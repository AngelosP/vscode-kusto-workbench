import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KwSectionShell } from '../../src/webview/components/kw-section-shell.js';

const handlerState = vi.hoisted(() => ({
	activeQueryEditorBoxId: '',
	connections: [] as Array<Record<string, unknown>>,
	kustoFavorites: [] as Array<Record<string, unknown>>,
	sqlConnections: [] as Array<Record<string, unknown>>,
	sqlCachedDatabases: {} as Record<string, string[]>,
	sqlFavorites: [] as Array<Record<string, unknown>>,
	sqlFavoritesModeByBoxId: {} as Record<string, boolean>,
	schemaByBoxId: {} as Record<string, unknown>,
	schemaMetaByBoxId: {} as Record<string, unknown>,
	schemaDiagnosticsTrustedByBoxId: {} as Record<string, boolean>,
	schemaByConnDb: {} as Record<string, unknown>,
	schemaMetaByConnDb: {} as Record<string, unknown>,
	schemaWorkerReadyByBoxId: {} as Record<string, any>,
	pendingSchemaWorkerUpdateByBoxId: {} as Record<string, unknown>,
	schemaRequestTokenByBoxId: {} as Record<string, string>,
	queryEditors: {} as Record<string, any>,
	queryBoxes: [] as string[],
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
		documentEditRevision: 0,
		resultsVisibleByBoxId: {},
	} as Record<string, unknown>,
}));

