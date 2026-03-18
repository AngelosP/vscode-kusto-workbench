// Copilot chat module — thin bridge between legacy DOM layout and <kw-copilot-chat> Lit component.
// Manages: split layout installation, visibility toggle, width persistence, toggle button.
// All message rendering is delegated to the <kw-copilot-chat> element.
export {};

import type { KwCopilotChat } from '../components/kw-copilot-chat.js';

const _win = window;

const COPILOT_QUERY_KIND = 'copilotQuery';
const DEFAULT_CHAT_WIDTH_PX = 720;
const MIN_CHAT_WIDTH_PX = 160;
const MIN_EDITOR_WIDTH_PX = 240;
const COPILOT_VISIBILITY_CLASS_HIDDEN = 'kusto-copilot-chat-hidden';

// ── State Maps ────────────────────────────────────────────────────────────────

function __kustoEnsureQueryBoxKindMap() {
	try {
		if (!(_win.__kustoQueryBoxKindByBoxId as any) || typeof (_win.__kustoQueryBoxKindByBoxId as any) !== 'object') {
			(_win.__kustoQueryBoxKindByBoxId as any) = {};
		}
	} catch (e) { console.error('[kusto]', e); }
	return (_win.__kustoQueryBoxKindByBoxId as any);
}

function __kustoEnsureCopilotChatWidthState() {
	try {
		if (!(_win.__kustoCopilotChatWidthPxByBoxId as any) || typeof (_win.__kustoCopilotChatWidthPxByBoxId as any) !== 'object') {
			(_win.__kustoCopilotChatWidthPxByBoxId as any) = {};
		}
	} catch (e) { console.error('[kusto]', e); }
	return (_win.__kustoCopilotChatWidthPxByBoxId as any);
}

