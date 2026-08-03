export interface ChartXAxisSettingsState {
	sortDirection?: 'asc' | 'desc' | '';
	scaleType?: 'category' | 'continuous' | '';
	labelDensity?: number;
	showAxisLabel?: boolean;
	customLabel?: string;
	titleGap?: number;
}

export interface ChartYAxisSettingsState {
	showAxisLabel?: boolean;
	customLabel?: string;
	min?: string;
	max?: string;
	seriesColors?: Record<string, string>;
	titleGap?: number;
	sortDirection?: 'asc' | 'desc' | '';
}

export interface ChartLegendSettingsState {
	position?: 'left' | 'right' | 'top' | 'bottom';
	stackMode?: 'normal' | 'stacked' | 'stacked100';
	gap?: number;
	sortMode?: '' | 'alpha-asc' | 'alpha-desc' | 'value-asc' | 'value-desc';
	topN?: number;
	title?: string;
	showEndLabels?: boolean;
}

export interface ChartHeatmapSettingsState {
	visualMapPosition?: 'right' | 'left' | 'bottom' | 'top';
	visualMapGap?: number;
	showCellLabels?: boolean;
	cellLabelMode?: 'all' | 'lowest' | 'highest' | 'both';
	cellLabelN?: number;
}

export interface PersistedChartSectionState {
	id?: string;
	type: 'chart';
	name?: string;
	mode?: 'edit' | 'preview';
	expanded?: boolean;
	editorHeightPx?: number;
	dataSourceId?: string;
	chartType?: 'line' | 'area' | 'bar' | 'scatter' | 'pie' | 'funnel' | 'sankey' | 'heatmap';
	xColumn?: string;
	yColumns?: string[];
	yColumn?: string;
	tooltipColumns?: string[];
	legendColumn?: string;
	legendPosition?: 'left' | 'right' | 'top' | 'bottom';
	stackMode?: 'normal' | 'stacked' | 'stacked100';
	labelColumn?: string;
	valueColumn?: string;
	sourceColumn?: string;
	targetColumn?: string;
	orient?: 'LR' | 'RL' | 'TB' | 'BT';
	sankeyLeftMargin?: number;
	showDataLabels?: boolean;
	labelMode?: 'auto' | 'all' | 'top5' | 'top10' | 'topPercent';
	labelDensity?: number;
	sortColumn?: string;
	sortDirection?: 'asc' | 'desc' | '';
	xAxisSettings?: ChartXAxisSettingsState;
	yAxisSettings?: ChartYAxisSettingsState;
	legendSettings?: ChartLegendSettingsState;
	heatmapSettings?: ChartHeatmapSettingsState;
	chartTitle?: string;
	chartSubtitle?: string;
	chartTitleAlign?: 'left' | 'center' | 'right';
	validation?: unknown;
}

export interface ChartSectionState extends PersistedChartSectionState {
	id: string;
}

type ChartConfiguration = Omit<PersistedChartSectionState, 'id' | 'type'>;
export type ChartSectionPatch = {
	[K in keyof ChartConfiguration]?: Exclude<ChartConfiguration[K], undefined> | null;
};

export type ChartSectionValidationResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

type JsonRecord = Record<string, unknown>;
type MutableChartState = ChartSectionState | PersistedChartSectionState | ChartSectionPatch;

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value: unknown): value is JsonRecord =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const setOwn = (target: object, key: string, value: unknown): void => {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
};

function cloneJsonValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
	if (!value || typeof value !== 'object') return undefined;
	const existing = seen.get(value);
	if (existing !== undefined) return existing;
	if (Array.isArray(value)) {
		const clone: unknown[] = [];
		seen.set(value, clone);
		for (const item of value) clone.push(cloneJsonValue(item, seen));
		return clone;
	}
	const clone: JsonRecord = {};
	seen.set(value, clone);
	for (const [key, item] of Object.entries(value)) setOwn(clone, key, cloneJsonValue(item, seen));
	return clone;
}

