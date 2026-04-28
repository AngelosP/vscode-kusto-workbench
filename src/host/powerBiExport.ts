// Power BI export: generates a PBIP project folder that uses the marketplace
// HTML Content visual to render an HTML section's code with Kusto DirectQuery data.

import * as vscode from 'vscode';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PowerBiDataSource {
	name: string;
	sectionId: string;
	clusterUrl: string;
	database: string;
	query: string;
	columns: Array<{ name: string; type: string }>;
}

export interface PowerBiExportInput {
	htmlCode: string;
	sectionName: string;
	projectName?: string;
	dataSources: PowerBiDataSource[];
	previewHeight?: number;
}

// ── Sanitize name for file system / Power BI identifiers ────────────────────

function sanitizeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50) || 'KustoHtmlDashboard';
}

// ── Map Kusto column types to TMDL data types ──────────────────────────────

function kustoTypeToTmdl(kustoType: string): string {
	const t = (kustoType || '').toLowerCase();
	if (t === 'datetime' || t === 'date') return 'dateTime';
	if (t === 'timespan' || t === 'time') return 'string';
	if (t === 'long' || t === 'int') return 'int64';
	if (t === 'real' || t === 'double' || t === 'decimal') return 'double';
	if (t === 'bool' || t === 'boolean') return 'boolean';
	if (t === 'guid' || t === 'uuid') return 'string';
	if (t === 'dynamic') return 'string';
	return 'string';
}

// ── HTML Content marketplace visual ─────────────────────────────────────────
// AppSource GUID for "HTML Content" by Daniel Marsh-Patrick (free, MIT, marketplace-signed).
// Works on locked-down tenants that block file-imported .pbiviz custom visuals.
const HTML_CONTENT_VISUAL_GUID = 'htmlContent443BE3AD55E043BF878BED274D3A6855';

// Measures table name (prefixed to avoid collision with user data source table names)
const MEASURES_TABLE_NAME = '_KW_HtmlMeasures';
const HTML_MEASURE_NAME = 'HTML Dashboard';

// ── DAX generation helpers ──────────────────────────────────────────────────

/** Escape `]` → `]]` for DAX column references like `[My Column]]Name]`. */
export function escapeDaxColumnRef(name: string): string {
	return name.replace(/]/g, ']]');
}

/** Return a DAX expression for a column value, formatted by Kusto type. */
export function daxColumnExpr(colName: string, kustoType: string): string {
	const ref = `[${escapeDaxColumnRef(colName)}]`;
	const t = (kustoType || '').toLowerCase();
	if (t === 'long' || t === 'int') return `FORMAT(${ref}, "#,##0")`;
	if (t === 'real' || t === 'double' || t === 'decimal') return `FORMAT(${ref}, "#,##0.##")`;
	if (t === 'datetime' || t === 'date') return `FORMAT(${ref}, "yyyy-MM-dd HH:mm")`;
	if (t === 'bool' || t === 'boolean') return `IF(${ref}, "true", "false")`;
	return ref;
}

/** Return true if a Kusto type is numeric. */
function isNumericKustoType(t: string): boolean {
	const lower = (t || '').toLowerCase();
	return lower === 'long' || lower === 'int' || lower === 'real' || lower === 'double' || lower === 'decimal';
}

// ── Provenance v1 — shared data model ───────────────────────────────────────
// The provenance block declares a single fact table (event-grain KQL query) and
// dimensions (slicer columns from the fact table).  Bindings declare how to
// aggregate the fact data into visuals (scalars, tables, pivots).

interface ScalarDisplay { type: 'scalar'; agg: string; column?: string; format?: string }

interface TableColumnSpec { name: string; header?: string; agg?: string; sourceColumn?: string; format?: string }
interface TableDisplay { type: 'table'; columns: TableColumnSpec[]; groupBy: string[]; orderBy?: { column: string; direction?: 'asc' | 'desc' }; top?: number; preAggregate?: PreAggregate }

interface PivotDisplay { type: 'pivot'; rows: string[]; pivotBy: string; pivotValues: string[]; value: string; agg: string; format?: string; total?: boolean; preAggregate?: PreAggregate }

// ── Chart display types (SVG-based visuals for PBI export) ──────────────────

interface ChartValue { agg: string; column?: string; format?: string }
interface BarDisplay { type: 'bar'; groupBy: string; value: ChartValue; top?: number; colors?: string[]; preAggregate?: PreAggregate }
interface LineSeriesSpec { agg: string; column?: string; label?: string }
interface LineDisplay { type: 'line'; xAxis: string; series: LineSeriesSpec[]; colors?: string[]; preAggregate?: PreAggregate }
interface PieDisplay { type: 'pie'; groupBy: string; value: ChartValue; top?: number; colors?: string[]; preAggregate?: PreAggregate }

/**
 * Pre-aggregate specification: creates an intermediate DAX table by grouping
 * the fact table and computing a derived column.  The binding then aggregates
 * from this intermediate table instead of the raw fact table.
 *
 * Example: "count distinct skills per session" → `{ groupBy: "SessionId", compute: { name: "SkillsPerSession", agg: "DISTINCTCOUNT", column: "SkillName" } }`
 *
 * The `compute.name` must NOT collide with existing fact table column names.
 */
interface PreAggregate {
	groupBy: string | string[];
	compute: { name: string; agg: string; column?: string };
}

type ChartDisplay = BarDisplay | LineDisplay | PieDisplay;

const CHART_COLORS = ['#FFC20A', '#0C7BDC', '#4819B1', '#EE6914', '#8E88E8', '#A0DACF', '#04F704', '#4C4B54', '#D81B60', '#5F6B6D'];

interface ModelFact { sectionId: string; sectionName: string }
export interface ModelDimension { column: string; label?: string; mode?: 'dropdown' | 'list' | 'between' }

export interface ResolvedSlicer { tableName: string; columnName: string; mode: 'dropdown' | 'list' | 'between' }

interface ProvenanceBinding {
	display?: ScalarDisplay | TableDisplay | PivotDisplay | ChartDisplay;
}

interface Provenance {
	version: number;
	model: { fact: ModelFact; dimensions?: ModelDimension[] };
	bindings: Record<string, ProvenanceBinding>;
}

function parseProvenance(htmlCode: string): Provenance | null {
	try {
		const match = htmlCode.match(/<script\s+type\s*=\s*["']application\/kw-provenance["'][^>]*>([\s\S]*?)<\/script>/i);
		if (!match) return null;
		const json = JSON.parse(match[1]);
		if (!json || typeof json !== 'object') return null;
		if (!json.model?.fact?.sectionId) return null;
		if (!json.bindings || typeof json.bindings !== 'object') return null;
		return { version: json.version ?? 1, model: json.model, bindings: json.bindings };
	} catch { return null; }
}

export function resolveFactTableSlicers(factDs: PowerBiDataSource | undefined, dimensions: ModelDimension[]): ResolvedSlicer[] {
	if (!factDs) return [];
	const factTableName = sanitizeName(factDs.name);
	const resolvedSlicers: ResolvedSlicer[] = [];
	for (const dim of dimensions) {
		const col = factDs.columns.find(c => c.name === dim.column);
		if (!col) continue;
		const colType = (col.type || '').toLowerCase();
		const mode = dim.mode || (colType === 'datetime' || colType === 'date' ? 'between' : 'dropdown');
		resolvedSlicers.push({ tableName: factTableName, columnName: dim.column, mode });
	}
	return resolvedSlicers;
}

// ── DAX aggregation mapping ─────────────────────────────────────────────────

function escTable(name: string): string { return `'${name.replace(/'/g, "''")}'`; }
function escCol(name: string): string { return `[${escapeDaxColumnRef(name)}]`; }

/** Map an aggregation name + table + column to a DAX expression. */
function mapAggToDax(agg: string, pbiTable: string, colName?: string): string {
	const tbl = escTable(pbiTable);
	const col = colName ? escCol(colName) : '';
	switch ((agg || 'SUM').toUpperCase()) {
		case 'SUM': return `SUMX(${tbl}, ${col})`;
		case 'AVG': case 'AVERAGE': return `AVERAGEX(${tbl}, ${col})`;
		case 'MAX': return `MAXX(${tbl}, ${col})`;
		case 'MIN': return `MINX(${tbl}, ${col})`;
		case 'COUNT': return `COUNTROWS(${tbl})`;
		case 'DISTINCTCOUNT': case 'DCOUNT': return `DISTINCTCOUNT(${tbl}${col})`;
		default: return `SUMX(${tbl}, ${col})`;
	}
}

/** Resolve a raw format pattern string (without DAX quotes). */
function resolveRawFormat(colName: string | undefined, ds: PowerBiDataSource): string {
	if (colName) {
		const col = ds.columns.find(c => c.name === colName);
		if (col && isNumericKustoType(col.type)) {
			return col.type.toLowerCase() === 'long' || col.type.toLowerCase() === 'int' ? '#,##0' : '#,##0.##';
		}
	}
	return '#,##0';
}

/** Resolve a DAX FORMAT pattern from an explicit format string or from Kusto column type. */
function resolveFormat(explicitFormat: string | undefined, colName: string | undefined, ds: PowerBiDataSource): string {
	const raw = explicitFormat || resolveRawFormat(colName, ds);
	return `"${escapeDaxString(raw)}"`;
}

/**
 * Build a DAX FORMAT expression from a format pattern.
 * Handles `%` specially: Kusto percentages are typically 0-100 (pre-multiplied),
 * but DAX FORMAT auto-multiplies by 100 when `%` is in the format string.
 * We strip `%` from the format and append it as a literal string instead.
 */
function buildFormatExpr(valueExpr: string, format: string): string {
	if (format.includes('%')) {
		// Strip % from format, append as literal text
		const fmtWithoutPct = format.replace(/%/g, '');
		return `FORMAT(${valueExpr}, "${escapeDaxString(fmtWithoutPct)}") & "%"`;
	}
	return `FORMAT(${valueExpr}, "${escapeDaxString(format)}")`;
}

function foldDaxBinaryFunction(functionName: 'MIN' | 'MAX', expressions: string[]): string {
	if (expressions.length === 0) return 'BLANK()';
	return expressions.slice(1).reduce((acc, expr) => `${functionName}(${acc}, ${expr})`, expressions[0]);
}

function columnType(dataSource: PowerBiDataSource | undefined, colName: string): string {
	return dataSource?.columns.find(c => c.name === colName)?.type?.toLowerCase() ?? '';
}

function lineAxisLabelExpr(valueExpr: string, colName: string, dataSource?: PowerBiDataSource): string {
	const type = columnType(dataSource, colName);
	if (type === 'datetime' || type === 'date') return `FORMAT(${valueExpr}, "yyyy-MM-dd")`;
	if (isNumericKustoType(type)) return `FORMAT(${valueExpr}, "#,##0.##")`;
	return valueExpr;
}

// ── Display-specific DAX generators (v1 — all aggregate from single fact table) ──

interface DaxVarResult { theadVar?: string; theadDax?: string; rowsVar?: string; rowsDax?: string; scalarVar?: string; scalarDax?: string; preVars?: string[] }

/** Extract CSS classes from original `<th>` elements in the table HTML. */
function extractOriginalThClasses(tableInnerHtml: string): string[] {
	const theadMatch = tableInnerHtml.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
	if (!theadMatch) return [];
	const thRe = /<th\b([^>]*)>/gi;
	const classes: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = thRe.exec(theadMatch[1])) !== null) {
		const classMatch = m[1].match(/class\s*=\s*["']([^"']+)["']/i);
		classes.push(classMatch ? classMatch[1] : '');
	}
	return classes;
}

