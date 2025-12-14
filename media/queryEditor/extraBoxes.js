// Additional section types for the Kusto Query Editor webview:
// - Markdown: Monaco editor while focused; rendered markdown viewer on blur
// - Python: Monaco editor + Run button; output viewer
// - URL: URL input + expand/collapse content viewer; content fetched by extension host

let markdownBoxes = [];
let pythonBoxes = [];
let urlBoxes = [];

let markdownEditors = {};
let pythonEditors = {};

let markdownRenderCacheByBoxId = {};
let markdownTabByBoxId = {}; // 'edit' | 'preview'
let markdownEditHeightByBoxId = {}; // number (px) - last editor wrapper height
let urlStateByBoxId = {}; // { url, expanded, loading, loaded, content, error, kind, contentType, status, dataUri, body, truncated }

let markdownMarkedResolvePromise = null;

function ensureMarkedGlobal() {
	// Marked may have registered itself as an AMD module (because Monaco installs `define.amd`)
	// instead of attaching to `window.marked`. Preview rendering expects `marked` to exist,
	// so if it's missing, try to resolve it from the AMD loader.
	try {
		if (typeof marked !== 'undefined' && marked) {
			return Promise.resolve(marked);
		}
	} catch {
		// ignore
	}

	if (markdownMarkedResolvePromise) {
		return markdownMarkedResolvePromise;
	}

	markdownMarkedResolvePromise = new Promise((resolve) => {
		try {
			if (typeof require === 'function') {
				require(
					['marked'],
					(m) => {
						try {
							if (typeof marked === 'undefined' || !marked) {
								// Best-effort: make it available as a global for the existing renderer.
								window.marked = m;
							}
						} catch {
							// ignore
						}
						resolve(m);
					},
					() => resolve(null)
				);
				return;
			}
		} catch {
			// ignore
		}
		resolve(null);
	});

	return markdownMarkedResolvePromise;
}

function autoSizeTitleInput(inputEl) {
	if (!inputEl) {
		return;
	}
	// Use pixel sizing based on scrollWidth so the input hugs its contents
	// (the `size` attribute tends to leave visible extra whitespace).
	try {
		inputEl.style.width = '1px';
		const pad = 1; // small breathing room (keep tight)
		const minPx = 56;
		const maxPx = 320;
		const w = Math.max(minPx, Math.min(maxPx, (inputEl.scrollWidth || 0) + pad));
		inputEl.style.width = w + 'px';
	} catch {
		// ignore
	}
}

function focusMarkdownTitle(boxId) {
	const input = document.getElementById(boxId + '_md_title');
	if (!input) {
		return;
	}
	try {
		input.focus();
		input.select();
	} catch {
		// ignore
	}
}

function onMarkdownTitleInput(boxId) {
	const input = document.getElementById(boxId + '_md_title');
	autoSizeTitleInput(input);
}

function __kustoUpdateUrlToggleButton(boxId) {
	const btn = document.getElementById(boxId + '_toggle');
	const st = urlStateByBoxId[boxId];
	if (!btn || !st) {
		return;
	}
	const expanded = !!st.expanded;
	btn.classList.toggle('is-active', expanded);
	btn.setAttribute('aria-selected', expanded ? 'true' : 'false');
	btn.title = expanded ? 'Hide' : 'Show';
	btn.setAttribute('aria-label', expanded ? 'Hide' : 'Show');
}

function addMarkdownBox(options) {
	const id = (options && options.id) ? String(options.id) : ('markdown_' + Date.now());
	markdownBoxes.push(id);
	markdownTabByBoxId[id] = 'edit';

	const container = document.getElementById('queries-container');
	if (!container) {
		return;
	}

	const closeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M4 4l8 8"/>' +
		'<path d="M12 4L4 12"/>' +
		'</svg>';

	const editIconSvg =
		'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M11.6 2.2l2.2 2.2" />' +
		'<path d="M4 12l-1 3 3-1 7.7-7.7-2.2-2.2L4 12z" />' +
		'<path d="M10.4 3.4l2.2 2.2" />' +
		'</svg>';

	const previewIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z" />' +
		'<circle cx="8" cy="8" r="2.1" />' +
		'</svg>';

	const boxHtml =
		'<div class="query-box" id="' + id + '">' +
		'<div class="section-header-row md-section-header">' +
		'<div class="md-header-center">' +
		'<div class="section-title-edit">' +
		'<input class="section-title-input" id="' + id + '_md_title" type="text" value="Markdown" size="8" oninput="onMarkdownTitleInput(\'' + id + '\')" aria-label="Section title" />' +
		'<button class="section-title-pen" type="button" onclick="focusMarkdownTitle(\'' + id + '\')" title="Rename" aria-label="Rename">' + editIconSvg + '</button>' +
		'</div>' +
		'</div>' +
		'<div class="section-actions">' +
		'<div class="md-tabs" role="tablist" aria-label="Markdown mode">' +
		'<button class="md-tab is-active" id="' + id + '_tab_edit" type="button" role="tab" aria-selected="true" onclick="setMarkdownTab(\'' + id + '\', \'edit\')" title="Edit" aria-label="Edit">' + editIconSvg + '</button>' +
		'<button class="md-tab" id="' + id + '_tab_preview" type="button" role="tab" aria-selected="false" onclick="setMarkdownTab(\'' + id + '\', \'preview\')" title="Preview" aria-label="Preview">' + previewIconSvg + '</button>' +
		'</div>' +
		'<button class="refresh-btn close-btn" type="button" onclick="removeMarkdownBox(\'' + id + '\')" title="Remove" aria-label="Remove">' + closeIconSvg + '</button>' +
		'</div>' +
		'</div>' +
		'<div class="query-editor-wrapper">' +
		'<div class="query-editor" id="' + id + '_md_editor"></div>' +
		'<div class="markdown-viewer" id="' + id + '_md_viewer" style="display:none;"></div>' +
		'<div class="query-editor-resizer" id="' + id + '_md_resizer" title="Drag to resize"></div>' +
		'</div>' +
		'</div>';

	container.insertAdjacentHTML('beforeend', boxHtml);
	try {
		onMarkdownTitleInput(id);
	} catch {
		// ignore
	}
	initMarkdownEditor(id);
	setMarkdownTab(id, 'edit');
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
	try {
		const controls = document.querySelector('.add-controls');
		if (controls && typeof controls.scrollIntoView === 'function') {
			controls.scrollIntoView({ block: 'end' });
		}
	} catch {
		// ignore
	}
	return id;
}

