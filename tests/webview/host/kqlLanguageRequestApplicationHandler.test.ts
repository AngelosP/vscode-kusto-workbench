import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	HostKqlLanguageRequestApplicationHandler,
	type KqlLanguageRequestApplicationHandlerOptions,
} from '../../../src/host/kqlLanguageRequestApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

const liveHandlers = new Set<HostKqlLanguageRequestApplicationHandler>();

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createHandler(
	languageHost: NonNullable<KqlLanguageRequestApplicationHandlerOptions['languageHost']> = {
		getDiagnostics: vi.fn(async () => ({ diagnostics: [] })),
		findTableReferences: vi.fn(async () => ({ references: [] })),
	},
) {
	const postMessage = vi.fn(() => Promise.resolve(true));
	const error = vi.fn();
	const handler = new HostKqlLanguageRequestApplicationHandler({
		connectionManager: {} as KqlLanguageRequestApplicationHandlerOptions['connectionManager'],
		context: {} as KqlLanguageRequestApplicationHandlerOptions['context'],
		postMessage,
		output: { error },
		languageHost,
	});
	liveHandlers.add(handler);
	return { handler, postMessage, error, languageHost };
}

function request(
	method: 'textDocument/diagnostic' | 'kusto/findTableReferences',
	requestId = 'kql-request-1',
): Extract<IncomingWebviewMessage, { type: 'kqlLanguageRequest' }> {
	return {
		type: 'kqlLanguageRequest',
		requestId,
		method,
		params: {
			text: 'StormEvents | project State',
			connectionId: 'connection-1',
			database: 'Samples',
			boxId: 'query-1',
			uri: 'file:///workspace/query.kqlx',
		},
	};
}

