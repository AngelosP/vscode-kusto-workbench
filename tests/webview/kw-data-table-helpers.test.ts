import { describe, it, expect } from 'vitest';
import {
	tryParseNum,
	tryParseDateMs,
	kustoTypeToSortType,
	inferColumnTypes,
	getCellDisplayValue,
	getCellSortValue,
	buildClipboardText,
	type DataTableColumn,
	type CellValue,
} from '../../src/webview/components/kw-data-table.js';

// ── tryParseNum ───────────────────────────────────────────────────────────────

describe('tryParseNum', () => {
	it('parses integers', () => {
		expect(tryParseNum(42)).toBe(42);
		expect(tryParseNum(-7)).toBe(-7);
		expect(tryParseNum(0)).toBe(0);
	});

	it('parses decimal numbers', () => {
		expect(tryParseNum(3.14)).toBe(3.14);
		expect(tryParseNum(-0.5)).toBe(-0.5);
	});

	it('parses numeric strings', () => {
		expect(tryParseNum('42')).toBe(42);
		expect(tryParseNum('-7')).toBe(-7);
		expect(tryParseNum('3.14')).toBe(3.14);
	});

	it('parses scientific notation', () => {
		expect(tryParseNum('1e3')).toBe(1000);
		expect(tryParseNum('2.5E-2')).toBe(0.025);
		expect(tryParseNum('-1.5e+3')).toBe(-1500);
	});

	it('handles whitespace around numbers', () => {
		expect(tryParseNum('  42  ')).toBe(42);
	});

	it('parses +3.14', () => {
		expect(tryParseNum('+3.14')).toBe(3.14);
	});

	it('parses -0', () => {
		expect(tryParseNum('-0')).toBe(-0);
	});

	it('rejects booleans explicitly', () => {
		expect(tryParseNum(true)).toBeNull();
		expect(tryParseNum(false)).toBeNull();
	});

	it('returns null for null/undefined', () => {
		expect(tryParseNum(null)).toBeNull();
		expect(tryParseNum(undefined)).toBeNull();
	});

	it('returns null for objects', () => {
		expect(tryParseNum({})).toBeNull();
		expect(tryParseNum([])).toBeNull();
	});

	it('returns null for non-numeric strings', () => {
		expect(tryParseNum('hello')).toBeNull();
		expect(tryParseNum('12abc')).toBeNull();
		expect(tryParseNum('')).toBeNull();
	});

	it('returns null for NaN/Infinity', () => {
		expect(tryParseNum(NaN)).toBeNull();
		expect(tryParseNum(Infinity)).toBeNull();
		expect(tryParseNum(-Infinity)).toBeNull();
	});
});

// ── tryParseDateMs (strict, regex-gated) ──────────────────────────────────────

describe('tryParseDateMs (data-table — strict)', () => {
	it('parses ISO date strings', () => {
		const result = tryParseDateMs('2024-01-15T10:30:00Z');
		expect(result).toBe(Date.parse('2024-01-15T10:30:00Z'));
	});

	it('parses ISO date with space separator', () => {
		const result = tryParseDateMs('2024-01-15 10:30');
		expect(result).toBeTypeOf('number');
		expect(result).not.toBeNull();
	});

	it('parses verbose Date.toString() format', () => {
		const result = tryParseDateMs('Mon Jan 15 2024 10:30:00 GMT+0000');
		expect(result).toBeTypeOf('number');
		expect(result).not.toBeNull();
	});

	it('rejects plain numbers (unlike filter version)', () => {
		expect(tryParseDateMs(42)).toBeNull();
		expect(tryParseDateMs(1705312200000)).toBeNull();
	});

	it('rejects booleans', () => {
		expect(tryParseDateMs(true)).toBeNull();
		expect(tryParseDateMs(false)).toBeNull();
	});

	it('rejects plain text', () => {
		expect(tryParseDateMs('hello')).toBeNull();
	});

	it('rejects null/undefined', () => {
		expect(tryParseDateMs(null)).toBeNull();
		expect(tryParseDateMs(undefined)).toBeNull();
	});

	it('rejects short strings (< 8 chars)', () => {
		expect(tryParseDateMs('2024')).toBeNull();
	});
});

// ── kustoTypeToSortType ───────────────────────────────────────────────────────