function readStringFields(input: JsonRecord, target: MutableChartState): string | undefined {
	for (const key of [
		'name', 'mode', 'dataSourceId', 'chartType', 'xColumn', 'yColumn', 'legendColumn',
		'legendPosition', 'stackMode', 'labelColumn', 'valueColumn', 'sourceColumn', 'targetColumn',
		'orient', 'labelMode', 'sortColumn', 'sortDirection', 'chartTitle', 'chartSubtitle',
		'chartTitleAlign',
	] as const) {
		if (!hasOwn(input, key)) continue;
		if (typeof input[key] !== 'string') return `Chart field "${key}" must be a string.`;
		setOwn(target, key, input[key]);
	}
	return undefined;
}

function readBooleanFields(input: JsonRecord, target: MutableChartState): string | undefined {
	for (const key of ['expanded', 'showDataLabels'] as const) {
		if (!hasOwn(input, key)) continue;
		if (typeof input[key] !== 'boolean') return `Chart field "${key}" must be a boolean.`;
		setOwn(target, key, input[key]);
	}
	return undefined;
}

function readNumberFields(input: JsonRecord, target: MutableChartState): string | undefined {
	for (const key of ['editorHeightPx', 'sankeyLeftMargin', 'labelDensity'] as const) {
		if (!hasOwn(input, key)) continue;
		if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) {
			return `Chart field "${key}" must be a finite number.`;
		}
		setOwn(target, key, input[key]);
	}
	return undefined;
}

function readStringArrays(input: JsonRecord, target: MutableChartState): string | undefined {
	for (const key of ['yColumns', 'tooltipColumns'] as const) {
		if (!hasOwn(input, key)) continue;
		if (!Array.isArray(input[key]) || !(input[key] as unknown[]).every(item => typeof item === 'string')) {
			return `Chart field "${key}" must be an array of strings.`;
		}
		setOwn(target, key, [...input[key] as string[]]);
	}
	return undefined;
}

function readNestedSettings<T extends object>(
	input: JsonRecord,
	key: string,
	stringKeys: readonly string[],
	booleanKeys: readonly string[],
	numberKeys: readonly string[],
	readExtra?: (source: JsonRecord, target: JsonRecord) => string | undefined,
): ChartSectionValidationResult<T | undefined> {
	if (!hasOwn(input, key)) return { ok: true, value: undefined };
	const source = input[key];
	if (!isRecord(source)) return { ok: false, error: `Chart field "${key}" must be an object.` };
	const target: JsonRecord = {};
	for (const field of stringKeys) {
		if (!hasOwn(source, field)) continue;
		if (typeof source[field] !== 'string') {
			return { ok: false, error: `Chart field "${key}.${field}" must be a string.` };
		}
		setOwn(target, field, source[field]);
	}
	for (const field of booleanKeys) {
		if (!hasOwn(source, field)) continue;
		if (typeof source[field] !== 'boolean') {
			return { ok: false, error: `Chart field "${key}.${field}" must be a boolean.` };
		}
		setOwn(target, field, source[field]);
	}
	for (const field of numberKeys) {
		if (!hasOwn(source, field)) continue;
		if (typeof source[field] !== 'number' || !Number.isFinite(source[field])) {
			return { ok: false, error: `Chart field "${key}.${field}" must be a finite number.` };
		}
		setOwn(target, field, source[field]);
	}
	const extraError = readExtra?.(source, target);
	return extraError ? { ok: false, error: extraError } : { ok: true, value: target as T };
}

function readSeriesColors(source: JsonRecord, target: JsonRecord): string | undefined {
	if (!hasOwn(source, 'seriesColors')) return undefined;
	if (!isRecord(source.seriesColors)) return 'Chart field "yAxisSettings.seriesColors" must be an object.';
	const colors: Record<string, string> = {};
	for (const [name, color] of Object.entries(source.seriesColors)) {
		if (typeof color !== 'string') return 'Chart field "yAxisSettings.seriesColors" values must be strings.';
		setOwn(colors, name, color);
	}
	setOwn(target, 'seriesColors', colors);
	return undefined;
}

