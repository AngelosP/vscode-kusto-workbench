import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const lifecycleEffects = vi.hoisted(() => ({
	openSection: vi.fn(),
	retireTarget: vi.fn(() => true),
	handleLanguageRequest: vi.fn(async () => undefined),
	didOpen: vi.fn(),
	didChange: vi.fn(async () => undefined),
	didClose: vi.fn(),
	connect: vi.fn(async () => undefined),
}));

const authEffects = vi.hoisted(() => ({
	clearSqlTokenOverride: vi.fn(async () => undefined),
	setSqlServerAccountMapEntry: vi.fn(async () => undefined),
	setSqlTokenOverride: vi.fn(async () => undefined),
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
	SchemaService: class {},
}));

vi.mock('../../../src/host/sql/sqlEditorLifecycleCoordinator', () => ({
	SqlEditorLifecycleCoordinator: class {
		readonly executionBroker = {};
		readonly openSection = lifecycleEffects.openSection;
		readonly retireTarget = lifecycleEffects.retireTarget;
		readonly handleLanguageRequest = lifecycleEffects.handleLanguageRequest;
		readonly didOpen = lifecycleEffects.didOpen;
		readonly didChange = lifecycleEffects.didChange;
		readonly didClose = lifecycleEffects.didClose;
		readonly connect = lifecycleEffects.connect;
		startSession(): void {}
		listComparisonBoxIds(): string[] { return []; }
	},
}));

