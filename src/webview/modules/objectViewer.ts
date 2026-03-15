// Object Viewer module — converted from legacy/objectViewer.js
// Window bridge exports at bottom for remaining inline onclick callers.
export {};

declare const escapeHtml: (s: string) => string;
declare const escapeRegex: (s: string) => string;

const _win = window;

function openObjectViewer(row: number, col: number, boxId: string): void {
	const currentResult = _win.currentResult as any;
	if (!currentResult || currentResult.boxId !== boxId) { return; }

	const cellData = currentResult.rows[row][col];
	if (!cellData || !cellData.isObject) { return; }

	const columnName = __kustoGetObjectViewerColumnName(col);

	const modal = document.getElementById('objectViewer');
	try { __kustoEnsureObjectViewerSearchControl(); } catch { /* ignore */ }
	const searchInput = document.getElementById('objectViewerSearch') as HTMLInputElement | null;
	const searchMode = document.getElementById('objectViewerSearchMode') as HTMLElement | null;
	const titleEl = document.getElementById('objectViewerTitle');

	// Header title: Object viewer for <column> (column bold)
	try {
		if (titleEl) {
			titleEl.textContent = '';
			titleEl.appendChild(document.createTextNode('Object viewer for '));
			const strong = document.createElement('strong');
			strong.textContent = columnName;
			titleEl.appendChild(strong);
		}
	} catch {
		// ignore
	}

	// Initialize the raw show/hide button glyph.
	try { __kustoEnsureObjectViewerRawToggleIcon(); } catch { /* ignore */ }
	try { __kustoEnsureObjectViewerRawCopyIcon(); } catch { /* ignore */ }
	try {
		_win.__kustoObjectViewerRawVisible = true;
		const rawBody = document.getElementById('objectViewerRawBody');
		if (rawBody) { rawBody.style.display = ''; }
		const rawToggle = document.getElementById('objectViewerRawToggle');
		if (rawToggle) { rawToggle.classList.add('is-active'); }
	} catch { /* ignore */ }

	// Initialize navigation state and render.
	const rootValue = __kustoParseMaybeJson(cellData.full);
	_win.__kustoObjectViewerState = {
		columnName: columnName,
		stack: [{ label: columnName, value: rootValue }]
	};
	__kustoRenderObjectViewer();

	if (modal) modal.classList.add('visible');

	// Check if there's an active data search and if this cell is a search match
	const dataSearchInput = document.getElementById(boxId + '_data_search') as HTMLInputElement | null;
	const dataSearchMode = document.getElementById(boxId + '_data_search_mode') as HTMLElement | null;
	const dataSearchTerm = dataSearchInput ? dataSearchInput.value : '';

	if (dataSearchTerm && currentResult.searchMatches &&
		currentResult.searchMatches.some((m: any) => m.row === row && m.col === col)) {
		// Automatically search for the same term in the object viewer
		if (searchInput) searchInput.value = dataSearchTerm;
		try {
			const dataModeVal = dataSearchMode ? ((dataSearchMode as any).dataset.mode || (dataSearchMode as any).value) : null;
			if (searchMode && dataModeVal) {
				(searchMode as any).dataset.mode = String(dataModeVal);
				if (typeof (_win.__kustoUpdateSearchModeToggle) === 'function') (_win.__kustoUpdateSearchModeToggle as any)(searchMode, dataModeVal);
			}
		} catch { /* ignore */ }
		searchInObjectViewer();
	} else {
		// Clear search
		if (searchInput) searchInput.value = '';
		try {
			if (searchMode) {
				(searchMode as any).dataset.mode = 'wildcard';
				if (typeof (_win.__kustoUpdateSearchModeToggle) === 'function') (_win.__kustoUpdateSearchModeToggle as any)(searchMode, 'wildcard');
			}
		} catch { /* ignore */ }
		const resultsSpan = document.getElementById('objectViewerSearchResults');
		if (resultsSpan) resultsSpan.textContent = '';
	}
}

function __kustoEnsureObjectViewerSearchControl(): void {
	try {
		if (document.getElementById('objectViewerSearch')) return;
		const host = document.getElementById('objectViewerSearchHost');
		if (!host) return;
		if (typeof (_win.__kustoCreateSearchControl) !== 'function') return;

		(_win.__kustoCreateSearchControl as any)(host, {
			inputId: 'objectViewerSearch',
			modeId: 'objectViewerSearchMode',
			ariaLabel: 'Search',
			onInput: function () { searchInObjectViewer(); }
		});
	} catch { /* ignore */ }
}

