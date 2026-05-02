import { beforeEach, describe, expect, it, vi } from 'vitest';
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
		tutorials: [{
			id: 'agent-start',
			title: 'Agent start',
			summary: 'Start with the agent',
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

function createServices(source: 'remote' | 'cache' | 'unavailable' = 'remote') {
	const resolvedCatalog = catalog();
	const catalogService = {
		getSettings: () => ({ catalogUrl: 'https://raw.githubusercontent.com/owner/repo/main/catalog.json', enableUpdateChecks: true, refreshIntervalHours: 24 }),
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
		getPreferences: () => [{ categoryId: 'agent', subscribed: true, channel: 'vscodeNotification', unseenCount: 1 }],
		getStoredPreference: () => ({ categoryId: 'agent', subscribed: true, channel: 'vscodeNotification', seenUpdateTokens: [] }),
		markCategorySeen: vi.fn(async () => undefined),
	};
	return { catalogService, subscriptionService };
}

describe('TutorialNotificationService', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
	});

	it('does not fetch tutorial updates on file open', async () => {
		const context = createContext();
		const { catalogService, subscriptionService } = createServices();
		const service = new TutorialNotificationService(context, catalogService as any, subscriptionService as any, vi.fn());
		(service as any).pendingPopup = { categoryId: 'agent', title: 'Agent workflow', count: 1 };

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
			'Mark Seen',
		);
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
});
