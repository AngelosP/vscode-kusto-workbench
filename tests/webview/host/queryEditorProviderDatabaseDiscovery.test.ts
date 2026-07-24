import { describe, expect, it, vi } from 'vitest';

import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import { SqlEditorSessionRegistry } from '../../../src/host/sql/sqlEditorSessionRegistry';

function createProviderHarness(): QueryEditorProvider & Record<string, any> {
	const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
	provider.connection = { sendDatabases: vi.fn(async () => undefined) };
	return provider;
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

function createSqlDiscoveryHarness(options: { accountId?: string; authType?: 'aad' | 'sql-login' } = {}) {
	const provider = createProviderHarness();
	const authType = options.authType ?? 'sql-login';
	let accountId = options.accountId;
	let connection: any = {
		id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', port: 1433,
		database: 'master', authType, ...(authType === 'sql-login' ? { username: 'user-a' } : {}),
	};
	const cachedDatabases: Record<string, string[]> = {};
	const globalState = {
		get: vi.fn((key: string) => {
			if (key === 'sql.auth.serverAccountMap') return accountId ? { 'server.example': accountId } : {};
			if (key === 'sql.connectionManager.cachedDatabases') return { ...cachedDatabases };
			return undefined;
		}),
		update: vi.fn(async (key: string, value: unknown) => {
			if (key === 'sql.connectionManager.cachedDatabases') {
				for (const existing of Object.keys(cachedDatabases)) delete cachedDatabases[existing];
				Object.assign(cachedDatabases, value);
			}
		}),
	};
	const getDatabases = vi.fn<(...args: any[]) => Promise<string[]>>();
	const connectionManager = {
		getConnection: vi.fn(() => connection),
		getConnections: vi.fn(() => connection ? [connection] : []),
		assertConnectionCurrent: vi.fn(async () => undefined),
	};
	const client = { getDatabases };
	provider.context = { globalState };
	provider.sqlWorkbench = {
		connectionManager,
		client,
		leaveNoTracePolicy: { getRevocationGeneration: vi.fn(() => 0) },
		assertSqlConnectionAllowed: vi.fn(async () => undefined),
		dispatchSqlConnectionAllowed: vi.fn(async (_connectionId: string, dispatch: () => unknown) => await dispatch()),
		dispatchSqlOwnerAllowed: vi.fn(async (_connection: unknown, _principal: string, _revocation: number, dispatch: () => unknown) => await dispatch()),
		dispatchSqlOwnerProtection: vi.fn(async (_connection: unknown, _principal: string, _revocation: number, _protected: boolean, dispatch: () => unknown) => await dispatch()),
		dispatchSqlOwnerSnapshot: vi.fn(async (dispatch: (snapshot: any) => unknown) => await dispatch({
			policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {} },
			connections: connection ? [connection] : [], connectionVersion: 1,
			accountsByServer: accountId ? { 'server.example': accountId } : {}, principalVersion: 1,
		})),
		dispatchSqlPolicySnapshot: vi.fn(async (dispatch: (policy: any) => unknown) => await dispatch({
			connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {},
		})),
		isLeaveNoTraceConnection: vi.fn(() => false),
		refreshLeaveNoTracePolicy: vi.fn(async () => []),
		getLeaveNoTraceConnectionIds: vi.fn(() => []),
		getStateVersions: vi.fn(() => ({ policy: 1, principals: 1, connections: 1 })),
	};
	provider.connection.getSqlFavorites = vi.fn(() => []);
	provider.output = { error: vi.fn(), warn: vi.fn() };
	provider.postMessage = vi.fn();
	provider._sqlDatabaseRequestIdByBoxId = new Map();
	provider._closedStsBoxIds = new Set();
	provider._sqlSectionInstanceIdByBoxId = new Map([['sql-box', 'instance-sql-box']]);
	provider.sqlOwnership = new SqlEditorSessionRegistry({ context: provider.context, sqlWorkbench: provider.sqlWorkbench });
	provider.sqlOwnership.adoptTarget('sql-box', 'sql-1', undefined, 7, () => undefined);
	return {
		provider,
		getDatabases,
		globalState,
		cachedDatabases,
		getConnection: () => connection,
		setConnection: (value: any) => { connection = value; },
		setAccountId: (value: string | undefined) => { accountId = value; },
	};
}

