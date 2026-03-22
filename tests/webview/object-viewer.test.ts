import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../../src/webview/core/utils.js';

import {
	parseMaybeJson as __kustoParseMaybeJson,
	stringifyForSearch as __kustoStringifyForSearch,
	formatScalarForTable as __kustoFormatScalarForTable,
	isComplexValue as __kustoIsComplexValue,
	syntaxHighlightJson as _syntaxHighlightJsonRaw,
	formatJson as _formatJsonRaw,
} from '../../src/webview/shared/viewer-utils.js';

// Bind escapeHtml for the functions that need it.
const syntaxHighlightJson = (obj: unknown, indent = 0) => _syntaxHighlightJsonRaw(obj, indent, escapeHtml);
const formatJson = (json: unknown) => _formatJsonRaw(json, escapeHtml);

// ── __kustoParseMaybeJson ─────────────────────────────────────────────────────

describe('__kustoParseMaybeJson', () => {
	it('parses JSON object string', () => {
		expect(__kustoParseMaybeJson('{"a":1}')).toEqual({ a: 1 });
	});

	it('parses JSON array string', () => {
		expect(__kustoParseMaybeJson('[1,2,3]')).toEqual([1, 2, 3]);
	});

	it('parses "null" string', () => {
		expect(__kustoParseMaybeJson('null')).toBeNull();
	});

	it('parses "true"/"false" strings', () => {
		expect(__kustoParseMaybeJson('true')).toBe(true);
		expect(__kustoParseMaybeJson('false')).toBe(false);
	});

	it('parses numeric string', () => {
		expect(__kustoParseMaybeJson('42')).toBe(42);
		expect(__kustoParseMaybeJson('-3.14')).toBe(-3.14);
	});

	it('parses quoted string', () => {
		expect(__kustoParseMaybeJson('"hello"')).toBe('hello');
	});

	it('returns non-JSON strings as-is', () => {
		expect(__kustoParseMaybeJson('hello world')).toBe('hello world');
	});

	it('returns empty string as-is', () => {
		expect(__kustoParseMaybeJson('')).toBe('');
	});

	it('returns whitespace-only string as-is', () => {
		expect(__kustoParseMaybeJson('   ')).toBe('   ');
	});

	it('passes through non-string values unchanged', () => {
		const obj = { a: 1 };
		expect(__kustoParseMaybeJson(obj)).toBe(obj);
		expect(__kustoParseMaybeJson(42)).toBe(42);
		expect(__kustoParseMaybeJson(null)).toBeNull();
		expect(__kustoParseMaybeJson(undefined)).toBeUndefined();
	});

	it('returns invalid JSON-looking string as-is', () => {
		expect(__kustoParseMaybeJson('{not json}')).toBe('{not json}');
	});
});

// ── __kustoStringifyForSearch ─────────────────────────────────────────────────

describe('__kustoStringifyForSearch', () => {
	it('returns string values unchanged', () => {
		expect(__kustoStringifyForSearch('hello')).toBe('hello');
	});

	it('returns empty string for null', () => {
		expect(__kustoStringifyForSearch(null)).toBe('');
	});

	it('returns empty string for undefined', () => {
		expect(__kustoStringifyForSearch(undefined)).toBe('');
	});

	it('stringifies objects to JSON', () => {
		expect(__kustoStringifyForSearch({ a: 1 })).toBe('{"a":1}');
	});

	it('stringifies arrays to JSON', () => {
		expect(__kustoStringifyForSearch([1, 2])).toBe('[1,2]');
	});

	it('stringifies numbers', () => {
		expect(__kustoStringifyForSearch(42)).toBe('42');
	});

	it('stringifies booleans', () => {
		expect(__kustoStringifyForSearch(true)).toBe('true');
	});
});

// ── __kustoFormatScalarForTable ───────────────────────────────────────────────

