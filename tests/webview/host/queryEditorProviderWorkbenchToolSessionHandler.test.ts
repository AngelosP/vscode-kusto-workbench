import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const toolOrchestratorMocks = vi.hoisted(() => ({
	connect: vi.fn(() => 41),
	activateConnection: vi.fn(),
	disconnectIfOwner: vi.fn(),
	handleKustoExecutionStarted: vi.fn(),
	handleDevelopmentNoteMutationResponse: vi.fn(() => false),
	handleWebviewResponse: vi.fn(),
}));

const authPreferencesMocks = vi.hoisted(() => ({
	getAccounts: vi.fn(async () => [] as Array<{ id: string; label: string; lastUsedAt: number }>),
	getPreferredAccountId: () => undefined,
	getAccountPartition: () => 'account',
}));

vi.mock('../../../src/host/kustoClient', async importOriginal => ({
	...await importOriginal<typeof import('../../../src/host/kustoClient')>(),
	KustoQueryClient: class { getAccountPartition(): string { return 'account'; } },
}));

vi.mock('../../../src/host/kustoAuthPreferenceService', () => ({
	KustoAuthPreferenceService: {
		getInstance: () => ({ ...authPreferencesMocks, onDidChange: () => ({ dispose() {} }) }),
	},
}));

vi.mock('../../../src/host/queryEditorConnection', () => ({
	ConnectionService: class {
		getLastConnectionId(): undefined { return undefined; }
		getLastDatabase(): undefined { return undefined; }
		getCachedDatabases(): object { return {}; }
	},
}));

vi.mock('../../../src/host/queryEditorSchema', () => ({
	SchemaService: class {},
}));

vi.mock('../../../src/host/sql/sqlEditorLifecycleCoordinator', () => ({
	SqlEditorLifecycleCoordinator: class {
		startSession(): void {}
		getConnectionId = vi.fn();
		getFirstConnectionId = vi.fn();
		getReadyToolOwner = vi.fn();
		getSectionInstanceId = vi.fn();
		getGeneration = vi.fn();
		reconcileComparisonOwners = vi.fn();
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
	toolOrchestrator: toolOrchestratorMocks,
}));

import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import { KustoWorkbenchToolOrchestrator } from '../../../src/host/kustoWorkbenchTools';
import { StsRuntime } from '../../../src/host/sql/stsRuntime';
import type { SqlReadyToolOwner } from '../../../src/host/sql/sqlEditorSessionRegistry';
import * as editingPreferences from '../../../src/host/editingPreferences';
import type { KustoLeaveNoTracePolicySnapshot } from '../../../src/host/kustoLeaveNoTracePolicyStore';
import type { WorkbenchToolSessionOrchestrator } from '../../../src/host/workbenchToolSessionApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';
import { MainWebviewStartupGateway, MAIN_WEBVIEW_DISPATCHER_READY_TYPE, isMainWebviewCorrelatedReply } from '../../../src/host/mainWebviewStartupGateway';
import { createToolStateResponseMessage } from '../../../src/shared/toolStateSnapshotProtocol';

type StructuralWorkbenchToolSessionHandler = {
	activate: ReturnType<typeof vi.fn>;
	handleDevelopmentNoteMutationResponse: ReturnType<typeof vi.fn>;
	handleDevelopmentNoteMutationResponseAdmission?: ReturnType<typeof vi.fn>;
	hasPendingDevelopmentNoteMutationResponse?: ReturnType<typeof vi.fn>;
	handleMessage: ReturnType<typeof vi.fn>;
	requestSectionsFromWebview: ReturnType<typeof vi.fn>;
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

function createProvider(workbenchToolSessionApplication?: StructuralWorkbenchToolSessionHandler,
	connectionManager: object = { getConnection: vi.fn(), getConnections: vi.fn(() => []) },
	sqlWorkbench: object = {
		connectionManager: { getConnection: vi.fn(), getConnections: vi.fn(() => []) },
		client: { getDatabases: vi.fn(async () => [] as string[]) },
	}): {
	provider: QueryEditorProvider;
	developmentNoteMutationApplication: { handleMessage: ReturnType<typeof vi.fn> };
} {
	const developmentNoteMutationApplication = {
		updateDevelopmentNotes: vi.fn(async () => ({ success: true })),
		handleMessage: vi.fn(() => false),
		dispose: vi.fn(),
	};
	const copilotInlineCompletionApplication = {
		handleMessage: vi.fn(() => undefined),
		dispose: vi.fn(),
	};
	const copilotAvailabilityApplication = {
		handleMessage: vi.fn(() => undefined),
		dispose: vi.fn(),
	};
	const copilotWriteQueryPreparationApplication = {
		handleMessage: vi.fn(() => undefined),
		dispose: vi.fn(),
	};
	const copilotConversationClearApplication = {
		handleMessage: vi.fn(() => undefined),
		dispose: vi.fn(),
	};
	const copilotHistoryRemovalApplication = {
		handleMessage: vi.fn(() => undefined),
		dispose: vi.fn(),
	};
	const copilotChatFirstTimeApplication = {
		handleMessage: vi.fn(() => undefined),
		dispose: vi.fn(),
	};
	const provider = Reflect.construct(QueryEditorProvider, [
		vscode.Uri.file('C:\\extension'),
		connectionManager,
		{ globalState: { get: vi.fn(), update: vi.fn(async () => undefined) } },
		sqlWorkbench,
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
		copilotInlineCompletionApplication,
		copilotAvailabilityApplication,
		copilotWriteQueryPreparationApplication,
		copilotConversationClearApplication,
		copilotHistoryRemovalApplication,
		copilotChatFirstTimeApplication,
		workbenchToolSessionApplication,
	]) as QueryEditorProvider;
	return { provider, developmentNoteMutationApplication };
}

async function createReadyReadHarness(connectionManager?: object, initialRuntimeId = 'runtime-1', sqlWorkbench?: object) {
	const { provider } = createProvider(undefined, connectionManager, sqlWorkbench);
	const internal = provider as unknown as {
		panel: vscode.WebviewPanel;
		_panelDisposed: boolean;
		workbenchToolSessionApplication: { dispose(): void };
		sqlLifecycle: { reconcileComparisonOwners: ReturnType<typeof vi.fn> };
	};
	let listener: ((message: unknown) => unknown) | undefined;
	const posted: Array<{ type: string; probeId?: string; requestId?: string }> = [];
	const panel = {
		visible: false, active: false, reveal: vi.fn(),
		webview: {
			onDidReceiveMessage: (handler: (message: unknown) => unknown) => {
				listener = handler;
				return { dispose: vi.fn() };
			},
			postMessage: vi.fn(async (message: unknown) => {
				posted.push(message as typeof posted[number]);
				return true;
			}),
		},
		onDidDispose: () => ({ dispose: vi.fn() }),
	} as unknown as vscode.WebviewPanel;
	internal.panel = panel;
	internal._panelDisposed = false;
	const gateway = new MainWebviewStartupGateway<IncomingWebviewMessage>({
		panel, admitInbound: input => input as IncomingWebviewMessage,
		isCorrelatedReply: isMainWebviewCorrelatedReply,
	});
	const transport = vi.fn((message: unknown, signal?: AbortSignal, isCurrent?: () => boolean) => gateway.postMessage(message, signal, isCurrent));
	provider.setMessageTransport(transport, () => gateway.beginDispatcherRevalidation(),
		() => gateway.readinessIdentity, () => gateway.waitForReadDispatcherReady(), () => gateway.runtimeIdentity);
	provider.setWorkbenchToolMutationReadiness(async () => true);
	provider.setWorkbenchToolSnapshotIdentity(() => 'projection-1');
	await gateway.setInboundHandler(message => provider.handlePanelWebviewMessage(message));
	const receive = (message: unknown) => listener!(message);
	if (initialRuntimeId) await receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: initialRuntimeId });
	return {
		provider, gateway, panel, posted, transport, receive,
		probes: () => posted.filter(message => message.type === 'mainWebviewDispatcherProbe'),
		snapshots: () => posted.filter(message => message.type === 'requestToolState'),
		reconcileComparisonOwners: internal.sqlLifecycle.reconcileComparisonOwners,
		dispose: () => {
			internal._panelDisposed = true;
			internal.workbenchToolSessionApplication.dispose();
			gateway.dispose();
		},
	};
}

