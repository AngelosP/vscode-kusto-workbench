import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { TutorialCatalog } from '../../../src/shared/tutorials/tutorialCatalog.js';
import { TutorialNotificationService } from '../../../src/host/tutorials/tutorialNotificationService.js';

const automaticCheckDateKey = 'kusto.tutorials.lastAutomaticCheckDate.v1';

function todayKey(): string {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `${now.getFullYear()}-${month}-${day}`;
}

function catalog(): TutorialCatalog {
	return {
		schemaVersion: 1,
		generatedAt: '2026-05-01T00:00:00.000Z',
		categories: [{ id: 'agent', title: 'Agent workflow' }],
		content: [{
			id: 'agent-start',
			categoryId: 'agent',
			contentUrl: 'content/agent-start.md',
			minExtensionVersion: '0.0.0',
			updateToken: 'agent-start-v1',
		}],
	};
}

function createContext(initialState: Record<string, unknown> = {}): vscode.ExtensionContext {
	const state = new Map<string, unknown>(Object.entries(initialState));
	return {
		globalState: {
			get: <T>(key: string, fallback?: T) => state.has(key) ? state.get(key) as T : fallback,
			update: vi.fn(async (key: string, value: unknown) => {
				if (value === undefined) {
					state.delete(key);
				} else {
					state.set(key, value);
				}
			}),
		},
		_state: state,
	} as any;
}

function createServices(source: 'remote' | 'cache' | 'unavailable' = 'remote', resolvedCatalog: TutorialCatalog = catalog()) {
	const catalogService = {
		getSettings: () => ({ enabled: true, catalogUrl: 'https://raw.githubusercontent.com/owner/repo/main/catalog.json', refreshIntervalHours: 24 }),
		getCatalog: vi.fn(async () => ({
			catalog: resolvedCatalog,
			validation: { catalog: resolvedCatalog, errors: [], warnings: [], incompatibleTutorialIds: [] },
			source,
			stale: false,
			lastUpdated: '2026-05-01T00:00:00.000Z',
			catalogUrl: 'https://raw.githubusercontent.com/owner/repo/main/catalog.json',
			errors: [],
			warnings: [],
		})),
	};
	const subscriptionService = {
		getSubscribedCategoryIds: () => ['agent'],
		getLastDigestAt: () => undefined,
		setLastDigestAt: vi.fn(async () => undefined),
		getPreferences: () => [{ categoryId: 'agent', subscribed: true, channel: 'vscodeNotification', notificationCadence: 'daily', unseenCount: 1 }],
		getStoredPreference: () => ({ categoryId: 'agent', subscribed: true, channel: 'vscodeNotification', notificationCadence: 'daily', seenUpdateTokens: [] }),
		markCategoryNotified: vi.fn(async () => undefined),
		markCategorySeen: vi.fn(async () => undefined),
	};
	return { catalogService, subscriptionService };
}

