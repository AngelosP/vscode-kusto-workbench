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

vi.mock('../../../src/host/copilotChatOpenUtils', () => ({
	openKustoWorkbenchAgentChat: vi.fn(async () => true),
}));

vi.mock('../../../src/host/kustoConnectionLifecycle', () => ({
	KustoConnectionLifecycle: class {},
}));

vi.mock('../../../src/host/extension', () => ({
	toolOrchestrator: undefined,
}));

import { openKustoWorkbenchAgentChat } from '../../../src/host/copilotChatOpenUtils';
import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

type StructuralCopilotChatFirstTimeHandler = {
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
	copilotChatFirstTimeApplication: StructuralCopilotChatFirstTimeHandler,
): {
	provider: QueryEditorProvider;
	directWorkflow: ReturnType<typeof vi.fn>;
	stateGet: ReturnType<typeof vi.fn>;
	stateUpdate: ReturnType<typeof vi.fn>;
	showInformationMessage: ReturnType<typeof vi.spyOn>;
	directTransport: ReturnType<typeof vi.fn>;
} {
	const stateGet = vi.fn(() => undefined);
	const stateUpdate = vi.fn(async () => undefined);
	const developmentNoteMutationApplication = {
		updateDevelopmentNotes: vi.fn(async () => ({ success: true })),
		handleMessage: vi.fn(() => false),
		dispose: vi.fn(),
	};
	const copilotInlineCompletionApplication = {
		handleMessage: vi.fn(() => undefined),
		dispose: vi.fn(),
	};
	const copilotAvailabilityApplication = {
		handleMessage: vi.fn(() => undefined),
		dispose: vi.fn(),
	};
	const copilotWriteQueryPreparationApplication = {
		handleMessage: vi.fn(() => undefined),
		dispose: vi.fn(),
	};
	const copilotConversationClearApplication = {
		handleMessage: vi.fn(() => undefined),
		dispose: vi.fn(),
	};
	const copilotHistoryRemovalApplication = {
		handleMessage: vi.fn(() => undefined),
		dispose: vi.fn(),
	};
	const provider = Reflect.construct(QueryEditorProvider, [
		vscode.Uri.file('C:\\extension'),
		{ getConnection: vi.fn(), getConnections: vi.fn(() => []) },
		{ globalState: { get: stateGet, update: stateUpdate } },
		{
			connectionManager: { getConnection: vi.fn(), getConnections: vi.fn(() => []) },
			client: { getDatabases: vi.fn(async () => [] as string[]) },
		},
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
		undefined,
		undefined,
		undefined,
		undefined,
		{
			handleMessage: vi.fn(() => undefined),
			getFavorites: vi.fn(() => []),
			dispose: vi.fn(),
		},
		{
			handleMessage: vi.fn(() => undefined),
			getFavorites: vi.fn(() => []),
			activate: vi.fn(),
			dispose: vi.fn(),
		},
		{ handleMessage: vi.fn(() => undefined), dispose: vi.fn() },
		{ handleMessage: vi.fn(() => undefined), dispose: vi.fn() },
		{ handleMessage: vi.fn(() => undefined), dispose: vi.fn() },
		developmentNoteMutationApplication,
		copilotInlineCompletionApplication,
		copilotAvailabilityApplication,
		copilotWriteQueryPreparationApplication,
		copilotConversationClearApplication,
		copilotHistoryRemovalApplication,
		copilotChatFirstTimeApplication,
	]) as QueryEditorProvider;
	const directWorkflow = vi.fn(async () => undefined);
	const directTransport = vi.fn(() => true);
	(provider as unknown as {
		copilot: { handleCopilotChatFirstTimeCheck: typeof directWorkflow };
	}).copilot.handleCopilotChatFirstTimeCheck = directWorkflow;
	(provider as unknown as { postMessage: typeof directTransport }).postMessage = directTransport;
	const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage')
		.mockResolvedValue(undefined);
	stateGet.mockClear();
	stateUpdate.mockClear();
	vi.mocked(openKustoWorkbenchAgentChat).mockClear();
	return {
		provider,
		directWorkflow,
		stateGet,
		stateUpdate,
		showInformationMessage,
		directTransport,
	};
}

