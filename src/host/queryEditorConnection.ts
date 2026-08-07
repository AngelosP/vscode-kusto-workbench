import * as vscode from 'vscode';

import { ConnectionManager, KustoConnection } from './connectionManager';
import { KustoQueryClient } from './kustoClient';
import { extractKqlSchemaMatchTokens, scoreSchemaMatch } from './kqlSchemaInference';
import { kustoClusterKey, kustoDatabaseKey } from '../shared/kustoClusterUrls';
import { schemaCacheKey } from './schemaCache';
import { KustoConnectionCache } from './kustoConnectionCache';
import { KustoAuthPreferenceService } from './kustoAuthPreferenceService';
import { getKustoConnectionIdentityKey, normalizeKustoAuthorityId } from '../shared/kustoAuth';
import { filterKustoFavoritesForActivePrincipals, mergeKustoFavoritesForActivePrincipals, migrateKustoFavoritesWithStatus } from './connectionManagerFavorites';
import {
	STORAGE_KEYS,
	KustoFavorite,
	CachedSchemaEntry,
	IncomingWebviewMessage
} from './queryEditorTypes';
import { getWorkbenchLogger, type WorkbenchLogger } from './workbenchLogger';
import {
	createDatabaseListTraceId,
	getDatabaseListErrorDetails,
	traceDatabaseList,
} from './databaseListTrace';
import type { KustoEditorLifecycleIdentity } from '../shared/kustoSchemaLifecycle';

export let testIsolateKustoConnections = false;

type DatabaseDiscoveryRequest =
	| ({ mode: 'passive'; requestToken?: string; requiredDatabase?: string } & Partial<KustoEditorLifecycleIdentity>)
	| ({ mode: 'interactive-refresh'; requestToken?: string; requiredDatabase?: string } & Partial<KustoEditorLifecycleIdentity>);

type ZeroResultRecoveryOutcome =
	| { kind: 'dismissed' }
	| { kind: 'fetched'; databases: string[] };

type DatabaseFetchResult = { databases: string[]; accountPartition?: string };

function isDatabaseDiscoveryCancellation(error: unknown): boolean {
	const pending: unknown[] = [error];
	const seen = new Set<unknown>();
	while (pending.length > 0 && seen.size < 12) {
		const candidate = pending.shift();
		if (!candidate || seen.has(candidate)) {
			continue;
		}
		seen.add(candidate);
		if (typeof candidate !== 'object' && typeof candidate !== 'function') {
			continue;
		}
		try {
			const record = candidate as Record<string, unknown>;
			const name = typeof record.name === 'string' ? record.name : '';
			const message = typeof record.message === 'string' ? record.message : '';
			if (record.isCancelled === true || name === 'QueryCancelledError') {
				return true;
			}
			if (/\b(?:sign[ -]?in cancelled|user cancel(?:l)?ed authentication|user did not consent|did not consent|consent denied)\b/i.test(message)) {
				return true;
			}
		} catch {
			// Continue through the bounded error graph.
		}
		for (const key of ['cause', 'innerError', 'error', 'originalError']) {
			try {
				const nested = (candidate as Record<string, unknown>)[key];
				if (nested) {
					pending.push(nested);
				}
			} catch {
				// Ignore malformed SDK error properties.
			}
		}
	}
	return false;
}

export function setTestIsolateKustoConnections(enabled: boolean): void {
	testIsolateKustoConnections = !!enabled;
}


// ── Pure utility functions (no instance state needed) ──

export function ensureHttpsUrl(url: string): string {
	const raw = String(url || '').trim();
	if (!raw) {
		return '';
	}
	if (/^https?:\/\//i.test(raw)) {
		return raw;
	}
	return `https://${raw.replace(/^\/+/, '')}`;
}

export function getDefaultConnectionName(clusterUrl: string): string {
	try {
		const withScheme = ensureHttpsUrl(clusterUrl);
		const u = new URL(withScheme);
		return u.hostname || withScheme;
	} catch {
		return String(clusterUrl || '').trim() || 'Kusto Cluster';
	}
}

export function getClusterShortName(clusterUrl: string): string {
	try {
		const withScheme = ensureHttpsUrl(clusterUrl);
		const u = new URL(withScheme);
		const host = String(u.hostname || '').trim();
		if (!host) {
			return getDefaultConnectionName(clusterUrl);
		}
		return host.split('.')[0] || host;
	} catch {
		return getDefaultConnectionName(clusterUrl);
	}
}

export function getClusterShortNameKey(clusterUrl: string): string {
	return kustoClusterKey(clusterUrl);
}

export function getClusterCacheKey(clusterUrlRaw: string): string {
	return kustoClusterKey(clusterUrlRaw);
}

export function normalizeFavoriteClusterUrl(clusterUrl: string): string {
	const normalized = ensureHttpsUrl(String(clusterUrl || '').trim());
	return normalized.replace(/\/+$/g, '');
}