describe('__kustoFormatScalarForTable', () => {
	it('formats null as "null"', () => {
		expect(__kustoFormatScalarForTable(null)).toBe('null');
	});

	it('formats undefined as "undefined"', () => {
		expect(__kustoFormatScalarForTable(undefined)).toBe('undefined');
	});

	it('returns strings unchanged', () => {
		expect(__kustoFormatScalarForTable('hello')).toBe('hello');
	});

	it('formats numbers as string', () => {
		expect(__kustoFormatScalarForTable(42)).toBe('42');
		expect(__kustoFormatScalarForTable(3.14)).toBe('3.14');
	});

	it('formats booleans as string', () => {
		expect(__kustoFormatScalarForTable(true)).toBe('true');
		expect(__kustoFormatScalarForTable(false)).toBe('false');
	});

	it('JSON-stringifies objects', () => {
		expect(__kustoFormatScalarForTable({ a: 1 })).toBe('{"a":1}');
	});
});

// ── __kustoIsComplexValue ─────────────────────────────────────────────────────

describe('__kustoIsComplexValue', () => {
	it('returns true for objects', () => {
		expect(__kustoIsComplexValue({ a: 1 })).toBe(true);
		expect(__kustoIsComplexValue([])).toBe(true);
	});

	it('returns true for JSON object strings', () => {
		expect(__kustoIsComplexValue('{"a":1}')).toBe(true);
	});

	it('returns true for JSON array strings', () => {
		expect(__kustoIsComplexValue('[1,2]')).toBe(true);
	});

	it('returns false for simple strings', () => {
		expect(__kustoIsComplexValue('hello')).toBe(false);
	});

	it('returns false for null/undefined', () => {
		expect(__kustoIsComplexValue(null)).toBe(false);
		expect(__kustoIsComplexValue(undefined)).toBe(false);
	});

	it('returns false for numbers/booleans', () => {
		expect(__kustoIsComplexValue(42)).toBe(false);
		expect(__kustoIsComplexValue(true)).toBe(false);
	});
});

// ── syntaxHighlightJson ───────────────────────────────────────────────────────

describe('syntaxHighlightJson', () => {
	it('highlights null', () => {
		expect(syntaxHighlightJson(null)).toBe('<span class="json-null">null</span>');
	});

	it('highlights string', () => {
		expect(syntaxHighlightJson('hello'))
			.toBe('<span class="json-string">"hello"</span>');
	});

	it('highlights number', () => {
		expect(syntaxHighlightJson(42)).toBe('<span class="json-number">42</span>');
	});

	it('highlights boolean', () => {
		expect(syntaxHighlightJson(true)).toBe('<span class="json-boolean">true</span>');
		expect(syntaxHighlightJson(false)).toBe('<span class="json-boolean">false</span>');
	});

	it('renders empty object', () => {
		expect(syntaxHighlightJson({})).toBe('{}');
	});

	it('renders empty array', () => {
		expect(syntaxHighlightJson([])).toBe('[]');
	});

	it('renders object with keys', () => {
		const result = syntaxHighlightJson({ a: 1 });
		expect(result).toContain('<span class="json-key">"a"</span>');
		expect(result).toContain('<span class="json-number">1</span>');
		expect(result).toContain('{\n');
		expect(result).toContain('}');
	});

	it('renders array with items', () => {
		const result = syntaxHighlightJson([1, 'x']);
		expect(result).toContain('<span class="json-number">1</span>');
		expect(result).toContain('<span class="json-string">"x"</span>');
	});

	it('escapes HTML in keys and string values', () => {
		const result = syntaxHighlightJson({ '<script>': '<b>xss</b>' });
		expect(result).toContain('&lt;script&gt;');
		expect(result).toContain('&lt;b&gt;xss&lt;/b&gt;');
	});

	it('handles nested objects', () => {
		const result = syntaxHighlightJson({ outer: { inner: 1 } });
		expect(result).toContain('json-key');
		expect(result).toContain('json-number');
	});
});

// ── formatJson ────────────────────────────────────────────────────────────────

describe('formatJson', () => {
	it('formats JSON string', () => {
		const result = formatJson('{"a":1}');
		expect(result).toContain('json-key');
		expect(result).toContain('json-number');
	});

	it('formats raw object', () => {
		const result = formatJson({ b: 'hello' });
		expect(result).toContain('json-key');
		expect(result).toContain('json-string');
	});

	it('falls back to escaped string for invalid JSON', () => {
		const result = formatJson('not json');
		expect(result).toContain('json-string');
		expect(result).toContain('not json');
	});

	it('handles null', () => {
		const result = formatJson(null);
		expect(result).toContain('json-null');
	});
});
