function setSchemaLoading(boxId, loading) {
	schemaFetchInFlightByBoxId[boxId] = !!loading;
	
	// Update the schema info icon - spinner is now handled via CSS ::after pseudo-element
	const infoBtn = document.getElementById(boxId + '_schema_info_btn');
	const infoStatus = document.getElementById(boxId + '_schema_info_status');
	const refreshBtn = document.getElementById(boxId + '_schema_info_refresh_btn');

	if (loading) {
		// Show spinner state on the info icon (CSS handles the actual spinner via ::after)
		if (infoBtn) infoBtn.classList.add('is-loading');
		if (infoStatus) infoStatus.textContent = 'Loading…';
		if (refreshBtn) refreshBtn.disabled = true;
	} else {
		// Remove spinner state
		if (infoBtn) infoBtn.classList.remove('is-loading');
		if (refreshBtn) refreshBtn.disabled = false;
	}

	// Legacy: Keep old element handling for backward compatibility during transition
	const el = document.getElementById(boxId + '_schema_status');
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

function setSchemaLoadedSummary(boxId, text, title, isError, meta) {
	// Update the new schema info popover
	const infoStatus = document.getElementById(boxId + '_schema_info_status');
	const tablesRow = document.getElementById(boxId + '_schema_info_tables_row');
	const tablesValue = document.getElementById(boxId + '_schema_info_tables');
	const colsRow = document.getElementById(boxId + '_schema_info_cols_row');
	const colsValue = document.getElementById(boxId + '_schema_info_cols');
	const cachedRow = document.getElementById(boxId + '_schema_info_cached_row');
	const infoBtn = document.getElementById(boxId + '_schema_info_btn');

	const hasText = !!text;
	
	if (hasText && meta) {
		const tablesCount = Number(meta.tablesCount);
		const columnsCount = Number(meta.columnsCount);
		const fromCache = !!meta.fromCache;

		// Update status
		if (infoStatus) {
			infoStatus.textContent = isError ? 'Error' : 'Loaded';
			infoStatus.classList.toggle('is-error', !!isError);
		}

		// Update tables count
		if (tablesRow && tablesValue) {
			tablesRow.style.display = 'flex';
			tablesValue.textContent = String(tablesCount >= 0 ? tablesCount : 0);
		}

		// Update columns count
		if (colsRow && colsValue) {
			colsRow.style.display = 'flex';
			colsValue.textContent = String(columnsCount >= 0 ? columnsCount : 0);
		}

		// Update cached indicator
		if (cachedRow) {
			cachedRow.style.display = fromCache ? 'flex' : 'none';
		}

		// Update button state for visual feedback
		if (infoBtn) {
			infoBtn.classList.toggle('has-schema', true);
			infoBtn.classList.toggle('is-error', !!isError);
			infoBtn.classList.toggle('is-cached', fromCache);
		}
	} else if (hasText) {
		// Error or simple text status
		if (infoStatus) {
			infoStatus.textContent = isError ? 'Error' : text;
			infoStatus.classList.toggle('is-error', !!isError);
		}
		if (tablesRow) tablesRow.style.display = 'none';
		if (colsRow) colsRow.style.display = 'none';
		if (cachedRow) cachedRow.style.display = 'none';
		if (infoBtn) {
			infoBtn.classList.toggle('has-schema', false);
			infoBtn.classList.toggle('is-error', !!isError);
			infoBtn.classList.toggle('is-cached', false);
		}
	} else {
		// No schema loaded
		if (infoStatus) {
			infoStatus.textContent = 'Not loaded';
			infoStatus.classList.remove('is-error');
		}
		if (tablesRow) tablesRow.style.display = 'none';
		if (colsRow) colsRow.style.display = 'none';
		if (cachedRow) cachedRow.style.display = 'none';
		if (infoBtn) {
			infoBtn.classList.remove('has-schema', 'is-error', 'is-cached');
		}
	}

	// Legacy: Keep old element handling for backward compatibility
	const el = document.getElementById(boxId + '_schema_loaded');
	if (!el) {
		return;
	}
	// Clear any prior content (we sometimes render a link).
	try {
		while (el.firstChild) {
			el.removeChild(el.firstChild);
		}
	} catch {
		// ignore
	}

	if (hasText && meta && meta.fromCache) {
		try {
			const tablesCount = Number(meta.tablesCount);
			const columnsCount = Number(meta.columnsCount);
			const prefix = document.createElement('span');
			prefix.textContent =
				(tablesCount >= 0 ? tablesCount : 0) + ' tables, ' + (columnsCount >= 0 ? columnsCount : 0) + ' cols';
			el.appendChild(prefix);

			const link = document.createElement('a');
			link.href = '#';
			link.className = 'schema-cached-link';
			link.textContent = '(cached)';
			link.title = 'Show cached values';
			link.addEventListener('click', (e) => {
				try {
					e.preventDefault();
					e.stopPropagation();
				} catch { /* ignore */ }
				try {
					vscode.postMessage({ type: 'seeCachedValues' });
				} catch { /* ignore */ }
			});
			el.appendChild(link);
		} catch {
			// Fallback: plain text
			el.textContent = text || '';
		}
	} else {
		el.textContent = text || '';
	}
	el.title = title || '';
	el.classList.toggle('error', !!isError);
	el.style.display = hasText ? 'inline-flex' : 'none';
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
	// Persist selection immediately so VS Code Problems can reflect current schema context.
	try {
		const connectionSelect = document.getElementById(boxId + '_connection');
		const databaseSelect = document.getElementById(boxId + '_database');
		const connectionId = connectionSelect ? connectionSelect.value : '';
		const database = databaseSelect ? databaseSelect.value : '';
		vscode.postMessage({
			type: 'saveLastSelection',
			connectionId: String(connectionId || ''),
			database: String(database || '')
		});
	} catch { /* ignore */ }
	ensureSchemaForBox(boxId, false);
	// Update monaco-kusto schema if we have a cached schema for the new database
	try {
		if (typeof window.__kustoUpdateSchemaForFocusedBox === 'function') {
			window.__kustoUpdateSchemaForFocusedBox(boxId);
		}
	} catch { /* ignore */ }
	try {
		if (typeof __kustoUpdateFavoritesUiForBox === 'function') {
			__kustoUpdateFavoritesUiForBox(boxId);
		} else if (window && typeof window.__kustoUpdateFavoritesUiForAllBoxes === 'function') {
			window.__kustoUpdateFavoritesUiForAllBoxes();
		}
	} catch { /* ignore */ }
	try {
		if (window && typeof window.__kustoUpdateRunEnabledForBox === 'function') {
			window.__kustoUpdateRunEnabledForBox(boxId);
		}
	} catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function refreshSchema(boxId) {
	if (!boxId) {
		return;
	}

	// Update new schema info UI
	try {
		const infoRefreshBtn = document.getElementById(boxId + '_schema_info_refresh_btn');
		if (infoRefreshBtn) {
			infoRefreshBtn.disabled = true;
		}
		// The spinner is now handled via CSS ::after pseudo-element on the button when .is-loading is added
		const infoBtn = document.getElementById(boxId + '_schema_info_btn');
		if (infoBtn) {
			infoBtn.classList.add('is-loading');
		}
		const infoStatus = document.getElementById(boxId + '_schema_info_status');
		if (infoStatus) {
			infoStatus.textContent = 'Refreshing…';
		}
	} catch { /* ignore */ }

	// Legacy: Update old schema refresh button if present
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
