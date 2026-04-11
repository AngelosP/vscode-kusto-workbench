import { describe, it, expect } from 'vitest';
import {
	normalizeCellForComparison,
	rowKeyForComparison,
	normalizeColumnNameForComparison,
	getNormalizedColumnNameList,
	doColumnHeaderNamesMatch,
	getColumnDifferences,
	doColumnOrderMatch,
	doRowOrderMatch,
	buildColumnIndexMapForNames,
	buildNameBasedColumnMapping,
	rowKeyForComparisonWithColumnMapping,
	rowKeyForComparisonIgnoringColumnOrder,
	areResultsEquivalentWithDetails,
	areResultsEquivalent,
	doResultHeadersMatch,
	indexToAlphaName,
	getRunModeLabelText,
	formatElapsed,
	isValidConnectionIdForRun,
} from '../../src/webview/shared/comparisonUtils';

// ── normalizeCellForComparison ────────────────────────────────────────────

describe('normalizeCellForComparison', () => {
	it('normalizes null', () => {
		expect(normalizeCellForComparison(null)).toEqual(['n', null]);
	});

	it('normalizes undefined', () => {
		expect(normalizeCellForComparison(undefined)).toEqual(['n', null]);
	});

	it('normalizes number', () => {
		expect(normalizeCellForComparison(42)).toEqual(['num', 42]);
	});

	it('normalizes Infinity as string', () => {
		expect(normalizeCellForComparison(Infinity)).toEqual(['num', 'Infinity']);
	});

	it('normalizes boolean true', () => {
		expect(normalizeCellForComparison(true)).toEqual(['bool', 1]);
	});

	it('normalizes boolean false', () => {
		expect(normalizeCellForComparison(false)).toEqual(['bool', 0]);
	});

	it('normalizes numeric string', () => {
		expect(normalizeCellForComparison('42')).toEqual(['num', 42]);
	});

	it('normalizes string with commas as numeric', () => {
		expect(normalizeCellForComparison('1,234')).toEqual(['num', 1234]);
	});

	it('normalizes plain string', () => {
		expect(normalizeCellForComparison('hello')).toEqual(['str', 'hello']);
	});

	it('normalizes ISO date string', () => {
		const result = normalizeCellForComparison('2024-01-15T10:30:00Z');
		expect(result[0]).toBe('date');
		expect(typeof result[1]).toBe('number');
	});

	it('unwraps {full} wrapper', () => {
		expect(normalizeCellForComparison({ full: 42, display: '42' })).toEqual(['num', 42]);
	});

	it('unwraps {display} wrapper', () => {
		expect(normalizeCellForComparison({ display: 'hello' })).toEqual(['str', 'hello']);
	});

	it('handles objects as JSON', () => {
		const result = normalizeCellForComparison({ key: 'val' });
		expect(result[0]).toBe('obj');
	});
});

// ── rowKeyForComparison ───────────────────────────────────────────────────

describe('rowKeyForComparison', () => {
	it('returns JSON of normalized cells', () => {
		const key = rowKeyForComparison([1, 'hello', null]);
		expect(typeof key).toBe('string');
		const parsed = JSON.parse(key);
		expect(parsed).toHaveLength(3);
	});

	it('produces same key for equivalent data', () => {
		const a = rowKeyForComparison([42, 'hello']);
		const b = rowKeyForComparison([42, 'hello']);
		expect(a).toBe(b);
	});

	it('produces different keys for different data', () => {
		const a = rowKeyForComparison([1, 'a']);
		const b = rowKeyForComparison([2, 'b']);
		expect(a).not.toBe(b);
	});

	it('handles empty array', () => {
		expect(rowKeyForComparison([])).toBe('[]');
	});
});

// ── normalizeColumnNameForComparison ──────────────────────────────────────

describe('normalizeColumnNameForComparison', () => {
	it('lowercases string column name', () => {
		expect(normalizeColumnNameForComparison('MyColumn')).toBe('mycolumn');
	});

	it('extracts name from {name, type} object', () => {
		expect(normalizeColumnNameForComparison({ name: 'MyCol', type: 'string' })).toBe('mycol');
	});

	it('handles null', () => {
		expect(normalizeColumnNameForComparison(null)).toBe('');
	});

	it('trims whitespace', () => {
		expect(normalizeColumnNameForComparison('  col  ')).toBe('col');
	});
});

