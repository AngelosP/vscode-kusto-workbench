import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KwSectionShell } from '../../src/webview/components/kw-section-shell.js';

const handlerState = vi.hoisted(() => ({
	sqlConnections: [] as Array<Record<string, unknown>>,
	sqlCachedDatabases: {} as Record<string, string[]>,
	sqlFavorites: [] as Array<Record<string, unknown>>,
	sqlFavoritesModeByBoxId: {} as Record<string, boolean>,
	schemaByBoxId: {} as Record<string, unknown>,
	schemaMetaByBoxId: {} as Record<string, unknown>,
	schemaByConnDb: {} as Record<string, unknown>,
	schemaMetaByConnDb: {} as Record<string, unknown>,
	pendingSchemaWorkerUpdateByBoxId: {} as Record<string, unknown>,
	schemaRequestTokenByBoxId: {} as Record<string, string>,
	queryEditors: {} as Record<string, any>,
	optimizationMetadataByBoxId: {} as Record<string, any>,
	pState: {
		isSessionFile: false,
		documentUri: '',
		documentKind: 'kqlx',
		allowedSectionKinds: ['query', 'chart', 'python', 'url', 'markdown'],
		defaultSectionKind: 'query',
		compatibilityMode: false,
		compatibilitySingleKind: 'query',
		upgradeRequestType: 'requestUpgradeToKqlx',
		compatibilityTooltip: '',
		copilotChatFirstTimeDismissed: false,
		devNotesSections: [],
		lastExecutedBox: '',
		resultsVisibleByBoxId: {},
	} as Record<string, unknown>,
}));

const mocks = {
	postMessageToHost: vi.fn(),
	handleDocumentDataMessage: vi.fn(),
	updateConnectionSelects: vi.fn(),
	updateDatabaseSelect: vi.fn(),
	onDatabasesError: vi.fn(),
	updateSqlConnectionSelects: vi.fn(),
	updateSqlDatabaseSelect: vi.fn(),
	onSqlDatabasesError: vi.fn(),
	getQuerySectionElement: vi.fn(),
	getConnectionId: vi.fn(() => ''),
	getDatabase: vi.fn(() => ''),
	updateSqlFavoritesUiForAllBoxes: vi.fn(),
	getSqlSectionElement: vi.fn(),
	parseKustoExplorerConnectionsXml: vi.fn(),
	onPythonResult: vi.fn(),
	onPythonError: vi.fn(),
	handleStsResponse: vi.fn(),
	handleStsDiagnostics: vi.fn(),
	displayCancelled: vi.fn(),
	setQueryExecuting: vi.fn(),
	setResultsVisible: vi.fn(),
	setConnections: vi.fn(),
	setSqlConnections: vi.fn(),
	setLastConnectionId: vi.fn(),
	setLastDatabase: vi.fn(),
	setKustoFavorites: vi.fn(),
	setSqlFavorites: vi.fn(),
	setLeaveNoTraceClusters: vi.fn(),
	setCaretDocsEnabled: vi.fn(),
	setAutoTriggerAutocompleteEnabled: vi.fn(),
	setCopilotInlineCompletionsEnabled: vi.fn(),
	setRunMode: vi.fn(),
	updateCaretDocsToggleButtons: vi.fn(),
	updateAutoTriggerAutocompleteToggleButtons: vi.fn(),
	updateCopilotInlineCompletionsToggleButtons: vi.fn(),
};

vi.mock('../../src/webview/shared/persistence-state.js', () => ({
	pState: handlerState.pState,
}));

vi.mock('../../src/webview/shared/webview-messages.js', () => ({
	postMessageToHost: mocks.postMessageToHost,
}));

vi.mock('../../src/webview/shared/schema-utils.js', () => ({
	buildSchemaInfo: vi.fn((text: string, isError: boolean, meta?: unknown) => ({ text, isError, meta })),
}));

vi.mock('../../src/webview/shared/safe-run.js', () => ({
	safeRun: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../src/webview/core/results-state.js', () => ({
	getResultsState: vi.fn(() => null),
	getResultsStateRevision: vi.fn(() => 0),
	displayResultForBox: vi.fn(),
	displayResult: vi.fn(),
	displayCancelled: mocks.displayCancelled,
}));

vi.mock('../../src/webview/core/error-renderer.js', () => ({
	__kustoRenderErrorUx: vi.fn(),
	__kustoDisplayBoxError: vi.fn(),
}));

vi.mock('../../src/webview/core/section-factory.js', () => ({
	addQueryBox: vi.fn(() => 'query_1'),
	removeQueryBox: vi.fn(),
	toggleCacheControls: vi.fn(),
	__kustoGetQuerySectionElement: mocks.getQuerySectionElement,
	__kustoSetSectionName: vi.fn(),
	__kustoGetSectionName: vi.fn(() => ''),
	__kustoPickNextAvailableSectionLetterName: vi.fn(() => 'A'),
	__kustoGetConnectionId: mocks.getConnectionId,
	__kustoGetDatabase: mocks.getDatabase,
	__kustoLog: vi.fn(),
	updateConnectionSelects: mocks.updateConnectionSelects,
	updateDatabaseSelect: mocks.updateDatabaseSelect,
	onDatabasesError: mocks.onDatabasesError,
	parseKustoExplorerConnectionsXml: mocks.parseKustoExplorerConnectionsXml,
	__kustoUpdateFavoritesUiForAllBoxes: vi.fn(),
	__kustoTryAutoEnterFavoritesModeForAllBoxes: vi.fn(),
	__kustoMaybeDefaultFirstBoxToFavoritesMode: vi.fn(),
	__kustoOnConnectionsUpdated: vi.fn(),
	schemaRequestTokenByBoxId: handlerState.schemaRequestTokenByBoxId,
	addPythonBox: vi.fn(() => 'python_1'),
	addUrlBox: vi.fn(() => 'url_1'),
	removePythonBox: vi.fn(),
	removeUrlBox: vi.fn(),
	addHtmlBox: vi.fn(() => 'html_1'),
	removeHtmlBox: vi.fn(),
	addSqlBox: vi.fn(() => 'sql_1'),
	removeSqlBox: vi.fn(),
	updateSqlConnectionSelects: mocks.updateSqlConnectionSelects,
	updateSqlDatabaseSelect: mocks.updateSqlDatabaseSelect,
	onSqlDatabasesError: mocks.onSqlDatabasesError,
	__kustoGetSqlSectionElement: mocks.getSqlSectionElement,
	sqlBoxes: [],
	updateSqlFavoritesUiForAllBoxes: mocks.updateSqlFavoritesUiForAllBoxes,
	onPythonResult: mocks.onPythonResult,
	onPythonError: mocks.onPythonError,
	__kustoGetChartValidationStatus: vi.fn(() => null),
}));

vi.mock('../../src/webview/sections/kw-markdown-section.js', () => ({
	addMarkdownBox: vi.fn(() => 'markdown_1'),
	removeMarkdownBox: vi.fn(),
	__kustoMaximizeMarkdownBox: vi.fn(),
}));

vi.mock('../../src/webview/sections/kw-chart-section.js', () => ({
	addChartBox: vi.fn(() => 'chart_1'),
	removeChartBox: vi.fn(),
}));

vi.mock('../../src/webview/sections/kw-transformation-section.js', () => ({
	addTransformationBox: vi.fn(() => 'transformation_1'),
	removeTransformationBox: vi.fn(),
}));


vi.mock('../../src/webview/sections/kw-query-toolbar.js', () => ({
	updateCaretDocsToggleButtons: mocks.updateCaretDocsToggleButtons,
	updateAutoTriggerAutocompleteToggleButtons: mocks.updateAutoTriggerAutocompleteToggleButtons,
	updateCopilotInlineCompletionsToggleButtons: mocks.updateCopilotInlineCompletionsToggleButtons,
	getRunMode: vi.fn(() => 'all'),
	setRunMode: mocks.setRunMode,
	closeRunMenu: vi.fn(),
	functionRunDialogOpenByBoxId: {},
}));

vi.mock('../../src/webview/sections/query-execution.controller.js', async () => {
	const actual = await vi.importActual<typeof import('../../src/webview/sections/query-execution.controller.js')>('../../src/webview/sections/query-execution.controller.js');
	return {
		...actual,
		executeQuery: vi.fn(),
		setQueryExecuting: mocks.setQueryExecuting,
		__kustoSetResultsVisible: mocks.setResultsVisible,
		__kustoSetLinkedOptimizationMode: vi.fn(),
		displayComparisonSummary: vi.fn(),
		optimizeQueryWithCopilot: actual.optimizeQueryWithCopilot,
		__kustoSetOptimizeInProgress: vi.fn(),
		__kustoHideOptimizePromptForBox: vi.fn(),
		__kustoApplyOptimizeQueryOptions: vi.fn(),
	};
});

