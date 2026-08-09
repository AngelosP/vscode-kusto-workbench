import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const coordinatorMocks = vi.hoisted(() => ({
	openSection: vi.fn(() => true),
	adoptTarget: vi.fn(() => true),
	closeSection: vi.fn(),
	cancelExpected: vi.fn(() => false),
	reserve: vi.fn(() => { throw new Error('legacy coordinator reservation'); }),
	hasExactActiveRequest: vi.fn(() => false),
	rejectPreclaimedRequest: vi.fn(async () => undefined),
	getActive: vi.fn(),
	getTarget: vi.fn(),
	getDispatchAccountPartition: vi.fn(),
}));

const kustoClientMocks = vi.hoisted(() => ({
	executeQueryCancelable: vi.fn(),
}));

const selectionMocks = vi.hoisted(() => ({
	saveLastSelection: vi.fn(async () => undefined),
	findConnection: vi.fn(),
}));

const copilotMocks = vi.hoisted(() => ({
	cancelKustoCopilotSection: vi.fn(),
}));

vi.mock('../../../src/host/kustoExecutionCoordinator', () => ({
	KustoExecutionCoordinator: class {
		readonly openSection = coordinatorMocks.openSection;
		readonly adoptTarget = coordinatorMocks.adoptTarget;
		readonly closeSection = coordinatorMocks.closeSection;
		readonly cancelExpected = coordinatorMocks.cancelExpected;
		readonly reserve = coordinatorMocks.reserve;
		readonly hasExactActiveRequest = coordinatorMocks.hasExactActiveRequest;
		readonly rejectPreclaimedRequest = coordinatorMocks.rejectPreclaimedRequest;
		readonly getActive = coordinatorMocks.getActive;
		readonly getTarget = coordinatorMocks.getTarget;
		readonly getDispatchAccountPartition = coordinatorMocks.getDispatchAccountPartition;
	},
}));

vi.mock('../../../src/host/kustoClient', async importOriginal => ({
	...await importOriginal<typeof import('../../../src/host/kustoClient')>(),
	KustoQueryClient: class {
		readonly executeQueryCancelable = kustoClientMocks.executeQueryCancelable;
	},
}));

vi.mock('../../../src/host/kustoAuthPreferenceService', () => ({
	KustoAuthPreferenceService: {
		getInstance: () => ({ onDidChange: () => ({ dispose() {} }) }),
	},
}));

vi.mock('../../../src/host/queryEditorConnection', () => ({
	ConnectionService: class {
		readonly saveLastSelection = selectionMocks.saveLastSelection;
		readonly findConnection = selectionMocks.findConnection;
	},
}));

vi.mock('../../../src/host/queryEditorSchema', () => ({
	SchemaService: class {},
}));

vi.mock('../../../src/host/sql/sqlEditorLifecycleCoordinator', () => ({
	SqlEditorLifecycleCoordinator: class {
		readonly executionBroker = {};
		startSession(): void {}
	},
}));

