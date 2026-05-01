import { isReservedDashboardTooltipAlias, isValidDashboardTooltipSpec, type DashboardTooltipSpec } from './dashboardTooltips';

export interface PreAggregate {
	groupBy: string | string[];
	compute: { name: string; agg: string; column?: string };
}

export interface ChartValue { agg: string; column?: string; format?: string }
export interface BarSegmentSpec extends ChartValue { label?: string; color?: string }
export interface BarThresholdBand { min: number; max: number; label?: string; color?: string }
export interface BarThresholdBands { bands: BarThresholdBand[]; scaleMax?: number }
export type BarColorRuleOperator = '>' | '>=' | '<' | '<=' | '=' | '==' | '!=' | '<>';
export interface BarColorRule { operator: BarColorRuleOperator; value: number; color: string; label?: string }
export type BarScale = 'relative' | 'normalized100';
export type BarVariant = 'standard' | 'distribution';
export interface BarDisplay {
	type: 'bar';
	groupBy: string;
	value?: ChartValue;
	segments?: BarSegmentSpec[];
	thresholdBands?: BarThresholdBands;
	colorRules?: BarColorRule[];
	scale?: BarScale;
	variant?: BarVariant;
	showValueLabels?: boolean;
	showCategoryLabels?: boolean;
	top?: number;
	colors?: string[];
	preAggregate?: PreAggregate;
	tooltip?: DashboardTooltipSpec;
}
export interface LineSeriesSpec { agg: string; column?: string; label?: string }
export interface LineDisplay { type: 'line'; xAxis: string; series: LineSeriesSpec[]; colors?: string[]; preAggregate?: PreAggregate; tooltip?: DashboardTooltipSpec }
export interface PieDisplay { type: 'pie'; groupBy: string; value: ChartValue; top?: number; colors?: string[]; preAggregate?: PreAggregate; tooltip?: DashboardTooltipSpec }

export type DashboardChartDisplay = BarDisplay | LineDisplay | PieDisplay;
export type DashboardChartType = DashboardChartDisplay['type'];

export const SUPPORTED_DASHBOARD_CHART_TYPES = ['bar', 'pie', 'line'] as const;
export const SUPPORTED_POWER_BI_DISPLAY_TYPES = ['scalar', 'table', 'repeatedTable', 'pivot', ...SUPPORTED_DASHBOARD_CHART_TYPES] as const;

export const DASHBOARD_CHART_COLORS = [
	'#FFC20A', '#0C7BDC', '#4819B1', '#EE6914', '#8E88E8',
	'#A0DACF', '#04F704', '#4C4B54', '#D81B60', '#5F6B6D',
] as const;

export const DASHBOARD_CHART_COLOR_CASE_COUNT = 10;

export const DASHBOARD_BAR_CHART = {
	labelW: 180,
	barMaxW: 460,
	valGap: 8,
	rowH: 24,
	gap: 6,
	padT: 8,
	padB: 8,
	totalW: 760,
	minH: 220,
	labelFontSize: 11,
	labelFill: '#605E5C',
	barRadius: 2,
} as const;

export const DASHBOARD_DISTRIBUTION_BAR_CHART = {
	labelW: 180,
	barMaxW: 560,
	valGap: 8,
	rowH: 16,
	barH: 8,
	gap: 8,
	padT: 6,
	padB: 6,
	totalW: 760,
	minH: 64,
	labelFontSize: 11,
	labelFill: '#605E5C',
	barRadius: 0,
} as const;

export const DASHBOARD_PIE_CHART = {
	cx: 110,
	cy: 110,
	outerR: 80,
	innerR: 50,
	svgW: 760,
	minSvgH: 220,
	legendX: 230,
	legendY: 32,
	legendRowH: 22,
	legendPadB: 18,
	legendValueX: 744,
	legendFontSize: 11,
	legendFill: '#605E5C',
	totalLabelFill: '#605E5C',
	totalValueFill: '#252423',
} as const;

