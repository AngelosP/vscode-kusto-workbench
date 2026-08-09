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

vi.mock('../../../src/host/kustoConnectionLifecycle', () => ({
	KustoConnectionLifecycle: class {},
}));

vi.mock('../../../src/host/extension', () => ({
	toolOrchestrator: undefined,
}));

import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

type StructuralCopilotHistoryRemovalHandler = {
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
	copilotHistoryRemovalApplication: StructuralCopilotHistoryRemovalHandler,
): {
	provider: QueryEditorProvider;
	directRemoval: ReturnType<typeof vi.fn>;
	directTransport: ReturnType<typeof vi.fn>;
} {
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
	const provider = Reflect.construct(QueryEditorProvider, [
		vscode.Uri.file('C:\\extension'),
		{ getConnection: vi.fn(), getConnections: vi.fn(() => []) },
		{ globalState: { get: vi.fn(() => undefined), update: vi.fn(async () => undefined) } },
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
	]) as QueryEditorProvider;
	const directRemoval = vi.fn();
	const directTransport = vi.fn(() => true);
	(provider as unknown as {
		copilot: { removeFromCopilotHistory: typeof directRemoval };
	}).copilot.removeFromCopilotHistory = directRemoval;
	(provider as unknown as { postMessage: typeof directTransport }).postMessage = directTransport;
	return { provider, directRemoval, directTransport };
}

