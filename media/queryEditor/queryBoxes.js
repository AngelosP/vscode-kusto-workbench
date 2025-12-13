function addQueryBox() {
	const id = 'query_' + Date.now();
	queryBoxes.push(id);

	const container = document.getElementById('queries-container');
	const toolbarHtml =
		'<div class="query-editor-toolbar" role="toolbar" aria-label="Editor tools">' +
		'<button type="button" class="query-editor-toolbar-btn" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'qualifyTables\')" title="Fully qualify tables\nEnsures table references are fully qualified as cluster(\'...\').database(\'...\').Table">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2 2h12v3H2V2zm0 4h12v3H2V6zm0 4h7v3H2v-3zm8 0h4v3h-4v-3z"/></svg>' +
		'</span>' +
		'</button>' +
		'<span class="query-editor-toolbar-sep" aria-hidden="true"></span>' +
		'<button type="button" class="query-editor-toolbar-btn" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'doubleToSingle\')" title="Replace \" with \'\nReplaces all double quotes with single quotes">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3 3h4v4H3V3zm6 6h4v4H9V9z"/><path d="M7.5 7.5l1 1-1 1-1-1 1-1z"/></svg>' +
		'</span>' +
		'</button>' +
		'<button type="button" class="query-editor-toolbar-btn" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'singleToDouble\')" title="Replace \' with \"\nReplaces all single quotes with double quotes">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3 9h4v4H3V9zm6-6h4v4H9V3z"/><path d="M7.5 7.5l1 1-1 1-1-1 1-1z"/></svg>' +
		'</span>' +
		'</button>' +
		'<span class="query-editor-toolbar-sep" aria-hidden="true"></span>' +
		'<button type="button" class="query-editor-toolbar-btn" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'exportPowerBI\')" title="Export to Power BI\nWraps the query in Power Query (M) using AzureDataExplorer.Contents(...)">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2 3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3zm9 2h2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-2V5z"/></svg>' +
		'</span>' +
		'</button>' +
		'<button type="button" class="query-editor-toolbar-btn" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'format\')" title="Format code\nReformats the entire query">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2 3h12v2H2V3zm0 4h8v2H2V7zm0 4h12v2H2v-2z"/></svg>' +
		'</span>' +
		'</button>' +
		'<span class="query-editor-toolbar-sep" aria-hidden="true"></span>' +
		'<button type="button" class="query-editor-toolbar-btn" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'search\')" title="Search\nFind in the current query">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M6.5 2a4.5 4.5 0 1 1 2.78 8.04l3.09 3.09-1.06 1.06-3.09-3.09A4.5 4.5 0 0 1 6.5 2zm0 1.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>' +
		'</span>' +
		'</button>' +
		'<button type="button" class="query-editor-toolbar-btn" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'replace\')" title="Search and replace\nFind and replace in the current query">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3 3h7v2H3V3zm0 4h10v2H3V7zm0 4h6v2H3v-2z"/><path d="M12.5 2.5l1 1-2.5 2.5-1-1 2.5-2.5zM9 6l1 1-1 1-1-1 1-1z"/></svg>' +
		'</span>' +
		'</button>' +
		'</div>';
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
		toolbarHtml +
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

function onQueryEditorToolbarAction(boxId, action) {
	// Focus the editor so Monaco widgets (find/replace) attach correctly.
	try {
		activeQueryEditorBoxId = boxId;
		if (queryEditors[boxId]) {
			queryEditors[boxId].focus();
		}
	} catch {
		// ignore
	}

	if (action === 'search') {
		return runMonacoAction(boxId, 'actions.find');
	}
	if (action === 'replace') {
		return runMonacoAction(boxId, 'editor.action.startFindReplaceAction');
	}
	if (action === 'format') {
		return runMonacoAction(boxId, 'editor.action.formatDocument');
	}
	if (action === 'doubleToSingle') {
		return replaceAllInEditor(boxId, '"', "'");
	}
	if (action === 'singleToDouble') {
		return replaceAllInEditor(boxId, "'", '"');
	}
	if (action === 'exportPowerBI') {
		return exportQueryToPowerBI(boxId);
	}
	if (action === 'qualifyTables') {
		return fullyQualifyTablesInEditor(boxId);
	}
}

function runMonacoAction(boxId, actionId) {
	const editor = queryEditors[boxId];
	if (!editor) {
		return;
	}
	try {
		const action = editor.getAction(actionId);
		if (action && typeof action.run === 'function') {
			action.run();
			return;
		}
	} catch {
		// ignore
	}
}

function replaceAllInEditor(boxId, from, to) {
	const editor = queryEditors[boxId];
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	if (!model) {
		return;
	}
	const value = model.getValue();
	if (!value) {
		return;
	}
	const next = value.split(from).join(to);
	if (next === value) {
		return;
	}
	try {
		editor.executeEdits('toolbar', [{ range: model.getFullModelRange(), text: next }]);
		editor.focus();
	} catch {
		// ignore
	}
}

function exportQueryToPowerBI(boxId) {
	const editor = queryEditors[boxId];
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	if (!model) {
		return;
	}
	const query = model.getValue() || '';
	const connectionId = (document.getElementById(boxId + '_connection') || {}).value || '';
	const database = (document.getElementById(boxId + '_database') || {}).value || '';
	if (!connectionId) {
		alert('Please select a cluster connection');
		return;
	}
	if (!database) {
		alert('Please select a database');
		return;
	}
	const conn = (connections || []).find(c => c && c.id === connectionId);
	const clusterUrl = conn ? (conn.clusterUrl || '') : '';
	if (!clusterUrl) {
		alert('Selected connection is missing a cluster URL');
		return;
	}

	const lines = (query || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
	const escapeMString = (s) => String(s).replace(/"/g, '""');
	const quotedLines = lines.map(l => '        "' + escapeMString(l) + '"');
	const m =
		'let\n' +
		'    Query = Text.Combine({\n' +
		quotedLines.join(',\n') +
		'\n    }, "#(lf)"),\n' +
		'    Source = AzureDataExplorer.Contents("' + escapeMString(clusterUrl) + '", "' + escapeMString(database) + '", Query)\n' +
		'in\n' +
		'    Source';

	try {
		editor.executeEdits('toolbar', [{ range: model.getFullModelRange(), text: m }]);
		editor.focus();
	} catch {
		// ignore
	}
}

function fullyQualifyTablesInEditor(boxId) {
	const editor = queryEditors[boxId];
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	if (!model) {
		return;
	}
	const connectionId = (document.getElementById(boxId + '_connection') || {}).value || '';
	const database = (document.getElementById(boxId + '_database') || {}).value || '';
	if (!connectionId) {
		alert('Please select a cluster connection');
		return;
	}
	if (!database) {
		alert('Please select a database');
		return;
	}
	const conn = (connections || []).find(c => c && c.id === connectionId);
	const clusterUrl = conn ? (conn.clusterUrl || '') : '';
	if (!clusterUrl) {
		alert('Selected connection is missing a cluster URL');
		return;
	}

	const schema = schemaByBoxId ? schemaByBoxId[boxId] : null;
	const tableList = schema && Array.isArray(schema.tables) ? schema.tables : null;
	if (!tableList || tableList.length === 0) {
		// Best-effort: request schema fetch and ask the user to retry.
		try { ensureSchemaForBox(boxId); } catch { /* ignore */ }
		alert('Schema not loaded yet. Wait for “Schema loaded” then try again.');
		return;
	}

	const text = model.getValue() || '';
	const next = qualifyTablesInText(text, tableList, clusterUrl, database);
	if (next === text) {
		return;
	}
	try {
		editor.executeEdits('toolbar', [{ range: model.getFullModelRange(), text: next }]);
		editor.focus();
	} catch {
		// ignore
	}
}

function qualifyTablesInText(text, tables, clusterUrl, database) {
	const isIdentChar = (ch) => /[A-Za-z0-9_\-]/.test(ch);
	const set = new Set((tables || []).map(t => String(t)));
	const skipNames = new Set();

	// Very small lexer to detect let bindings and skip qualifying those names.
	const tokens = [];
	{
		let i = 0;
		let inS = false;
		let inLineComment = false;
		let inBlockComment = false;
		while (i < text.length) {
			const ch = text[i];
			const next = text[i + 1];
			if (inLineComment) {
				if (ch === '\n') inLineComment = false;
				i++;
				continue;
			}
			if (inBlockComment) {
				if (ch === '*' && next === '/') {
					inBlockComment = false;
					i += 2;
					continue;
				}
				i++;
				continue;
			}
			if (inS) {
				if (ch === "'") {
					inS = false;
				}
				i++;
				continue;
			}
			if (ch === '/' && next === '/') {
				inLineComment = true;
				i += 2;
				continue;
			}
			if (ch === '/' && next === '*') {
				inBlockComment = true;
				i += 2;
				continue;
			}
			if (ch === "'") {
				inS = true;
				i++;
				continue;
			}
			if ((ch === '_' || /[A-Za-z]/.test(ch)) && !inS) {
				let j = i + 1;
				while (j < text.length && isIdentChar(text[j])) j++;
				const value = text.slice(i, j);
				tokens.push({ value, start: i, end: j });
				i = j;
				continue;
			}
			i++;
		}
	}

	for (let idx = 0; idx < tokens.length; idx++) {
		const t = tokens[idx];
		if (!t || String(t.value).toLowerCase() !== 'let') {
			continue;
		}
		const nameTok = tokens[idx + 1];
		if (!nameTok) continue;
		// If the next non-ws char after the identifier is '=', treat it as a let binding.
		let k = nameTok.end;
		while (k < text.length && /\s/.test(text[k])) k++;
		if (text[k] === '=') {
			skipNames.add(nameTok.value);
		}
	}

	const replacements = [];
	for (const tok of tokens) {
		if (!set.has(tok.value)) {
			continue;
		}
		if (skipNames.has(tok.value)) {
			continue;
		}
		// Skip if already qualified (immediate '.' before name).
		let p = tok.start - 1;
		while (p >= 0 && text[p] === ' ') p--;
		if (p >= 0 && text[p] === '.') {
			continue;
		}
		// Skip if this looks like a function call.
		let a = tok.end;
		while (a < text.length && text[a] === ' ') a++;
		if (text[a] === '(') {
			continue;
		}
		replacements.push({ start: tok.start, end: tok.end, value: tok.value });
	}

	if (replacements.length === 0) {
		return text;
	}

	// Apply from end to start.
	let out = text;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const r = replacements[i];
		const fq = "cluster('" + clusterUrl + "').database('" + database + "')." + r.value;
		out = out.slice(0, r.start) + fq + out.slice(r.end);
	}
	return out;
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
