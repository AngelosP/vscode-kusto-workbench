import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmbeddedTutorialWebviewHost, EmbeddedTutorialWebviewRegistry } from '../../../src/host/tutorials/embeddedTutorialWebviewHost';

afterEach(() => {
	vi.useRealTimers();
});

describe('EmbeddedTutorialWebviewHost transport', () => {
	it('retries until the embedded overlay acknowledges the matching show request', async () => {
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
		const show = host.show({
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
		await vi.advanceTimersByTimeAsync(600);

		const showMessages = transport.mock.calls
			.map(([message]) => message)
			.filter(message => message.type === 'showEmbeddedTutorialViewer');
		expect(showMessages.length).toBeGreaterThan(3);
		const requestId = showMessages[0].requestId;
		expect(requestId).toEqual(expect.any(String));
		expect(showMessages.every(message => message.requestId === requestId)).toBe(true);
		expect(host.handleMessage({ type: 'embeddedTutorialViewerShown', requestId: 'stale-request' })).toBe(true);
		expect(host.handleMessage({ type: 'requestSnapshot' })).toBe(true);
		expect(transport.mock.calls.some(([message]) => message.type === 'snapshot')).toBe(false);

		expect(host.handleMessage({ type: 'embeddedTutorialViewerShown', requestId })).toBe(true);
		await expect(show).resolves.toBe(true);

		expect(transport.mock.calls.at(-1)?.[0].type).toBe('snapshot');
		expect(directPostMessage).not.toHaveBeenCalled();
	});

	it('settles a pending show as unavailable when disposed', async () => {
		vi.useFakeTimers();
		const transport = vi.fn(async () => true);
		const panel = {
			visible: true,
			webview: { options: {}, postMessage: vi.fn(async () => true) },
		} as any;
		const catalog = { version: 1, categories: [], content: [] };
		const host = new EmbeddedTutorialWebviewHost(panel, 'file:///startup.kqlx', transport);
		const show = host.show({
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

		host.dispose();
		await expect(show).resolves.toBe(false);
		await vi.advanceTimersByTimeAsync(1000);
		expect(transport.mock.calls.filter(([message]) => message.type === 'showEmbeddedTutorialViewer')).toHaveLength(1);
		expect(transport.mock.calls.some(([message]) => message.type === 'snapshot')).toBe(false);
	});

	it('returns false when the acknowledged snapshot transport fails', async () => {
		let host!: EmbeddedTutorialWebviewHost;
		const transport = vi.fn(async (message: any) => {
			if (message.type === 'showEmbeddedTutorialViewer') {
				queueMicrotask(() => host.handleMessage({
					type: 'embeddedTutorialViewerShown', requestId: message.requestId,
				}));
			}
			return message.type !== 'snapshot';
		});
		const panel = {
			visible: true,
			webview: { options: {}, postMessage: vi.fn(async () => true) },
		} as any;
		const catalog = { version: 1, categories: [], content: [] };
		host = new EmbeddedTutorialWebviewHost(panel, 'file:///startup.kqlx', transport);

		await expect(host.show({
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
		}, {})).resolves.toBe(false);
		expect(transport.mock.calls.at(-1)?.[0]).toEqual({
			type: 'hideEmbeddedTutorialViewer', requestId: 'embedded-tutorial-1',
		});
	});

	it('allows only the newest overlapping show to publish a snapshot', async () => {
		const firstCatalog = Promise.withResolvers<{ catalog: any; status: any }>();
		const catalog = { version: 1, categories: [], content: [] };
		const getViewerCatalog = vi.fn()
			.mockImplementationOnce(() => firstCatalog.promise)
			.mockResolvedValue({ catalog, status: {} });
		const transport = vi.fn(async () => true);
		const panel = {
			visible: true,
			webview: { options: {}, postMessage: vi.fn(async () => true) },
		} as any;
		const host = new EmbeddedTutorialWebviewHost(panel, 'file:///startup.kqlx', transport);
		const services = {
			context: {} as any,
			catalogService: {
				getCacheRoot: () => ({ toString: () => 'file:///tutorial-cache' }),
				getViewerCatalog,
				getCatalog: async () => ({ catalog }),
				getSettings: () => ({ enabled: true }),
			} as any,
			subscriptionService: {
				getUnseenTutorialIds: () => new Set<string>(),
				getPreferences: () => ({}),
				getSubscribedCategoryIds: () => [],
			} as any,
		};

		const first = host.show(services, { selectedCategoryId: 'first' });
		let showMessages = transport.mock.calls.map(([message]) => message).filter(message => message.type === 'showEmbeddedTutorialViewer');
		host.handleMessage({ type: 'embeddedTutorialViewerShown', requestId: showMessages.at(-1).requestId });
		await vi.waitFor(() => expect(getViewerCatalog).toHaveBeenCalledTimes(1));

		const second = host.show(services, { selectedCategoryId: 'second' });
		showMessages = transport.mock.calls.map(([message]) => message).filter(message => message.type === 'showEmbeddedTutorialViewer');
		host.handleMessage({ type: 'embeddedTutorialViewerShown', requestId: showMessages.at(-1).requestId });
		await expect(second).resolves.toBe(true);
		firstCatalog.resolve({ catalog, status: {} });
		await expect(first).resolves.toBe(false);

		const snapshots = transport.mock.calls.map(([message]) => message).filter(message => message.type === 'snapshot');
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0].snapshot.selectedCategoryId).toBe('second');
	});

	it('returns false when disposed after acknowledgement during snapshot loading', async () => {
		const pendingCatalog = Promise.withResolvers<{ catalog: any; status: any }>();
		const catalog = { version: 1, categories: [], content: [] };
		const transport = vi.fn(async () => true);
		const panel = {
			visible: true,
			webview: { options: {}, postMessage: vi.fn(async () => true) },
		} as any;
		const host = new EmbeddedTutorialWebviewHost(panel, 'file:///startup.kqlx', transport);
		const show = host.show({
			context: {} as any,
			catalogService: {
				getCacheRoot: () => ({ toString: () => 'file:///tutorial-cache' }),
				getViewerCatalog: () => pendingCatalog.promise,
				getCatalog: async () => ({ catalog }),
				getSettings: () => ({ enabled: true }),
			} as any,
			subscriptionService: {
				getUnseenTutorialIds: () => new Set<string>(),
				getPreferences: () => ({}),
				getSubscribedCategoryIds: () => [],
			} as any,
		}, {});
		const requestId = transport.mock.calls.find(([message]) => message.type === 'showEmbeddedTutorialViewer')?.[0].requestId;
		host.handleMessage({ type: 'embeddedTutorialViewerShown', requestId });
		host.dispose();
		pendingCatalog.resolve({ catalog, status: {} });

		await expect(show).resolves.toBe(false);
		expect(transport.mock.calls.some(([message]) => message.type === 'snapshot')).toBe(false);
	});

	it('does not let deferred failed cleanup dispose a newer show session', async () => {
		const deferredHide = Promise.withResolvers<boolean>();
		let host!: EmbeddedTutorialWebviewHost;
		let snapshotCount = 0;
		const transport = vi.fn(async (message: any) => {
			if (message.type === 'showEmbeddedTutorialViewer') {
				queueMicrotask(() => host.handleMessage({
					type: 'embeddedTutorialViewerShown', requestId: message.requestId,
				}));
				return true;
			}
			if (message.type === 'snapshot') {
				snapshotCount++;
				return snapshotCount !== 1;
			}
			if (message.type === 'hideEmbeddedTutorialViewer') return deferredHide.promise;
			return true;
		});
		const panel = {
			visible: true,
			webview: { options: {}, postMessage: vi.fn(async () => true) },
		} as any;
		const catalog = { version: 1, categories: [], content: [] };
		const services = {
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
		};
		host = new EmbeddedTutorialWebviewHost(panel, 'file:///startup.kqlx', transport);

		const first = host.show(services, { selectedCategoryId: 'first' });
		await vi.waitFor(() => expect(
			transport.mock.calls.some(([message]) => message.type === 'hideEmbeddedTutorialViewer'),
		).toBe(true));
		const second = host.show(services, { selectedCategoryId: 'second' });
		await expect(second).resolves.toBe(true);
		deferredHide.resolve(true);
		await expect(first).resolves.toBe(false);

		const snapshots = transport.mock.calls.map(([message]) => message).filter(message => message.type === 'snapshot');
		expect(snapshots).toHaveLength(2);
		expect(snapshots[1].snapshot.selectedCategoryId).toBe('second');
	});

	it('returns false when dismissed after acknowledgement during snapshot loading', async () => {
		const pendingCatalog = Promise.withResolvers<{ catalog: any; status: any }>();
		const catalog = { version: 1, categories: [], content: [] };
		const transport = vi.fn(async () => true);
		const panel = {
			visible: true,
			webview: { options: {}, postMessage: vi.fn(async () => true) },
		} as any;
		const host = new EmbeddedTutorialWebviewHost(panel, 'file:///startup.kqlx', transport);
		const show = host.show({
			context: {} as any,
			catalogService: {
				getCacheRoot: () => ({ toString: () => 'file:///tutorial-cache' }),
				getViewerCatalog: () => pendingCatalog.promise,
				getCatalog: async () => ({ catalog }),
				getSettings: () => ({ enabled: true }),
			} as any,
			subscriptionService: {
				getUnseenTutorialIds: () => new Set<string>(),
				getPreferences: () => ({}),
				getSubscribedCategoryIds: () => [],
			} as any,
		}, {});
		const requestId = transport.mock.calls.find(([message]) => message.type === 'showEmbeddedTutorialViewer')?.[0].requestId;
		host.handleMessage({ type: 'embeddedTutorialViewerShown', requestId });
		expect(host.handleMessage({ type: 'dismiss' })).toBe(true);
		await vi.waitFor(() => expect(
			transport.mock.calls.some(([message]) => message.type === 'hideEmbeddedTutorialViewer'),
		).toBe(true));
		pendingCatalog.resolve({ catalog, status: {} });

		await expect(show).resolves.toBe(false);
		expect(transport.mock.calls.some(([message]) => message.type === 'snapshot')).toBe(false);
	});

	it('times out and ignores a late acknowledgement', async () => {
		vi.useFakeTimers();
		const transport = vi.fn(async () => true);
		const panel = {
			visible: true,
			webview: { options: {}, postMessage: vi.fn(async () => true) },
		} as any;
		const catalog = { version: 1, categories: [], content: [] };
		const host = new EmbeddedTutorialWebviewHost(panel, 'file:///startup.kqlx', transport);
		const show = host.show({
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
		const requestId = transport.mock.calls[0][0].requestId;
		await vi.advanceTimersByTimeAsync(10_001);
		await expect(show).resolves.toBe(false);
		host.handleMessage({ type: 'embeddedTutorialViewerShown', requestId });
		expect(transport.mock.calls.some(([message]) => message.type === 'snapshot')).toBe(false);
		expect(transport.mock.calls.some(([message]) => message.type === 'hideEmbeddedTutorialViewer')).toBe(true);
	});

	it('queues cleanup behind a show transport that resolves after timeout', async () => {
		vi.useFakeTimers();
		const firstDelivery = Promise.withResolvers<boolean>();
		const transport = vi.fn()
			.mockImplementationOnce(() => firstDelivery.promise)
			.mockResolvedValue(true);
		const panel = {
			visible: true,
			webview: { options: {}, postMessage: vi.fn(async () => true) },
		} as any;
		const catalog = { version: 1, categories: [], content: [] };
		const host = new EmbeddedTutorialWebviewHost(panel, 'file:///startup.kqlx', transport);
		const show = host.show({
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

		await vi.advanceTimersByTimeAsync(10_001);
		firstDelivery.resolve(true);
		await expect(show).resolves.toBe(false);
		await vi.waitFor(() => expect(
			transport.mock.calls.some(([message]) => message.type === 'hideEmbeddedTutorialViewer'),
		).toBe(true));
		expect(transport.mock.calls.some(([message]) => message.type === 'snapshot')).toBe(false);
	});

	it('propagates an unavailable host show through the document registry', async () => {
		const host = new EmbeddedTutorialWebviewHost({ visible: true, webview: { options: {} } } as any, 'file:///startup.kqlx');
		const show = vi.spyOn(host, 'show').mockResolvedValue(false);
		const registration = EmbeddedTutorialWebviewRegistry.register(host);
		try {
			await expect(EmbeddedTutorialWebviewRegistry.showForDocument(
				'file:///startup.kqlx', {} as any, {},
			)).resolves.toBe(false);
			expect(show).toHaveBeenCalledOnce();
		} finally {
			registration.dispose();
		}
	});
});