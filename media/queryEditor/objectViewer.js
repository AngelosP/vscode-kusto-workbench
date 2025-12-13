function openObjectViewer(row, col, boxId) {
	if (!window.currentResult || window.currentResult.boxId !== boxId) { return; }

	const cellData = window.currentResult.rows[row][col];
	if (!cellData || !cellData.isObject) { return; }

	const modal = document.getElementById('objectViewer');
	const content = document.getElementById('objectViewerContent');
	const searchInput = document.getElementById('objectViewerSearch');

	// Store the JSON data for searching
	window.currentObjectViewerData = {
		raw: cellData.full,
		formatted: formatJson(cellData.full)
	};

	content.innerHTML = window.currentObjectViewerData.formatted;
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

function closeObjectViewer(event) {
	if (event && event.target !== event.currentTarget && !event.currentTarget.classList.contains('object-viewer-close')) {
		return;
	}

	const modal = document.getElementById('objectViewer');
	modal.classList.remove('visible');
	window.currentObjectViewerData = null;
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
		return;
	}

	// Count matches in the raw JSON
	const rawJson = window.currentObjectViewerData.raw.toLowerCase();
	const matches = (rawJson.match(new RegExp(escapeRegex(searchTerm), 'g')) || []).length;

	// Highlight matches in the formatted JSON
	const highlightedHtml = highlightSearchTerm(window.currentObjectViewerData.formatted, searchTerm);
	content.innerHTML = highlightedHtml;

	resultsSpan.textContent = matches > 0 ? matches + ' match' + (matches !== 1 ? 'es' : '') : 'No matches';

	// Scroll to first match
	const firstMatch = content.querySelector('.json-highlight');
	if (firstMatch) {
		firstMatch.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}
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
