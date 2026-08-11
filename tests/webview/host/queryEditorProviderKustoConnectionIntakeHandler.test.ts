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

vi.mock('../../../src/host/extension', () => ({
	toolOrchestrator: undefined,
}));

import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

type StructuralKustoConnectionIntakeHandler = {
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
	kustoConnectionIntakeApplication: StructuralKustoConnectionIntakeHandler,
	postMessage: ReturnType<typeof vi.fn>,
): {
	provider: QueryEditorProvider;
	legacyAddConnectionsForClusters: ReturnType<typeof vi.fn>;
	legacyPromptImportConnectionsXml: ReturnType<typeof vi.fn>;
	legacyImportConnectionsFromXml: ReturnType<typeof vi.fn>;
	refreshConnections: ReturnType<typeof vi.fn>;
} {
	const provider = Reflect.construct(QueryEditorProvider, [
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
		undefined,
		undefined,
		undefined,
		kustoConnectionIntakeApplication,
	]) as QueryEditorProvider;
	const legacyAddConnectionsForClusters = vi.fn(async () => undefined);
	const legacyPromptImportConnectionsXml = vi.fn(async () => undefined);
	const legacyImportConnectionsFromXml = vi.fn(async () => undefined);
	const refreshConnections = vi.fn(async () => undefined);
	Object.assign(provider.connection, {
		addConnectionsForClusters: legacyAddConnectionsForClusters,
		promptImportConnectionsXml: legacyPromptImportConnectionsXml,
		importConnectionsFromXml: legacyImportConnectionsFromXml,
	});
	Object.assign(provider, {
		panel: {
			webview: { postMessage },
		},
		sendConnectionsData: refreshConnections,
	});
	return {
		provider,
		legacyAddConnectionsForClusters,
		legacyPromptImportConnectionsXml,
		legacyImportConnectionsFromXml,
		refreshConnections,
	};
}

describe('QueryEditorProvider Kusto connection-intake application', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('forwards all three exact intake messages without invoking legacy intake, refresh, or transport', async () => {
		const kustoConnectionIntakeApplication: StructuralKustoConnectionIntakeHandler = {
			handleMessage: vi.fn((message: IncomingWebviewMessage) => {
				switch (message.type) {
					case 'addConnectionsForClusters':
					case 'promptImportConnectionsXml':
					case 'importConnectionsFromXml':
						return Promise.resolve();
					default:
						return undefined;
				}
			}),
			dispose: vi.fn(),
		};
		const postMessage = vi.fn(async () => true);
		const {
			provider,
			legacyAddConnectionsForClusters,
			legacyPromptImportConnectionsXml,
			legacyImportConnectionsFromXml,
			refreshConnections,
		} = createProvider(kustoConnectionIntakeApplication, postMessage);
		const addClusters = {
			type: 'addConnectionsForClusters',
			clusterUrls: ['help', 'https://example.kusto.windows.net'],
			boxId: 'query-intake',
		} satisfies IncomingWebviewMessage;
		const promptImport = {
			type: 'promptImportConnectionsXml',
			boxId: 'query-intake',
		} satisfies IncomingWebviewMessage;
		const importConnections = {
			type: 'importConnectionsFromXml',
			boxId: 'query-intake',
			connections: [{
				name: 'Example',
				clusterUrl: 'https://example.kusto.windows.net',
				database: 'Samples',
				authorityId: 'organizations',
			}],
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(addClusters);
		await provider.handleWebviewMessage(promptImport);
		await provider.handleWebviewMessage(importConnections);

		expect(provider.kustoConnectionIntakeApplication).toBe(kustoConnectionIntakeApplication);
		expect(provider.editingPreferencesApplication).not.toBe(kustoConnectionIntakeApplication);
		expect(kustoConnectionIntakeApplication.handleMessage).toHaveBeenCalledTimes(3);
		expect(kustoConnectionIntakeApplication.handleMessage.mock.calls[0][0]).toBe(addClusters);
		expect(kustoConnectionIntakeApplication.handleMessage.mock.calls[1][0]).toBe(promptImport);
		expect(kustoConnectionIntakeApplication.handleMessage.mock.calls[2][0]).toBe(importConnections);
		expect(legacyAddConnectionsForClusters).not.toHaveBeenCalled();
		expect(legacyPromptImportConnectionsXml).not.toHaveBeenCalled();
		expect(legacyImportConnectionsFromXml).not.toHaveBeenCalled();
		expect(refreshConnections).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('awaits accepted intake work and adopts the injected handler rejection exactly', async () => {
		const handled = deferred<void>();
		const kustoConnectionIntakeApplication: StructuralKustoConnectionIntakeHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => handled.promise),
			dispose: vi.fn(),
		};
		const { provider } = createProvider(kustoConnectionIntakeApplication, vi.fn(async () => true));
		let settled = false;
		const request = provider.handleWebviewMessage({
			type: 'addConnectionsForClusters',
			clusterUrls: ['https://example.kusto.windows.net'],
		});
		void request.then(
			() => { settled = true; },
			() => { settled = true; },
		);
		await Promise.resolve();

		expect(settled).toBe(false);
		handled.resolve();
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);

		const failure = new Error('injected Kusto connection-intake handler failed');
		kustoConnectionIntakeApplication.handleMessage.mockImplementationOnce(() => Promise.reject(failure));
		await expect(provider.handleWebviewMessage({
			type: 'importConnectionsFromXml',
			connections: [],
		})).rejects.toBe(failure);
	});

	it('retains only handler injection while refresh ownership, webview parsing, and emitters stay put', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const serviceSource = readSource('src/host/queryEditorConnection.ts');
		const handlerSource = readSource('src/host/kustoConnectionIntakeApplicationHandler.ts');
		const managerSource = readSource('src/host/connectionManager.ts');
		const messageHandlerSource = readSource('src/webview/core/message-handler.ts');
		const controllerSource = readSource('src/webview/sections/query-connection.controller.ts');
		const emitterSource = readSource('src/webview/shared/webview-messages.ts');

		for (const type of [
			'addConnectionsForClusters',
			'promptImportConnectionsXml',
			'importConnectionsFromXml',
		]) {
			expect(providerSource).not.toContain(`case '${type}':`);
			expect(handlerSource).toContain(`case '${type}':`);
			expect(emitterSource).toContain(`type: '${type}'`);
		}
		for (const method of [
			'addConnectionsForClusters',
			'promptImportConnectionsXml',
			'importConnectionsFromXml',
		]) {
			expect(serviceSource).not.toContain(`async ${method}(`);
		}
		expect(providerSource).not.toContain('connectionsDataRevision');
		expect(providerSource).not.toContain('connectionsDataTail');
		expect(providerSource).toContain(
			'refreshConnections: () => this.kustoConnectionsProjectionApplication.refresh()',
		);
		expect(providerSource).toContain('this.kustoConnectionIntakeApplication.dispose();');
		expect(handlerSource).toContain('await this.options.refreshConnections();');
		expect(managerSource).toContain("this.changeEmitter.fire({ type: 'added', connection: { ...newConnection } });");

		expect(messageHandlerSource).toContain('const imported = parseKustoExplorerConnectionsXml(text);');
		expect(messageHandlerSource).toContain("postMessageToHost({ type: 'importConnectionsFromXml', connections: imported, boxId: message.boxId });");
		expect(controllerSource).toContain("type: 'addConnectionsForClusters'");
		expect(controllerSource).toContain("postMessageToHost({ type: 'promptImportConnectionsXml', boxId: this.host.boxId });");
	});
});