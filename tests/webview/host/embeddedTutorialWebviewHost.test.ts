import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmbeddedTutorialWebviewHost } from '../../../src/host/tutorials/embeddedTutorialWebviewHost';

afterEach(() => {
	vi.useRealTimers();
});

describe('EmbeddedTutorialWebviewHost transport', () => {
	it('uses the injected main-panel transport and cancels show retries on disposal', async () => {
		vi.useFakeTimers();
		const directPostMessage = vi.fn(async () => true);
		const transport = vi.fn(async () => true);
		const panel = {
			visible: true,
			webview: {
				options: {},
				postMessage: directPostMessage,
			},
		} as any;
		const catalog = { version: 1, categories: [], content: [] };
		const host = new EmbeddedTutorialWebviewHost(panel, 'file:///startup.kqlx', transport);
		await host.show({
			context: {} as any,
			catalogService: {
				getCacheRoot: () => ({ toString: () => 'file:///tutorial-cache' }),
				getViewerCatalog: async () => ({ catalog, status: {} }),
				getCatalog: async () => ({ catalog }),
				getSettings: () => ({ enabled: true }),
			} as any,
			subscriptionService: {
				getUnseenTutorialIds: () => new Set<string>(),
				getPreferences: () => ({}),
				getSubscribedCategoryIds: () => [],
			} as any,
		}, {});

		expect(transport.mock.calls.map(([message]) => message.type)).toEqual([
			'showEmbeddedTutorialViewer',
			'snapshot',
		]);
		expect(directPostMessage).not.toHaveBeenCalled();

		host.dispose();
		await vi.advanceTimersByTimeAsync(400);
		expect(transport).toHaveBeenCalledTimes(2);
		expect(directPostMessage).not.toHaveBeenCalled();
	});
});