describe('HostKqlLanguageRequestApplicationHandler', () => {
	afterEach(() => {
		for (const handler of liveHandlers) handler.dispose();
		liveHandlers.clear();
	});

	it('declines unrelated Kusto and SQL messages synchronously', () => {
		const { handler, languageHost, postMessage, error } = createHandler();

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(languageHost.getDiagnostics).not.toHaveBeenCalled();
		expect(languageHost.findTableReferences).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
	});

	it('delegates diagnostics with the exact params and publishes the exact result', async () => {
		const result = {
			diagnostics: [{
				range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
				severity: 1,
				message: 'Expected expression.',
			}],
		};
		const languageHost = {
			getDiagnostics: vi.fn(async () => result),
			findTableReferences: vi.fn(async () => ({ references: [] })),
		};
		const { handler, postMessage, error } = createHandler(languageHost);
		const message = request('textDocument/diagnostic', '  diagnostics-1  ');

		await handler.handleMessage(message);

		expect(languageHost.getDiagnostics).toHaveBeenCalledOnce();
		expect(languageHost.getDiagnostics.mock.calls[0][0]).toBe(message.params);
		expect(languageHost.findTableReferences).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledWith({
			type: 'kqlLanguageResponse', requestId: 'diagnostics-1', ok: true, result,
		});
		expect(error).not.toHaveBeenCalled();
	});

	it('delegates table-reference analysis with the exact params and publishes the exact result', async () => {
		const result = { references: [{ name: 'StormEvents', startOffset: 0, endOffset: 11 }] };
		const languageHost = {
			getDiagnostics: vi.fn(async () => ({ diagnostics: [] })),
			findTableReferences: vi.fn(async () => result),
		};
		const { handler, postMessage, error } = createHandler(languageHost);
		const message = request('kusto/findTableReferences', 'references-1');

		await handler.handleMessage(message);

		expect(languageHost.findTableReferences).toHaveBeenCalledOnce();
		expect(languageHost.findTableReferences.mock.calls[0][0]).toBe(message.params);
		expect(languageHost.getDiagnostics).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledWith({
			type: 'kqlLanguageResponse', requestId: 'references-1', ok: true, result,
		});
		expect(error).not.toHaveBeenCalled();
	});

	it('does not await response transport settlement', async () => {
		const transport = deferred<boolean>();
		const postMessage = vi.fn(() => transport.promise);
		const languageHost = {
			getDiagnostics: vi.fn(async () => ({ diagnostics: [] })),
			findTableReferences: vi.fn(async () => ({ references: [] })),
		};
		const handler = new HostKqlLanguageRequestApplicationHandler({
			connectionManager: {} as KqlLanguageRequestApplicationHandlerOptions['connectionManager'],
			context: {} as KqlLanguageRequestApplicationHandlerOptions['context'],
			postMessage,
			output: { error: vi.fn() },
			languageHost,
		});
		liveHandlers.add(handler);
		let settled = false;

		const handled = handler.handleMessage(request('kusto/findTableReferences', 'transport-pending'))!;
		void handled.then(() => { settled = true; });
		await handled;

		expect(settled).toBe(true);
		expect(postMessage).toHaveBeenCalledOnce();
		transport.resolve(true);
	});

	it('ignores a blank request ID before delegation or publication', async () => {
		const { handler, languageHost, postMessage, error } = createHandler();

		await handler.handleMessage(request('kusto/findTableReferences', '   '));

		expect(languageHost.getDiagnostics).not.toHaveBeenCalled();
		expect(languageHost.findTableReferences).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
	});

	it('preserves fallback params for malformed runtime input', async () => {
		const languageHost = {
			getDiagnostics: vi.fn(async () => ({ diagnostics: [] })),
			findTableReferences: vi.fn(async () => ({ references: [] })),
		};
		const { handler } = createHandler(languageHost);
		const message = {
			type: 'kqlLanguageRequest', requestId: 'malformed-params',
			method: 'textDocument/diagnostic', params: null,
		} as unknown as IncomingWebviewMessage;

		await handler.handleMessage(message);

		expect(languageHost.getDiagnostics).toHaveBeenCalledWith({ text: '' });
	});

	it('publishes the existing unsupported-method response without delegation', async () => {
		const { handler, languageHost, postMessage, error } = createHandler();
		const message = {
			type: 'kqlLanguageRequest', requestId: 'unsupported-1',
			method: 'workspace/symbol', params: { text: 'StormEvents' },
		} as unknown as IncomingWebviewMessage;

		await handler.handleMessage(message);

		expect(languageHost.getDiagnostics).not.toHaveBeenCalled();
		expect(languageHost.findTableReferences).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledWith({
			type: 'kqlLanguageResponse', requestId: 'unsupported-1', ok: false,
			error: { message: 'Unsupported method.' },
		});
		expect(error).not.toHaveBeenCalled();
	});

	it.each(['getDiagnostics', 'findTableReferences'] as const)(
		'logs and publishes the fixed failure response when %s rejects',
		async methodName => {
			const failure = new Error('analysis failed with details');
			const languageHost = {
				getDiagnostics: vi.fn(async () => ({ diagnostics: [] })),
				findTableReferences: vi.fn(async () => ({ references: [] })),
			};
			languageHost[methodName].mockRejectedValueOnce(failure as never);
			const { handler, postMessage, error } = createHandler(languageHost);
			const method = methodName === 'getDiagnostics'
				? 'textDocument/diagnostic'
				: 'kusto/findTableReferences';

			await handler.handleMessage(request(method, 'failure-1'));

			expect(error).toHaveBeenCalledOnce();
			expect(error).toHaveBeenCalledWith('[kql-ls] request failed: analysis failed with details');
			expect(postMessage).toHaveBeenCalledWith({
				type: 'kqlLanguageResponse', requestId: 'failure-1', ok: false,
				error: { message: 'KQL language service failed to process the request.' },
			});
		},
	);

	it('propagates a throwing logger exactly and does not publish a failure response', async () => {
		const analysisFailure = new Error('analysis failed');
		const loggerFailure = new Error('logger failed');
		const postMessage = vi.fn(() => Promise.resolve(true));
		const error = vi.fn(() => { throw loggerFailure; });
		const handler = new HostKqlLanguageRequestApplicationHandler({
			connectionManager: {} as KqlLanguageRequestApplicationHandlerOptions['connectionManager'],
			context: {} as KqlLanguageRequestApplicationHandlerOptions['context'],
			postMessage,
			output: { error },
			languageHost: {
				getDiagnostics: vi.fn(async () => { throw analysisFailure; }),
				findTableReferences: vi.fn(async () => ({ references: [] })),
			},
		});
		liveHandlers.add(handler);

		await expect(handler.handleMessage(request('textDocument/diagnostic', 'logger-failure')))
			.rejects.toBe(loggerFailure);

		expect(error).toHaveBeenCalledWith('[kql-ls] request failed: analysis failed');
		expect(postMessage).not.toHaveBeenCalled();
	});

	it.each(['resolve', 'reject'] as const)(
		'suppresses late %s effects after disposal and claims later requests',
		async outcome => {
			const pending = deferred<{ references: [] }>();
			const languageHost = {
				getDiagnostics: vi.fn(async () => ({ diagnostics: [] })),
				findTableReferences: vi.fn(() => pending.promise),
			};
			const { handler, postMessage, error } = createHandler(languageHost);
			const accepted = handler.handleMessage(request('kusto/findTableReferences', 'pending-1'))!;
			await Promise.resolve();

			handler.dispose();
			if (outcome === 'resolve') {
				pending.resolve({ references: [] });
			} else {
				pending.reject(new Error('late analysis failure'));
			}
			await accepted;
			await expect(handler.handleMessage(request('kusto/findTableReferences', 'after-dispose')))
				.resolves.toBeUndefined();

			expect(languageHost.findTableReferences).toHaveBeenCalledOnce();
			expect(postMessage).not.toHaveBeenCalled();
			expect(error).not.toHaveBeenCalled();
		},
	);
});
