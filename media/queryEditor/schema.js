function setSchemaLoading(boxId, loading) {
	schemaFetchInFlightByBoxId[boxId] = !!loading;
	const el = document.getElementById(boxId + '_schema_status');
	// We no longer show the separate inline "Schema…" spinner/label.
	if (el) {
		el.style.display = 'none';
	}

	const btn = document.getElementById(boxId + '_schema_refresh');
	if (!btn) {
		return;
	}

	const manual = !!(btn.dataset && btn.dataset.kustoRefreshSchemaInFlight === '1');
	const auto = !!(btn.dataset && btn.dataset.kustoSchemaAutoInFlight === '1');

	// While loading, show the in-place spinner in the refresh button (unless manual mode already did).
	if (loading) {
		if (!manual && !auto) {
			try {
				if (btn.dataset) {
					btn.dataset.kustoSchemaAutoInFlight = '1';
					btn.dataset.kustoAutoPrevHtml = String(btn.innerHTML || '');
					btn.dataset.kustoAutoPrevTitle = String(btn.title || '');
				}
				btn.innerHTML = '<span class="schema-spinner" aria-hidden="true"></span>';
				btn.setAttribute('aria-busy', 'true');
				btn.title = 'Loading schema…';
			} catch { /* ignore */ }
			btn.disabled = true;
		}
		return;
	}

	// On completion: restore manual button state if this was a manual refresh; otherwise restore auto.
	try {
		if (manual) {
			const prev = btn.dataset.kustoPrevHtml;
			if (typeof prev === 'string' && prev) {
				btn.innerHTML = prev;
			}
			try {
				const prevTitle = btn.dataset.kustoPrevTitle;
				if (typeof prevTitle === 'string') {
					btn.title = prevTitle;
				}
			} catch { /* ignore */ }
			try { delete btn.dataset.kustoPrevHtml; } catch { /* ignore */ }
			try { delete btn.dataset.kustoPrevTitle; } catch { /* ignore */ }
			try { delete btn.dataset.kustoRefreshSchemaInFlight; } catch { /* ignore */ }
			try { btn.removeAttribute('aria-busy'); } catch { /* ignore */ }
			btn.disabled = false;
			return;
		}
		if (auto) {
			const prev = btn.dataset.kustoAutoPrevHtml;
			if (typeof prev === 'string' && prev) {
				btn.innerHTML = prev;
			}
			try {
				const prevTitle = btn.dataset.kustoAutoPrevTitle;
				if (typeof prevTitle === 'string') {
					btn.title = prevTitle;
				}
			} catch { /* ignore */ }
			try { delete btn.dataset.kustoAutoPrevHtml; } catch { /* ignore */ }
			try { delete btn.dataset.kustoAutoPrevTitle; } catch { /* ignore */ }
			try { delete btn.dataset.kustoSchemaAutoInFlight; } catch { /* ignore */ }
			try { btn.removeAttribute('aria-busy'); } catch { /* ignore */ }
			btn.disabled = false;
		}
	} catch {
		// ignore
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

	let ownerId = boxId;
	try {
		if (window && typeof window.__kustoGetSelectionOwnerBoxId === 'function') {
			ownerId = window.__kustoGetSelectionOwnerBoxId(boxId) || boxId;
		}
	} catch { /* ignore */ }
	const connectionSelect = document.getElementById(ownerId + '_connection');
	const databaseSelect = document.getElementById(ownerId + '_database');
	const connectionId = connectionSelect ? connectionSelect.value : '';
	const database = databaseSelect ? databaseSelect.value : '';
	if (!connectionId || !database) {
		return;
	}

	setSchemaLoading(boxId, true);
	let requestToken = '';
	try {
		if (!window.__kustoSchemaRequestTokenByBoxId || typeof window.__kustoSchemaRequestTokenByBoxId !== 'object') {
			window.__kustoSchemaRequestTokenByBoxId = {};
		}
		requestToken = 'schema_' + Date.now() + '_' + Math.random().toString(16).slice(2);
		window.__kustoSchemaRequestTokenByBoxId[boxId] = requestToken;
	} catch { /* ignore */ }
	vscode.postMessage({
		type: 'prefetchSchema',
		connectionId,
		database,
		boxId,
		forceRefresh: !!forceRefresh,
		requestToken
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
		let clusterKey = '';
		try {
			const conn = Array.isArray(connections) ? connections.find(c => c && String(c.id || '').trim() === cid) : null;
			const clusterUrl = conn && conn.clusterUrl ? String(conn.clusterUrl) : '';
			if (clusterUrl) {
				let u = clusterUrl;
				if (!/^https?:\/\//i.test(u)) {
					u = 'https://' + u;
				}
				try {
					clusterKey = String(new URL(u).hostname || '').trim().toLowerCase();
				} catch {
					clusterKey = String(clusterUrl || '').trim().toLowerCase();
				}
			}
		} catch { /* ignore */ }

		const cachedByCluster = cachedDatabases && cachedDatabases[String(clusterKey || '').trim()];
		if (!forceRefresh && Array.isArray(cachedByCluster) && cachedByCluster.length) {
			return cachedByCluster;
		}

		// Legacy fallback (pre per-cluster cache): allow reading by connectionId.
		const cachedByConnectionId = cachedDatabases && cachedDatabases[cid];
		if (!forceRefresh && Array.isArray(cachedByConnectionId) && cachedByConnectionId.length) {
			return cachedByConnectionId;
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
	// Clear request throttling/in-flight so we can fetch immediately for the new DB.
	try {
		if (schemaFetchInFlightByBoxId) {
			schemaFetchInFlightByBoxId[boxId] = false;
		}
		if (lastSchemaRequestAtByBoxId) {
			lastSchemaRequestAtByBoxId[boxId] = 0;
		}
		if (window && window.__kustoSchemaRequestTokenByBoxId) {
			delete window.__kustoSchemaRequestTokenByBoxId[boxId];
		}
	} catch { /* ignore */ }
	setSchemaLoadedSummary(boxId, '', '', false);
	ensureSchemaForBox(boxId, false);
	try {
		if (typeof __kustoUpdateFavoritesUiForBox === 'function') {
			__kustoUpdateFavoritesUiForBox(boxId);
		} else if (window && typeof window.__kustoUpdateFavoritesUiForAllBoxes === 'function') {
			window.__kustoUpdateFavoritesUiForAllBoxes();
		}
	} catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function refreshSchema(boxId) {
	if (!boxId) {
		return;
	}
	try {
		const btn = document.getElementById(boxId + '_schema_refresh');
		if (btn) {
			if (btn.dataset && btn.dataset.kustoRefreshSchemaInFlight === '1') {
				return;
			}
			try {
				if (btn.dataset) {
					btn.dataset.kustoRefreshSchemaInFlight = '1';
					btn.dataset.kustoPrevHtml = String(btn.innerHTML || '');
					btn.dataset.kustoPrevTitle = String(btn.title || '');
				}
				btn.innerHTML = '<span class="schema-spinner" aria-hidden="true"></span>';
				btn.setAttribute('aria-busy', 'true');
				btn.title = 'Refreshing schema…';
			} catch { /* ignore */ }
			btn.disabled = true;
		}
	} catch {
		// ignore
	}
	// Hide the separate inline "Schema…" loading label while the refresh button is acting as the spinner.
	// This also covers the case where a schema fetch was already in-flight before the click.
	try {
		const el = document.getElementById(boxId + '_schema_status');
		if (el) {
			el.style.display = 'none';
		}
	} catch {
		// ignore
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
