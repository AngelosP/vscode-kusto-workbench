import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ConnectionManagerViewerV2 } from '../../../src/host/connectionManagerViewer';
import { sqlSchemaPrincipalFingerprint, sqlSchemaTargetSignature, SQL_SCHEMA_CACHE_VERSION } from '../../../src/host/sqlEditorSchema';
import { captureSqlSchemaCacheGeneration } from '../../../src/host/sqlSchemaCacheGeneration';

function createViewerHarness(): ConnectionManagerViewerV2 & Record<string, any> {
	const viewer = Object.create(ConnectionManagerViewerV2.prototype) as ConnectionManagerViewerV2 & Record<string, any>;
	viewer.pendingKustoPublicationAcks = new Map();
	viewer.kustoSearchOwnersByToken = new Map();
	viewer.postKustoPublication = vi.fn(async (message: unknown) => await Promise.resolve(viewer.panel?.webview?.postMessage(message)) !== false);
	return viewer;
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

function installKustoPreviewOwner(viewer: ConnectionManagerViewerV2 & Record<string, any>): void {
	viewer.context ??= { globalStorageUri: vscode.Uri.file('/preview-owner') };
	viewer.connectionCache = { captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })) };
	viewer.authPreferences = {
		getConnectionSessionGeneration: (connectionId: string) => {
			const connection = viewer.connectionManager.getConnections().find((candidate: any) => candidate.id === connectionId);
			return connection ? viewer.kustoClient.getConnectionSessionGeneration(connection) : 0;
		},
		waitForProviderAccountRefresh: vi.fn(async () => undefined),
	};
	const runWithSnapshot = viewer.connectionManager.runWithLeaveNoTraceSnapshotLock
		?? (async (run: (snapshot: any) => unknown) => await run({
			clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {},
		}));
	viewer.connectionManager.runWithLeaveNoTraceSnapshotLock = runWithSnapshot;
	const executeQueryWithIdentity = viewer.kustoClient.executeQueryWithIdentity;
	viewer.kustoClient.executeQueryWithIdentity = vi.fn(async (...args: any[]) => {
		const result = await executeQueryWithIdentity(...args);
		const gate = args[3];
		if (gate) {
			const connection = args[0];
			await runWithSnapshot((policy: any) => gate(
				connection, result.accountPartition, result.dispatchIdentity.authSessionGeneration,
				policy, async () => undefined,
			));
		}
		return result;
	});
}

function createSqlConnectionTestHarness(options: { accountId?: string; authType?: 'aad' | 'sql-login' } = {}) {
	const viewer = createViewerHarness();
	const authType = options.authType ?? 'aad';
	let connection: any = {
		id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', port: 1433,
		database: 'master', authType, ...(authType === 'sql-login' ? { username: 'user' } : {}),
	};
	let accountId = options.accountId;
	let revocationGeneration = 0;
	const cachedDatabases: Record<string, string[]> = {};
	const globalState = {
		get: vi.fn((key: string) => {
			if (key === 'sql.auth.serverAccountMap') return accountId ? { 'server.example': accountId } : {};
			if (key === 'sql.connectionManager.cachedDatabases') return cachedDatabases;
			return undefined;
		}),
		update: vi.fn(async (key: string, value: unknown) => {
			if (key === 'sql.connectionManager.cachedDatabases') {
				for (const existing of Object.keys(cachedDatabases)) delete cachedDatabases[existing];
				Object.assign(cachedDatabases, value);
			}
		}),
	};
	const manager = {
		getConnection: vi.fn(() => connection),
		getConnections: vi.fn(() => connection ? [connection] : []),
		assertConnectionCurrent: vi.fn(async () => undefined),
		setPassword: vi.fn(async () => undefined),
		updateConnectionAndPassword: vi.fn(async (_id: string, updates: Record<string, unknown>) => {
			connection = { ...connection, ...updates };
		}),
	};
	const getDatabases = vi.fn<(...args: any[]) => Promise<string[]>>();
	const executeQuery = vi.fn<(...args: any[]) => Promise<any>>();
	const getDatabaseSchema = vi.fn<(...args: any[]) => Promise<any>>();
	const assertSqlConnectionAllowed = vi.fn(async () => undefined);
	const dispatchSqlConnectionAllowed = vi.fn(async (_connectionId: string, dispatch: () => unknown) => await dispatch());
	const postMessage = vi.fn();
	viewer.context = { globalState };
	viewer.panel = { webview: { postMessage } };
	viewer.sqlDeps = {
		getSqlConnectionManager: () => manager,
		getSqlClient: () => ({ getDatabases, executeQuery, getDatabaseSchema }),
		assertSqlConnectionAllowed,
		dispatchSqlConnectionAllowed,
		dispatchSqlOwnerAllowed: async (captured: any, _principal: string, expectedRevocation: number, dispatch: () => unknown) => {
			if (expectedRevocation !== revocationGeneration) throw new Error('Leave No Trace generation changed');
			return dispatchSqlConnectionAllowed(captured.id, dispatch);
		},
		dispatchSqlOwnerSnapshot: async (dispatch: (snapshot: any) => unknown) => await dispatch({
			policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {} },
			connections: connection ? [connection] : [], connectionVersion: 1,
			accountsByServer: accountId ? { 'server.example': accountId } : {}, principalVersion: 1,
		}),
		dispatchSqlPolicySnapshot: async (dispatch: (policy: any) => unknown) => await dispatch({ connectionIds: [], version: 1, globallyBlocked: false }),
		getSqlRevocationGeneration: () => revocationGeneration,
	};
	viewer._sqlTestConnectionRequestIdByConnectionId = new Map();
	return {
		viewer,
		manager,
		getDatabases,
		executeQuery,
		getDatabaseSchema,
		postMessage,
		globalState,
		cachedDatabases,
		assertSqlConnectionAllowed,
		dispatchSqlConnectionAllowed,
		getConnection: () => connection,
		setConnection: (value: any) => { connection = value; },
		setAccountId: (value: string | undefined) => { accountId = value; },
		setRevocationGeneration: (value: number) => { revocationGeneration = value; },
	};
}

function sqlTestMessage(connection: any, password?: string) {
	return {
		type: 'sql.connection.test' as const,
		id: connection.id,
		name: connection.name,
		serverUrl: connection.serverUrl,
		port: connection.port,
		dialect: connection.dialect,
		authType: connection.authType,
		username: connection.username,
		database: connection.database,
		...(password !== undefined ? { password } : {}),
	};
}

