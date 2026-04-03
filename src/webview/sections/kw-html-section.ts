import { pState } from '../shared/persistence-state';
import { postMessageToHost } from '../shared/webview-messages';
import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { styles } from './kw-html-section.styles.js';
import { customElement, property, state } from 'lit/decorators.js';
import '../components/kw-section-shell.js';
import { getScrollY, maybeAutoScrollWhileDragging } from '../core/utils.js';
import { schedulePersist } from '../core/persistence.js';
import { __kustoForceEditorWritable, __kustoEnsureEditorWritableSoon, __kustoInstallWritableGuard } from '../monaco/writable.js';
import { __kustoAttachAutoResizeToContent } from '../monaco/resize.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type HtmlSectionMode = 'code' | 'preview';

/** Serialized shape for .kqlx persistence — must match KqlxSectionV1 html variant. */
export interface HtmlSectionData {
	id: string;
	type: 'html';
	name: string;
	code: string;
	mode: HtmlSectionMode;
	expanded: boolean;
	editorHeightPx?: number;
	previewHeightPx?: number;
}

// Monaco editor instance type (subset of monaco.editor.IStandaloneCodeEditor).
interface MonacoEditor {
	getValue(): string;
	setValue(value: string): void;
	getModel(): { getValue(): string } | null;
	getContentHeight(): number;
	getDomNode(): HTMLElement | null;
	layout(): void;
	dispose(): void;
	focus(): void;
	onDidFocusEditorText(cb: () => void): { dispose(): void };
	onDidFocusEditorWidget(cb: () => void): { dispose(): void };
	onDidChangeModelContent(cb: () => void): { dispose(): void };
	onDidContentSizeChange(cb: () => void): { dispose(): void };
	updateOptions(opts: Record<string, unknown>): void;
	addCommand(keybinding: number, handler: () => void): void;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<kw-html-section>` — Lit web component for an HTML section in the
 * Kusto Workbench notebook. Two modes:
 *   - Code: Monaco HTML editor with a basic toolbar
 *   - Preview: Sandboxed iframe rendering the HTML
 *
 * Monaco renders in light DOM via `<slot>` to avoid shadow DOM incompatibilities.
 */
@customElement('kw-html-section')
export class KwHtmlSection extends LitElement {

	// ── Public properties ─────────────────────────────────────────────────────

	/** Unique section identifier (e.g. "html_1709876543210"). */
	@property({ type: String, reflect: true, attribute: 'box-id' })
	boxId = '';

	/** Initial HTML code to load into the editor. */
	@property({ type: String, attribute: 'initial-code' })
	initialCode = '';

	/** Editor wrapper height in pixels (from persisted state). */
	@property({ type: Number, attribute: 'editor-height-px' })
	editorHeightPx: number | undefined = undefined;

	/** Preview wrapper height in pixels (from persisted state). */
	@property({ type: Number, attribute: 'preview-height-px' })
	previewHeightPx: number | undefined = undefined;

	// ── Internal state ────────────────────────────────────────────────────────

	@state() private _name = '';
	@state() private _mode: HtmlSectionMode = 'code';
	@state() private _expanded = true;
	@state() private _wordWrap = true;

	private _editor: MonacoEditor | null = null;
	private _initRetryCount = 0;
	private _userResizedEditor = false;
	private _userResizedPreview = false;
	/** Saved editor content across DOM moves (disconnect → reconnect). */
	private _savedCode: string | null = null;
	/** Last applied code-mode fit height — avoids redundant style writes. */
	private _lastFitHeight = 0;
	/** User-set editor wrapper height (survives mode switches). */
	private _savedEditorHeightPx: number | undefined;
	/** User-set preview wrapper height (survives mode switches). */
	private _savedPreviewHeightPx: number | undefined;
	/** Pending rAF id for window resize debounce. */
	private _resizeRaf = 0;
	/** Bound message handler for iframe height reports. */
	private _onMessage = this._handleIframeMessage.bind(this);

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	override connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener('message', this._onMessage);
		// Re-create editor after a DOM move (reorder).
		if (this._savedCode !== null) {
			this.updateComplete.then(() => this._initEditor());
		}
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		window.removeEventListener('message', this._onMessage);
		// Save content before destroying so it can be restored on reconnect.
		if (this._editor) {
			try {
				const model = this._editor.getModel();
				if (model) this._savedCode = model.getValue();
			} catch (e) { console.error('[kusto]', e); }
		}
		this._disposeEditor();
	}

	override firstUpdated(_changedProperties: PropertyValues): void {
		super.firstUpdated(_changedProperties);
		const slot = this.shadowRoot?.querySelector('slot[name="editor"]') as HTMLSlotElement | null;
		if (slot) {
			slot.addEventListener('slotchange', () => {
				if (!this._editor) this._initEditor();
			}, { once: true });
		}
		this._initEditor();

		// Restore user-set heights from persisted state.
		if (this.editorHeightPx !== undefined) {
			this._savedEditorHeightPx = this.editorHeightPx;
			this._userResizedEditor = true;
		}
		if (this.previewHeightPx !== undefined) {
			this._savedPreviewHeightPx = this.previewHeightPx;
			this._userResizedPreview = true;
		}
	}

	override updated(changed: PropertyValues): void {
		super.updated(changed);
		if (changed.has('_mode')) {
			if (this._mode === 'preview') {
				this._updatePreview();
				// Restore user-set preview height after the wrapper is rendered.
				if (this._userResizedPreview && this._savedPreviewHeightPx !== undefined) {
					this.updateComplete.then(() => this._restorePreviewHeight());
				}
			} else {
				// Returning to code mode — re-layout editor.
				this.updateComplete.then(() => {
					try { this._editor?.layout(); } catch (e) { console.error('[kusto]', e); }
					if (this._userResizedEditor && this._savedEditorHeightPx !== undefined) {
						this._restoreEditorHeight();
					} else {
						this._lastFitHeight = 0;
						this._autoFitToContent();
					}
				});
			}
		}
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	static override styles = styles;

	// ── Render ─────────────────────────────────────────────────────────────────

	override render() {
		const showResizer = this._expanded;
		return html`
			<div class="section-root">
			<kw-section-shell
				.name=${this._name}
				.expanded=${this._expanded}
				box-id=${this.boxId}
				name-placeholder="HTML name (optional)"
				@name-change=${this._onShellNameChange}
				@toggle-visibility=${this._toggleVisibility}
				@fit-to-contents=${this._fitToContents}>
				${this._renderToolbar()}
				${this._expanded ? (this._mode === 'code' ? this._renderCodeMode() : this._renderPreviewMode()) : nothing}
			</kw-section-shell>
			</div>
			${showResizer ? html`
				<div class="resizer"
					title="Drag to resize\nDouble-click to fit to contents"
					@mousedown=${this._mode === 'code' ? this._onEditorResizerMouseDown : this._onPreviewResizerMouseDown}
					@dblclick=${this._fitToContents}></div>
			` : nothing}
		`;
	}

	// ── Toolbar ───────────────────────────────────────────────────────────────

	private _renderToolbar(): TemplateResult {
		return html`
			<div slot="header-buttons" class="html-mode-buttons">
				<button class="unified-btn-secondary md-tab md-mode-btn ${this._mode === 'code' ? 'is-active' : ''}"
					type="button" role="tab" aria-selected=${this._mode === 'code' ? 'true' : 'false'}
					@click=${() => this._setMode('code')} title="Edit">Edit</button>
				<button class="unified-btn-secondary md-tab md-mode-btn ${this._mode === 'preview' ? 'is-active' : ''}"
					type="button" role="tab" aria-selected=${this._mode === 'preview' ? 'true' : 'false'}
					@click=${() => this._setMode('preview')} title="Preview">Preview</button>
				<button class="header-tab" type="button"
					@click=${this._saveAsHtml} title="Export as HTML file" aria-label="Export as HTML file">
					${KwHtmlSection._exportIcon}
				</button>
			</div>
		`;
	}

	// ── Code mode ─────────────────────────────────────────────────────────────

	private _renderCodeMode(): TemplateResult {
		return html`
			<div class="html-toolbar">
				<button class="html-toolbar-btn" type="button" title="Undo (Ctrl+Z)"
					aria-label="Undo" @click=${this._undo}>
					${KwHtmlSection._undoIcon}
				</button>
				<button class="html-toolbar-btn" type="button" title="Redo (Ctrl+Y)"
					aria-label="Redo" @click=${this._redo}>
					${KwHtmlSection._redoIcon}
				</button>
				<span class="html-toolbar-sep" aria-hidden="true"></span>
				<button class="html-toolbar-btn" type="button" title="Format Document (Shift+Alt+F)"
					aria-label="Format document" @click=${this._formatDocument}>
					${KwHtmlSection._formatIcon}
				</button>
				<button class="html-toolbar-btn" type="button" title="Toggle Comment (Ctrl+/)"
					aria-label="Toggle comment" @click=${this._toggleComment}>
					${KwHtmlSection._commentIcon}
				</button>
				<span class="html-toolbar-sep" aria-hidden="true"></span>
				<button class="html-toolbar-btn" type="button" title="Indent (Tab)"
					aria-label="Indent" @click=${this._indent}>
					${KwHtmlSection._indentIcon}
				</button>
				<button class="html-toolbar-btn" type="button" title="Outdent (Shift+Tab)"
					aria-label="Outdent" @click=${this._outdent}>
					${KwHtmlSection._outdentIcon}
				</button>
				<span class="html-toolbar-sep" aria-hidden="true"></span>
				<button class="html-toolbar-btn" type="button" title="Find (Ctrl+F)"
					aria-label="Find" @click=${this._find}>
					${KwHtmlSection._searchIcon}
				</button>
				<button class="html-toolbar-btn" type="button" title="Find and Replace (Ctrl+H)"
					aria-label="Find and Replace" @click=${this._findReplace}>
					${KwHtmlSection._replaceIcon}
				</button>
				<span class="html-toolbar-sep" aria-hidden="true"></span>
				<button class="html-toolbar-btn ${this._wordWrap ? 'is-active' : ''}" type="button"
					title="Toggle Word Wrap" aria-label="Toggle Word Wrap"
					@click=${this._toggleWordWrap}>
					${KwHtmlSection._wordWrapIcon}
				</button>
			</div>
			<div class="editor-wrapper" id="editor-wrapper">
				<div class="editor-placeholder" id="editor-placeholder">Probably best to let the agent do this part ...</div>
				<slot name="editor"></slot>
			</div>
		`;
	}

	// ── Preview mode ──────────────────────────────────────────────────────────

	private _renderPreviewMode(): TemplateResult {
		const code = this._getCodeText();
		const hasContent = !!code.trim();
		return html`
			<div class="preview-wrapper" id="preview-wrapper">
				${hasContent ? html`
					<iframe class="preview-iframe" id="preview-iframe"
						sandbox="allow-scripts"
						referrerpolicy="no-referrer"
						title="HTML Preview"></iframe>
				` : html`
					<div class="preview-empty">Write some HTML in Edit mode, and then switch to Preview.</div>
				`}
			</div>
		`;
	}

	// ── SVG Icons (static) ────────────────────────────────────────────────────

	private static _undoIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
			stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
			<path d="M3 6h7a3 3 0 0 1 0 6H9"/>
			<path d="M5.5 3.5L3 6l2.5 2.5"/>
		</svg>`;

