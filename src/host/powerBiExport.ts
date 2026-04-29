// Power BI export: generates a PBIP project folder that uses the marketplace
// HTML Content visual to render an HTML section's code with Kusto data.

import * as vscode from 'vscode';
import {
	DASHBOARD_BAR_CHART,
	DASHBOARD_DISTRIBUTION_BAR_CHART,
	DASHBOARD_LINE_CHART,
	DASHBOARD_PIE_CHART,
	chartColor,
	escapeXmlLiteral,
	isSupportedPowerBiDisplayType,
	isValidDashboardChartDisplay,
	type BarColorRule,
	type BarDisplay,
	type ChartValue,
	type DashboardChartDisplay,
	type LineDisplay,
	type PieDisplay,
	type PreAggregate,
} from '../shared/dashboardCharts';
import {
	isTableCellBarColumn,
	isTableCellFormattedColumn,
	isValidRepeatedTableDisplay,
	isValidTableDisplay,
	repeatedTableRepeatColumns,
	REPEATED_TABLE_ROW_INDEX_ALIAS_PREFIX,
	tableAggregateNeedsColumn,
	tableCellBarAlias,
	tableCellBarColor,
	tableCellBarGeometry,
	TABLE_ROW_INDEX_ALIAS_PREFIX,
	type RepeatedTableDisplay,
	type TableCellBarSpec,
	type TableCellFormatRule,
	type TableCellFormatSpec,
	type TableCellStyleSpec,
	type TableColumnSpec,
	type TableDisplay,
} from '../shared/dashboardTables';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PowerBiDataSource {
	name: string;
	sectionId: string;
	clusterUrl: string;
	database: string;
	query: string;
	columns: Array<{ name: string; type: string }>;
}

export type PowerBiDataMode = 'import' | 'directQuery';

export function normalizePowerBiDataMode(mode: unknown, fallback: PowerBiDataMode = 'import'): PowerBiDataMode {
	return mode === 'import' || mode === 'directQuery' ? mode : fallback;
}

