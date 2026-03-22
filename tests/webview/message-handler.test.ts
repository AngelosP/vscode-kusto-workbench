import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = {
	postMessageToHost: vi.fn(),
	handleDocumentDataMessage: vi.fn(),
	updateConnectionSelects: vi.fn(),
	updateDatabaseSelect: vi.fn(),
	onDatabasesError: vi.fn(),
	parseKustoExplorerConnectionsXml: vi.fn(),
	onPythonResult: vi.fn(),
	onPythonError: vi.fn(),
	displayCancelled: vi.fn(),
	setQueryExecuting: vi.fn(),
	setResultsVisible: vi.fn(),
	setConnections: vi.fn(),
	setLastConnectionId: vi.fn(),
	setLastDatabase: vi.fn(),
	setKustoFavorites: vi.fn(),
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
		allowedSectionKinds: ['query', 'chart', 'markdown', 'python', 'url'],
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
	buildSchemaInfo: vi.fn((text: string, isError: boolean) => ({ text, isError })),
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

vi.mock('../../src/webview/modules/errorUtils.js', () => ({
	__kustoRenderErrorUx: vi.fn(),
	__kustoDisplayBoxError: vi.fn(),
}));

vi.mock('../../src/webview/modules/queryBoxes.js', () => ({
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
}));

vi.mock('../../src/webview/modules/extraBoxes-markdown.js', () => ({
	addMarkdownBox: vi.fn(() => 'markdown_1'),
	__kustoMaximizeMarkdownBox: vi.fn(),
}));

vi.mock('../../src/webview/modules/extraBoxes-chart.js', () => ({
	addChartBox: vi.fn(() => 'chart_1'),
}));

vi.mock('../../src/webview/modules/extraBoxes-transformation.js', () => ({
	addTransformationBox: vi.fn(() => 'transformation_1'),
}));

vi.mock('../../src/webview/modules/extraBoxes.js', () => ({
	addPythonBox: vi.fn(() => 'python_1'),
	addUrlBox: vi.fn(() => 'url_1'),
	onPythonResult: mocks.onPythonResult,
	onPythonError: mocks.onPythonError,
	__kustoGetChartValidationStatus: vi.fn(() => null),
}));

vi.mock('../../src/webview/modules/queryBoxes-toolbar.js', () => ({
	updateCaretDocsToggleButtons: mocks.updateCaretDocsToggleButtons,
	updateAutoTriggerAutocompleteToggleButtons: mocks.updateAutoTriggerAutocompleteToggleButtons,
	updateCopilotInlineCompletionsToggleButtons: mocks.updateCopilotInlineCompletionsToggleButtons,
	setRunMode: vi.fn(),
}));

vi.mock('../../src/webview/modules/queryBoxes-execution.js', () => ({
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

vi.mock('../../src/webview/core/state.js', () => ({
	activeQueryEditorBoxId: '',
	connections: [],
	setConnections: mocks.setConnections,
	setLastConnectionId: mocks.setLastConnectionId,
	setLastDatabase: mocks.setLastDatabase,
	kustoFavorites: [],
	setKustoFavorites: mocks.setKustoFavorites,
	setLeaveNoTraceClusters: mocks.setLeaveNoTraceClusters,
	setCaretDocsEnabled: mocks.setCaretDocsEnabled,
	setAutoTriggerAutocompleteEnabled: mocks.setAutoTriggerAutocompleteEnabled,
	setCopilotInlineCompletionsEnabled: mocks.setCopilotInlineCompletionsEnabled,
	queryEditors: {},
	cachedDatabases: {},
	optimizationMetadataByBoxId: {},
	schemaByConnDb: {},
	schemaRequestResolversByBoxId: {},
	schemaByBoxId: {},
	schemaFetchInFlightByBoxId: {},
	databasesRequestResolversByBoxId: {},
}));

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
		vi.clearAllMocks();
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
});