// ── getNormalizedColumnNameList ────────────────────────────────────────────

describe('getNormalizedColumnNameList', () => {
	it('returns normalized names', () => {
		const state = { columns: ['A', 'B', 'C'] };
		expect(getNormalizedColumnNameList(state)).toEqual(['a', 'b', 'c']);
	});

	it('handles {name, type} columns', () => {
		const state = { columns: [{ name: 'A', type: 'string' }, { name: 'B', type: 'int' }] };
		expect(getNormalizedColumnNameList(state)).toEqual(['a', 'b']);
	});

	it('returns empty for null state', () => {
		expect(getNormalizedColumnNameList(null)).toEqual([]);
	});
});

// ── doColumnHeaderNamesMatch ──────────────────────────────────────────────

describe('doColumnHeaderNamesMatch', () => {
	it('returns true for matching columns regardless of order', () => {
		const a = { columns: ['A', 'B', 'C'] };
		const b = { columns: ['C', 'A', 'B'] };
		expect(doColumnHeaderNamesMatch(a, b)).toBe(true);
	});

	it('returns true for matching columns case-insensitively', () => {
		const a = { columns: ['Name', 'Value'] };
		const b = { columns: ['name', 'value'] };
		expect(doColumnHeaderNamesMatch(a, b)).toBe(true);
	});

	it('returns false for different column count', () => {
		const a = { columns: ['A', 'B'] };
		const b = { columns: ['A'] };
		expect(doColumnHeaderNamesMatch(a, b)).toBe(false);
	});

	it('returns false for different column names', () => {
		const a = { columns: ['A', 'B'] };
		const b = { columns: ['A', 'C'] };
		expect(doColumnHeaderNamesMatch(a, b)).toBe(false);
	});
});

// ── getColumnDifferences ──────────────────────────────────────────────────

describe('getColumnDifferences', () => {
	it('returns empty arrays for identical columns', () => {
		const a = { columns: ['Name', 'Value'] };
		const b = { columns: ['Name', 'Value'] };
		const result = getColumnDifferences(a, b);
		expect(result.onlyInA).toEqual([]);
		expect(result.onlyInB).toEqual([]);
	});

	it('detects columns only in source', () => {
		const a = { columns: ['Name', 'Extra'] };
		const b = { columns: ['Name'] };
		const result = getColumnDifferences(a, b);
		expect(result.onlyInA).toEqual(['Extra']);
		expect(result.onlyInB).toEqual([]);
	});

	it('detects columns only in comparison', () => {
		const a = { columns: ['Name'] };
		const b = { columns: ['Name', 'Extra'] };
		const result = getColumnDifferences(a, b);
		expect(result.onlyInA).toEqual([]);
		expect(result.onlyInB).toEqual(['Extra']);
	});
});

// ── doColumnOrderMatch ────────────────────────────────────────────────────

describe('doColumnOrderMatch', () => {
	it('returns true for same order', () => {
		const a = { columns: ['A', 'B', 'C'] };
		const b = { columns: ['A', 'B', 'C'] };
		expect(doColumnOrderMatch(a, b)).toBe(true);
	});

	it('returns false for different order', () => {
		const a = { columns: ['A', 'B', 'C'] };
		const b = { columns: ['A', 'C', 'B'] };
		expect(doColumnOrderMatch(a, b)).toBe(false);
	});

	it('case-insensitive matching', () => {
		const a = { columns: ['Name'] };
		const b = { columns: ['name'] };
		expect(doColumnOrderMatch(a, b)).toBe(true);
	});
});

// ── buildColumnIndexMapForNames ───────────────────────────────────────────

describe('buildColumnIndexMapForNames', () => {
	it('maps column names to indices', () => {
		const state = { columns: ['A', 'B', 'A'] };
		const map = buildColumnIndexMapForNames(state);
		expect(map.get('a')).toEqual([0, 2]);
		expect(map.get('b')).toEqual([1]);
	});
});

// ── buildNameBasedColumnMapping ───────────────────────────────────────────

