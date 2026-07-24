import { describe, it, expect, vi } from 'vitest';
import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import type { KustoConnection } from '../../../src/host/connectionManager';
import type { ExecuteQueryMessage } from '../../../src/host/queryEditorTypes';
import { appendQueryMode, isControlCommand, normalizeControlCommandForExecution } from '../../../src/host/queryEditorUtils';
import { sqlConnectionTargetSignature } from '../../../src/shared/sqlConnectionIdentity';
import { sqlSchemaPrincipalFingerprintForPrincipal } from '../../../src/host/sqlEditorSchema';
import { QueryRunCoordinator } from '../../../src/host/queryRunCoordinator';
import { SqlEditorSessionRegistry } from '../../../src/host/sql/sqlEditorSessionRegistry';
import { SqlExecutionBroker } from '../../../src/host/sql/sqlExecutionBroker';

const TEST_CONNECTION: KustoConnection = {
	id: 'conn-1',
	name: 'Test cluster',
	clusterUrl: 'https://example.kusto.windows.net',
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function queryResult(label: string) {
	return {
		columns: ['label'],
		rows: [[label]],
		metadata: {
			cluster: TEST_CONNECTION.clusterUrl,
			database: 'Samples',
			executionTime: '0.001s',
		},
	};
}

function executeMessage(boxId: string, query: string = 'print x=1'): ExecuteQueryMessage {
	return {
		type: 'executeQuery',
		query,
		connectionId: TEST_CONNECTION.id,
		database: 'Samples',
		boxId,
		queryMode: 'plain',
		cacheEnabled: false,
		cacheValue: 1,
		cacheUnit: 'h',
	};
}

function createProviderHarness() {
	const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
	provider.postMessage = vi.fn();
	provider.refreshConnectionsData = vi.fn(async () => undefined);
	provider.connection = {
		saveLastSelection: vi.fn(async () => undefined),
		findConnection: vi.fn(() => TEST_CONNECTION),
	};
	provider.kustoClient = {
		executeQueryCancelable: vi.fn(),
		getAccountPartition: vi.fn(() => 'partition-current'),
	};
	provider.appendQueryMode = vi.fn((query: string) => query);
	provider.isControlCommand = vi.fn(() => false);
	provider.normalizeControlCommandForExecution = vi.fn((query: string) => normalizeControlCommandForExecution(query));
	provider.buildCacheDirective = vi.fn(() => '');
	provider.logQueryExecutionError = vi.fn();
	provider.formatQueryExecutionErrorForUser = vi.fn((error: unknown) => error instanceof Error ? error.message : String(error));
	provider.output = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), show: vi.fn() };
	return provider;
}

