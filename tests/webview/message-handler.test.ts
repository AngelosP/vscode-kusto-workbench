import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KwSectionShell } from '../../src/webview/components/kw-section-shell.js';
import { kustoEditorSchemaCoordinator } from '../../src/webview/core/kusto-editor-schema-runtime.js';
import {
	kustoSyntheticDatabaseRequests,
	kustoSyntheticSchemaRequests,
} from '../../src/webview/core/kusto-synthetic-request-runtime.js';
import { retireSqlComparisonAdmission } from '../../src/webview/core/sql-comparison-admission-runtime.js';

const handlerState = vi.hoisted(() => ({
	activeQueryEditorBoxId: '',
	connections: [] as Array<Record<string, unknown>>,
	kustoFavorites: [] as Array<Record<string, unknown>>,
	sqlConnections: [] as Array<Record<string, unknown>>,
	sqlCachedDatabases: {} as Record<string, string[]>,
	sqlFavorites: [] as Array<Record<string, unknown>>,
	sqlFavoritesModeByBoxId: {} as Record<string, boolean>,
	schemaByBoxId: {} as Record<string, unknown>,
	sqlSchemaByBoxId: {} as Record<string, unknown>,
	schemaMetaByBoxId: {} as Record<string, unknown>,
	schemaDiagnosticsTrustedByBoxId: {} as Record<string, boolean>,
	schemaByConnDb: {} as Record<string, unknown>,
	schemaMetaByConnDb: {} as Record<string, unknown>,
	schemaWorkerReadyByBoxId: {} as Record<string, any>,
	pendingSchemaWorkerUpdateByBoxId: {} as Record<string, unknown>,
	schemaRequestTokenByBoxId: {} as Record<string, string>,
	queryEditors: {} as Record<string, any>,
	queryBoxes: [] as string[],
	sqlBoxes: [] as string[],
	optimizationMetadataByBoxId: {} as Record<string, any>,
	pState: {
		isSessionFile: false,
		documentUri: '',
		documentKind: 'kqlx',
		allowedSectionKinds: ['query', 'chart', 'python', 'url', 'markdown'],
		defaultSectionKind: 'query',
		compatibilityMode: false,
		documentMutationAllowed: true,
		documentRuntimeActive: true,
		compatibilitySingleKind: 'query',
		upgradeRequestType: 'requestUpgradeToKqlx',
		compatibilityTooltip: '',
		copilotChatFirstTimeDismissed: false,
		devNotesSections: [],
		lastExecutedBox: '',
		documentEditRevision: 0,
		sourceGeneration: 0,
		documentViewSessionId: '',
		compatibilityPersistenceViewSessionId: '',
		compatibilityPersistenceDocumentRequestIds: new Set<string>(),
		compatibilityPersistenceAppliedDocumentRequests: new Map<string, string>(),
		documentViewInitialProjectionRequestId: '',
		documentViewProjectionRequestIds: new Set<string>(),
		resultsVisibleByBoxId: {},
		resultArtifactByBoxId: {},
	} as Record<string, unknown>,
}));

