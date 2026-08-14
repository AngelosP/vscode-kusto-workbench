import { afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as crypto from 'crypto';
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
	const viewer = Object.create(CachedValuesViewerV2.prototype) as CachedValuesViewerV2 & Record<string, any>;
	viewer.pendingKustoPublicationAcks = new Map();
	viewer.kustoGlobalOperationGeneration = 0;
	viewer.kustoOperationGenerations = new Map();
	return viewer;
}

function installKustoSnapshotAdmission(viewer: CachedValuesViewerV2 & Record<string, any>, postMessage: ReturnType<typeof vi.fn>) {
	viewer.connectionManager = {
		...(viewer.connectionManager || {}),
		runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
			clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {},
		})),
	};
	viewer.postKustoPublication = vi.fn(async (message: unknown) => await Promise.resolve(postMessage(message)) !== false);
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
	it('omits protected Kusto connections, databases, and schema keys from snapshots', async () => {
		const viewer = createViewerHarness();
		const postKustoPublication = vi.fn(async () => true);
		viewer.snapshotRevision = 0;
		viewer.postKustoPublication = postKustoPublication;
		viewer.panel = { webview: { postMessage: vi.fn(async () => true) } };
		viewer.sqlDeps = { refreshSqlLeaveNoTracePolicy: vi.fn(async () => { throw new Error('SQL unavailable'); }) };
		viewer.connectionManager = {
			getConnections: vi.fn(() => [{ id: 'secret', name: 'Secret', clusterUrl: 'https://secret.kusto.windows.net' }]),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: ['secret'], globallyBlocked: false, version: 2, revocationGenerations: { secret: 1 },
			})),
		};
		viewer.buildSnapshot = vi.fn(async (revision: number) => ({
			revision, timestamp: Date.now(), activeKind: 'kusto', auth: { sessions: [], knownAccounts: [] },
			connections: [{ id: 'secret', name: 'Secret', clusterUrl: 'https://secret.kusto.windows.net', accountPreference: { mode: 'automatic' }, accountPartition: 'partition-a', hasTokenOverride: false }],
			cachedDatabases: { secret: ['SecretDb'] }, sqlAuth: { sessions: [] }, sqlConnections: [],
			sqlCachedDatabases: {}, sqlLeaveNoTrace: [], sqlAvailable: false, sqlServerAccountMap: {},
			cachedSchemaKeys: ['kusto:secret|SecretDb'],
		}));

		await viewer.sendSnapshotToWebview();

		expect(postKustoPublication).toHaveBeenCalledWith({
			type: 'snapshot', snapshot: expect.objectContaining({
				connections: [], cachedDatabases: {}, cachedSchemaKeys: [],
			}),
		});
	});

	it('releases Kusto snapshot admission between contended SQL owner attempts', async () => {
		const viewer = createViewerHarness();
		const storageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-cached-values-snapshot-contention-'));
		tempDirectories.push(storageDirectory);
		viewer.context = { globalStorageUri: vscode.Uri.file(storageDirectory) };
		const sqlSchemaCacheGeneration = await captureSqlSchemaCacheGeneration(viewer.context.globalStorageUri);
		const retry = deferred<void>();
		const continueRetry = deferred<void>();
		let kustoHeld = false;
		let attempts = 0;
		viewer.snapshotRevision = 0;
		viewer.panel = { webview: { postMessage: vi.fn(async () => true) } };
		viewer.connectionManager = {
			getConnections: vi.fn(() => []),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => {
				expect(kustoHeld).toBe(false);
				kustoHeld = true;
				try { return await run({ clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {} }); }
				finally { kustoHeld = false; }
			}),
		};
		viewer.buildSnapshot = vi.fn(async (revision: number) => ({
			revision, timestamp: Date.now(), activeKind: 'kusto', auth: { sessions: [], knownAccounts: [] },
			connections: [], cachedDatabases: {}, sqlAuth: { sessions: [] }, sqlConnections: [],
			sqlCachedDatabases: {}, sqlLeaveNoTrace: [], sqlAvailable: true, sqlServerAccountMap: {},
			sqlStateVersions: { policy: 1, connections: 1, principals: 1 }, cachedSchemaKeys: [],
			sqlCacheOwners: {}, sqlSchemaKeyOwners: {}, sqlSchemaCacheGeneration,
		}));
		viewer.sqlDeps = {
			refreshSqlLeaveNoTracePolicy: vi.fn(async () => undefined),
			getSqlStateVersions: () => ({ policy: 1, connections: 1, principals: 1 }),
			tryDispatchSqlOwnerSnapshot: vi.fn(async (dispatch: (snapshot: any) => unknown) => {
				attempts++;
				if (attempts === 1) return { acquired: false };
				return { acquired: true, value: await dispatch({
					policy: { connectionIds: [], version: 1, globallyBlocked: false },
					connections: [], connectionVersion: 1, accountsByServer: {}, principalVersion: 1,
				}) };
			}),
			retrySqlOwnerSnapshotAcquisition: async (attempt: () => Promise<any>) => {
				const first = await attempt();
				if (first.acquired) return first.value;
				expect(kustoHeld).toBe(false);
				retry.resolve();
				await continueRetry.promise;
				const second = await attempt();
				return second.value;
			},
		};
		viewer.postKustoPublication = vi.fn(async () => true);

		const snapshot = viewer.sendSnapshotToWebview();
		await retry.promise;
		expect(kustoHeld).toBe(false);
		continueRetry.resolve();
		await snapshot;
		expect(attempts).toBe(2);
	});

	it('does not read a protected Kusto schema cache entry', async () => {
		const viewer = createViewerHarness();
		const readFile = vi.spyOn(vscode.workspace.fs, 'readFile');
		viewer.context = { globalStorageUri: vscode.Uri.file('/protected-cache') };
		viewer.panel = { webview: { postMessage: vi.fn(async () => true) } };
		viewer.connectionManager = {
			getConnections: vi.fn(() => [{ id: 'secret', name: 'Secret', clusterUrl: 'https://secret.kusto.windows.net' }]),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: ['secret'], globallyBlocked: false, version: 2, revocationGenerations: { secret: 1 },
			})),
		};
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a') };

		await viewer.onMessage({ type: 'schema.get', requestId: 'protected-read', connectionId: 'secret', database: 'SecretDb' });

		expect(readFile).not.toHaveBeenCalled();
		expect(viewer.panel.webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
	});

	it('settles a current missing cached schema request with a row-free failure', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		const postKustoPublication = vi.fn(async () => true);
		viewer.context = { globalStorageUri: vscode.Uri.file('/missing-cached-schema') };
		viewer.postKustoPublication = postKustoPublication;
		viewer.connectionCache = { captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })) };
		viewer.authPreferences = { waitForProviderAccountRefresh: vi.fn(async () => undefined) };
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {},
			})),
		};
		viewer.kustoClient = {
			getAccountPartition: vi.fn(() => 'partition-a'), getConnectionSessionGeneration: vi.fn(() => 0),
		};

		await viewer.onMessage({ type: 'schema.get', requestId: 'missing-schema', connectionId: 'c1', database: 'Db' });

		expect(postKustoPublication).toHaveBeenCalledWith(expect.objectContaining({
			type: 'schemaResult', requestId: 'missing-schema', connectionId: 'c1', accountPartition: 'partition-a',
			database: 'Db', ok: false, json: expect.stringContaining('No cached schema'),
		}));
	});

	it('does not cache or publish Kusto schema after a policy enable-disable interval', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let leaveNoTraceRevision = 0;
		const pendingSchema = deferred<any>();
		const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile');
		viewer.context = { globalStorageUri: vscode.Uri.file('/cached-values-policy-interval') };
		viewer.panel = { webview: { postMessage: vi.fn(async () => true) } };
		viewer.postKustoPublication = vi.fn(async () => true);
		viewer.connectionCache = { captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })) };
		viewer.authPreferences = { getConnectionSessionGeneration: vi.fn(() => 0) };
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: leaveNoTraceRevision + 1,
				revocationGenerations: { cluster: leaveNoTraceRevision },
			})),
		};
		viewer.kustoClient = {
			getAccountPartition: vi.fn(() => 'partition-a'), getConnectionSessionGeneration: vi.fn(() => 0),
			getDatabaseSchema: vi.fn(() => pendingSchema.promise), isAuthenticationError: vi.fn(() => false),
		};

		const refresh = viewer.onMessage({ type: 'schema.refresh', requestId: 'policy-interval', connectionId: 'c1', database: 'Db' });
		await vi.waitFor(() => expect(viewer.kustoClient.getDatabaseSchema).toHaveBeenCalledOnce());
		leaveNoTraceRevision = 2;
		pendingSchema.resolve({ schema: { tables: ['SecretTable'], columnTypesByTable: {}, functions: [] }, accountPartition: 'partition-a' });
		await refresh;

		expect(writeFile).not.toHaveBeenCalled();
		expect(viewer.postKustoPublication).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'schemaResult' }));
		expect(viewer.panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'schemaResult', requestId: 'policy-interval', ok: false,
		}));
	});

	it('does not resurrect Kusto schema when Clear All wins during refresh', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		const pendingSchema = deferred<any>();
		const storageUri = vscode.Uri.file('/cached-values-clear-race');
		viewer.context = {
			globalStorageUri: storageUri,
			globalState: { get: vi.fn(), update: vi.fn(async () => undefined) },
		};
		viewer.panel = { webview: { postMessage: vi.fn(async () => true) } };
		viewer.postKustoPublication = vi.fn(async () => true);
		viewer.connectionCache = {
			captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })),
			clearAll: vi.fn(async () => undefined),
		};
		viewer.authPreferences = {
			getConnectionSessionGeneration: vi.fn(() => 0),
			waitForProviderAccountRefresh: vi.fn(async () => undefined),
		};
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {},
			})),
		};
		viewer.kustoClient = {
			getAccountPartition: vi.fn(() => 'partition-a'), getConnectionSessionGeneration: vi.fn(() => 0),
			getDatabaseSchema: vi.fn(() => pendingSchema.promise), isAuthenticationError: vi.fn(() => false),
		};
		const initialGeneration = captureSchemaCacheGeneration(storageUri, connection.id, 'partition-a');

		const refresh = viewer.onMessage({ type: 'schema.refresh', requestId: 'clear-race', connectionId: 'c1', database: 'Db' });
		await vi.waitFor(() => expect(viewer.kustoClient.getDatabaseSchema).toHaveBeenCalledOnce());
		await viewer.onMessage({ type: 'schema.clearAll' });
		pendingSchema.resolve({
			schema: { tables: ['SecretTable'], columnTypesByTable: {}, functions: [] },
			accountPartition: 'partition-a', cacheGeneration: initialGeneration,
		});
		await refresh;

		expect(viewer.postKustoPublication).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'schemaResult' }));
		const cacheDirectory = path.join(storageUri.fsPath, 'schemaCache');
		expect(fs.existsSync(cacheDirectory) ? fs.readdirSync(cacheDirectory) : []).toEqual([]);
	});

	it('does not publish a cached Kusto schema when Clear All wins during disk read', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		const storageUri = vscode.Uri.file('/cached-values-read-clear-race');
		const pendingRead = deferred<Uint8Array>();
		vi.spyOn(vscode.workspace.fs, 'readFile').mockReturnValue(pendingRead.promise);
		viewer.context = { globalStorageUri: storageUri, globalState: { get: vi.fn(), update: vi.fn(async () => undefined) } };
		viewer.panel = { webview: { postMessage: vi.fn(async () => true) } };
		viewer.postKustoPublication = vi.fn(async () => true);
		viewer.connectionCache = { clearAll: vi.fn(async () => undefined), captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })) };
		viewer.authPreferences = {
			getConnectionSessionGeneration: vi.fn(() => 0), waitForProviderAccountRefresh: vi.fn(async () => undefined),
		};
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {},
			})),
		};
		viewer.kustoClient = {
			getAccountPartition: vi.fn(() => 'partition-a'), getConnectionSessionGeneration: vi.fn(() => 0),
		};

		const read = viewer.onMessage({ type: 'schema.get', requestId: 'read-clear-race', connectionId: 'c1', database: 'Db' });
		await vi.waitFor(() => expect(vscode.workspace.fs.readFile).toHaveBeenCalledOnce());
		await viewer.onMessage({ type: 'schema.clearAll' });
		pendingRead.resolve(Buffer.from(JSON.stringify({
			version: SCHEMA_CACHE_VERSION,
			schema: { tables: ['SecretTable'], columnTypesByTable: {}, functions: [] },
			timestamp: Date.now(), clusterUrl: connection.clusterUrl, database: 'Db',
			connectionId: connection.id, accountPartition: 'partition-a',
		}), 'utf8'));
		await read;

		expect(viewer.postKustoPublication).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'schemaResult' }));
	});

	it('keeps a database refresh alive across first account establishment', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		const generation = { global: 0, connection: 0, partition: 0 };
		const pendingDiscovery = deferred<any>();
		let accountPartition: string | undefined;
		viewer.context = { globalStorageUri: vscode.Uri.file('/cached-values-first-sign-in-databases') };
		viewer.panel = { webview: { postMessage: vi.fn(async () => true) } };
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.readCachedDatabases = vi.fn(() => ({}));
		viewer.connectionCache = {
			captureGeneration: vi.fn(() => generation),
			setDatabases: vi.fn(async () => true),
		};
		viewer.authPreferences = { waitForProviderAccountRefresh: vi.fn(async () => undefined) };
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {},
			})),
		};
		viewer.kustoClient = {
			getAccountPartition: vi.fn(() => accountPartition), getConnectionSessionGeneration: vi.fn(() => 0),
			getDatabasesWithIdentity: vi.fn(() => pendingDiscovery.promise), isAuthenticationError: vi.fn(() => false),
		};

		const refresh = viewer.onMessage({ type: 'databases.refresh', connectionId: connection.id });
		await vi.waitFor(() => expect(viewer.kustoClient.getDatabasesWithIdentity).toHaveBeenCalledOnce());
		accountPartition = 'partition-a';
		viewer.handleKustoAuthPreferenceChange({
			connectionIds: [connection.id], reason: 'success', accountPartition, firstEstablishment: true,
		});
		pendingDiscovery.resolve({ databases: ['DbA'], accountPartition, cacheGeneration: generation, fromCache: false });
		await refresh;

		expect(viewer.kustoOperationGenerations.get(connection.id)).toBeUndefined();
		expect(viewer.connectionCache.setDatabases).toHaveBeenCalledWith(connection.id, accountPartition, ['DbA'], generation);
		expect(viewer.sendSnapshotToWebview).toHaveBeenCalled();
	});

	it('keeps a schema refresh alive across first account establishment', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		const storageUri = vscode.Uri.file('/cached-values-first-sign-in-schema');
		const generation = captureSchemaCacheGeneration(storageUri, connection.id, 'partition-a');
		const pendingSchema = deferred<any>();
		let accountPartition: string | undefined;
		viewer.context = { globalStorageUri: storageUri };
		viewer.panel = { webview: { postMessage: vi.fn(async () => true) } };
		viewer.postKustoPublication = vi.fn(async () => true);
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.connectionCache = { captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })) };
		viewer.authPreferences = { waitForProviderAccountRefresh: vi.fn(async () => undefined) };
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {},
			})),
		};
		viewer.kustoClient = {
			getAccountPartition: vi.fn(() => accountPartition), getConnectionSessionGeneration: vi.fn(() => 0),
			getDatabaseSchema: vi.fn(() => pendingSchema.promise), isAuthenticationError: vi.fn(() => false),
		};

		const refresh = viewer.onMessage({ type: 'schema.refresh', requestId: 'first-sign-in', connectionId: connection.id, database: 'DbA' });
		await vi.waitFor(() => expect(viewer.kustoClient.getDatabaseSchema).toHaveBeenCalledOnce());
		accountPartition = 'partition-a';
		viewer.handleKustoAuthPreferenceChange({
			connectionIds: [connection.id], reason: 'success', accountPartition, firstEstablishment: true,
		});
		pendingSchema.resolve({
			schema: { tables: ['TableA'], columnTypesByTable: {}, functions: [] },
			accountPartition, cacheGeneration: generation, fromCache: false,
		});
		await refresh;

		expect(viewer.kustoOperationGenerations.get(connection.id)).toBeUndefined();
		expect(viewer.postKustoPublication).toHaveBeenCalledWith(expect.objectContaining({
			type: 'schemaResult', requestId: 'first-sign-in', accountPartition, ok: true,
		}));
		expect(viewer.sendSnapshotToWebview).toHaveBeenCalled();
	});

	it('invalidates Cached Values owners after a later account success', () => {
		const viewer = createViewerHarness();
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);

		viewer.handleKustoAuthPreferenceChange({
			connectionIds: ['c1'], reason: 'success', accountPartition: 'partition-a', firstEstablishment: false,
		});

		expect(viewer.kustoOperationGenerations.get('c1')).toBe(1);
		expect(viewer.sendSnapshotToWebview).toHaveBeenCalledOnce();
	});

	it('does not globally invalidate Cached Values for an unmapped forgotten account', () => {
		const viewer = createViewerHarness();
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);

		viewer.handleKustoAuthPreferenceChange({
			connectionIds: [], reason: 'account-forgotten', accountId: 'historical-account',
		});

		expect(viewer.kustoGlobalOperationGeneration).toBe(0);
		expect(viewer.kustoOperationGenerations.size).toBe(0);
		expect(viewer.sendSnapshotToWebview).toHaveBeenCalledOnce();
	});

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
	it('keeps the exact Cached Values publication waiter live after a malformed matching acknowledgement', async () => {
		vi.useFakeTimers();
		try {
			const viewer = createViewerHarness();
			const postMessage = vi.fn(async () => true);
			viewer.panel = { webview: { postMessage } };
			let settled = false;
			const publishing = viewer.postKustoPublication({ type: 'snapshot', snapshot: { revision: 1 } })
				.then((accepted: boolean) => { settled = true; return accepted; });
			await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
			const stage = postMessage.mock.calls[0][0];
			await viewer.onMessage({
				type: 'kustoPublicationAck', publicationId: stage.publicationId, phase: 'staged', accepted: true,
			});
			await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
			const key = `${stage.publicationId}:applied`;
			const pending = viewer.pendingKustoPublicationAcks.get(key);
			const deadline = pending?.timer;

			await viewer.onMessage({
				type: 'kustoPublicationAck', publicationId: [stage.publicationId], phase: 'applied', accepted: true,
			});

			expect(settled).toBe(false);
			expect(viewer.pendingKustoPublicationAcks.get(key)).toBe(pending);
			expect(viewer.pendingKustoPublicationAcks.get(key)?.timer).toBe(deadline);

			await viewer.onMessage({
				type: 'kustoPublicationAck', publicationId: stage.publicationId, phase: 'applied', accepted: true,
			});
			await expect(publishing).resolves.toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('holds generation, Kusto, and SQL owner locks through applied schema acknowledgement', async () => {
		const harness = createSqlViewerHarness();
		await harness.setAccountId('account-a');
		const viewer = harness.viewer;
		const generation = await captureSqlSchemaCacheGeneration(harness.context.globalStorageUri);
		const owner = {
			principalFingerprint: sqlSchemaPrincipalFingerprint(viewer.context, harness.connection)!,
			targetSignature: sqlSchemaTargetSignature(harness.connection),
			revocationGeneration: 0,
		};
		const stagePosted = deferred<void>();
		const releaseStageAcknowledgement = deferred<void>();
		let kustoHeld = false;
		let sqlHeld = false;
		viewer.connectionManager = {
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => {
				kustoHeld = true;
				try { return await run({ clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {} }); }
				finally { kustoHeld = false; }
			}),
		};
		viewer.sqlDeps.dispatchSqlOwnerAllowed = vi.fn(async (
			_connection: unknown,
			_principal: string,
			_revocation: number,
			dispatch: () => unknown,
		) => {
			expect(kustoHeld).toBe(true);
			sqlHeld = true;
			try { return await dispatch(); }
			finally { sqlHeld = false; }
		});
		viewer.panel = { webview: { postMessage: vi.fn(async (message: any) => {
			expect(kustoHeld).toBe(true);
			expect(sqlHeld).toBe(true);
			if (message.type === 'kustoPublicationStage') {
				stagePosted.resolve(undefined);
				await releaseStageAcknowledgement.promise;
				await viewer.onMessage({
					type: 'kustoPublicationAck', publicationId: message.publicationId,
					phase: 'staged', accepted: true,
				});
			}
			if (message.type === 'kustoPublicationCommit') {
				await viewer.onMessage({
					type: 'kustoPublicationAck', publicationId: message.publicationId,
					phase: 'applied', accepted: true,
				});
			}
			return true;
		}) } };

		const publication = viewer.postSqlSchemaPublication(
			harness.connection,
			owner,
			generation,
			{ type: 'schemaResult', requestId: 'schema-locks', connectionId: harness.connection.id },
		);
		await stagePosted.promise;
		expect(kustoHeld).toBe(true);
		expect(sqlHeld).toBe(true);
		releaseStageAcknowledgement.resolve(undefined);

		await expect(publication).resolves.toBe(true);
		expect(kustoHeld).toBe(false);
		expect(sqlHeld).toBe(false);
		expect(viewer.panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'kustoPublicationStage',
			payload: expect.objectContaining({ type: 'schemaResult', requestId: 'schema-locks' }),
		}));
		expect(viewer.panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'kustoPublicationCommit',
		}));
	});

	it('retries a current SQL schema publication after one rejected application', async () => {
		const harness = createSqlViewerHarness();
		await harness.setAccountId('account-a');
		const generation = await captureSqlSchemaCacheGeneration(harness.context.globalStorageUri);
		const owner = {
			principalFingerprint: sqlSchemaPrincipalFingerprint(harness.viewer.context, harness.connection)!,
			targetSignature: sqlSchemaTargetSignature(harness.connection),
			revocationGeneration: 0,
		};
		harness.viewer.connectionManager = {
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {},
			})),
		};
		harness.viewer.postKustoPublication = vi.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);

		await expect(harness.viewer.postSqlSchemaPublication(
			harness.connection,
			owner,
			generation,
			{ type: 'schemaResult', requestId: 'schema-retry', connectionId: harness.connection.id },
		)).resolves.toBe(true);

		expect(harness.viewer.postKustoPublication).toHaveBeenCalledTimes(2);
		expect(harness.viewer.connectionManager.runWithLeaveNoTraceSnapshotLock).toHaveBeenCalledTimes(2);
		expect(harness.dispatchSqlConnectionAllowed).toHaveBeenCalledTimes(2);
	});

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
		installKustoSnapshotAdmission(viewer, postMessage);
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
		const storageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-cached-values-snapshot-owner-'));
		tempDirectories.push(storageDirectory);
		viewer.context = { globalStorageUri: vscode.Uri.file(storageDirectory) };
		const sqlSchemaCacheGeneration = await captureSqlSchemaCacheGeneration(viewer.context.globalStorageUri);
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
			sqlSchemaCacheGeneration,
		}));
		viewer.connectionManager = { getConnections: vi.fn(() => []) };
		installKustoSnapshotAdmission(viewer, postMessage);

		await viewer.sendSnapshotToWebview();

		const published = postMessage.mock.calls[0][0].snapshot;
		expect(published.sqlCachedDatabases).toEqual({ 'sql-1': ['DbA'] });
		expect(published.cachedSchemaKeys).toEqual(['kusto:kusto-1|Db']);
		expect(published.sqlSchemaKeyOwners).toBeUndefined();
	});

	it('retries a current SQL-capable snapshot after one rejected application', async () => {
		const viewer = createViewerHarness();
		const storageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-cached-values-snapshot-retry-'));
		tempDirectories.push(storageDirectory);
		viewer.context = { globalStorageUri: vscode.Uri.file(storageDirectory) };
		const generation = await captureSqlSchemaCacheGeneration(viewer.context.globalStorageUri);
		const stateVersions = { policy: 1, connections: 1, principals: 1 };
		viewer.snapshotRevision = 0;
		viewer.buildSnapshot = vi.fn(async (revision: number) => ({
			revision, timestamp: Date.now(), activeKind: 'sql', auth: { sessions: [], knownAccounts: [] },
			connections: [], cachedDatabases: {}, sqlAuth: { sessions: [] }, sqlConnections: [],
			sqlCachedDatabases: {}, sqlLeaveNoTrace: [], sqlStateVersions: stateVersions,
			sqlAvailable: true, sqlServerAccountMap: {}, cachedSchemaKeys: [], sqlCacheOwners: {},
			sqlSchemaKeyOwners: {}, sqlSchemaCacheGeneration: generation,
		}));
		viewer.connectionManager = {
			getConnections: vi.fn(() => []),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {},
			})),
		};
		viewer.sqlDeps = {
			refreshSqlLeaveNoTracePolicy: vi.fn(async () => undefined),
			getSqlStateVersions: () => stateVersions,
			dispatchSqlOwnerSnapshot: async (dispatch: (snapshot: any) => unknown) => await dispatch({
				policy: { connectionIds: [], globallyBlocked: false, version: 1 },
				connections: [], connectionVersion: 1, accountsByServer: {}, principalVersion: 1,
			}),
		};
		viewer.postKustoPublication = vi.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);

		await expect(viewer.sendSnapshotToWebview()).resolves.toBe(true);

		expect(viewer.postKustoPublication).toHaveBeenCalledTimes(2);
		expect(viewer.buildSnapshot).toHaveBeenCalledTimes(2);
	});

	it('retires a pending SQL cache snapshot and publishes a fresh snapshot after Clear All', async () => {
		const harness = createSqlViewerHarness();
		await harness.setAccountId('account-a');
		const viewer = harness.viewer;
		const oldGeneration = await captureSqlSchemaCacheGeneration(harness.context.globalStorageUri);
		const firstKustoAdmission = deferred<void>();
		const releaseFirstKustoAdmission = deferred<void>();
		let kustoAdmissionCount = 0;
		viewer.snapshotRevision = 0;
		viewer.connectionManager = {
			getConnections: vi.fn(() => []),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => {
				kustoAdmissionCount += 1;
				if (kustoAdmissionCount === 1) {
					firstKustoAdmission.resolve(undefined);
					await releaseFirstKustoAdmission.promise;
				}
				return await run({ clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {} });
			}),
		};
		const stateVersions = { policy: 1, connections: 1, principals: 1 };
		viewer.sqlDeps = {
			...viewer.sqlDeps,
			refreshSqlLeaveNoTracePolicy: vi.fn(async () => undefined),
			getSqlStateVersions: () => stateVersions,
		};
		viewer.buildSnapshot = vi.fn(async (revision: number) => {
			const fresh = revision !== 1;
			const generation = fresh
				? await captureSqlSchemaCacheGeneration(harness.context.globalStorageUri)
				: oldGeneration;
			return {
				revision, timestamp: Date.now(), activeKind: 'sql', auth: { sessions: [], knownAccounts: [] },
				connections: [], cachedDatabases: {}, sqlAuth: { sessions: [] },
				sqlConnections: [], sqlCachedDatabases: {}, sqlLeaveNoTrace: [],
				sqlStateVersions: stateVersions, sqlAvailable: true, sqlServerAccountMap: {},
				cachedSchemaKeys: fresh ? [] : ['sql:sql-1|DbA'],
				sqlCacheOwners: {},
				sqlSchemaKeyOwners: fresh ? {} : {
					'sql:sql-1|DbA': { targetSignature: 'stale-target', principalFingerprint: 'stale-principal' },
				},
				sqlSchemaCacheGeneration: generation,
			};
		});
		viewer.postKustoPublication = vi.fn(async () => true);

		const staleSnapshot = viewer.sendSnapshotToWebview();
		await firstKustoAdmission.promise;
		const clear = viewer.onMessage({ type: 'sqlSchema.clearAll' });
		expect(viewer.snapshotRevision).toBe(2);
		releaseFirstKustoAdmission.resolve(undefined);
		await Promise.all([staleSnapshot, clear]);

		expect(await captureSqlSchemaCacheGeneration(harness.context.globalStorageUri)).not.toBe(oldGeneration);
		expect(viewer.postKustoPublication).toHaveBeenCalledOnce();
		expect(viewer.postKustoPublication).toHaveBeenCalledWith({
			type: 'snapshot',
			snapshot: expect.objectContaining({
				revision: 3,
				cachedSchemaKeys: [],
				sqlCachedDatabases: {},
			}),
		});
	});

	it('invalidates SQL schema generation and refreshes after database-cache clearing fails', async () => {
		const harness = createSqlViewerHarness();
		const storageRoot = harness.context.globalStorageUri.fsPath;
		const suffix = crypto.createHash('sha1')
			.update('sql.connectionManager.cachedDatabases', 'utf8')
			.digest('hex')
			.slice(0, 12);
		fs.mkdirSync(path.join(storageRoot, `sql-database-cache-${suffix}.v1.json`));
		const before = await captureSqlSchemaCacheGeneration(harness.context.globalStorageUri);
		harness.viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);

		await harness.viewer.onMessage({ type: 'sqlSchema.clearAll' });

		expect(await captureSqlSchemaCacheGeneration(harness.context.globalStorageUri)).not.toBe(before);
		expect(harness.viewer.sendSnapshotToWebview).toHaveBeenCalledOnce();
		expect(showErrorMessage).toHaveBeenCalledWith(
			'Failed to delete all SQL schema cache files. Remaining files have been invalidated and will not be reused.',
		);
	});

	it('settles SQL Clear All when every fresh snapshot application is rejected', async () => {
		const harness = createSqlViewerHarness();
		harness.viewer.sendSnapshotToWebview = vi.fn(async () => false);
		harness.viewer.panel.webview.postMessage.mockResolvedValue(true);

		await harness.viewer.onMessage({ type: 'sqlSchema.clearAll' });

		expect(harness.viewer.sendSnapshotToWebview).toHaveBeenCalledOnce();
		expect(harness.viewer.panel.webview.postMessage).toHaveBeenCalledWith({
			type: 'kustoMutationComplete',
		});
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
