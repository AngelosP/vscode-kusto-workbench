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
}

export type LegendPosition = 'top' | 'right' | 'bottom' | 'left';
export type StackMode = 'normal' | 'stacked' | 'stacked100';
export type TimePeriodGranularity = 'day' | 'week' | 'month' | 'quarter' | 'year';

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
		(typeof settings.titleGap === 'number' && settings.titleGap !== defaults.titleGap)
	);
}

export function hasCustomLabelSettings(st: { showDataLabels?: boolean; labelMode?: string; labelDensity?: number } | null | undefined): boolean {
	if (!st) return false;
	const mode = st.labelMode || 'auto';
	const density = typeof st.labelDensity === 'number' ? st.labelDensity : 50;
	return mode !== 'auto' || density !== 50;
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
