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

// Request database list for an arbitrary connectionId.
// Uses the existing getDatabases/refreshDatabases message channel, but with a synthetic boxId.
window.__kustoRequestDatabases = async function (connectionId, forceRefresh) {
	const cid = String(connectionId || '').trim();
	if (!cid) {
		return [];
	}
	try {
		const cached = cachedDatabases && cachedDatabases[cid];
		if (!forceRefresh && Array.isArray(cached) && cached.length) {
			return cached;
		}
	} catch {
		// ignore
	}

	const requestId = '__kusto_dbreq__' + encodeURIComponent(cid) + '__' + Date.now() + '_' + Math.random().toString(16).slice(2);
	return await new Promise((resolve, reject) => {
		try {
			if (!databasesRequestResolversByBoxId || typeof databasesRequestResolversByBoxId !== 'object') {
				databasesRequestResolversByBoxId = {};
			}
			databasesRequestResolversByBoxId[requestId] = { resolve, reject };
		} catch {
			// If we can't stash a resolver, just resolve empty.
			resolve([]);
			return;
		}

		try {
			vscode.postMessage({
				type: forceRefresh ? 'refreshDatabases' : 'getDatabases',
				connectionId: cid,
				boxId: requestId
			});
		} catch (e) {
			try { delete databasesRequestResolversByBoxId[requestId]; } catch { /* ignore */ }
			reject(e);
		}
	});
};

function onDatabaseChanged(boxId) {
	// Clear any prior schema so it matches the newly selected DB.
	delete schemaByBoxId[boxId];
	setSchemaLoadedSummary(boxId, '', '', false);
	ensureSchemaForBox(boxId, false);
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function refreshSchema(boxId) {
	if (!boxId) {
		return;
	}
	// Force a refetch even if we fetched recently, but keep existing schema/summary
	// so a transient connectivity failure doesn't wipe the UI.
	lastSchemaRequestAtByBoxId[boxId] = 0;
	ensureSchemaForBox(boxId, true);
}

// Request schema for an arbitrary (connectionId, database) pair.
// Used by tools that need to resolve table names across DBs/clusters.
async function __kustoRequestSchema(connectionId, database, forceRefresh) {
	try {
		const cid = String(connectionId || '').trim();
		const db = String(database || '').trim();
		if (!cid || !db) {
			return null;
		}
		const key = cid + '|' + db;
		try {
			if (!forceRefresh && schemaByConnDb && schemaByConnDb[key]) {
				return schemaByConnDb[key];
			}
		} catch { /* ignore */ }

		const reqBoxId = '__schema_req__' + Date.now() + '_' + Math.random().toString(16).slice(2);
		const p = new Promise((resolve, reject) => {
			try {
				schemaRequestResolversByBoxId[reqBoxId] = { resolve, reject, key };
			} catch (e) {
				reject(e);
			}
		});
		try {
			vscode.postMessage({
				type: 'prefetchSchema',
				connectionId: cid,
				database: db,
				boxId: reqBoxId,
				forceRefresh: !!forceRefresh
			});
		} catch (e) {
			try { delete schemaRequestResolversByBoxId[reqBoxId]; } catch { /* ignore */ }
			throw e;
		}
		return await p;
	} catch {
		return null;
	}
}

try {
	window.__kustoRequestSchema = __kustoRequestSchema;
} catch {
	// ignore
}