// ── ConnectionServiceHost interface ──

export interface ConnectionServiceHost {
	readonly connectionManager: ConnectionManager;
	readonly context: vscode.ExtensionContext;
	readonly kustoClient: KustoQueryClient;
	readonly output: WorkbenchLogger;
	postMessage(message: unknown): Thenable<boolean> | PromiseLike<boolean> | void;
	postKustoPublication?(message: unknown): Promise<boolean>;
	formatQueryExecutionErrorForUser(error: unknown, connection: KustoConnection, database?: string): string;
	normalizeClusterUrlKey(url: string): string;
	getCachedSchemaFromDisk(cacheKey: string): Promise<CachedSchemaEntry | undefined>;
}


// ── ConnectionService class ──

export class ConnectionService {
	private static readonly liveServices = new Set<ConnectionService>();
	private static readonly kustoFavoritesListeners = new Set<(context: vscode.ExtensionContext) => void | PromiseLike<void>>();
	private static readonly zeroResultRecoveryByCluster = new Map<string, Promise<ZeroResultRecoveryOutcome>>();
	private static readonly databaseCacheSettlementByCluster = new Map<string, Promise<void>>();

	private lastConnectionId?: string;
	private lastDatabase?: string;
	private readonly connectionCache: KustoConnectionCache;
	private readonly authPreferences: KustoAuthPreferenceService;
	private disposed = false;
	/** Tracks when we last showed a DB-load error notification per cluster (to avoid spamming). */
	private lastDbErrorNotificationByCluster = new Map<string, number>();

	private traceDatabaseList(traceId: string, event: string, details: Record<string, unknown> = {}): void {
		traceDatabaseList(this.host.output, traceId, 'service', event, details);
	}

	private static async withDatabaseCacheSettlement<T>(clusterKey: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.databaseCacheSettlementByCluster.get(clusterKey) ?? Promise.resolve();
		let release!: () => void;
		const lock = new Promise<void>((resolve) => { release = resolve; });
		const tail = previous.catch(() => undefined).then(() => lock);
		this.databaseCacheSettlementByCluster.set(clusterKey, tail);
		await previous.catch(() => undefined);
		try {
			return await operation();
		} finally {
			release();
			if (this.databaseCacheSettlementByCluster.get(clusterKey) === tail) {
				this.databaseCacheSettlementByCluster.delete(clusterKey);
			}
		}
	}

	constructor(private readonly host: ConnectionServiceHost) {
		this.connectionCache = new KustoConnectionCache(host.context);
		this.authPreferences = KustoAuthPreferenceService.getInstance(host.context);
		void this.connectionCache.migrateLegacy(host.connectionManager.getConnections());
		this.activate();
		this.loadLastSelection();
	}

	private getResolvedAccountPartition(connection: KustoConnection): string | undefined {
		const resolver = (this.host.kustoClient as unknown as { getAccountPartition?: (candidate: KustoConnection) => string | undefined }).getAccountPartition;
		if (typeof resolver === 'function') return resolver.call(this.host.kustoClient, connection);
		const accountId = this.authPreferences.getPreferredAccountId(connection.id);
		return accountId ? this.authPreferences.getAccountPartition(connection.authorityId, accountId) : undefined;
	}

	activate(): void {
		this.disposed = false;
		ConnectionService.liveServices.add(this);
	}

	dispose(): void {
		this.disposed = true;
		ConnectionService.liveServices.delete(this);
	}

	// ── Last selection ──

	private loadLastSelection(): void {
		this.lastConnectionId = this.host.context.globalState.get<string>(STORAGE_KEYS.lastConnectionId);
		this.lastDatabase = this.host.context.globalState.get<string>(STORAGE_KEYS.lastDatabase);
	}

	async saveLastSelection(connectionId: string, database?: string): Promise<void> {
		this.lastConnectionId = connectionId;
		this.lastDatabase = database;
		await this.host.context.globalState.update(STORAGE_KEYS.lastConnectionId, connectionId);
		await this.host.context.globalState.update(STORAGE_KEYS.lastDatabase, database);
	}

	getLastConnectionId(): string | undefined {
		return this.lastConnectionId;
	}

	getLastDatabase(): string | undefined {
		return this.lastDatabase;
	}

	// ── Connection lookup ──

	findConnection(connectionId: string): KustoConnection | undefined {
		return this.host.connectionManager.getConnections().find((c) => c.id === connectionId);
	}

	// ── Favorites ──
	private getFavoriteAccountPartitions(): Map<string, string | undefined> {
		return new Map(this.host.connectionManager.getConnections().map(connection => [connection.id, this.getResolvedAccountPartition(connection)]));
	}

