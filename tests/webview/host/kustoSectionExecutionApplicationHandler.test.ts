import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	HostKustoSectionExecutionApplicationHandler,
	type KustoSectionExecutionApplicationHandlerOptions,
} from '../../../src/host/kustoSectionExecutionApplicationHandler';
import { KustoExecutionCoordinator } from '../../../src/host/kustoExecutionCoordinator';
import { QueryRunCoordinator } from '../../../src/host/queryRunCoordinator';
import type { KustoQueryClient, QueryResult } from '../../../src/host/kustoClient';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';
import type { KustoConnection } from '../../../src/host/connectionManager';
import { getKustoConnectionIdentityKey } from '../../../src/shared/kustoAuth';

const TEST_CONNECTION: KustoConnection = {
	id: 'connection-1',
	name: 'Test cluster',
	clusterUrl: 'https://cluster.kusto.windows.net',
};

const DISPATCH = Object.freeze({
	dispatchAttempt: 1,
	connectionRevision: 7,
	leaveNoTraceRevision: 3,
	connectionIdentityKey: getKustoConnectionIdentityKey(
		TEST_CONNECTION.clusterUrl,
		TEST_CONNECTION.authorityId,
	),
	clusterEndpoint: TEST_CONNECTION.clusterUrl,
	accountPartition: 'partition-current',
	authSessionGeneration: 11,
	clientActivityId: 'KW.execute_query;handler-test',
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

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function queryResult(label: string): QueryResult {
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

function executeMessage(executionId: string, query = 'print x=1'): Extract<IncomingWebviewMessage, {
	type: 'executeQuery';
}> {
	return {
		type: 'executeQuery',
		query,
		connectionId: TEST_CONNECTION.id,
		database: 'Samples',
		boxId: 'query-1',
		executionId,
		sectionInstanceId: 'instance-1',
		targetGeneration: 1,
		producer: 'manual',
		queryMode: 'plain',
		cacheEnabled: false,
		cacheValue: 1,
		cacheUnit: 'h',
	};
}

function createHarness() {
	const terminalMessages: unknown[] = [];
	const queryRuns = new QueryRunCoordinator();
	const coordinator = new KustoExecutionCoordinator({
		queryRuns,
		postMessage: message => {
			terminalMessages.push(message);
			return true;
		},
	});
	const transport = vi.fn<(message: unknown) => boolean>(() => true);
	const executeQueryCancelable = vi.fn<
		KustoSectionExecutionApplicationHandlerOptions['kustoClient']['executeQueryCancelable']
	>();
	const saveLastSelection = vi.fn(async () => undefined);
	const findConnection = vi.fn(() => TEST_CONNECTION);
	const refreshConnectionsData = vi.fn(async () => undefined);
	const cancelKustoCopilotSection = vi.fn();
	const showErrorMessage = vi.fn();
	const logQueryExecutionError = vi.fn();
	let hostDisposed = false;
	let handler!: HostKustoSectionExecutionApplicationHandler;
	const connectionManager = {
		getConnections: vi.fn(() => [TEST_CONNECTION]),
		getConnectionIncarnation: vi.fn(() => DISPATCH.connectionRevision),
		admitLeaveNoTraceRevision: vi.fn(async (
			_clusterUrl: string,
			_expectedRevision: number,
			admit: () => unknown,
		) => ({ admitted: true, value: await Promise.resolve(admit()) })),
	} as unknown as KustoSectionExecutionApplicationHandlerOptions['connectionManager'];
	const kustoClient = {
		executeQueryCancelable,
		waitForProviderAccountRefresh: vi.fn(async () => undefined),
		getConnectionSessionGeneration: vi.fn(() => DISPATCH.authSessionGeneration),
		getAccountPartition: vi.fn(() => DISPATCH.accountPartition),
	} as unknown as KustoSectionExecutionApplicationHandlerOptions['kustoClient'];

	handler = new HostKustoSectionExecutionApplicationHandler({
		coordinator,
		kustoClient,
		connection: { saveLastSelection, findConnection },
		connectionManager,
		postMessage: message => transport(message),
		refreshConnectionsData,
		cancelKustoCopilotSection,
		getErrorMessage: error => error instanceof Error ? error.message : String(error),
		formatQueryExecutionErrorForUser: error => `formatted:${error instanceof Error ? error.message : String(error)}`,
		logQueryExecutionError,
		appendQueryMode: query => query,
		isControlCommand: () => false,
		normalizeControlCommandForExecution: query => query,
		buildCacheDirective: () => '',
		showErrorMessage,
		isDisposed: () => hostDisposed,
		createPublicationId: () => 'publication-exact',
		now: () => Date.now(),
	});

	const openAndTarget = async () => {
		await handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		});
		await handler.handleMessage({
			type: 'kustoSectionTarget', boxId: 'query-1', sectionInstanceId: 'instance-1',
			targetGeneration: 1, connectionId: TEST_CONNECTION.id, database: 'Samples',
			connectionRevision: DISPATCH.connectionRevision,
			connectionIdentityKey: DISPATCH.connectionIdentityKey,
		});
	};

	return {
		handler,
		coordinator,
		queryRuns,
		transport,
		terminalMessages,
		executeQueryCancelable,
		saveLastSelection,
		findConnection,
		refreshConnectionsData,
		cancelKustoCopilotSection,
		showErrorMessage,
		logQueryExecutionError,
		openAndTarget,
		setHostDisposed(value: boolean) { hostDisposed = value; },
	};
}

function dispatchingExecution(
	promise: Promise<QueryResult>,
	cancel: () => void = vi.fn(),
) {
	return (
		_connection: KustoConnection,
		_database: string,
		_query: string,
		_key: string,
		options?: Parameters<KustoQueryClient['executeQueryCancelable']>[4],
	) => {
		options?.onDispatch?.(DISPATCH);
		return { promise, cancel };
	};
}

describe('HostKustoSectionExecutionApplicationHandler', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('owns exact section open, target, and close routing', async () => {
		const harness = createHarness();
		await harness.openAndTarget();

		expect(harness.coordinator.getTarget('query-1')).toEqual({
			boxId: 'query-1',
			sectionInstanceId: 'instance-1',
			targetGeneration: 1,
			connectionId: TEST_CONNECTION.id,
			database: 'Samples',
			connectionRevision: DISPATCH.connectionRevision,
			connectionIdentityKey: DISPATCH.connectionIdentityKey,
		});
		expect(harness.handler.getKustoSectionExecutionTarget('query-1')).toEqual({
			engine: 'kusto', boxId: 'query-1', sectionInstanceId: 'instance-1',
			targetGeneration: 1, connectionId: TEST_CONNECTION.id, database: 'Samples',
		});

		await harness.handler.handleMessage({
			type: 'kustoSectionClose', boxId: 'query-1', sectionInstanceId: 'instance-1',
		});

		expect(harness.cancelKustoCopilotSection).toHaveBeenCalledWith('query-1', 'instance-1');
		expect(harness.coordinator.getTarget('query-1')).toBeUndefined();
	});

	it('requires the exact execution-start acknowledgement before dispatch', async () => {
		const harness = createHarness();
		await harness.openAndTarget();
		const result = queryResult('copilot');
		harness.executeQueryCancelable.mockImplementationOnce(dispatchingExecution(Promise.resolve(result)));

		const running = harness.handler.executeKustoSectionQuery({
			target: harness.handler.getKustoSectionExecutionTarget('query-1')!,
			executionId: 'copilot-execution',
			producer: 'copilot',
			query: 'print x=1',
		});
		await vi.waitFor(() => expect(harness.transport).toHaveBeenCalledOnce());
		const started = harness.transport.mock.calls[0][0] as Extract<IncomingWebviewMessage, {
			type: 'kustoExecutionStartedAck';
		}> & { type: 'kustoExecutionStarted' };

		await harness.handler.handleMessage({
			type: 'kustoExecutionStartedAck', boxId: started.boxId,
			executionId: 'wrong-execution', sectionInstanceId: started.sectionInstanceId,
			targetGeneration: started.targetGeneration, accepted: true,
		});
		expect(harness.executeQueryCancelable).not.toHaveBeenCalled();

		await harness.handler.handleMessage({
			type: 'kustoExecutionStartedAck', boxId: started.boxId,
			executionId: started.executionId, sectionInstanceId: started.sectionInstanceId,
			targetGeneration: started.targetGeneration, accepted: true,
		});

		await expect(running).resolves.toEqual({
			status: 'success', executionId: 'copilot-execution', result,
		});
		expect(harness.executeQueryCancelable).toHaveBeenCalledOnce();
	});

	it('requires exact staged and applied publication acknowledgements', async () => {
		const harness = createHarness();
		const payload = { type: 'queryResult', marker: 'exact-payload' };
		let settled = false;
		const publishing = harness.handler.postKustoPublication(payload)
			.then(value => { settled = true; return value; });
		await vi.waitFor(() => expect(harness.transport).toHaveBeenCalledOnce());
		const stage = harness.transport.mock.calls[0][0] as {
			type: string; publicationId: string; payload: unknown;
		};
		expect(stage.payload).toBe(payload);

		await harness.handler.handleMessage({
			type: 'kustoPublicationAck', publicationId: `${stage.publicationId}-wrong`,
			phase: 'staged', accepted: true,
		});
		expect(settled).toBe(false);
		expect(harness.transport).toHaveBeenCalledOnce();

		await harness.handler.handleMessage({
			type: 'kustoPublicationAck', publicationId: stage.publicationId,
			phase: 'staged', accepted: true,
		});
		await vi.waitFor(() => expect(harness.transport).toHaveBeenCalledTimes(2));
		expect(harness.transport).toHaveBeenLastCalledWith({
			type: 'kustoPublicationCommit', publicationId: stage.publicationId,
		});
		expect(settled).toBe(false);

		await harness.handler.handleMessage({
			type: 'kustoPublicationAck', publicationId: stage.publicationId,
			phase: 'applied', accepted: true,
		});
		await expect(publishing).resolves.toBe(true);

		await harness.handler.handleMessage({
			type: 'kustoPublicationAck', publicationId: stage.publicationId,
			phase: 'applied', accepted: false,
		});
		expect(harness.transport).toHaveBeenCalledTimes(2);
	});

	it('publishes exact manual success and failure terminals', async () => {
		const harness = createHarness();
		await harness.openAndTarget();
		const success = queryResult('success');
		harness.executeQueryCancelable
			.mockImplementationOnce(dispatchingExecution(Promise.resolve(success)))
			.mockImplementationOnce(dispatchingExecution(Promise.reject(new Error('semantic failure'))));

		await harness.handler.handleMessage(executeMessage('execution-success'));
		await harness.handler.handleMessage(executeMessage('execution-failure', 'print missing_symbol'));
		await vi.waitFor(() => expect(harness.terminalMessages).toHaveLength(2));

		expect(harness.terminalMessages).toEqual([
			expect.objectContaining({
				type: 'queryResult', boxId: 'query-1', executionId: 'execution-success',
				sectionInstanceId: 'instance-1', targetGeneration: 1, result: success,
			}),
			expect.objectContaining({
				type: 'queryError', boxId: 'query-1', executionId: 'execution-failure',
				sectionInstanceId: 'instance-1', targetGeneration: 1,
				error: 'formatted:semantic failure',
			}),
		]);
		expect(harness.logQueryExecutionError).toHaveBeenCalledOnce();
		expect(harness.showErrorMessage).toHaveBeenCalledWith('formatted:semantic failure');
	});

	it('cancels the exact manual execution and suppresses its late result', async () => {
		const harness = createHarness();
		await harness.openAndTarget();
		const pending = deferred<QueryResult>();
		const cancel = vi.fn();
		harness.executeQueryCancelable.mockImplementationOnce(dispatchingExecution(pending.promise, cancel));

		const running = harness.handler.handleMessage(executeMessage('execution-cancel'))!;
		await vi.waitFor(() => expect(harness.executeQueryCancelable).toHaveBeenCalledOnce());
		await harness.handler.handleMessage({
			type: 'cancelQuery', boxId: 'query-1', executionId: 'execution-cancel',
			sectionInstanceId: 'instance-1', targetGeneration: 1,
		});
		await vi.waitFor(() => expect(harness.terminalMessages).toHaveLength(1));

		expect(cancel).toHaveBeenCalledOnce();
		expect(harness.terminalMessages[0]).toEqual(expect.objectContaining({
			type: 'queryCancelled', executionId: 'execution-cancel', reason: 'cancelled',
		}));

		pending.resolve(queryResult('late'));
		await running;
		expect(harness.terminalMessages).toHaveLength(1);
	});

	it('replaces a manual execution and publishes only the newer result', async () => {
		const harness = createHarness();
		await harness.openAndTarget();
		const first = deferred<QueryResult>();
		const firstCancel = vi.fn();
		const second = queryResult('second');
		harness.executeQueryCancelable
			.mockImplementationOnce(dispatchingExecution(first.promise, firstCancel))
			.mockImplementationOnce(dispatchingExecution(Promise.resolve(second)));

		const firstRun = harness.handler.handleMessage(executeMessage('execution-first'))!;
		await vi.waitFor(() => expect(harness.executeQueryCancelable).toHaveBeenCalledOnce());
		await harness.handler.handleMessage(executeMessage('execution-second'));
		await vi.waitFor(() => expect(harness.terminalMessages).toHaveLength(2));

		expect(firstCancel).toHaveBeenCalledOnce();
		expect(harness.terminalMessages).toEqual([
			expect.objectContaining({
				type: 'queryCancelled', executionId: 'execution-first', reason: 'superseded',
			}),
			expect.objectContaining({
				type: 'queryResult', executionId: 'execution-second', result: second,
			}),
		]);

		first.resolve(queryResult('first-late'));
		await firstRun;
		expect(harness.terminalMessages).toHaveLength(2);
	});

	it('suppresses late acknowledgements after both exact deadlines', async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		await harness.openAndTarget();
		const target = harness.handler.getKustoSectionExecutionTarget('query-1')!;
		const execution = harness.handler.executeKustoSectionQuery({
			target, executionId: 'execution-timeout', producer: 'copilot', query: 'print x=1',
		});
		await flushPromises();
		const started = harness.transport.mock.calls[0][0] as {
			boxId: string; executionId: string; sectionInstanceId: string; targetGeneration: number;
		};

		await vi.advanceTimersByTimeAsync(5_000);
		await expect(execution).resolves.toEqual({
			status: 'superseded', executionId: 'execution-timeout',
		});
		await harness.handler.handleMessage({
			type: 'kustoExecutionStartedAck', ...started, accepted: true,
		});
		expect(harness.executeQueryCancelable).not.toHaveBeenCalled();

		harness.transport.mockClear();
		const publication = harness.handler.postKustoPublication({ type: 'late-publication' });
		await flushPromises();
		const stage = harness.transport.mock.calls[0][0] as { publicationId: string };
		await harness.handler.handleMessage({
			type: 'kustoPublicationAck', publicationId: stage.publicationId,
			phase: 'staged', accepted: true,
		});
		await flushPromises();
		await vi.advanceTimersByTimeAsync(6_000);
		await expect(publication).resolves.toBe(false);
		await harness.handler.handleMessage({
			type: 'kustoPublicationAck', publicationId: stage.publicationId,
			phase: 'applied', accepted: true,
		});
		expect(harness.transport).toHaveBeenCalledTimes(3);
	});

	it('settles accepted work across disposal and suppresses every later request idempotently', async () => {
		const harness = createHarness();
		await harness.openAndTarget();
		const pending = deferred<QueryResult>();
		harness.executeQueryCancelable.mockImplementationOnce(dispatchingExecution(pending.promise));
		const running = harness.handler.handleMessage(executeMessage('execution-disposal'))!;
		await vi.waitFor(() => expect(harness.executeQueryCancelable).toHaveBeenCalledOnce());
		const publication = harness.handler.postKustoPublication({ type: 'pending-publication' });
		await vi.waitFor(() => expect(harness.transport).toHaveBeenCalledOnce());

		harness.handler.dispose();
		harness.handler.dispose();
		await expect(publication).resolves.toBe(false);
		await harness.handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'later', sectionInstanceId: 'later-instance',
		});
		await harness.handler.handleMessage(executeMessage('execution-later'));
		await harness.handler.handleMessage({
			type: 'cancelQuery', boxId: 'query-1', executionId: 'execution-disposal',
			sectionInstanceId: 'instance-1', targetGeneration: 1,
		});
		expect(harness.executeQueryCancelable).toHaveBeenCalledOnce();
		expect(harness.coordinator.getTarget('later')).toBeUndefined();

		pending.resolve(queryResult('settled-after-disposal'));
		await running;
		await vi.waitFor(() => expect(harness.terminalMessages).toContainEqual(expect.objectContaining({
			type: 'queryResult', executionId: 'execution-disposal',
		})));
	});
});