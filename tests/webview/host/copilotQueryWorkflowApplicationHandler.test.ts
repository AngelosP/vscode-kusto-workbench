import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	HostCopilotQueryWorkflowApplicationHandler,
	type CopilotQueryWorkflowApplicationHandlerOptions,
} from '../../../src/host/copilotQueryWorkflowApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

const SQL_PREFLIGHT_EXECUTION_ID = 'sql-copilot-owner-preflight';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createKustoStartMessage(): Extract<IncomingWebviewMessage, {
	type: 'startCopilotWriteQuery';
}> {
	return {
		type: 'startCopilotWriteQuery',
		boxId: 'kusto-start-exact',
		connectionId: 'kusto-connection-exact',
		serverUrl: 'https://kusto-exact.example.net',
		database: 'KustoDatabaseExact',
		currentQuery: 'StormEvents | take 5',
		request: 'Write an exact Kusto query',
		modelId: 'model-exact',
		enabledTools: ['tool-exact'],
		queryMode: 'take100',
		requireToolUse: true,
		flavor: 'kusto',
		copilotRequestId: 'copilot-start-request-exact',
		sectionInstanceId: 'kusto-start-section-exact',
		targetGeneration: 11,
	};
}

function createSqlStartMessage(): Extract<IncomingWebviewMessage, {
	type: 'startCopilotWriteQuery';
}> {
	return {
		type: 'startCopilotWriteQuery',
		boxId: 'sql-start-exact',
		connectionId: 'sql-connection-exact',
		serverUrl: 'sql-exact.example.net',
		database: 'SqlDatabaseExact',
		currentQuery: 'SELECT TOP 5 * FROM dbo.Events',
		request: 'Write an exact SQL query',
		modelId: 'model-exact',
		enabledTools: ['tool-exact'],
		queryMode: 'take100',
		requireToolUse: true,
		flavor: 'sql',
		sqlOwnerToken: 'sql-owner-token-exact',
	};
}

function createKustoCancelMessage(): Extract<IncomingWebviewMessage, {
	type: 'cancelCopilotWriteQuery';
}> {
	return {
		type: 'cancelCopilotWriteQuery',
		boxId: 'kusto-cancel-exact',
		flavor: 'kusto',
		copilotRequestId: 'copilot-cancel-request-exact',
		sectionInstanceId: 'kusto-cancel-section-exact',
		targetGeneration: 13,
	};
}

function createOptimizeMessages(): [
	Extract<IncomingWebviewMessage, { type: 'prepareOptimizeQuery' }>,
	Extract<IncomingWebviewMessage, { type: 'cancelOptimizeQuery' }>,
	Extract<IncomingWebviewMessage, { type: 'optimizeQuery' }>,
] {
	return [
		{
			type: 'prepareOptimizeQuery',
			boxId: 'optimize-prepare-exact',
			query: 'StormEvents | take 10',
			optimizeRequestId: 'optimize-prepare-request-exact',
			sectionInstanceId: 'optimize-prepare-section-exact',
			targetGeneration: 17,
		},
		{
			type: 'cancelOptimizeQuery',
			boxId: 'optimize-cancel-exact',
			optimizeRequestId: 'optimize-cancel-request-exact',
			sectionInstanceId: 'optimize-cancel-section-exact',
			targetGeneration: 19,
		},
		{
			type: 'optimizeQuery',
			boxId: 'optimize-run-exact',
			query: 'StormEvents | summarize count() by State',
			connectionId: 'kusto-optimize-connection-exact',
			database: 'OptimizeDatabaseExact',
			queryName: 'Optimize exact query',
			modelId: 'optimize-model-exact',
			promptText: 'Optimize this exact query',
			optimizeRequestId: 'optimize-run-request-exact',
			sectionInstanceId: 'optimize-run-section-exact',
			targetGeneration: 23,
		},
	];
}

