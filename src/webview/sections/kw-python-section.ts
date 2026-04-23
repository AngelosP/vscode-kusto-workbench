import { pState } from '../shared/persistence-state';
import type { SectionElement } from '../shared/dom-helpers';
import { LitElement, html, type PropertyValues } from 'lit';
import { styles } from './kw-python-section.styles.js';
import { sectionGlowStyles } from '../shared/section-glow.styles.js';
import { sashSheet } from '../shared/sash-styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';
import { osStyles } from '../shared/os-styles.js';
import { customElement, property, state } from 'lit/decorators.js';
import '../components/kw-section-shell.js';
import '../components/kw-monaco-toolbar.js';
import type { MonacoToolbarItem } from '../components/kw-monaco-toolbar.js';
import { undoIcon, redoIcon, commentIcon, indentIcon, outdentIcon, runIcon } from '../shared/icon-registry.js';
import { getScrollY, maybeAutoScrollWhileDragging } from '../core/utils.js';
import { schedulePersist } from '../core/persistence.js';
import { __kustoForceEditorWritable, __kustoEnsureEditorWritableSoon, __kustoInstallWritableGuard } from '../monaco/writable.js';
import { __kustoAttachAutoResizeToContent } from '../monaco/resize.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Serialized shape for .kqlx persistence — must match KqlxSectionV1 python variant. */
export interface PythonSectionData {
	id: string;
	type: 'python';
	name: string;
	code: string;
	output: string;
	expanded: boolean;
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
	addCommand(keybinding: number, handler: () => void): void;
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
export class KwPythonSection extends LitElement implements SectionElement {

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

	@state() private _title = '';
	@state() private _expanded = true;
	@state() private _output = '';
	@state() private _running = false;

	private _editor: MonacoEditor | null = null;
	private _initRetryCount = 0;
	private _userResized = false;
	/** Saved editor content across DOM moves (disconnect → reconnect). */
	private _savedCode: string | null = null;

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	override connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener('message', this._onMessage);
		// Re-create editor after a DOM move (reorder). firstUpdated only fires once,
		// so we need to re-init here when reconnecting with saved content.
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

	static override styles = [...osStyles, scrollbarSheet, sashSheet, styles, sectionGlowStyles];

	// ── Render ─────────────────────────────────────────────────────────────────

	/** Ordered toolbar items for the reusable toolbar component. */
	private get _toolbarItems(): MonacoToolbarItem[] {
		return [
			{ type: 'button', label: 'Comment', title: 'Comment/Uncomment (Ctrl+/)', action: () => this._toggleComment(), icon: commentIcon },
			{ type: 'button', label: 'Indent', title: 'Indent (Tab)', action: () => this._indent(), icon: indentIcon },
			{ type: 'button', label: 'Outdent', title: 'Outdent (Shift+Tab)', action: () => this._outdent(), icon: outdentIcon },
			{ type: 'separator' },
			{ type: 'button', label: 'Undo', title: 'Undo (Ctrl+Z)', action: () => this._undo(), icon: undoIcon },
			{ type: 'button', label: 'Redo', title: 'Redo (Ctrl+Y)', action: () => this._redo(), icon: redoIcon },
		];
	}

	override render() {
		return html`
			<div class="section-root">
			<kw-section-shell
				.name=${this._title}
				.expanded=${this._expanded}
				box-id=${this.boxId}
				section-type="python"
				name-placeholder="Python name (optional)"
				@name-change=${this._onShellNameChange}
				@toggle-visibility=${this._toggleVisibility}
				@fit-to-contents=${this._fitToContents}>
				<button slot="header-buttons" class="header-tab run-btn" type="button"
					@click=${this._run} title="Run Python (Ctrl+Enter)"
					aria-label="Run Python"
					?disabled=${this._running}>
					${runIcon}
					<span class="run-label">Run</span>
				</button>
				<div class="editor-wrapper" id="editor-wrapper">
					<kw-monaco-toolbar box-id=${this.boxId} .items=${this._toolbarItems} aria-label="Python editor tools"></kw-monaco-toolbar>
					<slot name="editor"></slot>
					<div class="resizer"
						title="Drag to resize editor\nDouble-click to fit to contents"
						@mousedown=${this._onResizerMouseDown}
						@dblclick=${this._fitToContents}></div>
				</div>
				${this._output ? html`<div class="python-output" aria-label="Python output">${this._output}</div>` : ''}
			</kw-section-shell>
			</div>
		`;
	}

	// ── Monaco Editor ─────────────────────────────────────────────────────────

	/** Lazily initialize the Monaco Python editor inside the slotted container. */
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

			// If an editor already exists and is attached, skip.
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
				language: 'python',
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
				renderLineHighlight: 'none'
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
			try {
				__kustoEnsureEditorWritableSoon(editor);
			} catch (e) { console.error('[kusto]', e); }
			try {
				__kustoInstallWritableGuard(editor);
			} catch (e) { console.error('[kusto]', e); }

			// Mousedown force-writable.
			try {
				slotted.addEventListener('mousedown', () => {
					this._forceWritable(editor);
					try { editor.focus(); } catch (e) { console.error('[kusto]', e); }
				}, true);
			} catch (e) { console.error('[kusto]', e); }

			// Auto-resize.
			try {
				__kustoAttachAutoResizeToContent(editor, slotted);
			} catch (e) { console.error('[kusto]', e); }

