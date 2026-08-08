import { describe, expect, it, vi } from 'vitest';

import {
	HostCopilotConversationClearApplicationHandler,
	type CopilotConversationClearApplicationHandlerOptions,
} from '../../../src/host/copilotConversationClearApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

type ClearMessage = Extract<IncomingWebviewMessage, {
	type: 'clearCopilotConversation';
}>;

type KustoClearMessage = Extract<ClearMessage, { flavor: 'kusto' }>;

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function kustoMessage(overrides: Partial<KustoClearMessage> = {}): KustoClearMessage {
	return {
		type: 'clearCopilotConversation',
		flavor: 'kusto',
		boxId: 'query-clear-1',
		sectionInstanceId: 'query-clear-instance-1',
		targetGeneration: 4,
		copilotRequestId: 'copilot-clear-request-1',
		...overrides,
	};
}

function createHandler(
	overrides: Partial<CopilotConversationClearApplicationHandlerOptions> = {},
) {
	const clearCopilotConversation = vi.fn(async () => undefined);
	const clearKustoCopilotConversation = vi.fn(async () => true);
	const handler = new HostCopilotConversationClearApplicationHandler({
		clearCopilotConversation,
		clearKustoCopilotConversation,
		...overrides,
	});
	return { handler, clearCopilotConversation, clearKustoCopilotConversation };
}

