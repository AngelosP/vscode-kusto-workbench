import { describe, it, expect } from 'vitest';
import {
	formatNumber,
	computeAxisFontSize,
	normalizeLegendPosition,
	getDefaultXAxisSettings,
	hasCustomXAxisSettings,
	getDefaultYAxisSettings,
	hasCustomYAxisSettings,
	hasCustomLabelSettings,
	formatUtcDateTime,
	computeTimePeriodGranularity,
	formatTimePeriodLabel,
	generateContinuousTimeLabels,
	shouldShowTimeForUtcAxis,
	computeTimeAxisLabelRotation,
	computeCategoryLabelRotation,
	measureLabelChars,
	DEFAULT_SERIES_COLORS,
	LEGEND_POSITION_CYCLE,
} from '../../src/webview/shared/chart-utils';

// ── formatNumber ──────────────────────────────────────────────────────────────

describe('formatNumber', () => {
	it('formats integers with commas', () => {
		expect(formatNumber(1000)).toBe('1,000');
		expect(formatNumber(1234567)).toBe('1,234,567');
	});
	it('formats decimals (max 6 fraction digits)', () => {
		expect(formatNumber(3.14159)).toBe('3.14159');
		expect(formatNumber(1.1234567)).toBe('1.123457'); // rounded to 6 digits
	});
	it('returns empty string for null/undefined', () => {
		expect(formatNumber(null)).toBe('');
		expect(formatNumber(undefined)).toBe('');
	});
	it('returns string for non-finite', () => {
		expect(formatNumber(NaN)).toBe('NaN');
		expect(formatNumber(Infinity)).toBe('Infinity');
	});
	it('handles zero', () => {
		expect(formatNumber(0)).toBe('0');
	});
	it('handles negative numbers', () => {
		expect(formatNumber(-42)).toBe('-42');
	});
	it('coerces string to number', () => {
		expect(formatNumber('123')).toBe('123');
	});
});

// ── computeAxisFontSize ───────────────────────────────────────────────────────

describe('computeAxisFontSize', () => {
	it('returns 12 as default for invalid input', () => {
		expect(computeAxisFontSize(0, 0, false)).toBe(12);
		expect(computeAxisFontSize(NaN, NaN, false)).toBe(12);
	});
	it('returns 11 for Y-axis always', () => {
		expect(computeAxisFontSize(10, 800, true)).toBe(11);
	});
	it('returns smaller font for dense X-axis', () => {
		expect(computeAxisFontSize(100, 300, false)).toBe(9);  // 3px per label
		expect(computeAxisFontSize(10, 300, false)).toBe(10);  // 30px per label (boundary)
		expect(computeAxisFontSize(5, 300, false)).toBe(11);   // 60px per label
		expect(computeAxisFontSize(3, 300, false)).toBe(12);   // 100px per label
	});
});

// ── normalizeLegendPosition ───────────────────────────────────────────────────

describe('normalizeLegendPosition', () => {
	it('passes through valid positions', () => {
		expect(normalizeLegendPosition('top')).toBe('top');
		expect(normalizeLegendPosition('right')).toBe('right');
		expect(normalizeLegendPosition('bottom')).toBe('bottom');
		expect(normalizeLegendPosition('left')).toBe('left');
	});
	it('is case-insensitive', () => {
		expect(normalizeLegendPosition('TOP')).toBe('top');
		expect(normalizeLegendPosition('Bottom')).toBe('bottom');
	});
	it('defaults to top for invalid input', () => {
		expect(normalizeLegendPosition('')).toBe('top');
		expect(normalizeLegendPosition(null)).toBe('top');
		expect(normalizeLegendPosition(undefined)).toBe('top');
		expect(normalizeLegendPosition('center')).toBe('top');
	});
});

// ── Axis settings ─────────────────────────────────────────────────────────────

describe('getDefaultXAxisSettings', () => {
	it('returns expected defaults', () => {
		const s = getDefaultXAxisSettings();
		expect(s.sortDirection).toBe('');
		expect(s.scaleType).toBe('');
		expect(s.labelDensity).toBe(100);
		expect(s.showAxisLabel).toBe(true);
		expect(s.customLabel).toBe('');
		expect(s.titleGap).toBe(30);
	});
});

