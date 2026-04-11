// Pure chart utility functions — extracted from extraBoxes-chart.ts.
// No DOM access, no window globals. Importable by both Lit components and bridge modules.

// ── Types ─────────────────────────────────────────────────────────────────────

export interface XAxisSettings {
	sortDirection: '' | 'asc' | 'desc';
	scaleType: '' | 'category' | 'continuous';
	labelDensity: number;
	showAxisLabel: boolean;
	customLabel: string;
	titleGap: number;
}

export interface YAxisSettings {
	showAxisLabel: boolean;
	customLabel: string;
	min: string;
	max: string;
	seriesColors: Record<string, string>;
	titleGap: number;
	sortDirection: '' | 'asc' | 'desc';
}

export type LegendPosition = 'top' | 'right' | 'bottom' | 'left';
export type StackMode = 'normal' | 'stacked' | 'stacked100';
export type LegendSortMode = '' | 'alpha-asc' | 'alpha-desc' | 'value-asc' | 'value-desc';
export type TimePeriodGranularity = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface LegendSettings {
	position: LegendPosition;
	stackMode: StackMode;
	gap: number;
	sortMode: LegendSortMode;
	topN: number;          // 0 = disabled, positive = show top N + 'Other'
	title: string;         // '' = use column name
	showEndLabels: boolean; // show legend label at end of each series
}

export type HeatmapVisualMapPosition = 'right' | 'left' | 'bottom' | 'top';
export type HeatmapCellLabelMode = 'all' | 'lowest' | 'highest' | 'both';

export interface HeatmapSettings {
	/** Position of the visual map (color slicer) relative to the chart */
	visualMapPosition: HeatmapVisualMapPosition;
	/** Gap in pixels between the chart area and the visual map */
	visualMapGap: number;
	/** Whether to show values inside each cell */
	showCellLabels: boolean;
	/** Which cells get labels: all, N lowest, N highest, or both N lowest & N highest */
	cellLabelMode: HeatmapCellLabelMode;
	/** Number of lowest/highest values to label */
	cellLabelN: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const LEGEND_POSITION_CYCLE: LegendPosition[] = ['top', 'right', 'bottom', 'left'];
export const STACK_MODE_CYCLE: StackMode[] = ['normal', 'stacked', 'stacked100'];

export const DEFAULT_SERIES_COLORS = [
	'#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de',
	'#3ba272', '#fc8452', '#9a60b4', '#ea7ccc', '#48b8d0',
];

// ── Functions ─────────────────────────────────────────────────────────────────

export function formatNumber(value: unknown): string {
	if (value === null || value === undefined) return '';
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n)) return String(value);
	return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

export function computeAxisFontSize(labelCount: number, axisPixelWidth: number, isYAxis: boolean): number {
	const w = (typeof axisPixelWidth === 'number' && Number.isFinite(axisPixelWidth)) ? axisPixelWidth : 0;
	const n = (typeof labelCount === 'number' && Number.isFinite(labelCount)) ? Math.max(0, Math.floor(labelCount)) : 0;
	if (!w || !n) return 12;
	if (isYAxis) return 11;
	const pixelsPerLabel = w / n;
	if (pixelsPerLabel < 30) return 9;
	if (pixelsPerLabel < 50) return 10;
	if (pixelsPerLabel < 80) return 11;
	return 12;
}

export function normalizeLegendPosition(pos: unknown): LegendPosition {
	const p = String(pos || '').toLowerCase();
	return (p === 'top' || p === 'right' || p === 'bottom' || p === 'left') ? p : 'top';
}

export function normalizeStackMode(mode: unknown): StackMode {
	const m = String(mode || '').toLowerCase();
	return (m === 'normal' || m === 'stacked' || m === 'stacked100') ? m : 'normal';
}

const SORT_MODE_ALIASES: Record<string, LegendSortMode> = {
	'alpha-asc': 'alpha-asc',
	'alpha-desc': 'alpha-desc',
	'value-asc': 'value-asc',
	'value-desc': 'value-desc',
	'alphabetical': 'alpha-asc',
	'alphabetical-asc': 'alpha-asc',
	'alphabetical-desc': 'alpha-desc',
	'by-value': 'value-desc',
	'by-value-asc': 'value-asc',
	'by-value-desc': 'value-desc',
};

export function normalizeLegendSortMode(mode: unknown): LegendSortMode {
	const m = String(mode ?? '').toLowerCase().trim();
	if (!m) return '';
	return SORT_MODE_ALIASES[m] ?? '';
}

