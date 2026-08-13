import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const projectionEffects = vi.hoisted(() => ({
	readDatabaseCache: vi.fn(async () => undefined),
	lifecycleRefresh: undefined as (() => Promise<boolean>) | undefined,
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
		readonly executionBroker = {};
		constructor(options: { effects: { refreshConnectionsData: () => Promise<boolean> } }) {
			projectionEffects.lifecycleRefresh = options.effects.refreshConnectionsData;
		}
		startSession(): void {}
	},
}));

vi.mock('../../../src/host/queryEditorCopilot', () => ({
	CopilotService: class {},
}));

vi.mock('../../../src/host/kustoConnectionLifecycle', () => ({
	KustoConnectionLifecycle: class {},
}));

vi.mock('../../../src/host/sqlDatabaseCache', async importOriginal => ({
	...await importOriginal<typeof import('../../../src/host/sqlDatabaseCache')>(),
	getOwnedSqlDatabaseCacheEntry: projectionEffects.readDatabaseCache,
}));

vi.mock('../../../src/host/extension', () => ({
	toolOrchestrator: undefined,
}));

import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

type StructuralSqlConnectionsProjectionHandler = {
	handleMessage: ReturnType<typeof vi.fn>;
	refresh: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
	return { promise, resolve };
}

function createProvider(sqlConnectionsProjectionApplication: StructuralSqlConnectionsProjectionHandler) {
	const sqlConnection = {
		id: 'sql-exact',
		name: 'Exact SQL',
		dialect: 'mssql',
		serverUrl: 'server.example',
		port: 1433,
		database: 'ExactDb',
		authType: 'sql-login',
		username: 'exact-user',
	};
	const sqlGetConnections = vi.fn(() => [sqlConnection]);
	const globalStateGet = vi.fn();
	const dispatchSqlOwnerSnapshot = vi.fn(async (dispatch: (snapshot: unknown) => unknown) => dispatch({
		policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {} },
		connections: [sqlConnection],
		connectionVersion: 1,
		accountsByServer: {},
		principalVersion: 1,
	}));
	const sqlFavoritesGet = vi.fn(() => []);
	const sqlFavoritesApplication = {
		handleMessage: vi.fn(),
		getFavorites: sqlFavoritesGet,
		dispose: vi.fn(),
	};
	const transport = vi.fn(async () => true);
	const constructorArgs: unknown[] = [
		vscode.Uri.file('C:\\extension'),
		{ getConnection: vi.fn(), getConnections: vi.fn(() => []) },
		{
			globalStorageUri: vscode.Uri.file('C:\\storage'),
			globalState: { get: globalStateGet, update: vi.fn(async () => undefined) },
			extensionMode: vscode.ExtensionMode.Test,
		},
		{
			connectionManager: {
				getConnection: vi.fn(),
				getConnections: sqlGetConnections,
			},
			client: {},
			leaveNoTracePolicy: { getRevocationGeneration: vi.fn(() => 0) },
			dispatchSqlOwnerSnapshot,
		},
	];
	while (constructorArgs.length < 22) constructorArgs.push(undefined);
	constructorArgs.push(sqlFavoritesApplication);
	while (constructorArgs.length < 41) constructorArgs.push(undefined);
	constructorArgs.push(sqlConnectionsProjectionApplication);
	const provider = Reflect.construct(QueryEditorProvider, constructorArgs) as QueryEditorProvider;
	Object.assign(provider, { postMessage: transport, panel: {} });
	vi.clearAllMocks();
	return {
		provider,
		sqlGetConnections,
		globalStateGet,
		dispatchSqlOwnerSnapshot,
		sqlFavoritesGet,
		transport,
	};
}

