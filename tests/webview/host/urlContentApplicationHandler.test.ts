import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	HostUrlContentApplicationHandler,
	type UrlContentApplicationHandlerOptions,
} from '../../../src/host/urlContentApplicationHandler';

const liveHandlers = new Set<HostUrlContentApplicationHandler>();

function createResponse(
	body: BodyInit | null,
	options: ResponseInit & { url?: string; contentType?: string } = {},
): Response {
	const headers = new Headers(options.headers);
	if (options.contentType !== undefined) headers.set('content-type', options.contentType);
	const response = new Response(body, { ...options, headers });
	Object.defineProperty(response, 'url', { value: options.url ?? '', configurable: true });
	return response;
}

function createHandler(
	fetchUrl: ReturnType<typeof vi.fn>,
	options: Omit<UrlContentApplicationHandlerOptions, 'postMessage' | 'fetchUrl'> = {},
) {
	const postMessage = vi.fn(() => Promise.resolve(true));
	const handler = new HostUrlContentApplicationHandler({
		postMessage,
		fetchUrl: fetchUrl as typeof fetch,
		...options,
	});
	liveHandlers.add(handler);
	return { handler, postMessage };
}

function fetchMessage(url: string, boxId = 'url-section', requestId = 'url-request') {
	return { type: 'fetchUrl' as const, boxId, url, requestId };
}

