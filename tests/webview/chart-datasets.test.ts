import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __kustoGetChartDatasetsInDomOrder } from '../../src/webview/core/section-factory';
import {
	bindResultArtifactConsumer,
	clearResultsState,
	getBoundResultArtifact,
	getCurrentResultArtifact,
	setResultsState,
} from '../../src/webview/core/results-state';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Create a minimal container + section children in the DOM. */
function setupDom(sections: { id: string; name?: string }[]) {
	const container = document.createElement('div');
	container.id = 'queries-container';
	for (const s of sections) {
		const el = document.createElement('div');
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
