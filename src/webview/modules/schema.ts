// Schema module — converted from legacy/schema.js
// Window bridge exports at bottom for remaining legacy callers.
export {};

import { buildSchemaInfo } from '../shared/schema-utils';

const _win = window;

function setSchemaLoading(boxId: string, loading: boolean): void {
	(_win.schemaFetchInFlightByBoxId as any)[boxId] = !!loading;

	// Delegate to Lit element.
	const kwEl = typeof (_win.__kustoGetQuerySectionElement) === 'function'
		? (_win.__kustoGetQuerySectionElement as any)(boxId) : null;
	if (kwEl && typeof kwEl.setSchemaInfo === 'function') {
		if (loading) {
			kwEl.setSchemaInfo({ status: 'loading', statusText: 'Loading\u2026' });
		}
	}
}

function setSchemaLoadedSummary(boxId: string, text: string, title: string, isError: boolean, meta?: any): void {
	// Delegate to Lit element.
	const kwEl = typeof (_win.__kustoGetQuerySectionElement) === 'function'
		? (_win.__kustoGetQuerySectionElement as any)(boxId) : null;
	if (kwEl && typeof kwEl.setSchemaInfo === 'function') {
		kwEl.setSchemaInfo(buildSchemaInfo(text, isError, meta));
	}
}

function ensureSchemaForBox(boxId: string, forceRefresh?: boolean): void {
	if (!boxId) {
		return;
	}
	if (!forceRefresh && (_win.schemaByBoxId as any)[boxId]) {
		return;
	}
	if ((_win.schemaFetchInFlightByBoxId as any)[boxId]) {
		return;
	}
	const now = Date.now();
	const last = (_win.lastSchemaRequestAtByBoxId as any)[boxId] || 0;
	// Avoid spamming schema fetch requests if autocomplete is invoked repeatedly.
	if (!forceRefresh && now - last < 1500) {
		return;
	}
	(_win.lastSchemaRequestAtByBoxId as any)[boxId] = now;

	let ownerId = boxId;
	try {
		if (typeof (_win.__kustoGetSelectionOwnerBoxId) === 'function') {
			ownerId = (_win.__kustoGetSelectionOwnerBoxId as any)(boxId) || boxId;
		}
	} catch (e) { console.error('[kusto]', e); }
	const connectionId = typeof (_win.__kustoGetConnectionId) === 'function' ? (_win.__kustoGetConnectionId as any)(ownerId) : '';
	const database = typeof (_win.__kustoGetDatabase) === 'function' ? (_win.__kustoGetDatabase as any)(ownerId) : '';
	if (!connectionId || !database) {
		return;
	}

	setSchemaLoading(boxId, true);
	let requestToken = '';
	try {
		if (!_win.__kustoSchemaRequestTokenByBoxId || typeof _win.__kustoSchemaRequestTokenByBoxId !== 'object') {
			_win.__kustoSchemaRequestTokenByBoxId = {};
		}
		requestToken = 'schema_' + Date.now() + '_' + Math.random().toString(16).slice(2);
		(_win.__kustoSchemaRequestTokenByBoxId as any)[boxId] = requestToken;
	} catch (e) { console.error('[kusto]', e); }
	(_win.vscode as any).postMessage({
		type: 'prefetchSchema',
		connectionId,
		database,
		boxId,
		forceRefresh: !!forceRefresh,
		requestToken
	});
}

// Request database list for an arbitrary connectionId.
_win.__kustoRequestDatabases = async function (connectionId: string, forceRefresh?: boolean): Promise<any[]> {
	const cid = String(connectionId || '').trim();
	if (!cid) {
		return [];
	}
	try {
		let clusterKey = '';
		try {
			const conn = Array.isArray(_win.connections) ? (_win.connections as any[]).find((c: any) => c && String(c.id || '').trim() === cid) : null;
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

		const cachedDatabases = _win.cachedDatabases as any;
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
			let resolvers = _win.databasesRequestResolversByBoxId as any;
			if (!resolvers || typeof resolvers !== 'object') {
				resolvers = {};
				_win.databasesRequestResolversByBoxId = resolvers;
			}
			resolvers[requestId] = { resolve, reject };
		} catch {
			resolve([]);
			return;
		}

		try {
			(_win.vscode as any).postMessage({
				type: forceRefresh ? 'refreshDatabases' : 'getDatabases',
				connectionId: cid,
				boxId: requestId
			});
		} catch (e) {
			try { delete (_win.databasesRequestResolversByBoxId as any)[requestId]; } catch (e) { console.error('[kusto]', e); }
			reject(e);
		}
	});
};