async function createKustoExecutionHarness(autoReadiness = false, initialRuntimeId = 'runtime-1') {
	const preferences = vi.spyOn(editingPreferences, 'getEditingPreferencesData').mockReturnValue({
		type: 'editingPreferencesData', revision: 1,
		caretDocsEnabled: true, caretDocsEnabledUserSet: false,
		autoTriggerAutocompleteEnabled: true, autoTriggerAutocompleteEnabledUserSet: false,
		copilotInlineCompletionsEnabled: true, copilotInlineCompletionsEnabledUserSet: false,
	});
	const accounts = deferred<Array<{ id: string; label: string; lastUsedAt: number }>>();
	authPreferencesMocks.getAccounts.mockImplementation(() => accounts.promise);
	const savedConnection = { id: 'kusto-provider', name: 'Provider', clusterUrl: 'https://cluster.kusto.windows.net' };
	let lockHeld = false;
	const manager = {
		getConnections: () => [savedConnection],
		getConnection: () => savedConnection,
		getConnectionIncarnation: () => 1,
		normalizeClusterUrl: () => 'cluster',
		runWithLeaveNoTraceSnapshotLock: async <T>(run: (snapshot: KustoLeaveNoTracePolicySnapshot) => Promise<T>) => {
			lockHeld = true;
			try { return await run({ clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {} }); }
			finally { lockHeld = false; }
		},
	};
	const harness = await createReadyReadHarness(manager, initialRuntimeId);
	if (autoReadiness) {
		const postMessage = vi.mocked(harness.panel.webview.postMessage).getMockImplementation()!;
		vi.mocked(harness.panel.webview.postMessage).mockImplementation(async message => {
			const delivered = await postMessage(message);
			if (message.type === 'mainWebviewDispatcherProbe') {
				await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: message.probeId });
			}
			if (message.type === 'requestToolState') {
				const response = createToolStateResponseMessage(message.requestId, [
					{ id: 'query_sibling', type: 'query', connectionId: 'other-connection', clusterUrl: 'https://other.kusto.windows.net' },
					{ id: 'query_provider', type: 'query', connectionId: savedConnection.id, clusterUrl: savedConnection.clusterUrl,
						database: 'Database', query: 'print Stored = 1', sectionInstanceId: 'provider-instance', targetGeneration: 1 },
				]);
				expect(response.ok).toBe(true);
				if (response.ok) await harness.receive(response.value);
			}
			return delivered;
		});
	}
	Reflect.set(KustoWorkbenchToolOrchestrator, 'instance', undefined);
	const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
		Reflect.get(harness.provider, 'context'), manager as never, () => ({} as never), {} as never,
	);
	toolOrchestratorMocks.connect.mockImplementation((...args: unknown[]) => Reflect.apply(orchestrator.connect, orchestrator, args));
	toolOrchestratorMocks.activateConnection.mockImplementation(token => orchestrator.activateConnection(token));
	toolOrchestratorMocks.disconnectIfOwner.mockImplementation(token => orchestrator.disconnectIfOwner(token));
	toolOrchestratorMocks.handleWebviewResponse.mockImplementation((requestId, result, error) =>
		orchestrator.handleWebviewResponse(requestId, result, error));
	const session = Reflect.get(harness.provider, 'workbenchToolSessionApplication') as { activate(): void };
	session.activate();
	return {
		...harness, orchestrator, accounts, isLockHeld: () => lockHeld,
		input: { sectionId: 'query_provider', clusterUrl: savedConnection.clusterUrl, connectionId: savedConnection.id,
			database: 'Database', execute: true },
		stages: () => harness.posted.filter(message => message.type === 'kustoPublicationStage') as unknown as Array<{
			publicationId: string; payload: { connectionsRevision: number };
		}>,
		executions: () => harness.posted.filter(message => message.type === 'toolConfigureQuerySection'),
		ack: (publicationId: string, phase: 'staged' | 'applied', accepted = true) =>
			harness.receive({ type: 'kustoPublicationAck', publicationId, phase, accepted }),
		dispose: () => {
			Reflect.get(harness.provider, 'kustoConnectionsProjectionApplication').dispose();
			Reflect.get(harness.provider, 'kustoSectionExecutionApplication').dispose();
			harness.dispose();
			toolOrchestratorMocks.connect.mockReset().mockReturnValue(41);
			toolOrchestratorMocks.activateConnection.mockReset();
			toolOrchestratorMocks.disconnectIfOwner.mockReset();
			toolOrchestratorMocks.handleWebviewResponse.mockReset();
			authPreferencesMocks.getAccounts.mockReset().mockResolvedValue([]);
			preferences.mockRestore();
			Reflect.set(KustoWorkbenchToolOrchestrator, 'instance', undefined);
		},
	};
}

async function createSqlInstallationHarness(aad = false) {
	const installation = deferred<string | null>();
	const managerReady = deferred<void>();
	const manager = {
		epoch: 0, isRunning: false, isFailed: false, ready: managerReady.promise,
		start: vi.fn(async () => {
			manager.epoch = 1;
			manager.isRunning = true;
			managerReady.resolve();
		}),
		stop: vi.fn(async () => { manager.isRunning = false; }),
		onDidFail: vi.fn(() => ({ dispose: vi.fn() })),
	};
	const dependencies = {
		ensureSts: vi.fn(() => installation.promise),
		invalidateStsCache: vi.fn(async () => undefined),
		createProcessManager: vi.fn(() => manager as never),
	};
	const runtime = new StsRuntime({
		globalStorageUri: { fsPath: 'sql-installation-fixture' }, logUri: { fsPath: 'sql-log-fixture' },
	} as never, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, dependencies);
	const savedConnection = {
		id: 'sql-provider', name: 'SQL Provider', serverUrl: 'server.example', dialect: 'mssql',
		authType: aad ? 'aad' : 'sql', username: 'fixture-user',
	};
	let currentConnection: typeof savedConnection | undefined = savedConnection;
	let principal = 'fixture-account-1';
	let protectedConnection = false;
	let revocationGeneration = 0;
	const sqlConnectionManager = {
		getConnection: (id: string) => id === savedConnection.id ? currentConnection : undefined,
		getConnections: () => currentConnection ? [currentConnection] : [],
		assertConnectionCurrent: vi.fn(async () => undefined),
	};
	const sqlWorkbench = {
		connectionManager: sqlConnectionManager,
		client: { getDatabases: vi.fn(async () => [] as string[]) },
		prepareToolExecution: () => runtime.prepareInstallation(),
	};
	const harness = await createReadyReadHarness(undefined, 'runtime-1', sqlWorkbench);
	const context = Reflect.get(harness.provider, 'context') as vscode.ExtensionContext;
	vi.mocked(context.globalState.get).mockImplementation(key => key === 'sql.auth.serverAccountMap'
		? { [savedConnection.serverUrl]: principal } : undefined);
	const originalDocuments = vscode.workspace.textDocuments;
	let source = '{"kind":"sqlx","state":{"sections":[{"id":"sql_probe","type":"sql","query":"SELECT 1 AS Probe"}]}}';
	const document = { uri: vscode.Uri.file('C:\\workspace\\sql-installation.sqlx'), version: 1,
		isClosed: false, getText: () => source };
	Reflect.set(vscode.workspace, 'textDocuments', [...originalDocuments, document]);
	harness.provider.documentUri = document.uri.toString();
	const lifecycle = Reflect.get(harness.provider, 'sqlLifecycle') as {
		getConnectionId: ReturnType<typeof vi.fn>;
		getReadyToolOwner: ReturnType<typeof vi.fn>;
		getSectionInstanceId: ReturnType<typeof vi.fn>;
		getGeneration: ReturnType<typeof vi.fn>;
	};
	let owner: SqlReadyToolOwner | undefined;
	lifecycle.getConnectionId.mockImplementation(() => owner?.connectionId);
	lifecycle.getReadyToolOwner.mockImplementation(() => owner);
	lifecycle.getSectionInstanceId.mockImplementation((sectionId: string) => sectionId === 'sql_probe' ? 'sql-probe-instance' : undefined);
	lifecycle.getGeneration.mockImplementation(() => owner?.generation ?? 0);
	Reflect.set(KustoWorkbenchToolOrchestrator, 'instance', undefined);
	const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
		context, { getConnections: () => [] } as never,
		() => sqlConnectionManager as never, {} as never,
		async () => protectedConnection ? [savedConnection.id] : [],
		async () => { if (protectedConnection) throw new Error('SQL connection is protected by Leave No Trace.'); },
		() => revocationGeneration,
	);
	toolOrchestratorMocks.connect.mockImplementation((...args: unknown[]) => Reflect.apply(orchestrator.connect, orchestrator, args));
	toolOrchestratorMocks.activateConnection.mockImplementation(token => orchestrator.activateConnection(token));
	toolOrchestratorMocks.disconnectIfOwner.mockImplementation(token => orchestrator.disconnectIfOwner(token));
	toolOrchestratorMocks.handleWebviewResponse.mockImplementation((requestId, result, error) =>
		orchestrator.handleWebviewResponse(requestId, result, error));
	const postMessage = vi.mocked(harness.panel.webview.postMessage).getMockImplementation()!;
	vi.mocked(harness.panel.webview.postMessage).mockImplementation(async message => {
		const delivered = await postMessage(message);
		if (message.type === 'mainWebviewDispatcherProbe') {
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: message.probeId });
		}
		if (message.type === 'requestToolState') {
			const response = createToolStateResponseMessage(message.requestId, [{
				id: 'sql_probe', type: 'sql', query: 'SELECT 1 AS Probe', database: 'Database',
				...(owner ? { connectionId: owner.connectionId, ownerToken: owner.ownerToken } : {}),
			}]);
			if (response.ok) await harness.receive(response.value);
		}
		if (message.type === 'toolConfigureSqlSection') {
			void runtime.getProcessManager().then(async () => {
				owner = { connectionId: savedConnection.id, database: 'Database', ownerToken: 'sql-owner-1', generation: 1 };
				await harness.receive({ type: 'toolResponse', requestId: message.requestId, result: {
					success: true, resultPreview: 'Probe\n1', executionId: message.input.executionId, executionOwner: owner,
				} });
			}, async error => {
				await harness.receive({ type: 'toolResponse', requestId: message.requestId, error: String(error) });
			});
		}
		return delivered;
	});
	Reflect.get(harness.provider, 'workbenchToolSessionApplication').activate();
	const wireInput = { sectionId: 'sql_probe', connectionId: savedConnection.id, database: 'Database', execute: true };
	return {
		...harness, orchestrator, runtime, installation, dependencies, manager, document, wireInput,
		input: { ...wireInput, targetFileUri: document.uri.toString() },
		change: async (kind: string) => {
			if (kind === 'source version') document.version++;
			if (kind === 'source bytes') source = 'changed source';
			if (kind === 'removed document') Reflect.set(vscode.workspace, 'textDocuments', originalDocuments);
			if (kind === 'projection') harness.provider.setWorkbenchToolSnapshotIdentity(() => 'projection-2');
			if (kind === 'runtime') await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-2' });
			if (kind === 'connection') currentConnection = { ...savedConnection, serverUrl: 'changed.example' };
			if (kind === 'removed connection') currentConnection = undefined;
			if (kind === 'principal') principal = 'fixture-account-2';
			if (kind === 'policy') { protectedConnection = true; revocationGeneration++; }
			if (kind === 'revocation') revocationGeneration++;
			if (kind === 'owner' && owner) owner = { ...owner, ownerToken: 'sql-owner-2', generation: 2 };
			if (kind === 'disposal') harness.dispose();
			if (kind === 'URI') {
				const connections = Reflect.get(orchestrator, 'liveConnections') as Map<number, { documentUri: string }>;
				for (const connection of connections.values()) connection.documentUri = vscode.Uri.file('C:\\workspace\\renamed.sqlx').toString();
			}
		},
		executions: () => harness.posted.filter(message => message.type === 'toolConfigureSqlSection'),
		dispose: async () => {
			harness.dispose();
			await runtime.dispose();
			Reflect.set(vscode.workspace, 'textDocuments', originalDocuments);
			toolOrchestratorMocks.connect.mockReset().mockReturnValue(41);
			toolOrchestratorMocks.activateConnection.mockReset();
			toolOrchestratorMocks.disconnectIfOwner.mockReset();
			toolOrchestratorMocks.handleWebviewResponse.mockReset();
			Reflect.set(KustoWorkbenchToolOrchestrator, 'instance', undefined);
		},
	};
}

