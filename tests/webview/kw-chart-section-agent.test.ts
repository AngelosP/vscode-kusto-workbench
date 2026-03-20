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
vi.mock('../../src/webview/modules/extraBoxes.js', () => ({
	__kustoGetChartDatasetsInDomOrder: () => fakeDatasets,
	__kustoGetChartValidationStatus: () => null,
}));

vi.mock('../../src/webview/modules/extraBoxes-chart.js', () => ({
	__kustoMaximizeChartBox: vi.fn(),
	__kustoDisposeChartEcharts: vi.fn(),
	__kustoRenderChart: vi.fn(),
}));

vi.mock('../../src/webview/modules/persistence.js', () => ({
	schedulePersist: vi.fn(),
}));

import '../../src/webview/sections/kw-chart-section.js';
import type { KwChartSection } from '../../src/webview/sections/kw-chart-section.js';

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
});