vi.mock('../../src/webview/core/persistence.js', () => ({
	schedulePersist: vi.fn(),
	handleDocumentDataMessage: mocks.handleDocumentDataMessage,
	getKqlxState: vi.fn(() => ({ sections: [] })),
	__kustoSetCompatibilityMode: vi.fn(),
	__kustoApplyDocumentCapabilities: vi.fn(),
	__kustoRequestAddSection: vi.fn(),
	__kustoOnQueryResult: vi.fn(),
	__kustoScheduleLocalSchemaPrewarm: vi.fn(),
}));

vi.mock('../../src/webview/monaco/monaco.js', () => ({
	__kustoControlCommandDocCache: {},
	__kustoControlCommandDocPending: {},
	__kustoCrossClusterSchemas: {},
}));

vi.mock('../../src/webview/monaco/suggest.js', () => ({
	__kustoFindSuggestWidgetForEditor: vi.fn(() => null),
	__kustoIsElementVisibleForSuggest: vi.fn(() => false),
}));

vi.mock('../../src/webview/monaco/sql-sts-providers.js', () => ({
	handleStsResponse: mocks.handleStsResponse,
	handleStsDiagnostics: mocks.handleStsDiagnostics,
}));

vi.mock('../../src/webview/core/state.js', () => ({
	activeQueryEditorBoxId: '',
	connections: [],
	setConnections: mocks.setConnections,
	sqlConnections: handlerState.sqlConnections,
	setSqlConnections: vi.fn((connections: Array<Record<string, unknown>>) => {
		mocks.setSqlConnections(connections);
		handlerState.sqlConnections.splice(0, handlerState.sqlConnections.length, ...connections);
	}),
	setLastConnectionId: mocks.setLastConnectionId,
	setLastDatabase: mocks.setLastDatabase,
	kustoFavorites: [],
	setKustoFavorites: mocks.setKustoFavorites,
	sqlFavorites: handlerState.sqlFavorites,
	setSqlFavorites: vi.fn((favorites: Array<Record<string, unknown>>) => {
		mocks.setSqlFavorites(favorites);
		handlerState.sqlFavorites.splice(0, handlerState.sqlFavorites.length, ...favorites);
	}),
	sqlCachedDatabases: handlerState.sqlCachedDatabases,
	sqlFavoritesModeByBoxId: handlerState.sqlFavoritesModeByBoxId,
	setLeaveNoTraceClusters: mocks.setLeaveNoTraceClusters,
	setCaretDocsEnabled: mocks.setCaretDocsEnabled,
	setAutoTriggerAutocompleteEnabled: mocks.setAutoTriggerAutocompleteEnabled,
	setCopilotInlineCompletionsEnabled: mocks.setCopilotInlineCompletionsEnabled,
	queryEditors: handlerState.queryEditors,
	queryExecutionTimers: {},
	pendingFavoriteSelectionByBoxId: {},
	cachedDatabases: {},
	optimizationMetadataByBoxId: handlerState.optimizationMetadataByBoxId,
	schemaByConnDb: handlerState.schemaByConnDb,
	schemaMetaByConnDb: handlerState.schemaMetaByConnDb,
	schemaRequestResolversByBoxId: {},
	schemaByBoxId: handlerState.schemaByBoxId,
	schemaMetaByBoxId: handlerState.schemaMetaByBoxId,
	schemaFetchInFlightByBoxId: {},
	markSchemaWorkerApplyFailed: vi.fn(),
	markSchemaWorkerApplyPending: vi.fn(),
	markSchemaWorkerReady: vi.fn(),
	pendingSchemaWorkerUpdateByBoxId: handlerState.pendingSchemaWorkerUpdateByBoxId,
	databasesRequestResolversByBoxId: {},
}));

type FakeSqlSection = HTMLElement & {
	_stsReady?: boolean;
	setSqlConnectionId: ReturnType<typeof vi.fn>;
	setFavoritesMode: ReturnType<typeof vi.fn>;
	setSchemaInfo: ReturnType<typeof vi.fn>;
	setStsReady: ReturnType<typeof vi.fn>;
};

type FakeHtmlSection = HTMLElement & {
	getCode: ReturnType<typeof vi.fn>;
	setCode: ReturnType<typeof vi.fn>;
	getMode: ReturnType<typeof vi.fn>;
	setMode: ReturnType<typeof vi.fn>;
	fitToContents: ReturnType<typeof vi.fn>;
	previewHeightUserSet?: boolean;
	updateComplete: Promise<void>;
};

function createFakeSqlSection(): FakeSqlSection {
	const el = document.createElement('div') as FakeSqlSection;
	el.setSqlConnectionId = vi.fn();
	el.setFavoritesMode = vi.fn();
	el.setSchemaInfo = vi.fn();
	el.setStsReady = vi.fn((ready: boolean) => {
		el._stsReady = ready;
	});
	return el;
}

function createFakeHtmlSection(id: string): FakeHtmlSection {
	const el = document.createElement('div') as FakeHtmlSection;
	el.id = id;
	el.getCode = vi.fn(() => '');
	el.setCode = vi.fn();
	el.getMode = vi.fn(() => 'code');
	el.setMode = vi.fn();
	el.fitToContents = vi.fn();
	el.updateComplete = Promise.resolve();
	document.body.appendChild(el);
	return el;
}

type FakeSectionHost = HTMLElement & {
	serialize: ReturnType<typeof vi.fn>;
	copilotWriteQuerySetQuery?: ReturnType<typeof vi.fn>;
};

function ensureQueriesContainer(): HTMLElement {
	let container = document.getElementById('queries-container');
	if (!container) {
		container = document.createElement('div');
		container.id = 'queries-container';
		document.body.appendChild(container);
	}
	return container;
}

function createSectionWithShell(id: string, initialState: Record<string, unknown> = { id, type: 'query', query: '' }) {
	const container = ensureQueriesContainer();
	const section = document.createElement('div') as FakeSectionHost;
	section.id = id;
	let serializedState = initialState;
	section.serialize = vi.fn(() => serializedState);
	section.attachShadow({ mode: 'open' });
	const shell = document.createElement('kw-section-shell') as KwSectionShell;
	section.shadowRoot!.appendChild(shell);
	container.appendChild(section);
	return {
		section,
		shell,
		setSerializedState: (nextState: Record<string, unknown>) => { serializedState = nextState; },
	};
}

function createQueryCacheControls(boxId: string): void {
	const enabled = document.createElement('input');
	enabled.id = `${boxId}_cache_enabled`;
	enabled.type = 'checkbox';
	const value = document.createElement('input');
	value.id = `${boxId}_cache_value`;
	value.value = '1';
	const unit = document.createElement('select');
	unit.id = `${boxId}_cache_unit`;
	unit.value = 'h';
	document.body.append(enabled, value, unit);
}

function dispatchHostMessage(data: Record<string, unknown>): void {
	window.dispatchEvent(new MessageEvent('message', { data }));
}

let getResultsStateMock: ReturnType<typeof vi.fn>;

