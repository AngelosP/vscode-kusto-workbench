// Connection, favorites & schema management — ReactiveController pattern.
// Extracted from modules/queryBoxes-connections.ts into a Lit ReactiveController
// that attaches to kw-query-section elements.
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { pState } from '../shared/persistence-state';
import { postMessageToHost } from '../shared/webview-messages';
import { schedulePersist } from '../core/persistence';
import {
	cachedDatabases,
	connections,
	favoritesModeByBoxId,
	pendingFavoriteSelectionByBoxId,
	queryEditors,
	getKustoEditorSchema,
	setKustoEditorSchema,
	schemaDiagnosticsTrustedByBoxId,
	schemaFetchInFlightByBoxId,
	lastSchemaRequestAtByBoxId,
	schemaByConnDb,
	getKustoSchemaMetadata,
	setKustoSchemaMetadata,
	schemaMetaByConnDb,
	databaseRequestTokenByBoxId,
	missingClusterDetectTimersByBoxId,
	lastQueryTextByBoxId,
	missingClusterUrlsByBoxId,
	suggestedDatabaseByClusterKeyByBoxId,
	kustoFavorites,
	lastConnectionId,
	lastDatabase,
	queryBoxes,
	optimizationMetadataByBoxId,
	beginKustoPreparation,
	failKustoPreparation,
	getKustoPreparationState,
	getKustoPreparationToken,
	invalidateSchemaWorkerReadinessForBox,
	requireSchemaWorkerApply,
	requestKustoSchemaApplyForBox,
	setKustoPreparationIdle,
	updateKustoPreparation,
	type KustoPreparationToken,
} from '../core/state';
import { buildSchemaInfo } from '../shared/schema-utils';
import { syncSelectBackedDropdown } from '../core/dropdown';
import {
	formatClusterDisplayName,
	formatClusterShortName,
	canonicalKustoClusterKey,
	extractClusterUrlsFromQueryText,
	extractClusterDatabaseHintsFromQueryText,
	computeMissingClusterUrls as _computeMissing,
	favoriteKey as __kustoFavoriteKey,
	findFavorite as __kustoFindFavorite_pure,
	getFavoritesSorted as __kustoGetFavoritesSorted_pure,
	parseKustoExplorerConnectionsXml as parseKustoExplorerConnectionsXmlPure,
	findConnectionIdForClusterUrl as _findConnIdPure,
} from '../shared/clusterUtils';
import { escapeHtml } from '../core/utils';
import { getKustoConnectionIdentityKey, getKustoSchemaIdentityKey } from '../../shared/kustoAuth.js';
import type { KustoEditorLifecycleIdentity } from '../../shared/kustoSchemaLifecycle.js';
import {
	__kustoGetQuerySectionElement,
	__kustoGetConnectionId,
	__kustoGetDatabase,
	__kustoGetClusterUrl,
	synchronizeKustoSectionTarget,
} from '../core/query-section-accessors';
import { schemaRequestTokenByBoxId } from '../core/kusto-schema-request-state';
import {
	kustoSyntheticDatabaseRequests,
	kustoSyntheticSchemaRequests,
} from '../core/kusto-synthetic-request-runtime.js';
import { kustoEditorSchemaCoordinator } from '../core/kusto-editor-schema-runtime.js';

const _win = window;

// ── Host interface (avoids circular import with kw-query-section.ts) ──────────

/** Minimal interface the controller needs from its host element. */
export interface QuerySectionHost extends ReactiveControllerHost, HTMLElement {
	boxId: string;
	getConnectionId(): string;
	getDatabase(): string;
	getDesiredDatabase?(): string;
	getClusterUrl(): string;
	setDatabases(databases: string[], desiredDb?: string): void;
	setRefreshLoading(loading: boolean): void;
	setDatabasesLoading(loading: boolean): void;
	setSchemaInfo(info: any): void;
	setFavorites(favorites: any[]): void;
	setFavoritesMode(mode: boolean): void;
	setDesiredClusterUrl(url: string): void;
	setDesiredDatabase(db: string): void;
	clearDesiredDatabase?(): void;
	setConnectionId(connectionId: string): void;
	setConnections(conns: any[], opts?: any): void;
	setSchemaLifecycleTarget(connectionId: string, database?: string): KustoEditorLifecycleIdentity | undefined;
	invalidateSchemaLifecycleTarget(): KustoEditorLifecycleIdentity | undefined;
	beginDatabaseLifecycleRequest(requestToken: string): (KustoEditorLifecycleIdentity & { requestToken: string }) | undefined;
	beginSchemaLifecycleRequest(requestToken: string): (KustoEditorLifecycleIdentity & { requestToken: string }) | undefined;
}

// ── Module-level state ────────────────────────────────────────────────────────

let __kustoAutoEnterFavoritesByBoxId: Record<string, { clusterUrl: string; database: string } | null> = Object.create(null);
let __kustoAutoEnterFavoritesForNewBoxByBoxId: Record<string, boolean> = Object.create(null);
let __kustoDidDefaultFirstBoxToFavorites = false;
let __kustoConfirmRemoveFavoriteCallbacksById: Record<string, ((ok: boolean) => void) | null> = Object.create(null);

function schemaIdentityKeyForConnection(connectionId: unknown, database: unknown): string {
	const id = String(connectionId || '').trim();
	const connection = (connections || []).find((candidate: any) => String(candidate?.id || '') === id);
	return getKustoSchemaIdentityKey(id, connection?.accountPartition, connection?.clusterUrl, database);
}

