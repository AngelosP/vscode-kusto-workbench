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

type StructuralCopilotInlineCompletionHandler = {
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

function createProvider(copilotInlineCompletionApplication: StructuralCopilotInlineCompletionHandler): {
	provider: QueryEditorProvider;
	assertSqlOwnerToken: ReturnType<typeof vi.fn>;
	copilotExecution: ReturnType<typeof vi.fn>;
	fallbackTransport: ReturnType<typeof vi.fn>;
} {
	const developmentNoteMutationApplication = {
		updateDevelopmentNotes: vi.fn(async () => ({ success: true })),
		handleMessage: vi.fn(() => false),
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
	]) as QueryEditorProvider;
	const assertSqlOwnerToken = vi.fn(async () => ({
		owner: { connectionId: 'sql-direct', database: 'DirectDb' },
		token: 'direct-owner-token',
	}));
	const copilotExecution = vi.fn(async () => undefined);
	const fallbackTransport = vi.fn(() => true);
	(provider as unknown as { assertSqlOwnerToken: typeof assertSqlOwnerToken }).assertSqlOwnerToken
		= assertSqlOwnerToken;
	(provider as unknown as {
		copilot: { handleCopilotInlineCompletionRequest: typeof copilotExecution };
	}).copilot.handleCopilotInlineCompletionRequest = copilotExecution;
	(provider as unknown as { postMessage: typeof fallbackTransport }).postMessage = fallbackTransport;
	return { provider, assertSqlOwnerToken, copilotExecution, fallbackTransport };
}

