import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { ConnectionManager, KustoConnection } from './connectionManager';
import { KustoQueryClient, DatabaseSchemaIndex } from './kustoClient';
import { createEmptyKqlxOrMdxFile } from './kqlxFormat';
import { writeCachedSchemaToDisk, SCHEMA_CACHE_VERSION, CachedSchemaEntry } from './schemaCache';
import type { SqlConnectionManager } from './sqlConnectionManager';
import type { SqlQueryClient } from './sqlClient';
import { listDialects } from './sql/sqlDialectRegistry';

/**
 * Connection Manager Viewer — Lit web components edition.
 * Extension-side message handling is identical to the original;
 * HTML shell loads the Lit bundle and renders <kw-connection-manager>.
 */

const VIEW_TITLE = 'Connection Manager';

const STORAGE_KEYS = {
	favorites: 'kusto.favorites',
	expandedClusters: 'kusto.connectionManager.expandedClusters',
	cachedDatabases: 'kusto.cachedDatabases',
	activeKind: 'connectionManager.activeKind',
	sqlExpandedConnections: 'sql.connectionManager.expandedConnections',
	sqlCachedDatabases: 'sql.connectionManager.cachedDatabases',
	sqlFavorites: 'sql.favorites',
	sqlLeaveNoTrace: 'sql.leaveNoTraceConnections',
} as const;

export type ConnectionKind = 'kusto' | 'sql';

export type KustoFavorite = {
	name: string;
	clusterUrl: string;
	database: string;
};

export type SqlFavorite = {
	name: string;
	connectionId: string;
	database: string;
};

