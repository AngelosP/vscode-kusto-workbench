function displayResult(result) {
	const boxId = window.lastExecutedBox;
	if (!boxId) { return; }

	setQueryExecuting(boxId, false);

	const resultsDiv = document.getElementById(boxId + '_results');
	if (!resultsDiv) { return; }

	// Store result data for navigation
	window.currentResult = {
		boxId: boxId,
		columns: result.columns,
		rows: result.rows,
		metadata: result.metadata,
		selectedCell: null,
		selectedRows: new Set(),
		searchMatches: [],
		currentSearchIndex: -1
	};

	let html =
		'<div class="results-header">' +
		'<div>' +
		'<strong>Results:</strong> ' + result.metadata.cluster + ' / ' + result.metadata.database +
		' (Execution time: ' + result.metadata.executionTime + ')' +
		'</div>' +
		'<div class="results-tools">' +
		'<button class="tool-toggle-btn" onclick="toggleSearchTool(\'' + boxId + '\')" title="Search data">🔍</button>' +
		'<button class="tool-toggle-btn" onclick="toggleColumnTool(\'' + boxId + '\')" title="Scroll to column">📋</button>' +
		'</div>' +
		'</div>' +
		'<div class="data-search" id="' + boxId + '_data_search_container" style="display: none;">' +
		'<input type="text" placeholder="Search data..." id="' + boxId + '_data_search" ' +
		'oninput="searchData(\'' + boxId + '\')" ' +
		'onkeydown="handleDataSearchKeydown(event, \'' + boxId + '\')" />' +
		'<div class="data-search-nav">' +
		'<button id="' + boxId + '_search_prev" onclick="previousSearchMatch(\'' + boxId + '\')" disabled title="Previous (Shift+Enter)">↑</button>' +
		'<button id="' + boxId + '_search_next" onclick="nextSearchMatch(\'' + boxId + '\')" disabled title="Next (Enter)">↓</button>' +
		'</div>' +
		'<span class="data-search-info" id="' + boxId + '_search_info"></span>' +
		'</div>' +
		'<div class="column-search" id="' + boxId + '_column_search_container" style="display: none;">' +
		'<input type="text" placeholder="Scroll to column..." id="' + boxId + '_column_search" ' +
		'oninput="filterColumns(\'' + boxId + '\')" ' +
		'onkeydown="handleColumnSearchKeydown(event, \'' + boxId + '\')" />' +
		'<div class="column-autocomplete" id="' + boxId + '_column_autocomplete"></div>' +
		'</div>' +
		'<div class="table-container" id="' + boxId + '_table_container" tabindex="0" onkeydown="handleTableKeydown(event, \'' + boxId + '\')">' +
		'<table id="' + boxId + '_table">' +
		'<thead><tr>' +
		'<th class="row-selector">#</th>' +
		result.columns.map((c, i) =>
			'<th data-col="' + i + '">' +
			'<div class="column-header-content">' +
			'<span>' + c + '</span>' +
			'<button class="column-menu-btn" onclick="toggleColumnMenu(' + i + ', \'' + boxId + '\'); event.stopPropagation();">☰</button>' +
			'<div class="column-menu" id="' + boxId + '_col_menu_' + i + '">' +
			'<div class="column-menu-item" onclick="showUniqueValues(' + i + ', \'' + boxId + '\')">Unique values</div>' +
			'<div class="column-menu-item" onclick="showDistinctCountPicker(' + i + ', \'' + boxId + '\')">Distinct count by column...</div>' +
			'</div>' +
			'</div>' +
			'</th>'
		).join('') +
		'</tr></thead>' +
		'<tbody>' +
		result.rows.map((row, rowIdx) =>
			'<tr data-row="' + rowIdx + '">' +
			'<td class="row-selector" onclick="toggleRowSelection(' + rowIdx + ', \'' + boxId + '\')">' + (rowIdx + 1) + '</td>' +
			row.map((cell, colIdx) => {
				// Check if cell is an object with display and full properties
				const hasHover = typeof cell === 'object' && cell !== null && 'display' in cell && 'full' in cell;
				const displayValue = hasHover ? cell.display : cell;
				const fullValue = hasHover ? cell.full : cell;
				const isObject = cell && cell.isObject;
				const title = hasHover && displayValue !== fullValue && !isObject ? ' title="' + fullValue + '"' : '';
				const viewBtn = isObject ? '<button class="object-view-btn" onclick="event.stopPropagation(); openObjectViewer(' + rowIdx + ', ' + colIdx + ', \'' + boxId + '\')">View</button>' : '';
				return '<td data-row="' + rowIdx + '" data-col="' + colIdx + '"' + title + ' ' +
					'onclick="selectCell(' + rowIdx + ', ' + colIdx + ', \'' + boxId + '\')">' +
					displayValue + viewBtn + '</td>';
			}).join('') +
			'</tr>'
		).join('') +
		'</tbody>' +
		'</table>' +
		'</div>';

	resultsDiv.innerHTML = html;
	resultsDiv.classList.add('visible');
}

