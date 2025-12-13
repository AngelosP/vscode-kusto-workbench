function setSchemaLoading(boxId, loading) {
	schemaFetchInFlightByBoxId[boxId] = !!loading;
	const el = document.getElementById(boxId + '_schema_status');
	if (el) {
		el.style.display = loading ? 'inline-flex' : 'none';
	}
}

function setSchemaLoadedSummary(boxId, text, title, isError) {
	const el = document.getElementById(boxId + '_schema_loaded');
	if (!el) {
		return;
	}
	el.textContent = text || '';
	el.title = title || '';
	el.classList.toggle('error', !!isError);
	el.style.display = text ? 'inline-flex' : 'none';
}

function ensureSchemaForBox(boxId, forceRefresh) {
	if (!boxId) {
		return;
	}
	if (!forceRefresh && schemaByBoxId[boxId]) {
		return;
	}
	if (schemaFetchInFlightByBoxId[boxId]) {
		return;
	}
	const now = Date.now();
	const last = lastSchemaRequestAtByBoxId[boxId] || 0;
	// Avoid spamming schema fetch requests if autocomplete is invoked repeatedly.
	if (!forceRefresh && now - last < 1500) {
		return;
	}
	lastSchemaRequestAtByBoxId[boxId] = now;

	const connectionSelect = document.getElementById(boxId + '_connection');
	const databaseSelect = document.getElementById(boxId + '_database');
	const connectionId = connectionSelect ? connectionSelect.value : '';
	const database = databaseSelect ? databaseSelect.value : '';
	if (!connectionId || !database) {
		return;
	}

	setSchemaLoading(boxId, true);
	vscode.postMessage({
		type: 'prefetchSchema',
		connectionId,
		database,
		boxId,
		forceRefresh: !!forceRefresh
	});
}

function onDatabaseChanged(boxId) {
	// Clear any prior schema so it matches the newly selected DB.
	delete schemaByBoxId[boxId];
	setSchemaLoadedSummary(boxId, '', '', false);
	ensureSchemaForBox(boxId, false);
}

function refreshSchema(boxId) {
	if (!boxId) {
		return;
	}
	// Force a refetch even if we fetched recently.
	delete schemaByBoxId[boxId];
	lastSchemaRequestAtByBoxId[boxId] = 0;
	setSchemaLoadedSummary(boxId, '', '', false);
	ensureSchemaForBox(boxId, true);
}
