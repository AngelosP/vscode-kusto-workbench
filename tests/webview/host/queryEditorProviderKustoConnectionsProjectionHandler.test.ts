import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const projectionEffects = vi.hoisted(() => ({
	getAccounts: vi.fn(async () => []),
	getEditingPreferencesData: vi.fn(() => ({
		type: 'editingPreferencesData' as const,
		revision: 1,
		caretDocsEnabled: true,
		caretDocsEnabledUserSet: false,
		autoTriggerAutocompleteEnabled: true,
		autoTriggerAutocompleteEnabledUserSet: false,
		copilotInlineCompletionsEnabled: true,
		copilotInlineCompletionsEnabledUserSet: false,
	})),
	getCachedDatabases: vi.fn(() => ({})),
	getLastConnectionId: vi.fn(() => undefined),
	getLastDatabase: vi.fn(() => undefined),
	legacySendConnectionsData: vi.fn(async () => undefined),
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
			getAccounts: projectionEffects.getAccounts,
			onDidChange: () => ({ dispose() {} }),
		}),
	},
}));

vi.mock('../../../src/host/editingPreferences', () => ({
	getEditingPreferencesData: projectionEffects.getEditingPreferencesData,
}));

vi.mock('../../../src/host/queryEditorConnection', () => ({
	ConnectionService: class {
		readonly sendConnectionsData = projectionEffects.legacySendConnectionsData;
		readonly getCachedDatabases = projectionEffects.getCachedDatabases;
		readonly getLastConnectionId = projectionEffects.getLastConnectionId;
		readonly getLastDatabase = projectionEffects.getLastDatabase;
		readonly sendDatabases = vi.fn(async () => undefined);
		readonly saveLastSelection = vi.fn(async () => undefined);
	},
}));