function __kustoEnsureCopilotChatVisibilityState() {
	try {
		if (!(_win.__kustoCopilotChatVisibleByBoxId as any) || typeof (_win.__kustoCopilotChatVisibleByBoxId as any) !== 'object') {
			(_win.__kustoCopilotChatVisibleByBoxId as any) = {};
		}
	} catch (e) { console.error('[kusto]', e); }
	return (_win.__kustoCopilotChatVisibleByBoxId as any);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function __kustoClampNumber(value: any, min: any, max: any) {
	const n = typeof value === 'number' ? value : parseInt(String(value || ''), 10);
	if (!Number.isFinite(n)) return min;
	if (typeof max === 'number' && Number.isFinite(max)) {
		return Math.max(min, Math.min(max, n));
	}
	return Math.max(min, n);
}

/** Find the <kw-copilot-chat> Lit element for a given box ID. */
function __kustoGetCopilotChatEl(boxId: string): KwCopilotChat | null {
	const id = String(boxId || '').trim();
	if (!id) return null;
	const pane = document.getElementById(id + '_copilot_chat_pane');
	return (pane?.querySelector('kw-copilot-chat') as KwCopilotChat | null) ?? null;
}

function __kustoSetCopilotToggleButtonState(boxId: any, visible: any) {
	try {
		const btn = document.getElementById(String(boxId || '') + '_copilot_chat_toggle');
		if (!btn) return;
		btn.classList.toggle('is-active', !!visible);
		btn.setAttribute('aria-pressed', visible ? 'true' : 'false');
	} catch (e) { console.error('[kusto]', e); }
}

// ── Width Get/Set ─────────────────────────────────────────────────────────────

function __kustoGetCopilotChatWidthPx(boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return undefined;
	try {
		const map = __kustoEnsureCopilotChatWidthState();
		const v = map[id];
		if (typeof v === 'number' && Number.isFinite(v)) return v;
	} catch (e) { console.error('[kusto]', e); }
	try {
		const pane = document.getElementById(id + '_copilot_chat_pane');
		if (!pane) return undefined;
		const w = Math.round(pane.getBoundingClientRect().width || 0);
		return w > 0 ? w : undefined;
	} catch {
		return undefined;
	}
}

function __kustoSetCopilotChatWidthPx(boxId: any, widthPx: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	let max;
	try {
		const split = document.getElementById(id + '_copilot_split');
		if (split) {
			const total = Math.round(split.getBoundingClientRect().width || 0);
			if (total > 0) max = Math.max(MIN_CHAT_WIDTH_PX, total - MIN_EDITOR_WIDTH_PX);
		}
	} catch (e) { console.error('[kusto]', e); }
	const next = __kustoClampNumber(widthPx, MIN_CHAT_WIDTH_PX, max);
	try {
		const pane = document.getElementById(id + '_copilot_chat_pane');
		if (pane && pane.style) pane.style.flex = '0 1 ' + next + 'px';
	} catch (e) { console.error('[kusto]', e); }
	try { const map = __kustoEnsureCopilotChatWidthState(); map[id] = next; } catch (e) { console.error('[kusto]', e); }
	try {
		const editor = (_win.queryEditors as any)?.[id];
		if (editor && typeof editor.layout === 'function') editor.layout();
	} catch (e) { console.error('[kusto]', e); }
}

// ── Set Query Text ────────────────────────────────────────────────────────────

function __kustoSetQueryText(boxId: any, queryText: any) {
	try {
		const editor = (_win.queryEditors as any)?.[boxId];
		if (!editor) return;
		const model = editor.getModel?.();
		if (!model) return;
		let next = String(queryText || '');
		try { if (typeof (_win.__kustoPrettifyKustoText as any) === 'function') next = (_win.__kustoPrettifyKustoText as any)(next); } catch (e) { console.error('[kusto]', e); }
		editor.executeEdits('copilot', [{ range: model.getFullModelRange(), text: next }]);
		editor.focus();
		try { (_win.schedulePersist as any)?.('copilotWriteQuery'); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

// ── Model Dropdown ────────────────────────────────────────────────────────────

function __kustoApplyModelOptions(boxId: any, models: any, selectedModelId: any) {
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
		try { if (typeof (_win.__kustoGetLastOptimizeModelId as any) === 'function') preferred = String((_win.__kustoGetLastOptimizeModelId as any)() || ''); } catch (e) { console.error('[kusto]', e); }
		const hasPreferred = preferred && Array.from(sel.options).some((o: any) => o.value === preferred);
		if (hasPreferred) sel.value = preferred;
		else if (selectedModelId) sel.value = String(selectedModelId);
		if (!sel.value && sel.options.length > 0) sel.selectedIndex = 0;
		sel.onchange = () => {
			try { if (typeof (_win.__kustoSetLastOptimizeModelId as any) === 'function') (_win.__kustoSetLastOptimizeModelId as any)(sel.value); } catch (e) { console.error('[kusto]', e); }
			try { (_win.__kustoDropdown as any)?.syncSelectBackedDropdown?.(boxId + '_copilot_model'); } catch (e) { console.error('[kusto]', e); }
		};
		try { (_win.__kustoDropdown as any)?.syncSelectBackedDropdown?.(boxId + '_copilot_model'); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoModelDropdownHtml(boxId: string): string {
	try {
		if ((_win.__kustoDropdown as any)?.renderMenuDropdownHtml) {
			const modelIconSvg = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3.18 8l1.83-.55L5.56 5.6a.3.3 0 0 1 .57 0l.55 1.85L8.5 8a.3.3 0 0 1 0 .57l-1.83.55-.55 1.84a.3.3 0 0 1-.57 0l-.55-1.84L3.18 8.57a.3.3 0 0 1 0-.57ZM9.14 3l1.16-.35.35-1.17a.19.19 0 0 1 .37 0l.35 1.17L12.53 3a.19.19 0 0 1 0 .36l-1.16.35-.35 1.17a.19.19 0 0 1-.37 0l-.35-1.17L9.14 3.36a.19.19 0 0 1 0-.36ZM9.14 11l1.16-.35.35-1.17a.19.19 0 0 1 .37 0l.35 1.17 1.16.35a.19.19 0 0 1 0 .36l-1.16.35-.35 1.17a.19.19 0 0 1-.37 0l-.35-1.17-1.16-.35a.19.19 0 0 1 0-.36Z"/></svg>';
			return (_win.__kustoDropdown as any).renderMenuDropdownHtml({
				wrapperClass: 'kusto-copilot-chat-model-dropdown kusto-dropdown-tooltip-label',
				title: '', iconSvg: modelIconSvg, includeHiddenSelect: true,
				selectId: boxId + '_copilot_model',
				onChange: "try{if(typeof __kustoSetLastOptimizeModelId==='function'){__kustoSetLastOptimizeModelId(this.value)}}catch{}",
				buttonId: boxId + '_copilot_model_btn', buttonTextId: boxId + '_copilot_model_btn_text',
				menuId: boxId + '_copilot_model_menu', placeholder: 'Select model...',
				onToggle: "try{window.__kustoDropdown&&window.__kustoDropdown.toggleSelectMenu&&window.__kustoDropdown.toggleSelectMenu('" + boxId + "_copilot_model')}catch{}"
			});
		}
	} catch (e) { console.error('[kusto]', e); }
	return '<div class="select-wrapper"><select id="' + boxId + '_copilot_model" aria-label="Copilot model"></select></div>';
}

// ── Install Copilot Chat (Split Layout + Lit Element) ─────────────────────────

function __kustoInstallCopilotChat(boxId: any) {
	try {
		const wrapper = document.getElementById(boxId + '_query_editor');
		if (!wrapper) return;
		const editorWrapper = wrapper.closest?.('.query-editor-wrapper') as HTMLElement | null;
		if (!editorWrapper) return;
		if (document.getElementById(boxId + '_copilot_chat_pane')) return;

		const existingChildren = Array.from(editorWrapper.childNodes || []);
		const split = document.createElement('div');
		split.className = 'kusto-copilot-split';
		split.id = boxId + '_copilot_split';
		split.style.flex = '1 1 auto';
		split.style.minHeight = '0';

		const splitter = document.createElement('div');
		splitter.className = 'query-editor-resizer kusto-copilot-splitter';
		splitter.id = boxId + '_copilot_splitter';
		splitter.title = 'Drag to resize Copilot chat';
		splitter.setAttribute('aria-label', 'Resize Copilot chat');
		splitter.setAttribute('data-kusto-no-editor-focus', 'true');

		const editorPane = document.createElement('div');
		editorPane.className = 'kusto-copilot-editor-pane';
		for (const n of existingChildren) { try { editorPane.appendChild(n); } catch (e) { console.error('[kusto]', e); } }

		try { editorWrapper.innerHTML = ''; } catch (e) { console.error('[kusto]', e); }
		split.appendChild(editorPane);
		split.appendChild(splitter);

		// Create chat pane with <kw-copilot-chat> Lit element.
		const chatPane = document.createElement('div');
		chatPane.className = 'kusto-copilot-chat-pane';
		chatPane.id = boxId + '_copilot_chat_pane';
		chatPane.style.flex = '0 1 ' + DEFAULT_CHAT_WIDTH_PX + 'px';

		const chatEl = document.createElement('kw-copilot-chat') as KwCopilotChat;
		chatEl.setAttribute('box-id', boxId);

		// Slot model dropdown into the Lit element.
		const modelSlot = document.createElement('div');
		modelSlot.setAttribute('slot', 'model-dropdown');
		modelSlot.innerHTML = __kustoModelDropdownHtml(boxId);
		chatEl.appendChild(modelSlot);

		chatPane.appendChild(chatEl);
		split.appendChild(chatPane);
		editorWrapper.appendChild(split);

		// Hoist vertical query resizer to wrapper level.
		try { const qr = document.getElementById(boxId + '_query_resizer'); if (qr) editorWrapper.appendChild(qr); } catch (e) { console.error('[kusto]', e); }

		// Restore persisted width.
		try {
			const persisted = __kustoGetCopilotChatWidthPx(boxId);
			if (typeof persisted === 'number' && Number.isFinite(persisted)) __kustoSetCopilotChatWidthPx(boxId, persisted);
		} catch (e) { console.error('[kusto]', e); }

		// ── Wire <kw-copilot-chat> events to vscode.postMessage ───────────

		chatEl.addEventListener('copilot-send', ((e: CustomEvent) => {
			const { text, enabledTools } = e.detail;
			const connectionId = typeof (_win.__kustoGetConnectionId as any) === 'function' ? (_win.__kustoGetConnectionId as any)(boxId) : '';
			const database = typeof (_win.__kustoGetDatabase as any) === 'function' ? (_win.__kustoGetDatabase as any)(boxId) : '';
			if (!connectionId) { chatEl.appendMessage('notification', 'Select a cluster connection first.'); return; }
			if (!database) { chatEl.appendMessage('notification', 'Select a database first.'); return; }
			let currentQuery = '';
			try { const ed = (_win.queryEditors as any)?.[boxId]; currentQuery = ed ? (ed.getValue() || '') : ''; } catch (e) { console.error('[kusto]', e); }
			const modelId = ((document.getElementById(boxId + '_copilot_model') || {}) as any).value || '';
			try { if (typeof (_win.__kustoSetLastOptimizeModelId as any) === 'function') (_win.__kustoSetLastOptimizeModelId as any)(modelId); } catch (e) { console.error('[kusto]', e); }
			chatEl.setRunning(true);
			try {
				(_win.vscode as any).postMessage({
					type: 'startCopilotWriteQuery', boxId: String(boxId),
					connectionId: String(connectionId || ''), database: String(database || ''),
					currentQuery: String(currentQuery || ''), request: String(text || ''),
					modelId: String(modelId || ''), enabledTools,
					queryMode: typeof (_win.getRunMode) === 'function' ? (_win.getRunMode as any)(boxId) : 'take100'
				});
			} catch { chatEl.setRunning(false, 'Failed to start Copilot request.'); }
		}) as EventListener);

		chatEl.addEventListener('copilot-cancel', () => {
			try { (_win.vscode as any).postMessage({ type: 'cancelCopilotWriteQuery', boxId }); } catch (e) { console.error('[kusto]', e); }
		});

		chatEl.addEventListener('copilot-clear', () => {
			chatEl.clearConversation();
			try { (_win.vscode as any).postMessage({ type: 'clearCopilotConversation', boxId }); } catch (e) { console.error('[kusto]', e); }
			try { (_win.vscode as any).postMessage({ type: 'prepareCopilotWriteQuery', boxId: String(boxId) }); } catch (e) { console.error('[kusto]', e); }
		});

		chatEl.addEventListener('copilot-close', () => { __kustoSetCopilotChatVisible(boxId, false); });

		chatEl.addEventListener('copilot-view-tool', ((e: CustomEvent) => {
			try { (_win.vscode as any).postMessage({ type: 'openToolResultInEditor', boxId, tool: e.detail.tool, label: e.detail.label, content: e.detail.content }); } catch (e) { console.error('[kusto]', e); }
		}) as EventListener);

		chatEl.addEventListener('copilot-remove-entry', ((e: CustomEvent) => {
			try { (_win.vscode as any).postMessage({ type: 'removeFromCopilotHistory', boxId, entryId: e.detail.entryId }); } catch (e) { console.error('[kusto]', e); }
		}) as EventListener);

		chatEl.addEventListener('copilot-open-preview', ((e: CustomEvent) => {
			try { (_win.vscode as any).postMessage({ type: 'openMarkdownPreview', filePath: e.detail.filePath }); } catch (e) { console.error('[kusto]', e); }
		}) as EventListener);

		chatEl.addEventListener('copilot-insert-query', ((e: CustomEvent) => {
			try {
				if (typeof _win.addQueryBox === 'function') {
					// Get the source section's connection to copy to the new section.
					const sourceEl = document.getElementById(boxId) as any;
					const sourceClusterUrl = sourceEl && typeof sourceEl.getClusterUrl === 'function' ? sourceEl.getClusterUrl() : '';
					const sourceDatabase = sourceEl && typeof sourceEl.getDatabase === 'function' ? sourceEl.getDatabase() : '';

					// Save scroll position before DOM insertion to prevent scroll jump.
					const scrollContainer = document.documentElement;
					const savedScroll = scrollContainer.scrollTop;
					const newBoxId = _win.addQueryBox({
						initialQuery: e.detail.query,
						defaultResultsVisible: true,
						afterBoxId: boxId,
						clusterUrl: sourceClusterUrl || undefined,
						database: sourceDatabase || undefined,
					});
					// Restore scroll position immediately after DOM insertion.
					scrollContainer.scrollTop = savedScroll;
					if (newBoxId) {
						// Set a name for the inserted section.
						if (typeof _win.__kustoSetSectionName === 'function') {
							_win.__kustoSetSectionName(newBoxId, 'Copilot query');
						}
						setTimeout(() => {
							__kustoSetQueryText(newBoxId, e.detail.query);
							if (e.detail.result && typeof (_win.displayResultForBox) === 'function') {
								(_win.displayResultForBox as any)(e.detail.result, newBoxId, { label: 'Results', showExecutionTime: true });
							}
							const newBox = document.getElementById(newBoxId);
							if (newBox) newBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
						}, 100);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
		}) as EventListener);

		chatEl.addEventListener('copilot-open-agent', () => {
			try { (_win.vscode as any).postMessage({ type: 'openCopilotAgent' }); } catch (e) { console.error('[kusto]', e); }
		});

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
				let max;
				try { const total = Math.round(split.getBoundingClientRect().width || 0); if (total > 0) max = Math.max(MIN_CHAT_WIDTH_PX, total - MIN_EDITOR_WIDTH_PX); } catch (e) { console.error('[kusto]', e); }
				const next = __kustoClampNumber(startW - delta, MIN_CHAT_WIDTH_PX, max);
				try { chatPane.style.flex = '0 1 ' + next + 'px'; } catch (e) { console.error('[kusto]', e); }
				try { __kustoEnsureCopilotChatWidthState()[boxId] = next; } catch (e) { console.error('[kusto]', e); }
				try { const ed = (_win.queryEditors as any)?.[boxId]; if (ed?.layout) ed.layout(); } catch (e) { console.error('[kusto]', e); }
			};
			const onUp = () => {
				document.removeEventListener('mousemove', onMove, true);
				document.removeEventListener('mouseup', onUp, true);
				splitter.classList.remove('is-dragging');
				document.body.style.cursor = previousCursor;
				document.body.style.userSelect = previousUserSelect;
				try { (_win.schedulePersist as any)?.(); } catch (e) { console.error('[kusto]', e); }
			};
			document.addEventListener('mousemove', onMove, true);
			document.addEventListener('mouseup', onUp, true);
		});

		// Ask extension for model list + default selection.
		try { (_win.vscode as any).postMessage({ type: 'prepareCopilotWriteQuery', boxId: String(boxId) }); } catch (e) { console.error('[kusto]', e); }

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
						const ed = (_win.queryEditors as any)?.[boxId];
						if (ed?.layout) ed.layout();
					}
				} catch (e) { console.error('[kusto]', e); }
			});
			splitObserver.observe(split);
		} catch (e) { console.error('[kusto]', e); }

		(_win.__kustoGetCopilotChatWidthPx as any) = __kustoGetCopilotChatWidthPx;
		(_win.__kustoSetCopilotChatWidthPx as any) = __kustoSetCopilotChatWidthPx;
	} catch (e) { console.error('[kusto]', e); }
}

// ── Visibility ────────────────────────────────────────────────────────────────

function __kustoGetCopilotChatVisible(boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return false;
	try { const map = __kustoEnsureCopilotChatVisibilityState(); if (typeof map[id] === 'boolean') return !!map[id]; } catch (e) { console.error('[kusto]', e); }
	return false;
}

function __kustoSetCopilotChatVisible(boxId: any, visible: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const next = !!visible;
	try { __kustoEnsureCopilotChatVisibilityState()[id] = next; } catch (e) { console.error('[kusto]', e); }
	if (next) { try { __kustoInstallCopilotChat(id); } catch (e) { console.error('[kusto]', e); } }
	try {
		const split = document.getElementById(id + '_copilot_split');
		if (split?.classList) split.classList.toggle(COPILOT_VISIBILITY_CLASS_HIDDEN, !next);
	} catch (e) { console.error('[kusto]', e); }
	if (next) {
		try {
			const wrapper = document.getElementById(id + '_query_editor');
			const editorWrapper = wrapper?.closest?.('.query-editor-wrapper') as HTMLElement | null;
			if (editorWrapper) {
				const currentHeight = editorWrapper.getBoundingClientRect().height;
				if (currentHeight < 180) {
					editorWrapper.style.height = '180px';
					try {
						if (!(_win.__kustoManualQueryEditorHeightPxByBoxId as any) || typeof (_win.__kustoManualQueryEditorHeightPxByBoxId as any) !== 'object') (_win.__kustoManualQueryEditorHeightPxByBoxId as any) = {};
						(_win.__kustoManualQueryEditorHeightPxByBoxId as any)[id] = 180;
					} catch (e) { console.error('[kusto]', e); }
				}
			}
		} catch (e) { console.error('[kusto]', e); }
	}
	__kustoSetCopilotToggleButtonState(id, next);
	try { const ed = (_win.queryEditors as any)?.[id]; if (ed?.layout) ed.layout(); } catch (e) { console.error('[kusto]', e); }
	try { (_win.schedulePersist as any)?.(); } catch (e) { console.error('[kusto]', e); }
}

// ── Window Bridge Assignments ─────────────────────────────────────────────────

window.__kustoToggleCopilotChatForBox = function (boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	if (!(_win.__kustoCopilotChatFirstTimeDismissed as any)) {
		try { (_win.vscode as any).postMessage({ type: 'copilotChatFirstTimeCheck', boxId: id }); } catch (e) { console.error('[kusto]', e); }
		return;
	}
	__kustoSetCopilotChatVisible(id, !__kustoGetCopilotChatVisible(id));
};

(_win.__kustoGetCopilotChatVisible as any) = __kustoGetCopilotChatVisible;
(_win.__kustoSetCopilotChatVisible as any) = __kustoSetCopilotChatVisible;
(_win.__kustoGetCopilotChatWidthPx as any) = __kustoGetCopilotChatWidthPx;
(_win.__kustoSetCopilotChatWidthPx as any) = __kustoSetCopilotChatWidthPx;
(_win.__kustoGetCopilotChatEl as any) = __kustoGetCopilotChatEl;

window.addCopilotQueryBox = function (options: any) {
	const id = (_win.addQueryBox as any)(options || {});
	try { __kustoEnsureQueryBoxKindMap()[id] = COPILOT_QUERY_KIND; } catch (e) { console.error('[kusto]', e); }
	try { __kustoInstallCopilotChat(id); __kustoSetCopilotChatVisible(id, true); } catch (e) { console.error('[kusto]', e); }
	return id;
};

window.__kustoCopilotWriteQueryCancel = function (boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const chatEl = __kustoGetCopilotChatEl(id);
	if (chatEl && !chatEl.isRunning()) return;
	try { (_win.vscode as any).postMessage({ type: 'cancelCopilotWriteQuery', boxId: id }); } catch (e) { console.error('[kusto]', e); }
};

window.__kustoDisposeCopilotQueryBox = function (boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	try { (_win.vscode as any).postMessage({ type: 'cancelCopilotWriteQuery', boxId: id }); } catch (e) { console.error('[kusto]', e); }
	try { delete __kustoEnsureQueryBoxKindMap()[id]; } catch (e) { console.error('[kusto]', e); }
};

// Delegators — main.ts calls these; they find the Lit element and delegate.
window.__kustoCopilotApplyWriteQueryOptions = function (boxId: any, models: any, selectedModelId: any, tools: any) {
	__kustoApplyModelOptions(String(boxId || ''), models, selectedModelId);
	const chatEl = __kustoGetCopilotChatEl(String(boxId || ''));
	if (chatEl) chatEl.applyOptions(models, selectedModelId, tools || []);
};

window.__kustoCopilotWriteQueryStatus = function (boxId: any, text: any, detail: any, role: any) {
	const chatEl = __kustoGetCopilotChatEl(String(boxId || ''));
	if (chatEl) chatEl.appendMessage((role === 'assistant' ? 'assistant' : 'notification') as 'assistant' | 'notification', String(text || ''), String(detail || ''));
};

window.__kustoCopilotWriteQuerySetQuery = function (boxId: any, queryText: any) {
	__kustoSetQueryText(String(boxId || ''), queryText);
};

window.__kustoCopilotWriteQueryDone = function (boxId: any, _ok: any, message: any) {
	const chatEl = __kustoGetCopilotChatEl(String(boxId || ''));
	if (chatEl) chatEl.setRunning(false, String(message || ''));
};

window.__kustoCopilotWriteQueryToolResult = function (boxId: any, toolName: any, label: any, jsonText: any, entryId: any) {
	const chatEl = __kustoGetCopilotChatEl(String(boxId || ''));
	if (chatEl) chatEl.appendToolResponse(String(toolName || ''), String(label || ''), String(jsonText || ''), String(entryId || ''));
};

window.__kustoCopilotAppendExecutedQuery = function (boxId: any, query: any, resultSummary: any, errorMessage: any, entryId: any, result: any) {
	const chatEl = __kustoGetCopilotChatEl(String(boxId || ''));
	if (chatEl) chatEl.appendExecutedQuery(String(query || ''), String(resultSummary || ''), String(errorMessage || ''), String(entryId || ''), result);
};

window.__kustoCopilotAppendGeneralRulesLink = function (boxId: any, filePath: any, preview: any, entryId: any) {
	const chatEl = __kustoGetCopilotChatEl(String(boxId || ''));
	if (chatEl) chatEl.appendGeneralRulesLink(String(filePath || ''), String(preview || ''), String(entryId || ''));
};

window.__kustoCopilotAppendClarifyingQuestion = function (boxId: any, question: any, entryId: any) {
	const chatEl = __kustoGetCopilotChatEl(String(boxId || ''));
	if (chatEl) chatEl.appendClarifyingQuestion(String(question || ''), String(entryId || ''));
};

window.__kustoCopilotAppendQuerySnapshot = function (boxId: any, queryText: any, entryId: any) {
	const chatEl = __kustoGetCopilotChatEl(String(boxId || ''));
	if (chatEl) chatEl.appendQuerySnapshot(String(queryText || ''), String(entryId || ''));
};

window.__kustoCopilotAppendDevNotesContext = function (boxId: any, preview: any, entryId: any) {
	const chatEl = __kustoGetCopilotChatEl(String(boxId || ''));
	if (chatEl) chatEl.appendDevNotesContext(String(preview || ''), String(entryId || ''));
};

window.__kustoCopilotAppendDevNoteToolCall = function (boxId: any, action: any, detail: any, result: any, entryId: any) {
	const chatEl = __kustoGetCopilotChatEl(String(boxId || ''));
	if (chatEl) chatEl.appendDevNoteToolCall(String(action || ''), String(detail || ''), String(result || ''), String(entryId || ''));
};

window.__kustoCopilotClearConversation = function (boxId: any) {
	const chatEl = __kustoGetCopilotChatEl(String(boxId || ''));
	if (chatEl) {
		chatEl.clearConversation();
		try { (_win.vscode as any).postMessage({ type: 'clearCopilotConversation', boxId }); } catch (e) { console.error('[kusto]', e); }
		try { (_win.vscode as any).postMessage({ type: 'prepareCopilotWriteQuery', boxId: String(boxId || '') }); } catch (e) { console.error('[kusto]', e); }
	}
};

window.__kustoCopilotWriteQuerySend = function (boxId: any) {
	const chatEl = __kustoGetCopilotChatEl(String(boxId || ''));
	if (!chatEl) return;
	const sendBtn = chatEl.shadowRoot?.querySelector('.send-btn') as HTMLElement | null;
	if (sendBtn) sendBtn.click();
};

// Tools panel is now fully managed by the Lit element — no-op for backwards compat.
window.__kustoCopilotToggleToolsPanel = function () {};