function createHarness(): {
	handler: HostCopilotQueryWorkflowApplicationHandler;
	copilot: {
		startCopilotWriteQuery: ReturnType<typeof vi.fn>;
		cancelCopilotWriteQuery: ReturnType<typeof vi.fn>;
		prepareOptimizeQuery: ReturnType<typeof vi.fn>;
		cancelOptimizeQuery: ReturnType<typeof vi.fn>;
		optimizeQueryWithCopilot: ReturnType<typeof vi.fn>;
	};
	broker: {
		reservePreflight: ReturnType<typeof vi.fn>;
		clearPreflight: ReturnType<typeof vi.fn>;
		cancelExpected: ReturnType<typeof vi.fn>;
	};
	lifecycle: {
		assertOwnerToken: ReturnType<typeof vi.fn>;
		getOwnerToken: ReturnType<typeof vi.fn>;
	};
	postMessage: ReturnType<typeof vi.fn>;
	getSqlConnectionManager: ReturnType<typeof vi.fn>;
	getSqlSchemaService: ReturnType<typeof vi.fn>;
	getSqlClient: ReturnType<typeof vi.fn>;
	sqlConnectionManager: object;
	sqlSchemaService: object;
	sqlClient: object;
	preflight: Readonly<{
		boxId: string;
		generation: number;
		executionId: string;
		ownerToken: string;
	}>;
} {
	const copilot = {
		startCopilotWriteQuery: vi.fn(async () => undefined),
		cancelCopilotWriteQuery: vi.fn(),
		prepareOptimizeQuery: vi.fn(async () => undefined),
		cancelOptimizeQuery: vi.fn(),
		optimizeQueryWithCopilot: vi.fn(async () => undefined),
	};
	const preflight = Object.freeze({
		boxId: 'sql-start-exact',
		generation: 7,
		executionId: SQL_PREFLIGHT_EXECUTION_ID,
		ownerToken: 'sql-owner-token-exact',
	});
	const broker = {
		reservePreflight: vi.fn(() => preflight),
		clearPreflight: vi.fn(() => true),
		cancelExpected: vi.fn(() => false),
	};
	const lifecycle = {
		assertOwnerToken: vi.fn(async () => ({
			token: 'sql-owner-token-exact',
			owner: { connectionId: 'sql-connection-exact', database: 'SqlDatabaseExact' },
		})),
		getOwnerToken: vi.fn(() => 'sql-owner-token-exact'),
	};
	const postMessage = vi.fn((_message: unknown) => true);
	const sqlConnectionManager = { kind: 'sql-connection-manager-exact' };
	const sqlSchemaService = { kind: 'sql-schema-service-exact' };
	const sqlClient = { kind: 'sql-client-exact' };
	const getSqlConnectionManager = vi.fn(() => sqlConnectionManager);
	const getSqlSchemaService = vi.fn(() => sqlSchemaService);
	const getSqlClient = vi.fn(() => sqlClient);
	const options: CopilotQueryWorkflowApplicationHandlerOptions = {
		copilot: copilot as unknown as CopilotQueryWorkflowApplicationHandlerOptions['copilot'],
		sqlExecutionBroker: broker as unknown as CopilotQueryWorkflowApplicationHandlerOptions['sqlExecutionBroker'],
		sqlLifecycle: lifecycle as unknown as CopilotQueryWorkflowApplicationHandlerOptions['sqlLifecycle'],
		getSqlConnectionManager: getSqlConnectionManager as unknown as CopilotQueryWorkflowApplicationHandlerOptions['getSqlConnectionManager'],
		getSqlSchemaService: getSqlSchemaService as unknown as CopilotQueryWorkflowApplicationHandlerOptions['getSqlSchemaService'],
		getSqlClient: getSqlClient as unknown as CopilotQueryWorkflowApplicationHandlerOptions['getSqlClient'],
		postMessage,
	};

	return {
		handler: new HostCopilotQueryWorkflowApplicationHandler(options),
		copilot,
		broker,
		lifecycle,
		postMessage,
		getSqlConnectionManager,
		getSqlSchemaService,
		getSqlClient,
		sqlConnectionManager,
		sqlSchemaService,
		sqlClient,
		preflight,
	};
}

