import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __kustoGetChartDatasetsInDomOrder, __kustoRefreshAllDataSourceDropdowns, removeHtmlBox } from '../../src/webview/core/section-factory';
import { htmlDashboardFactArtifactConsumerId, toPersistedResultArtifact } from '../../src/shared/resultArtifact.js';
import {
	HostPersistedResultSanitizationApplicationHandler,
	type PersistedResultSanitizationApplicationHandlerOptions,
} from '../../src/host/persistedResultSanitizationApplicationHandler.js';
import '../../src/webview/sections/kw-url-section.js';
import type { KwUrlSection } from '../../src/webview/sections/kw-url-section.js';
import {
	addChartBox,
	reconcileHostOwnedChartProjection,
	removeChartBox,
	type KwChartSection,
} from '../../src/webview/sections/kw-chart-section.js';
import { pState } from '../../src/webview/shared/persistence-state.js';
import {
	adoptHostOwnedMarkdownDocument,
	resetHostOwnedMarkdownDocument,
} from '../../src/webview/core/markdown-document-client.js';
import { suppressPersistenceForTest } from '../../src/webview/core/persistence.js';
import {
	bindResultArtifactConsumer,
	clearResultsState,
	getBoundResultArtifact,
	getCurrentResultArtifact,
	setResultsState,
} from '../../src/webview/core/results-state';
import { rebindChartResultArtifactBinding } from '../../src/webview/shared/chart-renderer.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Create a minimal container + section children in the DOM. */
function setupDom(sections: { id: string; name?: string; tag?: string }[]) {
	const container = document.createElement('div');
	container.id = 'queries-container';
	for (const s of sections) {
		const el = document.createElement(s.tag || 'div');
		el.id = s.id;
		// Simulate the Lit component's getName() method (the current way sections expose names)
		(el as any).getName = () => s.name ?? '';
		container.appendChild(el);
	}
	document.body.appendChild(container);
	return container;
}

function teardownDom() {
	const c = document.getElementById('queries-container');
	if (c) c.remove();
}

/** Inject fake results so the section qualifies as a data source. */
function setFakeResults(id: string) {
	setResultsState(id, {
		columns: [{ name: 'col1', type: 'string' }],
		rows: [['value1']],
	});
}

// ── __kustoGetChartDatasetsInDomOrder ─────────────────────────────────────────

