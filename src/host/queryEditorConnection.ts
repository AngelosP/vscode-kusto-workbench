import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

import { ConnectionManager, KustoConnection } from './connectionManager';
import { KustoQueryClient } from './kustoClient';
import { extractKqlSchemaMatchTokens, scoreSchemaMatch } from './kqlSchemaInference';
import {
	STORAGE_KEYS,
	KustoFavorite,
	SqlFavorite,
	CachedSchemaEntry,
	IncomingWebviewMessage
} from './queryEditorTypes';


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
	try {
		const withScheme = ensureHttpsUrl(clusterUrl);
		const u = new URL(withScheme);
		const host = String(u.hostname || '').trim();
		const first = host ? host.split('.')[0] : '';
		return String(first || host || clusterUrl || '').trim().toLowerCase();
	} catch {
		return String(clusterUrl || '').trim().toLowerCase();
	}
}

export function getClusterCacheKey(clusterUrlRaw: string): string {
	try {
		const withScheme = ensureHttpsUrl(String(clusterUrlRaw || '').trim());
		const u = new URL(withScheme);
		const host = String(u.hostname || '').trim().toLowerCase();
		return host || String(clusterUrlRaw || '').trim().toLowerCase();
	} catch {
		return String(clusterUrlRaw || '').trim().toLowerCase();
	}
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
	readonly output: vscode.OutputChannel;
	postMessage(message: unknown): void;
	formatQueryExecutionErrorForUser(error: unknown, connection: KustoConnection, database?: string): string;
	normalizeClusterUrlKey(url: string): string;
	getCachedSchemaFromDisk(cacheKey: string): Promise<CachedSchemaEntry | undefined>;
}


// ── ConnectionService class ──

export class ConnectionService {
	private lastConnectionId?: string;
	private lastDatabase?: string;
	/** Tracks when we last showed a DB-load error notification per cluster (to avoid spamming). */
	private lastDbErrorNotificationByCluster = new Map<string, number>();

	constructor(private readonly host: ConnectionServiceHost) {
		this.loadLastSelection();
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
		const c = this.host.normalizeClusterUrlKey(clusterUrl);
		const d = String(database || '').trim().toLowerCase();
		return `${c}|${d}`;
	}

	private async setFavorites(favorites: KustoFavorite[], boxId?: string): Promise<void> {
		await this.host.context.globalState.update(STORAGE_KEYS.favorites, favorites);
		await this.sendFavoritesData(boxId);
	}

	private async sendFavoritesData(boxId?: string): Promise<void> {
		const payload: any = { type: 'favoritesData', favorites: this.getFavorites() };
		if (boxId) {
			payload.boxId = boxId;
		}
		this.host.postMessage(payload);
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
		await this.sendSqlFavoritesData(boxId);
	}

