import { ConnectionManager, KustoConnection } from './connectionManager';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import {
	formatCellValue,
	isLikelyCancellationError as isLikelyCancellationErrorFn,
	isAuthError as isAuthErrorFn,
	extractSchemaFromJson as extractSchemaFromJsonFn,
	finalizeSchema as finalizeSchemeFn,
	parseDatabaseSchemaResultWithRaw as parseDatabaseSchemaResultWithRawFn
} from './kustoClientUtils';
import { exportKustoClusterEndpoint } from '../shared/kustoClusterUrls';
import { getWorkbenchLogger, type WorkbenchLogger } from './workbenchLogger';
import {
	getKustoAuthScopes,
	getKustoConnectionIdentityKey,
	KUSTO_AUTH_PROVIDER_ID,
	normalizeKustoAuthorityId,
} from '../shared/kustoAuth';
import { KustoAuthPreferenceService, type KustoAccountPreference } from './kustoAuthPreferenceService';
import { KustoConnectionCache, type KustoConnectionCacheGeneration } from './kustoConnectionCache';
import { captureSchemaCacheGeneration, deleteCachedSchemasForAccountPartitions, deleteCachedSchemasForConnections, type SchemaCacheGeneration } from './schemaCache';
import {
	createDatabaseListTraceId,
	databaseListTraceRef,
	getDatabaseListErrorDetails,
	traceDatabaseList,
} from './databaseListTrace';

type DatabaseDiscoveryOptions = {
	allowInteractive?: boolean;
	traceId?: string;
	source?: string;
	persistIdentity?: boolean;
};

export type SchemaDiscoveryOptions = {
	allowInteractive?: boolean;
	traceId?: string;
	source?: string;
};

/**
 * Server-side resource usage statistics extracted from the Kusto response.
 * All fields are optional because different cluster versions / configurations
 * may omit some of them. Extraction is always best-effort.
 */
export interface ServerQueryStats {
	/** Server-reported total CPU time, e.g. "00:00:00.1406250" */
	cpuTime?: string;
	/** Server-reported total CPU time in milliseconds (parsed from cpuTime) */
	cpuTimeMs?: number;
	/** Peak memory per node in bytes */
	peakMemoryPerNode?: number;
	/** Total extents (shards) in the input dataset */
	extentsTotal?: number;
	/** Number of extents actually scanned */
	extentsScanned?: number;
	/** Memory cache hits */
	memoryCacheHits?: number;
	/** Memory cache misses */
	memoryCacheMisses?: number;
	/** Disk cache hits */
	diskCacheHits?: number;
	/** Disk cache misses */
	diskCacheMisses?: number;
	/** Shard hot cache hit bytes */
	shardHotHitBytes?: number;
	/** Shard hot cache miss bytes */
	shardHotMissBytes?: number;
	/** Server-side execution time in seconds (from the Payload JSON) */
	serverExecutionTimeSec?: number;
	/** Total rows returned as reported by the server */
	serverRowCount?: number;
	/** Total table size in bytes as reported by the server */
	serverTableSize?: number;
	/** The full raw resource_usage object for advanced inspection */
	raw?: Record<string, unknown>;
}

export interface QueryResult {
	columns: Array<string | { name: string; type: string }>;
	rows: any[][];
	metadata: {
		cluster: string;
		database: string;
		executionTime: string;
		clientActivityId?: string;
		serverStats?: ServerQueryStats;
	};
}

export interface QueryResultWithIdentity {
	result: QueryResult;
	accountPartition?: string;
}

export interface CancelableQueryExecution {
	promise: Promise<QueryResult>;
	cancel: () => void;
	clientActivityId: string;
	getAccountPartition: () => string | undefined;
}

export interface DatabaseSchemaIndex {
	tables: string[];
	/**
	 * Column type information (best-effort) keyed by table and then column name.
	 * This is also the source of truth for which columns exist.
	 */
	columnTypesByTable: Record<string, Record<string, string>>;
	/**
	 * Optional docstrings for tables, keyed by table name.
	 */
	tableDocStrings?: Record<string, string>;
	/**
	 * Optional folder paths for tables, keyed by table name.
	 */
	tableFolders?: Record<string, string>;
	/**
	 * Optional docstrings for columns, keyed by "TableName.ColumnName".
	 */
	columnDocStrings?: Record<string, string>;
	/**
	 * Optional list of database-scoped (user-defined) functions.
	 * Populated best-effort; schema loading should still succeed even if this fails.
	 */
	functions?: KustoFunctionInfo[];
	/**
	 * Raw JSON output from `.show database schema as json` command.
	 * This is passed to monaco-kusto's setSchemaFromShowSchema API for full language support.
	 */
	rawSchemaJson?: unknown;
}

export type KustoFunctionParameter = {
	name: string;
	type?: string;
	defaultValue?: string;
	raw?: string;
};

export type KustoFunctionInfo = {
	name: string;
	parametersText?: string;
	parameters?: KustoFunctionParameter[];
	docString?: string;
	folder?: string;
	/**
	 * The KQL body of the function.
	 */
	body?: string;
};

export interface DatabaseSchemaResult {
	schema: DatabaseSchemaIndex;
	fromCache: boolean;
	accountPartition?: string;
	cacheGeneration?: SchemaCacheGeneration;
	cacheAgeMs?: number;
	debug?: {
		commandUsed?: string;
		primaryColumns?: string[];
		sampleRowType?: string;
		sampleRowKeys?: string[];
		sampleRowPreview?: string;
	};
}

export interface KustoDatabaseDiscoveryResult {
	databases: string[];
	accountPartition?: string;
	cacheGeneration?: KustoConnectionCacheGeneration;
	fromCache: boolean;
}

export class QueryCancelledError extends Error {
	readonly isCancelled = true;
	constructor(message: string = 'Query cancelled') {
		super(message);
		this.name = 'QueryCancelledError';
	}
}

export class QueryExecutionError extends Error {
	readonly clientActivityId?: string;
	constructor(message: string, clientActivityId?: string) {
		super(message);
		this.name = 'QueryExecutionError';
		this.clientActivityId = clientActivityId;
	}
}

type SessionPromptMode = 'default' | 'clearPreference' | 'forceNewSession';

export type KustoAuthContext = Readonly<{
	connectionId: string;
	connectionIdentityKey: string;
	clusterEndpoint: string;
	authorityId?: string;
	scopes: readonly string[];
	account: vscode.AuthenticationSessionAccountInformation;
	accountId: string;
	accountPartition: string;
	preferenceMode: KustoAccountPreference['mode'];
}>;

type CachedClientEntry = {
	client: any;
	auth: KustoAuthContext;
};

type AuthOperationOptions<T> = {
	allowInteractive?: boolean;
	cancelableKey?: string;
	onClient?: (client: any, auth: KustoAuthContext) => void;
	traceId?: string;
	operationName?: string;
	isSuccessfulResult?: (result: T) => boolean;
	persistAuthSuccess?: boolean;
};

export class KustoQueryClient {
	private clients: Map<string, CachedClientEntry> = new Map();
	// Dedicated clients used for cancelable query execution. Keyed by box/run context to
	// (a) support cancellation without impacting other editors, and (b) improve server-side
	// query results cache hit rate by reusing the same underlying HTTP session.
	// IMPORTANT: The key must include connection identity (e.g. boxId + connection.id).
	// Otherwise switching clusters in the same box would reuse the previous cluster's client.
	private cancelableClientsByKey: Map<string, CachedClientEntry> = new Map();
	private databaseCache: Map<string, { databases: string[], timestamp: number }> = new Map();
	private schemaCache: Map<string, { schema: DatabaseSchemaIndex; timestamp: number }> = new Map();
	private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
	private readonly SCHEMA_CACHE_TTL = 24 * 60 * 60 * 1000; // 1 day

	private static readonly STORAGE_KEYS = {
		/** Global epoch used to invalidate in-memory caches across extension instances. */
		cacheClearEpoch: 'kusto.cacheClearEpoch'
	} as const;

	// If the user cancels the VS Code authentication prompt, multiple concurrent/queued
	// requests (e.g. loading databases + schema) can otherwise prompt back-to-back.
	// We suppress additional interactive prompts for a short window.
	private static readonly AUTH_CANCEL_SUPPRESS_MS = 2500;

	private readonly context?: vscode.ExtensionContext;
	private readonly output: WorkbenchLogger;
	private readonly authLocksByIdentity = new Map<string, Promise<void>>();
	private readonly authCancelledAtByIdentity = new Map<string, number>();
	private readonly authPreferences?: KustoAuthPreferenceService;
	private readonly connectionCache?: KustoConnectionCache;
	private readonly subscriptions: vscode.Disposable[] = [];
	private readonly connectionRevisions = new Map<string, number>();
	private readonly accountRevisions = new Map<string, number>();
	private readonly authContextByClient = new WeakMap<object, KustoAuthContext>();
	private readonly transientPreferences = new Map<string, KustoAccountPreference>();
	private authRevision = 0;
	private lastSeenCacheClearEpoch = 0;
	private disposed = false;