function createSqlProviderHarness() {
	const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
	provider._comparisonOwnerByBoxId = new Map();
	provider._sqlDatabaseRequestIdByBoxId = new Map();
	provider._sqlSectionInstanceIdByBoxId = new Map([['sql_1', 'instance-1']]);
	provider._retiredSqlSectionInstanceIdByBoxId = new Map();
	provider._stsChangeSequenceByBoxId = new Map();
	provider._stsChangeTailByBoxId = new Map();
	provider._closedStsBoxIds = new Set();
	provider._pendingStsTextByBoxId = new Map();
	provider._stsDocumentSequenceByBoxId = new Map();
	provider.pendingComparisonEnsureByRequestId = new Map();
	provider.postMessage = vi.fn();
	provider.output = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	provider.context = {
		globalState: {
			get: vi.fn((key: string) => key === 'sql.auth.serverAccountMap' ? { 'server.example': 'account-a' } : undefined),
		},
	};
	const connectionManager = {
		getConnection: vi.fn(() => ({ id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' })),
		getConnections: vi.fn(() => [{ id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' }]),
		assertConnectionCurrent: vi.fn(async () => undefined),
	};
	const client = { executeQueryCancelable: vi.fn(() => { throw new Error('Leave No Trace blocked'); }) };
	provider.sqlWorkbench = {
		connectionManager,
		client,
		leaveNoTracePolicy: {
			getRevocationGeneration: vi.fn(() => 0),
			assertProtectionMode: vi.fn(async () => undefined),
		},
		ready: vi.fn(async () => undefined),
		serverAccountMap: {
			refresh: vi.fn(async () => undefined),
			getAccountsByServer: vi.fn(() => provider.context.globalState.get('sql.auth.serverAccountMap') ?? {}),
		},
		isLeaveNoTraceConnection: vi.fn(() => false),
		assertSqlConnectionAllowed: vi.fn(async () => undefined),
		dispatchSqlConnectionAllowed: vi.fn(async (_connectionId: string, dispatch: () => unknown) => await dispatch()),
		dispatchSqlOwnerAllowed: vi.fn(async (_connection: unknown, _principal: string, _revocation: number, dispatch: () => unknown) => await dispatch()),
		dispatchSqlOwnerProtection: vi.fn(async (_connection: unknown, _principal: string, _revocation: number, _protected: boolean, dispatch: () => unknown) => await dispatch()),
		dispatchSqlOwnerSnapshot: vi.fn(async (dispatch: (snapshot: any) => unknown) => await dispatch({
			policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {} },
			connections: connectionManager.getConnections(), connectionVersion: 1,
			accountsByServer: { 'server.example': 'account-a' }, principalVersion: 1,
		})),
		runWithSqlOwnerSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
			policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {} },
			connections: connectionManager.getConnections(), connectionVersion: 1,
			accountsByServer: { 'server.example': 'account-a' }, principalVersion: 1,
		})),
	};
	provider.sendSqlConnectionsData = vi.fn(async () => undefined);
	provider.sqlOwnership = new SqlEditorSessionRegistry({ context: provider.context, sqlWorkbench: provider.sqlWorkbench });
	provider.sqlOwnership.adoptTarget('sql_1', 'sql-1', 'Db', 1, () => undefined);
	const owner = provider.getSqlResultOwner('sql_1');
	provider.sqlOwnership.ownerTokenByBoxId.set('sql_1', { token: 'owner-token', owner });
	provider._queryRunCoordinator = new QueryRunCoordinator();
	provider.sqlExecutionBroker = new SqlExecutionBroker({
		queryRuns: provider._queryRunCoordinator,
		getOwnerToken: (boxId: string) => provider.sqlOwnership.getOwnerToken(boxId),
		postMessage: (message: unknown) => provider.postMessage(message),
	});
	let executionSequence = 0;
	const executeSqlQueryFromWebview = provider.executeSqlQueryFromWebview.bind(provider);
	provider.executeSqlQueryFromWebview = (message: Record<string, unknown>) => executeSqlQueryFromWebview({
		sectionInstanceId: 'instance-1',
		executionId: `test-execution-${++executionSequence}`,
		...message,
	});
	return provider;
}

function stsOwner(owner: Record<string, unknown> | undefined, sectionInstanceId = 'instance-1') {
	return owner ? { ...owner, sectionInstanceId } : owner;
}

describe('QueryEditorProvider cancellation orchestration', () => {
	it('preserves a retired target tombstone across same-instance section reorder', async () => {
		const provider = createSqlProviderHarness();
		provider._openedStsBoxIds = new Set();
		provider._latestStsConnectSequenceByBoxId = new Map();
		provider.copilot = { cancelCopilotWriteQuery: vi.fn() };

		expect(provider.retireSqlTarget('sql_1', 'instance-1', 2)).toBe(true);
		await provider.handleWebviewMessage({
			type: 'sqlSectionOpen', boxId: 'sql_1', sectionInstanceId: 'instance-1',
		} as any);

		expect(provider.sqlOwnership.getGeneration('sql_1')).toBe(2);
		expect(provider.sqlOwnership.adoptTarget('sql_1', 'sql-1', 'Db', 1, () => undefined)).toBe('rejected');
	});

	it('resets a retired target tombstone for a new section incarnation', async () => {
		const provider = createSqlProviderHarness();
		provider._openedStsBoxIds = new Set();
		provider._latestStsConnectSequenceByBoxId = new Map();
		provider.copilot = { cancelCopilotWriteQuery: vi.fn() };

		provider.handleStsDidClose('sql_1');
		expect(provider.sqlOwnership.getGeneration('sql_1')).toBe(2);
		await provider.handleWebviewMessage({
			type: 'sqlSectionOpen', boxId: 'sql_1', sectionInstanceId: 'instance-2',
		} as any);

		expect(provider.sqlOwnership.getGeneration('sql_1')).toBe(0);
		expect(provider.sqlOwnership.adoptTarget('sql_1', 'sql-1', 'Db', 1, () => undefined)).toBe('changed');
	});

	it('retires in-flight work before replacing a live section incarnation', async () => {
		const provider = createSqlProviderHarness();
		provider._openedStsBoxIds = new Set(['sql_1']);
		provider._latestStsConnectSequenceByBoxId = new Map([['sql_1', 4]]);
		provider._sqlDatabaseRequestIdByBoxId = new Map([['sql_1', 'database-request']]);
		provider._pendingStsTextByBoxId = new Map([['sql_1', 'SELECT old']]);
		provider._stsLanguageService = { closeDocumentForOwner: vi.fn(() => true) };
		provider.copilot = {
			cancelCopilotWriteQuery: vi.fn(), cancelCopilotQueryTarget: vi.fn(),
		};
		provider.sqlOwnership.setComparisonOwner('comparison-1', {
			sourceBoxId: 'sql_1', connectionId: 'sql-1', copilotSequence: 7,
		});
		const reject = vi.fn();
		provider.pendingComparisonEnsureByRequestId.set('comparison-request', {
			resolve: vi.fn(), reject, timer: setTimeout(() => undefined, 10_000),
			sourceBoxId: 'sql_1', sqlConnectionId: 'sql-1', copilotSequence: 7,
		});

		await provider.handleWebviewMessage({
			type: 'sqlSectionOpen', boxId: 'sql_1', sectionInstanceId: 'instance-2',
		} as any);

		expect(provider._sqlSectionInstanceIdByBoxId.get('sql_1')).toBe('instance-2');
		expect(provider._latestStsConnectSequenceByBoxId.has('sql_1')).toBe(false);
		expect(provider._sqlDatabaseRequestIdByBoxId.has('sql_1')).toBe(false);
		expect(provider._pendingStsTextByBoxId.has('sql_1')).toBe(false);
		expect(provider.sqlOwnership.getComparisonOwner('comparison-1')).toBeUndefined();
		expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: 'Canceled' }));
		expect(provider.copilot.cancelCopilotQueryTarget).toHaveBeenCalledWith('sql_1', 'comparison-1', 7);
	});

	it('retires an active target when its connection is deleted', async () => {
		const provider = createSqlProviderHarness();
		const connection = provider.sqlWorkbench.connectionManager.getConnection('sql-1');
		provider.sqlConnectionSignatureById = new Map([['sql-1', sqlConnectionTargetSignature(connection)]]);
		provider.sqlPersistenceInvalidationEmitter = { fire: vi.fn() };
		provider._openedStsBoxIds = new Set(['sql_1']);
		provider._latestStsConnectSequenceByBoxId = new Map([['sql_1', 3]]);
		provider._stsLanguageService = { closeDocumentForOwner: vi.fn(() => true) };
		provider.copilot = { invalidateSqlConnections: vi.fn(), cancelCopilotWriteQuery: vi.fn() };
		provider.sendSqlConnectionsData = vi.fn(async () => undefined);

		await provider.handleSqlConnectionsChanged([]);

		expect(provider.sqlOwnership.getTarget('sql_1')).toBeUndefined();
		expect(provider.sqlOwnership.getGeneration('sql_1')).toBe(2);
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sqlConnectionOwnerChanged', boxId: 'sql_1', sectionInstanceId: 'instance-1',
			targetGeneration: 2,
		}));
	});

	it('retires SQL ownership without closing the live section when its database disappears', () => {
		const provider = createSqlProviderHarness();
		const previousOwner = provider.getSqlResultOwner('sql_1');
		provider._openedStsBoxIds = new Set(['sql_1']);
		provider._latestStsConnectSequenceByBoxId = new Map([['sql_1', 3]]);
		provider._sqlDatabaseRequestIdByBoxId = new Map([['sql_1', 'request-1']]);
		provider._stsLanguageService = { closeDocumentForOwner: vi.fn(() => true) };
		provider.copilot = { cancelCopilotWriteQuery: vi.fn() };
		provider.sqlOwnership.setComparisonOwner('comparison-1', { sourceBoxId: 'sql_1', connectionId: 'sql-1' });

		expect(provider.retireSqlTarget('sql_1', 'instance-1', 2)).toBe(true);

		expect(provider._stsLanguageService.closeDocumentForOwner).toHaveBeenCalledWith('sql_1', stsOwner(previousOwner));
		expect(provider.sqlOwnership.getTarget('sql_1')).toBeUndefined();
		expect(provider.sqlOwnership.getGeneration('sql_1')).toBe(2);
		expect(provider.sqlOwnership.getComparisonOwner('comparison-1')).toBeUndefined();
		expect(provider._closedStsBoxIds.has('sql_1')).toBe(false);
		expect(provider._sqlSectionInstanceIdByBoxId.get('sql_1')).toBe('instance-1');
		expect(provider._latestStsConnectSequenceByBoxId.has('sql_1')).toBe(false);
		expect(provider._sqlDatabaseRequestIdByBoxId.has('sql_1')).toBe(false);
	});

	it('rejects an owner token removed while canonical validation is pending', async () => {
		const provider = createSqlProviderHarness();
		const validation = deferred<void>();
		const issued = provider.sqlOwnership.getIssuedOwner('sql_1');
		provider.sqlOwnership.assertOwnerAllowed = vi.fn(() => validation.promise);

		const assertion = provider.assertSqlOwnerToken('sql_1', 'owner-token');
		await vi.waitFor(() => expect(provider.sqlOwnership.assertOwnerAllowed).toHaveBeenCalledOnce());
		provider.sqlOwnership.revokeOwnerToken('sql_1');
		validation.resolve();

		await expect(assertion).rejects.toThrow('owner token changed');
		expect(issued).toBeTruthy();
	});

	it('posts a correlated generic terminal response when SQL owner preflight rejects', async () => {
			const provider = createSqlProviderHarness();
			provider.assertSqlOwnerToken = vi.fn(async () => { throw new Error('C:\\private\\sql-policy.lock failed'); });
			provider.copilot = {
				startCopilotWriteQuery: vi.fn(),
			};

			await provider.handleWebviewMessage({
				type: 'startCopilotWriteQuery', boxId: 'sql_1', flavor: 'sql', sqlOwnerToken: 'owner-token',
			} as any);

			expect(provider.postMessage).toHaveBeenCalledWith({
				type: 'copilotWriteQueryDone', boxId: 'sql_1', ok: false,
				message: 'SQL section owner changed. Retry the request.', ownerToken: 'owner-token',
			});
			expect(JSON.stringify(provider.postMessage.mock.calls)).not.toContain('sql-policy.lock');
			expect(provider.copilot.startCopilotWriteQuery).not.toHaveBeenCalled();
	});

	it('Stop during SQL owner preflight prevents service dispatch', async () => {
		const provider = createSqlProviderHarness();
		const ownerValidation = deferred<any>();
		provider.assertSqlOwnerToken = vi.fn(() => ownerValidation.promise);
		provider.copilot = {
			startCopilotWriteQuery: vi.fn(),
			cancelCopilotWriteQuery: vi.fn(),
		};

		const start = provider.handleWebviewMessage({
			type: 'startCopilotWriteQuery', boxId: 'sql_1', flavor: 'sql', sqlOwnerToken: 'owner-token',
		} as any);
		await vi.waitFor(() => expect(provider.assertSqlOwnerToken).toHaveBeenCalledOnce());
		await provider.handleWebviewMessage({ type: 'cancelCopilotWriteQuery', boxId: 'sql_1' } as any);
		ownerValidation.resolve(provider.sqlOwnership.getIssuedOwner('sql_1'));
		await start;

		expect(provider.copilot.startCopilotWriteQuery).not.toHaveBeenCalled();
		expect(provider.copilot.cancelCopilotWriteQuery).toHaveBeenCalledWith('sql_1');
		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'copilotWriteQueryDone', boxId: 'sql_1', ok: false, message: 'Canceled.', ownerToken: 'owner-token',
		});
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'SQL section owner changed. Retry the request.' }));
	});

	it('invalidates all SQL Copilot owners before panel disposal clears editor state', () => {
		const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
		let disposePanel!: () => void;
		const panel = { onDidDispose: vi.fn((handler: () => void) => { disposePanel = handler; }) } as any;
		provider.panel = panel;
		provider._panelDisposed = false;
		provider.sqlOwnership = {
			listComparisonOwners: () => [{ boxId: 'comparison_1', owner: { sourceBoxId: 'sql_1', connectionId: 'sql-a' } }],
		};
		provider.copilot = { invalidateSqlConnections: vi.fn() };
		provider.sqlLeaveNoTraceSubscription = { dispose: vi.fn() };
		provider.stsRuntimeSubscription = { dispose: vi.fn() };
		provider.sqlConnectionsSubscription = { dispose: vi.fn() };
		provider.sqlPrincipalsSubscription = { dispose: vi.fn() };
		provider.sqlPersistenceInvalidationEmitter = { dispose: vi.fn() };
		provider.disposeSqlEditorSession = vi.fn();
		provider.clearCursorStatusForProvider = vi.fn();
		provider.cancelAllRunningQueries = vi.fn();
		provider.kustoClient = { dispose: vi.fn() };
		provider.disconnectToolOrchestrator = vi.fn();
		provider.connection = { dispose: vi.fn() };

		provider.registerPanelDisposal(panel);
		disposePanel();

		expect(provider.copilot.invalidateSqlConnections).toHaveBeenCalledWith([], ['comparison_1']);
		expect(provider.disposeSqlEditorSession).toHaveBeenCalledOnce();
	});

	it('ignores policy messages after the panel webview getter is disposed', () => {
		const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
		provider._panelDisposed = true;
		provider.output = { warn: vi.fn() };
		provider.panel = Object.defineProperty({}, 'webview', {
			get: () => { throw new Error('Webview is disposed'); },
		});

		expect(() => provider.postMessage({ type: 'sqlLeaveNoTraceData', connectionIds: ['sql-1'] })).not.toThrow();
		expect(provider.output.warn).not.toHaveBeenCalled();
	});

	it('contains a rejected live webview post without an unhandled rejection', async () => {
		const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
		provider._panelDisposed = false;
		provider.output = { warn: vi.fn() };
		provider.panel = { webview: { postMessage: vi.fn(() => Promise.reject(new Error('delivery failed'))) } };

		await expect(provider.postMessage({ type: 'test' })).resolves.toBe(false);
		expect(provider.output.warn).toHaveBeenCalledWith('[webview] postMessage failed: delivery failed');
	});

	it('retries SQL language initialization in the same editor after a canceled startup', async () => {
		const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
		const manager = {
			onNotification: vi.fn(() => ({ dispose: vi.fn() })),
			onDidEndEpoch: vi.fn(() => ({ dispose: vi.fn() })),
			onDidStartEpoch: vi.fn(() => ({ dispose: vi.fn() })),
			sendNotification: vi.fn(),
			sendRequest: vi.fn(),
		};
		provider._sqlEditorSessionDisposed = false;
		provider.panel = { webview: {} };
		provider._stsLanguageService = undefined;
		provider._stsInitPromise = undefined;
		provider.context = { globalState: { get: vi.fn() } };
		provider.output = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		provider.postMessage = vi.fn();
		provider.sqlWorkbench = {
			runtime: { getProcessManager: vi.fn().mockRejectedValueOnce(new Error('Canceled')).mockResolvedValueOnce(manager) },
			connectionManager: { getPassword: vi.fn() },
			leaveNoTracePolicy: {
				getConnectionIds: () => [], isProtected: () => false,
				assertAllowed: vi.fn(async () => undefined), refresh: vi.fn(async () => []),
			},
		};

		await expect(provider.ensureStsLanguageService()).resolves.toBeNull();
		expect(provider._stsInitPromise).toBeUndefined();
		await expect(provider.ensureStsLanguageService()).resolves.not.toBeNull();
		expect(provider._stsLanguageService).toBeDefined();
		expect(provider.sqlWorkbench.runtime.getProcessManager).toHaveBeenCalledTimes(2);
	});

	it('does not replay SQL documents when manager publication completes a successful initializer', async () => {
		const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
		const service = { openDocument: vi.fn(), connectDocument: vi.fn() };
		provider._sqlEditorSessionDisposed = false;
		provider._stsLanguageService = undefined;
		provider._stsInitPromise = Promise.resolve(service);
		provider._closedStsBoxIds = new Set();
		provider._pendingStsTextByBoxId = new Map([['sql_1', 'SELECT 1']]);
		provider._openedStsBoxIds = new Set();
		provider.sqlWorkbench = { connectionManager: { getConnection: vi.fn() } };

		await provider.handleStsRuntimeManagerChange(true);

		expect(service.openDocument).not.toHaveBeenCalled();
		expect(service.connectDocument).not.toHaveBeenCalled();
	});

	it('owner-closes a runtime replay candidate when connect fails after didOpen', async () => {
		const provider = createSqlProviderHarness();
		provider._sqlEditorSessionDisposed = false;
		provider._closedStsBoxIds = new Set();
		provider._openedStsBoxIds = new Set();
		provider._pendingStsTextByBoxId = new Map([['sql_1', 'SELECT 1']]);
		provider._latestStsConnectSequenceByBoxId = new Map();
		provider._stsConnectSequenceByBoxId = new Map();
		provider._stsDocumentSequenceByBoxId = new Map();
		provider.sqlWorkbench.assertSqlConnectionAllowed = vi.fn(async () => undefined);
		const expectedOwner = provider.getSqlResultOwner('sql_1');
		provider.getCanonicalSqlResultOwner = vi.fn(async () => expectedOwner);
		const service = {
			openDocument: vi.fn(async () => 'replay-uri'),
			connectDocument: vi.fn(async () => { throw new Error('replay connect failed'); }),
			closeDocumentUriForOwner: vi.fn(() => true),
		};
		provider.ensureStsLanguageService = vi.fn(async () => service);

		await provider.handleStsRuntimeManagerChange(true);

		expect(service.openDocument).toHaveBeenCalledWith('sql_1', 'SELECT 1', expect.anything(), stsOwner(expectedOwner));
		expect(service.closeDocumentUriForOwner).toHaveBeenCalledWith('sql_1', 'replay-uri', stsOwner(expectedOwner));
		expect(provider._openedStsBoxIds.has('sql_1')).toBe(false);
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'stsConnectionState', boxId: 'sql_1', state: 'error', error: 'replay connect failed',
		}));
	});

	it('owner-closes the replacement URI created by a current replay connect failure', async () => {
		const provider = createSqlProviderHarness();
		provider._sqlEditorSessionDisposed = false;
		provider._closedStsBoxIds = new Set();
		provider._openedStsBoxIds = new Set();
		provider._pendingStsTextByBoxId = new Map([['sql_1', 'SELECT 1']]);
		provider._latestStsConnectSequenceByBoxId = new Map();
		provider._stsConnectSequenceByBoxId = new Map();
		provider.sqlWorkbench.assertSqlConnectionAllowed = vi.fn(async () => undefined);
		const expectedOwner = provider.getSqlResultOwner('sql_1');
		provider.getCanonicalSqlResultOwner = vi.fn(async () => expectedOwner);
		const service = {
			openDocument: vi.fn(async () => 'replay-uri-a'),
			connectDocument: vi.fn(async () => { throw new Error('submitted connect failed'); }),
			closeDocumentUriForOwner: vi.fn(() => false),
			closeDocumentForOwner: vi.fn(() => true),
		};
		provider.ensureStsLanguageService = vi.fn(async () => service);

		await provider.handleStsRuntimeManagerChange(true);

		expect(service.closeDocumentUriForOwner).toHaveBeenCalledWith('sql_1', 'replay-uri-a', stsOwner(expectedOwner));
		expect(service.closeDocumentForOwner).toHaveBeenCalledWith('sql_1', stsOwner(expectedOwner));
		expect(provider._openedStsBoxIds.has('sql_1')).toBe(false);
	});

	it('owner-closes a runtime replay candidate when openDocument rejects after didOpen', async () => {
		const provider = createSqlProviderHarness();
		provider._sqlEditorSessionDisposed = false;
		provider._closedStsBoxIds = new Set();
		provider._openedStsBoxIds = new Set();
		provider._pendingStsTextByBoxId = new Map([['sql_1', 'SELECT 1']]);
		provider._latestStsConnectSequenceByBoxId = new Map();
		provider._stsConnectSequenceByBoxId = new Map();
		provider.sqlWorkbench.assertSqlConnectionAllowed = vi.fn(async () => undefined);
		const expectedOwner = provider.getSqlResultOwner('sql_1');
		provider.getCanonicalSqlResultOwner = vi.fn(async () => expectedOwner);
		const service = {
			openDocument: vi.fn(async () => { throw new Error('post-didOpen failure'); }),
			connectDocument: vi.fn(),
			closeDocumentForOwner: vi.fn(() => true),
			closeDocumentUriForOwner: vi.fn(() => true),
		};
		provider.ensureStsLanguageService = vi.fn(async () => service);

		await provider.handleStsRuntimeManagerChange(true);

		expect(service.closeDocumentForOwner).not.toHaveBeenCalled();
		expect(service.closeDocumentUriForOwner).not.toHaveBeenCalled();
		expect(service.connectDocument).not.toHaveBeenCalled();
		expect(provider._openedStsBoxIds.has('sql_1')).toBe(false);
	});

	it('does not let an older host STS connect continue after a replacement owner opens', async () => {
		const provider = createSqlProviderHarness();
		const connectionA = { id: 'sql-a', name: 'A', dialect: 'mssql', serverUrl: 'a.example', authType: 'sql-login', username: 'alice' } as any;
		const connectionB = { id: 'sql-b', name: 'B', dialect: 'mssql', serverUrl: 'b.example', authType: 'sql-login', username: 'bob' } as any;
		provider.sqlWorkbench.connectionManager.getConnection = vi.fn((id: string) => id === 'sql-a' ? connectionA : id === 'sql-b' ? connectionB : undefined);
		provider.sqlWorkbench.assertSqlConnectionAllowed = vi.fn(async () => undefined);
		provider._closedStsBoxIds = new Set();
		provider._openedStsBoxIds = new Set();
		provider._pendingStsTextByBoxId = new Map([['sql_1', 'SELECT 1']]);
		provider._latestStsConnectSequenceByBoxId = new Map();
		provider._stsConnectSequenceByBoxId = new Map();
		provider.sqlOwnership.clear();
		let currentServiceOwner: any;
		let markAOpened!: () => void;
		let releaseA!: () => void;
		const aOpened = new Promise<void>(resolve => { markAOpened = resolve; });
		const aGate = new Promise<void>(resolve => { releaseA = resolve; });
		const service = {
			openDocument: vi.fn(async (_boxId: string, _text: string, _connection: unknown, owner: any) => {
				currentServiceOwner = owner;
				if (owner.connectionId === 'sql-a') { markAOpened(); await aGate; }
			}),
			connectDocument: vi.fn(async () => undefined),
			closeDocumentForOwner: vi.fn((_boxId: string, owner: any) => {
				if (currentServiceOwner?.connectionId !== owner.connectionId || currentServiceOwner?.generation !== owner.generation) return false;
				currentServiceOwner = undefined;
				return true;
			}),
		};
		provider.ensureStsLanguageService = vi.fn(async () => service);
		provider.issueSqlOwnerToken = vi.fn(async (_boxId: string, owner: any) => `token-${owner.connectionId}`);
		provider.getCanonicalSqlResultOwner = vi.fn(async (boxId: string) => {
			const target = provider.sqlOwnership.getTarget(boxId);
			const connectionId = target?.connectionId;
			const connection = connectionId === 'sql-a' ? connectionA : connectionB;
			const database = target?.database;
			return {
				connectionId, database, generation: target?.generation,
				targetSignature: sqlConnectionTargetSignature(connection),
				principalFingerprint: sqlSchemaPrincipalFingerprintForPrincipal(connection, connection.username),
				revocationGeneration: 0,
			};
		});
		const ownerA = {
			connectionId: 'sql-a', database: 'DbA', generation: 1,
			targetSignature: sqlConnectionTargetSignature(connectionA),
			principalFingerprint: sqlSchemaPrincipalFingerprintForPrincipal(connectionA, connectionA.username)!, revocationGeneration: 0,
		};
		const ownerB = {
			connectionId: 'sql-b', database: 'DbB', generation: 2,
			targetSignature: sqlConnectionTargetSignature(connectionB),
			principalFingerprint: sqlSchemaPrincipalFingerprintForPrincipal(connectionB, connectionB.username)!, revocationGeneration: 0,
		};

		const connectA = provider.handleStsConnect('sql_1', 'instance-1', 'sql-a', 'DbA', 1, ownerA);
		await aOpened;
		const connectB = provider.handleStsConnect('sql_1', 'instance-1', 'sql-b', 'DbB', 2, ownerB);
		await connectB;
		releaseA();
		await connectA;

		expect(service.connectDocument).toHaveBeenCalledTimes(1);
		expect(service.connectDocument).toHaveBeenCalledWith('sql_1', connectionB, 'DbB', expect.objectContaining({ connectionId: 'sql-b', generation: 2 }));
		expect(provider._openedStsBoxIds.has('sql_1')).toBe(true);
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'stsConnectionState', state: 'ready', connectionId: 'sql-b' }));
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'stsConnectionState', state: 'ready', connectionId: 'sql-a' }));
	});

	it('does not let a stale same-owner connect close its replacement document', async () => {
		const provider = createSqlProviderHarness();
		const connection = { id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' } as any;
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => false);
		provider._openedStsBoxIds = new Set();
		provider._pendingStsTextByBoxId = new Map([['sql_1', 'SELECT 1']]);
		provider._latestStsConnectSequenceByBoxId = new Map();
		provider._stsConnectSequenceByBoxId = new Map();
		let releaseFirstOpen!: () => void;
		const firstOpenGate = new Promise<void>(resolve => { releaseFirstOpen = resolve; });
		let signalFirstOpen!: () => void;
		const firstOpenStarted = new Promise<void>(resolve => { signalFirstOpen = resolve; });
		let openCount = 0;
		let nextUri = 0;
		let currentUri = '';
		const service = {
			openDocument: vi.fn(async () => {
				openCount += 1;
				const uri = `uri-${++nextUri}`;
				currentUri = uri;
				if (openCount === 1) {
					signalFirstOpen();
					await firstOpenGate;
				}
				return uri;
			}),
			connectDocument: vi.fn(async () => undefined),
			closeDocumentForOwner: vi.fn(() => true),
			closeDocumentUriForOwner: vi.fn((_boxId: string, uri: string) => {
				if (uri !== currentUri) return false;
				currentUri = '';
				return true;
			}),
		};
		provider.ensureStsLanguageService = vi.fn(async () => service);
		provider.issueSqlOwnerToken = vi.fn(async () => 'owner-token');
		provider.getCanonicalSqlResultOwner = vi.fn(async () => provider.getSqlResultOwner('sql_1'));
		const owner = provider.getSqlResultOwner('sql_1');

		const first = provider.handleStsConnect('sql_1', 'instance-1', connection.id, 'Db', 1, owner);
		await firstOpenStarted;
		const replacement = provider.handleStsConnect('sql_1', 'instance-1', connection.id, 'Db', 1, owner);
		await replacement;
		releaseFirstOpen();
		await first;

		expect(service.openDocument).toHaveBeenCalledTimes(2);
		expect(service.closeDocumentForOwner).not.toHaveBeenCalled();
		expect(service.closeDocumentUriForOwner).not.toHaveBeenCalled();
		expect(provider._openedStsBoxIds.has('sql_1')).toBe(true);
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'stsConnectionState', state: 'ready', connectionId: connection.id,
		}));
	});

	it('transfers a shared same-owner STS connect to the newest host sequence', async () => {
		const provider = createSqlProviderHarness();
		const connection = provider.sqlWorkbench.connectionManager.getConnection('sql-1');
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => false);
		provider._openedStsBoxIds = new Set();
		provider._pendingStsTextByBoxId = new Map([['sql_1', 'SELECT 1']]);
		provider._latestStsConnectSequenceByBoxId = new Map();
		provider._stsConnectSequenceByBoxId = new Map();
		provider._stsDocumentSequenceByBoxId = new Map();
		const sharedConnect = deferred<void>();
		let connectCalls = 0;
		const service = {
			openDocument: vi.fn(async () => 'shared-uri'),
			connectDocument: vi.fn(async () => {
				connectCalls += 1;
				await sharedConnect.promise;
			}),
			closeDocumentForOwner: vi.fn(() => true),
			closeDocumentUriForOwner: vi.fn(() => true),
		};
		provider.ensureStsLanguageService = vi.fn(async () => service);
		provider.issueSqlOwnerToken = vi.fn(async () => 'owner-token');
		provider.getCanonicalSqlResultOwner = vi.fn(async () => provider.getSqlResultOwner('sql_1'));
		const owner = provider.getSqlResultOwner('sql_1');

		const first = provider.handleStsConnect('sql_1', 'instance-1', connection.id, 'Db', 1, owner);
		await vi.waitFor(() => expect(connectCalls).toBe(1));
		const second = provider.handleStsConnect('sql_1', 'instance-1', connection.id, 'Db', 1, owner);
		await vi.waitFor(() => expect(connectCalls).toBe(2));
		sharedConnect.resolve();
		await Promise.all([first, second]);

		expect(service.openDocument).toHaveBeenCalledOnce();
		expect(service.closeDocumentUriForOwner).not.toHaveBeenCalled();
		expect(service.closeDocumentForOwner).not.toHaveBeenCalled();
		expect(provider._openedStsBoxIds.has('sql_1')).toBe(true);
		expect(provider.postMessage).toHaveBeenCalledTimes(1);
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'stsConnectionState', state: 'ready', connectionId: connection.id,
		}));
	});

	it('closes an in-flight STS document when its section closes', async () => {
		const provider = createSqlProviderHarness();
		const connection = { id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' } as any;
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => false);
		provider._openedStsBoxIds = new Set();
		provider._pendingStsTextByBoxId = new Map([['sql_1', 'SELECT 1']]);
		provider._latestStsConnectSequenceByBoxId = new Map();
		provider._stsConnectSequenceByBoxId = new Map();
		provider.copilot = { cancelCopilotWriteQuery: vi.fn() };
		let releaseOpen!: () => void;
		let signalOpen!: () => void;
		const openGate = new Promise<void>(resolve => { releaseOpen = resolve; });
		const openStarted = new Promise<void>(resolve => { signalOpen = resolve; });
		const service = {
			openDocument: vi.fn(async () => { signalOpen(); await openGate; return 'uri-in-flight'; }),
			connectDocument: vi.fn(async () => undefined),
			closeDocumentForOwner: vi.fn(() => true),
			closeDocumentUriForOwner: vi.fn(() => true),
		};
		provider.ensureStsLanguageService = vi.fn(async () => service);
		provider.getCanonicalSqlResultOwner = vi.fn(async () => provider.getSqlResultOwner('sql_1'));
		const owner = provider.getSqlResultOwner('sql_1');

		const connecting = provider.handleStsConnect('sql_1', 'instance-1', connection.id, 'Db', 1, owner);
		await openStarted;
		provider.handleStsDidClose('sql_1');
		releaseOpen();
		await connecting;

		expect(service.closeDocumentUriForOwner).toHaveBeenCalledWith('sql_1', 'uri-in-flight', stsOwner(owner));
		expect(service.connectDocument).not.toHaveBeenCalled();
	});

	it('republishes schema after principal rotation under the new owner generation', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlPersistenceInvalidationEmitter = { fire: vi.fn() };
		provider.copilot = { invalidateSqlConnections: vi.fn() };
		provider._openedStsBoxIds = new Set();
		provider._latestStsConnectSequenceByBoxId = new Map();
		provider.prefetchSqlSchema = vi.fn(async () => undefined);

		await provider.handleSqlPrincipalsChanged(['sql-1']);

		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sqlConnectionOwnerChanged', boxId: 'sql_1', connectionId: 'sql-1', targetGeneration: 2,
		}));
		expect(provider.sendSqlConnectionsData).toHaveBeenCalledOnce();
		expect(provider.prefetchSqlSchema).toHaveBeenCalledWith('sql-1', 'Db', 'sql_1', false);
		expect(provider.sendSqlConnectionsData.mock.invocationCallOrder[0])
			.toBeLessThan(provider.prefetchSqlSchema.mock.invocationCallOrder[0]);
	});

	it('owner-closes A before a failed B replacement can serve language data', async () => {
		const provider = createSqlProviderHarness();
		const connectionA = { id: 'sql-a', name: 'A', dialect: 'mssql', serverUrl: 'a.example', authType: 'sql-login', username: 'alice' } as any;
		const connectionB = { id: 'sql-b', name: 'B', dialect: 'mssql', serverUrl: 'b.example', authType: 'sql-login', username: 'bob' } as any;
		const ownerA = {
			connectionId: 'sql-a', database: 'DbA', generation: 1,
			targetSignature: sqlConnectionTargetSignature(connectionA),
			principalFingerprint: sqlSchemaPrincipalFingerprintForPrincipal(connectionA, connectionA.username)!, revocationGeneration: 0,
		};
		const ownerB = {
			connectionId: 'sql-b', database: 'DbB', generation: 2,
			targetSignature: sqlConnectionTargetSignature(connectionB),
			principalFingerprint: sqlSchemaPrincipalFingerprintForPrincipal(connectionB, connectionB.username)!, revocationGeneration: 0,
		};
		provider.sqlOwnership.clear();
		provider.sqlOwnership.adoptTarget('sql_1', 'sql-a', 'DbA', 1, () => undefined);
		provider.sqlOwnership.ownerTokenByBoxId.set('sql_1', { token: 'owner-a', owner: ownerA });
		provider._openedStsBoxIds = new Set(['sql_1']);
		provider._closedStsBoxIds = new Set();
		provider._latestStsConnectSequenceByBoxId = new Map();
		provider._stsConnectSequenceByBoxId = new Map();
		provider.sqlWorkbench.connectionManager.getConnection = vi.fn((id: string) => id === 'sql-a' ? connectionA : id === 'sql-b' ? connectionB : undefined);
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => false);
		provider.sqlWorkbench.assertSqlConnectionAllowed = vi.fn(async (id: string) => {
			if (id === 'sql-b') throw new Error('B policy rejected');
		});
		const service = {
			closeDocumentForOwner: vi.fn(() => true),
			getHover: vi.fn(async () => ({ contents: 'A secret' })),
			openDocument: vi.fn(), connectDocument: vi.fn(),
		};
		provider._stsLanguageService = service;

		await provider.handleStsConnect('sql_1', 'instance-1', 'sql-b', 'DbB', 2, ownerB);
		await provider.handleStsRequest('hover-b', 'textDocument/hover', {
			boxId: 'sql_1', line: 1, column: 1, ownerToken: 'owner-b', targetGeneration: 2,
		});

		expect(service.closeDocumentForOwner).toHaveBeenCalledWith('sql_1', stsOwner(ownerA));
		expect(provider._openedStsBoxIds.has('sql_1')).toBe(false);
		expect(service.openDocument).not.toHaveBeenCalled();
		expect(service.connectDocument).not.toHaveBeenCalled();
		expect(service.getHover).not.toHaveBeenCalled();
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'stsResponse', requestId: 'hover-b', result: null, ownerToken: 'owner-b', targetGeneration: 2,
		}));
		expect(JSON.stringify(provider.postMessage.mock.calls)).not.toContain('A secret');
	});

	it.each(['schema-result', 'schema-error'] as const)('suppresses %s details when schema owner admission rejects', async mode => {
		const provider = createSqlProviderHarness();
		provider._sqlSchemaService = {
			getSchema: vi.fn(async () => {
				if (mode === 'schema-error') throw new Error('SECRET_SCHEMA_ERROR');
				return {
					schema: { tables: ['SECRET_SCHEMA_TABLE'], columnsByTable: { SECRET_SCHEMA_TABLE: { SecretColumn: 'string' } } },
					fromCache: false,
				};
			}),
		};
		provider.dispatchSqlResultOwnerAllowed = vi.fn(async () => { throw new Error('owner invalid'); });

		await provider.prefetchSqlSchema('sql-1', 'Db', 'sql_1', false);

		expect(JSON.stringify(provider.output.info.mock.calls)).not.toContain('SECRET_SCHEMA');
		expect(JSON.stringify(provider.output.error.mock.calls)).not.toContain('SECRET_SCHEMA');
		expect(provider.output.warn).toHaveBeenCalledWith(expect.stringContaining('details suppressed'));
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'sqlSchemaData' }));
	});

	it('suppresses host STS request error details when final owner admission rejects', async () => {
		const provider = createSqlProviderHarness();
		provider._openedStsBoxIds = new Set(['sql_1']);
		provider._closedStsBoxIds = new Set();
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => false);
		const service = { getHover: vi.fn(async () => { throw new Error('SECRET_HOST_STS_ERROR'); }) };
		provider._stsLanguageService = service;
		provider.ensureStsLanguageService = vi.fn(async () => service);
		provider.dispatchSqlResultOwnerAllowed = vi.fn(async () => { throw new Error('owner invalid'); });

		await provider.handleStsRequest('request-1', 'textDocument/hover', {
			boxId: 'sql_1', sectionInstanceId: 'instance-1', line: 1, column: 1,
			ownerToken: 'owner-token', targetGeneration: 1,
		});

		expect(JSON.stringify(provider.output.error.mock.calls)).not.toContain('SECRET_HOST_STS_ERROR');
		expect(provider.output.warn).toHaveBeenCalledWith(expect.stringContaining('details suppressed'));
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'stsResponse', requestId: 'request-1', result: null }));
	});

	it('owner-closes a normal STS candidate when the full owner drifts during connect', async () => {
		const provider = createSqlProviderHarness();
		provider._closedStsBoxIds = new Set();
		provider._openedStsBoxIds = new Set();
		provider._pendingStsTextByBoxId = new Map([['sql_1', 'SELECT 1']]);
		provider._latestStsConnectSequenceByBoxId = new Map();
		provider._stsConnectSequenceByBoxId = new Map();
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => false);
		provider.sqlWorkbench.assertSqlConnectionAllowed = vi.fn(async () => undefined);
		const ownerA = provider.getSqlResultOwner('sql_1');
		const ownerB = { ...ownerA, principalFingerprint: 'principal-b' };
		provider.getCanonicalSqlResultOwner = vi.fn()
			.mockResolvedValueOnce(ownerA)
			.mockResolvedValueOnce(ownerB);
		const service = {
			openDocument: vi.fn(async () => 'candidate-uri'),
			connectDocument: vi.fn(async () => undefined),
			closeDocumentForOwner: vi.fn(() => true),
			closeDocumentUriForOwner: vi.fn(() => true),
		};
		provider.ensureStsLanguageService = vi.fn(async () => service);
		provider.issueSqlOwnerToken = vi.fn();

		await provider.handleStsConnect('sql_1', 'instance-1', 'sql-1', 'Db', 1);

		expect(service.connectDocument).toHaveBeenCalledWith('sql_1', expect.anything(), 'Db', stsOwner(ownerA));
		expect(service.closeDocumentUriForOwner).toHaveBeenCalledWith('sql_1', 'candidate-uri', stsOwner(ownerA));
		expect(service.closeDocumentForOwner).not.toHaveBeenCalled();
		expect(provider.issueSqlOwnerToken).not.toHaveBeenCalled();
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'stsConnectionState', state: 'ready' }));
	});

	it('posts queryError when SQL setup fails synchronously', async () => {
		const provider = createSqlProviderHarness();

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db', query: 'SELECT 1', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'setup-failure',
		});

		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'queryError', error: 'Leave No Trace blocked', boxId: 'sql_1', ownerToken: 'owner-token' }));
	});

	it('admits a protected SQL result through the execution-only owner mode', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => true);
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({
			promise: Promise.resolve({ columns: [{ name: 'Value', type: 'int' }], rows: [[{ full: '42', display: '42' }]], metadata: {} }),
			cancel: vi.fn(),
		}));

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT 42 AS Value', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'protected-run',
		});

		expect(provider.sqlWorkbench.dispatchSqlOwnerProtection).toHaveBeenCalled();
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryResult', boxId: 'sql_1', ownerToken: 'owner-token', executionId: 'protected-run',
		}));
	});

	it('keeps protected SQL error details out of the persistent output log', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => true);
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({
			promise: Promise.reject(new Error('SECRET_BACKEND_DETAIL')),
			cancel: vi.fn(),
		}));

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT secret', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'protected-error',
		});

		expect(JSON.stringify([
			...provider.output.error.mock.calls,
			...provider.output.warn.mock.calls,
		])).not.toContain('SECRET_BACKEND_DETAIL');
		expect(provider.output.warn).toHaveBeenCalledWith(expect.stringContaining('details were not logged'));
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryError', error: 'SECRET_BACKEND_DETAIL', executionId: 'protected-error',
		}));
	});

	it('retires manual SQL preflight after owner validation rejects', async () => {
		const provider = createSqlProviderHarness();
		provider.assertSqlOwnerToken = vi.fn(async () => { throw new Error('owner rejected'); });

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT 1', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'rejected-preflight',
		});

		expect(provider.sqlExecutionBroker.cancelExpected('sql_1', 'rejected-preflight', false)).toBe(false);
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryError', boxId: 'sql_1', executionId: 'rejected-preflight', error: 'owner rejected',
		}));
	});

	it('does not dispatch SQL after Cancel during asynchronous owner validation', async () => {
		const provider = createSqlProviderHarness();
		const ownerValidation = deferred<any>();
		provider.assertSqlOwnerToken = vi.fn(() => ownerValidation.promise);
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn();

		const run = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'UPDATE dbo.T SET Value = 1', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'manual-cancel',
		});
		await Promise.resolve();
		await provider.handleWebviewMessage({ type: 'cancelSqlQuery', boxId: 'sql_1', sectionInstanceId: 'instance-1', executionId: 'manual-cancel' });
		ownerValidation.resolve({ token: 'owner-token', owner: provider.getSqlResultOwner('sql_1') });
		await run;

		expect(provider.sqlWorkbench.client.executeQueryCancelable).not.toHaveBeenCalled();
	});

	it('does not dispatch an older SQL run after Copilot supersedes its paused owner validation', async () => {
		const provider = createSqlProviderHarness();
		const ownerValidation = deferred<any>();
		provider.assertSqlOwnerToken = vi.fn(() => ownerValidation.promise);
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn();

		const oldRun = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT old', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'manual-old',
		});
		await vi.waitFor(() => expect(provider.assertSqlOwnerToken).toHaveBeenCalledOnce());
		provider.sqlExecutionBroker.supersede('sql_1', { notifyWebview: true });
		ownerValidation.resolve(provider.sqlOwnership.getIssuedOwner('sql_1'));
		await oldRun;

		expect(provider.sqlWorkbench.client.executeQueryCancelable).not.toHaveBeenCalled();
		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'queryCancelled', boxId: 'sql_1', ownerToken: 'owner-token', executionId: 'manual-old',
		});
	});

	it('does not let Copilot dispatch after a newer manual run claims admission', () => {
		const provider = createSqlProviderHarness();
		const copilotAdmission = provider.sqlExecutionBroker.reserve('sql_1', 'copilot');
		const manualAdmission = provider.sqlExecutionBroker.reserve('sql_1', 'manual');
		const manualCancel = vi.fn();
		const manualRun = provider.sqlExecutionBroker.start(manualAdmission, () => ({ cancel: manualCancel, promise: Promise.resolve() }));
		const copilotStart = vi.fn(() => ({ cancel: vi.fn(), promise: Promise.resolve() }));

		expect(() => provider.sqlExecutionBroker.start(copilotAdmission, copilotStart))
			.toThrow('SQL Copilot write-query canceled');
		expect(copilotStart).not.toHaveBeenCalled();
		expect(manualRun.isCurrent()).toBe(true);
	});

	it('cancels a SQL execution when admission changes synchronously during start', () => {
		const provider = createSqlProviderHarness();
		const admission = provider.sqlExecutionBroker.reserve('sql_1', 'sync-change');
		const cancel = vi.fn();

		expect(() => provider.sqlExecutionBroker.start(admission, () => {
			provider.sqlExecutionBroker.supersede('sql_1');
			return { cancel };
		})).toThrow('SQL Copilot write-query canceled');

		expect(cancel).toHaveBeenCalledOnce();
		expect(provider._queryRunCoordinator.has('sql_1')).toBe(false);
	});

	it('snapshots SQL cancellation correlation before a reentrant cancel callback', () => {
		const provider = createSqlProviderHarness();
		const admission = provider.sqlExecutionBroker.reserve('sql_1', 'execution-1');
		const cancel = vi.fn(() => provider.sqlOwnership.revokeOwnerToken('sql_1'));
		provider.sqlExecutionBroker.start(admission, () => ({ cancel }));

		provider.sqlExecutionBroker.cancelRunning('sql_1', { notifyWebview: true });

		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'queryCancelled', boxId: 'sql_1', ownerToken: 'owner-token', executionId: 'execution-1',
		});
	});

	it('preserves SQL cancellation correlation when Leave No Trace invalidates an active run', () => {
		const provider = createSqlProviderHarness();
		provider.sqlPersistenceInvalidationEmitter = { fire: vi.fn() };
		provider.copilot = {
			invalidateSqlConnections: vi.fn(),
		};
		provider._openedStsBoxIds = new Set();
		provider._latestStsConnectSequenceByBoxId = new Map();
		const admission = provider.sqlExecutionBroker.reserve('sql_1', 'execution-lnt');
		const cancel = vi.fn();
		provider.sqlExecutionBroker.start(admission, () => ({ cancel }));

		provider.applySqlLeaveNoTraceChange(['sql-1'], ['sql-1'], []);

		expect(cancel).toHaveBeenCalledOnce();
		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'queryCancelled', boxId: 'sql_1', ownerToken: 'owner-token', executionId: 'execution-lnt',
		});
		expect(provider.postMessage.mock.calls.filter((call: unknown[]) =>
			(call[0] as any)?.type === 'queryCancelled' && (call[0] as any)?.boxId === 'sql_1')).toHaveLength(1);
		const cancellationIndex = provider.postMessage.mock.calls.findIndex((call: unknown[]) =>
			(call[0] as any)?.type === 'queryCancelled' && (call[0] as any)?.boxId === 'sql_1');
		const policyIndex = provider.postMessage.mock.calls.findIndex((call: unknown[]) =>
			(call[0] as any)?.type === 'sqlLeaveNoTraceData');
		expect(cancellationIndex).toBeGreaterThanOrEqual(0);
		expect(policyIndex).toBeGreaterThan(cancellationIndex);
		expect(provider.sqlOwnership.getOwnerToken('sql_1')).toBeUndefined();
	});

	it('publishes an execution-only owner after enabling Leave No Trace', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlPersistenceInvalidationEmitter = { fire: vi.fn() };
		provider.copilot = { invalidateSqlConnections: vi.fn() };
		provider._openedStsBoxIds = new Set();
		provider._latestStsConnectSequenceByBoxId = new Map();
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => true);

		provider.applySqlLeaveNoTraceChange(['sql-1'], ['sql-1'], []);

		await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sqlExecutionOwnerState', boxId: 'sql_1', sectionInstanceId: 'instance-1',
		})));
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'stsConnectionState', state: 'ready', boxId: 'sql_1',
		}));
	});

	it('revokes the protected execution owner when Leave No Trace is disabled', () => {
		const provider = createSqlProviderHarness();
		provider.sqlPersistenceInvalidationEmitter = { fire: vi.fn() };
		provider.copilot = { invalidateSqlConnections: vi.fn() };
		provider._openedStsBoxIds = new Set();
		provider._latestStsConnectSequenceByBoxId = new Map();
		expect(provider.sqlOwnership.getOwnerToken('sql_1')).toBe('owner-token');

		provider.applySqlLeaveNoTraceChange([], [], ['sql-1']);

		expect(provider.sqlOwnership.getOwnerToken('sql_1')).toBeUndefined();
	});

	it('does not post a stale validation error after Cancel supersedes SQL preflight', async () => {
		const provider = createSqlProviderHarness();
		const ownerValidation = deferred<any>();
		provider.assertSqlOwnerToken = vi.fn(() => ownerValidation.promise);

		const run = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT 1', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'stale-validation',
		});
		await Promise.resolve();
		await provider.handleWebviewMessage({ type: 'cancelSqlQuery', boxId: 'sql_1', sectionInstanceId: 'instance-1', executionId: 'stale-validation' });
		ownerValidation.reject(new Error('stale owner failure'));
		await run;

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryError', error: 'stale owner failure' }));
	});

	it('does not post an older validation error after a newer SQL Run starts', async () => {
		const provider = createSqlProviderHarness();
		const firstValidation = deferred<any>();
		const issued = provider.sqlOwnership.getIssuedOwner('sql_1');
		provider.assertSqlOwnerToken = vi.fn()
			.mockReturnValueOnce(firstValidation.promise)
			.mockResolvedValueOnce(issued);
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({
			promise: Promise.resolve({ columns: [{ name: 'Value' }], rows: [[2]], metadata: {} }),
			cancel: vi.fn(),
		}));

		const first = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT 1', queryMode: 'plain', ownerToken: 'owner-token',
		});
		await Promise.resolve();
		const second = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT 2', queryMode: 'plain', ownerToken: 'owner-token',
		});
		firstValidation.reject(new Error('older validation failed'));
		await Promise.all([first, second]);

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryError', error: 'older validation failed' }));
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
	});

	it('echoes the SQL tool execution ID on the accepted terminal result', async () => {
		const provider = createSqlProviderHarness();
		const owner = provider.getSqlResultOwner('sql_1');
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({
			promise: Promise.resolve({ columns: [{ name: 'Value' }], rows: [[1]], metadata: {} }), cancel: vi.fn(),
		}));

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT 1', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'tool-execution-1', toolExecution: true,
			expectedOwner: {
				connectionId: owner.connectionId, database: owner.database, targetSignature: owner.targetSignature,
				principalFingerprint: owner.principalFingerprint, revocationGeneration: owner.revocationGeneration,
			},
		});

		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryResult', boxId: 'sql_1', ownerToken: 'owner-token', executionId: 'tool-execution-1',
		}));
	});

	it('rejects a changed SQL tool principal before query dispatch', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn();

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'UPDATE Sensitive SET Value = 1', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'tool-execution-drift', toolExecution: true,
			expectedOwner: {
				connectionId: 'sql-1', database: 'Db', targetSignature: provider.getSqlResultOwner('sql_1').targetSignature,
				principalFingerprint: 'stale-principal', revocationGeneration: 0,
			},
		});

		expect(provider.sqlWorkbench.client.executeQueryCancelable).not.toHaveBeenCalled();
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryError', executionId: 'tool-execution-drift', error: 'SQL tool execution owner changed before query dispatch.',
		}));
	});

	it('accepts the real manual SQL payload without a tool expected owner', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({
			promise: Promise.resolve({ columns: [{ name: 'Value' }], rows: [[1]], metadata: {} }), cancel: vi.fn(),
		}));

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT 1 AS Value', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'sql-run-manual-1',
		});

		expect(provider.sqlWorkbench.client.executeQueryCancelable).toHaveBeenCalledOnce();
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryResult', executionId: 'sql-run-manual-1', result: expect.objectContaining({ rows: [[1]] }),
		}));
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
			error: 'SQL tool execution owner changed before query dispatch.',
		}));
	});

	it.each([
		['error', () => Promise.reject(new Error('SECRET_OBJECT_NAME'))],
		['cancellation', () => Promise.reject({ isCancelled: true })],
	] as const)('suppresses a stale SQL %s terminal when canonical owner admission rejects', async (_label, terminalPromise) => {
		const provider = createSqlProviderHarness();
		const admission = deferred<void>();
		provider.dispatchSqlResultOwnerAllowed = vi.fn(async () => {
			await admission.promise;
			throw new Error('Leave No Trace committed');
		});
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({
			promise: terminalPromise(), cancel: vi.fn(),
		}));

		const run = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT * FROM SensitiveObject', queryMode: 'plain', ownerToken: 'owner-token', executionId: `manual-${_label}`,
		});
		await vi.waitFor(() => expect(provider.dispatchSqlResultOwnerAllowed).toHaveBeenCalledOnce());
		admission.resolve();
		await run;

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryError' }));
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryCancelled' }));
		expect(JSON.stringify(provider.postMessage.mock.calls)).not.toContain('SECRET_OBJECT_NAME');
		expect(JSON.stringify(provider.output.error.mock.calls)).not.toContain('SECRET_OBJECT_NAME');
		if (_label === 'error') expect(provider.output.warn).toHaveBeenCalledWith(expect.stringContaining('details suppressed'));
	});

	it('notifies the exact tool execution before a newer SQL run supersedes it', async () => {
		const provider = createSqlProviderHarness();
		const toolCancel = vi.fn();
		const toolAdmission = provider.sqlExecutionBroker.reserve('sql_1', 'tool-execution-1');
		provider.sqlExecutionBroker.start(toolAdmission, () => ({ cancel: toolCancel }));
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({
			promise: Promise.resolve({ columns: [], rows: [], metadata: {} }), cancel: vi.fn(),
		}));

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT newer', queryMode: 'plain', ownerToken: 'owner-token',
		});

		expect(toolCancel).toHaveBeenCalledOnce();
		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'queryCancelled', boxId: 'sql_1', ownerToken: 'owner-token', executionId: 'tool-execution-1',
		});
	});

	it('suppresses a completed SQL result when the final Leave No Trace assertion fails', async () => {
		const provider = createSqlProviderHarness();
		const pending = deferred<any>();
		const cancel = vi.fn();
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({ promise: pending.promise, cancel }));
		provider.sqlWorkbench.assertSqlConnectionAllowed = vi.fn(async () => { throw new Error('Leave No Trace blocked'); });

		const task = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db', query: 'SELECT 1', queryMode: 'plain', ownerToken: 'owner-token',
		});
		await flushPromises();
		pending.resolve({ columns: [{ name: 'Value', type: 'int' }], rows: [[1]], metadata: {} });
		await task;

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'queryError', error: 'Leave No Trace blocked', boxId: 'sql_1', ownerToken: 'owner-token' }));
	});

	it('suppresses a completed SQL result when canonical publication admission rejects', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({
			promise: Promise.resolve({ columns: [{ name: 'Secret' }], rows: [['blocked-row']], metadata: {} }),
			cancel: vi.fn(),
		}));
		provider.sqlWorkbench.dispatchSqlOwnerAllowed.mockRejectedValueOnce(new Error('Leave No Trace committed'));

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT Secret FROM T', queryMode: 'plain', ownerToken: 'owner-token',
		});

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryError', error: 'Leave No Trace committed', boxId: 'sql_1',
		}));
	});

	it('rejects delayed SQL rows after the section switches target', async () => {
		const provider = createSqlProviderHarness();
		const pending = deferred<any>();
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({ promise: pending.promise, cancel: vi.fn() }));

		const task = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db', query: 'SELECT 1', queryMode: 'plain', ownerToken: 'owner-token',
		});
		await flushPromises();
		provider.sqlExecutionBroker.supersede('sql_1');
		provider.sqlOwnership.adoptTarget('sql_1', 'sql-2', 'OtherDb', 2, () => undefined);
		pending.resolve({ columns: [{ name: 'Value', type: 'int' }], rows: [[1]], metadata: {} });
		await task;

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryError' }));
	});

	it('rejects delayed SQL rows after the saved connection target changes under the same ID', async () => {
		const provider = createSqlProviderHarness();
		const pending = deferred<any>();
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({ promise: pending.promise, cancel: vi.fn() }));

		const task = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db', query: 'SELECT 1', queryMode: 'plain', ownerToken: 'owner-token',
		});
		await flushPromises();
		provider.sqlWorkbench.connectionManager.getConnection.mockReturnValue({
			id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', port: 1434, authType: 'aad',
		});
		pending.resolve({ columns: [{ name: 'Value', type: 'int' }], rows: [[1]], metadata: {} });
		await task;

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryError' }));
	});

	it('rejects delayed SQL rows after the AAD principal rotates under the same ID', async () => {
		const provider = createSqlProviderHarness();
		const pending = deferred<any>();
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({ promise: pending.promise, cancel: vi.fn() }));

		const task = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db', query: 'SELECT 1', queryMode: 'plain', ownerToken: 'owner-token',
		});
		await flushPromises();
		provider.context.globalState.get.mockImplementation((key: string) => key === 'sql.auth.serverAccountMap'
			? { 'server.example': 'account-b' }
			: undefined);
		pending.resolve({ columns: [{ name: 'Value', type: 'int' }], rows: [[1]], metadata: {} });
		await task;

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryError' }));
	});

	it('strips persisted SQL results for a protected runtime connection', () => {
		const provider = createSqlProviderHarness();
		const state = {
			sections: [
				{ id: 'sql_1', type: 'sql', query: 'SELECT 1', principalFingerprint: 'principal-a', resultJson: '{"secret":true}' },
				{ id: 'chart_1', type: 'chart', dataSourceId: 'sql_1' },
			],
		};

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized).not.toBe(state);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[0]).not.toHaveProperty('principalFingerprint');
		expect(sanitized.sections[1]).toEqual(state.sections[1]);
	});

	it('removes an orphaned SQL principal fingerprint even when no result remains', () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => false);
		const state = { sections: [{
			id: 'sql_1', type: 'sql', query: 'SELECT 1', principalFingerprint: 'principal-a',
		}] };

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);

		expect(sanitized.sections[0]).not.toHaveProperty('principalFingerprint');
	});

	it('strips restored SQL results by protected server before box ownership is known', () => {
		const provider = createSqlProviderHarness();
		provider.sqlOwnership.removeTarget('sql_1');
		const state = {
			sections: [{ id: 'sql_restored', type: 'sql', serverUrl: 'server.example', resultJson: '{"secret":true}' }],
		};

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
	});

	it('strips restored SQL results by protected connection hint after target-signature drift', () => {
		const provider = createSqlProviderHarness();
		provider.sqlOwnership.removeTarget('sql_1');
		const state = {
			sections: [{
				id: 'sql_restored', type: 'sql', connectionIdHint: 'sql-1',
				serverUrl: 'old.example', targetSignature: 'old-target', resultJson: '{"secret":true}',
			}],
		};

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
	});

	it('resolves a stale SQL hint through one exact target signature and strips protected rows', () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => true);
		const recreated = provider.sqlWorkbench.connectionManager.getConnection('sql-1');
		const targetSignature = sqlConnectionTargetSignature(recreated);
		const state = { sections: [{
			id: 'sql_restored', type: 'sql', connectionIdHint: 'sql_deleted', targetSignature,
			serverUrl: recreated.serverUrl, resultJson: '{"secret":true}',
		}] };

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
	});

	it('fails closed when restored SQL result ownership is ambiguous', () => {
		const provider = createSqlProviderHarness();
		const connection = provider.sqlWorkbench.connectionManager.getConnection('sql-1');
		provider.sqlWorkbench.connectionManager.getConnections = vi.fn(() => [connection, { ...connection, id: 'sql-2' }]);
		provider.sqlWorkbench.connectionManager.getConnection = vi.fn((id: string) => id === 'sql-1' ? connection : id === 'sql-2' ? { ...connection, id: 'sql-2' } : undefined);
		const targetSignature = sqlConnectionTargetSignature(connection);
		const state = { sections: [{ id: 'sql_restored', type: 'sql', connectionIdHint: 'sql_deleted', targetSignature, resultJson: '{"secret":true}' }] };

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
	});

	it('strips persisted comparison results by durable SQL source lineage', () => {
		const provider = createSqlProviderHarness();
		provider.sqlOwnership.removeTarget('sql_1');
		const state = {
			sections: [
				{ id: 'sql_source', type: 'sql', serverUrl: 'server.example', query: 'SELECT 1' },
				{ id: 'query_cmp', type: 'query', comparisonSourceBoxId: 'sql_source', query: 'SELECT 2', resultJson: '{"secret":true}' },
			],
		};

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized.sections[1]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[1]).toMatchObject({ comparisonSourceBoxId: 'sql_source', query: 'SELECT 2' });
	});

	it('strips SQL comparison rows when the persisted source owner cannot be resolved', () => {
		const provider = createSqlProviderHarness();
		provider.sqlOwnership.removeTarget('sql_1');
		const state = {
			sections: [
				{ id: 'sql_source', type: 'sql', connectionIdHint: 'missing', targetSignature: 'missing-target', serverUrl: 'unknown.example', query: 'SELECT 1' },
				{ id: 'query_cmp', type: 'query', comparisonSourceBoxId: 'sql_source', query: 'SELECT 2', resultJson: '{"secret":true}' },
			],
		};

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized.sections[1]).not.toHaveProperty('resultJson');
	});

	it('uses persisted SQL owner B instead of a stale same-box live owner A during reload', () => {
		const provider = createSqlProviderHarness();
		const ownerA = { id: 'sql-a', name: 'A', dialect: 'mssql', serverUrl: 'shared.example', authType: 'sql-login', username: 'UserA' };
		const ownerB = { id: 'sql-b', name: 'B', dialect: 'mssql', serverUrl: 'shared.example', authType: 'sql-login', username: 'UserB' };
		provider.sqlOwnership.adoptTarget('sql_source', 'sql-a', 'Db', 1, () => undefined);
		provider.sqlWorkbench.connectionManager.getConnection = vi.fn((id: string) => id === 'sql-a' ? ownerA : id === 'sql-b' ? ownerB : undefined);
		provider.sqlWorkbench.connectionManager.getConnections = vi.fn(() => [ownerA, ownerB]);
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn((id: string) => id === 'sql-b');
		const state = { sections: [
			{
				id: 'sql_source', type: 'sql', connectionIdHint: 'sql-b',
				targetSignature: sqlConnectionTargetSignature(ownerB), serverUrl: 'shared.example',
				query: 'SELECT 1', resultJson: '{"owner":"B"}',
			},
			{ id: 'query_cmp', type: 'query', comparisonSourceBoxId: 'sql_source', query: 'SELECT 2', resultJson: '{"owner":"B-comparison"}' },
		] };

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[1]).not.toHaveProperty('resultJson');
	});

	it('preserves persisted Kusto comparison results during SQL privacy sanitization', () => {
		const provider = createSqlProviderHarness();
		const state = {
			sections: [
				{ id: 'query_source', type: 'query', clusterUrl: 'https://cluster.kusto.windows.net', database: 'Db', query: 'T | count' },
				{ id: 'query_cmp', type: 'query', comparisonSourceBoxId: 'query_source', query: 'T | summarize count()', resultJson: '{"value":2}' },
			],
		};

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized.sections[1]).toHaveProperty('resultJson', '{"value":2}');
		expect(provider.sqlOwnership.getComparisonOwner('query_cmp')).toBeUndefined();
	});

	it('does not read SQL policy storage for pure Kusto, Markdown, and Chart state', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.refreshLeaveNoTracePolicy = vi.fn(async () => { throw new Error('SQL policy unavailable'); });
		const state = {
			sections: [
				{ id: 'query_1', type: 'query', query: 'T | count' },
				{ id: 'markdown_1', type: 'markdown', text: 'Notes' },
				{ id: 'chart_1', type: 'chart', dataSourceId: 'query_1' },
			],
		};

		await expect(provider.sanitizeSqlLeaveNoTraceStateFresh(state)).resolves.toBe(state);
		expect(provider.sqlWorkbench.refreshLeaveNoTracePolicy).not.toHaveBeenCalled();
	});

	it('holds canonical SQL owner admission through publication and never exposes pre-admission rows', async () => {
		const provider = createSqlProviderHarness();
		const connection = provider.sqlWorkbench.connectionManager.getConnection('sql-1');
		const principal = sqlSchemaPrincipalFingerprintForPrincipal(connection, 'account-a')!;
		let lockHeld = false;
		provider.sqlWorkbench.runWithSqlOwnerSnapshotLock = vi.fn(async (run: (snapshot: any) => unknown) => {
			lockHeld = true;
			try {
				return await run({
					policy: { connectionIds: ['sql-1'], version: 2, globallyBlocked: false, revocationGenerations: { 'sql-1': 1 } },
					connections: [connection], connectionVersion: 1,
					accountsByServer: { 'server.example': 'account-a' }, principalVersion: 1,
				});
			} finally {
				lockHeld = false;
			}
		});
		let releasePublish!: () => void;
		const publishGate = new Promise<void>(resolve => { releasePublish = resolve; });
		const state = { sections: [{
			id: 'sql_1', type: 'sql', connectionIdHint: 'sql-1',
			targetSignature: sqlConnectionTargetSignature(connection), principalFingerprint: principal,
			revocationGeneration: 0, resultJson: '{"secret":true}',
		}] };

		const publishing = provider.publishSqlLeaveNoTraceStateFresh(state, async (sanitized: typeof state) => {
			expect(lockHeld).toBe(true);
			expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
			await publishGate;
			expect(lockHeld).toBe(true);
			return 'published';
		});
		await vi.waitFor(() => expect(provider.sqlWorkbench.runWithSqlOwnerSnapshotLock).toHaveBeenCalledOnce());
		expect(lockHeld).toBe(true);
		releasePublish();

		await expect(publishing).resolves.toBe('published');
		expect(lockHeld).toBe(false);
	});

	it('strips orphaned comparison rows before SQL policy I/O during fresh save', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.refreshLeaveNoTracePolicy = vi.fn(async () => { throw new Error('SQL policy unavailable'); });
		const state = { sections: [{
			id: 'query_orphan', type: 'query', comparisonSourceBoxId: 'missing_source',
			query: 'SELECT 2', resultJson: '{"secret":true}',
		}] };

		const sanitized = await provider.sanitizeSqlLeaveNoTraceStateFresh(state);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(provider.sqlWorkbench.refreshLeaveNoTracePolicy).not.toHaveBeenCalled();
	});

	it('strips legacy SQL comparison rows when policy refresh fails during fresh save', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.refreshLeaveNoTracePolicy = vi.fn(async () => { throw new Error('SQL policy unavailable'); });
		const state = { sections: [{
			id: 'legacy_sql_cmp', type: 'query', connectionIdHint: 'sql_old',
			query: 'SELECT 2', resultJson: '{"secret":true}',
		}] };

		const sanitized = await provider.sanitizeSqlLeaveNoTraceStateFresh(state);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(provider.sqlWorkbench.dispatchSqlOwnerSnapshot).toHaveBeenCalledOnce();
	});

	it('strips persisted AAD source and comparison rows after the canonical principal rotates', async () => {
		const provider = createSqlProviderHarness();
		const connection = provider.sqlWorkbench.connectionManager.getConnection('sql-1');
		const principalA = sqlSchemaPrincipalFingerprintForPrincipal(connection, 'account-a')!;
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => false);
		provider.sqlWorkbench.refreshLeaveNoTracePolicy = vi.fn(async () => []);
		provider.sqlWorkbench.dispatchSqlOwnerSnapshot = vi.fn(async (dispatch: (snapshot: any) => unknown) => await dispatch({
			policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {} },
			connections: [connection], connectionVersion: 1,
			accountsByServer: { 'server.example': 'account-b' }, principalVersion: 2,
		}));
		const state = {
			sections: [
				{
					id: 'sql_1', type: 'sql', connectionIdHint: 'sql-1', serverUrl: 'server.example',
					targetSignature: sqlConnectionTargetSignature(connection), principalFingerprint: principalA,
					resultJson: '{"rows":[["source-a"]]}',
				},
				{
					id: 'comparison_1', type: 'query', comparisonSourceBoxId: 'sql_1',
					resultJson: '{"rows":[["comparison-a"]]}',
				},
			],
		};

		const sanitized = await provider.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[0]).not.toHaveProperty('principalFingerprint');
		expect(sanitized.sections[1]).not.toHaveProperty('resultJson');
	});

	it('strips persisted SQL rows when the canonical connection target changed before the watcher refresh', async () => {
		const provider = createSqlProviderHarness();
		const connection = provider.sqlWorkbench.connectionManager.getConnection('sql-1');
		const principal = sqlSchemaPrincipalFingerprintForPrincipal(connection, 'account-a')!;
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => false);
		provider.sqlWorkbench.refreshLeaveNoTracePolicy = vi.fn(async () => []);
		provider.sqlWorkbench.dispatchSqlOwnerSnapshot = vi.fn(async (dispatch: (snapshot: any) => unknown) => await dispatch({
			policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {} },
			connections: [{ ...connection, port: 1444 }], connectionVersion: 2,
			accountsByServer: { 'server.example': 'account-a' }, principalVersion: 1,
		}));
		const state = { sections: [{
			id: 'sql_1', type: 'sql', connectionIdHint: 'sql-1', serverUrl: 'server.example',
			targetSignature: sqlConnectionTargetSignature(connection), principalFingerprint: principal,
			resultJson: '{"rows":[["old-target"]]}',
		}] };

		const sanitized = await provider.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[0]).not.toHaveProperty('principalFingerprint');
	});

	it('strips pre-lineage SQL comparison rows while preserving Kusto, Markdown, and Chart state', () => {
		const provider = createSqlProviderHarness();
		const state = {
			sections: [
				{ id: 'legacy_sql_cmp', type: 'query', connectionIdHint: 'sql_legacy', query: 'SELECT 2', resultJson: '{"secret":true}' },
				{ id: 'kusto_query', type: 'query', connectionIdHint: 'kusto-1', query: 'T | count', resultJson: '{"count":1}' },
				{ id: 'markdown_1', type: 'markdown', text: 'Keep me' },
				{ id: 'chart_1', type: 'chart', chartType: 'bar' },
			],
		};

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[1]).toHaveProperty('resultJson', '{"count":1}');
		expect(sanitized.sections[2]).toMatchObject({ text: 'Keep me' });
		expect(sanitized.sections[3]).toMatchObject({ chartType: 'bar' });
	});

	it('prunes derived comparison owners immediately when their SQL source closes', () => {
		const provider = createSqlProviderHarness();
		provider._closedStsBoxIds = new Set();
		provider._openedStsBoxIds = new Set(['sql_1', 'sql_2']);
		provider._pendingStsTextByBoxId = new Map([['sql_1', 'SELECT 1'], ['sql_2', 'SELECT 2']]);
		provider._latestStsConnectSequenceByBoxId = new Map([['sql_1', 1], ['sql_2', 1]]);
		provider.sqlOwnership.revokeOwnerToken('sql_1');
		provider.sqlOwnership.adoptTarget('sql_2', 'sql-2', 'Db2', 1, () => undefined);
		provider.sqlOwnership.setComparisonOwner('comparison_1', { sourceBoxId: 'sql_1', connectionId: 'sql-1' });
		provider.sqlOwnership.setComparisonOwner('comparison_2', { sourceBoxId: 'sql_2', connectionId: 'sql-2' });
		const supersede = vi.spyOn(provider.sqlExecutionBroker, 'supersede');
		provider.copilot = { cancelCopilotWriteQuery: vi.fn(), cancelCopilotQueryTarget: vi.fn() };

		provider.handleStsDidClose('sql_1');

		expect(supersede).toHaveBeenCalledWith('sql_1', { notifyWebview: true });
		expect(supersede).toHaveBeenCalledWith('comparison_1', { notifyWebview: true });
		expect(provider.copilot.cancelCopilotWriteQuery).toHaveBeenCalledWith('sql_1');
		expect(provider.copilot.cancelCopilotWriteQuery).toHaveBeenCalledWith('comparison_1');
		expect(provider.sqlOwnership.getComparisonOwner('comparison_1')).toBeUndefined();
		expect(provider.sqlOwnership.getComparisonOwner('comparison_2')).toEqual({ sourceBoxId: 'sql_2', connectionId: 'sql-2' });
	});

	it('cancels and removes a SQL comparison owner immediately when the webview removes it', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlOwnership.setComparisonOwner('comparison_1', { sourceBoxId: 'sql_1', connectionId: 'sql-1', copilotSequence: 7 });
		provider.sqlOwnership.ownerTokenByBoxId.set('comparison_1', { token: 'token', owner: {} });
		provider.latestComparisonSummaryByKey = new Map([['sql_1::comparison_1', { dataMatches: true, headersMatch: true, timestamp: 1 }]]);
		const supersede = vi.spyOn(provider.sqlExecutionBroker, 'supersede');
		provider.copilot = { cancelCopilotWriteQuery: vi.fn(), cancelCopilotQueryTarget: vi.fn() };

		await provider.handleWebviewMessage({ type: 'sqlComparisonRemoved', boxId: 'comparison_1', sourceBoxId: 'sql_1' } as any);

		expect(supersede).toHaveBeenCalledWith('comparison_1', { notifyWebview: true });
		expect(supersede).not.toHaveBeenCalledWith('sql_1', expect.anything());
		expect(provider.copilot.cancelCopilotQueryTarget).toHaveBeenCalledWith('sql_1', 'comparison_1', 7);
		expect(provider.copilot.cancelCopilotWriteQuery).toHaveBeenCalledWith('sql_1', 7);
		expect(provider.sqlOwnership.getComparisonOwner('comparison_1')).toBeUndefined();
		expect(provider.sqlOwnership.getOwnerToken('comparison_1')).toBeUndefined();
		expect(provider.latestComparisonSummaryByKey.has('sql_1::comparison_1')).toBe(false);
	});

	it('ignores comparison removal events that are not tracked as SQL comparisons', async () => {
		const provider = createSqlProviderHarness();
		provider.cancelRunningQuery = vi.fn();
		provider.copilot = { cancelCopilotWriteQuery: vi.fn(), cancelCopilotQueryTarget: vi.fn() };

		await provider.handleWebviewMessage({ type: 'sqlComparisonRemoved', boxId: 'kusto_comparison', sourceBoxId: 'kusto_1' } as any);

		expect(provider.cancelRunningQuery).not.toHaveBeenCalled();
		expect(provider.copilot.cancelCopilotWriteQuery).not.toHaveBeenCalled();
	});

	it('cancels a tracked Kusto comparison and its exact Copilot sequence when removed', async () => {
		const provider = createSqlProviderHarness();
		provider._comparisonOwnerByBoxId.set('kusto_comparison', {
			sourceBoxId: 'kusto_1', copilotSequence: 9, comparisonRequestId: 'request-kusto',
		});
		provider.latestComparisonSummaryByKey = new Map();
		provider.cancelRunningQuery = vi.fn();
		provider.copilot = { cancelCopilotWriteQuery: vi.fn(), cancelCopilotQueryTarget: vi.fn() };

		await provider.handleWebviewMessage({
			type: 'sqlComparisonRemoved', boxId: 'kusto_comparison', sourceBoxId: 'kusto_1',
		} as any);

		expect(provider.cancelRunningQuery).toHaveBeenCalledWith('kusto_comparison', { notifyWebview: true });
		expect(provider.copilot.cancelCopilotQueryTarget).toHaveBeenCalledWith('kusto_1', 'kusto_comparison', 9);
		expect(provider.copilot.cancelCopilotWriteQuery).toHaveBeenCalledWith('kusto_1', 9);
		expect(provider._comparisonOwnerByBoxId.has('kusto_comparison')).toBe(false);
	});

	it('tombstones a SQL comparison but rejects a mismatched source cancellation', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlOwnership.setComparisonOwner('comparison_1', { sourceBoxId: 'sql_1', connectionId: 'sql-1', copilotSequence: 7 });
		provider.sqlOwnership.ownerTokenByBoxId.set('comparison_1', { token: 'token', owner: {} });
		provider.latestComparisonSummaryByKey = new Map();
		const supersede = vi.spyOn(provider.sqlExecutionBroker, 'supersede');
		provider.copilot = { cancelCopilotWriteQuery: vi.fn(), cancelCopilotQueryTarget: vi.fn() };

		await provider.handleWebviewMessage({ type: 'sqlComparisonRemoved', boxId: 'comparison_1', sourceBoxId: 'sql_new' } as any);

		expect(supersede).toHaveBeenCalledWith('comparison_1', { notifyWebview: true });
		expect(provider.copilot.cancelCopilotQueryTarget).toHaveBeenCalledWith('sql_1', 'comparison_1', 7);
		expect(provider.copilot.cancelCopilotWriteQuery).not.toHaveBeenCalled();
		expect(provider.sqlOwnership.getComparisonOwner('comparison_1')).toBeUndefined();
		expect(provider.sqlOwnership.getOwnerToken('comparison_1')).toBeUndefined();
	});

	it('tombstones a SQL comparison but rejects whole-sequence cancellation when the source is omitted', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlOwnership.setComparisonOwner('comparison_1', { sourceBoxId: 'sql_1', connectionId: 'sql-1', copilotSequence: 7 });
		provider.latestComparisonSummaryByKey = new Map();
		provider.cancelRunningQuery = vi.fn();
		provider.copilot = { cancelCopilotWriteQuery: vi.fn(), cancelCopilotQueryTarget: vi.fn() };

		await provider.handleWebviewMessage({ type: 'sqlComparisonRemoved', boxId: 'comparison_1' } as any);

		expect(provider.copilot.cancelCopilotQueryTarget).toHaveBeenCalledWith('sql_1', 'comparison_1', 7);
		expect(provider.copilot.cancelCopilotWriteQuery).not.toHaveBeenCalled();
		expect(provider.sqlOwnership.getComparisonOwner('comparison_1')).toBeUndefined();
	});

	it('does not cancel newer source work for a restored comparison without a live sequence', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlOwnership.setComparisonOwner('comparison_1', { sourceBoxId: 'sql_1', connectionId: 'sql-1' });
		provider.latestComparisonSummaryByKey = new Map();
		provider.cancelRunningQuery = vi.fn();
		provider.copilot = { cancelCopilotWriteQuery: vi.fn() };

		await provider.handleWebviewMessage({ type: 'sqlComparisonRemoved', boxId: 'comparison_1', sourceBoxId: 'sql_1' } as any);

		expect(provider.copilot.cancelCopilotWriteQuery).not.toHaveBeenCalled();
		expect(provider.sqlOwnership.getComparisonOwner('comparison_1')).toBeUndefined();
	});

	it('preserves a live comparison sequence while rebuilding owners from persisted state', () => {
		const provider = createSqlProviderHarness();
		const liveOwner = { sourceBoxId: 'sql_1', connectionId: 'sql-1', copilotSequence: 7, comparisonRequestId: 'request-1' };
		provider.sqlOwnership.setComparisonOwner('comparison_1', liveOwner);

		provider.rebuildSqlComparisonOwners([
			{ id: 'sql_1', type: 'sql' },
			{ id: 'comparison_1', type: 'query', comparisonSourceBoxId: 'sql_1' },
		]);

		expect(provider.sqlOwnership.getComparisonOwner('comparison_1')).toBe(liveOwner);
		expect(provider.sqlOwnership.getComparisonOwner('comparison_1')?.copilotSequence).toBe(7);
	});

	it('tombstones a comparison removed while SQL policy admission is pending', async () => {
		const provider = createSqlProviderHarness();
		const policy = deferred<void>();
		const resolve = vi.fn();
		const reject = vi.fn();
		provider.pendingComparisonEnsureByRequestId = new Map([['request-1', {
			resolve,
			reject,
			timer: setTimeout(() => undefined, 10_000),
			sourceBoxId: 'sql_1',
			sqlConnectionId: 'sql-1',
			copilotSequence: 7,
		}]]);
		provider.latestComparisonSummaryByKey = new Map();
		provider.cancelRunningQuery = vi.fn();
		provider.copilot = { cancelCopilotWriteQuery: vi.fn(), cancelCopilotQueryTarget: vi.fn() };
		provider.sqlWorkbench.assertSqlConnectionAllowed = vi.fn(() => policy.promise);

		const ensured = provider.handleWebviewMessage({
			type: 'comparisonBoxEnsured', requestId: 'request-1', comparisonBoxId: 'comparison_1',
		} as any);
		await vi.waitFor(() => expect(provider.sqlWorkbench.assertSqlConnectionAllowed).toHaveBeenCalledOnce());
		expect(provider.sqlOwnership.getComparisonOwner('comparison_1')).toMatchObject({
			sourceBoxId: 'sql_1', copilotSequence: 7, comparisonRequestId: 'request-1',
		});

		await provider.handleWebviewMessage({ type: 'sqlComparisonRemoved', boxId: 'comparison_1', sourceBoxId: 'sql_1' } as any);

		expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: 'Canceled' }));
		expect(provider.pendingComparisonEnsureByRequestId.has('request-1')).toBe(false);
		expect(provider.sqlOwnership.getComparisonOwner('comparison_1')).toBeUndefined();
		expect(provider.copilot.cancelCopilotWriteQuery).toHaveBeenCalledWith('sql_1', 7);

		policy.resolve(undefined);
		await ensured;
		expect(resolve).not.toHaveBeenCalled();
		expect(provider.sqlOwnership.getComparisonOwner('comparison_1')).toBeUndefined();
	});

	it('drops a delayed STS change when the section instance is replaced', async () => {
		const provider = createSqlProviderHarness();
		const policy = deferred<void>();
		provider._openedStsBoxIds = new Set(['sql_1']);
		provider._closedStsBoxIds = new Set();
		provider.sqlWorkbench.assertSqlConnectionAllowed = vi.fn(() => policy.promise);
		const service = { changeDocument: vi.fn(async () => undefined) };
		provider._stsLanguageService = service;

		const changing = provider.handleWebviewMessage({
			type: 'stsDidChange', boxId: 'sql_1', sectionInstanceId: 'instance-1', text: 'SELECT old',
		} as any);
		await vi.waitFor(() => expect(provider.sqlWorkbench.assertSqlConnectionAllowed).toHaveBeenCalledOnce());
		provider._sqlSectionInstanceIdByBoxId.set('sql_1', 'instance-2');

		policy.resolve(undefined);
		await changing;

		expect(service.changeDocument).not.toHaveBeenCalled();
	});

	it('applies only the latest same-instance STS text when policy admission is delayed', async () => {
		const provider = createSqlProviderHarness();
		const firstPolicy = deferred<void>();
		provider._openedStsBoxIds = new Set(['sql_1']);
		provider._closedStsBoxIds = new Set();
		provider.sqlWorkbench.assertSqlConnectionAllowed = vi.fn()
			.mockImplementationOnce(() => firstPolicy.promise)
			.mockResolvedValue(undefined);
		const service = { changeDocument: vi.fn(async () => undefined) };
		provider._stsLanguageService = service;

		const first = provider.handleStsDidChange('sql_1', 'instance-1', 'SELECT old');
		await vi.waitFor(() => expect(provider.sqlWorkbench.assertSqlConnectionAllowed).toHaveBeenCalledOnce());
		const second = provider.handleStsDidChange('sql_1', 'instance-1', 'SELECT newest');

		firstPolicy.resolve(undefined);
		await Promise.all([first, second]);

		expect(service.changeDocument).toHaveBeenCalledOnce();
		expect(service.changeDocument).toHaveBeenCalledWith('sql_1', 'SELECT newest', 'instance-1');
	});

	it('sends metadata-only SQL connection changes without invalidating an equivalent endpoint', async () => {
		const provider = createSqlProviderHarness();
		const previous = {
			id: 'sql-1', name: 'Old name', dialect: 'mssql', serverUrl: 'server.example',
			authType: 'sql-login', username: 'user',
		};
		const next = { ...previous, name: 'New name', port: 1433 };
		provider.sqlConnectionSignatureById = new Map([['sql-1', sqlConnectionTargetSignature(previous)]]);
		provider.sendSqlConnectionsData = vi.fn(async () => undefined);
		provider.copilot = { invalidateSqlConnections: vi.fn() };

		await provider.handleSqlConnectionsChanged([next]);

		expect(provider.sendSqlConnectionsData).toHaveBeenCalledOnce();
		expect(provider.copilot.invalidateSqlConnections).not.toHaveBeenCalled();
	});
	it('explicit user cancel posts queryCancelled immediately and suppresses a late result', async () => {
		const provider = createProviderHarness();
		const pending = deferred<any>();
		const cancel = vi.fn();
		provider.kustoClient.executeQueryCancelable.mockReturnValueOnce({
			promise: pending.promise,
			cancel,
			clientActivityId: 'KW.execute_query;manual-cancel',
		});

		const task = provider.executeQueryFromWebview(executeMessage('query_1'));
		await flushPromises();

		provider.cancelRunningQuery('query_1', { notifyWebview: true });

		expect(cancel).toHaveBeenCalledTimes(1);
		expect(provider.isRunningQueryCurrent('query_1', cancel, 1)).toBe(false);
		expect(provider.postMessage).toHaveBeenCalledWith({ type: 'queryCancelled', boxId: 'query_1' });

		pending.resolve(queryResult('late'));
		await task;

		expect(provider.postMessage).not.toHaveBeenCalledWith({ type: 'queryResult', result: queryResult('late'), boxId: 'query_1' });
	});

	it('rerunning the same box silently cancels the old run and only posts the new result', async () => {
		const provider = createProviderHarness();
		const first = deferred<any>();
		const firstCancel = vi.fn();
		const secondCancel = vi.fn();
		const secondResult = queryResult('second');
		provider.kustoClient.executeQueryCancelable
			.mockReturnValueOnce({ promise: first.promise, cancel: firstCancel, clientActivityId: 'KW.execute_query;first', getAccountPartition: () => 'partition-current' })
			.mockReturnValueOnce({ promise: Promise.resolve(secondResult), cancel: secondCancel, clientActivityId: 'KW.execute_query;second', getAccountPartition: () => 'partition-current' });

		const firstTask = provider.executeQueryFromWebview(executeMessage('query_1', 'print label="first"'));
		await flushPromises();

		await provider.executeQueryFromWebview(executeMessage('query_1', 'print label="second"'));

		expect(firstCancel).toHaveBeenCalledTimes(1);
		expect(provider.postMessage).not.toHaveBeenCalledWith({ type: 'queryCancelled', boxId: 'query_1' });
		expect(provider.postMessage).toHaveBeenCalledWith({ type: 'queryResult', result: secondResult, boxId: 'query_1' });

		first.resolve(queryResult('first'));
		await firstTask;

		const queryResults = provider.postMessage.mock.calls
			.map((call: unknown[]) => call[0] as any)
			.filter((message: any) => message?.type === 'queryResult');
		expect(queryResults).toHaveLength(1);
		expect(queryResults[0].result).toBe(secondResult);
	});

	it('does not publish a result superseded while its identity snapshot is pending', async () => {
		const provider = createProviderHarness();
		const snapshot = deferred<void>();
		const firstResult = queryResult('first');
		const secondResult = queryResult('second');
		provider.refreshConnectionsData.mockImplementationOnce(async () => snapshot.promise);
		provider.kustoClient.executeQueryCancelable
			.mockReturnValueOnce({ promise: Promise.resolve(firstResult), cancel: vi.fn(), clientActivityId: 'KW.execute_query;first', getAccountPartition: () => 'partition-current' })
			.mockReturnValueOnce({ promise: Promise.resolve(secondResult), cancel: vi.fn(), clientActivityId: 'KW.execute_query;second', getAccountPartition: () => 'partition-current' });

		const firstTask = provider.executeQueryFromWebview(executeMessage('query_1', 'print label="first"'));
		await flushPromises();
		const secondTask = provider.executeQueryFromWebview(executeMessage('query_1', 'print label="second"'));
		snapshot.resolve();
		await Promise.all([firstTask, secondTask]);

		const queryResults = provider.postMessage.mock.calls
			.map((call: unknown[]) => call[0] as any)
			.filter((message: any) => message?.type === 'queryResult');
		expect(queryResults).toEqual([{ type: 'queryResult', result: secondResult, boxId: 'query_1' }]);
	});

	it('does not publish account A rows after the snapshot adopts account B', async () => {
		const provider = createProviderHarness();
		const snapshot = deferred<void>();
		let currentPartition = 'partition-a';
		provider.kustoClient.getAccountPartition.mockImplementation(() => currentPartition);
		provider.refreshConnectionsData.mockImplementationOnce(async () => snapshot.promise);
		provider.kustoClient.executeQueryCancelable.mockReturnValueOnce({
			promise: Promise.resolve(queryResult('account-a')),
			cancel: vi.fn(),
			clientActivityId: 'KW.execute_query;account-a',
			getAccountPartition: () => 'partition-a',
		});

		const task = provider.executeQueryFromWebview(executeMessage('query_1'));
		await flushPromises();
		currentPartition = 'partition-b';
		snapshot.resolve();
		await task;

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
	});

	it('explicit cancel with no running query still unsticks the webview', async () => {
		const provider = createProviderHarness();

		await provider.handleWebviewMessage({ type: 'cancelQuery', boxId: 'query_missing' } as any);

		expect(provider.postMessage).toHaveBeenCalledWith({ type: 'queryCancelled', boxId: 'query_missing' });
	});

	it('cancels only the requested box when multiple boxes are running', () => {
		const provider = createProviderHarness();
		const cancelA = vi.fn();
		const cancelB = vi.fn();

		provider.registerRunningQuery('query_a', cancelA, 1, 'KW.execute_query;a');
		provider.registerRunningQuery('query_b', cancelB, 2, 'KW.execute_query;b');
		provider.cancelRunningQuery('query_a', { notifyWebview: true });

		expect(cancelA).toHaveBeenCalledTimes(1);
		expect(cancelB).not.toHaveBeenCalled();
		expect(provider.postMessage).toHaveBeenCalledWith({ type: 'queryCancelled', boxId: 'query_a' });

		provider.cancelRunningQuery('query_b');
		expect(cancelB).toHaveBeenCalledTimes(1);
	});

	it('unregisters only the matching running query handle', () => {
		const provider = createProviderHarness();
		const oldCancel = vi.fn();
		const newCancel = vi.fn();

		provider.registerRunningQuery('query_1', oldCancel, 1, 'KW.execute_query;old');
		provider.registerRunningQuery('query_1', newCancel, 2, 'KW.execute_query;new');
		provider.unregisterRunningQuery('query_1', oldCancel, 1);

		expect(provider.isRunningQueryCurrent('query_1', newCancel, 2)).toBe(true);
		provider.unregisterRunningQuery('query_1', newCancel, 2);
		expect(provider.isRunningQueryCurrent('query_1', newCancel, 2)).toBe(false);
	});

	it('strips leading comments only from the control-command payload sent to Kusto', async () => {
		const provider = createProviderHarness();
		const originalQuery = '  // create helper\r\n\t.create-or-update function F() { print x=1 }\n// trailing note';
		const message = executeMessage('query_1', originalQuery);
		message.cacheEnabled = true;
		message.queryMode = 'take100';
		provider.isControlCommand = vi.fn(() => true);
		provider.appendQueryMode = vi.fn((query: string) => query);
		provider.buildCacheDirective = vi.fn(() => 'set query_results_cache_max_age = time(1h);');
		provider.kustoClient.executeQueryCancelable.mockReturnValueOnce({
			promise: Promise.resolve(queryResult('ok')),
			cancel: vi.fn(),
			clientActivityId: 'KW.execute_query;commented-control',
		});

		await provider.executeQueryFromWebview(message);

		expect(provider.buildCacheDirective).not.toHaveBeenCalled();
		expect(provider.kustoClient.executeQueryCancelable).toHaveBeenCalledWith(
			TEST_CONNECTION,
			'Samples',
			'.create-or-update function F() { print x=1 }\n// trailing note',
			'query_1::conn-1'
		);
		expect(message.query).toBe(originalQuery);
	});

	it('uses real control-command detection to suppress cache and query-mode changes before stripping', async () => {
		const provider = createProviderHarness();
		const originalQuery = '  // create helper\r\n\t.create-or-update function F() { print x=1 }';
		const message = executeMessage('query_1', originalQuery);
		message.cacheEnabled = true;
		message.queryMode = 'take100';
		provider.isControlCommand = vi.fn((query: string) => isControlCommand(query));
		provider.appendQueryMode = vi.fn((query: string, mode?: string) => appendQueryMode(query, mode));
		provider.buildCacheDirective = vi.fn(() => 'set query_results_cache_max_age = time(1h);');
		provider.kustoClient.executeQueryCancelable.mockReturnValueOnce({
			promise: Promise.resolve(queryResult('ok')),
			cancel: vi.fn(),
			clientActivityId: 'KW.execute_query;real-control-detection',
		});

		await provider.executeQueryFromWebview(message);

		expect(provider.isControlCommand).toHaveBeenCalledWith(originalQuery);
		expect(provider.buildCacheDirective).not.toHaveBeenCalled();
		expect(provider.kustoClient.executeQueryCancelable).toHaveBeenCalledWith(
			TEST_CONNECTION,
			'Samples',
			'.create-or-update function F() { print x=1 }',
			'query_1::conn-1'
		);
		expect(message.query).toBe(originalQuery);
	});
});