import {
	DASHBOARD_CHART_COLORS,
	chartColor,
	type BarScale,
	type BarSegmentSpec,
	type PreAggregate,
} from './dashboardCharts';
import { DASHBOARD_TOOLTIP_ALIAS_PREFIX, isValidDashboardTooltipSpec, type DashboardTooltipSpec } from './dashboardTooltips';

export interface TableCellBarSpec {
	segments: BarSegmentSpec[];
	scale?: BarScale;
	width?: number;
	height?: number;
	radius?: number;
	colors?: string[];
}

export type TableCellFormatMode = 'badge' | 'cell';
export type TableCellFormatOperator = '>' | '>=' | '<' | '<=' | '=' | '==' | '!=' | '<>';
export type TableCellFontWeight = 'normal' | '600' | 'bold';

export interface TableCellStyleSpec {
	color?: string;
	backgroundColor?: string;
	fontWeight?: TableCellFontWeight;
}

export interface TableCellFormatRule extends TableCellStyleSpec {
	operator: TableCellFormatOperator;
	value: number;
}

export interface TableCellFormatSpec {
	mode?: TableCellFormatMode;
	valueColumn?: string;
	rules: TableCellFormatRule[];
	defaultStyle?: TableCellStyleSpec;
}

export interface TableColumnSpec {
	name: string;
	header?: string;
	agg?: string;
	sourceColumn?: string;
	format?: string;
	cellBar?: TableCellBarSpec;
	cellFormat?: TableCellFormatSpec;
}

export interface TableDisplay {
	type: 'table';
	columns: TableColumnSpec[];
	groupBy: string[];
	orderBy?: { column: string; direction?: 'asc' | 'desc' };
	top?: number;
	preAggregate?: PreAggregate;
	tooltip?: DashboardTooltipSpec;
}

export interface RepeatedTableInnerDisplay {
	columns: TableColumnSpec[];
	groupBy: string[];
	orderBy?: { column: string; direction?: 'asc' | 'desc' };
	top?: number;
	tooltip?: DashboardTooltipSpec;
}

export interface RepeatedTableDisplay {
	type: 'repeatedTable';
	repeatBy: string[];
	repeatColumns?: TableColumnSpec[];
	repeatOrderBy?: { column: string; direction?: 'asc' | 'desc' };
	repeatTop?: number;
	table: RepeatedTableInnerDisplay;
	preAggregate?: PreAggregate;
}

export const DASHBOARD_TABLE_CELL_BAR = {
	width: 160,
	height: 10,
	radius: 0,
} as const;

export const TABLE_CELL_BAR_ALIAS_PREFIX = '__kw_cellbar_';
export const TABLE_ROW_INDEX_ALIAS_PREFIX = '__kw_table_idx_';
export const REPEATED_TABLE_ROW_INDEX_ALIAS_PREFIX = '__kw_repeat_idx_';

export function tableCellBarAlias(varIdx: number, columnIndex: number, segmentIndex: number): string {
	return `${TABLE_CELL_BAR_ALIAS_PREFIX}${varIdx}_${columnIndex}_${segmentIndex}`;
}

export function tableCellBarGeometry(spec: TableCellBarSpec): { width: number; height: number; radius: number } {
	return {
		width: spec.width ?? DASHBOARD_TABLE_CELL_BAR.width,
		height: spec.height ?? DASHBOARD_TABLE_CELL_BAR.height,
		radius: spec.radius ?? DASHBOARD_TABLE_CELL_BAR.radius,
	};
}

export function tableCellBarColor(spec: TableCellBarSpec, segment: BarSegmentSpec, segmentIndex: number): string {
	return segment.color || chartColor(spec.colors ?? DASHBOARD_CHART_COLORS, segmentIndex);
}

export function tableAggregateNeedsColumn(agg: unknown): boolean {
	return String(agg || 'COUNT').toUpperCase() !== 'COUNT';
}

export function isTableCellBarColumn(column: TableColumnSpec): column is TableColumnSpec & { cellBar: TableCellBarSpec } {
	return column.cellBar !== undefined;
}

export function isTableCellFormattedColumn(column: TableColumnSpec): column is TableColumnSpec & { cellFormat: TableCellFormatSpec } {
	return column.cellFormat !== undefined;
}

export function isValidTableDisplay(display: unknown): display is TableDisplay {
	if (!isRecord(display) || display.type !== 'table') return false;
	if (!Array.isArray(display.groupBy) || display.groupBy.length === 0 || !display.groupBy.every(isNonEmptyString)) return false;
	if (!Array.isArray(display.columns) || display.columns.length === 0) return false;

	if (!areValidTableColumns(display.columns, display.groupBy, true)) return false;

	if (display.orderBy !== undefined) {
		if (!isValidOrderBy(display.orderBy, sortableTableColumns(display.groupBy, display.columns))) return false;
	}

	if (display.top !== undefined && (typeof display.top !== 'number' || !Number.isInteger(display.top) || display.top <= 0 || display.orderBy === undefined)) return false;
	if (display.preAggregate !== undefined && !isValidPreAggregateSpec(display.preAggregate)) return false;
	if (display.tooltip !== undefined && !isValidDashboardTooltipSpec(display.tooltip)) return false;
	return true;
}