function sqlInstallationCancellation() {
	let cancelled = false;
	const listeners = new Set<() => void>();
	return {
		listeners,
		token: {
			get isCancellationRequested() { return cancelled; },
			onCancellationRequested: (listener: () => void) => {
				listeners.add(listener);
				return { dispose: () => listeners.delete(listener) };
			},
		} as vscode.CancellationToken,
		cancel: () => {
			cancelled = true;
			for (const listener of [...listeners]) listener();
		},
	};
}

describe('QueryEditorProvider Workbench tool session application', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('holds the first SQL execute post until real STS installation finishes beyond the connection deadline', async () => {
		vi.useFakeTimers();
		const harness = await createSqlInstallationHarness();
		const execution = harness.orchestrator.configureSqlSection(harness.input).catch(error => error);
		try {
			await vi.advanceTimersByTimeAsync(30_001);
			expect(harness.dependencies.ensureSts).toHaveBeenCalledOnce();
			expect(harness.executions(), 'SQL configure must not be posted while verified STS installation is pending').toEqual([]);
			expect(harness.dependencies.createProcessManager).not.toHaveBeenCalled();
			harness.installation.resolve('verified-sts-binary');
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.executions()).toHaveLength(1);
			expect(harness.executions()[0]).toMatchObject({ input: harness.wireInput });
			expect(harness.executions()[0]).not.toHaveProperty('input.query');
			await expect(execution).resolves.toEqual({ success: true, resultPreview: 'Probe\n1' });
			expect(harness.manager.start).toHaveBeenCalledOnce();
			expect(harness.manager.isRunning).toBe(true);
			await expect(harness.orchestrator.configureSqlSection({ sectionId: 'sql_probe', execute: true,
				targetFileUri: harness.input.targetFileUri }))
				.resolves.toEqual({ success: true, resultPreview: 'Probe\n1' });
			expect(harness.executions()).toHaveLength(2);
			expect(harness.dependencies.ensureSts).toHaveBeenCalledOnce();
			expect(harness.manager.start).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			harness.installation.resolve('verified-sts-binary');
			await vi.advanceTimersByTimeAsync(0);
			await harness.dispose();
			await execution;
		}
	});

	it.each(['rejected installer', 'unavailable installer', 'cancelled', 'setup deadline'])(
		'retires SQL installation after %s without late execution or retained timers', async failure => {
			vi.useFakeTimers();
			const harness = await createSqlInstallationHarness();
			const cancellation = sqlInstallationCancellation();
			let settled = false;
			const execution = harness.orchestrator.configureSqlSection(harness.input, cancellation.token)
				.then(result => { settled = true; return result; }, error => { settled = true; return error; });
			try {
				await vi.advanceTimersByTimeAsync(0);
				expect(harness.dependencies.ensureSts).toHaveBeenCalledOnce();
				if (failure === 'rejected installer') harness.installation.reject(new Error('fixture installer failed'));
				if (failure === 'unavailable installer') harness.installation.resolve(null);
				if (failure === 'cancelled') cancellation.cancel();
				if (failure === 'setup deadline') {
					await vi.advanceTimersByTimeAsync(359_999);
					expect(settled).toBe(false);
					await vi.advanceTimersByTimeAsync(1);
				}
				await vi.advanceTimersByTimeAsync(0);
				expect(settled).toBe(true);
				const result = await execution;
				expect(result).toBeInstanceOf(Error);
				if (failure === 'cancelled') expect(result).toBeInstanceOf(vscode.CancellationError);
				if (failure === 'setup deadline') expect(result.message).toBe('SQL Tools Service installation preparation timed out.');
				harness.installation.resolve('verified-sts-binary');
				await vi.advanceTimersByTimeAsync(0);
				expect(harness.executions()).toEqual([]);
				expect(harness.dependencies.createProcessManager).not.toHaveBeenCalled();
				expect(Reflect.get(harness.orchestrator, 'pendingResponses').size).toBe(0);
				expect(cancellation.listeners.size).toBe(0);
				expect(vi.getTimerCount()).toBe(0);
				if (failure === 'rejected installer' || failure === 'unavailable installer') {
					harness.dependencies.ensureSts.mockResolvedValue('verified-sts-binary');
					await expect(harness.orchestrator.configureSqlSection(harness.input))
						.resolves.toEqual({ success: true, resultPreview: 'Probe\n1' });
					expect(harness.executions()).toHaveLength(1);
					expect(harness.dependencies.ensureSts).toHaveBeenCalledTimes(2);
				}
			} finally {
				harness.installation.resolve('verified-sts-binary');
				await harness.dispose();
				await execution;
			}
		},
	);

	it('cancels one SQL caller promptly while the other caller keeps the single shared installer', async () => {
		vi.useFakeTimers();
		const harness = await createSqlInstallationHarness();
		const cancellation = sqlInstallationCancellation();
		const first = harness.orchestrator.configureSqlSection(harness.input, cancellation.token).catch(error => error);
		const second = harness.orchestrator.configureSqlSection(harness.input).catch(error => error);
		try {
			await vi.advanceTimersByTimeAsync(30_001);
			expect(harness.dependencies.ensureSts).toHaveBeenCalledOnce();
			cancellation.cancel();
			await expect(first).resolves.toBeInstanceOf(vscode.CancellationError);
			expect(cancellation.listeners.size).toBe(0);
			expect(harness.executions()).toEqual([]);
			harness.installation.resolve('verified-sts-binary');
			await vi.advanceTimersByTimeAsync(0);
			await expect(second).resolves.toEqual({ success: true, resultPreview: 'Probe\n1' });
			expect(harness.executions()).toHaveLength(1);
			expect(harness.dependencies.ensureSts).toHaveBeenCalledOnce();
			expect(harness.manager.start).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			harness.installation.resolve('verified-sts-binary');
			await harness.dispose();
			await Promise.all([first, second]);
		}
	});

	it.each(['source version', 'source bytes', 'removed document', 'URI', 'projection', 'runtime',
		'connection', 'removed connection', 'principal', 'policy', 'revocation', 'disposal'])(
		'rejects SQL execution after %s changes during binary setup', async change => {
			vi.useFakeTimers();
			const harness = await createSqlInstallationHarness(change === 'principal');
			const execution = harness.orchestrator.configureSqlSection(harness.input).catch(error => error);
			try {
				await vi.advanceTimersByTimeAsync(0);
				expect(harness.dependencies.ensureSts).toHaveBeenCalledOnce();
				await harness.change(change);
				harness.installation.resolve('verified-sts-binary');
				await vi.advanceTimersByTimeAsync(0);
				await expect(execution).resolves.toBeInstanceOf(Error);
				expect(harness.executions()).toEqual([]);
				expect(harness.dependencies.createProcessManager).not.toHaveBeenCalled();
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				harness.installation.resolve('verified-sts-binary');
				await harness.dispose();
				await execution;
			}
		},
	);

	it.each(['source version', 'projection', 'principal', 'policy'])(
		'rejects queued SQL physical delivery after %s changes', async change => {
			vi.useFakeTimers();
			const harness = await createSqlInstallationHarness(change === 'principal');
			const held = deferred<boolean>();
			const execution = harness.orchestrator.configureSqlSection(harness.input).catch(error => error);
			let head: PromiseLike<unknown> | undefined;
			try {
				await vi.advanceTimersByTimeAsync(0);
				head = harness.gateway.postDocumentProjection({
					preflight: () => held.promise, prepare: () => ({ message: { type: 'heldSqlHead' } }),
				});
				harness.installation.resolve('verified-sts-binary');
				await vi.advanceTimersByTimeAsync(0);
				expect(harness.transport.mock.calls.some(([message]) => Reflect.get(message as object, 'type') === 'toolConfigureSqlSection')).toBe(true);
				expect(harness.executions()).toEqual([]);
				await harness.change(change);
				held.resolve(true);
				await head;
				await vi.advanceTimersByTimeAsync(0);
				await expect(execution).resolves.toBeInstanceOf(Error);
				expect(harness.executions(), 'a stale SQL request must be rejected before physical delivery').toEqual([]);
				expect(harness.dependencies.createProcessManager).not.toHaveBeenCalled();
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				held.resolve(true);
				harness.installation.resolve('verified-sts-binary');
				await head;
				await harness.dispose();
				await execution;
			}
		},
	);

	it('retains an execute-only warm SQL owner through queued physical delivery', async () => {
		vi.useFakeTimers();
		const harness = await createSqlInstallationHarness();
		const held = deferred<boolean>();
		let execution: Promise<unknown> | undefined;
		let head: PromiseLike<unknown> | undefined;
		try {
			harness.installation.resolve('verified-sts-binary');
			await expect(harness.orchestrator.configureSqlSection(harness.input))
				.resolves.toEqual({ success: true, resultPreview: 'Probe\n1' });
			expect(harness.manager.start).toHaveBeenCalledOnce();
			const post = harness.transport.getMockImplementation()!;
			harness.transport.mockImplementation((message, signal, isCurrent) => {
				if (Reflect.get(message as object, 'type') === 'toolConfigureSqlSection') {
					head = harness.gateway.postDocumentProjection({
						preflight: () => held.promise, prepare: () => ({ message: { type: 'heldWarmSqlHead' } }),
					});
				}
				return post(message, signal, isCurrent);
			});
			execution = harness.orchestrator.configureSqlSection({ sectionId: 'sql_probe', execute: true,
				targetFileUri: harness.input.targetFileUri }).catch(error => error);
			await vi.advanceTimersByTimeAsync(0);
			expect(head).toBeDefined();
			await harness.change('owner');
			held.resolve(true);
			await head;
			await expect(execution).resolves.toBeInstanceOf(Error);
			expect(harness.executions()).toHaveLength(1);
			expect(harness.dependencies.ensureSts).toHaveBeenCalledOnce();
			expect(harness.manager.start).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			held.resolve(true);
			harness.installation.resolve('verified-sts-binary');
			await head;
			await harness.dispose();
			await execution;
		}
	});

	it('waits for registered loading Kusto readiness before publication and admits the initial projection once', async () => {
		vi.useFakeTimers();
		const harness = await createKustoExecutionHarness();
		const ready = deferred<boolean>();
		let projection = 'projection-0';
		harness.provider.setWorkbenchToolMutationReadiness(() => ready.promise);
		harness.provider.setWorkbenchToolSnapshotIdentity(() => projection);
		const execution = harness.orchestrator.configureQuerySection(harness.input).catch(error => error);
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(authPreferencesMocks.getAccounts).not.toHaveBeenCalled();
			expect(harness.stages()).toEqual([]);
			expect(harness.executions()).toEqual([]);
			for (const probe of harness.probes()) {
				await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: probe.probeId });
			}
			await vi.advanceTimersByTimeAsync(0);
			expect(authPreferencesMocks.getAccounts).not.toHaveBeenCalled();
			projection = 'projection-1';
			ready.resolve(true);
			harness.accounts.resolve([]);
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.stages()).toHaveLength(1);
			const stage = harness.stages()[0];
			await harness.ack(stage.publicationId, 'staged');
			await harness.ack(stage.publicationId, 'applied');
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.executions()).toHaveLength(1);
			const request = harness.executions()[0];
			expect(request).toMatchObject({ input: harness.input });
			await harness.receive({ type: 'toolResponse', requestId: request.requestId, result: { success: true } });
			await expect(execution).resolves.toEqual({ success: true });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			ready.resolve(false);
			harness.accounts.resolve([]);
			harness.dispose();
			await execution;
		}
	});

	it.each(['runtime replacement', 'rejected readiness', 'cancelled', 'timed out before readiness', 'timed out during refresh'])(
		'retires Kusto preparation after %s without late execution or stranded timers', async failure => {
			vi.useFakeTimers();
			const harness = await createKustoExecutionHarness();
			const ready = deferred<boolean>();
			harness.provider.setWorkbenchToolMutationReadiness(() => ready.promise);
			let cancelled = false;
			let settled = false;
			const listeners = new Set<() => void>();
			const cancellation = {
				get isCancellationRequested() { return cancelled; },
				onCancellationRequested: (listener: () => void) => {
					listeners.add(listener);
					return { dispose: () => listeners.delete(listener) };
				},
			} as vscode.CancellationToken;
			const execution = harness.orchestrator.configureQuerySection(harness.input, cancellation)
				.then(result => { settled = true; return result; }, error => { settled = true; return error; });
			try {
				await vi.advanceTimersByTimeAsync(1_000);
				expect(authPreferencesMocks.getAccounts).not.toHaveBeenCalled();
				expect(new Set(harness.probes().map(probe => probe.probeId)).size).toBe(1);
				await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: harness.probes()[0].probeId });
				await vi.advanceTimersByTimeAsync(0);
				if (failure === 'runtime replacement') {
					await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-2' });
					ready.resolve(true);
				} else if (failure === 'rejected readiness') ready.resolve(false);
				else if (failure === 'cancelled') {
					cancelled = true;
					for (const listener of [...listeners]) listener();
				} else {
					await vi.advanceTimersByTimeAsync(19_000);
					if (failure === 'timed out during refresh') ready.resolve(true);
					await vi.advanceTimersByTimeAsync(9_999);
					expect(settled).toBe(false);
					await vi.advanceTimersByTimeAsync(1);
				}
				const result = await execution;
				expect(result).toBeInstanceOf(Error);
				if (failure.startsWith('timed out')) expect(result.message).toBe('Kusto execution preparation timed out.');
				if (failure === 'cancelled') expect(result).toBeInstanceOf(vscode.CancellationError);
				ready.resolve(true);
				harness.accounts.resolve([]);
				await vi.advanceTimersByTimeAsync(0);
				if (failure === 'timed out during refresh') {
					expect(authPreferencesMocks.getAccounts).toHaveBeenCalledOnce();
					expect(harness.stages()).toHaveLength(1);
					await harness.ack(harness.stages()[0].publicationId, 'staged');
					await harness.ack(harness.stages()[0].publicationId, 'applied');
					await vi.advanceTimersByTimeAsync(0);
				} else expect(authPreferencesMocks.getAccounts).not.toHaveBeenCalled();
				expect(harness.executions()).toEqual([]);
				expect(Reflect.get(harness.orchestrator, 'pendingResponses').size).toBe(0);
				expect(listeners.size).toBe(0);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				ready.resolve(false);
				harness.accounts.resolve([]);
				harness.dispose();
				await execution;
			}
		},
	);

	it('allows the first runtime to initialize during Kusto preparation without rejecting its readiness episode', async () => {
		vi.useFakeTimers();
		const harness = await createKustoExecutionHarness(true, '');
		const execution = harness.orchestrator.configureQuerySection(harness.input).catch(error => error);
		try {
			harness.accounts.resolve([]);
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.gateway.runtimeIdentity).toBe('runtime-1');
			expect(harness.stages()).toHaveLength(1);
			await harness.ack(harness.stages()[0].publicationId, 'staged');
			await harness.ack(harness.stages()[0].publicationId, 'applied');
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.executions()).toHaveLength(1);
			await harness.receive({ type: 'toolResponse', requestId: harness.executions()[0].requestId, result: { success: true } });
			await expect(execution).resolves.toEqual({ success: true });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			harness.accounts.resolve([]);
			harness.dispose();
			await execution;
		}
	});

	it('runs an execute-only follow-up from the exact provider raw snapshot without retargeting', async () => {
		vi.useFakeTimers();
		const harness = await createKustoExecutionHarness(true);
		const pending: Promise<unknown>[] = [];
		try {
			harness.accounts.resolve([]);
			for (const input of [harness.input, { sectionId: harness.input.sectionId, execute: true }]) {
				const execution = harness.orchestrator.configureQuerySection(input).catch(error => error);
				pending.push(execution);
				await vi.advanceTimersByTimeAsync(0);
				const stage = harness.stages().at(-1)!;
				expect(stage.payload.connectionsRevision).toBe(pending.length);
				await harness.ack(stage.publicationId, 'staged');
				await harness.ack(stage.publicationId, 'applied');
				await vi.advanceTimersByTimeAsync(0);
				expect(harness.executions()).toHaveLength(pending.length);
				const request = harness.executions().at(-1)!;
				expect(request).toMatchObject({ input });
				expect(Reflect.get(request, 'input')).toEqual(input);
				await harness.receive({ type: 'toolResponse', requestId: request.requestId, result: { success: true } });
				await expect(execution).resolves.toEqual({ success: true });
			}
			expect(harness.snapshots()).toHaveLength(1);
			expect(harness.executions()).toHaveLength(2);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			harness.accounts.resolve([]);
			harness.dispose();
			await Promise.all(pending);
		}
	});

	it('prepares first Kusto execution through the real provider session and both staged/applied connection publications', async () => {
		vi.useFakeTimers();
		const harness = await createKustoExecutionHarness(true);
		const normalRefresh = Promise.resolve(harness.receive({ type: 'getConnections' })).catch(error => error);
		const execution = harness.orchestrator.configureQuerySection(harness.input).catch(error => error);
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(authPreferencesMocks.getAccounts).toHaveBeenCalledOnce();
			expect(harness.stages()).toEqual([]);
			expect(harness.executions()).toEqual([]);
			harness.accounts.resolve([]);
			await vi.advanceTimersByTimeAsync(0);
			for (let revision = 1; revision <= 2; revision++) {
				expect(harness.stages()).toHaveLength(revision);
				const stage = harness.stages()[revision - 1];
				expect(stage.payload.connectionsRevision).toBe(revision);
				expect(harness.isLockHeld()).toBe(true);
				expect(harness.executions()).toEqual([]);
				await harness.ack(stage.publicationId, 'staged');
				await vi.advanceTimersByTimeAsync(0);
				expect(harness.posted.filter(message => message.type === 'kustoPublicationCommit')).toHaveLength(revision);
				expect(harness.executions()).toEqual([]);
				await harness.ack(stage.publicationId, 'applied');
				await vi.advanceTimersByTimeAsync(0);
			}
			await expect(normalRefresh).resolves.toBeUndefined();
			expect(harness.isLockHeld()).toBe(false);
			expect(harness.executions()).toHaveLength(1);
			const request = harness.executions()[0];
			expect(request).toMatchObject({ input: harness.input });
			expect(request).not.toHaveProperty('input.query');
			await harness.receive({ type: 'toolResponse', requestId: request.requestId, result: { success: true } });
			await expect(execution).resolves.toEqual({ success: true });
			expect(harness.snapshots()).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			harness.accounts.resolve([]);
			harness.dispose();
			await Promise.all([normalRefresh, execution]);
		}
	});

	it.each(['rejected publication', 'disposed projection'])('does not execute after %s in provider preparation', async failure => {
		vi.useFakeTimers();
		const harness = await createKustoExecutionHarness(true);
		const execution = harness.orchestrator.configureQuerySection(harness.input).catch(error => error);
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(authPreferencesMocks.getAccounts).toHaveBeenCalledOnce();
			if (failure === 'disposed projection') {
				Reflect.set(harness.provider, '_panelDisposed', true);
				Reflect.get(harness.provider, 'kustoConnectionsProjectionApplication').dispose();
			}
			harness.accounts.resolve([]);
			await vi.advanceTimersByTimeAsync(0);
			if (failure === 'rejected publication') {
				expect(harness.stages()).toHaveLength(1);
				const publicationId = harness.stages()[0].publicationId;
				await harness.ack(publicationId, 'staged');
				await vi.advanceTimersByTimeAsync(0);
				await harness.ack(publicationId, 'applied', false);
			}
			expect(await execution).toBeInstanceOf(Error);
			expect(harness.executions()).toEqual([]);
			expect(harness.isLockHeld()).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			harness.accounts.resolve([]);
			harness.dispose();
			await execution;
		}
	});

	it('rejects a captured tool projection at physical delivery through the session and provider', async () => {
		const harness = await createReadyReadHarness();
		const heldDelivery = deferred<boolean>();
		try {
			const session = Reflect.get(harness.provider, 'workbenchToolSessionApplication') as { activate(): void };
			session.activate();
			const connection = toolOrchestratorMocks.connect.mock.calls[0] as unknown as Parameters<WorkbenchToolSessionOrchestrator['connect']>;
			expect(connection[10]).toBeTypeOf('function');
			const isCurrent = connection[10]!();
			const head = harness.gateway.postDocumentProjection({
				preflight: () => heldDelivery.promise,
				prepare: () => ({ message: { type: 'heldHead' } }),
			});
			const request = { type: 'toolRemoveSection', sectionId: 'query_initial', requestId: 'guarded-removal' };
			const delivery = connection[0](request, undefined, isCurrent);
			harness.provider.setWorkbenchToolSnapshotIdentity(() => 'projection-2');
			heldDelivery.resolve(true);
			await head;
			await expect(delivery).resolves.toBe(false);
			expect(harness.posted.some(message => message.requestId === request.requestId)).toBe(false);
			await expect(harness.gateway.postMessage({ type: 'unguardedFollower' })).resolves.toBe(true);
			expect(harness.posted.filter(message => message.type === 'unguardedFollower')).toHaveLength(1);
		} finally {
			heldDelivery.resolve(true);
			harness.dispose();
		}
	});

	it('reference-identically forwards all three routes and leaves legacy authorities untouched', async () => {
		const routeSettlements = [deferred<void>(), deferred<void>(), deferred<void>()];
		const messages = [
			{
				type: 'toolExecutionStarted',
				requestId: 'tool-start-exact',
				owner: {
					engine: 'kusto',
					boxId: 'tool-box-exact',
					sectionInstanceId: 'tool-section-instance-exact',
					targetGeneration: 7,
					executionId: 'tool-execution-exact',
					connectionId: 'tool-connection-exact',
					database: 'ToolDatabaseExact',
					producer: 'tool',
				},
			},
			{
				type: 'toolResponse',
				requestId: 'tool-response-exact',
				result: { exact: true },
			},
			{
				type: 'toolStateResponse',
				requestId: 'tool-state-exact',
				sections: [{ id: 'query-exact', type: 'query' }],
			},
		] satisfies IncomingWebviewMessage[];
		const workbenchToolSessionApplication: StructuralWorkbenchToolSessionHandler = {
			activate: vi.fn(),
			handleDevelopmentNoteMutationResponse: vi.fn(() => false),
			handleMessage: vi.fn((candidate: IncomingWebviewMessage) => {
				const index = messages.indexOf(candidate);
				return index >= 0 ? routeSettlements[index].promise : undefined;
			}),
			requestSectionsFromWebview: vi.fn(),
			dispose: vi.fn(),
		};
		const { provider, developmentNoteMutationApplication } = createProvider(workbenchToolSessionApplication);
		const legacyStateResolver = vi.fn();
		(provider as unknown as {
			toolStateResponseResolvers: Map<string, (sections: unknown[] | undefined) => void>;
		}).toolStateResponseResolvers = new Map([['tool-state-exact', legacyStateResolver]]);
		const settled = [false, false, false];

		const requests = messages.map((message, index) => {
			const request = provider.handleWebviewMessage(message);
			void request.finally(() => { settled[index] = true; });
			return request;
		});
		await Promise.resolve();

		expect(workbenchToolSessionApplication.handleMessage).toHaveBeenCalledTimes(3);
		messages.forEach((message, index) => {
			expect(workbenchToolSessionApplication.handleMessage.mock.calls[index][0]).toBe(message);
		});
		expect((provider as unknown as { workbenchToolSessionApplication: unknown })
			.workbenchToolSessionApplication).toBe(workbenchToolSessionApplication);
		expect(settled).toEqual([false, false, false]);
		expect(developmentNoteMutationApplication.handleMessage).toHaveBeenCalledOnce();
		expect(developmentNoteMutationApplication.handleMessage).toHaveBeenCalledWith(messages[1]);
		expect(workbenchToolSessionApplication.handleDevelopmentNoteMutationResponse).toHaveBeenCalledOnce();
		expect(workbenchToolSessionApplication.handleDevelopmentNoteMutationResponse).toHaveBeenCalledWith(messages[1]);
		expect(legacyStateResolver).not.toHaveBeenCalled();
		expect(toolOrchestratorMocks.handleKustoExecutionStarted).not.toHaveBeenCalled();
		expect(toolOrchestratorMocks.handleWebviewResponse).not.toHaveBeenCalled();

		routeSettlements.forEach(settlement => settlement.resolve());
		await expect(Promise.all(requests)).resolves.toEqual([undefined, undefined, undefined]);
		expect(settled).toEqual([true, true, true]);
	});

	it('keeps section-state requests as a thin deferred delegate', async () => {
		const settlement = deferred<unknown[] | undefined>();
		const sections = [{ id: 'section-state-exact', type: 'query' }];
		const workbenchToolSessionApplication: StructuralWorkbenchToolSessionHandler = {
			activate: vi.fn(),
			handleDevelopmentNoteMutationResponse: vi.fn(() => false),
			handleMessage: vi.fn(() => undefined),
			requestSectionsFromWebview: vi.fn(() => settlement.promise),
			dispose: vi.fn(),
		};
		const { provider } = createProvider(workbenchToolSessionApplication);
		let settled = false;

		const request = provider.requestSectionsFromWebview('schema-refresh', 'connection-state-exact');
		void request.finally(() => { settled = true; });
		await Promise.resolve();

		expect(workbenchToolSessionApplication.requestSectionsFromWebview)
			.toHaveBeenCalledWith('schema-refresh', 'connection-state-exact');
		expect(settled).toBe(false);
		expect(toolOrchestratorMocks.connect).not.toHaveBeenCalled();
		expect(toolOrchestratorMocks.activateConnection).not.toHaveBeenCalled();

		settlement.resolve(sections);
		await expect(request).resolves.toBe(sections);
		expect(settled).toBe(true);
	});

	it('forwards host-only cancellation to transport and refuses an already aborted request', async () => {
		const handler: StructuralWorkbenchToolSessionHandler = {
			activate: vi.fn(), handleDevelopmentNoteMutationResponse: vi.fn(() => false),
			handleMessage: vi.fn(() => undefined), requestSectionsFromWebview: vi.fn(), dispose: vi.fn(),
		};
		const { provider } = createProvider(handler);
		const transport = vi.fn(async () => true);
		(provider as unknown as { _panelDisposed: boolean })._panelDisposed = false;
		provider.setMessageTransport(transport);
		const controller = new AbortController();
		const message = { type: 'requestToolState', requestId: 'state-signaled' };

		await expect(Reflect.apply(provider.postMessage, provider, [message, controller.signal])).resolves.toBe(true);
		expect(transport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(message), controller.signal);
		expect(transport.mock.calls[0][0]).not.toHaveProperty('signal');
		controller.abort();
		await expect(Reflect.apply(provider.postMessage, provider, [message, controller.signal])).resolves.toBe(false);
		expect(transport).toHaveBeenCalledOnce();
	});

	it('coalesces exact-panel read readiness without recursively requesting a snapshot', async () => {
		const handler: StructuralWorkbenchToolSessionHandler = {
			activate: vi.fn(), handleDevelopmentNoteMutationResponse: vi.fn(() => false),
			handleMessage: vi.fn(() => undefined), requestSectionsFromWebview: vi.fn(), dispose: vi.fn(),
		};
		const { provider } = createProvider(handler);
		const internal = provider as unknown as {
			panel: object; _panelDisposed: boolean; waitForWorkbenchToolReadiness(): Promise<boolean>;
		};
		internal.panel = {};
		internal._panelDisposed = false;
		const readiness = deferred<boolean>();
		const revalidate = vi.fn(() => readiness.promise);
		const projection = vi.fn(async () => true);
		provider.setMessageTransport(undefined, revalidate);
		provider.setWorkbenchToolMutationReadiness(projection);

		const first = internal.waitForWorkbenchToolReadiness();
		const second = internal.waitForWorkbenchToolReadiness();
		expect(first).toBe(second);
		await Promise.resolve();
		expect(revalidate).toHaveBeenCalledOnce();
		expect(projection).not.toHaveBeenCalled();
		readiness.resolve(true);
		await expect(first).resolves.toBe(true);
		expect(projection).toHaveBeenCalledOnce();
		expect(handler.requestSectionsFromWebview).not.toHaveBeenCalled();
	});

	it('does not force a new episode for staggered reads on an already ready transport', async () => {
		const handler: StructuralWorkbenchToolSessionHandler = {
			activate: vi.fn(), handleDevelopmentNoteMutationResponse: vi.fn(() => false),
			handleMessage: vi.fn(() => undefined), requestSectionsFromWebview: vi.fn(), dispose: vi.fn(),
		};
		const { provider } = createProvider(handler);
		const internal = provider as unknown as {
			panel: object; _panelDisposed: boolean; waitForWorkbenchToolReadiness(): Promise<boolean>;
		};
		internal.panel = {};
		internal._panelDisposed = false;
		let epoch = 1;
		const revalidate = vi.fn(async () => { epoch++; return true; });
		const revalidateRead = vi.fn(async () => true);
		provider.setMessageTransport(undefined, revalidate, () => epoch, revalidateRead);
		provider.setWorkbenchToolMutationReadiness(async () => true);

		await expect(internal.waitForWorkbenchToolReadiness()).resolves.toBe(true);
		await expect(internal.waitForWorkbenchToolReadiness()).resolves.toBe(true);
		expect(epoch).toBe(1);
		expect(revalidate).not.toHaveBeenCalled();
		expect(revalidateRead).toHaveBeenCalledTimes(2);
		expect(handler.requestSectionsFromWebview).not.toHaveBeenCalled();
	});

	it('recovers a cached READY projection through an actual read probe before requesting its snapshot', async () => {
		vi.useFakeTimers();
		const harness = await createReadyReadHarness();
		const hydration = deferred<boolean>();
		harness.provider.setWorkbenchToolMutationReadiness(() => hydration.promise);
		vi.mocked(harness.panel.webview.postMessage).mockImplementation(async message => {
			harness.posted.push(message);
			if (message.type === 'mainWebviewDispatcherProbe') hydration.resolve(true);
			return true;
		});
		try {
			const epoch = harness.gateway.readinessIdentity;
			expect(harness.gateway.isDispatcherReady).toBe(true);
			const read = harness.provider.requestSectionsFromWebview();
			await vi.waitFor(() => expect(harness.probes()).toHaveLength(1));
			const probe = harness.probes()[0];
			expect(harness.gateway.isDispatcherReady).toBe(true);
			expect(harness.gateway.readinessIdentity).toBe(epoch);
			expect(harness.snapshots()).toEqual([]);
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: 'stale-read-probe' });
			expect(harness.snapshots()).toEqual([]);
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: probe.probeId });
			await vi.waitFor(() => expect(harness.snapshots()).toHaveLength(1));
			const sections = [{ id: 'query-recovered', type: 'query', query: 'print Canary=10' }];
			const response = createToolStateResponseMessage(harness.snapshots()[0].requestId!, sections);
			expect(response.ok).toBe(true);
			if (!response.ok) throw new Error('The recovered response must be canonical.');
			await harness.receive(response.value);
			await expect(read).resolves.toEqual(sections);
			expect(harness.reconcileComparisonOwners).toHaveBeenCalledExactlyOnceWith(sections);
			expect(harness.transport.mock.calls[0][1]?.aborted).toBe(true);
			expect(harness.panel.reveal).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			hydration.resolve(false);
			harness.dispose();
		}
	});

	it.each([false, true])('fences an older snapshot only when a staggered read observes runtime replacement (%s)', async replacement => {
		vi.useFakeTimers();
		const harness = await createReadyReadHarness();
		try {
			const epoch = harness.gateway.readinessIdentity;
			const first = harness.provider.requestSectionsFromWebview();
			await vi.waitFor(() => expect(harness.probes()).toHaveLength(1));
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: harness.probes()[0].probeId });
			await vi.waitFor(() => expect(harness.snapshots()).toHaveLength(1));
			const firstRequest = harness.snapshots()[0];
			const second = harness.provider.requestSectionsFromWebview();
			await vi.waitFor(() => expect(harness.probes()).toHaveLength(2));
			const secondProbe = harness.probes()[1];
			expect(harness.gateway.readinessIdentity).toBe(epoch);
			if (replacement) {
				await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-2' });
				expect(harness.gateway.readinessIdentity).toBe(epoch + 1);
				expect(harness.gateway.isDispatcherReady).toBe(false);
			}
			const firstSections = [{ id: 'sql-older', type: 'sql', query: 'SELECT 1' }];
			await harness.receive({ type: 'toolStateResponse', requestId: firstRequest.requestId, sections: firstSections });
			await expect(first).resolves.toEqual(replacement ? undefined : firstSections);
			expect(harness.reconcileComparisonOwners).toHaveBeenCalledTimes(replacement ? 0 : 1);
			expect(harness.transport.mock.calls[0][1]?.aborted).toBe(true);
			expect(harness.snapshots()).toHaveLength(1);
			await harness.receive({
				type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: replacement ? 'runtime-2' : 'runtime-1', probeId: secondProbe.probeId,
			});
			await vi.waitFor(() => expect(harness.snapshots()).toHaveLength(2));
			const secondSections = [{ id: 'sql-current', type: 'sql', query: 'SELECT 2' }];
			await harness.receive({ type: 'toolStateResponse', requestId: harness.snapshots()[1].requestId, sections: secondSections });
			await expect(second).resolves.toEqual(secondSections);
			expect(harness.reconcileComparisonOwners).toHaveBeenLastCalledWith(secondSections);
			expect(harness.reconcileComparisonOwners).toHaveBeenCalledTimes(replacement ? 1 : 2);
			expect(harness.transport.mock.calls[1][1]?.aborted).toBe(true);
			expect(harness.gateway.readinessIdentity).toBe(epoch + (replacement ? 1 : 0));
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			harness.dispose();
		}
	});

	it.each(['expiry', 'disposal'] as const)('does not post a snapshot or apply SQL state after read validation %s', async terminal => {
		vi.useFakeTimers();
		const harness = await createReadyReadHarness();
		try {
			const read = harness.provider.requestSectionsFromWebview();
			await vi.waitFor(() => expect(harness.probes()).toHaveLength(1));
			const probe = harness.probes()[0];
			if (terminal === 'expiry') await vi.advanceTimersByTimeAsync(4_000);
			else harness.gateway.dispose();
			await expect(read).resolves.toBeUndefined();
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: probe.probeId });
			expect(harness.gateway.isDispatcherReady).toBe(false);
			expect(harness.snapshots()).toEqual([]);
			expect(harness.reconcileComparisonOwners).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			harness.dispose();
		}
	});

	it('revalidates transport before waiting for a projection that requires that transport', async () => {
		const projection = deferred<boolean>();
		const handler: StructuralWorkbenchToolSessionHandler = {
			activate: vi.fn(), handleDevelopmentNoteMutationResponse: vi.fn(() => false),
			handleMessage: vi.fn(() => undefined), requestSectionsFromWebview: vi.fn(async () => []), dispose: vi.fn(),
		};
		const { provider } = createProvider(handler);
		const internal = provider as unknown as {
			panel: object; _panelDisposed: boolean; reactivateWorkbenchToolSession(): Promise<boolean>;
		};
		internal.panel = {};
		internal._panelDisposed = false;
		provider.setWorkbenchToolMutationReadiness(() => projection.promise);
		const revalidate = vi.fn(async () => {
			projection.resolve(true);
			return true;
		});
		provider.setMessageTransport(undefined, revalidate);
		const activation = internal.reactivateWorkbenchToolSession();
		await vi.waitFor(() => expect(revalidate).toHaveBeenCalledOnce());
		await expect(activation).resolves.toBe(true);
	});

	it.each([
		{ stage: 'ready', expected: true, readinessCalls: 2, snapshotCalls: 1 },
		{ stage: 'initial-projection', expected: false, readinessCalls: 1, snapshotCalls: 0 },
		{ stage: 'dispatcher', expected: false, readinessCalls: 0, snapshotCalls: 0 },
		{ stage: 'current-projection', expected: false, readinessCalls: 2, snapshotCalls: 1 },
		{ stage: 'unavailable-snapshot', expected: false, readinessCalls: 1, snapshotCalls: 1 },
		{ stage: 'retired', expected: false, readinessCalls: 0, snapshotCalls: 0 },
		{ stage: 'replaced', expected: false, readinessCalls: 0, snapshotCalls: 0 },
	])('checks exact-panel activation readiness at $stage', async ({ stage, expected, readinessCalls, snapshotCalls }) => {
		const handler: StructuralWorkbenchToolSessionHandler = {
			activate: vi.fn(),
			handleDevelopmentNoteMutationResponse: vi.fn(() => false),
			handleMessage: vi.fn(() => undefined),
			requestSectionsFromWebview: vi.fn(async () => stage === 'unavailable-snapshot' ? undefined : []),
			dispose: vi.fn(),
		};
		const { provider } = createProvider(handler);
		const internal = provider as unknown as {
			panel: object;
			_panelDisposed: boolean;
			reactivateWorkbenchToolSession(): Promise<boolean>;
		};
		internal.panel = {};
		internal._panelDisposed = false;
		const readiness = vi.fn()
			.mockResolvedValueOnce(stage !== 'initial-projection')
			.mockResolvedValueOnce(stage !== 'current-projection');
		provider.setWorkbenchToolMutationReadiness(readiness);
		const revalidate = vi.fn(async () => {
			if (stage === 'retired') internal._panelDisposed = true;
			if (stage === 'replaced') internal.panel = {};
			return stage !== 'dispatcher';
		});
		provider.setMessageTransport(undefined, revalidate);
		await expect(internal.reactivateWorkbenchToolSession()).resolves.toBe(expected);
		expect(readiness).toHaveBeenCalledTimes(readinessCalls);
		expect(revalidate).toHaveBeenCalledOnce();
		expect(handler.requestSectionsFromWebview).toHaveBeenCalledTimes(snapshotCalls);
		expect(handler.activate).not.toHaveBeenCalled();
	});

	it('does not accept a returning snapshot after current projection readiness was revoked', async () => {
		const snapshot = deferred<unknown[]>();
		let projectionReady = true;
		const handler: StructuralWorkbenchToolSessionHandler = {
			activate: vi.fn(), handleDevelopmentNoteMutationResponse: vi.fn(() => false),
			handleMessage: vi.fn(() => undefined), requestSectionsFromWebview: vi.fn(() => snapshot.promise), dispose: vi.fn(),
		};
		const { provider } = createProvider(handler);
		const internal = provider as unknown as {
			panel: object; _panelDisposed: boolean; reactivateWorkbenchToolSession(): Promise<boolean>;
		};
		internal.panel = {};
		internal._panelDisposed = false;
		provider.setMessageTransport(undefined, async () => true);
		provider.setWorkbenchToolMutationReadiness(async () => projectionReady);
		const activation = internal.reactivateWorkbenchToolSession();
		await vi.waitFor(() => expect(handler.requestSectionsFromWebview).toHaveBeenCalledOnce());
		projectionReady = false;
		snapshot.resolve([]);
		await expect(activation).resolves.toBe(false);
	});

	it('does not accept a successful state snapshot after its panel retires', async () => {
		const snapshot = deferred<unknown[]>();
		const handler: StructuralWorkbenchToolSessionHandler = {
			activate: vi.fn(),
			handleDevelopmentNoteMutationResponse: vi.fn(() => false),
			handleMessage: vi.fn(() => undefined),
			requestSectionsFromWebview: vi.fn(() => snapshot.promise),
			dispose: vi.fn(),
		};
		const { provider } = createProvider(handler);
		const internal = provider as unknown as {
			panel: object;
			_panelDisposed: boolean;
			reactivateWorkbenchToolSession(): Promise<boolean>;
		};
		internal.panel = {};
		internal._panelDisposed = false;
		provider.setMessageTransport(undefined, async () => true);
		const activation = internal.reactivateWorkbenchToolSession();
		await vi.waitFor(() => expect(handler.requestSectionsFromWebview).toHaveBeenCalledOnce());
		internal._panelDisposed = true;
		snapshot.resolve([]);
		await expect(activation).resolves.toBe(false);
	});

	it('gives matching development-note responses first claim before tool-session fallthrough', async () => {
		const workbenchToolSessionApplication: StructuralWorkbenchToolSessionHandler = {
			activate: vi.fn(),
			handleDevelopmentNoteMutationResponse: vi.fn(() => false),
			handleMessage: vi.fn(() => Promise.resolve()),
			requestSectionsFromWebview: vi.fn(),
			dispose: vi.fn(),
		};
		const { provider, developmentNoteMutationApplication } = createProvider(workbenchToolSessionApplication);
		developmentNoteMutationApplication.handleMessage.mockReturnValue(true);
		const message = {
			type: 'toolResponse',
			requestId: 'copilot-devnote-claimed-exact',
			result: { success: true },
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(message);

		expect(developmentNoteMutationApplication.handleMessage).toHaveBeenCalledOnce();
		expect(developmentNoteMutationApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect(workbenchToolSessionApplication.handleMessage).not.toHaveBeenCalled();
		expect(toolOrchestratorMocks.handleWebviewResponse).not.toHaveBeenCalled();
	});

	it('gives matching agent development-note responses first claim before generic tool routing', async () => {
		const workbenchToolSessionApplication: StructuralWorkbenchToolSessionHandler = {
			activate: vi.fn(),
			handleDevelopmentNoteMutationResponse: vi.fn(() => true),
			handleMessage: vi.fn(() => Promise.resolve()),
			requestSectionsFromWebview: vi.fn(),
			dispose: vi.fn(),
		};
		const { provider, developmentNoteMutationApplication } = createProvider(workbenchToolSessionApplication);
		const message = {
			type: 'toolResponse', requestId: 'tool-development-note-claimed-exact', result: { success: 'yes' },
		} as unknown as IncomingWebviewMessage;

		await provider.handleWebviewMessage(message);

		expect(developmentNoteMutationApplication.handleMessage).toHaveBeenCalledWith(message);
		expect(workbenchToolSessionApplication.handleDevelopmentNoteMutationResponse).toHaveBeenCalledWith(message);
		expect(workbenchToolSessionApplication.handleMessage).not.toHaveBeenCalled();
		expect(toolOrchestratorMocks.handleWebviewResponse).not.toHaveBeenCalled();
	});

	it('quarantines unsafe matching agent correlation before property access and admits the canonical response', async () => {
		let getterCalls = 0;
		const handleAdmission = vi.fn((admission: {
			requestId?: string;
			parsed: { ok: boolean };
		}) => admission.requestId === 'tool-development-note-current');
		const workbenchToolSessionApplication: StructuralWorkbenchToolSessionHandler = {
			activate: vi.fn(),
			handleDevelopmentNoteMutationResponse: vi.fn(() => false),
			handleDevelopmentNoteMutationResponseAdmission: handleAdmission,
			hasPendingDevelopmentNoteMutationResponse: vi.fn(() => true),
			handleMessage: vi.fn(() => Promise.resolve()),
			requestSectionsFromWebview: vi.fn(),
			dispose: vi.fn(),
		};
		const { provider, developmentNoteMutationApplication } = createProvider(workbenchToolSessionApplication);
		(developmentNoteMutationApplication as unknown as {
			handleResponseAdmission: ReturnType<typeof vi.fn>;
			hasPendingResponse: ReturnType<typeof vi.fn>;
		}).handleResponseAdmission = vi.fn(() => false);
		(developmentNoteMutationApplication as unknown as {
			hasPendingResponse: ReturnType<typeof vi.fn>;
		}).hasPendingResponse = vi.fn(() => false);
		const inherited = Object.assign(Object.create({ requestId: 'tool-development-note-current' }), {
			type: 'toolResponse', result: { success: 'yes' },
		}) as IncomingWebviewMessage;
		const accessor: Record<string, unknown> = {
			type: 'toolResponse', result: { success: 'yes' },
		};
		Object.defineProperty(accessor, 'requestId', {
			enumerable: true,
			get() {
				getterCalls++;
				return 'tool-development-note-current';
			},
		});
		const canonical = {
			type: 'toolResponse', requestId: 'tool-development-note-current', result: { success: true },
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(inherited);
		await provider.handleWebviewMessage(accessor as unknown as IncomingWebviewMessage);
		await provider.handleWebviewMessage(canonical);

		expect(getterCalls).toBe(0);
		expect(handleAdmission).toHaveBeenCalledTimes(3);
		expect(handleAdmission.mock.calls[0][0]).toMatchObject({
			requestId: 'tool-development-note-current', parsed: { ok: false },
		});
		expect(handleAdmission.mock.calls[1][0]).toMatchObject({
			requestId: undefined, parsed: { ok: false },
		});
		expect(handleAdmission.mock.calls[2][0]).toMatchObject({
			requestId: 'tool-development-note-current', parsed: { ok: true },
		});
		expect(workbenchToolSessionApplication.handleMessage).not.toHaveBeenCalled();
		expect(toolOrchestratorMocks.handleWebviewResponse).not.toHaveBeenCalled();
	});

	it('deletes displaced provider authority while preserving orchestrator, schema, and SQL owners', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/workbenchToolSessionApplicationHandler.ts');
		const sanitationSource = readSource('src/host/persistedResultSanitizationApplicationHandler.ts');
		const orchestratorSource = readSource('src/host/kustoWorkbenchTools.ts');
		const schemaSource = readSource('src/host/queryEditorSchema.ts');
		const sqlLifecycleSource = readSource('src/host/sql/sqlEditorLifecycleCoordinator.ts');

		expect(providerSource).not.toContain('private toolOrchestratorToken');
		expect(providerSource).not.toContain('toolStateResponseResolvers');
		expect(providerSource).not.toContain('connectToolOrchestrator');
		expect(providerSource).not.toContain('disconnectToolOrchestrator');
		expect(providerSource).not.toContain('rebuildSqlComparisonOwners');
		expect(providerSource).not.toContain("case 'toolExecutionStarted':");
		expect(providerSource).not.toContain("case 'toolResponse':");
		expect(providerSource).not.toContain("case 'toolStateResponse':");
		expect(providerSource).toContain(
			'readonly workbenchToolSessionApplication: WorkbenchToolSessionApplicationHandler;',
		);
		expect(providerSource).toMatch(
			/copilotChatFirstTimeApplication\?: CopilotChatFirstTimeApplicationHandler,\s+workbenchToolSessionApplication\?: WorkbenchToolSessionApplicationHandler,/,
		);
		expect(providerSource).toContain(
			'return this.workbenchToolSessionApplication.requestSectionsFromWebview(purpose, targetConnectionId);',
		);
		expect(providerSource).toContain(
			'const admission = admitDevelopmentNoteMutationWebviewMessage(input);',
		);
		expect(providerSource).toContain(
			'this.developmentNoteMutationApplication.handleResponseAdmission(admission)',
		);
		expect(providerSource).toContain(
			'this.workbenchToolSessionApplication.handleDevelopmentNoteMutationResponseAdmission(admission)',
		);
		expect(providerSource).toContain(
			'= this.workbenchToolSessionApplication?.handleMessage(message);',
		);
		expect(providerSource).toContain('this.workbenchToolSessionApplication.activate();');
		expect(providerSource).toContain('this.workbenchToolSessionApplication.dispose();');
		expect(providerSource).not.toContain('this.sqlLifecycle.reconcileComparisonOwners(sections);');
		expect(sanitationSource).toContain(
			'this.options.sqlLifecycle.reconcileComparisonOwners(Array.isArray(state?.sections) ? state.sections : []);',
		);

		expect(handlerSource).toContain('private connectionToken: number | undefined;');
		expect(handlerSource).toContain('private readonly stateResponseResolvers');
		expect(handlerSource).toContain(
			'setTimeout(() => this.settleStateRequest(requestId, undefined), 5000);',
		);
		expect(handlerSource).toContain('createRequestToolStateMessage(requestId, purpose, targetConnectionId)');
		expect(handlerSource).toContain('resolveStrictKustoConnection');
		expect(handlerSource).toContain('canonicalSectionKind(candidate.type)');
		expect(handlerSource).toContain('this.options.schema.refreshSchemaForTools');
		expect(handlerSource).toContain('this.options.sqlLifecycle.getReadyToolOwner');
		expect(handlerSource).toContain('this.connectedOrchestrator.disconnectIfOwner(this.connectionToken);');

		expect(orchestratorSource).toContain('private pendingResponses = new Map');
		expect(orchestratorSource).toContain('handleKustoExecutionStarted(');
		expect(orchestratorSource).toContain('handleWebviewResponse(');
		expect(schemaSource).toContain('async refreshSchemaForTools(');
		expect(sqlLifecycleSource).toContain('getReadyToolOwner(boxId: string)');
		expect(sqlLifecycleSource).toContain('reconcileComparisonOwners(sections: unknown[])');
	});
});
