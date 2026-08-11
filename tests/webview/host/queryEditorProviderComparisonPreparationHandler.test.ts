import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const sqlLifecycleMocks = vi.hoisted(() => ({
	getConnectionId: vi.fn(() => undefined),
	getSectionInstanceId: vi.fn(),
	getGeneration: vi.fn(),
	getTarget: vi.fn(),
	getComparisonOwner: vi.fn(),
	setComparisonOwner: vi.fn(),
	removeComparisonOwner: vi.fn(),
}));

const sqlBrokerMocks = vi.hoisted(() => ({
	supersede: vi.fn(),
}));

const sqlWorkbenchMocks = vi.hoisted(() => ({
	assertSqlConnectionAllowed: vi.fn(async () => undefined),
}));

const kustoCoordinatorMocks = vi.hoisted(() => ({
	openSection: vi.fn(() => true),
	adoptTarget: vi.fn(() => true),
	getActive: vi.fn(),
	cancelExpected: vi.fn(() => false),
}));

const copilotMocks = vi.hoisted(() => ({
	cancelCopilotQueryTarget: vi.fn(),
	cancelCopilotWriteQuery: vi.fn(),
}));

vi.mock('../../../src/host/kustoExecutionCoordinator', () => ({
	KustoExecutionCoordinator: class {
		readonly openSection = kustoCoordinatorMocks.openSection;
		readonly adoptTarget = kustoCoordinatorMocks.adoptTarget;
		readonly getActive = kustoCoordinatorMocks.getActive;
		readonly cancelExpected = kustoCoordinatorMocks.cancelExpected;
	},
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
		readonly executionBroker = { supersede: sqlBrokerMocks.supersede };
		readonly getConnectionId = sqlLifecycleMocks.getConnectionId;
		readonly getSectionInstanceId = sqlLifecycleMocks.getSectionInstanceId;
		readonly getGeneration = sqlLifecycleMocks.getGeneration;
		readonly getTarget = sqlLifecycleMocks.getTarget;
		readonly getComparisonOwner = sqlLifecycleMocks.getComparisonOwner;
		readonly setComparisonOwner = sqlLifecycleMocks.setComparisonOwner;
		readonly removeComparisonOwner = sqlLifecycleMocks.removeComparisonOwner;
		startSession(): void {}
	},
}));

vi.mock('../../../src/host/queryEditorCopilot', () => ({
	CopilotService: class {
		readonly cancelCopilotQueryTarget = copilotMocks.cancelCopilotQueryTarget;
		readonly cancelCopilotWriteQuery = copilotMocks.cancelCopilotWriteQuery;
	},
}));

vi.mock('../../../src/host/kustoConnectionLifecycle', () => ({
	KustoConnectionLifecycle: class {},
}));

vi.mock('../../../src/host/extension', () => ({
	toolOrchestrator: undefined,
}));

import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

