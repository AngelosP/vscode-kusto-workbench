import { afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CachedValuesViewerV2, getClusterCacheKey, mergeCachedDatabaseKeys } from '../../../src/host/cachedValuesViewer';
import { captureSchemaCacheGeneration, clearCachedSchemas, deleteCachedSchemasForAccountPartitions, deleteCachedSchemasForConnections, SCHEMA_CACHE_VERSION, schemaCacheKey, writeCachedSchemaToDisk } from '../../../src/host/schemaCache';
import { readSqlServerAccountMap, setSqlServerAccountMapEntry } from '../../../src/host/sql/sqlAuthState';
import { sqlSchemaPrincipalFingerprint, sqlSchemaPrincipalFingerprintForPrincipal, sqlSchemaTargetSignature, SQL_SCHEMA_CACHE_VERSION } from '../../../src/host/sqlEditorSchema';
import { captureSqlSchemaCacheGeneration } from '../../../src/host/sqlSchemaCacheGeneration';

const tempDirectories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function createViewerHarness(): CachedValuesViewerV2 & Record<string, any> {
	return Object.create(CachedValuesViewerV2.prototype) as CachedValuesViewerV2 & Record<string, any>;
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

function createSqlViewerHarness() {
	const viewer = createViewerHarness();
	const storageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-cached-values-sql-'));
	tempDirectories.push(storageDirectory);
	let accountId: string | undefined;
	let revocationGeneration = 0;
	let cacheStore: unknown = {};
	const accountMapStore: Record<string, string> = {};
	const context = {
		globalStorageUri: vscode.Uri.file(storageDirectory),
		globalState: {
			get: vi.fn((key: string) => {
				if (key === 'sql.auth.serverAccountMap') return { ...accountMapStore };
				if (key === 'sql.connectionManager.cachedDatabases') return cacheStore;
				return undefined;
			}),
			update: vi.fn(async (key: string, value: unknown) => {
				if (key === 'sql.auth.serverAccountMap') {
					for (const existing of Object.keys(accountMapStore)) delete accountMapStore[existing];
					Object.assign(accountMapStore, value);
				}
				if (key === 'sql.connectionManager.cachedDatabases') cacheStore = structuredClone(value);
			}),
		},
	} as any;
	let connection = { id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'MixedCase.Server.Example', port: 1433, authType: 'aad', database: 'master' } as any;
	const getDatabases = vi.fn<() => Promise<string[]>>();
	const getDatabaseSchema = vi.fn<() => Promise<any>>();
	const dispatchSqlConnectionAllowed = vi.fn(async (_connectionId: string, dispatch: () => unknown) => await dispatch());
	const sqlConnectionManager = {
		getConnection: () => connection,
		getConnections: () => [connection],
		assertConnectionCurrent: vi.fn(async () => undefined),
	};
	viewer.context = context;
	viewer.sqlDeps = {
		getSqlConnectionManager: () => sqlConnectionManager,
		getSqlClient: () => ({ getDatabases, getDatabaseSchema }),
		assertSqlConnectionAllowed: vi.fn(async () => undefined),
		dispatchSqlConnectionAllowed,
		dispatchSqlOwnerAllowed: async (captured: any, _principal: string, expectedRevocation: number, dispatch: () => unknown) => {
			if (expectedRevocation !== revocationGeneration) throw new Error('Leave No Trace generation changed');
			return dispatchSqlConnectionAllowed(captured.id, dispatch);
		},
		getSqlRevocationGeneration: () => revocationGeneration,
		dispatchSqlOwnerSnapshot: async (dispatch: (snapshot: any) => unknown) => await dispatch({
			policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {} },
			connections: [connection], connectionVersion: 1,
			accountsByServer: accountId ? { 'mixedcase.server.example': accountId } : {}, principalVersion: 1,
		}),
		dispatchSqlPolicySnapshot: async (dispatch: (policy: any) => unknown) => await dispatch({ connectionIds: [], version: 1, globallyBlocked: false }),
	};
	viewer.panel = { webview: { postMessage: vi.fn() } };
	return {
		viewer,
		context,
		connection,
		getDatabases,
		getDatabaseSchema,
		dispatchSqlConnectionAllowed,
		sqlConnectionManager,
		getCacheStore: () => cacheStore as any,
		setConnection: (value: any) => { connection = value; },
		setAccountId: async (value: string | undefined) => {
			accountId = value;
			if (value) await setSqlServerAccountMapEntry(context, connection.serverUrl, value);
		},
		setRevocationGeneration: (value: number) => { revocationGeneration = value; },
		getAccountId: () => accountId,
	};
}

