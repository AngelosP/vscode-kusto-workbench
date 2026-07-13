import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { ConnectionManager, KustoConnection } from './connectionManager';
import { ConnectionService } from './queryEditorConnection';
import { KustoQueryClient, DatabaseSchemaIndex } from './kustoClient';
import { createEmptyKqlxOrMdxFile } from './kqlxFormat';
import { deleteCachedSchemasForConnections, writeCachedSchemaToDisk, SCHEMA_CACHE_VERSION, CachedSchemaEntry, searchCachedSchemas, readAllCachedSchemasFromDisk, type SchemaSearchMatch, schemaCacheKey, schemaPrincipalIdentity } from './schemaCache';
import { searchCachedSqlSchemas, readAllCachedSqlSchemasFromDisk, type SqlSchemaSearchMatch } from './sqlEditorSchema';
import type { SqlConnectionManager } from './sqlConnectionManager';
import type { SqlQueryClient } from './sqlClient';
import { listDialects } from './sql/sqlDialectRegistry';
import { selectBestKustoClusterUrl } from '../shared/kustoClusterUrls';
import { kustoClusterKey } from '../shared/kustoClusterUrls';
import { resolveKustoConnection } from '../shared/kustoAuth';
import { KustoAuthPreferenceService, type KustoAccountPreference } from './kustoAuthPreferenceService';
import { KustoConnectionCache } from './kustoConnectionCache';
import { normalizeKustoAuthorityId } from '../shared/kustoAuth';
import { getKustoConnectionIdentityKey } from '../shared/kustoAuth';
import { parseKustoExplorerConnectionsXml, stringifyKustoExplorerConnectionsXml } from '../shared/kustoExplorerConnections';
import { notifySavedFile, withCsvExtension } from './savedFileNotification';
import {
	addKustoFavoriteIfMissing,
	filterKustoFavoritesForActivePrincipals,
	addSqlFavoriteIfMissing,
	getKustoFavorite,
	getKustoFavoriteDefaultName,
	migrateKustoFavorites,
	migrateKustoFavoritesWithStatus,
	mergeKustoFavoritesForActivePrincipals,
	getSqlFavorite,
	normalizeFavoriteClusterUrl as normalizeStoredFavoriteClusterUrl,
	removeKustoFavorite,
	removeSqlFavorite,
	renameKustoFavorite,
	renameSqlFavorite,
	sanitizeKustoFavorites,
	sanitizeSqlFavorites,
	upsertKustoFavorite,
	upsertSqlFavorite,
	type KustoFavorite,
	type SqlFavorite,
} from './connectionManagerFavorites';
import { getWorkbenchLogger } from './workbenchLogger';
import {
	createDatabaseListTraceId,
	databaseListTraceRef,
	getDatabaseListErrorDetails,
	traceDatabaseList,
} from './databaseListTrace';

/**
 * Connection Manager Viewer — Lit web components edition.
 * Extension-side message handling is identical to the original;
 * HTML shell loads the Lit bundle and renders <kw-connection-manager>.
 */

const VIEW_TITLE = 'Connection Manager';

export type { KustoFavorite, SqlFavorite } from './connectionManagerFavorites';

const STORAGE_KEYS = {
	favorites: 'kusto.favorites',
	expandedClusters: 'kusto.connectionManager.expandedClusters',
	cachedDatabases: 'kusto.cachedDatabases',
	activeKind: 'connectionManager.activeKind',
	sqlExpandedConnections: 'sql.connectionManager.expandedConnections',
	sqlCachedDatabases: 'sql.connectionManager.cachedDatabases',
	sqlFavorites: 'sql.favorites',
	sqlLeaveNoTrace: 'sql.leaveNoTraceConnections',
	searchState: 'connectionManager.searchState',
} as const;

export type ConnectionKind = 'kusto' | 'sql';

type IncomingMessage =
	| { type: 'requestSnapshot' }
	| { type: 'connection.add'; name: string; clusterUrl: string; database?: string; authorityId?: string; accountId?: string }
	| { type: 'connection.edit'; id: string; name: string; clusterUrl: string; database?: string; authorityId?: string; accountId?: string }
	| { type: 'connection.delete'; id: string }
	| { type: 'connection.test'; id?: string; name?: string; clusterUrl?: string; database?: string; authorityId?: string; accountId?: string }
	| { type: 'connection.duplicate'; id: string }
	| { type: 'favorite.add'; connectionId: string; database: string; name: string }
	| { type: 'favorite.promptAdd'; connectionId: string; database: string; defaultName?: string }
	| { type: 'favorite.promptRename'; connectionId: string; database: string }
	| { type: 'favorite.remove'; connectionId: string; database: string }
	| { type: 'favorite.reorder'; favorites: KustoFavorite[] }
	| { type: 'cluster.expand'; connectionId: string }
	| { type: 'cluster.collapse'; connectionId: string }
	| { type: 'cluster.refreshDatabases'; connectionId: string }
	| { type: 'database.getSchema'; connectionId: string; database: string }
	| { type: 'copyToClipboard'; text: string }
	| { type: 'openInEditor'; connectionId: string; database?: string }
	| { type: 'leaveNoTrace.add'; clusterUrl: string }
	| { type: 'leaveNoTrace.remove'; clusterUrl: string }
	| { type: 'connection.importXml' }
	| { type: 'connection.exportXml' }
	| { type: 'database.openInNewFile'; connectionId: string; clusterUrl: string; database: string }
	| { type: 'database.refreshSchema'; connectionId: string; clusterUrl: string; database: string; source?: string }
	| { type: 'cluster.refreshSchema'; connectionId: string }
	| { type: 'table.preview'; connectionId: string; database: string; tableName: string }
	| { type: 'saveResultsCsv'; csv: string; suggestedFileName?: string }
	// SQL connection management
	| { type: 'setActiveKind'; kind: ConnectionKind }
	| { type: 'sql.connection.add'; name: string; serverUrl: string; port?: number; dialect: string; authType: string; username?: string; password?: string; database?: string }
	| { type: 'sql.connection.edit'; id: string; name: string; serverUrl: string; port?: number; dialect: string; authType: string; username?: string; password?: string; database?: string }
	| { type: 'sql.connection.delete'; id: string }
	| { type: 'sql.connection.test'; id: string; password?: string }
	| { type: 'sql.connection.duplicate'; id: string }
	| { type: 'sql.cluster.expand'; connectionId: string }
	| { type: 'sql.cluster.collapse'; connectionId: string }
	| { type: 'sql.cluster.refreshDatabases'; connectionId: string }
	| { type: 'sql.database.getSchema'; connectionId: string; database: string }
	| { type: 'sql.database.refreshSchema'; connectionId: string; database: string; source?: string }
	| { type: 'sql.database.openInNewFile'; serverUrl: string; database: string }
	| { type: 'sql.table.preview'; connectionId: string; database: string; tableName: string }
	| { type: 'sql.favorite.add'; connectionId: string; database: string; name: string }
	| { type: 'sql.favorite.promptAdd'; connectionId: string; database: string; defaultName?: string }
	| { type: 'sql.favorite.promptRename'; connectionId: string; database: string }
	| { type: 'sql.favorite.remove'; connectionId: string; database: string }
	| { type: 'sql.leaveNoTrace.add'; connectionId: string }
	| { type: 'sql.leaveNoTrace.remove'; connectionId: string }
	// Search
	| { type: 'search'; requestId: string; query: string; scope: string; kind: ConnectionKind; categories: Record<string, boolean>; contentToggles: Record<string, boolean> }
	| { type: 'search.cancel'; requestId: string }
	| { type: 'search.saveState'; state: unknown };

export interface ConnectionManagerSqlDeps {
	getSqlConnectionManager: () => SqlConnectionManager;
	getSqlClient: () => SqlQueryClient;
}

export class ConnectionManagerViewerV2 {
	private static current: ConnectionManagerViewerV2 | undefined;

	public static open(
		context: vscode.ExtensionContext,
		extensionUri: vscode.Uri,
		connectionManager: ConnectionManager,
		sqlDeps?: ConnectionManagerSqlDeps,
		viewColumn: vscode.ViewColumn = vscode.ViewColumn.One
	): void {
		if (ConnectionManagerViewerV2.current) {
			// Update SQL deps on re-reveal in case they changed
			if (sqlDeps) {
				ConnectionManagerViewerV2.current.sqlDeps = sqlDeps;
			}
			ConnectionManagerViewerV2.current.panel.webview.html = ConnectionManagerViewerV2.current.buildHtml(
				ConnectionManagerViewerV2.current.panel.webview
			);
			ConnectionManagerViewerV2.current.panel.reveal(viewColumn);
			return;
		}
		ConnectionManagerViewerV2.current = new ConnectionManagerViewerV2(context, extensionUri, connectionManager, sqlDeps, viewColumn);
	}

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly kustoClient: KustoQueryClient;
	private readonly authPreferences: KustoAuthPreferenceService;
	private readonly connectionCache: KustoConnectionCache;
	private schemaCache: Map<string, { schema: DatabaseSchemaIndex; timestamp: number }> = new Map();
	private sqlDeps: ConnectionManagerSqlDeps | undefined;
	private configSubscription: vscode.Disposable | undefined;
	private _activeSearchRequestId: string | null = null;
	private _searchAbortController: AbortController | null = null;

