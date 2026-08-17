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

type StructuralCopilotWriteQueryPreparationHandler = {
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
	copilotWriteQueryPreparationApplication: StructuralCopilotWriteQueryPreparationHandler,
): {
	provider: QueryEditorProvider;
	directCopilotPreparation: ReturnType<typeof vi.fn>;
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
	]) as QueryEditorProvider;
	const directCopilotPreparation = vi.fn(async () => undefined);
	const directTransport = vi.fn(() => true);
	(provider as unknown as {
		copilot: { prepareCopilotWriteQuery: typeof directCopilotPreparation };
	}).copilot.prepareCopilotWriteQuery = directCopilotPreparation;
	(provider as unknown as { postMessage: typeof directTransport }).postMessage = directTransport;
	return { provider, directCopilotPreparation, directTransport };
}

describe('QueryEditorProvider Copilot write-query preparation application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('reference-identically forwards exact Kusto and SQL requests and awaits both settlements', async () => {
		const kustoSettlement = deferred<void>();
		const sqlSettlement = deferred<void>();
		const copilotWriteQueryPreparationApplication: StructuralCopilotWriteQueryPreparationHandler = {
			handleMessage: vi.fn((message: IncomingWebviewMessage) => {
				if (message.type !== 'prepareCopilotWriteQuery') return undefined;
				return message.flavor === 'sql' ? sqlSettlement.promise : kustoSettlement.promise;
			}),
			dispose: vi.fn(),
		};
		const { provider, directCopilotPreparation, directTransport } = createProvider(
			copilotWriteQueryPreparationApplication,
		);
		const kustoMessage = {
			type: 'prepareCopilotWriteQuery',
			boxId: 'query-prepare-1',
			flavor: 'kusto',
		} satisfies IncomingWebviewMessage;
		const sqlMessage = {
			type: 'prepareCopilotWriteQuery',
			boxId: 'sql-prepare-1',
			flavor: 'sql',
		} satisfies IncomingWebviewMessage;
		let kustoSettled = false;
		let sqlSettled = false;

		const kustoRequest = provider.handleWebviewMessage(kustoMessage);
		const sqlRequest = provider.handleWebviewMessage(sqlMessage);
		void kustoRequest.finally(() => { kustoSettled = true; });
		void sqlRequest.finally(() => { sqlSettled = true; });
		await Promise.resolve();

		expect(copilotWriteQueryPreparationApplication.handleMessage).toHaveBeenCalledTimes(2);
		expect(copilotWriteQueryPreparationApplication.handleMessage.mock.calls[0][0]).toBe(kustoMessage);
		expect(copilotWriteQueryPreparationApplication.handleMessage.mock.calls[1][0]).toBe(sqlMessage);
		expect((provider as unknown as { copilotWriteQueryPreparationApplication: unknown })
			.copilotWriteQueryPreparationApplication).toBe(copilotWriteQueryPreparationApplication);
		expect(kustoSettled).toBe(false);
		expect(sqlSettled).toBe(false);
		expect(directCopilotPreparation).not.toHaveBeenCalled();
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
		const failure = new Error('injected Copilot write-query preparation handler failed');
		const copilotWriteQueryPreparationApplication: StructuralCopilotWriteQueryPreparationHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => Promise.reject(failure)),
			dispose: vi.fn(),
		};
		const { provider, directCopilotPreparation, directTransport } = createProvider(
			copilotWriteQueryPreparationApplication,
		);
		const message = {
			type: 'prepareCopilotWriteQuery',
			boxId: 'sql-prepare-reject-1',
			flavor: 'sql',
		} satisfies IncomingWebviewMessage;

		await expect(provider.handleWebviewMessage(message)).rejects.toBe(failure);

		expect(copilotWriteQueryPreparationApplication.handleMessage).toHaveBeenCalledOnce();
		expect(copilotWriteQueryPreparationApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect(directCopilotPreparation).not.toHaveBeenCalled();
		expect(directTransport).not.toHaveBeenCalled();
	});

	it('deletes displaced admission while preserving preparation semantics, callers, routing, and messages', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/copilotWriteQueryPreparationApplicationHandler.ts');
		const copilotSource = readSource('src/host/queryEditorCopilot.ts');
		const callerSource = readSource('src/webview/sections/copilot-chat-manager.controller.ts');
		const responseRouterSource = readSource('src/webview/core/message-handler.ts');
		const hostTypesSource = readSource('src/host/queryEditorTypes.ts');
		const webviewTypesSource = readSource('src/webview/shared/webview-messages.ts');

		expect(providerSource).not.toContain("case 'prepareCopilotWriteQuery':");
		expect(providerSource).toContain(
			'readonly copilotWriteQueryPreparationApplication: CopilotWriteQueryPreparationApplicationHandler;',
		);
		expect(providerSource).toMatch(
			/copilotAvailabilityApplication\?: CopilotAvailabilityApplicationHandler,\s+copilotWriteQueryPreparationApplication\?: CopilotWriteQueryPreparationApplicationHandler,/,
		);
		expect(providerSource).toContain(
			'this.copilotWriteQueryPreparationApplication?.handleMessage(message)',
		);
		expect(providerSource).toContain('this.copilotWriteQueryPreparationApplication.dispose();');
		expect(providerSource.match(/this\.copilot\.prepareCopilotWriteQuery\(message\)/g)).toHaveLength(1);
		expect(handlerSource).toContain("message.type !== 'prepareCopilotWriteQuery'");
		expect(handlerSource).toContain('await this.options.prepareCopilotWriteQuery(message);');

		expect(copilotSource).toContain('const boxId = String(message.boxId || \'\').trim();');
		expect(copilotSource).toContain("vscode.lm.selectChatModels({ vendor: 'copilot' })");
		expect(copilotSource).toContain('label: this.formatCopilotModelLabel(m)');
		expect(copilotSource).toContain('.filter((m) => !!m.id)');
		expect(copilotSource).toContain('.sort((a, b) => a.label.localeCompare(b.label))');
		expect(copilotSource).toContain('STORAGE_KEYS.lastOptimizeCopilotModelId');
		expect(copilotSource).toContain('findPreferredDefaultCopilotModel(models)?.id');
		expect(copilotSource.match(/this\.getLocalToolsForFlavor\(message\.flavor\)/g)).toHaveLength(3);
		expect(copilotSource.match(/type: 'copilotWriteQueryOptions'/g)).toHaveLength(3);
		expect(copilotSource).toContain("type: 'copilotWriteQueryStatus'");

		expect(callerSource.match(/type: 'prepareCopilotWriteQuery'/g)).toHaveLength(2);
		expect(callerSource.match(/flavor: this\.flavor\.id/g)).toHaveLength(2);
		expect(responseRouterSource).toContain("case 'copilotWriteQueryOptions':");
		expect(responseRouterSource).toContain("case 'copilotWriteQueryStatus':");
		expect(hostTypesSource).toContain(
			"type: 'prepareCopilotWriteQuery'; boxId: string; flavor?: 'kusto' | 'sql'",
		);
		expect(webviewTypesSource).toContain(
			"type: 'prepareCopilotWriteQuery'; boxId: string; flavor?: 'kusto' | 'sql'",
		);
	});
});