function onDatabaseChanged(boxId: string): void {
	// Clear any prior schema so it matches the newly selected DB.
	delete (_win.schemaByBoxId as any)[boxId];
	// Clear request throttling/in-flight so we can fetch immediately for the new DB.
	try {
		if (_win.schemaFetchInFlightByBoxId) {
			(_win.schemaFetchInFlightByBoxId as any)[boxId] = false;
		}
		if (_win.lastSchemaRequestAtByBoxId) {
			(_win.lastSchemaRequestAtByBoxId as any)[boxId] = 0;
		}
		if (_win.__kustoSchemaRequestTokenByBoxId) {
			delete (_win.__kustoSchemaRequestTokenByBoxId as any)[boxId];
		}
	} catch (e) { console.error('[kusto]', e); }
	setSchemaLoadedSummary(boxId, '', '', false);
	// Persist selection immediately so VS Code Problems can reflect current schema context.
	try {
		if (!_win.__kustoRestoreInProgress) {
			const connectionId = typeof (_win.__kustoGetConnectionId) === 'function' ? (_win.__kustoGetConnectionId as any)(boxId) : '';
			const database = typeof (_win.__kustoGetDatabase) === 'function' ? (_win.__kustoGetDatabase as any)(boxId) : '';
			(_win.vscode as any).postMessage({
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
			(_win.__kustoUpdateSchemaForFocusedBox as any)(boxId);
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof (_win.__kustoUpdateFavoritesUiForBox) === 'function') {
			(_win.__kustoUpdateFavoritesUiForBox as any)(boxId);
		} else if (typeof (_win.__kustoUpdateFavoritesUiForAllBoxes) === 'function') {
			(_win.__kustoUpdateFavoritesUiForAllBoxes as any)();
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof (_win.__kustoUpdateRunEnabledForBox) === 'function') {
			(_win.__kustoUpdateRunEnabledForBox as any)(boxId);
		}
	} catch (e) { console.error('[kusto]', e); }
	try { if (typeof (_win.schedulePersist) === 'function') (_win.schedulePersist as any)(); } catch (e) { console.error('[kusto]', e); }
}

function refreshSchema(boxId: string): void {
	if (!boxId) {
		return;
	}

	// Update schema info UI via Lit element.
	try {
		const kwEl = typeof (_win.__kustoGetQuerySectionElement) === 'function'
			? (_win.__kustoGetQuerySectionElement as any)(boxId) : null;
		if (kwEl && typeof kwEl.setSchemaInfo === 'function') {
			kwEl.setSchemaInfo({ status: 'loading', statusText: 'Refreshing…' });
		}
	} catch (e) { console.error('[kusto]', e); }

	(_win.lastSchemaRequestAtByBoxId as any)[boxId] = 0;
	ensureSchemaForBox(boxId, true);
}

// Request schema for an arbitrary (connectionId, database) pair.
async function __kustoRequestSchema(connectionId: string, database: string, forceRefresh?: boolean): Promise<any> {
	try {
		const cid = String(connectionId || '').trim();
		const db = String(database || '').trim();
		if (!cid || !db) {
			return null;
		}
		const key = cid + '|' + db;
		try {
			const schemaByConnDb = _win.schemaByConnDb as any;
			if (!forceRefresh && schemaByConnDb && schemaByConnDb[key]) {
				return schemaByConnDb[key];
			}
		} catch (e) { console.error('[kusto]', e); }

		const reqBoxId = '__schema_req__' + Date.now() + '_' + Math.random().toString(16).slice(2);
		const p = new Promise((resolve, reject) => {
			try {
				(_win.schemaRequestResolversByBoxId as any)[reqBoxId] = { resolve, reject, key };
			} catch (e) {
				reject(e);
			}
		});
		try {
			(_win.vscode as any).postMessage({
				type: 'prefetchSchema',
				connectionId: cid,
				database: db,
				boxId: reqBoxId,
				forceRefresh: !!forceRefresh
			});
		} catch (e) {
			try { delete (_win.schemaRequestResolversByBoxId as any)[reqBoxId]; } catch (e) { console.error('[kusto]', e); }
			throw e;
		}
		return await p;
	} catch {
		return null;
	}
}

// ======================================================================
// Window bridge: expose globals for remaining legacy callers
// ======================================================================
_win.setSchemaLoading = setSchemaLoading;
_win.setSchemaLoadedSummary = setSchemaLoadedSummary;
_win.ensureSchemaForBox = ensureSchemaForBox;
_win.onDatabaseChanged = onDatabaseChanged;
_win.refreshSchema = refreshSchema;
_win.__kustoRequestSchema = __kustoRequestSchema;
