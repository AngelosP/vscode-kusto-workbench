import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
	EDITING_PREFERENCE_CONFIGURATION_KEYS,
	getEditingPreferencesData,
	migrateLegacyEditingPreferences,
	refreshEditingPreferences,
	setEditingPreferences,
} from '../../../src/host/editingPreferences.js';
import { STORAGE_KEYS } from '../../../src/host/queryEditorTypes.js';

function contextHarness() {
	const values = new Map<string, unknown>();
	return {
		values,
		context: {
			globalState: {
				get: (key: string) => values.get(key),
				update: async (key: string, value: unknown) => {
					if (value === undefined) values.delete(key);
					else values.set(key, value);
				},
			},
		} as any,
	};
}

describe('editing preferences host data', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('inherits VS Code inline suggestions until the user explicitly chooses', () => {
		vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation((section: string) => ({
			get: () => section === 'editor' ? false : undefined,
			inspect: () => undefined,
			update: vi.fn(async () => undefined),
		}) as any);
		const test = contextHarness();

		expect(getEditingPreferencesData(test.context)).toMatchObject({
			revision: 0,
			caretDocsEnabled: true,
			caretDocsEnabledUserSet: false,
			autoTriggerAutocompleteEnabled: true,
			autoTriggerAutocompleteEnabledUserSet: false,
			copilotInlineCompletionsEnabled: false,
			copilotInlineCompletionsEnabledUserSet: false,
		});
	});

	it('writes one revision after all three first-launch choices', async () => {
		const configured = new Map<string, boolean>();
		const update = vi.fn(async (key: string, value: boolean) => { configured.set(key, value); });
		vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation((section: string) => ({
			get: () => true,
			inspect: (key: string) => section === 'kustoWorkbench' ? { globalValue: configured.get(key) } : undefined,
			update,
		}) as any);
		const test = contextHarness();

		const snapshot = await setEditingPreferences(test.context, {
			caretDocsEnabled: false,
			autoTriggerAutocompleteEnabled: true,
			copilotInlineCompletionsEnabled: false,
		});

		expect(snapshot).toMatchObject({
			revision: expect.any(Number),
			caretDocsEnabled: false,
			caretDocsEnabledUserSet: true,
			autoTriggerAutocompleteEnabled: true,
			autoTriggerAutocompleteEnabledUserSet: true,
			copilotInlineCompletionsEnabled: false,
			copilotInlineCompletionsEnabledUserSet: true,
		});
		expect(Number(test.values.get(STORAGE_KEYS.editingPreferencesRevision))).toBeGreaterThan(1);
		expect(update).toHaveBeenCalledTimes(3);
	});

	it('refreshes another window from application settings with a newer revision', async () => {
		const configured = new Map<string, boolean>([
			[EDITING_PREFERENCE_CONFIGURATION_KEYS.caretDocsEnabled, false],
			[EDITING_PREFERENCE_CONFIGURATION_KEYS.autoTriggerAutocompleteEnabled, false],
			[EDITING_PREFERENCE_CONFIGURATION_KEYS.copilotInlineCompletionsEnabled, true],
		]);
		vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation((section: string) => ({
			get: () => true,
			inspect: (key: string) => section === 'kustoWorkbench' ? { globalValue: configured.get(key) } : undefined,
			update: vi.fn(async () => undefined),
		}) as any);
		const test = contextHarness();
		test.values.set(STORAGE_KEYS.caretDocsEnabled, true);
		test.values.set(STORAGE_KEYS.editingPreferencesRevision, 4);

		const message = await refreshEditingPreferences(test.context);

		expect(message).toMatchObject({
			caretDocsEnabled: false,
			autoTriggerAutocompleteEnabled: false,
			copilotInlineCompletionsEnabled: true,
			caretDocsEnabledUserSet: true,
		});
		expect(message.revision).toBeGreaterThan(4);
	});

	it('saturates the revision at the maximum safe integer', async () => {
		vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation((section: string) => ({
			get: () => section === 'editor' ? true : undefined,
			inspect: () => undefined,
			update: vi.fn(async () => undefined),
		}) as any);
		const test = contextHarness();
		test.values.set(STORAGE_KEYS.editingPreferencesRevision, Number.MAX_SAFE_INTEGER);

		const message = await refreshEditingPreferences(test.context);

		expect(message.revision).toBe(Number.MAX_SAFE_INTEGER);
		expect(test.values.get(STORAGE_KEYS.editingPreferencesRevision)).toBe(Number.MAX_SAFE_INTEGER);
	});

	it('migrates legacy values once and Reset Setting returns to defaults instead of stale state', async () => {
		const configured = new Map<string, boolean>();
		vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation((section: string) => ({
			get: (_key: string, fallback: unknown) => section === 'editor' ? true : fallback,
			inspect: (key: string) => section === 'kustoWorkbench' ? { globalValue: configured.get(key) } : undefined,
			update: async (key: string, value: boolean | undefined) => {
				if (value === undefined) configured.delete(key);
				else configured.set(key, value);
			},
		}) as any);
		const test = contextHarness();
		test.values.set(STORAGE_KEYS.autoTriggerAutocompleteEnabled, false);

		await migrateLegacyEditingPreferences(test.context);
		expect(configured.get(EDITING_PREFERENCE_CONFIGURATION_KEYS.autoTriggerAutocompleteEnabled)).toBe(false);
		expect(test.values.has(STORAGE_KEYS.autoTriggerAutocompleteEnabled)).toBe(false);

		configured.delete(EDITING_PREFERENCE_CONFIGURATION_KEYS.autoTriggerAutocompleteEnabled);
		expect(getEditingPreferencesData(test.context).autoTriggerAutocompleteEnabled).toBe(true);
	});
});