import { pState } from '../shared/persistence-state';
import type { SectionElement } from '../shared/dom-helpers';
import { postMessageToHost } from '../shared/webview-messages';
import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { styles } from './kw-html-section.styles.js';
import { sectionGlowStyles } from '../shared/section-glow.styles.js';
import { sashSheet } from '../shared/sash-styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';
import { osStyles } from '../shared/os-styles.js';
import { OverlayScrollbarsController } from '../components/overlay-scrollbars.controller.js';
import { customElement, property, state } from 'lit/decorators.js';
import '../components/kw-section-shell.js';
import '../components/kw-monaco-toolbar.js';
import '../components/kw-publish-pbi-dialog.js';
import type { MonacoToolbarItem } from '../components/kw-monaco-toolbar.js';
import {
	undoIcon, redoIcon, prettifyIcon, commentHtmlIcon, searchIcon, replaceIcon,
	indentIcon, outdentIcon, wordWrapIcon, exportIcon, uploadIcon,
} from '../shared/icon-registry.js';
import { getScrollY, maybeAutoScrollWhileDragging } from '../core/utils.js';
import { schedulePersist } from '../core/persistence.js';
import { getResultsState } from '../core/results-state.js';
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
	dataSourceIds?: string[];
}

// ─── Provenance ───────────────────────────────────────────────────────────────

/** A single data binding declared inside `<script type="application/kw-provenance">`. */
export interface KwProvenanceBinding {
	sectionId: string;
	sectionName: string;
	query?: string;
	columns?: string[];
}

/** Parsed provenance block from the HTML code. */
export interface KwProvenance {
	version: number;
	bindings: Record<string, KwProvenanceBinding>;
}

/**
 * Parse the `<script type="application/kw-provenance">` block from HTML code.
 * Returns null if no provenance block is found or it's invalid JSON.
 */