// ── getClusterCacheKey ───────────────────────────────────────────────────────

describe('getClusterCacheKey', () => {
	it('returns empty string for empty input', () => {
		expect(getClusterCacheKey('')).toBe('');
	});

	it('returns empty string for falsy input', () => {
		expect(getClusterCacheKey(null as any)).toBe('');
		expect(getClusterCacheKey(undefined as any)).toBe('');
	});

	it('extracts hostname from https URL', () => {
		expect(getClusterCacheKey('https://mycluster.kusto.windows.net')).toBe('mycluster');
	});

	it('extracts hostname from http URL', () => {
		expect(getClusterCacheKey('http://mycluster.kusto.windows.net')).toBe('mycluster');
	});

	it('adds https:// prefix when missing and extracts hostname', () => {
		expect(getClusterCacheKey('mycluster.kusto.windows.net')).toBe('mycluster');
	});

	it('lowercases the hostname', () => {
		expect(getClusterCacheKey('https://MyCluster.Kusto.Windows.NET')).toBe('mycluster');
	});

	it('strips path from URL', () => {
		expect(getClusterCacheKey('https://mycluster.kusto.windows.net/some/path')).toBe('mycluster');
	});

	it('handles URL with trailing slash', () => {
		expect(getClusterCacheKey('https://mycluster.kusto.windows.net/')).toBe('mycluster');
	});

	it('handles public short cluster without scheme', () => {
		expect(getClusterCacheKey('help')).toBe('help');
	});

	it('handles regional public short and full forms', () => {
		expect(getClusterCacheKey('aoaiagents1.westus')).toBe('aoaiagents1.westus');
		expect(getClusterCacheKey('https://aoaiagents1.westus.kusto.windows.net')).toBe('aoaiagents1.westus');
	});

	it('trims whitespace', () => {
		expect(getClusterCacheKey('  https://mycluster.kusto.windows.net  ')).toBe('mycluster');
	});

	it('handles URL with port', () => {
		expect(getClusterCacheKey('https://mycluster.kusto.windows.net:443')).toBe('mycluster');
	});

	it('returns lowercased input for unparseable URL', () => {
		// A single word without dots still gets parsed as hostname by URL constructor
		expect(getClusterCacheKey('localhost')).toBe('localhost');
	});
});

// ── mergeCachedDatabaseKeys ──────────────────────────────────────────────────

