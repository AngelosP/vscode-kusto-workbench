// Connection/database picker wiring, cluster URL helpers, favorites, missing clusters,
// XML import — extracted from queryBoxes.ts
// Window bridge exports at bottom for remaining legacy callers.
export {};

const _win = window as unknown as Record<string, any>;

function formatClusterDisplayName( connection: any) {
	if (!connection) {
		return '';
	}
	const url = String(connection.clusterUrl || '').trim();
	if (url) {
		try {
			const u = new URL(url);
			const hostname = String(u.hostname || '').trim();
			const lower = hostname.toLowerCase();
			if (lower.endsWith('.kusto.windows.net')) {
				return hostname.slice(0, hostname.length - '.kusto.windows.net'.length);
			}
			return hostname || url;
		} catch {
			// ignore
		}
	}
	return String(connection.name || connection.clusterUrl || '').trim();
}

function normalizeClusterUrlKey( url: any) {
	try {
		const raw = String(url || '').trim();
		if (!raw) return '';
		const withScheme = /^https?:\/\//i.test(raw) ? raw : ('https://' + raw.replace(/^\/+/, ''));
		const u = new URL(withScheme);
		return (u.origin + u.pathname).replace(/\/+$/, '').toLowerCase();
	} catch {
		return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
	}
}

function formatClusterShortName( clusterUrl: any) {
	const raw = String(clusterUrl || '').trim();
	if (!raw) {
		return '';
	}
	try {
		const withScheme = /^https?:\/\//i.test(raw) ? raw : ('https://' + raw.replace(/^\/+/, ''));
		const u = new URL(withScheme);
		const host = String(u.hostname || '').trim();
		if (!host) {
			return raw;
		}
		const first = host.split('.')[0];
		return first || host;
	} catch {
		// Fall back to a best-effort host extraction
		const m = raw.match(/([a-z0-9-]+)(?:\.[a-z0-9.-]+)+/i);
		if (m && m[1]) {
			return m[1];
		}
		return raw;
	}
}

function clusterShortNameKey( clusterUrl: any) {
	try {
		return String(formatClusterShortName(clusterUrl) || '').trim().toLowerCase();
	} catch {
		return String(clusterUrl || '').trim().toLowerCase();
	}
}

