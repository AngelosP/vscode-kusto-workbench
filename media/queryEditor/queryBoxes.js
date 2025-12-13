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