			// Persist on content change.
			try {
				editor.onDidChangeModelContent(() => {
					this._schedulePersist();
				});
			} catch (e) { console.error('[kusto]', e); }

			// Ctrl+Enter / Ctrl+Shift+Enter runs the Python code (not the Kusto query).
			try {
				const runPython = () => this._run();
				editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runPython);
				editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, runPython);
			} catch (e) { console.error('[kusto]', e); }

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
			try { this._initEditor(); } catch (e) { console.error('[kusto]', e); }
		}, delay);
	}

	private _disposeEditor(): void {
		if (this._editor) {
			try { this._editor.dispose(); } catch (e) { console.error('[kusto]', e); }
			this._editor = null;
		}
	}

	private _forceWritable(editor: MonacoEditor): void {
		try {
			__kustoForceEditorWritable(editor);
		} catch (e) { console.error('[kusto]', e); }
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
			const vscode = window.vscode;
			if (vscode && typeof vscode.postMessage === 'function') {
				vscode.postMessage({ type: 'executePython', boxId: this.boxId, code });
			}
		} catch {
			this._output = 'Failed to send run request.';
			this._running = false;
		}
	}

	private _onShellNameChange(e: CustomEvent<{ name: string }>): void {
		this._title = e.detail.name;
		this._schedulePersist();
	}

	private _toggleVisibility(): void {
		this._expanded = !this._expanded;
		this.classList.toggle('is-collapsed', !this._expanded);
		if (this._expanded) {
			setTimeout(() => { try { this._editor?.layout(); } catch (e) { console.error('[kusto]', e); } }, 0);
		}
		this._schedulePersist();
	}

	// ── Toolbar actions ──────────────────────────────────────────────────────

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

	private _undo(): void {
		if (!this._editor) return;
		try { (this._editor as any).trigger?.('toolbar', 'undo', null); } catch (e) { console.error('[kusto]', e); }
	}

	private _redo(): void {
		if (!this._editor) return;
		try { (this._editor as any).trigger?.('toolbar', 'redo', null); } catch (e) { console.error('[kusto]', e); }
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
			} catch (e) { console.error('[kusto]', e); }
			if (!contentHeight) return;

			// Measure non-editor chrome inside wrapper.
			let chrome = 0;
			const editorContainer = this._getEditorContainer();
			for (const child of Array.from(wrapper.children)) {
				if (!child || child === editorContainer) continue;
				try {
					const cs = getComputedStyle(child);
					if (cs.display === 'none') continue;
				} catch (e) { console.error('[kusto]', e); }
				chrome += child.getBoundingClientRect().height || 0;
			}
			// Also count the slotted editor container's siblings within the wrapper
			try {
				const csw = getComputedStyle(wrapper);
				chrome += (parseFloat(csw.paddingTop || '0') || 0) + (parseFloat(csw.paddingBottom || '0') || 0);
				chrome += (parseFloat(csw.borderTopWidth || '0') || 0) + (parseFloat(csw.borderBottomWidth || '0') || 0);
			} catch (e) { console.error('[kusto]', e); }

			const desired = Math.max(120, Math.min(20000, Math.ceil(chrome + contentHeight)));
			wrapper.style.height = desired + 'px';
			wrapper.style.minHeight = '0';
			this._userResized = true;
			try { this._editor!.layout(); } catch (e) { console.error('[kusto]', e); }
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

		const startPageY = e.clientY + getScrollY();
		const startHeight = wrapper.getBoundingClientRect().height;

		const onMove = (moveEvent: MouseEvent) => {
			try {
				maybeAutoScrollWhileDragging(moveEvent.clientY);
			} catch (e) { console.error('[kusto]', e); }
			const pageY = moveEvent.clientY + getScrollY();
			const delta = pageY - startPageY;
			const nextHeight = Math.max(120, Math.min(900, startHeight + delta));
			wrapper.style.height = nextHeight + 'px';
			try { this._editor?.layout(); } catch (e) { console.error('[kusto]', e); }
		};

		const onUp = () => {
			document.removeEventListener('mousemove', onMove, true);
			document.removeEventListener('mouseup', onUp, true);
			document.removeEventListener('mouseleave', onUp);
			window.removeEventListener('blur', onUp);
			resizer.classList.remove('is-dragging');
			document.body.style.cursor = prevCursor;
			document.body.style.userSelect = prevSelect;
			this._schedulePersist();
		};

		document.addEventListener('mousemove', onMove, true);
		document.addEventListener('mouseup', onUp, true);
		document.addEventListener('mouseleave', onUp);
		window.addEventListener('blur', onUp);
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
			schedulePersist();
		} catch (e) { console.error('[kusto]', e); }
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
				const pending = pState.pendingPythonCodeByBoxId;
				if (pending && typeof pending[this.boxId] === 'string') {
					code = pending[this.boxId];
				}
			} catch (e) { console.error('[kusto]', e); }
		}

		const data: PythonSectionData = {
			id: this.boxId,
			type: 'python',
			name: this._title,
			code,
			output: this._output,
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

	public setTitle(title: string): void {
		this._title = title;
	}

	public getName(): string {
		return this._title;
	}

	/** Set section name programmatically (used by agent tools). */
	public setName(name: string): void {
		this._title = name;
	}

	public setExpanded(expanded: boolean): void {
		this._expanded = expanded;
		this.classList.toggle('is-collapsed', !expanded);
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-python-section': KwPythonSection;
	}
}
