import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSearchRegex, createDebouncedSearch, navigateMatch, createRegexCache } from '../../src/webview/components/search-utils.js';

// ── buildSearchRegex ──────────────────────────────────────────────────────────

describe('buildSearchRegex', () => {
	it('wildcard: simple term matches', () => {
		const { regex } = buildSearchRegex('hello', 'wildcard');
		expect(regex).not.toBeNull();
		expect(regex!.test('hello')).toBe(true);
		expect(regex!.test('world')).toBe(false);
	});

	it('wildcard: asterisk glob', () => {
		const { regex } = buildSearchRegex('hel*rld', 'wildcard');
		expect(regex).not.toBeNull();
		expect(regex!.test('hello world')).toBe(true);
	});

	it('wildcard: leading and trailing asterisks', () => {
		const { regex } = buildSearchRegex('*test*', 'wildcard');
		expect(regex).not.toBeNull();
		expect(regex!.test('this is a test case')).toBe(true);
	});

	it('wildcard: special chars are escaped', () => {
		const { regex } = buildSearchRegex('file.txt', 'wildcard');
		expect(regex).not.toBeNull();
		expect(regex!.test('file.txt')).toBe(true);
		expect(regex!.test('fileTtxt')).toBe(false);
	});

	it('wildcard: multiple stars', () => {
		const { regex } = buildSearchRegex('a*b*c', 'wildcard');
		expect(regex).not.toBeNull();
		expect(regex!.test('aXbYc')).toBe(true);
		regex!.lastIndex = 0;
		expect(regex!.test('abc')).toBe(true);
		regex!.lastIndex = 0;
		expect(regex!.test('ac')).toBe(false);
	});

	it('wildcard: lone star returns error (matches empty)', () => {
		const result = buildSearchRegex('*', 'wildcard');
		expect(result.regex).toBeNull();
		expect(result.error).toBe('Pattern matches empty text');
	});

	it('regex mode: digit pattern', () => {
		const { regex } = buildSearchRegex('\\d+', 'regex');
		expect(regex).not.toBeNull();
		regex!.lastIndex = 0;
		expect(regex!.test('abc123')).toBe(true);
	});

	it('regex mode: invalid regex returns null with error', () => {
		const result = buildSearchRegex('[invalid', 'regex');
		expect(result.regex).toBeNull();
		expect(result.error).toBe('Invalid regex');
	});

	it('empty query returns null with no error', () => {
		const result = buildSearchRegex('', 'wildcard');
		expect(result.regex).toBeNull();
		expect(result.error).toBeNull();
	});

	it('whitespace only returns null with no error', () => {
		const result = buildSearchRegex('   ', 'wildcard');
		expect(result.regex).toBeNull();
		expect(result.error).toBeNull();
	});

	it('pattern matching empty string returns null with error', () => {
		const result = buildSearchRegex('.*', 'regex');
		expect(result.regex).toBeNull();
		expect(result.error).toBe('Pattern matches empty text');
	});

	it('regex: ^$ matches empty text returns error', () => {
		const result = buildSearchRegex('^$', 'regex');
		expect(result.regex).toBeNull();
		expect(result.error).toBe('Pattern matches empty text');
	});

	it('regex mode: case insensitive', () => {
		const { regex } = buildSearchRegex('Hello', 'regex');
		expect(regex).not.toBeNull();
		expect(regex!.test('HELLO world')).toBe(true);
	});

	it('case insensitive', () => {
		const { regex } = buildSearchRegex('Hello', 'wildcard');
		expect(regex).not.toBeNull();
		expect(regex!.test('HELLO')).toBe(true);
		regex!.lastIndex = 0;
		expect(regex!.test('hello')).toBe(true);
	});

	it('regex has global flag', () => {
		const { regex } = buildSearchRegex('test', 'wildcard');
		expect(regex).not.toBeNull();
		expect(regex!.flags).toContain('g');
		expect(regex!.flags).toContain('i');
	});
});

// ── createDebouncedSearch ─────────────────────────────────────────────────────

