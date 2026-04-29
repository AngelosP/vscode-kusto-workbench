import { describe, it, expect } from 'vitest';
import {
	generateHtmlMeasureTmdl,
	generateHtmlContentVisualJson,
	generateSlicerVisualJson,
	generateDimTableTmdl,
	escapeDaxString,
	escapeDaxColumnRef,
	daxColumnExpr,
	findUnsupportedPowerBiBindings,
	getPowerBiHtmlValidationIssues,
	validatePowerBiHtmlBindings,
	generateDaxMeasure,
	generateTableTmdl,
	resolveFactTableSlicers,
	resolveCssVariables,
	patchCssForPbiVisual,
	type PowerBiDataSource,
} from '../../../src/host/powerBiExport';
import {
	DASHBOARD_BAR_CHART,
	DASHBOARD_LINE_CHART,
	DASHBOARD_PIE_CHART,
	SUPPORTED_POWER_BI_DISPLAY_TYPES,
	isValidDashboardChartDisplay,
} from '../../../src/shared/dashboardCharts';
import { isValidRepeatedTableDisplay, isValidTableDisplay } from '../../../src/shared/dashboardTables';
import { parseKwProvenance } from '../../../src/webview/sections/kw-html-section';

// ── Provenance v1 parsing ───────────────────────────────────────────────────

describe('parseKwProvenance', () => {
	it('extracts model and bindings from a valid v1 provenance block', () => {
		const html = `
			<script type="application/kw-provenance">
			{
				"version": 1,
				"model": {
					"fact": { "sectionId": "query_123", "sectionName": "Events" },
					"dimensions": [{ "column": "OS", "label": "Operating System" }]
				},
				"bindings": {
					"total": { "display": { "type": "scalar", "agg": "COUNT", "format": "#,##0" } }
				}
			}
			</script>
		`;
		const p = parseKwProvenance(html);
		expect(p).not.toBeNull();
		expect(p!.version).toBe(1);
		expect(p!.model.fact.sectionId).toBe('query_123');
		expect(p!.model.fact.sectionName).toBe('Events');
		expect(p!.model.dimensions).toHaveLength(1);
		expect(p!.model.dimensions![0].column).toBe('OS');
		expect(Object.keys(p!.bindings)).toHaveLength(1);
	});

	it('returns null when no provenance block exists', () => {
		expect(parseKwProvenance('<div>No provenance</div>')).toBeNull();
	});

	it('returns null for invalid JSON', () => {
		const html = '<script type="application/kw-provenance">{broken json</script>';
		expect(parseKwProvenance(html)).toBeNull();
	});

	it('returns null when model.fact.sectionId is missing', () => {
		const html = '<script type="application/kw-provenance">{"version":1,"model":{},"bindings":{}}</script>';
		expect(parseKwProvenance(html)).toBeNull();
	});

	it('handles provenance with no dimensions', () => {
		const html = `<script type="application/kw-provenance">
		{"version":1,"model":{"fact":{"sectionId":"q1","sectionName":"F"}},"bindings":{"x":{"display":{"type":"scalar","agg":"COUNT"}}}}
		</script>`;
		const p = parseKwProvenance(html);
		expect(p).not.toBeNull();
		expect(p!.model.dimensions).toBeUndefined();
	});

	it('handles multiple dimensions', () => {
		const html = `<script type="application/kw-provenance">
		{"version":1,"model":{"fact":{"sectionId":"q1","sectionName":"F"},"dimensions":[{"column":"A"},{"column":"B","mode":"between"},{"column":"C","label":"Country"}]},"bindings":{}}
		</script>`;
		const p = parseKwProvenance(html);
		expect(p!.model.dimensions).toHaveLength(3);
		expect(p!.model.dimensions![1].mode).toBe('between');
		expect(p!.model.dimensions![2].label).toBe('Country');
	});
});

