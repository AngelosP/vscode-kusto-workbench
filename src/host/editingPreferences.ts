import * as vscode from 'vscode';
import type { EditingPreferencesDataMessage } from '../shared/editingPreferences';
import type { FirstLaunchEditingPreferences } from '../shared/firstLaunchSetup';
import { STORAGE_KEYS } from './queryEditorTypes';

type EditingPreferenceStorageKey =
	| typeof STORAGE_KEYS.caretDocsEnabled
	| typeof STORAGE_KEYS.autoTriggerAutocompleteEnabled
	| typeof STORAGE_KEYS.copilotInlineCompletionsEnabled;

type EditingPreferencesContext = Pick<vscode.ExtensionContext, 'globalState'>;

let writeChain: Promise<unknown> = Promise.resolve();

export const EDITING_PREFERENCE_CONFIGURATION_KEYS = {
	caretDocsEnabled: 'editing.caretDocsEnabled',
	autoTriggerAutocompleteEnabled: 'editing.autoTriggerAutocompleteEnabled',
	copilotInlineCompletionsEnabled: 'editing.copilotInlineCompletionsEnabled',
} as const;

const STORAGE_TO_CONFIGURATION_KEY: Readonly<Record<EditingPreferenceStorageKey, string>> = {
	[STORAGE_KEYS.caretDocsEnabled]: EDITING_PREFERENCE_CONFIGURATION_KEYS.caretDocsEnabled,
	[STORAGE_KEYS.autoTriggerAutocompleteEnabled]: EDITING_PREFERENCE_CONFIGURATION_KEYS.autoTriggerAutocompleteEnabled,
	[STORAGE_KEYS.copilotInlineCompletionsEnabled]: EDITING_PREFERENCE_CONFIGURATION_KEYS.copilotInlineCompletionsEnabled,
};

function storedBoolean(context: EditingPreferencesContext, key: EditingPreferenceStorageKey): boolean | undefined {
	const value = context.globalState.get<boolean>(key);
	return typeof value === 'boolean' ? value : undefined;
}

function revision(context: EditingPreferencesContext): number {
	const value = context.globalState.get<number>(STORAGE_KEYS.editingPreferencesRevision);
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function configuredBoolean(key: string): boolean | undefined {
	const value = vscode.workspace.getConfiguration('kustoWorkbench').inspect<boolean>(key)?.globalValue;
	return typeof value === 'boolean' ? value : undefined;
}

export function getEditingPreferencesData(context: EditingPreferencesContext): EditingPreferencesDataMessage {
	const storedCaretDocs = storedBoolean(context, STORAGE_KEYS.caretDocsEnabled);
	const storedAutocomplete = storedBoolean(context, STORAGE_KEYS.autoTriggerAutocompleteEnabled);
	const storedCopilotInline = storedBoolean(context, STORAGE_KEYS.copilotInlineCompletionsEnabled);
	const configuredCaretDocs = configuredBoolean(EDITING_PREFERENCE_CONFIGURATION_KEYS.caretDocsEnabled);
	const configuredAutocomplete = configuredBoolean(EDITING_PREFERENCE_CONFIGURATION_KEYS.autoTriggerAutocompleteEnabled);
	const configuredCopilotInline = configuredBoolean(EDITING_PREFERENCE_CONFIGURATION_KEYS.copilotInlineCompletionsEnabled);
	const caretDocs = configuredCaretDocs ?? storedCaretDocs;
	const autocomplete = configuredAutocomplete ?? storedAutocomplete;
	const copilotInline = configuredCopilotInline ?? storedCopilotInline;
	const vscodeInlineSuggestEnabled = vscode.workspace.getConfiguration('editor').get<boolean>('inlineSuggest.enabled', true);
	return {
		type: 'editingPreferencesData',
		revision: revision(context),
		caretDocsEnabled: caretDocs ?? true,
		caretDocsEnabledUserSet: configuredCaretDocs !== undefined || storedCaretDocs !== undefined,
		autoTriggerAutocompleteEnabled: autocomplete ?? true,
		autoTriggerAutocompleteEnabledUserSet: configuredAutocomplete !== undefined || storedAutocomplete !== undefined,
		copilotInlineCompletionsEnabled: copilotInline ?? vscodeInlineSuggestEnabled,
		copilotInlineCompletionsEnabledUserSet: configuredCopilotInline !== undefined || storedCopilotInline !== undefined,
	};
}

async function bumpRevision(context: EditingPreferencesContext): Promise<void> {
	await context.globalState.update(STORAGE_KEYS.editingPreferencesRevision, Math.max(revision(context) + 1, Date.now()));
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
	const next = writeChain.then(operation, operation);
	writeChain = next.catch(() => undefined);
	return next;
}

export function setEditingPreference(
	context: EditingPreferencesContext,
	key: EditingPreferenceStorageKey,
	enabled: boolean,
): Promise<EditingPreferencesDataMessage> {
	return enqueue(async () => {
		await vscode.workspace.getConfiguration('kustoWorkbench').update(
			STORAGE_TO_CONFIGURATION_KEY[key],
			enabled,
			vscode.ConfigurationTarget.Global,
		);
		await bumpRevision(context);
		return getEditingPreferencesData(context);
	});
}

export function setEditingPreferences(
	context: EditingPreferencesContext,
	preferences: FirstLaunchEditingPreferences,
): Promise<EditingPreferencesDataMessage> {
	return enqueue(async () => {
		const configuration = vscode.workspace.getConfiguration('kustoWorkbench');
		await configuration.update(EDITING_PREFERENCE_CONFIGURATION_KEYS.caretDocsEnabled, preferences.caretDocsEnabled, vscode.ConfigurationTarget.Global);
		await configuration.update(EDITING_PREFERENCE_CONFIGURATION_KEYS.autoTriggerAutocompleteEnabled, preferences.autoTriggerAutocompleteEnabled, vscode.ConfigurationTarget.Global);
		await configuration.update(EDITING_PREFERENCE_CONFIGURATION_KEYS.copilotInlineCompletionsEnabled, preferences.copilotInlineCompletionsEnabled, vscode.ConfigurationTarget.Global);
		await bumpRevision(context);
		return getEditingPreferencesData(context);
	});
}

export function refreshEditingPreferences(context: EditingPreferencesContext): Promise<EditingPreferencesDataMessage> {
	return enqueue(async () => {
		await bumpRevision(context);
		return getEditingPreferencesData(context);
	});
}

export function migrateLegacyEditingPreferences(context: EditingPreferencesContext): Promise<void> {
	return enqueue(async () => {
		const configuration = vscode.workspace.getConfiguration('kustoWorkbench');
		for (const key of [
			STORAGE_KEYS.caretDocsEnabled,
			STORAGE_KEYS.autoTriggerAutocompleteEnabled,
			STORAGE_KEYS.copilotInlineCompletionsEnabled,
		] as const) {
			const configurationKey = STORAGE_TO_CONFIGURATION_KEY[key];
			const configured = configuredBoolean(configurationKey);
			const legacy = storedBoolean(context, key);
			if (configured === undefined && legacy !== undefined) {
				await configuration.update(configurationKey, legacy, vscode.ConfigurationTarget.Global);
			}
			if (legacy !== undefined) {
				await context.globalState.update(key, undefined);
			}
		}
	});
}