const mocks = {
	postMessageToHost: vi.fn(),
	markCrossClusterSchemaError: vi.fn(),
	handleCrossClusterSchemaData: vi.fn(() => true),
	handleCrossClusterSchemaError: vi.fn(() => true),
	retryPrimarySchemaEnhancement: vi.fn(() => true),
	releaseStaleCrossClusterResponse: vi.fn(),
	handleDocumentDataMessage: vi.fn(),
	flushCompatibilityPersist: vi.fn(),
	acknowledgePersistDocument: vi.fn(),
	updateConnectionSelects: vi.fn(),
	updateDatabaseSelect: vi.fn(),
	onDatabasesError: vi.fn(),
	updateKustoFavoritesUiForAllBoxes: vi.fn(),
	tryAutoEnterKustoFavoritesModeForAllBoxes: vi.fn(),
	maybeDefaultFirstKustoBoxToFavoritesMode: vi.fn(),
	updateSqlConnectionSelects: vi.fn(),
	updateSqlDatabaseSelect: vi.fn(),
	onSqlDatabasesError: vi.fn(),
	getQuerySectionElement: vi.fn(),
	getConnectionId: vi.fn(() => ''),
	getClusterUrl: vi.fn(() => ''),
	getDatabase: vi.fn(() => ''),
	updateSqlFavoritesUiForAllBoxes: vi.fn(),
	getSqlSectionElement: vi.fn(),
	parseKustoExplorerConnectionsXml: vi.fn(),
	onPythonResult: vi.fn(),
	onPythonError: vi.fn(),
	handleStsResponse: vi.fn(),
	handleStsDiagnostics: vi.fn(),
	displayCancelled: vi.fn(),
	clearResultsState: vi.fn(),
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
	executeQuery: vi.fn(),
	updateCaretDocsToggleButtons: vi.fn(),
	updateAutoTriggerAutocompleteToggleButtons: vi.fn(),
	updateCopilotInlineCompletionsToggleButtons: vi.fn(),
	applyEditingPreferencesData: vi.fn(),
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
	clearResultsState: mocks.clearResultsState,
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
	__kustoGetClusterUrl: mocks.getClusterUrl,
	__kustoGetDatabase: mocks.getDatabase,
	__kustoLog: vi.fn(),
	updateConnectionSelects: mocks.updateConnectionSelects,
	updateDatabaseSelect: mocks.updateDatabaseSelect,
	onDatabasesError: mocks.onDatabasesError,
	parseKustoExplorerConnectionsXml: mocks.parseKustoExplorerConnectionsXml,
	__kustoUpdateFavoritesUiForAllBoxes: mocks.updateKustoFavoritesUiForAllBoxes,
	__kustoTryAutoEnterFavoritesModeForAllBoxes: mocks.tryAutoEnterKustoFavoritesModeForAllBoxes,
	__kustoMaybeDefaultFirstBoxToFavoritesMode: mocks.maybeDefaultFirstKustoBoxToFavoritesMode,
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

vi.mock('../../src/webview/core/editing-preferences.js', () => ({
	applyEditingPreferencesData: mocks.applyEditingPreferencesData,
}));

vi.mock('../../src/webview/sections/query-execution.controller.js', async () => {
	const actual = await vi.importActual<typeof import('../../src/webview/sections/query-execution.controller.js')>('../../src/webview/sections/query-execution.controller.js');
	return {
		...actual,
		executeQuery: mocks.executeQuery,
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
	flushCompatibilityPersist: mocks.flushCompatibilityPersist,
	acknowledgePersistDocument: mocks.acknowledgePersistDocument,
	__kustoSetCompatibilityMode: vi.fn(),
	__kustoApplyDocumentCapabilities: vi.fn(),
	__kustoRequestAddSection: vi.fn(),
	__kustoOnQueryResult: vi.fn(),
	__kustoScheduleLocalSchemaPrewarm: vi.fn(),
	resolvePendingSqlResultRestores: vi.fn(),
	discardPendingSqlResultRestores: vi.fn(),
}));

vi.mock('../../src/webview/monaco/monaco.js', () => ({
	__kustoControlCommandDocCache: {},
	__kustoControlCommandDocPending: {},
	__kustoCrossClusterSchemas: {},
	__kustoHandleCrossClusterSchemaData: mocks.handleCrossClusterSchemaData,
	__kustoHandleCrossClusterSchemaError: mocks.handleCrossClusterSchemaError,
	__kustoIsCurrentCrossClusterRequest: vi.fn(() => true),
	__kustoMarkCrossClusterSchemaError: mocks.markCrossClusterSchemaError,
	__kustoReleaseStaleCrossClusterResponse: mocks.releaseStaleCrossClusterResponse,
	__kustoRetryPrimarySchemaEnhancement: mocks.retryPrimarySchemaEnhancement,
	__kustoTraceCrossCluster: vi.fn(),
}));

vi.mock('../../src/webview/monaco/suggest.js', () => ({
	__kustoFindSuggestWidgetForEditor: vi.fn(() => null),
	__kustoIsElementVisibleForSuggest: vi.fn(() => false),
}));

vi.mock('../../src/webview/monaco/sql-sts-providers.js', () => ({
	handleStsResponse: mocks.handleStsResponse,
	handleStsDiagnostics: mocks.handleStsDiagnostics,
}));

vi.mock('../../src/webview/core/state.js', async () => {
	const actual = await vi.importActual<typeof import('../../src/webview/core/state.js')>('../../src/webview/core/state.js');
	return {
	...actual,
	get activeQueryEditorBoxId() { return handlerState.activeQueryEditorBoxId; },
	connections: handlerState.connections,
	setConnections: mocks.setConnections,
	sqlConnections: handlerState.sqlConnections,
	setSqlConnections: vi.fn((connections: Array<Record<string, unknown>>) => {
		mocks.setSqlConnections(connections);
		handlerState.sqlConnections.splice(0, handlerState.sqlConnections.length, ...connections);
	}),
	setLastConnectionId: mocks.setLastConnectionId,
	setLastDatabase: mocks.setLastDatabase,
	kustoFavorites: handlerState.kustoFavorites,
	setKustoFavorites: vi.fn((favorites: Array<Record<string, unknown>>) => {
		mocks.setKustoFavorites(favorites);
		handlerState.kustoFavorites.splice(0, handlerState.kustoFavorites.length, ...favorites);
	}),
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
	queryBoxes: handlerState.queryBoxes,
	queryExecutionTimers: {},
	pendingFavoriteSelectionByBoxId: {},
	cachedDatabases: {},
	optimizationMetadataByBoxId: handlerState.optimizationMetadataByBoxId,
	schemaByConnDb: handlerState.schemaByConnDb,
	schemaMetaByConnDb: handlerState.schemaMetaByConnDb,
	schemaRequestResolversByBoxId: {},
	schemaByBoxId: handlerState.schemaByBoxId,
	schemaMetaByBoxId: handlerState.schemaMetaByBoxId,
	schemaDiagnosticsTrustedByBoxId: handlerState.schemaDiagnosticsTrustedByBoxId,
	schemaFetchInFlightByBoxId: {},
	markSchemaWorkerApplyFailed: vi.fn(actual.markSchemaWorkerApplyFailed),
	markSchemaWorkerApplyPending: vi.fn(),
	markSchemaWorkerReady: vi.fn(),
	schemaWorkerReadyByBoxId: handlerState.schemaWorkerReadyByBoxId,
	schemaWorkerReadyWaitersByBoxId: {},
	pendingSchemaWorkerUpdateByBoxId: handlerState.pendingSchemaWorkerUpdateByBoxId,
	databasesRequestResolversByBoxId: {},
};
});

type FakeSqlSection = HTMLElement & {
	sqlSession: {
		instanceId: string;
		targetGeneration: number;
		stsReady: boolean;
		databaseRequestId: string;
		adoptHostGeneration: ReturnType<typeof vi.fn>;
		beginDatabaseRequest: ReturnType<typeof vi.fn>;
		acceptDatabaseResponse: ReturnType<typeof vi.fn>;
		completeDatabaseRequest: ReturnType<typeof vi.fn>;
		admitOwnedMessage: ReturnType<typeof vi.fn>;
	};
	setSqlConnectionId: ReturnType<typeof vi.fn>;
	setFavoritesMode: ReturnType<typeof vi.fn>;
	setSchemaInfo: ReturnType<typeof vi.fn>;
	setStsReady: ReturnType<typeof vi.fn>;
	setDatabasesLoading: ReturnType<typeof vi.fn>;
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
	const sqlSession = {
		instanceId: 'instance-sql_1',
		targetGeneration: 0,
		stsReady: false,
		databaseRequestId: '',
		adoptHostGeneration: vi.fn((generation: number) => {
			if (!Number.isSafeInteger(generation) || generation < sqlSession.targetGeneration) return false;
			sqlSession.targetGeneration = generation;
			sqlSession.databaseRequestId = '';
			return true;
		}),
		beginDatabaseRequest: vi.fn((requestId: string, generation: number) => {
			if (generation !== sqlSession.targetGeneration) return false;
			sqlSession.databaseRequestId = requestId;
			return true;
		}),
		acceptDatabaseResponse: vi.fn((requestId: string | undefined, generation: number) =>
			generation === sqlSession.targetGeneration
			&& (!requestId || requestId === sqlSession.databaseRequestId)),
		completeDatabaseRequest: vi.fn(() => { sqlSession.databaseRequestId = ''; }),
		admitOwnedMessage: vi.fn((message: Record<string, unknown>) => {
			const ownerToken = String((el as any).getCopilotOwnerToken?.() || '');
			if (!ownerToken || ownerToken !== String(message.ownerToken || '')) return false;
			if (['queryResult', 'queryError', 'queryCancelled'].includes(String(message.type || ''))
				&& typeof (el as any).acceptsQueryTerminal === 'function') {
				return (el as any).acceptsQueryTerminal(String(message.executionId || ''));
			}
			return true;
		}),
	};
	el.sqlSession = sqlSession;
	el.setSqlConnectionId = vi.fn();
	el.setFavoritesMode = vi.fn();
	el.setSchemaInfo = vi.fn();
	el.setDatabasesLoading = vi.fn();
	el.setStsReady = vi.fn((ready: boolean, _ownerToken?: string, targetGeneration?: number) => {
		if (targetGeneration !== undefined && targetGeneration !== sqlSession.targetGeneration) return;
		sqlSession.stsReady = ready;
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
	if (data.type === 'schemaData') {
		const connectionId = String(data.connectionId || 'c1');
		const clusterUrl = String(data.clusterUrl || 'https://cluster.kusto.windows.net');
		const accountPartition = String(data.accountPartition || 'partition-1');
		const existing = handlerState.connections.find(connection => String(connection.id || '') === connectionId);
		if (existing) {
			if (!existing.clusterUrl) existing.clusterUrl = clusterUrl;
			if (!existing.accountPartition) existing.accountPartition = accountPartition;
		} else {
			handlerState.connections.push({ id: connectionId, clusterUrl, accountPartition });
		}
		data = { ...data, connectionId, clusterUrl, accountPartition };
	}
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

	beforeEach(async () => {
		const state = await import('../../src/webview/core/state.js');
		for (const key of Object.keys(state.schemaEnhancementReadyByBoxId)) delete state.schemaEnhancementReadyByBoxId[key];
		for (const key of Object.keys(state.kustoPreparationByBoxId)) delete state.kustoPreparationByBoxId[key];
		document.body.innerHTML = '';
		handlerState.activeQueryEditorBoxId = '';
		handlerState.connections.splice(0, handlerState.connections.length);
		handlerState.kustoFavorites.splice(0, handlerState.kustoFavorites.length);
		handlerState.sqlConnections.splice(0, handlerState.sqlConnections.length);
		handlerState.sqlFavorites.splice(0, handlerState.sqlFavorites.length);
		for (const key of Object.keys(handlerState.sqlCachedDatabases)) delete handlerState.sqlCachedDatabases[key];
		for (const key of Object.keys(handlerState.sqlFavoritesModeByBoxId)) delete handlerState.sqlFavoritesModeByBoxId[key];
		for (const key of Object.keys(handlerState.schemaByBoxId)) delete handlerState.schemaByBoxId[key];
		for (const key of Object.keys(handlerState.schemaMetaByBoxId)) delete handlerState.schemaMetaByBoxId[key];
		for (const key of Object.keys(handlerState.schemaDiagnosticsTrustedByBoxId)) delete handlerState.schemaDiagnosticsTrustedByBoxId[key];
		for (const key of Object.keys(handlerState.schemaByConnDb)) delete handlerState.schemaByConnDb[key];
		for (const key of Object.keys(handlerState.schemaMetaByConnDb)) delete handlerState.schemaMetaByConnDb[key];
		for (const key of Object.keys(handlerState.schemaWorkerReadyByBoxId)) delete handlerState.schemaWorkerReadyByBoxId[key];
		for (const key of Object.keys(handlerState.pendingSchemaWorkerUpdateByBoxId)) delete handlerState.pendingSchemaWorkerUpdateByBoxId[key];
		for (const key of Object.keys(handlerState.schemaRequestTokenByBoxId)) delete handlerState.schemaRequestTokenByBoxId[key];
		for (const key of Object.keys(handlerState.queryEditors)) delete handlerState.queryEditors[key];
		handlerState.queryBoxes.splice(0, handlerState.queryBoxes.length);
		for (const key of Object.keys(handlerState.optimizationMetadataByBoxId)) delete handlerState.optimizationMetadataByBoxId[key];
		delete (window as any).__kustoSqlLastConnectionId;
		delete (window as any).__kustoSqlLastDatabase;
		delete (window as any).__kustoSetMonacoKustoSchema;
		vi.clearAllMocks();
		getResultsStateMock.mockReturnValue(null);
		mocks.getQuerySectionElement.mockReturnValue(null);
		mocks.getConnectionId.mockReturnValue('');
		mocks.getClusterUrl.mockReturnValue('');
		mocks.getDatabase.mockReturnValue('');
		mocks.getSqlSectionElement.mockReturnValue(null);
		delete (window as any).__kustoEnterFavoritesModeForBox;
		handlerState.pState.documentEditRevision = 0;
	});

	it('answers final-persist requests and records persistence acknowledgements', async () => {
		dispatchHostMessage({ type: 'requestFinalPersist', requestId: 'flush-1', reason: 'save' });
		dispatchHostMessage({ type: 'persistDocumentAck', snapshotId: 'snapshot-1', editRevision: 7 });
		await vi.waitFor(() => {
			expect(mocks.flushCompatibilityPersist).toHaveBeenCalledWith('flush-1', 'save');
			expect(mocks.acknowledgePersistDocument).toHaveBeenCalledWith('snapshot-1', 7);
		});
	});

	it('routes documentData to persistence handler', async () => {
		const message = { type: 'documentData', ok: true, state: { sections: [] } };
		dispatchHostMessage(message);
		await Promise.resolve();
		expect(mocks.handleDocumentDataMessage).toHaveBeenCalledWith(message);
	});

	it('rejects a stale revision-conditional document reload before replacing local state', async () => {
		handlerState.pState.documentEditRevision = 7;
		const message = {
			type: 'documentData', ok: true, forceReload: true, expectedEditRevision: 6,
			editRevision: 6, reloadRequestId: 'reload-1', state: { sections: [{ type: 'markdown', text: 'external' }] },
		};

		dispatchHostMessage(message);
		await Promise.resolve();

		expect(mocks.handleDocumentDataMessage).not.toHaveBeenCalled();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'documentReloadResult', requestId: 'reload-1', applied: false, editRevision: 7,
		});
	});

	it('acknowledges and applies a current revision-conditional document reload', async () => {
		handlerState.pState.documentEditRevision = 7;
		const message = {
			type: 'documentData', ok: true, forceReload: true, expectedEditRevision: 7,
			editRevision: 7, reloadRequestId: 'reload-2', state: { sections: [{ type: 'markdown', text: 'external' }] },
		};

		dispatchHostMessage(message);
		await Promise.resolve();

		expect(mocks.handleDocumentDataMessage).toHaveBeenCalledWith(message);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'documentReloadResult', requestId: 'reload-2', applied: true, editRevision: 7,
		});
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
		expect(mocks.applyEditingPreferencesData).toHaveBeenCalledWith(expect.objectContaining({
			type: 'editingPreferencesData',
			caretDocsEnabled: true,
		}));
	});

	it('ignores an older connection snapshot after a newer principal revision', async () => {
		dispatchHostMessage({
			type: 'connectionsData',
			connectionsRevision: 200,
			connections: [{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net', accountPartition: 'partition-b' }],
			cachedDatabases: { c1: ['DbB'] },
			favorites: [],
			leaveNoTraceClusters: [],
		});
		dispatchHostMessage({
			type: 'connectionsData',
			connectionsRevision: 199,
			connections: [{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net', accountPartition: 'partition-a' }],
			cachedDatabases: { c1: ['DbA'] },
			favorites: [],
			leaveNoTraceClusters: [],
		});

		expect(mocks.setConnections).toHaveBeenCalledTimes(1);
		expect(mocks.setConnections).toHaveBeenCalledWith([
			expect.objectContaining({ accountPartition: 'partition-b' }),
		]);
	});

	it('routes revisioned editing preferences without touching document persistence', () => {
		const message = {
			type: 'editingPreferencesData',
			revision: 3,
			caretDocsEnabled: false,
			caretDocsEnabledUserSet: true,
			autoTriggerAutocompleteEnabled: true,
			autoTriggerAutocompleteEnabledUserSet: true,
			copilotInlineCompletionsEnabled: false,
			copilotInlineCompletionsEnabledUserSet: true,
		};

		dispatchHostMessage(message);

		expect(mocks.applyEditingPreferencesData).toHaveBeenCalledWith(message);
		expect(mocks.postMessageToHost).not.toHaveBeenCalled();
	});

	it('routes databasesData and databasesError to database handlers', async () => {
		dispatchHostMessage({ type: 'databasesData', boxId: 'query_1', databases: ['db2', 'db1'], connectionId: 'c1' });
		dispatchHostMessage({ type: 'databasesError', boxId: 'query_1', error: 'boom', connectionId: 'c1' });
		await Promise.resolve();
		expect(mocks.updateDatabaseSelect).toHaveBeenCalledWith('query_1', ['db2', 'db1'], 'c1', undefined, undefined, undefined);
		expect(mocks.onDatabasesError).toHaveBeenCalledWith('query_1', 'boom', 'c1', undefined);
	});

	it('drops database responses from an old account partition', async () => {
		handlerState.connections.splice(0, handlerState.connections.length, {
			id: 'c1',
			clusterUrl: 'https://cluster.kusto.windows.net',
			accountPartition: 'partition-b',
		});

		dispatchHostMessage({
			type: 'databasesData',
			boxId: 'query_1',
			connectionId: 'c1',
			accountPartition: 'partition-a',
			databases: ['AccountADb'],
		});
		await Promise.resolve();

		expect(mocks.updateDatabaseSelect).not.toHaveBeenCalled();
	});

	it('keeps an in-flight database token until host cancellation settles after session invalidation', async () => {
		const state = await import('../../src/webview/core/state.js');
		state.databaseRequestTokenByBoxId.query_1 = 'database-refresh-current';

		dispatchHostMessage({ type: 'kustoAuthIdentityChanged', connectionIds: [], reason: 'sessions-changed' });
		dispatchHostMessage({
			type: 'databasesError', boxId: 'query_1', connectionId: 'c1', requestToken: 'database-refresh-current', error: 'Database refresh cancelled.',
		});

		expect(state.databaseRequestTokenByBoxId.query_1).toBe('database-refresh-current');
		expect(mocks.onDatabasesError).toHaveBeenCalledWith('query_1', 'Database refresh cancelled.', 'c1', 'database-refresh-current');
	});

	it('clears rendered and persisted results immediately when Kusto identity is invalidated', async () => {
		const state = await import('../../src/webview/core/state.js');
		handlerState.queryEditors.query_1 = {};
		mocks.getConnectionId.mockReturnValue('c1');
		const clearResults = vi.fn();
		mocks.getQuerySectionElement.mockReturnValue({ clearResults });
		handlerState.pState.queryResultJsonByBoxId = { query_1: '{"rows":[["secret-a"]]}' };

		dispatchHostMessage({ type: 'kustoAuthIdentityChanged', connectionIds: ['c1'], reason: 'selection' });

		expect(mocks.clearResultsState).toHaveBeenCalledWith('query_1');
		expect((handlerState.pState.queryResultJsonByBoxId as Record<string, string>).query_1).toBeUndefined();
		expect(clearResults).toHaveBeenCalledOnce();
		expect(state.isSchemaWorkerApplyRequired('query_1')).toBe(true);
	});

	it('clears SQL Copilot chat and result snapshots when LNT policy changes', () => {
		const copilotWriteQueryCancel = vi.fn();
		const copilotClearConversation = vi.fn();
		const clearResults = vi.fn();
		mocks.getSqlSectionElement.mockReturnValue({ copilotWriteQueryCancel, copilotClearConversation, clearResults });
		handlerState.pState.queryResultJsonByBoxId = { sql_1: '{"rows":[["secret"]]}' };

		dispatchHostMessage({ type: 'sqlCopilotPolicyChanged', boxIds: ['sql_1'] });

		expect(copilotWriteQueryCancel).toHaveBeenCalledOnce();
		expect(copilotClearConversation).toHaveBeenCalledOnce();
		expect(mocks.clearResultsState).toHaveBeenCalledWith('sql_1');
		expect((handlerState.pState.queryResultJsonByBoxId as Record<string, string>).sql_1).toBeUndefined();
		expect(clearResults).toHaveBeenCalledOnce();
	});

	it('clears a SQL-derived comparison and rejects its late result', () => {
		const comparison = document.createElement('div') as HTMLElement & { clearResults: ReturnType<typeof vi.fn> };
		comparison.id = 'query_cmp_1';
		comparison.clearResults = vi.fn();
		document.body.appendChild(comparison);
		mocks.getQuerySectionElement.mockImplementation((boxId: string) => boxId === 'query_cmp_1' ? comparison : null);
		handlerState.pState.queryResultJsonByBoxId = { query_cmp_1: '{"rows":[["secret"]]}' };

		dispatchHostMessage({ type: 'sqlCopilotPolicyChanged', boxIds: ['sql_1', 'query_cmp_1'] });

		expect(mocks.clearResultsState).toHaveBeenCalledWith('query_cmp_1');
		expect((handlerState.pState.queryResultJsonByBoxId as Record<string, string>).query_cmp_1).toBeUndefined();
		expect(comparison.clearResults).toHaveBeenCalledOnce();

		const resultsState = vi.mocked(getResultsStateMock);
		dispatchHostMessage({
			type: 'queryResult',
			boxId: 'query_cmp_1',
			result: { columns: ['Secret'], rows: [['late-secret']], metadata: {} },
		});

		expect(resultsState).not.toHaveBeenCalled();
		expect(mocks.clearResultsState).toHaveBeenCalledWith('query_cmp_1');
		expect((handlerState.pState.queryResultJsonByBoxId as Record<string, string>).query_cmp_1).toBeUndefined();
	});

	it('allows a Kusto result when its ID reuses a removed SQL comparison tombstone', async () => {
		mocks.getSqlSectionElement.mockReturnValue(null);
		dispatchHostMessage({ type: 'sqlCopilotPolicyChanged', boxIds: ['query_reused'] });
		delete handlerState.optimizationMetadataByBoxId.query_reused;
		const queryElement = document.createElement('kw-query-section');
		queryElement.id = 'query_reused';
		document.body.appendChild(queryElement);
		const resultsState = await import('../../src/webview/core/results-state.js');
		vi.mocked(resultsState.displayResultForBox).mockClear();

		dispatchHostMessage({
			type: 'queryResult', boxId: 'query_reused',
			result: { columns: ['Value'], rows: [[42]], metadata: {} },
		});

		expect(resultsState.displayResultForBox).toHaveBeenCalledWith(
			expect.anything(), 'query_reused', { label: 'Results', showExecutionTime: true },
		);
		queryElement.remove();
	});

	it('routes cross-cluster schema responses with their originating box id', async () => {
		dispatchHostMessage({
			type: 'crossClusterSchemaData',
			boxId: 'query_7',
			clusterName: 'remote',
			clusterUrl: 'https://remote.kusto.windows.net',
			database: 'Telemetry',
			requestToken: 'token-7',
			requestSource: 'background',
			deliverySource: 'disk-cache-fresh',
			rawSchemaJson: '{"Databases":{}}',
		});
		await Promise.resolve();

		expect(mocks.handleCrossClusterSchemaData).toHaveBeenCalledWith(expect.objectContaining({
			clusterName: 'remote',
			clusterUrl: 'https://remote.kusto.windows.net',
			database: 'Telemetry',
			boxId: 'query_7',
			requestToken: 'token-7',
			requestSource: 'background',
			deliverySource: 'disk-cache-fresh',
			rawSchemaJson: '{"Databases":{}}',
		}));
	});

	it('drops stale cross-cluster schema responses before applying schema', async () => {
		const monacoModule = await import('../../src/webview/monaco/monaco.js');
		(monacoModule.__kustoIsCurrentCrossClusterRequest as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
		const applyCrossClusterSchema = vi.fn();
		(window as any).__kustoApplyCrossClusterSchema = applyCrossClusterSchema;

		dispatchHostMessage({
			type: 'crossClusterSchemaData',
			boxId: 'query_7',
			clusterName: 'remote',
			clusterUrl: 'https://remote.kusto.windows.net',
			database: 'Telemetry',
			requestToken: 'old-token',
			rawSchemaJson: '{"Databases":{}}',
		});
		await Promise.resolve();

		expect(applyCrossClusterSchema).not.toHaveBeenCalled();
		expect(mocks.releaseStaleCrossClusterResponse).toHaveBeenCalledWith('remote', 'Telemetry', 'Stale schema response ignored; request is retryable');
	});

	it('routes cross-cluster schema errors through the coordinator status helper', async () => {
		dispatchHostMessage({
			type: 'crossClusterSchemaError',
			boxId: 'query_7',
			clusterName: 'remote',
			database: 'Telemetry',
			requestToken: 'token-7',
			requestSource: 'background',
			failureKind: 'auth-required',
			error: 'boom',
		});
		await Promise.resolve();

		expect(mocks.handleCrossClusterSchemaError).toHaveBeenCalledWith(expect.objectContaining({
			clusterName: 'remote',
			database: 'Telemetry',
			boxId: 'query_7',
			requestToken: 'token-7',
			requestSource: 'background',
			failureKind: 'auth-required',
		}));
	});

	it('drops stale cross-cluster schema errors before marking schema state', async () => {
		const monacoModule = await import('../../src/webview/monaco/monaco.js');
		(monacoModule.__kustoIsCurrentCrossClusterRequest as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

		dispatchHostMessage({
			type: 'crossClusterSchemaError',
			boxId: 'query_7',
			clusterName: 'remote',
			database: 'Telemetry',
			requestToken: 'old-token',
			error: 'boom',
		});
		await Promise.resolve();

		expect(mocks.markCrossClusterSchemaError).not.toHaveBeenCalled();
		expect(mocks.releaseStaleCrossClusterResponse).toHaveBeenCalledWith('remote', 'Telemetry', 'Stale schema error ignored; request is retryable');
	});

	it('routes queryCancelled and ensureResultsVisible', async () => {
		dispatchHostMessage({ type: 'queryCancelled', boxId: 'query_2' });
		dispatchHostMessage({ type: 'ensureResultsVisible', boxId: 'query_2' });
		await Promise.resolve();
		expect(mocks.setQueryExecuting).toHaveBeenCalledWith('query_2', false);
		expect(mocks.displayCancelled).toHaveBeenCalledTimes(1);
		expect(mocks.setResultsVisible).toHaveBeenCalledWith('query_2', true);
	});

	it('drops a mismatched SQL execution cancellation before mutating the newer run UI', async () => {
		const sqlEl = createFakeSqlSection() as FakeSqlSection & {
			getCopilotOwnerToken: ReturnType<typeof vi.fn>;
			acceptsQueryTerminal: ReturnType<typeof vi.fn>;
			notifyToolRunCancelled: ReturnType<typeof vi.fn>;
		};
		sqlEl.getCopilotOwnerToken = vi.fn(() => 'owner-current');
		sqlEl.acceptsQueryTerminal = vi.fn(() => false);
		sqlEl.notifyToolRunCancelled = vi.fn();
		mocks.getSqlSectionElement.mockReturnValue(sqlEl);

		dispatchHostMessage({
			type: 'queryCancelled', boxId: 'sql_1', ownerToken: 'owner-current', executionId: 'execution-a',
		});
		await Promise.resolve();

		expect(sqlEl.acceptsQueryTerminal).toHaveBeenCalledWith('execution-a');
		expect(sqlEl.notifyToolRunCancelled).not.toHaveBeenCalled();
		expect(mocks.setQueryExecuting).not.toHaveBeenCalledWith('sql_1', false);
		expect(mocks.displayCancelled).not.toHaveBeenCalled();
	});

	it('drops stale Copilot executing=false before hiding a newer SQL run', async () => {
		const sqlEl = createFakeSqlSection() as FakeSqlSection & {
			getCopilotOwnerToken: ReturnType<typeof vi.fn>;
			setExternalQueryExecuting: ReturnType<typeof vi.fn>;
		};
		sqlEl.getCopilotOwnerToken = vi.fn(() => 'owner-current');
		sqlEl.setExternalQueryExecuting = vi.fn(() => false);
		mocks.getSqlSectionElement.mockReturnValue(sqlEl);

		dispatchHostMessage({
			type: 'copilotWriteQueryExecuting', boxId: 'sql_1', ownerToken: 'owner-current',
			executing: false, executionId: 'older-copilot-execution',
		});
		await Promise.resolve();

		expect(sqlEl.setExternalQueryExecuting).toHaveBeenCalledWith(false, 'older-copilot-execution');
		expect(mocks.setQueryExecuting).not.toHaveBeenCalledWith('sql_1', false);
	});

	it('admits an exploratory SQL card only for the current owner token', async () => {
		const sqlEl = createFakeSqlSection() as FakeSqlSection & {
			getCopilotOwnerToken: ReturnType<typeof vi.fn>;
			copilotAppendExecutedQuery: ReturnType<typeof vi.fn>;
		};
		sqlEl.getCopilotOwnerToken = vi.fn(() => 'owner-current');
		sqlEl.copilotAppendExecutedQuery = vi.fn();
		mocks.getSqlSectionElement.mockReturnValue(sqlEl);

		dispatchHostMessage({
			type: 'copilotExecutedQuery', boxId: 'sql_1', ownerToken: 'owner-current',
			query: 'SELECT 1', resultSummary: '1 row', entryId: 'entry-current',
			result: { columns: [{ name: 'Value' }], rows: [[1]], metadata: {} },
		});
		dispatchHostMessage({
			type: 'copilotExecutedQuery', boxId: 'sql_1',
			query: 'SELECT Secret FROM T', resultSummary: '1 row', entryId: 'entry-missing-owner',
			result: { columns: [{ name: 'Secret' }], rows: [['hidden']], metadata: {} },
		});
		await Promise.resolve();

		expect(sqlEl.copilotAppendExecutedQuery).toHaveBeenCalledOnce();
		expect(sqlEl.copilotAppendExecutedQuery).toHaveBeenCalledWith(
			'SELECT 1', '1 row', '', 'entry-current',
			expect.objectContaining({ rows: [[1]] }),
		);
	});

	it('clears an exact paused run cancellation before accepting the newer Copilot execution', async () => {
		let activeExecutionId = 'manual-old';
		const sqlEl = createFakeSqlSection() as FakeSqlSection & {
			getCopilotOwnerToken: ReturnType<typeof vi.fn>;
			acceptsQueryTerminal: ReturnType<typeof vi.fn>;
			notifyToolRunCancelled: ReturnType<typeof vi.fn>;
			setExternalQueryExecuting: ReturnType<typeof vi.fn>;
		};
		sqlEl.getCopilotOwnerToken = vi.fn(() => 'owner-current');
		sqlEl.acceptsQueryTerminal = vi.fn((executionId?: string) => executionId === activeExecutionId);
		sqlEl.notifyToolRunCancelled = vi.fn((executionId?: string) => {
			if (executionId === activeExecutionId) activeExecutionId = '';
		});
		sqlEl.setExternalQueryExecuting = vi.fn((executing: boolean, executionId?: string) => {
			if (executing && !activeExecutionId && executionId) {
				activeExecutionId = executionId;
				return true;
			}
			return false;
		});
		mocks.getSqlSectionElement.mockReturnValue(sqlEl);

		dispatchHostMessage({
			type: 'queryCancelled', boxId: 'sql_1', ownerToken: 'owner-current', executionId: 'manual-old',
		});
		dispatchHostMessage({
			type: 'copilotWriteQueryExecuting', boxId: 'sql_1', ownerToken: 'owner-current',
			executing: true, executionId: 'copilot-new',
		});
		await Promise.resolve();

		expect(sqlEl.notifyToolRunCancelled).toHaveBeenCalledWith('manual-old');
		expect(sqlEl.setExternalQueryExecuting).toHaveBeenCalledWith(true, 'copilot-new');
		expect(activeExecutionId).toBe('copilot-new');
		expect(mocks.setQueryExecuting).toHaveBeenCalledWith('sql_1', true);
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

	it('rejects a queued Kusto terminal after a newer execution claims the section', async () => {
		const resultsState = await import('../../src/webview/core/results-state.js');
		const persistence = await import('../../src/webview/core/persistence.js');
		let activeExecutionId = 'execution-new';
		const section = {
			acceptsQueryTerminal: vi.fn((executionId: string) => executionId === activeExecutionId),
			completeQueryExecution: vi.fn((executionId: string) => {
				if (executionId !== activeExecutionId) return false;
				activeExecutionId = '';
				return true;
			}),
		};
		mocks.getQuerySectionElement.mockReturnValue(section);
		vi.mocked(resultsState.displayResultForBox).mockClear();
		mocks.setQueryExecuting.mockClear();
		vi.mocked(persistence.__kustoOnQueryResult).mockClear();

		dispatchHostMessage({
			type: 'queryResult', boxId: 'query_1', executionId: 'execution-old',
			result: { columns: ['Value'], rows: [['stale']], metadata: {} },
		});

		expect(mocks.setQueryExecuting).not.toHaveBeenCalled();
		expect(resultsState.displayResultForBox).not.toHaveBeenCalled();
		expect(persistence.__kustoOnQueryResult).not.toHaveBeenCalled();
		expect(section.completeQueryExecution).not.toHaveBeenCalled();

		const currentResult = { columns: ['Value'], rows: [['current']], metadata: {} };
		dispatchHostMessage({
			type: 'queryResult', boxId: 'query_1', executionId: 'execution-new', result: currentResult,
		});

		expect(resultsState.displayResultForBox).toHaveBeenCalledWith(currentResult, 'query_1', {
			label: 'Results', showExecutionTime: true, executionId: 'execution-new',
		});
		expect(persistence.__kustoOnQueryResult).toHaveBeenCalledWith('query_1', currentResult);
		expect(section.completeQueryExecution).toHaveBeenCalledWith('execution-new');
		expect(activeExecutionId).toBe('');
	});

	it('toolExecuteQuery consumes only its exact admitted Kusto terminal', async () => {
		let activeExecutionId = 'execution-current';
		const section = {
			acceptsQueryTerminal: vi.fn((executionId: string) => executionId === activeExecutionId),
			completeQueryExecution: vi.fn((executionId: string) => {
				if (executionId !== activeExecutionId) return false;
				activeExecutionId = '';
				return true;
			}),
		};
		mocks.getQuerySectionElement.mockReturnValue(section);
		mocks.executeQuery.mockReturnValue('execution-current');
		mocks.postMessageToHost.mockClear();

		dispatchHostMessage({ type: 'toolExecuteQuery', requestId: 'tool-query-1', sectionId: 'query_1' });
		dispatchHostMessage({
			type: 'queryResult', boxId: 'query_1', executionId: 'execution-stale',
			result: { columns: ['Value'], rows: [['stale']], metadata: {} },
		});
		expect(mocks.postMessageToHost).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'toolResponse', requestId: 'tool-query-1',
		}));

		dispatchHostMessage({
			type: 'queryResult', boxId: 'query_1', executionId: 'execution-current',
			result: { columns: ['Value'], rows: [['current']], metadata: {} },
		});

		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'toolResponse', requestId: 'tool-query-1',
			result: expect.objectContaining({ success: true, rowCount: 1 }),
		}));
	});

	it('does not persist a query result rejected by its owning section', async () => {
		const resultsState = await import('../../src/webview/core/results-state.js');
		const persistence = await import('../../src/webview/core/persistence.js');
		vi.mocked(resultsState.displayResultForBox).mockReturnValueOnce(false);

		dispatchHostMessage({
			type: 'queryResult', boxId: 'sql_removed',
			result: { columns: ['Secret'], rows: [['late-secret']], metadata: {} },
		});
		await Promise.resolve();

		expect(resultsState.displayResultForBox).toHaveBeenCalled();
		expect(persistence.__kustoOnQueryResult).not.toHaveBeenCalled();
	});

	it('does not apply SQL owner-token admission to a Kusto section', async () => {
		const queryElement = document.createElement('kw-query-section');
		queryElement.id = 'query_kusto_owner_guard';
		document.body.appendChild(queryElement);
		mocks.getSqlSectionElement.mockImplementation((boxId: string) => {
			const element = document.getElementById(boxId);
			return element?.tagName.toLowerCase() === 'kw-sql-section' ? element : null;
		});
		const resultsState = await import('../../src/webview/core/results-state.js');

		try {
			dispatchHostMessage({
				type: 'queryResult', boxId: 'query_kusto_owner_guard',
				result: { columns: ['Value'], rows: [[42]], metadata: {} },
			});
			await Promise.resolve();
			expect(resultsState.displayResultForBox).toHaveBeenCalledWith(
				expect.anything(), 'query_kusto_owner_guard', { label: 'Results', showExecutionTime: true },
			);
		} finally {
			queryElement.remove();
		}
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

	it('ignores SQL connection data delivered after a newer revision', async () => {
		dispatchHostMessage({
			type: 'sqlConnectionsData', revision: 20,
			connections: [{ id: 'sql-new', serverUrl: 'new.example' }],
			cachedDatabases: { 'sql-new': ['CurrentDb'] }, sqlLeaveNoTrace: ['sql-new'],
		});
		dispatchHostMessage({
			type: 'sqlConnectionsData', revision: 19,
			connections: [{ id: 'sql-old', serverUrl: 'old.example' }],
			cachedDatabases: { 'sql-old': ['StaleDb'] }, sqlLeaveNoTrace: [],
		});

		const state = await import('../../src/webview/core/state.js');
		expect(state.sqlConnections.map(connection => connection.id)).toEqual(['sql-new']);
		expect(state.sqlCachedDatabases).toEqual({ 'sql-new': ['CurrentDb'] });
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

	it('routes favoritesData to Kusto favorites state and all Kusto sections', async () => {
		const favorites = [{ name: 'Telemetry Favorite', clusterUrl: 'https://telemetry.kusto.windows.net', database: 'Samples' }];
		const enterFavoritesMode = vi.fn();
		(window as any).__kustoEnterFavoritesModeForBox = enterFavoritesMode;

		dispatchHostMessage({
			type: 'favoritesData',
			boxId: 'query_1',
			favorites,
		});
		await Promise.resolve();

		expect(mocks.setKustoFavorites).toHaveBeenCalledWith(favorites);
		expect(mocks.updateKustoFavoritesUiForAllBoxes).toHaveBeenCalledTimes(1);
		expect(mocks.tryAutoEnterKustoFavoritesModeForAllBoxes).toHaveBeenCalledTimes(1);
		expect(mocks.maybeDefaultFirstKustoBoxToFavoritesMode).toHaveBeenCalledTimes(1);
		expect(enterFavoritesMode).toHaveBeenCalledWith('query_1');
	});

	it('does not auto-enter Kusto favorites mode for non-originating favoritesData', async () => {
		dispatchHostMessage({
			type: 'favoritesData',
			favorites: [{ name: 'Remote Favorite', clusterUrl: 'https://remote.kusto.windows.net', database: 'Samples' }],
		});
		await Promise.resolve();

		expect(mocks.setKustoFavorites).toHaveBeenCalledTimes(1);
		expect(mocks.updateKustoFavoritesUiForAllBoxes).toHaveBeenCalledTimes(1);
		expect(mocks.tryAutoEnterKustoFavoritesModeForAllBoxes).not.toHaveBeenCalled();
		expect(mocks.maybeDefaultFirstKustoBoxToFavoritesMode).not.toHaveBeenCalled();
	});

	it('routes sqlDatabasesData and sqlDatabasesError to SQL database handlers', async () => {
		const sqlEl = createFakeSqlSection();
		mocks.getSqlSectionElement.mockReturnValue(sqlEl);
		dispatchHostMessage({ type: 'sqlDatabasesData', boxId: 'sql_1', sectionInstanceId: sqlEl.sqlSession.instanceId, databases: ['B', 'A'], sqlConnectionId: 'sql_conn_1' });
		dispatchHostMessage({ type: 'sqlDatabasesError', boxId: 'sql_1', sectionInstanceId: sqlEl.sqlSession.instanceId, error: 'failed', sqlConnectionId: 'sql_conn_1' });
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
			sectionInstanceId: sqlEl.sqlSession.instanceId,
			schema,
			schemaMeta: { tablesCount: 2, columnsCount: 2, fromCache: true },
		});
		dispatchHostMessage({
			type: 'sqlSchemaData',
			boxId: 'sql_1',
			sectionInstanceId: sqlEl.sqlSession.instanceId,
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

	it('admits only the current SQL database request and generation', async () => {
		const sqlEl = createFakeSqlSection();
		mocks.getSqlSectionElement.mockReturnValue(sqlEl);
		sqlEl.sqlSession.targetGeneration = 4;

		dispatchHostMessage({
			type: 'sqlDatabasesLoading', boxId: 'sql_1', sectionInstanceId: sqlEl.sqlSession.instanceId, sqlConnectionId: 'sql-a', requestId: 'db-current', targetGeneration: 4,
		});
		dispatchHostMessage({
			type: 'sqlDatabasesData', boxId: 'sql_1', sectionInstanceId: sqlEl.sqlSession.instanceId, sqlConnectionId: 'sql-a', requestId: 'db-stale', targetGeneration: 4, databases: ['StaleDb'],
		});
		dispatchHostMessage({
			type: 'sqlDatabasesError', boxId: 'sql_1', sectionInstanceId: sqlEl.sqlSession.instanceId, sqlConnectionId: 'sql-a', requestId: 'db-current', targetGeneration: 3, error: 'stale generation',
		});

		expect(sqlEl.sqlSession.databaseRequestId).toBe('db-current');
		expect(sqlEl.setDatabasesLoading).toHaveBeenCalledWith(true);
		expect(mocks.updateSqlDatabaseSelect).not.toHaveBeenCalled();
		expect(mocks.onSqlDatabasesError).not.toHaveBeenCalled();

		dispatchHostMessage({
			type: 'sqlDatabasesData', boxId: 'sql_1', sectionInstanceId: sqlEl.sqlSession.instanceId, sqlConnectionId: 'sql-a', requestId: 'db-current', targetGeneration: 4, databases: ['CurrentDb'],
		});

		expect(mocks.updateSqlDatabaseSelect).toHaveBeenCalledWith('sql_1', ['CurrentDb'], 'sql-a');
		expect(sqlEl.sqlSession.databaseRequestId).toBe('');
	});

	it('rejects a delayed SQL result after the owner token rotates', () => {
		const resultsState = vi.mocked(getResultsStateMock);
		const sqlEl = createFakeSqlSection() as FakeSqlSection & {
			getCopilotOwnerToken: ReturnType<typeof vi.fn>;
		};
		sqlEl.getCopilotOwnerToken = vi.fn(() => 'owner-new');
		mocks.getSqlSectionElement.mockReturnValue(sqlEl);

		dispatchHostMessage({
			type: 'queryResult', boxId: 'sql_1', ownerToken: 'owner-old',
			result: { columns: ['Secret'], rows: [['late-secret']], metadata: {} },
		});

		expect(resultsState).not.toHaveBeenCalled();
		expect(mocks.setQueryExecuting).not.toHaveBeenCalledWith('sql_1', false);
	});

	it('routes STS response, diagnostics, and connection state messages', async () => {
		const sqlEl = createFakeSqlSection() as FakeSqlSection & {
			getConnectionId: ReturnType<typeof vi.fn>;
			getDatabase: ReturnType<typeof vi.fn>;
		};
		sqlEl.sqlSession.targetGeneration = 4;
		sqlEl.getConnectionId = vi.fn(() => 'sql-a');
		sqlEl.getDatabase = vi.fn(() => 'Db');
		mocks.getSqlSectionElement.mockReturnValue(sqlEl);

		dispatchHostMessage({ type: 'stsResponse', boxId: 'sql_1', sectionInstanceId: sqlEl.sqlSession.instanceId, requestId: 'sts_1', result: { items: [] }, ownerToken: 'owner-1', targetGeneration: 4 });
		dispatchHostMessage({ type: 'stsDiagnostics', boxId: 'sql_1', sectionInstanceId: sqlEl.sqlSession.instanceId, markers: [{ message: 'before ready' }] });
		dispatchHostMessage({ type: 'stsDiagnostics', boxId: 'sql_1', sectionInstanceId: sqlEl.sqlSession.instanceId, markers: [] });
		dispatchHostMessage({
			type: 'stsConnectionState', boxId: 'sql_1', sectionInstanceId: sqlEl.sqlSession.instanceId, state: 'ready', ownerToken: 'owner-1', targetGeneration: 4,
			connectionId: 'sql-a', database: 'Db',
		});
		dispatchHostMessage({ type: 'stsDiagnostics', boxId: 'sql_1', sectionInstanceId: sqlEl.sqlSession.instanceId, markers: [{ message: 'after ready' }] });
		await Promise.resolve();

		expect(mocks.handleStsResponse).toHaveBeenCalledWith('sql_1', 'sts_1', { items: [] }, 'owner-1', 4);
		expect(sqlEl.setStsReady).toHaveBeenCalledWith(true, 'owner-1', 4);
		expect(mocks.handleStsDiagnostics).toHaveBeenCalledTimes(2);
		expect(mocks.handleStsDiagnostics).toHaveBeenNthCalledWith(1, 'sql_1', []);
		expect(mocks.handleStsDiagnostics).toHaveBeenNthCalledWith(2, 'sql_1', [{ message: 'after ready' }]);
	});

	it('routes STS connection errors to pending SQL tool settlement', () => {
		const sqlEl = createFakeSqlSection() as FakeSqlSection & { notifyStsConnectionError: ReturnType<typeof vi.fn> };
		sqlEl.notifyStsConnectionError = vi.fn();
		mocks.getSqlSectionElement.mockReturnValue(sqlEl);

		dispatchHostMessage({ type: 'stsConnectionState', boxId: 'sql_1', sectionInstanceId: sqlEl.sqlSession.instanceId, state: 'error', error: 'Login failed' });

		expect(sqlEl.notifyStsConnectionError).toHaveBeenCalledWith('Login failed');
		expect(sqlEl.setStsReady).not.toHaveBeenCalled();
	});

	it('clears STS diagnostics when a SQL owner is invalidated', async () => {
		const sqlEl = createFakeSqlSection() as FakeSqlSection & { invalidateOwner: ReturnType<typeof vi.fn> };
		sqlEl.invalidateOwner = vi.fn();
		mocks.getSqlSectionElement.mockReturnValue(sqlEl);

		dispatchHostMessage({
			type: 'sqlConnectionOwnerChanged', boxId: 'sql_1', sectionInstanceId: sqlEl.sqlSession.instanceId,
			connectionId: 'sql-a', targetGeneration: 7,
		});

		expect(mocks.handleStsDiagnostics).toHaveBeenCalledWith('sql_1', []);
		expect(sqlEl.invalidateOwner).toHaveBeenCalledOnce();
		expect(sqlEl.sqlSession.targetGeneration).toBe(7);
	});

	it('preserves Kusto optimization comparison state during SQL policy refresh', () => {
		const source = {};
		const comparison = {};
		handlerState.optimizationMetadataByBoxId.query_source = { comparisonBoxId: 'query_cmp' };
		handlerState.optimizationMetadataByBoxId.query_cmp = { sourceBoxId: 'query_source', isComparison: true };
		mocks.getQuerySectionElement.mockImplementation((boxId: string) => boxId === 'query_source' ? source : boxId === 'query_cmp' ? comparison : null);
		mocks.getSqlSectionElement.mockReturnValue(null);

		dispatchHostMessage({ type: 'sqlLeaveNoTraceData', connectionIds: ['sql-sensitive'] });

		expect(handlerState.optimizationMetadataByBoxId.query_cmp).toMatchObject({ sourceBoxId: 'query_source', isComparison: true });
		expect(handlerState.optimizationMetadataByBoxId.query_source).toMatchObject({ comparisonBoxId: 'query_cmp' });
		expect(mocks.clearResultsState).not.toHaveBeenCalledWith('query_cmp');
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

	it('drops a late tool schema refresh after the box target token changes', async () => {
		handlerState.connections.splice(0, handlerState.connections.length, {
			id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net', accountPartition: 'partition-1',
		});
		handlerState.schemaRequestTokenByBoxId.query_1 = 'schema-new-target';

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database: 'OldDb',
			clusterUrl: 'https://cluster.kusto.windows.net',
			accountPartition: 'partition-1',
			requestToken: 'schema-old-target',
			schema: { tables: ['OldTargetTable'], columnTypesByTable: {}, rawSchemaJson: { Databases: {} } },
			schemaMeta: { workerUpdateNeeded: true },
		});

		expect(handlerState.schemaByBoxId.query_1).toBeUndefined();
	});

	it('drops Kusto schema responses from an old account partition', async () => {
		handlerState.connections.splice(0, handlerState.connections.length, {
			id: 'c1',
			clusterUrl: 'https://cluster.kusto.windows.net',
			accountPartition: 'partition-b',
		});
		handlerState.schemaRequestTokenByBoxId.query_1 = 'schema_current';

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database: 'Samples',
			clusterUrl: 'https://cluster.kusto.windows.net',
			accountPartition: 'partition-a',
			requestToken: 'schema_current',
			schema: { tables: ['AccountATable'], columnTypesByTable: {}, rawSchemaJson: { Databases: {} } },
			schemaMeta: { schemaSignature: 'account-a', workerUpdateNeeded: true },
		});

		expect(handlerState.schemaByBoxId.query_1).toBeUndefined();
		expect(Object.keys(handlerState.schemaByConnDb)).toHaveLength(0);
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

	it('settles a failed background refresh to ready when the prepared fallback remains usable', async () => {
		const state = await import('../../src/webview/core/state.js');
		handlerState.schemaRequestTokenByBoxId.query_1 = 'schema_refresh';
		state.beginKustoPreparation('query_1', {
			stage: 'refreshing',
			blockers: ['refresh'],
			target: { connectionId: 'c1', database: 'Samples', requestToken: 'schema_refresh' },
			usableFallback: true,
		});

		dispatchHostMessage({
			type: 'schemaError',
			boxId: 'query_1',
			connectionId: 'c1',
			database: 'Samples',
			requestToken: 'schema_refresh',
			silent: true,
			isBackgroundRefresh: true,
			refreshState: 'failed',
			hasUsableFallback: true,
			error: 'Background schema refresh failed.',
		});

		expect(state.getKustoPreparationState('query_1')).toMatchObject({ status: 'ready', stage: 'ready', blockers: [] });
	});

	it('does not keep refresh as a blocker while stale cached schema is being applied', async () => {
		const state = await import('../../src/webview/core/state.js');
		const { getKustoSchemaIdentityKey } = await import('../../src/shared/kustoAuth.js');
		const clusterUrl = 'https://cluster.kusto.windows.net';
		const database = 'Samples';
		const schemaKey = getKustoSchemaIdentityKey('c1', 'partition-1', clusterUrl, database);
		handlerState.activeQueryEditorBoxId = 'query_1';
		handlerState.queryBoxes.push('query_1');
		mocks.getConnectionId.mockReturnValue('c1');
		mocks.getClusterUrl.mockReturnValue(clusterUrl);
		mocks.getDatabase.mockReturnValue(database);
		handlerState.connections.push({ id: 'c1', clusterUrl, accountPartition: 'partition-1' });
		handlerState.queryEditors.query_1 = { getModel: vi.fn(() => ({ uri: { toString: () => 'inmemory://model/current' } })) };
		state.beginKustoPreparation('query_1', {
			stage: 'schema',
			blockers: ['schema', 'worker'],
			target: { connectionId: 'c1', database, requestToken: 'schema_stale' },
		});
		handlerState.schemaRequestTokenByBoxId.query_1 = 'schema_stale';
		(window as any).__kustoSetMonacoKustoSchema = vi.fn(async () => true);

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database,
			clusterUrl,
			requestToken: 'schema_stale',
			schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: { Databases: { Samples: {} } } },
			schemaMeta: {
				schemaSignature: 'sig-stale',
				workerUpdateNeeded: true,
				isBackgroundRefresh: true,
				refreshState: 'scheduled',
				isStale: true,
			},
		});

		expect(state.getKustoPreparationState('query_1')).toMatchObject({
			status: 'preparing',
			blockers: ['worker'],
			target: { schemaKey, schemaSignature: 'sig-stale' },
		});
	});

	it('applies changed background schema silently while prepared autocomplete stays ready', async () => {
		const state = await import('../../src/webview/core/state.js');
		const { getKustoSchemaIdentityKey } = await import('../../src/shared/kustoAuth.js');
		const clusterUrl = 'https://cluster.kusto.windows.net';
		const database = 'Samples';
		const schemaKey = getKustoSchemaIdentityKey('c1', 'partition-1', clusterUrl, database);
		handlerState.activeQueryEditorBoxId = 'query_1';
		handlerState.queryBoxes.push('query_1');
		mocks.getConnectionId.mockReturnValue('c1');
		mocks.getClusterUrl.mockReturnValue(clusterUrl);
		mocks.getDatabase.mockReturnValue(database);
		handlerState.queryEditors.query_1 = { getModel: vi.fn(() => ({ uri: { toString: () => 'inmemory://model/current' } })) };
		state.beginKustoPreparation('query_1', {
			stage: 'ready',
			blockers: [],
			target: { connectionId: 'c1', database, schemaKey, schemaSignature: 'sig-old', modelUri: 'inmemory://model/current', requestToken: 'schema_refresh' },
			usableFallback: true,
		});
		handlerState.schemaRequestTokenByBoxId.query_1 = 'schema_refresh';
		handlerState.schemaWorkerReadyByBoxId.query_1 = {
			status: 'ready',
			schemaKey,
			schemaSignature: 'sig-old',
			modelUri: 'inmemory://model/current',
			updatedAt: Date.now(),
		};
		const setSchema = vi.fn(async () => true);
		(window as any).__kustoSetMonacoKustoSchema = setSchema;

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database,
			clusterUrl,
			requestToken: 'schema_refresh',
			schema: { tables: ['Events', 'NewEvents'], columnTypesByTable: {}, rawSchemaJson: { Databases: { Samples: {} } } },
			schemaMeta: {
				schemaSignature: 'sig-new',
				workerUpdateNeeded: true,
				isBackgroundRefresh: true,
				refreshState: 'completed',
				autocompleteChanged: true,
			},
		});

		await vi.waitFor(() => expect(setSchema).toHaveBeenCalled());
		expect(state.getKustoPreparationState('query_1')).toMatchObject({ status: 'ready', blockers: [] });
		expect(state.markSchemaWorkerApplyPending).not.toHaveBeenCalled();
	});

	it('does not promote an invalidated section from a late unchanged refresh', async () => {
		const state = await import('../../src/webview/core/state.js');
		const setSchema = vi.fn(async () => true);
		handlerState.activeQueryEditorBoxId = 'query_1';
		handlerState.queryBoxes.push('query_1');
		mocks.getConnectionId.mockReturnValue('c1');
		mocks.getClusterUrl.mockReturnValue('https://cluster.kusto.windows.net');
		mocks.getDatabase.mockReturnValue('Samples');
		handlerState.queryEditors.query_1 = { getModel: vi.fn(() => ({ uri: { toString: () => 'inmemory://model/current' } })) };
		state.beginKustoPreparation('query_1', {
			stage: 'refreshing',
			blockers: ['refresh'],
			target: { connectionId: 'c1', database: 'Samples', requestToken: 'schema_late' },
			usableFallback: true,
		});
		handlerState.schemaRequestTokenByBoxId.query_1 = 'schema_late';
		state.invalidateSchemaWorkerReadinessForBox('query_1');
		(window as any).__kustoSetMonacoKustoSchema = setSchema;

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database: 'Samples',
			clusterUrl: 'https://cluster.kusto.windows.net',
			requestToken: 'schema_late',
			schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: { Databases: { Samples: {} } } },
			schemaMeta: { schemaSignature: 'sig-1', workerUpdateNeeded: false, isBackgroundRefresh: true, refreshState: 'completed' },
		});

		await vi.waitFor(() => expect(setSchema).toHaveBeenCalled());
		expect(state.getKustoPreparationState('query_1').status).toBe('preparing');
	});

	it('ignores a late background error after worker invalidation reset preparation to idle', async () => {
		const state = await import('../../src/webview/core/state.js');
		handlerState.schemaRequestTokenByBoxId.query_1 = 'schema_late_error';
		state.beginKustoPreparation('query_1', {
			stage: 'refreshing',
			blockers: ['refresh'],
			target: { connectionId: 'c1', database: 'Samples', requestToken: 'schema_late_error' },
			usableFallback: true,
		});
		state.invalidateSchemaWorkerReadinessForBox('query_1');

		dispatchHostMessage({
			type: 'schemaError',
			boxId: 'query_1',
			connectionId: 'c1',
			database: 'Samples',
			requestToken: 'schema_late_error',
			silent: true,
			isBackgroundRefresh: true,
			hasUsableFallback: true,
			error: 'Background schema refresh failed.',
		});

		expect(state.getKustoPreparationState('query_1')).toMatchObject({ status: 'idle', stage: 'idle', blockers: [] });
	});

	it('clears schema request throttling after a terminal schema error', async () => {
		const state = await import('../../src/webview/core/state.js');
		handlerState.schemaRequestTokenByBoxId.query_1 = 'schema_failed';
		state.lastSchemaRequestAtByBoxId.query_1 = Date.now();
		state.beginKustoPreparation('query_1', {
			stage: 'schema',
			blockers: ['schema'],
			target: { connectionId: 'c1', database: 'Samples', requestToken: 'schema_failed' },
		});

		dispatchHostMessage({
			type: 'schemaError',
			boxId: 'query_1',
			connectionId: 'c1',
			database: 'Samples',
			requestToken: 'schema_failed',
			error: 'Schema fetch failed.',
		});

		expect(state.lastSchemaRequestAtByBoxId.query_1).toBe(0);
		expect(state.getKustoPreparationState('query_1').status).toBe('error');
	});

	it('does not demote preparation when a duplicate schema request fails after exact worker adoption', async () => {
		const state = await vi.importActual<typeof import('../../src/webview/core/state.js')>('../../src/webview/core/state.js');
		const { getKustoSchemaIdentityKey } = await import('../../src/shared/kustoAuth.js');
		const clusterUrl = 'https://cluster.kusto.windows.net';
		const database = 'Samples';
		const schemaKey = getKustoSchemaIdentityKey('c1', 'partition-1', clusterUrl, database);
		mocks.getConnectionId.mockReturnValue('c1');
		mocks.getClusterUrl.mockReturnValue(clusterUrl);
		mocks.getDatabase.mockReturnValue(database);
		handlerState.connections.push({ id: 'c1', clusterUrl, accountPartition: 'partition-1' });
		handlerState.queryEditors.query_1 = { getModel: vi.fn(() => ({ uri: { toString: () => 'inmemory://model/current' } })) };
		const token = state.beginKustoPreparation('query_1', {
			stage: 'schema',
			blockers: ['schema', 'worker'],
			target: { connectionId: 'c1', database, schemaKey, modelUri: 'inmemory://model/current', requestToken: 'schema_duplicate' },
		})!;
		state.markSchemaWorkerReady('query_1', schemaKey, undefined, 'inmemory://model/current', token);
		handlerState.schemaRequestTokenByBoxId.query_1 = 'schema_duplicate';

		dispatchHostMessage({
			type: 'schemaError',
			boxId: 'query_1',
			connectionId: 'c1',
			database,
			requestToken: 'schema_duplicate',
			error: 'Duplicate fetch failed.',
		});

		expect(state.getKustoPreparationState('query_1')).toMatchObject({ status: 'ready', blockers: [] });
		state.disposeKustoPreparation('query_1');
	});

	it('retries failed exact enhancement without making enhancement a preparation blocker', async () => {
		const state = await import('../../src/webview/core/state.js');
		const { getKustoSchemaIdentityKey } = await import('../../src/shared/kustoAuth.js');
		const clusterUrl = 'https://cluster.kusto.windows.net';
		const database = 'Samples';
		const schemaKey = getKustoSchemaIdentityKey('c1', 'partition-1', clusterUrl, database);
		handlerState.activeQueryEditorBoxId = 'query_1';
		handlerState.queryBoxes.push('query_1');
		mocks.getConnectionId.mockReturnValue('c1');
		mocks.getClusterUrl.mockReturnValue(clusterUrl);
		mocks.getDatabase.mockReturnValue(database);
		handlerState.queryEditors.query_1 = { getModel: vi.fn(() => ({ uri: { toString: () => 'inmemory://model/current' } })) };
		const failedToken = state.beginKustoPreparation('query_1', {
			stage: 'enhancing',
			blockers: ['enhancement'],
			target: { connectionId: 'c1', database, schemaKey, schemaSignature: 'sig-1', modelUri: 'inmemory://model/current' },
		})!;
		handlerState.schemaWorkerReadyByBoxId.query_1 = {
			status: 'ready',
			schemaKey,
			schemaSignature: 'sig-1',
			modelUri: 'inmemory://model/current',
			updatedAt: Date.now(),
		};
		state.markSchemaEnhancementFailed('query_1', schemaKey, 'sig-1', 'inmemory://model/current', failedToken);
		expect(state.getKustoPreparationState('query_1').status).toBe('ready');
		expect(state.isSchemaEnhancementFailed('query_1', schemaKey, 'sig-1', 'inmemory://model/current')).toBe(true);
		(window as any).__kustoSetMonacoKustoSchema = vi.fn(async () => true);

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database,
			clusterUrl,
			schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: { Databases: { Samples: {} } } },
			schemaMeta: { schemaSignature: 'sig-1', workerUpdateNeeded: false, isBackgroundRefresh: true, refreshState: 'completed' },
		});

		expect(state.markSchemaWorkerApplyPending).not.toHaveBeenCalled();
		expect((window as any).__kustoSetMonacoKustoSchema).not.toHaveBeenCalled();
		expect(mocks.retryPrimarySchemaEnhancement).toHaveBeenCalledWith({
			boxId: 'query_1',
			rawSchemaJson: { Databases: { Samples: {} } },
			clusterUrl,
			database,
			connectionId: 'c1',
			accountPartition: 'partition-1',
			schemaKey,
			modelUri: 'inmemory://model/current',
		});
		expect(state.getKustoPreparationState('query_1')).toMatchObject({ status: 'ready', blockers: [] });
	});

	it('ends preparation with an error when terminal schema data cannot populate autocomplete', async () => {
		const state = await import('../../src/webview/core/state.js');
		const queryEl = { setSchemaInfo: vi.fn() };
		mocks.getQuerySectionElement.mockReturnValue(queryEl);
		state.lastSchemaRequestAtByBoxId.query_1 = Date.now();

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database: 'Samples',
			clusterUrl: 'https://cluster.kusto.windows.net',
			schema: { tables: ['Events'], columnTypesByTable: {} },
			schemaMeta: { schemaSignature: 'legacy', workerUpdateNeeded: true, refreshState: 'completed' },
		});

		expect(state.getKustoPreparationState('query_1')).toMatchObject({ status: 'error', stage: 'error' });
		expect(state.lastSchemaRequestAtByBoxId.query_1).toBe(0);
		expect(queryEl.setSchemaInfo).toHaveBeenCalledWith(expect.objectContaining({ isError: true }));
	});

	it('ends preparation when worker schema apply stalls for a fully qualified function body', async () => {
		vi.useFakeTimers();
		try {
			const state = await import('../../src/webview/core/state.js');
			const { KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS } = await import('../../src/webview/shared/kusto-schema-preparation-deadline.js');
			const { extractCrossClusterRefs } = await import('../../src/webview/shared/cross-cluster-schema.js');
			const clusterUrl = 'https://current.kusto.windows.net';
			const database = 'CurrentDb';
			const query = [
				'.create-or-alter function with',
				'(',
				'    folder = "ARM",',
				'    docstring = "Returns the number attempts to provision Azure Resources by Cloud Customer GUID, Azure Resource Provider, and Azure Resource Type."',
				')',
				'getResourceProvisionAttempts_ByCcid',
				'(',
				'    startDate: datetime = datetime(null),',
				'    endDate: datetime = datetime(null)',
				')',
				'{',
				"    cluster('apadata.westus.kusto.windows.net').database('CxPlat').ARM_PUT_Requests_Details_Final",
				'    | where (isnull(startDate) or PreciseTimeStamp >= startDate)',
				'        and (isnull(endDate) or PreciseTimeStamp < endDate)',
				'    | summarize ProvisionAttempts = count()',
				'        by CloudCustomerGuid = toguid(CloudCustomerGuid)',
				'}',
			].join('\n');
			expect(extractCrossClusterRefs(query, { clusterUrl, database })).toEqual([
				{ clusterName: 'apadata.westus.kusto.windows.net', database: 'CxPlat' },
			]);
			handlerState.activeQueryEditorBoxId = 'query_1';
			handlerState.queryBoxes.push('query_1');
			mocks.getConnectionId.mockReturnValue('c1');
			mocks.getClusterUrl.mockReturnValue(clusterUrl);
			mocks.getDatabase.mockReturnValue(database);
			handlerState.queryEditors.query_1 = {
				getValue: vi.fn(() => query),
				getModel: vi.fn(() => ({ uri: { toString: () => 'inmemory://model/current' } })),
			};
			state.beginKustoPreparation('query_1', {
				stage: 'schema',
				blockers: ['schema', 'worker'],
				target: { connectionId: 'c1', database, requestToken: 'schema_stalled' },
			});
			handlerState.schemaRequestTokenByBoxId.query_1 = 'schema_stalled';
			(window as any).__kustoSetMonacoKustoSchema = vi.fn(() => new Promise<boolean>(() => undefined));

			dispatchHostMessage({
				type: 'schemaData',
				boxId: 'query_1',
				connectionId: 'c1',
				database,
				clusterUrl,
				requestToken: 'schema_stalled',
				schema: { tables: ['CurrentEvents'], columnTypesByTable: {}, rawSchemaJson: { Databases: { CurrentDb: {} } } },
				schemaMeta: { schemaSignature: 'sig-stalled', workerUpdateNeeded: true, refreshState: 'completed' },
			});
			await vi.advanceTimersByTimeAsync(KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS + 1);

			expect((window as any).__kustoSetMonacoKustoSchema).toHaveBeenCalledOnce();
			expect(state.markSchemaWorkerApplyFailed).toHaveBeenCalledWith(
				'query_1',
				expect.any(String),
				'inmemory://model/current',
				expect.any(Object),
			);
			expect(state.getKustoPreparationState('query_1')).toMatchObject({
				status: 'error',
				stage: 'error',
				blockers: [],
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('returns diagnostics-untrusted schema preparation to idle instead of waiting forever', async () => {
		const state = await import('../../src/webview/core/state.js');
		handlerState.activeQueryEditorBoxId = 'query_1';
		handlerState.queryBoxes.push('query_1');
		handlerState.schemaDiagnosticsTrustedByBoxId.query_1 = false;
		mocks.getConnectionId.mockReturnValue('c1');
		mocks.getClusterUrl.mockReturnValue('https://cluster.kusto.windows.net');
		mocks.getDatabase.mockReturnValue('Samples');
		handlerState.queryEditors.query_1 = { getModel: vi.fn(() => ({ uri: { toString: () => 'inmemory://model/current' } })) };
		(window as any).__kustoSetMonacoKustoSchema = vi.fn(async () => true);

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database: 'Samples',
			clusterUrl: 'https://cluster.kusto.windows.net',
			schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: { Databases: { Samples: {} } } },
			schemaMeta: { schemaSignature: 'sig-1', workerUpdateNeeded: true },
		});

		expect(state.getKustoPreparationState('query_1').status).toBe('idle');
		expect((window as any).__kustoSetMonacoKustoSchema).not.toHaveBeenCalled();
	});

	it('applies an explicit inactive switch without replacing the focused worker context', async () => {
		const state = await import('../../src/webview/core/state.js');
		const setSchema = vi.fn(async () => true);
		handlerState.activeQueryEditorBoxId = 'query_2';
		handlerState.queryBoxes.push('query_1', 'query_2');
		mocks.getConnectionId.mockReturnValue('c1');
		mocks.getClusterUrl.mockReturnValue('https://cluster.kusto.windows.net');
		mocks.getDatabase.mockReturnValue('Db1');
		handlerState.queryEditors.query_1 = { getModel: vi.fn(() => ({ uri: { toString: () => 'inmemory://model/one' } })) };
		handlerState.queryEditors.query_2 = { getModel: vi.fn(() => ({ uri: { toString: () => 'inmemory://model/two' } })) };
		(window as any).__kustoSetMonacoKustoSchema = setSchema;
		state.requireSchemaWorkerApply('query_1');

		try {
			dispatchHostMessage({
				type: 'schemaData',
				boxId: 'query_1',
				connectionId: 'c1',
				database: 'Db1',
				clusterUrl: 'https://cluster.kusto.windows.net',
				schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: { Databases: { Db1: {} } } },
				schemaMeta: { schemaSignature: 'sig-1', workerUpdateNeeded: true },
			});

			await vi.waitFor(() => expect(setSchema).toHaveBeenCalled());
			expect(setSchema.mock.calls[0][3]).toBe(false);
			expect(setSchema.mock.calls[0][5]).toBe(true);
		} finally {
			state.disposeKustoPreparation('query_1');
		}
	});

	it('updates Kusto schema caches without touching the worker when schema metadata says it is unchanged', async () => {
		const state = await import('../../src/webview/core/state.js');
		const { getKustoSchemaIdentityKey } = await import('../../src/shared/kustoAuth.js');
		const clusterUrl = 'https://cluster.kusto.windows.net';
		const database = 'Samples';
		const schemaKey = getKustoSchemaIdentityKey('c1', 'partition-1', clusterUrl, database);
		const schema = { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: { Databases: {} } };

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database,
			clusterUrl,
			schema,
			schemaMeta: { schemaSignature: 'same', workerUpdateNeeded: false, isBackgroundRefresh: true },
		});

		expect(handlerState.schemaByBoxId.query_1).toBe(schema);
		expect(handlerState.schemaByConnDb[schemaKey]).toBe(schema);
		expect(state.markSchemaWorkerApplyPending).not.toHaveBeenCalled();
		expect(state.markSchemaWorkerReady).not.toHaveBeenCalled();
	});

	it('skips duplicate schema worker apply only when schema key, signature, and model URI still match', async () => {
		const state = await import('../../src/webview/core/state.js');
		const { getKustoSchemaIdentityKey } = await import('../../src/shared/kustoAuth.js');
		const clusterUrl = 'https://cluster.kusto.windows.net';
		const database = 'Samples';
		const schemaKey = getKustoSchemaIdentityKey('c1', 'partition-1', clusterUrl, database);
		handlerState.activeQueryEditorBoxId = 'query_1';
		mocks.getConnectionId.mockReturnValue('c1');
		mocks.getClusterUrl.mockReturnValue(clusterUrl);
		mocks.getDatabase.mockReturnValue(database);
		handlerState.queryEditors.query_1 = { getModel: vi.fn(() => ({ uri: { toString: () => 'inmemory://model/current' } })) };
		handlerState.schemaWorkerReadyByBoxId.query_1 = {
			status: 'ready',
			schemaKey,
			schemaSignature: 'sig-1',
			modelUri: 'inmemory://model/current',
			updatedAt: Date.now(),
		};
		state.markSchemaEnhancementReady('query_1', schemaKey, 'sig-1', 'inmemory://model/current');
		(window as any).__kustoSetMonacoKustoSchema = vi.fn(async () => true);

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database,
			clusterUrl,
			schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: { Databases: { Samples: {} } } },
			schemaMeta: { schemaSignature: 'sig-1', workerUpdateNeeded: true },
		});

		expect(state.markSchemaWorkerApplyPending).not.toHaveBeenCalled();
		expect((window as any).__kustoSetMonacoKustoSchema).not.toHaveBeenCalled();
	});

	it('does not let stale ready state for an old model suppress schema apply for a new model', async () => {
		const state = await import('../../src/webview/core/state.js');
		const { getKustoSchemaIdentityKey } = await import('../../src/shared/kustoAuth.js');
		const clusterUrl = 'https://cluster.kusto.windows.net';
		const database = 'Samples';
		const schemaKey = getKustoSchemaIdentityKey('c1', 'partition-1', clusterUrl, database);
		handlerState.activeQueryEditorBoxId = 'query_1';
		mocks.getConnectionId.mockReturnValue('c1');
		mocks.getClusterUrl.mockReturnValue(clusterUrl);
		mocks.getDatabase.mockReturnValue(database);
		handlerState.queryEditors.query_1 = { getModel: vi.fn(() => ({ uri: { toString: () => 'inmemory://model/new' } })) };
		handlerState.schemaWorkerReadyByBoxId.query_1 = {
			status: 'ready',
			schemaKey,
			schemaSignature: 'sig-1',
			modelUri: 'inmemory://model/old',
			updatedAt: Date.now(),
		};
		(window as any).__kustoSetMonacoKustoSchema = vi.fn(async () => true);

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database,
			clusterUrl,
			schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: { Databases: { Samples: {} } } },
			schemaMeta: { schemaSignature: 'sig-1', workerUpdateNeeded: true },
		});

		expect(state.markSchemaWorkerApplyPending).toHaveBeenCalledWith('query_1', schemaKey, 'sig-1', 'inmemory://model/new', expect.any(Object));
		expect((window as any).__kustoSetMonacoKustoSchema).toHaveBeenCalledWith(
			{ Databases: { Samples: {} } },
			clusterUrl,
			database,
			true,
			'inmemory://model/new',
			false,
			expect.any(Function),
			expect.any(Object),
			undefined,
			'c1',
			'partition-1',
		);
	});

	it('forces a worker refresh when a background delivery changes the schema signature', async () => {
		const state = await import('../../src/webview/core/state.js');
		const clusterUrl = 'https://cluster.kusto.windows.net';
		const database = 'Samples';
		const { getKustoSchemaIdentityKey } = await import('../../src/shared/kustoAuth.js');
		const schemaKey = getKustoSchemaIdentityKey('c1', 'partition-1', clusterUrl, database);
		handlerState.activeQueryEditorBoxId = 'query_1';
		handlerState.queryBoxes.push('query_1');
		mocks.getConnectionId.mockReturnValue('c1');
		mocks.getClusterUrl.mockReturnValue(clusterUrl);
		mocks.getDatabase.mockReturnValue(database);
		handlerState.queryEditors.query_1 = { getModel: vi.fn(() => ({ uri: { toString: () => 'inmemory://model/current' } })) };
		handlerState.schemaWorkerReadyByBoxId.query_1 = {
			status: 'ready', schemaKey, schemaSignature: 'sig-old', modelUri: 'inmemory://model/current', updatedAt: Date.now(),
		};
		(window as any).__kustoSetMonacoKustoSchema = vi.fn(async () => true);

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database,
			clusterUrl,
			schema: { tables: ['Events', 'NewEvents'], columnTypesByTable: {}, rawSchemaJson: { Databases: { Samples: {} } } },
			schemaMeta: {
				schemaSignature: 'sig-new',
				workerUpdateNeeded: true,
				autocompleteChanged: true,
				isBackgroundRefresh: true,
				refreshState: 'completed',
			},
		});

		expect((window as any).__kustoSetMonacoKustoSchema).toHaveBeenCalledWith(
			{ Databases: { Samples: {} } },
			clusterUrl,
			database,
			true,
			'inmemory://model/current',
			true,
			expect.any(Function),
			undefined,
			undefined,
			'c1',
			'partition-1',
		);
		expect(state.markSchemaWorkerApplyPending).not.toHaveBeenCalled();
	});

	it('queues inactive schema data when no Monaco model exists yet', async () => {
		const state = await import('../../src/webview/core/state.js');
		const { getKustoSchemaIdentityKey } = await import('../../src/shared/kustoAuth.js');
		const clusterUrl = 'https://cluster.kusto.windows.net';
		const database = 'Samples';
		const schemaKey = getKustoSchemaIdentityKey('c1', 'partition-1', clusterUrl, database);
		handlerState.activeQueryEditorBoxId = '';
		handlerState.queryBoxes.push('query_1');
		mocks.getConnectionId.mockReturnValue('c1');
		mocks.getClusterUrl.mockReturnValue(clusterUrl);
		mocks.getDatabase.mockReturnValue(database);
		(window as any).__kustoSetMonacoKustoSchema = vi.fn(async () => true);

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database,
			clusterUrl,
			schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: { Databases: { Samples: {} } } },
			schemaMeta: { schemaSignature: 'sig-1', workerUpdateNeeded: true },
		});

		expect(state.pendingSchemaWorkerUpdateByBoxId.query_1).toEqual(expect.objectContaining({
			schemaKey,
			schemaSignature: 'sig-1',
			reason: 'waiting-for-model',
		}));
		expect(state.markSchemaWorkerApplyPending).not.toHaveBeenCalled();
		expect((window as any).__kustoSetMonacoKustoSchema).not.toHaveBeenCalled();
	});

	it('queues mandatory schema data until its Monaco model exists', async () => {
		const state = await import('../../src/webview/core/state.js');
		const { getKustoSchemaIdentityKey } = await import('../../src/shared/kustoAuth.js');
		const clusterUrl = 'https://cluster.kusto.windows.net';
		const database = 'Samples';
		const schemaKey = getKustoSchemaIdentityKey('c1', 'partition-1', clusterUrl, database);
		handlerState.activeQueryEditorBoxId = '';
		handlerState.queryBoxes.push('query_1');
		mocks.getConnectionId.mockReturnValue('c1');
		mocks.getClusterUrl.mockReturnValue(clusterUrl);
		mocks.getDatabase.mockReturnValue(database);
		state.requireSchemaWorkerApply('query_1');
		(window as any).__kustoSetMonacoKustoSchema = vi.fn(async () => true);

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database,
			clusterUrl,
			schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: { Databases: { Samples: {} } } },
			schemaMeta: { schemaSignature: 'sig-1', workerUpdateNeeded: false },
		});

		expect(state.pendingSchemaWorkerUpdateByBoxId.query_1).toEqual(expect.objectContaining({
			schemaKey,
			schemaSignature: 'sig-1',
			reason: 'waiting-for-model',
		}));
		expect(state.markSchemaWorkerApplyPending).not.toHaveBeenCalled();
		expect((window as any).__kustoSetMonacoKustoSchema).not.toHaveBeenCalled();
		state.disposeKustoPreparation('query_1');
	});

	it('applies open-time schema data for the sole query editor before focus settles', async () => {
		const state = await import('../../src/webview/core/state.js');
		const { getKustoSchemaIdentityKey } = await import('../../src/shared/kustoAuth.js');
		const clusterUrl = 'https://cluster.kusto.windows.net';
		const database = 'Samples';
		const schemaKey = getKustoSchemaIdentityKey('c1', 'partition-1', clusterUrl, database);
		handlerState.activeQueryEditorBoxId = '';
		handlerState.queryBoxes.push('query_1');
		mocks.getConnectionId.mockReturnValue('c1');
		mocks.getClusterUrl.mockReturnValue(clusterUrl);
		mocks.getDatabase.mockReturnValue(database);
		handlerState.queryEditors.query_1 = { getModel: vi.fn(() => ({ uri: { toString: () => 'inmemory://model/open' } })) };
		(window as any).__kustoSetMonacoKustoSchema = vi.fn(async () => true);
		(window as any).__kustoTriggerRevalidation = vi.fn();

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database,
			clusterUrl,
			schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: { Databases: { Samples: {} } } },
			schemaMeta: { schemaSignature: 'sig-1', workerUpdateNeeded: true },
		});
		await vi.waitFor(() => expect((window as any).__kustoTriggerRevalidation).toHaveBeenCalledWith('query_1'));

		expect(state.markSchemaWorkerApplyPending).toHaveBeenCalledWith('query_1', schemaKey, 'sig-1', 'inmemory://model/open', expect.any(Object));
		expect((window as any).__kustoSetMonacoKustoSchema).toHaveBeenCalledWith(
			{ Databases: { Samples: {} } },
			clusterUrl,
			database,
			true,
			'inmemory://model/open',
			false,
			expect.any(Function),
			expect.any(Object),
			undefined,
			'c1',
			'partition-1',
		);
	});

	it('queues schema data during multi-section restore even if one Monaco editor is ready', async () => {
		const state = await import('../../src/webview/core/state.js');
		const { getKustoSchemaIdentityKey } = await import('../../src/shared/kustoAuth.js');
		const clusterUrl = 'https://cluster.kusto.windows.net';
		const database = 'Samples';
		const schemaKey = getKustoSchemaIdentityKey('c1', 'partition-1', clusterUrl, database);
		handlerState.activeQueryEditorBoxId = '';
		handlerState.queryBoxes.push('query_1', 'query_2');
		mocks.getConnectionId.mockReturnValue('c1');
		mocks.getClusterUrl.mockReturnValue(clusterUrl);
		mocks.getDatabase.mockReturnValue(database);
		handlerState.queryEditors.query_1 = { getModel: vi.fn(() => ({ uri: { toString: () => 'inmemory://model/open' } })) };
		(window as any).__kustoSetMonacoKustoSchema = vi.fn(async () => true);
		(window as any).__kustoTriggerRevalidation = vi.fn();

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database,
			clusterUrl,
			schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: { Databases: { Samples: {} } } },
			schemaMeta: { schemaSignature: 'sig-1', workerUpdateNeeded: true },
		});

		expect(state.pendingSchemaWorkerUpdateByBoxId.query_1).toEqual(expect.objectContaining({
			schemaKey,
			schemaSignature: 'sig-1',
			reason: 'inactive-box',
		}));
		expect(state.markSchemaWorkerApplyPending).not.toHaveBeenCalled();
		expect((window as any).__kustoSetMonacoKustoSchema).not.toHaveBeenCalled();
		expect((window as any).__kustoTriggerRevalidation).not.toHaveBeenCalled();
	});

	it('queues inactive force-refresh schema data instead of stealing context', async () => {
		const state = await import('../../src/webview/core/state.js');
		const { getKustoSchemaIdentityKey } = await import('../../src/shared/kustoAuth.js');
		const clusterUrl = 'https://cluster.kusto.windows.net';
		const database = 'Samples';
		const schemaKey = getKustoSchemaIdentityKey('c1', 'partition-1', clusterUrl, database);
		handlerState.activeQueryEditorBoxId = 'query_active';
		handlerState.queryBoxes.push('query_active', 'query_1');
		mocks.getConnectionId.mockReturnValue('c1');
		mocks.getClusterUrl.mockReturnValue(clusterUrl);
		mocks.getDatabase.mockReturnValue(database);
		handlerState.queryEditors.query_1 = { getModel: vi.fn(() => ({ uri: { toString: () => 'inmemory://model/inactive' } })) };
		(window as any).__kustoSetMonacoKustoSchema = vi.fn(async () => true);
		(window as any).__kustoTriggerRevalidation = vi.fn();

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database,
			clusterUrl,
			schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: { Databases: { Samples: {} } } },
			schemaMeta: { schemaSignature: 'sig-1', workerUpdateNeeded: true, forceRefresh: true },
		});

		expect(state.pendingSchemaWorkerUpdateByBoxId.query_1).toEqual(expect.objectContaining({
			schemaKey,
			schemaSignature: 'sig-1',
			forceRefresh: true,
			reason: 'inactive-force-refresh',
		}));
		expect(state.markSchemaWorkerApplyPending).not.toHaveBeenCalled();
		expect((window as any).__kustoSetMonacoKustoSchema).not.toHaveBeenCalled();
		expect((window as any).__kustoTriggerRevalidation).not.toHaveBeenCalled();
	});

	it('loads an explicit user database switch even when another section owns Monaco focus', async () => {
		const state = await import('../../src/webview/core/state.js');
		const { getKustoSchemaIdentityKey } = await import('../../src/shared/kustoAuth.js');
		const clusterUrl = 'https://cluster.kusto.windows.net';
		const database = 'Samples';
		const schemaKey = getKustoSchemaIdentityKey('c1', 'partition-1', clusterUrl, database);
		handlerState.activeQueryEditorBoxId = 'query_2';
		handlerState.queryBoxes.push('query_1', 'query_2');
		mocks.getConnectionId.mockReturnValue('c1');
		mocks.getClusterUrl.mockReturnValue(clusterUrl);
		mocks.getDatabase.mockReturnValue(database);
		handlerState.queryEditors.query_1 = { getModel: vi.fn(() => ({ uri: { toString: () => 'inmemory://model/one' } })) };
		state.requireSchemaWorkerApply('query_1');
		(window as any).__kustoSetMonacoKustoSchema = vi.fn(async () => true);

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database,
			clusterUrl,
			schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: { Databases: { Samples: {} } } },
			schemaMeta: { schemaSignature: 'sig-user-switch', workerUpdateNeeded: false },
		});
		await Promise.resolve();

		expect(state.pendingSchemaWorkerUpdateByBoxId.query_1).toBeUndefined();
		expect((window as any).__kustoSetMonacoKustoSchema).toHaveBeenCalledWith(
			{ Databases: { Samples: {} } },
			clusterUrl,
			database,
			false,
			'inmemory://model/one',
			true,
			expect.any(Function),
			expect.any(Object),
			undefined,
			'c1',
			'partition-1',
		);
		state.disposeKustoPreparation('query_1');
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
		expect(section.hasAttribute('has-changes')).toBe(true);
		expect(section.hasAttribute('title')).toBe(false);
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
		let activeExecutionId = '';
		(section as any).setExternalQueryExecuting = vi.fn((executing: boolean, executionId: string) => {
			if (executing) {
				if (activeExecutionId && activeExecutionId !== executionId) return false;
				activeExecutionId = executionId;
				return true;
			}
			if (activeExecutionId !== executionId) return false;
			activeExecutionId = '';
			return true;
		});
		(section as any).getActiveExecutionId = vi.fn(() => activeExecutionId);
		(section as any).acceptsQueryTerminal = vi.fn((executionId: string) => activeExecutionId === executionId);
		(section as any).completeQueryExecution = vi.fn((executionId: string) => {
			if (activeExecutionId !== executionId) return false;
			activeExecutionId = '';
			return true;
		});
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
			const executionId = 'delegated-kusto-execution';
			dispatchHostMessage({
				type: 'copilotWriteQueryExecuting', boxId: 'query_1', executing: true, executionId,
			});
			const queryResultMessage = {
				type: 'queryResult', boxId: 'query_1', executionId, result: { rows, columns },
			};
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
		(section as any).getCopilotOwnerToken = vi.fn(() => 'owner-a');
		(section as any).getConnectionId = vi.fn(() => 'sql-test');
		(section as any).getDatabase = vi.fn(() => 'Db');
		mocks.getSqlSectionElement.mockReturnValue(section);
		mocks.setRunMode.mockImplementation((sectionId: string, mode: string) => {
			if (sectionId !== 'sql_1') return;
			state = { ...state, runMode: mode };
			setSerializedState(state);
		});

		dispatchHostMessage({
			type: 'toolDelegateToSqlCopilot', requestId: 'r-sql-copilot',
			input: {
				sectionId: 'sql_1', question: 'Help', expectedOwnerToken: 'owner-a',
				expectedConnectionId: 'sql-test', expectedDatabase: 'Db',
			},
		});
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

	it('does not dispatch delegated SQL Copilot text after the owner changes during chat preparation', async () => {
		let ownerToken = 'owner-a';
		const section = document.createElement('div') as any;
		section.id = 'sql_1';
		section.setCopilotChatVisible = vi.fn();
		section.getCopilotOwnerToken = vi.fn(() => ownerToken);
		section.getConnectionId = vi.fn(() => 'sql-test');
		section.getDatabase = vi.fn(() => 'Db');
		section.getCopilotChatEl = vi.fn(() => ({ setInputText: vi.fn() }));
		mocks.getSqlSectionElement.mockReturnValue(section);
		mocks.postMessageToHost.mockClear();

		dispatchHostMessage({
			type: 'toolDelegateToSqlCopilot', requestId: 'r-sql-owner-race',
			input: {
				sectionId: 'sql_1', question: 'Secret owner A request', expectedOwnerToken: 'owner-a',
				expectedConnectionId: 'sql-test', expectedDatabase: 'Db',
			},
		});
		ownerToken = 'owner-b';
		await new Promise(resolve => setTimeout(resolve, 170));

		expect(section.getCopilotChatEl).not.toHaveBeenCalled();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'toolResponse', requestId: 'r-sql-owner-race',
			result: expect.objectContaining({ success: false, error: 'SQL Copilot owner changed before dispatch.' }),
		}));
	});

	it('cancels delegated SQL Copilot during chat preparation without a delayed dispatch', async () => {
		const section = document.createElement('div') as any;
		section.id = 'sql_1';
		section.setCopilotChatVisible = vi.fn();
		section.getCopilotOwnerToken = vi.fn(() => 'owner-a');
		section.getConnectionId = vi.fn(() => 'sql-test');
		section.getDatabase = vi.fn(() => 'Db');
		section.getCopilotChatEl = vi.fn(() => ({ setInputText: vi.fn() }));
		section.copilotWriteQueryCancel = vi.fn();
		mocks.getSqlSectionElement.mockReturnValue(section);

		dispatchHostMessage({
			type: 'toolDelegateToSqlCopilot', requestId: 'r-sql-cancel',
			input: {
				sectionId: 'sql_1', question: 'Do not dispatch', expectedOwnerToken: 'owner-a',
				expectedConnectionId: 'sql-test', expectedDatabase: 'Db',
			},
		});
		dispatchHostMessage({
			type: 'toolCancelSqlCopilot', requestId: 'r-sql-cancel',
			sectionId: 'sql_1', expectedOwnerToken: 'owner-a',
		});
		await new Promise(resolve => setTimeout(resolve, 170));

		expect(section.copilotWriteQueryCancel).toHaveBeenCalledOnce();
		expect(section.getCopilotChatEl).not.toHaveBeenCalled();
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

	it('rejects an overlapping SQL tool execution before mutating its query', async () => {
		const { section } = createSectionWithShell('sql_overlap', { id: 'sql_overlap', type: 'sql', query: 'select A' });
		let resolveFirst!: (value: unknown) => void;
		const firstResult = new Promise(resolve => { resolveFirst = resolve; });
		(section as any).reserveToolRun = vi.fn()
			.mockReturnValueOnce(firstResult)
			.mockImplementationOnce(() => { throw new Error('A SQL tool query is already running for this section.'); });
		(section as any).startReservedToolRun = vi.fn();
		(section as any).abortReservedToolRun = vi.fn();
		(section as any).setQuery = vi.fn();
		mocks.getSqlSectionElement.mockReturnValue(section);

		dispatchHostMessage({
			type: 'toolConfigureSqlSection', requestId: 'sql-tool-a',
			input: { sectionId: 'sql_overlap', query: 'select A', execute: true, executionId: 'execution-a' },
		});
		await Promise.resolve();
		dispatchHostMessage({
			type: 'toolConfigureSqlSection', requestId: 'sql-tool-b',
			input: { sectionId: 'sql_overlap', query: 'update B', execute: true, executionId: 'execution-b' },
		});
		await Promise.resolve();

		expect((section as any).setQuery).toHaveBeenCalledTimes(1);
		expect((section as any).setQuery).toHaveBeenCalledWith('select A');
		expect((section as any).startReservedToolRun).toHaveBeenCalledOnce();
		resolveFirst({ rowCount: 0, executionId: 'execution-a', owner: {} });
		await Promise.resolve();
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
