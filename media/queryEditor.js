// Bootstrap loader for the Kusto Query Editor webview.
//
// The implementation is split into smaller files under media/queryEditor/.
// This file remains as the stable entrypoint referenced by the webview HTML.
(function bootstrapKustoQueryEditor() {
	// If the user clicks "+ Add Query Box" before scripts are fully loaded,
	// queue those clicks and replay them once initialization completes.
	if (typeof window.__kustoQueryEditorPendingAdd !== 'number') {
		window.__kustoQueryEditorPendingAdd = 0;
	}
	if (typeof window.addQueryBox !== 'function') {
		window.addQueryBox = function () {
			window.__kustoQueryEditorPendingAdd++;
		};
	}

	const getBaseUrl = () => {
		try {
			if (document.currentScript && document.currentScript.src) {
				return new URL('.', document.currentScript.src);
			}
		} catch {
			// ignore
		}
		const scripts = document.getElementsByTagName('script');
		const last = scripts[scripts.length - 1];
		return new URL('.', last && last.src ? last.src : window.location.href);
	};

	const baseUrl = getBaseUrl();
	const scriptPaths = [
		'queryEditor/vscode.js',
		'queryEditor/state.js',
		'queryEditor/utils.js',
		'queryEditor/schema.js',
		'queryEditor/monaco.js',
		'queryEditor/queryBoxes.js',
		'queryEditor/resultsTable.js',
		'queryEditor/objectViewer.js',
		'queryEditor/columnAnalysis.js',
		'queryEditor/main.js'
	];

	const loadScript = (relativePath) => {
		return new Promise((resolve, reject) => {
			const el = document.createElement('script');
			el.src = new URL(relativePath, baseUrl).toString();
			el.onload = () => resolve();
			el.onerror = () => reject(new Error(`Failed to load ${relativePath}`));
			(document.head || document.documentElement).appendChild(el);
		});
	};

	(async () => {
		for (const path of scriptPaths) {
			await loadScript(path);
		}
	})().catch((err) => {
		console.error('[kusto-query-editor] bootstrap failed', err);
	});
})();

