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
import { getResultsState, getRawCellValue } from '../core/results-state.js';
import { __kustoForceEditorWritable, __kustoEnsureEditorWritableSoon, __kustoInstallWritableGuard } from '../monaco/writable.js';
import { __kustoAttachAutoResizeToContent } from '../monaco/resize.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type HtmlSectionMode = 'code' | 'preview';

/** Power BI publish metadata — mirrors the host-side PbiPublishInfo in kqlxFormat.ts. */
export interface PbiPublishInfo {
	workspaceId: string;
	workspaceName?: string;
	semanticModelId: string;
	reportId: string;
	reportName: string;
	reportUrl: string;
}

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
	pbiPublishInfo?: PbiPublishInfo;
}

// ─── Provenance v1 — shared data model ────────────────────────────────────────

export interface KwModelFact { sectionId: string; sectionName: string }
export interface KwModelDimension { column: string; label?: string; mode?: 'dropdown' | 'list' | 'between' }

/** Parsed provenance block from the HTML code. */
export interface KwProvenance {
	version: number;
	model: { fact: KwModelFact; dimensions?: KwModelDimension[] };
	bindings: Record<string, { display?: unknown }>;
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
		if (!json || typeof json !== 'object') return null;
		if (!json.model?.fact?.sectionId) return null;
		if (!json.bindings || typeof json.bindings !== 'object') return null;
		return { version: json.version ?? 1, model: json.model, bindings: json.bindings };
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
	/** Power BI publish metadata — set after first successful publish, persisted in .kqlx. */
	@state() private _pbiPublishInfo: PbiPublishInfo | undefined;

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
	/** MutationObserver for theme changes (body class/style). */
	private _themeObserver: MutationObserver | null = null;
	/** Last observed theme fingerprint — prevents non-theme mutations from triggering rebuilds. */
	private _themeFingerprint: string | null = null;

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	override connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener('message', this._onMessage);
		this._setupThemeObserver();
		// Re-create editor after a DOM move (reorder).
		if (this._savedCode !== null) {
			this.updateComplete.then(() => this._initEditor());
		}
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		window.removeEventListener('message', this._onMessage);
		this._themeObserver?.disconnect();
		this._themeObserver = null;
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

		// Parse provenance eagerly so slicers work when the section loads
		// directly in preview mode (editor init is skipped in that path).
		this._refreshProvenance();

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

	/** Get the section IDs referenced by the provenance model (just the fact table). */
	private _getProvenanceSectionIds(): string[] {
		if (!this._provenance?.model?.fact?.sectionId) return [];
		return [this._provenance.model.fact.sectionId];
	}

	// ── Export dashboard (unified HTML / Power BI) ────────────────────────────

