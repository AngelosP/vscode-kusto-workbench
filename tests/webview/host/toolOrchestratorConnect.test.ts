import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KustoWorkbenchToolOrchestrator, RemoveSectionTool } from '../../../src/host/kustoWorkbenchTools';
import * as kqlxEditor from '../../../src/host/kqlxEditorProvider';
import { HostWorkbenchToolSessionApplicationHandler, type KustoExecutionPreparation } from '../../../src/host/workbenchToolSessionApplicationHandler';
import { HostKustoConnectionsProjectionApplicationHandler } from '../../../src/host/kustoConnectionsProjectionApplicationHandler';
import { HostSqlSectionExecutionApplicationHandler } from '../../../src/host/sqlSectionExecutionApplicationHandler';
import type { ExecuteSqlQueryMessage } from '../../../src/host/queryEditorTypes';
import { QueryRunCoordinator } from '../../../src/host/queryRunCoordinator';
import { SqlEditorLifecycleCoordinator, type SqlEditorLanguageService } from '../../../src/host/sql/sqlEditorLifecycleCoordinator';
import type { SqlWorkbenchService } from '../../../src/host/sql/sqlWorkbenchService';
import type { SqlConnection } from '../../../src/host/sqlConnectionManager';
import { registerWorkbenchLogger, type WorkbenchLogger } from '../../../src/host/workbenchLogger';
import * as editingPreferences from '../../../src/host/editingPreferences';
import { MainWebviewStartupGateway, MAIN_WEBVIEW_DISPATCHER_READY_TYPE } from '../../../src/host/mainWebviewStartupGateway';
import { classifyWorkbenchUri } from '../../../src/host/workbenchFileTypes';
import { kustoClusterKey } from '../../../src/shared/kustoClusterUrls';
import { SCHEMA_CACHE_VERSION } from '../../../src/host/schemaCache';
import * as fileOpenTracing from '../../../src/host/fileOpenTrace';
import { createHash } from 'node:crypto';

/**
 * Regression tests for the orchestrator connect/disconnect token mechanism.
 *
 * Bug: When multiple .kqlx files were open, closing an older tab would call
 * disconnectIfOwner() and unconditionally clear the orchestrator's callbacks,
 * even though a different editor was the current connection. This left the
 * still-open file's tools broken ("Kusto Workbench is not currently open.").
 */

const fakeContext = {
	globalState: { get: () => undefined, update: () => Promise.resolve() },
	globalStorageUri: { fsPath: '/tmp/test', scheme: 'file', path: '/tmp/test' },
	subscriptions: [],
} as any;

const fakeConnectionManager = {
	getConnections: () => [],
} as any;

const defaultSqlConnection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'aad' };
const fakeGetSqlConnMgr = () => ({
	getConnections: () => [],
	getConnection: (id: string) => id === defaultSqlConnection.id ? defaultSqlConnection : undefined,
	assertConnectionCurrent: vi.fn(async () => undefined),
}) as any;
const fakeKustoClient = {} as any;

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

function createMessagePoster(result = true) {
	return vi.fn<(message: unknown) => boolean>(() => result);
}

function cancellationToken() {
	let cancelled = false;
	const listeners = new Set<() => void>();
	return {
		token: {
			get isCancellationRequested() { return cancelled; },
			onCancellationRequested(listener: () => void) {
				listeners.add(listener);
				return { dispose: () => listeners.delete(listener) };
			},
		} as vscode.CancellationToken,
		cancel() {
			cancelled = true;
			for (const listener of [...listeners]) listener();
		},
	};
}

function resetOpenEditorState(): void {
	(vscode.window as any).activeTextEditor = undefined;
	(vscode.window as any).visibleTextEditors = [];
	(vscode.window.tabGroups as any).activeTabGroup = { activeTab: undefined, tabs: [], isActive: true };
	(vscode.window.tabGroups as any).all = [];
	(vscode.workspace as any).textDocuments = [];
	delete (vscode.workspace as any).applyEdit;
	delete (vscode as any).WorkspaceEdit;
	((vscode as any).__mockCommandCalls ?? []).length = 0;
}

function setActiveCustomTab(uri: vscode.Uri, viewType: string): void {
	const activeTab = { isActive: true, input: new vscode.TabInputCustom(uri, viewType), label: uri.fsPath.split(/[\\/]/).pop() || uri.toString() };
	(vscode.window.tabGroups as any).activeTabGroup = { activeTab, tabs: [activeTab], isActive: true };
	(vscode.window.tabGroups as any).all = [(vscode.window.tabGroups as any).activeTabGroup];
}

function setActiveTextDocument(uri: vscode.Uri): void {
	const document = { uri };
	(vscode.window as any).activeTextEditor = { document };
	(vscode.window as any).visibleTextEditors = [{ document }];
	(vscode.workspace as any).textDocuments = [document];
}

function setTabGroups(activeGroup: any, ...inactiveGroups: any[]): void {
	(vscode.window.tabGroups as any).activeTabGroup = activeGroup;
	(vscode.window.tabGroups as any).all = [activeGroup, ...inactiveGroups];
}

async function createBackgroundSqlSeedHarness(label: string) {
	const connection: SqlConnection = { ...defaultSqlConnection, dialect: 'mssql', authType: 'sql-login', username: 'user' };
	let currentConnection: SqlConnection | undefined = { ...connection };
	let protectedConnection = false;
	let revocationGeneration = 0;
	const sqlManager = {
		getConnections: () => currentConnection ? [{ ...currentConnection }] : [],
		getConnection: (id: string) => id === currentConnection?.id ? { ...currentConnection } as SqlConnection : undefined,
		assertConnectionCurrent: vi.fn(async () => undefined),
	};
	const refreshPolicy = vi.fn(async (): Promise<string[]> => protectedConnection ? [connection.id] : []);
	const assertAllowed = vi.fn(async () => {
		if (protectedConnection) throw new Error('Leave No Trace blocked');
	});
	const getRevocationGeneration = vi.fn((id: string) => id === connection.id ? revocationGeneration : 0);
	const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
		fakeContext, fakeConnectionManager, () => sqlManager as any, fakeKustoClient, refreshPolicy, assertAllowed,
		getRevocationGeneration,
	);
	const uri = vscode.Uri.file(`/work/sql-structural-${label}.sqlx`);
	await expect(orchestrator.createFile({ fileType: 'sqlx', filePath: uri.fsPath, initialContent: 'SELECT 1 AS Probe', reveal: false }))
		.resolves.toMatchObject({ success: true });
	setActiveCustomTab(uri, 'kusto.kqlxEditor');
	let text: string = (vscode as any).__mockFileSystem.readText(uri);
	const source = text;
	const document = { uri, version: 1, isDirty: false, isClosed: false, getText: () => text,
		positionAt: (offset: number) => new vscode.Position(0, offset) };
	(vscode.workspace as any).textDocuments = [document];
	class TestWorkspaceEdit {
		replacement = '';
		replace(_uri: vscode.Uri, _range: vscode.Range, value: string) { this.replacement = value; }
	}
	(vscode as any).WorkspaceEdit = TestWorkspaceEdit;
	const applyEdit = vi.fn(async (edit: TestWorkspaceEdit) => {
		text = edit.replacement;
		document.version++;
		document.isDirty = true;
		return true;
	});
	(vscode.workspace as any).applyEdit = applyEdit;
	const runtimeId = 'sql_runtime';
	const stateGetter = vi.fn(async () => JSON.parse(text).state.sections.map((section: Record<string, unknown>) => ({ ...section, id: section.id ?? runtimeId })));
	const resolver = vi.fn<() => string | undefined>(() => undefined);
	const current = vi.fn(() => true);
	const captureAdmission = vi.fn(() => current);
	const poster = createMessagePoster();
	const token = orchestrator.connect(poster, stateGetter, vi.fn(), uri.toString(), resolver,
		undefined, undefined, undefined, undefined, undefined, captureAdmission);
	await expect(orchestrator.saveWorkbenchFile({ targetFileUri: uri.toString() })).resolves.toMatchObject({ success: true });
	const inventory = await orchestrator.listSections();
	const listed = inventory.openFiles?.find(file => file.uri === uri.toString());
	expect(inventory.sections).toEqual([]);
	expect(listed).toMatchObject({ isLiveWorkbench: true, sections: [{ id: runtimeId, type: 'sql' }] });
	expect(listed?.sections).toEqual([{ id: runtimeId, type: 'sql' }]);
	expect(JSON.parse(source).state.sections[0].id).toBeUndefined();
	stateGetter.mockClear();
	refreshPolicy.mockClear();
	assertAllowed.mockClear();
	getRevocationGeneration.mockClear();
	sqlManager.assertConnectionCurrent.mockClear();
	return { orchestrator, connection, sqlManager, refreshPolicy, assertAllowed, uri, source, document, applyEdit,
		stateGetter, resolver, current, captureAdmission, poster, token, getRevocationGeneration,
		input: { openFileId: listed!.openFileId, sectionId: listed!.sections![0].id, execute: false },
		setText: (value: string) => { text = value; document.version++; },
		setConnection: (value: SqlConnection | undefined) => { currentConnection = value ? { ...value } : undefined; },
		setProtected: (value: boolean) => {
			if (value && !protectedConnection) revocationGeneration++;
			protectedConnection = value;
		},
	};
}

function createKustoPreparationHarness() {
	const uri = vscode.Uri.file('/work/kusto-preparation.kqlx');
	const document = { uri, version: 1, isClosed: false, getText: () => 'print Value = 1' };
	(vscode.workspace as any).textDocuments = [document];
	setActiveCustomTab(uri, 'kusto.kqlxEditor');
	const savedConnection = { id: 'kusto-ready', name: 'Ready', clusterUrl: 'https://cluster.kusto.windows.net' };
	const otherConnection = { id: 'kusto-other', name: 'Other', clusterUrl: 'https://other.kusto.windows.net' };
	let connections = [savedConnection, otherConnection];
	let incarnation = 1;
	let otherIncarnation = 1;
	let runtime = {};
	let projection = {};
	const manager = { getConnections: () => connections,
		getConnectionIncarnation: (connectionId: string) => connectionId === savedConnection.id ? incarnation : otherIncarnation };
	const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
		fakeContext, manager as any, fakeGetSqlConnMgr, fakeKustoClient,
	);
	const preparation = deferred<boolean>();
	const prepare = vi.fn<KustoExecutionPreparation>(async onReady => {
		const capturedRuntime = runtime;
		if (!await onReady(() => runtime === capturedRuntime)) return false;
		return preparation.promise;
	});
	const mutationReady = vi.fn(async () => true);
	const executionPosted = vi.fn();
	const physicalPost = (message: unknown) => {
		const request = message as { type: string; requestId: string };
		if (request.type.startsWith('tool')) {
			executionPosted(message);
			orchestrator.handleWebviewResponse(request.requestId, { success: true });
		}
		return Promise.resolve(true);
	};
	let transport: (message: unknown, signal?: AbortSignal, isCurrent?: () => boolean) => unknown =
		(message, _signal, isCurrent) => isCurrent?.() === false ? false : physicalPost(message);
	const poster = vi.fn((message: unknown, signal?: AbortSignal, isCurrent?: () => boolean) => transport(message, signal, isCurrent));
	const stateGetter = vi.fn<Parameters<KustoWorkbenchToolOrchestrator['connect']>[1]>(async () => [{
		id: 'query_ready', type: 'query', connectionId: savedConnection.id, clusterUrl: savedConnection.clusterUrl,
		database: 'Database', sectionInstanceId: 'instance-ready', targetGeneration: 7,
	}]);
	const token = orchestrator.connect(poster, stateGetter, vi.fn(),
		uri.toString(), undefined, undefined, undefined, mutationReady, undefined, async () => true, () => {
			const capturedRuntime = runtime;
			const capturedProjection = projection;
			return () => runtime === capturedRuntime && projection === capturedProjection;
		}, prepare);
	const input = { targetFileUri: uri.toString(), sectionId: 'query_ready', clusterUrl: savedConnection.clusterUrl,
		connectionId: savedConnection.id, database: 'Database', execute: true };
	return {
		orchestrator, preparation, prepare, mutationReady, poster, executionPosted, physicalPost, input, document,
		stateGetter, savedConnection, otherConnection,
		setTransport: (next: typeof transport) => { transport = next; },
		change: (kind: string) => {
			if (kind === 'source') document.version++;
			if (kind === 'runtime') runtime = {};
			if (kind === 'projection') projection = {};
			if (kind === 'connection rename') connections = [{ ...savedConnection, name: 'Renamed' }];
			if (kind === 'connection incarnation') incarnation++;
			if (kind === 'other connection incarnation') otherIncarnation++;
			if (kind === 'removed connection') connections = [];
			if (kind === 'disposal') orchestrator.disconnectIfOwner(token);
			if (kind === 'URI') {
				const entries = Reflect.get(orchestrator, 'liveConnections') as Map<number, { documentUri: string }>;
				entries.get(token)!.documentUri = vscode.Uri.file('/work/renamed.kqlx').toString();
			}
		},
		dispose: () => orchestrator.disconnectIfOwner(token),
	};
}

function createPendingSqlLifecycleHarness(seed?: Awaited<ReturnType<typeof createBackgroundSqlSeedHarness>>) {
	const sectionId = seed?.input.sectionId ?? 'sql_pending';
	const connection = { ...defaultSqlConnection, authType: 'sql-login', username: 'user' };
	const subscription = () => ({ dispose: () => undefined });
	const sqlManager = {
		getConnections: () => [connection],
		getConnection: (connectionId: string) => connectionId === connection.id ? connection : undefined,
		assertConnectionCurrent: vi.fn(async () => undefined),
		onDidChangeConnections: subscription,
	};
	const sqlWorkbench = {
		connectionManager: sqlManager,
		ready: async () => undefined,
		serverAccountMap: { refresh: async () => undefined, getAccountsByServer: () => ({}) },
		leaveNoTracePolicy: { getRevocationGeneration: () => 0 },
		isLeaveNoTraceConnection: () => false,
		assertSqlConnectionAllowed: async () => undefined,
		dispatchSqlOwnerAllowed: async <T>(
			_connection: unknown, _principal: string, _revocation: number, dispatch: () => T | PromiseLike<T>,
		) => await dispatch(),
		runtime: { getProcessManager: async () => ({}), onDidChangeProcessManager: subscription },
		onDidChangeLeaveNoTrace: subscription,
		onDidChangeSqlPrincipals: subscription,
	} as unknown as SqlWorkbenchService;
	const service: SqlEditorLanguageService = {
		onDiagnostics: vi.fn(), getCompletions: vi.fn(), getHover: vi.fn(), getSignatureHelp: vi.fn(),
		openDocument: vi.fn(async () => 'file:///sql-test/pending.sql'),
		changeDocument: vi.fn(async () => undefined),
		closeDocumentForOwner: vi.fn(() => true), closeDocumentUriForOwner: vi.fn(() => true),
		connectDocument: vi.fn(async () => undefined), dispose: vi.fn(),
	};
	const publication = vi.fn(() => true);
	const lifecycle = new SqlEditorLifecycleCoordinator({
		context: fakeContext, sqlWorkbench, queryRuns: new QueryRunCoordinator(),
		output: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as WorkbenchLogger,
		hasWebview: () => true, createLanguageService: () => service,
		effects: {
			postMessage: publication, cancelCopilotWriteQuery: vi.fn(), cancelCopilotQueryTarget: vi.fn(),
			invalidateSqlCopilot: vi.fn(), rejectPendingComparisonEnsures: vi.fn(), invalidatePersistence: vi.fn(),
			refreshConnectionsData: async () => true, prefetchSchema: async () => undefined,
		},
	});
	lifecycle.startSession();
	lifecycle.openSection(sectionId, 'instance-original');
	expect(lifecycle.adoptTarget(sectionId, 'instance-original', connection.id, 'Db', 1)).toBe(true);
	const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
		fakeContext, fakeConnectionManager, () => sqlManager as any, fakeKustoClient,
		vi.fn(async () => []), vi.fn(async () => undefined),
	);
	const uri = seed?.uri ?? vscode.Uri.file('/work/sql-pending-lifecycle.sqlx');
	const source = seed?.document.getText() ?? JSON.stringify({ kind: 'sqlx', version: 1, state: { sections: [{
		id: sectionId, type: 'sql', query: 'SELECT 1 AS Probe', database: 'Db', connectionIdHint: connection.id,
	}] } });
	const document = seed?.document ?? { uri, version: 1, isClosed: false, getText: () => source };
	(vscode.workspace as any).textDocuments = [document];
	setActiveCustomTab(uri, 'kusto.sqlxEditor');
	const installation = deferred<void>();
	const prepareSqlExecution = vi.fn(() => installation.promise);
	const executionPosted = vi.fn();
	const snapshot = vi.fn(() => [{
		id: sectionId, type: 'sql', connectionId: lifecycle.getConnectionId(sectionId),
		database: lifecycle.getTarget(sectionId)?.database,
		ownerToken: lifecycle.getReadyToolOwner(sectionId)?.ownerToken ?? '',
	}]);
	const physicalPost = vi.fn(async (message: unknown) => {
		const request = message as { type: string; requestId: string; input?: { executionId: string } };
		if (request.type === 'requestToolState') {
			await session.handleMessage({ type: 'toolStateResponse', requestId: request.requestId, sections: snapshot() });
		} else if (request.type === 'toolConfigureSqlSection') {
			executionPosted(message);
			await session.handleMessage({ type: 'toolResponse', requestId: request.requestId, result: {
				success: true, resultPreview: 'Probe: 1', executionId: request.input?.executionId,
				executionOwner: lifecycle.getReadyToolOwner(sectionId),
			} });
		}
		return true;
	});
	let transport: (message: unknown, signal?: AbortSignal, isCurrent?: () => boolean) => boolean | PromiseLike<boolean> =
		(message, signal, isCurrent) => signal?.aborted || isCurrent?.() === false ? false : physicalPost(message);
	const postMessage = vi.fn((message: unknown, signal?: AbortSignal, isCurrent?: () => boolean) => transport(message, signal, isCurrent));
	const session = new HostWorkbenchToolSessionApplicationHandler({
		getOrchestrator: () => orchestrator, postMessage, isAvailable: () => true,
		getDocumentUri: () => uri.toString(), getMutationReadiness: () => async () => true,
		waitForReadReady: async () => true, captureStateAdmission: () => () => true,
		prepareSqlExecution, connectionManager: fakeConnectionManager,
		schema: { refreshSchemaForTools: vi.fn() }, sqlLifecycle: lifecycle,
	});
	session.activate();
	return {
		connection, sqlWorkbench, sqlManager, lifecycle, publication, orchestrator, uri, document, source, installation, prepareSqlExecution,
		executionPosted, snapshot, postMessage, physicalPost, session,
		input: { targetFileUri: uri.toString(), sectionId, execute: true },
		setTransport: (next: typeof transport) => { transport = next; },
		publishReadyOwner: async () => {
			const instance = lifecycle.getSectionInstanceId(sectionId)!;
			lifecycle.didOpen(sectionId, instance, 'SELECT 1 AS Probe');
			await lifecycle.connect(sectionId, instance, connection.id, 'Db', lifecycle.getGeneration(sectionId));
			return lifecycle.getReadyToolOwner(sectionId);
		},
		dispose: () => { session.dispose(); lifecycle.dispose(); },
	};
}