describe('QueryEditorProvider Copilot chat first-time application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('reference-identically forwards the exact request and awaits deferred settlement', async () => {
		const settlement = deferred<void>();
		const message = {
			type: 'copilotChatFirstTimeCheck',
			boxId: '  first-time-box-exact  ',
		} satisfies IncomingWebviewMessage;
		const copilotChatFirstTimeApplication: StructuralCopilotChatFirstTimeHandler = {
			handleMessage: vi.fn((candidate: IncomingWebviewMessage) =>
				candidate.type === 'copilotChatFirstTimeCheck' ? settlement.promise : undefined),
			dispose: vi.fn(),
		};
		const {
			provider,
			directWorkflow,
			stateGet,
			stateUpdate,
			showInformationMessage,
			directTransport,
		} = createProvider(copilotChatFirstTimeApplication);
		let settled = false;

		const request = provider.handleWebviewMessage(message);
		void request.finally(() => { settled = true; });
		await Promise.resolve();

		expect(copilotChatFirstTimeApplication.handleMessage).toHaveBeenCalledOnce();
		expect(copilotChatFirstTimeApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect((provider as unknown as { copilotChatFirstTimeApplication: unknown })
			.copilotChatFirstTimeApplication).toBe(copilotChatFirstTimeApplication);
		expect(settled).toBe(false);
		expect(directWorkflow).not.toHaveBeenCalled();
		expect(stateGet).not.toHaveBeenCalled();
		expect(stateUpdate).not.toHaveBeenCalled();
		expect(showInformationMessage).not.toHaveBeenCalled();
		expect(openKustoWorkbenchAgentChat).not.toHaveBeenCalled();
		expect(directTransport).not.toHaveBeenCalled();

		settlement.resolve();
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('adopts the injected rejection exactly without direct provider effects', async () => {
		const failure = new Error('injected Copilot chat first-time handler failed');
		const legacyFailure = new Error('legacy Copilot chat first-time workflow was invoked');
		const copilotChatFirstTimeApplication: StructuralCopilotChatFirstTimeHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => Promise.reject(failure)),
			dispose: vi.fn(),
		};
		const {
			provider,
			directWorkflow,
			stateGet,
			stateUpdate,
			showInformationMessage,
			directTransport,
		} = createProvider(copilotChatFirstTimeApplication);
		directWorkflow.mockImplementation(() => { throw legacyFailure; });
		const message = {
			type: 'copilotChatFirstTimeCheck',
			boxId: 'first-time-box-reject',
		} satisfies IncomingWebviewMessage;

		await expect(provider.handleWebviewMessage(message)).rejects.toBe(failure);

		expect(copilotChatFirstTimeApplication.handleMessage).toHaveBeenCalledOnce();
		expect(copilotChatFirstTimeApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect(directWorkflow).not.toHaveBeenCalled();
		expect(stateGet).not.toHaveBeenCalled();
		expect(stateUpdate).not.toHaveBeenCalled();
		expect(showInformationMessage).not.toHaveBeenCalled();
		expect(openKustoWorkbenchAgentChat).not.toHaveBeenCalled();
		expect(directTransport).not.toHaveBeenCalled();
	});

	it('deletes displaced workflow authority while preserving callers, projection, results, and messages', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/copilotChatFirstTimeApplicationHandler.ts');
		const copilotSource = readSource('src/host/queryEditorCopilot.ts');
		const typesSource = readSource('src/host/queryEditorTypes.ts');
		const managerSource = readSource('src/webview/sections/copilot-chat-manager.controller.ts');
		const messageHandlerSource = readSource('src/webview/core/message-handler.ts');
		const webviewTypesSource = readSource('src/webview/shared/webview-messages.ts');
		const helperSource = readSource('src/host/copilotChatOpenUtils.ts');

		expect(providerSource).not.toContain("case 'copilotChatFirstTimeCheck':");
		expect(providerSource).not.toContain('handleCopilotChatFirstTimeCheck');
		expect(providerSource).toContain(
			'readonly copilotChatFirstTimeApplication: CopilotChatFirstTimeApplicationHandler;',
		);
		expect(providerSource).toMatch(
			/copilotHistoryRemovalApplication\?: CopilotHistoryRemovalApplicationHandler,\s+copilotChatFirstTimeApplication\?: CopilotChatFirstTimeApplicationHandler,/,
		);
		expect(providerSource).toContain(
			'this.copilotChatFirstTimeApplication?.handleMessage(message)',
		);
		expect(providerSource).toContain('this.copilotChatFirstTimeApplication.dispose();');

		expect(copilotSource).not.toContain('handleCopilotChatFirstTimeCheck');
		expect(copilotSource).not.toContain("from './copilotChatOpenUtils'");
		expect(handlerSource).toContain("message.type !== 'copilotChatFirstTimeCheck'");
		expect(handlerSource).toContain(
			'globalState.get<boolean>(STORAGE_KEYS.copilotChatFirstTimeDismissed)',
		);
		expect(handlerSource).toContain(
			'globalState.update(STORAGE_KEYS.copilotChatFirstTimeDismissed, true)',
		);
		expect(handlerSource).toContain('await openKustoWorkbenchAgentChat();');
		expect(handlerSource).toContain(
			"this.options.postMessage({ type: 'copilotChatFirstTimeResult', boxId, action });",
		);
		expect(handlerSource).not.toContain('await this.options.postMessage');

		expect(typesSource).toContain(
			"copilotChatFirstTimeDismissed: 'kusto.copilotChatFirstTimeDismissed'",
		);
		expect(providerSource).toContain(
			'copilotChatFirstTimeDismissed: !!this.context.globalState.get<boolean>(STORAGE_KEYS.copilotChatFirstTimeDismissed)',
		);
		expect(managerSource.match(/postMessageToHost\(\{ type: 'copilotChatFirstTimeCheck'/g))
			.toHaveLength(1);
		expect(messageHandlerSource).toContain(
			'pState.copilotChatFirstTimeDismissed = !!message.copilotChatFirstTimeDismissed',
		);
		expect(messageHandlerSource).toContain("case 'copilotChatFirstTimeResult':");
		expect(messageHandlerSource).toContain('pState.copilotChatFirstTimeDismissed = true;');
		expect(messageHandlerSource).toContain("if (action === 'proceed')");
		expect(messageHandlerSource).toContain('__kustoGetQuerySectionElement(ftBoxId)');
		expect(messageHandlerSource).toContain('__kustoGetSqlSectionElement(ftBoxId)');
		expect(typesSource).toContain("type: 'copilotChatFirstTimeCheck'; boxId: string");
		expect(webviewTypesSource).toContain("type: 'copilotChatFirstTimeCheck'; boxId: string");

		expect(helperSource).toContain(
			"executeCommand('workbench.action.chat.open', { mode: KUSTO_CHAT_MODE })",
		);
		expect(helperSource).toContain('await delay(150);');
		expect(helperSource).toContain("const KUSTO_CHAT_MODE = 'Kusto Workbench';");
		expect(helperSource).toContain('isPartialQuery: options.submit === false');
		expect(helperSource).toContain('return !query;');
	});
});