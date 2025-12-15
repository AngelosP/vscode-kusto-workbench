// Persistence + .kqlx document round-tripping.
//
// The extension host stores the state as JSON in a .kqlx file.
// This file provides:
// - export: collect the current UI state
// - restore: rebuild the UI from a state object
// - debounced write-through: postMessage({type:'persistDocument'})

let __kustoPersistenceEnabled = false;
let __kustoRestoreInProgress = false;
let __kustoPersistTimer = null;
let __kustoDocumentDataApplyCount = 0;
let __kustoHasAppliedDocument = false;
// Set by the extension host; true for globalStorage/session.kqlx.
window.__kustoIsSessionFile = false;
// Set by the extension host; true for .kql/.csl files.
window.__kustoCompatibilityMode = false;

function __kustoSetCompatibilityMode(enabled) {
	try {
		window.__kustoCompatibilityMode = !!enabled;
		const msg = 'This file is in .kql/.csl mode. Click to upgrade to .kqlx and enable sections.';
		const wrappers = document.querySelectorAll('.add-controls .add-control-wrapper');
		for (const w of wrappers) {
			try {
				if (enabled) {
					w.title = msg;
				} else if (w.title === msg) {
					w.title = '';
				}
			} catch {
				// ignore
			}
		}
		const buttons = document.querySelectorAll('.add-controls .add-control-btn');
		for (const btn of buttons) {
			try {
				// Keep enabled; clicking will offer to upgrade.
				btn.disabled = false;
				btn.setAttribute('aria-disabled', 'false');
				// Tooltip is on wrapper span.
				btn.title = '';
			} catch {
				// ignore
			}
		}

		// If we just entered compatibility mode, ensure any early queued add clicks don't
		// accidentally create extra sections that can't be persisted.
		if (enabled) {
			try {
				if (window.__kustoQueryEditorPendingAdds && typeof window.__kustoQueryEditorPendingAdds === 'object') {
					window.__kustoQueryEditorPendingAdds = { query: 0, markdown: 0, python: 0, url: 0 };
				}
			} catch {
				// ignore
			}
		}
	} catch {
		// ignore
	}
}

function __kustoRequestAddSection(kind) {
	const k = String(kind || '').trim();
	if (!k) return;

	// For .kql/.csl compatibility files: offer upgrade instead of adding sections.
	try {
		if (window.__kustoCompatibilityMode) {
			try {
				vscode.postMessage({ type: 'requestUpgradeToKqlx', addKind: k });
			} catch {
				// ignore
			}
			return;
		}
	} catch {
		// ignore
	}

	// Normal .kqlx flow.
	if (k === 'query') return addQueryBox();
	if (k === 'markdown') return addMarkdownBox();
	if (k === 'python') return addPythonBox();
	if (k === 'url') return addUrlBox();
}

// Replace the early bootstrap stub (defined in queryEditor.js before all scripts load).
// In some browsers, relying on a global function declaration is not enough to override
// an existing window property, so assign explicitly.
try {
	window.__kustoRequestAddSection = __kustoRequestAddSection;
} catch {
	// ignore
}

// During restore, Monaco editors are created asynchronously.
// Stash initial values here so init*Editor can apply them once the editor exists.
window.__kustoPendingQueryTextByBoxId = window.__kustoPendingQueryTextByBoxId || {};
window.__kustoPendingMarkdownTextByBoxId = window.__kustoPendingMarkdownTextByBoxId || {};
window.__kustoPendingPythonCodeByBoxId = window.__kustoPendingPythonCodeByBoxId || {};

// Optional persisted query results (per box), stored as JSON text.
// This stays in-memory and is included in getKqlxState.
window.__kustoQueryResultJsonByBoxId = window.__kustoQueryResultJsonByBoxId || {};

const __kustoMaxPersistedResultBytes = 200 * 1024;

function __kustoByteLengthUtf8(text) {
	try {
		if (typeof TextEncoder !== 'undefined') {
			return new TextEncoder().encode(String(text)).length;
		}
		// Fallback: approximate (UTF-16 code units). Safe enough for a cap.
		return String(text).length * 2;
	} catch {
		return Number.MAX_SAFE_INTEGER;
	}
}

