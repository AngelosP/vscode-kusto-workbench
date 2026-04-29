import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KwHtmlSection } from '../../src/webview/sections/kw-html-section';
import { setResultsState } from '../../src/webview/core/results-state';
import { DASHBOARD_BAR_CHART, DASHBOARD_LINE_CHART } from '../../src/shared/dashboardCharts';

interface KustoWorkbenchRuntime {
	renderChart(bindingId: string, chartSpec?: unknown): void;
	renderTable(bindingId: string, tableSpec?: unknown): void;
	_notify(data: unknown): void;
	agg(): { avg(column: string): number };
}

type BridgeSection = KwHtmlSection & { _buildDataBridgeScript(): string };

const factColumns = [
	{ name: 'Day', type: 'datetime' },
	{ name: 'OS', type: 'string' },
	{ name: 'DeviceId', type: 'string' },
	{ name: 'SessionId', type: 'string' },
	{ name: 'SkillName', type: 'string' },
	{ name: 'Bucket', type: 'long' },
	{ name: 'Code', type: 'string' },
	{ name: 'Score', type: 'real' },
	{ name: 'Healthy', type: 'long' },
	{ name: 'Warning', type: 'long' },
	{ name: 'Critical', type: 'long' },
	{ name: 'LatencyMs', type: 'real' },
	{ name: 'FailureRate', type: 'real' },
];

function htmlWithBindings(bindings: Record<string, object>): string {
	const provenance = JSON.stringify({
		version: 1,
		model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
		bindings,
	});
	return `<script type="application/kw-provenance">${provenance}</script>`;
}

function installBridge(bindings: Record<string, object>, bodyHtml: string, rows: unknown[][]): KustoWorkbenchRuntime {
	document.body.innerHTML = bodyHtml;
	setResultsState('query_fact', { columns: factColumns, rows });

	const section = new KwHtmlSection();
	section.boxId = 'html_chart_test';
	section.setCode(htmlWithBindings(bindings));

	const bridgeHtml = (section as BridgeSection)._buildDataBridgeScript();
	const match = bridgeHtml.match(/<script>([\s\S]*?)<\/script>/i);
	expect(match).not.toBeNull();
	new Function(match![1]).call(window);
	return (window as Window & typeof globalThis & { KustoWorkbench: KustoWorkbenchRuntime }).KustoWorkbench;
}

