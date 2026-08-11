import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const connectionServiceEffects = vi.hoisted(() => ({
	broadcastKustoFavoritesData: vi.fn(),
	onKustoFavoritesChanged: vi.fn(),
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
	KqlLanguageServiceHost: class {},
}));

vi.mock('../../../src/host/queryEditorConnection', () => ({
	ConnectionService: class {
		static broadcastKustoFavoritesData = connectionServiceEffects.broadcastKustoFavoritesData;
		static onKustoFavoritesChanged = connectionServiceEffects.onKustoFavoritesChanged;
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

type StructuralKustoFavoritesHandler = {
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

function createProvider(kustoFavoritesApplication: StructuralKustoFavoritesHandler): {
	provider: QueryEditorProvider;
	showInputBox: ReturnType<typeof vi.spyOn>;
	showWarningMessage: ReturnType<typeof vi.spyOn>;
	getConnection: ReturnType<typeof vi.fn>;
	getAccountPartition: ReturnType<typeof vi.fn>;
	globalStateGet: ReturnType<typeof vi.fn>;
	globalStateUpdate: ReturnType<typeof vi.fn>;
	sendConnectionsData: ReturnType<typeof vi.fn>;
	postMessage: ReturnType<typeof vi.fn>;
	warn: ReturnType<typeof vi.fn>;
	legacyPromptAddFavorite: ReturnType<typeof vi.fn>;
	legacyRemoveFavorite: ReturnType<typeof vi.fn>;
	legacyConfirmRemoveFavorite: ReturnType<typeof vi.fn>;
} {
	const getConnection = vi.fn(() => ({
		id: 'kusto_sales',
		name: 'Sales Kusto',
		clusterUrl: 'https://sales.kusto.windows.net',
	}));
	const getAccountPartition = vi.fn(() => 'tenant-a|authority-a');
	const globalStateGet = vi.fn(() => []);
	const globalStateUpdate = vi.fn(async () => undefined);
	const provider = Reflect.construct(QueryEditorProvider, [
		vscode.Uri.file('C:\\extension'),
		{ getConnection, getConnections: vi.fn(() => []) },
		{
			globalState: { get: globalStateGet, update: globalStateUpdate },
		},
		{
			connectionManager: { getConnection: vi.fn(), getConnections: vi.fn(() => []) },
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
		kustoFavoritesApplication,
	]) as QueryEditorProvider;
	const postMessage = vi.fn(async () => true);
	const sendConnectionsData = vi.fn(async () => true);
	const warn = vi.fn();
	const legacyPromptAddFavorite = vi.fn(async () => undefined);
	const legacyRemoveFavorite = vi.fn(async () => undefined);
	const legacyConfirmRemoveFavorite = vi.fn(async () => undefined);
	Object.assign(provider, {
		panel: { webview: { postMessage } },
		kustoClient: { getAccountPartition },
		sendConnectionsData,
		output: { warn },
	});
	Object.assign(provider.connection, {
		promptAddFavorite: legacyPromptAddFavorite,
		removeFavorite: legacyRemoveFavorite,
		confirmRemoveFavorite: legacyConfirmRemoveFavorite,
	});
	const showInputBox = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined);
	const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
	return {
		provider,
		showInputBox,
		showWarningMessage,
		getConnection,
		getAccountPartition,
		globalStateGet,
		globalStateUpdate,
		sendConnectionsData,
		postMessage,
		warn,
		legacyPromptAddFavorite,
		legacyRemoveFavorite,
		legacyConfirmRemoveFavorite,
	};
}

describe('QueryEditorProvider Kusto favorites application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		connectionServiceEffects.broadcastKustoFavoritesData.mockClear();
		connectionServiceEffects.onKustoFavoritesChanged.mockClear();
	});

	it('forwards all three exact Kusto favorites messages without invoking legacy effects', async () => {
		const kustoFavoritesApplication: StructuralKustoFavoritesHandler = {
			handleMessage: vi.fn((message: IncomingWebviewMessage) => {
				switch (message.type) {
					case 'requestAddFavorite':
					case 'removeFavorite':
					case 'confirmRemoveFavorite':
						return Promise.resolve();
					default:
						return undefined;
				}
			}),
			dispose: vi.fn(),
		};
		const {
			provider,
			showInputBox,
			showWarningMessage,
			getConnection,
			getAccountPartition,
			globalStateGet,
			globalStateUpdate,
			sendConnectionsData,
			postMessage,
			warn,
			legacyPromptAddFavorite,
			legacyRemoveFavorite,
			legacyConfirmRemoveFavorite,
		} = createProvider(kustoFavoritesApplication);
		const add = {
			type: 'requestAddFavorite',
			connectionId: ' kusto_sales ',
			clusterUrl: ' HTTPS://Sales.Kusto.Windows.Net/ ',
			database: ' SalesDb ',
			defaultName: ' Sales favorite ',
			boxId: 'kusto-box-1',
		} satisfies IncomingWebviewMessage;
		const remove = {
			type: 'removeFavorite',
			connectionId: ' kusto_sales ',
			clusterUrl: ' HTTPS://Sales.Kusto.Windows.Net/ ',
			database: ' SALESDB ',
			boxId: 'kusto-box-2',
		} satisfies IncomingWebviewMessage;
		const confirm = {
			type: 'confirmRemoveFavorite',
			requestId: 'favorite-confirm-1',
			label: ' Sales favorite ',
			connectionId: ' kusto_sales ',
			clusterUrl: ' HTTPS://Sales.Kusto.Windows.Net/ ',
			database: ' SalesDb ',
			boxId: 'kusto-box-3',
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(add);
		await provider.handleWebviewMessage(remove);
		await provider.handleWebviewMessage(confirm);

		expect(kustoFavoritesApplication.handleMessage).toHaveBeenCalledTimes(3);
		expect(kustoFavoritesApplication.handleMessage.mock.calls[0][0]).toBe(add);
		expect(kustoFavoritesApplication.handleMessage.mock.calls[1][0]).toBe(remove);
		expect(kustoFavoritesApplication.handleMessage.mock.calls[2][0]).toBe(confirm);
		expect((provider as unknown as { kustoFavoritesApplication: unknown }).kustoFavoritesApplication)
			.toBe(kustoFavoritesApplication);
		expect(provider.sqlFavoritesApplication).not.toBe(kustoFavoritesApplication);
		expect(showInputBox).not.toHaveBeenCalled();
		expect(showWarningMessage).not.toHaveBeenCalled();
		expect(legacyPromptAddFavorite).not.toHaveBeenCalled();
		expect(legacyRemoveFavorite).not.toHaveBeenCalled();
		expect(legacyConfirmRemoveFavorite).not.toHaveBeenCalled();
		expect(getConnection).not.toHaveBeenCalled();
		expect(getAccountPartition).not.toHaveBeenCalled();
		expect(globalStateGet).not.toHaveBeenCalled();
		expect(globalStateUpdate).not.toHaveBeenCalled();
		expect(connectionServiceEffects.broadcastKustoFavoritesData).not.toHaveBeenCalled();
		expect(connectionServiceEffects.onKustoFavoritesChanged).not.toHaveBeenCalled();
		expect(sendConnectionsData).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it('awaits accepted Kusto favorites work and adopts the injected handler rejection exactly', async () => {
		const handled = deferred<void>();
		const kustoFavoritesApplication: StructuralKustoFavoritesHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => handled.promise),
			dispose: vi.fn(),
		};
		const { provider } = createProvider(kustoFavoritesApplication);
		let settled = false;
		const request = provider.handleWebviewMessage({
			type: 'requestAddFavorite',
			connectionId: 'kusto_sales',
			clusterUrl: 'https://sales.kusto.windows.net',
			database: 'SalesDb',
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

		const failure = new Error('injected Kusto favorites handler failed');
		kustoFavoritesApplication.handleMessage.mockImplementationOnce(() => Promise.reject(failure));
		await expect(provider.handleWebviewMessage({
			type: 'removeFavorite',
			connectionId: 'kusto_sales',
			clusterUrl: 'https://sales.kusto.windows.net',
			database: 'SalesDb',
		})).rejects.toBe(failure);
	});

	it('deletes displaced authority while preserving projection, inference, Connection Manager, and message shapes', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const connectionSource = readSource('src/host/queryEditorConnection.ts');
		const handlerSource = readSource('src/host/kustoFavoritesApplicationHandler.ts');
		const projectionSource = readSource('src/host/kustoConnectionsProjectionApplicationHandler.ts');
		const helpersSource = readSource('src/host/connectionManagerFavorites.ts');
		const managerViewerSource = readSource('src/host/connectionManagerViewer.ts');
		const extensionSource = readSource('src/host/extension.ts');
		const hostTypesSource = readSource('src/host/queryEditorTypes.ts');
		const emitterSource = readSource('src/webview/sections/query-connection.controller.ts');
		const webviewMessagesSource = readSource('src/webview/shared/webview-messages.ts');
		const messageHandlerSource = readSource('src/webview/core/message-handler.ts');

		for (const type of ['requestAddFavorite', 'removeFavorite', 'confirmRemoveFavorite']) {
			expect(providerSource).not.toContain(`case '${type}':`);
			expect(handlerSource).toContain(`case '${type}':`);
			expect(hostTypesSource).toContain(`type: '${type}'`);
			expect(webviewMessagesSource).toContain(`type: '${type}'`);
		}
		for (const displaced of [
			'liveServices',
			'kustoFavoritesListeners',
			'getFavoriteAccountPartitions(',
			'getFavorites()',
			'favoriteKey(',
			'setFavorites(',
			'broadcastKustoFavoritesData(',
			'onKustoFavoritesChanged(',
			'sharesFavoriteStorageWithContext(',
			'logFavoritesBroadcastError(',
			'sendFavoritesData(',
			'promptAddFavorite(',
			'addOrUpdateFavorite(',
			'removeFavorite(',
			'confirmRemoveFavorite(',
		]) {
			expect(connectionSource).not.toContain(displaced);
		}
		expect(projectionSource).toContain('favorites: this.options.getFavorites()');
		expect(connectionSource).toContain('const favorites = this.host.getKustoFavorites();');
		expect(connectionSource).toContain('getKustoFavoriteKey(f.connectionId, f.database)');
		expect(connectionSource).toContain('getKustoFavoriteKey(conn.id, database)');
		expect(providerSource).toContain('readonly kustoFavoritesApplication: KustoFavoritesApplicationHandler;');
		expect(providerSource).toContain('sqlFavoritesApplication?: SqlFavoritesApplicationHandler,');
		expect(providerSource).toContain('kustoFavoritesApplication?: KustoFavoritesApplicationHandler,');
		expect(providerSource).toContain('this.kustoFavoritesApplication.getFavorites()');
		expect(providerSource.match(/this\.kustoFavoritesApplication\.activate\(\);/g)).toHaveLength(2);
		expect(providerSource).toContain('this.kustoFavoritesApplication.dispose();');
		expect(handlerSource).toContain('migrateKustoFavoritesWithStatus');
		expect(handlerSource).toContain('filterKustoFavoritesForActivePrincipals');
		expect(handlerSource).toContain('mergeKustoFavoritesForActivePrincipals');
		expect(handlerSource).toContain('getKustoFavoriteKey');
		expect(handlerSource).toContain('removeKustoFavorite');
		expect(handlerSource).toContain("type: 'favoritesData'");
		expect(handlerSource).toContain("type: 'confirmRemoveFavoriteResult'");
		expect(helpersSource).toContain('export function migrateKustoFavoritesWithStatus(');
		expect(helpersSource).toContain('export function filterKustoFavoritesForActivePrincipals(');
		expect(helpersSource).toContain('export function mergeKustoFavoritesForActivePrincipals(');
		for (const route of [
			'favorite.add', 'favorite.promptAdd', 'favorite.promptRename', 'favorite.remove', 'favorite.reorder',
		]) {
			expect(managerViewerSource).toContain(`case '${route}':`);
		}
		expect(managerViewerSource).toContain('HostKustoFavoritesApplicationHandler.onKustoFavoritesChanged');
		expect(managerViewerSource).toContain('HostKustoFavoritesApplicationHandler.broadcastKustoFavoritesData');
		expect(extensionSource).toContain('HostKustoFavoritesApplicationHandler.broadcastKustoFavoritesData(context);');
		expect(emitterSource).toContain("type: 'requestAddFavorite'");
		expect(emitterSource).toContain("type: 'removeFavorite'");
		expect(messageHandlerSource).toContain("case 'favoritesData':");
		expect(messageHandlerSource).toContain("case 'confirmRemoveFavoriteResult':");
	});
});