function displayError(error) {
	const boxId = window.lastExecutedBox;
	if (!boxId) { return; }

	setQueryExecuting(boxId, false);

	const resultsDiv = document.getElementById(boxId + '_results');
	if (!resultsDiv) { return; }

	resultsDiv.innerHTML =
		'<div class="results-header" style="color: var(--vscode-errorForeground);">' +
		'<strong>Error:</strong> ' + error +
		'</div>';
	resultsDiv.classList.add('visible');
}

function selectCell(row, col, boxId) {
	if (!window.currentResult || window.currentResult.boxId !== boxId) { return; }

	// Clear previous selection
	const prevCell = document.querySelector('#' + boxId + '_table td.selected-cell');
	if (prevCell) {
		prevCell.classList.remove('selected-cell');
	}

	// Select new cell
	const cell = document.querySelector('#' + boxId + '_table td[data-row="' + row + '"][data-col="' + col + '"]');
	if (cell) {
		cell.classList.add('selected-cell');
		window.currentResult.selectedCell = { row, col };

		// Scroll cell into view
		cell.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });

		// Focus the container for keyboard navigation
		const container = document.getElementById(boxId + '_table_container');
		if (container) {
			container.focus();
		}
	}
}

function toggleRowSelection(row, boxId) {
	if (!window.currentResult || window.currentResult.boxId !== boxId) { return; }

	const rowElement = document.querySelector('#' + boxId + '_table tr[data-row="' + row + '"]');
	if (!rowElement) { return; }

	if (window.currentResult.selectedRows.has(row)) {
		window.currentResult.selectedRows.delete(row);
		rowElement.classList.remove('selected-row');
	} else {
		window.currentResult.selectedRows.add(row);
		rowElement.classList.add('selected-row');
	}
}

function toggleSearchTool(boxId) {
	const container = document.getElementById(boxId + '_data_search_container');
	const button = event.target.closest('.tool-toggle-btn');

	if (container.style.display === 'none') {
		// Close the other tool first
		const columnContainer = document.getElementById(boxId + '_column_search_container');
		if (columnContainer) {
			columnContainer.style.display = 'none';
		}
		// Remove active state from all buttons
		document.querySelectorAll('.tool-toggle-btn').forEach(btn => btn.classList.remove('active'));

		// Show this tool
		container.style.display = 'flex';
		button.classList.add('active');

		// Focus the input
		const input = document.getElementById(boxId + '_data_search');
		if (input) {
			setTimeout(() => input.focus(), 0);
		}
	} else {
		// Hide this tool
		container.style.display = 'none';
		button.classList.remove('active');
	}
}

function toggleColumnTool(boxId) {
	const container = document.getElementById(boxId + '_column_search_container');
	const button = event.target.closest('.tool-toggle-btn');

	if (container.style.display === 'none') {
		// Close the other tool first
		const searchContainer = document.getElementById(boxId + '_data_search_container');
		if (searchContainer) {
			searchContainer.style.display = 'none';
		}
		// Remove active state from all buttons
		document.querySelectorAll('.tool-toggle-btn').forEach(btn => btn.classList.remove('active'));

		// Show this tool
		container.style.display = 'block';
		button.classList.add('active');

		// Focus the input
		const input = document.getElementById(boxId + '_column_search');
		if (input) {
			setTimeout(() => input.focus(), 0);
		}
	} else {
		// Hide this tool
		container.style.display = 'none';
		button.classList.remove('active');
	}
}

