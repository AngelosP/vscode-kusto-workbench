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
	}> = {};
	const sqlLeaveNoTraceConnectionIds: string[] = [];
	const sqlConnections: Array<{ id: string; serverUrl: string }> = [];
	const postMessageToHost = vi.fn();

	const addQueryBox = vi.fn((options: { id?: string } = {}) => {
		const id = options.id || `query_restored_${addQueryBox.mock.calls.length + 1}`;
		queryBoxes.push(id);
		queryEditors[id] = { getValue: () => '' };
		const el = document.createElement('div') as HTMLElement & { serialize?: () => unknown };
		el.id = id;
		el.serialize = () => ({
			id,
			type: 'query',
			query: queryEditors[id]?.getValue?.() || (window as any).__testPendingQueryTextByBoxId?.[id] || '',
			...(typeof (window as any).__testQueryResultJsonByBoxId?.[id] === 'string' && (window as any).__testQueryResultJsonByBoxId[id]
				? { resultJson: (window as any).__testQueryResultJsonByBoxId[id] }
				: {}),
		});
		document.body.appendChild(el);
		return id;
	});

	const addMarkdownBox = vi.fn(() => {
		const id = `markdown_restored_${addMarkdownBox.mock.calls.length + 1}`;
		markdownBoxes.push(id);
		markdownEditors[id] = { getValue: () => '' };
		return id;
	});

	const addHtmlBox = vi.fn((options: { id?: string } = {}) => {
		const id = options.id || `html_restored_${htmlBoxes.length + 1}`;
		htmlBoxes.push(id);
		const el = document.createElement('div');
		el.id = id;
		document.body.appendChild(el);
		return id;
	});

	const addSqlBox = vi.fn((options: { id?: string } = {}) => {
		const id = options.id || `sql_restored_${sqlBoxes.length + 1}`;
		sqlBoxes.push(id);
		let protectedConnectionIds = new Set<string>();
		const selectedConnectionId = sqlConnections.find(connection => connection.serverUrl === (options as any).serverUrl)?.id || '';
		const el = document.createElement('div') as HTMLElement & {
			setFavoritesMode: ReturnType<typeof vi.fn>;
			setLeaveNoTraceConnectionIds: ReturnType<typeof vi.fn>;
			canPersistResults: () => boolean;
			getConnectionId: () => string;
		};
		el.id = id;
		el.setFavoritesMode = vi.fn();
		el.setLeaveNoTraceConnectionIds = vi.fn((ids: string[]) => { protectedConnectionIds = new Set(ids); });
		el.getConnectionId = () => selectedConnectionId;
		el.canPersistResults = () => {
			const currentConnectionId = el.getConnectionId();
			return !currentConnectionId || !protectedConnectionIds.has(currentConnectionId);
		};
		sqlElements[id] = el;
		const resultsWrapper = document.createElement('div');
		resultsWrapper.id = `${id}_sql_results_wrapper`;
		document.body.append(el, resultsWrapper);
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
		addQueryBox,
		addMarkdownBox,
		addHtmlBox,
		addSqlBox,
		postMessageToHost,
	};
});

vi.mock('../../src/webview/shared/persistence-utils.js', () => ({
	normalizeClusterUrl: vi.fn((url: unknown) => String(url || '').trim().toLowerCase()),
	isLeaveNoTraceCluster: vi.fn(() => false),
	byteLengthUtf8: vi.fn((v: unknown) => String(v ?? '').length),
	trySerializeQueryResult: vi.fn(() => ({ json: null })),
}));

vi.mock('../../src/webview/shared/webview-messages.js', () => ({
	postMessageToHost: testState.postMessageToHost,
}));

vi.mock('../../src/webview/shared/persistence-state.js', () => ({
	pState: {
		compatibilityMode: false,
		compatibilitySingleKind: 'query',
		allowedSectionKinds: ['query', 'chart', 'transformation', 'python', 'url', 'markdown'],
		defaultSectionKind: 'query',
		upgradeRequestType: 'requestUpgradeToKqlx',
		documentKind: 'kqlx',
		documentEditRevision: 0,
		documentUri: '',
		compatibilityTooltip: '',
		htmlPowerBiCompatibilityCheckEnabled: true,
		restoreInProgress: false,
		queryEditorPendingAdds: { query: 0, chart: 0, transformation: 0, markdown: 0, python: 0, url: 0 },
		pendingQueryTextByBoxId: {} as Record<string, string>,
		pendingMarkdownTextByBoxId: {} as Record<string, string>,
		pendingPythonCodeByBoxId: {} as Record<string, string>,
		pendingHtmlCodeByBoxId: {} as Record<string, string>,
		pendingSqlQueryByBoxId: {} as Record<string, string>,
		pendingWrapperHeightPxByBoxId: {} as Record<string, number>,
		manualQueryEditorHeightPxByBoxId: {} as Record<string, number>,
		resultsVisibleByBoxId: {} as Record<string, boolean>,
		queryResultJsonByBoxId: {} as Record<string, string>,
		lastExecutedBox: '',
		copilotChatFirstTimeDismissed: false,
		isSessionFile: false,
		devNotesSections: [],
	}
}));

