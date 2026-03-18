import { describe, it, expect } from 'vitest';
import {
	getRawCellValue,
	cellToChartString,
	cellToChartNumber,
	cellToChartTimeMs,
	inferTimeXAxisFromRows,
	normalizeResultsColumnName,
	pickFirstNonEmpty,
} from '../../src/webview/shared/data-utils';

// ── getRawCellValue ───────────────────────────────────────────────────────────

describe('getRawCellValue', () => {
	it('unwraps {full} objects', () => {
		expect(getRawCellValue({ full: 'value123', display: 'v...' })).toBe('value123');
	});
	it('unwraps {display} objects when no full', () => {
		expect(getRawCellValue({ display: 'shown' })).toBe('shown');
	});
	it('returns primitives unchanged', () => {
		expect(getRawCellValue(42)).toBe(42);
		expect(getRawCellValue('hello')).toBe('hello');
		expect(getRawCellValue(null)).toBe(null);
		expect(getRawCellValue(undefined)).toBe(undefined);
		expect(getRawCellValue(true)).toBe(true);
	});
	it('returns empty objects unchanged', () => {
		const obj = { other: 'field' };
		expect(getRawCellValue(obj)).toBe(obj);
	});
});

// ── cellToChartString ─────────────────────────────────────────────────────────

describe('cellToChartString', () => {
	it('returns empty for null/undefined', () => {
		expect(cellToChartString(null)).toBe('');
		expect(cellToChartString(undefined)).toBe('');
	});
	it('converts numbers to string', () => {
		expect(cellToChartString(42)).toBe('42');
	});
	it('handles strings', () => {
		expect(cellToChartString('hello')).toBe('hello');
	});
	it('handles booleans', () => {
		expect(cellToChartString(true)).toBe('true');
	});
	it('unwraps {full} before converting', () => {
		expect(cellToChartString({ full: 42 })).toBe('42');
	});
	it('converts Date to ISO string', () => {
		const d = new Date('2024-01-15T10:30:00.000Z');
		expect(cellToChartString(d)).toBe('2024-01-15T10:30:00.000Z');
	});
	it('JSON stringifies objects', () => {
		expect(cellToChartString({ a: 1 })).toBe('{"a":1}');
	});
});

// ── cellToChartNumber ─────────────────────────────────────────────────────────

describe('cellToChartNumber', () => {
	it('returns number for numeric values', () => {
		expect(cellToChartNumber(42)).toBe(42);
		expect(cellToChartNumber(3.14)).toBe(3.14);
	});
	it('parses numeric strings', () => {
		expect(cellToChartNumber('42')).toBe(42);
	});
	it('returns null for non-numeric', () => {
		expect(cellToChartNumber('abc')).toBe(null);
	});
	it('returns 0 for null (Number(null) === 0)', () => {
		expect(cellToChartNumber(null)).toBe(0);
	});
	it('unwraps {full} before parsing', () => {
		expect(cellToChartNumber({ full: 42 })).toBe(42);
	});
});

// ── cellToChartTimeMs ─────────────────────────────────────────────────────────

describe('cellToChartTimeMs', () => {
	it('parses ISO date strings', () => {
		const result = cellToChartTimeMs('2024-01-15T10:30:00Z');
		expect(result).toBe(Date.parse('2024-01-15T10:30:00Z'));
	});
	it('returns null for non-date strings', () => {
		expect(cellToChartTimeMs('not-a-date')).toBe(null);
	});
	it('returns null for null', () => {
		expect(cellToChartTimeMs(null)).toBe(null);
	});
	it('unwraps {full} before parsing', () => {
		const result = cellToChartTimeMs({ full: '2024-01-15T10:30:00Z' });
		expect(result).toBe(Date.parse('2024-01-15T10:30:00Z'));
	});
});

// ── inferTimeXAxisFromRows ────────────────────────────────────────────────────

describe('inferTimeXAxisFromRows', () => {
	it('returns true for date-heavy columns', () => {
		const rows = [
			['2024-01-01', 10],
			['2024-01-02', 20],
			['2024-01-03', 30],
			['2024-01-04', 40],
			['2024-01-05', 50],
		];
		expect(inferTimeXAxisFromRows(rows, 0)).toBe(true);
	});
	it('returns false for non-date columns', () => {
		const rows = [
			['foo', 10],
			['bar', 20],
			['baz', 30],
		];
		expect(inferTimeXAxisFromRows(rows, 0)).toBe(false);
	});
	it('returns false for empty rows', () => {
		expect(inferTimeXAxisFromRows([], 0)).toBe(false);
	});
	it('returns false for all-null rows', () => {
		const rows = [[null, 10], [null, 20]];
		expect(inferTimeXAxisFromRows(rows, 0)).toBe(false);
	});
});

// ── normalizeResultsColumnName ────────────────────────────────────────────────

describe('normalizeResultsColumnName', () => {
	it('returns string as-is', () => {
		expect(normalizeResultsColumnName('colA')).toBe('colA');
	});
	it('extracts name from {name} objects', () => {
		expect(normalizeResultsColumnName({ name: 'colB' })).toBe('colB');
	});
	it('extracts columnName from {columnName} objects', () => {
		expect(normalizeResultsColumnName({ columnName: 'colC' })).toBe('colC');
	});
	it('returns empty for null/undefined', () => {
		expect(normalizeResultsColumnName(null)).toBe('');
		expect(normalizeResultsColumnName(undefined)).toBe('');
	});
	it('returns empty for objects without name', () => {
		expect(normalizeResultsColumnName({ other: 'val' })).toBe('');
	});
});

// ── pickFirstNonEmpty ─────────────────────────────────────────────────────────

describe('pickFirstNonEmpty', () => {
	it('returns the first non-empty string', () => {
		expect(pickFirstNonEmpty(['', '', 'found', 'another'])).toBe('found');
	});
	it('returns empty if all empty', () => {
		expect(pickFirstNonEmpty(['', '', ''])).toBe('');
	});
	it('returns empty for empty array', () => {
		expect(pickFirstNonEmpty([])).toBe('');
	});
	it('coerces values to strings', () => {
		expect(pickFirstNonEmpty([null, undefined, 42] as unknown[])).toBe('42');
	});
});
