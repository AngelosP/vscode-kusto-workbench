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

type StructuralSqlLastSelectionHandler = {
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

function createProvider(sqlLastSelectionApplication: StructuralSqlLastSelectionHandler): {
	provider: QueryEditorProvider;
	globalStateUpdate: ReturnType<typeof vi.fn>;
} {
	const globalStateUpdate = vi.fn(async () => undefined);
	const provider = Reflect.construct(QueryEditorProvider, [
		vscode.Uri.file('C:\\extension'),
		{ getConnection: vi.fn(), getConnections: vi.fn(() => []) },
		{ globalState: { get: vi.fn(() => undefined), update: globalStateUpdate } },
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
		sqlLastSelectionApplication,
	]) as QueryEditorProvider;
	return { provider, globalStateUpdate };
}

describe('QueryEditorProvider SQL last-selection application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('reference-identically forwards the exact request and awaits deferred settlement without direct state writes', async () => {
		const handled = deferred<void>();
		const sqlLastSelectionApplication: StructuralSqlLastSelectionHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => handled.promise),
			dispose: vi.fn(),
		};
		const { provider, globalStateUpdate } = createProvider(sqlLastSelectionApplication);
		const message = {
			type: 'saveSqlLastSelection',
			sqlConnectionId: ' sql-a ',
			database: '',
		} satisfies IncomingWebviewMessage;
		let settled = false;

		const request = provider.handleWebviewMessage(message);
		void request.then(
			() => { settled = true; },
			() => { settled = true; },
		);
		await Promise.resolve();

		expect(sqlLastSelectionApplication.handleMessage).toHaveBeenCalledTimes(1);
		expect(sqlLastSelectionApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect((provider as unknown as { sqlLastSelectionApplication: unknown }).sqlLastSelectionApplication)
			.toBe(sqlLastSelectionApplication);
		expect(settled).toBe(false);
		expect(globalStateUpdate).not.toHaveBeenCalled();

		handled.resolve();
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('adopts the injected handler rejection exactly without direct state writes', async () => {
		const failure = new Error('injected SQL last-selection handler failed');
		const sqlLastSelectionApplication: StructuralSqlLastSelectionHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => Promise.reject(failure)),
			dispose: vi.fn(),
		};
		const { provider, globalStateUpdate } = createProvider(sqlLastSelectionApplication);
		const message = {
			type: 'saveSqlLastSelection',
			sqlConnectionId: ' sql-a ',
			database: '',
		} satisfies IncomingWebviewMessage;

		await expect(provider.handleWebviewMessage(message)).rejects.toBe(failure);

		expect(sqlLastSelectionApplication.handleMessage).toHaveBeenCalledTimes(1);
		expect(sqlLastSelectionApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect(globalStateUpdate).not.toHaveBeenCalled();
	});

	it('deletes displaced authority while preserving emitters, onboarding, projection reads, and message shape', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/sqlLastSelectionApplicationHandler.ts');
		const projectionSource = readSource('src/host/sqlConnectionsProjectionApplicationHandler.ts');
		const onboardingSource = readSource('src/host/sqlConnectionOnboardingApplicationHandler.ts');
		const hostTypesSource = readSource('src/host/queryEditorTypes.ts');
		const emitterSource = readSource('src/webview/sections/sql-section-session.controller.ts');

		expect(providerSource).not.toContain("case 'saveSqlLastSelection':");
		expect(providerSource).not.toContain("globalState.update('sql.lastConnectionId'");
		expect(providerSource).not.toContain("globalState.update('sql.lastDatabase'");
		expect(providerSource).toContain('readonly sqlLastSelectionApplication: SqlLastSelectionApplicationHandler;');
		expect(providerSource).toMatch(
			/kqlLanguageRequestApplication\?: KqlLanguageRequestApplicationHandler,\s+sqlLastSelectionApplication\?: SqlLastSelectionApplicationHandler,/,
		);
		expect(providerSource).toContain('this.sqlLastSelectionApplication.dispose();');
		expect(handlerSource).toContain("message.type !== 'saveSqlLastSelection'");
		expect(handlerSource).toContain("update('sql.lastConnectionId', sqlConnectionId)");
		expect(handlerSource).toContain('message.database !== undefined');
		expect(handlerSource).toContain("update('sql.lastDatabase', message.database)");
		expect(onboardingSource).toContain("update('sql.lastConnectionId', newConnection.id)");
		expect(providerSource).not.toContain("globalState.get<string>('sql.lastConnectionId')");
		expect(providerSource).not.toContain("globalState.get<string>('sql.lastDatabase')");
		expect(projectionSource).toContain("applicationState.get<string>('sql.lastConnectionId')");
		expect(projectionSource).toContain("applicationState.get<string>('sql.lastDatabase')");
		expect(hostTypesSource).toContain("type: 'saveSqlLastSelection'");
		expect(emitterSource).toContain("type: 'saveSqlLastSelection'");
	});
});