/*
 * Legacy monolith (disabled): this file was split into smaller scripts under media/queryEditor/.
 * Keeping the old content commented out avoids shipping-breaking diffs while we validate the split.


// Request connections on load
vscode.postMessage({ type: 'getConnections' });

window.addEventListener('message', event => {
	const message = event.data;
	switch (message.type) {
		case 'connectionsData':
			connections = message.connections;
			lastConnectionId = message.lastConnectionId;
			lastDatabase = message.lastDatabase;
			cachedDatabases = message.cachedDatabases || {};
			updateConnectionSelects();
			break;
		case 'databasesData':
			updateDatabaseSelect(message.boxId, message.databases);
			break;
		case 'queryResult':
			displayResult(message.result);
			break;
		case 'queryError':
			displayError(message.error);
			break;
		case 'schemaData':
			schemaByBoxId[message.boxId] = message.schema;
			setSchemaLoading(message.boxId, false);
			{
				const meta = message.schemaMeta || {};
				const tablesCount = meta.tablesCount ?? (message.schema?.tables?.length ?? 0);
				const columnsCount = meta.columnsCount ?? 0;
				const cacheTag = meta.fromCache ? ' (cache)' : '';
				setSchemaLoadedSummary(
					message.boxId,
					'Schema: ' + tablesCount + ' tables, ' + columnsCount + ' cols' + cacheTag,
					'Schema loaded for autocomplete' + cacheTag,
					false
				);
			}
			break;
		case 'schemaError':
			// Non-fatal; autocomplete will just not have schema.
			setSchemaLoading(message.boxId, false);
			setSchemaLoadedSummary(message.boxId, 'Schema failed', message.error || 'Schema fetch failed', true);
			break;
	}
});

function addQueryBox() {
	const id = 'query_' + Date.now();
	queryBoxes.push(id);

	const container = document.getElementById('queries-container');
	const boxHtml =
		'<div class="query-box" id="' + id + '">' +
		'<div class="query-header">' +
		'<input type="text" class="query-name" placeholder="Query Name (optional)" id="' + id + '_name" />' +
		'<div class="select-wrapper" data-icon="🖥️">' +
		'<select id="' + id + '_connection" onchange="updateDatabaseField(\'' + id + '\')">' +
		'<option value="">Select Cluster...</option>' +
		'</select>' +
		'</div>' +
		'<div class="select-wrapper" data-icon="📊">' +
		'<select id="' + id + '_database" onchange="onDatabaseChanged(\'' + id + '\')">' +
		'<option value="">Select Database...</option>' +
		'</select>' +
		'</div>' +
		'<span class="schema-status" id="' + id + '_schema_status" style="display: none;" title="Loading schema for autocomplete...">' +
		'<span class="schema-spinner" aria-hidden="true"></span>' +
		'<span>Loading schema…</span>' +
		'</span>' +
		'<span class="schema-loaded" id="' + id + '_schema_loaded" style="display: none;"></span>' +
		'<button class="refresh-btn" onclick="refreshDatabases(\'' + id + '\')" id="' + id + '_refresh" title="Refresh database list">⟳</button>' +
		'<button class="refresh-btn" onclick="removeQueryBox(\'' + id + '\')" title="Remove query box">✖</button>' +
		'</div>' +
		'<div class="query-editor-wrapper">' +
		'<div class="query-editor" id="' + id + '_query_editor"></div>' +
		'<div class="query-editor-placeholder" id="' + id + '_query_placeholder">Enter your KQL query here...</div>' +
		'<div class="query-editor-resizer" id="' + id + '_query_resizer" title="Drag to resize editor"></div>' +
		'</div>' +
		'<div class="query-actions">' +
		'<div class="query-run">' +
		'<div class="split-button" id="' + id + '_run_split">' +
		'<button class="split-main" id="' + id + '_run_btn" onclick="executeQuery(\'' + id + '\')">▶ Run Query (take 100)</button>' +
		'<button class="split-toggle" id="' + id + '_run_toggle" onclick="toggleRunMenu(\'' + id + '\'); event.stopPropagation();" aria-label="Run query options">▾</button>' +
		'<div class="split-menu" id="' + id + '_run_menu" role="menu">' +
		'<div class="split-menu-item" role="menuitem" onclick="setRunMode(\'' + id + '\', \'plain\'); executeQuery(\'' + id + '\'); closeRunMenu(\'' + id + '\');">Run Query</div>' +
		'<div class="split-menu-item" role="menuitem" onclick="setRunMode(\'' + id + '\', \'take100\'); executeQuery(\'' + id + '\'); closeRunMenu(\'' + id + '\');">Run Query (take 100)</div>' +
		'<div class="split-menu-item" role="menuitem" onclick="setRunMode(\'' + id + '\', \'sample100\'); executeQuery(\'' + id + '\'); closeRunMenu(\'' + id + '\');">Run Query (sample 100)</div>' +
		'</div>' +
		'</div>' +
		'<span class="query-exec-status" id="' + id + '_exec_status" style="display: none;">' +
		'<span class="query-spinner" aria-hidden="true"></span>' +
		'<span id="' + id + '_exec_elapsed">0:00.0</span>' +
		'</span>' +
		'</div>' +
		'<div class="cache-controls">' +
		'<label class="cache-checkbox">' +
		'<input type="checkbox" id="' + id + '_cache_enabled" checked onchange="toggleCacheControls(\'' + id + '\')" />' +
		'Cache results for' +
		'</label>' +
		'<input type="number" id="' + id + '_cache_value" value="1" min="1" />' +
		'<select id="' + id + '_cache_unit">' +
		'<option value="minutes">Minutes</option>' +
		'<option value="hours">Hours</option>' +
		'<option value="days" selected>Days</option>' +
		'</select>' +
		'</div>' +
		'</div>' +
		'<div class="results" id="' + id + '_results"></div>' +
		'</div>';

	container.insertAdjacentHTML('beforeend', boxHtml);
	setRunMode(id, 'take100');
	updateConnectionSelects();
	initQueryEditor(id);
}

function removeQueryBox(boxId) {
	// Stop any running timer/spinner for this box
	setQueryExecuting(boxId, false);
	delete runModesByBoxId[boxId];

	// Disconnect any resize observer
	if (queryEditorResizeObservers[boxId]) {
		try {
			queryEditorResizeObservers[boxId].disconnect();
		} catch {
			// ignore
		}
		delete queryEditorResizeObservers[boxId];
	}

	// Dispose editor if present
	if (queryEditors[boxId]) {
		try {
			queryEditors[boxId].dispose();
		} catch {
			// ignore
		}
		delete queryEditors[boxId];
	}

	// Remove from tracked list
	queryBoxes = queryBoxes.filter(id => id !== boxId);

	// Clear any global pointers if they reference this box
	if (window.lastExecutedBox === boxId) {
		window.lastExecutedBox = null;
	}
	if (window.currentResult && window.currentResult.boxId === boxId) {
		window.currentResult = null;
	}

	// Remove DOM node
	const box = document.getElementById(boxId);
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
}

function toggleCacheControls(boxId) {
	const enabled = document.getElementById(boxId + '_cache_enabled').checked;
	const valueInput = document.getElementById(boxId + '_cache_value');
	const unitSelect = document.getElementById(boxId + '_cache_unit');

	if (valueInput) {
		valueInput.disabled = !enabled;
	}
	if (unitSelect) {
		unitSelect.disabled = !enabled;
	}
}

function updateConnectionSelects() {
	queryBoxes.forEach(id => {
		const select = document.getElementById(id + '_connection');
		if (select) {
			const currentValue = select.value;
			select.innerHTML = '<option value="">Select Cluster...</option>' +
				connections.map(c => '<option value="' + c.id + '">' + c.name + '</option>').join('');

			// Pre-fill with last selection if this is a new box
			if (!currentValue && lastConnectionId) {
				select.value = lastConnectionId;
				// Trigger database loading
				updateDatabaseField(id);
			} else if (currentValue) {
				select.value = currentValue;
			}
		}
	});
}

function updateDatabaseField(boxId) {
	const connectionId = document.getElementById(boxId + '_connection').value;
	const databaseSelect = document.getElementById(boxId + '_database');
	const refreshBtn = document.getElementById(boxId + '_refresh');
	// Connection changed: clear schema so it doesn't mismatch.
	delete schemaByBoxId[boxId];

	if (connectionId && databaseSelect) {
		// Check if we have cached databases for this connection
		const cached = cachedDatabases[connectionId];

		if (cached && cached.length > 0) {
			// Use cached databases immediately
			updateDatabaseSelect(boxId, cached);
			if (refreshBtn) {
				refreshBtn.disabled = false;
			}
		} else {
			// No cache, need to load from server
			databaseSelect.innerHTML = '<option value="">Loading databases...</option>';
			databaseSelect.disabled = true;
			if (refreshBtn) {
				refreshBtn.disabled = true;
			}

			// Request databases from the extension
			vscode.postMessage({
				type: 'getDatabases',
				connectionId: connectionId,
				boxId: boxId
			});
		}
	} else if (databaseSelect) {
		databaseSelect.innerHTML = '<option value="">Select Database...</option>';
		databaseSelect.disabled = false;
		if (refreshBtn) {
			refreshBtn.disabled = true;
		}
	}
}

function refreshDatabases(boxId) {
	const connectionId = document.getElementById(boxId + '_connection').value;
	if (!connectionId) {
		return;
	}

	const databaseSelect = document.getElementById(boxId + '_database');
	const refreshBtn = document.getElementById(boxId + '_refresh');

	if (databaseSelect) {
		databaseSelect.innerHTML = '<option value="">Refreshing...</option>';
		databaseSelect.disabled = true;
	}
	if (refreshBtn) {
		refreshBtn.disabled = true;
	}

	vscode.postMessage({
		type: 'refreshDatabases',
		connectionId: connectionId,
		boxId: boxId
	});
}

function updateDatabaseSelect(boxId, databases) {
	const databaseSelect = document.getElementById(boxId + '_database');
	const refreshBtn = document.getElementById(boxId + '_refresh');

	if (databaseSelect) {
		databaseSelect.innerHTML = '<option value="">Select Database...</option>' +
			databases.map(db => '<option value="' + db + '">' + db + '</option>').join('');
		databaseSelect.disabled = false;

		// Update local cache with new databases
		const connectionId = document.getElementById(boxId + '_connection').value;
		if (connectionId) {
			cachedDatabases[connectionId] = databases;
		}

		// Pre-fill with last selection if available
		if (lastDatabase && databases.includes(lastDatabase)) {
			databaseSelect.value = lastDatabase;
			onDatabaseChanged(boxId);
		}
	}
	if (refreshBtn) {
		refreshBtn.disabled = false;
	}
}

let queryExecutionTimers = {};
let runModesByBoxId = {};

function getRunMode(boxId) {
	return runModesByBoxId[boxId] || 'take100';
}

function getRunModeLabel(mode) {
	switch ((mode || '').toLowerCase()) {
		case 'plain':
			return '▶ Run Query';
		case 'sample100':
			return '▶ Run Query (sample 100)';
		case 'take100':
		default:
			return '▶ Run Query (take 100)';
	}
}

function setRunMode(boxId, mode) {
	runModesByBoxId[boxId] = (mode || 'take100');
	const runBtn = document.getElementById(boxId + '_run_btn');
	if (runBtn) {
		runBtn.textContent = getRunModeLabel(runModesByBoxId[boxId]);
	}
}

function closeRunMenu(boxId) {
	const menu = document.getElementById(boxId + '_run_menu');
	if (menu) {
		menu.style.display = 'none';
	}
}

function closeAllRunMenus() {
	queryBoxes.forEach(id => closeRunMenu(id));
}

function toggleRunMenu(boxId) {
	const menu = document.getElementById(boxId + '_run_menu');
	if (!menu) {
		return;
	}
	const next = menu.style.display === 'block' ? 'none' : 'block';
	closeAllRunMenus();
	menu.style.display = next;
}

document.addEventListener('click', () => {
	closeAllRunMenus();
});

function formatElapsed(ms) {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	const tenths = Math.floor((ms % 1000) / 100);
	return minutes + ':' + seconds.toString().padStart(2, '0') + '.' + tenths;
}

function setQueryExecuting(boxId, executing) {
	const runBtn = document.getElementById(boxId + '_run_btn');
	const runToggle = document.getElementById(boxId + '_run_toggle');
	const status = document.getElementById(boxId + '_exec_status');
	const elapsed = document.getElementById(boxId + '_exec_elapsed');

	if (queryExecutionTimers[boxId]) {
		clearInterval(queryExecutionTimers[boxId]);
		delete queryExecutionTimers[boxId];
	}

	if (executing) {
		if (runBtn) {
			runBtn.disabled = true;
		}
		if (runToggle) {
			runToggle.disabled = true;
		}
		closeRunMenu(boxId);
		if (status) {
			status.style.display = 'inline-flex';
		}
		if (elapsed) {
			elapsed.textContent = '0:00.0';
		}

		const start = performance.now();
		queryExecutionTimers[boxId] = setInterval(() => {
			if (elapsed) {
				elapsed.textContent = formatElapsed(performance.now() - start);
			}
		}, 100);
		return;
	}

	if (runBtn) {
		runBtn.disabled = false;
	}
	if (runToggle) {
		runToggle.disabled = false;
	}
	if (status) {
		status.style.display = 'none';
	}
}

function executeQuery(boxId, mode) {
	const effectiveMode = mode || getRunMode(boxId);
	const query = queryEditors[boxId] ? queryEditors[boxId].getValue() : '';
	const connectionId = document.getElementById(boxId + '_connection').value;
	const database = document.getElementById(boxId + '_database').value;
	const cacheEnabled = document.getElementById(boxId + '_cache_enabled').checked;
	const cacheValue = parseInt(document.getElementById(boxId + '_cache_value').value) || 1;
	const cacheUnit = document.getElementById(boxId + '_cache_unit').value;

	if (!query.trim()) {
		return;
	}

	if (!connectionId) {
		alert('Please select a cluster connection');
		return;
	}

	setQueryExecuting(boxId, true);
	closeRunMenu(boxId);

	// Store the last executed box for result display
	window.lastExecutedBox = boxId;

	vscode.postMessage({
		type: 'executeQuery',
		query,
		queryMode: effectiveMode,
		connectionId,
		database,
		boxId,
		cacheEnabled,
		cacheValue,
		cacheUnit
	});
}

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

function escapeHtml(str) {
	const div = document.createElement('div');
	div.textContent = str;
	return div.innerHTML;
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

function escapeRegex(str) {
	return str.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function toggleColumnMenu(colIdx, boxId) {
	console.log('toggleColumnMenu called:', colIdx, boxId);

	// Close all other menus
	document.querySelectorAll('.column-menu').forEach(menu => {
		if (menu.id !== boxId + '_col_menu_' + colIdx) {
			menu.classList.remove('visible');
		}
	});

	// Toggle this menu
	const menuId = boxId + '_col_menu_' + colIdx;
	const menu = document.getElementById(menuId);
	console.log('Menu element:', menu, 'ID:', menuId);
	if (menu) {
		const isVisible = menu.classList.contains('visible');

		if (!isVisible) {
			// Position the menu using fixed positioning
			const button = menu.previousElementSibling;
			if (button) {
				const rect = button.getBoundingClientRect();
				menu.style.position = 'fixed';
				menu.style.top = (rect.bottom + 2) + 'px';
				menu.style.left = rect.left + 'px';
			}
		}

		menu.classList.toggle('visible');
		console.log('Menu classes after toggle:', menu.className);
	}
}

function showUniqueValues(colIdx, boxId) {
	if (!window.currentResult || window.currentResult.boxId !== boxId) { return; }

	// Close menu
	toggleColumnMenu(colIdx, boxId);

	const columnName = window.currentResult.columns[colIdx];
	const valueCounts = new Map();

	// Count occurrences of each value
	window.currentResult.rows.forEach(row => {
		const cell = row[colIdx];
		let value;

		// Extract value from cell object
		if (typeof cell === 'object' && cell !== null && 'display' in cell) {
			value = cell.display;
		} else {
			value = String(cell);
		}

		valueCounts.set(value, (valueCounts.get(value) || 0) + 1);
	});

	const totalRows = window.currentResult.rows.length;

	// Convert to array and sort by count (descending)
	const sortedValues = Array.from(valueCounts.entries())
		.sort((a, b) => b[1] - a[1]);

	// Display in modal
	const modal = document.getElementById('columnAnalysisModal');
	const title = document.getElementById('columnAnalysisTitle');
	const body = document.getElementById('columnAnalysisBody');

	title.textContent = 'Unique Values - ' + columnName;

	let html = '<table class="column-analysis-table">';
	html += '<thead><tr><th>Value</th><th>Count</th><th>%</th></tr></thead>';
	html += '<tbody>';

	sortedValues.forEach(([value, count]) => {
		const percentage = ((count / totalRows) * 100).toFixed(2);
		html += '<tr><td>' + escapeHtml(value) + '</td><td>' + count + '</td><td>' + percentage + '%</td></tr>';
	});

	html += '</tbody></table>';
	html += '<div style="margin-top: 24px;">';
	html += '<canvas id="uniqueValuesPieChart" style="width: 100%; height: 400px;"></canvas>';
	html += '</div>';

	body.innerHTML = html;
	modal.classList.add('visible');

	// Draw pie chart after DOM is updated
	setTimeout(() => {
		const canvas = document.getElementById('uniqueValuesPieChart');
		if (canvas) {
			canvas.width = canvas.offsetWidth;
			canvas.height = 400;
			drawPieChart('uniqueValuesPieChart', sortedValues, totalRows);
		}
	}, 0);
}

function drawPieChart(canvasId, data, total) {
	const canvas = document.getElementById(canvasId);
	if (!canvas) return;

	const ctx = canvas.getContext('2d');
	// Calculate dimensions based on canvas width
	const chartWidth = canvas.width * 0.6; // 60% for pie chart
	const legendWidth = canvas.width * 0.4; // 40% for legend
	const centerX = chartWidth / 2;
	const centerY = canvas.height / 2;
	const radius = Math.min(centerX, centerY) - 40;

	// Generate colors
	const colors = [
		'#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
		'#1abc9c', '#e67e22', '#34495e', '#95a5a6', '#16a085',
		'#27ae60', '#2980b9', '#8e44ad', '#c0392b', '#d35400'
	];

	let currentAngle = -Math.PI / 2; // Start at top

	// Take top 10 values, group the rest as "Others"
	const topN = 10;
	let displayData = data.slice(0, topN);

	if (data.length > topN) {
		const othersCount = data.slice(topN).reduce((sum, [_, count]) => sum + count, 0);
		displayData.push(['Others', othersCount]);
	}

	// Draw slices
	displayData.forEach(([value, count], index) => {
		const sliceAngle = (count / total) * 2 * Math.PI;
		const color = colors[index % colors.length];

		// Draw slice
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.moveTo(centerX, centerY);
		ctx.arc(centerX, centerY, radius, currentAngle, currentAngle + sliceAngle);
		ctx.closePath();
		ctx.fill();

		// Draw border
		ctx.strokeStyle = '#ffffff';
		ctx.lineWidth = 2;
		ctx.stroke();

		// Draw label if slice is large enough
		const percentage = (count / total) * 100;
		if (percentage > 3) {
			const labelAngle = currentAngle + sliceAngle / 2;
			const labelX = centerX + (radius * 0.7) * Math.cos(labelAngle);
			const labelY = centerY + (radius * 0.7) * Math.sin(labelAngle);

			ctx.fillStyle = '#ffffff';
			ctx.font = 'bold 12px sans-serif';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.strokeStyle = '#000000';
			ctx.lineWidth = 3;
			ctx.strokeText(percentage.toFixed(1) + '%', labelX, labelY);
			ctx.fillText(percentage.toFixed(1) + '%', labelX, labelY);
		}

		currentAngle += sliceAngle;
	});

	// Draw legend on the right side
	const legendX = chartWidth + 20;
	let legendY = 40;

	displayData.forEach(([value, count], index) => {
		const color = colors[index % colors.length];

		// Draw color box
		ctx.fillStyle = color;
		ctx.lineWidth = 1;
		ctx.strokeRect(legendX, legendY, 15, 15);

		// Draw label
		ctx.fillStyle = 'var(--vscode-foreground)';
		ctx.font = '11px sans-serif';
		ctx.textAlign = 'left';
		ctx.textBaseline = 'top';

		const labelText = value.length > 25 ? value.substring(0, 22) + '...' : value;
		const percentage = ((count / total) * 100).toFixed(1);
		ctx.fillText(labelText + ' (' + percentage + '%)', legendX + 20, legendY + 2);

		legendY += 20;
	});
}

function showDistinctCountPicker(colIdx, boxId) {
	if (!window.currentResult || window.currentResult.boxId !== boxId) { return; }

	const columnName = window.currentResult.columns[colIdx];
	const modal = document.getElementById('columnAnalysisModal');
	const title = document.getElementById('columnAnalysisTitle');
	const body = document.getElementById('columnAnalysisBody');

	title.textContent = 'Distinct Count - ' + columnName;

	let html = '<div class="column-picker">';
	html += '<label>Count distinct values of:</label>';
	html += '<select id="distinctCountTargetColumn" onchange="calculateDistinctCount(' + colIdx + ', \'' + boxId + '\')">';
	html += '<option value="">Select a column...</option>';

	// Build sorted column list
	const sortedColumns = window.currentResult.columns
		.map((col, idx) => ({ col, idx }))
		.filter(item => item.idx !== colIdx)
		.sort((a, b) => a.col.localeCompare(b.col));

	sortedColumns.forEach(item => {
		html += '<option value="' + item.idx + '">' + item.col + '</option>';
	});

	html += '</select>';
	html += '</div>';
	html += '<div id="distinctCountResults"></div>';

	body.innerHTML = html;
	modal.classList.add('visible');
}

function calculateDistinctCount(groupByColIdx, boxId) {
	if (!window.currentResult || window.currentResult.boxId !== boxId) { return; }

	const targetColIdx = parseInt(document.getElementById('distinctCountTargetColumn').value);
	if (isNaN(targetColIdx)) { return; }

	const groupByColumnName = window.currentResult.columns[groupByColIdx];
	const targetColumnName = window.currentResult.columns[targetColIdx];

	// Map of groupBy value -> Set of target values
	const groupedValues = new Map();

	window.currentResult.rows.forEach(row => {
		const groupByCell = row[groupByColIdx];
		const targetCell = row[targetColIdx];

		let groupByValue;
		let targetValue;

		// Extract values
		if (typeof groupByCell === 'object' && groupByCell !== null && 'display' in groupByCell) {
			groupByValue = groupByCell.display;
		} else {
			groupByValue = String(groupByCell);
		}

		if (typeof targetCell === 'object' && targetCell !== null && 'display' in targetCell) {
			targetValue = targetCell.display;
		} else {
			targetValue = String(targetCell);
		}

		if (!groupedValues.has(groupByValue)) {
			groupedValues.set(groupByValue, new Set());
		}
		groupedValues.get(groupByValue).add(targetValue);
	});

	// Convert to array and sort by distinct count (descending)
	const results = Array.from(groupedValues.entries())
		.map(([groupValue, valueSet]) => ({
			groupValue,
			distinctCount: valueSet.size
		}))
		.sort((a, b) => b.distinctCount - a.distinctCount);

	// Calculate total distinct count across all groups
	const totalDistinctValues = new Set();
	groupedValues.forEach(valueSet => {
		valueSet.forEach(value => totalDistinctValues.add(value));
	});
	const totalDistinctCount = totalDistinctValues.size;

	// Display results
	const resultsDiv = document.getElementById('distinctCountResults');

	let html = '<table class="column-analysis-table">';
	html += '<thead><tr><th>' + escapeHtml(groupByColumnName) + '</th><th>Distinct ' + escapeHtml(targetColumnName) + '</th><th>%</th></tr></thead>';
	html += '<tbody>';

	results.forEach(result => {
		const percentage = ((result.distinctCount / totalDistinctCount) * 100).toFixed(2);
		html += '<tr><td>' + escapeHtml(result.groupValue) + '</td><td>' + result.distinctCount + '</td><td>' + percentage + '%</td></tr>';
	});

	// Add total row
	html += '<tr class="total-row"><td><strong>Total</strong></td><td><strong>' + totalDistinctCount + '</strong></td><td><strong>100.00%</strong></td></tr>';
	html += '</tbody></table>';

	resultsDiv.innerHTML = html;
}

function closeColumnAnalysis(event) {
	if (event && event.target !== event.currentTarget) {
		return;
	}

	const modal = document.getElementById('columnAnalysisModal');
	modal.classList.remove('visible');
}

// Close column menus when clicking outside
document.addEventListener('click', (event) => {
	if (!event.target.closest('.column-menu-btn')) {
		document.querySelectorAll('.column-menu').forEach(menu => {
			menu.classList.remove('visible');
		});
	}
});

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

// Add initial query box
addQueryBox();
*/