function syntheticConnectionOwner(connectionId: string): { accountPartition: string; connectionIdentity: string } | undefined {
	const connection = (connections || []).find((candidate: any) => String(candidate?.id || '') === connectionId);
	if (!connection) return undefined;
	try {
		const connectionIdentity = getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId);
		return connectionIdentity ? {
			accountPartition: String(connection.accountPartition || '').trim(),
			connectionIdentity,
		} : undefined;
	} catch {
		return undefined;
	}
}

// ── ReactiveController ────────────────────────────────────────────────────────

/**
 * Manages connection, database, favorites, missing-cluster, and schema concerns
 * for a single `<kw-query-section>` element.
 */
export class QueryConnectionController implements ReactiveController {
	host: QuerySectionHost;

	constructor(host: QuerySectionHost) {
		this.host = host;
		host.addController(this);
	}

	private beginDatabasePreparation(connectionId: string): KustoPreparationToken | undefined {
		return beginKustoPreparation(this.host.boxId, {
			stage: 'databases',
			blockers: ['databases'],
			target: { connectionId },
		});
	}

	private retireDatabaseRequestToken(responseRequestToken?: any): void {
		const receivedRequestToken = String(responseRequestToken || '');
		if (receivedRequestToken && databaseRequestTokenByBoxId[this.host.boxId] === receivedRequestToken) {
			delete databaseRequestTokenByBoxId[this.host.boxId];
		}
	}

	private ensureSchemaPreparation(connectionId: string, database: string, forceRefresh: boolean): KustoPreparationToken | undefined {
		const boxId = this.host.boxId;
		const current = getKustoPreparationState(boxId);
		const targetMatches = current.target.connectionId === connectionId && current.target.database === database;
		if (targetMatches && current.status === 'preparing' && (!forceRefresh || current.stage === 'refreshing')) {
			return getKustoPreparationToken(boxId);
		}
		if (!forceRefresh && targetMatches && current.status === 'ready') {
			return getKustoPreparationToken(boxId);
		}
		if (!forceRefresh && targetMatches && current.status === 'deferred') {
			return getKustoPreparationToken(boxId);
		}
		const hasRawFallback = !!getKustoEditorSchema(boxId)?.rawSchemaJson;
		if (forceRefresh && targetMatches && current.status === 'ready' && hasRawFallback) {
			return getKustoPreparationToken(boxId);
		}
		return beginKustoPreparation(boxId, {
			stage: forceRefresh ? 'refreshing' : 'schema',
			blockers: ['schema', 'worker'],
			target: { connectionId, database },
			usableFallback: hasRawFallback,
		});
	}

	hostConnected(): void {
		// Lifecycle hook — no setup needed currently.
	}

	hostDisconnected(): void {
		// Clean up the missing-cluster debounce timer for this box.
		const id = this.host.boxId;
		if (id && missingClusterDetectTimersByBoxId[id]) {
			clearTimeout(missingClusterDetectTimersByBoxId[id]);
			delete missingClusterDetectTimersByBoxId[id];
		}
	}

	// ── Missing clusters ──────────────────────────────────────────────────────

