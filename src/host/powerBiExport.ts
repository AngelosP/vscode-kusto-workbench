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

// ── Provenance parsing (local copy — avoids cross-boundary webview import) ──

interface CellTemplate {
	element?: string;       // wrapper element tag, default 'span'
	baseClass?: string;     // always-applied CSS class (e.g. "success-badge")
	thresholds: Array<{ min: number; class: string }>;  // evaluated descending; first match wins
	defaultClass: string;   // CSS class when no threshold matches
}

interface FlatDisplay { type: 'flat'; columns: string[]; headers?: Record<string, string>; formats?: Record<string, string>; cellTemplates?: Record<string, CellTemplate> }
interface PivotDisplay { type: 'pivot'; rows: string[]; pivotBy: string; pivotValues: string[]; value: string; agg: string; format?: string; total?: boolean }
interface ScalarDisplay { type: 'scalar'; agg: string; column: string; format?: string }

interface ProvenanceBinding {
	sectionId: string;
	sectionName: string;
	columns?: string[];
	column?: string;
	row?: number;
	display?: FlatDisplay | PivotDisplay | ScalarDisplay;
}

interface Provenance {
	version: number;
	bindings: Record<string, ProvenanceBinding>;
}

function parseProvenance(htmlCode: string): Provenance | null {
	try {
		const match = htmlCode.match(/<script\s+type\s*=\s*["']application\/kw-provenance["'][^>]*>([\s\S]*?)<\/script>/i);
		if (!match) return null;
		const json = JSON.parse(match[1]);
		if (!json || typeof json !== 'object' || !json.bindings || typeof json.bindings !== 'object') return null;
		return json as Provenance;
	} catch { return null; }
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

// ── Conditional cell formatting ─────────────────────────────────────────────

/**
 * Build a DAX expression that wraps a formatted value in an HTML element with
 * conditional CSS classes based on the raw numeric column value.
 * Returns just the inner `<span>...</span>` fragment — the caller wraps it in `<td>`.
 *
 * Example output (for SuccessRate ≥80→high, ≥40→mid, else low):
 * ```
 * "<span class=""success-badge " & IF([SuccessRate] >= 80, "success-high", IF([SuccessRate] >= 40, "success-mid", "success-low")) & """>" & FORMAT([SuccessRate], "0.00") & "%" & "</span>"
 * ```
 *
 * Note: `formattedValExpr` may contain `&` operators (e.g. `FORMAT(...) & "%"`).
 * This is safe because DAX `&` is left-to-right string concatenation.
 */
function buildConditionalCellDax(colRef: string, formattedValExpr: string, template: CellTemplate): string {
	const tag = escapeDaxString(template.element || 'span');
	const baseClass = template.baseClass ? escapeDaxString(template.baseClass) + ' ' : '';

	// Sort thresholds descending by min — highest checked first
	const sorted = [...(template.thresholds || [])].sort((a, b) => b.min - a.min);

	// Build the IF chain for class selection
	let classExpr: string;
	if (sorted.length === 0) {
		classExpr = `"${escapeDaxString(template.defaultClass)}"`;
	} else {
		// Build from inside out: innermost is defaultClass
		classExpr = `"${escapeDaxString(template.defaultClass)}"`;
		for (let i = sorted.length - 1; i >= 0; i--) {
			const t = sorted[i];
			classExpr = `IF(${colRef} >= ${t.min}, "${escapeDaxString(t.class)}", ${classExpr})`;
		}
	}

	return `"<${tag} class=""${baseClass}" & ${classExpr} & """>" & ${formattedValExpr} & "</${tag}>"`;
}

// ── Display-specific DAX generators ─────────────────────────────────────────

interface DaxVarResult { theadVar?: string; theadDax?: string; rowsVar?: string; rowsDax?: string; scalarVar?: string; scalarDax?: string }

/** Extract CSS classes from original `<th>` elements in the table HTML. Returns one class string per column (empty if none). */
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

function generateFlatTableDax(pbiTable: string, display: FlatDisplay, ds: PowerBiDataSource, varIdx: number, originalThClasses: string[] = []): DaxVarResult {
	const theadVar = `_thead_${varIdx}`;
	const rowsVar = `_rows_${varIdx}`;

	// thead — use display headers (fallback to source column name), preserve original CSS classes
	const thCells = display.columns.map((colName, i) => {
		const headerText = escapeDaxString(display.headers?.[colName] || colName);
		const cls = originalThClasses[i] || '';
		return cls
			? `<th class=""${escapeDaxString(cls)}"">${headerText}</th>`
			: `<th>${headerText}</th>`;
	}).join('');
	const theadDax = `"<thead><tr>${thCells}</tr></thead>"`;

	// tbody — CONCATENATEX with per-column formatting + optional conditional templates
	// Reuse the same CSS classes from the original <th> on each <td>
	const tdExprs = display.columns.map((colName, i) => {
		const col = ds.columns.find(c => c.name === colName);
		let valExpr: string;
		if (display.formats?.[colName]) {
			valExpr = buildFormatExpr(escCol(colName), display.formats[colName]);
		} else if (col) {
			valExpr = daxColumnExpr(colName, col.type);
		} else {
			valExpr = escCol(colName);
		}

		const cls = originalThClasses[i] || '';
		const tdOpen = cls ? `<td class=""${escapeDaxString(cls)}"">`  : '<td>';

		// Wrap in conditional template if one is defined for this column
		const template = display.cellTemplates?.[colName];
		const isNum = col ? isNumericKustoType(col.type) : false;
		if (template && isNum) {
			const innerExpr = buildConditionalCellDax(escCol(colName), valExpr, template);
			return `"${tdOpen}" & ${innerExpr} & "</td>"`;
		}

		return `"${tdOpen}" & ${valExpr} & "</td>"`;
	}).join(' & ');
	const rowsDax = `CONCATENATEX(${escTable(pbiTable)}, "<tr>" & ${tdExprs} & "</tr>", "")`;

	return { theadVar, theadDax, rowsVar, rowsDax };
}

function generatePivotTableDax(pbiTable: string, display: PivotDisplay, ds: PowerBiDataSource, varIdx: number): DaxVarResult {
	if (display.pivotValues.length === 0) return {};

	const theadVar = `_thead_${varIdx}`;
	const rowsVar = `_rows_${varIdx}`;
	const rawFmt = display.format || resolveRawFormat(display.value, ds);
	const tbl = escTable(pbiTable);

	// thead — row dimensions + pivot value headers + optional Total
	const rowHeaders = display.rows.map(r => `<th>${escapeDaxString(r)}</th>`).join('');
	const pivotHeaders = display.pivotValues.map(v => `<th style=""text-align:right"">${escapeDaxString(v)}</th>`).join('');
	const totalHeader = display.total === true ? '<th style=""text-align:right"">Total</th>' : '';
	const theadDax = `"<thead><tr>${rowHeaders}${pivotHeaders}${totalHeader}</tr></thead>"`;

	// tbody — iterate over distinct row values
	const rowDimCells = display.rows.map(r => `"<td>" & ${escCol(r)} & "</td>"`).join(' & ');

	// For each pivot value: CALCULATE(AGG(...), filter)
	const aggName = (display.agg || 'SUM').toUpperCase();
	const pivotCells = display.pivotValues.map(val => {
		const filterExpr = `${tbl}${escCol(display.pivotBy)} = "${escapeDaxString(val)}"`;
		const calcExpr = aggName === 'COUNT'
			? `CALCULATE(COUNTROWS(${tbl}), ${filterExpr})`
			: `CALCULATE(${aggName}X(${tbl}, ${escCol(display.value)}), ${filterExpr})`;
		return `"<td style=""text-align:right"">" & ${buildFormatExpr(calcExpr, rawFmt)} & "</td>"`;
	}).join(' & ');

	// Optional total column (no filter = all pivot values)
	let totalCell = '';
	if (display.total === true) {
		const totalExpr = aggName === 'COUNT'
			? `CALCULATE(COUNTROWS(${tbl}))`
			: `CALCULATE(${aggName}X(${tbl}, ${escCol(display.value)}))`;
		totalCell = ` & "<td style=""text-align:right""><strong>" & ${buildFormatExpr(totalExpr, rawFmt)} & "</strong></td>"`;
	}

	const rowExpr = `"<tr>" & ${rowDimCells} & ${pivotCells}${totalCell} & "</tr>"`;
	const sortCol = `${tbl}${escCol(display.rows[0])}`;
	const rowsDax = `CONCATENATEX(VALUES(${sortCol}), ${rowExpr}, "", ${sortCol}, ASC)`;

	return { theadVar, theadDax, rowsVar, rowsDax };
}

function generateScalarDaxVar(pbiTable: string, display: ScalarDisplay, ds: PowerBiDataSource, varIdx: number): DaxVarResult {
	const scalarVar = `_scalar_${varIdx}`;
	const rawFmt = display.format || resolveRawFormat(display.column, ds);
	const aggExpr = mapAggToDax(display.agg, pbiTable, display.column);
	const scalarDax = buildFormatExpr(aggExpr, rawFmt);
	return { scalarVar, scalarDax };
}

// ── Column name remapping (provenance → actual) ────────────────────────────

/**
 * Build a remap function that maps provenance column names to actual data-source
 * column names using positional correspondence.  When the provenance `columns`
 * array is missing, empty, or a different length than the data-source columns
 * the returned function is the identity.
 */
function buildColumnRemap(bindingColumns: string[] | undefined, dsColumns: Array<{ name: string }>): (name: string) => string {
	if (!bindingColumns || bindingColumns.length === 0 || bindingColumns.length !== dsColumns.length) return n => n;
	const map = new Map<string, string>();
	for (let i = 0; i < bindingColumns.length; i++) {
		if (bindingColumns[i] !== dsColumns[i].name) {
			map.set(bindingColumns[i], dsColumns[i].name);
		}
	}
	if (map.size === 0) return n => n;
	return n => map.get(n) ?? n;
}

/** Remap column-name keys in a record, preserving values. */
function remapRecordKeys<V>(rec: Record<string, V> | undefined, remap: (n: string) => string): Record<string, V> | undefined {
	if (!rec) return rec;
	const out: Record<string, V> = {};
	for (const [k, v] of Object.entries(rec)) out[remap(k)] = v;
	return out;
}

/** Create a remapped copy of a display spec so that all column references use actual data-source names. */
function remapDisplay(display: FlatDisplay | PivotDisplay | ScalarDisplay, remap: (n: string) => string): FlatDisplay | PivotDisplay | ScalarDisplay {
	if (display.type === 'flat') {
		return {
			...display,
			columns: display.columns.map(remap),
			headers: remapRecordKeys(display.headers, remap),
			formats: remapRecordKeys(display.formats, remap),
			cellTemplates: remapRecordKeys(display.cellTemplates, remap),
		};
	}
	if (display.type === 'pivot') {
		return {
			...display,
			rows: display.rows.map(remap),
			pivotBy: remap(display.pivotBy),
			value: remap(display.value),
			// pivotValues are data values, not column names — leave unchanged
		};
	}
	// scalar
	return { ...display, column: remap(display.column) };
}

/**
 * Generate a DAX measure expression that builds HTML from live DirectQuery data.
 * v2 provenance: uses `display` specs (flat/pivot/scalar) for explicit DAX generation.
 * v1 fallback: heuristic based on `<table>` vs non-table element detection.
 */
export function generateDaxMeasure(htmlCode: string, dataSources: PowerBiDataSource[]): string {
	const provenance = parseProvenance(htmlCode);
	if (!provenance || dataSources.length === 0) {
		return `"${escapeDaxString(htmlCode)}"`;
	}

	// Map binding keys → data sources via sectionId
	const dsMap = new Map<string, { ds: PowerBiDataSource; pbiTable: string; binding: ProvenanceBinding }>();
	for (const [key, binding] of Object.entries(provenance.bindings)) {
		const ds = dataSources.find(d => d.sectionId === binding.sectionId);
		if (ds) {
			dsMap.set(key, { ds, pbiTable: sanitizeName(ds.name), binding });
		}
	}

	if (dsMap.size === 0) {
		return `"${escapeDaxString(htmlCode)}"`;
	}

	// Strip provenance script block (not needed in PBI)
	let html = htmlCode.replace(/<script\s+type\s*=\s*["']application\/kw-provenance["'][^>]*>[\s\S]*?<\/script>/gi, '');

	const vars: string[] = [];
	let varIdx = 0;

	// Process each binding
	for (const [key, { ds, pbiTable, binding }] of dsMap) {
		const bindAttr = `data-kw-bind\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`;

		// ── v2 display-driven dispatch (takes priority) ─────────────────
		if (binding.display) {
			// Remap provenance column names → actual data-source column names
			const remap = buildColumnRemap(binding.columns, ds.columns);
			const display = remapDisplay(binding.display, remap);

			if (display.type === 'flat' || display.type === 'pivot') {
				// Find the <table> element for this binding
				const tableRe = new RegExp(
					`(<table\\b[^>]*?\\b${bindAttr}[^>]*>)([\\s\\S]*?)(</table>)`, 'i',
				);
				const tableMatch = html.match(tableRe);
				if (!tableMatch) continue;

				const originalClasses = extractOriginalThClasses(tableMatch[2]);
				const result = display.type === 'flat'
					? generateFlatTableDax(pbiTable, display, ds, varIdx, originalClasses)
					: generatePivotTableDax(pbiTable, display as PivotDisplay, ds, varIdx);

				if (result.theadVar && result.theadDax) vars.push(`VAR ${result.theadVar} = ${result.theadDax}`);
				if (result.rowsVar && result.rowsDax) vars.push(`VAR ${result.rowsVar} = ${result.rowsDax}`);

				const replaced = `${tableMatch[1]}{{${result.theadVar}}}{{${result.rowsVar}}}${tableMatch[3]}`;
				html = html.replace(tableMatch[0], () => replaced);
				varIdx++;
				continue;
			}

			if (display.type === 'scalar') {
				// Find the element for this binding
				const scalarRe = new RegExp(
					`(<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*?\\b${bindAttr}[^>]*>)([\\s\\S]*?)(</\\2>)`, 'i',
				);
				const scalarMatch = html.match(scalarRe);
				if (!scalarMatch) continue;

				const result = generateScalarDaxVar(pbiTable, display as ScalarDisplay, ds, varIdx);
				if (result.scalarVar && result.scalarDax) {
					vars.push(`VAR ${result.scalarVar} = ${result.scalarDax}`);
					html = html.replace(scalarMatch[0], () => `${scalarMatch[1]}{{${result.scalarVar}}}${scalarMatch[4]}`);
				}
				varIdx++;
				continue;
			}
		}

		// ── v1 heuristic fallback (no display spec) ─────────────────────

		// Check for <table> binding
		const tableRe = new RegExp(
			`(<table\\b[^>]*?\\b${bindAttr}[^>]*>)([\\s\\S]*?)(</table>)`, 'i',
		);
		const tableMatch = html.match(tableRe);

		if (tableMatch) {
			const varName = `_rows_${varIdx}`;
			const theadVar = `_thead_${varIdx}`;
			varIdx++;

			const origClasses = extractOriginalThClasses(tableMatch[2]);
			const thCells = ds.columns.map((c, i) => {
				const cls = origClasses[i] || '';
				return cls
					? `<th class=""${escapeDaxString(cls)}"">${escapeDaxString(c.name)}</th>`
					: `<th>${escapeDaxString(c.name)}</th>`;
			}).join('');
			vars.push(`VAR ${theadVar} = "<thead><tr>${thCells}</tr></thead>"`);

			const tdExprs = ds.columns.map((c, i) => {
				const cls = origClasses[i] || '';
				const tdOpen = cls ? `<td class=""${escapeDaxString(cls)}"">` : '<td>';
				return `"${tdOpen}" & ${daxColumnExpr(c.name, c.type)} & "</td>"`;
			}).join(' & ');
			vars.push(`VAR ${varName} = CONCATENATEX(${escTable(pbiTable)}, "<tr>" & ${tdExprs} & "</tr>", "")`);

			const replaced = `${tableMatch[1]}{{${theadVar}}}{{${varName}}}${tableMatch[3]}`;
			html = html.replace(tableMatch[0], () => replaced);
			continue;
		}

		// Check for scalar (non-table) binding
		const scalarRe = new RegExp(
			`(<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*?\\b${bindAttr}[^>]*>)([\\s\\S]*?)(</\\2>)`, 'i',
		);
		const scalarMatch = html.match(scalarRe);

		if (scalarMatch) {
			const varName = `_scalar_${varIdx}`;
			varIdx++;

			let targetCol: { name: string; type: string } | undefined;
			if (binding.column) {
				targetCol = ds.columns.find(c => c.name === binding.column);
			}
			if (!targetCol) {
				targetCol = ds.columns.find(c => isNumericKustoType(c.type));
			}

			if (targetCol) {
				const ref = escCol(targetCol.name);
				const fmt = isNumericKustoType(targetCol.type)
					? (targetCol.type.toLowerCase() === 'long' || targetCol.type.toLowerCase() === 'int' ? '"#,##0"' : '"#,##0.##"')
					: '"0"';
				vars.push(`VAR ${varName} = FORMAT(SUMX(${escTable(pbiTable)}, ${ref}), ${fmt})`);
				html = html.replace(scalarMatch[0], () => `${scalarMatch[1]}{{${varName}}}${scalarMatch[4]}`);
			}
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
 */
export function generateHtmlContentVisualJson(visualName: string, pageHeight = 720): string {
	return JSON.stringify({
		$schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.8.0/schema.json',
		name: visualName,
		position: {
			x: 25,
			y: 0,
			z: 0,
			height: pageHeight,
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

// ── Generate TMDL semantic model files ──────────────────────────────────────

function generateModelTmdl(tableNames: string[]): string {
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

	lines.push('');
	lines.push('ref cultureInfo en-US');
	lines.push('');

	return lines.join('\n');
}

function generateTableTmdl(ds: PowerBiDataSource): string {
	const tableName = sanitizeName(ds.name);
	// Collapse query to a single line (TMDL M expression strings cannot span multiple lines
	// inside the expression block without breaking the indentation parser) and escape " as "".
	const singleLineQuery = ds.query.replace(/\r\n|\r|\n/g, ' ').replace(/\s+/g, ' ').trim();
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
	const pageHeight = Math.min(14400, Math.max(720, input.previewHeight || 720));

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
		generateHtmlContentVisualJson(visualId, pageHeight),
	);

	// ── Semantic model
	await write(`${modelFolder}/definition.pbism`, generateDefinitionPbism());
	const tableNames = input.dataSources.map(ds => sanitizeName(ds.name));
	await write(`${modelFolder}/definition/model.tmdl`, generateModelTmdl(tableNames));
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