export const DASHBOARD_LINE_CHART = {
	padL: 52,
	padR: 16,
	padT: 14,
	padB: 88,
	W: 760,
	H: 280,
	gridCount: 5,
	gridStroke: '#E6E6E6',
	axisStroke: '#C8C6C4',
	labelFill: '#605E5C',
	labelFontSize: 11,
	xLabelGap: 22,
	legendTopGap: 26,
	legendColumnWidth: 230,
	legendBottomPad: 16,
	legendLineWidth: 18,
	legendGap: 24,
	legendRowH: 18,
	lineStrokeWidth: 3,
	pointRadius: 3.5,
	pointStrokeWidth: 2,
	tooltipHitRadius: 8,
} as const;

export const DASHBOARD_CHART_DEFAULTS = {
	colors: DASHBOARD_CHART_COLORS,
	colorCaseCount: DASHBOARD_CHART_COLOR_CASE_COUNT,
	bar: DASHBOARD_BAR_CHART,
	barDistribution: DASHBOARD_DISTRIBUTION_BAR_CHART,
	pie: DASHBOARD_PIE_CHART,
	line: DASHBOARD_LINE_CHART,
} as const;

export function chartColor(colors: readonly string[] | undefined, idx: number): string {
	const palette = colors && colors.length > 0 ? colors : DASHBOARD_CHART_COLORS;
	return palette[idx % palette.length];
}

export function daxIndexedChartColor(colors: readonly string[] | undefined, idx: number): string {
	return idx < DASHBOARD_CHART_COLOR_CASE_COUNT ? chartColor(colors, idx) : chartColor(colors, 0);
}

