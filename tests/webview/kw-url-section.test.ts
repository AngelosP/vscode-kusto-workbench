import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { html, render, nothing } from 'lit';

// ── Mocks (must come before component import) ────────────────────────────────

vi.mock('../../src/webview/core/persistence.js', () => ({
	schedulePersist: vi.fn(),
}));

vi.mock('../../src/webview/core/section-factory.js', () => ({
	__kustoRefreshAllDataSourceDropdowns: vi.fn(),
}));

vi.mock('../../src/webview/core/utils.js', () => ({
	addPageScrollListener: vi.fn(() => vi.fn()),
	getScrollY: () => 0,
	maybeAutoScrollWhileDragging: () => {},
	escapeHtml: (s: string) => s,
}));

import '../../src/webview/sections/kw-url-section.js';
import { KwUrlSection } from '../../src/webview/sections/kw-url-section.js';
import type { UrlSectionData } from '../../src/webview/sections/kw-url-section.js';

// ── Static pure functions ─────────────────────────────────────────────────────

describe('KwUrlSection._parseCsv', () => {

	it('parses simple CSV', () => {
		const rows = KwUrlSection._parseCsv('a,b,c\n1,2,3');
		expect(rows).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
	});

	it('handles empty string', () => {
		const rows = KwUrlSection._parseCsv('');
		expect(rows).toEqual([['']]);
	});

	it('handles single field', () => {
		const rows = KwUrlSection._parseCsv('hello');
		expect(rows).toEqual([['hello']]);
	});

	it('handles CRLF line endings', () => {
		const rows = KwUrlSection._parseCsv('a,b\r\n1,2');
		expect(rows).toEqual([['a', 'b'], ['1', '2']]);
	});

	it('handles \\r only line endings', () => {
		const rows = KwUrlSection._parseCsv('a,b\r1,2');
		expect(rows).toEqual([['a', 'b'], ['1', '2']]);
	});

	it('handles quoted fields', () => {
		const rows = KwUrlSection._parseCsv('"hello","world"');
		expect(rows).toEqual([['hello', 'world']]);
	});

	it('handles escaped quotes inside quoted fields', () => {
		const rows = KwUrlSection._parseCsv('"say ""hello""",world');
		expect(rows).toEqual([['say "hello"', 'world']]);
	});

	it('handles commas inside quoted fields', () => {
		const rows = KwUrlSection._parseCsv('"a,b",c');
		expect(rows).toEqual([['a,b', 'c']]);
	});

	it('handles newlines inside quoted fields', () => {
		const rows = KwUrlSection._parseCsv('"line1\nline2",b');
		expect(rows).toEqual([['line1\nline2', 'b']]);
	});

	it('handles trailing newline', () => {
		const rows = KwUrlSection._parseCsv('a,b\n');
		expect(rows).toEqual([['a', 'b'], ['']]);
	});

	it('handles Unicode line separators', () => {
		const rows = KwUrlSection._parseCsv('a,b\u2028c,d');
		expect(rows).toEqual([['a', 'b'], ['c', 'd']]);
	});

	it('handles Unicode paragraph separators', () => {
		const rows = KwUrlSection._parseCsv('a,b\u2029c,d');
		expect(rows).toEqual([['a', 'b'], ['c', 'd']]);
	});

	it('handles multiple rows', () => {
		const rows = KwUrlSection._parseCsv('h1,h2\nv1,v2\nv3,v4');
		expect(rows).toEqual([['h1', 'h2'], ['v1', 'v2'], ['v3', 'v4']]);
	});

	it('handles empty fields', () => {
		const rows = KwUrlSection._parseCsv(',,,');
		expect(rows).toEqual([['', '', '', '']]);
	});
});