describe('message-handler dispatch', () => {
	beforeAll(async () => {
		(window as any).vscode = {
			postMessage: vi.fn(),
			getState: vi.fn(() => ({})),
			setState: vi.fn(),
		};
		await import('../../src/webview/components/kw-section-shell.js');
		const resultsState = await import('../../src/webview/core/results-state.js');
		getResultsStateMock = resultsState.getResultsState as unknown as ReturnType<typeof vi.fn>;
		await import('../../src/webview/core/message-handler.js');
	});

	beforeEach(() => {
		document.body.innerHTML = '';
		handlerState.sqlConnections.splice(0, handlerState.sqlConnections.length);
		handlerState.sqlFavorites.splice(0, handlerState.sqlFavorites.length);
		for (const key of Object.keys(handlerState.sqlCachedDatabases)) delete handlerState.sqlCachedDatabases[key];
		for (const key of Object.keys(handlerState.sqlFavoritesModeByBoxId)) delete handlerState.sqlFavoritesModeByBoxId[key];
		for (const key of Object.keys(handlerState.schemaByBoxId)) delete handlerState.schemaByBoxId[key];
		for (const key of Object.keys(handlerState.schemaMetaByBoxId)) delete handlerState.schemaMetaByBoxId[key];
		for (const key of Object.keys(handlerState.schemaByConnDb)) delete handlerState.schemaByConnDb[key];
		for (const key of Object.keys(handlerState.schemaMetaByConnDb)) delete handlerState.schemaMetaByConnDb[key];
		for (const key of Object.keys(handlerState.pendingSchemaWorkerUpdateByBoxId)) delete handlerState.pendingSchemaWorkerUpdateByBoxId[key];
		for (const key of Object.keys(handlerState.schemaRequestTokenByBoxId)) delete handlerState.schemaRequestTokenByBoxId[key];
		for (const key of Object.keys(handlerState.queryEditors)) delete handlerState.queryEditors[key];
		for (const key of Object.keys(handlerState.optimizationMetadataByBoxId)) delete handlerState.optimizationMetadataByBoxId[key];
		delete (window as any).__kustoSqlLastConnectionId;
		delete (window as any).__kustoSqlLastDatabase;
		vi.clearAllMocks();
		getResultsStateMock.mockReturnValue(null);
		mocks.getQuerySectionElement.mockReturnValue(null);
		mocks.getConnectionId.mockReturnValue('');
		mocks.getDatabase.mockReturnValue('');
		mocks.getSqlSectionElement.mockReturnValue(null);
	});

	it('routes documentData to persistence handler', async () => {
		const message = { type: 'documentData', ok: true, state: { sections: [] } };
		dispatchHostMessage(message);
		await Promise.resolve();
		expect(mocks.handleDocumentDataMessage).toHaveBeenCalledWith(message);
	});

	it('routes connectionsData to connection and toolbar updates', async () => {
		dispatchHostMessage({
			type: 'connectionsData',
			connections: [{ id: 'c1', name: 'A', clusterUrl: 'https://a.kusto.windows.net' }],
			lastConnectionId: 'c1',
			lastDatabase: 'db1',
			cachedDatabases: {},
			favorites: [],
			leaveNoTraceClusters: [],
			caretDocsEnabled: true,
			autoTriggerAutocompleteEnabled: true,
			copilotInlineCompletionsEnabled: true,
		});
		await Promise.resolve();
		expect(mocks.setConnections).toHaveBeenCalledTimes(1);
		expect(mocks.updateConnectionSelects).toHaveBeenCalledTimes(1);
		expect(mocks.updateCaretDocsToggleButtons).toHaveBeenCalledTimes(1);
	});

	it('routes databasesData and databasesError to database handlers', async () => {
		dispatchHostMessage({ type: 'databasesData', boxId: 'query_1', databases: ['db2', 'db1'], connectionId: 'c1' });
		dispatchHostMessage({ type: 'databasesError', boxId: 'query_1', error: 'boom', connectionId: 'c1' });
		await Promise.resolve();
		expect(mocks.updateDatabaseSelect).toHaveBeenCalledWith('query_1', ['db2', 'db1'], 'c1');
		expect(mocks.onDatabasesError).toHaveBeenCalledWith('query_1', 'boom', 'c1');
	});

	it('routes cross-cluster schema responses with their originating box id', async () => {
		const applyCrossClusterSchema = vi.fn();
		(window as any).__kustoApplyCrossClusterSchema = applyCrossClusterSchema;

		dispatchHostMessage({
			type: 'crossClusterSchemaData',
			boxId: 'query_7',
			clusterName: 'remote',
			clusterUrl: 'https://remote.kusto.windows.net',
			database: 'Telemetry',
			rawSchemaJson: '{"Databases":{}}',
		});
		await Promise.resolve();

		expect(applyCrossClusterSchema).toHaveBeenCalledWith(
			'remote',
			'https://remote.kusto.windows.net',
			'Telemetry',
			'{"Databases":{}}',
			'query_7',
		);
	});

	it('routes queryCancelled and ensureResultsVisible', async () => {
		dispatchHostMessage({ type: 'queryCancelled', boxId: 'query_2' });
		dispatchHostMessage({ type: 'ensureResultsVisible', boxId: 'query_2' });
		await Promise.resolve();
		expect(mocks.setQueryExecuting).toHaveBeenCalledWith('query_2', false);
		expect(mocks.displayCancelled).toHaveBeenCalledTimes(1);
		expect(mocks.setResultsVisible).toHaveBeenCalledWith('query_2', true);
	});

	it('routes one queryResult through rendering and the persistence owner once', async () => {
		const resultsState = await import('../../src/webview/core/results-state.js');
		const persistence = await import('../../src/webview/core/persistence.js');
		const result = {
			columns: [{ name: 'Value', type: 'long' }],
			rows: [[42]],
			metadata: { executionTime: '00:00:00.042' },
		};

		dispatchHostMessage({ type: 'queryResult', boxId: 'query_42', result });
		await Promise.resolve();

		expect(mocks.setQueryExecuting).toHaveBeenCalledWith('query_42', false);
		expect(resultsState.displayResultForBox).toHaveBeenCalledTimes(1);
		expect(resultsState.displayResultForBox).toHaveBeenCalledWith(result, 'query_42', { label: 'Results', showExecutionTime: true });
		expect(persistence.__kustoOnQueryResult).toHaveBeenCalledTimes(1);
		expect(persistence.__kustoOnQueryResult).toHaveBeenCalledWith('query_42', result);
	});

	it('routes pythonResult and pythonError to python module', async () => {
		dispatchHostMessage({ type: 'pythonResult', boxId: 'python_1', result: 'ok' });
		dispatchHostMessage({ type: 'pythonError', boxId: 'python_1', error: 'failed' });
		await Promise.resolve();
		expect(mocks.onPythonResult).toHaveBeenCalledTimes(1);
		expect(mocks.onPythonError).toHaveBeenCalledTimes(1);
	});

	it('routes importConnectionsXmlText through parser and outbound host message', async () => {
		mocks.parseKustoExplorerConnectionsXml.mockReturnValue([
			{ name: 'Conn', clusterUrl: 'https://x.kusto.windows.net', database: 'db' },
		]);

		dispatchHostMessage({ type: 'importConnectionsXmlText', text: '<xml/>', boxId: 'query_1' });
		await Promise.resolve();
		expect(mocks.parseKustoExplorerConnectionsXml).toHaveBeenCalledWith('<xml/>');
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'importConnectionsFromXml',
			connections: [{ name: 'Conn', clusterUrl: 'https://x.kusto.windows.net', database: 'db' }],
			boxId: 'query_1',
		});
	});

	it('routes sqlConnectionsData to SQL connection state and UI updates', async () => {
		dispatchHostMessage({
			type: 'sqlConnectionsData',
			connections: [{ id: 'sql_conn_1', name: 'Warehouse', serverUrl: 'tcp:sql.example.test', dialect: 'mssql', authType: 'aad' }],
			lastConnectionId: 'sql_conn_1',
			lastDatabase: 'Warehouse',
			cachedDatabases: { 'sql.example.test': ['Warehouse', 'Scratch'] },
			sqlFavorites: [{ name: 'Warehouse', connectionId: 'sql_conn_1', database: 'Warehouse' }],
		});
		await Promise.resolve();

		expect(mocks.setSqlConnections).toHaveBeenCalledWith([
			{ id: 'sql_conn_1', name: 'Warehouse', serverUrl: 'tcp:sql.example.test', dialect: 'mssql', authType: 'aad' },
		]);
		expect(handlerState.sqlCachedDatabases).toEqual({ 'sql.example.test': ['Warehouse', 'Scratch'] });
		expect((window as any).__kustoSqlLastConnectionId).toBe('sql_conn_1');
		expect((window as any).__kustoSqlLastDatabase).toBe('Warehouse');
		expect(mocks.setSqlFavorites).toHaveBeenCalledWith([
			{ name: 'Warehouse', connectionId: 'sql_conn_1', database: 'Warehouse' },
		]);
		expect(mocks.updateSqlConnectionSelects).toHaveBeenCalledTimes(1);
		expect(mocks.updateSqlFavoritesUiForAllBoxes).toHaveBeenCalledTimes(1);
	});

	it('routes sqlFavoritesData and enters favorites mode for the originating SQL section', async () => {
		const sqlEl = createFakeSqlSection();
		mocks.getSqlSectionElement.mockReturnValue(sqlEl);

		dispatchHostMessage({
			type: 'sqlFavoritesData',
			boxId: 'sql_1',
			favorites: [{ name: 'Warehouse', connectionId: 'sql_conn_1', database: 'Warehouse' }],
		});
		await Promise.resolve();

		expect(mocks.setSqlFavorites).toHaveBeenCalledWith([
			{ name: 'Warehouse', connectionId: 'sql_conn_1', database: 'Warehouse' },
		]);
		expect(mocks.updateSqlFavoritesUiForAllBoxes).toHaveBeenCalledTimes(1);
		expect(sqlEl.setFavoritesMode).toHaveBeenCalledWith(true);
		expect(handlerState.sqlFavoritesModeByBoxId.sql_1).toBe(true);
	});

	it('routes sqlDatabasesData and sqlDatabasesError to SQL database handlers', async () => {
		dispatchHostMessage({ type: 'sqlDatabasesData', boxId: 'sql_1', databases: ['B', 'A'], sqlConnectionId: 'sql_conn_1' });
		dispatchHostMessage({ type: 'sqlDatabasesError', boxId: 'sql_1', error: 'failed', sqlConnectionId: 'sql_conn_1' });
		await Promise.resolve();

		expect(mocks.updateSqlDatabaseSelect).toHaveBeenCalledWith('sql_1', ['B', 'A'], 'sql_conn_1');
		expect(mocks.onSqlDatabasesError).toHaveBeenCalledWith('sql_1', 'failed', 'sql_conn_1');
	});

	it('routes sqlConnectionAdded to SQL connection state and originating section', async () => {
		const sqlEl = createFakeSqlSection();
		const events: Array<Record<string, unknown>> = [];
		sqlEl.addEventListener('sql-connection-changed', ((event: CustomEvent) => {
			events.push(event.detail);
		}) as EventListener);
		mocks.getSqlSectionElement.mockReturnValue(sqlEl);

		dispatchHostMessage({
			type: 'sqlConnectionAdded',
			connections: [{ id: 'sql_conn_2', name: 'New SQL', serverUrl: 'tcp:new.example.test', dialect: 'mssql', authType: 'aad' }],
			boxId: 'sql_1',
			connectionId: 'sql_conn_2',
		});
		await Promise.resolve();

		expect(mocks.setSqlConnections).toHaveBeenCalledWith([
			{ id: 'sql_conn_2', name: 'New SQL', serverUrl: 'tcp:new.example.test', dialect: 'mssql', authType: 'aad' },
		]);
		expect(mocks.updateSqlConnectionSelects).toHaveBeenCalledTimes(1);
		expect(sqlEl.setSqlConnectionId).toHaveBeenCalledWith('sql_conn_2');
		expect(events).toEqual([{ boxId: 'sql_1', connectionId: 'sql_conn_2' }]);
	});

	it('routes sqlSchemaData success and error states to the SQL section', async () => {
		const sqlEl = createFakeSqlSection();
		mocks.getSqlSectionElement.mockReturnValue(sqlEl);
		const schema = {
			tables: ['Events', 'Users'],
			columnsByTable: { Events: { Id: 'int' }, Users: { Name: 'nvarchar' } },
		};

		dispatchHostMessage({
			type: 'sqlSchemaData',
			boxId: 'sql_1',
			schema,
			schemaMeta: { tablesCount: 2, columnsCount: 2, fromCache: true },
		});
		dispatchHostMessage({
			type: 'sqlSchemaData',
			boxId: 'sql_1',
			schemaMeta: { error: true, errorMessage: 'Schema failed' },
		});
		await Promise.resolve();

		expect(handlerState.schemaByBoxId.sql_1).toBe(schema);
		expect(sqlEl.setSchemaInfo).toHaveBeenNthCalledWith(1, {
			text: '2 tables, 2 cols (cached)',
			isError: false,
			meta: { fromCache: true, tablesCount: 2, columnsCount: 2, functionsCount: 0 },
		});
		expect(sqlEl.setSchemaInfo).toHaveBeenNthCalledWith(2, {
			text: 'Schema failed',
			isError: true,
			meta: undefined,
		});
	});

	it('routes STS response, diagnostics, and connection state messages', async () => {
		const sqlEl = createFakeSqlSection();
		mocks.getSqlSectionElement.mockReturnValue(sqlEl);

		dispatchHostMessage({ type: 'stsResponse', requestId: 'sts_1', result: { items: [] } });
		dispatchHostMessage({ type: 'stsDiagnostics', boxId: 'sql_1', markers: [{ message: 'before ready' }] });
		dispatchHostMessage({ type: 'stsDiagnostics', boxId: 'sql_1', markers: [] });
		dispatchHostMessage({ type: 'stsConnectionState', boxId: 'sql_1', state: 'ready' });
		dispatchHostMessage({ type: 'stsDiagnostics', boxId: 'sql_1', markers: [{ message: 'after ready' }] });
		await Promise.resolve();

		expect(mocks.handleStsResponse).toHaveBeenCalledWith('sts_1', { items: [] });
		expect(sqlEl.setStsReady).toHaveBeenCalledWith(true);
		expect(mocks.handleStsDiagnostics).toHaveBeenCalledTimes(2);
		expect(mocks.handleStsDiagnostics).toHaveBeenNthCalledWith(1, 'sql_1', []);
		expect(mocks.handleStsDiagnostics).toHaveBeenNthCalledWith(2, 'sql_1', [{ message: 'after ready' }]);
	});

	it('drops tokened Kusto schema responses when the box token no longer matches', async () => {
		handlerState.schemaRequestTokenByBoxId.query_1 = 'schema_new';

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database: 'Samples',
			clusterUrl: 'https://cluster.kusto.windows.net',
			requestToken: 'schema_old',
			schema: { tables: ['OldTable'], columnTypesByTable: {}, rawSchemaJson: { Databases: {} } },
			schemaMeta: { schemaSignature: 'old', workerUpdateNeeded: true },
		});

		expect(handlerState.schemaByBoxId.query_1).toBeUndefined();
		expect(handlerState.schemaByConnDb['c1|Samples']).toBeUndefined();
	});

	it('suppresses visible UI for silent cache-only schema misses', async () => {
		const errorRenderer = await import('../../src/webview/core/error-renderer.js');
		const sectionFactory = await import('../../src/webview/core/section-factory.js');
		handlerState.schemaRequestTokenByBoxId.query_1 = 'schema_prewarm';
		const queryEl = { setSchemaInfo: vi.fn() };
		(sectionFactory.__kustoGetQuerySectionElement as unknown as ReturnType<typeof vi.fn>).mockReturnValue(queryEl);

		dispatchHostMessage({
			type: 'schemaError',
			boxId: 'query_1',
			connectionId: 'c1',
			database: 'Samples',
			requestToken: 'schema_prewarm',
			cacheOnly: true,
			silent: true,
			error: 'No cached schema is available.',
		});

		expect(queryEl.setSchemaInfo).not.toHaveBeenCalled();
		expect(errorRenderer.__kustoDisplayBoxError).not.toHaveBeenCalled();
	});

	it('updates Kusto schema caches without touching the worker when schema metadata says it is unchanged', async () => {
		const state = await import('../../src/webview/core/state.js');
		const schema = { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: { Databases: {} } };

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database: 'Samples',
			clusterUrl: 'https://cluster.kusto.windows.net',
			schema,
			schemaMeta: { schemaSignature: 'same', workerUpdateNeeded: false, isBackgroundRefresh: true },
		});

		expect(handlerState.schemaByBoxId.query_1).toBe(schema);
		expect(handlerState.schemaByConnDb['c1|Samples']).toBe(schema);
		expect(state.markSchemaWorkerApplyPending).not.toHaveBeenCalled();
		expect(state.markSchemaWorkerReady).not.toHaveBeenCalled();
	});
});