describe('HostCopilotConversationClearApplicationHandler', () => {
	it('declines unrelated Kusto and SQL messages synchronously', () => {
		const { handler, clearCopilotConversation, clearKustoCopilotConversation } = createHandler();

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(clearCopilotConversation).not.toHaveBeenCalled();
		expect(clearKustoCopilotConversation).not.toHaveBeenCalled();
	});

	it('delegates exact Kusto identity and SQL box scope and awaits both settlements', async () => {
		const kustoSettlement = deferred<boolean>();
		const sqlSettlement = deferred<void>();
		const clearKustoCopilotConversation = vi.fn((_message: KustoClearMessage) => kustoSettlement.promise);
		const clearCopilotConversation = vi.fn((_boxId: string) => sqlSettlement.promise);
		const { handler } = createHandler({
			clearCopilotConversation,
			clearKustoCopilotConversation,
		});
		const kusto = kustoMessage({ boxId: '  query-clear-exact  ' });
		const sql = {
			type: 'clearCopilotConversation',
			boxId: '  sql-clear-exact  ',
			flavor: 'sql',
		} satisfies ClearMessage;
		let kustoSettled = false;
		let sqlSettled = false;

		const kustoRequest = handler.handleMessage(kusto)!;
		const sqlRequest = handler.handleMessage(sql)!;
		void kustoRequest.finally(() => { kustoSettled = true; });
		void sqlRequest.finally(() => { sqlSettled = true; });
		await Promise.resolve();

		expect(clearKustoCopilotConversation).toHaveBeenCalledOnce();
		expect(clearKustoCopilotConversation.mock.calls[0][0]).toBe(kusto);
		expect(clearCopilotConversation).toHaveBeenCalledOnce();
		expect(clearCopilotConversation).toHaveBeenCalledWith('  sql-clear-exact  ');
		expect(kustoSettled).toBe(false);
		expect(sqlSettled).toBe(false);

		kustoSettlement.resolve(false);
		await expect(kustoRequest).resolves.toBeUndefined();
		expect(kustoSettled).toBe(true);
		expect(sqlSettled).toBe(false);

		sqlSettlement.resolve();
		await expect(sqlRequest).resolves.toBeUndefined();
		expect(sqlSettled).toBe(true);
	});

	it('preserves metadata-free SQL compatibility', async () => {
		const clearCopilotConversation = vi.fn(async () => undefined);
		const { handler, clearKustoCopilotConversation } = createHandler({ clearCopilotConversation });
		const message = {
			type: 'clearCopilotConversation',
			boxId: 'sql-clear-compat',
		} satisfies ClearMessage;

		await expect(handler.handleMessage(message)).resolves.toBeUndefined();

		expect(clearCopilotConversation).toHaveBeenCalledWith('sql-clear-compat');
		expect(clearKustoCopilotConversation).not.toHaveBeenCalled();
	});

	it('claims but rejects every malformed Kusto request identity before delegation', async () => {
		const { handler, clearCopilotConversation, clearKustoCopilotConversation } = createHandler();
		const invalidMessages = [
			kustoMessage({ boxId: '' }),
			kustoMessage({ copilotRequestId: '' }),
			kustoMessage({ sectionInstanceId: '' }),
			kustoMessage({ targetGeneration: -1 }),
			{ ...kustoMessage(), targetGeneration: 1.5 },
		] as unknown as IncomingWebviewMessage[];

		for (const message of invalidMessages) {
			const request = handler.handleMessage(message);
			expect(request).toBeInstanceOf(Promise);
			await expect(request).resolves.toBeUndefined();
		}

		expect(clearCopilotConversation).not.toHaveBeenCalled();
		expect(clearKustoCopilotConversation).not.toHaveBeenCalled();
	});

	it('propagates exact asynchronous and synchronous rejections from both capabilities', async () => {
		const asynchronousKustoFailure = new Error('Kusto clear failed asynchronously');
		const synchronousKustoFailure = new Error('Kusto clear failed synchronously');
		const asynchronousSqlFailure = new Error('SQL clear failed asynchronously');
		const synchronousSqlFailure = new Error('SQL clear failed synchronously');
		const asynchronousKusto = createHandler({
			clearKustoCopilotConversation: vi.fn(async () => { throw asynchronousKustoFailure; }),
		});
		const synchronousKusto = createHandler({
			clearKustoCopilotConversation: vi.fn(() => { throw synchronousKustoFailure; }),
		});
		const asynchronousSql = createHandler({
			clearCopilotConversation: vi.fn(async () => { throw asynchronousSqlFailure; }),
		});
		const synchronousSql = createHandler({
			clearCopilotConversation: vi.fn(() => { throw synchronousSqlFailure; }),
		});
		const sqlMessage = {
			type: 'clearCopilotConversation', boxId: 'sql-clear-failure', flavor: 'sql',
		} satisfies ClearMessage;

		await expect(asynchronousKusto.handler.handleMessage(kustoMessage()))
			.rejects.toBe(asynchronousKustoFailure);
		await expect(synchronousKusto.handler.handleMessage(kustoMessage()))
			.rejects.toBe(synchronousKustoFailure);
		await expect(asynchronousSql.handler.handleMessage(sqlMessage))
			.rejects.toBe(asynchronousSqlFailure);
		await expect(synchronousSql.handler.handleMessage(sqlMessage))
			.rejects.toBe(synchronousSqlFailure);
	});

	it('allows accepted Kusto and SQL settlements to complete across disposal', async () => {
		const kustoSettlement = deferred<boolean>();
		const sqlSettlement = deferred<void>();
		const clearKustoCopilotConversation = vi.fn(() => kustoSettlement.promise);
		const clearCopilotConversation = vi.fn(() => sqlSettlement.promise);
		const { handler } = createHandler({
			clearCopilotConversation,
			clearKustoCopilotConversation,
		});
		const sqlMessage = {
			type: 'clearCopilotConversation', boxId: 'sql-clear-dispose', flavor: 'sql',
		} satisfies ClearMessage;
		const kustoRequest = handler.handleMessage(kustoMessage())!;
		const sqlRequest = handler.handleMessage(sqlMessage)!;

		handler.dispose();
		kustoSettlement.resolve(true);
		sqlSettlement.resolve();

		await expect(kustoRequest).resolves.toBeUndefined();
		await expect(sqlRequest).resolves.toBeUndefined();
	});

	it('preserves an accepted rejection across disposal', async () => {
		const settlement = deferred<boolean>();
		const failure = new Error('accepted Kusto clear failed');
		const { handler } = createHandler({
			clearKustoCopilotConversation: vi.fn(() => settlement.promise),
		});
		const request = handler.handleMessage(kustoMessage())!;

		handler.dispose();
		settlement.reject(failure);

		await expect(request).rejects.toBe(failure);
	});

	it('claims but suppresses later clear requests after idempotent disposal', async () => {
		const { handler, clearCopilotConversation, clearKustoCopilotConversation } = createHandler();

		handler.dispose();
		handler.dispose();
		const kustoRequest = handler.handleMessage(kustoMessage());
		const sqlRequest = handler.handleMessage({
			type: 'clearCopilotConversation', boxId: 'sql-clear-late', flavor: 'sql',
		});

		expect(kustoRequest).toBeInstanceOf(Promise);
		expect(sqlRequest).toBeInstanceOf(Promise);
		await expect(kustoRequest).resolves.toBeUndefined();
		await expect(sqlRequest).resolves.toBeUndefined();
		expect(clearCopilotConversation).not.toHaveBeenCalled();
		expect(clearKustoCopilotConversation).not.toHaveBeenCalled();
	});
});
