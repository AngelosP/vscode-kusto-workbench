import {
	DASHBOARD_CHART_COLORS,
	chartColor,
	type BarScale,
	type BarSegmentSpec,
	type PreAggregate,
} from './dashboardCharts';

export interface TableCellBarSpec {
	segments: BarSegmentSpec[];
	scale?: BarScale;
	width?: number;
	height?: number;
	radius?: number;
	colors?: string[];
}

export interface TableColumnSpec {
	name: string;
	header?: string;
	agg?: string;
	sourceColumn?: string;
	format?: string;
	cellBar?: TableCellBarSpec;
}

export interface TableDisplay {
	type: 'table';
	columns: TableColumnSpec[];
	groupBy: string[];
	orderBy?: { column: string; direction?: 'asc' | 'desc' };
	top?: number;
	preAggregate?: PreAggregate;
}

export const DASHBOARD_TABLE_CELL_BAR = {
	width: 160,
	height: 10,
	radius: 0,
} as const;

export const TABLE_CELL_BAR_ALIAS_PREFIX = '__kw_cellbar_';
export const TABLE_ROW_INDEX_ALIAS_PREFIX = '__kw_table_idx_';

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

export function isValidTableDisplay(display: unknown): display is TableDisplay {
	if (!isRecord(display) || display.type !== 'table') return false;
	if (!Array.isArray(display.groupBy) || display.groupBy.length === 0 || !display.groupBy.every(isNonEmptyString)) return false;
	if (!Array.isArray(display.columns) || display.columns.length === 0) return false;

	const groupedColumns = new Set(display.groupBy);
	if (hasReservedAliasName(display.groupBy)) return false;

	for (const column of display.columns) {
		if (!isRecord(column) || !isNonEmptyString(column.name)) return false;
		if (isReservedAliasName(column.name)) return false;
		if (column.header !== undefined && typeof column.header !== 'string') return false;
		if (column.agg !== undefined && !isNonEmptyString(column.agg)) return false;
		if (column.sourceColumn !== undefined && typeof column.sourceColumn !== 'string') return false;
		if (column.format !== undefined && typeof column.format !== 'string') return false;
		if (column.cellBar !== undefined) {
			if (column.agg !== undefined || column.sourceColumn !== undefined || column.format !== undefined) return false;
			if (!isValidTableCellBarSpec(column.cellBar)) return false;
			continue;
		}
		if (column.agg === undefined && !groupedColumns.has(column.name)) return false;
		if (tableAggregateNeedsColumn(column.agg) && !isNonEmptyString(column.sourceColumn ?? column.name)) return false;
	}

	if (display.orderBy !== undefined) {
		if (!isRecord(display.orderBy) || !isNonEmptyString(display.orderBy.column)) return false;
		if (display.orderBy.direction !== undefined && display.orderBy.direction !== 'asc' && display.orderBy.direction !== 'desc') return false;
		const sortableColumns = new Set([
			...display.groupBy,
			...display.columns.filter(column => !isTableCellBarColumn(column)).map(column => column.name),
		]);
		if (!sortableColumns.has(display.orderBy.column)) return false;
	}

	if (display.top !== undefined && (typeof display.top !== 'number' || !Number.isInteger(display.top) || display.top <= 0 || display.orderBy === undefined)) return false;
	if (display.preAggregate !== undefined && !isValidPreAggregateSpec(display.preAggregate)) return false;
	return true;
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

function isValidPreAggregateSpec(value: unknown): value is PreAggregate {
	if (!isRecord(value) || !isRecord(value.compute)) return false;
	const groupBy = value.groupBy;
	const validGroupBy = isNonEmptyString(groupBy) || (Array.isArray(groupBy) && groupBy.length > 0 && groupBy.every(isNonEmptyString));
	if (!validGroupBy || !isNonEmptyString(value.compute.name) || !isNonEmptyString(value.compute.agg)) return false;
	if (tableAggregateNeedsColumn(value.compute.agg) && !isNonEmptyString(value.compute.column)) return false;
	if (value.compute.column !== undefined && typeof value.compute.column !== 'string') return false;
	return true;
}

function isReservedAliasName(value: string): boolean {
	const normalized = value.toLowerCase();
	return normalized.startsWith(TABLE_CELL_BAR_ALIAS_PREFIX) || normalized.startsWith(TABLE_ROW_INDEX_ALIAS_PREFIX);
}

function hasReservedAliasName(values: string[]): boolean {
	return values.some(isReservedAliasName);
}