describe('changedSections agent provenance', () => {
	beforeAll(async () => {
		await import('../../src/webview/components/kw-section-shell.js');
		await import('../../src/webview/core/message-handler.js');
	});

	beforeEach(() => {
		document.body.innerHTML = '';
		dispatchHostMessage({ type: 'documentData', ok: true, state: { sections: [] } });
		vi.clearAllMocks();
		mocks.getQuerySectionElement.mockReturnValue(null);
		mocks.getConnectionId.mockReturnValue('');
		mocks.getDatabase.mockReturnValue('');
		mocks.getSqlSectionElement.mockReturnValue(null);
		mocks.setRunMode.mockImplementation(() => undefined);
		for (const key of Object.keys(handlerState.queryEditors)) delete handlerState.queryEditors[key];
		for (const key of Object.keys(handlerState.optimizationMetadataByBoxId)) delete handlerState.optimizationMetadataByBoxId[key];
		handlerState.pState.compatibilityMode = false;
		handlerState.pState.compatibilitySingleKind = 'query';
	});

	it('clears the agent marker when a section becomes clean', async () => {
		const { section, shell } = createSectionWithShell('query_1');
		shell.agentTouched = true;
		shell.hasChanges = 'modified';
		shell.showDiffBtn = true;
		section.setAttribute('has-changes', 'modified');
		await shell.updateComplete;

		dispatchHostMessage({ type: 'changedSections', changes: [] });
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('');
		expect(shell.showDiffBtn).toBe(false);
		expect(shell.agentTouched).toBe(false);
		expect(shell.hasAttribute('agent-touched')).toBe(false);
		expect(section.hasAttribute('has-changes')).toBe(false);
	});

	it('confirms pending agent provenance when a tool change becomes modified', async () => {
		let query = 'StormEvents | count';
		const { section, shell, setSerializedState } = createSectionWithShell('query_1', { id: 'query_1', type: 'query', query });
		section.copilotWriteQuerySetQuery = vi.fn((nextQuery: string) => {
			query = String(nextQuery);
			setSerializedState({ id: 'query_1', type: 'query', query });
		});
		mocks.getQuerySectionElement.mockReturnValue(section);

		dispatchHostMessage({ type: 'copilotWriteQuerySetQuery', boxId: 'query_1', query: 'StormEvents | take 10' });
		await Promise.resolve();
		expect(shell.agentTouched).toBe(false);

		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_1', status: 'modified', contentChanged: true, settingsChanged: false }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('modified');
		expect(shell.showDiffBtn).toBe(true);
		expect(shell.agentTouched).toBe(true);
		expect(shell.hasAttribute('agent-touched')).toBe(true);
	});

	it('keeps pending agent provenance if the user edits before dirty reconciliation', async () => {
		let query = 'StormEvents | count';
		const { section, shell, setSerializedState } = createSectionWithShell('query_1', { id: 'query_1', type: 'query', query });
		section.copilotWriteQuerySetQuery = vi.fn((nextQuery: string) => {
			query = String(nextQuery);
			setSerializedState({ id: 'query_1', type: 'query', query });
		});
		mocks.getQuerySectionElement.mockReturnValue(section);

		dispatchHostMessage({ type: 'copilotWriteQuerySetQuery', boxId: 'query_1', query: 'StormEvents | take 10' });
		await Promise.resolve();
		expect(shell.agentTouched).toBe(false);

		query = 'StormEvents | take 10\n| summarize Count=count()';
		setSerializedState({ id: 'query_1', type: 'query', query });
		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_1', status: 'modified', contentChanged: true, settingsChanged: false }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('modified');
		expect(shell.agentTouched).toBe(true);
		expect(shell.hasAttribute('agent-touched')).toBe(true);
	});

	it('confirms pending agent provenance when a tool-added section is new', async () => {
		const { shell } = createSectionWithShell('query_1', { id: 'query_1', type: 'query', query: 'print 1' });

		dispatchHostMessage({ type: 'toolAddSection', requestId: 'r-new', input: { type: 'query', query: 'print 1' } });
		await Promise.resolve();
		expect(shell.agentTouched).toBe(false);

		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_1', status: 'new', contentChanged: true, settingsChanged: true }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('new');
		expect(shell.showDiffBtn).toBe(false);
		expect(shell.agentTouched).toBe(true);
	});

	it('does not inherit agent provenance from a no-op Copilot query update', async () => {
		let query = 'StormEvents | count';
		const { section, shell, setSerializedState } = createSectionWithShell('query_1', { id: 'query_1', type: 'query', query });
		section.copilotWriteQuerySetQuery = vi.fn((nextQuery: string) => {
			query = String(nextQuery);
			setSerializedState({ id: 'query_1', type: 'query', query });
		});
		mocks.getQuerySectionElement.mockReturnValue(section);

		dispatchHostMessage({ type: 'copilotWriteQuerySetQuery', boxId: 'query_1', query });
		await Promise.resolve();
		expect(shell.agentTouched).toBe(false);

		query = 'StormEvents | summarize Count=count()';
		setSerializedState({ id: 'query_1', type: 'query', query });
		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_1', status: 'modified', contentChanged: true, settingsChanged: false }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('modified');
		expect(shell.agentTouched).toBe(false);
		expect(shell.hasAttribute('agent-touched')).toBe(false);
	});

	it('does not restore agent provenance after save-clear followed by manual edit', async () => {
		let query = 'StormEvents | count';
		const { section, shell, setSerializedState } = createSectionWithShell('query_1', { id: 'query_1', type: 'query', query });
		section.copilotWriteQuerySetQuery = vi.fn((nextQuery: string) => {
			query = String(nextQuery);
			setSerializedState({ id: 'query_1', type: 'query', query });
		});
		mocks.getQuerySectionElement.mockReturnValue(section);

		dispatchHostMessage({ type: 'copilotWriteQuerySetQuery', boxId: 'query_1', query: 'StormEvents | take 10' });
		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_1', status: 'modified', contentChanged: true, settingsChanged: false }],
		});
		await Promise.resolve();
		await shell.updateComplete;
		expect(shell.agentTouched).toBe(true);

		dispatchHostMessage({ type: 'changedSections', changes: [] });
		await Promise.resolve();
		await shell.updateComplete;
		expect(shell.agentTouched).toBe(false);

		query = 'StormEvents | summarize Count=count()';
		setSerializedState({ id: 'query_1', type: 'query', query });
		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_1', status: 'modified', contentChanged: true, settingsChanged: false }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('modified');
		expect(shell.agentTouched).toBe(false);
		expect(shell.hasAttribute('agent-touched')).toBe(false);
	});

	it('does not mark compatibility metadata-only tool changes as pending provenance', async () => {
		const pState = (await import('../../src/webview/shared/persistence-state.js')).pState as any;
		pState.compatibilityMode = true;
		pState.compatibilitySingleKind = 'sql';
		let sqlState = { id: 'sql_1', type: 'sql', query: 'select 1', name: 'Original' };
		const { section, shell, setSerializedState } = createSectionWithShell('sql_1', sqlState);
		(section as any).setName = vi.fn((name: string) => {
			sqlState = { ...sqlState, name };
			setSerializedState(sqlState);
		});
		mocks.getSqlSectionElement.mockReturnValue(section);

		dispatchHostMessage({
			type: 'toolConfigureSqlSection',
			requestId: 'r-sql-metadata',
			input: { sectionId: 'sql_1', name: 'Renamed SQL' },
		});
		await Promise.resolve();
		expect(shell.agentTouched).toBe(false);

		sqlState = { ...sqlState, query: 'select 2' };
		setSerializedState(sqlState);
		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'sql_1', status: 'modified', contentChanged: true, settingsChanged: false }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('modified');
		expect(shell.agentTouched).toBe(false);
		expect(shell.hasAttribute('agent-touched')).toBe(false);
	});

	it('marks reused optimized comparison sections as agent-touched when dirty', async () => {
		let query = 'Old optimized query';
		const { shell, setSerializedState } = createSectionWithShell('query_cmp', { id: 'query_cmp', type: 'query', query });
		handlerState.queryEditors.query_cmp = {
			setValue: vi.fn((nextQuery: string) => {
				query = String(nextQuery);
				setSerializedState({ id: 'query_cmp', type: 'query', query });
			}),
		};
		handlerState.queryEditors.query_src = { getValue: vi.fn(() => 'Source query') };
		handlerState.optimizationMetadataByBoxId.query_src = { comparisonBoxId: 'query_cmp' };

		dispatchHostMessage({
			type: 'optimizeQueryReady',
			boxId: 'query_src',
			optimizedQuery: 'New optimized query',
			queryName: 'Source',
		});
		await Promise.resolve();
		expect(shell.agentTouched).toBe(false);

		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_cmp', status: 'modified', contentChanged: true, settingsChanged: false }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('modified');
		expect(shell.agentTouched).toBe(true);
	});

	it('marks newly created optimized comparison sections as agent-touched when new', async () => {
		const { shell } = createSectionWithShell('query_1', { id: 'query_1', type: 'query', query: 'New optimized query' });
		handlerState.queryEditors.query_src = { getValue: vi.fn(() => 'Source query') };

		dispatchHostMessage({
			type: 'optimizeQueryReady',
			boxId: 'query_src',
			optimizedQuery: 'New optimized query',
			queryName: 'Source',
		});
		await Promise.resolve();
		expect(shell.agentTouched).toBe(false);

		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_1', status: 'new', contentChanged: true, settingsChanged: true }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('new');
		expect(shell.agentTouched).toBe(true);
	});

	it('marks tool-driven collapse changes as agent-touched when dirty', async () => {
		let expanded = true;
		const { section, shell, setSerializedState } = createSectionWithShell('query_1', { id: 'query_1', type: 'query', query: 'print 1', expanded });
		(section as any).setExpanded = vi.fn((nextExpanded: boolean) => {
			expanded = nextExpanded;
			setSerializedState({ id: 'query_1', type: 'query', query: 'print 1', expanded });
		});

		dispatchHostMessage({ type: 'toolCollapseSection', requestId: 'r-collapse', sectionId: 'query_1', collapsed: true });
		await Promise.resolve();
		expect(shell.agentTouched).toBe(false);

		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_1', status: 'modified', contentChanged: false, settingsChanged: true }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('modified');
		expect(shell.agentTouched).toBe(true);
	});

	it('exposes a bridge for Copilot chat inserted sections', async () => {
		const { shell } = createSectionWithShell('query_1', { id: 'query_1', type: 'query', query: 'print 1' });

		window.__kustoMarkSectionAgentTouched?.('query_1');
		await Promise.resolve();
		expect(shell.agentTouched).toBe(false);

		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_1', status: 'new', contentChanged: true, settingsChanged: true }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('new');
		expect(shell.agentTouched).toBe(true);
	});

	it('marks ensured comparison boxes as agent-touched when dirty', async () => {
		let comparisonQuery = 'Old comparison query';
		const { shell, setSerializedState } = createSectionWithShell('query_cmp', { id: 'query_cmp', type: 'query', query: comparisonQuery });
		handlerState.queryEditors.query_src = {
			getModel: vi.fn(() => ({ getValue: vi.fn(() => 'Source query') })),
			getValue: vi.fn(() => 'Source query'),
		};
		handlerState.queryEditors.query_cmp = {
			setValue: vi.fn((nextQuery: string) => {
				comparisonQuery = String(nextQuery);
				setSerializedState({ id: 'query_cmp', type: 'query', query: comparisonQuery });
			}),
		};
		handlerState.optimizationMetadataByBoxId.query_src = { comparisonBoxId: 'query_cmp' };
		mocks.getConnectionId.mockReturnValue('conn-1');
		mocks.getDatabase.mockReturnValue('db-1');

		dispatchHostMessage({ type: 'ensureComparisonBox', requestId: 'r-ensure', boxId: 'query_src', query: 'New comparison query' });
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(shell.agentTouched).toBe(false);

		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_cmp', status: 'modified', contentChanged: true, settingsChanged: false }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('modified');
		expect(shell.agentTouched).toBe(true);
	});

	it('marks source settings changed by ensured comparison as agent-touched when dirty', async () => {
		let sourceState = { id: 'query_src', type: 'query', query: 'Source query', runMode: 'take100' };
		let comparisonState = { id: 'query_cmp', type: 'query', query: 'Old comparison query', runMode: 'take100' };
		const { shell, setSerializedState: setSourceSerializedState } = createSectionWithShell('query_src', sourceState);
		const { setSerializedState: setComparisonSerializedState } = createSectionWithShell('query_cmp', comparisonState);
		handlerState.queryEditors.query_src = {
			getModel: vi.fn(() => ({ getValue: vi.fn(() => 'Source query') })),
			getValue: vi.fn(() => 'Source query'),
		};
		handlerState.queryEditors.query_cmp = {
			setValue: vi.fn((nextQuery: string) => {
				comparisonState = { ...comparisonState, query: String(nextQuery) };
				setComparisonSerializedState(comparisonState);
			}),
		};
		handlerState.optimizationMetadataByBoxId.query_src = { comparisonBoxId: 'query_cmp' };
		mocks.getConnectionId.mockReturnValue('conn-1');
		mocks.getDatabase.mockReturnValue('db-1');
		mocks.setRunMode.mockImplementation((sectionId: string, mode: string) => {
			if (sectionId === 'query_src') {
				sourceState = { ...sourceState, runMode: mode };
				setSourceSerializedState(sourceState);
			} else if (sectionId === 'query_cmp') {
				comparisonState = { ...comparisonState, runMode: mode };
				setComparisonSerializedState(comparisonState);
			}
		});

		dispatchHostMessage({ type: 'ensureComparisonBox', requestId: 'r-ensure-source', boxId: 'query_src', query: 'New comparison query' });
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(shell.agentTouched).toBe(false);

		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_src', status: 'modified', contentChanged: false, settingsChanged: true }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('modified');
		expect(shell.agentTouched).toBe(true);
	});

	it('does not mark manual compare-created sections as agent-touched', async () => {
		let sourceState = { id: 'query_src', type: 'query', query: 'Source query', runMode: 'take100' };
		let comparisonState = { id: 'query_1', type: 'query', query: 'Source query', runMode: 'take100' };
		const { setSerializedState: setSourceSerializedState } = createSectionWithShell('query_src', sourceState);
		const { shell, setSerializedState: setComparisonSerializedState } = createSectionWithShell('query_1', comparisonState);
		handlerState.queryEditors.query_src = {
			getModel: vi.fn(() => ({ getValue: vi.fn(() => 'Source query') })),
			getValue: vi.fn(() => 'Source query'),
		};
		mocks.getConnectionId.mockReturnValue('conn-1');
		mocks.getDatabase.mockReturnValue('db-1');
		mocks.setRunMode.mockImplementation((sectionId: string, mode: string) => {
			if (sectionId === 'query_src') {
				sourceState = { ...sourceState, runMode: mode };
				setSourceSerializedState(sourceState);
			} else if (sectionId === 'query_1') {
				comparisonState = { ...comparisonState, runMode: mode };
				setComparisonSerializedState(comparisonState);
			}
		});
		const { optimizeQueryWithCopilot } = await import('../../src/webview/sections/query-execution.controller.js');

		await optimizeQueryWithCopilot('query_src', null, { skipExecute: true });
		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_1', status: 'new', contentChanged: true, settingsChanged: true }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('new');
		expect(shell.agentTouched).toBe(false);
	});

	it('marks compare-query-created comparison boxes as agent-touched when new', async () => {
		const { shell } = createSectionWithShell('query_1', { id: 'query_1', type: 'query', query: 'Comparison query' });
		createQueryCacheControls('query_src');
		createQueryCacheControls('query_1');
		handlerState.queryEditors.query_src = {
			getModel: vi.fn(() => ({ getValue: vi.fn(() => 'Source query') })),
			getValue: vi.fn(() => 'Source query'),
		};
		mocks.getConnectionId.mockReturnValue('conn-1');
		mocks.getDatabase.mockReturnValue('db-1');

		dispatchHostMessage({ type: 'compareQueryPerformanceWithQuery', boxId: 'query_src', query: 'Comparison query' });
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(shell.agentTouched).toBe(false);

		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_1', status: 'new', contentChanged: true, settingsChanged: true }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('new');
		expect(shell.agentTouched).toBe(true);
		await new Promise(resolve => setTimeout(resolve, 120));
	});

	it('marks accepted optimized source queries as agent-touched when dirty', async () => {
		let sourceQuery = 'Source query';
		const { shell, setSerializedState } = createSectionWithShell('query_src', { id: 'query_src', type: 'query', query: sourceQuery });
		createSectionWithShell('query_cmp', { id: 'query_cmp', type: 'query', query: 'Optimized query' });
		handlerState.queryEditors.query_src = {
			setValue: vi.fn((nextQuery: string) => {
				sourceQuery = String(nextQuery);
				setSerializedState({ id: 'query_src', type: 'query', query: sourceQuery });
			}),
		};
		handlerState.queryEditors.query_cmp = { getValue: vi.fn(() => 'Optimized query') };
		handlerState.optimizationMetadataByBoxId.query_cmp = { sourceBoxId: 'query_src', optimizedQuery: 'Optimized query' };
		const { acceptOptimizations } = await import('../../src/webview/sections/query-execution.controller.js');

		acceptOptimizations('query_cmp');
		await Promise.resolve();
		expect(shell.agentTouched).toBe(false);

		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_src', status: 'modified', contentChanged: true, settingsChanged: false }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('modified');
		expect(shell.agentTouched).toBe(true);
	});

	it('marks delegated Kusto Copilot run-mode changes as agent-touched when dirty', async () => {
		let state = { id: 'query_1', type: 'query', query: 'print 1', runMode: 'take100' };
		const { section, shell, setSerializedState } = createSectionWithShell('query_1', state);
		(section as any).setCopilotChatVisible = vi.fn();
		mocks.getQuerySectionElement.mockReturnValue(section);
		mocks.getConnectionId.mockReturnValue('conn-1');
		mocks.getDatabase.mockReturnValue('db-1');
		mocks.setRunMode.mockImplementation((sectionId: string, mode: string) => {
			if (sectionId !== 'query_1') return;
			state = { ...state, runMode: mode };
			setSerializedState(state);
		});

		dispatchHostMessage({ type: 'toolDelegateToKustoWorkbenchCopilot', requestId: 'r-kusto-copilot', input: { sectionId: 'query_1', question: 'Help' } });
		await Promise.resolve();
		expect(shell.agentTouched).toBe(false);

		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_1', status: 'modified', contentChanged: false, settingsChanged: true }],
		});
		await Promise.resolve();
		await shell.updateComplete;
		await new Promise(resolve => setTimeout(resolve, 120));

		expect(shell.hasChanges).toBe('modified');
		expect(shell.agentTouched).toBe(true);
	});

	it('marks auto-created delegated Kusto Copilot sections as agent-touched when new', async () => {
		const { shell } = createSectionWithShell('query_1', { id: 'query_1', type: 'query', query: '' });

		dispatchHostMessage({ type: 'toolDelegateToKustoWorkbenchCopilot', requestId: 'r-kusto-new', input: { question: 'Help' } });
		await Promise.resolve();
		expect(shell.agentTouched).toBe(false);

		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_1', status: 'new', contentChanged: true, settingsChanged: true }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('new');
		expect(shell.agentTouched).toBe(true);
	});

	async function runDelegatedKustoCopilotResponseTest(options: { maxResultRows?: unknown; rowCount: number; resultBeforeDone?: boolean }) {
		const { section } = createSectionWithShell('query_1', { id: 'query_1', type: 'query', query: 'range Index from 1 to 10 step 1' });
		(section as any).setCopilotChatVisible = vi.fn();
		mocks.getQuerySectionElement.mockReturnValue(section);
		mocks.getConnectionId.mockReturnValue('conn-1');
		mocks.getDatabase.mockReturnValue('db-1');
		handlerState.queryEditors.query_1 = { getValue: vi.fn(() => 'range Index from 1 to 10 step 1') };

		const rows = Array.from({ length: options.rowCount }, (_unused, index) => [index + 1]);
		const columns = ['Index'];
		getResultsStateMock.mockReturnValue({ columns, rows } as any);

		const chatPane = document.createElement('div');
		chatPane.id = 'query_1_copilot_chat_pane';
		const chatElement = document.createElement('kw-copilot-chat') as HTMLElement & {
			setInputText: ReturnType<typeof vi.fn>;
			setRequireToolUseOnNextSend: ReturnType<typeof vi.fn>;
		};
		chatElement.setInputText = vi.fn();
		chatElement.setRequireToolUseOnNextSend = vi.fn();
		chatPane.appendChild(chatElement);
		document.body.appendChild(chatPane);

		(section as any).copilotWriteQuerySend = vi.fn(() => {
			const queryResultMessage = { type: 'queryResult', boxId: 'query_1', result: { rows, columns } };
			const doneMessage = { type: 'copilotWriteQueryDone', boxId: 'query_1', ok: true };
			if (options.resultBeforeDone) {
				dispatchHostMessage(queryResultMessage);
				dispatchHostMessage(doneMessage);
			} else {
				dispatchHostMessage(doneMessage);
				dispatchHostMessage(queryResultMessage);
			}
		});

		const input: Record<string, unknown> = { sectionId: 'query_1', question: 'Help' };
		if ('maxResultRows' in options) {
			input.maxResultRows = options.maxResultRows;
		}

		mocks.postMessageToHost.mockClear();
		dispatchHostMessage({ type: 'toolDelegateToKustoWorkbenchCopilot', requestId: 'r-kusto-copilot-results', input });
		await new Promise(resolve => setTimeout(resolve, 140));

		const response = mocks.postMessageToHost.mock.calls
			.map(([message]) => message as any)
			.find(message => message.type === 'toolResponse' && message.requestId === 'r-kusto-copilot-results');
		expect(response).toBeTruthy();
		return response.result;
	}

	it('defaults delegated Kusto Copilot tool results to 100 rows', async () => {
		const result = await runDelegatedKustoCopilotResponseTest({ rowCount: 150 });

		expect(result.success).toBe(true);
		expect(result.rowCount).toBe(150);
		expect(result.results).toHaveLength(100);
		expect(result.maxResultRows).toBe(100);
		expect(result.returnedRowCount).toBe(100);
		expect(result.truncated).toBe('Results truncated to 100 rows');
	});

	it('uses a custom delegated Kusto Copilot maxResultRows response cap', async () => {
		const result = await runDelegatedKustoCopilotResponseTest({ rowCount: 150, maxResultRows: 125 });

		expect(result.rowCount).toBe(150);
		expect(result.results).toHaveLength(125);
		expect(result.maxResultRows).toBe(125);
		expect(result.returnedRowCount).toBe(125);
		expect(result.truncated).toBe('Results truncated to 125 rows');
	});

	it('supports smaller delegated Kusto Copilot maxResultRows caps', async () => {
		const result = await runDelegatedKustoCopilotResponseTest({ rowCount: 25, maxResultRows: 5 });

		expect(result.rowCount).toBe(25);
		expect(result.results).toHaveLength(5);
		expect(result.maxResultRows).toBe(5);
		expect(result.returnedRowCount).toBe(5);
		expect(result.truncated).toBe('Results truncated to 5 rows');
	});

	it('normalizes invalid delegated Kusto Copilot maxResultRows values defensively', async () => {
		const invalidResult = await runDelegatedKustoCopilotResponseTest({ rowCount: 150, maxResultRows: '250' });
		expect(invalidResult.results).toHaveLength(100);
		expect(invalidResult.maxResultRows).toBe(100);

		const belowMinimumResult = await runDelegatedKustoCopilotResponseTest({ rowCount: 150, maxResultRows: 0 });
		expect(belowMinimumResult.results).toHaveLength(1);
		expect(belowMinimumResult.maxResultRows).toBe(1);
	});

	it('uses maxResultRows when query results arrive before Copilot completion', async () => {
		const result = await runDelegatedKustoCopilotResponseTest({ rowCount: 130, maxResultRows: 120, resultBeforeDone: true });

		expect(result.rowCount).toBe(130);
		expect(result.results).toHaveLength(120);
		expect(result.maxResultRows).toBe(120);
		expect(result.returnedRowCount).toBe(120);
		expect(result.truncated).toBe('Results truncated to 120 rows');
	});

	it('marks delegated SQL Copilot run-mode changes as agent-touched when dirty', async () => {
		let state = { id: 'sql_1', type: 'sql', query: 'select 1', runMode: 'top100' };
		const { section, shell, setSerializedState } = createSectionWithShell('sql_1', state);
		(section as any).setCopilotChatVisible = vi.fn();
		(section as any).getCopilotChatEl = vi.fn(() => null);
		mocks.getSqlSectionElement.mockReturnValue(section);
		mocks.setRunMode.mockImplementation((sectionId: string, mode: string) => {
			if (sectionId !== 'sql_1') return;
			state = { ...state, runMode: mode };
			setSerializedState(state);
		});

		dispatchHostMessage({ type: 'toolDelegateToSqlCopilot', requestId: 'r-sql-copilot', input: { sectionId: 'sql_1', question: 'Help' } });
		await Promise.resolve();
		expect(shell.agentTouched).toBe(false);

		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'sql_1', status: 'modified', contentChanged: false, settingsChanged: true }],
		});
		await Promise.resolve();
		await shell.updateComplete;
		await new Promise(resolve => setTimeout(resolve, 170));

		expect(shell.hasChanges).toBe('modified');
		expect(shell.agentTouched).toBe(true);
	});

	it('reconciles legacy copilotQuery sections when dirty', async () => {
		const { shell } = createSectionWithShell('copilotQuery_1', { id: 'copilotQuery_1', type: 'copilotQuery', query: 'print 1' });

		window.__kustoMarkSectionAgentTouched?.('copilotQuery_1');
		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'copilotQuery_1', status: 'modified', contentChanged: true, settingsChanged: false }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('modified');
		expect(shell.agentTouched).toBe(true);
	});

	it('clears visible agent markers when document data is re-applied without remounting', async () => {
		const { shell } = createSectionWithShell('query_1');
		shell.agentTouched = true;
		shell.hasChanges = 'modified';
		await shell.updateComplete;

		dispatchHostMessage({ type: 'documentData', ok: true, state: { sections: [] } });
		await Promise.resolve();
		await shell.updateComplete;

		expect(mocks.handleDocumentDataMessage).toHaveBeenCalledTimes(1);
		expect(shell.agentTouched).toBe(false);
		expect(shell.hasAttribute('agent-touched')).toBe(false);
	});

	it('suppresses stale visible agent markers when no provenance state exists', async () => {
		const { shell } = createSectionWithShell('query_1');
		shell.agentTouched = true;
		await shell.updateComplete;

		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_1', status: 'modified', contentChanged: true, settingsChanged: false }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('modified');
		expect(shell.agentTouched).toBe(false);
		expect(shell.hasAttribute('agent-touched')).toBe(false);
	});
});