describe('kustoTypeToSortType', () => {
	it('maps integer types → number', () => {
		expect(kustoTypeToSortType('int')).toBe('number');
		expect(kustoTypeToSortType('long')).toBe('number');
		expect(kustoTypeToSortType('int32')).toBe('number');
		expect(kustoTypeToSortType('int64')).toBe('number');
	});

	it('maps real/decimal types → number', () => {
		expect(kustoTypeToSortType('real')).toBe('number');
		expect(kustoTypeToSortType('decimal')).toBe('number');
		expect(kustoTypeToSortType('double')).toBe('number');
		expect(kustoTypeToSortType('float')).toBe('number');
	});

	it('maps datetime/date → date', () => {
		expect(kustoTypeToSortType('datetime')).toBe('date');
		expect(kustoTypeToSortType('date')).toBe('date');
	});

	it('maps bool/boolean → boolean', () => {
		expect(kustoTypeToSortType('bool')).toBe('boolean');
		expect(kustoTypeToSortType('boolean')).toBe('boolean');
	});

	it('maps string/guid → string', () => {
		expect(kustoTypeToSortType('string')).toBe('string');
		expect(kustoTypeToSortType('guid')).toBe('string');
	});

	it('strips system. prefix', () => {
		expect(kustoTypeToSortType('system.int32')).toBe('number');
		expect(kustoTypeToSortType('System.Int64')).toBe('number');
		expect(kustoTypeToSortType('System.DateTime')).toBe('date');
		expect(kustoTypeToSortType('System.Boolean')).toBe('boolean');
	});

	it('unknown type → null', () => {
		expect(kustoTypeToSortType('unknown')).toBeNull();
		expect(kustoTypeToSortType('foo')).toBeNull();
	});

	it('undefined → null', () => {
		expect(kustoTypeToSortType(undefined)).toBeNull();
	});
});

// ── inferColumnTypes ──────────────────────────────────────────────────────────

describe('inferColumnTypes', () => {
	const col = (name: string, type?: string): DataTableColumn => ({ name, type });

	it('all-number column → number', () => {
		const cols = [col('val')];
		const rows: CellValue[][] = [[1], [2], [3], [4], [5]];
		expect(inferColumnTypes(cols, rows)).toEqual(['number']);
	});

	it('all-date column → date', () => {
		const cols = [col('ts')];
		const rows: CellValue[][] = [
			['2024-01-01T00:00:00Z'],
			['2024-02-01T00:00:00Z'],
			['2024-03-01T00:00:00Z'],
		];
		expect(inferColumnTypes(cols, rows)).toEqual(['date']);
	});

	it('mixed column below threshold → string', () => {
		const cols = [col('mixed')];
		const rows: CellValue[][] = [[1], ['hello'], [true], [null], ['world']];
		expect(inferColumnTypes(cols, rows)).toEqual(['string']);
	});

	it('metadata override: col.type wins over heuristic', () => {
		const cols = [col('val', 'int')];
		const rows: CellValue[][] = [['not-a-number'], ['also-not']];
		expect(inferColumnTypes(cols, rows)).toEqual(['number']);
	});

	it('empty rows → string fallback', () => {
		const cols = [col('val')];
		expect(inferColumnTypes(cols, [])).toEqual(['string']);
	});

	it('all-null rows → string fallback (no samples)', () => {
		const cols = [col('val')];
		const rows: CellValue[][] = [[null], [undefined], ['']];
		expect(inferColumnTypes(cols, rows)).toEqual(['string']);
	});

	it('numeric timestamps should NOT infer as date if also parse as numbers', () => {
		// Plain number values parse as numbers but the strict tryParseDateMs rejects them
		const cols = [col('val')];
		const rows: CellValue[][] = [[1705312200000], [1705398600000], [1705485000000]];
		expect(inferColumnTypes(cols, rows)).toEqual(['number']);
	});

	it('boolean column (≥60% true/false) → boolean', () => {
		const cols = [col('flag')];
		const rows: CellValue[][] = [[true], [false], [true], [true], [false]];
		expect(inferColumnTypes(cols, rows)).toEqual(['boolean']);
	});

	it('handles object cells with .full', () => {
		const cols = [col('val')];
		const rows: CellValue[][] = [
			[{ full: 42 }],
			[{ full: 100 }],
			[{ full: -3 }],
		];
		expect(inferColumnTypes(cols, rows)).toEqual(['number']);
	});

	it('multiple columns inferred independently', () => {
		const cols = [col('num'), col('dt'), col('str')];
		const rows: CellValue[][] = [
			[1, '2024-01-01T00:00:00Z', 'hello'],
			[2, '2024-02-01T00:00:00Z', 'world'],
			[3, '2024-03-01T00:00:00Z', 'test'],
		];
		expect(inferColumnTypes(cols, rows)).toEqual(['number', 'date', 'string']);
	});
});

// ── getCellDisplayValue ───────────────────────────────────────────────────────

