import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const handlerState = vi.hoisted(() => ({
	sqlConnections: [] as Array<Record<string, unknown>>,
	sqlCachedDatabases: {} as Record<string, string[]>,
	sqlFavorites: [] as Array<Record<string, unknown>>,
	sqlFavoritesModeByBoxId: {} as Record<string, boolean>,
	schemaByBoxId: {} as Record<string, unknown>,
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
	updateCaretDocsToggleButtons: vi.fn(),
	updateAutoTriggerAutocompleteToggleButtons: vi.fn(),
	updateCopilotInlineCompletionsToggleButtons: vi.fn(),
};

vi.mock('../../src/webview/shared/persistence-state.js', () => ({
	pState: {
		isSessionFile: false,
		documentUri: '',
		documentKind: 'kqlx',
		allowedSectionKinds: ['query', 'chart', 'python', 'url', 'markdown'],
		defaultSectionKind: 'query',
		compatibilitySingleKind: 'query',
		upgradeRequestType: 'requestUpgradeToKqlx',
		compatibilityTooltip: '',
		copilotChatFirstTimeDismissed: false,
		devNotesSections: [],
		lastExecutedBox: '',
	}
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
	__kustoGetQuerySectionElement: vi.fn(() => null),
	__kustoSetSectionName: vi.fn(),
	__kustoGetConnectionId: vi.fn(() => ''),
	__kustoGetDatabase: vi.fn(() => ''),
	updateConnectionSelects: mocks.updateConnectionSelects,
	updateDatabaseSelect: mocks.updateDatabaseSelect,
	onDatabasesError: mocks.onDatabasesError,
	parseKustoExplorerConnectionsXml: mocks.parseKustoExplorerConnectionsXml,
	__kustoUpdateFavoritesUiForAllBoxes: vi.fn(),
	__kustoTryAutoEnterFavoritesModeForAllBoxes: vi.fn(),
	__kustoMaybeDefaultFirstBoxToFavoritesMode: vi.fn(),
	__kustoOnConnectionsUpdated: vi.fn(),
	schemaRequestTokenByBoxId: {},
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
	setRunMode: vi.fn(),
}));

vi.mock('../../src/webview/sections/query-execution.controller.js', () => ({
	executeQuery: vi.fn(),
	setQueryExecuting: mocks.setQueryExecuting,
	__kustoSetResultsVisible: mocks.setResultsVisible,
	__kustoSetLinkedOptimizationMode: vi.fn(),
	displayComparisonSummary: vi.fn(),
	optimizeQueryWithCopilot: vi.fn(async () => 'query_compare_1'),
	__kustoSetOptimizeInProgress: vi.fn(),
	__kustoHideOptimizePromptForBox: vi.fn(),
	__kustoApplyOptimizeQueryOptions: vi.fn(),
}));

vi.mock('../../src/webview/core/persistence.js', () => ({
	schedulePersist: vi.fn(),
	handleDocumentDataMessage: mocks.handleDocumentDataMessage,
	getKqlxState: vi.fn(() => ({ sections: [] })),
	__kustoSetCompatibilityMode: vi.fn(),
	__kustoApplyDocumentCapabilities: vi.fn(),
	__kustoRequestAddSection: vi.fn(),
	__kustoOnQueryResult: vi.fn(),
}));

vi.mock('../../src/webview/monaco/monaco.js', () => ({
	__kustoControlCommandDocCache: {},
	__kustoControlCommandDocPending: {},
	__kustoCrossClusterSchemas: {},
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
	queryEditors: {},
	cachedDatabases: {},
	optimizationMetadataByBoxId: {},
	schemaByConnDb: {},
	schemaRequestResolversByBoxId: {},
	schemaByBoxId: handlerState.schemaByBoxId,
	schemaFetchInFlightByBoxId: {},
	databasesRequestResolversByBoxId: {},
}));

type FakeSqlSection = HTMLElement & {
	_stsReady?: boolean;
	setSqlConnectionId: ReturnType<typeof vi.fn>;
	setFavoritesMode: ReturnType<typeof vi.fn>;
	setSchemaInfo: ReturnType<typeof vi.fn>;
	setStsReady: ReturnType<typeof vi.fn>;
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

function dispatchHostMessage(data: Record<string, unknown>): void {
	window.dispatchEvent(new MessageEvent('message', { data }));
}

describe('message-handler dispatch', () => {
	beforeAll(async () => {
		(window as any).vscode = {
			postMessage: vi.fn(),
			getState: vi.fn(() => ({})),
			setState: vi.fn(),
		};
		await import('../../src/webview/core/message-handler.js');
	});

	beforeEach(() => {
		document.body.innerHTML = '';
		handlerState.sqlConnections.splice(0, handlerState.sqlConnections.length);
		handlerState.sqlFavorites.splice(0, handlerState.sqlFavorites.length);
		for (const key of Object.keys(handlerState.sqlCachedDatabases)) delete handlerState.sqlCachedDatabases[key];
		for (const key of Object.keys(handlerState.sqlFavoritesModeByBoxId)) delete handlerState.sqlFavoritesModeByBoxId[key];
		for (const key of Object.keys(handlerState.schemaByBoxId)) delete handlerState.schemaByBoxId[key];
		delete (window as any).__kustoSqlLastConnectionId;
		delete (window as any).__kustoSqlLastDatabase;
		vi.clearAllMocks();
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

	it('routes queryCancelled and ensureResultsVisible', async () => {
		dispatchHostMessage({ type: 'queryCancelled', boxId: 'query_2' });
		dispatchHostMessage({ type: 'ensureResultsVisible', boxId: 'query_2' });
		await Promise.resolve();
		expect(mocks.setQueryExecuting).toHaveBeenCalledWith('query_2', false);
		expect(mocks.displayCancelled).toHaveBeenCalledTimes(1);
		expect(mocks.setResultsVisible).toHaveBeenCalledWith('query_2', true);
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
		dispatchHostMessage({ type: 'stsConnectionState', boxId: 'sql_1', state: 'ready' });
		dispatchHostMessage({ type: 'stsDiagnostics', boxId: 'sql_1', markers: [{ message: 'after ready' }] });
		await Promise.resolve();

		expect(mocks.handleStsResponse).toHaveBeenCalledWith('sts_1', { items: [] });
		expect(sqlEl.setStsReady).toHaveBeenCalledWith(true);
		expect(mocks.handleStsDiagnostics).toHaveBeenCalledTimes(1);
		expect(mocks.handleStsDiagnostics).toHaveBeenCalledWith('sql_1', [{ message: 'after ready' }]);
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
		mocks.getSqlSectionElement.mockReturnValue(null);
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
});