describe('__kustoGetChartDatasetsInDomOrder', () => {
	afterEach(() => teardownDom());

	// ── BUG: section name is ignored for Lit components ───────────────────────

	it('BUG: named query section should produce "A [section #1]" but returns "Unnamed"', () => {
		setupDom([{ id: 'query_1', name: 'A' }]);
		setFakeResults('query_1');

		const datasets = __kustoGetChartDatasetsInDomOrder();

		expect(datasets).toHaveLength(1);
		// This is what the label *should* be:
		const expected = 'A [section #1]';
		// The current code uses document.getElementById(id + '_name').value,
		// which returns '' because Lit components don't have a child <input id="query_1_name">.
		// So the actual label is 'Unnamed [section #1]'.
		expect(datasets[0].label).toBe(expected);
	});

	it('BUG: multiple named query sections should carry their names into Data dropdown labels', () => {
		setupDom([
			{ id: 'query_1', name: 'A' },
			{ id: 'query_2', name: 'B' },
		]);
		setFakeResults('query_1');
		setFakeResults('query_2');

		const datasets = __kustoGetChartDatasetsInDomOrder();

		expect(datasets).toHaveLength(2);
		expect(datasets[0].label).toBe('A [section #1]');
		expect(datasets[1].label).toBe('B [section #2]');
	});

	it('BUG: named transformation section should carry its name', () => {
		setupDom([
			{ id: 'query_1', name: 'Source' },
			{ id: 'transformation_1', name: 'MyTransform' },
		]);
		setFakeResults('query_1');
		setFakeResults('transformation_1');

		const datasets = __kustoGetChartDatasetsInDomOrder();

		const transformDs = datasets.find(d => d.id === 'transformation_1');
		expect(transformDs).toBeDefined();
		expect(transformDs!.label).toBe('MyTransform [section #2]');
	});

	// ── non-bug baseline tests ────────────────────────────────────────────────

	it('returns "Unnamed" label for genuinely unnamed sections', () => {
		setupDom([{ id: 'query_1' }]); // no name
		setFakeResults('query_1');

		const datasets = __kustoGetChartDatasetsInDomOrder();

		expect(datasets).toHaveLength(1);
		expect(datasets[0].label).toBe('Unnamed [section #1]');
	});

	it('skips sections without result data', () => {
		setupDom([{ id: 'query_nodata', name: 'A' }]);
		// no setFakeResults → no columns

		const datasets = __kustoGetChartDatasetsInDomOrder();
		expect(datasets).toHaveLength(0);
	});

	it('includes SQL sections with results as chart data sources', () => {
		setupDom([
			{ id: 'sql_1', name: 'A' },
			{ id: 'chart_1' },
		]);
		setFakeResults('sql_1');

		const datasets = __kustoGetChartDatasetsInDomOrder();

		expect(datasets).toHaveLength(1);
		expect(datasets[0].id).toBe('sql_1');
		expect(datasets[0].label).toBe('A [section #1]');
	});

	it('discovers opaque data-source IDs from section ownership', () => {
		setupDom([
			{ id: 'custom-query', name: 'Opaque query', tag: 'kw-query-section' },
			{ id: 'custom-transform', name: 'Opaque transform', tag: 'kw-transformation-section' },
		]);
		setResultsState('custom-query', { columns: ['Value'], rows: [[1]], metadata: {} }, {
			producer: { engine: 'kusto', boxId: 'custom-query' },
		});
		setResultsState('custom-transform', { columns: ['Value'], rows: [[2]], metadata: {} }, {
			producer: { engine: 'transformation', boxId: 'custom-transform' },
		});

		const datasets = __kustoGetChartDatasetsInDomOrder();

		expect(datasets.map(dataset => dataset.id)).toEqual(['custom-query', 'custom-transform']);
		expect(datasets.map(dataset => dataset.label)).toEqual([
			'Opaque query [section #1]', 'Opaque transform [section #2]',
		]);
	});

	it('discovers a real URL CSV source and removes it after fetch failure', async () => {
		const container = setupDom([]);
		const url = document.createElement('kw-url-section') as KwUrlSection;
		url.id = 'custom-url-source';
		url.boxId = 'custom-url-source';
		url.setName('Imported CSV');
		url.setUrl('https://example.com/data.csv');
		container.appendChild(url);
		await url.updateComplete;
		const internal = url as any;
		internal._activeFetchRequest = { requestId: 'chart-url-request', url: 'https://example.com/data.csv' };

		window.dispatchEvent(new MessageEvent('message', { data: {
			type: 'urlContent', boxId: url.boxId, requestId: 'chart-url-request',
			requestedUrl: 'https://example.com/data.csv', url: 'https://example.com/data.csv',
			kind: 'csv', contentType: 'text/csv', status: 200, body: 'Name,Score\nalpha,1',
			truncated: false, byteLength: 18,
		} }));
		await url.updateComplete;

		expect(__kustoGetChartDatasetsInDomOrder()).toEqual([
			expect.objectContaining({
				id: url.boxId, label: 'Imported CSV [section #1]',
				rows: [['alpha', '1']],
			}),
		]);

		url.setUrl('https://example.com/failing.csv');
		internal._activeFetchRequest = { requestId: 'chart-url-error', url: 'https://example.com/failing.csv' };
		window.dispatchEvent(new MessageEvent('message', { data: {
			type: 'urlError', boxId: url.boxId, requestId: 'chart-url-error',
			requestedUrl: 'https://example.com/failing.csv', error: 'Fetch failed',
		} }));
		await url.updateComplete;

		expect(__kustoGetChartDatasetsInDomOrder()).toEqual([]);
	});

	it('refreshes opaque chart and transformation IDs from element ownership', () => {
		const container = setupDom([]);
		const chart = document.createElement('kw-chart-section') as any;
		chart.id = 'custom-chart';
		chart.refreshDatasets = vi.fn();
		const transformation = document.createElement('kw-transformation-section') as any;
		transformation.id = 'custom-transform-ui';
		transformation.refreshDataSources = vi.fn();
		container.append(chart, transformation);

		__kustoRefreshAllDataSourceDropdowns();

		expect(chart.refreshDatasets).toHaveBeenCalled();
		expect(transformation.refreshDataSources).toHaveBeenCalled();
	});

	it('returns the immutable artifact snapshot when compatibility state mutates', () => {
		setupDom([{ id: 'query_immutable', name: 'Immutable' }]);
		const mutableState = {
			columns: [{ name: 'Value', type: 'string' }],
			rows: [['published']],
		};
		setResultsState('query_immutable', mutableState);
		mutableState.columns[0].name = 'Mutated';
		mutableState.rows[0][0] = 'mutable-state';

		const datasets = __kustoGetChartDatasetsInDomOrder();

		expect(datasets).toHaveLength(1);
		expect((datasets[0].columns[0] as { name: string }).name).toBe('Value');
		expect(datasets[0].rows).toEqual([['published']]);
	});

	it('keeps migrated cached rows available to a dependent chart after reopen', async () => {
		const connection = {
			id: 'legacy-chart-owner', name: 'Legacy chart owner',
			clusterUrl: 'https://legacy-chart.kusto.windows.net',
		};
		const kustoSnapshot = {
			clusterKeys: [] as string[], globallyBlocked: false, version: 1,
			revocationGenerations: {} as Record<string, number>,
		};
		const sqlSnapshot = {
			policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {} },
			connections: [], connectionVersion: 1, accountsByServer: {}, principalVersion: 1,
		};
		const handler = new HostPersistedResultSanitizationApplicationHandler({
			connectionManager: {
				getConnections: () => [connection],
				runWithLeaveNoTraceSnapshotLock: async run => await run(kustoSnapshot),
			},
			kustoClient: { getAccountPartition: () => 'partition-chart' },
			sqlConnectionManager: { getConnection: () => undefined, getConnections: () => [] },
			sqlLifecycle: {
				reconcileComparisonOwners: () => undefined,
				getComparisonOwner: () => undefined,
				getConnectionId: () => undefined,
			},
			sqlWorkbench: {
				isLeaveNoTraceConnection: () => false,
				retrySqlOwnerSnapshotAcquisition: async acquire => (await acquire()).value,
				tryDispatchSqlOwnerSnapshot: async run => ({ acquired: true, value: await run(sqlSnapshot) }),
				tryRunWithSqlOwnerSnapshotLock: async run => ({ acquired: true, value: await run(sqlSnapshot) }),
			},
		} as unknown as PersistedResultSanitizationApplicationHandlerOptions);
		const resultJson = JSON.stringify({
			columns: [{ name: 'Category', type: 'string' }, { name: 'Value', type: 'long' }],
			rows: [['retained', 42]],
			metadata: { cluster: 'legacy-chart', database: 'Db' },
		});
		const legacyState = { sections: [{
			id: 'query_legacy_chart', type: 'query', query: 'print Category="retained", Value=42',
			clusterUrl: connection.clusterUrl, connectionIdHint: connection.id, database: 'Db', resultJson,
		}] };

		try {
			const migrated = await handler.sanitizeSqlLeaveNoTraceStateFresh(legacyState);
			const reopened = await handler.sanitizeSqlLeaveNoTraceStateFresh(migrated);
			expect(reopened).toBe(migrated);
			setupDom([
				{ id: 'query_legacy_chart', name: 'Migrated source', tag: 'kw-query-section' },
				{ id: 'chart_legacy_cache', name: 'Dependent chart', tag: 'kw-chart-section' },
			]);
			setResultsState('query_legacy_chart', JSON.parse(resultJson));
			const restoredArtifact = getCurrentResultArtifact('query_legacy_chart');
			expect(restoredArtifact?.rows).toEqual([['retained', 42]]);
			expect(toPersistedResultArtifact(restoredArtifact)).toMatchObject({
				version: 1, sourceBoxId: 'query_legacy_chart', revision: 1,
			});

			const datasets = __kustoGetChartDatasetsInDomOrder();
			expect(datasets).toEqual([
				expect.objectContaining({ id: 'query_legacy_chart', rows: [['retained', 42]] }),
			]);
			rebindChartResultArtifactBinding('chart_legacy_cache', 'query_legacy_chart');
			expect(getBoundResultArtifact('chart_legacy_cache', 'query_legacy_chart')?.rows)
				.toEqual([['retained', 42]]);
		} finally {
			handler.dispose();
			clearResultsState('query_legacy_chart');
			teardownDom();
		}
	});

	// Regression: collapsed transformation sections must still appear as data
	// sources.  The bug was that KwTransformationSection._computeTransformation()
	// bailed on collapsed sections, so their results never reached the global map
	// and __kustoGetChartDatasetsInDomOrder skipped them (cols.length === 0).
	it('includes collapsed transformation sections that have results', () => {
		setupDom([
			{ id: 'query_1', name: 'Q1' },
			{ id: 'query_2', name: 'Q2' },
			{ id: 'markdown_1' },
			{ id: 'transformation_1', name: 'T1' },
			{ id: 'transformation_2', name: 'T2' },
		]);
		// All data-producing sections have results (queries ran, transformations computed)
		setFakeResults('query_1');
		setFakeResults('query_2');
		setFakeResults('transformation_1');
		setFakeResults('transformation_2');

		const datasets = __kustoGetChartDatasetsInDomOrder();

		// All four data-producing sections must appear, regardless of visibility.
		expect(datasets).toHaveLength(4);
		expect(datasets.map(d => d.id)).toEqual([
			'query_1', 'query_2', 'transformation_1', 'transformation_2',
		]);
		// Section numbering counts all section types (including markdown)
		expect(datasets[0].label).toBe('Q1 [section #1]');
		expect(datasets[1].label).toBe('Q2 [section #2]');
		expect(datasets[2].label).toBe('T1 [section #4]');
		expect(datasets[3].label).toBe('T2 [section #5]');
	});

	it('numbers sections correctly when non-data sections are interspersed', () => {
		setupDom([
			{ id: 'query_1', name: 'First' },
			{ id: 'markdown_1' },           // non-data section, still counted for numbering
			{ id: 'query_2', name: 'Second' },
		]);
		setFakeResults('query_1');
		setFakeResults('query_2');

		const datasets = __kustoGetChartDatasetsInDomOrder();

		expect(datasets).toHaveLength(2);
		// query_1 is section #1, markdown is #2, query_2 is section #3
		expect(datasets[0].label).toBe('First [section #1]');
		expect(datasets[1].label).toBe('Second [section #3]');
	});
});