	constructor(context?: vscode.ExtensionContext, output?: WorkbenchLogger, connectionManager?: ConnectionManager) {
		this.context = context;
		this.output = output ?? getWorkbenchLogger();
		if (context) {
			this.authPreferences = KustoAuthPreferenceService.getInstance(context);
			this.connectionCache = new KustoConnectionCache(context);
			this.subscriptions.push(this.authPreferences.onDidChange(change => {
				if (change.connectionIds.length > 0) {
					for (const connectionId of change.connectionIds) this.bumpConnectionRevision(connectionId);
				}
				if (change.reason === 'account-forgotten' && change.accountId) {
					this.bumpAccountRevision(change.accountId);
				} else if (change.connectionIds.length === 0) {
					this.authRevision++;
				}
				this.invalidateClients(change.connectionIds, change.accountId);
				if (change.reason === 'override' && change.accountPartition) {
					void this.connectionCache?.clearAccountPartition(change.accountPartition);
					if (this.context) void deleteCachedSchemasForAccountPartitions(this.context.globalStorageUri, new Set([change.accountPartition]));
				}
			}));
		}
		if (connectionManager) {
			this.subscriptions.push(connectionManager.onDidChangeConnections(change => {
				const ids = change.type === 'cleared'
					? change.connections.map(connection => connection.id)
					: change.type === 'updated'
						? [change.previous.id, change.connection.id]
						: [change.connection.id];
				for (const id of ids) this.bumpConnectionRevision(id);
				this.invalidateClients(ids);
				for (const id of ids) void this.connectionCache?.clearConnection(id);
				if (context) void deleteCachedSchemasForConnections(context.globalStorageUri, new Set(ids));
				if (change.type === 'removed') void this.authPreferences?.removeConnection(change.connection.id);
				if (change.type === 'cleared') {
					for (const connection of change.connections) void this.authPreferences?.removeConnection(connection.id);
				}
			}));
			void this.authPreferences?.migrateLegacyMappings(connectionManager.getConnections());
			void this.connectionCache?.migrateLegacy(connectionManager.getConnections());
		}
	}

	private static readonly APPLICATION_NAME = 'KustoWorkbench';

	private getConnectionRevision(connectionId: string): number {
		return this.connectionRevisions.get(connectionId) ?? 0;
	}

	private bumpConnectionRevision(connectionId: string): void {
		const id = String(connectionId || '').trim();
		if (id) this.connectionRevisions.set(id, this.getConnectionRevision(id) + 1);
	}

	private getAccountRevision(accountId: string): number {
		return this.accountRevisions.get(String(accountId || '').trim()) ?? 0;
	}

	private bumpAccountRevision(accountId: string): void {
		const id = String(accountId || '').trim();
		if (id) this.accountRevisions.set(id, this.getAccountRevision(id) + 1);
	}

