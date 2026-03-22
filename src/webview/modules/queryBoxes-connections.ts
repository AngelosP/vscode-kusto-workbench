// Connection, favorites & schema management — extracted from queryBoxes.ts
import { pState } from '../shared/persistence-state';
import { postMessageToHost } from '../shared/webview-messages';
import { schedulePersist } from './persistence';
import {
	cachedDatabases,
	connections,
	favoritesModeByBoxId,
	pendingFavoriteSelectionByBoxId,
	queryEditors,
	schemaByBoxId,
	schemaFetchInFlightByBoxId,
	lastSchemaRequestAtByBoxId,
	schemaByConnDb,
	schemaRequestResolversByBoxId,
	databasesRequestResolversByBoxId,
	missingClusterDetectTimersByBoxId,
	lastQueryTextByBoxId,
	missingClusterUrlsByBoxId,
	suggestedDatabaseByClusterKeyByBoxId,
	kustoFavorites,
	lastConnectionId,
	lastDatabase,
} from './state';
import { buildSchemaInfo } from '../shared/schema-utils';
import { syncSelectBackedDropdown } from './dropdown';
import {
	formatClusterDisplayName,
	normalizeClusterUrlKey,
	formatClusterShortName,
	clusterShortNameKey,
	extractClusterUrlsFromQueryText,
	extractClusterDatabaseHintsFromQueryText,
	computeMissingClusterUrls as _computeMissing,
	favoriteKey as __kustoFavoriteKey,
	findFavorite as __kustoFindFavorite_pure,
	getFavoritesSorted as __kustoGetFavoritesSorted_pure,
	parseKustoConnectionString,
	findConnectionIdForClusterUrl as _findConnIdPure,
} from '../shared/clusterUtils';
import { escapeHtml } from './utils';
import { __kustoGetQuerySectionElement, __kustoGetConnectionId, __kustoGetDatabase, __kustoGetClusterUrl, schemaRequestTokenByBoxId } from './queryBoxes';

const _win = window;

export function computeMissingClusterUrls(detectedClusterUrls: any) {
	return _computeMissing(detectedClusterUrls, connections || []);
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
		? ('Detected clusters not in your connections: <strong>' + escapeHtml(shortNames.join(', ')) + '</strong>.')
		: 'Detected clusters not in your connections.';
	textEl.innerHTML = label + ' Add them with one click.';
	banner.style.display = 'flex';
}

export function updateMissingClustersForBox( boxId: any, queryText: any) {
	try {
		lastQueryTextByBoxId[boxId] = String(queryText || '');
	} catch (e) { console.error('[kusto]', e); }
	try {
		suggestedDatabaseByClusterKeyByBoxId[boxId] = extractClusterDatabaseHintsFromQueryText(queryText);
	} catch (e) { console.error('[kusto]', e); }
	const detected = extractClusterUrlsFromQueryText(queryText);
	const missing = computeMissingClusterUrls(detected);
	try { missingClusterUrlsByBoxId[boxId] = missing; } catch (e) { console.error('[kusto]', e); }
	renderMissingClustersBanner(boxId, missing);
}

// Called by Monaco on content changes.
window.__kustoOnQueryValueChanged = function (boxId: any, queryText: any) {
	const id = String(boxId || '').trim();
	if (!id) {
		return;
	}
	try { lastQueryTextByBoxId[id] = String(queryText || ''); } catch (e) { console.error('[kusto]', e); }
	try {
		if (missingClusterDetectTimersByBoxId[id]) {
			clearTimeout(missingClusterDetectTimersByBoxId[id]);
		}
		missingClusterDetectTimersByBoxId[id] = setTimeout(() => {
			try { updateMissingClustersForBox(id, lastQueryTextByBoxId[id] || ''); } catch (e) { console.error('[kusto]', e); }
		}, 260);
	} catch (e) { console.error('[kusto]', e); }
};