/**
 * Regression tests: tool name updates must use __kustoSetSectionName.
 *
 * Bug: toolConfigureQuerySection, toolUpdateMarkdownSection, toolConfigureChart,
 * and toolConfigureTransformation tried to set names via a non-existent
 * `document.getElementById(sectionId + '_name')` DOM element, which silently
 * failed. The name parameter was accepted but never persisted.
 */
describe('tool section name persistence', () => {
	let setSectionNameSpy: ReturnType<typeof vi.fn>;

	beforeAll(async () => {
		const sectionFactory = await import('../../src/webview/core/section-factory.js');
		setSectionNameSpy = sectionFactory.__kustoSetSectionName as unknown as ReturnType<typeof vi.fn>;
	});

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getQuerySectionElement.mockReturnValue(null);
		mocks.getConnectionId.mockReturnValue('');
		mocks.getDatabase.mockReturnValue('');
		mocks.getSqlSectionElement.mockReturnValue(null);
		for (const key of Object.keys(handlerState.queryEditors)) delete handlerState.queryEditors[key];
		for (const key of Object.keys(handlerState.optimizationMetadataByBoxId)) delete handlerState.optimizationMetadataByBoxId[key];
	});

	it('toolConfigureQuerySection calls __kustoSetSectionName', async () => {
		dispatchHostMessage({
			type: 'toolConfigureQuerySection',
			requestId: 'r1',
			input: { sectionId: 'query_1', name: 'Install Telemetry' },
		});
		// Allow microtask queue to flush (handler is async)
		await new Promise(r => setTimeout(r, 50));
		expect(setSectionNameSpy).toHaveBeenCalledWith('query_1', 'Install Telemetry');
	});

	it('toolUpdateMarkdownSection calls __kustoSetSectionName', async () => {
		dispatchHostMessage({
			type: 'toolUpdateMarkdownSection',
			requestId: 'r2',
			input: { sectionId: 'markdown_1', name: 'Summary' },
		});
		await new Promise(r => setTimeout(r, 50));
		expect(setSectionNameSpy).toHaveBeenCalledWith('markdown_1', 'Summary');
	});

	it('toolConfigureChart calls __kustoSetSectionName', async () => {
		// B4: configureChart now validates the section is a chart — create a mock element
		const mockChartEl = document.createElement('div');
		Object.defineProperty(mockChartEl, 'tagName', { value: 'KW-CHART-SECTION', configurable: true });
		mockChartEl.id = 'chart_1';
		document.body.appendChild(mockChartEl);
		try {
			dispatchHostMessage({
				type: 'toolConfigureChart',
				requestId: 'r3',
				input: { sectionId: 'chart_1', name: 'Trend Chart' },
			});
			await new Promise(r => setTimeout(r, 50));
			expect(setSectionNameSpy).toHaveBeenCalledWith('chart_1', 'Trend Chart');
		} finally {
			mockChartEl.remove();
		}
	});

	it('toolConfigureTransformation calls __kustoSetSectionName', async () => {
		dispatchHostMessage({
			type: 'toolConfigureTransformation',
			requestId: 'r4',
			input: { sectionId: 'transformation_1', name: 'Pivot Data' },
		});
		await new Promise(r => setTimeout(r, 50));
		expect(setSectionNameSpy).toHaveBeenCalledWith('transformation_1', 'Pivot Data');
	});

	it('toolConfigureSqlSection schedules persistence after a name update', async () => {
		const { section, setSerializedState } = createSectionWithShell('sql_1', { id: 'sql_1', type: 'sql', query: 'select 1', name: 'Original' });
		(section as any).setName = vi.fn((name: string) => {
			setSerializedState({ id: 'sql_1', type: 'sql', query: 'select 1', name });
		});
		mocks.getSqlSectionElement.mockReturnValue(section);
		const persistence = await import('../../src/webview/core/persistence.js');

		dispatchHostMessage({
			type: 'toolConfigureSqlSection',
			requestId: 'r-sql-name',
			input: { sectionId: 'sql_1', name: 'Renamed SQL' },
		});
		await new Promise(r => setTimeout(r, 50));

		expect((section as any).setName).toHaveBeenCalledWith('Renamed SQL');
		expect(persistence.schedulePersist).toHaveBeenCalledWith(undefined, true);
	});

	it('toolConfigureHtmlSection auto-fits when code changes', async () => {
		const htmlEl = createFakeHtmlSection('html_1');

		dispatchHostMessage({
			type: 'toolConfigureHtmlSection',
			requestId: 'r5',
			sectionId: 'html_1',
			code: '<main>Dashboard</main>',
		});
		await new Promise(r => setTimeout(r, 50));

		expect(htmlEl.setCode).toHaveBeenCalledWith('<main>Dashboard</main>');
		expect(htmlEl.fitToContents).toHaveBeenCalled();
	});

	it('toolConfigureHtmlSection preserves manual preview height when code changes', async () => {
		const htmlEl = createFakeHtmlSection('html_manual_preview');
		htmlEl.getMode.mockReturnValue('preview');
		htmlEl.previewHeightUserSet = true;

		dispatchHostMessage({
			type: 'toolConfigureHtmlSection',
			requestId: 'r5-manual',
			sectionId: 'html_manual_preview',
			code: '<main>Dashboard</main>',
		});
		await new Promise(r => setTimeout(r, 50));

		expect(htmlEl.setCode).toHaveBeenCalledWith('<main>Dashboard</main>');
		expect(htmlEl.fitToContents).not.toHaveBeenCalled();
		expect(htmlEl.previewHeightUserSet).toBe(true);
	});

	it('toolConfigureHtmlSection does not auto-fit for name-only updates', async () => {
		const htmlEl = createFakeHtmlSection('html_2');

		dispatchHostMessage({
			type: 'toolConfigureHtmlSection',
			requestId: 'r6',
			sectionId: 'html_2',
			name: 'Executive Dashboard',
		});
		await new Promise(r => setTimeout(r, 50));

		expect(setSectionNameSpy).toHaveBeenCalledWith('html_2', 'Executive Dashboard');
		expect(htmlEl.fitToContents).not.toHaveBeenCalled();
	});

	it('toolConfigureHtmlSection does not auto-fit for unchanged mode or code fields', async () => {
		const htmlEl = createFakeHtmlSection('html_3');
		htmlEl.getCode.mockReturnValue('<main>Dashboard</main>');
		htmlEl.getMode.mockReturnValue('preview');

		dispatchHostMessage({
			type: 'toolConfigureHtmlSection',
			requestId: 'r7',
			sectionId: 'html_3',
			name: 'Executive Dashboard',
			code: '<main>Dashboard</main>',
			mode: 'preview',
		});
		await new Promise(r => setTimeout(r, 50));

		expect(htmlEl.setCode).toHaveBeenCalledWith('<main>Dashboard</main>');
		expect(htmlEl.setMode).toHaveBeenCalledWith('preview');
		expect(htmlEl.fitToContents).not.toHaveBeenCalled();
	});
});
