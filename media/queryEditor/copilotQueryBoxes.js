// Copilot chat for Kusto Query boxes.
//
// This integrates a Copilot chat pane into a normal query box:
// - It reuses addQueryBox() for the core KQL editor + results UI.
// - Copilot chat is toggled per query box via the toolbar.
// - Legacy `copilotQuery` persisted sections are supported for back-compat only.

(function () {
	const COPILOT_QUERY_KIND = 'copilotQuery';
	const DEFAULT_CHAT_WIDTH_PX = 360;
	const MIN_CHAT_WIDTH_PX = 240;
	const MIN_EDITOR_WIDTH_PX = 240;
	const COPILOT_VISIBILITY_CLASS_HIDDEN = 'kusto-copilot-chat-hidden';

	function __kustoEnsureQueryBoxKindMap() {
		try {
			if (!window.__kustoQueryBoxKindByBoxId || typeof window.__kustoQueryBoxKindByBoxId !== 'object') {
				window.__kustoQueryBoxKindByBoxId = {};
			}
		} catch {
			// ignore
		}
		return window.__kustoQueryBoxKindByBoxId;
	}

	function __kustoEnsureCopilotChatState() {
		try {
			if (!window.__kustoCopilotChatStateByBoxId || typeof window.__kustoCopilotChatStateByBoxId !== 'object') {
				window.__kustoCopilotChatStateByBoxId = {};
			}
		} catch {
			// ignore
		}
		return window.__kustoCopilotChatStateByBoxId;
	}

	function __kustoEnsureCopilotToolResponseState() {
		try {
			if (!window.__kustoCopilotToolResponsesByBoxId || typeof window.__kustoCopilotToolResponsesByBoxId !== 'object') {
				window.__kustoCopilotToolResponsesByBoxId = {};
			}
		} catch {
			// ignore
		}
		return window.__kustoCopilotToolResponsesByBoxId;
	}

	function __kustoEnsureCopilotToolSelectionState() {
		try {
			if (!window.__kustoCopilotToolSelectionByBoxId || typeof window.__kustoCopilotToolSelectionByBoxId !== 'object') {
				window.__kustoCopilotToolSelectionByBoxId = {};
			}
		} catch {
			// ignore
		}
		return window.__kustoCopilotToolSelectionByBoxId;
	}

	function __kustoEnsureCopilotChatWidthState() {
		try {
			if (!window.__kustoCopilotChatWidthPxByBoxId || typeof window.__kustoCopilotChatWidthPxByBoxId !== 'object') {
				window.__kustoCopilotChatWidthPxByBoxId = {};
			}
		} catch {
			// ignore
		}
		return window.__kustoCopilotChatWidthPxByBoxId;
	}

	function __kustoEnsureCopilotChatVisibilityState() {
		try {
			if (!window.__kustoCopilotChatVisibleByBoxId || typeof window.__kustoCopilotChatVisibleByBoxId !== 'object') {
				window.__kustoCopilotChatVisibleByBoxId = {};
			}
		} catch {
			// ignore
		}
		return window.__kustoCopilotChatVisibleByBoxId;
	}

	function __kustoSetCopilotToggleButtonState(boxId, visible) {
		try {
			const btn = document.getElementById(String(boxId || '') + '_copilot_chat_toggle');
			if (!btn) return;
			btn.classList.toggle('is-active', !!visible);
			btn.setAttribute('aria-pressed', visible ? 'true' : 'false');
		} catch { /* ignore */ }
	}

	function __kustoCopilotLogoHtml() {
		const uri = (() => {
			try {
				return (window.__kustoQueryEditorConfig && window.__kustoQueryEditorConfig.copilotLogoUri)
					? String(window.__kustoQueryEditorConfig.copilotLogoUri)
					: '';
			} catch {
				return '';
			}
		})();
		if (uri) {
			return '<img class="copilot-logo" src="' + uri + '" alt="" aria-hidden="true" />';
		}
		return (
			'<svg class="copilot-logo-svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
			'<rect x="3" y="3" width="10" height="9" rx="2" />' +
			'<path d="M6 12v1" />' +
			'<path d="M10 12v1" />' +
			'<circle cx="6.5" cy="7" r=".8" fill="currentColor" stroke="none" />' +
			'<circle cx="9.5" cy="7" r=".8" fill="currentColor" stroke="none" />' +
			'<path d="M6.2 9.2c.6.5 1.2.8 1.8.8s1.2-.3 1.8-.8" />' +
			'</svg>'
		);
	}

	function __kustoCopilotChatHtml(boxId) {
		const icon = __kustoCopilotLogoHtml();
		const modelDropdown = (() => {
			try {
				if (window.__kustoDropdown && typeof window.__kustoDropdown.renderMenuDropdownHtml === 'function') {
					return window.__kustoDropdown.renderMenuDropdownHtml({
						wrapperClass: 'kusto-copilot-chat-model-dropdown kusto-dropdown-tooltip-label',
						// No generic tooltip; we show the selected model name and per-item tooltips instead.
						title: '',
						includeHiddenSelect: true,
						selectId: boxId + '_copilot_model',
						onChange: "try{if(typeof __kustoSetLastOptimizeModelId==='function'){__kustoSetLastOptimizeModelId(this.value)}}catch{}",
						buttonId: boxId + '_copilot_model_btn',
						buttonTextId: boxId + '_copilot_model_btn_text',
						menuId: boxId + '_copilot_model_menu',
						placeholder: 'Select model...',
						onToggle:
							"try{window.__kustoDropdown&&window.__kustoDropdown.toggleSelectMenu&&window.__kustoDropdown.toggleSelectMenu('" +
							boxId +
							"_copilot_model')}catch{}"
					});
				}
			} catch {
				// ignore
			}
			return (
				'<div class="select-wrapper">' +
					'<select id="' + boxId + '_copilot_model" aria-label="Copilot model"></select>' +
				'</div>'
			);
		})();
		return (
			'<div class="kusto-copilot-chat" id="' + boxId + '_copilot_chat" data-kusto-no-editor-focus="true">' +
				'<div class="kusto-copilot-chat-header">' +
					'<div class="kusto-copilot-chat-title" title="Copilot Chat">' + icon + '<span>Copilot Chat</span></div>' +
					'<div class="kusto-copilot-chat-model">' +
						'<label for="' + boxId + '_copilot_model">Model</label>' +
						modelDropdown +
					'</div>' +
				'</div>' +
				'<div class="kusto-copilot-chat-messages" id="' + boxId + '_copilot_messages" aria-live="polite"></div>' +
				'<div class="kusto-copilot-chat-input">' +
					'<textarea id="' + boxId + '_copilot_input" rows="2" placeholder="Ask Copilot to write a Kusto query…" spellcheck="true"></textarea>' +
					'<div class="kusto-copilot-chat-actions">' +
						'<button type="button" id="' + boxId + '_copilot_send" class="kusto-copilot-chat-send" onclick="__kustoCopilotWriteQuerySend(\'' + boxId + '\')">Send</button>' +
						'<button type="button" id="' + boxId + '_copilot_tools_btn" class="kusto-copilot-chat-tools" onclick="__kustoCopilotToggleToolsPanel(\'' + boxId + '\')">Tools</button>' +
						'<button type="button" id="' + boxId + '_copilot_cancel" class="kusto-copilot-chat-cancel" style="display:none;" onclick="__kustoCopilotWriteQueryCancel(\'' + boxId + '\')">Cancel</button>' +
					'</div>' +
				'</div>' +
				'<div class="kusto-copilot-tools-panel" id="' + boxId + '_copilot_tools_panel" style="display:none;" data-kusto-no-editor-focus="true">' +
					'<div class="kusto-copilot-tools-panel-title">Tools (next message)</div>' +
					'<div class="kusto-copilot-tools-list" id="' + boxId + '_copilot_tools_list"></div>' +
				'</div>' +
			'</div>'
		);
	}

	function __kustoSafeToolDomId(name) {
		return String(name || '').replace(/[^a-zA-Z0-9_\-]/g, '_');
	}

	function __kustoGetDefaultEnabledTools(tools) {
		const list = Array.isArray(tools) ? tools : [];
		const enabled = [];
		for (const t of list) {
			if (!t || !t.name) continue;
			const byDefault = (typeof t.enabledByDefault === 'boolean') ? !!t.enabledByDefault : true;
			if (byDefault) enabled.push(String(t.name));
		}
		return enabled;
	}

	function __kustoSetCopilotToolsOptions(boxId, tools) {
		const id = String(boxId || '').trim();
		if (!id) return;
		const stateByBox = __kustoEnsureCopilotToolSelectionState();
		stateByBox[id] = stateByBox[id] || {};
		stateByBox[id].tools = Array.isArray(tools) ? tools : [];
		// If the user has already modified selection for this conversation, preserve it.
		if (!stateByBox[id].userModified) {
			stateByBox[id].enabledNext = __kustoGetDefaultEnabledTools(stateByBox[id].tools);
		} else {
			// Keep only tools that still exist.
			try {
				const known = new Set((stateByBox[id].tools || []).map(t => String((t && t.name) || '')));
				stateByBox[id].enabledNext = (Array.isArray(stateByBox[id].enabledNext) ? stateByBox[id].enabledNext : [])
					.map(String)
					.filter(n => n && known.has(String(n)));
			} catch { /* ignore */ }
		}
		try { __kustoRenderCopilotToolsPanel(id); } catch { /* ignore */ }
	}

	function __kustoGetEnabledToolsForNextMessage(boxId) {
		const id = String(boxId || '').trim();
		if (!id) return [];
		const stateByBox = __kustoEnsureCopilotToolSelectionState();
		const st = stateByBox[id] || {};
		const tools = Array.isArray(st.tools) ? st.tools : [];
		const enabled = Array.isArray(st.enabledNext) ? st.enabledNext : __kustoGetDefaultEnabledTools(tools);
		const known = new Set(tools.map(t => String((t && t.name) || '')));
		return enabled.map(String).filter(n => n && known.has(String(n)));
	}

	function __kustoResetEnabledToolsForNextMessage(boxId) {
		const id = String(boxId || '').trim();
		if (!id) return;
		const stateByBox = __kustoEnsureCopilotToolSelectionState();
		const st = stateByBox[id] || {};
		const tools = Array.isArray(st.tools) ? st.tools : [];
		st.enabledNext = __kustoGetDefaultEnabledTools(tools);
		stateByBox[id] = st;
		try { __kustoRenderCopilotToolsPanel(id); } catch { /* ignore */ }
	}

	function __kustoRenderCopilotToolsPanel(boxId) {
		const id = String(boxId || '').trim();
		if (!id) return;
		const listHost = document.getElementById(id + '_copilot_tools_list');
		const toolsBtn = document.getElementById(id + '_copilot_tools_btn');
		if (!listHost) return;
		const stateByBox = __kustoEnsureCopilotToolSelectionState();
		const st = stateByBox[id] || {};
		const tools = Array.isArray(st.tools) ? st.tools : [];
		const enabled = new Set(__kustoGetEnabledToolsForNextMessage(id));

		try { listHost.innerHTML = ''; } catch { /* ignore */ }

		if (!tools || tools.length === 0) {
			try {
				if (toolsBtn) toolsBtn.disabled = true;
				if (toolsBtn) {
					toolsBtn.classList.remove('is-active');
					toolsBtn.setAttribute('aria-pressed', 'false');
				}
				const panel = document.getElementById(id + '_copilot_tools_panel');
				if (panel) panel.style.display = 'none';
			} catch { /* ignore */ }
			return;
		}
		try {
			if (toolsBtn) {
				toolsBtn.disabled = false;
				if (!toolsBtn.hasAttribute('aria-pressed')) {
					toolsBtn.setAttribute('aria-pressed', 'false');
				}
			}
		} catch { /* ignore */ }

		for (const t of tools) {
			if (!t || !t.name) continue;
			const name = String(t.name);
			const label = String(t.label || t.name);
			const desc = String(t.description || '');

			const row = document.createElement('label');
			row.className = 'kusto-copilot-tool-item';
			row.setAttribute('data-kusto-no-editor-focus', 'true');

			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.className = 'kusto-copilot-tool-checkbox';
			cb.id = id + '_copilot_tool_' + __kustoSafeToolDomId(name);
			cb.checked = enabled.has(name);
			cb.onchange = () => {
				try {
					const next = __kustoEnsureCopilotToolSelectionState();
					next[id] = next[id] || {};
					next[id].userModified = true;
					next[id].enabledNext = __kustoGetEnabledToolsForNextMessage(id);
					const arr = next[id].enabledNext;
					const idx = arr.indexOf(name);
					if (cb.checked) {
						if (idx < 0) arr.push(name);
					} else {
						if (idx >= 0) arr.splice(idx, 1);
					}
				} catch { /* ignore */ }
			};

			const textWrap = document.createElement('span');
			textWrap.className = 'kusto-copilot-tool-text';
			const titleEl = document.createElement('span');
			titleEl.className = 'kusto-copilot-tool-name';
			titleEl.textContent = label;
			textWrap.appendChild(titleEl);
			if (desc) {
				const descEl = document.createElement('span');
				descEl.className = 'kusto-copilot-tool-desc';
				descEl.textContent = desc;
				textWrap.appendChild(descEl);
			}

			row.appendChild(cb);
			row.appendChild(textWrap);
			listHost.appendChild(row);
		}
	}

	function __kustoClampNumber(value, min, max) {
		const n = typeof value === 'number' ? value : parseInt(String(value || ''), 10);
		if (!Number.isFinite(n)) return min;
		if (typeof max === 'number' && Number.isFinite(max)) {
			return Math.max(min, Math.min(max, n));
		}
		return Math.max(min, n);
	}

	function __kustoGetCopilotChatWidthPx(boxId) {
		const id = String(boxId || '').trim();
		if (!id) return undefined;
		try {
			const map = __kustoEnsureCopilotChatWidthState();
			const v = map[id];
			if (typeof v === 'number' && Number.isFinite(v)) return v;
		} catch { /* ignore */ }
		try {
			const pane = document.getElementById(id + '_copilot_chat_pane');
			if (!pane) return undefined;
			const w = Math.round(pane.getBoundingClientRect().width || 0);
			return w > 0 ? w : undefined;
		} catch {
			return undefined;
		}
	}

	function __kustoSetCopilotChatWidthPx(boxId, widthPx) {
		const id = String(boxId || '').trim();
		if (!id) return;
		let max;
		try {
			const split = document.getElementById(id + '_copilot_split');
			if (split) {
				const total = Math.round(split.getBoundingClientRect().width || 0);
				if (total > 0) {
					max = Math.max(MIN_CHAT_WIDTH_PX, total - MIN_EDITOR_WIDTH_PX);
				}
			}
		} catch { /* ignore */ }
		const next = __kustoClampNumber(widthPx, MIN_CHAT_WIDTH_PX, max);
		try {
			const pane = document.getElementById(id + '_copilot_chat_pane');
			if (pane && pane.style) {
				pane.style.width = next + 'px';
				pane.style.flex = '0 0 ' + next + 'px';
			}
		} catch { /* ignore */ }
		try {
			const map = __kustoEnsureCopilotChatWidthState();
			map[id] = next;
		} catch { /* ignore */ }
		try {
			const editor = queryEditors && queryEditors[id];
			if (editor && typeof editor.layout === 'function') {
				editor.layout();
			}
		} catch { /* ignore */ }
	}

	function __kustoAppendChatMessage(boxId, role, text) {
		try {
			const host = document.getElementById(boxId + '_copilot_messages');
			if (!host) return;
			const safeRole = role === 'user' ? 'user' : 'assistant';
			const el = document.createElement('div');
			el.className = 'kusto-copilot-chat-msg kusto-copilot-chat-msg-' + safeRole;
			el.textContent = String(text || '');
			host.appendChild(el);
			try { host.scrollTop = host.scrollHeight; } catch { /* ignore */ }
		} catch {
			// ignore
		}
	}

	function __kustoAppendToolResponse(boxId, toolName, label, jsonText) {
		try {
			const host = document.getElementById(boxId + '_copilot_messages');
			if (!host) return;
			const safeTool = String(toolName || '').trim() || 'tool';
			const safeLabel = String(label || '').trim() || safeTool;
			const json = String(jsonText || '');

			const state = __kustoEnsureCopilotToolResponseState();
			state[boxId] = state[boxId] || { seq: 0 };
			state[boxId].seq = (state[boxId].seq || 0) + 1;
			const seq = state[boxId].seq;
			const preId = boxId + '_copilot_tool_json_' + seq;
			const linkId = boxId + '_copilot_tool_link_' + seq;

			const wrapper = document.createElement('div');
			wrapper.className = 'kusto-copilot-chat-msg kusto-copilot-chat-msg-assistant';
			wrapper.setAttribute('data-kusto-no-editor-focus', 'true');

			const header = document.createElement('div');
			header.className = 'kusto-copilot-tool-header';
			header.textContent = `${safeTool}: ${safeLabel} `;

			const link = document.createElement('a');
			link.href = '#';
			link.id = linkId;
			link.className = 'kusto-copilot-tool-link';
			link.textContent = 'View JSON';
			link.onclick = (e) => {
				try { e.preventDefault(); } catch { /* ignore */ }
				try {
					const pre = document.getElementById(preId);
					if (!pre) return;
					const isHidden = (pre.style.display === 'none' || !pre.style.display);
					pre.style.display = isHidden ? 'block' : 'none';
					link.textContent = isHidden ? 'Hide JSON' : 'View JSON';
				} catch { /* ignore */ }
				return false;
			};
			header.appendChild(link);

			const pre = document.createElement('pre');
			pre.id = preId;
			pre.className = 'kusto-copilot-tool-json';
			pre.style.display = 'none';
			pre.textContent = json;

			wrapper.appendChild(header);
			wrapper.appendChild(pre);
			host.appendChild(wrapper);
			try { host.scrollTop = host.scrollHeight; } catch { /* ignore */ }
		} catch {
			// ignore
		}
	}

	function __kustoSetCopilotChatRunning(boxId, running, statusText) {
		const stateByBox = __kustoEnsureCopilotChatState();
		try {
			stateByBox[boxId] = stateByBox[boxId] || {};
			stateByBox[boxId].running = !!running;
		} catch { /* ignore */ }

		try {
			const sendBtn = document.getElementById(boxId + '_copilot_send');
			const cancelBtn = document.getElementById(boxId + '_copilot_cancel');
			const toolsBtn = document.getElementById(boxId + '_copilot_tools_btn');
			const input = document.getElementById(boxId + '_copilot_input');
			const modelSel = document.getElementById(boxId + '_copilot_model');
			if (sendBtn) sendBtn.disabled = !!running;
			if (toolsBtn) toolsBtn.disabled = !!running || !!toolsBtn.disabled;
			if (input) input.disabled = !!running;
			if (modelSel) modelSel.disabled = !!running;
			if (cancelBtn) {
				cancelBtn.style.display = running ? '' : 'none';
				cancelBtn.disabled = !running;
			}
			try {
				const panel = document.getElementById(boxId + '_copilot_tools_panel');
				if (panel) {
					const inputs = panel.querySelectorAll ? panel.querySelectorAll('input') : [];
					for (const el of inputs) {
						try { el.disabled = !!running; } catch { /* ignore */ }
					}
				}
			} catch { /* ignore */ }
		} catch { /* ignore */ }

		if (statusText) {
			__kustoAppendChatMessage(boxId, 'assistant', String(statusText));
		}
	}

	function __kustoApplyModelOptions(boxId, models, selectedModelId) {
		try {
			const sel = document.getElementById(boxId + '_copilot_model');
			if (!sel) return;
			sel.innerHTML = '';
			// Ensure placeholder exists (needed for menu-dropdown button text when no selection yet).
			try {
				const ph = document.createElement('option');
				ph.value = '';
				ph.textContent = 'Select model...';
				ph.disabled = true;
				ph.selected = true;
				sel.appendChild(ph);
			} catch { /* ignore */ }
			const safeModels = Array.isArray(models) ? models : [];
			for (const m of safeModels) {
				if (!m || !m.id) continue;
				const opt = document.createElement('option');
				opt.value = String(m.id);
				opt.textContent = String(m.label || m.id);
				sel.appendChild(opt);
			}

			// Prefer the shared cached model id (same key as optimize).
			let preferred = '';
			try {
				if (typeof __kustoGetLastOptimizeModelId === 'function') {
					preferred = String(__kustoGetLastOptimizeModelId() || '');
				}
			} catch { /* ignore */ }

			const hasPreferred = preferred && Array.from(sel.options).some(o => o.value === preferred);
			if (hasPreferred) {
				sel.value = preferred;
			} else if (selectedModelId) {
				sel.value = String(selectedModelId);
			}
			if (!sel.value && sel.options.length > 0) {
				// keep placeholder selected
				sel.selectedIndex = 0;
			}

			sel.onchange = () => {
				try {
					if (typeof __kustoSetLastOptimizeModelId === 'function') {
						__kustoSetLastOptimizeModelId(sel.value);
					}
				} catch { /* ignore */ }
				try {
					if (window.__kustoDropdown && typeof window.__kustoDropdown.syncSelectBackedDropdown === 'function') {
						window.__kustoDropdown.syncSelectBackedDropdown(boxId + '_copilot_model');
					}
				} catch { /* ignore */ }
			};

			// If we're using the menu-dropdown wrapper, sync it now.
			try {
				if (window.__kustoDropdown && typeof window.__kustoDropdown.syncSelectBackedDropdown === 'function') {
					window.__kustoDropdown.syncSelectBackedDropdown(boxId + '_copilot_model');
				}
			} catch { /* ignore */ }
		} catch {
			// ignore
		}
	}

	function __kustoSetQueryText(boxId, queryText) {
		try {
			const editor = queryEditors && queryEditors[boxId];
			if (!editor) return;
			const model = editor.getModel && editor.getModel();
			if (!model) return;

			let next = String(queryText || '');
			try {
				if (typeof window.__kustoPrettifyKustoText === 'function') {
					next = window.__kustoPrettifyKustoText(next);
				}
			} catch { /* ignore */ }

			editor.executeEdits('copilot', [{ range: model.getFullModelRange(), text: next }]);
			editor.focus();
			try { schedulePersist && schedulePersist('copilotWriteQuery'); } catch { /* ignore */ }
		} catch {
			// ignore
		}
	}

	function __kustoInstallCopilotChat(boxId) {
		try {
			const wrapper = document.getElementById(boxId + '_query_editor');
			if (!wrapper) return;
			const editorWrapper = wrapper.closest ? wrapper.closest('.query-editor-wrapper') : null;
			if (!editorWrapper) return;

			if (document.getElementById(boxId + '_copilot_chat')) {
				return;
			}

			// Convert the query editor wrapper into a side-by-side split:
			// left = existing query editor UI, right = Copilot chat.
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
			let queryResizerEl = null;
			for (const n of existingChildren) {
				try {
					if (n && n.nodeType === 1) {
						const el = n;
						if (el.id && el.id === (boxId + '_query_resizer')) {
							queryResizerEl = el;
							continue;
						}
					}
				} catch { /* ignore */ }
				try { editorPane.appendChild(n); } catch { /* ignore */ }
			}

			// Rebuild wrapper.
			try { editorWrapper.innerHTML = ''; } catch { /* ignore */ }
			// Order matters: editor (left) -> splitter -> chat (right).
			split.appendChild(editorPane);
			split.appendChild(splitter);

			const chatPane = document.createElement('div');
			chatPane.className = 'kusto-copilot-chat-pane';
			chatPane.id = boxId + '_copilot_chat_pane';
			chatPane.style.width = DEFAULT_CHAT_WIDTH_PX + 'px';
			chatPane.style.flex = '0 0 ' + DEFAULT_CHAT_WIDTH_PX + 'px';
			chatPane.insertAdjacentHTML('beforeend', __kustoCopilotChatHtml(boxId));
			split.appendChild(chatPane);

			editorWrapper.appendChild(split);
			// Hoist the vertical query resizer to the wrapper level so it resizes
			// the entire split (chat + editor), not just the editor pane.
			try {
				if (queryResizerEl) {
					editorWrapper.appendChild(queryResizerEl);
				}
			} catch { /* ignore */ }

			// Restore persisted width if available.
			try {
				const persisted = __kustoGetCopilotChatWidthPx(boxId);
				if (typeof persisted === 'number' && Number.isFinite(persisted)) {
					__kustoSetCopilotChatWidthPx(boxId, persisted);
				}
			} catch { /* ignore */ }

			// Splitter drag behavior (reuses the same visual affordance as section resizers).
			try {
				splitter.addEventListener('mousedown', (e) => {
					try {
						e.preventDefault();
						e.stopPropagation();
					} catch { /* ignore */ }

					splitter.classList.add('is-dragging');
					const previousCursor = document.body.style.cursor;
					const previousUserSelect = document.body.style.userSelect;
					document.body.style.cursor = 'ew-resize';
					document.body.style.userSelect = 'none';

					const startX = e.clientX;
					let startW = DEFAULT_CHAT_WIDTH_PX;
					try {
						startW = Math.round(chatPane.getBoundingClientRect().width || DEFAULT_CHAT_WIDTH_PX);
					} catch { /* ignore */ }

					const onMove = (moveEvent) => {
						// Chat is on the right. Dragging right shrinks the chat, dragging left grows it.
						const delta = (moveEvent.clientX - startX);
						let max;
						try {
							const total = Math.round(split.getBoundingClientRect().width || 0);
							if (total > 0) {
								max = Math.max(MIN_CHAT_WIDTH_PX, total - MIN_EDITOR_WIDTH_PX);
							}
						} catch { /* ignore */ }
						const next = __kustoClampNumber(startW - delta, MIN_CHAT_WIDTH_PX, max);
						try {
							chatPane.style.width = next + 'px';
							chatPane.style.flex = '0 0 ' + next + 'px';
						} catch { /* ignore */ }
						try {
							const map = __kustoEnsureCopilotChatWidthState();
							map[boxId] = next;
						} catch { /* ignore */ }
						try {
							const editor = queryEditors && queryEditors[boxId];
							if (editor && typeof editor.layout === 'function') editor.layout();
						} catch { /* ignore */ }
					};
					const onUp = () => {
						document.removeEventListener('mousemove', onMove, true);
						document.removeEventListener('mouseup', onUp, true);
						splitter.classList.remove('is-dragging');
						document.body.style.cursor = previousCursor;
						document.body.style.userSelect = previousUserSelect;
						try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
					};

					document.addEventListener('mousemove', onMove, true);
					document.addEventListener('mouseup', onUp, true);
				});
			} catch {
				// ignore
			}

			__kustoSetCopilotChatRunning(boxId, false);
			__kustoAppendChatMessage(boxId, 'assistant', 'Describe what you want, and I will generate a full Kusto query and run it.');

			// Ask extension for model list + default selection.
			try {
				vscode.postMessage({ type: 'prepareCopilotWriteQuery', boxId: String(boxId || '') });
			} catch { /* ignore */ }

	// Expose get/set for persistence restore.
	window.__kustoGetCopilotChatWidthPx = __kustoGetCopilotChatWidthPx;
	window.__kustoSetCopilotChatWidthPx = __kustoSetCopilotChatWidthPx;
		} catch {
			// ignore
		}
	}

	function __kustoGetCopilotChatVisible(boxId) {
		const id = String(boxId || '').trim();
		if (!id) return false;
		try {
			const map = __kustoEnsureCopilotChatVisibilityState();
			if (typeof map[id] === 'boolean') {
				return !!map[id];
			}
		} catch { /* ignore */ }
		// Default: hidden unless explicitly enabled.
		return false;
	}

	function __kustoSetCopilotChatVisible(boxId, visible) {
		const id = String(boxId || '').trim();
		if (!id) return;
		const next = !!visible;
		try {
			const map = __kustoEnsureCopilotChatVisibilityState();
			map[id] = next;
		} catch { /* ignore */ }

		// Ensure UI exists before showing.
		if (next) {
			try { __kustoInstallCopilotChat(id); } catch { /* ignore */ }
		}

		try {
			const split = document.getElementById(id + '_copilot_split');
			if (split && split.classList) {
				split.classList.toggle(COPILOT_VISIBILITY_CLASS_HIDDEN, !next);
			}
		} catch { /* ignore */ }

		__kustoSetCopilotToggleButtonState(id, next);

		try {
			const editor = queryEditors && queryEditors[id];
			if (editor && typeof editor.layout === 'function') {
				editor.layout();
			}
		} catch { /* ignore */ }
		try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
	}

	// Toolbar handler.
	window.__kustoToggleCopilotChatForBox = function (boxId) {
		const id = String(boxId || '').trim();
		if (!id) return;
		const visible = __kustoGetCopilotChatVisible(id);
		__kustoSetCopilotChatVisible(id, !visible);
	};

	// Persistence helpers.
	window.__kustoGetCopilotChatVisible = __kustoGetCopilotChatVisible;
	window.__kustoSetCopilotChatVisible = __kustoSetCopilotChatVisible;

	window.addCopilotQueryBox = function addCopilotQueryBox(options) {
		const id = addQueryBox(options || {});
		try {
			const kinds = __kustoEnsureQueryBoxKindMap();
			kinds[id] = COPILOT_QUERY_KIND;
		} catch { /* ignore */ }
		try {
			__kustoInstallCopilotChat(id);
			__kustoSetCopilotChatVisible(id, true);
		} catch { /* ignore */ }
		return id;
	};

	window.__kustoCopilotWriteQuerySend = function __kustoCopilotWriteQuerySend(boxId) {
		const id = String(boxId || '').trim();
		if (!id) return;

		const stateByBox = __kustoEnsureCopilotChatState();
		if (stateByBox[id] && stateByBox[id].running) {
			return;
		}

		const inputEl = document.getElementById(id + '_copilot_input');
		const prompt = inputEl ? String(inputEl.value || '').trim() : '';
		if (!prompt) {
			__kustoAppendChatMessage(id, 'assistant', 'Type what you want the query to do, then press Send.');
			return;
		}

		// Gather context.
		const connectionId = (document.getElementById(id + '_connection') || {}).value || '';
		const database = (document.getElementById(id + '_database') || {}).value || '';
		if (!connectionId) {
			__kustoAppendChatMessage(id, 'assistant', 'Select a cluster connection first.');
			return;
		}
		if (!database) {
			__kustoAppendChatMessage(id, 'assistant', 'Select a database first.');
			return;
		}

		let currentQuery = '';
		try {
			const editor = queryEditors && queryEditors[id];
			currentQuery = editor ? (editor.getValue() || '') : '';
		} catch { /* ignore */ }

		const modelId = (document.getElementById(id + '_copilot_model') || {}).value || '';
		try {
			if (typeof __kustoSetLastOptimizeModelId === 'function') {
				__kustoSetLastOptimizeModelId(modelId);
			}
		} catch { /* ignore */ }

		try {
			__kustoAppendChatMessage(id, 'user', prompt);
			if (inputEl) inputEl.value = '';
		} catch { /* ignore */ }

		__kustoSetCopilotChatRunning(id, true, 'Working…');

		try {
			const enabledTools = __kustoGetEnabledToolsForNextMessage(id);
			vscode.postMessage({
				type: 'startCopilotWriteQuery',
				boxId: id,
				connectionId: String(connectionId || ''),
				database: String(database || ''),
				currentQuery: String(currentQuery || ''),
				request: String(prompt || ''),
				modelId: String(modelId || ''),
				enabledTools
			});
			// Do not reset: tool selection persists for this conversation.
		} catch {
			__kustoSetCopilotChatRunning(id, false, 'Failed to start Copilot request.');
		}
	};

	window.__kustoCopilotWriteQueryCancel = function __kustoCopilotWriteQueryCancel(boxId) {
		const id = String(boxId || '').trim();
		if (!id) return;
		try {
			const stateByBox = __kustoEnsureCopilotChatState();
			if (!stateByBox[id] || !stateByBox[id].running) {
				return;
			}
		} catch { /* ignore */ }
		try {
			vscode.postMessage({ type: 'cancelCopilotWriteQuery', boxId: id });
		} catch { /* ignore */ }
		try {
			const cancelBtn = document.getElementById(id + '_copilot_cancel');
			if (cancelBtn) cancelBtn.disabled = true;
		} catch { /* ignore */ }
	};

	window.__kustoDisposeCopilotQueryBox = function __kustoDisposeCopilotQueryBox(boxId) {
		const id = String(boxId || '').trim();
		if (!id) return;
		try {
			vscode.postMessage({ type: 'cancelCopilotWriteQuery', boxId: id });
		} catch { /* ignore */ }
		try {
			const kinds = __kustoEnsureQueryBoxKindMap();
			delete kinds[id];
		} catch { /* ignore */ }
		try {
			const stateByBox = __kustoEnsureCopilotChatState();
			delete stateByBox[id];
		} catch { /* ignore */ }
		try {
			const toolState = __kustoEnsureCopilotToolSelectionState();
			delete toolState[id];
		} catch { /* ignore */ }
	};

	// Called by main.js message handler.
	window.__kustoCopilotApplyWriteQueryOptions = function (boxId, models, selectedModelId, tools) {
		__kustoApplyModelOptions(String(boxId || ''), models, selectedModelId);
		try { __kustoSetCopilotToolsOptions(String(boxId || ''), tools || []); } catch { /* ignore */ }
	};

	window.__kustoCopilotToggleToolsPanel = function __kustoCopilotToggleToolsPanel(boxId) {
		const id = String(boxId || '').trim();
		if (!id) return;
		try {
			const panel = document.getElementById(id + '_copilot_tools_panel');
			const btn = document.getElementById(id + '_copilot_tools_btn');
			if (!panel) return;
			try { __kustoRenderCopilotToolsPanel(id); } catch { /* ignore */ }
			const isHidden = (panel.style.display === 'none');
			const nextVisible = !!isHidden;
			panel.style.display = nextVisible ? 'block' : 'none';
			try {
				if (btn) {
					btn.classList.toggle('is-active', nextVisible);
					btn.setAttribute('aria-pressed', nextVisible ? 'true' : 'false');
				}
			} catch { /* ignore */ }
		} catch { /* ignore */ }
	};
	window.__kustoCopilotWriteQueryStatus = function (boxId, text) {
		__kustoAppendChatMessage(String(boxId || ''), 'assistant', String(text || ''));
	};
	window.__kustoCopilotWriteQuerySetQuery = function (boxId, queryText) {
		__kustoSetQueryText(String(boxId || ''), queryText);
	};
	window.__kustoCopilotWriteQueryDone = function (boxId, ok, message) {
		const id = String(boxId || '').trim();
		__kustoSetCopilotChatRunning(id, false);
		if (message) {
			__kustoAppendChatMessage(id, 'assistant', String(message || ''));
		}
	};

	// Called by main.js when the host returns a local tool payload.
	window.__kustoCopilotWriteQueryToolResult = function (boxId, toolName, label, jsonText) {
		__kustoAppendToolResponse(String(boxId || ''), String(toolName || ''), String(label || ''), String(jsonText || ''));
	};
})();
