function openObjectViewer(row, col, boxId) {
	if (!window.currentResult || window.currentResult.boxId !== boxId) { return; }

	const cellData = window.currentResult.rows[row][col];
	if (!cellData || !cellData.isObject) { return; }

	const columnName = __kustoGetObjectViewerColumnName(col);

	const modal = document.getElementById('objectViewer');
	const searchInput = document.getElementById('objectViewerSearch');
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
		window.__kustoObjectViewerRawVisible = true;
		const rawBody = document.getElementById('objectViewerRawBody');
		if (rawBody) { rawBody.style.display = ''; }
		const rawToggle = document.getElementById('objectViewerRawToggle');
		if (rawToggle) { rawToggle.classList.add('is-active'); }
	} catch { /* ignore */ }

	// Initialize navigation state and render.
	const rootValue = __kustoParseMaybeJson(cellData.full);
	window.__kustoObjectViewerState = {
		columnName: columnName,
		stack: [{ label: columnName, value: rootValue }]
	};
	__kustoRenderObjectViewer();

	modal.classList.add('visible');

	// Check if there's an active data search and if this cell is a search match
	const dataSearchInput = document.getElementById(boxId + '_data_search');
	const dataSearchTerm = dataSearchInput ? dataSearchInput.value : '';

	if (dataSearchTerm && window.currentResult.searchMatches &&
		window.currentResult.searchMatches.some(m => m.row === row && m.col === col)) {
		// Automatically search for the same term in the object viewer
		searchInput.value = dataSearchTerm;
		searchInObjectViewer();
	} else {
		// Clear search
		searchInput.value = '';
		document.getElementById('objectViewerSearchResults').textContent = '';
	}
}

function copyObjectViewerRawToClipboard() {
	const rawBody = document.getElementById('objectViewerRawBody');
	const rawEl = document.getElementById('objectViewerContent');
	if (!rawBody || !rawEl) { return; }

	let textToCopy = '';
	try {
		const sel = window.getSelection && window.getSelection();
		const hasSelection = sel && !sel.isCollapsed && typeof sel.toString === 'function' && sel.toString();
		const inRaw = sel && sel.anchorNode && sel.focusNode && rawBody.contains(sel.anchorNode) && rawBody.contains(sel.focusNode);
		if (hasSelection && inRaw) {
			textToCopy = sel.toString();
		}
	} catch { /* ignore */ }

	if (!textToCopy) {
		try {
			textToCopy = String(window.currentObjectViewerData && window.currentObjectViewerData.raw ? window.currentObjectViewerData.raw : '');
		} catch {
			textToCopy = '';
		}
	}

	__kustoWriteTextToClipboard(textToCopy);
}

function closeObjectViewer(event) {
	if (event && event.target !== event.currentTarget && !event.currentTarget.classList.contains('object-viewer-close')) {
		return;
	}

	const modal = document.getElementById('objectViewer');
	modal.classList.remove('visible');
	window.currentObjectViewerData = null;
	try { window.__kustoObjectViewerState = null; } catch { /* ignore */ }
}

function toggleObjectViewerRaw() {
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
	try { window.__kustoObjectViewerRawVisible = next; } catch { /* ignore */ }
}

function objectViewerNavigateBack() {
	const st = window.__kustoObjectViewerState;
	if (!st || !Array.isArray(st.stack) || st.stack.length <= 1) { return; }
	st.stack.pop();
	__kustoRenderObjectViewer();
}

function objectViewerNavigateToDepth(depth) {
	const st = window.__kustoObjectViewerState;
	if (!st || !Array.isArray(st.stack)) { return; }
	const d = parseInt(String(depth), 10);
	if (!isFinite(d) || d < 1 || d > st.stack.length) { return; }
	if (d === st.stack.length) { return; }
	st.stack = st.stack.slice(0, d);
	__kustoRenderObjectViewer();
}

