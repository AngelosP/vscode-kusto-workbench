import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ConnectionManager, KustoConnection } from './connectionManager';
import { KustoQueryClient } from './kustoClient';
import { clearCachedSchemas, deleteCachedSchemasForAccountPartitions, getSchemaCacheFileUri, readCachedSchemaFromDiskByCluster, writeCachedSchemaToDisk, SCHEMA_CACHE_VERSION, schemaCacheKey } from './schemaCache';
import { KustoAuthPreferenceService, type KustoAccountPreference, type KustoKnownAccount } from './kustoAuthPreferenceService';
import { KustoConnectionCache } from './kustoConnectionCache';
import { countColumns } from './schemaIndexUtils';
import type { SqlConnectionManager, SqlConnection } from './sqlConnectionManager';
import type { SqlQueryClient } from './sqlClient';
import { getSqlSchemaCacheDirUri, getSqlSchemaCacheFileUri, readCachedSqlSchemaFromDisk, sqlSchemaCacheKey, SQL_SCHEMA_CACHE_VERSION } from './sqlEditorSchema';
import { kustoClusterKey } from '../shared/kustoClusterUrls';
import { getWorkbenchLogger } from './workbenchLogger';
import { getKustoAuthScopes, normalizeKustoAuthorityId } from '../shared/kustoAuth';

/**
 * Cached Values Viewer — uses Lit web components for the UI.
 * The extension host handles message routing and data access;
 * the webview renders via the <kw-cached-values> Lit component.
 */

/**
 * Extract hostname from a cluster URL for use as a cache key.
 * Pure function — no side-effects.
 */
export function getClusterCacheKey(clusterUrlRaw: string): string {
	return kustoClusterKey(clusterUrlRaw);
}

/**
 * Merge/dedup cached database entries, resolving connection IDs to cluster hostnames.
 * Pure function — no side-effects.
 */
export function mergeCachedDatabaseKeys(
	raw: Record<string, string[]>,
	connById: Map<string, { clusterUrl: string }>,
): { next: Record<string, string[]>; changed: boolean } {
	const src = raw && typeof raw === 'object' ? raw : {};
	let changed = false;
	const next: Record<string, string[]> = {};
	for (const [k, v] of Object.entries(src)) {
		const keyRaw = String(k || '').trim();
		if (!keyRaw) { changed = true; continue; }
		const list = (Array.isArray(v) ? v : []).map((d) => String(d || '').trim()).filter(Boolean);
		const conn = connById.get(keyRaw);
		const clusterKey = conn ? getClusterCacheKey(conn.clusterUrl) : getClusterCacheKey(keyRaw);
		if (clusterKey !== keyRaw) changed = true;
		const existing = next[clusterKey] || [];
		const merged = [...existing, ...list].map((d) => String(d || '').trim()).filter(Boolean);
		const deduped: string[] = [];
		const seen = new Set<string>();
		for (const d of merged) { const lower = d.toLowerCase(); if (!seen.has(lower)) { seen.add(lower); deduped.push(d); } }
		next[clusterKey] = deduped;
	}
	return { next, changed };
}

const VIEW_TITLE = 'Cached Values';

const STORAGE_KEYS = {
	connections: 'kusto.connections',
	activeKind: 'cachedValues.activeKind',
	sqlServerAccountMap: 'sql.auth.serverAccountMap',
	sqlCachedDatabases: 'sql.connectionManager.cachedDatabases',
} as const;

const SQL_AUTH = {
	providerId: 'microsoft',
	scope: 'https://database.windows.net/.default'
} as const;

const SECRET_KEYS = {
	sqlTokenOverrideByAccountId: (accountId: string) => `sql.auth.tokenOverride.${accountId}`
} as const;

type SnapshotKustoConnection = KustoConnection & {
	accountPreference: KustoAccountPreference;
	selectedAccountId?: string;
	selectedAccountLabel?: string;
	accountPartition?: string;
	hasTokenOverride: boolean;
};

type Snapshot = {
	revision: number;
	timestamp: number;
	activeKind: 'kusto' | 'sql';
	auth: {
		sessions: Array<{
			account: { id: string; label: string };
		}>;
		knownAccounts: KustoKnownAccount[];
	};
	connections: SnapshotKustoConnection[];
	cachedDatabases: Record<string, string[]>;
	sqlAuth: {
		sessions: Array<{
			account: { id: string; label: string };
			hasOverride: boolean;
		}>;
	};
	sqlConnections: Array<{ id: string; name: string; serverUrl: string; authType: string }>;
	sqlCachedDatabases: Record<string, string[]>;
	sqlServerAccountMap: Record<string, string>;
	cachedSchemaKeys: string[];
};

