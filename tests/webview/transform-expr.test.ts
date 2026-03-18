import { describe, it, expect } from 'vitest';
import {
	tryParseFiniteNumber,
	tryParseDate,
	formatDate,
	getRawCellValue,
	tokenizeExpr,
	parseExprToRpn,
	evalRpn,
} from '../../src/webview/shared/transform-expr';

// ── tryParseFiniteNumber ──────────────────────────────────────────────────────

describe('tryParseFiniteNumber', () => {
	it('parses numbers', () => {
		expect(tryParseFiniteNumber(42)).toBe(42);
		expect(tryParseFiniteNumber(3.14)).toBe(3.14);
		expect(tryParseFiniteNumber(-10)).toBe(-10);
	});
	it('parses numeric strings', () => {
		expect(tryParseFiniteNumber('42')).toBe(42);
		expect(tryParseFiniteNumber('3.14')).toBe(3.14);
	});
	it('returns null for non-numeric', () => {
		expect(tryParseFiniteNumber('abc')).toBe(null);
		expect(tryParseFiniteNumber(NaN)).toBe(null);
		expect(tryParseFiniteNumber(Infinity)).toBe(null);
	});
	it('returns 0 for null (Number(null) === 0)', () => {
		expect(tryParseFiniteNumber(null)).toBe(0);
		expect(tryParseFiniteNumber(undefined)).toBe(null);
	});
	it('handles zero', () => {
		expect(tryParseFiniteNumber(0)).toBe(0);
		expect(tryParseFiniteNumber('0')).toBe(0);
	});
});

// ── tryParseDate ──────────────────────────────────────────────────────────────

describe('tryParseDate', () => {
	it('returns null for null/undefined', () => {
		expect(tryParseDate(null)).toBe(null);
		expect(tryParseDate(undefined)).toBe(null);
	});
	it('parses Date objects', () => {
		const d = new Date('2024-01-15');
		expect(tryParseDate(d)).toBe(d);
	});
	it('returns null for invalid Date', () => {
		expect(tryParseDate(new Date('invalid'))).toBe(null);
	});
	it('parses ISO date strings', () => {
		const d = tryParseDate('2024-01-15T10:30:00Z');
		expect(d).toBeInstanceOf(Date);
		expect(d!.getUTCFullYear()).toBe(2024);
	});
	it('returns null for non-date strings', () => {
		expect(tryParseDate('not a date')).toBe(null);
	});
});

// ── formatDate ────────────────────────────────────────────────────────────────

describe('formatDate', () => {
	it('formats yyyy-MM-dd', () => {
		const d = new Date(2024, 0, 15); // Jan 15, 2024
		expect(formatDate(d, 'yyyy-MM-dd')).toBe('2024-01-15');
	});
	it('formats HH:mm:ss', () => {
		const d = new Date(2024, 0, 1, 14, 5, 9);
		expect(formatDate(d, 'HH:mm:ss')).toBe('14:05:09');
	});
	it('returns null for non-Date', () => {
		expect(formatDate(null as any, 'yyyy')).toBe(null);
	});
	it('formats 12-hour time', () => {
		const d = new Date(2024, 0, 1, 15, 30, 0);
		expect(formatDate(d, 'hh:mm')).toBe('03:30');
	});
});

// ── getRawCellValue ───────────────────────────────────────────────────────────

describe('getRawCellValue', () => {
	it('returns full if present', () => {
		expect(getRawCellValue({ full: 'foo', display: 'bar' })).toBe('foo');
	});
	it('returns display if no full', () => {
		expect(getRawCellValue({ display: 'bar' })).toBe('bar');
	});
	it('returns value directly for primitives', () => {
		expect(getRawCellValue(42)).toBe(42);
		expect(getRawCellValue('hello')).toBe('hello');
		expect(getRawCellValue(null)).toBe(null);
	});
});

// ── tokenizeExpr ──────────────────────────────────────────────────────────────