export function getDefaultXAxisSettings(): XAxisSettings {
	return {
		sortDirection: '',
		scaleType: '',
		labelDensity: 100,
		showAxisLabel: true,
		customLabel: '',
		titleGap: 30,
	};
}

export function hasCustomXAxisSettings(settings: Partial<XAxisSettings> | null | undefined): boolean {
	if (!settings || typeof settings !== 'object') return false;
	const defaults = getDefaultXAxisSettings();
	return !!(
		(settings.sortDirection && settings.sortDirection !== defaults.sortDirection) ||
		(settings.scaleType && settings.scaleType !== defaults.scaleType) ||
		(typeof settings.labelDensity === 'number' && settings.labelDensity !== 100) ||
		(settings.showAxisLabel === false) ||
		(settings.customLabel && settings.customLabel !== defaults.customLabel) ||
		(typeof settings.titleGap === 'number' && settings.titleGap !== defaults.titleGap)
	);
}

export function getDefaultYAxisSettings(): YAxisSettings {
	return {
		showAxisLabel: true,
		customLabel: '',
		min: '',
		max: '',
		seriesColors: {},
		titleGap: 45,
		sortDirection: '',
	};
}

export function hasCustomYAxisSettings(settings: Partial<YAxisSettings> | null | undefined): boolean {
	if (!settings || typeof settings !== 'object') return false;
	const defaults = getDefaultYAxisSettings();
	const hasCustomColors = settings.seriesColors && typeof settings.seriesColors === 'object' && Object.keys(settings.seriesColors).length > 0;
	return !!(
		(settings.showAxisLabel === false) ||
		(settings.customLabel && settings.customLabel !== '') ||
		(settings.min !== '' && settings.min !== undefined && settings.min !== null) ||
		(settings.max !== '' && settings.max !== undefined && settings.max !== null) ||
		hasCustomColors ||
		(typeof settings.titleGap === 'number' && settings.titleGap !== defaults.titleGap) ||
		(settings.sortDirection && settings.sortDirection !== defaults.sortDirection)
	);
}

export function hasCustomLabelSettings(st: { showDataLabels?: boolean; labelMode?: string; labelDensity?: number } | null | undefined): boolean {
	if (!st) return false;
	const mode = st.labelMode || 'auto';
	const density = typeof st.labelDensity === 'number' ? st.labelDensity : 50;
	return mode !== 'auto' || density !== 50;
}

export function getDefaultLegendSettings(): LegendSettings {
	return {
		position: 'top',
		stackMode: 'normal',
		gap: 0,
		sortMode: '',
		topN: 0,
		title: '',
		showEndLabels: false,
	};
}

export function hasCustomLegendSettings(settings: Partial<LegendSettings> | null | undefined): boolean {
	if (!settings || typeof settings !== 'object') return false;
	const d = getDefaultLegendSettings();
	return !!(
		(settings.position && settings.position !== d.position) ||
		(settings.stackMode && settings.stackMode !== d.stackMode) ||
		(typeof settings.gap === 'number' && settings.gap !== d.gap) ||
		(settings.sortMode && settings.sortMode !== d.sortMode) ||
		(typeof settings.topN === 'number' && settings.topN !== d.topN) ||
		(settings.title && settings.title !== d.title) ||
		(settings.showEndLabels === true)
	);
}

export function getDefaultHeatmapSettings(): HeatmapSettings {
	return {
		visualMapPosition: 'right',
		visualMapGap: 60,
		showCellLabels: false,
		cellLabelMode: 'all',
		cellLabelN: 5,
	};
}

export function hasCustomHeatmapSettings(settings: Partial<HeatmapSettings> | null | undefined): boolean {
	if (!settings || typeof settings !== 'object') return false;
	const d = getDefaultHeatmapSettings();
	return !!(
		(settings.visualMapPosition && settings.visualMapPosition !== d.visualMapPosition) ||
		(typeof settings.visualMapGap === 'number' && settings.visualMapGap !== d.visualMapGap) ||
		(settings.showCellLabels === true) ||
		(settings.cellLabelMode && settings.cellLabelMode !== d.cellLabelMode) ||
		(typeof settings.cellLabelN === 'number' && settings.cellLabelN !== d.cellLabelN)
	);
}

