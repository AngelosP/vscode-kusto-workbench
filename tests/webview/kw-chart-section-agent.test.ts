import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { html, render, nothing } from 'lit';

// ── Window globals stubs ──────────────────────────────────────────────────────

const fakeDatasets = [
	{
		id: 'q1',
		label: 'Query 1',
		columns: ['Timestamp', 'Count', 'Category', 'Value'],
		rows: [],
	},
];

// Mock modules that kw-chart-section imports directly
vi.mock('../../src/webview/core/section-factory.js', () => ({
	__kustoGetChartDatasetsInDomOrder: () => fakeDatasets,
	__kustoGetChartValidationStatus: () => null,
	__kustoCleanupSectionModeResizeObserver: vi.fn(),
}));

vi.mock('../../src/webview/shared/chart-renderer.js', () => ({
	maximizeChartBox: vi.fn(),
	disposeChartEcharts: vi.fn(),
	renderChart: vi.fn(),
	getChartState: (id: string) => {
		const states = (window as any).chartStateByBoxId || ((window as any).chartStateByBoxId = {});
		return states[id] || (states[id] = {});
	},
	getChartMinResizeHeight: () => 140,
}));

vi.mock('../../src/webview/core/persistence.js', () => ({
	schedulePersist: vi.fn(),
}));

import '../../src/webview/sections/kw-chart-section.js';
import { KwChartSection } from '../../src/webview/sections/kw-chart-section.js';
import { ICONS } from '../../src/webview/shared/icon-registry.js';

beforeEach(() => {
	// Stub globals that kw-chart-section reads
	(window as any).chartStateByBoxId = {};
});

// ── Test helpers ──────────────────────────────────────────────────────────────

let container: HTMLDivElement;

function createChartSection(boxId = 'chart_test_1'): KwChartSection {
	render(html`
		<kw-chart-section box-id=${boxId}>
			<div slot="chart-content"></div>
		</kw-chart-section>
	`, container);
	return container.querySelector('kw-chart-section')!;
}

function getChartTypeButton(el: KwChartSection, ariaLabel: string): HTMLButtonElement {
	const button = el.shadowRoot!.querySelector(`.chart-type-btn[aria-label="${ariaLabel}"]`) as HTMLButtonElement | null;
	expect(button).not.toBeNull();
	return button!;
}

function getSelectByFieldLabel(el: KwChartSection, fieldLabel: string): HTMLSelectElement {
	const groups = Array.from(el.shadowRoot!.querySelectorAll('.chart-field-group'));
	const group = groups.find(candidate => candidate.querySelector('label')?.textContent?.trim() === fieldLabel);
	expect(group).toBeTruthy();
	const select = group!.querySelector('select') as HTMLSelectElement | null;
	expect(select).not.toBeNull();
	return select!;
}

