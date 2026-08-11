import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const schemaEffects = vi.hoisted(() => ({
	prefetchSchema: vi.fn(async () => undefined),
	handleCrossClusterSchemaRequest: vi.fn(async () => undefined),
}));

vi.mock('../../../src/host/kustoExecutionCoordinator', () => ({
	KustoExecutionCoordinator: class {},
}));

vi.mock('../../../src/host/kustoClient', async importOriginal => ({
	...await importOriginal<typeof import('../../../src/host/kustoClient')>(),
	KustoQueryClient: class {},
}));

vi.mock('../../../src/host/kustoAuthPreferenceService', () => ({
	KustoAuthPreferenceService: {
		getInstance: () => ({
			getAccounts: vi.fn(async () => []),
			onDidChange: () => ({ dispose() {} }),
		}),
	},
}));

vi.mock('../../../src/host/queryEditorConnection', () => ({
	ConnectionService: class {
		readonly getCachedDatabases = vi.fn(() => ({}));
		readonly getLastConnectionId = vi.fn(() => undefined);
		readonly getLastDatabase = vi.fn(() => undefined);
		readonly sendDatabases = vi.fn(async () => undefined);
		readonly saveLastSelection = vi.fn(async () => undefined);
	},
}));

vi.mock('../../../src/host/queryEditorSchema', () => ({
	SchemaService: class {
		readonly prefetchSchema = schemaEffects.prefetchSchema;
		readonly handleCrossClusterSchemaRequest = schemaEffects.handleCrossClusterSchemaRequest;
	},
}));

vi.mock('../../../src/host/sql/sqlEditorLifecycleCoordinator', () => ({
	SqlEditorLifecycleCoordinator: class {
		readonly executionBroker = {};
		startSession(): void {}
		listComparisonBoxIds(): string[] { return []; }
	},
}));

vi.mock('../../../src/host/queryEditorCopilot', () => ({
	CopilotService: class {},
}));

vi.mock('../../../src/host/kustoConnectionLifecycle', () => ({
	KustoConnectionLifecycle: class {},
}));

vi.mock('../../../src/host/extension', () => ({
	toolOrchestrator: undefined,
}));

import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

type StructuralKustoSchemaRequestHandler = {
	handleMessage: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
	return { promise, resolve };
}

function createProvider(kustoSchemaRequestApplication: StructuralKustoSchemaRequestHandler) {
	const constructorArgs: unknown[] = [
		vscode.Uri.file('C:\\extension'),
		{
			getConnection: vi.fn(),
			getConnections: vi.fn(() => []),
			getConnectionIncarnation: vi.fn(() => 0),
			normalizeClusterUrl: vi.fn((value: string) => value),
		},
		{
			globalStorageUri: vscode.Uri.file('C:\\storage'),
			globalState: { get: vi.fn(() => undefined), update: vi.fn(async () => undefined) },
			extensionMode: vscode.ExtensionMode.Test,
		},
		{
			connectionManager: { getConnection: vi.fn(), getConnections: vi.fn(() => []) },
			client: {},
		},
	];
	while (constructorArgs.length < 45) constructorArgs.push(undefined);
	constructorArgs.push(kustoSchemaRequestApplication);
	const provider = Reflect.construct(QueryEditorProvider, constructorArgs) as QueryEditorProvider;
	const transport = vi.fn(async () => true);
	Object.assign(provider, { postMessage: transport, panel: {}, _panelDisposed: false });
	vi.clearAllMocks();
	return { provider, transport };
}

function createMessages(): readonly IncomingWebviewMessage[] {
	return [
		{
			type: 'prefetchSchema',
			connectionId: 'connection-exact',
			database: 'ExactDb',
			boxId: 'query-box-exact',
			forceRefresh: true,
			requestToken: 'prefetch-request-exact',
			cacheOnly: true,
			silent: true,
			reason: 'explicit-refresh',
			sectionInstanceId: 'section-instance-exact',
			targetGeneration: 17,
		},
		{
			type: 'requestCrossClusterSchema',
			clusterName: 'https://exact.kusto.windows.net',
			database: 'ExactDb',
			boxId: 'query-box-exact',
			requestToken: 'request-token-exact',
			requestSource: 'autocomplete',
			traceId: 'trace-exact',
		},
	];
}

