import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { TutorialCatalog } from '../../../src/shared/tutorials/tutorialCatalog.js';
import { resetDidYouKnowDevelopmentState } from '../../../src/host/tutorials/tutorialDevelopmentState.js';
import { AUTOMATIC_CHECK_DATE_KEY, PENDING_POPUPS_KEY } from '../../../src/host/tutorials/tutorialNotificationService.js';
import { SUBSCRIPTION_STATE_KEY } from '../../../src/host/tutorials/tutorialSubscriptionService.js';

const legacyPendingPopupKey = 'kusto.tutorials.pendingPopup.v1';

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

function catalog(): TutorialCatalog {
	return {
		schemaVersion: 1,
		generatedAt: '2026-05-01T00:00:00.000Z',
		categories: [
			{ id: 'agent', title: 'Agent workflow' },
			{ id: 'charts', title: 'Charts' },
			{ id: 'empty', title: 'Empty category' },
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
				id: 'agent-refine',
				categoryId: 'agent',
				contentUrl: 'content/agent-refine.md',
				minExtensionVersion: '0.0.0',
				updateToken: 'agent-refine-v1',
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
}

describe('resetDidYouKnowDevelopmentState', () => {
	it('subscribes all categories to file-open popups and clears seen/check state', async () => {
		const context = createContext({
			[AUTOMATIC_CHECK_DATE_KEY]: '2026-05-04',
			[PENDING_POPUPS_KEY]: [{ categoryId: 'old', title: 'Old', count: 1 }],
			[legacyPendingPopupKey]: { categoryId: 'old', title: 'Old', count: 1 },
			[SUBSCRIPTION_STATE_KEY]: { categories: [{ categoryId: 'agent', subscribed: false, channel: 'off', seenUpdateTokens: ['old-token'] }] },
		});
		const resolvedCatalog = catalog();
		const catalogService = {
			getCatalog: vi.fn(async () => ({
				catalog: resolvedCatalog,
				validation: { catalog: resolvedCatalog, errors: [], warnings: [], incompatibleTutorialIds: [] },
				source: 'localDevelopment',
				stale: false,
				lastUpdated: '2026-05-01T00:00:00.000Z',
				catalogUrl: 'file:///catalog.v1.json',
				errors: [],
				warnings: [],
			})),
		};

		const result = await resetDidYouKnowDevelopmentState(context, catalogService as any);

		expect(catalogService.getCatalog).toHaveBeenCalledWith({ forceRefresh: true });
		expect(result).toEqual({ categoryCount: 3, contentCount: 3, pendingPopupCount: 2, source: 'localDevelopment' });
		expect(context.globalState.get(SUBSCRIPTION_STATE_KEY)).toEqual({
			categories: [
				{
					categoryId: 'agent',
					subscribed: true,
					channel: 'nextFileOpenPopup',
					previousChannel: 'nextFileOpenPopup',
					notificationCadence: 'daily',
					muted: false,
					seenUpdateTokens: [],
				},
				{
					categoryId: 'charts',
					subscribed: true,
					channel: 'nextFileOpenPopup',
					previousChannel: 'nextFileOpenPopup',
					notificationCadence: 'daily',
					muted: false,
					seenUpdateTokens: [],
				},
				{
					categoryId: 'empty',
					subscribed: true,
					channel: 'nextFileOpenPopup',
					previousChannel: 'nextFileOpenPopup',
					notificationCadence: 'daily',
					muted: false,
					seenUpdateTokens: [],
				},
			],
		});
		expect(context.globalState.get(PENDING_POPUPS_KEY)).toEqual([
			{ categoryId: 'agent', title: 'Agent workflow', count: 2 },
			{ categoryId: 'charts', title: 'Charts', count: 1 },
		]);
		expect(context.globalState.get(AUTOMATIC_CHECK_DATE_KEY)).toBeUndefined();
		expect(context.globalState.get(legacyPendingPopupKey)).toBeUndefined();
	});
});