async function flushAsyncDispatch(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe('ConnectionManagerViewerV2 schema search mapping', () => {
	it('fails a Connection Manager Kusto publication closed when applied and revoke acknowledgements are lost', async () => {
		vi.useFakeTimers();
		try {
			const viewer = Object.create(ConnectionManagerViewerV2.prototype) as ConnectionManagerViewerV2 & Record<string, any>;
			viewer.pendingKustoPublicationAcks = new Map();
			const postMessage = vi.fn(async () => true);
			viewer.panel = { webview: { postMessage } };

			const publishing = viewer.postKustoPublication({ type: 'searchResults', requestId: 'lost-ack', results: [] });
			await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
			const stage = postMessage.mock.calls[0][0];
			await viewer.onMessage({
				type: 'kustoPublicationAck', publicationId: stage.publicationId, phase: 'staged', accepted: true,
			});
			await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));

			await vi.advanceTimersByTimeAsync(6_000);

			await expect(publishing).resolves.toBe(false);
			expect(postMessage).toHaveBeenCalledWith({
				type: 'kustoPublicationRevoke', publicationId: stage.publicationId,
			});
			expect(viewer.pendingKustoPublicationAcks.size).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects old-target SQL preview rows during final canonical admission', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		const result = deferred<any>();
		let targetCurrent = true;
		harness.executeQuery.mockReturnValue(result.promise);
		harness.manager.assertConnectionCurrent.mockImplementation(async () => {
			if (!targetCurrent) throw new Error('SQL connection changed while credentials were being resolved.');
		});

		const pending = harness.viewer.onMessage({
			type: 'sql.table.preview', connectionId: 'sql-1', database: 'Db', tableName: 'dbo.Secret',
		});
		await vi.waitFor(() => expect(harness.executeQuery).toHaveBeenCalledOnce());
		targetCurrent = false;
		result.resolve({ columns: [{ name: 'Secret' }], rows: [['old-target-row']], metadata: {} });
		await pending;

		const terminal = harness.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'sql.tablePreviewResult');
		expect(terminal).toEqual([expect.objectContaining({ success: false })]);
		expect(terminal).not.toContainEqual(expect.objectContaining({ success: true, rows: [['old-target-row']] }));
	});

	it('does not publish SQL preview rows when canonical LNT admission rejects', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		harness.executeQuery.mockResolvedValue({ columns: [{ name: 'Secret' }], rows: [['blocked-row']], metadata: {} });
		harness.dispatchSqlConnectionAllowed.mockRejectedValueOnce(new Error('Leave No Trace committed'));

		await harness.viewer.onMessage({
			type: 'sql.table.preview', connectionId: 'sql-1', database: 'Db', tableName: 'dbo.Secret',
		});

		const terminal = harness.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'sql.tablePreviewResult');
		expect(terminal).toEqual([expect.objectContaining({ success: false })]);
		expect(terminal).not.toContainEqual(expect.objectContaining({ success: true, rows: [['blocked-row']] }));
	});

	it('does not publish SQL preview rows after an LNT enable-disable interval', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		const result = deferred<any>();
		harness.executeQuery.mockReturnValue(result.promise);

		const pending = harness.viewer.onMessage({
			type: 'sql.table.preview', connectionId: 'sql-1', database: 'Db', tableName: 'dbo.Secret',
		});
		await vi.waitFor(() => expect(harness.executeQuery).toHaveBeenCalledOnce());
		harness.setRevocationGeneration(2);
		result.resolve({ columns: [{ name: 'Secret' }], rows: [['revoked-row']], metadata: {} });
		await pending;

		const terminal = harness.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'sql.tablePreviewResult');
		expect(terminal).toEqual([expect.objectContaining({ success: false })]);
		expect(terminal).not.toContainEqual(expect.objectContaining({ success: true, rows: [['revoked-row']] }));
	});
	it('includes Kusto column docstrings in cached schema search result snippets', () => {
		const viewer = createViewerHarness();
		viewer.connectionManager = {
			getConnections: vi.fn(() => [{ id: 'c1', name: 'MyCluster', clusterUrl: 'https://mycluster.kusto.windows.net' }]),
		};

		const results = viewer._mapKustoSchemaMatches([
			{
				clusterUrl: 'https://mycluster.kusto.windows.net',
				database: 'AlphaDb',
				kind: 'columnDocString',
				name: 'alphaCol',
				table: 'AlphaRoot',
				type: 'long',
				docString: 'Primary event count for the current window',
			},
		], { tables: true }, { tables: true });

		expect(results).toEqual([
			expect.objectContaining({
				category: 'column',
				name: 'alphaCol',
				parentName: 'AlphaRoot',
				matchContext: 'alphaCol: long - Primary event count for the current window',
			}),
		]);
	});

	it('searches Kusto column docstrings in freshly loaded schemas', () => {
		const viewer = createViewerHarness();
		const results = viewer._searchSingleKustoSchema(
			{
				tables: ['AlphaRoot'],
				columnTypesByTable: { AlphaRoot: { alphaCol: 'long' } },
				columnDocStrings: { 'AlphaRoot.alphaCol': 'Primary event count for the current window' },
			},
			'https://mycluster.kusto.windows.net',
			'AlphaDb',
			{ id: 'c1', name: 'MyCluster', clusterUrl: 'https://mycluster.kusto.windows.net' },
			/event count/i,
			{ tables: true },
			{ tables: true },
		);

		expect(results).toEqual([
			expect.objectContaining({
				category: 'column',
				name: 'alphaCol',
				parentName: 'AlphaRoot',
				matchContext: 'alphaCol: long - Primary event count for the current window',
			}),
		]);
	});
});

describe('ConnectionManagerViewerV2 database refresh', () => {
	it('releases Kusto snapshot admission between contended SQL owner attempts', async () => {
		const viewer = createViewerHarness();
		const retry = deferred<void>();
		const continueRetry = deferred<void>();
		let kustoHeld = false;
		let attempts = 0;
		viewer.snapshotRevision = 0;
		viewer.panel = { webview: { postMessage: vi.fn(async () => true) } };
		viewer.connectionManager = {
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => {
				expect(kustoHeld).toBe(false);
				kustoHeld = true;
				try { return await run({ clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {} }); }
				finally { kustoHeld = false; }
			}),
		};
		viewer.buildSnapshot = vi.fn(async (revision: number) => ({
			revision, timestamp: Date.now(), activeKind: 'kusto', connections: [], accounts: [], favorites: [],
			cachedDatabases: {}, expandedClusters: [], leaveNoTraceClusters: [], sqlAvailable: true,
			sqlConnections: [], sqlCachedDatabases: {}, sqlExpandedConnections: [], sqlFavorites: [],
			sqlLeaveNoTrace: [], sqlStateVersions: { policy: 1, connections: 1, principals: 1 },
			sqlCacheOwners: {}, sqlDialects: [], searchState: {},
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

	it('publishes Kusto state while omitting SQL when SQL policy refresh fails', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn();
		viewer.snapshotRevision = 0;
		viewer.panel = { webview: { postMessage } };
		viewer.sqlDeps = {
			refreshSqlLeaveNoTracePolicy: vi.fn(async () => { throw new Error('SQL policy unavailable'); }),
			getSqlConnectionManager: () => ({ getConnections: () => [{ id: 'sql-secret' }] }),
		};
		viewer.authPreferences = {
			getAccounts: vi.fn(async () => []), getPreference: vi.fn(() => ({ mode: 'automatic' })),
			getPreferredAccountId: vi.fn(() => undefined), getConnectionSessionGeneration: vi.fn(() => 0),
		};
		viewer.connectionManager = {
			getConnections: vi.fn(() => [{ id: 'c1', name: 'Kusto', clusterUrl: 'https://cluster.kusto.windows.net' }]),
			getLeaveNoTraceClusters: vi.fn(() => []),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({ clusterKeys: [], globallyBlocked: false })),
		};
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a') };
		viewer.getActiveKind = vi.fn(() => 'kusto');
		viewer.getFavorites = vi.fn(() => []);
		viewer.getCachedDatabases = vi.fn(() => ({ c1: ['Db'] }));
		viewer.getExpandedClusters = vi.fn(() => ['c1']);
		viewer.getSearchState = vi.fn(() => ({}));

		await viewer.sendSnapshotToWebview();

		expect(postMessage).toHaveBeenCalledWith({
			type: 'snapshot',
			snapshot: expect.objectContaining({
				sqlAvailable: false,
				connections: [expect.objectContaining({ id: 'c1' })],
				sqlConnections: [], sqlCachedDatabases: {}, sqlFavorites: [],
			}),
		});
	});

	it('replaces populated SQL state when final policy settlement fails', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn();
		const refreshPolicy = vi.fn()
			.mockResolvedValueOnce([])
			.mockRejectedValueOnce(new Error('final policy failure'));
		viewer.snapshotRevision = 0;
		viewer.context = { globalState: { get: vi.fn(() => undefined) } };
		viewer.panel = { webview: { postMessage } };
		viewer.sqlDeps = {
			refreshSqlLeaveNoTracePolicy: refreshPolicy,
			getSqlLeaveNoTraceConnectionIds: () => [],
			getSqlStateVersions: () => ({ policy: 1, principals: 1, connections: 1 }),
			getSqlConnectionManager: () => ({
				getConnections: () => [{ id: 'sql-secret', name: 'Secret', dialect: 'mssql', serverUrl: 'secret.example', authType: 'aad' }],
			}),
		};
		viewer.getSqlCachedDatabases = vi.fn(async () => ({ 'sql-secret': ['SecretDb'] }));
		viewer.getSqlFavorites = vi.fn(() => [{ name: 'Secret', connectionId: 'sql-secret', database: 'SecretDb' }]);
		viewer.getSqlExpandedConnections = vi.fn(() => ['sql-secret']);
		viewer.authPreferences = {
			getAccounts: vi.fn(async () => []), getPreference: vi.fn(() => ({ mode: 'automatic' })),
			getPreferredAccountId: vi.fn(() => undefined), getConnectionSessionGeneration: vi.fn(() => 0),
		};
		viewer.connectionManager = {
			getConnections: vi.fn(() => [{ id: 'c1', name: 'Kusto', clusterUrl: 'https://cluster.kusto.windows.net' }]),
			getLeaveNoTraceClusters: vi.fn(() => []),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({ clusterKeys: [], globallyBlocked: false })),
		};
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a') };
		viewer.getActiveKind = vi.fn(() => 'kusto');
		viewer.getFavorites = vi.fn(() => []);
		viewer.getCachedDatabases = vi.fn(() => ({ c1: ['Db'] }));
		viewer.getExpandedClusters = vi.fn(() => ['c1']);
		viewer.getSearchState = vi.fn(() => ({}));

		await viewer.sendSnapshotToWebview();

		expect(postMessage).toHaveBeenCalledWith({
			type: 'snapshot',
			snapshot: expect.objectContaining({
				sqlAvailable: false,
				sqlConnections: [], sqlCachedDatabases: {}, sqlFavorites: [],
			}),
		});
	});

	it('keeps the previous cached list when live discovery returns zero databases', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn();
		const connection = { id: 'c1', name: 'MyCluster', clusterUrl: 'https://mycluster.kusto.windows.net' };
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {},
			})),
		};
		viewer.context = { globalStorageUri: vscode.Uri.file('/database-zero') };
		viewer.connectionCache = {
			captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })),
			setDatabases: vi.fn(async () => true),
		};
		viewer.authPreferences = {
			getConnectionSessionGeneration: vi.fn(() => 0), waitForProviderAccountRefresh: vi.fn(async () => undefined),
		};
		viewer.kustoClient = {
			getAccountPartition: vi.fn(() => 'partition-a'), getConnectionSessionGeneration: vi.fn(() => 0),
			getDatabasesWithIdentity: vi.fn(async () => ({
				databases: [], accountPartition: 'partition-a', fromCache: false,
				cacheGeneration: { global: 0, connection: 0, partition: 0 },
			})),
			isAuthenticationError: vi.fn(() => false),
		};
		viewer.panel = { webview: { postMessage } };
		viewer.getCachedDatabases = vi.fn(() => ({ c1: ['CachedDb'] }));
		viewer.traceDatabaseList = vi.fn();
		const warning = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);

		await viewer.onMessage({ type: 'cluster.refreshDatabases', connectionId: 'c1' });

		expect(postMessage).toHaveBeenNthCalledWith(1, { type: 'loadingDatabases', connectionId: 'c1' });
		expect(postMessage).toHaveBeenNthCalledWith(2, {
			type: 'databasesLoaded',
			connectionId: 'c1',
			databases: ['CachedDb'],
			warning: true,
		});
		expect(warning).toHaveBeenCalledWith("Couldn't refresh the database list (received 0 databases). Keeping the previous cached list.");
	});
});

