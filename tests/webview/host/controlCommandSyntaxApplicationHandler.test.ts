import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	HostControlCommandSyntaxApplicationHandler,
	type ControlCommandSyntaxApplicationHandlerOptions,
} from '../../../src/host/controlCommandSyntaxApplicationHandler';

const DAY_MS = 24 * 60 * 60 * 1000;
const liveHandlers = new Set<HostControlCommandSyntaxApplicationHandler>();

function createHandler(
	fetchLearn: ReturnType<typeof vi.fn>,
	options: Omit<ControlCommandSyntaxApplicationHandlerOptions, 'postMessage' | 'fetchLearn'> = {},
) {
	const postMessage = vi.fn(() => Promise.resolve(true));
	const handler = new HostControlCommandSyntaxApplicationHandler({
		postMessage,
		fetchLearn: fetchLearn as typeof fetch,
		...options,
	});
	liveHandlers.add(handler);
	return { handler, postMessage };
}

function syntaxMessage(
	requestId = 'syntax-request',
	commandLower = '.show tables',
	href = '/en-us/kusto/management/show-tables-command?source=docs',
) {
	return { type: 'fetchControlCommandSyntax' as const, requestId, commandLower, href };
}

describe('HostControlCommandSyntaxApplicationHandler', () => {
	afterEach(() => {
		for (const handler of liveHandlers) handler.dispose();
		liveHandlers.clear();
	});

	it('declines unrelated Kusto and SQL messages synchronously', () => {
		const fetchLearn = vi.fn();
		const { handler, postMessage } = createHandler(fetchLearn);

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(fetchLearn).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('claims malformed recognized requests without fetching or publishing', async () => {
		const fetchLearn = vi.fn();
		const { handler, postMessage } = createHandler(fetchLearn);

		await handler.handleMessage(syntaxMessage('', '.SHOW TABLES', ''));
		await handler.handleMessage({
			type: 'fetchControlCommandSyntax', requestId: 'request-1', commandLower: 42, href: '/docs',
		} as unknown as Parameters<typeof handler.handleMessage>[0]);

		expect(fetchLearn).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('preserves exact validated request and command identity', async () => {
		const fetchLearn = vi.fn(async () => new Response('<h2>Syntax</h2><pre>.show tables</pre>', { status: 200 }));
		const { handler, postMessage } = createHandler(fetchLearn);

		await handler.handleMessage(syntaxMessage(' request-1 ', '.SHOW TABLES'));

		expect(postMessage).toHaveBeenCalledWith({
			type: 'controlCommandSyntaxResult', requestId: ' request-1 ', commandLower: '.SHOW TABLES',
			ok: true, syntax: '.show tables', withArgs: [],
		});
	});

	it('normalizes the Microsoft Learn URL and extracts syntax entities and with arguments', async () => {
		const html = [
			'<pre><code>.fallback ignored</code></pre>',
			'<h2> Syntax </h2>',
			'<p>Details</p>',
			'<pre><code>\r\n.show table &lt;TableName&gt; with (HotCache = true, maxRows=10, HOTCACHE = false)&amp; more\r\n</code></pre>',
		].join('');
		const fetchLearn = vi.fn(async () => new Response(html, { status: 200 }));
		const { handler, postMessage } = createHandler(fetchLearn);

		await handler.handleMessage(syntaxMessage());

		expect(fetchLearn).toHaveBeenCalledOnce();
		expect(fetchLearn).toHaveBeenCalledWith(
			'https://learn.microsoft.com/en-us/kusto/management/show-tables-command?source=docs&view=azure-data-explorer',
			{ method: 'GET' },
		);
		expect(postMessage).toHaveBeenCalledWith({
			type: 'controlCommandSyntaxResult', requestId: 'syntax-request', commandLower: '.show tables',
			ok: true,
			syntax: '.show table <TableName> with (HotCache = true, maxRows=10, HOTCACHE = false)& more',
			withArgs: ['HotCache', 'maxRows'],
		});
	});

	it('preserves absolute Learn URLs while replacing an existing view parameter', async () => {
		const fetchLearn = vi.fn(async () => new Response('<h2>Syntax</h2><pre>.show tables</pre>', { status: 200 }));
		const { handler } = createHandler(fetchLearn);

		await handler.handleMessage(syntaxMessage(
			'syntax-request',
			'.show tables',
			'https://learn.microsoft.com/en-us/kusto/management/show-tables-command?view=old&source=docs',
		));

		expect(fetchLearn).toHaveBeenCalledWith(
			'https://learn.microsoft.com/en-us/kusto/management/show-tables-command?view=azure-data-explorer&source=docs',
			{ method: 'GET' },
		);
	});

	it('falls back to the first pre block when no Syntax section exists', async () => {
		const fetchLearn = vi.fn(async () => new Response(
			'<h1>Command</h1><pre><span>.show version&nbsp;&quot;full&quot;&#39;x&#x27;</span></pre>',
			{ status: 200 },
		));
		const { handler, postMessage } = createHandler(fetchLearn);

		await handler.handleMessage(syntaxMessage());

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			ok: true, syntax: '.show version "full"\'x\'', withArgs: [],
		}));
	});

	it('uses the 24-hour cache and refetches at the exact expiry boundary', async () => {
		let now = 1_000;
		const fetchLearn = vi.fn()
			.mockResolvedValueOnce(new Response('<h2>Syntax</h2><pre>.show tables</pre>', { status: 200 }))
			.mockResolvedValueOnce(new Response('<h2>Syntax</h2><pre>.show tables details</pre>', { status: 200 }));
		const { handler, postMessage } = createHandler(fetchLearn, { now: () => now });

		await handler.handleMessage(syntaxMessage('request-1'));
		now += DAY_MS - 1;
		await handler.handleMessage(syntaxMessage('request-2'));
		now += 1;
		await handler.handleMessage(syntaxMessage('request-3'));

		expect(fetchLearn).toHaveBeenCalledTimes(2);
		expect(postMessage.mock.calls.map(call => call[0])).toEqual([
			{
				type: 'controlCommandSyntaxResult', requestId: 'request-1', commandLower: '.show tables',
				ok: true, syntax: '.show tables', withArgs: [],
			},
			{
				type: 'controlCommandSyntaxResult', requestId: 'request-2', commandLower: '.show tables',
				ok: true, syntax: '.show tables', withArgs: [],
			},
			{
				type: 'controlCommandSyntaxResult', requestId: 'request-3', commandLower: '.show tables',
				ok: true, syntax: '.show tables details', withArgs: [],
			},
		]);
	});

	it('preserves HTTP and fetch failure shaping, including cached failure behavior', async () => {
		let now = 5_000;
		const fetchLearn = vi.fn()
			.mockResolvedValueOnce(new Response('missing', { status: 404 }))
			.mockRejectedValueOnce(new Error('socket closed'));
		const { handler, postMessage } = createHandler(fetchLearn, { now: () => now });

		await handler.handleMessage(syntaxMessage('request-1'));
		await handler.handleMessage(syntaxMessage('request-2'));
		now += DAY_MS;
		await handler.handleMessage(syntaxMessage('request-3'));

		expect(fetchLearn).toHaveBeenCalledTimes(2);
		expect(postMessage.mock.calls.map(call => call[0])).toEqual([
			{
				type: 'controlCommandSyntaxResult', requestId: 'request-1', commandLower: '.show tables',
				ok: false, syntax: '', withArgs: [],
			},
			{
				type: 'controlCommandSyntaxResult', requestId: 'request-2', commandLower: '.show tables',
				ok: true, syntax: '', withArgs: [],
			},
			{
				type: 'controlCommandSyntaxResult', requestId: 'request-3', commandLower: '.show tables',
				ok: false, syntax: '', withArgs: [],
			},
		]);
	});

	it('suppresses late fetch completion after disposal and declines later work', async () => {
		let resolveFetch!: (response: Response) => void;
		const fetchLearn = vi.fn(() => new Promise<Response>(resolve => {
			resolveFetch = resolve;
		}));
		const { handler, postMessage } = createHandler(fetchLearn);
		const request = handler.handleMessage(syntaxMessage())!;
		await Promise.resolve();

		handler.dispose();
		resolveFetch(new Response('<h2>Syntax</h2><pre>.show tables</pre>', { status: 200 }));
		await request;
		await handler.handleMessage(syntaxMessage('after-dispose'));

		expect(fetchLearn).toHaveBeenCalledOnce();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('suppresses a late fetch rejection after disposal', async () => {
		let rejectFetch!: (error: Error) => void;
		const fetchLearn = vi.fn(() => new Promise<Response>((_resolve, reject) => {
			rejectFetch = reject;
		}));
		const { handler, postMessage } = createHandler(fetchLearn);
		const request = handler.handleMessage(syntaxMessage())!;
		await Promise.resolve();

		handler.dispose();
		rejectFetch(new Error('late failure'));
		await request;

		expect(postMessage).not.toHaveBeenCalled();
	});

	it.each(['resolve', 'reject'] as const)(
		'suppresses late response text %s after disposal',
		async outcome => {
			let resolveText!: (html: string) => void;
			let rejectText!: (error: Error) => void;
			const text = vi.fn(() => new Promise<string>((resolve, reject) => {
				resolveText = resolve;
				rejectText = reject;
			}));
			const fetchLearn = vi.fn(async () => ({ ok: true, status: 200, text }) as unknown as Response);
			const { handler, postMessage } = createHandler(fetchLearn);
			const request = handler.handleMessage(syntaxMessage())!;
			await Promise.resolve();
			await Promise.resolve();
			expect(text).toHaveBeenCalledOnce();

			handler.dispose();
			if (outcome === 'resolve') {
				resolveText('<h2>Syntax</h2><pre>.show tables</pre>');
			} else {
				rejectText(new Error('late text failure'));
			}
			await request;

			expect(postMessage).not.toHaveBeenCalled();
		},
	);
});