vi.mock('../../../src/host/sql/sqlAuthState', () => ({
	clearSqlTokenOverride: authEffects.clearSqlTokenOverride,
	setSqlServerAccountMapEntry: authEffects.setSqlServerAccountMapEntry,
	setSqlTokenOverride: authEffects.setSqlTokenOverride,
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

type StructuralSqlEditorLifecycleHandler = {
	handleMessage: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
	return { promise, resolve };
}

function createProvider(sqlEditorLifecycleApplication: StructuralSqlEditorLifecycleHandler) {
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
	while (constructorArgs.length < 44) constructorArgs.push(undefined);
	constructorArgs.push(sqlEditorLifecycleApplication);
	const provider = Reflect.construct(QueryEditorProvider, constructorArgs) as QueryEditorProvider;
	const transport = vi.fn(async () => true);
	Object.assign(provider, { postMessage: transport, panel: {}, _panelDisposed: false });
	vi.clearAllMocks();
	return { provider, transport };
}

function createMessages(): readonly IncomingWebviewMessage[] {
	const params = {
		boxId: 'sql-box-exact',
		sectionInstanceId: 'sql-instance-exact',
		line: 7,
		column: 11,
		ownerToken: 'owner-token-exact',
		targetGeneration: 13,
	};
	const expectedOwner = {
		connectionId: 'sql-connection-exact',
		database: 'ExactDb',
		targetSignature: 'target-signature-exact',
		principalFingerprint: 'principal-exact',
		revocationGeneration: 17,
	};
	return [
		{ type: 'sqlSectionOpen', boxId: 'sql-box-exact', sectionInstanceId: 'sql-instance-exact' },
		{
			type: 'retireSqlTarget', boxId: 'sql-box-exact', sectionInstanceId: 'sql-instance-exact',
			targetGeneration: 13,
		},
		{
			type: 'testSetSqlAuthOverride', serverUrl: 'exact.database.windows.net',
			accountId: 'account-exact', token: 'token-exact',
		},
		{ type: 'testClearSqlAuthOverride', accountId: 'account-exact' },
		{ type: 'stsRequest', requestId: 'sts-request-exact', method: 'textDocument/hover', params },
		{
			type: 'stsDidOpen', boxId: 'sql-box-exact', sectionInstanceId: 'sql-instance-exact',
			text: 'select 1;',
		},
		{
			type: 'stsDidChange', boxId: 'sql-box-exact', sectionInstanceId: 'sql-instance-exact',
			text: 'select 2;',
		},
		{ type: 'stsDidClose', boxId: 'sql-box-exact', sectionInstanceId: 'sql-instance-exact' },
		{
			type: 'stsConnect', boxId: 'sql-box-exact', sectionInstanceId: 'sql-instance-exact',
			sqlConnectionId: 'sql-connection-exact', database: 'ExactDb', targetGeneration: 13,
			expectedOwner,
		},
	];
}

function expectNoDirectEffects(transport: ReturnType<typeof vi.fn>): void {
	for (const effect of Object.values(lifecycleEffects)) {
		expect(effect).not.toHaveBeenCalled();
	}
	expect(authEffects.setSqlServerAccountMapEntry).not.toHaveBeenCalled();
	expect(authEffects.setSqlTokenOverride).not.toHaveBeenCalled();
	expect(authEffects.clearSqlTokenOverride).not.toHaveBeenCalled();
	expect(transport).not.toHaveBeenCalled();
}

describe('QueryEditorProvider SQL editor lifecycle application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('reference-identically forwards stsDidChange and awaits settlement without direct lifecycle, auth, or transport effects', async () => {
		const settlement = deferred<void>();
		const handler: StructuralSqlEditorLifecycleHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => settlement.promise),
			dispose: vi.fn(),
		};
		const { provider, transport } = createProvider(handler);
		const message = {
			type: 'stsDidChange',
			boxId: 'sql-box-exact',
			sectionInstanceId: 'sql-instance-exact',
			text: 'select 1;\r\n',
		} satisfies IncomingWebviewMessage;
		let settled = false;

		const request = provider.handleWebviewMessage(message);
		void request.finally(() => { settled = true; });
		await Promise.resolve();

		expect(handler.handleMessage).toHaveBeenCalledOnce();
		expect(handler.handleMessage.mock.calls[0][0]).toBe(message);
		expect((provider as unknown as { sqlEditorLifecycleApplication: unknown })
			.sqlEditorLifecycleApplication).toBe(handler);
		expect(settled).toBe(false);
		expectNoDirectEffects(transport);

		settlement.resolve();
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('reference-identically forwards all nine routes without direct provider effects', async () => {
		const messages = createMessages();
		const handler: StructuralSqlEditorLifecycleHandler = {
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
		const failure = new Error('injected SQL editor lifecycle handler failed');
		const message = createMessages()[8];
		const handler: StructuralSqlEditorLifecycleHandler = {
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

	it('deletes all nine provider branches while preserving lifecycle and auth helper owners', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/sqlEditorLifecycleApplicationHandler.ts');
		const lifecycleSource = readSource('src/host/sql/sqlEditorLifecycleCoordinator.ts');
		const authSource = readSource('src/host/sql/sqlAuthState.ts');
		const typesSource = readSource('src/host/queryEditorTypes.ts');
		const protocolSource = readSource('src/shared/sqlStsEditorLanguageProtocol.ts');
		const routes = [
			'sqlSectionOpen',
			'retireSqlTarget',
			'testSetSqlAuthOverride',
			'testClearSqlAuthOverride',
			'stsRequest',
			'stsDidOpen',
			'stsDidChange',
			'stsDidClose',
			'stsConnect',
		];

		for (const route of routes) {
			expect(providerSource).not.toContain(`case '${route}':`);
			expect(handlerSource).toContain(`case '${route}':`);
			if (route.startsWith('sts')) expect(protocolSource).toContain(`type: '${route}'`);
			else expect(typesSource).toContain(`type: '${route}'`);
		}
		expect(typesSource).toContain('| SqlStsEditorLanguageWebviewMessage');
		expect(typesSource).not.toContain("type: 'stsRequest'");
		expect(providerSource.match(/^\s*case '/gm) ?? []).toHaveLength(0);
		expect(providerSource).not.toContain("case 'prefetchSchema':");
		expect(providerSource).not.toContain("case 'requestCrossClusterSchema':");
		expect(providerSource).not.toContain("from './sql/sqlAuthState';");
		expect(providerSource).not.toContain('setSqlServerAccountMapEntry(');
		expect(providerSource).not.toContain('setSqlTokenOverride(');
		expect(providerSource).not.toContain('clearSqlTokenOverride(');
		expect(providerSource).toContain(
			'readonly sqlEditorLifecycleApplication: SqlEditorLifecycleApplicationHandler;',
		);
		expect(providerSource).toMatch(
			/kustoConnectionsProjectionApplication\?: KustoConnectionsProjectionApplicationHandler,\s+sqlEditorLifecycleApplication\?: SqlEditorLifecycleApplicationHandler,/,
		);
		expect(providerSource).toContain(
			'= this.sqlEditorLifecycleApplication?.handleMessage(message);',
		);
		expect(providerSource).toContain('this.sqlEditorLifecycleApplication.dispose();');

		expect(lifecycleSource).toContain('export class SqlEditorLifecycleCoordinator');
		for (const method of [
			'openSection(',
			'retireTarget(',
			'handleLanguageRequest(',
			'didOpen(',
			'didChange(',
			'didClose(',
			'connect(',
		]) {
			expect(lifecycleSource).toContain(method);
		}
		expect(authSource).toContain('export async function setSqlServerAccountMapEntry(');
		expect(authSource).toContain('export async function setSqlTokenOverride(');
		expect(authSource).toContain('export async function clearSqlTokenOverride(');
		expect(handlerSource).toContain('await setSqlServerAccountMapEntry(');
		expect(handlerSource).toContain('await setSqlTokenOverride(');
		expect(handlerSource).toContain('await clearSqlTokenOverride(');
	});
});