/** Build a DAX aggregation expression for a table column spec inside ADDCOLUMNS. */
function buildColumnAggExpr(col: TableColumnSpec, factTable: string): string {
	const agg = (col.agg || 'SUM').toUpperCase();
	const srcCol = col.sourceColumn || col.name;
	const tbl = escTable(factTable);
	if (agg === 'DISTINCTCOUNT' || agg === 'DCOUNT') return `CALCULATE(DISTINCTCOUNT(${tbl}${escCol(srcCol)}))`;
	if (agg === 'COUNT') return `CALCULATE(COUNTROWS(${tbl}))`;
	if (agg === 'SUM') return `CALCULATE(SUMX(${tbl}, ${escCol(srcCol)}))`;
	if (agg === 'AVG' || agg === 'AVERAGE') return `CALCULATE(AVERAGEX(${tbl}, ${escCol(srcCol)}))`;
	if (agg === 'MAX') return `CALCULATE(MAXX(${tbl}, ${escCol(srcCol)}))`;
	if (agg === 'MIN') return `CALCULATE(MINX(${tbl}, ${escCol(srcCol)}))`;
	return `CALCULATE(SUMX(${tbl}, ${escCol(srcCol)}))`;
}

function generateScalarDaxVar(factTable: string, display: ScalarDisplay, varIdx: number): DaxVarResult {
	const scalarVar = `_scalar_${varIdx}`;
	const agg = (display.agg || 'COUNT').toUpperCase();
	const tbl = escTable(factTable);
	let aggExpr: string;
	if (agg === 'DISTINCTCOUNT' || agg === 'DCOUNT') {
		aggExpr = `DISTINCTCOUNT(${tbl}${escCol(display.column || '')})`;
	} else if (agg === 'COUNT') {
		aggExpr = `COUNTROWS(${tbl})`;
	} else {
		aggExpr = mapAggToDax(display.agg, factTable, display.column);
	}
	const rawFmt = display.format || '#,##0';
	const scalarDax = buildFormatExpr(aggExpr, rawFmt);
	return { scalarVar, scalarDax };
}

// ── Pre-aggregate support ───────────────────────────────────────────────────

/**
 * Generate a DAX VAR for a pre-aggregate intermediate table.
 * Returns `["VAR _pre_N = ADDCOLUMNS(VALUES('Fact'[GroupBy]), "ComputedCol", CALCULATE(...))"]`.
 */
function generatePreAggregateVarDax(factTable: string, preAgg: PreAggregate, varIdx: number): string {
	const tbl = escTable(factTable);
	const preVarName = `_pre_${varIdx}`;
	const cols = Array.isArray(preAgg.groupBy) ? preAgg.groupBy : [preAgg.groupBy];
	const agg = (preAgg.compute.agg || 'COUNT').toUpperCase();
	const col = preAgg.compute.column;
	let aggExpr: string;
	if (agg === 'DISTINCTCOUNT' || agg === 'DCOUNT') aggExpr = `CALCULATE(DISTINCTCOUNT(${tbl}${escCol(col || '')}))`;
	else if (agg === 'COUNT') aggExpr = `CALCULATE(COUNTROWS(${tbl}))`;
	else if (agg === 'SUM') aggExpr = `CALCULATE(SUMX(${tbl}, ${escCol(col || '')}))`;
	else if (agg === 'AVG' || agg === 'AVERAGE') aggExpr = `CALCULATE(AVERAGEX(${tbl}, ${escCol(col || '')}))`;
	else if (agg === 'MAX') aggExpr = `CALCULATE(MAXX(${tbl}, ${escCol(col || '')}))`;
	else if (agg === 'MIN') aggExpr = `CALCULATE(MINX(${tbl}, ${escCol(col || '')}))`;
	else aggExpr = `CALCULATE(COUNTROWS(${tbl}))`;
	// Single column → VALUES; multiple columns → SUMMARIZE
	const groupSource = cols.length === 1
		? `VALUES(${tbl}${escCol(cols[0])})`
		: `SUMMARIZE(${tbl}, ${cols.map(c => `${tbl}${escCol(c)}`).join(', ')})`;
	return `VAR ${preVarName} = ADDCOLUMNS(${groupSource}, "${escapeDaxString(preAgg.compute.name)}", ${aggExpr})`;
}

/**
 * Build a second-level DAX aggregation expression that operates on a pre-aggregate
 * VAR table using FILTER + EARLIER for row context.
 * Used for computed columns when `preAggregate` is active.
 */
function buildPreAggColumnAggExpr(col: TableColumnSpec, preVarName: string, groupByCols: string[]): string {
	const agg = (col.agg || 'COUNT').toUpperCase();
	const srcCol = col.sourceColumn || col.name;
	const filterExpr = groupByCols.map(g => `${escCol(g)} = EARLIER(${escCol(g)})`).join(' && ');
	const filtered = `FILTER(${preVarName}, ${filterExpr})`;
	if (agg === 'COUNT') return `COUNTROWS(${filtered})`;
	if (agg === 'DISTINCTCOUNT' || agg === 'DCOUNT') return `COUNTROWS(DISTINCT(SELECTCOLUMNS(${filtered}, "x", ${escCol(srcCol)})))`;
	if (agg === 'SUM') return `SUMX(${filtered}, ${escCol(srcCol)})`;
	if (agg === 'AVG' || agg === 'AVERAGE') return `AVERAGEX(${filtered}, ${escCol(srcCol)})`;
	if (agg === 'MAX') return `MAXX(${filtered}, ${escCol(srcCol)})`;
	if (agg === 'MIN') return `MINX(${filtered}, ${escCol(srcCol)})`;
	return `COUNTROWS(${filtered})`;
}

/** Build a second-level aggregation for chart value specs on a pre-aggregate VAR table. */
function buildPreAggChartValExpr(value: ChartValue, preVarName: string, groupByCol: string): string {
	const agg = (value.agg || 'COUNT').toUpperCase();
	const srcCol = value.column || '';
	const filterExpr = `${escCol(groupByCol)} = EARLIER(${escCol(groupByCol)})`;
	const filtered = `FILTER(${preVarName}, ${filterExpr})`;
	if (agg === 'COUNT') return `COUNTROWS(${filtered})`;
	if (agg === 'DISTINCTCOUNT' || agg === 'DCOUNT') return `COUNTROWS(DISTINCT(SELECTCOLUMNS(${filtered}, "x", ${escCol(srcCol)})))`;
	if (agg === 'SUM') return `SUMX(${filtered}, ${escCol(srcCol)})`;
	if (agg === 'AVG' || agg === 'AVERAGE') return `AVERAGEX(${filtered}, ${escCol(srcCol)})`;
	if (agg === 'MAX') return `MAXX(${filtered}, ${escCol(srcCol)})`;
	if (agg === 'MIN') return `MINX(${filtered}, ${escCol(srcCol)})`;
	return `COUNTROWS(${filtered})`;
}