describe('KustoWorkbench.renderTable preview bridge', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		delete (window as Window & typeof globalThis & { KustoWorkbench?: KustoWorkbenchRuntime }).KustoWorkbench;
	});

	it('renders a full table with stacked cell-bar SVG cells', () => {
		const runtime = installBridge(
			{
				'status-table': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [
							{ name: 'OS', header: 'Service' },
							{
								name: 'Breakdown',
								cellBar: {
									segments: [
										{ agg: 'SUM', column: 'Healthy', color: '#2E7D32' },
										{ agg: 'SUM', column: 'Critical', color: '#C62828' },
									],
									scale: 'normalized100',
								},
							},
						],
					},
				},
			},
			'<table data-kw-bind="status-table"></table>',
			[
				['2026-04-01T00:00:00Z', 'Service <A>', 'd1', 's1', 'A', 0, 'A', 0, 2, 0, 1],
				['2026-04-01T00:00:00Z', 'Service B', 'd2', 's2', 'B', 0, 'B', 0, 1, 0, 1],
			],
		);

		runtime.renderTable('status-table');

		const table = document.querySelector('[data-kw-bind="status-table"]')!;
		expect(table.querySelectorAll('th')).toHaveLength(2);
		expect(table.textContent).toContain('Service');
		expect(table.innerHTML).toContain('Service &lt;A&gt;');
		const rects = Array.from(table.querySelectorAll('rect'));
		expect(rects).toHaveLength(4);
		expect(rects[0].getAttribute('width')).toBe('107');
		expect(rects[1].getAttribute('x')).toBe('107');
		expect(rects[1].getAttribute('width')).toBe('53');
		expect(rects[0].getAttribute('fill')).toBe('#2E7D32');
		expect(rects[1].getAttribute('fill')).toBe('#C62828');
	});

	it('renders tbody-only targets and relative cell-bar scaling', () => {
		const runtime = installBridge(
			{
				'status-table': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [
							{ name: 'OS' },
							{ name: 'Health', cellBar: { scale: 'relative', segments: [{ agg: 'SUM', column: 'Healthy', color: '#2E7D32' }] } },
						],
						orderBy: { column: 'OS', direction: 'asc' },
					},
				},
			},
			'<table><thead><tr><th>Service</th><th>Health</th></tr></thead><tbody data-kw-bind="status-table"></tbody></table>',
			[
				['2026-04-01T00:00:00Z', 'A', 'd1', 's1', 'A', 0, 'A', 0, 4, 0, 0],
				['2026-04-01T00:00:00Z', 'B', 'd2', 's2', 'B', 0, 'B', 0, 2, 0, 0],
			],
		);

		runtime.renderTable('status-table');

		const tbody = document.querySelector('tbody[data-kw-bind="status-table"]')!;
		expect(tbody.querySelectorAll('tr')).toHaveLength(2);
		expect(document.querySelectorAll('thead th')).toHaveLength(2);
		const rects = Array.from(tbody.querySelectorAll('rect'));
		expect(rects.map(rect => rect.getAttribute('width'))).toEqual(['160', '80']);
	});

	it('rerenders registered tables when filtered data is notified', () => {
		const runtime = installBridge(
			{
				'status-table': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [{ name: 'OS' }, { name: 'Rows', cellBar: { segments: [{ agg: 'COUNT' }] } }],
					},
				},
			},
			'<table data-kw-bind="status-table"></table>',
			[['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A']],
		);

		runtime.renderTable('status-table');
		expect(document.querySelector('[data-kw-bind="status-table"]')!.textContent).toContain('Linux');

		runtime._notify({
			fact: {
				columns: factColumns,
				rows: [['2026-04-01T00:00:00Z', 'Windows', 'd2', 's2', 'B']],
				totalRows: 1,
				capped: false,
			},
		});

		const text = document.querySelector('[data-kw-bind="status-table"]')!.textContent || '';
		expect(text).toContain('Windows');
		expect(text).not.toContain('Linux');
	});

	it('rejects table top without orderBy in preview', () => {
		const runtime = installBridge(
			{
				'top-table': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [{ name: 'OS' }, { name: 'Rows', agg: 'COUNT' }],
						top: 1,
					},
				},
			},
			'<table data-kw-bind="top-table"></table>',
			[
				['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A'],
				['2026-04-01T00:00:00Z', 'Windows', 'd2', 's2', 'B'],
			],
		);

		runtime.renderTable('top-table');

		expect(document.querySelector('[data-kw-bind="top-table"]')!.innerHTML).toBe('');
	});

	it('rejects plain columns that are neither grouped nor aggregated in preview', () => {
		const runtime = installBridge(
			{
				'bad-table': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [{ name: 'OS' }, { name: 'SkillName' }],
					},
				},
			},
			'<table data-kw-bind="bad-table"></table>',
			[['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A']],
		);

		runtime.renderTable('bad-table');

		expect(document.querySelector('[data-kw-bind="bad-table"]')!.innerHTML).toBe('');
	});

	it('uses group columns as deterministic top-N tie breakers in preview', () => {
		const runtime = installBridge(
			{
				'top-table': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [{ name: 'OS' }, { name: 'Rows', agg: 'COUNT' }],
						orderBy: { column: 'Rows', direction: 'desc' },
						top: 2,
					},
				},
			},
			'<table data-kw-bind="top-table"></table>',
			[
				['2026-04-01T00:00:00Z', 'C', 'd1', 's1', 'A'],
				['2026-04-01T00:00:00Z', 'A', 'd2', 's2', 'B'],
				['2026-04-01T00:00:00Z', 'B', 'd3', 's3', 'C'],
			],
		);

		runtime.renderTable('top-table');

		const cells = Array.from(document.querySelectorAll('[data-kw-bind="top-table"] tbody tr td:first-child'));
		expect(cells.map(cell => cell.textContent)).toEqual(['A', 'B']);
	});

	it('rejects table preAggregate specs without compute agg in preview', () => {
		const runtime = installBridge(
			{
				'session-depth': {
					display: {
						type: 'table',
						preAggregate: {
							groupBy: 'SessionId',
							compute: { name: 'SkillsPerSession', column: 'SkillName' },
						},
						groupBy: ['SkillsPerSession'],
						columns: [{ name: 'SkillsPerSession' }, { name: 'Sessions', agg: 'COUNT' }],
					},
				},
			},
			'<table data-kw-bind="session-depth"></table>',
			[['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A']],
		);

		runtime.renderTable('session-depth');

		expect(document.querySelector('[data-kw-bind="session-depth"]')!.innerHTML).toBe('');
	});
});