describe('ConnectionManagerViewerV2 new KQLX files', () => {
	it('serializes the exact connection authority and hint for same-cluster connections', async () => {
		const viewer = createViewerHarness();
		const targetUri = vscode.Uri.file('C:/work/GuestDb.kqlx');
		const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile').mockResolvedValue(undefined);
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(targetUri as any);
		vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue({
			getText: () => new TextDecoder().decode(writeFile.mock.calls.at(-1)?.[1] ?? new Uint8Array()),
			lineCount: 1,
			save: vi.fn(async () => true),
		} as any);
		viewer.connectionManager = {
			getConnections: vi.fn(() => [
				{ id: 'home', name: 'Home', clusterUrl: 'https://shared.kusto.windows.net', authorityId: 'home.onmicrosoft.com' },
				{ id: 'guest', name: 'Guest', clusterUrl: 'shared', authorityId: 'resource.onmicrosoft.com' },
			]),
		};

		await viewer.onMessage({
			type: 'database.openInNewFile',
			connectionId: 'guest',
			clusterUrl: 'https://shared.kusto.windows.net',
			database: 'GuestDb',
		});

		expect(writeFile).toHaveBeenCalledOnce();
		const content = new TextDecoder().decode(writeFile.mock.calls[0][1]);
		const file = JSON.parse(content);
		expect(file.state.sections[0]).toMatchObject({
			type: 'query',
			clusterUrl: 'shared',
			authorityId: 'resource.onmicrosoft.com',
			connectionIdHint: 'guest',
			database: 'GuestDb',
		});
	});

	it('serializes the exact SQL connection owner for same-host connections', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		const guest = {
			id: 'sql-guest', name: 'Guest SQL', dialect: 'mssql', serverUrl: 'server.example', port: 1433,
			database: 'GuestDb', authType: 'sql-login', username: 'GuestUser',
		};
		harness.setConnection(guest);
		const targetUri = vscode.Uri.file('C:/work/GuestDb.sqlx');
		const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile').mockResolvedValue(undefined);
		writeFile.mockClear();
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(targetUri as any);
		vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue({
			getText: () => new TextDecoder().decode(writeFile.mock.calls.at(-1)?.[1] ?? new Uint8Array()),
			lineCount: 1,
			save: vi.fn(async () => true),
		} as any);

		await harness.viewer.onMessage({
			type: 'sql.database.openInNewFile',
			connectionId: guest.id,
			database: guest.database,
		});

		expect(writeFile).toHaveBeenCalledOnce();
		const file = JSON.parse(new TextDecoder().decode(writeFile.mock.calls[0][1]));
		expect(file.state.sections[0]).toMatchObject({
			type: 'sql',
			serverUrl: guest.serverUrl,
			connectionIdHint: guest.id,
			targetSignature: sqlSchemaTargetSignature(guest as any),
			database: guest.database,
		});
		expect(harness.manager.assertConnectionCurrent).toHaveBeenCalledWith(guest);
	});
});

describe('ConnectionManagerViewerV2 mutation completion', () => {
	it('posts the final snapshot only after explicit account persistence settles', async () => {
		let settlePreference!: () => void;
		const preferenceGate = new Promise<void>(resolve => { settlePreference = resolve; });
		const events: string[] = [];
		const viewer = createViewerHarness();
		viewer.connectionManager = {
			addConnection: vi.fn(async () => ({ id: 'c1', name: 'Guest', clusterUrl: 'https://cluster.kusto.windows.net' })),
		};
		viewer.authPreferences = {
			getAccounts: vi.fn(async () => [{ id: 'account-1', label: 'Account one' }]),
			setExplicitAccount: vi.fn(async () => {
				await preferenceGate;
				events.push('preference');
			}),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => { events.push('snapshot'); });
		viewer.panel = { webview: { postMessage: vi.fn((message: { type: string }) => { events.push(message.type); }) } };

		const completion = viewer.onMessage({
			type: 'connection.add',
			name: 'Guest',
			clusterUrl: 'https://cluster.kusto.windows.net',
			authorityId: 'resource.onmicrosoft.com',
			accountId: 'account-1',
		});
		await Promise.resolve();
		expect(events).toEqual([]);

		settlePreference();
		await completion;
		expect(events).toEqual(['preference', 'snapshot', 'connectionMutationComplete']);
	});

	it.each(['add', 'edit', 'test'] as const)('returns terminal failure for malformed Authority during %s', async action => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn();
		viewer.connectionManager = {
			getConnections: vi.fn(() => action === 'edit' ? [{ id: 'c1', name: 'Stored', clusterUrl: 'https://cluster.kusto.windows.net' }] : []),
			addConnection: vi.fn(),
			updateConnection: vi.fn(),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage } };
		viewer.traceDatabaseList = vi.fn();

		const authorityId = 'https://login.microsoftonline.com/tenant';
		if (action === 'add') await viewer.onMessage({ type: 'connection.add', name: 'Bad', clusterUrl: 'https://cluster.kusto.windows.net', authorityId });
		if (action === 'edit') await viewer.onMessage({ type: 'connection.edit', id: 'c1', name: 'Bad', clusterUrl: 'https://cluster.kusto.windows.net', authorityId });
		if (action === 'test') await viewer.onMessage({ type: 'connection.test', name: 'Bad', clusterUrl: 'https://cluster.kusto.windows.net', authorityId });

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: action === 'test' ? 'testConnectionResult' : 'connectionMutationComplete',
			success: false,
		}));
	});
});