describe('getCellDisplayValue', () => {
	it('string → string', () => {
		expect(getCellDisplayValue('hello')).toBe('hello');
	});

	it('number → string', () => {
		expect(getCellDisplayValue(42)).toBe('42');
	});

	it('boolean → string', () => {
		expect(getCellDisplayValue(true)).toBe('true');
		expect(getCellDisplayValue(false)).toBe('false');
	});

	it('null → empty string', () => {
		expect(getCellDisplayValue(null)).toBe('');
	});

	it('undefined → empty string', () => {
		expect(getCellDisplayValue(undefined)).toBe('');
	});

	it('object with .display → uses .display', () => {
		expect(getCellDisplayValue({ display: 'shown', full: 'hidden' })).toBe('shown');
	});

	it('object with .full only → uses .full', () => {
		expect(getCellDisplayValue({ full: 'actual' })).toBe('actual');
	});

	it('object with .full null → empty string', () => {
		expect(getCellDisplayValue({ full: null })).toBe('');
	});

	it('object with .full as object → JSON.stringify', () => {
		expect(getCellDisplayValue({ full: { a: 1 } })).toBe('{"a":1}');
	});

	it('array → JSON.stringify', () => {
		expect(getCellDisplayValue([1, 2, 3] as unknown as CellValue)).toBe('[1,2,3]');
	});
});

// ── getCellSortValue ──────────────────────────────────────────────────────────

describe('getCellSortValue', () => {
	it('string → string', () => {
		expect(getCellSortValue('hello')).toBe('hello');
	});

	it('number → number', () => {
		expect(getCellSortValue(42)).toBe(42);
	});

	it('boolean → boolean', () => {
		expect(getCellSortValue(true)).toBe(true);
	});

	it('null → null', () => {
		expect(getCellSortValue(null)).toBeNull();
	});

	it('undefined → null', () => {
		expect(getCellSortValue(undefined)).toBeNull();
	});

	it('object with .full number → number', () => {
		expect(getCellSortValue({ full: 42 })).toBe(42);
	});

	it('object with .full string → string', () => {
		expect(getCellSortValue({ full: 'hello' })).toBe('hello');
	});

	it('object with .full boolean → boolean', () => {
		expect(getCellSortValue({ full: true })).toBe(true);
	});

	it('object with .full object → falls back to display value', () => {
		const v = getCellSortValue({ full: { a: 1 } });
		expect(v).toBe('{"a":1}');
	});
});

// ── buildClipboardText ────────────────────────────────────────────────────────

describe('buildClipboardText', () => {
	const cols: DataTableColumn[] = [
		{ name: 'Name' },
		{ name: 'Age' },
		{ name: 'City' },
	];
	const rows: CellValue[][] = [
		['Alice', 30, 'Seattle'],
		['Bob', 25, 'Portland'],
		['Carol', 35, 'Denver'],
	];

	it('copies full table with headers when nothing is selected', () => {
		const text = buildClipboardText(cols, rows, null, null);
		expect(text).toBe(
			'Name\tAge\tCity\n' +
			'Alice\t30\tSeattle\n' +
			'Bob\t25\tPortland\n' +
			'Carol\t35\tDenver'
		);
	});

	it('copies single cell value without header when selectedCell is set', () => {
		const text = buildClipboardText(cols, rows, null, { row: 1, col: 0 });
		expect(text).toBe('Bob');
	});

	it('copies single cell value without header for a 1×1 range selection', () => {
		// When a user drags within a single cell, _selectionRange becomes 1×1.
		// The clipboard text should still be just the cell value — no column header.
		const text = buildClipboardText(cols, rows, { rowMin: 0, rowMax: 0, colMin: 1, colMax: 1 }, { row: 0, col: 1 });
		expect(text).toBe('30');
	});

	it('copies multi-cell range with headers', () => {
		const text = buildClipboardText(cols, rows, { rowMin: 0, rowMax: 1, colMin: 0, colMax: 1 }, { row: 0, col: 0 });
		expect(text).toBe(
			'Name\tAge\n' +
			'Alice\t30\n' +
			'Bob\t25'
		);
	});

	it('copies single column range (multiple rows) with header', () => {
		const text = buildClipboardText(cols, rows, { rowMin: 0, rowMax: 2, colMin: 2, colMax: 2 }, { row: 0, col: 2 });
		expect(text).toBe(
			'City\n' +
			'Seattle\n' +
			'Portland\n' +
			'Denver'
		);
	});

	it('copies null/undefined cell values as empty string', () => {
		const nullRows: CellValue[][] = [
			[null, undefined, 'hello'],
		];
		const text = buildClipboardText(cols, nullRows, null, { row: 0, col: 0 });
		expect(text).toBe('');
	});
});