	getFavorites(): KustoFavorite[] {
		const raw = this.host.context.globalState.get<unknown>(STORAGE_KEYS.favorites);
		const partitions = this.getFavoriteAccountPartitions();
		const { favorites, unresolved } = migrateKustoFavoritesWithStatus(raw, this.host.connectionManager.getConnections(), partitions);
		if (unresolved === 0 && JSON.stringify(raw ?? []) !== JSON.stringify(favorites)) void this.host.context.globalState.update(STORAGE_KEYS.favorites, favorites);
		return filterKustoFavoritesForActivePrincipals(favorites, partitions);
	}

	private favoriteKey(connectionId: string, database: string): string {
		const c = String(connectionId || '').trim();
		const d = String(database || '').trim().toLowerCase();
		return `${c}|${d}`;
	}

	private async setFavorites(
		favorites: KustoFavorite[],
		boxId?: string,
		expectedOwner?: { connectionId: string; accountPartition?: string },
	): Promise<void> {
		const raw = this.host.context.globalState.get<unknown>(STORAGE_KEYS.favorites);
		const partitions = this.getFavoriteAccountPartitions();
		if (expectedOwner && partitions.get(expectedOwner.connectionId) !== expectedOwner.accountPartition) return;
		const allFavorites = migrateKustoFavoritesWithStatus(raw, this.host.connectionManager.getConnections(), partitions).favorites;
		await this.host.context.globalState.update(STORAGE_KEYS.favorites, mergeKustoFavoritesForActivePrincipals(allFavorites, favorites, partitions));
		ConnectionService.broadcastKustoFavoritesData(this.host.context, boxId, this);
	}

	static broadcastKustoFavoritesData(context: vscode.ExtensionContext, originatingBoxId?: string, originatingService?: ConnectionService): void {
		for (const service of ConnectionService.liveServices) {
			if (service.disposed) {
				ConnectionService.liveServices.delete(service);
				continue;
			}
			if (!service.sharesFavoriteStorageWithContext(context)) {
				continue;
			}
			void service
				.sendFavoritesData(service === originatingService ? originatingBoxId : undefined)
				.catch((error: unknown) => service.logFavoritesBroadcastError(error));
		}
		for (const listener of ConnectionService.kustoFavoritesListeners) {
			try {
				void Promise.resolve(listener(context)).catch((error: unknown) => {
					try { getWorkbenchLogger().warn('[favorites] Failed to notify Kusto favorites listener', error); } catch {
						// ignore logging failures
					}
				});
			} catch (error) {
				try { getWorkbenchLogger().warn('[favorites] Failed to notify Kusto favorites listener', error); } catch {
					// ignore logging failures
				}
			}
		}
	}

	static onKustoFavoritesChanged(listener: (context: vscode.ExtensionContext) => void | PromiseLike<void>): vscode.Disposable {
		ConnectionService.kustoFavoritesListeners.add(listener);
		return { dispose: () => { ConnectionService.kustoFavoritesListeners.delete(listener); } };
	}

	private sharesFavoriteStorageWithContext(context: vscode.ExtensionContext): boolean {
		if (this.host.context === context) {
			return true;
		}
		try {
			return this.host.context.globalState.get<unknown>(STORAGE_KEYS.favorites) === context.globalState.get<unknown>(STORAGE_KEYS.favorites);
		} catch {
			return false;
		}
	}

	private logFavoritesBroadcastError(error: unknown): void {
		try { this.host.output.warn(`[favorites] Failed to broadcast favoritesData: ${error instanceof Error ? error.message : String(error)}`); } catch {
			// ignore logging failures
		}
	}

	private async sendFavoritesData(boxId?: string): Promise<void> {
		const payload: any = { type: 'favoritesData', favorites: this.getFavorites() };
		if (boxId) {
			payload.boxId = boxId;
		}
		await Promise.resolve(this.host.postMessage(payload));
	}

	async promptAddFavorite(
		message: Extract<IncomingWebviewMessage, { type: 'requestAddFavorite' }>
	): Promise<void> {
		const clusterUrlRaw = String(message.clusterUrl || '').trim();
		const connectionId = String(message.connectionId || '').trim();
		const databaseRaw = String(message.database || '').trim();
		if (!connectionId || !clusterUrlRaw || !databaseRaw) {
			return;
		}
		const clusterUrl = normalizeFavoriteClusterUrl(clusterUrlRaw);
		const database = databaseRaw;
		const connection = this.findConnection(connectionId);
		const startingAccountPartition = connection ? this.getResolvedAccountPartition(connection) : undefined;
		const defaultName =
			String(message.defaultName || '').trim() || `${getClusterShortName(clusterUrl)}.${database}`;

		const picked = await vscode.window.showInputBox({
			title: 'Add to favorites',
			prompt: 'Enter a friendly name for this cluster + database',
			value: defaultName,
			ignoreFocusOut: true
		});
		const name = typeof picked === 'string' ? picked.trim() : '';
		if (!name) {
			return;
		}
		if (!connection || this.getResolvedAccountPartition(connection) !== startingAccountPartition) return;
		await this.addOrUpdateFavorite({ name, connectionId, clusterUrl, database }, message.boxId, startingAccountPartition);
	}

