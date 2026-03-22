import { describe, it, expect } from 'vitest';
import { escapeHtml, escapeRegex } from '../../src/webview/core/utils.js';

// ── escapeHtml ────────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
	it('escapes angle brackets', () => {
		expect(escapeHtml('<div>')).toBe('&lt;div&gt;');
	});

	it('escapes ampersand', () => {
		expect(escapeHtml('a & b')).toBe('a &amp; b');
	});

	it('does not escape double quotes (div innerHTML behaviour)', () => {
		// DOM textContent→innerHTML does not escape quotes
		expect(escapeHtml('"hello"')).toBe('"hello"');
	});

	it('leaves plain text unchanged', () => {
		expect(escapeHtml('hello world')).toBe('hello world');
	});

	it('handles empty string', () => {
		expect(escapeHtml('')).toBe('');
	});

	it('escapes multiple entities in one string', () => {
		expect(escapeHtml('<script>alert("xss")</script>'))
			.toBe('&lt;script&gt;alert("xss")&lt;/script&gt;');
	});

	it('does not double-escape', () => {
		expect(escapeHtml('&amp;')).toBe('&amp;amp;');
	});
});

// ── escapeRegex ───────────────────────────────────────────────────────────────

describe('escapeRegex', () => {
	it('escapes dot', () => {
		expect(escapeRegex('file.txt')).toBe('file\\.txt');
	});

	it('escapes all regex special chars', () => {
		const special = '-/\\^$*+?.()|[]{}';
		const escaped = escapeRegex(special);
		// All special chars should be preceded by backslash
		expect(escaped).toBe('\\-\\/\\\\\\^\\$\\*\\+\\?\\.\\(\\)\\|\\[\\]\\{\\}');
	});

	it('leaves plain text unchanged', () => {
		expect(escapeRegex('hello')).toBe('hello');
	});

	it('handles empty string', () => {
		expect(escapeRegex('')).toBe('');
	});

	it('escaped string works as regex literal', () => {
		const literal = 'price is $9.99 (USD)';
		const regex = new RegExp(escapeRegex(literal));
		expect(regex.test(literal)).toBe(true);
		expect(regex.test('price is X999 XUSDX')).toBe(false);
	});
});