function removeMarkdownBox(boxId) {
	if (markdownEditors[boxId]) {
		try { markdownEditors[boxId].dispose(); } catch { /* ignore */ }
		delete markdownEditors[boxId];
	}
	delete markdownRenderCacheByBoxId[boxId];
	delete markdownTabByBoxId[boxId];
	delete markdownEditHeightByBoxId[boxId];
	markdownBoxes = markdownBoxes.filter(id => id !== boxId);
	const box = document.getElementById(boxId);
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function setMarkdownTab(boxId, tab) {
	const next = (tab === 'preview') ? 'preview' : 'edit';
	markdownTabByBoxId[boxId] = next;
	try {
		const box = document.getElementById(boxId);
		if (box) {
			box.classList.toggle('is-md-preview', next === 'preview');
		}
	} catch {
		// ignore
	}

	const tabEdit = document.getElementById(boxId + '_tab_edit');
	const tabPreview = document.getElementById(boxId + '_tab_preview');
	if (tabEdit) {
		tabEdit.classList.toggle('is-active', next === 'edit');
		tabEdit.setAttribute('aria-selected', next === 'edit' ? 'true' : 'false');
	}
	if (tabPreview) {
		tabPreview.classList.toggle('is-active', next === 'preview');
		tabPreview.setAttribute('aria-selected', next === 'preview' ? 'true' : 'false');
	}

	const editorEl = document.getElementById(boxId + '_md_editor');
	const viewerEl = document.getElementById(boxId + '_md_viewer');
	if (!editorEl || !viewerEl) {
		return;
	}

	let wrapper = null;
	try {
		wrapper = editorEl.closest ? editorEl.closest('.query-editor-wrapper') : null;
	} catch {
		wrapper = null;
	}

	if (next === 'preview') {
		// Remember current editor height (so returning to Edit keeps the user's resize).
		try {
			if (wrapper) {
				markdownEditHeightByBoxId[boxId] = wrapper.getBoundingClientRect().height;
				wrapper.style.height = 'auto';
			}
		} catch {
			// ignore
		}
		try {
			const editor = markdownEditors[boxId];
			const markdown = editor && editor.getModel ? (editor.getModel() ? editor.getModel().getValue() : '') : '';
			renderMarkdownIntoViewer(boxId, markdown);
		} catch {
			// ignore
		}
		editorEl.style.display = 'none';
		viewerEl.style.display = '';
		try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
		return;
	}

	// Returning to Edit: restore the last known height.
	try {
		if (wrapper) {
			const saved = markdownEditHeightByBoxId[boxId];
			if (typeof saved === 'number' && isFinite(saved) && saved > 0) {
				wrapper.style.height = Math.round(saved) + 'px';
			} else {
				wrapper.style.height = '';
			}
		}
	} catch {
		// ignore
	}

	viewerEl.style.display = 'none';
	editorEl.style.display = '';
	try {
		if (markdownEditors[boxId]) {
			markdownEditors[boxId].layout();
		}
	} catch {
		// ignore
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function initMarkdownEditor(boxId) {
	return ensureMonaco().then(monaco => {
		const container = document.getElementById(boxId + '_md_editor');
		const viewer = document.getElementById(boxId + '_md_viewer');
		if (!container || !viewer) {
			return;
		}

		// If an editor exists, ensure it's still attached to this container.
		try {
			const existing = markdownEditors && markdownEditors[boxId] ? markdownEditors[boxId] : null;
			if (existing) {
				const dom = (typeof existing.getDomNode === 'function') ? existing.getDomNode() : null;
				const attached = !!(dom && dom.isConnected && container.contains(dom));
				if (attached) {
					return;
				}
				try { existing.dispose(); } catch { /* ignore */ }
				try { delete markdownEditors[boxId]; } catch { /* ignore */ }
			}
		} catch {
			// ignore
		}

		container.style.minHeight = '0';
		container.style.minWidth = '0';

		// Avoid editor.setValue() during init; pass initial value into create() to reduce timing races.
		let initialValue = '';
		try {
			const pending = window.__kustoPendingMarkdownTextByBoxId && window.__kustoPendingMarkdownTextByBoxId[boxId];
			if (typeof pending === 'string') {
				initialValue = pending;
				try { delete window.__kustoPendingMarkdownTextByBoxId[boxId]; } catch { /* ignore */ }
			}
		} catch {
			// ignore
		}

		const editor = monaco.editor.create(container, {
			value: initialValue,
			language: 'markdown',
			readOnly: false,
			domReadOnly: false,
			automaticLayout: true,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			fontFamily: getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family'),
			fontSize: 13,
			lineNumbers: 'on',
			renderLineHighlight: 'none'
		});

		// Mark this as the active Monaco editor for global key handlers (paste, etc.).
		try {
			if (typeof editor.onDidFocusEditorText === 'function') {
				editor.onDidFocusEditorText(() => {
					try { activeMonacoEditor = editor; } catch { /* ignore */ }
					try {
						if (typeof __kustoForceEditorWritable === 'function') {
							__kustoForceEditorWritable(editor);
						}
					} catch { /* ignore */ }
				});
			}
			if (typeof editor.onDidFocusEditorWidget === 'function') {
				editor.onDidFocusEditorWidget(() => {
					try { activeMonacoEditor = editor; } catch { /* ignore */ }
					try {
						if (typeof __kustoForceEditorWritable === 'function') {
							__kustoForceEditorWritable(editor);
						}
					} catch { /* ignore */ }
				});
			}
		} catch {
			// ignore
		}

		markdownEditors[boxId] = editor;
		// Work around sporadic webview timing issues where Monaco input can end up stuck readonly.
		try {
			if (typeof __kustoEnsureEditorWritableSoon === 'function') {
				__kustoEnsureEditorWritableSoon(editor);
			}
		} catch {
			// ignore
		}
		try {
			if (typeof __kustoInstallWritableGuard === 'function') {
				__kustoInstallWritableGuard(editor);
			}
		} catch {
			// ignore
		}
		// If the editor is stuck non-interactive on click, force writable before focusing.
		try {
			container.addEventListener('mousedown', () => {
				try {
					if (typeof __kustoForceEditorWritable === 'function') {
						__kustoForceEditorWritable(editor);
					}
				} catch { /* ignore */ }
				try { editor.focus(); } catch { /* ignore */ }
			}, true);
		} catch {
			// ignore
		}
		// Auto-resize editor to show full content, until the user manually resizes.
		try {
			if (typeof __kustoAttachAutoResizeToContent === 'function') {
				__kustoAttachAutoResizeToContent(editor, container);
			}
		} catch {
			// ignore
		}
		try {
			editor.onDidChangeModelContent(() => {
				try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
			});
		} catch {
			// ignore
		}

		// Drag handle resize (same pattern as the KQL editor).
		try {
			const wrapper = container.closest ? container.closest('.query-editor-wrapper') : null;
			const resizer = document.getElementById(boxId + '_md_resizer');
			if (wrapper && resizer) {
				resizer.addEventListener('mousedown', (e) => {
					try {
						e.preventDefault();
						e.stopPropagation();
					} catch {
						// ignore
					}
					try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }

					resizer.classList.add('is-dragging');
					const previousCursor = document.body.style.cursor;
					const previousUserSelect = document.body.style.userSelect;
					document.body.style.cursor = 'ns-resize';
					document.body.style.userSelect = 'none';

					const startY = e.clientY;
					const startHeight = wrapper.getBoundingClientRect().height;

					const onMove = (moveEvent) => {
						const delta = moveEvent.clientY - startY;
						const nextHeight = Math.max(120, Math.min(900, startHeight + delta));
						wrapper.style.height = nextHeight + 'px';
						try { editor.layout(); } catch { /* ignore */ }
					};
					const onUp = () => {
						document.removeEventListener('mousemove', onMove, true);
						document.removeEventListener('mouseup', onUp, true);
						resizer.classList.remove('is-dragging');
						document.body.style.cursor = previousCursor;
						document.body.style.userSelect = previousUserSelect;
						try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
					};

					document.addEventListener('mousemove', onMove, true);
					document.addEventListener('mouseup', onUp, true);
				});
			}
		} catch {
			// ignore
		}

		// Respect whichever tab is currently selected.
		try {
			setMarkdownTab(boxId, markdownTabByBoxId[boxId] || 'edit');
		} catch {
			// ignore
		}
	}).catch((e) => {
		try {
			if (markdownEditors && markdownEditors[boxId]) {
				return;
			}
		} catch {
			// ignore
		}

		let attempt = 0;
		try {
			window.__kustoMonacoInitRetryCountByBoxId = window.__kustoMonacoInitRetryCountByBoxId || {};
			attempt = (window.__kustoMonacoInitRetryCountByBoxId[boxId] || 0) + 1;
			window.__kustoMonacoInitRetryCountByBoxId[boxId] = attempt;
		} catch {
			attempt = 1;
		}

		const delays = [50, 250, 1000, 2000, 4000];
		const delay = delays[Math.min(attempt - 1, delays.length - 1)];
		if (attempt > delays.length) {
			try { console.error('Monaco init failed (markdown editor).', e); } catch { /* ignore */ }
			return;
		}
		try {
			setTimeout(() => {
				try { initMarkdownEditor(boxId); } catch { /* ignore */ }
			}, delay);
		} catch {
			// ignore
		}
	});
}

function renderMarkdownIntoViewer(boxId, markdown) {
	const viewer = document.getElementById(boxId + '_md_viewer');
	if (!viewer) {
		return;
	}
	const text = String(markdown || '');
	if (!text.trim()) {
		viewer.textContent = '';
		markdownRenderCacheByBoxId[boxId] = '';
		return;
	}

	// Use Marked + DOMPurify if available; otherwise fall back to plain text.
	try {
		const hasMarked = (typeof marked !== 'undefined') && marked;
		const parseFn = hasMarked ? (
			(typeof marked.parse === 'function') ? marked.parse :
			(typeof marked.marked === 'function') ? marked.marked :
			(typeof marked === 'function') ? marked :
			null
		) : null;

		let purifier = null;
		if (typeof DOMPurify !== 'undefined' && DOMPurify) {
			if (typeof DOMPurify.sanitize === 'function') {
				purifier = DOMPurify;
			} else if (typeof DOMPurify === 'function') {
				// Some DOMPurify builds export a factory that needs the window.
				try {
					const maybe = DOMPurify(window);
					if (maybe && typeof maybe.sanitize === 'function') {
						purifier = maybe;
					}
				} catch {
					// ignore
				}
			}
		}

		if (typeof parseFn === 'function') {
			const html = parseFn(text, { mangle: false, headerIds: false });
			const sanitized = purifier ? purifier.sanitize(html, { USE_PROFILES: { html: true } }) : html;
			viewer.innerHTML = sanitized;
			markdownRenderCacheByBoxId[boxId] = sanitized;
			return;
		}
	} catch {
		// ignore
	}

	// If Marked got captured as an AMD module, resolve it and retry (best-effort).
	try {
		ensureMarkedGlobal().then(() => {
			try {
				if ((markdownTabByBoxId[boxId] || 'edit') === 'preview') {
					renderMarkdownIntoViewer(boxId, markdown);
				}
			} catch {
				// ignore
			}
		});
	} catch {
		// ignore
	}
	viewer.textContent = text;
	markdownRenderCacheByBoxId[boxId] = '';
}

function addPythonBox(options) {
	const id = (options && options.id) ? String(options.id) : ('python_' + Date.now());
	pythonBoxes.push(id);

	const container = document.getElementById('queries-container');
	if (!container) {
		return;
	}

	const closeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M4 4l8 8"/>' +
		'<path d="M12 4L4 12"/>' +
		'</svg>';

	const boxHtml =
		'<div class="query-box" id="' + id + '">' +
		'<div class="section-header-row">' +
		'<div class="section-title">Python</div>' +
		'<div class="section-actions">' +
		'<button class="section-btn" type="button" onclick="runPythonBox(\'' + id + '\')" title="Run Python">▶ Run</button>' +
		'<button class="section-btn" type="button" onclick="removePythonBox(\'' + id + '\')" title="Remove" aria-label="Remove">' + closeIconSvg + '</button>' +
		'</div>' +
		'</div>' +
		'<div class="query-editor-wrapper">' +
		'<div class="query-editor" id="' + id + '_py_editor"></div>' +
		'<div class="query-editor-resizer" id="' + id + '_py_resizer" title="Drag to resize editor"></div>' +
		'</div>' +
		'<div class="python-output" id="' + id + '_py_output" aria-label="Python output"></div>' +
		'</div>';

	container.insertAdjacentHTML('beforeend', boxHtml);
	initPythonEditor(id);
	setPythonOutput(id, '');
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
	try {
		const controls = document.querySelector('.add-controls');
		if (controls && typeof controls.scrollIntoView === 'function') {
			controls.scrollIntoView({ block: 'end' });
		}
	} catch {
		// ignore
	}
	return id;
}

function removePythonBox(boxId) {
	if (pythonEditors[boxId]) {
		try { pythonEditors[boxId].dispose(); } catch { /* ignore */ }
		delete pythonEditors[boxId];
	}
	pythonBoxes = pythonBoxes.filter(id => id !== boxId);
	const box = document.getElementById(boxId);
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function initPythonEditor(boxId) {
	return ensureMonaco().then(monaco => {
		const container = document.getElementById(boxId + '_py_editor');
		if (!container) {
			return;
		}

		// If an editor exists, ensure it's still attached to this container.
		try {
			const existing = pythonEditors && pythonEditors[boxId] ? pythonEditors[boxId] : null;
			if (existing) {
				const dom = (typeof existing.getDomNode === 'function') ? existing.getDomNode() : null;
				const attached = !!(dom && dom.isConnected && container.contains(dom));
				if (attached) {
					return;
				}
				try { existing.dispose(); } catch { /* ignore */ }
				try { delete pythonEditors[boxId]; } catch { /* ignore */ }
			}
		} catch {
			// ignore
		}

		container.style.minHeight = '0';
		container.style.minWidth = '0';

		// Avoid editor.setValue() during init; pass initial value into create() to reduce timing races.
		let initialValue = '';
		try {
			const pending = window.__kustoPendingPythonCodeByBoxId && window.__kustoPendingPythonCodeByBoxId[boxId];
			if (typeof pending === 'string') {
				initialValue = pending;
				try { delete window.__kustoPendingPythonCodeByBoxId[boxId]; } catch { /* ignore */ }
			}
		} catch {
			// ignore
		}

		const editor = monaco.editor.create(container, {
			value: initialValue,
			language: 'python',
			readOnly: false,
			domReadOnly: false,
			automaticLayout: true,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			fontFamily: getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family'),
			fontSize: 13,
			lineNumbers: 'on',
			renderLineHighlight: 'none'
		});

		// Mark this as the active Monaco editor for global key handlers (paste, etc.).
		try {
			if (typeof editor.onDidFocusEditorText === 'function') {
				editor.onDidFocusEditorText(() => {
					try { activeMonacoEditor = editor; } catch { /* ignore */ }
					try {
						if (typeof __kustoForceEditorWritable === 'function') {
							__kustoForceEditorWritable(editor);
						}
					} catch { /* ignore */ }
				});
			}
			if (typeof editor.onDidFocusEditorWidget === 'function') {
				editor.onDidFocusEditorWidget(() => {
					try { activeMonacoEditor = editor; } catch { /* ignore */ }
					try {
						if (typeof __kustoForceEditorWritable === 'function') {
							__kustoForceEditorWritable(editor);
						}
					} catch { /* ignore */ }
				});
			}
		} catch {
			// ignore
		}

		pythonEditors[boxId] = editor;
		// Work around sporadic webview timing issues where Monaco input can end up stuck readonly.
		try {
			if (typeof __kustoEnsureEditorWritableSoon === 'function') {
				__kustoEnsureEditorWritableSoon(editor);
			}
		} catch {
			// ignore
		}
		try {
			if (typeof __kustoInstallWritableGuard === 'function') {
				__kustoInstallWritableGuard(editor);
			}
		} catch {
			// ignore
		}
		// If the editor is stuck non-interactive on click, force writable before focusing.
		try {
			container.addEventListener('mousedown', () => {
				try {
					if (typeof __kustoForceEditorWritable === 'function') {
						__kustoForceEditorWritable(editor);
					}
				} catch { /* ignore */ }
				try { editor.focus(); } catch { /* ignore */ }
			}, true);
		} catch {
			// ignore
		}
		// Auto-resize editor to show full content, until the user manually resizes.
		try {
			if (typeof __kustoAttachAutoResizeToContent === 'function') {
				__kustoAttachAutoResizeToContent(editor, container);
			}
		} catch {
			// ignore
		}
		try {
			editor.onDidChangeModelContent(() => {
				try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
			});
		} catch {
			// ignore
		}

		// Drag handle resize (copied from KQL editor behavior).
		try {
			const wrapper = container.closest ? container.closest('.query-editor-wrapper') : null;
			const resizer = document.getElementById(boxId + '_py_resizer');
			if (wrapper && resizer) {
				resizer.addEventListener('mousedown', (e) => {
					try {
						e.preventDefault();
						e.stopPropagation();
					} catch {
						// ignore
					}
					try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }

					resizer.classList.add('is-dragging');
					const previousCursor = document.body.style.cursor;
					const previousUserSelect = document.body.style.userSelect;
					document.body.style.cursor = 'ns-resize';
					document.body.style.userSelect = 'none';

					const startY = e.clientY;
					const startHeight = wrapper.getBoundingClientRect().height;

					const onMove = (moveEvent) => {
						const delta = moveEvent.clientY - startY;
						const nextHeight = Math.max(120, Math.min(900, startHeight + delta));
						wrapper.style.height = nextHeight + 'px';
						try { editor.layout(); } catch { /* ignore */ }
					};
					const onUp = () => {
						document.removeEventListener('mousemove', onMove, true);
						document.removeEventListener('mouseup', onUp, true);
						resizer.classList.remove('is-dragging');
						document.body.style.cursor = previousCursor;
						document.body.style.userSelect = previousUserSelect;
						try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
					};

					document.addEventListener('mousemove', onMove, true);
					document.addEventListener('mouseup', onUp, true);
				});
			}
		} catch {
			// ignore
		}
	}).catch((e) => {
		try {
			if (pythonEditors && pythonEditors[boxId]) {
				return;
			}
		} catch {
			// ignore
		}

		let attempt = 0;
		try {
			window.__kustoMonacoInitRetryCountByBoxId = window.__kustoMonacoInitRetryCountByBoxId || {};
			attempt = (window.__kustoMonacoInitRetryCountByBoxId[boxId] || 0) + 1;
			window.__kustoMonacoInitRetryCountByBoxId[boxId] = attempt;
		} catch {
			attempt = 1;
		}

		const delays = [50, 250, 1000, 2000, 4000];
		const delay = delays[Math.min(attempt - 1, delays.length - 1)];
		if (attempt > delays.length) {
			try { console.error('Monaco init failed (python editor).', e); } catch { /* ignore */ }
			return;
		}
		try {
			setTimeout(() => {
				try { initPythonEditor(boxId); } catch { /* ignore */ }
			}, delay);
		} catch {
			// ignore
		}
	});
}

function setPythonOutput(boxId, text) {
	const out = document.getElementById(boxId + '_py_output');
	if (!out) {
		return;
	}
	out.textContent = String(text || '');
}

function runPythonBox(boxId) {
	const editor = pythonEditors[boxId];
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	const code = model ? model.getValue() : '';
	setPythonOutput(boxId, 'Running…');
	try {
		vscode.postMessage({ type: 'executePython', boxId, code });
	} catch (e) {
		setPythonOutput(boxId, 'Failed to send run request.');
	}
}

function onPythonResult(message) {
	const boxId = message && message.boxId ? String(message.boxId) : '';
	if (!boxId) {
		return;
	}
	const stdout = String(message.stdout || '');
	const stderr = String(message.stderr || '');
	const exitCode = (typeof message.exitCode === 'number') ? message.exitCode : null;
	let out = '';
	if (stdout.trim()) {
		out += stdout;
	}
	if (stderr.trim()) {
		if (out) out += '\n\n';
		out += stderr;
	}
	if (!out) {
		out = (exitCode === 0) ? '' : 'No output.';
	}
	setPythonOutput(boxId, out);
}

function onPythonError(message) {
	const boxId = message && message.boxId ? String(message.boxId) : '';
	if (!boxId) {
		return;
	}
	setPythonOutput(boxId, String(message.error || 'Python execution failed.'));
}

function addUrlBox(options) {
	const id = (options && options.id) ? String(options.id) : ('url_' + Date.now());
	urlBoxes.push(id);
	// Default to expanded (view on) so the section shows content immediately once a URL is entered.
	urlStateByBoxId[id] = { url: '', expanded: true, loading: false, loaded: false, content: '', error: '', kind: '', contentType: '', status: null, dataUri: '', body: '', truncated: false };

	const container = document.getElementById('queries-container');
	if (!container) {
		return;
	}

	const closeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M4 4l8 8"/>' +
		'<path d="M12 4L4 12"/>' +
		'</svg>';

	const previewIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z" />' +
		'<circle cx="8" cy="8" r="2.1" />' +
		'</svg>';

	const boxHtml =
		'<div class="query-box url-box" id="' + id + '">' +
		'<div class="section-header-row url-section-header">' +
		'<input class="url-input" id="' + id + '_input" type="text" placeholder="https://example.com" oninput="onUrlChanged(\'' + id + '\')" />' +
		'<div class="section-actions">' +
		'<div class="md-tabs" role="tablist" aria-label="URL visibility">' +
		'<button class="md-tab" id="' + id + '_toggle" type="button" role="tab" aria-selected="false" onclick="toggleUrlBox(\'' + id + '\')" title="Show" aria-label="Show">' + previewIconSvg + '</button>' +
		'</div>' +
		'<button class="refresh-btn close-btn" type="button" onclick="removeUrlBox(\'' + id + '\')" title="Remove" aria-label="Remove">' + closeIconSvg + '</button>' +
		'</div>' +
		'</div>' +
		'<div class="url-output-wrapper" id="' + id + '_wrapper">' +
		'<div class="url-output" id="' + id + '_content" aria-label="URL content"></div>' +
		'<div class="query-editor-resizer" id="' + id + '_url_resizer" title="Drag to resize"></div>' +
		'</div>' +
		'</div>';

	container.insertAdjacentHTML('beforeend', boxHtml);
	try { __kustoUpdateUrlToggleButton(id); } catch { /* ignore */ }
	try { updateUrlContent(id); } catch { /* ignore */ }

	// Drag handle resize for URL output.
	try {
		const wrapper = document.getElementById(id + '_wrapper');
		const resizer = document.getElementById(id + '_url_resizer');
		if (wrapper && resizer) {
			resizer.addEventListener('mousedown', (e) => {
				try {
					e.preventDefault();
					e.stopPropagation();
				} catch {
					// ignore
				}
				try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }

				resizer.classList.add('is-dragging');
				const previousCursor = document.body.style.cursor;
				const previousUserSelect = document.body.style.userSelect;
				document.body.style.cursor = 'ns-resize';
				document.body.style.userSelect = 'none';

				const startY = e.clientY;
				const startHeight = wrapper.getBoundingClientRect().height;

				const onMove = (moveEvent) => {
					const delta = moveEvent.clientY - startY;
					const nextHeight = Math.max(120, Math.min(900, startHeight + delta));
					wrapper.style.height = nextHeight + 'px';
				};
				const onUp = () => {
					document.removeEventListener('mousemove', onMove, true);
					document.removeEventListener('mouseup', onUp, true);
					resizer.classList.remove('is-dragging');
					document.body.style.cursor = previousCursor;
					document.body.style.userSelect = previousUserSelect;
					try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
				};

				document.addEventListener('mousemove', onMove, true);
				document.addEventListener('mouseup', onUp, true);
			});
		}
	} catch {
		// ignore
	}

	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
	try {
		const controls = document.querySelector('.add-controls');
		if (controls && typeof controls.scrollIntoView === 'function') {
			controls.scrollIntoView({ block: 'end' });
		}
	} catch {
		// ignore
	}
	return id;
}

function removeUrlBox(boxId) {
	delete urlStateByBoxId[boxId];
	urlBoxes = urlBoxes.filter(id => id !== boxId);
	const box = document.getElementById(boxId);
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function onUrlChanged(boxId) {
	const input = document.getElementById(boxId + '_input');
	if (!input) {
		return;
	}
	const url = String(input.value || '').trim();
	if (!urlStateByBoxId[boxId]) {
		urlStateByBoxId[boxId] = { url: '', expanded: false, loading: false, loaded: false, content: '', error: '', kind: '', contentType: '', status: null, dataUri: '', body: '', truncated: false };
	}
	urlStateByBoxId[boxId].url = url;
	urlStateByBoxId[boxId].loaded = false;
	urlStateByBoxId[boxId].content = '';
	urlStateByBoxId[boxId].error = '';
	urlStateByBoxId[boxId].kind = '';
	urlStateByBoxId[boxId].contentType = '';
	urlStateByBoxId[boxId].status = null;
	urlStateByBoxId[boxId].dataUri = '';
	urlStateByBoxId[boxId].body = '';
	urlStateByBoxId[boxId].truncated = false;
	try { urlStateByBoxId[boxId].__hasFetchedOnce = false; } catch { /* ignore */ }
	try { urlStateByBoxId[boxId].__autoSizeImagePending = false; } catch { /* ignore */ }
	try { urlStateByBoxId[boxId].__autoSizedImageOnce = false; } catch { /* ignore */ }
	updateUrlContent(boxId);
	if (urlStateByBoxId[boxId].expanded && url) {
		requestUrlContent(boxId);
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function toggleUrlBox(boxId) {
	if (!urlStateByBoxId[boxId]) {
		urlStateByBoxId[boxId] = { url: '', expanded: true, loading: false, loaded: false, content: '', error: '', kind: '', contentType: '', status: null, dataUri: '', body: '', truncated: false };
	}
	urlStateByBoxId[boxId].expanded = !urlStateByBoxId[boxId].expanded;
	try { __kustoUpdateUrlToggleButton(boxId); } catch { /* ignore */ }
	updateUrlContent(boxId);
	if (urlStateByBoxId[boxId].expanded && urlStateByBoxId[boxId].url) {
		requestUrlContent(boxId);
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoClearElement(el) {
	try {
		while (el && el.firstChild) {
			el.removeChild(el.firstChild);
		}
	} catch {
		// ignore
	}
}

function __kustoParseCsv(text) {
	// Minimal CSV parser (RFC 4180-ish): supports quoted fields, commas, and newlines.
	const rows = [];
	let row = [];
	let field = '';
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (inQuotes) {
			if (ch === '"' && next === '"') {
				field += '"';
				i++;
				continue;
			}
			if (ch === '"') {
				inQuotes = false;
				continue;
			}
			field += ch;
			continue;
		}
		if (ch === '"') {
			inQuotes = true;
			continue;
		}
		if (ch === ',') {
			row.push(field);
			field = '';
			continue;
		}
		if (ch === '\r') {
			continue;
		}
		if (ch === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
			continue;
		}
		field += ch;
	}
	row.push(field);
	rows.push(row);
	return rows;
}

function __kustoRenderUrlContent(contentEl, st) {
	try {
		__kustoClearElement(contentEl);
		// Default for rich render.
		try { contentEl.style.whiteSpace = 'normal'; } catch { /* ignore */ }

		const kind = String(st.kind || '').toLowerCase();
		if (kind === 'image' && st.dataUri) {
			const img = document.createElement('img');
			// If this is the first fetch and the user hasn't resized, auto-size the wrapper to fit the image.
			const boxId = (() => {
				try {
					const id = contentEl && contentEl.id ? String(contentEl.id) : '';
					return id.endsWith('_content') ? id.slice(0, -('_content'.length)) : '';
				} catch {
					return '';
				}
			})();
			try {
				if (boxId && st.__autoSizeImagePending && !st.__autoSizedImageOnce) {
					img.addEventListener('load', () => {
						try {
							const wrapper = document.getElementById(boxId + '_wrapper');
							if (!wrapper) return;
							// Don't override user-sized or restored heights.
							try {
								if (wrapper.dataset && wrapper.dataset.kustoUserResized === 'true') {
									st.__autoSizeImagePending = false;
									st.__autoSizedImageOnce = true;
									return;
								}
							} catch { /* ignore */ }

							// Ensure layout is up to date before measuring.
							setTimeout(() => {
								try {
									const resizer = document.getElementById(boxId + '_url_resizer');
									const resizerH = resizer ? resizer.getBoundingClientRect().height : 12;
									const imgH = img.getBoundingClientRect().height;
									if (!imgH || !isFinite(imgH)) return;
									const minH = 120;
									const maxH = 3000;
									const nextH = Math.max(minH, Math.min(maxH, Math.ceil(imgH + resizerH)));
									wrapper.style.height = nextH + 'px';
									try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
									st.__autoSizeImagePending = false;
									st.__autoSizedImageOnce = true;
									try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
								} catch { /* ignore */ }
							}, 0);
						} catch { /* ignore */ }
					}, { once: true });
				}
			} catch {
				// ignore
			}

			img.src = String(st.dataUri);
			img.alt = 'Image';
			img.style.maxWidth = '100%';
			img.style.height = 'auto';
			img.style.display = 'block';
			contentEl.appendChild(img);
			return;
		}

		if (kind === 'csv' && typeof st.body === 'string') {
			const rows = __kustoParseCsv(st.body);
			const wrapper = document.createElement('div');
			// Important: don't create a nested scroller; let the URL section container scroll.
			wrapper.className = 'url-table-container';
			const table = document.createElement('table');
			const thead = document.createElement('thead');
			const tbody = document.createElement('tbody');

			const header = rows.length ? rows[0] : [];
			const headerRow = document.createElement('tr');
			for (const h of header) {
				const th = document.createElement('th');
				th.textContent = String(h ?? '');
				headerRow.appendChild(th);
			}
			thead.appendChild(headerRow);

			for (let i = 1; i < rows.length; i++) {
				const tr = document.createElement('tr');
				for (const cell of rows[i]) {
					const td = document.createElement('td');
					td.textContent = String(cell ?? '');
					tr.appendChild(td);
				}
				tbody.appendChild(tr);
			}

			table.appendChild(thead);
			table.appendChild(tbody);
			wrapper.appendChild(table);
			contentEl.appendChild(wrapper);
			return;
		}

		if (kind === 'html' && typeof st.body === 'string') {
			// Render the page in an iframe using srcdoc, sanitized via DOMPurify if available.
			let html = String(st.body);
			try {
				const base = st.url ? ('<base href="' + String(st.url).replace(/"/g, '&quot;') + '">') : '';
				html = base + html;
			} catch { /* ignore */ }
			try {
				if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
					html = window.DOMPurify.sanitize(html, {
						ADD_TAGS: ['base'],
						ADD_ATTR: ['href', 'target', 'rel']
					});
				}
			} catch {
				// ignore
			}
			const iframe = document.createElement('iframe');
			iframe.style.width = '100%';
			iframe.style.height = '300px';
			iframe.style.border = 'none';
			iframe.setAttribute('sandbox', '');
			iframe.setAttribute('referrerpolicy', 'no-referrer');
			iframe.srcdoc = html;
			contentEl.appendChild(iframe);
			return;
		}

		// Default: show as text.
		try { contentEl.style.whiteSpace = 'pre-wrap'; } catch { /* ignore */ }
		const pre = document.createElement('pre');
		pre.style.whiteSpace = 'pre-wrap';
		pre.style.margin = '0';
		pre.textContent = String(st.body || st.content || '');
		contentEl.appendChild(pre);
	} catch {
		// ignore
	}
}

function updateUrlContent(boxId) {
	const wrapperEl = document.getElementById(boxId + '_wrapper');
	const contentEl = document.getElementById(boxId + '_content');
	const st = urlStateByBoxId[boxId];
	if (!wrapperEl || !contentEl || !st) {
		return;
	}
	wrapperEl.classList.toggle('url-collapsed', !st.expanded);
	if (!st.expanded) {
		return;
	}
	if (st.loading) {
		try { contentEl.style.whiteSpace = 'pre-wrap'; } catch { /* ignore */ }
		contentEl.textContent = 'Loading…';
		return;
	}
	if (st.error) {
		try { contentEl.style.whiteSpace = 'pre-wrap'; } catch { /* ignore */ }
		contentEl.textContent = st.error;
		return;
	}
	if (st.loaded) {
		__kustoRenderUrlContent(contentEl, st);
		return;
	}
	try { contentEl.style.whiteSpace = 'pre-wrap'; } catch { /* ignore */ }
	contentEl.textContent = st.url ? 'Ready to load.' : 'Enter a URL above.';
}

function requestUrlContent(boxId) {
	const st = urlStateByBoxId[boxId];
	if (!st || st.loading || st.loaded) {
		return;
	}
	const url = String(st.url || '').trim();
	if (!url) {
		return;
	}
	st.loading = true;
	st.error = '';
	updateUrlContent(boxId);
	try {
		vscode.postMessage({ type: 'fetchUrl', boxId, url });
	} catch {
		st.loading = false;
		st.error = 'Failed to request URL.';
		updateUrlContent(boxId);
	}
}

function onUrlContent(message) {
	const boxId = message && message.boxId ? String(message.boxId) : '';
	if (!boxId || !urlStateByBoxId[boxId]) {
		return;
	}
	const st = urlStateByBoxId[boxId];
	st.loading = false;
	st.loaded = true;
	st.error = '';
	st.url = String(message.url || st.url || '');
	st.contentType = String(message.contentType || st.contentType || '');
	st.status = (typeof message.status === 'number') ? message.status : (st.status ?? null);
	st.kind = String(message.kind || '').toLowerCase();
	st.truncated = !!message.truncated;
	st.dataUri = String(message.dataUri || '');
	st.body = (typeof message.body === 'string') ? message.body : '';
	// Track first successful fetch; used for one-time auto-sizing of images.
	try {
		if (!st.__hasFetchedOnce) {
			st.__hasFetchedOnce = true;
			if (st.kind === 'image') {
				st.__autoSizeImagePending = true;
			}
		}
	} catch { /* ignore */ }
	// Keep a simple fallback string for older rendering.
	st.content = st.body || '';
	updateUrlContent(boxId);
}

function onUrlError(message) {
	const boxId = message && message.boxId ? String(message.boxId) : '';
	if (!boxId || !urlStateByBoxId[boxId]) {
		return;
	}
	const st = urlStateByBoxId[boxId];
	st.loading = false;
	st.loaded = false;
	st.content = '';
	st.error = String(message.error || 'Failed to load URL.');
	updateUrlContent(boxId);
}
