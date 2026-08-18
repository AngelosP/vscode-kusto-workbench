import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => {
	const queryBoxes: string[] = [];
	const chartBoxes: string[] = [];
	const transformationBoxes: string[] = [];
	const markdownBoxes: string[] = [];
	const pythonBoxes: string[] = [];
	const urlBoxes: string[] = [];
	const htmlBoxes: string[] = [];
	const sqlBoxes: string[] = [];
	const queryEditors: Record<string, { getValue: () => string; layout?: () => void }> = {};
	const markdownEditors: Record<string, { getValue: () => string }> = {};
	const queryExecutionTimers: Record<string, unknown> = {};
	const optimizationMetadataByBoxId: Record<string, unknown> = {};
	const sqlElements: Record<string, HTMLElement & {
		setFavoritesMode: ReturnType<typeof vi.fn>;
		setLeaveNoTraceConnectionIds: ReturnType<typeof vi.fn>;
		canPersistResults: () => boolean;
		getConnectionId: () => string;
		getSqlConnectionId: () => string;
		getDatabase: () => string;
		getQuery: () => string;
	}> = {};
	const sqlLeaveNoTraceConnectionIds: string[] = [];
	const sqlConnections: Array<{ id: string; serverUrl: string }> = [];
	const kustoConnections: Array<{ id: string; clusterUrl: string; authorityId?: string; accountPartition?: string }> = [];
	const postMessageToHost = vi.fn();
	const schemaDiagnosticsTrustedByBoxId: Record<string, boolean> = {};
	const schemaFetchInFlightByBoxId: Record<string, unknown> = {};
	const beginKustoPreparation = vi.fn((boxId: string) => ({ boxId, generation: 1, revision: 0 }));
	const getKustoPreparationState = vi.fn(() => ({ status: 'idle', stage: 'idle', blockers: [] }));
	const getCurrentResultArtifact = vi.fn(() => null as any);

	const addQueryBox = vi.fn((options: { id?: string; clusterUrl?: string; authorityId?: string; connectionIdHint?: string; database?: string } = {}) => {
		const id = options.id || `query_restored_${addQueryBox.mock.calls.length + 1}`;
		queryBoxes.push(id);
		queryEditors[id] = { getValue: () => '' };
		const el = document.createElement('kw-query-section') as HTMLElement & { serialize?: () => unknown; getClusterUrl?: () => string; getConnectionId?: () => string; getDatabase?: () => string; clearResults?: ReturnType<typeof vi.fn> };
		el.id = id;
		el.getClusterUrl = () => String(options.clusterUrl || '');
		el.getConnectionId = () => {
			const matches = kustoConnections.filter(connection => connection.clusterUrl === String(options.clusterUrl || '')
				&& String(connection.authorityId || '') === String(options.authorityId || ''));
			const hinted = matches.find(connection => connection.id === String(options.connectionIdHint || ''));
			return hinted?.id || (matches.length === 1 ? matches[0].id : '');
		};
		el.getDatabase = () => String(options.database || '');
		el.clearResults = vi.fn();
		el.serialize = () => ({
			id,
			type: 'query',
			query: queryEditors[id]?.getValue?.() || (window as any).__testPendingQueryTextByBoxId?.[id] || '',
			...(typeof (window as any).__testQueryResultJsonByBoxId?.[id] === 'string' && (window as any).__testQueryResultJsonByBoxId[id]
				? { resultJson: (window as any).__testQueryResultJsonByBoxId[id] }
				: {}),
		});
		(document.getElementById('queries-container') || document.body).appendChild(el);
		return id;
	});

	const addMarkdownBox = vi.fn((options: { id?: string } = {}) => {
		const id = options.id || `markdown_restored_${addMarkdownBox.mock.calls.length + 1}`;
		markdownBoxes.push(id);
		markdownEditors[id] = { getValue: () => '' };
		const el = document.createElement('kw-markdown-section');
		el.id = id;
		(document.getElementById('queries-container') || document.body).appendChild(el);
		return id;
	});

	const addUrlBox = vi.fn((options: { id?: string } = {}) => {
		const id = options.id || `url_restored_${addUrlBox.mock.calls.length + 1}`;
		urlBoxes.push(id);
		const el = document.createElement('kw-url-section');
		el.id = id;
		(document.getElementById('queries-container') || document.body).appendChild(el);
		return id;
	});

	const addHtmlBox = vi.fn((options: { id?: string } = {}) => {
		const id = options.id || `html_restored_${htmlBoxes.length + 1}`;
		htmlBoxes.push(id);
		const el = document.createElement('kw-html-section');
		el.id = id;
		(document.getElementById('queries-container') || document.body).appendChild(el);
		return id;
	});

	const addSqlBox = vi.fn((options: { id?: string; database?: string } = {}) => {
		const id = options.id || `sql_restored_${sqlBoxes.length + 1}`;
		sqlBoxes.push(id);
		let protectedConnectionIds = new Set<string>();
		const selectedConnectionId = sqlConnections.find(connection => connection.serverUrl === (options as any).serverUrl)?.id || '';
		const el = document.createElement('kw-sql-section') as HTMLElement & {
			serialize: () => unknown;
			setFavoritesMode: ReturnType<typeof vi.fn>;
			setLeaveNoTraceConnectionIds: ReturnType<typeof vi.fn>;
			canPersistResults: () => boolean;
			getConnectionId: () => string;
			getSqlConnectionId: () => string;
			getDatabase: () => string;
			getQuery: () => string;
		};
		el.id = id;
		el.setFavoritesMode = vi.fn();
		el.setLeaveNoTraceConnectionIds = vi.fn((ids: string[]) => { protectedConnectionIds = new Set(ids); });
		el.getConnectionId = () => selectedConnectionId;
		el.getSqlConnectionId = () => selectedConnectionId;
		el.getDatabase = () => String(options.database || '');
		el.getQuery = () => String((window as any).__testPendingSqlQueryByBoxId?.[id] || '');
		el.serialize = () => ({
			id, type: 'sql', query: el.getQuery(), expanded: true,
			...(options && (options as any).comparisonSourceBoxId
				? { comparisonSourceBoxId: String((options as any).comparisonSourceBoxId) }
				: {}),
		});
		el.canPersistResults = () => {
			const currentConnectionId = el.getConnectionId();
			return !currentConnectionId || !protectedConnectionIds.has(currentConnectionId);
		};
		sqlElements[id] = el;
		const resultsWrapper = document.createElement('div');
		resultsWrapper.id = `${id}_sql_results_wrapper`;
		(document.getElementById('queries-container') || document.body).appendChild(el);
		document.body.appendChild(resultsWrapper);
		return id;
	});

	return {
		queryBoxes,
		chartBoxes,
		transformationBoxes,
		markdownBoxes,
		pythonBoxes,
		urlBoxes,
		htmlBoxes,
		sqlBoxes,
		queryEditors,
		markdownEditors,
		queryExecutionTimers,
		optimizationMetadataByBoxId,
		sqlElements,
		sqlLeaveNoTraceConnectionIds,
		sqlConnections,
		kustoConnections,
		addQueryBox,
		addMarkdownBox,
		addUrlBox,
		addHtmlBox,
		addSqlBox,
		postMessageToHost,
		schemaDiagnosticsTrustedByBoxId,
		schemaFetchInFlightByBoxId,
		beginKustoPreparation,
		getKustoPreparationState,
		getCurrentResultArtifact,
	};
});

vi.mock('../../src/webview/shared/persistence-utils.js', () => ({
	normalizeClusterUrl: vi.fn((url: unknown) => String(url || '').trim().toLowerCase()),
	isLeaveNoTraceCluster: vi.fn((clusterUrl: unknown, protectedClusters: unknown[]) =>
		protectedClusters.map(value => String(value || '').trim().toLowerCase()).includes(String(clusterUrl || '').trim().toLowerCase())),
	byteLengthUtf8: vi.fn((v: unknown) => String(v ?? '').length),
	normalizePersistedResultJson: vi.fn((value: unknown) => {
		const text = String(value || '');
		try {
			const parsed = JSON.parse(text);
			const columns = Array.isArray(parsed?.columns) ? parsed.columns : [];
			const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
			if (rows.every((row: unknown) => Array.isArray(row) && row.length === columns.length)) return text;
			return JSON.stringify({
				...parsed,
				rows: rows.map((row: unknown) => Array.from(
					{ length: columns.length }, (_, index) => Array.isArray(row) ? row[index] : undefined,
				)),
			});
		} catch { return text; }
	}),
	trySerializeQueryResult: vi.fn(() => ({ json: null })),
}));

vi.mock('../../src/webview/shared/webview-messages.js', () => ({
	postMessageToHost: testState.postMessageToHost,
}));

vi.mock('../../src/webview/shared/persistence-state.js', () => {
	const queryEditorPendingAddKinds = [
		'query', 'chart', 'transformation', 'markdown', 'python', 'url',
	] as const;
	const createEmptyQueryEditorPendingAdds = () => ({
		query: 0, chart: 0, transformation: 0, markdown: 0, python: 0, url: 0,
	});
	return {
		queryEditorPendingAddKinds,
		createEmptyQueryEditorPendingAdds,
		pState: {
		compatibilityMode: false,
		compatibilitySingleKind: 'query',
		allowedSectionKinds: ['query', 'chart', 'transformation', 'python', 'url', 'markdown'],
		defaultSectionKind: 'query',
		upgradeRequestType: 'requestUpgradeToKqlx',
		documentKind: 'kqlx',
		documentMutationAllowed: true,
		documentRuntimeActive: true,
		documentEditRevision: 0,
		documentViewSessionId: '',
		compatibilityPersistenceViewSessionId: '',
		compatibilityPersistenceDocumentRequestIds: new Set<string>(),
		compatibilityPersistenceAppliedDocumentRequests: new Map<string, string>(),
		documentViewInitialProjectionRequestId: '',
		documentViewProjectionRequestIds: new Set<string>(),
		documentUri: '',
		compatibilityTooltip: '',
		htmlPowerBiCompatibilityCheckEnabled: true,
		restoreInProgress: false,
		queryEditorPendingAdds: createEmptyQueryEditorPendingAdds(),
		pendingQueryTextByBoxId: {} as Record<string, string>,
		pendingMarkdownTextByBoxId: {} as Record<string, string>,
		pendingPythonCodeByBoxId: {} as Record<string, string>,
		pendingHtmlCodeByBoxId: {} as Record<string, string>,
		pendingSqlQueryByBoxId: {} as Record<string, string>,
		pendingWrapperHeightPxByBoxId: {} as Record<string, number>,
		manualQueryEditorHeightPxByBoxId: {} as Record<string, number>,
		resultsVisibleByBoxId: {} as Record<string, boolean>,
		queryResultJsonByBoxId: {} as Record<string, string>,
		resultArtifactByBoxId: {} as Record<string, any>,
		kustoResultOwnerByBoxId: {} as Record<string, { accountPartition: string; leaveNoTraceRevision: number }>,
		lastExecutedBox: '',
		documentDataApplyCount: 0,
		documentDefaultsFinalizedApplyCount: -1,
		copilotChatFirstTimeDismissed: false,
		isSessionFile: false,
		metadataFreeDevelopmentNoteSections: [],
		},
	};
});

vi.mock('../../src/webview/core/results-state.js', () => ({
	captureResultsRuntime: vi.fn(() => ({ token: 'results-runtime' })),
	restoreResultsRuntime: vi.fn(),
	displayResult: vi.fn(),
	displayResultForBox: vi.fn(),
	clearResultsState: vi.fn(),
	getResultsState: vi.fn(() => null),
	getResultsStateRevision: vi.fn(() => 0),
	getCurrentResultArtifact: testState.getCurrentResultArtifact,
}));

vi.mock('../../src/webview/core/section-factory.js', () => ({
	__kustoWithPinnedSectionRemovalBypass: <T>(work: () => T) => work(),
	addQueryBox: testState.addQueryBox,
	removeQueryBox: vi.fn((id: string) => {
		const idx = testState.queryBoxes.indexOf(id);
		if (idx >= 0) testState.queryBoxes.splice(idx, 1);
		document.getElementById(id)?.remove();
	}),
	updateConnectionSelects: vi.fn(),
	toggleCacheControls: vi.fn(),
	__kustoGetQuerySectionElement: vi.fn(() => null),
	__kustoSetSectionName: vi.fn(),
	__kustoGetConnectionId: vi.fn(() => ''),
	__kustoGetDatabase: vi.fn(() => ''),
	__kustoSetAutoEnterFavoritesForBox: vi.fn(),
	__kustoTryAutoEnterFavoritesModeForAllBoxes: vi.fn(),
	__kustoClampResultsWrapperHeight: vi.fn(),
	addPythonBox: vi.fn((options?: { id?: string }) => {
		const id = String(options?.id || `python_restored_${testState.pythonBoxes.length + 1}`);
		testState.pythonBoxes.push(id);
		const el = document.createElement('kw-python-section');
		el.id = id;
		(document.getElementById('queries-container') || document.body).appendChild(el);
		return id;
	}),
	addUrlBox: testState.addUrlBox,
	removePythonBox: vi.fn(),
	removeUrlBox: vi.fn(),
	addHtmlBox: testState.addHtmlBox,
	removeHtmlBox: vi.fn((id: string) => {
		const idx = testState.htmlBoxes.indexOf(id);
		if (idx >= 0) testState.htmlBoxes.splice(idx, 1);
		document.getElementById(id)?.remove();
	}),
	htmlBoxes: testState.htmlBoxes,
	addSqlBox: testState.addSqlBox,
	removeSqlBox: vi.fn((id: string) => {
		const idx = testState.sqlBoxes.indexOf(id);
		if (idx >= 0) testState.sqlBoxes.splice(idx, 1);
		document.getElementById(id)?.remove();
		document.getElementById(`${id}_sql_results_wrapper`)?.remove();
		delete testState.sqlElements[id];
	}),
	sqlBoxes: testState.sqlBoxes,
	pythonBoxes: testState.pythonBoxes,
	urlBoxes: testState.urlBoxes,
	__kustoGetSqlSectionElement: vi.fn((id: string) => testState.sqlElements[id] || null),
}));

vi.mock('../../src/webview/core/state.js', () => ({
	connections: testState.kustoConnections,
	queryBoxes: testState.queryBoxes,
	queryEditors: testState.queryEditors,
	queryExecutionTimers: testState.queryExecutionTimers,
	optimizationMetadataByBoxId: testState.optimizationMetadataByBoxId,
	favoritesModeByBoxId: {},
	leaveNoTraceClusters: [],
	caretDocsEnabled: true,
	autoTriggerAutocompleteEnabled: true,
	setCaretDocsEnabled: vi.fn(),
	setAutoTriggerAutocompleteEnabled: vi.fn(),
	activeQueryEditorBoxId: null,
	beginKustoPreparation: testState.beginKustoPreparation,
	getKustoPreparationState: testState.getKustoPreparationState,
	schemaDiagnosticsTrustedByBoxId: testState.schemaDiagnosticsTrustedByBoxId,
	schemaFetchInFlightByBoxId: testState.schemaFetchInFlightByBoxId,
	sqlFavoritesModeByBoxId: {},
	sqlLeaveNoTraceConnectionIds: testState.sqlLeaveNoTraceConnectionIds,
	sqlConnections: testState.sqlConnections,
}));

vi.mock('../../src/webview/sections/kw-chart-section.js', () => ({
	addChartBox: vi.fn((options?: { id?: string }) => {
		const id = String(options?.id || `chart_restored_${testState.chartBoxes.length + 1}`);
		testState.chartBoxes.push(id);
		const element = document.createElement('kw-chart-section');
		element.id = id;
		(document.getElementById('queries-container') || document.body).appendChild(element);
		return id;
	}),
	removeChartBox: vi.fn((id: string) => {
		const index = testState.chartBoxes.indexOf(id);
		if (index >= 0) testState.chartBoxes.splice(index, 1);
		document.getElementById(id)?.remove();
	}),
	chartBoxes: testState.chartBoxes,
}));

vi.mock('../../src/webview/sections/kw-transformation-section.js', () => ({
	addTransformationBox: vi.fn((options?: { id?: string }) => {
		const id = String(options?.id || `transformation_restored_${testState.transformationBoxes.length + 1}`);
		testState.transformationBoxes.push(id);
		const element = document.createElement('kw-transformation-section') as HTMLElement & {
			applyHostDocumentState?: ReturnType<typeof vi.fn>;
		};
		element.id = id;
		element.applyHostDocumentState = vi.fn();
		(document.getElementById('queries-container') || document.body).appendChild(element);
		return id;
	}),
	removeTransformationBox: vi.fn((id: string) => {
		const idx = testState.transformationBoxes.indexOf(id);
		if (idx >= 0) testState.transformationBoxes.splice(idx, 1);
		document.getElementById(id)?.remove();
	}),
	transformationBoxes: testState.transformationBoxes,
}));

vi.mock('../../src/webview/sections/kw-markdown-section.js', () => ({
	addMarkdownBox: testState.addMarkdownBox,
	removeMarkdownBox: vi.fn((id: string) => {
		const idx = testState.markdownBoxes.indexOf(id);
		if (idx >= 0) testState.markdownBoxes.splice(idx, 1);
	}),
	markdownBoxes: testState.markdownBoxes,
	markdownEditors: testState.markdownEditors,
}));



vi.mock('../../src/webview/sections/kw-query-toolbar.js', () => ({
	__kustoCloseShareModal: vi.fn(),
	setRunMode: vi.fn(),
	updateCaretDocsToggleButtons: vi.fn(),
	updateAutoTriggerAutocompleteToggleButtons: vi.fn(),
}));

vi.mock('../../src/webview/sections/query-execution.controller.js', () => ({
	__kustoUpdateQueryResultsToggleButton: vi.fn(),
	__kustoApplyResultsVisibility: vi.fn(),
}));

vi.mock('../../src/webview/monaco/monaco.js', () => ({
	__kustoUpdateSchemaForFocusedBox: vi.fn(),
}));

import { createEmptyQueryEditorPendingAdds, pState } from '../../src/webview/shared/persistence-state.js';
import { postMessageToHost } from '../../src/webview/shared/webview-messages.js';
import { clearResultsState, displayResult, displayResultForBox } from '../../src/webview/core/results-state.js';
import { optimizationMetadataByBoxId, sqlFavoritesModeByBoxId } from '../../src/webview/core/state.js';
import { updateConnectionSelects, __kustoGetConnectionId, __kustoGetDatabase, __kustoGetQuerySectionElement, __kustoSetAutoEnterFavoritesForBox } from '../../src/webview/core/section-factory.js';
import { schemaRequestTokenByBoxId } from '../../src/webview/core/kusto-schema-request-state.js';
import { __kustoCloseShareModal, setRunMode } from '../../src/webview/sections/kw-query-toolbar.js';
import { addChartBox } from '../../src/webview/sections/kw-chart-section.js';
import { acknowledgePersistDocument, adoptCurrentStateAsCleanForTest, applyBrowserViewerDocumentProjection, applyKustoLeaveNoTracePolicy as applyKustoLeaveNoTracePolicyRaw, beginKustoLeaveNoTracePolicyApplication, captureKustoLeaveNoTracePolicyRuntime, createSectionWithCapabilities, discardPendingSqlResultRestores, finalizeDocumentDefaultsAfterAcknowledgement, flushCompatibilityPersist, getDeferredRestoredResultJobCountForTest, getKqlxState, getPendingKustoLeaveNoTracePolicyRequestIdForTest, handleDocumentDataMessage, installRuntimeAddSectionBridges, markKustoLeaveNoTracePolicyPending, resetDocumentPersistenceForTest, resolvePendingKustoResultRestores, resolvePendingSqlResultRestores, restoreKustoLeaveNoTracePolicyRuntime, schedulePersist, __kustoApplyDocumentCapabilities, __kustoClearStoredQueryResult, __kustoRequestAddSection, __kustoScheduleHtmlPowerBiCompatibilityCheck, __kustoScheduleLocalSchemaPrewarm, __kustoSetHtmlPowerBiCompatibilityCheckEnabled } from '../../src/webview/core/persistence.js';
import { createDerivedResultArtifactPublication, publicationFromPersistedResultArtifact, RESULT_ARTIFACT_CONSUMERS_REVOKED_EVENT, RESULT_ARTIFACT_CSV_RESET_EVENT } from '../../src/shared/resultArtifact.js';
import { sqlConnectionTargetSignature } from '../../src/shared/sqlConnectionIdentity.js';

