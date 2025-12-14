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

// During restore, Monaco editors are created asynchronously.
// Stash initial values here so init*Editor can apply them once the editor exists.
window.__kustoPendingQueryTextByBoxId = window.__kustoPendingQueryTextByBoxId || {};
window.__kustoPendingMarkdownTextByBoxId = window.__kustoPendingMarkdownTextByBoxId || {};
window.__kustoPendingPythonCodeByBoxId = window.__kustoPendingPythonCodeByBoxId || {};

function __kustoGetWrapperHeightPx(boxId, suffix) {
	try {
		const el = document.getElementById(boxId + suffix);
		if (!el) return undefined;
		const wrapper = el.closest ? el.closest('.query-editor-wrapper') : null;
		if (!wrapper) return undefined;
		const h = wrapper.getBoundingClientRect().height;
		return Number.isFinite(h) ? Math.max(0, Math.round(h)) : undefined;
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
	} catch {
		// ignore
	}
}

function getKqlxState() {
	const sections = [];
	const container = document.getElementById('queries-container');
	const children = container ? Array.from(container.children || []) : [];
	for (const child of children) {
		const id = child && child.id ? String(child.id) : '';
		if (!id) continue;

		if (id.startsWith('query_')) {
			const name = (document.getElementById(id + '_name') || {}).value || '';
			const connectionId = (document.getElementById(id + '_connection') || {}).value || '';
			const database = (document.getElementById(id + '_database') || {}).value || '';
			const query = queryEditors && queryEditors[id] ? (queryEditors[id].getValue() || '') : '';
			const runMode = (runModesByBoxId && runModesByBoxId[id]) ? String(runModesByBoxId[id]) : 'take100';
			const cacheEnabled = !!((document.getElementById(id + '_cache_enabled') || {}).checked);
			const cacheValue = parseInt(((document.getElementById(id + '_cache_value') || {}).value || '1'), 10) || 1;
			const cacheUnit = (document.getElementById(id + '_cache_unit') || {}).value || 'days';
			sections.push({
				type: 'query',
				name,
				connectionId,
				database,
				query,
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
				expanded
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

		__kustoClearAllSections();

		const s = state && typeof state === 'object' ? state : { sections: [] };

		if (typeof s.caretDocsEnabled === 'boolean') {
			caretDocsEnabled = !!s.caretDocsEnabled;
			try { updateCaretDocsToggleButtons(); } catch { /* ignore */ }
		}

		const sections = Array.isArray(s.sections) ? s.sections : [];
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
					const conn = String(section.connectionId || '');
					const db = String(section.database || '');
					const connEl = document.getElementById(boxId + '_connection');
					const dbEl = document.getElementById(boxId + '_database');
					if (dbEl) dbEl.dataset.desired = db;
					if (connEl && conn) {
						connEl.value = conn;
						connEl.dataset.prevValue = conn;
						updateDatabaseField(boxId);
					}
				} catch { /* ignore */ }
				// Monaco editor may not exist yet; store pending text for initQueryEditor.
				try {
					window.__kustoPendingQueryTextByBoxId[boxId] = String(section.query || '');
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
						urlStateByBoxId[boxId] = { url: '', expanded: false, loading: false, loaded: false, content: '', error: '' };
					}
					urlStateByBoxId[boxId].url = url;
					urlStateByBoxId[boxId].expanded = expanded;
					urlStateByBoxId[boxId].loaded = false;
					urlStateByBoxId[boxId].content = '';
					urlStateByBoxId[boxId].error = '';
					try {
						const btn = document.getElementById(boxId + '_toggle');
						if (btn) btn.textContent = expanded ? 'Hide' : 'Show';
					} catch { /* ignore */ }
					updateUrlContent(boxId);
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
