import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { TutorialCatalog } from '../../../src/shared/tutorials/tutorialCatalog.js';
import { TutorialSubscriptionService } from '../../../src/host/tutorials/tutorialSubscriptionService.js';

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

describe('TutorialSubscriptionService', () => {
	it('restores the previous active delivery channel when unmuting a category', async () => {
		const service = new TutorialSubscriptionService(createContext());

		await service.setChannel('agent', 'vscodeNotification');
		await service.setMuted('agent', true);

		expect(service.getPreferences(catalog())).toMatchObject([{
			categoryId: 'agent',
			subscribed: false,
			channel: 'off',
			muted: true,
		}]);

		await service.setMuted('agent', false);

		expect(service.getPreferences(catalog())).toMatchObject([{
			categoryId: 'agent',
			subscribed: true,
			channel: 'vscodeNotification',
			muted: false,
		}]);
	});

	it('keeps unsubscribe distinct from mute while preserving the previous delivery channel', async () => {
		const service = new TutorialSubscriptionService(createContext());

		await service.setChannel('agent', 'vscodeNotification');
		await service.setSubscription('agent', false);

		expect(service.getPreferences(catalog())).toMatchObject([{
			categoryId: 'agent',
			subscribed: false,
			channel: 'off',
			muted: false,
		}]);

		await service.setSubscription('agent', true);

		expect(service.getPreferences(catalog())).toMatchObject([{
			categoryId: 'agent',
			subscribed: true,
			channel: 'vscodeNotification',
			muted: false,
		}]);
	});
});