describe('persistence round-trip', () => {
	const kustoResultOwner = { kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0 } as const;
	const ownedKustoConnection = (connection: { id: string; clusterUrl: string; authorityId?: string }) => ({
		...connection, accountPartition: 'partition-a',
	});
	function applyKustoLeaveNoTracePolicy(
		clusterUrls: readonly unknown[], globallyBlocked = false, revocationGenerations: Record<string, number> = {},
	): void {
		applyKustoLeaveNoTracePolicyRaw(
			clusterUrls,
			globallyBlocked,
			getPendingKustoLeaveNoTracePolicyRequestIdForTest() || undefined,
			revocationGenerations,
		);
	}

	beforeEach(() => {
		resetDocumentPersistenceForTest();
		applyKustoLeaveNoTracePolicy([], false);
		document.body.innerHTML = '';
		testState.queryBoxes.splice(0, testState.queryBoxes.length);
		testState.chartBoxes.splice(0, testState.chartBoxes.length);
		testState.markdownBoxes.splice(0, testState.markdownBoxes.length);
		testState.pythonBoxes.splice(0, testState.pythonBoxes.length);
		testState.urlBoxes.splice(0, testState.urlBoxes.length);
		testState.htmlBoxes.splice(0, testState.htmlBoxes.length);
		testState.sqlBoxes.splice(0, testState.sqlBoxes.length);
		testState.sqlLeaveNoTraceConnectionIds.splice(0, testState.sqlLeaveNoTraceConnectionIds.length);
		testState.sqlConnections.splice(0, testState.sqlConnections.length);
		testState.kustoConnections.splice(0, testState.kustoConnections.length);
		for (const k of Object.keys(testState.queryEditors)) delete testState.queryEditors[k];
		for (const k of Object.keys(testState.markdownEditors)) delete testState.markdownEditors[k];
		for (const k of Object.keys(testState.queryExecutionTimers)) delete testState.queryExecutionTimers[k];
		for (const k of Object.keys(testState.sqlElements)) delete testState.sqlElements[k];
		for (const k of Object.keys(pState.pendingQueryTextByBoxId)) delete pState.pendingQueryTextByBoxId[k];
		for (const k of Object.keys(pState.pendingMarkdownTextByBoxId)) delete pState.pendingMarkdownTextByBoxId[k];
		for (const k of Object.keys(pState.pendingPythonCodeByBoxId)) delete pState.pendingPythonCodeByBoxId[k];
		for (const k of Object.keys(pState.pendingHtmlCodeByBoxId)) delete pState.pendingHtmlCodeByBoxId[k];
		for (const k of Object.keys(pState.pendingSqlQueryByBoxId)) delete pState.pendingSqlQueryByBoxId[k];
		for (const k of Object.keys(pState.pendingWrapperHeightPxByBoxId)) delete pState.pendingWrapperHeightPxByBoxId[k];
		for (const k of Object.keys(pState.resultsVisibleByBoxId)) delete pState.resultsVisibleByBoxId[k];
		for (const k of Object.keys(pState.queryResultJsonByBoxId)) delete pState.queryResultJsonByBoxId[k];
		for (const k of Object.keys(pState.resultArtifactByBoxId)) delete pState.resultArtifactByBoxId[k];
		for (const k of Object.keys(pState.kustoResultOwnerByBoxId)) delete pState.kustoResultOwnerByBoxId[k];
		for (const k of Object.keys(schemaRequestTokenByBoxId)) delete schemaRequestTokenByBoxId[k];
		for (const k of Object.keys(testState.schemaDiagnosticsTrustedByBoxId)) delete testState.schemaDiagnosticsTrustedByBoxId[k];
		for (const k of Object.keys(testState.schemaFetchInFlightByBoxId)) delete testState.schemaFetchInFlightByBoxId[k];
		for (const k of Object.keys(sqlFavoritesModeByBoxId)) delete sqlFavoritesModeByBoxId[k];
		for (const k of Object.keys(optimizationMetadataByBoxId)) delete optimizationMetadataByBoxId[k];
		vi.clearAllMocks();
		vi.mocked(displayResultForBox).mockReset();
		testState.getCurrentResultArtifact.mockReset().mockReturnValue(null);
		pState.compatibilityMode = false;
		pState.documentKind = 'kqlx';
		pState.documentEditRevision = 0;
		pState.documentUri = '';
		pState.metadataFreeDevelopmentNoteSections = [];
		pState.lastExecutedBox = '';
		pState.htmlPowerBiCompatibilityCheckEnabled = true;
		(window as any).__testPendingQueryTextByBoxId = pState.pendingQueryTextByBoxId;
		(window as any).__testPendingSqlQueryByBoxId = pState.pendingSqlQueryByBoxId;
		(window as any).__testQueryResultJsonByBoxId = pState.queryResultJsonByBoxId;
		delete (window as any).__kustoReadOnlyMode;
	});

	it('restores all known Sankey and heatmap chart settings before serialization overlay', () => {
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentKind: 'kqlx', state: { sections: [{
				id: 'chart_restore_settings', type: 'chart', chartType: 'sankey', sankeyLeftMargin: 137,
				heatmapSettings: {
					visualMapPosition: 'left', visualMapGap: 19, showCellLabels: true,
					cellLabelMode: 'highest', cellLabelN: 7,
				},
			}] },
		});

		expect(addChartBox).toHaveBeenCalledWith(expect.objectContaining({
			id: 'chart_restore_settings',
			sankeyLeftMargin: 137,
			heatmapSettings: {
				visualMapPosition: 'left', visualMapGap: 19, showCellLabels: true,
				cellLabelMode: 'highest', cellLabelN: 7,
			},
		}));
	});

	it('does not activate a source generation when a known section fails to restore', () => {
		pState.sourceGeneration = 7;
		vi.mocked(addChartBox).mockImplementationOnce(() => { throw new Error('injected chart restore failure'); });

		const applied = handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, sourceGeneration: 8,
			documentKind: 'kqlx', state: { sections: [
				{ id: 'chart_restore_failure', type: 'chart', chartType: 'bar' },
			] },
		});

		expect(applied).toBe(false);
		expect(pState.sourceGeneration).toBe(7);
		expect(document.getElementById('kusto-malformed-document-banner')?.textContent).toContain('injected chart restore failure');
	});

	it('does not acknowledge a newer rich source generation through the already-applied fast path', () => {
		expect(handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, sourceGeneration: 11,
			documentUri: 'file:///work/notebook.kqlx', state: { sections: [] },
		})).toBe(true);
		expect(pState.sourceGeneration).toBe(11);

		expect(handleDocumentDataMessage({
			type: 'documentData', ok: true, sourceGeneration: 12,
			documentUri: 'file:///work/notebook.kqlx', state: { sections: [] },
		})).toBe(false);
		expect(pState.sourceGeneration).toBe(11);
	});

	it('does not acknowledge a plain compatibility projection whose editor was not materialized', () => {
		pState.compatibilityMode = true;
		pState.compatibilitySingleKind = 'query';
		vi.mocked(testState.addQueryBox).mockImplementationOnce(() => 'missing_query_editor');

		const applied = handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, sourceGeneration: 21,
			documentKind: 'kql', compatibilityMode: true, compatibilitySingleKind: 'query',
			state: { sections: [{ type: 'query', query: 'print 1' }] },
		});

		expect(applied).toBe(false);
		expect(pState.sourceGeneration).toBe(0);
	});

	it('restores persisted Kusto rows as CSV-only artifacts in the read-only browser viewer', () => {
		vi.useFakeTimers();
		(window as any).__kustoReadOnlyMode = true;
		const resultJson = JSON.stringify({ columns: [{ name: 'Value' }], rows: [['browser-kusto']], metadata: {} });
		try {
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'https://example.test/result.kqlx',
				documentKind: 'kqlx', state: { sections: [{
					type: 'query', id: 'query_browser_restore', query: 'print Value="browser-kusto"',
					resultJson, ...kustoResultOwner,
					resultArtifact: {
						version: 1, artifactId: 'forged-browser-kusto', sourceBoxId: 'query_browser_restore',
						revision: 99, createdAt: 1,
						policy: { exposeToActiveContent: true, sendToModel: true, shareToClipboard: true },
					},
				}] },
			});
			flushDeferredRestoreTimers();

			expect(displayResultForBox).toHaveBeenCalledWith(
				expect.objectContaining({ rows: [['browser-kusto']] }), 'query_browser_restore',
				expect.objectContaining({
					artifactPublication: expect.objectContaining({
						producer: expect.objectContaining({ producer: 'browser-restored' }),
						policy: { exportToCsv: true },
					}),
				}),
			);
			expect(getDeferredRestoredResultJobCountForTest()).toBe(0);
			const publication = vi.mocked(displayResultForBox).mock.calls.at(-1)?.[2]?.artifactPublication;
			expect(publication?.policy).toEqual({ exportToCsv: true });
			expect(publication?.policy?.exposeToActiveContent).toBeUndefined();
			expect(publication?.policy?.sendToModel).toBeUndefined();
			expect(publication?.policy?.shareToClipboard).toBeUndefined();
		} finally {
			delete (window as any).__kustoReadOnlyMode;
			vi.useRealTimers();
		}
	});

	it('keeps a markerless Kusto cache inert in the read-only browser viewer', () => {
		vi.useFakeTimers();
		(window as any).__kustoReadOnlyMode = true;
		const resultJson = JSON.stringify({
			columns: [{ name: 'Value' }], rows: [['unverified-browser-kusto']],
			metadata: { cluster: 'browser-unverified', database: 'Db' },
		});
		try {
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true,
				documentUri: 'https://example.test/unverified.kqlx', documentKind: 'kqlx',
				state: { sections: [{
					type: 'query', id: 'query_browser_unverified', query: 'print Value="unverified-browser-kusto"',
					clusterUrl: 'https://browser-unverified.kusto.windows.net', database: 'Db', resultJson,
				}] },
			});
			flushDeferredRestoreTimers();

			expect(getDeferredRestoredResultJobCountForTest()).toBe(0);
			expect(displayResultForBox).not.toHaveBeenCalledWith(
				expect.objectContaining({ rows: [['unverified-browser-kusto']] }),
				'query_browser_unverified', expect.anything(),
			);
			expect(pState.queryResultJsonByBoxId.query_browser_unverified).toBeUndefined();
		} finally {
			delete (window as any).__kustoReadOnlyMode;
			vi.useRealTimers();
		}
	});

	it.each([
		['blank partition', { kustoAccountPartition: '', kustoLeaveNoTraceRevision: 0 }],
		['negative revision', { kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: -1 }],
		['non-integer revision', { kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0.5 }],
	])('keeps a Kusto cache with %s inert in the read-only browser viewer', (_label, provenance) => {
		vi.useFakeTimers();
		(window as any).__kustoReadOnlyMode = true;
		const resultJson = JSON.stringify({ columns: [{ name: 'Value' }], rows: [['invalid-browser-owner']], metadata: {} });
		try {
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true,
				documentUri: 'https://example.test/invalid-owner.kqlx', documentKind: 'kqlx',
				state: { sections: [{
					type: 'query', id: 'query_browser_invalid_owner', query: 'print Value="invalid-browser-owner"',
					resultJson, ...provenance,
				}] },
			});
			flushDeferredRestoreTimers();

			expect(displayResultForBox).not.toHaveBeenCalledWith(
				expect.objectContaining({ rows: [['invalid-browser-owner']] }),
				'query_browser_invalid_owner', expect.anything(),
			);
		} finally {
			delete (window as any).__kustoReadOnlyMode;
			vi.useRealTimers();
		}
	});

	it('normalizes ragged restored rows before presentation in the read-only viewer', () => {
		vi.useFakeTimers();
		(window as any).__kustoReadOnlyMode = true;
		const resultJson = JSON.stringify({
			columns: [{ name: 'A' }, { name: 'B' }],
			rows: [[1, 2, 'hidden'], [3]], metadata: {},
		});
		try {
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true,
				documentUri: 'https://example.test/ragged.kqlx', documentKind: 'kqlx',
				state: { sections: [{
					type: 'query', id: 'query_ragged_restore', query: 'print A=1, B=2', resultJson, ...kustoResultOwner,
				}] },
			});
			flushDeferredRestoreTimers();

			expect(displayResultForBox).toHaveBeenCalledWith(
				expect.objectContaining({ rows: [[1, 2], [3, undefined]] }),
				'query_ragged_restore', expect.anything(),
			);
			expect(pState.queryResultJsonByBoxId.query_ragged_restore).toBeUndefined();
		} finally {
			delete (window as any).__kustoReadOnlyMode;
			vi.useRealTimers();
		}
	});

	it('restores persisted SQL rows as CSV-only artifacts without live browser connections', () => {
		vi.useFakeTimers();
		(window as any).__kustoReadOnlyMode = true;
		const resultJson = JSON.stringify({ columns: [{ name: 'Value' }], rows: [['browser-sql']], metadata: {} });
		try {
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'https://example.test/result.sqlx',
				documentKind: 'sqlx', state: { sections: [{
					type: 'sql', id: 'sql_browser_restore', query: 'select \'browser-sql\' as Value',
					database: 'BrowserDb', connectionIdHint: 'missing-browser-connection', resultJson,
				}] },
			});
			flushDeferredRestoreTimers();

			expect(displayResultForBox).toHaveBeenCalledWith(
				expect.objectContaining({ rows: [['browser-sql']] }), 'sql_browser_restore',
				expect.objectContaining({
					artifactPublication: expect.objectContaining({
						producer: expect.objectContaining({ engine: 'sql', producer: 'browser-restored' }),
						policy: { exportToCsv: true },
					}),
				}),
			);
			expect(getDeferredRestoredResultJobCountForTest()).toBe(0);
			const publication = vi.mocked(displayResultForBox).mock.calls.at(-1)?.[2]?.artifactPublication;
			expect(publication?.policy).toEqual({ exportToCsv: true });
		} finally {
			delete (window as any).__kustoReadOnlyMode;
			vi.useRealTimers();
		}
	});

	it('accepts a same-generation browser presentation retry without rematerializing sections', () => {
		(window as any).__kustoReadOnlyMode = true;
		const projection = {
			ok: true,
			state: { sections: [{ id: 'query_browser_retry', type: 'query', query: 'print value=7' }] },
			documentUri: 'https://example.test/browser-retry.kqlx',
			documentKind: 'kqlx',
			allowedSectionKinds: [],
			defaultSectionKind: 'query',
			compatibilityMode: false,
			documentMutationAllowed: false,
			htmlPowerBiCompatibilityCheckEnabled: false,
			sourceGeneration: 7,
		};
		try {
			expect(applyBrowserViewerDocumentProjection(projection)).toBe(true);
			expect(testState.addQueryBox).toHaveBeenCalledOnce();
			expect(applyBrowserViewerDocumentProjection(projection)).toBe(true);
			expect(testState.addQueryBox).toHaveBeenCalledOnce();
		} finally {
			delete (window as any).__kustoReadOnlyMode;
		}
	});

	it.each(['source-first', 'comparison-first'])('restores browser SQL comparisons in %s order', order => {
		vi.useFakeTimers();
		(window as any).__kustoReadOnlyMode = true;
		const sourceId = `sql_browser_comparison_source_${order}`;
		const comparisonId = `query_browser_sql_comparison_${order}`;
		const source = {
			type: 'sql', id: sourceId, query: 'select 1 as Value', serverUrl: 'missing.example',
			database: 'BrowserDb', connectionIdHint: 'missing-browser-sql',
			resultJson: JSON.stringify({ columns: [{ name: 'Value' }], rows: [['source']], metadata: {} }),
		};
		const sourceArtifact = {
			artifactId: `result:${sourceId}:1`, sourceBoxId: sourceId, revision: 1, createdAt: 1,
			producer: { engine: 'sql', boxId: sourceId, producer: 'browser-restored' },
			policy: { exportToCsv: true }, lineage: [],
		};
		testState.getCurrentResultArtifact.mockImplementation((boxId: string) =>
			boxId === sourceId ? sourceArtifact : null);
		const comparison = {
			type: 'query', id: comparisonId, query: 'select 2 as Value', comparisonSourceBoxId: sourceId,
			resultJson: JSON.stringify({ columns: [{ name: 'Value' }], rows: [['comparison']], metadata: {} }),
			resultArtifact: {
				version: 1, artifactId: `forged:${comparisonId}`, sourceBoxId: comparisonId,
				revision: 7, createdAt: 1,
				policy: { exposeToActiveContent: true, sendToModel: true, shareToClipboard: true },
			},
		};
		try {
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true,
				documentUri: `https://example.test/${order}.kqlx`, documentKind: 'kqlx',
				state: { sections: order === 'source-first' ? [source, comparison] : [comparison, source] },
			});
			vi.advanceTimersByTime(200);

			const comparisonCall = vi.mocked(displayResultForBox).mock.calls
				.find(call => call[1] === comparisonId);
			expect(comparisonCall?.[0]).toEqual(expect.objectContaining({ rows: [['comparison']] }));
			expect(comparisonCall?.[2]?.artifactPublication).toMatchObject({
				lineage: [{ sourceArtifactId: sourceArtifact.artifactId, role: 'comparison-source' }],
				policy: {
					exportToCsv: true,
					sourcePolicies: [{ sourceArtifactId: sourceArtifact.artifactId, exportToCsv: true }],
				},
			});
			expect(comparisonCall?.[2]?.artifactPublication?.producer).toEqual(expect.objectContaining({
				engine: 'kusto', boxId: comparisonId, producer: 'browser-restored',
			}));
			expect(getDeferredRestoredResultJobCountForTest()).toBe(0);
		} finally {
			delete (window as any).__kustoReadOnlyMode;
			vi.useRealTimers();
		}
	});

	it('publishes a local schema prewarm token only after claiming stamped lifecycle ownership', () => {
		vi.useFakeTimers();
		const boxId = 'query_prewarm_claim';
		const lifecycleIdentity = { sectionInstanceId: 'section-prewarm', targetGeneration: 7 };
		const section = document.createElement('div') as HTMLElement & {
			setSchemaLifecycleTarget: ReturnType<typeof vi.fn>;
			beginSchemaLifecycleRequest: ReturnType<typeof vi.fn>;
		};
		section.id = boxId;
		section.setSchemaLifecycleTarget = vi.fn(() => lifecycleIdentity);
		section.beginSchemaLifecycleRequest = vi.fn()
			.mockReturnValueOnce(undefined)
			.mockImplementation((requestToken: string) => ({ boxId, ...lifecycleIdentity, requestToken }));
		vi.spyOn(section, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
		document.body.appendChild(section);
		testState.queryBoxes.push(boxId);
		vi.mocked(__kustoGetQuerySectionElement).mockReturnValue(section as any);
		vi.mocked(__kustoGetConnectionId).mockReturnValue('connection-prewarm');
		vi.mocked(__kustoGetDatabase).mockReturnValue('Samples');
		(window as any).vscode = {};

		try {
			__kustoScheduleLocalSchemaPrewarm('failed-claim');
			vi.advanceTimersByTime(80);

			expect(schemaRequestTokenByBoxId[boxId]).toBeUndefined();
			expect(postMessageToHost).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'prefetchSchema' }));

			__kustoScheduleLocalSchemaPrewarm('retry');
			vi.advanceTimersByTime(80);

			const request = vi.mocked(postMessageToHost).mock.calls
				.map(([message]) => message)
				.find((message: any) => message?.type === 'prefetchSchema') as any;
			expect(request).toMatchObject({
				boxId,
				connectionId: 'connection-prewarm',
				database: 'Samples',
				sectionInstanceId: 'section-prewarm',
				targetGeneration: 7,
				cacheOnly: true,
				silent: true,
			});
			expect(schemaRequestTokenByBoxId[boxId]).toBe(request.requestToken);
			const claimedToken = request.requestToken;

			vi.mocked(postMessageToHost).mockClear();
			__kustoScheduleLocalSchemaPrewarm('duplicate-generation');
			vi.advanceTimersByTime(80);

			expect(postMessageToHost).not.toHaveBeenCalled();
			expect(schemaRequestTokenByBoxId[boxId]).toBe(claimedToken);
			expect(section.beginSchemaLifecycleRequest).toHaveBeenCalledTimes(2);
		} finally {
			delete (window as any).vscode;
			vi.useRealTimers();
		}
	});

	function flushDeferredRestoreTimers() {
		vi.advanceTimersByTime(25);
	}

	function createRevisionedQueryHarness(uri: string, initialQuery: string) {
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, editRevision: 0,
			documentKind: 'kql', compatibilityMode: false, documentUri: uri,
			state: { sections: [{ type: 'query', id: 'query_ack_flow', query: initialQuery }] },
		});
		const queryId = testState.queryBoxes.at(-1)!;
		const query = document.getElementById(queryId) as HTMLElement & { serialize: () => unknown };
		let currentQuery = initialQuery;
		query.serialize = () => ({ id: queryId, type: 'query', query: currentQuery });
		const container = document.createElement('div');
		container.id = 'queries-container';
		container.appendChild(query);
		document.body.appendChild(container);
		adoptCurrentStateAsCleanForTest();
		vi.mocked(postMessageToHost).mockClear();
		return { setQuery: (value: string) => { currentQuery = value; } };
	}

	it('serializes section DOM via getKqlxState', () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		document.body.appendChild(container);

		const queryEl = document.createElement('div') as unknown as HTMLElement & { serialize: () => unknown };
		queryEl.id = 'custom-query';
		queryEl.serialize = () => ({ type: 'query', id: 'custom-query', query: 'StormEvents | take 5' });

		const markdownEl = document.createElement('div') as unknown as HTMLElement & { serialize: () => unknown };
		markdownEl.id = 'markdown_1';
		markdownEl.serialize = () => ({ type: 'markdown', id: 'markdown_1', text: 'hello' });

		const htmlEl = document.createElement('div') as unknown as HTMLElement & { serialize: () => unknown };
		htmlEl.id = 'html_1';
		htmlEl.serialize = () => ({ type: 'html', id: 'html_1', code: '<main></main>', mode: 'preview' });

		const sqlEl = document.createElement('div') as unknown as HTMLElement & { serialize: () => unknown };
		sqlEl.id = 'sql_1';
		sqlEl.serialize = () => ({ type: 'sql', id: 'sql_1', query: 'select 1' });

		container.append(queryEl, markdownEl, htmlEl, sqlEl);

		const state = getKqlxState() as { sections: Array<{ type: string }> };
		expect(state.sections).toHaveLength(4);
		expect(state.sections.map((s) => s.type)).toEqual(['query', 'markdown', 'html', 'sql']);
	});

	it('uses host-owned Markdown projection without consulting component serialize()', () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		document.body.appendChild(container);
		const markdown = document.createElement('kw-markdown-section') as HTMLElement & { serialize: ReturnType<typeof vi.fn> };
		markdown.id = 'markdown_host_owned';
		markdown.serialize = vi.fn(() => { throw new Error('stale DOM serializer'); });
		container.appendChild(markdown);
		pState.documentKind = 'kqlx';
		pState.hostOwnedMarkdownActive = true;
		pState.markdownDocumentRevision = 4;
		pState.markdownSectionRevisions = { markdown_host_owned: 2 };
		pState.hostOwnedMarkdownSections = {
			markdown_host_owned: {
				id: 'markdown_host_owned', type: 'markdown', title: 'Host', text: 'authoritative',
				mode: 'preview', tab: 'preview', expanded: false,
			},
		};

		expect(getKqlxState().sections).toEqual([pState.hostOwnedMarkdownSections.markdown_host_owned]);
		expect(markdown.serialize).not.toHaveBeenCalled();
	});

	it('uses host-owned Chart projection when component serialize() throws', () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		document.body.appendChild(container);
		const chart = document.createElement('kw-chart-section') as HTMLElement & { serialize: ReturnType<typeof vi.fn> };
		chart.id = 'chart_host_owned';
		chart.serialize = vi.fn(() => { throw new Error('poisoned Chart DOM serializer'); });
		container.appendChild(chart);
		pState.documentKind = 'kqlx';
		pState.documentRuntimeActive = true;
		pState.hostOwnedMarkdownActive = true;
		pState.markdownDocumentRevision = 5;
		pState.documentSectionRevisions = { chart_host_owned: 3 };
		pState.hostOwnedChartSections = {
			chart_host_owned: {
				id: 'chart_host_owned', type: 'chart', name: 'Host Chart', mode: 'preview', expanded: false,
				dataSourceId: 'query_1', chartType: 'line', xColumn: 'Day', yColumns: ['Value'],
				xAxisSettings: { customLabel: 'Date' }, chartTitle: 'Authoritative chart',
			},
		};

		expect(getKqlxState().sections).toEqual([pState.hostOwnedChartSections.chart_host_owned]);
		expect(chart.serialize).not.toHaveBeenCalled();
	});

	it('uses host-owned Transformation projection when component serialize() throws', () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		document.body.appendChild(container);
		const transformation = document.createElement('kw-transformation-section') as HTMLElement & {
			serialize: ReturnType<typeof vi.fn>;
		};
		transformation.id = 'transform-any-id';
		transformation.serialize = vi.fn(() => { throw new Error('poisoned Transformation DOM serializer'); });
		container.appendChild(transformation);
		pState.documentKind = 'kqlx';
		pState.documentRuntimeActive = true;
		pState.hostOwnedMarkdownActive = true;
		pState.markdownDocumentRevision = 7;
		pState.documentSectionRevisions = { 'transform-any-id': 2 };
		pState.hostOwnedTransformationSections = {
			'transform-any-id': {
				id: 'transform-any-id', type: 'transformation', name: 'Host Transformation',
				mode: 'preview', expanded: false, editorHeightPx: 440,
				dataSourceId: 'query_left', transformationType: 'join',
				joinRightDataSourceId: 'query_right', joinKind: 'fullouter',
				joinKeys: [{ left: 'CustomerId', right: 'AccountId' }],
				joinOmitDuplicateColumns: true,
			},
		};

		expect(getKqlxState().sections).toEqual([
			pState.hostOwnedTransformationSections['transform-any-id'],
		]);
		expect(transformation.serialize).not.toHaveBeenCalled();
	});

	it('uses host-owned URL projection when component serialize() throws', () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		document.body.appendChild(container);
		const url = document.createElement('kw-url-section') as HTMLElement & { serialize: ReturnType<typeof vi.fn> };
		url.id = 'url_host_owned';
		url.serialize = vi.fn(() => { throw new Error('stale URL DOM serializer'); });
		container.appendChild(url);
		pState.documentKind = 'kqlx';
		pState.hostOwnedMarkdownActive = true;
		pState.markdownDocumentRevision = 5;
		pState.documentSectionRevisions = { url_host_owned: 3 };
		pState.hostOwnedUrlSections = {
			url_host_owned: {
				id: 'url_host_owned', type: 'url', name: 'Host URL', url: 'https://example.com/owned.png',
				expanded: false, outputHeightPx: 360, imageSizeMode: 'natural', imageAlign: 'center',
				imageOverflow: 'scroll',
			},
		};

		expect(getKqlxState().sections).toEqual([pState.hostOwnedUrlSections.url_host_owned]);
		expect(url.serialize).not.toHaveBeenCalled();
	});

	it('uses host-owned Python projection when component serialize() throws', () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		document.body.appendChild(container);
		const python = document.createElement('kw-python-section') as HTMLElement & { serialize: ReturnType<typeof vi.fn> };
		python.id = 'python_host_owned';
		python.serialize = vi.fn(() => { throw new Error('poisoned Python DOM serializer'); });
		container.appendChild(python);
		pState.documentKind = 'kqlx';
		pState.documentRuntimeActive = true;
		pState.hostOwnedMarkdownActive = true;
		pState.markdownDocumentRevision = 6;
		pState.documentSectionRevisions = { python_host_owned: 4 };
		pState.hostOwnedPythonSections = {
			python_host_owned: {
				id: 'python_host_owned', type: 'python', name: 'Host Python', code: 'print("owned")',
				output: 'owned output', expanded: false, editorHeightPx: 360,
			},
		};

		expect(getKqlxState().sections).toEqual([pState.hostOwnedPythonSections.python_host_owned]);
		expect(python.serialize).not.toHaveBeenCalled();
	});

	it('omits provisional SQL comparisons until host admission', () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		document.body.appendChild(container);

		const source = document.createElement('div') as HTMLElement & { serialize: () => unknown };
		source.id = 'sql_source';
		source.serialize = () => ({ id: source.id, type: 'sql', query: 'SELECT 1' });
		const comparison = document.createElement('div') as HTMLElement & { serialize: () => unknown };
		comparison.id = 'sql_comparison';
		comparison.setAttribute('data-sql-comparison-admission-request-id', 'request-1');
		comparison.serialize = () => ({
			id: comparison.id, type: 'sql', query: 'SELECT 2', comparisonSourceBoxId: source.id,
		});
		container.append(source, comparison);

		expect(getKqlxState().sections).toEqual([
			{ id: 'sql_source', type: 'sql', query: 'SELECT 1' },
		]);
	});

	it('does not serialize application editing preferences into a new document', () => {
		handleDocumentDataMessage({ ok: true, forceReload: true, state: { sections: [] } });

		const state = getKqlxState() as Record<string, unknown>;

		expect(state).not.toHaveProperty('caretDocsEnabled');
		expect(state).not.toHaveProperty('autoTriggerAutocompleteEnabled');
	});

	it('preserves the last good state and blocks persistence after a malformed external reload', () => {
		const resetCsv = vi.fn();
		window.addEventListener(RESULT_ARTIFACT_CSV_RESET_EVENT, resetCsv);
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'kqlx', documentUri: 'file:///tmp/report.kqlx',
			state: { sections: [{ type: 'query', id: 'query_good', query: 'print 1' }] },
		});
		const container = document.createElement('div');
		container.id = 'queries-container';
		const query = document.getElementById('query_good')!;
		const clearTargetBoundState = vi.fn();
		const disposeSchemaLifecycle = vi.fn();
		const clearResults = vi.fn();
		Object.assign(query, {
			clearTargetBoundState,
			disposeSchemaLifecycle,
			clearResults,
			getSchemaLifecycleIdentity: () => ({ sectionInstanceId: 'query-good-instance', targetGeneration: 3 }),
		});
		container.appendChild(query);
		document.body.appendChild(container);
		testState.queryExecutionTimers.query_good = { active: true };
		pState.queryResultJsonByBoxId.query_good = '{"rows":[[1]]}';
		pState.resultArtifactByBoxId.query_good = { artifactId: 'result:query_good:1' } as any;
		pState.kustoResultOwnerByBoxId.query_good = { accountPartition: 'partition-a', leaveNoTraceRevision: 0 };
		vi.mocked(postMessageToHost).mockClear();
		vi.mocked(__kustoCloseShareModal).mockClear();
		resetCsv.mockClear();
		const diff = document.createElement('kw-diff-view') as any;
		diff.close = vi.fn(() => {
			diff._model = null;
			diff._visible = false;
			for (const table of diff.querySelectorAll<any>('kw-data-table')) {
				table.rows = [];
				table.columns = [];
				table.canCopyRows = () => false;
			}
		});
		diff._model = { rows: ['secret'] };
		diff._visible = true;
		const diffTable = document.createElement('kw-data-table') as any;
		diffTable.rows = [['secret']];
		diffTable.columns = [{ name: 'Value' }];
		diffTable.canCopyRows = () => true;
		diff.appendChild(diffTable);
		document.body.appendChild(diff);
		const previousCloseDiffView = window.closeDiffView;
		window.closeDiffView = () => diff.close();

		try {
			handleDocumentDataMessage({
				type: 'documentData', ok: false, forceReload: true,
				documentKind: 'kqlx', documentUri: 'file:///tmp/report.kqlx',
				error: 'Invalid JSON',
			});
		} finally {
			window.closeDiffView = previousCloseDiffView;
		}
		expect(__kustoCloseShareModal).toHaveBeenCalledOnce();
		expect(resetCsv).toHaveBeenCalledOnce();
		expect(diff.close).toHaveBeenCalledOnce();
		expect(diff._model).toBeNull();
		expect(diff._visible).toBe(false);
		expect(diffTable.rows).toEqual([]);
		expect(diffTable.columns).toEqual([]);
		expect(diffTable.canCopyRows()).toBe(false);
		expect(pState.documentRuntimeActive).toBe(false);
		expect(clearTargetBoundState).toHaveBeenCalledOnce();
		expect(disposeSchemaLifecycle).toHaveBeenCalledOnce();
		expect(clearResults).toHaveBeenCalled();
		expect(clearResultsState).toHaveBeenCalledWith('query_good');
		expect(postMessageToHost).toHaveBeenCalledWith({
			type: 'kustoSectionClose', boxId: 'query_good', sectionInstanceId: 'query-good-instance',
		});
		expect(testState.queryExecutionTimers.query_good).toBeUndefined();
		expect(pState.queryResultJsonByBoxId.query_good).toBeUndefined();
		expect(pState.resultArtifactByBoxId.query_good).toBeUndefined();
		expect(pState.kustoResultOwnerByBoxId.query_good).toBeUndefined();

		expect(document.getElementById('query_good')).toBe(query);
		expect((container as HTMLElement & { inert?: boolean }).inert).toBe(true);
		expect(document.getElementById('kusto-malformed-document-banner')?.textContent).toContain('Editing is disabled');
		schedulePersist('malformed', true);
		expect(vi.mocked(postMessageToHost).mock.calls.some(call => (call[0] as any)?.type === 'persistDocument')).toBe(false);

		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'kqlx', documentUri: 'file:///tmp/report.kqlx',
			state: { sections: [{ type: 'query', id: 'query_repaired', query: 'print 2' }] },
		});

		expect(document.getElementById('kusto-malformed-document-banner')).toBeNull();
		expect((container as HTMLElement & { inert?: boolean }).inert).toBe(false);
		expect(pState.documentRuntimeActive).toBe(true);
		diff.remove();
		window.removeEventListener(RESULT_ARTIFACT_CSV_RESET_EVENT, resetCsv);
	});

	it('closes share state only when documentData is applied', () => {
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true,
			documentUri: 'file:///tmp/share-transition.kqlx', state: { sections: [] },
		});
		vi.mocked(__kustoCloseShareModal).mockClear();

		handleDocumentDataMessage({
			type: 'documentData', ok: true,
			documentUri: 'file:///tmp/share-transition.kqlx', state: { sections: [] },
		});
		expect(__kustoCloseShareModal).not.toHaveBeenCalled();

		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true,
			documentUri: 'file:///tmp/share-transition.kqlx', state: { sections: [] },
		});
		expect(__kustoCloseShareModal).toHaveBeenCalledOnce();
	});

	it('round-trips legacy document preferences unchanged instead of current application values', () => {
		handleDocumentDataMessage({
			ok: true,
			forceReload: true,
			state: {
				caretDocsEnabled: false,
				autoTriggerAutocompleteEnabled: false,
				sections: [],
			},
		});

		const state = getKqlxState() as Record<string, unknown>;

		expect(state.caretDocsEnabled).toBe(false);
		expect(state.autoTriggerAutocompleteEnabled).toBe(false);
	});

	it('restores HTML section code, legacy dataSourceIds input, dashboard publish metadata, and Power BI dismissal state', () => {
		const pbiPublishInfo = {
			workspaceId: 'workspace-1',
			workspaceName: 'Analytics',
			semanticModelId: 'model-1',
			reportId: 'report-1',
			reportName: 'Ops Dashboard',
			reportUrl: 'https://app.powerbi.com/report-1',
			dataMode: 'import',
		};
		const powerBiUpgradeNotice = {
			dismissedForSection: true,
			dismissedForVersion: 1,
			dismissedForSignature: 'dismissed-signature',
			dismissedAt: '2026-05-06T00:00:00.000Z',
		};

		handleDocumentDataMessage({
			type: 'documentData',
			ok: true,
			forceReload: true,
			documentUri: 'file:///tmp/html.kqlx',
			state: {
				sections: [
					{
						type: 'html',
						id: 'html_saved_1',
						name: 'Dashboard',
						code: '<main data-kw-bind="total"></main>',
						mode: 'preview',
						expanded: false,
						editorHeightPx: 260,
						previewHeightPx: 520,
						// Accepted for older saved documents; provenance is the authoritative source for future saves.
						dataSourceIds: ['query_1', 'transformation_1'],
						pbiPublishInfo,
						powerBiUpgradeNotice,
					},
				],
			},
		});

		expect(pState.pendingHtmlCodeByBoxId.html_saved_1).toBe('<main data-kw-bind="total"></main>');
		expect(testState.addHtmlBox).toHaveBeenCalledWith({
			id: 'html_saved_1',
			name: 'Dashboard',
			mode: 'preview',
			expanded: false,
			editorHeightPx: 260,
			previewHeightPx: 520,
			dataSourceIds: ['query_1', 'transformation_1'],
			pbiPublishInfo,
			powerBiUpgradeNotice,
		});
		expect(testState.htmlBoxes).toEqual(['html_saved_1']);
		expect(testState.queryBoxes).toEqual([]);
	});

	it('skips dismissed HTML sections during scheduled Power BI compatibility checks but still checks other sections', () => {
		vi.useFakeTimers();
		try {
			const dismissed = document.createElement('div') as HTMLElement & {
				shouldRunPowerBiCompatibilityNoticeCheck: ReturnType<typeof vi.fn>;
				evaluatePowerBiCompatibilityNotice: ReturnType<typeof vi.fn>;
			};
			dismissed.id = 'html_dismissed';
			dismissed.shouldRunPowerBiCompatibilityNoticeCheck = vi.fn(() => false);
			dismissed.evaluatePowerBiCompatibilityNotice = vi.fn();

			const active = document.createElement('div') as HTMLElement & {
				shouldRunPowerBiCompatibilityNoticeCheck: ReturnType<typeof vi.fn>;
				evaluatePowerBiCompatibilityNotice: ReturnType<typeof vi.fn>;
			};
			active.id = 'html_active';
			active.shouldRunPowerBiCompatibilityNoticeCheck = vi.fn(() => true);
			active.evaluatePowerBiCompatibilityNotice = vi.fn();

			document.body.append(dismissed, active);
			testState.htmlBoxes.push('html_dismissed', 'html_active');

			__kustoScheduleHtmlPowerBiCompatibilityCheck('test');
			vi.advanceTimersByTime(500);
			vi.advanceTimersByTime(25);

			expect(dismissed.shouldRunPowerBiCompatibilityNoticeCheck).toHaveBeenCalledTimes(1);
			expect(dismissed.evaluatePowerBiCompatibilityNotice).not.toHaveBeenCalled();
			expect(active.shouldRunPowerBiCompatibilityNoticeCheck).toHaveBeenCalledTimes(1);
			expect(active.evaluatePowerBiCompatibilityNotice).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not schedule delayed HTML Power BI compatibility checks when globally disabled', () => {
		vi.useFakeTimers();
		try {
			const active = document.createElement('div') as HTMLElement & {
				shouldRunPowerBiCompatibilityNoticeCheck: ReturnType<typeof vi.fn>;
				evaluatePowerBiCompatibilityNotice: ReturnType<typeof vi.fn>;
				clearPowerBiCompatibilityNotice: ReturnType<typeof vi.fn>;
			};
			active.id = 'html_active';
			active.shouldRunPowerBiCompatibilityNoticeCheck = vi.fn(() => true);
			active.evaluatePowerBiCompatibilityNotice = vi.fn();
			active.clearPowerBiCompatibilityNotice = vi.fn();

			document.body.append(active);
			testState.htmlBoxes.push('html_active');

			__kustoSetHtmlPowerBiCompatibilityCheckEnabled(false);
			__kustoScheduleHtmlPowerBiCompatibilityCheck('test');
			vi.advanceTimersByTime(500);
			vi.advanceTimersByTime(25);

			expect(active.clearPowerBiCompatibilityNotice).toHaveBeenCalled();
			expect(active.shouldRunPowerBiCompatibilityNoticeCheck).not.toHaveBeenCalled();
			expect(active.evaluatePowerBiCompatibilityNotice).not.toHaveBeenCalled();
		} finally {
			pState.htmlPowerBiCompatibilityCheckEnabled = true;
			vi.useRealTimers();
		}
	});

	it('restores SQL section query, state, favorites mode, and persisted results', () => {
		vi.useFakeTimers();
		const sqlConnection = {
			id: 'sql-warehouse', name: 'Warehouse', dialect: 'mssql', serverUrl: 'tcp:sql.example.test,1433',
			database: 'Warehouse', authType: 'sql-login', username: 'ReportUser',
		};
		testState.sqlConnections.push(sqlConnection);
		const targetSignature = sqlConnectionTargetSignature(sqlConnection);
		const exactSqlQuery = '  select top 10 * from dbo.Events\n\n';
		const resultJson = JSON.stringify({
			columns: [{ name: 'Value', type: 'int' }],
			rows: [[1]],
			metadata: { executionTime: '00:00:00.010' },
		});
		const resultArtifact = {
			version: 1, artifactId: 'result:sql_saved_1:4', sourceBoxId: 'sql_saved_1', revision: 4, createdAt: 123,
			producer: {
				engine: 'sql', boxId: 'sql_saved_1', executionId: 'sql-execution',
				query: exactSqlQuery, connectionId: 'sql-warehouse', database: 'Warehouse',
			},
			policy: { exposeToActiveContent: true, shareToClipboard: true, exportToCsv: true },
		};
		vi.mocked(displayResultForBox).mockImplementationOnce((_result, boxId) => {
			const wrapper = document.getElementById(`${boxId}_sql_results_wrapper`);
			expect(wrapper?.style.height).toBe('420px');
			expect(wrapper?.dataset.kustoUserResized).toBe('true');
		});

		try {
			handleDocumentDataMessage({
				type: 'documentData',
				ok: true,
				forceReload: true,
				documentUri: 'file:///tmp/sql.sqlx',
				state: {
					sections: [
						{
							type: 'sql',
							id: 'sql_saved_1',
							name: 'Warehouse Query',
							query: exactSqlQuery,
							serverUrl: 'tcp:sql.example.test,1433',
							connectionIdHint: 'sql-warehouse',
							targetSignature,
							database: 'Warehouse',
							expanded: false,
							resultsVisible: false,
							favoritesMode: true,
							resultJson,
							resultArtifact,
							runMode: 'all',
							editorHeightPx: 310,
							resultsHeightPx: 420,
							copilotChatVisible: true,
							copilotChatWidthPx: 360,
						},
					],
				},
			});

			expect(pState.pendingSqlQueryByBoxId.sql_saved_1).toBe(exactSqlQuery);
			expect(testState.addSqlBox).toHaveBeenCalledWith({
				id: 'sql_saved_1',
				name: 'Warehouse Query',
				serverUrl: 'tcp:sql.example.test,1433',
				connectionIdHint: 'sql-warehouse',
				targetSignature,
				database: 'Warehouse',
				expanded: false,
				editorHeightPx: 310,
				copilotChatVisible: true,
				copilotChatWidthPx: 360,
			});
			expect(setRunMode).toHaveBeenCalledWith('sql_saved_1', 'all');
			expect(pState.resultsVisibleByBoxId.sql_saved_1).toBe(false);
			expect(testState.sqlElements.sql_saved_1.setFavoritesMode).toHaveBeenCalledWith(true);
			expect(sqlFavoritesModeByBoxId.sql_saved_1).toBe(true);
			expect(pState.queryResultJsonByBoxId.sql_saved_1).toBe(resultJson);
			expect(displayResultForBox).not.toHaveBeenCalled();
			expect(testState.sqlBoxes).toEqual(['sql_saved_1']);

			flushDeferredRestoreTimers();

			expect(pState.lastExecutedBox).toBe('sql_saved_1');
			expect(displayResultForBox).toHaveBeenCalledWith(JSON.parse(resultJson), 'sql_saved_1', {
				label: 'Results', showExecutionTime: true,
				artifactPublication: expect.objectContaining({
					producer: expect.objectContaining({ query: exactSqlQuery }),
					policy: expect.objectContaining({ shareToClipboard: true, exportToCsv: true }),
				}),
			});
			expect(pState.resultArtifactByBoxId.sql_saved_1).toEqual(resultArtifact);
			expect(document.getElementById('sql_saved_1_sql_results_wrapper')?.style.height).toBe('420px');
			expect(document.getElementById('sql_saved_1_sql_results_wrapper')?.dataset.kustoUserResized).toBe('true');
		} finally {
			vi.useRealTimers();
		}
	});

	it('renders SQL rows but rejects forged clipboard producer provenance on restore', () => {
		vi.useFakeTimers();
		try {
			const sqlConnection = {
				id: 'sql-forged', name: 'Forged', dialect: 'mssql', serverUrl: 'forged.example',
				database: 'Db', authType: 'sql-login', username: 'User',
			};
			testState.sqlConnections.push(sqlConnection);
			const resultJson = JSON.stringify({ columns: ['Value'], rows: [['persisted']], metadata: {} });
			const resultArtifact = {
				version: 1, artifactId: 'result:sql_forged:2', sourceBoxId: 'sql_forged', revision: 2, createdAt: 123,
				producer: {
					engine: 'sql', boxId: 'sql_forged', executionId: 'sql-execution',
					query: 'SELECT forged=1', connectionId: 'sql-forged', database: 'Db',
				},
				policy: { exposeToActiveContent: true, shareToClipboard: true, exportToCsv: true },
			};

			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/sql-forged.sqlx',
				state: { sections: [{
					type: 'sql', id: 'sql_forged', query: 'SELECT 1 AS Value', serverUrl: 'forged.example',
					connectionIdHint: 'sql-forged', targetSignature: sqlConnectionTargetSignature(sqlConnection),
					database: 'Db', resultJson, resultArtifact,
				}] },
			});
			flushDeferredRestoreTimers();

			expect(displayResultForBox).toHaveBeenCalledWith(
				expect.objectContaining({ rows: [['persisted']] }),
				'sql_forged',
				{ label: 'Results', showExecutionTime: true },
			);
			expect(pState.resultArtifactByBoxId.sql_forged).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		['query edit', (id: string) => { pState.pendingSqlQueryByBoxId[id] = 'SELECT changed=1'; }],
		['database change', (id: string) => { testState.sqlElements[id].getDatabase = () => 'OtherDb'; }],
	] as const)('discards SQL restore after a live %s before idle admission', (_label, mutate) => {
		vi.useFakeTimers();
		try {
			const sqlConnection = {
				id: 'sql-race', name: 'Race', dialect: 'mssql', serverUrl: 'race.example',
				database: 'Db', authType: 'sql-login', username: 'User',
			};
			testState.sqlConnections.push(sqlConnection);
			const resultJson = JSON.stringify({ columns: ['Value'], rows: [['old']], metadata: {} });
			const resultArtifact = {
				version: 1, artifactId: 'result:sql_race:2', sourceBoxId: 'sql_race', revision: 2, createdAt: 123,
				producer: {
					engine: 'sql', boxId: 'sql_race', executionId: 'sql-execution',
					query: 'SELECT 1 AS Value', connectionId: 'sql-race', database: 'Db',
				},
				policy: { exposeToActiveContent: true, shareToClipboard: true, exportToCsv: true },
			};
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: `file:///tmp/sql-race-${_label}.sqlx`,
				state: { sections: [{
					type: 'sql', id: 'sql_race', query: 'SELECT 1 AS Value', serverUrl: 'race.example',
					connectionIdHint: 'sql-race', targetSignature: sqlConnectionTargetSignature(sqlConnection),
					database: 'Db', resultJson, resultArtifact,
				}] },
			});
			mutate('sql_race');
			flushDeferredRestoreTimers();

			expect(displayResultForBox).not.toHaveBeenCalledWith(
				expect.objectContaining({ rows: [['old']] }), 'sql_race', expect.anything(),
			);
			expect(pState.queryResultJsonByBoxId.sql_race).toBeUndefined();
			expect(pState.resultArtifactByBoxId.sql_race).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		{ connectionIdHint: 'sql-a' },
		{ targetSignature: 'target-a' },
	])('does not restore SQL rows with partial owner metadata: %j', partialOwner => {
		const resultJson = JSON.stringify({ columns: [{ name: 'Secret' }], rows: [['partial-owner']] });
		testState.sqlConnections.push({ id: 'sql-a', serverUrl: 'shared.example' });

		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/partial.sqlx',
			state: { sections: [{
				type: 'sql', id: 'sql_partial', serverUrl: 'shared.example',
				...partialOwner, query: 'SELECT 1', resultJson,
			}] },
		});

		expect(pState.queryResultJsonByBoxId.sql_partial).toBeUndefined();
	});

	it('defers a complete-owner SQL result until the cold connection snapshot validates it', () => {
		const connection = {
			id: 'sql-cold', name: 'Cold', dialect: 'mssql', serverUrl: 'cold.example',
			database: 'Db', authType: 'sql-login', username: 'ColdUser',
		};
		const targetSignature = sqlConnectionTargetSignature(connection);
		const resultJson = JSON.stringify({ columns: [{ name: 'Value' }], rows: [[1]] });

		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/cold.sqlx',
			state: { sections: [{
				type: 'sql', id: 'sql_cold', serverUrl: 'cold.example', database: 'Db',
				connectionIdHint: 'sql-cold', targetSignature, query: 'SELECT 1', resultJson,
			}] },
		});
		expect(pState.queryResultJsonByBoxId.sql_cold).toBeUndefined();

		testState.sqlConnections.push(connection);
		testState.sqlElements.sql_cold.getConnectionId = () => 'sql-cold';
		resolvePendingSqlResultRestores();

		expect(pState.queryResultJsonByBoxId.sql_cold).toBe(resultJson);
	});

	it('preserves safe pending SQL results when another connection is Leave No Trace', () => {
		const safe = {
			id: 'sql-safe', name: 'Safe', dialect: 'mssql', serverUrl: 'safe.example',
			database: 'Db', authType: 'sql-login', username: 'SafeUser',
		};
		const protectedConnection = {
			id: 'sql-protected', name: 'Protected', dialect: 'mssql', serverUrl: 'protected.example',
			database: 'Db', authType: 'sql-login', username: 'ProtectedUser',
		};
		const safeResult = JSON.stringify({ columns: [{ name: 'Value' }], rows: [['safe']] });
		const protectedResult = JSON.stringify({ columns: [{ name: 'Value' }], rows: [['protected']] });

		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/mixed-lnt.sqlx',
			state: { sections: [
				{
					type: 'sql', id: 'sql_safe', serverUrl: safe.serverUrl, database: 'Db', query: 'SELECT 1',
					connectionIdHint: safe.id, targetSignature: sqlConnectionTargetSignature(safe), resultJson: safeResult,
				},
				{
					type: 'sql', id: 'sql_protected', serverUrl: protectedConnection.serverUrl, database: 'Db', query: 'SELECT 2',
					connectionIdHint: protectedConnection.id, targetSignature: sqlConnectionTargetSignature(protectedConnection), resultJson: protectedResult,
				},
			] },
		});

		discardPendingSqlResultRestores([protectedConnection.id]);
		testState.sqlConnections.push(safe, protectedConnection);
		testState.sqlElements.sql_safe.getConnectionId = () => safe.id;
		testState.sqlElements.sql_protected.getConnectionId = () => protectedConnection.id;
		resolvePendingSqlResultRestores();

		expect(pState.queryResultJsonByBoxId.sql_safe).toBe(safeResult);
		expect(pState.queryResultJsonByBoxId.sql_protected).toBeUndefined();
	});

	it.each([
		{ label: 'rotated', persistedPrincipal: 'principal-a', currentPrincipal: 'principal-b' },
		{ label: 'legacy-missing', persistedPrincipal: undefined, currentPrincipal: 'principal-b' },
	])('does not restore $label AAD rows or SQL comparison rows under another principal', ({ persistedPrincipal, currentPrincipal }) => {
		const connection = {
			id: 'sql-aad', name: 'AAD', dialect: 'mssql', serverUrl: 'aad.example',
			database: 'Db', authType: 'aad',
		};
		const sourceResult = JSON.stringify({ columns: [{ name: 'Secret' }], rows: [['source-a']] });
		const comparisonResult = JSON.stringify({ columns: [{ name: 'Secret' }], rows: [['comparison-a']] });
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/aad-rotation.sqlx',
			state: { sections: [
				{
					type: 'sql', id: 'sql_aad', serverUrl: connection.serverUrl, database: 'Db', query: 'SELECT 1',
					connectionIdHint: connection.id, targetSignature: sqlConnectionTargetSignature(connection),
					...(persistedPrincipal ? { principalFingerprint: persistedPrincipal } : {}),
					resultJson: sourceResult,
				},
				{ type: 'query', id: 'query_cmp_aad', comparisonSourceBoxId: 'sql_aad', query: 'SELECT 2', resultJson: comparisonResult },
			] },
		});

		testState.sqlConnections.push({ ...connection, principalFingerprint: currentPrincipal });
		testState.sqlElements.sql_aad.getConnectionId = () => connection.id;
		resolvePendingSqlResultRestores();

		expect(pState.queryResultJsonByBoxId.sql_aad).toBeUndefined();
		expect(pState.queryResultJsonByBoxId.query_cmp_aad).toBeUndefined();
	});

	it('restores AAD source and comparison rows only for the exact persisted principal', () => {
		const connection = {
			id: 'sql-aad-match', name: 'AAD', dialect: 'mssql', serverUrl: 'aad-match.example',
			database: 'Db', authType: 'aad', principalFingerprint: 'principal-a',
		};
		const sourceResult = JSON.stringify({ columns: [{ name: 'Value' }], rows: [[1]] });
		const comparisonResult = JSON.stringify({ columns: [{ name: 'Value' }], rows: [[2]] });
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/aad-match.sqlx',
			state: { sections: [
				{
					type: 'sql', id: 'sql_aad_match', serverUrl: connection.serverUrl, database: 'Db', query: 'SELECT 1',
					connectionIdHint: connection.id, targetSignature: sqlConnectionTargetSignature(connection),
					principalFingerprint: connection.principalFingerprint, resultJson: sourceResult,
				},
				{ type: 'query', id: 'query_cmp_aad_match', comparisonSourceBoxId: 'sql_aad_match', query: 'SELECT 2', resultJson: comparisonResult },
			] },
		});

		testState.sqlConnections.push(connection);
		testState.sqlElements.sql_aad_match.getConnectionId = () => connection.id;
		resolvePendingSqlResultRestores();

		expect(pState.queryResultJsonByBoxId.sql_aad_match).toBe(sourceResult);
		expect(pState.queryResultJsonByBoxId.query_cmp_aad_match).toBe(comparisonResult);
	});

	it('does not restore SQL rows after a later LNT revocation generation', () => {
		const connection = {
			id: 'sql-revoked', name: 'Revoked', dialect: 'mssql', serverUrl: 'revoked.example',
			database: 'Db', authType: 'sql-login', username: 'user', revocationGeneration: 1,
		};
		const resultJson = JSON.stringify({ columns: [{ name: 'Secret' }], rows: [['pre-revocation']] });
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/revoked.sqlx',
			state: { sections: [{
				type: 'sql', id: 'sql_revoked', serverUrl: connection.serverUrl, database: 'Db', query: 'SELECT 1',
				connectionIdHint: connection.id, targetSignature: sqlConnectionTargetSignature(connection),
				revocationGeneration: 0, resultJson,
			}] },
		});

		testState.sqlConnections.push(connection);
		testState.sqlElements.sql_revoked.getConnectionId = () => connection.id;
		resolvePendingSqlResultRestores();

		expect(pState.queryResultJsonByBoxId.sql_revoked).toBeUndefined();
	});

	it('does not admit a cold SQL comparison after Leave No Trace is applied', () => {
		const connection = {
			id: 'sql-sensitive', name: 'Sensitive', dialect: 'mssql', serverUrl: 'sensitive.example',
			database: 'Db', authType: 'sql-login', username: 'SensitiveUser',
		};
		const targetSignature = sqlConnectionTargetSignature(connection);
		const sourceResult = JSON.stringify({ columns: [{ name: 'Secret' }], rows: [['source']] });
		const comparisonResult = JSON.stringify({ columns: [{ name: 'Secret' }], rows: [['comparison']] });

		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/cold-lnt.sqlx',
			state: { sections: [
				{
					type: 'sql', id: 'sql_sensitive', serverUrl: 'sensitive.example', database: 'Db',
					connectionIdHint: connection.id, targetSignature, query: 'SELECT 1', resultJson: sourceResult,
				},
				{ type: 'query', id: 'query_cmp', comparisonSourceBoxId: 'sql_sensitive', query: 'SELECT 2', resultJson: comparisonResult },
			] },
		});
		testState.sqlConnections.push(connection);
		const source = testState.sqlElements.sql_sensitive;
		source.getConnectionId = () => connection.id;
		source.setLeaveNoTraceConnectionIds([connection.id]);

		resolvePendingSqlResultRestores();

		expect(pState.queryResultJsonByBoxId.sql_sensitive).toBeUndefined();
		expect(pState.queryResultJsonByBoxId.query_cmp).toBeUndefined();
	});

	it('skips an orphaned SQL comparison before creating or restoring its data', () => {
		const resultJson = JSON.stringify({ columns: [{ name: 'Secret' }], rows: [['orphaned-row']] });
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/orphan.sqlx',
			state: {
				sections: [{
					type: 'query', id: 'query_cmp_orphan', comparisonSourceBoxId: 'sql_missing',
					query: 'SELECT 2', resultJson,
				}],
			},
		});

		expect(testState.addQueryBox).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'query_cmp_orphan' }));
		expect(testState.queryBoxes).not.toContain('query_cmp_orphan');
		expect(pState.pendingQueryTextByBoxId.query_cmp_orphan).toBeUndefined();
		expect(pState.queryResultJsonByBoxId.query_cmp_orphan).toBeUndefined();
		expect(optimizationMetadataByBoxId.query_cmp_orphan).toBeUndefined();
	});

	it.each([
		['missing source', [
			{ type: 'sql', id: 'sql_comparison', comparisonSourceBoxId: 'sql_missing', query: 'SELECT 2' },
		]],
		['self source', [
			{ type: 'sql', id: 'sql_comparison', comparisonSourceBoxId: 'sql_comparison', query: 'SELECT 2' },
		]],
		['wrong-type source', [
			{ type: 'markdown', id: 'markdown_source', text: 'not SQL' },
			{ type: 'sql', id: 'sql_comparison', comparisonSourceBoxId: 'markdown_source', query: 'SELECT 2' },
		]],
	] as const)('rejects SQL comparison restore with %s before DOM mutation', (_label, sections) => {
		const applied = handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: `file:///tmp/${_label}.sqlx`,
			documentKind: 'sqlx',
			allowedSectionKinds: ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'],
			defaultSectionKind: 'sql', state: { sections },
		});

		expect(applied).toBe(false);
		expect(testState.addSqlBox).not.toHaveBeenCalled();
		expect(testState.addMarkdownBox).not.toHaveBeenCalled();
		expect(document.getElementById('kusto-malformed-document-banner')?.textContent)
			.toContain('invalid source');
		expect(pState.documentMutationAllowed).toBe(false);
		expect(createSectionWithCapabilities('markdown')).toMatchObject({
			ok: false, error: expect.stringContaining('read-only'),
		});
		expect(window.addMarkdownBox({ id: 'forged_after_malformed' })).toBe('');
		expect(testState.addMarkdownBox).not.toHaveBeenCalled();
	});

	it('does not restore SQL comparison rows while the existing source owner is unresolved', () => {
		const resultJson = JSON.stringify({ columns: [{ name: 'Secret' }], rows: [['unresolved-row']] });
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/unresolved.sqlx',
			state: {
				sections: [
					{ type: 'sql', id: 'sql_source', connectionIdHint: 'missing', targetSignature: 'missing-target', serverUrl: 'unknown.example', query: 'SELECT 1' },
					{ type: 'query', id: 'query_cmp', comparisonSourceBoxId: 'sql_source', query: 'SELECT 2', resultJson },
				],
			},
		});

		expect(testState.queryBoxes).toContain('query_cmp');
		expect(pState.queryResultJsonByBoxId.query_cmp).toBeUndefined();
	});

	it('does not restore SQL source or comparison rows through a stale same-box owner', () => {
		const sourceResult = JSON.stringify({ columns: [{ name: 'Secret' }], rows: [['owner-b']] });
		const comparisonResult = JSON.stringify({ columns: [{ name: 'Secret' }], rows: [['owner-b-comparison']] });
		testState.sqlConnections.push({ id: 'sql-a', serverUrl: 'shared.example' });
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/owner-b.sqlx',
			state: { sections: [
				{
					type: 'sql', id: 'sql_source', serverUrl: 'shared.example', connectionIdHint: 'sql-b',
					targetSignature: 'owner-b-target', query: 'SELECT 1', resultJson: sourceResult,
				},
				{ type: 'query', id: 'query_cmp', comparisonSourceBoxId: 'sql_source', query: 'SELECT 2', resultJson: comparisonResult },
			] },
		});

		expect(pState.queryResultJsonByBoxId.sql_source).toBeUndefined();
		expect(pState.queryResultJsonByBoxId.query_cmp).toBeUndefined();
	});

	it.each(['source-first', 'comparison-first'] as const)(
		'restores a warm lineage-bearing SQL comparison in %s order',
		(order) => {
		vi.useFakeTimers();
		try {
			const connection = {
				id: 'sql-warm-order', name: 'Warm', dialect: 'mssql', serverUrl: 'warm-order.example',
				database: 'Db', authType: 'sql-login', username: 'User',
			};
			testState.sqlConnections.push(connection);
			const targetSignature = sqlConnectionTargetSignature(connection);
			const sourceResult = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
			const comparisonResult = JSON.stringify({ columns: ['Value'], rows: [[2]], metadata: {} });
			const sourceArtifact = {
				artifactId: 'result:sql_warm_source:1', sourceBoxId: 'sql_warm_source', revision: 1,
				createdAt: 124, restored: true, columns: ['Value'], rows: [[1]], metadata: {},
				producer: {
					engine: 'sql', boxId: 'sql_warm_source', executionId: 'sql-source-execution', query: 'SELECT 1 AS Value',
					connectionId: connection.id, database: 'Db',
				},
				policy: { exposeToActiveContent: true, shareToClipboard: true, exportToCsv: true },
				lineage: [],
			};
			const sourceDescriptor = {
				version: 1, artifactId: sourceArtifact.artifactId, sourceBoxId: sourceArtifact.sourceBoxId,
				revision: sourceArtifact.revision, createdAt: sourceArtifact.createdAt,
				producer: sourceArtifact.producer, policy: sourceArtifact.policy,
			};
			const comparisonPublication = createDerivedResultArtifactPublication(
				{
					engine: 'sql', boxId: 'query_warm_cmp', query: 'SELECT 2 AS Value',
					connectionId: connection.id, database: 'Db', producer: 'comparison',
				},
				[{ artifact: sourceArtifact, role: 'comparison-source' }],
			);
			const comparisonDescriptor = {
				version: 1, artifactId: 'result:query_warm_cmp:2', sourceBoxId: 'query_warm_cmp',
				revision: 2, createdAt: 125,
				producer: {
					engine: 'sql', boxId: 'query_warm_cmp', executionId: 'sql-comparison-execution',
					query: 'SELECT 2 AS Value', connectionId: connection.id, database: 'Db', producer: 'comparison',
				},
				policy: comparisonPublication.policy,
				lineage: comparisonPublication.lineage,
			};
			let sourceRendered = false;
			let comparisonRendered = false;
			const comparisonArtifact = {
				...comparisonDescriptor, restored: true, columns: ['Value'], rows: [[2]], metadata: {},
			};
			vi.mocked(displayResultForBox).mockImplementation((_result, boxId) => {
				if (boxId === 'sql_warm_source') sourceRendered = true;
				if (boxId === 'query_warm_cmp') comparisonRendered = true;
				return true;
			});
			testState.getCurrentResultArtifact.mockImplementation((boxId: unknown) => {
				if (sourceRendered && String(boxId) === 'sql_warm_source') return sourceArtifact;
				if (comparisonRendered && String(boxId) === 'query_warm_cmp') return comparisonArtifact;
				return null;
			});
			const sourceSection = {
				type: 'sql', id: 'sql_warm_source', query: 'SELECT 1 AS Value', serverUrl: connection.serverUrl,
				connectionIdHint: connection.id, targetSignature, database: 'Db',
				resultJson: sourceResult, resultArtifact: sourceDescriptor,
			};
			const comparisonSection = {
				type: 'query', id: 'query_warm_cmp', comparisonSourceBoxId: 'sql_warm_source',
				query: 'SELECT 2 AS Value', resultJson: comparisonResult, resultArtifact: comparisonDescriptor,
			};

			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/sql-warm-order.sqlx',
				state: { sections: order === 'source-first'
					? [sourceSection, comparisonSection]
					: [comparisonSection, sourceSection] },
			});
			flushDeferredRestoreTimers();
			flushDeferredRestoreTimers();

			expect(displayResultForBox).toHaveBeenCalledWith(
				expect.objectContaining({ rows: [[1]] }), 'sql_warm_source',
				expect.objectContaining({ artifactPublication: expect.anything() }),
			);
			expect(displayResultForBox).toHaveBeenCalledWith(
				expect.objectContaining({ rows: [[2]] }), 'query_warm_cmp',
				expect.objectContaining({
					artifactPublication: expect.objectContaining({
						lineage: comparisonDescriptor.lineage,
						policy: expect.objectContaining({ shareToClipboard: true, exportToCsv: true }),
					}),
				}),
			);
			expect(pState.resultArtifactByBoxId.query_warm_cmp).toEqual(comparisonDescriptor);
		} finally {
			vi.useRealTimers();
		}
	});

	it('restores a Kusto optimization comparison and its persisted result', () => {
		vi.useFakeTimers();
		try {
			testState.kustoConnections.push(ownedKustoConnection({ id: 'cluster-default', clusterUrl: 'https://cluster.kusto.windows.net' }));
			const sourceResultJson = JSON.stringify({ columns: [{ name: 'Value' }], rows: [[1]] });
			const resultJson = JSON.stringify({ columns: [{ name: 'Value' }], rows: [[2]] });
			const sourcePolicy = {
				accountPartition: 'partition-a', leaveNoTraceRevision: 0,
				exposeToActiveContent: true, sendToModel: true,
				shareToClipboard: true, exportToCsv: true,
			};
			const sourceArtifact = {
				artifactId: 'result:query_source:3', sourceBoxId: 'query_source', revision: 3, createdAt: 100,
				restored: true, columns: [{ name: 'Value' }], rows: [[1]], metadata: {},
				producer: {
					engine: 'kusto', boxId: 'query_source', executionId: 'source-execution',
					query: 'T | count', connectionId: 'cluster-default', database: 'Db',
				},
				policy: sourcePolicy, lineage: [],
			};
			let sourceRendered = false;
			let comparisonRendered = false;
			vi.mocked(displayResultForBox).mockImplementation((_result, boxId) => {
				if (boxId === 'query_source') sourceRendered = true;
				if (boxId === 'query_cmp') comparisonRendered = true;
				return true;
			});
			const sourceDescriptor = {
				version: 1, artifactId: sourceArtifact.artifactId, sourceBoxId: 'query_source',
				revision: 3, createdAt: 100, producer: sourceArtifact.producer, policy: sourcePolicy,
			};
			const comparisonPublication = createDerivedResultArtifactPublication(
				{ engine: 'kusto', boxId: 'query_cmp', producer: 'comparison' },
				[{ artifact: sourceArtifact, role: 'comparison-source' }],
			);
			const comparisonDescriptor = {
				version: 1, artifactId: 'result:query_cmp:4', sourceBoxId: 'query_cmp', revision: 4, createdAt: 200,
				producer: {
					engine: 'kusto', boxId: 'query_cmp', executionId: 'comparison-execution',
					query: 'T | summarize count()', connectionId: 'cluster-default', database: 'Db',
				},
				policy: comparisonPublication.policy,
				lineage: comparisonPublication.lineage,
			};
			const comparisonArtifact = {
				artifactId: comparisonDescriptor.artifactId, sourceBoxId: 'query_cmp', revision: 4, createdAt: 200,
				restored: true, columns: [{ name: 'Value' }], rows: [[2]], metadata: {},
				producer: comparisonDescriptor.producer, policy: comparisonDescriptor.policy,
				lineage: comparisonDescriptor.lineage,
			};
			testState.getCurrentResultArtifact.mockImplementation((boxId: unknown) => {
				if (sourceRendered && String(boxId) === 'query_source') return sourceArtifact;
				if (comparisonRendered && String(boxId) === 'query_cmp') return comparisonArtifact;
				return null;
			});
			expect(publicationFromPersistedResultArtifact(comparisonDescriptor, 'query_cmp', {
				accountPartition: 'partition-a', leaveNoTraceRevision: 0,
				exposeToActiveContent: true, sendToModel: true,
				shareToClipboard: true, exportToCsv: true,
				derivedLineage: comparisonPublication.lineage,
				derivedSourcePolicies: comparisonPublication.policy?.sourcePolicies,
			})).toBeDefined();
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/comparison.kqlx',
				state: {
					sections: [
						{
							type: 'query', id: 'query_source', clusterUrl: 'https://cluster.kusto.windows.net',
							database: 'Db', query: 'T | count', resultJson: sourceResultJson,
							resultArtifact: sourceDescriptor, ...kustoResultOwner,
						},
						{
							type: 'query', id: 'query_cmp', comparisonSourceBoxId: 'query_source',
							clusterUrl: 'https://cluster.kusto.windows.net', database: 'Db',
							query: 'T | summarize count()', resultJson,
							resultArtifact: comparisonDescriptor, ...kustoResultOwner,
						},
					],
				},
			});
			applyKustoLeaveNoTracePolicy([], false);

			expect(testState.queryBoxes).toEqual(expect.arrayContaining(['query_source', 'query_cmp']));
			expect(optimizationMetadataByBoxId.query_cmp).toMatchObject({ sourceBoxId: 'query_source', isComparison: true });
			expect(pState.queryResultJsonByBoxId.query_cmp).toBeUndefined();
			flushDeferredRestoreTimers();
			flushDeferredRestoreTimers();
			expect(sourceRendered).toBe(true);
			expect(displayResultForBox).toHaveBeenCalledWith(
				expect.objectContaining({ rows: [[2]] }),
				'query_cmp',
				expect.anything(),
			);
			expect(pState.queryResultJsonByBoxId.query_cmp).toBe(resultJson);
			expect(pState.resultArtifactByBoxId.query_cmp).toEqual(comparisonDescriptor);
		} finally {
			vi.useRealTimers();
		}
	});

	it('preserves legacy active-content permission without granting model use on restore', () => {
		vi.useFakeTimers();
		try {
			testState.kustoConnections.push(ownedKustoConnection({
				id: 'public-default', clusterUrl: 'https://public.kusto.windows.net',
			}));
			const resultJson = JSON.stringify({ columns: ['Value'], rows: [['legacy']], metadata: {} });
			const resultArtifact = {
				version: 1, artifactId: 'result:query_legacy_exposure:2', sourceBoxId: 'query_legacy_exposure',
				revision: 2, createdAt: 123,
				producer: { engine: 'kusto', boxId: 'query_legacy_exposure', executionId: 'legacy-execution' },
				policy: {
					accountPartition: 'partition-a', leaveNoTraceRevision: 0,
					exposeToActiveContent: true,
				},
			};

			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/legacy-exposure.kqlx',
				state: { sections: [{
					type: 'query', id: 'query_legacy_exposure', query: 'print value=1',
					clusterUrl: 'https://public.kusto.windows.net', database: 'Db',
					resultJson, resultArtifact, ...kustoResultOwner,
				}] },
			});
			applyKustoLeaveNoTracePolicy([], false);
			flushDeferredRestoreTimers();

			expect(displayResultForBox).toHaveBeenCalledWith(
				expect.objectContaining({ rows: [['legacy']] }),
				'query_legacy_exposure',
				expect.objectContaining({
					artifactPublication: expect.objectContaining({
						policy: expect.objectContaining({ exposeToActiveContent: true }),
					}),
				}),
			);
			const publication = vi.mocked(displayResultForBox).mock.calls
				.find(([, boxId]) => boxId === 'query_legacy_exposure')?.[2]?.artifactPublication;
			expect(publication?.policy?.sendToModel).toBeUndefined();
			expect(publication?.policy?.shareToClipboard).toBeUndefined();
			expect(publication?.policy?.exportToCsv).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not trust a forged exposure-only restored query as producer provenance', () => {
		vi.useFakeTimers();
		try {
			testState.kustoConnections.push(ownedKustoConnection({
				id: 'public-default', clusterUrl: 'https://public.kusto.windows.net',
			}));
			const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
			const resultArtifact = {
				version: 1, artifactId: 'result:query_forged_exposure:2', sourceBoxId: 'query_forged_exposure',
				revision: 2, createdAt: 123,
				producer: {
					engine: 'kusto', boxId: 'query_forged_exposure', query: 'HiddenTable | take 100',
					connectionId: 'public-default', database: 'Db',
				},
				policy: {
					accountPartition: 'partition-a', leaveNoTraceRevision: 0,
					exposeToActiveContent: true,
				},
			};
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/forged-exposure.kqlx',
				state: { sections: [{
					type: 'query', id: 'query_forged_exposure', query: 'print Value=1',
					clusterUrl: 'https://public.kusto.windows.net', database: 'Db',
					resultJson, resultArtifact, ...kustoResultOwner,
				}] },
			});
			applyKustoLeaveNoTracePolicy([], false);
			flushDeferredRestoreTimers();

			const publication = vi.mocked(displayResultForBox).mock.calls
				.find(([, boxId]) => boxId === 'query_forged_exposure')?.[2]?.artifactPublication;
			expect(publication?.producer).toBeUndefined();
			expect(publication?.policy?.exposeToActiveContent).toBeUndefined();
			expect(JSON.stringify(publication || {})).not.toContain('HiddenTable');
		} finally {
			vi.useRealTimers();
		}
	});

	it('drops forged restored exposure when the live query is empty', () => {
		vi.useFakeTimers();
		try {
			testState.kustoConnections.push(ownedKustoConnection({
				id: 'public-default', clusterUrl: 'https://public.kusto.windows.net',
			}));
			const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
			const resultArtifact = {
				version: 1, artifactId: 'result:query_empty_forged:2', sourceBoxId: 'query_empty_forged',
				revision: 2, createdAt: 123,
				producer: {
					engine: 'kusto', boxId: 'query_empty_forged', query: 'HiddenTable | take 100',
					connectionId: 'public-default', database: 'Db',
				},
				policy: {
					accountPartition: 'partition-a', leaveNoTraceRevision: 0,
					exposeToActiveContent: true,
				},
			};
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/empty-forged.kqlx',
				state: { sections: [{
					type: 'query', id: 'query_empty_forged', query: 'print Value=1',
					clusterUrl: 'https://public.kusto.windows.net', database: 'Db',
					resultJson, resultArtifact, ...kustoResultOwner,
				}] },
			});
			applyKustoLeaveNoTracePolicy([], false);
			testState.queryEditors.query_empty_forged = { getValue: () => '' };
			delete pState.pendingQueryTextByBoxId.query_empty_forged;
			flushDeferredRestoreTimers();

			const options = vi.mocked(displayResultForBox).mock.calls
				.find(([, boxId]) => boxId === 'query_empty_forged')?.[2];
			expect(options?.artifactPublication).toBeUndefined();
			expect(JSON.stringify(options || {})).not.toContain('HiddenTable');
		} finally {
			vi.useRealTimers();
		}
	});

	it('discards cyclic Kusto comparison restore dependencies', () => {
		vi.useFakeTimers();
		try {
			testState.kustoConnections.push(ownedKustoConnection({
				id: 'public-default', clusterUrl: 'https://public.kusto.windows.net',
			}));
			const resultJson = JSON.stringify({ columns: ['Secret'], rows: [['cycle']], metadata: {} });
			const section = (id: string, comparisonSourceBoxId: string) => ({
				type: 'query', id, comparisonSourceBoxId, query: `print id='${id}'`,
				clusterUrl: 'https://public.kusto.windows.net', database: 'Db',
				resultJson, ...kustoResultOwner,
			});

			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/comparison-cycles.kqlx',
				state: { sections: [
					section('query_cycle_a', 'query_cycle_b'),
					section('query_cycle_b', 'query_cycle_a'),
					section('query_cycle_c', 'query_cycle_d'),
					section('query_cycle_d', 'query_cycle_e'),
					section('query_cycle_e', 'query_cycle_c'),
				] },
			});
			applyKustoLeaveNoTracePolicy([], false);
			for (let index = 0; index < 6; index++) flushDeferredRestoreTimers();

			expect(getDeferredRestoredResultJobCountForTest()).toBe(0);
			expect(displayResultForBox).not.toHaveBeenCalledWith(
				expect.objectContaining({ rows: [['cycle']] }), expect.anything(), expect.anything(),
			);
			for (const id of ['query_cycle_a', 'query_cycle_b', 'query_cycle_c', 'query_cycle_d', 'query_cycle_e']) {
				expect(pState.queryResultJsonByBoxId[id]).toBeUndefined();
				expect(pState.resultArtifactByBoxId[id]).toBeUndefined();
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it('rebuilds conservative artifact lineage for a migrated descriptorless Kusto comparison', () => {
		vi.useFakeTimers();
		try {
			const clusterUrl = 'https://legacy-comparison.kusto.windows.net';
			testState.kustoConnections.push(ownedKustoConnection({ id: 'legacy-comparison-owner', clusterUrl }));
			const sourceId = 'query_legacy_comparison_source';
			const comparisonId = 'query_legacy_comparison_output';
			const sourceResultJson = JSON.stringify({ columns: [{ name: 'Value' }], rows: [[1]], metadata: {} });
			const comparisonResultJson = JSON.stringify({ columns: [{ name: 'Value' }], rows: [[2]], metadata: {} });
			const sourcePolicy = { accountPartition: 'partition-a', leaveNoTraceRevision: 0 };
			const sourceArtifact = {
				artifactId: `result:${sourceId}:1`, sourceBoxId: sourceId, revision: 1, createdAt: 1,
				restored: false, columns: [{ name: 'Value' }], rows: [[1]], metadata: {},
				producer: {
					engine: 'kusto', boxId: sourceId, query: 'T',
					connectionId: 'legacy-comparison-owner', database: 'Db', producer: 'restored',
				},
				policy: sourcePolicy, lineage: [],
			};
			const derivedPublication = createDerivedResultArtifactPublication(
				{ engine: 'kusto', boxId: comparisonId, producer: 'comparison' },
				[{ artifact: sourceArtifact, role: 'comparison-source' }],
			);
			const comparisonArtifact = {
				artifactId: `result:${comparisonId}:1`, sourceBoxId: comparisonId, revision: 1, createdAt: 2,
				restored: false, columns: [{ name: 'Value' }], rows: [[2]], metadata: {},
				producer: {
					engine: 'kusto', boxId: comparisonId, query: 'T | count',
					connectionId: 'legacy-comparison-owner', database: 'Db', producer: 'comparison',
				},
				policy: derivedPublication.policy, lineage: derivedPublication.lineage,
			};
			let sourceRendered = false;
			let comparisonRendered = false;
			vi.mocked(displayResultForBox).mockImplementation((_result, boxId) => {
				if (boxId === sourceId) sourceRendered = true;
				if (boxId === comparisonId) comparisonRendered = true;
				return true;
			});
			testState.getCurrentResultArtifact.mockImplementation((boxId: unknown) => {
				if (sourceRendered && String(boxId) === sourceId) return sourceArtifact;
				if (comparisonRendered && String(boxId) === comparisonId) return comparisonArtifact;
				return null;
			});

			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true,
				documentUri: 'file:///tmp/legacy-comparison.kqlx',
				state: { sections: [
					{
						type: 'query', id: sourceId, query: 'T', clusterUrl,
						connectionIdHint: 'legacy-comparison-owner', database: 'Db',
						resultJson: sourceResultJson, ...kustoResultOwner,
					},
					{
						type: 'query', id: comparisonId, query: 'T | count',
						comparisonSourceBoxId: sourceId, resultJson: comparisonResultJson,
						...kustoResultOwner,
					},
				] },
			});
			applyKustoLeaveNoTracePolicy([], false);
			flushDeferredRestoreTimers();
			flushDeferredRestoreTimers();

			expect(displayResultForBox).toHaveBeenCalledWith(
				expect.objectContaining({ rows: [[1]] }), sourceId,
				expect.objectContaining({
					artifactPublication: expect.objectContaining({
						policy: sourcePolicy,
					}),
				}),
			);
			expect(displayResultForBox).toHaveBeenCalledWith(
				expect.objectContaining({ rows: [[2]] }), comparisonId,
				expect.objectContaining({
					artifactPublication: expect.objectContaining({
						lineage: derivedPublication.lineage,
						policy: derivedPublication.policy,
					}),
				}),
			);
			expect(derivedPublication.policy).toMatchObject(sourcePolicy);
			expect(derivedPublication.policy?.exposeToActiveContent).toBeUndefined();
			expect(derivedPublication.policy?.sendToModel).toBeUndefined();
			expect(derivedPublication.policy?.shareToClipboard).toBeUndefined();
			expect(derivedPublication.policy?.exportToCsv).toBeUndefined();
			expect(getDeferredRestoredResultJobCountForTest()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects a persisted Kusto comparison result owned by a different target than its source', () => {
		vi.useFakeTimers();
		try {
			testState.kustoConnections.push(
				{ id: 'source', clusterUrl: 'https://source.kusto.windows.net' },
				{ id: 'other', clusterUrl: 'https://other.kusto.windows.net' },
			);
			const resultJson = JSON.stringify({ columns: ['Secret'], rows: [['WRONG_TARGET']] });
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/mismatched-comparison.kqlx',
				state: { sections: [
					{ type: 'query', id: 'query_source', clusterUrl: 'https://source.kusto.windows.net', connectionIdHint: 'source', database: 'Db', query: 'T' },
					{ type: 'query', id: 'query_cmp', comparisonSourceBoxId: 'query_source', clusterUrl: 'https://other.kusto.windows.net', connectionIdHint: 'other', database: 'OtherDb', query: 'T | count', resultJson },
				] },
			});
			applyKustoLeaveNoTracePolicy([], false);
			flushDeferredRestoreTimers();

			expect(pState.queryResultJsonByBoxId.query_cmp).toBeUndefined();
			expect(displayResultForBox).not.toHaveBeenCalledWith(expect.anything(), 'query_cmp', expect.anything());
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not restore pre-lineage SQL comparison rows from a SQL connection hint', () => {
		const resultJson = JSON.stringify({ columns: [{ name: 'Secret' }], rows: [['legacy-secret']] });
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/legacy.sqlx',
			state: { sections: [{ type: 'query', id: 'legacy_sql_cmp', connectionIdHint: 'sql_old', query: 'SELECT 2', resultJson }] },
		});

		expect(testState.queryBoxes).toContain('legacy_sql_cmp');
		expect(pState.pendingQueryTextByBoxId.legacy_sql_cmp).toBe('SELECT 2');
		expect(pState.queryResultJsonByBoxId.legacy_sql_cmp).toBeUndefined();
	});

	it.each([
		['KQLX', 'kqlx', JSON.stringify({ columns: [{ name: 'Value' }], rows: [[1]], metadata: { cluster: 'legacy', database: 'Db' } })],
		['KQL sidecar', 'kql', JSON.stringify({ columns: [{ name: 'Value' }], rows: [[1]], metadata: { cluster: 'legacy', database: 'Db' } })],
		['KQLX mismatched', 'kqlx', JSON.stringify({ columns: [{ name: 'Value' }], rows: [[1]], metadata: { cluster: 'other', database: 'Db' } })],
		['KQL sidecar mismatched', 'kql', JSON.stringify({ columns: [{ name: 'Value' }], rows: [[1]], metadata: { cluster: 'other', database: 'Db' } })],
		['KQLX malformed', 'kqlx', '{"rows":'],
		['KQL sidecar malformed', 'kql', '{"rows":'],
	] as const)('keeps an unverified legacy Kusto cache inert for %s', (_label, documentKind, resultJson) => {
		vi.useFakeTimers();
		try {
			testState.kustoConnections.push(ownedKustoConnection({
				id: 'legacy-owner', clusterUrl: 'https://legacy.kusto.windows.net',
			}));
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true,
				documentKind, compatibilityMode: false, documentUri: `file:///tmp/legacy.${documentKind}`,
				state: { sections: [{
					id: 'legacy_result', type: 'query', query: 'print Value=1',
					clusterUrl: 'https://legacy.kusto.windows.net', connectionIdHint: 'legacy-owner',
					database: 'Db', resultJson,
				}] },
			});

			expect(getDeferredRestoredResultJobCountForTest()).toBe(0);
			expect(pState.queryResultJsonByBoxId.legacy_result).toBeUndefined();
			expect(displayResultForBox).not.toHaveBeenCalledWith(
				expect.anything(), 'legacy_result', expect.anything(),
			);
			vi.mocked(postMessageToHost).mockClear();
			applyKustoLeaveNoTracePolicy([], false);
			vi.runOnlyPendingTimers();

			expect(displayResultForBox).not.toHaveBeenCalledWith(
				expect.anything(), 'legacy_result', expect.anything(),
			);
			expect(postMessageToHost).not.toHaveBeenCalledWith(
				expect.objectContaining({ type: 'persistDocument' }),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not restore protected SQL resultJson into storage or shared results', () => {
		vi.useFakeTimers();
		const resultJson = JSON.stringify({ columns: [{ name: 'Secret' }], rows: [['protected-row']], metadata: {} });
		testState.sqlLeaveNoTraceConnectionIds.push('sql-sensitive');
		testState.sqlConnections.push({ id: 'sql-sensitive', serverUrl: 'server.example' });
		try {
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/protected.sqlx',
				state: { sections: [{ type: 'sql', id: 'sql_protected', serverUrl: 'server.example', resultJson }] },
			});
			const sqlEl = testState.sqlElements.sql_protected;
			expect(sqlEl.setLeaveNoTraceConnectionIds).toHaveBeenCalledWith(['sql-sensitive']);
			expect(pState.queryResultJsonByBoxId.sql_protected).toBeUndefined();
			vi.advanceTimersByTime(25);
			expect(displayResultForBox).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('restores persisted KQL query results to the saved section and keeps the next persist stable', () => {
		vi.useFakeTimers();
		testState.kustoConnections.push(ownedKustoConnection({ id: 'persisted-default', clusterUrl: 'https://persisted.example.kusto.windows.net' }));
		const resultJson = JSON.stringify({
			columns: [
				{ name: 'RowId', type: 'long' },
				{ name: 'Label', type: 'string' },
			],
			rows: [[1, 'persisted_alpha'], [2, 'persisted_beta']],
			metadata: { executionTime: '00:00:00.021', clientActivityId: 'cid_restore' },
		});

		try {
			handleDocumentDataMessage({
				type: 'documentData',
				ok: true,
				forceReload: true,
				documentUri: 'file:///tmp/query-results.kqlx',
				state: {
					sections: [
						{
							type: 'query',
							id: 'query_saved_results',
							name: 'Persisted Results',
							query: 'datatable(RowId:long, Label:string)[1, "persisted_alpha", 2, "persisted_beta"]',
							clusterUrl: 'https://persisted.example.kusto.windows.net',
							database: 'Samples',
							resultJson,
							...kustoResultOwner,
						},
					],
				},
			});
			applyKustoLeaveNoTracePolicy([], false);

			expect(testState.addQueryBox).toHaveBeenCalledWith({
				id: 'query_saved_results',
				expanded: true,
				clusterUrl: 'https://persisted.example.kusto.windows.net',
				database: 'Samples',
				authorityId: '',
				connectionIdHint: '',
			});
			expect(pState.pendingQueryTextByBoxId.query_saved_results).toContain('persisted_alpha');
			expect(pState.queryResultJsonByBoxId.query_saved_results).toBeUndefined();
			expect(displayResultForBox).not.toHaveBeenCalled();

			flushDeferredRestoreTimers();

			expect(pState.lastExecutedBox).toBe('query_saved_results');
			expect(pState.queryResultJsonByBoxId.query_saved_results).toBe(resultJson);
			expect(displayResultForBox).toHaveBeenCalledWith(
				JSON.parse(resultJson), 'query_saved_results',
				expect.objectContaining({
					label: 'Results', showExecutionTime: true,
					artifactPublication: expect.objectContaining({
						policy: { accountPartition: 'partition-a', leaveNoTraceRevision: 0 },
					}),
				}),
			);

			document.body.innerHTML = '';
			const container = document.createElement('div');
			container.id = 'queries-container';
			document.body.appendChild(container);
			const queryEl = document.createElement('div') as unknown as HTMLElement & { serialize: () => unknown };
			queryEl.id = 'query_saved_results';
			queryEl.serialize = () => ({
				id: 'query_saved_results',
				type: 'query',
				name: 'Persisted Results',
				clusterUrl: 'https://persisted.example.kusto.windows.net',
				database: 'Samples',
				query: pState.pendingQueryTextByBoxId.query_saved_results,
				resultJson: pState.queryResultJsonByBoxId.query_saved_results,
				resultsVisible: true,
			});
			container.appendChild(queryEl);

			vi.mocked(postMessageToHost).mockClear();
			schedulePersist('roundtrip', true);
			expect(postMessageToHost).toHaveBeenCalledTimes(1);
			const persistMessage = vi.mocked(postMessageToHost).mock.calls[0][0] as any;
			expect(persistMessage).toMatchObject({ type: 'persistDocument', reason: 'roundtrip' });
			expect(persistMessage.state.sections).toHaveLength(1);
			expect(persistMessage.state.sections[0].id).toBe('query_saved_results');
			expect(persistMessage.state.sections[0].resultJson).toBe(resultJson);
			acknowledgePersistDocument(persistMessage.snapshotId, persistMessage.editRevision);

			schedulePersist('roundtrip', true);
			expect(postMessageToHost).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		['KQLX', 'kqlx', 'file:///tmp/migrated-reopen.kqlx'],
		['KQL sidecar', 'kql', 'file:///tmp/migrated-reopen.kql'],
	] as const)('restores a migrated cached result after reopening in %s', (_label, documentKind, documentUri) => {
		vi.useFakeTimers();
		const clusterUrl = 'https://migrated-reopen.kusto.windows.net';
		const resultJson = JSON.stringify({
			columns: [{ name: 'Value', type: 'long' }], rows: [[42]],
			metadata: { cluster: 'migrated-reopen', database: 'Db' },
		});
		const state = { sections: [{
			id: 'query_migrated_reopen', type: 'query', query: 'print Value=42',
			clusterUrl, connectionIdHint: 'migrated-reopen-owner', database: 'Db', resultJson,
			...kustoResultOwner,
		}] };
		try {
			testState.kustoConnections.push(ownedKustoConnection({
				id: 'migrated-reopen-owner', clusterUrl,
			}));
			for (let open = 0; open < 2; open++) {
				vi.mocked(displayResultForBox).mockClear();
				handleDocumentDataMessage({
					type: 'documentData', ok: true, forceReload: true,
					documentKind, compatibilityMode: false, documentUri, state,
				});
				applyKustoLeaveNoTracePolicy([], false);
				flushDeferredRestoreTimers();

				expect(pState.queryResultJsonByBoxId.query_migrated_reopen).toBe(resultJson);
				expect(displayResultForBox).toHaveBeenCalledWith(
					expect.objectContaining({ rows: [[42]] }),
					'query_migrated_reopen',
					expect.anything(),
				);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it('publishes compatibility state and revision atomically without a debounce gap', () => {
		vi.useFakeTimers();
		try {
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true,
				documentKind: 'sql', compatibilityMode: false,
				documentUri: 'file:///tmp/revision.sql',
				state: { sections: [{ type: 'query', id: 'query_revision', query: 'print 1' }] },
			});
			document.body.innerHTML = '';
			const container = document.createElement('div');
			container.id = 'queries-container';
			document.body.appendChild(container);
			let queryText = 'print 2';
			const queryEl = document.createElement('div') as HTMLElement & { serialize: () => unknown };
			queryEl.id = 'query_revision';
			queryEl.serialize = () => ({ id: 'query_revision', type: 'query', query: queryText });
			container.appendChild(queryEl);
			if (!testState.queryBoxes.includes('query_revision')) testState.queryBoxes.push('query_revision');
			testState.queryEditors.query_revision = { getValue: () => 'print 1' };
			pState.documentKind = 'sql';
			pState.compatibilityMode = false;

			vi.mocked(postMessageToHost).mockClear();
			schedulePersist('immediate', true);
			queryText = 'print 3';
			schedulePersist('debounced', false);

			const messages = vi.mocked(postMessageToHost).mock.calls.map(call => call[0] as any);
			const persistMessages = messages.filter(message => message.type === 'persistDocument');
			expect(persistMessages).toHaveLength(2);
			expect(persistMessages[0].editRevision).toBe(1);
			expect(persistMessages[0].state.sections[0].query).toBe('print 2');
			expect(persistMessages[1]).toMatchObject({ reason: 'debounced', editRevision: 2 });
			expect(persistMessages[1].state.sections[0].query).toBe('print 3');
			expect(messages.some(message => message.type === 'documentEditRevision')).toBe(false);

			vi.advanceTimersByTime(400);
			expect(postMessageToHost).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('resends unchanged compatibility state until the exact snapshot is acknowledged', () => {
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'sql', compatibilityMode: false,
			documentUri: 'file:///tmp/retry.sql',
			state: { sections: [{ type: 'sql', id: 'sql_retry', query: 'select 1' }] },
		});
		document.body.innerHTML = '';
		const container = document.createElement('div');
		container.id = 'queries-container';
		const sql = document.createElement('div') as HTMLElement & { serialize: () => unknown };
		sql.id = 'sql_retry';
		sql.serialize = () => ({ id: 'sql_retry', type: 'sql', query: 'select 2' });
		container.appendChild(sql);
		document.body.appendChild(container);
		pState.documentKind = 'sql';
		pState.compatibilityMode = false;
		vi.mocked(postMessageToHost).mockClear();

		schedulePersist('first', true);
		schedulePersist('retry', true);

		const messages = vi.mocked(postMessageToHost).mock.calls.map(call => call[0] as any);
		expect(messages).toHaveLength(2);
		expect(messages.map(message => message.editRevision)).toEqual([1, 1]);
		expect(messages[1].snapshotId).not.toBe(messages[0].snapshotId);

		acknowledgePersistDocument(messages[1].snapshotId, messages[1].editRevision);
		schedulePersist('after-ack', true);
		expect(postMessageToHost).toHaveBeenCalledTimes(2);
	});

	it('resends unchanged rich-document state until the exact snapshot is acknowledged', () => {
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'kqlx', documentUri: 'file:///tmp/retry.kqlx',
			state: { sections: [{ type: 'query', id: 'query_rich_retry', query: 'print value=1' }] },
		});
		document.body.innerHTML = '';
		const container = document.createElement('div');
		container.id = 'queries-container';
		const query = document.createElement('div') as HTMLElement & { serialize: () => unknown };
		query.id = 'query_rich_retry';
		query.serialize = () => ({ id: 'query_rich_retry', type: 'query', query: 'print value=2' });
		container.appendChild(query);
		document.body.appendChild(container);
		pState.documentKind = 'kqlx';
		pState.compatibilityMode = false;
		vi.mocked(postMessageToHost).mockClear();

		schedulePersist('first', true);
		schedulePersist('retry', true);

		const messages = vi.mocked(postMessageToHost).mock.calls.map(call => call[0] as any);
		expect(messages).toHaveLength(2);
		expect(messages.map(message => message.editRevision)).toEqual([1, 1]);
		expect(messages[0].snapshotId).toMatch(/^document-snapshot-/);
		expect(messages[1].snapshotId).not.toBe(messages[0].snapshotId);

		acknowledgePersistDocument(messages[1].snapshotId, messages[1].editRevision);
		schedulePersist('after-ack', true);
		expect(postMessageToHost).toHaveBeenCalledTimes(2);
	});

	it('persists a change to a __proto__ series color', () => {
		document.body.innerHTML = '';
		const container = document.createElement('div');
		container.id = 'queries-container';
		let color = '#111111';
		const chart = document.createElement('div') as HTMLElement & { serialize: () => unknown };
		chart.id = 'chart_hostile_series';
		chart.serialize = () => ({
			id: 'chart_hostile_series', type: 'chart',
			yAxisSettings: JSON.parse(`{"seriesColors":{"__proto__":"${color}"}}`),
		});
		container.appendChild(chart);
		document.body.appendChild(container);
		pState.documentKind = 'kqlx';
		pState.compatibilityMode = false;
		adoptCurrentStateAsCleanForTest();
		vi.mocked(postMessageToHost).mockClear();

		color = '#222222';
		schedulePersist('hostile-series-color', true);

		expect(postMessageToHost).toHaveBeenCalledTimes(1);
		const message = vi.mocked(postMessageToHost).mock.calls[0][0] as any;
		expect(Object.prototype.hasOwnProperty.call(message.state.sections[0].yAxisSettings.seriesColors, '__proto__')).toBe(true);
		expect(message.state.sections[0].yAxisSettings.seriesColors['__proto__']).toBe('#222222');
	});

	it('does not mark compatibility state clean from a mismatched acknowledgement', () => {
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'kql', compatibilityMode: false,
			documentUri: 'file:///tmp/mismatched.kql',
			state: { sections: [{ type: 'query', id: 'query_ack', query: 'print 1' }] },
		});
		document.body.innerHTML = '';
		const container = document.createElement('div');
		container.id = 'queries-container';
		const query = document.createElement('div') as HTMLElement & { serialize: () => unknown };
		query.id = 'query_ack';
		query.serialize = () => ({ id: 'query_ack', type: 'query', query: 'print 2' });
		container.appendChild(query);
		document.body.appendChild(container);
		pState.documentKind = 'kql';
		pState.compatibilityMode = false;
		vi.mocked(postMessageToHost).mockClear();

		schedulePersist('first', true);
		const first = vi.mocked(postMessageToHost).mock.calls[0][0] as any;
		acknowledgePersistDocument(first.snapshotId, first.editRevision + 1);
		schedulePersist('retry', true);

		expect(postMessageToHost).toHaveBeenCalledTimes(2);
	});

	it('ignores an unknown snapshot acknowledgement and accepts a later exact retry acknowledgement', () => {
		const harness = createRevisionedQueryHarness('file:///tmp/unknown-ack.kql', 'print value=1');
		harness.setQuery('print value=2');

		schedulePersist('first', true);
		const first = vi.mocked(postMessageToHost).mock.calls[0][0] as any;
		acknowledgePersistDocument('unknown-snapshot', first.editRevision);
		schedulePersist('retry', true);

		const retry = vi.mocked(postMessageToHost).mock.calls[1][0] as any;
		expect(retry.editRevision).toBe(first.editRevision);
		acknowledgePersistDocument(retry.snapshotId, retry.editRevision);
		schedulePersist('after-ack', true);
		expect(postMessageToHost).toHaveBeenCalledTimes(2);
	});

	it('does not let an older acknowledgement replace a newer acknowledged snapshot', () => {
		const harness = createRevisionedQueryHarness('file:///tmp/out-of-order-ack.kql', 'print value=0');
		harness.setQuery('print value=1');
		schedulePersist('first', true);
		harness.setQuery('print value=2');
		schedulePersist('second', true);
		const [first, second] = vi.mocked(postMessageToHost).mock.calls.map(call => call[0] as any);

		acknowledgePersistDocument(second.snapshotId, second.editRevision);
		acknowledgePersistDocument(first.snapshotId, first.editRevision);
		schedulePersist('after-acks', true);

		expect([first.editRevision, second.editRevision]).toEqual([1, 2]);
		expect(postMessageToHost).toHaveBeenCalledTimes(2);
	});

	it('tracks a return to acknowledged content as a newer snapshot while another state is pending', () => {
		const harness = createRevisionedQueryHarness('file:///tmp/revert-ack.kql', 'print value=0');
		harness.setQuery('print value=1');
		schedulePersist('changed', true);
		harness.setQuery('print value=0');
		schedulePersist('reverted', true);
		const [changed, reverted] = vi.mocked(postMessageToHost).mock.calls.map(call => call[0] as any);

		acknowledgePersistDocument(changed.snapshotId, changed.editRevision);
		acknowledgePersistDocument(reverted.snapshotId, reverted.editRevision);
		schedulePersist('after-revert-ack', true);

		expect([changed.editRevision, reverted.editRevision]).toEqual([1, 2]);
		expect(postMessageToHost).toHaveBeenCalledTimes(2);
	});

	it('fails closed when an acknowledgement arrives for a pending snapshot evicted after 32 retries', () => {
		const harness = createRevisionedQueryHarness('file:///tmp/evicted-ack.kql', 'print value=0');
		harness.setQuery('print value=1');
		for (let index = 0; index < 33; index++) schedulePersist(`retry-${index}`, true);
		const messages = vi.mocked(postMessageToHost).mock.calls.map(call => call[0] as any);
		expect(new Set(messages.map(message => message.editRevision))).toEqual(new Set([1]));

		acknowledgePersistDocument(messages[0].snapshotId, messages[0].editRevision);
		schedulePersist('after-evicted-ack', true);
		expect(postMessageToHost).toHaveBeenCalledTimes(34);

		const latest = vi.mocked(postMessageToHost).mock.calls.at(-1)![0] as any;
		acknowledgePersistDocument(latest.snapshotId, latest.editRevision);
		schedulePersist('after-current-ack', true);
		expect(postMessageToHost).toHaveBeenCalledTimes(34);
	});

	it('answers a host final-snapshot request with correlated revisioned state', () => {
		pState.documentKind = 'sql';
		pState.compatibilityMode = false;
		const container = document.createElement('div');
		container.id = 'queries-container';
		const sql = document.createElement('div') as HTMLElement & { serialize: () => unknown };
		sql.id = 'sql_flush';
		sql.serialize = () => ({ id: 'sql_flush', type: 'sql', query: 'select 42' });
		container.appendChild(sql);
		document.body.appendChild(container);

		vi.mocked(postMessageToHost).mockClear();
		flushCompatibilityPersist('flush-request-1', 'save');

		expect(postMessageToHost).toHaveBeenCalledTimes(1);
		expect(vi.mocked(postMessageToHost).mock.calls[0][0]).toMatchObject({
			type: 'persistDocument',
			flushRequestId: 'flush-request-1', editRevision: 1,
			state: { sections: [{ id: 'sql_flush', type: 'sql', query: 'select 42' }] },
		});
		expect((vi.mocked(postMessageToHost).mock.calls[0][0] as any).snapshotId).toMatch(/^compat-snapshot-/);
	});

	it('answers a rich-document save request with the current correlated state', () => {
		pState.documentKind = 'sqlx';
		const container = document.createElement('div');
		container.id = 'queries-container';
		const sql = document.createElement('div') as HTMLElement & { serialize: () => unknown };
		sql.id = 'sql_rich_flush';
		sql.serialize = () => ({ id: 'sql_rich_flush', type: 'sql', query: 'select latest' });
		container.appendChild(sql);
		document.body.appendChild(container);

		vi.mocked(postMessageToHost).mockClear();
		flushCompatibilityPersist('rich-flush-1', 'save');

		expect(vi.mocked(postMessageToHost).mock.calls[0][0]).toMatchObject({
			type: 'persistDocument',
			flushRequestId: 'rich-flush-1',
			state: { sections: [{ id: 'sql_rich_flush', type: 'sql', query: 'select latest' }] },
		});
	});

	it('answers a final snapshot request explicitly while restore is in progress', () => {
		pState.restoreInProgress = true;
		vi.mocked(postMessageToHost).mockClear();
		try {
			flushCompatibilityPersist('restore-flush-1', 'save');
			expect(vi.mocked(postMessageToHost).mock.calls[0][0]).toMatchObject({
				type: 'persistDocument', flushRequestId: 'restore-flush-1',
				flushUnavailableReason: 'restore-in-progress',
			});
		} finally {
			pState.restoreInProgress = false;
		}
	});

	it('answers a compatibility final request before the initial projection is ready', () => {
		pState.compatibilityPersistenceViewSessionId = 'compatibility-session-1';
		pState.documentKind = '';
		vi.mocked(postMessageToHost).mockClear();

		flushCompatibilityPersist('startup-flush-1', 'save');

		expect(vi.mocked(postMessageToHost).mock.calls[0][0]).toEqual({
			type: 'persistDocument', state: { sections: [] }, sourceGeneration: 0,
			flushRequestId: 'startup-flush-1', flushUnavailableReason: 'document-not-ready',
		});
	});

	it('sends a compatibility upgrade with the exact persisted revision', () => {
		pState.documentKind = 'sql';
		pState.compatibilityMode = true;
		pState.compatibilitySingleKind = 'sql';
		pState.upgradeRequestType = 'requestUpgradeToSqlx';
		pState.allowedSectionKinds = ['sql', 'markdown'];
		const container = document.createElement('div');
		container.id = 'queries-container';
		const sql = document.createElement('div') as HTMLElement & { serialize: () => unknown };
		sql.id = 'sql_upgrade';
		sql.serialize = () => ({ id: 'sql_upgrade', type: 'sql', query: 'select latest' });
		container.appendChild(sql);
		document.body.appendChild(container);

		vi.mocked(postMessageToHost).mockClear();
		__kustoRequestAddSection('markdown');

		const messages = vi.mocked(postMessageToHost).mock.calls.map(call => call[0] as any);
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ type: 'persistDocument', reason: 'upgrade', editRevision: 1 });
		expect(messages[1]).toMatchObject({
			type: 'requestUpgradeToSqlx', addKind: 'markdown', editRevision: 1,
		});
		expect(messages[1].state).toEqual(messages[0].state);
	});

	it.each([
		['plain KQL compatibility', 'kql', 'requestUpgradeToKqlx', ['query', 'markdown'], 'markdown'],
		['plain SQL compatibility', 'sql', 'requestUpgradeToSqlx', ['sql', 'markdown'], 'markdown'],
	] as const)('rejects automation creation before mutating %s', (_label, documentKind, upgradeRequestType, allowedKinds, sectionKind) => {
		pState.documentKind = documentKind;
		pState.upgradeRequestType = upgradeRequestType;
		pState.allowedSectionKinds = [...allowedKinds];
		pState.compatibilityMode = true;

		const creation = createSectionWithCapabilities(sectionKind);

		expect(creation).toMatchObject({ ok: false, error: expect.stringContaining('requires upgrading') });
		expect(testState.addQueryBox).not.toHaveBeenCalled();
		expect(testState.addMarkdownBox).not.toHaveBeenCalled();
		expect(testState.addSqlBox).not.toHaveBeenCalled();
	});

	it('rejects a forbidden query creation in MDX before mutation', () => {
		pState.documentKind = 'mdx';
		pState.allowedSectionKinds = ['markdown', 'url', 'transformation'];

		expect(createSectionWithCapabilities('query')).toMatchObject({
			ok: false, error: expect.stringContaining('not supported in .mdx'),
		});
		expect(testState.addQueryBox).not.toHaveBeenCalled();
	});

	it('routes legacy creation globals through MDX capability admission', () => {
		pState.documentKind = 'mdx';
		pState.allowedSectionKinds = ['markdown', 'url', 'transformation'];

		expect(window.addQueryBox({ id: 'forged_query' })).toBe('');
		expect(window.addMarkdownBox({ id: 'allowed_markdown' })).toBe('allowed_markdown');
		expect(testState.addQueryBox).not.toHaveBeenCalled();
		expect(testState.addMarkdownBox).toHaveBeenCalledWith({ id: 'allowed_markdown' });
	});

	it('blocks legacy creation globals for an explicit empty capability set', () => {
		pState.documentKind = 'mdx';
		pState.allowedSectionKinds = [];

		expect(window.addMarkdownBox({ id: 'forged_markdown' })).toBe('');
		expect(window.addUrlBox({ id: 'forged_url' })).toBe('');
		expect(testState.addMarkdownBox).not.toHaveBeenCalled();
		expect(testState.urlBoxes).toEqual([]);
	});

	it('adopts a preload Markdown Add exactly once before default finalization', () => {
		const emptyPendingAdds = createEmptyQueryEditorPendingAdds();
		const runtimeWindow = window as unknown as Record<string, unknown>;
		const preloadBridgeNames = [
			'__kustoRequestAddSection', 'addQueryBox', 'addSqlBox', 'addMarkdownBox',
			'addChartBox', 'addTransformationBox', 'addPythonBox', 'addUrlBox',
			'addHtmlBox', 'addCopilotQueryBox',
		] as const;
		const runtimeBridges = Object.fromEntries(preloadBridgeNames.map(name => [name, runtimeWindow[name]]));
		const preloadSource = readFileSync(resolve(process.cwd(), 'src/webview/queryEditor.js'), 'utf8');
		const preloadStart = preloadSource.indexOf('\t// If the user clicks one of the add buttons');
		const preloadEnd = preloadSource.indexOf('\n\tconst getBaseUrl = () => {', preloadStart);
		expect(preloadStart).toBeGreaterThanOrEqual(0);
		expect(preloadEnd).toBeGreaterThan(preloadStart);

		try {
			for (const name of preloadBridgeNames) delete runtimeWindow[name];
			delete runtimeWindow.__kustoQueryEditorPendingAdds;
			pState.queryEditorPendingAdds = { ...emptyPendingAdds };

			new Function(preloadSource.slice(preloadStart, preloadEnd))();
			const preloadRequestAddSection = runtimeWindow.__kustoRequestAddSection;
			(window as unknown as { __kustoRequestAddSection: (kind: string) => void })
				.__kustoRequestAddSection('markdown');
			expect(runtimeWindow.__kustoQueryEditorPendingAdds).toEqual({
				...emptyPendingAdds, markdown: 1,
			});

			installRuntimeAddSectionBridges();
			expect(runtimeWindow.__kustoRequestAddSection).not.toBe(preloadRequestAddSection);
			installRuntimeAddSectionBridges();
			expect(pState.queryEditorPendingAdds).toEqual({
				...emptyPendingAdds, markdown: 1,
			});

			const state = { sections: [] };
			expect(handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true,
				documentKind: 'kqlx', documentUri: 'file:///tmp/preload-add-handoff.kqlx',
				allowedSectionKinds: ['query', 'markdown'], defaultSectionKind: 'query', state,
			})).toBe(true);

			finalizeDocumentDefaultsAfterAcknowledgement(state);
			finalizeDocumentDefaultsAfterAcknowledgement(state);

			expect(testState.markdownBoxes).toHaveLength(1);
			expect(testState.queryBoxes).toHaveLength(0);
			expect(pState.queryEditorPendingAdds).toEqual(emptyPendingAdds);
			expect(runtimeWindow.__kustoQueryEditorPendingAdds).toEqual(emptyPendingAdds);
		} finally {
			Object.assign(runtimeWindow, runtimeBridges);
			delete runtimeWindow.__kustoQueryEditorPendingAdds;
		}
	});

	it('hides controls and inserts no default for an explicit empty capability set', () => {
		const controls = document.createElement('div');
		controls.className = 'add-controls';
		const options = document.createElement('div');
		options.className = 'add-controls-options';
		const markdownButton = document.createElement('button');
		markdownButton.className = 'add-control-btn';
		markdownButton.setAttribute('data-add-kind', 'markdown');
		options.appendChild(markdownButton);
		controls.appendChild(options);
		document.body.appendChild(controls);

		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'mdx', documentUri: 'file:///tmp/read-only-empty.mdx',
			allowedSectionKinds: [], defaultSectionKind: 'markdown', state: { sections: [] },
		});
		__kustoApplyDocumentCapabilities();

		expect(controls.style.display).toBe('none');
		expect(markdownButton.style.display).toBe('none');
		expect(testState.addMarkdownBox).not.toHaveBeenCalled();
		expect(testState.addQueryBox).not.toHaveBeenCalled();
		expect(testState.addSqlBox).not.toHaveBeenCalled();
	});

	it('restores and serializes SQLX comparisons as SQL sections', () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		document.body.appendChild(container);
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'sqlx', documentUri: 'file:///tmp/sql-comparison.sqlx',
			allowedSectionKinds: ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'],
			defaultSectionKind: 'sql',
			state: { sections: [
				{ id: 'sql_source', type: 'sql', query: 'SELECT 1' },
				{ id: 'sql_comparison', type: 'sql', query: 'SELECT 2', comparisonSourceBoxId: 'sql_source' },
			] },
		});

		expect(getKqlxState().sections).toEqual([
			{ id: 'sql_source', type: 'sql', query: 'SELECT 1', expanded: true },
			{
				id: 'sql_comparison', type: 'sql', query: 'SELECT 2', expanded: true,
				comparisonSourceBoxId: 'sql_source',
			},
		]);
	});

	it('restores SQL-kind comparison rows with exact derived source lineage', () => {
		vi.useFakeTimers();
		try {
			const connection = {
				id: 'sql-lineage', name: 'Lineage', dialect: 'mssql', serverUrl: 'lineage.example',
				database: 'Db', authType: 'sql-login', username: 'User',
			};
			testState.sqlConnections.push(connection);
			const sourceArtifact = {
				artifactId: 'result:sql_source:1', sourceBoxId: 'sql_source', revision: 1, createdAt: 1,
				producer: {
					engine: 'sql', boxId: 'sql_source', executionId: 'source-run', query: 'SELECT 1',
					connectionId: connection.id, database: 'Db', producer: 'manual',
				},
				policy: {
					exposeToActiveContent: true, sendToModel: true,
					shareToClipboard: true, exportToCsv: true,
				},
				lineage: [],
			};
			testState.getCurrentResultArtifact.mockImplementation((boxId: string) =>
				boxId === 'sql_source' ? sourceArtifact : null);
			const comparisonArtifact = {
				version: 1, artifactId: 'result:sql_comparison:1', sourceBoxId: 'sql_comparison',
				revision: 1, createdAt: 2,
				producer: {
					engine: 'sql', boxId: 'sql_comparison', executionId: 'comparison-run',
					query: 'SELECT 2', connectionId: connection.id, database: 'Db', producer: 'comparison',
				},
				lineage: [{ sourceArtifactId: sourceArtifact.artifactId, role: 'comparison-source' }],
				policy: {
					exposeToActiveContent: true, sendToModel: true,
					shareToClipboard: true, exportToCsv: true,
					sourcePolicies: [{
						sourceArtifactId: sourceArtifact.artifactId,
						exposeToActiveContent: true, sendToModel: true,
						shareToClipboard: true, exportToCsv: true,
					}],
				},
			};
			const comparisonResult = JSON.stringify({ columns: [{ name: 'Value' }], rows: [[2]], metadata: {} });

			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true,
				documentKind: 'sqlx', documentUri: 'file:///tmp/sql-lineage.sqlx',
				allowedSectionKinds: ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'],
				state: { sections: [
					{
						id: 'sql_source', type: 'sql', query: 'SELECT 1', serverUrl: connection.serverUrl,
						connectionIdHint: connection.id, targetSignature: sqlConnectionTargetSignature(connection), database: 'Db',
					},
					{
						id: 'sql_comparison', type: 'sql', query: 'SELECT 2', comparisonSourceBoxId: 'sql_source',
						serverUrl: connection.serverUrl, connectionIdHint: connection.id,
						targetSignature: sqlConnectionTargetSignature(connection), database: 'Db',
						resultJson: comparisonResult, resultArtifact: comparisonArtifact,
					},
				] },
			});
			flushDeferredRestoreTimers();

			const comparisonCall = vi.mocked(displayResultForBox).mock.calls
				.find(call => call[1] === 'sql_comparison');
			expect(comparisonCall?.[2]?.artifactPublication).toMatchObject({
				lineage: [{ sourceArtifactId: sourceArtifact.artifactId, role: 'comparison-source' }],
				policy: { sourcePolicies: [expect.objectContaining({ sourceArtifactId: sourceArtifact.artifactId })] },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects SQL-kind comparison rows without an exact derived lineage descriptor', () => {
		vi.useFakeTimers();
		try {
			const connection = {
				id: 'sql-lineage-missing', name: 'Lineage', dialect: 'mssql', serverUrl: 'lineage-missing.example',
				database: 'Db', authType: 'sql-login', username: 'User',
			};
			testState.sqlConnections.push(connection);
			testState.getCurrentResultArtifact.mockImplementation((boxId: string) => boxId === 'sql_source'
				? {
					artifactId: 'result:sql_source:1', sourceBoxId: 'sql_source', revision: 1,
					createdAt: 1, producer: { engine: 'sql', boxId: 'sql_source' },
					policy: { exportToCsv: true }, lineage: [],
				}
				: null);

			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true,
				documentKind: 'sqlx', documentUri: 'file:///tmp/sql-lineage-missing.sqlx',
				allowedSectionKinds: ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'],
				state: { sections: [
					{ id: 'sql_source', type: 'sql', query: 'SELECT 1', serverUrl: connection.serverUrl, connectionIdHint: connection.id, targetSignature: sqlConnectionTargetSignature(connection), database: 'Db' },
					{ id: 'sql_comparison', type: 'sql', query: 'SELECT 2', comparisonSourceBoxId: 'sql_source', serverUrl: connection.serverUrl, connectionIdHint: connection.id, targetSignature: sqlConnectionTargetSignature(connection), database: 'Db', resultJson: JSON.stringify({ columns: [{ name: 'Value' }], rows: [[2]], metadata: {} }) },
				] },
			});
			flushDeferredRestoreTimers();

			expect(displayResultForBox).not.toHaveBeenCalledWith(
				expect.anything(), 'sql_comparison', expect.anything(),
			);
			expect(pState.queryResultJsonByBoxId.sql_comparison).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not persist load-time query defaults immediately after restoring persisted results', () => {
		vi.useFakeTimers();
		try {
			const resultJson = JSON.stringify({
				columns: [{ name: 'RowId', type: 'long' }],
				rows: [[1]],
				metadata: { executionTime: '00:00:00.321' },
			});
			handleDocumentDataMessage({
				type: 'documentData',
				ok: true,
				forceReload: true,
				documentUri: 'file:///tmp/persisted-results.kqlx',
				state: {
					sections: [{
						id: 'query_persisted_results',
						type: 'query',
						name: 'Persisted Result Fixture',
						query: 'datatable(RowId:long)[1]',
						expanded: true,
						resultsVisible: true,
						resultsHeightPx: 360,
						resultJson,
					}],
				},
			});

			const queryEl = document.getElementById('query_persisted_results') as HTMLElement & { serialize: () => unknown };
			expect(queryEl).toBeTruthy();
			queryEl.serialize = () => ({
				id: 'query_persisted_results',
				type: 'query',
				query: 'datatable(RowId:long)[1]',
				resultJson,
			});

			vi.mocked(postMessageToHost).mockClear();
			schedulePersist('restore-defaults', true);
			expect(postMessageToHost).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('adopts automatic owner proof enrichment without hiding authored target changes', () => {
		vi.useFakeTimers();
		try {
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true,
				documentUri: 'file:///tmp/owner-enrichment.kqlx',
				state: { sections: [{
					id: 'query_owner_enrichment', type: 'query', query: 'print Value=1',
					clusterUrl: 'https://owner.kusto.windows.net', database: 'Db',
				}] },
			});
			const query = document.getElementById('query_owner_enrichment') as HTMLElement & { serialize: () => unknown };
			query.serialize = () => ({
				id: 'query_owner_enrichment', type: 'query', query: 'print Value=1',
				clusterUrl: 'https://owner.kusto.windows.net', connectionIdHint: 'connection-1', database: 'Db',
			});
			vi.mocked(postMessageToHost).mockClear();

			schedulePersist();
			vi.advanceTimersByTime(500);
			expect(postMessageToHost).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('persists explicit owner selection instead of adopting it as automatic enrichment', () => {
		vi.useFakeTimers();
		try {
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true,
				documentUri: 'file:///tmp/explicit-owner-selection.kqlx',
				state: { sections: [{
					id: 'query_explicit_owner', type: 'query', query: 'print Value=1',
					clusterUrl: 'https://owner.kusto.windows.net', database: 'Db',
				}] },
			});
			const query = document.getElementById('query_explicit_owner') as HTMLElement & { serialize: () => unknown };
			query.serialize = () => ({
				id: 'query_explicit_owner', type: 'query', query: 'print Value=1',
				clusterUrl: 'https://owner.kusto.windows.net', connectionIdHint: 'connection-1', database: 'Db',
			});
			const container = document.createElement('div');
			container.id = 'queries-container';
			container.appendChild(query);
			document.body.appendChild(container);
			vi.mocked(postMessageToHost).mockClear();

			schedulePersist('kusto-target-selection', true);

			expect(postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
				type: 'persistDocument', reason: 'kusto-target-selection',
				state: expect.objectContaining({
					sections: [expect.objectContaining({ connectionIdHint: 'connection-1' })],
				}),
			}));
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		['KQLX', 'kqlx', 'file:///tmp/missing-owner-edit.kqlx'],
		['KQL sidecar', 'kql', 'file:///tmp/missing-owner-edit.kql'],
	] as const)('persists an authored edit after retiring a missing-owner restored result in %s', (_label, documentKind, documentUri) => {
		vi.useFakeTimers();
		try {
			const resultJson = JSON.stringify({ columns: ['Value'], rows: [['private']], metadata: {} });
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true,
				documentKind, compatibilityMode: false, documentUri,
				state: { sections: [
					{
						id: 'query_missing_owner_edit', type: 'query', query: 'print Value=1',
						clusterUrl: 'https://missing-owner.kusto.windows.net', database: 'Db',
						connectionIdHint: 'missing-owner', resultJson,
						kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
					},
					{ id: 'query_authored_peer', type: 'query', query: 'print Before=1' },
				] },
			});
			applyKustoLeaveNoTracePolicy([], false);
			flushDeferredRestoreTimers();
			expect(getDeferredRestoredResultJobCountForTest()).toBe(1);
			const container = document.createElement('div');
			container.id = 'queries-container';
			container.appendChild(document.getElementById('query_missing_owner_edit')!);
			container.appendChild(document.getElementById('query_authored_peer')!);
			document.body.appendChild(container);

			let authoredQuery = 'print Before=1';
			testState.queryEditors.query_authored_peer = { getValue: () => authoredQuery };
			adoptCurrentStateAsCleanForTest();
			authoredQuery = 'print After=2';
			vi.mocked(postMessageToHost).mockClear();

			schedulePersist('query-edit', true);

			const persisted = vi.mocked(postMessageToHost).mock.calls
				.map(([message]) => message as any)
				.filter(message => message.type === 'persistDocument')
				.at(-1);
			expect(persisted?.state.sections.find((section: any) => section.id === 'query_authored_peer'))
				.toMatchObject({ query: 'print After=2' });
			expect(persisted?.state.sections.find((section: any) => section.id === 'query_missing_owner_edit')?.resultJson)
				.toBeUndefined();
			expect(getDeferredRestoredResultJobCountForTest()).toBe(0);

			testState.kustoConnections.push(ownedKustoConnection({
				id: 'missing-owner', clusterUrl: 'https://missing-owner.kusto.windows.net',
			}));
			resolvePendingKustoResultRestores();
			flushDeferredRestoreTimers();
			expect(displayResultForBox).not.toHaveBeenCalledWith(
				expect.objectContaining({ rows: [['private']] }),
				'query_missing_owner_edit',
				expect.anything(),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		['KQLX', 'kqlx', 'file:///tmp/deferred-legacy-edit.kqlx'],
		['KQL sidecar', 'kql', 'file:///tmp/deferred-legacy-edit.kql'],
	] as const)('preserves a deferred legacy cache when an unrelated section is edited in %s', (_label, documentKind, documentUri) => {
		vi.useFakeTimers();
		try {
			const clusterUrl = 'https://deferred-legacy.kusto.windows.net';
			const resultJson = JSON.stringify({
				columns: [{ name: 'Value', type: 'long' }], rows: [[42]],
				metadata: { cluster: 'deferred-legacy', database: 'Db' },
			});
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true,
				documentKind, compatibilityMode: false, documentUri,
				state: { sections: [
					{
						id: 'query_deferred_legacy', type: 'query', query: 'print Value=42',
						clusterUrl, connectionIdHint: 'deferred-owner', database: 'Db', resultJson,
					},
					{ id: 'query_deferred_peer', type: 'query', query: 'print Before=1' },
				] },
			});
			expect(getDeferredRestoredResultJobCountForTest()).toBe(0);
			const container = document.createElement('div');
			container.id = 'queries-container';
			const legacyElement = document.getElementById('query_deferred_legacy') as HTMLElement & { serialize: () => unknown };
			legacyElement.serialize = () => ({
				id: 'query_deferred_legacy', type: 'query', query: 'print Value=42',
				clusterUrl, connectionIdHint: 'deferred-owner', database: 'Db',
			});
			const peerElement = document.getElementById('query_deferred_peer') as HTMLElement & { serialize: () => unknown };
			let peerQuery = 'print Before=1';
			peerElement.serialize = () => ({ id: 'query_deferred_peer', type: 'query', query: peerQuery });
			container.append(legacyElement, peerElement);
			document.body.appendChild(container);
			adoptCurrentStateAsCleanForTest();
			peerQuery = 'print After=2';
			vi.mocked(postMessageToHost).mockClear();

			schedulePersist('query-edit', true);

			const persisted = vi.mocked(postMessageToHost).mock.calls
				.map(([message]) => message as any)
				.filter(message => message.type === 'persistDocument')
				.at(-1);
			expect(persisted?.state.sections.find((section: any) => section.id === 'query_deferred_peer'))
				.toMatchObject({ query: 'print After=2' });
			const legacy = persisted?.state.sections.find((section: any) => section.id === 'query_deferred_legacy');
			expect(legacy?.resultJson).toBe(resultJson);
			expect(legacy).not.toHaveProperty('kustoAccountPartition');
			expect(legacy).not.toHaveProperty('kustoLeaveNoTraceRevision');
			expect(displayResultForBox).not.toHaveBeenCalledWith(
				expect.objectContaining({ rows: [[42]] }),
				'query_deferred_legacy',
				expect.anything(),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		['KQLX', 'kqlx', 'file:///tmp/deferred-authority-edit.kqlx'],
		['KQL sidecar', 'kql', 'file:///tmp/deferred-authority-edit.kql'],
	] as const)('preserves a deferred cache through automatic Kusto owner enrichment in %s', (_label, documentKind, documentUri) => {
		vi.useFakeTimers();
		try {
			const clusterUrl = 'https://deferred-authority.kusto.windows.net';
			const resultJson = JSON.stringify({
				columns: [{ name: 'Value', type: 'long' }], rows: [[42]],
				metadata: { cluster: 'deferred-authority', database: 'Db' },
			});
			testState.kustoConnections.push(ownedKustoConnection({
				id: 'tenant-owner', clusterUrl, authorityId: 'organizations',
			}));
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true,
				documentKind, compatibilityMode: false, documentUri,
				state: { sections: [
					{
						id: 'query_deferred_authority', type: 'query', query: 'print Value=42',
						clusterUrl, database: 'Db', resultJson,
					},
					{ id: 'query_authority_peer', type: 'query', query: 'print Before=1' },
				] },
			});
			const container = document.createElement('div');
			container.id = 'queries-container';
			const legacyElement = document.getElementById('query_deferred_authority') as HTMLElement & { serialize: () => unknown };
			legacyElement.serialize = () => ({
				id: 'query_deferred_authority', type: 'query', query: 'print Value=42',
				clusterUrl, authorityId: 'organizations', connectionIdHint: 'tenant-owner', database: 'Db',
			});
			const peerElement = document.getElementById('query_authority_peer') as HTMLElement & { serialize: () => unknown };
			let peerQuery = 'print Before=1';
			peerElement.serialize = () => ({ id: 'query_authority_peer', type: 'query', query: peerQuery });
			container.append(legacyElement, peerElement);
			document.body.appendChild(container);
			adoptCurrentStateAsCleanForTest();
			peerQuery = 'print After=2';
			vi.mocked(postMessageToHost).mockClear();

			schedulePersist('query-edit', true);

			const persisted = vi.mocked(postMessageToHost).mock.calls
				.map(([message]) => message as any)
				.filter(message => message.type === 'persistDocument')
				.at(-1);
			const legacy = persisted?.state.sections.find((section: any) => section.id === 'query_deferred_authority');
			expect(legacy?.resultJson).toBe(resultJson);
			expect(legacy).not.toHaveProperty('kustoAccountPartition');
			expect(legacy).not.toHaveProperty('kustoLeaveNoTraceRevision');
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		['KQLX', 'kqlx', 'file:///tmp/ready-before-idle.kqlx'],
		['KQL sidecar', 'kql', 'file:///tmp/ready-before-idle.kql'],
	] as const)('preserves an owner-ready restored result when another section changes before idle rendering in %s', (_label, documentKind, documentUri) => {
		vi.useFakeTimers();
		try {
			const clusterUrl = 'https://ready-owner.kusto.windows.net';
			const resultJson = JSON.stringify({ columns: ['Value'], rows: [['ready']], metadata: {} });
			testState.kustoConnections.push(ownedKustoConnection({ id: 'ready-owner', clusterUrl }));
			const container = document.createElement('div');
			container.id = 'queries-container';
			document.body.appendChild(container);
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true,
				documentKind, compatibilityMode: false, documentUri,
				state: { sections: [
					{
						id: 'query_ready_before_idle', type: 'query', query: 'print Value=1',
						clusterUrl, database: 'Db', connectionIdHint: 'ready-owner', resultJson,
						...kustoResultOwner,
					},
					{ id: 'query_ready_peer', type: 'query', query: 'print Before=1' },
				] },
			});
			applyKustoLeaveNoTracePolicy([], false);
			(window as any).__testQueryResultJsonByBoxId = pState.queryResultJsonByBoxId;
			expect(getDeferredRestoredResultJobCountForTest()).toBe(1);
			let peerQuery = 'print Before=1';
			testState.queryEditors.query_ready_peer = { getValue: () => peerQuery };
			peerQuery = 'print After=2';
			vi.mocked(postMessageToHost).mockClear();

			schedulePersist('query-edit', true);

			expect(pState.queryResultJsonByBoxId.query_ready_before_idle).toBe(resultJson);
			expect(displayResultForBox).toHaveBeenCalledWith(
				expect.objectContaining({ rows: [['ready']] }),
				'query_ready_before_idle',
				expect.anything(),
			);
			const persisted = vi.mocked(postMessageToHost).mock.calls
				.map(([message]) => message as any)
				.filter(message => message.type === 'persistDocument')
				.at(-1);
			expect(persisted?.state.sections.find((section: any) => section.id === 'query_ready_before_idle')?.resultJson)
				.toBe(resultJson);
			expect(persisted?.state.sections.find((section: any) => section.id === 'query_ready_peer'))
				.toMatchObject({ query: 'print After=2' });
			expect(getDeferredRestoredResultJobCountForTest()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('preserves a governed SQL sidecar result when persistence wins before idle rendering', () => {
		vi.useFakeTimers();
		try {
			const connection = {
				id: 'sql-sidecar-ready', name: 'Sidecar', dialect: 'mssql', serverUrl: 'sidecar-ready.example',
				database: 'Db', authType: 'sql-login', username: 'SidecarUser',
			};
			testState.sqlConnections.push(connection);
			const query = 'SELECT 1 AS Value';
			const resultJson = JSON.stringify({ columns: [{ name: 'Value' }], rows: [[1]], metadata: {} });
			const resultArtifact = {
				version: 1, artifactId: 'result:sql_sidecar_ready:1', sourceBoxId: 'sql_sidecar_ready',
				revision: 1, createdAt: 1,
				producer: {
					engine: 'sql', boxId: 'sql_sidecar_ready', executionId: 'sidecar-execution',
					query, connectionId: connection.id, database: 'Db',
				},
				policy: { exposeToActiveContent: true, shareToClipboard: true, exportToCsv: true },
			};
			const container = document.createElement('div');
			container.id = 'queries-container';
			document.body.appendChild(container);
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true,
				documentKind: 'sql', compatibilityMode: false, documentUri: 'file:///tmp/ready-before-idle.sql',
				state: { sections: [{
					id: 'sql_sidecar_ready', type: 'sql', query, serverUrl: connection.serverUrl,
					connectionIdHint: connection.id, targetSignature: sqlConnectionTargetSignature(connection),
					database: 'Db', resultJson, resultArtifact,
				}] },
			});
			const section = testState.sqlElements.sql_sidecar_ready;
			section.serialize = () => ({
				id: 'sql_sidecar_ready', type: 'sql', query, serverUrl: connection.serverUrl,
				connectionIdHint: connection.id, targetSignature: sqlConnectionTargetSignature(connection),
				database: 'Db',
				...(pState.queryResultJsonByBoxId.sql_sidecar_ready
					? { resultJson: pState.queryResultJsonByBoxId.sql_sidecar_ready } : {}),
				...(pState.resultArtifactByBoxId.sql_sidecar_ready
					? { resultArtifact: pState.resultArtifactByBoxId.sql_sidecar_ready } : {}),
			});
			expect(getDeferredRestoredResultJobCountForTest()).toBe(1);
			expect(displayResultForBox).not.toHaveBeenCalled();
			vi.mocked(postMessageToHost).mockClear();

			schedulePersist('sidecar-edit', true);

			const persisted = vi.mocked(postMessageToHost).mock.calls
				.map(([message]) => message as any)
				.filter(message => message.type === 'persistDocument')
				.at(-1);
			expect(persisted?.state.sections[0]).toMatchObject({ resultJson, resultArtifact });
			expect(displayResultForBox).toHaveBeenCalledWith(
				expect.objectContaining({ rows: [[1]] }),
				'sql_sidecar_ready',
				expect.objectContaining({
					artifactPublication: expect.objectContaining({
						policy: expect.objectContaining({ shareToClipboard: true, exportToCsv: true }),
					}),
				}),
			);
			expect(getDeferredRestoredResultJobCountForTest()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not flush restored non-session files on beforeunload', () => {
		pState.isSessionFile = false;
		const resultJson = JSON.stringify({
			columns: [{ name: 'RowId', type: 'long' }],
			rows: [[1]],
			metadata: { executionTime: '00:00:00.321' },
		});
		handleDocumentDataMessage({
			type: 'documentData',
			ok: true,
			forceReload: true,
			documentUri: 'file:///tmp/flush-clean.kqlx',
			state: {
				sections: [{
					id: 'query_flush_clean',
					type: 'query',
					query: 'datatable(RowId:long)[1]',
					resultJson,
				}],
			},
		});
		vi.mocked(postMessageToHost).mockClear();
		window.dispatchEvent(new Event('beforeunload'));
		expect(postMessageToHost).not.toHaveBeenCalled();
	});

	it('clears the initial document loading state after restore', () => {
		document.body.dataset.kustoDocumentLoading = 'true';
		const loader = document.createElement('div');
		loader.id = 'documentLoading';
		loader.innerHTML = '<span class="document-loading-text">Opening notebook...</span>';
		const container = document.createElement('div');
		container.id = 'queries-container';
		container.setAttribute('aria-busy', 'true');
		document.body.append(loader, container);

		handleDocumentDataMessage({
			type: 'documentData',
			ok: true,
			forceReload: true,
			documentUri: 'file:///tmp/loading.kqlx',
			state: { sections: [{ type: 'query', id: 'query_loading', query: 'print 1' }] },
		});

		expect(document.body.dataset.kustoDocumentLoading).toBeUndefined();
		expect(loader.getAttribute('aria-hidden')).toBe('true');
		expect(container.hasAttribute('aria-busy')).toBe(false);
	});

	it('does not let stale deferred restored results render after a forced reload', () => {
		vi.useFakeTimers();
		try {
			testState.kustoConnections.push(ownedKustoConnection({ id: 'reload-default', clusterUrl: 'https://reload.kusto.windows.net' }));
			const oldResultJson = JSON.stringify({ columns: [{ name: 'Old', type: 'string' }], rows: [['old']], metadata: {} });
			const newResultJson = JSON.stringify({ columns: [{ name: 'New', type: 'string' }], rows: [['new']], metadata: {} });

			handleDocumentDataMessage({
				type: 'documentData',
				ok: true,
				forceReload: true,
				documentUri: 'file:///tmp/reload.kqlx',
				state: { sections: [{ type: 'query', id: 'query_reload', query: 'old', clusterUrl: 'https://reload.kusto.windows.net', database: 'Db', resultJson: oldResultJson, ...kustoResultOwner }] },
			});
			const firstPolicyRequestId = getPendingKustoLeaveNoTracePolicyRequestIdForTest();
			handleDocumentDataMessage({
				type: 'documentData',
				ok: true,
				forceReload: true,
				documentUri: 'file:///tmp/reload.kqlx',
				state: { sections: [{ type: 'query', id: 'query_reload', query: 'new', clusterUrl: 'https://reload.kusto.windows.net', database: 'Db', resultJson: newResultJson, ...kustoResultOwner }] },
			});
			const secondPolicyRequestId = getPendingKustoLeaveNoTracePolicyRequestIdForTest();
			expect(secondPolicyRequestId).not.toBe(firstPolicyRequestId);

			applyKustoLeaveNoTracePolicyRaw(['https://stale.kusto.windows.net'], true, firstPolicyRequestId);
			applyKustoLeaveNoTracePolicyRaw(['https://uncorrelated.kusto.windows.net'], true);
			flushDeferredRestoreTimers();
			expect(displayResultForBox).not.toHaveBeenCalled();

			applyKustoLeaveNoTracePolicyRaw([], false, secondPolicyRequestId);

			flushDeferredRestoreTimers();

			expect(displayResultForBox).toHaveBeenCalledTimes(1);
			expect(displayResultForBox).toHaveBeenCalledWith(
				{ ...JSON.parse(newResultJson), metadata: { executionTime: '' } },
				'query_reload',
				expect.objectContaining({
					label: 'Results', showExecutionTime: true,
					artifactPublication: expect.objectContaining({
						policy: { accountPartition: 'partition-a', leaveNoTraceRevision: 0 },
					}),
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('waits for Kusto policy readiness and discards a protected restored result', () => {
		vi.useFakeTimers();
		try {
			markKustoLeaveNoTracePolicyPending();
			const resultJson = JSON.stringify({ columns: ['Secret'], rows: [['RESTORED_SECRET']], metadata: {} });
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/protected-restore.kqlx',
				state: { sections: [{
					type: 'query', id: 'query_protected_restore', query: 'print secret=1',
					clusterUrl: 'https://secret.kusto.windows.net', connectionIdHint: 'secret-connection', resultJson,
				}] },
			});

			flushDeferredRestoreTimers();
			expect(displayResultForBox).not.toHaveBeenCalled();
			expect(pState.queryResultJsonByBoxId.query_protected_restore).toBeUndefined();
			expect((getKqlxState() as any).sections.find((section: any) => section.id === 'query_protected_restore')?.resultJson)
				.toBeUndefined();

			applyKustoLeaveNoTracePolicy(['https://secret.kusto.windows.net'], false);
			flushDeferredRestoreTimers();
			expect(displayResultForBox).not.toHaveBeenCalled();
			expect(pState.queryResultJsonByBoxId.query_protected_restore).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('publishes a result-free document when the matching fresh policy is protected', () => {
		applyKustoLeaveNoTracePolicy(['https://secret.kusto.windows.net'], false);
		vi.mocked(postMessageToHost).mockClear();
		const resultJson = JSON.stringify({ columns: ['Secret'], rows: [['POLICY_FIRST_SECRET']], metadata: {} });

		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/policy-first.kqlx',
			state: { sections: [{
				type: 'query', id: 'query_policy_first', query: 'print secret=1',
				clusterUrl: 'https://secret.kusto.windows.net', resultJson, ...kustoResultOwner,
			}] },
		});
		applyKustoLeaveNoTracePolicy(['https://secret.kusto.windows.net'], false);

		const purge = vi.mocked(postMessageToHost).mock.calls
			.map(([message]) => message as any)
			.find(message => message.type === 'persistDocument' && message.reason === 'kusto-leave-no-trace-policy');
		expect(purge).toBeTruthy();
		expect(purge.state.sections.find((section: any) => section.id === 'query_policy_first')?.resultJson).toBeUndefined();
		expect(pState.queryResultJsonByBoxId.query_policy_first).toBeUndefined();
	});

	it('does not persist a protected-result purge before commit or after rollback', () => {
		const resultJson = JSON.stringify({ columns: ['Secret'], rows: [['REJECTED_SECRET']], metadata: {} });
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/rejected-policy.kqlx',
			state: { sections: [{
				type: 'query', id: 'query_rejected_policy', query: 'print secret=1',
				clusterUrl: 'https://secret.kusto.windows.net', resultJson, ...kustoResultOwner,
			}] },
		});
		pState.queryResultJsonByBoxId.query_rejected_policy = resultJson;
		pState.kustoResultOwnerByBoxId.query_rejected_policy = {
			accountPartition: 'partition-a', leaveNoTraceRevision: 0,
		};
		const serializedBefore = JSON.stringify(getKqlxState());
		const ownerBefore = { ...pState.kustoResultOwnerByBoxId.query_rejected_policy };
		vi.mocked(postMessageToHost).mockClear();
		vi.mocked(clearResultsState).mockClear();
		const application = beginKustoLeaveNoTracePolicyApplication();

		applyKustoLeaveNoTracePolicy(['https://secret.kusto.windows.net'], false);

		expect(clearResultsState).not.toHaveBeenCalled();
		expect(pState.queryResultJsonByBoxId.query_rejected_policy).toBe(resultJson);
		expect(pState.kustoResultOwnerByBoxId.query_rejected_policy).toEqual(ownerBefore);
		expect(JSON.stringify(getKqlxState())).toBe(serializedBefore);
		expect(vi.mocked(postMessageToHost).mock.calls.some(
			([message]) => (message as any).type === 'persistDocument',
		)).toBe(false);
		application.rollback();
		expect(clearResultsState).not.toHaveBeenCalled();
		expect(pState.queryResultJsonByBoxId.query_rejected_policy).toBe(resultJson);
		expect(pState.kustoResultOwnerByBoxId.query_rejected_policy).toEqual(ownerBefore);
		expect(JSON.stringify(getKqlxState())).toBe(serializedBefore);
		expect(vi.mocked(postMessageToHost).mock.calls.some(
			([message]) => (message as any).type === 'persistDocument',
		)).toBe(false);
	});

	it('emits protected-result revocation and persistence only at commit', () => {
		const resultJson = JSON.stringify({ columns: ['Secret'], rows: [['COMMITTED_SECRET']], metadata: {} });
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/committed-policy.kqlx',
			state: { sections: [{
				type: 'query', id: 'query_committed_policy', query: 'print secret=1',
				clusterUrl: 'https://secret.kusto.windows.net',
			}] },
		});
		pState.queryResultJsonByBoxId.query_committed_policy = resultJson;
		pState.kustoResultOwnerByBoxId.query_committed_policy = {
			accountPartition: 'partition-a', leaveNoTraceRevision: 0,
		};
		const revoked = vi.fn();
		window.addEventListener(RESULT_ARTIFACT_CONSUMERS_REVOKED_EVENT, revoked);
		vi.mocked(clearResultsState).mockImplementationOnce(boxId => {
			window.dispatchEvent(new CustomEvent(RESULT_ARTIFACT_CONSUMERS_REVOKED_EVENT, {
				detail: { sourceBoxId: boxId, consumerIds: ['active-consumer'] },
			}));
		});
		vi.mocked(postMessageToHost).mockClear();
		const application = beginKustoLeaveNoTracePolicyApplication();

		try {
			applyKustoLeaveNoTracePolicy(['https://secret.kusto.windows.net'], false);
			expect(clearResultsState).not.toHaveBeenCalled();
			expect(revoked).not.toHaveBeenCalled();
			expect(postMessageToHost).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'persistDocument' }));

			application.commit();

			expect(clearResultsState).toHaveBeenCalledWith('query_committed_policy');
			expect(revoked).toHaveBeenCalledOnce();
			expect(pState.queryResultJsonByBoxId.query_committed_policy).toBeUndefined();
			expect(pState.kustoResultOwnerByBoxId.query_committed_policy).toBeUndefined();
			expect(postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
				type: 'persistDocument', reason: 'kusto-leave-no-trace-policy',
			}));
		} finally {
			window.removeEventListener(RESULT_ARTIFACT_CONSUMERS_REVOKED_EVENT, revoked);
		}
	});

	it('restores Kusto result ownership and stored-result signatures exactly', () => {
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/owner-rollback.kqlx',
			state: { sections: [{
				type: 'query', id: 'query_owner_rollback', query: 'print value=1',
				clusterUrl: 'https://public.kusto.windows.net',
			}] },
		});
		pState.queryResultJsonByBoxId.query_owner_rollback = JSON.stringify({
			columns: ['Value'], rows: [[1]], metadata: {},
		});
		pState.kustoResultOwnerByBoxId.query_owner_rollback = {
			accountPartition: 'partition-a', leaveNoTraceRevision: 0,
		};
		const serializedBefore = JSON.stringify(getKqlxState());
		const resultJsonBefore = pState.queryResultJsonByBoxId.query_owner_rollback;
		const ownerBefore = { ...pState.kustoResultOwnerByBoxId.query_owner_rollback };
		adoptCurrentStateAsCleanForTest();
		const snapshot = captureKustoLeaveNoTracePolicyRuntime();

		__kustoClearStoredQueryResult('query_owner_rollback');
		restoreKustoLeaveNoTracePolicyRuntime(snapshot);

		expect(pState.queryResultJsonByBoxId.query_owner_rollback).toBe(resultJsonBefore);
		expect(pState.kustoResultOwnerByBoxId.query_owner_rollback).toEqual(ownerBefore);
		expect(JSON.stringify(getKqlxState())).toBe(serializedBefore);
		vi.mocked(postMessageToHost).mockClear();
		schedulePersist('owner-rollback-check', true);
		expect(postMessageToHost).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'persistDocument' }));
	});

	it('still purges a protected restore after a benign no-op persist schedule', () => {
		markKustoLeaveNoTracePolicyPending();
		const resultJson = JSON.stringify({ columns: ['Secret'], rows: [['NOOP_SECRET']], metadata: {} });
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/noop-before-policy.kqlx',
			state: { sections: [{
				type: 'query', id: 'query_noop_before_policy', query: 'print secret=1',
				clusterUrl: 'https://secret.kusto.windows.net', resultJson, ...kustoResultOwner,
			}] },
		});
		const container = document.createElement('div');
		container.id = 'queries-container';
		container.appendChild(document.getElementById('query_noop_before_policy')!);
		document.body.appendChild(container);
		adoptCurrentStateAsCleanForTest();
		vi.mocked(postMessageToHost).mockClear();

		schedulePersist('benign-noop', true);
		expect(postMessageToHost).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'persistDocument' }));
		applyKustoLeaveNoTracePolicy(['https://secret.kusto.windows.net'], false);

		const purge = vi.mocked(postMessageToHost).mock.calls
			.map(([message]) => message as any)
			.find(message => message.type === 'persistDocument' && message.reason === 'kusto-leave-no-trace-policy');
		expect(purge).toBeTruthy();
		expect(purge.state.sections.find((section: any) => section.id === 'query_noop_before_policy')?.resultJson).toBeUndefined();
	});

	it('preserves admitted public rows while durably purging protected rows', () => {
		vi.useFakeTimers();
		try {
			testState.kustoConnections.push(
				ownedKustoConnection({ id: 'secret-default', clusterUrl: 'https://secret.kusto.windows.net' }),
				ownedKustoConnection({ id: 'public-default', clusterUrl: 'https://public.kusto.windows.net' }),
			);
			markKustoLeaveNoTracePolicyPending();
			const protectedResult = JSON.stringify({ columns: ['Kind'], rows: [['PROTECTED']], metadata: {} });
			const publicResult = JSON.stringify({ columns: ['Kind'], rows: [['PUBLIC']], metadata: {} });
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/mixed-policy.kqlx',
				state: { sections: [
					{ type: 'query', id: 'query_protected_mixed', query: 'print kind="protected"', clusterUrl: 'https://secret.kusto.windows.net', database: 'Db', resultJson: protectedResult, ...kustoResultOwner },
					{ type: 'query', id: 'query_public_mixed', query: 'print kind="public"', clusterUrl: 'https://public.kusto.windows.net', database: 'Db', resultJson: publicResult, ...kustoResultOwner },
				] },
			});
			(window as any).__testQueryResultJsonByBoxId = pState.queryResultJsonByBoxId;
			const container = document.createElement('div');
			container.id = 'queries-container';
			for (const id of ['query_protected_mixed', 'query_public_mixed']) container.appendChild(document.getElementById(id)!);
			document.body.appendChild(container);
			vi.mocked(postMessageToHost).mockClear();

			applyKustoLeaveNoTracePolicy(['https://secret.kusto.windows.net'], false);
			flushDeferredRestoreTimers();
			expect(pState.queryResultJsonByBoxId.query_public_mixed).toBe(publicResult);

			const purge = vi.mocked(postMessageToHost).mock.calls
				.map(([message]) => message as any)
				.find(message => message.type === 'persistDocument' && message.reason === 'kusto-leave-no-trace-policy');
			expect(purge).toBeTruthy();
			expect(purge.state.sections.find((section: any) => section.id === 'query_protected_mixed')?.resultJson).toBeUndefined();
			expect(purge.state.sections.find((section: any) => section.id === 'query_public_mixed')?.resultJson).toBe(publicResult);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not restore stale rows after an edit and save before policy readiness', () => {
		vi.useFakeTimers();
		try {
			markKustoLeaveNoTracePolicyPending();
			const resultJson = JSON.stringify({ columns: ['Secret'], rows: [['PRE_EDIT_SECRET']], metadata: {} });
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/edit-before-policy.kqlx',
				state: { sections: [{
					type: 'query', id: 'query_edit_before_policy', query: 'print before=1',
					clusterUrl: 'https://public.kusto.windows.net', resultJson,
				}] },
			});
			const container = document.createElement('div');
			container.id = 'queries-container';
			container.appendChild(document.getElementById('query_edit_before_policy')!);
			document.body.appendChild(container);
			testState.queryEditors.query_edit_before_policy = { getValue: () => 'print after=2' };
			vi.mocked(postMessageToHost).mockClear();
			const editedState = getKqlxState() as any;
			expect(pState.restoreInProgress).toBe(false);
			expect(editedState.sections.find((section: any) => section.id === 'query_edit_before_policy'))
				.toMatchObject({ query: 'print after=2' });
			expect(editedState.sections.find((section: any) => section.id === 'query_edit_before_policy')?.resultJson)
				.toBeUndefined();

			schedulePersist('user-edit', true);
			const saved = vi.mocked(postMessageToHost).mock.calls
				.map(([message]) => message as any)
				.find(message => message.type === 'persistDocument');
			expect(saved).toBeTruthy();
			expect(saved.state.sections.find((section: any) => section.id === 'query_edit_before_policy')?.resultJson).toBeUndefined();

			applyKustoLeaveNoTracePolicy([], false);
			flushDeferredRestoreTimers();
			expect(displayResultForBox).not.toHaveBeenCalledWith(
				expect.objectContaining({ rows: [['PRE_EDIT_SECRET']] }),
				'query_edit_before_policy',
				expect.anything(),
			);
			expect(pState.queryResultJsonByBoxId.query_edit_before_policy).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not install public rows when edit and save wins before the idle restore callback', () => {
		vi.useFakeTimers();
		try {
			markKustoLeaveNoTracePolicyPending();
			const resultJson = JSON.stringify({ columns: ['Secret'], rows: [['IDLE_RACE_SECRET']], metadata: {} });
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/public-idle-race.kqlx',
				state: { sections: [{
					type: 'query', id: 'query_public_idle_race', query: 'print before=1',
					clusterUrl: 'https://public.kusto.windows.net', resultJson,
				}] },
			});
			const container = document.createElement('div');
			container.id = 'queries-container';
			container.appendChild(document.getElementById('query_public_idle_race')!);
			document.body.appendChild(container);
			applyKustoLeaveNoTracePolicy([], false);
			expect(pState.queryResultJsonByBoxId.query_public_idle_race).toBeUndefined();

			testState.queryEditors.query_public_idle_race = { getValue: () => 'print after=2' };
			schedulePersist('user-edit', true);
			flushDeferredRestoreTimers();

			expect(pState.queryResultJsonByBoxId.query_public_idle_race).toBeUndefined();
			expect(displayResultForBox).not.toHaveBeenCalledWith(
				expect.objectContaining({ rows: [['IDLE_RACE_SECRET']] }),
				'query_public_idle_race',
				expect.anything(),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not install or persist public rows when the query is cleared before idle restore', () => {
		vi.useFakeTimers();
		try {
			markKustoLeaveNoTracePolicyPending();
			const resultJson = JSON.stringify({ columns: ['Secret'], rows: [['EMPTY_QUERY_SECRET']], metadata: {} });
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/empty-before-idle.kqlx',
				state: { sections: [{
					type: 'query', id: 'query_empty_before_idle', query: 'print before=1',
					clusterUrl: 'https://public.kusto.windows.net', resultJson,
				}] },
			});
			const container = document.createElement('div');
			container.id = 'queries-container';
			container.appendChild(document.getElementById('query_empty_before_idle')!);
			document.body.appendChild(container);
			applyKustoLeaveNoTracePolicy([], false);
			testState.queryEditors.query_empty_before_idle = { getValue: () => '' };
			delete pState.pendingQueryTextByBoxId.query_empty_before_idle;

			vi.advanceTimersByTime(25);
			vi.advanceTimersByTime(400);

			expect(pState.queryResultJsonByBoxId.query_empty_before_idle).toBeUndefined();
			expect(displayResultForBox).not.toHaveBeenCalledWith(
				expect.objectContaining({ rows: [['EMPTY_QUERY_SECRET']] }),
				'query_empty_before_idle',
				expect.anything(),
			);
			const persists = vi.mocked(postMessageToHost).mock.calls
				.map(([message]) => message as any)
				.filter(message => message.type === 'persistDocument');
			for (const persist of persists) {
				expect(persist.state.sections.find((section: any) => section.id === 'query_empty_before_idle')?.resultJson)
					.toBeUndefined();
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it('releases an unprotected restored result only after Kusto policy readiness', () => {
		vi.useFakeTimers();
		try {
			testState.kustoConnections.push(ownedKustoConnection({ id: 'public-default', clusterUrl: 'https://public.kusto.windows.net' }));
			markKustoLeaveNoTracePolicyPending();
			const resultJson = JSON.stringify({ columns: ['Value'], rows: [['ready']], metadata: {} });
			const resultArtifact = {
				version: 1, artifactId: 'result:query_public_restore:9', sourceBoxId: 'query_public_restore',
				revision: 9, createdAt: 1234,
				producer: {
					engine: 'kusto', boxId: 'query_public_restore', executionId: 'execution-restored',
					query: 'print value=1', connectionId: 'public-default', database: 'Db',
				},
				policy: {
					accountPartition: 'partition-a', leaveNoTraceRevision: 0,
					exposeToActiveContent: true, sendToModel: true, shareToClipboard: true,
				},
			};
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/public-restore.kqlx',
				state: { sections: [{
					type: 'query', id: 'query_public_restore', query: 'print value=1',
					clusterUrl: 'https://public.kusto.windows.net', database: 'Db', resultJson, resultArtifact, ...kustoResultOwner,
				}] },
			});

			flushDeferredRestoreTimers();
			expect(displayResultForBox).not.toHaveBeenCalled();
			expect(pState.queryResultJsonByBoxId.query_public_restore).toBeUndefined();
			applyKustoLeaveNoTracePolicy([], false);
			flushDeferredRestoreTimers();
			expect(pState.queryResultJsonByBoxId.query_public_restore).toBe(resultJson);
			expect(pState.resultArtifactByBoxId.query_public_restore).toEqual(resultArtifact);
			expect(displayResultForBox).toHaveBeenCalledWith(
				{ ...JSON.parse(resultJson), metadata: { executionTime: '' } },
				'query_public_restore',
				expect.objectContaining({
					label: 'Results', showExecutionTime: true,
					artifactPublication: expect.objectContaining({
						persistedIdentity: expect.objectContaining({
							artifactId: resultArtifact.artifactId, revision: 9, sourceBoxId: 'query_public_restore',
						}),
						producer: expect.objectContaining({ executionId: 'execution-restored' }),
					}),
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects restored Kusto comparison rows with forged artifact ancestry', () => {
		vi.useFakeTimers();
		try {
			testState.kustoConnections.push(ownedKustoConnection({
				id: 'public-default', clusterUrl: 'https://public.kusto.windows.net',
			}));
			const sourceArtifact = {
				artifactId: 'result:query_source:3', sourceBoxId: 'query_source', revision: 3, createdAt: 100,
				restored: true, columns: ['Value'], rows: [[1]], metadata: {},
				producer: { engine: 'kusto', boxId: 'query_source', executionId: 'source-execution' },
				policy: {
					accountPartition: 'partition-a', leaveNoTraceRevision: 0,
					exposeToActiveContent: true, sendToModel: true, shareToClipboard: true,
				},
				lineage: [],
			};
			testState.getCurrentResultArtifact.mockImplementation((boxId: unknown) => (
				String(boxId) === 'query_source' ? sourceArtifact : null
			));
			const resultJson = JSON.stringify({ columns: ['Value'], rows: [['forged']], metadata: {} });
			const resultArtifact = {
				version: 1, artifactId: 'result:query_comparison:9', sourceBoxId: 'query_comparison',
				revision: 9, createdAt: 1234,
				producer: { engine: 'kusto', boxId: 'query_comparison', executionId: 'comparison-execution' },
				policy: {
					accountPartition: 'partition-a', leaveNoTraceRevision: 0,
					exposeToActiveContent: true, sendToModel: true, shareToClipboard: true,
					sourcePolicies: [{
						sourceArtifactId: 'result:unrelated:1', accountPartition: 'partition-a',
						exposeToActiveContent: true, sendToModel: true, shareToClipboard: true,
					}],
				},
				lineage: [{ sourceArtifactId: 'result:unrelated:1', role: 'comparison-source' }],
			};

			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/forged-comparison.kqlx',
				state: { sections: [
					{
						type: 'query', id: 'query_source', query: 'print source=1',
						clusterUrl: 'https://public.kusto.windows.net', database: 'Db',
					},
					{
						type: 'query', id: 'query_comparison', query: 'print comparison=1',
						comparisonSourceBoxId: 'query_source',
						clusterUrl: 'https://public.kusto.windows.net', database: 'Db',
						resultJson, resultArtifact, ...kustoResultOwner,
					},
				] },
			});
			applyKustoLeaveNoTracePolicy([], false);
			flushDeferredRestoreTimers();

			expect(displayResultForBox).not.toHaveBeenCalledWith(
				expect.objectContaining({ rows: [['forged']] }),
				'query_comparison',
				expect.anything(),
			);
			expect(pState.queryResultJsonByBoxId.query_comparison).toBeUndefined();
			expect(pState.resultArtifactByBoxId.query_comparison).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not restore account A Kusto rows after the same connection moves to account B', () => {
		vi.useFakeTimers();
		try {
			testState.kustoConnections.push({
				id: 'shared-connection', clusterUrl: 'https://shared.kusto.windows.net', accountPartition: 'partition-b',
			});
			const resultJson = JSON.stringify({ columns: ['Owner'], rows: [['ACCOUNT_A_ROW']], metadata: {} });
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/account-swap.kqlx',
				state: { sections: [{
					type: 'query', id: 'query_account_swap', query: 'print owner="A"',
					clusterUrl: 'https://shared.kusto.windows.net', connectionIdHint: 'shared-connection', database: 'Db',
					resultJson, kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
				}] },
			});
			applyKustoLeaveNoTracePolicy([], false);
			flushDeferredRestoreTimers();

			expect(pState.queryResultJsonByBoxId.query_account_swap).toBeUndefined();
			expect(displayResultForBox).not.toHaveBeenCalledWith(
				expect.objectContaining({ rows: [['ACCOUNT_A_ROW']] }), 'query_account_swap', expect.anything(),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not restore Kusto rows produced before a closed-notebook policy interval', () => {
		vi.useFakeTimers();
		try {
			testState.kustoConnections.push(ownedKustoConnection({
				id: 'interval-connection', clusterUrl: 'https://interval.kusto.windows.net',
			}));
			const resultJson = JSON.stringify({ columns: ['Marker'], rows: [['PRE_INTERVAL_ROW']], metadata: {} });
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/policy-interval.kqlx',
				state: { sections: [{
					type: 'query', id: 'query_policy_interval', query: 'print marker=1',
					clusterUrl: 'https://interval.kusto.windows.net', connectionIdHint: 'interval-connection', database: 'Db',
					resultJson, ...kustoResultOwner,
				}] },
			});
			applyKustoLeaveNoTracePolicy([], false, { interval: 2 });
			flushDeferredRestoreTimers();

			expect(pState.queryResultJsonByBoxId.query_policy_interval).toBeUndefined();
			expect(displayResultForBox).not.toHaveBeenCalledWith(
				expect.objectContaining({ rows: [['PRE_INTERVAL_ROW']] }), 'query_policy_interval', expect.anything(),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps restored Kusto rows private until their exact connection arrives', () => {
		vi.useFakeTimers();
		try {
			const resultJson = JSON.stringify({ columns: ['Value'], rows: [['late-owner']], metadata: {} });
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/late-owner.kqlx',
				state: { sections: [{
					type: 'query', id: 'query_late_owner', query: 'print value=1',
					clusterUrl: 'https://late.kusto.windows.net', connectionIdHint: 'late-connection', database: 'Db', resultJson, ...kustoResultOwner,
				}] },
			});
			applyKustoLeaveNoTracePolicy([], false);
			flushDeferredRestoreTimers();
			expect(displayResultForBox).not.toHaveBeenCalled();

			testState.kustoConnections.push(ownedKustoConnection({ id: 'late-connection', clusterUrl: 'https://late.kusto.windows.net' }));
			const section = document.getElementById('query_late_owner') as any;
			section.getConnectionId = () => 'late-connection';
			resolvePendingKustoResultRestores();
			flushDeferredRestoreTimers();

			expect(pState.queryResultJsonByBoxId.query_late_owner).toBe(resultJson);
			expect(displayResultForBox).toHaveBeenCalledWith(
				{ ...JSON.parse(resultJson), metadata: { executionTime: '' } },
				'query_late_owner',
				expect.objectContaining({
					label: 'Results', showExecutionTime: true,
					artifactPublication: expect.objectContaining({
						policy: { accountPartition: 'partition-a', leaveNoTraceRevision: 0 },
					}),
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		['ownerless', [], { clusterUrl: '', database: '' }],
		['ambiguous', [
			{ id: 'authority-a', clusterUrl: 'https://shared.kusto.windows.net', authorityId: 'common' },
			{ id: 'authority-b', clusterUrl: 'https://shared.kusto.windows.net', authorityId: 'organizations' },
		], { clusterUrl: 'https://shared.kusto.windows.net', database: 'Db' }],
	] as const)('never renders %s restored Kusto rows', (_case, ownerConnections, target) => {
		vi.useFakeTimers();
		try {
			testState.kustoConnections.push(...ownerConnections);
			const resultJson = JSON.stringify({ columns: ['Secret'], rows: [['UNOWNED']], metadata: {} });
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, documentUri: `file:///tmp/${_case}.kqlx`,
				state: { sections: [{ type: 'query', id: `query_${_case}`, query: 'print secret=1', ...target, resultJson }] },
			});
			applyKustoLeaveNoTracePolicy([], false);
			flushDeferredRestoreTimers();

			expect(displayResultForBox).not.toHaveBeenCalled();
			expect(pState.queryResultJsonByBoxId[`query_${_case}`]).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('clears stored and rendered Kusto results when global recovery blocks policy', () => {
		const resultJson = JSON.stringify({ columns: ['Secret'], rows: [['LIVE_SECRET']], metadata: {} });
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/global-recovery.kqlx',
			state: { sections: [{
				type: 'query', id: 'query_global_recovery', query: 'print secret=1',
				clusterUrl: 'https://unknown.kusto.windows.net', resultJson,
			}] },
		});
		vi.mocked(displayResultForBox).mockClear();

		applyKustoLeaveNoTracePolicy([], true);

		expect(pState.queryResultJsonByBoxId.query_global_recovery).toBeUndefined();
		expect((document.getElementById('query_global_recovery') as any).clearResults).toHaveBeenCalled();
	});

	it('purges a Kusto source and comparison whose opaque IDs begin with sql_', () => {
		const clusterUrl = 'https://opaque-id.kusto.windows.net';
		testState.kustoConnections.push({ id: 'sql_kusto_connection', clusterUrl });
		const sourceResult = JSON.stringify({ columns: ['Secret'], rows: [['SOURCE']] });
		const comparisonResult = JSON.stringify({ columns: ['Secret'], rows: [['COMPARISON']] });
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/opaque-id.kqlx',
			state: { sections: [
				{ type: 'query', id: 'sql_kusto_source', clusterUrl, connectionIdHint: 'sql_kusto_connection', database: 'Db', query: 'T', resultJson: sourceResult },
				{ type: 'query', id: 'sql_kusto_comparison', comparisonSourceBoxId: 'sql_kusto_source', clusterUrl, connectionIdHint: 'sql_kusto_connection', database: 'Db', query: 'T | count', resultJson: comparisonResult },
			] },
		});
		applyKustoLeaveNoTracePolicy([clusterUrl], false);

		expect(pState.queryResultJsonByBoxId.sql_kusto_source).toBeUndefined();
		expect(pState.queryResultJsonByBoxId.sql_kusto_comparison).toBeUndefined();
		expect((document.getElementById('sql_kusto_source') as any).clearResults).toHaveBeenCalled();
		expect((document.getElementById('sql_kusto_comparison') as any).clearResults).toHaveBeenCalled();
	});

	it('does not render deferred restored results over a running query', () => {
		vi.useFakeTimers();
		try {
			const resultJson = JSON.stringify({ columns: [{ name: 'Saved', type: 'string' }], rows: [['saved']], metadata: {} });

			handleDocumentDataMessage({
				type: 'documentData',
				ok: true,
				forceReload: true,
				documentUri: 'file:///tmp/live-wins.kqlx',
				state: { sections: [{ type: 'query', id: 'query_live_wins', query: 'saved', resultJson }] },
			});

			testState.queryExecutionTimers.query_live_wins = 1;
			delete pState.queryResultJsonByBoxId.query_live_wins;
			flushDeferredRestoreTimers();

			expect(displayResultForBox).not.toHaveBeenCalled();
			expect(pState.queryResultJsonByBoxId.query_live_wins).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not mark an unacknowledged edit clean when deferred results render', () => {
		vi.useFakeTimers();
		try {
			const resultJson = JSON.stringify({ columns: [{ name: 'Saved', type: 'string' }], rows: [['saved']], metadata: {} });
			handleDocumentDataMessage({
				type: 'documentData', ok: true, forceReload: true, editRevision: 0,
				documentKind: 'kql', compatibilityMode: false,
				documentUri: 'file:///tmp/deferred-ack.kql',
				state: { sections: [{ type: 'query', id: 'query_deferred_ack', query: 'print value=1', resultJson }] },
			});
			const query = document.getElementById('query_deferred_ack') as HTMLElement & { serialize: () => unknown };
			query.serialize = () => ({ id: 'query_deferred_ack', type: 'query', query: 'print value=2', resultJson });
			const container = document.createElement('div');
			container.id = 'queries-container';
			container.appendChild(query);
			document.body.appendChild(container);
			vi.mocked(postMessageToHost).mockClear();

			schedulePersist('edit-before-result-restore', true);
			flushDeferredRestoreTimers();
			schedulePersist('retry-after-result-restore', true);

			const snapshots = vi.mocked(postMessageToHost).mock.calls.map(call => call[0] as any);
			expect(snapshots).toHaveLength(2);
			expect(snapshots.map(snapshot => snapshot.editRevision)).toEqual([1, 1]);
			expect(snapshots[1].snapshotId).not.toBe(snapshots[0].snapshotId);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not stringify unchanged stored result JSON when schedulePersist runs again', () => {
		handleDocumentDataMessage({
			type: 'documentData',
			ok: true,
			forceReload: true,
			documentUri: 'file:///tmp/schedule-large-result.kqlx',
			state: { sections: [] },
		});

		const largeResultJson = JSON.stringify({
			columns: [{ name: 'Payload', type: 'string' }],
			rows: Array.from({ length: 2000 }, (_, index) => [`row_${index}_${'x'.repeat(80)}`]),
			metadata: { executionTime: '00:00:01.000' },
		});
		pState.queryResultJsonByBoxId.query_large = largeResultJson;

		document.body.innerHTML = '';
		const container = document.createElement('div');
		container.id = 'queries-container';
		document.body.appendChild(container);
		const queryEl = document.createElement('div') as unknown as HTMLElement & { serialize: () => unknown };
		queryEl.id = 'query_large';
		queryEl.serialize = () => ({
			id: 'query_large',
			type: 'query',
			name: 'Large Result',
			query: 'range i from 1 to 2000 step 1',
			clusterUrl: 'https://persisted.example.kusto.windows.net',
			database: 'Samples',
			resultJson: pState.queryResultJsonByBoxId.query_large,
		});
		container.appendChild(queryEl);

		vi.mocked(postMessageToHost).mockClear();
		schedulePersist('initial-large-result', true);
		expect(postMessageToHost).toHaveBeenCalledTimes(1);
		const initialPersist = vi.mocked(postMessageToHost).mock.calls[0][0] as any;
		acknowledgePersistDocument(initialPersist.snapshotId, initialPersist.editRevision);

		const stringifySpy = vi.spyOn(JSON, 'stringify');
		stringifySpy.mockClear();
		try {
			schedulePersist('unchanged-large-result', true);
			const fullResultStateStringifyCalls = stringifySpy.mock.calls.filter(([value]) => {
				if (!value || typeof value !== 'object') return false;
				const sections = (value as any).sections;
				return Array.isArray(sections) && sections.some((section: any) => section?.resultJson === largeResultJson);
			});
			expect(fullResultStateStringifyCalls).toHaveLength(0);
		} finally {
			stringifySpy.mockRestore();
		}
		expect(postMessageToHost).toHaveBeenCalledTimes(1);
	});

	it('recreates sections from serialized state on handleDocumentDataMessage', () => {
		handleDocumentDataMessage({
			type: 'documentData',
			ok: true,
			forceReload: true,
			documentUri: 'file:///tmp/a.kqlx',
			state: {
				sections: [
					{ type: 'query', id: 'query_saved_1', query: 'TableA | take 3' },
					{ type: 'markdown', id: 'markdown_saved_1', text: '# Notes' },
				],
			},
		});

		expect(testState.addQueryBox).toHaveBeenCalledTimes(1);
		expect(testState.addMarkdownBox).toHaveBeenCalledTimes(1);

		const restoredQueryId = String(testState.addQueryBox.mock.results[0]?.value || '');
		expect(restoredQueryId).toBeTruthy();
		expect(pState.pendingQueryTextByBoxId[restoredQueryId]).toBe('TableA | take 3');
	});

	it('retains a host-owned URL element across a same-document forced projection', () => {
		const documentUri = 'file:///tmp/url-handoff.kqlx';
		const state = { sections: [{
			id: 'url_handoff', type: 'url', name: 'Stable',
			url: 'https://example.com/data.csv', expanded: true,
		}] };
		const projection = (sourceGeneration: number) => ({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'kqlx', documentUri, sourceGeneration, documentRevision: 0,
			sectionRevisions: { url_handoff: 0 }, markdownSectionRevisions: {}, state,
		});

		expect(handleDocumentDataMessage(projection(1))).toBe(true);
		const element = document.getElementById('url_handoff') as HTMLElement & {
			applyHostDocumentState?: ReturnType<typeof vi.fn>;
			triggerFetch?: ReturnType<typeof vi.fn>;
			runtimeMarker?: string;
		};
		expect(element).toBeTruthy();
		element.runtimeMarker = 'preserved';
		element.applyHostDocumentState = vi.fn();
		element.triggerFetch = vi.fn();
		const addCount = testState.addUrlBox.mock.calls.length;

		expect(handleDocumentDataMessage(projection(2))).toBe(true);

		expect(document.getElementById('url_handoff')).toBe(element);
		expect(element.runtimeMarker).toBe('preserved');
		expect(testState.addUrlBox).toHaveBeenCalledTimes(addCount);
		expect(element.applyHostDocumentState).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'url_handoff', url: 'https://example.com/data.csv' }),
			{ fetchIfMissing: false },
		);
		expect(element.triggerFetch).not.toHaveBeenCalled();
	});

	it('retains a host-owned Chart element across a same-document forced projection', () => {
		const documentUri = 'file:///tmp/chart-handoff.kqlx';
		const state = { sections: [{
			id: 'chart_handoff', type: 'chart', name: 'Stable', mode: 'preview', expanded: true,
			dataSourceId: 'query_source', chartType: 'line', xColumn: 'Day', yColumns: ['Value'],
		}] };
		const projection = (sourceGeneration: number) => ({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'kqlx', documentUri, sourceGeneration, documentRevision: 0,
			sectionRevisions: { chart_handoff: 0 }, markdownSectionRevisions: {}, state,
		});

		expect(handleDocumentDataMessage(projection(1))).toBe(true);
		const element = document.getElementById('chart_handoff') as HTMLElement & {
			applyHostDocumentState?: ReturnType<typeof vi.fn>;
			runtimeMarker?: { identity: string };
		};
		expect(element).toBeTruthy();
		const runtimeMarker = { identity: 'preserved' };
		element.runtimeMarker = runtimeMarker;
		element.applyHostDocumentState = vi.fn();
		const addCount = testState.chartBoxes.length;

		expect(handleDocumentDataMessage(projection(2))).toBe(true);

		expect(document.getElementById('chart_handoff')).toBe(element);
		expect(element.runtimeMarker).toBe(runtimeMarker);
		expect(testState.chartBoxes).toHaveLength(addCount);
		expect(element.applyHostDocumentState).toHaveBeenCalledWith(expect.objectContaining({
			id: 'chart_handoff', dataSourceId: 'query_source', chartType: 'line',
		}));
	});

	it('retains a host-owned Python element across a same-document forced projection', () => {
		const documentUri = 'file:///tmp/python-handoff.kqlx';
		const state = { sections: [{
			id: 'python_handoff', type: 'python', name: 'Stable', code: 'print(1)',
			output: 'one', expanded: true, editorHeightPx: 180,
		}] };
		const projection = (sourceGeneration: number) => ({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'kqlx', documentUri, sourceGeneration, documentRevision: 0,
			sectionRevisions: { python_handoff: 0 }, markdownSectionRevisions: {}, state,
		});

		expect(handleDocumentDataMessage(projection(1))).toBe(true);
		const element = document.getElementById('python_handoff') as HTMLElement & {
			applyHostDocumentState?: ReturnType<typeof vi.fn>;
			runtimeMarker?: string;
		};
		expect(element).toBeTruthy();
		element.runtimeMarker = 'preserved';
		element.applyHostDocumentState = vi.fn();
		const pythonCount = testState.pythonBoxes.length;

		expect(handleDocumentDataMessage(projection(2))).toBe(true);

		expect(document.getElementById('python_handoff')).toBe(element);
		expect(element.runtimeMarker).toBe('preserved');
		expect(testState.pythonBoxes).toHaveLength(pythonCount);
		expect(element.applyHostDocumentState).toHaveBeenCalledWith(expect.objectContaining({
			id: 'python_handoff', code: 'print(1)', output: 'one',
		}));
	});

	it('retains an HTML iframe and unchanged fact source across an equal forced projection', () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		document.body.appendChild(container);
		const documentUri = 'file:///tmp/html-handoff.kqlx';
		const htmlCode = `<script type="application/kw-provenance">${JSON.stringify({
			version: 1,
			model: { fact: { sectionId: 'query_html_handoff', sectionName: 'Fact Events' } },
			bindings: {},
		})}</script><main>Dashboard</main>`;
		const state = { sections: [
			{ id: 'query_html_handoff', type: 'query', query: 'print Value=1' },
			{ id: 'python_html_handoff', type: 'python', code: 'print(1)', expanded: true },
			{
				id: 'html_handoff', type: 'html', name: 'Stable dashboard', code: htmlCode,
				mode: 'preview', expanded: true, dataSourceIds: ['query_html_handoff'],
			},
			{ id: 'url_html_handoff', type: 'url', url: 'https://example.com/data.csv', expanded: false },
		] };
		const projection = (sourceGeneration: number) => ({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'kqlx', documentUri, sourceGeneration, documentRevision: 0,
			sectionRevisions: { html_handoff: 0, python_html_handoff: 0, url_html_handoff: 0 },
			markdownSectionRevisions: {}, state,
		});

		expect(handleDocumentDataMessage(projection(1))).toBe(true);
		const query = document.getElementById('query_html_handoff')!;
		const python = document.getElementById('python_html_handoff')!;
		const url = document.getElementById('url_html_handoff')!;
		const htmlSection = document.getElementById('html_handoff') as HTMLElement & {
			applyHostDocumentState?: ReturnType<typeof vi.fn>;
			runtimeBinding?: { artifactId: string };
		};
		expect(htmlSection).toBeTruthy();
		htmlSection.applyHostDocumentState = vi.fn();
		htmlSection.runtimeBinding = { artifactId: 'fact-artifact-a' };
		const shadow = htmlSection.attachShadow({ mode: 'open' });
		const iframe = document.createElement('iframe');
		iframe.dataset.runtimeSentinel = 'iframe-a';
		shadow.appendChild(iframe);
		const insertBefore = vi.spyOn(container, 'insertBefore');

		expect(handleDocumentDataMessage(projection(2))).toBe(true);

		expect(document.getElementById('query_html_handoff')).toBe(query);
		expect(document.getElementById('python_html_handoff')).toBe(python);
		expect(document.getElementById('html_handoff')).toBe(htmlSection);
		expect(document.getElementById('url_html_handoff')).toBe(url);
		expect(htmlSection.shadowRoot?.querySelector('iframe')).toBe(iframe);
		expect(iframe.dataset.runtimeSentinel).toBe('iframe-a');
		expect(htmlSection.runtimeBinding).toEqual({ artifactId: 'fact-artifact-a' });
		expect(htmlSection.applyHostDocumentState).toHaveBeenCalledWith(expect.objectContaining({
			id: 'html_handoff', code: htmlCode, dataSourceIds: ['query_html_handoff'],
		}));
		expect(insertBefore).not.toHaveBeenCalled();
		expect(Array.from(container.children, element => element.id)).toEqual([
			'query_html_handoff', 'python_html_handoff', 'html_handoff', 'url_html_handoff',
		]);
	});

	it('retains unchanged query and SQL runtime sources for a host-owned Transformation handoff', async () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		document.body.appendChild(container);
		const documentUri = 'file:///tmp/transformation-source-handoff.kqlx';
		const state = { sections: [
			{ id: 'query_source_handoff', type: 'query', query: 'print Key=1, LeftValue="a"' },
			{ id: 'sql_source_handoff', type: 'sql', query: "select 1 as [Key], 'b' as RightValue" },
			{
				id: 'transform_source_handoff', type: 'transformation', expanded: false,
				dataSourceId: 'query_source_handoff', transformationType: 'join',
				joinRightDataSourceId: 'sql_source_handoff', joinKind: 'inner',
				joinKeys: [{ left: 'Key', right: 'Key' }],
			},
		] };
		const projection = (sourceGeneration: number, nextState = state) => ({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'kqlx', documentUri, sourceGeneration, documentRevision: 0,
			sectionRevisions: { transform_source_handoff: 0 }, markdownSectionRevisions: {}, state: nextState,
		});

		expect(handleDocumentDataMessage(projection(1))).toBe(true);
		const query = document.getElementById('query_source_handoff') as HTMLElement & { runtimeArtifactId?: string };
		const sql = document.getElementById('sql_source_handoff') as HTMLElement & { runtimeArtifactId?: string };
		const transformation = document.getElementById('transform_source_handoff') as HTMLElement & {
			inputBindings?: { primary: string; joinRight: string };
			outputLineage?: string[];
		};
		query.runtimeArtifactId = 'query-artifact-a';
		sql.runtimeArtifactId = 'sql-artifact-a';
		transformation.inputBindings = { primary: 'query-artifact-a', joinRight: 'sql-artifact-a' };
		transformation.outputLineage = ['query-artifact-a', 'sql-artifact-a'];
		const sectionFactory = await import('../../src/webview/core/section-factory.js');
		vi.mocked(sectionFactory.removeQueryBox).mockClear();
		vi.mocked(sectionFactory.removeSqlBox).mockClear();
		const queryAddCount = testState.addQueryBox.mock.calls.length;
		const sqlAddCount = testState.addSqlBox.mock.calls.length;

		expect(handleDocumentDataMessage(projection(2))).toBe(true);

		expect(document.getElementById('query_source_handoff')).toBe(query);
		expect(document.getElementById('sql_source_handoff')).toBe(sql);
		expect(document.getElementById('transform_source_handoff')).toBe(transformation);
		expect(query.runtimeArtifactId).toBe('query-artifact-a');
		expect(sql.runtimeArtifactId).toBe('sql-artifact-a');
		expect(transformation.inputBindings).toEqual({
			primary: 'query-artifact-a', joinRight: 'sql-artifact-a',
		});
		expect(transformation.outputLineage).toEqual(['query-artifact-a', 'sql-artifact-a']);
		expect(sectionFactory.removeQueryBox).not.toHaveBeenCalledWith('query_source_handoff');
		expect(sectionFactory.removeSqlBox).not.toHaveBeenCalledWith('sql_source_handoff');
		expect(testState.addQueryBox).toHaveBeenCalledTimes(queryAddCount);
		expect(testState.addSqlBox).toHaveBeenCalledTimes(sqlAddCount);

		const reorderedState = { sections: [state.sections[2], state.sections[1], state.sections[0]] };
		expect(handleDocumentDataMessage(projection(3, reorderedState))).toBe(true);
		expect(document.getElementById('query_source_handoff')).toBe(query);
		expect(document.getElementById('sql_source_handoff')).toBe(sql);
		expect(document.getElementById('transform_source_handoff')).toBe(transformation);
		expect(transformation.inputBindings).toEqual({
			primary: 'query-artifact-a', joinRight: 'sql-artifact-a',
		});
		expect(transformation.outputLineage).toEqual(['query-artifact-a', 'sql-artifact-a']);
		expect(Array.from(container.children, element => element.id)).toEqual([
			'transform_source_handoff', 'sql_source_handoff', 'query_source_handoff',
		]);
		expect(getKqlxState().sections.map((section: any) => section.id)).toEqual([
			'transform_source_handoff', 'sql_source_handoff', 'query_source_handoff',
		]);

		const changedState = { sections: reorderedState.sections.map(section =>
			section.id === 'query_source_handoff'
				? { ...section, query: 'print Key=2, LeftValue="changed"' }
				: section,
		) };
		expect(handleDocumentDataMessage(projection(4, changedState))).toBe(true);
		expect(document.getElementById('query_source_handoff')).not.toBe(query);
		expect(sectionFactory.removeQueryBox).toHaveBeenCalledWith('query_source_handoff');
	});

	it('accepts a Transformation command after an acknowledged full-snapshot reorder', async () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		document.body.appendChild(container);
		const documentUri = 'file:///tmp/transformation-reorder-command.kqlx';
		const before = {
			id: 'transform_reorder_command', type: 'transformation', name: 'Before', expanded: false,
			dataSourceId: 'query_reorder_command', transformationType: 'select',
		} as const;
		expect(handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'kqlx', documentUri, sourceGeneration: 21, editRevision: 0,
			documentRevision: 0, sectionRevisions: { [before.id]: 0 }, markdownSectionRevisions: {},
			state: { sections: [
				{ id: 'query_reorder_command', type: 'query', query: 'print Value=1' },
				{ id: 'future_reorder_command', type: 'future-section', payload: { keep: true } },
				before,
			] },
		})).toBe(true);
		const query = document.getElementById('query_reorder_command')!;
		const transformation = document.getElementById(before.id)!;
		container.insertBefore(transformation, query);
		vi.mocked(postMessageToHost).mockClear();

		schedulePersist('reorder');
		const persist = vi.mocked(postMessageToHost).mock.calls
			.map(call => call[0] as any)
			.find(message => message.type === 'persistDocument');
		expect(persist).toBeTruthy();
		(acknowledgePersistDocument as any)(persist.snapshotId, persist.editRevision, [
			before.id, 'future_reorder_command', 'query_reorder_command',
		]);

		const client = await import('../../src/webview/core/markdown-document-client.js');
		const after = { ...before, name: 'After' };
		expect(client.requestHostOwnedTransformationPatch(after)).toBe(true);
		const command = vi.mocked(postMessageToHost).mock.calls
			.map(call => call[0] as any)
			.find(message => message.type === 'markdownDocumentCommand');
		expect(command).toBeTruthy();
		const handled = client.handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: command.commandId, ok: true,
			sourceGeneration: 21,
			projection: {
				documentRevision: 1,
				sectionRevisions: { [before.id]: 1 }, markdownSectionRevisions: {},
				chartSections: [], markdownSections: [], pythonSections: [],
				transformationSections: [after], urlSections: [],
				orderedSectionIds: [before.id, 'future_reorder_command', 'query_reorder_command'],
			},
		});

		expect(handled).toMatchObject({ handled: true, accepted: true });
		expect(postMessageToHost).not.toHaveBeenCalledWith({ type: 'requestDocument' });
	});

	it('retains a Transformation source after its query edit is acknowledged before host handoff', () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		document.body.appendChild(container);
		const documentUri = 'file:///tmp/transformation-acknowledged-source.kqlx';
		const transformation = {
			id: 'transform_ack_source', type: 'transformation', expanded: false,
			dataSourceId: 'query_ack_source', transformationType: 'select',
		};
		const projection = (sourceGeneration: number, query: string) => ({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'kqlx', documentUri, sourceGeneration, documentRevision: 0,
			sectionRevisions: { transform_ack_source: 0 }, markdownSectionRevisions: {},
			state: { sections: [
				{ id: 'query_ack_source', type: 'query', query },
				transformation,
			] },
		});

		expect(handleDocumentDataMessage(projection(1, 'print Value=1'))).toBe(true);
		const query = document.getElementById('query_ack_source') as HTMLElement & {
			serialize: () => unknown;
			runtimeArtifactId?: string;
		};
		const transformElement = document.getElementById('transform_ack_source') as HTMLElement & {
			inputBinding?: string;
			outputLineage?: string[];
		};
		query.runtimeArtifactId = 'query-artifact-ack';
		transformElement.inputBinding = 'query-artifact-ack';
		transformElement.outputLineage = ['query-artifact-ack'];
		query.serialize = () => ({ id: 'query_ack_source', type: 'query', query: 'print Value=2' });
		vi.mocked(postMessageToHost).mockClear();

		schedulePersist('query-edit', true);
		const persist = vi.mocked(postMessageToHost).mock.calls
			.map(call => call[0] as any)
			.find(message => message.type === 'persistDocument');
		expect(persist).toBeTruthy();
		acknowledgePersistDocument(persist.snapshotId, persist.editRevision, [
			'query_ack_source', 'transform_ack_source',
		]);

		expect(handleDocumentDataMessage(projection(2, 'print Value=2'))).toBe(true);
		expect(document.getElementById('query_ack_source')).toBe(query);
		expect(document.getElementById('transform_ack_source')).toBe(transformElement);
		expect(query.runtimeArtifactId).toBe('query-artifact-ack');
		expect(transformElement.inputBinding).toBe('query-artifact-ack');
		expect(transformElement.outputLineage).toEqual(['query-artifact-ack']);
	});

	it('recreates a linked query when a host-owned Transformation handoff makes it inline', async () => {
		const documentUri = 'file:///tmp/transformation-linked-source-handoff.kqlx';
		const linkedState = { sections: [
			{
				id: 'query_linked_handoff', type: 'query', query: 'print Value=1',
				linkedQueryPath: 'queries/source.kql',
			},
			{
				id: 'transform_linked_handoff', type: 'transformation', expanded: false,
				dataSourceId: 'query_linked_handoff', transformationType: 'select',
			},
		] };
		const inlineState = { sections: linkedState.sections.map(section => {
			if (section.id !== 'query_linked_handoff') return section;
			const { linkedQueryPath: _linkedQueryPath, ...inlineSection } = section;
			return inlineSection;
		}) };
		const projection = (sourceGeneration: number, state: typeof linkedState) => ({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'kqlx', documentUri, sourceGeneration, documentRevision: 0,
			sectionRevisions: { transform_linked_handoff: 0 }, markdownSectionRevisions: {}, state,
		});

		expect(handleDocumentDataMessage(projection(1, linkedState))).toBe(true);
		const linkedQuery = document.getElementById('query_linked_handoff');
		const sectionFactory = await import('../../src/webview/core/section-factory.js');
		vi.mocked(sectionFactory.removeQueryBox).mockClear();

		expect(handleDocumentDataMessage(projection(2, inlineState))).toBe(true);

		expect(document.getElementById('query_linked_handoff')).not.toBe(linkedQuery);
		expect(sectionFactory.removeQueryBox).toHaveBeenCalledWith('query_linked_handoff');
	});

	it('carries pending Kusto result admission across a retained Transformation handoff', () => {
		vi.useFakeTimers();
		try {
			const documentUri = 'file:///tmp/transformation-pending-kusto-handoff.kqlx';
			const resultJson = JSON.stringify({ columns: ['Value'], rows: [['late-kusto']], metadata: {} });
			const querySection = {
				id: 'query_pending_kusto_handoff', type: 'query', query: 'print Value="late-kusto"',
				clusterUrl: 'https://late-handoff.kusto.windows.net', connectionIdHint: 'late-handoff',
				database: 'Db', resultJson, ...kustoResultOwner,
			};
			const state = { sections: [
				querySection,
				{
					id: 'transform_pending_kusto_handoff', type: 'transformation', expanded: false,
					dataSourceId: querySection.id, transformationType: 'select',
				},
			] };
			const projection = (sourceGeneration: number) => ({
				type: 'documentData', ok: true, forceReload: true,
				documentKind: 'kqlx', documentUri, sourceGeneration, documentRevision: 0,
				sectionRevisions: { transform_pending_kusto_handoff: 0 }, markdownSectionRevisions: {}, state,
			});

			expect(handleDocumentDataMessage(projection(1))).toBe(true);
			const query = document.getElementById(querySection.id) as HTMLElement & {
				serialize: () => unknown;
				getConnectionId: () => string;
			};
			query.serialize = () => ({ ...querySection });
			expect(getDeferredRestoredResultJobCountForTest()).toBe(1);

			expect(handleDocumentDataMessage(projection(2))).toBe(true);
			expect(document.getElementById(querySection.id)).toBe(query);
			expect(getDeferredRestoredResultJobCountForTest()).toBe(1);
			vi.mocked(postMessageToHost).mockClear();
			schedulePersist();
			vi.advanceTimersByTime(500);
			expect(postMessageToHost).not.toHaveBeenCalled();

			testState.kustoConnections.push(ownedKustoConnection({
				id: 'late-handoff', clusterUrl: querySection.clusterUrl,
			}));
			query.getConnectionId = () => 'late-handoff';
			applyKustoLeaveNoTracePolicy([], false);
			resolvePendingKustoResultRestores();
			flushDeferredRestoreTimers();

			expect(pState.queryResultJsonByBoxId[querySection.id]).toBe(resultJson);
			expect(displayResultForBox).toHaveBeenCalledWith(
				{ ...JSON.parse(resultJson), metadata: { executionTime: '' } },
				querySection.id,
				expect.objectContaining({
					label: 'Results', showExecutionTime: true,
					artifactPublication: expect.objectContaining({
						policy: { accountPartition: 'partition-a', leaveNoTraceRevision: 0 },
					}),
				}),
			);
			vi.advanceTimersByTime(500);
			expect(postMessageToHost).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('carries pending SQL owner admission across a retained Transformation handoff', () => {
		vi.useFakeTimers();
		try {
			const documentUri = 'file:///tmp/transformation-pending-sql-handoff.kqlx';
			const connection = {
				id: 'sql-late-handoff', name: 'Late', dialect: 'mssql', serverUrl: 'late-handoff.example',
				database: 'Db', authType: 'sql-login', username: 'LateUser',
			};
			const resultJson = JSON.stringify({ columns: [{ name: 'Value' }], rows: [['late-sql']], metadata: {} });
			const sqlSection = {
				id: 'sql_pending_handoff', type: 'sql', query: 'SELECT \'late-sql\' AS Value',
				serverUrl: connection.serverUrl, connectionIdHint: connection.id,
				targetSignature: sqlConnectionTargetSignature(connection), database: connection.database, resultJson,
			};
			const state = { sections: [
				sqlSection,
				{
					id: 'transform_pending_sql_handoff', type: 'transformation', expanded: false,
					dataSourceId: sqlSection.id, transformationType: 'select',
				},
			] };
			const projection = (sourceGeneration: number) => ({
				type: 'documentData', ok: true, forceReload: true,
				documentKind: 'kqlx', documentUri, sourceGeneration, documentRevision: 0,
				sectionRevisions: { transform_pending_sql_handoff: 0 }, markdownSectionRevisions: {}, state,
			});

			expect(handleDocumentDataMessage(projection(1))).toBe(true);
			const sql = document.getElementById(sqlSection.id) as HTMLElement & {
				serialize: () => unknown;
				getConnectionId: () => string;
				getSqlConnectionId: () => string;
			};
			sql.serialize = () => ({ ...sqlSection, expanded: true });

			expect(handleDocumentDataMessage(projection(2))).toBe(true);
			expect(document.getElementById(sqlSection.id)).toBe(sql);

			testState.sqlConnections.push(connection);
			sql.getConnectionId = () => connection.id;
			sql.getSqlConnectionId = () => connection.id;
			resolvePendingSqlResultRestores();
			flushDeferredRestoreTimers();

			expect(pState.queryResultJsonByBoxId[sqlSection.id]).toBe(resultJson);
			expect(displayResultForBox).toHaveBeenCalledWith(
				{ ...JSON.parse(resultJson), metadata: { executionTime: '' } },
				sqlSection.id,
				expect.objectContaining({ label: 'Results', showExecutionTime: true }),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('drops a pending SQL comparison job when only its retained owner survives the handoff', () => {
		vi.useFakeTimers();
		try {
			const documentUri = 'file:///tmp/transformation-pending-comparison-handoff.kqlx';
			const connection = {
				id: 'sql-comparison-owner', name: 'Owner', dialect: 'mssql', serverUrl: 'comparison.example',
				database: 'Db', authType: 'sql-login', username: 'OwnerUser',
			};
			const owner = {
				id: 'sql_comparison_owner', type: 'sql', query: 'SELECT 1 AS Value',
				serverUrl: connection.serverUrl, connectionIdHint: connection.id,
				targetSignature: sqlConnectionTargetSignature(connection), database: connection.database,
			};
			const oldResultJson = JSON.stringify({ columns: [{ name: 'Value' }], rows: [['old']], metadata: {} });
			const newResultJson = JSON.stringify({ columns: [{ name: 'Value' }], rows: [['new']], metadata: {} });
			const state = (resultJson: string) => ({ sections: [
				owner,
				{
					id: 'query_pending_comparison', type: 'query', query: 'SELECT 2 AS Value',
					comparisonSourceBoxId: owner.id, resultJson,
				},
				{
					id: 'transform_comparison_owner', type: 'transformation', expanded: false,
					dataSourceId: owner.id, transformationType: 'select',
				},
			] });
			const projection = (sourceGeneration: number, resultJson: string) => ({
				type: 'documentData', ok: true, forceReload: true,
				documentKind: 'kqlx', documentUri, sourceGeneration, documentRevision: 0,
				sectionRevisions: { transform_comparison_owner: 0 }, markdownSectionRevisions: {},
				state: state(resultJson),
			});

			expect(handleDocumentDataMessage(projection(1, oldResultJson))).toBe(true);
			const sql = document.getElementById(owner.id) as HTMLElement & {
				serialize: () => unknown;
				getConnectionId: () => string;
				getSqlConnectionId: () => string;
			};
			sql.serialize = () => ({ ...owner, expanded: true });

			expect(handleDocumentDataMessage(projection(2, newResultJson))).toBe(true);
			expect(document.getElementById(owner.id)).toBe(sql);

			testState.sqlConnections.push(connection);
			sql.getConnectionId = () => connection.id;
			sql.getSqlConnectionId = () => connection.id;
			resolvePendingSqlResultRestores();

			expect(pState.queryResultJsonByBoxId.query_pending_comparison).toBe(newResultJson);
			expect(getDeferredRestoredResultJobCountForTest()).toBe(1);
			expect(displayResultForBox).not.toHaveBeenCalled();
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it('recreates invalidated query and SQL sources after a failed same-document projection is repaired', () => {
		const documentUri = 'file:///tmp/transformation-failed-handoff.kqlx';
		const stableState = { sections: [
			{ id: 'query_failed_handoff', type: 'query', query: 'print Key=1' },
			{ id: 'sql_failed_handoff', type: 'sql', query: 'SELECT 1 AS [Key]' },
			{
				id: 'transform_failed_handoff', type: 'transformation', expanded: false,
				dataSourceId: 'query_failed_handoff', transformationType: 'join',
				joinRightDataSourceId: 'sql_failed_handoff', joinKind: 'inner',
				joinKeys: [{ left: 'Key', right: 'Key' }],
			},
		] };
		const projection = (sourceGeneration: number, state: any, sectionRevisions: Record<string, number>) => ({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'kqlx', documentUri, sourceGeneration, documentRevision: sourceGeneration - 1,
			sectionRevisions, markdownSectionRevisions: {}, state,
		});

		expect(handleDocumentDataMessage(projection(1, stableState, { transform_failed_handoff: 0 }))).toBe(true);
		const query = document.getElementById('query_failed_handoff');
		const sql = document.getElementById('sql_failed_handoff');
		vi.mocked(addChartBox).mockImplementationOnce(() => { throw new Error('injected handoff failure'); });
		const failedState = { sections: [
			...stableState.sections,
			{ id: 'chart_failed_handoff', type: 'chart', chartType: 'bar', dataSourceId: 'query_failed_handoff' },
		] };

		expect(handleDocumentDataMessage(projection(2, failedState, {
			transform_failed_handoff: 0, chart_failed_handoff: 0,
		}))).toBe(false);
		expect(pState.documentRuntimeActive).toBe(false);

		expect(handleDocumentDataMessage(projection(3, stableState, { transform_failed_handoff: 0 }))).toBe(true);
		expect(document.getElementById('query_failed_handoff')).not.toBe(query);
		expect(document.getElementById('sql_failed_handoff')).not.toBe(sql);
		expect(pState.documentRuntimeActive).toBe(true);
	});

	it('restores legacy copilotQuery content and serializes it canonically as query', () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		document.body.appendChild(container);

		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'kqlx', documentUri: 'file:///tmp/legacy-copilot-query.kqlx',
			allowedSectionKinds: ['query', 'sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'],
			defaultSectionKind: 'query',
			state: { sections: [{ id: 'legacy_query_1', type: 'copilotQuery', query: 'print legacy = 1' }] },
		});

		expect(testState.addQueryBox).toHaveBeenCalledWith(expect.objectContaining({ id: 'legacy_query_1' }));
		expect(pState.pendingQueryTextByBoxId.legacy_query_1).toBe('print legacy = 1');
		expect(getKqlxState().sections).toEqual([
			{ id: 'legacy_query_1', type: 'query', query: 'print legacy = 1' },
		]);
	});

	it('serializes native development notes from the acknowledged host projection in exact order', () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		document.body.appendChild(container);
		const authoritativeEntry = {
			id: 'note_authoritative', created: '2026-08-14T10:00:00.000Z', updated: '2026-08-14T10:01:00.000Z',
			category: 'clarification', content: 'host state', source: 'agent',
		};

		expect(handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'kqlx', documentUri: 'file:///tmp/devnotes-owner.kqlx',
			sourceGeneration: 4, documentRevision: 0,
			sectionRevisions: { markdown_a: 0, devnotes_owner: 0, markdown_b: 0 },
			markdownSectionRevisions: { markdown_a: 0, markdown_b: 0 },
			state: { sections: [
				{ id: 'markdown_a', type: 'markdown', text: 'A' },
				{ id: 'devnotes_owner', type: 'devnotes', entries: [authoritativeEntry] },
				{ id: 'markdown_b', type: 'markdown', text: 'B' },
			] },
		})).toBe(true);
		expect(pState.metadataFreeDevelopmentNoteSections).toEqual([]);
		pState.metadataFreeDevelopmentNoteSections = [{
			id: 'devnotes_owner', type: 'devnotes', entries: [{ ...authoritativeEntry, content: 'stale adapter' }],
		}];

		const state = getKqlxState();
		expect(state.sections.map((section: any) => section.id)).toEqual([
			'markdown_a', 'devnotes_owner', 'markdown_b',
		]);
		expect(state.sections[1]).toEqual({
			id: 'devnotes_owner', type: 'devnotes', entries: [authoritativeEntry],
		});
	});

	it.each([
		['chart-only KQLX', 'kqlx', { type: 'chart', id: 'chart_only' }],
		['transformation-only MDX', 'mdx', { type: 'transformation', id: 'transform_only' }],
		['opaque-only MDX', 'mdx', { type: 'future-section', id: 'future_only', payload: { keep: true } }],
		['devnotes-only MDX', 'mdx', { type: 'devnotes', id: 'devnotes_only', entries: [] }],
	] as const)('does not create a default section for a nonempty %s document', (_label, documentKind, section) => {
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true,
			documentKind, documentUri: `file:///tmp/${section.id}.${documentKind}`,
			allowedSectionKinds: documentKind === 'mdx'
				? ['markdown', 'url', 'transformation']
				: ['query', 'sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'],
			defaultSectionKind: documentKind === 'mdx' ? 'markdown' : 'query',
			state: { sections: [section] },
		});

		expect(testState.addQueryBox).not.toHaveBeenCalled();
		expect(testState.addMarkdownBox).not.toHaveBeenCalled();
		expect(testState.addSqlBox).not.toHaveBeenCalled();
	});

	it('restores compatibility query connection data before connection selectors refresh', () => {
		handleDocumentDataMessage({
			type: 'documentData',
			ok: true,
			forceReload: true,
			compatibilityMode: true,
			compatibilitySingleKind: 'query',
			documentKind: 'kql',
			documentUri: 'file:///tmp/plain.kql',
			state: {
				sections: [
					{
						type: 'query',
						query: 'StormEvents | take 5',
						clusterUrl: 'https://help.kusto.windows.net',
						database: 'Samples',
					},
				],
			},
		});

		expect(testState.addQueryBox).toHaveBeenCalledWith({
			clusterUrl: 'https://help.kusto.windows.net',
			database: 'Samples',
		});
		expect(__kustoSetAutoEnterFavoritesForBox).toHaveBeenCalledWith(
			testState.addQueryBox.mock.results[0]?.value,
			'https://help.kusto.windows.net',
			'Samples'
		);
		expect(updateConnectionSelects).toHaveBeenCalled();

		const restoredQueryId = String(testState.addQueryBox.mock.results[0]?.value || '');
		expect(pState.pendingQueryTextByBoxId[restoredQueryId]).toBe('StormEvents | take 5');
	});

	it('ignores duplicate documentData for same document unless forced', () => {
		handleDocumentDataMessage({
			type: 'documentData',
			ok: true,
			forceReload: true,
			documentUri: 'file:///tmp/once.kqlx',
			state: { sections: [{ type: 'query', id: 'query_saved_1', query: 'A' }] },
		});
		handleDocumentDataMessage({
			type: 'documentData',
			ok: true,
			documentUri: 'file:///tmp/once.kqlx',
			state: { sections: [{ type: 'query', id: 'query_saved_2', query: 'B' }] },
		});

		expect(testState.addQueryBox).toHaveBeenCalledTimes(1);
	});

	it('applies documentData when documentUri changes without forceReload', () => {
		handleDocumentDataMessage({
			type: 'documentData',
			ok: true,
			forceReload: true,
			documentUri: 'file:///tmp/doc-a.kqlx',
			state: { sections: [{ type: 'query', id: 'query_saved_a', query: 'A' }] },
		});
		handleDocumentDataMessage({
			type: 'documentData',
			ok: true,
			documentUri: 'file:///tmp/doc-b.kqlx',
			state: { sections: [{ type: 'query', id: 'query_saved_b', query: 'B' }] },
		});

		expect(testState.addQueryBox).toHaveBeenCalledTimes(2);
	});

	it('seeds a reused preview document with its incoming lower edit revision', () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		document.body.appendChild(container);
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, editRevision: 25,
			documentKind: 'kql', compatibilityMode: false,
			documentUri: 'file:///tmp/high-revision.kql',
			state: { sections: [{ type: 'query', id: 'query_high', query: 'print high=1' }] },
		});
		handleDocumentDataMessage({
			type: 'documentData', ok: true, editRevision: 0,
			documentKind: 'kql', compatibilityMode: false,
			documentUri: 'file:///tmp/reused-preview.kql',
			state: { sections: [{ type: 'query', id: 'query_reused', query: 'print value=1' }] },
		});

		expect(pState.documentEditRevision).toBe(0);
		const queryId = testState.queryBoxes.at(-1)!;
		const query = document.getElementById(queryId) as HTMLElement & { serialize: () => unknown };
		query.serialize = () => ({ id: queryId, type: 'query', query: 'print value=2' });
		container.appendChild(query);
		vi.mocked(postMessageToHost).mockClear();

		schedulePersist('preview-edit', true);

		const persist = vi.mocked(postMessageToHost).mock.calls[0][0] as any;
		expect(persist).toMatchObject({ type: 'persistDocument', editRevision: 1 });
		acknowledgePersistDocument(persist.snapshotId, persist.editRevision);
		schedulePersist('after-ack', true);
		expect(postMessageToHost).toHaveBeenCalledTimes(1);
	});
});