describe('HostCopilotQueryWorkflowApplicationHandler', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('declines unrelated traffic synchronously', () => {
		const { handler } = createHarness();

		expect(handler.handleMessage({ type: 'getConnections' })).toBeUndefined();
	});

	it('awaits exact Kusto start delegation and cancels only the exact Kusto request synchronously', async () => {
		const harness = createHarness();
		const startSettlement = deferred<void>();
		harness.copilot.startCopilotWriteQuery.mockImplementation(() => startSettlement.promise);
		const startMessage = createKustoStartMessage();
		const cancelMessage = createKustoCancelMessage();
		expect(harness.getSqlConnectionManager).not.toHaveBeenCalled();
		expect(harness.getSqlSchemaService).not.toHaveBeenCalled();
		expect(harness.getSqlClient).not.toHaveBeenCalled();

		const start = harness.handler.handleMessage(startMessage);
		expect(start).toBeInstanceOf(Promise);
		expect(harness.copilot.startCopilotWriteQuery).toHaveBeenCalledWith(
			startMessage,
			harness.sqlConnectionManager,
			harness.sqlSchemaService,
			harness.sqlClient,
		);
		expect(harness.getSqlConnectionManager).toHaveBeenCalledOnce();
		expect(harness.getSqlSchemaService).toHaveBeenCalledOnce();
		expect(harness.getSqlClient).toHaveBeenCalledOnce();

		const cancel = harness.handler.handleMessage(cancelMessage);
		expect(harness.copilot.cancelCopilotWriteQuery).toHaveBeenCalledWith(
			cancelMessage.boxId,
			undefined,
			{
				boxId: cancelMessage.boxId,
				copilotRequestId: cancelMessage.copilotRequestId,
				sectionInstanceId: cancelMessage.sectionInstanceId,
				targetGeneration: cancelMessage.targetGeneration,
			},
		);
		await expect(cancel).resolves.toBeUndefined();

		let settled = false;
		void start?.finally(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);
		startSettlement.resolve();
		await expect(start).resolves.toBeUndefined();
		expect(settled).toBe(true);
		expect(harness.broker.reservePreflight).not.toHaveBeenCalled();
	});

	it('reserves SQL preflight before owner assertion and dispatches only after exact clearance', async () => {
		const harness = createHarness();
		const ownerValidation = deferred<{
			token: string;
			owner: { connectionId: string; database: string };
		}>();
		const copilotSettlement = deferred<void>();
		const order: string[] = [];
		harness.broker.reservePreflight.mockImplementation(() => {
			order.push('reserve');
			return harness.preflight;
		});
		harness.lifecycle.assertOwnerToken.mockImplementation(() => {
			order.push('assert');
			return ownerValidation.promise;
		});
		harness.broker.clearPreflight.mockImplementation(() => {
			order.push('clear');
			return true;
		});
		harness.copilot.startCopilotWriteQuery.mockImplementation(() => {
			order.push('dispatch');
			return copilotSettlement.promise;
		});
		const message = createSqlStartMessage();

		const request = harness.handler.handleMessage(message);
		expect(order).toEqual(['reserve', 'assert']);
		expect(harness.broker.reservePreflight).toHaveBeenCalledWith(
			message.boxId,
			SQL_PREFLIGHT_EXECUTION_ID,
			message.sqlOwnerToken,
		);
		expect(harness.lifecycle.assertOwnerToken).toHaveBeenCalledWith(
			message.boxId,
			message.sqlOwnerToken,
		);
		expect(harness.copilot.startCopilotWriteQuery).not.toHaveBeenCalled();
		expect(harness.getSqlConnectionManager).not.toHaveBeenCalled();
		expect(harness.getSqlSchemaService).not.toHaveBeenCalled();
		expect(harness.getSqlClient).not.toHaveBeenCalled();

		ownerValidation.resolve({
			token: 'sql-owner-token-exact',
			owner: { connectionId: 'sql-connection-exact', database: 'SqlDatabaseExact' },
		});
		await Promise.resolve();
		expect(order).toEqual(['reserve', 'assert', 'clear', 'dispatch']);
		expect(harness.broker.clearPreflight).toHaveBeenCalledWith(harness.preflight);
		expect(harness.copilot.startCopilotWriteQuery).toHaveBeenCalledWith(
			message,
			harness.sqlConnectionManager,
			harness.sqlSchemaService,
			harness.sqlClient,
		);

		copilotSettlement.resolve();
		await expect(request).resolves.toBeUndefined();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('publishes the exact safe SQL owner-change terminal when preflight assertion fails', async () => {
		const harness = createHarness();
		harness.lifecycle.assertOwnerToken.mockRejectedValue(
			new Error('C:\\private\\sql-policy.lock failed'),
		);
		const message = createSqlStartMessage();

		await expect(harness.handler.handleMessage(message)).resolves.toBeUndefined();

		expect(harness.broker.clearPreflight).toHaveBeenCalledWith(harness.preflight);
		expect(harness.postMessage).toHaveBeenCalledOnce();
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'copilotWriteQueryDone',
			boxId: message.boxId,
			ok: false,
			message: 'SQL section owner changed. Retry the request.',
			ownerToken: message.sqlOwnerToken,
		});
		expect(JSON.stringify(harness.postMessage.mock.calls)).not.toContain('sql-policy.lock');
		expect(harness.copilot.startCopilotWriteQuery).not.toHaveBeenCalled();
	});

	it('lets exact cancellation win a pending successful SQL preflight', async () => {
		const harness = createHarness();
		const ownerValidation = deferred<{
			token: string;
			owner: { connectionId: string; database: string };
		}>();
		let canceled = false;
		harness.lifecycle.assertOwnerToken.mockReturnValue(ownerValidation.promise);
		harness.broker.cancelExpected.mockImplementation(() => {
			canceled = true;
			return true;
		});
		harness.broker.clearPreflight.mockImplementation(() => !canceled);
		const startMessage = createSqlStartMessage();
		const cancelMessage = {
			type: 'cancelCopilotWriteQuery',
			boxId: startMessage.boxId,
			flavor: 'sql',
		} satisfies IncomingWebviewMessage;

		const start = harness.handler.handleMessage(startMessage);
		await Promise.resolve();
		const cancel = harness.handler.handleMessage(cancelMessage);

		expect(harness.broker.cancelExpected).toHaveBeenCalledWith(
			startMessage.boxId,
			SQL_PREFLIGHT_EXECUTION_ID,
			false,
		);
		expect(harness.lifecycle.getOwnerToken).toHaveBeenCalledWith(startMessage.boxId);
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'copilotWriteQueryDone',
			boxId: startMessage.boxId,
			ok: false,
			message: 'Canceled.',
			ownerToken: 'sql-owner-token-exact',
		});
		expect(harness.copilot.cancelCopilotWriteQuery).toHaveBeenCalledWith(startMessage.boxId);
		await expect(cancel).resolves.toBeUndefined();

		ownerValidation.resolve({
			token: 'sql-owner-token-exact',
			owner: { connectionId: 'sql-connection-exact', database: 'SqlDatabaseExact' },
		});
		await expect(start).resolves.toBeUndefined();
		expect(harness.copilot.startCopilotWriteQuery).not.toHaveBeenCalled();
		expect(harness.getSqlConnectionManager).not.toHaveBeenCalled();
		expect(harness.getSqlSchemaService).not.toHaveBeenCalled();
		expect(harness.getSqlClient).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
			message: 'SQL section owner changed. Retry the request.',
		}));
	});

	it('suppresses the owner-change terminal when cancellation wins a rejecting SQL preflight', async () => {
		const harness = createHarness();
		const ownerValidation = deferred<never>();
		let canceled = false;
		harness.lifecycle.assertOwnerToken.mockReturnValue(ownerValidation.promise);
		harness.broker.cancelExpected.mockImplementation(() => {
			canceled = true;
			return true;
		});
		harness.broker.clearPreflight.mockImplementation(() => !canceled);
		const startMessage = createSqlStartMessage();
		const cancelMessage = {
			type: 'cancelCopilotWriteQuery',
			boxId: startMessage.boxId,
			flavor: 'sql',
		} satisfies IncomingWebviewMessage;

		const start = harness.handler.handleMessage(startMessage);
		await Promise.resolve();
		await harness.handler.handleMessage(cancelMessage);
		ownerValidation.reject(new Error('owner validation rejected after cancellation'));
		await expect(start).resolves.toBeUndefined();

		expect(harness.postMessage).toHaveBeenCalledTimes(1);
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'copilotWriteQueryDone',
			message: 'Canceled.',
		}));
		expect(harness.copilot.startCopilotWriteQuery).not.toHaveBeenCalled();
		expect(harness.getSqlConnectionManager).not.toHaveBeenCalled();
		expect(harness.getSqlSchemaService).not.toHaveBeenCalled();
		expect(harness.getSqlClient).not.toHaveBeenCalled();
	});

	it('awaits Optimize prepare and run while invoking exact cancellation synchronously', async () => {
		const harness = createHarness();
		const prepareSettlement = deferred<void>();
		const runSettlement = deferred<void>();
		harness.copilot.prepareOptimizeQuery.mockReturnValue(prepareSettlement.promise);
		harness.copilot.optimizeQueryWithCopilot.mockReturnValue(runSettlement.promise);
		const [prepareMessage, cancelMessage, runMessage] = createOptimizeMessages();

		const prepare = harness.handler.handleMessage(prepareMessage);
		const run = harness.handler.handleMessage(runMessage);
		const cancel = harness.handler.handleMessage(cancelMessage);

		expect(harness.copilot.prepareOptimizeQuery).toHaveBeenCalledWith(prepareMessage);
		expect(harness.copilot.optimizeQueryWithCopilot).toHaveBeenCalledWith(runMessage);
		expect(harness.copilot.cancelOptimizeQuery).toHaveBeenCalledWith(cancelMessage);
		await expect(cancel).resolves.toBeUndefined();

		let prepareSettled = false;
		let runSettled = false;
		void prepare?.finally(() => { prepareSettled = true; });
		void run?.finally(() => { runSettled = true; });
		await Promise.resolve();
		expect([prepareSettled, runSettled]).toEqual([false, false]);

		prepareSettlement.resolve();
		await expect(prepare).resolves.toBeUndefined();
		expect(prepareSettled).toBe(true);
		expect(runSettled).toBe(false);
		runSettlement.resolve();
		await expect(run).resolves.toBeUndefined();
		expect(runSettled).toBe(true);
	});

	it('preserves accepted settlement and exact rejection across disposal', async () => {
		const resolveHarness = createHarness();
		const startSettlement = deferred<void>();
		resolveHarness.copilot.startCopilotWriteQuery.mockReturnValue(startSettlement.promise);
		const start = resolveHarness.handler.handleMessage(createKustoStartMessage());
		resolveHarness.handler.dispose();
		startSettlement.resolve();
		await expect(start).resolves.toBeUndefined();

		const rejectHarness = createHarness();
		const failure = new Error('accepted Optimize delegation failed exactly');
		const runSettlement = deferred<void>();
		rejectHarness.copilot.optimizeQueryWithCopilot.mockReturnValue(runSettlement.promise);
		const run = rejectHarness.handler.handleMessage(createOptimizeMessages()[2]);
		rejectHarness.handler.dispose();
		runSettlement.reject(failure);
		await expect(run).rejects.toBe(failure);
	});

	it('idempotently disposes, claims later workflow traffic, and suppresses every effect', async () => {
		const harness = createHarness();
		const [prepareMessage, cancelOptimizeMessage, runMessage] = createOptimizeMessages();
		const messages: IncomingWebviewMessage[] = [
			createSqlStartMessage(),
			{ type: 'cancelCopilotWriteQuery', boxId: 'sql-start-exact', flavor: 'sql' },
			prepareMessage,
			cancelOptimizeMessage,
			runMessage,
		];

		harness.handler.dispose();
		harness.handler.dispose();
		await expect(Promise.all(messages.map(message => harness.handler.handleMessage(message))))
			.resolves.toEqual([undefined, undefined, undefined, undefined, undefined]);

		expect(harness.copilot.startCopilotWriteQuery).not.toHaveBeenCalled();
		expect(harness.copilot.cancelCopilotWriteQuery).not.toHaveBeenCalled();
		expect(harness.copilot.prepareOptimizeQuery).not.toHaveBeenCalled();
		expect(harness.copilot.cancelOptimizeQuery).not.toHaveBeenCalled();
		expect(harness.copilot.optimizeQueryWithCopilot).not.toHaveBeenCalled();
		expect(harness.broker.reservePreflight).not.toHaveBeenCalled();
		expect(harness.broker.clearPreflight).not.toHaveBeenCalled();
		expect(harness.broker.cancelExpected).not.toHaveBeenCalled();
		expect(harness.lifecycle.assertOwnerToken).not.toHaveBeenCalled();
		expect(harness.lifecycle.getOwnerToken).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
		expect(harness.getSqlConnectionManager).not.toHaveBeenCalled();
		expect(harness.getSqlSchemaService).not.toHaveBeenCalled();
		expect(harness.getSqlClient).not.toHaveBeenCalled();
		expect(harness.handler.handleMessage({ type: 'getConnections' })).toBeUndefined();
	});
});
