import { describe, it, expect, vi } from 'vitest';
import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import type { KustoConnection } from '../../../src/host/connectionManager';
import type { ExecuteQueryMessage } from '../../../src/host/queryEditorTypes';

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
	provider.runningQueriesByBoxId = new Map();
	provider.queryRunSeq = 0;
	provider.postMessage = vi.fn();
	provider.connection = {
		saveLastSelection: vi.fn(async () => undefined),
		findConnection: vi.fn(() => TEST_CONNECTION),
	};
	provider.kustoClient = {
		executeQueryCancelable: vi.fn(),
	};
	provider.appendQueryMode = vi.fn((query: string) => query);
	provider.isControlCommand = vi.fn(() => false);
	provider.buildCacheDirective = vi.fn(() => '');
	provider.logQueryExecutionError = vi.fn();
	provider.formatQueryExecutionErrorForUser = vi.fn((error: unknown) => error instanceof Error ? error.message : String(error));
	provider.output = { appendLine: vi.fn() };
	return provider;
}

describe('QueryEditorProvider cancellation orchestration', () => {
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
		expect(provider.runningQueriesByBoxId.has('query_1')).toBe(false);
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
			.mockReturnValueOnce({ promise: first.promise, cancel: firstCancel, clientActivityId: 'KW.execute_query;first' })
			.mockReturnValueOnce({ promise: Promise.resolve(secondResult), cancel: secondCancel, clientActivityId: 'KW.execute_query;second' });

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
		expect(provider.runningQueriesByBoxId.has('query_a')).toBe(false);
		expect(provider.runningQueriesByBoxId.has('query_b')).toBe(true);
		expect(provider.postMessage).toHaveBeenCalledWith({ type: 'queryCancelled', boxId: 'query_a' });
	});

	it('unregisters only the matching running query handle', () => {
		const provider = createProviderHarness();
		const oldCancel = vi.fn();
		const newCancel = vi.fn();

		provider.registerRunningQuery('query_1', oldCancel, 1, 'KW.execute_query;old');
		provider.registerRunningQuery('query_1', newCancel, 2, 'KW.execute_query;new');
		provider.unregisterRunningQuery('query_1', oldCancel, 1);

		expect(provider.runningQueriesByBoxId.has('query_1')).toBe(true);
		provider.unregisterRunningQuery('query_1', newCancel, 2);
		expect(provider.runningQueriesByBoxId.has('query_1')).toBe(false);
	});
});