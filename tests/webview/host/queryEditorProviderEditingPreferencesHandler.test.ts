import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('../../../src/host/kustoClient', async importOriginal => ({
	...await importOriginal<typeof import('../../../src/host/kustoClient')>(),
	KustoQueryClient: class {},
}));

vi.mock('../../../src/host/kustoAuthPreferenceService', () => ({
	KustoAuthPreferenceService: {
		getInstance: () => ({ onDidChange: () => ({ dispose() {} }) }),
	},
}));

vi.mock('../../../src/host/kqlLanguageService/host', () => ({
	KqlLanguageServiceHost: class {},
}));

vi.mock('../../../src/host/queryEditorConnection', () => ({
	ConnectionService: class {},
}));

vi.mock('../../../src/host/queryEditorSchema', () => ({
	SchemaService: class {},
}));

vi.mock('../../../src/host/sql/sqlEditorLifecycleCoordinator', () => ({
	SqlEditorLifecycleCoordinator: class {
		startSession(): void {}
	},
}));

vi.mock('../../../src/host/queryEditorCopilot', () => ({
	CopilotService: class {},
	SQL_COPILOT_OWNER_CHANGED_MESSAGE: 'SQL section owner changed. Retry the request.',
}));

vi.mock('../../../src/host/kustoConnectionLifecycle', () => ({
	KustoConnectionLifecycle: class {},
}));

vi.mock('../../../src/host/extension', () => ({
	toolOrchestrator: {
		postToAllWebviews: vi.fn(async () => undefined),
	},
}));

vi.mock('../../../src/host/editingPreferences', () => ({
	getEditingPreferencesData: vi.fn(),
	setEditingPreference: vi.fn(async () => ({
		type: 'editingPreferencesData',
		revision: 14,
		caretDocsEnabled: true,
		caretDocsEnabledUserSet: true,
		autoTriggerAutocompleteEnabled: false,
		autoTriggerAutocompleteEnabledUserSet: true,
		copilotInlineCompletionsEnabled: true,
		copilotInlineCompletionsEnabledUserSet: true,
	})),
}));

import { setEditingPreference } from '../../../src/host/editingPreferences';
import { toolOrchestrator } from '../../../src/host/extension';
import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

type StructuralEditingPreferencesHandler = {
	handleMessage: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createProvider(
	editingPreferencesApplication: StructuralEditingPreferencesHandler,
	postMessage: ReturnType<typeof vi.fn>,
): QueryEditorProvider {
	const provider = Reflect.construct(QueryEditorProvider, [
		vscode.Uri.file('C:\\extension'),
		{},
		{},
		{},
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		editingPreferencesApplication,
	]) as QueryEditorProvider;
	Object.assign(provider, {
		panel: {
			webview: { postMessage },
		},
	});
	return provider;
}

describe('QueryEditorProvider editing-preferences application', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('forwards all three exact preference messages without mutating or publishing directly', async () => {
		const editingPreferencesApplication: StructuralEditingPreferencesHandler = {
			handleMessage: vi.fn(async (_message: IncomingWebviewMessage) => undefined),
			dispose: vi.fn(),
		};
		const postMessage = vi.fn(async () => true);
		const provider = createProvider(editingPreferencesApplication, postMessage);
		const caretDocs = {
			type: 'setCaretDocsEnabled',
			enabled: true,
		} satisfies IncomingWebviewMessage;
		const autocomplete = {
			type: 'setAutoTriggerAutocompleteEnabled',
			enabled: false,
		} satisfies IncomingWebviewMessage;
		const inlineCompletions = {
			type: 'setCopilotInlineCompletionsEnabled',
			enabled: true,
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(caretDocs);
		await provider.handleWebviewMessage(autocomplete);
		await provider.handleWebviewMessage(inlineCompletions);

		expect(provider.editingPreferencesApplication).toBe(editingPreferencesApplication);
		expect(provider.editorCursorStatusApplication).not.toBe(editingPreferencesApplication);
		expect(editingPreferencesApplication.handleMessage).toHaveBeenCalledTimes(3);
		expect(editingPreferencesApplication.handleMessage.mock.calls[0][0]).toBe(caretDocs);
		expect(editingPreferencesApplication.handleMessage.mock.calls[1][0]).toBe(autocomplete);
		expect(editingPreferencesApplication.handleMessage.mock.calls[2][0]).toBe(inlineCompletions);
		expect(setEditingPreference).not.toHaveBeenCalled();
		expect(toolOrchestrator?.postToAllWebviews).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('awaits the injected handler settlement and adopts its exact rejection', async () => {
		const handled = deferred<void>();
		const editingPreferencesApplication: StructuralEditingPreferencesHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => handled.promise),
			dispose: vi.fn(),
		};
		const provider = createProvider(editingPreferencesApplication, vi.fn(async () => true));
		let settled = false;
		const request = provider.handleWebviewMessage({ type: 'setCaretDocsEnabled', enabled: true });
		void request.finally(() => { settled = true; });
		await Promise.resolve();

		expect(settled).toBe(false);
		handled.resolve();
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);

		const failure = new Error('injected editing-preferences handler failed');
		editingPreferencesApplication.handleMessage.mockReturnValueOnce(Promise.reject(failure));
		await expect(provider.handleWebviewMessage({
			type: 'setAutoTriggerAutocompleteEnabled', enabled: false,
		})).rejects.toBe(failure);
	});

	it('retains only injection while persistence, initial projection, configuration, and emitters stay put', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/editingPreferencesApplicationHandler.ts');
		const preferenceSource = readSource('src/host/editingPreferences.ts');
		const extensionSource = readSource('src/host/extension.ts');
		const emitterSource = readSource('src/webview/shared/webview-messages.ts');

		for (const type of [
			'setCaretDocsEnabled',
			'setAutoTriggerAutocompleteEnabled',
			'setCopilotInlineCompletionsEnabled',
		]) {
			expect(providerSource).not.toContain(`case '${type}':`);
			expect(handlerSource).toContain(`case '${type}':`);
			expect(emitterSource).toContain(`type: '${type}'`);
		}
		expect(providerSource).not.toContain('updateEditingPreference(');
		expect(providerSource).not.toContain('setEditingPreference');
		expect(providerSource).toContain('this.editingPreferencesApplication.dispose();');
		expect(providerSource).toContain('getEditingPreferencesData(this.context)');
		expect(providerSource).toContain('editingPreferencesRevision');
		expect(handlerSource).toContain('await setEditingPreference(this.options.context, key, !!message.enabled)');
		expect(handlerSource).toContain('await publisher.postToAllWebviews(preferences);');
		expect(handlerSource).toContain('await this.options.postMessage(preferences);');
		expect(preferenceSource).toContain('const STORAGE_TO_CONFIGURATION_KEY');
		expect(preferenceSource).toContain('Math.max(revision(context) + 1, Date.now())');
		expect(extensionSource).toContain('onDidChangeConfiguration');
		expect(extensionSource).toContain('refreshEditingPreferences(context)');
	});
});
