import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { KustoWorkbenchToolOrchestrator } from '../../../src/host/kustoWorkbenchTools';
import { classifyWorkbenchUri } from '../../../src/host/workbenchFileTypes';

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

const fakeGetSqlConnMgr = () => ({ getConnections: () => [] }) as any;
const fakeKustoClient = {} as any;

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
		const sqlPoster = vi.fn();
		const notebookPoster = vi.fn();
		const sqlStateGetter = vi.fn(async () => [{ id: 'sql_1', type: 'sql', name: 'SQL', serverUrl: 'server.example', database: 'db' }]);
		const notebookStateGetter = vi.fn(async () => [{ id: 'notebook_query', type: 'query' }]);

		orch.connect(sqlPoster, sqlStateGetter, vi.fn(), sqlUri.toString());
		orch.connect(notebookPoster, notebookStateGetter, vi.fn(), notebookUri.toString());
		setActiveCustomTab(sqlUri, 'kusto.sqlCompatEditor');

		const result = await orch.listSections();
		expect(sqlStateGetter).toHaveBeenCalledTimes(1);
		expect(notebookStateGetter).toHaveBeenCalledTimes(1);
		expect(result.sections[0]).toMatchObject({ id: 'sql_1', type: 'sql', serverUrl: 'server.example', database: 'db' });
		expect(result.fileName).toBe('query.sql');

		const configurePromise = orch.configureSqlSection({ sectionId: 'sql_1', query: 'select 1' });
		expect(sqlPoster).toHaveBeenCalledTimes(1);
		expect(notebookPoster).not.toHaveBeenCalled();
		const postedMessage = sqlPoster.mock.calls[0][0] as any;
		expect(postedMessage.type).toBe('toolConfigureSqlSection');
		orch.handleWebviewResponse(postedMessage.requestId, { success: true });
		await expect(configurePromise).resolves.toEqual({ success: true });
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