function changeSelectValue(select: HTMLSelectElement, value: string): void {
	select.value = value;
	select.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

async function configureAreaChart(el: KwChartSection): Promise<void> {
	expect(el.configure({ chartType: 'area', dataSourceId: 'q1', xColumn: 'Timestamp', yColumns: ['Count'] })).toBe(true);
	el.refreshDatasets();
	await el.updateComplete;
}

// ── Setup/teardown ────────────────────────────────────────────────────────────

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	render(nothing, container);
	container.remove();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('kw-chart-section agent configuration', () => {
	/**
	 * Regression: when the agent configures a chart via the tool, the global
	 * chartStateByBoxId is updated and __kustoUpdateChartBuilderUI is called.
	 * For Lit elements, that function must call syncFromGlobalState() so the
	 * Lit reactive properties (and thus the dropdown UI) reflect the new config.
	 * Previously, only refreshDatasets() was called, leaving dropdowns empty.
	 */
	it('syncFromGlobalState updates Lit properties from global state', async () => {
		const el = createChartSection();
		await el.updateComplete;

		// Simulate what the agent tool does: write config into global state
		const global = (window as any).chartStateByBoxId;
		global['chart_test_1'] = {
			chartType: 'bar',
			dataSourceId: 'q1',
			xColumn: 'Timestamp',
			yColumns: ['Count', 'Value'],
			legendColumn: 'Category',
			showDataLabels: true,
			sortColumn: 'Timestamp',
			sortDirection: 'asc',
		};

		// Call syncFromGlobalState (what __kustoUpdateChartBuilderUI should do)
		el.syncFromGlobalState();
		await el.updateComplete;

		// Verify Lit reactive properties are updated
		expect((el as any)._chartType).toBe('bar');
		expect((el as any)._dataSourceId).toBe('q1');
		expect((el as any)._xColumn).toBe('Timestamp');
		expect((el as any)._yColumns).toEqual(['Count', 'Value']);
		expect((el as any)._legendColumn).toBe('Category');
		expect((el as any)._showDataLabels).toBe(true);
		expect((el as any)._sortColumn).toBe('Timestamp');
		expect((el as any)._sortDirection).toBe('asc');
	});

	it('ignores stale zoom/pan state from global chart config', async () => {
		const el = createChartSection();
		await el.updateComplete;

		const global = (window as any).chartStateByBoxId;
		global['chart_test_1'] = {
			chartType: 'line',
			dataSourceId: 'q1',
			xColumn: 'Timestamp',
			yColumns: ['Count'],
			zoomPanEnabled: true,
		};

		el.syncFromGlobalState();
		await el.updateComplete;
		expect((el as any)._zoomPanEnabled).toBeUndefined();
		expect(el.serialize()).not.toHaveProperty('zoomPanEnabled');
	});

	it('configure ignores zoom/pan fields from untyped callers', async () => {
		const el = createChartSection();
		await el.updateComplete;

		expect(el.configure({ chartType: 'line', dataSourceId: 'q1', xColumn: 'Timestamp', yColumns: ['Count'], zoomPanEnabled: true } as any)).toBe(true);
		await el.updateComplete;
		expect(el.serialize()).not.toHaveProperty('zoomPanEnabled');
		expect((window as any).chartStateByBoxId['chart_test_1'] ?? {}).not.toHaveProperty('zoomPanEnabled');
		expect((el as any)._zoomPanEnabled).toBeUndefined();
	});

	it('configure drops nested stale zoom fields while keeping known settings', async () => {
		const el = createChartSection();
		await el.updateComplete;

		expect(el.configure({
			chartType: 'line',
			dataSourceId: 'q1',
			xColumn: 'Timestamp',
			yColumns: ['Count'],
			xAxisSettings: { customLabel: 'Time', zoomPanEnabled: true },
			yAxisSettings: { customLabel: 'Events', dataZoom: { start: 20 } },
			legendSettings: { sortMode: 'alphabetical', zoomPanEnabled: true },
		} as any)).toBe(true);
		await el.updateComplete;

		const serialized = el.serialize() as any;
		expect(serialized.xAxisSettings.customLabel).toBe('Time');
		expect(serialized.xAxisSettings).not.toHaveProperty('zoomPanEnabled');
		expect(serialized.yAxisSettings.customLabel).toBe('Events');
		expect(serialized.yAxisSettings).not.toHaveProperty('dataZoom');
		expect(serialized.legendSettings.sortMode).toBe('alpha-asc');
		expect(serialized.legendSettings).not.toHaveProperty('zoomPanEnabled');
	});

	it('axis setting setters drop stale nested zoom fields', async () => {
		const el = createChartSection();
		await el.updateComplete;

		el.setYColumns(['Count']);
		el.setXAxisSettings({ customLabel: 'Time', zoomPanEnabled: true } as any);
		el.setYAxisSettings({ customLabel: 'Events', dataZoom: { start: 10 } } as any);

		const serialized = el.serialize() as any;
		expect(serialized.xAxisSettings.customLabel).toBe('Time');
		expect(serialized.xAxisSettings).not.toHaveProperty('zoomPanEnabled');
		expect(serialized.yAxisSettings.customLabel).toBe('Events');
		expect(serialized.yAxisSettings).not.toHaveProperty('dataZoom');
	});

	it('partial legend settings preserve top-level stack mode', async () => {
		const el = createChartSection();
		await el.updateComplete;

		expect(el.configure({
			chartType: 'bar',
			dataSourceId: 'q1',
			xColumn: 'Timestamp',
			yColumns: ['Count'],
			stackMode: 'stacked',
			legendSettings: { sortMode: 'alpha-asc' },
		} as any)).toBe(true);

		const serialized = el.serialize() as any;
		expect(serialized.stackMode).toBe('stacked');
		expect(serialized.legendSettings.stackMode).toBe('stacked');
		expect(serialized.legendSettings.sortMode).toBe('alpha-asc');
	});

	it('does not render zoom as an edit-panel option', async () => {
		const el = createChartSection();
		await el.updateComplete;

		expect(el.configure({ chartType: 'line', dataSourceId: 'q1', xColumn: 'Timestamp', yColumns: ['Count'] })).toBe(true);
		el.refreshDatasets();
		await el.updateComplete;

		const labels = Array.from(el.shadowRoot!.querySelectorAll('.chart-mapping-grid > .chart-field-group > label:first-child'))
			.map(label => label.textContent?.trim())
			.filter(Boolean);
		expect(labels).not.toContain('Zoom');
	});

	it('uses the shared icon registry for the floating undo zoom button', () => {
		const queriesContainer = document.createElement('div');
		queriesContainer.id = 'queries-container';
		container.appendChild(queriesContainer);

		const id = 'chart_zoom_undo_icon';
		KwChartSection.addChartBox({ id });

		const undoButton = document.getElementById(`${id}_chart_zoom_undo`);
		const expected = document.createElement('span');
		render(ICONS.toolbarUndo, expected);

		expect(undoButton?.innerHTML).toBe(expected.innerHTML);
	});

	it('dropdowns reflect global state after syncFromGlobalState', async () => {
		const el = createChartSection();
		await el.updateComplete;

		// Simulate agent tool writing config
		const global = (window as any).chartStateByBoxId;
		global['chart_test_1'] = {
			chartType: 'bar',
			dataSourceId: 'q1',
			xColumn: 'Timestamp',
			yColumns: ['Count'],
		};

		el.syncFromGlobalState();
		// Also refresh datasets so column dropdowns are populated
		el.refreshDatasets();
		await el.updateComplete;

		// The data source <select> should show the correct value
		const shadowRoot = el.shadowRoot!;
		const dataSelect = shadowRoot.querySelector('.chart-select') as HTMLSelectElement;
		expect(dataSelect).not.toBeNull();

		// The chart type buttons should reflect 'bar' as active
		const activeTypeBtn = shadowRoot.querySelector('.chart-type-btn.is-active');
		expect(activeTypeBtn).not.toBeNull();
		expect(activeTypeBtn!.getAttribute('aria-label')).toBe('Bar Chart');

		// The X column select should show 'Timestamp'
		const selects = shadowRoot.querySelectorAll('.chart-select');
		// First select: data source, second: X column
		const xSelect = selects[1] as HTMLSelectElement | undefined;
		if (xSelect) {
			// Find the selected option
			const selected = xSelect.querySelector('option[selected]') as HTMLOptionElement | null;
			expect(selected?.value || xSelect.value).toBe('Timestamp');
		}
	});

	it('refreshDatasets alone does NOT sync chart config from global state', async () => {
		const el = createChartSection();
		await el.updateComplete;

		// Simulate agent tool writing config
		const global = (window as any).chartStateByBoxId;
		global['chart_test_1'] = {
			chartType: 'scatter',
			dataSourceId: 'q1',
			xColumn: 'Category',
			yColumns: ['Value'],
		};

		// Only call refreshDatasets (the old buggy path)
		el.refreshDatasets();
		await el.updateComplete;

		// chartType should still be the default ('area'), NOT 'scatter'
		// because refreshDatasets doesn't read from global state
		expect((el as any)._chartType).toBe('area');
		expect((el as any)._xColumn).toBe('');
		expect((el as any)._yColumns).toEqual([]);
	});

	for (const target of [
		{ ariaLabel: 'Pie Chart', chartType: 'pie' },
		{ ariaLabel: 'Funnel Chart', chartType: 'funnel' },
	] as const) {
		it(`${target.chartType} Label and Value dropdowns stay blank when backend fields are blank`, async () => {
			const el = createChartSection(`chart_${target.chartType}_blank_roles`);
			await el.updateComplete;
			await configureAreaChart(el);

			getChartTypeButton(el, target.ariaLabel).click();
			await el.updateComplete;

			const labelSelect = getSelectByFieldLabel(el, 'Label');
			const valueSelect = getSelectByFieldLabel(el, 'Value');
			expect(labelSelect.value).toBe('');
			expect(valueSelect.value).toBe('');

			const serialized = el.serialize() as any;
			expect(serialized.chartType).toBe(target.chartType);
			expect(serialized.xColumn).toBe('Timestamp');
			expect(serialized.yColumns).toEqual(['Count']);
			expect(serialized).not.toHaveProperty('labelColumn');
			expect(serialized).not.toHaveProperty('valueColumn');

			const globalState = (window as any).chartStateByBoxId[el.boxId];
			expect(globalState.labelColumn).toBe('');
			expect(globalState.valueColumn).toBe('');
		});
	}

	it('pie Label and Value dropdown changes update serialized and renderer state', async () => {
		const el = createChartSection('chart_pie_selected_roles');
		await el.updateComplete;
		await configureAreaChart(el);

		getChartTypeButton(el, 'Pie Chart').click();
		await el.updateComplete;

		changeSelectValue(getSelectByFieldLabel(el, 'Label'), 'Timestamp');
		await el.updateComplete;
		changeSelectValue(getSelectByFieldLabel(el, 'Value'), 'Count');
		await el.updateComplete;

		const serialized = el.serialize() as any;
		expect(serialized.chartType).toBe('pie');
		expect(serialized.labelColumn).toBe('Timestamp');
		expect(serialized.valueColumn).toBe('Count');

		const globalState = (window as any).chartStateByBoxId[el.boxId];
		expect(globalState.labelColumn).toBe('Timestamp');
		expect(globalState.valueColumn).toBe('Count');
	});

	it('opens X/Y axis popup from chart axis-title click event', async () => {
		const el = createChartSection();
		await el.updateComplete;

		el.dispatchEvent(new CustomEvent('kusto-axis-title-click', {
			detail: { axis: 'x', clientX: 120, clientY: 240 },
		}));
		await el.updateComplete;
		expect((el as any)._openAxisPopup).toBe('x');

		el.dispatchEvent(new CustomEvent('kusto-axis-title-click', {
			detail: { axis: 'y', clientX: 140, clientY: 260 },
		}));
		await el.updateComplete;
		expect((el as any)._openAxisPopup).toBe('y');
	});
});
