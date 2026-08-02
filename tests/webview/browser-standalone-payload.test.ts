import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('browser standalone viewer payload routing', () => {
	it('consumes concurrent payloads by unguessable request token in reverse order', () => {
		const listeners: Array<(message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean> = [];
		const createdUrls: string[] = [];
		const tokens = ['token-a', 'token-b'];
		const chrome = {
			runtime: {
				onMessage: { addListener: vi.fn((listener) => listeners.push(listener)) },
				getURL: vi.fn((path: string) => `chrome-extension://extension/${path}`),
			},
			tabs: { create: vi.fn(({ url }: { url: string }) => createdUrls.push(url)) },
		};
		runInNewContext(
			readFileSync('browser-ext/background.js', 'utf8'),
			{ chrome, crypto: { randomUUID: vi.fn(() => tokens.shift()) }, Map, Date, console },
		);
		const send = (message: unknown) => {
			let response: any;
			listeners[0](message, {}, value => { response = value; });
			return response;
		};

		send({ type: 'open-viewer-tab', payload: { filename: 'a.kql', content: 'A' } });
		send({ type: 'open-viewer-tab', payload: { filename: 'b.kql', content: 'B' } });
		expect(createdUrls).toEqual([
			'chrome-extension://extension/viewer-standalone.html?request=token-a',
			'chrome-extension://extension/viewer-standalone.html?request=token-b',
		]);
		expect(send({ type: 'get-pending-viewer-content', requestToken: 'token-b' })).toEqual({
			payload: { filename: 'b.kql', content: 'B' },
		});
		expect(send({ type: 'get-pending-viewer-content', requestToken: 'token-a' })).toEqual({
			payload: { filename: 'a.kql', content: 'A' },
		});
		expect(send({ type: 'get-pending-viewer-content', requestToken: 'token-a' })).toEqual({ payload: null });
	});

	it('requests only the token assigned to the standalone viewer URL', () => {
		const messages: unknown[] = [];
		const iframe = {
			contentWindow: { postMessage: vi.fn() },
			addEventListener: vi.fn(),
		};
		const windowObject = {
			location: { href: 'chrome-extension://extension/viewer-standalone.html?request=token-b' },
			addEventListener: vi.fn(),
		};
		runInNewContext(
			readFileSync('browser-ext/viewer-standalone-boot.js', 'utf8'),
			{
				window: windowObject,
				document: { getElementById: vi.fn(() => iframe) },
				chrome: {
					runtime: {
						lastError: undefined,
						sendMessage: vi.fn((message: unknown, callback: (response: unknown) => void) => {
							messages.push(message);
							callback({ payload: null });
						}),
					},
				},
				URL,
				console,
				setInterval: vi.fn(() => 1),
				clearInterval: vi.fn(),
				setTimeout: vi.fn(),
			},
		);

		expect(messages).toEqual([{ type: 'get-pending-viewer-content', requestToken: 'token-b' }]);
	});
});