describe('HTML artifact binding lifecycle', () => {
	it('releases the fact binding when removal runs after DOM detachment', () => {
		setResultsState('query_html_remove_source', { columns: ['Value'], rows: [[1]] }, {
			policy: { exposeToActiveContent: true },
		});
		const consumerId = htmlDashboardFactArtifactConsumerId('html_removed');
		bindResultArtifactConsumer(consumerId, 'query_html_remove_source');

		removeHtmlBox('html_removed');

		expect(getBoundResultArtifact(consumerId, 'query_html_remove_source')).toBeNull();
	});
});

describe('dependent chart cascade', () => {
	afterEach(() => {
		teardownDom();
		const chartState = (window as any).chartStateByBoxId || {};
		for (const key of Object.keys(chartState)) delete chartState[key];
		const transformationState = (window as any).transformationStateByBoxId || {};
		for (const key of Object.keys(transformationState)) delete transformationState[key];
	});

	it('refreshes a join transformation when its right input changes', async () => {
		const container = setupDom([{ id: 'query_right', name: 'Right' }]);
		const transformation = document.createElement('div') as HTMLDivElement & {
			refresh: ReturnType<typeof vi.fn>;
			refreshDataSources: ReturnType<typeof vi.fn>;
		};
		transformation.id = 'transformation_join';
		transformation.refresh = vi.fn();
		transformation.refreshDataSources = vi.fn();
		container.appendChild(transformation);
		const state = (window as any).transformationStateByBoxId
			|| ((window as any).transformationStateByBoxId = {});
		state.transformation_join = {
			dataSourceId: 'query_left',
			transformationType: 'join',
			joinRightDataSourceId: 'query_right',
		};

		setFakeResults('query_right');

		await vi.waitFor(() => expect(transformation.refresh).toHaveBeenCalled());
	});

	it('uses chart.refresh when source results are cleared', async () => {
		const container = setupDom([{ id: 'sql_source', name: 'SQL' }]);
		const chart = document.createElement('div') as HTMLDivElement & { refresh: ReturnType<typeof vi.fn> };
		chart.id = 'chart_1';
		chart.refresh = vi.fn();
		container.appendChild(chart);
		const chartState = (window as any).chartStateByBoxId || ((window as any).chartStateByBoxId = {});
		chartState.chart_1 = { dataSourceId: 'sql_source' };
		const legacyRender = vi.fn();
		(window as any).__kustoRenderChart = legacyRender;
		setFakeResults('sql_source');
		bindResultArtifactConsumer('chart_1', 'sql_source');

		clearResultsState('sql_source');
		await vi.waitFor(() => expect(chart.refresh).toHaveBeenCalled());

		expect(legacyRender).not.toHaveBeenCalled();
		expect(getBoundResultArtifact('chart_1', 'sql_source')).toBeNull();
	});

	it('rebinds a chart only when the dependent refresh consumes a new source revision', async () => {
		const container = setupDom([{ id: 'query_source', name: 'Query' }]);
		const chart = document.createElement('div') as HTMLDivElement & { refresh: ReturnType<typeof vi.fn> };
		chart.id = 'chart_revision';
		chart.refresh = vi.fn();
		container.appendChild(chart);
		const chartState = (window as any).chartStateByBoxId || ((window as any).chartStateByBoxId = {});
		chartState.chart_revision = { dataSourceId: 'query_source' };

		setResultsState('query_source', { columns: [{ name: 'Value' }], rows: [[1]], metadata: {} });
		await vi.waitFor(() => expect(chart.refresh).toHaveBeenCalled());
		chart.refresh.mockClear();
		const artifactA = getCurrentResultArtifact('query_source')!;
		expect(bindResultArtifactConsumer('chart_revision', 'query_source')).toBe(artifactA.artifactId);

		setResultsState('query_source', { columns: [{ name: 'Value' }], rows: [[2]], metadata: {} });
		const artifactB = getCurrentResultArtifact('query_source')!;
		expect(getBoundResultArtifact('chart_revision', 'query_source')).toBe(artifactA);

		await vi.waitFor(() => expect(chart.refresh).toHaveBeenCalled());
		expect(getBoundResultArtifact('chart_revision', 'query_source')).toBe(artifactB);
	});
});