describe('TutorialNotificationService', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('does not fetch tutorial updates on file open', async () => {
		const context = createContext();
		const { catalogService, subscriptionService } = createServices();
		subscriptionService.getStoredPreference = () => ({ categoryId: 'agent', subscribed: true, channel: 'nextFileOpenPopup', notificationCadence: 'daily', seenUpdateTokens: [] });
		const service = new TutorialNotificationService(context, catalogService as any, subscriptionService as any, vi.fn());
		(service as any).pendingPopups = [{ categoryId: 'agent', title: 'Agent workflow', count: 1 }];

		await service.checkOnKustoFileOpen();

		expect(catalogService.getCatalog).not.toHaveBeenCalled();
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			'1 new Agent workflow tutorial update available.',
			'Open Did you know?',
			'Dismiss',
		);
	});

	it('checks for updates once per day after activation', async () => {
		const context = createContext();
		const { catalogService, subscriptionService } = createServices('remote');
		const service = new TutorialNotificationService(context, catalogService as any, subscriptionService as any, vi.fn());

		await service.checkOnActivation();
		await service.checkOnActivation();

		expect(catalogService.getCatalog).toHaveBeenCalledTimes(1);
		expect(catalogService.getCatalog).toHaveBeenCalledWith({ forceRefresh: true });
		expect(context.globalState.get(automaticCheckDateKey)).toBe(todayKey());
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			'1 new Agent workflow tutorial update available.',
			'Open Did you know?',
		);
		expect(subscriptionService.markCategorySeen).not.toHaveBeenCalled();
	});

	it('does not notify from cache during the activation check', async () => {
		const context = createContext();
		const { catalogService, subscriptionService } = createServices('cache');
		const service = new TutorialNotificationService(context, catalogService as any, subscriptionService as any, vi.fn());

		await service.checkOnActivation();

		expect(catalogService.getCatalog).toHaveBeenCalledWith({ forceRefresh: true });
		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
		expect(context.globalState.get(automaticCheckDateKey)).toBe(todayKey());
	});

	it('does not check for updates when tutorials are disabled globally', async () => {
		const context = createContext();
		const { catalogService, subscriptionService } = createServices('remote');
		catalogService.getSettings = () => ({ enabled: false, catalogUrl: 'https://raw.githubusercontent.com/owner/repo/main/catalog.json', refreshIntervalHours: 24 });
		const service = new TutorialNotificationService(context, catalogService as any, subscriptionService as any, vi.fn());

		await service.checkOnActivation();

		expect(catalogService.getCatalog).not.toHaveBeenCalled();
		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
		expect(context.globalState.get(automaticCheckDateKey)).toBeUndefined();
	});

	it('does not show a pending popup when tutorials are disabled globally', async () => {
		const context = createContext();
		const { catalogService, subscriptionService } = createServices('remote');
		catalogService.getSettings = () => ({ enabled: false, catalogUrl: 'https://raw.githubusercontent.com/owner/repo/main/catalog.json', refreshIntervalHours: 24 });
		const openViewer = vi.fn();
		const service = new TutorialNotificationService(context, catalogService as any, subscriptionService as any, openViewer);
		(service as any).pendingPopups = [{ categoryId: 'agent', title: 'Agent workflow', count: 1 }];

		await service.checkOnKustoFileOpen();

		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
		expect(openViewer).not.toHaveBeenCalled();
		expect((service as any).pendingPopups).toEqual([]);
	});

	it('does not show a stale pending popup after its category is muted', async () => {
		const context = createContext();
		const { catalogService, subscriptionService } = createServices('remote');
		subscriptionService.getSubscribedCategoryIds = () => ['charts'];
		subscriptionService.getStoredPreference = (categoryId: string) => categoryId === 'agent'
			? { categoryId: 'agent', subscribed: false, channel: 'off', notificationCadence: 'daily', muted: true, seenUpdateTokens: [] }
			: { categoryId, subscribed: true, channel: 'nextFileOpenPopup', notificationCadence: 'daily', muted: false, seenUpdateTokens: [] };
		const openViewer = vi.fn();
		const service = new TutorialNotificationService(context, catalogService as any, subscriptionService as any, openViewer);
		(service as any).pendingPopups = [{ categoryId: 'agent', title: 'Agent workflow', count: 1 }];

		await service.checkOnKustoFileOpen();

		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
		expect(openViewer).not.toHaveBeenCalled();
		expect((service as any).pendingPopups).toEqual([]);
	});

	it('clears a stale pending popup when its muted category was the only subscription', async () => {
		const context = createContext();
		const { catalogService, subscriptionService } = createServices('remote');
		subscriptionService.getSubscribedCategoryIds = () => [];
		subscriptionService.getStoredPreference = () => ({ categoryId: 'agent', subscribed: false, channel: 'off', notificationCadence: 'daily', muted: true, seenUpdateTokens: [] });
		const openViewer = vi.fn();
		const service = new TutorialNotificationService(context, catalogService as any, subscriptionService as any, openViewer);
		(service as any).pendingPopups = [{ categoryId: 'agent', title: 'Agent workflow', count: 1 }];

		await service.checkOnKustoFileOpen();

		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
		expect(openViewer).not.toHaveBeenCalled();
		expect((service as any).pendingPopups).toEqual([]);
	});

	it('honors weekly notification cadence before showing a digest', async () => {
		const context = createContext();
		const { catalogService, subscriptionService } = createServices('remote');
		subscriptionService.getPreferences = () => [{ categoryId: 'agent', subscribed: true, channel: 'vscodeNotification', notificationCadence: 'weekly', unseenCount: 1 }];
		subscriptionService.getStoredPreference = () => ({
			categoryId: 'agent',
			subscribed: true,
			channel: 'vscodeNotification',
			notificationCadence: 'weekly',
			lastNotifiedAt: new Date().toISOString(),
			seenUpdateTokens: [],
		});
		const service = new TutorialNotificationService(context, catalogService as any, subscriptionService as any, vi.fn());

		await service.checkOnActivation();

		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
		expect(subscriptionService.markCategoryNotified).not.toHaveBeenCalled();
	});

	it.each([
		['daily', 23 * 60 * 60 * 1000, false],
		['daily', 25 * 60 * 60 * 1000, true],
		['weekly', 6 * 24 * 60 * 60 * 1000, false],
		['weekly', 8 * 24 * 60 * 60 * 1000, true],
		['monthly', 29 * 24 * 60 * 60 * 1000, false],
		['monthly', 31 * 24 * 60 * 60 * 1000, true],
	] as const)('honors %s notification cadence due state', async (cadence, elapsedMs, shouldNotify) => {
		vi.useFakeTimers();
		const now = new Date('2026-06-15T12:00:00.000Z');
		vi.setSystemTime(now);
		const context = createContext();
		const { catalogService, subscriptionService } = createServices('remote');
		const lastNotifiedAt = new Date(now.getTime() - elapsedMs).toISOString();
		subscriptionService.getPreferences = () => [{ categoryId: 'agent', subscribed: true, channel: 'vscodeNotification', notificationCadence: cadence, unseenCount: 1 }];
		subscriptionService.getStoredPreference = () => ({
			categoryId: 'agent',
			subscribed: true,
			channel: 'vscodeNotification',
			notificationCadence: cadence,
			lastNotifiedAt,
			seenUpdateTokens: [],
		});
		const service = new TutorialNotificationService(context, catalogService as any, subscriptionService as any, vi.fn());

		await service.checkOnActivation();

		if (shouldNotify) {
			expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
				'1 new Agent workflow tutorial update available.',
				'Open Did you know?',
			);
			expect(subscriptionService.markCategoryNotified).toHaveBeenCalledWith('agent');
		} else {
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
			expect(subscriptionService.markCategoryNotified).not.toHaveBeenCalled();
		}
	});

	it('queues multiple popup categories and marks them notified only after file-open delivery', async () => {
		const context = createContext();
		const multiCategoryCatalog: TutorialCatalog = {
			schemaVersion: 1,
			generatedAt: '2026-05-01T00:00:00.000Z',
			categories: [
				{ id: 'agent', title: 'Agent workflow' },
				{ id: 'charts', title: 'Charts' },
			],
			content: [
				{
					id: 'agent-start',
					categoryId: 'agent',
					contentUrl: 'content/agent-start.md',
					minExtensionVersion: '0.0.0',
					updateToken: 'agent-start-v1',
				},
				{
					id: 'chart-start',
					categoryId: 'charts',
					contentUrl: 'content/chart-start.md',
					minExtensionVersion: '0.0.0',
					updateToken: 'chart-start-v1',
				},
			],
		};
		const { catalogService, subscriptionService } = createServices('remote', multiCategoryCatalog);
		subscriptionService.getSubscribedCategoryIds = () => ['agent', 'charts'];
		subscriptionService.getPreferences = () => [
			{ categoryId: 'agent', subscribed: true, channel: 'nextFileOpenPopup', notificationCadence: 'daily', unseenCount: 1 },
			{ categoryId: 'charts', subscribed: true, channel: 'nextFileOpenPopup', notificationCadence: 'daily', unseenCount: 1 },
		];
		subscriptionService.getStoredPreference = (categoryId: string) => ({
			categoryId,
			subscribed: true,
			channel: 'nextFileOpenPopup',
			notificationCadence: 'daily',
			seenUpdateTokens: [],
		});
		const openViewer = vi.fn();
		const service = new TutorialNotificationService(context, catalogService as any, subscriptionService as any, openViewer);

		await service.checkOnActivation();

		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
		expect(subscriptionService.markCategoryNotified).not.toHaveBeenCalled();
		expect((service as any).pendingPopups).toEqual([
			{ categoryId: 'agent', title: 'Agent workflow', count: 1 },
			{ categoryId: 'charts', title: 'Charts', count: 1 },
		]);
		expect(subscriptionService.setLastDigestAt).toHaveBeenCalledOnce();

		await service.checkOnKustoFileOpen();

		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			'2 new tutorial updates available across 2 categories.',
			'Open Did you know?',
			'Dismiss',
		);
		expect(subscriptionService.markCategoryNotified).toHaveBeenCalledTimes(2);
		expect(subscriptionService.markCategoryNotified).toHaveBeenCalledWith('agent', expect.any(String));
		expect(subscriptionService.markCategoryNotified).toHaveBeenCalledWith('charts', expect.any(String));
		expect((service as any).pendingPopups).toEqual([]);
	});

	it('keeps cadence and delivery decisions scoped per category', async () => {
		vi.useFakeTimers();
		const now = new Date('2026-06-15T12:00:00.000Z');
		vi.setSystemTime(now);
		const context = createContext();
		const multiCategoryCatalog: TutorialCatalog = {
			schemaVersion: 1,
			generatedAt: '2026-05-01T00:00:00.000Z',
			categories: [
				{ id: 'agent', title: 'Agent workflow' },
				{ id: 'charts', title: 'Charts' },
			],
			content: [
				{
					id: 'agent-start',
					categoryId: 'agent',
					contentUrl: 'content/agent-start.md',
					minExtensionVersion: '0.0.0',
					updateToken: 'agent-start-v1',
				},
				{
					id: 'chart-start',
					categoryId: 'charts',
					contentUrl: 'content/chart-start.md',
					minExtensionVersion: '0.0.0',
					updateToken: 'chart-start-v1',
				},
			],
		};
		const { catalogService, subscriptionService } = createServices('remote', multiCategoryCatalog);
		subscriptionService.getSubscribedCategoryIds = () => ['agent', 'charts'];
		subscriptionService.getPreferences = () => [
			{ categoryId: 'agent', subscribed: true, channel: 'vscodeNotification', notificationCadence: 'daily', unseenCount: 1 },
			{ categoryId: 'charts', subscribed: true, channel: 'nextFileOpenPopup', notificationCadence: 'monthly', unseenCount: 1 },
		];
		subscriptionService.getStoredPreference = (categoryId: string) => ({
			categoryId,
			subscribed: true,
			channel: categoryId === 'agent' ? 'vscodeNotification' : 'nextFileOpenPopup',
			notificationCadence: categoryId === 'agent' ? 'daily' : 'monthly',
			lastNotifiedAt: categoryId === 'agent'
				? new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString()
				: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
			seenUpdateTokens: [],
		});
		const service = new TutorialNotificationService(context, catalogService as any, subscriptionService as any, vi.fn());

		await service.checkOnActivation();

		expect(vscode.window.showInformationMessage).toHaveBeenCalledOnce();
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			'1 new Agent workflow tutorial update available.',
			'Open Did you know?',
		);
		expect(subscriptionService.markCategoryNotified).toHaveBeenCalledOnce();
		expect(subscriptionService.markCategoryNotified).toHaveBeenCalledWith('agent');
		expect(subscriptionService.setLastDigestAt).toHaveBeenCalledOnce();

		vi.mocked(vscode.window.showInformationMessage).mockClear();
		await service.checkOnKustoFileOpen();

		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
	});
});