describe('mergeCachedDatabaseKeys', () => {
	it('returns empty result for empty input', () => {
		const { next, changed } = mergeCachedDatabaseKeys({}, new Map());
		expect(next).toEqual({});
		expect(changed).toBe(false);
	});

	it('canonicalizes entries keyed by hostname', () => {
		const { next, changed } = mergeCachedDatabaseKeys(
			{ 'mycluster.kusto.windows.net': ['db1', 'db2'] },
			new Map(),
		);
		expect(next['mycluster']).toEqual(['db1', 'db2']);
		expect(changed).toBe(true);
	});

	it('resolves connection IDs to cluster hostnames via connById', () => {
		const connById = new Map([['conn-1', { clusterUrl: 'https://mycluster.kusto.windows.net' }]]);
		const { next, changed } = mergeCachedDatabaseKeys(
			{ 'conn-1': ['db1'] },
			connById,
		);
		expect(next['mycluster']).toEqual(['db1']);
		expect(changed).toBe(true);
	});

	it('merges databases from duplicate keys', () => {
		const connById = new Map([
			['conn-1', { clusterUrl: 'https://mycluster.kusto.windows.net' }],
			['conn-2', { clusterUrl: 'https://MYCLUSTER.kusto.windows.net' }],
		]);
		const { next } = mergeCachedDatabaseKeys(
			{ 'conn-1': ['db1'], 'conn-2': ['db2'] },
			connById,
		);
		expect(next['mycluster']).toEqual(['db1', 'db2']);
	});

	it('deduplicates databases case-insensitively', () => {
		const { next } = mergeCachedDatabaseKeys(
			{ 'host.kusto.windows.net': ['Db1', 'db1', 'DB1'] },
			new Map(),
		);
		// Keeps first occurrence
		expect(next['host']).toEqual(['Db1']);
	});

	it('skips empty keys and marks changed', () => {
		const { next, changed } = mergeCachedDatabaseKeys(
			{ '': ['db1'], 'host.kusto.windows.net': ['db2'] },
			new Map(),
		);
		expect(next['']).toBeUndefined();
		expect(next['host']).toEqual(['db2']);
		expect(changed).toBe(true);
	});

	it('handles null/undefined raw input gracefully', () => {
		const { next, changed } = mergeCachedDatabaseKeys(null as any, new Map());
		expect(next).toEqual({});
		expect(changed).toBe(false);
	});

	it('filters out empty database names', () => {
		const { next } = mergeCachedDatabaseKeys(
			{ 'host.kusto.windows.net': ['db1', '', '  ', 'db2'] },
			new Map(),
		);
		expect(next['host']).toEqual(['db1', 'db2']);
	});

	it('handles non-array value gracefully', () => {
		const { next } = mergeCachedDatabaseKeys(
			{ 'host.kusto.windows.net': 'not-an-array' as any },
			new Map(),
		);
		expect(next['host']).toEqual([]);
	});
});

describe('deleteCachedSchemasForAccountPartitions', () => {
	it('deletes only schema files owned by the forgotten account partitions', async () => {
		const files = new Map<string, string>([
			['forgotten.json', JSON.stringify({ accountPartition: 'forgotten-partition' })],
			['retained.json', JSON.stringify({ accountPartition: 'retained-partition' })],
			['malformed.json', '{not json'],
		]);
		const deleted: string[] = [];
		const fsApi = vscode.workspace.fs as any;
		const originalReadDirectory = fsApi.readDirectory;
		const originalReadFile = fsApi.readFile;
		const originalDelete = fsApi.delete;
		fsApi.readDirectory = vi.fn(async () => [...files.keys()].map(fileName => [fileName, 1]));
		fsApi.readFile = vi.fn(async (uri: vscode.Uri) => {
			const fileName = uri.toString().split('/').pop() || '';
			return Buffer.from(files.get(fileName) || '', 'utf8');
		});
		fsApi.delete = vi.fn(async (uri: vscode.Uri) => {
			deleted.push(uri.toString().split('/').pop() || '');
		});

		try {
			const count = await deleteCachedSchemasForAccountPartitions(
				vscode.Uri.file('/global-storage'),
				new Set(['forgotten-partition']),
			);

			expect(count).toBe(1);
			expect(deleted).toEqual(['forgotten.json']);
		} finally {
			if (originalReadDirectory === undefined) delete fsApi.readDirectory;
			else fsApi.readDirectory = originalReadDirectory;
			fsApi.readFile = originalReadFile;
			if (originalDelete === undefined) delete fsApi.delete;
			else fsApi.delete = originalDelete;
		}
	});
});

