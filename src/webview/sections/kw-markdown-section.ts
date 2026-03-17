import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { styles } from './kw-markdown-section.styles.js';
import { customElement, property, state } from 'lit/decorators.js';
import '../components/kw-section-shell.js';

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
					@fit-to-contents=${this._fitToContents}>
					${this._renderModeButtons('header-buttons')}
					<div class="editor-wrapper" id="editor-wrapper">
						<slot name="editor"></slot>
						<slot name="viewer"></slot>
						<div class="resizer"
							title="Drag to resize\nDouble-click to fit to contents"
							@mousedown=${this._onResizerMouseDown}
							@dblclick=${this._fitToContents}></div>
					</div>
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
			const pending = window.__kustoPendingMarkdownTextByBoxId?.[this.boxId];
			if (typeof pending === 'string') {
				initialValue = pending;
				try { delete window.__kustoPendingMarkdownTextByBoxId[this.boxId]; } catch { /* ignore */ }
			}
		} catch { /* ignore */ }

		// Clean mount point.
		editorContainer.textContent = '';

		const isLikelyDark = typeof window.isLikelyDarkTheme === 'function'
			? window.isLikelyDarkTheme()
			: false;

		// Build undo/redo buttons.
		let toastEditorRef: any = null;
		const undoButton = this._createToolbarButton('Undo', 'Undo (Ctrl+Z)',
			'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>',
			() => { try { toastEditorRef?.getCurrentModeEditor?.()?.commands?.undo?.(); } catch { /* ignore */ } });
		const redoButton = this._createToolbarButton('Redo', 'Redo (Ctrl+Y)',
			'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>',
			() => { try { toastEditorRef?.getCurrentModeEditor?.()?.commands?.redo?.(); } catch { /* ignore */ } });

		const getToastUiPlugins = typeof window.getToastUiPlugins === 'function'
			? window.getToastUiPlugins
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
							if (typeof window.__kustoRewriteToastUiImagesInContainer === 'function') {
								window.__kustoRewriteToastUiImagesInContainer(editorContainer);
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
			if (typeof window.__kustoRewriteToastUiImagesInContainer === 'function') {
				window.__kustoRewriteToastUiImagesInContainer(editorContainer);
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
			const win = window;
			win.__kustoMarkdownEditors = win.__kustoMarkdownEditors || {};
			win.__kustoMarkdownEditors[this.boxId] = api;
		} catch { /* ignore */ }

		// Check for late-arriving pending text.
		try {
			const latePending = window.__kustoPendingMarkdownTextByBoxId?.[this.boxId];
			if (typeof latePending === 'string') {
				api.setValue(latePending);
				try { delete window.__kustoPendingMarkdownTextByBoxId[this.boxId]; } catch { /* ignore */ }
			}
		} catch { /* ignore */ }

		// Apply mode.
		this._applyEditorMode();

		// Apply pending reveal.
		try {
			if (typeof window.__kustoTryApplyPendingMarkdownReveal === 'function') {
				window.__kustoTryApplyPendingMarkdownReveal(this.boxId);
			}
		} catch { /* ignore */ }

		// Fix border issues.
		try {
			const isPlainMd = String(window.__kustoDocumentKind || '') === 'md';
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
		} catch { /* ignore */ }

		// Theme observer.
		try {
			if (typeof window.__kustoStartToastUiThemeObserver === 'function') {
				window.__kustoStartToastUiThemeObserver();
			}
			if (typeof window.__kustoApplyToastUiThemeAll === 'function') {
				window.__kustoApplyToastUiThemeAll();
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
			ToastEditor = window.toastui?.Editor ?? null;
		} catch { ToastEditor = null; }

		if (!ToastEditor) {
			this._retryViewerInit(initialValue);
			return;
		}

		viewerContainer.textContent = '';

		const isLikelyDark = typeof window.isLikelyDarkTheme === 'function'
			? window.isLikelyDarkTheme()
			: false;

		const getToastUiPlugins = typeof window.getToastUiPlugins === 'function'
			? window.getToastUiPlugins
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
							if (typeof window.__kustoRewriteToastUiImagesInContainer === 'function') {
								window.__kustoRewriteToastUiImagesInContainer(viewerContainer);
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
			if (typeof window.__kustoRewriteToastUiImagesInContainer === 'function') {
				window.__kustoRewriteToastUiImagesInContainer(viewerContainer);
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
			if (typeof window.__kustoStartToastUiThemeObserver === 'function') {
				window.__kustoStartToastUiThemeObserver();
			}
			if (typeof window.__kustoApplyToastUiThemeAll === 'function') {
				window.__kustoApplyToastUiThemeAll();
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
			const win = window;
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
			const win = window;
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
		try { window.__kustoDropdown?.closeAllMenus?.(); } catch { /* ignore */ }
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
			if (String(window.__kustoDocumentKind || '') !== 'md') return;
			if (this._autoExpandTimer) clearTimeout(this._autoExpandTimer);
			this._autoExpandTimer = setTimeout(() => {
				try { this._autoExpandToContent(); } catch { /* ignore */ }
			}, 80);
		} catch { /* ignore */ }
	}

	private _autoExpandToContent(): void {
		if (String(window.__kustoDocumentKind || '') !== 'md') return;
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

		const getScrollY = typeof window.__kustoGetScrollY === 'function'
			? window.__kustoGetScrollY as () => number
			: () => 0;

		const startPageY = e.clientY + getScrollY();
		const startHeight = wrapper.getBoundingClientRect().height;

		const onMove = (moveEvent: MouseEvent) => {
			try {
				if (typeof window.__kustoMaybeAutoScrollWhileDragging === 'function') {
					window.__kustoMaybeAutoScrollWhileDragging(moveEvent.clientY);
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

	// ── Persistence ───────────────────────────────────────────────────────────

	private _schedulePersist(): void {
		try {
			const sp = window.schedulePersist;
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
				const pending = window.__kustoPendingMarkdownTextByBoxId;
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

	/** Get section name. */
	public getName(): string {
		return this._title;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-markdown-section': KwMarkdownSection;
	}
}