	private async addOrUpdateFavorite(favorite: KustoFavorite, boxId?: string, accountPartition?: string): Promise<void> {
		const name = String(favorite.name || '').trim();
		const connectionId = String(favorite.connectionId || '').trim();
		const clusterUrl = normalizeFavoriteClusterUrl(String(favorite.clusterUrl || '').trim());
		const database = String(favorite.database || '').trim();
		if (!name || !connectionId || !clusterUrl || !database) {
			return;
		}
		const key = this.favoriteKey(connectionId, database);
		const current = this.getFavorites();
		const next: KustoFavorite[] = [];
		let replaced = false;
		for (const f of current) {
			const fk = this.favoriteKey(f.connectionId, f.database);
			if (fk === key) {
				next.push({ name, connectionId, clusterUrl, database, ...(accountPartition ? { accountPartition } : {}) } as KustoFavorite);
				replaced = true;
			} else {
				next.push(f);
			}
		}
		if (!replaced) {
			next.push({ name, connectionId, clusterUrl, database, ...(accountPartition ? { accountPartition } : {}) } as KustoFavorite);
		}
		await this.setFavorites(next, boxId, { connectionId, accountPartition });
	}

	async removeFavorite(connectionIdRaw: string, databaseRaw: string): Promise<void> {
		const connectionId = String(connectionIdRaw || '').trim();
		const database = String(databaseRaw || '').trim();
		if (!connectionId || !database) {
			return;
		}
		const key = this.favoriteKey(connectionId, database);
		const current = this.getFavorites();
		const next = current.filter((f) => this.favoriteKey(f.connectionId, f.database) !== key);
		await this.setFavorites(next);
	}

	async confirmRemoveFavorite(
		message: Extract<IncomingWebviewMessage, { type: 'confirmRemoveFavorite' }>
	): Promise<void> {
		const requestId = String(message.requestId || '').trim();
		const clusterUrl = normalizeFavoriteClusterUrl(String(message.clusterUrl || '').trim());
		const connectionId = String(message.connectionId || '').trim();
		const database = String(message.database || '').trim();
		const label = String(message.label || '').trim();
		if (!requestId) {
			return;
		}

		let ok = false;
		try {
			const display = label || (clusterUrl && database ? `${clusterUrl} (${database})` : 'this favorite');
			const choice = await vscode.window.showWarningMessage(
				`Remove "${display}" from favorites?`,
				{ modal: true },
				'Remove'
			);
			ok = choice === 'Remove';
		} catch {
			ok = false;
		}

		this.host.postMessage({
			type: 'confirmRemoveFavoriteResult',
			requestId,
			ok,
			connectionId,
			clusterUrl,
			database,
			boxId: message.boxId
		});
	}

	// ── Cached databases ──

	getCachedDatabases(): Record<string, string[]> {
		const cached: Record<string, string[]> = {};
		const connections = this.host.connectionManager.getConnections();
		const legacy = this.host.context.globalState.get<Record<string, string[]> | undefined>(STORAGE_KEYS.cachedDatabases) ?? {};
		for (const connection of connections) {
			let allowLegacy = false;
			let partition: string | undefined;
			try {
				const preference = this.authPreferences.getPreference(connection.id);
				partition = this.getResolvedAccountPartition(connection);
				allowLegacy = preference.mode === 'automatic' && normalizeKustoAuthorityId(connection.authorityId) === undefined;
			} catch {
				continue;
			}
			let databases = this.connectionCache.getDatabases(connection.id, partition, allowLegacy);
			if (databases.length === 0 && allowLegacy && !partition) {
				const sameCluster = connections.filter(candidate => getClusterCacheKey(candidate.clusterUrl) === getClusterCacheKey(connection.clusterUrl));
				if (sameCluster.length === 1) {
					databases = legacy[connection.id]
						?? legacy[getClusterCacheKey(connection.clusterUrl)]
						?? legacy[String(connection.clusterUrl || '').trim()]
						?? [];
				}
			}
			if (databases.length > 0) cached[connection.id] = databases;
		}
		return cached;
	}