// Called by main.ts when the connections list changes.
export function __kustoOnConnectionsUpdated() {
	try {
		for (const id of (queryBoxes || [])) {
			updateMissingClustersForBox(id, lastQueryTextByBoxId[id] || '');
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		for (const id of (queryBoxes || [])) {
			try {
				if (pendingFavoriteSelectionByBoxId && pendingFavoriteSelectionByBoxId[id]) {
					__kustoTryApplyPendingFavoriteSelectionForBox(id);
				}
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		__kustoUpdateFavoritesUiForAllBoxes();
	} catch (e) { console.error('[kusto]', e); }
}
window.__kustoOnConnectionsUpdated = __kustoOnConnectionsUpdated;

export function __kustoFindConnectionIdForClusterUrl( clusterUrl: any) {
	return _findConnIdPure(clusterUrl, connections || []);
}

export function __kustoGetCurrentClusterUrlForBox( boxId: any) {
	return __kustoGetClusterUrl(boxId);
}

export function __kustoGetCurrentDatabaseForBox( boxId: any) {
	return __kustoGetDatabase(boxId);
}

export function __kustoFindFavorite( clusterUrl: any, database: any) {
	return __kustoFindFavorite_pure(clusterUrl, database, Array.isArray(kustoFavorites) ? kustoFavorites : []);
}

function __kustoGetFavoritesSorted() {
	return __kustoGetFavoritesSorted_pure(Array.isArray(kustoFavorites) ? kustoFavorites : []);
}

let __kustoAutoEnterFavoritesByBoxId = Object.create(null);
let __kustoAutoEnterFavoritesForNewBoxByBoxId = Object.create(null);

export function __kustoMarkNewBoxForFavoritesAutoEnter( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	try {
		if (typeof pState.restoreInProgress === 'boolean' && pState.restoreInProgress) {
			return;
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		__kustoAutoEnterFavoritesForNewBoxByBoxId = __kustoAutoEnterFavoritesForNewBoxByBoxId || Object.create(null);
		__kustoAutoEnterFavoritesForNewBoxByBoxId[id] = true;
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoTryAutoEnterFavoritesModeForNewBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	let pending = false;
	try {
		pending = !!(__kustoAutoEnterFavoritesForNewBoxByBoxId && __kustoAutoEnterFavoritesForNewBoxByBoxId[id]);
	} catch { pending = false; }
	if (!pending) return;
	try {
		if (favoritesModeByBoxId && Object.prototype.hasOwnProperty.call(favoritesModeByBoxId, id)) {
			try { delete __kustoAutoEnterFavoritesForNewBoxByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
			return;
		}
	} catch (e) { console.error('[kusto]', e); }
	const hasAny = Array.isArray(kustoFavorites) && kustoFavorites.length > 0;
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
	} catch (e) { console.error('[kusto]', e); }
	try { delete __kustoAutoEnterFavoritesForNewBoxByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
}

export function __kustoSetAutoEnterFavoritesForBox(boxId: any, clusterUrl: any, database: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const c = String(clusterUrl || '').trim();
	const d = String(database || '').trim();
	if (!c || !d) return;
	try {
		__kustoAutoEnterFavoritesByBoxId = __kustoAutoEnterFavoritesByBoxId || Object.create(null);
		__kustoAutoEnterFavoritesByBoxId[id] = { clusterUrl: c, database: d };
	} catch (e) { console.error('[kusto]', e); }
}
window.__kustoSetAutoEnterFavoritesForBox = __kustoSetAutoEnterFavoritesForBox;

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
	const hasAny = Array.isArray(kustoFavorites) && kustoFavorites.length > 0;
	if (!hasAny) return;
	const fav = __kustoFindFavorite(desired.clusterUrl, desired.database);
	if (!fav) {
		try {
			const isInFavMode = !!(favoritesModeByBoxId && favoritesModeByBoxId[id]);
			if (isInFavMode) {
				__kustoApplyFavoritesMode(id, false);
			}
		} catch (e) { console.error('[kusto]', e); }
		try { delete __kustoAutoEnterFavoritesByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
		return;
	}
	try { __kustoApplyFavoritesMode(id, true); } catch (e) { console.error('[kusto]', e); }
	try { delete __kustoAutoEnterFavoritesByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
}

export function __kustoTryAutoEnterFavoritesModeForAllBoxes() {
	try {
		for (const id of (queryBoxes || [])) {
			try { __kustoTryAutoEnterFavoritesModeForBox(id); } catch (e) { console.error('[kusto]', e); }
			try { __kustoTryAutoEnterFavoritesModeForNewBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}
window.__kustoTryAutoEnterFavoritesModeForAllBoxes = __kustoTryAutoEnterFavoritesModeForAllBoxes;

let __kustoDidDefaultFirstBoxToFavorites = false;

export function __kustoMaybeDefaultFirstBoxToFavoritesMode() {
	try {
		if (__kustoDidDefaultFirstBoxToFavorites) return;
		const hasAny = Array.isArray(kustoFavorites) && kustoFavorites.length > 0;
		if (!hasAny) return;
		if (!Array.isArray(queryBoxes) || queryBoxes.length !== 1) return;
		const id = String(queryBoxes[0] || '').trim();
		if (!id) return;
		try {
			if (favoritesModeByBoxId && Object.prototype.hasOwnProperty.call(favoritesModeByBoxId, id)) {
				return;
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			let desiredCluster = '';
			let desiredDb = '';
			const pending = __kustoAutoEnterFavoritesByBoxId && __kustoAutoEnterFavoritesByBoxId[id];
			if (pending) {
				desiredCluster = pending.clusterUrl || '';
				desiredDb = pending.database || '';
			}
			if (!desiredCluster) {
				const kwEl = __kustoGetQuerySectionElement(id);
				desiredCluster = kwEl ? __kustoGetClusterUrl(id) : '';
			}
			if (!desiredDb) {
				desiredDb = __kustoGetDatabase(id);
			}
			if (desiredCluster && desiredDb) {
				const fav = __kustoFindFavorite(desiredCluster, desiredDb);
				if (!fav) {
					__kustoDidDefaultFirstBoxToFavorites = true;
					return;
				}
			}
		} catch (e) { console.error('[kusto]', e); }
		__kustoApplyFavoritesMode(id, true);
		try { __kustoUpdateFavoritesUiForBox(id); } catch (e) { console.error('[kusto]', e); }
		__kustoDidDefaultFirstBoxToFavorites = true;
	} catch (e) { console.error('[kusto]', e); }
}
window.__kustoMaybeDefaultFirstBoxToFavoritesMode = __kustoMaybeDefaultFirstBoxToFavoritesMode;

let __kustoConfirmRemoveFavoriteCallbacksById = Object.create(null);

window.__kustoOnConfirmRemoveFavoriteResult = function (message: any) {
	try {
		const m = (message && typeof message === 'object') ? message : {};
		const requestId = String(m.requestId || '');
		const ok = !!m.ok;
		if (!requestId) return;
		const cb = __kustoConfirmRemoveFavoriteCallbacksById && __kustoConfirmRemoveFavoriteCallbacksById[requestId];
		try { delete __kustoConfirmRemoveFavoriteCallbacksById[requestId]; } catch (e) { console.error('[kusto]', e); }
		if (typeof cb === 'function') {
			try { cb(ok); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
};

window.__kustoGetSelectionOwnerBoxId = function (boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return '';
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
			const meta = optimizationMetadataByBoxId[id];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				return String(meta.sourceBoxId || '').trim() || id;
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	return id;
};

function __kustoTryApplyPendingFavoriteSelectionForBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return false;
	let pending = null;
	try {
		pending = pendingFavoriteSelectionByBoxId && pendingFavoriteSelectionByBoxId[id]
			? pendingFavoriteSelectionByBoxId[id]
			: null;
	} catch (e) { console.error('[kusto]', e); }
	if (!pending) return false;
	const clusterUrl = String(pending.clusterUrl || '').trim();
	const database = String(pending.database || '').trim();
	if (!clusterUrl || !database) {
		try { delete pendingFavoriteSelectionByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
		return false;
	}
	const connectionId = __kustoFindConnectionIdForClusterUrl(clusterUrl);
	if (!connectionId) {
		return false;
	}
	let ownerId = id;
	try {
		ownerId = (typeof window.__kustoGetSelectionOwnerBoxId === 'function')
			? (window.__kustoGetSelectionOwnerBoxId(id) || id)
			: id;
	} catch { ownerId = id; }
	const applyToBox = (targetBoxId: any) => {
		const tid = String(targetBoxId || '').trim();
		if (!tid) return;
		const kwEl = __kustoGetQuerySectionElement(tid);
		if (!kwEl) return;
		try {
			if (typeof kwEl.setDesiredClusterUrl === 'function') kwEl.setDesiredClusterUrl(clusterUrl);
			if (typeof kwEl.setDesiredDatabase === 'function') kwEl.setDesiredDatabase(database);
		} catch (e) { console.error('[kusto]', e); }
		try {
			if (connectionId && typeof kwEl.setConnectionId === 'function') {
				kwEl.setConnectionId(connectionId);
			}
			kwEl.dispatchEvent(new CustomEvent('connection-changed', {
				detail: { boxId: tid, connectionId: connectionId, clusterUrl: clusterUrl },
				bubbles: true, composed: true,
			}));
		} catch (e) { console.error('[kusto]', e); }
	};
	applyToBox(ownerId);
	if (ownerId !== id) {
		applyToBox(id);
	}
	try { delete pendingFavoriteSelectionByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
	return true;
}

export function __kustoUpdateFavoritesUiForBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const kwEl = __kustoGetQuerySectionElement(id);
	if (kwEl && typeof kwEl.setFavorites === 'function') {
		kwEl.setFavorites(Array.isArray(kustoFavorites) ? kustoFavorites : []);
	}
}

export function __kustoUpdateFavoritesUiForAllBoxes() {
	try {
		queryBoxes.forEach((id: any) =>  {
			try { __kustoUpdateFavoritesUiForBox(id); } catch (e) { console.error('[kusto]', e); }
		});
	} catch (e) { console.error('[kusto]', e); }
}
window.__kustoUpdateFavoritesUiForAllBoxes = __kustoUpdateFavoritesUiForAllBoxes;

export function toggleFavoriteForBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const clusterUrl = __kustoGetClusterUrl(id);
	const database = __kustoGetDatabase(id);
	if (!clusterUrl || !database) return;
	const existing = __kustoFindFavorite(clusterUrl, database);
	if (existing) {
		postMessageToHost({ type: 'removeFavorite', clusterUrl: clusterUrl, database: database, boxId: id });
	} else {
		postMessageToHost({ type: 'requestAddFavorite', clusterUrl: clusterUrl, database: database, boxId: id });
	}
}

export function removeFavorite( clusterUrl: any, database: any) {
	const c = String(clusterUrl || '').trim();
	const d = String(database || '').trim();
	if (!c || !d) return;
	postMessageToHost({ type: 'removeFavorite', clusterUrl: c, database: d });
}

export function closeAllFavoritesDropdowns() {
	// no-op — Lit component handles its own dropdown lifecycle.
}

function __kustoApplyFavoritesMode( boxId: any, enabled: any) {
	favoritesModeByBoxId[boxId] = !!enabled;
	const kwEl = __kustoGetQuerySectionElement(boxId);
	if (kwEl && typeof kwEl.setFavoritesMode === 'function') {
		kwEl.setFavoritesMode(!!enabled);
	}
}

window.__kustoEnterFavoritesModeForBox = function (boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	try {
		const hasAny = Array.isArray(kustoFavorites) && kustoFavorites.length > 0;
		if (!hasAny) return;
		__kustoApplyFavoritesMode(id, true);
		__kustoUpdateFavoritesUiForBox(id);
	} catch (e) { console.error('[kusto]', e); }
};

export function addMissingClusterConnections( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) {
		return;
	}
	const missing = missingClusterUrlsByBoxId[id];
	const clusters = Array.isArray(missing) ? missing.slice() : [];
	if (!clusters.length) {
		return;
	}
	try {
		const hasSelection = !!__kustoGetConnectionId(id);
		const kwEl = __kustoGetQuerySectionElement(id);
		if (kwEl && !hasSelection) {
			const hints = suggestedDatabaseByClusterKeyByBoxId && suggestedDatabaseByClusterKeyByBoxId[id]
				? suggestedDatabaseByClusterKeyByBoxId[id]
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
	} catch (e) { console.error('[kusto]', e); }
	try {
		postMessageToHost({
			type: 'addConnectionsForClusters',
			boxId: id,
			clusterUrls: clusters
		});
	} catch (e) { console.error('[kusto]', e); }
}

export function updateConnectionSelects() {
	queryBoxes.forEach((id: any) =>  {
		const el = __kustoGetQuerySectionElement(id);
		if (el && typeof el.setConnections === 'function') {
			el.setConnections(connections || [], { lastConnectionId: lastConnectionId || '' });
		}
		try { __kustoUpdateFavoritesUiForBox(id); } catch (e) { console.error('[kusto]', e); }
	});
	try {
		if (typeof window.__kustoUpdateRunEnabledForAllBoxes === 'function') {
			window.__kustoUpdateRunEnabledForAllBoxes();
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function promptAddConnectionFromDropdown( boxId: any) {
	try {
		postMessageToHost({ type: 'promptAddConnection', boxId: boxId });
	} catch (e) { console.error('[kusto]', e); }
}

export function importConnectionsFromXmlFile( boxId: any) {
	try {
		postMessageToHost({ type: 'promptImportConnectionsXml', boxId: boxId });
	} catch (e: any) {
		try { postMessageToHost({ type: 'showInfo', message: 'Failed to open file picker: ' + (e && e.message ? e.message : String(e)) }); } catch (e) { console.error('[kusto]', e); }
	}
}

export function parseKustoExplorerConnectionsXml( xmlText: any) {
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
	try {
		const err = doc.getElementsByTagName('parsererror');
		if (err && err.length) {
			return [];
		}
	} catch (e) { console.error('[kusto]', e); }
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
		if (!/^https?:\/\//i.test(clusterUrl)) {
			clusterUrl = 'https://' + clusterUrl.replace(/^\/+/, '');
		}
		results.push({
			name: (name || '').trim() || clusterUrl,
			clusterUrl: clusterUrl.trim(),
			database: (parsed.initialCatalog || '').trim() || undefined
		});
	}
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

export function refreshDatabases( boxId: any) {
	const connectionId = __kustoGetConnectionId(boxId);
	if (!connectionId) return;
	const kwEl = __kustoGetQuerySectionElement(boxId);
	if (kwEl && typeof kwEl.setRefreshLoading === 'function') {
		kwEl.setRefreshLoading(true);
		kwEl.setDatabasesLoading(true);
	}
	postMessageToHost({
		type: 'refreshDatabases',
		connectionId: connectionId,
		boxId: boxId
	});
}

export function onDatabasesError( boxId: any, error: any, responseConnectionId: any) {
	const errText = String(error || '');
	const isEnotfound = /\bENOTFOUND\b/i.test(errText) || /getaddrinfo\s+ENOTFOUND/i.test(errText);
	const kwEl = __kustoGetQuerySectionElement(boxId);
	if (responseConnectionId) {
		const currentConnectionId = __kustoGetConnectionId(boxId);
		const responseConnId = String(responseConnectionId || '').trim();
		if (currentConnectionId && responseConnId && currentConnectionId !== responseConnId) {
			if (kwEl && typeof kwEl.setRefreshLoading === 'function') kwEl.setRefreshLoading(false);
			if (kwEl && typeof kwEl.setDatabasesLoading === 'function') kwEl.setDatabasesLoading(false);
			const refreshBtn = document.getElementById(boxId + '_refresh') as any;
			if (refreshBtn) {
				try {
					if (refreshBtn.dataset && (refreshBtn.dataset.kustoRefreshDbInFlight === '1' || refreshBtn.dataset.kustoAutoDbInFlight === '1')) {
						const prev = refreshBtn.dataset.kustoPrevHtml;
						if (typeof prev === 'string' && prev) {
							refreshBtn.innerHTML = prev;
						}
						try { delete refreshBtn.dataset.kustoPrevHtml; } catch (e) { console.error('[kusto]', e); }
						try { delete refreshBtn.dataset.kustoRefreshDbInFlight; } catch (e) { console.error('[kusto]', e); }
						try { delete refreshBtn.dataset.kustoAutoDbInFlight; } catch (e) { console.error('[kusto]', e); }
					}
					refreshBtn.removeAttribute('aria-busy');
					refreshBtn.disabled = false;
				} catch (e) { console.error('[kusto]', e); }
			}
			return;
		}
	}
	try {
		const databaseSelect = document.getElementById(boxId + '_database') as any;
		const refreshBtn = document.getElementById(boxId + '_refresh') as any;
		if (databaseSelect) {
			const hadPreviousContent = databaseSelect.dataset &&
				databaseSelect.dataset.kustoRefreshInFlight === 'true' &&
				typeof databaseSelect.dataset.kustoPrevHtml === 'string' &&
				databaseSelect.dataset.kustoPrevHtml;
			if (isEnotfound) {
				databaseSelect.innerHTML = '<option value="" disabled selected>Failed to load database list.</option>';
				try { databaseSelect.value = ''; } catch (e) { console.error('[kusto]', e); }
			} else if (hadPreviousContent) {
				try {
					const prevHtml = databaseSelect.dataset.kustoPrevHtml;
					const prevValue = databaseSelect.dataset.kustoPrevValue;
					if (typeof prevHtml === 'string' && prevHtml) {
						databaseSelect.innerHTML = prevHtml;
					}
					if (typeof prevValue === 'string') {
						databaseSelect.value = prevValue;
					}
				} catch (e) { console.error('[kusto]', e); }
			} else {
				databaseSelect.innerHTML = '<option value="" disabled selected>Failed to load database list.</option>';
				try { databaseSelect.value = ''; } catch (e) { console.error('[kusto]', e); }
			}
			databaseSelect.disabled = false;
			try { syncSelectBackedDropdown(boxId + '_database'); } catch (e) { console.error('[kusto]', e); }
			try {
				if (databaseSelect.dataset) {
					delete databaseSelect.dataset.kustoRefreshInFlight;
					delete databaseSelect.dataset.kustoPrevHtml;
					delete databaseSelect.dataset.kustoPrevValue;
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		if (refreshBtn) {
			try {
				if (refreshBtn.dataset && (refreshBtn.dataset.kustoRefreshDbInFlight === '1' || refreshBtn.dataset.kustoAutoDbInFlight === '1')) {
					const prev = refreshBtn.dataset.kustoPrevHtml;
					if (typeof prev === 'string' && prev) {
						refreshBtn.innerHTML = prev;
					}
					try { delete refreshBtn.dataset.kustoPrevHtml; } catch (e) { console.error('[kusto]', e); }
					try { delete refreshBtn.dataset.kustoRefreshDbInFlight; } catch (e) { console.error('[kusto]', e); }
					try { delete refreshBtn.dataset.kustoAutoDbInFlight; } catch (e) { console.error('[kusto]', e); }
				}
				refreshBtn.removeAttribute('aria-busy');
			} catch (e) { console.error('[kusto]', e); }
			refreshBtn.disabled = false;
		}
	} catch (e) { console.error('[kusto]', e); }
	// Reset Lit component loading states so spinners don't get stuck on error.
	try {
		if (kwEl && typeof kwEl.setRefreshLoading === 'function') kwEl.setRefreshLoading(false);
		if (kwEl && typeof kwEl.setDatabasesLoading === 'function') kwEl.setDatabasesLoading(false);
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof window.__kustoUpdateRunEnabledForBox === 'function') {
			window.__kustoUpdateRunEnabledForBox(boxId);
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function updateDatabaseSelect( boxId: any, databases: any, responseConnectionId: any) {
	const kwEl = __kustoGetQuerySectionElement(boxId);
	if (responseConnectionId) {
		const currentConnectionId = __kustoGetConnectionId(boxId);
		const responseConnId = String(responseConnectionId || '').trim();
		if (currentConnectionId && responseConnId && currentConnectionId !== responseConnId) {
			if (kwEl && typeof kwEl.setRefreshLoading === 'function') kwEl.setRefreshLoading(false);
			return;
		}
	}
	const list = (Array.isArray(databases) ? databases : [])
		.map((d: any) => String(d || '').trim())
		.filter(Boolean)
		.sort((a: any, b: any) => a.toLowerCase().localeCompare(b.toLowerCase()));
	const connectionId = __kustoGetConnectionId(boxId);
	if (connectionId) {
		let clusterKey = '';
		try {
			const cid = String(connectionId || '').trim();
			const conn = Array.isArray(connections) ? connections.find((c: any) => c && String(c.id || '').trim() === cid) : null;
			const clusterUrl = conn && conn.clusterUrl ? String(conn.clusterUrl) : '';
			if (clusterUrl) {
				let u = clusterUrl;
				if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
				try { clusterKey = String(new URL(u).hostname || '').trim().toLowerCase(); } catch { clusterKey = clusterUrl.trim().toLowerCase(); }
			}
		} catch (e) { console.error('[kusto]', e); }
		cachedDatabases[String(clusterKey || '').trim()] = list;
	}
	if (kwEl && typeof kwEl.setDatabases === 'function') {
		kwEl.setDatabases(list, lastDatabase || '');
		kwEl.setRefreshLoading(false);
	}
	try { __kustoTryAutoEnterFavoritesModeForNewBox(boxId); } catch (e) { console.error('[kusto]', e); }
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof window.__kustoUpdateRunEnabledForBox === 'function') {
			window.__kustoUpdateRunEnabledForBox(boxId);
		}
	} catch (e) { console.error('[kusto]', e); }
}

// ── Schema functions (relocated from schema.ts) ──

export function ensureSchemaForBox(boxId: string, forceRefresh?: boolean): void {
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
		if (typeof (_win.__kustoGetSelectionOwnerBoxId) === 'function') {
			ownerId = _win.__kustoGetSelectionOwnerBoxId(boxId) || boxId;
		}
	} catch (e) { console.error('[kusto]', e); }
	const connectionId = __kustoGetConnectionId(ownerId);
	const database = __kustoGetDatabase(ownerId);
	if (!connectionId || !database) {
		return;
	}

	// Set loading state.
	schemaFetchInFlightByBoxId[boxId] = true;
	try {
		const kwEl = __kustoGetQuerySectionElement(boxId);
		if (kwEl && typeof kwEl.setSchemaInfo === 'function') {
			kwEl.setSchemaInfo({ status: 'loading', statusText: 'Loading\u2026' });
		}
	} catch (e) { console.error('[kusto]', e); }

	let requestToken = '';
	try {
		requestToken = 'schema_' + Date.now() + '_' + Math.random().toString(16).slice(2);
		schemaRequestTokenByBoxId[boxId] = requestToken;
	} catch (e) { console.error('[kusto]', e); }
	postMessageToHost({
		type: 'prefetchSchema',
		connectionId,
		database,
		boxId,
		forceRefresh: !!forceRefresh,
		requestToken
	});
}

export function onDatabaseChanged(boxId: string): void {
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
		if (schemaRequestTokenByBoxId) {
			delete schemaRequestTokenByBoxId[boxId];
		}
	} catch (e) { console.error('[kusto]', e); }
	// Reset schema UI.
	try {
		const kwEl = __kustoGetQuerySectionElement(boxId);
		if (kwEl && typeof kwEl.setSchemaInfo === 'function') {
			kwEl.setSchemaInfo(buildSchemaInfo('', false));
		}
	} catch (e) { console.error('[kusto]', e); }
	// Persist selection immediately so VS Code Problems can reflect current schema context.
	try {
		if (!pState.restoreInProgress) {
			const connectionId = __kustoGetConnectionId(boxId);
			const database = __kustoGetDatabase(boxId);
			postMessageToHost({
				type: 'saveLastSelection',
				connectionId: String(connectionId || ''),
				database: String(database || '')
			});
		}
	} catch (e) { console.error('[kusto]', e); }
	ensureSchemaForBox(boxId, false);
	// Update monaco-kusto schema if we have a cached schema for the new database
	try {
		if (typeof (_win.__kustoUpdateSchemaForFocusedBox) === 'function') {
			_win.__kustoUpdateSchemaForFocusedBox(boxId);
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof (_win.__kustoUpdateFavoritesUiForBox) === 'function') {
			_win.__kustoUpdateFavoritesUiForBox(boxId);
		} else if (typeof (_win.__kustoUpdateFavoritesUiForAllBoxes) === 'function') {
			_win.__kustoUpdateFavoritesUiForAllBoxes();
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof (_win.__kustoUpdateRunEnabledForBox) === 'function') {
			_win.__kustoUpdateRunEnabledForBox(boxId);
		}
	} catch (e) { console.error('[kusto]', e); }
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function refreshSchema(boxId: string): void {
	if (!boxId) {
		return;
	}

	// Update schema info UI via Lit element.
	try {
		const kwEl = __kustoGetQuerySectionElement(boxId);
		if (kwEl && typeof kwEl.setSchemaInfo === 'function') {
			kwEl.setSchemaInfo({ status: 'loading', statusText: 'Refreshing\u2026' });
		}
	} catch (e) { console.error('[kusto]', e); }

	lastSchemaRequestAtByBoxId[boxId] = 0;
	ensureSchemaForBox(boxId, true);
}

// Request schema for an arbitrary (connectionId, database) pair.
export async function __kustoRequestSchema(connectionId: string, database: string, forceRefresh?: boolean): Promise<any> {
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
		} catch (e) { console.error('[kusto]', e); }

		const reqBoxId = '__schema_req__' + Date.now() + '_' + Math.random().toString(16).slice(2);
		const p = new Promise((resolve, reject) => {
			try {
			schemaRequestResolversByBoxId[reqBoxId] = { resolve, reject, key };
			} catch (e) {
				reject(e);
			}
		});
		try {
			postMessageToHost({
				type: 'prefetchSchema',
				connectionId: cid,
				database: db,
				boxId: reqBoxId,
				forceRefresh: !!forceRefresh
			});
		} catch (e) {
			try { delete schemaRequestResolversByBoxId[reqBoxId]; } catch (e) { console.error('[kusto]', e); }
			throw e;
		}
		return await p;
	} catch {
		return null;
	}
}

// Request database list for an arbitrary connectionId.
export async function __kustoRequestDatabases(connectionId: string, forceRefresh?: boolean): Promise<any[]> {
	const cid = String(connectionId || '').trim();
	if (!cid) {
		return [];
	}
	try {
		let clusterKey = '';
		try {
			const conn = Array.isArray(connections) ? (connections as any[]).find((c: any) => c && String(c.id || '').trim() === cid) : null;
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
		} catch (e) { console.error('[kusto]', e); }

		const cachedByCluster = cachedDatabases && cachedDatabases[String(clusterKey || '').trim()];
		if (!forceRefresh && Array.isArray(cachedByCluster) && cachedByCluster.length) {
			return cachedByCluster;
		}

		// Legacy fallback (pre per-cluster cache): allow reading by connectionId.
		const cachedByConnectionId = cachedDatabases && cachedDatabases[cid];
		if (!forceRefresh && Array.isArray(cachedByConnectionId) && cachedByConnectionId.length) {
			return cachedByConnectionId;
		}
	} catch (e) { console.error('[kusto]', e); }

	const requestId = '__kusto_dbreq__' + encodeURIComponent(cid) + '__' + Date.now() + '_' + Math.random().toString(16).slice(2);
	return await new Promise((resolve, reject) => {
		try {
			databasesRequestResolversByBoxId[requestId] = { resolve, reject };
		} catch {
			resolve([]);
			return;
		}

		try {
			postMessageToHost({
				type: forceRefresh ? 'refreshDatabases' : 'getDatabases',
				connectionId: cid,
				boxId: requestId
			});
		} catch (e) {
			try { delete databasesRequestResolversByBoxId[requestId]; } catch (e) { console.error('[kusto]', e); }
			reject(e);
		}
	});
};

// ── Window bridges for remaining legacy callers ──
// Execution, comparison, and optimization bridges are in queryBoxes-execution.ts.



