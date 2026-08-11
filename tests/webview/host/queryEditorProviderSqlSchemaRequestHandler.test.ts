import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const lifecycleEffects = vi.hoisted(() => ({
	adoptTarget: vi.fn(),
	getResultOwner: vi.fn(),
	isSectionCurrent: vi.fn(),
	isTargetCurrent: vi.fn(),
	dispatchResultOwnerAllowed: vi.fn(),
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
		readonly adoptTarget = lifecycleEffects.adoptTarget;
		readonly getResultOwner = lifecycleEffects.getResultOwner;
		readonly isSectionCurrent = lifecycleEffects.isSectionCurrent;
		readonly isTargetCurrent = lifecycleEffects.isTargetCurrent;
		readonly dispatchResultOwnerAllowed = lifecycleEffects.dispatchResultOwnerAllowed;
		startSession(): void {}
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

type StructuralSqlSchemaRequestHandler = {
	handleMessage: ReturnType<typeof vi.fn>;
	requestSchema: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
	return { promise, resolve };
}

function schemaMessage(): IncomingWebviewMessage {
	return {
		type: 'prefetchSqlSchema',
		sqlConnectionId: 'sql-exact',
		database: 'ExactDb',
		boxId: 'sql-box-exact',
		sectionInstanceId: 'sql-instance-exact',
		targetGeneration: 17,
		forceRefresh: true,
	};
}

function createProvider(sqlSchemaRequestApplication: StructuralSqlSchemaRequestHandler) {
	const sqlGetConnection = vi.fn();
	const transport = vi.fn(async () => true);
	const constructorArgs: unknown[] = [
		vscode.Uri.file('C:\\extension'),
		{ getConnection: vi.fn(), getConnections: vi.fn(() => []) },
		{
			globalStorageUri: vscode.Uri.file('C:\\storage'),
			globalState: { get: vi.fn(), update: vi.fn(async () => undefined) },
			extensionMode: vscode.ExtensionMode.Test,
		},
		{
			connectionManager: {
				getConnection: sqlGetConnection,
				getConnections: vi.fn(() => []),
			},
			client: {},
			leaveNoTracePolicy: { getRevocationGeneration: vi.fn(() => 0) },
		},
	];
	while (constructorArgs.length < 40) constructorArgs.push(undefined);
	constructorArgs.push(sqlSchemaRequestApplication);
	const provider = Reflect.construct(QueryEditorProvider, constructorArgs) as QueryEditorProvider;
	Object.assign(provider, { postMessage: transport, panel: {} });
	vi.clearAllMocks();
	return { provider, sqlGetConnection, transport };
}

describe('QueryEditorProvider SQL schema request application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('reference-identically forwards and awaits the exact schema request', async () => {
		const message = schemaMessage();
		const settlement = deferred<void>();
		const handler: StructuralSqlSchemaRequestHandler = {
			handleMessage: vi.fn((candidate: IncomingWebviewMessage) =>
				candidate === message ? settlement.promise : undefined),
			requestSchema: vi.fn(),
			dispose: vi.fn(),
		};
		const { provider, sqlGetConnection, transport } = createProvider(handler);
		let settled = false;
		const request = provider.handleWebviewMessage(message);
		void request.finally(() => { settled = true; });
		await Promise.resolve();

		expect(handler.handleMessage).toHaveBeenCalledOnce();
		expect(handler.handleMessage.mock.calls[0][0]).toBe(message);
		expect((provider as unknown as { sqlSchemaRequestApplication: unknown }).sqlSchemaRequestApplication)
			.toBe(handler);
		expect(settled).toBe(false);
		expect(lifecycleEffects.adoptTarget).not.toHaveBeenCalled();
		expect(lifecycleEffects.getResultOwner).not.toHaveBeenCalled();
		expect(sqlGetConnection).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();

		settlement.resolve(undefined);
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('adopts the injected handler rejection exactly', async () => {
		const message = schemaMessage();
		const failure = new Error('injected SQL schema request failed');
		const handler: StructuralSqlSchemaRequestHandler = {
			handleMessage: vi.fn((candidate: IncomingWebviewMessage) =>
				candidate === message ? Promise.reject(failure) : undefined),
			requestSchema: vi.fn(),
			dispose: vi.fn(),
		};
		const { provider, sqlGetConnection, transport } = createProvider(handler);

		await expect(provider.handleWebviewMessage(message)).rejects.toBe(failure);

		expect(handler.handleMessage).toHaveBeenCalledOnce();
		expect(handler.handleMessage.mock.calls[0][0]).toBe(message);
		expect(lifecycleEffects.adoptTarget).not.toHaveBeenCalled();
		expect(sqlGetConnection).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();
	});
});