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

type StructuralSqlFavoritesHandler = {
	handleMessage: ReturnType<typeof vi.fn>;
	getFavorites: ReturnType<typeof vi.fn>;
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

function createProvider(sqlFavoritesApplication: StructuralSqlFavoritesHandler): {
	provider: QueryEditorProvider;
	showInputBox: ReturnType<typeof vi.spyOn>;
	getConnection: ReturnType<typeof vi.fn>;
	globalStateGet: ReturnType<typeof vi.fn>;
	globalStateUpdate: ReturnType<typeof vi.fn>;
	sendSqlConnectionsData: ReturnType<typeof vi.fn>;
	postMessage: ReturnType<typeof vi.fn>;
	warn: ReturnType<typeof vi.fn>;
	legacyPromptAddSqlFavorite: ReturnType<typeof vi.fn>;
	legacyRemoveSqlFavorite: ReturnType<typeof vi.fn>;
} {
	const getConnection = vi.fn(() => ({
		id: 'sql_sales',
		name: 'Sales SQL',
		serverUrl: 'sales.database.windows.net',
	}));
	const globalStateGet = vi.fn(() => []);
	const globalStateUpdate = vi.fn(async () => undefined);
	const provider = Reflect.construct(QueryEditorProvider, [
		vscode.Uri.file('C:\\extension'),
		{},
		{
			globalState: { get: globalStateGet, update: globalStateUpdate },
		},
		{
			connectionManager: { getConnection, getConnections: vi.fn(() => []) },
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
		sqlFavoritesApplication,
	]) as QueryEditorProvider;
	const postMessage = vi.fn(async () => true);
	const sendSqlConnectionsData = vi.fn(async () => true);
	const warn = vi.fn();
	const legacyPromptAddSqlFavorite = vi.fn(async () => undefined);
	const legacyRemoveSqlFavorite = vi.fn(async () => undefined);
	Object.assign(provider, {
		panel: { webview: { postMessage } },
		sendSqlConnectionsData,
		output: { warn },
	});
	Object.assign(provider.connection, {
		promptAddSqlFavorite: legacyPromptAddSqlFavorite,
		removeSqlFavorite: legacyRemoveSqlFavorite,
	});
	const showInputBox = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined);
	return {
		provider,
		showInputBox,
		getConnection,
		globalStateGet,
		globalStateUpdate,
		sendSqlConnectionsData,
		postMessage,
		warn,
		legacyPromptAddSqlFavorite,
		legacyRemoveSqlFavorite,
	};
}

describe('QueryEditorProvider SQL favorites application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('forwards both exact SQL favorites messages without invoking provider-owned effects', async () => {
		const sqlFavoritesApplication: StructuralSqlFavoritesHandler = {
			handleMessage: vi.fn((message: IncomingWebviewMessage) => {
				switch (message.type) {
					case 'requestAddSqlFavorite':
					case 'removeSqlFavorite':
						return Promise.resolve();
					default:
						return undefined;
				}
			}),
			getFavorites: vi.fn(() => []),
			dispose: vi.fn(),
		};
		const {
			provider,
			showInputBox,
			getConnection,
			globalStateGet,
			globalStateUpdate,
			sendSqlConnectionsData,
			postMessage,
			warn,
			legacyPromptAddSqlFavorite,
			legacyRemoveSqlFavorite,
		} = createProvider(sqlFavoritesApplication);
		const add = {
			type: 'requestAddSqlFavorite',
			connectionId: ' sql_sales ',
			database: ' SalesDb ',
			defaultName: ' Sales favorite ',
			boxId: 'sql-box-1',
		} satisfies IncomingWebviewMessage;
		const remove = {
			type: 'removeSqlFavorite',
			connectionId: ' sql_sales ',
			database: ' SALESDB ',
			boxId: 'sql-box-2',
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(add);
		await provider.handleWebviewMessage(remove);

		expect(sqlFavoritesApplication.handleMessage).toHaveBeenCalledTimes(2);
		expect(sqlFavoritesApplication.handleMessage.mock.calls[0][0]).toBe(add);
		expect(sqlFavoritesApplication.handleMessage.mock.calls[1][0]).toBe(remove);
		expect(provider.sqlFavoritesApplication).toBe(sqlFavoritesApplication);
		expect(provider.sqlConnectionOnboardingApplication).not.toBe(sqlFavoritesApplication);
		expect(showInputBox).not.toHaveBeenCalled();
		expect(legacyPromptAddSqlFavorite).not.toHaveBeenCalled();
		expect(legacyRemoveSqlFavorite).not.toHaveBeenCalled();
		expect(getConnection).not.toHaveBeenCalled();
		expect(globalStateGet).not.toHaveBeenCalled();
		expect(globalStateUpdate).not.toHaveBeenCalled();
		expect(sendSqlConnectionsData).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it('awaits accepted SQL favorites work and adopts the injected handler rejection exactly', async () => {
		const handled = deferred<void>();
		const sqlFavoritesApplication: StructuralSqlFavoritesHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => handled.promise),
			getFavorites: vi.fn(() => []),
			dispose: vi.fn(),
		};
		const { provider } = createProvider(sqlFavoritesApplication);
		let settled = false;
		const request = provider.handleWebviewMessage({
			type: 'requestAddSqlFavorite', connectionId: 'sql_sales', database: 'SalesDb',
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

		const failure = new Error('injected SQL favorites handler failed');
		sqlFavoritesApplication.handleMessage.mockImplementationOnce(() => Promise.reject(failure));
		await expect(provider.handleWebviewMessage({
			type: 'removeSqlFavorite', connectionId: 'sql_sales', database: 'SalesDb',
		})).rejects.toBe(failure);
	});

	it('deletes displaced authority while preserving SQL projection, Connection Manager routes, and message shapes', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const connectionSource = readSource('src/host/queryEditorConnection.ts');
		const handlerSource = readSource('src/host/sqlFavoritesApplicationHandler.ts');
		const projectionSource = readSource('src/host/sqlConnectionsProjectionApplicationHandler.ts');
		const helpersSource = readSource('src/host/connectionManagerFavorites.ts');
		const managerViewerSource = readSource('src/host/connectionManagerViewer.ts');
		const hostTypesSource = readSource('src/host/queryEditorTypes.ts');
		const emitterSource = readSource('src/webview/shared/webview-messages.ts');
		const sectionFactorySource = readSource('src/webview/core/section-factory.ts');
		const messageHandlerSource = readSource('src/webview/core/message-handler.ts');

		for (const type of ['requestAddSqlFavorite', 'removeSqlFavorite']) {
			expect(providerSource).not.toContain(`case '${type}':`);
			expect(handlerSource).toContain(`case '${type}':`);
			expect(hostTypesSource).toContain(`type: '${type}'`);
			expect(emitterSource).toContain(`type: '${type}'`);
		}
		expect(connectionSource).not.toContain('getSqlFavorites(');
		expect(connectionSource).not.toContain('setSqlFavorites(');
		expect(connectionSource).not.toContain('sendSqlFavoritesData(');
		expect(connectionSource).not.toContain('promptAddSqlFavorite(');
		expect(connectionSource).not.toContain('addOrUpdateSqlFavorite(');
		expect(connectionSource).not.toContain('removeSqlFavorite(');
		expect(providerSource).not.toContain('private _sqlConnectionsSnapshotRevision');
		expect(providerSource).not.toContain('private sqlConnectionsSnapshotTail');
		expect(providerSource).not.toContain('private async sendSqlConnectionsData(');
		expect(providerSource).toContain('getFavorites: () => this.sqlFavoritesApplication.getFavorites()');
		expect(projectionSource).toContain('this.options.getFavorites()');
		expect(providerSource).toContain('this.sqlFavoritesApplication.dispose();');
		expect(handlerSource).toContain('sanitizeSqlFavorites');
		expect(handlerSource).toContain('getSqlFavoriteKey');
		expect(handlerSource).toContain('removeSqlFavorite');
		expect(handlerSource).toContain("this.options.globalState.update(STORAGE_KEYS.sqlFavorites, favorites)");
		expect(handlerSource).toContain("type: 'sqlFavoritesData'");
		expect(helpersSource).toContain('export function upsertSqlFavorite(');
		expect(helpersSource).toContain('export function removeSqlFavorite(');
		expect(managerViewerSource).toContain("case 'sql.favorite.promptAdd':");
		expect(managerViewerSource).toContain("case 'sql.favorite.remove':");
		expect(managerViewerSource).toContain('upsertSqlFavorite(this.getSqlFavorites()');
		expect(managerViewerSource).toContain('removeSqlFavorite(this.getSqlFavorites()');
		expect(sectionFactorySource).toContain("type: 'requestAddSqlFavorite'");
		expect(sectionFactorySource).toContain("type: 'removeSqlFavorite'");
		expect(messageHandlerSource).toContain("case 'sqlFavoritesData':");
	});
});