function copyObjectViewerRawToClipboard(): void {
	const rawBody = document.getElementById('objectViewerRawBody');
	const rawEl = document.getElementById('objectViewerContent');
	if (!rawBody || !rawEl) { return; }

	let textToCopy = '';
	try {
		const sel = window.getSelection && window.getSelection();
		const hasSelection = sel && !sel.isCollapsed && typeof sel.toString === 'function' && sel.toString();
		const inRaw = sel && sel.anchorNode && sel.focusNode && rawBody.contains(sel.anchorNode) && rawBody.contains(sel.focusNode);
		if (hasSelection && inRaw) {
			textToCopy = sel!.toString();
		}
	} catch { /* ignore */ }

	if (!textToCopy) {
		try {
			const data = _win.currentObjectViewerData as any;
			textToCopy = String(data && data.raw ? data.raw : '');
		} catch {
			textToCopy = '';
		}
	}

	if (typeof (_win.__kustoWriteTextToClipboard) === 'function') {
		(_win.__kustoWriteTextToClipboard as any)(textToCopy);
	}
}

function closeObjectViewer(event?: Event): void {
	if (event && event.target !== event.currentTarget && !(event.currentTarget as HTMLElement).classList.contains('object-viewer-close')) {
		return;
	}

	const modal = document.getElementById('objectViewer');
	if (modal) modal.classList.remove('visible');
	_win.currentObjectViewerData = null;
	try { _win.__kustoObjectViewerState = null; } catch { /* ignore */ }
}

function toggleObjectViewerRaw(): void {
	const body = document.getElementById('objectViewerRawBody');
	const btn = document.getElementById('objectViewerRawToggle');
	if (!body || !btn) { return; }
	const visible = body.style.display !== 'none';
	const next = !visible;
	try { body.style.display = next ? '' : 'none'; } catch { /* ignore */ }
	try { btn.classList.toggle('is-active', next); } catch { /* ignore */ }
	try {
		btn.title = next ? 'Hide raw value' : 'Show raw value';
		btn.setAttribute('aria-label', btn.title);
	} catch { /* ignore */ }
	try { _win.__kustoObjectViewerRawVisible = next; } catch { /* ignore */ }
}

function objectViewerNavigateBack(): void {
	const st = _win.__kustoObjectViewerState as any;
	if (!st || !Array.isArray(st.stack) || st.stack.length <= 1) { return; }
	st.stack.pop();
	__kustoRenderObjectViewer();
}

function objectViewerNavigateToDepth(depth: number): void {
	const st = _win.__kustoObjectViewerState as any;
	if (!st || !Array.isArray(st.stack)) { return; }
	const d = parseInt(String(depth), 10);
	if (!isFinite(d) || d < 1 || d > st.stack.length) { return; }
	if (d === st.stack.length) { return; }
	st.stack = st.stack.slice(0, d);
	__kustoRenderObjectViewer();
}

function objectViewerNavigateInto(key: string): void {
	const st = _win.__kustoObjectViewerState as any;
	if (!st || !Array.isArray(st.stack) || st.stack.length < 1) { return; }
	const frame = st.stack[st.stack.length - 1];
	if (!frame) { return; }
	const v = frame.value;
	if (v === null || v === undefined) { return; }
	try {
		const nextValue = v[key];
		st.stack.push({ label: String(key), value: __kustoParseMaybeJson(nextValue) });
		__kustoRenderObjectViewer();
	} catch {
		// ignore
	}
}

function __kustoGetObjectViewerColumnName(colIndex: number): string {
	try {
		const currentResult = _win.currentResult as any;
		const cols = (currentResult && Array.isArray(currentResult.columns)) ? currentResult.columns : [];
		const col = cols[colIndex];
		if (typeof col === 'string') return col;
		if (col && typeof col === 'object') {
			if (typeof col.name === 'string' && col.name) return col.name;
			if (typeof col.columnName === 'string' && col.columnName) return col.columnName;
			if (typeof col.displayName === 'string' && col.displayName) return col.displayName;
		}
	} catch {
		// ignore
	}
	return 'column ' + (colIndex + 1);
}