function readOptionalFields(
	input: JsonRecord,
	target: MutableChartState,
	allowNullDeletion: boolean,
): string | undefined {
	if (allowNullDeletion) {
		for (const key of Object.keys(input)) {
			if (key !== 'id' && key !== 'type' && input[key] === null) setOwn(target, key, null);
		}
	}
	const nonNullInput: JsonRecord = {};
	for (const [key, value] of Object.entries(input)) {
		if (!(allowNullDeletion && value === null)) setOwn(nonNullInput, key, value);
	}
	const scalarError = readStringFields(nonNullInput, target)
		?? readBooleanFields(nonNullInput, target)
		?? readNumberFields(nonNullInput, target)
		?? readStringArrays(nonNullInput, target);
	if (scalarError) return scalarError;

	const xAxis = readNestedSettings<ChartXAxisSettingsState>(
		nonNullInput, 'xAxisSettings', ['sortDirection', 'scaleType', 'customLabel'],
		['showAxisLabel'], ['labelDensity', 'titleGap'],
	);
	if (!xAxis.ok) return xAxis.error;
	if (xAxis.value !== undefined) setOwn(target, 'xAxisSettings', xAxis.value);

	const yAxis = readNestedSettings<ChartYAxisSettingsState>(
		nonNullInput, 'yAxisSettings', ['customLabel', 'min', 'max', 'sortDirection'],
		['showAxisLabel'], ['titleGap'], readSeriesColors,
	);
	if (!yAxis.ok) return yAxis.error;
	if (yAxis.value !== undefined) setOwn(target, 'yAxisSettings', yAxis.value);

	const legend = readNestedSettings<ChartLegendSettingsState>(
		nonNullInput, 'legendSettings', ['position', 'stackMode', 'sortMode', 'title'],
		['showEndLabels'], ['gap', 'topN'],
	);
	if (!legend.ok) return legend.error;
	if (legend.value !== undefined) setOwn(target, 'legendSettings', legend.value);

	const heatmap = readNestedSettings<ChartHeatmapSettingsState>(
		nonNullInput, 'heatmapSettings', ['visualMapPosition', 'cellLabelMode'],
		['showCellLabels'], ['visualMapGap', 'cellLabelN'],
	);
	if (!heatmap.ok) return heatmap.error;
	if (heatmap.value !== undefined) setOwn(target, 'heatmapSettings', heatmap.value);

	if (hasOwn(nonNullInput, 'validation')) {
		setOwn(target, 'validation', cloneJsonValue(nonNullInput.validation));
	}
	return undefined;
}

export function parseChartSection(input: unknown): ChartSectionValidationResult<ChartSectionState> {
	if (!isRecord(input) || input.type !== 'chart') {
		return { ok: false, error: 'Chart section must be an object with type "chart".' };
	}
	const id = typeof input.id === 'string' ? input.id.trim() : '';
	if (!id || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) {
		return { ok: false, error: 'Chart section must have a safe, non-empty ID.' };
	}
	const value: ChartSectionState = { id, type: 'chart' };
	const error = readOptionalFields(input, value, false);
	return error ? { ok: false, error } : { ok: true, value };
}

export function parseChartSectionPatch(input: unknown): ChartSectionValidationResult<ChartSectionPatch> {
	if (!isRecord(input)) return { ok: false, error: 'Chart patch must be an object.' };
	const value: ChartSectionPatch = {};
	const error = readOptionalFields(input, value, true);
	return error ? { ok: false, error } : { ok: true, value };
}

export function patchChartSection(section: ChartSectionState, patch: ChartSectionPatch): ChartSectionState {
	const next = cloneJsonValue(section) as ChartSectionState;
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete (next as unknown as JsonRecord)[key];
		else setOwn(next, key, cloneJsonValue(value));
	}
	next.id = section.id;
	next.type = 'chart';
	return next;
}

export function validatePersistedChartSection(input: unknown): string | undefined {
	if (!isRecord(input) || input.type !== 'chart') {
		return 'Chart section must be an object with type "chart".';
	}
	const value: PersistedChartSectionState = { type: 'chart' };
	return readOptionalFields(input, value, false);
}
