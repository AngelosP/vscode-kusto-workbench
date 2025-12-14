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
let urlStateByBoxId = {}; // { url, expanded, loading, loaded, content, error }

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

function addMarkdownBox() {
	const id = 'markdown_' + Date.now();
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

	const boxHtml =
		'<div class="query-box" id="' + id + '">' +
		'<div class="section-header-row md-section-header">' +
		'<div class="md-tabs" role="tablist" aria-label="Markdown mode">' +
		'<button class="md-tab is-active" id="' + id + '_tab_edit" type="button" role="tab" aria-selected="true" onclick="setMarkdownTab(\'' + id + '\', \'edit\')">Edit</button>' +
		'<button class="md-tab" id="' + id + '_tab_preview" type="button" role="tab" aria-selected="false" onclick="setMarkdownTab(\'' + id + '\', \'preview\')">Preview</button>' +
		'</div>' +
		'<div class="md-header-center">' +
		'<div class="section-title-edit">' +
		'<input class="section-title-input" id="' + id + '_md_title" type="text" value="Markdown" size="8" oninput="onMarkdownTitleInput(\'' + id + '\')" aria-label="Section title" />' +
		'<button class="section-title-pen" type="button" onclick="focusMarkdownTitle(\'' + id + '\')" title="Rename" aria-label="Rename">' + editIconSvg + '</button>' +
		'</div>' +
		'</div>' +
		'<div class="section-actions">' +
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
	try {
		const controls = document.querySelector('.add-controls');
		if (controls && typeof controls.scrollIntoView === 'function') {
			controls.scrollIntoView({ block: 'end' });
		}
	} catch {
		// ignore
	}
}

