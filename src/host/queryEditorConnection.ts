import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

import { ConnectionManager, KustoConnection } from './connectionManager';
import { KustoQueryClient } from './kustoClient';
import { extractKqlSchemaMatchTokens, scoreSchemaMatch } from './kqlSchemaInference';
import { kustoClusterKey, kustoDatabaseKey } from '../shared/kustoClusterUrls';
import { getLegacySchemaCacheKeys } from './schemaCache';
import {
	STORAGE_KEYS,
	KustoFavorite,
	SqlFavorite,
	CachedSchemaEntry,
	IncomingWebviewMessage
} from './queryEditorTypes';
import { getWorkbenchLogger, type WorkbenchLogger } from './workbenchLogger';
import {
	createDatabaseListTraceId,
	getDatabaseListErrorDetails,
	traceDatabaseList,
} from './databaseListTrace';

export let testIsolateKustoConnections = false;

type DatabaseDiscoveryRequest =
	| { mode: 'passive'; requestToken?: string; requiredDatabase?: string }
	| { mode: 'interactive-refresh'; requestToken?: string; requiredDatabase?: string };

type ZeroResultRecoveryOutcome =
	| { kind: 'dismissed' }
	| { kind: 'fetched'; databases: string[] };

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
	readonly sqlConnectionManager?: { getConnection(id: string): { name?: string; serverUrl?: string } | undefined };
	readonly context: vscode.ExtensionContext;
	readonly kustoClient: KustoQueryClient;
	readonly output: WorkbenchLogger;
	postMessage(message: unknown): Thenable<boolean> | PromiseLike<boolean> | void;
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
		this.activate();
		this.loadLastSelection();
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

	getFavorites(): KustoFavorite[] {
		const raw = this.host.context.globalState.get<unknown>(STORAGE_KEYS.favorites);
		if (!Array.isArray(raw)) {
			return [];
		}
		const out: KustoFavorite[] = [];
		for (const item of raw) {
			if (!item || typeof item !== 'object') {
				continue;
			}
			const maybe = item as Partial<KustoFavorite>;
			const name = String(maybe.name || '').trim();
			const clusterUrl = String(maybe.clusterUrl || '').trim();
			const database = String(maybe.database || '').trim();
			if (!name || !clusterUrl || !database) {
				continue;
			}
			out.push({ name, clusterUrl, database });
		}
		return out;
	}

	private favoriteKey(clusterUrl: string, database: string): string {
		const c = kustoClusterKey(clusterUrl);
		const d = String(database || '').trim().toLowerCase();
		return `${c}|${d}`;
	}

	private async setFavorites(favorites: KustoFavorite[], boxId?: string): Promise<void> {
		await this.host.context.globalState.update(STORAGE_KEYS.favorites, favorites);
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
		const databaseRaw = String(message.database || '').trim();
		if (!clusterUrlRaw || !databaseRaw) {
			return;
		}
		const clusterUrl = normalizeFavoriteClusterUrl(clusterUrlRaw);
		const database = databaseRaw;
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
		await this.addOrUpdateFavorite({ name, clusterUrl, database }, message.boxId);
	}

	private async addOrUpdateFavorite(favorite: KustoFavorite, boxId?: string): Promise<void> {
		const name = String(favorite.name || '').trim();
		const clusterUrl = normalizeFavoriteClusterUrl(String(favorite.clusterUrl || '').trim());
		const database = String(favorite.database || '').trim();
		if (!name || !clusterUrl || !database) {
			return;
		}
		const key = this.favoriteKey(clusterUrl, database);
		const current = this.getFavorites();
		const next: KustoFavorite[] = [];
		let replaced = false;
		for (const f of current) {
			const fk = this.favoriteKey(f.clusterUrl, f.database);
			if (fk === key) {
				next.push({ name, clusterUrl, database });
				replaced = true;
			} else {
				next.push(f);
			}
		}
		if (!replaced) {
			next.push({ name, clusterUrl, database });
		}
		await this.setFavorites(next, boxId);
	}

	async removeFavorite(clusterUrlRaw: string, databaseRaw: string): Promise<void> {
		const clusterUrl = normalizeFavoriteClusterUrl(String(clusterUrlRaw || '').trim());
		const database = String(databaseRaw || '').trim();
		if (!clusterUrl || !database) {
			return;
		}
		const key = this.favoriteKey(clusterUrl, database);
		const current = this.getFavorites();
		const next = current.filter((f) => this.favoriteKey(f.clusterUrl, f.database) !== key);
		await this.setFavorites(next);
	}

	async confirmRemoveFavorite(
		message: Extract<IncomingWebviewMessage, { type: 'confirmRemoveFavorite' }>
	): Promise<void> {
		const requestId = String(message.requestId || '').trim();
		const clusterUrl = normalizeFavoriteClusterUrl(String(message.clusterUrl || '').trim());
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
			clusterUrl,
			database,
			boxId: message.boxId
		});
	}

	// ── SQL Favorites ──

	getSqlFavorites(): SqlFavorite[] {
		const raw = this.host.context.globalState.get<unknown>(STORAGE_KEYS.sqlFavorites);
		if (!Array.isArray(raw)) {
			return [];
		}
		const out: SqlFavorite[] = [];
		for (const item of raw) {
			if (!item || typeof item !== 'object') {
				continue;
			}
			const maybe = item as Partial<SqlFavorite>;
			const name = String(maybe.name || '').trim();
			const connectionId = String(maybe.connectionId || '').trim();
			const database = String(maybe.database || '').trim();
			if (!name || !connectionId || !database) {
				continue;
			}
			out.push({ name, connectionId, database });
		}
		return out;
	}

	private sqlFavoriteKey(connectionId: string, database: string): string {
		const c = String(connectionId || '').trim();
		const d = String(database || '').trim().toLowerCase();
		return `${c}|${d}`;
	}

	private async setSqlFavorites(favorites: SqlFavorite[], boxId?: string): Promise<void> {
		await this.host.context.globalState.update(STORAGE_KEYS.sqlFavorites, favorites);
		try {
			await this.sendSqlFavoritesData(boxId);
		} catch (error) {
			try { this.host.output.warn(`[favorites] Failed to send sqlFavoritesData: ${error instanceof Error ? error.message : String(error)}`); } catch {
				// ignore logging failures
			}
		}
	}

	private async sendSqlFavoritesData(boxId?: string): Promise<void> {
		const payload: any = { type: 'sqlFavoritesData', favorites: this.getSqlFavorites() };
		if (boxId) {
			payload.boxId = boxId;
		}
		await Promise.resolve(this.host.postMessage(payload));
	}

	async promptAddSqlFavorite(
		message: Extract<IncomingWebviewMessage, { type: 'requestAddSqlFavorite' }>
	): Promise<void> {
		const connectionId = String(message.connectionId || '').trim();
		const databaseRaw = String(message.database || '').trim();
		if (!connectionId || !databaseRaw) {
			return;
		}
		const database = databaseRaw;
		const conn = this.host.sqlConnectionManager?.getConnection(connectionId);
		const serverName = conn ? (conn.name || conn.serverUrl || connectionId) : connectionId;
		const defaultName =
			String(message.defaultName || '').trim() || `${serverName}.${database}`;

		const picked = await vscode.window.showInputBox({
			title: 'Add to favorites',
			prompt: 'Enter a friendly name for this server + database',
			value: defaultName,
			ignoreFocusOut: true
		});
		const name = typeof picked === 'string' ? picked.trim() : '';
		if (!name) {
			return;
		}
		await this.addOrUpdateSqlFavorite({ name, connectionId, database }, message.boxId);
	}

	private async addOrUpdateSqlFavorite(favorite: SqlFavorite, boxId?: string): Promise<void> {
		const name = String(favorite.name || '').trim();
		const connectionId = String(favorite.connectionId || '').trim();
		const database = String(favorite.database || '').trim();
		if (!name || !connectionId || !database) {
			return;
		}
		const key = this.sqlFavoriteKey(connectionId, database);
		const current = this.getSqlFavorites();
		const next: SqlFavorite[] = [];
		let replaced = false;
		for (const f of current) {
			const fk = this.sqlFavoriteKey(f.connectionId, f.database);
			if (fk === key) {
				next.push({ name, connectionId, database });
				replaced = true;
			} else {
				next.push(f);
			}
		}
		if (!replaced) {
			next.push({ name, connectionId, database });
		}
		await this.setSqlFavorites(next, boxId);
	}

	async removeSqlFavorite(connectionIdRaw: string, databaseRaw: string): Promise<void> {
		const connectionId = String(connectionIdRaw || '').trim();
		const database = String(databaseRaw || '').trim();
		if (!connectionId || !database) {
			return;
		}
		const key = this.sqlFavoriteKey(connectionId, database);
		const current = this.getSqlFavorites();
		const next = current.filter((f) => this.sqlFavoriteKey(f.connectionId, f.database) !== key);
		await this.setSqlFavorites(next);
	}

	// ── Cached databases ──

	getCachedDatabases(): Record<string, string[]> {
		const raw = this.host.context.globalState.get<Record<string, string[]>>(STORAGE_KEYS.cachedDatabases, {});
		return this.migrateCachedDatabasesToClusterKeys(raw);
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
		if (!connection) {
			return;
		}
		const clusterKey = getClusterCacheKey(connection.clusterUrl);
		if (!clusterKey) {
			return;
		}
		const cached = this.getCachedDatabases();
		cached[clusterKey] = databases;
		await this.host.context.globalState.update(STORAGE_KEYS.cachedDatabases, cached);
	}

	// ── Send databases ──

	async sendDatabases(connectionId: string, boxId: string, request: DatabaseDiscoveryRequest): Promise<void> {
		const traceId = createDatabaseListTraceId();
		const forceRefresh = request.mode === 'interactive-refresh';
		const allowInteractive = request.mode === 'interactive-refresh';
		const { requestToken, requiredDatabase } = request;
		const connection = this.findConnection(connectionId);
		if (!connection) {
			this.traceDatabaseList(traceId, 'connection-missing', {
				connectionId,
				boxId,
				requestToken,
				forceRefresh,
				allowInteractive,
			});
			this.host.postMessage({
				type: 'databasesError',
				boxId,
				connectionId,
				requestToken,
				error: 'The selected Kusto connection is no longer available.',
			});
			return;
		}
		const clusterKey = getClusterCacheKey(connection.clusterUrl);
		const normalizeDatabases = (databasesRaw: unknown): string[] => (Array.isArray(databasesRaw) ? databasesRaw : [])
			.map((database) => String(database || '').trim())
			.filter(Boolean)
			.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
		const getCurrentCachedDatabases = (): string[] => normalizeDatabases(this.getCachedDatabases()[clusterKey] ?? []);
		const cachedBefore = getCurrentCachedDatabases();
		const requiredDatabaseName = String(requiredDatabase || '').trim();
		const cachedHasRequiredDatabase = !!requiredDatabaseName
			&& cachedBefore.some(database => database.toLowerCase() === requiredDatabaseName.toLowerCase());
		const requireLiveDiscovery = !!requiredDatabaseName && !cachedHasRequiredDatabase;
		const effectiveForceRefresh = forceRefresh || requireLiveDiscovery;
		const postDatabases = (databases: string[], provenance: 'cache' | 'live' | 'fallback') => {
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
				requestToken,
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
			postDatabases(cachedBefore, 'cache');
			return;
		}

		const fetchAndNormalize = async (
			reason: string,
			refresh: boolean = true,
			interactive: boolean = allowInteractive
		): Promise<string[]> => {
			this.traceDatabaseList(traceId, 'live-fetch.start', {
				reason,
				forceRefresh: refresh,
				allowInteractive: interactive,
			});
			try {
				const databasesRaw = await this.host.kustoClient.getDatabases(connection, refresh, {
					allowInteractive: interactive,
					traceId,
					source: 'query-editor',
				});
				const databases = normalizeDatabases(databasesRaw);
				this.traceDatabaseList(traceId, 'live-fetch.complete', {
					reason,
					databaseCount: databases.length,
				});
				return databases;
			} catch (error) {
				this.traceDatabaseList(traceId, 'live-fetch.failed', {
					reason,
					isAuthError: this.host.kustoClient.isAuthenticationError(error),
					...getDatabaseListErrorDetails(error),
				});
				throw error;
			}
		};
		const reauthenticate = async (promptMode: 'clearPreference' | 'forceNewSession', reason: string): Promise<void> => {
			this.traceDatabaseList(traceId, 'reauthenticate.start', { reason, promptMode });
			try {
				await this.host.kustoClient.reauthenticate(connection, promptMode, traceId);
				this.traceDatabaseList(traceId, 'reauthenticate.complete', { reason, promptMode });
			} catch (error) {
				this.traceDatabaseList(traceId, 'reauthenticate.failed', {
					reason,
					promptMode,
					isAuthError: this.host.kustoClient.isAuthenticationError(error),
					...getDatabaseListErrorDetails(error),
				});
				throw error;
			}
		};
		const saveLiveDatabases = async (databases: string[], reason: string): Promise<void> => {
			await this.saveCachedDatabases(connectionId, databases);
			this.traceDatabaseList(traceId, 'persisted-cache.updated', {
				reason,
				databaseCount: databases.length,
			});
		};
		const recoverFromZeroResult = async (): Promise<ZeroResultRecoveryOutcome> => {
			const existing = ConnectionService.zeroResultRecoveryByCluster.get(clusterKey);
			if (existing) {
				this.traceDatabaseList(traceId, 'account-choice.joined', { reason: 'zero-result' });
				return existing;
			}

			const recovery = (async (): Promise<ZeroResultRecoveryOutcome> => {
				this.traceDatabaseList(traceId, 'account-choice.prompt', { reason: 'zero-result' });
				const choice = await vscode.window.showWarningMessage(
					"No databases were returned. This is often because the selected account doesn't have access to this cluster.",
					'Try another account',
					'Add account',
					'Cancel'
				);
				this.traceDatabaseList(traceId, 'account-choice.result', {
					reason: 'zero-result',
					choice: choice ?? 'dismissed',
				});
				if (choice === 'Try another account') {
					await reauthenticate('clearPreference', 'zero-result-user-choice');
					return {
						kind: 'fetched',
						databases: await fetchAndNormalize('zero-result-after-clear-preference', true, false),
					};
				}
				if (choice === 'Add account') {
					await reauthenticate('forceNewSession', 'zero-result-user-choice');
					return {
						kind: 'fetched',
						databases: await fetchAndNormalize('zero-result-after-force-new-session', true, false),
					};
				}
				return { kind: 'dismissed' };
			})();

			ConnectionService.zeroResultRecoveryByCluster.set(clusterKey, recovery);
			try {
				return await recovery;
			} finally {
				if (ConnectionService.zeroResultRecoveryByCluster.get(clusterKey) === recovery) {
					ConnectionService.zeroResultRecoveryByCluster.delete(clusterKey);
				}
			}
		};
		const postCurrentCachedFallback = async (reason: string): Promise<boolean> =>
			ConnectionService.withDatabaseCacheSettlement(clusterKey, async () => {
				const currentCached = getCurrentCachedDatabases();
				if (currentCached.length === 0) {
					return false;
				}
				this.traceDatabaseList(traceId, 'fallback.selected', {
					reason,
					persistedCacheCount: currentCached.length,
				});
				postDatabases(currentCached, 'fallback');
				return true;
			});
		const settleDatabases = async (databases: string[], reason: string): Promise<void> =>
			ConnectionService.withDatabaseCacheSettlement(clusterKey, async () => {
				const currentCached = getCurrentCachedDatabases();
				if (databases.length === 0 && currentCached.length > 0) {
					this.traceDatabaseList(traceId, 'fallback.selected', {
						reason: 'live-result-empty',
						persistedCacheCount: currentCached.length,
					});
					postDatabases(currentCached, 'fallback');
					return;
				}
				await saveLiveDatabases(databases, reason);
				postDatabases(databases, 'live');
			});

		try {
			let databases = await fetchAndNormalize('initial', effectiveForceRefresh);

			if (allowInteractive && effectiveForceRefresh && databases.length === 0) {
				this.traceDatabaseList(traceId, 'zero-result.recovery-start', {
					reason: cachedBefore.length > 0 ? 'persisted-cache-available' : 'no-persisted-cache',
				});
				const recovery = await recoverFromZeroResult();
				if (recovery.kind === 'fetched') {
					databases = recovery.databases;
				}
			}

			await settleDatabases(databases, 'live-result');
			return;
		} catch (error) {
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
				this.traceDatabaseList(traceId, 'cancelled', { action });
				this.host.postMessage({
					type: 'databasesError',
					boxId,
					connectionId,
					requestToken,
					error: `Database ${action} cancelled.`,
				});
				return;
			}

			if (isAuthErr && !allowInteractive && await postCurrentCachedFallback('authentication-error')) {
				return;
			}

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
				devNotesEnabled: true
			});
			return;
		}
		const connections = this.host.connectionManager.getConnections();
		const cachedDatabases = this.getCachedDatabases();
		const favorites = this.getFavorites();
		const leaveNoTraceClusters = this.host.connectionManager.getLeaveNoTraceClusters();
		this.host.postMessage({
			type: 'connectionsData',
			connections,
			lastConnectionId: this.lastConnectionId,
			lastDatabase: this.lastDatabase,
			cachedDatabases,
			favorites,
			...settings,
			leaveNoTraceClusters,
			devNotesEnabled: true
		});
	}

	// ── Connection CRUD ──

	async promptAddConnection(boxId?: string): Promise<void> {
		this.host.postMessage({ type: 'openKustoAddConnectionDialog', boxId });
	}

	async addConnectionFromWebview(data: { name: string; clusterUrl: string; database?: string; boxId?: string }): Promise<void> {
		let clusterUrl = String(data.clusterUrl || '').trim();
		if (!clusterUrl) return;
		clusterUrl = ensureHttpsUrl(clusterUrl);

		const name = String(data.name || '').trim() || clusterUrl;
		const database = String(data.database || '').trim() || undefined;

		const newConn = await this.host.connectionManager.addConnection({
			name,
			clusterUrl,
			database,
		});
		await this.saveLastSelection(newConn.id, newConn.database);

		this.host.postMessage({
			type: 'connectionAdded',
			boxId: data.boxId,
			connectionId: newConn.id,
			lastConnectionId: this.lastConnectionId,
			lastDatabase: this.lastDatabase,
			connections: this.host.connectionManager.getConnections(),
			cachedDatabases: this.getCachedDatabases()
		});
	}

	async testConnectionFromWebview(data: { name?: string; clusterUrl: string; database?: string; boxId?: string }): Promise<void> {
		const traceId = createDatabaseListTraceId();
		let clusterUrl = String(data.clusterUrl || '').trim();
		if (!clusterUrl) {
			this.traceDatabaseList(traceId, 'test.invalid-request', { reason: 'missing-cluster-url' });
			this.host.postMessage({ type: 'kustoConnectionTestResult', boxId: data.boxId, success: false, message: 'Enter a cluster URL before testing.' });
			return;
		}
		clusterUrl = ensureHttpsUrl(clusterUrl);

		const connection: KustoConnection = {
			id: `draft:${clusterUrl}`,
			name: String(data.name || '').trim() || clusterUrl,
			clusterUrl,
			database: String(data.database || '').trim() || undefined,
		};

		this.traceDatabaseList(traceId, 'test.start', { connectionId: connection.id, boxId: data.boxId });
		this.host.postMessage({ type: 'kustoConnectionTestStarted', boxId: data.boxId });
		try {
			const databases = await this.host.kustoClient.getDatabases(connection, true, {
				allowInteractive: true,
				traceId,
				source: 'query-editor-connection-test',
			});
			const databaseList = (Array.isArray(databases) ? databases : []).map(d => String(d || '').trim()).filter(Boolean);
			this.traceDatabaseList(traceId, 'test.success', { connectionId: connection.id, databaseCount: databaseList.length });
			this.host.postMessage({
				type: 'kustoConnectionTestResult',
				boxId: data.boxId,
				success: true,
				message: `Connected successfully! Found ${databaseList.length} database(s).`,
				databases: databaseList,
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			const isAuthError = this.host.kustoClient.isAuthenticationError(error);
			this.traceDatabaseList(traceId, 'test.failed', {
				connectionId: connection.id,
				boxId: data.boxId,
				isAuthError,
				...getDatabaseListErrorDetails(error),
			});
			this.host.postMessage({
				type: 'kustoConnectionTestResult',
				boxId: data.boxId,
				success: false,
				message: isAuthError ? 'Authentication failed. Please sign in when prompted.' : `Connection failed: ${errorMsg}`,
				isAuthError,
			});
		}
	}

	async addConnectionsForClusters(clusterUrls: string[]): Promise<void> {
		const urls = Array.isArray(clusterUrls) ? clusterUrls : [];
		if (!urls.length) {
			return;
		}

		const existing = this.host.connectionManager.getConnections();
		const existingKeys = new Set(existing.map((c) => getClusterShortNameKey(c.clusterUrl || '')).filter(Boolean));

		for (const u of urls) {
			const original = String(u || '').trim();
			if (!original) {
				continue;
			}
			const key = getClusterShortNameKey(original);
			if (!key || existingKeys.has(key)) {
				continue;
			}
			const clusterUrl = ensureHttpsUrl(original);
			await this.host.connectionManager.addConnection({
				name: getDefaultConnectionName(clusterUrl),
				clusterUrl,
				database: undefined
			});
			existingKeys.add(key);
		}
	}

	async importConnectionsFromXml(
		connections: Array<{ name: string; clusterUrl: string; database?: string }>
	): Promise<void> {
		const incoming = Array.isArray(connections) ? connections : [];
		if (!incoming.length) {
			return;
		}

		const existing = this.host.connectionManager.getConnections();
		const existingByCluster = new Set(existing.map((c) => this.host.normalizeClusterUrlKey(c.clusterUrl || '')).filter(Boolean));

		let added = 0;
		for (const c of incoming) {
			const name = String(c?.name || '').trim();
			const clusterUrlRaw = String(c?.clusterUrl || '').trim();
			const database = c?.database ? String(c.database).trim() : undefined;
			if (!clusterUrlRaw) {
				continue;
			}
			const clusterUrl = ensureHttpsUrl(clusterUrlRaw).replace(/\/+$/g, '');
			const key = this.host.normalizeClusterUrlKey(clusterUrl);
			if (existingByCluster.has(key)) {
				continue;
			}
			await this.host.connectionManager.addConnection({
				name: name || clusterUrl,
				clusterUrl,
				database
			});
			existingByCluster.add(key);
			added++;
		}

		if (added > 0) {
			void vscode.window.showInformationMessage(`Imported ${added} Kusto connection${added === 1 ? '' : 's'}.`);
		} else {
			void vscode.window.showInformationMessage('No new connections were imported (they may already exist).');
		}
	}

	async promptImportConnectionsXml(boxId?: string): Promise<void> {
		try {
			const localAppData = process.env.LOCALAPPDATA;
			const base = localAppData && localAppData.trim()
				? localAppData.trim()
				: path.join(os.homedir(), 'AppData', 'Local');
			const defaultFolder = path.join(base, 'Kusto.Explorer');
			const defaultUri = vscode.Uri.file(defaultFolder);

			const picked = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				defaultUri,
				openLabel: 'Import',
				filters: {
					'XML files': ['xml'],
					'All files': ['*']
				}
			});
			if (!picked || picked.length === 0) {
				return;
			}
			const uri = picked[0];
			const bytes = await vscode.workspace.fs.readFile(uri);
			const text = new TextDecoder('utf-8').decode(bytes);
			this.host.postMessage({
				type: 'importConnectionsXmlText',
				boxId,
				text,
				fileName: path.basename(uri.fsPath)
			});
		} catch (e: any) {
			const error = typeof e?.message === 'string' ? e.message : String(e);
			this.host.postMessage({ type: 'importConnectionsXmlError', boxId, error });
		}
	}

	// ── Schema inference for .kql/.csl files ──

	async inferClusterDatabaseForKqlQuery(
		queryText: string
	): Promise<{ clusterUrl: string; database: string } | undefined> {
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
				favoriteKeys.add(this.favoriteKey(f.clusterUrl, f.database));
			} catch {
				// ignore
			}
		}

		const cachedDatabases = this.getCachedDatabases();
		const connections = this.host.connectionManager.getConnections();

		const MAX_CANDIDATES = 300;
		let candidatesSeen = 0;

		let best:
			| { clusterUrl: string; database: string; score: number; isFavorite: boolean }
			| undefined;

		for (const conn of connections) {
			const clusterUrl = String(conn?.clusterUrl || '').trim();
			if (!clusterUrl) continue;
			const clusterKey = getClusterCacheKey(clusterUrl);
			const dbList = (cachedDatabases && clusterKey && cachedDatabases[clusterKey]) ? cachedDatabases[clusterKey] : [];
			if (!Array.isArray(dbList) || dbList.length === 0) continue;

			for (const dbRaw of dbList) {
				if (candidatesSeen >= MAX_CANDIDATES) break;
				const database = String(dbRaw || '').trim();
				if (!database) continue;
				candidatesSeen++;

				let cached: CachedSchemaEntry | undefined;
				for (const cacheKey of getLegacySchemaCacheKeys(clusterUrl, database)) {
					cached = await this.host.getCachedSchemaFromDisk(cacheKey);
					if (cached?.schema) break;
				}
				const schema = cached?.schema;
				if (!schema) continue;

				const score = scoreSchemaMatch(tokens, schema);
				if (score <= 0) continue;

				const isFavorite = favoriteKeys.has(this.favoriteKey(clusterUrl, database));

				if (!best) {
					best = { clusterUrl, database, score, isFavorite };
					continue;
				}

				if (score > best.score) {
					best = { clusterUrl, database, score, isFavorite };
					continue;
				}
				if (score === best.score) {
					if (isFavorite && !best.isFavorite) {
						best = { clusterUrl, database, score, isFavorite };
						continue;
					}
					if (isFavorite === best.isFavorite) {
						const a = kustoDatabaseKey(clusterUrl, database) || `${clusterUrl.toLowerCase()}|${database.toLowerCase()}`;
						const b = kustoDatabaseKey(best.clusterUrl, best.database) || `${best.clusterUrl.toLowerCase()}|${best.database.toLowerCase()}`;
						if (a < b) {
							best = { clusterUrl, database, score, isFavorite };
						}
					}
				}
			}

			if (candidatesSeen >= MAX_CANDIDATES) break;
		}

		if (!best) {
			return undefined;
		}
		return { clusterUrl: best.clusterUrl, database: best.database };
	}
}
