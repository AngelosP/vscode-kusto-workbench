import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { KustoWorkbenchToolOrchestrator } from '../../../src/host/kustoWorkbenchTools';
import { classifyWorkbenchUri } from '../../../src/host/workbenchFileTypes';
import { kustoClusterKey } from '../../../src/shared/kustoClusterUrls';
import { SCHEMA_CACHE_VERSION } from '../../../src/host/schemaCache';

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

describe('KustoWorkbenchToolOrchestrator connect/disconnect', () => {
	beforeEach(() => {
		// Reset the singleton between tests
		(KustoWorkbenchToolOrchestrator as any).instance = undefined;
		resetOpenEditorState();
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
		const poster = vi.fn(() => true);
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
		const poster = vi.fn(() => true);
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
		const poster = vi.fn(() => true);
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
		const dispatchOwner = vi.fn(async (_connection: unknown, _principal: string, _revocation: number, dispatch: () => unknown) => {
			liveOwner = { ...liveOwner, database: 'DbB', generation: 2 };
			return await dispatch();
		});
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient,
			vi.fn(async () => []), vi.fn(async () => undefined), () => 0, dispatchOwner,
		);
		const poster = vi.fn(() => true);
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
		const dispatchOwner = vi.fn(async (_connection: unknown, _principal: string, _revocation: number, dispatch: () => unknown) => {
			liveOwner = undefined;
			return await dispatch();
		});
		const orch = KustoWorkbenchToolOrchestrator.getInstance(
			fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient,
			vi.fn(async () => []), vi.fn(async () => undefined), () => 0, dispatchOwner,
		);
		const poster = vi.fn(() => true);
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
		const firstPoster = vi.fn(() => true);
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
		const firstPoster = vi.fn(() => true);
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
		const poster = vi.fn(() => true);
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
		const poster = vi.fn(() => true);
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
		const poster = vi.fn(() => true);
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
		const poster = vi.fn(() => true);
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
		const poster = vi.fn(() => true);
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
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const uri = vscode.Uri.file('/work/active-query.kqlx');
		const poster = vi.fn();
		orch.connect(poster, vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), uri.toString());
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const cancellation = cancellationToken();

		const configurePromise = orch.configureQuerySection({ sectionId: 'query_1', query: 'range x from 1 to 10 step 1', execute: true }, cancellation.token);
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
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, fakeGetSqlConnMgr, fakeKustoClient);
		const uri = vscode.Uri.file('/work/active-query.kqlx');
		const poster = vi.fn();
		orch.connect(poster, vi.fn(async () => [{ id: 'query_1', type: 'query' }]), vi.fn(), uri.toString());
		setActiveCustomTab(uri, 'kusto.kqlxEditor');
		const cancellation = cancellationToken();

		const configurePromise = orch.configureQuerySection({ sectionId: 'query_1', query: 'range x from 1 to 10 step 1', execute: true }, cancellation.token);
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
		const sqlPoster = vi.fn(() => true);
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
		const poster = vi.fn(() => true);
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
		const poster = vi.fn(() => true);
		let liveOwner = { connectionId: 'sql-a', database: 'DbA', ownerToken: 'owner-a', generation: 1 };
		orch.connect(
			poster,
			vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: liveOwner.database, ownerToken: liveOwner.ownerToken }]),
			vi.fn(), undefined,
			() => liveOwner.connectionId,
			() => ({ ...liveOwner }),
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
	});

	it('dispatches SQL configuration to the editor captured before asynchronous preflight', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'aad' };
		const preflight = deferred<void>();
		const assertAllowed = vi.fn(async () => preflight.promise);
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient, undefined, assertAllowed);
		const firstPoster = vi.fn(() => true);
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
		const poster = vi.fn(() => true);
		const owner = { connectionId: 'sql-test', database: 'Db', ownerToken: 'owner-token', generation: 1 };
		const token = orch.connect(
			poster, vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'Db' }]), vi.fn(), undefined,
			() => 'sql-test', () => ({ ...owner }),
		);
		vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ get: vi.fn(() => 0) } as any);

		const request = orch.configureSqlSection({ sectionId: 'sql_1', connectionId: 'sql-test', query: 'WAITFOR DELAY', execute: true });
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		orch.disconnectIfOwner(token);

		await expect(request).rejects.toThrow('editor closed');
	});

	it('keeps an unbounded pending tool request alive when its editor is reactivated', async () => {
		const connection = { id: 'sql-test', name: 'SQL', serverUrl: 'server.example', dialect: 'mssql', authType: 'sql-login', username: 'user' };
		const sqlManager = { getConnections: () => [connection], getConnection: () => connection, assertConnectionCurrent: vi.fn(async () => undefined) } as any;
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager, () => sqlManager, fakeKustoClient);
		const poster = vi.fn(() => true);
		const owner = { connectionId: 'sql-test', database: 'Db', ownerToken: 'owner-token', generation: 1 };
		const token = orch.connect(
			poster, vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'Db' }]), vi.fn(), undefined,
			() => 'sql-test', () => ({ ...owner }),
		);
		vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ get: vi.fn(() => 0) } as any);

		const request = orch.configureSqlSection({ sectionId: 'sql_1', connectionId: 'sql-test', query: 'WAITFOR DELAY', execute: true });
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
		const poster = vi.fn(() => true);
		const owner = { connectionId: 'sql-test', database: 'Db', ownerToken: 'owner-token', generation: 1 };
		orch.connect(
			poster, vi.fn(async () => [{ id: 'sql_1', type: 'sql', database: 'Db' }]), vi.fn(), undefined,
			() => 'sql-test', () => ({ ...owner }),
		);
		const cancellation = cancellationToken();

		const request = orch.configureSqlSection({
			sectionId: 'sql_1', connectionId: 'sql-test', query: 'WAITFOR DELAY', execute: true,
		}, cancellation.token);
		await vi.waitFor(() => expect(poster).toHaveBeenCalledOnce());
		const configureMessage = poster.mock.calls[0][0] as any;
		cancellation.cancel();

		await expect(request).rejects.toMatchObject({ name: 'Canceled' });
		expect(poster).toHaveBeenCalledWith({
			type: 'toolCancelSqlExecution', sectionId: 'sql_1', executionId: configureMessage.input.executionId,
		});
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
});
