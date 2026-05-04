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
	const sqlElements: Record<string, HTMLElement & {
		setFavoritesMode: ReturnType<typeof vi.fn>;
	}> = {};
	const postMessageToHost = vi.fn();

	const addQueryBox = vi.fn((options: { id?: string } = {}) => {
		const id = options.id || `query_restored_${addQueryBox.mock.calls.length + 1}`;
		queryBoxes.push(id);
		queryEditors[id] = { getValue: () => '' };
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
		const el = document.createElement('div') as HTMLElement & { setFavoritesMode: ReturnType<typeof vi.fn> };
		el.id = id;
		el.setFavoritesMode = vi.fn();
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
		sqlElements,
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
		documentUri: '',
		compatibilityTooltip: '',
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
	favoritesModeByBoxId: {},
	leaveNoTraceClusters: [],
	caretDocsEnabled: true,
	autoTriggerAutocompleteEnabled: true,
	setCaretDocsEnabled: vi.fn(),
	setAutoTriggerAutocompleteEnabled: vi.fn(),
	sqlFavoritesModeByBoxId: {},
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
import { sqlFavoritesModeByBoxId } from '../../src/webview/core/state.js';
import { setRunMode } from '../../src/webview/sections/kw-query-toolbar.js';
import { getKqlxState, handleDocumentDataMessage, schedulePersist } from '../../src/webview/core/persistence.js';

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
		for (const k of Object.keys(testState.queryEditors)) delete testState.queryEditors[k];
		for (const k of Object.keys(testState.markdownEditors)) delete testState.markdownEditors[k];
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
		vi.clearAllMocks();
		pState.compatibilityMode = false;
		pState.documentKind = 'kqlx';
		pState.devNotesSections = [];
		pState.lastExecutedBox = '';
	});

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

	it('restores HTML section code, legacy dataSourceIds input, and dashboard publish metadata', () => {
		const pbiPublishInfo = {
			workspaceId: 'workspace-1',
			workspaceName: 'Analytics',
			semanticModelId: 'model-1',
			reportId: 'report-1',
			reportName: 'Ops Dashboard',
			reportUrl: 'https://app.powerbi.com/report-1',
			dataMode: 'import',
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
		});
		expect(testState.htmlBoxes).toEqual(['html_saved_1']);
		expect(testState.queryBoxes).toEqual([]);
	});

	it('restores SQL section query, state, favorites mode, and persisted results', () => {
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
		expect(pState.lastExecutedBox).toBe('sql_saved_1');
		expect(displayResultForBox).toHaveBeenCalledWith(JSON.parse(resultJson), 'sql_saved_1', { label: 'Results', showExecutionTime: true });
		expect(document.getElementById('sql_saved_1_sql_results_wrapper')?.style.height).toBe('420px');
		expect(document.getElementById('sql_saved_1_sql_results_wrapper')?.dataset.kustoUserResized).toBe('true');
		expect(testState.sqlBoxes).toEqual(['sql_saved_1']);
	});

	it('restores persisted KQL query results to the saved section and keeps the next persist stable', () => {
		const resultJson = JSON.stringify({
			columns: [
				{ name: 'RowId', type: 'long' },
				{ name: 'Label', type: 'string' },
			],
			rows: [[1, 'persisted_alpha'], [2, 'persisted_beta']],
			metadata: { executionTime: '00:00:00.021', clientActivityId: 'cid_restore' },
		});

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
		});
		expect(pState.pendingQueryTextByBoxId.query_saved_results).toContain('persisted_alpha');
		expect(pState.queryResultJsonByBoxId.query_saved_results).toBe(resultJson);
		expect(pState.lastExecutedBox).toBe('query_saved_results');
		expect(displayResult).toHaveBeenCalledWith(JSON.parse(resultJson));

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
});