describe('KustoWorkbenchToolOrchestrator connect/disconnect', () => {
	beforeEach(() => {
		// Reset the singleton between tests
		(KustoWorkbenchToolOrchestrator as any).instance = undefined;
		resetOpenEditorState();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('connect returns a token and listSections uses the stateGetter', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const stateGetter = vi.fn(async () => [
			{ id: 'q1', type: 'query', name: 'My Query' },
		]);
		orch.connect(vi.fn(), stateGetter, vi.fn());

		const result = await orch.listSections();
		expect(stateGetter).toHaveBeenCalledTimes(1);
		expect(result.sections).toHaveLength(1);
		expect(result.sections[0].id).toBe('q1');
	});

	it('waits for account enumeration and both applied connection revisions before first Kusto execution without query text', async () => {
		vi.useFakeTimers();
		vi.spyOn(editingPreferences, 'getEditingPreferencesData').mockReturnValue({
			type: 'editingPreferencesData', revision: 1,
			caretDocsEnabled: true, caretDocsEnabledUserSet: false,
			autoTriggerAutocompleteEnabled: true, autoTriggerAutocompleteEnabledUserSet: false,
			copilotInlineCompletionsEnabled: true, copilotInlineCompletionsEnabledUserSet: false,
		});
		const savedConnection = { id: 'kusto-first', name: 'First', clusterUrl: 'https://cluster.kusto.windows.net' };
		const accounts = deferred<[]>();
		const staged = [deferred<void>(), deferred<void>()];
		const applied = [deferred<void>(), deferred<void>()];
		const getAccounts = vi.fn(() => accounts.promise);
		let lockHeld = false;
		let rendererConnections: typeof savedConnection[] = [];
		const manager = {
			getConnections: () => [savedConnection],
			getConnectionIncarnation: () => 1,
			normalizeClusterUrl: (value: string) => kustoClusterKey(value),
			runWithLeaveNoTraceSnapshotLock: async <T>(run: (snapshot: any) => Promise<T>) => {
				lockHeld = true;
				try {
					return await run({ clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {} });
				} finally {
					lockHeld = false;
				}
			},
		};
		const publication = vi.fn(async (message: { connectionsRevision: number; connections: typeof savedConnection[] }) => {
			const index = message.connectionsRevision - 1;
			await staged[index].promise;
			await applied[index].promise;
			rendererConnections = message.connections;
			return true;
		});
		const projection = new HostKustoConnectionsProjectionApplicationHandler({
			context: fakeContext,
			connectionManager: manager,
			authPreferences: { getAccounts, getPreferredAccountId: () => undefined, getAccountPartition: () => 'account' },
			kustoClient: { getAccountPartition: () => 'account' },
			getLastSelection: () => ({ lastConnectionId: savedConnection.id, lastDatabase: 'Database' }),
			getCachedDatabases: () => ({}),
			getFavorites: () => [],
			postMessage: vi.fn(async () => true),
			postKustoPublication: publication,
		});
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, manager as any, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const poster = vi.fn((message: unknown) => {
			const request = message as { type: string; requestId: string };
			if (request.type === 'toolConfigureQuerySection') {
				orchestrator.handleWebviewResponse(request.requestId, { success: true });
			}
			return true;
		});
		const prepare = vi.fn(async () => { await projection.refresh(); return true; });
		const token = Reflect.apply(orchestrator.connect, orchestrator, [
			poster, async () => [{ id: 'query_first', type: 'query' }], vi.fn(), undefined,
			undefined, undefined, undefined, async () => true, undefined, async () => true, undefined, prepare,
		]) as number;
		const initialRefresh = projection.refresh();
		const input = { sectionId: 'query_first', clusterUrl: savedConnection.clusterUrl, connectionId: savedConnection.id,
			database: 'Database', execute: true };
		const execution = orchestrator.configureQuerySection(input);
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(getAccounts).toHaveBeenCalledOnce();
			expect(rendererConnections).toEqual([]);
			expect(poster, 'execution must not post while the valid host connection is absent from the renderer').not.toHaveBeenCalled();
			accounts.resolve([]);
			await vi.advanceTimersByTimeAsync(0);
			for (let revision = 0; revision < 2; revision++) {
				expect(publication).toHaveBeenCalledTimes(revision + 1);
				expect(lockHeld).toBe(true);
				staged[revision].resolve();
				await vi.advanceTimersByTimeAsync(0);
				expect(poster).not.toHaveBeenCalled();
				applied[revision].resolve();
				await vi.advanceTimersByTimeAsync(0);
			}
			await expect(execution).resolves.toEqual({ success: true });
			expect(prepare).toHaveBeenCalledOnce();
			expect(poster).toHaveBeenCalledOnce();
			expect(poster.mock.calls[0][0]).toMatchObject({ type: 'toolConfigureQuerySection', input });
			expect((poster.mock.calls[0][0] as { input: object }).input).not.toHaveProperty('query');
			expect(rendererConnections).toEqual([expect.objectContaining(savedConnection)]);
			expect(lockHeld).toBe(false);
		} finally {
			accounts.resolve([]);
			staged.forEach(gate => gate.resolve());
			applied.forEach(gate => gate.resolve());
			await initialRefresh;
			await execution;
			orchestrator.disconnectIfOwner(token);
			projection.dispose();
		}
	});

	it.each(['cancelled', 'timed out', 'rejected', 'unavailable'])('retires %s Kusto execution preparation without a late post and permits retry', async failure => {
		vi.useFakeTimers();
		vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
			get: (key: string, fallback: unknown) => key === 'queryTimeout' ? 0 : fallback,
		} as never);
		const harness = createKustoPreparationHarness();
		const cancellation = cancellationToken();
		const publicationError = new Error('publication failed');
		if (failure === 'rejected') harness.prepare.mockImplementationOnce(async () => {
			await harness.preparation.promise;
			throw publicationError;
		});
		let settled = false;
		const execution = harness.orchestrator.configureQuerySection(harness.input, cancellation.token)
			.then(result => { settled = true; return result; }, error => { settled = true; return error; });
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.prepare).toHaveBeenCalledOnce();
		expect(harness.poster).not.toHaveBeenCalled();
		if (failure === 'timed out') {
			await vi.advanceTimersByTimeAsync(29_999);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
		} else if (failure === 'cancelled') cancellation.cancel();
		else harness.preparation.resolve(failure !== 'unavailable');
		const outcome = await execution;
		if (failure === 'cancelled') expect(outcome).toBeInstanceOf(vscode.CancellationError);
		else if (failure === 'rejected') expect(outcome).toBe(publicationError);
		else expect(outcome).toMatchObject({ message: failure === 'timed out'
			? 'Kusto execution preparation timed out.' : 'Kusto connections could not be prepared for execution.' });
		harness.preparation.resolve(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.poster).not.toHaveBeenCalled();
		expect(Reflect.get(harness.orchestrator, 'pendingResponses').size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		harness.prepare.mockImplementation(async onReady => onReady(() => true));
		await expect(harness.orchestrator.configureQuerySection(harness.input)).resolves.toEqual({ success: true });
		expect(harness.executionPosted).toHaveBeenCalledOnce();
		expect(harness.prepare).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
		harness.dispose();
	});

	it('keeps invalid targets, cancelled requests, snapshots, removal, and source-only changes independent of Kusto preparation', async () => {
		const harness = createKustoPreparationHarness();
		await expect(harness.orchestrator.configureQuerySection({ ...harness.input, connectionId: 'missing' }))
			.resolves.toMatchObject({ success: false, error: 'No saved connection matches this cluster and connectionId.' });
		const cancellation = cancellationToken();
		cancellation.cancel();
		await expect(harness.orchestrator.configureQuerySection(harness.input, cancellation.token))
			.rejects.toBeInstanceOf(vscode.CancellationError);
		expect(harness.poster).not.toHaveBeenCalled();
		await expect(harness.orchestrator.listSections()).resolves.toMatchObject({ sections: [{ id: 'query_ready', type: 'query' }] });
		await expect(harness.orchestrator.configureQuerySection({ ...harness.input, execute: false, query: 'print Edited = 2' }))
			.resolves.toEqual({ success: true });
		await expect(harness.orchestrator.removeSection({ targetFileUri: harness.input.targetFileUri, sectionId: 'query_ready' }))
			.resolves.toEqual({ success: true });
		expect(harness.prepare).not.toHaveBeenCalled();
		expect(harness.executionPosted).toHaveBeenCalledTimes(2);
		harness.dispose();
	});

	it.each([false, true])('does not prepare Kusto connections for a SQL tool request (execute=%s)', async execute => {
		const sqlConnection = { ...defaultSqlConnection, authType: 'sql-login', username: 'test-user' };
		const owner = { connectionId: sqlConnection.id, database: 'Db', ownerToken: 'sql-ready-owner', generation: 1 };
		const sqlManager = {
			getConnections: () => [sqlConnection],
			getConnection: () => sqlConnection,
			assertConnectionCurrent: vi.fn(async () => undefined),
		};
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, () => sqlManager as any, fakeKustoClient,
		);
		const prepare = vi.fn(() => new Promise<boolean>(() => undefined));
		const poster = vi.fn((message: unknown) => {
			const request = message as { type: string; requestId: string; input: { executionId?: string } };
			expect(request.type).toBe('toolConfigureSqlSection');
			orchestrator.handleWebviewResponse(request.requestId, { success: true, resultPreview: '1 row',
				...(execute ? { executionId: request.input.executionId, executionOwner: owner } : {}) });
			return true;
		});
		const token = orchestrator.connect(poster, async () => [{ id: 'sql_ready', type: 'sql', database: 'Db' }],
			vi.fn(), undefined, () => sqlConnection.id, () => owner, undefined, async () => true,
			undefined, undefined, undefined, prepare);
		await expect(orchestrator.configureSqlSection({ sectionId: 'sql_ready', connectionId: sqlConnection.id,
			database: 'Db', execute })).resolves.toEqual({ success: true, resultPreview: '1 row' });
		expect(poster).toHaveBeenCalledOnce();
		expect(prepare).not.toHaveBeenCalled();
		orchestrator.disconnectIfOwner(token);
	});

	it('keeps the background handoff committed when first Kusto preparation fails after create, Save, and LIST', async () => {
		(vscode as any).__mockFileSystem.clear();
		const savedConnection = { id: 'background-kusto', name: 'Background', clusterUrl: 'https://cluster.kusto.windows.net' };
		const manager = { getConnections: () => [savedConnection], getConnectionIncarnation: () => 1 };
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, manager as any, fakeGetSqlConnMgr, fakeKustoClient);
		const uri = vscode.Uri.file('/work/background-preparation.kqlx');
		const sectionId = 'query_background';
		const initialContent = 'print Probe = 1';
		const prepare = vi.fn(async () => false);
		const poster = vi.fn((message: unknown) => {
			const request = message as { type: string; requestId: string; input: { execute?: boolean } };
			expect(request.type).toBe('toolConfigureQuerySection');
			orchestrator.handleWebviewResponse(request.requestId, { success: true });
			return true;
		});
		let token = 0;
		vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async (command, ...args) => {
			expect(command).toBe('vscode.openWith');
			expect(args).toEqual([uri, 'kusto.kqlxEditor', { preview: false, preserveFocus: true }]);
			const text = (vscode as any).__mockFileSystem.readText(uri);
			(vscode.workspace as any).textDocuments = [{ uri, version: 1, isDirty: false, getText: () => text,
				positionAt: (offset: number) => new vscode.Position(0, offset) }];
			setActiveCustomTab(uri, 'kusto.kqlxEditor');
			token = orchestrator.connect(poster, async () => [{ id: sectionId, type: 'query', query: initialContent }],
				vi.fn(), uri.toString(), undefined, undefined, undefined, async () => true,
				undefined, async () => true, () => () => true, prepare);
		});
		await expect(orchestrator.listConnections()).resolves.toMatchObject({ connections: [savedConnection] });
		await expect(orchestrator.createFile({ fileType: 'kqlx', filePath: uri.fsPath, initialContent, reveal: false }))
			.resolves.toMatchObject({ success: true });
		await expect(orchestrator.saveWorkbenchFile({ targetFileUri: uri.toString() }))
			.resolves.toMatchObject({ success: true, wasDirty: false });
		const inventory = await orchestrator.listSections();
		const file = inventory.openFiles!.find(candidate => candidate.openFileId === classifyWorkbenchUri(uri)!.openFileId)!;
		expect(file.sections).toEqual([expect.objectContaining({ id: sectionId })]);
		const input = { openFileId: file.openFileId, sectionId, execute: true, clusterUrl: savedConnection.clusterUrl,
			connectionId: savedConnection.id, database: 'Database' };
		await expect(orchestrator.configureQuerySection(input)).rejects.toThrow('Kusto connections could not be prepared for execution.');
		expect(poster).not.toHaveBeenCalled();
		expect(Reflect.get(orchestrator, 'hostOwnedBackgroundFiles').size).toBe(0);
		expect(Reflect.get(orchestrator, 'backgroundFileOperations').size).toBe(0);
		await expect(orchestrator.configureQuerySection({ ...input, execute: false, name: 'Still editable' })).resolves.toEqual({ success: true });
		expect(prepare).toHaveBeenCalledOnce();
		prepare.mockResolvedValue(true);
		await expect(orchestrator.configureQuerySection(input)).resolves.toEqual({ success: true });
		expect(prepare).toHaveBeenCalledTimes(2);
		expect(poster).toHaveBeenCalledTimes(2);
		expect(poster.mock.calls[1][0]).toMatchObject({ input: { sectionId, execute: true,
			clusterUrl: savedConnection.clusterUrl, connectionId: savedConnection.id, database: 'Database' } });
		expect(poster.mock.calls[1][0]).not.toHaveProperty('input.openFileId');
		expect(poster.mock.calls[1][0]).not.toHaveProperty('input.query');
		orchestrator.disconnectIfOwner(token);
	});

	it.each(['source', 'runtime', 'projection', 'URI', 'connection rename', 'connection incarnation', 'removed connection', 'disposal'])(
		'rejects %s drift while Kusto execution preparation is pending', async change => {
			vi.useFakeTimers();
			const harness = createKustoPreparationHarness();
			const execution = harness.orchestrator.configureQuerySection(harness.input).catch(error => error);
			await vi.advanceTimersByTimeAsync(0);
			harness.change(change);
			harness.preparation.resolve(true);
			const result = await execution;
			if (change === 'removed connection') expect(result).toMatchObject({ success: false, error: 'No saved connection matches this cluster and connectionId.' });
			else expect(result).toMatchObject({ message: 'The targeted Workbench editor changed during Kusto execution preparation.' });
			expect(harness.poster).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			harness.dispose();
		},
	);

	it('rechecks native source after Kusto preparation and the final mutation-readiness await', async () => {
		vi.useFakeTimers();
		const harness = createKustoPreparationHarness();
		const finalReady = deferred<boolean>();
		harness.prepare.mockImplementation(async onReady => onReady(() => true));
		harness.mutationReady.mockReturnValue(finalReady.promise);
		const execution = harness.orchestrator.configureQuerySection(harness.input).catch(error => error);
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.mutationReady).toHaveBeenCalledOnce();
		harness.change('source');
		finalReady.resolve(true);
		expect(await execution).toMatchObject({ message: 'The targeted Workbench editor changed before the request was dispatched.' });
		expect(harness.poster).not.toHaveBeenCalled();
		harness.dispose();
	});

	it.each(['source', 'runtime', 'projection', 'URI', 'connection rename', 'connection incarnation'])(
		'rechecks %s at physical delivery after successful Kusto execution preparation', async change => {
			vi.useFakeTimers();
			const harness = createKustoPreparationHarness();
			let receive!: (message: unknown) => unknown;
			const gateway = new MainWebviewStartupGateway<unknown>({
				panel: {
					webview: { postMessage: harness.physicalPost, onDidReceiveMessage: (listener: typeof receive) => {
						receive = listener;
						return { dispose() {} };
					} },
					onDidDispose: () => ({ dispose() {} }),
				} as never,
				admitInbound: input => input,
			});
			harness.setTransport((message, signal, isCurrent) => gateway.postMessage(message, signal, isCurrent));
			await receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'ready-runtime' });
			const heldHead = deferred<boolean>();
			const head = gateway.postDocumentProjection({ preflight: () => heldHead.promise,
				prepare: () => ({ message: { type: 'heldHead' } }) });
			harness.prepare.mockImplementation(async onReady => onReady(() => true));
			const execution = harness.orchestrator.configureQuerySection(harness.input).catch(error => error);
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.poster).toHaveBeenCalledOnce();
			expect(harness.poster.mock.calls[0][2]).toBeTypeOf('function');
			expect(harness.executionPosted).not.toHaveBeenCalled();
			harness.change(change);
			heldHead.resolve(true);
			await head;
			expect(await execution).toMatchObject({ message: 'The targeted Kusto Workbench editor rejected the request.' });
			expect(harness.executionPosted).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			harness.dispose();
			gateway.dispose();
		},
	);

	it.each(['publication', 'physical delivery'])(
		'fences an execute-only saved connection incarnation during %s without retargeting', async boundary => {
			vi.useFakeTimers();
			const harness = createKustoPreparationHarness();
			harness.stateGetter.mockResolvedValue([
				{ id: 'query_sibling', type: 'query', connectionId: harness.otherConnection.id, clusterUrl: harness.otherConnection.clusterUrl },
				{ id: harness.input.sectionId, type: 'query', connectionId: harness.savedConnection.id, clusterUrl: harness.savedConnection.clusterUrl,
					database: 'Database', sectionInstanceId: 'instance-ready', targetGeneration: 7 },
			]);
			let receive!: (message: unknown) => unknown;
			const gateway = new MainWebviewStartupGateway<unknown>({
				panel: {
					webview: { postMessage: harness.physicalPost, onDidReceiveMessage: (listener: typeof receive) => {
						receive = listener;
						return { dispose() {} };
					} },
					onDidDispose: () => ({ dispose() {} }),
				} as never,
				admitInbound: input => input,
			});
			harness.setTransport((message, signal, isCurrent) => gateway.postMessage(message, signal, isCurrent));
			await receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'execute-only-runtime' });
			const heldHead = deferred<boolean>();
			const head = boundary === 'physical delivery' ? gateway.postDocumentProjection({
				preflight: () => heldHead.promise, prepare: () => ({ message: { type: 'heldHead' } }),
			}) : Promise.resolve(true);
			const execution = harness.orchestrator.configureQuerySection({
				targetFileUri: harness.input.targetFileUri, sectionId: harness.input.sectionId, execute: true,
			}).catch(error => error);
			try {
				await vi.advanceTimersByTimeAsync(0);
				if (boundary === 'physical delivery') {
					harness.preparation.resolve(true);
					await vi.advanceTimersByTimeAsync(0);
					expect(harness.poster).toHaveBeenCalledOnce();
				}
				harness.change('connection incarnation');
				harness.preparation.resolve(true);
				heldHead.resolve(true);
				await head;
				const result = await execution;
				expect(harness.executionPosted).not.toHaveBeenCalled();
				expect(result).toBeInstanceOf(Error);
				expect(Reflect.get(harness.orchestrator, 'pendingResponses').size).toBe(0);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				harness.preparation.resolve(true);
				heldHead.resolve(true);
				await head;
				await execution;
				harness.dispose();
				gateway.dispose();
			}
		},
	);

	it('keeps execute-only target currentness local when another editor and connection change', async () => {
		vi.useFakeTimers();
		const harness = createKustoPreparationHarness();
		const snapshot = deferred<Awaited<ReturnType<typeof harness.stateGetter>>>();
		harness.stateGetter.mockReturnValue(snapshot.promise);
		const input = { targetFileUri: harness.input.targetFileUri, sectionId: harness.input.sectionId, execute: true };
		const execution = harness.orchestrator.configureQuerySection(input).catch(error => error);
		let otherToken: number | undefined;
		try {
			await vi.advanceTimersByTimeAsync(0);
			const otherPoster = createMessagePoster();
			const otherState = vi.fn(async () => [{ id: input.sectionId, type: 'query',
				connectionId: harness.otherConnection.id, clusterUrl: harness.otherConnection.clusterUrl }]);
			const otherUri = vscode.Uri.file('/work/other-preparation.kqlx');
			otherToken = harness.orchestrator.connect(otherPoster, otherState, vi.fn(), otherUri.toString());
			setActiveCustomTab(otherUri, 'kusto.kqlxEditor');
			snapshot.resolve([
				{ id: 'query_sibling', type: 'query', connectionId: harness.otherConnection.id, clusterUrl: harness.otherConnection.clusterUrl },
				{ id: input.sectionId, type: 'query', connectionId: harness.savedConnection.id, clusterUrl: harness.savedConnection.clusterUrl,
					database: 'Database', sectionInstanceId: 'instance-ready', targetGeneration: 7 },
			]);
			await vi.advanceTimersByTimeAsync(0);
			harness.change('other connection incarnation');
			harness.preparation.resolve(true);
			await expect(execution).resolves.toEqual({ success: true });
			expect(harness.executionPosted).toHaveBeenCalledOnce();
			expect(harness.poster.mock.calls[0][0]).toMatchObject({ input: { sectionId: input.sectionId, execute: true } });
			expect(Reflect.get(harness.poster.mock.calls[0][0] as object, 'input')).toEqual({ sectionId: input.sectionId, execute: true });
			const expected = Reflect.get(harness.poster.mock.calls[0][0] as object, 'expectedKustoTarget');
			expect(expected).toEqual({
				sectionId: input.sectionId, sectionInstanceId: 'instance-ready', targetGeneration: 7,
				connectionId: harness.savedConnection.id, clusterUrl: harness.savedConnection.clusterUrl, database: 'Database',
			});
			expect(Object.isFrozen(expected)).toBe(true);
			expect(otherState).not.toHaveBeenCalled();
			expect(otherPoster).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			snapshot.resolve(undefined);
			harness.preparation.resolve(true);
			await execution;
			if (otherToken !== undefined) harness.orchestrator.disconnectIfOwner(otherToken);
			harness.dispose();
		}
	});

	it.each(['unavailable snapshot', 'missing section', 'mismatched target', 'rejected snapshot',
		'missing lifecycle', 'missing database', 'unsafe generation'])(
		'fails closed for an execute-only %s without using a sibling target', async failure => {
			vi.useFakeTimers();
			const harness = createKustoPreparationHarness();
			const section = { id: harness.input.sectionId, type: 'query',
				connectionId: harness.savedConnection.id, clusterUrl: harness.savedConnection.clusterUrl,
				database: 'Database', sectionInstanceId: 'instance-ready', targetGeneration: 7 };
			if (failure === 'unavailable snapshot') harness.stateGetter.mockResolvedValue(undefined);
			else if (failure === 'missing section') harness.stateGetter.mockResolvedValue([{ ...section, id: 'query_sibling' }]);
			else if (failure === 'mismatched target') harness.stateGetter.mockResolvedValue([{ ...section, clusterUrl: harness.otherConnection.clusterUrl }]);
			else if (failure === 'missing lifecycle') harness.stateGetter.mockResolvedValue([{ ...section, sectionInstanceId: undefined }]);
			else if (failure === 'missing database') harness.stateGetter.mockResolvedValue([{ ...section, database: undefined }]);
			else if (failure === 'unsafe generation') harness.stateGetter.mockResolvedValue([{ ...section, targetGeneration: Number.MAX_SAFE_INTEGER + 1 }]);
			else harness.stateGetter.mockRejectedValue(new Error('snapshot unavailable'));
			harness.preparation.resolve(true);
			try {
				await expect(harness.orchestrator.configureQuerySection({ targetFileUri: harness.input.targetFileUri,
					sectionId: harness.input.sectionId, execute: true })).rejects.toThrow(failure === 'mismatched target'
					? 'The supplied connectionId does not match the requested cluster URL.'
					: failure === 'rejected snapshot' ? 'snapshot unavailable'
						: ['missing lifecycle', 'missing database', 'unsafe generation'].includes(failure)
							? 'The targeted query section has no complete Kusto execution target'
							: 'The targeted query section has no saved Kusto connection.');
				expect(harness.poster).not.toHaveBeenCalled();
				expect(harness.executionPosted).not.toHaveBeenCalled();
				expect(Reflect.get(harness.orchestrator, 'pendingResponses').size).toBe(0);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				harness.dispose();
			}
		},
	);

	it('does not attach the old target expectation to an explicit database-only retarget', async () => {
		const harness = createKustoPreparationHarness();
		harness.preparation.resolve(true);
		try {
			await expect(harness.orchestrator.configureQuerySection({
				targetFileUri: harness.input.targetFileUri, sectionId: harness.input.sectionId,
				database: 'OtherDatabase', execute: true,
			})).resolves.toEqual({ success: true });
			expect(harness.stateGetter).toHaveBeenCalledOnce();
			expect(harness.poster).toHaveBeenCalledOnce();
			const message = harness.poster.mock.calls[0][0] as Record<string, unknown>;
			expect(message.input).toEqual({ sectionId: harness.input.sectionId, database: 'OtherDatabase', execute: true });
			expect(message).not.toHaveProperty('expectedKustoTarget');
		} finally {
			harness.dispose();
		}
	});

	it('rejects execute-only dispatch when no ready snapshot proof can be captured', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const uri = vscode.Uri.file('/work/no-kusto-preparation.kqlx');
		const poster = createMessagePoster();
		orchestrator.connect(poster, async () => [{ id: 'query_1', type: 'query' }], vi.fn(), uri.toString());
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		await expect(orchestrator.configureQuerySection({ sectionId: 'query_1', execute: true })).resolves.toEqual({
			success: false, error: 'The targeted query section has no complete Kusto execution target.',
		});
		expect(poster).not.toHaveBeenCalled();
	});

	it('rejects source drift during execute-only snapshot acquisition before publication or execution', async () => {
		vi.useFakeTimers();
		const harness = createKustoPreparationHarness();
		const snapshot = deferred<Awaited<ReturnType<typeof harness.stateGetter>>>();
		harness.stateGetter.mockReturnValue(snapshot.promise);
		const execution = harness.orchestrator.configureQuerySection({ targetFileUri: harness.input.targetFileUri,
			sectionId: harness.input.sectionId, execute: true }).catch(error => error);
		try {
			await vi.advanceTimersByTimeAsync(0);
			harness.change('source');
			snapshot.resolve([{ id: harness.input.sectionId, type: 'query',
				connectionId: harness.savedConnection.id, clusterUrl: harness.savedConnection.clusterUrl,
				database: 'Database', sectionInstanceId: 'instance-ready', targetGeneration: 7 }]);
			harness.preparation.resolve(true);
			expect(await execution).toMatchObject({ message: 'Kusto connections could not be prepared for execution.' });
			expect(harness.poster).not.toHaveBeenCalled();
			expect(harness.executionPosted).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			snapshot.resolve(undefined);
			harness.preparation.resolve(true);
			await execution;
			harness.dispose();
		}
	});

	it.each([true, false])('waits for a reopened editor projection before posting a Markdown mutation (ready=%s)', async ready => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/reopened-markdown.kqlx');
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const poster = createMessagePoster();
		const readiness = deferred<boolean>();
		orchestrator.connect(poster, vi.fn(async () => [
			{ id: 'markdown_restored', type: 'markdown', name: 'Summary' },
		]), vi.fn(), uri.toString(), undefined, undefined, undefined, () => readiness.promise);
		const openFileId = classifyWorkbenchUri(uri)!.openFileId;
		const listed = await orchestrator.listSections();
		expect(listed.openFiles?.find(file => file.openFileId === openFileId)?.sections)
			.toEqual([expect.objectContaining({ id: 'markdown_restored' })]);
		const update = orchestrator.updateMarkdownSection({
			openFileId, sectionId: 'markdown_restored', text: '# Edited after reopen',
		});
		await Promise.resolve();
		expect(poster).not.toHaveBeenCalled();
		readiness.resolve(ready);
		if (ready) {
			await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
			const request = poster.mock.calls[0][0] as { requestId: string; type: string };
			expect(request.type).toBe('toolUpdateMarkdownSection');
			orchestrator.handleWebviewResponse(request.requestId, { success: true });
			await expect(update).resolves.toEqual({ success: true });
		} else {
			await expect(update).rejects.toThrow('This document is still loading and cannot accept mutations yet.');
			expect(poster).not.toHaveBeenCalled();
		}
	});

	it('does not post a waiting Markdown mutation to a retired editor connection', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/closed-during-projection.kqlx');
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const poster = createMessagePoster();
		const readiness = deferred<boolean>();
		const token = orchestrator.connect(poster, vi.fn(async () => [
			{ id: 'markdown_restored', type: 'markdown', name: 'Summary' },
		]), vi.fn(), uri.toString(), undefined, undefined, undefined, () => readiness.promise);
		const update = orchestrator.updateMarkdownSection({
			openFileId: classifyWorkbenchUri(uri)!.openFileId,
			sectionId: 'markdown_restored', text: '# Do not dispatch',
		});
		const rejection = expect(update).rejects.toThrow('The targeted Kusto Workbench editor closed before the request was dispatched.');
		orchestrator.disconnectIfOwner(token);
		readiness.resolve(true);
		await rejection;
		expect(poster).not.toHaveBeenCalled();
	});

	it('cancels a live query tool while its projection readiness remains pending', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/cancel-during-projection.kqlx');
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const poster = createMessagePoster();
		const readiness = deferred<boolean>();
		const cancellation = cancellationToken();
		orchestrator.connect(poster, vi.fn(async () => [
			{ id: 'query_restored', type: 'query' },
		]), vi.fn(), uri.toString(), undefined, undefined, undefined, () => readiness.promise);
		const update = orchestrator.configureQuerySection({
			openFileId: classifyWorkbenchUri(uri)!.openFileId,
			sectionId: 'query_restored', query: 'print Value=1', execute: false,
		}, cancellation.token);
		let settled = false;
		const result = update.then(
			() => { settled = true; return undefined; },
			error => { settled = true; return error; },
		);
		await Promise.resolve();
		expect(poster).not.toHaveBeenCalled();
		try {
			cancellation.cancel();
			await vi.waitFor(() => expect(settled).toBe(true), { timeout: 250 });
			expect(await result).toBeInstanceOf(vscode.CancellationError);
			expect(poster).not.toHaveBeenCalled();
		} finally {
			readiness.resolve(true);
			await result;
		}
	});

	it('withdraws a timed-out dashboard request behind a physically held outbound head', async () => {
		vi.useFakeTimers();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/queued-dashboard.kqlx');
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		let receive: ((message: unknown) => unknown) | undefined;
		const physicalHead = deferred<boolean>();
		const posted = vi.fn((message: unknown) => (message as { type: string }).type === 'heldOutbound'
			? physicalHead.promise : Promise.resolve(true));
		const gateway = new MainWebviewStartupGateway<unknown>({
			panel: {
				webview: { postMessage: posted, onDidReceiveMessage: (handler: (message: unknown) => unknown) => {
					receive = handler;
					return { dispose() {} };
				} },
				onDidDispose: () => ({ dispose() {} }),
			} as never,
			admitInbound: input => input,
		});
		const token = orchestrator.connect((message, signal) => gateway.postMessage(message, signal),
			vi.fn(async () => []), vi.fn(), uri.toString());
		const head = gateway.postMessage({ type: 'heldOutbound' });
		const ready = Promise.resolve(receive?.({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'held-runtime' }));
		try {
			expect(posted).toHaveBeenCalledExactlyOnceWith({ type: 'heldOutbound' });
			const pending = orchestrator.validateHtmlDashboard({ targetFileUri: uri.toString(), sectionId: 'html-queued' });
			await vi.advanceTimersByTimeAsync(29_999);
			expect(posted).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(1);
			await expect(pending).resolves.toMatchObject({ success: false, error: 'Request timed out' });

			physicalHead.resolve(true);
			await head;
			await ready;
			expect(posted.mock.calls.map(([message]) => (message as { type: string }).type))
				.not.toContain('toolGetHtmlDashboardContext');

			const fresh = orchestrator.validateHtmlDashboard({ targetFileUri: uri.toString(), sectionId: 'html-queued' });
			await vi.advanceTimersByTimeAsync(0);
			const freshRequest = posted.mock.calls.map(([message]) => message as { type: string; requestId: string })
				.find(message => message.type === 'toolGetHtmlDashboardContext');
			expect(freshRequest).toBeTruthy();
			orchestrator.handleWebviewResponse(freshRequest!.requestId, undefined,
				'HTML section not found or does not support dashboard context.');
			await expect(fresh).resolves.toMatchObject({
				success: false, error: 'HTML section not found or does not support dashboard context.',
			});
		} finally {
			physicalHead.resolve(true);
			orchestrator.disconnectIfOwner(token);
			gateway.dispose();
			await ready;
		}
	});

	it('awaits snapshot-free read preflight before requesting dashboard context', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/read-preflight.kqlx');
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const readiness = deferred<boolean>();
		const readReady = vi.fn(() => readiness.promise);
		const poster = createMessagePoster();
		const token = Reflect.apply(orchestrator.connect, orchestrator, [
			poster, vi.fn(async () => []), vi.fn(), uri.toString(),
			undefined, undefined, undefined, undefined, undefined, readReady,
		]) as number;
		try {
			const request = orchestrator.validateHtmlDashboard({ targetFileUri: uri.toString(), sectionId: 'html-preflight' });
			await Promise.resolve();
			expect(readReady).toHaveBeenCalledOnce();
			expect(poster).not.toHaveBeenCalled();
			readiness.resolve(true);
			await Promise.resolve();
			await Promise.resolve();
			const message = poster.mock.calls[0]?.[0] as { requestId: string } | undefined;
			expect(message).toBeTruthy();
			orchestrator.handleWebviewResponse(message!.requestId, undefined, 'Read diagnostic');
			await expect(request).resolves.toMatchObject({ success: false, error: 'Read diagnostic' });
		} finally {
			readiness.resolve(false);
			orchestrator.disconnectIfOwner(token);
		}
	});

	it.each([
		['kqlx', 'query', 'query'],
		['sqlx', 'sql', 'query'],
		['mdx', 'markdown', 'text'],
	] as const)('createFile writes and opens a fresh %s with its explicit %s starter', async (
		fileType, sectionType, contentField,
	) => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const requestedPath = `/work/fresh-${fileType}`;

		const result = await orchestrator.createFile({ fileType, filePath: requestedPath });

		expect(result).toMatchObject({
			success: true,
			filePath: expect.stringContaining(`fresh-${fileType}.${fileType}`),
			openRequested: true,
		});
		const uri = vscode.Uri.file(`${requestedPath}.${fileType}`);
		const text = (vscode as any).__mockFileSystem.readText(uri);
		const file = JSON.parse(text);
		expect(file).toMatchObject({
			kind: fileType,
			version: 1,
			state: { sections: [{ type: sectionType, expanded: true, [contentField]: '' }] },
		});
		expect(file.state.sections).toHaveLength(1);
		expect((vscode as any).__mockCommandCalls).toContainEqual({
			command: 'vscode.openWith', args: [uri, 'kusto.kqlxEditor', { preview: false, preserveFocus: false }],
		});
	});

	it('refuses to overwrite an existing main file byte-exact', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/existing-report.kqlx');
		const original = '{"owner":"user","content":"keep exactly"}';
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(original));

		const result = await orchestrator.createFile({
			fileType: 'kqlx',
			filePath: '/work/existing-report',
			initialContent: 'print ShouldNotWrite = 1',
		});

		expect(result).toMatchObject({ success: false, error: expect.stringContaining('never overwritten') });
		expect((vscode as any).__mockFileSystem.readText(uri)).toBe(original);
		expect((vscode as any).__mockCommandCalls).not.toContainEqual(expect.objectContaining({ command: 'vscode.openWith' }));
	});

	it('refuses a sidecar collision before creating the main file', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const mainUri = vscode.Uri.file('/work/existing-sidecar.kql');
		const sidecarUri = vscode.Uri.file('/work/existing-sidecar.kql.json');
		const originalSidecar = '{"owner":"user","sidecar":"keep exactly"}';
		await vscode.workspace.fs.writeFile(sidecarUri, new TextEncoder().encode(originalSidecar));

		const result = await orchestrator.createFile({
			fileType: 'kql-sidecar',
			filePath: '/work/existing-sidecar',
			initialContent: 'print ShouldNotWrite = 1',
		});

		expect(result).toMatchObject({ success: false, error: expect.stringContaining('never overwritten') });
		expect((vscode as any).__mockFileSystem.readText(mainUri)).toBeUndefined();
		expect((vscode as any).__mockFileSystem.readText(sidecarUri)).toBe(originalSidecar);
	});

	it('rolls back a newly published main file when sidecar publication fails', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const mainUri = vscode.Uri.file('/work/sidecar-publish-failure.kql');
		const sidecarUri = vscode.Uri.file('/work/sidecar-publish-failure.kql.json');
		const rename = vscode.workspace.fs.rename.bind(vscode.workspace.fs);
		let renameCount = 0;
		vi.spyOn(fs.promises, 'stat').mockResolvedValue({ dev: 1n, ino: 1n } as any);
		vi.spyOn(vscode.workspace.fs, 'rename').mockImplementation(async (...args) => {
			renameCount++;
			if (renameCount === 2) throw new Error('synthetic sidecar publish failure');
			return rename(...args);
		});

		const result = await orchestrator.createFile({
			fileType: 'kql-sidecar',
			filePath: '/work/sidecar-publish-failure',
			initialContent: 'print Value = 1',
		});

		expect(result).toMatchObject({ success: false, error: expect.stringContaining('synthetic sidecar publish failure') });
		expect((vscode as any).__mockFileSystem.readText(mainUri)).toBeUndefined();
		expect((vscode as any).__mockFileSystem.readText(sidecarUri)).toBeUndefined();
	});

	it('preserves an external replacement when sidecar publication fails after publishing the main file', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const mainUri = vscode.Uri.file('/work/sidecar-external-replacement.kql');
		const sidecarUri = vscode.Uri.file('/work/sidecar-external-replacement.kql.json');
		const externalText = 'print External = 2';
		const rename = vscode.workspace.fs.rename.bind(vscode.workspace.fs);
		let renameCount = 0;
		let externalReplacementPublished = false;
		vi.spyOn(fs.promises, 'stat').mockImplementation(async path => {
			const value = String(path);
			const mainFileQuarantine = value.includes('.rollback') && !value.includes('.kql.json.');
			const inode = mainFileQuarantine && externalReplacementPublished ? 3n : 1n;
			return { dev: 1n, ino: inode } as any;
		});
		vi.spyOn(vscode.workspace.fs, 'rename').mockImplementation(async (...args) => {
			renameCount++;
			if (renameCount === 2) {
				await vscode.workspace.fs.writeFile(mainUri, new TextEncoder().encode(externalText));
				externalReplacementPublished = true;
				throw new Error('synthetic sidecar publish failure');
			}
			return rename(...args);
		});

		const result = await orchestrator.createFile({
			fileType: 'kql-sidecar',
			filePath: '/work/sidecar-external-replacement',
			initialContent: 'print Value = 1',
		});

		expect(result).toMatchObject({ success: false, error: expect.stringContaining('synthetic sidecar publish failure') });
		expect((vscode as any).__mockFileSystem.readText(mainUri)).toBe(externalText);
		expect((vscode as any).__mockFileSystem.readText(sidecarUri)).toBeUndefined();
	});

	it('preserves an in-place external edit when sidecar publication fails after publishing the main file', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const mainUri = vscode.Uri.file('/work/sidecar-in-place-edit.kql');
		const externalText = 'print ExternalInPlace = 3';
		const rename = vscode.workspace.fs.rename.bind(vscode.workspace.fs);
		let renameCount = 0;
		vi.spyOn(fs.promises, 'stat').mockResolvedValue({ dev: 1n, ino: 1n } as any);
		vi.spyOn(vscode.workspace.fs, 'rename').mockImplementation(async (...args) => {
			renameCount++;
			if (renameCount === 2) {
				await vscode.workspace.fs.writeFile(mainUri, new TextEncoder().encode(externalText));
				throw new Error('synthetic sidecar publish failure');
			}
			return rename(...args);
		});

		const result = await orchestrator.createFile({
			fileType: 'kql-sidecar', filePath: '/work/sidecar-in-place-edit', initialContent: 'print Value = 1',
		});

		expect(result).toMatchObject({ success: false, error: expect.stringContaining('synthetic sidecar publish failure') });
		expect((vscode as any).__mockFileSystem.readText(mainUri)).toBe(externalText);
	});

	it('reports durable creation when opening the new file fails', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/created-not-opened.kqlx');
		vi.spyOn(vscode.commands, 'executeCommand').mockRejectedValueOnce(new Error('synthetic open failure'));

		const result = await orchestrator.createFile({
			fileType: 'kqlx', filePath: '/work/created-not-opened', reveal: false,
		});

		expect(result).toMatchObject({
			success: true,
			filePath: uri.fsPath,
			openRequested: true,
			opened: false,
			warning: expect.stringContaining('synthetic open failure'),
		});
		expect((vscode as any).__mockFileSystem.readText(uri)).toBeDefined();
	});

	it('createFile preserves focus for a background external workflow', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/background-report.kqlx');

		await orchestrator.createFile({ fileType: 'kqlx', filePath: '/work/background-report', reveal: false });

		expect((vscode as any).__mockCommandCalls).toContainEqual({
			command: 'vscode.openWith',
			args: [uri, 'kusto.kqlxEditor', { preview: false, preserveFocus: true }],
		});
	});

	it.each(['removal', 'Kusto execution', 'SQL execution'].flatMap(operation => [
		{ operation, targetKey: 'openFileId', active: true },
		{ operation, targetKey: 'targetFileUri', active: true },
		{ operation, targetKey: 'openFileId', active: false },
		{ operation, targetKey: 'targetFileUri', active: false },
	]))('first $operation after background creation ($targetKey, active=$active)', async ({ operation, targetKey, active }) => {
		(vscode as any).__mockFileSystem.clear();
		const kustoConnection = { id: 'kusto-test', clusterUrl: 'https://cluster.kusto.windows.net' };
		const sqlConnection = { ...defaultSqlConnection, authType: 'sql-login', username: 'test-user' };
		const sqlOwner = { connectionId: sqlConnection.id, database: 'Db', ownerToken: 'new-sql-owner', generation: 1 };
		const sqlManager = {
			getConnections: () => [sqlConnection],
			getConnection: (id: string) => id === sqlConnection.id ? sqlConnection : undefined,
			assertConnectionCurrent: vi.fn(async () => undefined),
		};
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, { getConnections: () => [kustoConnection] } as any, () => sqlManager as any, fakeKustoClient,
		);
		const fileType = operation === 'SQL execution' ? 'sqlx' : 'kqlx';
		const sectionType = operation === 'SQL execution' ? 'sql' : 'query';
		const initialContent = operation === 'removal' ? '' : operation === 'SQL execution' ? 'SELECT 1 AS Probe' : 'print Probe = 1';
		const uri = vscode.Uri.file(`/work/first-operation-${targetKey}-${active}.${fileType}`);
		const sectionId = `${sectionType}_projected_starter`;
		let sections = [{ id: sectionId, type: sectionType, query: initialContent, database: 'Db',
			...(operation === 'Kusto execution' ? { connectionId: kustoConnection.id, clusterUrl: kustoConnection.clusterUrl,
				sectionInstanceId: 'instance-created', targetGeneration: 1 } : {}),
		}];
		const poster = vi.fn((message: unknown) => {
			const request = message as { type: string; requestId: string; sectionId: string; input?: { sectionId: string; query?: string; executionId?: string; execute: boolean } };
			if (operation === 'removal') {
				expect(request.type).toBe('toolRemoveSection');
				expect(request.sectionId).toBe(sections[0].id);
				sections = [];
				orchestrator.handleWebviewResponse(request.requestId, { success: true });
			} else {
				expect(request.type).toBe(operation === 'SQL execution' ? 'toolConfigureSqlSection' : 'toolConfigureQuerySection');
				expect(request.input).toMatchObject({ sectionId, execute: true });
				expect(request.input).not.toHaveProperty('query');
				if (operation === 'Kusto execution') {
					expect(request.input).toEqual({ sectionId, execute: true });
					expect(request).toHaveProperty('expectedKustoTarget', {
						sectionId, sectionInstanceId: 'instance-created', targetGeneration: 1,
						connectionId: kustoConnection.id, clusterUrl: kustoConnection.clusterUrl, database: 'Db',
					});
				}
				expect(sections[0].query).toBe(initialContent);
				orchestrator.handleWebviewResponse(request.requestId, {
					success: true, resultPreview: 'Probe: 1',
					...(operation === 'SQL execution' ? { executionId: request.input?.executionId, executionOwner: sqlOwner } : {}),
				});
			}
			return true;
		});
		const stateGetter = vi.fn(async () => sections);
		const open = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async (command, ...args) => {
			expect(command).toBe('vscode.openWith');
			expect(args).toEqual([uri, 'kusto.kqlxEditor', { preview: false, preserveFocus: true }]);
			const text = (vscode as any).__mockFileSystem.readText(uri);
			(vscode.workspace as any).textDocuments = [{
				uri, getText: () => text, isDirty: false, version: 1,
				positionAt: (offset: number) => new vscode.Position(0, offset),
			}];
			const tab = { isActive: active, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
			if (active) setTabGroups({ activeTab: tab, tabs: [tab], isActive: true });
			else setTabGroups({ activeTab: undefined, tabs: [], isActive: true }, { activeTab: tab, tabs: [tab], isActive: false });
			orchestrator.connect(poster, stateGetter, vi.fn(), uri.toString(),
				() => sqlConnection.id, () => sqlOwner, undefined, async () => true,
				undefined, undefined, undefined, async onReady => onReady(() => true));
		});

		expect(await orchestrator.createFile({
			fileType, filePath: uri.fsPath, initialContent, reveal: false,
		})).toMatchObject({ success: true, filePath: uri.fsPath });
		expect(await orchestrator.saveWorkbenchFile({ targetFileUri: uri.toString() }))
			.toMatchObject({ success: true, saved: false, wasDirty: false });
		const inventory = await orchestrator.listSections();
		const file = inventory.openFiles?.find(candidate => candidate.openFileId === classifyWorkbenchUri(uri)!.openFileId);
		expect(file).toMatchObject({ isActive: active, isLiveWorkbench: true, isReadOnlyFallback: false });
		expect(file?.sections).toEqual([expect.objectContaining({ id: sectionId, type: sectionType })]);
		const target = targetKey === 'openFileId' ? { openFileId: file!.openFileId } : { targetFileUri: uri.toString() };

		if (operation === 'removal') {
			await expect(orchestrator.removeSection({ ...target, sectionId: file!.sections![0].id }))
				.resolves.toEqual({ success: true });
			expect(sections).toEqual([]);
		} else {
			const input = { ...target, sectionId: file!.sections![0].id, execute: true };
			await expect(operation === 'SQL execution'
				? orchestrator.configureSqlSection({ ...input, connectionId: sqlConnection.id, database: 'Db' })
				: orchestrator.configureQuerySection(input))
				.resolves.toEqual({ success: true, resultPreview: 'Probe: 1' });
		}
		expect(poster).toHaveBeenCalledOnce();
		expect(open).toHaveBeenCalledOnce();
	});

	it('rejects a first background removal when source changes during final dispatch readiness', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/background-dispatch-version.kqlx');
		await orchestrator.createFile({ fileType: 'kqlx', filePath: uri.fsPath, reveal: false });
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const text = (vscode as any).__mockFileSystem.readText(uri);
		const document = { uri, version: 1, isDirty: false, getText: () => text };
		(vscode.workspace as any).textDocuments = [document];
		const poster = vi.fn((message: unknown) => {
			orchestrator.handleWebviewResponse((message as { requestId: string }).requestId, { success: true });
			return true;
		});
		let readinessCalls = 0;
		orchestrator.connect(poster, async () => [{ id: 'query_projected', type: 'query' }], vi.fn(),
			uri.toString(), undefined, undefined, undefined, async () => {
				if (++readinessCalls === 2) document.version++;
				return true;
			});

		await expect(orchestrator.removeSection({ targetFileUri: uri.toString(), sectionId: 'query_projected' }))
			.rejects.toThrow('changed before the request was dispatched');
		expect(readinessCalls).toBe(2);
		expect(poster).not.toHaveBeenCalled();
	});

	it('cancels public background removal while an admitted edit drains and leaves Save usable', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/background-cancel-drain.kqlx');
		await orchestrator.createFile({ fileType: 'kqlx', filePath: uri.fsPath, reveal: false });
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		let text = (vscode as any).__mockFileSystem.readText(uri);
		let dirty = false;
		const document = {
			uri, version: 1, getText: () => text, get isDirty() { return dirty; },
			positionAt: (offset: number) => new vscode.Position(0, offset),
			save: vi.fn(async () => {
				await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
				dirty = false;
				return true;
			}),
		};
		(vscode.workspace as any).textDocuments = [document];
		class TestWorkspaceEdit {
			replacement = '';
			replace(_uri: vscode.Uri, _range: vscode.Range, value: string) { this.replacement = value; }
		}
		(vscode as any).WorkspaceEdit = TestWorkspaceEdit;
		const editGate = deferred<void>();
		const applyEdit = vi.fn(async (edit: TestWorkspaceEdit) => {
			await editGate.promise;
			text = edit.replacement;
			dirty = true;
			document.version++;
			return true;
		});
		(vscode.workspace as any).applyEdit = applyEdit;
		const poster = createMessagePoster();
		orchestrator.connect(poster, async () => [{ id: 'section_0', type: 'query' }], vi.fn(),
			uri.toString(), undefined, undefined, undefined, async () => true);
		const target = { targetFileUri: uri.toString() };
		const editing = orchestrator.configureQuerySection({ ...target, sectionId: 'section_0', query: 'print Retained = 2' });
		const resultDescriptor = Object.getOwnPropertyDescriptor(vscode, 'LanguageModelToolResult');
		try {
			Object.defineProperty(vscode, 'LanguageModelToolResult', {
				configurable: true,
				value: class { constructor(readonly content: unknown[]) {} },
			});
			await vi.waitFor(() => expect(applyEdit).toHaveBeenCalledOnce());
			const cancellation = cancellationToken();
			const removal = new RemoveSectionTool(orchestrator).invoke({
				input: { ...target, sectionId: 'section_0' }, toolInvocationToken: undefined,
			}, cancellation.token);
			cancellation.cancel();
			const response = await removal;
			expect((response.content[0] as vscode.LanguageModelTextPart).value).toMatch(/Error:.*cancel/i);
			expect(poster).not.toHaveBeenCalled();
			expect(orchestrator.isHostOwnedBackgroundFile(uri)).toBe(true);
		} finally {
			editGate.resolve();
			if (resultDescriptor) Object.defineProperty(vscode, 'LanguageModelToolResult', resultDescriptor);
			else Reflect.deleteProperty(vscode, 'LanguageModelToolResult');
			await editing;
		}
		await vi.waitFor(() => expect((orchestrator as any).backgroundMutationBlocks.size).toBe(0));
		await expect(orchestrator.saveWorkbenchFile(target)).resolves.toMatchObject({ success: true, saved: true });
		expect(JSON.parse((vscode as any).__mockFileSystem.readText(uri)).state.sections[0].query).toBe('print Retained = 2');
		expect(poster).not.toHaveBeenCalled();
	});

	it.each(['unready', 'source-version', 'closed'])('retains background ownership after rejected handoff (%s)', async failure => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file(`/work/background-rejected-${failure}.kqlx`);
		await orchestrator.createFile({ fileType: 'kqlx', filePath: uri.fsPath, reveal: false });
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const text = (vscode as any).__mockFileSystem.readText(uri);
		const document = { uri, version: 1, isDirty: false, getText: () => text };
		(vscode.workspace as any).textDocuments = [document];
		const poster = createMessagePoster();
		const ready = deferred<boolean>();
		const readiness = vi.fn(() => ready.promise);
		const token = orchestrator.connect(poster, async () => [{ id: 'query_projected', type: 'query' }], vi.fn(),
			uri.toString(), undefined, undefined, undefined, readiness);
		const removal = orchestrator.removeSection({ targetFileUri: uri.toString(), sectionId: 'query_projected' });
		const rejected = expect(removal).rejects.toThrow(failure === 'unready' ? 'still loading' : 'changed before background ownership');
		await vi.waitFor(() => expect(readiness).toHaveBeenCalledOnce());
		if (failure === 'source-version') document.version++;
		if (failure === 'closed') orchestrator.disconnectIfOwner(token);
		ready.resolve(failure !== 'unready');
		await rejected;
		expect(orchestrator.isHostOwnedBackgroundFile(uri)).toBe(true);
		expect(poster).not.toHaveBeenCalled();
		expect((vscode as any).__mockFileSystem.readText(uri)).toBe(text);
		await expect(orchestrator.saveWorkbenchFile({ targetFileUri: uri.toString() }))
			.resolves.toMatchObject({ success: true, saved: false });
	});

	it('lists backing-document sections while a live rich editor snapshot is not ready', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/opening-background.kqlx');
		const tab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
		setTabGroups({ activeTab: tab, tabs: [tab], isActive: true });
		const text = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{ id: 'query_backing', type: 'query', query: 'print Value = 1' }] },
		});
		(vscode.workspace as any).textDocuments = [{
			uri,
			getText: () => text,
			positionAt: (offset: number) => new vscode.Position(0, offset),
			isDirty: false,
		}];
		const stateGetter = vi.fn(async () => undefined as any);
		orchestrator.connect(vi.fn(() => true), stateGetter, vi.fn(), uri.toString());

		const result = await orchestrator.listSections();
		const file = result.openFiles?.find(candidate => candidate.openFileId === classifyWorkbenchUri(uri)!.openFileId);

		expect(stateGetter).toHaveBeenCalled();
		expect(result.sections).toEqual([expect.objectContaining({ id: 'query_backing', type: 'query' })]);
		expect(file?.sections).toEqual([expect.objectContaining({ id: 'query_backing', type: 'query' })]);
		expect(file).toMatchObject({
			isLiveWorkbench: false, isReadOnlyFallback: false, sectionsUnavailable: true,
			error: expect.stringMatching(/\S/),
		});
	});

	it('does not publish live inventory from a connection retired during snapshot retrieval', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/retired-inventory.kqlx');
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const snapshot = deferred<any[]>();
		const getter = vi.fn(() => snapshot.promise);
		const token = orchestrator.connect(createMessagePoster(), getter, vi.fn(), uri.toString());
		const inventory = orchestrator.listSections();
		await vi.waitFor(() => expect(getter).toHaveBeenCalledOnce());
		orchestrator.disconnectIfOwner(token);
		snapshot.resolve([{ id: 'retired_query', type: 'query', query: 'print Retired=1' }]);
		const result = await inventory;
		const file = result.openFiles?.find(candidate => candidate.uri === uri.toString());
		expect(file).toMatchObject({ isLiveWorkbench: false, sectionsUnavailable: true });
		expect(result.sections).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'retired_query' })]));
	});

	it('does not publish live inventory retired after its snapshot while another file is pending', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const firstUri = vscode.Uri.file('/work/retired-after-snapshot.kqlx');
		const secondUri = vscode.Uri.file('/work/pending-snapshot-peer.kqlx');
		const firstTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(firstUri, 'kusto.kqlxEditor') };
		const secondTab = { isActive: false, isDirty: false, input: new vscode.TabInputCustom(secondUri, 'kusto.kqlxEditor') };
		setTabGroups({ activeTab: firstTab, tabs: [firstTab, secondTab], isActive: true });
		const firstGetter = vi.fn(async () => [{ id: 'retired_query', type: 'query' }]);
		const secondSnapshot = deferred<Array<{ id: string; type: string }>>();
		const secondGetter = vi.fn(() => secondSnapshot.promise);
		const firstToken = orchestrator.connect(createMessagePoster(), firstGetter, vi.fn(), firstUri.toString());
		orchestrator.connect(createMessagePoster(), secondGetter, vi.fn(), secondUri.toString());

		const inventory = orchestrator.listSections();
		await vi.waitFor(() => expect(secondGetter).toHaveBeenCalledOnce());
		await Promise.resolve();
		await Promise.resolve();
		orchestrator.disconnectIfOwner(firstToken);
		secondSnapshot.resolve([{ id: 'current_query', type: 'query' }]);
		const result = await inventory;
		const retired = result.openFiles?.find(file => file.uri === firstUri.toString());
		const current = result.openFiles?.find(file => file.uri === secondUri.toString());

		expect(firstGetter).toHaveBeenCalledOnce();
		expect(retired).toMatchObject({ isLiveWorkbench: false, isReadOnlyFallback: false, sectionsUnavailable: true });
		expect(retired?.error?.trim()).toBeTruthy();
		expect(retired?.sections).toBeUndefined();
		expect(result.sections).toEqual([]);
		expect(current).toMatchObject({ isLiveWorkbench: true, sections: [expect.objectContaining({ id: 'current_query' })] });
	});

	it('does not publish live inventory from a connection retired during SQL privacy admission', async () => {
		const policy = deferred<string[]>();
		const refreshPolicy = vi.fn(() => policy.promise);
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient, refreshPolicy,
		);
		const uri = vscode.Uri.file('/work/retired-sql-inventory.sqlx');
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const token = orchestrator.connect(createMessagePoster(), vi.fn(async () => [{
			id: 'retired_sql', type: 'sql', query: 'SELECT 1', serverUrl: 'server.example',
		}]), vi.fn(), uri.toString(), () => 'sql-test');
		const inventory = orchestrator.listSections();
		await vi.waitFor(() => expect(refreshPolicy).toHaveBeenCalledOnce());
		orchestrator.disconnectIfOwner(token);
		policy.resolve([]);
		const result = await inventory;
		const file = result.openFiles?.find(candidate => candidate.uri === uri.toString());
		expect(file).toMatchObject({ isLiveWorkbench: false, sectionsUnavailable: true });
		expect(result.sections).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'retired_sql' })]));
	});

	it('omits a protected SQL section from backing-document fallback', async () => {
		const refreshPolicy = vi.fn(async () => ['sql-sensitive']);
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
			refreshPolicy,
		);
		const uri = vscode.Uri.file('/work/opening-sensitive.sqlx');
		const tab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
		setTabGroups({ activeTab: tab, tabs: [tab], isActive: true });
		const text = JSON.stringify({
			kind: 'sqlx', version: 1, state: { sections: [{
				id: 'sql_sensitive', type: 'sql', serverUrl: 'private.example', database: 'Sensitive',
				connectionIdHint: 'sql-sensitive', query: 'SELECT 1',
			}] },
		});
		(vscode.workspace as any).textDocuments = [{
			uri,
			getText: () => text,
			positionAt: (offset: number) => new vscode.Position(0, offset),
			isDirty: false,
		}];
		orchestrator.connect(vi.fn(() => true), vi.fn(async () => undefined as any), vi.fn(), uri.toString());

		const result = await orchestrator.listSections();
		const file = result.openFiles?.find(candidate => candidate.openFileId === classifyWorkbenchUri(uri)!.openFileId);

		expect(refreshPolicy).toHaveBeenCalled();
		expect(result.sections).toEqual([]);
		expect(file?.sections).toEqual([]);
		expect(JSON.stringify(file)).not.toContain('private.example');
		expect(JSON.stringify(file)).not.toContain('Sensitive');
	});

	it('does not expose backing SQL sections when privacy policy resolution fails', async () => {
		const refreshPolicy = vi.fn(async () => { throw new Error('privacy policy unavailable'); });
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
			refreshPolicy,
		);
		const uri = vscode.Uri.file('/work/opening-policy-failure.sqlx');
		const tab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
		setTabGroups({ activeTab: tab, tabs: [tab], isActive: true });
		const text = JSON.stringify({
			kind: 'sqlx', version: 1, state: { sections: [{
				id: 'sql_sensitive', type: 'sql', serverUrl: 'private.example', database: 'Sensitive',
				connectionIdHint: 'sql-sensitive', query: 'SELECT 1',
			}] },
		});
		(vscode.workspace as any).textDocuments = [{
			uri,
			getText: () => text,
			positionAt: (offset: number) => new vscode.Position(0, offset),
			isDirty: false,
		}];
		orchestrator.connect(vi.fn(() => true), vi.fn(async () => undefined as any), vi.fn(), uri.toString());

		const result = await orchestrator.listSections();
		const file = result.openFiles?.find(candidate => candidate.openFileId === classifyWorkbenchUri(uri)!.openFileId);

		expect(file?.sections).toBeUndefined();
		expect(file?.sectionsUnavailable).toBe(true);
		expect(file?.error).toContain('privacy policy unavailable');
		expect(JSON.stringify(file)).not.toContain('private.example');
		expect(JSON.stringify(file)).not.toContain('Sensitive');
	});

	it('keeps reveal-false rich files host-owned until explicit activation', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/owned-background.kqlx');
		expect(await orchestrator.createFile({
			fileType: 'kqlx',
			filePath: '/work/owned-background',
			initialContent: 'print Value = 1',
			reveal: false,
		})).toMatchObject({ success: true, filePath: uri.fsPath });
		let text = (vscode as any).__mockFileSystem.readText(uri);
		const tab = { isActive: false, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
		setTabGroups({ activeTab: undefined, tabs: [], isActive: true }, { activeTab: tab, tabs: [tab], isActive: false });
		const document = {
			uri,
			getText: () => text,
			positionAt: (offset: number) => new vscode.Position(0, offset),
			isDirty: false,
		};
		(vscode.workspace as any).textDocuments = [document];
		class TestWorkspaceEdit {
			replacement = '';
			replace(_uri: vscode.Uri, _range: vscode.Range, value: string) { this.replacement = value; }
		}
		(vscode as any).WorkspaceEdit = TestWorkspaceEdit;
		const applyEdit = vi.fn(async (edit: TestWorkspaceEdit) => {
			text = edit.replacement;
			return true;
		});
		(vscode.workspace as any).applyEdit = applyEdit;
		const poster = createMessagePoster();
		const stateGetter = vi.fn(async () => undefined as any);
		orchestrator.connect(poster, stateGetter, vi.fn(), uri.toString());

		const listed = await orchestrator.listSections();
		const file = listed.openFiles?.find(candidate => candidate.openFileId === classifyWorkbenchUri(uri)!.openFileId);
		const sectionId = file?.sections?.[0]?.id;
		expect(sectionId).toBe('section_0');
		expect(stateGetter).toHaveBeenCalledOnce();
		expect(file).toMatchObject({ isLiveWorkbench: false, isReadOnlyFallback: false, sectionsUnavailable: true });
		expect(file?.error?.trim()).toBeTruthy();
		expect(await orchestrator.configureQuerySection({
			openFileId: file!.openFileId,
			sectionId: sectionId!,
			query: 'print Value = 2',
		})).toEqual({ success: true });
		expect(poster).not.toHaveBeenCalled();
		expect(applyEdit).toHaveBeenCalledOnce();
		expect(text).toContain('print Value = 2');

		stateGetter.mockResolvedValue(JSON.parse(text).state.sections);
		expect(await orchestrator.activateWorkbenchFile({ openFileId: file!.openFileId }))
			.toMatchObject({ success: true });
		const liveMutation = orchestrator.configureQuerySection({
			openFileId: file!.openFileId,
			sectionId: sectionId!,
			query: 'print Value = 3',
		});
		expect(poster).toHaveBeenCalledOnce();
		const request = poster.mock.calls[0][0] as any;
		orchestrator.handleWebviewResponse(request.requestId, { success: true });
		await expect(liveMutation).resolves.toEqual({ success: true });
	});

	it('configures SQL, Transformation, and HTML sections in a reveal-false report without a live editor', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/background-complete-report.kqlx');
		await orchestrator.createFile({
			fileType: 'kqlx', filePath: '/work/background-complete-report', reveal: false,
		});
		let text = (vscode as any).__mockFileSystem.readText(uri);
		const tab = { isActive: false, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
		setTabGroups({ activeTab: undefined, tabs: [], isActive: true }, { activeTab: tab, tabs: [tab], isActive: false });
		(vscode.workspace as any).textDocuments = [{
			uri,
			getText: () => text,
			positionAt: (offset: number) => new vscode.Position(0, offset),
			isDirty: false,
		}];
		class TestWorkspaceEdit {
			replacement = '';
			replace(_uri: vscode.Uri, _range: vscode.Range, value: string) { this.replacement = value; }
		}
		(vscode as any).WorkspaceEdit = TestWorkspaceEdit;
		(vscode.workspace as any).applyEdit = vi.fn(async (edit: TestWorkspaceEdit) => {
			text = edit.replacement;
			return true;
		});
		const openFileId = classifyWorkbenchUri(uri)!.openFileId;

		const sql = await orchestrator.addSection({ openFileId, type: 'sql', name: 'Warehouse' });
		expect(await orchestrator.configureSqlSection({
			openFileId, sectionId: sql.sectionId, name: 'Warehouse', query: 'SELECT 42\\nGO', database: 'Analytics',
		})).toEqual({ success: true });
		const transformation = await orchestrator.addSection({
			openFileId, type: 'transformation', name: 'Summary', dataSourceId: 'old_source', dataSourceResultIndex: 2,
		});
		expect(await orchestrator.configureTransformation({
			openFileId, sectionId: transformation.sectionId, name: 'Summary', dataSourceId: 'section_0',
			transformationType: 'summarize', groupByColumns: ['Category'],
			aggregations: [{ name: 'Total', column: 'Value', function: 'sum' }],
		})).toEqual({ success: true });
		const html = await orchestrator.addSection({ openFileId, type: 'html', name: 'Dashboard' });
		const htmlCode = `<script type="application/kw-provenance">${JSON.stringify({
			version: 1, model: { fact: { sectionId: 'section_0' } }, bindings: {},
		})}</script><h1>Ready</h1>`;
		expect(await orchestrator.configureHtmlSection({
			openFileId, sectionId: html.sectionId, name: 'Dashboard', code: htmlCode, mode: 'preview',
		})).toEqual({ success: true });

		const file = JSON.parse(text);
		expect(file.state.sections).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: sql.sectionId, type: 'sql', name: 'Warehouse', query: 'SELECT 42\nGO', database: 'Analytics' }),
			expect.objectContaining({
				id: transformation.sectionId, type: 'transformation', transformationType: 'summarize',
				dataSourceId: 'section_0', dataSourceResultIndex: 0,
				groupByColumns: ['Category'], aggregations: [{ name: 'Total', column: 'Value', function: 'sum' }],
			}),
			expect.objectContaining({
				id: html.sectionId, type: 'html', name: 'Dashboard', code: htmlCode,
				mode: 'preview', dataSourceIds: ['section_0'],
			}),
		]));
	});

	it('migrates reveal-false ownership across rename before mutating the new file', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const oldUri = vscode.Uri.file('/work/background-before.kqlx');
		const newUri = vscode.Uri.file('/work/background-after.kqlx');
		await orchestrator.createFile({ fileType: 'kqlx', filePath: '/work/background-before', reveal: false });
		let text = (vscode as any).__mockFileSystem.readText(oldUri);
		const oldTab = { isActive: false, isDirty: false, input: new vscode.TabInputCustom(oldUri, 'kusto.kqlxEditor') };
		const newTab = { isActive: false, isDirty: false, input: new vscode.TabInputCustom(newUri, 'kusto.kqlxEditor') };
		setTabGroups({ activeTab: undefined, tabs: [oldTab], isActive: true });
		(vscode.workspace as any).textDocuments = [{
			uri: newUri,
			getText: () => text,
			positionAt: (offset: number) => new vscode.Position(0, offset),
			isDirty: false,
		}];
		class TestWorkspaceEdit {
			replacement = '';
			replace(_uri: vscode.Uri, _range: vscode.Range, value: string) { this.replacement = value; }
		}
		(vscode as any).WorkspaceEdit = TestWorkspaceEdit;
		const applyEdit = vi.fn(async (edit: TestWorkspaceEdit) => {
			text = edit.replacement;
			return true;
		});
		(vscode.workspace as any).applyEdit = applyEdit;
		const poster = vi.fn(() => true);
		orchestrator.connect(poster, vi.fn(async () => undefined as any), vi.fn(), oldUri.toString());

		await orchestrator.prepareFilesRename([{ oldUri, newUri }]);
		setTabGroups({ activeTab: undefined, tabs: [newTab], isActive: true });
		await orchestrator.handleFilesRenamed([{ oldUri, newUri }]);
		const listed = await orchestrator.listSections();
		const file = listed.openFiles?.find(candidate => candidate.openFileId === classifyWorkbenchUri(newUri)!.openFileId);
		expect(file?.sections?.[0]?.id).toBe('section_0');
		expect(await orchestrator.configureQuerySection({
			openFileId: file!.openFileId,
			sectionId: 'section_0',
			query: 'print Renamed = true',
		})).toEqual({ success: true });
		expect(poster).not.toHaveBeenCalled();
		expect(applyEdit).toHaveBeenCalledOnce();
		expect(text).toContain('print Renamed = true');
	});

	it('expands a parent-folder rename to its host-owned Workbench descendant', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const oldFolder = vscode.Uri.file('/work/background-folder-old');
		const newFolder = vscode.Uri.file('/work/background-folder-new');
		const oldUri = vscode.Uri.file('/work/background-folder-old/report.kqlx');
		const newUri = vscode.Uri.file('/work/background-folder-new/report.kqlx');
		await orchestrator.createFile({
			fileType: 'kqlx',
			filePath: '/work/background-folder-old/report',
			reveal: false,
		});
		let text = (vscode as any).__mockFileSystem.readText(oldUri);
		const oldTab = { isActive: false, isDirty: false, input: new vscode.TabInputCustom(oldUri, 'kusto.kqlxEditor') };
		const newTab = { isActive: false, isDirty: false, input: new vscode.TabInputCustom(newUri, 'kusto.kqlxEditor') };
		setTabGroups({ activeTab: undefined, tabs: [oldTab], isActive: true });
		(vscode.workspace as any).textDocuments = [{
			uri: newUri,
			getText: () => text,
			positionAt: (offset: number) => new vscode.Position(0, offset),
			isDirty: false,
		}];
		class TestWorkspaceEdit {
			replacement = '';
			replace(_uri: vscode.Uri, _range: vscode.Range, value: string) { this.replacement = value; }
		}
		(vscode as any).WorkspaceEdit = TestWorkspaceEdit;
		const applyEdit = vi.fn(async (edit: TestWorkspaceEdit) => {
			text = edit.replacement;
			return true;
		});
		(vscode.workspace as any).applyEdit = applyEdit;
		orchestrator.connect(vi.fn(() => true), vi.fn(async () => undefined as any), vi.fn(), oldUri.toString());

		await orchestrator.prepareFilesRename([{ oldUri: oldFolder, newUri: newFolder }]);
		setTabGroups({ activeTab: undefined, tabs: [newTab], isActive: true });
		await orchestrator.handleFilesRenamed([{ oldUri: oldFolder, newUri: newFolder }]);
		const listed = await orchestrator.listSections();
		const newFile = listed.openFiles?.find(candidate => candidate.openFileId === classifyWorkbenchUri(newUri)!.openFileId);
		expect(newFile?.sections?.[0]?.id).toBe('section_0');
		expect(listed.openFiles?.some(candidate => candidate.openFileId === classifyWorkbenchUri(oldUri)!.openFileId)).toBe(false);
		expect(await orchestrator.configureQuerySection({
			openFileId: newFile!.openFileId,
			sectionId: 'section_0',
			query: 'print FolderRenamed = true',
		})).toEqual({ success: true });
		expect(applyEdit).toHaveBeenCalledOnce();
		expect(text).toContain('print FolderRenamed = true');
	});

	it('retires reveal-false ownership after manual tab close so reopen uses the live editor', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/background-reopened.kqlx');
		await orchestrator.createFile({ fileType: 'kqlx', filePath: '/work/background-reopened', reveal: false });
		const closedTab = { isActive: false, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
		setTabGroups({ activeTab: undefined, tabs: [], isActive: true });
		await orchestrator.handleTabsClosed([closedTab as any]);
		const reopenedTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
		setTabGroups({ activeTab: reopenedTab, tabs: [reopenedTab], isActive: true });
		const poster = createMessagePoster();
		orchestrator.connect(poster, vi.fn(async () => [{ id: 'query_live', type: 'query' }]), vi.fn(), uri.toString());

		const mutation = orchestrator.configureQuerySection({
			openFileId: classifyWorkbenchUri(uri)!.openFileId,
			sectionId: 'query_live',
			query: 'print Live = true',
		});
		expect(poster).toHaveBeenCalledOnce();
		const request = poster.mock.calls[0][0] as any;
		orchestrator.handleWebviewResponse(request.requestId, { success: true });
		await expect(mutation).resolves.toEqual({ success: true });
	});

	it('transfers reveal-false ownership when the user activates the tab', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/background-user-activated.kqlx');
		await orchestrator.createFile({ fileType: 'kqlx', filePath: '/work/background-user-activated', reveal: false });
		await new Promise(resolve => setTimeout(resolve, 300));
		const otherTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(
			vscode.Uri.file('/work/other-user-activated.kqlx'), 'kusto.kqlxEditor',
		) };
		setTabGroups({ activeTab: otherTab, tabs: [otherTab], isActive: true });
		await orchestrator.handleTabsActivated([otherTab as any]);
		otherTab.isActive = false;
		const activeTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
		setTabGroups({ activeTab, tabs: [activeTab], isActive: true },
			{ activeTab: otherTab, tabs: [otherTab], isActive: false });
		const poster = createMessagePoster();
		orchestrator.connect(poster, vi.fn(async () => [{ id: 'query_live', type: 'query' }]), vi.fn(), uri.toString());
		await orchestrator.handleTabsActivated([activeTab as any]);

		const mutation = orchestrator.configureQuerySection({
			openFileId: classifyWorkbenchUri(uri)!.openFileId,
			sectionId: 'query_live',
			query: 'print Visible = true',
		});
		expect(poster).toHaveBeenCalledOnce();
		const request = poster.mock.calls[0][0] as any;
		orchestrator.handleWebviewResponse(request.requestId, { success: true });
		await expect(mutation).resolves.toEqual({ success: true });
	});

	it('does not transfer reveal-false ownership for an active tab in an inactive group', async () => {
		vi.useFakeTimers();
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/background-inactive-group.kqlx');
		await orchestrator.createFile({ fileType: 'kqlx', filePath: '/work/background-inactive-group', reveal: false });
		const visibleUri = vscode.Uri.file('/work/visible.kqlx');
		const visibleTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(visibleUri, 'kusto.kqlxEditor') };
		const hiddenTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
		setTabGroups(
			{ activeTab: visibleTab, tabs: [visibleTab], isActive: true },
			{ activeTab: hiddenTab, tabs: [hiddenTab], isActive: false },
		);
		await orchestrator.handleTabsActivated([hiddenTab as any]);

		expect((orchestrator as any).hostOwnedBackgroundFiles.has(classifyWorkbenchUri(uri)!.logicalUriKey)).toBe(true);
		await vi.advanceTimersByTimeAsync(250);
		expect(orchestrator.isHostOwnedBackgroundFile(uri)).toBe(true);
	});

	it('transfers reveal-false ownership when its already-selected editor group becomes active', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/background-group-activated.kqlx');
		await orchestrator.createFile({ fileType: 'kqlx', filePath: '/work/background-group-activated', reveal: false });
		await new Promise(resolve => setTimeout(resolve, 300));
		const tab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
		const group = { activeTab: tab, tabs: [tab], isActive: false };
		const otherTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(
			vscode.Uri.file('/work/active-before-group.kqlx'), 'kusto.kqlxEditor',
		) };
		const otherGroup = { activeTab: otherTab, tabs: [otherTab], isActive: true };
		setTabGroups(otherGroup, group);
		await orchestrator.handleTabsActivated([otherTab as any]);
		otherGroup.isActive = false;
		group.isActive = true;
		setTabGroups(group, otherGroup);
		const poster = createMessagePoster();
		orchestrator.connect(poster, vi.fn(async () => [{ id: 'query_live', type: 'query' }]), vi.fn(), uri.toString());

		await orchestrator.handleTabsActivated([tab as any]);
		const mutation = orchestrator.configureQuerySection({
			openFileId: classifyWorkbenchUri(uri)!.openFileId,
			sectionId: 'query_live',
			query: 'print GroupActive = true',
		});
		expect(poster).toHaveBeenCalledOnce();
		const request = poster.mock.calls[0][0] as any;
		orchestrator.handleWebviewResponse(request.requestId, { success: true });
		await expect(mutation).resolves.toEqual({ success: true });
	});

	it('retains reveal-false ownership until an activation after the opening lease', async () => {
		vi.useFakeTimers();
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/background-opening-lease.kqlx');
		await orchestrator.createFile({ fileType: 'kqlx', filePath: '/work/background-opening-lease', reveal: false });
		const tab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
		setTabGroups({ activeTab: tab, tabs: [tab], isActive: true });

		await orchestrator.handleTabsActivated([tab as any]);
		expect((orchestrator as any).hostOwnedBackgroundFiles.has(classifyWorkbenchUri(uri)!.logicalUriKey)).toBe(true);
		expect(orchestrator.isHostOwnedBackgroundFile(uri)).toBe(true);
		await vi.advanceTimersByTimeAsync(250);
		expect((orchestrator as any).hostOwnedBackgroundFiles.has(classifyWorkbenchUri(uri)!.logicalUriKey)).toBe(true);
		await orchestrator.handleTabsActivated([tab as any]);
		expect(orchestrator.isHostOwnedBackgroundFile(uri)).toBe(true);
		const otherTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(
			vscode.Uri.file('/work/after-opening-other.kqlx'), 'kusto.kqlxEditor',
		) };
		tab.isActive = false;
		setTabGroups({ activeTab: otherTab, tabs: [otherTab], isActive: true },
			{ activeTab: tab, tabs: [tab], isActive: false });
		await orchestrator.handleTabsActivated([otherTab as any]);
		otherTab.isActive = false;
		tab.isActive = true;
		setTabGroups({ activeTab: tab, tabs: [tab], isActive: true },
			{ activeTab: otherTab, tabs: [otherTab], isActive: false });
		await orchestrator.handleTabsActivated([tab as any]);
		expect((orchestrator as any).hostOwnedBackgroundFiles.has(classifyWorkbenchUri(uri)!.logicalUriKey)).toBe(false);
	});

	it('does not transfer reveal-false ownership for repeated programmatic tab activation', async () => {
		vi.useFakeTimers();
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/programmatic-active-report.kqlx');
		const tab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
		vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async command => {
			if (command === 'vscode.openWith') setTabGroups({ activeTab: tab, tabs: [tab], isActive: true });
		});
		await orchestrator.createFile({ fileType: 'kqlx', filePath: '/work/programmatic-active-report', reveal: false });
		await vi.advanceTimersByTimeAsync(250);
		await orchestrator.handleTabsActivated([tab as any]);
		await orchestrator.handleTabsActivated([tab as any]);
		expect(orchestrator.isHostOwnedBackgroundFile(uri)).toBe(true);

		const otherTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(
			vscode.Uri.file('/work/other-report.kqlx'), 'kusto.kqlxEditor',
		) };
		tab.isActive = false;
		setTabGroups({ activeTab: otherTab, tabs: [otherTab], isActive: true },
			{ activeTab: tab, tabs: [tab], isActive: false });
		await orchestrator.handleTabsActivated([otherTab as any]);
		otherTab.isActive = false;
		tab.isActive = true;
		setTabGroups({ activeTab: tab, tabs: [tab], isActive: true },
			{ activeTab: otherTab, tabs: [otherTab], isActive: false });
		await orchestrator.handleTabsActivated([tab as any]);
		expect(orchestrator.isHostOwnedBackgroundFile(uri)).toBe(false);
	});

	it('retains reveal-false ownership when VS Code selects the tab after opening returns', async () => {
		vi.useFakeTimers();
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/delayed-programmatic-selection.kqlx');
		await orchestrator.createFile({ fileType: 'kqlx', filePath: '/work/delayed-programmatic-selection', reveal: false });
		await vi.advanceTimersByTimeAsync(250);
		const tab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
		setTabGroups({ activeTab: tab, tabs: [tab], isActive: true });
		await orchestrator.handleTabsActivated([tab as any]);
		expect(orchestrator.isHostOwnedBackgroundFile(uri)).toBe(true);
	});

	it('fences background Save and tool edits on a same-tab user interaction', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/interactive-background.kqlx');
		const tab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
		vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async command => {
			if (command === 'vscode.openWith') setTabGroups({ activeTab: tab, tabs: [tab], isActive: true });
		});
		await orchestrator.createFile({ fileType: 'kqlx', filePath: '/work/interactive-background', reveal: false });
		const key = classifyWorkbenchUri(uri)!.logicalUriKey;
		const pendingEdit = deferred<void>();
		(orchestrator as any).backgroundFileOperations.set(key, pendingEdit.promise);
		try {
			const handoff = orchestrator.transferBackgroundOwnershipOnUserInteraction(uri);
			expect(orchestrator.isHostOwnedBackgroundFile(uri)).toBe(false);
			await expect(orchestrator.configureQuerySection({
				openFileId: classifyWorkbenchUri(uri)!.openFileId,
				sectionId: 'section_0', query: 'print Lost = true',
			})).rejects.toThrow('changing lifecycle state');
			expect((orchestrator as any).hostOwnedBackgroundFiles.has(key)).toBe(true);
			pendingEdit.resolve();
			await handoff;
			expect((orchestrator as any).hostOwnedBackgroundFiles.has(key)).toBe(false);
			await orchestrator.handleTabsActivated([tab as any]);
			expect(orchestrator.isHostOwnedBackgroundFile(uri)).toBe(false);
		} finally {
			pendingEdit.resolve();
		}
	});

	it('keeps background ownership when activation becomes stale while waiting for a file edit', async () => {
		vi.useFakeTimers();
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/background-stale-activation.kqlx');
		await orchestrator.createFile({ fileType: 'kqlx', filePath: '/work/background-stale-activation', reveal: false });
		const key = classifyWorkbenchUri(uri)!.logicalUriKey;
		const pendingEdit = deferred<void>();
		(orchestrator as any).backgroundFileOperations.set(key, pendingEdit.promise);
		const tab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
		setTabGroups({ activeTab: tab, tabs: [tab], isActive: true });
		try {
			await orchestrator.handleTabsActivated([tab as any]);
			await vi.advanceTimersByTimeAsync(250);
			const pendingActivation = orchestrator.handleTabsActivated([tab as any]);
			const other = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(
				vscode.Uri.file('/work/active-other.kqlx'), 'kusto.kqlxEditor',
			) };
			tab.isActive = false;
			setTabGroups({ activeTab: other, tabs: [other], isActive: true },
				{ activeTab: tab, tabs: [tab], isActive: false });
			pendingEdit.resolve();
			await pendingActivation;
			await vi.waitFor(() => expect((orchestrator as any).backgroundMutationBlocks.has(key)).toBe(false));
			expect(orchestrator.isHostOwnedBackgroundFile(uri)).toBe(true);
		} finally {
			pendingEdit.resolve();
		}
	});

	it('serializes host-owned mutation, save, and close without losing admitted bytes', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/background-serialized.kqlx');
		await orchestrator.createFile({ fileType: 'kqlx', filePath: '/work/background-serialized', reveal: false });
		let text = (vscode as any).__mockFileSystem.readText(uri);
		let dirty = false;
		const tab = { isActive: false, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
		setTabGroups({ activeTab: undefined, tabs: [], isActive: true }, { activeTab: tab, tabs: [tab], isActive: false });
		const save = vi.fn(async () => { dirty = false; return true; });
		const document = {
			uri,
			getText: () => text,
			positionAt: (offset: number) => new vscode.Position(0, offset),
			get isDirty() { return dirty; },
			save,
		};
		(vscode.workspace as any).textDocuments = [document];
		class TestWorkspaceEdit {
			replacement = '';
			replace(_uri: vscode.Uri, _range: vscode.Range, value: string) { this.replacement = value; }
		}
		(vscode as any).WorkspaceEdit = TestWorkspaceEdit;
		const firstApply = deferred<void>();
		const secondApply = deferred<void>();
		let applyCount = 0;
		const applyEdit = vi.fn(async (edit: TestWorkspaceEdit) => {
			applyCount++;
			await (applyCount === 1 ? firstApply.promise : secondApply.promise);
			text = edit.replacement;
			dirty = true;
			return true;
		});
		(vscode.workspace as any).applyEdit = applyEdit;
		const openFileId = classifyWorkbenchUri(uri)!.openFileId;

		const firstMutation = orchestrator.configureQuerySection({
			openFileId,
			sectionId: 'section_0',
			query: 'print Value = 2',
		});
		await vi.waitFor(() => expect(applyEdit).toHaveBeenCalledTimes(1));
		const saving = orchestrator.saveWorkbenchFile({ openFileId });
		await Promise.resolve();
		expect(save).not.toHaveBeenCalled();
		firstApply.resolve();
		await expect(firstMutation).resolves.toEqual({ success: true });
		await expect(saving).resolves.toMatchObject({ success: true, saved: true, wasDirty: true });
		expect(text).toContain('print Value = 2');

		const secondMutation = orchestrator.configureQuerySection({
			openFileId,
			sectionId: 'section_0',
			query: 'print Value = 3',
		});
		await vi.waitFor(() => expect(applyEdit).toHaveBeenCalledTimes(2));
		const closing = orchestrator.closeWorkbenchFile({ openFileId, saveChanges: true });
		await expect(orchestrator.configureQuerySection({
			openFileId,
			sectionId: 'section_0',
			query: 'print Value = 4',
		})).rejects.toThrow('changing lifecycle state');
		secondApply.resolve();
		await expect(secondMutation).resolves.toEqual({ success: true });
		await expect(closing).resolves.toMatchObject({ success: true, closed: true, saved: true, wasDirty: true });
		expect(text).toContain('print Value = 3');
		expect(text).not.toContain('print Value = 4');
		expect(save).toHaveBeenCalledTimes(2);
	});

	it('recovers after a failed background mutation and saves the next admitted edit', async () => {
		(vscode as any).__mockFileSystem.clear();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/background-recovery.kqlx');
		await orchestrator.createFile({ fileType: 'kqlx', filePath: '/work/background-recovery', reveal: false });
		let text = '{ invalid json';
		let dirty = false;
		const tab = { isActive: false, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
		setTabGroups({ activeTab: undefined, tabs: [], isActive: true }, { activeTab: tab, tabs: [tab], isActive: false });
		const save = vi.fn(async () => { dirty = false; return true; });
		const document = {
			uri,
			getText: () => text,
			positionAt: (offset: number) => new vscode.Position(0, offset),
			get isDirty() { return dirty; },
			save,
		};
		(vscode.workspace as any).textDocuments = [document];
		class TestWorkspaceEdit {
			replacement = '';
			replace(_uri: vscode.Uri, _range: vscode.Range, value: string) { this.replacement = value; }
		}
		(vscode as any).WorkspaceEdit = TestWorkspaceEdit;
		const applyEdit = vi.fn(async (edit: TestWorkspaceEdit) => {
			text = edit.replacement;
			dirty = true;
			return true;
		});
		(vscode.workspace as any).applyEdit = applyEdit;
		const openFileId = classifyWorkbenchUri(uri)!.openFileId;

		await expect(orchestrator.configureQuerySection({
			openFileId,
			sectionId: 'section_0',
			query: 'print Failed = true',
		})).rejects.toThrow('Invalid JSON');
		text = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{ type: 'query', query: 'print Value = 1' }] },
		});
		expect(await orchestrator.configureQuerySection({
			openFileId,
			sectionId: 'section_0',
			query: 'print Recovered = true',
		})).toEqual({ success: true });
		expect(await orchestrator.saveWorkbenchFile({ openFileId }))
			.toMatchObject({ success: true, saved: true, wasDirty: true });
		expect(text).toContain('print Recovered = true');
		expect(text).not.toContain('print Failed = true');
		expect(applyEdit).toHaveBeenCalledOnce();
		expect(save).toHaveBeenCalledOnce();
	});

	it('mutates and saves an exact inactive KQLX file without changing the active tab', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const activeUri = vscode.Uri.file('/work/active.kqlx');
		const targetUri = vscode.Uri.file('/work/background.kqlx');
		const activeTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(activeUri, 'kusto.kqlxEditor') };
		const targetTab = { isActive: false, isDirty: false, input: new vscode.TabInputCustom(targetUri, 'kusto.kqlxEditor') };
		setTabGroups(
			{ activeTab, tabs: [activeTab], isActive: true },
			{ activeTab: targetTab, tabs: [targetTab], isActive: false },
		);
		let text = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{ type: 'query', expanded: true, query: '' }] },
		}, null, 2);
		let dirty = false;
		const document = {
			uri: targetUri,
			getText: () => text,
			positionAt: (offset: number) => new vscode.Position(0, offset),
			get isDirty() { return dirty; },
			save: vi.fn(async () => { dirty = false; return true; }),
		};
		(vscode.workspace as any).textDocuments = [document];
		class TestWorkspaceEdit {
			replacement = '';
			replace(_uri: vscode.Uri, _range: vscode.Range, value: string) { this.replacement = value; }
		}
		(vscode as any).WorkspaceEdit = TestWorkspaceEdit;
		const applyEdit = vi.fn(async (edit: TestWorkspaceEdit) => {
			text = edit.replacement;
			dirty = true;
			return true;
		});
		(vscode.workspace as any).applyEdit = applyEdit;

		const listed = await orchestrator.listSections();
		const target = listed.openFiles?.find(file => file.openFileId === classifyWorkbenchUri(targetUri)!.openFileId);
		expect(target?.sections).toEqual([expect.objectContaining({ id: 'section_0', type: 'query' })]);
		expect(await orchestrator.configureQuerySection({
			openFileId: target!.openFileId,
			sectionId: 'section_0',
			name: 'Background query',
			query: 'print Value = 1',
			execute: false,
		})).toEqual({ success: true });
		const configuredQueryText = text;
		expect(await orchestrator.configureQuerySection({
			openFileId: target!.openFileId,
			sectionId: 'section_0',
			name: 'Background query',
			query: 'print Value = 1',
			execute: false,
		})).toEqual({ success: true });
		expect(text).toBe(configuredQueryText);
		expect(applyEdit).toHaveBeenCalledOnce();
		const markdown = await orchestrator.addSection({
			openFileId: target!.openFileId,
			type: 'markdown',
			name: 'Summary',
			text: '# Background report',
		});
		const chart = await orchestrator.addSection({
			openFileId: target!.openFileId,
			type: 'chart',
			name: 'Values',
			dataSourceId: 'section_0',
			chartType: 'bar',
		});
		expect(await orchestrator.updateMarkdownSection({
			openFileId: target!.openFileId,
			sectionId: markdown.sectionId,
			text: '# Saved background report',
			mode: 'preview',
		})).toEqual({ success: true });
		const updatedMarkdownText = text;
		expect(await orchestrator.updateMarkdownSection({
			openFileId: target!.openFileId,
			sectionId: markdown.sectionId,
			text: '# Saved background report',
			mode: 'preview',
		})).toEqual({ success: true });
		expect(text).toBe(updatedMarkdownText);
		expect(await orchestrator.configureChart({
			openFileId: target!.openFileId,
			sectionId: chart.sectionId,
			dataSourceId: 'section_0',
			chartType: 'bar',
			xColumn: 'Category',
			yColumns: ['Value'],
		})).toEqual({ success: true });
		const configuredChartText = text;
		expect(await orchestrator.configureChart({
			openFileId: target!.openFileId,
			sectionId: chart.sectionId,
			dataSourceId: 'section_0',
			chartType: 'bar',
			xColumn: 'Category',
			yColumns: ['Value'],
		})).toEqual({ success: true });
		expect(text).toBe(configuredChartText);
		expect(await orchestrator.saveWorkbenchFile({ openFileId: target!.openFileId }))
			.toMatchObject({ success: true, saved: true, wasDirty: true });

		const persisted = JSON.parse(text);
		expect(persisted.state.sections).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: 'section_0', type: 'query', name: 'Background query', query: 'print Value = 1' }),
			expect.objectContaining({ id: markdown.sectionId, type: 'markdown', text: '# Saved background report' }),
			expect.objectContaining({ id: chart.sectionId, type: 'chart', xColumn: 'Category', yColumns: ['Value'] }),
		]));
		expect(document.save).toHaveBeenCalledOnce();
		expect(applyEdit).toHaveBeenCalledTimes(5);
		expect((vscode.window.tabGroups.all[0] as any).activeTab).toBe(activeTab);
	});

	it('rejects an incompatible inactive-file section without changing SQLX bytes', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const activeUri = vscode.Uri.file('/work/active.kqlx');
		const targetUri = vscode.Uri.file('/work/background.sqlx');
		const activeTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(activeUri, 'kusto.kqlxEditor') };
		const targetTab = { isActive: false, isDirty: false, input: new vscode.TabInputCustom(targetUri, 'kusto.kqlxEditor') };
		setTabGroups(
			{ activeTab, tabs: [activeTab], isActive: true },
			{ activeTab: targetTab, tabs: [targetTab], isActive: false },
		);
		const originalText = JSON.stringify({
			kind: 'sqlx', version: 1, state: { sections: [{ id: 'sql_1', type: 'sql', expanded: true, query: 'select 1' }] },
		}, null, 2);
		const document = {
			uri: targetUri,
			getText: () => originalText,
			positionAt: (offset: number) => new vscode.Position(0, offset),
			isDirty: false,
		};
		(vscode.workspace as any).textDocuments = [document];
		class TestWorkspaceEdit {
			replace() { throw new Error('Rejected background mutation must not create an edit.'); }
		}
		(vscode as any).WorkspaceEdit = TestWorkspaceEdit;
		const applyEdit = vi.fn();
		(vscode.workspace as any).applyEdit = applyEdit;

		const listed = await orchestrator.listSections();
		const target = listed.openFiles?.find(file => file.openFileId === classifyWorkbenchUri(targetUri)!.openFileId);
		const result = await orchestrator.addSection({
			openFileId: target!.openFileId,
			type: 'query',
			query: 'print Value = 1',
		});

		expect(result).toEqual({
			sectionId: '',
			success: false,
			error: 'Section type "query" is not supported in .sqlx files.',
		});
		expect(document.getText()).toBe(originalText);
		expect(applyEdit).not.toHaveBeenCalled();
	});

	it('reconnects an evicted live bridge and returns a 3-row by 4-column askKustoCopilot result', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/reactivated-result.kqlx');
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const postMessage = createMessagePoster();
		const handler = new HostWorkbenchToolSessionApplicationHandler({
			getOrchestrator: () => orch,
			postMessage,
			isAvailable: () => true,
			getDocumentUri: () => uri.toString(),
			connectionManager: fakeConnectionManager,
			schema: { refreshSchemaForTools: vi.fn(async () => ({ schemas: [] })) } as any,
			sqlLifecycle: {
				getConnectionId: vi.fn(), getFirstConnectionId: vi.fn(),
				getReadyToolOwner: vi.fn(), reconcileComparisonOwners: vi.fn(),
				getSectionInstanceId: vi.fn(), getGeneration: vi.fn(() => 0),
			} as any,
		});
		handler.activate();
		expect(orch.evictActiveConnectionForTest()).toBe(true);
		handler.activate();
		const columns = [
			{ name: 'Timestamp', type: 'datetime' },
			{ name: 'Category', type: 'string' },
			{ name: 'Count', type: 'long' },
			{ name: 'Ratio', type: 'real' },
		];
		const results = [
			['2026-09-10T00:00:00Z', 'alpha', 10, 0.5],
			['2026-09-11T00:00:00Z', 'beta', 20, 0.75],
			['2026-09-12T00:00:00Z', 'gamma', 30, 1],
		];

		const pending = orch.delegateToKustoWorkbenchCopilot({ question: 'Return the 3 by 4 result.' });
		const request = postMessage.mock.calls.find(([message]) =>
			(message as any)?.type === 'toolDelegateToKustoWorkbenchCopilot')?.[0] as any;
		expect(request).toBeTruthy();
		orch.handleWebviewResponse(request.requestId, {
			success: true,
			query: 'datatable(Timestamp:datetime, Category:string, Count:long, Ratio:real)[]',
			rowCount: 3,
			columns,
			results,
			maxResultRows: 100,
			returnedRowCount: 3,
			resultSets: [{
				resultIndex: 0, rowCount: 3, columns, results,
				returnedRowCount: 3, truncated: false,
			}],
		});

		await expect(pending).resolves.toMatchObject({
			success: true, rowCount: 3, columns, results, returnedRowCount: 3,
		});
		handler.dispose();
	});

	it.each(['active', 'uri', 'id'] as const)('reports an unavailable note snapshot as a failure for %s targeting', async targeting => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/activation-canary.kqlx');
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const stateGetter = vi.fn(async () => undefined);
		orchestrator.connect(createMessagePoster(), stateGetter, vi.fn(), uri.toString());
		const target = targeting === 'uri' ? { targetFileUri: uri.toString() }
			: targeting === 'id' ? { openFileId: classifyWorkbenchUri(uri)!.openFileId } : {};
		const result = await orchestrator.manageDevelopmentNotes({ action: 'view', ...target });
		expect(result).toEqual({ success: false, error: expect.stringMatching(/\S/) });
		expect(result).not.toHaveProperty('notes');
		expect(stateGetter).toHaveBeenCalledOnce();
	});

	it('correlates native metadata and one pending snapshot through held activation without extra operations', async () => {
		vi.useFakeTimers();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const uri = vscode.Uri.file('/work/private-opening-log.kqlx'), unrelated = vscode.Uri.file('/work/unrelated.kqlx');
		const info = classifyWorkbenchUri(uri)!;
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const lifecycle = deferred<void>(), native = deferred<unknown>(), recovery = deferred<boolean>();
		const stateGetter = vi.fn(async () => []), poster = createMessagePoster();
		const reactivate = vi.fn(() => recovery.promise);
		orchestrator.connect(poster, stateGetter, vi.fn(), uri.toString(), undefined, undefined, undefined, undefined, reactivate);
		Reflect.get(orchestrator, 'hostOwnedBackgroundFiles').set(info.logicalUriKey, undefined);
		Reflect.get(orchestrator, 'backgroundFileOperations').set(info.logicalUriKey, lifecycle.promise);
		const release = vi.spyOn(orchestrator as any, 'removeBackgroundMutationBlock');
		const open = vi.spyOn(vscode.commands, 'executeCommand').mockReturnValue(native.promise as any);
		const publicState = vi.spyOn(orchestrator, 'listSections');
		const readFile = vi.spyOn(vscode.workspace.fs, 'readFile'), writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile');
		const openDocument = vi.spyOn(vscode.workspace, 'openTextDocument'), closeTab = vi.spyOn(vscode.window.tabGroups, 'close');
		const subscriptions: Array<{ dispose(): void }> = [];
		registerWorkbenchLogger({ subscriptions } as any);
		subscriptions[0].dispose();
		const output = vi.fn(), channel = { logLevel: 1, trace: output, dispose: vi.fn() };
		const createChannel = vi.spyOn(vscode.window, 'createOutputChannel').mockReturnValue(channel as any);
		const levelDescriptor = Object.getOwnPropertyDescriptor(vscode, 'LogLevel');
		const closeDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'onDidCloseTextDocument');
		Object.defineProperty(vscode, 'LogLevel', { configurable: true, value: { Trace: 1, Info: 3 } });
		let onOpen!: (document: vscode.TextDocument) => void, onClose!: (document: vscode.TextDocument) => void;
		let onTabs!: (event: vscode.TabChangeEvent) => void;
		const disposals = [vi.fn(), vi.fn(), vi.fn()];
		vi.spyOn(vscode.workspace, 'onDidOpenTextDocument').mockImplementation(listener => {
			onOpen = listener; return { dispose: disposals[0] };
		});
		Object.defineProperty(vscode.workspace, 'onDidCloseTextDocument', { configurable: true, value: vi.fn((listener: typeof onClose) => {
			onClose = listener; return { dispose: disposals[1] };
		}) });
		vi.spyOn(vscode.window.tabGroups, 'onDidChangeTabs').mockImplementation(listener => {
			onTabs = listener; return { dispose: disposals[2] };
		});
		const records = () => output.mock.calls.map(([line]) => {
			const match = /^\[file-open:(\d+)\] \+\d+ms activate\.([\w.]+)(?: (.*))?$/.exec(line)!;
			return { id: Number(match[1]), event: match[2], ...JSON.parse(match[3] || '{}') };
		});
		let settled = false;
		const activation = orchestrator.activateWorkbenchFile({ targetFileUri: uri.toString() });
		void activation.then(() => { settled = true; });
		try {
			expect(createChannel).toHaveBeenCalledExactlyOnceWith('Kusto Workbench', { log: true });
			const correlation = { id: records()[0].id, uriHash: createHash('sha256').update(info.logicalUriKey).digest('hex') };
			expect(records()[0]).toEqual({ ...correlation, event: 'start' });
			expect(records()).toContainEqual({ ...correlation, event: 'observe.start', phase: 'lifecycle',
				backgroundOwnerMember: true, backgroundOperationMember: true, mutationBlockCount: 0,
				document: { present: false }, tabs: { count: 1, active: true, custom: true } });
			onTabs({ opened: [], closed: [], changed: [vscode.window.tabGroups.activeTabGroup.activeTab!] });
			expect(records().at(-1)).toMatchObject({ ...correlation, event: 'observe.tabsChanged', phase: 'lifecycle', mutationBlockCount: 1 });
			expect(open).not.toHaveBeenCalled();
			lifecycle.resolve();
			await vi.advanceTimersByTimeAsync(0);
			expect(open).toHaveBeenCalledExactlyOnceWith('vscode.openWith', uri, 'kusto.kqlxEditor', {
				viewColumn: vscode.ViewColumn.Active, preserveFocus: false,
			});
			const document = { uri, version: 4, isDirty: true, isClosed: false, getText: vi.fn(() => 'private content') };
			(vscode.workspace as any).textDocuments = [document];
			const beforeUnrelated = output.mock.calls.length;
			onOpen({ ...document, uri: unrelated } as any);
			onClose({ ...document, uri: unrelated } as any);
			onTabs({ opened: [{ input: new vscode.TabInputCustom(unrelated, 'kusto.kqlxEditor') } as any], changed: [], closed: [] });
			expect(output).toHaveBeenCalledTimes(beforeUnrelated);
			onOpen(document as any);
			expect(records().at(-1)).toMatchObject({ ...correlation, event: 'observe.documentOpen', phase: 'openWith',
				document: { present: true, version: 4, isDirty: true, isClosed: false } });
			await vi.advanceTimersByTimeAsync(4999);
			expect(records().filter(record => record.event === 'observe.pending')).toEqual([]);
			await vi.advanceTimersByTimeAsync(1);
			expect(records().filter(record => record.event === 'observe.pending')).toEqual([
				{ ...correlation, event: 'observe.pending', phase: 'openWith', backgroundOwnerMember: true,
					backgroundOperationMember: true, mutationBlockCount: 1,
					document: { present: true, version: 4, isDirty: true, isClosed: false }, tabs: { count: 1, active: true, custom: true } },
			]);
			await vi.advanceTimersByTimeAsync(5000);
			expect(records().filter(record => record.event === 'observe.pending')).toHaveLength(1);
			expect(settled).toBe(false); expect(reactivate).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
			for (const untouched of [publicState, stateGetter, poster, readFile, writeFile, openDocument, closeTab, document.getText]) {
				expect(untouched).not.toHaveBeenCalled();
			}
			expect(open).toHaveBeenCalledOnce();
			native.resolve({ ignoredNativeResult: true });
			await vi.advanceTimersByTimeAsync(0);
			expect(reactivate).toHaveBeenCalledOnce(); expect(settled).toBe(false);
			document.isClosed = true;
			(vscode.workspace as any).textDocuments = [];
			onClose(document as any);
			expect(records().at(-1)).toMatchObject({ ...correlation, event: 'observe.documentClose', phase: 'recovery',
				document: { present: false, version: 4, isDirty: true, isClosed: true } });
			recovery.resolve(true);
			await expect(activation).resolves.toEqual({ success: true, openFileId: info.openFileId, uri: info.uriString,
				logicalUri: info.logicalUriString, fileKind: info.fileKind, filePath: info.filePath, fileName: info.fileName,
				isLiveWorkbench: true, isReadOnlyFallback: false });
			expect(release).toHaveBeenCalledExactlyOnceWith(info.logicalUriKey);
			expect(records().at(-1)).toMatchObject({ ...correlation, event: 'observe.stop', phase: 'release', mutationBlockCount: 0, suppressed: 0 });
			for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
			const finalCount = output.mock.calls.length;
			onOpen(document as any); onClose(document as any); onTabs({ opened: [], closed: [], changed: [] });
			await vi.advanceTimersByTimeAsync(5000);
			expect(output).toHaveBeenCalledTimes(finalCount);
			for (const record of records().filter(record => record.event.startsWith('observe.'))) expect(record).toMatchObject(correlation);
			for (const privateValue of [uri.toString(), uri.fsPath, info.fileName!, unrelated.toString(), 'private content']) {
				expect(JSON.stringify(output.mock.calls)).not.toContain(privateValue);
			}
		} finally {
			lifecycle.resolve(); native.resolve(undefined); recovery.resolve(true);
			await activation;
			subscriptions[0].dispose();
			if (levelDescriptor) Object.defineProperty(vscode, 'LogLevel', levelDescriptor);
			else Reflect.deleteProperty(vscode, 'LogLevel');
			if (closeDescriptor) Object.defineProperty(vscode.workspace, 'onDidCloseTextDocument', closeDescriptor);
			else Reflect.deleteProperty(vscode.workspace, 'onDidCloseTextDocument');
		}
	});

	it.each(['lifecycle', 'openWith', 'recovery', 'release', 'registration'])(
		'preserves activation results and lease cleanup with Trace diagnostics (%s)', async phase => {
			vi.useFakeTimers();
			const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
			const uri = vscode.Uri.file('/work/private-failure-log.kqlx'), info = classifyWorkbenchUri(uri)!;
			setActiveCustomTab(uri, 'kusto.kqlxEditor');
			const failure = new Error('Original activation failure'), diagnosticFailure = new Error('Private diagnostic failure');
			const release = vi.fn(() => { if (phase === 'release') throw failure; });
			vi.spyOn(orchestrator as any, 'acquireHostOwnedBackgroundLifecycle').mockImplementation(async () => {
				if (phase === 'lifecycle') throw failure;
				return release;
			});
			const open = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async () => {
				if (phase === 'openWith') throw failure;
			});
			const stateGetter = vi.fn(async () => []), poster = createMessagePoster();
			orchestrator.connect(poster, stateGetter, vi.fn(), uri.toString(), undefined, undefined, undefined, undefined, async () => {
				if (phase === 'recovery') throw failure;
				return true;
			});
			const state = vi.spyOn(Reflect.get(orchestrator, 'backgroundFileOperations') as Map<string, Promise<void>>, 'has');
			if (phase === 'recovery') state.mockImplementation(() => { throw diagnosticFailure; });
			const subscriptions: Array<{ dispose(): void }> = [];
			registerWorkbenchLogger({ subscriptions } as any);
			subscriptions[0].dispose();
			const output = vi.fn(() => { if (phase === 'openWith') throw diagnosticFailure; });
			vi.spyOn(vscode.window, 'createOutputChannel').mockReturnValue({ logLevel: 1, trace: output, dispose: vi.fn() } as any);
			const levelDescriptor = Object.getOwnPropertyDescriptor(vscode, 'LogLevel');
			const closeDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'onDidCloseTextDocument');
			Object.defineProperty(vscode, 'LogLevel', { configurable: true, value: { Trace: 1 } });
			const callbacks: Array<(event: any) => void> = [], disposals = [vi.fn(), vi.fn(), vi.fn()];
			if (phase === 'release') disposals[0].mockImplementation(() => { throw diagnosticFailure; });
			vi.spyOn(vscode.workspace, 'onDidOpenTextDocument').mockImplementation(listener => {
				callbacks[0] = listener; return { dispose: disposals[0] };
			});
			Object.defineProperty(vscode.workspace, 'onDidCloseTextDocument', { configurable: true, value: (listener: (event: any) => void) => {
				callbacks[1] = listener;
				if (phase === 'registration') throw diagnosticFailure;
				return { dispose: disposals[1] };
			} });
			vi.spyOn(vscode.window.tabGroups, 'onDidChangeTabs').mockImplementation(listener => {
				callbacks[2] = listener; return { dispose: disposals[2] };
			});
			try {
				const activation = orchestrator.activateWorkbenchFile({ targetFileUri: uri.toString() });
				if (phase === 'release') await expect(activation).rejects.toBe(failure);
				else await expect(activation).resolves.toEqual({
					success: phase === 'registration', openFileId: info.openFileId, uri: info.uriString, logicalUri: info.logicalUriString,
					fileKind: info.fileKind, filePath: info.filePath, fileName: info.fileName,
					...(phase === 'registration' ? { isLiveWorkbench: true, isReadOnlyFallback: false } : { error: failure.message }),
					...(phase === 'recovery' ? { isLiveWorkbench: false, isReadOnlyFallback: false } : {}),
				});
				expect(open).toHaveBeenCalledTimes(phase === 'lifecycle' ? 0 : 1);
				if (phase !== 'lifecycle') expect(open).toHaveBeenCalledWith('vscode.openWith', uri, 'kusto.kqlxEditor', {
					viewColumn: vscode.ViewColumn.Active, preserveFocus: false,
				});
				expect(release).toHaveBeenCalledTimes(phase === 'lifecycle' ? 0 : 1);
				for (const [index, dispose] of disposals.entries()) expect(dispose).toHaveBeenCalledTimes(phase === 'registration' && index > 0 ? 0 : 1);
				expect(vi.getTimerCount()).toBe(0); expect(stateGetter).not.toHaveBeenCalled(); expect(poster).not.toHaveBeenCalled();
				const lines = output.mock.calls.length, reads = state.mock.calls.length;
				for (const callback of callbacks) callback({ uri, opened: [], closed: [], changed: [] });
				await vi.advanceTimersByTimeAsync(5000);
				expect(output).toHaveBeenCalledTimes(lines); expect(state).toHaveBeenCalledTimes(reads);
				const logs = JSON.stringify(output.mock.calls);
				expect(logs.match(/activate\.observe\.stop/g)).toHaveLength(1);
				if (phase === 'recovery') expect(logs).toContain('unavailable');
				for (const privateValue of [uri.toString(), uri.fsPath, info.fileName!, failure.message, diagnosticFailure.message]) {
					expect(logs).not.toContain(privateValue);
				}
			} finally {
				subscriptions[0].dispose();
				if (levelDescriptor) Object.defineProperty(vscode, 'LogLevel', levelDescriptor);
				else Reflect.deleteProperty(vscode, 'LogLevel');
				if (closeDescriptor) Object.defineProperty(vscode.workspace, 'onDidCloseTextDocument', closeDescriptor);
				else Reflect.deleteProperty(vscode.workspace, 'onDidCloseTextDocument');
			}
		},
	);

	it('logs each activation wait before entering it without changing the native call or result', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const uri = vscode.Uri.file('/work/opening-log.kqlx');
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const events: Array<{ event: string; detail?: unknown }> = [];
		const createTrace = vi.spyOn(fileOpenTracing, 'createFileOpenTrace').mockImplementation((label, detail) => {
			events.push({ event: 'start', detail });
			return { id: 1, label, mark: (event, metadata) => { events.push({ event, detail: metadata }); } };
		});
		const lease = deferred<() => void>(), native = deferred<unknown>(), recovery = deferred<boolean>();
		const release = vi.fn();
		const acquire = vi.spyOn(orchestrator as any, 'acquireHostOwnedBackgroundLifecycle').mockReturnValue(lease.promise);
		const open = vi.spyOn(vscode.commands, 'executeCommand').mockReturnValue(native.promise as any);
		const reactivate = vi.fn(() => recovery.promise);
		orchestrator.connect(createMessagePoster(), async () => [], vi.fn(), uri.toString(), undefined, undefined, undefined, undefined, reactivate);
		const activation = orchestrator.activateWorkbenchFile({ targetFileUri: uri.toString() });
		expect(createTrace).toHaveBeenCalledOnce();
		expect(events).toEqual([
			{ event: 'start', detail: { uriHash: createHash('sha256').update(classifyWorkbenchUri(uri)!.logicalUriKey).digest('hex') } },
			{ event: 'lifecycle.start', detail: undefined },
		]);
		expect(acquire).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled();
		lease.resolve(release);
		await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
		expect(events.map(entry => entry.event)).toEqual(['start', 'lifecycle.start', 'lifecycle.done', 'openWith.start']);
		expect(open).toHaveBeenCalledWith('vscode.openWith', uri, 'kusto.kqlxEditor', { viewColumn: vscode.ViewColumn.Active, preserveFocus: false });
		expect(reactivate).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
		native.resolve(undefined);
		await vi.waitFor(() => expect(reactivate).toHaveBeenCalledOnce());
		expect(events.at(-1)).toEqual({ event: 'recovery.start', detail: { callback: true } });
		recovery.resolve(true);
		await expect(activation).resolves.toMatchObject({ success: true, isLiveWorkbench: true, isReadOnlyFallback: false, uri: uri.toString() });
		expect(events.slice(-2)).toEqual([
			{ event: 'recovery.done', detail: { ready: true, current: true } },
			{ event: 'result', detail: { success: true, live: true } },
		]);
		expect(release).toHaveBeenCalledOnce();
		expect(JSON.stringify(events)).not.toContain(uri.toString());
	});

	it.each(['lifecycle', 'openWith', 'recovery', 'unready', 'retired', 'fallback', 'snapshot'])(
		'logs activation outcomes without changing failure or release semantics (%s)', async phase => {
			const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
			const uri = vscode.Uri.file('/work/opening-outcome.kqlx');
			setActiveCustomTab(uri, 'kusto.kqlxEditor');
			const events: Array<{ event: string; detail?: unknown }> = [];
			vi.spyOn(fileOpenTracing, 'createFileOpenTrace').mockImplementation(label => ({ id: 1, label,
				mark: (event, detail) => { events.push({ event, detail }); },
			}));
			const failure = new Error('Original operation failed'), release = vi.fn();
			vi.spyOn(orchestrator as any, 'acquireHostOwnedBackgroundLifecycle').mockImplementation(async () => {
				if (phase === 'lifecycle') throw failure;
				return release;
			});
			vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async () => {
				if (phase === 'openWith') throw failure;
			});
			let token: number | undefined;
			if (phase !== 'fallback') token = orchestrator.connect(createMessagePoster(), async () => [], vi.fn(), uri.toString(),
				undefined, undefined, undefined, undefined, phase === 'snapshot' ? undefined : async () => {
					if (phase === 'recovery') throw failure;
					if (phase === 'retired') orchestrator.disconnectIfOwner(token!);
					return phase !== 'unready';
				});
			const result = await orchestrator.activateWorkbenchFile({ targetFileUri: uri.toString() });
			const failed = ['lifecycle', 'openWith', 'recovery', 'unready', 'retired'].includes(phase);
			expect(result.success).toBe(!failed);
			expect(release).toHaveBeenCalledTimes(phase === 'lifecycle' ? 0 : 1);
			if (['lifecycle', 'openWith', 'recovery'].includes(phase)) {
				expect(result.error).toBe(failure.message);
				expect(events).toContainEqual({ event: `${phase}.failed`, detail: undefined });
			} else {
				expect(events.at(-1)).toEqual({ event: 'result', detail: { success: !failed, live: !failed && phase !== 'fallback' } });
			}
			if (phase === 'snapshot') expect(events).toContainEqual({ event: 'recovery.start', detail: { callback: false } });
			if (phase === 'fallback') expect(events.some(entry => entry.event.startsWith('recovery.'))).toBe(false);
			if (phase === 'retired') expect(events).toContainEqual({ event: 'recovery.done', detail: { ready: true, current: false } });
			expect(JSON.stringify(events)).not.toContain(failure.message);
		},
	);

	it('records the provider URI hash before watcher setup without changing setup failure', async () => {
		const uri = vscode.Uri.file('/work/opening-provider.kqlx');
		const failure = new Error('Watcher setup failed');
		const createTrace = vi.spyOn(fileOpenTracing, 'createFileOpenTrace').mockReturnValue({ id: 1, label: 'kqlx', mark: vi.fn() });
		const descriptor = Object.getOwnPropertyDescriptor(vscode.workspace.fs, 'isWritableFileSystem');
		Object.defineProperty(vscode.workspace.fs, 'isWritableFileSystem', { configurable: true, value: () => { throw failure; } });
		try {
			await expect(kqlxEditor.KqlxEditorProvider.prototype.resolveCustomTextEditor.call({} as any,
				{ uri } as any, { visible: true, active: false } as any, {} as any)).rejects.toBe(failure);
			expect(createTrace).toHaveBeenCalledWith('kqlx', {
				documentKind: 'kqlx', uriHash: createHash('sha256').update(classifyWorkbenchUri(uri)!.logicalUriKey).digest('hex'), visible: true, active: false,
			});
		} finally {
			if (descriptor) Object.defineProperty(vscode.workspace.fs, 'isWritableFileSystem', descriptor);
			else Reflect.deleteProperty(vscode.workspace.fs, 'isWritableFileSystem');
		}
	});

	it.each([true, false])('requires an authoritative snapshot for callback-free activation (available=%s)', async available => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/callback-free-activation.kqlx');
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const stateGetter = vi.fn(async () => available ? [] : undefined);
		orchestrator.connect(createMessagePoster(), stateGetter, vi.fn(), uri.toString());
		const result = await orchestrator.activateWorkbenchFile({ targetFileUri: uri.toString() });
		expect(stateGetter).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ success: available, isLiveWorkbench: available, isReadOnlyFallback: false });
		if (!available) expect(result.error).toMatch(/\S/);
	});

	it.each([true, false])('awaits exact-panel activation recovery before reporting a live target (ready=%s)', async ready => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/activation-canary.kqlx');
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const recovery = deferred<boolean>();
		const reactivate = vi.fn(() => recovery.promise);
		(orchestrator.connect as any)(createMessagePoster(), vi.fn(async () => []), vi.fn(), uri.toString(),
			undefined, undefined, undefined, undefined, reactivate);
		let settled = false;
		const activation = orchestrator.activateWorkbenchFile({ targetFileUri: uri.toString() });
		void activation.then(() => { settled = true; });
		await vi.waitFor(() => expect(reactivate).toHaveBeenCalledOnce());
		expect(settled).toBe(false);
		recovery.resolve(ready);
		if (ready) {
			await expect(activation).resolves.toMatchObject({ success: true, isLiveWorkbench: true, uri: uri.toString() });
		} else {
			await expect(activation).resolves.toMatchObject({
				success: false, isLiveWorkbench: false, uri: uri.toString(), error: expect.stringMatching(/\S/),
			});
		}
	});

	it.each([new Error(''), new Error('   '), '', '   '])('never reports successful activation for an empty recovery rejection', async rejection => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/activation-canary.kqlx');
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		orchestrator.connect(createMessagePoster(), vi.fn(async () => { throw rejection; }), vi.fn(), uri.toString(),
			undefined, undefined, undefined, undefined, async () => { throw rejection; });
		await expect(orchestrator.activateWorkbenchFile({ targetFileUri: uri.toString() })).resolves.toMatchObject({
			success: false, isLiveWorkbench: false, error: expect.stringMatching(/\S/),
		});
		await expect(orchestrator.manageDevelopmentNotes({ action: 'view', targetFileUri: uri.toString() })).resolves.toEqual({
			success: false, error: expect.stringMatching(/\S/),
		});
	});

	it('rejects exact-panel activation recovery if its connection retires during the wait', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/activation-canary.kqlx');
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const recovery = deferred<boolean>();
		const reactivate = vi.fn(() => recovery.promise);
		const token = (orchestrator.connect as any)(createMessagePoster(), vi.fn(async () => []), vi.fn(), uri.toString(),
			undefined, undefined, undefined, undefined, reactivate);
		const activation = orchestrator.activateWorkbenchFile({ openFileId: classifyWorkbenchUri(uri)!.openFileId });
		await vi.waitFor(() => expect(reactivate).toHaveBeenCalledOnce());
		orchestrator.disconnectIfOwner(token);
		recovery.resolve(true);
		await expect(activation).resolves.toMatchObject({ success: false, isLiveWorkbench: false });
	});

	it('reports a rejected note snapshot without turning it into an empty successful result', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/activation-canary.kqlx');
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		orchestrator.connect(createMessagePoster(), vi.fn(async () => {
			throw new Error('The editor snapshot is unavailable.');
		}), vi.fn(), uri.toString());
		await expect(orchestrator.manageDevelopmentNotes({ action: 'view', targetFileUri: uri.toString() }))
			.resolves.toEqual({ success: false, error: 'The editor snapshot is unavailable.' });
	});

	it('rejects a note snapshot from a connection retired while its read was pending', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/activation-canary.kqlx');
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const snapshot = deferred<unknown[]>();
		const token = orchestrator.connect(createMessagePoster(), () => snapshot.promise as any, vi.fn(), uri.toString());
		const result = orchestrator.manageDevelopmentNotes({ action: 'view', targetFileUri: uri.toString() });
		orchestrator.disconnectIfOwner(token);
		snapshot.resolve([]);
		await expect(result).resolves.toEqual({ success: false, error: expect.stringMatching(/\S/) });
	});

	it('distinguishes authoritative empty notes from unavailable reads and preserves a later canary snapshot', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/activation-canary.kqlx');
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const note = {
			id: 'canary_note', created: '2026-10-07T00:00:00.000Z', updated: '2026-10-07T00:00:00.000Z',
			category: 'usage-note', content: 'The saved canary note remains readable.', source: 'agent',
			relatedSectionIds: ['canary_query'],
		};
		const getter = vi.fn()
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				...Array.from({ length: 9 }, (_, index) => ({ id: `query_${index}`, type: 'query' })),
				{ id: 'canary_notes', type: 'devnotes', entries: [note] },
			]);
		orchestrator.connect(createMessagePoster(), getter, vi.fn(), uri.toString());
		const input = { action: 'view' as const, targetFileUri: uri.toString() };
		await expect(orchestrator.manageDevelopmentNotes(input)).resolves.toMatchObject({ success: false });
		await expect(orchestrator.manageDevelopmentNotes(input)).resolves.toEqual({ success: true, notes: [] });
		await expect(orchestrator.manageDevelopmentNotes(input)).resolves.toEqual({ success: true, notes: [note] });
	});

	it('keeps the agent development-note waiter live until an exact canonical response arrives', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/development-notes.kqlx');
		const poster = createMessagePoster();
		orch.connect(poster, vi.fn(async () => []), vi.fn(), uri.toString());
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		let settled = false;

		const pending = orch.manageDevelopmentNotes({
			action: 'add',
			category: 'usage-note',
			content: 'Agent exact note',
			relatedSectionIds: ['query_exact'],
		});
		void pending.then(() => { settled = true; });
		const request = poster.mock.calls[0][0] as any;

		expect(request).toEqual({
			type: 'updateDevNotes',
			requestId: 'tool_1_1786665600000',
			action: 'add',
			entry: {
				id: 'dn_1786665600000_i',
				created: '2026-08-14T00:00:00.000Z',
				updated: '2026-08-14T00:00:00.000Z',
				category: 'usage-note',
				content: 'Agent exact note',
				source: 'agent',
				relatedSectionIds: ['query_exact'],
			},
		});
		expect(vi.getTimerCount()).toBe(1);

		const malformed = {
			type: 'toolResponse', requestId: request.requestId, result: { success: 'yes' },
		};
		expect(orch.handleDevelopmentNoteMutationResponse(malformed)).toBe(true);
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(vi.getTimerCount()).toBe(1);
		const inherited = Object.assign(Object.create({ requestId: request.requestId }), {
			type: 'toolResponse', result: { success: 'yes' },
		});
		expect(orch.handleDevelopmentNoteMutationResponse(inherited)).toBe(true);
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(vi.getTimerCount()).toBe(1);
		orch.handleWebviewResponse(request.requestId, { success: 'yes' });
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(vi.getTimerCount()).toBe(1);

		const canonical = {
			type: 'toolResponse', requestId: request.requestId, result: { success: true },
		};
		expect(orch.handleDevelopmentNoteMutationResponse(canonical)).toBe(true);
		await expect(pending).resolves.toEqual({ success: true });
		expect(settled).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('rejects malformed agent development-note payloads before transport', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/development-notes.kqlx');
		const poster = vi.fn(() => true);
		orch.connect(poster, vi.fn(async () => []), vi.fn(), uri.toString());
		setActiveCustomTab(uri, 'kusto.kqlxEditor');

		await expect(orch.manageDevelopmentNotes({
			action: 'add',
			category: 'usage-note',
			content: 'Malformed agent note',
			relatedSectionIds: ['query_exact', 42] as unknown as string[],
		})).rejects.toThrow('relatedSectionIds');
		expect(poster).not.toHaveBeenCalled();
	});

	it('rejects a revoked nested agent development-note array before transport or waiter effects', async () => {
		vi.useFakeTimers();
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const uri = vscode.Uri.file('/work/development-notes.kqlx');
		const poster = vi.fn(() => true);
		orch.connect(poster, vi.fn(async () => []), vi.fn(), uri.toString());
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const relatedSectionIds = Proxy.revocable(['query_exact'], {});
		relatedSectionIds.revoke();

		await expect(orch.manageDevelopmentNotes({
			action: 'add',
			category: 'usage-note',
			content: 'Revoked agent note',
			relatedSectionIds: relatedSectionIds.proxy,
		})).rejects.toThrow('relatedSectionIds');
		expect(poster).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('keeps Kusto optimization comparisons in tool inventory when SQL privacy is enabled elsewhere', async () => {
		const connection = { id: 'sql-sensitive', name: 'Sensitive', serverUrl: 'secret.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const refreshPolicy = vi.fn(async () => ['sql-sensitive']);
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient,
			refreshPolicy, vi.fn(async () => undefined),
		);
		orch.connect(vi.fn(), vi.fn(async () => [
			{ id: 'query_source', type: 'query', clusterUrl: 'https://cluster.kusto.windows.net', database: 'Db' },
			{ id: 'query_cmp', type: 'query', comparisonSourceBoxId: 'query_source', clusterUrl: 'https://cluster.kusto.windows.net', database: 'Db' },
		]), vi.fn(), undefined, () => undefined);

		const result = await orch.listSections();
		expect(result.sections.map(section => section.id)).toEqual(['query_source', 'query_cmp']);
		expect(refreshPolicy).not.toHaveBeenCalled();
	});

	it('disconnectIfOwner with matching token clears callbacks', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const token = orch.connect(vi.fn(), vi.fn(async () => []), vi.fn());

		orch.disconnectIfOwner(token);

		// stateGetter is now undefined → listSections should throw
		await expect(orch.listSections()).rejects.toThrow('not currently open');
	});

	it('disconnectIfOwner with stale token does NOT clear callbacks', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);

		// Editor A connects
		const tokenA = orch.connect(vi.fn(), vi.fn(async () => [{ id: 'a1', type: 'query' }]), vi.fn());

		// Editor B connects (overwrites A)
		const stateGetterB = vi.fn(async () => [{ id: 'b1', type: 'query' }]);
		orch.connect(vi.fn(), stateGetterB, vi.fn());

		// Editor A closes and tries to disconnect with its stale token
		orch.disconnectIfOwner(tokenA);

		// Orchestrator should still be connected to editor B
		const result = await orch.listSections();
		expect(stateGetterB).toHaveBeenCalled();
		expect(result.sections[0].id).toBe('b1');
	});

	it('postToActiveWebview uses the latest poster after reconnect', () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);

		const posterA = vi.fn();
		orch.connect(posterA, vi.fn(async () => []), vi.fn());

		const posterB = vi.fn();
		orch.connect(posterB, vi.fn(async () => []), vi.fn());

		orch.postToActiveWebview({ type: 'test' });
		expect(posterA).not.toHaveBeenCalled();
		expect(posterB).toHaveBeenCalledWith({ type: 'test' });
	});

	it('preserves a host-retained section ID in a structured add result', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const poster = createMessagePoster();
		orch.connect(poster, vi.fn(async () => []), vi.fn());

		const request = orch.addSection({ type: 'markdown', text: 'retained' });
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		const message = poster.mock.calls[0][0] as any;
		orch.handleWebviewResponse(message.requestId, {
			sectionId: 'markdown_retained', success: false,
			error: 'A concurrent host document section command failed after the section was added.',
		});

		await expect(request).resolves.toEqual({
			sectionId: 'markdown_retained', success: false,
			error: 'A concurrent host document section command failed after the section was added.',
		});
	});

	it('blocks SQL schema agent dispatch when the live owner is Leave No Trace', async () => {
		const connection = { id: 'sql-sensitive', name: 'Sensitive', serverUrl: 'secret.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const refreshPolicy = vi.fn(async () => ['sql-sensitive']);
		const assertAllowed = vi.fn(async () => { throw new Error('Leave No Trace blocked'); });
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext,
			fakeConnectionManager,
			() => sqlManager,
			fakeKustoClient,
			refreshPolicy,
			assertAllowed,
		);
		const poster = vi.fn(() => true);
		orch.connect(
			poster,
			vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'Db', ownerToken: 'owner-a' }]),
			vi.fn(),
			undefined,
			sectionId => sectionId === 'sql_1' ? 'sql-sensitive' : undefined,
		);

		await expect(orch.getSqlSchema({ sectionId: 'sql_1' })).rejects.toThrow('Leave No Trace blocked');
		expect(refreshPolicy).toHaveBeenCalledTimes(1);
		expect(poster).not.toHaveBeenCalled();
	});

	it('waits for the initial SQL owner after installation before execute-only dispatch', async () => {
		vi.useFakeTimers();
		const connection = { ...defaultSqlConnection, authType: 'sql-login', username: 'user' };
		const sqlManager = {
			getConnections: () => [connection],
			getConnection: (connectionId: string) => connectionId === connection.id ? connection : undefined,
			assertConnectionCurrent: vi.fn(async () => undefined),
		};
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, () => sqlManager as any, fakeKustoClient,
			vi.fn(async () => []), vi.fn(async () => undefined),
		);
		const uri = vscode.Uri.file('/work/sql-owner-readiness.sqlx');
		const document = { uri, version: 1, isClosed: false, getText: () => JSON.stringify({
			kind: 'sqlx', version: 1, state: { sections: [{
				id: 'sql_pending', type: 'sql', query: 'SELECT 1 AS Probe',
				connectionIdHint: connection.id, database: 'Db',
			}] },
		}) };
		(vscode.workspace as any).textDocuments = [document];
		setActiveCustomTab(uri, 'kusto.sqlxEditor');
		const installation = deferred<void>();
		const prepareSqlExecution = vi.fn(() => installation.promise);
		let readyOwner: { connectionId: string; database: string; ownerToken: string; generation: number } | undefined;
		const stateGetter = vi.fn(async () => [{
			id: 'sql_pending', type: 'sql', connectionId: connection.id, database: 'Db',
			ownerToken: readyOwner?.ownerToken ?? '',
		}]);
		const poster = vi.fn((message: unknown, _signal?: AbortSignal, isCurrent?: () => boolean) => {
			if (isCurrent?.() === false) return false;
			const request = message as { type: string; requestId: string; input: { executionId: string } };
			if (request.type === 'toolConfigureSqlSection') {
				orchestrator.handleWebviewResponse(request.requestId, {
					success: true, resultPreview: 'Probe: 1', executionId: request.input.executionId,
					executionOwner: readyOwner,
				});
			}
			return true;
		});
		const token = orchestrator.connect(poster, stateGetter, vi.fn(), uri.toString(),
			sectionId => sectionId === 'sql_pending' ? connection.id : undefined,
			sectionId => sectionId === 'sql_pending' ? readyOwner : undefined,
			undefined, async () => true, undefined, async () => true, () => () => true,
			undefined, prepareSqlExecution);
		const cancellation = cancellationToken();
		const input = { targetFileUri: uri.toString(), sectionId: 'sql_pending', execute: true };
		const execution = orchestrator.configureSqlSection(input, cancellation.token);
		let outcome: { status: string; error?: string } = { status: 'pending' };
		void execution.then(() => { outcome = { status: 'resolved' }; }).catch(error => {
			outcome = { status: 'rejected', error: error instanceof Error ? error.message : String(error) };
		});
		try {
			await vi.advanceTimersByTimeAsync(10_050);
			expect(outcome, 'installation must finish before the owner-readiness deadline starts').toEqual({ status: 'pending' });
			expect(prepareSqlExecution).toHaveBeenCalledOnce();
			expect(poster).not.toHaveBeenCalled();
			installation.resolve();
			await vi.advanceTimersByTimeAsync(0);
			expect(outcome).toEqual({ status: 'pending' });
			expect(poster).not.toHaveBeenCalled();
			readyOwner = { connectionId: connection.id, database: 'Db', ownerToken: 'sql-ready-owner', generation: 1 };
			await vi.advanceTimersByTimeAsync(50);
			await expect(execution).resolves.toEqual({ success: true, resultPreview: 'Probe: 1' });
			expect(poster).toHaveBeenCalledOnce();
			const posted = poster.mock.calls[0][0] as { type: string; input: Record<string, unknown> };
			expect(posted).toMatchObject({ type: 'toolConfigureSqlSection', input: {
				sectionId: 'sql_pending', execute: true, executionId: expect.stringMatching(/^sql-tool-/),
				expectedExecutionOwner: { connectionId: connection.id, database: 'Db' },
			} });
			for (const field of ['query', 'connectionId', 'database', 'serverUrl', 'resolvedConnection', 'requestedTargetSignature']) {
				expect(posted.input).not.toHaveProperty(field);
			}
		} finally {
			cancellation.cancel();
			installation.resolve();
			await execution.catch(() => undefined);
			orchestrator.disconnectIfOwner(token);
		}
	});

	it.each(['unchanged', 'same-ID replacement', 'target A-B-A'] as const)(
		'keeps SQL execute-only admission bound to the original pending lifecycle through %s', async transition => {
		vi.useFakeTimers();
		const { connection, lifecycle, publication, orchestrator, uri, document, source, installation,
			prepareSqlExecution, executionPosted, snapshot, session } = createPendingSqlLifecycleHarness();
		const initialInstance = lifecycle.getSectionInstanceId('sql_pending');
		const initialGeneration = lifecycle.getGeneration('sql_pending');
		expect(lifecycle.getReadyToolOwner('sql_pending')).toBeUndefined();
		const cancellation = cancellationToken();
		const execution = orchestrator.configureSqlSection({
			targetFileUri: uri.toString(), sectionId: 'sql_pending', execute: true,
		}, cancellation.token);
		let outcome: { status: string; error?: string } = { status: 'pending' };
		void execution.then(() => { outcome = { status: 'resolved' }; }).catch(error => {
			outcome = { status: 'rejected', error: error instanceof Error ? error.message : String(error) };
		});
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(outcome).toEqual({ status: 'pending' });
			expect(prepareSqlExecution).toHaveBeenCalledOnce();
			expect(snapshot).toHaveBeenCalledOnce();
			expect(snapshot.mock.results[0].value[0].ownerToken).toBe('');
			installation.resolve();
			await vi.advanceTimersByTimeAsync(0);
			expect(snapshot).toHaveBeenCalledTimes(2);
			expect(outcome).toEqual({ status: 'pending' });
			expect(executionPosted).not.toHaveBeenCalled();
			if (transition === 'same-ID replacement') {
				lifecycle.openSection('sql_pending', 'instance-replacement');
				expect(lifecycle.adoptTarget('sql_pending', 'instance-replacement', connection.id, 'Db', 1)).toBe(true);
				expect(lifecycle.getSectionInstanceId('sql_pending')).not.toBe(initialInstance);
				expect(lifecycle.getGeneration('sql_pending')).toBe(initialGeneration);
			} else if (transition === 'target A-B-A') {
				expect(lifecycle.adoptTarget('sql_pending', 'instance-original', connection.id, 'DbB', 2)).toBe(true);
				expect(lifecycle.adoptTarget('sql_pending', 'instance-original', connection.id, 'Db', 3)).toBe(true);
				expect(lifecycle.getSectionInstanceId('sql_pending')).toBe(initialInstance);
				expect(lifecycle.getGeneration('sql_pending')).toBeGreaterThan(initialGeneration);
			}
			const instance = lifecycle.getSectionInstanceId('sql_pending')!;
			lifecycle.didOpen('sql_pending', instance, 'SELECT 1 AS Probe');
			await lifecycle.connect('sql_pending', instance, connection.id, 'Db', lifecycle.getGeneration('sql_pending'));
			const readyOwner = lifecycle.getReadyToolOwner('sql_pending');
			expect(readyOwner).toEqual({ connectionId: connection.id, database: 'Db',
				ownerToken: expect.any(String), generation: transition === 'target A-B-A' ? 3 : 1 });
			expect(publication).toHaveBeenCalledWith(expect.objectContaining({
				type: 'stsConnectionState', sectionInstanceId: instance, state: 'ready', ownerToken: readyOwner!.ownerToken,
			}));
			expect(document.version).toBe(1);
			expect(document.getText()).toBe(source);
			await vi.advanceTimersByTimeAsync(50);
			if (transition === 'unchanged') {
				await expect(execution).resolves.toEqual({ success: true, resultPreview: 'Probe: 1' });
				expect(executionPosted).toHaveBeenCalledOnce();
				const request = executionPosted.mock.calls[0][0] as { input: Record<string, unknown> };
				expect(request.input.executionId).toEqual(expect.stringMatching(/^sql-tool-/));
				for (const field of ['query', 'connectionId', 'database', 'serverUrl', 'resolvedConnection', 'requestedTargetSignature']) {
					expect(request.input).not.toHaveProperty(field);
				}
			} else {
				expect({ deliveries: executionPosted.mock.calls.length, outcome },
					'a pending operation must not adopt a replacement or an A-B-A target').toMatchObject({
					deliveries: 0, outcome: { status: 'rejected' },
				});
			}
		} finally {
			cancellation.cancel();
			installation.resolve();
			await execution.catch(() => undefined);
			session.dispose();
			lifecycle.dispose();
		}
	});

	it('rejects a known raw SQL owner that disappeared instead of treating it as initially pending', async () => {
		vi.useFakeTimers();
		const harness = createPendingSqlLifecycleHarness();
		const cancellation = cancellationToken();
		expect(await harness.publishReadyOwner()).toBeDefined();
		const publishedSnapshot = harness.snapshot();
		expect(publishedSnapshot[0].ownerToken).not.toBe('');
		harness.snapshot.mockReturnValue(publishedSnapshot);
		harness.lifecycle.openSection('sql_pending', 'instance-replacement');
		expect(harness.lifecycle.adoptTarget('sql_pending', 'instance-replacement', harness.connection.id, 'Db', 1)).toBe(true);
		expect(harness.lifecycle.getReadyToolOwner('sql_pending')).toBeUndefined();
		const execution = harness.orchestrator.configureSqlSection(harness.input, cancellation.token).catch(error => error);
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(await execution).toMatchObject({ message: 'SQL section owner changed before execution.' });
			expect(harness.prepareSqlExecution).not.toHaveBeenCalled();
			harness.installation.resolve();
			expect(await harness.publishReadyOwner()).toBeDefined();
			await vi.advanceTimersByTimeAsync(50);
			expect(harness.executionPosted).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			cancellation.cancel();
			harness.installation.resolve();
			await execution;
			harness.dispose();
		}
	});

	it('captures SQL execute-only admission before the initial raw snapshot settles', async () => {
		vi.useFakeTimers();
		const harness = createPendingSqlLifecycleHarness();
		const snapshotRelease = deferred<void>();
		let snapshotHeld = false;
		harness.setTransport(async (message, signal, isCurrent) => {
			if ((message as { type: string }).type === 'requestToolState' && !snapshotHeld) {
				snapshotHeld = true;
				await snapshotRelease.promise;
			}
			return signal?.aborted || isCurrent?.() === false ? false : harness.physicalPost(message);
		});
		const cancellation = cancellationToken();
		const execution = harness.orchestrator.configureSqlSection(harness.input, cancellation.token).catch(error => error);
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(snapshotHeld).toBe(true);
			expect(harness.snapshot).not.toHaveBeenCalled();
			expect(harness.prepareSqlExecution).not.toHaveBeenCalled();
			harness.lifecycle.openSection('sql_pending', 'instance-replacement');
			expect(harness.lifecycle.adoptTarget('sql_pending', 'instance-replacement', harness.connection.id, 'Db', 1)).toBe(true);
			expect(await harness.publishReadyOwner()).toMatchObject({ connectionId: harness.connection.id, database: 'Db', generation: 1 });
			harness.installation.resolve();
			snapshotRelease.resolve();
			await vi.advanceTimersByTimeAsync(0);
			expect(await execution).toMatchObject({ message: 'The targeted Workbench editor changed before SQL installation preparation.' });
			expect(harness.snapshot).toHaveBeenCalledOnce();
			expect(harness.prepareSqlExecution).not.toHaveBeenCalled();
			expect(harness.executionPosted).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			cancellation.cancel();
			snapshotRelease.resolve();
			harness.installation.resolve();
			await execution;
			harness.dispose();
		}
	});

	it.each(['same-ID replacement', 'target A-B-A'] as const)(
		'rejects queued physical SQL delivery after pending readiness through %s', async transition => {
		vi.useFakeTimers();
		const harness = createPendingSqlLifecycleHarness();
		let receive!: (message: unknown) => unknown;
		const gateway = new MainWebviewStartupGateway<unknown>({
			panel: {
				webview: { postMessage: harness.physicalPost, onDidReceiveMessage: (listener: typeof receive) => {
					receive = listener;
					return { dispose() {} };
				} },
				onDidDispose: () => ({ dispose() {} }),
			} as never,
			admitInbound: input => input,
		});
		await receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'pending-sql-runtime' });
		const heldHead = deferred<boolean>();
		let head: Promise<boolean> | undefined;
		harness.setTransport((message, signal, isCurrent) => {
			if ((message as { type: string }).type === 'toolConfigureSqlSection') {
				head = gateway.postDocumentProjection({ preflight: () => heldHead.promise,
					prepare: () => ({ message: { type: 'heldHead' } }) });
			}
			return gateway.postMessage(message, signal, isCurrent);
		});
		const cancellation = cancellationToken();
		const execution = harness.orchestrator.configureSqlSection(harness.input, cancellation.token).catch(error => error);
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.prepareSqlExecution).toHaveBeenCalledOnce();
			harness.installation.resolve();
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.snapshot).toHaveBeenCalledTimes(2);
			expect(harness.lifecycle.getReadyToolOwner('sql_pending')).toBeUndefined();
			expect(await harness.publishReadyOwner()).toBeDefined();
			await vi.advanceTimersByTimeAsync(50);
			expect(head).toBeDefined();
			const request = harness.postMessage.mock.calls.find(([message]) => (message as { type: string }).type === 'toolConfigureSqlSection');
			expect(request?.[2]).toBeTypeOf('function');
			expect(request?.[2]?.()).toBe(true);
			expect(harness.executionPosted).not.toHaveBeenCalled();
			if (transition === 'same-ID replacement') {
				harness.lifecycle.openSection('sql_pending', 'instance-replacement');
				expect(harness.lifecycle.adoptTarget('sql_pending', 'instance-replacement', harness.connection.id, 'Db', 1)).toBe(true);
			} else {
				expect(harness.lifecycle.adoptTarget('sql_pending', 'instance-original', harness.connection.id, 'DbB', 2)).toBe(true);
				expect(harness.lifecycle.adoptTarget('sql_pending', 'instance-original', harness.connection.id, 'Db', 3)).toBe(true);
			}
			expect(await harness.publishReadyOwner()).toBeDefined();
			expect(request?.[2]?.()).toBe(false);
			heldHead.resolve(true);
			await head;
			expect(await execution).toMatchObject({ message: 'The targeted Kusto Workbench editor rejected the request.' });
			expect(harness.executionPosted).not.toHaveBeenCalled();
			expect(Reflect.get(harness.orchestrator, 'pendingResponses').size).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			cancellation.cancel();
			harness.installation.resolve();
			heldHead.resolve(true);
			await head;
			await execution;
			harness.dispose();
			gateway.dispose();
		}
	});

	it.each(['cancellation', 'disposal', 'source change', 'readiness timeout'] as const)(
		'settles pending SQL owner readiness after %s without late execution or retained timers', async failure => {
		vi.useFakeTimers();
		const harness = createPendingSqlLifecycleHarness();
		const cancellation = cancellationToken();
		let settled = false;
		const execution = harness.orchestrator.configureSqlSection(harness.input, cancellation.token)
			.then(result => { settled = true; return result; }, error => { settled = true; return error; });
		try {
			await vi.advanceTimersByTimeAsync(0);
			harness.installation.resolve();
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.snapshot).toHaveBeenCalledTimes(2);
			expect(settled).toBe(false);
			if (failure === 'cancellation') cancellation.cancel();
			if (failure === 'disposal') harness.session.dispose();
			if (failure === 'source change') {
				harness.document.version++;
				await harness.publishReadyOwner();
			}
			if (failure === 'readiness timeout') {
				await vi.advanceTimersByTimeAsync(9_999);
				expect(settled).toBe(false);
				await vi.advanceTimersByTimeAsync(1);
			} else await vi.advanceTimersByTimeAsync(50);
			const result = await execution;
			if (failure === 'cancellation') expect(result).toBeInstanceOf(vscode.CancellationError);
			else expect(result).toMatchObject({ message: failure === 'disposal'
				? 'The targeted Kusto Workbench editor closed during SQL tool preflight.'
				: failure === 'readiness timeout' ? 'SQL section owner did not become ready before tool preflight timed out.'
					: 'The targeted Workbench editor changed during SQL installation preparation.' });
			expect(harness.executionPosted).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			expect(await harness.publishReadyOwner()).toBeDefined();
			await vi.advanceTimersByTimeAsync(50);
			expect(harness.executionPosted).not.toHaveBeenCalled();
			expect(Reflect.get(harness.orchestrator, 'pendingResponses').size).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			cancellation.cancel();
			harness.installation.resolve();
			await execution;
			harness.dispose();
		}
	});

	it.each(['cancellation', 'disposal'] as const)(
		'settles pending SQL installation after %s within its existing deadline without late execution', async failure => {
		vi.useFakeTimers();
		const harness = createPendingSqlLifecycleHarness();
		const cancellation = cancellationToken();
		let settled = false;
		const execution = harness.orchestrator.configureSqlSection(harness.input, cancellation.token)
			.then(result => { settled = true; return result; }, error => { settled = true; return error; });
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.prepareSqlExecution).toHaveBeenCalledOnce();
			if (failure === 'cancellation') cancellation.cancel();
			else {
				harness.session.dispose();
				await vi.advanceTimersByTimeAsync(6 * 60_000 - 1);
				expect(settled).toBe(false);
				await vi.advanceTimersByTimeAsync(1);
			}
			const result = await execution;
			if (failure === 'cancellation') expect(result).toBeInstanceOf(vscode.CancellationError);
			else expect(result).toMatchObject({ message: 'SQL Tools Service installation preparation timed out.' });
			expect(vi.getTimerCount()).toBe(0);
			harness.installation.resolve();
			expect(await harness.publishReadyOwner()).toBeDefined();
			await vi.advanceTimersByTimeAsync(50);
			expect(harness.executionPosted).not.toHaveBeenCalled();
			expect(Reflect.get(harness.orchestrator, 'pendingResponses').size).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			cancellation.cancel();
			harness.installation.resolve();
			await execution;
			harness.dispose();
		}
	});

	it('waits for a selected SQL section owner to become ready before schema preflight', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient,
			vi.fn(async () => []), vi.fn(async () => undefined),
		);
		let liveOwner: { connectionId: string; database: string; ownerToken: string; generation: number } | undefined;
		const stateGetter = vi.fn(async () => [{
			id: 'sql_1', type: 'sql', connectionId: 'sql-test', database: 'Db',
			ownerToken: liveOwner?.ownerToken || '',
		}]);
		const poster = createMessagePoster();
		orch.connect(poster, stateGetter, vi.fn(), undefined, () => 'sql-test', () => liveOwner);

		const request = orch.getSqlSchema({ sectionId: 'sql_1' });
		const observed = request.then(value => ({ value }), error => ({ error }));
		setTimeout(() => {
			liveOwner = { connectionId: 'sql-test', database: 'Db', ownerToken: 'owner-ready', generation: 1 };
		}, 10);

		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		const message = poster.mock.calls[0][0] as any;
		orch.handleWebviewResponse(message.requestId, {
			success: true, schema: { tables: ['Ready'] },
			owner: { connectionId: 'sql-test', database: 'Db', ownerToken: 'owner-ready' },
		});

		expect(await observed).toEqual({ value: { success: true, schema: { tables: ['Ready'] }, owner: {
			connectionId: 'sql-test', database: 'Db', ownerToken: 'owner-ready',
		} } });
		expect(stateGetter.mock.calls.length).toBeGreaterThan(1);
	});

	it('rejects a different SQL owner that appears during readiness wait', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient,
			vi.fn(async () => []), vi.fn(async () => undefined),
		);
		let liveOwner: { connectionId: string; database: string; ownerToken: string; generation: number } | undefined;
		const poster = vi.fn(() => true);
		orch.connect(
			poster,
			vi.fn(async () => [{ id: 'sql_1', type: 'sql', connectionId: 'sql-test', database: 'DbA', ownerToken: '' }]),
			vi.fn(), undefined, () => 'sql-test', () => liveOwner,
		);

		const request = orch.getSqlSchema({ sectionId: 'sql_1' });
		setTimeout(() => {
			liveOwner = { connectionId: 'sql-test', database: 'DbB', ownerToken: 'owner-b', generation: 2 };
		}, 10);

		await expect(request).rejects.toThrow('owner changed');
		expect(poster).not.toHaveBeenCalled();
	});

	it('cancels SQL Copilot delegation while waiting for owner readiness', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient,
			vi.fn(async () => []), vi.fn(async () => undefined),
		);
		const poster = vi.fn(() => true);
		orch.connect(
			poster,
			vi.fn(async () => [{ id: 'sql_1', type: 'sql', connectionId: 'sql-test', database: 'Db', ownerToken: '' }]),
			vi.fn(), undefined, () => 'sql-test', () => undefined,
		);
		const cancellation = cancellationToken();

		const request = orch.delegateToSqlCopilot(
			{ sectionId: 'sql_1', question: 'Write a query' }, cancellation.token,
		);
		setTimeout(() => cancellation.cancel(), 10);

		await expect(request).rejects.toMatchObject({ name: 'Canceled' });
		expect(poster).not.toHaveBeenCalled();
	});

	it('cancels SQL schema lookup while waiting for owner readiness', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient,
			vi.fn(async () => []), vi.fn(async () => undefined),
		);
		const poster = vi.fn(() => true);
		orch.connect(
			poster,
			vi.fn(async () => [{ id: 'sql_1', type: 'sql', connectionId: 'sql-test', database: 'Db', ownerToken: '' }]),
			vi.fn(), undefined, () => 'sql-test', () => undefined,
		);
		const cancellation = cancellationToken();

		const request = orch.getSqlSchema({ sectionId: 'sql_1' }, cancellation.token);
		setTimeout(() => cancellation.cancel(), 10);

		await expect(request).rejects.toMatchObject({ name: 'Canceled' });
		expect(poster).not.toHaveBeenCalled();
	});

	it('times out a stalled SQL owner readiness wait without dispatching', async () => {
		vi.useFakeTimers();
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient,
			vi.fn(async () => []), vi.fn(async () => undefined),
		);
		const poster = vi.fn(() => true);
		orch.connect(
			poster,
			vi.fn(async () => [{ id: 'sql_1', type: 'sql', connectionId: 'sql-test', database: 'Db', ownerToken: '' }]),
			vi.fn(), undefined, () => 'sql-test', () => undefined,
		);

		const request = orch.getSqlSchema({ sectionId: 'sql_1' });
		const rejection = expect(request).rejects.toThrow('did not become ready');
		await vi.advanceTimersByTimeAsync(10_050);

		await rejection;
		expect(poster).not.toHaveBeenCalled();
	});

	it('rejects SQL schema agent data when policy changes before response admission', async () => {
		const connection = { id: 'sql-sensitive', name: 'Sensitive', serverUrl: 'secret.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		let allowed = true;
		const refreshPolicy = vi.fn(async () => allowed ? [] : ['sql-sensitive']);
		const assertAllowed = vi.fn(async () => {
			if (!allowed) throw new Error('Leave No Trace blocked');
		});
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext,
			fakeConnectionManager,
			() => sqlManager,
			fakeKustoClient,
			refreshPolicy,
			assertAllowed,
		);
		const poster = createMessagePoster();
		orch.connect(
			poster,
			vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'Db', ownerToken: 'owner-a' }]),
			vi.fn(),
			undefined,
			sectionId => sectionId === 'sql_1' ? 'sql-sensitive' : undefined,
		);

		const request = orch.getSqlSchema({ sectionId: 'sql_1' });
		await vi.waitFor(() => expect(poster).toHaveBeenCalledTimes(1));
		const message = poster.mock.calls[0][0] as any;
		allowed = false;
		orch.handleWebviewResponse(message.requestId, {
			success: true,
			schema: { tables: ['Secret'] },
			owner: { connectionId: 'sql-sensitive', database: 'Db', ownerToken: 'owner-a' },
		});

		await expect(request).rejects.toThrow('Leave No Trace blocked');
		expect(refreshPolicy).toHaveBeenCalledTimes(2);
	});

	it('rejects SQL schema agent data when composite owner admission fails after response validation', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const dispatchOwner = vi.fn(async () => { throw new Error('canonical owner changed'); });
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient,
			vi.fn(async () => []), vi.fn(async () => undefined), () => 0, dispatchOwner,
		);
		const poster = createMessagePoster();
		orch.connect(poster, vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'Db', ownerToken: 'owner-a' }]), vi.fn(), undefined, () => 'sql-test');

		const request = orch.getSqlSchema({ sectionId: 'sql_1' });
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		const message = poster.mock.calls[0][0] as any;
		orch.handleWebviewResponse(message.requestId, {
			success: true, schema: { tables: ['Secret'] },
			owner: { connectionId: 'sql-test', database: 'Db', ownerToken: 'owner-a' },
		});

		await expect(request).rejects.toThrow('canonical owner changed');
		expect(dispatchOwner).toHaveBeenCalledOnce();
	});

	it('rejects delegated SQL Copilot data when composite owner admission fails after response validation', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const dispatchOwner = vi.fn(async () => { throw new Error('canonical owner changed'); });
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient,
			vi.fn(async () => []), vi.fn(async () => undefined), () => 0, dispatchOwner,
		);
		const poster = createMessagePoster();
		orch.connect(poster, vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'Db', ownerToken: 'owner-a' }]), vi.fn(), undefined, () => 'sql-test');

		const request = orch.delegateToSqlCopilot({ sectionId: 'sql_1', question: 'Write a query' });
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		const message = poster.mock.calls[0][0] as any;
		orch.handleWebviewResponse(message.requestId, {
			success: true, answer: 'done', query: 'SELECT Secret FROM T',
			owner: { connectionId: 'sql-test', database: 'Db', ownerToken: 'owner-a' },
		});

		await expect(request).rejects.toThrow('canonical owner changed');
		expect(dispatchOwner).toHaveBeenCalledOnce();
	});

	it.each(['schema', 'copilot'] as const)('rejects %s data when the local database changes inside composite admission', async kind => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		let liveOwner = { connectionId: 'sql-test', database: 'DbA', ownerToken: 'owner-a', generation: 1 };
		const dispatchOwnerImplementation = async <T>(
			_connection: unknown,
			_principal: string,
			_revocation: number,
			dispatch: () => T | PromiseLike<T>,
		): Promise<T> => {
			liveOwner = { ...liveOwner, database: 'DbB', generation: 2 };
			return await dispatch();
		};
		const dispatchOwner = vi.fn(dispatchOwnerImplementation) as typeof dispatchOwnerImplementation;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient,
			vi.fn(async () => []), vi.fn(async () => undefined), () => 0, dispatchOwner,
		);
		const poster = createMessagePoster();
		orch.connect(
			poster,
			vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'DbA', ownerToken: 'owner-a' }]),
			vi.fn(), undefined, () => 'sql-test', () => liveOwner,
		);

		const request = kind === 'schema'
			? orch.getSqlSchema({ sectionId: 'sql_1' })
			: orch.delegateToSqlCopilot({ sectionId: 'sql_1', question: 'Write a query' });
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		const message = poster.mock.calls[0][0] as any;
		orch.handleWebviewResponse(message.requestId, kind === 'schema'
			? { success: true, schema: { tables: ['Secret'] }, owner: { connectionId: 'sql-test', database: 'DbA', ownerToken: 'owner-a' } }
			: { success: true, answer: 'done', query: 'SELECT 1', owner: { connectionId: 'sql-test', database: 'DbA', ownerToken: 'owner-a' } });

		await expect(request).rejects.toThrow('owner changed');
	});

	it('rejects SQL schema data when the full live owner disappears inside composite admission', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		let liveOwner: { connectionId: string; database: string; ownerToken: string; generation: number } | undefined = {
			connectionId: 'sql-test', database: 'Db', ownerToken: 'owner-a', generation: 1,
		};
		const dispatchOwnerImplementation = async <T>(
			_connection: unknown,
			_principal: string,
			_revocation: number,
			dispatch: () => T | PromiseLike<T>,
		): Promise<T> => {
			liveOwner = undefined;
			return await dispatch();
		};
		const dispatchOwner = vi.fn(dispatchOwnerImplementation) as typeof dispatchOwnerImplementation;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient,
			vi.fn(async () => []), vi.fn(async () => undefined), () => 0, dispatchOwner,
		);
		const poster = createMessagePoster();
		orch.connect(
			poster,
			vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'Db', ownerToken: 'owner-a' }]),
			vi.fn(), undefined, () => 'sql-test', () => liveOwner,
		);

		const request = orch.getSqlSchema({ sectionId: 'sql_1' });
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		const message = poster.mock.calls[0][0] as any;
		orch.handleWebviewResponse(message.requestId, {
			success: true, schema: { tables: ['Secret'] },
			owner: { connectionId: 'sql-test', database: 'Db', ownerToken: 'owner-a' },
		});

		await expect(request).rejects.toThrow('owner disappeared');
	});

	it('keeps SQL schema dispatch bound to the editor captured before preflight', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const preflight = deferred<void>();
		let assertions = 0;
		const sqlManager = {
			getConnections: () => [connection],
			getConnection: () => connection,
			assertConnectionCurrent: vi.fn(async () => { if (++assertions === 1) await preflight.promise; }),
		} as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient, vi.fn(async () => []), vi.fn(async () => undefined));
		const firstPoster = createMessagePoster();
		const secondPoster = vi.fn(() => true);
		orch.connect(firstPoster, vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'Db', ownerToken: 'owner-a' }]), vi.fn(), undefined, () => 'sql-test');

		const request = orch.getSqlSchema({ sectionId: 'sql_1' });
		await vi.waitFor(() => expect(sqlManager.assertConnectionCurrent).toHaveBeenCalledOnce());
		orch.connect(secondPoster, vi.fn(async () => [{ id: 'sql_2', type: 'sql' }]), vi.fn(), undefined, () => 'sql-test');
		preflight.resolve();

		await vi.waitFor(() => expect(firstPoster).toHaveBeenCalledOnce());
		expect(secondPoster).not.toHaveBeenCalled();
		const message = firstPoster.mock.calls[0][0] as any;
		orch.handleWebviewResponse(message.requestId, {
			success: true, schema: { tables: ['A'] },
			owner: { connectionId: 'sql-test', database: 'Db', ownerToken: 'owner-a' },
		});
		await expect(request).resolves.toMatchObject({ success: true, schema: { tables: ['A'] } });
	});

	it('keeps SQL Copilot dispatch bound to the editor captured before preflight', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const preflight = deferred<void>();
		let assertions = 0;
		const sqlManager = {
			getConnections: () => [connection],
			getConnection: () => connection,
			assertConnectionCurrent: vi.fn(async () => { if (++assertions === 1) await preflight.promise; }),
		} as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient, vi.fn(async () => []), vi.fn(async () => undefined));
		const firstPoster = createMessagePoster();
		const secondPoster = vi.fn(() => true);
		orch.connect(firstPoster, vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'Db', ownerToken: 'owner-a' }]), vi.fn(), undefined, () => 'sql-test');

		const request = orch.delegateToSqlCopilot({ sectionId: 'sql_1', question: 'Write a query' });
		await vi.waitFor(() => expect(sqlManager.assertConnectionCurrent).toHaveBeenCalledOnce());
		orch.connect(secondPoster, vi.fn(async () => [{ id: 'sql_2', type: 'sql' }]), vi.fn(), undefined, () => 'sql-test');
		preflight.resolve();

		await vi.waitFor(() => expect(firstPoster).toHaveBeenCalledOnce());
		expect(secondPoster).not.toHaveBeenCalled();
		const message = firstPoster.mock.calls[0][0] as any;
		orch.handleWebviewResponse(message.requestId, {
			success: true, answer: 'Query generated successfully.', query: 'SELECT 1',
			owner: { connectionId: 'sql-test', database: 'Db', ownerToken: 'owner-a' },
		});
		await expect(request).resolves.toMatchObject({ success: true, query: 'SELECT 1' });
	});

	it('tears down the captured SQL Copilot owner when tool cancellation is requested', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient, vi.fn(async () => []), vi.fn(async () => undefined));
		const poster = createMessagePoster();
		orch.connect(poster, vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'Db', ownerToken: 'owner-a' }]), vi.fn(), undefined, () => 'sql-test');
		const cancellation = cancellationToken();

		const request = orch.delegateToSqlCopilot({ sectionId: 'sql_1', question: 'Write a query' }, cancellation.token);
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		const dispatch = poster.mock.calls[0][0] as any;
		cancellation.cancel();

		await expect(request).rejects.toMatchObject({ name: 'Canceled' });
		expect(poster).toHaveBeenCalledWith({
			type: 'toolCancelSqlCopilot', requestId: dispatch.requestId,
			sectionId: 'sql_1', expectedOwnerToken: 'owner-a',
		});
	});

	it('preserves an actionable schema-unavailable failure after host owner revalidation', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient, vi.fn(async () => []), vi.fn(async () => undefined));
		const poster = createMessagePoster();
		orch.connect(poster, vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'Db', ownerToken: 'owner-a' }]), vi.fn(), undefined, () => 'sql-test');

		const request = orch.getSqlSchema({ sectionId: 'sql_1' });
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		const message = poster.mock.calls[0][0] as any;
		orch.handleWebviewResponse(message.requestId, { success: false, error: 'No schema loaded.' });

		await expect(request).resolves.toEqual({ success: false, error: 'No schema loaded.' });
	});

	it('preserves an actionable SQL Copilot timeout after host owner revalidation', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient, vi.fn(async () => []), vi.fn(async () => undefined));
		const poster = createMessagePoster();
		orch.connect(poster, vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'Db', ownerToken: 'owner-a' }]), vi.fn(), undefined, () => 'sql-test');

		const request = orch.delegateToSqlCopilot({ sectionId: 'sql_1', question: 'Write a query' });
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		const message = poster.mock.calls[0][0] as any;
		orch.handleWebviewResponse(message.requestId, { success: false, answer: '', timedOut: true, error: 'Request timed out.' });

		await expect(request).resolves.toMatchObject({ success: false, timedOut: true, error: 'Request timed out.' });
	});

	it('rejects SQL schema data when the section database changes before completion', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient, vi.fn(async () => []), vi.fn(async () => undefined));
		const poster = createMessagePoster();
		orch.connect(poster, vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'DbA', ownerToken: 'owner-a' }]), vi.fn(), undefined, () => 'sql-test');

		const request = orch.getSqlSchema({ sectionId: 'sql_1' });
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		const message = poster.mock.calls[0][0] as any;
		orch.handleWebviewResponse(message.requestId, { success: true, schema: {}, owner: { connectionId: 'sql-test', database: 'DbB', ownerToken: 'owner-a' } });

		await expect(request).rejects.toThrow('owner changed');
	});

	it('rejects SQL Copilot data when the section owner token changes before completion', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient, vi.fn(async () => []), vi.fn(async () => undefined));
		const poster = createMessagePoster();
		orch.connect(poster, vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'Db', ownerToken: 'owner-a' }]), vi.fn(), undefined, () => 'sql-test');

		const request = orch.delegateToSqlCopilot({ sectionId: 'sql_1', question: 'Write a query' });
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		const message = poster.mock.calls[0][0] as any;
		orch.handleWebviewResponse(message.requestId, { success: true, answer: 'done', owner: { connectionId: 'sql-test', database: 'Db', ownerToken: 'owner-b' } });

		await expect(request).rejects.toThrow('owner changed');
	});

	it('postToAllWebviews snapshots live connections and isolates disposed posters', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const posterA = vi.fn(async () => true);
		const posterB = vi.fn(() => { throw new Error('disposed'); });
		const posterC = vi.fn(async () => false);
		orch.connect(posterA, vi.fn(async () => []), vi.fn());
		orch.connect(posterB, vi.fn(async () => []), vi.fn());
		orch.connect(posterC, vi.fn(async () => []), vi.fn());

		const message = { type: 'editingPreferencesData', revision: 1 };
		await expect(orch.postToAllWebviews(message)).resolves.toEqual({ attempted: 3, delivered: 1 });
		expect(posterA).toHaveBeenCalledWith(message);
		expect(posterB).toHaveBeenCalledWith(message);
		expect(posterC).toHaveBeenCalledWith(message);
	});

	it('successive connects increment the token', () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const t1 = orch.connect(vi.fn(), vi.fn(async () => []), vi.fn());
		const t2 = orch.connect(vi.fn(), vi.fn(async () => []), vi.fn());
		const t3 = orch.connect(vi.fn(), vi.fn(async () => []), vi.fn());
		expect(t2).toBeGreaterThan(t1);
		expect(t3).toBeGreaterThan(t2);
	});

	it('listSections includes filePath and fileName when documentUri is provided', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		orch.connect(
			vi.fn(),
			vi.fn(async () => [{ id: 'q1', type: 'query' }]),
			vi.fn(),
			'file:///home/user/analysis.kqlx'
		);

		const result = await orch.listSections();
		expect(result.filePath).toBe('/home/user/analysis.kqlx');
		expect(result.fileName).toBe('analysis.kqlx');
		expect(result.sections).toHaveLength(1);
	});

	it('requires connectionId when schema refresh matches multiple saved connections', async () => {
		const getDatabases = vi.fn();
		const connectionManager = {
			getConnections: () => [
				{ id: 'home', name: 'Home tenant', clusterUrl: 'https://shared.kusto.windows.net' },
				{ id: 'guest', name: 'Guest tenant', clusterUrl: 'shared' },
			],
		} as any;
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext,
			connectionManager,
			fakeGetSqlConnMgr,
			{ getDatabases } as any,
		);

		const result = await orchestrator.refreshSchema({ clusterUrl: 'https://shared.kusto.windows.net' });

		expect(result).toEqual({ schemas: [], error: 'Multiple saved connections match this cluster. Pass connectionId from list-connections.' });
		expect(getDatabases).not.toHaveBeenCalled();
	});

	it('rejects a schema refresh connectionId that belongs to another cluster', async () => {
		const getDatabases = vi.fn();
		const connectionManager = {
			getConnections: () => [
				{ id: 'first', name: 'First', clusterUrl: 'https://first.kusto.windows.net' },
				{ id: 'second', name: 'Second', clusterUrl: 'https://second.kusto.windows.net' },
			],
		} as any;
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext,
			connectionManager,
			fakeGetSqlConnMgr,
			{ getDatabases } as any,
		);

		const result = await orchestrator.refreshSchema({
			clusterUrl: 'https://second.kusto.windows.net',
			connectionId: 'first',
		});

		expect(result).toEqual({ schemas: [], error: 'The supplied connectionId does not match the requested cluster URL.' });
		expect(getDatabases).not.toHaveBeenCalled();
	});

	it('rejects protected schema refresh before direct metadata dispatch', async () => {
		const connection = { id: 'sensitive', name: 'Sensitive', clusterUrl: 'https://sensitive.kusto.windows.net' };
		const getDatabases = vi.fn(async () => ['SecretDb']);
		const connectionManager = {
			getConnections: () => [connection],
			getConnectionIncarnation: () => 1,
			runWithLeaveNoTraceSnapshotLock: (run: (snapshot: unknown) => Promise<unknown>) => run({
				clusterKeys: [kustoClusterKey(connection.clusterUrl)],
				globallyBlocked: false,
				revision: 1,
				revocationGenerations: { [kustoClusterKey(connection.clusterUrl)]: 1 },
			}),
		} as any;
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext,
			connectionManager,
			fakeGetSqlConnMgr,
			{
				getDatabases,
				getAccountPartition: () => 'tenant|account',
				getConnectionSessionGeneration: () => 0,
				waitForProviderAccountRefresh: vi.fn(async () => undefined),
			} as any,
		);

		const result = await orchestrator.refreshSchema({
			clusterUrl: connection.clusterUrl,
			connectionId: connection.id,
		});

		expect(result).toEqual({ schemas: [], error: expect.stringContaining('Leave No Trace') });
		expect(getDatabases).not.toHaveBeenCalled();
	});

	it('rejects agent schema dispatch when Leave No Trace wins during authentication', async () => {
		const connection = { id: 'race', name: 'Race', clusterUrl: 'https://race.kusto.windows.net' };
		let protectedNow = false;
		const sdkDispatch = vi.fn(async () => ({ databases: ['SecretDb'] }));
		const connectionManager = {
			getConnections: () => [connection],
			getConnectionIncarnation: () => 1,
			runWithLeaveNoTraceSnapshotLock: (run: (snapshot: unknown) => Promise<unknown>) => run({
				clusterKeys: protectedNow ? [kustoClusterKey(connection.clusterUrl)] : [],
				globallyBlocked: false,
				version: protectedNow ? 2 : 1,
				revocationGenerations: { [kustoClusterKey(connection.clusterUrl)]: protectedNow ? 1 : 0 },
			}),
		} as any;
		const getDatabasesWithIdentity = vi.fn(async (_connection: unknown, _refresh: boolean, options: any) => {
			protectedNow = true;
			await options.dispatchAuthenticated(
				connection, 'tenant|account', 0,
				{
					clusterKeys: [kustoClusterKey(connection.clusterUrl)], globallyBlocked: false, version: 2,
					revocationGenerations: { [kustoClusterKey(connection.clusterUrl)]: 1 },
				},
				sdkDispatch,
			);
			return { databases: ['SecretDb'], accountPartition: 'tenant|account', cacheGeneration: { global: 0, connection: 0, partition: 0 }, fromCache: false };
		});
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext,
			connectionManager,
			fakeGetSqlConnMgr,
			{
				getDatabasesWithIdentity,
				getAccountPartition: () => 'tenant|account',
				getConnectionSessionGeneration: () => 0,
				waitForProviderAccountRefresh: vi.fn(async () => undefined),
			} as any,
		);

		const result = await orchestrator.refreshSchema({ clusterUrl: connection.clusterUrl, connectionId: connection.id });

		expect(result).toEqual({ schemas: [], error: expect.stringContaining('owner changed') });
		expect(sdkDispatch).not.toHaveBeenCalled();
	});

	it('rejects protected getSchema before reading the schema cache', async () => {
		const connection = { id: 'sensitive', name: 'Sensitive', clusterUrl: 'https://sensitive.kusto.windows.net' };
		const readFile = vi.spyOn(vscode.workspace.fs, 'readFile');
		const connectionManager = {
			getConnections: () => [connection],
			getConnectionIncarnation: () => 1,
			runWithLeaveNoTraceSnapshotLock: (run: (snapshot: unknown) => Promise<unknown>) => run({
				clusterKeys: [kustoClusterKey(connection.clusterUrl)], globallyBlocked: false, version: 1,
				revocationGenerations: { [kustoClusterKey(connection.clusterUrl)]: 1 },
			}),
		} as any;
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext,
			connectionManager,
			fakeGetSqlConnMgr,
			{
				getAccountPartition: () => 'tenant|account',
				getConnectionSessionGeneration: () => 0,
				waitForProviderAccountRefresh: vi.fn(async () => undefined),
			} as any,
		);

		const result = await orchestrator.getSchema({
			clusterUrl: connection.clusterUrl,
			connectionId: connection.id,
			database: 'SecretDb',
		});

		expect(result).toEqual({ error: expect.stringContaining('Leave No Trace') });
		expect(readFile).not.toHaveBeenCalled();
	});

	it('does not enumerate cached schemas for protected connections', async () => {
		const connection = { id: 'sensitive', name: 'Sensitive', clusterUrl: 'https://sensitive.kusto.windows.net' };
		const readDirectory = vi.fn(async () => []);
		(vscode.workspace.fs as any).readDirectory = readDirectory;
		const connectionManager = {
			getConnections: () => [connection],
			getConnectionIncarnation: () => 1,
			runWithLeaveNoTraceSnapshotLock: (run: (snapshot: unknown) => Promise<unknown>) => run({
				clusterKeys: [kustoClusterKey(connection.clusterUrl)], globallyBlocked: false, version: 1,
				revocationGenerations: { [kustoClusterKey(connection.clusterUrl)]: 1 },
			}),
		} as any;
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext,
			connectionManager,
			fakeGetSqlConnMgr,
			{
				getAccountPartition: () => 'tenant|account',
				getConnectionSessionGeneration: () => 0,
				waitForProviderAccountRefresh: vi.fn(async () => undefined),
			} as any,
		);

		const result = await orchestrator.searchCachedSchemas({ pattern: 'secret' });

		expect(result).toEqual({ matches: [], count: 0, pattern: 'secret' });
		expect(readDirectory).not.toHaveBeenCalled();
	});

	it('rejects a cached schema when Leave No Trace wins during disk read', async () => {
		const connection = { id: 'race', name: 'Race', clusterUrl: 'https://race.kusto.windows.net' };
		const accountPartition = 'tenant|account';
		const pendingRead = deferred<Uint8Array>();
		vi.spyOn(vscode.workspace.fs, 'stat').mockResolvedValue({ type: vscode.FileType.File, ctime: 1, mtime: 1, size: 100 });
		vi.spyOn(vscode.workspace.fs, 'readFile').mockReturnValue(pendingRead.promise);
		let protectedNow = false;
		const connectionManager = {
			getConnections: () => [connection],
			getConnectionIncarnation: () => 1,
			runWithLeaveNoTraceSnapshotLock: (run: (snapshot: unknown) => Promise<unknown>) => run({
				clusterKeys: protectedNow ? [kustoClusterKey(connection.clusterUrl)] : [],
				globallyBlocked: false,
				version: protectedNow ? 2 : 1,
				revocationGenerations: { [kustoClusterKey(connection.clusterUrl)]: protectedNow ? 1 : 0 },
			}),
		} as any;
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext,
			connectionManager,
			fakeGetSqlConnMgr,
			{
				getAccountPartition: () => accountPartition,
				getConnectionSessionGeneration: () => 0,
				waitForProviderAccountRefresh: vi.fn(async () => undefined),
			} as any,
		);

		const read = orchestrator.getSchema({
			clusterUrl: connection.clusterUrl,
			connectionId: connection.id,
			database: 'SecretDb',
		});
		await vi.waitFor(() => expect(vscode.workspace.fs.readFile).toHaveBeenCalledOnce());
		protectedNow = true;
		pendingRead.resolve(Buffer.from(JSON.stringify({
			version: SCHEMA_CACHE_VERSION,
			schema: { tables: ['SecretTable'], columnTypesByTable: {}, functions: [] },
			timestamp: Date.now(), clusterUrl: connection.clusterUrl, database: 'SecretDb',
			connectionId: connection.id, accountPartition,
		}), 'utf8'));

		await expect(read).resolves.toEqual({ error: expect.stringContaining('owner changed') });
	});

	it('routes authority-specific schema refresh through the canonical direct path with the exact connectionId', async () => {
		const generation = { global: 0, connection: 0, partition: 0 };
		const getDatabasesWithIdentity = vi.fn(async (connection: { id: string }) => ({
			databases: ['GuestDb'], accountPartition: `partition-${connection.id}`, cacheGeneration: generation, fromCache: false,
		}));
		const getDatabaseSchema = vi.fn(async (connection: { id: string }) => ({
			schema: { tables: ['GuestTable'], functions: [] }, fromCache: false,
			accountPartition: `partition-${connection.id}`, cacheGeneration: generation,
		}));
		const activeRefresher = vi.fn(async () => ({
			schemas: [{ clusterUrl: 'shared', database: 'GuestDb', tables: ['GuestTable'], functions: [] }],
		}));
		const laterRefresher = vi.fn(async () => ({ schemas: [] }));
		const connectionManager = {
			getConnections: () => [
				{ id: 'home', name: 'Home tenant', clusterUrl: 'https://shared.kusto.windows.net', authorityId: 'home.onmicrosoft.com' },
				{ id: 'guest', name: 'Guest tenant', clusterUrl: 'shared', authorityId: 'resource.onmicrosoft.com' },
			],
			getConnectionIncarnation: () => 1,
			runWithLeaveNoTraceSnapshotLock: (run: (snapshot: unknown) => Promise<unknown>) => run({
				clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {},
			}),
		} as any;
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext,
			connectionManager,
			fakeGetSqlConnMgr,
			{
				getDatabasesWithIdentity,
				getDatabaseSchema,
				getAccountPartition: (connection: { id: string }) => `partition-${connection.id}`,
				getConnectionSessionGeneration: () => 0,
				waitForProviderAccountRefresh: vi.fn(async () => undefined),
			} as any,
		);
		const activeUri = vscode.Uri.file('/work/active.kqlx');
		const laterUri = vscode.Uri.file('/work/later.kqlx');
		orchestrator.connect(vi.fn(), vi.fn(async () => []), activeRefresher, activeUri.toString());
		orchestrator.connect(vi.fn(), vi.fn(async () => []), laterRefresher, laterUri.toString());
		setActiveCustomTab(activeUri, 'kusto.kqlxEditor');

		const result = await orchestrator.refreshSchema({
			clusterUrl: 'https://shared.kusto.windows.net',
			connectionId: 'guest',
		});

		expect(activeRefresher).not.toHaveBeenCalled();
		expect(laterRefresher).not.toHaveBeenCalled();
		expect(getDatabasesWithIdentity).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'guest', authorityId: 'resource.onmicrosoft.com' }),
			true,
			expect.objectContaining({ persistCache: false }),
		);
		expect(getDatabaseSchema).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'guest', authorityId: 'resource.onmicrosoft.com' }),
			'GuestDb',
			true,
			expect.objectContaining({ persistCache: false }),
		);
		expect(result.schemas[0]).toMatchObject({ database: 'GuestDb', tables: ['GuestTable'] });
	});

	it('listSections uses the active .kql Workbench file instead of the later-connected notebook', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const kqlUri = vscode.Uri.file('/work/active-query.kql');
		const notebookUri = vscode.Uri.file('/work/later-notebook.kqlx');
		const kqlStateGetter = vi.fn(async () => [{ id: 'active_query', type: 'query', name: 'Active query' }]);
		const notebookStateGetter = vi.fn(async () => [{ id: 'notebook_query', type: 'query', name: 'Later notebook' }]);

		orch.connect(vi.fn(), kqlStateGetter, vi.fn(), kqlUri.toString());
		orch.connect(vi.fn(), notebookStateGetter, vi.fn(), notebookUri.toString());
		setActiveCustomTab(kqlUri, 'kusto.kqlCompatEditor');

		const result = await orch.listSections();

		expect(kqlStateGetter).toHaveBeenCalledTimes(1);
		expect(notebookStateGetter).toHaveBeenCalledTimes(1);
		expect(result.fileName).toBe('active-query.kql');
		expect(result.sections[0].id).toBe('active_query');
		expect(result.openFiles).toEqual(expect.arrayContaining([
			expect.objectContaining({ fileName: 'active-query.kql', fileKind: 'kql', isActive: true, isLiveWorkbench: true }),
			expect.objectContaining({ fileName: 'later-notebook.kqlx', isActive: false, isLiveWorkbench: true })
		]));
	});

	it('configureQuerySection posts to the active .kql Workbench file instead of the later-connected notebook', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const kqlUri = vscode.Uri.file('/work/active-query.kql');
		const notebookUri = vscode.Uri.file('/work/later-notebook.kqlx');
		const kqlPoster = vi.fn();
		const notebookPoster = vi.fn();

		orch.connect(kqlPoster, vi.fn(async () => [{ id: 'active_query', type: 'query' }]), vi.fn(), kqlUri.toString());
		orch.connect(notebookPoster, vi.fn(async () => [{ id: 'notebook_query', type: 'query' }]), vi.fn(), notebookUri.toString());
		setActiveCustomTab(kqlUri, 'kusto.kqlCompatEditor');

		const configurePromise = orch.configureQuerySection({ sectionId: 'active_query', query: 'print 1' });

		expect(kqlPoster).toHaveBeenCalledTimes(1);
		expect(notebookPoster).not.toHaveBeenCalled();
		const postedMessage = kqlPoster.mock.calls[0][0] as any;
		expect(postedMessage.type).toBe('toolConfigureQuerySection');
		expect(postedMessage.input.sectionId).toBe('active_query');
		orch.handleWebviewResponse(postedMessage.requestId, { success: true });
		await expect(configurePromise).resolves.toEqual({ success: true });
	});

	it('cancels the exact acknowledged Kusto execution on the captured editor', async () => {
		const connection = { id: 'connection-1', clusterUrl: 'https://cluster.kusto.windows.net' };
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, { getConnections: () => [connection] } as any, fakeGetSqlConnMgr, fakeKustoClient);
		const uri = vscode.Uri.file('/work/active-query.kqlx');
		const poster = createMessagePoster();
		orch.connect(poster, async () => [{ id: 'query_1', type: 'query', connectionId: connection.id,
			clusterUrl: connection.clusterUrl, database: 'Samples', sectionInstanceId: 'instance-1', targetGeneration: 1 }],
		vi.fn(), uri.toString(), undefined, undefined, undefined, undefined, undefined, undefined, undefined,
		async onReady => onReady(() => true));
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const cancellation = cancellationToken();

		const configurePromise = orch.configureQuerySection({ sectionId: 'query_1', query: 'range x from 1 to 10 step 1', execute: true }, cancellation.token);
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		const configureMessage = poster.mock.calls[0][0] as any;
		const owner = {
			engine: 'kusto', boxId: 'query_1', executionId: 'execution-1', sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples', producer: 'tool',
		};
		orch.handleKustoExecutionStarted(configureMessage.requestId, owner as any);
		cancellation.cancel();

		await expect(configurePromise).rejects.toBeInstanceOf(vscode.CancellationError);
		expect(poster).toHaveBeenCalledWith({
			type: 'toolCancelKustoExecution', requestId: configureMessage.requestId, owner,
		});
	});

	it('sends a request-scoped cancellation when cancellation wins before Kusto execution acknowledgement', async () => {
		const connection = { id: 'connection-1', clusterUrl: 'https://cluster.kusto.windows.net' };
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, { getConnections: () => [connection] } as any, fakeGetSqlConnMgr, fakeKustoClient);
		const uri = vscode.Uri.file('/work/active-query.kqlx');
		const poster = createMessagePoster();
		orch.connect(poster, async () => [{ id: 'query_1', type: 'query', connectionId: connection.id,
			clusterUrl: connection.clusterUrl, database: 'Samples', sectionInstanceId: 'instance-1', targetGeneration: 1 }],
		vi.fn(), uri.toString(), undefined, undefined, undefined, undefined, undefined, undefined, undefined,
		async onReady => onReady(() => true));
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const cancellation = cancellationToken();

		const configurePromise = orch.configureQuerySection({ sectionId: 'query_1', query: 'range x from 1 to 10 step 1', execute: true }, cancellation.token);
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		const configureMessage = poster.mock.calls[0][0] as any;
		cancellation.cancel();

		await expect(configurePromise).rejects.toBeInstanceOf(vscode.CancellationError);
		expect(poster).toHaveBeenCalledWith({
			type: 'toolCancelKustoExecution', requestId: configureMessage.requestId,
		});
	});

	it('listSections reports an active supported text file as read-only instead of using a hidden live notebook', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const kqlUri = vscode.Uri.file('/work/plain-text-query.kql');
		const hiddenNotebookUri = vscode.Uri.file('/work/hidden-notebook.kqlx');
		const hiddenStateGetter = vi.fn(async () => [{ id: 'hidden_query', type: 'query' }]);

		orch.connect(vi.fn(), hiddenStateGetter, vi.fn(), hiddenNotebookUri.toString());
		setActiveTextDocument(kqlUri);

		const result = await orch.listSections();

		expect(hiddenStateGetter).toHaveBeenCalledTimes(1);
		expect(result.sections).toEqual([]);
		expect(result.fileName).toBe('plain-text-query.kql');
		expect(result.openFiles).toEqual(expect.arrayContaining([
			expect.objectContaining({ fileName: 'plain-text-query.kql', fileKind: 'kql', isActive: true, isLiveWorkbench: false, isReadOnlyFallback: true }),
			expect.objectContaining({ fileName: 'hidden-notebook.kqlx', isActive: false, isLiveWorkbench: true, sections: [expect.objectContaining({ id: 'hidden_query' })] })
		]));
	});

	it('configureQuerySection does not post to a hidden live notebook when the active supported file is read-only fallback', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const kqlUri = vscode.Uri.file('/work/plain-text-query.kql');
		const hiddenNotebookUri = vscode.Uri.file('/work/hidden-notebook.kqlx');
		const hiddenPoster = vi.fn();

		orch.connect(hiddenPoster, vi.fn(async () => [{ id: 'hidden_query', type: 'query' }]), vi.fn(), hiddenNotebookUri.toString());
		setActiveTextDocument(kqlUri);

		const configurePromise = orch.configureQuerySection({ sectionId: 'hidden_query', query: 'print 2' });
		if (hiddenPoster.mock.calls.length > 0) {
			const postedMessage = hiddenPoster.mock.calls[0][0] as any;
			orch.handleWebviewResponse(postedMessage.requestId, { success: true });
		}

		expect(hiddenPoster).not.toHaveBeenCalled();
		await expect(configurePromise).rejects.toThrow('active Kusto Workbench file');
	});

	it('disconnectIfOwner removes a stale registry entry without disconnecting the newer active file', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const staleUri = vscode.Uri.file('/work/stale.kql');
		const activeUri = vscode.Uri.file('/work/active.csl');
		const staleStateGetter = vi.fn(async () => [{ id: 'stale_query', type: 'query' }]);
		const activeStateGetter = vi.fn(async () => [{ id: 'active_csl', type: 'query' }]);

		const staleToken = orch.connect(vi.fn(), staleStateGetter, vi.fn(), staleUri.toString());
		orch.connect(vi.fn(), activeStateGetter, vi.fn(), activeUri.toString());
		orch.disconnectIfOwner(staleToken);
		setActiveCustomTab(staleUri, 'kusto.kqlCompatEditor');

		const staleResult = await orch.listSections();
		expect(staleStateGetter).not.toHaveBeenCalled();
		expect(staleResult.sections).toEqual([]);
		expect(staleResult.openFiles).toEqual(expect.arrayContaining([
			expect.objectContaining({ fileName: 'stale.kql', isActive: true, isLiveWorkbench: false, isReadOnlyFallback: true })
		]));

		setActiveCustomTab(activeUri, 'kusto.kqlCompatEditor');
		const activeResult = await orch.listSections();
		expect(activeStateGetter).toHaveBeenCalledTimes(2);
		expect(activeResult.sections[0].id).toBe('active_csl');
	});

	it('does not treat an inactive editor group Workbench tab as the active target', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const unsupportedUri = vscode.Uri.file('/work/readme.txt');
		const backgroundUri = vscode.Uri.file('/work/background.kqlx');
		const backgroundPoster = vi.fn();
		const backgroundStateGetter = vi.fn(async () => [{ id: 'background_query', type: 'query' }]);
		const unsupportedTab = { isActive: true, input: new vscode.TabInputText(unsupportedUri), label: 'readme.txt' };
		const backgroundTab = { isActive: true, input: new vscode.TabInputCustom(backgroundUri, 'kusto.kqlxEditor'), label: 'background.kqlx' };

		orch.connect(backgroundPoster, backgroundStateGetter, vi.fn(), backgroundUri.toString());
		setTabGroups(
			{ activeTab: unsupportedTab, tabs: [unsupportedTab], isActive: true },
			{ activeTab: backgroundTab, tabs: [backgroundTab], isActive: false }
		);

		const result = await orch.listSections();
		expect(backgroundStateGetter).toHaveBeenCalledTimes(1);
		expect(result.sections).toEqual([]);
		expect(result.fileName).toBeUndefined();
		expect(result.openFiles).toEqual(expect.arrayContaining([
			expect.objectContaining({ fileName: 'background.kqlx', isActive: false, isLiveWorkbench: true, sections: [expect.objectContaining({ id: 'background_query' })] })
		]));

		const configurePromise = orch.configureQuerySection({ sectionId: 'background_query', query: 'print 3' });
		expect(backgroundPoster).not.toHaveBeenCalled();
		await expect(configurePromise).rejects.toThrow('Kusto Workbench is not currently open');
	});

	it('routes SQL tools to the active .sql Workbench compatibility file', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const sqlUri = vscode.Uri.file('/work/query.sql');
		const notebookUri = vscode.Uri.file('/work/later-notebook.kqlx');
		const sqlPoster = createMessagePoster();
		const notebookPoster = vi.fn();
		const sqlStateGetter = vi.fn(async () => [{ id: 'sql_1', type: 'sql', name: 'SQL', serverUrl: 'server.example', database: 'db' }]);
		const notebookStateGetter = vi.fn(async () => [{ id: 'notebook_query', type: 'query' }]);

		orch.connect(sqlPoster, sqlStateGetter, vi.fn(), sqlUri.toString(), sectionId => sectionId === 'sql_1' ? 'sql-test' : undefined);
		orch.connect(notebookPoster, notebookStateGetter, vi.fn(), notebookUri.toString());
		setActiveCustomTab(sqlUri, 'kusto.sqlCompatEditor');

		const result = await orch.listSections();
		expect(sqlStateGetter).toHaveBeenCalledTimes(1);
		expect(notebookStateGetter).toHaveBeenCalledTimes(1);
		expect(result.sections[0]).toMatchObject({ id: 'sql_1', type: 'sql', serverUrl: 'server.example', database: 'db' });
		expect(result.fileName).toBe('query.sql');

		const configurePromise = orch.configureSqlSection({ sectionId: 'sql_1', query: 'select 1' });
		await vi.waitFor(() => expect(sqlPoster).toHaveBeenCalledTimes(1));
		expect(notebookPoster).not.toHaveBeenCalled();
		const postedMessage = sqlPoster.mock.calls[0][0] as any;
		expect(postedMessage.type).toBe('toolConfigureSqlSection');
		orch.handleWebviewResponse(postedMessage.requestId, { success: true });
		await expect(configurePromise).resolves.toEqual({ success: true });
	});

	it('rejects SQL tool success when the same connection ID changes target before response admission', async () => {
		let connection = {
			id: 'sql-test', name: 'SQL', serverUrl: 'server-a.example', dialect: 'mssql', authType: 'aad',
		};
		const sqlManager = {
			getConnections: () => [connection],
			getConnection: () => connection,
			assertConnectionCurrent: vi.fn(async () => undefined),
		} as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient);
		const poster = createMessagePoster();
		orch.connect(poster, vi.fn(async () => [{ id: 'sql_1', type: 'sql' }]), vi.fn(), undefined, () => 'sql-test');

		const request = orch.configureSqlSection({ sectionId: 'sql_1', connectionId: 'sql-test', query: 'SELECT 1' });
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		const message = poster.mock.calls[0][0] as any;
		connection = { ...connection, serverUrl: 'server-b.example' };
		orch.handleWebviewResponse(message.requestId, { success: true });

		await expect(request).rejects.toThrow('target changed during tool execution');
	});

	it('admits configure-and-execute against the post-adoption SQL owner', async () => {
		const connectionA = {
			id: 'sql-a', name: 'SQL A', serverUrl: 'server-a.example', dialect: 'mssql', authType: 'sql-login', username: 'user-a',
		};
		const connectionB = {
			id: 'sql-b', name: 'SQL B', serverUrl: 'server-b.example', dialect: 'mssql', authType: 'sql-login', username: 'user-b',
		};
		const sqlManager = {
			getConnections: () => [connectionA, connectionB],
			getConnection: (id: string) => id === connectionA.id ? connectionA : id === connectionB.id ? connectionB : undefined,
			assertConnectionCurrent: vi.fn(async () => undefined),
		} as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient);
		const poster = createMessagePoster();
		let liveOwner = { connectionId: 'sql-a', database: 'DbA', ownerToken: 'owner-a', generation: 1 };
		const captureSqlSectionAdmission = vi.fn(() => () => false);
		orch.connect(
			poster,
			vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: liveOwner.database, ownerToken: liveOwner.ownerToken }]),
			vi.fn(), undefined,
			() => liveOwner.connectionId,
			() => ({ ...liveOwner }),
			undefined, undefined, undefined, undefined, undefined, undefined, undefined, captureSqlSectionAdmission,
		);

		const request = orch.configureSqlSection({
			sectionId: 'sql_1', connectionId: 'sql-b', database: 'DbB', query: 'SELECT 1', execute: true,
		});
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		const message = poster.mock.calls[0][0] as any;
		expect(message.input.resolvedConnection.id).toBe('sql-b');
		expect(message.input.expectedExecutionOwner).toMatchObject({ connectionId: 'sql-b', database: 'DbB' });
		liveOwner = { connectionId: 'sql-b', database: 'DbB', ownerToken: 'owner-b', generation: 2 };
		orch.handleWebviewResponse(message.requestId, {
			success: true, resultPreview: '1 row', executionId: message.input.executionId, executionOwner: { ...liveOwner },
		});

		await expect(request).resolves.toEqual({ success: true, resultPreview: '1 row' });
		expect(captureSqlSectionAdmission).not.toHaveBeenCalled();
	});

	it('dispatches SQL configuration to the editor captured before asynchronous preflight', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'aad' };
		const preflight = deferred<void>();
		const assertAllowed = vi.fn(async () => preflight.promise);
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient, undefined, assertAllowed);
		const firstPoster = createMessagePoster();
		const secondPoster = vi.fn();
		orch.connect(firstPoster, vi.fn(async () => [{ id: 'sql_1', type: 'sql' }]), vi.fn(), undefined, () => 'sql-test');

		const request = orch.configureSqlSection({ sectionId: 'sql_1', connectionId: 'sql-test', query: 'SELECT 1' });
		await vi.waitFor(() => expect(assertAllowed).toHaveBeenCalled());
		orch.connect(secondPoster, vi.fn(async () => [{ id: 'sql_2', type: 'sql' }]), vi.fn(), undefined, () => 'sql-test');
		preflight.resolve();

		await vi.waitFor(() => expect(firstPoster).toHaveBeenCalledOnce());
		expect(secondPoster).not.toHaveBeenCalled();
		const message = firstPoster.mock.calls[0][0] as any;
		orch.handleWebviewResponse(message.requestId, { success: true });
		await expect(request).resolves.toEqual({ success: true });
	});

	it('does not acquire an editor that opens after SQL configuration starts without one', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'aad' };
		const assertAllowed = vi.fn(async () => undefined);
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient, undefined, assertAllowed);
		const latePoster = vi.fn(() => true);

		const request = orch.configureSqlSection({ sectionId: 'sql_1', connectionId: 'sql-test', query: 'SELECT 1' });
		orch.connect(latePoster, vi.fn(async () => [{ id: 'sql_1', type: 'sql' }]), vi.fn(), undefined, () => 'sql-test');

		await expect(request).rejects.toThrow('not currently open with a live editor');
		expect(assertAllowed).not.toHaveBeenCalled();
		expect(latePoster).not.toHaveBeenCalled();
	});

	it('does not dispatch SQL configuration when cancellation occurs during preflight', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'aad' };
		const preflight = deferred<void>();
		const assertAllowed = vi.fn(async () => preflight.promise);
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient, undefined, assertAllowed);
		const poster = vi.fn(() => true);
		orch.connect(poster, vi.fn(async () => [{ id: 'sql_1', type: 'sql' }]), vi.fn(), undefined, () => 'sql-test');
		const cancellation = cancellationToken();

		const request = orch.configureSqlSection({ sectionId: 'sql_1', connectionId: 'sql-test', query: 'SELECT 1' }, cancellation.token);
		await vi.waitFor(() => expect(assertAllowed).toHaveBeenCalled());
		cancellation.cancel();
		preflight.resolve();

		await expect(request).rejects.toMatchObject({ name: 'Canceled' });
		expect(poster).not.toHaveBeenCalled();
	});

	it('rejects when the captured editor closes during preflight before dispatch registration', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'aad' };
		const preflight = deferred<void>();
		const assertAllowed = vi.fn(async () => preflight.promise);
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient, undefined, assertAllowed);
		const poster = vi.fn(() => true);
		const token = orch.connect(poster, vi.fn(async () => [{ id: 'sql_1', type: 'sql' }]), vi.fn(), undefined, () => 'sql-test');

		const request = orch.configureSqlSection({ sectionId: 'sql_1', connectionId: 'sql-test', query: 'SELECT 1' });
		await vi.waitFor(() => expect(assertAllowed).toHaveBeenCalled());
		orch.disconnectIfOwner(token);
		preflight.resolve();

		await expect(request).rejects.toThrow('closed before the request was dispatched');
		expect(poster).not.toHaveBeenCalled();
	});

	it('rejects when the captured editor refuses post delivery', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'aad' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient);
		const poster = vi.fn(() => false);
		orch.connect(poster, vi.fn(async () => [{ id: 'sql_1', type: 'sql' }]), vi.fn(), undefined, () => 'sql-test');

		await expect(orch.configureSqlSection({ sectionId: 'sql_1', connectionId: 'sql-test', query: 'SELECT 1' }))
			.rejects.toThrow('rejected the request');
	});

	it('rejects an unbounded pending tool request when its editor disconnects', async () => {
		const connection = {
			id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user',
		};
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient);
		const poster = createMessagePoster();
		const owner = { connectionId: 'sql-test', database: 'Db', ownerToken: 'owner-token', generation: 1 };
		const token = orch.connect(
			poster, vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'Db' }]), vi.fn(), undefined,
			() => 'sql-test', () => ({ ...owner }),
		);
		vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ get: vi.fn(() => 0) } as any);

		const request = orch.configureSqlSection({ sectionId: 'sql_1', connectionId: 'sql-test', database: 'Db', query: 'WAITFOR DELAY', execute: true });
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		orch.disconnectIfOwner(token);

		await expect(request).rejects.toThrow('editor closed');
	});

	it('keeps an unbounded pending tool request alive when its editor is reactivated', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient);
		const poster = createMessagePoster();
		const owner = { connectionId: 'sql-test', database: 'Db', ownerToken: 'owner-token', generation: 1 };
		const token = orch.connect(
			poster, vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'Db' }]), vi.fn(), undefined,
			() => 'sql-test', () => ({ ...owner }),
		);
		vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ get: vi.fn(() => 0) } as any);

		const request = orch.configureSqlSection({ sectionId: 'sql_1', connectionId: 'sql-test', database: 'Db', query: 'WAITFOR DELAY', execute: true });
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		orch.activateConnection(token);
		const message = poster.mock.calls[0][0] as any;
		orch.handleWebviewResponse(message.requestId, { success: true, executionId: message.input.executionId, executionOwner: { ...owner } });

		await expect(request).resolves.toEqual({ success: true });
	});

	it('cancels only the execution ID minted for the pending SQL tool request', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient);
		const poster = createMessagePoster();
		const owner = { connectionId: 'sql-test', database: 'Db', ownerToken: 'owner-token', generation: 1 };
		orch.connect(
			poster, vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'Db' }]), vi.fn(), undefined,
			() => 'sql-test', () => ({ ...owner }),
		);
		const cancellation = cancellationToken();

		const request = orch.configureSqlSection({
			sectionId: 'sql_1', connectionId: 'sql-test', database: 'Db', query: 'WAITFOR DELAY', execute: true,
		}, cancellation.token);
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		const configureMessage = poster.mock.calls[0][0] as any;
		cancellation.cancel();

		await expect(request).rejects.toMatchObject({ name: 'Canceled' });
		expect(poster).toHaveBeenCalledWith({
			type: 'toolCancelSqlExecution', requestId: configureMessage.requestId,
			sectionId: 'sql_1', executionId: configureMessage.input.executionId,
		});
	});

	it('rejects SQL retarget-and-execute without a database before webview dispatch', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient);
		const poster = vi.fn(() => true);
		orch.connect(
			poster, vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'DbA' }]), vi.fn(), undefined,
			() => 'sql-other', () => ({ connectionId: 'sql-other', database: 'DbA', ownerToken: 'owner-a', generation: 1 }),
		);

		await expect(orch.configureSqlSection({
			sectionId: 'sql_1', connectionId: 'sql-test', query: 'SELECT 1', execute: true,
		})).rejects.toThrow('database is required when retargeting and executing a SQL section.');
		expect(poster).not.toHaveBeenCalled();
	});

	it('omits protected SQL connections and sections from tool inventory', async () => {
		const sqlManager = {
			getConnections: () => [{ id: 'sql-sensitive', name: 'Sensitive', serverUrl: 'secret.example', dialect: 'mssql' }],
		} as any;
		const refreshPolicy = vi.fn(async () => ['sql-sensitive']);
		const assertAllowed = vi.fn(async () => { throw new Error('Leave No Trace blocked'); });
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext,
			fakeConnectionManager,
			() => sqlManager,
			fakeKustoClient,
			refreshPolicy,
			assertAllowed,
		);
		const poster = vi.fn();
		orch.connect(
			poster,
			vi.fn(async () => [{ id: 'sql_1', type: 'sql', serverUrl: 'secret.example', database: 'SecretDb' }]),
			vi.fn(),
			undefined,
			() => 'sql-sensitive',
		);

		expect(await orch.listSqlConnections()).toEqual({ connections: [] });
		expect((await orch.listSections()).sections).toEqual([]);
		await expect(orch.configureSqlSection({ sectionId: 'sql_1', query: 'SELECT 1' })).rejects.toThrow('Leave No Trace blocked');
		expect(poster).not.toHaveBeenCalled();
	});

	it('lists the real unconfigured SQL section after background CREATE and SAVE without handing off ownership', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const uri = vscode.Uri.file('/work/background-unconfigured-sql.sqlx');
		await orch.createFile({ fileType: 'sqlx', filePath: uri.fsPath, initialContent: 'SELECT 1 AS Probe', reveal: false });
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const source = (vscode as any).__mockFileSystem.readText(uri);
		(vscode.workspace as any).textDocuments = [{ uri, version: 1, isDirty: false, getText: () => source }];
		const stateGetter = vi.fn(async () => [{ id: 'sql_runtime', type: 'sql', query: 'SELECT 1 AS Probe' }]);
		const resolver = vi.fn(() => undefined);
		const poster = vi.fn(() => true);
		orch.connect(poster, stateGetter, vi.fn(), uri.toString(), resolver);
		await expect(orch.saveWorkbenchFile({ targetFileUri: uri.toString() })).resolves.toMatchObject({ success: true });

		const result = await orch.listSections();

		expect(result.sections).toEqual([]);
		const listed = result.openFiles?.find(file => file.uri === uri.toString());
		expect(listed?.isLiveWorkbench).toBe(true);
		expect(listed?.sections).toEqual([{ id: 'sql_runtime', type: 'sql' }]);
		expect(stateGetter).toHaveBeenCalledOnce();
		expect(resolver).toHaveReturnedWith(undefined);
		expect(poster).not.toHaveBeenCalled();
		expect(orch.isHostOwnedBackgroundFile(uri)).toBe(true);
		expect((vscode as any).__mockFileSystem.readText(uri)).toBe(source);
	});

	it.each([false, true])('configures the advertised SQL structural ID after CREATE SAVE LIST (changed=%s)', async changed => {
		const harness = await createBackgroundSqlSeedHarness(`configure-${changed}`);
		const { orchestrator, input, connection, document, source, applyEdit, stateGetter, poster } = harness;

		await expect(orchestrator.configureSqlSection({
			...input, query: 'SELECT 1 AS Probe',
			...(changed ? { name: 'Configured probe', connectionId: connection.id, database: 'ProbeDb' } : {}),
		})).resolves.toEqual({ success: true });

		expect(stateGetter).toHaveBeenCalledOnce();
		expect(applyEdit).toHaveBeenCalledTimes(changed ? 1 : 0);
		const sections = JSON.parse(document.getText()).state.sections;
		expect(sections).toHaveLength(1);
		expect(sections[0].query).toBe('SELECT 1 AS Probe');
		if (changed) {
			expect(sections[0]).toMatchObject({ id: input.sectionId, name: 'Configured probe', serverUrl: connection.serverUrl,
				connectionIdHint: connection.id, database: 'ProbeDb' });
			expect(stateGetter.mock.invocationCallOrder[0]).toBeLessThan(harness.assertAllowed.mock.invocationCallOrder[0]);
		} else {
			expect(document.getText()).toBe(source);
			expect(sections[0].id).toBeUndefined();
		}
		expect(poster).not.toHaveBeenCalled();
		expect(orchestrator.isHostOwnedBackgroundFile(harness.uri)).toBe(true);
	});

	it.each(['wrong-id', 'missing-runtime-callback', 'missing-proof-callback', 'source-changed', 'mapped'])(
		'refuses an unproved SQL structural alias without source effects (%s)', async kind => {
			const harness = await createBackgroundSqlSeedHarness(`unproved-${kind}`);
			const { orchestrator, input, document, source, stateGetter, resolver, token, applyEdit, poster } = harness;
			if (kind === 'missing-runtime-callback') Reflect.deleteProperty(Reflect.get(orchestrator, 'liveConnections').get(token), 'captureStateAdmission');
			if (kind === 'missing-proof-callback') vi.spyOn(orchestrator as any, 'getSectionsForConnection')
				.mockResolvedValueOnce([{ id: input.sectionId, type: 'sql' }]);
			if (kind === 'source-changed') harness.setText(source + ' ');
			if (kind === 'mapped') resolver.mockReturnValue(harness.connection.id);
			const expected = document.getText();

			await expect(orchestrator.configureSqlSection({ ...input, sectionId: kind === 'wrong-id' ? 'sql_absent' : input.sectionId,
				name: 'Must not apply', connectionId: harness.connection.id, database: 'ProbeDb' })).resolves.toEqual({ success: false });

			expect(applyEdit).not.toHaveBeenCalled();
			expect(poster).not.toHaveBeenCalled();
			expect(harness.assertAllowed).not.toHaveBeenCalled();
			expect(document.getText()).toBe(expected);
			expect(orchestrator.isHostOwnedBackgroundFile(harness.uri)).toBe(true);
			if (kind === 'source-changed' || kind === 'missing-runtime-callback') expect(stateGetter).not.toHaveBeenCalled();
		},
	);

	it.each(['proof', 'lock'].flatMap(phase =>
		['version-aba', 'document', 'runtime', 'mapping', 'ownership', 'connection', 'materialized-id', 'cancel'].map(kind => ({ phase, kind })),
	))('rejects an SQL structural alias invalidated during $phase ($kind)', async ({ phase, kind }) => {
		const harness = await createBackgroundSqlSeedHarness(`race-${phase}-${kind}`);
		const { orchestrator, input, uri, document, source, applyEdit, poster } = harness;
		const entered = deferred<void>(), release = deferred<void>();
		let lock: Promise<void> | undefined;
		if (phase === 'proof') {
			vi.spyOn(orchestrator as any, 'waitForBackgroundFileOperation').mockImplementationOnce(async () => {
				entered.resolve();
				await release.promise;
			});
		} else {
			const runWithLock = kqlxEditor.withKqlxDocumentWriteLock;
			const locked = deferred<void>();
			lock = runWithLock(uri, async () => { locked.resolve(); await release.promise; });
			await locked.promise;
			vi.spyOn(kqlxEditor, 'withKqlxDocumentWriteLock').mockImplementation(<T>(lockUri: vscode.Uri, work: () => Promise<T>) => {
				const pending = runWithLock(lockUri, work);
				entered.resolve();
				return pending;
			});
		}
		const cancellation = cancellationToken();
		const configuration = orchestrator.configureSqlSection({ ...input, name: 'Must not apply',
			connectionId: harness.connection.id, database: 'ProbeDb' }, cancellation.token)
			.then(value => ({ value }), error => ({ error }));
		let transfer: Promise<void> | undefined;
		try {
			await entered.promise;
			if (phase === 'proof') expect(harness.assertAllowed).not.toHaveBeenCalled();
			else expect(harness.assertAllowed).toHaveBeenCalledOnce();
			if (kind === 'version-aba') { harness.setText(source + ' '); harness.setText(source); }
			if (kind === 'document') (vscode.workspace as any).textDocuments = [{ ...document }];
			if (kind === 'runtime') harness.current.mockReturnValue(false);
			if (kind === 'mapping') harness.resolver.mockReturnValue(harness.connection.id);
			if (kind === 'ownership') transfer = orchestrator.transferBackgroundOwnershipOnUserInteraction(uri);
			if (kind === 'connection') orchestrator.disconnectIfOwner(harness.token);
			if (kind === 'materialized-id') {
				const file = JSON.parse(source);
				file.state.sections[0].id = input.sectionId;
				harness.setText(JSON.stringify(file));
			}
			if (kind === 'cancel') cancellation.cancel();
			const expected = document.getText();
			release.resolve();

			const result = await configuration;
			if (kind === 'cancel') expect(result).toMatchObject({ error: { name: 'Canceled' } });
			else expect(result).toEqual({ value: { success: false } });
			expect(applyEdit).not.toHaveBeenCalled();
			expect(poster).not.toHaveBeenCalled();
			expect(document.getText()).toBe(expected);
			if (kind !== 'ownership') expect(orchestrator.isHostOwnedBackgroundFile(uri)).toBe(true);
		} finally {
			release.resolve();
			await configuration;
			await lock;
			await transfer;
		}
	});

	it.each(['structural', 'persisted'].flatMap(sourceId =>
		['protected', 'enable-disable', 'removed', 'retargeted', 'credential-revision', 'cancel', 'unchanged-copy'].map(change => ({ sourceId, change })),
	))('fences queued requested SQL connections for $sourceId ($change)', async ({ sourceId, change }) => {
		const harness = await createBackgroundSqlSeedHarness(`requested-${sourceId}-${change}`);
		const { orchestrator, connection, sqlManager, uri, document, applyEdit, poster } = harness;
		const sectionId = sourceId === 'structural' ? harness.input.sectionId : 'sql_persisted';
		if (sourceId === 'persisted') {
			const file = JSON.parse(document.getText());
			file.state.sections[0].id = sectionId;
			file.state.sections.push({ id: 'other_sql', type: 'sql', query: 'SELECT 2 AS Other', name: 'Keep' });
			harness.setText(JSON.stringify(file));
		}
		const before = { text: document.getText(), version: document.version, dirty: document.isDirty };
		const diskBefore = (vscode as any).__mockFileSystem.readText(uri);
		const runWithLock = kqlxEditor.withKqlxDocumentWriteLock;
		const locked = deferred<void>(), queued = deferred<void>(), release = deferred<void>();
		const lock = runWithLock(uri, async () => { locked.resolve(); await release.promise; });
		await locked.promise;
		vi.spyOn(kqlxEditor, 'withKqlxDocumentWriteLock').mockImplementation(<T>(lockUri: vscode.Uri, work: () => Promise<T>) => {
			const pending = runWithLock(lockUri, work);
			queued.resolve();
			return pending;
		});
		const cancellation = cancellationToken();
		const input = { ...harness.input, sectionId, name: 'Requested target', query: 'SELECT 3 AS Probe',
			connectionId: connection.id, database: 'ProbeDb' };
		const configuration = orchestrator.configureSqlSection(input, cancellation.token)
			.then(value => ({ value }), error => ({ error }));
		try {
			await queued.promise;
			expect(harness.assertAllowed).toHaveBeenCalledOnce();
			expect(sqlManager.assertConnectionCurrent).toHaveBeenCalledOnce();
			expect(sqlManager.getConnection(connection.id)).toEqual(connection);
			expect(sqlManager.getConnection(connection.id)).not.toBe(sqlManager.getConnection(connection.id));
			if (change === 'protected' || change === 'enable-disable') harness.setProtected(true);
			if (change === 'enable-disable') harness.setProtected(false);
			if (change === 'removed') harness.setConnection(undefined);
			if (change === 'retargeted') harness.setConnection({ ...connection, serverUrl: 'replacement.example' });
			if (change === 'credential-revision') harness.setConnection({ ...connection, credentialRevision: 2 });
			if (change === 'cancel') cancellation.cancel();
			release.resolve();
			const result = await configuration;
			if (change === 'unchanged-copy') {
				expect(result).toEqual({ value: { success: true } });
			} else {
				if (change === 'cancel') expect(result).toMatchObject({ error: { name: 'Canceled' } });
				else expect(result).toMatchObject({ error: expect.any(Error) });
				expect(applyEdit).not.toHaveBeenCalled();
				expect({ text: document.getText(), version: document.version, dirty: document.isDirty }).toEqual(before);
				expect((vscode as any).__mockFileSystem.readText(uri)).toBe(diskBefore);
				expect(poster).not.toHaveBeenCalled();
				expect(orchestrator.isHostOwnedBackgroundFile(uri)).toBe(true);
				harness.setProtected(false);
				harness.setConnection(connection);
				await expect(orchestrator.configureSqlSection(input)).resolves.toEqual({ success: true });
			}
			expect(applyEdit).toHaveBeenCalledOnce();
			const sections = JSON.parse(document.getText()).state.sections;
			expect(sections[0]).toMatchObject({ id: sectionId, name: input.name, query: input.query,
				connectionIdHint: connection.id, serverUrl: connection.serverUrl, database: input.database });
			if (sourceId === 'persisted') expect(sections[1]).toEqual(JSON.parse(before.text).state.sections[1]);
			expect(poster).not.toHaveBeenCalled();
			expect(orchestrator.isHostOwnedBackgroundFile(uri)).toBe(true);
		} finally {
			release.resolve();
			await configuration;
			await lock;
		}
	});

	it.each(['structural', 'persisted'].flatMap(sourceId =>
		['refreshPolicy', 'assertAllowed', 'assertConnectionCurrent'].map(phase => ({ sourceId, phase })),
	))('captures requested SQL connection admission before $phase for $sourceId', async ({ sourceId, phase }) => {
		const harness = await createBackgroundSqlSeedHarness(`requested-await-${sourceId}-${phase}`);
		const { orchestrator, connection, document, applyEdit, poster } = harness;
		const sectionId = sourceId === 'structural' ? harness.input.sectionId : 'sql_persisted';
		if (sourceId === 'persisted') {
			const file = JSON.parse(document.getText());
			file.state.sections[0].id = sectionId;
			harness.setText(JSON.stringify(file));
		}
		const before = { text: document.getText(), version: document.version, dirty: document.isDirty };
		const revoke = () => { harness.setProtected(true); harness.setProtected(false); };
		if (sourceId === 'structural') harness.refreshPolicy.mockResolvedValueOnce([]);
		if (phase === 'refreshPolicy') harness.refreshPolicy.mockImplementationOnce(async () => { revoke(); return []; });
		if (phase === 'assertAllowed') harness.assertAllowed.mockImplementationOnce(async () => { revoke(); });
		if (phase === 'assertConnectionCurrent') harness.sqlManager.assertConnectionCurrent.mockImplementationOnce(async () => { revoke(); });
		const input = { ...harness.input, sectionId, name: 'Must wait for fresh admission', connectionId: connection.id, database: 'ProbeDb' };

		await expect(orchestrator.configureSqlSection(input)).rejects.toThrow(/changed|revoked/);

		expect(applyEdit).not.toHaveBeenCalled();
		expect({ text: document.getText(), version: document.version, dirty: document.isDirty }).toEqual(before);
		expect(harness.refreshPolicy).toHaveBeenCalledTimes(sourceId === 'structural' ? 2 : 1);
		expect(harness.getRevocationGeneration.mock.invocationCallOrder[0]).toBeLessThan(harness.refreshPolicy.mock.invocationCallOrder.at(-1)!);
		expect(poster).not.toHaveBeenCalled();
		expect(orchestrator.isHostOwnedBackgroundFile(harness.uri)).toBe(true);
		await expect(orchestrator.configureSqlSection(input)).resolves.toEqual({ success: true });
		expect(applyEdit).toHaveBeenCalledOnce();
		expect(JSON.parse(document.getText()).state.sections[0]).toMatchObject({ id: sectionId, name: input.name,
			query: 'SELECT 1 AS Probe', connectionIdHint: connection.id, database: input.database });
	});

	it.each(['section_0', 'sql_persisted'])('configures ordinary SQL source ID %s without a live structural probe', async sectionId => {
		const harness = await createBackgroundSqlSeedHarness(`ordinary-${sectionId}`);
		const { orchestrator, input, document, source, stateGetter, captureAdmission, poster } = harness;
		const other = { id: 'other_sql', type: 'sql', query: 'SELECT 2 AS Other', name: 'Keep' };
		if (sectionId !== 'section_0') {
			const file = JSON.parse(source);
			file.state.sections[0].id = sectionId;
			file.state.sections.push(other);
			harness.setText(JSON.stringify(file));
		}
		stateGetter.mockRejectedValue(new Error('Live editor is offline'));
		captureAdmission.mockClear();

		await expect(orchestrator.configureSqlSection({ ...input, sectionId, name: 'Source only' })).resolves.toEqual({ success: true });

		expect(stateGetter).not.toHaveBeenCalled();
		expect(captureAdmission).not.toHaveBeenCalled();
		expect(harness.refreshPolicy).not.toHaveBeenCalled();
		expect(harness.assertAllowed).not.toHaveBeenCalled();
		expect(harness.getRevocationGeneration).not.toHaveBeenCalled();
		expect(poster).not.toHaveBeenCalled();
		expect(JSON.parse(document.getText()).state.sections[0]).toMatchObject({ id: sectionId, name: 'Source only', query: 'SELECT 1 AS Probe' });
		if (sectionId !== 'section_0') expect(JSON.parse(document.getText()).state.sections[1]).toEqual(other);
		expect(orchestrator.isHostOwnedBackgroundFile(harness.uri)).toBe(true);
	});

	it.each([false, true])('executes a configured SQL structural ID through the current broker owner (ownerChanged=%s)', async ownerChanged => {
		const seed = await createBackgroundSqlSeedHarness(`composed-${ownerChanged}`);
		await expect(seed.orchestrator.configureSqlSection({ ...seed.input, name: 'Configured probe',
			connectionId: seed.connection.id, database: 'Db' })).resolves.toEqual({ success: true });
		expect(seed.poster).not.toHaveBeenCalled();
		expect(seed.orchestrator.isHostOwnedBackgroundFile(seed.uri)).toBe(true);
		const configuredSource = seed.document.getText();
		const configured = JSON.parse(configuredSource).state.sections[0];
		expect(configured).toMatchObject({ id: seed.input.sectionId, query: 'SELECT 1 AS Probe', connectionIdHint: seed.connection.id, database: 'Db' });
		const harness = createPendingSqlLifecycleHarness(seed);
		const { lifecycle, session, orchestrator } = harness;
		const result = { columns: [{ name: 'Probe', type: 'int' }], rows: [[1]], metadata: {} };
		const executeQueryCancelable = vi.fn(() => ({ promise: Promise.resolve(result), cancel: vi.fn() }));
		const terminal = vi.fn();
		const entered = deferred<void>(), release = deferred<void>();
		let requestId = '';
		const executionHandler = new HostSqlSectionExecutionApplicationHandler({
			sqlLifecycle: lifecycle, sqlExecutionBroker: lifecycle.executionBroker, sqlWorkbench: harness.sqlWorkbench,
			connectionManager: harness.sqlManager as any, client: { executeQueryCancelable },
			refreshConnectionsData: async () => undefined, output: { warn: vi.fn(), error: vi.fn() },
			postMessage: async message => {
				terminal(message);
				const response = message as { type: string; result: typeof result; executionId: string };
				expect(response.type).toBe('queryResult');
				await session.handleMessage({ type: 'toolResponse', requestId, result: {
					success: true, resultPreview: `Probe: ${response.result.rows[0][0]}`, executionId: response.executionId,
					executionOwner: lifecycle.getReadyToolOwner(configured.id),
				} });
				return true;
			},
		});
		const reserve = vi.spyOn(lifecycle.executionBroker, 'reservePreflight');
		const start = vi.spyOn(lifecycle.executionBroker, 'start');
		harness.setTransport(async (message, signal, isCurrent) => {
			const request = message as { type: string; requestId: string; input: {
				sectionId: string; executionId: string; execute: boolean; expectedExecutionOwner: ExecuteSqlQueryMessage['expectedOwner'];
			} };
			if (request.type !== 'toolConfigureSqlSection') return harness.physicalPost(message);
			entered.resolve();
			await release.promise;
			if (signal?.aborted || isCurrent?.() === false) return false;
			requestId = request.requestId;
			expect(request.input).toMatchObject({ sectionId: configured.id, execute: true });
			expect(request.input).not.toHaveProperty('query');
			expect(request.input).not.toHaveProperty('resolvedConnection');
			const owner = lifecycle.getReadyToolOwner(configured.id)!;
			await executionHandler.handleMessage({ type: 'executeSqlQuery', boxId: configured.id,
				sectionInstanceId: lifecycle.getSectionInstanceId(configured.id)!, query: configured.query, queryMode: 'plain',
				sqlConnectionId: configured.connectionIdHint, database: configured.database, ownerToken: owner.ownerToken,
				executionId: request.input.executionId, toolExecution: true, expectedOwner: request.input.expectedExecutionOwner });
			return true;
		});
		let execution: Promise<unknown> | undefined;
		try {
			harness.installation.resolve();
			expect(await harness.publishReadyOwner()).toMatchObject({ connectionId: seed.connection.id, database: 'Db' });
			execution = orchestrator.configureSqlSection({ openFileId: seed.input.openFileId, sectionId: configured.id, execute: true })
				.then(value => ({ value }), error => ({ error }));
			await entered.promise;
			if (ownerChanged) expect(lifecycle.adoptTarget(configured.id, 'instance-original', seed.connection.id, 'OtherDb', 2)).toBe(true);
			release.resolve();
			if (ownerChanged) {
				expect(await execution).toMatchObject({ error: { message: expect.stringMatching(/changed|rejected/) } });
				expect(executeQueryCancelable).not.toHaveBeenCalled();
				expect(reserve).not.toHaveBeenCalled();
				expect(start).not.toHaveBeenCalled();
				expect(terminal).not.toHaveBeenCalled();
			} else {
				expect(await execution).toEqual({ value: { success: true, resultPreview: 'Probe: 1' } });
				expect(executeQueryCancelable).toHaveBeenCalledExactlyOnceWith(harness.connection, 'Db', 'SELECT 1 AS Probe');
				expect(reserve).toHaveBeenCalledOnce();
				expect(start).toHaveBeenCalledOnce();
				expect(start.mock.results[0].value.isCurrent()).toBe(false);
				expect(terminal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'queryResult', result,
					boxId: configured.id, connectionId: seed.connection.id, database: 'Db', query: 'SELECT 1 AS Probe' }));
			}
			expect(orchestrator.isHostOwnedBackgroundFile(seed.uri)).toBe(false);
			expect(seed.document.getText()).toBe(configuredSource);
			expect(seed.applyEdit).toHaveBeenCalledOnce();
		} finally {
			release.resolve();
			await execution;
			executionHandler.dispose();
			harness.dispose();
		}
	});

	it.each(['fresh', 'protected', 'unowned', 'query-mismatch', 'no-id', 'comparison', 'multiple', 'source-target', 'source-result', 'source-name', 'source-empty', 'source-invalid'])(
		'keeps fresh SQL structural inventory private (%s)', async kind => {
			const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient, async () => ['protected-sql']);
			const uri = vscode.Uri.file(`/work/fresh-sql-${kind}.sqlx`);
			await expect(orch.createFile({ fileType: 'sqlx', filePath: uri.fsPath, initialContent: 'SELECT 1 AS Probe', reveal: false })).resolves.toMatchObject({ success: true });
			setActiveCustomTab(uri, 'kusto.kqlxEditor');
			let source = (vscode as any).__mockFileSystem.readText(uri);
			if (kind.startsWith('source-')) {
				const changed = JSON.parse(source);
				if (kind === 'source-target') changed.state.sections[0].connectionIdHint = 'protected-sql';
				if (kind === 'source-result') changed.state.sections[0].resultJson = '{"private":true}';
				if (kind === 'source-name') changed.state.sections[0].name = 'private-name';
				source = kind === 'source-empty' ? '' : kind === 'source-invalid' ? '{"private-name":' : JSON.stringify(changed);
			}
			(vscode.workspace as any).textDocuments = [{ uri, version: 1, isDirty: false, getText: () => source }];
			const raw = { id: kind === 'no-id' ? '' : 'sql_runtime', type: 'sql', query: kind === 'query-mismatch' ? 'SELECT 2' : 'SELECT 1 AS Probe',
				name: 'private-name', serverUrl: 'private-server', database: 'private-database', resultJson: '{"private":true}',
				...(kind === 'comparison' ? { comparisonSourceBoxId: 'sql_source' } : {}),
			};
			const poster = vi.fn(() => true);
			orch.connect(poster, async () => kind === 'multiple' ? [raw, { ...raw, id: 'sql_peer' }] : [raw], vi.fn(), uri.toString(),
				() => kind === 'protected' ? 'protected-sql' : undefined);
			if (kind === 'unowned') await orch.transferBackgroundOwnershipOnUserInteraction(uri);
			const result = await orch.listSections();
			const listed = result.openFiles?.find(file => file.uri === uri.toString());
			expect(listed?.sections).toEqual(kind === 'fresh' ? [{ id: 'sql_runtime', type: 'sql' }] : []);
			expect(JSON.stringify(result)).not.toContain('private-');
			expect(poster).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ wait: 'waitForBackgroundFileOperation', failed: false },
		{ wait: 'getBackgroundDocument', failed: false },
		{ wait: 'waitForBackgroundFileOperation', failed: true },
		{ wait: 'getBackgroundDocument', failed: true },
	])('fails closed when SQL mapping becomes protected during structural proof ($wait, failed=$failed)', async ({ wait, failed }) => {
		let protectedIds: string[] = [];
		let mapping: string | undefined;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient, async () => [...protectedIds]);
		const uri = vscode.Uri.file(`/work/sql-proof-${wait}-${failed}.sqlx`);
		await expect(orch.createFile({ fileType: 'sqlx', filePath: uri.fsPath, initialContent: 'SELECT 1 AS Probe', reveal: false })).resolves.toMatchObject({ success: true });
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const source = (vscode as any).__mockFileSystem.readText(uri);
		const document = { uri, version: 1, isDirty: false, getText: () => source };
		(vscode.workspace as any).textDocuments = [document];
		const poster = vi.fn(() => true);
		orch.connect(poster, async () => [{ id: 'private-id', type: 'sql', query: 'SELECT 1 AS Probe',
			name: 'private-name', serverUrl: 'private-server', database: 'private-database' }], vi.fn(), uri.toString(), () => mapping);
		const entered = deferred<void>(), release = deferred<void>();
		const proofWait = vi.spyOn(orch as any, wait).mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			if (failed) throw new Error('Proof unavailable');
			return wait === 'getBackgroundDocument' ? document : undefined;
		});

		const inventory = orch.listSections();
		await entered.promise;
		mapping = 'protected-sql';
		protectedIds = [mapping];
		release.resolve();
		const result = await inventory;

		expect(proofWait).toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain('private-');
		expect(result.openFiles?.find(file => file.uri === uri.toString())?.sections ?? []).toEqual([]);
		expect(poster).not.toHaveBeenCalled();
		expect(orch.isHostOwnedBackgroundFile(uri)).toBe(true);
		expect((vscode as any).__mockFileSystem.readText(uri)).toBe(source);
	});

	it.each([false, true])('skips structural proof waits for an already mapped SQL seed (protected=%s)', async protectedMapping => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
			async () => protectedMapping ? ['mapped-sql'] : []);
		const uri = vscode.Uri.file(`/work/sql-mapped-seed-${protectedMapping}.sqlx`);
		await expect(orch.createFile({ fileType: 'sqlx', filePath: uri.fsPath, initialContent: 'SELECT 1 AS Probe', reveal: false })).resolves.toMatchObject({ success: true });
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const source = (vscode as any).__mockFileSystem.readText(uri);
		(vscode.workspace as any).textDocuments = [{ uri, version: 1, isDirty: false, getText: () => source }];
		orch.connect(vi.fn(() => true), async () => [{ id: 'sql_mapped', type: 'sql', query: 'SELECT 1 AS Probe',
			name: 'Mapped', serverUrl: 'mapped-server', database: 'MappedDb' }], vi.fn(), uri.toString(), () => 'mapped-sql');
		const operationWait = vi.spyOn(orch as any, 'waitForBackgroundFileOperation');
		const documentWait = vi.spyOn(orch as any, 'getBackgroundDocument');

		const result = await orch.listSections();

		expect(operationWait).not.toHaveBeenCalled();
		expect(documentWait).not.toHaveBeenCalled();
		expect(result.openFiles?.find(file => file.uri === uri.toString())?.sections).toEqual(protectedMapping ? [] : [{
			id: 'sql_mapped', type: 'sql', name: 'Mapped', expanded: true, serverUrl: 'mapped-server', database: 'MappedDb',
		}]);
	});

	it.each(['version', 'source', 'document', 'runtime', 'ownership', 'mapping', 'protected-mapping', 'connection'])(
		'rejects a fresh SQL structural snapshot invalidated while another file is pending (%s)', async kind => {
			const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient, async () => ['protected-sql']);
			const uri = vscode.Uri.file(`/work/pending-fresh-sql-${kind}.sqlx`), peerUri = vscode.Uri.file('/work/slow-peer.kqlx');
			await expect(orch.createFile({ fileType: 'sqlx', filePath: uri.fsPath, initialContent: 'SELECT 1 AS Probe', reveal: false })).resolves.toMatchObject({ success: true });
			const tab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor') };
			setTabGroups({ activeTab: tab, tabs: [tab, { isActive: false, isDirty: false, input: new vscode.TabInputCustom(peerUri, 'kusto.kqlxEditor') }], isActive: true });
			let source = (vscode as any).__mockFileSystem.readText(uri);
			const document = { uri, version: 1, isDirty: false, getText: () => source };
			(vscode.workspace as any).textDocuments = [document];
			const current = vi.fn(() => true), resolver = vi.fn<() => string | undefined>(() => undefined);
			const token = orch.connect(vi.fn(() => true), async () => [{ id: 'sql_runtime', type: 'sql', query: 'SELECT 1 AS Probe' }], vi.fn(), uri.toString(),
				resolver, undefined, undefined, undefined, undefined, undefined, () => current);
			const peer = deferred<any[]>();
			orch.connect(vi.fn(() => true), () => peer.promise, vi.fn(), peerUri.toString());
			const proofComplete = deferred<void>();
			const getSections = Reflect.get(orch, 'getSectionsForConnection') as (...args: unknown[]) => Promise<unknown>;
			vi.spyOn(orch as any, 'getSectionsForConnection').mockImplementation(async (...args: unknown[]) => {
				const sections = await getSections.apply(orch, args);
				if (Reflect.get(args[0] as object, 'token') === token) proofComplete.resolve();
				return sections;
			});
			const inventory = orch.listSections();
			await proofComplete.promise;
			if (kind === 'version') document.version += 2;
			if (kind === 'source') source += ' ';
			if (kind === 'document') (vscode.workspace as any).textDocuments = [{ ...document }];
			if (kind === 'runtime') current.mockReturnValue(false);
			if (kind === 'ownership') await orch.transferBackgroundOwnershipOnUserInteraction(uri);
			if (kind === 'mapping' || kind === 'protected-mapping') resolver.mockReturnValue(kind === 'mapping' ? 'public-sql' : 'protected-sql');
			if (kind === 'connection') orch.disconnectIfOwner(token);
			peer.resolve([{ id: 'query_peer', type: 'query' }]);
			const listed = (await inventory).openFiles?.find(file => file.uri === uri.toString());
			expect(listed).toMatchObject({ isLiveWorkbench: false, sectionsUnavailable: true });
			expect(listed?.sections).toBeUndefined();
		},
	);

	it('matches an active SQL sidecar tab to the live primary .sql Workbench file', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const sqlUri = vscode.Uri.file('/work/query.sql');
		const sidecarUri = vscode.Uri.file('/work/query.sql.json');
		const sqlStateGetter = vi.fn(async () => [{ id: 'sql_1', type: 'sql' }]);

		orch.connect(vi.fn(), sqlStateGetter, vi.fn(), sqlUri.toString());
		setActiveCustomTab(sidecarUri, 'kusto.sqlCompatEditor');

		const result = await orch.listSections();

		expect(sqlStateGetter).toHaveBeenCalledTimes(1);
		expect(result.fileName).toBe('query.sql');
		expect(result.openFiles).toEqual(expect.arrayContaining([
			expect.objectContaining({ fileName: 'query.sql', fileKind: 'sql-sidecar', sidecarFor: '/work/query.sql', isActive: true, isLiveWorkbench: true })
		]));
	});

	it('listSections includes section inventory for every live open Workbench file', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const activeUri = vscode.Uri.file('/work/active.kqlx');
		const otherUri = vscode.Uri.file('/work/other.kqlx');
		const activeStateGetter = vi.fn(async () => [{ id: 'query_1', type: 'query', name: 'Active' }]);
		const otherStateGetter = vi.fn(async () => [{ id: 'query_1', type: 'query', name: 'Other' }]);

		orch.connect(vi.fn(), activeStateGetter, vi.fn(), activeUri.toString());
		orch.connect(vi.fn(), otherStateGetter, vi.fn(), otherUri.toString());
		setActiveCustomTab(activeUri, 'kusto.kqlxEditor');

		const result = await orch.listSections();

		expect(activeStateGetter).toHaveBeenCalledTimes(1);
		expect(otherStateGetter).toHaveBeenCalledTimes(1);
		expect(result.openFiles).toEqual(expect.arrayContaining([
			expect.objectContaining({ fileName: 'active.kqlx', sections: [expect.objectContaining({ id: 'query_1', name: 'Active' })] }),
			expect.objectContaining({ fileName: 'other.kqlx', sections: [expect.objectContaining({ id: 'query_1', name: 'Other' })] })
		]));
	});

	it('updates live open-file identity after a pinned editor is renamed', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const oldUri = vscode.Uri.file('/work/OpenBeforeRename.kqlx');
		const newUri = vscode.Uri.file('/work/openAfterRename.kqlx');
		const stateGetter = vi.fn(async () => [{ id: 'query_1', type: 'query', name: 'Renamed live file' }]);

		orch.connect(vi.fn(), stateGetter, vi.fn(), oldUri.toString());
		await orch.handleFilesRenamed([{ oldUri, newUri }]);
		setActiveCustomTab(newUri, 'kusto.kqlxEditor');

		const result = await orch.listSections();
		const openFiles = result.openFiles ?? [];

		expect(result.fileName).toBe('openAfterRename.kqlx');
		expect(result.sections).toEqual([expect.objectContaining({ id: 'query_1', name: 'Renamed live file' })]);
		expect(openFiles).toEqual(expect.arrayContaining([
			expect.objectContaining({ fileName: 'openAfterRename.kqlx', isActive: true, isLiveWorkbench: true })
		]));
		expect(openFiles.some(file => file.fileName === 'OpenBeforeRename.kqlx')).toBe(false);
	});

	it('refreshes casing for a case-only rename instead of keeping the old tab name', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const oldUri = vscode.Uri.file('/work/GetBlahBlah.kqlx');
		const newUri = vscode.Uri.file('/work/getBlahBlah.kqlx');

		orch.connect(vi.fn(), vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), oldUri.toString());
		await orch.handleFilesRenamed([{ oldUri, newUri }]);
		setActiveCustomTab(newUri, 'kusto.kqlxEditor');

		const result = await orch.listSections();
		const openFiles = result.openFiles ?? [];

		expect(openFiles).toHaveLength(1);
		expect(openFiles[0]).toMatchObject({ fileName: 'getBlahBlah.kqlx', isActive: true, isLiveWorkbench: true });
		expect(openFiles[0].fileName).not.toBe('GetBlahBlah.kqlx');
	});

	it('does not regress to the old file name when a renamed custom editor reconnects with its original URI', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const oldUri = vscode.Uri.file('/work/GetBlahBlah.kqlx');
		const newUri = vscode.Uri.file('/work/getBlahBlah.kqlx');
		const originalToken = orch.connect(vi.fn(), vi.fn(async () => [{ id: 'old_connection', type: 'query' }]), vi.fn(), oldUri.toString());

		await orch.handleFilesRenamed([{ oldUri, newUri }]);
		orch.disconnectIfOwner(originalToken);
		orch.connect(vi.fn(), vi.fn(async () => [{ id: 'reconnected', type: 'query' }]), vi.fn(), oldUri.toString());
		setActiveCustomTab(newUri, 'kusto.kqlxEditor');

		const result = await orch.listSections();
		const openFiles = result.openFiles ?? [];

		expect(result.fileName).toBe('getBlahBlah.kqlx');
		expect(result.sections[0].id).toBe('reconnected');
		expect(openFiles).toEqual([expect.objectContaining({ fileName: 'getBlahBlah.kqlx', isLiveWorkbench: true })]);
		expect(openFiles.some(file => file.fileName === 'GetBlahBlah.kqlx')).toBe(false);
	});

	it('collapses stale text documents left behind after a preview editor rename', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const oldUri = vscode.Uri.file('/work/PreviewRenameSource.kqlx');
		const newUri = vscode.Uri.file('/work/PreviewRenameTarget.kqlx');

		orch.connect(vi.fn(), vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), oldUri.toString());
		await orch.handleFilesRenamed([{ oldUri, newUri }]);
		setActiveCustomTab(newUri, 'kusto.kqlxEditor');
		(vscode.workspace as any).textDocuments = [{ uri: oldUri }, { uri: newUri }];

		const result = await orch.listSections();
		const openFiles = result.openFiles ?? [];

		expect(openFiles).toHaveLength(1);
		expect(openFiles[0]).toMatchObject({ fileName: 'PreviewRenameTarget.kqlx', isActive: true, isLiveWorkbench: true });
		expect(openFiles.some(file => file.fileName === 'PreviewRenameSource.kqlx')).toBe(false);
	});

	it('closes the stale old-case tab after a case-only rename', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const oldUri = vscode.Uri.file('/work/GetBlahBlah.kqlx');
		const newUri = vscode.Uri.file('/work/getBlahBlah.kqlx');
		const oldTab = { isActive: false, input: new vscode.TabInputCustom(oldUri, 'kusto.kqlxEditor'), label: 'GetBlahBlah.kqlx' };
		const newTab = { isActive: true, input: new vscode.TabInputCustom(newUri, 'kusto.kqlxEditor'), label: 'getBlahBlah.kqlx' };
		const group = { activeTab: newTab, tabs: [newTab, oldTab], isActive: true };

		orch.connect(vi.fn(), vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), oldUri.toString());
		setTabGroups(group);

		await orch.handleFilesRenamed([{ oldUri, newUri }]);

		expect(group.tabs).toEqual([newTab]);
	});

	it('routes configureQuerySection to a non-active file when openFileId is provided', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const activeUri = vscode.Uri.file('/work/active.kqlx');
		const otherUri = vscode.Uri.file('/work/other.kqlx');
		const activePoster = vi.fn();
		const otherPoster = vi.fn();

		orch.connect(activePoster, vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), activeUri.toString());
		orch.connect(otherPoster, vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), otherUri.toString());
		setActiveCustomTab(activeUri, 'kusto.kqlxEditor');

		const configurePromise = orch.configureQuerySection({
			sectionId: 'query_1',
			query: 'print "other"',
			openFileId: classifyWorkbenchUri(otherUri)!.openFileId,
		} as any);

		expect(activePoster).not.toHaveBeenCalled();
		expect(otherPoster).toHaveBeenCalledTimes(1);
		const postedMessage = otherPoster.mock.calls[0][0] as any;
		expect(postedMessage.input).toEqual({ sectionId: 'query_1', query: 'print "other"' });
		orch.handleWebviewResponse(postedMessage.requestId, { success: true });
		await expect(configurePromise).resolves.toEqual({ success: true });
	});

	it('routes targetFileUri sidecars to the live primary file', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const activeUri = vscode.Uri.file('/work/active.kqlx');
		const kqlUri = vscode.Uri.file('/work/query.kql');
		const sidecarUri = vscode.Uri.file('/work/query.kql.json');
		const activePoster = vi.fn();
		const kqlPoster = vi.fn();

		orch.connect(activePoster, vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), activeUri.toString());
		orch.connect(kqlPoster, vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), kqlUri.toString());
		setActiveCustomTab(activeUri, 'kusto.kqlxEditor');

		const configurePromise = orch.configureQuerySection({
			sectionId: 'query_1',
			query: 'print "sidecar target"',
			targetFileUri: sidecarUri.toString(),
		} as any);

		expect(activePoster).not.toHaveBeenCalled();
		expect(kqlPoster).toHaveBeenCalledTimes(1);
		const postedMessage = kqlPoster.mock.calls[0][0] as any;
		orch.handleWebviewResponse(postedMessage.requestId, { success: true });
		await expect(configurePromise).resolves.toEqual({ success: true });
	});

	it('fails loudly when openFileId and targetFileUri disagree', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const activeUri = vscode.Uri.file('/work/active.kqlx');
		const otherUri = vscode.Uri.file('/work/other.kqlx');
		const activePoster = vi.fn();

		orch.connect(activePoster, vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), activeUri.toString());
		setActiveCustomTab(activeUri, 'kusto.kqlxEditor');

		await expect(orch.configureQuerySection({
			sectionId: 'query_1',
			openFileId: classifyWorkbenchUri(activeUri)!.openFileId,
			targetFileUri: otherUri.toString(),
		} as any)).rejects.toThrow('target');
		expect(activePoster).not.toHaveBeenCalled();
	});

	it('refuses explicit read-only fallback targets instead of mutating active live files', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const activeUri = vscode.Uri.file('/work/active.kqlx');
		const plainTextUri = vscode.Uri.file('/work/plain.kql');
		const activePoster = vi.fn();

		orch.connect(activePoster, vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), activeUri.toString());
		(vscode.workspace as any).textDocuments = [{ uri: plainTextUri }];
		setActiveCustomTab(activeUri, 'kusto.kqlxEditor');

		await expect(orch.configureQuerySection({
			sectionId: 'query_1',
			targetFileUri: plainTextUri.toString(),
		} as any)).rejects.toThrow('live Workbench editor');
		expect(activePoster).not.toHaveBeenCalled();
	});

	it('refuses unsupported explicit targetFileUri instead of mutating the active file', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const activeUri = vscode.Uri.file('/work/active.kqlx');
		const activePoster = vi.fn();

		orch.connect(activePoster, vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), activeUri.toString());
		setActiveCustomTab(activeUri, 'kusto.kqlxEditor');

		await expect(orch.configureQuerySection({
			sectionId: 'query_1',
			targetFileUri: '/work/not-a-workbench-file.txt',
		} as any)).rejects.toThrow('targetFileUri');
		expect(activePoster).not.toHaveBeenCalled();
	});

	it('routes Windows absolute targetFileUri paths to the matching live file', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const activeUri = vscode.Uri.file('C:\\work\\active.kqlx');
		const targetUri = vscode.Uri.file('C:\\work\\target.kqlx');
		const activePoster = vi.fn();
		const targetPoster = vi.fn();

		orch.connect(activePoster, vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), activeUri.toString());
		orch.connect(targetPoster, vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), targetUri.toString());
		setActiveCustomTab(activeUri, 'kusto.kqlxEditor');

		const configurePromise = orch.configureQuerySection({
			sectionId: 'query_1',
			targetFileUri: 'C:\\work\\target.kqlx',
		} as any);

		expect(activePoster).not.toHaveBeenCalled();
		expect(targetPoster).toHaveBeenCalledTimes(1);
		const postedMessage = targetPoster.mock.calls[0][0] as any;
		orch.handleWebviewResponse(postedMessage.requestId, { success: true });
		await expect(configurePromise).resolves.toEqual({ success: true });
	});

	it('activateWorkbenchFile opens the logical primary file with the correct editor', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const sidecarUri = vscode.Uri.file('/work/query.kql.json');

		const result = await (orch as any).activateWorkbenchFile({ targetFileUri: sidecarUri.toString() });

		expect(result).toMatchObject({ success: true, fileName: 'query.kql', fileKind: 'kql-sidecar' });
		expect((vscode as any).__mockCommandCalls).toEqual(expect.arrayContaining([
			expect.objectContaining({ command: 'vscode.openWith' })
		]));
		const openCall = (vscode as any).__mockCommandCalls.find((call: any) => call.command === 'vscode.openWith');
		expect(openCall.args[0].fsPath).toBe('/work/query.kql');
		expect(openCall.args[1]).toBe('kusto.kqlCompatEditor');
	});

	it('closeWorkbenchFile closes only the exact targeted Workbench tab', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const activeUri = vscode.Uri.file('/work/active.kqlx');
		const targetUri = vscode.Uri.file('/work/target.kqlx');
		const activeTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(activeUri, 'kusto.kqlxEditor'), label: 'active.kqlx' };
		const targetTab = { isActive: false, isDirty: false, input: new vscode.TabInputCustom(targetUri, 'kusto.kqlxEditor'), label: 'target.kqlx' };
		setTabGroups(
			{ activeTab, tabs: [activeTab], isActive: true },
			{ activeTab: targetTab, tabs: [targetTab], isActive: false },
		);
		const close = vi.spyOn(vscode.window.tabGroups, 'close');

		const result = await (orch as any).closeWorkbenchFile({
			openFileId: classifyWorkbenchUri(targetUri)!.openFileId,
		});

		expect(result).toMatchObject({
			success: true, closed: true, closedTabCount: 1,
			openFileId: classifyWorkbenchUri(targetUri)!.openFileId,
		});
		expect(close).toHaveBeenCalledWith([targetTab], true);
		expect((vscode.window.tabGroups.all[0] as any).tabs).toEqual([activeTab]);
	});

	it('saveWorkbenchFile saves the exact dirty document without closing or focusing its tab', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const activeUri = vscode.Uri.file('/work/active.kqlx');
		const targetUri = vscode.Uri.file('/work/background-report.kqlx');
		const activeTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(activeUri, 'kusto.kqlxEditor'), label: 'active.kqlx' };
		const targetTab = { isActive: false, isDirty: false, input: new vscode.TabInputCustom(targetUri, 'kusto.kqlxEditor'), label: 'background-report.kqlx' };
		setTabGroups(
			{ activeTab, tabs: [activeTab], isActive: true },
			{ activeTab: targetTab, tabs: [targetTab], isActive: false },
		);
		let dirty = true;
		const save = vi.fn(async () => { dirty = false; return true; });
		(vscode.workspace as any).textDocuments = [{ uri: targetUri, get isDirty() { return dirty; }, save }];
		const close = vi.spyOn(vscode.window.tabGroups, 'close');

		const result = await orch.saveWorkbenchFile({
			openFileId: classifyWorkbenchUri(targetUri)!.openFileId,
		});

		expect(result).toMatchObject({ success: true, saved: true, wasDirty: true });
		expect(save).toHaveBeenCalledOnce();
		expect(close).not.toHaveBeenCalled();
		expect((vscode.window.tabGroups.all[0] as any).activeTab).toBe(activeTab);
	});

	it('saveWorkbenchFile rejects an explicit URI that is not open instead of falling back to the active file', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const activeUri = vscode.Uri.file('/work/active.kqlx');
		const foreignUri = vscode.Uri.file('/work/foreign-window.kqlx');
		const activeTab = { isActive: true, isDirty: true, input: new vscode.TabInputCustom(activeUri, 'kusto.kqlxEditor'), label: 'active.kqlx' };
		setTabGroups({ activeTab, tabs: [activeTab], isActive: true });
		const save = vi.fn(async () => true);
		(vscode.workspace as any).textDocuments = [{ uri: activeUri, isDirty: true, save }];

		const result = await orch.saveWorkbenchFile({ targetFileUri: foreignUri.toString() });

		expect(result).toEqual({
			success: false,
			saved: false,
			error: 'No matching open Kusto Workbench file was found.',
		});
		expect(save).not.toHaveBeenCalled();
	});

	it.each([
		{},
		{ openFileId: '   ' },
		{ targetFileUri: '\t' },
	])('closeWorkbenchFile refuses to infer a target from the active editor for %j', async input => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const activeUri = vscode.Uri.file('/work/active.kqlx');
		const activeTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(activeUri, 'kusto.kqlxEditor'), label: 'active.kqlx' };
		setTabGroups({ activeTab, tabs: [activeTab], isActive: true });
		const close = vi.spyOn(vscode.window.tabGroups, 'close');

		const result = await (orch as any).closeWorkbenchFile(input);

		expect(result).toMatchObject({ success: false, closed: false });
		expect(result.error).toContain('openFileId or targetFileUri');
		expect(close).not.toHaveBeenCalled();
	});

	it('closeWorkbenchFile refuses conflicting exact targets', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const targetUri = vscode.Uri.file('/work/target.kqlx');
		const otherUri = vscode.Uri.file('/work/other.kqlx');
		const targetTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(targetUri, 'kusto.kqlxEditor'), label: 'target.kqlx' };
		setTabGroups({ activeTab: targetTab, tabs: [targetTab], isActive: true });
		const close = vi.spyOn(vscode.window.tabGroups, 'close');

		const result = await (orch as any).closeWorkbenchFile({
			openFileId: classifyWorkbenchUri(targetUri)!.openFileId,
			targetFileUri: otherUri.toString(),
		});

		expect(result).toMatchObject({ success: false, closed: false });
		expect(result.error).toContain('different Workbench files');
		expect(close).not.toHaveBeenCalled();
	});

	it('closeWorkbenchFile refuses authoritative compatibility dirtiness even when the backing document is clean', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const targetUri = vscode.Uri.file('/work/metadata-dirty.kql');
		const targetTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(targetUri, 'kusto.kqlCompatEditor'), label: 'metadata-dirty.kql' };
		setTabGroups({ activeTab: targetTab, tabs: [targetTab], isActive: true });
		const closeLifecycle = {
			inspectDirty: vi.fn(async () => true),
			save: vi.fn(async () => undefined),
		};
		orch.connect(vi.fn(), vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), targetUri.toString(), undefined, undefined, closeLifecycle);
		const close = vi.spyOn(vscode.window.tabGroups, 'close');

		const result = await (orch as any).closeWorkbenchFile({
			openFileId: classifyWorkbenchUri(targetUri)!.openFileId,
		});

		expect(closeLifecycle.inspectDirty).toHaveBeenCalledOnce();
		expect(closeLifecycle.save).not.toHaveBeenCalled();
		expect(result).toMatchObject({ success: false, closed: false, wasDirty: true });
		expect(close).not.toHaveBeenCalled();
	});

	it('closeWorkbenchFile leaves the compatibility tab open when final snapshot inspection is unavailable', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const targetUri = vscode.Uri.file('/work/restore-in-progress.kql');
		const targetTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(targetUri, 'kusto.kqlCompatEditor'), label: 'restore-in-progress.kql' };
		setTabGroups({ activeTab: targetTab, tabs: [targetTab], isActive: true });
		const closeLifecycle = {
			inspectDirty: vi.fn(async () => { throw new Error('The final KQL metadata snapshot is unavailable: restore-in-progress.'); }),
			save: vi.fn(async () => undefined),
		};
		orch.connect(vi.fn(), vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), targetUri.toString(), undefined, undefined, closeLifecycle);
		const close = vi.spyOn(vscode.window.tabGroups, 'close');

		const result = await (orch as any).closeWorkbenchFile({ targetFileUri: targetUri.toString() });

		expect(result).toMatchObject({ success: false, closed: false });
		expect(result.error).toContain('restore-in-progress');
		expect(closeLifecycle.save).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
	});

	it('closeWorkbenchFile refuses a dirty companion text buffer before either authority saves', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const targetUri = vscode.Uri.file('/work/competing.kql');
		const sidecarUri = vscode.Uri.file('/work/competing.kql.json');
		const targetTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(targetUri, 'kusto.kqlCompatEditor'), label: 'competing.kql' };
		const sidecarTab = { isActive: false, isDirty: true, input: new vscode.TabInputText(sidecarUri), label: 'competing.kql.json' };
		setTabGroups({ activeTab: targetTab, tabs: [targetTab, sidecarTab], isActive: true });
		const sidecarDocument = { uri: sidecarUri, isDirty: true, save: vi.fn(async () => true) };
		(vscode.workspace as any).textDocuments = [sidecarDocument];
		const closeLifecycle = {
			inspectDirty: vi.fn(async () => true),
			save: vi.fn(async () => undefined),
		};
		orch.connect(vi.fn(), vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), targetUri.toString(), undefined, undefined, closeLifecycle);
		const close = vi.spyOn(vscode.window.tabGroups, 'close');

		const result = await (orch as any).closeWorkbenchFile({
			targetFileUri: targetUri.toString(),
			saveChanges: true,
		});

		expect(result).toMatchObject({ success: false, closed: false, wasDirty: true });
		expect(result.error).toContain('companion metadata editor');
		expect(closeLifecycle.inspectDirty).not.toHaveBeenCalled();
		expect(closeLifecycle.save).not.toHaveBeenCalled();
		expect(sidecarDocument.save).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
	});

	it.each(['inspection', 'lifecycle save', 'final inspection'] as const)(
		'closeWorkbenchFile refuses a companion text buffer that becomes dirty during %s',
		async dirtyPhase => {
			const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
			const targetUri = vscode.Uri.file(`/work/competing-${dirtyPhase.replace(' ', '-')}.kql`);
			const sidecarUri = vscode.Uri.file(`${targetUri.fsPath}.json`);
			const targetTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(targetUri, 'kusto.kqlCompatEditor'), label: 'target.kql' };
			const sidecarTab = { isActive: false, isDirty: false, input: new vscode.TabInputText(sidecarUri), label: 'target.kql.json' };
			const activeGroup = { activeTab: targetTab, tabs: dirtyPhase === 'lifecycle save' ? [targetTab, sidecarTab] : [targetTab], isActive: true };
			setTabGroups(activeGroup);
			const sidecarDocument = { uri: sidecarUri, isDirty: false, save: vi.fn(async () => true) };
			(vscode.workspace as any).textDocuments = dirtyPhase === 'lifecycle save' ? [sidecarDocument] : [];
			const dirtyCompanion = () => {
				if (!activeGroup.tabs.includes(sidecarTab)) activeGroup.tabs.push(sidecarTab);
				if (!(vscode.workspace.textDocuments as any[]).includes(sidecarDocument)) {
					(vscode.workspace as any).textDocuments = [...vscode.workspace.textDocuments, sidecarDocument];
				}
				sidecarTab.isDirty = true;
				sidecarDocument.isDirty = true;
			};
			let inspectionCount = 0;
			const closeLifecycle = {
				inspectDirty: vi.fn(async () => {
					inspectionCount++;
					if (dirtyPhase === 'inspection' && inspectionCount === 1) dirtyCompanion();
					if (dirtyPhase === 'final inspection' && inspectionCount === 2) dirtyCompanion();
					return inspectionCount === 1;
				}),
				save: vi.fn(async () => {
					if (dirtyPhase === 'lifecycle save') dirtyCompanion();
				}),
			};
			orch.connect(vi.fn(), vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), targetUri.toString(), undefined, undefined, closeLifecycle);
			const close = vi.spyOn(vscode.window.tabGroups, 'close');

			const result = await (orch as any).closeWorkbenchFile({
				targetFileUri: targetUri.toString(),
				saveChanges: true,
			});

			expect(result).toMatchObject({ success: false, closed: false, wasDirty: true });
			expect(result.error).toContain('companion metadata editor');
			expect(closeLifecycle.save).toHaveBeenCalledTimes(dirtyPhase === 'inspection' ? 0 : 1);
			expect(sidecarDocument.save).not.toHaveBeenCalled();
			expect(close).not.toHaveBeenCalled();
		},
	);

	it('closeWorkbenchFile includes a clean matching tab opened during final inspection', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const targetUri = vscode.Uri.file('/work/late-clean.kql');
		const sidecarUri = vscode.Uri.file('/work/late-clean.kql.json');
		const targetTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(targetUri, 'kusto.kqlCompatEditor'), label: 'late-clean.kql' };
		const sidecarTab = { isActive: false, isDirty: false, input: new vscode.TabInputText(sidecarUri), label: 'late-clean.kql.json' };
		const tabs: Array<typeof targetTab | typeof sidecarTab> = [targetTab];
		const activeGroup = { activeTab: targetTab, tabs, isActive: true };
		setTabGroups(activeGroup);
		let inspectionCount = 0;
		const closeLifecycle = {
			inspectDirty: vi.fn(async () => {
				inspectionCount++;
				if (inspectionCount === 2) activeGroup.tabs.push(sidecarTab);
				return inspectionCount === 1;
			}),
			save: vi.fn(async () => undefined),
		};
		orch.connect(vi.fn(), vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), targetUri.toString(), undefined, undefined, closeLifecycle);
		const close = vi.spyOn(vscode.window.tabGroups, 'close');

		const result = await (orch as any).closeWorkbenchFile({
			targetFileUri: targetUri.toString(),
			saveChanges: true,
		});

		expect(result).toMatchObject({ success: true, closed: true, closedTabCount: 2 });
		expect(close).toHaveBeenCalledWith([targetTab, sidecarTab], true);
	});

	it('closeWorkbenchFile refuses a compatibility tab whose authoritative lifecycle is unavailable', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const targetUri = vscode.Uri.file('/work/disconnected.kql');
		const targetTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(targetUri, 'kusto.kqlCompatEditor'), label: 'disconnected.kql' };
		setTabGroups({ activeTab: targetTab, tabs: [targetTab], isActive: true });
		const close = vi.spyOn(vscode.window.tabGroups, 'close');

		const result = await (orch as any).closeWorkbenchFile({ targetFileUri: targetUri.toString() });

		expect(result).toMatchObject({ success: false, closed: false });
		expect(result.error).toContain('close state');
		expect(close).not.toHaveBeenCalled();
	});

	it('closeWorkbenchFile awaits authoritative compatibility save and clean revalidation', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const targetUri = vscode.Uri.file('/work/metadata-save.kql');
		const targetTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(targetUri, 'kusto.kqlCompatEditor'), label: 'metadata-save.kql' };
		setTabGroups({ activeTab: targetTab, tabs: [targetTab], isActive: true });
		const closeLifecycle = {
			inspectDirty: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
			save: vi.fn(async () => undefined),
		};
		orch.connect(vi.fn(), vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), targetUri.toString(), undefined, undefined, closeLifecycle);
		const close = vi.spyOn(vscode.window.tabGroups, 'close');

		const result = await (orch as any).closeWorkbenchFile({
			openFileId: classifyWorkbenchUri(targetUri)!.openFileId,
			saveChanges: true,
		});

		expect(closeLifecycle.save).toHaveBeenCalledOnce();
		expect(closeLifecycle.inspectDirty).toHaveBeenCalledTimes(2);
		expect(close).toHaveBeenCalledWith([targetTab], true);
		expect(result).toMatchObject({ success: true, closed: true, saved: true, wasDirty: true });
	});

	it('closeWorkbenchFile leaves the compatibility tab open when authoritative save fails', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const targetUri = vscode.Uri.file('/work/metadata-save-failed.sql');
		const targetTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(targetUri, 'kusto.sqlCompatEditor'), label: 'metadata-save-failed.sql' };
		setTabGroups({ activeTab: targetTab, tabs: [targetTab], isActive: true });
		const closeLifecycle = {
			inspectDirty: vi.fn(async () => true),
			save: vi.fn(async () => { throw new Error('companion write failed'); }),
		};
		orch.connect(vi.fn(), vi.fn(async () => [{ id: 'sql_1', type: 'sql' }]), vi.fn(), targetUri.toString(), undefined, undefined, closeLifecycle);
		const close = vi.spyOn(vscode.window.tabGroups, 'close');

		const result = await (orch as any).closeWorkbenchFile({
			targetFileUri: targetUri.toString(),
			saveChanges: true,
		});

		expect(result).toMatchObject({ success: false, closed: false, wasDirty: true });
		expect(result.error).toContain('companion write failed');
		expect(close).not.toHaveBeenCalled();
	});

	it('closeWorkbenchFile leaves the compatibility tab open when save resolves but remains dirty', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const targetUri = vscode.Uri.file('/work/still-dirty.sql');
		const targetTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(targetUri, 'kusto.sqlCompatEditor'), label: 'still-dirty.sql' };
		setTabGroups({ activeTab: targetTab, tabs: [targetTab], isActive: true });
		const closeLifecycle = {
			inspectDirty: vi.fn(async () => true),
			save: vi.fn(async () => undefined),
		};
		orch.connect(vi.fn(), vi.fn(async () => [{ id: 'sql_1', type: 'sql' }]), vi.fn(), targetUri.toString(), undefined, undefined, closeLifecycle);
		const close = vi.spyOn(vscode.window.tabGroups, 'close');

		const result = await (orch as any).closeWorkbenchFile({
			targetFileUri: targetUri.toString(),
			saveChanges: true,
		});

		expect(result).toMatchObject({ success: false, closed: false, wasDirty: true });
		expect(result.error).toContain('remained dirty');
		expect(close).not.toHaveBeenCalled();
	});

	const connectCleanRichKqlx = (name: string, closeLifecycle: { inspectDirty: () => Promise<boolean>; save: () => Promise<void> }) => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const targetUri = vscode.Uri.file(`/work/${name}.kqlx`);
		const targetTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(targetUri, 'kusto.kqlxEditor'), label: `${name}.kqlx` };
		setTabGroups({ activeTab: targetTab, tabs: [targetTab], isActive: true });
		const document = { uri: targetUri, isDirty: false, save: vi.fn(async () => true) };
		(vscode.workspace as any).textDocuments = [document];
		orch.connect(vi.fn(), vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), targetUri.toString(), undefined, undefined, closeLifecycle);
		const close = vi.spyOn(vscode.window.tabGroups, 'close');
		const executeCommand = vi.spyOn(vscode.commands, 'executeCommand');
		return { orch, targetUri, targetTab, document, close, executeCommand };
	};

	it('closeWorkbenchFile refuses rich kqlx lifecycle dirtiness without saveChanges even when tab and document are clean', async () => {
		const closeLifecycle = {
			inspectDirty: vi.fn(async () => true),
			save: vi.fn(async () => undefined),
		};
		const { orch, targetUri, document, close } = connectCleanRichKqlx('rich-lifecycle-dirty', closeLifecycle);

		const result = await (orch as any).closeWorkbenchFile({
			openFileId: classifyWorkbenchUri(targetUri)!.openFileId,
		});

		expect(closeLifecycle.inspectDirty).toHaveBeenCalledOnce();
		expect(closeLifecycle.save).not.toHaveBeenCalled();
		expect(document.save).not.toHaveBeenCalled();
		expect(result).toMatchObject({ success: false, closed: false, wasDirty: true });
		expect(close).not.toHaveBeenCalled();
	});

	it('closeWorkbenchFile awaits rich kqlx lifecycle save and clean revalidation before closing the exact tab', async () => {
		let saveSettled = false;
		const closeLifecycle = {
			inspectDirty: vi.fn(async () => !saveSettled),
			save: vi.fn(async () => {
				await Promise.resolve();
				saveSettled = true;
			}),
		};
		const { orch, targetUri, targetTab, document, close, executeCommand } = connectCleanRichKqlx('rich-lifecycle-save', closeLifecycle);

		const result = await (orch as any).closeWorkbenchFile({
			targetFileUri: targetUri.toString(),
			saveChanges: true,
		});

		expect(closeLifecycle.save).toHaveBeenCalledOnce();
		expect(closeLifecycle.inspectDirty).toHaveBeenCalledTimes(2);
		expect(document.save).not.toHaveBeenCalled();
		expect(executeCommand).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledWith([targetTab], true);
		expect(result).toMatchObject({ success: true, closed: true, saved: true, wasDirty: true });
	});

	it('closeWorkbenchFile leaves the rich kqlx tab open when lifecycle save resolves but publication remains dirty', async () => {
		const closeLifecycle = {
			inspectDirty: vi.fn(async () => true),
			save: vi.fn(async () => undefined),
		};
		const { orch, targetUri, document, close } = connectCleanRichKqlx('rich-publication-failed', closeLifecycle);

		const result = await (orch as any).closeWorkbenchFile({
			targetFileUri: targetUri.toString(),
			saveChanges: true,
		});

		expect(closeLifecycle.save).toHaveBeenCalledOnce();
		expect(closeLifecycle.inspectDirty).toHaveBeenCalledTimes(2);
		expect(document.save).not.toHaveBeenCalled();
		expect(result).toMatchObject({ success: false, closed: false, wasDirty: true });
		expect(result.error).toContain('remained dirty');
		expect(close).not.toHaveBeenCalled();
	});

	it('closeWorkbenchFile does not close a rich kqlx tab until pending publication inspection settles', async () => {
		let resolveFinalInspection!: (dirty: boolean) => void;
		const finalInspection = new Promise<boolean>(resolve => { resolveFinalInspection = resolve; });
		const closeLifecycle = {
			inspectDirty: vi.fn()
				.mockResolvedValueOnce(true)
				.mockImplementationOnce(() => finalInspection),
			save: vi.fn(async () => undefined),
		};
		const { orch, targetUri, targetTab, close } = connectCleanRichKqlx('rich-pending-publication', closeLifecycle);
		expect(targetTab.isDirty).toBe(false);

		const pending = (orch as any).closeWorkbenchFile({
			targetFileUri: targetUri.toString(),
			saveChanges: true,
		});
		await vi.waitFor(() => expect(closeLifecycle.inspectDirty).toHaveBeenCalledTimes(2));
		for (let i = 0; i < 10; i++) await Promise.resolve();

		expect(closeLifecycle.save).toHaveBeenCalledOnce();
		expect(close).not.toHaveBeenCalled();

		resolveFinalInspection(false);
		const result = await pending;

		expect(close).toHaveBeenCalledWith([targetTab], true);
		expect(result).toMatchObject({ success: true, closed: true, saved: true, wasDirty: true });
	});

	it('closeWorkbenchFile refuses a dirty target unless saveChanges is explicit', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const targetUri = vscode.Uri.file('/work/dirty.kqlx');
		const targetTab = { isActive: true, isDirty: true, input: new vscode.TabInputCustom(targetUri, 'kusto.kqlxEditor'), label: 'dirty.kqlx' };
		setTabGroups({ activeTab: targetTab, tabs: [targetTab], isActive: true });
		const close = vi.spyOn(vscode.window.tabGroups, 'close');

		const result = await (orch as any).closeWorkbenchFile({ targetFileUri: targetUri.toString() });

		expect(result).toMatchObject({ success: false, closed: false, wasDirty: true });
		expect(result.error).toContain('saveChanges');
		expect(close).not.toHaveBeenCalled();
	});

	it('closeWorkbenchFile saves the exact dirty document before closing when requested', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const targetUri = vscode.Uri.file('/work/save-before-close.kqlx');
		const targetTab = { isActive: true, isDirty: true, input: new vscode.TabInputCustom(targetUri, 'kusto.kqlxEditor'), label: 'save-before-close.kqlx' };
		setTabGroups({ activeTab: targetTab, tabs: [targetTab], isActive: true });
		const document = {
			uri: targetUri,
			isDirty: true,
			save: vi.fn(async function (this: { isDirty: boolean }) { this.isDirty = false; targetTab.isDirty = false; return true; }),
		};
		(vscode.workspace as any).textDocuments = [document];
		const close = vi.spyOn(vscode.window.tabGroups, 'close');

		const result = await (orch as any).closeWorkbenchFile({
			targetFileUri: targetUri.toString(), saveChanges: true,
		});

		expect(document.save).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledWith([targetTab], true);
		expect(result).toMatchObject({
			success: true, closed: true, saved: true, wasDirty: true, closedTabCount: 1,
		});
	});

	it('closeWorkbenchFile leaves the exact dirty tab open when its save fails', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const targetUri = vscode.Uri.file('/work/save-failed.kqlx');
		const targetTab = { isActive: true, isDirty: true, input: new vscode.TabInputCustom(targetUri, 'kusto.kqlxEditor'), label: 'save-failed.kqlx' };
		setTabGroups({ activeTab: targetTab, tabs: [targetTab], isActive: true });
		const document = { uri: targetUri, isDirty: true, save: vi.fn(async () => false) };
		(vscode.workspace as any).textDocuments = [document];
		const close = vi.spyOn(vscode.window.tabGroups, 'close');

		const result = await (orch as any).closeWorkbenchFile({
			targetFileUri: targetUri.toString(), saveChanges: true,
		});

		expect(document.save).toHaveBeenCalledOnce();
		expect(close).not.toHaveBeenCalled();
		expect(result).toMatchObject({ success: false, closed: false, wasDirty: true });
		expect(result.error).toContain('could not be saved');
	});

	it('closeWorkbenchFile reports a supported target that is not open', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const targetUri = vscode.Uri.file('/work/not-open.kqlx');
		const close = vi.spyOn(vscode.window.tabGroups, 'close');

		const result = await (orch as any).closeWorkbenchFile({ targetFileUri: targetUri.toString() });

		expect(result).toMatchObject({ success: false, closed: false });
		expect(result.error).toContain('not open');
		expect(close).not.toHaveBeenCalled();
	});

	it('listSections omits filePath and fileName when no documentUri is provided', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		orch.connect(
			vi.fn(),
			vi.fn(async () => [{ id: 'q1', type: 'query' }]),
			vi.fn()
		);

		const result = await orch.listSections();
		expect(result.filePath).toBeUndefined();
		expect(result.fileName).toBeUndefined();
	});

	it('listSections omits filePath and fileName for non-file URI schemes', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		orch.connect(
			vi.fn(),
			vi.fn(async () => [{ id: 'q1', type: 'query' }]),
			vi.fn(),
			'untitled:Untitled-1'
		);

		const result = await orch.listSections();
		expect(result.filePath).toBeUndefined();
		expect(result.fileName).toBeUndefined();
	});

	it('disconnectIfOwner clears documentUri', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const token = orch.connect(
			vi.fn(),
			vi.fn(async () => []),
			vi.fn(),
			'file:///home/user/test.kqlx'
		);

		orch.disconnectIfOwner(token);

		// After disconnect, listSections should throw (no stateGetter)
		await expect(orch.listSections()).rejects.toThrow('not currently open');
	});

	it('normalizes maxResultRows before delegating to Kusto Copilot', async () => {
		async function capturePostedInput(rawMaxResultRows: unknown): Promise<Record<string, unknown>> {
			(KustoWorkbenchToolOrchestrator as any).instance = undefined;
			const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
			const poster = vi.fn();
			orchestrator.connect(poster, vi.fn(async () => []), vi.fn());

			const input: Record<string, unknown> = { question: 'Help' };
			if (rawMaxResultRows !== undefined) {
				input.maxResultRows = rawMaxResultRows;
			}
			const delegatePromise = orchestrator.delegateToKustoWorkbenchCopilot(input as any);
			const postedMessage = poster.mock.calls[0][0] as any;
			orchestrator.handleWebviewResponse(postedMessage.requestId, { success: true });
			await delegatePromise;
			return postedMessage.input;
		}

		await expect(capturePostedInput(undefined)).resolves.toMatchObject({ maxResultRows: 100 });
		await expect(capturePostedInput(250)).resolves.toMatchObject({ maxResultRows: 250 });
		await expect(capturePostedInput(250.9)).resolves.toMatchObject({ maxResultRows: 250 });
		await expect(capturePostedInput(0)).resolves.toMatchObject({ maxResultRows: 1 });
		await expect(capturePostedInput(2000)).resolves.toMatchObject({ maxResultRows: 1000 });
		await expect(capturePostedInput('250')).resolves.toMatchObject({ maxResultRows: 100 });
	});

	it('does not install a fixed deadline for delegated Kusto Copilot requests', async () => {
		vi.useFakeTimers();
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
		try {
			const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
				fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
			);
			const poster = createMessagePoster();
			orchestrator.connect(poster, vi.fn(async () => []), vi.fn());
			let outcome = 'pending';
			const pending = orchestrator.delegateToKustoWorkbenchCopilot({ question: 'Help' });
			void pending.then(
				() => { outcome = 'resolved'; },
				() => { outcome = 'rejected'; },
			);
			const request = poster.mock.calls[0][0] as any;
			expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 180_000);

			await vi.advanceTimersByTimeAsync(180_001);

			expect(outcome).toBe('pending');
			expect(poster).not.toHaveBeenCalledWith(expect.objectContaining({
				type: 'toolCancelKustoCopilot', requestId: request.requestId,
			}));
			orchestrator.handleWebviewResponse(request.requestId, { success: true, sectionId: 'query_1' });
			await expect(pending).resolves.toEqual({ success: true, sectionId: 'query_1' });
		} finally {
			setTimeoutSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it('cancels an unbounded delegated Kusto Copilot request explicitly', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const poster = createMessagePoster();
		orchestrator.connect(poster, vi.fn(async () => []), vi.fn());
		const cancellation = cancellationToken();
		const pending = orchestrator.delegateToKustoWorkbenchCopilot({ question: 'Help' }, cancellation.token);
		const request = poster.mock.calls[0][0] as any;

		cancellation.cancel();

		await expect(pending).rejects.toMatchObject({ name: 'Canceled' });
		expect(poster).toHaveBeenCalledWith({
			type: 'toolCancelKustoCopilot', requestId: request.requestId,
		});
	});

	it('keeps the Kusto Copilot waiter live after a malformed matching clarification result', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const poster = createMessagePoster();
		orchestrator.connect(poster, vi.fn(async () => []), vi.fn());
		let settled = false;
		const pending = orchestrator.delegateToKustoWorkbenchCopilot({ question: 'Help' });
		void pending.then(() => { settled = true; });
		const request = poster.mock.calls[0][0] as any;
		const revoked = Proxy.revocable({
			outcome: 'clarification-required', success: false,
			question: 'Which range?', sectionId: 'query_1',
		}, {});
		revoked.revoke();

		expect(() => orchestrator.handleWebviewResponse(request.requestId, revoked.proxy)).not.toThrow();
		await Promise.resolve();
		expect(settled).toBe(false);

		orchestrator.handleWebviewResponse(request.requestId, {
			outcome: 'clarification-required', success: 'false',
			question: 'Which range?', sectionId: 'query_1',
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		orchestrator.handleWebviewResponse(request.requestId, {
			outcome: 'clarification-required', success: false,
			question: 'Which range?', sectionId: 'query_1',
		});
		await expect(pending).resolves.toEqual({
			outcome: 'clarification-required', success: false,
			question: 'Which range?', sectionId: 'query_1',
		});
	});

	it('enriches clarification from the exact dispatched file after active focus changes', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const fileA = vscode.Uri.file('/work/clarification-a.kqlx');
		const fileB = vscode.Uri.file('/work/clarification-b.kqlx');
		const infoA = classifyWorkbenchUri(fileA)!;
		const posterA = createMessagePoster();
		orchestrator.connect(posterA, vi.fn(async () => []), vi.fn(), fileA.toString());
		orchestrator.connect(vi.fn(() => true), vi.fn(async () => []), vi.fn(), fileB.toString());
		setActiveCustomTab(fileA, 'kusto.kqlxEditor');

		const pending = orchestrator.delegateToKustoWorkbenchCopilot({
			question: 'Help', openFileId: infoA.openFileId,
		});
		const request = posterA.mock.calls[0][0] as any;
		setActiveCustomTab(fileB, 'kusto.kqlxEditor');
		orchestrator.handleWebviewResponse(request.requestId, {
			outcome: 'clarification-required', success: false,
			question: 'Which range?', sectionId: 'query_1',
		});

		await expect(pending).resolves.toEqual({
			outcome: 'clarification-required', success: false,
			question: 'Which range?', sectionId: 'query_1', openFileId: infoA.openFileId,
		});
	});

	it('uses the captured file current identity when it is renamed before clarification settles', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const oldUri = vscode.Uri.file('/work/clarification-old.kqlx');
		const newUri = vscode.Uri.file('/work/clarification-new.kqlx');
		const oldInfo = classifyWorkbenchUri(oldUri)!;
		const newInfo = classifyWorkbenchUri(newUri)!;
		const poster = createMessagePoster();
		orchestrator.connect(poster, vi.fn(async () => []), vi.fn(), oldUri.toString());

		const pending = orchestrator.delegateToKustoWorkbenchCopilot({
			question: 'Help', openFileId: oldInfo.openFileId,
		});
		const request = poster.mock.calls[0][0] as any;
		await orchestrator.handleFilesRenamed([{ oldUri, newUri }]);
		orchestrator.handleWebviewResponse(request.requestId, {
			outcome: 'clarification-required', success: false,
			question: 'Which range?', sectionId: 'query_1',
		});

		await expect(pending).resolves.toEqual(expect.objectContaining({ openFileId: newInfo.openFileId }));
	});

	it('defers stale renamed-tab closure until the captured clarification settles', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const oldUri = vscode.Uri.file('/work/clarification-pending-old.kqlx');
		const newUri = vscode.Uri.file('/work/clarification-pending-new.kqlx');
		const oldInfo = classifyWorkbenchUri(oldUri)!;
		const newInfo = classifyWorkbenchUri(newUri)!;
		const oldTab = {
			isActive: true,
			input: new vscode.TabInputCustom(oldUri, 'kusto.kqlxEditor'),
			label: 'clarification-pending-old.kqlx',
		};
		const group = { activeTab: oldTab, tabs: [oldTab], isActive: true };
		const poster = createMessagePoster();
		orchestrator.connect(poster, vi.fn(async () => []), vi.fn(), oldUri.toString());
		setTabGroups(group);

		const pending = orchestrator.delegateToKustoWorkbenchCopilot({
			question: 'Help', openFileId: oldInfo.openFileId,
		});
		const request = poster.mock.calls[0][0] as any;
		await orchestrator.handleFilesRenamed([{ oldUri, newUri }]);

		expect(group.tabs).toContain(oldTab);
		orchestrator.handleWebviewResponse(request.requestId, {
			outcome: 'clarification-required', success: false,
			question: 'Which range?', sectionId: 'query_1',
		});

		await expect(pending).resolves.toEqual(expect.objectContaining({ openFileId: newInfo.openFileId }));
		await vi.waitFor(() => expect(group.tabs).not.toContain(oldTab));
	});

	it('fences native rename until the current-identity clarification response settles', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const oldUri = vscode.Uri.file('/work/clarification-will-old.kqlx');
		const newUri = vscode.Uri.file('/work/clarification-will-new.kqlx');
		const oldInfo = classifyWorkbenchUri(oldUri)!;
		const poster = createMessagePoster();
		orchestrator.connect(poster, vi.fn(async () => []), vi.fn(), oldUri.toString());

		const pending = orchestrator.delegateToKustoWorkbenchCopilot({
			question: 'Help', openFileId: oldInfo.openFileId,
		});
		const request = poster.mock.calls[0][0] as any;
		let renameFenceSettled = false;
		const renameFence = orchestrator.prepareFilesRename([{ oldUri, newUri }])
			.then(() => { renameFenceSettled = true; });
		await Promise.resolve();

		expect(renameFenceSettled).toBe(false);
		orchestrator.handleWebviewResponse(request.requestId, {
			outcome: 'clarification-required', success: false,
			question: 'Which range?', sectionId: 'query_1',
		});

		await expect(pending).resolves.toEqual(expect.objectContaining({ openFileId: oldInfo.openFileId }));
		await renameFence;
		expect(renameFenceSettled).toBe(true);
	});

	it('keeps old identity and releases ownership block when a prepared rename never completes', async () => {
		vi.useFakeTimers();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const oldUri = vscode.Uri.file('/work/cancelled-rename-old.kqlx');
		const newUri = vscode.Uri.file('/work/cancelled-rename-new.kqlx');
		const oldInfo = classifyWorkbenchUri(oldUri)!;
		await vscode.workspace.fs.writeFile(oldUri, new TextEncoder().encode('{}'));
		(orchestrator as any).hostOwnedBackgroundFiles.set(oldInfo.logicalUriKey, undefined);

		await orchestrator.prepareFilesRename([{ oldUri, newUri }]);

		expect((orchestrator as any).resolveRenamedWorkbenchFileInfo(oldInfo).openFileId).toBe(oldInfo.openFileId);
		expect((orchestrator as any).backgroundMutationBlocks.get(oldInfo.logicalUriKey)).toBe(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect((orchestrator as any).backgroundMutationBlocks.has(oldInfo.logicalUriKey)).toBe(false);
		expect((orchestrator as any).hostOwnedBackgroundFiles.has(oldInfo.logicalUriKey)).toBe(true);
		expect((orchestrator as any).renamedWorkbenchFiles.has(oldInfo.logicalUriKey)).toBe(false);
	});

	it('keeps a rename fenced while an admitted background operation exceeds the cancellation timeout', async () => {
		vi.useFakeTimers();
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const oldUri = vscode.Uri.file('/work/slow-rename-old.kqlx');
		const newUri = vscode.Uri.file('/work/slow-rename-new.kqlx');
		const oldInfo = classifyWorkbenchUri(oldUri)!;
		await vscode.workspace.fs.writeFile(oldUri, new TextEncoder().encode('{}'));
		(orchestrator as any).hostOwnedBackgroundFiles.set(oldInfo.logicalUriKey, undefined);
		const operationGate = deferred<void>();
		const operation = (orchestrator as any).runBackgroundFileOperation(
			oldInfo.logicalUriKey,
			() => operationGate.promise,
		);
		let prepareSettled = false;
		const preparing = orchestrator.prepareFilesRename([{ oldUri, newUri }])
			.then(() => { prepareSettled = true; });
		await Promise.resolve();

		await vi.advanceTimersByTimeAsync(10_000);
		expect(prepareSettled).toBe(false);
		expect((orchestrator as any).backgroundMutationBlocks.get(oldInfo.logicalUriKey)).toBe(1);
		operationGate.resolve();
		await operation;
		await preparing;
		expect((orchestrator as any).backgroundMutationBlocks.get(oldInfo.logicalUriKey)).toBe(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect((orchestrator as any).backgroundMutationBlocks.has(oldInfo.logicalUriKey)).toBe(false);
	});

	it('retires a rename alias when the old source path is recreated as a distinct file', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-rename-recreate-'));
		try {
			const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
				fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
			);
			const oldUri = vscode.Uri.file(join(root, 'source.kqlx'));
			const newUri = vscode.Uri.file(join(root, 'renamed.kqlx'));
			writeFileSync(newUri.fsPath, '{}');
			await orchestrator.handleFilesRenamed([{ oldUri, newUri }]);
			writeFileSync(oldUri.fsPath, '{}');
			const oldPoster = createMessagePoster();
			const newPoster = createMessagePoster();
			orchestrator.connect(oldPoster, vi.fn(async () => [{ id: 'query_old', type: 'query' }]), vi.fn(), oldUri.toString());
			orchestrator.connect(newPoster, vi.fn(async () => [{ id: 'query_new', type: 'query' }]), vi.fn(), newUri.toString());
			const oldTab = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(oldUri, 'kusto.kqlxEditor') };
			const newTab = { isActive: false, isDirty: false, input: new vscode.TabInputCustom(newUri, 'kusto.kqlxEditor') };
			setTabGroups(
				{ activeTab: oldTab, tabs: [oldTab], isActive: true },
				{ activeTab: newTab, tabs: [newTab], isActive: false },
			);

			const oldMutation = orchestrator.configureQuerySection({
				openFileId: classifyWorkbenchUri(oldUri)!.openFileId,
				sectionId: 'query_old',
				query: 'print Source = true',
			});
			expect(oldPoster).toHaveBeenCalledOnce();
			const oldRequest = oldPoster.mock.calls[0][0] as any;
			orchestrator.handleWebviewResponse(oldRequest.requestId, { success: true });
			await expect(oldMutation).resolves.toEqual({ success: true });

			const newMutation = orchestrator.configureQuerySection({
				openFileId: classifyWorkbenchUri(newUri)!.openFileId,
				sectionId: 'query_new',
				query: 'print Renamed = true',
			});
			expect(newPoster).toHaveBeenCalledOnce();
			const newRequest = newPoster.mock.calls[0][0] as any;
			orchestrator.handleWebviewResponse(newRequest.requestId, { success: true });
			await expect(newMutation).resolves.toEqual({ success: true });
			expect((orchestrator as any).renamedWorkbenchFiles.has(classifyWorkbenchUri(oldUri)!.logicalUriKey)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('flattens chained rename aliases before an intermediate path is recreated', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-rename-chain-'));
		try {
			const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
				fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
			);
			const uriA = vscode.Uri.file(join(root, 'a.kqlx'));
			const uriB = vscode.Uri.file(join(root, 'b.kqlx'));
			const uriC = vscode.Uri.file(join(root, 'c.kqlx'));
			writeFileSync(uriC.fsPath, '{}');
			await orchestrator.handleFilesRenamed([{ oldUri: uriA, newUri: uriB }]);
			await orchestrator.handleFilesRenamed([{ oldUri: uriB, newUri: uriC }]);
			writeFileSync(uriB.fsPath, '{}');
			const posterB = createMessagePoster();
			const posterC = createMessagePoster();
			orchestrator.connect(posterB, vi.fn(async () => [{ id: 'query_b', type: 'query' }]), vi.fn(), uriB.toString());
			orchestrator.connect(posterC, vi.fn(async () => [{ id: 'query_c', type: 'query' }]), vi.fn(), uriC.toString());
			const tabB = { isActive: true, isDirty: false, input: new vscode.TabInputCustom(uriB, 'kusto.kqlxEditor') };
			const tabC = { isActive: false, isDirty: false, input: new vscode.TabInputCustom(uriC, 'kusto.kqlxEditor') };
			setTabGroups(
				{ activeTab: tabB, tabs: [tabB], isActive: true },
				{ activeTab: tabC, tabs: [tabC], isActive: false },
			);

			const mutationB = orchestrator.configureQuerySection({
				openFileId: classifyWorkbenchUri(uriB)!.openFileId,
				sectionId: 'query_b',
				query: 'print B = true',
			});
			expect(posterB).toHaveBeenCalledOnce();
			const requestB = posterB.mock.calls[0][0] as any;
			orchestrator.handleWebviewResponse(requestB.requestId, { success: true });
			await expect(mutationB).resolves.toEqual({ success: true });

			const mutationC = orchestrator.configureQuerySection({
				openFileId: classifyWorkbenchUri(uriC)!.openFileId,
				sectionId: 'query_c',
				query: 'print C = true',
			});
			expect(posterC).toHaveBeenCalledOnce();
			const requestC = posterC.mock.calls[0][0] as any;
			orchestrator.handleWebviewResponse(requestC.requestId, { success: true });
			await expect(mutationC).resolves.toEqual({ success: true });
			const aliasA = (orchestrator as any).renamedWorkbenchFiles.get(classifyWorkbenchUri(uriA)!.logicalUriKey);
			expect(aliasA?.logicalUriKey).toBe(classifyWorkbenchUri(uriC)!.logicalUriKey);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('does not fence rename on unrelated pending tools', async () => {
		const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient,
		);
		const oldUri = vscode.Uri.file('/work/configure-will-old.kqlx');
		const newUri = vscode.Uri.file('/work/configure-will-new.kqlx');
		const oldInfo = classifyWorkbenchUri(oldUri)!;
		const poster = createMessagePoster();
		orchestrator.connect(poster, vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), oldUri.toString());

		const pending = orchestrator.configureQuerySection({
			question: 'Configure', sectionId: 'query_1', query: 'print 1', openFileId: oldInfo.openFileId,
		} as any);
		const request = poster.mock.calls[0][0] as any;
		await expect(orchestrator.prepareFilesRename([{ oldUri, newUri }])).resolves.toBeUndefined();
		orchestrator.handleWebviewResponse(request.requestId, { success: true });

		await expect(pending).resolves.toEqual(expect.objectContaining({ success: true }));
	});
});