	renderMissingClustersBanner(missingClusterUrls: any): void {
		const boxId = this.host.boxId;
		const banner = document.getElementById(boxId + '_missing_clusters') as any;
		const textEl = document.getElementById(boxId + '_missing_clusters_text') as any;
		if (!banner || !textEl) return;
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

	updateMissingClusters(queryText: any): void {
		const boxId = this.host.boxId;
		try {
			lastQueryTextByBoxId[boxId] = String(queryText || '');
		} catch (e) { console.error('[kusto]', e); }
		try {
			suggestedDatabaseByClusterKeyByBoxId[boxId] = extractClusterDatabaseHintsFromQueryText(queryText);
		} catch (e) { console.error('[kusto]', e); }
		const detected = extractClusterUrlsFromQueryText(queryText);
		const missing = computeMissingClusterUrls(detected);
		try { missingClusterUrlsByBoxId[boxId] = missing; } catch (e) { console.error('[kusto]', e); }
		this.renderMissingClustersBanner(missing);
	}

	onQueryValueChanged(queryText: any): void {
		const boxId = this.host.boxId;
		if (!boxId) return;
		try { lastQueryTextByBoxId[boxId] = String(queryText || ''); } catch (e) { console.error('[kusto]', e); }
		try {
			if (missingClusterDetectTimersByBoxId[boxId]) {
				clearTimeout(missingClusterDetectTimersByBoxId[boxId]);
			}
			missingClusterDetectTimersByBoxId[boxId] = setTimeout(() => {
				try { this.updateMissingClusters(lastQueryTextByBoxId[boxId] || ''); } catch (e) { console.error('[kusto]', e); }
			}, 260);
		} catch (e) { console.error('[kusto]', e); }
	}

	// ── Favorites ─────────────────────────────────────────────────────────────

	markNewBoxForFavoritesAutoEnter(): void {
		const id = this.host.boxId;
		if (!id) return;
		try {
			if (typeof pState.restoreInProgress === 'boolean' && pState.restoreInProgress) return;
		} catch (e) { console.error('[kusto]', e); }
		try {
			__kustoAutoEnterFavoritesForNewBoxByBoxId[id] = true;
		} catch (e) { console.error('[kusto]', e); }
	}

	tryAutoEnterFavoritesModeForNewBox(): void {
		const id = this.host.boxId;
		if (!id) return;
		let pending = false;
		try { pending = !!(__kustoAutoEnterFavoritesForNewBoxByBoxId && __kustoAutoEnterFavoritesForNewBoxByBoxId[id]); } catch { pending = false; }
		if (!pending) return;
		try {
			if (favoritesModeByBoxId && Object.prototype.hasOwnProperty.call(favoritesModeByBoxId, id)) {
				try { delete __kustoAutoEnterFavoritesForNewBoxByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
				return;
			}
		} catch (e) { console.error('[kusto]', e); }
		const hasAny = Array.isArray(kustoFavorites) && kustoFavorites.length > 0;
		if (!hasAny) return;
		const connectionId = this.host.getConnectionId();
		const db = this.host.getDatabase();
		if (!connectionId || !db) return;
		const fav = __kustoFindFavorite(connectionId, db);
		try {
			if (fav) {
				this.applyFavoritesMode(true);
				this.updateFavoritesUi();
			}
		} catch (e) { console.error('[kusto]', e); }
		try { delete __kustoAutoEnterFavoritesForNewBoxByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
	}

	setAutoEnterFavorites(clusterUrl: any, database: any): void {
		const id = this.host.boxId;
		if (!id) return;
		const c = String(clusterUrl || '').trim();
		const d = String(database || '').trim();
		if (!c || !d) return;
		try {
			__kustoAutoEnterFavoritesByBoxId[id] = { clusterUrl: c, database: d };
		} catch (e) { console.error('[kusto]', e); }
	}

	tryAutoEnterFavoritesMode(): void {
		const id = this.host.boxId;
		if (!id) return;
		let desired: { clusterUrl: string; database: string } | null = null;
		try {
			desired = __kustoAutoEnterFavoritesByBoxId && __kustoAutoEnterFavoritesByBoxId[id]
				? __kustoAutoEnterFavoritesByBoxId[id]
				: null;
		} catch { desired = null; }
		if (!desired) return;
		const hasAny = Array.isArray(kustoFavorites) && kustoFavorites.length > 0;
		if (!hasAny) return;
		const fav = __kustoFindFavorite(this.host.getConnectionId(), desired.database);
		if (!fav) {
			try {
				const isInFavMode = !!(favoritesModeByBoxId && favoritesModeByBoxId[id]);
				if (isInFavMode) this.applyFavoritesMode(false);
			} catch (e) { console.error('[kusto]', e); }
			try { delete __kustoAutoEnterFavoritesByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
			return;
		}
		try { this.applyFavoritesMode(true); } catch (e) { console.error('[kusto]', e); }
		try { delete __kustoAutoEnterFavoritesByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
	}

	tryApplyPendingFavoriteSelection(): boolean {
		const id = this.host.boxId;
		if (!id) return false;
		let pending: any = null;
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
		if (!connectionId) return false;
		let ownerId = id;
		try {
			ownerId = (typeof _win.__kustoGetSelectionOwnerBoxId === 'function')
				? (_win.__kustoGetSelectionOwnerBoxId(id) || id)
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
					detail: { boxId: tid, connectionId: connectionId, clusterUrl: clusterUrl, source: 'user' },
					bubbles: true, composed: true,
				}));
			} catch (e) { console.error('[kusto]', e); }
		};
		applyToBox(ownerId);
		if (ownerId !== id) applyToBox(id);
		try { delete pendingFavoriteSelectionByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
		return true;
	}

	updateFavoritesUi(): void {
		const host = this.host;
		if (typeof host.setFavorites === 'function') {
			host.setFavorites(Array.isArray(kustoFavorites) ? kustoFavorites : []);
		}
	}

	applyFavoritesMode(enabled: boolean): void {
		const id = this.host.boxId;
		favoritesModeByBoxId[id] = !!enabled;
		if (typeof this.host.setFavoritesMode === 'function') {
			this.host.setFavoritesMode(!!enabled);
		}
	}

	toggleFavorite(): void {
		const id = this.host.boxId;
		if (!id) return;
		const connectionId = this.host.getConnectionId();
		const clusterUrl = this.host.getClusterUrl();
		const database = this.host.getDatabase();
		if (!connectionId || !clusterUrl || !database) return;
		const existing = __kustoFindFavorite(connectionId, database);
		if (existing) {
			postMessageToHost({ type: 'removeFavorite', connectionId, clusterUrl, database, boxId: id });
		} else {
			postMessageToHost({ type: 'requestAddFavorite', connectionId, clusterUrl, database, boxId: id });
		}
	}

	// ── Missing cluster connections ───────────────────────────────────────────

	addMissingClusterConnections(): void {
		const id = this.host.boxId;
		if (!id) return;
		const missing = missingClusterUrlsByBoxId[id];
		const clusters = Array.isArray(missing) ? missing.slice() : [];
		if (!clusters.length) return;
		try {
			const hasSelection = !!this.host.getConnectionId();
			if (!hasSelection) {
				const hints = suggestedDatabaseByClusterKeyByBoxId && suggestedDatabaseByClusterKeyByBoxId[id]
					? suggestedDatabaseByClusterKeyByBoxId[id]
					: {};
				let chosenClusterUrl = '';
				let chosenDb = '';
				for (const u of clusters) {
					const key = canonicalKustoClusterKey(u);
					const db = key && hints ? String((hints as any)[key] || '') : '';
					if (db) {
						chosenClusterUrl = String(u || '').trim();
						chosenDb = db;
						break;
					}
				}
				if (!chosenClusterUrl) {
					chosenClusterUrl = String(clusters[0] || '').trim();
					const key0 = canonicalKustoClusterKey(chosenClusterUrl);
					chosenDb = key0 && hints ? String((hints as any)[key0] || '') : '';
				}
				if (typeof this.host.setDesiredClusterUrl === 'function') this.host.setDesiredClusterUrl(chosenClusterUrl);
				if (chosenDb && typeof this.host.setDesiredDatabase === 'function') this.host.setDesiredDatabase(chosenDb);
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

	// ── Connection & database selectors ───────────────────────────────────────

	promptAddConnection(): void {
		try { postMessageToHost({ type: 'promptAddConnection', boxId: this.host.boxId }); } catch (e) { console.error('[kusto]', e); }
	}

	importConnectionsFromXmlFile(): void {
		try {
			postMessageToHost({ type: 'promptImportConnectionsXml', boxId: this.host.boxId });
		} catch (e: any) {
			try { postMessageToHost({ type: 'showInfo', message: 'Failed to open file picker: ' + (e && e.message ? e.message : String(e)) }); } catch (e) { console.error('[kusto]', e); }
		}
	}

	refreshDatabases(): void {
		const connectionId = this.host.getConnectionId();
		if (!connectionId) return;
		const requestToken = 'databases_' + Date.now() + '_' + Math.random().toString(16).slice(2);
		databaseRequestTokenByBoxId[this.host.boxId] = requestToken;
		const lifecycle = this.host.beginDatabaseLifecycleRequest(requestToken);
		if (!this.host.getDatabase()) {
			this.beginDatabasePreparation(connectionId);
		}
		this.host.setRefreshLoading(true);
		this.host.setDatabasesLoading(true);
		postMessageToHost({
			type: 'refreshDatabases',
			connectionId,
			boxId: this.host.boxId,
			requestToken,
			requiredDatabase: String(this.host.getDesiredDatabase?.() || ''),
			...(lifecycle ? {
				sectionInstanceId: lifecycle.sectionInstanceId,
				targetGeneration: lifecycle.targetGeneration,
			} : {}),
		});
	}

	onDatabasesError(error: any, responseConnectionId: any, responseRequestToken?: any): void {
		const boxId = this.host.boxId;
		const expectedRequestToken = String(databaseRequestTokenByBoxId[boxId] || '');
		const receivedRequestToken = String(responseRequestToken || '');
		if ((expectedRequestToken || receivedRequestToken) && receivedRequestToken !== expectedRequestToken) return;
		const errText = String(error || '');
		const isEnotfound = /\bENOTFOUND\b/i.test(errText) || /getaddrinfo\s+ENOTFOUND/i.test(errText);
		if (responseConnectionId) {
			const currentConnectionId = this.host.getConnectionId();
			const responseConnId = String(responseConnectionId || '').trim();
			if (currentConnectionId && responseConnId && currentConnectionId !== responseConnId) {
				this.retireDatabaseRequestToken(responseRequestToken);
				this.host.setRefreshLoading(false);
				this.host.setDatabasesLoading(false);
				const refreshBtn = document.getElementById(boxId + '_refresh') as any;
				if (refreshBtn) {
					try {
						if (refreshBtn.dataset && (refreshBtn.dataset.kustoRefreshDbInFlight === '1' || refreshBtn.dataset.kustoAutoDbInFlight === '1')) {
							const prev = refreshBtn.dataset.kustoPrevHtml;
							if (typeof prev === 'string' && prev) refreshBtn.innerHTML = prev;
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
						if (typeof prevHtml === 'string' && prevHtml) databaseSelect.innerHTML = prevHtml;
						if (typeof prevValue === 'string') databaseSelect.value = prevValue;
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
						if (typeof prev === 'string' && prev) refreshBtn.innerHTML = prev;
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
			this.host.setRefreshLoading(false);
			this.host.setDatabasesLoading(false);
		} catch (e) { console.error('[kusto]', e); }
		const preparation = getKustoPreparationState(boxId);
		if (preparation.status === 'preparing' && preparation.blockers.includes('databases')) {
			failKustoPreparation(getKustoPreparationToken(boxId), 'Failed to load databases.');
		}
		this.retireDatabaseRequestToken(responseRequestToken);
		try {
			if (typeof _win.__kustoUpdateRunEnabledForBox === 'function') {
				_win.__kustoUpdateRunEnabledForBox(boxId);
			}
		} catch (e) { console.error('[kusto]', e); }
	}

	updateDatabaseSelect(databases: any, responseConnectionId: any, responseRequestToken?: any, responseAuthoritative?: any, responseFallback?: any): void {
		const boxId = this.host.boxId;
		const expectedRequestToken = String(databaseRequestTokenByBoxId[boxId] || '');
		const receivedRequestToken = String(responseRequestToken || '');
		if ((expectedRequestToken || receivedRequestToken) && receivedRequestToken !== expectedRequestToken) return;
		if (responseConnectionId) {
			const currentConnectionId = this.host.getConnectionId();
			const responseConnId = String(responseConnectionId || '').trim();
			if (currentConnectionId && responseConnId && currentConnectionId !== responseConnId) {
				this.retireDatabaseRequestToken(responseRequestToken);
				this.host.setRefreshLoading(false);
				return;
			}
		}
		const list = (Array.isArray(databases) ? databases : [])
			.map((d: any) => String(d || '').trim())
			.filter(Boolean)
			.sort((a: any, b: any) => a.toLowerCase().localeCompare(b.toLowerCase()));
		const connectionId = this.host.getConnectionId();
		if (connectionId) {
			cachedDatabases[String(connectionId).trim()] = list;
		}
		this.host.setDatabases(list, lastDatabase || '');
		this.host.setRefreshLoading(false);
		const preparation = getKustoPreparationState(boxId);
		if (preparation.status === 'preparing' && preparation.blockers.includes('databases')) {
			const unresolvedDesiredDatabase = String(this.host.getDesiredDatabase?.() || '');
			if (unresolvedDesiredDatabase) {
				if (responseFallback === true) {
					failKustoPreparation(getKustoPreparationToken(boxId), `Failed to verify database "${unresolvedDesiredDatabase}" against the live cluster.`);
				} else if (responseAuthoritative !== false) {
					failKustoPreparation(getKustoPreparationToken(boxId), `Database "${unresolvedDesiredDatabase}" is not available.`);
					this.host.clearDesiredDatabase?.();
				}
			} else if (!this.host.getDatabase()) {
				setKustoPreparationIdle(boxId);
			}
		}
		this.retireDatabaseRequestToken(responseRequestToken);
		try { this.tryAutoEnterFavoritesModeForNewBox(); } catch (e) { console.error('[kusto]', e); }
		try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		try {
			if (typeof _win.__kustoUpdateRunEnabledForBox === 'function') {
				_win.__kustoUpdateRunEnabledForBox(boxId);
			}
		} catch (e) { console.error('[kusto]', e); }
	}

	// ── Schema ────────────────────────────────────────────────────────────────

	ensureSchema(forceRefresh?: boolean): void {
		const boxId = this.host.boxId;
		if (!boxId) return;
		let ownerId = boxId;
		try {
			if (typeof (_win.__kustoGetSelectionOwnerBoxId) === 'function') {
				ownerId = _win.__kustoGetSelectionOwnerBoxId(boxId) || boxId;
			}
		} catch (e) { console.error('[kusto]', e); }
		const connectionId = __kustoGetConnectionId(ownerId);
		const database = __kustoGetDatabase(ownerId);
		if (!connectionId || !database) {
			setKustoPreparationIdle(boxId);
			return;
		}
		this.host.setSchemaLifecycleTarget(connectionId, database);
		let preparationToken = this.ensureSchemaPreparation(connectionId, database, !!forceRefresh);
		const preparationState = getKustoPreparationState(boxId);
		if (!forceRefresh && preparationState.status === 'ready'
			&& preparationState.target.connectionId === connectionId
			&& preparationState.target.database === database) {
			return;
		}
		if (!forceRefresh && getKustoEditorSchema(boxId)?.rawSchemaJson) {
			const meta = getKustoSchemaMetadata(boxId) || {};
			const needsRefresh = !!meta.isStale || meta.cacheState === 'stale' || meta.cacheState === 'outdated';
			if (!needsRefresh) {
				if (preparationToken) {
					updateKustoPreparation(preparationToken, {
						status: 'deferred',
						stage: 'waiting-focus',
						replaceBlockers: [],
						usableFallback: true,
						target: { schemaSignature: meta.schemaSignature },
					});
				}
				return;
			}
		}
		if (schemaFetchInFlightByBoxId[boxId]) return;
		const now = Date.now();
		const last = lastSchemaRequestAtByBoxId[boxId] || 0;
		if (!forceRefresh && now - last < 1500) return;
		lastSchemaRequestAtByBoxId[boxId] = now;

		try {
			const connDbKey = schemaIdentityKeyForConnection(connectionId, database);
			if (!forceRefresh && schemaByConnDb && schemaByConnDb[connDbKey]?.rawSchemaJson) {
				setKustoEditorSchema(boxId, schemaByConnDb[connDbKey]);
				setKustoSchemaMetadata(boxId, schemaMetaByConnDb[connDbKey] || {});
				const schema = getKustoEditorSchema(boxId);
				const meta = getKustoSchemaMetadata(boxId) || {};
				const tablesCount = meta.tablesCount ?? (schema?.tables?.length ?? 0);
				const columnsCount = meta.columnsCount ?? 0;
				const functionsCount = meta.functionsCount ?? (schema?.functions?.length ?? 0);
				this.host.setSchemaInfo(buildSchemaInfo(`${tablesCount} tables, ${columnsCount} cols${meta.fromCache ? ' (cached)' : ''}`, false,
					{ fromCache: !!meta.fromCache, tablesCount, columnsCount, functionsCount, hasRawSchemaJson: !!schema?.rawSchemaJson }));
				const needsRefresh = !!meta.isStale || meta.cacheState === 'stale' || meta.cacheState === 'outdated';
				if (preparationToken) {
					updateKustoPreparation(preparationToken, {
						status: needsRefresh ? 'preparing' : 'deferred',
						stage: needsRefresh ? 'refreshing' : 'waiting-focus',
						replaceBlockers: needsRefresh ? ['worker'] : [],
						usableFallback: true,
						target: { schemaSignature: meta.schemaSignature },
					});
				}
				if (!needsRefresh) return;
			}
		} catch (e) { console.error('[kusto]', e); }

		schemaFetchInFlightByBoxId[boxId] = true;
		try {
			this.host.setSchemaInfo({ status: 'loading', statusText: getKustoEditorSchema(boxId) ? 'Refreshing\u2026' : 'Loading\u2026' });
		} catch (e) { console.error('[kusto]', e); }

		let requestToken = '';
		let lifecycle: KustoEditorLifecycleIdentity | undefined;
		try {
			requestToken = 'schema_' + Date.now() + '_' + Math.random().toString(16).slice(2);
			schemaRequestTokenByBoxId[boxId] = requestToken;
			lifecycle = this.host.beginSchemaLifecycleRequest(requestToken);
			if (preparationToken) {
				updateKustoPreparation(preparationToken, { target: { requestToken } });
			}
		} catch (e) { console.error('[kusto]', e); }
		postMessageToHost({
			type: 'prefetchSchema',
			connectionId,
			database,
			boxId,
			forceRefresh: !!forceRefresh,
			requestToken,
			...(lifecycle ? {
				sectionInstanceId: lifecycle.sectionInstanceId,
				targetGeneration: lifecycle.targetGeneration,
			} : {}),
		});
	}

	onDatabaseChanged(source: string = ''): void {
		const boxId = this.host.boxId;
		const diagnosticsTrusted = schemaDiagnosticsTrustedByBoxId[boxId] !== false;
		const connectionId = this.host.getConnectionId();
		const database = this.host.getDatabase();
		this.host.setSchemaLifecycleTarget(connectionId, database);
		if (source === 'user') requireSchemaWorkerApply(boxId);
		invalidateLinkedComparisonSchemaForSource(boxId);
		try {
			if (schemaFetchInFlightByBoxId) schemaFetchInFlightByBoxId[boxId] = false;
			if (lastSchemaRequestAtByBoxId) lastSchemaRequestAtByBoxId[boxId] = 0;
			if (schemaRequestTokenByBoxId) delete schemaRequestTokenByBoxId[boxId];
		} catch (e) { console.error('[kusto]', e); }
		try {
			this.host.setSchemaInfo(buildSchemaInfo('', false));
		} catch (e) { console.error('[kusto]', e); }
		if (pState.restoreInProgress || !diagnosticsTrusted || !connectionId || !database) {
			setKustoPreparationIdle(boxId);
		} else {
			beginKustoPreparation(boxId, {
				stage: 'schema',
				blockers: ['schema', 'worker'],
				target: { connectionId, database },
			});
		}
		try {
			if (!pState.restoreInProgress) {
				const connectionId = this.host.getConnectionId();
				const database = this.host.getDatabase();
				if (diagnosticsTrusted) {
					postMessageToHost({
						type: 'saveLastSelection',
						connectionId: String(connectionId || ''),
						database: String(database || '')
					});
				}
			}
		} catch (e) { console.error('[kusto]', e); }
		if (!pState.restoreInProgress && diagnosticsTrusted) {
			this.ensureSchema(false);
		}
		// Only set the database-in-context when the user actually interacts.
		// During restore every section fires onDatabaseChanged sequentially;
		// calling __kustoUpdateSchemaForFocusedBox for each one races against
		// async schema responses and the last to arrive wins — which may not
		// be the section the user later clicks into.
		if (!pState.restoreInProgress && diagnosticsTrusted) {
			requestKustoSchemaApplyForBox(boxId);
		}
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

	refreshSchema(): void {
		const boxId = this.host.boxId;
		if (!boxId) return;
		try {
			this.host.setSchemaInfo({ status: 'loading', statusText: 'Refreshing\u2026' });
		} catch (e) { console.error('[kusto]', e); }
		const connectionId = this.host.getConnectionId();
		const database = this.host.getDatabase();
		if (connectionId && database) {
			const currentPreparation = getKustoPreparationState(boxId);
			const hasUsableFallback = currentPreparation.status === 'ready' && !!getKustoEditorSchema(boxId)?.rawSchemaJson;
			if (!hasUsableFallback) {
				beginKustoPreparation(boxId, {
					stage: 'refreshing',
					blockers: ['schema', 'worker'],
					target: { connectionId, database },
					usableFallback: false,
				});
			}
		}
		lastSchemaRequestAtByBoxId[boxId] = 0;
		this.ensureSchema(true);
	}
}

// ── Standalone functions (cross-box, pure utilities, facade wrappers) ─────────

export function invalidateLinkedComparisonSchemaForSource(sourceBoxId: string): void {
	try {
		const comparisonBoxId = String(optimizationMetadataByBoxId[sourceBoxId]?.comparisonBoxId || '').trim();
		if (!comparisonBoxId) return;
		synchronizeKustoSectionTarget(sourceBoxId, comparisonBoxId);
		schemaFetchInFlightByBoxId[comparisonBoxId] = false;
		lastSchemaRequestAtByBoxId[comparisonBoxId] = 0;
		delete schemaRequestTokenByBoxId[comparisonBoxId];
		delete databaseRequestTokenByBoxId[comparisonBoxId];
		requireSchemaWorkerApply(comparisonBoxId);
		invalidateSchemaWorkerReadinessForBox(comparisonBoxId);
	} catch (e) { console.error('[kusto]', e); }
}

export function computeMissingClusterUrls(detectedClusterUrls: any) {
	return _computeMissing(detectedClusterUrls, connections || []);
}

export function __kustoFindConnectionIdForClusterUrl(clusterUrl: any) {
	return _findConnIdPure(clusterUrl, connections || []);
}

export function __kustoGetCurrentClusterUrlForBox(boxId: any) {
	return __kustoGetClusterUrl(boxId);
}

export function __kustoGetCurrentDatabaseForBox(boxId: any) {
	return __kustoGetDatabase(boxId);
}

export function __kustoFindFavorite(connectionId: any, database: any) {
	return __kustoFindFavorite_pure(connectionId, database, Array.isArray(kustoFavorites) ? kustoFavorites : []);
}

// ── Facade functions — match old API signatures, delegate to controller ───────

export function updateMissingClustersForBox(boxId: any, queryText: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.connectionCtrl) {
		el.connectionCtrl.updateMissingClusters(queryText);
	}
}

export function __kustoMarkNewBoxForFavoritesAutoEnter(boxId: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.connectionCtrl) {
		el.connectionCtrl.markNewBoxForFavoritesAutoEnter();
	}
}

export function __kustoTryAutoEnterFavoritesModeForNewBox(boxId: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.connectionCtrl) {
		el.connectionCtrl.tryAutoEnterFavoritesModeForNewBox();
	}
}

export function __kustoSetAutoEnterFavoritesForBox(boxId: any, clusterUrl: any, database: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const c = String(clusterUrl || '').trim();
	const d = String(database || '').trim();
	if (!c || !d) return;
	// Write to module-level map; controller reads via tryAutoEnterFavoritesMode().
	__kustoAutoEnterFavoritesByBoxId[id] = { clusterUrl: c, database: d };
}

export function __kustoUpdateFavoritesUiForBox(boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const el = __kustoGetQuerySectionElement(id);
	if (el?.connectionCtrl) {
		el.connectionCtrl.updateFavoritesUi();
	}
}

export function __kustoSetFavoritesModeForBox(boxId: any, enabled: boolean) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const el = __kustoGetQuerySectionElement(id);
	if (el?.connectionCtrl) {
		el.connectionCtrl.applyFavoritesMode(!!enabled);
		el.connectionCtrl.updateFavoritesUi();
	}
}

export function __kustoUpdateFavoritesUiForAllBoxes() {
	try {
		queryBoxes.forEach((id: any) => {
			try { __kustoUpdateFavoritesUiForBox(id); } catch (e) { console.error('[kusto]', e); }
		});
	} catch (e) { console.error('[kusto]', e); }
}

export function toggleFavoriteForBox(boxId: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.connectionCtrl) {
		el.connectionCtrl.toggleFavorite();
	}
}


export function removeFavorite(connectionId: any, clusterUrl: any, database: any) {
	const id = String(connectionId || '').trim();
	const c = String(clusterUrl || '').trim();
	const d = String(database || '').trim();
	if (!id || !c || !d) return;
	postMessageToHost({ type: 'removeFavorite', connectionId: id, clusterUrl: c, database: d });
}

export function closeAllFavoritesDropdowns() {
	// no-op — Lit component handles its own dropdown lifecycle.
}

export function addMissingClusterConnections(boxId: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.connectionCtrl) {
		el.connectionCtrl.addMissingClusterConnections();
	}
}

export function updateConnectionSelects() {
	queryBoxes.forEach((id: any) => {
		const el = __kustoGetQuerySectionElement(id);
		if (el && typeof el.setConnections === 'function') {
			el.setConnections(connections || [], { lastConnectionId: lastConnectionId || '' });
		}
		try { __kustoUpdateFavoritesUiForBox(id); } catch (e) { console.error('[kusto]', e); }
	});
	try {
		if (typeof _win.__kustoUpdateRunEnabledForAllBoxes === 'function') {
			_win.__kustoUpdateRunEnabledForAllBoxes();
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function promptAddConnectionFromDropdown(boxId: any) {
	try { postMessageToHost({ type: 'promptAddConnection', boxId }); } catch (e) { console.error('[kusto]', e); }
}

export function importConnectionsFromXmlFile(boxId: any) {
	try {
		postMessageToHost({ type: 'promptImportConnectionsXml', boxId });
	} catch (e: any) {
		try { postMessageToHost({ type: 'showInfo', message: 'Failed to open file picker: ' + (e && e.message ? e.message : String(e)) }); } catch (e) { console.error('[kusto]', e); }
	}
}

export function parseKustoExplorerConnectionsXml(xmlText: any) {
	return parseKustoExplorerConnectionsXmlPure(xmlText);
}

export function refreshDatabases(boxId: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.connectionCtrl) {
		el.connectionCtrl.refreshDatabases();
	}
}

export function onDatabasesError(boxId: any, error: any, responseConnectionId: any, responseRequestToken?: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.connectionCtrl) {
		el.connectionCtrl.onDatabasesError(error, responseConnectionId, responseRequestToken);
	}
}

export function updateDatabaseSelect(boxId: any, databases: any, responseConnectionId: any, responseRequestToken?: any, responseAuthoritative?: any, responseFallback?: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.connectionCtrl) {
		el.connectionCtrl.updateDatabaseSelect(databases, responseConnectionId, responseRequestToken, responseAuthoritative, responseFallback);
	}
}

export function ensureSchemaForBox(boxId: string, forceRefresh?: boolean): void {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.connectionCtrl) {
		el.connectionCtrl.ensureSchema(forceRefresh);
	}
}

export function onDatabaseChanged(boxId: string, source: string = ''): void {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.connectionCtrl) {
		el.connectionCtrl.onDatabaseChanged(source);
	}
}

export function refreshSchema(boxId: string): void {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.connectionCtrl) {
		el.connectionCtrl.refreshSchema();
	}
}

// ── Cross-box coordination functions ──────────────────────────────────────────

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
					const el = __kustoGetQuerySectionElement(id);
					if (el?.connectionCtrl) el.connectionCtrl.tryApplyPendingFavoriteSelection();
				}
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	try { __kustoUpdateFavoritesUiForAllBoxes(); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoTryAutoEnterFavoritesModeForAllBoxes() {
	try {
		for (const id of (queryBoxes || [])) {
			try {
				const el = __kustoGetQuerySectionElement(id);
				if (el?.connectionCtrl) {
					el.connectionCtrl.tryAutoEnterFavoritesMode();
					el.connectionCtrl.tryAutoEnterFavoritesModeForNewBox();
				}
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoMaybeDefaultFirstBoxToFavoritesMode() {
	try {
		if (__kustoDidDefaultFirstBoxToFavorites) return;
		const hasAny = Array.isArray(kustoFavorites) && kustoFavorites.length > 0;
		if (!hasAny) return;
		if (!Array.isArray(queryBoxes) || queryBoxes.length !== 1) return;
		const id = String(queryBoxes[0] || '').trim();
		if (!id) return;
		try {
			if (favoritesModeByBoxId && Object.prototype.hasOwnProperty.call(favoritesModeByBoxId, id)) return;
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
			if (!desiredDb) desiredDb = __kustoGetDatabase(id);
			if (desiredCluster && desiredDb) {
				const fav = __kustoFindFavorite(__kustoGetConnectionId(id), desiredDb);
				if (!fav) {
					__kustoDidDefaultFirstBoxToFavorites = true;
					return;
				}
			}
		} catch (e) { console.error('[kusto]', e); }
		const el = __kustoGetQuerySectionElement(id);
		if (el?.connectionCtrl) {
			el.connectionCtrl.applyFavoritesMode(true);
			el.connectionCtrl.updateFavoritesUi();
		}
		__kustoDidDefaultFirstBoxToFavorites = true;
	} catch (e) { console.error('[kusto]', e); }
}

// ── Async schema/database requests (synthetic boxIds, no host element) ────────

export async function __kustoRequestSchema(connectionId: string, database: string, forceRefresh?: boolean): Promise<any> {
	try {
		const cid = String(connectionId || '').trim();
		const db = String(database || '').trim();
		if (!cid || !db) return null;
		const key = schemaIdentityKeyForConnection(cid, db);
		const owner = syntheticConnectionOwner(cid);
		if (!owner?.accountPartition || !key) return null;
		try {
			if (!forceRefresh && schemaByConnDb && schemaByConnDb[key]) return schemaByConnDb[key];
		} catch (e) { console.error('[kusto]', e); }
		const reqBoxId = '__schema_req__' + Date.now() + '_' + Math.random().toString(16).slice(2);
		const request = kustoSyntheticSchemaRequests.begin(reqBoxId, {
			connectionId: cid,
			database: db,
			schemaKey: key,
			...owner,
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
			kustoSyntheticSchemaRequests.cancel(reqBoxId, e);
		}
		return await request;
	} catch { return null; }
}

export async function __kustoRequestDatabases(connectionId: string): Promise<any[]> {
	const cid = String(connectionId || '').trim();
	if (!cid) return [];
	try {
		const cachedByConnectionId = cachedDatabases && cachedDatabases[cid];
		if (Array.isArray(cachedByConnectionId) && cachedByConnectionId.length) return cachedByConnectionId;
	} catch (e) { console.error('[kusto]', e); }
	const requestId = '__kusto_dbreq__' + encodeURIComponent(cid) + '__' + Date.now() + '_' + Math.random().toString(16).slice(2);
	const owner = syntheticConnectionOwner(cid);
	if (!owner) return [];
	const request = kustoSyntheticDatabaseRequests.begin(requestId, { connectionId: cid, ...owner });
	try {
		postMessageToHost({
			type: 'getDatabases',
			connectionId: cid,
			boxId: requestId
		});
	} catch (e) {
		kustoSyntheticDatabaseRequests.cancel(requestId, e);
	}
	try {
		return await request;
	} catch {
		return [];
	}
}

// ── Window bridges (module-scope, assigned at load time) ──────────────────────

_win.__kustoOnQueryValueChanged = function (boxId: any, queryText: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const el = __kustoGetQuerySectionElement(id);
	if (el?.connectionCtrl) {
		el.connectionCtrl.onQueryValueChanged(queryText);
	} else {
		// Fallback for boxes that haven't yet adopted the controller.
		try { lastQueryTextByBoxId[id] = String(queryText || ''); } catch (e) { console.error('[kusto]', e); }
	}
};

_win.__kustoOnConnectionsUpdated = __kustoOnConnectionsUpdated;

_win.__kustoSetAutoEnterFavoritesForBox = __kustoSetAutoEnterFavoritesForBox;

_win.__kustoTryAutoEnterFavoritesModeForAllBoxes = __kustoTryAutoEnterFavoritesModeForAllBoxes;

_win.__kustoMaybeDefaultFirstBoxToFavoritesMode = __kustoMaybeDefaultFirstBoxToFavoritesMode;

_win.__kustoOnConfirmRemoveFavoriteResult = function (message: any) {
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

_win.__kustoGetSelectionOwnerBoxId = function (boxId: any) {
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

_win.__kustoUpdateFavoritesUiForAllBoxes = __kustoUpdateFavoritesUiForAllBoxes;

_win.__kustoUpdateFavoritesUiForBox = __kustoUpdateFavoritesUiForBox;

_win.__kustoSetFavoritesModeForBox = __kustoSetFavoritesModeForBox;

_win.__kustoEnterFavoritesModeForBox = function (boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	try {
		const hasAny = Array.isArray(kustoFavorites) && kustoFavorites.length > 0;
		if (!hasAny) return;
		const el = __kustoGetQuerySectionElement(id);
		if (el?.connectionCtrl) {
			el.connectionCtrl.applyFavoritesMode(true);
			el.connectionCtrl.updateFavoritesUi();
		}
	} catch (e) { console.error('[kusto]', e); }
};
