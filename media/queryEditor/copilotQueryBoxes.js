// Copilot chat for Kusto Query boxes.
//
// This integrates a Copilot chat pane into a normal query box:
// - It reuses addQueryBox() for the core KQL editor + results UI.
// - Copilot chat is toggled per query box via the toolbar.
// - Legacy `copilotQuery` persisted sections are supported for back-compat only.

(function () {
	const COPILOT_QUERY_KIND = 'copilotQuery';
	const DEFAULT_CHAT_WIDTH_PX = 720;
	const MIN_CHAT_WIDTH_PX = 160;
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

	// Global tracker for currently visible tooltip to prevent overlaps
	let __kustoCurrentVisibleTooltip = null;
	let __kustoCurrentHideTimeout = null;

	// Helper to set up hover tooltip behavior with fixed positioning
	function __kustoSetupToolTooltip(wrapper, tooltip) {
		const TOOLTIP_WIDTH = 350; // matches CSS width
		const TOOLTIP_GAP = 8;
		const HIDE_DELAY = 300; // enough time to move mouse to tooltip
		const showTooltip = (e) => {
			try {
				// Hide any previously visible tooltip immediately
				if (__kustoCurrentVisibleTooltip && __kustoCurrentVisibleTooltip !== tooltip) {
					__kustoCurrentVisibleTooltip.classList.remove('is-visible');
				}
				if (__kustoCurrentHideTimeout) {
					clearTimeout(__kustoCurrentHideTimeout);
					__kustoCurrentHideTimeout = null;
				}
				const rect = wrapper.getBoundingClientRect();
				const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
				// Check if tooltip would go off right edge
				const rightPosition = rect.right + TOOLTIP_GAP + TOOLTIP_WIDTH;
				if (rightPosition > viewportWidth) {
					// Position to the left of the wrapper
					tooltip.style.left = Math.max(0, rect.left - TOOLTIP_GAP - TOOLTIP_WIDTH) + 'px';
				} else {
					// Position to the right of the wrapper
					tooltip.style.left = (rect.right + TOOLTIP_GAP) + 'px';
				}
				// Also check vertical positioning
				const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
				const tooltipHeight = 300; // max-height from CSS
				if (rect.top + tooltipHeight > viewportHeight) {
					tooltip.style.top = Math.max(0, viewportHeight - tooltipHeight - 8) + 'px';
				} else {
					tooltip.style.top = rect.top + 'px';
				}
				tooltip.classList.add('is-visible');
				__kustoCurrentVisibleTooltip = tooltip;
			} catch { /* ignore */ }
		};
		const cancelHide = () => {
			try {
				if (__kustoCurrentHideTimeout) {
					clearTimeout(__kustoCurrentHideTimeout);
					__kustoCurrentHideTimeout = null;
				}
			} catch { /* ignore */ }
		};
		const hideTooltip = () => {
			try {
				__kustoCurrentHideTimeout = setTimeout(() => {
					tooltip.classList.remove('is-visible');
					if (__kustoCurrentVisibleTooltip === tooltip) {
						__kustoCurrentVisibleTooltip = null;
					}
				}, HIDE_DELAY);
			} catch { /* ignore */ }
		};
		wrapper.addEventListener('mouseenter', showTooltip);
		wrapper.addEventListener('mousemove', showTooltip);
		wrapper.addEventListener('mouseleave', hideTooltip);
		// Allow hovering over the tooltip itself to keep it visible and scroll
		tooltip.addEventListener('mouseenter', cancelHide);
		tooltip.addEventListener('mouseleave', hideTooltip);
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
		const modelDropdown = (() => {
			try {
				if (window.__kustoDropdown && typeof window.__kustoDropdown.renderMenuDropdownHtml === 'function') {
					// Small sparkle icon shown beside (or instead of) the model name.
					const modelIconSvg = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3.18 8l1.83-.55L5.56 5.6a.3.3 0 0 1 .57 0l.55 1.85L8.5 8a.3.3 0 0 1 0 .57l-1.83.55-.55 1.84a.3.3 0 0 1-.57 0l-.55-1.84L3.18 8.57a.3.3 0 0 1 0-.57ZM9.14 3l1.16-.35.35-1.17a.19.19 0 0 1 .37 0l.35 1.17L12.53 3a.19.19 0 0 1 0 .36l-1.16.35-.35 1.17a.19.19 0 0 1-.37 0l-.35-1.17L9.14 3.36a.19.19 0 0 1 0-.36ZM9.14 11l1.16-.35.35-1.17a.19.19 0 0 1 .37 0l.35 1.17 1.16.35a.19.19 0 0 1 0 .36l-1.16.35-.35 1.17a.19.19 0 0 1-.37 0l-.35-1.17-1.16-.35a.19.19 0 0 1 0-.36Z"/></svg>';
					return window.__kustoDropdown.renderMenuDropdownHtml({
						wrapperClass: 'kusto-copilot-chat-model-dropdown kusto-dropdown-tooltip-label',
						// No generic tooltip; we show the selected model name and per-item tooltips instead.
						title: '',
						iconSvg: modelIconSvg,
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
					'<div class="kusto-copilot-chat-title" title="Chat"><span>CHAT</span></div>' +
					'<div class="kusto-copilot-chat-header-actions">' +
						'<button type="button" id="' + boxId + '_copilot_clear_btn" class="unified-btn-secondary kusto-copilot-chat-clear" onclick="__kustoCopilotClearConversation(\'' + boxId + '\')" title="Clear conversation history">' +
							'<span class="codicon codicon-clear-all" aria-hidden="true"></span>' +
						'</button>' +
						'<button type="button" class="unified-btn-secondary kusto-copilot-chat-close" onclick="__kustoToggleCopilotChatForBox(\'' + boxId + '\')" title="Close chat">' +
							'<span class="codicon codicon-close" aria-hidden="true"></span>' +
						'</button>' +
					'</div>' +
				'</div>' +
				'<div class="kusto-copilot-chat-messages" id="' + boxId + '_copilot_messages" aria-live="polite"></div>' +
				'<div class="kusto-copilot-chat-input-resizer" id="' + boxId + '_copilot_input_resizer" title="Drag to resize input area"></div>' +
				'<div class="kusto-copilot-chat-input">' +
					'<textarea id="' + boxId + '_copilot_input" rows="1" style="height:32px" placeholder="Ask Copilot\u2026" spellcheck="true"></textarea>' +
					'<div class="kusto-copilot-chat-input-bar">' +
						'<div class="kusto-copilot-chat-input-bar-left">' +
							modelDropdown +
							'<div class="kusto-copilot-tools-container">' +
								'<button type="button" id="' + boxId + '_copilot_tools_btn" class="unified-btn-secondary kusto-copilot-chat-tools" onclick="__kustoCopilotToggleToolsPanel(\'' + boxId + '\')" aria-pressed="false" title="Tools">' +
									'<span class="codicon codicon-tools" aria-hidden="true"></span>' +
								'</button>' +
								'<div class="kusto-copilot-tools-panel" id="' + boxId + '_copilot_tools_panel" style="display:none;" data-kusto-no-editor-focus="true">' +
									'<div class="kusto-copilot-tools-panel-title">Tools (next message)</div>' +
									'<div class="kusto-copilot-tools-list" id="' + boxId + '_copilot_tools_list"></div>' +
								'</div>' +
							'</div>' +
						'</div>' +
						'<button type="button" id="' + boxId + '_copilot_send" class="kusto-copilot-chat-send-icon" onclick="__kustoCopilotWriteQuerySend(\'' + boxId + '\')" title="Send (Enter)">' +
							'<svg class="kusto-copilot-icon-send" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M1.724 1.053a.5.5 0 0 0-.714.545l1.403 4.85a.5.5 0 0 0 .397.354l5.69.953c.268.053.268.437 0 .49l-5.69.953a.5.5 0 0 0-.397.354l-1.403 4.85a.5.5 0 0 0 .714.545l13-6.5a.5.5 0 0 0 0-.894l-13-6.5Z"/></svg>' +
							'<svg class="kusto-copilot-icon-stop" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>' +
						'</button>' +
					'</div>' +
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

		const FINAL_TOOL_NAMES = new Set([
			'respond_to_query_performance_optimization_request',
			'respond_to_all_other_queries',
			'ask_user_clarifying_question'
		]);

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

		function appendGroupHeader(title, isFirst) {
			const header = document.createElement('div');
			header.className = 'kusto-copilot-tools-group-title' + (isFirst ? ' is-first' : '');
			header.textContent = String(title || '');
			listHost.appendChild(header);
		}

		function appendToolItem(t) {
			if (!t || !t.name) return;
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

		const finalTools = [];
		const optionalTools = [];
		for (const t of tools) {
			if (!t || !t.name) continue;
			if (FINAL_TOOL_NAMES.has(String(t.name))) {
				finalTools.push(t);
			} else {
				optionalTools.push(t);
			}
		}

		let hasRenderedAnyGroup = false;
		if (finalTools.length) {
			appendGroupHeader('Final step', !hasRenderedAnyGroup);
			hasRenderedAnyGroup = true;
			for (const t of finalTools) appendToolItem(t);
		}
		if (optionalTools.length) {
			appendGroupHeader('Optional tools', !hasRenderedAnyGroup);
			hasRenderedAnyGroup = true;
			for (const t of optionalTools) appendToolItem(t);
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
				pane.style.flex = '0 1 ' + next + 'px';
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

	function __kustoAppendChatMessage(boxId, role, text, detail) {
		try {
			const host = document.getElementById(boxId + '_copilot_messages');
			if (!host) return;
			// Support 'user', 'assistant', and 'notification' roles
			const roleMap = { user: 'user', assistant: 'assistant', notification: 'notification' };
			const safeRole = roleMap[role] || 'assistant';
			const el = document.createElement('div');
			el.className = 'kusto-copilot-chat-msg kusto-copilot-chat-msg-' + safeRole;
			el.textContent = String(text || '');
			// If detail text is provided, show it on hover
			const safeDetail = String(detail || '').trim();
			if (safeDetail) {
				el.title = safeDetail;
				el.style.cursor = 'help';
				el.style.textDecoration = 'underline dotted';
			}
			host.appendChild(el);
			try { host.scrollTop = host.scrollHeight; } catch { /* ignore */ }
		} catch {
			// ignore
		}
	}

	function __kustoAppendCopilotTipMessage(boxId) {
		try {
			const host = document.getElementById(boxId + '_copilot_messages');
			if (!host) return;
			const el = document.createElement('div');
			el.className = 'kusto-copilot-chat-msg kusto-copilot-chat-msg-notification';
			const link = document.createElement('a');
			link.href = '#';
			link.textContent = 'Kusto Workbench custom agent';
			link.title = 'Open the Kusto Workbench agent in VS Code Copilot Chat';
			link.style.cursor = 'pointer';
			link.addEventListener('click', (e) => {
				try { e.preventDefault(); } catch { /* ignore */ }
				try { vscode.postMessage({ type: 'openCopilotAgent' }); } catch { /* ignore */ }
			});
			el.appendChild(document.createTextNode('Tip: If the ask is very challenging or broad, use the '));
			el.appendChild(link);
			el.appendChild(document.createTextNode(' instead.'));
			host.appendChild(el);
			try { host.scrollTop = host.scrollHeight; } catch { /* ignore */ }
		} catch { /* ignore */ }
	}

	function __kustoAppendToolResponse(boxId, toolName, label, jsonText, entryId) {
		try {
			const host = document.getElementById(boxId + '_copilot_messages');
			if (!host) return;
			const safeTool = String(toolName || '').trim() || 'tool';
			const safeLabel = String(label || '').trim() || safeTool;
			const json = String(jsonText || '');
			const safeEntryId = String(entryId || '').trim();

			const state = __kustoEnsureCopilotToolResponseState();
			state[boxId] = state[boxId] || { seq: 0 };
			state[boxId].seq = (state[boxId].seq || 0) + 1;
			const seq = state[boxId].seq;
			const preId = boxId + '_copilot_tool_json_' + seq;
			const linkId = boxId + '_copilot_tool_link_' + seq;

			const wrapper = document.createElement('div');
			wrapper.className = 'kusto-copilot-chat-msg kusto-copilot-chat-msg-tool';
			wrapper.setAttribute('data-kusto-no-editor-focus', 'true');
			if (safeEntryId) {
				wrapper.setAttribute('data-entry-id', safeEntryId);
			}

			// Header row: icon + tool name + action icons
			const header = document.createElement('div');
			header.className = 'kusto-copilot-tool-header';

			// Left side: icon + tool name
			const leftSide = document.createElement('div');
			leftSide.className = 'kusto-copilot-tool-header-left';

			const icon = document.createElement('span');
			icon.className = 'codicon codicon-tools';
			icon.setAttribute('aria-hidden', 'true');
			leftSide.appendChild(icon);

			const toolNameEl = document.createElement('strong');
			toolNameEl.textContent = ' ' + safeTool;
			leftSide.appendChild(toolNameEl);

			header.appendChild(leftSide);

			// Right side: action icons
			const rightSide = document.createElement('div');
			rightSide.className = 'kusto-copilot-tool-header-right';

			// View icon button
			const viewBtn = document.createElement('button');
			viewBtn.type = 'button';
			viewBtn.className = 'kusto-copilot-icon-btn';
			viewBtn.title = 'View what the tool returned';
			viewBtn.id = linkId;
			const viewIcon = document.createElement('span');
			viewIcon.className = 'codicon codicon-eye';
			viewBtn.appendChild(viewIcon);
			viewBtn.onclick = (e) => {
				try { e.preventDefault(); } catch { /* ignore */ }
				try {
					vscode.postMessage({
						type: 'openToolResultInEditor',
						boxId: boxId,
						tool: safeTool,
						label: safeLabel,
						content: json
					});
				} catch { /* ignore */ }
			};
			rightSide.appendChild(viewBtn);

			// Remove icon button (if we have an entryId)
			if (safeEntryId) {
				const removeBtn = document.createElement('button');
				removeBtn.type = 'button';
				removeBtn.className = 'kusto-copilot-icon-btn kusto-copilot-remove-btn';
				removeBtn.title = 'Remove from conversation history';
				const removeIcon = document.createElement('span');
				removeIcon.className = 'codicon codicon-trash';
				removeBtn.appendChild(removeIcon);
				removeBtn.onclick = (e) => {
					try { e.preventDefault(); } catch { /* ignore */ }
					try {
						wrapper.classList.add('is-removed');
						removeBtn.style.display = 'none';
						vscode.postMessage({
							type: 'removeFromCopilotHistory',
							boxId: boxId,
							entryId: safeEntryId
						});
					} catch { /* ignore */ }
				};
				rightSide.appendChild(removeBtn);
			}

			header.appendChild(rightSide);
			wrapper.appendChild(header);

			// Result row (underneath header)
			const resultRow = document.createElement('div');
			resultRow.className = 'kusto-copilot-tool-result';
			resultRow.textContent = safeLabel;
			wrapper.appendChild(resultRow);

			// Tooltip (shown on hover) with tool call details
			const tooltip = document.createElement('div');
			tooltip.className = 'kusto-copilot-tool-tooltip';
			const tooltipRequestLabel = document.createElement('div');
			tooltipRequestLabel.className = 'kusto-copilot-tool-tooltip-label';
			tooltipRequestLabel.textContent = 'Tool: ' + safeTool;
			tooltip.appendChild(tooltipRequestLabel);
			const tooltipContent = document.createElement('div');
			tooltipContent.className = 'kusto-copilot-tool-tooltip-content';
			tooltipContent.textContent = json;
			tooltip.appendChild(tooltipContent);
			document.body.appendChild(tooltip);

			// Set up tooltip show/hide behavior
			__kustoSetupToolTooltip(wrapper, tooltip);

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
			const toolsBtn = document.getElementById(boxId + '_copilot_tools_btn');
			const input = document.getElementById(boxId + '_copilot_input');
			const modelSel = document.getElementById(boxId + '_copilot_model');
			if (sendBtn) {
				try { sendBtn.classList.toggle('is-running', !!running); } catch { /* ignore */ }
				// When running, clicking the button should cancel instead of send.
				if (running) {
					sendBtn.title = 'Stop (Esc)';
					sendBtn.onclick = function () { __kustoCopilotWriteQueryCancel(boxId); };
				} else {
					sendBtn.title = 'Send (Enter)';
					sendBtn.onclick = function () { __kustoCopilotWriteQuerySend(boxId); };
				}
			}
			// Tools button stays usable while running.
			if (toolsBtn) toolsBtn.disabled = !!toolsBtn.disabled;
			if (input) input.disabled = !!running;
			if (modelSel) modelSel.disabled = !!running;
			// Sync the custom dropdown wrapper so the visible button reflects the new disabled state.
			try {
				if (modelSel && window.__kustoDropdown && typeof window.__kustoDropdown.syncSelectBackedDropdown === 'function') {
					window.__kustoDropdown.syncSelectBackedDropdown(boxId + '_copilot_model');
				}
			} catch { /* ignore */ }
		} catch { /* ignore */ }

		if (statusText) {
			__kustoAppendChatMessage(boxId, 'notification', String(statusText));
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
				const label = String(m.label || m.id);
				const id = String(m.id);
				opt.textContent = (label && label !== id) ? label + ' (' + id + ')' : id;
				opt.setAttribute('data-short-label', label);
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
			for (const n of existingChildren) {
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
			chatPane.style.flex = '0 1 ' + DEFAULT_CHAT_WIDTH_PX + 'px';
			chatPane.insertAdjacentHTML('beforeend', __kustoCopilotChatHtml(boxId));
			split.appendChild(chatPane);

			editorWrapper.appendChild(split);
			// Hoist the vertical query resizer to the wrapper level so it spans
			// the entire width of the section (chat + editor), not just the editor pane.
			// The resizer is nested inside qe-editor-clip, so use getElementById.
			try {
				const queryResizerEl = document.getElementById(boxId + '_query_resizer');
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
							chatPane.style.flex = '0 1 ' + next + 'px';
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
			__kustoAppendCopilotTipMessage(boxId);

			// Ask extension for model list + default selection.
			try {
				vscode.postMessage({ type: 'prepareCopilotWriteQuery', boxId: String(boxId || '') });
			} catch { /* ignore */ }

			// Add Enter key handler to send message, Ctrl+Enter for newline
			try {
				const inputEl = document.getElementById(boxId + '_copilot_input');
				if (inputEl) {
					inputEl.addEventListener('keydown', (e) => {
						if (e.key === 'Enter' && e.ctrlKey) {
							// Ctrl+Enter inserts a newline
							try {
								e.preventDefault();
								const start = inputEl.selectionStart;
								const end = inputEl.selectionEnd;
								inputEl.value = inputEl.value.substring(0, start) + '\n' + inputEl.value.substring(end);
								inputEl.selectionStart = inputEl.selectionEnd = start + 1;
								inputEl.dispatchEvent(new Event('input', { bubbles: true }));
							} catch { /* ignore */ }
							return;
						}
						// Enter without Shift sends the message
						if (e.key === 'Enter' && !e.shiftKey) {
							try { e.preventDefault(); } catch { /* ignore */ }
							__kustoCopilotWriteQuerySend(boxId);
						}
					});

					// Auto-grow textarea as user types
					const autoGrow = () => {
						try {
							const maxH = 400;
							const minH = 32;
							inputEl.style.height = 'auto';
							const scrollH = inputEl.scrollHeight;
							inputEl.style.height = Math.max(minH, Math.min(maxH, scrollH + 4)) + 'px';
						} catch { /* ignore */ }
					};
					inputEl.addEventListener('input', autoGrow);
				}
			} catch { /* ignore */ }

			// Chat input area resizer – drag to grow/shrink the textarea.
			try {
				const inputResizer = document.getElementById(boxId + '_copilot_input_resizer');
				const chatTextarea = document.getElementById(boxId + '_copilot_input');
				if (inputResizer && chatTextarea) {
					inputResizer.addEventListener('mousedown', (e) => {
						try { e.preventDefault(); e.stopPropagation(); } catch { /* ignore */ }
						inputResizer.classList.add('is-dragging');
						const prevCursor = document.body.style.cursor;
						const prevUserSelect = document.body.style.userSelect;
						document.body.style.cursor = 'ns-resize';
						document.body.style.userSelect = 'none';

						const startY = e.clientY;
						const startH = chatTextarea.getBoundingClientRect().height;

						const onMove = (moveEvt) => {
							// Dragging up grows the textarea (delta is negative).
							const delta = startY - moveEvt.clientY;
							const next = Math.max(32, Math.min(400, startH + delta));
							chatTextarea.style.height = next + 'px';
						};
						const onUp = () => {
							document.removeEventListener('mousemove', onMove, true);
							document.removeEventListener('mouseup', onUp, true);
							inputResizer.classList.remove('is-dragging');
							document.body.style.cursor = prevCursor;
							document.body.style.userSelect = prevUserSelect;
						};
						document.addEventListener('mousemove', onMove, true);
						document.addEventListener('mouseup', onUp, true);
					});
				}
			} catch { /* ignore */ }

			// ResizeObserver: when the split container crosses the auto-hide threshold
			// (320px = MIN_EDITOR_WIDTH + MIN_CHAT_WIDTH), the CSS container query
			// hides/shows the chat pane. We need to re-layout Monaco when that happens.
			try {
				const AUTO_HIDE_THRESHOLD = MIN_EDITOR_WIDTH_PX + MIN_CHAT_WIDTH_PX;
				let wasBelowThreshold = false;
				const splitObserver = new ResizeObserver((entries) => {
					try {
						const entry = entries[0];
						if (!entry) return;
						const w = entry.contentRect.width;
						const isBelowNow = w > 0 && w <= AUTO_HIDE_THRESHOLD;
						if (isBelowNow !== wasBelowThreshold) {
							wasBelowThreshold = isBelowNow;
							const editor = queryEditors && queryEditors[boxId];
							if (editor && typeof editor.layout === 'function') {
								editor.layout();
							}
						}
					} catch { /* ignore */ }
				});
				splitObserver.observe(split);
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

		// When showing the chat, ensure the wrapper meets the min-height requirement.
		if (next) {
			try {
				const wrapper = document.getElementById(id + '_query_editor');
				const editorWrapper = wrapper && wrapper.closest ? wrapper.closest('.query-editor-wrapper') : null;
				if (editorWrapper) {
					const currentHeight = editorWrapper.getBoundingClientRect().height;
					const minHeight = 180;
					if (currentHeight < minHeight) {
						editorWrapper.style.height = minHeight + 'px';
						// Update the manual height tracker so persistence is correct.
						try {
							if (!window.__kustoManualQueryEditorHeightPxByBoxId || typeof window.__kustoManualQueryEditorHeightPxByBoxId !== 'object') {
								window.__kustoManualQueryEditorHeightPxByBoxId = {};
							}
							window.__kustoManualQueryEditorHeightPxByBoxId[id] = minHeight;
						} catch { /* ignore */ }
					}
				}
			} catch { /* ignore */ }
		}

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
			__kustoAppendChatMessage(id, 'notification', 'Type what you want the query to do, then press Send.');
			return;
		}

		// Gather context.
		const connectionId = (document.getElementById(id + '_connection') || {}).value || '';
		const database = (document.getElementById(id + '_database') || {}).value || '';
		if (!connectionId) {
			__kustoAppendChatMessage(id, 'notification', 'Select a cluster connection first.');
			return;
		}
		if (!database) {
			__kustoAppendChatMessage(id, 'notification', 'Select a database first.');
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
			if (inputEl) {
				inputEl.value = '';
				inputEl.style.height = '32px';
			}
		} catch { /* ignore */ }

		__kustoSetCopilotChatRunning(id, true);

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
				enabledTools,
				queryMode: typeof getRunMode === 'function' ? getRunMode(id) : 'take100'
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
		// The send-icon button is toggled back to send mode via __kustoSetCopilotChatRunning(false).
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

	// Track active panel for click-outside-to-close
	let __kustoActiveCopilotToolsPanel = null;

	function __kustoCopilotCloseToolsPanel(boxId) {
		const id = String(boxId || '').trim();
		if (!id) return;
		const panel = document.getElementById(id + '_copilot_tools_panel');
		const btn = document.getElementById(id + '_copilot_tools_btn');
		if (panel) panel.style.display = 'none';
		if (btn) {
			btn.classList.remove('is-active');
			btn.setAttribute('aria-pressed', 'false');
		}
		if (__kustoActiveCopilotToolsPanel === id) {
			__kustoActiveCopilotToolsPanel = null;
		}
	}

	window.__kustoCopilotClearConversation = function __kustoCopilotClearConversation(boxId) {
		const id = String(boxId || '').trim();
		if (!id) return;
		try {
			// Clear all messages from the chat UI
			const messagesHost = document.getElementById(id + '_copilot_messages');
			if (messagesHost) {
				messagesHost.innerHTML = '';
			}
		} catch { /* ignore */ }
		try {
			// Reset tool response sequence counter
			const state = __kustoEnsureCopilotToolResponseState();
			if (state[id]) {
				state[id].seq = 0;
			}
		} catch { /* ignore */ }
		try {
			// Notify extension to reset conversation state (so next message is treated as first)
			vscode.postMessage({ type: 'clearCopilotConversation', boxId: id });
		} catch { /* ignore */ }

		// Re-run the same initialization logic that runs when the chat first opens
		__kustoSetCopilotChatRunning(id, false);
		__kustoAppendCopilotTipMessage(id);

		// Re-request model list + default selection (same as initial setup)
		try {
			vscode.postMessage({ type: 'prepareCopilotWriteQuery', boxId: id });
		} catch { /* ignore */ }
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

			// Close any previously open panel
			if (__kustoActiveCopilotToolsPanel && __kustoActiveCopilotToolsPanel !== id) {
				__kustoCopilotCloseToolsPanel(__kustoActiveCopilotToolsPanel);
			}

			panel.style.display = nextVisible ? 'block' : 'none';
			__kustoActiveCopilotToolsPanel = nextVisible ? id : null;
			try {
				if (btn) {
					btn.classList.toggle('is-active', nextVisible);
					btn.setAttribute('aria-pressed', nextVisible ? 'true' : 'false');
				}
			} catch { /* ignore */ }
		} catch { /* ignore */ }
	};

	// Click-outside-to-close handler
	document.addEventListener('click', function (e) {
		if (!__kustoActiveCopilotToolsPanel) return;
		const id = __kustoActiveCopilotToolsPanel;
		const panel = document.getElementById(id + '_copilot_tools_panel');
		const btn = document.getElementById(id + '_copilot_tools_btn');
		if (!panel) return;
		// If click is inside panel or on the toggle button, ignore
		if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
		__kustoCopilotCloseToolsPanel(id);
	}, true);

	window.__kustoCopilotWriteQueryStatus = function (boxId, text, detail, role) {
		// If role is specified (e.g. 'assistant'), use that; otherwise default to 'notification'
		const effectiveRole = (role === 'assistant') ? 'assistant' : 'notification';
		__kustoAppendChatMessage(String(boxId || ''), effectiveRole, String(text || ''), String(detail || ''));
	};
	window.__kustoCopilotWriteQuerySetQuery = function (boxId, queryText) {
		__kustoSetQueryText(String(boxId || ''), queryText);
	};
	window.__kustoCopilotWriteQueryDone = function (boxId, ok, message) {
		const id = String(boxId || '').trim();
		__kustoSetCopilotChatRunning(id, false);
		if (message) {
			__kustoAppendChatMessage(id, 'notification', String(message || ''));
		}
	};

	// Called by main.js when the host returns a local tool payload.
	window.__kustoCopilotWriteQueryToolResult = function (boxId, toolName, label, jsonText, entryId) {
		__kustoAppendToolResponse(String(boxId || ''), String(toolName || ''), String(label || ''), String(jsonText || ''), String(entryId || ''));
	};

	// Called by main.js when Copilot executes a query and receives results.
	// Shows a link with hover tooltip (query text), clicking inserts a new section with the query and results.
	window.__kustoCopilotAppendExecutedQuery = function (boxId, query, resultSummary, errorMessage, entryId, result) {
		try {
			const id = String(boxId || '').trim();
			if (!id) return;

			const host = document.getElementById(id + '_copilot_messages');
			if (!host) return;

			const safeQuery = String(query || '').trim();
			const safeSummary = String(resultSummary || '').trim();
			const safeError = String(errorMessage || '').trim();
			const safeEntryId = String(entryId || '').trim();
			const isError = safeSummary === 'Error' || !!safeError;
			// Store result for use when inserting
			const storedResult = result || null;

			const wrapper = document.createElement('div');
			wrapper.className = 'kusto-copilot-chat-msg kusto-copilot-chat-msg-tool' + (isError ? ' is-error' : '');
			wrapper.setAttribute('data-kusto-no-editor-focus', 'true');
			if (safeEntryId) {
				wrapper.setAttribute('data-entry-id', safeEntryId);
			}

			// Header row: icon + tool name + action icons
			const header = document.createElement('div');
			header.className = 'kusto-copilot-tool-header';

			// Left side: icon + tool name
			const leftSide = document.createElement('div');
			leftSide.className = 'kusto-copilot-tool-header-left';

			const icon = document.createElement('span');
			icon.className = 'codicon codicon-tools';
			icon.setAttribute('aria-hidden', 'true');
			leftSide.appendChild(icon);

			const toolName = document.createElement('strong');
			toolName.textContent = ' execute_kusto_query';
			leftSide.appendChild(toolName);

			header.appendChild(leftSide);

			// Right side: action icons
			const rightSide = document.createElement('div');
			rightSide.className = 'kusto-copilot-tool-header-right';

			// Insert icon button
			const insertBtn = document.createElement('button');
			insertBtn.type = 'button';
			insertBtn.className = 'kusto-copilot-icon-btn';
			insertBtn.title = 'Insert as new query section so you can inspect the query and results';
			const insertIcon = document.createElement('span');
			insertIcon.className = 'codicon codicon-insert';
			insertBtn.appendChild(insertIcon);
			insertBtn.onclick = (e) => {
				try { e.preventDefault(); } catch { /* ignore */ }
				try {
					if (typeof window.addQueryBox === 'function') {
						// Create new box with results visible by default
						const newBoxId = window.addQueryBox({ initialQuery: safeQuery, defaultResultsVisible: true });
						if (newBoxId) {
							setTimeout(() => {
								// Set the query text
								if (typeof __kustoSetQueryText === 'function') {
									__kustoSetQueryText(newBoxId, safeQuery);
								}
								// Display the stored results if available (no re-execution needed)
								if (storedResult && typeof displayResultForBox === 'function') {
									displayResultForBox(storedResult, newBoxId, { label: 'Results', showExecutionTime: true });
								}
								// Scroll to the new box
								const newBox = document.getElementById(newBoxId);
								if (newBox) {
									newBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
								}
							}, 100);
						}
					}
				} catch { /* ignore */ }
			};
			rightSide.appendChild(insertBtn);

			// Remove icon button (if we have an entryId)
			if (safeEntryId) {
				const removeBtn = document.createElement('button');
				removeBtn.type = 'button';
				removeBtn.className = 'kusto-copilot-icon-btn kusto-copilot-remove-btn';
				removeBtn.title = 'Remove from conversation history';
				const removeIcon = document.createElement('span');
				removeIcon.className = 'codicon codicon-trash';
				removeBtn.appendChild(removeIcon);
				removeBtn.onclick = (e) => {
					try { e.preventDefault(); } catch { /* ignore */ }
					try {
						wrapper.classList.add('is-removed');
						removeBtn.style.display = 'none';
						vscode.postMessage({
							type: 'removeFromCopilotHistory',
							boxId: id,
							entryId: safeEntryId
						});
					} catch { /* ignore */ }
				};
				rightSide.appendChild(removeBtn);
			}

			header.appendChild(rightSide);
			wrapper.appendChild(header);

			// Result row (underneath header)
			const resultRow = document.createElement('div');
			resultRow.className = 'kusto-copilot-tool-result';
			if (isError) {
				resultRow.textContent = 'Query failed to execute';
				resultRow.classList.add('is-error');
			} else if (safeSummary) {
				resultRow.textContent = safeSummary;
			}
			wrapper.appendChild(resultRow);

			// Tooltip (shown on hover) with tool call details
			const tooltip = document.createElement('div');
			tooltip.className = 'kusto-copilot-tool-tooltip';
			const tooltipRequestLabel = document.createElement('div');
			tooltipRequestLabel.className = 'kusto-copilot-tool-tooltip-label';
			tooltipRequestLabel.textContent = 'Query:';
			tooltip.appendChild(tooltipRequestLabel);
			const tooltipQuery = document.createElement('div');
			tooltipQuery.className = 'kusto-copilot-tool-tooltip-content';
			tooltipQuery.textContent = safeQuery;
			tooltip.appendChild(tooltipQuery);
			if (isError && safeError) {
				const tooltipErrorLabel = document.createElement('div');
				tooltipErrorLabel.className = 'kusto-copilot-tool-tooltip-label';
				tooltipErrorLabel.style.marginTop = '8px';
				tooltipErrorLabel.textContent = 'Error:';
				tooltip.appendChild(tooltipErrorLabel);
				const tooltipError = document.createElement('div');
				tooltipError.className = 'kusto-copilot-tool-tooltip-content';
				tooltipError.style.color = 'var(--vscode-inputValidation-errorForeground, #f48771)';
				tooltipError.textContent = safeError;
				tooltip.appendChild(tooltipError);
			} else if (safeSummary) {
				const tooltipResultLabel = document.createElement('div');
				tooltipResultLabel.className = 'kusto-copilot-tool-tooltip-label';
				tooltipResultLabel.style.marginTop = '8px';
				tooltipResultLabel.textContent = 'Result:';
				tooltip.appendChild(tooltipResultLabel);
				const tooltipResult = document.createElement('div');
				tooltipResult.className = 'kusto-copilot-tool-tooltip-content';
				tooltipResult.textContent = safeSummary;
				tooltip.appendChild(tooltipResult);
			}
			document.body.appendChild(tooltip);

			// Set up tooltip show/hide behavior
			__kustoSetupToolTooltip(wrapper, tooltip);

			host.appendChild(wrapper);
			try { host.scrollTop = host.scrollHeight; } catch { /* ignore */ }
		} catch {
			// ignore
		}
	};

	// Called by main.js when general-query-rules.md is loaded for the first message.
	// Shows a link with hover tooltip (preview of content), clicking opens markdown preview.
	window.__kustoCopilotAppendGeneralRulesLink = function (boxId, filePath, preview, entryId) {
		try {
			const id = String(boxId || '').trim();
			if (!id) return;

			const host = document.getElementById(id + '_copilot_messages');
			if (!host) return;

			const safeFilePath = String(filePath || '').trim();
			const safePreview = String(preview || '').trim();
			const safeEntryId = String(entryId || '').trim();

			const wrapper = document.createElement('div');
			wrapper.className = 'kusto-copilot-chat-msg kusto-copilot-chat-msg-system';
			wrapper.setAttribute('data-kusto-no-editor-focus', 'true');
			if (safeEntryId) {
				wrapper.setAttribute('data-entry-id', safeEntryId);
			}

			// Header row: icon + label + action icons
			const header = document.createElement('div');
			header.className = 'kusto-copilot-tool-header';

			// Left side: icon + label
			const leftSide = document.createElement('div');
			leftSide.className = 'kusto-copilot-tool-header-left';

			const icon = document.createElement('span');
			icon.className = 'codicon codicon-book';
			icon.setAttribute('aria-hidden', 'true');
			leftSide.appendChild(icon);

			const text = document.createElement('strong');
			text.textContent = ' general-query-rules.md';
			leftSide.appendChild(text);

			header.appendChild(leftSide);

			// Right side: action icons
			const rightSide = document.createElement('div');
			rightSide.className = 'kusto-copilot-tool-header-right';

			// Preview icon button
			const previewBtn = document.createElement('button');
			previewBtn.type = 'button';
			previewBtn.className = 'kusto-copilot-icon-btn';
			previewBtn.title = 'View what the guidelines are';
			const previewIcon = document.createElement('span');
			previewIcon.className = 'codicon codicon-eye';
			previewBtn.appendChild(previewIcon);
			previewBtn.onclick = (e) => {
				try { e.preventDefault(); } catch { /* ignore */ }
				try {
					if (safeFilePath) {
						vscode.postMessage({
							type: 'openMarkdownPreview',
							filePath: safeFilePath
						});
					}
				} catch { /* ignore */ }
			};
			rightSide.appendChild(previewBtn);

			// Remove icon button (if we have an entryId)
			if (safeEntryId) {
				const removeBtn = document.createElement('button');
				removeBtn.type = 'button';
				removeBtn.className = 'kusto-copilot-icon-btn kusto-copilot-remove-btn';
				removeBtn.title = 'Remove from conversation history';
				const removeIcon = document.createElement('span');
				removeIcon.className = 'codicon codicon-trash';
				removeBtn.appendChild(removeIcon);
				removeBtn.onclick = (e) => {
					try { e.preventDefault(); } catch { /* ignore */ }
					try {
						wrapper.classList.add('is-removed');
						removeBtn.style.display = 'none';
						vscode.postMessage({
							type: 'removeFromCopilotHistory',
							boxId: id,
							entryId: safeEntryId
						});
					} catch { /* ignore */ }
				};
				rightSide.appendChild(removeBtn);
			}

			header.appendChild(rightSide);
			wrapper.appendChild(header);

			// Result row (underneath header)
			const resultRow = document.createElement('div');
			resultRow.className = 'kusto-copilot-tool-result';
			resultRow.textContent = 'Loaded query writing guidelines';
			wrapper.appendChild(resultRow);

			// Tooltip (shown on hover) with preview of file content
			const tooltip = document.createElement('div');
			tooltip.className = 'kusto-copilot-tool-tooltip';
			const tooltipLabel = document.createElement('div');
			tooltipLabel.className = 'kusto-copilot-tool-tooltip-label';
			tooltipLabel.textContent = 'Preview:';
			tooltip.appendChild(tooltipLabel);
			const tooltipContent = document.createElement('div');
			tooltipContent.className = 'kusto-copilot-tool-tooltip-content';
			tooltipContent.textContent = safePreview || 'Query writing guidelines for the LLM';
			tooltip.appendChild(tooltipContent);
			document.body.appendChild(tooltip);

			// Set up tooltip show/hide behavior
			__kustoSetupToolTooltip(wrapper, tooltip);

			// Find the first user message and insert after it
			const firstUserMsg = host.querySelector('.kusto-copilot-chat-msg-user');
			if (firstUserMsg && firstUserMsg.nextSibling) {
				host.insertBefore(wrapper, firstUserMsg.nextSibling);
			} else if (firstUserMsg) {
				host.appendChild(wrapper);
			} else {
				// No user message yet, append at end (will be before any assistant response)
				host.appendChild(wrapper);
			}
		} catch {
			// ignore
		}
	};

	// Called by main.js when Copilot asks a clarifying question.
	// Shows the question as an assistant message in the chat.
	window.__kustoCopilotAppendClarifyingQuestion = function (boxId, question, entryId) {
		try {
			const id = String(boxId || '').trim();
			if (!id) return;

			const host = document.getElementById(id + '_copilot_messages');
			if (!host) return;

			const safeQuestion = String(question || '').trim();
			const safeEntryId = String(entryId || '').trim();
			if (!safeQuestion) return;

			const wrapper = document.createElement('div');
			wrapper.className = 'kusto-copilot-chat-msg kusto-copilot-chat-msg-clarifying-question';
			wrapper.setAttribute('data-kusto-no-editor-focus', 'true');
			if (safeEntryId) {
				wrapper.setAttribute('data-entry-id', safeEntryId);
			}

			// Header row: icon + label + action icons
			const header = document.createElement('div');
			header.className = 'kusto-copilot-tool-header';

			// Left side: icon + label
			const leftSide = document.createElement('div');
			leftSide.className = 'kusto-copilot-tool-header-left';

			const icon = document.createElement('span');
			icon.className = 'codicon codicon-comment-discussion';
			icon.setAttribute('aria-hidden', 'true');
			leftSide.appendChild(icon);

			const text = document.createElement('strong');
			text.textContent = ' Clarifying question';
			leftSide.appendChild(text);

			header.appendChild(leftSide);

			// Right side: action icons
			const rightSide = document.createElement('div');
			rightSide.className = 'kusto-copilot-tool-header-right';

			// Remove icon button (if we have an entryId)
			if (safeEntryId) {
				const removeBtn = document.createElement('button');
				removeBtn.type = 'button';
				removeBtn.className = 'kusto-copilot-icon-btn kusto-copilot-remove-btn';
				removeBtn.title = 'Remove from conversation history';
				const removeIcon = document.createElement('span');
				removeIcon.className = 'codicon codicon-trash';
				removeBtn.appendChild(removeIcon);
				removeBtn.onclick = (e) => {
					try { e.preventDefault(); } catch { /* ignore */ }
					try {
						wrapper.classList.add('is-removed');
						removeBtn.style.display = 'none';
						vscode.postMessage({
							type: 'removeFromCopilotHistory',
							boxId: id,
							entryId: safeEntryId
						});
					} catch { /* ignore */ }
				};
				rightSide.appendChild(removeBtn);
			}

			header.appendChild(rightSide);
			wrapper.appendChild(header);

			// Question content row
			const questionRow = document.createElement('div');
			questionRow.className = 'kusto-copilot-clarifying-question-text';
			questionRow.textContent = safeQuestion;
			wrapper.appendChild(questionRow);

			host.appendChild(wrapper);
			try { host.scrollTop = host.scrollHeight; } catch { /* ignore */ }

			// Focus the input so user can respond
			try {
				const input = document.getElementById(id + '_copilot_input');
				if (input) {
					input.focus();
				}
			} catch { /* ignore */ }
		} catch {
			// ignore
		}
	};

	// Called by main.js when user sends a message and has a query in the editor.
	// Shows the query snapshot with ability to remove it from conversation history.
	window.__kustoCopilotAppendQuerySnapshot = function (boxId, queryText, entryId) {
		try {
			const id = String(boxId || '').trim();
			if (!id) return;

			const host = document.getElementById(id + '_copilot_messages');
			if (!host) return;

			const safeQuery = String(queryText || '').trim();
			const safeEntryId = String(entryId || '').trim();
			if (!safeQuery) return; // Don't show empty query snapshots

			const wrapper = document.createElement('div');
			wrapper.className = 'kusto-copilot-chat-msg kusto-copilot-chat-msg-query-snapshot';
			wrapper.setAttribute('data-kusto-no-editor-focus', 'true');
			if (safeEntryId) {
				wrapper.setAttribute('data-entry-id', safeEntryId);
			}

			// Header row: icon + label + action icons
			const header = document.createElement('div');
			header.className = 'kusto-copilot-tool-header';

			// Left side: icon + label
			const leftSide = document.createElement('div');
			leftSide.className = 'kusto-copilot-tool-header-left';

			const icon = document.createElement('span');
			icon.className = 'codicon codicon-code';
			icon.setAttribute('aria-hidden', 'true');
			leftSide.appendChild(icon);

			const text = document.createElement('strong');
			text.textContent = ' Query context';
			leftSide.appendChild(text);

			header.appendChild(leftSide);

			// Right side: action icons
			const rightSide = document.createElement('div');
			rightSide.className = 'kusto-copilot-tool-header-right';

			// View icon button
			const viewBtn = document.createElement('button');
			viewBtn.type = 'button';
			viewBtn.className = 'kusto-copilot-icon-btn';
			viewBtn.title = safeQuery; // Full query on hover
			const viewIcon = document.createElement('span');
			viewIcon.className = 'codicon codicon-eye';
			viewBtn.appendChild(viewIcon);
			viewBtn.onclick = (e) => {
				try { e.preventDefault(); } catch { /* ignore */ }
				try {
					vscode.postMessage({
						type: 'openToolResultInEditor',
						boxId: id,
						tool: 'Query context',
						label: 'Query snapshot',
						content: safeQuery
					});
				} catch { /* ignore */ }
			};
			rightSide.appendChild(viewBtn);

			// Remove icon button (if we have an entryId)
			if (safeEntryId) {
				const removeBtn = document.createElement('button');
				removeBtn.type = 'button';
				removeBtn.className = 'kusto-copilot-icon-btn kusto-copilot-remove-btn';
				removeBtn.title = 'Remove from conversation history';
				const removeIcon = document.createElement('span');
				removeIcon.className = 'codicon codicon-trash';
				removeBtn.appendChild(removeIcon);
				removeBtn.onclick = (e) => {
					try { e.preventDefault(); } catch { /* ignore */ }
					try {
						wrapper.classList.add('is-removed');
						removeBtn.style.display = 'none';
						vscode.postMessage({
							type: 'removeFromCopilotHistory',
							boxId: id,
							entryId: safeEntryId
						});
					} catch { /* ignore */ }
				};
				rightSide.appendChild(removeBtn);
			}

			header.appendChild(rightSide);
			wrapper.appendChild(header);

			// Result row (underneath header) - truncated preview of query
			const previewLen = 80;
			const preview = safeQuery.length > previewLen
				? safeQuery.substring(0, previewLen).replace(/\s+/g, ' ') + '…'
				: safeQuery.replace(/\s+/g, ' ');
			const resultRow = document.createElement('div');
			resultRow.className = 'kusto-copilot-tool-result';
			resultRow.textContent = preview;
			wrapper.appendChild(resultRow);

			// Create tooltip element for showing full query on hover
			const tooltip = document.createElement('div');
			tooltip.className = 'kusto-copilot-tool-tooltip';
			const tooltipContent = document.createElement('pre');
			tooltipContent.className = 'kusto-copilot-tool-tooltip-content';
			tooltipContent.style.margin = '0';
			tooltipContent.style.whiteSpace = 'pre-wrap';
			tooltipContent.style.wordBreak = 'break-word';
			tooltipContent.textContent = safeQuery;
			tooltip.appendChild(tooltipContent);
			document.body.appendChild(tooltip);

			// Setup hover tooltip using existing helper
			__kustoSetupToolTooltip(wrapper, tooltip);

			host.appendChild(wrapper);
			try { host.scrollTop = host.scrollHeight; } catch { /* ignore */ }
		} catch {
			// ignore
		}
	};
})();