export function isDashboardChartDisplay(display: unknown): display is DashboardChartDisplay {
	if (!display || typeof display !== 'object') return false;
	const type = (display as { type?: unknown }).type;
	return typeof type === 'string' && (SUPPORTED_DASHBOARD_CHART_TYPES as readonly string[]).includes(type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object';
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isValidChartDimensionName(value: unknown): value is string {
	return isNonEmptyString(value) && !isReservedDashboardTooltipAlias(value);
}

function aggregateNeedsColumn(agg: unknown): boolean {
	return String(agg || '').toUpperCase() !== 'COUNT';
}

function isChartValue(value: unknown): value is ChartValue {
	if (!isRecord(value) || !isNonEmptyString(value.agg)) return false;
	if (aggregateNeedsColumn(value.agg) && !isNonEmptyString(value.column)) return false;
	if (value.column !== undefined && typeof value.column !== 'string') return false;
	if (value.format !== undefined && typeof value.format !== 'string') return false;
	return true;
}

function isSafeSvgColor(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0 && !/["'<>&]/.test(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isBarSegmentSpec(value: unknown): value is BarSegmentSpec {
	if (!isChartValue(value)) return false;
	const record = value as unknown as Record<string, unknown>;
	if (record.label !== undefined && typeof record.label !== 'string') return false;
	if (record.color !== undefined && !isSafeSvgColor(record.color)) return false;
	return true;
}

function isBarThresholdBand(value: unknown): value is BarThresholdBand {
	if (!isRecord(value) || !isFiniteNumber(value.min) || !isFiniteNumber(value.max)) return false;
	if (value.min < 0 || value.max <= value.min) return false;
	if (value.label !== undefined && typeof value.label !== 'string') return false;
	if (value.color !== undefined && !isSafeSvgColor(value.color)) return false;
	return true;
}

function isBarThresholdBands(value: unknown): value is BarThresholdBands {
	if (!isRecord(value) || !Array.isArray(value.bands) || value.bands.length === 0) return false;
	if (value.scaleMax !== undefined && (!isFiniteNumber(value.scaleMax) || value.scaleMax <= 0)) return false;
	let expectedMin = 0;
	for (const band of value.bands) {
		if (!isBarThresholdBand(band) || band.min !== expectedMin) return false;
		expectedMin = band.max;
	}
	if (value.scaleMax !== undefined && value.scaleMax < expectedMin) return false;
	return true;
}

function isBarColorRule(value: unknown): value is BarColorRule {
	if (!isRecord(value) || !isFiniteNumber(value.value) || !isSafeSvgColor(value.color)) return false;
	if (!['>', '>=', '<', '<=', '=', '==', '!=', '<>'].includes(String(value.operator))) return false;
	if (value.label !== undefined && typeof value.label !== 'string') return false;
	return true;
}

function isValidBarDisplay(display: BarDisplay): boolean {
	if (!isValidChartDimensionName(display.groupBy)) return false;
	if (display.scale !== undefined && display.scale !== 'relative' && display.scale !== 'normalized100') return false;
	if (display.variant !== undefined && display.variant !== 'standard' && display.variant !== 'distribution') return false;
	if (display.showValueLabels !== undefined && typeof display.showValueLabels !== 'boolean') return false;
	if (display.showCategoryLabels !== undefined && typeof display.showCategoryLabels !== 'boolean') return false;

	const hasValue = display.value !== undefined;
	const hasSegments = display.segments !== undefined;
	const hasThresholdBands = display.thresholdBands !== undefined;
	const hasColorRules = display.colorRules !== undefined;
	const modeCount = (hasSegments ? 1 : 0) + (hasThresholdBands ? 1 : 0) + (hasColorRules ? 1 : 0);
	if (modeCount > 1) return false;
	if (display.scale === 'normalized100' && !hasSegments) return false;
	if (hasSegments) {
		return !hasValue
			&& Array.isArray(display.segments)
			&& display.segments.length > 0
			&& display.segments.every(isBarSegmentSpec);
	}
	if (hasThresholdBands) {
		return hasValue
			&& isChartValue(display.value)
			&& isBarThresholdBands(display.thresholdBands);
	}
	if (hasColorRules) {
		return hasValue
			&& isChartValue(display.value)
			&& Array.isArray(display.colorRules)
			&& display.colorRules.length > 0
			&& display.colorRules.every(isBarColorRule);
	}
	return hasValue && isChartValue(display.value);
}

function isPreAggregate(value: unknown): value is PreAggregate {
	if (!isRecord(value)) return false;
	const groupBy = value.groupBy;
	const validGroupBy = isValidChartDimensionName(groupBy) || (Array.isArray(groupBy) && groupBy.length > 0 && groupBy.every(isValidChartDimensionName));
	if (!validGroupBy || !isRecord(value.compute)) return false;
	const compute = value.compute;
	if (!isValidChartDimensionName(compute.name) || !isNonEmptyString(compute.agg)) return false;
	if (aggregateNeedsColumn(compute.agg) && !isNonEmptyString(compute.column)) return false;
	if (compute.column !== undefined && typeof compute.column !== 'string') return false;
	return true;
}

function hasValidSharedChartOptions(display: Record<string, unknown>): boolean {
	if (display.top !== undefined && (typeof display.top !== 'number' || !Number.isInteger(display.top) || display.top <= 0)) return false;
	if (display.colors !== undefined && (!Array.isArray(display.colors) || !display.colors.every(isSafeSvgColor))) return false;
	if (display.preAggregate !== undefined && !isPreAggregate(display.preAggregate)) return false;
	if (display.tooltip !== undefined && !isValidDashboardTooltipSpec(display.tooltip)) return false;
	return true;
}

export function isValidDashboardChartDisplay(display: unknown): display is DashboardChartDisplay {
	if (!isDashboardChartDisplay(display) || !hasValidSharedChartOptions(display as unknown as Record<string, unknown>)) return false;
	if (display.type === 'bar') {
		return isValidBarDisplay(display);
	}
	if (display.type === 'pie') {
		return isValidChartDimensionName(display.groupBy) && isChartValue(display.value);
	}
	return isValidChartDimensionName(display.xAxis)
		&& Array.isArray(display.series)
		&& display.series.length > 0
		&& display.series.every(series => isRecord(series)
			&& isNonEmptyString(series.agg)
			&& (!aggregateNeedsColumn(series.agg) || isNonEmptyString(series.column))
			&& (series.column === undefined || typeof series.column === 'string')
			&& (series.label === undefined || typeof series.label === 'string'));
}

export function isSupportedPowerBiDisplayType(type: string): boolean {
	return (SUPPORTED_POWER_BI_DISPLAY_TYPES as readonly string[]).includes(type);
}

export function escapeXmlLiteral(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