function __kustoTryStoreQueryResult(boxId, result) {
	try {
		if (!boxId) return;
		let json = '';
		try {
			json = JSON.stringify(result ?? null);
		} catch {
			// If result isn't serializable, don't persist it.
			delete window.__kustoQueryResultJsonByBoxId[boxId];
			return;
		}
		const bytes = __kustoByteLengthUtf8(json);
		if (bytes <= __kustoMaxPersistedResultBytes) {
			window.__kustoQueryResultJsonByBoxId[boxId] = json;
		} else {
			delete window.__kustoQueryResultJsonByBoxId[boxId];
		}
	} catch {
		// ignore
	}
}

// Called by main.js when query results arrive.
function __kustoOnQueryResult(boxId, result) {
	__kustoTryStoreQueryResult(boxId, result);
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoGetWrapperHeightPx(boxId, suffix) {
	try {
		const el = document.getElementById(boxId + suffix);
		if (!el) return undefined;
		const wrapper = el.closest ? el.closest('.query-editor-wrapper') : null;
		if (!wrapper) return undefined;
		// Only persist heights that came from an explicit user resize (or a restored persisted height).
		// Auto-resize can set an inline height too, but that should not get saved into .kqlx.
		try {
			if (!wrapper.dataset || wrapper.dataset.kustoUserResized !== 'true') {
				return undefined;
			}
		} catch {
			return undefined;
		}
		// Only persist height if the user explicitly resized (wrapper has an inline height).
		// Otherwise, default layout can vary by window size/theme and would cause spurious "dirty" writes.
		const inlineHeight = (wrapper.style && typeof wrapper.style.height === 'string') ? wrapper.style.height.trim() : '';
		if (!inlineHeight || inlineHeight === 'auto') return undefined;
		const m = inlineHeight.match(/^([0-9]+)px$/i);
		if (!m) return undefined;
		const px = parseInt(m[1], 10);
		return Number.isFinite(px) ? Math.max(0, px) : undefined;
	} catch {
		return undefined;
	}
}

function __kustoSetWrapperHeightPx(boxId, suffix, heightPx) {
	try {
		const el = document.getElementById(boxId + suffix);
		if (!el) return;
		const wrapper = el.closest ? el.closest('.query-editor-wrapper') : null;
		if (!wrapper) return;
		const h = Number(heightPx);
		if (!Number.isFinite(h) || h <= 0) return;
		wrapper.style.height = Math.round(h) + 'px';
		try {
			wrapper.dataset.kustoUserResized = 'true';
		} catch {
			// ignore
		}
	} catch {
		// ignore
	}
}

function __kustoGetUrlOutputHeightPx(boxId) {
	try {
		const wrapper = document.getElementById(boxId + '_wrapper');
		if (!wrapper) return undefined;
		// Only persist heights that came from an explicit user resize (or a restored persisted height).
		// Auto/default layout can vary and should not mark the document dirty.
		try {
			if (!wrapper.dataset || wrapper.dataset.kustoUserResized !== 'true') {
				return undefined;
			}
		} catch {
			return undefined;
		}
		let inlineHeight = (wrapper.style && typeof wrapper.style.height === 'string') ? wrapper.style.height.trim() : '';
		// When URL CSV results are hidden we may collapse the wrapper to height:auto, but we still
		// want to persist the user's last explicit height.
		if (!inlineHeight || inlineHeight === 'auto') {
			try {
				const prev = (wrapper.dataset && wrapper.dataset.kustoPrevHeight) ? String(wrapper.dataset.kustoPrevHeight).trim() : '';
				if (prev) {
					inlineHeight = prev;
				}
			} catch {
				// ignore
			}
		}
		if (!inlineHeight || inlineHeight === 'auto') return undefined;
		const m = inlineHeight.match(/^([0-9]+)px$/i);
		if (!m) return undefined;
		const px = parseInt(m[1], 10);
		return Number.isFinite(px) ? Math.max(0, px) : undefined;
	} catch {
		return undefined;
	}
}

function __kustoSetUrlOutputHeightPx(boxId, heightPx) {
	try {
		const wrapper = document.getElementById(boxId + '_wrapper');
		if (!wrapper) return;
		const h = Number(heightPx);
		if (!Number.isFinite(h) || h <= 0) return;
		wrapper.style.height = Math.round(h) + 'px';
		try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
		// If this is a URL CSV section and the persisted height is larger than its contents,
		// clamp it once the DOM has finished laying out.
		try {
			setTimeout(() => {
				try {
					if (typeof window.__kustoClampUrlCsvWrapperHeight === 'function') {
						window.__kustoClampUrlCsvWrapperHeight(boxId);
					}
				} catch { /* ignore */ }
			}, 0);
		} catch { /* ignore */ }
	} catch {
		// ignore
	}
}

function getKqlxState() {
	// Compatibility mode (.kql/.csl): only a single query section is supported.
	try {
		if (window.__kustoCompatibilityMode) {
			let firstQueryBoxId = null;
			try {
				const ids = Array.isArray(queryBoxes) ? queryBoxes : [];
				for (const id of ids) {
					if (typeof id === 'string' && id.startsWith('query_')) {
						firstQueryBoxId = id;
						break;
					}
				}
			} catch {
				// ignore
			}
			const q = (firstQueryBoxId && queryEditors && queryEditors[firstQueryBoxId])
				? (queryEditors[firstQueryBoxId].getValue() || '')
				: '';
			return {
				caretDocsEnabled: (typeof caretDocsEnabled === 'boolean') ? caretDocsEnabled : true,
				sections: [{ type: 'query', query: q }]
			};
		}
	} catch {
		// ignore
	}

	const sections = [];
	const container = document.getElementById('queries-container');
	const children = container ? Array.from(container.children || []) : [];
	for (const child of children) {
		const id = child && child.id ? String(child.id) : '';
		if (!id) continue;

		if (id.startsWith('query_')) {
			const name = (document.getElementById(id + '_name') || {}).value || '';
			const connectionId = (document.getElementById(id + '_connection') || {}).value || '';
			let clusterUrl = '';
			try {
				if (connectionId && Array.isArray(connections)) {
					const conn = (connections || []).find(c => c && String(c.id || '') === String(connectionId));
					clusterUrl = conn ? String(conn.clusterUrl || '') : '';
				}
			} catch {
				// ignore
			}
			const database = (document.getElementById(id + '_database') || {}).value || '';
			const query = queryEditors && queryEditors[id] ? (queryEditors[id].getValue() || '') : '';
			const resultJson = (window.__kustoQueryResultJsonByBoxId && window.__kustoQueryResultJsonByBoxId[id])
				? String(window.__kustoQueryResultJsonByBoxId[id])
				: '';
			const runMode = (runModesByBoxId && runModesByBoxId[id]) ? String(runModesByBoxId[id]) : 'take100';
			const cacheEnabled = !!((document.getElementById(id + '_cache_enabled') || {}).checked);
			const cacheValue = parseInt(((document.getElementById(id + '_cache_value') || {}).value || '1'), 10) || 1;
			const cacheUnit = (document.getElementById(id + '_cache_unit') || {}).value || 'days';
			sections.push({
				type: 'query',
				name,
				clusterUrl,
				database,
				query,
				...(resultJson ? { resultJson } : {}),
				runMode,
				cacheEnabled,
				cacheValue,
				cacheUnit,
				editorHeightPx: __kustoGetWrapperHeightPx(id, '_query_editor')
			});
			continue;
		}

		if (id.startsWith('markdown_')) {
			const title = (document.getElementById(id + '_md_title') || {}).value || 'Markdown';
			const text = markdownEditors && markdownEditors[id] ? (markdownEditors[id].getValue() || '') : '';
			const tab = (markdownTabByBoxId && markdownTabByBoxId[id]) ? String(markdownTabByBoxId[id]) : 'edit';
			sections.push({
				type: 'markdown',
				title,
				text,
				tab: (tab === 'preview') ? 'preview' : 'edit',
				editorHeightPx: __kustoGetWrapperHeightPx(id, '_md_editor')
			});
			continue;
		}

		if (id.startsWith('python_')) {
			const code = pythonEditors && pythonEditors[id] ? (pythonEditors[id].getValue() || '') : '';
			const output = (document.getElementById(id + '_py_output') || {}).textContent || '';
			sections.push({
				type: 'python',
				code,
				output,
				editorHeightPx: __kustoGetWrapperHeightPx(id, '_py_editor')
			});
			continue;
		}

		if (id.startsWith('url_')) {
			const st = (urlStateByBoxId && urlStateByBoxId[id]) ? urlStateByBoxId[id] : null;
			const url = st ? (String(st.url || '')) : ((document.getElementById(id + '_input') || {}).value || '');
			const expanded = !!(st && st.expanded);
			sections.push({
				type: 'url',
				url,
				expanded,
				outputHeightPx: __kustoGetUrlOutputHeightPx(id)
			});
			continue;
		}
	}

	return {
		caretDocsEnabled: (typeof caretDocsEnabled === 'boolean') ? caretDocsEnabled : true,
		sections
	};
}

function schedulePersist() {
	if (!__kustoPersistenceEnabled || __kustoRestoreInProgress) {
		return;
	}
	try {
		if (__kustoPersistTimer) {
			clearTimeout(__kustoPersistTimer);
		}
		__kustoPersistTimer = setTimeout(() => {
			try {
				const state = getKqlxState();
				vscode.postMessage({ type: 'persistDocument', state });
			} catch {
				// ignore
			}
		}, 400);
	} catch {
		// ignore
	}
}

// Best-effort flush: when the user closes the editor, try to persist the latest state immediately.
// (The extension decides whether to actually auto-save to disk; for session.kqlx it does.)
try {
	window.addEventListener('beforeunload', () => {
		try {
			// Only force a final flush for the session file.
			if (!window.__kustoIsSessionFile) {
				return;
			}
			if (!__kustoPersistenceEnabled || __kustoRestoreInProgress) {
				return;
			}
			const state = getKqlxState();
			vscode.postMessage({ type: 'persistDocument', state, flush: true });
		} catch {
			// ignore
		}
	});
} catch {
	// ignore
}

function __kustoClearAllSections() {
	try {
		for (const id of (queryBoxes || []).slice()) {
			try { removeQueryBox(id); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
	try {
		for (const id of (markdownBoxes || []).slice()) {
			try { removeMarkdownBox(id); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
	try {
		for (const id of (pythonBoxes || []).slice()) {
			try { removePythonBox(id); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
	try {
		for (const id of (urlBoxes || []).slice()) {
			try { removeUrlBox(id); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
}

function applyKqlxState(state) {
	__kustoRestoreInProgress = true;
	try {
		__kustoPersistenceEnabled = false;

		// Reset persisted results when loading a new document.
		try { window.__kustoQueryResultJsonByBoxId = {}; } catch { /* ignore */ }

		__kustoClearAllSections();

		const s = state && typeof state === 'object' ? state : { sections: [] };

		// Respect a global user preference (persisted in extension globalState) once it exists.
		// Only fall back to document state if the user has never explicitly toggled the feature.
		const userSet = (() => {
			try {
				return !!window.__kustoCaretDocsEnabledUserSet;
			} catch {
				return false;
			}
		})();
		if (!userSet && typeof s.caretDocsEnabled === 'boolean') {
			caretDocsEnabled = !!s.caretDocsEnabled;
			try { updateCaretDocsToggleButtons(); } catch { /* ignore */ }
		}

		// Compatibility mode (.kql/.csl): force exactly one query editor and ignore all other sections.
		if (window.__kustoCompatibilityMode) {
			let queryText = '';
			try {
				const sections = Array.isArray(s.sections) ? s.sections : [];
				const first = sections.find(sec => sec && String(sec.type || '') === 'query');
				queryText = first ? String(first.query || '') : '';
			} catch {
				// ignore
			}
			const boxId = addQueryBox();
			try {
				window.__kustoPendingQueryTextByBoxId[boxId] = queryText;
			} catch {
				// ignore
			}
			return;
		}

		const sections = Array.isArray(s.sections) ? s.sections : [];
		const normalizeClusterUrlKey = (url) => {
			try {
				const raw = String(url || '').trim();
				if (!raw) return '';
				const withScheme = /^https?:\/\//i.test(raw) ? raw : ('https://' + raw.replace(/^\/+/, ''));
				const u = new URL(withScheme);
				// Lowercase host, drop trailing slashes.
				const out = (u.origin + u.pathname).replace(/\/+$/, '');
				return out.toLowerCase();
			} catch {
				return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
			}
		};
		const clusterShortNameKey = (url) => {
			try {
				const raw = String(url || '').trim();
				if (!raw) return '';
				const withScheme = /^https?:\/\//i.test(raw) ? raw : ('https://' + raw.replace(/^\/+/, ''));
				const u = new URL(withScheme);
				const host = String(u.hostname || '').trim();
				const first = host ? host.split('.')[0] : '';
				return String(first || host || raw).trim().toLowerCase();
			} catch {
				return String(url || '').trim().toLowerCase();
			}
		};
		const findConnectionIdByClusterUrl = (clusterUrl) => {
			try {
				const key = normalizeClusterUrlKey(clusterUrl);
				if (!key) return '';
				for (const c of (connections || [])) {
					if (!c) continue;
					const ck = normalizeClusterUrlKey(c.clusterUrl || '');
					if (ck && ck === key) {
						return String(c.id || '');
					}
				}
				// Fallback: match by short-name key.
				const sk = clusterShortNameKey(clusterUrl);
				if (sk) {
					for (const c of (connections || [])) {
						if (!c) continue;
						const ck2 = clusterShortNameKey(c.clusterUrl || '');
						if (ck2 && ck2 === sk) {
							return String(c.id || '');
						}
					}
				}
			} catch {
				// ignore
			}
			return '';
		};
		for (const section of sections) {
			const t = section && section.type ? String(section.type) : '';
			if (t === 'query') {
				const boxId = addQueryBox({
					id: (section.id ? String(section.id) : undefined)
				});
				try {
					const nameEl = document.getElementById(boxId + '_name');
					if (nameEl) nameEl.value = String(section.name || '');
				} catch { /* ignore */ }
				try {
					const desiredClusterUrl = String(section.clusterUrl || '');
					const resolvedConnectionId = desiredClusterUrl ? findConnectionIdByClusterUrl(desiredClusterUrl) : '';
					const db = String(section.database || '');
					const connEl = document.getElementById(boxId + '_connection');
					const dbEl = document.getElementById(boxId + '_database');
					if (dbEl) {
						dbEl.dataset.desired = db;
						// Optimistic restore: show the persisted DB immediately, even before the DB list loads.
						if (db) {
							const esc = (typeof escapeHtml === 'function') ? escapeHtml(db) : db;
							dbEl.innerHTML =
								'<option value="" disabled hidden>Select Database...</option>' +
								'<option value="' + esc + '">' + esc + '</option>';
							dbEl.value = db;
						}
					}
					if (connEl) {
						// Stash desired selection so updateConnectionSelects can apply it once
						// connections are populated (connections may arrive after document restore).
						if (desiredClusterUrl) {
							connEl.dataset.desiredClusterUrl = desiredClusterUrl;
						}

						if (resolvedConnectionId) {
							connEl.value = resolvedConnectionId;
							connEl.dataset.prevValue = resolvedConnectionId;
							updateDatabaseField(boxId);
						} else {
							// Try again after connections are populated.
							try { updateConnectionSelects(); } catch { /* ignore */ }
						}
					}
				} catch { /* ignore */ }
				// Monaco editor may not exist yet; store pending text for initQueryEditor.
				try {
					window.__kustoPendingQueryTextByBoxId[boxId] = String(section.query || '');
				} catch { /* ignore */ }
				// Restore last result (if present + parseable).
				try {
					const rj = section.resultJson ? String(section.resultJson) : '';
					if (rj) {
						// Keep in-memory cache aligned with restored boxes.
						window.__kustoQueryResultJsonByBoxId[boxId] = rj;
						try {
							const parsed = JSON.parse(rj);
							if (parsed && typeof parsed === 'object') {
								// displayResult expects columns/rows/metadata in the typical shape.
								const p = parsed;
								if (!p.metadata || typeof p.metadata !== 'object') {
									p.metadata = { executionTime: '' };
								} else if (typeof p.metadata.executionTime === 'undefined') {
									p.metadata.executionTime = '';
								}
								window.lastExecutedBox = boxId;
								if (typeof displayResult === 'function') {
									displayResult(p);
								}
							}
						} catch {
							// If stored JSON is invalid, drop it.
							delete window.__kustoQueryResultJsonByBoxId[boxId];
						}
					}
				} catch { /* ignore */ }
				try {
					setRunMode(boxId, String(section.runMode || 'take100'));
				} catch { /* ignore */ }
				try {
					const ce = document.getElementById(boxId + '_cache_enabled');
					const cv = document.getElementById(boxId + '_cache_value');
					const cu = document.getElementById(boxId + '_cache_unit');
					if (ce) ce.checked = (section.cacheEnabled !== false);
					if (cv) cv.value = String(section.cacheValue || 1);
					if (cu) cu.value = String(section.cacheUnit || 'days');
					try { toggleCacheControls(boxId); } catch { /* ignore */ }
				} catch { /* ignore */ }
				try { __kustoSetWrapperHeightPx(boxId, '_query_editor', section.editorHeightPx); } catch { /* ignore */ }
				continue;
			}

			if (t === 'markdown') {
				const boxId = addMarkdownBox({ id: (section.id ? String(section.id) : undefined) });
				try {
					const titleEl = document.getElementById(boxId + '_md_title');
					if (titleEl) titleEl.value = String(section.title || 'Markdown');
					try { onMarkdownTitleInput(boxId); } catch { /* ignore */ }
				} catch { /* ignore */ }
				// Monaco editor may not exist yet; store pending markdown for initMarkdownEditor.
				try {
					window.__kustoPendingMarkdownTextByBoxId[boxId] = String(section.text || '');
				} catch { /* ignore */ }
				try { setMarkdownTab(boxId, (section.tab === 'preview') ? 'preview' : 'edit'); } catch { /* ignore */ }
				try { __kustoSetWrapperHeightPx(boxId, '_md_editor', section.editorHeightPx); } catch { /* ignore */ }
				continue;
			}

			if (t === 'python') {
				const boxId = addPythonBox({ id: (section.id ? String(section.id) : undefined) });
				// Monaco editor may not exist yet; store pending python code for initPythonEditor.
				try {
					window.__kustoPendingPythonCodeByBoxId[boxId] = String(section.code || '');
				} catch { /* ignore */ }
				try { setPythonOutput(boxId, String(section.output || '')); } catch { /* ignore */ }
				try { __kustoSetWrapperHeightPx(boxId, '_py_editor', section.editorHeightPx); } catch { /* ignore */ }
				continue;
			}

			if (t === 'url') {
				const boxId = addUrlBox({ id: (section.id ? String(section.id) : undefined) });
				try {
					const url = String(section.url || '');
					const expanded = !!section.expanded;
					const input = document.getElementById(boxId + '_input');
					if (input) input.value = url;
					if (!urlStateByBoxId[boxId]) {
						urlStateByBoxId[boxId] = { url: '', expanded: false, loading: false, loaded: false, content: '', error: '', kind: '', contentType: '', status: null, dataUri: '', body: '', truncated: false };
					}
					urlStateByBoxId[boxId].url = url;
					urlStateByBoxId[boxId].expanded = expanded;
					urlStateByBoxId[boxId].loaded = false;
					urlStateByBoxId[boxId].content = '';
					urlStateByBoxId[boxId].error = '';
					urlStateByBoxId[boxId].kind = '';
					urlStateByBoxId[boxId].contentType = '';
					urlStateByBoxId[boxId].status = null;
					urlStateByBoxId[boxId].dataUri = '';
					urlStateByBoxId[boxId].body = '';
					urlStateByBoxId[boxId].truncated = false;
					try { __kustoSetUrlOutputHeightPx(boxId, section.outputHeightPx); } catch { /* ignore */ }
					try {
						if (typeof __kustoUpdateUrlToggleButton === 'function') {
							__kustoUpdateUrlToggleButton(boxId);
						}
					} catch { /* ignore */ }
					updateUrlContent(boxId);
					// On open/restore: if the section is visible, automatically fetch its content.
					try {
						if (expanded && url && typeof requestUrlContent === 'function') {
							requestUrlContent(boxId);
						}
					} catch { /* ignore */ }
				} catch { /* ignore */ }
				continue;
			}
		}
	} finally {
		__kustoRestoreInProgress = false;
		__kustoPersistenceEnabled = true;
		// Do not auto-persist immediately after restore: Monaco editors may not be ready yet,
		// and persisting too early can overwrite loaded content with empty strings.
	}
}

function __kustoApplyPendingAdds() {
	const pendingAdds = (window.__kustoQueryEditorPendingAdds && typeof window.__kustoQueryEditorPendingAdds === 'object')
		? window.__kustoQueryEditorPendingAdds
		: { query: 0, markdown: 0, python: 0, url: 0 };
	// Reset counts so they don't replay on reload.
	window.__kustoQueryEditorPendingAdds = { query: 0, markdown: 0, python: 0, url: 0 };

	const pendingTotal = (pendingAdds.query || 0) + (pendingAdds.markdown || 0) + (pendingAdds.python || 0) + (pendingAdds.url || 0);
	if (pendingTotal <= 0) {
		return false;
	}
	for (let i = 0; i < (pendingAdds.query || 0); i++) addQueryBox();
	for (let i = 0; i < (pendingAdds.markdown || 0); i++) addMarkdownBox();
	for (let i = 0; i < (pendingAdds.python || 0); i++) addPythonBox();
	for (let i = 0; i < (pendingAdds.url || 0); i++) addUrlBox();
	return true;
}

function handleDocumentDataMessage(message) {
	__kustoDocumentDataApplyCount++;
	try {
		const sectionCount = Array.isArray(message && message.state && message.state.sections)
			? message.state.sections.length
			: 0;
		console.log('[kusto] documentData', { count: __kustoDocumentDataApplyCount, ok: !!(message && message.ok), sections: sectionCount });
	} catch {
		// ignore
	}

	// The extension host should only send documentData in response to requestDocument.
	// If we receive it more than once, re-applying causes noticeable flicker and can leave
	// Monaco editors in a bad interactive state due to teardown/recreate races.
	// So by default, only apply the first documentData payload.
	try {
		if (__kustoHasAppliedDocument && !(message && message.forceReload)) {
			return;
		}
	} catch {
		// ignore
	}
	__kustoHasAppliedDocument = true;

	// Some host-to-webview messages can arrive before the webview registers its message listener.
	// documentData is requested by the webview after initialization, so it is a reliable place
	// to apply compatibility mode for .kql/.csl files.
	try {
		if (typeof message.compatibilityMode === 'boolean') {
			if (typeof __kustoSetCompatibilityMode === 'function') {
				__kustoSetCompatibilityMode(!!message.compatibilityMode);
			} else {
				window.__kustoCompatibilityMode = !!message.compatibilityMode;
			}
		}
	} catch {
		// ignore
	}

	const ok = !!(message && message.ok);
	if (!ok && message && message.error) {
		try {
			// Non-fatal: start with an empty doc state.
			console.warn('Failed to parse .kqlx:', message.error);
		} catch {
			// ignore
		}
	}

	applyKqlxState(message && message.state ? message.state : { sections: [] });

	// If the doc is empty, initialize UX content.
	try {
		const hasAny = (queryBoxes && queryBoxes.length) || (markdownBoxes && markdownBoxes.length) || (pythonBoxes && pythonBoxes.length) || (urlBoxes && urlBoxes.length);
		if (!hasAny) {
			const applied = __kustoApplyPendingAdds();
			if (!applied) {
				addQueryBox();
			}
		}
	} catch {
		// ignore
	}

	// Persistence remains enabled; edits will persist via event hooks.
}