describe('ConnectionManagerViewerV2 table preview identity', () => {
	it('completes a preview when first automatic sign-in establishes the account partition', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let currentPartition: string | undefined;
		viewer.connectionManager = { getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 0) };
		viewer.kustoClient = {
			executeQueryWithIdentity: vi.fn(async () => {
				currentPartition = 'partition-first-sign-in';
				return {
					accountPartition: currentPartition,
					leaveNoTraceRevision: 0,
					dispatchIdentity: {
						dispatchAttempt: 1, connectionRevision: 0, leaveNoTraceRevision: 0,
						connectionIdentityKey: 'cluster|', clusterEndpoint: connection.clusterUrl,
						accountPartition: currentPartition, authSessionGeneration: 0, clientActivityId: 'preview-first-sign-in',
					},
					result: { columns: [{ name: 'value', type: 'string' }], rows: [['ready']], metadata: { executionTime: '0.1s' } },
				};
			}),
			getAccountPartition: vi.fn(() => currentPartition),
			getConnectionSessionGeneration: vi.fn(() => 0),
			waitForProviderAccountRefresh: vi.fn(async () => undefined),
			isAuthenticationError: vi.fn(() => false),
		};
		viewer.connectionManager.admitLeaveNoTraceRevision = vi.fn(async (_clusterUrl: string, _revision: number, admit: () => unknown) => ({ admitted: true, value: await Promise.resolve(admit()) }));
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage } };
		installKustoPreviewOwner(viewer);

		await viewer.onMessage({ type: 'table.preview', connectionId: 'c1', database: 'Db', tableName: 'Events' });

		expect(postMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'tablePreviewLoading', connectionId: 'c1', database: 'Db', tableName: 'Events', requestId: expect.any(String) }));
		expect(postMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
			type: 'tablePreviewResult',
			connectionId: 'c1',
			accountPartition: 'partition-first-sign-in',
			success: true,
			rows: [['ready']],
		}));
	});

	it('rejects preview rows after the preview cluster policy generation changes', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn(async () => true);
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster-a.kusto.windows.net' };
		let snapshotCall = 0;
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]),
			getConnectionIncarnation: vi.fn(() => 0),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: ++snapshotCall,
				revocationGenerations: { 'cluster-a': snapshotCall > 1 ? 5 : 4 },
			})),
		};
		viewer.kustoClient = {
			executeQueryWithIdentity: vi.fn(async () => ({
				accountPartition: 'partition-a', leaveNoTraceRevision: 4,
				dispatchIdentity: {
					dispatchAttempt: 1, connectionRevision: 0, leaveNoTraceRevision: 4,
					connectionIdentityKey: 'cluster-a|', clusterEndpoint: connection.clusterUrl,
					accountPartition: 'partition-a', authSessionGeneration: 0, clientActivityId: 'preview-stale-policy',
				},
				result: { columns: ['value'], rows: [['SECRET_ROW']], metadata: {} },
			})),
			getAccountPartition: vi.fn(() => 'partition-a'),
			getConnectionSessionGeneration: vi.fn(() => 0),
			waitForProviderAccountRefresh: vi.fn(async () => undefined),
			isAuthenticationError: vi.fn(() => false),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage } };
		installKustoPreviewOwner(viewer);

		await viewer.onMessage({ type: 'table.preview', connectionId: 'c1', database: 'Db', tableName: 'Events' });

		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ success: true }));
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'tablePreviewResult', success: false, error: expect.stringMatching(/Leave no trace|owner changed/i),
		}));
	});

	it('publishes preview rows when only an unrelated cluster generation changes', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn(async () => true);
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster-a.kusto.windows.net' };
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]),
			getConnectionIncarnation: vi.fn(() => 0),
			admitLeaveNoTraceRevision: vi.fn(async (clusterUrl: string, revision: number, admit: () => unknown) => {
				expect(clusterUrl).toBe(connection.clusterUrl);
				expect(revision).toBe(4);
				return { admitted: true, value: await Promise.resolve(admit()) };
			}),
		};
		viewer.kustoClient = {
			executeQueryWithIdentity: vi.fn(async () => ({
				accountPartition: 'partition-a', leaveNoTraceRevision: 4,
				dispatchIdentity: {
					dispatchAttempt: 1, connectionRevision: 0, leaveNoTraceRevision: 4,
					connectionIdentityKey: 'cluster-a|', clusterEndpoint: connection.clusterUrl,
					accountPartition: 'partition-a', authSessionGeneration: 0, clientActivityId: 'preview-current',
				},
				result: { columns: ['value'], rows: [['ready']], metadata: {} },
			})),
			getAccountPartition: vi.fn(() => 'partition-a'),
			getConnectionSessionGeneration: vi.fn(() => 0),
			waitForProviderAccountRefresh: vi.fn(async () => undefined),
			isAuthenticationError: vi.fn(() => false),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage } };
		installKustoPreviewOwner(viewer);

		await viewer.onMessage({ type: 'table.preview', connectionId: 'c1', database: 'Db', tableName: 'Events' });

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'tablePreviewResult', success: true, rows: [['ready']],
		}));
	});

	it.each([
		['endpoint', { clusterUrl: 'https://cluster-b.kusto.windows.net' }],
		['authority', { authorityId: 'tenant-b.onmicrosoft.com' }],
	] as const)('rejects preview rows after a same-ID %s mutation', async (_label, mutation) => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn(async () => true);
		const original = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster-a.kusto.windows.net', authorityId: 'tenant-a.onmicrosoft.com' };
		let current = original;
		viewer.connectionManager = {
			getConnections: vi.fn(() => [current]),
			getConnectionIncarnation: vi.fn(() => 0),
			admitLeaveNoTraceRevision: vi.fn(async (_clusterUrl: string, _revision: number, admit: () => unknown) => ({ admitted: true, value: await Promise.resolve(admit()) })),
		};
		viewer.kustoClient = {
			executeQueryWithIdentity: vi.fn(async () => {
				current = { ...original, ...mutation };
				return {
					accountPartition: 'partition-a', leaveNoTraceRevision: 2,
					dispatchIdentity: {
						dispatchAttempt: 1, connectionRevision: 0, leaveNoTraceRevision: 2,
						connectionIdentityKey: 'cluster-a|tenant-a.onmicrosoft.com', clusterEndpoint: original.clusterUrl,
						authorityId: 'tenant-a.onmicrosoft.com', accountPartition: 'partition-a', authSessionGeneration: 0, clientActivityId: 'preview-old-target',
					},
					result: { columns: ['value'], rows: [['SECRET_A']], metadata: {} },
				};
			}),
			getAccountPartition: vi.fn(() => 'partition-a'),
			getConnectionSessionGeneration: vi.fn(() => 0),
			waitForProviderAccountRefresh: vi.fn(async () => undefined),
			isAuthenticationError: vi.fn(() => false),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage } };
		installKustoPreviewOwner(viewer);

		await viewer.onMessage({ type: 'table.preview', connectionId: 'c1', database: 'Db', tableName: 'Events' });

		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ success: true }));
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'tablePreviewResult', success: false, error: expect.stringMatching(/target changed|owner changed/i),
		}));
	});

	it('rejects preview rows after a same-ID target changes A to B and back to A', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn(async () => true);
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster-a.kusto.windows.net', authorityId: 'common' };
		let incarnation = 1;
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]),
			getConnectionIncarnation: vi.fn(() => incarnation),
			admitLeaveNoTraceRevision: vi.fn(async (_clusterUrl: string, _revision: number, admit: () => unknown) => ({ admitted: true, value: await Promise.resolve(admit()) })),
		};
		viewer.kustoClient = {
			executeQueryWithIdentity: vi.fn(async () => {
				incarnation = 3;
				return {
					accountPartition: 'partition-a', leaveNoTraceRevision: 2,
					dispatchIdentity: {
						dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 2,
						connectionIdentityKey: 'cluster-a|common', clusterEndpoint: connection.clusterUrl,
						authorityId: 'common', accountPartition: 'partition-a', authSessionGeneration: 0, clientActivityId: 'preview-aba',
					},
					result: { columns: ['value'], rows: [['SECRET_ABA']], metadata: {} },
				};
			}),
			getAccountPartition: vi.fn(() => 'partition-a'),
			getConnectionSessionGeneration: vi.fn(() => 0),
			waitForProviderAccountRefresh: vi.fn(async () => undefined),
			isAuthenticationError: vi.fn(() => false),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage } };
		installKustoPreviewOwner(viewer);

		await viewer.onMessage({ type: 'table.preview', connectionId: 'c1', database: 'Db', tableName: 'Events' });

		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ success: true }));
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'tablePreviewResult', success: false, error: expect.stringMatching(/target changed|owner changed/i),
		}));
	});

	it('rejects preview rows after same-account session recreation with unchanged partition', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn(async () => true);
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let authGeneration = 0;
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 0),
			admitLeaveNoTraceRevision: vi.fn(async (_cluster: string, _revision: number, admit: () => unknown) => ({ admitted: true, value: await Promise.resolve(admit()) })),
		};
		viewer.kustoClient = {
			executeQueryWithIdentity: vi.fn(async () => {
				authGeneration = 1;
				return {
					accountPartition: 'partition-a', leaveNoTraceRevision: 0,
					dispatchIdentity: {
						dispatchAttempt: 1, connectionRevision: 0, leaveNoTraceRevision: 0,
						connectionIdentityKey: 'cluster|', clusterEndpoint: connection.clusterUrl,
						accountPartition: 'partition-a', authSessionGeneration: 0, clientActivityId: 'preview-old-session',
					},
					result: { columns: ['Secret'], rows: [['OLD_SESSION_ROW']], metadata: {} },
				};
			}),
			getAccountPartition: vi.fn(() => 'partition-a'),
			getConnectionSessionGeneration: vi.fn(() => authGeneration),
			waitForProviderAccountRefresh: vi.fn(async () => undefined),
			isAuthenticationError: vi.fn(() => false),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage } };
		installKustoPreviewOwner(viewer);

		await viewer.onMessage({ type: 'table.preview', connectionId: 'c1', database: 'Db', tableName: 'Events' });

		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ success: true }));
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'tablePreviewResult', success: false, error: expect.stringMatching(/Authentication changed|owner changed/i),
		}));
		expect(JSON.stringify(postMessage.mock.calls)).not.toContain('OLD_SESSION_ROW');
	});

	it('waits for queued provider refresh before admitting preview rows', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn(async () => true);
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		const refresh = deferred<void>();
		let authGeneration = 0;
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 0),
			admitLeaveNoTraceRevision: vi.fn(async (_cluster: string, _revision: number, admit: () => unknown) => ({ admitted: true, value: await Promise.resolve(admit()) })),
		};
		viewer.kustoClient = {
			executeQueryWithIdentity: vi.fn(async () => ({
				accountPartition: 'partition-a', leaveNoTraceRevision: 0,
				dispatchIdentity: {
					dispatchAttempt: 1, connectionRevision: 0, leaveNoTraceRevision: 0,
					connectionIdentityKey: 'cluster|', clusterEndpoint: connection.clusterUrl,
					accountPartition: 'partition-a', authSessionGeneration: 0, clientActivityId: 'preview-queued-session',
				},
				result: { columns: ['Secret'], rows: [['QUEUED_OLD_SESSION_ROW']], metadata: {} },
			})),
			getAccountPartition: vi.fn(() => 'partition-a'),
			getConnectionSessionGeneration: vi.fn(() => authGeneration),
			waitForProviderAccountRefresh: vi.fn(async () => refresh.promise),
			isAuthenticationError: vi.fn(() => false),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage } };
		viewer.postKustoPublication = vi.fn(async (message: unknown) => await postMessage(message));
		installKustoPreviewOwner(viewer);

		const preview = viewer.onMessage({ type: 'table.preview', connectionId: 'c1', database: 'Db', tableName: 'Events' });
		await vi.waitFor(() => expect(viewer.kustoClient.waitForProviderAccountRefresh).toHaveBeenCalledOnce());
		expect(viewer.postKustoPublication).not.toHaveBeenCalled();
		authGeneration = 1;
		refresh.resolve();
		await preview;

		expect(viewer.postKustoPublication).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'tablePreviewResult', success: false, error: expect.stringContaining('Authentication changed'),
		}));
		expect(JSON.stringify(postMessage.mock.calls)).not.toContain('QUEUED_OLD_SESSION_ROW');
	});
});