vi.mock('../../../src/host/queryEditorSchema', () => ({
	SchemaService: class {},
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

type StructuralKustoConnectionsProjectionHandler = {
	refresh: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
	return { promise, resolve };
}

function createProvider(kustoConnectionsProjectionApplication: StructuralKustoConnectionsProjectionHandler) {
	const globalStateGet = vi.fn();
	const getConnections = vi.fn(() => []);
	const getConnectionIncarnation = vi.fn(() => 0);
	const runWithLeaveNoTraceSnapshotLock = vi.fn();
	const getFavorites = vi.fn(() => []);
	const kustoFavoritesApplication = {
		handleMessage: vi.fn(() => undefined),
		getFavorites,
		activate: vi.fn(),
		dispose: vi.fn(),
	};
	const constructorArgs: unknown[] = [
		vscode.Uri.file('C:\\extension'),
		{
			getConnection: vi.fn(),
			getConnections,
			getConnectionIncarnation,
			normalizeClusterUrl: vi.fn((value: string) => value),
			runWithLeaveNoTraceSnapshotLock,
		},
		{
			globalStorageUri: vscode.Uri.file('C:\\storage'),
			globalState: { get: globalStateGet, update: vi.fn(async () => undefined) },
			extensionMode: vscode.ExtensionMode.Test,
		},
		{
			connectionManager: { getConnection: vi.fn(), getConnections: vi.fn(() => []) },
			client: {},
		},
	];
	while (constructorArgs.length < 24) constructorArgs.push(undefined);
	constructorArgs[23] = kustoFavoritesApplication;
	while (constructorArgs.length < 43) constructorArgs.push(undefined);
	constructorArgs.push(kustoConnectionsProjectionApplication);
	const provider = Reflect.construct(QueryEditorProvider, constructorArgs) as QueryEditorProvider;
	const transport = vi.fn(async () => true);
	Object.assign(provider, { postMessage: transport, panel: {}, _panelDisposed: false });
	vi.clearAllMocks();
	return {
		provider,
		globalStateGet,
		getConnections,
		getConnectionIncarnation,
		runWithLeaveNoTraceSnapshotLock,
		getFavorites,
		transport,
	};
}

describe('QueryEditorProvider Kusto connections projection application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('routes HST-31 getConnections through the injected projection owner and awaits it without direct effects', async () => {
		const message = {
			type: 'getConnections',
			policyRequestId: 'policy-request-exact',
		} satisfies IncomingWebviewMessage;
		const settlement = deferred<boolean>();
		const handler: StructuralKustoConnectionsProjectionHandler = {
			refresh: vi.fn((policyRequestId?: string) => {
				expect(policyRequestId).toBe(message.policyRequestId);
				return settlement.promise;
			}),
			dispose: vi.fn(),
		};
		const {
			provider,
			globalStateGet,
			getConnections,
			getConnectionIncarnation,
			runWithLeaveNoTraceSnapshotLock,
			getFavorites,
			transport,
		} = createProvider(handler);
		const providerState = provider as unknown as Record<string, unknown>;
		const revisionBefore = providerState.connectionsDataRevision;
		const tailBefore = providerState.connectionsDataTail;
		let settled = false;

		const request = provider.handleWebviewMessage(message);
		void request.finally(() => { settled = true; });
		await Promise.resolve();

		expect(handler.refresh).toHaveBeenCalledOnce();
		expect(handler.refresh).toHaveBeenCalledWith(message.policyRequestId);
		expect((provider as unknown as { kustoConnectionsProjectionApplication: unknown })
			.kustoConnectionsProjectionApplication).toBe(handler);
		expect(settled).toBe(false);
		expect(providerState.connectionsDataRevision).toBe(revisionBefore);
		expect(providerState.connectionsDataTail).toBe(tailBefore);
		expect(projectionEffects.getEditingPreferencesData).not.toHaveBeenCalled();
		expect(globalStateGet).not.toHaveBeenCalled();
		expect(projectionEffects.legacySendConnectionsData).not.toHaveBeenCalled();
		expect(projectionEffects.getAccounts).not.toHaveBeenCalled();
		expect(getConnections).not.toHaveBeenCalled();
		expect(getConnectionIncarnation).not.toHaveBeenCalled();
		expect(projectionEffects.getCachedDatabases).not.toHaveBeenCalled();
		expect(getFavorites).not.toHaveBeenCalled();
		expect(runWithLeaveNoTraceSnapshotLock).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();

		settlement.resolve(true);
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('delegates the public refresh trigger to the same owner', async () => {
		const settlement = deferred<boolean>();
		const handler: StructuralKustoConnectionsProjectionHandler = {
			refresh: vi.fn(() => settlement.promise),
			dispose: vi.fn(),
		};
		const {
			provider,
			globalStateGet,
			getConnections,
			runWithLeaveNoTraceSnapshotLock,
			transport,
		} = createProvider(handler);
		let settled = false;

		const refresh = provider.refreshConnectionsData();
		void refresh.finally(() => { settled = true; });
		await Promise.resolve();

		expect(handler.refresh).toHaveBeenCalledOnce();
		expect(handler.refresh).toHaveBeenCalledWith();
		expect(settled).toBe(false);
		expect(globalStateGet).not.toHaveBeenCalled();
		expect(projectionEffects.legacySendConnectionsData).not.toHaveBeenCalled();
		expect(getConnections).not.toHaveBeenCalled();
		expect(runWithLeaveNoTraceSnapshotLock).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();

		settlement.resolve(true);
		await expect(refresh).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('keeps every Kusto snapshot trigger and projection decision in the new owner', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/kustoConnectionsProjectionApplicationHandler.ts');
		const connectionServiceSource = readSource('src/host/queryEditorConnection.ts');
		const browsingSource = readSource('src/host/kustoConnectionBrowsingApplicationHandler.ts');
		const extensionSource = readSource('src/host/extension.ts');

		expect(providerSource).not.toContain('connectionsDataRevision');
		expect(providerSource).not.toContain('connectionsDataTail');
		expect(providerSource).not.toContain('private async sendConnectionsData');
		expect(providerSource).not.toContain("type: 'connectionsData'");
		expect(providerSource).not.toContain('getEditingPreferencesData');
		expect(providerSource.match(/kustoConnectionsProjectionApplication\.refresh\(/g)).toHaveLength(6);
		expect(providerSource).toMatch(
			/persistedResultSanitizationApplication\?: PersistedResultSanitizationApplicationHandler,\s+kustoConnectionsProjectionApplication\?: KustoConnectionsProjectionApplicationHandler,/,
		);
		expect(providerSource).toContain('this.kustoConnectionsProjectionApplication.dispose();');

		expect(connectionServiceSource).not.toContain('async sendConnectionsData(');
		expect(connectionServiceSource).not.toContain('testIsolateKustoConnections');
		expect(connectionServiceSource).toContain('async sendDatabases(');
		expect(connectionServiceSource).toContain('async saveLastSelection(');
		expect(connectionServiceSource).toContain('getCachedDatabases(): Record<string, string[]>');

		expect(handlerSource).toContain('private snapshotRevision = 0;');
		expect(handlerSource).toContain('private snapshotTail: Promise<void> = Promise.resolve();');
		expect(handlerSource).toContain('getEditingPreferencesData(this.options.context)');
		expect(handlerSource).toContain('this.options.authPreferences.getAccounts()');
		expect(handlerSource).toContain('this.options.connectionManager.getConnections()');
		expect(handlerSource).toContain('.getConnectionIncarnation(connection.id)');
		expect(handlerSource).toContain('this.options.getCachedDatabases()');
		expect(handlerSource).toContain('this.options.getFavorites()');
		expect(handlerSource).toContain('runWithLeaveNoTraceSnapshotLock');
		expect(handlerSource).toContain('const message: KustoConnectionsData = {');
		expect(handlerSource).toContain('const captured = this.captureSnapshot(message);');
		expect(handlerSource).toContain('this.options.postKustoPublication(captured)');
		expect(handlerSource.indexOf('const captured = this.captureSnapshot(message);'))
			.toBeLessThan(handlerSource.indexOf('this.options.postKustoPublication(captured)'));
		expect(handlerSource).toContain("type: 'connectionsData'");
		expect(handlerSource).toContain('const attempts = policyRequestId ? 2 : 1;');

		expect(browsingSource).toContain('await this.options.sendConnectionsData(message.policyRequestId);');
		expect(extensionSource).toContain("from './kustoConnectionsProjectionApplicationHandler';");
	});
});