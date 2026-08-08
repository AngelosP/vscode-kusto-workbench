import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const lifecycleEffects = vi.hoisted(() => ({
	adoptTarget: vi.fn(() => false),
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
	ConnectionService: class {},
}));

vi.mock('../../../src/host/queryEditorSchema', () => ({
	SchemaService: class {},
}));

vi.mock('../../../src/host/sql/sqlEditorLifecycleCoordinator', () => ({
	SqlEditorLifecycleCoordinator: class {
		readonly adoptTarget = lifecycleEffects.adoptTarget;
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

type StructuralSqlDatabaseDiscoveryHandler = {
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

function createProvider(sqlDatabaseDiscoveryApplication: StructuralSqlDatabaseDiscoveryHandler): {
	provider: QueryEditorProvider;
	getConnection: ReturnType<typeof vi.fn>;
	getDatabases: ReturnType<typeof vi.fn>;
	globalStateGet: ReturnType<typeof vi.fn>;
	globalStateUpdate: ReturnType<typeof vi.fn>;
	postMessage: ReturnType<typeof vi.fn>;
	showWarningMessage: ReturnType<typeof vi.spyOn>;
	showErrorMessage: ReturnType<typeof vi.spyOn>;
	error: ReturnType<typeof vi.fn>;
	warn: ReturnType<typeof vi.fn>;
} {
	const getConnection = vi.fn(() => undefined);
	const getDatabases = vi.fn(async () => [] as string[]);
	const globalStateGet = vi.fn(() => undefined);
	const globalStateUpdate = vi.fn(async () => undefined);
	const provider = Reflect.construct(QueryEditorProvider, [
		vscode.Uri.file('C:\\extension'),
		{ getConnection: vi.fn(), getConnections: vi.fn(() => []) },
		{ globalState: { get: globalStateGet, update: globalStateUpdate } },
		{
			connectionManager: { getConnection, getConnections: vi.fn(() => []) },
			client: { getDatabases },
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
		sqlDatabaseDiscoveryApplication,
	]) as QueryEditorProvider;
	const postMessage = vi.fn(async () => true);
	const error = vi.fn();
	const warn = vi.fn();
	Object.assign(provider, {
		panel: { webview: { postMessage } },
		output: { error, warn },
	});
	const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
	const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
	return {
		provider,
		getConnection,
		getDatabases,
		globalStateGet,
		globalStateUpdate,
		postMessage,
		showWarningMessage,
		showErrorMessage,
		error,
		warn,
	};
}

describe('QueryEditorProvider SQL database discovery application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		lifecycleEffects.adoptTarget.mockClear();
	});

	it('forwards both exact discovery messages without invoking provider-owned effects', async () => {
		const sqlDatabaseDiscoveryApplication: StructuralSqlDatabaseDiscoveryHandler = {
			handleMessage: vi.fn((message: IncomingWebviewMessage) => {
				switch (message.type) {
					case 'getSqlDatabases':
					case 'refreshSqlDatabases':
						return Promise.resolve();
					default:
						return undefined;
				}
			}),
			dispose: vi.fn(),
		};
		const {
			provider,
			getConnection,
			getDatabases,
			globalStateGet,
			globalStateUpdate,
			postMessage,
			showWarningMessage,
			showErrorMessage,
			error,
			warn,
		} = createProvider(sqlDatabaseDiscoveryApplication);
		const passive = {
			type: 'getSqlDatabases',
			sqlConnectionId: 'sql-sales',
			boxId: 'sql-box-1',
			sectionInstanceId: 'sql-instance-1',
			targetGeneration: 7,
		} satisfies IncomingWebviewMessage;
		const refresh = {
			type: 'refreshSqlDatabases',
			sqlConnectionId: 'sql-warehouse',
			boxId: 'sql-box-2',
			sectionInstanceId: 'sql-instance-2',
			targetGeneration: 11,
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(passive);
		await provider.handleWebviewMessage(refresh);

		expect(sqlDatabaseDiscoveryApplication.handleMessage).toHaveBeenCalledTimes(2);
		expect(sqlDatabaseDiscoveryApplication.handleMessage.mock.calls[0][0]).toBe(passive);
		expect(sqlDatabaseDiscoveryApplication.handleMessage.mock.calls[1][0]).toBe(refresh);
		expect((provider as unknown as { sqlDatabaseDiscoveryApplication: unknown }).sqlDatabaseDiscoveryApplication)
			.toBe(sqlDatabaseDiscoveryApplication);
		expect(lifecycleEffects.adoptTarget).not.toHaveBeenCalled();
		expect(getConnection).not.toHaveBeenCalled();
		expect(getDatabases).not.toHaveBeenCalled();
		expect(globalStateGet).not.toHaveBeenCalled();
		expect(globalStateUpdate).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
		expect(showWarningMessage).not.toHaveBeenCalled();
		expect(showErrorMessage).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it('awaits accepted discovery work and adopts the injected handler rejection exactly', async () => {
		const handled = deferred<void>();
		const sqlDatabaseDiscoveryApplication: StructuralSqlDatabaseDiscoveryHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => handled.promise),
			dispose: vi.fn(),
		};
		const { provider } = createProvider(sqlDatabaseDiscoveryApplication);
		let settled = false;
		const request = provider.handleWebviewMessage({
			type: 'getSqlDatabases',
			sqlConnectionId: 'sql-sales',
			boxId: 'sql-box-1',
			sectionInstanceId: 'sql-instance-1',
			targetGeneration: 7,
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

		const failure = new Error('injected SQL database discovery handler failed');
		sqlDatabaseDiscoveryApplication.handleMessage.mockImplementationOnce(() => Promise.reject(failure));
		await expect(provider.handleWebviewMessage({
			type: 'refreshSqlDatabases',
			sqlConnectionId: 'sql-sales',
			boxId: 'sql-box-1',
			sectionInstanceId: 'sql-instance-1',
			targetGeneration: 7,
		})).rejects.toBe(failure);
	});

	it('deletes displaced authority while preserving lifecycle, policy, cache, emitters, and response routing', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/sqlDatabaseDiscoveryApplicationHandler.ts');
		const lifecycleSource = readSource('src/host/sql/sqlEditorLifecycleCoordinator.ts');
		const workbenchSource = readSource('src/host/sql/sqlWorkbenchService.ts');
		const cacheSource = readSource('src/host/sqlDatabaseCache.ts');
		const hostTypesSource = readSource('src/host/queryEditorTypes.ts');
		const emitterSource = readSource('src/webview/sections/sql-section-session.controller.ts');
		const sqlMessageRouterSource = readSource('src/webview/core/sql-section-message-router.ts');

		for (const type of ['getSqlDatabases', 'refreshSqlDatabases']) {
			expect(providerSource).not.toContain(`case '${type}':`);
			expect(handlerSource).toContain(`case '${type}':`);
			expect(hostTypesSource).toContain(`type: '${type}'`);
			expect(emitterSource).toContain(`type: '${type}'`);
		}
		for (const displaced of [
			'private async sendSqlDatabases(',
			'private async postSqlConnectionMessageAllowed(',
			'private async postSqlConnectionMessageProtection(',
		]) {
			expect(providerSource).not.toContain(displaced);
			expect(handlerSource).toContain(displaced.replace('private async ', 'private async '));
		}
		expect(providerSource).toContain('readonly sqlDatabaseDiscoveryApplication: SqlDatabaseDiscoveryApplicationHandler;');
		expect(providerSource).toContain('kustoFavoritesApplication?: KustoFavoritesApplicationHandler,');
		expect(providerSource).toContain('sqlDatabaseDiscoveryApplication?: SqlDatabaseDiscoveryApplicationHandler,');
		expect(providerSource).toContain('this.sqlDatabaseDiscoveryApplication.dispose();');
		expect(lifecycleSource).toContain('beginDatabaseRequest(');
		expect(lifecycleSource).toContain('isDatabaseRequestCurrent(');
		expect(lifecycleSource).toContain('isDatabaseSectionOwnerCurrent(');
		expect(workbenchSource).toContain('dispatchSqlOwnerAllowed<T>(');
		expect(workbenchSource).toContain('dispatchSqlOwnerProtection<T>(');
		expect(handlerSource).toContain('beginRequest: beginSqlDatabaseCacheRequest');
		expect(handlerSource).toContain('getOwnedEntry: getOwnedSqlDatabaseCacheEntry');
		expect(handlerSource).toContain('writeOwnedEntry: writeOwnedSqlDatabaseCacheEntry');
		expect(handlerSource).toContain('this.cache.beginRequest(');
		expect(handlerSource).toContain('this.cache.getOwnedEntry(');
		expect(handlerSource).toContain('this.cache.writeOwnedEntry(');
		expect(cacheSource).toContain('export async function beginSqlDatabaseCacheRequest(');
		expect(cacheSource).toContain('export async function writeOwnedSqlDatabaseCacheEntry(');
		expect(providerSource).toContain("type: 'sqlConnectionsData'");
		expect(providerSource).toContain('sqlFavorites: this.sqlFavoritesApplication.getFavorites()');
		expect(sqlMessageRouterSource).toContain("case 'sqlDatabasesLoading':");
		expect(sqlMessageRouterSource).toContain("case 'sqlDatabasesData':");
		expect(sqlMessageRouterSource).toContain("case 'sqlDatabasesError':");
	});
});