describe('ConnectionManagerViewerV2 persisted search ownership', () => {
	it('preserves the establishing Connection Manager search on first automatic sign-in', () => {
		const viewer = createViewerHarness();
		const abort = vi.fn();
		viewer._searchAbortController = { abort };
		viewer.activeKustoSearchOwners = new Map([['c1', {}]]);
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);

		viewer.handleKustoAuthPreferenceChange({
			connectionIds: ['c1'], reason: 'success', accountPartition: 'partition-a', firstEstablishment: true,
		});

		expect(abort).not.toHaveBeenCalled();
		expect(viewer.sendSnapshotToWebview).toHaveBeenCalledOnce();
	});

	it('aborts an old-session Connection Manager search after later auth invalidation', () => {
		const viewer = createViewerHarness();
		const abort = vi.fn();
		viewer._searchAbortController = { abort };
		viewer.activeKustoSearchOwners = new Map([['c1', {}]]);
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);

		viewer.handleKustoAuthPreferenceChange({ connectionIds: ['c1'], reason: 'sessions-changed' });

		expect(abort).toHaveBeenCalledOnce();
	});

	it('strips protected Kusto explorer metadata while retaining the cluster row', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'secret', name: 'Secret', clusterUrl: 'https://secret.kusto.windows.net' };
		viewer.context = { globalState: { get: vi.fn(), update: vi.fn(async () => undefined) } };
		viewer.connectionManager = { getConnections: vi.fn(() => [connection]), normalizeClusterUrl: (value: string) => value };
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a') };
		viewer.authPreferences = {
			getAccounts: vi.fn(async () => []), getPreference: vi.fn(() => ({ mode: 'automatic' })),
			getPreferredAccountId: vi.fn(() => 'account-a'), getConnectionSessionGeneration: vi.fn(() => 0),
		};
		viewer.getFavorites = vi.fn(() => [{ name: 'Secret favorite', connectionId: 'secret', clusterUrl: connection.clusterUrl, database: 'SecretDb' }]);
		viewer.getCachedDatabases = vi.fn(() => ({ secret: ['SecretDb'] }));
		viewer.getExpandedClusters = vi.fn(() => ['secret']);
		viewer.getActiveKind = vi.fn(() => 'kusto');

		const snapshot = await viewer.buildSnapshot(1, true, {
			clusterKeys: ['secret'], globallyBlocked: false, version: 2,
		});

		expect(snapshot.connections).toEqual([expect.objectContaining({ id: 'secret' })]);
		expect(snapshot.cachedDatabases).toEqual({});
		expect(snapshot.favorites).toEqual([]);
		expect(snapshot.expandedClusters).toEqual([]);
	});

	it.each(['cluster.expand', 'cluster.refreshDatabases', 'database.getSchema', 'database.refreshSchema'] as const)(
		'does not invoke Kusto discovery for protected %s',
		async type => {
			const viewer = createViewerHarness();
			const connection = { id: 'secret', name: 'Secret', clusterUrl: 'https://secret.kusto.windows.net' };
			viewer.connectionManager = {
				getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
				runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
					clusterKeys: ['secret'], globallyBlocked: false, version: 2, revocationGenerations: { secret: 1 },
				})),
			};
			viewer.connectionCache = { captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })) };
			viewer.context = { globalStorageUri: vscode.Uri.file('/protected-explorer') };
			viewer.authPreferences = {
				getConnectionSessionGeneration: vi.fn(() => 0), waitForProviderAccountRefresh: vi.fn(async () => undefined),
			};
			viewer.kustoClient = {
				getAccountPartition: vi.fn(() => 'partition-a'), getConnectionSessionGeneration: vi.fn(() => 0),
				getDatabasesWithIdentity: vi.fn(), getDatabaseSchema: vi.fn(),
			};
			viewer.panel = { webview: { postMessage: vi.fn(async () => true) } };

			if (type === 'cluster.expand' || type === 'cluster.refreshDatabases') {
				await viewer.onMessage({ type, connectionId: 'secret' });
			} else if (type === 'database.getSchema') {
				await viewer.onMessage({ type, connectionId: 'secret', database: 'SecretDb' });
			} else {
				await viewer.onMessage({ type, connectionId: 'secret', clusterUrl: connection.clusterUrl, database: 'SecretDb' });
			}

			expect(viewer.kustoClient.getDatabasesWithIdentity).not.toHaveBeenCalled();
			expect(viewer.kustoClient.getDatabaseSchema).not.toHaveBeenCalled();
		},
	);

	it.each(['cached', 'refresh-cached', 'everything'] as const)(
		'excludes protected Kusto owners before %s search work begins',
		async scope => {
			const viewer = createViewerHarness();
			const connection = { id: 'protected-1', name: 'Protected', clusterUrl: 'https://protected.kusto.windows.net' };
			const postMessage = vi.fn(async () => true);
			const getDatabases = vi.fn(async () => ['SecretDb']);
			const getDatabaseSchema = vi.fn(async () => ({ schema: { tables: ['SecretTable'] }, accountPartition: 'partition-a' }));
			viewer.panel = { webview: { postMessage } };
			viewer.context = {
				globalStorageUri: { fsPath: '', path: '/protected-search', toString: () => 'file:///protected-search' } as vscode.Uri,
				globalState: { get: vi.fn(), update: vi.fn(async () => undefined) },
			};
			viewer.connectionManager = {
				getConnections: vi.fn(() => [connection]),
				getConnectionIncarnation: vi.fn(() => 1),
				runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
					clusterKeys: ['protected'], globallyBlocked: false,
				})),
			};
			viewer.kustoClient = {
				getAccountPartition: vi.fn(() => 'partition-a'),
				getDatabases,
				getDatabaseSchema,
				isAuthenticationError: vi.fn(() => false),
			};

			await viewer.onMessage({
				type: 'search', requestId: `protected-${scope}`, query: 'Secret', scope, kind: 'kusto',
				categories: { clusters: true, databases: true, tables: true, functions: true },
				contentToggles: { tables: true, functions: true },
			});
			await vi.waitFor(() => expect(viewer._activeSearchRequestId).toBeNull());

			expect(getDatabases).not.toHaveBeenCalled();
			expect(getDatabaseSchema).not.toHaveBeenCalled();
			expect(postMessage.mock.calls.map(call => call[0])).not.toContainEqual(expect.objectContaining({
				type: 'searchResults', results: expect.arrayContaining([expect.objectContaining({ connectionId: connection.id })]),
			}));
		},
	);

	it('drops protected Kusto rows from a late search.saveState publication', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'protected-1', name: 'Protected', clusterUrl: 'https://protected.kusto.windows.net' };
		let persisted: unknown;
		viewer.context = { globalState: {
			get: vi.fn(),
			update: vi.fn(async (_key: string, value: unknown) => { persisted = value; }),
		} };
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: ['protected'], globallyBlocked: false,
			})),
		};
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a') };

		await viewer.onMessage({
			type: 'search.saveState', kind: 'kusto', state: {
				query: 'Secret', scope: 'everything', lastSearchTimestamp: 123,
				lastResults: [{ kind: 'kusto', connectionId: connection.id, name: 'SecretTable' }],
			},
		});

		expect(persisted).toEqual(expect.objectContaining({ lastResults: [] }));
		expect(JSON.stringify(persisted)).not.toContain('SecretTable');
	});

	it('drops delayed Kusto search rows after the same connection rotates from principal A to B', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let partition = 'partition-a';
		let persisted: any;
		viewer.context = { globalState: {
			get: vi.fn(),
			update: vi.fn(async (_key: string, value: unknown) => { persisted = value; }),
		} };
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]),
			getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1,
			})),
		};
		viewer.kustoClient = { getAccountPartition: vi.fn(() => partition) };
		const owners = await viewer.captureKustoSearchOwners();
		const ownerToken = viewer.rememberKustoSearchOwners(owners);
		partition = 'partition-b';

		await viewer.onMessage({
			type: 'search.saveState', kind: 'kusto', state: {
				query: 'Secret', scope: 'cached', lastSearchTimestamp: 123,
				lastResults: [{
					kind: 'kusto', connectionId: connection.id, name: 'SecretTable',
					kustoSearchOwnerToken: ownerToken,
				}],
			},
		});

		expect(persisted.lastResults).toEqual([]);
		expect(JSON.stringify(persisted)).not.toContain('SecretTable');
	});

	it('drops delayed Kusto search rows after a policy enable-disable interval', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let revocationGeneration = 0;
		let persisted: any;
		viewer.context = { globalState: {
			get: vi.fn(), update: vi.fn(async (_key: string, value: unknown) => { persisted = value; }),
		} };
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: revocationGeneration + 1,
				revocationGenerations: { cluster: revocationGeneration },
			})),
		};
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a') };
		const ownerToken = viewer.rememberKustoSearchOwners(await viewer.captureKustoSearchOwners());
		revocationGeneration = 2;

		await viewer.onMessage({
			type: 'search.saveState', kind: 'kusto', state: {
				query: 'Secret', scope: 'cached', lastSearchTimestamp: 123,
				lastResults: [{
					kind: 'kusto', connectionId: connection.id, name: 'SecretTable', kustoSearchOwnerToken: ownerToken,
				}],
			},
		});

		expect(persisted.lastResults).toEqual([]);
		expect(JSON.stringify(persisted)).not.toContain('SecretTable');
	});

	it('does not publish live Kusto search rows after a policy enable-disable interval', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let revocationGeneration = 0;
		const postKustoPublication = vi.fn(async () => true);
		viewer.postKustoPublication = postKustoPublication;
		viewer.context = {
			globalStorageUri: { fsPath: '', path: '/live-policy-interval', toString: () => 'file:///live-policy-interval' } as vscode.Uri,
			globalState: { get: vi.fn(() => ({ c1: ['SecretDb'] })), update: vi.fn(async () => undefined) },
		};
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: revocationGeneration + 1,
				revocationGenerations: { cluster: revocationGeneration },
			})),
		};
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a'), isAuthenticationError: vi.fn(() => false) };

		await viewer.onMessage({
			type: 'search', requestId: 'live-policy-interval', query: 'SecretDb', scope: 'cached', kind: 'kusto',
			categories: { clusters: false, databases: true, tables: false, functions: false }, contentToggles: {},
		});
		revocationGeneration = 2;
		await vi.waitFor(() => expect(viewer._activeSearchRequestId).toBeNull());

		const publishedRows = postKustoPublication.mock.calls
			.map(call => call[0] as any)
			.filter(message => message.type === 'searchResults')
			.flatMap(message => message.results || []);
		expect(publishedRows).toEqual([]);
	});

	it('keeps a Kusto search owner current when only another cluster policy changes', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		viewer.context = { globalStorageUri: vscode.Uri.file('/search-unrelated-policy') };
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1,
				revocationGenerations: { cluster: 0 },
			})),
		};
		viewer.connectionCache = { captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })) };
		viewer.authPreferences = { getConnectionSessionGeneration: vi.fn(() => 0) };
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a') };
		const owner = (await viewer.captureKustoSearchOwners()).get(connection.id);

		expect(viewer.isKustoSearchOwnerCurrent(owner, {
			clusterKeys: ['other'], globallyBlocked: false, version: 2,
			revocationGenerations: { cluster: 0, other: 1 },
		})).toBe(true);
	});

	it('restores an exact Kusto search proof after unrelated account and policy changes', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		const unrelated = { id: 'c2', name: 'Other', clusterUrl: 'https://other.kusto.windows.net' };
		let persistedState: any;
		viewer.context = {
			globalStorageUri: vscode.Uri.file('/search-proof-reopen'),
			globalState: {
				get: vi.fn((key: string) => key === 'connectionManager.searchState' ? persistedState : undefined),
				update: vi.fn(async () => undefined),
			},
		};
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection, unrelated]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1,
				revocationGenerations: { cluster: 0, other: 0 },
			})),
		};
		viewer.connectionCache = { captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })) };
		viewer.authPreferences = {
			getAccounts: vi.fn(async () => []), getPreference: vi.fn(() => ({ mode: 'automatic' })),
			getPreferredAccountId: vi.fn(() => undefined), getConnectionSessionGeneration: vi.fn(() => 0),
		};
		viewer.kustoClient = {
			getAccountPartition: vi.fn((candidate: any) => candidate.id === 'c1' ? 'partition-a' : 'partition-b'),
		};
		viewer.getActiveKind = vi.fn(() => 'kusto');
		viewer.getFavorites = vi.fn(() => []);
		viewer.getCachedDatabases = vi.fn(() => ({}));
		viewer.getExpandedClusters = vi.fn(() => []);
		const owner = (await viewer.captureKustoSearchOwners()).get(connection.id);
		persistedState = {
			query: 'StillCurrent', scope: 'cached', lastSearchTimestamp: 123,
			kustoPrincipalFingerprint: 'before-unrelated-account-change', kustoPolicyVersion: 1,
			lastResults: [{
				kind: 'kusto', connectionId: connection.id, name: 'StillCurrent',
				kustoSearchOwner: viewer.persistedKustoSearchOwner(owner),
			}],
		};

		const snapshot = await viewer.buildSnapshot(1, false, {
			clusterKeys: ['other'], globallyBlocked: false, version: 2,
			revocationGenerations: { cluster: 0, other: 1 },
		});

		expect(snapshot.searchState.lastResults).toEqual([
			expect.objectContaining({ connectionId: 'c1', name: 'StillCurrent' }),
		]);
	});

	it('drops persisted Kusto search proof after schema cache clear', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let schemaGeneration = 0;
		let persisted: any;
		viewer.context = {
			globalStorageUri: vscode.Uri.file('/search-cache-clear'),
			globalState: { update: vi.fn(async (_key: string, value: unknown) => { persisted = value; }) },
		};
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: { cluster: 0 },
			})),
		};
		viewer.connectionCache = { captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })) };
		viewer.authPreferences = { getConnectionSessionGeneration: vi.fn(() => 0) };
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a') };
		const owner = (await viewer.captureKustoSearchOwners()).get(connection.id);
		const proof = viewer.persistedKustoSearchOwner(owner);
		schemaGeneration++;
		proof.schemaCacheGeneration = { ...proof.schemaCacheGeneration, global: schemaGeneration };

		await viewer.onMessage({
			type: 'search.saveState', kind: 'kusto', state: {
				query: 'Secret', scope: 'cached', lastSearchTimestamp: 1,
				lastResults: [{ kind: 'kusto', connectionId: connection.id, name: 'Secret', kustoSearchOwner: proof }],
			},
		});

		expect(persisted.lastResults).toEqual([]);
	});

	it('rejects live and persisted Kusto search rows after same-account session recreation', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let authGeneration = 0;
		let persisted: any;
		viewer.context = {
			globalStorageUri: { fsPath: '', path: '/search-auth-generation', toString: () => 'file:///search-auth-generation' } as vscode.Uri,
			globalState: {
				get: vi.fn((key: string) => key === 'kusto.cachedDatabases' ? { c1: ['SecretDb'] } : undefined),
				update: vi.fn(async (_key: string, value: unknown) => { persisted = value; }),
			},
		};
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {},
			})),
		};
		viewer.connectionCache = { captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })) };
		viewer.authPreferences = {
			getConnectionSessionGeneration: vi.fn(() => authGeneration), waitForProviderAccountRefresh: vi.fn(async () => undefined),
		};
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a'), isAuthenticationError: vi.fn(() => false) };
		const owners = await viewer.captureKustoSearchOwners();
		const ownerToken = viewer.rememberKustoSearchOwners(owners);
		authGeneration = 1;

		const owner = owners.get(connection.id);
		expect(viewer.isKustoSearchOwnerCurrent(owner, { clusterKeys: [], globallyBlocked: false, version: 1 })).toBe(false);
		await viewer.onMessage({
			type: 'search.saveState', kind: 'kusto', state: {
				query: 'SecretDb', scope: 'cached', lastSearchTimestamp: 123,
				lastResults: [{
					kind: 'kusto', connectionId: connection.id, name: 'SecretDb', kustoSearchOwnerToken: ownerToken,
				}],
			},
		});

		expect(persisted.lastResults).toEqual([]);
		expect(JSON.stringify(persisted.lastResults)).not.toContain('SecretDb');
	});

	it('never persists or restores SQL search result rows', async () => {
		const viewer = createViewerHarness();
		let persisted: any = {
			query: 'Secret', scope: 'cached', lastResults: [{ connectionId: 'sql-1', name: 'SecretProcedure', matchContext: 'secret body' }],
			lastSearchTimestamp: 123,
		};
		viewer.context = {
			globalState: {
				get: vi.fn((key: string) => key === 'connectionManager.activeKind' ? 'sql' : persisted),
				update: vi.fn(async (_key: string, value: unknown) => { persisted = value; }),
			},
		};

		expect(viewer.getSearchState()).toEqual(expect.objectContaining({ lastResults: [], lastSearchTimestamp: 0 }));
		await viewer.setSearchState({
			query: 'New', scope: 'everything', lastResults: [{ connectionId: 'sql-1', name: 'NewSecret' }],
			lastSearchTimestamp: 456,
		});
		expect(persisted).toEqual(expect.objectContaining({
			query: 'New', scope: 'everything', lastResults: [], lastSearchTimestamp: 0,
		}));
		viewer.connectionManager = {
			getConnections: vi.fn(() => [{ id: 'kusto-1', name: 'Kusto', clusterUrl: 'https://kusto-1.kusto.windows.net' }]),
			getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false,
			})),
		};
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a') };

		await viewer.setSearchState({
			query: 'Mixed', scope: 'cached',
			lastResults: [
				{ kind: 'sql', connectionId: 'sql-1', name: 'SecretSql', matchContext: 'secret body' },
				{ kind: 'kusto', connectionId: 'kusto-1', name: 'SafeKusto' },
			],
			lastSearchTimestamp: 789,
		}, 'kusto');
		expect(persisted.lastResults).toEqual([]);
		expect(JSON.stringify(persisted)).not.toContain('SecretSql');
	});

	it.each(['target', 'principal'] as const)('drops cached SQL schema matches when the %s changes during disk search', async change => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		const storageUri = { fsPath: '', path: '/cached-search-race', toString: () => 'file:///cached-search-race' } as vscode.Uri;
		harness.viewer.context = { ...harness.viewer.context, globalStorageUri: storageUri };
		harness.viewer._activeSearchRequestId = `cached-${change}`;
		const startingConnection = harness.getConnection();
		const principalFingerprint = sqlSchemaPrincipalFingerprint(harness.viewer.context, startingConnection)!;
		const cacheGeneration = await captureSqlSchemaCacheGeneration(storageUri);
		const entry = {
			version: SQL_SCHEMA_CACHE_VERSION,
			schema: { tables: ['SecretTable'], columnsByTable: {} },
			timestamp: Date.now(),
			serverUrl: startingConnection.serverUrl,
			database: 'DbA',
			connectionId: startingConnection.id,
			cacheGeneration,
			principalFingerprint,
			targetSignature: sqlSchemaTargetSignature(startingConnection),
		};
		const pendingRead = deferred<Uint8Array>();
		const fsApi = vscode.workspace.fs as any;
		const originalReadDirectory = fsApi.readDirectory;
		const originalReadFile = fsApi.readFile;
		fsApi.readDirectory = vi.fn(async () => [['entry.json', 1]]);
		fsApi.readFile = vi.fn(() => pendingRead.promise);
		const sendResults = vi.fn();

		try {
			const search = harness.viewer._searchCachedSchemasForSearch(
				'sql', 'SecretTable', { tables: true }, { tables: true },
				`cached-${change}`, new AbortController().signal, sendResults,
			);
			await vi.waitFor(() => expect(fsApi.readFile).toHaveBeenCalledOnce());
			if (change === 'target') harness.setConnection({ ...startingConnection, port: 1434 });
			else harness.setAccountId('account-b');
			pendingRead.resolve(Buffer.from(JSON.stringify(entry), 'utf8'));
			await search;

			expect(sendResults).not.toHaveBeenCalled();
		} finally {
			if (originalReadDirectory === undefined) delete fsApi.readDirectory;
			else fsApi.readDirectory = originalReadDirectory;
			fsApi.readFile = originalReadFile;
		}
	});

	it('drops live SQL schema matches when the target changes during Search Everything', async () => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		const pendingSchema = deferred<any>();
		harness.getDatabases.mockResolvedValue(['DbA']);
		const getDatabaseSchema = vi.fn(() => pendingSchema.promise);
		harness.viewer.sqlDeps.getSqlClient = () => ({ getDatabases: harness.getDatabases, getDatabaseSchema });
		harness.viewer._activeSearchRequestId = 'search-1';
		const sendResults = vi.fn();
		const signal = new AbortController().signal;

		const search = harness.viewer._refreshSchemasForSearch(
			'sql', 'everything', 'SecretTable', { tables: true }, { tables: true },
			'search-1', signal, sendResults, vi.fn(),
		);
		await vi.waitFor(() => expect(getDatabaseSchema).toHaveBeenCalledOnce());
		harness.setConnection({ ...harness.getConnection(), serverUrl: 'server-b.example' });
		pendingSchema.resolve({ tables: ['SecretTable'], columnsByTable: {} });
		await search;

		expect(sendResults).not.toHaveBeenCalled();
	});

	it('drops live SQL schema matches when the principal changes during Search Everything', async () => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		const pendingSchema = deferred<any>();
		harness.getDatabases.mockResolvedValue(['DbA']);
		const getDatabaseSchema = vi.fn(() => pendingSchema.promise);
		harness.viewer.sqlDeps.getSqlClient = () => ({ getDatabases: harness.getDatabases, getDatabaseSchema });
		harness.viewer._activeSearchRequestId = 'search-2';
		const sendResults = vi.fn();

		const search = harness.viewer._refreshSchemasForSearch(
			'sql', 'everything', 'SecretTable', { tables: true }, { tables: true },
			'search-2', new AbortController().signal, sendResults, vi.fn(),
		);
		await vi.waitFor(() => expect(getDatabaseSchema).toHaveBeenCalledOnce());
		harness.setAccountId('account-b');
		pendingSchema.resolve({ tables: ['SecretTable'], columnsByTable: {} });
		await search;

		expect(sendResults).not.toHaveBeenCalled();
	});

	it('drops Kusto search results when reopening under a different principal fingerprint', () => {
		const viewer = createViewerHarness();
		viewer.context = { globalState: { get: vi.fn(() => ({
			query: 'SecretA', scope: 'cached', lastResults: [{ name: 'SecretA' }],
			kustoPrincipalFingerprint: 'conn-a|partition-a',
		})) } };
		viewer.getActiveKind = vi.fn(() => 'kusto');
		viewer.getKustoSearchPrincipalFingerprint = vi.fn(() => 'conn-a|partition-b');

		expect(viewer.getSearchState()).toEqual(expect.objectContaining({ lastResults: [], lastSearchTimestamp: 0 }));
	});

	it('drops legacy SQL search rows even under a valid Kusto search fingerprint', () => {
		const viewer = createViewerHarness();
		viewer.getKustoSearchPrincipalFingerprint = vi.fn(() => 'conn-a|partition-a');
		viewer.context = { globalState: { get: vi.fn((key: string) => key === 'connectionManager.activeKind' ? 'kusto' : ({
			query: 'Mixed', scope: 'cached', kustoPrincipalFingerprint: 'conn-a|partition-a',
			lastResults: [
				{ kind: 'sql', connectionId: 'sql-a', name: 'SecretProcedure', matchContext: 'secret body' },
				{ kind: 'kusto', connectionId: 'conn-a', name: 'SafeTable' },
			],
			lastSearchTimestamp: 123,
		})) } };

		expect(viewer.getSearchState()).toEqual(expect.objectContaining({
			lastResults: [{ kind: 'kusto', connectionId: 'conn-a', name: 'SafeTable' }],
			lastSearchTimestamp: 0,
		}));
	});
});

