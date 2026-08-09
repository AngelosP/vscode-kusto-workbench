import { afterEach, describe, expect, it, vi } from 'vitest';

import { QueryRunCoordinator } from '../../../src/host/queryRunCoordinator';
import { SqlQueryCancelledError } from '../../../src/host/sqlClient';
import {
	HostSqlSectionExecutionApplicationHandler,
	type SqlSectionExecutionApplicationHandler,
} from '../../../src/host/sqlSectionExecutionApplicationHandler';
import { SqlExecutionBroker } from '../../../src/host/sql/sqlExecutionBroker';
import type { SqlIssuedOwnerToken, SqlResultOwner } from '../../../src/host/sql/sqlEditorSessionRegistry';
import type { ExecuteSqlQueryMessage, IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

const connection = Object.freeze({
	id: 'sql-1',
	name: 'SQL',
	dialect: 'mssql',
	serverUrl: 'server.example',
	authType: 'aad',
});

const initialOwner: SqlResultOwner = Object.freeze({
	connectionId: 'sql-1',
	database: 'Db',
	generation: 1,
	targetSignature: 'server.example|1433|mssql|aad',
	principalFingerprint: 'aad:account-a',
	revocationGeneration: 0,
});

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function result(value: unknown = 42) {
	return {
		columns: [{ name: 'Value', type: 'int' }],
		rows: [[value]],
		metadata: {},
	};
}

function executeMessage(overrides: Partial<ExecuteSqlQueryMessage> = {}): ExecuteSqlQueryMessage {
	return {
		type: 'executeSqlQuery',
		query: 'SELECT Value FROM dbo.T',
		sqlConnectionId: 'sql-1',
		boxId: 'sql-box',
		sectionInstanceId: 'sql-instance',
		database: 'Db',
		queryMode: 'plain',
		ownerToken: 'owner-token',
		executionId: 'execution-1',
		...overrides,
	};
}

function createHarness() {
	let currentConnection: typeof connection | undefined = connection;
	let currentOwner = initialOwner;
	let sectionCurrent = true;
	let protectedExecution = false;
	const issuedOwner = (): SqlIssuedOwnerToken => ({ token: 'owner-token', owner: currentOwner });
	const postMessage = vi.fn((_message: unknown) => true);
	const output = { warn: vi.fn(), error: vi.fn() };
	const refreshConnectionsData = vi.fn(async () => undefined);
	const isSectionCurrent = vi.fn((_boxId: string, sectionInstanceId: string) =>
		sectionCurrent && sectionInstanceId === 'sql-instance');
	const assertOwnerToken = vi.fn(async () => issuedOwner());
	const assertOwnerTokenProtection = vi.fn(async () => issuedOwner());
	const assertResultOwnerAllowed = vi.fn(async () => undefined);
	const assertResultOwnerProtection = vi.fn(async () => undefined);
	const dispatchAllowed = vi.fn(async (
		_boxId: string,
		_owner: SqlResultOwner,
		dispatch: () => unknown,
	) => await dispatch());
	const dispatchProtection = vi.fn(async (
		_boxId: string,
		_owner: SqlResultOwner,
		_expectedProtected: boolean,
		dispatch: () => unknown,
	) => await dispatch());
	const lifecycle = {
		isSectionCurrent,
		assertOwnerToken,
		assertOwnerTokenProtection,
		assertResultOwnerAllowed,
		assertResultOwnerProtection,
		dispatchResultOwnerAllowed<T>(
			boxId: string,
			owner: SqlResultOwner,
			dispatch: () => T | PromiseLike<T>,
		): Promise<T> {
			return dispatchAllowed(boxId, owner, dispatch) as Promise<T>;
		},
		dispatchResultOwnerProtection<T>(
			boxId: string,
			owner: SqlResultOwner,
			expectedProtected: boolean,
			dispatch: () => T | PromiseLike<T>,
		): Promise<T> {
			return dispatchProtection(boxId, owner, expectedProtected, dispatch) as Promise<T>;
		},
	};
	const queryRuns = new QueryRunCoordinator();
	const broker = new SqlExecutionBroker({
		queryRuns,
		getOwnerToken: () => 'owner-token',
		postMessage,
	});
	const cancel = vi.fn();
	const executeQueryCancelable = vi.fn(() => ({
		promise: Promise.resolve(result()),
		cancel,
	}));
	const getConnection = vi.fn(() => currentConnection);
	const isLeaveNoTraceConnection = vi.fn(() => protectedExecution);
	const handler: SqlSectionExecutionApplicationHandler = new HostSqlSectionExecutionApplicationHandler({
		sqlLifecycle: lifecycle,
		sqlExecutionBroker: broker,
		sqlWorkbench: { isLeaveNoTraceConnection },
		connectionManager: { getConnection },
		client: { executeQueryCancelable },
		postMessage,
		refreshConnectionsData,
		output,
	});
	const send = (message: IncomingWebviewMessage): Promise<void> => {
		const claimed = handler.handleMessage(message);
		if (!claimed) throw new Error(`Handler declined ${message.type}.`);
		return claimed;
	};

	return {
		handler,
		send,
		isSectionCurrent,
		broker,
		queryRuns,
		postMessage,
		output,
		refreshConnectionsData,
		executeQueryCancelable,
		getConnection,
		isLeaveNoTraceConnection,
		assertOwnerToken,
		assertOwnerTokenProtection,
		assertResultOwnerAllowed,
		assertResultOwnerProtection,
		dispatchAllowed,
		dispatchProtection,
		cancel,
		setConnection: (value: typeof connection | undefined) => { currentConnection = value; },
		setOwner: (value: SqlResultOwner) => { currentOwner = value; },
		setSectionCurrent: (value: boolean) => { sectionCurrent = value; },
		setProtected: (value: boolean) => { protectedExecution = value; },
	};
}

describe('HostSqlSectionExecutionApplicationHandler', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('declines unrelated traffic synchronously', () => {
		const harness = createHarness();

		expect(harness.handler.handleMessage({ type: 'getConnections' })).toBeUndefined();
		expect(harness.isSectionCurrent).not.toHaveBeenCalled();
	});

	it.each([
		['blank box ID', executeMessage({ boxId: ' ' })],
		['blank execution ID', executeMessage({ executionId: ' ' })],
		['stale section incarnation', executeMessage({ sectionInstanceId: 'stale-instance' })],
	] as const)('ignores %s before reserving execution', async (_label, message) => {
		const harness = createHarness();
		const reserve = vi.spyOn(harness.broker, 'reservePreflight');

		await harness.send(message);

		expect(harness.executeQueryCancelable).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
		expect(reserve).not.toHaveBeenCalled();
	});

	it.each([
		['missing connection', () => undefined, 'Db', initialOwner,
			'SQL connection not found. Please configure a connection.'],
		['missing database', () => connection, '', initialOwner, 'Please select a database.'],
		['changed target', () => connection, 'Db', { ...initialOwner, database: 'OtherDb' },
			'SQL section target changed. Run the query again.'],
	] as const)('publishes and cleans up the %s preflight terminal', async (
		_label,
		connectionFactory,
		database,
		owner,
		expectedError,
	) => {
		const harness = createHarness();
		harness.setConnection(connectionFactory());
		harness.setOwner(owner);
		const message = executeMessage({ database, executionId: `execution-${_label}` });

		await harness.send(message);

		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryError', boxId: 'sql-box', executionId: message.executionId,
			error: expectedError,
		}));
		expect(harness.executeQueryCancelable).not.toHaveBeenCalled();
		expect(harness.broker.cancelExpected('sql-box', message.executionId, false)).toBe(false);
	});

	it('shapes physical query mode but publishes the exact authored query and result identity', async () => {
		const harness = createHarness();
		const message = executeMessage({
			query: 'SELECT Value FROM dbo.T',
			queryMode: 'top100',
			executionId: 'execution-shaped',
			comparisonSourceBoxId: 'source-box',
			comparisonSourceExecutionId: 'source-execution',
		});

		await harness.send(message);

		expect(harness.executeQueryCancelable).toHaveBeenCalledWith(
			connection,
			'Db',
			'SELECT TOP 100 Value FROM dbo.T',
		);
		expect(harness.refreshConnectionsData).toHaveBeenCalledOnce();
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'queryResult',
			result: result(),
			boxId: 'sql-box',
			ownerToken: 'owner-token',
			executionId: 'execution-shaped',
			query: 'SELECT Value FROM dbo.T',
			connectionId: 'sql-1',
			database: 'Db',
			comparisonSourceBoxId: 'source-box',
			comparisonSourceExecutionId: 'source-execution',
		});
		expect(harness.queryRuns.has('sql-box')).toBe(false);
		expect(harness.broker.cancelExpected('sql-box', 'execution-shaped', false)).toBe(false);
	});

	it('reserves preflight synchronously and lets exact cancel win owner validation', async () => {
		const harness = createHarness();
		const validation = deferred<SqlIssuedOwnerToken>();
		harness.assertOwnerToken.mockReturnValueOnce(validation.promise);
		const reserve = vi.spyOn(harness.broker, 'reservePreflight');

		const run = harness.send(executeMessage({ executionId: 'execution-cancel-validation' }));
		expect(reserve).toHaveBeenCalledOnce();
		await harness.send({
			type: 'cancelSqlQuery', boxId: 'sql-box', sectionInstanceId: 'sql-instance',
			executionId: 'execution-cancel-validation',
		});
		validation.resolve({ token: 'owner-token', owner: initialOwner });
		await run;
		await Promise.resolve();

		expect(harness.executeQueryCancelable).not.toHaveBeenCalled();
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'queryCancelled', boxId: 'sql-box', ownerToken: 'owner-token',
			executionId: 'execution-cancel-validation',
		});
	});

	it('lets a newer run replace a paused validation without stale error publication', async () => {
		const harness = createHarness();
		const firstValidation = deferred<SqlIssuedOwnerToken>();
		harness.assertOwnerToken
			.mockReturnValueOnce(firstValidation.promise)
			.mockResolvedValueOnce({ token: 'owner-token', owner: initialOwner });

		const first = harness.send(executeMessage({ executionId: 'execution-old', query: 'SELECT 1' }));
		const second = harness.send(executeMessage({ executionId: 'execution-new', query: 'SELECT 2' }));
		firstValidation.reject(new Error('stale owner failure'));
		await Promise.all([first, second]);
		await Promise.resolve();

		expect(harness.executeQueryCancelable).toHaveBeenCalledOnce();
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryCancelled', executionId: 'execution-old',
		}));
		expect(harness.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryError', error: 'stale owner failure',
		}));
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryResult', executionId: 'execution-new', query: 'SELECT 2',
		}));
	});

	it('rejects tool-owner drift before physical dispatch', async () => {
		const harness = createHarness();

		await harness.send(executeMessage({
			executionId: 'tool-drift',
			toolExecution: true,
			expectedOwner: {
				connectionId: 'sql-1',
				database: 'Db',
				targetSignature: initialOwner.targetSignature,
				principalFingerprint: 'aad:stale-account',
				revocationGeneration: 0,
			},
		}));

		expect(harness.executeQueryCancelable).not.toHaveBeenCalled();
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryError', executionId: 'tool-drift',
			error: 'SQL tool execution owner changed before query dispatch.',
		}));
	});

	it.each([false, true])('publishes success through protected=%s owner mode', async protectedMode => {
		const harness = createHarness();
		harness.setProtected(protectedMode);

		await harness.send(executeMessage({ executionId: `success-${protectedMode}` }));

		if (protectedMode) {
			expect(harness.assertOwnerTokenProtection).toHaveBeenCalledWith('sql-box', 'owner-token', true);
			expect(harness.assertResultOwnerProtection).toHaveBeenCalledWith('sql-box', initialOwner, true);
			expect(harness.dispatchProtection).toHaveBeenCalled();
			expect(harness.assertOwnerToken).not.toHaveBeenCalled();
		} else {
			expect(harness.assertOwnerToken).toHaveBeenCalledWith('sql-box', 'owner-token');
			expect(harness.assertResultOwnerAllowed).toHaveBeenCalledWith('sql-box', initialOwner);
			expect(harness.dispatchAllowed).toHaveBeenCalled();
			expect(harness.assertOwnerTokenProtection).not.toHaveBeenCalled();
		}
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryResult', executionId: `success-${protectedMode}`,
		}));
	});

	it('publishes an ordinary error with sanitized durable logging', async () => {
		const harness = createHarness();
		harness.executeQueryCancelable.mockReturnValueOnce({
			promise: Promise.reject(new Error('backend\r\nsecret')),
			cancel: vi.fn(),
		});

		await harness.send(executeMessage({ executionId: 'ordinary-error' }));

		const durableLog = String(harness.output.error.mock.calls[0]?.[0] ?? '');
		expect(durableLog).toContain('backend');
		expect(durableLog).toContain('secret');
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryError', error: 'backend\r\nsecret', executionId: 'ordinary-error',
		}));
	});

	it('keeps protected backend details out of durable logging', async () => {
		const harness = createHarness();
		harness.setProtected(true);
		harness.executeQueryCancelable.mockReturnValueOnce({
			promise: Promise.reject(new Error('SECRET_PROTECTED_BACKEND_DETAIL')),
			cancel: vi.fn(),
		});

		await harness.send(executeMessage({ executionId: 'protected-error' }));

		expect(JSON.stringify([
			...harness.output.warn.mock.calls,
			...harness.output.error.mock.calls,
		])).not.toContain('SECRET_PROTECTED_BACKEND_DETAIL');
		expect(harness.output.warn).toHaveBeenCalledWith(
			'[sql-lnt] Isolated SQL query failed; details were not logged.',
		);
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryError', error: 'SECRET_PROTECTED_BACKEND_DETAIL', executionId: 'protected-error',
		}));
	});

	it.each([
		['ordinary error', false, new SqlQueryCancelledError('cancelled')],
		['ordinary marker', false, { isCancelled: true }],
		['protected error', true, new SqlQueryCancelledError('cancelled')],
	] as const)('publishes %s as an exact cancellation terminal', async (
		_label,
		protectedMode,
		cancellation,
	) => {
		const harness = createHarness();
		harness.setProtected(protectedMode);
		harness.executeQueryCancelable.mockReturnValueOnce({
			promise: Promise.reject(cancellation),
			cancel: vi.fn(),
		});

		await harness.send(executeMessage({ executionId: `cancelled-${protectedMode}` }));

		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'queryCancelled', boxId: 'sql-box', ownerToken: 'owner-token',
			executionId: `cancelled-${protectedMode}`,
		});
		expect(harness.output.error).not.toHaveBeenCalled();
	});

	it('suppresses delayed rows after target replacement', async () => {
		const harness = createHarness();
		const pending = deferred<ReturnType<typeof result>>();
		harness.executeQueryCancelable.mockReturnValueOnce({ promise: pending.promise, cancel: vi.fn() });
		const run = harness.send(executeMessage({ executionId: 'target-rotation' }));
		await Promise.resolve();

		harness.broker.supersede('sql-box');
		harness.setSectionCurrent(false);
		pending.resolve(result('stale'));
		await run;

		expect(harness.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
		expect(harness.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryError' }));
	});

	it.each([false, true])('suppresses completed rows after protected=%s owner or policy rotation', async protectedMode => {
		const harness = createHarness();
		harness.setProtected(protectedMode);
		if (protectedMode) {
			harness.assertResultOwnerProtection.mockRejectedValueOnce(new Error('protected owner rotated'));
			harness.dispatchProtection.mockRejectedValue(new Error('protected owner rotated'));
		} else {
			harness.assertResultOwnerAllowed.mockRejectedValueOnce(new Error('owner rotated'));
			harness.dispatchAllowed.mockRejectedValue(new Error('owner rotated'));
		}

		await harness.send(executeMessage({ executionId: `owner-rotation-${protectedMode}` }));

		expect(harness.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
		expect(harness.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryError' }));
		expect(harness.output.warn).toHaveBeenCalledWith(
			'[sql] Query failed after owner invalidation; error details suppressed.',
		);
	});

	it('contains synchronous client and transport failures and performs exact cleanup', async () => {
		const harness = createHarness();
		harness.executeQueryCancelable.mockImplementationOnce(() => {
			throw new Error('synchronous client failure');
		});

		await harness.send(executeMessage({ executionId: 'sync-client-failure' }));

		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryError', error: 'synchronous client failure', executionId: 'sync-client-failure',
		}));
		expect(harness.broker.cancelExpected('sql-box', 'sync-client-failure', false)).toBe(false);
		expect(harness.queryRuns.has('sql-box')).toBe(false);

		harness.postMessage.mockClear();
		harness.postMessage.mockImplementation(() => { throw new Error('synchronous transport failure'); });
		await harness.send(executeMessage({ executionId: 'sync-transport-failure' }));

		expect(harness.output.warn).toHaveBeenCalledWith(
			'[sql] Query failed after owner invalidation; error details suppressed.',
		);
		expect(harness.broker.cancelExpected('sql-box', 'sync-transport-failure', false)).toBe(false);
		expect(harness.queryRuns.has('sql-box')).toBe(false);
	});

	it('lets accepted work settle across disposal and suppresses later recognized traffic idempotently', async () => {
		const harness = createHarness();
		const pending = deferred<ReturnType<typeof result>>();
		harness.executeQueryCancelable.mockReturnValueOnce({ promise: pending.promise, cancel: vi.fn() });
		const run = harness.send(executeMessage({ executionId: 'accepted-before-disposal' }));
		await Promise.resolve();

		harness.handler.dispose();
		harness.handler.dispose();
		pending.resolve(result('accepted'));
		await run;
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryResult', executionId: 'accepted-before-disposal',
		}));

		harness.postMessage.mockClear();
		harness.executeQueryCancelable.mockClear();
		await harness.send(executeMessage({ executionId: 'after-disposal' }));
		await harness.send({
			type: 'cancelSqlQuery', boxId: 'sql-box', sectionInstanceId: 'sql-instance',
			executionId: 'after-disposal',
		});
		expect(harness.executeQueryCancelable).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});
});
