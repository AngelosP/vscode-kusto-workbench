import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const copilotMocks = vi.hoisted(() => ({
	startCopilotWriteQuery: vi.fn(async () => undefined),
	cancelCopilotWriteQuery: vi.fn(),
	prepareOptimizeQuery: vi.fn(async () => undefined),
	cancelOptimizeQuery: vi.fn(),
	optimizeQueryWithCopilot: vi.fn(async () => undefined),
}));

const sqlLifecycleMocks = vi.hoisted(() => {
	const preflight = { boxId: 'legacy-preflight' };
	return {
		preflight,
		reservePreflight: vi.fn(() => preflight),
		clearPreflight: vi.fn(() => true),
		cancelExpected: vi.fn(() => false),
		assertOwnerToken: vi.fn(async () => ({
			token: 'legacy-issued-owner-token',
			owner: { connectionId: 'legacy-sql-connection', database: 'LegacyDatabase' },
		})),
		getOwnerToken: vi.fn(() => 'legacy-current-owner-token'),
	};
});

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
		readonly executionBroker = {
			reservePreflight: sqlLifecycleMocks.reservePreflight,
			clearPreflight: sqlLifecycleMocks.clearPreflight,
			cancelExpected: sqlLifecycleMocks.cancelExpected,
		};
		readonly assertOwnerToken = sqlLifecycleMocks.assertOwnerToken;
		readonly getOwnerToken = sqlLifecycleMocks.getOwnerToken;
		startSession(): void {}
	},
}));