export interface PowerBiExportInput {
	htmlCode: string;
	sectionName: string;
	projectName?: string;
	dataSources: PowerBiDataSource[];
	dataMode?: PowerBiDataMode;
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

interface PivotDisplay { type: 'pivot'; rows: string[]; pivotBy: string; pivotValues: string[]; value: string; agg: string; format?: string; total?: boolean; preAggregate?: PreAggregate }

interface ModelFact { sectionId: string; sectionName: string }
export interface ModelDimension { column: string; label?: string; mode?: 'dropdown' | 'list' | 'between' }

export interface ResolvedSlicer { tableName: string; columnName: string; mode: 'dropdown' | 'list' | 'between' }

interface ProvenanceBinding {
	display?: ScalarDisplay | TableDisplay | PivotDisplay | DashboardChartDisplay | RepeatedTableDisplay;
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

function findDataKwBindTargets(htmlCode: string): Set<string> {
	return new Set(findDataKwBindTargetTags(htmlCode).keys());
}

function stripNonRenderedHtmlBlocks(html: string): string {
	return html.replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<template\b[\s\S]*?<\/template>|<noscript\b[\s\S]*?<\/noscript>/gi, '');
}

interface DataKwBindTargetElement { tagName: string; openTag: string }

function findDataKwBindTargetElements(htmlCode: string): Map<string, DataKwBindTargetElement[]> {
	const targets = new Map<string, DataKwBindTargetElement[]>();
	const elementHtml = stripNonRenderedHtmlBlocks(htmlCode);
	const re = /<([a-zA-Z][a-zA-Z0-9:-]*)\b[^>]*\bdata-kw-bind\s*=\s*(["'])(.*?)\2[^>]*>/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(elementHtml)) !== null) {
		const key = match[3];
		const tagName = match[1].toLowerCase();
		const elements = targets.get(key) ?? [];
		elements.push({ tagName, openTag: match[0] });
		targets.set(key, elements);
	}
	return targets;
}

function findDataKwBindTargetTags(htmlCode: string): Map<string, string[]> {
	const targetTags = new Map<string, string[]>();
	for (const [key, elements] of findDataKwBindTargetElements(htmlCode)) {
		targetTags.set(key, elements.map(element => element.tagName));
	}
	return targetTags;
}

function isHiddenDataKwBindTarget(openTag: string): boolean {
	if (/\shidden(?:\s|=|>)/i.test(openTag)) return true;
	if (/\baria-hidden\s*=\s*(["'])true\1/i.test(openTag)) return true;
	const classMatch = openTag.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
	if (classMatch && /(?:^|\s)pbi-hidden(?:\s|$)/i.test(classMatch[2])) return true;
	const styleMatch = openTag.match(/\bstyle\s*=\s*(["'])(.*?)\1/i);
	if (styleMatch && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(styleMatch[2])) return true;
	return false;
}

function bindingAttributePattern(key: string): string {
	return `data-kw-bind\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`;
}

function hasBoundContainerElement(html: string, bindAttr: string): boolean {
	const re = new RegExp(
		`<([a-zA-Z][a-zA-Z0-9:-]*)\\b[^>]*?\\b${bindAttr}[^>]*>[\\s\\S]*?</\\1>`, 'i',
	);
	return re.test(html);
}
function isRepeatedTableContainerTag(tagName: string): boolean {
	return !['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th'].includes(tagName.toLowerCase());
}

function isVisibleRepeatedTableTarget(target: DataKwBindTargetElement): boolean {
	return isRepeatedTableContainerTag(target.tagName) && !isHiddenDataKwBindTarget(target.openTag);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object';
}

function isNonEmptyText(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function aggregateRequiresColumn(agg: unknown): boolean {
	return String(agg || 'COUNT').toUpperCase() !== 'COUNT';
}

function isValidPreAggregateSpec(value: unknown): value is PreAggregate {
	if (!isObjectRecord(value) || !isObjectRecord(value.compute)) return false;
	const groupBy = value.groupBy;
	const validGroupBy = isNonEmptyText(groupBy) || (Array.isArray(groupBy) && groupBy.length > 0 && groupBy.every(isNonEmptyText));
	if (!validGroupBy || !isNonEmptyText(value.compute.name) || !isNonEmptyText(value.compute.agg)) return false;
	if (aggregateRequiresColumn(value.compute.agg) && !isNonEmptyText(value.compute.column)) return false;
	if (value.compute.column !== undefined && typeof value.compute.column !== 'string') return false;
	return true;
}

function isValidScalarDisplay(display: unknown): display is ScalarDisplay {
	if (!isObjectRecord(display) || display.type !== 'scalar') return false;
	if (display.agg !== undefined && !isNonEmptyText(display.agg)) return false;
	if (aggregateRequiresColumn(display.agg) && !isNonEmptyText(display.column)) return false;
	if (display.column !== undefined && typeof display.column !== 'string') return false;
	if (display.format !== undefined && typeof display.format !== 'string') return false;
	return true;
}

function isValidPivotDisplay(display: unknown): display is PivotDisplay {
	if (!isObjectRecord(display) || display.type !== 'pivot') return false;
	if (!Array.isArray(display.rows) || display.rows.length === 0 || !display.rows.every(isNonEmptyText)) return false;
	if (!isNonEmptyText(display.pivotBy)) return false;
	if (!Array.isArray(display.pivotValues) || display.pivotValues.length === 0 || !display.pivotValues.every(value => typeof value === 'string')) return false;
	if (!isNonEmptyText(display.agg)) return false;
	if (aggregateRequiresColumn(display.agg) && !isNonEmptyText(display.value)) return false;
	if (display.value !== undefined && typeof display.value !== 'string') return false;
	if (display.format !== undefined && typeof display.format !== 'string') return false;
	if (display.total !== undefined && typeof display.total !== 'boolean') return false;
	if (display.preAggregate !== undefined && !isValidPreAggregateSpec(display.preAggregate)) return false;
	return true;
}

function preAggregateOutputColumns(preAggregate: PreAggregate): Set<string> {
	const groupBy = Array.isArray(preAggregate.groupBy) ? preAggregate.groupBy : [preAggregate.groupBy];
	return new Set([...groupBy, preAggregate.compute.name]);
}

function tableValueColumnTypes(groupBy: string[], columns: TableColumnSpec[], sourceTypes: Map<string, string>): Map<string, string> {
	const types = new Map<string, string>();
	for (const columnName of groupBy) types.set(columnName, sourceTypes.get(columnName) ?? '');
	for (const column of columns) {
		if (isTableCellBarColumn(column)) continue;
		types.set(column.name, column.agg ? 'real' : (sourceTypes.get(column.name) ?? ''));
	}
	return types;
}

function columnKey(name: string): string {
	return name.trim().toLowerCase();
}

function findMissingPowerBiBindingTargets(htmlCode: string): string[] {
	const provenance = parseProvenance(htmlCode);
	if (!provenance) return [];
	const renderedTargetTags = findDataKwBindTargetTags(htmlCode);
	return Object.keys(provenance.bindings)
		.filter(bindingKey => !renderedTargetTags.has(bindingKey))
		.map(bindingKey => `${bindingKey} (missing data-kw-bind target)`);
}

function findMissingPowerBiBindingColumns(htmlCode: string, dataSources: PowerBiDataSource[]): string[] {
	const provenance = parseProvenance(htmlCode);
	if (!provenance) return [];
	const factDs = dataSources.find(dataSource => dataSource.sectionId === provenance.model.fact.sectionId);
	if (!factDs) return [];
	const factColumns = new Set(factDs.columns.map(column => column.name));
	const factColumnTypes = new Map(factDs.columns.map(column => [column.name, column.type]));
	const renderedTargetTags = findDataKwBindTargetTags(htmlCode);
	const missing: string[] = [];
	const requireFactColumn = (bindingKey: string, columnName: unknown, role: string) => {
		if (isNonEmptyText(columnName) && !factColumns.has(columnName)) missing.push(`${bindingKey} (${role}: missing column ${columnName})`);
	};
	const requireAllowedColumn = (bindingKey: string, columnName: unknown, role: string, allowedColumns: Set<string>) => {
		if (isNonEmptyText(columnName) && !allowedColumns.has(columnName)) missing.push(`${bindingKey} (${role}: missing column ${columnName})`);
	};
	const requireNumericCellFormatColumn = (bindingKey: string, column: TableColumnSpec, role: string, rowColumnTypes: Map<string, string>) => {
		if (!isTableCellFormattedColumn(column)) return;
		const columnName = column.cellFormat.valueColumn ?? column.name;
		const columnTypeName = rowColumnTypes.get(columnName);
		if (columnTypeName === undefined) {
			missing.push(`${bindingKey} (${role}: missing column ${columnName})`);
		} else if (!isNumericKustoType(columnTypeName)) {
			missing.push(`${bindingKey} (${role}: non-numeric column ${columnName})`);
		}
	};
	const preAggregateColumnTypes = (preAggregate: PreAggregate): Map<string, string> => {
		const groupBy = Array.isArray(preAggregate.groupBy) ? preAggregate.groupBy : [preAggregate.groupBy];
		const types = new Map<string, string>();
		for (const columnName of groupBy) types.set(columnName, factColumnTypes.get(columnName) ?? '');
		types.set(preAggregate.compute.name, 'real');
		return types;
	};
	const validatePreAggregate = (bindingKey: string, preAggregate: PreAggregate | undefined): Set<string> | undefined => {
		if (!preAggregate) return undefined;
		const groupBy = Array.isArray(preAggregate.groupBy) ? preAggregate.groupBy : [preAggregate.groupBy];
		for (const columnName of groupBy) requireFactColumn(bindingKey, columnName, 'preAggregate.groupBy');
		const computeNameKey = columnKey(preAggregate.compute.name);
		const groupByCollision = groupBy.find(columnName => columnKey(columnName) === computeNameKey);
		const factCollision = factDs.columns.find(column => columnKey(column.name) === computeNameKey);
		if (groupByCollision) {
			missing.push(`${bindingKey} (preAggregate.compute.name: collides with groupBy column ${groupByCollision})`);
		} else if (factCollision) {
			missing.push(`${bindingKey} (preAggregate.compute.name: collides with fact column ${factCollision.name})`);
		}
		if (aggregateRequiresColumn(preAggregate.compute.agg)) requireFactColumn(bindingKey, preAggregate.compute.column, 'preAggregate.compute.column');
		return preAggregateOutputColumns(preAggregate);
	};
	const dimensions = Array.isArray(provenance.model.dimensions) ? provenance.model.dimensions : [];
	for (let i = 0; i < dimensions.length; i++) {
		const dimension = dimensions[i];
		if (isObjectRecord(dimension) && isNonEmptyText(dimension.column) && !factColumns.has(dimension.column)) {
			missing.push(`model.dimensions[${i}] (slicer: missing column ${dimension.column})`);
		}
	}
	for (const [bindingKey, binding] of Object.entries(provenance.bindings)) {
		if (!renderedTargetTags.has(bindingKey) || !binding.display) continue;
		const display = binding.display;
		if (isValidScalarDisplay(display)) {
			if (aggregateRequiresColumn(display.agg)) requireFactColumn(bindingKey, display.column, 'column');
		} else if (isValidTableDisplay(display)) {
			const preColumns = validatePreAggregate(bindingKey, display.preAggregate);
			const outputColumns = preColumns ?? factColumns;
			const outputColumnTypes = display.preAggregate ? preAggregateColumnTypes(display.preAggregate) : factColumnTypes;
			const rowColumnTypes = tableValueColumnTypes(display.groupBy, display.columns, outputColumnTypes);
			for (const columnName of display.groupBy) requireAllowedColumn(bindingKey, columnName, 'groupBy', outputColumns);
			for (let i = 0; i < display.columns.length; i++) {
				const column = display.columns[i];
				if (isTableCellBarColumn(column)) {
					for (let s = 0; s < column.cellBar.segments.length; s++) {
						const segment = column.cellBar.segments[s];
						if (tableAggregateNeedsColumn(segment.agg)) requireAllowedColumn(bindingKey, segment.column, `columns[${i}].cellBar.segments[${s}].column`, outputColumns);
					}
					continue;
				}
				const sourceColumn = column.sourceColumn || column.name;
				if (column.agg) {
					if (tableAggregateNeedsColumn(column.agg)) requireAllowedColumn(bindingKey, sourceColumn, 'column', outputColumns);
				} else {
					requireAllowedColumn(bindingKey, column.name, 'column', outputColumns);
				}
				requireNumericCellFormatColumn(bindingKey, column, `columns[${i}].cellFormat.valueColumn`, rowColumnTypes);
			}
			if (display.orderBy) {
				const orderColumns = new Set([...display.groupBy, ...display.columns.filter(column => !isTableCellBarColumn(column)).map(column => column.name)]);
				requireAllowedColumn(bindingKey, display.orderBy.column, 'orderBy', orderColumns);
			}
		} else if (isValidRepeatedTableDisplay(display)) {
			const preColumns = validatePreAggregate(bindingKey, display.preAggregate);
			const outputColumns = preColumns ?? factColumns;
			const outputColumnTypes = display.preAggregate ? preAggregateColumnTypes(display.preAggregate) : factColumnTypes;
			for (const columnName of display.repeatBy) requireAllowedColumn(bindingKey, columnName, 'repeatBy', outputColumns);
			const repeatColumns = repeatedTableRepeatColumns(display);
			for (let i = 0; i < repeatColumns.length; i++) {
				const column = repeatColumns[i];
				if (column.agg) {
					if (tableAggregateNeedsColumn(column.agg)) requireAllowedColumn(bindingKey, column.sourceColumn || column.name, `repeatColumns[${i}].column`, outputColumns);
				} else {
					requireAllowedColumn(bindingKey, column.name, `repeatColumns[${i}].column`, outputColumns);
				}
			}
			if (display.repeatOrderBy) {
				const orderColumns = new Set([...display.repeatBy, ...repeatColumns.map(column => column.name)]);
				requireAllowedColumn(bindingKey, display.repeatOrderBy.column, 'repeatOrderBy', orderColumns);
			}
			for (const columnName of display.table.groupBy) requireAllowedColumn(bindingKey, columnName, 'table.groupBy', outputColumns);
			for (let i = 0; i < display.table.columns.length; i++) {
				const column = display.table.columns[i];
				if (isTableCellBarColumn(column)) {
					for (let s = 0; s < column.cellBar.segments.length; s++) {
						const segment = column.cellBar.segments[s];
						if (tableAggregateNeedsColumn(segment.agg)) requireAllowedColumn(bindingKey, segment.column, `table.columns[${i}].cellBar.segments[${s}].column`, outputColumns);
					}
					continue;
				}
				const sourceColumn = column.sourceColumn || column.name;
				if (column.agg) {
					if (tableAggregateNeedsColumn(column.agg)) requireAllowedColumn(bindingKey, sourceColumn, `table.columns[${i}].column`, outputColumns);
				} else {
					requireAllowedColumn(bindingKey, column.name, `table.columns[${i}].column`, outputColumns);
				}
			}
			const innerRowColumnTypes = tableValueColumnTypes(display.table.groupBy, display.table.columns, outputColumnTypes);
			if (display.table.orderBy) {
				const orderColumns = new Set([...display.table.groupBy, ...display.table.columns.filter(column => !isTableCellBarColumn(column)).map(column => column.name)]);
				requireAllowedColumn(bindingKey, display.table.orderBy.column, 'table.orderBy', orderColumns);
			}
			for (let i = 0; i < display.table.columns.length; i++) {
				requireNumericCellFormatColumn(bindingKey, display.table.columns[i], `table.columns[${i}].cellFormat.valueColumn`, innerRowColumnTypes);
			}
		} else if (isValidPivotDisplay(display)) {
			const preColumns = validatePreAggregate(bindingKey, display.preAggregate);
			const outputColumns = preColumns ?? factColumns;
			for (const columnName of display.rows) requireAllowedColumn(bindingKey, columnName, 'rows', outputColumns);
			requireAllowedColumn(bindingKey, display.pivotBy, 'pivotBy', outputColumns);
			if (aggregateRequiresColumn(display.agg)) requireAllowedColumn(bindingKey, display.value, 'value', outputColumns);
		} else if (isValidDashboardChartDisplay(display)) {
			const preColumns = validatePreAggregate(bindingKey, display.preAggregate);
			const outputColumns = preColumns ?? factColumns;
			if (display.type === 'bar') {
				requireAllowedColumn(bindingKey, display.groupBy, 'groupBy', outputColumns);
				if (display.segments) {
					for (let i = 0; i < display.segments.length; i++) {
						const segment = display.segments[i];
						if (aggregateRequiresColumn(segment.agg)) requireAllowedColumn(bindingKey, segment.column, `segments[${i}].column`, outputColumns);
					}
				} else if (display.value && aggregateRequiresColumn(display.value.agg)) {
					requireAllowedColumn(bindingKey, display.value.column, 'value.column', outputColumns);
				}
			} else if (display.type === 'pie') {
				requireAllowedColumn(bindingKey, display.groupBy, 'groupBy', outputColumns);
				if (aggregateRequiresColumn(display.value.agg)) requireAllowedColumn(bindingKey, display.value.column, 'value.column', outputColumns);
			} else {
				requireAllowedColumn(bindingKey, display.xAxis, 'xAxis', outputColumns);
				for (const series of display.series) {
					if (aggregateRequiresColumn(series.agg)) requireAllowedColumn(bindingKey, series.column, 'series.column', outputColumns);
				}
			}
		}
	}
	return missing;
}

export function findUnsupportedPowerBiBindings(htmlCode: string): string[] {
	const provenance = parseProvenance(htmlCode);
	if (!provenance) return [];
	const renderedTargetElements = findDataKwBindTargetElements(htmlCode);
	const renderedTargetTags = new Map(Array.from(renderedTargetElements, ([key, elements]) => [key, elements.map(element => element.tagName)]));
	const renderedHtml = stripNonRenderedHtmlBlocks(htmlCode);
	const unsupported: string[] = [];
	for (const [key] of renderedTargetTags) {
		const binding = provenance.bindings[key];
		if (!binding) {
			unsupported.push(`${key} (missing provenance binding)`);
			continue;
		}
		if (!binding.display) {
			unsupported.push(`${key} (missing display)`);
			continue;
		}
		const display = binding.display as { type?: unknown };
		const type = typeof display.type === 'string' ? display.type : '';
		if (!type) {
			unsupported.push(`${key} (missing display type)`);
			continue;
		}
		const targets = renderedTargetElements.get(key) ?? [];
		if (targets.length > 0 && targets.every(target => isHiddenDataKwBindTarget(target.openTag))) {
			unsupported.push(`${key} (${type}: target is hidden; bind exportable content to a visible data-kw-bind element)`);
			continue;
		}
		const bindAttr = bindingAttributePattern(key);
		if ((type === 'table' || type === 'pivot') && !matchTableElement(renderedHtml, bindAttr)) {
			unsupported.push(`${key} (${type}: target must be table or tbody inside table)`);
		} else if (type === 'repeatedTable' && !hasBoundContainerElement(renderedHtml, bindAttr)) {
			unsupported.push(`${key} (${type}: target must be container element)`);
		} else if (type === 'repeatedTable' && targets.some(target => !isVisibleRepeatedTableTarget(target))) {
			unsupported.push(`${key} (${type}: target must be a visible non-table container element)`);
		} else if ((type === 'scalar' || type === 'bar' || type === 'pie' || type === 'line') && !hasBoundContainerElement(renderedHtml, bindAttr)) {
			unsupported.push(`${key} (${type}: target must be container element)`);
		}
	}
	for (const [key, binding] of Object.entries(provenance.bindings)) {
		if (!renderedTargetTags.has(key)) continue;
		const display = binding.display as { type?: unknown } | undefined;
		const type = typeof display?.type === 'string' ? display.type : '';
		const top = (display as { top?: unknown } | undefined)?.top;
		if (type && !isSupportedPowerBiDisplayType(type)) {
			unsupported.push(`${key} (${type})`);
		} else if (type === 'scalar' && !isValidScalarDisplay(display)) {
			unsupported.push(`${key} (${type}: invalid spec)`);
		} else if (type === 'table' && top !== undefined && (typeof top !== 'number' || !Number.isInteger(top) || top <= 0 || !isObjectRecord((display as { orderBy?: unknown }).orderBy))) {
			unsupported.push(`${key} (${type}: invalid top)`);
		} else if (type === 'table' && !isValidTableDisplay(display)) {
			unsupported.push(`${key} (${type}: invalid spec)`);
		} else if (type === 'repeatedTable' && (display as { repeatTop?: unknown } | undefined)?.repeatTop !== undefined) {
			const repeatTop = (display as { repeatTop?: unknown; repeatOrderBy?: unknown }).repeatTop;
			if (typeof repeatTop !== 'number' || !Number.isInteger(repeatTop) || repeatTop <= 0 || !isObjectRecord((display as { repeatOrderBy?: unknown }).repeatOrderBy)) {
				unsupported.push(`${key} (${type}: invalid repeatTop)`);
			} else if (!isValidRepeatedTableDisplay(display)) {
				unsupported.push(`${key} (${type}: invalid spec)`);
			}
		} else if (type === 'repeatedTable' && !isValidRepeatedTableDisplay(display)) {
			unsupported.push(`${key} (${type}: invalid spec)`);
		} else if (type === 'pivot' && !isValidPivotDisplay(display)) {
			unsupported.push(`${key} (${type}: invalid spec)`);
		} else if ((type === 'bar' || type === 'pie' || type === 'line') && !isValidDashboardChartDisplay(display)) {
			unsupported.push(`${key} (${type}: invalid chart spec)`);
		}
	}
	return unsupported;
}

export function getPowerBiHtmlValidationIssues(htmlCode: string, dataSources?: PowerBiDataSource[]): string[] {
	return [
		...findMissingPowerBiBindingTargets(htmlCode),
		...findUnsupportedPowerBiBindings(htmlCode),
		...(dataSources ? findMissingPowerBiBindingColumns(htmlCode, dataSources) : []),
	];
}

export function validatePowerBiHtmlBindings(htmlCode: string, dataSources?: PowerBiDataSource[]): void {
	const unsupportedBindings = getPowerBiHtmlValidationIssues(htmlCode, dataSources);
	if (unsupportedBindings.length > 0) {
		throw new Error(`Power BI export supports scalar, table, repeatedTable, pivot, bar, pie, and line bindings. Unsupported bindings: ${unsupportedBindings.join(', ')}.`);
	}
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
interface TableRenderOptions { compactMetricColumns?: boolean }

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
	return buildTableValueAggExpr(col.agg, col.sourceColumn || col.name, factTable);
}

function buildTableValueAggExpr(aggName: string | undefined, sourceColumn: string | undefined, factTable: string): string {
	const agg = (aggName || 'SUM').toUpperCase();
	const srcCol = sourceColumn || '';
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
	return buildPreAggTableValueAggExpr(col.agg, col.sourceColumn || col.name, preVarName, groupByCols);
}

function buildPreAggTableValueAggExpr(aggName: string | undefined, sourceColumn: string | undefined, preVarName: string, groupByCols: string[]): string {
	const agg = (aggName || 'COUNT').toUpperCase();
	const srcCol = sourceColumn || '';
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

function tableCellBarSegmentAliases(varIdx: number, columnIndex: number, cellBar: TableCellBarSpec): string[] {
	return cellBar.segments.map((_, segmentIndex) => tableCellBarAlias(varIdx, columnIndex, segmentIndex));
}

function tableCellBarValueExpr(alias: string): string {
	return `MAX(0, COALESCE(${escCol(alias)}, 0))`;
}

function tableCellBarTotalExpr(aliases: string[]): string {
	return aliases.length > 0 ? aliases.map(tableCellBarValueExpr).join(' + ') : '0';
}

function tableCellBarDimensionExpr(numeratorExpr: string, denominatorExpr: string, width: number): string {
	return `FORMAT(ROUND(DIVIDE(${numeratorExpr}, ${denominatorExpr}, 0) * ${width}, 0), "0")`;
}

function tableCellBarSvgExpr(cellBar: TableCellBarSpec, aliases: string[], maxVarName?: string): string {
	const geom = tableCellBarGeometry(cellBar);
	const totalExpr = tableCellBarTotalExpr(aliases);
	const denominatorExpr = maxVarName ?? totalExpr;
	const svgStart = `<svg class='kw-cell-bar' width='${geom.width}' height='${geom.height}' viewBox='0 0 ${geom.width} ${geom.height}' xmlns='http://www.w3.org/2000/svg' style='width:${geom.width}px;height:${geom.height}px;display:block' aria-hidden='true'>`;
	const rectExprs = cellBar.segments.map((segment, segmentIndex) => {
		const alias = aliases[segmentIndex];
		const previousAliases = aliases.slice(0, segmentIndex);
		const xNumeratorExpr = previousAliases.length > 0 ? tableCellBarTotalExpr(previousAliases) : '0';
		const widthNumeratorExpr = tableCellBarValueExpr(alias);
		const xExpr = segmentIndex === 0 ? '"0"' : tableCellBarDimensionExpr(xNumeratorExpr, denominatorExpr, geom.width);
		const widthExpr = tableCellBarDimensionExpr(widthNumeratorExpr, denominatorExpr, geom.width);
		const fill = escapeDaxString(tableCellBarColor(cellBar, segment, segmentIndex));
		return `"<rect x='" & ${xExpr} & "' y='0' width='" & ${widthExpr} & "' height='${geom.height}' rx='${geom.radius}' fill='${fill}'/>"`;
	});
	return `"${escapeDaxString(svgStart)}"${rectExprs.length > 0 ? ` & ${rectExprs.join(' & ')}` : ''} & "</svg>"`;
}

function tableCellBarMaxVarName(varIdx: number, columnIndex: number): string {
	return `_kwCellBarMax_${varIdx}_${columnIndex}`;
}

function tableRowIndexAlias(varIdx: number): string {
	return `${TABLE_ROW_INDEX_ALIAS_PREFIX}${varIdx}`;
}

function repeatedTableRowIndexAlias(varIdx: number): string {
	return `${REPEATED_TABLE_ROW_INDEX_ALIAS_PREFIX}${varIdx}`;
}

function escapeHtmlTextLiteral(text: string): string {
	return escapeXmlLiteral(text).replace(/'/g, '&#39;');
}

function daxHtmlEscape(colExpr: string): string {
	return `SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE("" & ${colExpr}, "&", "&amp;"), "<", "&lt;"), ">", "&gt;"), """", "&quot;"), "'", "&#39;")`;
}

const TABLE_CELL_BADGE_BASE_STYLE = 'display:inline-block;min-width:34px;padding:1px 10px;border-radius:999px;line-height:1.4;text-align:center;font-weight:600;';
const TABLE_COMPACT_METRIC_CELL_STYLE = 'width:1%;white-space:nowrap;text-align:right;';

function tableStaticCellStyle(column: TableColumnSpec, options: TableRenderOptions): string | undefined {
	if (!options.compactMetricColumns) return undefined;
	return column.agg || isTableCellBarColumn(column) ? TABLE_COMPACT_METRIC_CELL_STYLE : undefined;
}

function tableCellStyleCss(style: TableCellStyleSpec | undefined, mode: 'badge' | 'cell'): string {
	const parts = mode === 'badge' ? [TABLE_CELL_BADGE_BASE_STYLE] : [];
	if (style?.backgroundColor) parts.push(`background-color:${style.backgroundColor.trim()};`);
	if (style?.color) parts.push(`color:${style.color.trim()};`);
	if (style?.fontWeight) parts.push(`font-weight:${style.fontWeight};`);
	return parts.join('');
}

function tableCellFormatPredicate(rule: TableCellFormatRule, valueRef: string): string {
	const value = daxNumber(rule.value);
	switch (rule.operator) {
		case '>': return `${valueRef} > ${value}`;
		case '>=': return `${valueRef} >= ${value}`;
		case '<': return `${valueRef} < ${value}`;
		case '<=': return `${valueRef} <= ${value}`;
		case '!=':
		case '<>': return `${valueRef} <> ${value}`;
		case '=':
		case '==': return `${valueRef} = ${value}`;
	}
	return `${valueRef} = ${value}`;
}

function tableCellFormatStyleDax(format: TableCellFormatSpec, valueRef: string): string {
	const mode = format.mode ?? 'badge';
	const ruleCases = format.rules
		.map(rule => `${tableCellFormatPredicate(rule, valueRef)}, "${escapeDaxString(tableCellStyleCss(rule, mode))}"`)
		.join(', ');
	const defaultStyle = `"${escapeDaxString(tableCellStyleCss(format.defaultStyle, mode))}"`;
	return `SWITCH(TRUE(), ${ruleCases}, ${defaultStyle})`;
}

function tableDaxAttrs(cls: string, staticStyle?: string): string {
	const classAttr = cls ? ` class=""${escapeDaxString(cls)}""` : '';
	const styleAttr = staticStyle ? ` style=""${escapeDaxString(staticStyle)}""` : '';
	return `${classAttr}${styleAttr}`;
}

function tableTdOpenDax(cls: string, styleExpr?: string, staticStyle?: string): string {
	const attrs = tableDaxAttrs(cls);
	if (styleExpr && staticStyle) return `"<td${attrs} style='${escapeDaxString(staticStyle)}" & ${styleExpr} & "'>"`;
	if (styleExpr) return `"<td${attrs} style='" & ${styleExpr} & "'>"`;
	return `"<td${tableDaxAttrs(cls, staticStyle)}>"`;
}

function uniqueColumnNames(columns: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const column of columns) {
		const key = columnKey(column);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(column);
	}
	return result;
}

function buildTableComputedColumnParts(columns: TableColumnSpec[], groupBy: string[], factTable: string, varIdx: number, preVarName?: string): string[] {
	const parts: string[] = [];
	for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
		const column = columns[columnIndex];
		if (column.agg) {
			const expr = preVarName
				? buildPreAggTableValueAggExpr(column.agg, column.sourceColumn || column.name, preVarName, groupBy)
				: buildTableValueAggExpr(column.agg, column.sourceColumn || column.name, factTable);
			parts.push(`"${escapeDaxString(column.name)}", ${expr}`);
		}
		if (isTableCellBarColumn(column)) {
			const aliases = tableCellBarSegmentAliases(varIdx, columnIndex, column.cellBar);
			for (let segmentIndex = 0; segmentIndex < column.cellBar.segments.length; segmentIndex++) {
				const segment = column.cellBar.segments[segmentIndex];
				const expr = preVarName
					? buildPreAggTableValueAggExpr(segment.agg, segment.column, preVarName, groupBy)
					: buildTableValueAggExpr(segment.agg, segment.column, factTable);
				parts.push(`"${escapeDaxString(aliases[segmentIndex])}", ${expr}`);
			}
		}
	}
	return parts;
}

function buildTableSummaryExpr(factTable: string, columns: TableColumnSpec[], groupBy: string[], varIdx: number, preVarName?: string): string {
	const tbl = escTable(factTable);
	const sourceTable = preVarName ?? tbl;
	const groupByRefs = preVarName ? groupBy.map(g => escCol(g)) : groupBy.map(g => `${tbl}${escCol(g)}`);
	const addColumnParts = buildTableComputedColumnParts(columns, groupBy, factTable, varIdx, preVarName).join(', ');
	return addColumnParts
		? `ADDCOLUMNS(SUMMARIZE(${sourceTable}, ${groupByRefs.join(', ')}), ${addColumnParts})`
		: `SUMMARIZE(${sourceTable}, ${groupByRefs.join(', ')})`;
}

function tableTheadDax(columns: TableColumnSpec[], originalThClasses: string[] = [], options: TableRenderOptions = {}): string {
	const thCells = columns.map((col, i) => {
		const headerText = escapeDaxString(escapeHtmlTextLiteral(col.header || col.name));
		const cls = originalThClasses[i] || '';
		const style = tableStaticCellStyle(col, options);
		return `<th${tableDaxAttrs(cls, style)}>${headerText}</th>`;
	}).join('');
	return `"<thead><tr>${thCells}</tr></thead>"`;
}

function tableRowCellDax(columns: TableColumnSpec[], varIdx: number, originalThClasses: string[] = [], options: TableRenderOptions = {}): string {
	return columns.map((col, i) => {
		const cls = originalThClasses[i] || '';
		const staticStyle = tableStaticCellStyle(col, options);
		if (isTableCellBarColumn(col)) {
			const aliases = tableCellBarSegmentAliases(varIdx, i, col.cellBar);
			const maxVarName = (col.cellBar.scale ?? 'normalized100') === 'relative' ? tableCellBarMaxVarName(varIdx, i) : undefined;
			return `${tableTdOpenDax(cls, undefined, staticStyle)} & ${tableCellBarSvgExpr(col.cellBar, aliases, maxVarName)} & "</td>"`;
		}
		const formattedValueExpr = col.format ? buildFormatExpr(escCol(col.name), col.format) : escCol(col.name);
		if (isTableCellFormattedColumn(col)) {
			const mode = col.cellFormat.mode ?? 'badge';
			const styleExpr = tableCellFormatStyleDax(col.cellFormat, escCol(col.cellFormat.valueColumn ?? col.name));
			if (mode === 'cell') {
				return `${tableTdOpenDax(cls, styleExpr, staticStyle)} & ${daxHtmlEscape(formattedValueExpr)} & "</td>"`;
			}
			return `${tableTdOpenDax(cls, undefined, staticStyle)} & "<span class='kw-cell-badge' style='" & ${styleExpr} & "'>" & ${daxHtmlEscape(formattedValueExpr)} & "</span></td>"`;
		}
		return `${tableTdOpenDax(cls, undefined, staticStyle)} & ${daxHtmlEscape(formattedValueExpr)} & "</td>"`;
	}).join(' & ');
}

function generateTableDaxVars(factTable: string, display: TableDisplay, varIdx: number, originalThClasses: string[] = []): DaxVarResult {
	const theadVar = `_thead_${varIdx}`;
	const rowsVar = `_rows_${varIdx}`;
	const preVars: string[] = [];
	const theadDax = tableTheadDax(display.columns, originalThClasses);

	let summarizedTable: string;
	if (display.preAggregate) {
		const preVarName = `_pre_${varIdx}`;
		preVars.push(generatePreAggregateVarDax(factTable, display.preAggregate, varIdx));
		summarizedTable = buildTableSummaryExpr(factTable, display.columns, display.groupBy, varIdx, preVarName);
	} else {
		summarizedTable = buildTableSummaryExpr(factTable, display.columns, display.groupBy, varIdx);
	}

	const tdExprs = tableRowCellDax(display.columns, varIdx, originalThClasses);

	let renderTable = summarizedTable;
	let sortExpr = '';
	if (display.orderBy) {
		const dir = (display.orderBy.direction || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
		const rowIndexAlias = tableRowIndexAlias(varIdx);
		const rowIndexRef = escCol(rowIndexAlias);
		const indexedRows = indexedTableRowsExpr(summarizedTable, rowIndexAlias, escCol(display.orderBy.column), display.groupBy.map(g => escCol(g)), dir);
		if (display.top !== undefined && Number.isInteger(display.top) && display.top > 0) {
			renderTable = `FILTER(${indexedRows}, ${rowIndexRef} <= ${display.top})`;
		} else {
			renderTable = indexedRows;
		}
		sortExpr = `, ${rowIndexRef}, ASC`;
	}

	const relativeMaxVars = display.columns.flatMap((column, columnIndex) => {
		if (!isTableCellBarColumn(column) || (column.cellBar.scale ?? 'normalized100') !== 'relative') return [];
		const aliases = tableCellBarSegmentAliases(varIdx, columnIndex, column.cellBar);
		return [`VAR ${tableCellBarMaxVarName(varIdx, columnIndex)} = MAXX(${renderTable}, ${tableCellBarTotalExpr(aliases)})`];
	});
	const rowConcatDax = `CONCATENATEX(${renderTable}, "<tr>" & ${tdExprs} & "</tr>", ""${sortExpr})`;
	const rowsDax = relativeMaxVars.length > 0 ? `${relativeMaxVars.join(' ')} RETURN ${rowConcatDax}` : rowConcatDax;

	return { theadVar, theadDax, rowsVar, rowsDax, ...(preVars.length > 0 ? { preVars } : {}) };
}

const REPEATED_TABLE_GROUP_STYLE = 'margin:0 0 16px 0;border:1px solid rgba(127,127,127,0.35);border-radius:6px;overflow:hidden;';
const REPEATED_TABLE_HEADER_STYLE = 'display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px 32px;padding:10px 12px;background:rgba(127,127,127,0.10);border-bottom:1px solid rgba(127,127,127,0.35);font:inherit;';
const REPEATED_TABLE_PRIMARY_FIELD_STYLE = 'display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0;line-height:1.25;flex:1 1 220px;';
const REPEATED_TABLE_METRIC_FIELD_STYLE = 'display:flex;flex-direction:column;align-items:flex-end;gap:4px;min-width:96px;line-height:1.25;white-space:nowrap;flex:0 0 auto;';
const REPEATED_TABLE_LABEL_STYLE = 'font-size:inherit;font-weight:700;line-height:1.25;';
const REPEATED_TABLE_VALUE_STYLE = 'font-size:inherit;font-weight:400;line-height:1.35;';
const REPEATED_TABLE_TABLE_STYLE = 'width:100%;border-collapse:collapse;';

function repeatedTableHeaderDax(display: RepeatedTableDisplay): string {
	const fields = repeatedTableRepeatColumns(display).map((column, index) => {
		const isPrimary = index === 0;
		const label = escapeDaxString(escapeHtmlTextLiteral(column.header || column.name));
		const valueExpr = column.format ? buildFormatExpr(escCol(column.name), column.format) : escCol(column.name);
		const fieldClass = isPrimary ? 'kw-repeat-field kw-repeat-primary' : 'kw-repeat-field kw-repeat-metric';
		const fieldStyle = isPrimary ? REPEATED_TABLE_PRIMARY_FIELD_STYLE : REPEATED_TABLE_METRIC_FIELD_STYLE;
		return `"<span class='${fieldClass}' style='${fieldStyle}'><span class='kw-repeat-label' style='${REPEATED_TABLE_LABEL_STYLE}'>${label}</span><span class='kw-repeat-value' style='${REPEATED_TABLE_VALUE_STYLE}'>" & ${daxHtmlEscape(valueExpr)} & "</span></span>"`;
	});
	return `"<div class='kw-repeated-table-header' style='${REPEATED_TABLE_HEADER_STYLE}'>" & ${fields.join(' & ')} & "</div>"`;
}

function generateRepeatedTableDax(factTable: string, display: RepeatedTableDisplay, varIdx: number, vars: string[]): string {
	const repeatVar = `_repeat_${varIdx}`;
	const outerVar = `_repeatData_${varIdx}`;
	const innerDataVar = `_repeatInnerData_${varIdx}`;
	const preVarName = display.preAggregate ? `_pre_${varIdx}` : undefined;
	if (display.preAggregate) {
		vars.push(generatePreAggregateVarDax(factTable, display.preAggregate, varIdx));
	}

	const repeatColumns = repeatedTableRepeatColumns(display);
	const outerSummary = buildTableSummaryExpr(factTable, repeatColumns, display.repeatBy, varIdx, preVarName);
	const outerIndexAlias = repeatedTableRowIndexAlias(varIdx);
	const outerOrderColumn = display.repeatOrderBy?.column ?? display.repeatBy[0];
	const outerDirection = display.repeatOrderBy
		? ((display.repeatOrderBy.direction || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC')
		: 'ASC';
	const outerIndexedRows = indexedTableRowsExpr(outerSummary, outerIndexAlias, escCol(outerOrderColumn), display.repeatBy.map(g => escCol(g)), outerDirection);
	const outerRows = display.repeatTop !== undefined && Number.isInteger(display.repeatTop) && display.repeatTop > 0
		? `FILTER(${outerIndexedRows}, ${escCol(outerIndexAlias)} <= ${display.repeatTop})`
		: outerIndexedRows;
	vars.push(`VAR ${outerVar} = ${outerRows}`);

	const innerSummaryGroupBy = uniqueColumnNames([...display.repeatBy, ...display.table.groupBy]);
	const innerSummary = buildTableSummaryExpr(factTable, display.table.columns, innerSummaryGroupBy, varIdx, preVarName);
	vars.push(`VAR ${innerDataVar} = ${innerSummary}`);

	const scopedVar = `_kwRepeatScoped_${varIdx}`;
	const rowsVar = `_kwRepeatRows_${varIdx}`;
	const htmlVar = `_kwRepeatHtml_${varIdx}`;
	const outerKeyVars = display.repeatBy.map((column, index) => `VAR _kwRepeatKey_${varIdx}_${index} = ${escCol(column)}`).join(' ');
	const scopedFilter = display.repeatBy.map((column, index) => `${escCol(column)} = _kwRepeatKey_${varIdx}_${index}`).join(' && ');

	let innerRowsExpr = scopedVar;
	let innerSortExpr = display.table.groupBy.length > 0 ? `, ${escCol(display.table.groupBy[0])}, ASC` : '';
	if (display.table.orderBy) {
		const innerDirection = (display.table.orderBy.direction || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
		const innerIndexAlias = tableRowIndexAlias(varIdx);
		const indexedRows = indexedTableRowsExpr(scopedVar, innerIndexAlias, escCol(display.table.orderBy.column), display.table.groupBy.map(g => escCol(g)), innerDirection);
		innerRowsExpr = display.table.top !== undefined && Number.isInteger(display.table.top) && display.table.top > 0
			? `FILTER(${indexedRows}, ${escCol(innerIndexAlias)} <= ${display.table.top})`
			: indexedRows;
		innerSortExpr = `, ${escCol(innerIndexAlias)}, ASC`;
	}

	const relativeMaxVars = display.table.columns.flatMap((column, columnIndex) => {
		if (!isTableCellBarColumn(column) || (column.cellBar.scale ?? 'normalized100') !== 'relative') return [];
		const aliases = tableCellBarSegmentAliases(varIdx, columnIndex, column.cellBar);
		return [`VAR ${tableCellBarMaxVarName(varIdx, columnIndex)} = MAXX(${rowsVar}, ${tableCellBarTotalExpr(aliases)})`];
	});
	const repeatedTableOptions: TableRenderOptions = { compactMetricColumns: true };
	const rowCells = tableRowCellDax(display.table.columns, varIdx, [], repeatedTableOptions);
	const rowsHtmlDax = `CONCATENATEX(${rowsVar}, "<tr>" & ${rowCells} & "</tr>", ""${innerSortExpr})`;
	const tableDax = `"<table class='kw-repeated-table' style='${REPEATED_TABLE_TABLE_STYLE}'>" & ${tableTheadDax(display.table.columns, [], repeatedTableOptions)} & "<tbody>" & ${htmlVar} & "</tbody></table>"`;
	const groupDax = `${outerKeyVars} VAR ${scopedVar} = FILTER(${innerDataVar}, ${scopedFilter}) VAR ${rowsVar} = ${innerRowsExpr} ${relativeMaxVars.join(' ')} VAR ${htmlVar} = ${rowsHtmlDax} RETURN "<section class='kw-repeated-table-group' style='${REPEATED_TABLE_GROUP_STYLE}'>" & ${repeatedTableHeaderDax(display)} & ${tableDax} & "</section>"`;
	vars.push(`VAR ${repeatVar} = CONCATENATEX(${outerVar}, ${groupDax}, "", ${escCol(outerIndexAlias)}, ASC)`);
	return repeatVar;
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

function indexedChartRowsExpr(sourceVar: string, groupByRef: string): string {
	return `ADDCOLUMNS(${sourceVar}, "Idx", VAR _v = [Val] VAR _label = ${groupByRef} RETURN COUNTROWS(FILTER(${sourceVar}, [Val] > _v || ([Val] = _v && ${groupByRef} <= _label))))`;
}

function lexicographicLessOrEqualExpr(refs: string[], variablePrefix: string): string {
	return refs.map((ref, idx) => {
		const previousEquals = refs.slice(0, idx).map((prevRef, prevIdx) => `${prevRef} = ${variablePrefix}${prevIdx}`).join(' && ');
		const comparison = idx === refs.length - 1 ? `${ref} <= ${variablePrefix}${idx}` : `${ref} < ${variablePrefix}${idx}`;
		return previousEquals ? `(${previousEquals} && ${comparison})` : comparison;
	}).join(' || ');
}

function indexedTableRowsExpr(sourceTable: string, indexColumn: string, sortRef: string, tieRefs: string[], direction: 'ASC' | 'DESC'): string {
	const keyVars = tieRefs.map((ref, idx) => `VAR _key${idx} = ${ref}`).join(' ');
	const primaryComparison = direction === 'ASC' ? `${sortRef} < _sort` : `${sortRef} > _sort`;
	const tieComparison = tieRefs.length > 0 ? lexicographicLessOrEqualExpr(tieRefs, '_key') : 'TRUE()';
	return `ADDCOLUMNS(${sourceTable}, "${escapeDaxString(indexColumn)}", VAR _sort = ${sortRef} ${keyVars} RETURN COUNTROWS(FILTER(${sourceTable}, ${primaryComparison} || (${sortRef} = _sort && (${tieComparison})))))`;
}

/**
 * Generate DAX for a horizontal bar chart SVG.
 * Pushes intermediate VARs into `vars[]`, returns the final marker name.
 */
function generateSimpleBarChartDax(factTable: string, display: BarDisplay & { value: ChartValue }, varIdx: number, vars: string[], dataSource?: PowerBiDataSource): string {
	const tbl = escTable(factTable);
	const dp = `_bardata_${varIdx}`;
	const rp = `_barrows_${varIdx}`;
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
	vars.push(`VAR ${dp} = ${dataTable}`);
	const indexedRows = indexedChartRowsExpr(dp, groupByRef);
	vars.push(`VAR ${rp} = ${display.top && display.top > 0 ? `FILTER(${indexedRows}, [Idx] <= ${display.top})` : indexedRows}`);
	vars.push(`VAR ${mp} = MAXX(${rp}, MAX(0, [Val]))`);

	const { labelW, barMaxW, valGap, rowH, gap, padT, padB, totalW, minH } = DASHBOARD_BAR_CHART;

	// CONCATENATEX emitting SVG elements per row
	const colorCases = Array.from({ length: 10 }, (_, i) =>
		`${i + 1}, "${chartColor(display.colors, i)}"`,
	).join(', ');

	const valueTextExpr = buildFormatExpr('[Val]', display.value.format || '#,##0');
	const labelTextExpr = daxXmlEscape(lineAxisLabelExpr(groupByRef, display.groupBy, dataSource));
	const svgExpr = `CONCATENATEX(`
		+ `${rp}, `
		+ `VAR _y = ${padT} + ([Idx] - 1) * ${rowH + gap} `
		+ `VAR _barval = MAX(0, [Val]) `
		+ `VAR _w = IF(${mp} = 0, 0, _barval / ${mp} * ${barMaxW}) `
		+ `VAR _col = SWITCH([Idx], ${colorCases}, "${chartColor(display.colors, 0)}") `
		+ `RETURN `
		+ `"<text x='${labelW - 6}' y='" & FORMAT(_y + 16, "0") & "' text-anchor='end' font-size='11' fill='#605E5C'>" & ${labelTextExpr} & "</text>" `
		+ `& "<rect x='${labelW}' y='" & FORMAT(_y + 2, "0") & "' width='" & FORMAT(_w, "0") & "' height='${rowH - 4}' rx='2' fill='" & _col & "'/>" `
		+ `& "<text x='" & FORMAT(${labelW} + _w + ${valGap}, "0") & "' y='" & FORMAT(_y + 16, "0") & "' font-size='11' fill='#605E5C'>" & ${valueTextExpr} & "</text>", `
		+ `"", [Idx], ASC)`;

	const countExpr = `COUNTROWS(${rp})`;
	const heightValueExpr = `MAX(${minH}, ${padT + padB} + ${countExpr} * ${rowH + gap})`;
	const heightExpr = `FORMAT(${heightValueExpr}, "0")`;
	const svgDax = `"<svg class='chart-svg' viewBox='0 0 ${totalW} " & ${heightExpr} & "' xmlns='http://www.w3.org/2000/svg' style='width:100%;height:" & ${heightExpr} & "px;display:block' role='img'>" & ${svgExpr} & "</svg>"`;
	vars.push(`VAR ${sp} = ${svgDax}`);
	return sp;
}

function hasAdvancedBarOptions(display: BarDisplay): boolean {
	return !!display.segments
		|| !!display.thresholdBands
		|| !!display.colorRules
		|| display.scale !== undefined
		|| display.variant !== undefined
		|| display.showValueLabels !== undefined
		|| display.showCategoryLabels !== undefined;
}

function barValueFormat(display: BarDisplay): string {
	return display.value?.format || display.segments?.[0]?.format || '#,##0';
}

function daxNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : String(value);
}

function daxColorLiteral(color: string): string {
	return `"${escapeDaxString(color)}"`;
}

function chartValueAggExpr(value: ChartValue, factTable: string, preVarName: string | undefined, groupByCol: string): string {
	return preVarName ? buildPreAggChartValExpr(value, preVarName, groupByCol) : chartAggExpr(value, factTable);
}

function barRulePredicate(rule: BarColorRule): string {
	const value = daxNumber(rule.value);
	if (rule.operator === '>') return `[Val] > ${value}`;
	if (rule.operator === '>=') return `[Val] >= ${value}`;
	if (rule.operator === '<') return `[Val] < ${value}`;
	if (rule.operator === '<=') return `[Val] <= ${value}`;
	if (rule.operator === '!=' || rule.operator === '<>') return `[Val] <> ${value}`;
	return `[Val] = ${value}`;
}

function rowColorSwitchExpr(display: BarDisplay): string {
	const colorCases = Array.from({ length: 10 }, (_, i) =>
		`${i + 1}, ${daxColorLiteral(chartColor(display.colors, i))}`,
	).join(', ');
	return `SWITCH([Idx], ${colorCases}, ${daxColorLiteral(chartColor(display.colors, 0))})`;
}

function colorRulesSwitchExpr(display: BarDisplay): string {
	if (!display.colorRules?.length) return rowColorSwitchExpr(display);
	const ruleCases = display.colorRules
		.map(rule => `${barRulePredicate(rule)}, ${daxColorLiteral(rule.color)}`)
		.join(', ');
	return `SWITCH(TRUE(), ${ruleCases}, ${rowColorSwitchExpr(display)})`;
}

interface ExportBarGeometry {
	totalW: number;
	minH: number;
	padT: number;
	padB: number;
	rowH: number;
	gap: number;
	labelW: number;
	barMaxW: number;
	valGap: number;
	barH: number;
	barOffset: number;
	barRadius: number;
	labelFontSize: number;
	labelFill: string;
	textDy: number;
	showCategoryLabels: boolean;
	showValueLabels: boolean;
}

function exportBarGeometry(display: BarDisplay): ExportBarGeometry {
	const distribution = display.variant === 'distribution';
	const base = distribution ? DASHBOARD_DISTRIBUTION_BAR_CHART : DASHBOARD_BAR_CHART;
	const showCategoryLabels = display.showCategoryLabels !== false;
	const showValueLabels = display.showValueLabels === undefined ? !distribution : display.showValueLabels;
	const labelW = showCategoryLabels ? base.labelW : 0;
	const valueW = showValueLabels ? 96 : 0;
	const barMaxW = distribution
		? Math.max(1, base.totalW - labelW - valueW - (showValueLabels ? base.valGap : 0))
		: base.barMaxW;
	return {
		totalW: base.totalW,
		minH: base.minH,
		padT: base.padT,
		padB: base.padB,
		rowH: base.rowH,
		gap: base.gap,
		labelW,
		barMaxW,
		valGap: base.valGap,
		barH: distribution ? DASHBOARD_DISTRIBUTION_BAR_CHART.barH : base.rowH - 4,
		barOffset: distribution ? Math.floor((DASHBOARD_DISTRIBUTION_BAR_CHART.rowH - DASHBOARD_DISTRIBUTION_BAR_CHART.barH) / 2) : 2,
		barRadius: base.barRadius,
		labelFontSize: base.labelFontSize,
		labelFill: base.labelFill,
		textDy: distribution ? base.labelFontSize + 3 : 16,
		showCategoryLabels,
		showValueLabels,
	};
}

function thresholdDomain(display: BarDisplay): number {
	const bands = display.thresholdBands?.bands ?? [];
	return display.thresholdBands?.scaleMax ?? bands[bands.length - 1]?.max ?? 0;
}

function advancedBarDataTableExpr(factTable: string, display: BarDisplay, varIdx: number, vars: string[]): { dataTable: string; groupByRef: string } {
	const tbl = escTable(factTable);
	const preVarName = display.preAggregate ? `_pre_${varIdx}` : undefined;
	if (display.preAggregate) {
		vars.push(generatePreAggregateVarDax(factTable, display.preAggregate, varIdx));
	}
	const groupByRef = preVarName ? escCol(display.groupBy) : `${tbl}${escCol(display.groupBy)}`;
	const sourceTable = preVarName ?? tbl;

	if (display.segments?.length) {
		const segmentColumns = display.segments.map((segment, i) =>
			`"Seg${i}", ${chartValueAggExpr(segment, factTable, preVarName, display.groupBy)}`,
		);
		const totalExpr = display.segments
			.map(segment => `MAX(0, ${chartValueAggExpr(segment, factTable, preVarName, display.groupBy)})`)
			.join(' + ');
		return {
			dataTable: `ADDCOLUMNS(SUMMARIZE(${sourceTable}, ${groupByRef}), ${[...segmentColumns, `"Val", ${totalExpr}`].join(', ')})`,
			groupByRef,
		};
	}

	const value = display.value ?? { agg: 'COUNT' };
	return {
		dataTable: `ADDCOLUMNS(SUMMARIZE(${sourceTable}, ${groupByRef}), "Val", ${chartValueAggExpr(value, factTable, preVarName, display.groupBy)})`,
		groupByRef,
	};
}

function advancedBarSegmentVariables(display: BarDisplay): string {
	if (display.segments?.length) {
		return display.segments.map((_, i) => `VAR _seg${i} = MAX(0, [Seg${i}]) VAR _w${i} = IF(_den = 0, 0, _seg${i} / _den * _barw)`).join(' ');
	}
	if (display.thresholdBands?.bands.length) {
		return display.thresholdBands.bands.map((band, i) =>
			`VAR _seg${i} = MAX(0, MIN(_barval, ${daxNumber(band.max)}) - ${daxNumber(band.min)}) VAR _w${i} = IF(_den = 0, 0, _seg${i} / _den * _barw)`,
		).join(' ');
	}
	return 'VAR _seg0 = _barval VAR _w0 = IF(_den = 0, 0, _seg0 / _den * _barw)';
}

function advancedBarRectExpr(display: BarDisplay, geom: ExportBarGeometry): string {
	const colors: string[] = [];
	if (display.segments?.length) {
		for (let i = 0; i < display.segments.length; i++) colors.push(display.segments[i].color || chartColor(display.colors, i));
	} else if (display.thresholdBands?.bands.length) {
		for (let i = 0; i < display.thresholdBands.bands.length; i++) colors.push(display.thresholdBands.bands[i].color || chartColor(display.colors, i));
	} else {
		colors.push('');
	}
	return colors.map((color, i) => {
		const xExpr = i === 0 ? `${geom.labelW}` : `${geom.labelW} + ${Array.from({ length: i }, (_, idx) => `_w${idx}`).join(' + ')}`;
		const colorExpr = color ? daxColorLiteral(color) : '_col';
		return `"<rect x='" & FORMAT(${xExpr}, "0") & "' y='" & FORMAT(_y + ${geom.barOffset}, "0") & "' width='" & FORMAT(_w${i}, "0") & "' height='${geom.barH}' rx='${geom.barRadius}' fill='" & ${colorExpr} & "'/>"`;
	}).join(' & ');
}

function generateAdvancedBarChartDax(factTable: string, display: BarDisplay, varIdx: number, vars: string[], dataSource?: PowerBiDataSource): string {
	const dp = `_bardata_${varIdx}`;
	const rp = `_barrows_${varIdx}`;
	const mp = `_barmax_${varIdx}`;
	const sp = `_bar_${varIdx}`;
	const { dataTable, groupByRef } = advancedBarDataTableExpr(factTable, display, varIdx, vars);
	vars.push(`VAR ${dp} = ${dataTable}`);
	const indexedRows = indexedChartRowsExpr(dp, groupByRef);
	vars.push(`VAR ${rp} = ${display.top && display.top > 0 ? `FILTER(${indexedRows}, [Idx] <= ${display.top})` : indexedRows}`);
	vars.push(`VAR ${mp} = MAXX(${rp}, MAX(0, [Val]))`);

	const geom = exportBarGeometry(display);
	const labelTextExpr = daxXmlEscape(lineAxisLabelExpr(groupByRef, display.groupBy, dataSource));
	const valueTextExpr = buildFormatExpr('[Val]', barValueFormat(display));
	const denominatorExpr = display.thresholdBands
		? daxNumber(thresholdDomain(display))
		: display.scale === 'normalized100' ? '_barval' : mp;
	const fillValueExpr = display.thresholdBands ? 'MIN(_barval, _den)' : '_barval';
	const colorExpr = display.colorRules ? colorRulesSwitchExpr(display) : rowColorSwitchExpr(display);
	const labelExpr = geom.showCategoryLabels
		? `"<text x='${geom.labelW - 6}' y='" & FORMAT(_y + ${geom.textDy}, "0") & "' text-anchor='end' font-size='${geom.labelFontSize}' fill='${geom.labelFill}'>" & ${labelTextExpr} & "</text>"`
		: '';
	const valueExpr = geom.showValueLabels
		? `"<text x='" & FORMAT(${geom.labelW} + IF(_den = 0, 0, _fillval / _den * _barw) + ${geom.valGap}, "0") & "' y='" & FORMAT(_y + ${geom.textDy}, "0") & "' font-size='${geom.labelFontSize}' fill='${geom.labelFill}'>" & ${valueTextExpr} & "</text>"`
		: '';
	const pieces = [labelExpr, advancedBarRectExpr(display, geom), valueExpr].filter(Boolean).join(' & ');
	const svgExpr = `CONCATENATEX(`
		+ `${rp}, `
		+ `VAR _y = ${geom.padT} + ([Idx] - 1) * ${geom.rowH + geom.gap} `
		+ `VAR _barval = MAX(0, [Val]) `
		+ `VAR _den = ${denominatorExpr} `
		+ `VAR _fillval = ${fillValueExpr} `
		+ `VAR _barw = ${geom.barMaxW} `
		+ `VAR _col = ${colorExpr} `
		+ `${advancedBarSegmentVariables(display)} `
		+ `RETURN ${pieces}, `
		+ `"", [Idx], ASC)`;

	const countExpr = `COUNTROWS(${rp})`;
	const heightValueExpr = `MAX(${geom.minH}, ${geom.padT + geom.padB} + ${countExpr} * ${geom.rowH + geom.gap})`;
	const heightExpr = `FORMAT(${heightValueExpr}, "0")`;
	const svgDax = `"<svg class='chart-svg' viewBox='0 0 ${geom.totalW} " & ${heightExpr} & "' xmlns='http://www.w3.org/2000/svg' style='width:100%;height:" & ${heightExpr} & "px;display:block' role='img'>" & ${svgExpr} & "</svg>"`;
	vars.push(`VAR ${sp} = ${svgDax}`);
	return sp;
}

export function generateBarChartDax(factTable: string, display: BarDisplay, varIdx: number, vars: string[], dataSource?: PowerBiDataSource): string {
	if (!hasAdvancedBarOptions(display) && display.value) {
		return generateSimpleBarChartDax(factTable, display as BarDisplay & { value: ChartValue }, varIdx, vars, dataSource);
	}
	return generateAdvancedBarChartDax(factTable, display, varIdx, vars, dataSource);
}

/**
 * Generate DAX for a donut/pie chart SVG.
 * Uses stroke-dasharray circles (no sin/cos needed).
 */
export function generatePieChartDax(factTable: string, display: PieDisplay, varIdx: number, vars: string[], dataSource?: PowerBiDataSource): string {
	const tbl = escTable(factTable);
	const dp = `_piedata_${varIdx}`;
	const rp = `_pierows_${varIdx}`;
	const slices = `_pieslices_${varIdx}`;
	const tp = `_pietotal_${varIdx}`;
	const sp = `_pie_${varIdx}`;

	let dataTable: string;
	let groupByRef: string;
	if (display.preAggregate) {
		const preVarName = `_pre_${varIdx}`;
		vars.push(generatePreAggregateVarDax(factTable, display.preAggregate, varIdx));
		const groupCol = escCol(display.groupBy);
		const valExpr = buildPreAggChartValExpr(display.value, preVarName, display.groupBy);
		dataTable = `ADDCOLUMNS(SUMMARIZE(${preVarName}, ${groupCol}), "Val", ${valExpr})`;
		groupByRef = groupCol;
	} else {
		const aggExpr = chartAggExpr(display.value, factTable);
		dataTable = `ADDCOLUMNS(SUMMARIZE(${tbl}, ${tbl}${escCol(display.groupBy)}), "Val", ${aggExpr})`;
		groupByRef = `${tbl}${escCol(display.groupBy)}`;
	}
	vars.push(`VAR ${dp} = ${dataTable}`);
	const indexedRows = indexedChartRowsExpr(dp, groupByRef);
	vars.push(`VAR ${rp} = ${display.top && display.top > 0 ? `FILTER(${indexedRows}, [Idx] <= ${display.top})` : indexedRows}`);
	vars.push(`VAR ${tp} = SUMX(${rp}, [Val])`);
	vars.push(`VAR ${slices} = ADDCOLUMNS(${rp}, "PrevSum", VAR _idx = [Idx] RETURN SUMX(FILTER(${rp}, [Idx] < _idx), [Val]))`);

	const { cx, cy, outerR, innerR, svgW, minSvgH, legendX, legendY, legendRowH, legendPadB, legendValueX } = DASHBOARD_PIE_CHART;
	const strokeW = outerR - innerR;
	const effectiveR = (outerR + innerR) / 2;

	const colorCases = Array.from({ length: 10 }, (_, i) =>
		`${i + 1}, "${chartColor(display.colors, i)}"`,
	).join(', ');
	const valueTextExpr = buildFormatExpr('[Val]', display.value.format || '#,##0');
	const totalTextExpr = buildFormatExpr(tp, display.value.format || '#,##0');
	const labelTextExpr = daxXmlEscape(lineAxisLabelExpr(groupByRef, display.groupBy, dataSource));

	const svgExpr = `CONCATENATEX(`
		+ `${slices}, `
		+ `VAR _circ = 2 * PI() * ${effectiveR} `
		+ `VAR _segLen = IF(${tp} = 0, 0, [Val] / ${tp} * _circ) `
		+ `VAR _offset = _circ / 4 - IF(${tp} = 0, 0, [PrevSum] / ${tp} * _circ) `
		+ `VAR _col = SWITCH([Idx], ${colorCases}, "${chartColor(display.colors, 0)}") `
		+ `RETURN `
		+ `"<circle cx='${cx}' cy='${cy}' r='${effectiveR}' fill='none' stroke='" & _col & "' stroke-width='${strokeW}' `
		+ `stroke-dasharray='" & FORMAT(_segLen, "0.00") & " " & FORMAT(_circ - _segLen, "0.00") & "' `
		+ `stroke-dashoffset='" & FORMAT(_offset, "0.00") & "'/>", `
		+ `"", [Idx], ASC)`;

	const legendExpr = `CONCATENATEX(`
		+ `${slices}, `
		+ `VAR _y = ${legendY} + ([Idx] - 1) * ${legendRowH} `
		+ `VAR _col = SWITCH([Idx], ${colorCases}, "${chartColor(display.colors, 0)}") `
		+ `RETURN `
		+ `"<rect x='${legendX}' y='" & FORMAT(_y - 10, "0") & "' width='10' height='10' rx='2' fill='" & _col & "'/>" `
		+ `& "<text x='${legendX + 16}' y='" & FORMAT(_y, "0") & "' font-size='11' fill='#605E5C'>" & ${labelTextExpr} & "</text>" `
		+ `& "<text x='${legendValueX}' y='" & FORMAT(_y, "0") & "' text-anchor='end' font-size='11' fill='#605E5C'>" & ${valueTextExpr} & " (" & FORMAT(DIVIDE([Val], ${tp}, 0), "0.0%") & ")</text>", `
		+ `"", [Idx], ASC)`;
	const totalLabel = `"<text x='${cx}' y='${cy - 4}' text-anchor='middle' font-size='11' fill='#605E5C'>Total</text>" `
		+ `& "<text x='${cx}' y='${cy + 18}' text-anchor='middle' font-size='20' font-weight='600' fill='#252423'>" & ${totalTextExpr} & "</text>"`;
	const countExpr = `COUNTROWS(${slices})`;
	const heightValueExpr = `MAX(${minSvgH}, ${legendY + legendPadB} + ${countExpr} * ${legendRowH})`;
	const heightExpr = `FORMAT(${heightValueExpr}, "0")`;

	const svgDax = `"<svg class='chart-svg' viewBox='0 0 ${svgW} " & ${heightExpr} & "' xmlns='http://www.w3.org/2000/svg' style='width:100%;height:" & ${heightExpr} & "px;display:block' role='img'>" & ${svgExpr} & ${totalLabel} & ${legendExpr} & "</svg>"`;
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
	const { padL, padR, padT, padB, W, H } = DASHBOARD_LINE_CHART;
	const plotW = W - padL - padR;
	const plotH = H - padT - padB;
	const plotBottom = padT + plotH;
	const xLabelY = plotBottom + DASHBOARD_LINE_CHART.xLabelGap;
	const legendY = xLabelY + DASHBOARD_LINE_CHART.legendTopGap;
	const legendColumns = Math.max(1, Math.floor(plotW / DASHBOARD_LINE_CHART.legendColumnWidth));
	const legendRows = Math.max(1, Math.ceil(display.series.length / legendColumns));
	const svgH = Math.max(H, legendY + legendRows * DASHBOARD_LINE_CHART.legendRowH + DASHBOARD_LINE_CHART.legendBottomPad);

	// Compute min/max across all series for Y scaling
	const allSeriesMinMax = display.series.map((_, i) => `[S${i}]`);
	const minExprs = allSeriesMinMax.map(s => `MINX(${dp}, ${s})`);
	const maxExprs = allSeriesMinMax.map(s => `MAXX(${dp}, ${s})`);
	vars.push(`VAR _linemin_${varIdx} = ${foldDaxBinaryFunction('MIN', minExprs)}`);
	vars.push(`VAR _linemax_${varIdx} = ${foldDaxBinaryFunction('MAX', maxExprs)}`);
	vars.push(`VAR _linerange_${varIdx} = _linemax_${varIdx} - _linemin_${varIdx}`);
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
	const xLabels = `"<text x='${padL}' y='${xLabelY}' font-size='11' fill='#605E5C'>" & ${daxXmlEscape(`_linexfirstlabel_${varIdx}`)} & "</text>" `
		+ `& "<text x='${W - padR}' y='${xLabelY}' text-anchor='end' font-size='11' fill='#605E5C'>" & ${daxXmlEscape(`_linexlastlabel_${varIdx}`)} & "</text>"`;
	const legend = display.series.map((series, i) => {
		const color = chartColor(display.colors, i);
		const col = i % legendColumns;
		const row = Math.floor(i / legendColumns);
		const x = padL + col * DASHBOARD_LINE_CHART.legendColumnWidth;
		const y = legendY + row * DASHBOARD_LINE_CHART.legendRowH;
		const label = escapeDaxString(escapeXmlLiteral(series.label || series.column || `Series ${i + 1}`));
		return `"<line x1='${x}' y1='${y - 4}' x2='${x + DASHBOARD_LINE_CHART.legendLineWidth}' y2='${y - 4}' stroke='${color}' stroke-width='${DASHBOARD_LINE_CHART.lineStrokeWidth}' stroke-linecap='round'/>" `
			+ `& "<text x='${x + DASHBOARD_LINE_CHART.legendGap}' y='${y}' font-size='${DASHBOARD_LINE_CHART.labelFontSize}' fill='${DASHBOARD_LINE_CHART.labelFill}'>${label}</text>"`;
	}).join(' & ');

	// Generate one polyline per series
	const polylines: string[] = [];
	for (let i = 0; i < display.series.length; i++) {
		const pointsVar = `_linepts_${varIdx}_${i}`;
		const markerVar = `_linemarker_${varIdx}_${i}`;
		const color = chartColor(display.colors, i);

		const pointsExpr = `CONCATENATEX(`
			+ `${indexedTable}, `
			+ `VAR _x = IF(_linen_${varIdx} <= 1, ${padL + plotW / 2}, ${padL} + (${plotW}) * ([Idx] - 1) / (_linen_${varIdx} - 1)) `
			+ `VAR _y = ${padT} + ${plotH} - IF(_linerange_${varIdx} = 0, ${plotH / 2}, ([S${i}] - _linemin_${varIdx}) / _linerange_${varIdx} * ${plotH}) `
			+ `RETURN FORMAT(_x, "0.0") & "," & FORMAT(_y, "0.0"), `
			+ `" ", ${xAxisRef}, ASC)`;

		vars.push(`VAR ${pointsVar} = ${pointsExpr}`);
		const markerExpr = `IF(_linen_${varIdx} = 1, CONCATENATEX(${indexedTable}, `
			+ `VAR _x = ${padL + plotW / 2} `
			+ `VAR _y = ${padT} + ${plotH} - IF(_linerange_${varIdx} = 0, ${plotH / 2}, ([S${i}] - _linemin_${varIdx}) / _linerange_${varIdx} * ${plotH}) `
			+ `RETURN "<circle cx='" & FORMAT(_x, "0.0") & "' cy='" & FORMAT(_y, "0.0") & "' r='3.5' fill='${color}'/>", ""), "")`;
		vars.push(`VAR ${markerVar} = ${markerExpr}`);
		polylines.push(`"<polyline points='" & ${pointsVar} & "' fill='none' stroke='${color}' stroke-width='${DASHBOARD_LINE_CHART.lineStrokeWidth}' stroke-linecap='round' stroke-linejoin='round'/>"`);
		polylines.push(markerVar);
	}

	const svgContent = [gridLines, axisLines, ...polylines, legend, xLabels].filter(Boolean).join(' & ');
	const svgDax = `"<svg class='chart-svg' viewBox='0 0 ${W} ${svgH}' xmlns='http://www.w3.org/2000/svg' style='width:100%;height:${svgH}px;display:block' role='img'>" & ${svgContent} & "</svg>"`;
	vars.push(`VAR ${sp} = ${svgDax}`);
	return sp;
}
/**
 * Match a `<table>` element that has a `data-kw-bind` attribute either on the
 * `<table>` tag itself or on a `<tbody>` child.
 *
 * Pattern 1: `<table data-kw-bind="x">...</table>`
 * Pattern 2: `<table ...><thead>...</thead><tbody data-kw-bind="x">...</tbody></table>`
 */
interface TableElementMatch {
	fullMatch: string;
	target: 'table' | 'tbody';
	tableOpen: string;
	innerContent: string;
	tableClose: string;
	beforeTbody?: string;
	tbodyOpen?: string;
	tbodyInner?: string;
	tbodyClose?: string;
	afterTbody?: string;
}

function matchTableElement(html: string, bindAttr: string): TableElementMatch | null {
	// Try <table data-kw-bind="x">
	const onTableRe = new RegExp(
		`(<table\\b[^>]*?\\b${bindAttr}[^>]*>)([\\s\\S]*?)(</table>)`, 'i',
	);
	const onTable = html.match(onTableRe);
	if (onTable) {
		return {
			fullMatch: onTable[0],
			target: 'table',
			tableOpen: onTable[1],
			innerContent: onTable[2],
			tableClose: onTable[3],
		};
	}

	// Try <tbody data-kw-bind="x"> inside a <table>
	// Use negative lookahead (?!<table\b) to prevent crossing <table> boundaries
	// when multiple tables exist in the HTML.
	const onTbodyRe = new RegExp(
		`(<table\\b[^>]*>)((?:(?!<table\\b)[\\s\\S])*?)(<tbody\\b[^>]*?\\b${bindAttr}[^>]*>)([\\s\\S]*?)(</tbody>)((?:(?!<table\\b)[\\s\\S])*?)(</table>)`, 'i',
	);
	const onTbody = html.match(onTbodyRe);
	if (!onTbody) return null;
	return {
		fullMatch: onTbody[0],
		target: 'tbody',
		tableOpen: onTbody[1],
		beforeTbody: onTbody[2],
		tbodyOpen: onTbody[3],
		tbodyInner: onTbody[4],
		tbodyClose: onTbody[5],
		afterTbody: onTbody[6],
		tableClose: onTbody[7],
		innerContent: `${onTbody[2]}${onTbody[3]}${onTbody[4]}${onTbody[5]}${onTbody[6]}`,
	};
}

function replaceTableElement(match: TableElementMatch, theadVar: string | undefined, rowsVar: string | undefined): string {
	if (match.target === 'tbody') {
		return `${match.tableOpen}${match.beforeTbody ?? ''}${match.tbodyOpen ?? ''}{{${rowsVar}}}${match.tbodyClose ?? ''}${match.afterTbody ?? ''}${match.tableClose}`;
	}
	return `${match.tableOpen}{{${theadVar}}}<tbody>{{${rowsVar}}}</tbody>${match.tableClose}`;
}

function protectNonRenderedHtmlBlocks(html: string): { html: string; blocks: string[] } {
	const blocks: string[] = [];
	const protectedHtml = html.replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<template\b[\s\S]*?<\/template>|<noscript\b[\s\S]*?<\/noscript>/gi, block => {
		const token = `__KW_PROTECTED_HTML_BLOCK_${blocks.length}__`;
		blocks.push(block);
		return token;
	});
	return { html: protectedHtml, blocks };
}

function restoreNonRenderedHtmlBlocks(html: string, blocks: string[]): string {
	return html.replace(/__KW_PROTECTED_HTML_BLOCK_(\d+)__/g, (_match, indexText: string) => blocks[Number(indexText)] ?? '');
}

/**
 * Generate a DAX measure expression that builds HTML from a shared fact table.
 * All bindings aggregate from the single fact table declared in `model.fact`.
 * Native slicer visuals bind directly to fact columns, so their filter context
 * reaches the generated HTML measure without generated dimension relationships.
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
	const protectedBlocks = protectNonRenderedHtmlBlocks(html);
	html = protectedBlocks.html;

	const vars: string[] = [];
	let varIdx = 0;

	// Process each binding — all reference the same fact table
	for (const [key, binding] of Object.entries(provenance.bindings)) {
		const bindAttr = bindingAttributePattern(key);

		if (!binding.display) continue;
		const display = binding.display;

		if (display.type === 'scalar') {
			if (!isValidScalarDisplay(display)) continue;
			const scalarRe = new RegExp(
				`(<([a-zA-Z][a-zA-Z0-9:-]*)\\b[^>]*?\\b${bindAttr}[^>]*>)([\\s\\S]*?)(</\\2>)`, 'i',
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
			if (!isValidTableDisplay(display)) continue;
			const tableMatch = matchTableElement(html, bindAttr);
			if (!tableMatch) continue;

			const originalClasses = extractOriginalThClasses(tableMatch.innerContent);
			const result = generateTableDaxVars(factTable, display as TableDisplay, varIdx, originalClasses);
			if (result.preVars) result.preVars.forEach(v => vars.push(v));
			if (result.theadVar && result.theadDax) vars.push(`VAR ${result.theadVar} = ${result.theadDax}`);
			if (result.rowsVar && result.rowsDax) vars.push(`VAR ${result.rowsVar} = ${result.rowsDax}`);

			const replaced = replaceTableElement(tableMatch, result.theadVar, result.rowsVar);
			html = html.replace(tableMatch.fullMatch, () => replaced);
			varIdx++;
			continue;
		}

		if (display.type === 'pivot') {
			if (!isValidPivotDisplay(display)) continue;
			const tableMatch = matchTableElement(html, bindAttr);
			if (!tableMatch) continue;

			const result = generatePivotDaxVars(factTable, display as PivotDisplay, varIdx);
			if (result.preVars) result.preVars.forEach(v => vars.push(v));
			if (result.theadVar && result.theadDax) vars.push(`VAR ${result.theadVar} = ${result.theadDax}`);
			if (result.rowsVar && result.rowsDax) vars.push(`VAR ${result.rowsVar} = ${result.rowsDax}`);

			const replaced = replaceTableElement(tableMatch, result.theadVar, result.rowsVar);
			html = html.replace(tableMatch.fullMatch, () => replaced);
			varIdx++;
			continue;
		}

		if (display.type === 'repeatedTable') {
			if (!isValidRepeatedTableDisplay(display)) continue;
			const repeatedTableRe = new RegExp(
				'(<([a-zA-Z][a-zA-Z0-9:-]*)\\b[^>]*?\\b' + bindAttr + '[^>]*>)([\\s\\S]*?)(</\\2>)', 'i',
			);
			const repeatedTableMatch = html.match(repeatedTableRe);
			if (!repeatedTableMatch || !isRepeatedTableContainerTag(repeatedTableMatch[2])) continue;

			const markerName = generateRepeatedTableDax(factTable, display as RepeatedTableDisplay, varIdx, vars);
			html = html.replace(repeatedTableMatch[0], () => `${repeatedTableMatch[1]}{{${markerName}}}${repeatedTableMatch[4]}`);
			varIdx++;
			continue;
		}

		if (display.type === 'bar' || display.type === 'pie' || display.type === 'line') {
			if (!isValidDashboardChartDisplay(display)) continue;
			const chartRe = new RegExp(
				`(<([a-zA-Z][a-zA-Z0-9:-]*)\\b[^>]*?\\b${bindAttr}[^>]*>)([\\s\\S]*?)(</\\2>)`, 'i',
			);
			const chartMatch = html.match(chartRe);
			if (!chartMatch) continue;

			let markerName: string;
			if (display.type === 'bar') markerName = generateBarChartDax(factTable, display as BarDisplay, varIdx, vars, factDs);
			else if (display.type === 'pie') markerName = generatePieChartDax(factTable, display as PieDisplay, varIdx, vars, factDs);
			else markerName = generateLineChartDax(factTable, display as LineDisplay, varIdx, vars, factDs);

			html = html.replace(chartMatch[0], () => `${chartMatch[1]}{{${markerName}}}${chartMatch[4]}`);
			varIdx++;
			continue;
		}
	}

	if (vars.length === 0) {
		return `"${escapeDaxString(restoreNonRenderedHtmlBlocks(html, protectedBlocks.blocks))}"`;
	}

	// Build the RETURN expression: split HTML at markers, escape fragments, join with &
	const markerRe = /\{\{(_[a-z]+_\d+)\}\}/g;
	const parts: string[] = [];
	let lastIndex = 0;

	for (const m of html.matchAll(markerRe)) {
		const fragment = restoreNonRenderedHtmlBlocks(html.substring(lastIndex, m.index), protectedBlocks.blocks);
		if (fragment) {
			parts.push(`"${escapeDaxString(fragment)}"`);
		}
		parts.push(m[1]);
		lastIndex = m.index! + m[0].length;
	}
	const trailing = restoreNonRenderedHtmlBlocks(html.substring(lastIndex), protectedBlocks.blocks);
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

	// Relationships are reserved for future generated-table scenarios; current
	// dashboard slicers bind directly to fact columns and do not need them.
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
	dataMode: PowerBiDataMode = 'import',
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
		`\t\tmode: ${normalizePowerBiDataMode(dataMode, 'import')}`,
		'\t\tsource =',
		'\t\t\tlet',
		`\t\t\t\tSource = AzureDataExplorer.Contents("${escapedCluster}", "${escapedDb}", "${escapedQuery}")`,
		'\t\t\tin',
		'\t\t\t\tSource',
	];

	return lines.join('\n');
}

export function generateTableTmdl(ds: PowerBiDataSource, dataMode: PowerBiDataMode = 'import'): string {
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
	lines.push(`\t\tmode: ${normalizePowerBiDataMode(dataMode, 'import')}`);
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
	validatePowerBiHtmlBindings(input.htmlCode, input.dataSources);

	const projectName = input.projectName || sanitizeName(input.sectionName) || 'KustoHtmlDashboard';
	const reportFolder = `${projectName}.Report`;
	const modelFolder = `${projectName}.SemanticModel`;
	const pageName = 'ReportPage1';
	const visualId = Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
	const dataMode = normalizePowerBiDataMode(input.dataMode, 'import');

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

	// ── Data source tables (Kusto)
	for (const ds of input.dataSources) {
		const tableName = sanitizeName(ds.name);
		await write(`${modelFolder}/definition/tables/${tableName}.tmdl`, generateTableTmdl(ds, dataMode));
	}

	// ── HTML measures table (DAX measure containing the dashboard HTML/JS)
	await write(`${modelFolder}/definition/tables/${MEASURES_TABLE_NAME}.tmdl`, generateHtmlMeasureTmdl(pbiHtml, input.dataSources));
}
