import { describe, it, expect } from 'vitest';
import {
	generateHtmlMeasureTmdl,
	generateHtmlContentVisualJson,
	escapeDaxString,
	escapeDaxColumnRef,
	daxColumnExpr,
	generateDaxMeasure,
	resolveCssVariables,
	patchCssForPbiVisual,
	type PowerBiDataSource,
} from '../../../src/host/powerBiExport';
import { parseKwProvenance } from '../../../src/webview/sections/kw-html-section';

// ── Provenance parsing ──────────────────────────────────────────────────────

describe('parseKwProvenance', () => {
	it('extracts bindings from a valid provenance block', () => {
		const html = `
			<div>Hello</div>
			<script type="application/kw-provenance">
			{
				"version": 1,
				"bindings": {
					"sales-table": {
						"sectionId": "query_123",
						"sectionName": "Sales",
						"columns": ["Region", "Amount"]
					}
				}
			}
			</script>
		`;
		const p = parseKwProvenance(html);
		expect(p).not.toBeNull();
		expect(p!.version).toBe(1);
		expect(Object.keys(p!.bindings)).toHaveLength(1);
		expect(p!.bindings['sales-table'].sectionId).toBe('query_123');
		expect(p!.bindings['sales-table'].sectionName).toBe('Sales');
	});

	it('returns null when no provenance block exists', () => {
		expect(parseKwProvenance('<div>No provenance</div>')).toBeNull();
	});

	it('returns null for invalid JSON', () => {
		const html = '<script type="application/kw-provenance">{broken json</script>';
		expect(parseKwProvenance(html)).toBeNull();
	});

	it('handles multiple bindings', () => {
		const html = `<script type="application/kw-provenance">
		{"version":1,"bindings":{"a":{"sectionId":"query_1","sectionName":"A"},"b":{"sectionId":"query_2","sectionName":"B"}}}
		</script>`;
		const p = parseKwProvenance(html);
		expect(p).not.toBeNull();
		expect(Object.keys(p!.bindings)).toHaveLength(2);
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

// ── Dynamic DAX measure generation ──────────────────────────────────────────

const sampleDataSources: PowerBiDataSource[] = [
	{
		name: 'Regional Sales',
		sectionId: 'query_1',
		clusterUrl: 'https://cluster.kusto.windows.net',
		database: 'db',
		query: 'T | take 10',
		columns: [
			{ name: 'Region', type: 'string' },
			{ name: 'Sales', type: 'long' },
			{ name: 'Quarter', type: 'string' },
		],
	},
	{
		name: 'Categories',
		sectionId: 'query_2',
		clusterUrl: 'https://cluster.kusto.windows.net',
		database: 'db',
		query: 'T2 | take 10',
		columns: [
			{ name: 'Category', type: 'string' },
			{ name: 'Revenue', type: 'long' },
			{ name: 'Units', type: 'int' },
		],
	},
];

function makeHtmlWithProvenance(tableBindings: string[], scalarBindings: string[] = []): string {
	const bindings: Record<string, object> = {};
	if (tableBindings.includes('sales')) {
		bindings['sales-table'] = { sectionId: 'query_1', sectionName: 'Regional Sales', columns: ['Region', 'Sales', 'Quarter'] };
	}
	if (tableBindings.includes('categories')) {
		bindings['cat-table'] = { sectionId: 'query_2', sectionName: 'Categories', columns: ['Category', 'Revenue', 'Units'] };
	}
	if (scalarBindings.includes('total-sales')) {
		bindings['sales-table'] = bindings['sales-table'] || { sectionId: 'query_1', sectionName: 'Regional Sales', columns: ['Region', 'Sales', 'Quarter'] };
	}

	const provScript = `<script type="application/kw-provenance">${JSON.stringify({ version: 1, bindings })}</script>`;
	let html = `<html><head>${provScript}</head><body>`;

	if (scalarBindings.includes('total-sales')) {
		html += `<div data-kw-bind="sales-table">$100,000</div>`;
	}
	if (tableBindings.includes('sales')) {
		html += `<table data-kw-bind="sales-table"><thead><tr><th>R</th><th class="num">S</th><th>Q</th></tr></thead><tbody><tr><td>NA</td><td>50000</td><td>Q1</td></tr></tbody></table>`;
	}
	if (tableBindings.includes('categories')) {
		html += `<table data-kw-bind="cat-table"><thead><tr><th>C</th><th>R</th><th>U</th></tr></thead><tbody><tr><td>Electronics</td><td>45000</td><td>320</td></tr></tbody></table>`;
	}

	html += `</body></html>`;
	return html;
}

describe('generateDaxMeasure', () => {
	it('falls back to static string when no provenance', () => {
		const result = generateDaxMeasure('<div>Hello</div>', sampleDataSources);
		expect(result).toMatch(/^"/);
		expect(result).toContain('Hello');
		expect(result).not.toContain('CONCATENATEX');
	});

	it('falls back to static string when dataSources is empty', () => {
		const html = makeHtmlWithProvenance(['sales']);
		const result = generateDaxMeasure(html, []);
		expect(result).toMatch(/^"/);
		expect(result).not.toContain('CONCATENATEX');
	});

	it('generates CONCATENATEX for a table binding', () => {
		const html = makeHtmlWithProvenance(['sales']);
		const result = generateDaxMeasure(html, sampleDataSources);
		expect(result).toContain('CONCATENATEX');
		expect(result).toContain("'Regional_Sales'");
		expect(result).toContain('[Region]');
		expect(result).toContain('[Sales]');
		expect(result).toContain('[Quarter]');
		expect(result).toContain('RETURN');
	});

	it('generates CONCATENATEX for multiple table bindings', () => {
		const html = makeHtmlWithProvenance(['sales', 'categories']);
		const result = generateDaxMeasure(html, sampleDataSources);
		expect(result).toContain("'Regional_Sales'");
		expect(result).toContain("'Categories'");
		expect(result).toContain('_rows_0');
		expect(result).toContain('_rows_1');
	});

	it('generates SUMX for scalar binding', () => {
		const html = makeHtmlWithProvenance([], ['total-sales']);
		const result = generateDaxMeasure(html, sampleDataSources);
		expect(result).toContain('SUMX');
		expect(result).toContain('[Sales]');
		expect(result).toContain('FORMAT');
	});

	it('strips the provenance script from output', () => {
		const html = makeHtmlWithProvenance(['sales']);
		const result = generateDaxMeasure(html, sampleDataSources);
		expect(result).not.toContain('application/kw-provenance');
	});

	it('replaces thead with data source column names', () => {
		const html = makeHtmlWithProvenance(['sales']);
		const result = generateDaxMeasure(html, sampleDataSources);
		expect(result).toContain('Region');
		expect(result).toContain('Sales');
		expect(result).toContain('Quarter');
		expect(result).toContain('<thead>');
	});

	it('preserves original CSS classes from HTML th elements', () => {
		const html = makeHtmlWithProvenance(['sales']);
		const result = generateDaxMeasure(html, sampleDataSources);
		// Sales column had class="num" in the original HTML — should be preserved
		expect(result).toContain('class=""num""');
	});

	it('handles table binding taking priority over scalar for same key', () => {
		// When both a table and scalar use the same binding key, table wins
		const html = makeHtmlWithProvenance(['sales'], ['total-sales']);
		const result = generateDaxMeasure(html, sampleDataSources);
		// Table binding produces CONCATENATEX
		expect(result).toContain('CONCATENATEX');
		// Scalar should NOT produce SUMX since the table binding consumed the key
		expect(result).not.toContain('SUMX');
	});
});

// ── Provenance v2: display-driven DAX generation ────────────────────────────

function makeV2Html(bindings: Record<string, object>, bodyHtml: string): string {
	const prov = JSON.stringify({ version: 2, bindings });
	return `<html><head><script type="application/kw-provenance">${prov}</script></head><body>${bodyHtml}</body></html>`;
}

describe('generateDaxMeasure — v2 flat display', () => {
	it('generates CONCATENATEX with explicit columns', () => {
		const html = makeV2Html(
			{
				'cat-table': {
					sectionId: 'query_2', sectionName: 'Categories', columns: ['Category', 'Revenue', 'Units'],
					display: { type: 'flat', columns: ['Category', 'Revenue', 'Units'] },
				},
			},
			'<table data-kw-bind="cat-table"><thead><tr><th>C</th></tr></thead><tbody><tr><td>X</td></tr></tbody></table>',
		);
		const result = generateDaxMeasure(html, sampleDataSources);
		expect(result).toContain('CONCATENATEX');
		expect(result).toContain('[Category]');
		expect(result).toContain('[Revenue]');
		expect(result).toContain('[Units]');
	});

	it('applies per-column format from display.formats', () => {
		const html = makeV2Html(
			{
				'cat-table': {
					sectionId: 'query_2', sectionName: 'Categories', columns: ['Category', 'Revenue'],
					display: { type: 'flat', columns: ['Category', 'Revenue'], formats: { Revenue: '$#,##0' } },
				},
			},
			'<table data-kw-bind="cat-table"><thead><tr><th>C</th></tr></thead><tbody><tr><td>X</td></tr></tbody></table>',
		);
		const result = generateDaxMeasure(html, sampleDataSources);
		expect(result).toContain('$#,##0');
	});
});

describe('generateDaxMeasure — v2 pivot display', () => {
	it('generates CALCULATE per pivot value', () => {
		const html = makeV2Html(
			{
				'sales-pivot': {
					sectionId: 'query_1', sectionName: 'Regional Sales', columns: ['Region', 'Sales', 'Quarter'],
					display: {
						type: 'pivot', rows: ['Region'], pivotBy: 'Quarter',
						pivotValues: ['Q1', 'Q2'], value: 'Sales', agg: 'SUM', format: '$#,##0',
					},
				},
			},
			'<table data-kw-bind="sales-pivot"><thead><tr><th>R</th></tr></thead><tbody><tr><td>X</td></tr></tbody></table>',
		);
		const result = generateDaxMeasure(html, sampleDataSources);
		expect(result).toContain('CALCULATE');
		expect(result).toContain('SUMX');
		expect(result).toContain('"Q1"');
		expect(result).toContain('"Q2"');
		expect(result).toContain('VALUES');
	});

	it('includes total column when total is true', () => {
		const html = makeV2Html(
			{
				'sales-pivot': {
					sectionId: 'query_1', sectionName: 'Regional Sales', columns: ['Region', 'Sales', 'Quarter'],
					display: {
						type: 'pivot', rows: ['Region'], pivotBy: 'Quarter',
						pivotValues: ['Q1'], value: 'Sales', agg: 'SUM', total: true,
					},
				},
			},
			'<table data-kw-bind="sales-pivot"><thead><tr><th>R</th></tr></thead><tbody><tr><td>X</td></tr></tbody></table>',
		);
		const result = generateDaxMeasure(html, sampleDataSources);
		expect(result).toContain('Total');
		expect(result).toContain('<strong>');
	});

	it('omits total column when total is false or absent', () => {
		const html = makeV2Html(
			{
				'sales-pivot': {
					sectionId: 'query_1', sectionName: 'Regional Sales', columns: ['Region', 'Sales', 'Quarter'],
					display: {
						type: 'pivot', rows: ['Region'], pivotBy: 'Quarter',
						pivotValues: ['Q1'], value: 'Sales', agg: 'SUM',
					},
				},
			},
			'<table data-kw-bind="sales-pivot"><thead><tr><th>R</th></tr></thead><tbody><tr><td>X</td></tr></tbody></table>',
		);
		const result = generateDaxMeasure(html, sampleDataSources);
		expect(result).not.toContain('Total');
	});

	it('generates thead with pivot value names', () => {
		const html = makeV2Html(
			{
				'sales-pivot': {
					sectionId: 'query_1', sectionName: 'Regional Sales', columns: ['Region', 'Sales', 'Quarter'],
					display: {
						type: 'pivot', rows: ['Region'], pivotBy: 'Quarter',
						pivotValues: ['Q1', 'Q2', 'Q3'], value: 'Sales', agg: 'SUM',
					},
				},
			},
			'<table data-kw-bind="sales-pivot"><thead><tr><th>R</th></tr></thead><tbody><tr><td>X</td></tr></tbody></table>',
		);
		const result = generateDaxMeasure(html, sampleDataSources);
		expect(result).toContain('Q1');
		expect(result).toContain('Q2');
		expect(result).toContain('Q3');
		expect(result).toContain('Region');
	});

	it('sorts rows by row dimension', () => {
		const html = makeV2Html(
			{
				'sales-pivot': {
					sectionId: 'query_1', sectionName: 'Regional Sales', columns: ['Region', 'Sales', 'Quarter'],
					display: {
						type: 'pivot', rows: ['Region'], pivotBy: 'Quarter',
						pivotValues: ['Q1'], value: 'Sales', agg: 'SUM',
					},
				},
			},
			'<table data-kw-bind="sales-pivot"><thead><tr><th>R</th></tr></thead><tbody><tr><td>X</td></tr></tbody></table>',
		);
		const result = generateDaxMeasure(html, sampleDataSources);
		expect(result).toContain('ASC');
	});
});

describe('generateDaxMeasure — v2 scalar display', () => {
	it('generates FORMAT with specified agg and column', () => {
		const html = makeV2Html(
			{
				'total-sales': {
					sectionId: 'query_1', sectionName: 'Regional Sales',
					display: { type: 'scalar', agg: 'SUM', column: 'Sales', format: '$#,##0' },
				},
			},
			'<div data-kw-bind="total-sales">$0</div>',
		);
		const result = generateDaxMeasure(html, sampleDataSources);
		expect(result).toContain('SUMX');
		expect(result).toContain('[Sales]');
		expect(result).toContain('$#,##0');
	});

	it('handles COUNT agg without column ref', () => {
		const html = makeV2Html(
			{
				'row-count': {
					sectionId: 'query_1', sectionName: 'Regional Sales',
					display: { type: 'scalar', agg: 'COUNT', column: 'Region', format: '#,##0' },
				},
			},
			'<span data-kw-bind="row-count">0</span>',
		);
		const result = generateDaxMeasure(html, sampleDataSources);
		expect(result).toContain('COUNTROWS');
	});

	it('handles AVG agg', () => {
		const html = makeV2Html(
			{
				'avg-sales': {
					sectionId: 'query_1', sectionName: 'Regional Sales',
					display: { type: 'scalar', agg: 'AVG', column: 'Sales', format: '#,##0' },
				},
			},
			'<div data-kw-bind="avg-sales">0</div>',
		);
		const result = generateDaxMeasure(html, sampleDataSources);
		expect(result).toContain('AVERAGEX');
	});
});

describe('generateDaxMeasure — v1/v2 mixed', () => {
	it('handles v1 bindings without display alongside v2 bindings', () => {
		const html = makeV2Html(
			{
				'v1-table': { sectionId: 'query_2', sectionName: 'Categories', columns: ['Category', 'Revenue', 'Units'] },
				'v2-scalar': {
					sectionId: 'query_1', sectionName: 'Regional Sales',
					display: { type: 'scalar', agg: 'SUM', column: 'Sales', format: '$#,##0' },
				},
			},
			'<table data-kw-bind="v1-table"><thead><tr><th>C</th></tr></thead><tbody><tr><td>X</td></tr></tbody></table><div data-kw-bind="v2-scalar">$0</div>',
		);
		const result = generateDaxMeasure(html, sampleDataSources);
		// v1 table binding uses heuristic CONCATENATEX
		expect(result).toContain('CONCATENATEX');
		// v2 scalar binding uses explicit SUMX
		expect(result).toContain('SUMX');
		expect(result).toContain('$#,##0');
	});
});

// ── Provenance v2: conditional cell templates ───────────────────────────────

describe('generateDaxMeasure — v2 flat with cellTemplates', () => {
	const dsWithRate: PowerBiDataSource[] = [
		{
			name: 'Templates',
			sectionId: 'query_3',
			clusterUrl: 'https://c.kusto.windows.net',
			database: 'db',
			query: 'T',
			columns: [
				{ name: 'Name', type: 'string' },
				{ name: 'Count', type: 'long' },
				{ name: 'SuccessRate', type: 'real' },
			],
		},
	];

	it('wraps cell value in conditional span with IF chain', () => {
		const html = makeV2Html(
			{
				't-table': {
					sectionId: 'query_3', sectionName: 'Templates', columns: ['Name', 'Count', 'SuccessRate'],
					display: {
						type: 'flat', columns: ['Name', 'Count', 'SuccessRate'],
						formats: { SuccessRate: '0.0%' },
						cellTemplates: {
							SuccessRate: {
								baseClass: 'success-badge',
								thresholds: [{ min: 80, class: 'success-high' }, { min: 40, class: 'success-mid' }],
								defaultClass: 'success-low',
							},
						},
					},
				},
			},
			'<table data-kw-bind="t-table"><thead><tr><th>N</th></tr></thead><tbody><tr><td>X</td></tr></tbody></table>',
		);
		const result = generateDaxMeasure(html, dsWithRate);
		expect(result).toContain('IF([SuccessRate] >= 80');
		expect(result).toContain('success-high');
		expect(result).toContain('success-mid');
		expect(result).toContain('success-low');
		expect(result).toContain('success-badge');
		// Verify correct IF nesting order: highest threshold first
		expect(result).toContain('IF([SuccessRate] >= 80, "success-high", IF([SuccessRate] >= 40, "success-mid", "success-low"))');
		expect(result).toContain('<span');
		expect(result).toContain('</span>');
	});

	it('renders non-template columns normally alongside template columns', () => {
		const html = makeV2Html(
			{
				't-table': {
					sectionId: 'query_3', sectionName: 'Templates', columns: ['Name', 'Count', 'SuccessRate'],
					display: {
						type: 'flat', columns: ['Name', 'Count', 'SuccessRate'],
						formats: { Count: '#,##0', SuccessRate: '0.0%' },
						cellTemplates: {
							SuccessRate: {
								thresholds: [{ min: 50, class: 'good' }],
								defaultClass: 'bad',
							},
						},
					},
				},
			},
			'<table data-kw-bind="t-table"><thead><tr><th>N</th></tr></thead><tbody><tr><td>X</td></tr></tbody></table>',
		);
		const result = generateDaxMeasure(html, dsWithRate);
		expect(result).toContain('[Name]');
		expect(result).toContain('#,##0');
		expect(result).toContain('IF([SuccessRate] >= 50');
	});

	it('handles empty thresholds — uses defaultClass only', () => {
		const html = makeV2Html(
			{
				't-table': {
					sectionId: 'query_3', sectionName: 'Templates', columns: ['Name', 'SuccessRate'],
					display: {
						type: 'flat', columns: ['Name', 'SuccessRate'],
						cellTemplates: {
							SuccessRate: { baseClass: 'badge', thresholds: [], defaultClass: 'neutral' },
						},
					},
				},
			},
			'<table data-kw-bind="t-table"><thead><tr><th>N</th></tr></thead><tbody><tr><td>X</td></tr></tbody></table>',
		);
		const result = generateDaxMeasure(html, dsWithRate);
		expect(result).toContain('neutral');
		expect(result).not.toContain('IF([SuccessRate]');
	});

	it('works with percentage format and cellTemplate together', () => {
		const html = makeV2Html(
			{
				't-table': {
					sectionId: 'query_3', sectionName: 'Templates', columns: ['SuccessRate'],
					display: {
						type: 'flat', columns: ['SuccessRate'],
						formats: { SuccessRate: '0.0%' },
						cellTemplates: {
							SuccessRate: { thresholds: [{ min: 80, class: 'high' }], defaultClass: 'low' },
						},
					},
				},
			},
			'<table data-kw-bind="t-table"><thead><tr><th>R</th></tr></thead><tbody><tr><td>X</td></tr></tbody></table>',
		);
		const result = generateDaxMeasure(html, dsWithRate);
		expect(result).toContain('"%"');
		expect(result).toContain('IF([SuccessRate] >= 80');
		expect(result).toContain('</span>');
	});

	it('uses custom element tag when specified', () => {
		const html = makeV2Html(
			{
				't-table': {
					sectionId: 'query_3', sectionName: 'Templates', columns: ['SuccessRate'],
					display: {
						type: 'flat', columns: ['SuccessRate'],
						cellTemplates: {
							SuccessRate: { element: 'div', thresholds: [{ min: 50, class: 'ok' }], defaultClass: 'bad' },
						},
					},
				},
			},
			'<table data-kw-bind="t-table"><thead><tr><th>R</th></tr></thead><tbody><tr><td>X</td></tr></tbody></table>',
		);
		const result = generateDaxMeasure(html, dsWithRate);
		expect(result).toContain('<div');
		expect(result).toContain('</div>');
	});
});

// ── Provenance v2: column name remapping (provenance → actual) ──────────────

describe('generateDaxMeasure — column name remapping', () => {
	const dailyByClientDs: PowerBiDataSource[] = [
		{
			name: 'Daily Trend by Client',
			sectionId: 'query_daily',
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'db',
			query: 'T | summarize Refs = count() by Day = bin(timestamp, 1d), Client = tostring(customDimensions.clientname)',
			columns: [
				{ name: 'Day', type: 'datetime' },
				{ name: 'Client', type: 'string' },
				{ name: 'Refs', type: 'long' },
			],
		},
	];

	it('remaps pivot column names from provenance to actual data-source names', () => {
		const html = makeV2Html(
			{
				'daily-by-client': {
					sectionId: 'query_daily', sectionName: 'Daily Trend by Client',
					columns: ['Day', 'ClientName', 'SkillReferences'],
					display: {
						type: 'pivot', rows: ['Day'], pivotBy: 'ClientName',
						pivotValues: ['vscode', 'copilot-cli'], value: 'SkillReferences',
						agg: 'SUM', format: '#,##0', total: true,
					},
				},
			},
			'<table data-kw-bind="daily-by-client"><thead><tr><th>D</th></tr></thead><tbody><tr><td>X</td></tr></tbody></table>',
		);
		const result = generateDaxMeasure(html, dailyByClientDs);
		// Should reference the ACTUAL column names, not the provenance ones
		expect(result).toContain('[Client]');
		expect(result).toContain('[Refs]');
		// Should NOT reference the mismatched provenance column names
		expect(result).not.toContain('[ClientName]');
		expect(result).not.toContain('[SkillReferences]');
		// Pivot values are data values, not columns — should be preserved
		expect(result).toContain('"vscode"');
		expect(result).toContain('"copilot-cli"');
	});

	it('remaps flat column names from provenance to actual data-source names', () => {
		const html = makeV2Html(
			{
				'flat-table': {
					sectionId: 'query_daily', sectionName: 'Daily Trend by Client',
					columns: ['Day', 'ClientName', 'SkillReferences'],
					display: {
						type: 'flat', columns: ['Day', 'ClientName', 'SkillReferences'],
						headers: { Day: 'Date', ClientName: 'Client Name', SkillReferences: 'Refs' },
						formats: { SkillReferences: '#,##0' },
					},
				},
			},
			'<table data-kw-bind="flat-table"><thead><tr><th>D</th><th>C</th><th>R</th></tr></thead><tbody><tr><td>X</td><td>Y</td><td>Z</td></tr></tbody></table>',
		);
		const result = generateDaxMeasure(html, dailyByClientDs);
		// Should reference actual column names in DAX
		expect(result).toContain('[Client]');
		expect(result).toContain('[Refs]');
		// Should NOT reference provenance column names
		expect(result).not.toContain('[ClientName]');
		expect(result).not.toContain('[SkillReferences]');
		// Headers (display text) should still appear
		expect(result).toContain('Client Name');
		expect(result).toContain('#,##0');
	});

	it('remaps scalar column name from provenance to actual data-source name', () => {
		const html = makeV2Html(
			{
				'total': {
					sectionId: 'query_daily', sectionName: 'Daily Trend by Client',
					columns: ['Day', 'ClientName', 'SkillReferences'],
					display: { type: 'scalar', agg: 'SUM', column: 'SkillReferences', format: '#,##0' },
				},
			},
			'<div data-kw-bind="total">0</div>',
		);
		const result = generateDaxMeasure(html, dailyByClientDs);
		expect(result).toContain('[Refs]');
		expect(result).not.toContain('[SkillReferences]');
	});

	it('preserves column names when provenance matches actual (identity remap)', () => {
		const html = makeV2Html(
			{
				'sales-pivot': {
					sectionId: 'query_1', sectionName: 'Regional Sales',
					columns: ['Region', 'Sales', 'Quarter'],
					display: {
						type: 'pivot', rows: ['Region'], pivotBy: 'Quarter',
						pivotValues: ['Q1', 'Q2'], value: 'Sales', agg: 'SUM',
					},
				},
			},
			'<table data-kw-bind="sales-pivot"><thead><tr><th>R</th></tr></thead><tbody><tr><td>X</td></tr></tbody></table>',
		);
		const result = generateDaxMeasure(html, sampleDataSources);
		expect(result).toContain('[Region]');
		expect(result).toContain('[Sales]');
		expect(result).toContain('[Quarter]');
	});

	it('skips remapping when binding.columns is absent', () => {
		const html = makeV2Html(
			{
				'sales-pivot': {
					sectionId: 'query_1', sectionName: 'Regional Sales',
					display: {
						type: 'pivot', rows: ['Region'], pivotBy: 'Quarter',
						pivotValues: ['Q1'], value: 'Sales', agg: 'SUM',
					},
				},
			},
			'<table data-kw-bind="sales-pivot"><thead><tr><th>R</th></tr></thead><tbody><tr><td>X</td></tr></tbody></table>',
		);
		const result = generateDaxMeasure(html, sampleDataSources);
		expect(result).toContain('[Region]');
		expect(result).toContain('[Sales]');
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