export function isValidRepeatedTableDisplay(display: unknown): display is RepeatedTableDisplay {
	if (!isRecord(display) || display.type !== 'repeatedTable') return false;
	if (display.tooltip !== undefined) return false;
	if (!Array.isArray(display.repeatBy) || display.repeatBy.length === 0 || !display.repeatBy.every(isNonEmptyString)) return false;
	if (hasReservedAliasName(display.repeatBy)) return false;
	if (display.repeatColumns !== undefined && (!Array.isArray(display.repeatColumns) || display.repeatColumns.length === 0)) return false;
	if (display.repeatColumns !== undefined && !areValidTableColumns(display.repeatColumns, display.repeatBy, false, false)) return false;

	const repeatColumns = display.repeatColumns ?? display.repeatBy.map(name => ({ name }));
	if (display.repeatOrderBy !== undefined && !isValidOrderBy(display.repeatOrderBy, sortableTableColumns(display.repeatBy, repeatColumns))) return false;
	if (display.repeatTop !== undefined && (typeof display.repeatTop !== 'number' || !Number.isInteger(display.repeatTop) || display.repeatTop <= 0 || display.repeatOrderBy === undefined)) return false;

	if (!isRecord(display.table)) return false;
	const tableDisplay = {
		type: 'table',
		groupBy: display.table.groupBy,
		columns: display.table.columns,
		orderBy: display.table.orderBy,
		top: display.table.top,
		preAggregate: display.preAggregate,
		tooltip: display.table.tooltip,
	};
	return isValidTableDisplay(tableDisplay);
}