async function flushAsyncDispatch(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe('QueryEditorProvider database discovery routing', () => {
	it('keeps passive database discovery non-interactive', async () => {
		const provider = createProviderHarness();

		await provider.handleWebviewMessage({
			type: 'getDatabases',
			connectionId: 'connection-1',
			boxId: 'query-1',
			requestToken: 'request-1',
			requiredDatabase: 'SavedDb',
		});

		expect(provider.connection.sendDatabases).toHaveBeenCalledWith('connection-1', 'query-1', {
			mode: 'passive',
			requestToken: 'request-1',
			requiredDatabase: 'SavedDb',
		});
	});

	it('routes an explicit refresh as interactive', async () => {
		const provider = createProviderHarness();

		await provider.handleWebviewMessage({
			type: 'refreshDatabases',
			connectionId: 'connection-1',
			boxId: 'query-1',
			requestToken: 'request-2',
			requiredDatabase: 'SavedDb',
		});

		expect(provider.connection.sendDatabases).toHaveBeenCalledWith('connection-1', 'query-1', {
			mode: 'interactive-refresh',
			requestToken: 'request-2',
			requiredDatabase: 'SavedDb',
		});
	});
});

describe('QueryEditorProvider SQL database discovery ownership', () => {
	it('discovers protected databases ephemerally without writing the durable cache', async () => {
		const harness = createSqlDiscoveryHarness();
		harness.provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => true);
		harness.getDatabases.mockResolvedValue(['PrivateB', 'PrivateA']);

		await harness.provider.sendSqlDatabases('sql-1', 'sql-box', 'instance-sql-box', true);

		expect(harness.provider.sqlWorkbench.dispatchSqlOwnerProtection).toHaveBeenCalled();
		expect(harness.provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sqlDatabasesData', databases: ['PrivateA', 'PrivateB'],
		}));
		expect(harness.cachedDatabases).toEqual({});
		expect(harness.globalState.update).not.toHaveBeenCalledWith(
			'sql.connectionManager.cachedDatabases', expect.anything(),
		);
	});

	it('echoes the current request and target generation on loading and data', async () => {
		const harness = createSqlDiscoveryHarness();
		harness.getDatabases.mockResolvedValue(['DbB', 'DbA']);

		await harness.provider.sendSqlDatabases('sql-1', 'sql-box', 'instance-sql-box', true);

		const messages = harness.provider.postMessage.mock.calls.map((call: any[]) => call[0]);
		const loading = messages.find((message: any) => message.type === 'sqlDatabasesLoading');
		expect(loading).toMatchObject({ boxId: 'sql-box', sqlConnectionId: 'sql-1', targetGeneration: 7, requestId: expect.any(String) });
		expect(messages).toContainEqual(expect.objectContaining({
			type: 'sqlDatabasesData', boxId: 'sql-box', sqlConnectionId: 'sql-1',
			targetGeneration: 7, requestId: loading.requestId, databases: ['DbA', 'DbB'],
		}));
	});

	it('does not publish databases when canonical admission rejects after discovery', async () => {
		const harness = createSqlDiscoveryHarness();
		harness.getDatabases.mockResolvedValue(['SecretDb']);
		harness.provider.sqlWorkbench.dispatchSqlOwnerAllowed = vi.fn(async () => {
			throw new Error('Leave No Trace committed');
		});

		await harness.provider.sendSqlDatabases('sql-1', 'sql-box', 'instance-sql-box', true);

		expect(harness.provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'sqlDatabasesData',
		}));
	});

	it('allows first AAD discovery to establish the principal once', async () => {
		const harness = createSqlDiscoveryHarness({ authType: 'aad' });
		harness.getDatabases.mockImplementation(async () => {
			harness.setAccountId('account-a');
			return ['DbA'];
		});

		await harness.provider.sendSqlDatabases('sql-1', 'sql-box', 'instance-sql-box', true);

		expect((harness.cachedDatabases as any).entries['sql-1']).toEqual(expect.objectContaining({
			version: 1,
			connectionId: 'sql-1',
			databases: ['DbA'],
			principalFingerprint: expect.any(String),
			targetSignature: expect.stringMatching(/^v2:[0-9a-f]{64}$/),
		}));
		expect(harness.provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'sqlDatabasesData', databases: ['DbA'] }));
	});

	it('admits only the newest overlapping request for an unchanged target', async () => {
		const harness = createSqlDiscoveryHarness();
		const first = deferred<string[]>();
		const second = deferred<string[]>();
		let invocation = 0;
		harness.getDatabases.mockImplementation(() => (++invocation === 1 ? first.promise : second.promise));

		const firstRun = harness.provider.sendSqlDatabases('sql-1', 'sql-box', 'instance-sql-box', true);
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledTimes(1));
		const secondRun = harness.provider.sendSqlDatabases('sql-1', 'sql-box', 'instance-sql-box', true);
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledTimes(2));
		first.resolve(['OldDb']);
		await firstRun;

		expect((harness.cachedDatabases as any).entries).toEqual({});
		expect(harness.provider.postMessage.mock.calls.map((call: any[]) => call[0]).filter((message: any) => message.type === 'sqlDatabasesData')).toEqual([]);

		second.resolve(['CurrentDb']);
		await secondRun;
		const loadingMessages = harness.provider.postMessage.mock.calls.map((call: any[]) => call[0]).filter((message: any) => message.type === 'sqlDatabasesLoading');
		const dataMessages = harness.provider.postMessage.mock.calls.map((call: any[]) => call[0]).filter((message: any) => message.type === 'sqlDatabasesData');
		expect(loadingMessages).toHaveLength(2);
		expect(dataMessages).toEqual([expect.objectContaining({ requestId: loadingMessages[1].requestId, databases: ['CurrentDb'] })]);
		expect((harness.cachedDatabases as any).entries['sql-1']).toEqual(expect.objectContaining({ databases: ['CurrentDb'] }));
	});

	it.each(['legacy-array', 'principal-mismatch', 'target-mismatch'] as const)('ignores an unowned %s cache and performs guarded discovery', async cacheKind => {
		const harness = createSqlDiscoveryHarness();
		if (cacheKind === 'legacy-array') {
			(harness.cachedDatabases as any)['sql-1'] = ['StaleDb'];
		} else {
			harness.cachedDatabases.schemaVersion = 1 as any;
			harness.cachedDatabases.version = 1 as any;
			harness.cachedDatabases.entries = {
				'sql-1': {
					version: 1,
					connectionId: 'sql-1',
					targetSignature: cacheKind === 'target-mismatch' ? 'stale-target' : JSON.stringify({
						dialect: 'mssql', serverUrl: 'server.example', port: 1433, database: 'master', authType: 'sql-login', username: 'user-a',
					}),
					principalFingerprint: cacheKind === 'principal-mismatch' ? 'stale-principal' : 'unused',
					databases: ['StaleDb'],
					writeId: 'stale-write', requestId: 'stale-request', requestVersion: 1, updatedAt: Date.now(),
				},
			};
			harness.cachedDatabases.latestRequestByConnectionId = { 'sql-1': { requestId: 'stale-request', version: 1 } } as any;
			harness.cachedDatabases.deletedAtVersionByConnectionId = {} as any;
			harness.cachedDatabases.clearedAtVersion = 0 as any;
		}
		harness.getDatabases.mockResolvedValue(['FreshDb']);

		await harness.provider.sendSqlDatabases('sql-1', 'sql-box', 'instance-sql-box', false);

		expect(harness.getDatabases).toHaveBeenCalledOnce();
		expect(harness.provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'sqlDatabasesData', databases: ['FreshDb'] }));
		expect((harness.cachedDatabases as any).entries['sql-1']).toEqual(expect.objectContaining({ databases: ['FreshDb'] }));
	});

	it('omits a populated cache from connection snapshots after principal rotation', async () => {
		const harness = createSqlDiscoveryHarness({ accountId: 'account-a', authType: 'aad' });
		harness.getDatabases.mockResolvedValue(['AccountADb']);
		await harness.provider.sendSqlDatabases('sql-1', 'sql-box', 'instance-sql-box', true);

		harness.provider.postMessage.mockClear();
		harness.setAccountId('account-b');
		await harness.provider.sendSqlConnectionsData();

		expect(harness.provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sqlConnectionsData',
			cachedDatabases: {},
		}));
	});

	it('canonically strips protected cache data and principal fingerprints from a stale local snapshot', async () => {
		const harness = createSqlDiscoveryHarness({ accountId: 'account-a', authType: 'aad' });
		(harness.cachedDatabases as any).entries = {
			'sql-1': { databases: ['SecretDb'] },
		};
		harness.provider.sqlWorkbench.dispatchSqlOwnerSnapshot = vi.fn(async (dispatch: (snapshot: any) => unknown) => await dispatch({
			policy: { connectionIds: ['sql-1'], version: 2, globallyBlocked: false, revocationGenerations: { 'sql-1': 1 } },
			connections: [harness.getConnection()], connectionVersion: 1,
			accountsByServer: { 'server.example': 'account-a' }, principalVersion: 1,
		}));

		await harness.provider.sendSqlConnectionsData();

		const message = harness.provider.postMessage.mock.calls.map((call: any[]) => call[0])
			.find((candidate: any) => candidate.type === 'sqlConnectionsData');
		expect(message.sqlLeaveNoTrace).toEqual(['sql-1']);
		expect(message.cachedDatabases).toEqual({});
		expect(message.connections[0]).not.toHaveProperty('principalFingerprint');
	});

	it.each(['edited', 'deleted', 'principal-rotated', 'generation-changed'] as const)('drops metadata when its owner is %s', async change => {
		const harness = createSqlDiscoveryHarness();
		const pending = deferred<string[]>();
		harness.getDatabases.mockReturnValue(pending.promise);

		const run = harness.provider.sendSqlDatabases('sql-1', 'sql-box', 'instance-sql-box', true);
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledOnce());
		if (change === 'edited') harness.setConnection({ ...harness.getConnection(), database: 'OtherDb' });
		if (change === 'deleted') harness.setConnection(undefined);
		if (change === 'principal-rotated') harness.setConnection({ ...harness.getConnection(), username: 'user-b' });
		if (change === 'generation-changed') harness.provider.sqlOwnership.rotateTargetOwner('sql-box');
		pending.resolve(['StaleDb']);
		await run;

		expect((harness.cachedDatabases as any).entries).toEqual({});
		expect(harness.provider.postMessage.mock.calls.map((call: any[]) => call[0]).filter((message: any) =>
			message.type === 'sqlDatabasesData' || message.type === 'sqlDatabasesError')).toEqual([]);
	});
});