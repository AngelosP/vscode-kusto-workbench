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

type StructuralCopilotConversationClearHandler = {
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
	copilotConversationClearApplication: StructuralCopilotConversationClearHandler,
): {
	provider: QueryEditorProvider;
	directKustoClear: ReturnType<typeof vi.fn>;
	directSqlClear: ReturnType<typeof vi.fn>;
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
	]) as QueryEditorProvider;
	const directKustoClear = vi.fn(() => true);
	const directSqlClear = vi.fn();
	const directTransport = vi.fn(() => true);
	(provider as unknown as {
		copilot: {
			clearKustoCopilotConversation: typeof directKustoClear;
			clearCopilotConversation: typeof directSqlClear;
		};
	}).copilot.clearKustoCopilotConversation = directKustoClear;
	(provider as unknown as {
		copilot: { clearCopilotConversation: typeof directSqlClear };
	}).copilot.clearCopilotConversation = directSqlClear;
	(provider as unknown as { postMessage: typeof directTransport }).postMessage = directTransport;
	return { provider, directKustoClear, directSqlClear, directTransport };
}

describe('QueryEditorProvider Copilot conversation-clear application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('reference-identically forwards exact Kusto and SQL requests and awaits both settlements', async () => {
		const kustoSettlement = deferred<void>();
		const sqlSettlement = deferred<void>();
		const copilotConversationClearApplication: StructuralCopilotConversationClearHandler = {
			handleMessage: vi.fn((message: IncomingWebviewMessage) => {
				if (message.type !== 'clearCopilotConversation') return undefined;
				return message.flavor === 'kusto' ? kustoSettlement.promise : sqlSettlement.promise;
			}),
			dispose: vi.fn(),
		};
		const { provider, directKustoClear, directSqlClear, directTransport } = createProvider(
			copilotConversationClearApplication,
		);
		const kustoMessage = {
			type: 'clearCopilotConversation',
			flavor: 'kusto',
			boxId: 'query-clear-1',
			sectionInstanceId: 'query-clear-instance-1',
			targetGeneration: 7,
			copilotRequestId: 'copilot-clear-request-1',
		} satisfies IncomingWebviewMessage;
		const sqlMessage = {
			type: 'clearCopilotConversation',
			flavor: 'sql',
			boxId: 'sql-clear-1',
		} satisfies IncomingWebviewMessage;
		let kustoSettled = false;
		let sqlSettled = false;

		const kustoRequest = provider.handleWebviewMessage(kustoMessage);
		const sqlRequest = provider.handleWebviewMessage(sqlMessage);
		void kustoRequest.finally(() => { kustoSettled = true; });
		void sqlRequest.finally(() => { sqlSettled = true; });
		await Promise.resolve();

		expect(copilotConversationClearApplication.handleMessage).toHaveBeenCalledTimes(2);
		expect(copilotConversationClearApplication.handleMessage.mock.calls[0][0]).toBe(kustoMessage);
		expect(copilotConversationClearApplication.handleMessage.mock.calls[1][0]).toBe(sqlMessage);
		expect((provider as unknown as { copilotConversationClearApplication: unknown })
			.copilotConversationClearApplication).toBe(copilotConversationClearApplication);
		expect(kustoSettled).toBe(false);
		expect(sqlSettled).toBe(false);
		expect(directKustoClear).not.toHaveBeenCalled();
		expect(directSqlClear).not.toHaveBeenCalled();
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
		const failure = new Error('injected Copilot conversation-clear handler failed');
		const legacyFailure = new Error('legacy provider clear path was invoked');
		const copilotConversationClearApplication: StructuralCopilotConversationClearHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => Promise.reject(failure)),
			dispose: vi.fn(),
		};
		const { provider, directKustoClear, directSqlClear, directTransport } = createProvider(
			copilotConversationClearApplication,
		);
		directKustoClear.mockImplementation(() => { throw legacyFailure; });
		const message = {
			type: 'clearCopilotConversation',
			flavor: 'kusto',
			boxId: 'query-clear-reject-1',
			sectionInstanceId: 'query-clear-reject-instance-1',
			targetGeneration: 11,
			copilotRequestId: 'copilot-clear-reject-request-1',
		} satisfies IncomingWebviewMessage;

		await expect(provider.handleWebviewMessage(message)).rejects.toBe(failure);

		expect(copilotConversationClearApplication.handleMessage).toHaveBeenCalledOnce();
		expect(copilotConversationClearApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect(directKustoClear).not.toHaveBeenCalled();
		expect(directSqlClear).not.toHaveBeenCalled();
		expect(directTransport).not.toHaveBeenCalled();
	});

	it('deletes displaced admission while preserving clear semantics, callers, and messages', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/copilotConversationClearApplicationHandler.ts');
		const copilotSource = readSource('src/host/queryEditorCopilot.ts');
		const callerSource = readSource('src/webview/sections/copilot-chat-manager.controller.ts');
		const hostTypesSource = readSource('src/host/queryEditorTypes.ts');
		const webviewTypesSource = readSource('src/webview/shared/webview-messages.ts');

		expect(providerSource).not.toContain("case 'clearCopilotConversation':");
		expect(providerSource).toContain(
			'readonly copilotConversationClearApplication: CopilotConversationClearApplicationHandler;',
		);
		expect(providerSource).toMatch(
			/copilotWriteQueryPreparationApplication\?: CopilotWriteQueryPreparationApplicationHandler,\s+copilotConversationClearApplication\?: CopilotConversationClearApplicationHandler,/,
		);
		expect(providerSource).toContain(
			'this.copilotConversationClearApplication?.handleMessage(message)',
		);
		expect(providerSource).toContain('this.copilotConversationClearApplication.dispose();');
		expect(providerSource.match(/this\.copilot\.clearCopilotConversation\(boxId\)/g)).toHaveLength(1);
		expect(providerSource.match(/this\.copilot\.clearKustoCopilotConversation\(message\)/g))
			.toHaveLength(1);
		expect(handlerSource).toContain("message.type !== 'clearCopilotConversation'");
		expect(handlerSource).toContain('hasKustoCopilotRequestIdentity(message)');
		expect(handlerSource).toContain('await this.options.clearKustoCopilotConversation(message);');
		expect(handlerSource).toContain('await this.options.clearCopilotConversation(message.boxId);');

		expect(copilotSource).toContain("const id = String(boxId || '').trim();");
		expect(copilotSource).toContain('this.copilotGeneralRulesSentPerBox.delete(id);');
		expect(copilotSource).toContain('this.copilotDevNotesSentPerBox.delete(id);');
		expect(copilotSource).toContain('this.copilotConversationHistoryByBoxId.delete(id);');
		expect(copilotSource).toContain('this.copilotConversationOwnerByBoxId.get(expected.boxId)');
		expect(copilotSource).toContain('kustoCopilotRequestIdentityEquals(owner.kustoRequest, expected)');
		expect(copilotSource).toContain('this.copilotConversationOwnerByBoxId.delete(expected.boxId);');

		expect(callerSource.match(/type: 'clearCopilotConversation'/g)).toHaveLength(3);
		expect(callerSource).toContain("chatEl.addEventListener('copilot-clear', () => {");
		expect(callerSource).toContain('this.copilotClearConversation();');
		expect(callerSource).toContain(
			"postMessageToHost({ type: 'clearCopilotConversation', flavor: 'kusto', ...owner })",
		);
		expect(callerSource).toContain(
			"postMessageToHost({ type: 'clearCopilotConversation', boxId: this.host.boxId, flavor: 'sql' })",
		);
		expect(providerSource).not.toContain("case 'startCopilotWriteQuery':");
		expect(providerSource).not.toContain("case 'cancelCopilotWriteQuery':");
		expect(providerSource).toContain(
			'this.copilotQueryWorkflowApplication?.handleMessage(message)',
		);
		expect(hostTypesSource).toContain(
			"type: 'clearCopilotConversation'; flavor: 'kusto'",
		);
		expect(hostTypesSource).toContain(
			"type: 'clearCopilotConversation'; boxId: string; flavor?: 'sql'",
		);
		expect(webviewTypesSource).toContain(
			"type: 'clearCopilotConversation'; flavor: 'kusto'",
		);
		expect(webviewTypesSource).toContain(
			"type: 'clearCopilotConversation'; boxId: string; flavor?: 'sql'",
		);
	});
});