type IncomingMessage =
	| { type: 'requestSnapshot' }
	| { type: 'copyToClipboard'; text: string }
	| { type: 'setActiveKind'; kind: 'kusto' | 'sql' }
	| { type: 'auth.copyToken'; connectionId: string; accountId: string }
	| { type: 'auth.setTokenOverride'; connectionId: string; accountId: string; token: string }
	| { type: 'auth.clearTokenOverride'; connectionId: string; accountId: string }
	| { type: 'auth.forgetAccount'; accountId: string }
	| { type: 'auth.resetAll' }
	| { type: 'connectionPreference.set'; connectionId: string; accountId?: string }
	| { type: 'databases.delete'; connectionId: string }
	| { type: 'databases.refresh'; connectionId: string }
	| { type: 'schema.clearAll' }
	| { type: 'schema.get'; requestId: string; connectionId: string; database: string }
	| { type: 'schema.refresh'; requestId: string; connectionId: string; database: string }
	| { type: 'sqlServerMap.set'; serverUrl: string; accountId: string }
	| { type: 'sqlServerMap.delete'; serverUrl: string }
	| { type: 'sqlDatabases.delete'; connectionId: string }
	| { type: 'sqlDatabases.refresh'; connectionId: string }
	| { type: 'sqlSchema.get'; serverUrl: string; database: string }
	| { type: 'sqlSchema.refresh'; serverUrl: string; database: string; connectionId: string }
	| { type: 'sqlSchema.clearAll' }
	| { type: 'sqlAuth.editConnection'; connectionId: string }
	| { type: 'sqlAuth.copyToken'; accountId: string }
	| { type: 'sqlAuth.setTokenOverride'; accountId: string; token: string }
	| { type: 'sqlAuth.clearTokenOverride'; accountId: string };

export interface CachedValuesSqlDeps {
	getSqlConnectionManager: () => SqlConnectionManager;
	getSqlClient: () => SqlQueryClient;
}

export class CachedValuesViewerV2 {
	private static current: CachedValuesViewerV2 | undefined;