describe('hasCustomXAxisSettings', () => {
	it('returns false for defaults', () => {
		expect(hasCustomXAxisSettings(getDefaultXAxisSettings())).toBe(false);
	});
	it('returns false for null/undefined', () => {
		expect(hasCustomXAxisSettings(null)).toBe(false);
		expect(hasCustomXAxisSettings(undefined)).toBe(false);
	});
	it('detects custom sortDirection', () => {
		expect(hasCustomXAxisSettings({ ...getDefaultXAxisSettings(), sortDirection: 'asc' })).toBe(true);
	});
	it('detects custom labelDensity', () => {
		expect(hasCustomXAxisSettings({ ...getDefaultXAxisSettings(), labelDensity: 50 })).toBe(true);
	});
	it('detects hidden axis label', () => {
		expect(hasCustomXAxisSettings({ ...getDefaultXAxisSettings(), showAxisLabel: false })).toBe(true);
	});
});

describe('getDefaultYAxisSettings', () => {
	it('returns expected defaults', () => {
		const s = getDefaultYAxisSettings();
		expect(s.showAxisLabel).toBe(true);
		expect(s.customLabel).toBe('');
		expect(s.min).toBe('');
		expect(s.max).toBe('');
		expect(s.seriesColors).toEqual({});
		expect(s.titleGap).toBe(45);
	});
});

describe('hasCustomYAxisSettings', () => {
	it('returns false for defaults', () => {
		expect(hasCustomYAxisSettings(getDefaultYAxisSettings())).toBe(false);
	});
	it('returns false for null/undefined', () => {
		expect(hasCustomYAxisSettings(null)).toBe(false);
	});
	it('detects custom min', () => {
		expect(hasCustomYAxisSettings({ ...getDefaultYAxisSettings(), min: '0' })).toBe(true);
	});
	it('detects custom series colors', () => {
		expect(hasCustomYAxisSettings({ ...getDefaultYAxisSettings(), seriesColors: { 'Revenue': '#ff0000' } })).toBe(true);
	});
});

describe('hasCustomLabelSettings', () => {
	it('returns false for defaults', () => {
		expect(hasCustomLabelSettings({ labelMode: 'auto', labelDensity: 50 })).toBe(false);
	});
	it('returns false for null', () => {
		expect(hasCustomLabelSettings(null)).toBe(false);
	});
	it('detects custom mode', () => {
		expect(hasCustomLabelSettings({ labelMode: 'all', labelDensity: 50 })).toBe(true);
	});
	it('detects custom density', () => {
		expect(hasCustomLabelSettings({ labelMode: 'auto', labelDensity: 25 })).toBe(true);
	});
});

// ── formatUtcDateTime ─────────────────────────────────────────────────────────

describe('formatUtcDateTime', () => {
	it('formats date only', () => {
		const ms = Date.UTC(2024, 0, 15); // Jan 15, 2024
		expect(formatUtcDateTime(ms, false)).toBe('15-Jan-2024');
	});
	it('formats date with time (no seconds)', () => {
		const ms = Date.UTC(2024, 5, 1, 14, 30, 0); // Jun 1, 2024 14:30:00
		expect(formatUtcDateTime(ms, true)).toBe('01-Jun-2024 14:30');
	});
	it('formats date with time including seconds', () => {
		const ms = Date.UTC(2024, 5, 1, 14, 30, 45);
		expect(formatUtcDateTime(ms, true)).toBe('01-Jun-2024 14:30:45');
	});
	it('returns empty for non-finite', () => {
		expect(formatUtcDateTime(NaN, false)).toBe('');
		expect(formatUtcDateTime(Infinity, false)).toBe('');
	});
});

// ── computeTimePeriodGranularity ──────────────────────────────────────────────

describe('computeTimePeriodGranularity', () => {
	const day = 24 * 60 * 60 * 1000;
	const now = Date.now();

	it('returns day for small ranges', () => {
		expect(computeTimePeriodGranularity([now, now + 5 * day])).toBe('day');
	});
	it('returns week for 2-12 week ranges', () => {
		expect(computeTimePeriodGranularity([now, now + 30 * day])).toBe('week');
	});
	it('returns month for 3-12 month ranges', () => {
		expect(computeTimePeriodGranularity([now, now + 200 * day])).toBe('month');
	});
	it('returns quarter for 1-2 year ranges', () => {
		expect(computeTimePeriodGranularity([now, now + 400 * day])).toBe('quarter');
	});
	it('returns year for large ranges', () => {
		expect(computeTimePeriodGranularity([now, now + 800 * day])).toBe('year');
	});
	it('returns day for single point', () => {
		expect(computeTimePeriodGranularity([now])).toBe('day');
	});
});