	migrateCachedDatabasesToClusterKeys(raw: Record<string, string[]>): Record<string, string[]> {
		const src = raw && typeof raw === 'object' ? raw : {};
		const connections = this.host.connectionManager.getConnections();
		const connById = new Map<string, KustoConnection>(connections.map((c) => [c.id, c]));

		let changed = false;
		const next: Record<string, string[]> = {};
		for (const [k, v] of Object.entries(src)) {
			const keyRaw = String(k || '').trim();
			if (!keyRaw) {
				changed = true;
				continue;
			}

			const list = (Array.isArray(v) ? v : [])
				.map((d) => String(d || '').trim())
				.filter(Boolean);

			const conn = connById.get(keyRaw);
			const clusterKey = conn ? getClusterCacheKey(conn.clusterUrl) : getClusterCacheKey(keyRaw);
			if (clusterKey !== keyRaw) {
				changed = true;
			}

			const existing = next[clusterKey] || [];
			const merged = [...existing, ...list]
				.map((d) => String(d || '').trim())
				.filter(Boolean);
			const deduped: string[] = [];
			const seen = new Set<string>();
			for (const d of merged) {
				const lower = d.toLowerCase();
				if (!seen.has(lower)) {
					seen.add(lower);
					deduped.push(d);
				}
			}
			next[clusterKey] = deduped;
		}

		if (changed) {
			void this.host.context.globalState.update(STORAGE_KEYS.cachedDatabases, next);
		}
		return next;
	}

	private async saveCachedDatabases(connectionId: string, databases: string[]): Promise<void> {
		const connection = this.findConnection(connectionId);
		const partition = connection ? this.getResolvedAccountPartition(connection) : undefined;
		if (!connection || !partition || databases.length === 0) return;
		await this.connectionCache.setDatabases(connectionId, partition, databases);
	}

	// ── Send databases ──

	async sendDatabases(connectionId: string, boxId: string, request: DatabaseDiscoveryRequest): Promise<void> {
		const traceId = createDatabaseListTraceId();
		const forceRefresh = request.mode === 'interactive-refresh';
		const allowInteractive = request.mode === 'interactive-refresh';
		const { requestToken, requiredDatabase } = request;
		const lifecycle = request.sectionInstanceId !== undefined && request.targetGeneration !== undefined
			? { sectionInstanceId: request.sectionInstanceId, targetGeneration: request.targetGeneration }
			: {};
		const connection = this.findConnection(connectionId);
		if (!connection) {
			this.traceDatabaseList(traceId, 'connection-missing', {
				connectionId,
				boxId,
				requestToken,
				...lifecycle,
				forceRefresh,
				allowInteractive,
			});
			this.host.postMessage({
				type: 'databasesError',
				boxId,
				connectionId,
				requestToken,
				...lifecycle,
				error: 'The selected Kusto connection is no longer available.',
			});
			return;
		}
		const clusterKey = getClusterCacheKey(connection.clusterUrl);
		let capturedIdentity = '';
		try {
			capturedIdentity = getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId);
		} catch {
			this.host.postMessage({
				type: 'databasesError', boxId, connectionId, requestToken, ...lifecycle,
				error: 'The saved Kusto connection has an invalid Tenant / Authority ID.',
			});
			return;
		}
		const isConnectionCurrent = () => {
			const current = this.findConnection(connection.id);
			if (!current) return false;
			try {
				return getKustoConnectionIdentityKey(current.clusterUrl, current.authorityId) === capturedIdentity;
			} catch {
				return false;
			}
		};
		const settlementKey = () => `${connection.id}|${this.getResolvedAccountPartition(connection) || 'unresolved'}`;
		const normalizeDatabases = (databasesRaw: unknown): string[] => (Array.isArray(databasesRaw) ? databasesRaw : [])
			.map((database) => String(database || '').trim())
			.filter(Boolean)
			.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
		const getCurrentCachedDatabases = (): string[] => normalizeDatabases(this.getCachedDatabases()[connection.id] ?? []);
		const cachedBefore = getCurrentCachedDatabases();
		const requiredDatabaseName = String(requiredDatabase || '').trim();
		const cachedHasRequiredDatabase = !!requiredDatabaseName
			&& cachedBefore.some(database => database.toLowerCase() === requiredDatabaseName.toLowerCase());
		const requireLiveDiscovery = !!requiredDatabaseName && !cachedHasRequiredDatabase;
		const effectiveForceRefresh = forceRefresh || requireLiveDiscovery;
		const postDatabases = (databases: string[], provenance: 'cache' | 'live' | 'fallback', accountPartition?: string) => {
			if (!isConnectionCurrent()) return;
			this.traceDatabaseList(traceId, 'webview.post', {
				connectionId,
				provenance,
				databaseCount: databases.length,
				authoritative: provenance === 'live',
				fallback: provenance === 'fallback',
			});
			this.host.postMessage({
				type: 'databasesData',
				databases,
				boxId,
				connectionId,
				accountPartition,
				requestToken,
				...lifecycle,
				authoritative: provenance === 'live',
				fallback: provenance === 'fallback',
			});
		};
		this.traceDatabaseList(traceId, 'start', {
			connectionId,
			boxId,
			requestToken,
			clusterKey,
			requestMode: request.mode,
			forceRefresh,
			effectiveForceRefresh,
			allowInteractive,
			persistedCacheCount: cachedBefore.length,
			requiredDatabaseSpecified: !!requiredDatabaseName,
			cachedHasRequiredDatabase,
			requireLiveDiscovery,
		});

