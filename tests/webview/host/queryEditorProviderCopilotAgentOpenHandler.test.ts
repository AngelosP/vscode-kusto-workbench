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

vi.mock('../../../src/host/copilotChatOpenUtils', () => ({
	openKustoWorkbenchAgentChat: vi.fn(async () => true),
}));

import { openKustoWorkbenchAgentChat } from '../../../src/host/copilotChatOpenUtils';
import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createProvider(copilotAgentOpenApplication: {
	handleMessage: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
}): QueryEditorProvider {
	return Reflect.construct(QueryEditorProvider, [
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
		copilotAgentOpenApplication,
	]) as QueryEditorProvider;
}

describe('QueryEditorProvider Copilot agent-open application', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('forwards the exact openCopilotAgent message to the injected handler without opening chat directly', async () => {
		const copilotAgentOpenApplication = {
			handleMessage: vi.fn(async (_message: IncomingWebviewMessage) => undefined),
			dispose: vi.fn(),
		};
		const provider = createProvider(copilotAgentOpenApplication);
		const message = { type: 'openCopilotAgent' } satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(message);

		expect(provider.copilotAgentOpenApplication).toBe(copilotAgentOpenApplication);
		expect(provider.cachedValuesOpenApplication).not.toBe(copilotAgentOpenApplication);
		expect(copilotAgentOpenApplication.handleMessage).toHaveBeenCalledTimes(1);
		expect(copilotAgentOpenApplication.handleMessage).toHaveBeenCalledWith(message);
		expect(copilotAgentOpenApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect(openKustoWorkbenchAgentChat).not.toHaveBeenCalled();
	});

	it('awaits the injected handler settlement', async () => {
		const handled = deferred<void>();
		const copilotAgentOpenApplication = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => handled.promise),
			dispose: vi.fn(),
		};
		const provider = createProvider(copilotAgentOpenApplication);
		let settled = false;

		const request = provider.handleWebviewMessage({ type: 'openCopilotAgent' });
		void request.finally(() => { settled = true; });
		await Promise.resolve();

		expect(settled).toBe(false);
		handled.resolve();
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('propagates the injected handler rejection exactly', async () => {
		const failure = new Error('injected agent-open handler failed');
		const copilotAgentOpenApplication = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => Promise.reject(failure)),
			dispose: vi.fn(),
		};
		const provider = createProvider(copilotAgentOpenApplication);

		await expect(provider.handleWebviewMessage({ type: 'openCopilotAgent' })).rejects.toBe(failure);
	});

	it('retains only injection while the handler owns the unchanged provider route', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/copilotAgentOpenApplicationHandler.ts');
		const helperSource = readSource('src/host/copilotChatOpenUtils.ts');
		const extensionSource = readSource('src/host/extension.ts');
		const dashboardSource = readSource('src/host/dashboardApplicationHandler.ts');
		const copilotSource = readSource('src/host/queryEditorCopilot.ts');
		const controllerSource = readSource('src/webview/sections/copilot-chat-manager.controller.ts');

		expect(providerSource).not.toContain("case 'openCopilotAgent':");
		expect(providerSource).not.toContain('openKustoWorkbenchAgentChat');
		expect(handlerSource).toContain("message.type !== 'openCopilotAgent'");
		expect(handlerSource).toContain('await openKustoWorkbenchAgentChat();');

		expect(helperSource).toContain("executeCommand('workbench.action.chat.open', { mode: KUSTO_CHAT_MODE })");
		expect(helperSource).toContain('await delay(150);');
		expect(helperSource).toContain("const KUSTO_CHAT_MODE = 'Kusto Workbench';");
		expect(helperSource).toContain('isPartialQuery: options.submit === false');
		expect(helperSource).toContain('return !query;');

		for (const source of [extensionSource, dashboardSource, copilotSource]) {
			expect(source).toContain("from './copilotChatOpenUtils'");
			expect(source).toContain('openKustoWorkbenchAgentChat(');
		}
		expect(controllerSource).toContain("postMessageToHost({ type: 'openCopilotAgent' });");
	});
});