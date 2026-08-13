import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const connectionServiceMocks = vi.hoisted(() => ({
	sendDatabases: vi.fn(async () => undefined),
	saveLastSelection: vi.fn(async () => undefined),
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

vi.mock('../../../src/host/queryEditorConnection', () => ({
	ConnectionService: class {
		readonly sendDatabases = connectionServiceMocks.sendDatabases;
		readonly saveLastSelection = connectionServiceMocks.saveLastSelection;
	},
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

type StructuralKustoConnectionBrowsingHandler = {
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
	kustoConnectionBrowsingApplication: StructuralKustoConnectionBrowsingHandler,
): {
	provider: QueryEditorProvider;
	sendConnectionsData: ReturnType<typeof vi.fn>;
	executeCommand: ReturnType<typeof vi.spyOn>;
} {
	const developmentNoteMutationApplication = {
		updateDevelopmentNotes: vi.fn(async () => ({ success: true })),
		handleMessage: vi.fn(() => false),
		dispose: vi.fn(),
	};
	const workbenchToolSessionApplication = {
		activate: vi.fn(),
		handleMessage: vi.fn(() => undefined),
		requestSectionsFromWebview: vi.fn(),
		dispose: vi.fn(),
	};
	const provider = Reflect.construct(QueryEditorProvider, [
		vscode.Uri.file('C:\\extension'),
		{ getConnection: vi.fn(), getConnections: vi.fn(() => []) },
		{ globalState: { get: vi.fn(), update: vi.fn(async () => undefined) } },
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
		{ handleMessage: vi.fn(() => undefined), dispose: vi.fn() },
		{ handleMessage: vi.fn(() => undefined), dispose: vi.fn() },
		{ handleMessage: vi.fn(() => undefined), dispose: vi.fn() },
		{ handleMessage: vi.fn(() => undefined), dispose: vi.fn() },
		{ handleMessage: vi.fn(() => undefined), dispose: vi.fn() },
		{ handleMessage: vi.fn(() => undefined), dispose: vi.fn() },
		workbenchToolSessionApplication,
		kustoConnectionBrowsingApplication,
	]) as QueryEditorProvider;
	const sendConnectionsData = vi.fn(async () => undefined);
	(provider as unknown as { sendConnectionsData: typeof sendConnectionsData }).sendConnectionsData
		= sendConnectionsData;
	const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
	connectionServiceMocks.sendDatabases.mockClear();
	connectionServiceMocks.saveLastSelection.mockClear();
	return { provider, sendConnectionsData, executeCommand };
}

describe('QueryEditorProvider Kusto connection browsing application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('reference-identically forwards all four routes and leaves direct effects untouched', async () => {
		const routeSettlements = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
		const messages = [
			{
				type: 'getConnections',
				policyRequestId: 'policy-request-exact',
			},
			{
				type: 'getDatabases',
				connectionId: 'passive-connection-exact',
				boxId: 'passive-box-exact',
				requestToken: 'passive-token-exact',
				requiredDatabase: 'PassiveDatabaseExact',
				sectionInstanceId: 'passive-section-exact',
				targetGeneration: 17,
			},
			{
				type: 'refreshDatabases',
				connectionId: 'refresh-connection-exact',
				boxId: 'refresh-box-exact',
				requestToken: 'refresh-token-exact',
				requiredDatabase: 'RefreshDatabaseExact',
				sectionInstanceId: 'refresh-section-exact',
				targetGeneration: 23,
			},
			{
				type: 'saveLastSelection',
				connectionId: ' selection-connection-exact ',
				database: '',
			},
		] satisfies IncomingWebviewMessage[];
		const kustoConnectionBrowsingApplication: StructuralKustoConnectionBrowsingHandler = {
			handleMessage: vi.fn((candidate: IncomingWebviewMessage) => {
				const index = messages.indexOf(candidate);
				return index >= 0 ? routeSettlements[index].promise : undefined;
			}),
			dispose: vi.fn(),
		};
		const { provider, sendConnectionsData, executeCommand } = createProvider(
			kustoConnectionBrowsingApplication,
		);
		const settled = [false, false, false, false];

		const requests = messages.map((message, index) => {
			const request = provider.handleWebviewMessage(message);
			void request.finally(() => { settled[index] = true; });
			return request;
		});
		await Promise.resolve();

		expect(kustoConnectionBrowsingApplication.handleMessage).toHaveBeenCalledTimes(4);
		messages.forEach((message, index) => {
			expect(kustoConnectionBrowsingApplication.handleMessage.mock.calls[index][0]).toBe(message);
		});
		expect((provider as unknown as { kustoConnectionBrowsingApplication: unknown })
			.kustoConnectionBrowsingApplication).toBe(kustoConnectionBrowsingApplication);
		expect(settled).toEqual([false, false, false, false]);
		expect(sendConnectionsData).not.toHaveBeenCalled();
		expect(connectionServiceMocks.sendDatabases).not.toHaveBeenCalled();
		expect(connectionServiceMocks.saveLastSelection).not.toHaveBeenCalled();
		expect(executeCommand).not.toHaveBeenCalled();

		routeSettlements.forEach(settlement => settlement.resolve());
		await expect(Promise.all(requests)).resolves.toEqual([undefined, undefined, undefined, undefined]);
		expect(settled).toEqual([true, true, true, true]);
	});

	it('adopts the injected rejection exactly without direct effects', async () => {
		const failure = new Error('injected Kusto connection browsing handler failed');
		const message = {
			type: 'saveLastSelection',
			connectionId: 'selection-rejection-exact',
			database: 'SelectionDatabaseExact',
		} satisfies IncomingWebviewMessage;
		const kustoConnectionBrowsingApplication: StructuralKustoConnectionBrowsingHandler = {
			handleMessage: vi.fn((candidate: IncomingWebviewMessage) =>
				candidate === message ? Promise.reject(failure) : undefined),
			dispose: vi.fn(),
		};
		const { provider, sendConnectionsData, executeCommand } = createProvider(
			kustoConnectionBrowsingApplication,
		);

		await expect(provider.handleWebviewMessage(message)).rejects.toBe(failure);

		expect(kustoConnectionBrowsingApplication.handleMessage).toHaveBeenCalledOnce();
		expect(kustoConnectionBrowsingApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect(sendConnectionsData).not.toHaveBeenCalled();
		expect(connectionServiceMocks.sendDatabases).not.toHaveBeenCalled();
		expect(connectionServiceMocks.saveLastSelection).not.toHaveBeenCalled();
		expect(executeCommand).not.toHaveBeenCalled();
	});

	it('deletes displaced provider authority while preserving canonical services and compatibility behavior', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/kustoConnectionBrowsingApplicationHandler.ts');
		const connectionServiceSource = readSource('src/host/queryEditorConnection.ts');
		const compatibilitySource = readSource('src/host/kqlCompatEditorProvider.ts');
		const extensionSource = readSource('src/host/extension.ts');
		const typesSource = readSource('src/host/queryEditorTypes.ts');
		const protocolSource = readSource('src/shared/kustoConnectionsProjectionProtocol.ts');

		expect(providerSource).not.toContain("case 'getConnections':");
		expect(providerSource).not.toContain("case 'getDatabases':");
		expect(providerSource).not.toContain("case 'refreshDatabases':");
		expect(providerSource).not.toContain("case 'saveLastSelection':");
		expect(providerSource).toContain(
			'readonly kustoConnectionBrowsingApplication: KustoConnectionBrowsingApplicationHandler;',
		);
		expect(providerSource).toMatch(
			/workbenchToolSessionApplication\?: WorkbenchToolSessionApplicationHandler,\s+kustoConnectionBrowsingApplication\?: KustoConnectionBrowsingApplicationHandler,/,
		);
		expect(providerSource).toContain(
			'= this.kustoConnectionBrowsingApplication?.handleMessage(message);',
		);
		expect(providerSource).toContain('this.kustoConnectionBrowsingApplication.dispose();');

		expect(handlerSource).not.toContain("case 'getConnections':");
		expect(handlerSource).not.toContain("case 'getDatabases':");
		expect(handlerSource).not.toContain("case 'refreshDatabases':");
		expect(handlerSource).toContain("case 'saveLastSelection':");
		expect(handlerSource).toContain('admitKustoConnectionsProjectionWebviewMessage(message)');
		expect(handlerSource.indexOf('admitKustoConnectionsProjectionWebviewMessage(message)'))
			.toBeLessThan(handlerSource.indexOf('this.options.sendConnectionsData('));
		expect(handlerSource).toContain('parseKustoDatabaseDiscoveryWebviewMessage(message)');
		expect(handlerSource).toContain("parsed.value.type === 'getDatabases' ? 'passive' : 'interactive-refresh'");
		expect(handlerSource.indexOf('parseKustoDatabaseDiscoveryWebviewMessage(message)'))
			.toBeLessThan(handlerSource.indexOf('this.options.sendDatabases('));
		expect(handlerSource).toContain('await this.options.saveLastSelection(connectionId, message.database);');
		expect(handlerSource).toContain('await this.options.refreshTextEditorDiagnostics();');

		expect(connectionServiceSource).toContain('class ConnectionService');
		expect(connectionServiceSource).toContain('async sendDatabases(');
		expect(connectionServiceSource).toContain('async saveLastSelection(');
		expect(connectionServiceSource).toContain('KustoConnectionCache');
		expect(connectionServiceSource).toContain('getDatabasesWithIdentity');
		expect(connectionServiceSource).toContain('traceDatabaseList');
		expect(connectionServiceSource).toContain('postMessage(message: KustoDatabaseDiscoveryHostMessage)');

		const compatibilitySelection = compatibilitySource.indexOf("case 'saveLastSelection':");
		const compatibilityCache = compatibilitySource.indexOf('setFileConnection(', compatibilitySelection);
		const compatibilityInference = compatibilitySource.indexOf('inferredSelection = {', compatibilityCache);
		const compatibilityForward = compatibilitySource.indexOf(
			'await queryEditor.handleWebviewMessage(message as any);',
			compatibilityInference,
		);
		expect(compatibilitySelection).toBeGreaterThanOrEqual(0);
		expect(compatibilityCache).toBeGreaterThan(compatibilitySelection);
		expect(compatibilityInference).toBeGreaterThan(compatibilityCache);
		expect(compatibilityForward).toBeGreaterThan(compatibilityInference);

		expect(extensionSource).toContain(
			"vscode.commands.registerCommand('kusto.refreshTextEditorDiagnostics'",
		);
		expect(typesSource).toContain('| KustoConnectionsProjectionWebviewMessage');
		expect(typesSource).not.toContain("type: 'getConnections'; policyRequestId?: string");
		expect(protocolSource).toContain("type: 'getConnections';");
		expect(protocolSource).toContain('policyRequestId?: string;');
		expect(typesSource).toContain('| KustoDatabaseDiscoveryWebviewMessage');
		expect(typesSource).not.toContain("type: 'getDatabases'");
		expect(typesSource).not.toContain("type: 'refreshDatabases'");
		expect(typesSource).toContain("type: 'saveLastSelection'; connectionId: string; database?: string");
	});
});
