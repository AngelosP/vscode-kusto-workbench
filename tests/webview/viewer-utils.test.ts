import { describe, it, expect } from 'vitest';
import {
	getColumnName,
	parseMaybeJson,
	stringifyForSearch,
	formatScalarForTable,
	isComplexValue,
	syntaxHighlightJson,
	formatJson,
} from '../../src/webview/shared/viewer-utils';

// ── parseMaybeJson ────────────────────────────────────────────────────────────

describe('parseMaybeJson', () => {
	it('parses a JSON object string', () => {
		expect(parseMaybeJson('{"a":1}')).toEqual({ a: 1 });
	});

	it('parses a JSON array string', () => {
		expect(parseMaybeJson('[1,2,3]')).toEqual([1, 2, 3]);
	});

	it('parses "null"', () => {
		expect(parseMaybeJson('null')).toBeNull();
	});

	it('parses "true" and "false"', () => {
		expect(parseMaybeJson('true')).toBe(true);
		expect(parseMaybeJson('false')).toBe(false);
	});

	it('parses a numeric string', () => {
		expect(parseMaybeJson('42')).toBe(42);
		expect(parseMaybeJson('-3.14')).toBe(-3.14);
	});

	it('parses a quoted JSON string', () => {
		expect(parseMaybeJson('"hello"')).toBe('hello');
	});

	it('returns the original string if not valid JSON', () => {
		expect(parseMaybeJson('not json')).toBe('not json');
	});

	it('returns the original string for partial JSON', () => {
		expect(parseMaybeJson('{broken')).toBe('{broken');
	});

	it('returns the original value for non-string input', () => {
		expect(parseMaybeJson(42)).toBe(42);
		expect(parseMaybeJson(null)).toBeNull();
		expect(parseMaybeJson(undefined)).toBeUndefined();
		expect(parseMaybeJson(true)).toBe(true);
	});

	it('returns the original for empty string', () => {
		expect(parseMaybeJson('')).toBe('');
	});

	it('returns the original for whitespace-only string', () => {
		expect(parseMaybeJson('   ')).toBe('   ');
	});

	it('handles leading whitespace before JSON', () => {
		expect(parseMaybeJson('  {"a":1}')).toEqual({ a: 1 });
	});

	it('returns string that does not start with a JSON prefix', () => {
		expect(parseMaybeJson('hello world')).toBe('hello world');
	});
});

// ── stringifyForSearch ────────────────────────────────────────────────────────

describe('stringifyForSearch', () => {
	it('returns empty string for null', () => {
		expect(stringifyForSearch(null)).toBe('');
	});

	it('returns empty string for undefined', () => {
		expect(stringifyForSearch(undefined)).toBe('');
	});

	it('returns string values as-is', () => {
		expect(stringifyForSearch('hello')).toBe('hello');
	});

	it('returns empty string for empty string', () => {
		expect(stringifyForSearch('')).toBe('');
	});

	it('JSON-stringifies numbers', () => {
		expect(stringifyForSearch(42)).toBe('42');
	});

	it('JSON-stringifies booleans', () => {
		expect(stringifyForSearch(true)).toBe('true');
	});

	it('JSON-stringifies objects', () => {
		expect(stringifyForSearch({ a: 1 })).toBe('{"a":1}');
	});

	it('JSON-stringifies arrays', () => {
		expect(stringifyForSearch([1, 2])).toBe('[1,2]');
	});
});

// ── formatScalarForTable ──────────────────────────────────────────────────────

describe('formatScalarForTable', () => {
	it('returns "null" for null', () => {
		expect(formatScalarForTable(null)).toBe('null');
	});

	it('returns "undefined" for undefined', () => {
		expect(formatScalarForTable(undefined)).toBe('undefined');
	});

	it('returns string values as-is', () => {
		expect(formatScalarForTable('hello')).toBe('hello');
	});

	it('converts numbers to string', () => {
		expect(formatScalarForTable(42)).toBe('42');
		expect(formatScalarForTable(3.14)).toBe('3.14');
	});

	it('converts booleans to string', () => {
		expect(formatScalarForTable(true)).toBe('true');
		expect(formatScalarForTable(false)).toBe('false');
	});

	it('JSON-stringifies objects', () => {
		expect(formatScalarForTable({ a: 1 })).toBe('{"a":1}');
	});

	it('JSON-stringifies arrays', () => {
		expect(formatScalarForTable([1, 2])).toBe('[1,2]');
	});
});

// ── isComplexValue ────────────────────────────────────────────────────────────

describe('isComplexValue', () => {
	it('returns false for null', () => {
		expect(isComplexValue(null)).toBe(false);
	});

	it('returns false for undefined', () => {
		expect(isComplexValue(undefined)).toBe(false);
	});

	it('returns false for plain strings', () => {
		expect(isComplexValue('hello')).toBe(false);
	});

	it('returns true for string that looks like JSON object', () => {
		expect(isComplexValue('{"a":1}')).toBe(true);
	});

	it('returns true for string that looks like JSON array', () => {
		expect(isComplexValue('[1,2,3]')).toBe(true);
	});

	it('returns true for string with leading whitespace before {', () => {
		expect(isComplexValue('  { "a": 1 }')).toBe(true);
	});

	it('returns true for objects', () => {
		expect(isComplexValue({ a: 1 })).toBe(true);
	});

	it('returns true for arrays', () => {
		expect(isComplexValue([1, 2])).toBe(true);
	});

	it('returns true for Date objects', () => {
		expect(isComplexValue(new Date())).toBe(true);
	});

	it('returns false for numbers', () => {
		expect(isComplexValue(42)).toBe(false);
	});

	it('returns false for booleans', () => {
		expect(isComplexValue(true)).toBe(false);
	});
});