vi.mock('../../src/webview/core/results-state.js', () => ({
	displayResult: vi.fn(),
	displayResultForBox: vi.fn(),
	getResultsStateRevision: vi.fn(() => 0),
}));

vi.mock('../../src/webview/core/section-factory.js', () => ({
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
	addPythonBox: vi.fn(() => {
		const id = `python_restored_${testState.pythonBoxes.length + 1}`;
		testState.pythonBoxes.push(id);
		return id;
	}),
	addUrlBox: vi.fn(() => {
		const id = `url_restored_${testState.urlBoxes.length + 1}`;
		testState.urlBoxes.push(id);
		return id;
	}),
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
	connections: [],
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
	sqlFavoritesModeByBoxId: {},
	sqlLeaveNoTraceConnectionIds: testState.sqlLeaveNoTraceConnectionIds,
	sqlConnections: testState.sqlConnections,
}));

vi.mock('../../src/webview/sections/kw-chart-section.js', () => ({
	addChartBox: vi.fn(),
	removeChartBox: vi.fn(),
	chartBoxes: testState.chartBoxes,
}));

vi.mock('../../src/webview/sections/kw-transformation-section.js', () => ({
	addTransformationBox: vi.fn(),
	removeTransformationBox: vi.fn((id: string) => {
		const idx = testState.transformationBoxes.indexOf(id);
		if (idx >= 0) testState.transformationBoxes.splice(idx, 1);
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

import { pState } from '../../src/webview/shared/persistence-state.js';
import { postMessageToHost } from '../../src/webview/shared/webview-messages.js';
import { displayResult, displayResultForBox } from '../../src/webview/core/results-state.js';
import { optimizationMetadataByBoxId, sqlFavoritesModeByBoxId } from '../../src/webview/core/state.js';
import { updateConnectionSelects, __kustoSetAutoEnterFavoritesForBox } from '../../src/webview/core/section-factory.js';
import { setRunMode } from '../../src/webview/sections/kw-query-toolbar.js';
import { acknowledgePersistDocument, adoptCurrentStateAsCleanForTest, discardPendingSqlResultRestores, flushCompatibilityPersist, getKqlxState, handleDocumentDataMessage, resolvePendingSqlResultRestores, schedulePersist, __kustoRequestAddSection, __kustoScheduleHtmlPowerBiCompatibilityCheck, __kustoSetHtmlPowerBiCompatibilityCheckEnabled } from '../../src/webview/core/persistence.js';
import { sqlConnectionTargetSignature } from '../../src/shared/sqlConnectionIdentity.js';

describe('persistence round-trip', () => {
	beforeEach(() => {
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
		for (const k of Object.keys(sqlFavoritesModeByBoxId)) delete sqlFavoritesModeByBoxId[k];
		for (const k of Object.keys(optimizationMetadataByBoxId)) delete optimizationMetadataByBoxId[k];
		vi.clearAllMocks();
		pState.compatibilityMode = false;
		pState.documentKind = 'kqlx';
		pState.documentEditRevision = 0;
		pState.documentUri = '';
		pState.devNotesSections = [];
		pState.lastExecutedBox = '';
		pState.htmlPowerBiCompatibilityCheckEnabled = true;
		(window as any).__testPendingQueryTextByBoxId = pState.pendingQueryTextByBoxId;
		(window as any).__testQueryResultJsonByBoxId = pState.queryResultJsonByBoxId;
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
		queryEl.id = 'query_1';
		queryEl.serialize = () => ({ type: 'query', id: 'query_1', query: 'StormEvents | take 5' });

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

	it('does not serialize application editing preferences into a new document', () => {
		handleDocumentDataMessage({ ok: true, forceReload: true, state: { sections: [] } });

		const state = getKqlxState() as Record<string, unknown>;

		expect(state).not.toHaveProperty('caretDocsEnabled');
		expect(state).not.toHaveProperty('autoTriggerAutocompleteEnabled');
	});

	it('preserves the last good state and blocks persistence after a malformed external reload', () => {
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true,
			documentKind: 'kqlx', documentUri: 'file:///tmp/report.kqlx',
			state: { sections: [{ type: 'query', id: 'query_good', query: 'print 1' }] },
		});
		const container = document.createElement('div');
		container.id = 'queries-container';
		const query = document.getElementById('query_good')!;
		container.appendChild(query);
		document.body.appendChild(container);
		vi.mocked(postMessageToHost).mockClear();

		handleDocumentDataMessage({
			type: 'documentData', ok: false, forceReload: true,
			documentKind: 'kqlx', documentUri: 'file:///tmp/report.kqlx',
			error: 'Invalid JSON',
		});

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
		const resultJson = JSON.stringify({
			columns: [{ name: 'Value', type: 'int' }],
			rows: [[1]],
			metadata: { executionTime: '00:00:00.010' },
		});
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
							query: 'select top 10 * from dbo.Events',
							serverUrl: 'tcp:sql.example.test,1433',
							connectionIdHint: 'sql-warehouse',
							targetSignature,
							database: 'Warehouse',
							expanded: false,
							resultsVisible: false,
							favoritesMode: true,
							resultJson,
							runMode: 'all',
							editorHeightPx: 310,
							resultsHeightPx: 420,
							copilotChatVisible: true,
							copilotChatWidthPx: 360,
						},
					],
				},
			});

			expect(pState.pendingSqlQueryByBoxId.sql_saved_1).toBe('select top 10 * from dbo.Events');
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
			expect(displayResultForBox).toHaveBeenCalledWith(JSON.parse(resultJson), 'sql_saved_1', { label: 'Results', showExecutionTime: true });
			expect(document.getElementById('sql_saved_1_sql_results_wrapper')?.style.height).toBe('420px');
			expect(document.getElementById('sql_saved_1_sql_results_wrapper')?.dataset.kustoUserResized).toBe('true');
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

	it('restores a Kusto optimization comparison and its persisted result', () => {
		const resultJson = JSON.stringify({ columns: [{ name: 'Value' }], rows: [[2]] });
		handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true, documentUri: 'file:///tmp/comparison.kqlx',
			state: {
				sections: [
					{ type: 'query', id: 'query_source', clusterUrl: 'https://cluster.kusto.windows.net', database: 'Db', query: 'T | count' },
					{ type: 'query', id: 'query_cmp', comparisonSourceBoxId: 'query_source', clusterUrl: 'https://cluster.kusto.windows.net', database: 'Db', query: 'T | summarize count()', resultJson },
				],
			},
		});

		expect(testState.queryBoxes).toEqual(expect.arrayContaining(['query_source', 'query_cmp']));
		expect(optimizationMetadataByBoxId.query_cmp).toMatchObject({ sourceBoxId: 'query_source', isComparison: true });
		expect(pState.queryResultJsonByBoxId.query_cmp).toBe(resultJson);
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
						},
					],
				},
			});

			expect(testState.addQueryBox).toHaveBeenCalledWith({
				id: 'query_saved_results',
				expanded: true,
				clusterUrl: 'https://persisted.example.kusto.windows.net',
				database: 'Samples',
				authorityId: '',
				connectionIdHint: '',
			});
			expect(pState.pendingQueryTextByBoxId.query_saved_results).toContain('persisted_alpha');
			expect(pState.queryResultJsonByBoxId.query_saved_results).toBe(resultJson);
			expect(displayResultForBox).not.toHaveBeenCalled();

			flushDeferredRestoreTimers();

			expect(pState.lastExecutedBox).toBe('query_saved_results');
			expect(displayResultForBox).toHaveBeenCalledWith(JSON.parse(resultJson), 'query_saved_results', { label: 'Results', showExecutionTime: true });

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

			schedulePersist('roundtrip', true);
			expect(postMessageToHost).toHaveBeenCalledTimes(1);
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
			const oldResultJson = JSON.stringify({ columns: [{ name: 'Old', type: 'string' }], rows: [['old']], metadata: {} });
			const newResultJson = JSON.stringify({ columns: [{ name: 'New', type: 'string' }], rows: [['new']], metadata: {} });

			handleDocumentDataMessage({
				type: 'documentData',
				ok: true,
				forceReload: true,
				documentUri: 'file:///tmp/reload.kqlx',
				state: { sections: [{ type: 'query', id: 'query_reload', query: 'old', resultJson: oldResultJson }] },
			});
			handleDocumentDataMessage({
				type: 'documentData',
				ok: true,
				forceReload: true,
				documentUri: 'file:///tmp/reload.kqlx',
				state: { sections: [{ type: 'query', id: 'query_reload', query: 'new', resultJson: newResultJson }] },
			});

			flushDeferredRestoreTimers();
			flushDeferredRestoreTimers();

			expect(displayResultForBox).toHaveBeenCalledTimes(1);
			expect(displayResultForBox).toHaveBeenCalledWith(
				{ ...JSON.parse(newResultJson), metadata: { executionTime: '' } },
				'query_reload',
				{ label: 'Results', showExecutionTime: true }
			);
		} finally {
			vi.useRealTimers();
		}
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
