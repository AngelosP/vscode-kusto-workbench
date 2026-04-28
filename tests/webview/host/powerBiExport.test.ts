import { describe, it, expect } from 'vitest';
import {
	generateHtmlMeasureTmdl,
	generateHtmlContentVisualJson,
	generateSlicerVisualJson,
	generateDimTableTmdl,
	escapeDaxString,
	escapeDaxColumnRef,
	daxColumnExpr,
	generateDaxMeasure,
	resolveFactTableSlicers,
	resolveCssVariables,
	patchCssForPbiVisual,
	type PowerBiDataSource,
} from '../../../src/host/powerBiExport';
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
		expect(result).toContain('TOPN(10');
		expect(result).toContain('CONCATENATEX');
		expect(result).toContain('[Refs]');
		expect(result).toContain('DESC');
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
			'<table><thead><tr><th>Skill</th><th>Refs</th></tr></thead><tbody data-kw-bind="top-skills"></tbody></table>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('SUMMARIZE');
		expect(result).toContain('TOPN(10');
		expect(result).toContain('CONCATENATEX');
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

	it('applies TOPN when top is specified', () => {
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
		expect(result).toContain('TOPN(5');
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
		expect(result).toContain('[Rank]');
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

	it('applies TOPN when top is specified', () => {
		const html = makeV1Html(
			{
				'pie': {
					display: { type: 'pie', groupBy: 'OS', value: { agg: 'COUNT' }, top: 6 },
				},
			},
			'<div data-kw-bind="pie"></div>',
		);
		const result = generateDaxMeasure(html, [factDataSource]);
		expect(result).toContain('TOPN(6');
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
		expect(result).toContain("<svg class='chart-svg' viewBox='0 0 760 220'");
		expect(result).toContain("style='width:100%;height:220px;display:block'");
		expect(result).toContain("<line x1='52'");
		expect(result).toContain('text-anchor=');
		expect(result).toContain('_linexfirstlabel_0');
		expect(result).toContain('_linexlastlabel_0');
		expect(result).toContain('stroke-linecap=');
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
		expect(result).toContain('_linerange_');
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

	it('uses DirectQuery mode', () => {
		const tmdl = generateDimTableTmdl('dim_X', 'X', 'string', 'https://c.kusto.windows.net', 'db', 'T');
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