describe('buildNameBasedColumnMapping', () => {
	it('builds index mapping from canonical names', () => {
		const state = { columns: ['B', 'A', 'C'] };
		const canonical = ['a', 'b', 'c'];
		const mapping = buildNameBasedColumnMapping(state, canonical);
		expect(mapping).toEqual([1, 0, 2]);
	});
});

// ── doRowOrderMatch ───────────────────────────────────────────────────────

describe('doRowOrderMatch', () => {
	it('returns true for identical data', () => {
		const a = { columns: ['x', 'y'], rows: [[1, 2], [3, 4]] };
		const b = { columns: ['x', 'y'], rows: [[1, 2], [3, 4]] };
		expect(doRowOrderMatch(a, b)).toBe(true);
	});

	it('returns false for different row order', () => {
		const a = { columns: ['x', 'y'], rows: [[1, 2], [3, 4]] };
		const b = { columns: ['x', 'y'], rows: [[3, 4], [1, 2]] };
		expect(doRowOrderMatch(a, b)).toBe(false);
	});

	it('matches with reordered columns', () => {
		const a = { columns: ['x', 'y'], rows: [[1, 2], [3, 4]] };
		const b = { columns: ['y', 'x'], rows: [[2, 1], [4, 3]] };
		expect(doRowOrderMatch(a, b)).toBe(true);
	});
});

// ── areResultsEquivalentWithDetails ───────────────────────────────────────

describe('areResultsEquivalentWithDetails', () => {
	it('detects identical results', () => {
		const s = { columns: ['a'], rows: [[1], [2]] };
		const result = areResultsEquivalentWithDetails(s, s);
		expect(result.dataMatches).toBe(true);
		expect(result.rowOrderMatches).toBe(true);
		expect(result.columnOrderMatches).toBe(true);
	});

	it('detects column count mismatch', () => {
		const a = { columns: ['a', 'b'], rows: [] };
		const b = { columns: ['a'], rows: [] };
		const result = areResultsEquivalentWithDetails(a, b);
		expect(result.dataMatches).toBe(false);
		expect(result.reason).toBe('columnCountMismatch');
	});

	it('detects row count mismatch', () => {
		const a = { columns: ['a'], rows: [[1], [2]] };
		const b = { columns: ['a'], rows: [[1]] };
		const result = areResultsEquivalentWithDetails(a, b);
		expect(result.dataMatches).toBe(false);
		expect(result.reason).toBe('rowCountMismatch');
	});

	it('matches data with different row order', () => {
		const a = { columns: ['a'], rows: [[1], [2], [3]] };
		const b = { columns: ['a'], rows: [[3], [1], [2]] };
		const result = areResultsEquivalentWithDetails(a, b);
		expect(result.dataMatches).toBe(true);
		expect(result.rowOrderMatches).toBe(false);
	});

	it('matches data with different column order', () => {
		const a = { columns: ['x', 'y'], rows: [[1, 2]] };
		const b = { columns: ['y', 'x'], rows: [[2, 1]] };
		const result = areResultsEquivalentWithDetails(a, b);
		expect(result.dataMatches).toBe(true);
		expect(result.columnOrderMatches).toBe(false);
	});

	it('detects data mismatch', () => {
		const a = { columns: ['a'], rows: [[1], [2]] };
		const b = { columns: ['a'], rows: [[1], [3]] };
		const result = areResultsEquivalentWithDetails(a, b);
		expect(result.dataMatches).toBe(false);
	});
});

// ── areResultsEquivalent ──────────────────────────────────────────────────

describe('areResultsEquivalent', () => {
	it('returns true for equivalent results', () => {
		const s = { columns: ['a'], rows: [[1]] };
		expect(areResultsEquivalent(s, s)).toBe(true);
	});

	it('returns false for different results', () => {
		const a = { columns: ['a'], rows: [[1]] };
		const b = { columns: ['a'], rows: [[2]] };
		expect(areResultsEquivalent(a, b)).toBe(false);
	});
});

// ── doResultHeadersMatch ──────────────────────────────────────────────────