type IncomingMessage =
	| { type: 'requestSnapshot' }
	| { type: 'connection.add'; name: string; clusterUrl: string; database?: string }
	| { type: 'connection.edit'; id: string; name: string; clusterUrl: string; database?: string }
	| { type: 'connection.delete'; id: string }
	| { type: 'connection.test'; id: string }
	| { type: 'connection.duplicate'; id: string }
	| { type: 'favorite.add'; clusterUrl: string; database: string; name: string }
	| { type: 'favorite.remove'; clusterUrl: string; database: string }
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
	| { type: 'database.openInNewFile'; clusterUrl: string; database: string }
	| { type: 'database.refreshSchema'; clusterUrl: string; database: string; source?: string }
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
	| { type: 'sql.favorite.remove'; connectionId: string; database: string }
	| { type: 'sql.leaveNoTrace.add'; connectionId: string }
	| { type: 'sql.leaveNoTrace.remove'; connectionId: string };

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
	private schemaCache: Map<string, { schema: DatabaseSchemaIndex; timestamp: number }> = new Map();
	private sqlDeps: ConnectionManagerSqlDeps | undefined;
	private configSubscription: vscode.Disposable | undefined;

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager,
		sqlDeps: ConnectionManagerSqlDeps | undefined,
		viewColumn: vscode.ViewColumn
	) {
		this.kustoClient = new KustoQueryClient(this.context);
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
		this.configSubscription?.dispose();
		for (const d of this.disposables) {
			try { d.dispose(); } catch { /* ignore */ }
		}
	}

	// ─── Data helpers (identical to original) ───────────────────────────────

	private getFavorites(): KustoFavorite[] {
		const raw = this.context.globalState.get<unknown>(STORAGE_KEYS.favorites);
		if (!Array.isArray(raw)) return [];
		const out: KustoFavorite[] = [];
		for (const item of raw) {
			if (!item || typeof item !== 'object') continue;
			const maybe = item as Partial<KustoFavorite>;
			const name = String(maybe.name || '').trim();
			const clusterUrl = String(maybe.clusterUrl || '').trim();
			const database = String(maybe.database || '').trim();
			if (!name || !clusterUrl || !database) continue;
			out.push({ name, clusterUrl, database });
		}
		return out;
	}

	private async setFavorites(favorites: KustoFavorite[]): Promise<void> {
		await this.context.globalState.update(STORAGE_KEYS.favorites, favorites);
	}

	private normalizeFavoriteClusterUrl(clusterUrl: string): string {
		let u = String(clusterUrl || '').trim();
		if (!u) return '';
		if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
		return u.replace(/\/+$/g, '').toLowerCase();
	}

	private isFavorite(clusterUrl: string, database: string): boolean {
		const normalizedUrl = this.normalizeFavoriteClusterUrl(clusterUrl);
		const normalizedDb = String(database || '').trim().toLowerCase();
		return this.getFavorites().some((f) => {
			return this.normalizeFavoriteClusterUrl(f.clusterUrl) === normalizedUrl &&
				String(f.database || '').trim().toLowerCase() === normalizedDb;
		});
	}

	private getExpandedClusters(): string[] {
		const raw = this.context.globalState.get<string[] | undefined>(STORAGE_KEYS.expandedClusters);
		return Array.isArray(raw) ? raw.filter((s) => typeof s === 'string') : [];
	}

	private async setExpandedClusters(expanded: string[]): Promise<void> {
		await this.context.globalState.update(STORAGE_KEYS.expandedClusters, expanded);
	}

	private getCachedDatabases(): Record<string, string[]> {
		const raw = this.context.globalState.get<Record<string, string[]> | undefined>(STORAGE_KEYS.cachedDatabases);
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
		const result: Record<string, string[]> = {};
		for (const [k, v] of Object.entries(raw)) {
			if (typeof k === 'string' && Array.isArray(v)) result[k] = v.filter((d) => typeof d === 'string');
		}
		return result;
	}

	private async setCachedDatabases(cached: Record<string, string[]>): Promise<void> {
		await this.context.globalState.update(STORAGE_KEYS.cachedDatabases, cached);
	}

	private getClusterCacheKey(clusterUrlRaw: string): string {
		try {
			let u = String(clusterUrlRaw || '').trim();
			if (!u) return '';
			if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
			const parsed = new URL(u);
			const host = String(parsed.hostname || '').trim().toLowerCase();
			return host || String(clusterUrlRaw || '').trim().toLowerCase();
		} catch {
			return String(clusterUrlRaw || '').trim().toLowerCase();
		}
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
		if (!Array.isArray(raw)) return [];
		const out: SqlFavorite[] = [];
		for (const item of raw) {
			if (!item || typeof item !== 'object') continue;
			const maybe = item as Partial<SqlFavorite>;
			const name = String(maybe.name || '').trim();
			const connectionId = String(maybe.connectionId || '').trim();
			const database = String(maybe.database || '').trim();
			if (!name || !connectionId || !database) continue;
			out.push({ name, connectionId, database });
		}
		return out;
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

	private async buildSnapshot() {
		const sqlConnections = this.sqlDeps ? this.sqlDeps.getSqlConnectionManager().getConnections() : [];
		return {
			timestamp: Date.now(),
			activeKind: this.getActiveKind(),
			connections: this.connectionManager.getConnections(),
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
		};
	}

	private async sendSnapshotToWebview(): Promise<void> {
		try {
			const snapshot = await this.buildSnapshot();
			await this.panel.webview.postMessage({ type: 'snapshot', snapshot });
		} catch (error) {
			// Ignore transient panel lifecycle races (dispose/reveal ordering), but keep diagnostics.
			console.warn('[kusto] connection manager snapshot refresh failed', error);
		}
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
				if (!name || !clusterUrl) { void vscode.window.showErrorMessage('Connection name and cluster URL are required.'); return; }
				try { await this.connectionManager.addConnection({ name, clusterUrl, database }); void vscode.window.setStatusBarMessage(`Connection "${name}" added successfully`, 2000); } catch (error) { void vscode.window.showErrorMessage(`Failed to add connection: ${error instanceof Error ? error.message : String(error)}`); }
				return;
			}
			case 'connection.edit': {
				const id = String(msg.id || '').trim();
				const name = String(msg.name || '').trim();
				const clusterUrl = String(msg.clusterUrl || '').trim();
				const database = msg.database ? String(msg.database).trim() : undefined;
				if (!id || !name || !clusterUrl) { void vscode.window.showErrorMessage('Connection ID, name, and cluster URL are required.'); return; }
				try { await this.connectionManager.updateConnection(id, { name, clusterUrl, database }); void vscode.window.setStatusBarMessage(`Connection "${name}" updated successfully`, 2000); } catch (error) { void vscode.window.showErrorMessage(`Failed to update connection: ${error instanceof Error ? error.message : String(error)}`); }
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
						const normalizedUrl = this.normalizeFavoriteClusterUrl(conn.clusterUrl);
						const favorites = this.getFavorites().filter((f) => this.normalizeFavoriteClusterUrl(f.clusterUrl) !== normalizedUrl);
						await this.setFavorites(favorites);
					}
					await this.connectionManager.removeConnection(id);
					void vscode.window.setStatusBarMessage(`Connection "${connName}" deleted`, 2000);
					const snapshot = await this.buildSnapshot();
					this.panel.webview.postMessage({ type: 'snapshot', snapshot });
				} catch (error) { void vscode.window.showErrorMessage(`Failed to delete connection: ${error instanceof Error ? error.message : String(error)}`); }
				return;
			}
			case 'connection.test': {
				const id = String(msg.id || '').trim();
				if (!id) return;
				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === id);
				if (!conn) { void vscode.window.showErrorMessage('Connection not found.'); return; }
				this.panel.webview.postMessage({ type: 'testConnectionStarted', connectionId: id });
				try {
					const databases = await this.kustoClient.getDatabases(conn, true);
					this.panel.webview.postMessage({ type: 'testConnectionResult', connectionId: id, success: true, message: `Connected successfully! Found ${databases.length} database(s).`, databases });
					const clusterKey = this.getClusterCacheKey(conn.clusterUrl);
					if (clusterKey && databases.length > 0) { const cached = this.getCachedDatabases(); cached[clusterKey] = databases; await this.setCachedDatabases(cached); }
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					const isAuthError = this.kustoClient.isAuthenticationError(error);
					this.panel.webview.postMessage({ type: 'testConnectionResult', connectionId: id, success: false, message: isAuthError ? 'Authentication failed. Please sign in when prompted.' : `Connection failed: ${errorMsg}`, isAuthError });
				}
				return;
			}
			case 'connection.duplicate': {
				const id = String(msg.id || '').trim();
				if (!id) return;
				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === id);
				if (!conn) { void vscode.window.showErrorMessage('Connection not found.'); return; }
				try { await this.connectionManager.addConnection({ name: `${conn.name} (copy)`, clusterUrl: conn.clusterUrl, database: conn.database }); void vscode.window.setStatusBarMessage(`Connection duplicated`, 2000); } catch (error) { void vscode.window.showErrorMessage(`Failed to duplicate connection: ${error instanceof Error ? error.message : String(error)}`); }
				return;
			}
			case 'favorite.add': {
				const clusterUrl = String(msg.clusterUrl || '').trim();
				const database = String(msg.database || '').trim();
				const name = String(msg.name || '').trim();
				if (!clusterUrl || !database || !name) return;
				if (this.isFavorite(clusterUrl, database)) return;
				const favorites = this.getFavorites();
				favorites.push({ name, clusterUrl, database });
				await this.setFavorites(favorites);
				return;
			}
			case 'favorite.remove': {
				const clusterUrl = String(msg.clusterUrl || '').trim();
				const database = String(msg.database || '').trim();
				if (!clusterUrl || !database) return;
				const normalizedUrl = this.normalizeFavoriteClusterUrl(clusterUrl);
				const normalizedDb = database.toLowerCase();
				const favorites = this.getFavorites().filter((f) => !(this.normalizeFavoriteClusterUrl(f.clusterUrl) === normalizedUrl && String(f.database || '').trim().toLowerCase() === normalizedDb));
				await this.setFavorites(favorites);
				return;
			}
			case 'favorite.reorder': {
				if (Array.isArray(msg.favorites)) await this.setFavorites(msg.favorites);
				return;
			}
			case 'cluster.expand': {
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) return;
				const expanded = this.getExpandedClusters();
				if (!expanded.includes(connectionId)) { expanded.push(connectionId); await this.setExpandedClusters(expanded); }
				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === connectionId);
				if (conn) {
					const clusterKey = this.getClusterCacheKey(conn.clusterUrl);
					const cached = this.getCachedDatabases();
					if (!cached[clusterKey] || cached[clusterKey].length === 0) {
						this.panel.webview.postMessage({ type: 'loadingDatabases', connectionId });
						try {
							const databases = await this.kustoClient.getDatabases(conn, false, { allowInteractive: false });
							cached[clusterKey] = databases;
							await this.setCachedDatabases(cached);
							this.panel.webview.postMessage({ type: 'databasesLoaded', connectionId, databases });
						} catch (error) { this.panel.webview.postMessage({ type: 'databasesLoadError', connectionId, error: error instanceof Error ? error.message : String(error) }); }
					}
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
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) return;
				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === connectionId);
				if (!conn) return;
				this.panel.webview.postMessage({ type: 'loadingDatabases', connectionId });
				try {
					const databases = await this.kustoClient.getDatabases(conn, true);
					const clusterKey = this.getClusterCacheKey(conn.clusterUrl);
					const cached = this.getCachedDatabases();
					cached[clusterKey] = databases;
					await this.setCachedDatabases(cached);
					this.panel.webview.postMessage({ type: 'databasesLoaded', connectionId, databases });
				} catch (error) {
					const isAuthError = this.kustoClient.isAuthenticationError(error);
					this.panel.webview.postMessage({ type: 'databasesLoadError', connectionId, error: isAuthError ? 'Authentication required. Please test the connection to sign in.' : error instanceof Error ? error.message : String(error) });
				}
				return;
			}
			case 'database.getSchema': {
				const connectionId = String(msg.connectionId || '').trim();
				const database = String(msg.database || '').trim();
				if (!connectionId || !database) return;
				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === connectionId);
				if (!conn) return;
				this.panel.webview.postMessage({ type: 'loadingSchema', connectionId, database });
				try {
					const result = await this.kustoClient.getDatabaseSchema(conn, database, false);
					this.panel.webview.postMessage({ type: 'schemaLoaded', connectionId, database, schema: result.schema, fromCache: result.fromCache, cacheAgeMs: result.cacheAgeMs });
				} catch (error) { this.panel.webview.postMessage({ type: 'schemaLoadError', connectionId, database, error: error instanceof Error ? error.message : String(error) }); }
				return;
			}
			case 'database.refreshSchema': {
				const clusterUrl = String(msg.clusterUrl || '').trim();
				const database = String(msg.database || '').trim();
				const source = String(msg.source || '').trim();
				if (!clusterUrl || !database) return;
				const connections = this.connectionManager.getConnections();
				const normalizedUrl = this.normalizeFavoriteClusterUrl(clusterUrl);
				const conn = connections.find((c) => this.normalizeFavoriteClusterUrl(c.clusterUrl) === normalizedUrl);
				if (!conn) { void vscode.window.showWarningMessage(`No connection found for cluster: ${clusterUrl}`); return; }
				this.panel.webview.postMessage({ type: 'schemaRefreshStarted', clusterUrl, database });
				try {
					const result = await this.kustoClient.getDatabaseSchema(conn, database, true);
					const normalizedCluster = conn.clusterUrl.replace(/\/+$/, '');
					const cacheKey = `${normalizedCluster}|${database}`;
					const timestamp = result.fromCache ? Date.now() - (result.cacheAgeMs ?? 0) : Date.now();
					const diskEntry: CachedSchemaEntry = { schema: result.schema, timestamp, version: SCHEMA_CACHE_VERSION, clusterUrl: normalizedCluster, database };
					await writeCachedSchemaToDisk(this.context.globalStorageUri, cacheKey, diskEntry);
					this.panel.webview.postMessage({ type: 'schemaLoaded', connectionId: conn.id, database, schema: result.schema, fromCache: false, cacheAgeMs: 0 });
					this.panel.webview.postMessage({ type: 'schemaRefreshCompleted', clusterUrl, database, success: true });
					void vscode.window.showInformationMessage(`Schema refreshed: ${database}${source ? ` (via ${source})` : ''}`);
				} catch (error) {
					const isAuthError = this.kustoClient.isAuthenticationError(error);
					this.panel.webview.postMessage({ type: 'schemaRefreshCompleted', clusterUrl, database, success: false, error: isAuthError ? 'Authentication required. Please test the connection to sign in.' : error instanceof Error ? error.message : String(error) });
					void vscode.window.showErrorMessage(`Failed to refresh schema for ${database}: ${isAuthError ? 'Authentication required.' : (error instanceof Error ? error.message : String(error))}`);
				}
				return;
			}
			case 'cluster.refreshSchema': {
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) return;
				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === connectionId);
				if (!conn) return;
				this.panel.webview.postMessage({ type: 'loadingDatabases', connectionId });
				try {
					const databases = await this.kustoClient.getDatabases(conn, true);
					const clusterKey = this.getClusterCacheKey(conn.clusterUrl);
					const cached = this.getCachedDatabases();
					cached[clusterKey] = databases;
					await this.setCachedDatabases(cached);
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
				const clusterUrl = String(msg.clusterUrl || '').trim();
				const database = String(msg.database || '').trim();
				if (!clusterUrl || !database) return;
				try {
					const file = createEmptyKqlxOrMdxFile('kqlx');
					file.state.sections.push({ type: 'query', expanded: true, clusterUrl, database, query: '' });
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
				const connectionId = String(msg.connectionId || '').trim();
				const database = String(msg.database || '').trim();
				const tableName = String(msg.tableName || '').trim();
				if (!connectionId || !database || !tableName) return;
				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === connectionId);
				if (!conn) { this.panel.webview.postMessage({ type: 'tablePreviewResult', connectionId, database, tableName, success: false, error: 'Connection not found.' }); return; }
				this.panel.webview.postMessage({ type: 'tablePreviewLoading', connectionId, database, tableName });
				try {
					const safeTableName = `['${tableName.replace(/'/g, "''")}']`;
					const query = `${safeTableName} | take 100`;
					const result = await this.kustoClient.executeQuery(conn, database, query);
					this.panel.webview.postMessage({ type: 'tablePreviewResult', connectionId, database, tableName, success: true, columns: result.columns, rows: result.rows, rowCount: result.rows.length, executionTime: result.metadata?.executionTime });
				} catch (error) {
					const isAuthError = this.kustoClient.isAuthenticationError(error);
					this.panel.webview.postMessage({ type: 'tablePreviewResult', connectionId, database, tableName, success: false, error: isAuthError ? 'Authentication required. Please test the connection to sign in.' : error instanceof Error ? error.message : String(error) });
				}
				return;
			}
			case 'saveResultsCsv': {
				const csv = String(msg.csv || '');
				if (!csv.trim()) { void vscode.window.showInformationMessage('No results to save.'); return; }
				const suggestedName = String(msg.suggestedFileName || 'results.csv');
				const uri = await vscode.window.showSaveDialog({ filters: { 'CSV': ['csv'] }, saveLabel: 'Save', title: 'Save results as CSV', defaultUri: vscode.workspace.workspaceFolders?.[0] ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, suggestedName) : undefined });
				if (uri) { await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(csv)); void vscode.window.setStatusBarMessage(`Results saved to ${uri.fsPath}`, 3000); }
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
				const favorites = this.getSqlFavorites();
				if (favorites.some(f => f.connectionId === connectionId && f.database.toLowerCase() === database.toLowerCase())) return;
				favorites.push({ name, connectionId, database });
				await this.setSqlFavorites(favorites);
				return;
			}
			case 'sql.favorite.remove': {
				const connectionId = String(msg.connectionId || '').trim();
				const database = String(msg.database || '').trim();
				if (!connectionId || !database) return;
				const favorites = this.getSqlFavorites().filter(f => !(f.connectionId === connectionId && f.database.toLowerCase() === database.toLowerCase()));
				await this.setSqlFavorites(favorites);
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
			default: return;
		}
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
			const connections = this.parseKustoExplorerConnectionsXml(text);
			if (!connections.length) { void vscode.window.showInformationMessage('No connections found in the selected XML file.'); return; }
			const existing = this.connectionManager.getConnections();
			const existingKeys = new Set(existing.map((c) => this.normalizeClusterUrlKey(c.clusterUrl || '')).filter(Boolean));
			let added = 0;
			for (const c of connections) {
				const key = this.normalizeClusterUrlKey(c.clusterUrl);
				if (existingKeys.has(key)) continue;
				await this.connectionManager.addConnection({ name: c.name || c.clusterUrl, clusterUrl: c.clusterUrl, database: c.database });
				existingKeys.add(key);
				added++;
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
			const xmlBlocks = connections.map(c => {
				const url = /^https?:\/\//i.test(c.clusterUrl) ? c.clusterUrl : 'https://' + c.clusterUrl;
				const dbPart = c.database ? `Initial Catalog=${this.escapeXml(c.database)};` : '';
				return `  <ServerDescriptionBase>\n    <Name>${this.escapeXml(c.name || c.clusterUrl)}</Name>\n    <Details>${this.escapeXml(url)}</Details>\n    <ConnectionString>Data Source=${this.escapeXml(url)};${dbPart}AAD Federated Security=True</ConnectionString>\n  </ServerDescriptionBase>`;
			});
			const xml = `<?xml version="1.0" encoding="utf-8"?>\n<ArrayOfServerDescriptionBase xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n${xmlBlocks.join('\n')}\n</ArrayOfServerDescriptionBase>\n`;
			const uri = await vscode.window.showSaveDialog({ filters: { 'XML files': ['xml'] }, saveLabel: 'Export', title: 'Export connections', defaultUri: vscode.workspace.workspaceFolders?.[0] ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'connections.xml') : undefined });
			if (uri) {
				await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(xml));
				void vscode.window.setStatusBarMessage(`Exported ${connections.length} connection${connections.length !== 1 ? 's' : ''} to ${uri.fsPath}`, 3000);
			}
		} catch (e: any) { void vscode.window.showErrorMessage(`Failed to export connections: ${e instanceof Error ? e.message : String(e)}`); }
	}

	private escapeXml(s: string): string {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
	}

	private parseKustoExplorerConnectionsXml(xmlText: string): Array<{ name: string; clusterUrl: string; database?: string }> {
		const text = String(xmlText || '').trim();
		if (!text) return [];
		const results: Array<{ name: string; clusterUrl: string; database?: string }> = [];
		const blockRegex = /<ServerDescriptionBase[^>]*>([\s\S]*?)<\/ServerDescriptionBase>/gi;
		let blockMatch: RegExpExecArray | null;
		while ((blockMatch = blockRegex.exec(text)) !== null) {
			const block = blockMatch[1];
			const name = this.getXmlChildText(block, 'Name');
			const details = this.getXmlChildText(block, 'Details');
			const connectionString = this.getXmlChildText(block, 'ConnectionString');
			const parsed = this.parseKustoConnectionString(connectionString);
			let clusterUrl = (parsed.dataSource || details || '').trim();
			if (!clusterUrl) continue;
			if (!/^https?:\/\//i.test(clusterUrl)) clusterUrl = 'https://' + clusterUrl.replace(/^\/+/, '');
			results.push({ name: name.trim() || clusterUrl, clusterUrl: clusterUrl.trim(), database: parsed.initialCatalog.trim() || undefined });
		}
		const seen = new Set<string>();
		return results.filter((r) => { const key = this.normalizeClusterUrlKey(r.clusterUrl); if (!key || seen.has(key)) return false; seen.add(key); return true; });
	}

	private getXmlChildText(parentContent: string, tagName: string): string {
		const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
		const match = regex.exec(parentContent);
		return match ? match[1].trim() : '';
	}

	private parseKustoConnectionString(cs: string): { dataSource: string; initialCatalog: string } {
		const raw = String(cs || '');
		const parts = raw.split(';').map((p) => p.trim()).filter(Boolean);
		const map: Record<string, string> = {};
		for (const part of parts) { const idx = part.indexOf('='); if (idx <= 0) continue; map[part.slice(0, idx).trim().toLowerCase()] = part.slice(idx + 1).trim(); }
		return { dataSource: map['data source'] || map['datasource'] || map['server'] || map['address'] || '', initialCatalog: map['initial catalog'] || map['database'] || '' };
	}

	private normalizeClusterUrlKey(url: string): string {
		try {
			const raw = String(url || '').trim();
			if (!raw) return '';
			const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
			const u = new URL(withScheme);
			return (u.origin + u.pathname).replace(/\/+$/g, '').toLowerCase();
		} catch { return String(url || '').trim().replace(/\/+$/g, '').toLowerCase(); }
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