describe('schema cache clear durability', () => {
	it('does not allow a paused old-generation write to recreate schema after Clear All', async () => {
		const storageUri = vscode.Uri.file('/schema-clear-race');
		const cacheKey = schemaCacheKey('https://cluster.kusto.windows.net', 'Db', 'connection-1', 'account-partition');
		const oldGeneration = captureSchemaCacheGeneration(storageUri);
		let releaseDirectory!: () => void;
		const directoryGate = new Promise<void>(resolve => { releaseDirectory = resolve; });
		const createDirectory = vi.spyOn(vscode.workspace.fs, 'createDirectory').mockImplementation(async () => {
			await directoryGate;
		});
		const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile').mockResolvedValue(undefined);
		const fsApi = vscode.workspace.fs as any;
		const originalDelete = fsApi.delete;
		const deletePath = vi.fn(async () => undefined);
		fsApi.delete = deletePath;
		const entry = {
			schema: { tables: ['LateTable'], columnTypesByTable: {}, functions: [] },
			timestamp: Date.now(),
			version: SCHEMA_CACHE_VERSION,
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Db',
			connectionId: 'connection-1',
			accountPartition: 'account-partition',
		};

		try {
			const oldWrite = writeCachedSchemaToDisk(storageUri, cacheKey, entry, oldGeneration);
			await vi.waitFor(() => expect(createDirectory).toHaveBeenCalledOnce());
			const clear = clearCachedSchemas(storageUri);
			releaseDirectory();
			await Promise.all([oldWrite, clear]);

			expect(writeFile).not.toHaveBeenCalled();
			expect(deletePath).toHaveBeenCalledWith(expect.anything(), { recursive: true, useTrash: false });
		} finally {
			if (originalDelete === undefined) delete fsApi.delete;
			else fsApi.delete = originalDelete;
		}
	});

	it('does not invalidate a connection A schema write when connection B schemas are deleted', async () => {
		const storageUri = vscode.Uri.file('/schema-connection-isolation');
		const cacheKey = schemaCacheKey('https://a.kusto.windows.net', 'DbA', 'connection-a', 'partition-a');
		const generationA = captureSchemaCacheGeneration(storageUri, 'connection-a', 'partition-a');
		const fsApi = vscode.workspace.fs as any;
		const originalReadDirectory = fsApi.readDirectory;
		const originalCreateDirectory = fsApi.createDirectory;
		const originalWriteFile = fsApi.writeFile;
		fsApi.readDirectory = vi.fn(async () => []);
		fsApi.createDirectory = vi.fn(async () => undefined);
		fsApi.writeFile = vi.fn(async () => undefined);

		try {
			await deleteCachedSchemasForConnections(storageUri, new Set(['connection-b']));
			await writeCachedSchemaToDisk(storageUri, cacheKey, {
				schema: { tables: ['TableA'], columnTypesByTable: {}, functions: [] },
				timestamp: Date.now(), version: SCHEMA_CACHE_VERSION,
				clusterUrl: 'https://a.kusto.windows.net', database: 'DbA', connectionId: 'connection-a', accountPartition: 'partition-a',
			}, generationA);

			expect(fsApi.writeFile).toHaveBeenCalledOnce();
		} finally {
			fsApi.readDirectory = originalReadDirectory;
			fsApi.createDirectory = originalCreateDirectory;
			fsApi.writeFile = originalWriteFile;
		}
	});
});

describe('CachedValuesViewerV2 Kusto mutation completion', () => {
	it('posts the refreshed snapshot only after an account preference mutation settles', async () => {
		let settleMutation!: () => void;
		const mutationGate = new Promise<void>(resolve => { settleMutation = resolve; });
		const events: string[] = [];
		const viewer = createViewerHarness();
		viewer.authPreferences = {
			getAccounts: vi.fn(async () => [{ id: 'account-1', label: 'Account one' }]),
			setExplicitAccount: vi.fn(async () => {
				await mutationGate;
				events.push('mutation');
			}),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => { events.push('snapshot'); });
		viewer.panel = { webview: { postMessage: vi.fn(async (message: { type: string }) => { events.push(message.type); }) } };

		const completion = viewer.onMessage({ type: 'connectionPreference.set', connectionId: 'connection-1', accountId: 'account-1' });
		await Promise.resolve();
		expect(events).toEqual([]);

		settleMutation();
		await completion;
		expect(events).toEqual(['mutation', 'snapshot', 'kustoMutationComplete']);
	});

	it('refreshes and completes when Forget Account is cancelled', async () => {
		vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);
		const viewer = createViewerHarness();
		viewer.clearKustoAccountCachedData = vi.fn();
		viewer.authPreferences = { forgetAccount: vi.fn() };
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage: vi.fn(async () => true) } };

		await viewer.onMessage({ type: 'auth.forgetAccount', accountId: 'account-1' });

		expect(viewer.clearKustoAccountCachedData).not.toHaveBeenCalled();
		expect(viewer.authPreferences.forgetAccount).not.toHaveBeenCalled();
		expect(viewer.sendSnapshotToWebview).toHaveBeenCalledOnce();
		expect(viewer.panel.webview.postMessage).toHaveBeenCalledWith({ type: 'kustoMutationComplete' });
	});
});