describe('findUnsupportedPowerBiBindings', () => {
	it('keeps the documented Power BI display support list explicit', () => {
		expect(SUPPORTED_POWER_BI_DISPLAY_TYPES).toEqual(['scalar', 'table', 'repeatedTable', 'pivot', 'bar', 'pie', 'line']);
	});

	it('reports provenance display types that cannot be rendered during Power BI export', () => {
		const html = makeV1Html(
			{
				'trend': { display: { type: 'line', xAxis: 'Day', series: [{ agg: 'COUNT' }] } },
				'heat': { display: { type: 'heatmap', xColumn: 'Day', valueColumn: 'Actions' } },
				'points': { display: { type: 'scatter', xColumn: 'Actions', yColumns: ['Devices'] } },
			},
			'<div data-kw-bind="trend"></div><div data-kw-bind="heat"></div><div data-kw-bind="points"></div>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual(['heat (heatmap)', 'points (scatter)']);
	});

	it('ignores unsupported provenance bindings without matching data-kw-bind targets', () => {
		const html = makeV1Html(
			{
				'total': { display: { type: 'scalar', agg: 'COUNT' } },
				'unused-heatmap': { display: { type: 'heatmap', xColumn: 'Day', valueColumn: 'SkillName' } },
			},
			'<span data-kw-bind="total"></span>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual([]);
	});

	it('ignores data-kw-bind text that appears only inside script content', () => {
		const html = makeV1Html(
			{
				'total': { display: { type: 'scalar', agg: 'COUNT' } },
				'heat': { display: { type: 'heatmap', xColumn: 'Day', valueColumn: 'SkillName' } },
			},
			'<span data-kw-bind="total"></span><script>document.querySelector(\'[data-kw-bind="heat"]\')</script>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual([]);
	});

	it('does not let commented script-like text hide rendered unsupported bindings', () => {
		const html = makeV1Html(
			{
				'heat': { display: { type: 'heatmap', xColumn: 'Day', valueColumn: 'SkillName' } },
			},
			'<!-- <script>unterminated-looking comment</script> --><div data-kw-bind="heat"></div>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual(['heat (heatmap)']);
	});

	it('does not let comment-like script text hide rendered unsupported bindings', () => {
		const html = makeV1Html(
			{
				'heat': { display: { type: 'heatmap', xColumn: 'Day', valueColumn: 'SkillName' } },
			},
			'<script>const marker = "<!--";</script><div data-kw-bind="heat"></div><!-- close -->',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual(['heat (heatmap)']);
	});

	it('ignores data-kw-bind markup inside template content', () => {
		const html = makeV1Html(
			{
				'heat': { display: { type: 'heatmap', xColumn: 'Day', valueColumn: 'SkillName' } },
			},
			'<template><div data-kw-bind="heat"></div></template>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual([]);
	});

	it('ignores data-kw-bind markup inside noscript content', () => {
		const html = makeV1Html(
			{
				'heat': { display: { type: 'heatmap', xColumn: 'Day', valueColumn: 'SkillName' } },
			},
			'<noscript><div data-kw-bind="heat"></div></noscript>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual([]);
	});

	it('reports malformed rendered chart specs before export', () => {
		const html = makeV1Html(
			{
				'trend': { display: { type: 'line', xAxis: 'Day' } },
			},
			'<div data-kw-bind="trend"></div>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual(['trend (line: invalid chart spec)']);
		expect(() => generateDaxMeasure(html, [factDataSource])).not.toThrow();
	});

	it('reports invalid top values before export', () => {
		const html = makeV1Html(
			{
				'os-chart': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' }, top: -1 } },
			},
			'<div data-kw-bind="os-chart"></div>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual(['os-chart (bar: invalid chart spec)']);
	});

	it('reports invalid table top values before export', () => {
		const html = makeV1Html(
			{
				'top-table': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [{ name: 'OS' }, { name: 'Sessions', agg: 'COUNT' }],
						orderBy: { column: 'Sessions', direction: 'desc' },
						top: -1,
					},
				},
			},
			'<table data-kw-bind="top-table"></table>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual(['top-table (table: invalid top)']);
		expect(generateDaxMeasure(html, [factDataSource])).not.toContain('[Idx] <= -1');
	});

	it('reports table top without orderBy before export', () => {
		const html = makeV1Html(
			{
				'top-table': {
					display: {
						type: 'table',
						groupBy: ['SkillName'],
						columns: [{ name: 'SkillName' }, { name: 'Refs', agg: 'COUNT' }],
						top: 5,
					},
				},
			},
			'<table data-kw-bind="top-table"></table>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual(['top-table (table: invalid top)']);
	});

	it('reports repeated table top without repeatOrderBy before export', () => {
		const html = makeV1Html(
			{
				'by-skill': {
					display: {
						type: 'repeatedTable',
						repeatBy: ['SkillName'],
						repeatTop: 5,
						table: {
							groupBy: ['ClientName'],
							columns: [{ name: 'ClientName' }, { name: 'Rows', agg: 'COUNT' }],
						},
					},
				},
			},
			'<div data-kw-bind="by-skill"></div>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual(['by-skill (repeatedTable: invalid repeatTop)']);
	});

	it('requires repeated table bindings to target a non-table container', () => {
		const html = makeV1Html(
			{
				'by-skill': {
					display: {
						type: 'repeatedTable',
						repeatBy: ['SkillName'],
						table: {
							groupBy: ['ClientName'],
							columns: [{ name: 'ClientName' }, { name: 'Rows', agg: 'COUNT' }],
						},
					},
				},
			},
			'<table data-kw-bind="by-skill"></table>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual(['by-skill (repeatedTable: target must be a visible non-table container element)']);
	});

	it('rejects repeated table bindings when any duplicate target is not a visible non-table container', () => {
		const html = makeV1Html(
			{
				'by-skill': {
					display: {
						type: 'repeatedTable',
						repeatBy: ['SkillName'],
						table: {
							groupBy: ['ClientName'],
							columns: [{ name: 'ClientName' }, { name: 'Rows', agg: 'COUNT' }],
						},
					},
				},
			},
			'<table data-kw-bind="by-skill"></table><div data-kw-bind="by-skill"></div>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual(['by-skill (repeatedTable: target must be a visible non-table container element)']);
	});

	it('reports invalid optional chart fields before export', () => {
		const html = makeV1Html(
			{
				'os-chart': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT', column: 123 } } },
			},
			'<div data-kw-bind="os-chart"></div>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual(['os-chart (bar: invalid chart spec)']);
	});

	it('reports rendered targets missing provenance or display metadata', () => {
		const missingBindingHtml = makeV1Html({}, '<span data-kw-bind="missing"></span>');
		const missingDisplayHtml = makeV1Html({ 'total': {} }, '<span data-kw-bind="total"></span>');
		const missingTypeHtml = makeV1Html({ 'total': { display: { agg: 'COUNT' } } }, '<span data-kw-bind="total"></span>');

		expect(findUnsupportedPowerBiBindings(missingBindingHtml)).toEqual(['missing (missing provenance binding)']);
		expect(findUnsupportedPowerBiBindings(missingDisplayHtml)).toEqual(['total (missing display)']);
		expect(findUnsupportedPowerBiBindings(missingTypeHtml)).toEqual(['total (missing display type)']);
	});

	it('reports table bindings rendered on non-table targets', () => {
		const html = makeV1Html(
			{
				'top-table': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [{ name: 'OS' }, { name: 'Sessions', agg: 'COUNT' }],
					},
				},
			},
			'<div data-kw-bind="top-table"></div>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual(['top-table (table: target must be table or tbody inside table)']);
	});

	it('reports bindings rendered only on hidden targets', () => {
		const html = makeV1Html(
			{
				'top-table': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [{ name: 'OS' }, { name: 'Sessions', agg: 'COUNT' }],
					},
				},
			},
			'<table class="pbi-hidden" data-kw-bind="top-table"></table>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual([
			'top-table (table: target is hidden; bind exportable content to a visible data-kw-bind element)',
		]);
	});

	it('reports standalone tbody table targets before export', () => {
		const html = makeV1Html(
			{
				'top-table': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [{ name: 'OS' }, { name: 'Sessions', agg: 'COUNT' }],
					},
				},
			},
			'<tbody data-kw-bind="top-table"></tbody>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual(['top-table (table: target must be table or tbody inside table)']);
	});

	it('reports scalar and chart bindings rendered on void elements', () => {
		const html = makeV1Html(
			{
				'total': { display: { type: 'scalar', agg: 'COUNT' } },
				'os-chart': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' } } },
			},
			'<input data-kw-bind="total"><img data-kw-bind="os-chart">',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual([
			'total (scalar: target must be container element)',
			'os-chart (bar: target must be container element)',
		]);
	});

	it('reports bindings that reference columns missing from the fact data source', () => {
		const html = makeV1Html(
			{
				'os-chart': { display: { type: 'bar', groupBy: 'OS', value: { agg: 'SUM', column: 'Actions' } } },
			},
			'<div data-kw-bind="os-chart"></div>',
		);

		expect(getPowerBiHtmlValidationIssues(html, [factDataSource])).toEqual([
			'os-chart (groupBy: missing column OS)',
			'os-chart (value.column: missing column Actions)',
		]);
		expect(() => validatePowerBiHtmlBindings(html, [factDataSource])).toThrow(/missing column OS/);
		expect(() => validatePowerBiHtmlBindings(html, [factDataSource])).toThrow(/missing column Actions/);
	});

	it('reports missing columns referenced by segmented bar specs', () => {
		const html = makeV1Html(
			{
				'status-chart': {
					display: {
						type: 'bar', groupBy: 'OS',
						segments: [
							{ agg: 'SUM', column: 'Healthy' },
							{ agg: 'SUM', column: 'MissingStatus' },
						],
					},
				},
			},
			'<div data-kw-bind="status-chart"></div>',
		);

		expect(getPowerBiHtmlValidationIssues(html, [barDataSource])).toEqual([
			'status-chart (segments[1].column: missing column MissingStatus)',
		]);
	});

	it('reports missing columns referenced by table cell-bar segments', () => {
		const html = makeV1Html(
			{
				'status-table': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [
							{ name: 'OS' },
							{
								name: 'Breakdown',
								cellBar: {
									segments: [
										{ agg: 'SUM', column: 'Healthy' },
										{ agg: 'SUM', column: 'MissingStatus' },
									],
								},
							},
						],
					},
				},
			},
			'<table data-kw-bind="status-table"></table>',
		);

		expect(getPowerBiHtmlValidationIssues(html, [barDataSource])).toEqual([
			'status-table (columns[1].cellBar.segments[1].column: missing column MissingStatus)',
		]);
	});

	it('reports missing and non-numeric columns referenced by table cell formatting', () => {
		const html = makeV1Html(
			{
				'format-table': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [
							{ name: 'OS' },
							{ name: 'Rows', agg: 'COUNT', cellFormat: { valueColumn: 'MissingValue', rules: [{ operator: '>', value: 1, backgroundColor: '#E7F3E7' }] } },
						],
					},
				},
				'group-format': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [
							{ name: 'OS', cellFormat: { rules: [{ operator: '=', value: 1, backgroundColor: '#E7F3E7' }] } },
							{ name: 'Rows', agg: 'COUNT' },
						],
					},
				},
			},
			'<table data-kw-bind="format-table"></table><table data-kw-bind="group-format"></table>',
		);

		expect(getPowerBiHtmlValidationIssues(html, [barDataSource])).toEqual([
			'format-table (table: invalid spec)',
			'group-format (columns[0].cellFormat.valueColumn: non-numeric column OS)',
		]);
	});

	it('reports missing columns referenced by repeated table specs', () => {
		const html = makeV1Html(
			{
				'by-skill': {
					display: {
						type: 'repeatedTable',
						repeatBy: ['SkillName'],
						repeatColumns: [
							{ name: 'SkillName' },
							{ name: 'MissingTotal', agg: 'SUM', sourceColumn: 'MissingTotal' },
						],
						table: {
							groupBy: ['ClientName'],
							columns: [{ name: 'ClientName' }, { name: 'MissingRows', agg: 'SUM', sourceColumn: 'MissingRows' }],
						},
					},
				},
			},
			'<div data-kw-bind="by-skill"></div>',
		);

		expect(getPowerBiHtmlValidationIssues(html, [factDataSource])).toEqual([
			'by-skill (repeatColumns[1].column: missing column MissingTotal)',
			'by-skill (table.columns[1].column: missing column MissingRows)',
		]);
	});

	it('rejects malformed table cell-bar specs, visual-only sort columns, and plain non-group columns', () => {
		const html = makeV1Html(
			{
				'bad-cellbar': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [
							{ name: 'OS' },
							{ name: 'Breakdown', cellBar: { segments: [] } },
						],
					},
				},
				'bad-sort': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [
							{ name: 'OS' },
							{ name: 'Breakdown', cellBar: { segments: [{ agg: 'COUNT' }] } },
						],
						orderBy: { column: 'Breakdown' },
					},
				},
				'bad-plain-column': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [
							{ name: 'OS' },
							{ name: 'SkillName' },
						],
					},
				},
				'bad-reserved-column': {
					display: {
						type: 'table',
						groupBy: ['__kw_table_idx_0'],
						columns: [{ name: '__kw_table_idx_0' }],
					},
				},
			},
			'<table data-kw-bind="bad-cellbar"></table><table data-kw-bind="bad-sort"></table><table data-kw-bind="bad-plain-column"></table><table data-kw-bind="bad-reserved-column"></table>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual([
			'bad-cellbar (table: invalid spec)',
			'bad-sort (table: invalid spec)',
			'bad-plain-column (table: invalid spec)',
			'bad-reserved-column (table: invalid spec)',
		]);
	});

	it('accepts COUNT table cell-bar segments without source columns', () => {
		const html = makeV1Html(
			{
				'status-table': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [
							{ name: 'OS' },
							{ name: 'Rows', cellBar: { segments: [{ agg: 'COUNT' }] } },
						],
					},
				},
			},
			'<table data-kw-bind="status-table"></table>',
		);

		expect(() => validatePowerBiHtmlBindings(html, [barDataSource])).not.toThrow();
	});

	it('reports invalid advanced bar combinations before export', () => {
		const html = makeV1Html(
			{
				'bad-segment-value': {
					display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' }, segments: [{ agg: 'SUM', column: 'Healthy' }] },
				},
				'bad-threshold-scale': {
					display: {
						type: 'bar', groupBy: 'OS', value: { agg: 'AVG', column: 'LatencyMs' }, scale: 'normalized100',
						thresholdBands: { bands: [{ min: 0, max: 50 }, { min: 50, max: 100 }] },
					},
				},
				'bad-color-scale': {
					display: {
						type: 'bar', groupBy: 'OS', value: { agg: 'AVG', column: 'FailureRate' }, scale: 'normalized100',
						colorRules: [{ operator: '>=', value: 0.1, color: '#C62828' }],
					},
				},
			},
			'<div data-kw-bind="bad-segment-value"></div><div data-kw-bind="bad-threshold-scale"></div><div data-kw-bind="bad-color-scale"></div>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual([
			'bad-segment-value (bar: invalid chart spec)',
			'bad-threshold-scale (bar: invalid chart spec)',
			'bad-color-scale (bar: invalid chart spec)',
		]);
	});

	it('reports provenance bindings without matching rendered targets', () => {
		const html = makeV1Html(
			{
				'total': { display: { type: 'scalar', agg: 'COUNT' } },
				'unrendered-chart': { display: { type: 'bar', groupBy: 'SkillName', value: { agg: 'COUNT' } } },
			},
			'<span data-kw-bind="total"></span>',
		);

		expect(getPowerBiHtmlValidationIssues(html, [factDataSource])).toEqual([
			'unrendered-chart (missing data-kw-bind target)',
		]);
		expect(() => validatePowerBiHtmlBindings(html, [factDataSource])).toThrow(/unrendered-chart \(missing data-kw-bind target\)/);
	});

	it('reports slicer dimensions missing from the fact data source', () => {
		const html = makeV1Html(
			{ 'total': { display: { type: 'scalar', agg: 'COUNT' } } },
			'<span data-kw-bind="total"></span>',
			[{ column: 'OS', label: 'Operating System' }],
		);

		expect(getPowerBiHtmlValidationIssues(html, [factDataSource])).toEqual([
			'model.dimensions[0] (slicer: missing column OS)',
		]);
	});

	it('keeps the non-throwing collector aligned with the throwing validator', () => {
		const html = makeV1Html(
			{
				'heat': { display: { type: 'heatmap', xColumn: 'Day', valueColumn: 'SkillName' } },
				'bad-scalar': { display: { type: 'scalar', agg: 'SUM' } },
			},
			'<div data-kw-bind="heat"></div><span data-kw-bind="bad-scalar"></span>',
		);

		const issues = getPowerBiHtmlValidationIssues(html, [factDataSource]);
		expect(issues).toEqual(['heat (heatmap)', 'bad-scalar (scalar: invalid spec)']);
		expect(() => validatePowerBiHtmlBindings(html, [factDataSource])).toThrow(issues.join(', '));
	});

	it('reports malformed scalar bindings before export', () => {
		const html = makeV1Html(
			{
				'total': { display: { type: 'scalar', agg: 'SUM' } },
			},
			'<span data-kw-bind="total"></span>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual(['total (scalar: invalid spec)']);
		expect(() => validatePowerBiHtmlBindings(html)).toThrow(/total \(scalar: invalid spec\)/);
		expect(generateDaxMeasure(html, [factDataSource])).not.toContain('SUMX');
	});

	it('reports malformed table bindings before export', () => {
		const html = makeV1Html(
			{
				'top-table': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [{ name: 'OS' }, { name: 'Metric', agg: 'SUM', sourceColumn: 123 }],
					},
				},
			},
			'<table data-kw-bind="top-table"></table>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual(['top-table (table: invalid spec)']);
		expect(() => validatePowerBiHtmlBindings(html)).toThrow(/top-table \(table: invalid spec\)/);
	});

	it('reports table preAggregate specs missing compute agg before export', () => {
		const html = makeV1Html(
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
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual(['session-depth (table: invalid spec)']);
	});

	it('accepts table COUNT aliases that are computed outputs', () => {
		const html = makeV1Html(
			{
				'top-skills': {
					display: {
						type: 'table',
						groupBy: ['SkillName'],
						columns: [{ name: 'SkillName' }, { name: 'Refs', agg: 'COUNT', format: '#,##0' }],
						orderBy: { column: 'Refs', direction: 'desc' },
					},
				},
			},
			'<table data-kw-bind="top-skills"><tbody></tbody></table>',
		);

		expect(() => validatePowerBiHtmlBindings(html, [factDataSource])).not.toThrow();
	});

	it('accepts preAggregate table COUNT aliases that are computed outputs', () => {
		const html = makeV1Html(
			{
				'session-depth': {
					display: {
						type: 'table',
						preAggregate: {
							groupBy: 'DeviceId',
							compute: { name: 'SkillsPerSession', agg: 'DISTINCTCOUNT', column: 'SkillName' },
						},
						groupBy: ['SkillsPerSession'],
						columns: [{ name: 'SkillsPerSession' }, { name: 'SessionCount', agg: 'COUNT', format: '#,##0' }],
						orderBy: { column: 'SkillsPerSession', direction: 'asc' },
					},
				},
			},
			'<table data-kw-bind="session-depth"><tbody></tbody></table>',
		);

		expect(() => validatePowerBiHtmlBindings(html, [factDataSource])).not.toThrow();
	});

	it('reports preAggregate computed names that collide with fact or group columns', () => {
		const html = makeV1Html(
			{
				'fact-collision': {
					display: {
						type: 'bar',
						groupBy: 'DeviceId',
						value: { agg: 'COUNT' },
						preAggregate: {
							groupBy: 'DeviceId',
							compute: { name: 'SkillName', agg: 'DISTINCTCOUNT', column: 'ClientName' },
						},
					},
				},
				'group-collision': {
					display: {
						type: 'bar',
						groupBy: 'DeviceId',
						value: { agg: 'COUNT' },
						preAggregate: {
							groupBy: 'DeviceId',
							compute: { name: 'deviceid', agg: 'DISTINCTCOUNT', column: 'SkillName' },
						},
					},
				},
				'case-collision': {
					display: {
						type: 'bar',
						groupBy: 'DeviceId',
						value: { agg: 'COUNT' },
						preAggregate: {
							groupBy: 'DeviceId',
							compute: { name: 'clientname', agg: 'DISTINCTCOUNT', column: 'SkillName' },
						},
					},
				},
			},
			'<div data-kw-bind="fact-collision"></div><div data-kw-bind="group-collision"></div><div data-kw-bind="case-collision"></div>',
		);

		expect(getPowerBiHtmlValidationIssues(html, [factDataSource])).toEqual([
			'fact-collision (preAggregate.compute.name: collides with fact column SkillName)',
			'group-collision (preAggregate.compute.name: collides with groupBy column DeviceId)',
			'case-collision (preAggregate.compute.name: collides with fact column ClientName)',
		]);
	});

	it('reports malformed pivot bindings before export', () => {
		const html = makeV1Html(
			{
				'pivot': {
					display: {
						type: 'pivot',
						rows: ['OS'],
						pivotBy: 'SkillName',
						pivotValues: ['A'],
						agg: 'SUM',
					},
				},
				'pivot-preagg': {
					display: {
						type: 'pivot',
						rows: ['SkillsPerSession'],
						pivotBy: 'ClientName',
						pivotValues: ['vscode'],
						value: 'SkillsPerSession',
						agg: 'COUNT',
						preAggregate: {
							groupBy: 'SessionId',
							compute: { name: 'SkillsPerSession', column: 'SkillName' },
						},
					},
				},
			},
			'<table data-kw-bind="pivot"></table><table data-kw-bind="pivot-preagg"></table>',
		);

		expect(findUnsupportedPowerBiBindings(html)).toEqual([
			'pivot (pivot: invalid spec)',
			'pivot-preagg (pivot: invalid spec)',
		]);
		expect(() => validatePowerBiHtmlBindings(html)).toThrow(/pivot \(pivot: invalid spec\)/);
	});

	it('throws from the root Power BI binding validator for unsupported rendered bindings', () => {
		const html = makeV1Html(
			{
				'heat': { display: { type: 'heatmap', xColumn: 'Day', valueColumn: 'SkillName' } },
			},
			'<div data-kw-bind="heat"></div>',
		);

		expect(() => validatePowerBiHtmlBindings(html)).toThrow(/Unsupported bindings: heat \(heatmap\)/);
	});
});

// ── DAX string escaping ─────────────────────────────────────────────────────

describe('escapeDaxString', () => {
	it('escapes double quotes', () => {
		expect(escapeDaxString('say "hello"')).toBe('say ""hello""');
	});

	it('collapses newlines to spaces', () => {
		expect(escapeDaxString('line1\nline2\r\nline3')).toBe('line1 line2 line3');
	});

	it('handles HTML with scripts and quotes', () => {
		const html = '<div id="test">Hello</div><script>var x = "world";</script>';
		const result = escapeDaxString(html);
		expect(result).toContain('id=""test""');
		expect(result).toContain('x = ""world""');
		expect(result).not.toContain('\n');
	});

	it('handles empty string', () => {
		expect(escapeDaxString('')).toBe('');
	});

	it('preserves single quotes and backticks', () => {
		expect(escapeDaxString("it's a `test`")).toBe("it's a `test`");
	});
});

// ── HTML measures table TMDL ────────────────────────────────────────────────

describe('generateHtmlMeasureTmdl', () => {
	it('generates a TMDL table with measure containing the HTML', () => {
		const tmdl = generateHtmlMeasureTmdl('<div>Hello</div>');
		expect(tmdl).toContain("table '_KW_HtmlMeasures'");
		expect(tmdl).toContain("measure 'HTML Dashboard'");
		expect(tmdl).toContain('<div>Hello</div>');
		expect(tmdl).toContain('column Column1');
		expect(tmdl).toContain('mode: import');
	});

	it('escapes double quotes in HTML for DAX string literal', () => {
		const tmdl = generateHtmlMeasureTmdl('<div id="test">Hello</div>');
		// DAX string: " becomes ""
		expect(tmdl).toContain('id=""test""');
	});

	it('collapses newlines in HTML for TMDL compatibility', () => {
		const tmdl = generateHtmlMeasureTmdl('<div>\n  <p>Hello</p>\n</div>');
		// Measure expression should be on one line (no raw newlines in DAX string)
		const measureLine = tmdl.split('\n').find(l => l.includes("measure 'HTML Dashboard'"));
		expect(measureLine).toBeDefined();
		expect(measureLine).not.toContain('\\n');
	});

	it('handles HTML with script tags containing double quotes', () => {
		const html = '<script>var x = "hello"; document.getElementById("test").innerText = x;</script>';
		const tmdl = generateHtmlMeasureTmdl(html);
		expect(tmdl).toContain('""hello""');
		expect(tmdl).toContain('getElementById(""test"")');
	});

	it('includes the empty-data import partition', () => {
		const tmdl = generateHtmlMeasureTmdl('<div>Test</div>');
		expect(tmdl).toContain('Binary.Decompress');
		expect(tmdl).toContain('Table.FromRows');
		expect(tmdl).toContain('PBI_NavigationStepName');
		expect(tmdl).toContain('PBI_ResultType');
	});
});