describe('QueryEditorProvider Copilot inline-completion application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('reference-identically forwards exact Kusto and SQL requests and awaits both settlements', async () => {
		const kustoSettlement = deferred<void>();
		const sqlSettlement = deferred<void>();
		const copilotInlineCompletionApplication: StructuralCopilotInlineCompletionHandler = {
			handleMessage: vi.fn((message: IncomingWebviewMessage) => {
				if (message.type !== 'requestCopilotInlineCompletion') return undefined;
				return message.flavor === 'sql' ? sqlSettlement.promise : kustoSettlement.promise;
			}),
			dispose: vi.fn(),
		};
		const { provider, assertSqlOwnerToken, copilotExecution, fallbackTransport } = createProvider(
			copilotInlineCompletionApplication,
		);
		const kustoMessage = {
			type: 'requestCopilotInlineCompletion',
			requestId: 'inline-kusto-1',
			boxId: 'query-1',
			textBefore: 'StormEvents\n| where State == "WA"\n| ',
			textAfter: '\n| take 10',
			flavor: 'kusto',
		} satisfies IncomingWebviewMessage;
		const sqlMessage = {
			type: 'requestCopilotInlineCompletion',
			requestId: 'inline-sql-1',
			boxId: 'sql-1',
			textBefore: 'SELECT *\nFROM dbo.Events\nWHERE ',
			textAfter: '\nORDER BY CreatedAt DESC',
			flavor: 'sql',
			ownerToken: 'sql-owner-token-1',
		} satisfies IncomingWebviewMessage;
		let kustoSettled = false;
		let sqlSettled = false;

		const kustoRequest = provider.handleWebviewMessage(kustoMessage);
		const sqlRequest = provider.handleWebviewMessage(sqlMessage);
		void kustoRequest.finally(() => { kustoSettled = true; });
		void sqlRequest.finally(() => { sqlSettled = true; });
		await Promise.resolve();

		expect(copilotInlineCompletionApplication.handleMessage).toHaveBeenCalledTimes(2);
		expect(copilotInlineCompletionApplication.handleMessage.mock.calls[0][0]).toBe(kustoMessage);
		expect(copilotInlineCompletionApplication.handleMessage.mock.calls[1][0]).toBe(sqlMessage);
		expect((provider as unknown as { copilotInlineCompletionApplication: unknown })
			.copilotInlineCompletionApplication).toBe(copilotInlineCompletionApplication);
		expect(kustoSettled).toBe(false);
		expect(sqlSettled).toBe(false);
		expect(assertSqlOwnerToken).not.toHaveBeenCalled();
		expect(copilotExecution).not.toHaveBeenCalled();
		expect(fallbackTransport).not.toHaveBeenCalled();

		kustoSettlement.resolve();
		await expect(kustoRequest).resolves.toBeUndefined();
		expect(kustoSettled).toBe(true);
		expect(sqlSettled).toBe(false);

		sqlSettlement.resolve();
		await expect(sqlRequest).resolves.toBeUndefined();
		expect(sqlSettled).toBe(true);
	});

	it('adopts the injected handler rejection exactly without direct provider effects', async () => {
		const failure = new Error('injected inline-completion handler failed');
		const copilotInlineCompletionApplication: StructuralCopilotInlineCompletionHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => Promise.reject(failure)),
			dispose: vi.fn(),
		};
		const { provider, assertSqlOwnerToken, copilotExecution, fallbackTransport } = createProvider(
			copilotInlineCompletionApplication,
		);
		const message = {
			type: 'requestCopilotInlineCompletion',
			requestId: 'inline-sql-reject-1',
			boxId: 'sql-reject-1',
			textBefore: 'SELECT ',
			textAfter: ' FROM dbo.Events',
			flavor: 'sql',
			ownerToken: 'sql-owner-token-reject-1',
		} satisfies IncomingWebviewMessage;

		await expect(provider.handleWebviewMessage(message)).rejects.toBe(failure);

		expect(copilotInlineCompletionApplication.handleMessage).toHaveBeenCalledOnce();
		expect(copilotInlineCompletionApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect(assertSqlOwnerToken).not.toHaveBeenCalled();
		expect(copilotExecution).not.toHaveBeenCalled();
		expect(fallbackTransport).not.toHaveBeenCalled();
	});

	it('deletes displaced admission while preserving Copilot, SQL owner, webview, and message authorities', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/copilotInlineCompletionApplicationHandler.ts');
		const copilotSource = readSource('src/host/queryEditorCopilot.ts');
		const sqlOwnerSource = readSource('src/host/sql/sqlEditorSessionRegistry.ts');
		const hostTypesSource = readSource('src/host/queryEditorTypes.ts');
		const webviewTypesSource = readSource('src/webview/shared/webview-messages.ts');
		const monacoSource = readSource('src/webview/monaco/monaco.ts');
		const messageHandlerSource = readSource('src/webview/core/message-handler.ts');
		const editingPreferencesSource = readSource('src/webview/core/editing-preferences.ts');

		expect(providerSource).not.toContain("case 'requestCopilotInlineCompletion':");
		expect(providerSource).not.toContain(
			"type: 'copilotInlineCompletionResult', requestId: message.requestId",
		);
		expect(providerSource).toContain(
			'readonly copilotInlineCompletionApplication: CopilotInlineCompletionApplicationHandler;',
		);
		expect(providerSource).toMatch(
			/developmentNoteMutationApplication\?: DevelopmentNoteMutationApplicationHandler,\s+copilotInlineCompletionApplication\?: CopilotInlineCompletionApplicationHandler,/,
		);
		expect(providerSource).toContain(
			'this.copilotInlineCompletionApplication?.handleMessage(message)',
		);
		expect(providerSource).toContain('this.copilotInlineCompletionApplication.dispose();');
		expect(handlerSource).toContain("message.type !== 'requestCopilotInlineCompletion'");
		expect(handlerSource).toContain('this.options.assertSqlOwnerToken(message.boxId, message.ownerToken)');
		expect(handlerSource).toContain(
			'this.options.handleCopilotInlineCompletionRequest(message, issued.owner, issued.token)',
		);
		expect(handlerSource).toContain("type: 'copilotInlineCompletionResult'");
		expect(handlerSource).toContain('completions: []');

		expect(copilotSource).toContain('private readonly runningSqlInlineCompletionByBoxId');
		expect(copilotSource).toContain('let model = this._cachedInlineModel;');
		expect(copilotSource).toContain("vscode.lm.selectChatModels({ vendor: 'copilot' })");
		expect(copilotSource).toContain('const maxBefore = 2000;');
		expect(copilotSource).toContain('const maxAfter = 500;');
		expect(copilotSource).toContain('setTimeout(() => cts.cancel(), 8000)');
		expect(copilotSource).toContain('model.sendRequest(');
		expect(sqlOwnerSource).toContain('async assertOwnerToken(');
		expect(sqlOwnerSource).toContain('private readonly ownerTokenByBoxId');

		expect(hostTypesSource).toContain("type: 'requestCopilotInlineCompletion'");
		expect(webviewTypesSource).toContain("type: 'requestCopilotInlineCompletion'");
		expect(monacoSource).toContain("type: 'requestCopilotInlineCompletion'");
		expect(monacoSource).toContain('}, 10000);');
		expect(messageHandlerSource).toContain("case 'copilotInlineCompletionResult':");
		expect(editingPreferencesSource).toContain(
			'setCopilotInlineCompletionsEnabled(preferences.copilotInlineCompletionsEnabled);',
		);
	});
});