const mocks = {
	postMessageToHost: vi.fn((message: Record<string, unknown>) => {
		const compatibilityTypes = new Set([
			'requestDocument', 'persistDocument', 'documentReloadResult',
		]);
		const compatibilitySessionId = String(handlerState.pState.compatibilityPersistenceViewSessionId || '');
		if (compatibilitySessionId && compatibilityTypes.has(String(message.type || ''))) {
			Object.assign(message, {
				protocolVersion: 1, channel: 'compatibility-persistence', viewSessionId: compatibilitySessionId,
			});
		}
		const documentViewTypes = new Set([
			'documentReloadResult', 'markdownDocumentCommand', 'markdownDocumentCommandBarrierResult',
		]);
		const viewSessionId = String(handlerState.pState.documentViewSessionId || '');
		if (viewSessionId && documentViewTypes.has(String(message.type || ''))) {
			Object.assign(message, {
				protocolVersion: 1, channel: 'document-view', viewSessionId,
			});
		}
	}),
	markCrossClusterSchemaError: vi.fn(),
	handleCrossClusterSchemaData: vi.fn(() => true),
	handleCrossClusterSchemaError: vi.fn(() => true),
	retryPrimarySchemaEnhancement: vi.fn(() => true),
	releaseStaleCrossClusterResponse: vi.fn(),
	handleDocumentDataMessage: vi.fn(() => true),
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
	displayResultForBox: vi.fn(),
	clearResultsState: vi.fn(),
	retireResultsStateForRerun: vi.fn(),
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
	executeKustoComparisonPair: vi.fn(async () => true),
	updateCaretDocsToggleButtons: vi.fn(),
	updateAutoTriggerAutocompleteToggleButtons: vi.fn(),
	updateCopilotInlineCompletionsToggleButtons: vi.fn(),
	applyEditingPreferencesData: vi.fn(),
	applyKustoLeaveNoTracePolicy: vi.fn(),
	getResultArtifactByProducerExecution: vi.fn(),
	getCurrentResultArtifact: vi.fn(() => null),
	getResultsStateRevision: vi.fn(() => 0),
	bindResultArtifactConsumer: vi.fn(),
	getBoundResultArtifact: vi.fn(),
	unbindResultArtifactConsumer: vi.fn(),
	clearStoredQueryResult: vi.fn(),
	createSectionWithCapabilities: vi.fn(),
	isHostOwnedMarkdownDocument: vi.fn(() => false),
	waitForHostOwnedMarkdownCommands: vi.fn(async () => true),
	handleHostOwnedMarkdownCommandResult: vi.fn(() => ({ handled: false, accepted: false })),
	reconcileHostOwnedChartProjection: vi.fn(),
	reconcileHostOwnedHtmlProjection: vi.fn(),
	reconcileHostOwnedMarkdownProjection: vi.fn(),
	reconcileHostOwnedPythonProjection: vi.fn(),
	reconcileHostOwnedTransformationProjection: vi.fn(),
	reconcileHostOwnedUrlProjection: vi.fn(),
	detachSqlComparisonForAdmissionRollback: vi.fn((boxId: string, sourceBoxId: string) => {
		const metadata = handlerState.optimizationMetadataByBoxId[boxId];
		if (!metadata || String(metadata.sourceBoxId || '') !== sourceBoxId) return false;
		delete handlerState.optimizationMetadataByBoxId[boxId];
		if (handlerState.optimizationMetadataByBoxId[sourceBoxId]?.comparisonBoxId === boxId) {
			delete handlerState.optimizationMetadataByBoxId[sourceBoxId];
		}
		document.getElementById(boxId)?.removeAttribute('data-sql-comparison-admission-request-id');
		return true;
	}),
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

vi.mock('../../src/webview/core/markdown-document-client.js', () => ({
	isHostOwnedMarkdownDocument: mocks.isHostOwnedMarkdownDocument,
	waitForHostOwnedMarkdownCommands: mocks.waitForHostOwnedMarkdownCommands,
	handleHostOwnedMarkdownCommandResult: mocks.handleHostOwnedMarkdownCommandResult,
}));

vi.mock('../../src/webview/core/results-state.js', () => ({
	getCurrentResultArtifact: mocks.getCurrentResultArtifact,
	getResultArtifactByProducerExecution: mocks.getResultArtifactByProducerExecution,
	bindResultArtifactConsumer: mocks.bindResultArtifactConsumer,
	getBoundResultArtifact: mocks.getBoundResultArtifact,
	unbindResultArtifactConsumer: mocks.unbindResultArtifactConsumer,
	getResultsState: vi.fn(() => null),
	getResultsStateRevision: mocks.getResultsStateRevision,
	clearResultsState: mocks.clearResultsState,
	retireResultsStateForRerun: mocks.retireResultsStateForRerun,
	displayResultForBox: mocks.displayResultForBox,
	displayResult: vi.fn(),
	displayCancelled: mocks.displayCancelled,
}));

vi.mock('../../src/webview/core/error-renderer.js', () => ({
	__kustoRenderErrorUx: vi.fn(),
	__kustoDisplayBoxError: vi.fn(),
}));

vi.mock('../../src/webview/core/section-factory.js', () => ({
	addQueryBox: vi.fn(() => 'query_1'),
	isPinnedFirstSection: vi.fn((boxId: unknown) => {
		if (!handlerState.pState.firstSectionPinned) return false;
		const first = document.getElementById('queries-container')?.children[0] as HTMLElement | undefined;
		return !!first && first.id === String(boxId || '');
	}),
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
	addPythonBox: vi.fn(() => 'python_1'),
	addUrlBox: vi.fn(() => 'url_1'),
	removePythonBox: vi.fn(),
	removeUrlBox: vi.fn(),
	reconcileHostOwnedPythonProjection: mocks.reconcileHostOwnedPythonProjection,
	commitUrlDocumentState: vi.fn(() => true),
	reconcileHostOwnedUrlProjection: mocks.reconcileHostOwnedUrlProjection,
	addHtmlBox: vi.fn(() => 'html_1'),
	removeHtmlBox: vi.fn(),
	commitHtmlDocumentState: vi.fn(() => true),
	reconcileHostOwnedHtmlProjection: mocks.reconcileHostOwnedHtmlProjection,
	addSqlBox: vi.fn(() => 'sql_1'),
	removeSqlBox: vi.fn(),
	detachSqlComparisonForAdmissionRollback: mocks.detachSqlComparisonForAdmissionRollback,
	updateSqlConnectionSelects: mocks.updateSqlConnectionSelects,
	updateSqlDatabaseSelect: mocks.updateSqlDatabaseSelect,
	onSqlDatabasesError: mocks.onSqlDatabasesError,
	__kustoGetSqlSectionElement: mocks.getSqlSectionElement,
	sqlBoxes: handlerState.sqlBoxes,
	updateSqlFavoritesUiForAllBoxes: mocks.updateSqlFavoritesUiForAllBoxes,
	onPythonResult: mocks.onPythonResult,
	onPythonError: mocks.onPythonError,
	__kustoGetChartValidationStatus: vi.fn(() => null),
}));

vi.mock('../../src/webview/core/kusto-schema-request-state.js', () => ({
	schemaRequestTokenByBoxId: handlerState.schemaRequestTokenByBoxId,
}));

vi.mock('../../src/webview/sections/kw-markdown-section.js', () => ({
	addMarkdownBox: vi.fn(() => 'markdown_1'),
	removeMarkdownBox: vi.fn(),
	__kustoMaximizeMarkdownBox: vi.fn(),
	commitMarkdownDocumentState: vi.fn(() => true),
	reconcileHostOwnedMarkdownProjection: mocks.reconcileHostOwnedMarkdownProjection,
}));

vi.mock('../../src/webview/sections/kw-chart-section.js', () => ({
	addChartBox: vi.fn(() => 'chart_1'),
	removeChartBox: vi.fn(),
	reconcileHostOwnedChartProjection: mocks.reconcileHostOwnedChartProjection,
}));

vi.mock('../../src/webview/sections/kw-transformation-section.js', () => ({
	addTransformationBox: vi.fn(() => 'transformation_1'),
	removeTransformationBox: vi.fn(),
	commitTransformationDocumentState: vi.fn(() => true),
	reconcileHostOwnedTransformationProjection: mocks.reconcileHostOwnedTransformationProjection,
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
		executeKustoComparisonPair: mocks.executeKustoComparisonPair,
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
	DOCUMENT_RUNTIME_INVALIDATED_EVENT: 'kusto-document-runtime-invalidated',
	schedulePersist: vi.fn(),
	__kustoClearStoredQueryResult: mocks.clearStoredQueryResult,
	handleDocumentDataMessage: mocks.handleDocumentDataMessage,
	getKqlxState: vi.fn(() => ({ sections: [] })),
	flushCompatibilityPersist: mocks.flushCompatibilityPersist,
	acknowledgePersistDocument: mocks.acknowledgePersistDocument,
	__kustoSetCompatibilityMode: vi.fn(),
	__kustoApplyDocumentCapabilities: vi.fn(),
	__kustoRequestAddSection: vi.fn(),
	createSectionWithCapabilities: mocks.createSectionWithCapabilities,
	__kustoOnQueryResult: vi.fn(),
	__kustoScheduleLocalSchemaPrewarm: vi.fn(),
	resolvePendingKustoResultRestores: vi.fn(),
	resolvePendingSqlResultRestores: vi.fn(),
	discardPendingSqlResultRestores: vi.fn(),
	applyKustoLeaveNoTracePolicy: mocks.applyKustoLeaveNoTracePolicy,
	isDocumentMutationAllowed: () => handlerState.pState.documentMutationAllowed === true,
	finalizeDocumentDefaultsAfterAcknowledgement: vi.fn(),
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
	invalidateKustoSchemaIdentityState: vi.fn(),
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
	schemaByBoxId: handlerState.schemaByBoxId,
	getKustoEditorSchema: (boxId: string) => handlerState.schemaByBoxId[boxId],
	setKustoEditorSchema: (boxId: string, schema: unknown) => { handlerState.schemaByBoxId[boxId] = schema; },
	clearKustoEditorSchema: (boxId: string) => delete handlerState.schemaByBoxId[boxId],
	clearAllKustoEditorSchemas: () => {
		for (const boxId of Object.keys(handlerState.schemaByBoxId)) delete handlerState.schemaByBoxId[boxId];
	},
	sqlSchemaByBoxId: handlerState.sqlSchemaByBoxId,
	schemaMetaByBoxId: handlerState.schemaMetaByBoxId,
	getKustoSchemaMetadata: (boxId: string) => handlerState.schemaMetaByBoxId[boxId],
	setKustoSchemaMetadata: (boxId: string, metadata: unknown) => { handlerState.schemaMetaByBoxId[boxId] = metadata; },
	clearKustoSchemaMetadata: (boxId: string) => delete handlerState.schemaMetaByBoxId[boxId],
	clearAllKustoSchemaMetadata: () => {
		for (const boxId of Object.keys(handlerState.schemaMetaByBoxId)) delete handlerState.schemaMetaByBoxId[boxId];
	},
	schemaDiagnosticsTrustedByBoxId: handlerState.schemaDiagnosticsTrustedByBoxId,
	schemaFetchInFlightByBoxId: {},
	markSchemaWorkerApplyFailed: vi.fn(actual.markSchemaWorkerApplyFailed),
	markSchemaWorkerApplyPending: vi.fn(),
	markSchemaWorkerReady: vi.fn(),
	schemaWorkerReadyByBoxId: handlerState.schemaWorkerReadyByBoxId,
	getSchemaWorkerReadyState: (boxId: string) => handlerState.schemaWorkerReadyByBoxId[boxId],
	schemaWorkerReadyWaitersByBoxId: {},
	pendingSchemaWorkerUpdateByBoxId: handlerState.pendingSchemaWorkerUpdateByBoxId,
	getPendingSchemaWorkerUpdate: (boxId: string) => handlerState.pendingSchemaWorkerUpdateByBoxId[boxId],
	setPendingSchemaWorkerUpdate: (boxId: string, update: unknown) => { handlerState.pendingSchemaWorkerUpdateByBoxId[boxId] = update; },
	clearPendingSchemaWorkerUpdate: (boxId: string, expected?: unknown) => {
		const current = handlerState.pendingSchemaWorkerUpdateByBoxId[boxId];
		if (current === undefined || (expected !== undefined && current !== expected)) return false;
		delete handlerState.pendingSchemaWorkerUpdateByBoxId[boxId];
		return true;
	},
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
			if (!requestId || generation !== sqlSession.targetGeneration) return false;
			sqlSession.databaseRequestId = requestId;
			return true;
		}),
		acceptDatabaseResponse: vi.fn((requestId: string | undefined, generation: number) =>
			!!requestId && generation === sqlSession.targetGeneration
			&& requestId === sqlSession.databaseRequestId),
		completeDatabaseRequest: vi.fn((requestId: string) => {
			if (!requestId || requestId !== sqlSession.databaseRequestId) return false;
			sqlSession.databaseRequestId = '';
			return true;
		}),
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
	const el = document.createElement('kw-html-section') as FakeHtmlSection;
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
	const sectionType = String(initialState.type || '');
	const tagName = sectionType === 'query' || sectionType === 'copilotQuery'
		? 'kw-query-section'
		: sectionType === 'sql'
			? 'kw-sql-section'
			: 'div';
	const section = document.createElement(tagName) as FakeSectionHost;
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

function configureFakeKustoTarget(section: HTMLElement, initialConnectionId = 'conn-1', initialDatabase = 'db-1'): void {
	let connectionId = initialConnectionId;
	let database = initialDatabase;
	let targetConnectionId = initialConnectionId;
	let targetDatabase = initialDatabase;
	let targetGeneration = 1;
	Object.assign(section, {
		getConnectionId: () => connectionId,
		getDatabase: () => database,
		getSchemaLifecycleIdentity: () => ({ sectionInstanceId: `instance-${section.id}`, targetGeneration }),
		setConnectionId: (value: string) => { connectionId = String(value || ''); },
		setDatabase: (value: string) => { database = String(value || ''); },
		setDesiredDatabase: vi.fn(),
		clearDesiredDatabase: vi.fn(),
		setSchemaLifecycleTarget: vi.fn((nextConnectionId: string, nextDatabase?: string) => {
			const normalizedConnectionId = String(nextConnectionId || '');
			const normalizedDatabase = String(nextDatabase || '');
			if (normalizedConnectionId !== targetConnectionId || normalizedDatabase.toLowerCase() !== targetDatabase.toLowerCase()) {
				targetConnectionId = normalizedConnectionId;
				targetDatabase = normalizedDatabase;
				targetGeneration += 1;
			}
			return { sectionInstanceId: `instance-${section.id}`, targetGeneration };
		}),
	});
}

function configureFakeKustoCopilotRequest(section: HTMLElement, requestId = 'copilot-request-query_1') {
	const owner = {
		copilotRequestId: requestId,
		sectionInstanceId: `instance-${section.id}`,
		targetGeneration: 1,
	};
	Object.assign(section, {
		admitKustoCopilotMessage: vi.fn((message: Record<string, unknown>) =>
			message.copilotRequestId === owner.copilotRequestId
			&& message.sectionInstanceId === owner.sectionInstanceId
			&& message.targetGeneration === owner.targetGeneration),
		completeKustoCopilotRequest: vi.fn(),
	});
	return owner;
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

function documentViewHostMessage(message: Record<string, unknown>): Record<string, unknown> {
	return {
		protocolVersion: 1,
		channel: 'document-view',
		viewSessionId: 'view-session-1',
		...message,
	};
}

function compatibilityHostMessage(
	message: Record<string, unknown>,
	viewSessionId = 'compatibility-session-1',
): Record<string, unknown> {
	return {
		protocolVersion: 1,
		channel: 'compatibility-persistence',
		viewSessionId,
		...message,
	};
}

function kustoDispatch(clientActivityId: string): Record<string, unknown> {
	return {
		dispatchAttempt: 1,
		connectionRevision: 0,
		leaveNoTraceRevision: 0,
		connectionIdentityKey: 'cluster|authority',
		clusterEndpoint: 'https://cluster.kusto.windows.net',
		accountPartition: 'partition-1',
		authSessionGeneration: 0,
		clientActivityId,
	};
}

let getResultsStateMock: ReturnType<typeof vi.fn>;
let messageHandlerModule: typeof import('../../src/webview/core/message-handler.js');
let initialDispatcherReadyCount = 0;

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
		messageHandlerModule = await import('../../src/webview/core/message-handler.js');
		(window as any).__kustoBufferedHostMessages = [{
			type: 'persistenceMode',
			isSessionFile: false,
			documentUri: 'file:///startup.kqlx',
			documentKind: 'kqlx',
			allowedSectionKinds: ['query'],
			defaultSectionKind: 'query',
			compatibilityMode: false,
		}];
		await messageHandlerModule.startMainWebviewMessageDispatcher();
		initialDispatcherReadyCount = mocks.postMessageToHost.mock.calls.filter(([message]) =>
			message.type === 'mainWebviewDispatcherReady',
		).length;
	});

	beforeEach(async () => {
		kustoEditorSchemaCoordinator.clear();
		kustoSyntheticSchemaRequests.clearForTests();
		kustoSyntheticDatabaseRequests.clearForTests();
		const state = await import('../../src/webview/core/state.js');
		document.body.innerHTML = '';
		handlerState.activeQueryEditorBoxId = '';
		handlerState.connections.splice(0, handlerState.connections.length);
		handlerState.kustoFavorites.splice(0, handlerState.kustoFavorites.length);
		handlerState.sqlConnections.splice(0, handlerState.sqlConnections.length);
		handlerState.sqlFavorites.splice(0, handlerState.sqlFavorites.length);
		for (const key of Object.keys(handlerState.sqlCachedDatabases)) delete handlerState.sqlCachedDatabases[key];
		for (const key of Object.keys(handlerState.sqlFavoritesModeByBoxId)) delete handlerState.sqlFavoritesModeByBoxId[key];
		for (const key of Object.keys(handlerState.schemaByBoxId)) delete handlerState.schemaByBoxId[key];
		for (const key of Object.keys(handlerState.sqlSchemaByBoxId)) delete handlerState.sqlSchemaByBoxId[key];
		for (const key of Object.keys(handlerState.schemaMetaByBoxId)) delete handlerState.schemaMetaByBoxId[key];
		for (const key of Object.keys(handlerState.schemaDiagnosticsTrustedByBoxId)) delete handlerState.schemaDiagnosticsTrustedByBoxId[key];
		for (const key of Object.keys(handlerState.schemaByConnDb)) delete handlerState.schemaByConnDb[key];
		for (const key of Object.keys(handlerState.schemaMetaByConnDb)) delete handlerState.schemaMetaByConnDb[key];
		for (const key of Object.keys(handlerState.schemaWorkerReadyByBoxId)) delete handlerState.schemaWorkerReadyByBoxId[key];
		for (const key of Object.keys(handlerState.pendingSchemaWorkerUpdateByBoxId)) delete handlerState.pendingSchemaWorkerUpdateByBoxId[key];
		for (const key of Object.keys(handlerState.schemaRequestTokenByBoxId)) delete handlerState.schemaRequestTokenByBoxId[key];
		for (const key of Object.keys(handlerState.queryEditors)) delete handlerState.queryEditors[key];
		handlerState.queryBoxes.splice(0, handlerState.queryBoxes.length);
		handlerState.sqlBoxes.splice(0, handlerState.sqlBoxes.length);
		for (const key of Object.keys(handlerState.optimizationMetadataByBoxId)) delete handlerState.optimizationMetadataByBoxId[key];
		delete (window as any).__kustoSqlLastConnectionId;
		delete (window as any).__kustoSqlLastDatabase;
		delete (window as any).__kustoReadOnlyMode;
		delete (window as any).__kustoSetMonacoKustoSchema;
		vi.clearAllMocks();
		getResultsStateMock.mockReturnValue(null);
		mocks.getQuerySectionElement.mockReturnValue(null);
		mocks.getConnectionId.mockReturnValue('');
		mocks.getClusterUrl.mockReturnValue('');
		mocks.getDatabase.mockReturnValue('');
		mocks.getSqlSectionElement.mockReturnValue(null);
		mocks.createSectionWithCapabilities.mockImplementation((kind: unknown) => {
			const sectionKind = String(kind || '');
			if (handlerState.pState.compatibilityMode) {
				return { ok: false, error: `Adding a ${sectionKind} section requires upgrading this compatibility file first.` };
			}
			const allowedKinds = Array.isArray(handlerState.pState.allowedSectionKinds)
				? handlerState.pState.allowedSectionKinds.map(String)
				: [];
			if (!allowedKinds.includes(sectionKind)) {
				return { ok: false, error: `Section type "${sectionKind}" is unavailable in the current document host.` };
			}
			return { ok: true, sectionId: `${sectionKind}_1` };
		});
		delete (window as any).__kustoEnterFavoritesModeForBox;
		handlerState.pState.documentEditRevision = 0;
		handlerState.pState.sourceGeneration = 0;
		handlerState.pState.documentViewSessionId = '';
		handlerState.pState.compatibilityPersistenceViewSessionId = '';
		handlerState.pState.compatibilityPersistenceDocumentRequestIds = new Set<string>();
		handlerState.pState.compatibilityPersistenceAppliedDocumentRequests = new Map<string, string>();
		handlerState.pState.documentViewInitialProjectionRequestId = '';
		handlerState.pState.documentViewProjectionRequestIds = new Set<string>();
		handlerState.pState.documentKind = 'kqlx';
		handlerState.pState.allowedSectionKinds = ['query', 'sql', 'chart', 'transformation', 'markdown', 'python', 'url', 'html'];
		handlerState.pState.compatibilityMode = false;
		handlerState.pState.documentMutationAllowed = true;
		handlerState.pState.documentRuntimeActive = true;
		handlerState.pState.firstSectionPinned = false;
		handlerState.pState.devNotesSections = [];
		handlerState.pState.queryResultJsonByBoxId = {};
		handlerState.pState.resultArtifactByBoxId = {};
		handlerState.pState.upgradeRequestType = 'requestUpgradeToKqlx';
	});

	it('adopts buffered host traffic before publishing dispatcher readiness exactly once', async () => {
		expect(handlerState.pState.documentUri).toBe('file:///startup.kqlx');
		expect((window as any).__kustoBufferedHostMessages).toEqual([]);
		expect((window as any).__kustoHostMessageDispatcherReady).toBe(true);
		expect(initialDispatcherReadyCount).toBe(1);

		await messageHandlerModule.startMainWebviewMessageDispatcher();
		await messageHandlerModule.startMainWebviewMessageDispatcher();
		expect(mocks.postMessageToHost.mock.calls.filter(([message]) =>
			message.type === 'mainWebviewDispatcherReady',
		)).toHaveLength(0);
	});

	it('answers final-persist requests and records persistence acknowledgements', async () => {
		dispatchHostMessage({ type: 'requestFinalPersist', requestId: 'flush-1', reason: 'save' });
		dispatchHostMessage({ type: 'persistDocumentAck', snapshotId: 'snapshot-1', editRevision: 7 });
		await vi.waitFor(() => {
			expect(mocks.flushCompatibilityPersist).toHaveBeenCalledWith('flush-1', 'save');
			expect(mocks.acknowledgePersistDocument).toHaveBeenCalledWith('snapshot-1', 7, undefined);
		});
	});

	it('applies one stable mixed-section order after rejected command reconciliation', async () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		for (const id of ['query_1', 'url_1', 'python_1', 'url_2']) {
			const element = document.createElement('div');
			element.id = id;
			container.appendChild(element);
		}
		document.body.appendChild(container);
		mocks.handleHostOwnedMarkdownCommandResult.mockReturnValueOnce({
			handled: true,
			accepted: false,
			projection: {
				documentRevision: 4,
				sectionRevisions: { url_1: 1, python_1: 2, url_2: 0 },
				markdownSectionRevisions: {},
				chartSections: [],
				markdownSections: [],
				pythonSections: [{
					id: 'python_1', type: 'python', code: 'print(1)', output: 'one', expanded: true,
				}],
				transformationSections: [],
				urlSections: [
					{ id: 'url_1', type: 'url', url: 'https://example.com/one.png', expanded: true },
					{ id: 'url_2', type: 'url', url: 'https://example.com/two.png', expanded: true },
				],
				orderedSectionIds: ['url_1', 'python_1', 'url_2', 'query_1'],
			},
		});

		dispatchHostMessage({ type: 'markdownDocumentCommandResult', commandId: 'stale-url' });

		await vi.waitFor(() => expect(Array.from(container.children, element => element.id)).toEqual([
			'url_1', 'python_1', 'url_2', 'query_1',
		]));
		expect(mocks.reconcileHostOwnedMarkdownProjection).toHaveBeenCalledOnce();
		expect(mocks.reconcileHostOwnedChartProjection).toHaveBeenCalledOnce();
		expect(mocks.reconcileHostOwnedHtmlProjection).toHaveBeenCalledOnce();
		expect(mocks.reconcileHostOwnedPythonProjection).toHaveBeenCalledOnce();
		expect(mocks.reconcileHostOwnedTransformationProjection).toHaveBeenCalledOnce();
		expect(mocks.reconcileHostOwnedUrlProjection).toHaveBeenCalledOnce();
	});

	it('routes documentData to persistence handler', async () => {
		const message = { type: 'documentData', ok: true, state: { sections: [] } };
		dispatchHostMessage(message);
		await Promise.resolve();
		expect(mocks.handleDocumentDataMessage).toHaveBeenCalledWith(message);
	});

	it('rejects malformed and predecessor compatibility lifecycle traffic before B effects', async () => {
		handlerState.pState.compatibilityPersistenceViewSessionId = 'compatibility-session-B';
		handlerState.pState.compatibilityPersistenceDocumentRequestIds = new Set(['document-request-B']);
		const projection = compatibilityHostMessage({
			type: 'documentData', ok: true, requestId: 'document-request-B', requestSource: 'webview',
			reloadRequestId: 'reload-B', sourceGeneration: 4, forceReload: true,
			documentUri: 'file:///tmp/query.kql', documentKind: 'kql', allowedSectionKinds: ['query'],
			firstSectionPinned: true, documentMutationAllowed: true, editRevision: 0,
			state: { sections: [{ id: 'compat_primary_query', type: 'query', query: 'print 1' }] },
			compatibilityMode: true, compatibilitySingleKind: 'query', defaultSectionKind: 'query',
			upgradeRequestType: 'requestUpgradeToKqlx', compatibilityTooltip: 'Create a companion file.',
		}, 'compatibility-session-B');

		dispatchHostMessage({ ...projection, viewSessionId: 'compatibility-session-A' });
		dispatchHostMessage({ ...projection, editRevision: '0' });
		await Promise.resolve();
		expect(mocks.handleDocumentDataMessage).not.toHaveBeenCalled();
		expect(mocks.postMessageToHost).not.toHaveBeenCalled();

		dispatchHostMessage(projection);
		await Promise.resolve();
		expect(mocks.handleDocumentDataMessage).toHaveBeenCalledTimes(1);
		expect(mocks.handleDocumentDataMessage).toHaveBeenCalledWith(projection);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(compatibilityHostMessage({
			type: 'documentReloadResult', requestId: 'reload-B', applied: true, editRevision: 0,
			markdownCommandBarrierSupported: true,
		}, 'compatibility-session-B'));
		expect(handlerState.pState.compatibilityPersistenceDocumentRequestIds.has('document-request-B')).toBe(false);

		mocks.handleDocumentDataMessage.mockClear();
		mocks.postMessageToHost.mockClear();
		handlerState.pState.documentEditRevision = 2;
		const retryProjection = {
			...projection,
			reloadRequestId: 'reload-B-retry',
			sourceGeneration: 5,
		};
		dispatchHostMessage(retryProjection);
		await Promise.resolve();
		expect(mocks.handleDocumentDataMessage).not.toHaveBeenCalled();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(compatibilityHostMessage({
			type: 'documentReloadResult', requestId: 'reload-B-retry', applied: true, editRevision: 2,
			markdownCommandBarrierSupported: true,
		}, 'compatibility-session-B'));
		expect(handlerState.pState.sourceGeneration).toBe(5);
		const persistence = await import('../../src/webview/core/persistence.js');
		expect(persistence.schedulePersist).toHaveBeenCalledWith('compatibility-projection-retry', true);

		dispatchHostMessage(compatibilityHostMessage({
			type: 'requestFinalPersist', requestId: 'final-B', reason: 'save',
		}, 'compatibility-session-A'));
		dispatchHostMessage(compatibilityHostMessage({
			type: 'requestFinalPersist', requestId: 'final-B', reason: 4,
		}, 'compatibility-session-B'));
		dispatchHostMessage(compatibilityHostMessage({
			type: 'requestFinalPersist', requestId: 'final-B', reason: 'save',
		}, 'compatibility-session-B'));
		expect(mocks.flushCompatibilityPersist).toHaveBeenCalledTimes(1);
		expect(mocks.flushCompatibilityPersist).toHaveBeenCalledWith('final-B', 'save');

		dispatchHostMessage(compatibilityHostMessage({
			type: 'persistDocumentAck', snapshotId: 'snapshot-B', editRevision: 1,
		}, 'compatibility-session-A'));
		dispatchHostMessage(compatibilityHostMessage({
			type: 'persistDocumentAck', snapshotId: 'snapshot-B', editRevision: '1',
		}, 'compatibility-session-B'));
		dispatchHostMessage(compatibilityHostMessage({
			type: 'persistDocumentAck', snapshotId: 'snapshot-B', editRevision: 1,
		}, 'compatibility-session-B'));
		expect(mocks.acknowledgePersistDocument).toHaveBeenCalledTimes(1);
		expect(mocks.acknowledgePersistDocument).toHaveBeenCalledWith('snapshot-B', 1, undefined);
	});

	it('bounds applied compatibility requests and applies a changed retry under the same request', async () => {
		handlerState.pState.compatibilityPersistenceViewSessionId = 'compatibility-session-B';
		for (let index = 0; index < 66; index++) {
			const requestId = `bounded-request-${index}`;
			handlerState.pState.compatibilityPersistenceDocumentRequestIds.add(requestId);
			dispatchHostMessage(compatibilityHostMessage({
				type: 'documentData', ok: true, requestId, requestSource: 'webview',
				reloadRequestId: `bounded-reload-${index}`, sourceGeneration: index + 1, forceReload: true,
				documentUri: 'file:///tmp/query.kql', documentKind: 'kql', allowedSectionKinds: ['query'],
				firstSectionPinned: true, documentMutationAllowed: true, editRevision: 0,
				state: { sections: [{ id: 'compat_primary_query', type: 'query', query: `print ${index}` }] },
				compatibilityMode: true, compatibilitySingleKind: 'query', defaultSectionKind: 'query',
				upgradeRequestType: 'requestUpgradeToKqlx', compatibilityTooltip: '',
			}, 'compatibility-session-B'));
		}
		await Promise.resolve();
		expect(handlerState.pState.compatibilityPersistenceAppliedDocumentRequests.size).toBe(64);
		expect(handlerState.pState.compatibilityPersistenceAppliedDocumentRequests.has('bounded-request-0')).toBe(false);
		expect(handlerState.pState.compatibilityPersistenceAppliedDocumentRequests.has('bounded-request-65')).toBe(true);

		mocks.handleDocumentDataMessage.mockClear();
		const changedRetry = compatibilityHostMessage({
			type: 'documentData', ok: true, requestId: 'bounded-request-65', requestSource: 'webview',
			reloadRequestId: 'bounded-reload-changed', sourceGeneration: 67, forceReload: true,
			documentUri: 'file:///tmp/query.kql', documentKind: 'kql', allowedSectionKinds: ['query'],
			firstSectionPinned: true, documentMutationAllowed: true, editRevision: 0,
			state: { sections: [{ id: 'compat_primary_query', type: 'query', query: 'print changed' }] },
			compatibilityMode: true, compatibilitySingleKind: 'query', defaultSectionKind: 'query',
			upgradeRequestType: 'requestUpgradeToKqlx', compatibilityTooltip: '',
		}, 'compatibility-session-B');
		dispatchHostMessage(changedRetry);
		await Promise.resolve();
		expect(mocks.handleDocumentDataMessage).toHaveBeenCalledOnce();
		expect(mocks.handleDocumentDataMessage).toHaveBeenCalledWith(changedRetry);
	});

	it('rejects a changed compatibility retry whose generation is older than the current projection', async () => {
		handlerState.pState.compatibilityPersistenceViewSessionId = 'compatibility-session-B';
		handlerState.pState.compatibilityPersistenceDocumentRequestIds = new Set(['stale-retry-request']);
		const projection = compatibilityHostMessage({
			type: 'documentData', ok: true, requestId: 'stale-retry-request', requestSource: 'webview',
			reloadRequestId: 'stale-retry-initial', sourceGeneration: 8, forceReload: true,
			documentUri: 'file:///tmp/query.kql', documentKind: 'kql', allowedSectionKinds: ['query'],
			firstSectionPinned: true, documentMutationAllowed: true, editRevision: 0,
			state: { sections: [{ id: 'compat_primary_query', type: 'query', query: 'print current' }] },
			compatibilityMode: true, compatibilitySingleKind: 'query', defaultSectionKind: 'query',
			upgradeRequestType: 'requestUpgradeToKqlx', compatibilityTooltip: '',
		}, 'compatibility-session-B');
		dispatchHostMessage(projection);
		await Promise.resolve();
		handlerState.pState.sourceGeneration = 8;
		expect(handlerState.pState.sourceGeneration).toBe(8);

		mocks.handleDocumentDataMessage.mockClear();
		mocks.postMessageToHost.mockClear();
		dispatchHostMessage({
			...projection,
			reloadRequestId: 'stale-retry-lower',
			sourceGeneration: 7,
			state: { sections: [{ id: 'compat_primary_query', type: 'query', query: 'print stale changed' }] },
		});
		await Promise.resolve();

		expect(mocks.handleDocumentDataMessage).not.toHaveBeenCalled();
		expect(handlerState.pState.sourceGeneration).toBe(8);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(compatibilityHostMessage({
			type: 'documentReloadResult', requestId: 'stale-retry-lower', applied: false, editRevision: 0,
			markdownCommandBarrierSupported: true,
		}, 'compatibility-session-B'));
	});

	it('rejects malformed and duplicate initial document-view projections before adoption', async () => {
		handlerState.pState.documentEditRevision = 4;
		const projection = documentViewHostMessage({
			type: 'documentData', ok: true, reloadRequestId: 'reload-initial',
			sourceGeneration: 1, forceReload: false, documentUri: 'file:///tmp/session.kqlx',
			documentRevision: 0, sectionRevisions: {}, markdownSectionRevisions: {},
			state: { sections: [] },
		});

		dispatchHostMessage(projection);
		await Promise.resolve();
		dispatchHostMessage(documentViewHostMessage({
			...projection,
			reloadRequestId: 'reload-malformed',
			sourceGeneration: 'not-a-generation',
		}));
		dispatchHostMessage(projection);
		await Promise.resolve();

		expect(mocks.handleDocumentDataMessage).toHaveBeenCalledTimes(1);
		expect(mocks.handleDocumentDataMessage).toHaveBeenCalledWith(projection);
		expect(handlerState.pState.documentEditRevision).toBe(4);
		const reloadResults = mocks.postMessageToHost.mock.calls
			.map(([message]) => message)
			.filter(message => message?.type === 'documentReloadResult');
		expect(reloadResults).toEqual([documentViewHostMessage({
			type: 'documentReloadResult', requestId: 'reload-initial',
			applied: true, editRevision: 4, markdownCommandBarrierSupported: true,
		})]);
	});

	it('rejects prior-session command results and Save barriers before client admission', async () => {
		const projection = documentViewHostMessage({
			type: 'documentData', ok: true, reloadRequestId: 'reload-current',
			sourceGeneration: 5, forceReload: false, documentUri: 'file:///tmp/session.kqlx',
			documentRevision: 0, sectionRevisions: {}, markdownSectionRevisions: {},
			state: { sections: [] },
		});
		dispatchHostMessage(projection);
		await Promise.resolve();
		mocks.handleHostOwnedMarkdownCommandResult.mockClear();
		mocks.waitForHostOwnedMarkdownCommands.mockClear();
		mocks.postMessageToHost.mockClear();
		handlerState.pState.markdownSourceGeneration = 5;
		handlerState.pState.markdownDocumentRevision = 0;
		mocks.isHostOwnedMarkdownDocument.mockReturnValue(true);

		const commandResult = documentViewHostMessage({
			type: 'markdownDocumentCommandResult', commandId: 'command-current', ok: false,
			sourceGeneration: 5, documentRevision: 0,
			error: { code: 'stale-document-revision', message: 'Rejected.' },
			projection: {
				documentRevision: 0, sectionRevisions: {}, markdownSectionRevisions: {},
				chartSections: [], markdownSections: [], pythonSections: [], urlSections: [],
				orderedSectionIds: [],
			},
		});
		dispatchHostMessage({ ...commandResult, viewSessionId: 'retired-session' });
		dispatchHostMessage(commandResult);
		await Promise.resolve();
		expect(mocks.handleHostOwnedMarkdownCommandResult).toHaveBeenCalledTimes(1);
		expect(mocks.handleHostOwnedMarkdownCommandResult).toHaveBeenCalledWith(commandResult);

		const barrier = documentViewHostMessage({
			type: 'requestMarkdownCommandBarrier', requestId: 'barrier-current', sourceGeneration: 5,
		});
		dispatchHostMessage({ ...barrier, viewSessionId: 'retired-session' });
		dispatchHostMessage(barrier);
		await vi.waitFor(() => expect(mocks.waitForHostOwnedMarkdownCommands).toHaveBeenCalledTimes(1));
		const barrierResults = mocks.postMessageToHost.mock.calls
			.map(([message]) => message)
			.filter(message => message?.type === 'markdownDocumentCommandBarrierResult');
		expect(barrierResults).toEqual([documentViewHostMessage({
			type: 'markdownDocumentCommandBarrierResult', requestId: 'barrier-current',
			sourceGeneration: 5, documentRevision: 0, accepted: true,
		})]);
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
			markdownCommandBarrierSupported: true,
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
			markdownCommandBarrierSupported: true,
		});
	});

	it('exports exact Kusto lifecycle ownership in tool state', async () => {
		const persistence = await import('../../src/webview/core/persistence.js');
		vi.mocked(persistence.getKqlxState).mockReturnValueOnce({
			sections: [{ id: 'query_1', type: 'query', database: 'Samples' }],
		} as any);
		mocks.getConnectionId.mockReturnValue('c1');
		const lease = kustoEditorSchemaCoordinator.openSection('query_1', 'instance-1')!;
		const identity = kustoEditorSchemaCoordinator.setTarget(lease, 'c1', 'Samples')!;
		kustoEditorSchemaCoordinator.beginSchemaRequest(lease, 'schema-current');
		handlerState.schemaRequestTokenByBoxId.query_1 = 'schema-current';

		dispatchHostMessage({ type: 'requestToolState', requestId: 'tool-state-1' });
		await Promise.resolve();

		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolStateResponse', requestId: 'tool-state-1',
			sections: [expect.objectContaining({
				id: 'query_1', connectionId: 'c1', schemaRequestToken: 'schema-current',
				sectionInstanceId: 'instance-1', targetGeneration: identity.targetGeneration,
			})],
		});
	});

	it('mints exact Kusto schema ownership for a tokenless tool refresh', async () => {
		const persistence = await import('../../src/webview/core/persistence.js');
		vi.mocked(persistence.getKqlxState).mockReturnValueOnce({
			sections: [{ id: 'query_1', type: 'query', database: 'Samples' }],
		} as any);
		mocks.getConnectionId.mockReturnValue('c1');
		mocks.getDatabase.mockReturnValue('Samples');
		const lease = kustoEditorSchemaCoordinator.openSection('query_1', 'instance-1')!;
		kustoEditorSchemaCoordinator.setTarget(lease, 'c1', 'Samples');
		const state = await import('../../src/webview/core/state.js');
		state.schemaFetchInFlightByBoxId.query_1 = true;
		state.lastSchemaRequestAtByBoxId.query_1 = Date.now();
		state.beginKustoPreparation('query_1', { stage: 'schema', blockers: ['schema'], target: { connectionId: 'c1', database: 'Samples' } });

		dispatchHostMessage({ type: 'requestToolState', requestId: 'tool-state-refresh', purpose: 'schema-refresh', targetConnectionId: 'c1' });
		await Promise.resolve();

		const token = kustoEditorSchemaCoordinator.getSchemaRequestToken('query_1');
		expect(token).toMatch(/^schema_tool_/);
		expect(handlerState.schemaRequestTokenByBoxId.query_1).toBe(token);
		expect(state.schemaFetchInFlightByBoxId.query_1).toBe(false);
		expect(state.lastSchemaRequestAtByBoxId.query_1).toBe(0);
		expect(state.getKustoPreparationState('query_1').status).toBe('idle');
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolStateResponse', requestId: 'tool-state-refresh',
			sections: [expect.objectContaining({
				id: 'query_1', connectionId: 'c1', database: 'Samples', schemaRequestToken: token,
				sectionInstanceId: 'instance-1', targetGeneration: expect.any(Number),
			})],
		});
	});

	it('does not replace unrelated schema ownership during a targeted tool refresh', async () => {
		const persistence = await import('../../src/webview/core/persistence.js');
		vi.mocked(persistence.getKqlxState).mockReturnValueOnce({
			sections: [
				{ id: 'query_1', type: 'query', database: 'DbA' },
				{ id: 'query_2', type: 'query', database: 'DbB' },
			],
		} as any);
		mocks.getConnectionId.mockImplementation(boxId => boxId === 'query_1' ? 'c1' : 'c2');
		mocks.getDatabase.mockImplementation(boxId => boxId === 'query_1' ? 'DbA' : 'DbB');
		const first = kustoEditorSchemaCoordinator.openSection('query_1', 'instance-1')!;
		kustoEditorSchemaCoordinator.setTarget(first, 'c1', 'DbA');
		const second = kustoEditorSchemaCoordinator.openSection('query_2', 'instance-2')!;
		kustoEditorSchemaCoordinator.setTarget(second, 'c2', 'DbB');
		kustoEditorSchemaCoordinator.beginSchemaRequest(second, 'schema-in-flight-b');
		handlerState.schemaRequestTokenByBoxId.query_2 = 'schema-in-flight-b';

		dispatchHostMessage({ type: 'requestToolState', requestId: 'tool-state-targeted', purpose: 'schema-refresh', targetConnectionId: 'c1' });
		await Promise.resolve();

		expect(kustoEditorSchemaCoordinator.getSchemaRequestToken('query_1')).toMatch(/^schema_tool_/);
		expect(kustoEditorSchemaCoordinator.getSchemaRequestToken('query_2')).toBe('schema-in-flight-b');
		expect(handlerState.schemaRequestTokenByBoxId.query_2).toBe('schema-in-flight-b');
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
		await new Promise(resolve => setTimeout(resolve, 120));
		expect(mocks.setConnections).toHaveBeenCalledTimes(1);
		expect(mocks.updateConnectionSelects).toHaveBeenCalledTimes(1);
		expect(mocks.applyKustoLeaveNoTracePolicy).toHaveBeenCalledWith([], false, undefined, {});
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

	it('caches active synthetic schema success and consumes tombstoned late delivery', async () => {
		const { getKustoConnectionIdentityKey } = await import('../../src/shared/kustoAuth.js');
		const clusterUrl = 'https://cluster.kusto.windows.net';
		const connectionIdentity = getKustoConnectionIdentityKey(clusterUrl, 'common');
		handlerState.connections.push({ id: 'c1', clusterUrl, authorityId: 'common', accountPartition: 'partition-1' });
		const schema = { tables: ['Events'], columnTypesByTable: {} };
		const activeRequest = kustoSyntheticSchemaRequests.begin('__schema_req__active', {
			connectionId: 'c1',
			database: 'Samples',
			schemaKey: 'c1|Samples',
			accountPartition: 'partition-1',
			connectionIdentity,
		});
		dispatchHostMessage({
			type: 'schemaData',
			boxId: '__schema_req__active',
			connectionId: 'c1',
			accountPartition: 'partition-1',
			database: 'Samples',
			schema,
			schemaMeta: { schemaSignature: 'sig-active' },
		});

		await expect(activeRequest).resolves.toBe(schema);
		expect(handlerState.schemaByConnDb['c1|Samples']).toBe(schema);
		expect(handlerState.schemaByBoxId['__schema_req__active']).toBeUndefined();

		const lateRequest = kustoSyntheticSchemaRequests.begin('__schema_req__late', {
			connectionId: 'c1',
			database: 'LateDb',
			schemaKey: 'c1|LateDb',
			accountPartition: 'partition-1',
			connectionIdentity,
		});
		const lateRejection = expect(lateRequest).rejects.toThrow('canceled for test');
		kustoSyntheticSchemaRequests.cancel('__schema_req__late', new Error('canceled for test'));
		await lateRejection;
		dispatchHostMessage({
			type: 'schemaData',
			boxId: '__schema_req__late',
			connectionId: 'c1',
			database: 'LateDb',
			schema: { tables: ['LateEvents'], columnTypesByTable: {} },
		});

		expect(handlerState.schemaByConnDb['c1|LateDb']).toBeUndefined();
		expect(handlerState.schemaByBoxId['__schema_req__late']).toBeUndefined();
	});

	it('rejects synthetic schema delivery from a different account partition', async () => {
		const { getKustoConnectionIdentityKey } = await import('../../src/shared/kustoAuth.js');
		const clusterUrl = 'https://cluster.kusto.windows.net';
		handlerState.connections.push({ id: 'c1', clusterUrl, authorityId: 'common', accountPartition: 'partition-new' });
		const request = kustoSyntheticSchemaRequests.begin('__schema_req__old-principal', {
			connectionId: 'c1', database: 'Samples', schemaKey: 'old-key', accountPartition: 'partition-old',
			connectionIdentity: getKustoConnectionIdentityKey(clusterUrl, 'common'),
		});
		const rejection = expect(request).rejects.toThrow('target mismatch');

		dispatchHostMessage({
			type: 'schemaData', boxId: '__schema_req__old-principal', connectionId: 'c1', database: 'Samples',
			accountPartition: 'partition-old', schema: { tables: ['Old'], columnTypesByTable: {} },
		});

		await rejection;
		expect(handlerState.schemaByConnDb['old-key']).toBeUndefined();
	});

	it('consumes reserved synthetic IDs after broker retention has ended', () => {
		dispatchHostMessage({
			type: 'schemaData', boxId: '__schema_req__expired', connectionId: 'c1', database: 'LateDb',
			schema: { tables: ['LateEvents'], columnTypesByTable: {} },
		});
		dispatchHostMessage({
			type: 'databasesData', boxId: '__kusto_dbreq__expired', connectionId: 'c1', databases: ['LateDb'],
		});

		expect(handlerState.schemaByBoxId['__schema_req__expired']).toBeUndefined();
		expect(handlerState.schemaByConnDb['c1|LateDb']).toBeUndefined();
		expect(mocks.updateDatabaseSelect).not.toHaveBeenCalledWith(
			'__kusto_dbreq__expired', expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
		);
	});

	it('admits a lifecycle-stamped real section whose ID uses a reserved prefix', () => {
		const boxId = '__schema_req__manual';
		const lease = kustoEditorSchemaCoordinator.openSection(boxId, 'instance-real')!;
		const identity = kustoEditorSchemaCoordinator.setTarget(lease, 'c1', 'Samples')!;
		kustoEditorSchemaCoordinator.beginSchemaRequest(lease, 'schema-real');
		handlerState.schemaRequestTokenByBoxId[boxId] = 'schema-real';
		handlerState.connections.push({ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net', accountPartition: 'partition-1' });

		dispatchHostMessage({
			type: 'schemaData', boxId, connectionId: 'c1', accountPartition: 'partition-1',
			database: 'Samples', clusterUrl: 'https://cluster.kusto.windows.net', requestToken: 'schema-real', ...identity,
			schema: { tables: ['Events'], columnTypesByTable: {} },
			schemaMeta: { schemaSignature: 'real', workerUpdateNeeded: false },
		});

		expect(handlerState.schemaByBoxId[boxId]).toEqual({ tables: ['Events'], columnTypesByTable: {} });
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
		const invalidateSchemaLifecycleTarget = vi.fn();
		mocks.getQuerySectionElement.mockReturnValue({ clearResults, invalidateSchemaLifecycleTarget });
		handlerState.pState.queryResultJsonByBoxId = { query_1: '{"rows":[["secret-a"]]}' };

		dispatchHostMessage({ type: 'kustoAuthIdentityChanged', connectionIds: ['c1'], reason: 'selection' });

		expect(mocks.clearResultsState).toHaveBeenCalledWith('query_1');
		expect((handlerState.pState.queryResultJsonByBoxId as Record<string, string>).query_1).toBeUndefined();
		expect(clearResults).toHaveBeenCalledOnce();
		expect(invalidateSchemaLifecycleTarget).toHaveBeenCalledOnce();
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

	it('routes an unstamped SQL-derived comparison result through SQL ownership before rendering', async () => {
		const { registerSqlDerivedComparisonSession, registerSqlSectionSession } = await import('../../src/webview/core/sql-section-message-router.js');
		const resultsState = await import('../../src/webview/core/results-state.js');
		const source = createFakeSqlSection();
		source.id = 'sql_source';
		(source as any).getCopilotOwnerToken = vi.fn(() => 'owner-current');
		(source.sqlSession as any).ownerToken = 'owner-current';
		(source.sqlSession as any).admitOwnedMessage = vi.fn((message: any) => message.ownerToken === 'owner-current');
		registerSqlSectionSession(source.sqlSession as any);
		registerSqlDerivedComparisonSession('query_comparison', 'sql_source');
		mocks.getSqlSectionElement.mockImplementation((boxId: string) => boxId === 'sql_source' ? source : null);
		handlerState.optimizationMetadataByBoxId.query_comparison = { sourceBoxId: 'sql_source', isComparison: true };
		vi.mocked(resultsState.displayResultForBox).mockClear();
		const sourceArtifact = {
			artifactId: 'result:sql_source:1', sourceBoxId: 'sql_source', revision: 1, createdAt: 1,
			restored: false, columns: ['Value'], rows: [[0]], metadata: {},
			producer: {
				engine: 'sql', boxId: 'sql_source', executionId: 'sql-source-a',
				connectionId: 'sql-connection', database: 'SqlDb',
			},
			policy: {
				exposeToActiveContent: true, sendToModel: true,
				shareToClipboard: true, exportToCsv: true,
			},
			lineage: [],
		};
		mocks.getCurrentResultArtifact.mockReturnValue(sourceArtifact);
		mocks.getResultArtifactByProducerExecution.mockReturnValue(sourceArtifact);
		mocks.bindResultArtifactConsumer.mockReturnValue(sourceArtifact.artifactId);
		mocks.getBoundResultArtifact.mockReturnValue(sourceArtifact);

		dispatchHostMessage({
			type: 'copilotWriteQueryExecuting', boxId: 'query_comparison', ownerToken: 'owner-current',
			executionId: 'sql-comparison-1', executing: true,
			sourceBoxId: 'sql_source', sourceExecutionId: 'sql-source-a',
		});
		const sourceArtifactB = {
			...sourceArtifact,
			artifactId: 'result:sql_source:2', revision: 2, rows: [[99]],
			producer: { ...sourceArtifact.producer, executionId: 'sql-source-b' },
		};
		mocks.getCurrentResultArtifact.mockReturnValue(sourceArtifactB);
		const result = { columns: ['Value'], rows: [[1]], metadata: {} };
		dispatchHostMessage({
			type: 'queryResult', boxId: 'query_comparison', ownerToken: 'owner-current',
			executionId: 'sql-comparison-1', query: 'select 1 as Value',
			connectionId: 'sql-connection', database: 'SqlDb', result,
		});
		await Promise.resolve();

		expect(resultsState.displayResultForBox).toHaveBeenCalledWith(result, 'query_comparison', {
			label: 'Results', showExecutionTime: true,
			artifactPublication: expect.objectContaining({
				producer: expect.objectContaining({
					engine: 'sql', boxId: 'query_comparison', query: 'select 1 as Value',
					connectionId: 'sql-connection', database: 'SqlDb',
				}),
				lineage: [{ sourceArtifactId: sourceArtifact.artifactId, role: 'comparison-source' }],
				policy: expect.objectContaining({
					exposeToActiveContent: true, sendToModel: true,
					shareToClipboard: true, exportToCsv: true,
				}),
			}),
		});
		expect(mocks.bindResultArtifactConsumer).toHaveBeenCalledWith(
			'comparison:query_comparison:source', 'sql_source', sourceArtifact.artifactId,
		);
		expect(mocks.getResultArtifactByProducerExecution).toHaveBeenCalledWith('sql_source', 'sql-source-a');
		expect(mocks.unbindResultArtifactConsumer).toHaveBeenCalledWith('comparison:query_comparison:source');
		expect(mocks.setQueryExecuting).toHaveBeenCalledWith('query_comparison', true);
		expect(mocks.setQueryExecuting).toHaveBeenCalledWith('query_comparison', false);

		mocks.unbindResultArtifactConsumer.mockClear();
		dispatchHostMessage({
			type: 'copilotWriteQueryExecuting', boxId: 'query_comparison', ownerToken: 'owner-current',
			executionId: 'sql-comparison-2', executing: true,
			sourceBoxId: 'sql_source', sourceExecutionId: 'sql-source-a',
		});
		dispatchHostMessage({
			type: 'copilotWriteQueryExecuting', boxId: 'query_comparison', ownerToken: 'owner-current',
			executionId: 'sql-comparison-2', executing: false,
		});
		expect(mocks.unbindResultArtifactConsumer).toHaveBeenCalledWith('comparison:query_comparison:source');
	});

	it('renders a direct SQL comparison result with its exact bound source lineage', async () => {
		const { registerSqlDerivedComparisonSession, registerSqlSectionSession } = await import('../../src/webview/core/sql-section-message-router.js');
		const resultsState = await import('../../src/webview/core/results-state.js');
		const source = createFakeSqlSection();
		const comparison = createFakeSqlSection();
		let activeExecutionId = 'direct-comparison-1';
		source.id = 'sql_source';
		comparison.id = 'sql_comparison';
		(source.sqlSession as any).ownerToken = 'source-owner';
		(comparison.sqlSession as any).ownerToken = 'comparison-owner';
		(source.sqlSession as any).admitOwnedMessage = vi.fn((message: any) => message.ownerToken === 'source-owner');
		(comparison.sqlSession as any).admitOwnedMessage = vi.fn((message: any) =>
			message.ownerToken === 'comparison-owner' && message.executionId === activeExecutionId);
		(comparison as any).setExternalQueryExecuting = vi.fn((executing: boolean, executionId: string) => {
			if (executing) {
				if (activeExecutionId && activeExecutionId !== executionId) return false;
				activeExecutionId = executionId;
				return true;
			}
			if (activeExecutionId !== executionId) return false;
			activeExecutionId = '';
			return true;
		});
		registerSqlSectionSession(source.sqlSession as any);
		registerSqlSectionSession(comparison.sqlSession as any);
		registerSqlDerivedComparisonSession('sql_comparison', 'sql_source');
		mocks.getSqlSectionElement.mockImplementation((boxId: string) => ({
			sql_source: source, sql_comparison: comparison,
		} as Record<string, FakeSqlSection>)[boxId] || null);
		handlerState.optimizationMetadataByBoxId.sql_source = { comparisonBoxId: 'sql_comparison' };
		handlerState.optimizationMetadataByBoxId.sql_comparison = { sourceBoxId: 'sql_source', isComparison: true };
		const sourceArtifact = {
			artifactId: 'result:sql_source:direct', sourceBoxId: 'sql_source', revision: 1, createdAt: 1,
			restored: false, columns: ['Value'], rows: [[1]], metadata: {},
			producer: {
				engine: 'sql', boxId: 'sql_source', executionId: 'source-direct-1',
				connectionId: 'sql-connection', database: 'SqlDb',
			},
			policy: {
				exposeToActiveContent: true, sendToModel: true, shareToClipboard: true, exportToCsv: true,
			},
			lineage: [],
		};
		mocks.getBoundResultArtifact.mockReturnValue(sourceArtifact);
		mocks.getResultArtifactByProducerExecution.mockReturnValue(sourceArtifact);
		mocks.bindResultArtifactConsumer.mockReturnValue(sourceArtifact.artifactId);
		vi.mocked(resultsState.displayResultForBox).mockClear();
		const result = { columns: ['Value'], rows: [[2]], metadata: {} };

		dispatchHostMessage({
			type: 'queryResult', boxId: 'sql_comparison', ownerToken: 'comparison-owner',
			executionId: 'direct-comparison-1', comparisonSourceBoxId: 'sql_source',
			comparisonSourceExecutionId: 'source-direct-1', query: 'SELECT 2',
			connectionId: 'sql-connection', database: 'SqlDb', result,
		});
		await Promise.resolve();

		expect(resultsState.displayResultForBox).toHaveBeenCalledWith(result, 'sql_comparison', {
			label: 'Results', showExecutionTime: true, executionId: 'direct-comparison-1',
			artifactPublication: expect.objectContaining({
				producer: expect.objectContaining({ engine: 'sql', boxId: 'sql_comparison', executionId: 'direct-comparison-1' }),
				lineage: [{ sourceArtifactId: sourceArtifact.artifactId, role: 'comparison-source' }],
			}),
		});
		expect(activeExecutionId).toBe('');
		expect(mocks.unbindResultArtifactConsumer).toHaveBeenCalledWith('comparison:sql_comparison:source');

		dispatchHostMessage({
			type: 'copilotWriteQueryExecuting', boxId: 'sql_comparison', ownerToken: 'source-owner',
			executionId: 'copilot-after-direct', executing: true,
			sourceBoxId: 'sql_source', sourceExecutionId: 'source-direct-1',
		});
		expect(activeExecutionId).toBe('copilot-after-direct');
		expect(mocks.bindResultArtifactConsumer).toHaveBeenCalledWith(
			'comparison:sql_comparison:source', 'sql_source', sourceArtifact.artifactId,
		);
		dispatchHostMessage({
			type: 'copilotWriteQueryExecuting', boxId: 'sql_comparison', ownerToken: 'source-owner',
			executionId: 'copilot-after-direct', executing: false,
		});
		expect(activeExecutionId).toBe('');

		vi.mocked(resultsState.displayResultForBox).mockClear();
		activeExecutionId = 'direct-stale-source';
		dispatchHostMessage({
			type: 'queryResult', boxId: 'sql_comparison', ownerToken: 'comparison-owner',
			executionId: 'direct-stale-source', comparisonSourceBoxId: 'sql_source',
			comparisonSourceExecutionId: 'source-stale', query: 'SELECT 2',
			connectionId: 'sql-connection', database: 'SqlDb', result,
		});
		expect(resultsState.displayResultForBox).not.toHaveBeenCalled();
	});

	it('settles a direct SQL comparison error before a Copilot comparison retry', async () => {
		const { registerSqlDerivedComparisonSession, registerSqlSectionSession } = await import('../../src/webview/core/sql-section-message-router.js');
		const errorRenderer = await import('../../src/webview/core/error-renderer.js');
		const source = createFakeSqlSection();
		const comparison = createFakeSqlSection();
		let activeExecutionId = 'direct-error';
		source.id = 'sql_source';
		comparison.id = 'sql_comparison';
		(source.sqlSession as any).ownerToken = 'source-owner';
		(comparison.sqlSession as any).ownerToken = 'comparison-owner';
		(comparison.sqlSession as any).admitOwnedMessage = vi.fn((message: any) =>
			message.ownerToken === 'comparison-owner' && message.executionId === activeExecutionId);
		(comparison as any).setExternalQueryExecuting = vi.fn((executing: boolean, executionId: string) => {
			if (executing) {
				if (activeExecutionId && activeExecutionId !== executionId) return false;
				activeExecutionId = executionId;
				return true;
			}
			if (activeExecutionId !== executionId) return false;
			activeExecutionId = '';
			return true;
		});
		registerSqlSectionSession(source.sqlSession as any);
		registerSqlSectionSession(comparison.sqlSession as any);
		registerSqlDerivedComparisonSession('sql_comparison', 'sql_source');
		mocks.getSqlSectionElement.mockImplementation((boxId: string) => ({
			sql_source: source, sql_comparison: comparison,
		} as Record<string, FakeSqlSection>)[boxId] || null);
		handlerState.optimizationMetadataByBoxId.sql_source = { comparisonBoxId: 'sql_comparison' };
		handlerState.optimizationMetadataByBoxId.sql_comparison = { sourceBoxId: 'sql_source', isComparison: true };
		const sourceArtifact = {
			artifactId: 'result:sql_source:retry', sourceBoxId: 'sql_source', revision: 1,
			producer: { engine: 'sql', boxId: 'sql_source', executionId: 'source-retry' },
		};
		mocks.getResultArtifactByProducerExecution.mockReturnValue(sourceArtifact);
		mocks.bindResultArtifactConsumer.mockReturnValue(sourceArtifact.artifactId);
		vi.mocked(errorRenderer.__kustoRenderErrorUx).mockClear();

		dispatchHostMessage({
			type: 'queryError', boxId: 'sql_comparison', ownerToken: 'comparison-owner',
			executionId: 'direct-error', error: 'direct failure',
		});
		expect(activeExecutionId).toBe('');
		expect(errorRenderer.__kustoRenderErrorUx).toHaveBeenCalledWith(
			'sql_comparison', 'direct failure', undefined, 'direct-error',
		);

		dispatchHostMessage({
			type: 'copilotWriteQueryExecuting', boxId: 'sql_comparison', ownerToken: 'source-owner',
			executionId: 'copilot-after-error', executing: true,
			sourceBoxId: 'sql_source', sourceExecutionId: 'source-retry',
		});
		expect(activeExecutionId).toBe('copilot-after-error');
		expect(mocks.bindResultArtifactConsumer).toHaveBeenCalledWith(
			'comparison:sql_comparison:source', 'sql_source', sourceArtifact.artifactId,
		);
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
		expect(persistence.__kustoOnQueryResult).toHaveBeenCalledWith('query_42', result, undefined);
	});

	it('rejects an expired Kusto publication before rendering and acknowledges false', async () => {
		const resultsState = await import('../../src/webview/core/results-state.js');
		vi.mocked(resultsState.displayResultForBox).mockClear();
		mocks.postMessageToHost.mockClear();

		dispatchHostMessage({
			type: 'kustoPublicationStage', publicationId: 'publication-expired', publicationDeadline: Date.now() - 1,
			payload: { type: 'queryResult', engine: 'kusto', boxId: 'query_1', executionId: 'expired',
			sectionInstanceId: 'instance-query_1', targetGeneration: 1, connectionId: 'c1', database: 'Db', producer: 'manual',
			reservationSequence: 1, dispatch: {
				dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 1,
				connectionIdentityKey: 'cluster|', clusterEndpoint: 'https://cluster.kusto.windows.net',
				accountPartition: 'partition', authSessionGeneration: 0, clientActivityId: 'expired',
			},
			result: { columns: ['x'], rows: [[1]], metadata: {} },
			},
		});
		await Promise.resolve();

		expect(resultsState.displayResultForBox).not.toHaveBeenCalled();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'kustoPublicationAck', publicationId: 'publication-expired', phase: 'staged', accepted: false,
		});
	});

	it('revokes staged Kusto publication authority before a late commit can render', async () => {
		vi.useFakeTimers();
		try {
			const resultsState = await import('../../src/webview/core/results-state.js');
			vi.mocked(resultsState.displayResultForBox).mockClear();
			mocks.postMessageToHost.mockClear();
			dispatchHostMessage({
				type: 'kustoPublicationStage', publicationId: 'publication-late-commit', publicationDeadline: Date.now() + 100,
				payload: {
					type: 'queryResult', engine: 'kusto', boxId: 'query_1', executionId: 'late',
					sectionInstanceId: 'instance-query_1', targetGeneration: 1, connectionId: 'c1', database: 'Db', producer: 'manual',
					reservationSequence: 1, dispatch: {
						dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 1,
						connectionIdentityKey: 'cluster|', clusterEndpoint: 'https://cluster.kusto.windows.net',
						accountPartition: 'partition', authSessionGeneration: 0, clientActivityId: 'late',
					}, result: { columns: ['x'], rows: [[1]], metadata: {} },
				},
			});
			await vi.advanceTimersByTimeAsync(101);
			dispatchHostMessage({ type: 'kustoPublicationCommit', publicationId: 'publication-late-commit' });
			await Promise.resolve();

			expect(resultsState.displayResultForBox).not.toHaveBeenCalled();
			expect(mocks.postMessageToHost).toHaveBeenCalledWith({
				type: 'kustoPublicationAck', publicationId: 'publication-late-commit', phase: 'applied', accepted: false,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects an unstamped terminal aimed at a registered Kusto section', async () => {
		const resultsState = await import('../../src/webview/core/results-state.js');
		const persistence = await import('../../src/webview/core/persistence.js');
		handlerState.queryBoxes.push('query_42');
		mocks.getQuerySectionElement.mockReturnValue({ admitQueryTerminal: vi.fn() });
		vi.mocked(resultsState.displayResultForBox).mockClear();
		vi.mocked(persistence.__kustoOnQueryResult).mockClear();

		dispatchHostMessage({
			type: 'queryResult', boxId: 'query_42',
			result: { columns: ['Value'], rows: [[42]], metadata: {} },
		});

		expect(resultsState.displayResultForBox).not.toHaveBeenCalled();
		expect(persistence.__kustoOnQueryResult).not.toHaveBeenCalled();
		expect(mocks.setQueryExecuting).not.toHaveBeenCalled();
	});

	it('rejects a queued Kusto terminal after a newer execution claims the section', async () => {
		const resultsState = await import('../../src/webview/core/results-state.js');
		const persistence = await import('../../src/webview/core/persistence.js');
		let activeExecutionId = 'execution-new';
		const section = {
			admitQueryTerminal: vi.fn((identity: { executionId: string }) => identity.executionId === activeExecutionId ? 'active' : 'rejected'),
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
			type: 'queryResult', engine: 'kusto', boxId: 'query_1', executionId: 'execution-old',
			sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples', producer: 'manual', reservationSequence: 1,
			dispatch: kustoDispatch('old'),
			result: { columns: ['Value'], rows: [['stale']], metadata: {} },
		});

		expect(mocks.setQueryExecuting).not.toHaveBeenCalled();
		expect(resultsState.displayResultForBox).not.toHaveBeenCalled();
		expect(persistence.__kustoOnQueryResult).not.toHaveBeenCalled();
		expect(section.completeQueryExecution).not.toHaveBeenCalled();

		const currentResult = { columns: ['Value'], rows: [['current']], metadata: {} };
		dispatchHostMessage({
			type: 'queryResult', engine: 'kusto', boxId: 'query_1', executionId: 'execution-new',
			sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples', producer: 'manual', reservationSequence: 2,
			dispatch: kustoDispatch('current'), query: 'StormEvents | take 10',
			result: currentResult,
		});

		expect(resultsState.displayResultForBox).toHaveBeenCalledWith(currentResult, 'query_1', expect.objectContaining({
			label: 'Results', showExecutionTime: true, executionId: 'execution-new',
			artifactPublication: expect.objectContaining({
				producer: expect.objectContaining({
					executionId: 'execution-new', reservationSequence: 2, dispatch: kustoDispatch('current'),
					query: 'StormEvents | take 10', connectionId: 'connection-1', database: 'Samples',
				}),
				policy: expect.objectContaining({
					accountPartition: 'partition-1', leaveNoTraceRevision: 0,
					exposeToActiveContent: true, sendToModel: true,
					shareToClipboard: true, exportToCsv: true,
				}),
			}),
		}));
		expect(persistence.__kustoOnQueryResult).toHaveBeenCalledWith('query_1', currentResult, kustoDispatch('current'));
		expect(section.completeQueryExecution).toHaveBeenCalledWith('execution-new');
		expect(activeExecutionId).toBe('');
	});

	it('pins the exact source execution and publishes comparison lineage from it after source current advances', async () => {
		const resultsState = await import('../../src/webview/core/results-state.js');
		const comparisonRun = {
			sourceBoxId: 'query_source', sourceExecutionId: 'source-execution-a', comparisonBoxId: 'query_comparison',
		};
		const sourceArtifactA = {
			artifactId: 'result:query_source:1', sourceBoxId: 'query_source', revision: 1, createdAt: 1,
			restored: false, columns: ['Value'], rows: [['a']], metadata: {},
			producer: {
				engine: 'kusto', boxId: 'query_source', executionId: 'source-execution-a',
				connectionId: 'connection-1', database: 'Samples',
			},
			policy: {
				accountPartition: 'partition-1', authSessionGeneration: 0, leaveNoTraceRevision: 0,
				connectionRevision: 0, connectionIdentityKey: 'cluster|authority',
			}, lineage: [],
		};
		const sourceArtifactB = {
			...sourceArtifactA,
			artifactId: 'result:query_source:2', revision: 2, rows: [['b']],
			producer: {
				engine: 'kusto', boxId: 'query_source', executionId: 'source-execution-b',
				connectionId: 'connection-1', database: 'Samples',
			},
		};
		const section = {
			getSchemaLifecycleIdentity: vi.fn(() => ({ sectionInstanceId: 'instance-1', targetGeneration: 1 })),
			getConnectionId: vi.fn(() => 'connection-1'),
			getDatabase: vi.fn(() => 'Samples'),
			beginQueryExecution: vi.fn(() => true),
			admitQueryTerminal: vi.fn(() => 'active'),
			completeQueryExecution: vi.fn(() => true),
		};
		mocks.getQuerySectionElement.mockReturnValue(section);
		handlerState.optimizationMetadataByBoxId.query_source = { comparisonBoxId: 'query_comparison' };
		handlerState.optimizationMetadataByBoxId.query_comparison = { sourceBoxId: 'query_source', isComparison: true };
		mocks.getResultArtifactByProducerExecution.mockReturnValue(sourceArtifactA);
		mocks.getBoundResultArtifact.mockReturnValue(sourceArtifactA);
		mocks.bindResultArtifactConsumer.mockReturnValue(sourceArtifactA.artifactId);
		vi.mocked(resultsState.getCurrentResultArtifact).mockReturnValue(sourceArtifactB as any);

		dispatchHostMessage({
			type: 'queryResult', engine: 'kusto', boxId: 'query_source', executionId: 'source-execution-a',
			sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples', producer: 'comparison', reservationSequence: 1,
			comparisonRun, dispatch: kustoDispatch('source-a'),
			result: { columns: ['Value'], rows: [['a']], metadata: {} },
		});

		expect(mocks.bindResultArtifactConsumer).toHaveBeenCalledWith(
			'comparison:query_comparison:source', 'query_source', sourceArtifactA.artifactId,
		);

		dispatchHostMessage({
			type: 'kustoExecutionStarted', engine: 'kusto', boxId: 'query_comparison', executionId: 'comparison-execution',
			sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples', producer: 'comparison', reservationSequence: 2,
			comparisonRun,
		});
		dispatchHostMessage({
			type: 'queryResult', engine: 'kusto', boxId: 'query_comparison', executionId: 'comparison-execution',
			sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples', producer: 'comparison', reservationSequence: 2,
			comparisonRun, dispatch: kustoDispatch('comparison'),
			result: { columns: ['Value'], rows: [['optimized']], metadata: {} },
		});

		expect(resultsState.displayResultForBox).toHaveBeenLastCalledWith(
			expect.anything(), 'query_comparison', expect.objectContaining({
				artifactPublication: expect.objectContaining({
					lineage: [{ sourceArtifactId: sourceArtifactA.artifactId, role: 'comparison-source' }],
				}),
			}),
		);
		expect(mocks.unbindResultArtifactConsumer).toHaveBeenCalledWith('comparison:query_comparison:source');
	});

	it('rejects comparison output when its exact source policy differs from dispatch', async () => {
		const resultsState = await import('../../src/webview/core/results-state.js');
		const comparisonRun = {
			sourceBoxId: 'query_source', sourceExecutionId: 'source-execution', comparisonBoxId: 'query_comparison',
		};
		const sourceArtifact = {
			artifactId: 'result:query_source:1', sourceBoxId: 'query_source', revision: 1, createdAt: 1,
			restored: false, columns: ['Value'], rows: [['a']], metadata: {},
			producer: {
				engine: 'kusto', boxId: 'query_source', executionId: 'source-execution',
				connectionId: 'connection-1', database: 'Samples',
			},
			policy: {
				accountPartition: 'different-partition', authSessionGeneration: 0, leaveNoTraceRevision: 0,
				connectionRevision: 0, connectionIdentityKey: 'cluster|authority',
			}, lineage: [],
		};
		mocks.getQuerySectionElement.mockReturnValue({
			admitQueryTerminal: vi.fn(() => 'active'), completeQueryExecution: vi.fn(() => true),
		});
		mocks.getBoundResultArtifact.mockReturnValue(sourceArtifact);
		vi.mocked(resultsState.displayResultForBox).mockClear();
		mocks.postMessageToHost.mockClear();

		dispatchHostMessage({
			type: 'queryResult', engine: 'kusto', boxId: 'query_comparison', executionId: 'comparison-execution',
			sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples', producer: 'comparison', reservationSequence: 2,
			comparisonRun, dispatch: kustoDispatch('comparison-policy-mismatch'),
			result: { columns: ['Value'], rows: [['optimized']], metadata: {} },
		});

		expect(resultsState.displayResultForBox).not.toHaveBeenCalled();
		expect(mocks.unbindResultArtifactConsumer).toHaveBeenCalledWith('comparison:query_comparison:source');
	});

	it('rejects a delayed Copilot start that crosses a newer manual preclaim', async () => {
		const executionModule = await vi.importActual<typeof import('../../src/webview/sections/query-execution.controller.js')>(
			'../../src/webview/sections/query-execution.controller.js',
		);
		const { section } = createSectionWithShell('query_crossed_start', {
			id: 'query_crossed_start', type: 'query', query: 'print marker="manual"',
		});
		const host = section as any;
		host.boxId = 'query_crossed_start';
		host.addController = vi.fn();
		host.requestUpdate = vi.fn();
		host.getConnectionId = vi.fn(() => 'connection-1');
		host.getDatabase = vi.fn(() => 'Db');
		host.getSchemaLifecycleIdentity = vi.fn(() => ({ sectionInstanceId: 'instance-crossed', targetGeneration: 1 }));
		const controller = new executionModule.QueryExecutionController(host);
		Object.assign(host, {
			beginQueryExecution: (executionId: string, producer?: any, copilotRequestId?: string, expectedPredecessorExecutionId?: string) =>
				controller.beginQueryExecution(executionId, producer, copilotRequestId, expectedPredecessorExecutionId),
			getActiveExecution: () => controller.getActiveExecution(),
			getSchemaLifecycleIdentity: () => ({ sectionInstanceId: 'instance-crossed', targetGeneration: 1 }),
		});
		mocks.getQuerySectionElement.mockImplementation((boxId: string) => boxId === host.boxId ? host : null);
		expect(host.beginQueryExecution('manual-current', 'manual')).toBe(true);
		mocks.postMessageToHost.mockClear();

		dispatchHostMessage({
			type: 'kustoExecutionStarted', engine: 'kusto', boxId: host.boxId,
			executionId: 'copilot-delayed', sectionInstanceId: 'instance-crossed', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Db', producer: 'copilot', reservationSequence: 1,
		});
		await Promise.resolve();

		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'kustoExecutionStartedAck', boxId: host.boxId, executionId: 'copilot-delayed',
			sectionInstanceId: 'instance-crossed', targetGeneration: 1, accepted: false,
		});
		expect(controller.getActiveExecution()).toEqual(expect.objectContaining({
			executionId: 'manual-current', producer: 'manual',
		}));
	});

	it('toolConfigureQuerySection acknowledges and consumes only its exact Kusto execution terminal', async () => {
		let activeExecutionId = 'execution-current';
		const owner = {
			engine: 'kusto' as const,
			boxId: 'query_1', executionId: 'execution-current',
			sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples', producer: 'tool' as const,
		};
		const section = {
			admitQueryTerminal: vi.fn((identity: { executionId: string }) => identity.executionId === activeExecutionId ? 'active' : 'rejected'),
			getActiveExecution: vi.fn(() => owner),
			acceptsQueryTerminal: vi.fn((executionId: string) => executionId === activeExecutionId),
			completeQueryExecution: vi.fn((executionId: string) => {
				if (executionId !== activeExecutionId) return false;
				activeExecutionId = '';
				return true;
			}),
		};
		mocks.getQuerySectionElement.mockReturnValue(section);
		mocks.getConnectionId.mockReturnValue('connection-1');
		mocks.getDatabase.mockReturnValue('Samples');
		mocks.executeQuery.mockReturnValue('execution-current');
		const resultArtifact = {
			artifactId: 'result:query_1:tool-current', sourceBoxId: 'query_1', revision: 1, createdAt: 1,
			restored: false, columns: ['Value'], rows: [['current']], metadata: {},
			producer: { engine: 'kusto', boxId: 'query_1', executionId: 'execution-current' },
			policy: { sendToModel: true }, lineage: [],
		};
		mocks.getResultArtifactByProducerExecution.mockReturnValue(resultArtifact);
		mocks.bindResultArtifactConsumer.mockReturnValue(resultArtifact.artifactId);
		mocks.getBoundResultArtifact.mockReturnValue(resultArtifact);
		mocks.postMessageToHost.mockClear();

		dispatchHostMessage({
			type: 'toolConfigureQuerySection', requestId: 'tool-query-1',
			input: { sectionId: 'query_1', execute: true },
		});
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolExecutionStarted', requestId: 'tool-query-1', owner,
		});
		mocks.postMessageToHost.mockClear();
		dispatchHostMessage({
			type: 'queryResult', engine: 'kusto', boxId: 'query_1', executionId: 'execution-stale',
			sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples', producer: 'tool', reservationSequence: 1,
			dispatch: kustoDispatch('tool-stale'),
			result: { columns: ['Value'], rows: [['stale']], metadata: {} },
		});
		expect(mocks.postMessageToHost).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'toolResponse', requestId: 'tool-query-1',
		}));

		dispatchHostMessage({
			type: 'queryResult', engine: 'kusto', boxId: 'query_1', executionId: 'execution-current',
			sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples', producer: 'tool', reservationSequence: 2,
			dispatch: kustoDispatch('tool-current'),
			result: { columns: ['Value'], rows: [['current']], metadata: {} },
		});

		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'toolResponse', requestId: 'tool-query-1',
			result: expect.objectContaining({ success: true, rowCount: 1 }),
		}));
		expect(mocks.bindResultArtifactConsumer).toHaveBeenCalledWith(
			'model:tool-query-1:result', 'query_1', resultArtifact.artifactId,
		);
		expect(mocks.unbindResultArtifactConsumer).toHaveBeenCalledWith('model:tool-query-1:result');
	});

	it('toolConfigureQuerySection denies model preview when the exact artifact disallows model use', async () => {
		const owner = {
			engine: 'kusto' as const,
			boxId: 'query_1', executionId: 'execution-denied',
			sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples', producer: 'tool' as const,
		};
		mocks.getQuerySectionElement.mockReturnValue({
			admitQueryTerminal: vi.fn(() => 'active'), getActiveExecution: vi.fn(() => owner),
			completeQueryExecution: vi.fn(() => true),
		});
		mocks.getConnectionId.mockReturnValue('connection-1');
		mocks.getDatabase.mockReturnValue('Samples');
		mocks.executeQuery.mockReturnValue('execution-denied');
		const artifact = {
			artifactId: 'result:query_1:denied', sourceBoxId: 'query_1', revision: 1, createdAt: 1,
			restored: false, columns: ['Secret'], rows: [['classified']], metadata: {},
			producer: { engine: 'kusto', boxId: 'query_1', executionId: 'execution-denied' },
			policy: { sendToModel: false }, lineage: [],
		};
		mocks.getResultArtifactByProducerExecution.mockReturnValue(artifact);
		mocks.bindResultArtifactConsumer.mockReturnValue(artifact.artifactId);
		mocks.getBoundResultArtifact.mockReturnValue(artifact);
		mocks.postMessageToHost.mockClear();

		dispatchHostMessage({
			type: 'toolConfigureQuerySection', requestId: 'tool-query-denied',
			input: { sectionId: 'query_1', execute: true },
		});
		dispatchHostMessage({
			type: 'queryResult', engine: 'kusto', boxId: 'query_1', executionId: 'execution-denied',
			sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples', producer: 'tool', reservationSequence: 1,
			dispatch: kustoDispatch('tool-denied'), result: { columns: ['Secret'], rows: [['classified']], metadata: {} },
		});

		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolResponse', requestId: 'tool-query-denied',
			result: { success: false, error: 'Query results are not permitted for model use.' },
		});
		expect(mocks.unbindResultArtifactConsumer).toHaveBeenCalledWith('model:tool-query-denied:result');
	});

	it('toolConfigureQuerySection settles when executeQuery throws after response deferral starts', async () => {
		mocks.getConnectionId.mockReturnValue('connection-1');
		mocks.getDatabase.mockReturnValue('Samples');
		mocks.executeQuery.mockImplementationOnce(() => { throw new Error('synthetic execution failure'); });
		mocks.postMessageToHost.mockClear();

		dispatchHostMessage({
			type: 'toolConfigureQuerySection', requestId: 'tool-query-throws',
			input: { sectionId: 'query_1', execute: true },
		});

		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolResponse', requestId: 'tool-query-throws',
			result: { success: false, error: 'synthetic execution failure' },
		});
		expect(mocks.unbindResultArtifactConsumer).toHaveBeenCalledWith('model:tool-query-throws:result');
	});

	it('toolConfigureQuerySection settles and cleans up when cancellation has no terminal', async () => {
		const owner = {
			engine: 'kusto' as const,
			boxId: 'query_1', executionId: 'execution-cancelled',
			sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples', producer: 'tool' as const,
		};
		mocks.getQuerySectionElement.mockReturnValue({ getActiveExecution: vi.fn(() => owner) });
		mocks.getConnectionId.mockReturnValue('connection-1');
		mocks.getDatabase.mockReturnValue('Samples');
		mocks.executeQuery.mockReturnValue('execution-cancelled');
		const cancelQuery = vi.fn();
		(window as any).cancelQuery = cancelQuery;
		mocks.postMessageToHost.mockClear();

		dispatchHostMessage({
			type: 'toolConfigureQuerySection', requestId: 'tool-query-cancelled',
			input: { sectionId: 'query_1', execute: true },
		});
		dispatchHostMessage({ type: 'toolCancelKustoExecution', requestId: 'tool-query-cancelled', owner });
		delete (window as any).cancelQuery;

		expect(cancelQuery).toHaveBeenCalledWith('query_1');
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolResponse', requestId: 'tool-query-cancelled',
			result: { success: false, error: 'Query was cancelled' },
		});
		expect(mocks.unbindResultArtifactConsumer).toHaveBeenCalledWith('model:tool-query-cancelled:result');
	});

	it('toolConfigureQuerySection consumes pre-start cancellation and ignores a late terminal', async () => {
		const owner = {
			engine: 'kusto' as const,
			boxId: 'query_1', executionId: 'execution-pre-cancelled',
			sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples', producer: 'tool' as const,
		};
		mocks.getQuerySectionElement.mockReturnValue({
			getActiveExecution: vi.fn(() => owner), admitQueryTerminal: vi.fn(() => 'active'),
			completeQueryExecution: vi.fn(() => true),
		});
		mocks.getConnectionId.mockReturnValue('connection-1');
		mocks.getDatabase.mockReturnValue('Samples');
		mocks.executeQuery.mockReturnValue('execution-pre-cancelled');
		const cancelQuery = vi.fn();
		(window as any).cancelQuery = cancelQuery;

		dispatchHostMessage({ type: 'toolCancelKustoExecution', requestId: 'tool-query-pre-cancelled' });
		mocks.postMessageToHost.mockClear();
		dispatchHostMessage({
			type: 'toolConfigureQuerySection', requestId: 'tool-query-pre-cancelled',
			input: { sectionId: 'query_1', execute: true },
		});
		const immediateResponses = mocks.postMessageToHost.mock.calls
			.map(([message]) => message as any)
			.filter(message => message.type === 'toolResponse' && message.requestId === 'tool-query-pre-cancelled');
		expect(immediateResponses).toEqual([{
			type: 'toolResponse', requestId: 'tool-query-pre-cancelled',
			result: { success: false, error: 'Query was cancelled' },
		}]);
		dispatchHostMessage({
			type: 'queryCancelled', engine: 'kusto', boxId: 'query_1', executionId: 'execution-pre-cancelled',
			sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples', producer: 'tool', reservationSequence: 1,
			reason: 'cancelled',
		});
		delete (window as any).cancelQuery;

		expect(cancelQuery).toHaveBeenCalledWith('query_1');
		const responses = mocks.postMessageToHost.mock.calls
			.map(([message]) => message as any)
			.filter(message => message.type === 'toolResponse' && message.requestId === 'tool-query-pre-cancelled');
		expect(responses).toEqual([{
			type: 'toolResponse', requestId: 'tool-query-pre-cancelled',
			result: { success: false, error: 'Query was cancelled' },
		}]);
		expect(mocks.unbindResultArtifactConsumer).toHaveBeenCalledWith('model:tool-query-pre-cancelled:result');
	});

	it('toolConfigureQuerySection settles when its terminal artifact lookup throws', async () => {
		const owner = {
			engine: 'kusto' as const,
			boxId: 'query_1', executionId: 'execution-lookup-throws',
			sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples', producer: 'tool' as const,
		};
		mocks.getQuerySectionElement.mockReturnValue({
			admitQueryTerminal: vi.fn(() => 'active'), getActiveExecution: vi.fn(() => owner),
			completeQueryExecution: vi.fn(() => true),
		});
		mocks.getConnectionId.mockReturnValue('connection-1');
		mocks.getDatabase.mockReturnValue('Samples');
		mocks.executeQuery.mockReturnValue('execution-lookup-throws');
		mocks.getResultArtifactByProducerExecution.mockImplementationOnce(() => {
			throw new Error('synthetic artifact lookup failure');
		});
		mocks.postMessageToHost.mockClear();

		dispatchHostMessage({
			type: 'toolConfigureQuerySection', requestId: 'tool-query-lookup-throws',
			input: { sectionId: 'query_1', execute: true },
		});
		dispatchHostMessage({
			type: 'queryResult', engine: 'kusto', boxId: 'query_1', executionId: 'execution-lookup-throws',
			sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples', producer: 'tool', reservationSequence: 1,
			dispatch: kustoDispatch('tool-lookup-throws'), result: { columns: ['Value'], rows: [[1]], metadata: {} },
		});

		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolResponse', requestId: 'tool-query-lookup-throws',
			result: { success: false, error: 'synthetic artifact lookup failure' },
		});
		expect(mocks.unbindResultArtifactConsumer).toHaveBeenCalledWith('model:tool-query-lookup-throws:result');
	});

	it('explicitly rejects cluster-only Kusto retarget and execute before any mutation or run claim', async () => {
		const sectionFactory = await import('../../src/webview/core/section-factory.js');
		const setValue = vi.fn();
		handlerState.queryEditors.query_1 = { setValue };
		mocks.executeQuery.mockClear();
		mocks.postMessageToHost.mockClear();

		dispatchHostMessage({
			type: 'toolConfigureQuerySection', requestId: 'tool-cluster-only-execute',
			input: {
				sectionId: 'query_1', clusterUrl: 'https://cluster.kusto.windows.net',
				connectionId: 'connection-1', query: 'print should_not_apply=1', name: 'Rejected', execute: true,
			},
		});

		expect(mocks.executeQuery).not.toHaveBeenCalled();
		expect(setValue).not.toHaveBeenCalled();
		expect(sectionFactory.__kustoSetSectionName).not.toHaveBeenCalledWith('query_1', 'Rejected');
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolResponse', requestId: 'tool-cluster-only-execute',
			result: { success: false, resultPreview: '' },
			error: 'database is required when retargeting and executing a Kusto query section.',
		});
	});

	it('rejects configure-and-execute on an unconfigured section before query or name mutation', async () => {
		const sectionFactory = await import('../../src/webview/core/section-factory.js');
		const setValue = vi.fn();
		handlerState.queryEditors.query_unconfigured = { setValue };
		mocks.getConnectionId.mockReturnValue('');
		mocks.getDatabase.mockReturnValue('');
		mocks.executeQuery.mockClear();
		mocks.postMessageToHost.mockClear();

		dispatchHostMessage({
			type: 'toolConfigureQuerySection', requestId: 'tool-unconfigured-execute',
			input: {
				sectionId: 'query_unconfigured', name: 'Should not apply',
				query: 'print should_not_apply=1', execute: true,
			},
		});

		expect(setValue).not.toHaveBeenCalled();
		expect(sectionFactory.__kustoSetSectionName).not.toHaveBeenCalledWith('query_unconfigured', 'Should not apply');
		expect(mocks.executeQuery).not.toHaveBeenCalled();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolResponse', requestId: 'tool-unconfigured-execute',
			result: { success: false, resultPreview: '' },
			error: 'A cluster connection and database are required before executing a Kusto query section.',
		});
	});

	it('settles an exact tool cancellation after its section is removed without rendering it', async () => {
		const resultsState = await import('../../src/webview/core/results-state.js');
		const persistence = await import('../../src/webview/core/persistence.js');
		const owner = {
			engine: 'kusto' as const,
			boxId: 'query_removed', executionId: 'execution-removed',
			sectionInstanceId: 'instance-removed', targetGeneration: 3,
			connectionId: 'connection-1', database: 'Samples', producer: 'tool' as const,
		};
		mocks.getQuerySectionElement.mockReturnValue({ getActiveExecution: vi.fn(() => owner) });
		mocks.getConnectionId.mockReturnValue(owner.connectionId);
		mocks.getDatabase.mockReturnValue(owner.database);
		mocks.executeQuery.mockReturnValue(owner.executionId);
		mocks.postMessageToHost.mockClear();

		dispatchHostMessage({
			type: 'toolConfigureQuerySection', requestId: 'tool-query-removed',
			input: { sectionId: owner.boxId, execute: true },
		});
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolExecutionStarted', requestId: 'tool-query-removed', owner,
		});

		mocks.postMessageToHost.mockClear();
		mocks.getQuerySectionElement.mockReturnValue(null);
		vi.mocked(resultsState.displayResultForBox).mockClear();
		vi.mocked(persistence.__kustoOnQueryResult).mockClear();
		dispatchHostMessage({
			type: 'queryCancelled', ...owner, reservationSequence: 9, reason: 'retired',
		});

		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolResponse', requestId: 'tool-query-removed',
			result: { success: false, error: 'Query was cancelled' },
		});
		expect(resultsState.displayResultForBox).not.toHaveBeenCalled();
		expect(persistence.__kustoOnQueryResult).not.toHaveBeenCalled();
		expect(mocks.setQueryExecuting).not.toHaveBeenCalled();
	});

	it('settles an exact old tool terminal after same-ID section recreation without rendering it', async () => {
		const resultsState = await import('../../src/webview/core/results-state.js');
		const persistence = await import('../../src/webview/core/persistence.js');
		const owner = {
			engine: 'kusto' as const,
			boxId: 'query_recreated', executionId: 'execution-old-incarnation',
			sectionInstanceId: 'instance-old', targetGeneration: 2,
			connectionId: 'connection-1', database: 'Samples', producer: 'tool' as const,
		};
		mocks.getQuerySectionElement.mockReturnValue({ getActiveExecution: vi.fn(() => owner) });
		mocks.getConnectionId.mockReturnValue(owner.connectionId);
		mocks.getDatabase.mockReturnValue(owner.database);
		mocks.executeQuery.mockReturnValue(owner.executionId);
		dispatchHostMessage({
			type: 'toolConfigureQuerySection', requestId: 'tool-query-recreated',
			input: { sectionId: owner.boxId, execute: true },
		});

		mocks.postMessageToHost.mockClear();
		mocks.getQuerySectionElement.mockReturnValue({
			admitQueryTerminal: vi.fn(() => 'rejected'),
			completeQueryExecution: vi.fn(),
		});
		mocks.getSqlSectionElement.mockReturnValue({ boxId: owner.boxId });
		mocks.getSqlSectionElement.mockClear();
		vi.mocked(resultsState.displayResultForBox).mockClear();
		vi.mocked(persistence.__kustoOnQueryResult).mockClear();
		dispatchHostMessage({
			type: 'queryCancelled', ...owner, reservationSequence: 7, reason: 'retired',
		});

		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolResponse', requestId: 'tool-query-recreated',
			result: { success: false, error: 'Query was cancelled' },
		});
		expect(resultsState.displayResultForBox).not.toHaveBeenCalled();
		expect(persistence.__kustoOnQueryResult).not.toHaveBeenCalled();
		expect(mocks.setQueryExecuting).not.toHaveBeenCalled();
		expect(mocks.getSqlSectionElement).not.toHaveBeenCalled();
	});

	it('settles a retired tool result as row-free cancellation', async () => {
		const owner = {
			engine: 'kusto' as const,
			boxId: 'query_retired', executionId: 'execution-retired',
			sectionInstanceId: 'instance-retired', targetGeneration: 2,
			connectionId: 'connection-a', database: 'DbA', producer: 'tool' as const,
		};
		mocks.getQuerySectionElement.mockReturnValue({
			getActiveExecution: vi.fn(() => owner),
			admitQueryTerminal: vi.fn(() => 'retired'),
		});
		mocks.getConnectionId.mockReturnValue(owner.connectionId);
		mocks.getDatabase.mockReturnValue(owner.database);
		mocks.executeQuery.mockReturnValue(owner.executionId);

		dispatchHostMessage({
			type: 'toolConfigureQuerySection', requestId: 'tool-retired-result',
			input: { sectionId: owner.boxId, execute: true },
		});
		mocks.postMessageToHost.mockClear();
		dispatchHostMessage({
			type: 'queryResult', ...owner, reservationSequence: 4,
			dispatch: kustoDispatch('retired-result'),
			result: { columns: ['Secret'], rows: [['OLD_TARGET_ROW']], metadata: {} },
		});

		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolResponse', requestId: 'tool-retired-result',
			result: { success: false, error: 'Query was cancelled' },
		});
		expect(JSON.stringify(mocks.postMessageToHost.mock.calls)).not.toContain('OLD_TARGET_ROW');
	});

	it('rejects queued Kusto Copilot output after same-ID section recreation', () => {
		const oldOwner = {
			boxId: 'query_1', copilotRequestId: 'copilot-old', sectionInstanceId: 'instance-old', targetGeneration: 1,
		};
		const newOwner = {
			boxId: 'query_1', copilotRequestId: 'copilot-new', sectionInstanceId: 'instance-new', targetGeneration: 0,
		};
		const section = {
			admitKustoCopilotMessage: vi.fn((message: Record<string, unknown>) =>
				message.copilotRequestId === newOwner.copilotRequestId
				&& message.sectionInstanceId === newOwner.sectionInstanceId
				&& message.targetGeneration === newOwner.targetGeneration),
			copilotWriteQuerySetQuery: vi.fn(),
		};
		mocks.getQuerySectionElement.mockReturnValue(section);

		dispatchHostMessage({
			type: 'copilotWriteQuerySetQuery', boxId: 'query_recreated', query: 'print stale=1', ...oldOwner,
		});
		dispatchHostMessage({
			type: 'copilotWriteQuerySetQuery', boxId: 'query_recreated', query: 'print current=1', ...newOwner,
		});

		expect(section.copilotWriteQuerySetQuery).toHaveBeenCalledOnce();
		expect(section.copilotWriteQuerySetQuery).toHaveBeenCalledWith('print current=1');
	});

	it('rejects direct Copilot publication when the result card cannot be applied', async () => {
		const owner = { boxId: 'query_1', copilotRequestId: 'copilot-apply-failure', sectionInstanceId: 'instance-current', targetGeneration: 1 };
		mocks.getQuerySectionElement.mockReturnValue({
			admitKustoCopilotMessage: vi.fn(() => true),
			copilotAppendExecutedQuery: vi.fn(() => { throw new Error('render failed'); }),
		});
		mocks.postMessageToHost.mockClear();

		dispatchHostMessage({
			type: 'kustoPublicationStage', publicationId: 'copilot-failed-publication', publicationDeadline: Date.now() + 1000,
			payload: {
				type: 'copilotExecutedQuery', ...owner, entryId: 'entry', query: 'print 1', resultSummary: '1 row',
				result: { columns: ['x'], rows: [[1]], metadata: {} },
			},
		});
		dispatchHostMessage({ type: 'kustoPublicationCommit', publicationId: 'copilot-failed-publication' });
		await Promise.resolve();

		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'kustoPublicationAck', publicationId: 'copilot-failed-publication', phase: 'applied', accepted: false,
		});
	});

	it('preserves one exact identity from the real controller through provider dispatch and window admission', async () => {
		const executionModule = await vi.importActual<typeof import('../../src/webview/sections/query-execution.controller.js')>(
			'../../src/webview/sections/query-execution.controller.js',
		);
		const { QueryEditorProvider } = await import('../../src/host/queryEditorProvider.js');
		const { HostKustoSectionExecutionApplicationHandler } = await import(
			'../../src/host/kustoSectionExecutionApplicationHandler.js'
		);
		const { getKustoConnectionIdentityKey } = await import('../../src/shared/kustoAuth.js');
		const { normalizeControlCommandForExecution } = await import('../../src/host/queryEditorUtils.js');
		const resultsState = await import('../../src/webview/core/results-state.js');
		const persistence = await import('../../src/webview/core/persistence.js');
		const boxId = 'query_cross_layer';
		const lifecycle = { sectionInstanceId: 'instance-cross-layer', targetGeneration: 2 };
		const connection = {
			id: 'connection-cross-layer', name: 'Cross layer', clusterUrl: 'https://cross-layer.kusto.windows.net',
		};
		const connectionIdentityKey = getKustoConnectionIdentityKey(connection.clusterUrl);
		const { section } = createSectionWithShell(boxId, { id: boxId, type: 'query', query: 'print Value=42' });
		const host = section as any;
		host.boxId = boxId;
		host.addController = vi.fn();
		host.requestUpdate = vi.fn();
		host.getConnectionId = vi.fn(() => connection.id);
		host.getDatabase = vi.fn(() => 'Samples');
		host.getSchemaLifecycleIdentity = vi.fn(() => lifecycle);
		host._testExecuting = false;
		const controller = new executionModule.QueryExecutionController(host);
		host.beginQueryExecution = (executionId: string, producer?: any) => controller.beginQueryExecution(executionId, producer);
		host.getActiveExecution = () => controller.getActiveExecution();
		host.getActiveExecutionId = () => controller.getActiveExecutionId();
		host.admitQueryTerminal = (identity: any) => controller.admitQueryTerminal(identity);
		host.acceptsQueryTerminal = (executionId: string) => controller.acceptsQueryTerminal(executionId);
		host.completeQueryExecution = (executionId: string) => controller.completeQueryExecution(executionId);
		mocks.getQuerySectionElement.mockImplementation((candidate: string) => candidate === boxId ? host : null);
		mocks.getConnectionId.mockImplementation((candidate: string) => candidate === boxId ? connection.id : '');
		mocks.getDatabase.mockImplementation((candidate: string) => candidate === boxId ? 'Samples' : '');
		handlerState.queryBoxes.push(boxId);
		handlerState.queryEditors[boxId] = { getValue: vi.fn(() => 'print Value=42') };
		(handlerState.pState as any).queryResultJsonByBoxId = {};
		createQueryCacheControls(boxId);
		mocks.postMessageToHost.mockClear();

		const executionId = executionModule.executeQuery(boxId, 'plain');
		const outbound = mocks.postMessageToHost.mock.calls
			.map(([message]) => message as any)
			.find(message => message.type === 'executeQuery');
		expect(executionId).toMatch(/^kusto-run-/);
		expect(outbound).toMatchObject({
			type: 'executeQuery', boxId, executionId,
			...lifecycle, connectionId: connection.id, database: 'Samples', producer: 'manual',
		});

		const provider = Object.create(QueryEditorProvider.prototype) as any;
		provider.refreshConnectionsData = vi.fn(async () => undefined);
		provider.connectionManager = {
			getConnections: vi.fn(() => [connection]),
			getConnectionIncarnation: vi.fn(() => 0),
			getLeaveNoTraceRevision: vi.fn(() => 0),
			admitLeaveNoTraceRevision: vi.fn(async (_clusterUrl: string, expectedGeneration: number, admit: () => unknown) =>
				expectedGeneration === 0 ? { admitted: true, value: admit() } : { admitted: false }),
		};
		provider.connection = {
			saveLastSelection: vi.fn(async () => undefined),
			findConnection: vi.fn(() => connection),
		};
		const result = {
			columns: ['Value'], rows: [[42]],
			metadata: { cluster: connection.clusterUrl, database: 'Samples', executionTime: '0.001s' },
		};
		provider.kustoClient = {
			executeQueryCancelable: vi.fn((_connection: unknown, _database: string, _query: string, _key: string, options: any) => {
				options.onDispatch({
					dispatchAttempt: 1, connectionRevision: 0, leaveNoTraceRevision: 0,
					connectionIdentityKey, clusterEndpoint: connection.clusterUrl,
					accountPartition: 'partition-cross-layer', authSessionGeneration: 0, clientActivityId: 'KW.execute_query;cross-layer',
				});
				return {
					promise: Promise.resolve(result), cancel: vi.fn(), clientActivityId: 'KW.execute_query;cross-layer',
					getAccountPartition: () => 'partition-cross-layer',
				};
			}),
			getAccountPartition: vi.fn(() => 'partition-cross-layer'),
			getConnectionSessionGeneration: vi.fn(() => 0),
			waitForProviderAccountRefresh: vi.fn(async () => undefined),
		};
		provider.appendQueryMode = vi.fn((query: string) => query);
		provider.isControlCommand = vi.fn(() => false);
		provider.normalizeControlCommandForExecution = vi.fn((query: string) => normalizeControlCommandForExecution(query));
		provider.buildCacheDirective = vi.fn(() => '');
		provider.logQueryExecutionError = vi.fn();
		provider.formatQueryExecutionErrorForUser = vi.fn((error: unknown) => String(error));
		provider.output = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), show: vi.fn() };
		let handledAckCalls = mocks.postMessageToHost.mock.calls.length;
		provider.postMessage = vi.fn(async (message: Record<string, unknown>) => {
			dispatchHostMessage(message);
			const newCalls = mocks.postMessageToHost.mock.calls.slice(handledAckCalls);
			handledAckCalls = mocks.postMessageToHost.mock.calls.length;
			for (const [ack] of newCalls) {
				if ((ack as any)?.type === 'kustoPublicationAck') await provider.handleWebviewMessage(ack as any);
			}
			return true;
		});
		provider.kustoSectionExecutionApplication = new HostKustoSectionExecutionApplicationHandler({
			coordinator: provider.kustoExecutionCoordinator,
			kustoClient: provider.kustoClient,
			connection: provider.connection,
			connectionManager: provider.connectionManager,
			postMessage: (message: unknown) => provider.postMessage(message),
			refreshConnectionsData: () => provider.refreshConnectionsData(),
			cancelKustoCopilotSection: () => undefined,
			getErrorMessage: (error: unknown) => provider.getErrorMessage(error),
			formatQueryExecutionErrorForUser: (error: unknown, targetConnection: any, database?: string) =>
				provider.formatQueryExecutionErrorForUser(error, targetConnection, database),
			logQueryExecutionError: (error: unknown, targetConnection: any, database: string | undefined, targetBoxId: string, query: string) =>
				provider.logQueryExecutionError(error, targetConnection, database, targetBoxId, query),
			appendQueryMode: (query: string, queryMode?: string) => provider.appendQueryMode(query, queryMode),
			isControlCommand: (query: string) => provider.isControlCommand(query),
			normalizeControlCommandForExecution: (query: string) => provider.normalizeControlCommandForExecution(query),
			buildCacheDirective: (enabled?: boolean, value?: number, unit?: string) =>
				provider.buildCacheDirective(enabled, value, unit),
			showErrorMessage: () => undefined,
			isDisposed: () => false,
			createPublicationId: () => 'cross-layer',
			now: () => Date.now(),
		});
		provider.kustoExecutionCoordinator.openSection(boxId, lifecycle.sectionInstanceId);
		provider.kustoExecutionCoordinator.adoptTarget({
			boxId, ...lifecycle, connectionId: connection.id, database: 'Samples',
			connectionRevision: 0,
			connectionIdentityKey,
		});
		vi.mocked(resultsState.displayResultForBox).mockClear();
		vi.mocked(persistence.__kustoOnQueryResult).mockClear();

		await provider.handleWebviewMessage(outbound);
		await vi.waitFor(() => expect(persistence.__kustoOnQueryResult).toHaveBeenCalledWith(
			boxId, result, expect.objectContaining({ clientActivityId: 'KW.execute_query;cross-layer' }),
		));

		const stagedPublication = provider.postMessage.mock.calls
			.map((call: unknown[]) => call[0] as any)
			.find((message: any) => message?.type === 'kustoPublicationStage');
		expect(stagedPublication?.payload).toEqual(expect.objectContaining({
			type: 'queryResult', boxId, executionId, ...lifecycle,
			dispatch: expect.objectContaining({ clientActivityId: 'KW.execute_query;cross-layer' }),
		}));
		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'kustoPublicationCommit', publicationId: stagedPublication.publicationId,
		});
		expect(resultsState.displayResultForBox).toHaveBeenCalledWith(result, boxId, expect.objectContaining({
			label: 'Results', showExecutionTime: true, executionId,
			artifactPublication: expect.objectContaining({
				producer: expect.objectContaining({
					engine: 'kusto', boxId, executionId, ...lifecycle,
					dispatch: expect.objectContaining({ clientActivityId: 'KW.execute_query;cross-layer' }),
				}),
				policy: expect.objectContaining({
					accountPartition: 'partition-cross-layer', leaveNoTraceRevision: 0,
				}),
			}),
		}));
		expect(controller.getActiveExecution()).toBeUndefined();
		controller.setQueryExecuting(false);
	}, 10_000);

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

	it('preserves SQL comparison metadata across SQL connection refresh', async () => {
		const source = createFakeSqlSection();
		const comparison = createFakeSqlSection();
		(source as any).getConnectionId = vi.fn(() => 'sql_conn_1');
		(comparison as any).getConnectionId = vi.fn(() => 'sql_conn_1');
		(source as any).setLeaveNoTraceConnectionIds = vi.fn();
		(comparison as any).setLeaveNoTraceConnectionIds = vi.fn();
		handlerState.sqlBoxes.push('sql_source', 'sql_comparison');
		handlerState.optimizationMetadataByBoxId.sql_source = { comparisonBoxId: 'sql_comparison' };
		handlerState.optimizationMetadataByBoxId.sql_comparison = {
			sourceBoxId: 'sql_source', isComparison: true,
		};
		mocks.getSqlSectionElement.mockImplementation((boxId: string) => ({
			sql_source: source, sql_comparison: comparison,
		} as Record<string, FakeSqlSection>)[boxId] || null);
		mocks.getQuerySectionElement.mockReturnValue(null);

		dispatchHostMessage({
			type: 'sqlConnectionsData',
			connections: [{ id: 'sql_conn_1', serverUrl: 'sql.example.test' }],
			sqlLeaveNoTrace: [],
		});
		await Promise.resolve();

		expect(handlerState.optimizationMetadataByBoxId.sql_source).toEqual({ comparisonBoxId: 'sql_comparison' });
		expect(handlerState.optimizationMetadataByBoxId.sql_comparison).toEqual({
			sourceBoxId: 'sql_source', isComparison: true,
		});
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

	it('rejects uncorrelated sqlDatabasesData and sqlDatabasesError', async () => {
		const sqlEl = createFakeSqlSection();
		mocks.getSqlSectionElement.mockReturnValue(sqlEl);
		dispatchHostMessage({ type: 'sqlDatabasesData', boxId: 'sql_1', sectionInstanceId: sqlEl.sqlSession.instanceId, databases: ['B', 'A'], sqlConnectionId: 'sql_conn_1' });
		dispatchHostMessage({ type: 'sqlDatabasesError', boxId: 'sql_1', sectionInstanceId: sqlEl.sqlSession.instanceId, error: 'failed', sqlConnectionId: 'sql_conn_1' });
		await Promise.resolve();

		expect(mocks.updateSqlDatabaseSelect).not.toHaveBeenCalled();
		expect(mocks.onSqlDatabasesError).not.toHaveBeenCalled();
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

		expect(handlerState.sqlSchemaByBoxId.sql_1).toBe(schema);
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

	it('preserves SQL schema when Kusto authentication identity changes', () => {
		handlerState.schemaByBoxId.query_1 = { tables: ['KustoEvents'] };
		handlerState.sqlSchemaByBoxId.sql_1 = { tables: ['SqlEvents'] };

		dispatchHostMessage({ type: 'kustoAuthIdentityChanged', connectionIds: [], reason: 'sessions-changed' });

		expect(handlerState.schemaByBoxId.query_1).toBeUndefined();
		expect(handlerState.sqlSchemaByBoxId.sql_1).toEqual({ tables: ['SqlEvents'] });
	});

	it('cancels affected synthetic requests when Kusto identity changes', async () => {
		const request = kustoSyntheticDatabaseRequests.begin('__kusto_dbreq__active', {
			connectionId: 'c1', accountPartition: 'partition-1', connectionIdentity: 'cluster|common',
		});
		const rejection = expect(request).rejects.toThrow('invalidated by authentication change');

		dispatchHostMessage({ type: 'kustoAuthIdentityChanged', connectionIds: ['c1'], reason: 'sessions-changed' });

		await rejection;
		expect(kustoSyntheticDatabaseRequests.hasActive('__kusto_dbreq__active')).toBe(false);
	});

	it('preserves unrelated Kusto catalogs during targeted identity invalidation', () => {
		mocks.getConnectionId.mockImplementation(boxId => boxId === 'query_a' ? 'c1' : 'c2');
		const first = kustoEditorSchemaCoordinator.openSection('query_a', 'instance-a')!;
		kustoEditorSchemaCoordinator.setTarget(first, 'c1', 'DbA');
		kustoEditorSchemaCoordinator.setOwnedState('query_a', 'schema', { tables: ['A'] });
		const second = kustoEditorSchemaCoordinator.openSection('query_b', 'instance-b')!;
		kustoEditorSchemaCoordinator.setTarget(second, 'c2', 'DbB');
		kustoEditorSchemaCoordinator.setOwnedState('query_b', 'schema', { tables: ['B'] });
		handlerState.schemaByConnDb['v1|c1|partition|cluster|dba'] = { tables: ['A'] };
		handlerState.schemaMetaByConnDb['v1|c1|partition|cluster|dba'] = { connectionId: 'c1' };
		handlerState.schemaByConnDb['v1|c2|partition|cluster|dbb'] = { tables: ['B'] };
		handlerState.schemaMetaByConnDb['v1|c2|partition|cluster|dbb'] = { connectionId: 'c2' };

		dispatchHostMessage({ type: 'kustoAuthIdentityChanged', connectionIds: ['c1'], reason: 'sessions-changed' });

		expect(kustoEditorSchemaCoordinator.getOwnedState('query_a', 'schema')).toBeUndefined();
		expect(kustoEditorSchemaCoordinator.getOwnedState('query_b', 'schema')).toEqual({ tables: ['B'] });
		expect(handlerState.schemaByConnDb['v1|c1|partition|cluster|dba']).toBeUndefined();
		expect(handlerState.schemaByConnDb['v1|c2|partition|cluster|dbb']).toEqual({ tables: ['B'] });
	});

	it('invalidates a registered Kusto section before its Monaco editor exists', async () => {
		const state = await import('../../src/webview/core/state.js');
		const section = {
			setDatabasesLoading: vi.fn(), setRefreshLoading: vi.fn(), clearResults: vi.fn(), getCopilotChatEl: vi.fn(),
		};
		mocks.getQuerySectionElement.mockReturnValue(section);
		mocks.getConnectionId.mockReturnValue('c1');
		const lease = kustoEditorSchemaCoordinator.openSection('query_restored', 'instance-restored')!;
		const before = kustoEditorSchemaCoordinator.setTarget(lease, 'c1', 'Samples')!;
		kustoEditorSchemaCoordinator.beginSchemaRequest(lease, 'schema-restored');
		handlerState.schemaRequestTokenByBoxId.query_restored = 'schema-restored';
		state.databaseRequestTokenByBoxId.query_restored = 'databases-restored';
		state.beginKustoPreparation('query_restored', { stage: 'ready', blockers: [], target: { connectionId: 'c1', database: 'Samples' } });

		dispatchHostMessage({ type: 'kustoAuthIdentityChanged', connectionIds: ['c1'], reason: 'sessions-changed' });

		const after = kustoEditorSchemaCoordinator.getIdentity('query_restored')!;
		expect(after.targetGeneration).toBeGreaterThan(before.targetGeneration);
		expect(kustoEditorSchemaCoordinator.getSchemaRequestToken('query_restored')).toBeUndefined();
		expect(handlerState.schemaRequestTokenByBoxId.query_restored).toBeUndefined();
		expect(state.databaseRequestTokenByBoxId.query_restored).toBeUndefined();
		expect(state.getKustoPreparationState('query_restored').status).toBe('idle');
		expect(section.setDatabasesLoading).toHaveBeenCalledWith(false);
		expect(section.setRefreshLoading).toHaveBeenCalledWith(false);
	});

	it('clears only SQL schema when Leave No Trace protects its connection', () => {
		handlerState.schemaByBoxId.query_1 = { tables: ['KustoEvents'] };
		handlerState.sqlSchemaByBoxId.sql_1 = { tables: ['SqlEvents'] };
		const sqlEl = createFakeSqlSection() as FakeSqlSection & { getConnectionId: () => string; clearSchemaForLeaveNoTrace: ReturnType<typeof vi.fn> };
		sqlEl.getConnectionId = () => 'sql-sensitive';
		sqlEl.clearSchemaForLeaveNoTrace = vi.fn(() => { delete handlerState.sqlSchemaByBoxId.sql_1; });
		mocks.getSqlSectionElement.mockImplementation(boxId => boxId === 'sql_1' ? sqlEl : null);
		handlerState.sqlBoxes.push('sql_1');

		dispatchHostMessage({ type: 'sqlLeaveNoTraceData', connectionIds: ['sql-sensitive'] });

		expect(handlerState.sqlSchemaByBoxId.sql_1).toBeUndefined();
		expect(handlerState.schemaByBoxId.query_1).toEqual({ tables: ['KustoEvents'] });
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
		expect(sqlEl.invalidateOwner).toHaveBeenCalledWith(false);
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

	it('rejects background worker completion after same-ID section recreation', async () => {
		const state = await import('../../src/webview/core/state.js');
		const clusterUrl = 'https://cluster.kusto.windows.net';
		const database = 'Samples';
		handlerState.activeQueryEditorBoxId = 'query_1';
		handlerState.queryBoxes.push('query_1');
		handlerState.connections.push({ id: 'c1', clusterUrl, accountPartition: 'partition-1' });
		mocks.getConnectionId.mockReturnValue('c1');
		mocks.getClusterUrl.mockReturnValue(clusterUrl);
		mocks.getDatabase.mockReturnValue(database);
		const oldLease = kustoEditorSchemaCoordinator.openSection('query_1', 'instance-old')!;
		const identity = kustoEditorSchemaCoordinator.setTarget(oldLease, 'c1', database)!;
		kustoEditorSchemaCoordinator.beginSchemaRequest(oldLease, 'schema-old');
		kustoEditorSchemaCoordinator.attachModel(oldLease, 'inmemory://model/old');
		handlerState.schemaRequestTokenByBoxId.query_1 = 'schema-old';
		handlerState.queryEditors.query_1 = { getModel: vi.fn(() => ({ uri: { toString: () => 'inmemory://model/old' } })) };
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const workerStarted = new Promise<void>(resolve => { started = resolve; });
		(window as any).__kustoSetMonacoKustoSchema = vi.fn(async (...args: any[]) => {
			started();
			await gate;
			return args[6]();
		});
		vi.mocked(state.markSchemaWorkerReady).mockClear();

		dispatchHostMessage({
			type: 'schemaData', boxId: 'query_1', connectionId: 'c1', accountPartition: 'partition-1',
			database, clusterUrl, requestToken: 'schema-old', ...identity,
			schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: { Databases: { Samples: {} } } },
			schemaMeta: { schemaSignature: 'sig-old', workerUpdateNeeded: true, isBackgroundRefresh: true, refreshState: 'completed', autocompleteChanged: true },
		});
		await workerStarted;

		kustoEditorSchemaCoordinator.closeSection(oldLease);
		const newLease = kustoEditorSchemaCoordinator.openSection('query_1', 'instance-new')!;
		kustoEditorSchemaCoordinator.setTarget(newLease, 'c1', database);
		kustoEditorSchemaCoordinator.attachModel(newLease, 'inmemory://model/new');
		handlerState.queryEditors.query_1 = { getModel: vi.fn(() => ({ uri: { toString: () => 'inmemory://model/new' } })) };
		release();
		await vi.waitFor(() => expect((window as any).__kustoSetMonacoKustoSchema).toHaveBeenCalledOnce());
		await Promise.resolve();

		expect(state.markSchemaWorkerReady).not.toHaveBeenCalled();
		expect(kustoEditorSchemaCoordinator.getOwnedState('query_1', 'workerReady')).toBeUndefined();
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

	it('shows a worker-ready schema failover as cached instead of error', () => {
		const queryEl = { setSchemaInfo: vi.fn() };
		mocks.getQuerySectionElement.mockReturnValue(queryEl);

		dispatchHostMessage({
			type: 'schemaData',
			boxId: 'query_1',
			connectionId: 'c1',
			database: 'Samples',
			clusterUrl: 'https://cluster.kusto.windows.net',
			schema: {
				tables: ['Events'],
				columnTypesByTable: { Events: { EventName: 'string' } },
				rawSchemaJson: { Plugins: [], Databases: { Samples: { Tables: {} } } },
			},
			schemaMeta: {
				fromCache: true,
				isFailoverToCache: true,
				refreshState: 'failed',
				tablesCount: 1,
				columnsCount: 1,
				functionsCount: 0,
				workerUpdateNeeded: true,
			},
		});

		expect(queryEl.setSchemaInfo).toHaveBeenCalledWith({
			text: '1 tables, 1 cols (cached)',
			isError: false,
			meta: expect.objectContaining({
				fromCache: true,
				hasRawSchemaJson: true,
				isFailoverToCache: true,
			}),
		});
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

		expect(state.getPendingSchemaWorkerUpdate('query_1')).toEqual(expect.objectContaining({
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

		expect(state.getPendingSchemaWorkerUpdate('query_1')).toEqual(expect.objectContaining({
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

		expect(state.getPendingSchemaWorkerUpdate('query_1')).toEqual(expect.objectContaining({
			schemaKey,
			schemaSignature: 'sig-1',
			reason: 'inactive-box',
		}));
		expect(state.getKustoPreparationState('query_1')).toMatchObject({
			status: 'deferred',
			stage: 'waiting-focus',
			blockers: [],
			usableFallback: true,
			target: { schemaKey, modelUri: 'inmemory://model/open' },
		});
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

		expect(state.getPendingSchemaWorkerUpdate('query_1')).toEqual(expect.objectContaining({
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

		expect(state.getPendingSchemaWorkerUpdate('query_1')).toBeUndefined();
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
		handlerState.pState.documentKind = 'kqlx';
		handlerState.pState.allowedSectionKinds = ['query', 'sql', 'chart', 'transformation', 'markdown', 'python', 'url', 'html'];
		handlerState.pState.compatibilityMode = false;
		handlerState.pState.compatibilitySingleKind = 'query';
		handlerState.pState.documentMutationAllowed = true;
		handlerState.pState.documentRuntimeActive = true;
		mocks.createSectionWithCapabilities.mockImplementation((kind: unknown) => {
			const sectionKind = String(kind || '');
			if (handlerState.pState.compatibilityMode) {
				return { ok: false, error: `Adding a ${sectionKind} section requires upgrading this compatibility file first.` };
			}
			const allowedKinds = Array.isArray(handlerState.pState.allowedSectionKinds)
				? handlerState.pState.allowedSectionKinds.map(String)
				: [];
			return allowedKinds.includes(sectionKind)
				? { ok: true, sectionId: `${sectionKind}_1` }
				: { ok: false, error: `Section type "${sectionKind}" is unavailable in the current document host.` };
		});
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
		const copilotOwner = configureFakeKustoCopilotRequest(section);
		mocks.getQuerySectionElement.mockReturnValue(section);

		dispatchHostMessage({ type: 'copilotWriteQuerySetQuery', boxId: 'query_1', query: 'StormEvents | take 10', ...copilotOwner });
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
		const copilotOwner = configureFakeKustoCopilotRequest(section);
		mocks.getQuerySectionElement.mockReturnValue(section);

		dispatchHostMessage({ type: 'copilotWriteQuerySetQuery', boxId: 'query_1', query: 'StormEvents | take 10', ...copilotOwner });
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

	it.each([
		['kqlx', ['query', 'copilotQuery', 'sql', 'chart', 'transformation', 'markdown', 'python', 'url', 'html']],
		['sqlx', ['sql', 'chart', 'transformation', 'markdown', 'python', 'url', 'html']],
		['mdx', ['transformation', 'markdown', 'url']],
	] as const)('admits tool-added sections from the %s matrix row', async (documentKind, allowedKinds) => {
		const knownKinds = [
			'query', 'copilotQuery', 'sql', 'chart', 'transformation',
			'markdown', 'python', 'url', 'html', 'devnotes', 'future-section',
		];
		handlerState.pState.documentKind = documentKind;
		handlerState.pState.allowedSectionKinds = [
			'query', 'sql', 'chart', 'transformation', 'markdown', 'python', 'url', 'html',
		];

		for (const sectionKind of knownKinds) {
			mocks.postMessageToHost.mockClear();
			const requestId = `tool-${documentKind}-${sectionKind}`;
			dispatchHostMessage({ type: 'toolAddSection', requestId, input: { type: sectionKind } });
			await Promise.resolve();
			const response = mocks.postMessageToHost.mock.calls
				.map(call => call[0] as any)
				.find(message => message.type === 'toolResponse' && message.requestId === requestId);
			expect(response, `${documentKind}/${sectionKind}`).toBeDefined();
			expect(response.result.success, `${documentKind}/${sectionKind}`).toBe(allowedKinds.includes(sectionKind as never));
			if (!allowedKinds.includes(sectionKind as never)) {
				expect(response.error, `${documentKind}/${sectionKind}`).toMatch(/section type|failed to add section/i);
			}
		}
	});

	it('passes Python code through tool creation and waits for host command settlement', async () => {
		mocks.isHostOwnedMarkdownDocument.mockReturnValue(true);
		try {
			dispatchHostMessage({
				type: 'toolAddSection', requestId: 'tool-python-code',
				input: { type: 'python', name: 'Analysis', code: 'print(42)' },
			});
			await new Promise(resolve => setTimeout(resolve, 0));

			expect(mocks.createSectionWithCapabilities).toHaveBeenCalledWith('python', { code: 'print(42)' });
			expect(mocks.waitForHostOwnedMarkdownCommands).toHaveBeenCalledOnce();
			expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
				type: 'toolResponse', requestId: 'tool-python-code',
				result: { sectionId: 'python_1', success: true },
			}));
		} finally {
			mocks.isHostOwnedMarkdownDocument.mockReturnValue(false);
		}
	});

	it('rejects tool-added sections in compatibility mode before mutation', async () => {
		handlerState.pState.documentKind = 'kql';
		handlerState.pState.compatibilityMode = true;
		handlerState.pState.upgradeRequestType = 'requestUpgradeToKqlx';
		handlerState.pState.allowedSectionKinds = ['query', 'markdown'];

		dispatchHostMessage({ type: 'toolAddSection', requestId: 'compat-add', input: { type: 'markdown', text: 'lost' } });
		await Promise.resolve();

		expect(mocks.createSectionWithCapabilities).toHaveBeenCalledWith('markdown', { text: 'lost' });
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'toolResponse', requestId: 'compat-add', result: { sectionId: '', success: false },
			error: expect.stringContaining('requires upgrading'),
		}));
	});

	it.each(['kql', 'sql'] as const)('rejects development-note mutation for malformed %s companion projection', async documentKind => {
		handlerState.pState.documentKind = documentKind;
		handlerState.pState.compatibilityMode = false;
		handlerState.pState.documentMutationAllowed = false;

		dispatchHostMessage({
			type: 'updateDevNotes', requestId: `devnotes-malformed-${documentKind}`, action: 'add',
			entry: {
				id: 'note_invalid', created: '2026-08-02T00:00:00.000Z', updated: '2026-08-02T00:00:00.000Z',
				category: 'usage-note', content: 'must not mutate', source: 'agent',
			},
		});
		await Promise.resolve();

		expect(handlerState.pState.devNotesSections).toEqual([]);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'toolResponse', requestId: `devnotes-malformed-${documentKind}`, result: { success: false },
			error: expect.stringContaining('read-only'),
		}));
	});

	it('rejects stale terminals and all tool access while retained DOM is runtime-inactive', async () => {
		handlerState.pState.documentMutationAllowed = false;
		handlerState.pState.documentRuntimeActive = false;

		dispatchHostMessage({
			type: 'queryResult', boxId: 'query_stale', executionId: 'execution-stale',
			result: { columns: [{ name: 'Secret' }], rows: [['stale']] },
		});
		dispatchHostMessage({ type: 'pythonResult', boxId: 'python_stale', stdout: 'discarded', exitCode: 0 });
		dispatchHostMessage({ type: 'pythonError', boxId: 'python_error_stale', error: 'discarded' });
		dispatchHostMessage({ type: 'requestToolState', requestId: 'state-invalid' });
		dispatchHostMessage({
			type: 'toolConfigureSqlSection', requestId: 'configure-invalid',
			input: { sectionId: 'sql_stale', query: 'SELECT leaked=1', execute: true },
		});
		dispatchHostMessage({
			type: 'kustoPublicationStage', publicationId: 'invalid-publication',
			publicationDeadline: Date.now() + 10_000, payload: {
				type: 'queryResult', boxId: 'query_stale', executionId: 'execution-stale',
			},
		});
		await Promise.resolve();

		expect(mocks.displayResultForBox).not.toHaveBeenCalled();
		expect(mocks.onPythonResult).toHaveBeenCalledWith(expect.objectContaining({ boxId: 'python_stale' }));
		expect(mocks.onPythonError).toHaveBeenCalledWith(expect.objectContaining({ boxId: 'python_error_stale' }));
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolStateResponse', requestId: 'state-invalid', sections: [],
			error: 'This document is invalid and its retained sections are non-executable.',
		});
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolResponse', requestId: 'configure-invalid', result: { success: false },
			error: 'This document is invalid and its retained sections are read-only.',
		});
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'kustoPublicationAck', publicationId: 'invalid-publication', phase: 'staged', accepted: false,
		});
	});

	it('rejects mutations before the initial document projection is applied', async () => {
		handlerState.pState.documentMutationAllowed = true;
		handlerState.pState.documentRuntimeActive = false;

		dispatchHostMessage({
			type: 'updateDevNotes', requestId: 'note-before-document', action: 'add',
			entry: {
				id: 'note_early', created: '2026-08-02T00:00:00.000Z', updated: '2026-08-02T00:00:00.000Z',
				category: 'usage-note', content: 'must not disappear', source: 'agent',
			},
		});
		dispatchHostMessage({
			type: 'toolAddSection', requestId: 'section-before-document',
			input: { type: 'markdown', text: 'must not disappear' },
		});
		dispatchHostMessage({ type: 'requestToolState', requestId: 'state-before-document' });
		await Promise.resolve();

		expect(handlerState.pState.devNotesSections).toEqual([]);
		expect(mocks.createSectionWithCapabilities).not.toHaveBeenCalled();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolResponse', requestId: 'note-before-document', result: { success: false },
			error: 'This document is still loading and cannot accept mutations yet.',
		});
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolResponse', requestId: 'section-before-document', result: { success: false },
			error: 'This document is still loading and cannot accept mutations yet.',
		});
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolStateResponse', requestId: 'state-before-document', sections: [],
			error: 'This document is still loading and has no executable sections yet.',
		});
	});

	it.each([
		['KQL', 'kql', 'query'],
		['SQL', 'sql', 'sql'],
	] as const)('rejects development-note mutation in plain %s compatibility mode', async (_label, documentKind, primaryKind) => {
		handlerState.pState.documentKind = documentKind;
		handlerState.pState.compatibilityMode = true;
		handlerState.pState.documentMutationAllowed = true;
		handlerState.pState.compatibilitySingleKind = primaryKind;

		dispatchHostMessage({
			type: 'updateDevNotes', requestId: `devnotes-${documentKind}`, action: 'add',
			entry: {
				id: 'note_1', created: '2026-08-02T00:00:00.000Z', updated: '2026-08-02T00:00:00.000Z',
				category: 'usage-note', content: 'must persist', source: 'agent',
			},
		});
		await Promise.resolve();

		expect(handlerState.pState.devNotesSections).toEqual([]);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'toolResponse', requestId: `devnotes-${documentKind}`, result: { success: false },
			error: expect.stringContaining('companion metadata file'),
		}));
	});

	it('acknowledges only actual development-note add, supersede, and remove transitions', async () => {
		handlerState.pState.compatibilityMode = false;
		handlerState.pState.documentMutationAllowed = true;
		const first = {
			id: 'note_first', created: '2026-08-02T00:00:00.000Z', updated: '2026-08-02T00:00:00.000Z',
			category: 'usage-note', content: 'first', source: 'agent',
		};
		const replacement = {
			...first, id: 'note_replacement', updated: '2026-08-02T00:01:00.000Z', content: 'replacement',
		};

		dispatchHostMessage({ type: 'updateDevNotes', requestId: 'note-add', action: 'add', entry: first });
		await Promise.resolve();
		expect(handlerState.pState.devNotesSections[0].entries).toEqual([first]);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolResponse', requestId: 'note-add', result: { success: true },
		});

		dispatchHostMessage({
			type: 'updateDevNotes', requestId: 'note-supersede', action: 'supersede',
			supersededId: first.id, entry: replacement,
		});
		await Promise.resolve();
		expect(handlerState.pState.devNotesSections[0].entries).toEqual([replacement]);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolResponse', requestId: 'note-supersede', result: { success: true },
		});

		dispatchHostMessage({
			type: 'updateDevNotes', requestId: 'note-missing', action: 'supersede',
			supersededId: 'missing', entry: { ...replacement, id: 'note_never_added' },
		});
		await Promise.resolve();
		expect(handlerState.pState.devNotesSections[0].entries).toEqual([replacement]);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'toolResponse', requestId: 'note-missing', result: { success: false },
			error: expect.stringContaining('not found uniquely'),
		}));

		dispatchHostMessage({
			type: 'updateDevNotes', requestId: 'note-remove', action: 'remove', noteId: replacement.id,
		});
		await Promise.resolve();
		expect(handlerState.pState.devNotesSections[0].entries).toEqual([]);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolResponse', requestId: 'note-remove', result: { success: true },
		});
		const persistence = await import('../../src/webview/core/persistence.js');
		expect(persistence.schedulePersist).toHaveBeenCalledTimes(3);
	});

	it('leaves duplicate development notes unchanged when removal is not unique', async () => {
		const duplicateA = { id: 'duplicate_note', content: 'A' };
		const duplicateB = { id: 'duplicate_note', content: 'B' };
		handlerState.pState.devNotesSections = [
			{ id: 'devnotes_a', type: 'devnotes', entries: [duplicateA] },
			{ id: 'devnotes_b', type: 'devnotes', entries: [duplicateB] },
		];
		const before = structuredClone(handlerState.pState.devNotesSections);
		const persistence = await import('../../src/webview/core/persistence.js');
		vi.mocked(persistence.schedulePersist).mockClear();

		dispatchHostMessage({
			type: 'updateDevNotes', requestId: 'remove-duplicate-note', action: 'remove', noteId: 'duplicate_note',
		});
		await Promise.resolve();

		expect(handlerState.pState.devNotesSections).toEqual(before);
		expect(persistence.schedulePersist).not.toHaveBeenCalled();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'toolResponse', requestId: 'remove-duplicate-note', result: { success: false },
			error: expect.stringContaining('not found uniquely'),
		}));
	});

	it('removes an arbitrary query section ID through the owning cleanup path', async () => {
		const sectionFactory = await import('../../src/webview/core/section-factory.js');
		const section = document.createElement('div') as HTMLDivElement & { serialize: () => unknown };
		section.id = 'custom-query';
		section.serialize = () => ({ id: 'custom-query', type: 'query', query: 'print 1' });
		document.body.appendChild(section);

		dispatchHostMessage({ type: 'toolRemoveSection', requestId: 'remove-custom', sectionId: 'custom-query' });
		await Promise.resolve();

		expect(sectionFactory.removeQueryBox).toHaveBeenCalledWith('custom-query');
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'toolResponse', requestId: 'remove-custom', result: { success: true },
		}));
	});

	it('routes Markdown removal by element tag without consulting serialize()', async () => {
		const markdownModule = await import('../../src/webview/sections/kw-markdown-section.js');
		const section = document.createElement('div') as HTMLDivElement & { serialize: ReturnType<typeof vi.fn> };
		Object.defineProperty(section, 'tagName', { value: 'KW-MARKDOWN-SECTION', configurable: true });
		section.id = 'opaque-markdown-id';
		section.serialize = vi.fn(() => { throw new Error('stale serializer'); });
		document.body.appendChild(section);

		dispatchHostMessage({ type: 'toolRemoveSection', requestId: 'remove-markdown', sectionId: section.id });
		await Promise.resolve();

		expect(section.serialize).not.toHaveBeenCalled();
		expect(markdownModule.removeMarkdownBox).toHaveBeenCalledWith(section.id);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'toolResponse', requestId: 'remove-markdown', result: { success: true },
		}));
	});

	it('reports failure when the host rejects a Python removal command', async () => {
		const section = document.createElement('div');
		Object.defineProperty(section, 'tagName', { value: 'KW-PYTHON-SECTION', configurable: true });
		section.id = 'opaque-python-id';
		document.body.appendChild(section);
		mocks.isHostOwnedMarkdownDocument.mockReturnValue(true);
		mocks.waitForHostOwnedMarkdownCommands.mockResolvedValue(false);
		try {
			dispatchHostMessage({ type: 'toolRemoveSection', requestId: 'remove-python', sectionId: section.id });
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
				type: 'toolResponse', requestId: 'remove-python', result: { success: false },
				error: 'The host rejected the document section command.',
			}));
		} finally {
			mocks.isHostOwnedMarkdownDocument.mockReturnValue(false);
			mocks.waitForHostOwnedMarkdownCommands.mockResolvedValue(true);
			section.remove();
		}
	});

	it('refuses tool removal of the pinned compatibility primary', async () => {
		handlerState.pState.firstSectionPinned = true;
		const container = document.createElement('div');
		container.id = 'queries-container';
		const primary = document.createElement('div') as HTMLDivElement & { serialize: () => unknown };
		primary.id = 'primary-query';
		primary.serialize = () => ({ id: primary.id, type: 'query', query: 'print 1' });
		const secondary = document.createElement('div');
		secondary.id = 'secondary-query';
		container.append(primary, secondary);
		document.body.appendChild(container);

		dispatchHostMessage({ type: 'toolRemoveSection', requestId: 'remove-primary', sectionId: primary.id });
		await Promise.resolve();

		const sectionFactory = await import('../../src/webview/core/section-factory.js');
		expect(sectionFactory.removeQueryBox).not.toHaveBeenCalled();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'toolResponse', requestId: 'remove-primary', result: { success: false },
			error: expect.stringContaining('pinned'),
		}));
	});

	it('does not inherit agent provenance from a no-op Copilot query update', async () => {
		let query = 'StormEvents | count';
		const { section, shell, setSerializedState } = createSectionWithShell('query_1', { id: 'query_1', type: 'query', query });
		section.copilotWriteQuerySetQuery = vi.fn((nextQuery: string) => {
			query = String(nextQuery);
			setSerializedState({ id: 'query_1', type: 'query', query });
		});
		const copilotOwner = configureFakeKustoCopilotRequest(section);
		mocks.getQuerySectionElement.mockReturnValue(section);

		dispatchHostMessage({ type: 'copilotWriteQuerySetQuery', boxId: 'query_1', query, ...copilotOwner });
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
		const copilotOwner = configureFakeKustoCopilotRequest(section);
		mocks.getQuerySectionElement.mockReturnValue(section);

		dispatchHostMessage({ type: 'copilotWriteQuerySetQuery', boxId: 'query_1', query: 'StormEvents | take 10', ...copilotOwner });
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
		const { section: sourceSection } = createSectionWithShell('query_src', { id: 'query_src', type: 'query', query: 'Source query' });
		const { section: comparisonSection, shell, setSerializedState } = createSectionWithShell('query_cmp', { id: 'query_cmp', type: 'query', query });
		configureFakeKustoTarget(sourceSection, 'conn-1', 'Db');
		configureFakeKustoTarget(comparisonSection, 'conn-old', 'OldDb');
		handlerState.queryEditors.query_cmp = {
			setValue: vi.fn((nextQuery: string) => {
				query = String(nextQuery);
				setSerializedState({ id: 'query_cmp', type: 'query', query });
			}),
		};
		handlerState.queryEditors.query_src = { getValue: vi.fn(() => 'Source query') };
		handlerState.optimizationMetadataByBoxId.query_src = { comparisonBoxId: 'query_cmp' };
		const optimizeOwner = { boxId: 'query_src', optimizeRequestId: 'optimize-reused', sectionInstanceId: 'instance-source', targetGeneration: 1 };
		Object.assign(sourceSection, {
			admitKustoOptimizeMessage: vi.fn(() => true), completeKustoOptimizeRequest: vi.fn(() => true),
		});
		mocks.getQuerySectionElement.mockImplementation((boxId: string) =>
			boxId === 'query_src' ? sourceSection : boxId === 'query_cmp' ? comparisonSection : null);

		dispatchHostMessage({
			type: 'optimizeQueryReady',
			...optimizeOwner,
			optimizedQuery: 'New optimized query',
			queryName: 'Source',
			connectionId: 'conn-1', database: 'Db',
		});
		await new Promise(resolve => setTimeout(resolve, 120));
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

	it('keeps Optimize ownership live when ready application fails so the fallback error can settle it', async () => {
		const { section: sourceSection } = createSectionWithShell('query_src', { id: 'query_src', type: 'query', query: 'Source query' });
		configureFakeKustoTarget(sourceSection, 'conn-1', 'Db');
		const optimizeOwner = { boxId: 'query_src', optimizeRequestId: 'optimize-failed-ready', sectionInstanceId: 'instance-source', targetGeneration: 1 };
		const complete = vi.fn(() => true);
		Object.assign(sourceSection, {
			admitKustoOptimizeMessage: vi.fn(() => true),
			completeKustoOptimizeRequest: complete,
		});
		handlerState.optimizationMetadataByBoxId.query_src = { comparisonBoxId: 'missing-comparison' };
		mocks.getQuerySectionElement.mockImplementation((boxId: string) => boxId === 'query_src' ? sourceSection : null);

		for (const message of [
			{
				publicationId: 'optimize-ready-publication',
				payload: {
					type: 'optimizeQueryReady', ...optimizeOwner, optimizedQuery: 'Optimized query',
					queryName: 'Source', connectionId: 'conn-1', database: 'Db',
				},
				expected: false,
			},
			{
				publicationId: 'optimize-error-publication',
				payload: { type: 'optimizeQueryError', ...optimizeOwner, error: 'Comparison application failed' },
				expected: true,
			},
		] as const) {
			dispatchHostMessage({
				type: 'kustoPublicationStage', publicationId: message.publicationId,
				publicationDeadline: Date.now() + 1_000, payload: message.payload,
			});
			dispatchHostMessage({ type: 'kustoPublicationCommit', publicationId: message.publicationId });
			await vi.waitFor(() => expect(mocks.postMessageToHost).toHaveBeenCalledWith({
				type: 'kustoPublicationAck', publicationId: message.publicationId,
				phase: 'applied', accepted: message.expected,
			}));
			if (!message.expected) expect(complete).not.toHaveBeenCalled();
		}

		expect(complete).toHaveBeenCalledOnce();
		expect(complete).toHaveBeenCalledWith(expect.objectContaining({
			type: 'optimizeQueryError', ...optimizeOwner,
		}));
	});

	it('marks newly created optimized comparison sections as agent-touched when new', async () => {
		const { section: sourceSection } = createSectionWithShell('query_src', { id: 'query_src', type: 'query', query: 'Source query' });
		const { section: comparisonSection, shell } = createSectionWithShell('query_1', { id: 'query_1', type: 'query', query: 'New optimized query' });
		configureFakeKustoTarget(sourceSection, 'conn-1', 'Db');
		configureFakeKustoTarget(comparisonSection, 'conn-old', 'OldDb');
		handlerState.queryEditors.query_src = { getValue: vi.fn(() => 'Source query') };
		const optimizeOwner = { boxId: 'query_src', optimizeRequestId: 'optimize-new', sectionInstanceId: 'instance-source', targetGeneration: 1 };
		Object.assign(sourceSection, {
			admitKustoOptimizeMessage: vi.fn(() => true), completeKustoOptimizeRequest: vi.fn(() => true),
		});
		mocks.getQuerySectionElement.mockImplementation((boxId: string) =>
			boxId === 'query_src' ? sourceSection : boxId === 'query_1' ? comparisonSection : null);

		dispatchHostMessage({
			type: 'optimizeQueryReady',
			...optimizeOwner,
			optimizedQuery: 'New optimized query',
			queryName: 'Source',
			connectionId: 'conn-1', database: 'Db',
		});
		await new Promise(resolve => setTimeout(resolve, 120));
		expect(mocks.createSectionWithCapabilities).toHaveBeenCalledWith('query', expect.objectContaining({
			isComparison: true,
			comparisonSourceBoxId: 'query_src',
		}));
		expect((comparisonSection as any).getConnectionId()).toBe('conn-1');
		expect((comparisonSection as any).getDatabase()).toBe('Db');
		expect(mocks.executeKustoComparisonPair).toHaveBeenCalledWith('query_src', 'query_1');
		expect(mocks.executeQuery).not.toHaveBeenCalled();
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

	it('reports failure when the host rejects a Markdown collapse command', async () => {
		const section = document.createElement('div') as HTMLDivElement & { setExpanded: ReturnType<typeof vi.fn> };
		Object.defineProperty(section, 'tagName', { value: 'KW-MARKDOWN-SECTION', configurable: true });
		section.id = 'markdown-collapse';
		section.setExpanded = vi.fn();
		document.body.appendChild(section);
		mocks.isHostOwnedMarkdownDocument.mockReturnValue(true);
		mocks.waitForHostOwnedMarkdownCommands.mockResolvedValue(false);
		try {
			dispatchHostMessage({
				type: 'toolCollapseSection', requestId: 'collapse-markdown', sectionId: section.id, collapsed: true,
			});
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(section.setExpanded).toHaveBeenCalledWith(false);
			expect(mocks.postMessageToHost).toHaveBeenCalledWith({
				type: 'toolResponse', requestId: 'collapse-markdown',
				result: { success: false }, error: 'Failed to collapse/expand section',
			});
		} finally {
			mocks.isHostOwnedMarkdownDocument.mockReturnValue(false);
			mocks.waitForHostOwnedMarkdownCommands.mockResolvedValue(true);
			section.remove();
		}
	});

	it('reports failure when the host rejects a Python collapse command', async () => {
		const section = document.createElement('div') as HTMLDivElement & { setExpanded: ReturnType<typeof vi.fn> };
		Object.defineProperty(section, 'tagName', { value: 'KW-PYTHON-SECTION', configurable: true });
		section.id = 'python-collapse';
		section.setExpanded = vi.fn();
		document.body.appendChild(section);
		mocks.isHostOwnedMarkdownDocument.mockReturnValue(true);
		mocks.waitForHostOwnedMarkdownCommands.mockResolvedValue(false);
		try {
			dispatchHostMessage({
				type: 'toolCollapseSection', requestId: 'collapse-python', sectionId: section.id, collapsed: true,
			});
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(section.setExpanded).toHaveBeenCalledWith(false);
			expect(mocks.postMessageToHost).toHaveBeenCalledWith({
				type: 'toolResponse', requestId: 'collapse-python',
				result: { success: false }, error: 'Failed to collapse/expand section',
			});
		} finally {
			mocks.isHostOwnedMarkdownDocument.mockReturnValue(false);
			mocks.waitForHostOwnedMarkdownCommands.mockResolvedValue(true);
			section.remove();
		}
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
		const { section: sourceSection } = createSectionWithShell('query_src', { id: 'query_src', type: 'query', query: 'Source query' });
		const { section: comparisonSection, shell, setSerializedState } = createSectionWithShell('query_cmp', { id: 'query_cmp', type: 'query', query: comparisonQuery });
		configureFakeKustoTarget(sourceSection);
		configureFakeKustoTarget(comparisonSection, 'connection-old', 'OldDb');
		const comparisonRequest = configureFakeKustoCopilotRequest(sourceSection, 'comparison-request');
		mocks.getQuerySectionElement.mockImplementation((boxId: string) =>
			boxId === 'query_src' ? sourceSection : boxId === 'query_cmp' ? comparisonSection : null);
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

		dispatchHostMessage({ type: 'ensureComparisonBox', requestId: 'r-ensure', boxId: 'query_src', query: 'New comparison query', ...comparisonRequest });
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(shell.agentTouched).toBe(false);
		expect((comparisonSection as any).getConnectionId()).toBe('conn-1');
		expect((comparisonSection as any).getDatabase()).toBe('db-1');
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'comparisonBoxEnsured', requestId: 'r-ensure', comparisonBoxId: 'query_cmp',
			kustoTarget: expect.objectContaining({
				boxId: 'query_cmp', connectionId: 'conn-1', database: 'db-1', targetGeneration: 2,
			}),
		}));

		dispatchHostMessage({
			type: 'changedSections',
			changes: [{ id: 'query_cmp', status: 'modified', contentChanged: true, settingsChanged: false }],
		});
		await Promise.resolve();
		await shell.updateComplete;

		expect(shell.hasChanges).toBe('modified');
		expect(shell.agentTouched).toBe(true);
	});

	it('prepares SQL comparisons as SQL sections in SQLX', async () => {
		handlerState.pState.documentKind = 'sqlx';
		handlerState.pState.allowedSectionKinds = ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'];
		const sourceSql = createFakeSqlSection() as FakeSqlSection & {
			getServerUrl: () => string; getConnectionId: () => string; getDatabase: () => string;
		};
		sourceSql.id = 'sql_source';
		sourceSql.getServerUrl = () => 'server.example';
		sourceSql.getConnectionId = () => 'sql-a';
		sourceSql.getDatabase = () => 'Db';
		mocks.getSqlSectionElement.mockImplementation((boxId: string) => boxId === 'sql_source' ? sourceSql : null);

		dispatchHostMessage({
			type: 'ensureComparisonBox', requestId: 'sql-comparison', boxId: 'sql_source',
			query: 'SELECT 2', engine: 'sql',
			sourceSectionInstanceId: sourceSql.sqlSession.instanceId,
			sourceTargetGeneration: sourceSql.sqlSession.targetGeneration,
		});
		await Promise.resolve();

		expect(mocks.createSectionWithCapabilities).toHaveBeenCalledWith('sql', expect.objectContaining({
			query: 'SELECT 2', afterBoxId: 'sql_source', comparisonSourceBoxId: 'sql_source',
			serverUrl: 'server.example', connectionIdHint: 'sql-a', database: 'Db',
		}));
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'comparisonBoxEnsured', requestId: 'sql-comparison', sourceBoxId: 'sql_source',
			comparisonBoxId: 'sql_1',
			sourceSectionInstanceId: sourceSql.sqlSession.instanceId,
			sourceTargetGeneration: sourceSql.sqlSession.targetGeneration,
		}));
		expect(mocks.postMessageToHost).not.toHaveBeenCalledWith(expect.objectContaining({ kustoTarget: expect.anything() }));
	});

	it('rejects a nested SQL comparison source before creating or mutating a section', async () => {
		handlerState.pState.documentKind = 'sqlx';
		handlerState.pState.allowedSectionKinds = ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'];
		const comparisonSource = createFakeSqlSection() as FakeSqlSection & {
			getServerUrl: () => string; getConnectionId: () => string; getDatabase: () => string;
		};
		comparisonSource.id = 'sql_comparison_source';
		comparisonSource.getServerUrl = () => 'server.example';
		comparisonSource.getConnectionId = () => 'sql-a';
		comparisonSource.getDatabase = () => 'Db';
		handlerState.optimizationMetadataByBoxId.sql_comparison_source = {
			sourceBoxId: 'sql_root', isComparison: true,
		};
		mocks.getSqlSectionElement.mockImplementation((boxId: string) =>
			boxId === 'sql_comparison_source' ? comparisonSource : null);
		mocks.createSectionWithCapabilities.mockClear();

		dispatchHostMessage({
			type: 'ensureComparisonBox', requestId: 'nested-sql-comparison',
			boxId: 'sql_comparison_source', query: 'SELECT 3', engine: 'sql',
			sourceSectionInstanceId: comparisonSource.sqlSession.instanceId,
			sourceTargetGeneration: comparisonSource.sqlSession.targetGeneration,
		});
		await Promise.resolve();

		expect(mocks.createSectionWithCapabilities).not.toHaveBeenCalled();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'comparisonBoxEnsured', engine: 'sql', requestId: 'nested-sql-comparison',
			sourceBoxId: 'sql_comparison_source', comparisonBoxId: '',
		});
	});

	it('uses distinct request-derived comparison IDs even when the clock is fixed', async () => {
		handlerState.pState.documentKind = 'sqlx';
		handlerState.pState.allowedSectionKinds = ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'];
		const sourceA = createFakeSqlSection() as FakeSqlSection & {
			getServerUrl: () => string; getConnectionId: () => string; getDatabase: () => string;
		};
		const sourceB = createFakeSqlSection() as typeof sourceA;
		sourceA.id = 'sql_source_a';
		sourceB.id = 'sql_source_b';
		for (const source of [sourceA, sourceB]) {
			source.getServerUrl = () => 'server.example';
			source.getConnectionId = () => 'sql-a';
			source.getDatabase = () => 'Db';
		}
		const comparisons: Record<string, FakeSqlSection> = {};
		mocks.getSqlSectionElement.mockImplementation((boxId: string) => ({
			sql_source_a: sourceA, sql_source_b: sourceB, ...comparisons,
		} as Record<string, FakeSqlSection>)[boxId] || null);
		mocks.createSectionWithCapabilities.mockImplementation((_kind: unknown, options: any) => {
			const id = String(options.id);
			const comparison = createFakeSqlSection();
			comparison.id = id;
			comparison.setAttribute('data-sql-comparison-admission-request-id', String(options.comparisonAdmissionRequestId));
			comparisons[id] = comparison;
			handlerState.optimizationMetadataByBoxId[id] = { sourceBoxId: options.comparisonSourceBoxId, isComparison: true };
			handlerState.optimizationMetadataByBoxId[options.comparisonSourceBoxId] = { comparisonBoxId: id };
			return { ok: true, sectionId: id };
		});
		const now = vi.spyOn(Date, 'now').mockReturnValue(1234);
		try {
			for (const [requestId, source] of [['request-a', sourceA], ['request-b', sourceB]] as const) {
				dispatchHostMessage({
					type: 'ensureComparisonBox', requestId, boxId: source.id,
					query: `SELECT '${requestId}'`, engine: 'sql',
					sourceSectionInstanceId: source.sqlSession.instanceId,
					sourceTargetGeneration: source.sqlSession.targetGeneration,
				});
				await Promise.resolve();
			}
			const ids = mocks.createSectionWithCapabilities.mock.calls.map((call: any[]) => call[1].id);
			expect(ids).toEqual(['sql_cmp_request-a', 'sql_cmp_request-b']);
			expect(new Set(ids).size).toBe(2);
			for (const [requestId, source, comparisonBoxId] of [
				['request-a', sourceA, 'sql_cmp_request-a'],
				['request-b', sourceB, 'sql_cmp_request-b'],
			] as const) {
				dispatchHostMessage({
					type: 'sqlComparisonAdmissionRollback', requestId,
					sourceBoxId: source.id, comparisonBoxId,
				});
			}
		} finally {
			now.mockRestore();
		}
	});

	it('removes only the exact newly provisional SQL comparison when host admission is rejected', async () => {
		handlerState.pState.documentKind = 'sqlx';
		handlerState.pState.allowedSectionKinds = ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'];
		const source = createFakeSqlSection() as FakeSqlSection & {
			getServerUrl: () => string; getConnectionId: () => string; getDatabase: () => string;
		};
		const comparison = createFakeSqlSection();
		source.id = 'sql_source';
		comparison.id = 'sql_1';
		source.getServerUrl = () => 'server.example';
		source.getConnectionId = () => 'sql-a';
		source.getDatabase = () => 'Db';
		mocks.getSqlSectionElement.mockImplementation((boxId: string) => ({
			sql_source: source, sql_1: comparison,
		} as Record<string, FakeSqlSection>)[boxId] || null);
		mocks.createSectionWithCapabilities.mockImplementation((_kind: unknown, options: any) => {
			handlerState.optimizationMetadataByBoxId.sql_source = { comparisonBoxId: 'sql_1' };
			handlerState.optimizationMetadataByBoxId.sql_1 = { sourceBoxId: 'sql_source', isComparison: true };
			comparison.setAttribute('data-sql-comparison-admission-request-id', String(options.comparisonAdmissionRequestId));
			return { ok: true, sectionId: 'sql_1' };
		});

		dispatchHostMessage({
			type: 'ensureComparisonBox', requestId: 'sql-provisional', boxId: 'sql_source',
			query: 'SELECT 2', engine: 'sql', sourceSectionInstanceId: source.sqlSession.instanceId,
			sourceTargetGeneration: source.sqlSession.targetGeneration,
		});
		await Promise.resolve();
		expect(comparison.getAttribute('data-sql-comparison-admission-request-id')).toBe('sql-provisional');
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'comparisonBoxEnsured', engine: 'sql', requestId: 'sql-provisional', comparisonBoxId: 'sql_1',
		}));
		dispatchHostMessage({
			type: 'sqlComparisonAdmission', requestId: 'sql-provisional',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_1', accepted: true,
		});
		await Promise.resolve();
		expect(comparison.getAttribute('data-sql-comparison-admission-request-id')).toBe('sql-provisional');
		const sectionFactory = await import('../../src/webview/core/section-factory.js');
		expect(sectionFactory.removeSqlBox).not.toHaveBeenCalled();

		dispatchHostMessage({
			type: 'sqlComparisonAdmissionRollback', requestId: 'sql-provisional',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_1',
		});
		await Promise.resolve();
		expect(sectionFactory.removeSqlBox).toHaveBeenCalledWith('sql_1');
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionAck', phase: 'rolledBack', requestId: 'sql-provisional',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_1', accepted: true,
		});
	});

	it('retains idempotent rollback acknowledgement beyond the host retry horizon', async () => {
		vi.useFakeTimers();
		try {
			handlerState.pState.documentKind = 'sqlx';
			handlerState.pState.allowedSectionKinds = ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'];
			const source = createFakeSqlSection() as FakeSqlSection & {
				getServerUrl: () => string; getConnectionId: () => string; getDatabase: () => string;
			};
			const comparison = createFakeSqlSection();
			source.id = 'sql_source';
			comparison.id = 'sql_cmp_rollback-proof';
			source.getServerUrl = () => 'server.example';
			source.getConnectionId = () => 'sql-a';
			source.getDatabase = () => 'Db';
			mocks.getSqlSectionElement.mockImplementation((boxId: string) => ({
				sql_source: source, 'sql_cmp_rollback-proof': comparison,
			} as Record<string, FakeSqlSection>)[boxId] || null);
			mocks.createSectionWithCapabilities.mockImplementation((_kind: unknown, options: any) => {
				handlerState.optimizationMetadataByBoxId.sql_source = { comparisonBoxId: comparison.id };
				handlerState.optimizationMetadataByBoxId[comparison.id] = { sourceBoxId: 'sql_source', isComparison: true };
				comparison.setAttribute('data-sql-comparison-admission-request-id', String(options.comparisonAdmissionRequestId));
				return { ok: true, sectionId: comparison.id };
			});

			dispatchHostMessage({
				type: 'ensureComparisonBox', requestId: 'rollback-proof', boxId: 'sql_source',
				query: 'SELECT 2', engine: 'sql', sourceSectionInstanceId: source.sqlSession.instanceId,
				sourceTargetGeneration: source.sqlSession.targetGeneration,
			});
			dispatchHostMessage({
				type: 'sqlComparisonAdmissionRollback', requestId: 'rollback-proof',
				sourceBoxId: 'sql_source', comparisonBoxId: comparison.id,
			});
			mocks.postMessageToHost.mockClear();
			vi.advanceTimersByTime(15_000);

			dispatchHostMessage({
				type: 'sqlComparisonAdmissionRollback', requestId: 'rollback-proof',
				sourceBoxId: 'sql_source', comparisonBoxId: comparison.id,
			});
			expect(mocks.postMessageToHost).toHaveBeenCalledWith({
				type: 'sqlComparisonAdmissionAck', phase: 'rolledBack', requestId: 'rollback-proof',
				sourceBoxId: 'sql_source', comparisonBoxId: comparison.id, accepted: true,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not mutate a reused SQL comparison query until exact host admission', async () => {
		handlerState.pState.documentKind = 'sqlx';
		handlerState.pState.allowedSectionKinds = ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'];
		const source = createFakeSqlSection() as FakeSqlSection & {
			getServerUrl: () => string; getConnectionId: () => string; getDatabase: () => string;
		};
		const comparison = createFakeSqlSection() as FakeSqlSection & {
			getConnectionId: () => string; getDatabase: () => string;
			setQuery: ReturnType<typeof vi.fn>; clearResults: ReturnType<typeof vi.fn>;
		};
		source.id = 'sql_source';
		comparison.id = 'sql_comparison';
		source.getServerUrl = () => 'server.example';
		source.getConnectionId = () => 'sql-a';
		source.getDatabase = () => 'Db';
		comparison.getConnectionId = () => 'sql-a';
		comparison.getDatabase = () => 'Db';
		comparison.setQuery = vi.fn();
		comparison.clearResults = vi.fn();
		document.body.append(source, comparison);
		handlerState.optimizationMetadataByBoxId.sql_source = { comparisonBoxId: 'sql_comparison' };
		handlerState.optimizationMetadataByBoxId.sql_comparison = { sourceBoxId: 'sql_source', isComparison: true };
		mocks.getSqlSectionElement.mockImplementation((boxId: string) => ({
			sql_source: source, sql_comparison: comparison,
		} as Record<string, FakeSqlSection>)[boxId] || null);

		dispatchHostMessage({
			type: 'ensureComparisonBox', requestId: 'sql-reuse-admission', boxId: 'sql_source',
			query: 'SELECT 3', engine: 'sql', sourceSectionInstanceId: source.sqlSession.instanceId,
			sourceTargetGeneration: source.sqlSession.targetGeneration,
		});
		await Promise.resolve();
		expect(comparison.setQuery).not.toHaveBeenCalled();
		const sectionFactory = await import('../../src/webview/core/section-factory.js');
		expect(sectionFactory.__kustoSetSectionName).not.toHaveBeenCalledWith('sql_comparison', 'Optimized SQL');

		dispatchHostMessage({
			type: 'sqlComparisonAdmission', requestId: 'sql-reuse-admission',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison', accepted: true,
		});
		await Promise.resolve();
		expect(comparison.setQuery).not.toHaveBeenCalled();
		dispatchHostMessage({
			type: 'sqlComparisonAdmissionCommit', requestId: 'sql-reuse-admission',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison',
		});
		await Promise.resolve();
		expect(comparison.setQuery).toHaveBeenCalledWith('SELECT 3');
		expect(comparison.clearResults).not.toHaveBeenCalled();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionAck', phase: 'committed', requestId: 'sql-reuse-admission',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison', accepted: true,
		});
		dispatchHostMessage({
			type: 'sqlComparisonAdmissionFinalize', requestId: 'sql-reuse-admission',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison',
		});
		await Promise.resolve();
		expect(comparison.clearResults).not.toHaveBeenCalled();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionAck', phase: 'finalized', requestId: 'sql-reuse-admission',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison', accepted: true,
		});
		dispatchHostMessage({
			type: 'sqlComparisonAdmissionComplete', requestId: 'sql-reuse-admission',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison',
		});
		await Promise.resolve();
		expect(comparison.clearResults).toHaveBeenCalledOnce();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionAck', phase: 'completed', requestId: 'sql-reuse-admission',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison', accepted: true,
		});
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionAck', phase: 'staged', requestId: 'sql-reuse-admission',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison', accepted: true,
		});
		comparison.setQuery.mockClear();
		mocks.postMessageToHost.mockClear();
		dispatchHostMessage({
			type: 'sqlComparisonAdmissionRollback', requestId: 'sql-reuse-admission',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison',
		});
		await Promise.resolve();
		expect(comparison.setQuery).not.toHaveBeenCalled();
		expect(handlerState.optimizationMetadataByBoxId.sql_comparison).toEqual({ sourceBoxId: 'sql_source', isComparison: true });
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionAck', phase: 'rolledBack', requestId: 'sql-reuse-admission',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison', accepted: false,
		});
	});

	it('never rolls back after finalization while completion is delayed past the old deadline', async () => {
		vi.useFakeTimers();
		try {
			expect(handlerState.pState.documentRuntimeActive).toBe(true);
			handlerState.pState.documentKind = 'sqlx';
			handlerState.pState.allowedSectionKinds = ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'];
			const source = createFakeSqlSection() as FakeSqlSection & {
				getServerUrl: () => string; getConnectionId: () => string; getDatabase: () => string;
			};
			const comparison = createFakeSqlSection() as FakeSqlSection & {
				getConnectionId: () => string; getDatabase: () => string; getQuery: () => string;
				getQueryRevision: () => number; setQuery: ReturnType<typeof vi.fn>;
			};
			source.id = 'sql_source';
			comparison.id = 'sql_comparison';
			source.getServerUrl = () => 'server.example';
			source.getConnectionId = () => 'sql-a';
			source.getDatabase = () => 'Db';
			comparison.getConnectionId = () => 'sql-a';
			comparison.getDatabase = () => 'Db';
			let query = 'SELECT old';
			let revision = 1;
			comparison.getQuery = () => query;
			comparison.getQueryRevision = () => revision;
			comparison.setQuery = vi.fn((value: string) => { query = value; revision += 1; });
			handlerState.optimizationMetadataByBoxId.sql_source = { comparisonBoxId: 'sql_comparison' };
			handlerState.optimizationMetadataByBoxId.sql_comparison = { sourceBoxId: 'sql_source', isComparison: true };
			mocks.getSqlSectionElement.mockImplementation((boxId: string) => ({
				sql_source: source, sql_comparison: comparison,
			} as Record<string, FakeSqlSection>)[boxId] || null);

			dispatchHostMessage({
				type: 'ensureComparisonBox', requestId: 'completion-delay', boxId: 'sql_source',
				query: 'SELECT new', engine: 'sql', sourceSectionInstanceId: source.sqlSession.instanceId,
				sourceTargetGeneration: source.sqlSession.targetGeneration,
			});
			await Promise.resolve();
			expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
				type: 'comparisonBoxEnsured', requestId: 'completion-delay', comparisonBoxId: 'sql_comparison',
			}));
			for (const [type, phase] of [
				['sqlComparisonAdmission', 'staged'],
				['sqlComparisonAdmissionCommit', 'committed'],
				['sqlComparisonAdmissionFinalize', 'finalized'],
			] as const) {
				dispatchHostMessage({ type, requestId: 'completion-delay', sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison', accepted: true });
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
				expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
					type: 'sqlComparisonAdmissionAck', phase, accepted: true,
				}));
			}
			mocks.postMessageToHost.mockClear();
			vi.advanceTimersByTime(30_000);

			expect(query).toBe('SELECT new');
			expect(handlerState.optimizationMetadataByBoxId.sql_comparison).toEqual({ sourceBoxId: 'sql_source', isComparison: true });
			expect(mocks.postMessageToHost).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'rolledBack' }));
			dispatchHostMessage({
				type: 'sqlComparisonAdmissionComplete', requestId: 'completion-delay',
				sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison',
			});
			expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
				type: 'sqlComparisonAdmissionAck', phase: 'completed', accepted: true,
			}));
		} finally {
			vi.useRealTimers();
		}
	});

	it('locally retires finalized admission before target detachment and rejects late completion', async () => {
		handlerState.pState.documentKind = 'sqlx';
		handlerState.pState.allowedSectionKinds = ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'];
		const source = createFakeSqlSection() as FakeSqlSection & {
			getServerUrl: () => string; getConnectionId: () => string; getDatabase: () => string;
		};
		const comparison = createFakeSqlSection() as FakeSqlSection & {
			getConnectionId: () => string; getDatabase: () => string;
			setQuery: ReturnType<typeof vi.fn>;
			setComparisonAdmissionPending: ReturnType<typeof vi.fn>;
			setComparisonPersistenceSnapshot: ReturnType<typeof vi.fn>;
		};
		source.id = 'sql_source';
		comparison.id = 'sql_comparison';
		source.getServerUrl = () => 'server.example';
		source.getConnectionId = () => 'sql-a';
		source.getDatabase = () => 'Db';
		comparison.getConnectionId = () => 'sql-a';
		comparison.getDatabase = () => 'Db';
		comparison.setQuery = vi.fn();
		comparison.setComparisonAdmissionPending = vi.fn();
		comparison.setComparisonPersistenceSnapshot = vi.fn();
		document.body.append(source, comparison);
		handlerState.optimizationMetadataByBoxId.sql_source = { comparisonBoxId: 'sql_comparison' };
		handlerState.optimizationMetadataByBoxId.sql_comparison = { sourceBoxId: 'sql_source', isComparison: true };
		mocks.getSqlSectionElement.mockImplementation((boxId: string) => ({
			sql_source: source, sql_comparison: comparison,
		} as Record<string, FakeSqlSection>)[boxId] || null);

		dispatchHostMessage({
			type: 'ensureComparisonBox', requestId: 'finalized-retarget', boxId: 'sql_source',
			query: 'SELECT new', engine: 'sql', sourceSectionInstanceId: source.sqlSession.instanceId,
			sourceTargetGeneration: source.sqlSession.targetGeneration,
		});
		await Promise.resolve();
		for (const [type, phase] of [
			['sqlComparisonAdmission', 'staged'],
			['sqlComparisonAdmissionCommit', 'committed'],
			['sqlComparisonAdmissionFinalize', 'finalized'],
		] as const) {
			dispatchHostMessage({
				type, requestId: 'finalized-retarget', sourceBoxId: 'sql_source',
				comparisonBoxId: 'sql_comparison', accepted: true,
			});
			await Promise.resolve();
			expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
				type: 'sqlComparisonAdmissionAck', phase, accepted: true,
			}));
		}

		expect(retireSqlComparisonAdmission('sql_comparison', 'sql_source')).toBe(true);
		expect(comparison.setComparisonAdmissionPending).toHaveBeenLastCalledWith(false);
		expect(comparison.setComparisonPersistenceSnapshot).toHaveBeenLastCalledWith(undefined);
		expect(comparison.hasAttribute('data-sql-comparison-admission-request-id')).toBe(false);
		mocks.postMessageToHost.mockClear();

		dispatchHostMessage({
			type: 'sqlComparisonAdmissionComplete', requestId: 'finalized-retarget',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison',
		});
		await Promise.resolve();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionAck', phase: 'completed', requestId: 'finalized-retarget',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison', accepted: false,
		});

		dispatchHostMessage({
			type: 'ensureComparisonBox', requestId: 'after-finalized-retarget', boxId: 'sql_source',
			query: 'SELECT retry', engine: 'sql', sourceSectionInstanceId: source.sqlSession.instanceId,
			sourceTargetGeneration: source.sqlSession.targetGeneration,
		});
		await Promise.resolve();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'comparisonBoxEnsured', requestId: 'after-finalized-retarget',
			comparisonBoxId: 'sql_comparison',
		}));
		expect(retireSqlComparisonAdmission('sql_comparison', 'sql_source')).toBe(false);
		dispatchHostMessage({
			type: 'sqlComparisonAdmissionRollback', requestId: 'after-finalized-retarget',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison',
		});
		await Promise.resolve();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionAck', phase: 'rolledBack',
			requestId: 'after-finalized-retarget', sourceBoxId: 'sql_source',
			comparisonBoxId: 'sql_comparison', accepted: true,
		});
	});

	it('restores reused SQL query and persisted results when a committed proposal is rejected', async () => {
		handlerState.pState.documentKind = 'sqlx';
		handlerState.pState.allowedSectionKinds = ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'];
		const source = createFakeSqlSection() as FakeSqlSection & {
			getServerUrl: () => string; getConnectionId: () => string; getDatabase: () => string;
		};
		const comparison = createFakeSqlSection() as FakeSqlSection & {
			getConnectionId: () => string; getDatabase: () => string; getQuery: () => string;
			serialize: () => Record<string, unknown>; setQuery: ReturnType<typeof vi.fn>;
		};
		source.id = 'sql_source';
		comparison.id = 'sql_comparison';
		source.getServerUrl = () => 'server.example';
		source.getConnectionId = () => 'sql-a';
		source.getDatabase = () => 'Db';
		comparison.getConnectionId = () => 'sql-a';
		comparison.getDatabase = () => 'Db';
		comparison.getQuery = () => 'SELECT old';
		comparison.serialize = () => ({ id: 'sql_comparison', type: 'sql', query: 'SELECT old' });
		comparison.setQuery = vi.fn();
		handlerState.pState.queryResultJsonByBoxId = { sql_comparison: '{"rows":[[1]]}' };
		handlerState.pState.resultArtifactByBoxId = { sql_comparison: { artifactId: 'old-artifact' } };
		handlerState.optimizationMetadataByBoxId.sql_source = { comparisonBoxId: 'sql_comparison' };
		handlerState.optimizationMetadataByBoxId.sql_comparison = { sourceBoxId: 'sql_source', isComparison: true };
		mocks.getSqlSectionElement.mockImplementation((boxId: string) => ({
			sql_source: source, sql_comparison: comparison,
		} as Record<string, FakeSqlSection>)[boxId] || null);

		dispatchHostMessage({
			type: 'ensureComparisonBox', requestId: 'sql-reuse-rollback', boxId: 'sql_source',
			query: 'SELECT new', engine: 'sql', sourceSectionInstanceId: source.sqlSession.instanceId,
			sourceTargetGeneration: source.sqlSession.targetGeneration,
		});
		await Promise.resolve();
		dispatchHostMessage({
			type: 'sqlComparisonAdmission', requestId: 'sql-reuse-rollback',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison', accepted: true,
		});
		dispatchHostMessage({
			type: 'sqlComparisonAdmissionCommit', requestId: 'sql-reuse-rollback',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison',
		});
		await Promise.resolve();
		expect(comparison.setQuery).toHaveBeenLastCalledWith('SELECT new');
		expect((handlerState.pState.queryResultJsonByBoxId as any).sql_comparison).toBeUndefined();
		expect(retireSqlComparisonAdmission('sql_comparison', 'sql_source')).toBe(false);

		dispatchHostMessage({
			type: 'sqlComparisonAdmissionRollback', requestId: 'sql-reuse-rollback',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison',
		});
		await Promise.resolve();
		expect(comparison.setQuery).toHaveBeenLastCalledWith('SELECT old');
		expect((handlerState.pState.queryResultJsonByBoxId as any).sql_comparison).toBe('{"rows":[[1]]}');
		expect((handlerState.pState.resultArtifactByBoxId as any).sql_comparison).toEqual({ artifactId: 'old-artifact' });
	});

	it('never overwrites newer query or result revisions while rolling back a committed reuse', async () => {
		handlerState.pState.documentKind = 'sqlx';
		handlerState.pState.allowedSectionKinds = ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'];
		const source = createFakeSqlSection() as FakeSqlSection & {
			getServerUrl: () => string; getConnectionId: () => string; getDatabase: () => string;
		};
		const comparison = createFakeSqlSection() as FakeSqlSection & {
			getConnectionId: () => string; getDatabase: () => string; getQuery: () => string;
			getQueryRevision: () => number; setQuery: ReturnType<typeof vi.fn>;
		};
		source.id = 'sql_source';
		comparison.id = 'sql_comparison';
		source.getServerUrl = () => 'server.example';
		source.getConnectionId = () => 'sql-a';
		source.getDatabase = () => 'Db';
		comparison.getConnectionId = () => 'sql-a';
		comparison.getDatabase = () => 'Db';
		let query = 'SELECT old';
		let queryRevision = 1;
		let resultRevision = 1;
		comparison.getQuery = () => query;
		comparison.getQueryRevision = () => queryRevision;
		comparison.setQuery = vi.fn((value: string) => { query = value; queryRevision += 1; });
		mocks.getResultsStateRevision.mockImplementation((boxId: string) => boxId === 'sql_comparison' ? resultRevision : 0);
		handlerState.pState.queryResultJsonByBoxId = { sql_comparison: '{"rows":[[1]]}' };
		handlerState.pState.resultArtifactByBoxId = { sql_comparison: { artifactId: 'old-artifact' } };
		handlerState.optimizationMetadataByBoxId.sql_source = { comparisonBoxId: 'sql_comparison' };
		handlerState.optimizationMetadataByBoxId.sql_comparison = { sourceBoxId: 'sql_source', isComparison: true };
		mocks.getSqlSectionElement.mockImplementation((boxId: string) => ({
			sql_source: source, sql_comparison: comparison,
		} as Record<string, FakeSqlSection>)[boxId] || null);

		dispatchHostMessage({
			type: 'ensureComparisonBox', requestId: 'sql-reuse-newer-edit', boxId: 'sql_source',
			query: 'SELECT proposed', engine: 'sql', sourceSectionInstanceId: source.sqlSession.instanceId,
			sourceTargetGeneration: source.sqlSession.targetGeneration,
		});
		await Promise.resolve();
		dispatchHostMessage({
			type: 'sqlComparisonAdmission', requestId: 'sql-reuse-newer-edit',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison', accepted: true,
		});
		dispatchHostMessage({
			type: 'sqlComparisonAdmissionCommit', requestId: 'sql-reuse-newer-edit',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison',
		});
		await Promise.resolve();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionAck', phase: 'committed', requestId: 'sql-reuse-newer-edit',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison', accepted: true,
		});
		comparison.setQuery('SELECT user edit');
		resultRevision += 1;
		handlerState.pState.queryResultJsonByBoxId.sql_comparison = '{"rows":[[99]]}';
		handlerState.pState.resultArtifactByBoxId.sql_comparison = { artifactId: 'user-artifact' };
		comparison.setQuery.mockClear();
		dispatchHostMessage({
			type: 'sqlComparisonAdmissionRollback', requestId: 'sql-reuse-newer-edit',
			sourceBoxId: 'sql_source', comparisonBoxId: 'sql_comparison',
		});
		await Promise.resolve();

		expect(comparison.setQuery).not.toHaveBeenCalled();
		expect(query).toBe('SELECT user edit');
		expect(handlerState.pState.queryResultJsonByBoxId.sql_comparison).toBe('{"rows":[[99]]}');
		expect(handlerState.pState.resultArtifactByBoxId.sql_comparison).toEqual({ artifactId: 'user-artifact' });
	});

	it('preserves an edited provisional comparison as an ordinary SQL section on rollback', async () => {
		handlerState.pState.documentKind = 'sqlx';
		handlerState.pState.allowedSectionKinds = ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'];
		const source = createFakeSqlSection() as FakeSqlSection & {
			getServerUrl: () => string; getConnectionId: () => string; getDatabase: () => string;
		};
		const comparison = createFakeSqlSection() as FakeSqlSection & {
			getQuery: () => string; getQueryRevision: () => number;
			setName: (name: string) => void; getName: () => string;
			serializeForComparisonAdmission: () => Record<string, unknown>;
		};
		source.id = 'sql_source';
		comparison.id = 'sql_cmp_request-edit';
		source.getServerUrl = () => 'server.example';
		source.getConnectionId = () => 'sql-a';
		source.getDatabase = () => 'Db';
		const query = 'SELECT proposed';
		let name = 'Optimized SQL';
		comparison.getQuery = () => query;
		comparison.getQueryRevision = () => 1;
		comparison.setName = (value: string) => { name = value; };
		comparison.getName = () => name;
		comparison.serializeForComparisonAdmission = () => ({
			id: comparison.id, type: 'sql', name, query, comparisonSourceBoxId: 'sql_source',
		});
		document.body.append(comparison);
		mocks.getSqlSectionElement.mockImplementation((boxId: string) => ({
			sql_source: source, 'sql_cmp_request-edit': comparison,
		} as Record<string, FakeSqlSection>)[boxId] || null);
		mocks.createSectionWithCapabilities.mockImplementation((_kind: unknown, options: any) => {
			handlerState.optimizationMetadataByBoxId.sql_source = { comparisonBoxId: comparison.id };
			handlerState.optimizationMetadataByBoxId[comparison.id] = { sourceBoxId: 'sql_source', isComparison: true };
			comparison.setAttribute('data-sql-comparison-admission-request-id', String(options.comparisonAdmissionRequestId));
			return { ok: true, sectionId: comparison.id };
		});

		dispatchHostMessage({
			type: 'ensureComparisonBox', requestId: 'request-edit', boxId: 'sql_source',
			query: 'SELECT proposed', engine: 'sql', sourceSectionInstanceId: source.sqlSession.instanceId,
			sourceTargetGeneration: source.sqlSession.targetGeneration,
		});
		await Promise.resolve();
		comparison.setName('Custom user name');
		dispatchHostMessage({
			type: 'sqlComparisonAdmissionCommit', requestId: 'request-edit',
			sourceBoxId: 'sql_source', comparisonBoxId: comparison.id,
		});
		await Promise.resolve();
		dispatchHostMessage({
			type: 'sqlComparisonAdmissionRollback', requestId: 'request-edit',
			sourceBoxId: 'sql_source', comparisonBoxId: comparison.id,
		});
		await Promise.resolve();

		expect(query).toBe('SELECT proposed');
		expect(comparison.getName()).toBe('Custom user name');
		expect(document.getElementById(comparison.id)).toBe(comparison);
		expect(comparison.hasAttribute('data-sql-comparison-admission-request-id')).toBe(false);
		expect(handlerState.optimizationMetadataByBoxId[comparison.id]).toBeUndefined();
		expect((await import('../../src/webview/core/section-factory.js')).removeSqlBox).not.toHaveBeenCalledWith(comparison.id);
	});

	it('reuses the exact SQL comparison on repeated preparation', async () => {
		handlerState.pState.documentKind = 'sqlx';
		handlerState.pState.allowedSectionKinds = ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'];
		const source = createFakeSqlSection() as FakeSqlSection & {
			getServerUrl: () => string; getConnectionId: () => string; getDatabase: () => string;
		};
		const comparison = createFakeSqlSection() as FakeSqlSection & {
			getConnectionId: () => string; getDatabase: () => string;
			setQuery: ReturnType<typeof vi.fn>; clearResults: ReturnType<typeof vi.fn>;
		};
		source.id = 'sql_source';
		comparison.id = 'sql_comparison';
		source.getServerUrl = () => 'server.example';
		source.getConnectionId = () => 'sql-a';
		source.getDatabase = () => 'Db';
		comparison.getConnectionId = () => 'sql-a';
		comparison.getDatabase = () => 'Db';
		comparison.setQuery = vi.fn();
		comparison.clearResults = vi.fn();
		handlerState.optimizationMetadataByBoxId.sql_source = { comparisonBoxId: 'sql_comparison' };
		handlerState.optimizationMetadataByBoxId.sql_comparison = { sourceBoxId: 'sql_source', isComparison: true };
		mocks.getSqlSectionElement.mockImplementation((boxId: string) => ({
			sql_source: source, sql_comparison: comparison,
		} as Record<string, FakeSqlSection>)[boxId] || null);
		mocks.createSectionWithCapabilities.mockClear();

		for (const [index, query] of ['SELECT 2', 'SELECT 3'].entries()) {
			const requestId = `sql-reuse-${index}`;
			dispatchHostMessage({
				type: 'ensureComparisonBox', requestId, boxId: 'sql_source',
				query, engine: 'sql', sourceSectionInstanceId: source.sqlSession.instanceId,
				sourceTargetGeneration: source.sqlSession.targetGeneration,
			});
			await Promise.resolve();
			dispatchHostMessage({
				type: 'sqlComparisonAdmission', requestId, sourceBoxId: 'sql_source',
				comparisonBoxId: 'sql_comparison', accepted: true,
			});
			await Promise.resolve();
			dispatchHostMessage({
				type: 'sqlComparisonAdmissionCommit', requestId, sourceBoxId: 'sql_source',
				comparisonBoxId: 'sql_comparison',
			});
			await Promise.resolve();
			dispatchHostMessage({
				type: 'sqlComparisonAdmissionFinalize', requestId, sourceBoxId: 'sql_source',
				comparisonBoxId: 'sql_comparison',
			});
			await Promise.resolve();
			dispatchHostMessage({
				type: 'sqlComparisonAdmissionComplete', requestId, sourceBoxId: 'sql_source',
				comparisonBoxId: 'sql_comparison',
			});
			await Promise.resolve();
		}

		expect(mocks.createSectionWithCapabilities).not.toHaveBeenCalled();
		expect(comparison.setQuery).toHaveBeenNthCalledWith(1, 'SELECT 2');
		expect(comparison.setQuery).toHaveBeenNthCalledWith(2, 'SELECT 3');
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'comparisonBoxEnsured', requestId: 'sql-reuse-1', comparisonBoxId: 'sql_comparison',
		}));
	});

		it('fully retires an absent SQL comparison before creating its replacement', async () => {
			handlerState.pState.documentKind = 'sqlx';
			handlerState.pState.allowedSectionKinds = ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'];
			const source = createFakeSqlSection() as FakeSqlSection & {
				getServerUrl: () => string; getConnectionId: () => string; getDatabase: () => string;
			};
			source.id = 'sql_source';
			source.getServerUrl = () => 'server.example';
			source.getConnectionId = () => 'sql-a';
			source.getDatabase = () => 'Db';
			handlerState.optimizationMetadataByBoxId.sql_source = { comparisonBoxId: 'sql_stale' };
			handlerState.optimizationMetadataByBoxId.sql_stale = { sourceBoxId: 'sql_source', isComparison: true };
			mocks.getSqlSectionElement.mockImplementation((boxId: string) => boxId === 'sql_source' ? source : null);
			const sectionFactory = await import('../../src/webview/core/section-factory.js');
			vi.mocked(sectionFactory.removeSqlBox).mockClear();
			mocks.createSectionWithCapabilities.mockClear();

			dispatchHostMessage({
				type: 'ensureComparisonBox', requestId: 'sql-replace-stale', boxId: 'sql_source',
				query: 'SELECT replacement', engine: 'sql',
				sourceSectionInstanceId: source.sqlSession.instanceId,
				sourceTargetGeneration: source.sqlSession.targetGeneration,
			});
			await Promise.resolve();

			expect(sectionFactory.removeSqlBox).toHaveBeenCalledOnce();
			expect(sectionFactory.removeSqlBox).toHaveBeenCalledWith('sql_stale');
			expect(mocks.createSectionWithCapabilities).toHaveBeenCalledOnce();
			expect(mocks.createSectionWithCapabilities).toHaveBeenCalledWith('sql', expect.objectContaining({
				query: 'SELECT replacement', comparisonSourceBoxId: 'sql_source',
			}));
		});

	it.each([
		['missing source', undefined, 'instance-sql_1', 0],
		['stale instance', createFakeSqlSection(), 'stale-instance', 0],
		['stale generation', createFakeSqlSection(), 'instance-sql_1', 99],
	] as const)('rejects SQL comparison preparation for %s', async (_label, source, instanceId, generation) => {
		if (source) source.id = 'sql_source';
		mocks.getSqlSectionElement.mockImplementation((boxId: string) => boxId === 'sql_source' ? source : null);
		mocks.createSectionWithCapabilities.mockClear();

		dispatchHostMessage({
			type: 'ensureComparisonBox', requestId: `sql-reject-${_label}`, boxId: 'sql_source',
			query: 'SELECT stale', engine: 'sql',
			sourceSectionInstanceId: instanceId, sourceTargetGeneration: generation,
		});
		await Promise.resolve();

		expect(mocks.createSectionWithCapabilities).not.toHaveBeenCalled();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'comparisonBoxEnsured', requestId: `sql-reject-${_label}`, comparisonBoxId: '',
		}));
	});

	it('marks source settings changed by ensured comparison as agent-touched when dirty', async () => {
		let sourceState = { id: 'query_src', type: 'query', query: 'Source query', runMode: 'take100' };
		let comparisonState = { id: 'query_cmp', type: 'query', query: 'Old comparison query', runMode: 'take100' };
		const { section: sourceSection, shell, setSerializedState: setSourceSerializedState } = createSectionWithShell('query_src', sourceState);
		const { section: comparisonSection, setSerializedState: setComparisonSerializedState } = createSectionWithShell('query_cmp', comparisonState);
		configureFakeKustoTarget(sourceSection);
		configureFakeKustoTarget(comparisonSection, 'connection-old', 'OldDb');
		const comparisonRequest = configureFakeKustoCopilotRequest(sourceSection, 'comparison-request');
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

		dispatchHostMessage({ type: 'ensureComparisonBox', requestId: 'r-ensure-source', boxId: 'query_src', query: 'New comparison query', ...comparisonRequest });
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

	it('rejects stale comparison preparation before mutating the current comparison', async () => {
		const { section: sourceSection } = createSectionWithShell('query_src', { id: 'query_src', type: 'query', query: 'Source query' });
		const { section: comparisonSection } = createSectionWithShell('query_cmp', { id: 'query_cmp', type: 'query', query: 'Current comparison' });
		configureFakeKustoTarget(sourceSection);
		configureFakeKustoTarget(comparisonSection);
		configureFakeKustoCopilotRequest(sourceSection, 'current-comparison-request');
		const setValue = vi.fn();
		handlerState.queryEditors.query_src = { getModel: vi.fn(() => ({ getValue: vi.fn(() => 'Source query') })), getValue: vi.fn(() => 'Source query') };
		handlerState.queryEditors.query_cmp = { setValue };
		handlerState.optimizationMetadataByBoxId.query_src = { comparisonBoxId: 'query_cmp' };
		mocks.getQuerySectionElement.mockImplementation((boxId: string) =>
			boxId === 'query_src' ? sourceSection : boxId === 'query_cmp' ? comparisonSection : null);
		mocks.postMessageToHost.mockClear();

		dispatchHostMessage({
			type: 'ensureComparisonBox', requestId: 'stale-ensure', boxId: 'query_src', query: 'Stale comparison',
			copilotRequestId: 'old-comparison-request', sectionInstanceId: 'instance-query_src', targetGeneration: 1,
		});
		await Promise.resolve();

		expect(setValue).not.toHaveBeenCalled();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'comparisonBoxEnsured', requestId: 'stale-ensure', comparisonBoxId: '',
			copilotRequestId: 'old-comparison-request',
		}));
	});

	it('does not clear a recreated section conversation from an old identity change', () => {
		const currentOwner = { boxId: 'query_src', copilotRequestId: 'current-request', sectionInstanceId: 'instance-new', targetGeneration: 1 };
		const retireOwner = vi.fn((message: Record<string, unknown>) =>
			message.copilotRequestId === currentOwner.copilotRequestId
				&& message.sectionInstanceId === currentOwner.sectionInstanceId
				&& message.targetGeneration === currentOwner.targetGeneration);
		const section = {
			retireKustoCopilotConversationOwner: retireOwner,
		};
		mocks.getQuerySectionElement.mockReturnValue(section);

		dispatchHostMessage({
			type: 'kustoCopilotIdentityChanged', boxId: 'query_recreated',
			copilotRequestId: 'old-request', sectionInstanceId: 'instance-old', targetGeneration: 1,
		});
		dispatchHostMessage({ type: 'kustoCopilotIdentityChanged', boxId: 'query_recreated', ...currentOwner });

		expect(retireOwner).toHaveBeenCalledTimes(2);
		expect(retireOwner).toHaveNthReturnedWith(1, false);
		expect(retireOwner).toHaveNthReturnedWith(2, true);
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

	it('reuses a SQL-derived comparison without Kusto target synchronization', async () => {
		const { section: sourceSection } = createSectionWithShell('sql_source', { id: 'sql_source', type: 'sql', query: 'SELECT 1' });
		const { section: comparisonSection } = createSectionWithShell('query_cmp', { id: 'query_cmp', type: 'query', query: 'SELECT 2' });
		const setValue = vi.fn();
		const clearComparisonResults = vi.fn();
		(comparisonSection as any).clearResults = clearComparisonResults;
		handlerState.queryEditors.sql_source = {
			getModel: vi.fn(() => ({ getValue: vi.fn(() => 'SELECT 1') })),
			getValue: vi.fn(() => 'SELECT 1'),
		};
		handlerState.queryEditors.query_cmp = { setValue, getValue: vi.fn(() => 'SELECT 2') };
		handlerState.optimizationMetadataByBoxId.sql_source = { comparisonBoxId: 'query_cmp' };
		handlerState.optimizationMetadataByBoxId.query_cmp = { sourceBoxId: 'sql_source', isComparison: true };
		mocks.getConnectionId.mockReturnValue('sql-connection');
		mocks.getDatabase.mockReturnValue('Db');
		mocks.postMessageToHost.mockClear();
		const { optimizeQueryWithCopilot } = await import('../../src/webview/sections/query-execution.controller.js');

		const comparisonId = await optimizeQueryWithCopilot('sql_source', 'SELECT 3', { skipExecute: true });

		expect(comparisonId).toBe('query_cmp');
		expect(setValue).toHaveBeenCalledWith('SELECT 3');
		expect(mocks.clearStoredQueryResult).toHaveBeenCalledWith('query_cmp');
		expect(mocks.retireResultsStateForRerun).toHaveBeenCalledWith('query_cmp');
		expect(clearComparisonResults).toHaveBeenCalledOnce();
		expect(mocks.postMessageToHost).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'showInfo', message: expect.stringContaining('still updating'),
		}));
		expect(sourceSection.tagName.toLowerCase()).toBe('kw-sql-section');
		expect(comparisonSection.tagName.toLowerCase()).toBe('kw-query-section');
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

	it('rejects delegated Kusto Copilot auto-create in MDX before mutation', async () => {
		handlerState.pState.documentKind = 'mdx';
		handlerState.pState.allowedSectionKinds = ['markdown', 'url', 'transformation'];

		dispatchHostMessage({ type: 'toolDelegateToKustoWorkbenchCopilot', requestId: 'mdx-kusto-new', input: { question: 'Help' } });
		await Promise.resolve();
		await Promise.resolve();

		expect(mocks.createSectionWithCapabilities).toHaveBeenCalledWith('query');
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'toolResponse', requestId: 'mdx-kusto-new', result: { success: false },
			error: expect.stringContaining('unavailable'),
		}));
	});

	it('honors delegated Kusto Copilot cancellation before the request starts', async () => {
		dispatchHostMessage({ type: 'toolCancelKustoCopilot', requestId: 'r-kusto-pre-cancel' });
		dispatchHostMessage({
			type: 'toolDelegateToKustoWorkbenchCopilot', requestId: 'r-kusto-pre-cancel',
			input: { sectionId: 'query_1', question: 'Do not start' },
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolResponse', requestId: 'r-kusto-pre-cancel',
			result: { success: false, error: 'Copilot request was cancelled.' },
		});
		expect(mocks.getQuerySectionElement).not.toHaveBeenCalled();
	});

	it('does not let delayed delegated cancellation cancel a newer Copilot owner', async () => {
		const { section } = createSectionWithShell('query_1', { id: 'query_1', type: 'query', query: 'print 1' });
		const oldOwner = { boxId: 'query_1', copilotRequestId: 'delegated-old', sectionInstanceId: 'instance-old', targetGeneration: 1 };
		const newOwner = { boxId: 'query_1', copilotRequestId: 'delegated-new', sectionInstanceId: 'instance-new', targetGeneration: 1 };
		let currentOwner = oldOwner;
		const cancelExact = vi.fn((expected: typeof oldOwner) => expected.copilotRequestId === currentOwner.copilotRequestId);
		Object.assign(section, {
			setCopilotChatVisible: vi.fn(),
			copilotWriteQuerySend: vi.fn(),
			getActiveKustoCopilotRequest: vi.fn(() => oldOwner),
			cancelKustoCopilotRequest: cancelExact,
		});
		mocks.getQuerySectionElement.mockReturnValue(section);
		mocks.getConnectionId.mockReturnValue('conn-1');
		mocks.getDatabase.mockReturnValue('db-1');
		const chatPane = document.createElement('div');
		chatPane.id = 'query_1_copilot_chat_pane';
		const chatElement = document.createElement('kw-copilot-chat') as any;
		chatElement.setInputText = vi.fn();
		chatElement.setRequireToolUseOnNextSend = vi.fn();
		chatPane.appendChild(chatElement);
		document.body.appendChild(chatPane);

		dispatchHostMessage({
			type: 'toolDelegateToKustoWorkbenchCopilot', requestId: 'r-kusto-stale-cancel',
			input: { sectionId: 'query_1', question: 'Start old request' },
		});
		await new Promise(resolve => setTimeout(resolve, 120));
		currentOwner = newOwner;
		dispatchHostMessage({ type: 'toolCancelKustoCopilot', requestId: 'r-kusto-stale-cancel' });

		expect(cancelExact).toHaveBeenCalledWith(oldOwner);
		expect(cancelExact).toHaveReturnedWith(false);

		window.dispatchEvent(new CustomEvent('kusto-workbench-copilot-output', {
			detail: { type: 'copilotWriteQueryDone', ...oldOwner, ok: false, message: 'Stopped' },
		}));
	});

	it('settles delegated Kusto Copilot immediately when its exact owner is invalidated', async () => {
		const { section } = createSectionWithShell('query_1', { id: 'query_1', type: 'query', query: 'print 1' });
		const owner = { boxId: 'query_1', copilotRequestId: 'delegated-invalidated', sectionInstanceId: 'instance-old', targetGeneration: 1 };
		Object.assign(section, {
			setCopilotChatVisible: vi.fn(),
			copilotWriteQuerySend: vi.fn(),
			getActiveKustoCopilotRequest: vi.fn(() => owner),
			retireKustoCopilotConversationOwner: vi.fn((identity: typeof owner) => {
				if (identity.copilotRequestId !== owner.copilotRequestId) return false;
				window.dispatchEvent(new CustomEvent('kusto-workbench-copilot-output', {
					detail: { type: 'copilotWriteQueryDone', ...owner, ok: false, message: 'Canceled.', retired: true },
				}));
				return true;
			}),
		});
		mocks.getQuerySectionElement.mockReturnValue(section);
		mocks.getConnectionId.mockReturnValue('conn-1');
		mocks.getDatabase.mockReturnValue('db-1');
		const chatPane = document.createElement('div');
		chatPane.id = 'query_1_copilot_chat_pane';
		const chatElement = document.createElement('kw-copilot-chat') as any;
		chatElement.setInputText = vi.fn();
		chatElement.setRequireToolUseOnNextSend = vi.fn();
		chatPane.appendChild(chatElement);
		document.body.appendChild(chatPane);

		dispatchHostMessage({
			type: 'toolDelegateToKustoWorkbenchCopilot', requestId: 'r-kusto-invalidated',
			input: { sectionId: 'query_1', question: 'Start request' },
		});
		await new Promise(resolve => setTimeout(resolve, 120));
		mocks.postMessageToHost.mockClear();
		dispatchHostMessage({ type: 'kustoCopilotIdentityChanged', ...owner });

		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolResponse', requestId: 'r-kusto-invalidated',
			result: { success: false, error: 'Canceled.', query: undefined },
		});
		expect(mocks.unbindResultArtifactConsumer).toHaveBeenCalledWith('model:r-kusto-invalidated:result');
	});

	async function runDelegatedKustoCopilotResponseTest(options: {
		maxResultRows?: unknown;
		rowCount: number;
		resultBeforeDone?: boolean;
		oldTerminalBeforeStart?: boolean;
		cancelBeforeDone?: boolean;
		advanceCurrentBeforeDone?: boolean;
		revokeBeforeDone?: boolean;
		allowSendToModel?: boolean;
		advanceQueryBeforeDone?: boolean;
		advanceQueryBeforeStart?: boolean;
		artifactLookupThrows?: boolean;
	}) {
		if (!getResultsStateMock) {
			const resultsState = await import('../../src/webview/core/results-state.js');
			getResultsStateMock = resultsState.getResultsState as unknown as ReturnType<typeof vi.fn>;
		}
		const { section } = createSectionWithShell('query_1', { id: 'query_1', type: 'query', query: 'range Index from 1 to 10 step 1' });
		(section as any).setCopilotChatVisible = vi.fn();
		const lifecycle = { sectionInstanceId: 'instance-query_1', targetGeneration: 4 };
		const copilotOwner = { boxId: 'query_1', ...lifecycle, copilotRequestId: 'delegated-copilot-request' };
		let activeOwner: Record<string, unknown> | undefined;
		(section as any).getSchemaLifecycleIdentity = vi.fn(() => lifecycle);
		(section as any).getConnectionId = vi.fn(() => 'conn-1');
		(section as any).getDatabase = vi.fn(() => 'db-1');
		(section as any).beginQueryExecution = vi.fn((executionId: string, producer: string) => {
			activeOwner = {
				engine: 'kusto', boxId: 'query_1', executionId,
				...lifecycle, connectionId: 'conn-1', database: 'db-1', producer,
			};
			return true;
		});
		(section as any).getActiveExecution = vi.fn(() => activeOwner);
		(section as any).getActiveKustoCopilotRequest = vi.fn(() => copilotOwner);
		(section as any).admitKustoCopilotMessage = vi.fn((message: Record<string, unknown>) =>
			message.copilotRequestId === copilotOwner.copilotRequestId
				&& message.sectionInstanceId === copilotOwner.sectionInstanceId
				&& message.targetGeneration === copilotOwner.targetGeneration);
		(section as any).getActiveExecutionId = vi.fn(() => String(activeOwner?.executionId || ''));
		(section as any).admitQueryTerminal = vi.fn((identity: Record<string, unknown>) =>
			activeOwner
				&& identity.executionId === activeOwner.executionId
				&& identity.sectionInstanceId === activeOwner.sectionInstanceId
				&& identity.targetGeneration === activeOwner.targetGeneration
				? 'active' : 'rejected');
		(section as any).acceptsQueryTerminal = vi.fn((executionId: string) => activeOwner?.executionId === executionId);
		(section as any).completeQueryExecution = vi.fn((executionId: string) => {
			if (activeOwner?.executionId !== executionId) return false;
			activeOwner = undefined;
			return true;
		});
		mocks.getQuerySectionElement.mockReturnValue(section);
		mocks.getConnectionId.mockReturnValue('conn-1');
		mocks.getDatabase.mockReturnValue('db-1');
		const executedQuery = 'range Index from 1 to 10 step 1';
		const getEditorQuery = vi.fn(() => executedQuery);
		handlerState.queryEditors.query_1 = { getValue: getEditorQuery };

		const rows = Array.from({ length: options.rowCount }, (_unused, index) => [index + 1]);
		const columns = ['Index'];
		getResultsStateMock.mockReturnValue({ columns, rows } as any);
		const resultArtifact = {
			artifactId: 'result:query_1:delegated', sourceBoxId: 'query_1', revision: 1, createdAt: 1,
			restored: false, columns, rows, metadata: {},
			producer: { engine: 'kusto', boxId: 'query_1', executionId: 'delegated-kusto-execution' },
			policy: { sendToModel: options.allowSendToModel !== false }, lineage: [],
		};
		if (options.artifactLookupThrows) {
			mocks.getResultArtifactByProducerExecution.mockImplementationOnce(() => {
				throw new Error('synthetic delegated artifact lookup failure');
			});
		} else {
			mocks.getResultArtifactByProducerExecution.mockReturnValue(resultArtifact);
		}
		mocks.bindResultArtifactConsumer.mockReturnValue(resultArtifact.artifactId);
		mocks.getBoundResultArtifact.mockReturnValue(resultArtifact);

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

		(section as any).copilotWriteQuerySend = vi.fn(() => queueMicrotask(() => {
			const executionId = 'delegated-kusto-execution';
			if (options.oldTerminalBeforeStart) {
				window.dispatchEvent(new CustomEvent('kusto-workbench-query-terminal', {
					detail: {
						type: 'queryCancelled', engine: 'kusto', boxId: 'query_1', executionId: 'old-copilot-execution',
						...lifecycle, connectionId: 'conn-1', database: 'db-1', producer: 'copilot',
						copilotRequestId: 'old-copilot-request', reservationSequence: 1, reason: 'superseded',
					},
				}));
			}
			const owner = {
				type: 'kustoExecutionStarted', engine: 'kusto', boxId: 'query_1', executionId,
				...lifecycle, connectionId: 'conn-1', database: 'db-1', producer: 'copilot',
				copilotRequestId: copilotOwner.copilotRequestId, reservationSequence: 1, query: executedQuery,
			};
			if (options.advanceQueryBeforeStart) getEditorQuery.mockReturnValue('print newer_query=2');
			dispatchHostMessage({
				...owner,
			});
			const queryResultMessage = {
				...owner, type: 'queryResult', dispatch: kustoDispatch('delegated-copilot'), result: { rows, columns, metadata: {} },
			};
			const doneMessage = { type: 'copilotWriteQueryDone', boxId: 'query_1', ok: true, ...copilotOwner };
			if (options.cancelBeforeDone) {
				dispatchHostMessage({ ...owner, type: 'queryCancelled', reason: 'cancelled' });
				dispatchHostMessage(doneMessage);
				return;
			}
			if (options.resultBeforeDone) {
				dispatchHostMessage(queryResultMessage);
				if (options.advanceCurrentBeforeDone) {
					getResultsStateMock.mockReturnValue({ columns, rows: [['newer-current-b']] } as any);
				}
				if (options.advanceQueryBeforeDone) getEditorQuery.mockReturnValue('print newer_query=2');
				if (options.revokeBeforeDone) mocks.getBoundResultArtifact.mockReturnValue(null);
				dispatchHostMessage(doneMessage);
			} else {
				dispatchHostMessage(doneMessage);
				dispatchHostMessage(queryResultMessage);
			}
		}));

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

	it('ignores an old Copilot terminal that arrives before the delegated request execution starts', async () => {
		const result = await runDelegatedKustoCopilotResponseTest({ rowCount: 3, oldTerminalBeforeStart: true });

		expect(result).toMatchObject({ success: true, rowCount: 3, results: [[1], [2], [3]] });
	});

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

	it('returns exact artifact A when mutable current advances to B before Copilot completion', async () => {
		const result = await runDelegatedKustoCopilotResponseTest({
			rowCount: 3, resultBeforeDone: true, advanceCurrentBeforeDone: true,
		});

		expect(result).toMatchObject({ success: true, rowCount: 3, results: [[1], [2], [3]] });
		expect(mocks.bindResultArtifactConsumer).toHaveBeenCalledWith(
			'model:r-kusto-copilot-results:result', 'query_1', 'result:query_1:delegated',
		);
		expect(mocks.unbindResultArtifactConsumer).toHaveBeenCalledWith('model:r-kusto-copilot-results:result');
	});

	it('returns the query captured for artifact A when the editor advances before completion', async () => {
		const result = await runDelegatedKustoCopilotResponseTest({
			rowCount: 3, resultBeforeDone: true, advanceQueryBeforeDone: true,
		});

		expect(result).toMatchObject({
			success: true,
			query: 'range Index from 1 to 10 step 1',
			results: [[1], [2], [3]],
		});
	});

	it('returns the host-captured query when the editor advances before execution start', async () => {
		const result = await runDelegatedKustoCopilotResponseTest({
			rowCount: 3, resultBeforeDone: true, advanceQueryBeforeStart: true,
		});

		expect(result).toMatchObject({
			success: true,
			query: 'range Index from 1 to 10 step 1',
			results: [[1], [2], [3]],
		});
	});

	it('settles delegated Kusto Copilot when terminal artifact lookup throws', async () => {
		const result = await runDelegatedKustoCopilotResponseTest({ rowCount: 3, artifactLookupThrows: true });

		expect(result).toMatchObject({
			success: false,
			error: 'synthetic delegated artifact lookup failure',
		});
		expect(mocks.unbindResultArtifactConsumer).toHaveBeenCalledWith('model:r-kusto-copilot-results:result');
	});

	it('fails closed when the exact result artifact denies sendToModel', async () => {
		const result = await runDelegatedKustoCopilotResponseTest({ rowCount: 3, allowSendToModel: false });

		expect(result).toMatchObject({
			success: false,
			error: 'Query results are not permitted for model use.',
		});
		expect(result).not.toHaveProperty('results');
		expect(mocks.unbindResultArtifactConsumer).toHaveBeenCalledWith('model:r-kusto-copilot-results:result');
	});

	it('fails closed when the exact result artifact is revoked before Copilot completion', async () => {
		const result = await runDelegatedKustoCopilotResponseTest({
			rowCount: 3, resultBeforeDone: true, revokeBeforeDone: true,
		});

		expect(result).toMatchObject({
			success: false,
			error: 'Query results are not permitted for model use.',
		});
		expect(result).not.toHaveProperty('results');
	});

	it('settles and releases the model binding when query cancellation arrives before Copilot completion', async () => {
		const result = await runDelegatedKustoCopilotResponseTest({ rowCount: 3, cancelBeforeDone: true });

		expect(result).toMatchObject({ success: false, error: 'Query execution was cancelled.' });
		expect(mocks.unbindResultArtifactConsumer).toHaveBeenCalledWith('model:r-kusto-copilot-results:result');
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
		const markdown = document.createElement('div');
		Object.defineProperty(markdown, 'tagName', { value: 'KW-MARKDOWN-SECTION', configurable: true });
		markdown.id = 'markdown_1';
		document.body.appendChild(markdown);
		try {
			dispatchHostMessage({
				type: 'toolUpdateMarkdownSection',
				requestId: 'r2',
				input: { sectionId: 'markdown_1', name: 'Summary' },
			});
			await new Promise(r => setTimeout(r, 50));
			expect(setSectionNameSpy).toHaveBeenCalledWith('markdown_1', 'Summary');
		} finally {
			markdown.remove();
		}
	});

	it('toolUpdateMarkdownSection rejects a missing section', async () => {
		dispatchHostMessage({
			type: 'toolUpdateMarkdownSection',
			requestId: 'missing-markdown',
			input: { sectionId: 'markdown_missing', text: 'not applied' },
		});
		await new Promise(r => setTimeout(r, 50));
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'toolResponse', requestId: 'missing-markdown',
			result: { success: false }, error: 'Markdown section not found',
		});
	});

	it('toolUpdateMarkdownSection clears pending text after updating a live editor', async () => {
		const markdown = document.createElement('div');
		Object.defineProperty(markdown, 'tagName', { value: 'KW-MARKDOWN-SECTION', configurable: true });
		markdown.id = 'markdown_live';
		document.body.appendChild(markdown);
		const setValue = vi.fn();
		(window as any).__kustoMarkdownEditors = { markdown_live: { setValue } };
		(handlerState.pState as any).pendingMarkdownTextByBoxId = {};
		try {
			dispatchHostMessage({
				type: 'toolUpdateMarkdownSection', requestId: 'live-markdown',
				input: { sectionId: 'markdown_live', text: 'tool text' },
			});
			await new Promise(resolve => setTimeout(resolve, 50));
			expect(setValue).toHaveBeenCalledWith('tool text');
			expect((handlerState.pState as any).pendingMarkdownTextByBoxId).not.toHaveProperty('markdown_live');
		} finally {
			delete (window as any).__kustoMarkdownEditors;
			markdown.remove();
		}
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
		const transformation = document.createElement('div');
		Object.defineProperty(transformation, 'tagName', {
			value: 'KW-TRANSFORMATION-SECTION', configurable: true,
		});
		transformation.id = 'transformation_1';
		document.body.appendChild(transformation);
		try {
			dispatchHostMessage({
				type: 'toolConfigureTransformation',
				requestId: 'r4',
				input: { sectionId: 'transformation_1', name: 'Pivot Data' },
			});
			await new Promise(r => setTimeout(r, 50));
			expect(setSectionNameSpy).toHaveBeenCalledWith('transformation_1', 'Pivot Data');
		} finally {
			transformation.remove();
		}
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

	it('toolConfigureHtmlSection rejects a Python section before invoking its mutators', async () => {
		const persistence = await import('../../src/webview/core/persistence.js');
		vi.mocked(persistence.schedulePersist).mockClear();
		const python = document.createElement('kw-python-section') as HTMLElement & {
			getCode: ReturnType<typeof vi.fn>;
			setCode: ReturnType<typeof vi.fn>;
			setMode: ReturnType<typeof vi.fn>;
		};
		python.id = 'python_not_html';
		python.getCode = vi.fn(() => 'print(1)');
		python.setCode = vi.fn();
		python.setMode = vi.fn();
		document.body.appendChild(python);

		dispatchHostMessage({
			type: 'toolConfigureHtmlSection', requestId: 'html-tool-on-python',
			sectionId: python.id, code: '<main>wrong kind</main>', mode: 'preview',
		});
		await new Promise(resolve => setTimeout(resolve, 50));

		expect(python.setCode).not.toHaveBeenCalled();
		expect(python.setMode).not.toHaveBeenCalled();
		expect(persistence.schedulePersist).not.toHaveBeenCalled();
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'toolResponse', requestId: 'html-tool-on-python',
			result: { success: false, sectionId: 'python_not_html' },
		}));
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
