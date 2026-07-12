export interface FirstLaunchFilePreferences {
	openKqlFiles: boolean;
	openCslFiles: boolean;
	openMdFiles: boolean;
	openSqlFiles: boolean;
}

export interface FirstLaunchEditingPreferences {
	caretDocsEnabled: boolean;
	autoTriggerAutocompleteEnabled: boolean;
	copilotInlineCompletionsEnabled: boolean;
}

export type FirstLaunchSetupMode = 'automatic' | 'configure';

export interface FirstLaunchSetupSnapshot {
	mode: FirstLaunchSetupMode;
	filePreferences: FirstLaunchFilePreferences;
	editingPreferences: FirstLaunchEditingPreferences;
	inlineSuggestEnabled: boolean;
	pendingOperation?: 'save' | 'skip';
	retryOnly?: boolean;
}

export type FirstLaunchSetupWebviewMessage =
	| { type: 'ready' }
	| { type: 'requestSnapshot' }
	| { type: 'save'; filePreferences: FirstLaunchFilePreferences; editingPreferences: FirstLaunchEditingPreferences }
	| { type: 'skip' }
	| { type: 'cancel' };

export type FirstLaunchSetupHostMessage =
	| { type: 'snapshot'; snapshot: FirstLaunchSetupSnapshot }
	| { type: 'working'; working: boolean }
	| { type: 'error'; message: string; retryOnly?: boolean };