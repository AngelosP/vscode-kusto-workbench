import { describe, expect, it, vi } from 'vitest';

import {
	HostCopilotWriteQueryPreparationApplicationHandler,
	type CopilotWriteQueryPreparationApplicationHandlerOptions,
} from '../../../src/host/copilotWriteQueryPreparationApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

type PreparationMessage = Extract<IncomingWebviewMessage, {
	type: 'prepareCopilotWriteQuery';
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

function preparationMessage(
	boxId = 'prepare-query-1',
	flavor: 'kusto' | 'sql' = 'kusto',
): PreparationMessage {
	return { type: 'prepareCopilotWriteQuery', boxId, flavor };
}

function createHandler(
	overrides: Partial<CopilotWriteQueryPreparationApplicationHandlerOptions> = {},
) {
	const prepareCopilotWriteQuery = vi.fn(async () => undefined);
	const handler = new HostCopilotWriteQueryPreparationApplicationHandler({
		prepareCopilotWriteQuery,
		...overrides,
	});
	return { handler, prepareCopilotWriteQuery };
}

describe('HostCopilotWriteQueryPreparationApplicationHandler', () => {
	it('declines unrelated Kusto and SQL messages synchronously', () => {
		const { handler, prepareCopilotWriteQuery } = createHandler();

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(prepareCopilotWriteQuery).not.toHaveBeenCalled();
	});

	it('delegates reference-identical Kusto and SQL messages and awaits both settlements', async () => {
		const kustoSettlement = deferred<void>();
		const sqlSettlement = deferred<void>();
		const prepareCopilotWriteQuery = vi.fn((message: PreparationMessage) =>
			message.flavor === 'sql' ? sqlSettlement.promise : kustoSettlement.promise);
		const { handler } = createHandler({ prepareCopilotWriteQuery });
		const kustoMessage = preparationMessage('  prepare-query-exact  ', 'kusto');
		const sqlMessage = preparationMessage('  prepare-sql-exact  ', 'sql');
		let kustoSettled = false;
		let sqlSettled = false;

		const kustoRequest = handler.handleMessage(kustoMessage)!;
		const sqlRequest = handler.handleMessage(sqlMessage)!;
		void kustoRequest.finally(() => { kustoSettled = true; });
		void sqlRequest.finally(() => { sqlSettled = true; });
		await Promise.resolve();

		expect(prepareCopilotWriteQuery).toHaveBeenCalledTimes(2);
		expect(prepareCopilotWriteQuery.mock.calls[0][0]).toBe(kustoMessage);
		expect(prepareCopilotWriteQuery.mock.calls[1][0]).toBe(sqlMessage);
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
		const asynchronousFailure = new Error('Copilot preparation failed asynchronously');
		const synchronousFailure = new Error('Copilot preparation failed synchronously');
		const asynchronous = createHandler({
			prepareCopilotWriteQuery: vi.fn(async () => { throw asynchronousFailure; }),
		});
		const synchronous = createHandler({
			prepareCopilotWriteQuery: vi.fn(() => { throw synchronousFailure; }),
		});

		await expect(asynchronous.handler.handleMessage(preparationMessage('async')))
			.rejects.toBe(asynchronousFailure);
		await expect(synchronous.handler.handleMessage(preparationMessage('sync')))
			.rejects.toBe(synchronousFailure);
	});

	it('allows accepted settlement to complete across disposal', async () => {
		const settlement = deferred<void>();
		const prepareCopilotWriteQuery = vi.fn(() => settlement.promise);
		const { handler } = createHandler({ prepareCopilotWriteQuery });
		const message = preparationMessage();
		const request = handler.handleMessage(message)!;

		handler.dispose();
		expect(prepareCopilotWriteQuery).toHaveBeenCalledWith(message);
		settlement.resolve();

		await expect(request).resolves.toBeUndefined();
	});

	it('preserves an accepted rejection across disposal', async () => {
		const settlement = deferred<void>();
		const failure = new Error('accepted Copilot preparation failed');
		const prepareCopilotWriteQuery = vi.fn(() => settlement.promise);
		const { handler } = createHandler({ prepareCopilotWriteQuery });
		const request = handler.handleMessage(preparationMessage())!;

		handler.dispose();
		settlement.reject(failure);

		await expect(request).rejects.toBe(failure);
	});

	it('claims but suppresses later requests after idempotent disposal', async () => {
		const { handler, prepareCopilotWriteQuery } = createHandler();

		handler.dispose();
		handler.dispose();
		const request = handler.handleMessage(preparationMessage());

		expect(request).toBeInstanceOf(Promise);
		await expect(request).resolves.toBeUndefined();
		expect(prepareCopilotWriteQuery).not.toHaveBeenCalled();
	});
});