describe('KwUrlSection._looksLikeHtmlText', () => {

	it('detects <!doctype html', () => {
		expect(KwUrlSection._looksLikeHtmlText('<!doctype html><html>')).toBe(true);
	});

	it('detects <html', () => {
		expect(KwUrlSection._looksLikeHtmlText('<html><body>hi</body></html>')).toBe(true);
	});

	it('detects <head', () => {
		expect(KwUrlSection._looksLikeHtmlText('<head><title>Test</title></head>')).toBe(true);
	});

	it('detects <body', () => {
		expect(KwUrlSection._looksLikeHtmlText('<body>content</body>')).toBe(true);
	});

	it('is case insensitive', () => {
		expect(KwUrlSection._looksLikeHtmlText('<!DOCTYPE HTML>')).toBe(true);
		expect(KwUrlSection._looksLikeHtmlText('<HTML>')).toBe(true);
	});

	it('handles leading whitespace', () => {
		expect(KwUrlSection._looksLikeHtmlText('   <!doctype html>')).toBe(true);
	});

	it('returns false for non-HTML text', () => {
		expect(KwUrlSection._looksLikeHtmlText('just plain text')).toBe(false);
	});

	it('returns false for partial HTML tags', () => {
		expect(KwUrlSection._looksLikeHtmlText('<h1>Heading</h1>')).toBe(false);
	});

	it('returns false for empty string', () => {
		expect(KwUrlSection._looksLikeHtmlText('')).toBe(false);
	});

	it('handles null-ish input gracefully', () => {
		expect(KwUrlSection._looksLikeHtmlText(null as any)).toBe(false);
		expect(KwUrlSection._looksLikeHtmlText(undefined as any)).toBe(false);
	});
});

// ── Component rendering & serialization ───────────────────────────────────────

let container: HTMLDivElement;

function createUrlSection(boxId = 'url_test_1'): KwUrlSection {
	render(html`
		<kw-url-section box-id=${boxId}></kw-url-section>
	`, container);
	return container.querySelector('kw-url-section')!;
}

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	render(nothing, container);
	container.remove();
});

describe('kw-url-section — rendering', () => {

	it('renders without errors', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		expect(el).toBeTruthy();
		expect(el.shadowRoot).toBeTruthy();
	});

	it('shows a URL input field', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		const input = el.shadowRoot!.querySelector('.url-input') as HTMLInputElement;
		expect(input).toBeTruthy();
		expect(input.placeholder).toContain('URL');
	});
});

describe('kw-url-section — public API', () => {

	it('getName / setName work', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		el.setName('My URL');
		expect(el.getName()).toBe('My URL');
	});

	it('setUrl updates the URL state', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		el.setUrl('https://example.com');
		const state = el.getFetchState();
		expect(state.url).toBe('https://example.com');
	});

	it('setExpanded toggles expanded state', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		el.setExpanded(false);
		expect(el.getFetchState().expanded).toBe(false);
		el.setExpanded(true);
		expect(el.getFetchState().expanded).toBe(true);
	});
});

describe('kw-url-section — serialize', () => {

	it('serializes default state', async () => {
		const el = createUrlSection('url_42');
		await el.updateComplete;
		const data = el.serialize();
		expect(data.id).toBe('url_42');
		expect(data.type).toBe('url');
		expect(data.name).toBe('');
		expect(data.url).toBe('');
		expect(data.expanded).toBe(true);
	});

	it('serializes with name and URL', async () => {
		const el = createUrlSection('url_99');
		await el.updateComplete;
		el.setName('Test URL');
		el.setUrl('https://example.com/data.csv');
		const data = el.serialize();
		expect(data.name).toBe('Test URL');
		expect(data.url).toBe('https://example.com/data.csv');
	});

	it('serializes expanded=false', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		el.setExpanded(false);
		const data = el.serialize();
		expect(data.expanded).toBe(false);
	});

	it('omits default image display settings', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		const data = el.serialize();
		// Defaults: fill, left, shrink — all omitted.
		expect(data.imageSizeMode).toBeUndefined();
		expect(data.imageAlign).toBeUndefined();
		expect(data.imageOverflow).toBeUndefined();
	});

	it('includes non-default image display settings', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		el.setImageDisplayMode('natural', 'center', 'scroll');
		const data = el.serialize();
		expect(data.imageSizeMode).toBe('natural');
		expect(data.imageAlign).toBe('center');
		expect(data.imageOverflow).toBe('scroll');
	});

	it('setImageDisplayMode ignores invalid values', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		el.setImageDisplayMode('bogus' as any, 'bogus' as any, 'bogus' as any);
		const data = el.serialize();
		// Should still be defaults.
		expect(data.imageSizeMode).toBeUndefined();
		expect(data.imageAlign).toBeUndefined();
		expect(data.imageOverflow).toBeUndefined();
	});
});
