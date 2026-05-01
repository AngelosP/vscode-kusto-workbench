import { describe, it, expect, afterEach } from 'vitest';
import { addPageScrollListener, escapeHtml, escapeRegex, getPageScrollElement, getPageScrollMaxTop, getScrollY, refreshPageScrollListeners, scrollElementIntoPageView, scrollPageBy, setPageScrollTop } from '../../src/webview/core/utils.js';

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
	function createScrollablePageElement(): HTMLDivElement {
		const scrollEl = document.createElement('div');
		scrollEl.className = 'kw-scroll-viewport';
		Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, value: 100 });
		Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, value: 500 });
		document.body.appendChild(scrollEl);
		return scrollEl;
	}

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

	it('sets and clamps the explicit overlay page scroll position', () => {
		const scrollEl = createScrollablePageElement();

		expect(getPageScrollMaxTop()).toBe(400);
		expect(setPageScrollTop(250)).toBe(250);
		expect(scrollEl.scrollTop).toBe(250);

		expect(setPageScrollTop(999)).toBe(400);
		expect(scrollEl.scrollTop).toBe(400);

		expect(setPageScrollTop(-30)).toBe(0);
		expect(scrollEl.scrollTop).toBe(0);
	});

	it('scrolls the explicit page element by a delta without consulting window scroll reads', () => {
		const scrollEl = createScrollablePageElement();
		scrollEl.scrollTop = 120;

		expect(scrollPageBy(0, 90)).toEqual({ left: 0, top: 210 });
		expect(scrollEl.scrollTop).toBe(210);

		expect(scrollPageBy(0, -500)).toEqual({ left: 0, top: 0 });
		expect(scrollEl.scrollTop).toBe(0);
	});

	it('scrolls an element into the overlay page viewport using client rects', () => {
		const scrollEl = createScrollablePageElement();
		const target = document.createElement('div');
		scrollEl.appendChild(target);
		scrollEl.scrollTop = 50;
		(scrollEl as any).getBoundingClientRect = () => ({ top: 10, bottom: 110, height: 100, left: 0, right: 100, width: 100, x: 0, y: 10, toJSON: () => ({}) } as DOMRect);
		(target as any).getBoundingClientRect = () => ({ top: 180, bottom: 220, height: 40, left: 0, right: 100, width: 100, x: 0, y: 180, toJSON: () => ({}) } as DOMRect);

		scrollElementIntoPageView(target, 'start');

		expect(scrollEl.scrollTop).toBe(220);
	});

	it('documents the old fake-scroll/native-event coordinate mismatch', () => {
		const clientY = 120;
		const nativeEventPageY = 120;
		const editorViewportTop = 100;
		const fakeWindowScrollY = 500;

		const oldMixedRelativeY = nativeEventPageY - (editorViewportTop + fakeWindowScrollY);
		const clientCoordinateRelativeY = clientY - editorViewportTop;

		expect(oldMixedRelativeY).toBe(-480);
		expect(clientCoordinateRelativeY).toBe(20);
	});
});