	private static _redoIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
			stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
			<path d="M13 6H6a3 3 0 0 0 0 6h1"/>
			<path d="M10.5 3.5L13 6l-2.5 2.5"/>
		</svg>`;

	private static _formatIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
			stroke-width="1.3" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">
			<path d="M3 4h10M5 8h8M3 12h6"/>
		</svg>`;

	private static _commentIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M2 4h3l-3 4h3l-3 4" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
			<path d="M9 4h5M9 8h4M9 12h3" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>
		</svg>`;

	private static _indentIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
			stroke-width="1.3" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">
			<path d="M7 4h7M7 8h7M7 12h7"/>
			<path d="M2 5l3 3-3 3"/>
		</svg>`;

	private static _outdentIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
			stroke-width="1.3" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">
			<path d="M7 4h7M7 8h7M7 12h7"/>
			<path d="M5 5l-3 3 3 3"/>
		</svg>`;

	private static _searchIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
			stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
			<circle cx="7" cy="7" r="4.5"/>
			<path d="M10.5 10.5L14 14"/>
		</svg>`;

	private static _replaceIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path fill-rule="evenodd" d="M2.5 4.5h8V3l3 2.5-3 2.5V6.5h-8v-2zM13.5 11.5h-8V13l-3-2.5 3-2.5v1.5h8v2z"/>
		</svg>`;

	private static _wordWrapIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
			stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
			<path d="M2 4h12M2 8h9a2.5 2.5 0 0 1 0 5H8"/>
			<path d="M9.5 11.5L8 13l1.5 1.5"/>
		</svg>`;

