import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

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

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	override connectedCallback(): void {
		super.connectedCallback();
		document.addEventListener('click', this._onDocumentClick);
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

	static override styles = css`
		*, *::before, *::after {
			box-sizing: border-box;
		}

		:host {
			display: block;
			border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.25))));
			border-radius: 0;
			margin-bottom: 16px;
			background: var(--vscode-editor-background);
			box-shadow: 0 2px 10px var(--vscode-widget-shadow);
		}

		:host(.is-collapsed) .editor-wrapper {
			display: none !important;
		}
		:host(.is-collapsed) .md-mode-btn,
		:host(.is-collapsed) .md-tabs-divider,
		:host(.is-collapsed) .md-max-btn,
		:host(.is-collapsed) .md-mode-dropdown {
			display: none !important;
		}
		:host(.is-collapsed) {
			padding-bottom: 2px;
		}

		:host(.is-md-preview) .editor-wrapper {
			border: none;
			background: transparent;
			margin-top: 0;
		}
		:host(.is-md-preview) .section-header-row {
			margin-bottom: 2px;
		}
		:host(.is-md-preview) {
			margin-bottom: 20px;
		}
		:host(.is-md-preview-auto) .editor-wrapper {
			height: auto;
			min-height: 0;
			overflow: visible;
		}
		:host(.is-md-preview-fixed) .editor-wrapper {
			overflow: hidden;
		}

		.section-root {
			padding: 12px;
			padding-bottom: 5px;
		}

		.section-header-row {
			display: flex;
			gap: 8px;
			align-items: center;
			justify-content: space-between;
			margin-bottom: 8px;
		}

		.query-name-group {
			display: inline-flex;
			align-items: center;
			gap: 0;
			min-width: 0;
			flex: 1 1 auto;
		}

		.section-drag-handle {
			opacity: 1;
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-descriptionForeground);
			border-radius: 4px;
			margin: 0;
			width: 12px;
			height: 24px;
			padding: 0;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			cursor: grab;
			flex: 0 0 auto;
		}
		.section-drag-handle:hover {
			background: var(--vscode-list-hoverBackground);
			border-color: var(--vscode-input-border);
			color: var(--vscode-foreground);
		}
		.section-drag-handle:active { cursor: grabbing; }
		.section-drag-handle:focus-visible {
			outline: none;
			border-color: var(--vscode-focusBorder);
		}
		.section-drag-handle-glyph {
			font-size: 14px;
			line-height: 1;
			letter-spacing: -1px;
		}

		.query-name {
			font-size: 12px;
			color: var(--vscode-foreground);
			background: transparent;
			border: 1px solid transparent;
			border-radius: 4px;
			padding: 2px 6px;
			outline: none;
			min-width: 0;
			flex: 1 1 auto;
			font-family: inherit;
		}
		.query-name::placeholder {
			color: var(--vscode-input-placeholderForeground);
		}
		.query-name:hover {
			border-color: var(--vscode-input-border);
		}
		.query-name:focus {
			border-color: var(--vscode-focusBorder);
		}

		.section-actions {
			display: inline-flex;
			gap: 2px;
			align-items: center;
			flex: 0 0 auto;
		}

		.md-tabs {
			display: inline-flex;
			gap: 2px;
			align-items: center;
			border: none;
			border-radius: 0;
			overflow: visible;
			margin: 0;
			background: transparent;
		}

		.md-tabs-divider {
			width: 1px;
			height: 16px;
			background: var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.35))));
			margin: 0 4px;
			opacity: 0.9;
		}

		.unified-btn-secondary {
			background: transparent;
			color: var(--vscode-foreground);
			border: 1px solid transparent;
			border-radius: 4px;
			padding: 4px 8px;
			font-size: 12px;
			cursor: pointer;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 4px;
			white-space: nowrap;
			line-height: 1.4;
		}
		.unified-btn-secondary:hover:not(:disabled) {
			background: var(--vscode-list-hoverBackground);
		}
		.unified-btn-icon-only {
			width: 28px;
			height: 28px;
			min-width: 28px;
			padding: 0;
		}
		.unified-btn-icon-only svg {
			display: block;
		}

		.md-tab {
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-foreground);
			cursor: pointer;
			padding: 0;
			width: 28px;
			height: 28px;
			border-radius: 4px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			line-height: 0;
		}
		.md-tab svg {
			display: block;
		}
		.md-tab:hover {
			background: var(--vscode-list-hoverBackground);
		}
		.md-tab.md-max-btn {
			margin-right: 6px;
		}

		.md-tab.md-mode-btn {
			width: auto;
			padding: 0 10px;
			font-size: 12px;
			line-height: 1;
			height: 28px;
			min-width: 68px;
			justify-content: center;
		}
		.md-tab.md-mode-btn.is-active {
			background: var(--vscode-list-hoverBackground);
			border-color: var(--vscode-input-border);
		}

		.md-tab.is-active {
			background: var(--vscode-list-hoverBackground);
			border-color: var(--vscode-input-border);
		}

		/* Mode dropdown (shown on narrow widths) */
		.md-mode-dropdown {
			display: none;
			position: relative;
			flex: 0 0 auto;
			width: auto;
		}
		:host(.is-md-narrow) .md-mode-btn {
			display: none !important;
		}
		:host(.is-md-narrow) .md-mode-dropdown {
			display: inline-flex;
		}
		:host(.is-md-very-narrow) .md-mode-dropdown,
		:host(.is-md-very-narrow) .md-tabs-divider {
			display: none !important;
		}

		.md-mode-dropdown-btn {
			display: inline-flex;
			align-items: center;
			gap: 4px;
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-foreground);
			cursor: pointer;
			padding: 0 8px;
			height: 28px;
			border-radius: 4px;
			font-size: 12px;
			line-height: 1;
			width: auto;
			flex: 0 0 auto;
		}
		.md-mode-dropdown-btn:hover {
			background: var(--vscode-list-hoverBackground);
		}
		.md-mode-dropdown-text {
			white-space: nowrap;
		}
		.md-mode-dropdown-caret {
			display: block;
			opacity: 0.8;
			flex-shrink: 0;
		}
		.md-mode-dropdown-menu {
			position: absolute;
			top: 100%;
			left: 0;
			z-index: 1000;
			min-width: 100px;
			background: var(--vscode-dropdown-background, var(--vscode-menu-background));
			border: 1px solid var(--vscode-dropdown-border, var(--vscode-menu-border, var(--vscode-widget-border)));
			border-radius: 4px;
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
			margin-top: 2px;
		}
		.md-mode-dropdown-item {
			padding: 6px 12px;
			cursor: pointer;
			font-size: 12px;
			color: var(--vscode-dropdown-foreground, var(--vscode-menu-foreground));
		}
		.md-mode-dropdown-item:hover {
			background: var(--vscode-list-hoverBackground);
		}
		.md-mode-dropdown-item:first-child {
			border-radius: 3px 3px 0 0;
		}
		.md-mode-dropdown-item:last-child {
			border-radius: 0 0 3px 3px;
		}

		/* Editor wrapper — slotted TOAST UI content lives in light DOM */
		.editor-wrapper {
			position: relative;
			width: 100%;
			min-height: 120px;
			height: 325px;
			margin: 0 0 0 0;
			border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.25))));
			border-radius: 2px;
			background: var(--vscode-editor-background);
			overflow: visible;
			display: flex;
			flex-direction: column;
		}

		::slotted(.kusto-markdown-editor) {
			width: 100%;
			flex: 1 1 auto;
			height: auto;
			min-height: 0;
			min-width: 0;
			position: relative;
			overflow: hidden;
		}

		::slotted(.markdown-viewer) {
			width: 100%;
			flex: 1 1 auto;
			height: auto;
			min-height: 80px;
			min-width: 0;
			position: relative;
			overflow: auto;
			font-size: 13px;
			border: none;
			border-radius: 0;
			padding: 0;
			background: transparent;
		}

		/* Preview mode: strip TOAST UI viewer chrome */
		:host(.is-md-preview) ::slotted(.markdown-viewer) {
			border: none;
			padding: 0;
			min-height: 0;
		}

		.resizer {
			flex: 0 0 12px;
			height: 12px;
			cursor: ns-resize;
			border-top: none;
			background: var(--vscode-editor-background);
			position: relative;
			touch-action: none;
		}
		.resizer::after {
			content: '';
			position: absolute;
			left: 50%;
			top: 50%;
			width: 34px;
			height: 4px;
			transform: translate(-50%, -50%);
			border-radius: 2px;
			opacity: 0.55;
			background-image: repeating-linear-gradient(
				0deg,
				var(--vscode-input-placeholderForeground),
				var(--vscode-input-placeholderForeground) 1px,
				transparent 1px,
				transparent 3px
			);
		}
		.resizer:hover { background: var(--vscode-list-hoverBackground); }
		.resizer:hover::after { opacity: 0.85; }
		.resizer.is-dragging { background: var(--vscode-list-hoverBackground); }

		.close-btn {
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-foreground);
			border-radius: 4px;
			cursor: pointer;
		}
		.close-btn:hover {
			background: var(--vscode-list-hoverBackground);
		}
	`;

	// ── Render ─────────────────────────────────────────────────────────────────

	override render() {
		const modeLabels: Record<MarkdownMode, string> = { wysiwyg: 'WYSIWYG', markdown: 'Markdown', preview: 'Preview' };

		return html`
			<div class="section-root">
				<div class="section-header-row">
					<div class="query-name-group">
						<button type="button" class="section-drag-handle" draggable="true"
							title="Drag to reorder" aria-label="Reorder section"
							@dragstart=${this._onDragStart}>
							<span class="section-drag-handle-glyph" aria-hidden="true">⋮</span>
						</button>
						<input type="text" class="query-name"
							placeholder="Section Name (optional)"
							.value=${this._title}
							@input=${this._onTitleInput} />
					</div>
					<div class="section-actions">
						<div class="md-tabs" role="tablist" aria-label="Markdown visibility">
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
								@click=${() => this._setMode('wysiwyg')} title="WYSIWYG" aria-label="WYSIWYG">WYSIWYG</button>
							<button class="unified-btn-secondary md-tab md-mode-btn ${this._mode === 'markdown' ? 'is-active' : ''}"
								type="button" role="tab" aria-selected=${this._mode === 'markdown' ? 'true' : 'false'}
								@click=${() => this._setMode('markdown')} title="Markdown" aria-label="Markdown">Markdown</button>
							<button class="unified-btn-secondary md-tab md-mode-btn ${this._mode === 'preview' ? 'is-active' : ''}"
								type="button" role="tab" aria-selected=${this._mode === 'preview' ? 'true' : 'false'}
								@click=${() => this._setMode('preview')} title="Preview" aria-label="Preview">Preview</button>
							<span class="md-tabs-divider" aria-hidden="true"></span>
							<button class="unified-btn-secondary md-tab md-max-btn"
								type="button" @click=${this._fitToContents}
								title="Fit to contents" aria-label="Fit to contents">
								${KwMarkdownSection._maximizeIcon}
							</button>
							<button class="unified-btn-secondary md-tab ${this._expanded ? 'is-active' : ''}"
								type="button" role="tab" aria-selected=${this._expanded ? 'true' : 'false'}
								@click=${this._toggleVisibility}
								title=${this._expanded ? 'Hide' : 'Show'}
								aria-label=${this._expanded ? 'Hide' : 'Show'}>
								${KwMarkdownSection._previewIcon}
							</button>
						</div>
						<button class="unified-btn-secondary unified-btn-icon-only close-btn"
							type="button" @click=${this._requestRemove}
							title="Remove" aria-label="Remove">
							${KwMarkdownSection._closeIcon}
						</button>
					</div>
				</div>
				<div class="editor-wrapper" id="editor-wrapper">
					<slot name="editor"></slot>
					<slot name="viewer"></slot>
					<div class="resizer"
						title="Drag to resize\nDouble-click to fit to contents"
						@mousedown=${this._onResizerMouseDown}
						@dblclick=${this._fitToContents}></div>
				</div>
			</div>
		`;
	}

	// ── SVG Icons (static) ────────────────────────────────────────────────────

	private static _closeIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
			stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">
			<path d="M4 4l8 8"/><path d="M12 4L4 12"/>
		</svg>`;

	private static _previewIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
			stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
			<path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z" />
			<circle cx="8" cy="8" r="2.1" />
		</svg>`;

	private static _maximizeIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
			stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
			<path d="M3 6V3h3"/><path d="M13 10v3h-3"/>
			<path d="M3 3l4 4"/><path d="M13 13l-4-4"/>
		</svg>`;

	// ── TOAST UI Editor Init ──────────────────────────────────────────────────

	/** Initialize the TOAST UI editor in the slotted light-DOM container. */
	private _initEditor(): void {
		const editorContainer = this._getEditorContainer();
		if (!editorContainer) return;

		let ToastEditor: any = null;
		try {
			ToastEditor = (window as any).toastui?.Editor ?? null;
		} catch { ToastEditor = null; }

		if (!ToastEditor) {
			this._retryEditorInit();
			return;
		}

		// If already initialized and attached, skip.
		if (this._editorApi) {
			const attached = !!editorContainer.querySelector('.toastui-editor-defaultUI');
			if (attached) return;
			try { this._editorApi.dispose(); } catch { /* ignore */ }
			this._editorApi = null;
		}

		editorContainer.style.minHeight = '0';
		editorContainer.style.minWidth = '0';

		// Resolve initial text: prefer pending buffer, then attribute.
		let initialValue = this.initialText || '';
		try {
			const pending = (window as any).__kustoPendingMarkdownTextByBoxId?.[this.boxId];
			if (typeof pending === 'string') {
				initialValue = pending;
				try { delete (window as any).__kustoPendingMarkdownTextByBoxId[this.boxId]; } catch { /* ignore */ }
			}
		} catch { /* ignore */ }

		// Clean mount point.
		editorContainer.textContent = '';

		const isLikelyDark = typeof (window as any).isLikelyDarkTheme === 'function'
			? (window as any).isLikelyDarkTheme()
			: false;

		// Build undo/redo buttons.
		let toastEditorRef: any = null;
		const undoButton = this._createToolbarButton('Undo', 'Undo (Ctrl+Z)',
			'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>',
			() => { try { toastEditorRef?.getCurrentModeEditor?.()?.commands?.undo?.(); } catch { /* ignore */ } });
		const redoButton = this._createToolbarButton('Redo', 'Redo (Ctrl+Y)',
			'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>',
			() => { try { toastEditorRef?.getCurrentModeEditor?.()?.commands?.redo?.(); } catch { /* ignore */ } });

		const getToastUiPlugins = typeof (window as any).getToastUiPlugins === 'function'
			? (window as any).getToastUiPlugins
			: () => [];

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
				initialValue,
				toolbarItems: toolbarItemsConfig,
				plugins: getToastUiPlugins(ToastEditor),
				events: {
					change: () => {
						this._schedulePersist();
						this._scheduleMdAutoExpand();
					},
					afterPreviewRender: () => {
						try {
							if (typeof (window as any).__kustoRewriteToastUiImagesInContainer === 'function') {
								(window as any).__kustoRewriteToastUiImagesInContainer(editorContainer);
							}
						} catch { /* ignore */ }
					}
				}
			};
			if (isLikelyDark) {
				editorOptions.theme = 'dark';
			}
			toastEditor = new ToastEditor(editorOptions);
			toastEditorRef = toastEditor;
		} catch (e) {
			try { console.error('Failed to initialize TOAST UI Editor.', e); } catch { /* ignore */ }
			return;
		}

		// Install keyboard shortcut conflict resolution (same as legacy).
		this._installKeyboardShortcuts(editorContainer, toastEditor);

		// Initial image rewrite pass.
		try {
			if (typeof (window as any).__kustoRewriteToastUiImagesInContainer === 'function') {
				(window as any).__kustoRewriteToastUiImagesInContainer(editorContainer);
			}
		} catch { /* ignore */ }

		// Build and store API.
		const api: ToastEditorApi = {
			getValue: () => {
				try { return toastEditor?.getMarkdown?.() ?? ''; } catch { return ''; }
			},
			setValue: (value: string) => {
				try { toastEditor?.setMarkdown?.(String(value || '')); } catch { /* ignore */ }
			},
			layout: () => {
				try {
					if (!toastEditor || typeof toastEditor.setHeight !== 'function') return;
					const wrapper = this.shadowRoot?.getElementById('editor-wrapper');
					if (!wrapper) return;
					const resizerEl = wrapper.querySelector('.resizer');
					let h = wrapper.getBoundingClientRect().height;
					if (resizerEl) h -= resizerEl.getBoundingClientRect().height;
					h = Math.max(120, h);
					toastEditor.setHeight(Math.round(h) + 'px');
				} catch { /* ignore */ }
			},
			dispose: () => {
				try { toastEditor?.destroy?.(); } catch { /* ignore */ }
				try { editorContainer.textContent = ''; } catch { /* ignore */ }
			},
			_toastui: toastEditor
		};

		this._editorApi = api;

		// Register with global markdownEditors map so legacy code can still access it.
		try {
			const win = window as any;
			win.__kustoMarkdownEditors = win.__kustoMarkdownEditors || {};
			win.__kustoMarkdownEditors[this.boxId] = api;
		} catch { /* ignore */ }

		// Check for late-arriving pending text.
		try {
			const latePending = (window as any).__kustoPendingMarkdownTextByBoxId?.[this.boxId];
			if (typeof latePending === 'string') {
				api.setValue(latePending);
				try { delete (window as any).__kustoPendingMarkdownTextByBoxId[this.boxId]; } catch { /* ignore */ }
			}
		} catch { /* ignore */ }

		// Apply mode.
		this._applyEditorMode();

		// Apply pending reveal.
		try {
			if (typeof (window as any).__kustoTryApplyPendingMarkdownReveal === 'function') {
				(window as any).__kustoTryApplyPendingMarkdownReveal(this.boxId);
			}
		} catch { /* ignore */ }

		// Fix double-border issue for multi-section files.
		try {
			const isPlainMd = String((window as any).__kustoDocumentKind || '') === 'md';
			if (!isPlainMd) {
				const defaultUI = editorContainer.querySelector('.toastui-editor-defaultUI') as HTMLElement | null;
				if (defaultUI) {
					defaultUI.style.setProperty('border', 'none', 'important');
					defaultUI.style.setProperty('border-radius', '0', 'important');
				}
				const toolbar = editorContainer.querySelector('.toastui-editor-defaultUI-toolbar') as HTMLElement | null;
				if (toolbar) {
					toolbar.style.setProperty('margin', '-1px -1px 0 -1px', 'important');
					toolbar.style.setProperty('border-radius', '0', 'important');
				}
			}
		} catch { /* ignore */ }

		// Theme observer.
		try {
			if (typeof (window as any).__kustoStartToastUiThemeObserver === 'function') {
				(window as any).__kustoStartToastUiThemeObserver();
			}
			if (typeof (window as any).__kustoApplyToastUiThemeAll === 'function') {
				(window as any).__kustoApplyToastUiThemeAll();
			}
		} catch { /* ignore */ }

		// Initial sizing.
		try { api.layout(); } catch { /* ignore */ }
	}

	private _editorInitRetryCount = 0;
	private _retryEditorInit(): void {
		this._editorInitRetryCount++;
		const delays = [50, 250, 1000, 2000, 4000];
		if (this._editorInitRetryCount > delays.length) return;
		const delay = delays[this._editorInitRetryCount - 1];
		setTimeout(() => { try { this._initEditor(); } catch { /* ignore */ } }, delay);
	}

	// ── TOAST UI Viewer Init ──────────────────────────────────────────────────

	private _initViewer(initialValue: string): void {
		const viewerContainer = this._getViewerContainer();
		if (!viewerContainer) return;

		// If a viewer exists and is attached, just update value.
		if (this._viewerApi) {
			const attached = !!viewerContainer.querySelector('.toastui-editor-contents');
			if (attached) {
				this._viewerApi.setValue(initialValue);
				return;
			}
			try { this._viewerApi.dispose(); } catch { /* ignore */ }
			this._viewerApi = null;
		}

		let ToastEditor: any = null;
		try {
			ToastEditor = (window as any).toastui?.Editor ?? null;
		} catch { ToastEditor = null; }

		if (!ToastEditor) {
			this._retryViewerInit(initialValue);
			return;
		}

		viewerContainer.textContent = '';

		const isLikelyDark = typeof (window as any).isLikelyDarkTheme === 'function'
			? (window as any).isLikelyDarkTheme()
			: false;

		const getToastUiPlugins = typeof (window as any).getToastUiPlugins === 'function'
			? (window as any).getToastUiPlugins
			: () => [];

		let instance: any = null;
		try {
			const opts: any = {
				el: viewerContainer,
				viewer: true,
				usageStatistics: false,
				initialValue: String(initialValue || ''),
				plugins: getToastUiPlugins(ToastEditor),
				events: {
					afterPreviewRender: () => {
						try {
							if (typeof (window as any).__kustoRewriteToastUiImagesInContainer === 'function') {
								(window as any).__kustoRewriteToastUiImagesInContainer(viewerContainer);
							}
						} catch { /* ignore */ }
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
			try { console.error('Failed to initialize TOAST UI viewer.', e); } catch { /* ignore */ }
			return;
		}

		try {
			if (typeof (window as any).__kustoRewriteToastUiImagesInContainer === 'function') {
				(window as any).__kustoRewriteToastUiImagesInContainer(viewerContainer);
			}
		} catch { /* ignore */ }

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
		} catch { /* ignore */ }

		this._viewerApi = {
			setValue: (value: string) => {
				try { instance?.setMarkdown?.(String(value || '')); } catch { /* ignore */ }
			},
			dispose: () => {
				try { instance?.destroy?.(); } catch { /* ignore */ }
			}
		};

		// Theme observer.
		try {
			if (typeof (window as any).__kustoStartToastUiThemeObserver === 'function') {
				(window as any).__kustoStartToastUiThemeObserver();
			}
			if (typeof (window as any).__kustoApplyToastUiThemeAll === 'function') {
				(window as any).__kustoApplyToastUiThemeAll();
			}
		} catch { /* ignore */ }
	}

	private _viewerInitRetryCount = 0;
	private _retryViewerInit(initialValue: string): void {
		this._viewerInitRetryCount++;
		const delays = [50, 250, 1000, 2000, 4000];
		if (this._viewerInitRetryCount > delays.length) return;
		const delay = delays[this._viewerInitRetryCount - 1];
		setTimeout(() => { try { this._initViewer(initialValue); } catch { /* ignore */ } }, delay);
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
					} catch { /* ignore */ }
					return;
				}

				// Ctrl+Z → undo
				if (key === 'z' && !ev.shiftKey) {
					ev.stopPropagation(); ev.stopImmediatePropagation(); ev.preventDefault();
					try { toastEditor.getCurrentModeEditor?.()?.commands?.undo?.(); } catch { /* ignore */ }
					return;
				}
				// Ctrl+Shift+Z → redo
				if (key === 'z' && ev.shiftKey) {
					ev.stopPropagation(); ev.stopImmediatePropagation(); ev.preventDefault();
					try { toastEditor.getCurrentModeEditor?.()?.commands?.redo?.(); } catch { /* ignore */ }
					return;
				}
				// Ctrl+Y → redo
				if (key === 'y' && !ev.shiftKey) {
					ev.stopPropagation(); ev.stopImmediatePropagation(); ev.preventDefault();
					try { toastEditor.getCurrentModeEditor?.()?.commands?.redo?.(); } catch { /* ignore */ }
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
			} catch { /* ignore */ }
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
			const win = window as any;
			win.__kustoMarkdownModeByBoxId = win.__kustoMarkdownModeByBoxId || {};
			win.__kustoMarkdownModeByBoxId[this.boxId] = mode;
		} catch { /* ignore */ }
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
			return;
		}

		// Editor modes (WYSIWYG / Markdown).
		const toastEditor = this._editorApi?._toastui;
		if (toastEditor && typeof toastEditor.changeMode === 'function') {
			try { toastEditor.changeMode(this._mode, true); } catch { /* ignore */ }
		}
		try { this._editorApi?.layout(); } catch { /* ignore */ }
	}

	// ── Visibility (expand/collapse) ──────────────────────────────────────────

	private _toggleVisibility(): void {
		this._expanded = !this._expanded;
		this.classList.toggle('is-collapsed', !this._expanded);

		// Sync with global state for legacy code.
		try {
			const win = window as any;
			win.__kustoMarkdownExpandedByBoxId = win.__kustoMarkdownExpandedByBoxId || {};
			win.__kustoMarkdownExpandedByBoxId[this.boxId] = this._expanded;
		} catch { /* ignore */ }

		if (this._expanded) {
			setTimeout(() => { try { this._editorApi?.layout(); } catch { /* ignore */ } }, 0);
		}
		this._schedulePersist();
	}

	// ── Dropdown ──────────────────────────────────────────────────────────────

	private _toggleDropdown(e: Event): void {
		e.stopPropagation();
		// Close any global dropdowns first.
		try { (window as any).__kustoDropdown?.closeAllMenus?.(); } catch { /* ignore */ }
		this._dropdownOpen = !this._dropdownOpen;
	}

	private _onDocumentClick = (): void => {
		if (this._dropdownOpen) {
			this._dropdownOpen = false;
		}
	};

	// ── Drag ──────────────────────────────────────────────────────────────────

	private _onDragStart(e: DragEvent): void {
		if (e.dataTransfer) {
			e.dataTransfer.setData('text/plain', this.boxId);
			e.dataTransfer.effectAllowed = 'move';
		}
		this.dispatchEvent(new CustomEvent('section-drag-start', {
			detail: { boxId: this.boxId },
			bubbles: true,
			composed: true
		}));
	}

	// ── Title ─────────────────────────────────────────────────────────────────

	private _onTitleInput(e: Event): void {
		this._title = (e.target as HTMLInputElement).value;
		this._schedulePersist();
	}

	// ── Fit to contents ───────────────────────────────────────────────────────

	private _fitToContents(): void {
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
							} catch { /* ignore */ }
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
						} catch { /* ignore */ }
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

				const resizerH = 12;
				const padding = this._mode === 'wysiwyg' ? -1 : 13;
				const FIT_SLACK_PX = 5;
				const desired = Math.max(120, Math.ceil(toolbarH + contentH + resizerH + padding + FIT_SLACK_PX));
				wrapper.style.height = desired + 'px';
			} catch { /* ignore */ }
			try { this._editorApi?.layout(); } catch { /* ignore */ }
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
			if (String((window as any).__kustoDocumentKind || '') !== 'md') return;
			if (this._autoExpandTimer) clearTimeout(this._autoExpandTimer);
			this._autoExpandTimer = setTimeout(() => {
				try { this._autoExpandToContent(); } catch { /* ignore */ }
			}, 80);
		} catch { /* ignore */ }
	}

	private _autoExpandToContent(): void {
		if (String((window as any).__kustoDocumentKind || '') !== 'md') return;
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
				try { this._editorApi?.layout(); } catch { /* ignore */ }
			} catch { /* ignore */ }
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

		const getScrollY = typeof (window as any).__kustoGetScrollY === 'function'
			? (window as any).__kustoGetScrollY as () => number
			: () => 0;

		const startPageY = e.clientY + getScrollY();
		const startHeight = wrapper.getBoundingClientRect().height;

		const onMove = (moveEvent: MouseEvent) => {
			try {
				if (typeof (window as any).__kustoMaybeAutoScrollWhileDragging === 'function') {
					(window as any).__kustoMaybeAutoScrollWhileDragging(moveEvent.clientY);
				}
			} catch { /* ignore */ }
			const pageY = moveEvent.clientY + getScrollY();
			const delta = pageY - startPageY;
			const nextHeight = Math.max(120, startHeight + delta);
			wrapper.style.height = nextHeight + 'px';
			try { this._editorApi?.layout(); } catch { /* ignore */ }
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

	// ── Actions ───────────────────────────────────────────────────────────────

	private _requestRemove(): void {
		this.dispatchEvent(new CustomEvent('section-remove', {
			detail: { boxId: this.boxId },
			bubbles: true,
			composed: true
		}));
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	private _schedulePersist(): void {
		try {
			const sp = (window as any).schedulePersist;
			if (typeof sp === 'function') sp();
		} catch { /* ignore */ }
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
				const pending = (window as any).__kustoPendingMarkdownTextByBoxId;
				if (pending && typeof pending[this.boxId] === 'string') {
					text = pending[this.boxId];
				}
			} catch { /* ignore */ }
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
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-markdown-section': KwMarkdownSection;
	}
}