		if (!effectiveForceRefresh && cachedBefore.length > 0) {
			this.traceDatabaseList(traceId, 'persisted-cache.hit', {
				databaseCount: cachedBefore.length,
			});
			postDatabases(cachedBefore, 'cache', this.getResolvedAccountPartition(connection));
			return;
		}

		const fetchAndNormalize = async (
			reason: string,
			refresh: boolean = true,
			interactive: boolean = allowInteractive
		): Promise<DatabaseFetchResult> => {
			this.traceDatabaseList(traceId, 'live-fetch.start', {
				reason,
				forceRefresh: refresh,
				allowInteractive: interactive,
			});
			try {
				const discovery = await this.host.kustoClient.getDatabasesWithIdentity(connection, refresh, {
					allowInteractive: interactive,
					traceId,
					source: 'query-editor',
				});
				const databases = normalizeDatabases(discovery.databases);
				this.traceDatabaseList(traceId, 'live-fetch.complete', {
					reason,
					databaseCount: databases.length,
				});
				return { databases, accountPartition: discovery.accountPartition };
			} catch (error) {
				this.traceDatabaseList(traceId, 'live-fetch.failed', {
					reason,
					isAuthError: this.host.kustoClient.isAuthenticationError(error),
					...getDatabaseListErrorDetails(error),
				});
				throw error;
			}
		};
		const recoverFromZeroResult = async (): Promise<ZeroResultRecoveryOutcome> => {
			if (!isConnectionCurrent()) return { kind: 'dismissed' };
			const recoveryKey = settlementKey();
			const existing = ConnectionService.zeroResultRecoveryByCluster.get(recoveryKey);
			if (existing) {
				this.traceDatabaseList(traceId, 'account-choice.joined', { reason: 'zero-result' });
				return existing;
			}

			const recovery = (async (): Promise<ZeroResultRecoveryOutcome> => {
				if (!isConnectionCurrent()) return { kind: 'dismissed' };
				this.traceDatabaseList(traceId, 'account-choice.prompt', { reason: 'zero-result' });
				const preference = this.authPreferences.getPreference(connection.id);
				const choice = await vscode.window.showWarningMessage(
					preference.mode === 'explicit'
						? 'The selected account can connect, but no databases are visible. Check the connection Authority / Tenant ID and account.'
						: 'No databases are visible with the available accounts. Check the connection Authority / Tenant ID or choose an explicit account.',
					'Edit Connections',
				);
				if (!isConnectionCurrent()) return { kind: 'dismissed' };
				this.traceDatabaseList(traceId, 'account-choice.result', {
					reason: 'zero-result',
					choice: choice ?? 'dismissed',
				});
				if (choice === 'Edit Connections') void vscode.commands.executeCommand('kusto.manageConnections');
				return { kind: 'dismissed' };
			})();

			ConnectionService.zeroResultRecoveryByCluster.set(recoveryKey, recovery);
			try {
				return await recovery;
			} finally {
				if (ConnectionService.zeroResultRecoveryByCluster.get(recoveryKey) === recovery) {
					ConnectionService.zeroResultRecoveryByCluster.delete(recoveryKey);
				}
			}
		};
		const postCurrentCachedFallback = async (reason: string): Promise<boolean> =>
			ConnectionService.withDatabaseCacheSettlement(settlementKey(), async () => {
				const currentCached = getCurrentCachedDatabases();
				if (currentCached.length === 0) {
					return false;
				}
				this.traceDatabaseList(traceId, 'fallback.selected', {
					reason,
					persistedCacheCount: currentCached.length,
				});
				postDatabases(currentCached, 'fallback', this.getResolvedAccountPartition(connection));
				return true;
			});
		const settleDatabases = async (discovery: DatabaseFetchResult): Promise<void> =>
			ConnectionService.withDatabaseCacheSettlement(settlementKey(), async () => {
				const databases = discovery.databases;
				const currentCached = getCurrentCachedDatabases();
				if (databases.length === 0 && currentCached.length > 0) {
					this.traceDatabaseList(traceId, 'fallback.selected', {
						reason: 'live-result-empty',
						persistedCacheCount: currentCached.length,
					});
					postDatabases(currentCached, 'fallback', this.getResolvedAccountPartition(connection));
					return;
				}
				postDatabases(databases, 'live', discovery.accountPartition);
			});

