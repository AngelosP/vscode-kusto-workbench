import { describe, expect, it, vi } from 'vitest';

import {
	HostCopilotInlineCompletionApplicationHandler,
	type CopilotInlineCompletionApplicationHandlerOptions,
} from '../../../src/host/copilotInlineCompletionApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';
import type { SqlIssuedOwnerToken } from '../../../src/host/sql/sqlEditorSessionRegistry';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function kustoMessage(): Extract<IncomingWebviewMessage, { type: 'requestCopilotInlineCompletion' }> {
	return {
		type: 'requestCopilotInlineCompletion',
		requestId: 'inline-kusto-1',
		boxId: 'query-1',
		textBefore: 'StormEvents\n| where State == "WA"\n| ',
		textAfter: '\n| take 10',
		flavor: 'kusto',
	};
}

function sqlMessage(): Extract<IncomingWebviewMessage, { type: 'requestCopilotInlineCompletion' }> {
	return {
		type: 'requestCopilotInlineCompletion',
		requestId: 'inline-sql-1',
		boxId: 'sql-1',
		textBefore: 'SELECT *\nFROM dbo.Events\nWHERE ',
		textAfter: '\nORDER BY CreatedAt DESC',
		flavor: 'sql',
		ownerToken: 'sql-owner-token-1',
	};
}

const issuedOwnerToken: SqlIssuedOwnerToken = Object.freeze({
	token: 'issued-owner-token-1',
	owner: Object.freeze({
		connectionId: 'sql-connection-1',
		database: 'EventsDb',
		generation: 7,
		targetSignature: 'target-signature-1',
		principalFingerprint: 'principal-1',
		revocationGeneration: 3,
	}),
});

function createHandler(overrides: Partial<CopilotInlineCompletionApplicationHandlerOptions> = {}) {
	const assertSqlOwnerToken = vi.fn(async () => issuedOwnerToken);
	const handleCopilotInlineCompletionRequest = vi.fn(async () => undefined);
	const postMessage = vi.fn(() => Promise.resolve(true));
	const handler = new HostCopilotInlineCompletionApplicationHandler({
		assertSqlOwnerToken,
		handleCopilotInlineCompletionRequest,
		postMessage,
		...overrides,
	});
	return { handler, assertSqlOwnerToken, handleCopilotInlineCompletionRequest, postMessage };
}

