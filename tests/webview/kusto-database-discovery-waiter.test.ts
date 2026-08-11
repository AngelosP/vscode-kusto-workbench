import { afterEach, describe, expect, it, vi } from 'vitest';

import { e2eIdentityRequestDatabases } from '../../src/webview/core/test-helpers.js';

describe('bundled Kusto database discovery waiter', () => {
	afterEach(() => {
		delete (window as any).vscode;
	});

	it('ignores a malformed matching delivery and resolves from the later valid delivery', async () => {
		const postMessage = vi.fn();
		(window as any).vscode = { postMessage };
		let settled = false;
		const request = e2eIdentityRequestDatabases('connection-1', 1000);
		void request.finally(() => { settled = true; });
		const outbound = postMessage.mock.calls[0]?.[0];
		expect(outbound).toEqual(expect.objectContaining({
			type: 'getDatabases', connectionId: 'connection-1', boxId: expect.any(String),
		}));

		window.dispatchEvent(new MessageEvent('message', { data: {
			type: 'databasesData', boxId: outbound.boxId, connectionId: 'connection-1',
			databases: ['MalformedDb'], authoritative: 'yes',
		} }));
		window.dispatchEvent(new MessageEvent('message', { data: {
			type: 'databasesData', boxId: outbound.boxId, connectionId: 'connection-1',
			databases: new Array<string>(1), authoritative: true,
		} }));
		await Promise.resolve();
		expect(settled).toBe(false);

		window.dispatchEvent(new MessageEvent('message', { data: {
			type: 'databasesData', boxId: outbound.boxId, connectionId: 'connection-1',
			databases: [' DbB ', '', 'DbA'], authoritative: true, fallback: false,
		} }));

		await expect(request).resolves.toEqual(['DbB', 'DbA']);
	});
});