describe('doResultHeadersMatch', () => {
	it('returns true for exact match', () => {
		const a = { columns: ['A', 'B'] };
		const b = { columns: ['A', 'B'] };
		expect(doResultHeadersMatch(a, b)).toBe(true);
	});

	it('returns false for case mismatch (strict)', () => {
		const a = { columns: ['A'] };
		const b = { columns: ['a'] };
		expect(doResultHeadersMatch(a, b)).toBe(false);
	});

	it('returns false for different count', () => {
		const a = { columns: ['A', 'B'] };
		const b = { columns: ['A'] };
		expect(doResultHeadersMatch(a, b)).toBe(false);
	});
});

// ── indexToAlphaName ──────────────────────────────────────────────────────

describe('indexToAlphaName', () => {
	it('converts 0 to A', () => {
		expect(indexToAlphaName(0)).toBe('A');
	});

	it('converts 25 to Z', () => {
		expect(indexToAlphaName(25)).toBe('Z');
	});

	it('converts 26 to AA', () => {
		expect(indexToAlphaName(26)).toBe('AA');
	});

	it('converts 27 to AB', () => {
		expect(indexToAlphaName(27)).toBe('AB');
	});

	it('converts 51 to AZ', () => {
		expect(indexToAlphaName(51)).toBe('AZ');
	});

	it('converts 52 to BA', () => {
		expect(indexToAlphaName(52)).toBe('BA');
	});

	it('handles negative as 0', () => {
		expect(indexToAlphaName(-5)).toBe('A');
	});

	it('handles non-numeric as A', () => {
		expect(indexToAlphaName('foo')).toBe('A');
	});
});

// ── getRunModeLabelText ───────────────────────────────────────────────────

describe('getRunModeLabelText', () => {
	it('returns correct text for plain mode', () => {
		expect(getRunModeLabelText('plain')).toBe('Run Query');
	});

	it('returns correct text for take100 mode', () => {
		expect(getRunModeLabelText('take100')).toBe('Run Query (take 100)');
	});

	it('returns correct text for sample100 mode', () => {
		expect(getRunModeLabelText('sample100')).toBe('Run Query (sample 100)');
	});

	it('returns correct text for runFunction mode', () => {
		expect(getRunModeLabelText('runFunction')).toBe('Run Function');
	});

	it('defaults to take100 for unknown', () => {
		expect(getRunModeLabelText('')).toBe('Run Query (take 100)');
	});

	it('case-insensitive', () => {
		expect(getRunModeLabelText('PLAIN')).toBe('Run Query');
	});
});

// ── formatElapsed ─────────────────────────────────────────────────────────

describe('formatElapsed', () => {
	it('formats 0ms', () => {
		expect(formatElapsed(0)).toBe('0:00');
	});

	it('formats under a minute', () => {
		expect(formatElapsed(5000)).toBe('0:05');
	});

	it('formats over a minute', () => {
		expect(formatElapsed(65000)).toBe('1:05');
	});

	it('pads seconds', () => {
		expect(formatElapsed(3000)).toBe('0:03');
	});

	it('handles negative as 0:00', () => {
		expect(formatElapsed(-100)).toBe('0:00');
	});

	it('handles non-numeric as 0:00', () => {
		expect(formatElapsed('nope')).toBe('0:00');
	});
});

// ── isValidConnectionIdForRun ─────────────────────────────────────────────

describe('isValidConnectionIdForRun', () => {
	it('returns false for empty', () => {
		expect(isValidConnectionIdForRun('')).toBe(false);
	});

	it('returns false for __prompt__', () => {
		expect(isValidConnectionIdForRun('__prompt__')).toBe(false);
	});

	it('returns false for __enter_new__', () => {
		expect(isValidConnectionIdForRun('__enter_new__')).toBe(false);
	});

	it('returns false for __import_xml__', () => {
		expect(isValidConnectionIdForRun('__import_xml__')).toBe(false);
	});

	it('returns true for valid ID', () => {
		expect(isValidConnectionIdForRun('conn_123')).toBe(true);
	});
});

// ── rowKeyForComparisonIgnoringColumnOrder ─────────────────────────────────

describe('rowKeyForComparisonIgnoringColumnOrder', () => {
	it('produces same key regardless of cell order', () => {
		const a = rowKeyForComparisonIgnoringColumnOrder([1, 'hello']);
		const b = rowKeyForComparisonIgnoringColumnOrder(['hello', 1]);
		expect(a).toBe(b);
	});
});