describe('HostCopilotInlineCompletionApplicationHandler', () => {
	it('declines unrelated Kusto and SQL messages synchronously', () => {
		const { handler, assertSqlOwnerToken, handleCopilotInlineCompletionRequest, postMessage } = createHandler();

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(assertSqlOwnerToken).not.toHaveBeenCalled();
		expect(handleCopilotInlineCompletionRequest).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('descriptor-snapshots Kusto requests and awaits exact settlement', async () => {
		const completion = deferred<void>();
		const handleCopilotInlineCompletionRequest = vi.fn(() => completion.promise);
		const { handler, assertSqlOwnerToken, postMessage } = createHandler({
			handleCopilotInlineCompletionRequest,
		});
		const message = kustoMessage();
		let settled = false;

		const request = handler.handleMessage(message)!;
		void request.finally(() => { settled = true; });
		await Promise.resolve();

		expect(handleCopilotInlineCompletionRequest).toHaveBeenCalledOnce();
		expect(handleCopilotInlineCompletionRequest.mock.calls[0]).toEqual([message]);
		expect(handleCopilotInlineCompletionRequest.mock.calls[0][0]).not.toBe(message);
		expect(assertSqlOwnerToken).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
		expect(settled).toBe(false);

		completion.resolve();
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('asserts SQL admission before delegating the exact issued owner and token', async () => {
		const admission = deferred<SqlIssuedOwnerToken>();
		const completion = deferred<void>();
		const assertSqlOwnerToken = vi.fn(() => admission.promise);
		const handleCopilotInlineCompletionRequest = vi.fn(() => completion.promise);
		const { handler, postMessage } = createHandler({
			assertSqlOwnerToken,
			handleCopilotInlineCompletionRequest,
		});
		const message = sqlMessage();
		let settled = false;

		const request = handler.handleMessage(message)!;
		void request.finally(() => { settled = true; });
		await Promise.resolve();

		expect(assertSqlOwnerToken).toHaveBeenCalledOnce();
		expect(assertSqlOwnerToken).toHaveBeenCalledWith(message.boxId, message.ownerToken);
		expect(handleCopilotInlineCompletionRequest).not.toHaveBeenCalled();
		expect(settled).toBe(false);

		admission.resolve(issuedOwnerToken);
		await vi.waitFor(() => expect(handleCopilotInlineCompletionRequest).toHaveBeenCalledOnce());
		expect(handleCopilotInlineCompletionRequest.mock.calls[0][0]).toEqual(message);
		expect(handleCopilotInlineCompletionRequest.mock.calls[0][0]).not.toBe(message);
		expect(handleCopilotInlineCompletionRequest.mock.calls[0][1]).toBe(issuedOwnerToken.owner);
		expect(handleCopilotInlineCompletionRequest.mock.calls[0][2]).toBe(issuedOwnerToken.token);
		expect(postMessage).not.toHaveBeenCalled();
		expect(settled).toBe(false);

		completion.resolve();
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('claims malformed recognized requests before SQL owner or Copilot effects', async () => {
		const { handler, assertSqlOwnerToken, handleCopilotInlineCompletionRequest, postMessage } = createHandler();

		await expect(handler.handleMessage({
			...sqlMessage(),
			ownerToken: ['forged'],
		} as unknown as IncomingWebviewMessage)).resolves.toBeUndefined();

		expect(assertSqlOwnerToken).not.toHaveBeenCalled();
		expect(handleCopilotInlineCompletionRequest).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('publishes the exact empty SQL fallback when owner admission rejects', async () => {
		const failure = new Error('owner token changed');
		const assertSqlOwnerToken = vi.fn(async () => { throw failure; });
		const { handler, handleCopilotInlineCompletionRequest, postMessage } = createHandler({
			assertSqlOwnerToken,
		});
		const message = sqlMessage();

		await expect(handler.handleMessage(message)).resolves.toBeUndefined();

		expect(handleCopilotInlineCompletionRequest).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledWith({
			type: 'copilotInlineCompletionResult',
			requestId: message.requestId,
			boxId: message.boxId,
			ownerToken: message.ownerToken,
			completions: [],
		});
	});

	it('publishes the same empty SQL fallback when Copilot delegation rejects', async () => {
		const failure = new Error('inline model failed');
		const handleCopilotInlineCompletionRequest = vi.fn(async () => { throw failure; });
		const { handler, assertSqlOwnerToken, postMessage } = createHandler({
			handleCopilotInlineCompletionRequest,
		});
		const message = sqlMessage();

		await expect(handler.handleMessage(message)).resolves.toBeUndefined();

		expect(assertSqlOwnerToken).toHaveBeenCalledWith(message.boxId, message.ownerToken);
		expect(handleCopilotInlineCompletionRequest.mock.calls[0][0]).toEqual(message);
		expect(handleCopilotInlineCompletionRequest.mock.calls[0][0]).not.toBe(message);
		expect(handleCopilotInlineCompletionRequest.mock.calls[0][1]).toBe(issuedOwnerToken.owner);
		expect(handleCopilotInlineCompletionRequest.mock.calls[0][2]).toBe(issuedOwnerToken.token);
		expect(postMessage).toHaveBeenCalledWith({
			type: 'copilotInlineCompletionResult',
			requestId: message.requestId,
			boxId: message.boxId,
			ownerToken: message.ownerToken,
			completions: [],
		});
	});

	it('does not await empty-fallback transport settlement', async () => {
		const transport = deferred<boolean>();
		const postMessage = vi.fn(() => transport.promise);
		const { handler } = createHandler({
			assertSqlOwnerToken: vi.fn(async () => { throw new Error('denied'); }),
			postMessage,
		});
		let settled = false;

		const request = handler.handleMessage(sqlMessage())!;
		void request.then(() => { settled = true; });
		await request;

		expect(settled).toBe(true);
		expect(postMessage).toHaveBeenCalledOnce();
		transport.resolve(true);
	});

	it('propagates the exact Kusto delegation rejection without a fallback', async () => {
		const failure = new Error('Kusto inline model failed');
		const handleCopilotInlineCompletionRequest = vi.fn(async () => { throw failure; });
		const { handler, assertSqlOwnerToken, postMessage } = createHandler({
			handleCopilotInlineCompletionRequest,
		});
		const message = kustoMessage();

		await expect(handler.handleMessage(message)).rejects.toBe(failure);

		expect(handleCopilotInlineCompletionRequest.mock.calls[0][0]).toEqual(message);
		expect(handleCopilotInlineCompletionRequest.mock.calls[0][0]).not.toBe(message);
		expect(assertSqlOwnerToken).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('allows accepted SQL admission and delegation to settle across disposal', async () => {
		const admission = deferred<SqlIssuedOwnerToken>();
		const completion = deferred<void>();
		const assertSqlOwnerToken = vi.fn(() => admission.promise);
		const handleCopilotInlineCompletionRequest = vi.fn(() => completion.promise);
		const { handler, postMessage } = createHandler({
			assertSqlOwnerToken,
			handleCopilotInlineCompletionRequest,
		});
		const message = sqlMessage();
		const request = handler.handleMessage(message)!;

		handler.dispose();
		admission.resolve(issuedOwnerToken);
		await vi.waitFor(() => expect(handleCopilotInlineCompletionRequest).toHaveBeenCalledOnce());
		expect(handleCopilotInlineCompletionRequest.mock.calls[0][0]).toEqual(message);
		expect(handleCopilotInlineCompletionRequest.mock.calls[0][0]).not.toBe(message);
		expect(handleCopilotInlineCompletionRequest.mock.calls[0][1]).toBe(issuedOwnerToken.owner);
		expect(handleCopilotInlineCompletionRequest.mock.calls[0][2]).toBe(issuedOwnerToken.token);
		expect(postMessage).not.toHaveBeenCalled();

		completion.resolve();
		await expect(request).resolves.toBeUndefined();
	});

	it('claims but suppresses later requests after idempotent disposal', async () => {
		const { handler, assertSqlOwnerToken, handleCopilotInlineCompletionRequest, postMessage } = createHandler();

		handler.dispose();
		handler.dispose();
		const request = handler.handleMessage(sqlMessage());

		expect(request).toBeInstanceOf(Promise);
		await expect(request).resolves.toBeUndefined();
		expect(assertSqlOwnerToken).not.toHaveBeenCalled();
		expect(handleCopilotInlineCompletionRequest).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
	});
});