	private connectionIdentityKey(connection: KustoConnection): string {
		return getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId);
	}

	private dataCachePrefix(connection: KustoConnection, accountPartition: string): string {
		return `${encodeURIComponent(connection.id)}|${this.connectionIdentityKey(connection)}|${accountPartition}`;
	}

	private databaseCacheKey(connection: KustoConnection, accountPartition: string): string {
		return this.dataCachePrefix(connection, accountPartition);
	}

	private schemaCacheKey(connection: KustoConnection, accountPartition: string, database: string): string {
		return `${this.dataCachePrefix(connection, accountPartition)}|${String(database || '').trim().toLowerCase()}`;
	}

	private authLockKey(connection: KustoConnection, preference: KustoAccountPreference): string {
		const account = preference.mode === 'explicit'
			? preference.accountId
			: preference.lastSuccessfulAccountId ?? preference.legacyAccountId ?? '';
		return `${encodeURIComponent(connection.id)}|${this.connectionIdentityKey(connection)}|${preference.mode}|${account}`;
	}

	private cancelableCacheKey(connection: KustoConnection, callerKey: string, preference: KustoAccountPreference): string {
		return `${this.authLockKey(connection, preference)}|${callerKey}`;
	}

	private isEntryCompatible(entry: CachedClientEntry | undefined, connection: KustoConnection, preference: KustoAccountPreference): boolean {
		if (!entry || entry.auth.connectionIdentityKey !== this.connectionIdentityKey(connection)) return false;
		if (preference.mode === 'explicit') return entry.auth.accountId === preference.accountId;
		const preferred = preference.lastSuccessfulAccountId ?? preference.legacyAccountId;
		return !preferred || entry.auth.accountId === preferred;
	}

	private closeEntry(entry: CachedClientEntry | undefined): void {
		try { entry?.client?.close?.(); } catch { /* ignore */ }
	}

	private invalidateClients(connectionIds: readonly string[], accountId?: string): void {
		const ids = new Set(connectionIds.map(id => String(id || '').trim()).filter(Boolean));
		for (const [key, entry] of [...this.clients]) {
			if ((ids.size === 0 && (!accountId || entry.auth.accountId === accountId)) || ids.has(entry.auth.connectionId)) {
				this.clients.delete(key);
				this.closeEntry(entry);
			}
		}
		for (const [key, entry] of [...this.cancelableClientsByKey]) {
			if ((ids.size === 0 && (!accountId || entry.auth.accountId === accountId)) || ids.has(entry.auth.connectionId)) {
				this.cancelableClientsByKey.delete(key);
				this.closeEntry(entry);
			}
		}
		if (ids.size === 0) {
			this.databaseCache.clear();
			this.schemaCache.clear();
			return;
		}
		for (const key of [...this.databaseCache.keys()]) {
			if ([...ids].some(id => key.startsWith(`${encodeURIComponent(id)}|`))) this.databaseCache.delete(key);
		}
		for (const key of [...this.schemaCache.keys()]) {
			if ([...ids].some(id => key.startsWith(`${encodeURIComponent(id)}|`))) this.schemaCache.delete(key);
		}
	}

	private traceDatabaseDiscovery(traceId: string | undefined, event: string, details: Record<string, unknown> = {}): void {
		traceDatabaseList(this.output, traceId, '', event, details);
	}

	/**
	 * Creates a {@link ClientRequestProperties} with the `Application` and `ClientActivityId` headers set.
	 * @param activityPrefix Short label for the operation, e.g. `execute_query` or `get_databases`.
	 * @param clientTimeoutMs Optional client-side HTTP timeout in milliseconds. When set, the SDK
	 *   keeps the HTTP connection open for this long without altering the server-side timeout.
	 */
	private async createRequestProperties(activityPrefix: string, clientTimeoutMs?: number, clientRequestId?: string): Promise<any> {
		const { ClientRequestProperties } = await import('azure-kusto-data');
		const props = new ClientRequestProperties();
		props.clientRequestId = clientRequestId || `KW.${activityPrefix};${randomUUID()}`;
		props.application = KustoQueryClient.APPLICATION_NAME;
		if (clientTimeoutMs && clientTimeoutMs > 0) {
			props.setClientTimeout(clientTimeoutMs);
		}
		return props;
	}

	private static quoteKustoStringLiteral(value: string): string {
		return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	}

	private async cancelQueryByClientActivityId(
		connection: KustoConnection,
		database: string,
		clientActivityId: string,
		reason: string = 'Canceled from Kusto Workbench',
		capturedAuth?: KustoAuthContext,
	): Promise<void> {
		const id = String(clientActivityId || '').trim();
		if (!id) {
			return;
		}
		const command = `.cancel query ${KustoQueryClient.quoteKustoStringLiteral(id)} with (reason = ${KustoQueryClient.quoteKustoStringLiteral(reason)})`;
		const props = await this.createRequestProperties('cancel_query');
		if (capturedAuth) {
			const capturedConnection: KustoConnection = {
				...connection,
				id: capturedAuth.connectionId,
				clusterUrl: capturedAuth.clusterEndpoint,
				authorityId: capturedAuth.authorityId,
			};
			const exactPreference: KustoAccountPreference = { mode: 'explicit', accountId: capturedAuth.accountId };
			const requested = await this.requestSession(capturedConnection, exactPreference, capturedAuth.account, {
				interactiveIfNeeded: false,
			});
			if (!requested.session) {
				throw new Error('The Microsoft account used by the running query is no longer available for cancellation.');
			}
			const entry = await this.createClientEntry(capturedConnection, requested.session, exactPreference);
			try {
				await entry.client.execute(database, command, props);
			} finally {
				this.closeEntry(entry);
			}
			return;
		}
		await this.executeWithAuthRetry<any>(
			connection,
			(client) => client.execute(database, command, props),
			{ allowInteractive: false }
		);
	}

	/**
	 * Extracts the Client Activity ID from a Kusto response's status table.
	 * Works with both V1 (column: `ClientActivityId`) and V2 (column: `ClientRequestId`) responses.
	 */
	private extractClientActivityId(result: any): string | undefined {
		try {
			const statusTable = result?.statusTable;
			if (!statusTable || !statusTable._rows || statusTable._rows.length === 0) {
				return undefined;
			}
			// The response object exposes getCridColumn() which returns the correct column name
			// for the protocol version (V1: "ClientActivityId", V2: "ClientRequestId").
			// However, we access the result generically, so try both column names.
			for (const row of statusTable.rows()) {
				const id = row?.['ClientActivityId'] ?? row?.['ClientRequestId'];
				if (typeof id === 'string' && id.trim()) {
					return id.trim();
				}
			}
		} catch {
			// Extraction is best-effort; never let it break query execution.
		}
		return undefined;
	}

	/**
	 * Parses a Kusto timespan string like "00:00:01.1406250" into milliseconds.
	 * Returns undefined if the string is not parseable.
	 */
	private static parseKustoTimespan(ts: string | undefined): number | undefined {
		if (!ts || typeof ts !== 'string') {
			return undefined;
		}
		// Format: [d.]hh:mm:ss[.fffffff]
		const m = ts.match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/);
		if (!m) {
			return undefined;
		}
		const days = m[1] ? parseInt(m[1], 10) : 0;
		const hours = parseInt(m[2], 10);
		const minutes = parseInt(m[3], 10);
		const seconds = parseFloat(m[4]);
		return ((days * 86400 + hours * 3600 + minutes * 60 + seconds) * 1000);
	}

	/**
	 * Extracts server-side resource usage statistics from the Kusto response.
	 * Works with V2 responses where the statusTable rows have a `Payload` column
	 * containing a JSON string with `resource_usage`, `dataset_statistics`, and
	 * `input_dataset_statistics`.
	 * Also handles V1 responses where the status column is `StatusDescription`.
	 */
	private extractServerStats(result: any): ServerQueryStats | undefined {
		try {
			const statusTable = result?.statusTable;
			if (!statusTable || !statusTable._rows || statusTable._rows.length === 0) {
				return undefined;
			}

			// Look for a row whose Payload (V2) or StatusDescription (V1) contains
			// resource_usage information.
			for (const row of statusTable.rows()) {
				const payloadRaw = row?.['Payload'] ?? row?.['StatusDescription'];
				if (!payloadRaw) {
					continue;
				}

				let payload: any;
				if (typeof payloadRaw === 'string') {
					try {
						payload = JSON.parse(payloadRaw);
					} catch {
						continue;
					}
				} else if (typeof payloadRaw === 'object') {
					payload = payloadRaw;
				} else {
					continue;
				}

				const ru = payload?.resource_usage;
				if (!ru) {
					continue;
				}

				const stats: ServerQueryStats = {};

				// CPU
				const cpuStr = ru?.cpu?.['total cpu'] ?? ru?.cpu?.total_cpu;
				if (typeof cpuStr === 'string') {
					stats.cpuTime = cpuStr;
					stats.cpuTimeMs = KustoQueryClient.parseKustoTimespan(cpuStr);
				}

				// Memory
				const peakMem = ru?.memory?.peak_per_node;
				if (typeof peakMem === 'number' && isFinite(peakMem)) {
					stats.peakMemoryPerNode = peakMem;
				}

				// Cache
				const memCache = ru?.cache?.memory;
				if (memCache) {
					if (typeof memCache.hits === 'number') { stats.memoryCacheHits = memCache.hits; }
					if (typeof memCache.misses === 'number') { stats.memoryCacheMisses = memCache.misses; }
				}
				const diskCache = ru?.cache?.disk;
				if (diskCache) {
					if (typeof diskCache.hits === 'number') { stats.diskCacheHits = diskCache.hits; }
					if (typeof diskCache.misses === 'number') { stats.diskCacheMisses = diskCache.misses; }
				}
				const shardHot = ru?.cache?.shards?.hot;
				if (shardHot) {
					if (typeof shardHot.hitbytes === 'number') { stats.shardHotHitBytes = shardHot.hitbytes; }
					if (typeof shardHot.missbytes === 'number') { stats.shardHotMissBytes = shardHot.missbytes; }
				}

				// Extents
				const extents = payload?.input_dataset_statistics?.extents;
				if (extents) {
					if (typeof extents.total === 'number') { stats.extentsTotal = extents.total; }
					if (typeof extents.scanned === 'number') { stats.extentsScanned = extents.scanned; }
				}

				// Server execution time
				if (typeof payload.ExecutionTime === 'number') {
					stats.serverExecutionTimeSec = payload.ExecutionTime;
				}

				// Dataset statistics
				const ds = payload?.dataset_statistics;
				if (Array.isArray(ds) && ds.length > 0) {
					if (typeof ds[0].table_row_count === 'number') { stats.serverRowCount = ds[0].table_row_count; }
					if (typeof ds[0].table_size === 'number') { stats.serverTableSize = ds[0].table_size; }
				}

				// Keep the raw object for advanced users
				stats.raw = ru;

				return stats;
			}
		} catch {
			// Extraction is best-effort; never let it break query execution.
		}
		return undefined;
	}

	private syncCacheClearEpoch(): void {
		if (!this.context) {
			return;
		}
		try {
			const epoch = this.context.globalState.get<number>(KustoQueryClient.STORAGE_KEYS.cacheClearEpoch) ?? 0;
			const next = typeof epoch === 'number' && isFinite(epoch) ? epoch : 0;
			if (next && next !== this.lastSeenCacheClearEpoch) {
				this.lastSeenCacheClearEpoch = next;
				this.databaseCache.clear();
				this.schemaCache.clear();
			}
		} catch {
			// ignore
		}
	}

	private getPreference(connection: KustoConnection): KustoAccountPreference {
		return this.transientPreferences.get(connection.id)
			?? this.authPreferences?.getPreference(connection.id)
			?? { mode: 'automatic' };
	}

	public async withTransientAuthPreference<T>(
		connection: KustoConnection,
		preference: KustoAccountPreference,
		operation: () => Promise<T>,
	): Promise<T> {
		if (this.transientPreferences.has(connection.id)) {
			throw new Error('A transient authentication operation is already running for this connection.');
		}
		this.transientPreferences.set(connection.id, preference);
		try {
			return await operation();
		} finally {
			this.transientPreferences.delete(connection.id);
			this.invalidateClients([connection.id]);
			await this.connectionCache?.clearConnection(connection.id);
		}
	}

	private async getEffectiveAccessToken(
		session: vscode.AuthenticationSession,
		authorityId: string | undefined,
		traceId?: string,
	): Promise<string> {
		const token = String(session?.accessToken || '');
		if (!this.authPreferences) {
			this.traceDatabaseDiscovery(traceId, 'auth.token.selected', {
				accountRef: databaseListTraceRef(session?.account?.id),
				source: 'vscode-session',
				tokenPresent: !!token,
			});
			return token;
		}
		try {
			const override = await this.authPreferences.getTokenOverride(authorityId, session.account.id);
			const trimmed = String(override || '').trim();
			this.traceDatabaseDiscovery(traceId, 'auth.token.selected', {
				accountRef: databaseListTraceRef(session.account.id),
				source: trimmed ? 'secret-override' : 'vscode-session',
				tokenPresent: !!(trimmed || token),
			});
			return trimmed ? trimmed : token;
		} catch (error) {
			this.traceDatabaseDiscovery(traceId, 'auth.token.override-read-failed', {
				accountRef: databaseListTraceRef(session?.account?.id),
				...getDatabaseListErrorDetails(error),
			});
			return token;
		}
	}

	private buildAuthContext(
		connection: KustoConnection,
		session: vscode.AuthenticationSession,
		preference: KustoAccountPreference,
	): KustoAuthContext {
		const authorityId = normalizeKustoAuthorityId(connection.authorityId);
		const accountId = String(session.account.id || '').trim();
		const accountPartition = this.authPreferences?.getAccountPartition(authorityId, accountId)
			?? `ephemeral:${accountId}`;
		return Object.freeze({
			connectionId: connection.id,
			connectionIdentityKey: this.connectionIdentityKey(connection),
			clusterEndpoint: this.normalizeClusterEndpoint(connection.clusterUrl),
			...(authorityId ? { authorityId } : {}),
			scopes: Object.freeze(getKustoAuthScopes(authorityId)),
			account: Object.freeze({ id: accountId, label: session.account.label }),
			accountId,
			accountPartition,
			preferenceMode: preference.mode,
		});
	}

	private registerEntry(entry: CachedClientEntry): CachedClientEntry {
		if (entry.client && (typeof entry.client === 'object' || typeof entry.client === 'function')) {
			this.authContextByClient.set(entry.client, entry.auth);
		}
		return entry;
	}

	private async createClientEntry(
		connection: KustoConnection,
		session: vscode.AuthenticationSession,
		preference: KustoAccountPreference,
		traceId?: string,
	): Promise<CachedClientEntry> {
		const auth = this.buildAuthContext(connection, session, preference);
		const { Client, KustoConnectionStringBuilder } = await import('azure-kusto-data');
		const effectiveToken = await this.getEffectiveAccessToken(session, auth.authorityId, traceId);
		const kcsb = KustoConnectionStringBuilder.withAccessToken(auth.clusterEndpoint, effectiveToken);
		kcsb.applicationNameForTracing = KustoQueryClient.APPLICATION_NAME;
		return this.registerEntry({ client: new Client(kcsb), auth });
	}

	/**
	 * Forces an interactive auth prompt for the given connection and refreshes the cached client.
	 * Useful for explicit user actions like "Refresh databases" when the current account has no access.
	 */
	public async reauthenticate(
		connection: KustoConnection,
		promptMode: 'clearPreference' | 'forceNewSession' = 'clearPreference',
		traceId?: string
	): Promise<void> {
		const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
		this.traceDatabaseDiscovery(traceId, 'auth.reauthenticate.start', {
			connectionId: connection.id,
			clusterEndpoint,
			promptMode,
		});
		if (!clusterEndpoint) {
			throw new Error('Cluster URL is missing.');
		}
		this.invalidateClients([connection.id]);
		// Explicit user action: skip silent selection so VS Code shows an account picker/sign-in.
		await this.createClientWithRetry(connection, { interactiveIfNeeded: true, promptMode, skipSilent: true, traceId });
		this.traceDatabaseDiscovery(traceId, 'auth.reauthenticate.complete', {
			connectionId: connection.id,
			promptMode,
		});
	}

	public isAuthenticationError(error: unknown): boolean {
		return this.isAuthError(error);
	}

	private normalizeClusterEndpoint(clusterUrl: string): string {
		return exportKustoClusterEndpoint(clusterUrl);
	}

	private async getOrCreateClient(connection: KustoConnection, opts?: { interactiveIfNeeded?: boolean; traceId?: string }): Promise<any> {
		const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
		if (!clusterEndpoint) {
			throw new Error('Cluster URL is missing.');
		}

		const preference = this.getPreference(connection);
		const preferredAccountId = preference.mode === 'explicit'
			? preference.accountId
			: preference.lastSuccessfulAccountId ?? preference.legacyAccountId;
		const existing = this.clients.get(connection.id);
		this.traceDatabaseDiscovery(opts?.traceId, 'auth.client.lookup', {
			connectionId: connection.id,
			clusterEndpoint,
			mappedAccountRef: databaseListTraceRef(preferredAccountId),
			cachedClientPresent: !!existing,
			cachedEndpointMatches: existing?.auth.clusterEndpoint === clusterEndpoint,
			cachedAccountMatches: !!preferredAccountId && existing?.auth.accountId === preferredAccountId,
		});
		if (this.isEntryCompatible(existing, connection, preference)) {
			this.traceDatabaseDiscovery(opts?.traceId, 'auth.client.reused', {
				connectionId: connection.id,
				accountRef: databaseListTraceRef(existing?.auth.accountId),
			});
			return existing?.client;
		}
		if (existing) {
			this.clients.delete(connection.id);
			this.closeEntry(existing);
		}

		// Create/refresh client via auth flow (may use silent retries and only prompt if needed).
		const { client } = await this.createClientWithRetry(connection, {
			interactiveIfNeeded: opts?.interactiveIfNeeded !== false,
			traceId: opts?.traceId,
		});
		return client;
	}

	private async createDedicatedClient(connection: KustoConnection, opts?: { interactiveIfNeeded?: boolean }): Promise<CachedClientEntry> {
		return this.createClientWithRetry(connection, {
			interactiveIfNeeded: !!opts?.interactiveIfNeeded,
			storeInMainClientCache: false,
		});
	}

	private async getOrCreateCancelableClient(connection: KustoConnection, key: string, opts?: { interactiveIfNeeded?: boolean }): Promise<any> {
		const preference = this.getPreference(connection);
		const cacheKey = this.cancelableCacheKey(connection, key, preference);
		const existing = this.cancelableClientsByKey.get(cacheKey);
		if (this.isEntryCompatible(existing, connection, preference)) {
			return existing?.client;
		}
		if (existing) {
			this.closeEntry(existing);
			this.cancelableClientsByKey.delete(cacheKey);
		}
		const created = await this.createClientWithRetry(connection, { interactiveIfNeeded: opts?.interactiveIfNeeded !== false, storeInMainClientCache: false });
		this.cancelableClientsByKey.set(cacheKey, created);
		return created.client;
	}

	private evictCancelableClient(connection: KustoConnection, callerKey: string, client?: any): void {
		let matched = false;
		for (const [cacheKey, entry] of [...this.cancelableClientsByKey]) {
			if (entry.auth.connectionId !== connection.id) continue;
			if (client && entry.client !== client) continue;
			if (!client && !cacheKey.endsWith(`|${callerKey}`)) continue;
			matched = true;
			this.cancelableClientsByKey.delete(cacheKey);
			this.closeEntry(entry);
		}
		if (client && !matched) {
			try { client.close?.(); } catch { /* ignore */ }
		}
	}

	private markAuthCancelled(authIdentity: string): void {
		try {
			this.authCancelledAtByIdentity.set(authIdentity, Date.now());
		} catch {
			// ignore
		}
	}

	private wasAuthCancelledRecently(authIdentity: string): boolean {
		const t = this.authCancelledAtByIdentity.get(authIdentity) ?? 0;
		return !!(t && (Date.now() - t) < KustoQueryClient.AUTH_CANCEL_SUPPRESS_MS);
	}

	private createAuthCancelledError(): QueryCancelledError {
		return new QueryCancelledError('Sign-in cancelled');
	}

	private isAuthError(error: unknown): boolean {
		return isAuthErrorFn(error);
	}

	private async getAccountCandidates(preference: KustoAccountPreference): Promise<vscode.AuthenticationSessionAccountInformation[]> {
		const accounts = await this.authPreferences?.getAccounts() ?? [];
		const byId = new Map(accounts.map(account => [account.id, { id: account.id, label: account.label }]));
		if (preference.mode === 'explicit') {
			return [byId.get(preference.accountId) ?? { id: preference.accountId, label: preference.accountId }];
		}
		const candidates: vscode.AuthenticationSessionAccountInformation[] = [];
		const preferred = preference.lastSuccessfulAccountId ?? preference.legacyAccountId;
		if (preferred) candidates.push(byId.get(preferred) ?? { id: preferred, label: preferred });
		for (const account of accounts) {
			if (!candidates.some(candidate => candidate.id === account.id)) {
				candidates.push({ id: account.id, label: account.label });
			}
		}
		return candidates;
	}

	private async requestSession(
		connection: KustoConnection,
		preference: KustoAccountPreference,
		requestedAccount: vscode.AuthenticationSessionAccountInformation | undefined,
		opts: { interactiveIfNeeded: boolean; promptMode?: SessionPromptMode; skipSilent?: boolean; traceId?: string },
	): Promise<{ session: vscode.AuthenticationSession | undefined; interactive: boolean }> {
		const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
		const scopes = getKustoAuthScopes(connection.authorityId);
		const authIdentity = `${this.authLockKey(connection, preference)}|${requestedAccount?.id ?? 'picker'}`;
		this.traceDatabaseDiscovery(opts.traceId, 'auth.session.discovery.start', {
			clusterEndpoint,
			contextAvailable: !!this.context,
			interactiveIfNeeded: opts.interactiveIfNeeded,
			promptMode: opts.promptMode ?? 'default',
			skipSilent: !!opts.skipSilent,
			accountRef: databaseListTraceRef(requestedAccount?.id),
			authorityRef: databaseListTraceRef(normalizeKustoAuthorityId(connection.authorityId)),
		});

		const validateExactAccount = (session: vscode.AuthenticationSession | undefined): vscode.AuthenticationSession | undefined => {
			if (!session || !requestedAccount) return session;
			if (session.account.id !== requestedAccount.id) {
				throw new Error(`Microsoft authentication returned a different account than the one selected for connection "${connection.name}".`);
			}
			return session;
		};

		if (!opts.skipSilent) {
			try {
				this.traceDatabaseDiscovery(opts.traceId, 'auth.session.silent.start', {
					accountRef: databaseListTraceRef(requestedAccount?.id),
				});
				const session = validateExactAccount(await vscode.authentication.getSession(
					KUSTO_AUTH_PROVIDER_ID,
					scopes,
					requestedAccount ? { silent: true, account: requestedAccount } : { silent: true },
				));
				this.traceDatabaseDiscovery(opts.traceId, 'auth.session.silent.complete', {
					sessionFound: !!session,
					accountRef: databaseListTraceRef(session?.account?.id),
				});
				if (session) return { session, interactive: false };
			} catch (error) {
				this.traceDatabaseDiscovery(opts.traceId, 'auth.session.silent.failed', getDatabaseListErrorDetails(error));
				if (preference.mode === 'explicit') throw error;
			}
		}

		if (!opts.interactiveIfNeeded) {
			this.traceDatabaseDiscovery(opts.traceId, 'auth.session.unavailable', {
				reason: 'interactive-disabled',
			});
			return { session: undefined, interactive: false };
		}

		// If the user just cancelled an auth prompt for this cluster, avoid prompting again
		// back-to-back (common when multiple features request auth in quick succession).
		if (this.wasAuthCancelledRecently(authIdentity)) {
			this.traceDatabaseDiscovery(opts.traceId, 'auth.session.unavailable', {
				reason: 'recent-cancellation-suppression',
			});
			return { session: undefined, interactive: false };
		}

		// Finally: interactive prompt.
		// IMPORTANT: In multi-account scenarios, VS Code may return an existing session without
		// prompting unless we clear preference / force a new session.
		const promptMode: SessionPromptMode = opts.promptMode ?? 'default';
		const promptOptions: vscode.AuthenticationGetSessionOptions =
			promptMode === 'forceNewSession'
				? { forceNewSession: true }
				: promptMode === 'clearPreference'
					? { createIfNone: true, clearSessionPreference: true }
					: { createIfNone: true };
		const interactiveOptions: vscode.AuthenticationGetSessionOptions = requestedAccount
			? { ...promptOptions, account: requestedAccount }
			: promptOptions;

		try {
			this.traceDatabaseDiscovery(opts.traceId, 'auth.session.interactive.start', {
				promptMode,
			});
			const session = validateExactAccount(await vscode.authentication.getSession(
				KUSTO_AUTH_PROVIDER_ID,
				scopes,
				interactiveOptions
			));
			// VS Code may return `undefined` when the user cancels the consent/sign-in UI.
			if (!session) {
				this.markAuthCancelled(authIdentity);
				this.traceDatabaseDiscovery(opts.traceId, 'auth.session.interactive.cancelled', {
					promptMode,
				});
				return { session: undefined, interactive: true };
			}
			this.traceDatabaseDiscovery(opts.traceId, 'auth.session.interactive.complete', {
				promptMode,
				sessionFound: !!session,
				accountRef: databaseListTraceRef(session?.account?.id),
			});
			return { session, interactive: true };
		} catch (e) {
			if (this.isLikelyCancellationError(e)) {
				this.markAuthCancelled(authIdentity);
				this.traceDatabaseDiscovery(opts.traceId, 'auth.session.interactive.cancelled', {
					promptMode,
				});
				return { session: undefined, interactive: true };
			}
			this.traceDatabaseDiscovery(opts.traceId, 'auth.session.interactive.failed', {
				promptMode,
				...getDatabaseListErrorDetails(e),
			});
			throw e;
		}
	}

	private async withAuthLock<T>(authIdentity: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.authLocksByIdentity.get(authIdentity) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>(resolve => { release = resolve; });
		const tail = previous.catch(() => undefined).then(() => current);
		this.authLocksByIdentity.set(authIdentity, tail);
		await previous.catch(() => undefined);
		try {
			return await fn();
		} finally {
			release();
			if (this.authLocksByIdentity.get(authIdentity) === tail) this.authLocksByIdentity.delete(authIdentity);
		}
	}

	private async createClientWithRetry(
		connection: KustoConnection,
		opts: { interactiveIfNeeded: boolean; storeInMainClientCache?: boolean; promptMode?: SessionPromptMode; skipSilent?: boolean; traceId?: string }
	): Promise<CachedClientEntry>
	{
		const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
		if (!clusterEndpoint) throw new Error('Cluster URL is missing.');
		const storeInMain = opts.storeInMainClientCache !== false;
		const preference = this.getPreference(connection);
		const lockKey = this.authLockKey(connection, preference);
		this.traceDatabaseDiscovery(opts.traceId, 'auth.client.create.start', {
			connectionId: connection.id,
			clusterEndpoint,
			interactiveIfNeeded: opts.interactiveIfNeeded,
			promptMode: opts.promptMode ?? 'default',
			skipSilent: !!opts.skipSilent,
			storeInMainCache: storeInMain,
			waitingForClusterAuthLock: this.authLocksByIdentity.has(lockKey),
		});

		// Ensure we don't race multiple auth prompts for the same cluster.
		let created: CachedClientEntry | undefined;
		try {
			await this.withAuthLock(lockKey, async () => {
			this.traceDatabaseDiscovery(opts.traceId, 'auth.client.create.lock-acquired', {
				clusterEndpoint,
			});
			// Re-check cache after waiting.
			if (storeInMain && !opts.skipSilent) {
				const existing = this.clients.get(connection.id);
				if (this.isEntryCompatible(existing, connection, preference)) {
					created = existing;
					this.traceDatabaseDiscovery(opts.traceId, 'auth.client.reused-after-lock', {
						connectionId: connection.id,
						accountRef: databaseListTraceRef(existing?.auth.accountId),
					});
					return;
				}
			}

			const candidates = await this.getAccountCandidates(preference);
			if (!opts.skipSilent) {
				for (const candidate of candidates) {
					const requested = await this.requestSession(connection, preference, candidate, {
						interactiveIfNeeded: false,
						traceId: opts.traceId,
					});
					if (requested.session) {
						created = await this.createClientEntry(connection, requested.session, preference, opts.traceId);
						break;
					}
				}
				if (!created && preference.mode === 'automatic') {
					const requested = await this.requestSession(connection, preference, undefined, {
						interactiveIfNeeded: false,
						traceId: opts.traceId,
					});
					if (requested.session) created = await this.createClientEntry(connection, requested.session, preference, opts.traceId);
				}
			}

			if (!created && opts.interactiveIfNeeded) {
				const requestedAccount = preference.mode === 'explicit' ? candidates[0] : undefined;
				const requested = await this.requestSession(connection, preference, requestedAccount, {
					interactiveIfNeeded: true,
					promptMode: opts.promptMode ?? 'default',
					skipSilent: true,
					traceId: opts.traceId,
				});
				if (!requested.session) throw this.createAuthCancelledError();
				created = await this.createClientEntry(connection, requested.session, preference, opts.traceId);
			}

			if (!created) {
				throw Object.assign(new Error(preference.mode === 'explicit'
					? `The selected Microsoft account is unavailable for connection "${connection.name}".`
					: 'No Microsoft account session is available.'), { statusCode: 401 });
			}
			if (storeInMain) {
				this.clients.set(connection.id, created);
			}
			this.traceDatabaseDiscovery(opts.traceId, 'auth.client.created', {
				connectionId: connection.id,
				clusterEndpoint,
				accountRef: databaseListTraceRef(created.auth.accountId),
				storedInMainCache: storeInMain,
			});
			});
		} catch (error) {
			this.traceDatabaseDiscovery(opts.traceId, 'auth.client.create.failed', {
				connectionId: connection.id,
				...getDatabaseListErrorDetails(error),
			});
			throw error;
		}
		if (!created) {
			throw new Error('Failed to authenticate with Microsoft');
		}
		return created;
	}

	private async executeWithAuthRetry<T>(
		connection: KustoConnection,
		operation: (client: any, auth?: KustoAuthContext) => Promise<T>,
		opts?: AuthOperationOptions<T>,
	): Promise<T> {
		const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
		const allowInteractive = opts?.allowInteractive !== false;
		const preference = this.getPreference(connection);
		let revision = this.getConnectionRevision(connection.id);
		let authRevision = this.authRevision;
		const candidates = await this.getAccountCandidates(preference);
		const attemptedAccounts = new Set<string>();
		let lastAuthError: unknown;
		let rejectedResult: { result: T; auth: KustoAuthContext } | undefined;
		const returnRejectedResult = (): T => {
			if (!rejectedResult) throw new Error('No rejected authentication result is available.');
			try { opts?.onClient?.(undefined, rejectedResult.auth); } catch { /* ignore */ }
			return rejectedResult.result;
		};
		this.traceDatabaseDiscovery(opts?.traceId, 'auth.execute.start', {
			operation: opts?.operationName ?? 'kusto-operation',
			connectionId: connection.id,
			clusterEndpoint,
			allowInteractive,
			cancelable: !!opts?.cancelableKey,
			preferenceMode: preference.mode,
		});

		const assertCurrentRevision = (accountId?: string, accountRevision?: number) => {
			if (this.getConnectionRevision(connection.id) !== revision || this.authRevision !== authRevision) {
				throw new QueryCancelledError('Authentication changed while the Kusto operation was running');
			}
			if (accountId && accountRevision !== undefined && this.getAccountRevision(accountId) !== accountRevision) {
				throw new QueryCancelledError('The Microsoft account changed while the Kusto operation was running');
			}
		};

		const cacheEntry = (entry: CachedClientEntry) => {
			if (opts?.cancelableKey) {
				this.cancelableClientsByKey.set(this.cancelableCacheKey(connection, opts.cancelableKey, preference), entry);
			} else {
				this.clients.set(connection.id, entry);
			}
		};

		const evictEntry = (entry: CachedClientEntry | undefined) => {
			if (!entry) return;
			for (const [key, candidate] of [...this.clients]) {
				if (candidate === entry || candidate.client === entry.client) this.clients.delete(key);
			}
			for (const [key, candidate] of [...this.cancelableClientsByKey]) {
				if (candidate === entry || candidate.client === entry.client) this.cancelableClientsByKey.delete(key);
			}
			this.closeEntry(entry);
		};

		type Attempt = { kind: 'accepted'; result: T } | { kind: 'rejected' } | { kind: 'auth-error'; error: unknown };
		const adoptAcquiredSessionRevision = () => {
			if (this.getConnectionRevision(connection.id) !== revision) {
				throw new QueryCancelledError('Authentication changed while the Kusto client was being acquired');
			}
			authRevision = this.authRevision;
		};
		const attempt = async (entry: CachedClientEntry, label: string): Promise<Attempt> => {
			attemptedAccounts.add(entry.auth.accountId);
			const accountRevision = this.getAccountRevision(entry.auth.accountId);
			try {
				assertCurrentRevision(entry.auth.accountId, accountRevision);
				try { opts?.onClient?.(entry.client, entry.auth); } catch { /* ignore */ }
				this.traceDatabaseDiscovery(opts?.traceId, 'auth.operation.start', {
					attempt: label,
					accountRef: databaseListTraceRef(entry.auth.accountId),
				});
				const result = await operation(entry.client, entry.auth);
				assertCurrentRevision(entry.auth.accountId, accountRevision);
				if (opts?.isSuccessfulResult && !opts.isSuccessfulResult(result)) {
					rejectedResult = { result, auth: entry.auth };
					this.traceDatabaseDiscovery(opts?.traceId, 'auth.operation.rejected-result', {
						attempt: label,
						accountRef: databaseListTraceRef(entry.auth.accountId),
					});
					if (preference.mode === 'automatic') evictEntry(entry);
					return { kind: 'rejected' };
				}
				if (opts?.persistAuthSuccess !== false) {
					const identityChanged = await this.authPreferences?.recordSuccessfulAccount(connection.id, entry.auth.account, entry.auth.accountPartition) ?? false;
					if (identityChanged) {
						revision = this.getConnectionRevision(connection.id);
						authRevision = this.authRevision;
					}
					assertCurrentRevision(entry.auth.accountId, accountRevision);
				}
				this.traceDatabaseDiscovery(opts?.traceId, 'auth.operation.complete', {
					attempt: label,
					accountRef: databaseListTraceRef(entry.auth.accountId),
				});
				return { kind: 'accepted', result };
			} catch (error) {
				const isAuthError = this.isAuthError(error);
				this.traceDatabaseDiscovery(opts?.traceId, 'auth.operation.failed', {
					attempt: label,
					isAuthError,
					...getDatabaseListErrorDetails(error),
				});
				if (!isAuthError) throw error;
				lastAuthError = error;
				evictEntry(entry);
				return { kind: 'auth-error', error };
			}
		};

		const initialClient = opts?.cancelableKey
			? await this.getOrCreateCancelableClient(connection, opts.cancelableKey, { interactiveIfNeeded: false }).catch(error => {
				lastAuthError = error;
				this.traceDatabaseDiscovery(opts?.traceId, 'auth.operation.failed', {
					attempt: 'initial',
					isAuthError: this.isAuthError(error),
					...getDatabaseListErrorDetails(error),
				});
				return undefined;
			})
			: await this.getOrCreateClient(connection, { interactiveIfNeeded: false, traceId: opts?.traceId }).catch(error => {
				lastAuthError = error;
				this.traceDatabaseDiscovery(opts?.traceId, 'auth.operation.failed', {
					attempt: 'initial',
					isAuthError: this.isAuthError(error),
					...getDatabaseListErrorDetails(error),
				});
				return undefined;
			});
		if (initialClient) {
			const auth = this.authContextByClient.get(initialClient);
			if (!auth) {
				try {
					this.traceDatabaseDiscovery(opts?.traceId, 'auth.operation.start', { attempt: 'initial' });
					const result = await operation(initialClient);
					this.traceDatabaseDiscovery(opts?.traceId, 'auth.operation.complete', { attempt: 'initial' });
					return result;
				} catch (error) {
					const isAuthError = this.isAuthError(error);
					this.traceDatabaseDiscovery(opts?.traceId, 'auth.operation.failed', {
						attempt: 'initial',
						isAuthError,
						...getDatabaseListErrorDetails(error),
					});
					if (!isAuthError) throw error;
					lastAuthError = error;
				}
			} else {
				adoptAcquiredSessionRevision();
				const initial = await attempt({ client: initialClient, auth }, 'initial');
				if (initial.kind === 'accepted') return initial.result;
				if (initial.kind === 'rejected' && preference.mode === 'explicit') return returnRejectedResult();
			}
		}

		this.traceDatabaseDiscovery(opts?.traceId, 'auth.retry.clients-evicted', { connectionId: connection.id });
		this.traceDatabaseDiscovery(opts?.traceId, 'auth.retry.known-accounts.start', { knownAccountCount: candidates.length });

		for (let index = 0; index < candidates.length; index++) {
			const candidate = candidates[index];
			if (attemptedAccounts.has(candidate.id)) continue;
			try {
				const requested = await this.requestSession(connection, preference, candidate, {
					interactiveIfNeeded: false,
					traceId: opts?.traceId,
				});
				if (!requested.session) continue;
				const entry = await this.createClientEntry(connection, requested.session, preference, opts?.traceId);
				cacheEntry(entry);
				adoptAcquiredSessionRevision();
				const result = await attempt(entry, `known-account-${index + 1}`);
				if (result.kind === 'accepted') return result.result;
				if (result.kind === 'rejected' && preference.mode === 'explicit') return returnRejectedResult();
			} catch (error) {
				if (!this.isAuthError(error)) throw error;
				lastAuthError = error;
			}
		}

		if (!allowInteractive) {
			this.traceDatabaseDiscovery(opts?.traceId, 'auth.operation.failed', {
				attempt: 'all-silent',
				isAuthError: true,
				...getDatabaseListErrorDetails(lastAuthError),
			});
			this.traceDatabaseDiscovery(opts?.traceId, 'auth.retry.interactive.skipped', { reason: 'interactive-disabled' });
			if (rejectedResult !== undefined) return returnRejectedResult();
			throw lastAuthError ?? Object.assign(new Error('No Microsoft account session is available.'), { statusCode: 401 });
		}

		const interactiveModes: SessionPromptMode[] = preference.mode === 'explicit'
			? ['clearPreference']
			: ['clearPreference', 'forceNewSession'];
		for (const promptMode of interactiveModes) {
			this.traceDatabaseDiscovery(opts?.traceId, 'auth.retry.interactive.start', { promptMode });
			try {
				const created = await this.createClientWithRetry(connection, {
					interactiveIfNeeded: true,
					storeInMainClientCache: false,
					promptMode,
					skipSilent: true,
					traceId: opts?.traceId,
				});
				cacheEntry(created);
				adoptAcquiredSessionRevision();
				const result = await attempt(created, `interactive-${promptMode}`);
				if (result.kind === 'accepted') return result.result;
				if (result.kind === 'rejected' && preference.mode === 'explicit') return returnRejectedResult();
			} catch (error) {
				if (error instanceof QueryCancelledError || this.isLikelyCancellationError(error)) throw error;
				if (!this.isAuthError(error)) throw error;
				lastAuthError = error;
			}
		}

		if (rejectedResult !== undefined) return returnRejectedResult();
		throw lastAuthError ?? Object.assign(new Error('Failed to authenticate with Microsoft.'), { statusCode: 401 });
	}

	private isLikelyCancellationError(error: unknown): boolean {
		return isLikelyCancellationErrorFn(error);
	}

	public getAccountPartition(connection: KustoConnection): string | undefined {
		const accountId = this.authPreferences?.getPreferredAccountId(connection.id);
		return accountId ? this.authPreferences?.getAccountPartition(connection.authorityId, accountId) : undefined;
	}

	async getDatabasesWithIdentity(connection: KustoConnection, forceRefresh: boolean = false, opts?: DatabaseDiscoveryOptions): Promise<KustoDatabaseDiscoveryResult> {
		const traceId = String(opts?.traceId || createDatabaseListTraceId());
		const startedAt = Date.now();
		try {
			this.syncCacheClearEpoch();
			const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
			const preference = this.getPreference(connection);
			const preferredPartition = this.getAccountPartition(connection);
			const cacheGeneration = this.connectionCache?.captureGeneration(connection.id, preferredPartition);
			const cacheKey = preferredPartition ? this.databaseCacheKey(connection, preferredPartition) : undefined;
			const cached = cacheKey ? this.databaseCache.get(cacheKey) : undefined;
			const allowLegacy = preference.mode === 'automatic' && normalizeKustoAuthorityId(connection.authorityId) === undefined;
			const persisted = this.connectionCache?.getDatabases(connection.id, preferredPartition, allowLegacy) ?? [];
			const cacheAgeMs = cached ? Date.now() - cached.timestamp : undefined;
			this.traceDatabaseDiscovery(traceId, 'client.start', {
				source: opts?.source ?? 'direct',
				connectionId: connection.id,
				clusterEndpoint,
				forceRefresh,
				allowInteractive: opts?.allowInteractive !== false,
				cachePresent: !!cached,
				cacheAgeMs,
				cachedCount: cached?.databases.length ?? persisted.length,
			});
			// Check cache first
			if (!forceRefresh) {
				if (cached && cacheAgeMs !== undefined && cacheAgeMs < this.CACHE_TTL) {
					this.traceDatabaseDiscovery(traceId, 'client.cache.hit', {
						cacheAgeMs,
						databaseCount: cached.databases.length,
					});
					return { databases: cached.databases, accountPartition: preferredPartition, cacheGeneration, fromCache: true };
				}
				if (persisted.length > 0) {
					this.traceDatabaseDiscovery(traceId, 'client.cache.hit', {
						source: 'persisted',
						databaseCount: persisted.length,
					});
					return { databases: persisted, accountPartition: preferredPartition, cacheGeneration, fromCache: true };
				}
			}
			this.traceDatabaseDiscovery(traceId, 'client.cache.miss', {
				reason: forceRefresh ? 'force-refresh' : cached ? 'expired' : 'absent',
			});

			const props = await this.createRequestProperties('get_databases');
			this.traceDatabaseDiscovery(traceId, 'client.request.start', {
				clientRequestId: props.clientRequestId,
				command: '.show databases',
			});
			let operationAuth: KustoAuthContext | undefined;
			let operationCacheGeneration = cacheGeneration;
			const generationsByPartition = new Map<string, KustoConnectionCacheGeneration>();
			const result = await this.executeWithAuthRetry<any>(
				connection,
				(client) => client.execute('', '.show databases', props),
				{
					allowInteractive: opts?.allowInteractive,
					traceId,
					operationName: 'get-databases',
					persistAuthSuccess: opts?.persistIdentity !== false,
					onClient: (_client, auth) => {
						operationAuth = auth;
						let generation = generationsByPartition.get(auth.accountPartition);
						if (!generation) {
							generation = this.connectionCache?.captureGeneration(connection.id, auth.accountPartition);
							if (generation) generationsByPartition.set(auth.accountPartition, generation);
						}
						operationCacheGeneration = generation;
					},
					isSuccessfulResult: response => {
						const primary = response?.primaryResults?.[0];
						if (!primary || typeof primary.rows !== 'function') return false;
						for (const _row of primary.rows()) return true;
						return false;
					},
				}
			);
			this.traceDatabaseDiscovery(traceId, 'client.request.complete', {
				clientRequestId: props.clientRequestId,
				elapsedMs: Date.now() - startedAt,
				primaryResultCount: Array.isArray(result?.primaryResults) ? result.primaryResults.length : 0,
			});
			
			const databases: string[] = [];
			
			// Extract database names from the result
			const primaryResults = result?.primaryResults?.[0];
			if (!primaryResults || typeof primaryResults.rows !== 'function') {
				throw new Error('Kusto returned no readable primary result for .show databases.');
			}
			const columnNames = Array.isArray(primaryResults.columns)
				? primaryResults.columns.map((column: any) => String(column?.name ?? column?.type ?? 'unknown').slice(0, 100)).join(',')
				: '';
			this.traceDatabaseDiscovery(traceId, 'client.response.shape', {
				columnCount: Array.isArray(primaryResults.columns) ? primaryResults.columns.length : undefined,
				columnNames,
			});
			
			for (const row of primaryResults.rows()) {
				// Database name is typically in the first column
				const dbName = row['DatabaseName'] || row[0];
				if (dbName) {
					databases.push(dbName.toString());
				}
			}
			
			const resolvedPartition = databases.length === 0
				? this.getAccountPartition(connection)
				: operationAuth?.accountPartition;
			const resolvedCacheGeneration = databases.length === 0 && resolvedPartition
				? generationsByPartition.get(resolvedPartition) ?? cacheGeneration
				: operationCacheGeneration;
			let cacheUpdated = false;
			if (opts?.persistIdentity !== false && databases.length > 0 && resolvedPartition) {
				cacheUpdated = await this.connectionCache?.setDatabases(connection.id, resolvedPartition, databases, resolvedCacheGeneration) ?? true;
			}
			const currentGeneration = resolvedPartition
				? this.connectionCache?.captureGeneration(connection.id, resolvedPartition)
				: this.connectionCache?.captureGeneration(connection.id, preferredPartition);
			if (resolvedCacheGeneration !== undefined && currentGeneration !== undefined
				&& (currentGeneration.global !== resolvedCacheGeneration.global
					|| currentGeneration.connection !== resolvedCacheGeneration.connection
					|| currentGeneration.partition !== resolvedCacheGeneration.partition)) {
				throw new QueryCancelledError('Cached values changed while database discovery was running');
			}
			if (cacheUpdated && resolvedPartition) {
				this.databaseCache.set(this.databaseCacheKey(connection, resolvedPartition), {
					databases,
					timestamp: Date.now(),
				});
			}
			this.traceDatabaseDiscovery(traceId, 'client.success', {
				databaseCount: databases.length,
				elapsedMs: Date.now() - startedAt,
				cacheUpdated,
			});
			
			return { databases, accountPartition: resolvedPartition, cacheGeneration: resolvedCacheGeneration, fromCache: false };
		} catch (error) {
			this.traceDatabaseDiscovery(traceId, 'client.failure', {
				elapsedMs: Date.now() - startedAt,
				isAuthError: this.isAuthError(error),
				...getDatabaseListErrorDetails(error),
			});
			try {
				this.output.error(`Failed to fetch databases. Trace ID: ${traceId}`);
			} catch {
				// Diagnostics must not replace the connection failure.
			}
			throw new Error(`Failed to fetch databases: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	}

	async getDatabases(connection: KustoConnection, forceRefresh: boolean = false, opts?: DatabaseDiscoveryOptions): Promise<string[]> {
		return (await this.getDatabasesWithIdentity(connection, forceRefresh, opts)).databases;
	}

	async executeQuery(
		connection: KustoConnection,
		database: string,
		query: string
	): Promise<QueryResult> {
		return (await this.executeQueryWithIdentity(connection, database, query)).result;
	}

	async executeQueryWithIdentity(
		connection: KustoConnection,
		database: string,
		query: string
	): Promise<QueryResultWithIdentity> {
		const startTime = Date.now();
		
		let requestClientActivityId: string | undefined;
		let operationAuth: KustoAuthContext | undefined;
		try {
			const queryTimeoutMin = vscode.workspace.getConfiguration('kustoWorkbench').get<number>('queryTimeout', 20);
			const clientTimeoutMs = queryTimeoutMin > 0 ? queryTimeoutMin * 60 * 1000 : undefined;
			const props = await this.createRequestProperties('execute_query', clientTimeoutMs);
			requestClientActivityId = props.clientRequestId;
			const result = await this.executeWithAuthRetry<any>(connection, (client) => client.execute(database, query, props), {
				onClient: (_client, auth) => { operationAuth = auth; },
			});
			const executionTime = ((Date.now() - startTime) / 1000).toFixed(3) + 's';
			const clientActivityId = this.extractClientActivityId(result);
			const serverStats = this.extractServerStats(result);
			
			// Get the primary result
			const primaryResults = result.primaryResults[0];
			
			// Extract column names and types
			const columns = primaryResults.columns.map((col: any) => {
				const name = col.name || col.type || 'Unknown';
				const type = typeof col.type === 'string' ? col.type : '';
				return type ? { name, type } : name;
			});
			
			// Extract rows
			const rows: any[][] = [];
			for (const row of primaryResults.rows()) {
				// Row might be an object or array, convert to array
				const rowArray: any[] = [];
				if (Array.isArray(row)) {
					rowArray.push(...row);
				} else {
					// If it's an object, extract values based on column order
					const rowObj = row as Record<string, unknown>;
					for (const col of primaryResults.columns) {
						const value = rowObj[col.name] ?? rowObj[col.ordinal];
						rowArray.push(value);
					}
				}
				rows.push(rowArray.map((cell: any) => formatCellValue(cell)));
			}
			
			return {
				result: {
					columns,
					rows,
					metadata: {
						cluster: connection.clusterUrl,
						database: database,
						executionTime,
						clientActivityId,
						serverStats
					}
				},
				accountPartition: operationAuth?.accountPartition,
			};
		} catch (error) {
			getWorkbenchLogger().error('Error executing query:', error instanceof Error ? error : String(error));
			let errorMessage = 'Unknown error';
			if (error instanceof Error) {
				errorMessage = error.message;
				// Check if there's additional error info from Kusto
				if ((error as Record<string, any>).response?.data) {
					errorMessage = JSON.stringify((error as Record<string, any>).response.data);
				}
			} else {
				errorMessage = String(error);
			}
			
			throw new QueryExecutionError(errorMessage, requestClientActivityId);
		}
	}

	executeQueryCancelable(
		connection: KustoConnection,
		database: string,
		query: string,
		clientKey?: string
	): CancelableQueryExecution {
		const key = String(clientKey || connection.id || '').trim() || 'default';
		const clientActivityId = `KW.execute_query;${randomUUID()}`;
		let client: any | undefined;
		let capturedAuth: KustoAuthContext | undefined;
		let cancelled = false;
		let settled = false;
		let submitted = false;
		let serverCancelStarted = false;

		// Use a deferred rejection so that cancel() immediately resolves the
		// outer promise instead of waiting for the HTTP round-trip to complete.
		// client.close() is still called for clean-up, but we no longer rely on
		// the SDK's deprecated Axios CancelToken to abort the request promptly.
		let rejectWithCancel: ((err: Error) => void) | undefined;
		const cancelPromise = new Promise<never>((_resolve, reject) => {
			rejectWithCancel = reject;
		});
		// Prevent unhandled-rejection noise when the query completes normally
		// and cancelPromise is never settled.
		cancelPromise.catch(() => { /* intentionally ignored */ });

		const startServerCancel = () => {
			if (serverCancelStarted || !submitted) {
				return;
			}
			serverCancelStarted = true;
			const cancellation = capturedAuth
				? this.cancelQueryByClientActivityId(connection, database, clientActivityId, 'Canceled from Kusto Workbench', capturedAuth)
				: this.cancelQueryByClientActivityId(connection, database, clientActivityId);
			void cancellation.catch(() => {
				// Server-side cancellation is best-effort. Local cancellation already won.
			});
		};

		const cancel = () => {
			if (cancelled || settled) {
				return;
			}
			cancelled = true;
			// Immediately trip the race so the caller gets QueryCancelledError
			// without waiting for the network response.
			try {
				rejectWithCancel?.(new QueryCancelledError());
			} catch {
				// ignore – already settled
			}
			try {
				// Evict the client for this key so the next run starts clean.
				this.evictCancelableClient(connection, key, client);
				if (!client) this.evictCancelableClient(connection, key);
			} catch {
				// ignore
			}
			startServerCancel();
		};

		const executeAsync = async (): Promise<QueryResult> => {
			// If this run was cancelled before we even started, bail out early.
			if (cancelled) {
				throw new QueryCancelledError();
			}
			client = await this.getOrCreateCancelableClient(connection, key);
			if (client && (typeof client === 'object' || typeof client === 'function')) {
				capturedAuth = this.authContextByClient.get(client);
			}
			// If we were cancelled while acquiring/creating the client, do not execute.
			if (cancelled) {
				try {
					this.evictCancelableClient(connection, key, client);
				} catch {
					// ignore
				}
				throw new QueryCancelledError();
			}
			const startTime = Date.now();
			let requestClientActivityId: string | undefined = clientActivityId;
			try {
				// Check again right before executing (cancellation can happen at any time).
				if (cancelled) {
					throw new QueryCancelledError();
				}
				const queryTimeoutMin = vscode.workspace.getConfiguration('kustoWorkbench').get<number>('queryTimeout', 20);
				const clientTimeoutMs = queryTimeoutMin > 0 ? queryTimeoutMin * 60 * 1000 : undefined;
				const props = await this.createRequestProperties('execute_query', clientTimeoutMs, clientActivityId);
				if (cancelled) {
					throw new QueryCancelledError();
				}
				requestClientActivityId = props.clientRequestId || clientActivityId;
				const result = await this.executeWithAuthRetry<any>(
					connection,
					(c) => {
						if (cancelled) {
							throw new QueryCancelledError();
						}
						submitted = true;
						return c.execute(database, query, props);
					},
					{
						allowInteractive: true,
						cancelableKey: key,
						onClient: (c2, auth) => { client = c2; capturedAuth = auth; },
					}
				);
				const executionTime = ((Date.now() - startTime) / 1000).toFixed(3) + 's';
				const responseClientActivityId = this.extractClientActivityId(result) || requestClientActivityId;
				const serverStats = this.extractServerStats(result);

				const primaryResults = result.primaryResults[0];
				const columns = primaryResults.columns.map((col: any) => {
					const name = col.name || col.type || 'Unknown';
					const type = typeof col.type === 'string' ? col.type : '';
					return type ? { name, type } : name;
				});

				const rows: any[][] = [];
				for (const row of primaryResults.rows()) {
					const rowArray: any[] = [];
					if (Array.isArray(row)) {
						rowArray.push(...row);
					} else {
						const rowObj = row as Record<string, unknown>;
						for (const col of primaryResults.columns) {
							const value = rowObj[col.name] ?? rowObj[col.ordinal];
							rowArray.push(value);
						}
					}
					rows.push(rowArray.map((cell: any) => formatCellValue(cell)));
				}

				return {
					columns,
					rows,
					metadata: {
						cluster: connection.clusterUrl,
						database: database,
						executionTime,
						clientActivityId: responseClientActivityId,
						serverStats
					}
				};
			} catch (error) {
				if (cancelled || this.isLikelyCancellationError(error)) {
					throw new QueryCancelledError();
				}
				// If we hit a non-cancellation error, evict+close this client so a subsequent run
				// can recreate a fresh connection/session.
				try {
					this.evictCancelableClient(connection, key, client);
				} catch {
					// ignore
				}
				getWorkbenchLogger().error('Error executing query:', error instanceof Error ? error : String(error));
				let errorMessage = 'Unknown error';
				if (error instanceof Error) {
					errorMessage = error.message;
					if ((error as Record<string, any>).response?.data) {
						errorMessage = JSON.stringify((error as Record<string, any>).response.data);
					}
				} else {
					errorMessage = String(error);
				}
				throw new QueryExecutionError(errorMessage, requestClientActivityId);
			}
		};

		// Race the actual execution against the cancel promise so that calling
		// cancel() causes the outer promise to reject immediately.
		const promise = Promise.race([executeAsync(), cancelPromise]).finally(() => {
			settled = true;
		});

		return { promise, cancel, clientActivityId, getAccountPartition: () => capturedAuth?.accountPartition };
	}

	async getDatabaseSchema(
		connection: KustoConnection,
		database: string,
		forceRefresh: boolean = false,
		opts?: SchemaDiscoveryOptions
	): Promise<DatabaseSchemaResult> {
		this.syncCacheClearEpoch();
		const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
		const preferredPartition = this.getAccountPartition(connection);
		const cacheGeneration = this.context ? captureSchemaCacheGeneration(this.context.globalStorageUri, connection.id, preferredPartition) : undefined;
		const cacheKey = preferredPartition ? this.schemaCacheKey(connection, preferredPartition, database) : undefined;
		const traceId = String(opts?.traceId || '').trim() || undefined;
		const trace = (event: string, details: Record<string, unknown> = {}) => this.traceDatabaseDiscovery(traceId, `schema.${event}`, {
			source: opts?.source || 'schema',
			clusterRef: databaseListTraceRef(clusterEndpoint),
			databaseRef: databaseListTraceRef(database),
			...details,
		});
		trace('start', { forceRefresh, allowInteractive: opts?.allowInteractive !== false });
		if (!forceRefresh) {
			const cached = cacheKey ? this.schemaCache.get(cacheKey) : undefined;
			if (cached && (Date.now() - cached.timestamp) < this.SCHEMA_CACHE_TTL) {
				trace('cache.hit', { cacheAgeMs: Date.now() - cached.timestamp, hasRawSchemaJson: !!cached.schema.rawSchemaJson });
				return {
					schema: cached.schema,
					fromCache: true,
					accountPartition: preferredPartition,
					cacheGeneration,
					cacheAgeMs: Date.now() - cached.timestamp
				};
			}
		}
		trace('cache.miss', { reason: forceRefresh ? 'force-refresh' : 'not-fresh' });

		const tryCommands = [
			'.show database schema as json',
			'.show database schema'
		];

		let lastError: unknown = null;
		for (let commandIndex = 0; commandIndex < tryCommands.length; commandIndex++) {
			const command = tryCommands[commandIndex];
			try {
				trace('command.start', { commandKind: command.endsWith('as json') ? 'json' : 'tabular', attempt: commandIndex + 1 });
				const props = await this.createRequestProperties('get_schema');
				let operationAuth: KustoAuthContext | undefined;
				let operationCacheGeneration = cacheGeneration;
				const generationsByPartition = new Map<string, SchemaCacheGeneration>();
				const result = await this.executeWithAuthRetry<any>(
					connection,
					(client) => client.execute(database, command, props),
					{
						allowInteractive: opts?.allowInteractive,
						traceId,
						operationName: 'get-schema',
						onClient: (_client, auth) => {
							operationAuth = auth;
							let generation = generationsByPartition.get(auth.accountPartition);
							if (!generation && this.context) {
								generation = captureSchemaCacheGeneration(this.context.globalStorageUri, connection.id, auth.accountPartition);
								generationsByPartition.set(auth.accountPartition, generation);
							}
							operationCacheGeneration = generation;
						},
					}
				);
				const debug = this.buildSchemaDebug(result, command);
				const { schema, rawSchemaJson } = this.parseDatabaseSchemaResultWithRaw(result, command);

				// Store the raw schema JSON for monaco-kusto integration
				if (rawSchemaJson) {
					schema.rawSchemaJson = rawSchemaJson;
				}

				trace('success', {
					commandKind: command.endsWith('as json') ? 'json' : 'tabular',
					tableCount: Array.isArray(schema.tables) ? schema.tables.length : 0,
					functionCount: Array.isArray(schema.functions) ? schema.functions.length : 0,
					hasRawSchemaJson: !!schema.rawSchemaJson,
				});
				const resolvedPartition = operationAuth?.accountPartition;
				const currentGeneration = resolvedPartition && this.context
					? captureSchemaCacheGeneration(this.context.globalStorageUri, connection.id, resolvedPartition)
					: undefined;
				if (operationCacheGeneration !== undefined && currentGeneration !== undefined
					&& (currentGeneration.global !== operationCacheGeneration.global
						|| currentGeneration.connection !== operationCacheGeneration.connection
						|| currentGeneration.partition !== operationCacheGeneration.partition)) {
					throw new QueryCancelledError('Cached values changed while schema discovery was running');
				}
				if (resolvedPartition) {
					this.schemaCache.set(this.schemaCacheKey(connection, resolvedPartition, database), { schema, timestamp: Date.now() });
				}
				return { schema, fromCache: false, accountPartition: resolvedPartition, cacheGeneration: operationCacheGeneration, debug };
			} catch (e) {
				if (e instanceof QueryCancelledError) throw e;
				lastError = e;
				trace('command.failed', {
					commandKind: command.endsWith('as json') ? 'json' : 'tabular',
					attempt: commandIndex + 1,
					...getDatabaseListErrorDetails(e),
				});
			}
		}
		trace('failed', getDatabaseListErrorDetails(lastError));

		throw new Error(
			`Failed to fetch database schema: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
			{ cause: lastError }
		);
	}

	/**
	 * Parses schema result and also returns the raw JSON if available from `.show database schema as json`.
	 * The raw JSON is used by monaco-kusto's setSchemaFromShowSchema API for full language support.
	 */
	private parseDatabaseSchemaResultWithRaw(result: any, commandUsed: string): { schema: DatabaseSchemaIndex; rawSchemaJson?: unknown } {
		return parseDatabaseSchemaResultWithRawFn(result, commandUsed);
	}

	private parseDatabaseSchemaResult(result: any): DatabaseSchemaIndex {
		return parseDatabaseSchemaResultWithRawFn(result, '').schema;
	}

	private buildSchemaDebug(result: any, commandUsed: string): DatabaseSchemaResult['debug'] {
		try {
			const primary = result?.primaryResults?.[0];
			const primaryColumns: string[] = (primary?.columns ?? []).map((c: any) => String(c?.name ?? c?.type ?? '')).filter(Boolean);
			let sampleRow: any = null;
			if (primary?.rows) {
				sampleRow = Array.from(primary.rows())[0] ?? null;
			}
			const sampleRowType = sampleRow === null ? 'null' : Array.isArray(sampleRow) ? 'array' : typeof sampleRow;
			const sampleRowKeys = sampleRow && typeof sampleRow === 'object' ? Object.keys(sampleRow).slice(0, 20) : [];
			let sampleRowPreview = '';
			try {
				sampleRowPreview = JSON.stringify(sampleRow)?.slice(0, 500) ?? '';
			} catch {
				sampleRowPreview = String(sampleRow)?.slice(0, 500) ?? '';
			}
			return { commandUsed, primaryColumns, sampleRowType, sampleRowKeys, sampleRowPreview };
		} catch {
			return { commandUsed };
		}
	}

	private extractSchemaFromJson(
		parsed: any,
		columnTypesByTable: Record<string, Record<string, string>>,
		tableDocStrings?: Record<string, string>,
		columnDocStrings?: Record<string, string>,
		tableFolders?: Record<string, string>,
		functions?: KustoFunctionInfo[]
	) {
		extractSchemaFromJsonFn(parsed, columnTypesByTable, tableDocStrings, columnDocStrings, tableFolders, functions);
	}

	private finalizeSchema(
		columnTypesByTable: Record<string, Record<string, string>>,
		tableDocStrings?: Record<string, string>,
		columnDocStrings?: Record<string, string>,
		tableFolders?: Record<string, string>,
		functions?: KustoFunctionInfo[]
	): DatabaseSchemaIndex {
		return finalizeSchemeFn(columnTypesByTable, tableDocStrings, columnDocStrings, tableFolders, functions);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const entry of this.clients.values()) this.closeEntry(entry);
		for (const entry of this.cancelableClientsByKey.values()) this.closeEntry(entry);
		this.clients.clear();
		this.cancelableClientsByKey.clear();
		this.databaseCache.clear();
		this.schemaCache.clear();
		this.authLocksByIdentity.clear();
		this.authCancelledAtByIdentity.clear();
		for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
	}
}

// ── Testable pure function exports ───────────────────────────────────────────
// These wrap private static/instance methods so they can be imported by tests.

/** Parses a Kusto timespan string like "00:00:01.1406250" into milliseconds. */
export function parseKustoTimespan(ts: string | undefined): number | undefined {
	return (KustoQueryClient as any).parseKustoTimespan(ts);
}

/** Normalizes a cluster URL to a canonical endpoint (adds scheme, expands short names). */
export function normalizeClusterEndpoint(clusterUrl: string): string {
	// Static-compatible: the method doesn't use `this` state.
	const proto = KustoQueryClient.prototype as any;
	return proto.normalizeClusterEndpoint.call(null, clusterUrl);
}