function objectViewerNavigateInto(key) {
	const st = window.__kustoObjectViewerState;
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

function __kustoGetObjectViewerColumnName(colIndex) {
	try {
		const cols = (window.currentResult && Array.isArray(window.currentResult.columns)) ? window.currentResult.columns : [];
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

function __kustoParseMaybeJson(value) {
	if (typeof value !== 'string') {
		return value;
	}
	const s = value.trim();
	if (!s) {
		return value;
	}
	// Only attempt JSON.parse when the string looks like JSON.
	if (!(s.startsWith('{') || s.startsWith('[') || s === 'null' || s === 'true' || s === 'false' || /^-?\d/.test(s) || s.startsWith('"'))) {
		return value;
	}
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function __kustoStringifyForSearch(value) {
	try {
		if (value === null || value === undefined) return '';
		if (typeof value === 'string') return value;
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function __kustoFormatScalarForTable(value) {
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

function __kustoIsComplexValue(value) {
	if (value === null || value === undefined) return false;
	if (typeof value === 'string') {
		const s = value.trim();
		return s.startsWith('{') || s.startsWith('[');
	}
	return typeof value === 'object';
}

function __kustoEnsureObjectViewerRawToggleIcon() {
	const btn = document.getElementById('objectViewerRawToggle');
	if (!btn) { return; }
	if (btn.__kustoHasIcon) { return; }
	btn.__kustoHasIcon = true;
	try {
		if (typeof __kustoGetResultsVisibilityIconSvg === 'function') {
			btn.innerHTML = __kustoGetResultsVisibilityIconSvg();
		} else {
			btn.textContent = 'Hide';
		}
	} catch {
		btn.textContent = 'Hide';
	}
}

function __kustoEnsureObjectViewerRawCopyIcon() {
	const btn = document.getElementById('objectViewerRawCopy');
	if (!btn) { return; }
	if (btn.__kustoHasIcon) { return; }
	btn.__kustoHasIcon = true;
	try {
		btn.innerHTML = __kustoGetCopyIconSvg(16);
	} catch {
		btn.textContent = 'Copy';
	}
}

function __kustoGetCopyIconSvg(size) {
	const s = (typeof size === 'number' && isFinite(size) && size > 0) ? Math.floor(size) : 16;
	return (
		'<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<rect x="5" y="5" width="9" height="9" rx="2" />' +
		'<path d="M3 11V4c0-1.1.9-2 2-2h7" />' +
		'</svg>'
	);
}

function __kustoWriteTextToClipboard(text) {
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

function __kustoRenderObjectViewer() {
	const st = window.__kustoObjectViewerState;
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
					crumb.addEventListener('click', (e) => {
						try { e.stopPropagation(); } catch { /* ignore */ }
						objectViewerNavigateToDepth(i + 1);
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
		window.currentObjectViewerData = {
			raw: __kustoStringifyForSearch(frame.value),
			formatted: formatJson(frame.value)
		};
	} catch {
		window.currentObjectViewerData = {
			raw: String(frame.value || ''),
			formatted: formatJson(frame.value)
		};
	}
	try {
		if (content) {
			content.innerHTML = window.currentObjectViewerData.formatted;
		}
	} catch { /* ignore */ }

	// If user already typed a search term, keep highlighting in sync.
	try {
		const input = document.getElementById('objectViewerSearch');
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
		const keys = Array.isArray(v) ? v.map((_, i) => String(i)) : Object.keys(v);
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
			let nextValue;
			try { nextValue = v[key]; } catch { nextValue = undefined; }

			const parsedNext = __kustoParseMaybeJson(nextValue);
			try {
				tr.dataset.kustoKeyLower = String(key).toLowerCase();
				tr.dataset.kustoValueLower = __kustoStringifyForSearch(parsedNext).toLowerCase();
			} catch { /* ignore */ }

			// Copy value icon (hover on row). Copies the property's raw value.
			const copyBtn = document.createElement('button');
			copyBtn.type = 'button';
			copyBtn.className = 'refresh-btn close-btn object-viewer-prop-copy-btn';
			copyBtn.title = 'Copy value to clipboard';
			copyBtn.setAttribute('aria-label', 'Copy value to clipboard');
			try { copyBtn.innerHTML = __kustoGetCopyIconSvg(14); } catch { copyBtn.textContent = 'Copy'; }
			copyBtn.addEventListener('click', (e) => {
				try { e.stopPropagation(); } catch { /* ignore */ }
				__kustoWriteTextToClipboard(__kustoStringifyForSearch(parsedNext));
			});
			keyCell.appendChild(copyBtn);
			tdKey.appendChild(keyCell);
			if (__kustoIsComplexValue(parsedNext)) {
				const btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'object-view-btn';
				btn.textContent = 'View';
				btn.addEventListener('click', (e) => {
					try { e.stopPropagation(); } catch { /* ignore */ }
					objectViewerNavigateInto(key);
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

function __kustoApplyObjectViewerTableSearchHighlight() {
	const table = document.getElementById('objectViewerPropsTable');
	if (!table) { return; }
	const input = document.getElementById('objectViewerSearch');
	const term = input ? String(input.value || '').trim().toLowerCase() : '';
	const rows = table.querySelectorAll('tr');
	rows.forEach((tr) => {
		try {
			const keyLower = tr.dataset ? String(tr.dataset.kustoKeyLower || '') : '';
			const valueLower = tr.dataset ? String(tr.dataset.kustoValueLower || '') : '';
			const hit = !!term && (keyLower.includes(term) || valueLower.includes(term));
			tr.classList.toggle('search-match', hit);
		} catch { /* ignore */ }
	});
}

function formatJson(jsonString) {
	try {
		const obj = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;
		return syntaxHighlightJson(obj);
	} catch (e) {
		return '<span class="json-string">' + escapeHtml(jsonString) + '</span>';
	}
}

function syntaxHighlightJson(obj, indent = 0) {
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
		const keys = Object.keys(obj);
		if (keys.length === 0) {
			return '{}';
		}

		let result = '{\n';
		keys.forEach((key, index) => {
			result += nextIndent + '<span class="json-key">"' + escapeHtml(key) + '"</span>: ';
			result += syntaxHighlightJson(obj[key], indent + 1);
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

function searchInObjectViewer() {
	if (!window.currentObjectViewerData) { return; }

	const searchTerm = document.getElementById('objectViewerSearch').value.toLowerCase();
	const content = document.getElementById('objectViewerContent');
	const resultsSpan = document.getElementById('objectViewerSearchResults');

	if (!searchTerm) {
		content.innerHTML = window.currentObjectViewerData.formatted;
		resultsSpan.textContent = '';
		try { __kustoApplyObjectViewerTableSearchHighlight(); } catch { /* ignore */ }
		return;
	}

	// Count matches in the raw JSON
	const rawJson = String(window.currentObjectViewerData.raw || '').toLowerCase();
	const matches = (rawJson.match(new RegExp(escapeRegex(searchTerm), 'g')) || []).length;

	// Highlight matches in the formatted JSON
	const highlightedHtml = highlightSearchTerm(window.currentObjectViewerData.formatted, searchTerm);
	content.innerHTML = highlightedHtml;

	resultsSpan.textContent = matches > 0 ? matches + ' match' + (matches !== 1 ? 'es' : '') : 'No matches';
	try { __kustoApplyObjectViewerTableSearchHighlight(); } catch { /* ignore */ }
}

function highlightSearchTerm(html, searchTerm) {
	// Create a temporary div to work with the HTML
	const tempDiv = document.createElement('div');
	tempDiv.innerHTML = html;

	// Function to highlight text in text nodes
	function highlightInNode(node) {
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node.textContent;
			const lowerText = text.toLowerCase();
			const lowerSearch = searchTerm.toLowerCase();

			if (lowerText.includes(lowerSearch)) {
				const parts = [];
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
				parts.forEach(part => parent.insertBefore(part, node));
				parent.removeChild(node);
			}
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			// Recursively process child nodes
			Array.from(node.childNodes).forEach(child => highlightInNode(child));
		}
	}

	highlightInNode(tempDiv);
	return tempDiv.innerHTML;
}