describe('QueryEditorProvider SQL connections projection application', () => {
	afterEach(() => {
		projectionEffects.lifecycleRefresh = undefined;
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('reference-identically forwards and awaits the exact projection request without direct effects', async () => {
		const message: IncomingWebviewMessage = { type: 'getSqlConnections' };
		const settlement = deferred<void>();
		const handler: StructuralSqlConnectionsProjectionHandler = {
			handleMessage: vi.fn((candidate: IncomingWebviewMessage) =>
				candidate === message ? settlement.promise : undefined),
			refresh: vi.fn(),
			dispose: vi.fn(),
		};
		const {
			provider,
			sqlGetConnections,
			globalStateGet,
			dispatchSqlOwnerSnapshot,
			sqlFavoritesGet,
			transport,
		} = createProvider(handler);
		let settled = false;
		const request = provider.handleWebviewMessage(message);
		void request.finally(() => { settled = true; });
		await Promise.resolve();

		expect(handler.handleMessage).toHaveBeenCalledOnce();
		expect(handler.handleMessage.mock.calls[0][0]).toBe(message);
		expect((provider as unknown as { sqlConnectionsProjectionApplication: unknown })
			.sqlConnectionsProjectionApplication).toBe(handler);
		expect(settled).toBe(false);
		expect(sqlGetConnections).not.toHaveBeenCalled();
		expect(globalStateGet).not.toHaveBeenCalled();
		expect(dispatchSqlOwnerSnapshot).not.toHaveBeenCalled();
		expect(sqlFavoritesGet).not.toHaveBeenCalled();
		expect(projectionEffects.readDatabaseCache).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();

		settlement.resolve(undefined);
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('delegates public and lifecycle refresh triggers to the same owner', async () => {
		const handler: StructuralSqlConnectionsProjectionHandler = {
			handleMessage: vi.fn(),
			refresh: vi.fn(async () => true),
			dispose: vi.fn(),
		};
		const {
			provider,
			sqlGetConnections,
			globalStateGet,
			dispatchSqlOwnerSnapshot,
			sqlFavoritesGet,
			transport,
		} = createProvider(handler);

		await expect(provider.refreshSqlConnectionsData()).resolves.toBeUndefined();
		await expect(projectionEffects.lifecycleRefresh?.()).resolves.toBe(true);

		expect(handler.refresh).toHaveBeenCalledTimes(2);
		expect(sqlGetConnections).not.toHaveBeenCalled();
		expect(globalStateGet).not.toHaveBeenCalled();
		expect(dispatchSqlOwnerSnapshot).not.toHaveBeenCalled();
		expect(sqlFavoritesGet).not.toHaveBeenCalled();
		expect(projectionEffects.readDatabaseCache).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();
	});

	it('keeps SQL connections projection authority out of the provider', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const providerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/queryEditorProvider.ts'),
			'utf8',
		);
		const handlerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/sqlConnectionsProjectionApplicationHandler.ts'),
			'utf8',
		);

		expect(providerSource).not.toContain("case 'getSqlConnections':");
		expect(providerSource).not.toContain("type: 'sqlConnectionsData'");
		expect(providerSource).not.toContain('sqlConnectionsSnapshotTail');
		expect(providerSource).not.toContain('_sqlConnectionsSnapshotRevision');
		expect(providerSource).not.toContain('publishSqlConnectionsDataSnapshot');
		expect(providerSource).not.toContain('sendSqlConnectionsData');
		expect(providerSource.match(/sqlConnectionsProjectionApplication\.refresh\(\)/g)).toHaveLength(3);
		expect(providerSource).toContain('this.sqlConnectionsProjectionApplication.dispose();');
		expect(handlerSource.indexOf('admitSqlConnectionsProjectionWebviewMessage(message)'))
			.toBeLessThan(handlerSource.indexOf('return this.refresh().then('));
		expect(handlerSource).toContain("type: 'sqlConnectionsData'");
		expect(handlerSource).toContain('private snapshotTail: Promise<boolean> = Promise.resolve(true);');
		expect(handlerSource).toContain('this.options.workbench.dispatchSqlOwnerSnapshot');
		expect(handlerSource).toContain('this.options.readDatabaseCache(connection)');
		expect(handlerSource).toContain('this.options.getFavorites()');
	});
});