	private static _exportIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
			stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
			<path d="M8 2v8M5 7l3 3 3-3"/>
			<path d="M3 11v2h10v-2"/>
		</svg>`;

	// ── Monaco Editor ─────────────────────────────────────────────────────────

	private _initEditor(): void {
		const slotted = this._getEditorContainer();
		if (!slotted) return;

		const ensureMonaco = window.ensureMonaco as (() => Promise<any>) | undefined;
		if (typeof ensureMonaco !== 'function') {
			this._retryInit();
			return;
		}

		ensureMonaco().then((monaco: any) => {
			if (!slotted || !slotted.isConnected) return;

			if (this._editor) {
				try {
					const dom = this._editor.getDomNode();
					if (dom && dom.isConnected && slotted.contains(dom)) return;
					this._editor.dispose();
				} catch (e) { console.error('[kusto]', e); }
				this._editor = null;
			}

			slotted.style.minHeight = '0';
			slotted.style.minWidth = '0';

			const editor = monaco.editor.create(slotted, {
				value: this._savedCode ?? this.initialCode ?? '',
				language: 'html',
				readOnly: false,
				domReadOnly: false,
				automaticLayout: true,
				scrollbar: { alwaysConsumeMouseWheel: false },
				fixedOverflowWidgets: true,
				minimap: { enabled: false },
				scrollBeyondLastLine: false,
				fontFamily: getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family'),
				fontSize: 13,
				lineNumbers: 'on',
				renderLineHighlight: 'none',
				wordWrap: 'on'
			});

			// Track active editor for global key handlers.
			try {
				editor.onDidFocusEditorText(() => {
					try { window.activeMonacoEditor = editor; } catch (e) { console.error('[kusto]', e); }
					this._forceWritable(editor);
				});
				editor.onDidFocusEditorWidget(() => {
					try { window.activeMonacoEditor = editor; } catch (e) { console.error('[kusto]', e); }
					this._forceWritable(editor);
				});
			} catch (e) { console.error('[kusto]', e); }

			this._editor = editor;

			// Writable guards.
			this._forceWritable(editor);
			try { __kustoEnsureEditorWritableSoon(editor); } catch (e) { console.error('[kusto]', e); }
			try { __kustoInstallWritableGuard(editor); } catch (e) { console.error('[kusto]', e); }

			// Mousedown force-writable.
			try {
				slotted.addEventListener('mousedown', () => {
					this._forceWritable(editor);
					try { editor.focus(); } catch (e) { console.error('[kusto]', e); }
				}, true);
			} catch (e) { console.error('[kusto]', e); }

			// Auto-resize.
			try { __kustoAttachAutoResizeToContent(editor, slotted); } catch (e) { console.error('[kusto]', e); }

			// Persist on content change.
			try {
				editor.onDidChangeModelContent(() => {
					this._schedulePersist();
					this._updatePlaceholder();
				});
			} catch (e) { console.error('[kusto]', e); }

			// Auto-fit height + max-height so the section is exactly as tall as its content (no scrollbar).
			try {
				editor.onDidContentSizeChange(() => this._autoFitToContent());
			} catch (e) { console.error('[kusto]', e); }

			this._updatePlaceholder();

			// Ctrl+Enter toggles to preview mode.
			try {
				const togglePreview = () => this._setMode('preview');
				editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, togglePreview);
			} catch (e) { console.error('[kusto]', e); }

			// Initial auto-fit or restore user-set height (after a brief layout settle).
			requestAnimationFrame(() => {
				if (this._userResizedEditor && this._savedEditorHeightPx !== undefined) {
					this._restoreEditorHeight();
				} else {
					this._autoFitToContent();
				}
			});

			// Recalculate on window resize (word-wrap may change line count).
			window.addEventListener('resize', this._onWindowResize);

			this._initRetryCount = 0;
		}).catch(() => {
			if (this._editor) return;
			this._retryInit();
		});
	}

	private _retryInit(): void {
		this._initRetryCount++;
		const delays = [50, 250, 1000, 2000, 4000];
		if (this._initRetryCount > delays.length) return;
		const delay = delays[this._initRetryCount - 1];
		setTimeout(() => {
			try { this._initEditor(); } catch (e) { console.error('[kusto]', e); }
		}, delay);
	}

	private _disposeEditor(): void {
		window.removeEventListener('resize', this._onWindowResize);
		if (this._resizeRaf) { cancelAnimationFrame(this._resizeRaf); this._resizeRaf = 0; }
		if (this._editor) {
			try { this._editor.dispose(); } catch (e) { console.error('[kusto]', e); }
			this._editor = null;
		}
	}

	private _forceWritable(editor: MonacoEditor): void {
		try { __kustoForceEditorWritable(editor); } catch (e) { console.error('[kusto]', e); }
	}

	private _getEditorContainer(): HTMLElement | null {
		const slot = this.shadowRoot?.querySelector('slot[name="editor"]') as HTMLSlotElement | null;
		if (slot) {
			const assigned = slot.assignedElements();
			if (assigned.length > 0) return assigned[0] as HTMLElement;
		}
		return this.querySelector('.query-editor') as HTMLElement | null;
	}

	// ── Placeholder ───────────────────────────────────────────────────────────

	private _updatePlaceholder(): void {
		const el = this.shadowRoot?.getElementById('editor-placeholder');
		if (!el) return;
		const hasContent = !!(this._editor?.getValue?.()?.trim());
		el.style.display = hasContent ? 'none' : '';
	}

	// ── Preview ───────────────────────────────────────────────────────────────

	private _updatePreview(): void {
		this.updateComplete.then(() => {
			const iframe = this.shadowRoot?.getElementById('preview-iframe') as HTMLIFrameElement | null;
			if (!iframe) return;
			const code = this._getCodeText();
			if (code.trim()) {
				// Inject a height-reporting script so we can auto-fit the section to the
				// rendered content height (the iframe is sandboxed, so we use postMessage).
				iframe.srcdoc = code + KwHtmlSection._heightReportScript;
			}
		});
	}

	/** Script injected into the preview srcdoc to report content height via postMessage. */
	private static _heightReportScript = `
<script>
(function(){
	function send(){parent.postMessage({type:'kw-html-preview-height',h:document.documentElement.scrollHeight},'*');}
	if(document.readyState==='complete')send();else window.addEventListener('load',send);
	window.addEventListener('resize',send);
	window.addEventListener('message',function(e){if(e.data&&e.data.type==='kw-html-request-height')send();});
	new ResizeObserver(send).observe(document.documentElement);
})();
<\/script>`;

	/** Handle height reports from the sandboxed preview iframe. */
	private _handleIframeMessage(e: MessageEvent): void {
		try {
			if (!e.data || e.data.type !== 'kw-html-preview-height') return;
			// Verify the message came from our own iframe.
			const iframe = this.shadowRoot?.getElementById('preview-iframe') as HTMLIFrameElement | null;
			if (!iframe || e.source !== iframe.contentWindow) return;
			const h = Number(e.data.h);
			if (!Number.isFinite(h) || h <= 0) return;
			this._applyPreviewFitHeight(h);
		} catch (ex) { console.error('[kusto]', ex); }
	}

	/** Apply the measured content height to the preview wrapper. */
	private _applyPreviewFitHeight(contentH: number): void {
		if (this._userResizedPreview) return;
		const wrapper = this.shadowRoot?.getElementById('preview-wrapper');
		if (!wrapper) return;
		const fitH = Math.max(120, Math.ceil(contentH));
		wrapper.style.height = fitH + 'px';
		wrapper.style.maxHeight = fitH + 'px';
	}

	// ── Height capture / restore (survive mode switches) ──────────────────────

	/** Snapshot the current wrapper height before a mode switch destroys it. */
	private _captureCurrentHeight(): void {
		if (this._mode === 'code') {
			const wrapper = this.shadowRoot?.getElementById('editor-wrapper');
			if (wrapper) {
				const h = wrapper.getBoundingClientRect().height;
				if (h > 0) { this._savedEditorHeightPx = Math.round(h); this._userResizedEditor = true; }
			}
		} else {
			const wrapper = this.shadowRoot?.getElementById('preview-wrapper');
			if (wrapper) {
				const h = wrapper.getBoundingClientRect().height;
				if (h > 0) { this._savedPreviewHeightPx = Math.round(h); this._userResizedPreview = true; }
			}
		}
	}

	private _restoreEditorHeight(): void {
		const wrapper = this.shadowRoot?.getElementById('editor-wrapper');
		if (!wrapper || this._savedEditorHeightPx === undefined) return;
		const h = this._savedEditorHeightPx;
		wrapper.style.height = h + 'px';
		wrapper.style.maxHeight = h + 'px';
		this._lastFitHeight = h;
		try { this._editor?.layout(); } catch (e) { console.error('[kusto]', e); }
	}

	private _restorePreviewHeight(): void {
		const wrapper = this.shadowRoot?.getElementById('preview-wrapper');
		if (!wrapper || this._savedPreviewHeightPx === undefined) return;
		const h = this._savedPreviewHeightPx;
		wrapper.style.height = h + 'px';
		wrapper.style.maxHeight = h + 'px';
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	private _onShellNameChange(e: CustomEvent<{ name: string }>): void {
		this._name = e.detail.name;
		this._schedulePersist();
	}

	private _toggleVisibility(): void {
		this._expanded = !this._expanded;
		this.classList.toggle('is-collapsed', !this._expanded);
		if (this._expanded && this._mode === 'code') {
			setTimeout(() => { try { this._editor?.layout(); } catch (e) { console.error('[kusto]', e); } }, 0);
		}
		this._schedulePersist();
	}

	private _setMode(mode: HtmlSectionMode): void {
		if (this._mode === mode) return;
		// Capture current wrapper height before the mode switch destroys the DOM.
		this._captureCurrentHeight();
		this._mode = mode;
		this._schedulePersist();
	}

	private _saveAsHtml(): void {
		const code = this._getCodeText();
		if (!code.trim()) {
			try {
				postMessageToHost({ type: 'showInfo', message: 'There is no HTML content to save.' });
			} catch (e) { console.error('[kusto]', e); }
			return;
		}
		try {
			postMessageToHost({ type: 'saveHtmlFile', boxId: this.boxId, html: code, suggestedFileName: this._name || '' });
		} catch (e) { console.error('[kusto]', e); }
	}

	// ── Toolbar actions ──────────────────────────────────────────────────────

	private _undo(): void {
		if (!this._editor) return;
		try { (this._editor as any).trigger?.('toolbar', 'undo', null); } catch (e) { console.error('[kusto]', e); }
	}

	private _redo(): void {
		if (!this._editor) return;
		try { (this._editor as any).trigger?.('toolbar', 'redo', null); } catch (e) { console.error('[kusto]', e); }
	}

	private _formatDocument(): void {
		if (!this._editor) return;
		try { (this._editor as any).getAction?.('editor.action.formatDocument')?.run?.(); } catch (e) { console.error('[kusto]', e); }
	}

	private _toggleComment(): void {
		if (!this._editor) return;
		try { (this._editor as any).getAction?.('editor.action.commentLine')?.run?.(); } catch (e) { console.error('[kusto]', e); }
	}

	private _indent(): void {
		if (!this._editor) return;
		try { (this._editor as any).getAction?.('editor.action.indentLines')?.run?.(); } catch (e) { console.error('[kusto]', e); }
	}

	private _outdent(): void {
		if (!this._editor) return;
		try { (this._editor as any).getAction?.('editor.action.outdentLines')?.run?.(); } catch (e) { console.error('[kusto]', e); }
	}

	private _find(): void {
		if (!this._editor) return;
		try { (this._editor as any).getAction?.('actions.find')?.run?.(); } catch (e) { console.error('[kusto]', e); }
	}

	private _findReplace(): void {
		if (!this._editor) return;
		try { (this._editor as any).getAction?.('editor.action.startFindReplaceAction')?.run?.(); } catch (e) { console.error('[kusto]', e); }
	}

	private _toggleWordWrap(): void {
		this._wordWrap = !this._wordWrap;
		if (this._editor) {
			try { this._editor.updateOptions({ wordWrap: this._wordWrap ? 'on' : 'off' }); } catch (e) { console.error('[kusto]', e); }
		}
	}

	// ── Fit to contents ───────────────────────────────────────────────────────

	/** Compute the wrapper padding/border chrome that surrounds the editor. */
	private _getEditorWrapperChrome(wrapper: HTMLElement): number {
		let chrome = 0;
		try {
			const csw = getComputedStyle(wrapper);
			chrome += (parseFloat(csw.paddingTop || '0') || 0) + (parseFloat(csw.paddingBottom || '0') || 0);
			chrome += (parseFloat(csw.borderTopWidth || '0') || 0) + (parseFloat(csw.borderBottomWidth || '0') || 0);
		} catch (e) { console.error('[kusto]', e); }
		return chrome;
	}

	/** Max auto-fit height for code mode (user can still resize beyond this). */
	private static _AUTO_FIT_MAX_PX = 750;

	/** Return the ideal wrapper height = Monaco content height + wrapper chrome. */
	private _getContentFitHeight(): number | undefined {
		if (!this._editor) return undefined;
		const wrapper = this.shadowRoot?.getElementById('editor-wrapper');
		if (!wrapper) return undefined;

		let contentHeight = 0;
		try {
			const ch = this._editor.getContentHeight();
			if (ch && Number.isFinite(ch) && ch > 0) contentHeight = ch;
		} catch (e) { console.error('[kusto]', e); }
		if (!contentHeight) return undefined;

		const raw = Math.max(120, Math.ceil(this._getEditorWrapperChrome(wrapper) + contentHeight));
		return Math.min(raw, KwHtmlSection._AUTO_FIT_MAX_PX);
	}

	/**
	 * Set both height and max-height on the editor wrapper so the section
	 * is exactly as tall as its content (no vertical scrollbar, no empty gap).
	 * Skips redundant writes when the fit height hasn't changed.
	 */
	private _autoFitToContent(): void {
		if (this._mode !== 'code') return;
		if (this._userResizedEditor) return;
		const wrapper = this.shadowRoot?.getElementById('editor-wrapper');
		if (!wrapper || !this._editor) return;
		const fitH = this._getContentFitHeight();
		if (fitH === undefined || fitH === this._lastFitHeight) return;
		this._lastFitHeight = fitH;
		wrapper.style.height = fitH + 'px';
		wrapper.style.maxHeight = fitH + 'px';
		try { this._editor.layout(); } catch (e) { console.error('[kusto]', e); }
	}

	/** Debounced window resize handler — forces auto-fit recalculation. */
	private _onWindowResize = (): void => {
		if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
		this._resizeRaf = requestAnimationFrame(() => {
			this._resizeRaf = 0;
			if (this._mode === 'code') {
				this._lastFitHeight = 0;
				this._autoFitToContent();
			}
			// Preview mode auto-resizes via the iframe's own resize → postMessage flow.
		});
	};

	private _fitToContents(): void {
		if (this._mode === 'code') {
			// Clear user-resize so auto-fit re-engages.
			this._userResizedEditor = false;
			this._savedEditorHeightPx = undefined;
			// Force recalculation by resetting cached fit height.
			this._lastFitHeight = 0;
			this._autoFitToContent();
			// Retry after layout settles.
			setTimeout(() => { this._lastFitHeight = 0; this._autoFitToContent(); }, 50);
			setTimeout(() => { this._lastFitHeight = 0; this._autoFitToContent(); }, 150);
		} else {
			// Clear user-resize so auto-fit re-engages.
			this._userResizedPreview = false;
			this._savedPreviewHeightPx = undefined;
			// Preview mode — ask the iframe to re-report its height.
			const iframe = this.shadowRoot?.getElementById('preview-iframe') as HTMLIFrameElement | null;
			if (iframe?.contentWindow) {
				try { iframe.contentWindow.postMessage({ type: 'kw-html-request-height' }, '*'); } catch (e) { console.error('[kusto]', e); }
			}
		}
		this._schedulePersist();
	}

	// ── Resize handles ────────────────────────────────────────────────────────

	private _onEditorResizerMouseDown(e: MouseEvent): void {
		this._onResizerMouseDown(e, 'editor-wrapper', () => { this._userResizedEditor = true; }, (editor) => { try { editor?.layout(); } catch (e) { console.error('[kusto]', e); } });
	}

	private _onPreviewResizerMouseDown(e: MouseEvent): void {
		this._onResizerMouseDown(e, 'preview-wrapper', () => { this._userResizedPreview = true; });
	}

	private _onResizerMouseDown(e: MouseEvent, wrapperId: string, markResized: () => void, onMove?: (editor: MonacoEditor | null) => void): void {
		e.preventDefault();
		e.stopPropagation();

		const wrapper = this.shadowRoot?.getElementById(wrapperId);
		if (!wrapper) return;

		markResized();
		const resizer = e.currentTarget as HTMLElement;
		resizer.classList.add('is-dragging');

		const prevCursor = document.body.style.cursor;
		const prevSelect = document.body.style.userSelect;
		document.body.style.cursor = 'ns-resize';
		document.body.style.userSelect = 'none';

		// Disable pointer-events on iframes so mousemove/mouseup are not swallowed.
		const iframe = this.shadowRoot?.querySelector('iframe') as HTMLIFrameElement | null;
		if (iframe) iframe.style.pointerEvents = 'none';

		const startPageY = e.clientY + getScrollY();
		const startHeight = wrapper.getBoundingClientRect().height;

		const move = (moveEvent: MouseEvent) => {
			try { maybeAutoScrollWhileDragging(moveEvent.clientY); } catch (e) { console.error('[kusto]', e); }
			const pageY = moveEvent.clientY + getScrollY();
			const delta = pageY - startPageY;
			const maxH = parseFloat(wrapper.style.maxHeight || '') || 2000;
			const nextHeight = Math.max(120, Math.min(maxH, startHeight + delta));
			wrapper.style.height = nextHeight + 'px';
			if (onMove) onMove(this._editor);
		};

		const up = () => {
			document.removeEventListener('mousemove', move, true);
			document.removeEventListener('mouseup', up, true);
			document.removeEventListener('mouseleave', up);
			window.removeEventListener('blur', up);
			resizer.classList.remove('is-dragging');
			document.body.style.cursor = prevCursor;
			document.body.style.userSelect = prevSelect;
			if (iframe) iframe.style.pointerEvents = '';
			// Save user-set height so it survives mode switches.
			const finalH = wrapper.getBoundingClientRect().height;
			if (finalH > 0) {
				const rounded = Math.round(finalH);
				if (wrapperId === 'editor-wrapper') this._savedEditorHeightPx = rounded;
				else if (wrapperId === 'preview-wrapper') this._savedPreviewHeightPx = rounded;
			}
			this._schedulePersist();
		};

		document.addEventListener('mousemove', move, true);
		document.addEventListener('mouseup', up, true);
		document.addEventListener('mouseleave', up);
		window.addEventListener('blur', up);
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	private _schedulePersist(): void {
		try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	}

	private _getCodeText(): string {
		if (this._editor) {
			const model = this._editor.getModel();
			if (model) return model.getValue();
		}
		// Fallback: check pending code buffer (Monaco may not be ready yet).
		try {
			const pending = pState.pendingHtmlCodeByBoxId;
			if (pending && typeof pending[this.boxId] === 'string') {
				return pending[this.boxId];
			}
		} catch (e) { console.error('[kusto]', e); }
		return '';
	}

	/**
	 * Serialize to the .kqlx JSON format.
	 */
	public serialize(): HtmlSectionData {
		const data: HtmlSectionData = {
			id: this.boxId,
			type: 'html',
			name: this._name,
			code: this._getCodeText(),
			mode: this._mode,
			expanded: this._expanded,
		};

		// Use saved heights (survive mode switches); fall back to DOM for the active wrapper.
		const editorH = this._savedEditorHeightPx ?? this._getWrapperHeightPx('editor-wrapper', this._userResizedEditor);
		if (editorH !== undefined) data.editorHeightPx = editorH;

		const previewH = this._savedPreviewHeightPx ?? this._getWrapperHeightPx('preview-wrapper', this._userResizedPreview);
		if (previewH !== undefined) data.previewHeightPx = previewH;

		return data;
	}

	private _getWrapperHeightPx(wrapperId: string, userResized: boolean): number | undefined {
		const wrapper = this.shadowRoot?.getElementById(wrapperId);
		if (!wrapper || !userResized) return undefined;

		const inlineHeight = wrapper.style.height?.trim();
		if (!inlineHeight || inlineHeight === 'auto') return undefined;

		const m = inlineHeight.match(/^(\d+)px$/i);
		if (!m) return undefined;

		const px = parseInt(m[1], 10);
		return Number.isFinite(px) ? px : undefined;
	}

	// ── Public API (for factory / tool integration) ───────────────────────────

	public getName(): string { return this._name; }
	public setName(name: string): void { this._name = name; }

	public getCode(): string { return this._getCodeText(); }
	public setCode(code: string): void {
		if (this._editor) {
			this._editor.setValue(code);
		} else {
			// Buffer for when Monaco isn't ready yet.
			pState.pendingHtmlCodeByBoxId = pState.pendingHtmlCodeByBoxId || {};
			pState.pendingHtmlCodeByBoxId[this.boxId] = code;
		}
		// Refresh the preview iframe when content is updated while in preview mode.
		// requestUpdate() triggers a Lit re-render so the iframe is created if it
		// was previously showing the empty-content placeholder.
		if (this._mode === 'preview') {
			this.requestUpdate();
			this._updatePreview();
		}
	}

	public getMode(): HtmlSectionMode { return this._mode; }
	public setMode(mode: HtmlSectionMode): void { this._setMode(mode); }

	public setExpanded(expanded: boolean): void {
		this._expanded = expanded;
		this.classList.toggle('is-collapsed', !expanded);
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-html-section': KwHtmlSection;
	}
}