// ── HTML Content visual JSON ────────────────────────────────────────────────

describe('generateHtmlContentVisualJson', () => {
	it('uses the marketplace HTML Content visual type', () => {
		const json = JSON.parse(generateHtmlContentVisualJson('vis1'));
		expect(json.visual.visualType).toBe('htmlContent443BE3AD55E043BF878BED274D3A6855');
	});

	it('has the content data role with measure projection', () => {
		const json = JSON.parse(generateHtmlContentVisualJson('vis1'));
		const content = json.visual.query.queryState.content;
		expect(content).toBeDefined();
		expect(content.projections).toHaveLength(1);
		expect(content.projections[0].field.Measure).toBeDefined();
		expect(content.projections[0].field.Measure.Property).toBe('HTML Dashboard');
		expect(content.projections[0].field.Measure.Expression.SourceRef.Entity).toBe('_KW_HtmlMeasures');
	});

	it('uses the correct PBIR schema version', () => {
		const json = JSON.parse(generateHtmlContentVisualJson('vis1'));
		expect(json.$schema).toContain('visualContainer/2.8.0');
	});

	it('positions the visual to fill the page', () => {
		const json = JSON.parse(generateHtmlContentVisualJson('vis1'));
		expect(json.position.width).toBe(1450);
		expect(json.position.height).toBe(720);
		expect(json.position.x).toBe(25);
		expect(json.position.y).toBe(0);
	});

	it('uses custom page height', () => {
		const json = JSON.parse(generateHtmlContentVisualJson('vis1', 2000));
		expect(json.position.height).toBe(2000);
	});

	it('uses the provided visual name', () => {
		const json = JSON.parse(generateHtmlContentVisualJson('myVisualId'));
		expect(json.name).toBe('myVisualId');
	});
});

// ── DAX column reference escaping ───────────────────────────────────────────

describe('escapeDaxColumnRef', () => {
	it('escapes ] to ]]', () => {
		expect(escapeDaxColumnRef('My]Column')).toBe('My]]Column');
	});

	it('leaves names without ] unchanged', () => {
		expect(escapeDaxColumnRef('Region')).toBe('Region');
	});
});

// ── DAX column expression ───────────────────────────────────────────────────

describe('daxColumnExpr', () => {
	it('formats long/int with #,##0', () => {
		expect(daxColumnExpr('Sales', 'long')).toBe('FORMAT([Sales], "#,##0")');
	});

	it('uses raw reference for string type', () => {
		expect(daxColumnExpr('Region', 'string')).toBe('[Region]');
	});

	it('formats datetime', () => {
		expect(daxColumnExpr('Timestamp', 'datetime')).toBe('FORMAT([Timestamp], "yyyy-MM-dd HH:mm")');
	});

	it('escapes ] in column names', () => {
		expect(daxColumnExpr('My]Col', 'string')).toBe('[My]]Col]');
	});

	it('formats real/double with decimals', () => {
		expect(daxColumnExpr('Margin', 'real')).toBe('FORMAT([Margin], "#,##0.##")');
	});

	it('formats boolean with IF', () => {
		expect(daxColumnExpr('IsActive', 'bool')).toBe('IF([IsActive], "true", "false")');
	});
});

// ── Dynamic DAX measure generation (v1 — shared fact table) ─────────────────

const factDataSource: PowerBiDataSource = {
	name: 'Fact Events',
	sectionId: 'query_fact',
	clusterUrl: 'https://cluster.kusto.windows.net',
	database: 'db',
	query: 'T | project Day, SkillName, ClientName, DeviceId',
	columns: [
		{ name: 'Day', type: 'datetime' },
		{ name: 'SkillName', type: 'string' },
		{ name: 'ClientName', type: 'string' },
		{ name: 'DeviceId', type: 'string' },
	],
};

const barDataSource: PowerBiDataSource = {
	...factDataSource,
	columns: [
		...factDataSource.columns,
		{ name: 'OS', type: 'string' },
		{ name: 'Healthy', type: 'long' },
		{ name: 'Warning', type: 'long' },
		{ name: 'Critical', type: 'long' },
		{ name: 'LatencyMs', type: 'real' },
		{ name: 'FailureRate', type: 'real' },
	],
};