function searchData(boxId) {
	if (!window.currentResult || window.currentResult.boxId !== boxId) { return; }

	const searchInput = document.getElementById(boxId + '_data_search');
	const searchTerm = searchInput.value.toLowerCase();
	const infoSpan = document.getElementById(boxId + '_search_info');
	const prevBtn = document.getElementById(boxId + '_search_prev');
	const nextBtn = document.getElementById(boxId + '_search_next');

	// Clear previous search highlights
	document.querySelectorAll('#' + boxId + '_table td.search-match, #' + boxId + '_table td.search-match-current')
		.forEach(cell => {
			cell.classList.remove('search-match', 'search-match-current');
		});

	window.currentResult.searchMatches = [];
	window.currentResult.currentSearchIndex = -1;

	if (!searchTerm) {
		infoSpan.textContent = '';
		prevBtn.disabled = true;
		nextBtn.disabled = true;
		return;
	}

	// Search through all cells
	window.currentResult.rows.forEach((row, rowIdx) => {
		row.forEach((cell, colIdx) => {
			let cellText = '';

			// Extract searchable text from cell
			if (typeof cell === 'object' && cell !== null) {
				// If it's a formatted cell object, search in both display and full values
				if ('display' in cell) {
					cellText = cell.display + ' ' + (cell.full || '');
				} else {
					cellText = JSON.stringify(cell);
				}
			} else {
				cellText = String(cell);
			}

			// Check if search term is in cell text
			if (cellText.toLowerCase().includes(searchTerm)) {
				window.currentResult.searchMatches.push({ row: rowIdx, col: colIdx });
			}
		});
	});

	// Update UI
	const matchCount = window.currentResult.searchMatches.length;
	if (matchCount > 0) {
		infoSpan.textContent = matchCount + ' match' + (matchCount !== 1 ? 'es' : '');
		prevBtn.disabled = false;
		nextBtn.disabled = false;

		// Highlight all matches
		window.currentResult.searchMatches.forEach(match => {
			const cell = document.querySelector('#' + boxId + '_table td[data-row="' + match.row + '"][data-col="' + match.col + '"]');
			if (cell) {
				cell.classList.add('search-match');
			}
		});

		// Jump to first match
		window.currentResult.currentSearchIndex = 0;
		highlightCurrentSearchMatch(boxId);
	} else {
		infoSpan.textContent = 'No matches';
		prevBtn.disabled = true;
		nextBtn.disabled = true;
	}
}

function nextSearchMatch(boxId) {
	if (!window.currentResult || window.currentResult.boxId !== boxId) { return; }

	const matches = window.currentResult.searchMatches;
	if (matches.length === 0) { return; }

	window.currentResult.currentSearchIndex = (window.currentResult.currentSearchIndex + 1) % matches.length;
	highlightCurrentSearchMatch(boxId);
}

function previousSearchMatch(boxId) {
	if (!window.currentResult || window.currentResult.boxId !== boxId) { return; }

	const matches = window.currentResult.searchMatches;
	if (matches.length === 0) { return; }

	window.currentResult.currentSearchIndex = (window.currentResult.currentSearchIndex - 1 + matches.length) % matches.length;
	highlightCurrentSearchMatch(boxId);
}

function highlightCurrentSearchMatch(boxId) {
	if (!window.currentResult || window.currentResult.boxId !== boxId) { return; }

	const matches = window.currentResult.searchMatches;
	const currentIndex = window.currentResult.currentSearchIndex;

	if (currentIndex < 0 || currentIndex >= matches.length) { return; }

	// Remove current highlight from all cells
	document.querySelectorAll('#' + boxId + '_table td.search-match-current')
		.forEach(cell => cell.classList.remove('search-match-current'));

	// Highlight current match
	const match = matches[currentIndex];
	const cell = document.querySelector('#' + boxId + '_table td[data-row="' + match.row + '"][data-col="' + match.col + '"]');

	if (cell) {
		cell.classList.add('search-match-current');
		cell.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
	}

	// Update info text
	const infoSpan = document.getElementById(boxId + '_search_info');
	if (infoSpan) {
		infoSpan.textContent = (currentIndex + 1) + ' of ' + matches.length;
	}
}

function handleDataSearchKeydown(event, boxId) {
	if (event.key === 'Enter') {
		event.preventDefault();
		if (event.shiftKey) {
			previousSearchMatch(boxId);
		} else {
			nextSearchMatch(boxId);
		}
	}
}

function handleTableKeydown(event, boxId) {
	if (!window.currentResult || window.currentResult.boxId !== boxId) { return; }

	// Handle copy to clipboard (Ctrl+C or Cmd+C)
	if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
		event.preventDefault();
		copySelectionToClipboard(boxId);
		return;
	}

	const cell = window.currentResult.selectedCell;
	if (!cell) {
		// If no cell selected, select first cell
		if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
			event.preventDefault();
			selectCell(0, 0, boxId);
		}
		return;
	}

	let newRow = cell.row;
	let newCol = cell.col;
	const maxRow = window.currentResult.rows.length - 1;
	const maxCol = window.currentResult.columns.length - 1;

	switch (event.key) {
		case 'ArrowRight':
			if (newCol < maxCol) {
				newCol++;
				event.preventDefault();
			}
			break;
		case 'ArrowLeft':
			if (newCol > 0) {
				newCol--;
				event.preventDefault();
			}
			break;
		case 'ArrowDown':
			if (newRow < maxRow) {
				newRow++;
				event.preventDefault();
			}
			break;
		case 'ArrowUp':
			if (newRow > 0) {
				newRow--;
				event.preventDefault();
			}
			break;
		case 'Home':
			if (event.ctrlKey) {
				newRow = 0;
				newCol = 0;
			} else {
				newCol = 0;
			}
			event.preventDefault();
			break;
		case 'End':
			if (event.ctrlKey) {
				newRow = maxRow;
				newCol = maxCol;
			} else {
				newCol = maxCol;
			}
			event.preventDefault();
			break;
		default:
			return;
	}

	if (newRow !== cell.row || newCol !== cell.col) {
		selectCell(newRow, newCol, boxId);
	}
}