describe('host-owned Chart projection runtime', () => {
	afterEach(() => {
		resetHostOwnedMarkdownDocument();
		suppressPersistenceForTest(false);
		delete (window as any).__e2eCaptureHostMessage;
		teardownDom();
	});

	it('retains the element, ECharts marker, artifact binding, and command silence for an equal projection', async () => {
		setupDom([{ id: 'query_projection_source', name: 'Source' }]);
		setResultsState('query_projection_source', {
			columns: [{ name: 'Day' }, { name: 'Value' }],
			rows: [['2026-08-01', 1]],
			metadata: {},
		});
		suppressPersistenceForTest(true);
		pState.documentKind = 'kqlx';
		pState.compatibilityMode = false;
		pState.documentRuntimeActive = true;
		pState.restoreInProgress = false;

		const chartId = addChartBox({
			id: 'chart_projection_retained', name: 'Stable', mode: 'edit', expanded: true,
			dataSourceId: 'query_projection_source', chartType: 'line', xColumn: 'Day',
			yColumns: ['Value'], showDataLabels: true,
		});
		const element = document.getElementById(chartId) as KwChartSection;
		expect(element).toBeTruthy();
		await element.updateComplete;
		const section = element.createDocumentState();
		expect(adoptHostOwnedMarkdownDocument({
			documentRevision: 0,
			sourceGeneration: 21,
			sectionRevisions: { [chartId]: 0 },
			markdownSectionRevisions: {},
		}, {
			sections: [
				{ id: 'query_projection_source', type: 'query' },
				section,
			],
		})).toBe(true);

		const artifactA = getCurrentResultArtifact('query_projection_source')!;
		expect(bindResultArtifactConsumer(chartId, 'query_projection_source')).toBe(artifactA.artifactId);
		const chartState = (window as any).chartStateByBoxId[chartId];
		const runtimeMarker = { instance: { identity: 'echarts-a' }, zoom: { start: 10, end: 90 } };
		chartState.__echarts = runtimeMarker;
		const captureHostMessage = vi.fn(() => false);
		(window as any).__e2eCaptureHostMessage = captureHostMessage;

		reconcileHostOwnedChartProjection(
			[section],
			['query_projection_source', chartId],
		);
		await element.updateComplete;
		await Promise.resolve();

		expect(document.getElementById(chartId)).toBe(element);
		expect((window as any).chartStateByBoxId[chartId].__echarts).toBe(runtimeMarker);
		expect(getBoundResultArtifact(chartId, 'query_projection_source')).toBe(artifactA);
		expect(captureHostMessage).not.toHaveBeenCalled();

		resetHostOwnedMarkdownDocument();
		removeChartBox(chartId);
		clearResultsState('query_projection_source');
	});

	it('ignores removal emitted by a detached same-ID predecessor', async () => {
		const container = setupDom([]);
		suppressPersistenceForTest(true);
		pState.documentKind = 'kqlx';
		pState.compatibilityMode = false;
		pState.documentRuntimeActive = true;
		pState.restoreInProgress = true;
		expect(adoptHostOwnedMarkdownDocument({
			documentRevision: 0, sourceGeneration: 22,
			sectionRevisions: { chart_replaced: 0 }, markdownSectionRevisions: {},
		}, {
			sections: [{ id: 'chart_replaced', type: 'chart', chartType: 'bar' }],
		})).toBe(true);
		const chartId = addChartBox({ id: 'chart_replaced', chartType: 'bar', showDataLabels: false });
		pState.restoreInProgress = false;
		const predecessor = document.getElementById(chartId) as KwChartSection;
		await predecessor.updateComplete;
		predecessor.remove();
		const replacement = document.createElement('div');
		replacement.id = chartId;
		container.appendChild(replacement);
		const captureHostMessage = vi.fn(() => false);
		(window as any).__e2eCaptureHostMessage = captureHostMessage;

		predecessor.dispatchEvent(new CustomEvent('section-remove', {
			detail: { boxId: chartId }, bubbles: true, composed: true,
		}));

		expect(document.getElementById(chartId)).toBe(replacement);
		expect(captureHostMessage).not.toHaveBeenCalled();
		replacement.remove();
		resetHostOwnedMarkdownDocument();
		removeChartBox(chartId);
	});

	it('ignores first-update side effects from a replaced same-ID predecessor', async () => {
		const container = setupDom([
			{ id: 'query_first_update_a', name: 'A' },
			{ id: 'query_first_update_b', name: 'B' },
		]);
		setResultsState('query_first_update_a', { columns: [{ name: 'Value' }], rows: [[1]], metadata: {} });
		setResultsState('query_first_update_b', { columns: [{ name: 'Value' }], rows: [[2]], metadata: {} });
		suppressPersistenceForTest(true);
		pState.restoreInProgress = true;
		const chartId = addChartBox({
			id: 'chart_first_update_replaced', dataSourceId: 'query_first_update_a',
			chartType: 'line', xColumn: 'Value', yColumns: ['Value'], showDataLabels: false,
		});
		pState.restoreInProgress = false;
		const predecessor = document.getElementById(chartId) as KwChartSection;
		predecessor.remove();
		const replacement = document.createElement('div');
		replacement.id = chartId;
		container.appendChild(replacement);
		const runtimeMarker = { instance: { identity: 'replacement-echarts' } };
		(window as any).chartStateByBoxId[chartId] = {
			dataSourceId: 'query_first_update_b', chartType: 'bar', replacementMarker: true,
			__echarts: runtimeMarker,
		};
		const artifactB = getCurrentResultArtifact('query_first_update_b')!;
		expect(bindResultArtifactConsumer(chartId, 'query_first_update_b')).toBe(artifactB.artifactId);
		const captureHostMessage = vi.fn(() => false);
		(window as any).__e2eCaptureHostMessage = captureHostMessage;

		await predecessor.updateComplete;
		await Promise.resolve();

		expect((window as any).chartStateByBoxId[chartId]).toMatchObject({
			dataSourceId: 'query_first_update_b', chartType: 'bar', replacementMarker: true,
			__echarts: runtimeMarker,
		});
		expect(getBoundResultArtifact(chartId, 'query_first_update_b')).toBe(artifactB);
		expect(captureHostMessage).not.toHaveBeenCalled();
		replacement.remove();
		resetHostOwnedMarkdownDocument();
		removeChartBox(chartId);
		clearResultsState('query_first_update_a');
		clearResultsState('query_first_update_b');
	});

	it('rebinds a collapsed Chart immediately when an authoritative source changes', async () => {
		setupDom([
			{ id: 'query_source_a', name: 'A' },
			{ id: 'query_source_b', name: 'B' },
		]);
		setResultsState('query_source_a', { columns: [{ name: 'Value' }], rows: [[1]], metadata: {} });
		setResultsState('query_source_b', { columns: [{ name: 'Value' }], rows: [[2]], metadata: {} });
		suppressPersistenceForTest(true);
		const chartId = addChartBox({
			id: 'chart_collapsed_retarget', expanded: false, dataSourceId: 'query_source_a',
			chartType: 'bar', xColumn: 'Value', yColumns: ['Value'], showDataLabels: false,
		});
		const element = document.getElementById(chartId) as KwChartSection;
		await element.updateComplete;
		const artifactA = getCurrentResultArtifact('query_source_a')!;
		const artifactB = getCurrentResultArtifact('query_source_b')!;
		expect(bindResultArtifactConsumer(chartId, 'query_source_a')).toBe(artifactA.artifactId);

		element.applyHostDocumentState({
			id: chartId, type: 'chart', expanded: false, dataSourceId: 'query_source_b',
			chartType: 'bar', xColumn: 'Value', yColumns: ['Value'], showDataLabels: false,
		});

		expect(getBoundResultArtifact(chartId, 'query_source_b')).toBe(artifactB);
		expect(getBoundResultArtifact(chartId, 'query_source_a')).toBeNull();
		removeChartBox(chartId);
		clearResultsState('query_source_a');
		clearResultsState('query_source_b');
	});
});