describe('dashboard bar display validation', () => {
	it('accepts each supported bar mode and rejects ambiguous combinations', () => {
		expect(isValidDashboardChartDisplay({ type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' } })).toBe(true);
		expect(isValidDashboardChartDisplay({
			type: 'bar', groupBy: 'OS',
			segments: [{ agg: 'SUM', column: 'Healthy', color: '#2E7D32' }],
		})).toBe(true);
		expect(isValidDashboardChartDisplay({
			type: 'bar', groupBy: 'OS',
			value: { agg: 'AVG', column: 'LatencyMs' },
			thresholdBands: { scaleMax: 100, bands: [{ min: 0, max: 50 }, { min: 50, max: 100 }] },
		})).toBe(true);
		expect(isValidDashboardChartDisplay({
			type: 'bar', groupBy: 'OS',
			value: { agg: 'AVG', column: 'FailureRate' },
			colorRules: [{ operator: '>=', value: 0.1, color: '#C62828' }],
		})).toBe(true);

		expect(isValidDashboardChartDisplay({
			type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' },
			scale: 'normalized100',
		})).toBe(false);
		expect(isValidDashboardChartDisplay({
			type: 'bar', groupBy: 'OS',
			value: { agg: 'AVG', column: 'FailureRate' },
			scale: 'normalized100',
			colorRules: [{ operator: '>=', value: 0.1, color: '#C62828' }],
		})).toBe(false);
		expect(isValidDashboardChartDisplay({
			type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' },
			segments: [{ agg: 'SUM', column: 'Healthy' }],
		})).toBe(false);
		expect(isValidDashboardChartDisplay({
			type: 'bar', groupBy: 'OS',
			value: { agg: 'AVG', column: 'LatencyMs' },
			scale: 'normalized100',
			thresholdBands: { bands: [{ min: 0, max: 50 }, { min: 60, max: 100 }] },
		})).toBe(false);
		expect(isValidDashboardChartDisplay({
			type: 'bar', groupBy: 'OS',
			value: { agg: 'AVG', column: 'LatencyMs' },
			thresholdBands: { scaleMax: 40, bands: [{ min: 0, max: 50 }] },
		})).toBe(false);
		expect(isValidDashboardChartDisplay({
			type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' },
			colors: ['#2E7D32', 'bad"color'],
		})).toBe(false);
	});
});

describe('dashboard repeated table display validation', () => {
	it('accepts valid repeated table specs and rejects ambiguous repeat columns', () => {
		expect(isValidRepeatedTableDisplay({
			type: 'repeatedTable',
			repeatBy: ['SkillName'],
			repeatColumns: [{ name: 'SkillName' }, { name: 'Rows', agg: 'COUNT' }],
			repeatOrderBy: { column: 'Rows', direction: 'desc' },
			repeatTop: 10,
			table: {
				groupBy: ['ClientName'],
				columns: [{ name: 'ClientName' }, { name: 'Devices', agg: 'DCOUNT', sourceColumn: 'DeviceId' }],
				orderBy: { column: 'Devices', direction: 'desc' },
				top: 5,
			},
		})).toBe(true);

		expect(isValidRepeatedTableDisplay({
			type: 'repeatedTable',
			repeatBy: ['SkillName'],
			repeatColumns: [{ name: 'Visual', cellBar: { segments: [{ agg: 'COUNT' }] } }],
			table: { groupBy: ['ClientName'], columns: [{ name: 'ClientName' }] },
		})).toBe(false);
		expect(isValidRepeatedTableDisplay({
			type: 'repeatedTable',
			repeatBy: ['SkillName'],
			repeatTop: 3,
			table: { groupBy: ['ClientName'], columns: [{ name: 'ClientName' }] },
		})).toBe(false);
		expect(isValidRepeatedTableDisplay({
			type: 'repeatedTable',
			repeatBy: ['__kw_repeat_idx_0'],
			table: { groupBy: ['ClientName'], columns: [{ name: 'ClientName' }] },
		})).toBe(false);
	});
});

describe('dashboard table cell formatting validation', () => {
	it('accepts badge and whole-cell conditional formatting specs', () => {
		expect(isValidTableDisplay({
			type: 'table',
			groupBy: ['OS'],
			columns: [
				{ name: 'OS' },
				{
					name: 'FailureRate',
					agg: 'AVG',
					sourceColumn: 'FailureRate',
					format: '0.##%',
					cellFormat: {
						mode: 'badge',
						rules: [{ operator: '<', value: 0.8, backgroundColor: '#FDE7E9', color: '#C62828', fontWeight: '600' }],
						defaultStyle: { backgroundColor: '#E7F3E7', color: '#2E7D32' },
					},
				},
			],
		})).toBe(true);

		expect(isValidTableDisplay({
			type: 'table',
			groupBy: ['OS'],
			columns: [
				{ name: 'OS' },
				{
					name: 'Latency',
					agg: 'AVG',
					sourceColumn: 'LatencyMs',
					cellFormat: { mode: 'cell', rules: [{ operator: '>=', value: 1000, backgroundColor: 'red', color: 'white' }] },
				},
			],
		})).toBe(true);
	});

	it('rejects unsafe or ambiguous cell formatting specs', () => {
		expect(isValidTableDisplay({
			type: 'table',
			groupBy: ['OS'],
			columns: [{ name: 'OS' }, { name: 'Rows', agg: 'COUNT', cellFormat: { rules: [{ operator: 'between', value: 1, backgroundColor: '#fff' }] } }],
		})).toBe(false);
		expect(isValidTableDisplay({
			type: 'table',
			groupBy: ['OS'],
			columns: [{ name: 'OS' }, { name: 'Rows', agg: 'COUNT', cellFormat: { rules: [{ operator: '>', value: 1, backgroundColor: 'red;position:fixed' }] } }],
		})).toBe(false);
		expect(isValidTableDisplay({
			type: 'table',
			groupBy: ['OS'],
			columns: [{ name: 'OS' }, { name: 'Rows', agg: 'COUNT', cellFormat: { rules: [{ operator: '>', value: 1, backgroundColor: '#fff', fontWeight: '900' }] } }],
		})).toBe(false);
		expect(isValidTableDisplay({
			type: 'table',
			groupBy: ['OS'],
			columns: [
				{ name: 'OS' },
				{ name: 'Visual', cellBar: { segments: [{ agg: 'COUNT' }] }, cellFormat: { rules: [{ operator: '>', value: 1, backgroundColor: '#fff' }] } },
			],
		})).toBe(false);
		expect(isValidTableDisplay({
			type: 'table',
			groupBy: ['OS'],
			columns: [{ name: 'OS' }, { name: 'Rows', agg: 'COUNT', cellFormat: { valueColumn: 'Missing', rules: [{ operator: '>', value: 1, backgroundColor: '#fff' }] } }],
		})).toBe(false);
		expect(isValidRepeatedTableDisplay({
			type: 'repeatedTable',
			repeatBy: ['SkillName'],
			repeatColumns: [{ name: 'SkillName', cellFormat: { rules: [{ operator: '=', value: 1, backgroundColor: '#fff' }] } }],
			table: { groupBy: ['ClientName'], columns: [{ name: 'ClientName' }] },
		})).toBe(false);
	});
});

describe('generateTableTmdl', () => {
	it('uses Import mode by default for local export compatibility', () => {
		const tmdl = generateTableTmdl(factDataSource);

		expect(tmdl).toContain('mode: import');
		expect(tmdl).not.toContain('mode: directQuery');
	});

	it('uses DirectQuery mode when requested', () => {
		const tmdl = generateTableTmdl(factDataSource, 'directQuery');

		expect(tmdl).toContain('mode: directQuery');
		expect(tmdl).not.toContain('mode: import');
	});

	it('preserves the AzureDataExplorer.Contents expression in both modes', () => {
		const tmdl = generateTableTmdl(factDataSource, 'import');

		expect(tmdl).toContain('AzureDataExplorer.Contents("https://cluster.kusto.windows.net", "db"');
	});
});

function makeV1Html(bindings: Record<string, object>, bodyHtml: string, dimensions?: object[]): string {
	const model: any = { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } };
	if (dimensions) model.dimensions = dimensions;
	const prov = JSON.stringify({ version: 1, model, bindings });
	return `<html><head><script type="application/kw-provenance">${prov}</script></head><body>${bodyHtml}</body></html>`;
}

describe('generateDaxMeasure — v1 scalar', () => {
	it('generates COUNT for row count scalar', () => {
		const html = makeV1Html(
			{ 'total': { display: { type: 'scalar', agg: 'COUNT', format: '#,##0' } } },
			'<span data-kw-bind="total">0</span>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('COUNTROWS');
		expect(result).toContain('#,##0');
		expect(result).toContain('RETURN');
	});

	it('generates DISTINCTCOUNT for unique values scalar', () => {
		const html = makeV1Html(
			{ 'devices': { display: { type: 'scalar', agg: 'DISTINCTCOUNT', column: 'DeviceId', format: '#,##0' } } },
			'<span data-kw-bind="devices">0</span>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('DISTINCTCOUNT');
		expect(result).toContain('[DeviceId]');
	});

	it('falls back to static string when no provenance', () => {
		const result = generateDaxMeasure('<div>Hello</div>', [factDataSource]);
		expect(result).toMatch(/^"/);
		expect(result).toContain('Hello');
	});

	it('falls back to static string when dataSources is empty', () => {
		const html = makeV1Html(
			{ 'total': { display: { type: 'scalar', agg: 'COUNT' } } },
			'<span data-kw-bind="total">0</span>',
		);
		const result = generateDaxMeasure(html, []);
		expect(result).toMatch(/^"/);
	});

	it('replaces the real scalar target when commented bound markup appears first', () => {
		const html = makeV1Html(
			{ 'total': { display: { type: 'scalar', agg: 'COUNT' } } },
			'<!-- <span data-kw-bind="total">old</span> --><span data-kw-bind="total">0</span>',
		);

		const result = generateDaxMeasure(html, [factDataSource]);

		expect(result).toContain('<!-- <span data-kw-bind=""total"">old</span> -->');
		expect(result).toContain('<span data-kw-bind=""total"">" & _scalar_0 & "</span>');
	});

	it('replaces the real scalar target when scripted bound markup appears first', () => {
		const html = makeV1Html(
			{ 'total': { display: { type: 'scalar', agg: 'COUNT' } } },
			'<script>const html = \'<span data-kw-bind="total">old</span>\';</script><span data-kw-bind="total">0</span>',
		);

		const result = generateDaxMeasure(html, [factDataSource]);

		expect(result).toContain('<script>const html = \'<span data-kw-bind=""total"">old</span>\';</script>');
		expect(result).toContain('<span data-kw-bind=""total"">" & _scalar_0 & "</span>');
	});

	it('replaces the real scalar target when template bound markup appears first', () => {
		const html = makeV1Html(
			{ 'total': { display: { type: 'scalar', agg: 'COUNT' } } },
			'<template><span data-kw-bind="total">old</span></template><span data-kw-bind="total">0</span>',
		);

		const result = generateDaxMeasure(html, [factDataSource]);

		expect(result).toContain('<template><span data-kw-bind=""total"">old</span></template>');
		expect(result).toContain('<span data-kw-bind=""total"">" & _scalar_0 & "</span>');
	});

	it('replaces the real scalar target when noscript bound markup appears first', () => {
		const html = makeV1Html(
			{ 'total': { display: { type: 'scalar', agg: 'COUNT' } } },
			'<noscript><span data-kw-bind="total">old</span></noscript><span data-kw-bind="total">0</span>',
		);

		const result = generateDaxMeasure(html, [factDataSource]);

		expect(result).toContain('<noscript><span data-kw-bind=""total"">old</span></noscript>');
		expect(result).toContain('<span data-kw-bind=""total"">" & _scalar_0 & "</span>');
	});
});

describe('generateDaxMeasure — v1 table with groupBy', () => {
	it('generates SUMMARIZE + ADDCOLUMNS + CONCATENATEX', () => {
		const html = makeV1Html(
			{
				'top-skills': {
					display: {
						type: 'table',
						columns: [
							{ name: 'SkillName', header: 'Skill' },
							{ name: 'Refs', agg: 'COUNT', format: '#,##0' },
						],
						groupBy: ['SkillName'],
						orderBy: { column: 'Refs', direction: 'desc' },
						top: 10,
					},
				},
			},
			'<table data-kw-bind="top-skills"><thead><tr><th>S</th><th>R</th></tr></thead><tbody></tbody></table>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('SUMMARIZE');
		expect(result).toContain('ADDCOLUMNS');
		expect(result).toContain('FILTER(ADDCOLUMNS(');
		expect(result).toContain('"__kw_table_idx_0", VAR _sort = [Refs]');
		expect(result).toContain('[__kw_table_idx_0] <= 10');
		expect(result).not.toContain('TOPN(10');
		expect(result).toContain('CONCATENATEX');
		expect(result).toContain('[Refs]');
		expect(result).toContain(', [__kw_table_idx_0], ASC');
		expect(result).toContain('<thead>');
	});

	it('generates CALCULATE(DISTINCTCOUNT(...)) inside ADDCOLUMNS', () => {
		const html = makeV1Html(
			{
				'skills': {
					display: {
						type: 'table',
						columns: [
							{ name: 'SkillName' },
							{ name: 'Devices', agg: 'DISTINCTCOUNT', sourceColumn: 'DeviceId' },
						],
						groupBy: ['SkillName'],
					},
				},
			},
			'<table data-kw-bind="skills"><thead><tr><th>S</th><th>D</th></tr></thead><tbody></tbody></table>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('CALCULATE(DISTINCTCOUNT');
		expect(result).toContain('[DeviceId]');
	});

	it('uses deterministic groupBy tie ordering for ordered tables without top', () => {
		const html = makeV1Html(
			{
				'skills': {
					display: {
						type: 'table',
						columns: [
							{ name: 'SkillName', header: 'Skill' },
							{ name: 'Refs', agg: 'COUNT', format: '#,##0' },
						],
						groupBy: ['SkillName'],
						orderBy: { column: 'Refs', direction: 'desc' },
					},
				},
			},
			'<table data-kw-bind="skills"></table>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);

		expect(result).toContain('"__kw_table_idx_0", VAR _sort = [Refs]');
		expect(result).toContain('[Refs] > _sort || ([Refs] = _sort && ([SkillName] <= _key0))');
		expect(result).toContain(', [__kw_table_idx_0], ASC');
		expect(result).not.toContain('[__kw_table_idx_0] <=');
	});

	it('escapes table header literals and dynamic cell text for HTML export', () => {
		const html = makeV1Html(
			{
				'skills': {
					display: {
						type: 'table',
						columns: [
							{ name: 'SkillName', header: 'Skill <Name> & Owner' },
							{ name: 'Refs', agg: 'COUNT' },
						],
						groupBy: ['SkillName'],
					},
				},
			},
			'<table data-kw-bind="skills"><thead><tr><th>Skill</th><th>Refs</th></tr></thead><tbody></tbody></table>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);

		expect(result).toContain('<th>Skill &lt;Name&gt; &amp; Owner</th>');
		expect(result).toContain('"" & [SkillName], "&", "&amp;"');
		expect(result).toContain('"<", "&lt;"');
		expect(result).toContain('">", "&gt;"');
		expect(result).not.toContain('"<td>" & [SkillName] & "</td>"');
	});

	it('generates conditional badge table cells from raw numeric values', () => {
		const html = makeV1Html(
			{
				'status-table': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [
							{ name: 'OS', header: 'Service <Name>' },
							{
								name: 'FailureRate',
								header: 'Failure %',
								agg: 'AVG',
								sourceColumn: 'FailureRate',
								format: '0.##%',
								cellFormat: {
									rules: [
										{ operator: '<', value: 0.05, backgroundColor: '#E7F3E7', color: '#2E7D32', fontWeight: '600' },
										{ operator: '>=', value: 0.1, backgroundColor: '#FDE7E9', color: '#C62828' },
									],
									defaultStyle: { backgroundColor: '#FFF4CE', color: '#8A6D1D' },
								},
							},
						],
					},
				},
			},
			'<table data-kw-bind="status-table"><thead><tr><th>Service</th><th class="metric">Failure</th></tr></thead><tbody></tbody></table>',
		);

		const result = generateDaxMeasure(html, [barDataSource]);

		expect(result).toContain('kw-cell-badge');
		expect(result).toContain('SWITCH(TRUE(), [FailureRate] < 0.05');
		expect(result).toContain('[FailureRate] >= 0.1');
		expect(result).toContain('background-color:#E7F3E7;color:#2E7D32;font-weight:600;');
		expect(result).toContain('background-color:#FFF4CE;color:#8A6D1D;');
		expect(result).toContain('FORMAT([FailureRate], "0.##") & "%"');
		expect(result).toContain('<th>Service &lt;Name&gt;</th>');
		expect(result).toContain("\"<td class=\"\"metric\"\">\" & \"<span class='kw-cell-badge' style='\" & SWITCH");
	});

	it('generates whole-cell conditional styles without wrapping badges', () => {
		const html = makeV1Html(
			{
				'latency-table': {
					display: {
						type: 'table',
						groupBy: ['OS'],
						columns: [
							{ name: 'OS' },
							{
								name: 'Latency',
								agg: 'AVG',
								sourceColumn: 'LatencyMs',
								format: '#,##0',
								cellFormat: {
									mode: 'cell',
									rules: [{ operator: '>', value: 1000, backgroundColor: '#FDE7E9', color: '#C62828' }],
									defaultStyle: { backgroundColor: '#E7F3E7' },
								},
							},
						],
					},
				},
			},
			'<table data-kw-bind="latency-table"></table>',
		);

		const result = generateDaxMeasure(html, [barDataSource]);

		expect(result).toContain("\"<td style='\" & SWITCH(TRUE(), [Latency] > 1000");
		expect(result).toContain('background-color:#FDE7E9;color:#C62828;');
		expect(result).toContain('background-color:#E7F3E7;');
		expect(result).not.toContain('kw-cell-badge');
	});

	it('generates inline SVG table cells for stacked cell bars', () => {
		const html = makeV1Html(
			{
				'status-table': {
					display: {
						type: 'table',
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
						groupBy: ['OS'],
					},
				},
			},
			'<table data-kw-bind="status-table"><thead><tr><th>Service</th><th>Breakdown</th></tr></thead><tbody></tbody></table>',
		);
		const result = generateDaxMeasure(html, [barDataSource]);

		expect(result).toContain('Breakdown');
		expect(result).toContain('kw-cell-bar');
		expect(result).toContain('__kw_cellbar_0_1_0');
		expect(result).toContain('__kw_cellbar_0_1_1');
		expect(result).toContain('CALCULATE(SUMX');
		expect(result).toContain('[Healthy]');
		expect(result).toContain('[Critical]');
		expect(result).toContain('DIVIDE(MAX(0, COALESCE([__kw_cellbar_0_1_0], 0))');
		expect(result).toContain('"<td>" & "<svg class=\'kw-cell-bar\'');
	});

	it('generates relative scaling vars for each table cell-bar column', () => {
		const html = makeV1Html(
			{
				'status-table': {
					display: {
						type: 'table',
						columns: [
							{ name: 'OS' },
							{ name: 'Health', cellBar: { scale: 'relative', segments: [{ agg: 'SUM', column: 'Healthy' }] } },
							{ name: 'Problems', cellBar: { scale: 'relative', segments: [{ agg: 'SUM', column: 'Warning' }, { agg: 'SUM', column: 'Critical' }] } },
						],
						groupBy: ['OS'],
						orderBy: { column: 'OS', direction: 'asc' },
						top: 5,
					},
				},
			},
			'<table data-kw-bind="status-table"><tbody></tbody></table>',
		);
		const result = generateDaxMeasure(html, [barDataSource]);

		expect(result).toContain('VAR _kwCellBarMax_0_1 = MAXX(');
		expect(result).toContain('VAR _kwCellBarMax_0_2 = MAXX(');
		expect(result).toContain('DIVIDE(MAX(0, COALESCE([__kw_cellbar_0_1_0], 0)), _kwCellBarMax_0_1, 0)');
		expect(result).toContain('[__kw_table_idx_0] <= 5');
	});

	it('generates COUNT-based table cell bars without requiring a source column', () => {
		const html = makeV1Html(
			{
				'status-table': {
					display: {
						type: 'table',
						columns: [
							{ name: 'OS' },
							{ name: 'Rows', cellBar: { segments: [{ agg: 'COUNT', color: '#0078D4' }] } },
						],
						groupBy: ['OS'],
					},
				},
			},
			'<table data-kw-bind="status-table"><tbody></tbody></table>',
		);
		const result = generateDaxMeasure(html, [barDataSource]);

		expect(result).toContain('"__kw_cellbar_0_1_0", CALCULATE(COUNTROWS(');
		expect(result).toContain("fill='#0078D4'");
	});
});

describe('generateDaxMeasure — repeated table', () => {
	it('generates outer repeated sections with scoped ordered inner tables', () => {
		const html = makeV1Html(
			{
				'by-skill': {
					display: {
						type: 'repeatedTable',
						repeatBy: ['SkillName'],
						repeatColumns: [
							{ name: 'SkillName', header: 'Skill <Name>' },
							{ name: 'Refs', agg: 'COUNT', header: 'References', format: '#,##0' },
						],
						repeatOrderBy: { column: 'Refs', direction: 'desc' },
						repeatTop: 2,
						table: {
							groupBy: ['ClientName'],
							columns: [
								{ name: 'ClientName', header: 'Client' },
								{ name: 'Devices', agg: 'DCOUNT', sourceColumn: 'DeviceId', header: 'Devices', format: '#,##0' },
							],
							orderBy: { column: 'Devices', direction: 'desc' },
							top: 3,
						},
					},
				},
			},
			'<div data-kw-bind="by-skill"></div>',
		);

		const result = generateDaxMeasure(html, [factDataSource]);

		expect(result).toContain('VAR _repeatData_0 = FILTER(ADDCOLUMNS(');
		expect(result).toContain('"__kw_repeat_idx_0", VAR _sort = [Refs]');
		expect(result).toContain('[__kw_repeat_idx_0] <= 2');
		expect(result).toContain('VAR _repeatInnerData_0 = ADDCOLUMNS(SUMMARIZE');
		expect(result).toContain('[SkillName] = _kwRepeatKey_0_0');
		expect(result).toContain('"__kw_table_idx_0", VAR _sort = [Devices]');
		expect(result).toContain('[__kw_table_idx_0] <= 3');
		expect(result).toContain('kw-repeated-table-group');
		expect(result).toContain('kw-repeated-table');
		expect(result).toContain("kw-repeated-table-group' style='margin:0 0 16px 0;border:1px solid rgba(127,127,127,0.35);border-radius:6px;overflow:hidden;");
		expect(result).toContain("kw-repeated-table-header' style='display:flex");
		expect(result).toContain('align-items:flex-start');
		expect(result).toContain('gap:10px 32px');
		expect(result).toContain('border-bottom:1px solid rgba(127,127,127,0.35)');
		expect(result).toContain("kw-repeat-field kw-repeat-primary' style='display:flex");
		expect(result).toContain('flex-direction:column');
		expect(result).toContain('flex:1 1 220px');
		expect(result).toContain("kw-repeat-field kw-repeat-metric' style='display:flex");
		expect(result).toContain('align-items:flex-end');
		expect(result).toContain('white-space:nowrap');
		expect(result).toContain('<th style=""width:1%;white-space:nowrap;text-align:right;"">Devices</th>');
		expect(result).toContain('<td style=""width:1%;white-space:nowrap;text-align:right;"">');
		expect(result).toContain("kw-repeat-label' style='font-size:inherit;font-weight:700");
		expect(result).toContain("kw-repeat-value' style='font-size:inherit;font-weight:400");
		expect(result).toContain('Skill &lt;Name&gt;');
		expect(result).toContain('DISTINCTCOUNT');
		expect(result).toContain('CONCATENATEX(_repeatData_0');
		expect(result).toContain('RETURN "<html>');
		expect(result).toContain('_repeat_0');
	});

	it('defaults omitted repeatOrderBy direction to descending like preview table ordering', () => {
		const html = makeV1Html(
			{
				'by-skill': {
					display: {
						type: 'repeatedTable',
						repeatBy: ['SkillName'],
						repeatColumns: [{ name: 'SkillName' }, { name: 'Rows', agg: 'COUNT' }],
						repeatOrderBy: { column: 'Rows' },
						table: {
							groupBy: ['ClientName'],
							columns: [{ name: 'ClientName' }, { name: 'Devices', agg: 'DCOUNT', sourceColumn: 'DeviceId' }],
						},
					},
				},
			},
			'<div data-kw-bind="by-skill"></div>',
		);

		const result = generateDaxMeasure(html, [factDataSource]);

		expect(result).toContain('"__kw_repeat_idx_0", VAR _sort = [Rows]');
		expect(result).toContain('[Rows] > _sort');
	});

	it('uses group-key default ordering when repeated table orderBy fields are omitted', () => {
		const html = makeV1Html(
			{
				'by-skill': {
					display: {
						type: 'repeatedTable',
						repeatBy: ['SkillName'],
						table: {
							groupBy: ['ClientName'],
							columns: [{ name: 'ClientName' }, { name: 'Rows', agg: 'COUNT' }],
						},
					},
				},
			},
			'<div data-kw-bind="by-skill"></div>',
		);

		const result = generateDaxMeasure(html, [factDataSource]);

		expect(result).toContain('"__kw_repeat_idx_0", VAR _sort = [SkillName]');
		expect(result).toContain('CONCATENATEX(_repeatData_0');
		expect(result).toContain(', [__kw_repeat_idx_0], ASC');
		expect(result).toContain('CONCATENATEX(_kwRepeatRows_0, "<tr>"');
		expect(result).toContain(', [ClientName], ASC');
	});

	it('generates per-group relative cell bars for inner repeated tables', () => {
		const html = makeV1Html(
			{
				'by-os': {
					display: {
						type: 'repeatedTable',
						repeatBy: ['OS'],
						repeatColumns: [{ name: 'OS' }, { name: 'Rows', agg: 'COUNT' }],
						repeatOrderBy: { column: 'Rows', direction: 'desc' },
						table: {
							groupBy: ['SkillName'],
							columns: [
								{ name: 'SkillName' },
								{ name: 'Health', cellBar: { scale: 'relative', segments: [{ agg: 'SUM', column: 'Healthy', color: '#2E7D32' }] } },
							],
							orderBy: { column: 'SkillName', direction: 'asc' },
						},
					},
				},
			},
			'<div data-kw-bind="by-os"></div>',
		);

		const result = generateDaxMeasure(html, [barDataSource]);

		expect(result).toContain('VAR _kwCellBarMax_0_1 = MAXX(_kwRepeatRows_0');
		expect(result).toContain('DIVIDE(MAX(0, COALESCE([__kw_cellbar_0_1_0], 0)), _kwCellBarMax_0_1, 0)');
		expect(result).toContain('kw-cell-bar');
	});

	it('generates conditional formatting for inner repeated table cells', () => {
		const html = makeV1Html(
			{
				'by-os': {
					display: {
						type: 'repeatedTable',
						repeatBy: ['OS'],
						table: {
							groupBy: ['SkillName'],
							columns: [
								{ name: 'SkillName' },
								{
									name: 'FailureRate',
									agg: 'AVG',
									sourceColumn: 'FailureRate',
									format: '0.##%',
									cellFormat: { rules: [{ operator: '>=', value: 0.1, backgroundColor: '#FDE7E9', color: '#C62828' }] },
								},
							],
						},
					},
				},
			},
			'<div data-kw-bind="by-os"></div>',
		);

		const result = generateDaxMeasure(html, [barDataSource]);

		expect(result).toContain('VAR _repeatInnerData_0 = ADDCOLUMNS(SUMMARIZE');
		expect(result).toContain('kw-cell-badge');
		expect(result).toContain('SWITCH(TRUE(), [FailureRate] >= 0.1');
		expect(result).toContain('FORMAT([FailureRate], "0.##") & "%"');
	});
});

describe('generateDaxMeasure — v1 pivot', () => {
	it('generates CALCULATE per pivot value from fact table', () => {
		const html = makeV1Html(
			{
				'by-client': {
					display: {
						type: 'pivot', rows: ['SkillName'], pivotBy: 'ClientName',
						pivotValues: ['vscode', 'copilot-cli'], value: 'SkillName', agg: 'COUNT', total: true,
					},
				},
			},
			'<table data-kw-bind="by-client"><thead><tr><th>S</th></tr></thead><tbody></tbody></table>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('CALCULATE');
		expect(result).toContain('COUNTROWS');
		expect(result).toContain('"vscode"');
		expect(result).toContain('"copilot-cli"');
		expect(result).toContain('Total');
	});
});

describe('generateDaxMeasure — data-kw-bind on <tbody>', () => {
	it('matches table binding when data-kw-bind is on <tbody> not <table>', () => {
		const html = makeV1Html(
			{
				'top-skills': {
					display: {
						type: 'table',
						columns: [
							{ name: 'SkillName', header: 'Skill' },
							{ name: 'Refs', agg: 'COUNT', format: '#,##0' },
						],
						groupBy: ['SkillName'],
						orderBy: { column: 'Refs', direction: 'desc' },
						top: 10,
					},
				},
			},
			'<table><caption>Keep me</caption><colgroup><col></colgroup><thead><tr><th>Existing Skill</th><th>Existing Refs</th></tr></thead><tbody class="live" data-kw-bind="top-skills"></tbody></table>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('SUMMARIZE');
		expect(result).toContain('[__kw_table_idx_0] <= 10');
		expect(result).not.toContain('TOPN(10');
		expect(result).toContain('CONCATENATEX');
		expect(result).toContain('<caption>Keep me</caption>');
		expect(result).toContain('<colgroup><col></colgroup>');
		expect(result).toContain('Existing Skill');
		expect(result).toContain('<tbody class=""live"" data-kw-bind=""top-skills"">');
		expect(result).toContain('_rows_0 & "</tbody></table>');
	});

	it('matches pivot binding when data-kw-bind is on <tbody>', () => {
		const html = makeV1Html(
			{
				'by-client': {
					display: {
						type: 'pivot', rows: ['SkillName'], pivotBy: 'ClientName',
						pivotValues: ['vscode', 'copilot-cli'], value: 'SkillName', agg: 'COUNT', total: true,
					},
				},
			},
			'<table><thead><tr><th>S</th></tr></thead><tbody data-kw-bind="by-client"></tbody></table>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('CALCULATE');
		expect(result).toContain('COUNTROWS');
		expect(result).toContain('"vscode"');
	});

	it('prefers <table data-kw-bind> when both table and tbody have the attribute', () => {
		const html = makeV1Html(
			{
				'skills': {
					display: {
						type: 'table',
						columns: [{ name: 'SkillName' }, { name: 'Refs', agg: 'COUNT' }],
						groupBy: ['SkillName'],
					},
				},
			},
			'<table data-kw-bind="skills"><thead><tr><th>S</th><th>R</th></tr></thead><tbody></tbody></table>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('SUMMARIZE');
	});

	it('does not clobber adjacent tables when multiple have tbody data-kw-bind', () => {
		const html = makeV1Html(
			{
				'weekly': {
					display: {
						type: 'table',
						columns: [{ name: 'Week' }, { name: 'Calls', agg: 'COUNT' }],
						groupBy: ['Week'],
					},
				},
				'skills': {
					display: {
						type: 'table',
						columns: [{ name: 'SkillName' }, { name: 'Refs', agg: 'COUNT' }],
						groupBy: ['SkillName'],
					},
				},
			},
			'<table><thead><tr><th>W</th><th>C</th></tr></thead><tbody data-kw-bind="weekly"></tbody></table>'
			+ '<table><thead><tr><th>S</th><th>R</th></tr></thead><tbody data-kw-bind="skills"></tbody></table>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		// Both tables should produce independent DAX — verify two SUMMARIZE calls
		const summarizeCount = (result.match(/SUMMARIZE/g) || []).length;
		expect(summarizeCount).toBeGreaterThanOrEqual(2);
		// Both thead VARs should exist
		expect(result).toContain('_thead_0');
		expect(result).toContain('_thead_1');
	});
});

// ── Pre-aggregate (two-level aggregation) ───────────────────────────────────

describe('generateDaxMeasure — preAggregate', () => {
	it('generates two-level aggregation for table binding (session-depth pattern)', () => {
		const html = makeV1Html(
			{
				'session-depth': {
					display: {
						type: 'table',
						preAggregate: {
							groupBy: 'SessionId',
							compute: { name: 'SkillsPerSession', agg: 'DISTINCTCOUNT', column: 'SkillName' },
						},
						columns: [
							{ name: 'SkillsPerSession', header: 'Skills per Session' },
							{ name: 'SessionCount', agg: 'COUNT', format: '#,##0' },
						],
						groupBy: ['SkillsPerSession'],
						orderBy: { column: 'SkillsPerSession', direction: 'asc' },
					},
				},
			},
			'<table><thead><tr><th>D</th><th>C</th></tr></thead><tbody data-kw-bind="session-depth"></tbody></table>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		// Pre-aggregate VAR must exist with DISTINCTCOUNT
		expect(result).toContain('_pre_0');
		expect(result).toContain('VALUES(');
		expect(result).toContain('[SessionId]');
		expect(result).toContain('DISTINCTCOUNT');
		expect(result).toContain('"SkillsPerSession"');
		// Second-level uses SUMMARIZE on the pre-aggregate + FILTER/EARLIER
		expect(result).toContain('SUMMARIZE(_pre_0');
		expect(result).toContain('COUNTROWS(FILTER(_pre_0');
		expect(result).toContain('EARLIER');
		// Pre-aggregate VAR appears before rows VAR
		const preIdx = result.indexOf('_pre_0');
		const rowsIdx = result.indexOf('_rows_0');
		expect(preIdx).toBeLessThan(rowsIdx);
	});

	it('generates pre-aggregate for bar chart', () => {
		const html = makeV1Html(
			{
				'depth-chart': {
					display: {
						type: 'bar',
						preAggregate: {
							groupBy: 'SessionId',
							compute: { name: 'SkillsPerSession', agg: 'DISTINCTCOUNT', column: 'SkillName' },
						},
						groupBy: 'SkillsPerSession',
						value: { agg: 'COUNT', format: '#,##0' },
					},
				},
			},
			'<div data-kw-bind="depth-chart"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('_pre_0');
		expect(result).toContain('VALUES(');
		expect(result).toContain('DISTINCTCOUNT');
		expect(result).toContain('<svg');
		expect(result).toContain('<rect');
	});

	it('table without preAggregate is unchanged (regression)', () => {
		const html = makeV1Html(
			{
				'top-skills': {
					display: {
						type: 'table',
						columns: [{ name: 'SkillName' }, { name: 'Refs', agg: 'COUNT' }],
						groupBy: ['SkillName'],
					},
				},
			},
			'<table data-kw-bind="top-skills"><thead><tr><th>S</th><th>R</th></tr></thead><tbody></tbody></table>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).not.toContain('_pre_');
		expect(result).toContain('SUMMARIZE');
		expect(result).toContain("'Fact_Events'[SkillName]");
	});

	it('uses unqualified column references for pre-aggregate groupBy', () => {
		const html = makeV1Html(
			{
				'depth': {
					display: {
						type: 'table',
						preAggregate: {
							groupBy: 'DeviceId',
							compute: { name: 'EventCount', agg: 'COUNT' },
						},
						columns: [
							{ name: 'EventCount' },
							{ name: 'Devices', agg: 'COUNT' },
						],
						groupBy: ['EventCount'],
					},
				},
			},
			'<table><thead><tr><th>E</th><th>D</th></tr></thead><tbody data-kw-bind="depth"></tbody></table>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		// groupBy should be unqualified [EventCount], NOT 'Fact_Events'[EventCount]
		expect(result).toContain('SUMMARIZE(_pre_0, [EventCount])');
		expect(result).not.toContain("'Fact_Events'[EventCount]");
	});

	it('supports DISTINCTCOUNT as second-level aggregation', () => {
		const html = makeV1Html(
			{
				'depth': {
					display: {
						type: 'table',
						preAggregate: {
							groupBy: 'SessionId',
							compute: { name: 'SkillsPerSession', agg: 'DISTINCTCOUNT', column: 'SkillName' },
						},
						columns: [
							{ name: 'SkillsPerSession' },
							{ name: 'UniqueDevices', agg: 'DISTINCTCOUNT', sourceColumn: 'DeviceId' },
						],
						groupBy: ['SkillsPerSession'],
					},
				},
			},
			'<table><thead><tr><th>D</th><th>U</th></tr></thead><tbody data-kw-bind="depth"></tbody></table>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('COUNTROWS(DISTINCT(SELECTCOLUMNS(');
		expect(result).toContain('[DeviceId]');
	});

	it('bar chart preAggregate dispatches on value.agg (SUM)', () => {
		const html = makeV1Html(
			{
				'chart': {
					display: {
						type: 'bar',
						preAggregate: {
							groupBy: 'DeviceId',
							compute: { name: 'EventCount', agg: 'COUNT' },
						},
						groupBy: 'EventCount',
						value: { agg: 'SUM', column: 'EventCount' },
					},
				},
			},
			'<div data-kw-bind="chart"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('SUMX(FILTER(_pre_0');
		expect(result).not.toContain('COUNTROWS(FILTER(_pre_0');
	});

	it('pie chart preAggregate dispatches on value.agg', () => {
		const html = makeV1Html(
			{
				'chart': {
					display: {
						type: 'pie',
						preAggregate: {
							groupBy: 'DeviceId',
							compute: { name: 'EventCount', agg: 'COUNT' },
						},
						groupBy: 'EventCount',
						value: { agg: 'SUM', column: 'EventCount' },
					},
				},
			},
			'<div data-kw-bind="chart"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('SUMX(FILTER(_pre_0');
	});

	it('line chart supports preAggregate', () => {
		const html = makeV1Html(
			{
				'trend': {
					display: {
						type: 'line',
						preAggregate: {
							groupBy: 'SessionId',
							compute: { name: 'SkillsPerSession', agg: 'DISTINCTCOUNT', column: 'SkillName' },
						},
						xAxis: 'SkillsPerSession',
						series: [{ agg: 'COUNT', label: 'Sessions' }],
					},
				},
			},
			'<div data-kw-bind="trend"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('_pre_0');
		expect(result).toContain('SUMMARIZE(_pre_0');
		expect(result).toContain('<polyline');
		expect(result).toContain('COUNTROWS(FILTER(_pre_0');
	});

	it('pivot supports preAggregate with multi-column groupBy', () => {
		const html = makeV1Html(
			{
				'pivot': {
					display: {
						type: 'pivot',
						preAggregate: {
							groupBy: ['SessionId', 'ClientName'],
							compute: { name: 'SkillCount', agg: 'DISTINCTCOUNT', column: 'SkillName' },
						},
						rows: ['ClientName'],
						pivotBy: 'SkillCount',
						pivotValues: ['1', '2', '3'],
						value: 'SkillCount',
						agg: 'COUNT',
						total: true,
					},
				},
			},
			'<table data-kw-bind="pivot"><thead><tr><th>C</th></tr></thead><tbody></tbody></table>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		// Multi-column groupBy → SUMMARIZE instead of VALUES
		expect(result).toContain("SUMMARIZE('Fact_Events'");
		expect(result).toContain('[SessionId]');
		expect(result).toContain('[ClientName]');
		// Pre-agg VAR must exist before rows VAR
		expect(result).toContain('_pre_0');
		// Pivot cells use FILTER on pre-agg VAR
		expect(result).toContain('FILTER(_pre_0');
		// Total cell also uses FILTER on pre-agg
		expect(result).toContain('<strong>');
	});

	it('preAggregate groupBy as single-element array normalizes correctly', () => {
		const html = makeV1Html(
			{
				'depth': {
					display: {
						type: 'table',
						preAggregate: {
							groupBy: ['SessionId'],
							compute: { name: 'SkillsPerSession', agg: 'DISTINCTCOUNT', column: 'SkillName' },
						},
						columns: [
							{ name: 'SkillsPerSession' },
							{ name: 'Count', agg: 'COUNT' },
						],
						groupBy: ['SkillsPerSession'],
					},
				},
			},
			'<table><thead><tr><th>D</th><th>C</th></tr></thead><tbody data-kw-bind="depth"></tbody></table>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		// Single-element array → VALUES (not SUMMARIZE)
		expect(result).toContain('VALUES(');
		expect(result).not.toContain('SUMMARIZE(\'Fact_Events\'');
	});
});

// ── SVG chart binding DAX generation ────────────────────────────────────────

describe('generateDaxMeasure — bar chart', () => {
	it('generates SUMMARIZE + CONCATENATEX with SVG rect elements', () => {
		const html = makeV1Html(
			{
				'os-chart': {
					display: {
						type: 'bar', groupBy: 'OS',
						value: { agg: 'COUNT', format: '#,##0' },
					},
				},
			},
			'<div data-kw-bind="os-chart"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('SUMMARIZE');
		expect(result).toContain('CONCATENATEX');
		expect(result).toContain('<rect');
		expect(result).toContain('<text');
		expect(result).toContain('<svg');
		expect(result).toContain('RETURN');
	});

	it('exports bar charts with fixed chart sizing and tie-safe row indexes', () => {
		const html = makeV1Html(
			{
				'os-chart': {
					display: {
						type: 'bar', groupBy: 'OS',
						value: { agg: 'COUNT', format: '#,##0' },
					},
				},
			},
			'<div data-kw-bind="os-chart"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain(`<svg class='chart-svg' viewBox='0 0 ${DASHBOARD_BAR_CHART.totalW} `);
		expect(result).toContain("style='width:100%;height:");
		expect(result).toContain("px;display:block'");
		expect(result).toContain(`MAX(${DASHBOARD_BAR_CHART.minH}, ${DASHBOARD_BAR_CHART.padT + DASHBOARD_BAR_CHART.padB} + COUNTROWS(_barrows_0) * ${DASHBOARD_BAR_CHART.rowH + DASHBOARD_BAR_CHART.gap})`);
		expect(result).toContain('VAR _barrows_0 = ADDCOLUMNS(_bardata_0, "Idx", VAR _v = [Val]');
		expect(result).toContain('COUNTROWS(FILTER(_bardata_0');
		expect(result).toContain("'Fact_Events'[OS] <= _label");
		expect(result).not.toContain('RANKX(_bardata_0, [Val]');
	});

	it('replaces chart targets on hyphenated custom elements', () => {
		const html = makeV1Html(
			{
				'os-chart': {
					display: {
						type: 'bar', groupBy: 'OS',
						value: { agg: 'COUNT', format: '#,##0' },
					},
				},
			},
			'<kw-card data-kw-bind="os-chart"></kw-card>',
		);

		const result = generateDaxMeasure(html, [factDataSource]);

		expect(findUnsupportedPowerBiBindings(html)).toEqual([]);
		expect(result).toContain('<kw-card data-kw-bind=""os-chart"">" & _bar_0 & "</kw-card>');
	});

	it('applies exact top count when top is specified', () => {
		const html = makeV1Html(
			{
				'top-os': {
					display: {
						type: 'bar', groupBy: 'OS',
						value: { agg: 'COUNT' }, top: 5,
					},
				},
			},
			'<div data-kw-bind="top-os"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('FILTER(ADDCOLUMNS(_bardata_0, "Idx"');
		expect(result).toContain('[Idx] <= 5');
		expect(result).not.toContain('TOPN(5');
	});

	it('guards against division by zero with IF(_barmax = 0)', () => {
		const html = makeV1Html(
			{
				'chart': {
					display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' } },
				},
			},
			'<div data-kw-bind="chart"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('IF(');
		expect(result).toContain('= 0');
	});

	it('preserves custom value formats through DAX FORMAT', () => {
		const html = makeV1Html(
			{
				'currency-chart': {
					display: { type: 'bar', groupBy: 'OS', value: { agg: 'SUM', column: 'Actions', format: '$#,##0' } },
				},
				'unit-chart': {
					display: { type: 'bar', groupBy: 'OS', value: { agg: 'SUM', column: 'Actions', format: '#,##0 ms' } },
				},
			},
			'<div data-kw-bind="currency-chart"></div><div data-kw-bind="unit-chart"></div>',
		);

		const result = generateDaxMeasure(html, [factDataSource]);

		expect(result).toContain('FORMAT([Val], "$#,##0")');
		expect(result).toContain('FORMAT([Val], "#,##0 ms")');
	});

	it('formats datetime bar category labels explicitly', () => {
		const html = makeV1Html(
			{
				'day-chart': {
					display: { type: 'bar', groupBy: 'Day', value: { agg: 'COUNT' } },
				},
			},
			'<div data-kw-bind="day-chart"></div>',
		);

		const result = generateDaxMeasure(html, [factDataSource]);

		expect(result).toContain('FORMAT(\'Fact_Events\'[Day], "yyyy-MM-dd")');
	});

	it('formats numeric bar category labels explicitly', () => {
		const html = makeV1Html(
			{
				'bucket-chart': {
					display: { type: 'bar', groupBy: 'Bucket', value: { agg: 'COUNT' } },
				},
			},
			'<div data-kw-bind="bucket-chart"></div>',
		);
		const dataSource = { ...factDataSource, columns: [...factDataSource.columns, { name: 'Bucket', type: 'long' }] };

		const result = generateDaxMeasure(html, [dataSource]);

		expect(result).toContain('FORMAT(\'Fact_Events\'[Bucket], "#,##0.##")');
	});

	it('clamps negative bar widths to zero while preserving raw value labels', () => {
		const html = makeV1Html(
			{
				'chart': {
					display: { type: 'bar', groupBy: 'OS', value: { agg: 'SUM', column: 'Actions' } },
				},
			},
			'<div data-kw-bind="chart"></div>',
		);

		const result = generateDaxMeasure(html, [factDataSource]);

		expect(result).toContain('VAR _barmax_0 = MAXX(_barrows_0, MAX(0, [Val]))');
		expect(result).toContain('VAR _barval = MAX(0, [Val])');
		expect(result).toContain('VAR _w = IF(_barmax_0 = 0, 0, _barval / _barmax_0');
		expect(result).toContain('FORMAT([Val], "#,##0")');
	});

	it('XML-escapes label values with SUBSTITUTE', () => {
		const html = makeV1Html(
			{
				'chart': {
					display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' } },
				},
			},
			'<div data-kw-bind="chart"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('SUBSTITUTE');
		expect(result).toContain('&amp;');
	});

	it('supports DISTINCTCOUNT aggregation', () => {
		const html = makeV1Html(
			{
				'chart': {
					display: { type: 'bar', groupBy: 'OS', value: { agg: 'DISTINCTCOUNT', column: 'DeviceId' } },
				},
			},
			'<div data-kw-bind="chart"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('DISTINCTCOUNT');
		expect(result).toContain('[DeviceId]');
	});

	it('generates segmented normalized distribution bar DAX without same-call Val reuse', () => {
		const html = makeV1Html(
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
		);

		const result = generateDaxMeasure(html, [barDataSource]);

		expect(result).toContain('"Seg0", CALCULATE(SUMX');
		expect(result).toContain('"Seg1", CALCULATE(SUMX');
		expect(result).toContain('"Val", MAX(0, CALCULATE(SUMX');
		expect(result).toContain('VAR _den = _barval');
		expect(result).toContain("height='8'");
		expect(result).toContain("rx='0'");
		expect(result).not.toContain('"Val", MAX(0, [Seg0])');
		expect((result.match(/<rect/g) || [])).toHaveLength(2);
	});

	it('generates threshold band clamp expressions against an explicit domain', () => {
		const html = makeV1Html(
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
		);

		const result = generateDaxMeasure(html, [barDataSource]);

		expect(result).toContain('VAR _den = 100');
		expect(result).toContain('VAR _fillval = MIN(_barval, _den)');
		expect(result).toContain('VAR _seg0 = MAX(0, MIN(_barval, 50) - 0)');
		expect(result).toContain('VAR _seg1 = MAX(0, MIN(_barval, 100) - 50)');
		expect(result).toContain('FORMAT(_y + 16, "0")');
		expect((result.match(/<rect/g) || [])).toHaveLength(2);
	});

	it('generates color rule SWITCH expressions for whole-bar coloring', () => {
		const html = makeV1Html(
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
		);

		const result = generateDaxMeasure(html, [barDataSource]);

		expect(result).toContain('SWITCH(TRUE(), [Val] >= 0.1, "#C62828", [Val] < 0.1, "#2E7D32"');
		expect(result).toContain('VAR _col = SWITCH(TRUE()');
		expect((result.match(/<rect/g) || [])).toHaveLength(1);
	});
});

describe('generateDaxMeasure — pie chart', () => {
	it('generates SVG circles with stroke-dasharray', () => {
		const html = makeV1Html(
			{
				'os-pie': {
					display: {
						type: 'pie', groupBy: 'OS',
						value: { agg: 'COUNT' },
					},
				},
			},
			'<div data-kw-bind="os-pie"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('<circle');
		expect(result).toContain('stroke-dasharray');
		expect(result).toContain('stroke-dashoffset');
		expect(result).toContain('PI()');
		expect(result).toContain('<svg');
	});

	it('exports pie charts with chart sizing, legend, and tie-safe slice indexes', () => {
		const html = makeV1Html(
			{
				'os-pie': {
					display: {
						type: 'pie', groupBy: 'OS',
						value: { agg: 'COUNT', format: '#,##0' },
					},
				},
			},
			'<div data-kw-bind="os-pie"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain(`<svg class='chart-svg' viewBox='0 0 ${DASHBOARD_PIE_CHART.svgW} `);
		expect(result).toContain("style='width:100%;height:");
		expect(result).toContain("px;display:block'");
		expect(result).toContain(`MAX(${DASHBOARD_PIE_CHART.minSvgH}, ${DASHBOARD_PIE_CHART.legendY + DASHBOARD_PIE_CHART.legendPadB} + COUNTROWS(_pieslices_0) * ${DASHBOARD_PIE_CHART.legendRowH})`);
		expect(result).toContain('VAR _pierows_0 = ADDCOLUMNS(_piedata_0, "Idx", VAR _v = [Val]');
		expect(result).toContain('VAR _pieslices_0 = ADDCOLUMNS(_pierows_0, "PrevSum"');
		expect(result).toContain('<rect x=');
		expect(result).toContain('DIVIDE([Val], _pietotal_0, 0)');
		expect(result).not.toContain('RANKX(_piedata_0, [Val]');
	});

	it('formats datetime pie category labels explicitly', () => {
		const html = makeV1Html(
			{
				'day-pie': {
					display: { type: 'pie', groupBy: 'Day', value: { agg: 'COUNT' } },
				},
			},
			'<div data-kw-bind="day-pie"></div>',
		);

		const result = generateDaxMeasure(html, [factDataSource]);

		expect(result).toContain('FORMAT(\'Fact_Events\'[Day], "yyyy-MM-dd")');
	});

	it('formats numeric pie category labels explicitly', () => {
		const html = makeV1Html(
			{
				'bucket-pie': {
					display: { type: 'pie', groupBy: 'Bucket', value: { agg: 'COUNT' } },
				},
			},
			'<div data-kw-bind="bucket-pie"></div>',
		);
		const dataSource = { ...factDataSource, columns: [...factDataSource.columns, { name: 'Bucket', type: 'long' }] };

		const result = generateDaxMeasure(html, [dataSource]);

		expect(result).toContain('FORMAT(\'Fact_Events\'[Bucket], "#,##0.##")');
	});

	it('computes running totals with SUMX + FILTER', () => {
		const html = makeV1Html(
			{
				'pie': {
					display: { type: 'pie', groupBy: 'OS', value: { agg: 'COUNT' } },
				},
			},
			'<div data-kw-bind="pie"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('SUMX(FILTER');
		expect(result).toContain('[Idx]');
	});

	it('guards against zero total', () => {
		const html = makeV1Html(
			{
				'pie': {
					display: { type: 'pie', groupBy: 'OS', value: { agg: 'COUNT' } },
				},
			},
			'<div data-kw-bind="pie"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('IF(');
		expect(result).toContain('= 0');
	});

	it('applies exact top count when top is specified', () => {
		const html = makeV1Html(
			{
				'pie': {
					display: { type: 'pie', groupBy: 'OS', value: { agg: 'COUNT' }, top: 6 },
				},
			},
			'<div data-kw-bind="pie"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('FILTER(ADDCOLUMNS(_piedata_0, "Idx"');
		expect(result).toContain('[Idx] <= 6');
		expect(result).not.toContain('TOPN(6');
	});
});

describe('generateDaxMeasure — line chart', () => {
	it('generates SVG polyline with CONCATENATEX for points', () => {
		const html = makeV1Html(
			{
				'trend': {
					display: {
						type: 'line', xAxis: 'Day',
						series: [{ agg: 'COUNT', label: 'Calls' }],
					},
				},
			},
			'<div data-kw-bind="trend"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('<polyline');
		expect(result).toContain('points=');
		expect(result).toContain('CONCATENATEX');
		expect(result).toContain('<svg');
	});

	it('exports line charts with preview-like fixed sizing and axes', () => {
		const html = makeV1Html(
			{
				'trend': {
					display: {
						type: 'line', xAxis: 'Day',
						series: [{ agg: 'SUM', column: 'Actions', label: 'Actions' }],
					},
				},
			},
			'<div data-kw-bind="trend"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		const plotBottom = DASHBOARD_LINE_CHART.padT + (DASHBOARD_LINE_CHART.H - DASHBOARD_LINE_CHART.padT - DASHBOARD_LINE_CHART.padB);
		const legendY = plotBottom + DASHBOARD_LINE_CHART.xLabelGap + DASHBOARD_LINE_CHART.legendTopGap;
		expect(result).toContain(`<svg class='chart-svg' viewBox='0 0 ${DASHBOARD_LINE_CHART.W} ${DASHBOARD_LINE_CHART.H}'`);
		expect(result).toContain(`style='width:100%;height:${DASHBOARD_LINE_CHART.H}px;display:block'`);
		expect(result).toContain("<line x1='52'");
		expect(result).toContain('text-anchor=');
		expect(result).toContain('_linexfirstlabel_0');
		expect(result).toContain('_linexlastlabel_0');
		expect(result).toContain('stroke-linecap=');
		expect(result).toContain('Actions</text>');
		expect(result).toContain(`<line x1='${DASHBOARD_LINE_CHART.padL}' y1='${legendY - 4}'`);
		expect(result).toContain(`y='${legendY}' font-size='${DASHBOARD_LINE_CHART.labelFontSize}' fill='${DASHBOARD_LINE_CHART.labelFill}'>Actions</text>`);
		expect(result).toContain('VAR _linemarker_0_0 = IF(_linen_0 = 1');
		expect(result).toContain(`VAR _x = ${DASHBOARD_LINE_CHART.padL + (DASHBOARD_LINE_CHART.W - DASHBOARD_LINE_CHART.padL - DASHBOARD_LINE_CHART.padR) / 2}`);
		expect(result).toContain(`IF(_linerange_0 = 0, ${(DASHBOARD_LINE_CHART.H - DASHBOARD_LINE_CHART.padT - DASHBOARD_LINE_CHART.padB) / 2}`);
		expect(result).toContain('<circle cx=');
	});

	it('uses modulo color selection for line series beyond ten', () => {
		const colors = [
			'#010101', '#020202', '#030303', '#040404', '#050505', '#060606',
			'#070707', '#080808', '#090909', '#101010', '#111111',
		];
		const html = makeV1Html(
			{
				'trend': {
					display: {
						type: 'line', xAxis: 'Day',
						series: colors.map((_, index) => ({ agg: 'COUNT', label: `Series ${index + 1}` })),
						colors,
					},
				},
			},
			'<div data-kw-bind="trend"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain("stroke='#111111'");
		expect(result).toContain('Series 11</text>');
	});

	it('computes Y scaling with MIN/MAX/range guards', () => {
		const html = makeV1Html(
			{
				'trend': {
					display: {
						type: 'line', xAxis: 'Day',
						series: [{ agg: 'COUNT' }],
					},
				},
			},
			'<div data-kw-bind="trend"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('_linemin_');
		expect(result).toContain('_linemax_');
		expect(result).toContain('VAR _linerange_0 = _linemax_0 - _linemin_0');
		expect(result).toContain('IF(');
	});

	it('handles single data point with center-x guard', () => {
		const html = makeV1Html(
			{
				'trend': {
					display: {
						type: 'line', xAxis: 'Day',
						series: [{ agg: 'COUNT' }],
					},
				},
			},
			'<div data-kw-bind="trend"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('IF(_linen_');
		expect(result).toContain('<= 1');
	});

	it('generates multiple polylines for multi-series', () => {
		const html = makeV1Html(
			{
				'trend': {
					display: {
						type: 'line', xAxis: 'Day',
						series: [
							{ agg: 'COUNT', label: 'Calls' },
							{ agg: 'DISTINCTCOUNT', column: 'DeviceId', label: 'Devices' },
						],
					},
				},
			},
			'<div data-kw-bind="trend"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		const polylineCount = (result.match(/<polyline/g) || []).length;
		expect(polylineCount).toBe(2);
		// Each series gets a distinct points VAR
		expect(result).toContain('_linepts_0_0');
		expect(result).toContain('_linepts_0_1');
	});

	it('nests line chart Y scale MIN/MAX for three or more series', () => {
		const html = makeV1Html(
			{
				'trend': {
					display: {
						type: 'line', xAxis: 'Day',
						series: [
							{ agg: 'SUM', column: 'InternalActions', label: 'Internal' },
							{ agg: 'SUM', column: 'ExternalEnterpriseActions', label: 'Enterprise' },
							{ agg: 'SUM', column: 'ExternalNonEnterpriseActions', label: 'Non-enterprise' },
						],
					},
				},
			},
			'<div data-kw-bind="trend"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('VAR _linemin_0 = MIN(MIN(MINX(_linedata_0, [S0]), MINX(_linedata_0, [S1])), MINX(_linedata_0, [S2]))');
		expect(result).toContain('VAR _linemax_0 = MAX(MAX(MAXX(_linedata_0, [S0]), MAXX(_linedata_0, [S1])), MAXX(_linedata_0, [S2]))');
		expect(result).not.toContain('VAR _linemin_0 = MIN(MINX(_linedata_0, [S0]), MINX(_linedata_0, [S1]), MINX(_linedata_0, [S2]))');
		expect(result).not.toContain('VAR _linemax_0 = MAX(MAXX(_linedata_0, [S0]), MAXX(_linedata_0, [S1]), MAXX(_linedata_0, [S2]))');
	});
});

describe('generateDaxMeasure — mixed chart + scalar + table', () => {
	it('generates independent VARs for scalar, table, and chart in same dashboard', () => {
		const html = makeV1Html(
			{
				'total': { display: { type: 'scalar', agg: 'COUNT' } },
				'top-skills': {
					display: {
						type: 'table',
						columns: [{ name: 'SkillName' }, { name: 'Refs', agg: 'COUNT' }],
						groupBy: ['SkillName'],
					},
				},
				'os-chart': {
					display: { type: 'bar', groupBy: 'OS', value: { agg: 'COUNT' } },
				},
			},
			'<span data-kw-bind="total">0</span>'
			+ '<table data-kw-bind="top-skills"><thead><tr><th>S</th><th>R</th></tr></thead><tbody></tbody></table>'
			+ '<div data-kw-bind="os-chart"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		// All three types present
		expect(result).toContain('_scalar_');
		expect(result).toContain('_thead_');
		expect(result).toContain('_rows_');
		expect(result).toContain('_bar_');
		expect(result).toContain('<svg');
		expect(result).toContain('<rect');
		expect(result).toContain('RETURN');
	});
});

// ── CSS custom-property resolution ──────────────────────────────────────────

describe('resolveCssVariables', () => {
	it('resolves :root variables in style blocks', () => {
		const html = '<style>:root{--bg:#0d1117;--text:#e6edf3}body{background:var(--bg);color:var(--text)}</style>';
		const result = resolveCssVariables(html);
		expect(result).toContain('background:#0d1117');
		expect(result).toContain('color:#e6edf3');
		expect(result).not.toContain('var(--bg)');
		expect(result).not.toContain('var(--text)');
	});

	it('resolves variables defined on body selector', () => {
		const html = '<style>body{--accent:#58a6ff;color:var(--accent)}</style>';
		const result = resolveCssVariables(html);
		expect(result).toContain('color:#58a6ff');
	});

	it('resolves variables defined on html selector', () => {
		const html = '<style>html{--x:red}.cls{color:var(--x)}</style>';
		const result = resolveCssVariables(html);
		expect(result).toContain('color:red');
	});

	it('handles var(--name, fallback) syntax', () => {
		const html = '<style>:root{--a:blue}div{color:var(--a, red);border:var(--missing, 1px solid gray)}</style>';
		const result = resolveCssVariables(html);
		expect(result).toContain('color:blue');
		expect(result).toContain('border:1px solid gray');
	});

	it('handles fallback with nested parentheses', () => {
		const html = '<style>:root{--x:red}div{color:var(--missing, rgba(0,0,0,.5))}</style>';
		const result = resolveCssVariables(html);
		expect(result).toContain('color:rgba(0,0,0,.5)');
	});

	it('resolves variable chains (var referencing another var)', () => {
		const html = '<style>:root{--base:#fff;--bg:var(--base)}body{background:var(--bg)}</style>';
		const result = resolveCssVariables(html);
		expect(result).toContain('background:#fff');
	});

	it('resolves variables in inline style attributes', () => {
		const html = '<style>:root{--bg:#0d1117}</style><body style="background:var(--bg)">';
		const result = resolveCssVariables(html);
		expect(result).toContain('style="background:#0d1117"');
	});

	it('does not touch script content', () => {
		const html = '<style>:root{--x:red}</style><script>var s = "var(--x)";</script><div style="color:var(--x)">test</div>';
		const result = resolveCssVariables(html);
		// Script content preserved
		expect(result).toContain('<script>var s = "var(--x)";</script>');
		// Style resolved
		expect(result).toContain('style="color:red"');
	});

	it('returns input unchanged when no CSS variables exist', () => {
		const html = '<style>body{color:white}</style><div>test</div>';
		expect(resolveCssVariables(html)).toBe(html);
	});

	it('handles multi-word values like font stacks', () => {
		const html = "<style>:root{--font:'Segoe UI',sans-serif}body{font-family:var(--font)}</style>";
		const result = resolveCssVariables(html);
		expect(result).toContain("font-family:'Segoe UI',sans-serif");
	});

	it('preserves unresolvable variables without fallback', () => {
		const html = '<style>div{color:var(--undefined-var)}</style>';
		const result = resolveCssVariables(html);
		expect(result).toContain('var(--undefined-var)');
	});
});

describe('resolveCssVariables + extractHtmlBackground integration', () => {
	it('extractHtmlBackground returns literal color after CSS variable resolution', () => {
		const html = '<style>:root{--bg:#0d1117}body{background:var(--bg);color:#e6edf3}</style>';
		const resolved = resolveCssVariables(html);
		// generateHtmlMeasureTmdl uses extractHtmlBackground internally,
		// but we can verify the resolved HTML would match the regex
		expect(resolved).toContain('background:#0d1117');
	});
});

describe('resolveCssVariables + generateDaxMeasure integration', () => {
	it('DAX measure contains resolved colors, not var() references', () => {
		const darkCss = ':root{--bg:#0d1117;--text:#e6edf3;--accent:#58a6ff}';
		const html = `<html><head><style>${darkCss}body{background:var(--bg);color:var(--text)}</style></head><body><div>Hello</div></body></html>`;
		const resolved = resolveCssVariables(html);
		const dax = generateDaxMeasure(resolved, []);
		expect(dax).toContain('#0d1117');
		expect(dax).toContain('#e6edf3');
		expect(dax).not.toContain('var(--bg)');
		expect(dax).not.toContain('var(--text)');
	});
});

// ── PBI visual CSS patching (body selector → .kw-pbi-root) ─────────────────

describe('patchCssForPbiVisual', () => {
	it('duplicates body selector with .kw-pbi-root', () => {
		const html = '<style>body{color:#e6edf3;padding:24px}</style><body><div>Hi</div></body>';
		const result = patchCssForPbiVisual(html);
		expect(result).toContain('body,.kw-pbi-root{color:#e6edf3;padding:24px}');
	});

	it('does not match tbody', () => {
		const html = '<style>tbody{border:none}</style><body><table><tbody></tbody></table></body>';
		const result = patchCssForPbiVisual(html);
		// tbody should NOT get .kw-pbi-root duplicate
		expect(result).not.toContain('.kw-pbi-root{border:none}');
		expect(result).toContain('tbody{border:none}');
	});

	it('handles compound selector: body .foo', () => {
		const html = '<style>body .foo{color:red}</style><body><div class="foo">X</div></body>';
		const result = patchCssForPbiVisual(html);
		expect(result).toContain('.kw-pbi-root .foo');
		expect(result).toContain('body .foo');
	});

	it('handles comma-separated selectors with body', () => {
		const html = '<style>html,body{margin:0}</style><body><div>X</div></body>';
		const result = patchCssForPbiVisual(html);
		expect(result).toContain('.kw-pbi-root');
		expect(result).toContain('html');
		expect(result).toContain('body');
	});

	it('wraps body content in .kw-pbi-root div', () => {
		const html = '<html><head></head><body><div>Content</div></body></html>';
		const result = patchCssForPbiVisual(html);
		expect(result).toContain('<div class="kw-pbi-root"><div>Content</div></div>');
	});

	it('wraps content after </head> when no body tag', () => {
		const html = '<html><head><style>body{color:white}</style></head><div>Content</div></html>';
		const result = patchCssForPbiVisual(html);
		expect(result).toContain('<div class="kw-pbi-root">');
		expect(result).toContain('Content');
	});

	it('patches multiple body rules', () => {
		const html = '<style>body{color:white}body .panel{background:black}</style><body><div>X</div></body>';
		const result = patchCssForPbiVisual(html);
		expect(result).toContain('.kw-pbi-root{color:white}');
		expect(result).toContain('.kw-pbi-root .panel{background:black}');
	});

	it('does not affect rules without body', () => {
		const html = '<style>.panel{color:red}th{color:gray}</style><body><div>X</div></body>';
		const result = patchCssForPbiVisual(html);
		expect(result).toContain('.panel{color:red}');
		expect(result).toContain('th{color:gray}');
		// No kw-pbi-root for non-body selectors
		expect(result).not.toContain('.kw-pbi-root{color:red}');
	});
});

describe('full PBI export pipeline integration', () => {
	it('resolves CSS vars, extracts background, patches body selectors, and wraps content', () => {
		const html = '<html><head><style>:root{--bg:#0d1117;--text:#e6edf3}body{background:var(--bg);color:var(--text)}td{padding:8px}</style></head><body><table><td>Hello</td></table></body></html>';
		const resolved = resolveCssVariables(html);
		// Background extraction works before patch
		expect(resolved).toContain('background:#0d1117');
		// Patch for PBI
		const patched = patchCssForPbiVisual(resolved);
		// .kw-pbi-root gets body styles including color
		expect(patched).toContain('.kw-pbi-root{background:#0d1117;color:#e6edf3}');
		// Content wrapped
		expect(patched).toContain('<div class="kw-pbi-root">');
		// td rule unaffected
		expect(patched).toContain('td{padding:8px}');
		// DAX measure includes the patched CSS
		const dax = generateDaxMeasure(patched, []);
		expect(dax).toContain('.kw-pbi-root');
		expect(dax).toContain('#e6edf3');
	});
});

// ── Slicer visual JSON generation ───────────────────────────────────────────

describe('generateSlicerVisualJson', () => {
	it('uses native slicer visualType', () => {
		const json = JSON.parse(generateSlicerVisualJson('s1', 'Events', 'OS', { x: 25, y: 20, width: 300, height: 60 }));
		expect(json.visual.visualType).toBe('slicer');
	});

	it('uses the correct PBIR schema version', () => {
		const json = JSON.parse(generateSlicerVisualJson('s1', 'Events', 'OS', { x: 25, y: 20, width: 300, height: 60 }));
		expect(json.$schema).toContain('visualContainer/2.8.0');
	});

	it('references the table and column in Category query state', () => {
		const json = JSON.parse(generateSlicerVisualJson('s1', 'MyTable', 'Region', { x: 0, y: 0, width: 200, height: 60 }));
		const cat = json.visual.query.queryState.Category;
		expect(cat).toBeDefined();
		expect(cat.projections).toHaveLength(1);
		expect(cat.projections[0].field.Column.Expression.SourceRef.Entity).toBe('MyTable');
		expect(cat.projections[0].field.Column.Property).toBe('Region');
		expect(cat.projections[0].queryRef).toBe('MyTable.Region');
		expect(cat.projections[0].nativeQueryRef).toBe('Region');
	});

	it('positions the visual using provided coordinates', () => {
		const json = JSON.parse(generateSlicerVisualJson('s1', 'T', 'C', { x: 50, y: 20, width: 400, height: 60 }));
		expect(json.position.x).toBe(50);
		expect(json.position.y).toBe(20);
		expect(json.position.width).toBe(400);
		expect(json.position.height).toBe(60);
		expect(json.position.z).toBe(1);
	});

	it('defaults to Dropdown mode', () => {
		const json = JSON.parse(generateSlicerVisualJson('s1', 'T', 'C', { x: 0, y: 0, width: 200, height: 60 }));
		expect(json.visual.objects.data[0].properties.mode.expr.Literal.Value).toBe("'Dropdown'");
	});

	it('supports List mode', () => {
		const json = JSON.parse(generateSlicerVisualJson('s1', 'T', 'C', { x: 0, y: 0, width: 200, height: 60 }, 'list'));
		expect(json.visual.objects.data[0].properties.mode.expr.Literal.Value).toBe("'Basic'");
	});

	it('supports Between mode', () => {
		const json = JSON.parse(generateSlicerVisualJson('s1', 'T', 'C', { x: 0, y: 0, width: 200, height: 60 }, 'between'));
		expect(json.visual.objects.data[0].properties.mode.expr.Literal.Value).toBe("'Between'");
	});

	it('Between mode includes Values projection with active flag', () => {
		const json = JSON.parse(generateSlicerVisualJson('s1', 'MyTable', 'Day', { x: 0, y: 0, width: 200, height: 60 }, 'between'));
		const values = json.visual.query.queryState.Values;
		expect(values).toBeDefined();
		expect(values.projections).toHaveLength(1);
		expect(values.projections[0].field.Column.Property).toBe('Day');
		expect(values.projections[0].field.Column.Expression.SourceRef.Entity).toBe('MyTable');
		expect(values.projections[0].active).toBe(true);
	});

	it('Between mode includes sortDefinition', () => {
		const json = JSON.parse(generateSlicerVisualJson('s1', 'MyTable', 'Day', { x: 0, y: 0, width: 200, height: 60 }, 'between'));
		const sort = json.visual.query.sortDefinition;
		expect(sort).toBeDefined();
		expect(sort.isDefaultSort).toBe(true);
		expect(sort.sort).toHaveLength(1);
		expect(sort.sort[0].direction).toBe('Ascending');
		expect(sort.sort[0].field.Column.Property).toBe('Day');
	});

	it('Between mode includes filterConfig', () => {
		const json = JSON.parse(generateSlicerVisualJson('s1', 'MyTable', 'Day', { x: 0, y: 0, width: 200, height: 60 }, 'between'));
		expect(json.filterConfig).toBeDefined();
		expect(json.filterConfig.filters).toHaveLength(1);
		expect(json.filterConfig.filters[0].type).toBe('Categorical');
		expect(json.filterConfig.filters[0].field.Column.Property).toBe('Day');
	});

	it('Dropdown mode includes Values projection with active flag', () => {
		const json = JSON.parse(generateSlicerVisualJson('s1', 'T', 'C', { x: 0, y: 0, width: 200, height: 60 }, 'dropdown'));
		const values = json.visual.query.queryState.Values;
		expect(values).toBeDefined();
		expect(values.projections[0].active).toBe(true);
	});

	it('Dropdown mode includes filterConfig', () => {
		const json = JSON.parse(generateSlicerVisualJson('s1', 'T', 'C', { x: 0, y: 0, width: 200, height: 60 }, 'dropdown'));
		expect(json.filterConfig).toBeDefined();
		expect(json.filterConfig.filters).toHaveLength(1);
		expect(json.filterConfig.filters[0].type).toBe('Categorical');
	});

	it('Dropdown mode does not include sortDefinition', () => {
		const json = JSON.parse(generateSlicerVisualJson('s1', 'T', 'C', { x: 0, y: 0, width: 200, height: 60 }, 'dropdown'));
		expect(json.visual.query.sortDefinition).toBeUndefined();
	});

	it('sets tabOrder from parameter', () => {
		const json = JSON.parse(generateSlicerVisualJson('s1', 'T', 'C', { x: 0, y: 0, width: 200, height: 60 }, 'dropdown', 3));
		expect(json.position.tabOrder).toBe(3);
	});

	it('uses the provided visual name', () => {
		const json = JSON.parse(generateSlicerVisualJson('mySlicerId', 'T', 'C', { x: 0, y: 0, width: 200, height: 60 }));
		expect(json.name).toBe('mySlicerId');
	});

	it('enables drillFilterOtherVisuals', () => {
		const json = JSON.parse(generateSlicerVisualJson('s1', 'T', 'C', { x: 0, y: 0, width: 200, height: 60 }));
		expect(json.visual.drillFilterOtherVisuals).toBe(true);
	});
});

// ── HTML Content visual with yOffset ────────────────────────────────────────

describe('generateHtmlContentVisualJson — with yOffset', () => {
	it('positions visual at y=0 with default height when no yOffset', () => {
		const json = JSON.parse(generateHtmlContentVisualJson('vis1'));
		expect(json.position.y).toBe(0);
		expect(json.position.height).toBe(720);
	});

	it('positions visual at y=0 with default when yOffset is 0', () => {
		const json = JSON.parse(generateHtmlContentVisualJson('vis1', 1000, 0));
		expect(json.position.y).toBe(0);
		expect(json.position.height).toBe(1000);
	});

	it('offsets y and reduces height when yOffset is provided', () => {
		const json = JSON.parse(generateHtmlContentVisualJson('vis1', 1000, 100));
		expect(json.position.y).toBe(100);
		expect(json.position.height).toBe(900);
	});

	it('preserves existing tests — width is still 1450', () => {
		const json = JSON.parse(generateHtmlContentVisualJson('vis1', 720, 100));
		expect(json.position.width).toBe(1450);
		expect(json.position.x).toBe(25);
	});
});

describe('resolveFactTableSlicers', () => {
	it('binds slicers directly to the fact table to avoid DirectQuery joins over let queries', () => {
		const slicers = resolveFactTableSlicers({
			...factDataSource,
			name: 'TypeSpec VS Overall-Driven User Type Fact',
			columns: [
				{ name: 'Day', type: 'datetime' },
				{ name: 'Version', type: 'string' },
				{ name: 'UserType', type: 'string' },
			],
		}, [
			{ column: 'Day', mode: 'between' },
			{ column: 'Version' },
			{ column: 'UserType' },
		]);

		expect(slicers).toEqual([
			{ tableName: 'TypeSpec_VS_Overall-Driven_User_Type_Fact', columnName: 'Day', mode: 'between' },
			{ tableName: 'TypeSpec_VS_Overall-Driven_User_Type_Fact', columnName: 'Version', mode: 'dropdown' },
			{ tableName: 'TypeSpec_VS_Overall-Driven_User_Type_Fact', columnName: 'UserType', mode: 'dropdown' },
		]);
		expect(slicers.every(s => !s.tableName.startsWith('dim_'))).toBe(true);
	});

	it('skips provenance dimensions that are not projected by the fact query', () => {
		const slicers = resolveFactTableSlicers(factDataSource, [
			{ column: 'ClientName' },
			{ column: 'MissingColumn' },
		]);
		expect(slicers.map(s => s.columnName)).toEqual(['ClientName']);
	});
});

// ── Dimension table TMDL generation ─────────────────────────────────────────

describe('generateDimTableTmdl', () => {
	it('generates a table with the dim name', () => {
		const tmdl = generateDimTableTmdl('dim_Client', 'ClientName', 'string', 'https://c.kusto.windows.net', 'db', 'T | take 100');
		expect(tmdl).toContain("table 'dim_Client'");
	});

	it('includes the column with isKey attribute', () => {
		const tmdl = generateDimTableTmdl('dim_Client', 'ClientName', 'string', 'https://c.kusto.windows.net', 'db', 'T | take 100');
		expect(tmdl).toContain("column 'ClientName'");
		expect(tmdl).toContain('isKey');
		expect(tmdl).toContain('dataType: string');
	});

	it('maps datetime column type to TMDL dateTime', () => {
		const tmdl = generateDimTableTmdl('dim_Day', 'Day', 'datetime', 'https://c.kusto.windows.net', 'db', 'T | take 100');
		expect(tmdl).toContain('dataType: dateTime');
	});

	it('appends | distinct to the source query', () => {
		const tmdl = generateDimTableTmdl('dim_OS', 'OS', 'string', 'https://c.kusto.windows.net', 'db', 'T\n| where x > 1\n| summarize count() by OS');
		expect(tmdl).toContain('| distinct OS');
		// Original query is collapsed to single line
		expect(tmdl).not.toContain('\n| where');
	});

	it('uses Import mode by default', () => {
		const tmdl = generateDimTableTmdl('dim_X', 'X', 'string', 'https://c.kusto.windows.net', 'db', 'T');
		expect(tmdl).toContain('mode: import');
	});

	it('uses DirectQuery mode when requested', () => {
		const tmdl = generateDimTableTmdl('dim_X', 'X', 'string', 'https://c.kusto.windows.net', 'db', 'T', 'directQuery');
		expect(tmdl).toContain('mode: directQuery');
	});

	it('uses AzureDataExplorer.Contents M expression', () => {
		const tmdl = generateDimTableTmdl('dim_X', 'X', 'string', 'https://cluster.kusto.windows.net', 'mydb', 'T | take 10');
		expect(tmdl).toContain('AzureDataExplorer.Contents("https://cluster.kusto.windows.net", "mydb"');
	});

	it('has exactly one column', () => {
		const tmdl = generateDimTableTmdl('dim_Version', 'Version', 'string', 'https://c.kusto.windows.net', 'db', 'T');
		const columnMatches = tmdl.match(/\tcolumn /g);
		expect(columnMatches).toHaveLength(1);
	});

	it('strips KQL single-line comments before collapsing to one line', () => {
		const query = [
			'RawEvents',
			'| where name == "skill_invocation"',
			'    // Filter out test clients',
			'    and tostring(customDimensions[\'clientname\']) !endswith \'LiveTests\'',
			'| project Day = startofday(timestamp), OS = client_OS',
		].join('\n');
		const tmdl = generateDimTableTmdl('dim_Day', 'Day', 'datetime', 'https://c.kusto.windows.net', 'db', query);
		// The | project and | distinct must survive (not be eaten by //)
		expect(tmdl).toContain('| project Day');
		expect(tmdl).toContain('| distinct Day');
		// The comment text itself must be gone
		expect(tmdl).not.toContain('Filter out test clients');
	});

	it('preserves :// in cluster URLs within KQL when stripping comments', () => {
		const query = 'cluster("https://other.kusto.windows.net").database("db").T | project X';
		const tmdl = generateDimTableTmdl('dim_X', 'X', 'string', 'https://c.kusto.windows.net', 'db', query);
		expect(tmdl).toContain('https://other.kusto.windows.net');
		expect(tmdl).toContain('| distinct X');
	});
});