	private async sendSqlFavoritesData(boxId?: string): Promise<void> {
		const payload: any = { type: 'sqlFavoritesData', favorites: this.getSqlFavorites() };
		if (boxId) {
			payload.boxId = boxId;
		}
		this.host.postMessage(payload);
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

	async sendDatabases(connectionId: string, boxId: string, forceRefresh: boolean): Promise<void> {
		const connection = this.findConnection(connectionId);
		if (!connection) {
			return;
		}
		const clusterKey = getClusterCacheKey(connection.clusterUrl);
		const cachedBefore = (this.getCachedDatabases()[clusterKey] ?? []).filter(Boolean);

		if (!forceRefresh && cachedBefore.length > 0) {
			this.host.postMessage({ type: 'databasesData', databases: cachedBefore, boxId, connectionId });
			return;
		}

		const fetchAndNormalize = async (): Promise<string[]> => {
			const databasesRaw = await this.host.kustoClient.getDatabases(connection, true, { allowInteractive: false });
			return (Array.isArray(databasesRaw) ? databasesRaw : [])
				.map((d) => String(d || '').trim())
				.filter(Boolean)
				.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
		};

		try {
			let databasesRaw = await this.host.kustoClient.getDatabases(connection, forceRefresh, { allowInteractive: false });
			let databases = (Array.isArray(databasesRaw) ? databasesRaw : [])
				.map((d) => String(d || '').trim())
				.filter(Boolean)
				.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

			if (forceRefresh && databases.length === 0 && cachedBefore.length === 0) {
				try {
					await this.host.kustoClient.reauthenticate(connection, 'clearPreference');
					databases = await fetchAndNormalize();
				} catch {
					// ignore
				}

				if (databases.length === 0) {
					try {
						const choice = await vscode.window.showWarningMessage(
							"No databases were returned. This is often because the selected account doesn't have access to this cluster.",
							'Try another account',
							'Add account',
							'Cancel'
						);
						if (choice === 'Try another account') {
							await this.host.kustoClient.reauthenticate(connection, 'clearPreference');
							databases = await fetchAndNormalize();
						} else if (choice === 'Add account') {
							await this.host.kustoClient.reauthenticate(connection, 'forceNewSession');
							databases = await fetchAndNormalize();
						}
					} catch {
						// ignore
					}
				}
			}

			if (!forceRefresh || databases.length > 0 || cachedBefore.length === 0) {
				await this.saveCachedDatabases(connectionId, databases);
				this.host.postMessage({ type: 'databasesData', databases, boxId, connectionId });
				return;
			}

			this.host.postMessage({ type: 'databasesData', databases: cachedBefore, boxId, connectionId });
			void vscode.window.showWarningMessage(
				`Couldn't refresh the database list (received 0 databases). Using cached list.`,
				'More Info'
			).then(selection => {
				if (selection === 'More Info') {
					void vscode.window.showInformationMessage(
						`If you expected databases here, try refreshing again and sign in with a different account.`,
						{ modal: true }
					);
				}
			});
		} catch (error) {
			const isAuthErr = this.host.kustoClient.isAuthenticationError(error);
			if (isAuthErr && !forceRefresh && cachedBefore.length > 0) {
				this.host.postMessage({ type: 'databasesData', databases: cachedBefore, boxId, connectionId });
				const now = Date.now();
				const lastShown = this.lastDbErrorNotificationByCluster.get(clusterKey) ?? 0;
				if ((now - lastShown) > 5000) {
					this.lastDbErrorNotificationByCluster.set(clusterKey, now);
					void vscode.window.showWarningMessage(
						`Couldn't refresh the database list due to an authentication error. Using cached list.`,
						'More Info'
					).then(selection => {
						if (selection === 'More Info') {
							void vscode.window.showInformationMessage(
								`Use the refresh button and sign in with the correct account for this cluster.`,
								{ modal: true }
							);
						}
					});
				}
				return;
			}

			if ((forceRefresh || cachedBefore.length === 0) && isAuthErr) {
				try {
					await this.host.kustoClient.reauthenticate(connection, 'clearPreference');
					const databases = await fetchAndNormalize();
					await this.saveCachedDatabases(connectionId, databases);
					this.host.postMessage({ type: 'databasesData', databases, boxId, connectionId });
					return;
				} catch {
					try {
						const choice = await vscode.window.showWarningMessage(
							"Authentication succeeded but the cluster still rejected the request (401/403). Try a different account?",
							'Try another account',
							'Add account',
							'Cancel'
						);
						if (choice === 'Try another account') {
							await this.host.kustoClient.reauthenticate(connection, 'clearPreference');
							const databases = await fetchAndNormalize();
							await this.saveCachedDatabases(connectionId, databases);
							this.host.postMessage({ type: 'databasesData', databases, boxId, connectionId });
							return;
						}
						if (choice === 'Add account') {
							await this.host.kustoClient.reauthenticate(connection, 'forceNewSession');
							const databases = await fetchAndNormalize();
							await this.saveCachedDatabases(connectionId, databases);
							this.host.postMessage({ type: 'databasesData', databases, boxId, connectionId });
							return;
						}
					} catch {
						// fall through to error UI
					}
				}
			}

			const userMessage = this.host.formatQueryExecutionErrorForUser(error, connection);
			const action = forceRefresh ? 'refresh' : 'load';

			// Throttle error notifications: suppress if we showed one for this cluster within the last 5 seconds.
			// This prevents spamming when multiple query sections all fail for the same cluster (e.g. VPN disconnect).
			const now = Date.now();
			const lastShown = this.lastDbErrorNotificationByCluster.get(clusterKey) ?? 0;
			const shouldShowNotification = (now - lastShown) > 5000;
			if (shouldShowNotification) {
				this.lastDbErrorNotificationByCluster.set(clusterKey, now);
			}

			if (cachedBefore.length > 0) {
				this.host.postMessage({ type: 'databasesData', databases: cachedBefore, boxId, connectionId });
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
			this.host.postMessage({
				type: 'databasesError',
				boxId,
				connectionId,
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
		copilotChatFirstTimeDismissed: boolean;
	}): Promise<void> {
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
		const clusterUrlRaw = await vscode.window.showInputBox({
			prompt: 'Cluster URL',
			placeHolder: 'https://mycluster.region.kusto.windows.net',
			ignoreFocusOut: true
		});
		if (!clusterUrlRaw) {
			return;
		}

		let clusterUrl = clusterUrlRaw.trim();
		if (!/^https?:\/\//i.test(clusterUrl)) {
			clusterUrl = 'https://' + clusterUrl.replace(/^\/+/, '');
		}

		const name =
			(await vscode.window.showInputBox({
				prompt: 'Connection name (optional)',
				placeHolder: 'My cluster',
				ignoreFocusOut: true
			})) || '';
		const database =
			(await vscode.window.showInputBox({
				prompt: 'Default database (optional)',
				placeHolder: 'MyDatabase',
				ignoreFocusOut: true
			})) || '';

		const newConn = await this.host.connectionManager.addConnection({
			name: name.trim() || clusterUrl,
			clusterUrl,
			database: database.trim() || undefined
		});
		await this.saveLastSelection(newConn.id, newConn.database);

		this.host.postMessage({
			type: 'connectionAdded',
			boxId,
			connectionId: newConn.id,
			lastConnectionId: this.lastConnectionId,
			lastDatabase: this.lastDatabase,
			connections: this.host.connectionManager.getConnections(),
			cachedDatabases: this.getCachedDatabases()
		});
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

				const cacheKey = `${clusterUrl}|${database}`;
				const cached = await this.host.getCachedSchemaFromDisk(cacheKey);
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
						const a = `${clusterUrl.toLowerCase()}|${database.toLowerCase()}`;
						const b = `${best.clusterUrl.toLowerCase()}|${best.database.toLowerCase()}`;
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
