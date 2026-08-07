import type * as vscode from 'vscode';

import type { EditingPreferencesDataMessage } from '../shared/editingPreferences';
import { setEditingPreference } from './editingPreferences';
import { STORAGE_KEYS, type IncomingWebviewMessage } from './queryEditorTypes';

type EditingPreferencesMessage = Extract<IncomingWebviewMessage, {
	type: 'setCaretDocsEnabled' | 'setAutoTriggerAutocompleteEnabled' | 'setCopilotInlineCompletionsEnabled';
}>;

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
		let key: EditingPreferenceStorageKey;
		switch (message.type) {
			case 'setCaretDocsEnabled':
				key = STORAGE_KEYS.caretDocsEnabled;
				break;
			case 'setAutoTriggerAutocompleteEnabled':
				key = STORAGE_KEYS.autoTriggerAutocompleteEnabled;
				break;
			case 'setCopilotInlineCompletionsEnabled':
				key = STORAGE_KEYS.copilotInlineCompletionsEnabled;
				break;
			default:
				return undefined;
		}
		if (this.disposed) return Promise.resolve();
		return this.updatePreference(message, key);
	}

	dispose(): void {
		this.disposed = true;
	}

	private async updatePreference(
		message: EditingPreferencesMessage,
		key: EditingPreferenceStorageKey,
	): Promise<void> {
		const preferences = await setEditingPreference(this.options.context, key, !!message.enabled);
		const publisher = this.options.getPublisher();
		if (publisher) {
			await publisher.postToAllWebviews(preferences);
		} else {
			await this.options.postMessage(preferences);
		}
	}
}
