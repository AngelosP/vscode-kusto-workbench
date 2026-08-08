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

type StructuralCopilotAvailabilityHandler = {
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

function createProvider(copilotAvailabilityApplication: StructuralCopilotAvailabilityHandler): {
	provider: QueryEditorProvider;
	directCopilotAvailability: ReturnType<typeof vi.fn>;
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
	]) as QueryEditorProvider;
	const directCopilotAvailability = vi.fn(async () => undefined);
	const directTransport = vi.fn(() => true);
	(provider as unknown as {
		copilot: { checkCopilotAvailability: typeof directCopilotAvailability };
	}).copilot.checkCopilotAvailability = directCopilotAvailability;
	(provider as unknown as { postMessage: typeof directTransport }).postMessage = directTransport;
	return { provider, directCopilotAvailability, directTransport };
}

describe('QueryEditorProvider Copilot availability application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('reference-identically forwards the exact request and awaits its settlement', async () => {
		const settlement = deferred<void>();
		const copilotAvailabilityApplication: StructuralCopilotAvailabilityHandler = {
			handleMessage: vi.fn((message: IncomingWebviewMessage) => {
				if (message.type !== 'checkCopilotAvailability') return undefined;
				return settlement.promise;
			}),
			dispose: vi.fn(),
		};
		const { provider, directCopilotAvailability, directTransport } = createProvider(
			copilotAvailabilityApplication,
		);
		const message = {
			type: 'checkCopilotAvailability',
			boxId: 'availability-query-1',
		} satisfies IncomingWebviewMessage;
		let settled = false;

		const request = provider.handleWebviewMessage(message);
		void request.finally(() => { settled = true; });
		await Promise.resolve();

		expect(copilotAvailabilityApplication.handleMessage).toHaveBeenCalledOnce();
		expect(copilotAvailabilityApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect((provider as unknown as { copilotAvailabilityApplication: unknown })
			.copilotAvailabilityApplication).toBe(copilotAvailabilityApplication);
		expect(settled).toBe(false);
		expect(directCopilotAvailability).not.toHaveBeenCalled();
		expect(directTransport).not.toHaveBeenCalled();

		settlement.resolve();
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('adopts the injected rejection exactly without direct provider effects', async () => {
		const failure = new Error('injected Copilot availability handler failed');
		const copilotAvailabilityApplication: StructuralCopilotAvailabilityHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => Promise.reject(failure)),
			dispose: vi.fn(),
		};
		const { provider, directCopilotAvailability, directTransport } = createProvider(
			copilotAvailabilityApplication,
		);
		const message = {
			type: 'checkCopilotAvailability',
			boxId: 'availability-query-reject-1',
		} satisfies IncomingWebviewMessage;

		await expect(provider.handleWebviewMessage(message)).rejects.toBe(failure);

		expect(copilotAvailabilityApplication.handleMessage).toHaveBeenCalledOnce();
		expect(copilotAvailabilityApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect(directCopilotAvailability).not.toHaveBeenCalled();
		expect(directTransport).not.toHaveBeenCalled();
	});

	it('deletes displaced admission while preserving service, callers, routing, and messages', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/copilotAvailabilityApplicationHandler.ts');
		const copilotSource = readSource('src/host/queryEditorCopilot.ts');
		const globalCallerSource = readSource('src/webview/core/main.ts');
		const sectionCallerSource = readSource('src/webview/core/section-factory.ts');
		const responseRouterSource = readSource('src/webview/core/message-handler.ts');
		const hostTypesSource = readSource('src/host/queryEditorTypes.ts');
		const webviewTypesSource = readSource('src/webview/shared/webview-messages.ts');

		expect(providerSource).not.toContain("case 'checkCopilotAvailability':");
		expect(providerSource).toContain(
			'readonly copilotAvailabilityApplication: CopilotAvailabilityApplicationHandler;',
		);
		expect(providerSource).toMatch(
			/copilotInlineCompletionApplication\?: CopilotInlineCompletionApplicationHandler,\s+copilotAvailabilityApplication\?: CopilotAvailabilityApplicationHandler,/,
		);
		expect(providerSource).toContain(
			'this.copilotAvailabilityApplication?.handleMessage(message)',
		);
		expect(providerSource).toContain('this.copilotAvailabilityApplication.dispose();');
		expect(handlerSource).toContain("message.type !== 'checkCopilotAvailability'");
		expect(handlerSource).toContain(
			'await this.options.checkCopilotAvailability(message.boxId);',
		);

		expect(copilotSource).toContain('async checkCopilotAvailability(boxId: string): Promise<void>');
		expect(copilotSource).toContain("vscode.lm.selectChatModels({ vendor: 'copilot' })");
		expect(copilotSource.match(/type: 'copilotAvailability'/g)).toHaveLength(2);
		expect(copilotSource).toContain('available: false');
		expect(globalCallerSource).toContain(
			"postMessageToHost({ type: 'checkCopilotAvailability', boxId: '__kusto_global__' })",
		);
		expect(sectionCallerSource.match(/type: 'checkCopilotAvailability'/g)).toHaveLength(2);
		expect(responseRouterSource).toContain("case 'copilotAvailability':");
		expect(hostTypesSource).toContain("type: 'checkCopilotAvailability'; boxId: string");
		expect(webviewTypesSource).toContain("type: 'checkCopilotAvailability'; boxId: string");
	});
});
