import { pState } from '../shared/persistence-state';
import { postMessageToHost } from '../shared/webview-messages.js';
import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { styles } from './kw-markdown-section.styles.js';
import { customElement, property, state } from 'lit/decorators.js';
import '../components/kw-section-shell.js';
import { getScrollY, maybeAutoScrollWhileDragging } from '../core/utils.js';
import { closeAllMenus as _closeAllDropdownMenus } from '../core/dropdown.js';
import { schedulePersist } from '../core/persistence.js';
import { ensureToastUiLoaded } from '../shared/lazy-vendor.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Serialized shape for .kqlx persistence — must match KqlxSectionV1 markdown variant. */
export interface MarkdownSectionData {
	id: string;
	type: 'markdown';
	title: string;
	text: string;
	tab: 'edit' | 'preview';
	mode?: 'preview' | 'markdown' | 'wysiwyg';
	expanded: boolean;
	editorHeightPx?: number;
}

type MarkdownMode = 'wysiwyg' | 'markdown' | 'preview';

/** Minimal interface for the TOAST UI editor wrapper stored in markdownEditors[boxId]. */
interface ToastEditorApi {
	getValue(): string;
	setValue(value: string): void;
	layout(): void;
	dispose(): void;
	_toastui: any;
}

/** Minimal interface for the TOAST UI viewer wrapper stored in markdownViewers[boxId]. */
interface ToastViewerApi {
	setValue(value: string): void;
	dispose(): void;
}

window.__kustoMarkdownBoxes = window.__kustoMarkdownBoxes || [];
window.__kustoMarkdownEditors = window.__kustoMarkdownEditors || {};
export const markdownBoxes: string[] = window.__kustoMarkdownBoxes;
export const markdownEditors = window.__kustoMarkdownEditors;

// Pending reveal payloads can arrive before editor initialization.
pState.pendingMarkdownRevealByBoxId = pState.pendingMarkdownRevealByBoxId || {};

