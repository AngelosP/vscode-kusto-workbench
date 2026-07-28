import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ConnectionManager, KustoConnection, type KustoConnectionChange } from './connectionManager';
import { KustoQueryClient } from './kustoClient';
import { captureSchemaCacheGeneration, clearCachedSchemas, deleteCachedSchemasForAccountPartitions, getSchemaCacheFileUri, readCachedSchemaFromDiskByCluster, writeCachedSchemaToDisk, SCHEMA_CACHE_VERSION, schemaCacheKey } from './schemaCache';
import { KustoAuthPreferenceService, type KustoAccountPreference, type KustoAuthPreferenceChange, type KustoKnownAccount } from './kustoAuthPreferenceService';
import { KustoConnectionCache, type KustoConnectionCacheGeneration } from './kustoConnectionCache';
import { countColumns } from './schemaIndexUtils';
import type { SqlConnectionManager, SqlConnection } from './sqlConnectionManager';
import type { SqlQueryClient } from './sqlClient';
import { getSqlSchemaCacheDirUri, getSqlSchemaCacheFileUri, readCachedSqlSchemaFromDisk, readCurrentSqlSchemaPrincipalFingerprint, sqlSchemaCacheKey, sqlSchemaPrincipalFingerprint, sqlSchemaPrincipalFingerprintForPrincipal, sqlSchemaTargetSignature, SQL_SCHEMA_CACHE_VERSION, type SqlSchemaCacheOwner } from './sqlEditorSchema';
import { kustoClusterKey } from '../shared/kustoClusterUrls';
import { getWorkbenchLogger } from './workbenchLogger';
import { getKustoAuthScopes, getKustoConnectionIdentityKey, normalizeKustoAuthorityId } from '../shared/kustoAuth';
import type { KustoLeaveNoTracePolicySnapshot } from './kustoLeaveNoTracePolicyStore';
import type { SchemaCacheGeneration } from './schemaCache';
import {
	beginSqlDatabaseCacheRequest,
	clearSqlDatabaseCacheStore,
	deleteSqlDatabaseCacheEntry,
	getOwnedSqlDatabaseLists,
	getOwnedSqlDatabaseCacheEntry,
	sqlDatabaseTargetSignature,
	SQL_DATABASE_CACHE_STORAGE_KEY,
	setSqlDatabaseCacheConnectionIdentity,
	writeOwnedSqlDatabaseCacheEntry,
} from './sqlDatabaseCache';
import {
	deleteSqlServerAccountMapEntry,
	normalizeSqlServerUrl,
	readSqlServerAccountMap,
	setSqlServerAccountMapEntry,
} from './sql/sqlAuthState';
import { captureSqlSchemaCacheGeneration, clearSqlSchemaCacheFiles, publishSqlSchemaCacheFile } from './sqlSchemaCacheGeneration';

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
	sqlCachedDatabases: SQL_DATABASE_CACHE_STORAGE_KEY,
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

type KustoCachedValuesOwner = Readonly<{
	connection: KustoConnection;
	connectionIdentityKey: string;
	connectionIncarnation: number;
	accountPartition?: string;
	authSessionGeneration: number;
	leaveNoTraceRevision: number;
	operationGeneration: number;
	databaseCacheGeneration: KustoConnectionCacheGeneration;
	schemaCacheGeneration: SchemaCacheGeneration;
}>;

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
	sqlLeaveNoTrace: string[];
	sqlStateVersions?: { policy: number; principals: number; connections: number };
	sqlAvailable?: boolean;
	sqlServerAccountMap: Record<string, string>;
	cachedSchemaKeys: string[];
	/** Host-only provenance removed before posting to the webview. */
	sqlCacheOwners?: Record<string, { targetSignature: string; principalFingerprint: string }>;
	/** Host-only provenance removed before posting to the webview. */
	sqlSchemaKeyOwners?: Record<string, { targetSignature: string; principalFingerprint: string }>;
};

type IncomingMessage =
	| { type: 'requestSnapshot' }
	| { type: 'kustoPublicationAck'; publicationId: string; phase: 'staged' | 'applied'; accepted: boolean }
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
	| { type: 'sqlSchema.get'; requestId: string; serverUrl: string; database: string; connectionId: string }
	| { type: 'sqlSchema.refresh'; requestId: string; serverUrl: string; database: string; connectionId: string }
	| { type: 'sqlSchema.clearAll' }
	| { type: 'sqlAuth.editConnection'; connectionId: string }
	| { type: 'sqlAuth.copyToken'; accountId: string }
	| { type: 'sqlAuth.setTokenOverride'; accountId: string; token: string }
	| { type: 'sqlAuth.clearTokenOverride'; accountId: string };

