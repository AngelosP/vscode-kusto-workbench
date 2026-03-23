import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { XAxisSettings, YAxisSettings } from '../../src/webview/shared/chart-utils.js';
import type { ChartSectionHost, DatasetEntry } from '../../src/webview/sections/chart-data-source.controller.js';

// ── Mock section-factory (must appear before controller import) ───────────────

let mockDatasets: DatasetEntry[] = [];

vi.mock('../../src/webview/core/section-factory.js', () => ({
	__kustoGetChartDatasetsInDomOrder: () => mockDatasets,
}));

import { ChartDataSourceController } from '../../src/webview/sections/chart-data-source.controller.js';

// ── Mock host factory ─────────────────────────────────────────────────────────

function defaultXAxis(): XAxisSettings {
	return { sortDirection: '', scaleType: '', labelDensity: 0, showAxisLabel: false, customLabel: '', titleGap: 0 };
}
function defaultYAxis(): YAxisSettings {
	return { showAxisLabel: false, customLabel: '', min: '', max: '', seriesColors: {}, titleGap: 0 };
}

interface HostState {
	boxId: string;
	dataSourceId: string;
	datasets: DatasetEntry[];
	xColumn: string; yColumns: string[]; legendColumn: string;
	labelColumn: string; valueColumn: string;
	tooltipColumns: string[]; sortColumn: string;
	xAxisSettings: XAxisSettings; yAxisSettings: YAxisSettings;
}

function createMockHost(overrides: Partial<HostState> = {}): ChartSectionHost {
	const state: HostState = {
		boxId: 'box1',
		dataSourceId: '',
		datasets: [],
		xColumn: '', yColumns: [], legendColumn: '',
		labelColumn: '', valueColumn: '',
		tooltipColumns: [], sortColumn: '',
		xAxisSettings: defaultXAxis(), yAxisSettings: defaultYAxis(),
		...overrides,
	};

	const el = document.createElement('div') as unknown as ChartSectionHost;
	return Object.assign(el, {
		boxId: state.boxId,
		addController: vi.fn(),
		removeController: vi.fn(),
		requestUpdate: vi.fn(),
		updateComplete: Promise.resolve(true),
		schedulePersist: vi.fn(),
		getDataSourceId: () => state.dataSourceId,
		setDataSourceId: (id: string) => { state.dataSourceId = id; },
		getDatasets: () => state.datasets,
		setDatasets: (ds: DatasetEntry[]) => { state.datasets = ds; },
		getXColumn: () => state.xColumn,
		setXColumn: (v: string) => { state.xColumn = v; },
		getYColumns: () => state.yColumns,
		setYColumns: (v: string[]) => { state.yColumns = v; },
		getLegendColumn: () => state.legendColumn,
		setLegendColumn: (v: string) => { state.legendColumn = v; },
		getLabelColumn: () => state.labelColumn,
		setLabelColumn: (v: string) => { state.labelColumn = v; },
		getValueColumn: () => state.valueColumn,
		setValueColumn: (v: string) => { state.valueColumn = v; },
		getTooltipColumns: () => state.tooltipColumns,
		setTooltipColumns: (v: string[]) => { state.tooltipColumns = v; },
		getSortColumn: () => state.sortColumn,
		setSortColumn: (v: string) => { state.sortColumn = v; },
		getXAxisSettings: () => state.xAxisSettings,
		setXAxisSettings: (v: XAxisSettings) => { state.xAxisSettings = v; },
		getYAxisSettings: () => state.yAxisSettings,
		setYAxisSettings: (v: YAxisSettings) => { state.yAxisSettings = v; },
		// expose state for test assertions
		_state: state,
	}) as any;
}

