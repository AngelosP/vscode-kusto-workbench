import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { styles } from './kw-copilot-chat.styles.js';
import { codiconSheet } from '../shared/codicon-styles.js';
import { pushDismissable, removeDismissable } from './dismiss-stack.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Tool definition provided by the extension host. */
export interface CopilotTool {
	name: string;
	label?: string;
	description?: string;
	enabledByDefault?: boolean;
}

/** Represents a single entry visible in the chat panel. */
export interface ChatMessageEntry {
	id: string;
	kind: 'user' | 'assistant' | 'notification' | 'tool' | 'system' | 'query-snapshot' | 'clarifying-question';
	text: string;
	/** For tool entries — the tool name. */
	toolName?: string;
	/** For tool entries — the user-friendly label/result summary. */
	toolLabel?: string;
	/** For tool entries — full JSON or detail text (shown on hover tooltip). */
	detail?: string;
	/** For tool entries — a short preview of the detail text shown in the tooltip label. */
	tooltipLabel?: string;
	/** For tool entries with an insert action (execute_kusto_query). */
	queryText?: string;
	/** Stored result for executed query entries (used for inserting with results). */
	storedResult?: unknown;
	/** For system entries — filePath to open. */
	filePath?: string;
	/** Entry ID from conversation history (for remove-from-history). */
	entryId?: string;
	/** Whether this entry has been error-styled. */
	isError?: boolean;
	/** Whether this entry has been removed from history. */
	removed?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const AUTOSCROLL_THRESHOLD_PX = 40;

/** Render markdown text to sanitized HTML. Falls back to plain text if marked/DOMPurify unavailable. */
function renderMarkdown(text: string): string {
	const w = globalThis as Record<string, unknown>;
	const marked = w['marked'] as { parse?: (src: string) => string } | undefined;
	const DOMPurify = w['DOMPurify'] as { sanitize?: (html: string) => string } | undefined;
	if (!marked?.parse || !DOMPurify?.sanitize) return '';
	try {
		return DOMPurify.sanitize(marked.parse(text));
	} catch {
		return '';
	}
}

const FINAL_TOOL_NAMES = new Set([
	'respond_to_query_performance_optimization_request',
	'respond_to_all_other_queries',
	'ask_user_clarifying_question',
]);

const SVG_TOOLS = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="5.5" x2="14" y2="5.5"/><circle cx="10" cy="5.5" r="2" fill="var(--vscode-editor-background, #1e1e1e)" stroke="currentColor"/><line x1="2" y1="10.5" x2="14" y2="10.5"/><circle cx="6" cy="10.5" r="2" fill="var(--vscode-editor-background, #1e1e1e)" stroke="currentColor"/></svg>';

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<kw-copilot-chat>` — Self-contained Copilot Chat panel.
 *
 * Lives inside a query section as a sibling pane to the Monaco editor.
 * Handles message history, streaming, tool call display, and user input.
 *
 * Communication pattern:
 *   - Dispatches custom events that the parent (kw-query-section / bridge code) 
 *     forwards via vscode.postMessage.
 *   - Public methods are called by the bridge code when incoming messages arrive
 *     from the extension host.
 *
 * @fires copilot-send      - User wants to send a message. detail: { text, modelId, enabledTools }
 * @fires copilot-cancel     - User wants to cancel the running request.
 * @fires copilot-clear      - User clicked the clear button.
 * @fires copilot-close      - User clicked the close button.
 * @fires copilot-view-tool  - User wants to view a tool result. detail: { tool, label, content }
 * @fires copilot-remove-entry - User removed an entry from history. detail: { entryId }
 * @fires copilot-open-preview - User wants to open a file in markdown preview. detail: { filePath }
 * @fires copilot-insert-query - User wants to insert a query+results as a new section. detail: { query, result }
 * @fires copilot-open-agent  - User clicked the "Kusto Workbench custom agent" link.
 */
@customElement('kw-copilot-chat')
export class KwCopilotChat extends LitElement {

	static override styles = [codiconSheet, styles];

	@property({ type: String, attribute: 'box-id' })
	boxId = '';

	// ── Internal reactive state ───────────────────────────────────────────────

	@state() private _messages: ChatMessageEntry[] = [];
	@state() private _running = false;
	@state() private _tools: CopilotTool[] = [];
	@state() private _enabledTools: string[] = [];
	@state() private _userModifiedTools = false;
	@state() private _toolsPanelOpen = false;
	@state() private _inputHeight = 32;

	// ── Private non-reactive fields ───────────────────────────────────────────

	/** Auto-scroll pinned state — true means we follow new messages. */
	private _autoScrollPinned = true;
	/** Counter for generating per-tooltip unique IDs within this instance. */
	private _tooltipSeq = 0;
	/** All tooltip elements appended to document.body (cleaned up on disconnect). */
	private _tooltips: HTMLElement[] = [];
	/** Bound handler for closing tools panel on outside click. */
	private _closeToolsPanelBound = this._onOutsideClickToolsPanel.bind(this);
	/** Stable dismiss callback for dismiss-stack (Escape key). */
	private _dismissToolsPanel = (): void => { this._closeToolsPanel(); };
	/** Bound scroll handler for dismiss-on-scroll. */
	private _closeToolsPanelOnScrollBound = this._closeToolsPanelOnScroll.bind(this);
	/** Scroll position captured when the tools panel opened. */
	private _toolsPanelScrollAtOpen = 0;

	@query('.messages') private _messagesHost!: HTMLDivElement;
	@query('textarea') private _textarea!: HTMLTextAreaElement;

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	override connectedCallback(): void {
		super.connectedCallback();
		// Seed the initial tip message before the first render.
		if (this._messages.length === 0) {
			this._messages = [{
				id: this._nextId(),
				kind: 'notification',
				text: '__TIP__',
			}];
		}
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this._cleanupTooltips();
		this._closeToolsPanel();
	}

	override updated(changed: PropertyValues): void {
		if (changed.has('_messages')) {
			this._autoScrollIfPinned();
		}
	}

	// ── Public API (called from bridge code) ──────────────────────────────────

	/** Append a user, assistant, or notification message. */
	appendMessage(role: 'user' | 'assistant' | 'notification', text: string, detail = ''): void {
		const id = this._nextId();
		this._messages = [...this._messages, {
			id,
			kind: role,
			text: String(text || ''),
			detail: detail || undefined,
		}];
	}

	/** Append the initial tip notification. */
	appendTipMessage(): void {
		this._messages = [...this._messages, {
			id: this._nextId(),
			kind: 'notification',
			text: '__TIP__', // Sentinel — rendered specially.
		}];
	}

	/** Append a tool call response. */
	appendToolResponse(toolName: string, label: string, jsonText: string, entryId: string): void {
		this._messages = [...this._messages, {
			id: this._nextId(),
			kind: 'tool',
			text: label,
			toolName,
			toolLabel: label,
			detail: jsonText,
			tooltipLabel: 'Tool: ' + toolName,
			entryId: entryId || undefined,
		}];
	}

	/** Append an executed query display. */
	appendExecutedQuery(query: string, resultSummary: string, errorMessage: string, entryId: string, result: unknown): void {
		const isError = resultSummary === 'Error' || !!errorMessage;
		this._messages = [...this._messages, {
			id: this._nextId(),
			kind: 'tool',
			text: isError ? 'Query failed to execute' : (resultSummary || ''),
			toolName: 'execute_kusto_query',
			toolLabel: isError ? 'Query failed to execute' : resultSummary,
			detail: query,
			tooltipLabel: 'Query:',
			queryText: query,
			storedResult: result || undefined,
			entryId: entryId || undefined,
			isError,
		}];
	}

	/** Append general-query-rules link. Inserts after the first user message. */
	appendGeneralRulesLink(filePath: string, preview: string, entryId: string): void {
		const entry: ChatMessageEntry = {
			id: this._nextId(),
			kind: 'system',
			text: 'Loaded query writing guidelines',
			toolName: 'General query rules',
			detail: preview || 'Query writing guidelines for the LLM',
			tooltipLabel: 'Preview:',
			filePath: filePath || undefined,
			entryId: entryId || undefined,
		};
		// Insert after the first user message.
		const msgs = [...this._messages];
		const firstUserIdx = msgs.findIndex(m => m.kind === 'user');
		if (firstUserIdx >= 0) {
			msgs.splice(firstUserIdx + 1, 0, entry);
		} else {
			msgs.push(entry);
		}
		this._messages = msgs;
	}

	/** Append a query snapshot (current query sent with user message). */
	appendQuerySnapshot(queryText: string, entryId: string): void {
		if (!queryText) return;
		const previewLen = 80;
		const preview = queryText.length > previewLen
			? queryText.substring(0, previewLen).replace(/\s+/g, ' ') + '\u2026'
			: queryText.replace(/\s+/g, ' ');
		this._messages = [...this._messages, {
			id: this._nextId(),
			kind: 'query-snapshot',
			text: preview,
			detail: queryText,
			tooltipLabel: undefined,
			entryId: entryId || undefined,
		}];
	}

	/** Append a clarifying question from the assistant. */
	appendClarifyingQuestion(question: string, entryId: string): void {
		if (!question) return;
		this._messages = [...this._messages, {
			id: this._nextId(),
			kind: 'clarifying-question',
			text: question,
			entryId: entryId || undefined,
		}];
		// Focus input so user can respond.
		this.updateComplete.then(() => {
			this._textarea?.focus();
		});
	}

	/** Append a devnotes context card. */
	appendDevNotesContext(preview: string, entryId: string): void {
		this._messages = [...this._messages, {
			id: this._nextId(),
			kind: 'system',
			text: 'Loaded file development notes for context',
			toolName: 'Development notes',
			detail: preview || '(no notes)',
			tooltipLabel: 'Notes:',
			entryId: entryId || undefined,
		}];
	}

	/** Append a devnote tool call (save/remove). */
	appendDevNoteToolCall(action: string, detail: string, result: string, entryId: string): void {
		this._messages = [...this._messages, {
			id: this._nextId(),
			kind: 'tool',
			text: result || detail || 'Done',
			toolName: 'update_development_note' + (action === 'remove' ? ' (remove)' : ''),
			detail: detail || undefined,
			tooltipLabel: detail ? undefined : undefined,
			entryId: entryId || undefined,
		}];
	}

	/** Set running state. */
	setRunning(running: boolean, statusText = ''): void {
		this._running = running;
		if (statusText) {
			this.appendMessage('notification', statusText);
		}
	}

	/** Apply model + tools options from the extension host. */
	applyOptions(models: unknown[], selectedModelId: string, tools: CopilotTool[]): void {
		this._tools = Array.isArray(tools) ? tools.filter(t => t && t.name) : [];
		if (!this._userModifiedTools) {
			this._enabledTools = this._getDefaultEnabledTools();
		} else {
			// Keep only tools that still exist.
			const known = new Set(this._tools.map(t => t.name));
			this._enabledTools = this._enabledTools.filter(n => known.has(n));
		}
		// Model dropdown is managed via slot — dispatch event for parent to handle.
		this.dispatchEvent(new CustomEvent('copilot-models', {
			bubbles: true,
			composed: true,
			detail: { models, selectedModelId },
		}));
	}

	/** Clear all messages and reset state. */
	clearConversation(): void {
		this._cleanupTooltips();
		this._tooltipSeq = 0;
		this._autoScrollPinned = true;
		this._userModifiedTools = false;
		this._enabledTools = this._getDefaultEnabledTools();
		this._running = false;
		this._messages = [{
			id: this._nextId(),
			kind: 'notification',
			text: '__TIP__',
		}];
	}

	/** Get the list of enabled tool names for the next message. */
	getEnabledTools(): string[] {
		const known = new Set(this._tools.map(t => t.name));
		return this._enabledTools.filter(n => known.has(n));
	}

	/** Get all current messages (for testing/inspection). */
	getMessages(): readonly ChatMessageEntry[] {
		return this._messages;
	}

	/** Check if chat is currently running. */
	isRunning(): boolean {
		return this._running;
	}

	// ── Render ────────────────────────────────────────────────────────────────

	override render() {
		return html`
			<div class="chat-header">
				<div class="chat-title"><span>CHAT</span></div>
				<div class="chat-header-actions">
					<button type="button" class="icon-btn clear-btn"
						title="Clear conversation history"
						@click=${this._onClear}>
						<span class="codicon codicon-clear-all" aria-hidden="true"></span>
					</button>
					<button type="button" class="icon-btn close-btn"
						title="Close chat"
						@click=${this._onClose}>
						<span class="codicon codicon-close" aria-hidden="true"></span>
					</button>
				</div>
			</div>
			<div class="messages" aria-live="polite" @scroll=${this._onMessagesScroll}>
				${this._messages.map(m => this._renderMessage(m))}
			</div>
			<div class="input-resizer"
				title="Drag to resize input area"
				@mousedown=${this._onInputResizerMouseDown}></div>
			<div class="input-area">
				<textarea
					rows="1"
					style="height:${this._inputHeight}px"
					placeholder="Ask Copilot\u2026"
					spellcheck="true"
					?disabled=${this._running}
					@keydown=${this._onTextareaKeydown}
					@input=${this._onTextareaInput}></textarea>
				<div class="input-bar">
					<div class="input-bar-left">
						<slot name="model-dropdown"></slot>
						<div class="tools-container">
							<button type="button"
								class="tools-btn ${this._toolsPanelOpen ? 'is-active' : ''}"
								title="Tools"
								aria-pressed=${this._toolsPanelOpen ? 'true' : 'false'}
								?disabled=${this._tools.length === 0}
								@click=${this._onToggleToolsPanel}>
								<span aria-hidden="true" .innerHTML=${SVG_TOOLS}></span>
							</button>
							${this._toolsPanelOpen ? this._renderToolsPanel() : nothing}
						</div>
					</div>
					<button type="button"
						class="send-btn ${this._running ? 'is-running' : ''}"
						title=${this._running ? 'Stop (Esc)' : 'Send (Enter)'}
						@click=${this._onSendOrCancel}>
						<span class="icon-send codicon codicon-arrow-up"></span>
						<span class="icon-stop codicon codicon-debug-stop"></span>
					</button>
				</div>
			</div>
		`;
	}

	// ── Message rendering ─────────────────────────────────────────────────────

	private _renderMessage(msg: ChatMessageEntry) {
		switch (msg.kind) {
			case 'user': return this._renderUserMessage(msg);
			case 'assistant': return this._renderAssistantMessage(msg);
			case 'notification': return this._renderNotificationMessage(msg);
			case 'tool': return this._renderToolMessage(msg);
			case 'system': return this._renderSystemMessage(msg);
			case 'query-snapshot': return this._renderQuerySnapshotMessage(msg);
			case 'clarifying-question': return this._renderClarifyingQuestionMessage(msg);
			default: return nothing;
		}
	}

	private _renderUserMessage(msg: ChatMessageEntry) {
		return html`<div class="msg msg-user"
			title=${msg.detail || ''}
			style=${msg.detail ? 'cursor:help;text-decoration:underline dotted' : ''}
		>${msg.text}</div>`;
	}

	private _renderAssistantMessage(msg: ChatMessageEntry) {
		const mdHtml = renderMarkdown(msg.text);
		return html`<div class="msg msg-assistant"
			title=${msg.detail || ''}
			style=${msg.detail ? 'cursor:help;text-decoration:underline dotted' : ''}
		>${mdHtml ? unsafeHTML(mdHtml) : msg.text}</div>`;
	}

	private _renderNotificationMessage(msg: ChatMessageEntry) {
		if (msg.text === '__TIP__') {
			return html`<div class="msg msg-notification">Tip: If the ask is very challenging or broad, use the <a href="#" @click=${this._onOpenAgent}>Kusto Workbench custom agent</a> instead.</div>`;
		}
		return html`<div class="msg msg-notification">${msg.text}</div>`;
	}

	private _renderToolMessage(msg: ChatMessageEntry) {
		const isExecuteQuery = msg.toolName === 'execute_kusto_query';
		const isDevNote = msg.toolName?.startsWith('update_development_note');
		return html`
			<div class="msg msg-tool ${msg.isError ? 'is-error' : ''} ${msg.removed ? 'is-removed' : ''}"
				data-entry-id=${msg.entryId || ''}
				@mouseenter=${(e: MouseEvent) => this._showTooltip(e, msg)}
				@mousemove=${(e: MouseEvent) => this._showTooltip(e, msg)}
				@mouseleave=${() => this._hideTooltip()}>
				<div class="tool-header">
					<div class="tool-header-left">
						${isDevNote
							? html`<span class="tool-icon codicon codicon-notebook" aria-hidden="true"></span>`
							: html`<span class="tool-icon" aria-hidden="true" .innerHTML=${SVG_TOOLS}></span>`}
						<strong>${msg.toolName || 'tool'}</strong>
					</div>
					<div class="tool-header-right">
						${isExecuteQuery ? html`
							<button type="button" class="tool-icon-btn"
								title="Insert as new query section so you can inspect the query and results"
								@click=${(e: Event) => { e.preventDefault(); this._onInsertQuery(msg); }}>
								<span class="codicon codicon-insert"></span>
							</button>
						` : nothing}
						${!isExecuteQuery && !isDevNote && msg.detail ? html`
						<button type="button" class="tool-icon-btn"
							title="View what the tool returned"
							@click=${(e: Event) => { e.preventDefault(); this._onViewTool(msg); }}>
							<span class="codicon codicon-link-external"></span>
							</button>
						` : nothing}
						${msg.entryId && !msg.removed ? html`
							<button type="button" class="tool-icon-btn remove-btn"
								title="Remove from conversation history"
								@click=${(e: Event) => { e.preventDefault(); this._onRemoveEntry(msg); }}>
								<span class="codicon codicon-trash"></span>
							</button>
						` : nothing}
					</div>
				</div>
				<div class="tool-result ${msg.isError ? 'is-error' : ''}">${msg.text}</div>
			</div>
		`;
	}

	private _renderSystemMessage(msg: ChatMessageEntry) {
		const isDevNotes = msg.toolName === 'Development notes';
		const iconClass = isDevNotes ? 'codicon-notebook' : 'codicon-book';
		return html`
			<div class="msg msg-system ${msg.removed ? 'is-removed' : ''}"
				data-entry-id=${msg.entryId || ''}
				@mouseenter=${(e: MouseEvent) => this._showTooltip(e, msg)}
				@mousemove=${(e: MouseEvent) => this._showTooltip(e, msg)}
				@mouseleave=${() => this._hideTooltip()}>
				<div class="tool-header">
					<div class="tool-header-left">
						<span class="tool-icon codicon ${iconClass}" aria-hidden="true"></span>
						<strong>${msg.toolName || ''}</strong>
					</div>
					<div class="tool-header-right">
						${msg.filePath ? html`
							<button type="button" class="tool-icon-btn"
								title="View in new tab"
								@click=${(e: Event) => { e.preventDefault(); this._onOpenPreview(msg); }}>
								<span class="codicon codicon-link-external"></span>
							</button>
						` : nothing}
						${!msg.filePath && msg.detail ? html`
							<button type="button" class="tool-icon-btn"
								title="View content"
								@click=${(e: Event) => { e.preventDefault(); this._onViewTool(msg); }}>
								<span class="codicon codicon-link-external"></span>
							</button>
						` : nothing}
						${msg.entryId && !msg.removed ? html`
							<button type="button" class="tool-icon-btn remove-btn"
								title="Remove from conversation history"
								@click=${(e: Event) => { e.preventDefault(); this._onRemoveEntry(msg); }}>
								<span class="codicon codicon-trash"></span>
							</button>
						` : nothing}
					</div>
				</div>
				<div class="tool-result">${msg.text}</div>
			</div>
		`;
	}

	private _renderQuerySnapshotMessage(msg: ChatMessageEntry) {
		return html`
			<div class="msg msg-query-snapshot ${msg.removed ? 'is-removed' : ''}"
				data-entry-id=${msg.entryId || ''}
				@mouseenter=${(e: MouseEvent) => this._showTooltip(e, msg)}
				@mousemove=${(e: MouseEvent) => this._showTooltip(e, msg)}
				@mouseleave=${() => this._hideTooltip()}>
				<div class="tool-header">
					<div class="tool-header-left">
						<span class="tool-icon codicon codicon-code" aria-hidden="true"></span>
						<strong>Existing query</strong>
					</div>
					<div class="tool-header-right">
						<button type="button" class="tool-icon-btn"
							title=${msg.detail || ''}
							@click=${(e: Event) => { e.preventDefault(); this._onViewTool({ ...msg, toolName: 'Existing query', toolLabel: 'Query snapshot' }); }}>
						<span class="codicon codicon-link-external"></span>
						</button>
						${msg.entryId && !msg.removed ? html`
							<button type="button" class="tool-icon-btn remove-btn"
								title="Remove from conversation history"
								@click=${(e: Event) => { e.preventDefault(); this._onRemoveEntry(msg); }}>
								<span class="codicon codicon-trash"></span>
							</button>
						` : nothing}
					</div>
				</div>
				<div class="tool-result">${msg.text}</div>
			</div>
		`;
	}

	private _renderClarifyingQuestionMessage(msg: ChatMessageEntry) {
		return html`
			<div class="msg msg-clarifying-question ${msg.removed ? 'is-removed' : ''}"
				data-entry-id=${msg.entryId || ''}>
				<div class="tool-header">
					<div class="tool-header-left">
						<span class="tool-icon codicon codicon-comment" aria-hidden="true"></span>
						<strong>Clarifying question</strong>
					</div>
					<div class="tool-header-right">
						${msg.entryId && !msg.removed ? html`
							<button type="button" class="tool-icon-btn remove-btn"
								title="Remove from conversation history"
								@click=${(e: Event) => { e.preventDefault(); this._onRemoveEntry(msg); }}>
								<span class="codicon codicon-trash"></span>
							</button>
						` : nothing}
					</div>
				</div>
				<div class="clarifying-question-text">${(() => { const h = renderMarkdown(msg.text); return h ? unsafeHTML(h) : msg.text; })()}</div>
			</div>
		`;
	}

	// ── Tools panel ───────────────────────────────────────────────────────────

	private _renderToolsPanel() {
		const finalTools = this._tools.filter(t => FINAL_TOOL_NAMES.has(t.name));
		const optionalTools = this._tools.filter(t => !FINAL_TOOL_NAMES.has(t.name));
		const enabledSet = new Set(this._enabledTools);

		return html`
			<div class="tools-panel"
				@mousedown=${(e: Event) => e.stopPropagation()}
				@click=${(e: Event) => e.stopPropagation()}>
				<div class="tools-panel-title">Tools (next message)</div>
				<div class="tools-list">
					${finalTools.length ? html`
						<div class="tools-group-title is-first">Final step</div>
						${finalTools.map(t => this._renderToolItem(t, enabledSet))}
					` : nothing}
					${optionalTools.length ? html`
						<div class="tools-group-title ${!finalTools.length ? 'is-first' : ''}">Optional tools</div>
						${optionalTools.map(t => this._renderToolItem(t, enabledSet))}
					` : nothing}
				</div>
			</div>
		`;
	}

	private _renderToolItem(tool: CopilotTool, enabledSet: Set<string>) {
		const label = tool.label || tool.name;
		return html`
			<label class="tool-item">
				<input type="checkbox" class="tool-checkbox"
					.checked=${enabledSet.has(tool.name)}
					@change=${(e: Event) => this._onToolToggle(tool.name, (e.target as HTMLInputElement).checked)} />
				<span class="tool-text">
					<span class="tool-name">${label}</span>
					${tool.description ? html`<span class="tool-desc">${tool.description}</span>` : nothing}
				</span>
			</label>
		`;
	}

	// ── Tooltip management ────────────────────────────────────────────────────

	private _currentTooltip: HTMLElement | null = null;
	private _hideTimeout: ReturnType<typeof setTimeout> | null = null;

	private _showTooltip(e: MouseEvent, msg: ChatMessageEntry): void {
		if (!msg.detail) return;
		const wrapper = e.currentTarget as HTMLElement;
		const TOOLTIP_WIDTH = 350;
		const TOOLTIP_GAP = 8;

		// Reuse or create tooltip element.
		let tooltip = this._currentTooltip;
		if (!tooltip || tooltip.dataset.msgId !== msg.id) {
			this._hideTooltipImmediate();
			tooltip = document.createElement('div');
			tooltip.className = 'kusto-copilot-tool-tooltip';
			tooltip.dataset.msgId = msg.id;
			tooltip.style.cssText = 'position:fixed;background:var(--vscode-editorHoverWidget-background,#252526);border:1px solid var(--vscode-editorHoverWidget-border,#454545);padding:8px 10px;border-radius:4px;font-size:11px;width:350px;max-height:300px;overflow:auto;z-index:10000;box-shadow:0 2px 8px rgba(0,0,0,0.3);white-space:pre-wrap;word-break:break-word;pointer-events:auto;';

			if (msg.tooltipLabel) {
				const label = document.createElement('div');
				label.style.cssText = 'font-weight:600;color:var(--vscode-charts-blue,#4fc1ff);margin-bottom:4px;';
				label.textContent = msg.tooltipLabel;
				tooltip.appendChild(label);
			}
			const content = document.createElement('div');
			content.style.cssText = 'color:var(--vscode-foreground);font-family:var(--vscode-editor-font-family,monospace);';
			content.textContent = msg.detail;
			tooltip.appendChild(content);

			// Additional error info for executed queries.
			if (msg.isError && msg.toolName === 'execute_kusto_query' && msg.text) {
				const errLabel = document.createElement('div');
				errLabel.style.cssText = 'font-weight:600;color:var(--vscode-charts-blue,#4fc1ff);margin-top:8px;margin-bottom:4px;';
				errLabel.textContent = 'Error:';
				tooltip.appendChild(errLabel);
				const errContent = document.createElement('div');
				errContent.style.cssText = 'color:var(--vscode-inputValidation-errorForeground,#f48771);font-family:var(--vscode-editor-font-family,monospace);';
				errContent.textContent = msg.text;
				tooltip.appendChild(errContent);
			}

			tooltip.addEventListener('mouseenter', () => this._cancelHideTooltip());
			tooltip.addEventListener('mouseleave', () => this._scheduleHideTooltip());

			document.body.appendChild(tooltip);
			this._tooltips.push(tooltip);
			this._currentTooltip = tooltip;
		}

		this._cancelHideTooltip();

		// Position tooltip.
		const rect = wrapper.getBoundingClientRect();
		const vpW = window.innerWidth || document.documentElement.clientWidth;
		const vpH = window.innerHeight || document.documentElement.clientHeight;

		if (rect.right + TOOLTIP_GAP + TOOLTIP_WIDTH > vpW) {
			tooltip.style.left = Math.max(0, rect.left - TOOLTIP_GAP - TOOLTIP_WIDTH) + 'px';
		} else {
			tooltip.style.left = (rect.right + TOOLTIP_GAP) + 'px';
		}
		const tooltipMaxH = 300;
		if (rect.top + tooltipMaxH > vpH) {
			tooltip.style.top = Math.max(0, vpH - tooltipMaxH - 8) + 'px';
		} else {
			tooltip.style.top = rect.top + 'px';
		}
		tooltip.style.display = 'block';
	}

	private _hideTooltip(): void {
		this._scheduleHideTooltip();
	}

	private _scheduleHideTooltip(): void {
		this._hideTimeout = setTimeout(() => {
			this._hideTooltipImmediate();
		}, 300);
	}

	private _cancelHideTooltip(): void {
		if (this._hideTimeout) {
			clearTimeout(this._hideTimeout);
			this._hideTimeout = null;
		}
	}

	private _hideTooltipImmediate(): void {
		this._cancelHideTooltip();
		if (this._currentTooltip) {
			this._currentTooltip.style.display = 'none';
			this._currentTooltip = null;
		}
	}

	private _cleanupTooltips(): void {
		this._hideTooltipImmediate();
		for (const tt of this._tooltips) {
			tt.remove();
		}
		this._tooltips = [];
	}

	// ── Auto-scroll ───────────────────────────────────────────────────────────

	private _onMessagesScroll(): void {
		const host = this._messagesHost;
		if (!host) return;
		this._autoScrollPinned = host.scrollHeight - host.scrollTop - host.clientHeight <= AUTOSCROLL_THRESHOLD_PX;
	}

	private _autoScrollIfPinned(): void {
		if (!this._autoScrollPinned) return;
		this.updateComplete.then(() => {
			const host = this._messagesHost;
			if (host) {
				host.scrollTop = host.scrollHeight;
			}
		});
	}

	// ── Event handlers ────────────────────────────────────────────────────────

	private _onClear(): void {
		this.dispatchEvent(new CustomEvent('copilot-clear', { bubbles: true, composed: true }));
	}

	private _onClose(): void {
		this.dispatchEvent(new CustomEvent('copilot-close', { bubbles: true, composed: true }));
	}

	private _onSendOrCancel(): void {
		if (this._running) {
			this.dispatchEvent(new CustomEvent('copilot-cancel', { bubbles: true, composed: true }));
			return;
		}
		this._doSend();
	}

	private _doSend(): void {
		const textarea = this._textarea;
		if (!textarea) return;
		const text = textarea.value.trim();
		if (!text) {
			this.appendMessage('notification', 'Type what you want the query to do, then press Send.');
			return;
		}
		this.appendMessage('user', text);
		textarea.value = '';
		this._inputHeight = 32;
		this.dispatchEvent(new CustomEvent('copilot-send', {
			bubbles: true,
			composed: true,
			detail: { text, enabledTools: this.getEnabledTools() },
		}));
	}

	private _onTextareaKeydown(e: KeyboardEvent): void {
		if (e.key === 'Enter' && e.ctrlKey) {
			e.preventDefault();
			const ta = this._textarea;
			if (ta) {
				const start = ta.selectionStart;
				const end = ta.selectionEnd;
				ta.value = ta.value.substring(0, start) + '\n' + ta.value.substring(end);
				ta.selectionStart = ta.selectionEnd = start + 1;
				this._autoGrowTextarea();
			}
			return;
		}
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			this._onSendOrCancel();
		}
		if (e.key === 'Escape' && this._running) {
			e.preventDefault();
			this.dispatchEvent(new CustomEvent('copilot-cancel', { bubbles: true, composed: true }));
		}
	}

	private _onTextareaInput(): void {
		this._autoGrowTextarea();
	}

	private _autoGrowTextarea(): void {
		const ta = this._textarea;
		if (!ta) return;
		ta.style.height = 'auto';
		const minH = 32;
		const maxH = 400;
		this._inputHeight = Math.max(minH, Math.min(maxH, ta.scrollHeight + 4));
		ta.style.height = this._inputHeight + 'px';
	}

	private _onInputResizerMouseDown(e: MouseEvent): void {
		e.preventDefault();
		e.stopPropagation();
		const resizer = e.currentTarget as HTMLElement;
		resizer.classList.add('is-dragging');
		const prevCursor = document.body.style.cursor;
		const prevUserSelect = document.body.style.userSelect;
		document.body.style.cursor = 'ns-resize';
		document.body.style.userSelect = 'none';
		const startY = e.clientY;
		const startH = this._inputHeight;

		const onMove = (moveEvt: MouseEvent) => {
			const delta = startY - moveEvt.clientY;
			this._inputHeight = Math.max(32, Math.min(400, startH + delta));
			const ta = this._textarea;
			if (ta) ta.style.height = this._inputHeight + 'px';
		};
		const onUp = () => {
			document.removeEventListener('mousemove', onMove, true);
			document.removeEventListener('mouseup', onUp, true);
			resizer.classList.remove('is-dragging');
			document.body.style.cursor = prevCursor;
			document.body.style.userSelect = prevUserSelect;
		};
		document.addEventListener('mousemove', onMove, true);
		document.addEventListener('mouseup', onUp, true);
	}

	// ── Tools panel ───────────────────────────────────────────────────────────

	private _onToggleToolsPanel(e: Event): void {
		e.stopPropagation();
		if (this._toolsPanelOpen) {
			this._closeToolsPanel();
			return;
		}
		this._toolsPanelOpen = true;

		// Position after render.
		this.updateComplete.then(() => {
			const btn = (e.currentTarget || e.target) as HTMLElement;
			const panel = this.shadowRoot?.querySelector('.tools-panel') as HTMLElement;
			if (!btn || !panel) return;
			const btnRect = btn.getBoundingClientRect();
			panel.style.left = '0px';
			panel.style.top = '0px';
			panel.style.bottom = 'auto';
			const panelRect = panel.getBoundingClientRect();
			const ph = panelRect.height;
			const pw = panelRect.width;
			const gap = 4;
			let top = btnRect.top - ph - gap;
			let left = btnRect.left;
			if (top < 0) top = btnRect.bottom + gap;
			const vpW = document.documentElement.clientWidth || window.innerWidth;
			if (left + pw > vpW) left = Math.max(0, vpW - pw - 4);
			panel.style.top = top + 'px';
			panel.style.left = left + 'px';
		});
		setTimeout(() => document.addEventListener('mousedown', this._closeToolsPanelBound, true), 0);
		pushDismissable(this._dismissToolsPanel);
		this._toolsPanelScrollAtOpen = document.documentElement.scrollTop;
		document.addEventListener('scroll', this._closeToolsPanelOnScrollBound, { capture: true, passive: true });
	}

	/** Close the tools panel and remove all listeners. */
	private _closeToolsPanel(): void {
		if (!this._toolsPanelOpen) return;
		this._toolsPanelOpen = false;
		document.removeEventListener('mousedown', this._closeToolsPanelBound, true);
		document.removeEventListener('scroll', this._closeToolsPanelOnScrollBound, true);
		removeDismissable(this._dismissToolsPanel);
	}

	private _onOutsideClickToolsPanel(e: Event): void {
		const panel = this.shadowRoot?.querySelector('.tools-panel');
		const btn = this.shadowRoot?.querySelector('.tools-btn');
		if (panel?.contains(e.target as Node) || btn?.contains(e.target as Node)) return;
		this._closeToolsPanel();
	}

	private _closeToolsPanelOnScroll(): void {
		if (Math.abs(document.documentElement.scrollTop - this._toolsPanelScrollAtOpen) > 20) {
			this._closeToolsPanel();
		}
	}

	private _onToolToggle(name: string, checked: boolean): void {
		this._userModifiedTools = true;
		const arr = [...this._enabledTools];
		const idx = arr.indexOf(name);
		if (checked && idx < 0) arr.push(name);
		if (!checked && idx >= 0) arr.splice(idx, 1);
		this._enabledTools = arr;
	}

	// ── Message action handlers ───────────────────────────────────────────────

	private _onViewTool(msg: ChatMessageEntry): void {
		this.dispatchEvent(new CustomEvent('copilot-view-tool', {
			bubbles: true,
			composed: true,
			detail: {
				tool: msg.toolName || 'tool',
				label: msg.toolLabel || msg.toolName || '',
				content: msg.detail || '',
			},
		}));
	}

	private _onOpenPreview(msg: ChatMessageEntry): void {
		if (msg.filePath) {
			this.dispatchEvent(new CustomEvent('copilot-open-preview', {
				bubbles: true,
				composed: true,
				detail: { filePath: msg.filePath },
			}));
		}
	}

	private _onInsertQuery(msg: ChatMessageEntry): void {
		this.dispatchEvent(new CustomEvent('copilot-insert-query', {
			bubbles: true,
			composed: true,
			detail: {
				query: msg.queryText || msg.detail || '',
				result: msg.storedResult || null,
			},
		}));
	}

	private _onRemoveEntry(msg: ChatMessageEntry): void {
		if (!msg.entryId) return;
		// Mark as removed in the local state.
		this._messages = this._messages.map(m =>
			m.id === msg.id ? { ...m, removed: true } : m
		);
		this.dispatchEvent(new CustomEvent('copilot-remove-entry', {
			bubbles: true,
			composed: true,
			detail: { entryId: msg.entryId },
		}));
	}

	private _onOpenAgent(e: Event): void {
		e.preventDefault();
		this.dispatchEvent(new CustomEvent('copilot-open-agent', {
			bubbles: true,
			composed: true,
		}));
	}

	// ── Utilities ─────────────────────────────────────────────────────────────

	private _nextId(): string {
		return 'cm_' + (++this._tooltipSeq);
	}

	private _getDefaultEnabledTools(): string[] {
		return this._tools
			.filter(t => typeof t.enabledByDefault === 'boolean' ? t.enabledByDefault : true)
			.map(t => t.name);
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-copilot-chat': KwCopilotChat;
	}
}