// ── getColumnName ─────────────────────────────────────────────────────────────

describe('getColumnName', () => {
	it('returns column name from string array', () => {
		const state = { columns: ['Name', 'Age', 'City'] };
		expect(getColumnName(state, 0)).toBe('Name');
		expect(getColumnName(state, 2)).toBe('City');
	});

	it('returns column.name from object array', () => {
		const state = { columns: [{ name: 'Name' }, { name: 'Age' }] };
		expect(getColumnName(state, 0)).toBe('Name');
	});

	it('returns column.columnName if name is missing', () => {
		const state = { columns: [{ columnName: 'MyCol' }] };
		expect(getColumnName(state, 0)).toBe('MyCol');
	});

	it('returns column.displayName as fallback', () => {
		const state = { columns: [{ displayName: 'Display' }] };
		expect(getColumnName(state, 0)).toBe('Display');
	});

	it('returns fallback for out-of-bounds index', () => {
		const state = { columns: ['Name'] };
		expect(getColumnName(state, 5)).toBe('column 6');
	});

	it('returns fallback for null state', () => {
		expect(getColumnName(null, 0)).toBe('column 1');
	});

	it('returns fallback for state without columns', () => {
		expect(getColumnName({}, 0)).toBe('column 1');
	});

	it('returns fallback for undefined state', () => {
		expect(getColumnName(undefined, 3)).toBe('column 4');
	});

	it('returns fallback for column object with empty name', () => {
		const state = { columns: [{ name: '' }] };
		expect(getColumnName(state, 0)).toBe('column 1');
	});
});

// ── syntaxHighlightJson ───────────────────────────────────────────────────────

describe('syntaxHighlightJson', () => {
	it('highlights null', () => {
		expect(syntaxHighlightJson(null)).toBe('<span class="json-null">null</span>');
	});

	it('highlights strings', () => {
		expect(syntaxHighlightJson('hello')).toBe('<span class="json-string">"hello"</span>');
	});

	it('highlights numbers', () => {
		expect(syntaxHighlightJson(42)).toBe('<span class="json-number">42</span>');
	});

	it('highlights booleans', () => {
		expect(syntaxHighlightJson(true)).toBe('<span class="json-boolean">true</span>');
		expect(syntaxHighlightJson(false)).toBe('<span class="json-boolean">false</span>');
	});

	it('highlights empty array as []', () => {
		expect(syntaxHighlightJson([])).toBe('[]');
	});

	it('highlights empty object as {}', () => {
		expect(syntaxHighlightJson({})).toBe('{}');
	});

	it('highlights array with elements', () => {
		const result = syntaxHighlightJson([1, 'a']);
		expect(result).toContain('<span class="json-number">1</span>');
		expect(result).toContain('<span class="json-string">"a"</span>');
		expect(result).toContain('[');
		expect(result).toContain(']');
	});

	it('highlights object with keys', () => {
		const result = syntaxHighlightJson({ key: 'val' });
		expect(result).toContain('<span class="json-key">"key"</span>');
		expect(result).toContain('<span class="json-string">"val"</span>');
	});

	it('uses custom escapeHtml function', () => {
		const esc = (s: string) => s.replace(/</g, '&lt;');
		const result = syntaxHighlightJson('<script>', 0, esc);
		expect(result).toContain('&lt;script>');
		expect(result).not.toContain('<script>');
	});

	it('handles nested objects', () => {
		const result = syntaxHighlightJson({ a: { b: 1 } });
		expect(result).toContain('<span class="json-key">"a"</span>');
		expect(result).toContain('<span class="json-key">"b"</span>');
		expect(result).toContain('<span class="json-number">1</span>');
	});

	it('handles undefined values via String()', () => {
		const result = syntaxHighlightJson(undefined);
		expect(result).toBe('undefined');
	});
});

// ── formatJson ────────────────────────────────────────────────────────────────

describe('formatJson', () => {
	it('parses a JSON string and highlights it', () => {
		const result = formatJson('{"a":1}');
		expect(result).toContain('<span class="json-key">"a"</span>');
		expect(result).toContain('<span class="json-number">1</span>');
	});

	it('highlights non-string values directly', () => {
		const result = formatJson({ a: 1 });
		expect(result).toContain('<span class="json-key">"a"</span>');
	});

	it('wraps invalid JSON in json-string span', () => {
		const result = formatJson('{broken');
		expect(result).toContain('<span class="json-string">{broken</span>');
	});

	it('uses custom escapeHtml for malformed JSON', () => {
		const esc = (s: string) => s.replace(/</g, '&lt;');
		const result = formatJson('<bad>', esc);
		expect(result).toContain('&lt;bad>');
	});

	it('handles null input', () => {
		const result = formatJson(null);
		expect(result).toBe('<span class="json-null">null</span>');
	});

	it('handles numeric input', () => {
		const result = formatJson(42);
		expect(result).toBe('<span class="json-number">42</span>');
	});
});
