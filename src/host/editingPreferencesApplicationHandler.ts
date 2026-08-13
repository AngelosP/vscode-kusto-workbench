import type * as vscode from 'vscode';

import {
	admitEditingPreferencesWebviewMessage,
	parseEditingPreferencesHostMessage,
	type EditingPreferencesDataMessage,
	type EditingPreferencesWebviewMessage,
} from '../shared/editingPreferences';
import { setEditingPreference } from './editingPreferences';
import { STORAGE_KEYS, type IncomingWebviewMessage } from './queryEditorTypes';

type EditingPreferenceStorageKey =
	| typeof STORAGE_KEYS.caretDocsEnabled
	| typeof STORAGE_KEYS.autoTriggerAutocompleteEnabled
	| typeof STORAGE_KEYS.copilotInlineCompletionsEnabled;

type EditingPreferencesPublisher = {
	postToAllWebviews(message: EditingPreferencesDataMessage): Promise<unknown>;
};

export interface EditingPreferencesApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type EditingPreferencesApplicationHandlerOptions = {
	context: vscode.ExtensionContext;
	getPublisher: () => EditingPreferencesPublisher | undefined;
	postMessage: (message: EditingPreferencesDataMessage) => Thenable<boolean>;
};

export class HostEditingPreferencesApplicationHandler implements EditingPreferencesApplicationHandler {
	private disposed = false;

	constructor(private readonly options: EditingPreferencesApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		const admission = admitEditingPreferencesWebviewMessage(message);
		if (!admission.recognized) return undefined;
		if (!admission.parsed.ok) return Promise.resolve();
		const request = admission.parsed.value;
		let key: EditingPreferenceStorageKey;
		switch (request.type) {
			case 'setCaretDocsEnabled':
				key = STORAGE_KEYS.caretDocsEnabled;
				break;
			case 'setAutoTriggerAutocompleteEnabled':
				key = STORAGE_KEYS.autoTriggerAutocompleteEnabled;
				break;
			case 'setCopilotInlineCompletionsEnabled':
				key = STORAGE_KEYS.copilotInlineCompletionsEnabled;
				break;
		}
		if (this.disposed) return Promise.resolve();
		return this.updatePreference(request, key);
	}

	dispose(): void {
		this.disposed = true;
	}

	private async updatePreference(
		message: EditingPreferencesWebviewMessage,
		key: EditingPreferenceStorageKey,
	): Promise<void> {
		const preferences = await setEditingPreference(this.options.context, key, message.enabled);
		const parsed = parseEditingPreferencesHostMessage(preferences);
		if (!parsed.ok) {
			throw new Error(`Editing preferences publication was invalid: ${parsed.error}`);
		}
		const publisher = this.options.getPublisher();
		if (publisher) {
			await publisher.postToAllWebviews(parsed.value);
		} else {
			await this.options.postMessage(parsed.value);
		}
	}
}