		try {
			let discovery = await fetchAndNormalize('initial', effectiveForceRefresh);
			let databases = discovery.databases;

			if (allowInteractive && effectiveForceRefresh && databases.length === 0) {
				this.traceDatabaseList(traceId, 'zero-result.recovery-start', {
					reason: cachedBefore.length > 0 ? 'persisted-cache-available' : 'no-persisted-cache',
				});
				const recovery = await recoverFromZeroResult();
				if (recovery.kind === 'fetched') {
					databases = recovery.databases;
					discovery = { databases };
				}
			}

			await settleDatabases(discovery);
			return;
		} catch (error) {
			if (!isConnectionCurrent()) return;
			const isAuthErr = this.host.kustoClient.isAuthenticationError(error);
			const isCancelled = isDatabaseDiscoveryCancellation(error);
			const action = forceRefresh ? 'refresh' : 'load';
			this.traceDatabaseList(traceId, 'failed', {
				isAuthError: isAuthErr,
				isCancelled,
				...getDatabaseListErrorDetails(error),
				effectiveForceRefresh,
				persistedCacheCount: cachedBefore.length,
			});
			if (isCancelled) {
				if (await postCurrentCachedFallback('cancelled')) {
					return;
				}
				if (!isConnectionCurrent()) return;
				this.traceDatabaseList(traceId, 'cancelled', { action });
				this.host.postMessage({
					type: 'databasesError',
					boxId,
					connectionId,
					requestToken,
					...lifecycle,
					error: `Database ${action} cancelled.`,
				});
				return;
			}

			if (isAuthErr && !allowInteractive && await postCurrentCachedFallback('authentication-error')) {
				return;
			}
			if (!isConnectionCurrent()) return;

			const userMessage = this.host.formatQueryExecutionErrorForUser(error, connection);

			// Throttle error notifications: suppress if we showed one for this cluster within the last 5 seconds.
			// This prevents spamming when multiple query sections all fail for the same cluster (e.g. VPN disconnect).
			const now = Date.now();
			const lastShown = this.lastDbErrorNotificationByCluster.get(clusterKey) ?? 0;
			const shouldShowNotification = allowInteractive && (now - lastShown) > 5000;
			if (shouldShowNotification) {
				this.lastDbErrorNotificationByCluster.set(clusterKey, now);
			}

			if (await postCurrentCachedFallback('unrecovered-error')) {
				if (!isConnectionCurrent()) return;
				if (shouldShowNotification) {
					void vscode.window.showWarningMessage(
						`Failed to ${action} database list. Using cached list.`,
						'More Info'
					).then(selection => {
						if (selection === 'More Info') {
							void vscode.window.showInformationMessage(userMessage, { modal: true });
						}
					});
				}
				return;
			}
			if (!isConnectionCurrent()) return;

			if (shouldShowNotification) {
				void vscode.window.showErrorMessage(`Failed to ${action} database list.`, 'More Info').then(selection => {
					if (selection === 'More Info') {
						void vscode.window.showInformationMessage(userMessage, { modal: true });
					}
				});
			}
			this.traceDatabaseList(traceId, 'webview.error', {
				action,
				notificationShown: shouldShowNotification,
			});
			this.host.postMessage({
				type: 'databasesError',
				boxId,
				connectionId,
				requestToken,
				...lifecycle,
				error: `Failed to ${action} database list.\n${userMessage}`
			});
		}
	}

	// ── Send connections data ──

	async sendConnectionsData(settings: {
		caretDocsEnabled: boolean;
		caretDocsEnabledUserSet: boolean;
		autoTriggerAutocompleteEnabled: boolean;
		autoTriggerAutocompleteEnabledUserSet: boolean;
		copilotInlineCompletionsEnabled: boolean;
		copilotInlineCompletionsEnabledUserSet: boolean;
		editingPreferencesRevision: number;
		copilotChatFirstTimeDismissed: boolean;
		connectionsRevision: number;
		policyRequestId?: string;
	}): Promise<void> {
		if (testIsolateKustoConnections) {
			this.host.postMessage({
				type: 'connectionsData',
				connections: [],
				lastConnectionId: null,
				lastDatabase: null,
				cachedDatabases: {},
				favorites: [],
				...settings,
				leaveNoTraceClusters: [],
				leaveNoTraceGloballyBlocked: false,
				leaveNoTraceRevisions: {},
				devNotesEnabled: true
			});
			return;
		}
		const attempts = settings.policyRequestId ? 2 : 1;
		for (let attempt = 0; attempt < attempts; attempt++) {
			const accounts = await this.authPreferences.getAccounts();
			const applied = await this.host.connectionManager.runWithLeaveNoTraceSnapshotLock(async policy => {
				const connections = this.host.connectionManager.getConnections().map(connection => {
					let accountPartition: string | undefined;
					try { accountPartition = this.getResolvedAccountPartition(connection); } catch { accountPartition = undefined; }
					let connectionIdentityKey: string | undefined;
					try { connectionIdentityKey = getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId); } catch { connectionIdentityKey = undefined; }
					return {
						...connection,
						accountPartition,
						connectionRevision: this.host.connectionManager.getConnectionIncarnation(connection.id),
						...(connectionIdentityKey ? { connectionIdentityKey } : {}),
					};
				});
				const leaveNoTraceClusters = policy.globallyBlocked
					? [...new Set(connections.map(connection => this.host.connectionManager.normalizeClusterUrl(connection.clusterUrl)).filter(Boolean))]
					: [...policy.clusterKeys];
				const payload = {
					type: 'connectionsData',
					connections,
					accounts,
					lastConnectionId: this.lastConnectionId,
					lastDatabase: this.lastDatabase,
					cachedDatabases: this.getCachedDatabases(),
					favorites: this.getFavorites(),
					...settings,
					leaveNoTraceClusters,
					leaveNoTraceGloballyBlocked: policy.globallyBlocked,
					leaveNoTraceRevisions: policy.revocationGenerations,
					devNotesEnabled: true
				};
				if (this.host.postKustoPublication) return this.host.postKustoPublication(payload);
				await Promise.resolve(this.host.postMessage(payload));
				return true;
			});
			if (applied) return;
		}
		throw new Error('Kusto policy snapshot was not applied by the webview.');
	}

	// ── Schema inference for .kql/.csl files ──

	async inferClusterDatabaseForKqlQuery(
		queryText: string
	): Promise<{ clusterUrl: string; database: string; authorityId?: string; connectionIdHint: string } | undefined> {
		const text = String(queryText ?? '').trim();
		if (!text) {
			return undefined;
		}

		const tokens = extractKqlSchemaMatchTokens(text);
		if (!tokens.allNamesLower.size) {
			return undefined;
		}

		const favorites = this.getFavorites();
		const favoriteKeys = new Set<string>();
		for (const f of favorites) {
			try {
				favoriteKeys.add(this.favoriteKey(f.connectionId, f.database));
			} catch {
				// ignore
			}
		}

		const cachedDatabases = this.getCachedDatabases();
		const connections = this.host.connectionManager.getConnections();

		const MAX_CANDIDATES = 300;
		let candidatesSeen = 0;

		let best:
			| { clusterUrl: string; database: string; authorityId?: string; connectionIdHint: string; score: number; isFavorite: boolean }
			| undefined;
		const topConnectionIds = new Set<string>();

		for (const conn of connections) {
			const clusterUrl = String(conn?.clusterUrl || '').trim();
			if (!clusterUrl) continue;
			const dbList = cachedDatabases[conn.id] ?? [];
			if (!Array.isArray(dbList) || dbList.length === 0) continue;

			for (const dbRaw of dbList) {
				if (candidatesSeen >= MAX_CANDIDATES) break;
				const database = String(dbRaw || '').trim();
				if (!database) continue;
				candidatesSeen++;

				const accountPartition = this.getResolvedAccountPartition(conn);
				if (!accountPartition) continue;
				const cached: CachedSchemaEntry | undefined = await this.host.getCachedSchemaFromDisk(
					schemaCacheKey(clusterUrl, database, conn.id, accountPartition),
				);
				const schema = cached?.schema;
				if (!schema) continue;

				const score = scoreSchemaMatch(tokens, schema);
				if (score <= 0) continue;

				const isFavorite = favoriteKeys.has(this.favoriteKey(conn.id, database));

				if (!best) {
					best = { clusterUrl, database, authorityId: conn.authorityId, connectionIdHint: conn.id, score, isFavorite };
					topConnectionIds.add(conn.id);
					continue;
				}

				if (score > best.score) {
					best = { clusterUrl, database, authorityId: conn.authorityId, connectionIdHint: conn.id, score, isFavorite };
					topConnectionIds.clear();
					topConnectionIds.add(conn.id);
					continue;
				}
				if (score === best.score) {
					if (isFavorite && !best.isFavorite) {
						best = { clusterUrl, database, authorityId: conn.authorityId, connectionIdHint: conn.id, score, isFavorite };
						topConnectionIds.clear();
						topConnectionIds.add(conn.id);
						continue;
					}
					if (isFavorite === best.isFavorite) {
						topConnectionIds.add(conn.id);
						const a = kustoDatabaseKey(clusterUrl, database) || `${clusterUrl.toLowerCase()}|${database.toLowerCase()}`;
						const b = kustoDatabaseKey(best.clusterUrl, best.database) || `${best.clusterUrl.toLowerCase()}|${best.database.toLowerCase()}`;
						if (a < b) {
							best = { clusterUrl, database, authorityId: conn.authorityId, connectionIdHint: conn.id, score, isFavorite };
						}
					}
				}
			}

			if (candidatesSeen >= MAX_CANDIDATES) break;
		}

		if (!best || topConnectionIds.size > 1) {
			return undefined;
		}
		return { clusterUrl: best.clusterUrl, database: best.database, authorityId: best.authorityId, connectionIdHint: best.connectionIdHint };
	}
}
