import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	analyzeHtmlDashboardPowerBiCompatibility,
} from '../../src/shared/htmlDashboardUpgrade';
import {
	compilePortableDashboard,
	portableDashboardIrToProvenance,
} from '../../src/shared/portableDashboardCompiler';
import {
	getPowerBiHtmlValidationDiagnostics,
	type PowerBiDataSource,
} from '../../src/host/powerBiExport';

const factDataSource: PowerBiDataSource = {
	name: 'Fact Events',
	sectionId: 'query_fact',
	clusterUrl: 'https://cluster.kusto.windows.net',
	database: 'db',
	query: 'FactEvents',
	columns: [
		{ name: 'Day', type: 'datetime' },
		{ name: 'ExistingMetric', type: 'long' },
	],
};

function dashboardHtml(
	bindings: Record<string, unknown>,
	body: string,
	dimensions: unknown[] = [],
	version = 1,
): string {
	return `<script type="application/kw-provenance">${JSON.stringify({
		version,
		model: {
			fact: { sectionId: 'query_fact', sectionName: 'Fact Events' },
			dimensions,
		},
		bindings,
	})}</script>${body}`;
}

describe('portable dashboard compiler', () => {
	it('returns the same typed missing-column diagnostic across preview and Power BI paths', () => {
		const htmlCode = dashboardHtml(
			{
				'total-actions': { display: { type: 'scalar', agg: 'SUM', column: 'MissingMetric' } },
			},
			'<span data-kw-bind="total-actions"></span>',
		);
		const expected = [{
			code: 'missing-column',
			severity: 'error',
			message: 'total-actions (column: missing column MissingMetric)',
			bindingKey: 'total-actions',
			role: 'column',
			columnName: 'MissingMetric',
		}];

		expect(compilePortableDashboard({ htmlCode, dataSources: [factDataSource] }).diagnostics).toEqual(expected);
		expect(analyzeHtmlDashboardPowerBiCompatibility(htmlCode, [factDataSource]).diagnostics).toEqual(expected);
		expect(getPowerBiHtmlValidationDiagnostics(htmlCode, [factDataSource])).toEqual(expected);
	});

	it('normalizes valid provenance into renderer-neutral admitted IR', () => {
		const htmlCode = dashboardHtml(
			{
				total: { display: { type: 'scalar' } },
			},
			'<span data-kw-bind="total"></span>',
			[{ column: 'Day' }],
		);

		const result = compilePortableDashboard({ htmlCode, dataSources: [factDataSource] });

		expect(result.diagnostics).toEqual([]);
		expect(result.ir).toMatchObject({
			version: 1,
			sourceVersion: 1,
			fact: { sectionId: 'query_fact', sectionName: 'Fact Events' },
			dimensions: [{ column: 'Day' }],
			bindings: [{
				key: 'total',
				display: { type: 'scalar', agg: 'COUNT' },
				targets: [{ tagName: 'span', hidden: false }],
				admitted: true,
			}],
		});
		expect(portableDashboardIrToProvenance(result.ir!)).toEqual({
			version: 1,
			model: {
				fact: { sectionId: 'query_fact', sectionName: 'Fact Events' },
				dimensions: [{ column: 'Day' }],
			},
			bindings: { total: { display: { type: 'scalar', agg: 'COUNT' } } },
		});
	});

	it('retains rejected bindings in IR but excludes them from renderer provenance', () => {
		const htmlCode = dashboardHtml(
			{
				table: {
					display: {
						type: 'table',
						groupBy: ['Day'],
						columns: [{ name: 'Day' }],
					},
				},
			},
			'<div data-kw-bind="table"></div>',
		);

		const result = compilePortableDashboard({ htmlCode, dataSources: [factDataSource] });

		expect(result.diagnostics).toContainEqual({
			code: 'invalid-target',
			severity: 'error',
			message: 'table (table: target must be table or tbody inside table)',
			bindingKey: 'table',
			displayType: 'table',
		});
		expect(result.ir?.bindings[0].admitted).toBe(false);
		expect(portableDashboardIrToProvenance(result.ir!).bindings).toEqual({});
	});

	it.each([
		'textarea', 'title', 'template', 'script', 'style', 'noscript',
		'iframe', 'xmp', 'noembed', 'noframes',
	])('does not admit markup text inside <%s> as a rendered target', tagName => {
		const htmlCode = dashboardHtml(
			{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
			`<${tagName}><span data-kw-bind="total"></span></${tagName}>`,
		);
		const expected = [{
			code: 'missing-target',
			severity: 'error',
			message: 'total (missing data-kw-bind target)',
			bindingKey: 'total',
		}];

		const result = compilePortableDashboard({ htmlCode, dataSources: [factDataSource] });

		expect(result.diagnostics).toEqual(expected);
		expect(analyzeHtmlDashboardPowerBiCompatibility(htmlCode, [factDataSource]).diagnostics).toEqual(expected);
		expect(getPowerBiHtmlValidationDiagnostics(htmlCode, [factDataSource])).toEqual(expected);
		expect(result.ir?.bindings[0]).toMatchObject({ targets: [], admitted: false });
	});

	it.each(['textarea', 'title', 'template', 'style', 'noscript', 'iframe'])('does not parse provenance markup inside <%s>', tagName => {
		const htmlCode = `<${tagName}>${dashboardHtml({}, '<main>Dashboard</main>')}</${tagName}>`;

		expect(compilePortableDashboard({ htmlCode }).diagnostics).toEqual([{
			code: 'missing-provenance',
			severity: 'error',
			message: 'Missing application/kw-provenance block. Ask Kusto Workbench to make this dashboard exportable to Power BI.',
		}]);
	});

	it('recognizes real tags with quoted delimiters and unquoted portable attributes', () => {
		const provenance = JSON.stringify({
			version: 1,
			model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
			bindings: { total: { display: { type: 'scalar', agg: 'COUNT' } } },
		});
		const htmlCode = `<script nonce="a > b" type=application/kw-provenance>${provenance}</script>`
			+ '<span title="a > b" data-kw-bind=total></span>';

		expect(compilePortableDashboard({ htmlCode, dataSources: [factDataSource] }).diagnostics).toEqual([]);
	});

	it('matches browser tree-building for select, bogus comments, and non-void self-closing syntax', () => {
		const selectTarget = dashboardHtml(
			{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
			'<select><span data-kw-bind="total"></span></select>',
		);
		expect(compilePortableDashboard({ htmlCode: selectTarget, dataSources: [factDataSource] }).diagnostics).toEqual([{
			code: 'missing-target', severity: 'error', message: 'total (missing data-kw-bind target)', bindingKey: 'total',
		}]);

		const bogusComment = '<!oops <script type="application/kw-provenance">'
			+ '{"version":1,"model":{"fact":{"sectionId":"query_fact"}},"bindings":{}}</script>>';
		expect(compilePortableDashboard({ htmlCode: bogusComment }).diagnostics[0].code).toBe('missing-provenance');

		const table = dashboardHtml(
			{ rows: { display: { type: 'table', groupBy: ['Day'], columns: [{ name: 'Day' }] } } },
			'<table data-kw-bind="rows" /></table>',
		);
		expect(compilePortableDashboard({ htmlCode: table, dataSources: [factDataSource] }).diagnostics).toEqual([]);
	});

	it.each(['style', 'script', 'template', 'textarea', 'select'])('rejects <%s> as a direct portable target', tagName => {
		const htmlCode = dashboardHtml(
			{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
			`<${tagName} data-kw-bind="total"></${tagName}>`,
		);

		expect(compilePortableDashboard({ htmlCode, dataSources: [factDataSource] }).diagnostics).toEqual([{
			code: 'invalid-target',
			severity: 'error',
			message: 'total (scalar: target must be rendered container element)',
			bindingKey: 'total',
			displayType: 'scalar',
		}]);
	});

	it('rejects nested binding target ranges before renderer admission', () => {
		const htmlCode = dashboardHtml(
			{
				outer: { display: { type: 'scalar', agg: 'COUNT' } },
				inner: { display: { type: 'scalar', agg: 'COUNT' } },
			},
			'<div data-kw-bind="outer"><span data-kw-bind="inner">0</span></div>',
		);

		expect(compilePortableDashboard({ htmlCode, dataSources: [factDataSource] }).diagnostics).toEqual([
			{
				code: 'overlapping-target', severity: 'error',
				message: 'outer (scalar: target overlaps binding inner)',
				bindingKey: 'outer', displayType: 'scalar',
			},
			{
				code: 'overlapping-target', severity: 'error',
				message: 'inner (scalar: target overlaps binding outer)',
				bindingKey: 'inner', displayType: 'scalar',
			},
		]);
	});

	it('rejects a target range that contains the provenance block', () => {
		const provenance = JSON.stringify({
			version: 1,
			model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
			bindings: { outer: { display: { type: 'scalar', agg: 'COUNT' } } },
		});
		const htmlCode = `<div data-kw-bind="outer"><script type="application/kw-provenance">${provenance}</script></div>`;

		expect(compilePortableDashboard({ htmlCode, dataSources: [factDataSource] }).diagnostics).toEqual([{
			code: 'overlapping-target', severity: 'error',
			message: 'outer (scalar: target overlaps provenance block)',
			bindingKey: 'outer', displayType: 'scalar',
		}]);
	});

	it('counts browser-generated bound clones without source ranges', () => {
		const provenance = JSON.stringify({
			version: 1,
			model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
			bindings: { total: { display: { type: 'scalar', agg: 'COUNT' } } },
		});
		const htmlCode = `<script type="application/kw-provenance">${provenance}</script>`
			+ '<b data-kw-bind="total">one<div>two</b>three</div>';

		const result = compilePortableDashboard({ htmlCode, dataSources: [factDataSource] });

		expect(result.diagnostics).toEqual([{
			code: 'duplicate-target',
			severity: 'error',
			message: 'total (scalar: expected exactly one data-kw-bind target, found 2)',
			bindingKey: 'total',
			displayType: 'scalar',
		}]);
	});

	it.each(['', 'prefix'])('rejects foster-parented source content after prefix %j', prefix => {
		const htmlCode = dashboardHtml(
			{
				rows: { display: { type: 'table', groupBy: ['Day'], columns: [{ name: 'Day' }] } },
			},
			`${prefix}<table data-kw-bind="rows">FOSTER_MARKER</table>`,
		);

		const expected = [{
			code: 'invalid-target', severity: 'error',
			message: 'rows (table: target source content is reparented outside target)',
			bindingKey: 'rows', displayType: 'table',
		}];
		expect(compilePortableDashboard({ htmlCode, dataSources: [factDataSource] }).diagnostics).toEqual(expected);
		expect(analyzeHtmlDashboardPowerBiCompatibility(htmlCode, [factDataSource]).diagnostics).toEqual(expected);
		expect(getPowerBiHtmlValidationDiagnostics(htmlCode, [factDataSource])).toEqual(expected);
	});

	it.each([
		{
			name: 'scalar on tbody',
			display: { type: 'scalar', agg: 'COUNT' },
			target: '<table><tbody data-kw-bind="value"></tbody></table>',
			type: 'scalar',
		},
		{
			name: 'chart on tbody',
			display: { type: 'bar', groupBy: 'Day', value: { agg: 'COUNT' } },
			target: '<table><tbody data-kw-bind="value"></tbody></table>',
			type: 'bar',
		},
		{
			name: 'repeated table on p',
			display: {
				type: 'repeatedTable', repeatBy: ['Day'],
				table: { groupBy: ['ExistingMetric'], columns: [{ name: 'ExistingMetric' }] },
			},
			target: '<p data-kw-bind="value"></p>',
			type: 'repeatedTable',
		},
		{
			name: 'repeated table on colgroup',
			display: {
				type: 'repeatedTable', repeatBy: ['Day'],
				table: { groupBy: ['ExistingMetric'], columns: [{ name: 'ExistingMetric' }] },
			},
			target: '<table><colgroup data-kw-bind="value"></colgroup></table>',
			type: 'repeatedTable',
		},
	])('rejects $name when generated output leaves the target', ({ display, target, type }) => {
		const htmlCode = dashboardHtml({ value: { display } }, target);

		const expected = [{
			code: 'invalid-target', severity: 'error',
			message: `value (${type}: generated output does not remain inside target)`,
			bindingKey: 'value', displayType: type,
		}];
		expect(compilePortableDashboard({ htmlCode, dataSources: [factDataSource] }).diagnostics).toEqual(expected);
		expect(analyzeHtmlDashboardPowerBiCompatibility(htmlCode, [factDataSource]).diagnostics).toEqual(expected);
		expect(getPowerBiHtmlValidationDiagnostics(htmlCode, [factDataSource])).toEqual(expected);
	});

	it('does not confuse authored probe-like text with generated content', () => {
		const htmlCode = dashboardHtml(
			{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
			'<p>KW_PORTABLE_SCALAR_MARKER KW_PORTABLE_GENERATED_PROBE_0</p><span data-kw-bind="total"></span>',
		);

		expect(compilePortableDashboard({ htmlCode, dataSources: [factDataSource] }).diagnostics).toEqual([]);
		expect(analyzeHtmlDashboardPowerBiCompatibility(htmlCode, [factDataSource]).diagnostics).toEqual([]);
		expect(getPowerBiHtmlValidationDiagnostics(htmlCode, [factDataSource])).toEqual([]);
	});

	it('rejects a target whose rewrite interior contains a misnested ancestor end tag', () => {
		const htmlCode = dashboardHtml(
			{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
			'<form><div data-kw-bind="total">old</form>inside</div><button type="submit">Outside</button>',
		);

		const expected = [{
			code: 'invalid-target', severity: 'error',
			message: 'total (scalar: target source contains form boundary tokens)',
			bindingKey: 'total', displayType: 'scalar',
		}];
		expect(compilePortableDashboard({ htmlCode, dataSources: [factDataSource] }).diagnostics).toEqual(expected);
		expect(analyzeHtmlDashboardPowerBiCompatibility(htmlCode, [factDataSource]).diagnostics).toEqual(expected);
		expect(getPowerBiHtmlValidationDiagnostics(htmlCode, [factDataSource])).toEqual(expected);
	});

	it('rejects target replacement that changes the parser form pointer outside the target', () => {
		const htmlCode = dashboardHtml(
			{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
			'<div data-kw-bind="total"><form id="poison"></div>'
				+ '<form id="outside"><button type="submit">Submit</button></form>',
		);
		const expected = [{
			code: 'invalid-target', severity: 'error',
			message: 'total (scalar: target source contains form boundary tokens)',
			bindingKey: 'total', displayType: 'scalar',
		}];

		expect(compilePortableDashboard({ htmlCode, dataSources: [factDataSource] }).diagnostics).toEqual(expected);
		expect(analyzeHtmlDashboardPowerBiCompatibility(htmlCode, [factDataSource]).diagnostics).toEqual(expected);
		expect(getPowerBiHtmlValidationDiagnostics(htmlCode, [factDataSource])).toEqual(expected);
	});

	it('rejects form boundary tokens whose parser-state effect is not represented in the DOM', () => {
		const htmlCode = dashboardHtml(
			{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
			'<table><form id="owner"><tr><td>'
				+ '<div data-kw-bind="total"></form></div>'
				+ '</td></tr></table><input id="outside" type="submit">',
		);
		const expected = [{
			code: 'invalid-target', severity: 'error',
			message: 'total (scalar: target source contains form boundary tokens)',
			bindingKey: 'total', displayType: 'scalar',
		}];

		expect(compilePortableDashboard({ htmlCode, dataSources: [factDataSource] }).diagnostics).toEqual(expected);
		expect(analyzeHtmlDashboardPowerBiCompatibility(htmlCode, [factDataSource]).diagnostics).toEqual(expected);
		expect(getPowerBiHtmlValidationDiagnostics(htmlCode, [factDataSource])).toEqual(expected);
	});

	it('uses tree-builder tokenizer state for form boundaries in ignored select content', () => {
		const htmlCode = dashboardHtml(
			{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
			'<table><form id="owner"><tr><td>'
				+ '<div data-kw-bind="total"><select><style></select></form></div>'
				+ '</td></tr></table><input id="outside" type="submit">',
		);
		const expected = [{
			code: 'invalid-target', severity: 'error',
			message: 'total (scalar: target source contains form boundary tokens)',
			bindingKey: 'total', displayType: 'scalar',
		}];

		expect(compilePortableDashboard({ htmlCode, dataSources: [factDataSource] }).diagnostics).toEqual(expected);
		expect(analyzeHtmlDashboardPowerBiCompatibility(htmlCode, [factDataSource]).diagnostics).toEqual(expected);
		expect(getPowerBiHtmlValidationDiagnostics(htmlCode, [factDataSource])).toEqual(expected);
	});

	it.each([
		'<span data-kw-bind="total"><script>const form = "<form></form>";</script></span>',
		'<span data-kw-bind="total"><!-- <form></form> --></span>',
		'<span data-kw-bind="total">&lt;form&gt;&lt;/form&gt;</span>',
	])('allows non-token form-like text inside a target: %s', body => {
		const htmlCode = dashboardHtml(
			{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
			body,
		);

		expect(compilePortableDashboard({ htmlCode, dataSources: [factDataSource] }).diagnostics).toEqual([]);
	});

	it.each(['html', 'body'])('rejects <%s> attribute adoption from inside a target', tagName => {
		const htmlCode = dashboardHtml(
			{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
			`<div data-kw-bind="total"><${tagName} data-kw-mode="adopted"></${tagName}></div>`,
		);

		expect(compilePortableDashboard({ htmlCode, dataSources: [factDataSource] }).diagnostics).toEqual([{
			code: 'invalid-target', severity: 'error',
			message: 'total (scalar: generated output does not remain inside target)',
			bindingKey: 'total', displayType: 'scalar',
		}]);
	});

	it('allows ordinary form controls outside a clean scalar target', () => {
		const htmlCode = dashboardHtml(
			{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
			'<span data-kw-bind="total">old</span>'
				+ '<form id="outside"><button type="submit">Submit</button></form>',
		);

		expect(compilePortableDashboard({ htmlCode, dataSources: [factDataSource] }).diagnostics).toEqual([]);
	});

	it.each([
		'<div hidden><span data-kw-bind="total"></span></div>',
		'<div style="display:none"><span data-kw-bind="total"></span></div>',
		'<canvas><span data-kw-bind="total"></span></canvas>',
	])('rejects a target hidden by ancestor context: %s', body => {
		const htmlCode = dashboardHtml(
			{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
			body,
		);

		const expected = [{
			code: 'hidden-target', severity: 'error',
			message: 'total (scalar: target is hidden; bind exportable content to a visible data-kw-bind element)',
			bindingKey: 'total', displayType: 'scalar',
		}];
		expect(compilePortableDashboard({ htmlCode, dataSources: [factDataSource] }).diagnostics).toEqual(expected);
		expect(analyzeHtmlDashboardPowerBiCompatibility(htmlCode, [factDataSource]).diagnostics).toEqual(expected);
		expect(getPowerBiHtmlValidationDiagnostics(htmlCode, [factDataSource])).toEqual(expected);
	});

	it('rejects empty and whitespace-only binding IDs', () => {
		for (const bindingKey of ['', '   ']) {
			const htmlCode = dashboardHtml(
				{ [bindingKey]: { display: { type: 'scalar', agg: 'COUNT' } } },
				`<span data-kw-bind="${bindingKey}"></span>`,
			);

			const result = compilePortableDashboard({ htmlCode, dataSources: [factDataSource] });
			expect(result.ir).toBeNull();
			expect(result.diagnostics).toContainEqual({
				code: 'invalid-binding-key', severity: 'error',
				message: 'Dashboard provenance binding keys must be non-empty strings.',
			});
		}
	});

	it('allows zero bindings consistently for provenance-only data bridges', () => {
		const htmlCode = dashboardHtml({}, '<main>Dashboard</main>');

		const result = compilePortableDashboard({ htmlCode, dataSources: [factDataSource] });

		expect(result.ir).toMatchObject({ bindings: [] });
		expect(result.diagnostics).toEqual([]);
		expect(analyzeHtmlDashboardPowerBiCompatibility(htmlCode, [factDataSource]).diagnostics).toEqual(result.diagnostics);
		expect(getPowerBiHtmlValidationDiagnostics(htmlCode, [factDataSource])).toEqual(result.diagnostics);
	});

	it('omits missing slicer columns from normalized IR', () => {
		const htmlCode = dashboardHtml({ total: { display: { type: 'scalar', agg: 'COUNT' } } }, '<span data-kw-bind="total"></span>', [
			{ column: 'Day' },
			{ column: 'MissingDimension' },
		]);

		const result = compilePortableDashboard({ htmlCode, dataSources: [factDataSource] });

		expect(result.diagnostics).toContainEqual({
			code: 'missing-column',
			severity: 'error',
			message: 'model.dimensions[1] (slicer: missing column MissingDimension)',
			role: 'model.dimensions[1].column',
			columnName: 'MissingDimension',
		});
		expect(result.ir?.dimensions).toEqual([{ column: 'Day' }]);
	});

	it('does not emit portable IR for provenance versions other than v1', () => {
		const result = compilePortableDashboard({
			htmlCode: dashboardHtml({}, '<main>Dashboard</main>', [], 2),
		});

		expect(result.ir).toBeNull();
		expect(result.diagnostics).toEqual([{
			code: 'unsupported-version',
			severity: 'error',
			message: 'Dashboard provenance version 2 is not supported by the portable dashboard contract version 1.',
		}]);
	});

	it('fails malformed binding records without throwing', () => {
		const htmlCode = dashboardHtml({ total: null }, '<span data-kw-bind="total"></span>');

		expect(() => compilePortableDashboard({ htmlCode })).not.toThrow();
		expect(compilePortableDashboard({ htmlCode }).diagnostics).toEqual([{
			code: 'missing-display',
			severity: 'error',
			message: 'total (missing display)',
			bindingKey: 'total',
		}]);
	});

	it.each([
		{
			name: 'table',
			display: { type: 'table', groupBy: ['Day'], columns: [null] },
			target: '<table data-kw-bind="malformed"></table>',
		},
		{
			name: 'repeated table',
			display: {
				type: 'repeatedTable',
				repeatBy: ['Day'],
				repeatColumns: [null],
				table: { groupBy: ['Day'], columns: [{ name: 'Day' }] },
			},
			target: '<div data-kw-bind="malformed"></div>',
		},
	])('returns invalid-display for malformed $name columns', ({ display, target }) => {
		const htmlCode = dashboardHtml({ malformed: { display } }, target);

		expect(() => compilePortableDashboard({ htmlCode, dataSources: [factDataSource] })).not.toThrow();
		expect(compilePortableDashboard({ htmlCode, dataSources: [factDataSource] }).diagnostics).toEqual([{
			code: 'invalid-display',
			severity: 'error',
			message: `malformed (${display.type}: invalid spec)`,
			bindingKey: 'malformed',
			displayType: display.type,
		}]);
	});

	it('returns a typed diagnostic for malformed source schema without throwing', () => {
		const htmlCode = dashboardHtml(
			{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
			'<span data-kw-bind="total"></span>',
		);
		const malformedDataSources = [{ sectionId: 'query_fact', columns: [null] }];

		expect(() => compilePortableDashboard({
			htmlCode,
			dataSources: malformedDataSources as unknown as PowerBiDataSource[],
		})).not.toThrow();
		const result = compilePortableDashboard({
			htmlCode,
			dataSources: malformedDataSources as unknown as PowerBiDataSource[],
		});
		expect(result.diagnostics).toEqual([{
			code: 'invalid-source-schema',
			severity: 'error',
			message: 'dataSources[0] (invalid source schema)',
		}]);
		expect(result.ir).toBeNull();
	});

	it('returns a fatal typed diagnostic when the declared fact source is unavailable', () => {
		const htmlCode = dashboardHtml(
			{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
			'<span data-kw-bind="total"></span>',
		);

		const result = compilePortableDashboard({ htmlCode, dataSources: [] });

		expect(result.ir).toBeNull();
		expect(result.diagnostics).toEqual([{
			code: 'missing-data-source',
			severity: 'error',
			message: 'model.fact (missing data source query_fact)',
			role: 'model.fact.sectionId',
		}]);
	});

	it.each([
		{
			name: 'scalar',
			display: { type: 'scalar', agg: 'MEDIAN', column: 'ExistingMetric' },
			target: '<span data-kw-bind="unsupported-agg"></span>',
		},
		{
			name: 'table column',
			display: {
				type: 'table',
				groupBy: ['Day'],
				columns: [{ name: 'Day' }, { name: 'Median', agg: 'MEDIAN', sourceColumn: 'ExistingMetric' }],
			},
			target: '<table data-kw-bind="unsupported-agg"></table>',
		},
		{
			name: 'table cell bar',
			display: {
				type: 'table',
				groupBy: ['Day'],
				columns: [
					{ name: 'Day' },
					{ name: 'Median', cellBar: { segments: [{ agg: 'MEDIAN', column: 'ExistingMetric' }] } },
				],
			},
			target: '<table data-kw-bind="unsupported-agg"></table>',
		},
		{
			name: 'chart value',
			display: { type: 'bar', groupBy: 'Day', value: { agg: 'MEDIAN', column: 'ExistingMetric' } },
			target: '<div data-kw-bind="unsupported-agg"></div>',
		},
		{
			name: 'line series',
			display: { type: 'line', xAxis: 'Day', series: [{ agg: 'MEDIAN', column: 'ExistingMetric' }] },
			target: '<div data-kw-bind="unsupported-agg"></div>',
		},
		{
			name: 'pivot',
			display: {
				type: 'pivot', rows: ['Day'], pivotBy: 'ExistingMetric', pivotValues: ['1'],
				value: 'ExistingMetric', agg: 'MEDIAN',
			},
			target: '<table data-kw-bind="unsupported-agg"></table>',
		},
		{
			name: 'repeated-table column',
			display: {
				type: 'repeatedTable',
				repeatBy: ['Day'],
				table: {
					groupBy: ['ExistingMetric'],
					columns: [
						{ name: 'ExistingMetric' },
						{ name: 'Median', agg: 'MEDIAN', sourceColumn: 'ExistingMetric' },
					],
				},
			},
			target: '<div data-kw-bind="unsupported-agg"></div>',
		},
		{
			name: 'tooltip',
			display: {
				type: 'bar', groupBy: 'Day', value: { agg: 'COUNT' },
				tooltip: { fields: [{ label: 'Median', agg: 'MEDIAN', column: 'ExistingMetric' }] },
			},
			target: '<div data-kw-bind="unsupported-agg"></div>',
		},
		{
			name: 'pre-aggregate',
			display: {
				type: 'bar',
				groupBy: 'Day',
				value: { agg: 'SUM', column: 'Computed' },
				preAggregate: { groupBy: 'Day', compute: { name: 'Computed', agg: 'MEDIAN', column: 'ExistingMetric' } },
			},
			target: '<div data-kw-bind="unsupported-agg"></div>',
		},
	])('rejects unsupported $name aggregates before rendering', ({ display, target }) => {
		const htmlCode = dashboardHtml({ 'unsupported-agg': { display } }, target);

		expect(compilePortableDashboard({ htmlCode, dataSources: [factDataSource] }).diagnostics).toEqual([{
			code: 'invalid-display',
			severity: 'error',
			message: `unsupported-agg (${display.type}: ${['bar', 'pie', 'line'].includes(display.type) ? 'invalid chart spec' : 'invalid spec'})`,
			bindingKey: 'unsupported-agg',
			displayType: display.type,
		}]);
	});

	it.each([
		{ version: '2', label: 'string version' },
		{ version: null, label: 'null version' },
	])('rejects a malformed $label instead of defaulting to v1', ({ version }) => {
		const htmlCode = `<script type="application/kw-provenance">${JSON.stringify({
			version,
			model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
			bindings: {},
		})}</script><main>Dashboard</main>`;

		const result = compilePortableDashboard({ htmlCode });

		expect(result.ir).toBeNull();
		expect(result.diagnostics).toEqual([{
			code: 'invalid-provenance',
			severity: 'error',
			message: 'Dashboard provenance version must be a finite number.',
		}]);
	});

	it.each([
		{
			label: 'invalid JSON',
			htmlCode: '<script type="application/kw-provenance">{broken</script>',
			message: 'Dashboard provenance contains invalid JSON.',
		},
		{
			label: 'non-object JSON',
			htmlCode: '<script type="application/kw-provenance">[]</script>',
			message: 'Dashboard provenance must be a JSON object.',
		},
		{
			label: 'missing fact identity',
			htmlCode: '<script type="application/kw-provenance">{"version":1,"model":{"fact":{}},"bindings":{}}</script>',
			message: 'Dashboard provenance model.fact.sectionId is required.',
		},
	])('returns invalid-provenance for $label', ({ htmlCode, message }) => {
		const result = compilePortableDashboard({ htmlCode });

		expect(result.ir).toBeNull();
		expect(result.diagnostics).toEqual([{
			code: 'invalid-provenance',
			severity: 'error',
			message,
		}]);
	});

	it.each([
		{ dimension: { column: 'Day', label: 42 }, label: 'label' },
		{ dimension: { column: 'Day', mode: 'slider' }, label: 'mode' },
	])('rejects an invalid slicer $label without emitting portable IR', ({ dimension }) => {
		const htmlCode = dashboardHtml(
			{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
			'<span data-kw-bind="total"></span>',
			[dimension],
		);

		const result = compilePortableDashboard({ htmlCode, dataSources: [factDataSource] });

		expect(result.ir).toBeNull();
		expect(result.diagnostics).toEqual([{
			code: 'invalid-dimension',
			severity: 'error',
			message: 'model.dimensions[0] (invalid slicer spec)',
			role: 'model.dimensions[0]',
		}]);
	});

	it('rejects duplicate mixed targets instead of letting renderers select different elements', () => {
		const htmlCode = dashboardHtml(
			{
				table: {
					display: { type: 'table', groupBy: ['Day'], columns: [{ name: 'Day' }] },
				},
			},
			'<div data-kw-bind="table"></div><table data-kw-bind="table"></table>',
		);

		const result = compilePortableDashboard({ htmlCode, dataSources: [factDataSource] });

		expect(result.diagnostics).toEqual([{
			code: 'duplicate-target',
			severity: 'error',
			message: 'table (table: expected exactly one data-kw-bind target, found 2)',
			bindingKey: 'table',
			displayType: 'table',
		}]);
		expect(result.ir?.bindings[0].admitted).toBe(false);
	});
});

describe('portable dashboard compiler ownership', () => {
	const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

	it('keeps admission decisions in the shared compiler', () => {
		const compiler = source('src/shared/portableDashboardCompiler.ts');
		const compatibility = source('src/shared/htmlDashboardUpgrade.ts');
		const powerBiExport = source('src/host/powerBiExport.ts');
		const powerBiPublish = source('src/host/powerBiPublish.ts');
		const htmlSection = source('src/webview/sections/kw-html-section.ts');
		const tools = source('src/host/kustoWorkbenchTools.ts');

		expect(compiler).toContain('export function compilePortableDashboard');
		expect(compiler).toContain("'missing-column'");
		expect(compiler).toContain('PortableDashboardIr');
		expect(compatibility).toContain('compilePortableDashboard');
		expect(compatibility).not.toContain('function findDataKwBindTargetElements');
		expect(compatibility).not.toContain('function isValidScalarDisplay');
		expect(powerBiExport).toContain('const portableDashboard = validatePowerBiHtmlBindings');
		expect(powerBiExport).toContain('portableIr.bindings');
		expect(powerBiExport).not.toContain('function findMissingPowerBiBindingColumns');
		expect(powerBiExport).not.toContain('function parseProvenance');
		expect(htmlSection).toContain('portableDashboardIrToProvenance');
		expect(htmlSection).toContain('const portableDashboard = compilePortableDashboard');
		expect(htmlSection).toContain('JSON.stringify(portableProvenance)');
		expect(htmlSection).toContain('const dimensions = portableProvenance.model.dimensions');
		expect(htmlSection).not.toContain('JSON.stringify(this._provenance ?? null)');
		expect(htmlSection).toContain('analyzeHtmlDashboardPowerBiCompatibility(code, dataSources)');
		expect(tools).toContain('getPowerBiHtmlValidationDiagnostics');
		expect(powerBiPublish).toContain('exportHtmlToPowerBI');
	});
});