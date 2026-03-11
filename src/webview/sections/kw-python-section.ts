import { LitElement, html, css, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Serialized shape for .kqlx persistence — must match KqlxSectionV1 python variant. */
export interface PythonSectionData {
	id: string;
	type: 'python';
	code: string;
	output: string;
	editorHeightPx?: number;
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
	updateOptions(opts: Record<string, unknown>): void;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<kw-python-section>` — Lit web component for a Python code section in the
 * Kusto Workbench notebook. Renders a Monaco Python editor, Run button,
 * resize handle, and output pane.
 *
 * Monaco renders in light DOM via `<slot>` to avoid shadow DOM incompatibilities.
 */
@customElement('kw-python-section')
export class KwPythonSection extends LitElement {

	// ── Public properties ─────────────────────────────────────────────────────

	/** Unique section identifier (e.g. "python_1709876543210"). */
	@property({ type: String, reflect: true, attribute: 'box-id' })
	boxId = '';

	/** Initial Python code to load into the editor. */
	@property({ type: String, attribute: 'initial-code' })
	initialCode = '';

	/** Editor wrapper height in pixels (from persisted state). */
	@property({ type: Number, attribute: 'editor-height-px' })
	editorHeightPx: number | undefined = undefined;

	// ── Internal state ────────────────────────────────────────────────────────

	@state() private _output = '';
	@state() private _running = false;

	private _editor: MonacoEditor | null = null;
	private _initRetryCount = 0;
	private _userResized = false;

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	override connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener('message', this._onMessage);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		window.removeEventListener('message', this._onMessage);
		this._disposeEditor();
	}

	override firstUpdated(_changedProperties: PropertyValues): void {
		super.firstUpdated(_changedProperties);
		// Slot assignment may happen after firstUpdated; listen for it.
		const slot = this.shadowRoot?.querySelector('slot[name="editor"]') as HTMLSlotElement | null;
		if (slot) {
			slot.addEventListener('slotchange', () => {
				if (!this._editor) this._initEditor();
			}, { once: true });
		}
		this._initEditor();
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

		.section-root {
			padding: 12px;
			padding-bottom: 0;
		}

		.section-header-row {
			display: flex;
			gap: 8px;
			align-items: center;
			justify-content: space-between;
			margin-bottom: 8px;
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

		.section-title {
			font-size: 12px;
			color: var(--vscode-foreground);
			font-weight: 600;
		}

		.section-actions {
			display: inline-flex;
			gap: 8px;
			align-items: center;
		}

		.md-tabs {
			display: inline-flex;
			gap: 2px;
			align-items: center;
			border: none;
			border-radius: 0;
			overflow: visible;
			margin: 0;
		}

		.section-btn {
			background: transparent;
			border: 1px solid var(--vscode-input-border);
			color: var(--vscode-foreground);
			cursor: pointer;
			padding: 4px 8px;
			font-size: 12px;
			border-radius: 4px;
		}
		.section-btn:hover {
			background: var(--vscode-list-hoverBackground);
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

		/* Editor wrapper — slotted content (Monaco) lives in light DOM */
		.editor-wrapper {
			position: relative;
			width: 100%;
			min-height: 120px;
			height: 325px;
			margin: 8px 0;
			border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.25))));
			border-radius: 2px;
			background: var(--vscode-editor-background);
			overflow: visible;
			display: flex;
			flex-direction: column;
		}

		::slotted(.query-editor) {
			width: 100%;
			flex: 1 1 auto;
			height: auto;
			min-height: 0;
			min-width: 0;
			position: relative;
			overflow: hidden;
			font-family: var(--vscode-editor-font-family);
			font-size: 13px;
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

		.python-output {
			border: 1px solid var(--vscode-input-border);
			border-radius: 4px;
			background: var(--vscode-editor-background);
			padding: 10px;
			font-family: var(--vscode-editor-font-family);
			font-size: 12px;
			white-space: pre-wrap;
			overflow: auto;
			max-height: 320px;
		}
	`;

	// ── Render ─────────────────────────────────────────────────────────────────

	override render() {
		return html`
			<div class="section-root">
			<div class="section-header-row">
				<button type="button" class="section-drag-handle" draggable="true"
					title="Drag to reorder" aria-label="Reorder section"
					@dragstart=${this._onDragStart}>
					<span class="section-drag-handle-glyph" aria-hidden="true">⋮</span>
				</button>
				<div class="section-title">Python</div>
				<div class="section-actions">
					<div class="md-tabs" role="tablist" aria-label="Python controls">
						<button class="unified-btn-secondary md-tab md-max-btn"
							type="button" @click=${this._fitToContents}
							title="Fit to contents" aria-label="Fit to contents">
							${KwPythonSection._maximizeIcon}
						</button>
					</div>
					<button class="section-btn" type="button"
						@click=${this._run} title="Run Python"
						?disabled=${this._running}>▶ Run</button>
					<button class="unified-btn-secondary unified-btn-icon-only section-btn"
						type="button" @click=${this._requestRemove}
						title="Remove" aria-label="Remove">
						${KwPythonSection._closeIcon}
					</button>
				</div>
			</div>
			<div class="editor-wrapper" id="editor-wrapper">
				<slot name="editor"></slot>
				<div class="resizer"
					title="Drag to resize editor\nDouble-click to fit to contents"
					@mousedown=${this._onResizerMouseDown}
					@dblclick=${this._fitToContents}></div>
			</div>
			<div class="python-output" aria-label="Python output">${this._output}</div>
			</div>
		`;
	}

	// ── SVG Icons (static) ────────────────────────────────────────────────────

	private static _closeIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
			stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">
			<path d="M4 4l8 8"/><path d="M12 4L4 12"/>
		</svg>`;

	private static _maximizeIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
			stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
			<path d="M3 6V3h3"/><path d="M13 10v3h-3"/>
			<path d="M3 3l4 4"/><path d="M13 13l-4-4"/>
		</svg>`;

	// ── Monaco Editor ─────────────────────────────────────────────────────────

	/** Lazily initialize the Monaco Python editor inside the slotted container. */
	private _initEditor(): void {
		const slotted = this._getEditorContainer();
		if (!slotted) return;

		const ensureMonaco = (window as any).ensureMonaco as (() => Promise<any>) | undefined;
		if (typeof ensureMonaco !== 'function') {
			this._retryInit();
			return;
		}

		ensureMonaco().then((monaco: any) => {
			if (!slotted || !slotted.isConnected) return;

			// If an editor already exists and is attached, skip.
			if (this._editor) {
				try {
					const dom = this._editor.getDomNode();
					if (dom && dom.isConnected && slotted.contains(dom)) return;
					this._editor.dispose();
				} catch { /* ignore */ }
				this._editor = null;
			}

			slotted.style.minHeight = '0';
			slotted.style.minWidth = '0';

			const editor = monaco.editor.create(slotted, {
				value: this.initialCode || '',
				language: 'python',
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
				renderLineHighlight: 'none'
			});

			// Track active editor for global key handlers.
			try {
				editor.onDidFocusEditorText(() => {
					try { (window as any).activeMonacoEditor = editor; } catch { /* ignore */ }
					this._forceWritable(editor);
				});
				editor.onDidFocusEditorWidget(() => {
					try { (window as any).activeMonacoEditor = editor; } catch { /* ignore */ }
					this._forceWritable(editor);
				});
			} catch { /* ignore */ }

			this._editor = editor;

			// Writable guards.
			this._forceWritable(editor);
			try {
				if (typeof (window as any).__kustoEnsureEditorWritableSoon === 'function') {
					(window as any).__kustoEnsureEditorWritableSoon(editor);
				}
			} catch { /* ignore */ }
			try {
				if (typeof (window as any).__kustoInstallWritableGuard === 'function') {
					(window as any).__kustoInstallWritableGuard(editor);
				}
			} catch { /* ignore */ }

			// Mousedown force-writable.
			try {
				slotted.addEventListener('mousedown', () => {
					this._forceWritable(editor);
					try { editor.focus(); } catch { /* ignore */ }
				}, true);
			} catch { /* ignore */ }

			// Auto-resize.
			try {
				if (typeof (window as any).__kustoAttachAutoResizeToContent === 'function') {
					(window as any).__kustoAttachAutoResizeToContent(editor, slotted);
				}
			} catch { /* ignore */ }

			// Persist on content change.
			try {
				editor.onDidChangeModelContent(() => {
					this._schedulePersist();
				});
			} catch { /* ignore */ }

			// Restore persisted height.
			if (this.editorHeightPx && this.editorHeightPx > 0) {
				const wrapper = this.shadowRoot?.getElementById('editor-wrapper');
				if (wrapper) {
					wrapper.style.height = this.editorHeightPx + 'px';
					this._userResized = true;
				}
			}

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
			try { this._initEditor(); } catch { /* ignore */ }
		}, delay);
	}

	private _disposeEditor(): void {
		if (this._editor) {
			try { this._editor.dispose(); } catch { /* ignore */ }
			this._editor = null;
		}
	}

	private _forceWritable(editor: MonacoEditor): void {
		try {
			if (typeof (window as any).__kustoForceEditorWritable === 'function') {
				(window as any).__kustoForceEditorWritable(editor);
			}
		} catch { /* ignore */ }
	}

	/** Get the slotted editor container element from light DOM. */
	private _getEditorContainer(): HTMLElement | null {
		const slot = this.shadowRoot?.querySelector('slot[name="editor"]') as HTMLSlotElement | null;
		if (slot) {
			const assigned = slot.assignedElements();
			if (assigned.length > 0) return assigned[0] as HTMLElement;
		}
		// Fallback: find by ID in the host's children.
		return this.querySelector('.query-editor') as HTMLElement | null;
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	private _run(): void {
		if (!this._editor) return;
		const model = this._editor.getModel();
		const code = model ? model.getValue() : '';
		this._output = 'Running…';
		this._running = true;
		try {
			const vscode = (window as any).vscode;
			if (vscode && typeof vscode.postMessage === 'function') {
				vscode.postMessage({ type: 'executePython', boxId: this.boxId, code });
			}
		} catch {
			this._output = 'Failed to send run request.';
			this._running = false;
		}
	}

	private _requestRemove(): void {
		this.dispatchEvent(new CustomEvent('section-remove', {
			detail: { boxId: this.boxId },
			bubbles: true,
			composed: true
		}));
	}

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

	// ── Fit to contents ───────────────────────────────────────────────────────

	private _fitToContents(): void {
		const wrapper = this.shadowRoot?.getElementById('editor-wrapper');
		if (!wrapper || !this._editor) return;

		const apply = () => {
			if (!this._editor) return;
			let contentHeight = 0;
			try {
				const ch = this._editor.getContentHeight();
				if (ch && Number.isFinite(ch) && ch > 0) contentHeight = ch;
			} catch { /* ignore */ }
			if (!contentHeight) return;

			// Measure non-editor chrome inside wrapper.
			let chrome = 0;
			const editorContainer = this._getEditorContainer();
			for (const child of Array.from(wrapper.children)) {
				if (!child || child === editorContainer) continue;
				try {
					const cs = getComputedStyle(child);
					if (cs.display === 'none') continue;
				} catch { /* ignore */ }
				chrome += child.getBoundingClientRect().height || 0;
			}
			// Also count the slotted editor container's siblings within the wrapper
			try {
				const csw = getComputedStyle(wrapper);
				chrome += (parseFloat(csw.paddingTop || '0') || 0) + (parseFloat(csw.paddingBottom || '0') || 0);
				chrome += (parseFloat(csw.borderTopWidth || '0') || 0) + (parseFloat(csw.borderBottomWidth || '0') || 0);
			} catch { /* ignore */ }

			const desired = Math.max(120, Math.min(20000, Math.ceil(chrome + contentHeight)));
			wrapper.style.height = desired + 'px';
			wrapper.style.minHeight = '0';
			this._userResized = true;
			try { this._editor!.layout(); } catch { /* ignore */ }
		};

		apply();
		setTimeout(apply, 50);
		setTimeout(apply, 150);
		this._schedulePersist();
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
			const nextHeight = Math.max(120, Math.min(900, startHeight + delta));
			wrapper.style.height = nextHeight + 'px';
			try { this._editor?.layout(); } catch { /* ignore */ }
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

	// ── Message handling ──────────────────────────────────────────────────────

	private _onMessage = (e: MessageEvent): void => {
		const msg = e.data;
		if (!msg || typeof msg !== 'object') return;

		if (msg.type === 'pythonResult' && msg.boxId === this.boxId) {
			this._running = false;
			const stdout = String(msg.stdout || '');
			const stderr = String(msg.stderr || '');
			const exitCode = typeof msg.exitCode === 'number' ? msg.exitCode : null;
			let out = '';
			if (stdout.trim()) out += stdout;
			if (stderr.trim()) {
				if (out) out += '\n\n';
				out += stderr;
			}
			if (!out) out = exitCode === 0 ? '' : 'No output.';
			this._output = out;
		}

		if (msg.type === 'pythonError' && msg.boxId === this.boxId) {
			this._running = false;
			this._output = String(msg.error || 'Python execution failed.');
		}
	};

	// ── Persistence ───────────────────────────────────────────────────────────

	private _schedulePersist(): void {
		try {
			const sp = (window as any).schedulePersist;
			if (typeof sp === 'function') sp();
		} catch { /* ignore */ }
	}

	/**
	 * Serialize to the .kqlx JSON format.
	 * Output is identical to the original persistence.js Python section shape.
	 */
	public serialize(): PythonSectionData {
		let code = '';
		if (this._editor) {
			const model = this._editor.getModel();
			code = model ? model.getValue() : '';
		}
		if (!code) {
			// Fallback: check pending code buffer (Monaco may not be ready yet).
			try {
				const pending = (window as any).__kustoPendingPythonCodeByBoxId;
				if (pending && typeof pending[this.boxId] === 'string') {
					code = pending[this.boxId];
				}
			} catch { /* ignore */ }
		}

		const data: PythonSectionData = {
			id: this.boxId,
			type: 'python',
			code,
			output: this._output,
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

		// Only persist heights from explicit user resizes.
		if (!this._userResized) return undefined;

		const inlineHeight = wrapper.style.height?.trim();
		if (!inlineHeight || inlineHeight === 'auto') return undefined;

		const m = inlineHeight.match(/^(\d+)px$/i);
		if (!m) return undefined;

		const px = parseInt(m[1], 10);
		return Number.isFinite(px) ? px : undefined;
	}

	/** Set output text programmatically (e.g. from restore). */
	public setOutput(text: string): void {
		this._output = text;
	}

	/** Get the code from the Monaco editor. */
	public getCode(): string {
		if (this._editor) {
			const model = this._editor.getModel();
			return model ? model.getValue() : '';
		}
		return '';
	}

	/** Set code in the Monaco editor. */
	public setCode(code: string): void {
		if (this._editor) {
			this._editor.setValue(code);
		}
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-python-section': KwPythonSection;
	}
}