function fakeEvent(value: string): Event {
	return { target: { value } } as unknown as Event;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ChartDataSourceController', () => {
	let host: ChartSectionHost & { _state: HostState };
	let ctrl: ChartDataSourceController;
	let wrapper: HTMLDivElement;

	beforeEach(() => {
		mockDatasets = [];
		host = createMockHost() as any;
		ctrl = new ChartDataSourceController(host);
		// Create wrapper element for height save/restore
		wrapper = document.createElement('div');
		wrapper.id = 'box1_chart_wrapper';
		document.body.appendChild(wrapper);
	});

	afterEach(() => {
		wrapper.remove();
	});

	// ── getColumnNames ────────────────────────────────────────────────────

	describe('getColumnNames', () => {
		it('returns column names from string array', () => {
			host._state.dataSourceId = 'ds1';
			host._state.datasets = [{ id: 'ds1', label: 'DS 1', columns: ['A', 'B', 'C'] as any, rows: [] }];
			expect(ctrl.getColumnNames()).toEqual(['A', 'B', 'C']);
		});

		it('returns column names from objects with .name', () => {
			host._state.dataSourceId = 'ds1';
			host._state.datasets = [{ id: 'ds1', label: 'DS 1', columns: [{ name: 'X' }, { name: 'Y' }] as any, rows: [] }];
			expect(ctrl.getColumnNames()).toEqual(['X', 'Y']);
		});

		it('returns column names from objects with .columnName', () => {
			host._state.dataSourceId = 'ds1';
			host._state.datasets = [{ id: 'ds1', label: 'DS 1', columns: [{ columnName: 'P' }] as any, rows: [] }];
			expect(ctrl.getColumnNames()).toEqual(['P']);
		});

		it('filters out empty/falsy column names', () => {
			host._state.dataSourceId = 'ds1';
			host._state.datasets = [{ id: 'ds1', label: 'DS 1', columns: ['A', '', null, { name: '' }] as any, rows: [] }];
			expect(ctrl.getColumnNames()).toEqual(['A']);
		});

		it('returns empty array when no dataset matches', () => {
			host._state.dataSourceId = 'ds-unknown';
			host._state.datasets = [{ id: 'ds1', label: 'DS 1', columns: ['A'] as any, rows: [] }];
			expect(ctrl.getColumnNames()).toEqual([]);
		});

		it('returns empty array when columns is not an array', () => {
			host._state.dataSourceId = 'ds1';
			host._state.datasets = [{ id: 'ds1', label: 'DS 1', columns: undefined as any, rows: [] }];
			expect(ctrl.getColumnNames()).toEqual([]);
		});
	});

	// ── pruneStaleColumns ─────────────────────────────────────────────────

	describe('pruneStaleColumns', () => {
		it('removes columns not in the current dataset', () => {
			host._state.dataSourceId = 'ds1';
			host._state.datasets = [{ id: 'ds1', label: 'DS 1', columns: ['A', 'B'] as any, rows: [] }];
			host._state.xColumn = 'A';
			host._state.yColumns = ['A', 'C'];
			host._state.legendColumn = 'D';
			host._state.tooltipColumns = ['B', 'E'];
			host._state.sortColumn = 'F';
			host._state.labelColumn = 'G';
			host._state.valueColumn = 'H';

			ctrl.pruneStaleColumns();

			expect(host._state.xColumn).toBe('A');
			expect(host._state.yColumns).toEqual(['A']);
			expect(host._state.legendColumn).toBe('');
			expect(host._state.tooltipColumns).toEqual(['B']);
			expect(host._state.sortColumn).toBe('');
			expect(host._state.labelColumn).toBe('');
			expect(host._state.valueColumn).toBe('');
		});

		it('no-ops when all columns are valid', () => {
			host._state.dataSourceId = 'ds1';
			host._state.datasets = [{ id: 'ds1', label: 'DS 1', columns: ['A', 'B', 'C'] as any, rows: [] }];
			host._state.xColumn = 'A';
			host._state.yColumns = ['B', 'C'];
			host._state.legendColumn = 'A';

			ctrl.pruneStaleColumns();

			expect(host._state.xColumn).toBe('A');
			expect(host._state.yColumns).toEqual(['B', 'C']);
			expect(host._state.legendColumn).toBe('A');
		});

		it('no-ops when dataset has no columns (empty columns set)', () => {
			host._state.dataSourceId = 'ds-empty';
			host._state.datasets = [{ id: 'ds-empty', label: 'Empty', columns: [] as any, rows: [] }];
			host._state.xColumn = 'X';

			ctrl.pruneStaleColumns();

			// Should not touch x/y because cols.size === 0 early return
			expect(host._state.xColumn).toBe('X');
		});
	});

	// ── refreshDatasets ───────────────────────────────────────────────────

	describe('refreshDatasets', () => {
		it('updates datasets from __kustoGetChartDatasetsInDomOrder', () => {
			const ds: DatasetEntry[] = [{ id: 'q1', label: 'Query 1', columns: ['A'] as any, rows: [[1]] }];
			mockDatasets = ds;

			ctrl.refreshDatasets();

			expect(host._state.datasets).toEqual(ds);
		});

		it('skips setDatasets when return value is identical', () => {
			const ds: DatasetEntry[] = [{ id: 'q1', label: 'Q1', columns: ['A'] as any, rows: [[1]] }];
			host._state.datasets = ds;
			mockDatasets = [{ id: 'q1', label: 'Q1', columns: ['A'] as any, rows: [[1]] }];

			const setDatasetsSpy = vi.spyOn(host, 'setDatasets' as any);
			ctrl.refreshDatasets();

			expect(setDatasetsSpy).not.toHaveBeenCalled();
		});

		it('updates when dataset ids differ', () => {
			host._state.datasets = [{ id: 'old', label: 'Old', columns: [] as any, rows: [] }];
			mockDatasets = [{ id: 'new', label: 'New', columns: [] as any, rows: [] }];

			ctrl.refreshDatasets();

			expect(host._state.datasets[0].id).toBe('new');
		});

		it('prunes stale columns after refresh', () => {
			host._state.dataSourceId = 'ds1';
			host._state.xColumn = 'Gone';
			mockDatasets = [{ id: 'ds1', label: 'DS1', columns: ['A', 'B'] as any, rows: [] }];

			ctrl.refreshDatasets();

			expect(host._state.xColumn).toBe('');
		});
	});

	// ── onDataSourceChanged — column memory ───────────────────────────────

	describe('onDataSourceChanged', () => {
		const ds1: DatasetEntry = { id: 'ds1', label: 'DS 1', columns: ['A', 'B', 'C'] as any, rows: [[1, 2, 3]] };
		const ds2: DatasetEntry = { id: 'ds2', label: 'DS 2', columns: ['X', 'Y'] as any, rows: [[10, 20]] };

		beforeEach(() => {
			mockDatasets = [ds1, ds2];
		});

		it('saves column memory and restores on switch back', () => {
			// Start on ds1 with some columns selected
			host._state.dataSourceId = 'ds1';
			host._state.datasets = [ds1, ds2];
			host._state.xColumn = 'A';
			host._state.yColumns = ['B', 'C'];
			host._state.legendColumn = 'A';

			// Switch to ds2
			ctrl.onDataSourceChanged(fakeEvent('ds2'));

			expect(host._state.dataSourceId).toBe('ds2');
			// Old ds1 columns should be no longer on host (prune kicked in for ds2)
			// But column memory should have saved them

			// Set ds2 columns
			host._state.xColumn = 'X';
			host._state.yColumns = ['Y'];

			// Switch back to ds1
			ctrl.onDataSourceChanged(fakeEvent('ds1'));

			expect(host._state.dataSourceId).toBe('ds1');
			expect(host._state.xColumn).toBe('A');
			expect(host._state.yColumns).toEqual(['B', 'C']);
			expect(host._state.legendColumn).toBe('A');
		});

		it('calls schedulePersist', () => {
			host._state.dataSourceId = 'ds1';
			host._state.datasets = [ds1, ds2];

			ctrl.onDataSourceChanged(fakeEvent('ds2'));

			expect(host.schedulePersist).toHaveBeenCalled();
		});

		it('saves and restores wrapper height', () => {
			host._state.dataSourceId = 'ds1';
			host._state.datasets = [ds1, ds2];
			wrapper.style.height = '400px';

			ctrl.onDataSourceChanged(fakeEvent('ds2'));

			// Now switch back to ds1
			host._state.datasets = [ds1, ds2];
			ctrl.onDataSourceChanged(fakeEvent('ds1'));

			expect(wrapper.style.height).toBe('400px');
			expect(wrapper.dataset.kustoUserResized).toBe('true');
		});

		it('skips restore of columns that no longer exist in dataset', () => {
			host._state.dataSourceId = 'ds1';
			host._state.datasets = [ds1, ds2];
			host._state.xColumn = 'C';
			host._state.yColumns = ['B'];

			// Switch away (saves memory with columns C, B)
			ctrl.onDataSourceChanged(fakeEvent('ds2'));

			// Now replace ds1 with a version missing column C
			const ds1slim: DatasetEntry = { id: 'ds1', label: 'DS1', columns: ['A', 'B'] as any, rows: [] };
			mockDatasets = [ds1slim, ds2];

			// Switch back
			ctrl.onDataSourceChanged(fakeEvent('ds1'));

			// C was remembered but not in dataset — should not be restored
			expect(host._state.xColumn).not.toBe('C');
			// B is still valid
			expect(host._state.yColumns).toEqual(['B']);
		});

		it('does not save column memory when old data source id is empty', () => {
			host._state.dataSourceId = '';
			host._state.datasets = [ds1, ds2];
			host._state.xColumn = 'A';

			ctrl.onDataSourceChanged(fakeEvent('ds1'));

			// Now switch away and back — there should be no memory for ''
			host._state.xColumn = 'B';
			ctrl.onDataSourceChanged(fakeEvent('ds1'));
			// Should not restore anything from '' source
		});

		it('saves and restores axis settings between data sources', () => {
			host._state.dataSourceId = 'ds1';
			host._state.datasets = [ds1, ds2];
			const customXAxis = { ...defaultXAxis(), sortDirection: 'desc', scaleType: 'log' };
			const customYAxis = { ...defaultYAxis(), min: '0', max: '100' };
			host._state.xAxisSettings = customXAxis;
			host._state.yAxisSettings = customYAxis;

			ctrl.onDataSourceChanged(fakeEvent('ds2'));

			// Set different axis settings on ds2
			host._state.xAxisSettings = defaultXAxis();
			host._state.yAxisSettings = defaultYAxis();

			// Switch back
			ctrl.onDataSourceChanged(fakeEvent('ds1'));

			expect(host._state.xAxisSettings.sortDirection).toBe('desc');
			expect(host._state.xAxisSettings.scaleType).toBe('log');
			expect(host._state.yAxisSettings.min).toBe('0');
			expect(host._state.yAxisSettings.max).toBe('100');
		});

		it('handles rapid back-and-forth switching preserving separate memories', () => {
			host._state.dataSourceId = 'ds1';
			host._state.datasets = [ds1, ds2];
			host._state.xColumn = 'A';
			host._state.yColumns = ['B'];

			ctrl.onDataSourceChanged(fakeEvent('ds2'));
			host._state.xColumn = 'X';
			host._state.yColumns = ['Y'];

			ctrl.onDataSourceChanged(fakeEvent('ds1'));
			expect(host._state.xColumn).toBe('A');
			expect(host._state.yColumns).toEqual(['B']);

			ctrl.onDataSourceChanged(fakeEvent('ds2'));
			expect(host._state.xColumn).toBe('X');
			expect(host._state.yColumns).toEqual(['Y']);
		});
	});

	// ── getColumnNames — additional edge cases ─────────────────────────────

	describe('getColumnNames — extra edge cases', () => {
		it('handles mixed column name formats', () => {
			host._state.dataSourceId = 'ds1';
			host._state.datasets = [{
				id: 'ds1', label: 'DS', rows: [],
				columns: ['A', { name: 'B' }, { columnName: 'C' }, { name: '' }, 42] as any,
			}];
			expect(ctrl.getColumnNames()).toEqual(['A', 'B', 'C']);
		});

		it('returns empty when dataSourceId has not been set', () => {
			host._state.dataSourceId = '';
			host._state.datasets = [{ id: 'ds1', label: 'DS', columns: ['A'] as any, rows: [] }];
			expect(ctrl.getColumnNames()).toEqual([]);
		});
	});

	// ── pruneStaleColumns — additional edge cases ──────────────────────────

	describe('pruneStaleColumns — extra edge cases', () => {
		it('prunes all yColumns when none match', () => {
			host._state.dataSourceId = 'ds1';
			host._state.datasets = [{ id: 'ds1', label: 'DS', columns: ['A'] as any, rows: [] }];
			host._state.yColumns = ['X', 'Y', 'Z'];
			ctrl.pruneStaleColumns();
			expect(host._state.yColumns).toEqual([]);
		});

		it('prunes tooltipColumns and sortColumn together', () => {
			host._state.dataSourceId = 'ds1';
			host._state.datasets = [{ id: 'ds1', label: 'DS', columns: ['A', 'B'] as any, rows: [] }];
			host._state.tooltipColumns = ['A', 'Gone'];
			host._state.sortColumn = 'Gone';
			ctrl.pruneStaleColumns();
			expect(host._state.tooltipColumns).toEqual(['A']);
			expect(host._state.sortColumn).toBe('');
		});
	});
});