vi.mock('../../../src/host/queryEditorCopilot', () => ({
	CopilotService: class {
		readonly startCopilotWriteQuery = copilotMocks.startCopilotWriteQuery;
		readonly cancelCopilotWriteQuery = copilotMocks.cancelCopilotWriteQuery;
		readonly prepareOptimizeQuery = copilotMocks.prepareOptimizeQuery;
		readonly cancelOptimizeQuery = copilotMocks.cancelOptimizeQuery;
		readonly optimizeQueryWithCopilot = copilotMocks.optimizeQueryWithCopilot;
	},
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

type StructuralCopilotQueryWorkflowHandler = {
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
	copilotQueryWorkflowApplication: StructuralCopilotQueryWorkflowHandler,
): {
	provider: QueryEditorProvider;
	transport: ReturnType<typeof vi.fn>;
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
	const kustoConnectionBrowsingApplication = {
		handleMessage: vi.fn(() => undefined),
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
		copilotQueryWorkflowApplication,
	]) as QueryEditorProvider;
	const transport = vi.fn(() => true);
	(provider as unknown as { postMessage: typeof transport }).postMessage = transport;

	copilotMocks.startCopilotWriteQuery.mockClear();
	copilotMocks.cancelCopilotWriteQuery.mockClear();
	copilotMocks.prepareOptimizeQuery.mockClear();
	copilotMocks.cancelOptimizeQuery.mockClear();
	copilotMocks.optimizeQueryWithCopilot.mockClear();
	sqlLifecycleMocks.reservePreflight.mockClear();
	sqlLifecycleMocks.clearPreflight.mockClear();
	sqlLifecycleMocks.cancelExpected.mockClear();
	sqlLifecycleMocks.assertOwnerToken.mockClear();
	sqlLifecycleMocks.getOwnerToken.mockClear();

	return { provider, transport };
}

function createMessages(): IncomingWebviewMessage[] {
	return [
		{
			type: 'startCopilotWriteQuery',
			boxId: 'sql-workflow-start',
			connectionId: 'sql-connection-exact',
			serverUrl: 'sql-exact.example.net',
			database: 'SqlDatabaseExact',
			request: 'Write the exact SQL query',
			flavor: 'sql',
			sqlOwnerToken: 'sql-owner-token-exact',
		},
		{
			type: 'cancelCopilotWriteQuery',
			boxId: 'kusto-workflow-cancel',
			flavor: 'kusto',
			copilotRequestId: 'copilot-request-exact',
			sectionInstanceId: 'kusto-section-exact',
			targetGeneration: 17,
		},
		{
			type: 'prepareOptimizeQuery',
			boxId: 'optimize-workflow-prepare',
			query: 'StormEvents | take 10',
			optimizeRequestId: 'optimize-prepare-exact',
			sectionInstanceId: 'optimize-section-prepare',
			targetGeneration: 23,
		},
		{
			type: 'cancelOptimizeQuery',
			boxId: 'optimize-workflow-cancel',
			optimizeRequestId: 'optimize-cancel-exact',
			sectionInstanceId: 'optimize-section-cancel',
			targetGeneration: 29,
		},
		{
			type: 'optimizeQuery',
			boxId: 'optimize-workflow-run',
			query: 'StormEvents | summarize count() by State',
			connectionId: 'kusto-connection-exact',
			database: 'KustoDatabaseExact',
			queryName: 'Optimize exact query',
			optimizeRequestId: 'optimize-run-exact',
			sectionInstanceId: 'optimize-section-run',
			targetGeneration: 31,
		},
	];
}

function expectNoDirectEffects(transport: ReturnType<typeof vi.fn>): void {
	expect(copilotMocks.startCopilotWriteQuery).not.toHaveBeenCalled();
	expect(copilotMocks.cancelCopilotWriteQuery).not.toHaveBeenCalled();
	expect(copilotMocks.prepareOptimizeQuery).not.toHaveBeenCalled();
	expect(copilotMocks.cancelOptimizeQuery).not.toHaveBeenCalled();
	expect(copilotMocks.optimizeQueryWithCopilot).not.toHaveBeenCalled();
	expect(sqlLifecycleMocks.reservePreflight).not.toHaveBeenCalled();
	expect(sqlLifecycleMocks.clearPreflight).not.toHaveBeenCalled();
	expect(sqlLifecycleMocks.cancelExpected).not.toHaveBeenCalled();
	expect(sqlLifecycleMocks.assertOwnerToken).not.toHaveBeenCalled();
	expect(sqlLifecycleMocks.getOwnerToken).not.toHaveBeenCalled();
	expect(transport).not.toHaveBeenCalled();
}

describe('QueryEditorProvider Copilot query workflow application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('reference-identically forwards all five routes and awaits their exact settlements', async () => {
		const messages = createMessages();
		const settlements = messages.map(() => deferred<void>());
		const copilotQueryWorkflowApplication: StructuralCopilotQueryWorkflowHandler = {
			handleMessage: vi.fn((candidate: IncomingWebviewMessage) => {
				const index = messages.indexOf(candidate);
				return index >= 0 ? settlements[index].promise : undefined;
			}),
			dispose: vi.fn(),
		};
		const { provider, transport } = createProvider(copilotQueryWorkflowApplication);
		const settled = messages.map(() => false);

		const requests = messages.map((message, index) => {
			const request = provider.handleWebviewMessage(message);
			void request.finally(() => { settled[index] = true; });
			return request;
		});
		await Promise.resolve();

		expect(copilotQueryWorkflowApplication.handleMessage).toHaveBeenCalledTimes(5);
		messages.forEach((message, index) => {
			expect(copilotQueryWorkflowApplication.handleMessage.mock.calls[index][0]).toBe(message);
		});
		expect((provider as unknown as { copilotQueryWorkflowApplication: unknown })
			.copilotQueryWorkflowApplication).toBe(copilotQueryWorkflowApplication);
		expect(settled).toEqual([false, false, false, false, false]);
		expectNoDirectEffects(transport);

		settlements.forEach(settlement => settlement.resolve());
		await expect(Promise.all(requests)).resolves.toEqual([
			undefined, undefined, undefined, undefined, undefined,
		]);
		expect(settled).toEqual([true, true, true, true, true]);
	});

	it('adopts the injected rejection exactly without direct provider effects', async () => {
		const failure = new Error('injected Copilot query workflow handler failed');
		const message = createMessages()[4];
		const copilotQueryWorkflowApplication: StructuralCopilotQueryWorkflowHandler = {
			handleMessage: vi.fn((candidate: IncomingWebviewMessage) =>
				candidate === message ? Promise.reject(failure) : undefined),
			dispose: vi.fn(),
		};
		const { provider, transport } = createProvider(copilotQueryWorkflowApplication);

		await expect(provider.handleWebviewMessage(message)).rejects.toBe(failure);

		expect(copilotQueryWorkflowApplication.handleMessage).toHaveBeenCalledOnce();
		expect(copilotQueryWorkflowApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expectNoDirectEffects(transport);
	});

	it('deletes five provider cases while preserving canonical workflow capabilities', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/copilotQueryWorkflowApplicationHandler.ts');
		const copilotSource = readSource('src/host/queryEditorCopilot.ts');
		const brokerSource = readSource('src/host/sql/sqlExecutionBroker.ts');
		const lifecycleSource = readSource('src/host/sql/sqlEditorLifecycleCoordinator.ts');
		const typesSource = readSource('src/host/queryEditorTypes.ts');

		for (const route of [
			'startCopilotWriteQuery',
			'cancelCopilotWriteQuery',
			'prepareOptimizeQuery',
			'cancelOptimizeQuery',
			'optimizeQuery',
		]) {
			expect(providerSource).not.toContain(`case '${route}':`);
			expect(handlerSource).toContain(`case '${route}':`);
		}
		expect(providerSource.match(/^\s*case '/gm) ?? []).toHaveLength(2);
		expect(handlerSource.match(/^\s*case '/gm) ?? []).toHaveLength(5);
		expect(providerSource).not.toContain('sql-copilot-owner-preflight');
		expect(providerSource).toContain(
			'readonly copilotQueryWorkflowApplication: CopilotQueryWorkflowApplicationHandler;',
		);
		expect(providerSource).toMatch(
			/kustoConnectionBrowsingApplication\?: KustoConnectionBrowsingApplicationHandler,\s+copilotQueryWorkflowApplication\?: CopilotQueryWorkflowApplicationHandler,/,
		);
		expect(providerSource).toContain(
			'= this.copilotQueryWorkflowApplication?.handleMessage(message);',
		);
		expect(providerSource).toContain('this.copilotQueryWorkflowApplication.dispose();');
		expect(providerSource).toContain('getSqlConnectionManager: () => this.sqlConnectionManager,');
		expect(providerSource).toContain('getSqlSchemaService: () => this.sqlSchemaService,');
		expect(providerSource).toContain('getSqlClient: () => this.sqlClient,');

		expect(handlerSource).toContain(
			"const SQL_COPILOT_PREFLIGHT_EXECUTION_ID = 'sql-copilot-owner-preflight';",
		);
		expect(handlerSource).toContain('this.options.sqlExecutionBroker.reservePreflight(');
		expect(handlerSource).toContain('await this.options.sqlLifecycle.assertOwnerToken(');
		expect(handlerSource).toContain('this.options.sqlExecutionBroker.clearPreflight(preflight)');
		expect(handlerSource).toContain('this.options.sqlExecutionBroker.cancelExpected(');
		expect(handlerSource).toContain("message: 'Canceled.'");
		expect(handlerSource).toContain('message: SQL_COPILOT_OWNER_CHANGED_MESSAGE');
		expect(handlerSource).toContain(
			'this.options.copilot.cancelCopilotWriteQuery(message.boxId, undefined, expectedRequest);',
		);
		expect(handlerSource).toContain('this.options.getSqlConnectionManager()');
		expect(handlerSource).toContain('this.options.getSqlSchemaService()');
		expect(handlerSource).toContain('this.options.getSqlClient()');
		expect(handlerSource).toContain('return this.options.copilot.prepareOptimizeQuery(message);');
		expect(handlerSource).toContain('this.options.copilot.cancelOptimizeQuery(message);');
		expect(handlerSource).toContain('return this.options.copilot.optimizeQueryWithCopilot(message);');

		expect(copilotSource).toContain('async startCopilotWriteQuery(');
		expect(copilotSource).toContain('cancelCopilotWriteQuery(boxId: string');
		expect(copilotSource).toContain('async prepareOptimizeQuery(');
		expect(copilotSource).toContain('cancelOptimizeQuery(expected: KustoOptimizeRequestIdentity): void');
		expect(copilotSource).toContain('async optimizeQueryWithCopilot(');
		expect(brokerSource).toContain('reservePreflight(');
		expect(brokerSource).toContain('clearPreflight(');
		expect(brokerSource).toContain('cancelExpected(');
		expect(lifecycleSource).toContain('assertOwnerToken(boxId: string');
		expect(lifecycleSource).toContain('getOwnerToken(boxId: string)');
		expect(typesSource).toContain("type: 'startCopilotWriteQuery';");
		expect(typesSource).toContain("type: 'cancelCopilotWriteQuery'; boxId: string; flavor: 'kusto'");
		expect(typesSource).toContain("type: 'prepareOptimizeQuery'; query: string");
		expect(typesSource).toContain("type: 'cancelOptimizeQuery'");
		expect(typesSource).toContain("type: 'optimizeQuery';");
	});
});
