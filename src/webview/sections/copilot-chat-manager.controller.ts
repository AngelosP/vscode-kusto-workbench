// Copilot chat management — ReactiveController pattern.
// Extracted from kw-query-section.ts into a Lit ReactiveController
// that manages the Copilot chat panel within a query section.
// Parameterized with WebviewCopilotFlavor to support both Kusto and SQL.
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type { KwCopilotChat } from '../components/kw-copilot-chat.js';
import { pState } from '../shared/persistence-state';
import { postMessageToHost } from '../shared/webview-messages';
import { schedulePersist } from '../core/persistence';
import { displayResultForBox } from '../core/results-state.js';
import { syncSelectBackedDropdown, renderMenuDropdownHtml } from '../core/dropdown.js';
import {
	addQueryBox,
	addSqlBox,
	__kustoSetSectionName,
} from '../core/section-factory.js';
import { __kustoGetLastOptimizeModelId, __kustoSetLastOptimizeModelId } from './query-execution.controller.js';
import { __kustoPrettifyKustoTextWithSemicolonStatements } from '../monaco/prettify.js';
import type { WebviewCopilotFlavor } from './copilot-chat-flavor.js';

// ── Host interface (avoids circular import with kw-query-section.ts) ──────────

/** Minimal interface the controller needs from its host element. */
export interface CopilotChatManagerHost extends ReactiveControllerHost, HTMLElement {
	boxId: string;
	/** Connection identifier (Kusto connectionId or SQL sqlConnectionId). */
	getCopilotConnectionId(): string;
	/** Server URL (Kusto clusterUrl or SQL serverUrl). */
	getCopilotServerUrl(): string;
	getDatabase(): string;
	/** Set query text in the section's editor. */
	setCopilotQueryText(text: string): void;
	/** Get the current query text from the section's editor. */
	getCopilotEditorValue(): string;
	/** Re-layout the section's editor (after resize). */
	layoutCopilotEditor(): void;
	/** Focus the section's editor (e.g. after closing the Copilot chat). */
	focusCopilotEditor(): void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_CHAT_WIDTH_PX = 500;
const MIN_CHAT_WIDTH_PX = 160;
const MIN_EDITOR_WIDTH_PX = 240;

// ── Helpers (module-level) ────────────────────────────────────────────────────

function clampNumber(value: any, min: any, max: any): number {
	const n = typeof value === 'number' ? value : parseInt(String(value || ''), 10);
	if (!Number.isFinite(n)) return min;
	if (typeof max === 'number' && Number.isFinite(max)) {
		return Math.max(min, Math.min(max, n));
	}
	return Math.max(min, n);
}

function setQueryText(boxId: string, queryText: string): void {
	try {
		const editor = window.queryEditors?.[boxId];
		if (!editor) return;
		const model = editor.getModel?.();
		if (!model) return;
		let next = String(queryText || '');
		try { next = __kustoPrettifyKustoTextWithSemicolonStatements(next); } catch (e) { console.error('[kusto]', e); }
		editor.executeEdits('copilot', [{ range: model.getFullModelRange(), text: next }]);
		editor.focus();
		try { schedulePersist('copilotWriteQuery'); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

function applyModelOptions(boxId: string, models: any, selectedModelId: any): void {
	try {
		const sel = document.getElementById(boxId + '_copilot_model') as HTMLSelectElement | null;
		if (!sel) return;
		sel.innerHTML = '';
		const ph = document.createElement('option');
		ph.value = ''; ph.textContent = 'Select model...'; ph.disabled = true; ph.selected = true;
		sel.appendChild(ph);
		for (const m of (Array.isArray(models) ? models : []) as any[]) {
			if (!m?.id) continue;
			const opt = document.createElement('option');
			opt.value = String(m.id);
			const label = String(m.label || m.id);
			const id = String(m.id);
			opt.textContent = (label && label !== id) ? label + ' (' + id + ')' : id;
			opt.setAttribute('data-short-label', label);
			sel.appendChild(opt);
		}
		let preferred = '';
		try { preferred = String(__kustoGetLastOptimizeModelId() || ''); } catch (e) { console.error('[kusto]', e); }
		const hasPreferred = preferred && Array.from(sel.options).some((o: any) => o.value === preferred);
		if (hasPreferred) sel.value = preferred;
		else if (selectedModelId) sel.value = String(selectedModelId);
		if (!sel.value && sel.options.length > 0) sel.selectedIndex = 0;
		sel.onchange = () => {
			try { __kustoSetLastOptimizeModelId(sel.value); } catch (e) { console.error('[kusto]', e); }
			try { syncSelectBackedDropdown(boxId + '_copilot_model'); } catch (e) { console.error('[kusto]', e); }
		};
		try { syncSelectBackedDropdown(boxId + '_copilot_model'); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

function modelDropdownHtml(boxId: string): string {
	try {
		const modelIconSvg = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3.18 8l1.83-.55L5.56 5.6a.3.3 0 0 1 .57 0l.55 1.85L8.5 8a.3.3 0 0 1 0 .57l-1.83.55-.55 1.84a.3.3 0 0 1-.57 0l-.55-1.84L3.18 8.57a.3.3 0 0 1 0-.57ZM9.14 3l1.16-.35.35-1.17a.19.19 0 0 1 .37 0l.35 1.17L12.53 3a.19.19 0 0 1 0 .36l-1.16.35-.35 1.17a.19.19 0 0 1-.37 0l-.35-1.17L9.14 3.36a.19.19 0 0 1 0-.36ZM9.14 11l1.16-.35.35-1.17a.19.19 0 0 1 .37 0l.35 1.17 1.16.35a.19.19 0 0 1 0 .36l-1.16.35-.35 1.17a.19.19 0 0 1-.37 0l-.35-1.17-1.16-.35a.19.19 0 0 1 0-.36Z"/></svg>';
		return renderMenuDropdownHtml({
				wrapperClass: 'kusto-copilot-chat-model-dropdown kusto-dropdown-tooltip-label',
				title: '', iconSvg: modelIconSvg, includeHiddenSelect: true,
				selectId: boxId + '_copilot_model',
				onChange: "try{if(typeof __kustoSetLastOptimizeModelId==='function'){__kustoSetLastOptimizeModelId(this.value)}}catch{}",
				buttonId: boxId + '_copilot_model_btn', buttonTextId: boxId + '_copilot_model_btn_text',
				menuId: boxId + '_copilot_model_menu', placeholder: 'Select model...',
				onToggle: "try{window.__kustoDropdown&&window.__kustoDropdown.toggleSelectMenu&&window.__kustoDropdown.toggleSelectMenu('" + boxId + "_copilot_model')}catch{}"
		});
	} catch (e) { console.error('[kusto]', e); }
	return '<div class="select-wrapper"><select id="' + boxId + '_copilot_model" aria-label="Copilot model"></select></div>';
}

// ── ReactiveController ────────────────────────────────────────────────────────

/**
 * Manages the Copilot chat panel for a query or SQL section element:
 * installation, visibility, resize, event wiring, and message delegation.
 * Parameterized with WebviewCopilotFlavor to support both Kusto and SQL.
 */
export class CopilotChatManagerController implements ReactiveController {
	host: CopilotChatManagerHost;
	readonly flavor: WebviewCopilotFlavor;

	private _copilotChatVisible = false;
	private _copilotChatWidthPx: number | undefined;
	private _copilotSplitObserver: ResizeObserver | null = null;

	constructor(host: CopilotChatManagerHost, flavor: WebviewCopilotFlavor) {
		this.host = host;
		this.flavor = flavor;
		host.addController(this);
	}

	hostConnected(): void {
		// Lifecycle hook — no setup needed currently.
	}

	hostDisconnected(): void {
		// Do NOT disconnect _copilotSplitObserver here — it must survive
		// disconnect/reconnect during section reorder. Only disposeCopilotChat()
		// cleans it up.
	}

	// ── Element lookup ────────────────────────────────────────────────────────

	/** Find the <kw-copilot-chat> Lit element for this section. */
	getCopilotChatEl(): KwCopilotChat | null {
		const pane = document.getElementById(this.host.boxId + this.flavor.domIdInfix + '_copilot_chat_pane');
		return (pane?.querySelector('kw-copilot-chat') as KwCopilotChat | null) ?? null;
	}

	// ── Visibility & sizing ───────────────────────────────────────────────────

	getCopilotChatVisible(): boolean {
		return this._copilotChatVisible;
	}

	getCopilotChatWidthPx(): number | undefined {
		if (typeof this._copilotChatWidthPx === 'number' && Number.isFinite(this._copilotChatWidthPx)) {
			return this._copilotChatWidthPx;
		}
		try {
			const pane = document.getElementById(this.host.boxId + this.flavor.domIdInfix + '_copilot_chat_pane');
			if (!pane) return undefined;
			const w = Math.round(pane.getBoundingClientRect().width || 0);
			return w > 0 ? w : undefined;
		} catch { return undefined; }
	}

	setCopilotChatWidthPx(widthPx: number): void {
		const id = this.host.boxId;
		if (!id) return;
		let max: number | undefined;
		try {
			const split = document.getElementById(id + this.flavor.domIdInfix + '_copilot_split');
			if (split) {
				const total = Math.round(split.getBoundingClientRect().width || 0);
				if (total > 0) max = Math.max(MIN_CHAT_WIDTH_PX, total - MIN_EDITOR_WIDTH_PX);
			}
		} catch (e) { console.error('[kusto]', e); }
		const next = clampNumber(widthPx, MIN_CHAT_WIDTH_PX, max);
		try {
			const pane = document.getElementById(id + this.flavor.domIdInfix + '_copilot_chat_pane');
			if (pane?.style) pane.style.flex = '0 1 ' + next + 'px';
		} catch (e) { console.error('[kusto]', e); }
		this._copilotChatWidthPx = next;
		try { this.host.layoutCopilotEditor(); } catch (e) { console.error('[kusto]', e); }
	}

	setCopilotChatVisible(visible: boolean): void {
		const id = this.host.boxId;
		if (!id) return;
		const next = !!visible;
		const wasVisible = this._copilotChatVisible;
		this._copilotChatVisible = next;
		if (next) { try { this.installCopilotChat(); } catch (e) { console.error('[kusto]', e); } }
		try {
			const split = document.getElementById(id + this.flavor.domIdInfix + '_copilot_split');
			if (split?.classList) split.classList.toggle(this.flavor.hiddenClass, !next);
		} catch (e) { console.error('[kusto]', e); }
		if (next) {
			try {
				const editorWrapper = this.host.querySelector?.('.query-editor-wrapper') as HTMLElement | null;
				if (editorWrapper) {
					const currentHeight = editorWrapper.getBoundingClientRect().height;
					if (currentHeight < 180) {
						editorWrapper.style.height = '180px';
						try {
							pState.manualQueryEditorHeightPxByBoxId[id] = 180;
						} catch (e) { console.error('[kusto]', e); }
					}
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		this._setCopilotToggleButtonState(next);
		try { this.host.layoutCopilotEditor(); } catch (e) { console.error('[kusto]', e); }
		try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		// Focus management: focus chat input on open, editor on close.
		if (next && !wasVisible) {
			try { this.getCopilotChatEl()?.focusInput(); } catch (e) { console.error('[kusto]', e); }
		} else if (!next && wasVisible) {
			try { this.host.focusCopilotEditor(); } catch (e) { console.error('[kusto]', e); }
		}
	}

	toggleCopilotChat(): void {
		const id = this.host.boxId;
		if (!id) return;
		if (!pState.copilotChatFirstTimeDismissed) {
			try { postMessageToHost({ type: 'copilotChatFirstTimeCheck', boxId: id }); } catch (e) { console.error('[kusto]', e); }
			return;
		}
		this.setCopilotChatVisible(!this._copilotChatVisible);
	}

	disposeCopilotChat(): void {
		const id = this.host.boxId;
		if (!id) return;
		try { postMessageToHost({ type: 'cancelCopilotWriteQuery', boxId: id }); } catch (e) { console.error('[kusto]', e); }
		if (this._copilotSplitObserver) {
			this._copilotSplitObserver.disconnect();
			this._copilotSplitObserver = null;
		}
	}

	installCopilotChat(): void {
		const boxId = this.host.boxId;
		const infix = this.flavor.domIdInfix;
		const cssPrefix = this.flavor.cssClassPrefix;
		try {
			const editorWrapper = this.host.querySelector?.('.query-editor-wrapper') as HTMLElement | null;
			if (!editorWrapper) return;
			if (document.getElementById(boxId + infix + '_copilot_chat_pane')) return;

			const existingChildren = Array.from(editorWrapper.childNodes || []);
			const split = document.createElement('div');
			split.className = cssPrefix + '-copilot-split';
			split.id = boxId + infix + '_copilot_split';
			split.style.flex = '1 1 auto';
			split.style.minHeight = '0';

			const splitter = document.createElement('div');
			splitter.className = 'resizer-v query-editor-resizer ' + cssPrefix + '-copilot-splitter';
			splitter.id = boxId + infix + '_copilot_splitter';
			splitter.title = 'Drag to resize Copilot chat';
			splitter.setAttribute('aria-label', 'Resize Copilot chat');
			splitter.setAttribute('data-kusto-no-editor-focus', 'true');

			const editorPane = document.createElement('div');
			editorPane.className = cssPrefix + '-copilot-editor-pane';
			for (const n of existingChildren) { try { editorPane.appendChild(n); } catch (e) { console.error('[kusto]', e); } }

			try { editorWrapper.innerHTML = ''; } catch (e) { console.error('[kusto]', e); }
			split.appendChild(editorPane);
			split.appendChild(splitter);

			const chatPane = document.createElement('div');
			chatPane.className = cssPrefix + '-copilot-chat-pane';
			chatPane.id = boxId + infix + '_copilot_chat_pane';
			chatPane.style.flex = '0 1 ' + DEFAULT_CHAT_WIDTH_PX + 'px';

			const chatEl = document.createElement('kw-copilot-chat') as KwCopilotChat;
			chatEl.setAttribute('box-id', boxId);
			chatEl.finalToolNames = this.flavor.finalToolNames;
			chatEl.insertQueryToolName = this.flavor.insertQueryToolName;
			chatEl.tipHtml = this.flavor.tipHtml;

			// Create model dropdown slot.
			const modelSlot = document.createElement('div');
			modelSlot.setAttribute('slot', 'model-dropdown');
			modelSlot.innerHTML = modelDropdownHtml(boxId);
			chatEl.appendChild(modelSlot);

			chatPane.appendChild(chatEl);
			split.appendChild(chatPane);
			editorWrapper.appendChild(split);

			// Hoist vertical query resizer to wrapper level.
			try { const qr = document.getElementById(boxId + '_query_resizer'); if (qr) editorWrapper.appendChild(qr); } catch (e) { console.error('[kusto]', e); }

			// Restore persisted width, or compute a dynamic default:
			// min(half of available width, 500px).
			try {
				const persisted = this._copilotChatWidthPx;
				if (typeof persisted === 'number' && Number.isFinite(persisted)) {
					this.setCopilotChatWidthPx(persisted);
				} else {
					const totalW = Math.round(split.getBoundingClientRect().width || 0);
					if (totalW > 0) this.setCopilotChatWidthPx(Math.min(Math.round(totalW / 2), DEFAULT_CHAT_WIDTH_PX));
				}
			} catch (e) { console.error('[kusto]', e); }

			// ── Wire <kw-copilot-chat> events to vscode.postMessage ───────
			this._wireCopilotChatEvents(chatEl, boxId, chatPane, split, splitter);

			// Ask extension for model list + default selection.
			try { postMessageToHost({ type: 'prepareCopilotWriteQuery', boxId: String(boxId), flavor: this.flavor.id }); } catch (e) { console.error('[kusto]', e); }

			// ResizeObserver: re-layout Monaco when split crosses auto-hide threshold.
			try {
				const AUTO_HIDE_THRESHOLD = MIN_EDITOR_WIDTH_PX + MIN_CHAT_WIDTH_PX;
				let wasBelowThreshold = false;
				const splitObserver = new ResizeObserver((entries: any) => {
					try {
						const w = entries[0]?.contentRect?.width;
						const isBelowNow = w > 0 && w <= AUTO_HIDE_THRESHOLD;
						if (isBelowNow !== wasBelowThreshold) {
							wasBelowThreshold = isBelowNow;
							try { this.host.layoutCopilotEditor(); } catch (e) { console.error('[kusto]', e); }
						}
					} catch (e) { console.error('[kusto]', e); }
				});
				splitObserver.observe(split);
				this._copilotSplitObserver = splitObserver;
			} catch (e) { console.error('[kusto]', e); }
		} catch (e) { console.error('[kusto]', e); }
	}

	private _wireCopilotChatEvents(chatEl: KwCopilotChat, boxId: string, chatPane: HTMLElement, split: HTMLElement, splitter: HTMLElement): void {
		chatEl.addEventListener('copilot-send', ((e: CustomEvent) => {
			const { text, enabledTools, requireToolUse } = e.detail;
			const connectionId = this.host.getCopilotConnectionId();
			const database = this.host.getDatabase();
			if (!connectionId) { chatEl.appendMessage('notification', this.flavor.noConnectionMessage); return; }
			if (!database) { chatEl.appendMessage('notification', 'Select a database first.'); return; }
			let currentQuery = '';
			if (this.flavor.includesQueryContext) {
				try { currentQuery = this.host.getCopilotEditorValue(); } catch (e) { console.error('[kusto]', e); }
			}
			const modelId = ((document.getElementById(boxId + '_copilot_model') || {}) as any).value || '';
			try { __kustoSetLastOptimizeModelId(modelId); } catch (e) { console.error('[kusto]', e); }
			chatEl.setRunning(true);
			try {
				postMessageToHost({
					type: 'startCopilotWriteQuery', boxId: String(boxId),
					flavor: this.flavor.id,
					connectionId: String(connectionId || ''),
					serverUrl: String(this.host.getCopilotServerUrl() || ''),
					database: String(database || ''),
					currentQuery: this.flavor.includesQueryContext ? String(currentQuery || '') : undefined,
					request: String(text || ''),
					modelId: String(modelId || ''),
					enabledTools,
					queryMode: this.flavor.includesQueryContext ? 'plain' : undefined,
					requireToolUse: requireToolUse || undefined
				});
			} catch { chatEl.setRunning(false, 'Failed to start Copilot request.'); }
		}) as EventListener);

		chatEl.addEventListener('copilot-cancel', () => {
			try { postMessageToHost({ type: 'cancelCopilotWriteQuery', boxId }); } catch (e) { console.error('[kusto]', e); }
		});

		chatEl.addEventListener('copilot-clear', () => {
			chatEl.clearConversation();
			try { postMessageToHost({ type: 'clearCopilotConversation', boxId }); } catch (e) { console.error('[kusto]', e); }
			try { postMessageToHost({ type: 'prepareCopilotWriteQuery', boxId: String(boxId), flavor: this.flavor.id }); } catch (e) { console.error('[kusto]', e); }
		});

		chatEl.addEventListener('copilot-close', () => { this.setCopilotChatVisible(false); });

		chatEl.addEventListener('copilot-view-tool', ((e: CustomEvent) => {
			try { postMessageToHost({ type: 'openToolResultInEditor', boxId, tool: e.detail.tool, label: e.detail.label, content: e.detail.content }); } catch (e) { console.error('[kusto]', e); }
		}) as EventListener);

		chatEl.addEventListener('copilot-remove-entry', ((e: CustomEvent) => {
			try { postMessageToHost({ type: 'removeFromCopilotHistory', boxId, entryId: e.detail.entryId }); } catch (e) { console.error('[kusto]', e); }
		}) as EventListener);

		if (this.flavor.supportsOpenPreview) {
			chatEl.addEventListener('copilot-open-preview', ((e: CustomEvent) => {
				try { postMessageToHost({ type: 'openMarkdownPreview', filePath: e.detail.filePath }); } catch (e) { console.error('[kusto]', e); }
			}) as EventListener);
		}

		if (this.flavor.supportsInsertQuery) {
			chatEl.addEventListener('copilot-insert-query', ((e: CustomEvent) => {
				try {
					const sourceServerUrl = this.host.getCopilotServerUrl();
					const sourceDatabase = this.host.getDatabase();

					const scrollContainer = document.documentElement;
					const savedScroll = scrollContainer.scrollTop;
					const isSql = this.flavor.id === 'sql';

					// For SQL queries, extract a leading -- comment as the section name.
					let queryText = String(e.detail.query || '');
					let sectionName = 'Copilot query';
					if (isSql) {
						const match = queryText.match(/^\s*--\s*(.*)\r?\n?/);
						if (match && match[1] && match[1].trim()) {
							sectionName = match[1].trim();
							queryText = queryText.slice(match[0].length);
						}
					}

					const newBoxId = isSql
						? addSqlBox({
							query: queryText,
							afterBoxId: boxId,
							serverUrl: sourceServerUrl || undefined,
							database: sourceDatabase || undefined,
						})
						: addQueryBox({
							initialQuery: queryText,
							defaultResultsVisible: true,
							afterBoxId: boxId,
							clusterUrl: sourceServerUrl || undefined,
							database: sourceDatabase || undefined,
						});
					scrollContainer.scrollTop = savedScroll;
					if (newBoxId) {
						__kustoSetSectionName(newBoxId, sectionName);
						setTimeout(() => {
							if (!isSql) setQueryText(newBoxId, e.detail.query);
							if (e.detail.result) {
								displayResultForBox(e.detail.result, newBoxId, { label: 'Results', showExecutionTime: true });
							}
							const newBox = document.getElementById(newBoxId);
							if (newBox) newBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
						}, 100);
					}
				} catch (e) { console.error('[kusto]', e); }
			}) as EventListener);
		}

		if (this.flavor.supportsOpenAgent) {
			chatEl.addEventListener('copilot-open-agent', () => {
				try { postMessageToHost({ type: 'openCopilotAgent' }); } catch (e) { console.error('[kusto]', e); }
			});
		}

		// ── Splitter drag ─────────────────────────────────────────────────

		splitter.addEventListener('mousedown', (e: any) => {
			try { e.preventDefault(); e.stopPropagation(); } catch (e) { console.error('[kusto]', e); }
			splitter.classList.add('is-dragging');
			const previousCursor = document.body.style.cursor;
			const previousUserSelect = document.body.style.userSelect;
			document.body.style.cursor = 'ew-resize';
			document.body.style.userSelect = 'none';
			const startX = e.clientX;
			let startW = DEFAULT_CHAT_WIDTH_PX;
			try { startW = Math.round(chatPane.getBoundingClientRect().width || DEFAULT_CHAT_WIDTH_PX); } catch (e) { console.error('[kusto]', e); }
			const onMove = (moveEvent: any) => {
				const delta = (moveEvent.clientX - startX);
				let max: number | undefined;
				try { const total = Math.round(split.getBoundingClientRect().width || 0); if (total > 0) max = Math.max(MIN_CHAT_WIDTH_PX, total - MIN_EDITOR_WIDTH_PX); } catch (e) { console.error('[kusto]', e); }
				const next = clampNumber(startW - delta, MIN_CHAT_WIDTH_PX, max);
				try { chatPane.style.flex = '0 1 ' + next + 'px'; } catch (e) { console.error('[kusto]', e); }
				this._copilotChatWidthPx = next;
				try { this.host.layoutCopilotEditor(); } catch (e) { console.error('[kusto]', e); }
			};
			const onUp = () => {
				document.removeEventListener('mousemove', onMove, true);
				document.removeEventListener('mouseup', onUp, true);
				splitter.classList.remove('is-dragging');
				document.body.style.cursor = previousCursor;
				document.body.style.userSelect = previousUserSelect;
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			};
			document.addEventListener('mousemove', onMove, true);
			document.addEventListener('mouseup', onUp, true);
		});
	}

	private _setCopilotToggleButtonState(visible: boolean): void {
		try {
			const toolbar = document.querySelector(this.flavor.toolbarTagName + '[box-id="' + this.host.boxId + '"]') as any;
			if (toolbar && typeof toolbar.setCopilotChatActive === 'function') {
				toolbar.setCopilotChatActive(!!visible);
			}
		} catch (e) { console.error('[kusto]', e); }
	}

	// ── Copilot message delegators ────────────────────────────────────────────
	// Called from kw-query-section forwarding methods. Find the <kw-copilot-chat>
	// element and delegate to its public API.

	copilotApplyWriteQueryOptions(models: any, selectedModelId: string, tools: any): void {
		applyModelOptions(this.host.boxId, models, selectedModelId);
		const chatEl = this.getCopilotChatEl();
		if (chatEl) chatEl.applyOptions(models, selectedModelId, tools || []);
	}

	copilotWriteQueryStatus(text: string, detail: string, role: string): void {
		const chatEl = this.getCopilotChatEl();
		if (chatEl) chatEl.appendMessage((role === 'assistant' ? 'assistant' : 'notification') as 'assistant' | 'notification', text, detail);
	}

	copilotWriteQuerySetQuery(queryText: string): void {
		try { this.host.setCopilotQueryText(queryText); } catch (e) { console.error('[kusto]', e); }
	}

	copilotWriteQueryDone(ok: boolean, message: string): void {
		const chatEl = this.getCopilotChatEl();
		if (chatEl) chatEl.setRunning(false, message);
	}

	copilotWriteQueryToolResult(toolName: string, label: string, jsonText: string, entryId: string): void {
		const chatEl = this.getCopilotChatEl();
		if (chatEl) chatEl.appendToolResponse(toolName, label, jsonText, entryId);
	}

	copilotAppendExecutedQuery(query: string, resultSummary: string, errorMessage: string, entryId: string, result: unknown): void {
		const chatEl = this.getCopilotChatEl();
		if (chatEl) chatEl.appendExecutedQuery(query, resultSummary, errorMessage, entryId, result);
	}

	copilotAppendGeneralRulesLink(filePath: string, preview: string, entryId: string): void {
		const chatEl = this.getCopilotChatEl();
		if (chatEl) chatEl.appendGeneralRulesLink(filePath, preview, entryId);
	}

	copilotAppendClarifyingQuestion(question: string, entryId: string): void {
		const chatEl = this.getCopilotChatEl();
		if (chatEl) chatEl.appendClarifyingQuestion(question, entryId);
	}

	copilotAppendQuerySnapshot(queryText: string, entryId: string): void {
		const chatEl = this.getCopilotChatEl();
		if (chatEl) chatEl.appendQuerySnapshot(queryText, entryId);
	}

	copilotAppendDevNotesContext(preview: string, entryId: string): void {
		const chatEl = this.getCopilotChatEl();
		if (chatEl) chatEl.appendDevNotesContext(preview, entryId);
	}

	copilotAppendDevNoteToolCall(action: string, detail: string, result: string, entryId: string): void {
		const chatEl = this.getCopilotChatEl();
		if (chatEl) chatEl.appendDevNoteToolCall(action, detail, result, entryId);
	}

	copilotClearConversation(): void {
		const chatEl = this.getCopilotChatEl();
		if (chatEl) {
			chatEl.clearConversation();
			try { postMessageToHost({ type: 'clearCopilotConversation', boxId: this.host.boxId }); } catch (e) { console.error('[kusto]', e); }
			try { postMessageToHost({ type: 'prepareCopilotWriteQuery', boxId: String(this.host.boxId || '') }); } catch (e) { console.error('[kusto]', e); }
		}
	}

	copilotWriteQuerySend(): void {
		const chatEl = this.getCopilotChatEl();
		if (!chatEl) return;
		const sendBtn = chatEl.shadowRoot?.querySelector('.send-btn') as HTMLElement | null;
		if (sendBtn) sendBtn.click();
	}

	copilotWriteQueryCancel(): void {
		const chatEl = this.getCopilotChatEl();
		if (chatEl && !chatEl.isRunning()) return;
		try { postMessageToHost({ type: 'cancelCopilotWriteQuery', boxId: this.host.boxId }); } catch (e) { console.error('[kusto]', e); }
	}
}