vi.mock('../../../src/host/queryEditorCopilot', () => ({
	CopilotService: class {
		readonly cancelKustoCopilotSection = copilotMocks.cancelKustoCopilotSection;
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

type StructuralKustoSectionExecutionHandler = {
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
	kustoSectionExecutionApplication: StructuralKustoSectionExecutionHandler,
): {
	provider: QueryEditorProvider;
	transport: ReturnType<typeof vi.fn>;
	executionStartAckLedger: { get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
	publicationAckLedger: { get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
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
		kustoSectionExecutionApplication,
	]) as QueryEditorProvider;
	const transport = vi.fn(() => true);
	(provider as unknown as { postMessage: typeof transport }).postMessage = transport;
	const executionStartAckLedger = { get: vi.fn(), delete: vi.fn() };
	const publicationAckLedger = { get: vi.fn(), delete: vi.fn() };
	Object.assign(provider, {
		pendingKustoExecutionStartAcks: executionStartAckLedger,
		pendingKustoPublicationAcks: publicationAckLedger,
	});

	vi.clearAllMocks();
	return { provider, transport, executionStartAckLedger, publicationAckLedger };
}

function createMessages(): IncomingWebviewMessage[] {
	return [
		{
			type: 'kustoSectionOpen',
			boxId: 'kusto-open-exact',
			sectionInstanceId: 'kusto-open-instance-exact',
		},
		{
			type: 'kustoSectionTarget',
			boxId: 'kusto-target-exact',
			sectionInstanceId: 'kusto-target-instance-exact',
			targetGeneration: 17,
			connectionId: 'kusto-connection-exact',
			database: 'KustoDatabaseExact',
			connectionRevision: 23,
			connectionIdentityKey: 'kusto-identity-exact',
		},
		{
			type: 'kustoSectionClose',
			boxId: 'kusto-close-exact',
			sectionInstanceId: 'kusto-close-instance-exact',
		},
		{
			type: 'kustoExecutionStartedAck',
			boxId: 'kusto-start-ack-exact',
			executionId: 'kusto-start-execution-exact',
			sectionInstanceId: 'kusto-start-instance-exact',
			targetGeneration: 29,
			accepted: true,
		},
		{
			type: 'kustoPublicationAck',
			publicationId: 'kusto-publication-exact',
			phase: 'applied',
			accepted: false,
		},
		{
			type: 'executeQuery',
			query: 'StormEvents | take 10',
			connectionId: 'kusto-execute-connection-exact',
			database: 'KustoExecuteDatabaseExact',
			boxId: 'kusto-execute-exact',
			executionId: 'kusto-execution-exact',
			sectionInstanceId: 'kusto-execute-instance-exact',
			targetGeneration: 31,
			producer: 'manual',
			queryMode: 'plain',
			cacheEnabled: true,
			cacheValue: 7,
			cacheUnit: 'd',
		},
		{
			type: 'cancelQuery',
			boxId: 'kusto-cancel-exact',
			executionId: 'kusto-cancel-execution-exact',
			sectionInstanceId: 'kusto-cancel-instance-exact',
			targetGeneration: 37,
		},
	];
}

function expectNoDirectEffects(
	transport: ReturnType<typeof vi.fn>,
	executionStartAckLedger: { get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> },
	publicationAckLedger: { get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> },
): void {
	expect(coordinatorMocks.openSection).not.toHaveBeenCalled();
	expect(coordinatorMocks.adoptTarget).not.toHaveBeenCalled();
	expect(coordinatorMocks.closeSection).not.toHaveBeenCalled();
	expect(coordinatorMocks.cancelExpected).not.toHaveBeenCalled();
	expect(coordinatorMocks.reserve).not.toHaveBeenCalled();
	expect(coordinatorMocks.hasExactActiveRequest).not.toHaveBeenCalled();
	expect(coordinatorMocks.rejectPreclaimedRequest).not.toHaveBeenCalled();
	expect(kustoClientMocks.executeQueryCancelable).not.toHaveBeenCalled();
	expect(selectionMocks.saveLastSelection).not.toHaveBeenCalled();
	expect(selectionMocks.findConnection).not.toHaveBeenCalled();
	expect(copilotMocks.cancelKustoCopilotSection).not.toHaveBeenCalled();
	expect(executionStartAckLedger.get).not.toHaveBeenCalled();
	expect(executionStartAckLedger.delete).not.toHaveBeenCalled();
	expect(publicationAckLedger.get).not.toHaveBeenCalled();
	expect(publicationAckLedger.delete).not.toHaveBeenCalled();
	expect(transport).not.toHaveBeenCalled();
}

describe('QueryEditorProvider Kusto section execution application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('reference-identically forwards all seven routes and awaits their exact settlements', async () => {
		const messages = createMessages();
		const settlements = messages.map(() => deferred<void>());
		const kustoSectionExecutionApplication: StructuralKustoSectionExecutionHandler = {
			handleMessage: vi.fn((candidate: IncomingWebviewMessage) => {
				const index = messages.indexOf(candidate);
				return index >= 0 ? settlements[index].promise : undefined;
			}),
			dispose: vi.fn(),
		};
		const { provider, transport, executionStartAckLedger, publicationAckLedger }
			= createProvider(kustoSectionExecutionApplication);
		const settled = messages.map(() => false);

		const requests = messages.map((message, index) => {
			const request = provider.handleWebviewMessage(message);
			void request.finally(() => { settled[index] = true; });
			return request;
		});
		await Promise.resolve();

		expect(kustoSectionExecutionApplication.handleMessage).toHaveBeenCalledTimes(7);
		messages.forEach((message, index) => {
			expect(kustoSectionExecutionApplication.handleMessage.mock.calls[index][0]).toBe(message);
		});
		expect((provider as unknown as { kustoSectionExecutionApplication: unknown })
			.kustoSectionExecutionApplication).toBe(kustoSectionExecutionApplication);
		expect(settled).toEqual([false, false, false, false, false, false, false]);
		expectNoDirectEffects(transport, executionStartAckLedger, publicationAckLedger);

		settlements.forEach(settlement => settlement.resolve());
		await expect(Promise.all(requests)).resolves.toEqual([
			undefined, undefined, undefined, undefined, undefined, undefined, undefined,
		]);
		expect(settled).toEqual([true, true, true, true, true, true, true]);
	});

	it('adopts the injected rejection exactly without direct provider effects', async () => {
		const failure = new Error('injected Kusto section execution handler failed');
		const message = createMessages()[5];
		const kustoSectionExecutionApplication: StructuralKustoSectionExecutionHandler = {
			handleMessage: vi.fn((candidate: IncomingWebviewMessage) =>
				candidate === message ? Promise.reject(failure) : undefined),
			dispose: vi.fn(),
		};
		const { provider, transport, executionStartAckLedger, publicationAckLedger }
			= createProvider(kustoSectionExecutionApplication);

		await expect(provider.handleWebviewMessage(message)).rejects.toBe(failure);

		expect(kustoSectionExecutionApplication.handleMessage).toHaveBeenCalledOnce();
		expect(kustoSectionExecutionApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expectNoDirectEffects(transport, executionStartAckLedger, publicationAckLedger);
	});

	it('deletes seven provider cases and all displaced execution and acknowledgement authority', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/kustoSectionExecutionApplicationHandler.ts');
		const coordinatorSource = readSource('src/host/kustoExecutionCoordinator.ts');
		const clientSource = readSource('src/host/kustoClient.ts');
		const typesSource = readSource('src/host/queryEditorTypes.ts');

		for (const route of [
			'kustoSectionOpen',
			'kustoSectionTarget',
			'kustoSectionClose',
			'kustoExecutionStartedAck',
			'kustoPublicationAck',
			'executeQuery',
			'cancelQuery',
		]) {
			expect(providerSource).not.toContain(`case '${route}':`);
			expect(handlerSource).toContain(`case '${route}':`);
			expect(typesSource).toContain(`type: '${route}'`);
		}
		expect(providerSource.match(/^\s*case '/gm) ?? []).toHaveLength(13);
		expect(handlerSource.match(/^\s*case '/gm) ?? []).toHaveLength(7);
		expect(providerSource).not.toContain('pendingKustoExecutionStartAcks');
		expect(providerSource).not.toContain('pendingKustoPublicationAcks');
		expect(providerSource).not.toContain('kustoExecutionAckKey');
		expect(providerSource).not.toContain('claimKustoExecutionInWebview');
		expect(providerSource).not.toContain('executeQueryFromWebview');
		expect(providerSource).toContain(
			'readonly kustoSectionExecutionApplication: KustoSectionExecutionApplicationHandler;',
		);
		expect(providerSource).toMatch(
			/copilotQueryWorkflowApplication\?: CopilotQueryWorkflowApplicationHandler,\s+kustoSectionExecutionApplication\?: KustoSectionExecutionApplicationHandler,/,
		);
		expect(providerSource).toContain(
			'= this.kustoSectionExecutionApplication?.handleMessage(message);',
		);
		expect(providerSource).toContain('this.kustoSectionExecutionApplication.dispose();');
		expect(providerSource).toContain(
			'return this.kustoSectionExecutionApplication.postKustoPublication(message);',
		);
		expect(providerSource).toContain(
			'return this.kustoSectionExecutionApplication.executeKustoSectionQuery(options);',
		);
		expect(providerSource).toContain(
			'.getCurrentKustoConnectionForDispatch(connectionId, dispatch);',
		);
		expect(providerSource).not.toContain('getConnectionIncarnation(connectionId) === dispatch.connectionRevision');

		expect(handlerSource).toContain('private readonly pendingExecutionStartAcks = new Map');
		expect(handlerSource).toContain('private readonly pendingPublicationAcks = new Map');
		expect(handlerSource).toContain('const publicationDeadline = this.options.now() + 5_000;');
		expect(handlerSource).toContain('this.options.coordinator.reserve(request)');
		expect(handlerSource).toContain('this.options.kustoClient.executeQueryCancelable(');
		expect(handlerSource).toContain('this.options.connection.saveLastSelection(');
		expect(handlerSource).toContain('this.options.cancelKustoCopilotSection(');
		expect(coordinatorSource).toContain('export class KustoExecutionCoordinator');
		expect(coordinatorSource).toContain('reserve(request: KustoExecutionRequestIdentity)');
		expect(coordinatorSource).toContain('cancelExpected(identity: Pick<KustoExecutionRequestIdentity');
		expect(clientSource).toContain('executeQueryCancelable(');
	});
});