	/** Best-effort collection of the fact data source for PBI export. Returns empty array on failure. */
	private _collectDataSourcesForPBI(): Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }> {
		const provenance = parseKwProvenance(this._getCodeText());
		if (!provenance?.model?.fact?.sectionId) return [];

		const dsId = provenance.model.fact.sectionId;
		const el = document.getElementById(dsId) as any;
		if (!el || !dsId.startsWith('query_')) return [];
		const rsState = getResultsState(dsId);
		if (!rsState || !rsState.columns?.length) return [];

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

		if (!resolvedCluster || !resolvedDb) return [];

		const sectionName = provenance.model.fact.sectionName
			|| (typeof el.getName === 'function' ? el.getName() : '')
			|| dsId.replace('query_', 'Query_');
		const columns = rsState.columns.map((c: any) => ({
			name: typeof c === 'string' ? c : (c?.name || c?.displayName || 'column'),
			type: typeof c === 'object' ? (c?.type || 'string') : 'string',
		}));

		return [{ name: sectionName, sectionId: dsId, clusterUrl: resolvedCluster, database: resolvedDb, query: resolvedQuery, columns }];
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
			dialog.show(dataSources, htmlCode, suggestedName, previewHeight, this.boxId, this._pbiPublishInfo);
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

	/** Build a <script> block that injects KustoWorkbench fact data bridge into the iframe. */
	private _buildDataBridgeScript(): string {
		const factSectionId = this._provenance?.model?.fact?.sectionId;
		if (!factSectionId) return '';

		const rs = getResultsState(factSectionId);
		if (!rs || !rs.columns) return '';

		const MAX_ROWS = 10_000;
		const columns = (rs.columns || []).map((c: any) => ({
			name: typeof c === 'string' ? c : (c?.name || 'column'),
			type: typeof c === 'object' ? (c?.type || 'string') : 'string',
		}));
		const allRows = Array.isArray(rs.rows) ? rs.rows : [];
		const capped = allRows.length > MAX_ROWS;
		const rawRows = capped ? allRows.slice(0, MAX_ROWS) : allRows;

		// Unwrap cell objects ({display,full} → primitive) before serializing to iframe.
		// This ensures all JS code in the iframe sees plain values, not wrapper objects.
		const rows = rawRows.map((row: unknown[]) =>
			row.map((cell: unknown) => getRawCellValue(cell)),
		);

		const fact = { columns, rows, totalRows: allRows.length, capped };
		const json = JSON.stringify({ fact }).replace(/<\//g, '<\\/');

		// Build slicer emulation from model.dimensions
		const dimensions = this._provenance?.model?.dimensions;
		let slicerBlock = '';
		if (dimensions && dimensions.length > 0) {
			slicerBlock = this._buildSlicerBlock(dimensions, columns, rows);
		}

		return `<script>
(function(){
	var _d=${json};
	var _full=JSON.parse(JSON.stringify(_d));
	var _cbs=[];
	function _cellVal(c){if(c&&typeof c==='object'){if('full' in c&&c.full!=null)return _cellVal(c.full);if('display' in c&&c.display!=null)return _cellVal(c.display);}return c;}
	function _esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
	function _fmtDate(s){if(s==null)return '';if(s instanceof Date)s=s.toISOString();if(typeof s!=='string')s=String(s);var vm=/^[A-Z][a-z]{2} [A-Z][a-z]{2} \\d/.test(s);if(vm){var p=Date.parse(s);if(isFinite(p))s=new Date(p).toISOString();}if(/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}/.test(s)){var d=s.replace('T',' ').replace(/\\.\\d+Z?$/,'').replace(/Z$/,'');return d.endsWith(' 00:00:00')?d.substring(0,10):d;}if(/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$/.test(s))return s.endsWith(' 00:00:00')?s.substring(0,10):s;if(/^\\d{4}-\\d{2}-\\d{2}$/.test(s))return s;return s;}
	function _fmtVal(v){if(v==null)return '';if(typeof v==='number'){if(v>1e12&&v<2e13){var ds=new Date(v).toISOString();return _fmtDate(ds);}return v.toLocaleString();}var s=String(v);return _fmtDate(s);}
	function _colIdx(cols,name){for(var i=0;i<cols.length;i++){if(cols[i].name===name)return i;}return -1;}
	function _num(v){var n=Number(v);return isFinite(n)?n:0;}
	function _agg(optFact){
		var f=optFact||_d.fact;
		var cols=f.columns,rows=f.rows;
		function ci(name){return _colIdx(cols,name);}
		var api={
			count:function(){return rows.length;},
			dcount:function(col){var i=ci(col);if(i<0)return 0;var s=new Set();for(var r=0;r<rows.length;r++){var v=_cellVal(rows[r][i]);if(v!=null)s.add(v);}return s.size;},
			sum:function(col){var i=ci(col);if(i<0)return 0;var t=0;for(var r=0;r<rows.length;r++)t+=_num(_cellVal(rows[r][i]));return t;},
			avg:function(col){return rows.length?api.sum(col)/rows.length:0;},
			min:function(col){var i=ci(col);if(i<0)return undefined;var m;for(var r=0;r<rows.length;r++){var v=_cellVal(rows[r][i]);if(m===undefined||v<m)m=v;}return m;},
			max:function(col){var i=ci(col);if(i<0)return undefined;var m;for(var r=0;r<rows.length;r++){var v=_cellVal(rows[r][i]);if(m===undefined||v>m)m=v;}return m;},
			groupBy:function(keys){
				var kis=keys.map(ci);
				var specs=[];
				function builder(){return{
					addCount:function(name){specs.push({name:name,type:'count'});return builder();},
					addDcount:function(name,srcCol){specs.push({name:name,type:'dcount',src:ci(srcCol)});return builder();},
					addSum:function(name,srcCol){specs.push({name:name,type:'sum',src:ci(srcCol)});return builder();},
					addAvg:function(name,srcCol){specs.push({name:name,type:'avg',src:ci(srcCol)});return builder();},
					addMin:function(name,srcCol){specs.push({name:name,type:'min',src:ci(srcCol)});return builder();},
					addMax:function(name,srcCol){specs.push({name:name,type:'max',src:ci(srcCol)});return builder();},
					orderBy:function(sortCol,dir){
						var rs=builder().rows();
						rs.sort(function(a,b){var av=a[sortCol],bv=b[sortCol];if(av===bv)return 0;var ta=typeof av==='string'&&Date.parse(av),tb=typeof bv==='string'&&Date.parse(bv);if(ta&&tb){av=ta;bv=tb;}var d=(dir||'asc')==='asc'?1:-1;return av<bv?-d:d;});
						return{rows:function(){return rs;},toTable:function(headers){return _toTable(rs,keys,specs,headers);},topN:function(n){if(n>0)rs=rs.slice(0,n);return{rows:function(){return rs;},toTable:function(headers){return _toTable(rs,keys,specs,headers);}};}};
					},
					topN:function(n,sortCol,dir){
						var rs=builder().rows();
						rs.sort(function(a,b){var av=a[sortCol],bv=b[sortCol];if(av===bv)return 0;var ta=typeof av==='string'&&Date.parse(av),tb=typeof bv==='string'&&Date.parse(bv);if(ta&&tb){av=ta;bv=tb;}var d=(dir||'desc')==='asc'?1:-1;return av<bv?-d:d;});
						if(n>0)rs=rs.slice(0,n);
						return{rows:function(){return rs;},toTable:function(headers){return _toTable(rs,keys,specs,headers);}};
					},
					rows:function(){
						var groups=new Map();
						for(var r=0;r<rows.length;r++){
							var key=kis.map(function(ki){return String(_cellVal(rows[r][ki])||'');}).join('\\x00');
							var g=groups.get(key);
							if(!g){
								g={_key:key,_count:0};
								for(var k=0;k<keys.length;k++)g[keys[k]]=_cellVal(rows[r][kis[k]]);
								for(var s=0;s<specs.length;s++){
									var sp=specs[s];
									if(sp.type==='dcount')g['_set_'+s]=new Set();
									else if(sp.type==='count')g[sp.name]=0;
									else if(sp.type==='sum'||sp.type==='avg')g[sp.name]=0;
									else if(sp.type==='min'||sp.type==='max')g[sp.name]=undefined;
								}
								groups.set(key,g);
							}
							g._count++;
							for(var s=0;s<specs.length;s++){
								var sp=specs[s];
								var v=sp.src>=0?_cellVal(rows[r][sp.src]):undefined;
								if(sp.type==='count')g[sp.name]=g._count;
								else if(sp.type==='dcount'){if(v!=null)g['_set_'+s].add(v);}
								else if(sp.type==='sum')g[sp.name]+=_num(v);
								else if(sp.type==='avg')g[sp.name]+=_num(v);
								else if(sp.type==='min'&&(g[sp.name]===undefined||v<g[sp.name]))g[sp.name]=v;
								else if(sp.type==='max'&&(g[sp.name]===undefined||v>g[sp.name]))g[sp.name]=v;
							}
						}
						var result=[];
						groups.forEach(function(g){
							for(var s=0;s<specs.length;s++){
								var sp=specs[s];
								if(sp.type==='dcount')g[sp.name]=g['_set_'+s].size;
								else if(sp.type==='avg'&&g._count)g[sp.name]=g[sp.name]/g._count;
							}
							result.push(g);
						});
						return result;
					},
					toTable:function(headers){return _toTable(builder().rows(),keys,specs,headers);}
				};}
				return builder();
			}
		};
		return api;
	}
	function _toTable(rows,keys,specs,headers){
		var allCols=keys.concat(specs.map(function(s){return s.name;}));
		var hdrs=headers||allCols;
		var b='';
		for(var r=0;r<rows.length;r++){
			b+='<tr>';
			for(var c=0;c<allCols.length;c++){
				var v=rows[r][allCols[c]];
				b+='<td>'+(v!=null?_esc(_fmtVal(v)):'')+'</td>';
			}
			b+='</tr>';
		}
		return b;
	}
	function _bind(id,val){var el=document.querySelector('[data-kw-bind=\"'+id+'\"]');if(el)el.textContent=_fmtVal(val);}
	function _bindHtml(id,html){var el=document.querySelector('[data-kw-bind=\"'+id+'\"]');if(el)el.innerHTML=html;}
	window.KustoWorkbench={
		getData:function(){return _d;},
		onDataReady:function(cb){_cbs.push(cb);try{cb(_d);}catch(e){console.error(e);}},
		_notify:function(d){_d=d;for(var i=0;i<_cbs.length;i++){try{_cbs[i](d);}catch(e){console.error(e);}}},
		agg:_agg,
		bind:_bind,
		bindHtml:_bindHtml,
		formatDate:_fmtDate,
		formatValue:_fmtVal,
		_cellVal:_cellVal
	};
	window._kwFull=_full;
})();
<\/script>\n${slicerBlock}`;
	}

	/**
	 * Build the slicer emulation HTML+JS block for the preview iframe.
	 * Dimensions from model.dimensions filter the single fact table.
	 */
	private _buildSlicerBlock(
		dimensions: KwModelDimension[],
		columns: Array<{ name: string; type: string }>,
		rows: unknown[][],
	): string {
		const MAX_DISTINCT = 500;

		interface SlicerMeta { label: string; colIndex: number; mode: string; distinct: string[] }
		const metas: SlicerMeta[] = [];

		for (const dim of dimensions) {
			const colIndex = columns.findIndex(c => c.name === dim.column);
			if (colIndex < 0) continue;
			const colType = columns[colIndex].type;
			const mode = dim.mode || (colType === 'datetime' || colType === 'date' ? 'between' : 'dropdown');
			const seen = new Set<string>();
			const distinct: string[] = [];
			for (const row of rows) {
				const raw = getRawCellValue(row[colIndex]);
				const val = String(raw ?? '');
				if (!seen.has(val)) { seen.add(val); distinct.push(val); }
				if (distinct.length >= MAX_DISTINCT) break;
			}
			distinct.sort();
			metas.push({ label: dim.label || dim.column, colIndex, mode, distinct });
		}

		if (metas.length === 0) return '';

		// Read current VS Code theme colors. Inside the sandboxed iframe CSS custom
		// properties from the parent do not inherit, so we resolve them here and
		// inject concrete color values into the slicer HTML.
		const cssVar = (name: string, fallback: string): string => {
			try { return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback; }
			catch { return fallback; }
		};
		const slicerBg = cssVar('--vscode-editor-background', '#1e1e1e');
		const slicerFg = cssVar('--vscode-editor-foreground', '#cccccc');
		const slicerBorder = cssVar('--vscode-widget-border', '#444444');
		const inputBg = cssVar('--vscode-input-background', '#3c3c3c');
		const inputFg = cssVar('--vscode-input-foreground', '#cccccc');
		const inputBorder = cssVar('--vscode-input-border', '#555555');
		const isDark = this._isDarkTheme();

		// HTML-entity-escape for safe <option> rendering
		const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

		// Build slicer HTML
		let html = `<div id="kw-slicers" style="all:initial;display:flex;gap:16px;padding:12px 16px;margin-bottom:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;background:${slicerBg};color:${slicerFg};border-bottom:1px solid ${slicerBorder};flex-wrap:wrap;align-items:center;color-scheme:${isDark ? 'dark' : 'light'}">`;

		for (let i = 0; i < metas.length; i++) {
			const m = metas[i];
			html += `<label style="display:flex;flex-direction:column;gap:2px;min-width:120px"><span style="font-size:11px;opacity:0.7">${esc(m.label)}</span>`;
			if (m.mode === 'between') {
				html += `<span style="display:flex;gap:4px"><input type="date" data-kw-slicer="${i}" data-kw-range="min" style="background:${inputBg};color:${inputFg};border:1px solid ${inputBorder};padding:2px 6px;border-radius:3px;font-size:12px"><input type="date" data-kw-slicer="${i}" data-kw-range="max" style="background:${inputBg};color:${inputFg};border:1px solid ${inputBorder};padding:2px 6px;border-radius:3px;font-size:12px"></span>`;
			} else {
				html += `<select data-kw-slicer="${i}" style="background:${inputBg};color:${inputFg};border:1px solid ${inputBorder};padding:2px 6px;border-radius:3px;font-size:12px"><option value="">All</option>`;
				for (const v of m.distinct) {
					html += `<option value="${esc(v)}">${esc(v)}</option>`;
				}
				html += `</select>`;
			}
			html += `</label>`;
		}
		html += `</div>`;

		// Slicer metadata as JSON for the filtering script
		const metaJson = JSON.stringify(metas.map(m => ({
			colIndex: m.colIndex, mode: m.mode,
		}))).replace(/<\//g, '<\\/');

		// Filtering JS — all slicers filter the single fact table's rows
		const filterScript = `<script>
(function(){
	var _meta=${metaJson};
	var _cv=window.KustoWorkbench._cellVal;
	function _toDateStr(val){var s=String(val||'');if(/^\\d{4}-\\d{2}-\\d{2}/.test(s))return s.substring(0,10);var d=new Date(s);if(isNaN(d.getTime()))return '';var y=d.getFullYear(),m=d.getMonth()+1,dy=d.getDate();return y+'-'+(m<10?'0':'')+m+'-'+(dy<10?'0':'')+dy;}
	function applyFilters(){
		var full=window._kwFull;
		var rows=full.fact.rows.slice();
		for(var i=0;i<_meta.length;i++){
			var m=_meta[i];
			if(m.mode==='between'){
				var minEl=document.querySelector('[data-kw-slicer="'+i+'"][data-kw-range="min"]');
				var maxEl=document.querySelector('[data-kw-slicer="'+i+'"][data-kw-range="max"]');
				var minV=minEl?minEl.value:'';
				var maxV=maxEl?maxEl.value:'';
				if(minV||maxV){
					rows=rows.filter(function(row){
						var v=_toDateStr(_cv(row[m.colIndex]));
						if(minV&&v<minV)return false;
						if(maxV&&v>maxV)return false;
						return true;
					});
				}
			}else{
				var sel=document.querySelector('[data-kw-slicer="'+i+'"]');
				var val=sel?sel.value:'';
				if(val){
					rows=rows.filter(function(row){return String(_cv(row[m.colIndex])||'')===val;});
				}
			}
		}
		window.KustoWorkbench._notify({fact:{columns:full.fact.columns,rows:rows,totalRows:rows.length,capped:false}});
	}
	var slicerEl=document.getElementById('kw-slicers');
	slicerEl.addEventListener('change',applyFilters);
	slicerEl.addEventListener('input',applyFilters);
})();
<\/script>\n`;

		return html + filterScript;
	}

	private _setupThemeObserver(): void {
		this._themeFingerprint = this._getThemeFingerprint();
		this._themeObserver = new MutationObserver(() => {
			const fp = this._getThemeFingerprint();
			if (this._themeFingerprint !== fp) {
				this._themeFingerprint = fp;
				if (this._mode === 'preview') this._updatePreview();
			}
		});
		if (document.body) {
			this._themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
		}
		if (document.documentElement) {
			this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
		}
	}

	private _getThemeFingerprint(): string {
		try { return getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim(); }
		catch { return ''; }
	}

	private _isDarkTheme(): boolean {
		const cls = document.body?.classList;
		if (cls?.contains('vscode-dark') || cls?.contains('vscode-high-contrast')) return true;
		if (cls?.contains('vscode-light') || cls?.contains('vscode-high-contrast-light')) return false;
		return true;
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

			if ((e.data.type === 'pbiWorkspacesResult' || e.data.type === 'publishToPowerBIResult' || e.data.type === 'pbiItemExistsResult') && e.data.boxId === this.boxId) {
				// Capture publish GUIDs BEFORE forwarding to dialog so they persist even if the dialog throws.
				if (e.data.type === 'publishToPowerBIResult' && e.data.ok && e.data.semanticModelId && e.data.reportId) {
					this._pbiPublishInfo = {
						workspaceId: e.data.workspaceId,
						workspaceName: e.data.workspaceName,
						semanticModelId: e.data.semanticModelId,
						reportId: e.data.reportId,
						reportName: e.data.reportName || '',
						reportUrl: e.data.reportUrl || '',
					};
					schedulePersist(undefined, true); // Immediate flush — losing publish GUIDs is costly
				}
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
		} else if (this._expanded && this._mode === 'preview') {
			this._updatePreview();
			if (this._userResizedPreview && this._savedPreviewHeightPx !== undefined) {
				this.updateComplete.then(() => this._restorePreviewHeight());
			}
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

		if (this._pbiPublishInfo) data.pbiPublishInfo = this._pbiPublishInfo;

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

	public getPbiPublishInfo(): PbiPublishInfo | undefined { return this._pbiPublishInfo; }
	public setPbiPublishInfo(info: PbiPublishInfo | undefined): void { this._pbiPublishInfo = info; }

	/** Called by the cascade system when a referenced data source's results change. */
	public refreshDataBridge(): void {
		if (this._mode === 'preview') this._updatePreview();
	}

	public setExpanded(expanded: boolean): void {
		const wasCollapsed = !this._expanded;
		this._expanded = expanded;
		this.classList.toggle('is-collapsed', !expanded);
		if (wasCollapsed && expanded && this._mode === 'preview') {
			this._updatePreview();
			if (this._userResizedPreview && this._savedPreviewHeightPx !== undefined) {
				this.updateComplete.then(() => this._restorePreviewHeight());
			}
		}
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-html-section': KwHtmlSection;
	}
}