describe('tokenizeExpr', () => {
	it('tokenizes numbers', () => {
		const tokens = tokenizeExpr('42');
		expect(tokens).toEqual([{ t: 'num', v: 42 }]);
	});
	it('tokenizes operators', () => {
		const tokens = tokenizeExpr('1 + 2');
		expect(tokens).toEqual([
			{ t: 'num', v: 1 },
			{ t: 'op', v: '+' },
			{ t: 'num', v: 2 },
		]);
	});
	it('tokenizes column references [col]', () => {
		const tokens = tokenizeExpr('[MyColumn]');
		expect(tokens).toEqual([{ t: 'col', v: 'MyColumn' }]);
	});
	it('tokenizes string literals', () => {
		const tokens = tokenizeExpr('"hello"');
		expect(tokens).toEqual([{ t: 'str', v: 'hello' }]);
	});
	it('tokenizes function calls', () => {
		const tokens = tokenizeExpr('round(3.14, 1)');
		expect(tokens).toEqual([
			{ t: 'id', v: 'round' },
			{ t: 'op', v: '(' },
			{ t: 'num', v: 3.14 },
			{ t: 'op', v: ',' },
			{ t: 'num', v: 1 },
			{ t: 'op', v: ')' },
		]);
	});
	it('tokenizes identifiers as column refs', () => {
		const tokens = tokenizeExpr('colA + colB');
		expect(tokens).toEqual([
			{ t: 'id', v: 'colA' },
			{ t: 'op', v: '+' },
			{ t: 'id', v: 'colB' },
		]);
	});
	it('throws on unclosed bracket', () => {
		expect(() => tokenizeExpr('[unclosed')).toThrow('Unclosed [column] reference');
	});
	it('throws on unclosed string', () => {
		expect(() => tokenizeExpr('"unclosed')).toThrow('Unclosed string literal');
	});
	it('handles escaped characters in strings', () => {
		const tokens = tokenizeExpr('"he\\"llo"');
		expect(tokens[0].v).toBe('he"llo');
	});
	it('handles decimal numbers starting with dot', () => {
		const tokens = tokenizeExpr('.5');
		expect(tokens).toEqual([{ t: 'num', v: 0.5 }]);
	});
});

// ── parseExprToRpn ────────────────────────────────────────────────────────────

describe('parseExprToRpn', () => {
	it('converts simple addition to RPN', () => {
		const tokens = tokenizeExpr('1 + 2');
		const rpn = parseExprToRpn(tokens);
		expect(rpn).toEqual([
			{ t: 'num', v: 1 },
			{ t: 'num', v: 2 },
			{ t: 'op', v: '+' },
		]);
	});
	it('respects multiplication precedence', () => {
		const tokens = tokenizeExpr('1 + 2 * 3');
		const rpn = parseExprToRpn(tokens);
		// RPN: 1 2 3 * +
		expect(rpn).toEqual([
			{ t: 'num', v: 1 },
			{ t: 'num', v: 2 },
			{ t: 'num', v: 3 },
			{ t: 'op', v: '*' },
			{ t: 'op', v: '+' },
		]);
	});
	it('handles parentheses', () => {
		const tokens = tokenizeExpr('(1 + 2) * 3');
		const rpn = parseExprToRpn(tokens);
		expect(rpn).toEqual([
			{ t: 'num', v: 1 },
			{ t: 'num', v: 2 },
			{ t: 'op', v: '+' },
			{ t: 'num', v: 3 },
			{ t: 'op', v: '*' },
		]);
	});
	it('handles unary minus', () => {
		const tokens = tokenizeExpr('-5');
		const rpn = parseExprToRpn(tokens);
		expect(rpn).toEqual([
			{ t: 'num', v: 5 },
			{ t: 'op', v: 'u-' },
		]);
	});
	it('handles function calls', () => {
		const tokens = tokenizeExpr('round(3.14, 1)');
		const rpn = parseExprToRpn(tokens);
		expect(rpn).toEqual([
			{ t: 'num', v: 3.14 },
			{ t: 'num', v: 1 },
			{ t: 'fn', v: 'round' },
		]);
	});
	it('treats bare identifiers as column refs', () => {
		const tokens = tokenizeExpr('price * qty');
		const rpn = parseExprToRpn(tokens);
		expect(rpn[0]).toEqual({ t: 'col', v: 'price' });
		expect(rpn[1]).toEqual({ t: 'col', v: 'qty' });
		expect(rpn[2]).toEqual({ t: 'op', v: '*' });
	});
	it('throws on mismatched parentheses', () => {
		expect(() => parseExprToRpn(tokenizeExpr('(1 + 2'))).toThrow('Mismatched');
		expect(() => parseExprToRpn(tokenizeExpr('1 + 2)'))).toThrow('Mismatched');
	});
});