// ── formatTimePeriodLabel ─────────────────────────────────────────────────────

describe('formatTimePeriodLabel', () => {
	it('formats year', () => {
		const ms = Date.UTC(2024, 5, 15);
		expect(formatTimePeriodLabel(ms, 'year')).toBe('2024');
	});
	it('formats quarter', () => {
		const ms = Date.UTC(2024, 5, 15); // June = Q2
		expect(formatTimePeriodLabel(ms, 'quarter')).toBe('Q2 2024');
	});
	it('formats month', () => {
		const ms = Date.UTC(2024, 5, 15);
		expect(formatTimePeriodLabel(ms, 'month')).toBe('Jun 2024');
	});
	it('formats day', () => {
		const ms = Date.UTC(2024, 0, 5);
		expect(formatTimePeriodLabel(ms, 'day')).toBe('05-Jan');
	});
	it('returns empty for non-finite', () => {
		expect(formatTimePeriodLabel(NaN, 'day')).toBe('');
	});
});

// ── generateContinuousTimeLabels ──────────────────────────────────────────────

describe('generateContinuousTimeLabels', () => {
	it('returns empty array for empty input', () => {
		expect(generateContinuousTimeLabels([], 'day')).toEqual([]);
	});
	it('shows labels only at period boundaries', () => {
		const day = 24 * 60 * 60 * 1000;
		const jan1 = Date.UTC(2024, 0, 1);
		const jan2 = Date.UTC(2024, 0, 2);
		const feb1 = Date.UTC(2024, 1, 1);
		const labels = generateContinuousTimeLabels([jan1, jan2, feb1], 'month');
		expect(labels[0]).toBe('Jan 2024');
		expect(labels[1]).toBe(''); // same month
		expect(labels[2]).toBe('Feb 2024');
	});
});

// ── shouldShowTimeForUtcAxis ──────────────────────────────────────────────────

describe('shouldShowTimeForUtcAxis', () => {
	it('returns false for midnight-only values', () => {
		expect(shouldShowTimeForUtcAxis([
			Date.UTC(2024, 0, 1, 0, 0, 0),
			Date.UTC(2024, 0, 2, 0, 0, 0),
		])).toBe(false);
	});
	it('returns true when time component present', () => {
		expect(shouldShowTimeForUtcAxis([
			Date.UTC(2024, 0, 1, 14, 30, 0),
		])).toBe(true);
	});
	it('returns false for empty array', () => {
		expect(shouldShowTimeForUtcAxis([])).toBe(false);
	});
});

// ── Label rotation ────────────────────────────────────────────────────────────

describe('computeTimeAxisLabelRotation', () => {
	it('returns 0 for few labels', () => {
		expect(computeTimeAxisLabelRotation(1000, 3, false)).toBe(0);
	});
	it('returns non-zero for many labels in small width', () => {
		const result = computeTimeAxisLabelRotation(300, 50, false);
		expect(result).toBeGreaterThan(0);
	});
	it('returns 0 for invalid input', () => {
		expect(computeTimeAxisLabelRotation(0, 0, false)).toBe(0);
	});
});

describe('computeCategoryLabelRotation', () => {
	it('returns 0 for few short labels', () => {
		expect(computeCategoryLabelRotation(800, 3, 5, 8)).toBe(0);
	});
	it('returns rotation for many labels in small width', () => {
		const result = computeCategoryLabelRotation(200, 50, 10, 20);
		expect(result).toBeGreaterThan(0);
	});
});

describe('measureLabelChars', () => {
	it('measures average and max correctly', () => {
		const result = measureLabelChars(['abc', 'ab', 'a', 'abcde']);
		expect(result.avgLabelChars).toBeCloseTo((3 + 2 + 1 + 5) / 4);
		expect(result.maxLabelChars).toBe(5);
	});
	it('returns defaults for empty input', () => {
		const result = measureLabelChars([]);
		expect(result.avgLabelChars).toBe(6);
		expect(result.maxLabelChars).toBe(6);
	});
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe('constants', () => {
	it('LEGEND_POSITION_CYCLE has 4 positions', () => {
		expect(LEGEND_POSITION_CYCLE).toEqual(['top', 'right', 'bottom', 'left']);
	});
	it('DEFAULT_SERIES_COLORS has 10 colors', () => {
		expect(DEFAULT_SERIES_COLORS).toHaveLength(10);
		expect(DEFAULT_SERIES_COLORS[0]).toBe('#5470c6');
	});
});