// ── Date/time formatting ──────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatUtcDateTime(ms: number, showTime: boolean): string {
	const v = (typeof ms === 'number') ? ms : Number(ms);
	if (!Number.isFinite(v)) return '';
	const d = new Date(v);
	const dd = String(d.getUTCDate()).padStart(2, '0');
	const mon = MONTHS[d.getUTCMonth()] || 'Jan';
	const yyyy = String(d.getUTCFullYear());
	const date = `${dd}-${mon}-${yyyy}`;
	if (!showTime) return date;
	const hh = String(d.getUTCHours()).padStart(2, '0');
	const mm = String(d.getUTCMinutes()).padStart(2, '0');
	const ss = String(d.getUTCSeconds()).padStart(2, '0');
	return (ss === '00') ? `${date} ${hh}:${mm}` : `${date} ${hh}:${mm}:${ss}`;
}

export function computeTimePeriodGranularity(timeMsValues: number[]): TimePeriodGranularity {
	const times = (timeMsValues || []).filter((t: unknown) => typeof t === 'number' && Number.isFinite(t as number));
	if (times.length < 2) return 'day';

	const minT = Math.min(...times);
	const maxT = Math.max(...times);
	const rangeDays = (maxT - minT) / (1000 * 60 * 60 * 24);

	if (rangeDays > 365 * 2) return 'year';
	if (rangeDays > 365) return 'quarter';
	if (rangeDays > 90) return 'month';
	if (rangeDays > 14) return 'week';
	return 'day';
}

export function formatTimePeriodLabel(ms: number, granularity: TimePeriodGranularity): string {
	const v = (typeof ms === 'number') ? ms : Number(ms);
	if (!Number.isFinite(v)) return '';
	const d = new Date(v);
	const yyyy = String(d.getUTCFullYear());
	const mon = MONTHS[d.getUTCMonth()] || 'Jan';

	switch (granularity) {
		case 'year':
			return yyyy;
		case 'quarter': {
			const q = Math.floor(d.getUTCMonth() / 3) + 1;
			return `Q${q} ${yyyy}`;
		}
		case 'month':
			return `${mon} ${yyyy}`;
		case 'week': {
			const dayOfWeek = d.getUTCDay();
			const diff = d.getUTCDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
			const weekStart = new Date(d);
			weekStart.setUTCDate(diff);
			const dd = String(weekStart.getUTCDate()).padStart(2, '0');
			const mm = MONTHS[weekStart.getUTCMonth()] || 'Jan';
			return `${dd}-${mm}`;
		}
		default: {
			const dd = String(d.getUTCDate()).padStart(2, '0');
			return `${dd}-${mon}`;
		}
	}
}

export function generateContinuousTimeLabels(timeKeys: number[], granularity: TimePeriodGranularity): string[] {
	if (!timeKeys || !timeKeys.length) return [];
	const labels: string[] = [];
	let lastPeriodLabel: string | null = null;
	for (const t of timeKeys) {
		const periodLabel = formatTimePeriodLabel(t, granularity);
		if (periodLabel !== lastPeriodLabel) {
			labels.push(periodLabel);
			lastPeriodLabel = periodLabel;
		} else {
			labels.push('');
		}
	}
	return labels;
}

export function shouldShowTimeForUtcAxis(timeMsValues: number[]): boolean {
	for (const t of (timeMsValues || [])) {
		const v = (typeof t === 'number') ? t : Number(t);
		if (!Number.isFinite(v)) continue;
		const d = new Date(v);
		if (d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0 || d.getUTCMilliseconds() !== 0) {
			return true;
		}
	}
	return false;
}

// ── Label rotation ────────────────────────────────────────────────────────────

export function computeTimeAxisLabelRotation(axisPixelWidth: number, labelCount: number, showTime: boolean): number {
	const w = (typeof axisPixelWidth === 'number' && Number.isFinite(axisPixelWidth)) ? axisPixelWidth : 0;
	const n = (typeof labelCount === 'number' && Number.isFinite(labelCount)) ? Math.max(0, Math.floor(labelCount)) : 0;
	if (!w || !n) return 0;

	const approxChars = showTime ? 17 : 11;
	const approxCharPx = 7;
	const approxLabelPx = approxChars * approxCharPx + 10;
	const maxNoRotate = Math.max(1, Math.floor(w / Math.max(1, approxLabelPx)));

	if (n > maxNoRotate * 2) return 60;
	if (n > maxNoRotate * 1.3) return 45;
	return 0;
}