function __kustoParseMaybeJson(value: unknown): unknown {
	if (typeof value !== 'string') {
		return value;
	}
	const s = (value as string).trim();
	if (!s) {
		return value;
	}
	// Only attempt JSON.parse when the string looks like JSON.
	if (!(s.startsWith('{') || s.startsWith('[') || s === 'null' || s === 'true' || s === 'false' || /^-?\d/.test(s) || s.startsWith('"'))) {
		return value;
	}
	try {
		return JSON.parse(value as string);
	} catch {
		return value;
	}
}

function __kustoStringifyForSearch(value: unknown): string {
	try {
		if (value === null || value === undefined) return '';
		if (typeof value === 'string') return value;
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function __kustoFormatScalarForTable(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function __kustoIsComplexValue(value: unknown): boolean {
	if (value === null || value === undefined) return false;
	if (typeof value === 'string') {
		const s = (value as string).trim();
		return s.startsWith('{') || s.startsWith('[');
	}
	return typeof value === 'object';
}

function __kustoEnsureObjectViewerRawToggleIcon(): void {
	const btn = document.getElementById('objectViewerRawToggle') as any;
	if (!btn) { return; }
	if (btn.__kustoHasIcon) { return; }
	btn.__kustoHasIcon = true;
	const fallbackIcon = () => (
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z" />' +
		'<circle cx="8" cy="8" r="2.1" />' +
		'</svg>'
	);
	try {
		if (typeof (_win.__kustoGetResultsVisibilityIconSvg) === 'function') {
			btn.innerHTML = (_win.__kustoGetResultsVisibilityIconSvg as any)();
		} else {
			btn.innerHTML = fallbackIcon();
		}
	} catch {
		try {
			btn.innerHTML = fallbackIcon();
		} catch {
			// ignore
		}
	}
}

function __kustoEnsureObjectViewerRawCopyIcon(): void {
	const btn = document.getElementById('objectViewerRawCopy') as any;
	if (!btn) { return; }
	if (btn.__kustoHasIcon) { return; }
	btn.__kustoHasIcon = true;
	try {
		btn.innerHTML = __kustoGetCopyIconSvg(16);
	} catch {
		btn.textContent = 'Copy';
	}
}

function __kustoGetCopyIconSvg(size?: number): string {
	const s = (typeof size === 'number' && isFinite(size) && size > 0) ? Math.floor(size) : 16;
	return (
		'<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<rect x="5" y="5" width="9" height="9" rx="2" />' +
		'<path d="M3 11V4c0-1.1.9-2 2-2h7" />' +
		'</svg>'
	);
}

function __kustoWriteTextToClipboard(text: unknown): void {
	const value = (text === null || text === undefined) ? '' : String(text);
	try {
		if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
			navigator.clipboard.writeText(value);
			return;
		}
	} catch { /* ignore */ }
	try {
		const ta = document.createElement('textarea');
		ta.value = value;
		ta.setAttribute('readonly', '');
		ta.style.position = 'fixed';
		ta.style.left = '-1000px';
		ta.style.top = '-1000px';
		document.body.appendChild(ta);
		ta.select();
		document.execCommand('copy');
		document.body.removeChild(ta);
	} catch { /* ignore */ }
}

function __kustoRenderObjectViewer(): void {
	const st = _win.__kustoObjectViewerState as any;
	if (!st || !Array.isArray(st.stack) || st.stack.length < 1) { return; }
	const frame = st.stack[st.stack.length - 1];
	const depth = st.stack.length;

	const propsTitle = document.getElementById('objectViewerPropsTitle');
	const backBtn = document.getElementById('objectViewerBackBtn');
	const table = document.getElementById('objectViewerPropsTable');
	const content = document.getElementById('objectViewerContent');

	try {
		if (backBtn) {
			backBtn.style.display = depth > 1 ? '' : 'none';
		}
	} catch { /* ignore */ }
	try {
		if (propsTitle) {
			propsTitle.textContent = '';
			for (let i = 0; i < st.stack.length; i++) {
				const crumb = document.createElement('button');
				crumb.type = 'button';
				crumb.className = 'object-viewer-crumb';
				crumb.textContent = String(st.stack[i] && st.stack[i].label ? st.stack[i].label : '');
				const isCurrent = i === (st.stack.length - 1);
				crumb.disabled = isCurrent;
				if (!isCurrent) {
					const capturedI = i;
					crumb.addEventListener('click', (e: Event) => {
						try { e.stopPropagation(); } catch { /* ignore */ }
						objectViewerNavigateToDepth(capturedI + 1);
					});
				}
				propsTitle.appendChild(crumb);
				if (i < st.stack.length - 1) {
					const sep = document.createElement('span');
					sep.className = 'object-viewer-crumb-sep';
					sep.textContent = '>';
					propsTitle.appendChild(sep);
				}
			}
		}
	} catch { /* ignore */ }

	// Update Raw value content + search backing data.
	try {
		_win.currentObjectViewerData = {
			raw: __kustoStringifyForSearch(frame.value),
			formatted: formatJson(frame.value)
		};
	} catch {
		_win.currentObjectViewerData = {
			raw: String(frame.value || ''),
			formatted: formatJson(frame.value)
		};
	}
	try {
		if (content) {
			content.innerHTML = (_win.currentObjectViewerData as any).formatted;
		}
	} catch { /* ignore */ }

	// If user already typed a search term, keep highlighting in sync.
	try {
		const input = document.getElementById('objectViewerSearch') as HTMLInputElement | null;
		if (input && String(input.value || '').trim()) {
			searchInObjectViewer();
		}
	} catch { /* ignore */ }

	// Render the properties table.
	if (!table) { return; }
	try { table.textContent = ''; } catch { /* ignore */ }
	const tbody = document.createElement('tbody');
	const v = frame.value;

	if (v && typeof v === 'object') {
		const keys = Array.isArray(v) ? v.map((_: unknown, i: number) => String(i)) : Object.keys(v as Record<string, unknown>);
		for (const key of keys) {
			const tr = document.createElement('tr');
			const tdKey = document.createElement('td');
			const keyCell = document.createElement('div');
			keyCell.className = 'object-viewer-prop-key-cell';
			const keyText = document.createElement('span');
			keyText.className = 'object-viewer-prop-key-text';
			keyText.textContent = String(key);
			keyCell.appendChild(keyText);
			const tdVal = document.createElement('td');
			let nextValue: unknown;
			try { nextValue = (v as any)[key]; } catch { nextValue = undefined; }

			const parsedNext = __kustoParseMaybeJson(nextValue);
			try {
				(tr as any).dataset.kustoKeyText = String(key);
				(tr as any).dataset.kustoValueText = __kustoStringifyForSearch(parsedNext);
			} catch { /* ignore */ }

			// Copy value icon (hover on row). Copies the property's raw value.
			const copyBtn = document.createElement('button');
			copyBtn.type = 'button';
			copyBtn.className = 'refresh-btn close-btn object-viewer-prop-copy-btn';
			copyBtn.title = 'Copy value to clipboard';
			copyBtn.setAttribute('aria-label', 'Copy value to clipboard');
			try { copyBtn.innerHTML = __kustoGetCopyIconSvg(14); } catch { copyBtn.textContent = 'Copy'; }
			const capturedParsedNext = parsedNext;
			copyBtn.addEventListener('click', (e: Event) => {
				try { e.stopPropagation(); } catch { /* ignore */ }
				__kustoWriteTextToClipboard(__kustoStringifyForSearch(capturedParsedNext));
			});
			keyCell.appendChild(copyBtn);
			tdKey.appendChild(keyCell);
			if (__kustoIsComplexValue(parsedNext)) {
				const btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'object-view-btn';
				btn.textContent = 'View';
				const capturedKey = key;
				btn.addEventListener('click', (e: Event) => {
					try { e.stopPropagation(); } catch { /* ignore */ }
					objectViewerNavigateInto(capturedKey);
				});
				tdVal.appendChild(btn);
			} else {
				tdVal.textContent = __kustoFormatScalarForTable(parsedNext);
			}

			tr.appendChild(tdKey);
			tr.appendChild(tdVal);
			tbody.appendChild(tr);
		}
	} else {
		const tr = document.createElement('tr');
		const tdKey = document.createElement('td');
		tdKey.textContent = '(value)';
		const tdVal = document.createElement('td');
		tdVal.textContent = __kustoFormatScalarForTable(v);
		tr.appendChild(tdKey);
		tr.appendChild(tdVal);
		tbody.appendChild(tr);
	}

	try { table.appendChild(tbody); } catch { /* ignore */ }
	try { __kustoApplyObjectViewerTableSearchHighlight(); } catch { /* ignore */ }
}

function __kustoApplyObjectViewerTableSearchHighlight(): void {
	const table = document.getElementById('objectViewerPropsTable');
	if (!table) { return; }
	let query = '';
	let built: any = { regex: null, error: null };
	try {
		if (typeof (_win.__kustoGetSearchControlState) === 'function' && typeof (_win.__kustoTryBuildSearchRegex) === 'function') {
			const st = (_win.__kustoGetSearchControlState as any)('objectViewerSearch', 'objectViewerSearchMode');
			query = String((st && st.query) ? st.query : '');
			const mode = st && st.mode ? st.mode : 'wildcard';
			built = (_win.__kustoTryBuildSearchRegex as any)(query, mode);
		} else {
			const input = document.getElementById('objectViewerSearch') as HTMLInputElement | null;
			query = input ? String(input.value || '').trim() : '';
			built = { regex: query ? new RegExp(escapeRegex(query), 'gi') : null, error: null };
		}
	} catch { /* ignore */ }
	const regex = built && built.regex ? built.regex : null;
	const rows = table.querySelectorAll('tr');
	rows.forEach((tr) => {
		try {
			const keyText = (tr as any).dataset ? String((tr as any).dataset.kustoKeyText || '') : '';
			const valueText = (tr as any).dataset ? String((tr as any).dataset.kustoValueText || '') : '';
			const hit = !!query && !built.error && regex && (typeof (_win.__kustoRegexTest) === 'function'
				? ((_win.__kustoRegexTest as any)(regex, keyText) || (_win.__kustoRegexTest as any)(regex, valueText))
				: (keyText.toLowerCase().includes(query.toLowerCase()) || valueText.toLowerCase().includes(query.toLowerCase())));
			tr.classList.toggle('search-match', hit);
		} catch { /* ignore */ }
	});
}

function formatJson(jsonString: unknown): string {
	try {
		const obj = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;
		return syntaxHighlightJson(obj);
	} catch {
		return '<span class="json-string">' + escapeHtml(String(jsonString)) + '</span>';
	}
}

function syntaxHighlightJson(obj: unknown, indent = 0): string {
	const indentStr = '  '.repeat(indent);
	const nextIndent = '  '.repeat(indent + 1);

	if (obj === null) {
		return '<span class="json-null">null</span>';
	}

	if (typeof obj === 'string') {
		return '<span class="json-string">"' + escapeHtml(obj) + '"</span>';
	}

	if (typeof obj === 'number') {
		return '<span class="json-number">' + obj + '</span>';
	}

	if (typeof obj === 'boolean') {
		return '<span class="json-boolean">' + obj + '</span>';
	}

	if (Array.isArray(obj)) {
		if (obj.length === 0) {
			return '[]';
		}

		let result = '[\n';
		obj.forEach((item, index) => {
			result += nextIndent + syntaxHighlightJson(item, indent + 1);
			if (index < obj.length - 1) {
				result += ',';
			}
			result += '\n';
		});
		result += indentStr + ']';
		return result;
	}

	if (typeof obj === 'object') {
		const keys = Object.keys(obj as Record<string, unknown>);
		if (keys.length === 0) {
			return '{}';
		}

		let result = '{\n';
		keys.forEach((key, index) => {
			result += nextIndent + '<span class="json-key">"' + escapeHtml(key) + '"</span>: ';
			result += syntaxHighlightJson((obj as Record<string, unknown>)[key], indent + 1);
			if (index < keys.length - 1) {
				result += ',';
			}
			result += '\n';
		});
		result += indentStr + '}';
		return result;
	}

	return String(obj);
}

function searchInObjectViewer(): void {
	const currentData = _win.currentObjectViewerData as any;
	if (!currentData) { return; }

	try { __kustoEnsureObjectViewerSearchControl(); } catch { /* ignore */ }
	const content = document.getElementById('objectViewerContent');
	const resultsSpan = document.getElementById('objectViewerSearchResults');
	if (!content || !resultsSpan) return;

	let query = '';
	let built: any = { regex: null, error: null };
	try {
		if (typeof (_win.__kustoGetSearchControlState) === 'function' && typeof (_win.__kustoTryBuildSearchRegex) === 'function') {
			const st = (_win.__kustoGetSearchControlState as any)('objectViewerSearch', 'objectViewerSearchMode');
			query = String((st && st.query) ? st.query : '');
			const mode = st && st.mode ? st.mode : 'wildcard';
			built = (_win.__kustoTryBuildSearchRegex as any)(query, mode);
		} else {
			const input = document.getElementById('objectViewerSearch') as HTMLInputElement | null;
			query = input ? String(input.value || '').trim() : '';
			built = { regex: query ? new RegExp(escapeRegex(query), 'gi') : null, error: null };
		}
	} catch { /* ignore */ }

	if (!String(query || '').trim()) {
		content.innerHTML = currentData.formatted;
		resultsSpan.textContent = '';
		try { __kustoApplyObjectViewerTableSearchHighlight(); } catch { /* ignore */ }
		return;
	}

	if (built && built.error) {
		content.innerHTML = currentData.formatted;
		resultsSpan.textContent = String(built.error);
		try { __kustoApplyObjectViewerTableSearchHighlight(); } catch { /* ignore */ }
		return;
	}

	const regex = built && built.regex ? built.regex : null;
	const rawJson = String(currentData.raw || '');
	const matches = (regex && typeof (_win.__kustoCountRegexMatches) === 'function') ? (_win.__kustoCountRegexMatches as any)(regex, rawJson, 5000) : 0;

	content.innerHTML = currentData.formatted;
	try {
		if (regex && typeof (_win.__kustoHighlightElementTextNodes) === 'function') {
			(_win.__kustoHighlightElementTextNodes as any)(content, regex, 'json-highlight');
		}
	} catch { /* ignore */ }

	resultsSpan.textContent = matches > 0 ? (matches + ' match' + (matches !== 1 ? 'es' : '')) : 'No matches';
	try { __kustoApplyObjectViewerTableSearchHighlight(); } catch { /* ignore */ }
}

function highlightSearchTerm(html: string, searchTerm: string): string {
	// Create a temporary div to work with the HTML
	const tempDiv = document.createElement('div');
	tempDiv.innerHTML = html;

	// Function to highlight text in text nodes
	function highlightInNode(node: Node): void {
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node.textContent || '';
			const lowerText = text.toLowerCase();
			const lowerSearch = searchTerm.toLowerCase();

			if (lowerText.includes(lowerSearch)) {
				const parts: Node[] = [];
				let lastIndex = 0;
				let index = lowerText.indexOf(lowerSearch);

				while (index !== -1) {
					// Add text before match
					if (index > lastIndex) {
						parts.push(document.createTextNode(text.substring(lastIndex, index)));
					}

					// Add highlighted match
					const span = document.createElement('span');
					span.className = 'json-highlight';
					span.textContent = text.substring(index, index + searchTerm.length);
					parts.push(span);

					lastIndex = index + searchTerm.length;
					index = lowerText.indexOf(lowerSearch, lastIndex);
				}

				// Add remaining text
				if (lastIndex < text.length) {
					parts.push(document.createTextNode(text.substring(lastIndex)));
				}

				// Replace the text node with highlighted parts
				const parent = node.parentNode;
				if (parent) {
					parts.forEach(part => parent.insertBefore(part, node));
					parent.removeChild(node);
				}
			}
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			// Recursively process child nodes
			Array.from(node.childNodes).forEach(child => highlightInNode(child));
		}
	}

	highlightInNode(tempDiv);
	return tempDiv.innerHTML;
}

// ======================================================================
// Window bridge: expose globals for remaining legacy callers / onclick
// ======================================================================
_win.openObjectViewer = openObjectViewer;
_win.closeObjectViewer = closeObjectViewer;
_win.copyObjectViewerRawToClipboard = copyObjectViewerRawToClipboard;
_win.toggleObjectViewerRaw = toggleObjectViewerRaw;
_win.objectViewerNavigateBack = objectViewerNavigateBack;
_win.objectViewerNavigateToDepth = objectViewerNavigateToDepth;
_win.objectViewerNavigateInto = objectViewerNavigateInto;
_win.searchInObjectViewer = searchInObjectViewer;
_win.formatJson = formatJson;
_win.syntaxHighlightJson = syntaxHighlightJson;
_win.highlightSearchTerm = highlightSearchTerm;
_win.__kustoGetCopyIconSvg = __kustoGetCopyIconSvg;
_win.__kustoWriteTextToClipboard = __kustoWriteTextToClipboard;
_win.__kustoParseMaybeJson = __kustoParseMaybeJson;