describe('ConnectionManagerViewerV2 favorite prompt ownership', () => {
	it.each(['add', 'rename'] as const)('does not commit an A favorite %s after rotation to B', async action => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let partition = 'partition-a';
		const picked = deferred<string | undefined>();
		vi.spyOn(vscode.window, 'showInputBox').mockReturnValue(picked.promise as any);
		viewer.connectionManager = { getConnections: vi.fn(() => [connection]) };
		viewer.kustoClient = { getAccountPartition: vi.fn(() => partition) };
		viewer.getFavorites = vi.fn(() => action === 'rename' ? [{
			name: 'A favorite', connectionId: 'c1', clusterUrl: connection.clusterUrl, database: 'SecretA',
		}] : []);
		viewer.setFavorites = vi.fn(async () => undefined);
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);

		const prompt = action === 'add'
			? viewer.promptAddFavorite('c1', 'SecretA')
			: viewer.promptRenameFavorite('c1', 'SecretA');
		await Promise.resolve();
		partition = 'partition-b';
		picked.resolve('Changed favorite');
		await prompt;

		expect(viewer.setFavorites).not.toHaveBeenCalled();
	});
});

describe('ConnectionManagerViewerV2 SQL connection test ownership', () => {
	it('returns a terminal failure when Leave No Trace blocks connection testing', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		harness.assertSqlConnectionAllowed.mockRejectedValueOnce(new Error('Leave No Trace blocked'));

		await harness.viewer.onMessage(sqlTestMessage(harness.getConnection()));

		const started = harness.postMessage.mock.calls.map(call => call[0]).find(message => message.type === 'sql.testConnectionStarted');
		expect(started).toBeTruthy();
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sql.testConnectionResult', requestId: started.requestId, success: false,
			message: expect.stringContaining('Leave No Trace'),
		}));
		expect(harness.getDatabases).not.toHaveBeenCalled();
	});

	it.each(['sql.cluster.expand', 'sql.cluster.refreshDatabases'] as const)('allows first AAD identity establishment during %s', async type => {
		const harness = createSqlConnectionTestHarness();
		harness.getDatabases.mockImplementation(async () => {
			harness.setAccountId('account-a');
			return ['DbA'];
		});

		await harness.viewer.onMessage({ type, connectionId: 'sql-1' });

		expect((harness.cachedDatabases as any).entries['sql-1']).toEqual(expect.objectContaining({ databases: ['DbA'] }));
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sql.databasesLoaded', connectionId: 'sql-1', databases: ['DbA'],
		}));
	});

	it('keeps the newest ordinary refresh when responses complete in reverse order', async () => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		const older = deferred<string[]>();
		const newer = deferred<string[]>();
		let invocation = 0;
		harness.getDatabases.mockImplementation(() => (++invocation === 1 ? older.promise : newer.promise));

		const olderRun = harness.viewer.onMessage({ type: 'sql.cluster.refreshDatabases', connectionId: 'sql-1' });
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledTimes(1));
		const newerRun = harness.viewer.onMessage({ type: 'sql.cluster.refreshDatabases', connectionId: 'sql-1' });
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledTimes(2));
		newer.resolve(['CurrentDb']);
		await newerRun;
		older.resolve(['OldDb']);
		await olderRun;

		expect((harness.cachedDatabases as any).entries['sql-1']).toEqual(expect.objectContaining({ databases: ['CurrentDb'] }));
	});

	it('does not resurrect a deleted cache after pending refresh completes', async () => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		const pending = deferred<string[]>();
		harness.getDatabases.mockReturnValue(pending.promise);

		const refresh = harness.viewer.onMessage({ type: 'sql.cluster.refreshDatabases', connectionId: 'sql-1' });
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledOnce());
		await harness.viewer.onMessage({ type: 'sql.cluster.collapse', connectionId: 'sql-1' });
		const { deleteSqlDatabaseCacheEntry } = await import('../../../src/host/sqlDatabaseCache');
		await deleteSqlDatabaseCacheEntry(harness.viewer.context, 'sql.connectionManager.cachedDatabases', 'sql-1');
		pending.resolve(['StaleDb']);
		await refresh;

		expect((harness.cachedDatabases as any).entries).toEqual({});
	});

	it('allows a first AAD test to establish its principal before admitting metadata', async () => {
		const harness = createSqlConnectionTestHarness();
		harness.getDatabases.mockImplementation(async () => {
			harness.setAccountId('account-a');
			return ['DbA'];
		});

		await harness.viewer.onMessage(sqlTestMessage(harness.getConnection()));

		expect((harness.cachedDatabases as any).entries['sql-1']).toEqual(expect.objectContaining({
			version: 1,
			connectionId: 'sql-1',
			databases: ['DbA'],
			principalFingerprint: expect.any(String),
			targetSignature: expect.stringMatching(/^v2:[0-9a-f]{64}$/),
		}));
		expect(harness.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
			type: 'sql.testConnectionResult', connectionId: 'sql-1', success: true,
		}));
	});

	it('uses a draft SQL Login password only for the test operation', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		harness.getDatabases.mockResolvedValue(['Db']);

		await harness.viewer.onMessage(sqlTestMessage(harness.getConnection(), 'draft-password'));

		expect(harness.manager.setPassword).not.toHaveBeenCalled();
		expect(harness.getDatabases).toHaveBeenCalledWith(
			expect.objectContaining(harness.getConnection()),
			{ passwordOverride: 'draft-password', allowUncommittedTarget: false },
		);
	});

	it('correlates a changed SQL Login target failure when no replacement password is supplied', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		await harness.viewer.onMessage(sqlTestMessage({ ...harness.getConnection(), serverUrl: 'changed.example' }));

		const started = harness.postMessage.mock.calls.map(call => call[0]).find(message => message.type === 'sql.testConnectionStarted');
		expect(started).toBeTruthy();
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sql.testConnectionResult', requestId: started.requestId, success: false,
			message: expect.stringContaining('password'),
		}));
		expect(harness.getDatabases).not.toHaveBeenCalled();
	});

	it('uses the stored password when testing an unchanged revisioned SQL Login', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		harness.setConnection({ ...harness.getConnection(), credentialRevision: 1 });
		harness.getDatabases.mockResolvedValue(['Db']);

		await harness.viewer.onMessage(sqlTestMessage(harness.getConnection()));

		expect(harness.getDatabases).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'sql-1', credentialRevision: 1 }),
			{ passwordOverride: undefined, allowUncommittedTarget: false },
		);
		expect(harness.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
			type: 'sql.testConnectionResult', connectionId: 'sql-1', success: true,
		}));
	});

	it('tests every draft target field without publishing databases to the saved owner cache', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		harness.getDatabases.mockResolvedValue(['DraftDb']);
		const draft = {
			...harness.getConnection(),
			name: 'Draft SQL', serverUrl: 'draft.example', port: 1444,
			username: 'DraftUser', database: 'DraftDb',
		};

		await harness.viewer.onMessage(sqlTestMessage(draft, 'draft-password'));

		expect(harness.getDatabases).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'sql-1', name: 'Draft SQL', serverUrl: 'draft.example', port: 1444,
				username: 'DraftUser', database: 'DraftDb',
			}),
			{ passwordOverride: 'draft-password', allowUncommittedTarget: true },
		);
		expect((harness.cachedDatabases as any).entries).toBeUndefined();
	});

	it('admits only the newest overlapping test for an unchanged target', async () => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		const first = deferred<string[]>();
		const second = deferred<string[]>();
		let invocation = 0;
		harness.getDatabases.mockImplementation(() => (++invocation === 1 ? first.promise : second.promise));

		const firstRun = harness.viewer.onMessage(sqlTestMessage(harness.getConnection()));
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledTimes(1));
		const secondRun = harness.viewer.onMessage(sqlTestMessage(harness.getConnection()));
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledTimes(2));
		first.resolve(['OldDb']);
		await firstRun;

		expect((harness.cachedDatabases as any).entries).toEqual({});
		expect(harness.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'sql.testConnectionResult')).toEqual([]);

		second.resolve(['CurrentDb']);
		await secondRun;
		const started = harness.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'sql.testConnectionStarted');
		const terminal = harness.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'sql.testConnectionResult');
		expect(started).toHaveLength(2);
		expect(terminal).toEqual([expect.objectContaining({ requestId: started[1].requestId, success: true })]);
		expect((harness.cachedDatabases as any).entries['sql-1']).toEqual(expect.objectContaining({ databases: ['CurrentDb'] }));
	});

	it('invalidates an owned cache before editing the same connection ID to a new target', async () => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		harness.getDatabases.mockResolvedValue(['DbA']);
		await harness.viewer.onMessage(sqlTestMessage(harness.getConnection()));
		expect((harness.cachedDatabases as any).entries['sql-1']).toEqual(expect.objectContaining({ databases: ['DbA'] }));

		harness.manager.updateConnectionAndPassword = vi.fn(async (_id: string, updates: Record<string, unknown>) => {
			harness.setConnection({ ...harness.getConnection(), ...updates });
		});
		harness.viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		await harness.viewer.onMessage({
			type: 'sql.connection.edit', id: 'sql-1', name: 'SQL B', serverUrl: 'server-b.example',
			dialect: 'mssql', authType: 'aad', database: 'master',
		});

		expect((harness.cachedDatabases as any).entries['sql-1']).toBeUndefined();
		expect(await harness.viewer.getSqlCachedDatabases()).toEqual({});
		expect(harness.manager.updateConnectionAndPassword).toHaveBeenCalledWith('sql-1', expect.objectContaining({ serverUrl: 'server-b.example' }), undefined);
	});

	it('unblocks database discovery when an in-place edit fails and the old record survives', async () => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		harness.manager.updateConnectionAndPassword = vi.fn(async () => { throw new Error('save failed'); });
		harness.viewer.sendSnapshotToWebview = vi.fn(async () => undefined);

		await harness.viewer.onMessage({
			type: 'sql.connection.edit', id: 'sql-1', name: 'SQL B', serverUrl: 'server-b.example',
			dialect: 'mssql', authType: 'aad', database: 'master',
		});

		const { beginSqlDatabaseCacheRequest } = await import('../../../src/host/sqlDatabaseCache');
		await expect(beginSqlDatabaseCacheRequest(harness.viewer.context, 'sql.connectionManager.cachedDatabases', harness.getConnection()))
			.resolves.toEqual(expect.objectContaining({ connectionId: 'sql-1' }));
	});

	it.each(['legacy-array', 'principal-rotated', 'target-edited'] as const)('does not expose a %s database cache', async change => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		if (change === 'legacy-array') {
			(harness.cachedDatabases as any)['sql-1'] = ['LegacyDb'];
		} else {
			harness.getDatabases.mockResolvedValue(['AccountADb']);
			await harness.viewer.onMessage(sqlTestMessage(harness.getConnection()));
			if (change === 'principal-rotated') harness.setAccountId('account-b');
			if (change === 'target-edited') harness.setConnection({ ...harness.getConnection(), serverUrl: 'server-b.example' });
		}

		expect(await harness.viewer.getSqlCachedDatabases()).toEqual({});
	});

	it.each(['edited', 'deleted', 'principal-rotated'] as const)('drops a pending test when its owner is %s', async change => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		const pending = deferred<string[]>();
		harness.getDatabases.mockReturnValue(pending.promise);

		const run = harness.viewer.onMessage(sqlTestMessage(harness.getConnection()));
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledOnce());
		if (change === 'edited') harness.setConnection({ ...harness.getConnection(), database: 'OtherDb' });
		if (change === 'deleted') harness.setConnection(undefined);
		if (change === 'principal-rotated') harness.setAccountId('account-b');
		pending.resolve(['StaleDb']);
		await run;

		expect((harness.cachedDatabases as any).entries).toEqual({});
		expect(harness.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'sql.testConnectionResult')).toEqual([]);
	});
});