try {
	if (typeof window.__kustoRevealTextRangeFromHost !== 'function') {
		window.__kustoRevealTextRangeFromHost = (message: any) => {
			try {
				const kind = String(pState.documentKind || '');
				if (kind !== 'md') return;

				const start = message?.start;
				const end = message?.end;
				const sl = start && typeof start.line === 'number' ? start.line : 0;
				const sc = start && typeof start.character === 'number' ? start.character : 0;
				const el = end && typeof end.line === 'number' ? end.line : sl;
				const ec = end && typeof end.character === 'number' ? end.character : sc;
				const matchText = typeof message?.matchText === 'string' ? String(message.matchText) : '';
				const startOffset = typeof message?.startOffset === 'number' ? message.startOffset : undefined;
				const endOffset = typeof message?.endOffset === 'number' ? message.endOffset : undefined;

				const boxId = markdownBoxes.length ? String(markdownBoxes[0] || '') : '';
				if (!boxId) return;

				const payload = { startLine: sl, startChar: sc, endLine: el, endChar: ec, matchText, startOffset, endOffset };
				const litEl = document.getElementById(boxId) as any;
				if (litEl && typeof litEl.revealRange === 'function') {
					try {
						postMessageToHost({
							type: 'debugMdSearchReveal',
							phase: 'markdownReveal(apply)',
							detail: `${String(pState.documentUri || '')} boxId=${boxId} ${sl}:${sc}-${el}:${ec} matchLen=${matchText.length}`
						} as any);
					} catch (e) { console.error('[kusto]', e); }
					litEl.revealRange(payload);
				} else {
					try {
						postMessageToHost({
							type: 'debugMdSearchReveal',
							phase: 'markdownReveal(queued)',
							detail: `${String(pState.documentUri || '')} boxId=${boxId} ${sl}:${sc}-${el}:${ec} matchLen=${matchText.length}`
						} as any);
					} catch (e) { console.error('[kusto]', e); }
					pState.pendingMarkdownRevealByBoxId = pState.pendingMarkdownRevealByBoxId || {};
					pState.pendingMarkdownRevealByBoxId[boxId] = payload;
				}
			} catch (e) { console.error('[kusto]', e); }
		};
	}
} catch (e) { console.error('[kusto]', e); }

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<kw-markdown-section>` — Lit web component for a Markdown section in the
 * Kusto Workbench notebook. Renders a TOAST UI WYSIWYG/Markdown editor and a
 * TOAST UI viewer for Preview mode.
 *
 * TOAST UI renders in light DOM via `<slot>` to avoid shadow DOM incompatibilities.
 */
@customElement('kw-markdown-section')
export class KwMarkdownSection extends LitElement {
	public static addMarkdownBox(options: Record<string, unknown> = {}): string {
		const id = (typeof options.id === 'string' && options.id) ? String(options.id) : ('markdown_' + Date.now());
		markdownBoxes.push(id);

		try {
			const rawMode = typeof options.mode !== 'undefined' ? String(options.mode || '').toLowerCase() : '';
			if (rawMode === 'preview' || rawMode === 'markdown' || rawMode === 'wysiwyg') {
				window.__kustoMarkdownModeByBoxId = window.__kustoMarkdownModeByBoxId || {};
				window.__kustoMarkdownModeByBoxId[id] = rawMode;
			}
		} catch (e) { console.error('[kusto]', e); }

		try {
			const initialText = typeof options.text === 'string' ? options.text : undefined;
			if (typeof initialText === 'string') {
				pState.pendingMarkdownTextByBoxId = pState.pendingMarkdownTextByBoxId || {};
				pState.pendingMarkdownTextByBoxId[id] = initialText;
			}
		} catch (e) { console.error('[kusto]', e); }

		const container = document.getElementById('queries-container');
		if (!container) return id;

		const litEl = document.createElement('kw-markdown-section') as KwMarkdownSection;
		litEl.id = id;
		litEl.setAttribute('box-id', id);

		try {
			if (String(pState.documentKind || '') === 'md' || options.mdAutoExpand) {
				litEl.setAttribute('plain-md', '');
			}
		} catch (e) { console.error('[kusto]', e); }

		const pendingText = pState.pendingMarkdownTextByBoxId?.[id];
		if (typeof pendingText === 'string') {
			litEl.setAttribute('initial-text', pendingText);
		}

		const editorDiv = document.createElement('div');
		editorDiv.className = 'kusto-markdown-editor';
		editorDiv.id = id + '_md_editor';
		editorDiv.slot = 'editor';
		litEl.appendChild(editorDiv);

		const viewerDiv = document.createElement('div');
		viewerDiv.className = 'markdown-viewer';
		viewerDiv.id = id + '_md_viewer';
		viewerDiv.slot = 'viewer';
		viewerDiv.style.display = 'none';
		litEl.appendChild(viewerDiv);

		litEl.addEventListener('section-remove', (e: any) => {
			try { removeMarkdownBox(e?.detail?.boxId || id); } catch (err) { console.error('[kusto]', err); }
		});

		container.appendChild(litEl);

		try {
			const h = typeof options.editorHeightPx === 'number' ? options.editorHeightPx : undefined;
			const isPlainMd = String(pState.documentKind || '') === 'md';
			if (!isPlainMd && typeof h === 'number' && Number.isFinite(h) && h > 0) {
				litEl.setAttribute('editor-height-px', String(h));
			}
		} catch (e) { console.error('[kusto]', e); }

		try {
			const rawMode = typeof options.mode !== 'undefined' ? String(options.mode || '').toLowerCase() : '';
			if (rawMode === 'preview' || rawMode === 'markdown' || rawMode === 'wysiwyg') {
				litEl.setMarkdownMode(rawMode as any);
			}
		} catch (e) { console.error('[kusto]', e); }

		try {
			if (typeof options.title === 'string' && options.title) {
				litEl.setTitle(options.title);
			}
		} catch (e) { console.error('[kusto]', e); }

		try {
			if (typeof options.expanded === 'boolean') {
				litEl.setExpanded(options.expanded);
			}
		} catch (e) { console.error('[kusto]', e); }

		try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		try {
			const isPlainMd = String(pState.documentKind || '') === 'md';
			if (!isPlainMd) {
				const controls = document.querySelector('.add-controls');
				if (controls && typeof controls.scrollIntoView === 'function') {
					controls.scrollIntoView({ block: 'end' });
				}
			}
		} catch (e) { console.error('[kusto]', e); }

		return id;
	}

	// ── Public properties ─────────────────────────────────────────────────────

	/** Unique section identifier (e.g. "markdown_1709876543210"). */
	@property({ type: String, reflect: true, attribute: 'box-id' })
	boxId = '';

	/** Initial markdown text to load into the editor. */
	@property({ type: String, attribute: 'initial-text' })
	initialText = '';

	/** Editor wrapper height in pixels (from persisted state). */
	@property({ type: Number, attribute: 'editor-height-px' })
	editorHeightPx: number | undefined = undefined;

	/** Plain .md file mode — hides section chrome, full-page layout. */
	@property({ type: Boolean, attribute: 'plain-md', reflect: true })
	plainMd = false;

	// ── Internal state ────────────────────────────────────────────────────────

	@state() private _mode: MarkdownMode = 'wysiwyg';
	@state() private _expanded = true;
	@state() private _title = '';
	@state() private _dropdownOpen = false;

	private _editorApi: ToastEditorApi | null = null;
	private _viewerApi: ToastViewerApi | null = null;
	private _userResized = false;
	private _resizeObserver: ResizeObserver | null = null;
	private _isNarrow = false;
	private _isVeryNarrow = false;
	/** Height stored before entering Preview mode (so we can restore it). */
	private _prevHeightPx: string | null = null;

	// ── Theme observer singleton ─────────────────────────────────────────────

	private static _themeObserverStarted = false;
	private static _lastAppliedToastUiIsDark: boolean | null = null;

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	override connectedCallback(): void {
		super.connectedCallback();
		document.addEventListener('click', this._onDocumentClick);
		KwMarkdownSection._startThemeObserver();
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		document.removeEventListener('click', this._onDocumentClick);
		this._cleanupResizeObserver();
	}

	override firstUpdated(_changedProperties: PropertyValues): void {
		super.firstUpdated(_changedProperties);

		// Slot assignment may happen after firstUpdated; listen for it.
		const editorSlot = this.shadowRoot?.querySelector('slot[name="editor"]') as HTMLSlotElement | null;
		if (editorSlot) {
			editorSlot.addEventListener('slotchange', () => {
				if (!this._editorApi) this._initEditor();
			}, { once: true });
		}

		// Apply persisted height.
		if (this.editorHeightPx && this.editorHeightPx > 0) {
			const wrapper = this.shadowRoot?.getElementById('editor-wrapper');
			if (wrapper) {
				wrapper.style.height = Math.round(this.editorHeightPx) + 'px';
				this._userResized = true;
			}
		}

		this._initEditor();
		this._setupResizeObserver();
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	static override styles = styles;

	// ── Render ─────────────────────────────────────────────────────────────────

	override render() {
		if (this.plainMd) {
			return this._renderPlainMd();
		}
		return html`
			<div class="section-root">
				<kw-section-shell
					.name=${this._title}
					.expanded=${this._expanded}
					box-id=${this.boxId}
					name-placeholder="Markdown Name (optional)"
					@name-change=${this._onShellNameChange}
					@toggle-visibility=${this._toggleVisibility}
					@fit-to-contents=${this.fitToContents}>
					${this._renderModeButtons('header-buttons')}
					<div class="editor-wrapper" id="editor-wrapper">
						<slot name="editor"></slot>
						<slot name="viewer"></slot>
					</div>
					<div class="resizer"
						title="Drag to resize\nDouble-click to fit to contents"
						@mousedown=${this._onResizerMouseDown}
						@dblclick=${this.fitToContents}></div>
				</kw-section-shell>
			</div>
		`;
	}

	/** Plain .md mode — no section chrome, just mode buttons + editor. */
	private _renderPlainMd() {
		const modeLabels: Record<MarkdownMode, string> = { wysiwyg: 'WYSIWYG', markdown: 'Markdown', preview: 'Preview' };
		return html`
			<div class="section-root">
				<div class="plain-md-header">
					<div class="md-tabs" role="tablist" aria-label="Markdown mode">
						<button class="unified-btn-secondary md-tab md-mode-btn ${this._mode === 'wysiwyg' ? 'is-active' : ''}"
							type="button" role="tab" aria-selected=${this._mode === 'wysiwyg' ? 'true' : 'false'}
							@click=${() => this._setMode('wysiwyg')} title="WYSIWYG" aria-label="WYSIWYG">
							<span class="md-mode-icon" aria-hidden="true">${KwMarkdownSection._wysiwygIcon}</span>
							<span class="md-mode-label">WYSIWYG</span>
						</button>
						<button class="unified-btn-secondary md-tab md-mode-btn ${this._mode === 'markdown' ? 'is-active' : ''}"
							type="button" role="tab" aria-selected=${this._mode === 'markdown' ? 'true' : 'false'}
							@click=${() => this._setMode('markdown')} title="Markdown" aria-label="Markdown">
							<span class="md-mode-icon" aria-hidden="true">${KwMarkdownSection._markdownIcon}</span>
							<span class="md-mode-label">Markdown</span>
						</button>
						<button class="unified-btn-secondary md-tab md-mode-btn ${this._mode === 'preview' ? 'is-active' : ''}"
							type="button" role="tab" aria-selected=${this._mode === 'preview' ? 'true' : 'false'}
							@click=${() => this._setMode('preview')} title="Preview" aria-label="Preview">
							<span class="md-mode-icon" aria-hidden="true">${KwMarkdownSection._previewModeIcon}</span>
							<span class="md-mode-label">Preview</span>
						</button>
					</div>
				</div>
				<div class="editor-wrapper" id="editor-wrapper">
					<slot name="editor"></slot>
					<slot name="viewer"></slot>
				</div>
			</div>
		`;
	}

	/** Render mode buttons — reused in both shell and plain-md modes. */
	private _renderModeButtons(slot?: string) {
		const modeLabels: Record<MarkdownMode, string> = { wysiwyg: 'WYSIWYG', markdown: 'Markdown', preview: 'Preview' };
		return html`
			<div slot=${slot ?? nothing} class="md-mode-buttons">
				<!-- Mode dropdown (narrow) -->
				<div class="md-mode-dropdown">
					<button class="unified-btn-secondary md-tab md-mode-dropdown-btn"
						type="button" aria-haspopup="listbox"
						aria-expanded=${this._dropdownOpen ? 'true' : 'false'}
						@click=${this._toggleDropdown}
						title="Editor mode" aria-label="Editor mode">
						<span class="md-mode-dropdown-text">${modeLabels[this._mode]}</span>
						<svg class="md-mode-dropdown-caret" width="12" height="12" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
							<path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/>
						</svg>
					</button>
					${this._dropdownOpen ? html`
						<div class="md-mode-dropdown-menu" role="listbox">
							<div class="md-mode-dropdown-item" role="option" @click=${() => this._setModeAndCloseDropdown('wysiwyg')}>WYSIWYG</div>
							<div class="md-mode-dropdown-item" role="option" @click=${() => this._setModeAndCloseDropdown('markdown')}>Markdown</div>
							<div class="md-mode-dropdown-item" role="option" @click=${() => this._setModeAndCloseDropdown('preview')}>Preview</div>
						</div>
					` : nothing}
				</div>
				<!-- Mode buttons (wide) -->
				<button class="unified-btn-secondary md-tab md-mode-btn ${this._mode === 'wysiwyg' ? 'is-active' : ''}"
					type="button" role="tab" aria-selected=${this._mode === 'wysiwyg' ? 'true' : 'false'}
					@click=${() => this._setMode('wysiwyg')} title="WYSIWYG" aria-label="WYSIWYG">
					<span class="md-mode-icon" aria-hidden="true">${KwMarkdownSection._wysiwygIcon}</span>
					<span class="md-mode-label">WYSIWYG</span>
				</button>
				<button class="unified-btn-secondary md-tab md-mode-btn ${this._mode === 'markdown' ? 'is-active' : ''}"
					type="button" role="tab" aria-selected=${this._mode === 'markdown' ? 'true' : 'false'}
					@click=${() => this._setMode('markdown')} title="Markdown" aria-label="Markdown">
					<span class="md-mode-icon" aria-hidden="true">${KwMarkdownSection._markdownIcon}</span>
					<span class="md-mode-label">Markdown</span>
				</button>
				<button class="unified-btn-secondary md-tab md-mode-btn ${this._mode === 'preview' ? 'is-active' : ''}"
					type="button" role="tab" aria-selected=${this._mode === 'preview' ? 'true' : 'false'}
					@click=${() => this._setMode('preview')} title="Preview" aria-label="Preview">
					<span class="md-mode-icon" aria-hidden="true">${KwMarkdownSection._previewModeIcon}</span>
					<span class="md-mode-label">Preview</span>
				</button>
			</div>
		`;
	}

	// ── SVG Icons (static) ────────────────────────────────────────────────────

	/* WYSIWYG mode icon — pencil on document */
	private static _wysiwygIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
			stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
			<rect x="3" y="2" width="10" height="12" rx="1.2" />
			<path d="M5.5 6h5M5.5 8.5h3" />
		</svg>`;

	/* Markdown mode icon — MD text badge */
	private static _markdownIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
			stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
			<rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
			<path d="M4 10V6l2 2.5L8 6v4" />
			<path d="M10.5 8.5l1.5 1.5 1.5-1.5M12 10V6" />
		</svg>`;

	/* Preview mode icon — eye */
	private static _previewModeIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
			stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
			<path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z" />
			<circle cx="8" cy="8" r="2.1" />
		</svg>`;



	// ── TOAST UI Editor Init ──────────────────────────────────────────────────

	/** Initialize the TOAST UI editor in the slotted light-DOM container. */
	private _initEditor(): void {
		const editorContainer = this._getEditorContainer();
		if (!editorContainer) return;

		let ToastEditor: any = null;
		try {
			ToastEditor = window.toastui?.Editor ?? null;
		} catch { ToastEditor = null; }

		if (!ToastEditor) {
			// Trigger lazy load — the retries will pick it up once loaded.
			ensureToastUiLoaded().catch(() => {});
			this._retryEditorInit();
			return;
		}

		// If already initialized and attached, skip.
		if (this._editorApi) {
			const attached = !!editorContainer.querySelector('.toastui-editor-defaultUI');
			if (attached) return;
			try { this._editorApi.dispose(); } catch (e) { console.error('[kusto]', e); }
			this._editorApi = null;
		}

		editorContainer.style.minHeight = '0';
		editorContainer.style.minWidth = '0';

		// Resolve initial text: prefer pending buffer, then attribute.
		let initialValue = this.initialText || '';
		try {
			const pending = pState.pendingMarkdownTextByBoxId?.[this.boxId];
			if (typeof pending === 'string') {
				initialValue = pending;
				try { delete pState.pendingMarkdownTextByBoxId[this.boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		// Clean mount point.
		editorContainer.textContent = '';

		const isLikelyDark = KwMarkdownSection._isDarkTheme();

		// Build undo/redo buttons.
		let toastEditorRef: any = null;
		const undoButton = this._createToolbarButton('Undo', 'Undo (Ctrl+Z)',
			'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>',
			() => { try { toastEditorRef?.getCurrentModeEditor?.()?.commands?.undo?.(); } catch (e) { console.error('[kusto]', e); } });
		const redoButton = this._createToolbarButton('Redo', 'Redo (Ctrl+Y)',
			'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>',
			() => { try { toastEditorRef?.getCurrentModeEditor?.()?.commands?.redo?.(); } catch (e) { console.error('[kusto]', e); } });

		const toolbarItemsConfig: any[] = [];
		if (undoButton && redoButton) {
			toolbarItemsConfig.push([
				{ name: 'undo', el: undoButton, tooltip: 'Undo (Ctrl+Z)' },
				{ name: 'redo', el: redoButton, tooltip: 'Redo (Ctrl+Y)' }
			]);
		}
		toolbarItemsConfig.push(
			['heading', 'bold', 'italic', 'strike'],
			['hr', 'quote'],
			['ul', 'ol', 'task', 'indent', 'outdent'],
			['table', 'image', 'link'],
			['code', 'codeblock']
		);

		let toastEditor: any = null;
		try {
			const editorOptions: any = {
				el: editorContainer,
				height: '100%',
				initialEditType: 'wysiwyg',
				previewStyle: 'vertical',
				hideModeSwitch: true,
				usageStatistics: false,
				frontMatter: true,
				initialValue,
				toolbarItems: toolbarItemsConfig,
				plugins: KwMarkdownSection._getToastUiPlugins(ToastEditor),
				events: {
					change: () => {
						this._schedulePersist();
						this._scheduleMdAutoExpand();
					},
					afterPreviewRender: () => {
						try { KwMarkdownSection._rewriteToastUiImages(editorContainer); } catch (e) { console.error('[kusto]', e); }
					}
				}
			};
			if (isLikelyDark) {
				editorOptions.theme = 'dark';
			}
			toastEditor = new ToastEditor(editorOptions);
			toastEditorRef = toastEditor;
		} catch (e) {
			try { console.error('Failed to initialize TOAST UI Editor.', e); } catch (e) { console.error('[kusto]', e); }
			return;
		}

		// Install keyboard shortcut conflict resolution (same as legacy).
		this._installKeyboardShortcuts(editorContainer, toastEditor);

		// Initial image rewrite pass.
		try { KwMarkdownSection._rewriteToastUiImages(editorContainer); } catch (e) { console.error('[kusto]', e); }

		// Build and store API.
		const api: ToastEditorApi = {
			getValue: () => {
				try { return toastEditor?.getMarkdown?.() ?? ''; } catch { return ''; }
			},
			setValue: (value: string) => {
				try { toastEditor?.setMarkdown?.(String(value || '')); } catch (e) { console.error('[kusto]', e); }
			},
			layout: () => {
				try {
					if (!toastEditor || typeof toastEditor.setHeight !== 'function') return;
					const wrapper = this.shadowRoot?.getElementById('editor-wrapper');
					if (!wrapper) return;
					const h = Math.max(120, wrapper.clientHeight);
					toastEditor.setHeight(Math.round(h) + 'px');
				} catch (e) { console.error('[kusto]', e); }
			},
			dispose: () => {
				try { toastEditor?.destroy?.(); } catch (e) { console.error('[kusto]', e); }
				try { editorContainer.textContent = ''; } catch (e) { console.error('[kusto]', e); }
			},
			_toastui: toastEditor
		};

		this._editorApi = api;

		// Register with global markdownEditors map so legacy code can still access it.
		try {
			const win = window;
			win.__kustoMarkdownEditors = win.__kustoMarkdownEditors || {};
			win.__kustoMarkdownEditors[this.boxId] = api;
		} catch (e) { console.error('[kusto]', e); }

		// Check for late-arriving pending text.
		try {
			const latePending = pState.pendingMarkdownTextByBoxId?.[this.boxId];
			if (typeof latePending === 'string') {
				api.setValue(latePending);
				try { delete pState.pendingMarkdownTextByBoxId[this.boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		// Apply mode.
		this._applyEditorMode();

		// Apply pending reveal.
		try { this._tryApplyPendingReveal(); } catch (e) { console.error('[kusto]', e); }

		// Fix border issues.
		try {
			const isPlainMd = String(pState.documentKind || '') === 'md';
			const defaultUI = editorContainer.querySelector('.toastui-editor-defaultUI') as HTMLElement | null;
			if (defaultUI) {
				if (isPlainMd) {
					// Plain .md: remove the outer border entirely (toolbar keeps its own bottom border).
					defaultUI.style.setProperty('border', 'none', 'important');
					defaultUI.style.setProperty('border-radius', '0', 'important');
				} else {
					// Multi-section: remove border to avoid double-border with section wrapper.
					defaultUI.style.setProperty('border', 'none', 'important');
					defaultUI.style.setProperty('border-radius', '0', 'important');
				}
			}
			if (!isPlainMd) {
				const toolbar = editorContainer.querySelector('.toastui-editor-defaultUI-toolbar') as HTMLElement | null;
				if (toolbar) {
					toolbar.style.setProperty('margin', '-1px -1px 0 -1px', 'important');
					toolbar.style.setProperty('border-radius', '0', 'important');
				}
			}
		} catch (e) { console.error('[kusto]', e); }

		// Apply theme to this instance.
		try { KwMarkdownSection._applyThemeToHost(editorContainer, KwMarkdownSection._isDarkTheme()); } catch (e) { console.error('[kusto]', e); }

		// Initial sizing.
		try { api.layout(); } catch (e) { console.error('[kusto]', e); }
	}

	private _editorInitRetryCount = 0;
	private _retryEditorInit(): void {
		this._editorInitRetryCount++;
		const delays = [50, 250, 1000, 2000, 4000];
		if (this._editorInitRetryCount > delays.length) return;
		const delay = delays[this._editorInitRetryCount - 1];
		setTimeout(() => { try { this._initEditor(); } catch (e) { console.error('[kusto]', e); } }, delay);
	}

	// ── TOAST UI Viewer Init ──────────────────────────────────────────────────

	private _initViewer(initialValue: string): void {
		// Invalidate any pending retries from a previous _initViewer call so they
		// don't overwrite this viewer with stale (possibly empty) content.
		this._viewerInitRetryGeneration++;
		this._viewerInitRetryCount = 0;

		const viewerContainer = this._getViewerContainer();
		if (!viewerContainer) return;

		// If a viewer exists and is attached, just update value.
		if (this._viewerApi) {
			const attached = !!viewerContainer.querySelector('.toastui-editor-contents');
			if (attached) {
				this._viewerApi.setValue(initialValue);
				return;
			}
			try { this._viewerApi.dispose(); } catch (e) { console.error('[kusto]', e); }
			this._viewerApi = null;
		}

		let ToastEditor: any = null;
		try {
			ToastEditor = window.toastui?.Editor ?? null;
		} catch { ToastEditor = null; }

		if (!ToastEditor) {
			// Trigger lazy load — the retries will pick it up once loaded.
			ensureToastUiLoaded().catch(() => {});
			this._retryViewerInit(initialValue);
			return;
		}

		viewerContainer.textContent = '';

		const isLikelyDark = KwMarkdownSection._isDarkTheme();

		let instance: any = null;
		try {
			const opts: any = {
				el: viewerContainer,
				viewer: true,
				usageStatistics: false,
				frontMatter: true,
				initialValue: String(initialValue || ''),
				plugins: KwMarkdownSection._getToastUiPlugins(ToastEditor),
				events: {
					afterPreviewRender: () => {
						try { KwMarkdownSection._rewriteToastUiImages(viewerContainer); } catch (e) { console.error('[kusto]', e); }
					}
				}
			};
			if (isLikelyDark) {
				opts.theme = 'dark';
			}
			instance = typeof ToastEditor.factory === 'function'
				? ToastEditor.factory(opts)
				: new ToastEditor(opts);
		} catch (e) {
			try { console.error('Failed to initialize TOAST UI viewer.', e); } catch (e) { console.error('[kusto]', e); }
			return;
		}

		try {
			KwMarkdownSection._rewriteToastUiImages(viewerContainer);
		} catch (e) { console.error('[kusto]', e); }

		// Strip TOAST UI viewer chrome (border, padding) for cleaner preview rendering.
		try {
			const defaultUI = viewerContainer.querySelector('.toastui-editor-defaultUI') as HTMLElement | null;
			if (defaultUI) {
				defaultUI.style.setProperty('border', 'none', 'important');
				defaultUI.style.setProperty('outline', 'none', 'important');
				defaultUI.style.setProperty('box-shadow', 'none', 'important');
			}
			const contents = viewerContainer.querySelector('.toastui-editor-contents') as HTMLElement | null;
			if (contents) {
				contents.style.setProperty('border', 'none', 'important');
				contents.style.setProperty('outline', 'none', 'important');
				contents.style.setProperty('box-shadow', 'none', 'important');
				contents.style.setProperty('padding', '0 10px 10px 5px', 'important');
			}
			// Also strip border on any direct children (TOAST UI viewer wrapper).
			for (const child of Array.from(viewerContainer.children)) {
				const el = child as HTMLElement;
				if (el.style) {
					el.style.setProperty('border', 'none', 'important');
					el.style.setProperty('outline', 'none', 'important');
					el.style.setProperty('box-shadow', 'none', 'important');
				}
			}
		} catch (e) { console.error('[kusto]', e); }

		this._viewerApi = {
			setValue: (value: string) => {
				try { instance?.setMarkdown?.(String(value || '')); } catch (e) { console.error('[kusto]', e); }
			},
			dispose: () => {
				try { instance?.destroy?.(); } catch (e) { console.error('[kusto]', e); }
			}
		};

		// Apply theme to this viewer instance.
		try { KwMarkdownSection._applyThemeToHost(viewerContainer, KwMarkdownSection._isDarkTheme()); } catch (e) { console.error('[kusto]', e); }
	}

	private _viewerInitRetryCount = 0;
	private _viewerInitRetryGeneration = 0;
	private _retryViewerInit(initialValue: string): void {
		this._viewerInitRetryCount++;
		const delays = [50, 250, 1000, 2000, 4000];
		if (this._viewerInitRetryCount > delays.length) return;
		const delay = delays[this._viewerInitRetryCount - 1];
		const gen = this._viewerInitRetryGeneration;
		setTimeout(() => {
			try {
				// If a newer _initViewer call has started, abandon this stale retry.
				if (gen !== this._viewerInitRetryGeneration) return;
				this._initViewer(initialValue);
			} catch (e) { console.error('[kusto]', e); }
		}, delay);
	}

	// ── Keyboard shortcuts ────────────────────────────────────────────────────

	private _installKeyboardShortcuts(container: HTMLElement, toastEditor: any): void {
		const markdownFormattingKeys = new Set(['b', 'i', 'u', 'e', 'k', 'l', 'd']);

		const isEditorFocused = () => {
			try {
				const active = document.activeElement;
				if (!active) return false;
				return container.contains(active) && (
					active.classList.contains('ProseMirror') ||
					active.closest?.('.ProseMirror') ||
					active.closest?.('.toastui-editor-contents') ||
					(active as HTMLElement).isContentEditable
				);
			} catch { return false; }
		};

		container.addEventListener('keydown', (ev: KeyboardEvent) => {
			try {
				const key = ev.key.toLowerCase();
				const hasCtrlOrMeta = ev.ctrlKey || ev.metaKey;
				if (!hasCtrlOrMeta) return;
				if (!isEditorFocused()) return;

				// Ctrl+S → redirect to VS Code for save.
				if (key === 's') {
					ev.stopPropagation();
					ev.stopImmediatePropagation();
					ev.preventDefault();
					try {
						const newEvent = new KeyboardEvent('keydown', {
							key: ev.key, code: ev.code, keyCode: ev.keyCode, which: ev.which,
							ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, shiftKey: ev.shiftKey, altKey: ev.altKey,
							bubbles: true, cancelable: true
						});
						document.dispatchEvent(newEvent);
					} catch (e) { console.error('[kusto]', e); }
					return;
				}

				// Ctrl+Z → undo
				if (key === 'z' && !ev.shiftKey) {
					ev.stopPropagation(); ev.stopImmediatePropagation(); ev.preventDefault();
					try { toastEditor.getCurrentModeEditor?.()?.commands?.undo?.(); } catch (e) { console.error('[kusto]', e); }
					return;
				}
				// Ctrl+Shift+Z → redo
				if (key === 'z' && ev.shiftKey) {
					ev.stopPropagation(); ev.stopImmediatePropagation(); ev.preventDefault();
					try { toastEditor.getCurrentModeEditor?.()?.commands?.redo?.(); } catch (e) { console.error('[kusto]', e); }
					return;
				}
				// Ctrl+Y → redo
				if (key === 'y' && !ev.shiftKey) {
					ev.stopPropagation(); ev.stopImmediatePropagation(); ev.preventDefault();
					try { toastEditor.getCurrentModeEditor?.()?.commands?.redo?.(); } catch (e) { console.error('[kusto]', e); }
					return;
				}

				// Formatting shortcuts.
				if (markdownFormattingKeys.has(key)) {
					ev.stopPropagation();
				}
				// Block cut/paste from reaching VS Code.
				if (key === 'v' || key === 'x') {
					ev.stopPropagation();
				}
			} catch (e) { console.error('[kusto]', e); }
		}, true);
	}

	// ── Toolbar button helper ─────────────────────────────────────────────────

	private _createToolbarButton(label: string, title: string, svgHtml: string, onClick: () => void): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'toastui-editor-toolbar-icons ' + label.toLowerCase();
		btn.setAttribute('aria-label', label);
		btn.title = title;
		btn.style.backgroundImage = 'none';
		btn.innerHTML = svgHtml;
		btn.addEventListener('click', onClick);
		return btn;
	}

	// ── Mode switching ────────────────────────────────────────────────────────

	private _setMode(mode: MarkdownMode): void {
		this._mode = mode;
		// Sync with global mode map for legacy code compatibility.
		try {
			const win = window;
			win.__kustoMarkdownModeByBoxId = win.__kustoMarkdownModeByBoxId || {};
			win.__kustoMarkdownModeByBoxId[this.boxId] = mode;
		} catch (e) { console.error('[kusto]', e); }
		this._applyEditorMode();
		this._scheduleMdAutoExpand();
		this._schedulePersist();
	}

	private _setModeAndCloseDropdown(mode: MarkdownMode): void {
		this._dropdownOpen = false;
		this._setMode(mode);
	}

	private _applyEditorMode(): void {
		const editorContainer = this._getEditorContainer();
		const viewerContainer = this._getViewerContainer();
		if (!editorContainer || !viewerContainer) return;

		const isPreview = this._mode === 'preview';
		const wrapper = this.shadowRoot?.getElementById('editor-wrapper');

		// Update host classes.
		this.classList.toggle('is-md-preview', isPreview);

		// Preview sizing behavior.
		if (wrapper) {
			if (isPreview) {
				let fixed = this._userResized;
				if (!fixed) {
					const h = wrapper.style.height?.trim() || '';
					if (/^\d+px$/i.test(h)) {
						fixed = true;
						this._userResized = true;
					}
				}
				if (!fixed) {
					// Store previous height so we can restore later.
					this._prevHeightPx = wrapper.style.height || null;
					wrapper.style.height = '';
				}
				this.classList.toggle('is-md-preview-fixed', fixed);
				this.classList.toggle('is-md-preview-auto', !fixed);
			} else {
				this.classList.remove('is-md-preview-fixed', 'is-md-preview-auto');
			}
		}

		// Toggle editor/viewer visibility.
		editorContainer.style.display = isPreview ? 'none' : '';
		viewerContainer.style.display = isPreview ? '' : 'none';

		if (isPreview) {
			// Strip any border on the viewer container itself (global CSS may add one).
			viewerContainer.style.setProperty('border', 'none', 'important');
			const md = this._editorApi?.getValue() ?? '';
			this._initViewer(md);

			// Auto-fit on entering Preview mode so user sees full rendered content.
			const fit = () => { try { this.fitToContents(); } catch (e) { console.error('[kusto]', e); } };
			fit();
			setTimeout(fit, 50);
			setTimeout(fit, 150);
			setTimeout(fit, 350);

			// In .md files, reset scroll to prevent layout shift.
			this._resetMdScroll();
			return;
		}

		// Editor modes (WYSIWYG / Markdown).
		const toastEditor = this._editorApi?._toastui;
		if (toastEditor && typeof toastEditor.changeMode === 'function') {
			try { toastEditor.changeMode(this._mode, true); } catch (e) { console.error('[kusto]', e); }
		}
		try { this._editorApi?.layout(); } catch (e) { console.error('[kusto]', e); }

		// After a mode switch (especially from preview → editor where the container
		// transitions from display:none to visible), the TOASTUI toolbar may
		// recalculate its item layout before the DOM has finalized dimensions,
		// causing toolbar items to be pushed into the overflow dropdown and the
		// toolbar border to render incorrectly.  Force a second layout pass after
		// the browser has completed the layout cycle.
		requestAnimationFrame(() => {
			try { this._editorApi?.layout(); } catch (e) { console.error('[kusto]', e); }
			// Nudge the toolbar element to trigger its ResizeObserver, which
			// re-runs classifyToolbarItems() with the correct clientWidth.
			try {
				const toolbarEl = editorContainer.querySelector('.toastui-editor-defaultUI-toolbar');
				if (toolbarEl instanceof HTMLElement) {
					// A minimal style toggle forces the ResizeObserver callback.
					toolbarEl.style.minWidth = '0';
					requestAnimationFrame(() => {
						toolbarEl.style.minWidth = '';
					});
				}
			} catch (e) { console.error('[kusto]', e); }
		});

		// In .md files, reset scroll to prevent layout shift.
		this._resetMdScroll();
	}

	/** Reset scroll position for .md files after mode switch. */
	private _resetMdScroll(): void {
		try {
			if (String(pState.documentKind || '') === 'md') {
				document.body.scrollTop = 0;
				document.documentElement.scrollTop = 0;
			}
		} catch (e) { console.error('[kusto]', e); }
	}

	// ── Visibility (expand/collapse) ──────────────────────────────────────────

	private _toggleVisibility(): void {
		this._expanded = !this._expanded;
		this.classList.toggle('is-collapsed', !this._expanded);

		// Sync with global state for legacy code.
		try {
			const win = window;
			win.__kustoMarkdownExpandedByBoxId = win.__kustoMarkdownExpandedByBoxId || {};
			win.__kustoMarkdownExpandedByBoxId[this.boxId] = this._expanded;
		} catch (e) { console.error('[kusto]', e); }

		if (this._expanded) {
			setTimeout(() => { try { this._editorApi?.layout(); } catch (e) { console.error('[kusto]', e); } }, 0);
		}
		this._schedulePersist();
	}

	// ── Dropdown ──────────────────────────────────────────────────────────────

	private _toggleDropdown(e: Event): void {
		e.stopPropagation();
		// Close any global dropdowns first.
		try { _closeAllDropdownMenus(); } catch (e) { console.error('[kusto]', e); }
		this._dropdownOpen = !this._dropdownOpen;
	}

	private _onDocumentClick = (): void => {
		if (this._dropdownOpen) {
			this._dropdownOpen = false;
		}
	};

	// ── Shell event handlers ──────────────────────────────────────────────────

	private _onShellNameChange(e: CustomEvent<{ name: string }>): void {
		this._title = e.detail.name;
		this._schedulePersist();
	}

	// ── Fit to contents ───────────────────────────────────────────────────────

	public fitToContents(): void {
		const wrapper = this.shadowRoot?.getElementById('editor-wrapper');
		if (!wrapper) return;

		if (this._mode === 'preview') {
			// For preview, clear wrapper height and let content auto-size.
			wrapper.style.height = '';
			this._userResized = false;
			this.classList.remove('is-md-preview-fixed');
			this.classList.add('is-md-preview-auto');

			// Ensure viewer is up-to-date before layout.
			const viewerContainer = this._getViewerContainer();
			if (viewerContainer && viewerContainer.style.display !== 'none') {
				const md = this._editorApi?.getValue() ?? '';
				this._initViewer(md);
			}
			this._schedulePersist();
			return;
		}

		const editorContainer = this._getEditorContainer();
		if (!editorContainer) return;

		const applyOnce = () => {
			try {
				const ui = editorContainer.querySelector('.toastui-editor-defaultUI') as HTMLElement | null;
				if (!ui) return;
				const toolbar = ui.querySelector('.toastui-editor-defaultUI-toolbar') as HTMLElement | null;
				const toolbarH = toolbar?.getBoundingClientRect().height ?? 0;

				let contentH = 0;
				if (this._mode === 'wysiwyg') {
					const prose = ui.querySelector('.toastui-editor-ww-container .ProseMirror') as HTMLElement | null;
					if (prose) {
						let minTop = Infinity;
						let maxBottom = 0;
						for (const child of Array.from(prose.children)) {
							if (child.nodeType !== 1) continue;
							const el = child as HTMLElement;
							const top = el.offsetTop ?? 0;
							const h = el.offsetHeight ?? 0;
							let mt = 0, mb = 0;
							try {
								const cs = getComputedStyle(el);
								mt = parseFloat(cs.marginTop || '0') || 0;
								mb = parseFloat(cs.marginBottom || '0') || 0;
							} catch (e) { console.error('[kusto]', e); }
							minTop = Math.min(minTop, Math.max(0, top - mt));
							maxBottom = Math.max(maxBottom, Math.max(0, top + h + mb));
						}
						let docH = 0;
						if (Number.isFinite(minTop) && maxBottom > minTop) {
							docH = maxBottom - minTop;
						}
						try {
							const cs = getComputedStyle(prose);
							docH += (parseFloat(cs.paddingTop || '0') || 0) + (parseFloat(cs.paddingBottom || '0') || 0);
						} catch (e) { console.error('[kusto]', e); }
						if (docH && Number.isFinite(docH)) contentH = Math.ceil(docH);
					}
					if (!contentH) {
						const wwContents = ui.querySelector('.toastui-editor-ww-container .toastui-editor-contents') as HTMLElement | null;
						if (wwContents && wwContents.scrollHeight > (wwContents.clientHeight || 0) + 1) {
							contentH = wwContents.scrollHeight;
						}
					}
				} else {
					// Markdown mode uses CodeMirror.
					const cmSizer = ui.querySelector('.toastui-editor-md-container .CodeMirror .CodeMirror-sizer') as HTMLElement | null;
					if (cmSizer) {
						contentH = Math.max(cmSizer.offsetHeight ?? 0, cmSizer.getBoundingClientRect().height ?? 0);
					}
					if (!contentH) {
						const cmScroll = ui.querySelector('.toastui-editor-md-container .CodeMirror .CodeMirror-scroll') as HTMLElement | null;
						if (cmScroll) contentH = cmScroll.scrollHeight ?? 0;
					}
				}

				if (!contentH) {
					const anyContents = ui.querySelector('.toastui-editor-contents') as HTMLElement | null;
					if (anyContents) contentH = anyContents.scrollHeight ?? 0;
				}

				if (!contentH) return;

				const padding = this._mode === 'wysiwyg' ? -1 : 13;
				const FIT_SLACK_PX = 5;
				const desired = Math.max(120, Math.ceil(toolbarH + contentH + padding + FIT_SLACK_PX));
				wrapper.style.height = desired + 'px';
			} catch (e) { console.error('[kusto]', e); }
			try { this._editorApi?.layout(); } catch (e) { console.error('[kusto]', e); }
		};

		applyOnce();
		setTimeout(applyOnce, 50);
		setTimeout(applyOnce, 150);
		setTimeout(applyOnce, 350);
		this._userResized = true;
		this._schedulePersist();
	}

	// ── Auto-expand for .md files ─────────────────────────────────────────────

	private _autoExpandTimer: ReturnType<typeof setTimeout> | null = null;

	private _scheduleMdAutoExpand(): void {
		try {
			if (String(pState.documentKind || '') !== 'md') return;
			if (this._autoExpandTimer) clearTimeout(this._autoExpandTimer);
			this._autoExpandTimer = setTimeout(() => {
				try { this._autoExpandToContent(); } catch (e) { console.error('[kusto]', e); }
			}, 80);
		} catch (e) { console.error('[kusto]', e); }
	}

	private _autoExpandToContent(): void {
		if (String(pState.documentKind || '') !== 'md') return;
		const wrapper = this.shadowRoot?.getElementById('editor-wrapper');
		const editorContainer = this._getEditorContainer();
		if (!wrapper || !editorContainer) return;

		const apply = () => {
			try {
				const ui = editorContainer.querySelector('.toastui-editor-defaultUI') as HTMLElement | null;
				if (!ui) return;
				const toolbar = ui.querySelector('.toastui-editor-defaultUI-toolbar') as HTMLElement | null;
				const toolbarH = toolbar?.getBoundingClientRect().height ?? 0;
				let contentH = 0;

				if (this._mode === 'wysiwyg') {
					const prose = ui.querySelector('.toastui-editor-ww-container .ProseMirror') as HTMLElement | null;
					if (prose) contentH = prose.scrollHeight ?? 0;
					if (!contentH) {
						const ww = ui.querySelector('.toastui-editor-ww-container .toastui-editor-contents') as HTMLElement | null;
						if (ww) contentH = ww.scrollHeight ?? 0;
					}
				} else if (this._mode === 'markdown') {
					const cmSizer = ui.querySelector('.toastui-editor-md-container .CodeMirror .CodeMirror-sizer') as HTMLElement | null;
					if (cmSizer) contentH = cmSizer.offsetHeight ?? 0;
					if (!contentH) {
						const cmScroll = ui.querySelector('.toastui-editor-md-container .CodeMirror .CodeMirror-scroll') as HTMLElement | null;
						if (cmScroll) contentH = cmScroll.scrollHeight ?? 0;
					}
				}

				if (!contentH) {
					const any = ui.querySelector('.toastui-editor-contents') as HTMLElement | null;
					if (any) contentH = any.scrollHeight ?? 0;
				}
				if (!contentH) return;

				const desired = Math.max(120, Math.ceil(toolbarH + contentH + 18));
				wrapper.style.height = Math.round(desired) + 'px';
				try { this._editorApi?.layout(); } catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
		};

		apply();
		setTimeout(apply, 50);
		setTimeout(apply, 150);
		setTimeout(apply, 350);
	}

	// ── Resize handle ─────────────────────────────────────────────────────────

	private _onResizerMouseDown(e: MouseEvent): void {
		e.preventDefault();
		e.stopPropagation();

		const wrapper = this.shadowRoot?.getElementById('editor-wrapper');
		if (!wrapper) return;

		this._userResized = true;
		const resizer = e.currentTarget as HTMLElement;
		resizer.classList.add('is-dragging');

		const prevCursor = document.body.style.cursor;
		const prevSelect = document.body.style.userSelect;
		document.body.style.cursor = 'ns-resize';
		document.body.style.userSelect = 'none';

		const startPageY = e.clientY + getScrollY();
		const startHeight = wrapper.getBoundingClientRect().height;

		const onMove = (moveEvent: MouseEvent) => {
			try {
				maybeAutoScrollWhileDragging(moveEvent.clientY);
			} catch (e) { console.error('[kusto]', e); }
			const pageY = moveEvent.clientY + getScrollY();
			const delta = pageY - startPageY;
			const minH = this._mode === 'preview' ? 60 : 120;
			const nextHeight = Math.max(minH, startHeight + delta);
			wrapper.style.height = nextHeight + 'px';
			try { this._editorApi?.layout(); } catch (e) { console.error('[kusto]', e); }
		};

		const onUp = () => {
			document.removeEventListener('mousemove', onMove, true);
			document.removeEventListener('mouseup', onUp, true);
			resizer.classList.remove('is-dragging');
			document.body.style.cursor = prevCursor;
			document.body.style.userSelect = prevSelect;
			this._schedulePersist();
		};

		document.addEventListener('mousemove', onMove, true);
		document.addEventListener('mouseup', onUp, true);
	}

	// ── Responsive resize observer ────────────────────────────────────────────

	private _setupResizeObserver(): void {
		if (typeof ResizeObserver === 'undefined') return;
		const NARROW = 450;
		const VERY_NARROW = 250;

		this._resizeObserver = new ResizeObserver(() => {
			const width = this.offsetWidth || 0;
			const narrow = width > 0 && width < NARROW;
			const veryNarrow = width > 0 && width < VERY_NARROW;
			if (narrow !== this._isNarrow || veryNarrow !== this._isVeryNarrow) {
				this._isNarrow = narrow;
				this._isVeryNarrow = veryNarrow;
				this.classList.toggle('is-md-narrow', narrow);
				this.classList.toggle('is-md-very-narrow', veryNarrow);
			}
		});
		this._resizeObserver.observe(this);

		// Initial check.
		const width = this.offsetWidth || 0;
		this._isNarrow = width > 0 && width < NARROW;
		this._isVeryNarrow = width > 0 && width < VERY_NARROW;
		this.classList.toggle('is-md-narrow', this._isNarrow);
		this.classList.toggle('is-md-very-narrow', this._isVeryNarrow);
	}

	private _cleanupResizeObserver(): void {
		if (this._resizeObserver) {
			this._resizeObserver.disconnect();
			this._resizeObserver = null;
		}
	}

	// ── DOM helpers ───────────────────────────────────────────────────────────

	/** Get the slotted editor container from light DOM. */
	private _getEditorContainer(): HTMLElement | null {
		const slot = this.shadowRoot?.querySelector('slot[name="editor"]') as HTMLSlotElement | null;
		if (slot) {
			const assigned = slot.assignedElements();
			if (assigned.length > 0) return assigned[0] as HTMLElement;
		}
		return this.querySelector('.kusto-markdown-editor') as HTMLElement | null;
	}

	/** Get the slotted viewer container from light DOM. */
	private _getViewerContainer(): HTMLElement | null {
		const slot = this.shadowRoot?.querySelector('slot[name="viewer"]') as HTMLSlotElement | null;
		if (slot) {
			const assigned = slot.assignedElements();
			if (assigned.length > 0) return assigned[0] as HTMLElement;
		}
		return this.querySelector('.markdown-viewer') as HTMLElement | null;
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	private _schedulePersist(): void {
		try {
			schedulePersist();
		} catch (e) { console.error('[kusto]', e); }
	}

	/**
	 * Serialize to the .kqlx JSON format.
	 * Output is identical to the original persistence.js Markdown section shape.
	 */
	public serialize(): MarkdownSectionData {
		let text = '';
		if (this._editorApi) {
			text = this._editorApi.getValue();
		}
		if (!text) {
			try {
				const pending = pState.pendingMarkdownTextByBoxId;
				if (pending && typeof pending[this.boxId] === 'string') {
					text = pending[this.boxId];
				}
			} catch (e) { console.error('[kusto]', e); }
		}

		const tab: 'edit' | 'preview' = this._mode === 'preview' ? 'preview' : 'edit';

		const data: MarkdownSectionData = {
			id: this.boxId,
			type: 'markdown',
			title: this._title,
			text,
			tab,
			...(this._mode ? { mode: this._mode } : {}),
			expanded: this._expanded,
		};

		const heightPx = this._getWrapperHeightPx();
		if (heightPx !== undefined) {
			data.editorHeightPx = heightPx;
		}

		return data;
	}

	/** Get the editor wrapper height if user explicitly resized. */
	private _getWrapperHeightPx(): number | undefined {
		const wrapper = this.shadowRoot?.getElementById('editor-wrapper');
		if (!wrapper) return undefined;

		// Check inline height.
		const inlineHeight = wrapper.style.height?.trim();
		if (!inlineHeight || inlineHeight === 'auto') {
			// If we're in preview mode and cached a previous height, use that.
			if (this._prevHeightPx) {
				const m = this._prevHeightPx.match(/^(\d+)px$/i);
				if (m) return parseInt(m[1], 10);
			}
			return undefined;
		}

		const m = inlineHeight.match(/^(\d+)px$/i);
		if (!m) return undefined;

		const px = parseInt(m[1], 10);
		return Number.isFinite(px) ? px : undefined;
	}

	// ── Public API (for legacy integration) ───────────────────────────────────

	/** Get the markdown text from the TOAST UI editor. */
	public getText(): string {
		return this._editorApi?.getValue() ?? '';
	}

	/** Set markdown text in the TOAST UI editor. */
	public setText(text: string): void {
		if (this._editorApi) {
			this._editorApi.setValue(text);
		}
	}

	/** Set the title. */
	public setTitle(title: string): void {
		this._title = title;
	}

	/** Set mode programmatically. */
	public setMarkdownMode(mode: MarkdownMode): void {
		this._setMode(mode);
	}

	/** Set expanded state. */
	public setExpanded(expanded: boolean): void {
		this._expanded = expanded;
		this.classList.toggle('is-collapsed', !expanded);
	}

	/** Get the TOAST UI editor API (for legacy markdownEditors[boxId] compatibility). */
	public getEditorApi(): ToastEditorApi | null {
		return this._editorApi;
	}

	/** Get section name. */
	public getName(): string {
		return this._title;
	}

	/** Re-apply editor mode externally (e.g., after text update from tool). */
	public applyEditorMode(): void {
		this._applyEditorMode();
	}

	// ── Internalized utilities (formerly in extraBoxes-markdown.ts) ────────────

	/** Detect if VS Code is using a dark theme. */
	private static _isDarkTheme(): boolean {
		// Prefer the body classes VS Code toggles on theme change.
		try {
			const cls = document?.body?.classList;
			if (cls) {
				if (cls.contains('vscode-light') || cls.contains('vscode-high-contrast-light')) return false;
				if (cls.contains('vscode-dark') || cls.contains('vscode-high-contrast')) return true;
			}
		} catch (e) { console.error('[kusto]', e); }

		// Fall back to luminance of the editor background.
		let bg = '';
		try {
			bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
			if (!bg) bg = getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background').trim();
		} catch { bg = ''; }
		const rgb = KwMarkdownSection._parseCssColorToRgb(bg);
		if (!rgb) return false;
		const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
		return luminance < 0.5;
	}

	private static _parseCssColorToRgb(value: string): { r: number; g: number; b: number } | null {
		const v = String(value || '').trim();
		if (!v) return null;
		let m = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
		if (m) return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) };
		m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
		if (m) {
			const hex = m[1];
			if (hex.length === 3) return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16) };
			return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
		}
		return null;
	}

	/** Get Toast UI plugins for the editor. */
	private static _getToastUiPlugins(ToastEditor: any): any[] {
		try {
			const colorSyntax = ToastEditor?.plugin?.colorSyntax;
			if (typeof colorSyntax === 'function') return [[colorSyntax, {}]];
		} catch (e) { console.error('[kusto]', e); }
		return [];
	}

	/** Apply dark/light theme class to a TOAST UI host container. */
	private static _applyThemeToHost(hostEl: HTMLElement | null, isDark: boolean): void {
		if (!hostEl) return;
		try {
			// Always toggle on the host element itself — TOAST UI's constructor
			// adds `toastui-editor-dark` to the `el` option (our host) when
			// `theme: 'dark'` is passed. Without this, ancestor-descendant CSS
			// selectors like `.toastui-editor-dark .ProseMirror { color: #fff }`
			// would still match after switching to a light theme.
			hostEl.classList.toggle('toastui-editor-dark', isDark);

			// Also toggle on .toastui-editor-defaultUI elements (if present)
			// so combined selectors like `.toastui-editor-dark.toastui-editor-defaultUI`
			// work correctly.
			const roots = hostEl.querySelectorAll('.toastui-editor-defaultUI');
			for (const el of roots) {
				try { el.classList.toggle('toastui-editor-dark', isDark); } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }
	}

	/** Apply theme to all markdown instances. Called by the singleton observer. */
	static applyThemeAll(): void {
		let isDark = true;
		try { isDark = KwMarkdownSection._isDarkTheme(); } catch { isDark = true; }
		if (KwMarkdownSection._lastAppliedToastUiIsDark === isDark) return;
		KwMarkdownSection._lastAppliedToastUiIsDark = isDark;

		try {
			const boxes: string[] = window.__kustoMarkdownBoxes || [];
			for (const boxId of boxes) {
				const editorHost = document.getElementById(String(boxId) + '_md_editor');
				const viewerHost = document.getElementById(String(boxId) + '_md_viewer');
				KwMarkdownSection._applyThemeToHost(editorHost, isDark);
				KwMarkdownSection._applyThemeToHost(viewerHost, isDark);
			}
		} catch (e) { console.error('[kusto]', e); }
	}

	/** Start the singleton MutationObserver for theme changes. */
	private static _startThemeObserver(): void {
		if (KwMarkdownSection._themeObserverStarted) return;
		KwMarkdownSection._themeObserverStarted = true;

		// Apply once now.
		try { KwMarkdownSection.applyThemeAll(); } catch (e) { console.error('[kusto]', e); }

		let pending = false;
		const schedule = () => {
			if (pending) return;
			pending = true;
			setTimeout(() => {
				pending = false;
				try { KwMarkdownSection.applyThemeAll(); } catch (e) { console.error('[kusto]', e); }
			}, 0);
		};

		try {
			const observer = new MutationObserver(() => schedule());
			if (document?.body) observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
			if (document?.documentElement) observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
		} catch (e) { console.error('[kusto]', e); }
	}

	/** Rewrite relative image src URLs to webview-compatible URIs. */
	private static _rewriteToastUiImages(rootEl: HTMLElement): void {
		try {
			if (!rootEl?.querySelectorAll) return;
			const baseUri = typeof pState.documentUri === 'string' ? String(pState.documentUri) : '';
			if (!baseUri) return;

			pState.resolvedImageSrcCache = pState.resolvedImageSrcCache || {};
			const cache = pState.resolvedImageSrcCache;

			const imgs = rootEl.querySelectorAll('img');
			for (const img of imgs) {
				try {
					const src = String(img.getAttribute('src') || '').trim();
					if (!src) continue;
					const lower = src.toLowerCase();
					if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('blob:') ||
						lower.startsWith('vscode-webview://') || lower.startsWith('vscode-resource:')) continue;
					try { if (img.dataset?.kustoResolvedSrc === src) continue; } catch (e) { console.error('[kusto]', e); }

					const key = baseUri + '::' + src;
					if (cache && typeof cache[key] === 'string' && cache[key]) {
						img.setAttribute('src', cache[key]);
						try { if (img.dataset) img.dataset.kustoResolvedSrc = src; } catch (e) { console.error('[kusto]', e); }
						continue;
					}

					const resolver = window.__kustoResolveResourceUri;
					if (typeof resolver !== 'function') continue;

					resolver({ path: src, baseUri }).then((resolved: any) => {
						try {
							if (!resolved || typeof resolved !== 'string') return;
							cache[key] = resolved;
							img.setAttribute('src', resolved);
							try { if (img.dataset) img.dataset.kustoResolvedSrc = src; } catch (e) { console.error('[kusto]', e); }
						} catch (e) { console.error('[kusto]', e); }
					});
				} catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }
	}

	/** Apply any pending markdown reveal that was queued before the editor initialized. */
	private _tryApplyPendingReveal(): void {
		try {
			const map = pState.pendingMarkdownRevealByBoxId;
			const pending = map?.[this.boxId];
			if (!pending) return;
			try { if (map) delete map[this.boxId]; } catch (e) { console.error('[kusto]', e); }
			this.revealRange(pending);
		} catch (e) { console.error('[kusto]', e); }
	}

	/** Reveal a text range in the markdown editor (for search/find integration). */
	public revealRange(payload: any): void {
		if (!payload) return;
		const toast = this._editorApi?._toastui;
		if (!toast || typeof toast.setSelection !== 'function') {
			// Queue for later if editor not ready.
			pState.pendingMarkdownRevealByBoxId = pState.pendingMarkdownRevealByBoxId || {};
			pState.pendingMarkdownRevealByBoxId[this.boxId] = payload;
			return;
		}

		const sl = typeof payload.startLine === 'number' ? payload.startLine : 0;
		const sc = typeof payload.startChar === 'number' ? payload.startChar : 0;
		const el = typeof payload.endLine === 'number' ? payload.endLine : sl;
		const ec = typeof payload.endChar === 'number' ? payload.endChar : sc;
		const matchText = typeof payload.matchText === 'string' ? String(payload.matchText) : '';
		const startOffset = typeof payload.startOffset === 'number' ? payload.startOffset : undefined;

		try { this.scrollIntoView({ block: 'center' }); } catch (e) { console.error('[kusto]', e); }

		// Get the editor's markdown text for offset-based search.
		const mdText = (() => {
			try { return typeof toast.getMarkdown === 'function' ? String(toast.getMarkdown() || '') : String(this._editorApi?.getValue() || ''); }
			catch { return ''; }
		})();

		const computeLineChar1Based = (text: string, offset0: number): [number, number] => {
			const t = String(text || '');
			const off = Math.max(0, Math.min(t.length, Math.floor(offset0)));
			const before = t.slice(0, off);
			const line = before.split('\n').length;
			const lastNl = before.lastIndexOf('\n');
			const ch = off - (lastNl >= 0 ? (lastNl + 1) : 0) + 1;
			return [Math.max(1, line), Math.max(1, ch)];
		};

		let foundStart = 0;
		let foundEnd = 0;
		if (matchText) {
			const preferred = (typeof startOffset === 'number' && Number.isFinite(startOffset)) ? Math.max(0, Math.floor(startOffset)) : undefined;
			let idx = -1;
			try {
				if (typeof preferred === 'number' && mdText.startsWith(matchText, preferred)) {
					idx = preferred;
				} else if (typeof preferred === 'number') {
					const forward = mdText.indexOf(matchText, preferred);
					const back = mdText.lastIndexOf(matchText, preferred);
					if (forward < 0) idx = back;
					else if (back < 0) idx = forward;
					else idx = (Math.abs(forward - preferred) <= Math.abs(preferred - back)) ? forward : back;
				} else {
					idx = mdText.indexOf(matchText);
				}
			} catch { idx = -1; }
			if (idx >= 0) {
				foundStart = idx;
				foundEnd = idx + matchText.length;
			}
		}

		const mdStart: [number, number] = (matchText && foundEnd > foundStart)
			? computeLineChar1Based(mdText, foundStart)
			: [Math.max(1, sl + 1), Math.max(1, sc + 1)];
		const mdEnd: [number, number] = (matchText && foundEnd > foundStart)
			? computeLineChar1Based(mdText, foundEnd)
			: [Math.max(1, el + 1), Math.max(1, ec + 1)];

		const applySelection = () => {
			try {
				if (this._mode === 'preview') {
					// In preview mode, try to select in the rendered DOM.
					const viewerContainer = this._getViewerContainer();
					if (viewerContainer && matchText) {
						const walker = document.createTreeWalker(viewerContainer, NodeFilter.SHOW_TEXT);
						while (walker.nextNode()) {
							const n = walker.currentNode;
							const text = typeof n.nodeValue === 'string' ? n.nodeValue : '';
							const at = text.indexOf(matchText);
							if (at >= 0) {
								const range = document.createRange();
								range.setStart(n, at);
								range.setEnd(n, at + matchText.length);
								try {
									const sel = window.getSelection?.();
									if (sel) { sel.removeAllRanges(); sel.addRange(range); }
								} catch (e) { console.error('[kusto]', e); }
								try { (range.startContainer.parentElement as HTMLElement)?.scrollIntoView({ block: 'center' }); } catch (e) { console.error('[kusto]', e); }
								return;
							}
						}
					}
					return;
				}

				if (this._mode === 'wysiwyg') {
					let from = 0, to = 0;
					try {
						if (typeof toast.convertPosToMatchEditorMode === 'function') {
							const converted = toast.convertPosToMatchEditorMode(mdStart, mdEnd, 'wysiwyg');
							if (converted && typeof converted[0] === 'number' && typeof converted[1] === 'number') {
								from = converted[0]; to = converted[1];
							}
						}
					} catch (e) { console.error('[kusto]', e); }
					try { toast.setSelection(from, to); } catch (e) { console.error('[kusto]', e); }
				} else {
					try { toast.setSelection(mdStart, mdEnd); } catch (e) { console.error('[kusto]', e); }
				}
				try { if (typeof toast.focus === 'function') toast.focus(); } catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
		};

		applySelection();
		setTimeout(applySelection, 50);
		setTimeout(applySelection, 150);
	}
}

function _getLitEl(boxId: unknown): KwMarkdownSection | null {
	const el = document.getElementById(String(boxId || ''));
	return (el && typeof (el as any).fitToContents === 'function') ? (el as KwMarkdownSection) : null;
}

export function addMarkdownBox(options: Record<string, unknown> = {}): string {
	return KwMarkdownSection.addMarkdownBox(options);
}

export function removeMarkdownBox(boxId: unknown): void {
	const id = String(boxId || '');
	if (!id) return;
	if (markdownEditors[id]) {
		try { markdownEditors[id].dispose(); } catch (e) { console.error('[kusto]', e); }
		delete markdownEditors[id];
	}
	const idx = markdownBoxes.indexOf(id);
	if (idx >= 0) markdownBoxes.splice(idx, 1);
	const box = document.getElementById(id);
	if (box?.parentNode) box.parentNode.removeChild(box);
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	try {
		if (window.__kustoMarkdownModeByBoxId && typeof window.__kustoMarkdownModeByBoxId === 'object') {
			delete window.__kustoMarkdownModeByBoxId[id];
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoMaximizeMarkdownBox(boxId: unknown): void {
	const el = _getLitEl(boxId);
	if (!el) return;
	const fit = () => { try { el.fitToContents(); } catch (e) { console.error('[kusto]', e); } };
	fit();
	setTimeout(fit, 50);
	setTimeout(fit, 150);
	setTimeout(fit, 350);
}

export function __kustoSetMarkdownMode(boxId: unknown, mode: unknown): void {
	const el = _getLitEl(boxId);
	if (el) el.setMarkdownMode(mode as any);
}

export function __kustoApplyMarkdownEditorMode(boxId: unknown): void {
	const el = _getLitEl(boxId);
	if (el) el.applyEditorMode();
}

export function __kustoGetMarkdownMode(boxId: unknown): 'preview' | 'markdown' | 'wysiwyg' {
	try {
		const map = window.__kustoMarkdownModeByBoxId;
		const v = map && boxId ? String(map[String(boxId)] || '') : '';
		if (v === 'preview' || v === 'markdown' || v === 'wysiwyg') return v;
	} catch (e) { console.error('[kusto]', e); }
	return 'wysiwyg';
}

export function getToastUiPlugins(ToastEditor: any): any[] {
	return (KwMarkdownSection as any)._getToastUiPlugins(ToastEditor);
}

function __kustoApplyToastUiThemeAll(): void {
	try { KwMarkdownSection.applyThemeAll(); } catch (e) { console.error('[kusto]', e); }
}

window.__kustoMaximizeMarkdownBox = __kustoMaximizeMarkdownBox;
window.__kustoSetMarkdownMode = __kustoSetMarkdownMode;
window.__kustoApplyMarkdownEditorMode = __kustoApplyMarkdownEditorMode;
window.getToastUiPlugins = getToastUiPlugins;
window.addMarkdownBox = addMarkdownBox;
window.removeMarkdownBox = removeMarkdownBox;
window.__kustoApplyToastUiThemeAll = __kustoApplyToastUiThemeAll;

declare global {
	interface HTMLElementTagNameMap {
		'kw-markdown-section': KwMarkdownSection;
	}
}