	private traceDatabaseList(traceId: string, event: string, details: Record<string, unknown> = {}): void {
		traceDatabaseList(getWorkbenchLogger(), traceId, 'connection-manager', event, details);
	}

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager,
		sqlDeps: ConnectionManagerSqlDeps | undefined,
		viewColumn: vscode.ViewColumn
	) {
		this.authPreferences = KustoAuthPreferenceService.getInstance(this.context);
		this.connectionCache = new KustoConnectionCache(this.context);
		this.kustoClient = new KustoQueryClient(this.context, undefined, this.connectionManager);
		this.sqlDeps = sqlDeps;
		this.panel = vscode.window.createWebviewPanel(
			'kusto.connectionManagerV2',
			VIEW_TITLE,
			{ viewColumn, preserveFocus: false },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [this.extensionUri]
			}
		);
		this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'images', 'kusto-workbench-logo.png');

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.disposables.push(ConnectionService.onKustoFavoritesChanged((context) => {
			if (context === this.context) {
				return this.sendSnapshotToWebview();
			}
			return undefined;
		}));
		this.disposables.push(this.authPreferences.onDidChange(() => this.sendSnapshotToWebview()));
		this.panel.onDidChangeViewState((e) => {
			if (e.webviewPanel.visible) {
				void this.sendSnapshotToWebview();
			}
		}, null, this.disposables);
		this.panel.webview.onDidReceiveMessage((msg: IncomingMessage) => void this.onMessage(msg), null, this.disposables);
		this.panel.webview.html = this.buildHtml(this.panel.webview);
		this.watchAlternatingRowColorSetting();
	}

	private dispose(): void {
		ConnectionManagerViewerV2.current = undefined;
		this.kustoClient.dispose();
		this.configSubscription?.dispose();
		for (const d of this.disposables) {
			try { d.dispose(); } catch { /* ignore */ }
		}
		this._searchAbortController?.abort();
	}

	// ─── Data helpers (identical to original) ───────────────────────────────
	private getFavoriteAccountPartitions(): Map<string, string | undefined> {
		return new Map(this.connectionManager.getConnections().map(connection => {
			let partition: string | undefined;
			try { partition = this.kustoClient.getAccountPartition(connection); } catch { partition = undefined; }
			return [connection.id, partition];
		}));
	}

	private getFavorites(): KustoFavorite[] {
		const raw = this.context.globalState.get<unknown>(STORAGE_KEYS.favorites);
		const partitions = this.getFavoriteAccountPartitions();
		const { favorites, unresolved } = migrateKustoFavoritesWithStatus(raw, this.connectionManager.getConnections(), partitions);
		if (unresolved === 0 && JSON.stringify(raw ?? []) !== JSON.stringify(favorites)) void this.context.globalState.update(STORAGE_KEYS.favorites, favorites);
		return filterKustoFavoritesForActivePrincipals(favorites, partitions);
	}

	private getActiveSchemaPrincipalIdentities(): Set<string> {
		const identities = new Set<string>();
		for (const connection of this.connectionManager.getConnections()) {
			let partition: string | undefined;
			try { partition = this.kustoClient.getAccountPartition(connection); } catch { partition = undefined; }
			const identity = schemaPrincipalIdentity(connection.id, partition);
			if (identity) identities.add(identity);
		}
		return identities;
	}

	private async setFavorites(
		favorites: KustoFavorite[],
		expectedOwner?: { connectionId: string; accountPartition?: string },
	): Promise<void> {
		const raw = this.context.globalState.get<unknown>(STORAGE_KEYS.favorites);
		const partitions = this.getFavoriteAccountPartitions();
		if (expectedOwner && partitions.get(expectedOwner.connectionId) !== expectedOwner.accountPartition) return;
		const allFavorites = migrateKustoFavoritesWithStatus(raw, this.connectionManager.getConnections(), partitions).favorites;
		await this.context.globalState.update(STORAGE_KEYS.favorites, mergeKustoFavoritesForActivePrincipals(allFavorites, favorites, partitions));
		ConnectionService.broadcastKustoFavoritesData(this.context);
	}

	private getExpandedClusters(): string[] {
		const raw = this.context.globalState.get<string[] | undefined>(STORAGE_KEYS.expandedClusters);
		return Array.isArray(raw) ? raw.filter((s) => typeof s === 'string') : [];
	}

	private async setExpandedClusters(expanded: string[]): Promise<void> {
		await this.context.globalState.update(STORAGE_KEYS.expandedClusters, expanded);
	}

	private getCachedDatabases(): Record<string, string[]> {
		const result: Record<string, string[]> = {};
		const connections = this.connectionManager.getConnections();
		for (const connection of connections) {
			let partition: string | undefined;
			let allowLegacy = false;
			try {
				const preference = this.authPreferences.getPreference(connection.id);
				partition = this.kustoClient.getAccountPartition(connection);
				allowLegacy = preference.mode === 'automatic' && normalizeKustoAuthorityId(connection.authorityId) === undefined;
			} catch {
				continue;
			}
			const databases = this.connectionCache.getDatabases(connection.id, partition, allowLegacy);
			if (databases.length > 0) result[connection.id] = databases;
		}
		return result;
	}

	private getClusterCacheKey(clusterUrlRaw: string): string {
		return kustoClusterKey(clusterUrlRaw);
	}

	// ─── SQL data helpers ───────────────────────────────────────────────────

	private getSqlExpandedConnections(): string[] {
		const raw = this.context.globalState.get<string[] | undefined>(STORAGE_KEYS.sqlExpandedConnections);
		return Array.isArray(raw) ? raw.filter((s) => typeof s === 'string') : [];
	}

	private async setSqlExpandedConnections(expanded: string[]): Promise<void> {
		await this.context.globalState.update(STORAGE_KEYS.sqlExpandedConnections, expanded);
	}

	private getSqlCachedDatabases(): Record<string, string[]> {
		const raw = this.context.globalState.get<Record<string, string[]> | undefined>(STORAGE_KEYS.sqlCachedDatabases);
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
		const result: Record<string, string[]> = {};
		for (const [k, v] of Object.entries(raw)) {
			if (typeof k === 'string' && Array.isArray(v)) result[k] = v.filter((d) => typeof d === 'string');
		}
		return result;
	}

	private async setSqlCachedDatabases(cached: Record<string, string[]>): Promise<void> {
		await this.context.globalState.update(STORAGE_KEYS.sqlCachedDatabases, cached);
	}

	private getSqlFavorites(): SqlFavorite[] {
		const raw = this.context.globalState.get<unknown>(STORAGE_KEYS.sqlFavorites);
		return sanitizeSqlFavorites(raw);
	}

	private async setSqlFavorites(favorites: SqlFavorite[]): Promise<void> {
		await this.context.globalState.update(STORAGE_KEYS.sqlFavorites, favorites);
	}

	private getSqlLeaveNoTrace(): string[] {
		const raw = this.context.globalState.get<string[] | undefined>(STORAGE_KEYS.sqlLeaveNoTrace);
		return Array.isArray(raw) ? raw.filter((s) => typeof s === 'string') : [];
	}

	private async setSqlLeaveNoTrace(connectionIds: string[]): Promise<void> {
		await this.context.globalState.update(STORAGE_KEYS.sqlLeaveNoTrace, connectionIds);
	}

	private getActiveKind(): ConnectionKind {
		const raw = this.context.globalState.get<string>(STORAGE_KEYS.activeKind);
		return raw === 'sql' ? 'sql' : 'kusto';
	}

	private async setActiveKind(kind: ConnectionKind): Promise<void> {
		await this.context.globalState.update(STORAGE_KEYS.activeKind, kind);
	}

	private getKustoSearchPrincipalFingerprint(): string {
		return [...this.getActiveSchemaPrincipalIdentities()].sort().join(';');
	}

	private getSearchState(): unknown {
		const raw = this.context.globalState.get<unknown>(STORAGE_KEYS.searchState) ?? null;
		if (this.getActiveKind() !== 'kusto' || !raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
		const state = raw as Record<string, unknown>;
		return state.kustoPrincipalFingerprint === this.getKustoSearchPrincipalFingerprint()
			? state
			: { ...state, lastResults: [], lastSearchTimestamp: 0 };
	}

	private async setSearchState(state: unknown): Promise<void> {
		if (this.getActiveKind() === 'kusto' && state && typeof state === 'object' && !Array.isArray(state)) {
			await this.context.globalState.update(STORAGE_KEYS.searchState, {
				...(state as Record<string, unknown>),
				kustoPrincipalFingerprint: this.getKustoSearchPrincipalFingerprint(),
			});
			return;
		}
		await this.context.globalState.update(STORAGE_KEYS.searchState, state);
	}

	private async buildSnapshot() {
		const sqlConnections = this.sqlDeps ? this.sqlDeps.getSqlConnectionManager().getConnections() : [];
		const accounts = await this.authPreferences.getAccounts();
		const connections = this.connectionManager.getConnections().map(connection => {
			let accountPartition: string | undefined;
			try { accountPartition = this.kustoClient.getAccountPartition(connection); } catch { accountPartition = undefined; }
			return {
				...connection,
				accountPreference: this.authPreferences.getPreference(connection.id),
				selectedAccountId: this.authPreferences.getPreferredAccountId(connection.id),
				accountPartition,
			};
		});
		return {
			timestamp: Date.now(),
			activeKind: this.getActiveKind(),
			connections,
			accounts,
			favorites: this.getFavorites(),
			cachedDatabases: this.getCachedDatabases(),
			expandedClusters: this.getExpandedClusters(),
			leaveNoTraceClusters: this.connectionManager.getLeaveNoTraceClusters(),
			// SQL
			sqlConnections,
			sqlCachedDatabases: this.getSqlCachedDatabases(),
			sqlExpandedConnections: this.getSqlExpandedConnections(),
			sqlFavorites: this.getSqlFavorites(),
			sqlLeaveNoTrace: this.getSqlLeaveNoTrace(),
			sqlDialects: listDialects().map(d => ({ id: d.id, displayName: d.displayName, defaultPort: d.defaultPort, authTypes: d.authTypes.map(a => ({ id: a.id, displayName: a.label })) })),
			// Search
			searchState: this.getSearchState(),
		};
	}

	private async sendSnapshotToWebview(): Promise<void> {
		try {
			const snapshot = await this.buildSnapshot();
			await this.panel.webview.postMessage({ type: 'snapshot', snapshot });
		} catch (error) {
			// Ignore transient panel lifecycle races (dispose/reveal ordering), but keep diagnostics.
			getWorkbenchLogger().warn('[kusto] connection manager snapshot refresh failed', error);
		}
	}

	private async promptAddFavorite(connectionIdRaw: string, databaseRaw: string, defaultNameRaw?: string): Promise<void> {
		const connectionId = String(connectionIdRaw || '').trim();
		const connection = this.connectionManager.getConnections().find(candidate => candidate.id === connectionId);
		const clusterUrl = connection ? normalizeStoredFavoriteClusterUrl(connection.clusterUrl) : '';
		const database = String(databaseRaw || '').trim();
		if (!clusterUrl || !database) return;
		const startingAccountPartition = connection ? this.kustoClient.getAccountPartition(connection) : undefined;
		const defaultName = String(defaultNameRaw || '').trim() || getKustoFavoriteDefaultName(clusterUrl, database);
		const picked = await vscode.window.showInputBox({
			title: 'Add to favorites',
			prompt: 'Enter a friendly name for this cluster + database',
			value: defaultName,
			ignoreFocusOut: true,
		});
		const name = typeof picked === 'string' ? picked.trim() : '';
		if (!name) return;
		if (!connection || this.kustoClient.getAccountPartition(connection) !== startingAccountPartition) return;
		const result = upsertKustoFavorite(this.getFavorites(), { name, connectionId, clusterUrl, database, accountPartition: startingAccountPartition });
		if (result.changed) {
			await this.setFavorites(result.favorites, { connectionId, accountPartition: startingAccountPartition });
			void vscode.window.setStatusBarMessage(`Favorite "${name}" saved`, 2000);
		}
		await this.sendSnapshotToWebview();
	}

	private async promptRenameFavorite(connectionIdRaw: string, databaseRaw: string): Promise<void> {
		const connectionId = String(connectionIdRaw || '').trim();
		const database = String(databaseRaw || '').trim();
		if (!connectionId || !database) return;
		const connection = this.connectionManager.getConnections().find(candidate => candidate.id === connectionId);
		const startingAccountPartition = connection ? this.kustoClient.getAccountPartition(connection) : undefined;
		const current = getKustoFavorite(this.getFavorites(), connectionId, database);
		if (!current) { await this.sendSnapshotToWebview(); return; }
		const picked = await vscode.window.showInputBox({
			title: 'Rename favorite',
			prompt: 'Enter a friendly name for this cluster + database',
			value: current.name,
			ignoreFocusOut: true,
		});
		const name = typeof picked === 'string' ? picked.trim() : '';
		if (!name) return;
		if (!connection || this.kustoClient.getAccountPartition(connection) !== startingAccountPartition) return;
		const result = renameKustoFavorite(this.getFavorites(), connectionId, database, name);
		for (const favorite of result.favorites) {
			if (favorite.connectionId === connectionId && favorite.database.toLowerCase() === database.toLowerCase()) {
				favorite.accountPartition = startingAccountPartition;
			}
		}
		if (result.changed) {
			await this.setFavorites(result.favorites, { connectionId, accountPartition: startingAccountPartition });
			void vscode.window.setStatusBarMessage(`Favorite renamed to "${name}"`, 2000);
		}
		await this.sendSnapshotToWebview();
	}

	private getSqlFavoriteDefaultName(connectionId: string, database: string): string {
		const connection = this.sqlDeps?.getSqlConnectionManager().getConnection(connectionId);
		const serverName = connection ? (connection.name || connection.serverUrl || connectionId) : connectionId;
		return `${serverName}.${database}`;
	}

	private async promptAddSqlFavorite(connectionIdRaw: string, databaseRaw: string, defaultNameRaw?: string): Promise<void> {
		const connectionId = String(connectionIdRaw || '').trim();
		const database = String(databaseRaw || '').trim();
		if (!connectionId || !database) return;
		const defaultName = String(defaultNameRaw || '').trim() || this.getSqlFavoriteDefaultName(connectionId, database);
		const picked = await vscode.window.showInputBox({
			title: 'Add to favorites',
			prompt: 'Enter a friendly name for this server + database',
			value: defaultName,
			ignoreFocusOut: true,
		});
		const name = typeof picked === 'string' ? picked.trim() : '';
		if (!name) return;
		const result = upsertSqlFavorite(this.getSqlFavorites(), { name, connectionId, database });
		if (result.changed) {
			await this.setSqlFavorites(result.favorites);
			void vscode.window.setStatusBarMessage(`SQL favorite "${name}" saved`, 2000);
		}
		await this.sendSnapshotToWebview();
	}

	private async promptRenameSqlFavorite(connectionIdRaw: string, databaseRaw: string): Promise<void> {
		const connectionId = String(connectionIdRaw || '').trim();
		const database = String(databaseRaw || '').trim();
		if (!connectionId || !database) return;
		const current = getSqlFavorite(this.getSqlFavorites(), connectionId, database);
		if (!current) { await this.sendSnapshotToWebview(); return; }
		const picked = await vscode.window.showInputBox({
			title: 'Rename favorite',
			prompt: 'Enter a friendly name for this server + database',
			value: current.name,
			ignoreFocusOut: true,
		});
		const name = typeof picked === 'string' ? picked.trim() : '';
		if (!name) return;
		const result = renameSqlFavorite(this.getSqlFavorites(), connectionId, database, name);
		if (result.changed) {
			await this.setSqlFavorites(result.favorites);
			void vscode.window.setStatusBarMessage(`SQL favorite renamed to "${name}"`, 2000);
		}
		await this.sendSnapshotToWebview();
	}

	// ─── Message handling (identical to original) ───────────────────────────

	private async onMessage(msg: IncomingMessage): Promise<void> {
		switch (msg.type) {
			case 'requestSnapshot': {
				await this.sendSnapshotToWebview();
				this.sendAlternatingRowColorSetting();
				return;
			}
			case 'connection.add': {
				const name = String(msg.name || '').trim();
				const clusterUrl = String(msg.clusterUrl || '').trim();
				const database = msg.database ? String(msg.database).trim() : undefined;
				const accountId = String(msg.accountId || '').trim();
				if (!name || !clusterUrl) {
					const error = 'Connection name and cluster URL are required.';
					void vscode.window.showErrorMessage(error);
					this.panel.webview.postMessage({ type: 'connectionMutationComplete', success: false, error });
					return;
				}
				let success = false;
				let errorMessage = '';
				try {
					const authorityId = normalizeKustoAuthorityId(msg.authorityId);
					const added = await this.connectionManager.addConnection({ name, clusterUrl, database, authorityId });
					if (accountId) {
						const account = (await this.authPreferences.getAccounts()).find(candidate => candidate.id === accountId) ?? { id: accountId, label: accountId };
						await this.authPreferences.setExplicitAccount(added.id, account);
					}
					void vscode.window.setStatusBarMessage(`Connection "${name}" added successfully`, 2000);
					success = true;
				} catch (error) {
					errorMessage = error instanceof Error ? error.message : String(error);
					void vscode.window.showErrorMessage(`Failed to add connection: ${errorMessage}`);
				}
				await this.sendSnapshotToWebview();
				this.panel.webview.postMessage({ type: 'connectionMutationComplete', success, ...(errorMessage ? { error: errorMessage } : {}) });
				return;
			}
			case 'connection.edit': {
				const id = String(msg.id || '').trim();
				const name = String(msg.name || '').trim();
				const clusterUrl = String(msg.clusterUrl || '').trim();
				const database = msg.database ? String(msg.database).trim() : undefined;
				const accountId = String(msg.accountId || '').trim();
				if (!id || !name || !clusterUrl) {
					const error = 'Connection ID, name, and cluster URL are required.';
					void vscode.window.showErrorMessage(error);
					this.panel.webview.postMessage({ type: 'connectionMutationComplete', success: false, error });
					return;
				}
				let success = false;
				let errorMessage = '';
				try {
					const authorityId = normalizeKustoAuthorityId(msg.authorityId);
					await this.connectionCache.clearConnection(id);
					await deleteCachedSchemasForConnections(this.context.globalStorageUri, new Set([id]));
					await this.connectionManager.updateConnection(id, { name, clusterUrl, database, authorityId });
					if (accountId) {
						const account = (await this.authPreferences.getAccounts()).find(candidate => candidate.id === accountId) ?? { id: accountId, label: accountId };
						await this.authPreferences.setExplicitAccount(id, account);
					} else {
						await this.authPreferences.setAutomatic(id);
					}
					void vscode.window.setStatusBarMessage(`Connection "${name}" updated successfully`, 2000);
					success = true;
				} catch (error) {
					errorMessage = error instanceof Error ? error.message : String(error);
					void vscode.window.showErrorMessage(`Failed to update connection: ${errorMessage}`);
				}
				await this.sendSnapshotToWebview();
				this.panel.webview.postMessage({ type: 'connectionMutationComplete', success, ...(errorMessage ? { error: errorMessage } : {}) });
				return;
			}
			case 'connection.delete': {
				const id = String(msg.id || '').trim();
				if (!id) return;
				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === id);
				const connName = conn?.name || id;
				const confirm = await vscode.window.showWarningMessage(`Delete connection "${connName}"?`, { modal: true }, 'Delete');
				if (confirm !== 'Delete') return;
				try {
					if (conn) {
						const raw = this.context.globalState.get<unknown>(STORAGE_KEYS.favorites);
						const allFavorites = migrateKustoFavorites(raw, connections, this.getFavoriteAccountPartitions())
							.filter(favorite => favorite.connectionId !== conn.id);
						await this.context.globalState.update(STORAGE_KEYS.favorites, allFavorites);
						ConnectionService.broadcastKustoFavoritesData(this.context);
					}
					await this.connectionCache.clearConnection(id);
					await deleteCachedSchemasForConnections(this.context.globalStorageUri, new Set([id]));
					await this.connectionManager.removeConnection(id);
					void vscode.window.setStatusBarMessage(`Connection "${connName}" deleted`, 2000);
					const snapshot = await this.buildSnapshot();
					this.panel.webview.postMessage({ type: 'snapshot', snapshot });
				} catch (error) { void vscode.window.showErrorMessage(`Failed to delete connection: ${error instanceof Error ? error.message : String(error)}`); }
				return;
			}
			case 'connection.test': {
				const traceId = createDatabaseListTraceId();
				const id = String(msg.id || '').trim();
				const stored = id ? this.connectionManager.getConnections().find((connection) => connection.id === id) : undefined;
				const clusterUrl = String(msg.clusterUrl || stored?.clusterUrl || '').trim();
				let conn: KustoConnection | undefined;
				try {
					conn = clusterUrl ? {
						id: `draft:${Date.now()}:${Math.random().toString(36).slice(2)}`,
						name: String(msg.name || stored?.name || '').trim() || clusterUrl,
						clusterUrl,
						database: String(msg.database || stored?.database || '').trim() || undefined,
						authorityId: normalizeKustoAuthorityId(msg.authorityId ?? stored?.authorityId),
					} : undefined;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this.panel.webview.postMessage({ type: 'testConnectionResult', connectionId: id || 'draft', success: false, message });
					return;
				}
				if (!conn) {
					this.traceDatabaseList(traceId, 'test.connection-missing', { connectionId: id || 'draft' });
					void vscode.window.showErrorMessage('Connection not found.');
					return;
				}
				this.traceDatabaseList(traceId, 'test.start', { connectionId: id || conn.id });
				this.panel.webview.postMessage({ type: 'testConnectionStarted', connectionId: id || conn.id });
				try {
					const accountId = String(msg.accountId || '').trim();
					const preference: KustoAccountPreference = accountId ? { mode: 'explicit', accountId } : { mode: 'automatic' };
					const databases = await this.kustoClient.withTransientAuthPreference(conn, preference, () =>
						this.kustoClient.getDatabases(conn, true, { traceId, source: 'connection-manager-test', persistIdentity: false })
					);
					this.traceDatabaseList(traceId, 'test.success', { connectionId: id || conn.id, databaseCount: databases.length });
					if (databases.length === 0) {
						this.panel.webview.postMessage({ type: 'testConnectionResult', connectionId: id || conn.id, success: false, warning: true, message: 'Connected, but no databases are visible. Check the Authority / Tenant ID and account.', databases });
					} else {
						this.panel.webview.postMessage({ type: 'testConnectionResult', connectionId: id || conn.id, success: true, message: `Connected successfully! Found ${databases.length} database(s).`, databases });
					}
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					const isAuthError = this.kustoClient.isAuthenticationError(error);
					this.traceDatabaseList(traceId, 'test.failed', {
						connectionId: id || conn.id,
						isAuthError,
						...getDatabaseListErrorDetails(error),
					});
					this.panel.webview.postMessage({ type: 'testConnectionResult', connectionId: id || conn.id, success: false, message: isAuthError ? 'Authentication failed. Please sign in when prompted.' : `Connection failed: ${errorMsg}`, isAuthError });
				}
				return;
			}
			case 'connection.duplicate': {
				const id = String(msg.id || '').trim();
				if (!id) return;
				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === id);
				if (!conn) { void vscode.window.showErrorMessage('Connection not found.'); return; }
				try {
					const duplicate = await this.connectionManager.addConnection({ name: `${conn.name} (copy)`, clusterUrl: conn.clusterUrl, database: conn.database, authorityId: conn.authorityId });
					const preference = this.authPreferences.getPreference(conn.id);
					if (preference.mode === 'explicit') {
						const account = (await this.authPreferences.getAccounts()).find(candidate => candidate.id === preference.accountId) ?? { id: preference.accountId, label: preference.accountId };
						await this.authPreferences.setExplicitAccount(duplicate.id, account);
					}
					void vscode.window.setStatusBarMessage('Connection duplicated', 2000);
				} catch (error) { void vscode.window.showErrorMessage(`Failed to duplicate connection: ${error instanceof Error ? error.message : String(error)}`); }
				return;
			}
			case 'favorite.add': {
				const connectionId = String(msg.connectionId || '').trim();
				const connection = this.connectionManager.getConnections().find(candidate => candidate.id === connectionId);
				const clusterUrl = String(connection?.clusterUrl || '').trim();
				const database = String(msg.database || '').trim();
				const name = String(msg.name || '').trim();
				if (!clusterUrl || !database || !name) return;
				const result = addKustoFavoriteIfMissing(this.getFavorites(), { name, connectionId, clusterUrl, database });
				if (result.changed) {
					await this.setFavorites(result.favorites);
				}
				await this.sendSnapshotToWebview();
				return;
			}
			case 'favorite.promptAdd': {
				await this.promptAddFavorite(msg.connectionId, msg.database, msg.defaultName);
				return;
			}
			case 'favorite.promptRename': {
				await this.promptRenameFavorite(msg.connectionId, msg.database);
				return;
			}
			case 'favorite.remove': {
				const connectionId = String(msg.connectionId || '').trim();
				const database = String(msg.database || '').trim();
				if (!connectionId || !database) return;
				const result = removeKustoFavorite(this.getFavorites(), connectionId, database);
				if (result.changed) {
					await this.setFavorites(result.favorites);
				}
				await this.sendSnapshotToWebview();
				return;
			}
			case 'favorite.reorder': {
				if (Array.isArray(msg.favorites)) {
					await this.setFavorites(migrateKustoFavorites(msg.favorites, this.connectionManager.getConnections()));
					await this.sendSnapshotToWebview();
				}
				return;
			}
			case 'cluster.expand': {
				const traceId = createDatabaseListTraceId();
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) {
					this.traceDatabaseList(traceId, 'expand.invalid-request', { reason: 'missing-connection-id' });
					return;
				}
				const expanded = this.getExpandedClusters();
				if (!expanded.includes(connectionId)) { expanded.push(connectionId); await this.setExpandedClusters(expanded); }
				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === connectionId);
				if (conn) {
					const clusterKey = this.getClusterCacheKey(conn.clusterUrl);
					const cached = this.getCachedDatabases();
					const cachedCount = cached[connectionId]?.length ?? 0;
					this.traceDatabaseList(traceId, 'expand.start', { connectionId, clusterKey, persistedCacheCount: cachedCount });
					if (!cached[connectionId] || cached[connectionId].length === 0) {
						this.panel.webview.postMessage({ type: 'loadingDatabases', connectionId });
						try {
							const databases = await this.kustoClient.getDatabases(conn, false, {
								allowInteractive: false,
								traceId,
								source: 'connection-manager-expand',
							});
							this.traceDatabaseList(traceId, 'expand.live-success', { connectionId, databaseCount: databases.length, persistedCacheUpdated: true });
							this.panel.webview.postMessage({ type: 'databasesLoaded', connectionId, databases });
						} catch (error) {
							this.traceDatabaseList(traceId, 'expand.failed', {
								connectionId,
								isAuthError: this.kustoClient.isAuthenticationError(error),
								...getDatabaseListErrorDetails(error),
							});
							this.panel.webview.postMessage({ type: 'databasesLoadError', connectionId, error: error instanceof Error ? error.message : String(error) });
						}
					} else {
						this.traceDatabaseList(traceId, 'expand.persisted-cache-hit', { connectionId, databaseCount: cachedCount });
					}
				} else {
					this.traceDatabaseList(traceId, 'expand.connection-missing', { connectionId });
				}
				return;
			}
			case 'cluster.collapse': {
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) return;
				const expanded = this.getExpandedClusters().filter((id) => id !== connectionId);
				await this.setExpandedClusters(expanded);
				return;
			}
			case 'cluster.refreshDatabases': {
				const traceId = createDatabaseListTraceId();
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) {
					this.traceDatabaseList(traceId, 'refresh.invalid-request', { reason: 'missing-connection-id' });
					return;
				}
				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === connectionId);
				if (!conn) {
					this.traceDatabaseList(traceId, 'refresh.connection-missing', { connectionId });
					return;
				}
				const cachedBefore = this.getCachedDatabases()[connectionId] ?? [];
				this.traceDatabaseList(traceId, 'refresh.start', { connectionId });
				this.panel.webview.postMessage({ type: 'loadingDatabases', connectionId });
				try {
					const databases = await this.kustoClient.getDatabases(conn, true, { traceId, source: 'connection-manager-refresh' });
					if (databases.length === 0) {
						if (cachedBefore.length > 0) {
							this.panel.webview.postMessage({ type: 'databasesLoaded', connectionId, databases: cachedBefore, warning: true });
							void vscode.window.showWarningMessage("Couldn't refresh the database list (received 0 databases). Keeping the previous cached list.");
						} else {
							this.panel.webview.postMessage({ type: 'databasesLoaded', connectionId, databases: [], warning: true });
							void vscode.window.showWarningMessage('The selected identity can connect but no databases are visible. Check the Authority / Tenant ID and account.');
						}
						return;
					}
					const clusterKey = this.getClusterCacheKey(conn.clusterUrl);
					this.traceDatabaseList(traceId, 'refresh.success', { connectionId, databaseCount: databases.length, persistedCacheUpdated: true });
					this.panel.webview.postMessage({ type: 'databasesLoaded', connectionId, databases });
				} catch (error) {
					const isAuthError = this.kustoClient.isAuthenticationError(error);
					this.traceDatabaseList(traceId, 'refresh.failed', {
						connectionId,
						isAuthError,
						...getDatabaseListErrorDetails(error),
					});
					this.panel.webview.postMessage({ type: 'databasesLoadError', connectionId, error: isAuthError ? 'Authentication required. Please test the connection to sign in.' : error instanceof Error ? error.message : String(error) });
				}
				return;
			}
			case 'database.getSchema': {
				const requestId = createDatabaseListTraceId();
				const connectionId = String(msg.connectionId || '').trim();
				const database = String(msg.database || '').trim();
				if (!connectionId || !database) return;
				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === connectionId);
				if (!conn) return;
				let startingAccountPartition: string | undefined;
				try { startingAccountPartition = this.kustoClient.getAccountPartition(conn); } catch { startingAccountPartition = undefined; }
				this.panel.webview.postMessage({ type: 'loadingSchema', connectionId, database, requestId, accountPartition: startingAccountPartition });
				try {
					const result = await this.kustoClient.getDatabaseSchema(conn, database, false);
					await this.sendSnapshotToWebview();
					if (!result.accountPartition || this.kustoClient.getAccountPartition(conn) !== result.accountPartition) {
						this.panel.webview.postMessage({ type: 'schemaLoadError', connectionId, database, requestId, error: 'Authentication changed while schema was loading.' });
						return;
					}
					this.panel.webview.postMessage({ type: 'schemaLoaded', connectionId, database, requestId, accountPartition: result.accountPartition, schema: result.schema, fromCache: result.fromCache, cacheAgeMs: result.cacheAgeMs });
				} catch (error) { this.panel.webview.postMessage({ type: 'schemaLoadError', connectionId, database, requestId, error: error instanceof Error ? error.message : String(error) }); }
				return;
			}
			case 'database.refreshSchema': {
				const requestId = createDatabaseListTraceId();
				const connectionId = String(msg.connectionId || '').trim();
				const clusterUrl = String(msg.clusterUrl || '').trim();
				const database = String(msg.database || '').trim();
				const source = String(msg.source || '').trim();
				if (!connectionId || !clusterUrl || !database) return;
				const conn = this.connectionManager.getConnections().find(candidate => candidate.id === connectionId);
				if (!conn || kustoClusterKey(conn.clusterUrl) !== kustoClusterKey(clusterUrl)) return;
				let startingAccountPartition: string | undefined;
				try { startingAccountPartition = this.kustoClient.getAccountPartition(conn); } catch { startingAccountPartition = undefined; }
				this.panel.webview.postMessage({ type: 'schemaRefreshStarted', connectionId, clusterUrl, database, requestId, accountPartition: startingAccountPartition });
				try {
					const result = await this.kustoClient.getDatabaseSchema(conn, database, true);
					const accountPartition = result.accountPartition;
					if (!accountPartition) throw new Error('Schema authentication identity could not be resolved.');
					const normalizedCluster = conn.clusterUrl.replace(/\/+$/, '');
					const cacheKey = schemaCacheKey(normalizedCluster, database, conn.id, accountPartition);
					const timestamp = result.fromCache ? Date.now() - (result.cacheAgeMs ?? 0) : Date.now();
					const diskEntry: CachedSchemaEntry = {
						schema: result.schema,
						timestamp,
						version: SCHEMA_CACHE_VERSION,
						clusterUrl: normalizedCluster,
						database,
						connectionId: conn.id,
						accountPartition,
					};
					await writeCachedSchemaToDisk(this.context.globalStorageUri, cacheKey, diskEntry, result.cacheGeneration);
					await this.sendSnapshotToWebview();
					if (this.kustoClient.getAccountPartition(conn) !== accountPartition) {
						this.panel.webview.postMessage({ type: 'schemaRefreshCompleted', connectionId, clusterUrl, database, requestId, success: false, error: 'Authentication changed while schema was loading.' });
						return;
					}
					this.panel.webview.postMessage({ type: 'schemaLoaded', connectionId: conn.id, database, requestId, accountPartition, schema: result.schema, fromCache: false, cacheAgeMs: 0 });
					this.panel.webview.postMessage({ type: 'schemaRefreshCompleted', connectionId, clusterUrl, database, requestId, success: true });
					void vscode.window.showInformationMessage(`Schema refreshed: ${database}${source ? ` (via ${source})` : ''}`);
				} catch (error) {
					const isAuthError = this.kustoClient.isAuthenticationError(error);
					this.panel.webview.postMessage({ type: 'schemaRefreshCompleted', connectionId, clusterUrl, database, requestId, success: false, error: isAuthError ? 'Authentication required. Please test the connection to sign in.' : error instanceof Error ? error.message : String(error) });
					void vscode.window.showErrorMessage(`Failed to refresh schema for ${database}: ${isAuthError ? 'Authentication required.' : (error instanceof Error ? error.message : String(error))}`);
				}
				return;
			}
			case 'cluster.refreshSchema': {
				const traceId = createDatabaseListTraceId();
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) return;
				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === connectionId);
				if (!conn) return;
				this.panel.webview.postMessage({ type: 'loadingDatabases', connectionId });
				try {
					const databases = await this.kustoClient.getDatabases(conn, true, { traceId, source: 'connection-manager-cluster-schema-refresh' });
					this.panel.webview.postMessage({ type: 'databasesLoaded', connectionId, databases });
				} catch (error) {
					const isAuthError = this.kustoClient.isAuthenticationError(error);
					this.panel.webview.postMessage({ type: 'databasesLoadError', connectionId, error: isAuthError ? 'Authentication required. Please test the connection to sign in.' : error instanceof Error ? error.message : String(error) });
				}
				return;
			}
			case 'copyToClipboard': {
				try { await vscode.env.clipboard.writeText(String(msg.text ?? '')); void vscode.window.setStatusBarMessage('Copied to clipboard', 1500); } catch { void vscode.window.showErrorMessage('Could not copy to clipboard.'); }
				return;
			}
			case 'openInEditor': {
				try { await vscode.commands.executeCommand('kusto.openQueryEditor'); } catch { void vscode.window.showErrorMessage('Failed to open query editor.'); }
				return;
			}
			case 'database.openInNewFile': {
				const connectionId = String(msg.connectionId || '').trim();
				const clusterUrl = String(msg.clusterUrl || '').trim();
				const database = String(msg.database || '').trim();
				const connection = this.connectionManager.getConnections().find(candidate => candidate.id === connectionId);
				if (!connection || kustoClusterKey(connection.clusterUrl) !== kustoClusterKey(clusterUrl) || !database) return;
				try {
					const file = createEmptyKqlxOrMdxFile('kqlx');
					file.state.sections.push({
						type: 'query',
						expanded: true,
						clusterUrl: connection.clusterUrl,
						authorityId: connection.authorityId,
						connectionIdHint: connection.id,
						database,
						query: '',
					});
					const defaultName = `${database}.kqlx`;
					const uri = await vscode.window.showSaveDialog({ filters: { 'Kusto Notebook': ['kqlx'] }, saveLabel: 'Create', title: 'Create new .kqlx file', defaultUri: vscode.workspace.workspaceFolders?.[0] ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, defaultName) : undefined });
					if (uri) {
						const content = JSON.stringify(file, null, 2) + '\n';
						await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
						const doc = await vscode.workspace.openTextDocument(uri);
						if (doc.getText().trim() !== content.trim()) { const edit = new vscode.WorkspaceEdit(); edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), content); await vscode.workspace.applyEdit(edit); await doc.save(); }
						await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor');
					}
				} catch { void vscode.window.showErrorMessage('Failed to create .kqlx file.'); }
				return;
			}
			case 'leaveNoTrace.add': {
				const clusterUrl = String(msg.clusterUrl || '').trim();
				if (!clusterUrl) return;
				try {
					await this.connectionManager.addLeaveNoTrace(clusterUrl);
					const snapshot = await this.buildSnapshot();
					this.panel.webview.postMessage({ type: 'snapshot', snapshot });
					void vscode.window.setStatusBarMessage('Cluster marked as "Leave no trace"', 2000);
				} catch (error) { void vscode.window.showErrorMessage(`Failed to mark cluster: ${error instanceof Error ? error.message : String(error)}`); }
				return;
			}
			case 'leaveNoTrace.remove': {
				const clusterUrl = String(msg.clusterUrl || '').trim();
				if (!clusterUrl) return;
				try {
					await this.connectionManager.removeLeaveNoTrace(clusterUrl);
					const snapshot = await this.buildSnapshot();
					this.panel.webview.postMessage({ type: 'snapshot', snapshot });
					void vscode.window.setStatusBarMessage('Cluster removed from "Leave no trace"', 2000);
				} catch (error) { void vscode.window.showErrorMessage(`Failed to remove cluster from "Leave no trace": ${error instanceof Error ? error.message : String(error)}`); }
				return;
			}
			case 'connection.importXml': {
				await this.handleImportConnectionsXml();
				return;
			}
			case 'connection.exportXml': {
				await this.handleExportConnectionsXml();
				return;
			}
			case 'table.preview': {
				const requestId = createDatabaseListTraceId();
				const connectionId = String(msg.connectionId || '').trim();
				const database = String(msg.database || '').trim();
				const tableName = String(msg.tableName || '').trim();
				if (!connectionId || !database || !tableName) return;
				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === connectionId);
				if (!conn) { this.panel.webview.postMessage({ type: 'tablePreviewResult', connectionId, database, tableName, requestId, success: false, error: 'Connection not found.' }); return; }
				let startingAccountPartition: string | undefined;
				try { startingAccountPartition = this.kustoClient.getAccountPartition(conn); } catch { startingAccountPartition = undefined; }
				this.panel.webview.postMessage({ type: 'tablePreviewLoading', connectionId, database, tableName, requestId, accountPartition: startingAccountPartition });
				try {
					const safeTableName = `['${tableName.replace(/'/g, "''")}']`;
					const query = `${safeTableName} | take 100`;
					const execution = await this.kustoClient.executeQueryWithIdentity(conn, database, query);
					const { result, accountPartition } = execution;
					await this.sendSnapshotToWebview();
					if (!accountPartition || this.kustoClient.getAccountPartition(conn) !== accountPartition) {
						this.panel.webview.postMessage({ type: 'tablePreviewResult', connectionId, database, tableName, requestId, success: false, error: 'Authentication changed while preview was loading.' });
						return;
					}
					this.panel.webview.postMessage({ type: 'tablePreviewResult', connectionId, database, tableName, requestId, accountPartition, success: true, columns: result.columns, rows: result.rows, rowCount: result.rows.length, executionTime: result.metadata?.executionTime });
				} catch (error) {
					const isAuthError = this.kustoClient.isAuthenticationError(error);
					this.panel.webview.postMessage({ type: 'tablePreviewResult', connectionId, database, tableName, requestId, success: false, error: isAuthError ? 'Authentication required. Please test the connection to sign in.' : error instanceof Error ? error.message : String(error) });
				}
				return;
			}
			case 'saveResultsCsv': {
				try {
					const csv = String(msg.csv || '');
					if (!csv.trim()) { void vscode.window.showInformationMessage('No results to save.'); return; }
					const suggestedName = String(msg.suggestedFileName || 'results.csv');
					const uri = await vscode.window.showSaveDialog({ filters: { 'CSV': ['csv'] }, saveLabel: 'Save', title: 'Save results as CSV', defaultUri: vscode.workspace.workspaceFolders?.[0] ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, suggestedName) : undefined });
					if (uri) {
						let targetUri = uri;
						try { targetUri = withCsvExtension(uri); } catch { /* ignore */ }
						await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(csv));
						await notifySavedFile(targetUri, `Saved results to ${targetUri.fsPath}`);
					}
				} catch {
					void vscode.window.showErrorMessage('Failed to save results to CSV file.');
				}
				return;
			}

			// ─── SQL message handlers ───────────────────────────────────────

			case 'setActiveKind': {
				const kind = msg.kind === 'sql' ? 'sql' : 'kusto' as ConnectionKind;
				await this.setActiveKind(kind);
				return;
			}
			case 'sql.connection.add': {
				if (!this.sqlDeps) return;
				const name = String(msg.name || '').trim();
				const serverUrl = String(msg.serverUrl || '').trim();
				if (!name || !serverUrl) { void vscode.window.showErrorMessage('Connection name and server URL are required.'); return; }
				try {
					const mgr = this.sqlDeps.getSqlConnectionManager();
					await mgr.addConnection({
						name,
						serverUrl,
						port: msg.port,
						dialect: String(msg.dialect || 'mssql'),
						authType: String(msg.authType || 'aad'),
						username: msg.username,
						database: msg.database ? String(msg.database).trim() : undefined,
					}, msg.password);
					void vscode.window.setStatusBarMessage(`SQL connection "${name}" added successfully`, 2000);
					await this.sendSnapshotToWebview();
				} catch (error) { void vscode.window.showErrorMessage(`Failed to add SQL connection: ${error instanceof Error ? error.message : String(error)}`); }
				return;
			}
			case 'sql.connection.edit': {
				if (!this.sqlDeps) return;
				const id = String(msg.id || '').trim();
				const name = String(msg.name || '').trim();
				const serverUrl = String(msg.serverUrl || '').trim();
				if (!id || !name || !serverUrl) { void vscode.window.showErrorMessage('Connection ID, name, and server URL are required.'); return; }
				try {
					const mgr = this.sqlDeps.getSqlConnectionManager();
					await mgr.updateConnection(id, {
						name,
						serverUrl,
						port: msg.port,
						dialect: String(msg.dialect || 'mssql'),
						authType: String(msg.authType || 'aad'),
						username: msg.username,
						database: msg.database ? String(msg.database).trim() : undefined,
					});
					if (msg.password !== undefined && msg.password !== null) {
						await mgr.setPassword(id, msg.password);
					}
					void vscode.window.setStatusBarMessage(`SQL connection "${name}" updated successfully`, 2000);
					await this.sendSnapshotToWebview();
				} catch (error) { void vscode.window.showErrorMessage(`Failed to update SQL connection: ${error instanceof Error ? error.message : String(error)}`); }
				return;
			}
			case 'sql.connection.delete': {
				if (!this.sqlDeps) return;
				const id = String(msg.id || '').trim();
				if (!id) return;
				const mgr = this.sqlDeps.getSqlConnectionManager();
				const conn = mgr.getConnection(id);
				const connName = conn?.name || id;
				const confirm = await vscode.window.showWarningMessage(`Delete SQL connection "${connName}"?`, { modal: true }, 'Delete');
				if (confirm !== 'Delete') return;
				try {
					// Clean up associated favorites and LNT
					const sqlFavorites = this.getSqlFavorites().filter(f => f.connectionId !== id);
					await this.setSqlFavorites(sqlFavorites);
					const sqlLnt = this.getSqlLeaveNoTrace().filter(cid => cid !== id);
					await this.setSqlLeaveNoTrace(sqlLnt);
					await mgr.removeConnection(id);
					void vscode.window.setStatusBarMessage(`SQL connection "${connName}" deleted`, 2000);
					await this.sendSnapshotToWebview();
				} catch (error) { void vscode.window.showErrorMessage(`Failed to delete SQL connection: ${error instanceof Error ? error.message : String(error)}`); }
				return;
			}
			case 'sql.connection.test': {
				if (!this.sqlDeps) return;
				const id = String(msg.id || '').trim();
				if (!id) return;
				const mgr = this.sqlDeps.getSqlConnectionManager();
				const conn = mgr.getConnection(id);
				if (!conn) { void vscode.window.showErrorMessage('SQL connection not found.'); return; }
				// If a password was passed (testing before save), store it temporarily
				if (msg.password !== undefined && msg.password !== null) {
					await mgr.setPassword(id, msg.password);
				}
				this.panel.webview.postMessage({ type: 'sql.testConnectionStarted', connectionId: id });
				try {
					const client = this.sqlDeps.getSqlClient();
					const databases = await client.getDatabases(conn);
					this.panel.webview.postMessage({ type: 'sql.testConnectionResult', connectionId: id, success: true, message: `Connected successfully! Found ${databases.length} database(s).` });
					const cached = this.getSqlCachedDatabases();
					cached[id] = databases;
					await this.setSqlCachedDatabases(cached);
				} catch (error) {
					this.panel.webview.postMessage({ type: 'sql.testConnectionResult', connectionId: id, success: false, message: `Connection failed: ${error instanceof Error ? error.message : String(error)}` });
				}
				return;
			}
			case 'sql.connection.duplicate': {
				if (!this.sqlDeps) return;
				const id = String(msg.id || '').trim();
				if (!id) return;
				const mgr = this.sqlDeps.getSqlConnectionManager();
				const conn = mgr.getConnection(id);
				if (!conn) { void vscode.window.showErrorMessage('SQL connection not found.'); return; }
				try {
					await mgr.addConnection({ name: `${conn.name} (copy)`, serverUrl: conn.serverUrl, port: conn.port, dialect: conn.dialect, authType: conn.authType, username: conn.username, database: conn.database });
					void vscode.window.setStatusBarMessage(`SQL connection duplicated`, 2000);
					await this.sendSnapshotToWebview();
				} catch (error) { void vscode.window.showErrorMessage(`Failed to duplicate SQL connection: ${error instanceof Error ? error.message : String(error)}`); }
				return;
			}
			case 'sql.cluster.expand': {
				if (!this.sqlDeps) return;
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) return;
				const expanded = this.getSqlExpandedConnections();
				if (!expanded.includes(connectionId)) { expanded.push(connectionId); await this.setSqlExpandedConnections(expanded); }
				const mgr = this.sqlDeps.getSqlConnectionManager();
				const conn = mgr.getConnection(connectionId);
				if (conn) {
					const cached = this.getSqlCachedDatabases();
					if (!cached[connectionId] || cached[connectionId].length === 0) {
						this.panel.webview.postMessage({ type: 'sql.loadingDatabases', connectionId });
						try {
							const client = this.sqlDeps.getSqlClient();
							const databases = await client.getDatabases(conn);
							cached[connectionId] = databases;
							await this.setSqlCachedDatabases(cached);
							this.panel.webview.postMessage({ type: 'sql.databasesLoaded', connectionId, databases });
						} catch (error) { this.panel.webview.postMessage({ type: 'sql.databasesLoadError', connectionId, error: error instanceof Error ? error.message : String(error) }); }
					}
				}
				return;
			}
			case 'sql.cluster.collapse': {
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) return;
				const expanded = this.getSqlExpandedConnections().filter((id) => id !== connectionId);
				await this.setSqlExpandedConnections(expanded);
				return;
			}
			case 'sql.cluster.refreshDatabases': {
				if (!this.sqlDeps) return;
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) return;
				const mgr = this.sqlDeps.getSqlConnectionManager();
				const conn = mgr.getConnection(connectionId);
				if (!conn) return;
				this.panel.webview.postMessage({ type: 'sql.loadingDatabases', connectionId });
				try {
					const client = this.sqlDeps.getSqlClient();
					const databases = await client.getDatabases(conn);
					const cached = this.getSqlCachedDatabases();
					cached[connectionId] = databases;
					await this.setSqlCachedDatabases(cached);
					this.panel.webview.postMessage({ type: 'sql.databasesLoaded', connectionId, databases });
				} catch (error) {
					this.panel.webview.postMessage({ type: 'sql.databasesLoadError', connectionId, error: error instanceof Error ? error.message : String(error) });
				}
				return;
			}
			case 'sql.database.getSchema': {
				if (!this.sqlDeps) return;
				const connectionId = String(msg.connectionId || '').trim();
				const database = String(msg.database || '').trim();
				if (!connectionId || !database) return;
				const mgr = this.sqlDeps.getSqlConnectionManager();
				const conn = mgr.getConnection(connectionId);
				if (!conn) return;
				this.panel.webview.postMessage({ type: 'sql.loadingSchema', connectionId, database });
				try {
					const client = this.sqlDeps.getSqlClient();
					const schema = await client.getDatabaseSchema(conn, database);
					this.panel.webview.postMessage({ type: 'sql.schemaLoaded', connectionId, database, schema });
				} catch (error) { this.panel.webview.postMessage({ type: 'sql.schemaLoadError', connectionId, database, error: error instanceof Error ? error.message : String(error) }); }
				return;
			}
			case 'sql.database.refreshSchema': {
				if (!this.sqlDeps) return;
				const connectionId = String(msg.connectionId || '').trim();
				const database = String(msg.database || '').trim();
				const source = String(msg.source || '').trim();
				if (!connectionId || !database) return;
				const mgr = this.sqlDeps.getSqlConnectionManager();
				const conn = mgr.getConnection(connectionId);
				if (!conn) return;
				this.panel.webview.postMessage({ type: 'sql.loadingSchema', connectionId, database });
				try {
					const client = this.sqlDeps.getSqlClient();
					const schema = await client.getDatabaseSchema(conn, database);
					this.panel.webview.postMessage({ type: 'sql.schemaLoaded', connectionId, database, schema });
					void vscode.window.showInformationMessage(`SQL schema refreshed: ${database}${source ? ` (via ${source})` : ''}`);
				} catch (error) { this.panel.webview.postMessage({ type: 'sql.schemaLoadError', connectionId, database, error: error instanceof Error ? error.message : String(error) }); }
				return;
			}
			case 'sql.database.openInNewFile': {
				const serverUrl = String(msg.serverUrl || '').trim();
				const database = String(msg.database || '').trim();
				if (!serverUrl || !database) return;
				try {
					const file = createEmptyKqlxOrMdxFile('sqlx');
					file.state.sections.push({ type: 'sql', expanded: true, serverUrl, database, query: '' });
					const defaultName = `${database}.sqlx`;
					const uri = await vscode.window.showSaveDialog({ filters: { 'SQL Notebook': ['sqlx'] }, saveLabel: 'Create', title: 'Create new .sqlx file', defaultUri: vscode.workspace.workspaceFolders?.[0] ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, defaultName) : undefined });
					if (uri) {
						const content = JSON.stringify(file, null, 2) + '\n';
						await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
						const doc = await vscode.workspace.openTextDocument(uri);
						if (doc.getText().trim() !== content.trim()) { const edit = new vscode.WorkspaceEdit(); edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), content); await vscode.workspace.applyEdit(edit); await doc.save(); }
						await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor');
					}
				} catch { void vscode.window.showErrorMessage('Failed to create .sqlx file.'); }
				return;
			}
			case 'sql.table.preview': {
				if (!this.sqlDeps) return;
				const connectionId = String(msg.connectionId || '').trim();
				const database = String(msg.database || '').trim();
				const tableName = String(msg.tableName || '').trim();
				if (!connectionId || !database || !tableName) return;
				const mgr = this.sqlDeps.getSqlConnectionManager();
				const conn = mgr.getConnection(connectionId);
				if (!conn) { this.panel.webview.postMessage({ type: 'sql.tablePreviewResult', connectionId, database, tableName, success: false, error: 'Connection not found.' }); return; }
				this.panel.webview.postMessage({ type: 'sql.tablePreviewLoading', connectionId, database, tableName });
				try {
					const safeTableName = tableName.split('.').map(part => `[${part.replace(/\]/g, ']]')}]`).join('.');
					const query = `SELECT TOP 100 * FROM ${safeTableName}`;
					const client = this.sqlDeps.getSqlClient();
					const result = await client.executeQuery(conn, database, query);
					this.panel.webview.postMessage({ type: 'sql.tablePreviewResult', connectionId, database, tableName, success: true, columns: result.columns, rows: result.rows, rowCount: result.rows.length, executionTime: result.metadata?.executionTime });
				} catch (error) {
					this.panel.webview.postMessage({ type: 'sql.tablePreviewResult', connectionId, database, tableName, success: false, error: error instanceof Error ? error.message : String(error) });
				}
				return;
			}
			case 'sql.favorite.add': {
				const connectionId = String(msg.connectionId || '').trim();
				const database = String(msg.database || '').trim();
				const name = String(msg.name || '').trim();
				if (!connectionId || !database || !name) return;
				const result = addSqlFavoriteIfMissing(this.getSqlFavorites(), { name, connectionId, database });
				if (result.changed) {
					await this.setSqlFavorites(result.favorites);
				}
				await this.sendSnapshotToWebview();
				return;
			}
			case 'sql.favorite.promptAdd': {
				await this.promptAddSqlFavorite(msg.connectionId, msg.database, msg.defaultName);
				return;
			}
			case 'sql.favorite.promptRename': {
				await this.promptRenameSqlFavorite(msg.connectionId, msg.database);
				return;
			}
			case 'sql.favorite.remove': {
				const connectionId = String(msg.connectionId || '').trim();
				const database = String(msg.database || '').trim();
				if (!connectionId || !database) return;
				const result = removeSqlFavorite(this.getSqlFavorites(), connectionId, database);
				if (result.changed) {
					await this.setSqlFavorites(result.favorites);
				}
				await this.sendSnapshotToWebview();
				return;
			}
			case 'sql.leaveNoTrace.add': {
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) return;
				const lnt = this.getSqlLeaveNoTrace();
				if (!lnt.includes(connectionId)) { lnt.push(connectionId); await this.setSqlLeaveNoTrace(lnt); }
				await this.sendSnapshotToWebview();
				return;
			}
			case 'sql.leaveNoTrace.remove': {
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) return;
				const lnt = this.getSqlLeaveNoTrace().filter(id => id !== connectionId);
				await this.setSqlLeaveNoTrace(lnt);
				await this.sendSnapshotToWebview();
				return;
			}

			// ─── Search message handlers ────────────────────────────────

			case 'search': {
				const requestId = String(msg.requestId || '');
				const query = String(msg.query || '').trim();
				if (!requestId || !query) return;

				// Cancel any previous search
				if (this._searchAbortController) {
					this._searchAbortController.abort();
				}
				this._activeSearchRequestId = requestId;
				const abortController = new AbortController();
				this._searchAbortController = abortController;
				const signal = abortController.signal;

				// Run search in the background (don't block message loop)
				void this._executeSearch(requestId, query, msg.scope as string, msg.kind as ConnectionKind, msg.categories, msg.contentToggles, signal);
				return;
			}
			case 'search.cancel': {
				const requestId = String(msg.requestId || '');
				if (requestId === this._activeSearchRequestId) {
					if (this._searchAbortController) this._searchAbortController.abort();
					this._activeSearchRequestId = null;
					this._searchAbortController = null;
				}
				return;
			}
			case 'search.saveState': {
				await this.setSearchState(msg.state);
				return;
			}

			default: return;
		}
	}

	// ─── Search execution ───────────────────────────────────────────────────

	private async _executeSearch(
		requestId: string,
		query: string,
		scope: string,
		kind: ConnectionKind,
		categories: Record<string, boolean>,
		contentToggles: Record<string, boolean>,
		signal: AbortSignal,
	): Promise<void> {
		type SearchResult = {
			category: string;
			kind: ConnectionKind;
			connectionId: string;
			connectionName: string;
			database?: string;
			name: string;
			parentName?: string;
			matchContext?: string;
		};

		const sendResults = (results: SearchResult[], completed: boolean) => {
			if (signal.aborted) return;
			try { this.panel.webview.postMessage({ type: 'searchResults', requestId, results, completed }); } catch { /* panel disposed */ }
		};
		const sendProgress = (message: string, current?: number, total?: number) => {
			if (signal.aborted) return;
			try { this.panel.webview.postMessage({ type: 'searchProgress', requestId, message, current, total }); } catch { /* panel disposed */ }
		};

		let re: RegExp;
		try { re = new RegExp(query, 'i'); } catch { sendResults([], true); return; }

		try {
			// ── Phase 1: Connection/database name matches (instant, from snapshot) ──
			const nameResults: SearchResult[] = [];

			if (kind === 'kusto') {
				const connections = this.connectionManager.getConnections();
				const cachedDbs = this.getCachedDatabases();
				for (const conn of connections) {
					if (categories['clusters'] && (re.test(conn.name) || re.test(conn.clusterUrl))) {
						nameResults.push({ category: 'cluster', kind: 'kusto', connectionId: conn.id, connectionName: conn.name, name: conn.name || conn.clusterUrl });
					}
					if (categories['databases']) {
						const clusterKey = this.getClusterCacheKey(conn.clusterUrl);
						for (const db of cachedDbs[conn.id] ?? []) {
							if (re.test(db)) {
								nameResults.push({ category: 'database', kind: 'kusto', connectionId: conn.id, connectionName: conn.name, database: db, name: db });
							}
						}
					}
				}
			} else {
				const sqlConns = this.sqlDeps ? this.sqlDeps.getSqlConnectionManager().getConnections() : [];
				const sqlCachedDbs = this.getSqlCachedDatabases();
				for (const conn of sqlConns) {
					if (categories['servers'] && (re.test(conn.name) || re.test(conn.serverUrl))) {
						nameResults.push({ category: 'server', kind: 'sql', connectionId: conn.id, connectionName: conn.name, name: conn.name || conn.serverUrl });
					}
					if (categories['databases']) {
						for (const db of sqlCachedDbs[conn.id] ?? []) {
							if (re.test(db)) {
								nameResults.push({ category: 'database', kind: 'sql', connectionId: conn.id, connectionName: conn.name, database: db, name: db });
							}
						}
					}
				}
			}

			if (nameResults.length > 0) sendResults(nameResults, false);
			if (signal.aborted) return;

			// ── Phase 2: Schema search (scope-dependent) ──

			if (scope === 'refresh-cached' || scope === 'everything') {
				await this._refreshSchemasForSearch(kind, scope, query, categories, contentToggles, requestId, signal, sendResults, sendProgress);
			} else {
				// Tier 1: search disk-cached schemas
				await this._searchCachedSchemasForSearch(kind, query, categories, contentToggles, requestId, signal, sendResults);
			}

			if (!signal.aborted) sendResults([], true);
		} catch (error) {
			if (!signal.aborted) {
				getWorkbenchLogger().warn('[kusto] search error', error);
				sendResults([], true);
			}
		} finally {
			if (this._activeSearchRequestId === requestId) {
				this._activeSearchRequestId = null;
				this._searchAbortController = null;
			}
		}
	}

	/** Tier 1: Search already-cached schemas from disk. */
	private async _searchCachedSchemasForSearch(
		kind: ConnectionKind,
		query: string,
		categories: Record<string, boolean>,
		contentToggles: Record<string, boolean>,
		_requestId: string,
		signal: AbortSignal,
		sendResults: (results: any[], completed: boolean) => void,
	): Promise<void> {
		const wantsSchemaSearch = kind === 'kusto'
			? (categories['tables'] || categories['functions'])
			: (categories['tables'] || categories['views'] || categories['storedProcedures']);
		if (!wantsSchemaSearch) return;

		if (kind === 'kusto') {
			const matches = await searchCachedSchemas(this.context.globalStorageUri, query, 500, this.getActiveSchemaPrincipalIdentities());
			if (signal.aborted) return;
			const results = this._mapKustoSchemaMatches(matches, categories, contentToggles);
			if (results.length > 0) sendResults(results, false);
		} else {
			const matches = await searchCachedSqlSchemas(this.context.globalStorageUri, query, 500);
			if (signal.aborted) return;
			const results = this._mapSqlSchemaMatches(matches, categories, contentToggles);
			if (results.length > 0) sendResults(results, false);
		}
	}

	/** Tier 2 & 3: Refresh schemas then search each one as it's refreshed. */
	private async _refreshSchemasForSearch(
		kind: ConnectionKind,
		scope: string,
		query: string,
		categories: Record<string, boolean>,
		contentToggles: Record<string, boolean>,
		requestId: string,
		signal: AbortSignal,
		sendResults: (results: any[], completed: boolean) => void,
		sendProgress: (message: string, current?: number, total?: number) => void,
	): Promise<void> {
		let re: RegExp;
		try { re = new RegExp(query, 'i'); } catch { return; }

		if (kind === 'kusto') {
			const connections = this.connectionManager.getConnections();

			if (scope === 'everything') {
				const searchTraceId = createDatabaseListTraceId();
				const requestRef = databaseListTraceRef(requestId);
				this.traceDatabaseList(searchTraceId, 'search-everything.start', {
					requestId,
					connectionCount: connections.length,
				});
				// Tier 3: refresh all databases for all connections, then schemas
				let step = 0;
				const totalConns = connections.length;
				const dbPairs: Array<{ conn: KustoConnection; db: string }> = [];

				for (const conn of connections) {
					if (signal.aborted) {
						this.traceDatabaseList(searchTraceId, 'search-everything.cancelled', { requestId, completedConnections: step });
						return;
					}
					step++;
					sendProgress(`Connecting to ${conn.name || conn.clusterUrl}…`, step, totalConns);
					const childTraceId = createDatabaseListTraceId();
					this.traceDatabaseList(searchTraceId, 'search-everything.connection-start', {
						requestId,
						connectionId: conn.id,
						childTraceId,
						position: step,
					});
					try {
						const dbs = await this.kustoClient.getDatabases(conn, true, {
							traceId: childTraceId,
							source: 'connection-manager-search-everything',
						});
						for (const db of dbs) dbPairs.push({ conn, db });
						this.traceDatabaseList(searchTraceId, 'search-everything.connection-complete', {
							requestId,
							connectionId: conn.id,
							childTraceId,
							databaseCount: dbs.length,
						});
					} catch (error) {
						this.traceDatabaseList(searchTraceId, 'search-everything.connection-failed', {
							requestId,
							connectionId: conn.id,
							childTraceId,
							isAuthError: this.kustoClient.isAuthenticationError(error),
							...getDatabaseListErrorDetails(error),
						});
					}
				}
				this.traceDatabaseList(searchTraceId, 'search-everything.discovery-complete', {
					requestId,
					requestRef,
					connectionCount: totalConns,
					databaseCount: dbPairs.length,
				});

				// Now refresh all schemas
				const totalSchemas = dbPairs.length;
				for (let i = 0; i < dbPairs.length; i++) {
					if (signal.aborted) return;
					const { conn, db } = dbPairs[i];
					sendProgress(`Loading schema: ${db}`, i + 1, totalSchemas);
					try {
						const result = await this.kustoClient.getDatabaseSchema(conn, db, true);
						const accountPartition = result.accountPartition;
						if (!accountPartition) continue;
						const normalizedCluster = conn.clusterUrl.replace(/\/+$/, '');
						const cacheKey = schemaCacheKey(normalizedCluster, db, conn.id, accountPartition);
						await writeCachedSchemaToDisk(this.context.globalStorageUri, cacheKey, {
							schema: result.schema,
							timestamp: Date.now(),
							version: SCHEMA_CACHE_VERSION,
							clusterUrl: normalizedCluster,
							database: db,
							connectionId: conn.id,
							accountPartition,
						}, result.cacheGeneration);
						// Search the freshly loaded schema
						const schemaResults = this._searchSingleKustoSchema(result.schema, normalizedCluster, db, conn, re, categories, contentToggles);
						if (schemaResults.length > 0) sendResults(schemaResults, false);
					} catch { /* skip schema errors */ }
				}
			} else {
				// Tier 2: refresh only already-cached schemas
				const cachedEntries = await readAllCachedSchemasFromDisk(
					this.context.globalStorageUri,
					undefined,
					undefined,
					this.getActiveSchemaPrincipalIdentities(),
				);
				const total = cachedEntries.length;
				for (let i = 0; i < cachedEntries.length; i++) {
					if (signal.aborted) return;
					const entry = cachedEntries[i];
					sendProgress(`Refreshing ${entry.database}…`, i + 1, total);
					const conn = connections.find(c => c.id === entry.connectionId);
					if (!conn) continue;
					try {
						const result = await this.kustoClient.getDatabaseSchema(conn, entry.database, true);
						const accountPartition = result.accountPartition;
						if (!accountPartition) continue;
						const normalizedCluster = conn.clusterUrl.replace(/\/+$/, '');
						const cacheKey = schemaCacheKey(normalizedCluster, entry.database, conn.id, accountPartition);
						await writeCachedSchemaToDisk(this.context.globalStorageUri, cacheKey, {
							schema: result.schema,
							timestamp: Date.now(),
							version: SCHEMA_CACHE_VERSION,
							clusterUrl: normalizedCluster,
							database: entry.database,
							connectionId: conn.id,
							accountPartition,
						}, result.cacheGeneration);
						const schemaResults = this._searchSingleKustoSchema(result.schema, normalizedCluster, entry.database, conn, re, categories, contentToggles);
						if (schemaResults.length > 0) sendResults(schemaResults, false);
					} catch { /* skip schema errors */ }
				}
			}
		} else {
			// SQL Tier 2/3
			if (!this.sqlDeps) return;
			const mgr = this.sqlDeps.getSqlConnectionManager();
			const client = this.sqlDeps.getSqlClient();
			const sqlConns = mgr.getConnections();

			if (scope === 'everything') {
				let step = 0;
				const totalConns = sqlConns.length;
				const dbPairs: Array<{ conn: any; db: string }> = [];

				for (const conn of sqlConns) {
					if (signal.aborted) return;
					step++;
					sendProgress(`Connecting to ${conn.name || conn.serverUrl}…`, step, totalConns);
					try {
						const dbs = await client.getDatabases(conn);
						const cached = this.getSqlCachedDatabases();
						cached[conn.id] = dbs;
						await this.setSqlCachedDatabases(cached);
						for (const db of dbs) dbPairs.push({ conn, db });
					} catch { /* skip */ }
				}

				const totalSchemas = dbPairs.length;
				for (let i = 0; i < dbPairs.length; i++) {
					if (signal.aborted) return;
					const { conn, db } = dbPairs[i];
					sendProgress(`Loading schema: ${db}`, i + 1, totalSchemas);
					try {
						const schema = await client.getDatabaseSchema(conn, db);
						// Search the fresh schema inline
						const schemaResults = this._searchSingleSqlSchema(schema, conn, db, re, categories, contentToggles);
						if (schemaResults.length > 0) sendResults(schemaResults, false);
					} catch { /* skip */ }
				}
			} else {
				// Tier 2: refresh cached SQL schemas
				const cachedEntries = await readAllCachedSqlSchemasFromDisk(this.context.globalStorageUri);
				const total = cachedEntries.length;
				for (let i = 0; i < cachedEntries.length; i++) {
					if (signal.aborted) return;
					const entry = cachedEntries[i];
					sendProgress(`Refreshing ${entry.database}…`, i + 1, total);
					const conn = sqlConns.find(c => c.serverUrl.toLowerCase() === entry.serverUrl.toLowerCase());
					if (!conn) continue;
					try {
						const schema = await client.getDatabaseSchema(conn, entry.database);
						const schemaResults = this._searchSingleSqlSchema(schema, conn, entry.database, re, categories, contentToggles);
						if (schemaResults.length > 0) sendResults(schemaResults, false);
					} catch { /* skip */ }
				}
			}
		}
	}

	/** Search a single Kusto schema against a regex. */
	private _searchSingleKustoSchema(
		schema: DatabaseSchemaIndex,
		_clusterUrl: string,
		database: string,
		conn: KustoConnection,
		re: RegExp,
		categories: Record<string, boolean>,
		contentToggles: Record<string, boolean>,
	): any[] {
		const results: any[] = [];
		const columnMatchContext = (name: string, type?: string, docString?: string): string => {
			const typeText = type ? `${name}: ${type}` : '';
			return docString ? (typeText ? `${typeText} - ${docString}` : docString) : typeText;
		};
		if (categories['tables']) {
			for (const table of schema.tables ?? []) {
				if (re.test(table)) results.push({ category: 'table', kind: 'kusto', connectionId: conn.id, connectionName: conn.name, database, name: table });
			}
			if (contentToggles['tables']) {
				for (const [table, cols] of Object.entries(schema.columnTypesByTable ?? {})) {
					for (const [col, colType] of Object.entries(cols)) {
						const docString = schema.columnDocStrings?.[`${table}.${col}`];
						if (re.test(col) || re.test(colType) || (!!docString && re.test(docString))) {
							results.push({ category: 'column', kind: 'kusto', connectionId: conn.id, connectionName: conn.name, database, name: col, parentName: table, matchContext: columnMatchContext(col, colType, docString) });
						}
					}
				}
			}
		}
		if (categories['functions']) {
			for (const fn of (schema.functions ?? []) as Array<{ name?: string; body?: string; parametersText?: string; docString?: string }>) {
				const fnName = typeof fn === 'string' ? fn : fn?.name;
				if (!fnName) continue;
				if (re.test(fnName)) {
					results.push({ category: 'function', kind: 'kusto', connectionId: conn.id, connectionName: conn.name, database, name: fnName });
				} else if (contentToggles['functions'] && typeof fn === 'object') {
					if ((fn.body && re.test(fn.body)) || (fn.parametersText && re.test(fn.parametersText)) || (fn.docString && re.test(fn.docString))) {
						results.push({ category: 'function', kind: 'kusto', connectionId: conn.id, connectionName: conn.name, database, name: fnName, matchContext: fn.docString || fn.parametersText || '(body match)' });
					}
				}
			}
		}
		return results;
	}

	/** Search a single SQL schema against a regex. */
	private _searchSingleSqlSchema(
		schema: import('./sql/sqlDialect').SqlDatabaseSchemaIndex,
		conn: { id: string; name: string; serverUrl: string },
		database: string,
		re: RegExp,
		categories: Record<string, boolean>,
		contentToggles: Record<string, boolean>,
	): any[] {
		const results: any[] = [];
		if (categories['tables']) {
			for (const table of schema.tables ?? []) {
				if (re.test(table)) results.push({ category: 'table', kind: 'sql', connectionId: conn.id, connectionName: conn.name, database, name: table });
			}
			if (contentToggles['tables']) {
				const viewSet = new Set(schema.views ?? []);
				for (const [table, cols] of Object.entries(schema.columnsByTable ?? {})) {
					if (viewSet.has(table)) continue;
					for (const [col, colType] of Object.entries(cols)) {
						if (re.test(col) || re.test(colType)) {
							results.push({ category: 'column', kind: 'sql', connectionId: conn.id, connectionName: conn.name, database, name: col, parentName: table, matchContext: `${col}: ${colType}` });
						}
					}
				}
			}
		}
		if (categories['views']) {
			for (const view of schema.views ?? []) {
				if (re.test(view)) results.push({ category: 'view', kind: 'sql', connectionId: conn.id, connectionName: conn.name, database, name: view });
			}
			if (contentToggles['views']) {
				for (const [view, cols] of Object.entries(schema.columnsByTable ?? {})) {
					if (!(schema.views ?? []).includes(view)) continue;
					for (const [col, colType] of Object.entries(cols)) {
						if (re.test(col) || re.test(colType)) {
							results.push({ category: 'column', kind: 'sql', connectionId: conn.id, connectionName: conn.name, database, name: col, parentName: view, matchContext: `${col}: ${colType}` });
						}
					}
				}
			}
		}
		if (categories['storedProcedures']) {
			for (const sp of schema.storedProcedures ?? []) {
				if (re.test(sp.name)) {
					results.push({ category: 'stored-procedure', kind: 'sql', connectionId: conn.id, connectionName: conn.name, database, name: sp.name });
				} else if (contentToggles['storedProcedures']) {
					if ((sp.body && re.test(sp.body)) || (sp.parametersText && re.test(sp.parametersText))) {
						results.push({ category: 'stored-procedure', kind: 'sql', connectionId: conn.id, connectionName: conn.name, database, name: sp.name, matchContext: sp.parametersText || '(body match)' });
					}
				}
			}
		}
		return results;
	}

	/** Map Kusto SchemaSearchMatch results to the webview SearchResult format. */
	private _mapKustoSchemaMatches(matches: SchemaSearchMatch[], categories: Record<string, boolean>, contentToggles: Record<string, boolean>): any[] {
		const connections = this.connectionManager.getConnections();
		const results: any[] = [];
		for (const m of matches) {
			const conn = connections.find(c => c.id === m.connectionId);
			const connId = conn?.id ?? '';
			const connName = conn?.name ?? m.clusterUrl;

			if (m.kind === 'table' || m.kind === 'tableDocString' || m.kind === 'tableFolder') {
				if (!categories['tables']) continue;
				results.push({ category: 'table', kind: 'kusto', connectionId: connId, connectionName: connName, database: m.database, name: m.name, matchContext: m.docString });
			} else if (m.kind === 'column' || m.kind === 'columnType' || m.kind === 'columnDocString') {
				if (!categories['tables'] || !contentToggles['tables']) continue;
				const typeText = m.type ? `${m.name}: ${m.type}` : '';
				const matchContext = m.docString ? (typeText ? `${typeText} - ${m.docString}` : m.docString) : typeText;
				results.push({ category: 'column', kind: 'kusto', connectionId: connId, connectionName: connName, database: m.database, name: m.name, parentName: m.table, matchContext });
			} else if (m.kind === 'function' || m.kind === 'functionDocString' || m.kind === 'functionFolder' || m.kind === 'functionParameter' || m.kind === 'functionBody') {
				if (!categories['functions']) continue;
				if ((m.kind === 'functionBody' || m.kind === 'functionParameter' || m.kind === 'functionDocString') && !contentToggles['functions']) continue;
				results.push({ category: 'function', kind: 'kusto', connectionId: connId, connectionName: connName, database: m.database, name: m.name, matchContext: m.docString || m.parametersText });
			}
		}
		return results;
	}

	/** Map SQL SqlSchemaSearchMatch results to the webview SearchResult format. */
	private _mapSqlSchemaMatches(matches: SqlSchemaSearchMatch[], categories: Record<string, boolean>, contentToggles: Record<string, boolean>): any[] {
		const sqlConns = this.sqlDeps ? this.sqlDeps.getSqlConnectionManager().getConnections() : [];
		const results: any[] = [];
		for (const m of matches) {
			const conn = sqlConns.find(c => c.serverUrl.toLowerCase() === m.serverUrl.toLowerCase());
			const connId = conn?.id ?? '';
			const connName = conn?.name ?? m.serverUrl;

			if (m.kind === 'table') {
				if (!categories['tables']) continue;
				results.push({ category: 'table', kind: 'sql', connectionId: connId, connectionName: connName, database: m.database, name: m.name });
			} else if (m.kind === 'view') {
				if (!categories['views']) continue;
				results.push({ category: 'view', kind: 'sql', connectionId: connId, connectionName: connName, database: m.database, name: m.name });
			} else if (m.kind === 'column') {
				const isTableContent = categories['tables'] && contentToggles['tables'];
				const isViewContent = categories['views'] && contentToggles['views'];
				if (!isTableContent && !isViewContent) continue;
				results.push({ category: 'column', kind: 'sql', connectionId: connId, connectionName: connName, database: m.database, name: m.name, parentName: m.table, matchContext: m.type ? `${m.name}: ${m.type}` : undefined });
			} else if (m.kind === 'storedProcedure' || m.kind === 'spBody' || m.kind === 'spParameter') {
				if (!categories['storedProcedures']) continue;
				if ((m.kind === 'spBody' || m.kind === 'spParameter') && !contentToggles['storedProcedures']) continue;
				results.push({ category: 'stored-procedure', kind: 'sql', connectionId: connId, connectionName: connName, database: m.database, name: m.name, matchContext: m.parametersText });
			}
		}
		return results;
	}

	// ─── XML import (identical to original) ─────────────────────────────────

	private async handleImportConnectionsXml(): Promise<void> {
		try {
			const localAppData = process.env.LOCALAPPDATA;
			const base = localAppData && localAppData.trim() ? localAppData.trim() : path.join(os.homedir(), 'AppData', 'Local');
			const defaultFolder = path.join(base, 'Kusto.Explorer');
			const defaultUri = vscode.Uri.file(defaultFolder);
			const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, defaultUri, openLabel: 'Import', filters: { 'XML files': ['xml'], 'All files': ['*'] } });
			if (!picked || picked.length === 0) return;
			const uri = picked[0];
			const bytes = await vscode.workspace.fs.readFile(uri);
			const text = new TextDecoder('utf-8').decode(bytes);
			const connections = parseKustoExplorerConnectionsXml(text);
			if (!connections.length) { void vscode.window.showInformationMessage('No connections found in the selected XML file.'); return; }
			const existing = this.connectionManager.getConnections();
			const existingKeys = new Set(existing.flatMap((connection) => {
				try {
					const key = getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId);
					return key ? [key] : [];
				} catch {
					return [];
				}
			}));
			let added = 0;
			for (const c of connections) {
				try {
					const authorityId = normalizeKustoAuthorityId(c.authorityId);
					const key = getKustoConnectionIdentityKey(c.clusterUrl, authorityId);
					if (existingKeys.has(key)) continue;
					await this.connectionManager.addConnection({ name: c.name || c.clusterUrl, clusterUrl: c.clusterUrl, database: c.database, authorityId });
					existingKeys.add(key);
					added++;
				} catch {
					// Skip malformed imported identities without blocking later valid entries.
				}
			}
			if (added > 0) { void vscode.window.showInformationMessage(`Imported ${added} Kusto connection${added === 1 ? '' : 's'}.`); } else { void vscode.window.showInformationMessage('No new connections were imported (they may already exist).'); }
			const snapshot = await this.buildSnapshot();
			this.panel.webview.postMessage({ type: 'snapshot', snapshot });
		} catch (e: any) { void vscode.window.showErrorMessage(`Failed to import connections: ${e instanceof Error ? e.message : String(e)}`); }
	}

	private async handleExportConnectionsXml(): Promise<void> {
		try {
			const connections = this.connectionManager.getConnections();
			if (connections.length === 0) { void vscode.window.showInformationMessage('No connections to export.'); return; }
			const xml = stringifyKustoExplorerConnectionsXml(connections);
			const uri = await vscode.window.showSaveDialog({ filters: { 'XML files': ['xml'] }, saveLabel: 'Export', title: 'Export connections', defaultUri: vscode.workspace.workspaceFolders?.[0] ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'connections.xml') : undefined });
			if (uri) {
				await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(xml));
				void vscode.window.setStatusBarMessage(`Exported ${connections.length} connection${connections.length !== 1 ? 's' : ''} to ${uri.fsPath}`, 3000);
			}
		} catch (e: any) { void vscode.window.showErrorMessage(`Failed to export connections: ${e instanceof Error ? e.message : String(e)}`); }
	}

	private normalizeClusterUrlKey(url: string): string {
		return kustoClusterKey(url);
	}

	// ─── Alternating row color setting ──────────────────────────────────────

	private sendAlternatingRowColorSetting(): void {
		const val = vscode.workspace.getConfiguration('kustoWorkbench').get<string>('alternatingRowColor', 'theme');
		void this.panel.webview.postMessage({ type: 'settingsUpdate', alternatingRowColor: val });
	}

	private watchAlternatingRowColorSetting(): void {
		this.configSubscription?.dispose();
		this.configSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('kustoWorkbench.alternatingRowColor')) {
				this.sendAlternatingRowColorSetting();
			}
		});
	}

	private getAlternatingRowCss(): string {
		const altRowColor = vscode.workspace.getConfiguration('kustoWorkbench').get<string>('alternatingRowColor', 'theme');
		if (altRowColor === 'off') return '';
		if (altRowColor === 'theme' || !altRowColor) {
			return ':root{--kw-alt-row-bg:color-mix(in srgb,var(--vscode-editor-background) 97%,var(--vscode-foreground) 3%)}';
		}
		const safe = altRowColor.replace(/[^a-zA-Z0-9#(),./\s%\-]/g, '');
		return safe ? `:root{--kw-alt-row-bg:${safe}}` : '';
	}

	// ─── HTML shell (loads Lit bundle) ──────────────────────────────────────

	private buildHtml(webview: vscode.Webview): string {
		const nonce = String(Date.now()) + Math.random().toString(16).slice(2);
		const bundleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'webview.bundle.js')).toString();
		const codiconFontUri = webview
			.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'monaco', 'vs', 'base', 'browser', 'ui', 'codicons', 'codicon', 'codicon.ttf'))
			.toString();
		const altRowCss = this.getAlternatingRowCss();
		const csp = [
			"default-src 'none'",
			"img-src data:",
			`font-src ${webview.cspSource}`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`script-src 'nonce-${nonce}' ${webview.cspSource}`,
			`connect-src ${webview.cspSource}`
		].join('; ');

		return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${VIEW_TITLE}</title>
	<style>@font-face { font-family: "codicon"; font-display: block; src: url("${codiconFontUri}") format("truetype"); }</style>
	${altRowCss ? `<style>${altRowCss}</style>` : ''}
</head>
<body>
	<kw-connection-manager></kw-connection-manager>
	<script nonce="${nonce}" src="${bundleUri}"></script>
</body>
</html>`;
	}
}