describe('HostUrlContentApplicationHandler', () => {
	afterEach(() => {
		for (const handler of liveHandlers) handler.dispose();
		liveHandlers.clear();
		vi.useRealTimers();
	});

	it('declines unrelated Kusto and SQL messages synchronously', () => {
		const fetchUrl = vi.fn();
		const { handler, postMessage } = createHandler(fetchUrl);

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(fetchUrl).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('claims malformed recognized requests before coercion or fetch effects', async () => {
		const fetchUrl = vi.fn();
		const { handler, postMessage } = createHandler(fetchUrl);
		const inheritedBoxId = Object.assign(Object.create({ boxId: 'url-section' }), {
			type: 'fetchUrl', url: 'https://example.com/data.csv', requestId: 'url-request',
		});
		for (const message of [
			Object.assign([], fetchMessage('https://example.com/data.csv')),
			Object.assign(() => undefined, fetchMessage('https://example.com/data.csv')),
			inheritedBoxId,
			{ ...fetchMessage('https://example.com/data.csv'), boxId: ['url-section'] },
			{ ...fetchMessage('https://example.com/data.csv'), url: { href: 'https://example.com' } },
			{ ...fetchMessage('https://example.com/data.csv'), requestId: 42 },
		]) {
			await handler.handleMessage(message as never);
		}

		expect(fetchUrl).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('snapshots a valid request proxy before host field reads', async () => {
		let propertyReads = 0;
		const request = fetchMessage('https://example.com/data.csv');
		const requestProxy = new Proxy(request, {
			get() {
				propertyReads++;
				throw new Error('property read');
			},
		});
		const fetchUrl = vi.fn(async () => createResponse('Name\nalpha', {
			status: 200, contentType: 'text/csv', url: request.url,
		}));
		const { handler, postMessage } = createHandler(fetchUrl);

		await handler.handleMessage(requestProxy);

		expect(propertyReads).toBe(0);
		expect(fetchUrl).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'urlContent', boxId: request.boxId, requestId: request.requestId,
			requestedUrl: request.url, kind: 'csv', body: 'Name\nalpha',
		}));
	});

	it('preserves normalized request identity for invalid and non-HTTP URLs', async () => {
		const fetchUrl = vi.fn();
		const { handler, postMessage } = createHandler(fetchUrl);

		await handler.handleMessage(fetchMessage('  not a URL  ', '  url-a  ', '  request-a  '));
		await handler.handleMessage(fetchMessage('file:///C:/private.csv', 'url-b', 'request-b'));

		expect(fetchUrl).not.toHaveBeenCalled();
		expect(postMessage.mock.calls.map(call => call[0])).toEqual([
			{
				type: 'urlError', boxId: 'url-a', requestId: 'request-a',
				requestedUrl: 'not a URL', error: 'Invalid URL.',
			},
			{
				type: 'urlError', boxId: 'url-b', requestId: 'request-b',
				requestedUrl: 'file:///C:/private.csv', error: 'Only http/https URLs are supported.',
			},
		]);
	});

	it('follows redirects and publishes CSV with original and resolved URL identity', async () => {
		const fetchUrl = vi.fn(async () => createResponse('Name,Score\nalpha,1', {
			status: 200,
			contentType: 'text/csv; charset=utf-8',
			url: 'https://cdn.example.com/data/final.csv',
		}));
		const { handler, postMessage } = createHandler(fetchUrl);

		await handler.handleMessage(fetchMessage('https://example.com/download?id=1'));

		expect(fetchUrl).toHaveBeenCalledOnce();
		expect(fetchUrl).toHaveBeenCalledWith('https://example.com/download?id=1', {
			redirect: 'follow',
			signal: expect.any(AbortSignal),
		});
		expect(postMessage).toHaveBeenCalledWith({
			type: 'urlContent',
			boxId: 'url-section',
			requestId: 'url-request',
			requestedUrl: 'https://example.com/download?id=1',
			url: 'https://cdn.example.com/data/final.csv',
			contentType: 'text/csv; charset=utf-8',
			status: 200,
			kind: 'csv',
			body: 'Name,Score\nalpha,1',
			truncated: false,
			byteLength: 18,
		});
	});

	it.each([
		{
			name: 'CSV by resolved extension',
			contentType: 'application/octet-stream',
			url: 'https://example.com/data.csv',
			body: 'Name\nalpha',
			kind: 'csv',
		},
		{
			name: 'HTML by content type',
			contentType: 'text/html; charset=utf-8',
			url: 'https://example.com/page',
			body: '<main>hello</main>',
			kind: 'html',
		},
		{
			name: 'text by JSON content type',
			contentType: 'application/json',
			url: 'https://example.com/data',
			body: '{"value":1}',
			kind: 'text',
		},
	] as const)('classifies $name', async ({ contentType, url, body, kind }) => {
		const fetchUrl = vi.fn(async () => createResponse(body, { status: 200, contentType, url }));
		const { handler, postMessage } = createHandler(fetchUrl);

		await handler.handleMessage(fetchMessage('https://example.com/source'));

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'urlContent', url, contentType, kind, body, truncated: false,
		}));
	});

	it('publishes an empty text body without dropping it', async () => {
		const fetchUrl = vi.fn(async () => createResponse('', {
			status: 200,
			contentType: 'text/plain',
			url: 'https://example.com/empty.txt',
		}));
		const { handler, postMessage } = createHandler(fetchUrl);

		await handler.handleMessage(fetchMessage('https://example.com/empty.txt'));

		expect(postMessage).toHaveBeenCalledWith({
			type: 'urlContent', boxId: 'url-section', requestId: 'url-request',
			requestedUrl: 'https://example.com/empty.txt', url: 'https://example.com/empty.txt',
			contentType: 'text/plain', status: 200, kind: 'text', body: '',
			truncated: false, byteLength: 0,
		});
	});

	it('sniffs HTML bodies and does not classify an HTML response as CSV by extension', async () => {
		const body = '  <!DOCTYPE html><html><body>Sign in</body></html>';
		const fetchUrl = vi.fn(async () => createResponse(body, {
			status: 200,
			contentType: 'application/octet-stream',
			url: 'https://example.com/export.csv',
		}));
		const { handler, postMessage } = createHandler(fetchUrl);

		await handler.handleMessage(fetchMessage('https://example.com/export.csv'));

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'urlContent', kind: 'html', body,
		}));
	});

	it('publishes images as exact data URIs without a text body', async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		const fetchUrl = vi.fn(async () => createResponse(bytes, {
			status: 200,
			contentType: 'image/png; charset=binary',
			url: 'https://cdn.example.com/image.png',
		}));
		const { handler, postMessage } = createHandler(fetchUrl);

		await handler.handleMessage(fetchMessage('https://example.com/image'));

		expect(postMessage).toHaveBeenCalledWith({
			type: 'urlContent',
			boxId: 'url-section',
			requestId: 'url-request',
			requestedUrl: 'https://example.com/image',
			url: 'https://cdn.example.com/image.png',
			contentType: 'image/png; charset=binary',
			status: 200,
			kind: 'image',
			dataUri: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
			byteLength: bytes.byteLength,
		});
	});

	it('truncates decoded text at 200,000 characters while retaining exact byte length', async () => {
		const body = 'a'.repeat(200_001);
		const fetchUrl = vi.fn(async () => createResponse(body, {
			status: 200,
			contentType: 'text/plain',
			url: 'https://example.com/large.txt',
		}));
		const { handler, postMessage } = createHandler(fetchUrl);

		await handler.handleMessage(fetchMessage('https://example.com/large.txt'));

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'urlContent', kind: 'text', body: 'a'.repeat(200_000),
			truncated: true, byteLength: 200_001,
		}));
	});

	it.each([
		{ name: 'text/CSV', contentType: 'text/csv', maxTextBytes: 4, maxImageBytes: 10, expected: '4 B' },
		{ name: 'image', contentType: 'image/png', maxTextBytes: 10, maxImageBytes: 4, expected: '4 B' },
	] as const)('enforces the $name byte cap before publication', async ({ contentType, maxTextBytes, maxImageBytes, expected }) => {
		const fetchUrl = vi.fn(async () => createResponse(new Uint8Array(5), {
			status: 200,
			contentType,
			url: 'https://example.com/content',
		}));
		const { handler, postMessage } = createHandler(fetchUrl, { maxTextBytes, maxImageBytes });

		await handler.handleMessage(fetchMessage('https://example.com/content'));

		expect(postMessage).toHaveBeenCalledWith({
			type: 'urlError', boxId: 'url-section', requestId: 'url-request',
			requestedUrl: 'https://example.com/content',
			error: `Response too large (5 B). Max is ${expected}.`,
		});
	});

	it('preserves HTTP status errors and the raw-CSV HTML hint', async () => {
		const fetchUrl = vi.fn(async () => createResponse('<html>not found</html>', {
			status: 404,
			statusText: 'Not Found',
			contentType: 'text/html',
			url: 'https://example.com/missing.csv',
		}));
		const { handler, postMessage } = createHandler(fetchUrl);

		await handler.handleMessage(fetchMessage('https://example.com/missing.csv'));

		expect(postMessage).toHaveBeenCalledWith({
			type: 'urlError', boxId: 'url-section', requestId: 'url-request',
			requestedUrl: 'https://example.com/missing.csv',
			error: 'HTTP 404 Not Found. The server returned HTML, not CSV. Try using a raw download link.',
		});
	});

	it('preserves nonblank fetch failure messages and canonicalizes blank or non-Error failures', async () => {
		const fetchUrl = vi.fn()
			.mockRejectedValueOnce(new Error('socket closed'))
			.mockRejectedValueOnce(new Error(''))
			.mockRejectedValueOnce('failed');
		const { handler, postMessage } = createHandler(fetchUrl);

		await handler.handleMessage(fetchMessage('https://example.com/a'));
		await handler.handleMessage(fetchMessage('https://example.com/b', 'url-b', 'request-b'));
		await handler.handleMessage(fetchMessage('https://example.com/c', 'url-c', 'request-c'));

		expect(postMessage.mock.calls.map(call => call[0])).toEqual([
			{
				type: 'urlError', boxId: 'url-section', requestId: 'url-request',
				requestedUrl: 'https://example.com/a', error: 'socket closed',
			},
			{
				type: 'urlError', boxId: 'url-b', requestId: 'request-b',
				requestedUrl: 'https://example.com/b', error: 'Failed to fetch URL.',
			},
			{
				type: 'urlError', boxId: 'url-c', requestId: 'request-c',
				requestedUrl: 'https://example.com/c', error: 'Failed to fetch URL.',
			},
		]);
	});

	it('extracts proxy errors without property reads and ignores hostile accessors', async () => {
		let propertyReads = 0;
		const proxiedError = new Proxy(new Error('proxy failure'), {
			get() {
				propertyReads++;
				throw new Error('property read');
			},
		});
		const accessorError = {};
		Object.defineProperty(accessorError, 'message', {
			get() {
				propertyReads++;
				throw new Error('accessor read');
			},
		});
		const fetchUrl = vi.fn()
			.mockRejectedValueOnce(proxiedError)
			.mockRejectedValueOnce(accessorError);
		const { handler, postMessage } = createHandler(fetchUrl);

		await handler.handleMessage(fetchMessage('https://example.com/a'));
		await handler.handleMessage(fetchMessage('https://example.com/b', 'url-b', 'request-b'));

		expect(propertyReads).toBe(0);
		expect(postMessage.mock.calls.map(call => call[0])).toEqual([
			{
				type: 'urlError', boxId: 'url-section', requestId: 'url-request',
				requestedUrl: 'https://example.com/a', error: 'proxy failure',
			},
			{
				type: 'urlError', boxId: 'url-b', requestId: 'request-b',
				requestedUrl: 'https://example.com/b', error: 'Failed to fetch URL.',
			},
		]);
	});

	it('bounds cyclic and unbounded error prototype inspection', async () => {
		let cyclicError: object;
		cyclicError = new Proxy({}, {
			getPrototypeOf: () => cyclicError,
		});
		let prototypeReads = 0;
		const createUnboundedError = (): object => new Proxy({}, {
			getPrototypeOf() {
				prototypeReads++;
				return createUnboundedError();
			},
		});
		const fetchUrl = vi.fn()
			.mockRejectedValueOnce(cyclicError)
			.mockRejectedValueOnce(createUnboundedError());
		const { handler, postMessage } = createHandler(fetchUrl);

		await handler.handleMessage(fetchMessage('https://example.com/a'));
		await handler.handleMessage(fetchMessage('https://example.com/b', 'url-b', 'request-b'));

		expect(prototypeReads).toBe(32);
		expect(postMessage.mock.calls.map(call => call[0])).toEqual([
			{
				type: 'urlError', boxId: 'url-section', requestId: 'url-request',
				requestedUrl: 'https://example.com/a', error: 'Failed to fetch URL.',
			},
			{
				type: 'urlError', boxId: 'url-b', requestId: 'request-b',
				requestedUrl: 'https://example.com/b', error: 'Failed to fetch URL.',
			},
		]);
	});

	it('aborts after 15 seconds and publishes the exact timeout terminal', async () => {
		vi.useFakeTimers();
		let capturedSignal: AbortSignal | undefined;
		const fetchUrl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			capturedSignal = init?.signal ?? undefined;
			capturedSignal?.addEventListener('abort', () => {
				reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
			});
		}));
		const { handler, postMessage } = createHandler(fetchUrl);
		const request = handler.handleMessage(fetchMessage('https://example.com/slow'))!;

		await vi.advanceTimersByTimeAsync(15_000);
		await request;

		expect(capturedSignal?.aborted).toBe(true);
		expect(postMessage).toHaveBeenCalledWith({
			type: 'urlError', boxId: 'url-section', requestId: 'url-request',
			requestedUrl: 'https://example.com/slow', error: 'Timed out after 15s.',
		});
	});

	it('preserves the timeout terminal for a native AbortError DOMException', async () => {
		const fetchUrl = vi.fn().mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'));
		const { handler, postMessage } = createHandler(fetchUrl);

		await handler.handleMessage(fetchMessage('https://example.com/aborted'));

		expect(postMessage).toHaveBeenCalledWith({
			type: 'urlError', boxId: 'url-section', requestId: 'url-request',
			requestedUrl: 'https://example.com/aborted', error: 'Timed out after 15s.',
		});
	});

	it('aborts active work on disposal and suppresses late content or error publication', async () => {
		let capturedSignal: AbortSignal | undefined;
		let resolveFetch!: (response: Response) => void;
		const fetchUrl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>(resolve => {
			capturedSignal = init?.signal ?? undefined;
			resolveFetch = resolve;
		}));
		const { handler, postMessage } = createHandler(fetchUrl);
		const request = handler.handleMessage(fetchMessage('https://example.com/dispose'))!;
		await Promise.resolve();

		handler.dispose();
		resolveFetch(createResponse('late', {
			status: 200, contentType: 'text/plain', url: 'https://example.com/dispose',
		}));
		await request;

		expect(capturedSignal?.aborted).toBe(true);
		expect(postMessage).not.toHaveBeenCalled();
		await handler.handleMessage(fetchMessage('https://example.com/after-dispose'));
		expect(fetchUrl).toHaveBeenCalledOnce();
	});

	it('suppresses the abort rejection raised by disposal', async () => {
		const fetchUrl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => {
				reject(Object.assign(new Error('aborted by disposal'), { name: 'AbortError' }));
			});
		}));
		const { handler, postMessage } = createHandler(fetchUrl);
		const request = handler.handleMessage(fetchMessage('https://example.com/dispose-rejection'))!;
		await Promise.resolve();

		handler.dispose();
		await request;

		expect(postMessage).not.toHaveBeenCalled();
	});
});
