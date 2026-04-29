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
import { requestOverlayScrollbarUpdate } from '../core/overlay-scrollbars.js';
import { schedulePersist } from '../core/persistence.js';
import { getResultsState, getRawCellValue } from '../core/results-state.js';
import { __kustoForceEditorWritable, __kustoEnsureEditorWritableSoon, __kustoInstallWritableGuard } from '../monaco/writable.js';
import { __kustoAttachAutoResizeToContent } from '../monaco/resize.js';
import { DASHBOARD_CHART_DEFAULTS } from '../../shared/dashboardCharts.js';
import { DASHBOARD_TABLE_CELL_BAR } from '../../shared/dashboardTables.js';

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
	dataMode?: 'import' | 'directQuery';
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

export interface HtmlDashboardExportContext {
	sectionId: string;
	name: string;
	code: string;
	previewHeight?: number;
	hasProvenance: boolean;
	bindingCount: number;
	dataSources: Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }>;
	factColumns: Array<{ name: string; type: string }>;
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
	private static readonly _POWER_BI_HTML_VISUAL_WIDTH = 1450;

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
	/** Last content height reported by the preview iframe, independent of wrapper size. */
	private _lastPreviewContentHeight = 0;
	/** Last raw scroll height reported by the preview iframe for diagnostics and scrollbar checks. */
	private _lastPreviewScrollHeight = 0;
	/** Last viewport height reported by the preview iframe for diagnostics and scrollbar checks. */
	private _lastPreviewViewportHeight = 0;
	/** Pending resolver for an explicit iframe height request before export/publish. */
	private _pendingPreviewHeightResolve: ((height: number | undefined) => void) | null = null;
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

		// Restore user-set editor heights from persisted state.
		if (this.editorHeightPx !== undefined) {
			this._savedEditorHeightPx = this.editorHeightPx;
			this._userResizedEditor = true;
		}

		// Older files may contain auto-fit preview heights persisted as plain
		// previewHeightPx values. Keep the value as a fallback for export, but let
		// the iframe's fresh measurement fit the preview on open.
		if (this.previewHeightPx !== undefined) {
			this._savedPreviewHeightPx = this.previewHeightPx;
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
				@fit-to-contents=${this.fitToContents}>
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
		if (this._lastPreviewContentHeight > 0) return this._lastPreviewContentHeight;
		if (this._lastPreviewFitHeight > 0) return this._lastPreviewFitHeight;
		if (this._savedPreviewHeightPx && this._savedPreviewHeightPx > 0) return this._savedPreviewHeightPx;
		const wrapper = this.shadowRoot?.getElementById('preview-wrapper');
		if (wrapper && wrapper.clientHeight > 0) return wrapper.clientHeight;
		return undefined;
	}

	private _invalidatePreviewContentHeight(): void {
		this._lastPreviewContentHeight = 0;
		this._lastPreviewFitHeight = 0;
		this._lastPreviewScrollHeight = 0;
		this._lastPreviewViewportHeight = 0;
	}

	private _requestFreshPreviewHeight(): Promise<number | undefined> {
		const iframe = this.shadowRoot?.getElementById('preview-iframe') as HTMLIFrameElement | null;
		const contentWindow = iframe?.contentWindow;
		if (!contentWindow) return Promise.resolve(this._measurePreviewHeight());

		return new Promise(resolve => {
			let settled = false;
			const finish = (height: number | undefined) => {
				if (settled) return;
				settled = true;
				if (this._pendingPreviewHeightResolve === finish) this._pendingPreviewHeightResolve = null;
				resolve(height ?? this._measurePreviewHeight());
			};

			this._pendingPreviewHeightResolve = finish;
			try {
				contentWindow.postMessage({ type: 'kw-html-request-height' }, '*');
			} catch (e) {
				console.error('[kusto]', e);
				finish(undefined);
				return;
			}

			window.setTimeout(() => finish(undefined), 350);
		});
	}

	private _measureCurrentHtmlHeight(code: string): Promise<number | undefined> {
		const root = this.shadowRoot;
		if (!root || !code.trim()) return this._requestFreshPreviewHeight();

		const iframe = document.createElement('iframe');
		iframe.setAttribute('sandbox', 'allow-scripts');
		iframe.setAttribute('referrerpolicy', 'no-referrer');
		iframe.style.position = 'absolute';
		iframe.style.left = '-10000px';
		iframe.style.top = '0';
		iframe.style.width = `${this._getPowerBiMeasurementWidth()}px`;
		iframe.style.height = '1px';
		iframe.style.border = '0';
		iframe.style.visibility = 'hidden';
		iframe.style.pointerEvents = 'none';

		return new Promise(resolve => {
			let settled = false;
			let bestHeight = 0;
			let idleTimer = 0;
			let maxTimer = 0;
			const startedAt = Date.now();

			const cleanup = () => {
				window.removeEventListener('message', onMessage);
				if (idleTimer) window.clearTimeout(idleTimer);
				if (maxTimer) window.clearTimeout(maxTimer);
				iframe.remove();
			};

			const finish = (height: number | undefined) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(height ?? this._measurePreviewHeight());
			};

			const queueStableFinish = () => {
				if (idleTimer) window.clearTimeout(idleTimer);
				const elapsed = Date.now() - startedAt;
				const waitMs = elapsed < 350 ? 350 - elapsed : 180;
				idleTimer = window.setTimeout(() => finish(bestHeight || undefined), waitMs);
			};

			const onMessage = (event: MessageEvent) => {
				if (event.source !== iframe.contentWindow || event.data?.type !== 'kw-html-preview-height') return;
				const height = Number(event.data.h);
				if (!Number.isFinite(height) || height <= 0) return;
				bestHeight = Math.max(bestHeight, Math.ceil(height));
				queueStableFinish();
			};

			window.addEventListener('message', onMessage);
			maxTimer = window.setTimeout(() => finish(bestHeight || undefined), 1500);
			root.appendChild(iframe);
			iframe.srcdoc = this._buildDataBridgeScript() + code + KwHtmlSection._heightReportScript;
		});
	}

	private _getPowerBiMeasurementWidth(): number {
		return KwHtmlSection._POWER_BI_HTML_VISUAL_WIDTH;
	}

	private async _exportDashboard(): Promise<void> {
		const code = this._getCodeText();
		if (!code.trim()) {
			try { postMessageToHost({ type: 'showInfo', message: 'There is no HTML content to export.' }); } catch (e) { console.error('[kusto]', e); }
			return;
		}
		const previewHeight = await this._measureCurrentHtmlHeight(code);
		try {
			postMessageToHost({
				type: 'exportDashboard',
				boxId: this.boxId,
				html: code,
				suggestedFileName: this._name || '',
				previewHeight,
				dataSources: this._collectDataSourcesForPBI(),
			});
		} catch (e) { console.error('[kusto]', e); }
	}

	private async _publishToPowerBI(): Promise<void> {
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

		const previewHeight = await this._measureCurrentHtmlHeight(code);
		this._openPublishDialog(code, dataSources, previewHeight, this._name || 'KustoHtmlDashboard');
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
				@dblclick=${this.fitToContents}></div>
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
				@dblclick=${this.fitToContents}></div>
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

			const pendingCode = this._consumePendingHtmlCode();
			if (pendingCode !== undefined) this._savedCode = pendingCode;

			const editor = monaco.editor.create(slotted, {
				value: pendingCode ?? this._savedCode ?? this.initialCode ?? '',
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
					this._invalidatePreviewContentHeight();
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

	private _consumePendingHtmlCode(): string | undefined {
		try {
			const pending = pState.pendingHtmlCodeByBoxId;
			if (pending && typeof pending[this.boxId] === 'string') {
				const code = pending[this.boxId];
				delete pending[this.boxId];
				return code;
			}
		} catch (e) { console.error('[kusto]', e); }
		return undefined;
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
				this._invalidatePreviewContentHeight();
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
		const provenanceJson = JSON.stringify(this._provenance ?? null).replace(/<\//g, '<\\/');
		const chartDefaultsJson = JSON.stringify(DASHBOARD_CHART_DEFAULTS).replace(/<\//g, '<\\/');
		const tableDefaultsJson = JSON.stringify(DASHBOARD_TABLE_CELL_BAR).replace(/<\//g, '<\\/');

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
	var _p=${provenanceJson};
	var _chartDefaults=${chartDefaultsJson};
	var _tableDefaults=${tableDefaultsJson};
	var _cbs=[];
	var _chartRegistry={};
	var _tableRegistry={};
	var _repeatedTableRegistry={};
	var _repeatGroupStyle='margin:0 0 16px 0;border:1px solid rgba(127,127,127,0.35);border-radius:6px;overflow:hidden;';
	var _repeatHeaderStyle='display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px 32px;padding:10px 12px;background:rgba(127,127,127,0.10);border-bottom:1px solid rgba(127,127,127,0.35);font:inherit;';
	var _repeatPrimaryFieldStyle='display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0;line-height:1.25;flex:1 1 220px;';
	var _repeatMetricFieldStyle='display:flex;flex-direction:column;align-items:flex-end;gap:4px;min-width:96px;line-height:1.25;white-space:nowrap;flex:0 0 auto;';
	var _repeatLabelStyle='font-size:inherit;font-weight:700;line-height:1.25;';
	var _repeatValueStyle='font-size:inherit;font-weight:400;line-height:1.35;';
	var _repeatTableStyle='width:100%;border-collapse:collapse;';
	var _metricCellStyle='width:1%;white-space:nowrap;text-align:right;';
	function _cellVal(c){if(c&&typeof c==='object'){if('full' in c&&c.full!=null)return _cellVal(c.full);if('display' in c&&c.display!=null)return _cellVal(c.display);}return c;}
	function _esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
	function _fmtDate(s){if(s==null)return '';if(s instanceof Date)s=s.toISOString();if(typeof s!=='string')s=String(s);var vm=/^[A-Z][a-z]{2} [A-Z][a-z]{2} \\d/.test(s);if(vm){var p=Date.parse(s);if(isFinite(p))s=new Date(p).toISOString();}if(/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}/.test(s)){var d=s.replace('T',' ').replace(/\\.\\d+Z?$/,'').replace(/Z$/,'');return d.endsWith(' 00:00:00')?d.substring(0,10):d;}if(/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$/.test(s))return s.endsWith(' 00:00:00')?s.substring(0,10):s;if(/^\\d{4}-\\d{2}-\\d{2}$/.test(s))return s;return s;}
	function _fmtVal(v){if(v==null)return '';if(typeof v==='number'){if(v>1e12&&v<2e13){var ds=new Date(v).toISOString();return _fmtDate(ds);}return v.toLocaleString();}var s=String(v);return _fmtDate(s);}
	function _colIdx(cols,name){for(var i=0;i<cols.length;i++){if(cols[i].name===name)return i;}return -1;}
	function _isNumVal(v){if(typeof v==='number')return isFinite(v);if(typeof v==='string'){var s=v.trim();return s!==''&&isFinite(Number(s));}return false;}
	function _num(v){return _isNumVal(v)?Number(v):0;}
	function _aggComparable(v,type){if(v==null)return undefined;var t=String(type||'').toLowerCase();if(_isNumericType(t))return _isNumVal(v)?Number(v):undefined;if((t==='datetime'||t==='date')&&String(v).trim().toLowerCase()==='null')return undefined;return v;}
	function _cmpVal(av,bv,type){if(av===bv)return 0;if(av==null)return -1;if(bv==null)return 1;var t=String(type||'').toLowerCase();if(t==='datetime'||t==='date'){var ta=Date.parse(av),tb=Date.parse(bv);if(isFinite(ta)&&isFinite(tb)){av=ta;bv=tb;}}else if(_isNumericType(t)||typeof av==='number'||typeof bv==='number'){av=Number(av);bv=Number(bv);}else{av=String(av);bv=String(bv);}return av<bv?-1:1;}
	function _cmpKeys(a,b,keys,types){for(var i=0;i<keys.length;i++){var c=_cmpVal(a[keys[i]],b[keys[i]],types&&types[i]);if(c!==0)return c;}return 0;}
	function _cmpRows(a,b,sortCol,dir,keys,keyTypes,sortType){var c=_cmpVal(a[sortCol],b[sortCol],sortType);if(c!==0)return (dir||'asc')==='asc'?c:-c;return _cmpKeys(a,b,keys,keyTypes);}
	function _agg(optFact){
		var f=optFact||_d.fact;
		var cols=f.columns,rows=f.rows;
		function ci(name){return _colIdx(cols,name);}
		function ct(name){return _columnType(f,name);}
		var api={
			count:function(){return rows.length;},
			dcount:function(col){var i=ci(col);if(i<0)return 0;var s=new Set();for(var r=0;r<rows.length;r++){var v=_cellVal(rows[r][i]);if(v!=null)s.add(v);}return s.size;},
			sum:function(col){var i=ci(col);if(i<0)return 0;var t=0;for(var r=0;r<rows.length;r++)t+=_num(_cellVal(rows[r][i]));return t;},
			avg:function(col){var i=ci(col);if(i<0)return 0;var t=0,n=0;for(var r=0;r<rows.length;r++){var v=_cellVal(rows[r][i]);if(_isNumVal(v)){t+=_num(v);n++;}}return n?t/n:0;},
			min:function(col){var i=ci(col);if(i<0)return undefined;var m,t=ct(col);for(var r=0;r<rows.length;r++){var v=_aggComparable(_cellVal(rows[r][i]),t);if(v===undefined)continue;if(m===undefined||v<m)m=v;}return m;},
			max:function(col){var i=ci(col);if(i<0)return undefined;var m,t=ct(col);for(var r=0;r<rows.length;r++){var v=_aggComparable(_cellVal(rows[r][i]),t);if(v===undefined)continue;if(m===undefined||v>m)m=v;}return m;},
			groupBy:function(keys){
				var kis=keys.map(ci);
				var keyTypes=keys.map(ct);
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
						rs.sort(function(a,b){return _cmpRows(a,b,sortCol,dir||'asc',keys,keyTypes,ct(sortCol));});
						return{rows:function(){return rs;},toTable:function(headers){return _toTable(rs,keys,specs,headers);},topN:function(n){if(n>0)rs=rs.slice(0,n);return{rows:function(){return rs;},toTable:function(headers){return _toTable(rs,keys,specs,headers);}};}};
					},
					topN:function(n,sortCol,dir){
						var rs=builder().rows();
						rs.sort(function(a,b){return _cmpRows(a,b,sortCol,dir||'desc',keys,keyTypes,ct(sortCol));});
						if(n>0)rs=rs.slice(0,n);
						return{rows:function(){return rs;},toTable:function(headers){return _toTable(rs,keys,specs,headers);}};
					},
					rows:function(){
						var groups=new Map();
						for(var r=0;r<rows.length;r++){
							var key=kis.map(function(ki){var kv=_cellVal(rows[r][ki]);return String(kv==null?'':kv);}).join('\\x00');
							var g=groups.get(key);
							if(!g){
								g={_key:key,_count:0};
								for(var k=0;k<keys.length;k++)g[keys[k]]=_cellVal(rows[r][kis[k]]);
								for(var s=0;s<specs.length;s++){
									var sp=specs[s];
									if(sp.type==='dcount')g['_set_'+s]=new Set();
									else if(sp.type==='count')g[sp.name]=0;
									else if(sp.type==='sum'||sp.type==='avg'){g[sp.name]=0;if(sp.type==='avg')g['_avgcount_'+s]=0;}
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
								else if(sp.type==='avg'){if(_isNumVal(v)){g[sp.name]+=_num(v);g['_avgcount_'+s]++;}}
								else if(sp.type==='min'||sp.type==='max'){
									var mv=_aggComparable(v,sp.src>=0&&cols[sp.src]?cols[sp.src].type:'');
									if(mv!==undefined&&(g[sp.name]===undefined||(sp.type==='min'?mv<g[sp.name]:mv>g[sp.name])))g[sp.name]=mv;
								}
							}
						}
						var result=[];
						groups.forEach(function(g){
							for(var s=0;s<specs.length;s++){
								var sp=specs[s];
								if(sp.type==='dcount')g[sp.name]=g['_set_'+s].size;
								else if(sp.type==='avg')g[sp.name]=g['_avgcount_'+s]?g[sp.name]/g['_avgcount_'+s]:0;
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
	function _bindEl(id){var key=String(id||'');var all=document.querySelectorAll('[data-kw-bind]');for(var i=0;i<all.length;i++){if(all[i].getAttribute('data-kw-bind')===key)return all[i];}return null;}
	function _formatChartNumber(v,fmt){var n=Number(v);if(!isFinite(n))return _fmtVal(v);var f=String(fmt||'#,##0');var pct=f.indexOf('%')>=0;if(pct){n=n*100;f=f.replace(/%/g,'');}var first=f.search(/[0#]/),last=Math.max(f.lastIndexOf('0'),f.lastIndexOf('#')),prefix='',suffix='',pattern=f;if(first>=0&&last>=first){prefix=f.substring(0,first).replace(/"/g,'');suffix=f.substring(last+1).replace(/"/g,'');pattern=f.substring(first,last+1);}var dec='',dot=pattern.indexOf('.');if(dot>=0){dec=pattern.substring(dot+1);var stop=dec.search(/[^0#]/);if(stop>=0)dec=dec.substring(0,stop);}var min=0;for(var i=0;i<dec.length;i++){if(dec.charAt(i)==='0')min++;}var out=n.toLocaleString('en-US',{useGrouping:pattern.indexOf(',')>=0,minimumFractionDigits:min,maximumFractionDigits:dec.length});return prefix+out+suffix+(pct?'%':'');}
	function _isNumericType(t){t=String(t||'').toLowerCase();return t==='long'||t==='int'||t==='real'||t==='double'||t==='decimal';}
	function _columnType(f,name){var cols=f&&f.columns?f.columns:[];for(var i=0;i<cols.length;i++){if(cols[i].name===name)return String(cols[i].type||'').toLowerCase();}return '';}
	function _axisLabel(v,name,f){var t=_columnType(f,name);if(t==='datetime'||t==='date')return _fmtDate(v).substring(0,10);if(_isNumericType(t))return _formatChartNumber(v,'#,##0.##');return _fmtVal(v);}
	function _addAgg(builder,name,agg,col){var a=String(agg||'COUNT').toUpperCase();if(a==='COUNT')return builder.addCount(name);if(a==='DISTINCTCOUNT'||a==='DCOUNT')return builder.addDcount(name,col||'');if(a==='SUM')return builder.addSum(name,col||'');if(a==='AVG'||a==='AVERAGE')return builder.addAvg(name,col||'');if(a==='MIN')return builder.addMin(name,col||'');if(a==='MAX')return builder.addMax(name,col||'');return builder.addCount(name);}
	function _preFact(pre){var keys=Array.isArray(pre&&pre.groupBy)?pre.groupBy:[pre&&pre.groupBy].filter(Boolean);if(!pre||!pre.compute||!pre.compute.name||keys.length===0)return _d.fact;var b=_agg().groupBy(keys);b=_addAgg(b,pre.compute.name,pre.compute.agg,pre.compute.column);var rs=b.rows();var cols=[];for(var i=0;i<keys.length;i++){cols.push({name:keys[i],type:_columnType(_d.fact,keys[i])||'string'});}cols.push({name:pre.compute.name,type:'real'});var outRows=rs.map(function(r){var row=[];for(var i=0;i<keys.length;i++)row.push(r[keys[i]]);row.push(r[pre.compute.name]);return row;});return{columns:cols,rows:outRows,totalRows:outRows.length,capped:_d.fact.capped};}
	function _chartFact(display){return display&&display.preAggregate?_preFact(display.preAggregate):_d.fact;}
	function _chartColor(colors,idx){var p=colors&&colors.length?colors:_chartDefaults.colors;return p[idx%p.length];}
	function _chartSwitchColor(colors,idx){if(idx>=_chartDefaults.colorCaseCount)return _chartColor(colors,0);return _chartColor(colors,idx);}
	function _aggNeedsColumn(agg){return String(agg||'').toUpperCase()!=='COUNT';}
	function _safeColor(c){return typeof c==='string'&&c.trim()&&!/["'<>&]/.test(c);}
	function _safeCssColor(c){if(typeof c!=='string')return false;var s=c.trim();return !!s&&!/[;:{}"'<>&\\\\]/.test(s)&&s.indexOf('/*')<0&&(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)||/^[a-zA-Z]+$/.test(s)||/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(s)||/^hsla?\(\s*-?\d+(?:\.\d+)?(?:deg)?\s*,\s*(?:100|\d{1,2}(?:\.\d+)?)%\s*,\s*(?:100|\d{1,2}(?:\.\d+)?)%\s*(?:,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(s));}
	function _validFiniteNumber(v){return typeof v==='number'&&isFinite(v);}
	function _validChartValue(v){return v&&typeof v==='object'&&typeof v.agg==='string'&&v.agg.trim()&&(!_aggNeedsColumn(v.agg)||(typeof v.column==='string'&&v.column.trim()))&&(v.column===undefined||typeof v.column==='string')&&(v.format===undefined||typeof v.format==='string');}
	function _validBarSegment(s){return _validChartValue(s)&&(s.label===undefined||typeof s.label==='string')&&(s.color===undefined||_safeColor(s.color));}
	function _validThresholdBand(b){return b&&typeof b==='object'&&_validFiniteNumber(b.min)&&_validFiniteNumber(b.max)&&b.min>=0&&b.max>b.min&&(b.label===undefined||typeof b.label==='string')&&(b.color===undefined||_safeColor(b.color));}
	function _validThresholdBands(t){if(!t||typeof t!=='object'||!Array.isArray(t.bands)||t.bands.length===0)return false;if(t.scaleMax!==undefined&&(!_validFiniteNumber(t.scaleMax)||t.scaleMax<=0))return false;var expected=0;for(var i=0;i<t.bands.length;i++){if(!_validThresholdBand(t.bands[i])||t.bands[i].min!==expected)return false;expected=t.bands[i].max;}return t.scaleMax===undefined||t.scaleMax>=expected;}
	function _validColorRule(r){var ops={'>':1,'>=':1,'<':1,'<=':1,'=':1,'==':1,'!=':1,'<>':1};return r&&typeof r==='object'&&ops[String(r.operator)]&&_validFiniteNumber(r.value)&&_safeColor(r.color)&&(r.label===undefined||typeof r.label==='string');}
	function _validChartSeries(s){return s&&typeof s==='object'&&typeof s.agg==='string'&&s.agg.trim()&&(!_aggNeedsColumn(s.agg)||(typeof s.column==='string'&&s.column.trim()))&&(s.column===undefined||typeof s.column==='string')&&(s.label===undefined||typeof s.label==='string');}
	function _validPreAggregate(p){if(!p||typeof p!=='object'||!p.compute||typeof p.compute!=='object')return false;var g=typeof p.groupBy==='string'?p.groupBy.trim():Array.isArray(p.groupBy)&&p.groupBy.length>0&&p.groupBy.every(function(x){return typeof x==='string'&&x.trim();});return !!g&&typeof p.compute.name==='string'&&p.compute.name.trim()&&typeof p.compute.agg==='string'&&p.compute.agg.trim()&&(!_aggNeedsColumn(p.compute.agg)||(typeof p.compute.column==='string'&&p.compute.column.trim()))&&(p.compute.column===undefined||typeof p.compute.column==='string');}
	function _validChartOptions(d){if(d.top!==undefined&&(typeof d.top!=='number'||!isFinite(d.top)||Math.floor(d.top)!==d.top||d.top<=0))return false;if(d.colors!==undefined&&(!Array.isArray(d.colors)||!d.colors.every(_safeColor)))return false;if(d.preAggregate!==undefined&&!_validPreAggregate(d.preAggregate))return false;return true;}
	function _validBarDisplay(d){if(typeof d.groupBy!=='string'||!d.groupBy.trim())return false;if(d.scale!==undefined&&d.scale!=='relative'&&d.scale!=='normalized100')return false;if(d.variant!==undefined&&d.variant!=='standard'&&d.variant!=='distribution')return false;if(d.showValueLabels!==undefined&&typeof d.showValueLabels!=='boolean')return false;if(d.showCategoryLabels!==undefined&&typeof d.showCategoryLabels!=='boolean')return false;var hasValue=d.value!==undefined,hasSegments=d.segments!==undefined,hasThreshold=d.thresholdBands!==undefined,hasRules=d.colorRules!==undefined,modeCount=(hasSegments?1:0)+(hasThreshold?1:0)+(hasRules?1:0);if(modeCount>1)return false;if(d.scale==='normalized100'&&!hasSegments)return false;if(hasSegments)return !hasValue&&Array.isArray(d.segments)&&d.segments.length>0&&d.segments.every(_validBarSegment);if(hasThreshold)return hasValue&&_validChartValue(d.value)&&_validThresholdBands(d.thresholdBands);if(hasRules)return hasValue&&_validChartValue(d.value)&&Array.isArray(d.colorRules)&&d.colorRules.length>0&&d.colorRules.every(_validColorRule);return hasValue&&_validChartValue(d.value);}
	function _validChartDisplay(d){if(!d||typeof d!=='object'||!_validChartOptions(d))return false;if(d.type==='bar')return _validBarDisplay(d);if(d.type==='pie')return typeof d.groupBy==='string'&&d.groupBy.trim()&&_validChartValue(d.value);if(d.type==='line')return typeof d.xAxis==='string'&&d.xAxis.trim()&&Array.isArray(d.series)&&d.series.length>0&&d.series.every(_validChartSeries);return false;}
	function _reservedTableAlias(n){var s=String(n||'').toLowerCase();return s.indexOf('__kw_cellbar_')===0||s.indexOf('__kw_table_idx_')===0||s.indexOf('__kw_repeat_idx_')===0;}
	function _validCellBar(b){return b&&typeof b==='object'&&Array.isArray(b.segments)&&b.segments.length>0&&b.segments.every(_validBarSegment)&&(b.scale===undefined||b.scale==='normalized100'||b.scale==='relative')&&(b.width===undefined||(_validFiniteNumber(b.width)&&b.width>0))&&(b.height===undefined||(_validFiniteNumber(b.height)&&b.height>0))&&(b.radius===undefined||(_validFiniteNumber(b.radius)&&b.radius>=0))&&(b.colors===undefined||(Array.isArray(b.colors)&&b.colors.every(_safeColor)));}
	function _isCellBarColumn(c){return !!(c&&typeof c==='object'&&c.cellBar!==undefined);}
	function _isCellFormattedColumn(c){return !!(c&&typeof c==='object'&&c.cellFormat!==undefined);}
	function _validCellStyle(s){return s&&typeof s==='object'&&(s.color!==undefined||s.backgroundColor!==undefined||s.fontWeight!==undefined)&&(s.color===undefined||_safeCssColor(s.color))&&(s.backgroundColor===undefined||_safeCssColor(s.backgroundColor))&&(s.fontWeight===undefined||s.fontWeight==='normal'||s.fontWeight==='600'||s.fontWeight==='bold');}
	function _validCellFormatRule(r){var ops={'>':1,'>=':1,'<':1,'<=':1,'=':1,'==':1,'!=':1,'<>':1};return _validCellStyle(r)&&ops[String(r.operator)]&&_validFiniteNumber(r.value);}
	function _validCellFormat(f){return f&&typeof f==='object'&&Array.isArray(f.rules)&&f.rules.length>0&&f.rules.every(_validCellFormatRule)&&(f.mode===undefined||f.mode==='badge'||f.mode==='cell')&&(f.valueColumn===undefined||(typeof f.valueColumn==='string'&&f.valueColumn.trim()))&&(f.defaultStyle===undefined||_validCellStyle(f.defaultStyle));}
	function _validTableDisplay(d){
		if(!d||typeof d!=='object'||d.type!=='table')return false;
		if(!Array.isArray(d.groupBy)||d.groupBy.length===0||!d.groupBy.every(function(x){return typeof x==='string'&&x.trim();}))return false;
		if(!Array.isArray(d.columns)||d.columns.length===0)return false;
		var grouped={},available={};
		for(var g=0;g<d.groupBy.length;g++){if(_reservedTableAlias(d.groupBy[g]))return false;grouped[d.groupBy[g]]=1;available[d.groupBy[g]]=1;}
		for(var a=0;a<d.columns.length;a++){var ac=d.columns[a];if(ac&&typeof ac==='object'&&typeof ac.name==='string'&&ac.name.trim()&&!_isCellBarColumn(ac))available[ac.name]=1;}
		for(var i=0;i<d.columns.length;i++){
			var c=d.columns[i];
			if(!c||typeof c!=='object'||typeof c.name!=='string'||!c.name.trim())return false;
			if(_reservedTableAlias(c.name))return false;
			if(c.header!==undefined&&typeof c.header!=='string')return false;
			if(c.agg!==undefined&&(typeof c.agg!=='string'||!c.agg.trim()))return false;
			if(c.sourceColumn!==undefined&&typeof c.sourceColumn!=='string')return false;
			if(c.format!==undefined&&typeof c.format!=='string')return false;
			if(_isCellBarColumn(c)){if(c.cellFormat!==undefined||c.agg!==undefined||c.sourceColumn!==undefined||c.format!==undefined)return false;if(!_validCellBar(c.cellBar))return false;continue;}
			if(c.cellFormat!==undefined){if(!_validCellFormat(c.cellFormat))return false;if(!available[c.cellFormat.valueColumn||c.name])return false;}
			if(c.agg===undefined&&!grouped[c.name])return false;
			if(_aggNeedsColumn(c.agg)){var src=c.sourceColumn||c.name;if(typeof src!=='string'||!src.trim())return false;}
		}
		if(d.orderBy!==undefined){if(!d.orderBy||typeof d.orderBy!=='object'||typeof d.orderBy.column!=='string'||!d.orderBy.column.trim())return false;if(d.orderBy.direction!==undefined&&d.orderBy.direction!=='asc'&&d.orderBy.direction!=='desc')return false;var ok=false;for(var og=0;og<d.groupBy.length;og++){if(d.groupBy[og]===d.orderBy.column)ok=true;}for(var oi=0;oi<d.columns.length;oi++){if(!_isCellBarColumn(d.columns[oi])&&d.columns[oi].name===d.orderBy.column)ok=true;}if(!ok)return false;}
		if(d.top!==undefined&&(typeof d.top!=='number'||!isFinite(d.top)||Math.floor(d.top)!==d.top||d.top<=0||d.orderBy===undefined))return false;
		if(d.preAggregate!==undefined&&!_validPreAggregate(d.preAggregate))return false;
		return true;
	}
	function _repeatColumns(d){return Array.isArray(d.repeatColumns)?d.repeatColumns:d.repeatBy.map(function(n){return{name:n};});}
	function _validRepeatColumns(cols,repeatBy){if(cols!==undefined&&(!Array.isArray(cols)||cols.length===0))return false;if(cols===undefined)return true;var grouped={};for(var g=0;g<repeatBy.length;g++)grouped[repeatBy[g]]=1;for(var i=0;i<cols.length;i++){var c=cols[i];if(!c||typeof c!=='object'||typeof c.name!=='string'||!c.name.trim())return false;if(_reservedTableAlias(c.name)||_isCellBarColumn(c)||c.cellFormat!==undefined)return false;if(c.header!==undefined&&typeof c.header!=='string')return false;if(c.agg!==undefined&&(typeof c.agg!=='string'||!c.agg.trim()))return false;if(c.sourceColumn!==undefined&&typeof c.sourceColumn!=='string')return false;if(c.format!==undefined&&typeof c.format!=='string')return false;if(c.agg===undefined&&!grouped[c.name])return false;if(_aggNeedsColumn(c.agg)){var src=c.sourceColumn||c.name;if(typeof src!=='string'||!src.trim())return false;}}return true;}
	function _validRepeatedTableDisplay(d){if(!d||typeof d!=='object'||d.type!=='repeatedTable')return false;if(!Array.isArray(d.repeatBy)||d.repeatBy.length===0||!d.repeatBy.every(function(x){return typeof x==='string'&&x.trim()&&!_reservedTableAlias(x);}))return false;if(!_validRepeatColumns(d.repeatColumns,d.repeatBy))return false;var rcols=_repeatColumns(d);if(d.repeatOrderBy!==undefined){if(!d.repeatOrderBy||typeof d.repeatOrderBy!=='object'||typeof d.repeatOrderBy.column!=='string'||!d.repeatOrderBy.column.trim())return false;if(d.repeatOrderBy.direction!==undefined&&d.repeatOrderBy.direction!=='asc'&&d.repeatOrderBy.direction!=='desc')return false;var rok=false;for(var r=0;r<d.repeatBy.length;r++){if(d.repeatBy[r]===d.repeatOrderBy.column)rok=true;}for(var c=0;c<rcols.length;c++){if(rcols[c].name===d.repeatOrderBy.column)rok=true;}if(!rok)return false;}if(d.repeatTop!==undefined&&(typeof d.repeatTop!=='number'||!isFinite(d.repeatTop)||Math.floor(d.repeatTop)!==d.repeatTop||d.repeatTop<=0||d.repeatOrderBy===undefined))return false;if(!d.table||typeof d.table!=='object')return false;return _validTableDisplay({type:'table',groupBy:d.table.groupBy,columns:d.table.columns,orderBy:d.table.orderBy,top:d.table.top,preAggregate:d.preAggregate});}
	function _chartDisplay(id,spec){var b=_p&&_p.bindings?_p.bindings[String(id||'')]:null;if(b&&b.display)return _validChartDisplay(b.display)?b.display:null;if(spec&&typeof spec==='object'){try{console.warn('KustoWorkbench.renderChart ignores chartSpec unless the same chart is declared in kw-provenance.');}catch(e){}}return null;}
	function _tableColumnValueType(display,f,name){for(var g=0;g<display.groupBy.length;g++){if(display.groupBy[g]===name)return _columnType(f,name);}for(var i=0;i<display.columns.length;i++){var c=display.columns[i];if(!_isCellBarColumn(c)&&c.name===name)return c.agg?'real':_columnType(f,c.name);}return '';}
	function _validCellFormatValueTypes(display,f){for(var i=0;i<display.columns.length;i++){var c=display.columns[i];if(_isCellFormattedColumn(c)&&!_isNumericType(_tableColumnValueType(display,f,c.cellFormat.valueColumn||c.name)))return false;}return true;}
	function _tableDisplay(id,spec){var b=_p&&_p.bindings?_p.bindings[String(id||'')]:null;if(b&&b.display)return _validTableDisplay(b.display)&&_validCellFormatValueTypes(b.display,_tableFact(b.display))?b.display:null;if(spec&&typeof spec==='object'){try{console.warn('KustoWorkbench.renderTable ignores tableSpec unless the same table is declared in kw-provenance.');}catch(e){}}return null;}
	function _repeatedTableDisplay(id,spec){var b=_p&&_p.bindings?_p.bindings[String(id||'')]:null;if(b&&b.display){if(!_validRepeatedTableDisplay(b.display))return null;var inner={type:'table',groupBy:b.display.table.groupBy,columns:b.display.table.columns};return _validCellFormatValueTypes(inner,_tableFact(b.display))?b.display:null;}if(spec&&typeof spec==='object'){try{console.warn('KustoWorkbench.renderRepeatedTable ignores repeatedTableSpec unless the same repeated table is declared in kw-provenance.');}catch(e){}}return null;}
	function _tableFact(display){return display&&display.preAggregate?_preFact(display.preAggregate):_d.fact;}
	function _tableSegmentAlias(ci,si){return '__kw_cellbar_'+ci+'_'+si;}
	function _tableValue(row,alias){return Math.max(0,_num(row[alias]));}
	function _tableCellBarTotal(row,aliases){var t=0;for(var i=0;i<aliases.length;i++)t+=_tableValue(row,aliases[i]);return t;}
	function _tableRowsFromFact(f,display){var b=_agg(f).groupBy(display.groupBy);for(var i=0;i<display.columns.length;i++){var col=display.columns[i];if(_isCellBarColumn(col)){for(var s=0;s<col.cellBar.segments.length;s++){var seg=col.cellBar.segments[s];b=_addAgg(b,_tableSegmentAlias(i,s),seg.agg,seg.column);}}else if(col.agg){b=_addAgg(b,col.name,col.agg,col.sourceColumn||col.name);}}
		var rs=b.rows(),order=display.orderBy;if(order){var typ=_columnType(f,order.column);for(var c=0;c<display.columns.length;c++){if(display.columns[c].name===order.column&&display.columns[c].agg)typ='real';}var dir=order.direction==='asc'?1:-1;rs.sort(function(a,b){var primary=dir*_cmpVal(a[order.column],b[order.column],typ);if(primary!==0)return primary;for(var g=0;g<display.groupBy.length;g++){var gc=display.groupBy[g],tie=_cmpVal(a[gc],b[gc],_columnType(f,gc));if(tie!==0)return tie;}return 0;});if(display.top>0)rs=rs.slice(0,display.top);}var maxes={};for(var c=0;c<display.columns.length;c++){var col=display.columns[c];if(_isCellBarColumn(col)&&col.cellBar.scale==='relative'){var aliases=[];for(var s=0;s<col.cellBar.segments.length;s++)aliases.push(_tableSegmentAlias(c,s));var m=0;for(var r=0;r<rs.length;r++){var t=_tableCellBarTotal(rs[r],aliases);if(t>m)m=t;}maxes[c]=m;}}return{fact:f,rows:rs,relativeMaxes:maxes};}
	function _tableRows(display){return _tableRowsFromFact(_tableFact(display),display);}
	function _tableFormat(v,fmt){return fmt?_formatChartNumber(v,fmt):_fmtVal(v);}
	function _cellBarGeom(b){return{width:b.width||_tableDefaults.width,height:b.height||_tableDefaults.height,radius:b.radius===undefined?_tableDefaults.radius:b.radius};}
	function _cellBarColor(b,seg,i){return seg.color||_chartColor(b.colors,i);}
	function _renderCellBarSvg(cellBar,row,columnIndex,relativeMax){var g=_cellBarGeom(cellBar),aliases=[],total=0,body='',x=0;for(var s=0;s<cellBar.segments.length;s++){aliases.push(_tableSegmentAlias(columnIndex,s));}for(var s=0;s<aliases.length;s++)total+=_tableValue(row,aliases[s]);var denom=cellBar.scale==='relative'?relativeMax:total;for(var s=0;s<cellBar.segments.length;s++){var val=_tableValue(row,aliases[s]),w=denom>0?Math.round(val/denom*g.width):0;body+="<rect x='"+Math.round(x)+"' y='0' width='"+w+"' height='"+g.height+"' rx='"+g.radius+"' fill='"+_esc(_cellBarColor(cellBar,cellBar.segments[s],s))+"'/"+'>';x+=denom>0?val/denom*g.width:0;}return "<svg class='kw-cell-bar' width='"+g.width+"' height='"+g.height+"' viewBox='0 0 "+g.width+' '+g.height+"' xmlns='http://www.w3.org/2000/svg' style='width:"+g.width+"px;height:"+g.height+"px;display:block' aria-hidden='true'>"+body+'</svg>';}
	var _cellBadgeBaseStyle='display:inline-block;min-width:34px;padding:1px 10px;border-radius:999px;line-height:1.4;text-align:center;font-weight:600;';
	function _cellStyleCss(s,mode){var out=mode==='badge'?_cellBadgeBaseStyle:'';if(s&&s.backgroundColor)out+='background-color:'+String(s.backgroundColor).trim()+';';if(s&&s.color)out+='color:'+String(s.color).trim()+';';if(s&&s.fontWeight)out+='font-weight:'+String(s.fontWeight)+';';return out;}
	function _cellFormatStyle(fmt,row,col){var mode=(fmt&&fmt.mode)||'badge',v=_num(row[(fmt&&fmt.valueColumn)||col.name]),rules=(fmt&&fmt.rules)||[];for(var i=0;i<rules.length;i++){if(_ruleMatches(v,rules[i]))return _cellStyleCss(rules[i],mode);}return _cellStyleCss(fmt&&fmt.defaultStyle,mode);}
	function _metricColumn(col){return !!(col&&(col.agg||_isCellBarColumn(col)));}
	function _renderTableCellHtml(col,row,columnIndex,mat,compact){var compactStyle=compact&&_metricColumn(col)?_metricCellStyle:'',cellAttr=compactStyle?' style="'+compactStyle+'"':'';if(_isCellBarColumn(col))return '<td'+cellAttr+'>'+_renderCellBarSvg(col.cellBar,row,columnIndex,mat.relativeMaxes[columnIndex]||0)+'</td>';var text=_esc(_tableFormat(row[col.name],col.format));if(_isCellFormattedColumn(col)){var mode=col.cellFormat.mode||'badge',style=_esc(_cellFormatStyle(col.cellFormat,row,col));if(mode==='cell')return '<td style="'+compactStyle+style+'">'+text+'</td>';return '<td'+cellAttr+'><span class="kw-cell-badge" style="'+style+'">'+text+'</span></td>';}return '<td'+cellAttr+'>'+text+'</td>';}
	function _renderTableRowsHtml(display,mat,compact){var rows='';for(var r=0;r<mat.rows.length;r++){var row=mat.rows[r];rows+='<tr>';for(var c=0;c<display.columns.length;c++){rows+=_renderTableCellHtml(display.columns[c],row,c,mat,compact);}rows+='</tr>';}return rows;}
	function _renderTableHeadHtml(display,compact){var head='<thead><tr>';for(var c=0;c<display.columns.length;c++){var col=display.columns[c],cellAttr=compact&&_metricColumn(col)?' style="'+_metricCellStyle+'"':'';head+='<th'+cellAttr+'>'+_esc(col.header||col.name)+'</th>';}return head+'</tr></thead>';}
	function _renderTable(id,spec){var key=String(id||'');if(!key)return;var display=_tableDisplay(key,spec);if(!display||display.type!=='table')return;_tableRegistry[key]=display;var el=_bindEl(key);if(!el){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){_renderRegisteredTables();},{once:true});return;}var mat=_tableRows(display),rows=_renderTableRowsHtml(display,mat,false);if(String(el.tagName||'').toLowerCase()==='tbody'){el.innerHTML=rows;return;}el.innerHTML=_renderTableHeadHtml(display,false)+'<tbody>'+rows+'</tbody>';}
	function _renderRegisteredTables(){for(var key in _tableRegistry){if(Object.prototype.hasOwnProperty.call(_tableRegistry,key))_renderTable(key,_tableRegistry[key]);}}
	function _sameKeyValue(a,b,type){return _cmpVal(a,b,type)===0;}
	function _filterFactForRepeat(f,repeatBy,row){var idxs=repeatBy.map(function(k){return _colIdx(f.columns,k);});var types=repeatBy.map(function(k){return _columnType(f,k);});var out=[];for(var r=0;r<f.rows.length;r++){var sourceRow=f.rows[r],ok=true;for(var i=0;i<repeatBy.length;i++){if(!_sameKeyValue(_cellVal(sourceRow[idxs[i]]),row[repeatBy[i]],types[i])){ok=false;break;}}if(ok)out.push(sourceRow);}return{columns:f.columns,rows:out,totalRows:out.length,capped:f.capped};}
	function _renderRepeatedHeader(display,row){var cols=_repeatColumns(display),html='<div class="kw-repeated-table-header" style="'+_repeatHeaderStyle+'">';for(var i=0;i<cols.length;i++){var col=cols[i],primary=i===0,fieldStyle=primary?_repeatPrimaryFieldStyle:_repeatMetricFieldStyle,fieldClass=primary?'kw-repeat-field kw-repeat-primary':'kw-repeat-field kw-repeat-metric',label=col.header||col.name;html+='<span class="'+fieldClass+'" style="'+fieldStyle+'"><span class="kw-repeat-label" style="'+_repeatLabelStyle+'">'+_esc(label)+'</span><span class="kw-repeat-value" style="'+_repeatValueStyle+'">'+_esc(_tableFormat(row[col.name],col.format))+'</span></span>';}return html+'</div>';}
	function _renderRepeatedTable(id,spec){var key=String(id||'');if(!key)return;var display=_repeatedTableDisplay(key,spec);if(!display||display.type!=='repeatedTable')return;_repeatedTableRegistry[key]=display;var el=_bindEl(key);if(!el){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){_renderRegisteredRepeatedTables();},{once:true});return;}var tag=String(el.tagName||'').toLowerCase();if(tag==='table'||tag==='thead'||tag==='tbody'||tag==='tfoot'||tag==='tr'||tag==='td'||tag==='th')return;var fact=_tableFact(display),repeatDisplay={type:'table',groupBy:display.repeatBy,columns:_repeatColumns(display),orderBy:display.repeatOrderBy||{column:display.repeatBy[0],direction:'asc'},top:display.repeatTop},outer=_tableRowsFromFact(fact,repeatDisplay).rows,html='';for(var r=0;r<outer.length;r++){var outerRow=outer[r],scoped=_filterFactForRepeat(fact,display.repeatBy,outerRow),innerOrder=display.table.orderBy||(display.table.groupBy.length?{column:display.table.groupBy[0],direction:'asc'}:undefined),innerDisplay={type:'table',groupBy:display.table.groupBy,columns:display.table.columns,orderBy:innerOrder,top:display.table.top},mat=_tableRowsFromFact(scoped,innerDisplay);html+='<section class="kw-repeated-table-group" style="'+_repeatGroupStyle+'">'+_renderRepeatedHeader(display,outerRow)+'<table class="kw-repeated-table" style="'+_repeatTableStyle+'">'+_renderTableHeadHtml(innerDisplay,true)+'<tbody>'+_renderTableRowsHtml(innerDisplay,mat,true)+'</tbody></table></section>';}el.innerHTML=html;}
	function _renderRegisteredRepeatedTables(){for(var key in _repeatedTableRegistry){if(Object.prototype.hasOwnProperty.call(_repeatedTableRegistry,key))_renderRepeatedTable(key,_repeatedTableRegistry[key]);}}
	function _barPieRows(display){var f=_chartFact(display);var val=display.value||{agg:'COUNT'};var labelType=_columnType(f,display.groupBy);var b=_agg(f).groupBy([display.groupBy]);b=_addAgg(b,'Val',val.agg,val.column);var rs=b.rows().map(function(r){var label=r[display.groupBy];return{Label:label==null?'':_axisLabel(label,display.groupBy,f),RawLabel:label,Val:_num(r.Val)};});rs.sort(function(a,b){var c=_cmpVal(a.Val,b.Val);if(c!==0)return -c;return _cmpVal(a.RawLabel,b.RawLabel,labelType);});if(display.top>0)rs=rs.slice(0,display.top);return rs;}
	function _sortBarRows(rs,display,labelType){rs.sort(function(a,b){var c=_cmpVal(a.SortVal,b.SortVal);if(c!==0)return -c;return _cmpVal(a.RawLabel,b.RawLabel,labelType);});if(display.top>0)rs=rs.slice(0,display.top);return rs;}
	function _barValueFormat(display){if(display.value&&display.value.format)return display.value.format;if(display.segments&&display.segments.length&&display.segments[0].format)return display.segments[0].format;return '#,##0';}
	function _barSegmentRows(display){var f=_chartFact(display),specs=display.segments||[],labelType=_columnType(f,display.groupBy),b=_agg(f).groupBy([display.groupBy]);for(var i=0;i<specs.length;i++)b=_addAgg(b,'S'+i,specs[i].agg,specs[i].column);var rs=b.rows().map(function(r){var label=r[display.groupBy],total=0,segs=[];for(var i=0;i<specs.length;i++){var sp=specs[i],v=Math.max(0,_num(r['S'+i]));total+=v;segs.push({Label:sp.label||sp.column||('Segment '+(i+1)),Val:v,Color:sp.color||_chartColor(display.colors,i)});}return{Label:label==null?'':_axisLabel(label,display.groupBy,f),RawLabel:label,Val:total,SortVal:total,Segments:segs};});return _sortBarRows(rs,display,labelType);}
	function _thresholdRows(display){var base=_barPieRows(display),bands=display.thresholdBands&&display.thresholdBands.bands?display.thresholdBands.bands:[],domain=(display.thresholdBands&&display.thresholdBands.scaleMax)||((bands[bands.length-1]||{}).max||0);return base.map(function(r){var pv=Math.max(0,r.Val),segs=[];for(var i=0;i<bands.length;i++){var band=bands[i],v=Math.max(0,Math.min(pv,band.max)-band.min);segs.push({Label:band.label||'',Val:v,Color:band.color||_chartColor(display.colors,i)});}return{Label:r.Label,RawLabel:r.RawLabel,Val:r.Val,SortVal:r.Val,Domain:domain,Segments:segs};});}
	function _ruleMatches(v,r){if(r.operator==='>')return v>r.value;if(r.operator==='>=')return v>=r.value;if(r.operator==='<')return v<r.value;if(r.operator==='<=')return v<=r.value;if(r.operator==='!='||r.operator==='<>')return v!==r.value;return v===r.value;}
	function _ruleColor(display,val,idx){var rules=display.colorRules||[];for(var i=0;i<rules.length;i++){if(_ruleMatches(val,rules[i]))return rules[i].color;}return _chartSwitchColor(display.colors,idx);}
	function _barRows(display){if(display.segments)return _barSegmentRows(display);if(display.thresholdBands)return _thresholdRows(display);var base=_barPieRows(display);return base.map(function(r,i){return{Label:r.Label,RawLabel:r.RawLabel,Val:r.Val,SortVal:r.Val,Segments:[{Label:'',Val:Math.max(0,r.Val),Color:display.colorRules?_ruleColor(display,r.Val,i):_chartSwitchColor(display.colors,i)}]};});}
	function _lineRows(display){var f=_chartFact(display);var series=Array.isArray(display.series)?display.series:[];var xType=_columnType(f,display.xAxis);var b=_agg(f).groupBy([display.xAxis]);for(var i=0;i<series.length;i++){b=_addAgg(b,'S'+i,series[i].agg,series[i].column);}var rs=b.rows();rs.sort(function(a,b){return _cmpVal(a[display.xAxis],b[display.xAxis],xType);});return{fact:f,series:series,rows:rs};}
	function _svgRoot(w,h,content){return "<svg class='chart-svg' viewBox='0 0 "+w+' '+h+"' xmlns='http://www.w3.org/2000/svg' style='width:100%;height:"+h+"px;display:block' role='img'>"+content+'</svg>';}
	function _hasAdvancedBarOptions(display){return !!(display.segments||display.thresholdBands||display.colorRules||display.scale||display.variant||display.showValueLabels!==undefined||display.showCategoryLabels!==undefined);}
	function _renderSimpleBarSvg(display){var g=_chartDefaults.bar,rows=_barPieRows(display),max=0,body='';for(var i=0;i<rows.length;i++){var pv=Math.max(0,rows[i].Val);if(pv>max)max=pv;}var h=Math.max(g.minH,g.padT+g.padB+rows.length*(g.rowH+g.gap));for(var i=0;i<rows.length;i++){var r=rows[i],y=g.padT+i*(g.rowH+g.gap),barVal=Math.max(0,r.Val),w=max===0?0:barVal/max*g.barMaxW,col=_chartSwitchColor(display.colors,i);body+="<text x='"+(g.labelW-6)+"' y='"+(y+16)+"' text-anchor='end' font-size='11' fill='#605E5C'>"+_esc(r.Label)+"</text>";body+="<rect x='"+g.labelW+"' y='"+(y+2)+"' width='"+Math.round(w)+"' height='"+(g.rowH-4)+"' rx='2' fill='"+col+"'/>";body+="<text x='"+Math.round(g.labelW+w+g.valGap)+"' y='"+(y+16)+"' font-size='11' fill='#605E5C'>"+_esc(_formatChartNumber(r.Val,(display.value&&display.value.format)||'#,##0'))+"</text>";}return _svgRoot(g.totalW,h,body);}
	function _barGeom(display){var dist=display.variant==='distribution',g=dist?_chartDefaults.barDistribution:_chartDefaults.bar,showCat=display.showCategoryLabels!==false,showVal=display.showValueLabels===undefined?!dist:display.showValueLabels,labelW=showCat?g.labelW:0,valueW=showVal?96:0,barMaxW=dist?Math.max(1,g.totalW-labelW-valueW-(showVal?g.valGap:0)):g.barMaxW,barH=dist?g.barH:g.rowH-4,barOffset=dist?Math.floor((g.rowH-barH)/2):2,textDy=dist?g.labelFontSize+3:16;return{g:g,showCat:showCat,showVal:showVal,labelW:labelW,barMaxW:barMaxW,barH:barH,barOffset:barOffset,textDy:textDy};}
	function _renderBarSvg(display){if(!_hasAdvancedBarOptions(display))return _renderSimpleBarSvg(display);var geom=_barGeom(display),g=geom.g,rows=_barRows(display),max=0,body='',fmt=_barValueFormat(display);for(var i=0;i<rows.length;i++){var pv=Math.max(0,rows[i].Val);if(pv>max)max=pv;}var h=Math.max(g.minH,g.padT+g.padB+rows.length*(g.rowH+g.gap));for(var i=0;i<rows.length;i++){var r=rows[i],y=g.padT+i*(g.rowH+g.gap),x=geom.labelW,denom=display.thresholdBands?r.Domain:(display.scale==='normalized100'?Math.max(0,r.Val):max),fillVal=display.thresholdBands?Math.min(Math.max(0,r.Val),denom):Math.max(0,r.Val);if(geom.showCat)body+="<text x='"+(geom.labelW-6)+"' y='"+(y+geom.textDy)+"' text-anchor='end' font-size='"+g.labelFontSize+"' fill='"+g.labelFill+"'>"+_esc(r.Label)+"</text>";for(var s=0;s<r.Segments.length;s++){var seg=r.Segments[s],segVal=Math.max(0,seg.Val),w=denom===0?0:segVal/denom*geom.barMaxW;body+="<rect x='"+Math.round(x)+"' y='"+(y+geom.barOffset)+"' width='"+Math.round(w)+"' height='"+geom.barH+"' rx='"+g.barRadius+"' fill='"+seg.Color+"'/>";x+=w;}if(geom.showVal)body+="<text x='"+Math.round(geom.labelW+(denom===0?0:fillVal/denom*geom.barMaxW)+g.valGap)+"' y='"+(y+geom.textDy)+"' font-size='"+g.labelFontSize+"' fill='"+g.labelFill+"'>"+_esc(_formatChartNumber(r.Val,fmt))+"</text>";}return _svgRoot(g.totalW,h,body);}
	function _renderPieSvg(display){var g=_chartDefaults.pie,rows=_barPieRows(display),total=0,body='',legend='';for(var i=0;i<rows.length;i++)total+=rows[i].Val;var strokeW=g.outerR-g.innerR,effR=(g.outerR+g.innerR)/2,circ=2*Math.PI*effR,prev=0,h=Math.max(g.minSvgH,g.legendY+g.legendPadB+rows.length*g.legendRowH);for(var i=0;i<rows.length;i++){var r=rows[i],col=_chartSwitchColor(display.colors,i),seg=total===0?0:r.Val/total*circ,off=circ/4-(total===0?0:prev/total*circ),y=g.legendY+i*g.legendRowH;body+="<circle cx='"+g.cx+"' cy='"+g.cy+"' r='"+effR+"' fill='none' stroke='"+col+"' stroke-width='"+strokeW+"' stroke-dasharray='"+seg.toFixed(2)+' '+(circ-seg).toFixed(2)+"' stroke-dashoffset='"+off.toFixed(2)+"'/>";legend+="<rect x='"+g.legendX+"' y='"+(y-10)+"' width='10' height='10' rx='2' fill='"+col+"'/>";legend+="<text x='"+(g.legendX+16)+"' y='"+y+"' font-size='11' fill='#605E5C'>"+_esc(r.Label)+"</text>";legend+="<text x='"+g.legendValueX+"' y='"+y+"' text-anchor='end' font-size='11' fill='#605E5C'>"+_esc(_formatChartNumber(r.Val,(display.value&&display.value.format)||'#,##0'))+' ('+_formatChartNumber(total===0?0:r.Val/total,'0.0%')+")</text>";prev+=r.Val;}var center="<text x='"+g.cx+"' y='"+(g.cy-4)+"' text-anchor='middle' font-size='11' fill='#605E5C'>Total</text>"+"<text x='"+g.cx+"' y='"+(g.cy+18)+"' text-anchor='middle' font-size='20' font-weight='600' fill='#252423'>"+_esc(_formatChartNumber(total,(display.value&&display.value.format)||'#,##0'))+"</text>";return _svgRoot(g.svgW,h,body+center+legend);}
	function _renderLineSvg(display){var g=_chartDefaults.line,mat=_lineRows(display),rows=mat.rows,series=mat.series,plotW=g.W-g.padL-g.padR,plotH=g.H-g.padT-g.padB,plotBottom=g.padT+plotH,xLabelY=plotBottom+g.xLabelGap,legendY=xLabelY+g.legendTopGap,legendColumns=Math.max(1,Math.floor(plotW/g.legendColumnWidth)),legendRows=Math.max(1,Math.ceil(series.length/legendColumns)),svgH=Math.max(g.H,legendY+legendRows*g.legendRowH+g.legendBottomPad),min,max;for(var r=0;r<rows.length;r++){for(var s=0;s<series.length;s++){var v=_num(rows[r]['S'+s]);if(min===undefined||v<min)min=v;if(max===undefined||v>max)max=v;}}if(min===undefined){min=0;max=0;}var range=max-min,body='';for(var grid=0;grid<g.gridCount;grid++){var y=g.padT+grid*plotH/(g.gridCount-1),yv=max-(grid*range/(g.gridCount-1));body+="<line x1='"+g.padL+"' y1='"+y+"' x2='"+(g.W-g.padR)+"' y2='"+y+"' stroke='#E6E6E6' stroke-width='1'/>";body+="<text x='"+(g.padL-8)+"' y='"+(y+4)+"' text-anchor='end' font-size='11' fill='#605E5C'>"+_esc(_formatChartNumber(yv,'#,##0'))+"</text>";}body+="<line x1='"+g.padL+"' y1='"+g.padT+"' x2='"+g.padL+"' y2='"+plotBottom+"' stroke='#C8C6C4' stroke-width='1'/><line x1='"+g.padL+"' y1='"+plotBottom+"' x2='"+(g.W-g.padR)+"' y2='"+plotBottom+"' stroke='#C8C6C4' stroke-width='1'/>";for(var s=0;s<series.length;s++){var pts=[],singlePoint='';for(var r=0;r<rows.length;r++){var x=rows.length<=1?g.padL+plotW/2:g.padL+plotW*r/(rows.length-1),y=g.padT+plotH-(range===0?plotH/2:(_num(rows[r]['S'+s])-min)/range*plotH);pts.push(x.toFixed(1)+','+y.toFixed(1));if(rows.length===1)singlePoint="<circle cx='"+x.toFixed(1)+"' cy='"+y.toFixed(1)+"' r='3.5' fill='"+_chartColor(display.colors,s)+"'/>";}body+="<polyline points='"+pts.join(' ')+"' fill='none' stroke='"+_chartColor(display.colors,s)+"' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/>"+singlePoint;}for(var s=0;s<series.length;s++){var col=s%legendColumns,row=Math.floor(s/legendColumns),lx=g.padL+col*g.legendColumnWidth,ly=legendY+row*g.legendRowH,label=series[s].label||series[s].column||('Series '+(s+1));body+="<line x1='"+lx+"' y1='"+(ly-4)+"' x2='"+(lx+g.legendLineWidth)+"' y2='"+(ly-4)+"' stroke='"+_chartColor(display.colors,s)+"' stroke-width='3' stroke-linecap='round'/>";body+="<text x='"+(lx+g.legendGap)+"' y='"+ly+"' font-size='11' fill='#605E5C'>"+_esc(label)+"</text>";}if(rows.length>0){body+="<text x='"+g.padL+"' y='"+xLabelY+"' font-size='11' fill='#605E5C'>"+_esc(_axisLabel(rows[0][display.xAxis],display.xAxis,mat.fact))+"</text>";body+="<text x='"+(g.W-g.padR)+"' y='"+xLabelY+"' text-anchor='end' font-size='11' fill='#605E5C'>"+_esc(_axisLabel(rows[rows.length-1][display.xAxis],display.xAxis,mat.fact))+"</text>";}return _svgRoot(g.W,svgH,body);}
	function _renderChart(id,spec){var key=String(id||'');if(!key)return;var display=_chartDisplay(key,spec);if(!display||!display.type)return;_chartRegistry[key]=display;var el=_bindEl(key);if(!el){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){_renderRegisteredCharts();},{once:true});return;}var svg='';if(display.type==='bar'&&display.groupBy)svg=_renderBarSvg(display);else if(display.type==='pie'&&display.groupBy)svg=_renderPieSvg(display);else if(display.type==='line'&&display.xAxis)svg=_renderLineSvg(display);if(svg)el.innerHTML=svg;}
	function _renderRegisteredCharts(){for(var key in _chartRegistry){if(Object.prototype.hasOwnProperty.call(_chartRegistry,key))_renderChart(key,_chartRegistry[key]);}}
	function _bind(id,val){var el=_bindEl(id);if(el)el.textContent=_fmtVal(val);}
	function _bindHtml(id,html){var el=_bindEl(id);if(el)el.innerHTML=html;}
	window.KustoWorkbench={
		getData:function(){return _d;},
		onDataReady:function(cb){_cbs.push(cb);try{cb(_d);}catch(e){console.error(e);}},
		_notify:function(d){_d=d;for(var i=0;i<_cbs.length;i++){try{_cbs[i](d);}catch(e){console.error(e);}}_renderRegisteredCharts();_renderRegisteredTables();_renderRegisteredRepeatedTables();},
		agg:_agg,
		bind:_bind,
		bindHtml:_bindHtml,
		renderChart:_renderChart,
		renderTable:_renderTable,
		renderRepeatedTable:_renderRepeatedTable,
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
		let html = `<style id="kw-preview-slicer-reset">html,body{margin:0!important;}</style><div id="kw-slicers" style="all:initial;box-sizing:border-box;display:flex;gap:16px;padding:12px 16px;margin-bottom:20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;background:${slicerBg};color:${slicerFg};border-bottom:1px solid ${slicerBorder};flex-wrap:wrap;align-items:center;color-scheme:${isDark ? 'dark' : 'light'}">`;

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
		function fitSlicerToPreviewEdges(){
			if(!slicerEl||!document.body)return;
			var cs=getComputedStyle(document.body);
			var pt=parseFloat(cs.paddingTop)||0;
			var pl=parseFloat(cs.paddingLeft)||0;
			var pr=parseFloat(cs.paddingRight)||0;
			slicerEl.style.marginTop=pt?('-'+pt+'px'):'0';
			slicerEl.style.marginLeft=pl?('-'+pl+'px'):'0';
			slicerEl.style.marginRight=pr?('-'+pr+'px'):'0';
			slicerEl.style.width='calc(100% + '+(pl+pr)+'px)';
		}
		requestAnimationFrame(fitSlicerToPreviewEdges);
		window.addEventListener('load',fitSlicerToPreviewEdges);
		window.addEventListener('resize',fitSlicerToPreviewEdges);
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
		var raf=0;
		function px(v){var n=parseFloat(v||'0');return isFinite(n)?n:0;}
		function viewportHeight(){
			var de=document.documentElement;
			var body=document.body;
			var primary=Math.max(window.innerHeight||0,de?(de.clientHeight||0):0);
			return primary>0?primary:(body?(body.clientHeight||0):0);
		}
		function bodyBoxHeight(){
			var body=document.body;
			if(!body)return 0;
			var rect=body.getBoundingClientRect();
			var style=getComputedStyle(body);
			var bottom=Math.max(0,Math.ceil(rect.bottom+window.scrollY+px(style.marginBottom)));
			var viewport=viewportHeight();
			if(!scrollOverflowHeight()&&viewport>0&&Math.abs(bottom-viewport)<2)return 0;
			return bottom;
		}
		function scrollOverflowHeight(){
			var de=document.documentElement;
			var body=document.body;
			var viewport=viewportHeight();
			var max=0;
			var bodyScroll=body?(body.scrollHeight||0):0;
			var docScroll=de?(de.scrollHeight||0):0;
			if(bodyScroll>viewport+1)max=Math.max(max,bodyScroll);
			if(docScroll>viewport+1)max=Math.max(max,docScroll);
			return max;
		}
		function rawScrollHeight(){
			var de=document.documentElement;
			var body=document.body;
			return Math.max(body?(body.scrollHeight||0):0,de?(de.scrollHeight||0):0);
		}
		function isInFixedSubtree(el){
			for(var n=el;n&&n!==document.body;n=n.parentElement){
				if(getComputedStyle(n).position==='fixed')return true;
			}
			return false;
		}
		function isViewportFill(rect){
			var viewport=viewportHeight();
			if(!viewport||scrollOverflowHeight())return false;
			var top=Math.round(rect.top+window.scrollY);
			var bottom=Math.round(rect.bottom+window.scrollY);
			return top<=1&&Math.abs(bottom-viewport)<2;
		}
		function clampsOverflow(style){
			return /(auto|scroll|hidden|clip)/.test((style.overflow||'')+' '+(style.overflowY||'')+' '+(style.overflowX||''));
		}
		function clampToOverflowAncestors(el,bottom){
			for(var n=el.parentElement;n&&n!==document.body;n=n.parentElement){
				var style=getComputedStyle(n);
				if(!clampsOverflow(style))continue;
				var rect=n.getBoundingClientRect();
				if(!rect.width&&!rect.height)continue;
				bottom=Math.min(bottom,Math.ceil(rect.bottom+window.scrollY+px(style.marginBottom)));
			}
			return bottom;
		}
		function maxElementBottom(){
			var body=document.body;
			if(!body)return 0;
			var nodes=body.querySelectorAll('*');
			var max=0;
			for(var i=0;i<nodes.length;i++){
				var el=nodes[i];
				var rect=el.getBoundingClientRect();
				if(!rect.width&&!rect.height)continue;
				var style=getComputedStyle(el);
				if(style.display==='none'||isInFixedSubtree(el)||isViewportFill(rect))continue;
				var marginBottom=px(style.marginBottom);
				var bottom=Math.ceil(rect.bottom+window.scrollY+marginBottom);
				max=Math.max(max,clampToOverflowAncestors(el,bottom));
			}
			return max;
		}
		function fallbackElementBottom(){
			var body=document.body;
			if(!body)return 0;
			var nodes=body.querySelectorAll('*');
			var max=0;
			for(var i=0;i<nodes.length;i++){
				var el=nodes[i];
				var rect=el.getBoundingClientRect();
				if(!rect.width&&!rect.height)continue;
				var style=getComputedStyle(el);
				if(style.display==='none')continue;
				var marginBottom=px(style.marginBottom);
				var bottom=Math.ceil(rect.bottom+window.scrollY+marginBottom);
				max=Math.max(max,clampToOverflowAncestors(el,bottom));
			}
			return max;
		}
		function measure(){
			var primary=Math.max(bodyBoxHeight(),scrollOverflowHeight(),maxElementBottom());
			return Math.max(1,primary||fallbackElementBottom());
		}
		function send(){
			var h=measure();
			parent.postMessage({type:'kw-html-preview-height',h:h,metrics:{viewportHeight:viewportHeight(),scrollHeight:rawScrollHeight()}},'*');
		}
		function schedule(){
			if(raf)cancelAnimationFrame(raf);
			raf=requestAnimationFrame(function(){raf=0;send();});
		}
		if(document.readyState==='complete')schedule();else window.addEventListener('load',schedule);
		window.addEventListener('DOMContentLoaded',schedule);
		window.addEventListener('resize',schedule);
		window.addEventListener('message',function(e){if(e.data&&e.data.type==='kw-html-request-height')schedule();});
		var ro=new ResizeObserver(schedule);
		if(document.documentElement)ro.observe(document.documentElement);
		if(document.body)ro.observe(document.body);
		var mo=new MutationObserver(schedule);
		mo.observe(document.documentElement,{childList:true,subtree:true,attributes:true,characterData:true});
		schedule();
		setTimeout(schedule,50);
		setTimeout(schedule,250);
		setTimeout(schedule,1000);
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
				this._lastPreviewContentHeight = Math.ceil(h);
				const metrics = e.data.metrics as { scrollHeight?: unknown; viewportHeight?: unknown } | undefined;
				const scrollHeight = Number(metrics?.scrollHeight);
				const viewportHeight = Number(metrics?.viewportHeight);
				this._lastPreviewScrollHeight = Number.isFinite(scrollHeight) && scrollHeight > 0 ? Math.ceil(scrollHeight) : 0;
				this._lastPreviewViewportHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? Math.ceil(viewportHeight) : 0;
				this._applyPreviewFitHeight(this._lastPreviewContentHeight);
				if (this._pendingPreviewHeightResolve) {
					const resolve = this._pendingPreviewHeightResolve;
					this._pendingPreviewHeightResolve = null;
					resolve(this._lastPreviewContentHeight);
				}
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
						dataMode: e.data.dataMode === 'import' || e.data.dataMode === 'directQuery' ? e.data.dataMode : undefined,
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
		const fitH = Math.max(120, Math.ceil(contentH + 8));
		if (this._lastPreviewFitHeight > 0 && Math.abs(fitH - this._lastPreviewFitHeight) < 5) return;
		this._lastPreviewFitHeight = fitH;
		wrapper.style.height = fitH + 'px';
		wrapper.style.maxHeight = fitH + 'px';
		requestOverlayScrollbarUpdate(true);
	}

	// ── Height capture / restore (survive mode switches) ──────────────────────

	/** Snapshot the current wrapper height before a mode switch destroys it. */
	private _captureCurrentHeight(): void {
		if (this._mode === 'code') {
			if (!this._userResizedEditor) { this._savedEditorHeightPx = undefined; return; }
			const wrapper = this.shadowRoot?.getElementById('editor-wrapper');
			if (wrapper) {
				const h = wrapper.getBoundingClientRect().height;
				if (h > 0) this._savedEditorHeightPx = Math.round(h);
			}
		} else {
			if (!this._userResizedPreview) { this._savedPreviewHeightPx = undefined; return; }
			const wrapper = this.shadowRoot?.getElementById('preview-wrapper');
			if (wrapper) {
				const h = wrapper.getBoundingClientRect().height;
				if (h > 0) this._savedPreviewHeightPx = Math.round(h);
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
		requestOverlayScrollbarUpdate(true);
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

	/** Measure a visible fixed-height child without letting the editor area feed back into the fit. */
	private _getVisibleBoxHeight(el: Element): number {
		try {
			const element = el as HTMLElement;
			const cs = getComputedStyle(element);
			if (cs.display === 'none') return 0;
			const rect = element.getBoundingClientRect();
			const margin = (parseFloat(cs.marginTop || '0') || 0) + (parseFloat(cs.marginBottom || '0') || 0);
			return Math.max(0, Math.ceil((rect.height || 0) + margin));
		} catch (e) { console.error('[kusto]', e); }
		return 0;
	}

	/** Compute the wrapper chrome that surrounds the Monaco content. */
	private _getEditorWrapperChrome(wrapper: HTMLElement): number {
		let chrome = 0;
		try {
			const csw = getComputedStyle(wrapper);
			chrome += (parseFloat(csw.paddingTop || '0') || 0) + (parseFloat(csw.paddingBottom || '0') || 0);
			chrome += (parseFloat(csw.borderTopWidth || '0') || 0) + (parseFloat(csw.borderBottomWidth || '0') || 0);

			for (const child of Array.from(wrapper.children)) {
				if ((child as HTMLElement).classList?.contains('editor-area')) continue;
				chrome += this._getVisibleBoxHeight(child);
			}

			const editorArea = wrapper.querySelector('.editor-area') as HTMLElement | null;
			if (editorArea) {
				const csa = getComputedStyle(editorArea);
				chrome += (parseFloat(csa.paddingTop || '0') || 0) + (parseFloat(csa.paddingBottom || '0') || 0);
				chrome += (parseFloat(csa.borderTopWidth || '0') || 0) + (parseFloat(csa.borderBottomWidth || '0') || 0);
			}
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

		const raw = Math.max(120, Math.ceil(this._getEditorWrapperChrome(wrapper) + contentHeight + 5));
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
		requestOverlayScrollbarUpdate(true);
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

	public fitToContents(): void {
		const run = () => {
			try { this._fitToContents(); } catch (e) { console.error('[kusto]', e); }
		};

		run();
		this.updateComplete.then(() => {
			run();
			window.setTimeout(run, 50);
			window.setTimeout(run, 150);
			window.setTimeout(run, 350);
		}).catch(e => console.error('[kusto]', e));
	}

	private _fitToContents(): void {
		if (this._mode === 'code') {
			// Clear user-resize so auto-fit re-engages.
			this._userResizedEditor = false;
			this._savedEditorHeightPx = undefined;
			// Force recalculation by resetting cached fit height.
			this._lastFitHeight = 0;
			this._autoFitToContent();
		} else {
			// Clear user-resize so auto-fit re-engages.
			this._userResizedPreview = false;
			this._savedPreviewHeightPx = undefined;
			this._invalidatePreviewContentHeight();
			this.requestUpdate();
			// Preview mode — ask the iframe to re-report its height.
			const iframe = this.shadowRoot?.getElementById('preview-iframe') as HTMLIFrameElement | null;
			if (iframe?.contentWindow) {
				try { iframe.contentWindow.postMessage({ type: 'kw-html-request-height' }, '*'); } catch (e) { console.error('[kusto]', e); }
			} else {
				this.updateComplete.then(() => {
					const nextIframe = this.shadowRoot?.getElementById('preview-iframe') as HTMLIFrameElement | null;
					if (nextIframe?.contentWindow) {
						try { nextIframe.contentWindow.postMessage({ type: 'kw-html-request-height' }, '*'); } catch (e) { console.error('[kusto]', e); }
					}
				}).catch(e => console.error('[kusto]', e));
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
			requestOverlayScrollbarUpdate(true);
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
			requestOverlayScrollbarUpdate(true);
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
		if (this._savedCode !== null) return this._savedCode;
		if (typeof this.initialCode === 'string') return this.initialCode;
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

		const previewH = this._userResizedPreview
			? (this._savedPreviewHeightPx ?? this._getWrapperHeightPx('preview-wrapper', true))
			: undefined;
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
			this._savedCode = code;
			this.initialCode = code;
			// Buffer for when Monaco isn't ready yet.
			pState.pendingHtmlCodeByBoxId = pState.pendingHtmlCodeByBoxId || {};
			pState.pendingHtmlCodeByBoxId[this.boxId] = code;
		}
		this._invalidatePreviewContentHeight();
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

	public getDashboardExportContext(): HtmlDashboardExportContext {
		const code = this._getCodeText();
		const provenance = parseKwProvenance(code);
		const dataSources = this._collectDataSourcesForPBI();
		return {
			sectionId: this.boxId,
			name: this._name,
			code,
			previewHeight: this._measurePreviewHeight(),
			hasProvenance: !!provenance,
			bindingCount: provenance ? Object.keys(provenance.bindings || {}).length : 0,
			dataSources,
			factColumns: dataSources[0]?.columns ?? [],
		};
	}

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