function extractClusterUrlsFromQueryText( queryText: any) {
	const text = String(queryText || '');
	if (!text) {
		return [];
	}
	// Primary pattern: cluster('https://...') or cluster("...")
	const urls = [];
	try {
		const re = /\bcluster\s*\(\s*(['"])([^'"\r\n]+?)\1\s*\)/ig;
		let m;
		while ((m = re.exec(text)) !== null) {
			const u = String(m[2] || '').trim();
			if (u) urls.push(u);
		}
	} catch {
		// ignore
	}
	// Unique by cluster short-name key (case-insensitive)
	const seen = new Set();
	const out = [];
	for (const u of urls) {
		const key = clusterShortNameKey(u);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(u);
	}
	return out;
}

function extractClusterDatabaseHintsFromQueryText( queryText: any) {
	const text = String(queryText || '');
	const map: any = {};
	if (!text) {
		return map;
	}
	// Pattern: cluster('...').database('...') (case-insensitive, with whitespace)
	try {
		const re = /\bcluster\s*\(\s*(['"])([^'"\r\n]+?)\1\s*\)\s*\.\s*database\s*\(\s*(['"])([^'"\r\n]+?)\3\s*\)/ig;
		let m;
		while ((m = re.exec(text)) !== null) {
			const clusterUrl = String(m[2] || '').trim();
			const database = String(m[4] || '').trim();
			if (!clusterUrl || !database) continue;
			const key = clusterShortNameKey(clusterUrl);
			if (!key) continue;
			if (!map[key]) {
				map[key] = database;
			}
		}
	} catch {
		// ignore
	}
	return map;
}

function computeMissingClusterUrls( detectedClusterUrls: any) {
	const detected = Array.isArray(detectedClusterUrls) ? detectedClusterUrls : [];
	if (!detected.length) {
		return [];
	}
	const existingKeys = new Set();
	try {
		for (const c of (_win.connections || [])) {
			if (!c) continue;
			const key = clusterShortNameKey(c.clusterUrl || '');
			if (key) existingKeys.add(key);
		}
	} catch {
		// ignore
	}
	const missing = [];
	for (const u of detected) {
		const key = clusterShortNameKey(u);
		if (!key) continue;
		if (!existingKeys.has(key)) {
			missing.push(u);
		}
	}
	return missing;
}

function renderMissingClustersBanner( boxId: any, missingClusterUrls: any) {
	const banner = document.getElementById(boxId + '_missing_clusters') as any;
	const textEl = document.getElementById(boxId + '_missing_clusters_text') as any;
	if (!banner || !textEl) {
		return;
	}
	const missing = Array.isArray(missingClusterUrls) ? missingClusterUrls : [];
	if (!missing.length) {
		banner.style.display = 'none';
		textEl.innerHTML = '';
		return;
	}
	const shortNames = missing
		.map((u: any) => formatClusterShortName(u))
		.filter(Boolean);
	const label = shortNames.length
		? ('Detected clusters not in your connections: <strong>' + _win.escapeHtml(shortNames.join(', ')) + '</strong>.')
		: 'Detected clusters not in your connections.';
	textEl.innerHTML = label + ' Add them with one click.';
	banner.style.display = 'flex';
}

function updateMissingClustersForBox( boxId: any, queryText: any) {
	try {
		_win.lastQueryTextByBoxId[boxId] = String(queryText || '');
	} catch { /* ignore */ }
	try {
		_win.suggestedDatabaseByClusterKeyByBoxId[boxId] = extractClusterDatabaseHintsFromQueryText(queryText);
	} catch { /* ignore */ }
	const detected = extractClusterUrlsFromQueryText(queryText);
	const missing = computeMissingClusterUrls(detected);
	try { _win.missingClusterUrlsByBoxId[boxId] = missing; } catch { /* ignore */ }
	renderMissingClustersBanner(boxId, missing);
}

// Called by Monaco (media/queryEditor/monaco.js) on content changes.
(window as any).__kustoOnQueryValueChanged = function (boxId: any, queryText: any) {
	const id = String(boxId || '').trim();
	if (!id) {
		return;
	}
	try { _win.lastQueryTextByBoxId[id] = String(queryText || ''); } catch { /* ignore */ }
	try {
		if (_win.missingClusterDetectTimersByBoxId[id]) {
			clearTimeout(_win.missingClusterDetectTimersByBoxId[id]);
		}
		_win.missingClusterDetectTimersByBoxId[id] = setTimeout(() => {
			try { updateMissingClustersForBox(id, _win.lastQueryTextByBoxId[id] || ''); } catch { /* ignore */ }
		}, 260);
	} catch {
		// ignore
	}
};

// Called by main.js when the connections list changes.
(window as any).__kustoOnConnectionsUpdated = function () {
	try {
		for (const id of (_win.queryBoxes || [])) {
			updateMissingClustersForBox(id, _win.lastQueryTextByBoxId[id] || '');
		}
	} catch {
		// ignore
	}
	// Apply any pending favorite selections now that connections may exist.
	try {
		for (const id of (_win.queryBoxes || [])) {
			try {
				if (_win.pendingFavoriteSelectionByBoxId && _win.pendingFavoriteSelectionByBoxId[id]) {
					__kustoTryApplyPendingFavoriteSelectionForBox(id);
				}
			} catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
	try {
		if (typeof (window as any).__kustoUpdateFavoritesUiForAllBoxes === 'function') {
			(window as any).__kustoUpdateFavoritesUiForAllBoxes();
		}
	} catch { /* ignore */ }
};

function __kustoFavoriteKey( clusterUrl: any, database: any) {
	const c = normalizeClusterUrlKey(String(clusterUrl || '').trim());
	const d = String(database || '').trim().toLowerCase();
	return c + '|' + d;
}

function __kustoGetCurrentClusterUrlForBox( boxId: any) {
	return _win.__kustoGetClusterUrl(boxId);
}

function __kustoGetCurrentDatabaseForBox( boxId: any) {
	return _win.__kustoGetDatabase(boxId);
}

function __kustoFindFavorite( clusterUrl: any, database: any) {
	const key = __kustoFavoriteKey(clusterUrl, database);
	const list = Array.isArray(_win.kustoFavorites) ? _win.kustoFavorites : [];
	for (const f of list) {
		if (!f) continue;
		const fk = __kustoFavoriteKey(f.clusterUrl, f.database);
		if (fk === key) return f;
	}
	return null;
}

function __kustoGetFavoritesSorted() {
	const list = (Array.isArray(_win.kustoFavorites) ? _win.kustoFavorites : []).slice();
	list.sort((a: any, b: any) => {
		const an = String((a && a.name) || '').toLowerCase();
		const bn = String((b && b.name) || '').toLowerCase();
		return an.localeCompare(bn);
	});
	return list;
}

// Auto-enter Favorites mode when restoring a .kqlx selection that matches an existing favorite.
// This is intended to run only for boxes restored from disk, not for arbitrary user selections.
let __kustoAutoEnterFavoritesByBoxId = Object.create(null);

// For newly-added sections (not restore): if the prefilled cluster+db matches an existing
// favorite, switch that box into Favorites mode.
let __kustoAutoEnterFavoritesForNewBoxByBoxId = Object.create(null);

function __kustoMarkNewBoxForFavoritesAutoEnter( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	try {
		// Never treat restore-created boxes as "new".
		if (typeof _win.__kustoRestoreInProgress === 'boolean' && _win.__kustoRestoreInProgress) {
			return;
		}
	} catch { /* ignore */ }
	try {
		__kustoAutoEnterFavoritesForNewBoxByBoxId = __kustoAutoEnterFavoritesForNewBoxByBoxId || Object.create(null);
		__kustoAutoEnterFavoritesForNewBoxByBoxId[id] = true;
	} catch { /* ignore */ }
}

function __kustoTryAutoEnterFavoritesModeForNewBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	let pending = false;
	try {
		pending = !!(__kustoAutoEnterFavoritesForNewBoxByBoxId && __kustoAutoEnterFavoritesForNewBoxByBoxId[id]);
	} catch { pending = false; }
	if (!pending) return;

	// Don't override an explicit choice for this box.
	try {
		if (_win.favoritesModeByBoxId && Object.prototype.hasOwnProperty.call(_win.favoritesModeByBoxId, id)) {
			try { delete __kustoAutoEnterFavoritesForNewBoxByBoxId[id]; } catch { /* ignore */ }
			return;
		}
	} catch { /* ignore */ }

	// Wait until favorites are available.
	const hasAny = Array.isArray(_win.kustoFavorites) && _win.kustoFavorites.length > 0;
	if (!hasAny) return;

	const clusterUrl = __kustoGetCurrentClusterUrlForBox(id);
	const db = __kustoGetCurrentDatabaseForBox(id);
	if (!clusterUrl || !db) return;

	const fav = __kustoFindFavorite(clusterUrl, db);
	try {
		if (fav) {
			__kustoApplyFavoritesMode(id, true);
			__kustoUpdateFavoritesUiForBox(id);
		}
	} catch { /* ignore */ }
	// Either way, we've reached a stable selection; only do this once.
	try { delete __kustoAutoEnterFavoritesForNewBoxByBoxId[id]; } catch { /* ignore */ }
}

(window as any).__kustoSetAutoEnterFavoritesForBox = function (boxId: any, clusterUrl: any, database: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const c = String(clusterUrl || '').trim();
	const d = String(database || '').trim();
	if (!c || !d) return;
	try {
		__kustoAutoEnterFavoritesByBoxId = __kustoAutoEnterFavoritesByBoxId || Object.create(null);
		__kustoAutoEnterFavoritesByBoxId[id] = { clusterUrl: c, database: d };
	} catch { /* ignore */ }
};

function __kustoTryAutoEnterFavoritesModeForBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	let desired = null;
	try {
		desired = __kustoAutoEnterFavoritesByBoxId && __kustoAutoEnterFavoritesByBoxId[id]
			? __kustoAutoEnterFavoritesByBoxId[id]
			: null;
	} catch { desired = null; }
	if (!desired) return;

	// Wait until favorites are available.
	const hasAny = Array.isArray(_win.kustoFavorites) && _win.kustoFavorites.length > 0;
	if (!hasAny) return;

	const fav = __kustoFindFavorite(desired.clusterUrl, desired.database);
	if (!fav) {
		// No matching favorite — ensure we're NOT in favorites mode so the
		// cluster/database dropdowns are visible and the user can see the connection.
		try {
			const isInFavMode = !!(_win.favoritesModeByBoxId && _win.favoritesModeByBoxId[id]);
			if (isInFavMode) {
				__kustoApplyFavoritesMode(id, false);
			}
		} catch { /* ignore */ }
		try { delete __kustoAutoEnterFavoritesByBoxId[id]; } catch { /* ignore */ }
		return;
	}

	try { __kustoApplyFavoritesMode(id, true); } catch { /* ignore */ }
	try { delete __kustoAutoEnterFavoritesByBoxId[id]; } catch { /* ignore */ }
}

(window as any).__kustoTryAutoEnterFavoritesModeForAllBoxes = function () {
	try {
		for (const id of (_win.queryBoxes || [])) {
			try { __kustoTryAutoEnterFavoritesModeForBox(id); } catch { /* ignore */ }
			try { __kustoTryAutoEnterFavoritesModeForNewBox(id); } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
};

// Default behavior for blank/new docs: if the user has any favorites, start the first
// section in Favorites mode. If they have no favorites, keep the normal cluster/db selects.
let __kustoDidDefaultFirstBoxToFavorites = false;

(window as any).__kustoMaybeDefaultFirstBoxToFavoritesMode = function () {
	try {
		if (__kustoDidDefaultFirstBoxToFavorites) return;
		const hasAny = Array.isArray(_win.kustoFavorites) && _win.kustoFavorites.length > 0;
		if (!hasAny) return;
		if (!Array.isArray(_win.queryBoxes) || _win.queryBoxes.length !== 1) return;
		const id = String(_win.queryBoxes[0] || '').trim();
		if (!id) return;

		// Don't override an explicit/restored setting for this box.
		try {
			if (_win.favoritesModeByBoxId && Object.prototype.hasOwnProperty.call(_win.favoritesModeByBoxId, id)) {
				return;
			}
		} catch { /* ignore */ }

		// If the box has a stashed desired connection that doesn't match any favorite,
		// don't enter favorites mode — let the cluster/database dropdowns show instead.
		try {
			let desiredCluster = '';
			let desiredDb = '';
			const pending = __kustoAutoEnterFavoritesByBoxId && __kustoAutoEnterFavoritesByBoxId[id];
			if (pending) {
				desiredCluster = pending.clusterUrl || '';
				desiredDb = pending.database || '';
			}
			if (!desiredCluster) {
				const kwEl = _win.__kustoGetQuerySectionElement(id);
				desiredCluster = kwEl ? _win.__kustoGetClusterUrl(id) : '';
			}
			if (!desiredDb) {
				desiredDb = _win.__kustoGetDatabase(id);
			}
			if (desiredCluster && desiredDb) {
				const fav = __kustoFindFavorite(desiredCluster, desiredDb);
				if (!fav) {
					// Connection exists but no matching favorite — skip favorites mode.
					__kustoDidDefaultFirstBoxToFavorites = true;
					return;
				}
			}
		} catch { /* ignore */ }

		__kustoApplyFavoritesMode(id, true);
		try { __kustoUpdateFavoritesUiForBox(id); } catch { /* ignore */ }
		__kustoDidDefaultFirstBoxToFavorites = true;
	} catch { /* ignore */ }
};

// Webviews are sandboxed; confirm()/alert() may be blocked unless allow-modals is set.
// Route confirmation via the extension host so we can use VS Code's native modal.
let __kustoConfirmRemoveFavoriteCallbacksById = Object.create(null);

(window as any).__kustoOnConfirmRemoveFavoriteResult = function (message: any) {
	try {
		const m = (message && typeof message === 'object') ? message : {};
		const requestId = String(m.requestId || '');
		const ok = !!m.ok;
		if (!requestId) return;
		const cb = __kustoConfirmRemoveFavoriteCallbacksById && __kustoConfirmRemoveFavoriteCallbacksById[requestId];
		try { delete __kustoConfirmRemoveFavoriteCallbacksById[requestId]; } catch { /* ignore */ }
		if (typeof cb === 'function') {
			try { cb(ok); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
};

function __kustoFindConnectionIdForClusterUrl( clusterUrl: any) {
	try {
		const key = normalizeClusterUrlKey(String(clusterUrl || '').trim());
		if (!key) return '';
		for (const c of (_win.connections || [])) {
			if (!c) continue;
			if (normalizeClusterUrlKey(c.clusterUrl || '') === key) {
				return String(c.id || '').trim();
			}
		}
	} catch {
		// ignore
	}
	return '';
}

// For optimized/comparison boxes, execution inherits cluster/db from the source box.
// Expose this so schema/autocomplete and favorites selection can follow the same path.
(window as any).__kustoGetSelectionOwnerBoxId = function (boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return '';
	try {
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
			const meta = _win.optimizationMetadataByBoxId[id];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				return String(meta.sourceBoxId || '').trim() || id;
			}
		}
	} catch { /* ignore */ }
	return id;
};

function __kustoTryApplyPendingFavoriteSelectionForBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return false;
	let pending = null;
	try {
		pending = _win.pendingFavoriteSelectionByBoxId && _win.pendingFavoriteSelectionByBoxId[id]
			? _win.pendingFavoriteSelectionByBoxId[id]
			: null;
	} catch { /* ignore */ }
	if (!pending) return false;

	const clusterUrl = String(pending.clusterUrl || '').trim();
	const database = String(pending.database || '').trim();
	if (!clusterUrl || !database) {
		try { delete _win.pendingFavoriteSelectionByBoxId[id]; } catch { /* ignore */ }
		return false;
	}

	const connectionId = __kustoFindConnectionIdForClusterUrl(clusterUrl);
	if (!connectionId) {
		return false;
	}

	// Apply to the effective selection owner (matches execution behavior).
	let ownerId = id;
	try {
		ownerId = (typeof (window as any).__kustoGetSelectionOwnerBoxId === 'function')
			? ((window as any).__kustoGetSelectionOwnerBoxId(id) || id)
			: id;
	} catch { ownerId = id; }

	const applyToBox = (targetBoxId: any) => {
		const tid = String(targetBoxId || '').trim();
		if (!tid) return;
		const kwEl = _win.__kustoGetQuerySectionElement(tid);
		if (!kwEl) return;
		try {
			if (typeof kwEl.setDesiredClusterUrl === 'function') kwEl.setDesiredClusterUrl(clusterUrl);
			if (typeof kwEl.setDesiredDatabase === 'function') kwEl.setDesiredDatabase(database);
		} catch { /* ignore */ }
		try {
			if (connectionId && typeof kwEl.setConnectionId === 'function') {
				kwEl.setConnectionId(connectionId);
			}
			// Trigger database loading.
			kwEl.dispatchEvent(new CustomEvent('connection-changed', {
				detail: { boxId: tid, connectionId: connectionId, clusterUrl: clusterUrl },
				bubbles: true, composed: true,
			}));
		} catch { /* ignore */ }
	};

	applyToBox(ownerId);
	// Keep the originating box UI in sync if it's different.
	if (ownerId !== id) {
		applyToBox(id);
	}

	try { delete _win.pendingFavoriteSelectionByBoxId[id]; } catch { /* ignore */ }
	return true;
}

function __kustoSetElementDisplay( el: any, display: any) {
	try {
		if (!el) return;
		el.style.display = display;
	} catch { /* ignore */ }
}

function __kustoUpdateFavoritesUiForBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const kwEl = _win.__kustoGetQuerySectionElement(id);
	if (kwEl && typeof kwEl.setFavorites === 'function') {
		kwEl.setFavorites(Array.isArray(_win.kustoFavorites) ? _win.kustoFavorites : []);
	}
}

(window as any).__kustoUpdateFavoritesUiForAllBoxes = function () {
	try {
		_win.queryBoxes.forEach((id: any) =>  {
			try { __kustoUpdateFavoritesUiForBox(id); } catch { /* ignore */ }
		});
	} catch { /* ignore */ }
};

// Toggle the current cluster+database as a favorite for a given query box.
// Sends a message to the extension host which handles add/remove + persistence.
function toggleFavoriteForBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const clusterUrl = _win.__kustoGetClusterUrl(id);
	const database = _win.__kustoGetDatabase(id);
	if (!clusterUrl || !database) return;

	const existing = __kustoFindFavorite(clusterUrl, database);
	if (existing) {
		// Already a favorite — remove it.
		(_win.vscode as any).postMessage({ type: 'removeFavorite', clusterUrl: clusterUrl, database: database, boxId: id });
	} else {
		// Not a favorite yet — request add (extension host shows input box for name).
		(_win.vscode as any).postMessage({ type: 'requestAddFavorite', clusterUrl: clusterUrl, database: database, boxId: id });
	}
}

// Remove a specific favorite by cluster+database.
function removeFavorite( clusterUrl: any, database: any) {
	const c = String(clusterUrl || '').trim();
	const d = String(database || '').trim();
	if (!c || !d) return;
	(_win.vscode as any).postMessage({ type: 'removeFavorite', clusterUrl: c, database: d });
}

// Favorites dropdowns are now managed by the Lit component's shadow DOM.
// This function must exist because the document click/scroll/wheel handlers
// call it without a try/catch guard.
function closeAllFavoritesDropdowns() {
	// no-op — Lit component handles its own dropdown lifecycle.
}

function __kustoApplyFavoritesMode( boxId: any, enabled: any) {
	_win.favoritesModeByBoxId = _win.favoritesModeByBoxId || {};
	_win.favoritesModeByBoxId[boxId] = !!enabled;

	// Delegate to the Lit element — it handles showing/hiding favorites vs cluster/database
	// dropdowns in its shadow DOM render.
	const kwEl = _win.__kustoGetQuerySectionElement(boxId);
	if (kwEl && typeof kwEl.setFavoritesMode === 'function') {
		kwEl.setFavoritesMode(!!enabled);
	}
}

// Called by main.js when a favorite was just added from a specific query box.
(window as any).__kustoEnterFavoritesModeForBox = function (boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	try {
		const hasAny = Array.isArray(_win.kustoFavorites) && _win.kustoFavorites.length > 0;
		if (!hasAny) return;
		__kustoApplyFavoritesMode(id, true);
		__kustoUpdateFavoritesUiForBox(id);
	} catch { /* ignore */ }
};

function __kustoGetTrashIconSvg() {
	return (
		'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
		'<path d="M6 2.5h4" />' +
		'<path d="M3.5 4.5h9" />' +
		'<path d="M5 4.5l.7 9h4.6l.7-9" />' +
		'<path d="M6.6 7v4.8" />' +
		'<path d="M9.4 7v4.8" />' +
		'</svg>'
	);
}


function addMissingClusterConnections( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) {
		return;
	}
	const missing = _win.missingClusterUrlsByBoxId[id];
	const clusters = Array.isArray(missing) ? missing.slice() : [];
	if (!clusters.length) {
		return;
	}
	// If this query box has no cluster selected, auto-select the first newly-added cluster
	// once connections refresh.
	try {
		const hasSelection = !!_win.__kustoGetConnectionId(id);
		const kwEl = _win.__kustoGetQuerySectionElement(id);
		if (kwEl && !hasSelection) {
			const hints = _win.suggestedDatabaseByClusterKeyByBoxId && _win.suggestedDatabaseByClusterKeyByBoxId[id]
				? _win.suggestedDatabaseByClusterKeyByBoxId[id]
				: {};
			let chosenClusterUrl = '';
			let chosenDb = '';
			for (const u of clusters) {
				const key = clusterShortNameKey(u);
				const db = key && hints ? String(hints[key] || '') : '';
				if (db) {
					chosenClusterUrl = String(u || '').trim();
					chosenDb = db;
					break;
				}
			}
			if (!chosenClusterUrl) {
				chosenClusterUrl = String(clusters[0] || '').trim();
				const key0 = clusterShortNameKey(chosenClusterUrl);
				chosenDb = key0 && hints ? String(hints[key0] || '') : '';
			}
			if (typeof kwEl.setDesiredClusterUrl === 'function') kwEl.setDesiredClusterUrl(chosenClusterUrl);
			if (chosenDb && typeof kwEl.setDesiredDatabase === 'function') kwEl.setDesiredDatabase(chosenDb);
		}
	} catch {
		// ignore
	}
	try {
		(_win.vscode as any).postMessage({
			type: 'addConnectionsForClusters',
			boxId: id,
			clusterUrls: clusters
		});
	} catch {
		// ignore
	}
}

function updateConnectionSelects() {
	_win.queryBoxes.forEach((id: any) =>  {
		const el = _win.__kustoGetQuerySectionElement(id);
		if (el && typeof el.setConnections === 'function') {
			// Delegate to the Lit element — it handles desired/current/last resolution internally.
			el.setConnections(_win.connections || [], { lastConnectionId: _win.lastConnectionId || '' });
		}
		try { __kustoUpdateFavoritesUiForBox(id); } catch { /* ignore */ }
	});
	try {
		if (typeof (window as any).__kustoUpdateRunEnabledForAllBoxes === 'function') {
			(window as any).__kustoUpdateRunEnabledForAllBoxes();
		}
	} catch { /* ignore */ }
}

function updateDatabaseField( boxId: any) {
	// If a previous database-load attempt rendered an error into the results area,
	// clear it as soon as the user changes clusters so the UI doesn't look stuck.
	try {
		if (typeof __kustoClearDatabaseLoadError === 'function') {
			__kustoClearDatabaseLoadError(boxId);
		}
	} catch { /* ignore */ }

	const connectionId = _win.__kustoGetConnectionId(boxId);
	if (!connectionId) return;

	// For Lit elements, connection-changed events already handle database loading.
	// This function is only called as a manual trigger from legacy code paths.
	// All query sections are <kw-query-section> Lit elements.
	// The connection-changed event handler (wired in addQueryBox) handles
	// database loading, schema clearing, and persistence.
	const kwEl = _win.__kustoGetQuerySectionElement(boxId);
	if (kwEl) {
		kwEl.dispatchEvent(new CustomEvent('connection-changed', {
			detail: { boxId: boxId, connectionId: connectionId, clusterUrl: _win.__kustoGetClusterUrl(boxId) },
			bubbles: true, composed: true,
		}));
	}
}

function __kustoClearDatabaseLoadError( boxId: any) {
	const bid = String(boxId || '').trim();
	if (!bid) return;
	const resultsDiv = document.getElementById(bid + '_results') as any;
	if (!resultsDiv || !resultsDiv.dataset) return;

	try {
		if (resultsDiv.dataset.kustoDbLoadErrorActive !== '1') {
			return;
		}
		const prevHtml = resultsDiv.dataset.kustoDbLoadErrorPrevHtml;
		const prevVisible = resultsDiv.dataset.kustoDbLoadErrorPrevVisible;
		if (typeof prevHtml === 'string') {
			resultsDiv.innerHTML = prevHtml;
		}
		try {
			if (typeof prevVisible === 'string' && prevVisible.length) {
				const desiredVisible = (prevVisible === '1');
				if (typeof _win.__kustoSetResultsVisible === 'function') {
					_win.__kustoSetResultsVisible(bid, desiredVisible);
				} else {
					try {
						if ((window as any).__kustoResultsVisibleByBoxId) {
							(window as any).__kustoResultsVisibleByBoxId[bid] = desiredVisible;
						}
						if (typeof _win.__kustoApplyResultsVisibility === 'function') {
							_win.__kustoApplyResultsVisibility(bid);
						}
					} catch { /* ignore */ }
				}
			}
		} catch { /* ignore */ }
	} finally {
		try {
			delete resultsDiv.dataset.kustoDbLoadErrorActive;
			delete resultsDiv.dataset.kustoDbLoadErrorPrevHtml;
			delete resultsDiv.dataset.kustoDbLoadErrorPrevVisible;
		} catch { /* ignore */ }
	}
}

function promptAddConnectionFromDropdown( boxId: any) {
	try {
		(_win.vscode as any).postMessage({ type: 'promptAddConnection', boxId: boxId });
	} catch {
		// ignore
	}
}

function importConnectionsFromXmlFile( boxId: any) {
	try {
		// Use the extension host's file picker so we can default to the user's Kusto Explorer folder.
		(_win.vscode as any).postMessage({ type: 'promptImportConnectionsXml', boxId: boxId });
	} catch (e: any) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Failed to open file picker: ' + (e && e.message ? e.message : String(e)) }); } catch { /* ignore */ }
	}
}

function parseKustoExplorerConnectionsXml( xmlText: any) {
	const text = String(xmlText || '');
	if (!text.trim()) {
		return [];
	}
	let doc;
	try {
		doc = new DOMParser().parseFromString(text, 'application/xml');
	} catch {
		return [];
	}
	// Detect parse errors.
	try {
		const err = doc.getElementsByTagName('parsererror');
		if (err && err.length) {
			return [];
		}
	} catch {
		// ignore
	}

	const nodes = Array.from(doc.getElementsByTagName('ServerDescriptionBase'));
	const results = [];
	for (const node of nodes) {
		const name = getChildText(node, 'Name');
		const details = getChildText(node, 'Details');
		const connectionString = getChildText(node, 'ConnectionString');
		const parsed = parseKustoConnectionString(connectionString);
		let clusterUrl = (parsed.dataSource || details || '').trim();
		if (!clusterUrl) {
			continue;
		}
		// Normalize URL-ish strings.
		if (!/^https?:\/\//i.test(clusterUrl)) {
			clusterUrl = 'https://' + clusterUrl.replace(/^\/+/, '');
		}
		results.push({
			name: (name || '').trim() || clusterUrl,
			clusterUrl: clusterUrl.trim(),
			database: (parsed.initialCatalog || '').trim() || undefined
		});
	}

	// De-dupe within the file.
	const seen = new Set();
	const deduped = [];
	for (const r of results) {
		let key = '';
		try {
			key = (typeof normalizeClusterUrlKey === 'function')
				? normalizeClusterUrlKey(r.clusterUrl || '')
				: String(r.clusterUrl || '').trim().replace(/\/+$/g, '').toLowerCase();
		} catch {
			key = String(r.clusterUrl || '').trim().replace(/\/+$/g, '').toLowerCase();
		}
		if (!key || seen.has(key)) {
			continue;
		}
		seen.add(key);
		deduped.push(r);
	}
	return deduped;
}

function getChildText( node: any, localName: any) {
	if (!node || !node.childNodes) {
		return '';
	}
	for (const child of Array.from(node.childNodes) as any[]) {
		if (!child || child.nodeType !== 1) {
			continue;
		}
		const ln = child.localName || child.nodeName;
		if (String(ln).toLowerCase() === String(localName).toLowerCase()) {
			return String(child.textContent || '');
		}
	}
	return '';
}

function parseKustoConnectionString( cs: any) {
	const raw = String(cs || '');
	const parts = raw.split(';').map((p: any) => p.trim()).filter(Boolean);
	const map: any = {};
	for (const part of parts) {
		const idx = part.indexOf('=');
		if (idx <= 0) {
			continue;
		}
		const key = part.slice(0, idx).trim().toLowerCase();
		const val = part.slice(idx + 1).trim();
		map[key] = val;
	}
	return {
		dataSource: map['data source'] || map['datasource'] || map['server'] || map['address'] || '',
		initialCatalog: map['initial catalog'] || map['database'] || ''
	};
}

function refreshDatabases( boxId: any) {
	const connectionId = _win.__kustoGetConnectionId(boxId);
	if (!connectionId) return;

	const kwEl = _win.__kustoGetQuerySectionElement(boxId);
	if (kwEl && typeof kwEl.setRefreshLoading === 'function') {
		kwEl.setRefreshLoading(true);
		kwEl.setDatabasesLoading(true);
	}

	(_win.vscode as any).postMessage({
		type: 'refreshDatabases',
		connectionId: connectionId,
		boxId: boxId
	});
}

function onDatabasesError( boxId: any, error: any, responseConnectionId: any) {
	const errText = String(error || '');
	const isEnotfound = /\bENOTFOUND\b/i.test(errText) || /getaddrinfo\s+ENOTFOUND/i.test(errText);

	// If the response includes a connectionId, verify it matches the currently selected connection.
	// This prevents stale error responses (from a slow request for a previous cluster) from affecting
	// the dropdown when the user has already switched to a different cluster.
	if (responseConnectionId) {
		const currentConnectionId = _win.__kustoGetConnectionId(boxId);
		const responseConnId = String(responseConnectionId || '').trim();
		if (currentConnectionId && responseConnId && currentConnectionId !== responseConnId) {
			// Response is for a different connection than currently selected - ignore it.
			// Still stop any spinner that might be running.
			const refreshBtn = document.getElementById(boxId + '_refresh') as any;
			if (refreshBtn) {
				try {
					if (refreshBtn.dataset && (refreshBtn.dataset.kustoRefreshDbInFlight === '1' || refreshBtn.dataset.kustoAutoDbInFlight === '1')) {
						const prev = refreshBtn.dataset.kustoPrevHtml;
						if (typeof prev === 'string' && prev) {
							refreshBtn.innerHTML = prev;
						}
						try { delete refreshBtn.dataset.kustoPrevHtml; } catch { /* ignore */ }
						try { delete refreshBtn.dataset.kustoRefreshDbInFlight; } catch { /* ignore */ }
						try { delete refreshBtn.dataset.kustoAutoDbInFlight; } catch { /* ignore */ }
					}
					refreshBtn.removeAttribute('aria-busy');
					refreshBtn.disabled = false;
				} catch { /* ignore */ }
			}
			return;
		}
	}

	try {
		const databaseSelect = document.getElementById(boxId + '_database') as any;
		const refreshBtn = document.getElementById(boxId + '_refresh') as any;
		if (databaseSelect) {
			// Check if we have previous content to restore (from a manual refresh)
			const hadPreviousContent = databaseSelect.dataset && 
				databaseSelect.dataset.kustoRefreshInFlight === 'true' &&
				typeof databaseSelect.dataset.kustoPrevHtml === 'string' && 
				databaseSelect.dataset.kustoPrevHtml;
			
			if (isEnotfound) {
				// Cluster is unreachable/invalid: show failure message
				databaseSelect.innerHTML = '<option value="" disabled selected>Failed to load database list.</option>';
				try { databaseSelect.value = ''; } catch { /* ignore */ }
			} else if (hadPreviousContent) {
				// Restore previous dropdown contents/value if we snapshotted them (manual refresh case).
				try {
					const prevHtml = databaseSelect.dataset.kustoPrevHtml;
					const prevValue = databaseSelect.dataset.kustoPrevValue;
					if (typeof prevHtml === 'string' && prevHtml) {
						databaseSelect.innerHTML = prevHtml;
					}
					if (typeof prevValue === 'string') {
						databaseSelect.value = prevValue;
					}
				} catch { /* ignore */ }
			} else {
				// No previous content (initial load failed): show failure message
				databaseSelect.innerHTML = '<option value="" disabled selected>Failed to load database list.</option>';
				try { databaseSelect.value = ''; } catch { /* ignore */ }
			}
			databaseSelect.disabled = false;
			try { (window as any).__kustoDropdown && (window as any).__kustoDropdown.syncSelectBackedDropdown && (window as any).__kustoDropdown.syncSelectBackedDropdown(boxId + '_database'); } catch { /* ignore */ }
			try {
				if (databaseSelect.dataset) {
					delete databaseSelect.dataset.kustoRefreshInFlight;
					delete databaseSelect.dataset.kustoPrevHtml;
					delete databaseSelect.dataset.kustoPrevValue;
				}
			} catch { /* ignore */ }
		}
		if (refreshBtn) {
			try {
				if (refreshBtn.dataset && (refreshBtn.dataset.kustoRefreshDbInFlight === '1' || refreshBtn.dataset.kustoAutoDbInFlight === '1')) {
					const prev = refreshBtn.dataset.kustoPrevHtml;
					if (typeof prev === 'string' && prev) {
						refreshBtn.innerHTML = prev;
					}
					try { delete refreshBtn.dataset.kustoPrevHtml; } catch { /* ignore */ }
					try { delete refreshBtn.dataset.kustoRefreshDbInFlight; } catch { /* ignore */ }
					try { delete refreshBtn.dataset.kustoAutoDbInFlight; } catch { /* ignore */ }
				}
				refreshBtn.removeAttribute('aria-busy');
			} catch { /* ignore */ }
			refreshBtn.disabled = false;
		}
	} catch {
		// ignore
	}
	try {
		if (typeof (window as any).__kustoUpdateRunEnabledForBox === 'function') {
			(window as any).__kustoUpdateRunEnabledForBox(boxId);
		}
	} catch { /* ignore */ }
	// Note: We no longer show inline errors in the results section for database load failures.
	// The extension now uses VS Code notifications instead for a consistent experience.
}

function updateDatabaseSelect( boxId: any, databases: any, responseConnectionId: any) {
	const kwEl = _win.__kustoGetQuerySectionElement(boxId);

	// If the response includes a connectionId, verify it matches the currently selected connection.
	if (responseConnectionId) {
		const currentConnectionId = _win.__kustoGetConnectionId(boxId);
		const responseConnId = String(responseConnectionId || '').trim();
		if (currentConnectionId && responseConnId && currentConnectionId !== responseConnId) {
			// Response is for a different connection — ignore it, stop spinner.
			if (kwEl && typeof kwEl.setRefreshLoading === 'function') kwEl.setRefreshLoading(false);
			return;
		}
	}

	const list = (Array.isArray(databases) ? databases : [])
		.map((d: any) => String(d || '').trim())
		.filter(Boolean)
		.sort((a: any, b: any) => a.toLowerCase().localeCompare(b.toLowerCase()));

	// Update local cache.
	const connectionId = _win.__kustoGetConnectionId(boxId);
	if (connectionId) {
		let clusterKey = '';
		try {
			const cid = String(connectionId || '').trim();
			const conn = Array.isArray(_win.connections) ? _win.connections.find((c: any) => c && String(c.id || '').trim() === cid) : null;
			const clusterUrl = conn && conn.clusterUrl ? String(conn.clusterUrl) : '';
			if (clusterUrl) {
				let u = clusterUrl;
				if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
				try { clusterKey = String(new URL(u).hostname || '').trim().toLowerCase(); } catch { clusterKey = clusterUrl.trim().toLowerCase(); }
			}
		} catch { /* ignore */ }
		_win.cachedDatabases[String(clusterKey || '').trim()] = list;
	}

	// Delegate to the Lit element.
	if (kwEl && typeof kwEl.setDatabases === 'function') {
		kwEl.setDatabases(list, _win.lastDatabase || '');
		kwEl.setRefreshLoading(false);
	}

	try { __kustoTryAutoEnterFavoritesModeForNewBox(boxId); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
	try {
		if (typeof (window as any).__kustoUpdateRunEnabledForBox === 'function') {
			(window as any).__kustoUpdateRunEnabledForBox(boxId);
		}
	} catch { /* ignore */ }
}

// ── Window bridges for remaining legacy callers ──
(window as any).formatClusterDisplayName = formatClusterDisplayName;
(window as any).normalizeClusterUrlKey = normalizeClusterUrlKey;
(window as any).formatClusterShortName = formatClusterShortName;
(window as any).clusterShortNameKey = clusterShortNameKey;
(window as any).extractClusterUrlsFromQueryText = extractClusterUrlsFromQueryText;
(window as any).extractClusterDatabaseHintsFromQueryText = extractClusterDatabaseHintsFromQueryText;
(window as any).computeMissingClusterUrls = computeMissingClusterUrls;
(window as any).renderMissingClustersBanner = renderMissingClustersBanner;
(window as any).updateMissingClustersForBox = updateMissingClustersForBox;
(window as any).__kustoFavoriteKey = __kustoFavoriteKey;
(window as any).__kustoGetCurrentClusterUrlForBox = __kustoGetCurrentClusterUrlForBox;
(window as any).__kustoGetCurrentDatabaseForBox = __kustoGetCurrentDatabaseForBox;
(window as any).__kustoFindFavorite = __kustoFindFavorite;
(window as any).__kustoGetFavoritesSorted = __kustoGetFavoritesSorted;
(window as any).__kustoMarkNewBoxForFavoritesAutoEnter = __kustoMarkNewBoxForFavoritesAutoEnter;
(window as any).__kustoTryAutoEnterFavoritesModeForNewBox = __kustoTryAutoEnterFavoritesModeForNewBox;
(window as any).__kustoTryAutoEnterFavoritesModeForBox = __kustoTryAutoEnterFavoritesModeForBox;
(window as any).__kustoFindConnectionIdForClusterUrl = __kustoFindConnectionIdForClusterUrl;
(window as any).__kustoTryApplyPendingFavoriteSelectionForBox = __kustoTryApplyPendingFavoriteSelectionForBox;
(window as any).__kustoSetElementDisplay = __kustoSetElementDisplay;
(window as any).__kustoUpdateFavoritesUiForBox = __kustoUpdateFavoritesUiForBox;
(window as any).toggleFavoriteForBox = toggleFavoriteForBox;
(window as any).removeFavorite = removeFavorite;
(window as any).closeAllFavoritesDropdowns = closeAllFavoritesDropdowns;
(window as any).__kustoApplyFavoritesMode = __kustoApplyFavoritesMode;
(window as any).__kustoGetTrashIconSvg = __kustoGetTrashIconSvg;
(window as any).addMissingClusterConnections = addMissingClusterConnections;
(window as any).updateConnectionSelects = updateConnectionSelects;
(window as any).updateDatabaseField = updateDatabaseField;
(window as any).__kustoClearDatabaseLoadError = __kustoClearDatabaseLoadError;
(window as any).promptAddConnectionFromDropdown = promptAddConnectionFromDropdown;
(window as any).importConnectionsFromXmlFile = importConnectionsFromXmlFile;
(window as any).parseKustoExplorerConnectionsXml = parseKustoExplorerConnectionsXml;
(window as any).getChildText = getChildText;
(window as any).parseKustoConnectionString = parseKustoConnectionString;
(window as any).refreshDatabases = refreshDatabases;
(window as any).onDatabasesError = onDatabasesError;
(window as any).updateDatabaseSelect = updateDatabaseSelect;