export function computeCategoryLabelRotation(axisPixelWidth: number, labelCount: number, avgLabelChars: number, maxLabelChars: number): number {
	const w = (typeof axisPixelWidth === 'number' && Number.isFinite(axisPixelWidth)) ? axisPixelWidth : 0;
	const n = (typeof labelCount === 'number' && Number.isFinite(labelCount)) ? Math.max(0, Math.floor(labelCount)) : 0;
	if (!w || !n) return 0;

	const avg = (typeof avgLabelChars === 'number' && Number.isFinite(avgLabelChars)) ? avgLabelChars : 6;
	const mx = (typeof maxLabelChars === 'number' && Number.isFinite(maxLabelChars)) ? maxLabelChars : avg;

	const approxCharPx = 7;
	const effectiveLabelChars = Math.ceil(avg * 0.6 + mx * 0.4);
	const approxLabelPx = effectiveLabelChars * approxCharPx + 12;
	const maxNoRotate = Math.max(1, Math.floor(w / Math.max(1, approxLabelPx)));

	if (n > maxNoRotate * 3) return 75;
	if (n > maxNoRotate * 2) return 60;
	if (n > maxNoRotate * 1.3) return 45;
	if (n > maxNoRotate) return 30;
	return 0;
}

export function measureLabelChars(labels: string[]): { avgLabelChars: number; maxLabelChars: number } {
	let total = 0, mx = 0;
	const len = labels ? labels.length : 0;
	for (let i = 0; i < len; i++) {
		const c = String(labels[i] || '').length;
		total += c;
		if (c > mx) mx = c;
	}
	return { avgLabelChars: len ? total / len : 6, maxLabelChars: mx || 6 };
}
// ── Sankey cycle breaking ─────────────────────────────────────────────────────

export interface SankeyLink {
	source: string;
	target: string;
	value: number;
}

/**
 * Remove the minimum set of links (back edges) needed to make a Sankey graph
 * acyclic.  Uses DFS with adjacency lists sorted by descending value so that
 * high-value edges are explored first and low-value edges are more likely to
 * be identified as back edges and removed.
 *
 * Self-loops (source === target) are always removed.
 *
 * Returns the filtered link array and the count of dropped links.
 */
export function breakSankeyCycles<T extends SankeyLink>(links: T[]): { links: T[]; dropped: number } {
	if (!links || links.length === 0) return { links: links || [], dropped: 0 };

	// Remove self-loops first — they are always invalid in a DAG.
	const selfLoops: T[] = [];
	const remaining: T[] = [];
	for (const l of links) {
		if (l.source === l.target) selfLoops.push(l);
		else remaining.push(l);
	}

	// Build adjacency list, sorted by descending value so DFS prefers keeping
	// high-value edges and marks low-value edges as back edges.
	const adj = new Map<string, T[]>();
	for (const link of remaining) {
		let list = adj.get(link.source);
		if (!list) { list = []; adj.set(link.source, list); }
		list.push(link);
	}
	for (const list of adj.values()) {
		list.sort((a, b) => b.value - a.value);
	}

	// Collect all node names.
	const nodes = new Set<string>();
	for (const link of remaining) {
		nodes.add(link.source);
		nodes.add(link.target);
	}

	// DFS — WHITE=unvisited, GRAY=in current path, BLACK=finished.
	const WHITE = 0, GRAY = 1, BLACK = 2;
	const color = new Map<string, number>();
	for (const n of nodes) color.set(n, WHITE);
	const backEdges = new Set<T>();

	// Iterative DFS to avoid stack overflow on large graphs.
	for (const start of nodes) {
		if (color.get(start) !== WHITE) continue;
		const stack: { node: string; idx: number }[] = [{ node: start, idx: 0 }];
		color.set(start, GRAY);

		while (stack.length > 0) {
			const frame = stack[stack.length - 1];
			const neighbours = adj.get(frame.node) || [];
			if (frame.idx < neighbours.length) {
				const link = neighbours[frame.idx++];
				const v = link.target;
				const c = color.get(v);
				if (c === GRAY) {
					backEdges.add(link);
				} else if (c === WHITE) {
					color.set(v, GRAY);
					stack.push({ node: v, idx: 0 });
				}
			} else {
				color.set(frame.node, BLACK);
				stack.pop();
			}
		}
	}

	const totalDropped = selfLoops.length + backEdges.size;
	if (totalDropped === 0) return { links, dropped: 0 };

	const filtered = remaining.filter(l => !backEdges.has(l));
	return { links: filtered, dropped: totalDropped };
}