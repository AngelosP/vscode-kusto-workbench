export interface DashboardTooltipField {
	label?: string;
	column?: string;
	agg?: string;
	format?: string;
}

export interface DashboardTooltipSpec {
	fields: DashboardTooltipField[];
}

export const DASHBOARD_TOOLTIP_ALIAS_PREFIX = '__kw_tooltip_';
export const DASHBOARD_TOOLTIP_AGGREGATES = ['COUNT', 'SUM', 'AVG', 'AVERAGE', 'MIN', 'MAX', 'DISTINCTCOUNT', 'DCOUNT'] as const;

export function dashboardTooltipAlias(varIdx: number, fieldIndex: number): string {
	return `${DASHBOARD_TOOLTIP_ALIAS_PREFIX}${varIdx}_${fieldIndex}`;
}

export function dashboardTooltipAggregateNeedsColumn(agg: unknown): boolean {
	return normalizeDashboardTooltipAggregate(agg) !== 'COUNT';
}

export function normalizeDashboardTooltipAggregate(agg: unknown): string {
	return String(agg || '').trim().toUpperCase();
}

export function isValidDashboardTooltipAggregate(agg: unknown): boolean {
	return typeof agg === 'string'
		&& (DASHBOARD_TOOLTIP_AGGREGATES as readonly string[]).includes(normalizeDashboardTooltipAggregate(agg));
}

export function isReservedDashboardTooltipAlias(value: string): boolean {
	return value.toLowerCase().startsWith(DASHBOARD_TOOLTIP_ALIAS_PREFIX);
}

export function isValidDashboardTooltipSpec(value: unknown): value is DashboardTooltipSpec {
	if (!isRecord(value) || !Array.isArray(value.fields) || value.fields.length === 0) return false;
	return value.fields.every(isValidDashboardTooltipField);
}

function isValidDashboardTooltipField(value: unknown): value is DashboardTooltipField {
	if (!isRecord(value)) return false;
	if (value.label !== undefined && !isSafeTooltipString(value.label)) return false;
	if (value.format !== undefined && !isSafeTooltipString(value.format)) return false;
	if (value.column !== undefined && !isNonEmptyString(value.column)) return false;
	if (value.agg !== undefined && !isValidDashboardTooltipAggregate(value.agg)) return false;
	if (value.agg === undefined && !isNonEmptyString(value.column)) return false;
	if (normalizeDashboardTooltipAggregate(value.agg) === 'COUNT' && value.column !== undefined) return false;
	if (dashboardTooltipAggregateNeedsColumn(value.agg) && !isNonEmptyString(value.column)) return false;
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object';
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0 && !/<\/script/i.test(value);
}

function isSafeTooltipString(value: unknown): value is string {
	return typeof value === 'string' && !/<\/script/i.test(value);
}