function removeMarkdownBox(boxId) {
	if (markdownEditors[boxId]) {
		try { markdownEditors[boxId].dispose(); } catch { /* ignore */ }
		delete markdownEditors[boxId];
	}
	delete markdownRenderCacheByBoxId[boxId];
	delete markdownTabByBoxId[boxId];
	markdownBoxes = markdownBoxes.filter(id => id !== boxId);
	const box = document.getElementById(boxId);
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
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

	if (next === 'preview') {
		try {
			const editor = markdownEditors[boxId];
			const markdown = editor && editor.getModel ? (editor.getModel() ? editor.getModel().getValue() : '') : '';
			renderMarkdownIntoViewer(boxId, markdown);
		} catch {
			// ignore
		}
		editorEl.style.display = 'none';
		viewerEl.style.display = '';
		return;
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
}

function initMarkdownEditor(boxId) {
	return ensureMonaco().then(monaco => {
		const container = document.getElementById(boxId + '_md_editor');
		const viewer = document.getElementById(boxId + '_md_viewer');
		if (!container || !viewer) {
			return;
		}

		container.style.minHeight = '0';
		container.style.minWidth = '0';

		const editor = monaco.editor.create(container, {
			value: '',
			language: 'markdown',
			readOnly: false,
			automaticLayout: true,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			fontFamily: getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family'),
			fontSize: 13,
			lineNumbers: 'on',
			renderLineHighlight: 'none'
		});

		markdownEditors[boxId] = editor;

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
		if (typeof marked !== 'undefined' && marked && typeof marked.parse === 'function' && typeof DOMPurify !== 'undefined') {
			const html = marked.parse(text, {
				mangle: false,
				headerIds: false
			});
			const sanitized = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
			viewer.innerHTML = sanitized;
			markdownRenderCacheByBoxId[boxId] = sanitized;
			return;
		}
	} catch {
		// ignore
	}
	viewer.textContent = text;
	markdownRenderCacheByBoxId[boxId] = '';
}

function addPythonBox() {
	const id = 'python_' + Date.now();
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
	try {
		const controls = document.querySelector('.add-controls');
		if (controls && typeof controls.scrollIntoView === 'function') {
			controls.scrollIntoView({ block: 'end' });
		}
	} catch {
		// ignore
	}
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
}

function initPythonEditor(boxId) {
	return ensureMonaco().then(monaco => {
		const container = document.getElementById(boxId + '_py_editor');
		if (!container) {
			return;
		}

		container.style.minHeight = '0';
		container.style.minWidth = '0';

		const editor = monaco.editor.create(container, {
			value: '',
			language: 'python',
			readOnly: false,
			automaticLayout: true,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			fontFamily: getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family'),
			fontSize: 13,
			lineNumbers: 'on',
			renderLineHighlight: 'none'
		});

		pythonEditors[boxId] = editor;

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
					};

					document.addEventListener('mousemove', onMove, true);
					document.addEventListener('mouseup', onUp, true);
				});
			}
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

function addUrlBox() {
	const id = 'url_' + Date.now();
	urlBoxes.push(id);
	urlStateByBoxId[id] = { url: '', expanded: false, loading: false, loaded: false, content: '', error: '' };

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
		'<div class="section-title">URL</div>' +
		'<div class="section-actions">' +
		'<button class="section-btn" type="button" id="' + id + '_toggle" onclick="toggleUrlBox(\'' + id + '\')" title="Expand/collapse">Show</button>' +
		'<button class="section-btn" type="button" onclick="removeUrlBox(\'' + id + '\')" title="Remove" aria-label="Remove">' + closeIconSvg + '</button>' +
		'</div>' +
		'</div>' +
		'<div class="url-row">' +
		'<input class="url-input" id="' + id + '_input" type="text" placeholder="https://example.com" oninput="onUrlChanged(\'' + id + '\')" />' +
		'</div>' +
		'<div class="url-output url-collapsed" id="' + id + '_content" aria-label="URL content"></div>' +
		'</div>';

	container.insertAdjacentHTML('beforeend', boxHtml);
	try {
		const controls = document.querySelector('.add-controls');
		if (controls && typeof controls.scrollIntoView === 'function') {
			controls.scrollIntoView({ block: 'end' });
		}
	} catch {
		// ignore
	}
}

function removeUrlBox(boxId) {
	delete urlStateByBoxId[boxId];
	urlBoxes = urlBoxes.filter(id => id !== boxId);
	const box = document.getElementById(boxId);
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
}

function onUrlChanged(boxId) {
	const input = document.getElementById(boxId + '_input');
	if (!input) {
		return;
	}
	const url = String(input.value || '').trim();
	if (!urlStateByBoxId[boxId]) {
		urlStateByBoxId[boxId] = { url: '', expanded: false, loading: false, loaded: false, content: '', error: '' };
	}
	urlStateByBoxId[boxId].url = url;
	urlStateByBoxId[boxId].loaded = false;
	urlStateByBoxId[boxId].content = '';
	urlStateByBoxId[boxId].error = '';
	updateUrlContent(boxId);
	if (urlStateByBoxId[boxId].expanded && url) {
		requestUrlContent(boxId);
	}
}

function toggleUrlBox(boxId) {
	if (!urlStateByBoxId[boxId]) {
		urlStateByBoxId[boxId] = { url: '', expanded: false, loading: false, loaded: false, content: '', error: '' };
	}
	urlStateByBoxId[boxId].expanded = !urlStateByBoxId[boxId].expanded;
	const btn = document.getElementById(boxId + '_toggle');
	if (btn) {
		btn.textContent = urlStateByBoxId[boxId].expanded ? 'Hide' : 'Show';
	}
	updateUrlContent(boxId);
	if (urlStateByBoxId[boxId].expanded && urlStateByBoxId[boxId].url) {
		requestUrlContent(boxId);
	}
}

function updateUrlContent(boxId) {
	const contentEl = document.getElementById(boxId + '_content');
	const st = urlStateByBoxId[boxId];
	if (!contentEl || !st) {
		return;
	}
	contentEl.classList.toggle('url-collapsed', !st.expanded);
	if (!st.expanded) {
		return;
	}
	if (st.loading) {
		contentEl.textContent = 'Loading…';
		return;
	}
	if (st.error) {
		contentEl.textContent = st.error;
		return;
	}
	if (st.loaded) {
		contentEl.textContent = st.content || '';
		return;
	}
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
	const url = String(message.url || st.url || '');
	const contentType = String(message.contentType || '');
	let body = String(message.body || '');
	const truncated = !!message.truncated;
	const status = (typeof message.status === 'number') ? message.status : null;

	// If this looks like HTML, present a readable text extraction.
	try {
		if (contentType.toLowerCase().includes('text/html') && typeof DOMParser !== 'undefined') {
			const doc = new DOMParser().parseFromString(body, 'text/html');
			const extracted = (doc && doc.body && (doc.body.innerText || doc.body.textContent))
				? String(doc.body.innerText || doc.body.textContent)
				: (doc && doc.documentElement && doc.documentElement.textContent ? String(doc.documentElement.textContent) : '');
			if (extracted && extracted.trim()) {
				body = extracted;
			}
		}
	} catch {
		// ignore
	}

	let header = '';
	if (url) {
		header += url;
	}
	if (typeof status === 'number') {
		header += (header ? '\n' : '') + 'Status: ' + status;
	}
	if (contentType) {
		header += (header ? '\n' : '') + 'Content-Type: ' + contentType;
	}
	if (header) {
		header += '\n\n';
	}
	st.content = header + body + (truncated ? '\n\n[Truncated]' : '');
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
