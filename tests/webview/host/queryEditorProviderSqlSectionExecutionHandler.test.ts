import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const sqlLifecycleMocks = vi.hoisted(() => ({
	isSectionCurrent: vi.fn(() => false),
	assertOwnerToken: vi.fn(),
	assertOwnerTokenProtection: vi.fn(),
	dispatchResultOwnerAllowed: vi.fn(),
	dispatchResultOwnerProtection: vi.fn(),
}));

const sqlBrokerMocks = vi.hoisted(() => ({
	reservePreflight: vi.fn(),
	promotePreflight: vi.fn(),
	start: vi.fn(),
	cancelExpected: vi.fn(),
	clearPreflight: vi.fn(),
	clearPending: vi.fn(),
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
		readonly executionBroker = {
			reservePreflight: sqlBrokerMocks.reservePreflight,
			promotePreflight: sqlBrokerMocks.promotePreflight,
			start: sqlBrokerMocks.start,
			cancelExpected: sqlBrokerMocks.cancelExpected,
			clearPreflight: sqlBrokerMocks.clearPreflight,
			clearPending: sqlBrokerMocks.clearPending,
		};
		readonly isSectionCurrent = sqlLifecycleMocks.isSectionCurrent;
		readonly assertOwnerToken = sqlLifecycleMocks.assertOwnerToken;
		readonly assertOwnerTokenProtection = sqlLifecycleMocks.assertOwnerTokenProtection;
		readonly dispatchResultOwnerAllowed = sqlLifecycleMocks.dispatchResultOwnerAllowed;
		readonly dispatchResultOwnerProtection = sqlLifecycleMocks.dispatchResultOwnerProtection;
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

type StructuralSqlSectionExecutionHandler = {
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

function createMessages(): IncomingWebviewMessage[] {
	return [
		{
			type: 'executeSqlQuery',
			query: 'SELECT 36',
			sqlConnectionId: 'sql-connection-exact',
			boxId: 'sql-box-exact',
			sectionInstanceId: 'sql-instance-exact',
			database: 'ExactDb',
			queryMode: 'top100',
			ownerToken: 'sql-owner-exact',
			executionId: 'sql-execution-exact',
		},
		{
			type: 'cancelSqlQuery',
			boxId: 'sql-box-exact',
			sectionInstanceId: 'sql-instance-exact',
			executionId: 'sql-execution-exact',
		},
	];
}

function createProvider(sqlSectionExecutionApplication: StructuralSqlSectionExecutionHandler): {
	provider: QueryEditorProvider;
	transport: ReturnType<typeof vi.fn>;
	connectionLookup: ReturnType<typeof vi.fn>;
	protectedLookup: ReturnType<typeof vi.fn>;
	clientExecution: ReturnType<typeof vi.fn>;
} {
	const transport = vi.fn(() => true);
	const connectionLookup = vi.fn();
	const protectedLookup = vi.fn(() => false);
	const clientExecution = vi.fn();
	const developmentNoteMutationApplication = {
		updateDevelopmentNotes: vi.fn(async () => ({ success: true })),
		handleMessage: vi.fn(() => undefined),
		dispose: vi.fn(),
	};
	const workbenchToolSessionApplication = {
		activate: vi.fn(),
		handleMessage: vi.fn(() => undefined),
		requestSectionsFromWebview: vi.fn(),
		dispose: vi.fn(),
	};
	const comparisonPreparationApplication = {
		handleMessage: vi.fn(() => undefined),
		ensureComparisonBoxInWebview: vi.fn(),
		rejectPendingComparisonEnsures: vi.fn(),
		dispose: vi.fn(),
	};
	const provider = Reflect.construct(QueryEditorProvider, [
		vscode.Uri.file('C:\\extension'),
		{ getConnection: vi.fn(), getConnections: vi.fn(() => []) },
		{ globalState: { get: vi.fn(), update: vi.fn(async () => undefined) } },
		{
			connectionManager: { getConnection: connectionLookup, getConnections: vi.fn(() => []) },
			client: { getDatabases: vi.fn(async () => [] as string[]), executeQueryCancelable: clientExecution },
			assertSqlConnectionAllowed: vi.fn(async () => undefined),
			isLeaveNoTraceConnection: protectedLookup,
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
		{ handleMessage: vi.fn(() => undefined), dispose: vi.fn() },
		{ handleMessage: vi.fn(() => undefined), dispose: vi.fn() },
		{ handleMessage: vi.fn(() => undefined), dispose: vi.fn() },
		comparisonPreparationApplication,
		sqlSectionExecutionApplication,
	]) as QueryEditorProvider;
	Object.assign(provider, { postMessage: transport, panel: {} });

	vi.clearAllMocks();
	return { provider, transport, connectionLookup, protectedLookup, clientExecution };
}

function expectNoDirectEffects(
	transport: ReturnType<typeof vi.fn>,
	connectionLookup: ReturnType<typeof vi.fn>,
	protectedLookup: ReturnType<typeof vi.fn>,
	clientExecution: ReturnType<typeof vi.fn>,
): void {
	expect(sqlLifecycleMocks.isSectionCurrent).not.toHaveBeenCalled();
	expect(sqlLifecycleMocks.assertOwnerToken).not.toHaveBeenCalled();
	expect(sqlLifecycleMocks.assertOwnerTokenProtection).not.toHaveBeenCalled();
	expect(sqlLifecycleMocks.dispatchResultOwnerAllowed).not.toHaveBeenCalled();
	expect(sqlLifecycleMocks.dispatchResultOwnerProtection).not.toHaveBeenCalled();
	expect(sqlBrokerMocks.reservePreflight).not.toHaveBeenCalled();
	expect(sqlBrokerMocks.promotePreflight).not.toHaveBeenCalled();
	expect(sqlBrokerMocks.start).not.toHaveBeenCalled();
	expect(sqlBrokerMocks.cancelExpected).not.toHaveBeenCalled();
	expect(sqlBrokerMocks.clearPreflight).not.toHaveBeenCalled();
	expect(sqlBrokerMocks.clearPending).not.toHaveBeenCalled();
	expect(connectionLookup).not.toHaveBeenCalled();
	expect(protectedLookup).not.toHaveBeenCalled();
	expect(clientExecution).not.toHaveBeenCalled();
	expect(transport).not.toHaveBeenCalled();
}

describe('QueryEditorProvider SQL section execution application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('reference-identically forwards execute and cancel with exact deferred settlement', async () => {
		const messages = createMessages();
		const settlements = messages.map(() => deferred<void>());
		const sqlSectionExecutionApplication: StructuralSqlSectionExecutionHandler = {
			handleMessage: vi.fn((candidate: IncomingWebviewMessage) => {
				const index = messages.indexOf(candidate);
				return index >= 0 ? settlements[index].promise : undefined;
			}),
			dispose: vi.fn(),
		};
		const { provider, transport, connectionLookup, protectedLookup, clientExecution }
			= createProvider(sqlSectionExecutionApplication);
		const settled = [false, false];
		const requests = messages.map((message, index) => {
			const request = provider.handleWebviewMessage(message);
			void request.then(
				() => { settled[index] = true; },
				() => { settled[index] = true; },
			);
			return request;
		});

		try {
			await Promise.resolve();

			expect(sqlSectionExecutionApplication.handleMessage).toHaveBeenCalledTimes(2);
			messages.forEach((message, index) => {
				expect(sqlSectionExecutionApplication.handleMessage.mock.calls[index][0]).toBe(message);
			});
			expect((provider as unknown as { sqlSectionExecutionApplication: unknown })
				.sqlSectionExecutionApplication).toBe(sqlSectionExecutionApplication);
			expect(settled).toEqual([false, false]);
			expectNoDirectEffects(transport, connectionLookup, protectedLookup, clientExecution);

			settlements.forEach(settlement => settlement.resolve());
			await expect(Promise.all(requests)).resolves.toEqual([undefined, undefined]);
			expect(settled).toEqual([true, true]);
		} finally {
			settlements.forEach(settlement => settlement.resolve());
			await Promise.allSettled(requests);
		}
	});

	it('adopts an injected execution rejection exactly without direct provider effects', async () => {
		const routeFailure = new Error('injected SQL execution route failed');
		const message = createMessages()[0];
		const sqlSectionExecutionApplication: StructuralSqlSectionExecutionHandler = {
			handleMessage: vi.fn((candidate: IncomingWebviewMessage) =>
				candidate === message ? Promise.reject(routeFailure) : undefined),
			dispose: vi.fn(),
		};
		const { provider, transport, connectionLookup, protectedLookup, clientExecution }
			= createProvider(sqlSectionExecutionApplication);

		await expect(provider.handleWebviewMessage(message)).rejects.toBe(routeFailure);

		expect(sqlSectionExecutionApplication.handleMessage).toHaveBeenCalledOnce();
		expect(sqlSectionExecutionApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expectNoDirectEffects(transport, connectionLookup, protectedLookup, clientExecution);
	});

	it('deletes both provider routes while preserving canonical SQL execution owners', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/sqlSectionExecutionApplicationHandler.ts');
		const lifecycleSource = readSource('src/host/sql/sqlEditorLifecycleCoordinator.ts');
		const registrySource = readSource('src/host/sql/sqlEditorSessionRegistry.ts');
		const brokerSource = readSource('src/host/sql/sqlExecutionBroker.ts');
		const workbenchSource = readSource('src/host/sql/sqlWorkbenchService.ts');
		const clientSource = readSource('src/host/sqlClient.ts');
		const copilotSource = readSource('src/host/queryEditorCopilot.ts');
		const typesSource = readSource('src/host/queryEditorTypes.ts');

		for (const route of ['executeSqlQuery', 'cancelSqlQuery']) {
			expect(providerSource).not.toContain(`case '${route}':`);
			expect(handlerSource).toContain(`case '${route}':`);
			expect(typesSource).toContain(`type: '${route}'`);
		}
		expect(providerSource.match(/^\s*case '/gm) ?? []).toHaveLength(13);
		expect(handlerSource.match(/^\s*case '/gm) ?? []).toHaveLength(2);
		expect(providerSource).not.toContain('executeSqlQueryFromWebview');
		expect(providerSource).not.toContain('appendSqlQueryMode as appendSqlQueryModeFn');
		expect(providerSource).not.toContain('SqlQueryCancelledError');
		expect(providerSource).not.toContain('SqlExecutionAdmission');
		expect(providerSource).not.toContain('SqlExecutionLease');
		expect(providerSource).not.toContain('postSqlOwnerMessageAllowed');
		expect(providerSource).not.toContain('postSqlOwnerMessageProtection');
		expect(providerSource).toContain(
			'readonly sqlSectionExecutionApplication: SqlSectionExecutionApplicationHandler;',
		);
		expect(providerSource).toMatch(
			/comparisonPreparationApplication\?: ComparisonPreparationApplicationHandler,\s+sqlSectionExecutionApplication\?: SqlSectionExecutionApplicationHandler,/,
		);
		expect(providerSource).toContain(
			'= this.sqlSectionExecutionApplication?.handleMessage(message);',
		);
		expect(providerSource).toContain('this.sqlSectionExecutionApplication.dispose();');

		expect(handlerSource).toContain('reservePreflight(');
		expect(handlerSource).toContain('assertOwnerTokenProtection(');
		expect(handlerSource).toContain('appendSqlQueryMode(message.query, message.queryMode)');
		expect(handlerSource).toContain("'[sql-lnt] Isolated SQL query failed; details were not logged.'");
		expect(handlerSource).toContain('this.options.sqlExecutionBroker.clearPreflight(preflight);');
		expect(handlerSource).toContain('lease?.release();');
		expect(handlerSource).not.toContain('SqlEditorSessionRegistry');

		expect(lifecycleSource).toContain('export class SqlEditorLifecycleCoordinator');
		expect(registrySource).toContain('export class SqlEditorSessionRegistry');
		expect(brokerSource).toContain('export class SqlExecutionBroker');
		expect(workbenchSource).toContain('export class SqlWorkbenchService');
		expect(clientSource).toContain('export class SqlQueryClient');
		expect(copilotSource).toContain('export class CopilotService');
	});
});
