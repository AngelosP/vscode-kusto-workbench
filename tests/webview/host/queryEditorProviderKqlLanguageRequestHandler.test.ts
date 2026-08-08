import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const languageHostEffects = vi.hoisted(() => ({
	findTableReferences: vi.fn(async () => ({ references: [] })),
	getDiagnostics: vi.fn(async () => ({ diagnostics: [] })),
}));

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
	KqlLanguageServiceHost: class {
		readonly findTableReferences = languageHostEffects.findTableReferences;
		readonly getDiagnostics = languageHostEffects.getDiagnostics;
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

type StructuralKqlLanguageRequestHandler = {
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

function createProvider(kqlLanguageRequestApplication: StructuralKqlLanguageRequestHandler): {
	provider: QueryEditorProvider;
	postMessage: ReturnType<typeof vi.fn>;
	error: ReturnType<typeof vi.fn>;
	warn: ReturnType<typeof vi.fn>;
} {
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
		kqlLanguageRequestApplication,
	]) as QueryEditorProvider;
	const postMessage = vi.fn(async () => true);
	const error = vi.fn();
	const warn = vi.fn();
	Object.assign(provider, {
		panel: { webview: { postMessage } },
		output: { error, warn },
	});
	return { provider, postMessage, error, warn };
}

describe('QueryEditorProvider KQL language request application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		languageHostEffects.findTableReferences.mockClear();
		languageHostEffects.getDiagnostics.mockClear();
	});

	it('reference-identically forwards an exact table-reference request without direct provider effects', async () => {
		const handled = deferred<void>();
		const kqlLanguageRequestApplication: StructuralKqlLanguageRequestHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => handled.promise),
			dispose: vi.fn(),
		};
		const { provider, postMessage, error, warn } = createProvider(kqlLanguageRequestApplication);
		const message = {
			type: 'kqlLanguageRequest',
			requestId: 'kql-language-request-21',
			method: 'kusto/findTableReferences',
			params: { text: 'StormEvents | join kind=inner PopulationData on State' },
		} satisfies IncomingWebviewMessage;
		let settled = false;

		const request = provider.handleWebviewMessage(message);
		void request.then(
			() => { settled = true; },
			() => { settled = true; },
		);
		await Promise.resolve();

		expect(kqlLanguageRequestApplication.handleMessage).toHaveBeenCalledTimes(1);
		expect(kqlLanguageRequestApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect((provider as unknown as { kqlLanguageRequestApplication: unknown }).kqlLanguageRequestApplication)
			.toBe(kqlLanguageRequestApplication);
		expect(settled).toBe(false);
		expect(languageHostEffects.findTableReferences).not.toHaveBeenCalled();
		expect(languageHostEffects.getDiagnostics).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();

		handled.resolve();
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('adopts the injected handler rejection exactly', async () => {
		const failure = new Error('injected KQL language request handler failed');
		const kqlLanguageRequestApplication: StructuralKqlLanguageRequestHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => Promise.reject(failure)),
			dispose: vi.fn(),
		};
		const { provider, postMessage, error, warn } = createProvider(kqlLanguageRequestApplication);
		const message = {
			type: 'kqlLanguageRequest',
			requestId: 'kql-language-request-rejection-21',
			method: 'kusto/findTableReferences',
			params: { text: 'StormEvents | project State' },
		} satisfies IncomingWebviewMessage;

		await expect(provider.handleWebviewMessage(message)).rejects.toBe(failure);

		expect(kqlLanguageRequestApplication.handleMessage).toHaveBeenCalledTimes(1);
		expect(kqlLanguageRequestApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect(languageHostEffects.findTableReferences).not.toHaveBeenCalled();
		expect(languageHostEffects.getDiagnostics).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it('deletes displaced authority while preserving the language host, webview ledger, and message shapes', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/kqlLanguageRequestApplicationHandler.ts');
		const languageHostSource = readSource('src/host/kqlLanguageService/host.ts');
		const languageServiceSource = readSource('src/host/kqlLanguageService/service.ts');
		const hostTypesSource = readSource('src/host/queryEditorTypes.ts');
		const webviewSource = readSource('src/webview/core/message-handler.ts');

		expect(providerSource).not.toContain("from './kqlLanguageService/host'");
		expect(providerSource).not.toContain('private readonly kqlLanguageHost:');
		expect(providerSource).not.toContain("case 'kqlLanguageRequest':");
		expect(providerSource).not.toContain('private async handleKqlLanguageRequest(');
		expect(providerSource).toContain('readonly kqlLanguageRequestApplication: KqlLanguageRequestApplicationHandler;');
		expect(providerSource).toMatch(
			/sqlDatabaseDiscoveryApplication\?: SqlDatabaseDiscoveryApplicationHandler,\s+kqlLanguageRequestApplication\?: KqlLanguageRequestApplicationHandler,/,
		);
		expect(providerSource).toContain('this.kqlLanguageRequestApplication.dispose();');
		expect(handlerSource).toContain("case 'textDocument/diagnostic':");
		expect(handlerSource).toContain("case 'kusto/findTableReferences':");
		expect(handlerSource).toContain("type: 'kqlLanguageResponse'");
		expect(handlerSource).toContain('[kql-ls] request failed:');
		expect(languageHostSource).toContain('private resolveContext(');
		expect(languageHostSource).toContain('private async tryGetSchema(');
		expect(languageHostSource).toContain('this.service.getDiagnostics(');
		expect(languageHostSource).toContain('this.service.findTableReferences(');
		expect(languageServiceSource).toContain('getDiagnostics(');
		expect(languageServiceSource).toContain('findTableReferences(');
		expect(hostTypesSource).toContain("type: 'kqlLanguageRequest'");
		expect(webviewSource).toContain("method: 'kusto/findTableReferences'");
		expect(webviewSource).toContain("case 'kqlLanguageResponse':");
		expect(webviewSource).toContain('__kustoKqlLanguageRequestResolversById');
	});
});