describe('createDebouncedSearch', () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it('fires after delay', () => {
		const fn = vi.fn();
		const { trigger } = createDebouncedSearch(fn, 200);
		trigger();
		expect(fn).not.toHaveBeenCalled();
		vi.advanceTimersByTime(200);
		expect(fn).toHaveBeenCalledOnce();
	});

	it('multiple rapid triggers fire once', () => {
		const fn = vi.fn();
		const { trigger } = createDebouncedSearch(fn, 200);
		trigger();
		trigger();
		trigger();
		vi.advanceTimersByTime(200);
		expect(fn).toHaveBeenCalledOnce();
	});

	it('multiple rapid triggers with gaps still fire once', () => {
		const fn = vi.fn();
		const { trigger } = createDebouncedSearch(fn, 200);
		for (let i = 0; i < 5; i++) {
			trigger();
			vi.advanceTimersByTime(50);
		}
		expect(fn).not.toHaveBeenCalled();
		vi.advanceTimersByTime(200);
		expect(fn).toHaveBeenCalledOnce();
	});

	it('cancel prevents firing', () => {
		const fn = vi.fn();
		const { trigger, cancel } = createDebouncedSearch(fn, 200);
		trigger();
		cancel();
		vi.advanceTimersByTime(200);
		expect(fn).not.toHaveBeenCalled();
	});

	it('custom delay respected', () => {
		const fn = vi.fn();
		const { trigger } = createDebouncedSearch(fn, 500);
		trigger();
		vi.advanceTimersByTime(300);
		expect(fn).not.toHaveBeenCalled();
		vi.advanceTimersByTime(200);
		expect(fn).toHaveBeenCalledOnce();
	});

	it('immediate re-trigger after fire', () => {
		const fn = vi.fn();
		const { trigger } = createDebouncedSearch(fn, 200);
		trigger();
		vi.advanceTimersByTime(200);
		expect(fn).toHaveBeenCalledTimes(1);
		trigger();
		vi.advanceTimersByTime(200);
		expect(fn).toHaveBeenCalledTimes(2);
	});
});

// ── navigateMatch ─────────────────────────────────────────────────────────────

describe('navigateMatch', () => {
	it('next: advances index', () => {
		expect(navigateMatch(0, 5, 'next')).toBe(1);
		expect(navigateMatch(3, 5, 'next')).toBe(4);
	});

	it('next: wraps at end', () => {
		expect(navigateMatch(4, 5, 'next')).toBe(0);
	});

	it('prev: decrements index', () => {
		expect(navigateMatch(3, 5, 'prev')).toBe(2);
	});

	it('prev: wraps at start', () => {
		expect(navigateMatch(0, 5, 'prev')).toBe(4);
	});

	it('matchCount 0 returns 0', () => {
		expect(navigateMatch(0, 0, 'next')).toBe(0);
		expect(navigateMatch(0, 0, 'prev')).toBe(0);
	});

	it('matchCount 1 always returns 0', () => {
		expect(navigateMatch(0, 1, 'next')).toBe(0);
		expect(navigateMatch(0, 1, 'prev')).toBe(0);
	});

	it('next: wraps from last index', () => {
		expect(navigateMatch(2, 3, 'next')).toBe(0);
	});
});

// ── createRegexCache ──────────────────────────────────────────────────────────

describe('createRegexCache', () => {
	it('same query+mode returns same result', () => {
		const cache = createRegexCache();
		const r1 = cache.get('hello', 'wildcard');
		const r2 = cache.get('hello', 'wildcard');
		expect(r1).toBe(r2);
		expect(r1.regex).not.toBeNull();
	});

	it('different query returns new result', () => {
		const cache = createRegexCache();
		const r1 = cache.get('hello', 'wildcard');
		const r2 = cache.get('world', 'wildcard');
		expect(r1).not.toBe(r2);
	});

	it('different mode returns new result', () => {
		const cache = createRegexCache();
		const r1 = cache.get('hello', 'wildcard');
		const r2 = cache.get('hello', 'regex');
		expect(r1).not.toBe(r2);
	});

	it('null queries return null regex', () => {
		const cache = createRegexCache();
		const r = cache.get('', 'wildcard');
		expect(r.regex).toBeNull();
		expect(r.error).toBeNull();
	});

	it('invalid regex queries return null regex with error', () => {
		const cache = createRegexCache();
		const r = cache.get('[bad', 'regex');
		expect(r.regex).toBeNull();
		expect(r.error).toBe('Invalid regex');
	});

	it('invalid regex returns same cached result on repeat call', () => {
		const cache = createRegexCache();
		const r1 = cache.get('[bad', 'regex');
		const r2 = cache.get('[bad', 'regex');
		expect(r1).toBe(r2);
	});

	it('empty query returns cached result on repeat call', () => {
		const cache = createRegexCache();
		const r1 = cache.get('', 'wildcard');
		const r2 = cache.get('', 'wildcard');
		expect(r1).toBe(r2);
		expect(r1.regex).toBeNull();
		expect(r1.error).toBeNull();
	});
});