type StructuralComparisonPreparationHandler = {
	handleMessage: ReturnType<typeof vi.fn>;
	ensureComparisonBoxInWebview: ReturnType<typeof vi.fn>;
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

function createCancellation() {
	let isCancellationRequested = false;
	const listeners = new Set<() => void>();
	const token = {
		get isCancellationRequested() { return isCancellationRequested; },
		onCancellationRequested: (listener: () => void) => {
			listeners.add(listener);
			return { dispose: () => listeners.delete(listener) };
		},
	} as vscode.CancellationToken;
	return {
		token,
		cancel: () => {
			if (isCancellationRequested) return;
			isCancellationRequested = true;
			for (const listener of [...listeners]) listener();
		},
		dispose: () => listeners.clear(),
	};
}

function createProvider(
	comparisonPreparationApplication: StructuralComparisonPreparationHandler,
): {
	provider: QueryEditorProvider;
	transport: ReturnType<typeof vi.fn>;
	pendingMapSpies: ReturnType<typeof createMapSpies>;
	ownerMapSpies: ReturnType<typeof createMapSpies>;
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
	const provider = Reflect.construct(QueryEditorProvider, [
		vscode.Uri.file('C:\\extension'),
		{ getConnection: vi.fn(), getConnections: vi.fn(() => []) },
		{ globalState: { get: vi.fn(), update: vi.fn(async () => undefined) } },
		{
			connectionManager: { getConnection: vi.fn(), getConnections: vi.fn(() => []) },
			client: { getDatabases: vi.fn(async () => [] as string[]) },
			assertSqlConnectionAllowed: sqlWorkbenchMocks.assertSqlConnectionAllowed,
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
	]) as QueryEditorProvider;
	const transport = vi.fn(() => true);
	const pendingMapSpies = createMapSpies();
	const ownerMapSpies = createMapSpies();
	Object.assign(provider, {
		postMessage: transport,
		panel: {},
		pendingComparisonEnsureByRequestId: pendingMapSpies.map,
		_comparisonOwnerByBoxId: ownerMapSpies.map,
	});

	vi.clearAllMocks();
	return { provider, transport, pendingMapSpies, ownerMapSpies };
}

function createMapSpies() {
	const map = new Map<string, unknown>();
	return {
		map,
		get: vi.spyOn(map, 'get'),
		set: vi.spyOn(map, 'set'),
		delete: vi.spyOn(map, 'delete'),
	};
}

function createMessages(): IncomingWebviewMessage[] {
	return [
		{
			type: 'sqlComparisonAdmissionAck',
			phase: 'staged',
			requestId: 'comparison-request-exact',
			sourceBoxId: 'comparison-source-exact',
			comparisonBoxId: 'comparison-target-exact',
			accepted: true,
		},
		{
			type: 'comparisonBoxEnsured',
			engine: 'sql',
			requestId: 'comparison-request-exact',
			sourceBoxId: 'comparison-source-exact',
			comparisonBoxId: 'comparison-target-exact',
		},
		{
			type: 'sqlComparisonRemoved',
			boxId: 'comparison-target-exact',
			sourceBoxId: 'comparison-source-exact',
		},
	];
}

function expectNoDirectEffects(
	transport: ReturnType<typeof vi.fn>,
	pendingMapSpies: ReturnType<typeof createMapSpies>,
	ownerMapSpies: ReturnType<typeof createMapSpies>,
): void {
	expect(pendingMapSpies.get).not.toHaveBeenCalled();
	expect(pendingMapSpies.set).not.toHaveBeenCalled();
	expect(pendingMapSpies.delete).not.toHaveBeenCalled();
	expect(ownerMapSpies.get).not.toHaveBeenCalled();
	expect(ownerMapSpies.set).not.toHaveBeenCalled();
	expect(ownerMapSpies.delete).not.toHaveBeenCalled();
	expect(sqlLifecycleMocks.getConnectionId).not.toHaveBeenCalled();
	expect(sqlLifecycleMocks.getSectionInstanceId).not.toHaveBeenCalled();
	expect(sqlLifecycleMocks.getGeneration).not.toHaveBeenCalled();
	expect(sqlLifecycleMocks.getTarget).not.toHaveBeenCalled();
	expect(sqlLifecycleMocks.getComparisonOwner).not.toHaveBeenCalled();
	expect(sqlLifecycleMocks.setComparisonOwner).not.toHaveBeenCalled();
	expect(sqlLifecycleMocks.removeComparisonOwner).not.toHaveBeenCalled();
	expect(sqlBrokerMocks.supersede).not.toHaveBeenCalled();
	expect(sqlWorkbenchMocks.assertSqlConnectionAllowed).not.toHaveBeenCalled();
	expect(kustoCoordinatorMocks.openSection).not.toHaveBeenCalled();
	expect(kustoCoordinatorMocks.adoptTarget).not.toHaveBeenCalled();
	expect(kustoCoordinatorMocks.getActive).not.toHaveBeenCalled();
	expect(kustoCoordinatorMocks.cancelExpected).not.toHaveBeenCalled();
	expect(copilotMocks.cancelCopilotQueryTarget).not.toHaveBeenCalled();
	expect(copilotMocks.cancelCopilotWriteQuery).not.toHaveBeenCalled();
	expect(transport).not.toHaveBeenCalled();
}

describe('QueryEditorProvider comparison preparation application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('reference-identically forwards all three routes and preparation with exact deferred settlement', async () => {
		const messages = createMessages();
		const messageSettlements = messages.map(() => deferred<void>());
		const preparationSettlement = deferred<{ boxId: string }>();
		const comparisonPreparationApplication: StructuralComparisonPreparationHandler = {
			handleMessage: vi.fn((candidate: IncomingWebviewMessage) => {
				const index = messages.indexOf(candidate);
				return index >= 0 ? messageSettlements[index].promise : undefined;
			}),
			ensureComparisonBoxInWebview: vi.fn(() => preparationSettlement.promise),
			dispose: vi.fn(),
		};
		const { provider, transport, pendingMapSpies, ownerMapSpies }
			= createProvider(comparisonPreparationApplication);
		const cancellation = createCancellation();
		const settled = [false, false, false, false];
		const requests = messages.map((message, index) => {
			const request = provider.handleWebviewMessage(message);
			void request.then(
				() => { settled[index] = true; },
				() => { settled[index] = true; },
			);
			return request;
		});
		const preparation = provider.ensureComparisonBoxInWebview(
			'comparison-source-exact',
			'SELECT 2',
			cancellation.token,
			41,
		);
		void preparation.then(
			() => { settled[3] = true; },
			() => { settled[3] = true; },
		);

		try {
			await Promise.resolve();

			expect(comparisonPreparationApplication.handleMessage).toHaveBeenCalledTimes(3);
			messages.forEach((message, index) => {
				expect(comparisonPreparationApplication.handleMessage.mock.calls[index][0]).toBe(message);
			});
			expect(comparisonPreparationApplication.ensureComparisonBoxInWebview)
				.toHaveBeenCalledWith(
					'comparison-source-exact',
					'SELECT 2',
					cancellation.token,
					41,
					undefined,
				);
			expect((provider as unknown as { comparisonPreparationApplication: unknown })
				.comparisonPreparationApplication).toBe(comparisonPreparationApplication);
			expect(settled).toEqual([false, false, false, false]);
			expectNoDirectEffects(transport, pendingMapSpies, ownerMapSpies);

			messageSettlements.forEach(settlement => settlement.resolve());
			preparationSettlement.resolve({ boxId: 'comparison-target-exact' });
			await expect(Promise.all([...requests, preparation])).resolves.toEqual([
				undefined,
				undefined,
				undefined,
				{ boxId: 'comparison-target-exact' },
			]);
			expect(settled).toEqual([true, true, true, true]);
		} finally {
			messageSettlements.forEach(settlement => settlement.resolve());
			preparationSettlement.resolve({ boxId: 'comparison-target-exact' });
			cancellation.cancel();
			await Promise.allSettled([...requests, preparation]);
			cancellation.dispose();
		}
	});

	it('adopts injected route and preparation rejections exactly without direct provider effects', async () => {
		const routeFailure = new Error('injected comparison route failed');
		const preparationFailure = new Error('injected comparison preparation failed');
		const message = createMessages()[1];
		const comparisonPreparationApplication: StructuralComparisonPreparationHandler = {
			handleMessage: vi.fn((candidate: IncomingWebviewMessage) =>
				candidate === message ? Promise.reject(routeFailure) : undefined),
			ensureComparisonBoxInWebview: vi.fn(() => Promise.reject(preparationFailure)),
			dispose: vi.fn(),
		};
		const { provider, transport, pendingMapSpies, ownerMapSpies }
			= createProvider(comparisonPreparationApplication);

		await expect(provider.handleWebviewMessage(message)).rejects.toBe(routeFailure);

		const cancellation = createCancellation();
		cancellation.cancel();
		await expect(provider.ensureComparisonBoxInWebview(
			'comparison-source-exact',
			'SELECT rejected',
			cancellation.token,
			43,
		)).rejects.toBe(preparationFailure);
		cancellation.dispose();

		expect(comparisonPreparationApplication.handleMessage).toHaveBeenCalledOnce();
		expect(comparisonPreparationApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect(comparisonPreparationApplication.ensureComparisonBoxInWebview).toHaveBeenCalledOnce();
		expectNoDirectEffects(transport, pendingMapSpies, ownerMapSpies);
	});

	it('deletes all three provider routes and displaced comparison transaction authority', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/comparisonPreparationApplicationHandler.ts');
		const lifecycleSource = readSource('src/host/sql/sqlEditorLifecycleCoordinator.ts');
		const registrySource = readSource('src/host/sql/sqlEditorSessionRegistry.ts');
		const brokerSource = readSource('src/host/sql/sqlExecutionBroker.ts');
		const kustoCoordinatorSource = readSource('src/host/kustoExecutionCoordinator.ts');
		const copilotSource = readSource('src/host/queryEditorCopilot.ts');
		const typesSource = readSource('src/host/queryEditorTypes.ts');

		for (const route of [
			'sqlComparisonAdmissionAck',
			'comparisonBoxEnsured',
			'sqlComparisonRemoved',
		]) {
			expect(providerSource).not.toContain(`case '${route}':`);
			expect(handlerSource).toContain(`case '${route}':`);
			expect(typesSource).toContain(`type: '${route}'`);
		}
		expect(providerSource.match(/^\s*case '/gm) ?? []).toHaveLength(2);
		expect(handlerSource.match(/^\s*case '/gm) ?? []).toHaveLength(3);
		expect(providerSource).not.toContain('pendingComparisonEnsureByRequestId');
		expect(providerSource).not.toContain('_comparisonOwnerByBoxId');
		expect(providerSource).not.toContain('settlePendingComparisonEnsure');
		expect(providerSource).not.toContain('rollbackPendingSqlComparison');
		expect(providerSource).not.toContain('waitForSqlComparisonAdmission');
		expect(providerSource).not.toContain('type PendingComparisonEnsure');
		expect(providerSource).toContain(
			'readonly comparisonPreparationApplication: ComparisonPreparationApplicationHandler;',
		);
		expect(providerSource).toMatch(
			/kustoSectionExecutionApplication\?: KustoSectionExecutionApplicationHandler,\s+comparisonPreparationApplication\?: ComparisonPreparationApplicationHandler,/,
		);
		expect(providerSource).toContain(
			'= this.comparisonPreparationApplication?.handleMessage(message);',
		);
		expect(providerSource).toContain(
			'this.comparisonPreparationApplication?.rejectPendingComparisonEnsures(sourceBoxId)',
		);
		expect(providerSource).toContain(
			'return this.comparisonPreparationApplication.ensureComparisonBoxInWebview(',
		);
		expect(providerSource).toContain('this.comparisonPreparationApplication.dispose();');

		expect(handlerSource).toContain('private readonly pendingComparisonEnsureByRequestId = new Map');
		expect(handlerSource).toContain('private readonly comparisonOwnerByBoxId = new Map');
		expect(handlerSource).toContain("'staged' | 'committed' | 'finalized' | 'completed' | 'rolledBack'");
		expect(handlerSource).toContain('}, 20_000);');
		expect(handlerSource).toContain('const timer = setTimeout(() => complete(false), 5_000);');
		expect(handlerSource).toContain('for (let attempt = 0; attempt < 3 && !rolledBack; attempt += 1)');
		expect(handlerSource).toContain('}, 1_000);');
		expect(handlerSource).not.toContain('SqlEditorSessionRegistry');

		expect(lifecycleSource).toContain('export class SqlEditorLifecycleCoordinator');
		expect(registrySource).toContain('export class SqlEditorSessionRegistry');
		expect(brokerSource).toContain('export class SqlExecutionBroker');
		expect(kustoCoordinatorSource).toContain('export class KustoExecutionCoordinator');
		expect(copilotSource).toContain('export class CopilotService');
	});
});