	public static open(context: vscode.ExtensionContext, extensionUri: vscode.Uri, connectionManager: ConnectionManager, sqlDeps?: CachedValuesSqlDeps, viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active): void {
		if (CachedValuesViewerV2.current) {
			if (sqlDeps) { CachedValuesViewerV2.current.sqlDeps = sqlDeps; }
			CachedValuesViewerV2.current.panel.webview.html = CachedValuesViewerV2.current.buildHtml(CachedValuesViewerV2.current.panel.webview);
			CachedValuesViewerV2.current.panel.reveal(viewColumn);
			return;
		}
		CachedValuesViewerV2.current = new CachedValuesViewerV2(context, extensionUri, connectionManager, sqlDeps, viewColumn);
	}

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly kustoClient: KustoQueryClient;
	private readonly authPreferences: KustoAuthPreferenceService;
	private readonly connectionCache: KustoConnectionCache;
	private sqlDeps: CachedValuesSqlDeps | undefined;
	private snapshotRevision = 0;

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager,
		sqlDeps: CachedValuesSqlDeps | undefined,
		viewColumn: vscode.ViewColumn
	) {
		this.authPreferences = KustoAuthPreferenceService.getInstance(this.context);
		this.connectionCache = new KustoConnectionCache(this.context);
		this.kustoClient = new KustoQueryClient(this.context, undefined, this.connectionManager);
		this.sqlDeps = sqlDeps;
		this.panel = vscode.window.createWebviewPanel(
			'kusto.cachedValuesV2',
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
		this.disposables.push(this.authPreferences.onDidChange(() => { void this.sendSnapshotToWebview(); }));
		this.disposables.push(this.connectionManager.onDidChangeConnections(() => { void this.sendSnapshotToWebview(); }));
		this.panel.webview.onDidReceiveMessage((msg: IncomingMessage) => void this.onMessage(msg), null, this.disposables);
		this.panel.webview.html = this.buildHtml(this.panel.webview);
	}

	private dispose(): void {
		CachedValuesViewerV2.current = undefined;
		this.kustoClient.dispose();
		for (const d of this.disposables) {
			try { d.dispose(); } catch { /* ignore */ }
		}
	}

	// ─── Data layer ────────────────────────────────────────────────────────

	private readCachedDatabases(): Record<string, string[]> {
		const next: Record<string, string[]> = {};
		for (const connection of this.connectionManager.getConnections()) {
			let accountPartition: string | undefined;
			let allowLegacy = false;
			try {
				const preference = this.authPreferences.getPreference(connection.id);
				accountPartition = this.kustoClient.getAccountPartition(connection);
				allowLegacy = preference.mode === 'automatic' && normalizeKustoAuthorityId(connection.authorityId) === undefined;
			} catch {
				continue;
			}
			const databases = this.connectionCache.getDatabases(connection.id, accountPartition, allowLegacy);
			if (databases.length > 0) next[connection.id] = databases;
		}
		return next;
	}

	private getClusterCacheKey(clusterUrlRaw: string): string {
		return getClusterCacheKey(clusterUrlRaw);
	}

	private readSqlServerAccountMap(): Record<string, string> {
		const raw = this.context.globalState.get<Record<string, string> | undefined>(STORAGE_KEYS.sqlServerAccountMap);
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
		const next: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw)) {
			if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim()) next[k] = v;
		}
		return next;
	}

	private readSqlCachedDatabases(): Record<string, string[]> {
		const raw = this.context.globalState.get<Record<string, string[]> | undefined>(STORAGE_KEYS.sqlCachedDatabases);
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
		const next: Record<string, string[]> = {};
		for (const [k, v] of Object.entries(raw)) {
			if (typeof k !== 'string' || !k.trim()) continue;
			if (!Array.isArray(v)) continue;
			next[k] = v.map(x => String(x || '').trim()).filter(Boolean);
		}
		return next;
	}

	private async buildSnapshot(revision: number): Promise<Snapshot> {
		const knownAccounts = await this.authPreferences.getAccounts();
		const baseConnections = this.connectionManager.getConnections();
		const cachedDatabases = this.readCachedDatabases();
		const accountsById = new Map<string, { id: string; label: string }>();
		for (const a of knownAccounts) accountsById.set(a.id, { id: a.id, label: a.label });
		const sessionRows = [...accountsById.values()].map(account => ({ account }));
		const connections: SnapshotKustoConnection[] = await Promise.all(baseConnections.map(async connection => {
			const accountPreference = this.authPreferences.getPreference(connection.id);
			const selectedAccountId = this.authPreferences.getPreferredAccountId(connection.id);
			const selectedAccountLabel = selectedAccountId ? accountsById.get(selectedAccountId)?.label ?? selectedAccountId : undefined;
			let hasTokenOverride = false;
			let accountPartition: string | undefined;
			try { accountPartition = this.kustoClient.getAccountPartition(connection); } catch { accountPartition = undefined; }
			try {
				hasTokenOverride = selectedAccountId
					? !!(await this.authPreferences.getTokenOverride(connection.authorityId, selectedAccountId))
					: false;
			} catch { /* malformed legacy authority */ }
			return {
				...connection,
				accountPreference,
				...(selectedAccountId ? { selectedAccountId } : {}),
				...(selectedAccountLabel ? { selectedAccountLabel } : {}),
				...(accountPartition ? { accountPartition } : {}),
				hasTokenOverride,
			};
		}));

		// SQL data
		const activeKind = (this.context.globalState.get<string>(STORAGE_KEYS.activeKind) === 'sql' ? 'sql' : 'kusto') as 'kusto' | 'sql';
		const sqlConnections: Snapshot['sqlConnections'] = [];
		let sqlCachedDatabases: Record<string, string[]> = {};
		const sqlServerAccountMap = this.readSqlServerAccountMap();
		const sqlAuthSessions: Snapshot['sqlAuth']['sessions'] = [];

		// Include SQL server-account map accounts so SQL-only AAD accounts are discovered
		for (const accountId of Object.values(sqlServerAccountMap)) {
			if (accountId && !accountsById.has(accountId)) accountsById.set(accountId, { id: accountId, label: accountId });
		}

		if (this.sqlDeps) {
			try {
				const conns = this.sqlDeps.getSqlConnectionManager().getConnections();
				for (const c of conns) {
					sqlConnections.push({ id: c.id, name: c.name, serverUrl: c.serverUrl, authType: c.authType });
				}
			} catch { /* ignore */ }
			sqlCachedDatabases = this.readSqlCachedDatabases();

			// Build SQL AAD sessions for known accounts (same Microsoft provider, SQL scope)
			const sqlSessionRows = await Promise.all(
				[...accountsById.values()].map(async (account) => {
					let session: vscode.AuthenticationSession | undefined;
					try { session = await vscode.authentication.getSession(SQL_AUTH.providerId, [SQL_AUTH.scope], { silent: true, account }); } catch { session = undefined; }
					if (!session) return null;
					let overrideToken: string | undefined;
					try { overrideToken = (await this.context.secrets.get(SECRET_KEYS.sqlTokenOverrideByAccountId(account.id))) ?? undefined; } catch { overrideToken = undefined; }
					return { account: { id: account.id, label: account.label }, hasOverride: !!(overrideToken && overrideToken.trim()) };
				})
			);
			for (const row of sqlSessionRows) { if (row) sqlAuthSessions.push(row); }
		}

		// Check which databases have cached schema files on disk
		const cachedSchemaKeys: string[] = [];
		const globalStorageUri = this.context.globalStorageUri;
		// Kusto schemas
		for (const [connectionId, dbs] of Object.entries(cachedDatabases)) {
			const connection = connections.find(candidate => candidate.id === connectionId);
			if (!connection) continue;
			let accountPartition: string | undefined;
			try { accountPartition = this.kustoClient.getAccountPartition(connection); } catch { accountPartition = undefined; }
			if (!accountPartition) continue;
			for (const db of dbs) {
				const cacheKey = schemaCacheKey(connection.clusterUrl, db, connection.id, accountPartition);
				try { await vscode.workspace.fs.stat(getSchemaCacheFileUri(globalStorageUri, cacheKey)); cachedSchemaKeys.push(`kusto:${connectionId}|${db}`); } catch { /* no file = not cached */ }
			}
		}
		// SQL schemas
		for (const [connId, dbs] of Object.entries(sqlCachedDatabases)) {
			const conn = sqlConnections.find(c => c.id === connId);
			const serverUrl = conn ? conn.serverUrl : connId;
			for (const db of dbs) {
				const cacheKey = sqlSchemaCacheKey(serverUrl, db);
				try { await vscode.workspace.fs.stat(getSqlSchemaCacheFileUri(globalStorageUri, cacheKey)); cachedSchemaKeys.push(`sql:${serverUrl}|${db}`); } catch { /* no file = not cached */ }
			}
		}

		return {
			revision,
			timestamp: Date.now(),
			activeKind,
			auth: { sessions: sessionRows, knownAccounts },
			connections,
			cachedDatabases,
			sqlAuth: { sessions: sqlAuthSessions },
			sqlConnections,
			sqlCachedDatabases,
			sqlServerAccountMap,
			cachedSchemaKeys,
		};
	}

	private async sendSnapshotToWebview(): Promise<void> {
		try {
			const revision = ++this.snapshotRevision;
			const snapshot = await this.buildSnapshot(revision);
			await this.panel.webview.postMessage({ type: 'snapshot', snapshot });
		} catch (error) {
			// Ignore transient panel lifecycle races (dispose/reveal ordering), but keep diagnostics.
			getWorkbenchLogger().warn('[kusto] cached values snapshot refresh failed', error);
		}
	}

	private async completeKustoMutation(): Promise<void> {
		await this.sendSnapshotToWebview();
		try { await this.panel.webview.postMessage({ type: 'kustoMutationComplete' }); } catch { /* panel disposed */ }
	}

	private async clearKustoAccountCachedData(accountId: string): Promise<void> {
		const accountPartitions = new Set<string>();
		for (const connection of this.connectionManager.getConnections()) {
			try {
				const partition = this.authPreferences.getAccountPartition(connection.authorityId, accountId);
				if (partition) accountPartitions.add(partition);
			} catch {
				// A malformed legacy authority must not block cleanup for other connections.
			}
		}
		for (const partition of accountPartitions) {
			await this.connectionCache.clearAccountPartition(partition);
		}
		await deleteCachedSchemasForAccountPartitions(this.context.globalStorageUri, accountPartitions);
	}

	private getConnectionsForAccountPartition(accountId: string, accountPartition: string): string[] {
		return this.connectionManager.getConnections().flatMap(connection => {
			try {
				return this.authPreferences.getPreferredAccountId(connection.id) === accountId
					&& this.authPreferences.getAccountPartition(connection.authorityId, accountId) === accountPartition
					? [connection.id]
					: [];
			} catch {
				return [];
			}
		});
	}

	// ─── Message handling ──────────────────────────────────────────────────

	private async onMessage(msg: IncomingMessage): Promise<void> {
		switch (msg.type) {
			case 'requestSnapshot': {
				await this.sendSnapshotToWebview();
				return;
			}
			case 'copyToClipboard': {
				try { await vscode.env.clipboard.writeText(String(msg.text ?? '')); void vscode.window.setStatusBarMessage('Copied to clipboard', 1500); } catch { void vscode.window.showErrorMessage('Could not copy to clipboard.'); }
				return;
			}
			case 'setActiveKind': {
				const kind = msg.kind === 'sql' ? 'sql' : 'kusto';
				await this.context.globalState.update(STORAGE_KEYS.activeKind, kind);
				return;
			}
			case 'auth.copyToken': {
				const connection = this.connectionManager.getConnections().find(candidate => candidate.id === String(msg.connectionId || '').trim());
				const accountId = String(msg.accountId || '').trim();
				if (!connection || !accountId) return;
				try {
					let token = await this.authPreferences.getTokenOverride(connection.authorityId, accountId);
					if (!token) {
						const account = (await this.authPreferences.getAccounts()).find(candidate => candidate.id === accountId)
							?? { id: accountId, label: accountId };
						const session = await vscode.authentication.getSession('microsoft', getKustoAuthScopes(connection.authorityId), { silent: true, account });
						if (!session || session.account.id !== accountId) throw new Error('The selected Microsoft account session is unavailable.');
						token = session.accessToken;
					}
					await vscode.env.clipboard.writeText(token);
					void vscode.window.setStatusBarMessage('Copied token to clipboard', 1500);
				} catch {
					void vscode.window.showErrorMessage('Could not retrieve the token for this connection and account.');
				}
				return;
			}
			case 'auth.setTokenOverride': {
				const connection = this.connectionManager.getConnections().find(candidate => candidate.id === String(msg.connectionId || '').trim());
				const accountId = String(msg.accountId || '').trim();
				if (!connection || !accountId) return;
				const accountPartition = this.authPreferences.getAccountPartition(connection.authorityId, accountId);
				await this.authPreferences.setTokenOverride(
					connection.authorityId,
					accountId,
					String(msg.token ?? ''),
					this.getConnectionsForAccountPartition(accountId, accountPartition),
				);
				await this.completeKustoMutation();
				return;
			}
			case 'auth.clearTokenOverride': {
				const connection = this.connectionManager.getConnections().find(candidate => candidate.id === String(msg.connectionId || '').trim());
				const accountId = String(msg.accountId || '').trim();
				if (!connection || !accountId) return;
				const accountPartition = this.authPreferences.getAccountPartition(connection.authorityId, accountId);
				await this.authPreferences.clearTokenOverride(
					connection.authorityId,
					accountId,
					this.getConnectionsForAccountPartition(accountId, accountPartition),
				);
				await this.completeKustoMutation();
				return;
			}
			case 'auth.forgetAccount': {
				const accountId = String(msg.accountId || '').trim();
				if (!accountId) return;
				const choice = await vscode.window.showWarningMessage(
					'Forget this account and remove only its Kusto preferences and cached data?',
					{ modal: true },
					'Forget Account',
				);
				if (choice !== 'Forget Account') { await this.completeKustoMutation(); return; }
				await this.authPreferences.forgetAccount(accountId);
				await this.clearKustoAccountCachedData(accountId);
				await this.completeKustoMutation();
				return;
			}
			case 'auth.resetAll': {
				for (const account of await this.authPreferences.getAccounts()) {
					await this.authPreferences.forgetAccount(account.id);
				}
				await this.connectionCache.clearAll();
				try { await this.context.globalState.update('kusto.cacheClearEpoch', Date.now()); } catch { /* ignore */ }
				await clearCachedSchemas(this.context.globalStorageUri);
				await this.completeKustoMutation();
				return;
			}
			case 'connectionPreference.set': {
				const connectionId = String(msg.connectionId || '').trim();
				const accountId = String(msg.accountId || '').trim();
				if (!connectionId) return;
				if (!accountId) {
					await this.authPreferences.setAutomatic(connectionId);
				} else {
					const account = (await this.authPreferences.getAccounts()).find(candidate => candidate.id === accountId)
						?? { id: accountId, label: accountId };
					await this.authPreferences.setExplicitAccount(connectionId, account);
				}
				await this.completeKustoMutation();
				return;
			}
			case 'databases.delete': {
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) return;
				await this.connectionCache.clearConnection(connectionId);
				await this.completeKustoMutation();
				return;
			}
			case 'databases.refresh': {
				const connectionId = String(msg.connectionId || '').trim();
				const connection = this.connectionManager.getConnections().find(candidate => candidate.id === connectionId);
				if (!connection) return;
				const cachedBefore = this.readCachedDatabases()[connectionId] ?? [];
				try {
					const databasesRaw = await this.kustoClient.getDatabases(connection, true, {
						traceId: randomUUID(),
						source: 'cached-values-refresh',
					});
					const databases = (Array.isArray(databasesRaw) ? databasesRaw : []).map((d) => String(d || '').trim()).filter(Boolean).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
					if (databases.length > 0) return;
					if (cachedBefore.length === 0) void vscode.window.showWarningMessage('The selected identity can connect but no databases are visible. Check the Authority / Tenant ID and account.');
					else void vscode.window.showWarningMessage("Couldn't refresh the database list (received 0 databases). Keeping the previous cached list.");
					return;
				} catch (error) {
					const msgText = this.kustoClient.isAuthenticationError(error) ? 'Failed to refresh the database list due to an authentication error. Try running a query against the cluster to sign in, then refresh again.' : 'Failed to refresh the database list. Check your connection and try again.';
					void vscode.window.showErrorMessage(msgText);
					return;
				} finally {
					await this.completeKustoMutation();
				}
			}
			case 'schema.clearAll': {
				try { await this.connectionCache.clearAll(); } catch { /* ignore */ }
				try { await this.context.globalState.update('kusto.cacheClearEpoch', Date.now()); } catch { /* ignore */ }
				await clearCachedSchemas(this.context.globalStorageUri);
				try { void vscode.window.setStatusBarMessage('Cleared cached schema data', 2000); } catch { /* ignore */ }
				await this.completeKustoMutation();
				return;
			}
			case 'schema.get': {
				const requestId = String(msg.requestId || '').trim();
				const connectionId = String(msg.connectionId || '').trim();
				const database = String(msg.database || '').trim();
				const connection = this.connectionManager.getConnections().find(candidate => candidate.id === connectionId);
				if (!requestId || !connection || !database) return;
				const accountPartition = this.kustoClient.getAccountPartition(connection);
				let jsonText = '';
				let ok = false;
				try {
					const cached = await readCachedSchemaFromDiskByCluster(this.context.globalStorageUri, connection.clusterUrl, database, connection.id, accountPartition);
					if (!cached?.schema) {
						jsonText = JSON.stringify({ cluster: connection.clusterUrl, database, error: 'No cached schema was found for this database and account. Try loading schema for autocomplete (or refresh schema), then try again.' }, null, 2);
						ok = false;
					} else {
						const schema = cached.schema;
						const tablesCount = schema.tables?.length ?? 0;
						const columnsCount = countColumns(schema);
						const functionsCount = schema.functions?.length ?? 0;
						const cacheAgeMs = Math.max(0, Date.now() - cached.timestamp);
						jsonText = JSON.stringify({ cluster: connection.clusterUrl, database, schema, meta: { cacheAgeMs, tablesCount, columnsCount, functionsCount, timestamp: cached.timestamp } }, null, 2);
						ok = true;
					}
				} catch {
					jsonText = JSON.stringify({ cluster: connection.clusterUrl, database, error: 'Failed to read cached schema from disk.' }, null, 2);
					ok = false;
				}
				if (this.kustoClient.getAccountPartition(connection) !== accountPartition) return;
				try { this.panel.webview.postMessage({ type: 'schemaResult', requestId, connectionId, accountPartition, database, ok, json: jsonText }); } catch { /* ignore */ }
				return;
			}
			case 'schema.refresh': {
				const requestId = String(msg.requestId || '').trim();
				const connectionId = String(msg.connectionId || '').trim();
				const database = String(msg.database || '').trim();
				const connection = this.connectionManager.getConnections().find(candidate => candidate.id === connectionId);
				if (!requestId || !connection || !database) return;
				const startingAccountPartition = this.kustoClient.getAccountPartition(connection);
				try {
					const result = await this.kustoClient.getDatabaseSchema(connection, database, true);
					const schema = result.schema;
					const accountPartition = result.accountPartition;
					if (!accountPartition) throw new Error('Schema authentication identity could not be resolved.');
					const cacheKey = schemaCacheKey(connection.clusterUrl, database, connection.id, accountPartition);
					const entry = { schema, timestamp: Date.now(), version: SCHEMA_CACHE_VERSION, clusterUrl: connection.clusterUrl, database, connectionId: connection.id, accountPartition };
					await writeCachedSchemaToDisk(this.context.globalStorageUri, cacheKey, entry, result.cacheGeneration);
					const tablesCount = schema.tables?.length ?? 0;
					const columnsCount = countColumns(schema);
					const functionsCount = schema.functions?.length ?? 0;
					const jsonText = JSON.stringify({ cluster: connection.clusterUrl, database, schema, meta: { cacheAgeMs: 0, tablesCount, columnsCount, functionsCount, timestamp: entry.timestamp } }, null, 2);
					await this.sendSnapshotToWebview();
					if (this.kustoClient.getAccountPartition(connection) !== accountPartition) return;
					try { this.panel.webview.postMessage({ type: 'schemaResult', requestId, connectionId, accountPartition, database, ok: true, json: jsonText }); } catch { /* ignore */ }
					void vscode.window.setStatusBarMessage(`Refreshed schema for ${database}`, 2000);
				} catch (error) {
					const isAuth = this.kustoClient.isAuthenticationError(error);
					const msgText = isAuth
						? 'Failed to refresh schema due to an authentication error. Try running a query first.'
						: 'Failed to refresh schema. Check your connection and try again.';
					void vscode.window.showErrorMessage(msgText);
					if (this.kustoClient.getAccountPartition(connection) === startingAccountPartition) {
						try { this.panel.webview.postMessage({ type: 'schemaResult', requestId, connectionId, accountPartition: startingAccountPartition, database, ok: false, json: '' }); } catch { /* ignore */ }
					}
				}
				return;
			}

			// ── SQL message handlers ───────────────────────────────────────────

			case 'sqlServerMap.set': {
				const serverUrl = String(msg.serverUrl || '').trim();
				const accountId = String(msg.accountId || '').trim();
				if (!serverUrl || !accountId) return;
				const prev = this.readSqlServerAccountMap();
				prev[serverUrl] = accountId;
				await this.context.globalState.update(STORAGE_KEYS.sqlServerAccountMap, prev);
				return;
			}
			case 'sqlServerMap.delete': {
				const serverUrl = String(msg.serverUrl || '').trim();
				if (!serverUrl) return;
				const prev = this.readSqlServerAccountMap();
				delete prev[serverUrl];
				await this.context.globalState.update(STORAGE_KEYS.sqlServerAccountMap, prev);
				return;
			}
			case 'sqlDatabases.delete': {
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) return;
				const cached = this.readSqlCachedDatabases();
				delete cached[connectionId];
				await this.context.globalState.update(STORAGE_KEYS.sqlCachedDatabases, cached);
				return;
			}
			case 'sqlDatabases.refresh': {
				if (!this.sqlDeps) return;
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) return;
				let connection: SqlConnection | undefined;
				try { connection = this.sqlDeps.getSqlConnectionManager().getConnections().find(c => c.id === connectionId); } catch { connection = undefined; }
				if (!connection) { void vscode.window.showErrorMessage('SQL connection not found.'); return; }
				try {
					const databases = await this.sqlDeps.getSqlClient().getDatabases(connection);
					const sorted = (Array.isArray(databases) ? databases : []).map(d => String(d || '').trim()).filter(Boolean).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
					const cached = this.readSqlCachedDatabases();
					cached[connectionId] = sorted;
					await this.context.globalState.update(STORAGE_KEYS.sqlCachedDatabases, cached);
				} catch {
					void vscode.window.showErrorMessage('Failed to refresh the SQL database list. Check your connection and try again.');
				}
				return;
			}
			case 'sqlSchema.get': {
				const serverUrl = String(msg.serverUrl || '').trim();
				const database = String(msg.database || '').trim();
				if (!serverUrl || !database) return;
				const cacheKey = sqlSchemaCacheKey(serverUrl, database);
				let jsonText = '';
				let ok = false;
				try {
					const cached = await readCachedSqlSchemaFromDisk(this.context.globalStorageUri, cacheKey);
					if (!cached?.schema) {
						jsonText = JSON.stringify({ server: serverUrl, database, error: 'No cached schema was found for this database. Run a query or open the database in a SQL section to cache the schema, then try again.' }, null, 2);
						ok = false;
					} else {
						const schema = cached.schema;
						const tablesCount = schema.tables?.length ?? 0;
						const viewsCount = schema.views?.length ?? 0;
						const procsCount = schema.storedProcedures?.length ?? 0;
						const cacheAgeMs = Math.max(0, Date.now() - cached.timestamp);
						const stale = typeof cached.version !== 'number' || cached.version < SQL_SCHEMA_CACHE_VERSION;
						jsonText = JSON.stringify({ server: serverUrl, database, schema, meta: { cacheAgeMs, tablesCount, viewsCount, procsCount, timestamp: cached.timestamp, ...(stale ? { staleWarning: 'Schema cached by an older version. Click the refresh button (↻) next to the database name to re-fetch and include views & stored procedures.' } : {}) } }, null, 2);
						ok = true;
					}
				} catch {
					jsonText = JSON.stringify({ server: serverUrl, database, error: 'Failed to read cached SQL schema from disk.' }, null, 2);
					ok = false;
				}
				try { this.panel.webview.postMessage({ type: 'schemaResult', clusterKey: serverUrl, database, ok, json: jsonText }); } catch { /* ignore */ }
				return;
			}
			case 'sqlSchema.refresh': {
				if (!this.sqlDeps) return;
				const serverUrl = String(msg.serverUrl || '').trim();
				const database = String(msg.database || '').trim();
				const connectionId = String(msg.connectionId || '').trim();
				if (!serverUrl || !database || !connectionId) return;
				let connection: SqlConnection | undefined;
				try { connection = this.sqlDeps.getSqlConnectionManager().getConnections().find(c => c.id === connectionId); } catch { connection = undefined; }
				if (!connection) { void vscode.window.showErrorMessage('SQL connection not found.'); return; }
				try {
					const schema = await this.sqlDeps.getSqlClient().getDatabaseSchema(connection, database);
					// Write to disk cache with version
					const cacheKey = sqlSchemaCacheKey(serverUrl, database);
					const entry = { schema, timestamp: Date.now(), version: SQL_SCHEMA_CACHE_VERSION };
					const dir = getSqlSchemaCacheDirUri(this.context.globalStorageUri);
					try { await vscode.workspace.fs.createDirectory(dir); } catch { /* ignore */ }
					const hash = (await import('crypto')).createHash('sha1').update(cacheKey, 'utf8').digest('hex');
					const fileUri = vscode.Uri.joinPath(dir, `${hash}.json`);
					await vscode.workspace.fs.writeFile(fileUri, Buffer.from(JSON.stringify(entry), 'utf8'));
					// Send freshly-fetched schema to the viewer
					const tablesCount = schema.tables?.length ?? 0;
					const viewsCount = schema.views?.length ?? 0;
					const procsCount = schema.storedProcedures?.length ?? 0;
					const jsonText = JSON.stringify({ server: serverUrl, database, schema, meta: { cacheAgeMs: 0, tablesCount, viewsCount, procsCount, timestamp: entry.timestamp } }, null, 2);
					try { this.panel.webview.postMessage({ type: 'schemaResult', clusterKey: serverUrl, database, ok: true, json: jsonText }); } catch { /* ignore */ }
					void vscode.window.setStatusBarMessage(`Refreshed SQL schema for ${database}`, 2000);
				} catch (error) {
					void vscode.window.showErrorMessage('Failed to refresh SQL schema. Check your connection and try again.');
				}
				return;
			}
			case 'sqlSchema.clearAll': {
				try { await this.context.globalState.update(STORAGE_KEYS.sqlCachedDatabases, {}); } catch { /* ignore */ }
				try { const dir = getSqlSchemaCacheDirUri(this.context.globalStorageUri); await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false }); } catch { /* ignore */ }
				try { void vscode.window.setStatusBarMessage('Cleared cached SQL schema data', 2000); } catch { /* ignore */ }
				return;
			}
			case 'sqlAuth.editConnection': {
				void vscode.commands.executeCommand('kusto.manageConnections');
				return;
			}
			case 'sqlAuth.copyToken': {
				const accountId = String(msg.accountId || '').trim();
				if (!accountId) return;
				try {
					const account = (await this.authPreferences.getAccounts()).find(candidate => candidate.id === accountId)
						?? { id: accountId, label: accountId };
					const session = await vscode.authentication.getSession(SQL_AUTH.providerId, [SQL_AUTH.scope], { silent: true, account });
					if (!session || session.account.id !== accountId) throw new Error('SQL account session unavailable.');
					const override = await this.context.secrets.get(SECRET_KEYS.sqlTokenOverrideByAccountId(accountId));
					await vscode.env.clipboard.writeText(String(override || '').trim() || session.accessToken);
					void vscode.window.setStatusBarMessage('Copied token to clipboard', 1500);
				} catch {
					void vscode.window.showErrorMessage('Could not retrieve the SQL token for this account.');
				}
				return;
			}
			case 'sqlAuth.setTokenOverride': {
				const accountId = String(msg.accountId || '').trim();
				if (!accountId) return;
				await this.context.secrets.store(SECRET_KEYS.sqlTokenOverrideByAccountId(accountId), String(msg.token ?? ''));
				return;
			}
			case 'sqlAuth.clearTokenOverride': {
				const accountId = String(msg.accountId || '').trim();
				if (!accountId) return;
				try { await this.context.secrets.delete(SECRET_KEYS.sqlTokenOverrideByAccountId(accountId)); } catch { /* ignore */ }
				return;
			}
			default:
				return;
		}
	}

	// ─── HTML shell (loads Lit bundle + renders <kw-cached-values>) ─────────

	private buildHtml(webview: vscode.Webview): string {
		const nonce = String(Date.now()) + Math.random().toString(16).slice(2);
		const bundleUri = webview
			.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'webview.bundle.js'))
			.toString();
		const codiconFontUri = webview
			.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'monaco', 'vs', 'base', 'browser', 'ui', 'codicons', 'codicon', 'codicon.ttf'))
			.toString();
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
	<style>
		@font-face { font-family: "codicon"; font-display: block; src: url("${codiconFontUri}") format("truetype"); }
		html, body { width: 100%; min-height: 100%; margin: 0; }
		kw-cached-values { display: block; width: 100%; }
	</style>
</head>
<body data-kw-page-overlay-scroll="true">
	<kw-cached-values></kw-cached-values>
	<script nonce="${nonce}" src="${bundleUri}"></script>
</body>
</html>`;
	}
}