// ── evalRpn ───────────────────────────────────────────────────────────────────

describe('evalRpn', () => {
	const evaluate = (expr: string, env: Record<string, unknown> = {}) => {
		return evalRpn(parseExprToRpn(tokenizeExpr(expr)), env);
	};

	it('evaluates arithmetic', () => {
		expect(evaluate('2 + 3')).toBe(5);
		expect(evaluate('10 - 4')).toBe(6);
		expect(evaluate('3 * 7')).toBe(21);
		expect(evaluate('15 / 3')).toBe(5);
	});

	it('evaluates expressions with columns', () => {
		expect(evaluate('[price] * [qty]', { price: 10, qty: 5 })).toBe(50);
	});

	it('evaluates column references case-insensitively', () => {
		expect(evaluate('[Price]', { price: 42 })).toBe(42);
	});

	it('evaluates unary minus', () => {
		expect(evaluate('-5')).toBe(-5);
	});

	it('evaluates string concatenation with +', () => {
		expect(evaluate('"hello" + " " + "world"')).toBe('hello world');
	});

	it('returns null for division by zero', () => {
		expect(evaluate('10 / 0')).toBe(null);
	});

	// Function tests
	it('round()', () => {
		expect(evaluate('round(3.14159, 2)')).toBe(3.14);
		expect(evaluate('round(3.6, 0)')).toBe(4);
	});

	it('floor() and ceil()', () => {
		expect(evaluate('floor(3.9)')).toBe(3);
		expect(evaluate('ceiling(3.1)')).toBe(4);
		expect(evaluate('ceil(3.1)')).toBe(4);
	});

	it('abs()', () => {
		expect(evaluate('abs(-42)')).toBe(42);
		expect(evaluate('abs(42)')).toBe(42);
	});

	it('len()', () => {
		expect(evaluate('len("hello")')).toBe(5);
	});

	it('tostring() and tonumber()', () => {
		expect(evaluate('tostring(42)')).toBe('42');
		expect(evaluate('tonumber("42")')).toBe(42);
	});

	it('string functions', () => {
		expect(evaluate('trim("  hello  ")')).toBe('hello');
		expect(evaluate('toupper("hello")')).toBe('HELLO');
		expect(evaluate('tolower("HELLO")')).toBe('hello');
		expect(evaluate('indexof("hello world", "world")')).toBe(6);
		expect(evaluate('replace("hello world", "world", "there")')).toBe('hello there');
	});

	it('substring()', () => {
		expect(evaluate('substring("hello", 1, 3)')).toBe('ell');
	});

	it('coalesce()', () => {
		// coalesce isn't easily testable because its arity is dynamic;
		// but with the current implementation it uses arity 1.
		// Let's test with a column value:
		expect(evaluate('coalesce([a])', { a: null })).toBe(null); // only 1 arg in arity table
	});

	it('date functions: getyear, getmonth, getday', () => {
		const d = new Date(2024, 5, 15);
		expect(evaluate('getyear([d])', { d })).toBe(2024);
		expect(evaluate('getmonth([d])', { d })).toBe(6);
		expect(evaluate('getday([d])', { d })).toBe(15);
	});

	it('format_datetime()', () => {
		const d = new Date(2024, 0, 15, 10, 30, 0);
		expect(evaluate('format_datetime([d], "yyyy-MM-dd")', { d })).toBe('2024-01-15');
	});

	it('throws on unknown function', () => {
		expect(() => evaluate('unknownfn(42)')).toThrow('Unknown function');
	});

	it('complex expression: [price] * [qty] + 10', () => {
		expect(evaluate('[price] * [qty] + 10', { price: 5, qty: 3 })).toBe(25);
	});

	it('nested function: round([price] * 1.1, 2)', () => {
		expect(evaluate('round([price] * 1.1, 2)', { price: 10 })).toBe(11);
	});
});