function expectNoDirectEffects(transport: ReturnType<typeof vi.fn>): void {
	expect(schemaEffects.prefetchSchema).not.toHaveBeenCalled();
	expect(schemaEffects.handleCrossClusterSchemaRequest).not.toHaveBeenCalled();
	expect(transport).not.toHaveBeenCalled();
}

describe('QueryEditorProvider Kusto schema request application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('reference-identically forwards cross-cluster schema and awaits settlement without direct schema or transport effects', async () => {
		const settlement = deferred<void>();
		const handler: StructuralKustoSchemaRequestHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => settlement.promise),
			dispose: vi.fn(),
		};
		const { provider, transport } = createProvider(handler);
		const message = createMessages()[1];
		let settled = false;

		const request = provider.handleWebviewMessage(message);
		void request.finally(() => { settled = true; });
		await Promise.resolve();

		expect(handler.handleMessage).toHaveBeenCalledOnce();
		expect(handler.handleMessage.mock.calls[0][0]).toBe(message);
		expect((provider as unknown as { kustoSchemaRequestApplication: unknown })
			.kustoSchemaRequestApplication).toBe(handler);
		expect(settled).toBe(false);
		expectNoDirectEffects(transport);

		settlement.resolve();
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('reference-identically forwards both Kusto schema routes without direct provider effects', async () => {
		const messages = createMessages();
		const handler: StructuralKustoSchemaRequestHandler = {
			handleMessage: vi.fn(() => Promise.resolve()),
			dispose: vi.fn(),
		};
		const { provider, transport } = createProvider(handler);

		for (const message of messages) {
			await expect(provider.handleWebviewMessage(message)).resolves.toBeUndefined();
		}

		expect(handler.handleMessage).toHaveBeenCalledTimes(messages.length);
		messages.forEach((message, index) => {
			expect(handler.handleMessage.mock.calls[index][0]).toBe(message);
		});
		expectNoDirectEffects(transport);
	});

	it('adopts the injected handler rejection exactly without direct provider effects', async () => {
		const failure = new Error('injected Kusto schema request failed');
		const message = createMessages()[0];
		const handler: StructuralKustoSchemaRequestHandler = {
			handleMessage: vi.fn((candidate: IncomingWebviewMessage) =>
				candidate === message ? Promise.reject(failure) : undefined),
			dispose: vi.fn(),
		};
		const { provider, transport } = createProvider(handler);

		await expect(provider.handleWebviewMessage(message)).rejects.toBe(failure);

		expect(handler.handleMessage).toHaveBeenCalledOnce();
		expect(handler.handleMessage.mock.calls[0][0]).toBe(message);
		expectNoDirectEffects(transport);
	});

	it('removes the provider application switch while preserving SchemaService algorithms', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/kustoSchemaRequestApplicationHandler.ts');
		const schemaSource = readSource('src/host/queryEditorSchema.ts');
		const typesSource = readSource('src/host/queryEditorTypes.ts');

		for (const route of ['prefetchSchema', 'requestCrossClusterSchema']) {
			expect(providerSource).not.toContain(`case '${route}':`);
			expect(handlerSource).toContain(`case '${route}':`);
			expect(typesSource).toContain(`type: '${route}'`);
		}
		expect(providerSource.match(/^\s*case '/gm) ?? []).toHaveLength(0);
		expect(providerSource).not.toContain('this.schema.prefetchSchema(');
		expect(providerSource).not.toContain('this.schema.handleCrossClusterSchemaRequest(');
		expect(providerSource).toContain(
			'readonly kustoSchemaRequestApplication: KustoSchemaRequestApplicationHandler;',
		);
		expect(providerSource).toMatch(
			/sqlEditorLifecycleApplication\?: SqlEditorLifecycleApplicationHandler,\s+kustoSchemaRequestApplication\?: KustoSchemaRequestApplicationHandler,/,
		);
		expect(providerSource).toContain(
			'= this.kustoSchemaRequestApplication?.handleMessage(message);',
		);
		expect(providerSource).toContain('this.kustoSchemaRequestApplication.dispose();');
		expect(schemaSource).toContain('async prefetchSchema(');
		expect(schemaSource).toContain('async handleCrossClusterSchemaRequest(');
	});
});
