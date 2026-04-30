import { describe, it, expect, afterEach } from 'vitest';
import { addPageScrollListener, escapeHtml, escapeRegex, getPageScrollElement, getScrollY, refreshPageScrollListeners } from '../../src/webview/core/utils.js';

afterEach(() => {
	document.querySelectorAll('.kw-scroll-viewport').forEach(el => el.remove());
});

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

// ── page scroll helpers ──────────────────────────────────────────────────────

describe('page scroll helpers', () => {
	it('reads scroll position from the overlay page scroll element when present', () => {
		const scrollEl = document.createElement('div');
		scrollEl.className = 'kw-scroll-viewport';
		scrollEl.scrollTop = 42;
		document.body.appendChild(scrollEl);

		expect(getPageScrollElement()).toBe(scrollEl);
		expect(getScrollY()).toBe(42);
	});

	it('listens to the overlay page scroll element instead of document noise', () => {
		const scrollEl = document.createElement('div');
		scrollEl.className = 'kw-scroll-viewport';
		document.body.appendChild(scrollEl);
		let calls = 0;
		const cleanup = addPageScrollListener(() => { calls++; }, { passive: true });

		document.dispatchEvent(new Event('scroll'));
		expect(calls).toBe(0);

		scrollEl.dispatchEvent(new Event('scroll'));
		expect(calls).toBe(1);

		cleanup();
		scrollEl.dispatchEvent(new Event('scroll'));
		expect(calls).toBe(1);
	});

	it('rebinds listeners to a later-created overlay page scroll element', () => {
		let calls = 0;
		const cleanup = addPageScrollListener(() => { calls++; }, { passive: true });

		window.dispatchEvent(new Event('scroll'));
		expect(calls).toBe(1);

		const scrollEl = document.createElement('div');
		scrollEl.className = 'kw-scroll-viewport';
		document.body.appendChild(scrollEl);
		refreshPageScrollListeners();

		window.dispatchEvent(new Event('scroll'));
		expect(calls).toBe(1);

		scrollEl.dispatchEvent(new Event('scroll'));
		expect(calls).toBe(2);

		cleanup();
		scrollEl.dispatchEvent(new Event('scroll'));
		expect(calls).toBe(2);
	});
});