export interface CachedValuesSqlDeps {
	getSqlConnectionManager: () => SqlConnectionManager;
	getSqlClient: () => SqlQueryClient;
	assertSqlConnectionAllowed?: (connectionId: string) => Promise<void>;
	dispatchSqlConnectionAllowed?: <T>(connectionId: string, dispatch: () => T | PromiseLike<T>) => Promise<T>;
	dispatchSqlPolicySnapshot?: <T>(dispatch: (snapshot: { connectionIds: readonly string[]; version: number; globallyBlocked: boolean }) => T | PromiseLike<T>) => Promise<T>;
	dispatchSqlOwnerAllowed?: <T>(connection: SqlConnection, principalFingerprint: string, revocationGeneration: number, dispatch: () => T | PromiseLike<T>) => Promise<T>;
	dispatchSqlOwnerSnapshot?: <T>(dispatch: (snapshot: {
		policy: { connectionIds: readonly string[]; version: number; globallyBlocked: boolean; revocationGenerations: Readonly<Record<string, number>> };
		connections: readonly SqlConnection[];
		connectionVersion: number;
		accountsByServer: Readonly<Record<string, string>>;
		principalVersion: number;
	}) => T | PromiseLike<T>) => Promise<T>;
	tryDispatchSqlOwnerSnapshot?: <T>(dispatch: (snapshot: {
		policy: { connectionIds: readonly string[]; version: number; globallyBlocked: boolean; revocationGenerations: Readonly<Record<string, number>> };
		connections: readonly SqlConnection[];
		connectionVersion: number;
		accountsByServer: Readonly<Record<string, string>>;
		principalVersion: number;
	}) => T | PromiseLike<T>) => Promise<{ acquired: true; value: T } | { acquired: false }>;
	retrySqlOwnerSnapshotAcquisition?: <T>(attempt: () => Promise<{ acquired: true; value: T } | { acquired: false }>) => Promise<T>;
	refreshSqlLeaveNoTracePolicy?: () => Promise<string[]>;
	getSqlLeaveNoTraceConnectionIds?: () => string[];
	getSqlRevocationGeneration?: (connectionId: string) => number;
	getSqlStateVersions?: () => { policy: number; principals: number; connections: number };
	onDidChangeSqlLeaveNoTrace?: (listener: (change: { invalidatedConnectionIds: string[] }) => void) => vscode.Disposable;
	onDidChangeSqlPrincipals?: (listener: (change: { connectionIds: string[] }) => void) => vscode.Disposable;
	onDidChangeSqlConnections?: (listener: (change: { connectionIds: string[] }) => void) => vscode.Disposable;
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
	private readonly sqlPanelAbortController = new AbortController();
	private kustoGlobalOperationGeneration = 0;
	private readonly kustoOperationGenerations = new Map<string, number>();
	private readonly pendingKustoPublicationAcks = new Map<string, { resolve: (accepted: boolean) => void; timer?: ReturnType<typeof setTimeout> }>();

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
		this.disposables.push(this.authPreferences.onDidChange(change => {
			this.handleKustoAuthPreferenceChange(change);
		}));
		this.disposables.push(this.connectionManager.onDidChangeConnections(change => {
			this.invalidateKustoOwners(this.getChangedKustoConnectionIds(change));
			void this.sendSnapshotToWebview();
		}));
		this.disposables.push(this.connectionManager.onDidChangeLeaveNoTrace(change => {
			this.invalidateKustoOwners(change.connectionIds);
			void this.sendSnapshotToWebview();
		}));
		const sqlPolicySubscription = this.sqlDeps?.onDidChangeSqlLeaveNoTrace?.(change => {
			if (change.invalidatedConnectionIds.length > 0) {
				try { this.panel.webview.postMessage({ type: 'sqlOwnerChanged', connectionIds: change.invalidatedConnectionIds }); } catch { /* panel disposed */ }
			}
			void this.sendSnapshotToWebview();
		});
		if (sqlPolicySubscription) this.disposables.push(sqlPolicySubscription);
		const sqlPrincipalSubscription = this.sqlDeps?.onDidChangeSqlPrincipals?.(change => {
			try { this.panel.webview.postMessage({ type: 'sqlPrincipalChanged', connectionIds: change.connectionIds }); } catch { /* panel disposed */ }
			void this.sendSnapshotToWebview();
		});
		if (sqlPrincipalSubscription) this.disposables.push(sqlPrincipalSubscription);
		const sqlConnectionSubscription = this.sqlDeps?.onDidChangeSqlConnections?.(change => {
			try { this.panel.webview.postMessage({ type: 'sqlOwnerChanged', connectionIds: change.connectionIds }); } catch { /* panel disposed */ }
			void this.sendSnapshotToWebview();
		});
		if (sqlConnectionSubscription) this.disposables.push(sqlConnectionSubscription);
		this.panel.webview.onDidReceiveMessage((msg: IncomingMessage) => void this.onMessage(msg), null, this.disposables);
		this.panel.webview.html = this.buildHtml(this.panel.webview);
	}

	private dispose(): void {
		CachedValuesViewerV2.current = undefined;
		this.sqlPanelAbortController?.abort();
		this.kustoClient.dispose();
		for (const [key, pending] of [...this.pendingKustoPublicationAcks]) {
			this.pendingKustoPublicationAcks.delete(key);
			if (pending.timer) clearTimeout(pending.timer);
			pending.resolve(false);
		}
		for (const d of this.disposables) {
			try { d.dispose(); } catch { /* ignore */ }
		}
	}

	private getChangedKustoConnectionIds(change: KustoConnectionChange): string[] {
		if (change.type === 'cleared') return change.connections.map(connection => connection.id);
		return [change.connection.id];
	}

	private handleKustoAuthPreferenceChange(change: KustoAuthPreferenceChange): void {
		if (change.connectionIds.length > 0 && (change.reason !== 'success' || change.firstEstablishment !== true)) {
			this.invalidateKustoOwners(change.connectionIds);
		}
		void this.sendSnapshotToWebview();
	}

	private invalidateKustoOwners(connectionIds: readonly string[]): void {
		const ids = [...new Set(connectionIds.map(id => String(id || '').trim()).filter(Boolean))];
		if (ids.length === 0) this.kustoGlobalOperationGeneration++;
		for (const id of ids) {
			this.kustoOperationGenerations.set(id, (this.kustoOperationGenerations.get(id) ?? 0) + 1);
		}
		try { void this.panel.webview.postMessage({ type: 'kustoOwnerChanged', connectionIds: ids }); } catch { /* panel disposed */ }
	}

	private currentKustoOperationGeneration(connectionId: string): number {
		return this.kustoGlobalOperationGeneration * 1_000_000_000
			+ (this.kustoOperationGenerations.get(connectionId) ?? 0);
	}

	private async postKustoPublication(message: Record<string, unknown>): Promise<boolean> {
		const publicationId = `kusto-cached-values-publication-${randomUUID()}`;
		const publicationDeadline = Date.now() + 5_000;
		const waitForAck = (phase: 'staged' | 'applied', timeoutMs?: number): Promise<boolean> => new Promise(resolve => {
			const key = `${publicationId}:${phase}`;
			const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
				this.pendingKustoPublicationAcks.delete(key);
				resolve(false);
			}, timeoutMs);
			this.pendingKustoPublicationAcks.set(key, { resolve, ...(timer ? { timer } : {}) });
		});
		const fail = (phase: 'staged' | 'applied') => {
			const key = `${publicationId}:${phase}`;
			const pending = this.pendingKustoPublicationAcks.get(key);
			if (!pending) return;
			this.pendingKustoPublicationAcks.delete(key);
			if (pending.timer) clearTimeout(pending.timer);
			pending.resolve(false);
		};
		const staged = waitForAck('staged', 5_000);
		if (!await this.panel.webview.postMessage({
			type: 'kustoPublicationStage', publicationId, publicationDeadline, payload: message,
		})) fail('staged');
		if (!await staged) return false;
		const applied = waitForAck('applied');
		const pending = this.pendingKustoPublicationAcks.get(`${publicationId}:applied`);
		if (pending) {
			const key = `${publicationId}:applied`;
			pending.timer = setTimeout(async () => {
				if (this.pendingKustoPublicationAcks.get(key) !== pending) return;
				pending.timer = setTimeout(() => fail('applied'), 1_000);
				if (!await this.panel.webview.postMessage({ type: 'kustoPublicationRevoke', publicationId })) fail('applied');
			}, Math.max(1, publicationDeadline - Date.now()));
		}
		if (!await this.panel.webview.postMessage({ type: 'kustoPublicationCommit', publicationId })) fail('applied');
		return applied;
	}

	private async captureKustoOwner(connectionId: string): Promise<KustoCachedValuesOwner | undefined> {
		return this.connectionManager.runWithLeaveNoTraceSnapshotLock(async policy => {
			const connection = this.connectionManager.getConnections().find(candidate => candidate.id === connectionId);
			if (!connection || policy.globallyBlocked || new Set(policy.clusterKeys).has(kustoClusterKey(connection.clusterUrl))) return undefined;
			const accountPartition = String(this.kustoClient.getAccountPartition(connection) || '').trim() || undefined;
			return Object.freeze({
				connection: Object.freeze({ ...connection }),
				connectionIdentityKey: getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId),
				connectionIncarnation: this.connectionManager.getConnectionIncarnation(connection.id),
				...(accountPartition ? { accountPartition } : {}),
				authSessionGeneration: this.kustoClient.getConnectionSessionGeneration(connection),
				leaveNoTraceRevision: policy.revocationGenerations[ kustoClusterKey(connection.clusterUrl) ] ?? 0,
				operationGeneration: this.currentKustoOperationGeneration(connection.id),
				databaseCacheGeneration: this.connectionCache.captureGeneration(connection.id, accountPartition || ''),
				schemaCacheGeneration: captureSchemaCacheGeneration(this.context.globalStorageUri, connection.id, accountPartition || ''),
			});
		});
	}

	private async admitKustoOwner<T>(
		owner: KustoCachedValuesOwner,
		expectedAccountPartition: string | undefined,
		apply: (connection: KustoConnection) => T | PromiseLike<T>,
	): Promise<T | undefined> {
		await this.authPreferences.waitForProviderAccountRefresh();
		return this.connectionManager.runWithLeaveNoTraceSnapshotLock(async policy => {
			const connection = this.connectionManager.getConnections().find(candidate => candidate.id === owner.connection.id);
			const clusterKey = kustoClusterKey(connection?.clusterUrl);
			if (!connection || policy.globallyBlocked || new Set(policy.clusterKeys).has(clusterKey)
				|| (policy.revocationGenerations[clusterKey] ?? 0) !== owner.leaveNoTraceRevision
				|| this.currentKustoOperationGeneration(connection.id) !== owner.operationGeneration
				|| this.connectionManager.getConnectionIncarnation(connection.id) !== owner.connectionIncarnation
				|| getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId) !== owner.connectionIdentityKey
				|| this.kustoClient.getConnectionSessionGeneration(connection) !== owner.authSessionGeneration) return undefined;
			const currentPartition = this.kustoClient.getAccountPartition(connection);
			const expectedPartition = expectedAccountPartition || owner.accountPartition;
			if (!expectedPartition || currentPartition !== expectedPartition
				|| (owner.accountPartition && currentPartition !== owner.accountPartition)) return undefined;
			return await apply(connection);
		});
	}

	private isKustoOwnerLocallyCurrent(owner: KustoCachedValuesOwner, expectedAccountPartition: string): boolean {
		const connection = this.connectionManager.getConnections().find(candidate => candidate.id === owner.connection.id);
		return !!connection
			&& this.currentKustoOperationGeneration(connection.id) === owner.operationGeneration
			&& this.connectionManager.getConnectionIncarnation(connection.id) === owner.connectionIncarnation
			&& getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId) === owner.connectionIdentityKey
			&& this.kustoClient.getConnectionSessionGeneration(connection) === owner.authSessionGeneration
			&& this.kustoClient.getAccountPartition(connection) === expectedAccountPartition;
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
		return readSqlServerAccountMap(this.context);
	}

	private async readSqlCachedDatabases(): Promise<Record<string, string[]>> {
		const connections = this.sqlDeps?.getSqlConnectionManager().getConnections() ?? [];
		return getOwnedSqlDatabaseLists(this.context, STORAGE_KEYS.sqlCachedDatabases, connections);
	}

	private async resolveCurrentSqlPrincipal(connection: SqlConnection, revocationGeneration: number, startingPrincipal?: string): Promise<string> {
		await this.sqlDeps?.assertSqlConnectionAllowed?.(connection.id);
		await this.sqlDeps?.getSqlConnectionManager().assertConnectionCurrent(connection);
		const current = this.sqlDeps?.getSqlConnectionManager().getConnection(connection.id);
		const principal = current ? await readCurrentSqlSchemaPrincipalFingerprint(this.context, current) : undefined;
		if (!current
			|| sqlDatabaseTargetSignature(current) !== sqlDatabaseTargetSignature(connection)
			|| !principal
			|| (startingPrincipal && principal !== startingPrincipal)) {
			throw new Error('SQL connection changed while the request was running.');
		}
		await this.dispatchSqlAllowed(connection, principal, revocationGeneration, () => undefined);
		return principal;
	}

	private async assertCurrentSqlSchemaOwner(
		connection: SqlConnection,
		owner: SqlSchemaCacheOwner & { revocationGeneration: number },
	): Promise<SqlConnection> {
		await this.sqlDeps?.assertSqlConnectionAllowed?.(connection.id);
		await this.sqlDeps?.getSqlConnectionManager().assertConnectionCurrent(connection);
		const current = this.sqlDeps?.getSqlConnectionManager().getConnection(connection.id);
		if (!current
			|| sqlSchemaTargetSignature(current) !== owner.targetSignature
			|| await readCurrentSqlSchemaPrincipalFingerprint(this.context, current) !== owner.principalFingerprint) {
			throw new Error('SQL schema owner changed while the request was running.');
		}
		await this.dispatchSqlAllowed(connection, owner.principalFingerprint, owner.revocationGeneration, () => undefined);
		return current;
	}

	private async dispatchSqlAllowed<T>(
		connection: SqlConnection,
		principalFingerprint: string,
		revocationGeneration: number,
		dispatch: () => T | PromiseLike<T>,
	): Promise<T> {
		if (this.sqlDeps?.dispatchSqlOwnerAllowed) {
			return this.sqlDeps.dispatchSqlOwnerAllowed(connection, principalFingerprint, revocationGeneration, dispatch);
		}
		await this.sqlDeps?.assertSqlConnectionAllowed?.(connection.id);
		return await dispatch();
	}

	private async dispatchSqlPolicySnapshot<T>(
		dispatch: (snapshot: { connectionIds: readonly string[]; version: number; globallyBlocked: boolean }) => T | PromiseLike<T>,
	): Promise<T> {
		if (this.sqlDeps?.dispatchSqlPolicySnapshot) return this.sqlDeps.dispatchSqlPolicySnapshot(dispatch);
		await this.sqlDeps?.refreshSqlLeaveNoTracePolicy?.();
		return await dispatch({
			connectionIds: this.sqlDeps?.getSqlLeaveNoTraceConnectionIds?.() ?? [],
			version: this.sqlDeps?.getSqlStateVersions?.().policy ?? 0,
			globallyBlocked: false,
		});
	}

	private async dispatchSqlOwnerSnapshot<T>(
		dispatch: NonNullable<CachedValuesSqlDeps['dispatchSqlOwnerSnapshot']> extends (callback: infer C) => Promise<T> ? C : never,
	): Promise<T> {
		if (!this.sqlDeps?.dispatchSqlOwnerSnapshot) throw new Error('Canonical SQL owner snapshot is unavailable.');
		return this.sqlDeps.dispatchSqlOwnerSnapshot(dispatch as any) as Promise<T>;
	}

	private async tryDispatchSqlOwnerSnapshot<T>(dispatch: (snapshot: any) => T | PromiseLike<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
		if (this.sqlDeps?.tryDispatchSqlOwnerSnapshot) return this.sqlDeps.tryDispatchSqlOwnerSnapshot(dispatch);
		return { acquired: true, value: await this.dispatchSqlOwnerSnapshot(dispatch as any) };
	}

	private async retrySqlOwnerSnapshotAcquisition<T>(attempt: () => Promise<{ acquired: true; value: T } | { acquired: false }>): Promise<T> {
		if (this.sqlDeps?.retrySqlOwnerSnapshotAcquisition) return this.sqlDeps.retrySqlOwnerSnapshotAcquisition(attempt);
		const result = await attempt();
		if (!result.acquired) throw new Error('Canonical SQL owner snapshot is contended.');
		return result.value;
	}

	private async buildSnapshot(revision: number, forceSqlUnavailable = false): Promise<Snapshot> {
		let sqlAvailable = !forceSqlUnavailable;
		if (sqlAvailable) {
			try { await this.sqlDeps?.refreshSqlLeaveNoTracePolicy?.(); } catch { sqlAvailable = false; }
		}
		const sqlStateVersions = sqlAvailable ? this.sqlDeps?.getSqlStateVersions?.() : undefined;
		const protectedSqlConnectionIds = new Set(this.sqlDeps?.getSqlLeaveNoTraceConnectionIds?.() ?? []);
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
		const sqlCacheOwners: NonNullable<Snapshot['sqlCacheOwners']> = {};
		const sqlServerAccountMap = sqlAvailable ? this.readSqlServerAccountMap() : {};
		const sqlAuthSessions: Snapshot['sqlAuth']['sessions'] = [];

		// Include SQL server-account map accounts so SQL-only AAD accounts are discovered
		for (const accountId of Object.values(sqlServerAccountMap)) {
			if (accountId && !accountsById.has(accountId)) accountsById.set(accountId, { id: accountId, label: accountId });
		}

		if (sqlAvailable && this.sqlDeps) {
			try {
				const conns = this.sqlDeps.getSqlConnectionManager().getConnections()
					.filter(connection => !protectedSqlConnectionIds.has(connection.id));
				for (const c of conns) {
					sqlConnections.push({ id: c.id, name: c.name, serverUrl: c.serverUrl, authType: c.authType });
				}
			} catch { /* ignore */ }
			for (const connection of this.sqlDeps.getSqlConnectionManager().getConnections()) {
				if (protectedSqlConnectionIds.has(connection.id)) continue;
				const entry = await getOwnedSqlDatabaseCacheEntry(this.context, STORAGE_KEYS.sqlCachedDatabases, connection);
				if (!entry) continue;
				sqlCachedDatabases[connection.id] = [...entry.databases];
				sqlCacheOwners[connection.id] = {
					targetSignature: entry.targetSignature,
					principalFingerprint: entry.principalFingerprint,
				};
			}

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
		const sqlSchemaKeyOwners: NonNullable<Snapshot['sqlSchemaKeyOwners']> = {};
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
		if (sqlAvailable) {
			const sqlSchemaCacheGeneration = await captureSqlSchemaCacheGeneration(globalStorageUri);
			for (const [connId, dbs] of Object.entries(sqlCachedDatabases)) {
				const conn = this.sqlDeps?.getSqlConnectionManager().getConnection(connId);
				if (!conn) continue;
				const principalFingerprint = sqlSchemaPrincipalFingerprint(this.context, conn);
				if (!principalFingerprint) continue;
				const owner = { principalFingerprint, targetSignature: sqlSchemaTargetSignature(conn) };
				for (const db of dbs) {
					const cacheKey = sqlSchemaCacheKey(db, connId, owner);
					if (await readCachedSqlSchemaFromDisk(globalStorageUri, cacheKey, { connectionId: connId, ...owner }, sqlSchemaCacheGeneration)) {
						const key = `sql:${connId}|${db}`;
						cachedSchemaKeys.push(key);
						sqlSchemaKeyOwners[key] = { ...owner };
					}
				}
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
			sqlLeaveNoTrace: sqlAvailable ? [...protectedSqlConnectionIds] : [],
			sqlStateVersions,
			sqlAvailable,
			sqlServerAccountMap,
			cachedSchemaKeys,
			sqlCacheOwners,
			sqlSchemaKeyOwners,
		};
	}

	private async sendSnapshotToWebview(): Promise<void> {
		try {
			const revision = ++this.snapshotRevision;
			let snapshot;
			while (true) {
				snapshot = await this.buildSnapshot(revision);
				let sqlRefreshSucceeded = true;
				try { await this.sqlDeps?.refreshSqlLeaveNoTracePolicy?.(); } catch { sqlRefreshSucceeded = false; }
				if (revision !== this.snapshotRevision) return;
				if (!sqlRefreshSucceeded) {
					snapshot = await this.buildSnapshot(revision, true);
					break;
				}
				if (snapshot.sqlAvailable === false) continue;
				const currentVersions = this.sqlDeps?.getSqlStateVersions?.();
				if (JSON.stringify(currentVersions) === JSON.stringify(snapshot.sqlStateVersions)) break;
			}
			if (snapshot.sqlAvailable === false) {
				await this.connectionManager.runWithLeaveNoTraceSnapshotLock(async kustoPolicy => {
					const protectedClusters = new Set(kustoPolicy.clusterKeys);
					const protectedIds = new Set(snapshot.connections
						.filter(connection => kustoPolicy.globallyBlocked || protectedClusters.has(kustoClusterKey(connection.clusterUrl)))
						.map(connection => connection.id));
					await this.postKustoPublication({
						type: 'snapshot', snapshot: {
							...snapshot,
							connections: snapshot.connections.filter(connection => !protectedIds.has(connection.id)),
							cachedDatabases: Object.fromEntries(Object.entries(snapshot.cachedDatabases)
								.filter(([connectionId]) => !protectedIds.has(connectionId))),
							cachedSchemaKeys: snapshot.cachedSchemaKeys.filter(key => {
								if (!key.startsWith('kusto:')) return true;
								return !protectedIds.has(key.slice(6).split('|', 1)[0]);
							}),
						},
					});
				});
				return;
			}
			await this.retrySqlOwnerSnapshotAcquisition(() => this.connectionManager.runWithLeaveNoTraceSnapshotLock(async kustoPolicy => {
				return this.tryDispatchSqlOwnerSnapshot((canonical: any) => {
				if (revision !== this.snapshotRevision) return;
				const protectedIds = canonical.policy.globallyBlocked
					? new Set<string>((canonical.connections as SqlConnection[]).map(connection => connection.id))
					: new Set<string>(canonical.policy.connectionIds as readonly string[]);
				const protectedServers = new Set((canonical.connections as SqlConnection[])
					.filter(connection => protectedIds.has(connection.id))
					.map(connection => normalizeSqlServerUrl(connection.serverUrl)));
				const canonicalPrincipalById = new Map<string, string>();
				for (const connection of canonical.connections as SqlConnection[]) {
					const authType = String(connection.authType || '').trim().toLowerCase();
					const principal = authType === 'aad'
						? canonical.accountsByServer[normalizeSqlServerUrl(connection.serverUrl)]
						: String(connection.username || '').trim();
					const fingerprint = sqlSchemaPrincipalFingerprintForPrincipal(connection, principal);
					if (fingerprint) canonicalPrincipalById.set(connection.id, fingerprint);
				}
				const ownerMatches = (connectionId: string) => {
					const captured = snapshot.sqlCacheOwners?.[connectionId];
					const current = (canonical.connections as SqlConnection[]).find(connection => connection.id === connectionId);
					return !!captured && !!current
						&& captured.targetSignature === sqlDatabaseTargetSignature(current)
						&& captured.principalFingerprint === canonicalPrincipalById.get(connectionId);
				};
				const { sqlCacheOwners: _sqlCacheOwners, sqlSchemaKeyOwners, ...publicSnapshot } = snapshot;
				const protectedKustoClusters = new Set(kustoPolicy.clusterKeys);
				const protectedKustoIds = new Set(snapshot.connections
					.filter(connection => kustoPolicy.globallyBlocked || protectedKustoClusters.has(kustoClusterKey(connection.clusterUrl)))
					.map(connection => connection.id));
				const admittedSnapshot: Snapshot = {
					...publicSnapshot,
					connections: publicSnapshot.connections.filter(connection => !protectedKustoIds.has(connection.id)),
					cachedDatabases: Object.fromEntries(Object.entries(publicSnapshot.cachedDatabases)
						.filter(([connectionId]) => !protectedKustoIds.has(connectionId))),
					sqlAvailable: snapshot.sqlAvailable && !canonical.policy.globallyBlocked,
					sqlConnections: (canonical.connections as SqlConnection[])
						.filter(connection => !protectedIds.has(connection.id))
						.map(connection => ({ id: connection.id, name: connection.name, serverUrl: connection.serverUrl, authType: connection.authType })),
					sqlCachedDatabases: Object.fromEntries(Object.entries(snapshot.sqlCachedDatabases)
						.filter(([connectionId]) => !protectedIds.has(connectionId) && ownerMatches(connectionId))),
					sqlLeaveNoTrace: [...protectedIds],
					sqlStateVersions: {
						policy: canonical.policy.version,
						connections: canonical.connectionVersion,
						principals: canonical.principalVersion,
					},
					sqlServerAccountMap: Object.fromEntries(Object.entries(canonical.accountsByServer as Record<string, string>)
						.filter(([serverUrl]) => !protectedServers.has(normalizeSqlServerUrl(serverUrl)))),
					cachedSchemaKeys: snapshot.cachedSchemaKeys.filter(key => {
						if (key.startsWith('kusto:')) {
							return !protectedKustoIds.has(key.slice(6).split('|', 1)[0]);
						}
						if (!key.startsWith('sql:')) return true;
						const connectionId = key.slice(4).split('|', 1)[0];
						const capturedOwner = sqlSchemaKeyOwners?.[key];
						const current = (canonical.connections as SqlConnection[]).find(connection => connection.id === connectionId);
						return !protectedIds.has(connectionId) && !!capturedOwner && !!current
							&& capturedOwner.targetSignature === sqlDatabaseTargetSignature(current)
							&& capturedOwner.principalFingerprint === canonicalPrincipalById.get(connectionId);
					}),
				};
				return this.postKustoPublication({ type: 'snapshot', snapshot: admittedSnapshot });
			});
			}));
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
		if (msg.type === 'kustoPublicationAck') {
			const key = `${msg.publicationId}:${msg.phase}`;
			const pending = this.pendingKustoPublicationAcks.get(key);
			if (pending) {
				this.pendingKustoPublicationAcks.delete(key);
				if (pending.timer) clearTimeout(pending.timer);
				pending.resolve(msg.accepted === true);
			}
			return;
		}
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
				this.invalidateKustoOwners([connectionId]);
				await this.connectionCache.clearConnection(connectionId);
				await this.completeKustoMutation();
				return;
			}
			case 'databases.refresh': {
				const connectionId = String(msg.connectionId || '').trim();
				const owner = await this.captureKustoOwner(connectionId);
				if (!owner) return;
				const cachedBefore = this.readCachedDatabases()[connectionId] ?? [];
				try {
					const discovery = await this.kustoClient.getDatabasesWithIdentity(owner.connection, true, {
						traceId: randomUUID(),
						source: 'cached-values-refresh',
						persistCache: false,
					});
					const accountPartition = String(discovery.accountPartition || '').trim();
					const databases = (Array.isArray(discovery.databases) ? discovery.databases : []).map((d) => String(d || '').trim()).filter(Boolean).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
					const admitted = await this.admitKustoOwner(owner, accountPartition, async current => {
						return this.connectionCache.setDatabases(
							current.id, accountPartition, databases,
							discovery.cacheGeneration ?? this.connectionCache.captureGeneration(current.id, accountPartition),
						);
					});
					if (admitted !== true) return;
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
				this.invalidateKustoOwners([]);
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
				const owner = await this.captureKustoOwner(connectionId);
				if (!requestId || !owner || !database || !owner.accountPartition) return;
				const accountPartition = owner.accountPartition;
				let jsonText = '';
				let ok = false;
				try {
					const cached = await readCachedSchemaFromDiskByCluster(
						this.context.globalStorageUri, owner.connection.clusterUrl, database, owner.connection.id, accountPartition,
					);
					if (!this.isKustoOwnerLocallyCurrent(owner, accountPartition)) return;
					if (!cached?.schema) {
						jsonText = JSON.stringify({
							cluster: owner.connection.clusterUrl,
							database,
							error: 'No cached schema was found for this database and account. Refresh the schema and try again.',
						}, null, 2);
						await this.admitKustoOwner(owner, accountPartition, () => {
							if (!this.isKustoOwnerLocallyCurrent(owner, accountPartition)) return false;
							return this.postKustoPublication({
								type: 'schemaResult', requestId, connectionId, accountPartition, database, ok: false, json: jsonText,
							});
						});
						return;
					}
					const schema = cached.schema;
					const tablesCount = schema.tables?.length ?? 0;
					const columnsCount = countColumns(schema);
					const functionsCount = schema.functions?.length ?? 0;
					const cacheAgeMs = Math.max(0, Date.now() - cached.timestamp);
					jsonText = JSON.stringify({ cluster: owner.connection.clusterUrl, database, schema, meta: { cacheAgeMs, tablesCount, columnsCount, functionsCount, timestamp: cached.timestamp } }, null, 2);
					const admitted = await this.admitKustoOwner(owner, accountPartition, () => {
						if (!this.isKustoOwnerLocallyCurrent(owner, accountPartition)) return false;
						return this.postKustoPublication({ type: 'schemaResult', requestId, connectionId, accountPartition, database, ok: true, json: jsonText });
					});
					if (admitted === true) return;
					jsonText = JSON.stringify({ cluster: owner.connection.clusterUrl, database, error: 'No admissible cached schema was found for this database and account.' }, null, 2);
				} catch {
					jsonText = JSON.stringify({ cluster: owner.connection.clusterUrl, database, error: 'Failed to read cached schema from disk.' }, null, 2);
				}
				try { this.panel.webview.postMessage({ type: 'schemaResult', requestId, connectionId, accountPartition, database, ok, json: jsonText }); } catch { /* ignore */ }
				return;
			}
			case 'schema.refresh': {
				const requestId = String(msg.requestId || '').trim();
				const connectionId = String(msg.connectionId || '').trim();
				const database = String(msg.database || '').trim();
				const owner = await this.captureKustoOwner(connectionId);
				if (!requestId || !owner || !database) return;
				try {
					const result = await this.kustoClient.getDatabaseSchema(owner.connection, database, true, {
						persistCache: false, source: 'cached-values-refresh',
					});
					const schema = result.schema;
					const accountPartition = result.accountPartition;
					if (!accountPartition) throw new Error('Schema authentication identity could not be resolved.');
					const admitted = await this.admitKustoOwner(owner, accountPartition, async current => {
						const cacheKey = schemaCacheKey(current.clusterUrl, database, current.id, accountPartition);
						const entry = { schema, timestamp: Date.now(), version: SCHEMA_CACHE_VERSION, clusterUrl: current.clusterUrl, database, connectionId: current.id, accountPartition };
						await writeCachedSchemaToDisk(this.context.globalStorageUri, cacheKey, entry, result.cacheGeneration ?? owner.schemaCacheGeneration);
						const currentSchemaGeneration = captureSchemaCacheGeneration(this.context.globalStorageUri, current.id, accountPartition);
						const expectedSchemaGeneration = result.cacheGeneration ?? owner.schemaCacheGeneration;
						if (currentSchemaGeneration.global !== expectedSchemaGeneration.global
							|| currentSchemaGeneration.connection !== expectedSchemaGeneration.connection
							|| currentSchemaGeneration.partition !== expectedSchemaGeneration.partition) return false;
						if (!this.isKustoOwnerLocallyCurrent(owner, accountPartition)) return false;
						const tablesCount = schema.tables?.length ?? 0;
						const columnsCount = countColumns(schema);
						const functionsCount = schema.functions?.length ?? 0;
						const jsonText = JSON.stringify({ cluster: current.clusterUrl, database, schema, meta: { cacheAgeMs: 0, tablesCount, columnsCount, functionsCount, timestamp: entry.timestamp } }, null, 2);
						return this.postKustoPublication({ type: 'schemaResult', requestId, connectionId, accountPartition, database, ok: true, json: jsonText });
					});
					if (admitted !== true) throw new Error('Kusto schema owner changed during refresh.');
					await this.sendSnapshotToWebview();
					void vscode.window.setStatusBarMessage(`Refreshed schema for ${database}`, 2000);
				} catch (error) {
					const isAuth = this.kustoClient.isAuthenticationError(error);
					const msgText = isAuth
						? 'Failed to refresh schema due to an authentication error. Try running a query first.'
						: 'Failed to refresh schema. Check your connection and try again.';
					void vscode.window.showErrorMessage(msgText);
					try { this.panel.webview.postMessage({ type: 'schemaResult', requestId, connectionId, accountPartition: owner.accountPartition || '', database, ok: false, json: '' }); } catch { /* ignore */ }
				}
				return;
			}

			// ── SQL message handlers ───────────────────────────────────────────

			case 'sqlServerMap.set': {
				const serverUrl = String(msg.serverUrl || '').trim();
				const accountId = String(msg.accountId || '').trim();
				if (!serverUrl || !accountId) return;
				await setSqlServerAccountMapEntry(this.context, serverUrl, accountId);
				const normalizedServer = normalizeSqlServerUrl(serverUrl);
				for (const connection of this.sqlDeps?.getSqlConnectionManager().getConnections() ?? []) {
					if (normalizeSqlServerUrl(connection.serverUrl) === normalizedServer) {
						await setSqlDatabaseCacheConnectionIdentity(this.context, STORAGE_KEYS.sqlCachedDatabases, connection);
					}
				}
				return;
			}
			case 'sqlServerMap.delete': {
				const serverUrl = String(msg.serverUrl || '').trim();
				if (!serverUrl) return;
				await deleteSqlServerAccountMapEntry(this.context, serverUrl);
				const normalizedServer = normalizeSqlServerUrl(serverUrl);
				for (const connection of this.sqlDeps?.getSqlConnectionManager().getConnections() ?? []) {
					if (normalizeSqlServerUrl(connection.serverUrl) === normalizedServer) {
						await setSqlDatabaseCacheConnectionIdentity(this.context, STORAGE_KEYS.sqlCachedDatabases, connection);
					}
				}
				return;
			}
			case 'sqlDatabases.delete': {
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) return;
				await deleteSqlDatabaseCacheEntry(this.context, STORAGE_KEYS.sqlCachedDatabases, connectionId);
				return;
			}
			case 'sqlDatabases.refresh': {
				if (!this.sqlDeps) return;
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) return;
				let connection: SqlConnection | undefined;
				try { connection = this.sqlDeps.getSqlConnectionManager().getConnections().find(c => c.id === connectionId); } catch { connection = undefined; }
				if (!connection) { void vscode.window.showErrorMessage('SQL connection not found.'); return; }
				const startingPrincipal = sqlSchemaPrincipalFingerprint(this.context, connection);
				const revocationGeneration = this.sqlDeps.getSqlRevocationGeneration?.(connection.id) ?? 0;
				try {
					const cacheRequest = await beginSqlDatabaseCacheRequest(this.context, STORAGE_KEYS.sqlCachedDatabases, connection);
					await this.sqlDeps.assertSqlConnectionAllowed?.(connection.id);
					const databases = await this.sqlDeps.getSqlClient().getDatabases(connection, { signal: this.sqlPanelAbortController?.signal });
					const principalFingerprint = await this.resolveCurrentSqlPrincipal(connection, revocationGeneration, startingPrincipal);
					const sorted = (Array.isArray(databases) ? databases : []).map(d => String(d || '').trim()).filter(Boolean).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
					await writeOwnedSqlDatabaseCacheEntry(
						this.context,
						STORAGE_KEYS.sqlCachedDatabases,
						connection,
						principalFingerprint,
						sorted,
						cacheRequest,
						() => this.resolveCurrentSqlPrincipal(connection, revocationGeneration, principalFingerprint).then(() => undefined),
					);
				} catch {
					void vscode.window.showErrorMessage('Failed to refresh the SQL database list. Check your connection and try again.');
				}
				return;
			}
			case 'sqlSchema.get': {
				const requestId = String(msg.requestId || '').trim();
				const requestedServerUrl = String(msg.serverUrl || '').trim();
				const database = String(msg.database || '').trim();
				const connectionId = String(msg.connectionId || '').trim();
				if (!requestId || !requestedServerUrl || !database || !connectionId) return;
				const currentConnection = this.sqlDeps?.getSqlConnectionManager().getConnection(connectionId);
				const connection = currentConnection ? { ...currentConnection } : undefined;
				const principalFingerprint = connection ? sqlSchemaPrincipalFingerprint(this.context, connection) : undefined;
				const revocationGeneration = connection ? this.sqlDeps?.getSqlRevocationGeneration?.(connection.id) ?? 0 : 0;
				if (!connection || !principalFingerprint) {
					this.panel.webview.postMessage({
						type: 'schemaResult', requestId, connectionId,
						clusterKey: connection?.serverUrl || requestedServerUrl, database, ok: false,
						json: JSON.stringify({ server: connection?.serverUrl || requestedServerUrl, database, error: 'SQL schema identity is unavailable.' }, null, 2),
					});
					return;
				}
				const serverUrl = connection.serverUrl;
				const owner = { principalFingerprint, targetSignature: sqlSchemaTargetSignature(connection), revocationGeneration };
				try { await this.assertCurrentSqlSchemaOwner(connection, owner); } catch {
					this.panel.webview.postMessage({ type: 'schemaResult', requestId, connectionId, clusterKey: serverUrl, database, ok: false, json: JSON.stringify({ server: serverUrl, database, error: 'Leave No Trace blocks cached SQL schema access.' }, null, 2) });
					return;
				}
				const cacheKey = sqlSchemaCacheKey(database, connectionId, owner);
				const cacheGeneration = await captureSqlSchemaCacheGeneration(this.context.globalStorageUri);
				let jsonText = '';
				let ok = false;
				try {
					const cached = await readCachedSqlSchemaFromDisk(this.context.globalStorageUri, cacheKey, { connectionId, ...owner }, cacheGeneration);
					if (!cached?.schema) {
						jsonText = JSON.stringify({ server: serverUrl, database, error: 'No cached schema was found for this database. Run a query or open the database in a SQL section to cache the schema, then try again.' }, null, 2);
						ok = false;
					} else {
						await this.assertCurrentSqlSchemaOwner(connection, owner);
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
				try {
					await this.assertCurrentSqlSchemaOwner(connection, owner);
					if (ok) {
						await this.dispatchSqlAllowed(connection, owner.principalFingerprint, owner.revocationGeneration, () => {
							const current = this.sqlDeps?.getSqlConnectionManager().getConnection(connectionId);
							if (!current || sqlSchemaTargetSignature(current) !== owner.targetSignature) return;
							return this.panel.webview.postMessage({ type: 'schemaResult', requestId, connectionId, clusterKey: serverUrl, database, ok, json: jsonText });
						});
					} else {
						this.panel.webview.postMessage({ type: 'schemaResult', requestId, connectionId, clusterKey: serverUrl, database, ok, json: jsonText });
					}
				} catch {
					this.panel.webview.postMessage({
						type: 'schemaResult', requestId, connectionId, clusterKey: serverUrl, database, ok: false,
						json: JSON.stringify({ server: serverUrl, database, error: 'SQL schema owner changed before response admission.' }, null, 2),
					});
				}
				return;
			}
			case 'sqlSchema.refresh': {
				const requestId = String(msg.requestId || '').trim();
				if (!this.sqlDeps) return;
				const requestedServerUrl = String(msg.serverUrl || '').trim();
				const database = String(msg.database || '').trim();
				const connectionId = String(msg.connectionId || '').trim();
				if (!requestId || !requestedServerUrl || !database || !connectionId) return;
				let currentConnection: SqlConnection | undefined;
				try { currentConnection = this.sqlDeps.getSqlConnectionManager().getConnection(connectionId); } catch { currentConnection = undefined; }
				const connection = currentConnection ? { ...currentConnection } : undefined;
				if (!connection) {
					this.panel.webview.postMessage({
						type: 'schemaResult', requestId, connectionId, clusterKey: requestedServerUrl, database, ok: false,
						json: JSON.stringify({ server: requestedServerUrl, database, error: 'SQL connection not found.' }, null, 2),
					});
					return;
				}
				const revocationGeneration = this.sqlDeps.getSqlRevocationGeneration?.(connection.id) ?? 0;
				try {
					const principalFingerprint = sqlSchemaPrincipalFingerprint(this.context, connection);
					if (!principalFingerprint) throw new Error('SQL schema identity is unavailable.');
					const targetSignature = sqlSchemaTargetSignature(connection);
					const owner = { principalFingerprint, targetSignature, revocationGeneration };
					await this.assertCurrentSqlSchemaOwner(connection, owner);
					const cacheGeneration = await captureSqlSchemaCacheGeneration(this.context.globalStorageUri);
					const schema = await this.sqlDeps.getSqlClient().getDatabaseSchema(connection, database, { signal: this.sqlPanelAbortController?.signal });
					await this.assertCurrentSqlSchemaOwner(connection, owner);
					// Write to disk cache with version
					const cacheKey = sqlSchemaCacheKey(database, connectionId, owner);
					const entry = {
						schema,
						timestamp: Date.now(),
						version: SQL_SCHEMA_CACHE_VERSION,
						serverUrl: connection.serverUrl,
						database,
						connectionId,
						principalFingerprint,
						targetSignature,
						cacheGeneration,
					};
					const dir = getSqlSchemaCacheDirUri(this.context.globalStorageUri);
					try { await vscode.workspace.fs.createDirectory(dir); } catch { /* ignore */ }
					const hash = (await import('crypto')).createHash('sha1').update(cacheKey, 'utf8').digest('hex');
					const fileUri = vscode.Uri.joinPath(dir, `${hash}.json`);
					const tempUri = vscode.Uri.joinPath(dir, `${hash}.${process.pid}.${Date.now()}.tmp`);
					let published = false;
					try {
						await vscode.workspace.fs.writeFile(tempUri, Buffer.from(JSON.stringify(entry), 'utf8'));
						published = await publishSqlSchemaCacheFile(
							this.context.globalStorageUri,
							cacheGeneration,
							tempUri,
							fileUri,
							() => this.assertCurrentSqlSchemaOwner(connection, owner).then(() => undefined),
						);
						if (!published) throw new Error('SQL schema cache was cleared while the refresh was running.');
					} catch (error) {
						try { await vscode.workspace.fs.delete(published ? fileUri : tempUri, { useTrash: false }); } catch { /* ignore */ }
						throw error;
					}
					// Send freshly-fetched schema to the viewer
					const tablesCount = schema.tables?.length ?? 0;
					const viewsCount = schema.views?.length ?? 0;
					const procsCount = schema.storedProcedures?.length ?? 0;
					const jsonText = JSON.stringify({ server: connection.serverUrl, database, schema, meta: { cacheAgeMs: 0, tablesCount, viewsCount, procsCount, timestamp: entry.timestamp } }, null, 2);
					await this.assertCurrentSqlSchemaOwner(connection, owner);
					await this.dispatchSqlAllowed(connection, owner.principalFingerprint, owner.revocationGeneration, () => {
						const current = this.sqlDeps?.getSqlConnectionManager().getConnection(connectionId);
						if (!current || sqlSchemaTargetSignature(current) !== owner.targetSignature) return;
						return this.panel.webview.postMessage({ type: 'schemaResult', requestId, connectionId, clusterKey: connection.serverUrl, database, ok: true, json: jsonText });
					});
					void vscode.window.setStatusBarMessage(`Refreshed SQL schema for ${database}`, 2000);
				} catch (error) {
					this.panel.webview.postMessage({
						type: 'schemaResult', requestId, connectionId, clusterKey: connection.serverUrl, database, ok: false,
						json: JSON.stringify({ server: connection.serverUrl, database, error: 'Failed to refresh SQL schema.' }, null, 2),
					});
					void vscode.window.showErrorMessage('Failed to refresh SQL schema. Check your connection and try again.');
				}
				return;
			}
			case 'sqlSchema.clearAll': {
				try {
					await clearSqlDatabaseCacheStore(this.context, STORAGE_KEYS.sqlCachedDatabases);
					await clearSqlSchemaCacheFiles(this.context.globalStorageUri, getSqlSchemaCacheDirUri(this.context.globalStorageUri));
					void vscode.window.setStatusBarMessage('Cleared cached SQL schema data', 2000);
				} catch {
					void vscode.window.showErrorMessage('Failed to delete all SQL schema cache files. Remaining files have been invalidated and will not be reused.');
				}
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