describe('KustoWorkbench.renderChart preview bridge', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		delete (window as Window & typeof globalThis & { KustoWorkbench?: KustoWorkbenchRuntime }).KustoWorkbench;
	});

	it('renders a provenance bar chart with Power BI-compatible SVG geometry', () => {
		const runtime = installBridge(
			{
				'os-chart': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT', format: '#,##0' }, top: 2 } },
			},
			'<div data-kw-bind="os-chart"></div>',
			[
				['2026-04-01T00:00:00Z', 'Windows', 'd1', 's1', 'A'],
				['2026-04-01T00:00:00Z', 'Linux', 'd2', 's2', 'B'],
				['2026-04-01T00:00:00Z', 'Linux', 'd3', 's3', 'C'],
			],
		);

		runtime.renderChart('os-chart');

		const svg = document.querySelector('[data-kw-bind="os-chart"] svg') as SVGElement | null;
		expect(svg).not.toBeNull();
		expect(svg!.getAttribute('viewBox')).toBe(`0 0 ${DASHBOARD_BAR_CHART.totalW} ${DASHBOARD_BAR_CHART.minH}`);
		expect(svg!.getAttribute('style')).toContain(`height:${DASHBOARD_BAR_CHART.minH}px`);
		expect(svg!.textContent).toContain('Linux');
		expect(svg!.textContent).toContain('2');
	});

	it('rerenders registered charts when filtered data is notified', () => {
		const runtime = installBridge(
			{
				'os-chart': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' } } },
			},
			'<div data-kw-bind="os-chart"></div>',
			[
				['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A'],
				['2026-04-01T00:00:00Z', 'Linux', 'd2', 's2', 'B'],
				['2026-04-01T00:00:00Z', 'Windows', 'd3', 's3', 'C'],
			],
		);

		runtime.renderChart('os-chart');
		expect(document.querySelector('[data-kw-bind="os-chart"]')!.textContent).toContain('Linux');

		runtime._notify({
			fact: {
				columns: factColumns,
				rows: [['2026-04-01T00:00:00Z', 'Windows', 'd3', 's3', 'C']],
				totalRows: 1,
				capped: false,
			},
		});

		const text = document.querySelector('[data-kw-bind="os-chart"]')!.textContent || '';
		expect(text).toContain('Windows');
		expect(text).not.toContain('Linux');
	});

	it('uses Power BI DAX color fallback after the tenth bar segment', () => {
		const rows = Array.from({ length: 11 }, (_, index) => [
			'2026-04-01T00:00:00Z',
			`C${String(index).padStart(2, '0')}`,
			`d${index}`,
			`s${index}`,
			'A',
		]);
		const runtime = installBridge(
			{
				'os-chart': {
					display: {
						type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' },
						colors: ['#111111', '#222222', '#333333'],
					},
				},
			},
			'<div data-kw-bind="os-chart"></div>',
			rows,
		);

		runtime.renderChart('os-chart');

		const rects = Array.from(document.querySelectorAll('[data-kw-bind="os-chart"] rect'));
		expect(rects).toHaveLength(11);
		expect(rects[10].getAttribute('fill')).toBe('#111111');
	});

	it('renders normalized distribution bar segments as full-width compact rows', () => {
		const runtime = installBridge(
			{
				'status-chart': {
					display: {
						type: 'bar', groupBy: 'OS',
						segments: [
							{ agg: 'SUM', column: 'Healthy', color: '#2E7D32' },
							{ agg: 'SUM', column: 'Critical', color: '#C62828' },
						],
						scale: 'normalized100',
						variant: 'distribution',
						showCategoryLabels: false,
						showValueLabels: false,
					},
				},
			},
			'<div data-kw-bind="status-chart"></div>',
			[
				['2026-04-01T00:00:00Z', 'Service A', 'd1', 's1', 'A', 0, 'A', 0, 2, 0, 1],
				['2026-04-01T00:00:00Z', 'Service B', 'd2', 's2', 'B', 0, 'B', 0, 1, 0, 1],
			],
		);

		runtime.renderChart('status-chart');

		const rects = Array.from(document.querySelectorAll('[data-kw-bind="status-chart"] rect'));
		expect(rects).toHaveLength(4);
		expect(rects[0].getAttribute('rx')).toBe('0');
		expect(rects[0].getAttribute('height')).toBe('8');
		expect(rects[0].getAttribute('width')).toBe('507');
		expect(rects[1].getAttribute('x')).toBe('507');
		expect(rects[1].getAttribute('width')).toBe('253');
		expect(rects[0].getAttribute('fill')).toBe('#2E7D32');
		expect(rects[1].getAttribute('fill')).toBe('#C62828');
		expect((document.querySelector('[data-kw-bind="status-chart"]')!.textContent || '').trim()).toBe('');
	});

	it('splits a bar value across fixed threshold bands', () => {
		const runtime = installBridge(
			{
				'latency-chart': {
					display: {
						type: 'bar', groupBy: 'OS',
						value: { agg: 'AVG', column: 'LatencyMs', format: '#,##0 ms' },
						thresholdBands: {
							scaleMax: 100,
							bands: [
								{ min: 0, max: 50, color: '#2E7D32' },
								{ min: 50, max: 100, color: '#C62828' },
							],
						},
					},
				},
			},
			'<div data-kw-bind="latency-chart"></div>',
			[['2026-04-01T00:00:00Z', 'Service A', 'd1', 's1', 'A', 0, 'A', 0, 0, 0, 0, 75]],
		);

		runtime.renderChart('latency-chart');

		const rects = Array.from(document.querySelectorAll('[data-kw-bind="latency-chart"] rect'));
		expect(rects.map(rect => rect.getAttribute('width'))).toEqual(['230', '115']);
		expect(rects.map(rect => rect.getAttribute('fill'))).toEqual(['#2E7D32', '#C62828']);
		const label = document.querySelector('[data-kw-bind="latency-chart"] text');
		expect(label!.getAttribute('y')).toBe('24');
		expect(document.querySelector('[data-kw-bind="latency-chart"]')!.textContent).toContain('75 ms');
	});

	it('colors a whole bar by first matching color rule', () => {
		const runtime = installBridge(
			{
				'failure-chart': {
					display: {
						type: 'bar', groupBy: 'OS',
						value: { agg: 'AVG', column: 'FailureRate', format: '0.0%' },
						colorRules: [
							{ operator: '>=', value: 0.1, color: '#C62828' },
							{ operator: '<', value: 0.1, color: '#2E7D32' },
						],
					},
				},
			},
			'<div data-kw-bind="failure-chart"></div>',
			[['2026-04-01T00:00:00Z', 'Service A', 'd1', 's1', 'A', 0, 'A', 0, 0, 0, 0, 0, 0.12]],
		);

		runtime.renderChart('failure-chart');

		const rect = document.querySelector('[data-kw-bind="failure-chart"] rect');
		expect(rect).not.toBeNull();
		expect(rect!.getAttribute('fill')).toBe('#C62828');
	});

	it('formats pie legend percentages with DAX percent semantics', () => {
		const runtime = installBridge(
			{
				'os-pie': { display: { type: 'pie', groupBy: 'OS', value: { agg: 'COUNT' } } },
			},
			'<div data-kw-bind="os-pie"></div>',
			[
				['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A'],
				['2026-04-01T00:00:00Z', 'Windows', 'd2', 's2', 'B'],
				['2026-04-01T00:00:00Z', 'Windows', 'd3', 's3', 'C'],
			],
		);

		runtime.renderChart('os-pie');

		const text = document.querySelector('[data-kw-bind="os-pie"]')!.textContent || '';
		expect(text).toContain('66.7%');
		expect(text).toContain('33.3%');
		expect(text).not.toContain('0.7%');
	});

	it('uses raw numeric group values for bar top-N tie ordering', () => {
		const runtime = installBridge(
			{
				'bucket-chart': { display: { type: 'bar', groupBy: 'Bucket', value: { agg: 'COUNT' }, top: 2 } },
			},
			'<div data-kw-bind="bucket-chart"></div>',
			[
				['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A', 100],
				['2026-04-01T00:00:00Z', 'Linux', 'd2', 's2', 'B', 2],
				['2026-04-01T00:00:00Z', 'Linux', 'd3', 's3', 'C', 20],
			],
		);

		runtime.renderChart('bucket-chart');

		const text = document.querySelector('[data-kw-bind="bucket-chart"]')!.textContent || '';
		expect(text).toContain('2');
		expect(text).toContain('20');
		expect(text).not.toContain('100');
	});

	it('keeps string-like category tie ordering string-based', () => {
		const runtime = installBridge(
			{
				'code-chart': { display: { type: 'bar', groupBy: 'Code', value: { agg: 'COUNT' }, top: 2 } },
			},
			'<div data-kw-bind="code-chart"></div>',
			[
				['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A', 1, '2'],
				['2026-04-01T00:00:00Z', 'Linux', 'd2', 's2', 'B', 2, '10'],
				['2026-04-01T00:00:00Z', 'Linux', 'd3', 's3', 'C', 3, '1'],
			],
		);

		runtime.renderChart('code-chart');

		const text = document.querySelector('[data-kw-bind="code-chart"]')!.textContent || '';
		expect(text).toContain('1');
		expect(text).toContain('10');
		expect(text).not.toContain('2');
	});

	it('prefers provenance display specs over caller-supplied chart specs', () => {
		const runtime = installBridge(
			{
				'os-chart': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' } } },
			},
			'<div data-kw-bind="os-chart"></div>',
			[['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A']],
		);

		runtime.renderChart('os-chart', { type: 'pie', groupBy: 'OS', value: { agg: 'COUNT' } });

		expect(document.querySelector('[data-kw-bind="os-chart"] rect')).not.toBeNull();
		expect(document.querySelector('[data-kw-bind="os-chart"] circle')).toBeNull();
	});

	it('does not render caller-supplied chart specs without provenance', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const runtime = installBridge(
			{},
			'<div data-kw-bind="adhoc-chart"></div>',
			[['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A']],
		);

		runtime.renderChart('adhoc-chart', { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' } });

		expect(warnSpy).toHaveBeenCalled();
		expect(document.querySelector('[data-kw-bind="adhoc-chart"] svg')).toBeNull();
		expect(document.querySelector('[data-kw-bind="adhoc-chart"]')!.innerHTML).toBe('');
		warnSpy.mockRestore();
	});

	it('ignores malformed chart specs in preview', () => {
		const runtime = installBridge(
			{
				'trend': { display: { type: 'line', xAxis: 'Day' } },
			},
			'<div data-kw-bind="trend"></div>',
			[['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A']],
		);

		runtime.renderChart('trend');

		expect(document.querySelector('[data-kw-bind="trend"] svg')).toBeNull();
		expect(document.querySelector('[data-kw-bind="trend"]')!.innerHTML).toBe('');
	});

	it('ignores chart specs with invalid shared options in preview', () => {
		const runtime = installBridge(
			{
				'bad-top': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' }, top: -1 } },
				'bad-colors': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' }, colors: '#ff0000' } },
				'bad-palette': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' }, colors: ['#2E7D32', 'bad"color'] } },
				'bad-format': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT', format: {} } } },
				'bad-column': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT', column: 123 } } },
				'bad-normalized-value': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' }, scale: 'normalized100' } },
				'bad-segment-value': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' }, segments: [{ agg: 'SUM', column: 'Healthy' }] } },
				'bad-threshold-scale': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' }, scale: 'normalized100', thresholdBands: { bands: [{ min: 0, max: 1 }] } } },
				'bad-label': { display: { type: 'line', xAxis: 'Day', series: [{ agg: 'COUNT', label: 123 }] } },
				'bad-preagg': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' }, preAggregate: { groupBy: 'OS', compute: { name: 'Total', agg: 'SUM' } } } },
			},
			'<div data-kw-bind="bad-top"></div><div data-kw-bind="bad-colors"></div><div data-kw-bind="bad-palette"></div><div data-kw-bind="bad-format"></div><div data-kw-bind="bad-column"></div><div data-kw-bind="bad-normalized-value"></div><div data-kw-bind="bad-segment-value"></div><div data-kw-bind="bad-threshold-scale"></div><div data-kw-bind="bad-label"></div><div data-kw-bind="bad-preagg"></div>',
			[['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A']],
		);

		runtime.renderChart('bad-top');
		runtime.renderChart('bad-colors');
		runtime.renderChart('bad-palette');
		runtime.renderChart('bad-format');
		runtime.renderChart('bad-column');
		runtime.renderChart('bad-normalized-value');
		runtime.renderChart('bad-segment-value');
		runtime.renderChart('bad-threshold-scale');
		runtime.renderChart('bad-label');
		runtime.renderChart('bad-preagg');

		expect(document.querySelector('[data-kw-bind="bad-top"] svg')).toBeNull();
		expect(document.querySelector('[data-kw-bind="bad-colors"] svg')).toBeNull();
		expect(document.querySelector('[data-kw-bind="bad-palette"] svg')).toBeNull();
		expect(document.querySelector('[data-kw-bind="bad-format"] svg')).toBeNull();
		expect(document.querySelector('[data-kw-bind="bad-column"] svg')).toBeNull();
		expect(document.querySelector('[data-kw-bind="bad-normalized-value"] svg')).toBeNull();
		expect(document.querySelector('[data-kw-bind="bad-segment-value"] svg')).toBeNull();
		expect(document.querySelector('[data-kw-bind="bad-threshold-scale"] svg')).toBeNull();
		expect(document.querySelector('[data-kw-bind="bad-label"] svg')).toBeNull();
		expect(document.querySelector('[data-kw-bind="bad-preagg"] svg')).toBeNull();
	});

	it('ignores null values for AVG chart aggregations', () => {
		const runtime = installBridge(
			{
				'avg-chart': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'AVG', column: 'Score', format: '#,##0' } } },
			},
			'<div data-kw-bind="avg-chart"></div>',
			[
				['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A', 1, 'A', 10],
				['2026-04-01T00:00:00Z', 'Linux', 'd2', 's2', 'B', 2, 'B', null],
				['2026-04-01T00:00:00Z', 'Linux', 'd3', 's3', 'C', 3, 'C', ''],
				['2026-04-01T00:00:00Z', 'Linux', 'd4', 's4', 'D', 4, 'D', 'n/a'],
				['2026-04-01T00:00:00Z', 'Linux', 'd5', 's5', 'E', 5, 'E', false],
			],
		);

		expect(runtime.agg().avg('Score')).toBe(10);
		runtime.renderChart('avg-chart');

		const text = document.querySelector('[data-kw-bind="avg-chart"]')!.textContent || '';
		expect(text).toContain('10');
		expect(text).not.toContain('5');
	});

	it('preserves simple prefix and suffix chart value formats', () => {
		const runtime = installBridge(
			{
				'currency-chart': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'SUM', column: 'Score', format: '$#,##0' } } },
				'unit-chart': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'SUM', column: 'Score', format: '#,##0 ms' } } },
			},
			'<div data-kw-bind="currency-chart"></div><div data-kw-bind="unit-chart"></div>',
			[['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A', 1, 'A', 1234]],
		);

		runtime.renderChart('currency-chart');
		runtime.renderChart('unit-chart');

		expect(document.querySelector('[data-kw-bind="currency-chart"]')!.textContent).toContain('$1,234');
		expect(document.querySelector('[data-kw-bind="unit-chart"]')!.textContent).toContain('1,234 ms');
	});

	it('clamps negative bar geometry to zero while preserving labels', () => {
		const runtime = installBridge(
			{
				'negative-chart': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'SUM', column: 'Score', format: '#,##0' } } },
			},
			'<div data-kw-bind="negative-chart"></div>',
			[
				['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A', 1, 'A', -10],
				['2026-04-01T00:00:00Z', 'Windows', 'd2', 's2', 'B', 2, 'B', -5],
			],
		);

		runtime.renderChart('negative-chart');

		const rects = Array.from(document.querySelectorAll('[data-kw-bind="negative-chart"] rect'));
		expect(rects.map(rect => rect.getAttribute('width'))).toEqual(['0', '0']);
		expect(document.querySelector('[data-kw-bind="negative-chart"]')!.textContent).toContain('-5');
	});

	it('formats datetime bar category labels like export', () => {
		const runtime = installBridge(
			{
				'day-chart': { display: { type: 'bar', groupBy: 'Day', value: { agg: 'COUNT' } } },
			},
			'<div data-kw-bind="day-chart"></div>',
			[
				['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A'],
				['2026-04-02T00:00:00Z', 'Windows', 'd2', 's2', 'B'],
			],
		);

		runtime.renderChart('day-chart');

		const text = document.querySelector('[data-kw-bind="day-chart"]')!.textContent || '';
		expect(text).toContain('2026-04-01');
		expect(text).toContain('2026-04-02');
		expect(text).not.toContain('00:00:00');
	});

	it('renders line charts with the shared exported SVG dimensions and legend labels', () => {
		const runtime = installBridge(
			{
				'trend': { display: { type: 'line', xAxis: 'Day', series: [{ agg: 'COUNT', label: 'Sessions' }] } },
			},
			'<div data-kw-bind="trend"></div>',
			[
				['2026-04-02T00:00:00Z', 'Linux', 'd1', 's1', 'A'],
				['2026-04-01T00:00:00Z', 'Windows', 'd2', 's2', 'B'],
			],
		);

		runtime.renderChart('trend');

		const svg = document.querySelector('[data-kw-bind="trend"] svg') as SVGElement | null;
		expect(svg).not.toBeNull();
		expect(svg!.getAttribute('viewBox')).toBe(`0 0 ${DASHBOARD_LINE_CHART.W} ${DASHBOARD_LINE_CHART.H}`);
		expect(svg!.textContent).toContain('Sessions');
		expect(svg!.textContent).toContain('2026-04-01');
		expect(svg!.textContent).toContain('2026-04-02');
		const plotBottom = DASHBOARD_LINE_CHART.padT + (DASHBOARD_LINE_CHART.H - DASHBOARD_LINE_CHART.padT - DASHBOARD_LINE_CHART.padB);
		const legendText = Array.from(svg!.querySelectorAll('text')).find(element => element.textContent === 'Sessions');
		expect(legendText).not.toBeUndefined();
		expect(Number(legendText!.getAttribute('y'))).toBeGreaterThan(plotBottom);
	});

	it('uses modulo color selection for line series beyond ten', () => {
		const colors = [
			'#010101', '#020202', '#030303', '#040404', '#050505', '#060606',
			'#070707', '#080808', '#090909', '#101010', '#111111',
		];
		const runtime = installBridge(
			{
				'trend': {
					display: {
						type: 'line',
						xAxis: 'Day',
						series: colors.map((_, index) => ({ agg: 'COUNT', label: `Series ${index + 1}` })),
						colors,
					},
				},
			},
			'<div data-kw-bind="trend"></div>',
			[['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A']],
		);

		runtime.renderChart('trend');

		const polylines = Array.from(document.querySelectorAll('[data-kw-bind="trend"] polyline'));
		expect(polylines).toHaveLength(11);
		expect(polylines[10].getAttribute('stroke')).toBe('#111111');
	});

	it('emits a visible marker for single-point line charts', () => {
		const runtime = installBridge(
			{
				'trend': { display: { type: 'line', xAxis: 'Day', series: [{ agg: 'COUNT', label: 'Sessions' }] } },
			},
			'<div data-kw-bind="trend"></div>',
			[['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A']],
		);

		runtime.renderChart('trend');

		const marker = document.querySelector('[data-kw-bind="trend"] circle');
		expect(marker).not.toBeNull();
		expect(marker!.getAttribute('r')).toBe('3.5');
		expect(marker!.getAttribute('cx')).toBe(String(DASHBOARD_LINE_CHART.padL + (DASHBOARD_LINE_CHART.W - DASHBOARD_LINE_CHART.padL - DASHBOARD_LINE_CHART.padR) / 2) + '.0');
		expect(marker!.getAttribute('cy')).toBe(String(DASHBOARD_LINE_CHART.padT + (DASHBOARD_LINE_CHART.H - DASHBOARD_LINE_CHART.padT - DASHBOARD_LINE_CHART.padB) / 2) + '.0');
	});

	it('applies preAggregate before chart grouping in preview', () => {
		const runtime = installBridge(
			{
				'session-depth': {
					display: {
						type: 'bar',
						preAggregate: {
							groupBy: 'SessionId',
							compute: { name: 'SkillsPerSession', agg: 'DISTINCTCOUNT', column: 'SkillName' },
						},
						groupBy: 'SkillsPerSession',
						value: { agg: 'COUNT' },
					},
				},
			},
			'<div data-kw-bind="session-depth"></div>',
			[
				['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'A'],
				['2026-04-01T00:00:00Z', 'Linux', 'd1', 's1', 'B'],
				['2026-04-01T00:00:00Z', 'Windows', 'd2', 's2', 'A'],
			],
		);

		runtime.renderChart('session-depth');

		const text = document.querySelector('[data-kw-bind="session-depth"]')!.textContent || '';
		expect(text).toContain('2');
		expect(text).toContain('1');
	});
});