export function repeatedTableRepeatColumns(display: RepeatedTableDisplay): TableColumnSpec[] {
	return display.repeatColumns ?? display.repeatBy.map(name => ({ name }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object';
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isSafeSvgColor(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0 && !/["'<>&]/.test(value);
}

function isSafeCssColor(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const trimmed = value.trim();
	if (!trimmed || /[;:{}"'<>&\\]/.test(trimmed) || /\/\*/.test(trimmed)) return false;
	if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) return true;
	if (/^[a-zA-Z]+$/.test(trimmed)) return true;
	if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(trimmed)) return true;
	if (/^hsla?\(\s*-?\d+(?:\.\d+)?(?:deg)?\s*,\s*(?:100|\d{1,2}(?:\.\d+)?)%\s*,\s*(?:100|\d{1,2}(?:\.\d+)?)%\s*(?:,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(trimmed)) return true;
	return false;
}

function isValidTableBarSegment(value: unknown): value is BarSegmentSpec {
	if (!isRecord(value) || !isNonEmptyString(value.agg)) return false;
	if (tableAggregateNeedsColumn(value.agg) && !isNonEmptyString(value.column)) return false;
	if (value.column !== undefined && typeof value.column !== 'string') return false;
	if (value.format !== undefined && typeof value.format !== 'string') return false;
	if (value.label !== undefined && typeof value.label !== 'string') return false;
	if (value.color !== undefined && !isSafeSvgColor(value.color)) return false;
	return true;
}

function isValidTableCellBarSpec(value: unknown): value is TableCellBarSpec {
	if (!isRecord(value) || !Array.isArray(value.segments) || value.segments.length === 0) return false;
	if (!value.segments.every(isValidTableBarSegment)) return false;
	if (value.scale !== undefined && value.scale !== 'normalized100' && value.scale !== 'relative') return false;
	if (value.width !== undefined && (!isFiniteNumber(value.width) || value.width <= 0)) return false;
	if (value.height !== undefined && (!isFiniteNumber(value.height) || value.height <= 0)) return false;
	if (value.radius !== undefined && (!isFiniteNumber(value.radius) || value.radius < 0)) return false;
	if (value.colors !== undefined && (!Array.isArray(value.colors) || !value.colors.every(isSafeSvgColor))) return false;
	return true;
}

function isValidCellStyleSpec(value: unknown): value is TableCellStyleSpec {
	if (!isRecord(value)) return false;
	if (value.color !== undefined && !isSafeCssColor(value.color)) return false;
	if (value.backgroundColor !== undefined && !isSafeCssColor(value.backgroundColor)) return false;
	if (value.fontWeight !== undefined && value.fontWeight !== 'normal' && value.fontWeight !== '600' && value.fontWeight !== 'bold') return false;
	return value.color !== undefined || value.backgroundColor !== undefined || value.fontWeight !== undefined;
}

function isValidCellFormatRule(value: unknown): value is TableCellFormatRule {
	if (!isRecord(value)) return false;
	if (!isValidCellStyleSpec(value)) return false;
	if (!['>', '>=', '<', '<=', '=', '==', '!=', '<>'].includes(String(value.operator))) return false;
	return isFiniteNumber(value.value);
}

function isValidCellFormatSpec(value: unknown): value is TableCellFormatSpec {
	if (!isRecord(value) || !Array.isArray(value.rules) || value.rules.length === 0) return false;
	if (value.mode !== undefined && value.mode !== 'badge' && value.mode !== 'cell') return false;
	if (value.valueColumn !== undefined && !isNonEmptyString(value.valueColumn)) return false;
	if (!value.rules.every(isValidCellFormatRule)) return false;
	if (value.defaultStyle !== undefined && !isValidCellStyleSpec(value.defaultStyle)) return false;
	return true;
}

function areValidTableColumns(columns: TableColumnSpec[], groupBy: string[], allowCellBar: boolean, allowCellFormat = true): boolean {
	const groupedColumns = new Set(groupBy);
	const summarizedColumns = sortableTableColumns(groupBy, columns);
	if (hasReservedAliasName(groupBy)) return false;
	for (const column of columns) {
		if (!isRecord(column) || !isNonEmptyString(column.name)) return false;
		if (isReservedAliasName(column.name)) return false;
		if (column.header !== undefined && typeof column.header !== 'string') return false;
		if (column.agg !== undefined && !isNonEmptyString(column.agg)) return false;
		if (column.sourceColumn !== undefined && typeof column.sourceColumn !== 'string') return false;
		if (column.format !== undefined && typeof column.format !== 'string') return false;
		if (column.cellBar !== undefined) {
			if (!allowCellBar) return false;
			if (column.cellFormat !== undefined) return false;
			if (column.agg !== undefined || column.sourceColumn !== undefined || column.format !== undefined) return false;
			if (!isValidTableCellBarSpec(column.cellBar)) return false;
			continue;
		}
		if (column.cellFormat !== undefined) {
			if (!allowCellFormat || !isValidCellFormatSpec(column.cellFormat)) return false;
			if (!summarizedColumns.has(column.cellFormat.valueColumn ?? column.name)) return false;
		}
		if (column.agg === undefined && !groupedColumns.has(column.name)) return false;
		if (tableAggregateNeedsColumn(column.agg) && !isNonEmptyString(column.sourceColumn ?? column.name)) return false;
	}
	return true;
}

function sortableTableColumns(groupBy: string[], columns: TableColumnSpec[]): Set<string> {
	return new Set([
		...groupBy,
		...columns.filter(column => !isTableCellBarColumn(column)).map(column => column.name),
	]);
}

function isValidOrderBy(orderBy: unknown, sortableColumns: Set<string>): orderBy is { column: string; direction?: 'asc' | 'desc' } {
	if (!isRecord(orderBy) || !isNonEmptyString(orderBy.column)) return false;
	if (orderBy.direction !== undefined && orderBy.direction !== 'asc' && orderBy.direction !== 'desc') return false;
	return sortableColumns.has(orderBy.column);
}

function isValidPreAggregateSpec(value: unknown): value is PreAggregate {
	if (!isRecord(value) || !isRecord(value.compute)) return false;
	const groupBy = value.groupBy;
	const validGroupBy = isNonEmptyString(groupBy) || (Array.isArray(groupBy) && groupBy.length > 0 && groupBy.every(isNonEmptyString));
	if (!validGroupBy || !isNonEmptyString(value.compute.name) || !isNonEmptyString(value.compute.agg)) return false;
	const groupByColumns = (Array.isArray(groupBy) ? groupBy : [groupBy]) as string[];
	if (hasReservedAliasName(groupByColumns) || isReservedAliasName(value.compute.name)) return false;
	if (tableAggregateNeedsColumn(value.compute.agg) && !isNonEmptyString(value.compute.column)) return false;
	if (value.compute.column !== undefined && typeof value.compute.column !== 'string') return false;
	return true;
}

function isReservedAliasName(value: string): boolean {
	const normalized = value.toLowerCase();
	return normalized.startsWith(TABLE_CELL_BAR_ALIAS_PREFIX)
		|| normalized.startsWith(TABLE_ROW_INDEX_ALIAS_PREFIX)
		|| normalized.startsWith(REPEATED_TABLE_ROW_INDEX_ALIAS_PREFIX)
		|| normalized.startsWith(DASHBOARD_TOOLTIP_ALIAS_PREFIX);
}

function hasReservedAliasName(values: string[]): boolean {
	return values.some(isReservedAliasName);
}