function generateTableDaxVars(factTable: string, display: TableDisplay, varIdx: number, originalThClasses: string[] = []): DaxVarResult {
	const theadVar = `_thead_${varIdx}`;
	const rowsVar = `_rows_${varIdx}`;
	const tbl = escTable(factTable);
	const preVars: string[] = [];

	// thead
	const thCells = display.columns.map((col, i) => {
		const headerText = escapeDaxString(col.header || col.name);
		const cls = originalThClasses[i] || '';
		return cls ? `<th class=""${escapeDaxString(cls)}"">${headerText}</th>` : `<th>${headerText}</th>`;
	}).join('');
	const theadDax = `"<thead><tr>${thCells}</tr></thead>"`;

	let summarizedTable: string;

	if (display.preAggregate) {
		// Two-level aggregation: create pre-aggregate VAR, then SUMMARIZE from it
		const preVarName = `_pre_${varIdx}`;
		preVars.push(generatePreAggregateVarDax(factTable, display.preAggregate, varIdx));

		// groupBy columns reference the pre-aggregate table (unqualified)
		const groupByCols = display.groupBy.map(g => escCol(g)).join(', ');
		const computedCols = display.columns.filter(c => c.agg);
		const addColumnParts = computedCols.map(c =>
			`"${escapeDaxString(c.name)}", ${buildPreAggColumnAggExpr(c, preVarName, display.groupBy)}`,
		).join(', ');

		if (addColumnParts) {
			summarizedTable = `ADDCOLUMNS(SUMMARIZE(${preVarName}, ${groupByCols}), ${addColumnParts})`;
		} else {
			summarizedTable = `SUMMARIZE(${preVarName}, ${groupByCols})`;
		}
	} else {
		// Standard single-level aggregation from the fact table
		const groupByCols = display.groupBy.map(g => `${tbl}${escCol(g)}`).join(', ');
		const computedCols = display.columns.filter(c => c.agg);
		const addColumnParts = computedCols.map(c => `"${escapeDaxString(c.name)}", ${buildColumnAggExpr(c, factTable)}`).join(', ');

		if (addColumnParts) {
			summarizedTable = `ADDCOLUMNS(SUMMARIZE(${tbl}, ${groupByCols}), ${addColumnParts})`;
		} else {
			summarizedTable = `SUMMARIZE(${tbl}, ${groupByCols})`;
		}
	}

	// Optionally wrap in TOPN
	if (display.top && display.orderBy) {
		const dir = (display.orderBy.direction || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
		summarizedTable = `TOPN(${display.top}, ${summarizedTable}, ${escCol(display.orderBy.column)}, ${dir})`;
	}

	// CONCATENATEX for HTML rows
	const tdExprs = display.columns.map((col, i) => {
		let valExpr: string;
		if (col.format) {
			valExpr = buildFormatExpr(escCol(col.name), col.format);
		} else {
			valExpr = escCol(col.name);
		}
		const cls = originalThClasses[i] || '';
		const tdOpen = cls ? `<td class=""${escapeDaxString(cls)}"">` : '<td>';
		return `"${tdOpen}" & ${valExpr} & "</td>"`;
	}).join(' & ');

	// Sort for CONCATENATEX
	let sortExpr = '';
	if (display.orderBy) {
		const dir = (display.orderBy.direction || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
		sortExpr = `, ${escCol(display.orderBy.column)}, ${dir}`;
	}

	const rowsDax = `CONCATENATEX(${summarizedTable}, "<tr>" & ${tdExprs} & "</tr>", ""${sortExpr})`;

	return { theadVar, theadDax, rowsVar, rowsDax, ...(preVars.length > 0 ? { preVars } : {}) };
}

function generatePivotDaxVars(factTable: string, display: PivotDisplay, varIdx: number): DaxVarResult {
	if (!display.pivotValues || display.pivotValues.length === 0) return {};

	const theadVar = `_thead_${varIdx}`;
	const rowsVar = `_rows_${varIdx}`;
	const rawFmt = display.format || '#,##0';
	const tbl = escTable(factTable);
	const preVars: string[] = [];

	// thead
	const rowHeaders = display.rows.map(r => `<th>${escapeDaxString(r)}</th>`).join('');
	const pivotHeaders = display.pivotValues.map(v => `<th style=""text-align:right"">${escapeDaxString(v)}</th>`).join('');
	const totalHeader = display.total === true ? '<th style=""text-align:right"">Total</th>' : '';
	const theadDax = `"<thead><tr>${rowHeaders}${pivotHeaders}${totalHeader}</tr></thead>"`;

	const aggName = (display.agg || 'SUM').toUpperCase();

	let rowDimCells: string;
	let pivotCells: string;
	let totalCell = '';
	let rowExpr: string;
	let rowsDax: string;

	if (display.preAggregate) {
		// Two-level aggregation: create pre-agg VAR with all needed dimensions
		const preVarName = `_pre_${varIdx}`;
		preVars.push(generatePreAggregateVarDax(factTable, display.preAggregate, varIdx));
		const computedCol = escCol(display.preAggregate.compute.name);

		// Row dim cells — unqualified refs from pre-agg VAR
		rowDimCells = display.rows.map(r => `"<td>" & ${escCol(r)} & "</td>"`).join(' & ');

		// Pivot cells: SUMX(FILTER(preVar, [pivotBy]="val" && [row0]=EARLIER([row0]) && ...), [Computed])
		pivotCells = display.pivotValues.map(val => {
			const rowFilters = display.rows.map(r => `${escCol(r)} = EARLIER(${escCol(r)})`).join(' && ');
			const pivotFilter = `${escCol(display.pivotBy)} = "${escapeDaxString(val)}"`;
			const filterExpr = `${pivotFilter} && ${rowFilters}`;
			const filtered = `FILTER(${preVarName}, ${filterExpr})`;
			let calcExpr: string;
			if (aggName === 'COUNT') calcExpr = `COUNTROWS(${filtered})`;
			else if (aggName === 'DISTINCTCOUNT' || aggName === 'DCOUNT') calcExpr = `COUNTROWS(DISTINCT(SELECTCOLUMNS(${filtered}, "x", ${computedCol})))`;
			else if (aggName === 'SUM') calcExpr = `SUMX(${filtered}, ${computedCol})`;
			else if (aggName === 'AVG' || aggName === 'AVERAGE') calcExpr = `AVERAGEX(${filtered}, ${computedCol})`;
			else if (aggName === 'MAX') calcExpr = `MAXX(${filtered}, ${computedCol})`;
			else if (aggName === 'MIN') calcExpr = `MINX(${filtered}, ${computedCol})`;
			else calcExpr = `COUNTROWS(${filtered})`;
			return `"<td style=""text-align:right"">" & ${buildFormatExpr(calcExpr, rawFmt)} & "</td>"`;
		}).join(' & ');

		// Total cell: same but without pivotBy filter
		if (display.total === true) {
			const rowFilters = display.rows.map(r => `${escCol(r)} = EARLIER(${escCol(r)})`).join(' && ');
			const filtered = `FILTER(${preVarName}, ${rowFilters})`;
			let totalExpr: string;
			if (aggName === 'COUNT') totalExpr = `COUNTROWS(${filtered})`;
			else if (aggName === 'DISTINCTCOUNT' || aggName === 'DCOUNT') totalExpr = `COUNTROWS(DISTINCT(SELECTCOLUMNS(${filtered}, "x", ${computedCol})))`;
			else if (aggName === 'SUM') totalExpr = `SUMX(${filtered}, ${computedCol})`;
			else if (aggName === 'AVG' || aggName === 'AVERAGE') totalExpr = `AVERAGEX(${filtered}, ${computedCol})`;
			else if (aggName === 'MAX') totalExpr = `MAXX(${filtered}, ${computedCol})`;
			else if (aggName === 'MIN') totalExpr = `MINX(${filtered}, ${computedCol})`;
			else totalExpr = `COUNTROWS(${filtered})`;
			totalCell = ` & "<td style=""text-align:right""><strong>" & ${buildFormatExpr(totalExpr, rawFmt)} & "</strong></td>"`;
		}

		rowExpr = `"<tr>" & ${rowDimCells} & ${pivotCells}${totalCell} & "</tr>"`;
		// Iterate over distinct row dimension values from the pre-agg table
		const rowGroupCols = display.rows.map(r => escCol(r)).join(', ');
		const sortCol = escCol(display.rows[0]);
		rowsDax = `CONCATENATEX(SUMMARIZE(${preVarName}, ${rowGroupCols}), ${rowExpr}, "", ${sortCol}, ASC)`;
	} else {
		// Standard pivot from fact table
		rowDimCells = display.rows.map(r => `"<td>" & ${escCol(r)} & "</td>"`).join(' & ');

		pivotCells = display.pivotValues.map(val => {
			const filterExpr = `${tbl}${escCol(display.pivotBy)} = "${escapeDaxString(val)}"`;
			const calcExpr = aggName === 'COUNT'
				? `CALCULATE(COUNTROWS(${tbl}), ${filterExpr})`
				: aggName === 'DISTINCTCOUNT' || aggName === 'DCOUNT'
					? `CALCULATE(DISTINCTCOUNT(${tbl}${escCol(display.value)}), ${filterExpr})`
					: `CALCULATE(${aggName}X(${tbl}, ${escCol(display.value)}), ${filterExpr})`;
			return `"<td style=""text-align:right"">" & ${buildFormatExpr(calcExpr, rawFmt)} & "</td>"`;
		}).join(' & ');

		if (display.total === true) {
			const totalExpr = aggName === 'COUNT'
				? `CALCULATE(COUNTROWS(${tbl}))`
				: aggName === 'DISTINCTCOUNT' || aggName === 'DCOUNT'
					? `CALCULATE(DISTINCTCOUNT(${tbl}${escCol(display.value)}))`
					: `CALCULATE(${aggName}X(${tbl}, ${escCol(display.value)}))`;
			totalCell = ` & "<td style=""text-align:right""><strong>" & ${buildFormatExpr(totalExpr, rawFmt)} & "</strong></td>"`;
		}

		rowExpr = `"<tr>" & ${rowDimCells} & ${pivotCells}${totalCell} & "</tr>"`;
		const sortCol = `${tbl}${escCol(display.rows[0])}`;
		rowsDax = `CONCATENATEX(VALUES(${sortCol}), ${rowExpr}, "", ${sortCol}, ASC)`;
	}

	return { theadVar, theadDax, rowsVar, rowsDax, ...(preVars.length > 0 ? { preVars } : {}) };
}

// ── SVG chart DAX generators ────────────────────────────────────────────────
// Chart generators push VARs directly into the `vars[]` array and return the
// final SVG marker name (e.g. "_bar_0") for HTML replacement.

/**
 * Build a DAX expression that XML-escapes a column value for safe embedding
 * inside SVG `<text>` elements.  Handles `&`, `<`, `>`, `"`.
 */
function daxXmlEscape(colExpr: string): string {
	return `SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(${colExpr}, "&", "&amp;"), "<", "&lt;"), ">", "&gt;"), """", "&quot;")`;
}

/** Build a DAX aggregation expression for chart value specs. */
function chartAggExpr(val: ChartValue, factTable: string): string {
	const agg = (val.agg || 'COUNT').toUpperCase();
	const tbl = escTable(factTable);
	if (agg === 'COUNT') return `CALCULATE(COUNTROWS(${tbl}))`;
	if (agg === 'DISTINCTCOUNT' || agg === 'DCOUNT') return `CALCULATE(DISTINCTCOUNT(${tbl}${escCol(val.column || '')}))`;
	if (agg === 'SUM') return `CALCULATE(SUMX(${tbl}, ${escCol(val.column || '')}))`;
	if (agg === 'AVG' || agg === 'AVERAGE') return `CALCULATE(AVERAGEX(${tbl}, ${escCol(val.column || '')}))`;
	if (agg === 'MAX') return `CALCULATE(MAXX(${tbl}, ${escCol(val.column || '')}))`;
	if (agg === 'MIN') return `CALCULATE(MINX(${tbl}, ${escCol(val.column || '')}))`;
	return `CALCULATE(COUNTROWS(${tbl}))`;
}

/** Pick a color from the palette by 0-based index. */
function chartColor(colors: string[] | undefined, idx: number): string {
	const palette = colors && colors.length > 0 ? colors : CHART_COLORS;
	return palette[idx % palette.length];
}

/**
 * Generate DAX for a horizontal bar chart SVG.
 * Pushes intermediate VARs into `vars[]`, returns the final marker name.
 */
export function generateBarChartDax(factTable: string, display: BarDisplay, varIdx: number, vars: string[]): string {
	const tbl = escTable(factTable);
	const dp = `_bardata_${varIdx}`;
	const mp = `_barmax_${varIdx}`;
	const sp = `_bar_${varIdx}`;

	let dataTable: string;
	let groupByRef: string; // column reference for labels in CONCATENATEX
	if (display.preAggregate) {
		const preVarName = `_pre_${varIdx}`;
		vars.push(generatePreAggregateVarDax(factTable, display.preAggregate, varIdx));
		const groupCol = escCol(display.groupBy); // unqualified — references pre-aggregate VAR column
		const valExpr = buildPreAggChartValExpr(display.value, preVarName, display.groupBy);
		dataTable = `ADDCOLUMNS(SUMMARIZE(${preVarName}, ${groupCol}), "Val", ${valExpr})`;
		groupByRef = groupCol;
	} else {
		const aggExpr = chartAggExpr(display.value, factTable);
		dataTable = `ADDCOLUMNS(SUMMARIZE(${tbl}, ${tbl}${escCol(display.groupBy)}), "Val", ${aggExpr})`;
		groupByRef = `${tbl}${escCol(display.groupBy)}`;
	}
	if (display.top) {
		dataTable = `TOPN(${display.top}, ${dataTable}, [Val], DESC)`;
	}
	vars.push(`VAR ${dp} = ${dataTable}`);
	vars.push(`VAR ${mp} = MAXX(${dp}, [Val])`);

	// SVG geometry constants
	const labelW = 80;
	const barMaxW = 200;
	const valGap = 6;
	const rowH = 24;
	const gap = 4;
	const totalW = labelW + barMaxW + 60;

	// CONCATENATEX emitting SVG elements per row
	const colorCases = Array.from({ length: 10 }, (_, i) =>
		`${i + 1}, "${chartColor(display.colors, i)}"`,
	).join(', ');

	const fmtStr = escapeDaxString(display.value.format || '#,##0');
	const svgExpr = `CONCATENATEX(`
		+ `ADDCOLUMNS(${dp}, "Idx", RANKX(${dp}, [Val],, DESC, DENSE)), `
		+ `VAR _y = ([Idx] - 1) * ${rowH + gap} `
		+ `VAR _w = IF(${mp} = 0, 0, [Val] / ${mp} * ${barMaxW}) `
		+ `VAR _col = SWITCH([Idx], ${colorCases}, "${chartColor(display.colors, 0)}") `
		+ `RETURN `
		+ `"<text x='${labelW - 6}' y='" & FORMAT(_y + 16, "0") & "' text-anchor='end' font-size='11' fill='#605E5C'>" & ${daxXmlEscape(groupByRef)} & "</text>" `
		+ `& "<rect x='${labelW}' y='" & FORMAT(_y + 2, "0") & "' width='" & FORMAT(_w, "0") & "' height='${rowH - 4}' rx='2' fill='" & _col & "'/>" `
		+ `& "<text x='" & FORMAT(${labelW} + _w + ${valGap}, "0") & "' y='" & FORMAT(_y + 16, "0") & "' font-size='11' fill='#605E5C'>" & FORMAT([Val], "${fmtStr}") & "</text>", `
		+ `"", [Idx], ASC)`;

	const countExpr = `COUNTROWS(${dp})`;
	const heightExpr = `FORMAT(${countExpr} * ${rowH + gap}, "0")`;
	const svgDax = `"<svg viewBox='0 0 ${totalW} " & ${heightExpr} & "' xmlns='http://www.w3.org/2000/svg' style='width:100%;height:auto'>" & ${svgExpr} & "</svg>"`;
	vars.push(`VAR ${sp} = ${svgDax}`);
	return sp;
}

/**
 * Generate DAX for a donut/pie chart SVG.
 * Uses stroke-dasharray circles (no sin/cos needed).
 */
export function generatePieChartDax(factTable: string, display: PieDisplay, varIdx: number, vars: string[]): string {
	const tbl = escTable(factTable);
	const dp = `_piedata_${varIdx}`;
	const tp = `_pietotal_${varIdx}`;
	const sp = `_pie_${varIdx}`;

	let dataTable: string;
	if (display.preAggregate) {
		const preVarName = `_pre_${varIdx}`;
		vars.push(generatePreAggregateVarDax(factTable, display.preAggregate, varIdx));
		const groupCol = escCol(display.groupBy);
		const valExpr = buildPreAggChartValExpr(display.value, preVarName, display.groupBy);
		dataTable = `ADDCOLUMNS(SUMMARIZE(${preVarName}, ${groupCol}), "Val", ${valExpr})`;
	} else {
		const aggExpr = chartAggExpr(display.value, factTable);
		dataTable = `ADDCOLUMNS(SUMMARIZE(${tbl}, ${tbl}${escCol(display.groupBy)}), "Val", ${aggExpr})`;
	}
	if (display.top) {
		dataTable = `TOPN(${display.top}, ${dataTable}, [Val], DESC)`;
	}
	vars.push(`VAR ${dp} = ${dataTable}`);
	vars.push(`VAR ${tp} = SUMX(${dp}, [Val])`);

	// Circle geometry
	const cx = 100;
	const cy = 100;
	const outerR = 80;
	const innerR = 50;
	const strokeW = outerR - innerR;
	const effectiveR = (outerR + innerR) / 2;
	const svgW = 200;
	const svgH = 200;

	const colorCases = Array.from({ length: 10 }, (_, i) =>
		`${i + 1}, "${chartColor(display.colors, i)}"`,
	).join(', ');

	// Build ranked table with running totals
	const rankedTable = `ADDCOLUMNS(${dp}, "Rank", RANKX(${dp}, [Val],, DESC, DENSE))`;

	const svgExpr = `CONCATENATEX(`
		+ `ADDCOLUMNS(${rankedTable}, `
		+ `"PrevSum", VAR _r = [Rank] RETURN SUMX(FILTER(${rankedTable}, [Rank] < _r), [Val])), `
		+ `VAR _circ = 2 * PI() * ${effectiveR} `
		+ `VAR _segLen = IF(${tp} = 0, 0, [Val] / ${tp} * _circ) `
		+ `VAR _offset = _circ / 4 - IF(${tp} = 0, 0, [PrevSum] / ${tp} * _circ) `
		+ `VAR _col = SWITCH([Rank], ${colorCases}, "${chartColor(display.colors, 0)}") `
		+ `RETURN `
		+ `"<circle cx='${cx}' cy='${cy}' r='${effectiveR}' fill='none' stroke='" & _col & "' stroke-width='${strokeW}' `
		+ `stroke-dasharray='" & FORMAT(_segLen, "0.00") & " " & FORMAT(_circ - _segLen, "0.00") & "' `
		+ `stroke-dashoffset='" & FORMAT(_offset, "0.00") & "'/>", `
		+ `"", [Rank], ASC)`;

	const svgDax = `"<svg viewBox='0 0 ${svgW} ${svgH}' xmlns='http://www.w3.org/2000/svg' style='width:100%;height:auto'>" & ${svgExpr} & "</svg>"`;
	vars.push(`VAR ${sp} = ${svgDax}`);
	return sp;
}

/**
 * Generate DAX for a line chart SVG.
 * Produces a `<polyline>` per series with equally-spaced x-axis points.
 */
export function generateLineChartDax(factTable: string, display: LineDisplay, varIdx: number, vars: string[], dataSource?: PowerBiDataSource): string {
	const tbl = escTable(factTable);
	const dp = `_linedata_${varIdx}`;
	const sp = `_line_${varIdx}`;

	let xAxisRef: string; // column reference for RANKX and CONCATENATEX sort

	if (display.preAggregate) {
		const preVarName = `_pre_${varIdx}`;
		vars.push(generatePreAggregateVarDax(factTable, display.preAggregate, varIdx));
		xAxisRef = escCol(display.xAxis); // unqualified — on pre-agg VAR

		// Build series columns with second-level aggregation from pre-agg table
		const seriesCols = display.series.map((s, i) => {
			const filterExpr = `${xAxisRef} = EARLIER(${xAxisRef})`;
			const filtered = `FILTER(${preVarName}, ${filterExpr})`;
			const agg = (s.agg || 'COUNT').toUpperCase();
			const srcCol = s.column || '';
			let expr: string;
			if (agg === 'COUNT') expr = `COUNTROWS(${filtered})`;
			else if (agg === 'DISTINCTCOUNT' || agg === 'DCOUNT') expr = `COUNTROWS(DISTINCT(SELECTCOLUMNS(${filtered}, "x", ${escCol(srcCol)})))`;
			else if (agg === 'SUM') expr = `SUMX(${filtered}, ${escCol(srcCol)})`;
			else if (agg === 'AVG' || agg === 'AVERAGE') expr = `AVERAGEX(${filtered}, ${escCol(srcCol)})`;
			else if (agg === 'MAX') expr = `MAXX(${filtered}, ${escCol(srcCol)})`;
			else if (agg === 'MIN') expr = `MINX(${filtered}, ${escCol(srcCol)})`;
			else expr = `COUNTROWS(${filtered})`;
			return `"S${i}", ${expr}`;
		}).join(', ');

		vars.push(`VAR ${dp} = ADDCOLUMNS(SUMMARIZE(${preVarName}, ${xAxisRef}), ${seriesCols})`);
	} else {
		xAxisRef = `${tbl}${escCol(display.xAxis)}`;

		// Build data table with all series columns from fact table
		const seriesCols = display.series.map((s, i) => {
			const seriesVal: ChartValue = { agg: s.agg, column: s.column };
			return `"S${i}", ${chartAggExpr(seriesVal, factTable)}`;
		}).join(', ');

		vars.push(`VAR ${dp} = ADDCOLUMNS(SUMMARIZE(${tbl}, ${xAxisRef}), ${seriesCols})`);
	}

	// Chart geometry
	const padL = 52;
	const padR = 16;
	const padT = 14;
	const padB = 32;
	const W = 760;
	const H = 220;
	const plotW = W - padL - padR;
	const plotH = H - padT - padB;

	// Compute min/max across all series for Y scaling
	const allSeriesMinMax = display.series.map((_, i) => `[S${i}]`);
	const minExprs = allSeriesMinMax.map(s => `MINX(${dp}, ${s})`);
	const maxExprs = allSeriesMinMax.map(s => `MAXX(${dp}, ${s})`);
	vars.push(`VAR _linemin_${varIdx} = ${foldDaxBinaryFunction('MIN', minExprs)}`);
	vars.push(`VAR _linemax_${varIdx} = ${foldDaxBinaryFunction('MAX', maxExprs)}`);
	vars.push(`VAR _linerange_${varIdx} = IF(_linemax_${varIdx} = _linemin_${varIdx}, 1, _linemax_${varIdx} - _linemin_${varIdx})`);
	vars.push(`VAR _linen_${varIdx} = COUNTROWS(${dp})`);
	vars.push(`VAR _linexfirstlabel_${varIdx} = CONCATENATEX(TOPN(1, ${dp}, ${xAxisRef}, ASC), ${lineAxisLabelExpr(xAxisRef, display.xAxis, dataSource)}, "")`);
	vars.push(`VAR _linexlastlabel_${varIdx} = CONCATENATEX(TOPN(1, ${dp}, ${xAxisRef}, DESC), ${lineAxisLabelExpr(xAxisRef, display.xAxis, dataSource)}, "")`);

	const indexedTable = `ADDCOLUMNS(${dp}, "Idx", RANKX(${dp}, ${xAxisRef},, ASC, DENSE))`;
	const gridLines = Array.from({ length: 5 }, (_, grid) => {
		const y = padT + grid * plotH / 4;
		const yValue = `_linemax_${varIdx} - (${grid} * _linerange_${varIdx} / 4)`;
		return `"<line x1='${padL}' y1='${y}' x2='${W - padR}' y2='${y}' stroke='#E6E6E6' stroke-width='1'/>" `
			+ `& "<text x='${padL - 8}' y='${y + 4}' text-anchor='end' font-size='11' fill='#605E5C'>" & ${daxXmlEscape(`FORMAT(${yValue}, "#,##0")`)} & "</text>"`;
	}).join(' & ');
	const axisLines = `"<line x1='${padL}' y1='${padT}' x2='${padL}' y2='${padT + plotH}' stroke='#C8C6C4' stroke-width='1'/>" `
		+ `& "<line x1='${padL}' y1='${padT + plotH}' x2='${W - padR}' y2='${padT + plotH}' stroke='#C8C6C4' stroke-width='1'/>"`;
	const xLabels = `"<text x='${padL}' y='${H - 10}' font-size='11' fill='#605E5C'>" & ${daxXmlEscape(`_linexfirstlabel_${varIdx}`)} & "</text>" `
		+ `& "<text x='${W - padR}' y='${H - 10}' text-anchor='end' font-size='11' fill='#605E5C'>" & ${daxXmlEscape(`_linexlastlabel_${varIdx}`)} & "</text>"`;

	// Generate one polyline per series
	const polylines: string[] = [];
	for (let i = 0; i < display.series.length; i++) {
		const pointsVar = `_linepts_${varIdx}_${i}`;
		const color = chartColor(display.colors, i);

		const pointsExpr = `CONCATENATEX(`
			+ `${indexedTable}, `
			+ `VAR _x = IF(_linen_${varIdx} <= 1, ${plotW / 2}, ${padL} + (${plotW}) * ([Idx] - 1) / (_linen_${varIdx} - 1)) `
			+ `VAR _y = ${padT} + ${plotH} - IF(_linerange_${varIdx} = 0, ${plotH / 2}, ([S${i}] - _linemin_${varIdx}) / _linerange_${varIdx} * ${plotH}) `
			+ `RETURN FORMAT(_x, "0.0") & "," & FORMAT(_y, "0.0"), `
			+ `" ", ${xAxisRef}, ASC)`;

		vars.push(`VAR ${pointsVar} = ${pointsExpr}`);
		polylines.push(`"<polyline points='" & ${pointsVar} & "' fill='none' stroke='${color}' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/>"`);
	}

	const svgContent = [gridLines, axisLines, ...polylines, xLabels].join(' & ');
	const svgDax = `"<svg class='chart-svg' viewBox='0 0 ${W} ${H}' xmlns='http://www.w3.org/2000/svg' style='width:100%;height:${H}px;display:block' role='img'>" & ${svgContent} & "</svg>"`;
	vars.push(`VAR ${sp} = ${svgDax}`);
	return sp;
}
/**
 * Match a `<table>` element that has a `data-kw-bind` attribute either on the
 * `<table>` tag itself or on a `<tbody>` child.  Returns a match-like tuple
 * `[fullMatch, openTag, innerContent, closeTag]` or null.
 *
 * Pattern 1: `<table data-kw-bind="x">...</table>`
 * Pattern 2: `<table ...><thead>...</thead><tbody data-kw-bind="x">...</tbody></table>`
 */
function matchTableElement(html: string, bindAttr: string): RegExpMatchArray | null {
	// Try <table data-kw-bind="x">
	const onTableRe = new RegExp(
		`(<table\\b[^>]*?\\b${bindAttr}[^>]*>)([\\s\\S]*?)(</table>)`, 'i',
	);
	const onTable = html.match(onTableRe);
	if (onTable) return onTable;

	// Try <tbody data-kw-bind="x"> inside a <table>
	// Use negative lookahead (?!<table\b) to prevent crossing <table> boundaries
	// when multiple tables exist in the HTML.
	const onTbodyRe = new RegExp(
		`(<table\\b[^>]*>)((?:(?!<table\\b)[\\s\\S])*?<tbody\\b[^>]*?\\b${bindAttr}[^>]*>(?:(?!<table\\b)[\\s\\S])*?)(</table>)`, 'i',
	);
	return html.match(onTbodyRe);
}

/**
 * Generate a DAX measure expression that builds HTML from a shared fact table.
 * All bindings aggregate from the single fact table declared in `model.fact`.
 * Slicer filter context propagates automatically through the star schema.
 */
export function generateDaxMeasure(htmlCode: string, dataSources: PowerBiDataSource[]): string {
	const provenance = parseProvenance(htmlCode);
	if (!provenance || dataSources.length === 0) {
		return `"${escapeDaxString(htmlCode)}"`;
	}

	// Resolve the fact table
	const factDs = dataSources.find(d => d.sectionId === provenance.model.fact.sectionId);
	if (!factDs) return `"${escapeDaxString(htmlCode)}"`;
	const factTable = sanitizeName(factDs.name);

	// Strip provenance script block (not needed in PBI)
	let html = htmlCode.replace(/<script\s+type\s*=\s*["']application\/kw-provenance["'][^>]*>[\s\S]*?<\/script>/gi, '');

	const vars: string[] = [];
	let varIdx = 0;

	// Process each binding — all reference the same fact table
	for (const [key, binding] of Object.entries(provenance.bindings)) {
		const bindAttr = `data-kw-bind\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`;

		if (!binding.display) continue;
		const display = binding.display;

		if (display.type === 'scalar') {
			const scalarRe = new RegExp(
				`(<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*?\\b${bindAttr}[^>]*>)([\\s\\S]*?)(</\\2>)`, 'i',
			);
			const scalarMatch = html.match(scalarRe);
			if (!scalarMatch) continue;

			const result = generateScalarDaxVar(factTable, display as ScalarDisplay, varIdx);
			if (result.scalarVar && result.scalarDax) {
				vars.push(`VAR ${result.scalarVar} = ${result.scalarDax}`);
				html = html.replace(scalarMatch[0], () => `${scalarMatch[1]}{{${result.scalarVar}}}${scalarMatch[4]}`);
			}
			varIdx++;
			continue;
		}

		if (display.type === 'table') {
			const tableMatch = matchTableElement(html, bindAttr);
			if (!tableMatch) continue;

			const originalClasses = extractOriginalThClasses(tableMatch[2]);
			const result = generateTableDaxVars(factTable, display as TableDisplay, varIdx, originalClasses);
			if (result.preVars) result.preVars.forEach(v => vars.push(v));
			if (result.theadVar && result.theadDax) vars.push(`VAR ${result.theadVar} = ${result.theadDax}`);
			if (result.rowsVar && result.rowsDax) vars.push(`VAR ${result.rowsVar} = ${result.rowsDax}`);

			const replaced = `${tableMatch[1]}{{${result.theadVar}}}{{${result.rowsVar}}}${tableMatch[3]}`;
			html = html.replace(tableMatch[0], () => replaced);
			varIdx++;
			continue;
		}

		if (display.type === 'pivot') {
			const tableMatch = matchTableElement(html, bindAttr);
			if (!tableMatch) continue;

			const result = generatePivotDaxVars(factTable, display as PivotDisplay, varIdx);
			if (result.preVars) result.preVars.forEach(v => vars.push(v));
			if (result.theadVar && result.theadDax) vars.push(`VAR ${result.theadVar} = ${result.theadDax}`);
			if (result.rowsVar && result.rowsDax) vars.push(`VAR ${result.rowsVar} = ${result.rowsDax}`);

			const replaced = `${tableMatch[1]}{{${result.theadVar}}}{{${result.rowsVar}}}${tableMatch[3]}`;
			html = html.replace(tableMatch[0], () => replaced);
			varIdx++;
			continue;
		}

		if (display.type === 'bar' || display.type === 'pie' || display.type === 'line') {
			const chartRe = new RegExp(
				`(<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*?\\b${bindAttr}[^>]*>)([\\s\\S]*?)(</\\2>)`, 'i',
			);
			const chartMatch = html.match(chartRe);
			if (!chartMatch) continue;

			let markerName: string;
			if (display.type === 'bar') markerName = generateBarChartDax(factTable, display as BarDisplay, varIdx, vars);
			else if (display.type === 'pie') markerName = generatePieChartDax(factTable, display as PieDisplay, varIdx, vars);
			else markerName = generateLineChartDax(factTable, display as LineDisplay, varIdx, vars, factDs);

			html = html.replace(chartMatch[0], () => `${chartMatch[1]}{{${markerName}}}${chartMatch[4]}`);
			varIdx++;
			continue;
		}
	}

	if (vars.length === 0) {
		return `"${escapeDaxString(html)}"`;
	}

	// Build the RETURN expression: split HTML at markers, escape fragments, join with &
	const markerRe = /\{\{(_[a-z]+_\d+)\}\}/g;
	const parts: string[] = [];
	let lastIndex = 0;

	for (const m of html.matchAll(markerRe)) {
		const fragment = html.substring(lastIndex, m.index);
		if (fragment) {
			parts.push(`"${escapeDaxString(fragment)}"`);
		}
		parts.push(m[1]);
		lastIndex = m.index! + m[0].length;
	}
	const trailing = html.substring(lastIndex);
	if (trailing) {
		parts.push(`"${escapeDaxString(trailing)}"`);
	}

	const returnExpr = parts.join(' & ');
	return `${vars.join(' ')} RETURN ${returnExpr}`;
}

/** Escape HTML code for embedding inside a DAX string literal (double-quoted). */
export function escapeDaxString(html: string): string {
	// DAX string literals are "...". The only escape is "" for a literal double quote.
	// Newlines are NOT allowed inside DAX string literals in TMDL, so collapse to single line.
	return html.replace(/\r\n|\r|\n/g, ' ').replace(/"/g, '""');
}

/**
 * Generate a TMDL table that holds a DAX measure containing the user's HTML/JS code.
 * When dataSources are provided and the HTML has provenance bindings, generates a
 * dynamic DAX expression with CONCATENATEX to build HTML from live DirectQuery data.
 * Otherwise, embeds the HTML as a static DAX string literal.
 */
export function generateHtmlMeasureTmdl(htmlCode: string, dataSources: PowerBiDataSource[] = []): string {
	const escapeTmdlName = (s: string) => s.replace(/'/g, "''");
	const daxExpression = generateDaxMeasure(htmlCode, dataSources);

	return [
		`table '${escapeTmdlName(MEASURES_TABLE_NAME)}'`,
		`\tlineageTag: ${crypto.randomUUID?.() ?? Math.random().toString(36).substring(2)}`,
		'',
		`\tmeasure '${escapeTmdlName(HTML_MEASURE_NAME)}' = ${daxExpression}`,
		`\t\tlineageTag: ${crypto.randomUUID?.() ?? Math.random().toString(36).substring(2)}`,
		'',
		`\tcolumn Column1`,
		`\t\tdataType: string`,
		`\t\tlineageTag: ${crypto.randomUUID?.() ?? Math.random().toString(36).substring(2)}`,
		`\t\tsummarizeBy: none`,
		`\t\tsourceColumn: Column1`,
		'',
		`\t\tannotation SummarizationSetBy = Automatic`,
		'',
		`\tpartition '${escapeTmdlName(MEASURES_TABLE_NAME)}' = m`,
		'\t\tmode: import',
		'\t\tsource =',
		'\t\t\tlet',
		'\t\t\t\tSource = Table.FromRows(Json.Document(Binary.Decompress(Binary.FromText("i44FAA==", BinaryEncoding.Base64), Compression.Deflate)), let _t = ((type nullable text) meta [Serialized.Text = true]) in type table [Column1 = _t])',
		'\t\t\tin',
		'\t\t\t\tSource',
		'',
		'\tannotation PBI_NavigationStepName = Navigation',
		'',
		'\tannotation PBI_ResultType = Table',
		'',
	].join('\n');
}

// ── Generate HTML Content visual JSON ───────────────────────────────────────

/**
 * Generate a PBIR visual.json that uses the marketplace HTML Content visual.
 * The visual reads the HTML DAX measure from the measures table.
 * @param yOffset Vertical offset when slicers occupy space above the visual.
 */
export function generateHtmlContentVisualJson(visualName: string, pageHeight = 720, yOffset = 0): string {
	return JSON.stringify({
		$schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.8.0/schema.json',
		name: visualName,
		position: {
			x: 25,
			y: yOffset,
			z: 0,
			height: pageHeight - yOffset,
			width: 1450,
			tabOrder: 0,
		},
		visual: {
			visualType: HTML_CONTENT_VISUAL_GUID,
			query: {
				queryState: {
					content: {
						projections: [
							{
								field: {
									Measure: {
										Expression: {
											SourceRef: {
												Entity: MEASURES_TABLE_NAME,
											},
										},
										Property: HTML_MEASURE_NAME,
									},
								},
								queryRef: `${MEASURES_TABLE_NAME}.${HTML_MEASURE_NAME}`,
								nativeQueryRef: HTML_MEASURE_NAME,
							},
						],
					},
				},
			},
			visualContainerObjects: {
				background: [{
					properties: {
						show: { expr: { Literal: { Value: 'false' } } },
					},
				}],
			},
			drillFilterOtherVisuals: true,
		},
	}, null, 2);
}

// ── Generate native PBI slicer visual JSON ──────────────────────────────────

export interface SlicerPosition { x: number; y: number; width: number; height: number }

/**
 * Generate a PBIR visual.json for a native Power BI slicer.
 * The slicer filters other visuals on the same page via the Category data role.
 */
export function generateSlicerVisualJson(
	visualName: string,
	tableName: string,
	columnName: string,
	position: SlicerPosition,
	mode: 'dropdown' | 'list' | 'between' = 'dropdown',
	tabOrder = 0,
): string {
	const pbiMode = mode === 'between' ? 'Between' : mode === 'list' ? 'Basic' : 'Dropdown';
	const isBetween = mode === 'between';

	const columnField = {
		Column: {
			Expression: { SourceRef: { Entity: tableName } },
			Property: columnName,
		},
	};
	const queryRef = `${tableName}.${columnName}`;

	// All slicer modes need a Values projection (with active: true) so PBI
	// binds the field and populates values.  Between-mode additionally needs
	// a sortDefinition.  Without Values + filterConfig the slicer renders
	// chrome but shows no data.
	const queryState: Record<string, unknown> = {
		Category: {
			projections: [{
				field: columnField,
				queryRef,
				nativeQueryRef: columnName,
			}],
		},
		Values: {
			projections: [{
				field: columnField,
				queryRef,
				nativeQueryRef: columnName,
				active: true,
			}],
		},
	};

	const query: Record<string, unknown> = { queryState };
	if (isBetween) {
		query.sortDefinition = {
			sort: [{ field: columnField, direction: 'Ascending' }],
			isDefaultSort: true,
		};
	}

	const result: Record<string, unknown> = {
		$schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.8.0/schema.json',
		name: visualName,
		position: {
			x: position.x,
			y: position.y,
			z: 1,
			height: position.height,
			width: position.width,
			tabOrder,
		},
		visual: {
			visualType: 'slicer',
			query,
			objects: {
				data: [{
					properties: {
						mode: { expr: { Literal: { Value: `'${pbiMode}'` } } },
					},
				}],
				selection: [{
					properties: {
						singleSelect: { expr: { Literal: { Value: 'false' } } },
					},
				}],
			},
			drillFilterOtherVisuals: true,
		},
	};

	// All slicers need a filterConfig so PBI binds the field and emits
	// cross-filter interactions to other visuals on the page.
	const filterId = Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
	result.filterConfig = {
		filters: [{
			name: filterId,
			field: columnField,
			type: 'Categorical',
		}],
	};

	return JSON.stringify(result, null, 2);
}

// ── Generate TMDL semantic model files ──────────────────────────────────────

/** A relationship entry for the TMDL model (many-to-one, from fact to dim). */
export interface TmdlRelationship {
	fromTable: string;
	fromColumn: string;
	toTable: string;
	toColumn: string;
}

function generateModelTmdl(tableNames: string[], relationships: TmdlRelationship[] = []): string {
	const allTables = [MEASURES_TABLE_NAME, ...tableNames];
	const lines = [
		'model Model',
		'\tculture: en-US',
		'\tdefaultPowerBIDataSourceVersion: powerBI_V3',
		'\tsourceQueryCulture: en-US',
		'\tdataAccessOptions',
		'\t\tlegacyRedirects',
		'\t\treturnErrorValuesAsNull',
		'',
		`annotation PBI_QueryOrder = ${JSON.stringify(allTables)}`,
		'',
		'annotation PBI_ProTooling = ["DevMode"]',
		'',
	];

	for (const name of allTables) {
		const escapeTmdlName = (s: string) => s.replace(/'/g, "''");
		lines.push(`ref table '${escapeTmdlName(name)}'`);
	}

	// Relationships (many-to-one from fact tables to dimension tables)
	if (relationships.length > 0) {
		lines.push('');
		const esc = (s: string) => s.replace(/'/g, "''");
		for (const rel of relationships) {
			const id = crypto.randomUUID?.() ?? Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
			lines.push(`relationship ${id}`);
			lines.push(`\tfromColumn: '${esc(rel.fromTable)}'.'${esc(rel.fromColumn)}'`);
			lines.push(`\ttoColumn: '${esc(rel.toTable)}'.'${esc(rel.toColumn)}'`);
			lines.push('');
		}
	}

	lines.push('');
	lines.push('ref cultureInfo en-US');
	lines.push('');

	return lines.join('\n');
}

// ── KQL comment stripping ────────────────────────────────────────────────────

/**
 * Strip KQL single-line comments (`// …`) so the query can be safely collapsed
 * to a single line. Uses a negative lookbehind to preserve `://` in URLs.
 */
function stripKqlLineComments(kql: string): string {
	return kql.replace(/(?<!:)\/\/[^\r\n]*/g, '');
}

// ── Dimension table TMDL generation ─────────────────────────────────────────

/**
 * Generate a TMDL table for a dimension (shared lookup) table.
 * The table has a single column with `isKey` and wraps the source query with
 * `| distinct <column>` to produce unique values for the slicer.
 */
export function generateDimTableTmdl(
	dimTableName: string,
	columnName: string,
	columnType: string,
	clusterUrl: string,
	database: string,
	sourceQuery: string,
): string {
	const tmdlType = kustoTypeToTmdl(columnType);
	const escapeTmdlName = (s: string) => s.replace(/'/g, "''");
	const singleLineQuery = stripKqlLineComments(sourceQuery).replace(/\r\n|\r|\n/g, ' ').replace(/\s+/g, ' ').trim();
	const dimQuery = `${singleLineQuery} | distinct ${columnName}`;
	const escapedQuery = dimQuery.replace(/"/g, '""');
	const escapedCluster = clusterUrl.replace(/"/g, '""');
	const escapedDb = database.replace(/"/g, '""');

	const lines: string[] = [
		`table '${escapeTmdlName(dimTableName)}'`,
		`\tlineageTag: ${crypto.randomUUID?.() ?? Math.random().toString(36).substring(2)}`,
		'',
		`\tcolumn '${escapeTmdlName(columnName)}'`,
		`\t\tdataType: ${tmdlType}`,
		`\t\tlineageTag: ${Math.random().toString(36).substring(2)}`,
		`\t\tsummarizeBy: none`,
		`\t\tisKey`,
		`\t\tsourceColumn: ${escapeTmdlName(columnName)}`,
		'',
		`\tpartition '${escapeTmdlName(dimTableName)}' = m`,
		'\t\tmode: directQuery',
		'\t\tsource =',
		'\t\t\tlet',
		`\t\t\t\tSource = AzureDataExplorer.Contents("${escapedCluster}", "${escapedDb}", "${escapedQuery}")`,
		'\t\t\tin',
		'\t\t\t\tSource',
	];

	return lines.join('\n');
}

function generateTableTmdl(ds: PowerBiDataSource): string {
	const tableName = sanitizeName(ds.name);
	// Strip KQL line comments, then collapse to a single line (TMDL M expression
	// strings cannot span multiple lines without breaking the indentation parser).
	const singleLineQuery = stripKqlLineComments(ds.query).replace(/\r\n|\r|\n/g, ' ').replace(/\s+/g, ' ').trim();
	const escapedQuery = singleLineQuery.replace(/"/g, '""');
	const escapeTmdlName = (s: string) => s.replace(/'/g, "''");
	const lines: string[] = [
		`table '${escapeTmdlName(tableName)}'`,
		`\tlineageTag: ${crypto.randomUUID?.() ?? Math.random().toString(36).substring(2)}`,
		'',
	];

	for (const col of ds.columns) {
		const tmdlType = kustoTypeToTmdl(col.type);
		lines.push(`\tcolumn '${escapeTmdlName(col.name)}'`);
		lines.push(`\t\tdataType: ${tmdlType}`);
		lines.push(`\t\tlineageTag: ${Math.random().toString(36).substring(2)}`);
		lines.push(`\t\tsummarizeBy: none`);
		lines.push(`\t\tsourceColumn: ${escapeTmdlName(col.name)}`);
		lines.push('');
	}

	const escapedCluster = ds.clusterUrl.replace(/"/g, '""');
	const escapedDb = ds.database.replace(/"/g, '""');
	lines.push(`\tpartition '${escapeTmdlName(tableName)}' = m`);
	lines.push(`\t\tmode: directQuery`);
	lines.push(`\t\tsource =`);
	lines.push(`\t\t\tlet`);
	lines.push(`\t\t\t\tSource = AzureDataExplorer.Contents("${escapedCluster}", "${escapedDb}", "${escapedQuery}")`);
	lines.push(`\t\t\tin`);
	lines.push(`\t\t\t\tSource`);

	return lines.join('\n');
}

// ── CSS custom-property resolution for Power BI ─────────────────────────────
// The HTML Content visual renders injected HTML inside a <div>, so :root and
// body selectors don't match — CSS custom properties never resolve. We inline
// the literal values before exporting.

/**
 * Resolve CSS custom properties (`var(--name)`) to their literal values.
 * Extracts definitions from `:root`, `html`, and `body` rule blocks, then
 * replaces `var(--name)` and `var(--name, fallback)` references inside
 * `<style>` blocks and `style=""` attributes.  `<script>` content is left
 * untouched to avoid corrupting JavaScript or provenance JSON.
 */
export function resolveCssVariables(html: string): string {
	// ── 1. Collect variable definitions from :root / html / body blocks ──
	const varDefs = new Map<string, string>();
	const selectorRe = /(?::root|html|body)\s*\{([^}]*)\}/gi;
	let sm: RegExpExecArray | null;
	while ((sm = selectorRe.exec(html)) !== null) {
		const block = sm[1];
		const propRe = /(--[\w-]+)\s*:\s*([^;]+?)(?:\s*;|\s*$)/g;
		let pm: RegExpExecArray | null;
		while ((pm = propRe.exec(block)) !== null) {
			varDefs.set(pm[1], pm[2].trim());
		}
	}
	if (varDefs.size === 0) return html;

	// ── 2. Iteratively resolve var() references inside definition values ──
	//    Handles chains like --a: var(--b); --b: #fff
	for (let pass = 0; pass < 10; pass++) {
		let changed = false;
		for (const [key, value] of varDefs) {
			const resolved = replaceVarRefs(value, varDefs);
			if (resolved !== value) { varDefs.set(key, resolved); changed = true; }
		}
		if (!changed) break;
	}

	// ── 3. Replace var() in <style> blocks ──────────────────────────────
	html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open, css, close) => {
		return open + replaceVarRefs(css, varDefs) + close;
	});

	// ── 4. Replace var() in inline style="" attributes ──────────────────
	html = html.replace(/\bstyle\s*=\s*"([^"]*)"/gi, (_m, styleVal) => {
		return `style="${replaceVarRefs(styleVal, varDefs)}"`;
	});

	return html;
}

/**
 * Replace all `var(--name)` and `var(--name, fallback)` occurrences in `text`
 * using the given variable map.  Uses paren-depth counting so fallbacks with
 * nested parentheses (e.g. `var(--x, rgba(0,0,0,.5))`) are handled correctly.
 */
function replaceVarRefs(text: string, vars: Map<string, string>): string {
	// Find each `var(` and manually walk to the matching `)`
	let result = '';
	let i = 0;
	while (i < text.length) {
		const varStart = text.indexOf('var(', i);
		if (varStart === -1) { result += text.substring(i); break; }

		result += text.substring(i, varStart);

		// Walk from the opening `(` to find the matching `)`
		let depth = 1;
		let j = varStart + 4; // past "var("
		while (j < text.length && depth > 0) {
			if (text[j] === '(') depth++;
			else if (text[j] === ')') depth--;
			j++;
		}
		// j now points past the closing `)`
		const inner = text.substring(varStart + 4, j - 1).trim();

		// Split into name and optional fallback at the first comma
		const commaIdx = inner.indexOf(',');
		const varName = (commaIdx >= 0 ? inner.substring(0, commaIdx) : inner).trim();
		const fallback = commaIdx >= 0 ? inner.substring(commaIdx + 1).trim() : undefined;

		const resolved = vars.get(varName);
		if (resolved !== undefined) {
			result += resolved;
		} else if (fallback !== undefined) {
			result += fallback;
		} else {
			// Can't resolve — keep original
			result += text.substring(varStart, j);
		}

		i = j;
	}
	return result;
}

// ── Extract background color from HTML ──────────────────────────────────────

/** Extract the body background color from the HTML's CSS. Returns null if not found. */
function extractHtmlBackground(htmlCode: string): string | null {
	// Match body { ... background: #xyz ... } or body { ... background-color: #xyz ... }
	const bodyMatch = htmlCode.match(/body\s*\{[^}]*?\bbackground(?:-color)?\s*:\s*([^;}\s]+)/i);
	return bodyMatch ? bodyMatch[1].trim() : null;
}

// ── PBI visual CSS patching (body selector → wrapper class) ─────────────────
// The HTML Content visual renders content as innerHTML of a <div>, so `body`
// selectors never match. We duplicate them with a `.kw-pbi-root` class and
// wrap the body content in a div with that class.

const PBI_ROOT_CLASS = 'kw-pbi-root';

/**
 * Patch HTML for the Power BI HTML Content visual:
 * 1. In `<style>` blocks, duplicate every selector group containing `body`
 *    with a copy where `body` is replaced by `.kw-pbi-root`.
 * 2. Wrap the `<body>` content (or entire content) in `<div class="kw-pbi-root">`.
 *
 * Must run AFTER `resolveCssVariables` and AFTER `extractHtmlBackground`.
 */
export function patchCssForPbiVisual(html: string): string {
	// ── 1. Patch <style> blocks ─────────────────────────────────────────
	html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open, css, close) => {
		return open + patchBodySelectorsInCss(css) + close;
	});

	// ── 2. Wrap body content in .kw-pbi-root div ────────────────────────
	const bodyOpenRe = /<body\b[^>]*>/i;
	const bodyCloseRe = /<\/body>/i;
	const openMatch = html.match(bodyOpenRe);
	const closeMatch = html.match(bodyCloseRe);

	if (openMatch && closeMatch) {
		const afterOpen = openMatch.index! + openMatch[0].length;
		const beforeClose = html.indexOf(closeMatch[0], afterOpen);
		html = html.substring(0, afterOpen)
			+ `<div class="${PBI_ROOT_CLASS}">`
			+ html.substring(afterOpen, beforeClose)
			+ '</div>'
			+ html.substring(beforeClose);
	} else {
		// No <body> tag — wrap everything after </head> or the entire string
		const headClose = html.indexOf('</head>');
		if (headClose >= 0) {
			const insertAt = headClose + '</head>'.length;
			html = html.substring(0, insertAt)
				+ `<div class="${PBI_ROOT_CLASS}">`
				+ html.substring(insertAt)
				+ '</div>';
		} else {
			html = `<div class="${PBI_ROOT_CLASS}">${html}</div>`;
		}
	}

	return html;
}

/**
 * For each CSS rule set in the text, if any selector in its comma-separated
 * list contains standalone `body`, duplicate the entire selector list with
 * `body` → `.kw-pbi-root`.
 *
 * Example: `body .foo, .bar { color: red }` →
 *          `body .foo, .bar, .kw-pbi-root .foo { color: red }`
 */
function patchBodySelectorsInCss(css: string): string {
	// Match: selector-group { declarations }
	// Non-greedy: [^{}]* matches selectors, \{[^}]*\} matches the block
	return css.replace(/([^{}]+)(\{[^}]*\})/g, (_, selectorGroup: string, block: string) => {
		const selectors = selectorGroup.split(',').map(s => s.trim());
		const bodyRe = /(?<![a-zA-Z0-9_-])body(?![a-zA-Z0-9_-])/g;
		const extras: string[] = [];

		for (const sel of selectors) {
			if (bodyRe.test(sel)) {
				bodyRe.lastIndex = 0;
				const patched = sel.replace(bodyRe, `.${PBI_ROOT_CLASS}`);
				extras.push(patched);
			}
		}

		if (extras.length === 0) return selectorGroup + block;
		return selectors.concat(extras).join(',') + block;
	});
}

// ── PBIR functions — matched against Power BI Desktop April 2026 output ─────

function generatePbirReportJson(): string {
	const obj: Record<string, unknown> = {
		$schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/3.2.0/schema.json',
		themeCollection: {
			baseTheme: {
				name: 'CY24SU06',
				reportVersionAtImport: { visual: '2.8.0', report: '3.2.0', page: '2.3.1' },
				type: 'SharedResources',
			},
		},
		publicCustomVisuals: [HTML_CONTENT_VISUAL_GUID],
		settings: {
			useStylableVisualContainerHeader: true,
			exportDataMode: 'AllowSummarized',
			defaultDrillFilterOtherVisuals: true,
			allowChangeFilterTypes: true,
			useEnhancedTooltips: true,
			useDefaultAggregateDisplayName: true,
		},
	};
	return JSON.stringify(obj, null, 2);
}

function generatePbirPageJson(pageName: string, pageHeight = 720, bgColor?: string): string {
	const obj: Record<string, unknown> = {
		$schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.1.0/schema.json',
		name: pageName,
		displayName: 'Dashboard',
		displayOption: 'ActualSize',
		height: pageHeight,
		width: 1500,
	};
	if (bgColor) {
		obj.objects = {
			background: [{ properties: {
				color: { solid: { color: { expr: { Literal: { Value: `'${bgColor}'` } } } } },
				transparency: { expr: { Literal: { Value: '0' } } },
			} }],
		};
	}
	return JSON.stringify(obj, null, 2);
}

function generatePbirPagesJson(pageName: string): string {
	return JSON.stringify({
		$schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.0.0/schema.json',
		pageOrder: [pageName],
		activePageName: pageName,
	}, null, 2);
}

function generatePbirVersionJson(): string {
	return JSON.stringify({
		$schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json',
		version: '2.0.0',
	}, null, 2);
}

function generateDefinitionPbir(semanticModelFolder: string): string {
	return JSON.stringify({
		$schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json',
		version: '4.0',
		datasetReference: {
			byPath: { path: `../${semanticModelFolder}` },
		},
	}, null, 2);
}

function generateDefinitionPbism(): string {
	return JSON.stringify({
		$schema: 'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json',
		version: '4.2',
		settings: {},
	}, null, 2);
}

function generatePlatformFile(type: 'Report' | 'SemanticModel', displayName: string): string {
	const uuid = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
	const logicalId = `${uuid.substring(0, 8)}-${uuid.substring(8, 12)}-${uuid.substring(12, 16)}-${uuid.substring(16, 20)}-${uuid.substring(20)}`;
	return JSON.stringify({
		$schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
		metadata: { type, displayName },
		config: { version: '2.0', logicalId },
	}, null, 2);
}

function generateDatabaseTmdl(): string {
	return 'database\n\tcompatibilityLevel: 1600\n';
}

function generateCultureTmdl(): string {
	return 'cultureInfo en-US\n';
}

// ── Main export function ────────────────────────────────────────────────────

export async function exportHtmlToPowerBI(
	input: PowerBiExportInput,
	folderUri: vscode.Uri,
): Promise<void> {
	const projectName = input.projectName || sanitizeName(input.sectionName) || 'KustoHtmlDashboard';
	const reportFolder = `${projectName}.Report`;
	const modelFolder = `${projectName}.SemanticModel`;
	const pageName = 'ReportPage1';
	const visualId = Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

	// ── Page height from actual preview rendering ──────────────────────
	// The HTML section's preview iframe measures scrollHeight and sends it.
	// PBI max page height is 14400px; default 16:9 is 720px.
	const contentHeight = Math.min(14400, Math.max(720, input.previewHeight || 720));

	// ── Slicer layout (from model.dimensions) ────────────────────────
	const provenance = parseProvenance(input.htmlCode);
	const dimensions = provenance?.model?.dimensions ?? [];

	// Resolve the fact data source
	const factDs = provenance?.model?.fact
		? input.dataSources.find(d => d.sectionId === provenance.model.fact.sectionId)
		: input.dataSources[0];
	const factTableName = factDs ? sanitizeName(factDs.name) : '';

	// Build slicer bindings directly on the fact table. Avoid generated DirectQuery
	// dimension tables here: ADX DirectQuery can fail when Power BI composes
	// joins over native KQL queries that contain `let` statements.
	const resolvedSlicers = resolveFactTableSlicers(factDs, dimensions);

	const SLICER_ROW_HEIGHT = 60;
	const SLICER_ROW_MARGIN = 20;
	const SLICER_GAP = 16;
	const hasSlicers = resolvedSlicers.length > 0;
	const slicerYOffset = hasSlicers ? SLICER_ROW_MARGIN + SLICER_ROW_HEIGHT + SLICER_ROW_MARGIN : 0;
	// The preview scrollHeight includes the injected slicer UI (~100px). In PBI
	// the slicer row is a separate native visual, so subtract the preview slicer
	// height to avoid double-counting when computing the page height.
	const PREVIEW_SLICER_APPROX = 80;
	const adjustedContentHeight = hasSlicers ? Math.max(720, contentHeight - PREVIEW_SLICER_APPROX) : contentHeight;
	const pageHeight = Math.min(14400, adjustedContentHeight + slicerYOffset);

	// ── Resolve CSS custom properties so they work in PBI HTML Content ──
	// The visual renders inside a <div>, so :root/body selectors don't
	// match and var() references never resolve.  Inline them now.
	const resolvedHtml = resolveCssVariables(input.htmlCode);

	// ── Extract background BEFORE patching body selectors (regex expects `body{`) ──
	const bgColor = extractHtmlBackground(resolvedHtml) || undefined;

	// ── Patch body selectors → .kw-pbi-root wrapper for PBI visual ──
	const pbiHtml = patchCssForPbiVisual(resolvedHtml);

	const write = async (relativePath: string, content: string | Buffer) => {
		const uri = vscode.Uri.joinPath(folderUri, relativePath);
		const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
		await vscode.workspace.fs.writeFile(uri, data);
	};

	// ── .pbip entry point
	await write(`${projectName}.pbip`, JSON.stringify({
		$schema: 'https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json',
		version: '1.0',
		artifacts: [
			{ report: { path: reportFolder } },
		],
		settings: { enableAutoRecovery: true },
	}, null, 2));

	// ── .gitignore
	await write('.gitignore', '**/.pbi/localSettings.json\n**/.pbi/cache.abf\n');

	// ── .platform files (required by PBI Desktop)
	await write(`${reportFolder}/.platform`, generatePlatformFile('Report', projectName));
	await write(`${modelFolder}/.platform`, generatePlatformFile('SemanticModel', projectName));

	// ── Report definition (PBIR format — folder-based)
	await write(`${reportFolder}/definition.pbir`, generateDefinitionPbir(modelFolder));
	await write(`${reportFolder}/definition/version.json`, generatePbirVersionJson());
	await write(`${reportFolder}/definition/report.json`, generatePbirReportJson());
	await write(`${reportFolder}/definition/pages/pages.json`, generatePbirPagesJson(pageName));
	await write(`${reportFolder}/definition/pages/${pageName}/page.json`, generatePbirPageJson(pageName, pageHeight, bgColor));

	// ── HTML Content visual (marketplace visual — references the HTML measure)
	await write(
		`${reportFolder}/definition/pages/${pageName}/visuals/${visualId}/visual.json`,
		generateHtmlContentVisualJson(visualId, pageHeight, slicerYOffset),
	);

	// ── Slicer visuals (native PBI slicers above the HTML Content visual)
	if (hasSlicers) {
		const PAGE_WIDTH = 1500;
		const SLICER_X_MARGIN = 25;
		const availableWidth = PAGE_WIDTH - 2 * SLICER_X_MARGIN;
		const slicerWidth = Math.floor((availableWidth - (resolvedSlicers.length - 1) * SLICER_GAP) / resolvedSlicers.length);

		for (let i = 0; i < resolvedSlicers.length; i++) {
			const s = resolvedSlicers[i];
			const slicerVisualId = Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
			const x = SLICER_X_MARGIN + i * (slicerWidth + SLICER_GAP);
			await write(
				`${reportFolder}/definition/pages/${pageName}/visuals/${slicerVisualId}/visual.json`,
				generateSlicerVisualJson(slicerVisualId, s.tableName, s.columnName, {
					x, y: SLICER_ROW_MARGIN, width: slicerWidth, height: SLICER_ROW_HEIGHT,
				}, s.mode, i + 1),
			);
		}
	}

	// ── Semantic model (fact tables only; slicers bind directly to fact columns)
	await write(`${modelFolder}/definition.pbism`, generateDefinitionPbism());
	const factTableNames = input.dataSources.map(ds => sanitizeName(ds.name));
	await write(`${modelFolder}/definition/model.tmdl`, generateModelTmdl(factTableNames));
	await write(`${modelFolder}/definition/database.tmdl`, generateDatabaseTmdl());
	await write(`${modelFolder}/definition/cultures/en-US.tmdl`, generateCultureTmdl());

	// ── Data source tables (Kusto DirectQuery)
	for (const ds of input.dataSources) {
		const tableName = sanitizeName(ds.name);
		await write(`${modelFolder}/definition/tables/${tableName}.tmdl`, generateTableTmdl(ds));
	}

	// ── HTML measures table (DAX measure containing the dashboard HTML/JS)
	await write(`${modelFolder}/definition/tables/${MEASURES_TABLE_NAME}.tmdl`, generateHtmlMeasureTmdl(pbiHtml, input.dataSources));
}
