import { describe, expect, it, vi } from 'vitest';

import {
	HostCopilotHistoryRemovalApplicationHandler,
	type CopilotHistoryRemovalApplicationHandlerOptions,
} from '../../../src/host/copilotHistoryRemovalApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

type HistoryRemovalMessage = Extract<IncomingWebviewMessage, {
	type: 'removeFromCopilotHistory';
}>;

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function removalMessage(
	boxId = 'query-history-1',
	entryId = 'history-entry-1',
): HistoryRemovalMessage {
	return { type: 'removeFromCopilotHistory', boxId, entryId };
}

function createHandler(
	overrides: Partial<CopilotHistoryRemovalApplicationHandlerOptions> = {},
) {
	const removeFromCopilotHistory = vi.fn(async () => undefined);
	const handler = new HostCopilotHistoryRemovalApplicationHandler({
		removeFromCopilotHistory,
		...overrides,
	});
	return { handler, removeFromCopilotHistory };
}

describe('HostCopilotHistoryRemovalApplicationHandler', () => {
	it('declines unrelated Kusto and SQL messages synchronously', () => {
		const { handler, removeFromCopilotHistory } = createHandler();

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(removeFromCopilotHistory).not.toHaveBeenCalled();
	});

	it('delegates exact Kusto and SQL box-entry scopes and awaits both settlements', async () => {
		const kustoSettlement = deferred<void>();
		const sqlSettlement = deferred<void>();
		const removeFromCopilotHistory = vi.fn((boxId: string) =>
			boxId.includes('query') ? kustoSettlement.promise : sqlSettlement.promise);
		const { handler } = createHandler({ removeFromCopilotHistory });
		const kusto = removalMessage('  query-history-exact  ', '  query-entry-exact  ');
		const sql = removalMessage('  sql-history-exact  ', '  sql-entry-exact  ');
		let kustoSettled = false;
		let sqlSettled = false;

		const kustoRequest = handler.handleMessage(kusto)!;
		const sqlRequest = handler.handleMessage(sql)!;
		void kustoRequest.finally(() => { kustoSettled = true; });
		void sqlRequest.finally(() => { sqlSettled = true; });
		await Promise.resolve();

		expect(removeFromCopilotHistory).toHaveBeenCalledTimes(2);
		expect(removeFromCopilotHistory.mock.calls[0]).toEqual([kusto.boxId, kusto.entryId]);
		expect(removeFromCopilotHistory.mock.calls[1]).toEqual([sql.boxId, sql.entryId]);
		expect(kustoSettled).toBe(false);
		expect(sqlSettled).toBe(false);

		kustoSettlement.resolve();
		await expect(kustoRequest).resolves.toBeUndefined();
		expect(kustoSettled).toBe(true);
		expect(sqlSettled).toBe(false);

		sqlSettlement.resolve();
		await expect(sqlRequest).resolves.toBeUndefined();
		expect(sqlSettled).toBe(true);
	});

	it('propagates exact asynchronous and synchronous rejections', async () => {
		const asynchronousFailure = new Error('Copilot history removal failed asynchronously');
		const synchronousFailure = new Error('Copilot history removal failed synchronously');
		const asynchronous = createHandler({
			removeFromCopilotHistory: vi.fn(async () => { throw asynchronousFailure; }),
		});
		const synchronous = createHandler({
			removeFromCopilotHistory: vi.fn(() => { throw synchronousFailure; }),
		});

		await expect(asynchronous.handler.handleMessage(removalMessage('async-box', 'async-entry')))
			.rejects.toBe(asynchronousFailure);
		await expect(synchronous.handler.handleMessage(removalMessage('sync-box', 'sync-entry')))
			.rejects.toBe(synchronousFailure);
	});

	it('allows accepted settlements to complete across disposal', async () => {
		const settlement = deferred<void>();
		const removeFromCopilotHistory = vi.fn(() => settlement.promise);
		const { handler } = createHandler({ removeFromCopilotHistory });
		const message = removalMessage();
		const request = handler.handleMessage(message)!;

		handler.dispose();
		expect(removeFromCopilotHistory).toHaveBeenCalledWith(message.boxId, message.entryId);
		settlement.resolve();

		await expect(request).resolves.toBeUndefined();
	});

	it('preserves an accepted rejection across disposal', async () => {
		const settlement = deferred<void>();
		const failure = new Error('accepted Copilot history removal failed');
		const { handler } = createHandler({
			removeFromCopilotHistory: vi.fn(() => settlement.promise),
		});
		const request = handler.handleMessage(removalMessage())!;

		handler.dispose();
		settlement.reject(failure);

		await expect(request).rejects.toBe(failure);
	});

	it('claims but suppresses later requests after idempotent disposal', async () => {
		const { handler, removeFromCopilotHistory } = createHandler();

		handler.dispose();
		handler.dispose();
		const request = handler.handleMessage(removalMessage());

		expect(request).toBeInstanceOf(Promise);
		await expect(request).resolves.toBeUndefined();
		expect(removeFromCopilotHistory).not.toHaveBeenCalled();
	});
});