describe('CachedValuesViewerV2 SQL database ownership', () => {
	it('publishes Kusto cached values while omitting SQL when SQL policy refresh fails', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn();
		viewer.snapshotRevision = 0;
		viewer.context = {
			globalStorageUri: vscode.Uri.file('/cached-values-kusto-only'),
			globalState: { get: vi.fn(() => undefined), update: vi.fn(async () => undefined) },
			secrets: { get: vi.fn(async () => undefined) },
		};
		viewer.panel = { webview: { postMessage } };
		viewer.sqlDeps = {
			refreshSqlLeaveNoTracePolicy: vi.fn(async () => { throw new Error('SQL policy unavailable'); }),
			getSqlConnectionManager: () => ({ getConnections: () => [{ id: 'sql-secret' }] }),
		};
		viewer.authPreferences = {
			getAccounts: vi.fn(async () => []), getPreference: vi.fn(() => ({ mode: 'automatic' })),
			getPreferredAccountId: vi.fn(() => undefined), getTokenOverride: vi.fn(async () => undefined),
		};
		viewer.connectionManager = {
			getConnections: vi.fn(() => [{ id: 'c1', name: 'Kusto', clusterUrl: 'https://cluster.kusto.windows.net' }]),
		};
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a') };
		viewer.readCachedDatabases = vi.fn(() => ({ c1: ['Db'] }));

		await viewer.sendSnapshotToWebview();

		expect(postMessage).toHaveBeenCalledWith({
			type: 'snapshot',
			snapshot: expect.objectContaining({
				sqlAvailable: false,
				connections: [expect.objectContaining({ id: 'c1' })],
				sqlConnections: [], sqlCachedDatabases: {}, sqlServerAccountMap: {},
			}),
		});
	});

	it('filters a SQL schema key whose captured owner differs from the canonical snapshot owner', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn(async () => true);
		const connection = {
			id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example',
			authType: 'sql-login', username: 'alice', database: 'DbA', credentialRevision: 1,
		} as any;
		const targetSignature = sqlSchemaTargetSignature(connection);
		const principalFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(connection, 'alice')!;
		const sqlStateVersions = { policy: 1, connections: 1, principals: 1 };
		viewer.snapshotRevision = 0;
		viewer.panel = { webview: { postMessage } };
		viewer.sqlDeps = {
			refreshSqlLeaveNoTracePolicy: vi.fn(async () => undefined),
			getSqlStateVersions: () => sqlStateVersions,
			dispatchSqlOwnerSnapshot: async (dispatch: (snapshot: any) => unknown) => await dispatch({
				policy: { connectionIds: [], globallyBlocked: false, version: 1 },
				connections: [connection], connectionVersion: 1, accountsByServer: {}, principalVersion: 1,
			}),
		};
		viewer.buildSnapshot = vi.fn(async (revision: number) => ({
			revision, timestamp: Date.now(), activeKind: 'sql', auth: { sessions: [], knownAccounts: [] },
			connections: [], cachedDatabases: {}, sqlAuth: { sessions: [] },
			sqlConnections: [{ id: connection.id, name: connection.name, serverUrl: connection.serverUrl, authType: connection.authType }],
			sqlCachedDatabases: { 'sql-1': ['DbA'] }, sqlLeaveNoTrace: [], sqlStateVersions, sqlAvailable: true,
			sqlServerAccountMap: {}, cachedSchemaKeys: ['kusto:kusto-1|Db', 'sql:sql-1|DbA'],
			sqlCacheOwners: { 'sql-1': { targetSignature, principalFingerprint } },
			sqlSchemaKeyOwners: { 'sql:sql-1|DbA': { targetSignature: `${targetSignature}-stale`, principalFingerprint } },
		}));

		await viewer.sendSnapshotToWebview();

		const published = postMessage.mock.calls[0][0].snapshot;
		expect(published.sqlCachedDatabases).toEqual({ 'sql-1': ['DbA'] });
		expect(published.cachedSchemaKeys).toEqual(['kusto:kusto-1|Db']);
		expect(published.sqlSchemaKeyOwners).toBeUndefined();
	});

	it('returns a correlated terminal response when cached schema identity is unavailable', async () => {
		const harness = createSqlViewerHarness();

		await harness.viewer.onMessage({
			type: 'sqlSchema.get', requestId: 'schema-missing-identity', connectionId: 'sql-1',
			serverUrl: harness.connection.serverUrl, database: 'DbA',
		});

		expect(harness.viewer.panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'schemaResult', requestId: 'schema-missing-identity', connectionId: 'sql-1', ok: false,
		}));
	});

	it('returns a correlated terminal response when live schema refresh fails', async () => {
		const harness = createSqlViewerHarness();
		await harness.setAccountId('account-a');
		harness.getDatabaseSchema.mockRejectedValue(new Error('refresh failed'));

		await harness.viewer.onMessage({
			type: 'sqlSchema.refresh', requestId: 'schema-refresh-failed', connectionId: 'sql-1',
			serverUrl: harness.connection.serverUrl, database: 'DbA',
		});

		expect(harness.viewer.panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'schemaResult', requestId: 'schema-refresh-failed', connectionId: 'sql-1', ok: false,
		}));
	});

	it('allows first AAD refresh to establish the principal', async () => {
		const harness = createSqlViewerHarness();
		harness.getDatabases.mockImplementation(async () => {
			await harness.setAccountId('account-a');
			return ['DbA'];
		});

		await harness.viewer.onMessage({ type: 'sqlDatabases.refresh', connectionId: 'sql-1' });

		expect(harness.getCacheStore().entries['sql-1']).toEqual(expect.objectContaining({ databases: ['DbA'] }));
	});

	it('does not resurrect databases when Clear All runs during refresh', async () => {
		const harness = createSqlViewerHarness();
		await harness.setAccountId('account-a');
		const pending = deferred<string[]>();
		harness.getDatabases.mockReturnValue(pending.promise);

		const refresh = harness.viewer.onMessage({ type: 'sqlDatabases.refresh', connectionId: 'sql-1' });
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledOnce());
		await harness.viewer.onMessage({ type: 'sqlSchema.clearAll' });
		pending.resolve(['StaleDb']);
		await refresh;

		expect(harness.getCacheStore().entries).toEqual({});
	});

	it('removes a mixed-case server mapping through the canonical normalized key', async () => {
		const harness = createSqlViewerHarness();
		await setSqlServerAccountMapEntry(harness.context, harness.connection.serverUrl, 'account-a');
		expect(readSqlServerAccountMap(harness.context)).toEqual({ 'mixedcase.server.example': 'account-a' });

		await harness.viewer.onMessage({ type: 'sqlServerMap.delete', serverUrl: harness.connection.serverUrl });

		expect(readSqlServerAccountMap(harness.context)).toEqual({});
	});

	it('drops a cached SQL schema response when the target changes during the disk read', async () => {
		const harness = createSqlViewerHarness();
		await harness.setAccountId('account-a');
		const principalFingerprint = sqlSchemaPrincipalFingerprint(harness.viewer.context, harness.connection)!;
		const cacheGeneration = await captureSqlSchemaCacheGeneration(harness.viewer.context.globalStorageUri);
		const entry = {
			version: SQL_SCHEMA_CACHE_VERSION,
			schema: { tables: ['SecretTable'], columnsByTable: {} },
			timestamp: Date.now(),
			serverUrl: harness.connection.serverUrl,
			database: 'DbA',
			connectionId: harness.connection.id,
			cacheGeneration,
			principalFingerprint,
			targetSignature: sqlSchemaTargetSignature(harness.connection),
		};
		const pendingRead = deferred<Uint8Array>();
		const readFile = vi.spyOn(vscode.workspace.fs, 'readFile').mockReturnValue(pendingRead.promise);

		const request = harness.viewer.onMessage({
			type: 'sqlSchema.get', requestId: 'schema-get-1', connectionId: 'sql-1',
			serverUrl: harness.connection.serverUrl, database: 'DbA',
		});
		await vi.waitFor(() => expect(readFile).toHaveBeenCalledOnce());
		harness.setConnection({ ...harness.connection, port: 1434 });
		pendingRead.resolve(Buffer.from(JSON.stringify(entry), 'utf8'));
		await request;

		expect(harness.viewer.panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'schemaResult', requestId: 'schema-get-1', connectionId: 'sql-1', ok: false,
		}));
		expect(harness.viewer.panel.webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
	});

	it('drops a refreshed SQL schema when the target changes during the live request', async () => {
		const harness = createSqlViewerHarness();
		await harness.setAccountId('account-a');
		const pendingSchema = deferred<any>();
		harness.getDatabaseSchema.mockReturnValue(pendingSchema.promise);

		const request = harness.viewer.onMessage({
			type: 'sqlSchema.refresh', requestId: 'schema-refresh-1', connectionId: 'sql-1',
			serverUrl: harness.connection.serverUrl, database: 'DbA',
		});
		await vi.waitFor(() => expect(harness.getDatabaseSchema).toHaveBeenCalledOnce());
		harness.setConnection({ ...harness.connection, port: 1434 });
		pendingSchema.resolve({ tables: ['SecretTable'], columnsByTable: {} });
		await request;

		expect(harness.viewer.panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'schemaResult', requestId: 'schema-refresh-1', connectionId: 'sql-1', ok: false,
		}));
		expect(harness.viewer.panel.webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
	});

	it('does not publish a refreshed SQL schema when canonical LNT admission rejects', async () => {
		const harness = createSqlViewerHarness();
		await harness.setAccountId('account-a');
		harness.getDatabaseSchema.mockResolvedValue({ tables: ['SecretTable'], columnsByTable: {} });
		harness.dispatchSqlConnectionAllowed.mockRejectedValueOnce(new Error('Leave No Trace committed'));

		await harness.viewer.onMessage({
			type: 'sqlSchema.refresh', requestId: 'schema-refresh-lnt', connectionId: 'sql-1',
			serverUrl: harness.connection.serverUrl, database: 'DbA',
		});

		expect(harness.viewer.panel.webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'schemaResult', requestId: 'schema-refresh-lnt', ok: true,
		}));
		expect(harness.viewer.panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'schemaResult', requestId: 'schema-refresh-lnt', ok: false,
		}));
	});

	it('does not publish or cache SQL schema after an LNT enable-disable interval', async () => {
		const harness = createSqlViewerHarness();
		await harness.setAccountId('account-a');
		const pendingSchema = deferred<any>();
		harness.getDatabaseSchema.mockReturnValue(pendingSchema.promise);

		const request = harness.viewer.onMessage({
			type: 'sqlSchema.refresh', requestId: 'schema-refresh-revoked', connectionId: 'sql-1',
			serverUrl: harness.connection.serverUrl, database: 'DbA',
		});
		await vi.waitFor(() => expect(harness.getDatabaseSchema).toHaveBeenCalledOnce());
		harness.setRevocationGeneration(2);
		pendingSchema.resolve({ tables: ['SecretTable'], columnsByTable: {} });
		await request;

		expect(harness.viewer.panel.webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'schemaResult', requestId: 'schema-refresh-revoked', ok: true,
		}));
		const cacheDirectory = path.join(harness.context.globalStorageUri.fsPath, 'sqlSchemaCache');
		expect(fs.existsSync(cacheDirectory) ? fs.readdirSync(cacheDirectory) : []).toEqual([]);
	});
});

// ── HTML shell ───────────────────────────────────────────────────────────────

describe('CachedValuesViewerV2 HTML shell', () => {
	it('opts into the shared page-level overlay scrollbar', () => {
		const webview = {
			cspSource: 'vscode-resource:',
			asWebviewUri: () => ({ toString: () => 'vscode-resource:/asset' }),
		};
		const html = (CachedValuesViewerV2.prototype as any).buildHtml.call({ extensionUri: {} }, webview);

		expect(html).toContain('<body data-kw-page-overlay-scroll="true">');
		expect(html).toContain('html, body { width: 100%; min-height: 100%; margin: 0; }');
		expect(html).toContain('kw-cached-values { display: block; width: 100%; }');
	});
});
