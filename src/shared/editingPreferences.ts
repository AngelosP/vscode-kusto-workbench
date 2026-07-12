export interface EditingPreferencesDataMessage {
	type: 'editingPreferencesData';
	revision: number;
	caretDocsEnabled: boolean;
	caretDocsEnabledUserSet: boolean;
	autoTriggerAutocompleteEnabled: boolean;
	autoTriggerAutocompleteEnabledUserSet: boolean;
	copilotInlineCompletionsEnabled: boolean;
	copilotInlineCompletionsEnabledUserSet: boolean;
}