function filterColumns(boxId) {
	if (!window.currentResult || window.currentResult.boxId !== boxId) { return; }

	const input = document.getElementById(boxId + '_column_search');
	const autocomplete = document.getElementById(boxId + '_column_autocomplete');
	if (!input || !autocomplete) { return; }

	const query = input.value.toLowerCase();

	if (!query) {
		autocomplete.classList.remove('visible');
		return;
	}

	const matches = window.currentResult.columns
		.map((col, idx) => ({ name: col, index: idx }))
		.filter(col => col.name.toLowerCase().includes(query));

	if (matches.length === 0) {
		autocomplete.classList.remove('visible');
		return;
	}

	autocomplete.innerHTML = matches.map((col, idx) =>
		'<div class="column-autocomplete-item' + (idx === 0 ? ' selected' : '') + '" ' +
		'data-col-index="' + col.index + '" ' +
		'onclick="scrollToColumn(' + col.index + ', \'' + boxId + '\')">' +
		col.name + '</div>'
	).join('');

	autocomplete.classList.add('visible');
	window.currentAutocompleteIndex = 0;
}

function handleColumnSearchKeydown(event, boxId) {
	const autocomplete = document.getElementById(boxId + '_column_autocomplete');
	if (!autocomplete || !autocomplete.classList.contains('visible')) { return; }

	const items = autocomplete.querySelectorAll('.column-autocomplete-item');
	if (items.length === 0) { return; }

	if (event.key === 'ArrowDown') {
		event.preventDefault();
		window.currentAutocompleteIndex = (window.currentAutocompleteIndex + 1) % items.length;
		updateAutocompleteSelection(items);
	} else if (event.key === 'ArrowUp') {
		event.preventDefault();
		window.currentAutocompleteIndex = (window.currentAutocompleteIndex - 1 + items.length) % items.length;
		updateAutocompleteSelection(items);
	} else if (event.key === 'Enter') {
		event.preventDefault();
		const selected = items[window.currentAutocompleteIndex];
		if (selected) {
			const colIndex = parseInt(selected.getAttribute('data-col-index'));
			scrollToColumn(colIndex, boxId);
			autocomplete.classList.remove('visible');
			const input = document.getElementById(boxId + '_column_search');
			if (input) { input.value = ''; }
		}
	} else if (event.key === 'Escape') {
		event.preventDefault();
		autocomplete.classList.remove('visible');
	}
}

function updateAutocompleteSelection(items) {
	items.forEach((item, idx) => {
		if (idx === window.currentAutocompleteIndex) {
			item.classList.add('selected');
			item.scrollIntoView({ block: 'nearest' });
		} else {
			item.classList.remove('selected');
		}
	});
}

function scrollToColumn(colIndex, boxId) {
	if (!window.currentResult || window.currentResult.boxId !== boxId) { return; }

	// Select first cell in that column first
	selectCell(0, colIndex, boxId);

	// Then scroll the container to center the column
	setTimeout(() => {
		const cell = document.querySelector('#' + boxId + '_table td[data-row="0"][data-col="' + colIndex + '"]');
		if (cell) {
			cell.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
		}
	}, 100);
}

function copySelectionToClipboard(boxId) {
	if (!window.currentResult || window.currentResult.boxId !== boxId) { return; }

	// Check if any rows are selected
	if (window.currentResult.selectedRows.size > 0) {
		// Copy selected rows in tab-delimited format
		const rowIndices = Array.from(window.currentResult.selectedRows).sort((a, b) => a - b);
		const textToCopy = rowIndices.map(rowIdx => {
			const row = window.currentResult.rows[rowIdx];
			return row.join('\t');
		}).join('\n');

		navigator.clipboard.writeText(textToCopy).then(() => {
			console.log('Copied ' + rowIndices.length + ' row(s) to clipboard');
		}).catch(err => {
			console.error('Failed to copy rows:', err);
		});
	} else if (window.currentResult.selectedCell) {
		// Copy single cell value
		const cell = window.currentResult.selectedCell;
		const value = window.currentResult.rows[cell.row][cell.col];

		navigator.clipboard.writeText(value).then(() => {
			console.log('Copied cell value to clipboard:', value);
		}).catch(err => {
			console.error('Failed to copy cell:', err);
		});
	}
}