export function parseKwProvenance(htmlCode: string): KwProvenance | null {
	try {
		const match = htmlCode.match(/<script\s+type\s*=\s*["']application\/kw-provenance["'][^>]*>([\s\S]*?)<\/script>/i);
		if (!match) return null;
		const json = JSON.parse(match[1]);
		if (!json || typeof json !== 'object' || !json.bindings || typeof json.bindings !== 'object') return null;
		return json as KwProvenance;
	} catch {
		return null;
	}
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
export class KwHtmlSection extends LitElement implements SectionElement {

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
	/** Parsed from `<script type="application/kw-provenance">` in the HTML code. */
	@state() private _provenance: KwProvenance | null = null;

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
				this._lastPreviewFitHeight = 0;
				this.updateComplete.then(() => {
					try { this._editor?.layout(); } catch (e) { console.error('[kusto]', e); }
					this._updatePlaceholder();
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

	static override styles = [...osStyles, scrollbarSheet, sashSheet, styles, sectionGlowStyles];

	// ── Render ─────────────────────────────────────────────────────────────────

	override render() {
		return html`
			<div class="section-root">
			<kw-section-shell
				.name=${this._name}
				.expanded=${this._expanded}
				box-id=${this.boxId}
				section-type="html"
				name-placeholder="HTML name (optional)"
				@name-change=${this._onShellNameChange}
				@toggle-visibility=${this._toggleVisibility}
				@fit-to-contents=${this._fitToContents}>
				${this._renderToolbar()}
				${this._expanded ? (this._mode === 'code' ? this._renderCodeMode() : this._renderPreviewMode()) : nothing}
			</kw-section-shell>
			<kw-publish-pbi-dialog></kw-publish-pbi-dialog>
			</div>
		`;
	}

	// ── Toolbar ───────────────────────────────────────────────────────────────

	private _renderToolbar(): TemplateResult {
		const bindingCount = this._provenance ? Object.keys(this._provenance.bindings).length : 0;
		return html`
			<div slot="header-buttons" class="html-mode-buttons">
				<button class="unified-btn-secondary md-tab md-mode-btn ${this._mode === 'code' ? 'is-active' : ''}"
					type="button" role="tab" aria-selected=${this._mode === 'code' ? 'true' : 'false'}
					@click=${() => this._setMode('code')} title="Edit">Edit</button>
				<button class="unified-btn-secondary md-tab md-mode-btn ${this._mode === 'preview' ? 'is-active' : ''}"
					type="button" role="tab" aria-selected=${this._mode === 'preview' ? 'true' : 'false'}
					@click=${() => this._setMode('preview')} title="Preview">Preview</button>
				<span class="query-editor-toolbar-sep"></span>
				<button class="header-tab" type="button"
					@click=${this._publishToPowerBI} title="Publish to Power BI service"
					aria-label="Publish to Power BI service"
					?disabled=${bindingCount === 0}>
					${uploadIcon}
				</button>
				<button class="header-tab" type="button"
					@click=${this._exportDashboard} title="Save dashboard as HTML or Power BI file"
					aria-label="Save dashboard as HTML or Power BI file">
					${exportIcon}
				</button>
			</div>
		`;
	}

	// ── Provenance detection ──────────────────────────────────────────────────

	/** Re-parse provenance from the current HTML code. Called on content change. */
	private _refreshProvenance(): void {
		const code = this._getCodeText();
		this._provenance = parseKwProvenance(code);
	}

	/** Get the section IDs referenced by the provenance bindings. */
	private _getProvenanceSectionIds(): string[] {
		if (!this._provenance) return [];
		return [...new Set(Object.values(this._provenance.bindings).map(b => b.sectionId).filter(Boolean))];
	}

	// ── Export dashboard (unified HTML / Power BI) ────────────────────────────

	/** Best-effort collection of data sources for PBI export. Returns empty array on failure. */
	private _collectDataSourcesForPBI(): Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }> {
		const provenance = parseKwProvenance(this._getCodeText());
		if (!provenance || Object.keys(provenance.bindings).length === 0) return [];

		const dataSources: Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }> = [];
		for (const [, binding] of Object.entries(provenance.bindings)) {
			const dsId = binding.sectionId;
			const el = document.getElementById(dsId) as any;
			if (!el || !dsId.startsWith('query_')) continue;
			const rsState = getResultsState(dsId);
			if (!rsState || !rsState.columns?.length) continue;

			let resolvedCluster = '';
			let resolvedDb = '';
			let resolvedQuery = '';
			try {
				if (typeof el.serialize === 'function') {
					const serialized = el.serialize();
					resolvedCluster = serialized.clusterUrl || '';
					resolvedDb = serialized.database || '';
					resolvedQuery = serialized.query || '';
				}
			} catch (e) { console.error('[kusto]', e); }

			if (!resolvedCluster || !resolvedDb) continue;

			const sectionName = binding.sectionName || dsId.replace('query_', 'Query_');
			const columns = rsState.columns.map((c: any) => ({
				name: typeof c === 'string' ? c : (c?.name || c?.displayName || 'column'),
				type: typeof c === 'object' ? (c?.type || 'string') : 'string',
			}));

			dataSources.push({ name: sectionName, sectionId: dsId, clusterUrl: resolvedCluster, database: resolvedDb, query: resolvedQuery, columns });
		}
		return dataSources;
	}

	/** Measure the current preview height for PBI page sizing. */
	private _measurePreviewHeight(): number | undefined {
		if (this._lastPreviewFitHeight > 0) return this._lastPreviewFitHeight;
		if (this._savedPreviewHeightPx && this._savedPreviewHeightPx > 0) return this._savedPreviewHeightPx;
		const wrapper = this.shadowRoot?.getElementById('preview-wrapper');
		if (wrapper && wrapper.clientHeight > 0) return wrapper.clientHeight;
		return undefined;
	}

	private _exportDashboard(): void {
		const code = this._getCodeText();
		if (!code.trim()) {
			try { postMessageToHost({ type: 'showInfo', message: 'There is no HTML content to export.' }); } catch (e) { console.error('[kusto]', e); }
			return;
		}
		try {
			postMessageToHost({
				type: 'exportDashboard',
				boxId: this.boxId,
				html: code,
				suggestedFileName: this._name || '',
				previewHeight: this._measurePreviewHeight(),
				dataSources: this._collectDataSourcesForPBI(),
			});
		} catch (e) { console.error('[kusto]', e); }
	}

	private _publishToPowerBI(): void {
		const code = this._getCodeText();
		if (!code.trim()) {
			try { postMessageToHost({ type: 'showInfo', message: 'Write some HTML content before publishing to Power BI.' }); } catch (e) { console.error('[kusto]', e); }
			return;
		}

		const dataSources = this._collectDataSourcesForPBI();
		if (dataSources.length === 0) {
			try { postMessageToHost({ type: 'showInfo', message: 'No data bindings found. Add a provenance block and run queries before publishing.' }); } catch (e) { console.error('[kusto]', e); }
			return;
		}

		this._openPublishDialog(code, dataSources, this._measurePreviewHeight(), this._name || 'KustoHtmlDashboard');
	}

	private _openPublishDialog(htmlCode: string, dataSources: Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }>, previewHeight: number | undefined, suggestedName: string): void {
		const dialog = this.shadowRoot?.querySelector<any>('kw-publish-pbi-dialog');
		if (dialog) {
			dialog.show(dataSources, htmlCode, suggestedName, previewHeight, this.boxId);
		}
	}

	// ── Code mode ─────────────────────────────────────────────────────────────

	/** Ordered toolbar items for overflow system. */
	private get _toolbarItems(): MonacoToolbarItem[] {
		return [
			{ type: 'button', label: 'Undo', title: 'Undo (Ctrl+Z)', action: () => this._undo(), icon: undoIcon },
			{ type: 'button', label: 'Redo', title: 'Redo (Ctrl+Y)', action: () => this._redo(), icon: redoIcon },
			{ type: 'separator' },
			{ type: 'button', label: 'Format', title: 'Format Document (Shift+Alt+F)', action: () => this._formatDocument(), icon: prettifyIcon },
			{ type: 'button', label: 'Comment', title: 'Toggle Comment (Ctrl+/)', action: () => this._toggleComment(), icon: commentHtmlIcon },
			{ type: 'separator' },
			{ type: 'button', label: 'Indent', title: 'Indent (Tab)', action: () => this._indent(), icon: indentIcon },
			{ type: 'button', label: 'Outdent', title: 'Outdent (Shift+Tab)', action: () => this._outdent(), icon: outdentIcon },
			{ type: 'separator' },
			{ type: 'button', label: 'Find', title: 'Find (Ctrl+F)', action: () => this._find(), icon: searchIcon },
			{ type: 'button', label: 'Replace', title: 'Find and Replace (Ctrl+H)', action: () => this._findReplace(), icon: replaceIcon },
			{ type: 'separator' },
			{ type: 'button', label: 'Word Wrap', title: 'Toggle Word Wrap', action: () => this._toggleWordWrap(), icon: wordWrapIcon, isActive: this._wordWrap },
		];
	}

	private _renderCodeMode(): TemplateResult {
		return html`
			<div class="editor-wrapper" id="editor-wrapper">
				<kw-monaco-toolbar box-id=${this.boxId} .items=${this._toolbarItems} aria-label="HTML editor tools"></kw-monaco-toolbar>
				<div class="editor-area">
					<div class="editor-placeholder" id="editor-placeholder">Probably best to let the agent do this part ...</div>
					<slot name="editor"></slot>
				</div>
			</div>
			<div class="resizer"
				title="Drag to resize\nDouble-click to fit to contents"
				@mousedown=${this._onEditorResizerMouseDown}
				@dblclick=${this._fitToContents}></div>
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
			<div class="resizer"
				title="Drag to resize\nDouble-click to fit to contents"
				@mousedown=${this._onPreviewResizerMouseDown}
				@dblclick=${this._fitToContents}></div>
		`;
	}

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
				scrollbar: { alwaysConsumeMouseWheel: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
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
					this._refreshProvenance();
				});
			} catch (e) { console.error('[kusto]', e); }

			// Parse provenance from initial content.
			this._refreshProvenance();

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
				const dataBridge = this._buildDataBridgeScript();
				iframe.srcdoc = dataBridge + code + KwHtmlSection._heightReportScript;
			}
		});
	}

	/** Build a <script> block that injects KustoWorkbench data bridge into the iframe. */
	private _buildDataBridgeScript(): string {
		const sectionIds = this._getProvenanceSectionIds();
		if (sectionIds.length === 0) return '';

		const MAX_ROWS = 10_000;
		const sections: Record<string, { columns: Array<{ name: string; type: string }>; rows: unknown[][] }> = {};

		for (const dsId of sectionIds) {
			const rs = getResultsState(dsId);
			if (!rs || !rs.columns) continue;
			const el = document.getElementById(dsId) as any;
			const name = (typeof el?.getName === 'function' ? el.getName() : '') || dsId.replace('query_', 'Query_');
			const columns = (rs.columns || []).map((c: any) => ({
				name: typeof c === 'string' ? c : (c?.name || 'column'),
				type: typeof c === 'object' ? (c?.type || 'string') : 'string',
			}));
			const rows = Array.isArray(rs.rows) ? rs.rows.slice(0, MAX_ROWS) : [];
			sections[name] = { columns, rows };
		}

		// Serialize and escape </script> to prevent XSS (C2 from review)
		const json = JSON.stringify({ sections }).replace(/<\//g, '<\\/');

		return `<script>
(function(){
	var _d=${json};
	var _cbs=[];
	window.KustoWorkbench={
		getData:function(){return _d;},
		onDataReady:function(cb){_cbs.push(cb);try{cb(_d);}catch(e){console.error(e);}},
		_notify:function(d){_d=d;for(var i=0;i<_cbs.length;i++){try{_cbs[i](d);}catch(e){console.error(e);}}}
	};
})();
<\/script>\n`;
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
			if (!e.data) return;

			// Messages from the sandboxed iframe: only allow kw-html-preview-height.
			const iframe = this.shadowRoot?.getElementById('preview-iframe') as HTMLIFrameElement | null;
			if (iframe && e.source === iframe.contentWindow) {
				if (e.data.type !== 'kw-html-preview-height') return;
				const h = Number(e.data.h);
				if (!Number.isFinite(h) || h <= 0) return;
				this._applyPreviewFitHeight(h);
				return;
			}

			// Host→webview messages (e.source is null for VS Code postMessage)
			if (e.data.type === 'openPublishPbiDialog' && e.data.boxId === this.boxId) {
				this._openPublishDialog(e.data.htmlCode, e.data.dataSources, e.data.previewHeight, e.data.suggestedName);
				return;
			}

			if ((e.data.type === 'pbiWorkspacesResult' || e.data.type === 'publishToPowerBIResult') && e.data.boxId === this.boxId) {
				const dialog = this.shadowRoot?.querySelector<any>('kw-publish-pbi-dialog');
				if (dialog) dialog.handleHostMessage(e.data);
				return;
			}
		} catch (ex) { console.error('[kusto]', ex); }
	}

	/** Apply the measured content height to the preview wrapper.
	 *  Skips small adjustments (< 5 px) to avoid a resize feedback loop
	 *  between the wrapper and the iframe's ResizeObserver. */
	private _lastPreviewFitHeight = 0;
	private _applyPreviewFitHeight(contentH: number): void {
		if (this._userResizedPreview) return;
		const wrapper = this.shadowRoot?.getElementById('preview-wrapper');
		if (!wrapper) return;
		const fitH = Math.max(120, Math.ceil(contentH));
		if (this._lastPreviewFitHeight > 0 && Math.abs(fitH - this._lastPreviewFitHeight) < 5) return;
		this._lastPreviewFitHeight = fitH;
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
			const nextHeight = Math.max(120, Math.min(2000, startHeight + delta));
			wrapper.style.height = nextHeight + 'px';
			wrapper.style.maxHeight = nextHeight + 'px';
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
		this._refreshProvenance();
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

	public getDataSourceIds(): string[] { return this._getProvenanceSectionIds(); }
	public setDataSourceIds(_ids: string[]): void {
		// No-op: data sources are now declared via provenance in the HTML code.
		// Kept for backward compatibility with addHtmlBox() restore path.
	}

	/** Called by the cascade system when a referenced data source's results change. */
	public refreshDataBridge(): void {
		if (this._mode === 'preview') this._updatePreview();
	}

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