describe('QueryEditorProvider Copilot history-removal application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('reference-identically forwards exact Kusto- and SQL-originated requests and awaits both settlements', async () => {
		const kustoSettlement = deferred<void>();
		const sqlSettlement = deferred<void>();
		const kustoMessage = {
			type: 'removeFromCopilotHistory',
			boxId: 'query-history-1',
			entryId: 'query-tool-call-1',
		} satisfies IncomingWebviewMessage;
		const sqlMessage = {
			type: 'removeFromCopilotHistory',
			boxId: 'sql-history-1',
			entryId: 'sql-general-rules-1',
		} satisfies IncomingWebviewMessage;
		const copilotHistoryRemovalApplication: StructuralCopilotHistoryRemovalHandler = {
			handleMessage: vi.fn((message: IncomingWebviewMessage) => {
				if (message.type !== 'removeFromCopilotHistory') return undefined;
				return message === kustoMessage ? kustoSettlement.promise : sqlSettlement.promise;
			}),
			dispose: vi.fn(),
		};
		const { provider, directRemoval, directTransport } = createProvider(
			copilotHistoryRemovalApplication,
		);
		let kustoSettled = false;
		let sqlSettled = false;

		const kustoRequest = provider.handleWebviewMessage(kustoMessage);
		const sqlRequest = provider.handleWebviewMessage(sqlMessage);
		void kustoRequest.finally(() => { kustoSettled = true; });
		void sqlRequest.finally(() => { sqlSettled = true; });
		await Promise.resolve();

		expect(copilotHistoryRemovalApplication.handleMessage).toHaveBeenCalledTimes(2);
		expect(copilotHistoryRemovalApplication.handleMessage.mock.calls[0][0]).toBe(kustoMessage);
		expect(copilotHistoryRemovalApplication.handleMessage.mock.calls[1][0]).toBe(sqlMessage);
		expect((provider as unknown as { copilotHistoryRemovalApplication: unknown })
			.copilotHistoryRemovalApplication).toBe(copilotHistoryRemovalApplication);
		expect(kustoSettled).toBe(false);
		expect(sqlSettled).toBe(false);
		expect(directRemoval).not.toHaveBeenCalled();
		expect(directTransport).not.toHaveBeenCalled();

		kustoSettlement.resolve();
		await expect(kustoRequest).resolves.toBeUndefined();
		expect(kustoSettled).toBe(true);
		expect(sqlSettled).toBe(false);

		sqlSettlement.resolve();
		await expect(sqlRequest).resolves.toBeUndefined();
		expect(sqlSettled).toBe(true);
	});

	it('adopts the injected rejection exactly without direct provider effects', async () => {
		const failure = new Error('injected Copilot history-removal handler failed');
		const legacyFailure = new Error('legacy provider history-removal path was invoked');
		const copilotHistoryRemovalApplication: StructuralCopilotHistoryRemovalHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => Promise.reject(failure)),
			dispose: vi.fn(),
		};
		const { provider, directRemoval, directTransport } = createProvider(
			copilotHistoryRemovalApplication,
		);
		directRemoval.mockImplementation(() => { throw legacyFailure; });
		const message = {
			type: 'removeFromCopilotHistory',
			boxId: 'query-history-reject-1',
			entryId: 'query-history-entry-reject-1',
		} satisfies IncomingWebviewMessage;

		await expect(provider.handleWebviewMessage(message)).rejects.toBe(failure);

		expect(copilotHistoryRemovalApplication.handleMessage).toHaveBeenCalledOnce();
		expect(copilotHistoryRemovalApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect(directRemoval).not.toHaveBeenCalled();
		expect(directTransport).not.toHaveBeenCalled();
	});

	it('deletes displaced admission while preserving history semantics, shared UI, and messages', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/copilotHistoryRemovalApplicationHandler.ts');
		const copilotSource = readSource('src/host/queryEditorCopilot.ts');
		const chatSource = readSource('src/webview/components/kw-copilot-chat.ts');
		const managerSource = readSource('src/webview/sections/copilot-chat-manager.controller.ts');
		const flavorSource = readSource('src/webview/sections/copilot-chat-flavor.ts');
		const hostTypesSource = readSource('src/host/queryEditorTypes.ts');
		const webviewTypesSource = readSource('src/webview/shared/webview-messages.ts');

		expect(providerSource).not.toContain("case 'removeFromCopilotHistory':");
		expect(providerSource).toContain(
			'readonly copilotHistoryRemovalApplication: CopilotHistoryRemovalApplicationHandler;',
		);
		expect(providerSource).toMatch(
			/copilotConversationClearApplication\?: CopilotConversationClearApplicationHandler,\s+copilotHistoryRemovalApplication\?: CopilotHistoryRemovalApplicationHandler,/,
		);
		expect(providerSource).toContain(
			'this.copilotHistoryRemovalApplication?.handleMessage(message)',
		);
		expect(providerSource).toContain('this.copilotHistoryRemovalApplication.dispose();');
		expect(providerSource.match(/this\.copilot\.removeFromCopilotHistory\(boxId, entryId\)/g))
			.toHaveLength(1);
		expect(handlerSource).toContain("message.type !== 'removeFromCopilotHistory'");
		expect(handlerSource).toContain(
			'await this.options.removeFromCopilotHistory(message.boxId, message.entryId);',
		);

		expect(copilotSource).toContain('removeFromCopilotHistory(boxId: string, entryId: string): void');
		expect(copilotSource).toContain("const id = String(boxId || '').trim();");
		expect(copilotSource).toContain("const eid = String(entryId || '').trim();");
		expect(copilotSource).toContain('this.copilotConversationHistoryByBoxId.get(id)');
		expect(copilotSource).toContain("entry.type === 'tool-call' || entry.type === 'general-rules'");
		expect(copilotSource).toContain('entry.removed = true;');

		expect(chatSource).toContain("this.dispatchEvent(new CustomEvent('copilot-remove-entry'");
		expect(chatSource).toContain('{ ...m, removed: true }');
		expect(managerSource.match(/chatEl\.addEventListener\('copilot-remove-entry'/g)).toHaveLength(1);
		expect(managerSource).toContain(
			"postMessageToHost({ type: 'removeFromCopilotHistory', boxId, entryId: e.detail.entryId })",
		);
		expect(flavorSource.match(/removeHistoryMessageType: 'removeFromCopilotHistory'/g))
			.toHaveLength(2);
		expect(hostTypesSource).toContain(
			"type: 'removeFromCopilotHistory'; boxId: string; entryId: string",
		);
		expect(webviewTypesSource).toContain(
			"type: 'removeFromCopilotHistory'; boxId: string; entryId: string",
		);

		expect(providerSource).not.toContain("case 'copilotChatFirstTimeCheck':");
		expect(providerSource).toContain(
			'this.copilotChatFirstTimeApplication?.handleMessage(message)',
		);
		expect(providerSource).not.toContain("case 'startCopilotWriteQuery':");
		expect(providerSource).not.toContain("case 'cancelCopilotWriteQuery':");
		expect(providerSource).not.toContain("case 'prepareOptimizeQuery':");
		expect(providerSource).not.toContain("case 'cancelOptimizeQuery':");
		expect(providerSource).not.toContain("case 'optimizeQuery':");
		expect(providerSource).toContain(
			'this.copilotQueryWorkflowApplication?.handleMessage(message)',
		);
	});
});
