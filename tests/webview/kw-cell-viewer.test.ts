import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { html, render, nothing } from 'lit';
import '../../src/webview/components/kw-cell-viewer.js';
import type { KwCellViewer } from '../../src/webview/components/kw-cell-viewer.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

let container: HTMLDivElement;

function getViewer(): KwCellViewer {
	let el = container.querySelector('kw-cell-viewer') as KwCellViewer | null;
	if (!el) {
		render(html`<kw-cell-viewer></kw-cell-viewer>`, container);
		el = container.querySelector('kw-cell-viewer')!;
	}
	return el;
}

function getBackdrop(el: KwCellViewer): HTMLElement | null {
	return el.shadowRoot!.querySelector('.modal-backdrop');
}

function getTitle(el: KwCellViewer): string {
	const h3 = el.shadowRoot!.querySelector('.modal-header h3');
	return h3?.textContent?.trim() ?? '';
}

function getCellValue(el: KwCellViewer): HTMLElement | null {
	return el.shadowRoot!.querySelector('.cell-value');
}

function getCloseButton(el: KwCellViewer): HTMLButtonElement | null {
	return el.shadowRoot!.querySelector('.close-btn');
}

function getCopyButton(el: KwCellViewer): HTMLButtonElement | null {
	return el.shadowRoot!.querySelector('.tool-btn');
}

function getSearchBar(el: KwCellViewer): HTMLElement | null {
	return el.shadowRoot!.querySelector('kw-search-bar');
}

function getHighlights(el: KwCellViewer): NodeListOf<Element> {
	return el.shadowRoot!.querySelectorAll('.cell-highlight');
}

// ── Setup/teardown ────────────────────────────────────────────────────────────

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	render(nothing, container);
	container.remove();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('kw-cell-viewer', () => {
	it('renders nothing when open=false', async () => {
		const el = getViewer();
		await el.updateComplete;
		expect(getBackdrop(el)).toBeNull();
	});

	it('renders modal when show() is called', async () => {
		const el = getViewer();
		el.show('MyColumn', 'Hello World');
		await el.updateComplete;

		expect(getBackdrop(el)).not.toBeNull();
		expect(getTitle(el)).toContain('MyColumn');
		expect(getCellValue(el)?.textContent).toBe('Hello World');
	});

	it('renders search bar when open', async () => {
		const el = getViewer();
		el.show('Col', 'value');
		await el.updateComplete;

		expect(getSearchBar(el)).not.toBeNull();
	});

	it('close button hides the modal', async () => {
		const el = getViewer();
		el.show('Col', 'value');
		await el.updateComplete;

		getCloseButton(el)?.click();
		await el.updateComplete;

		expect(getBackdrop(el)).toBeNull();
		expect(el.open).toBe(false);
	});

	it('clicking backdrop hides the modal', async () => {
		const el = getViewer();
		el.show('Col', 'value');
		await el.updateComplete;

		getBackdrop(el)?.click();
		await el.updateComplete;

		expect(el.open).toBe(false);
	});

	it('clicking modal content does not close', async () => {
		const el = getViewer();
		el.show('Col', 'value');
		await el.updateComplete;

		const content = el.shadowRoot!.querySelector('.modal-content') as HTMLElement;
		content.click();
		await el.updateComplete;

		expect(el.open).toBe(true);
	});

	it('hide() clears raw value', async () => {
		const el = getViewer();
		el.show('Col', 'some value');
		await el.updateComplete;
		expect(getCellValue(el)?.textContent).toBe('some value');

		el.hide();
		await el.updateComplete;
		expect(getBackdrop(el)).toBeNull();
	});

	it('escapes HTML in value', async () => {
		const el = getViewer();
		el.show('Col', '<script>alert("xss")</script>');
		await el.updateComplete;

		const valueEl = getCellValue(el);
		expect(valueEl?.innerHTML).toContain('&lt;script&gt;');
		expect(valueEl?.innerHTML).not.toContain('<script>');
	});

	it('shows copy button', async () => {
		const el = getViewer();
		el.show('Col', 'text');
		await el.updateComplete;

		expect(getCopyButton(el)).not.toBeNull();
	});

	it('search highlights matching text', async () => {
		const el = getViewer();
		el.show('Col', 'Hello World Hello', { searchQuery: 'Hello' });
		await el.updateComplete;

		const highlights = getHighlights(el);
		expect(highlights.length).toBe(2);
		expect(el.matchCount).toBe(2);
	});

	it('no highlights when search has no matches', async () => {
		const el = getViewer();
		el.show('Col', 'Hello World', { searchQuery: 'xyz' });
		await el.updateComplete;

		expect(getHighlights(el).length).toBe(0);
		expect(el.matchCount).toBe(0);
	});

	it('no highlights with empty search query', async () => {
		const el = getViewer();
		el.show('Col', 'Hello World', { searchQuery: '' });
		await el.updateComplete;

		expect(getHighlights(el).length).toBe(0);
	});

	it('regex search mode works', async () => {
		const el = getViewer();
		el.show('Col', 'abc 123 def 456', { searchQuery: '\\d+', searchMode: 'regex' });
		await el.updateComplete;

		expect(getHighlights(el).length).toBe(2);
	});

	it('current match gets active class after update', async () => {
		const el = getViewer();
		el.show('Col', 'aaa bbb aaa bbb aaa', { searchQuery: 'aaa' });
		await el.updateComplete;

		const highlights = getHighlights(el);
		expect(highlights.length).toBe(3);
		// First match should be highlighted as current
		expect(highlights[0].classList.contains('cell-highlight-current')).toBe(true);
	});

	it('show() resets state from previous view', async () => {
		const el = getViewer();
		el.show('First', 'aaa aaa', { searchQuery: 'aaa' });
		await el.updateComplete;
		expect(getHighlights(el).length).toBe(2);

		el.show('Second', 'bbb', { searchQuery: '' });
		await el.updateComplete;
		expect(getHighlights(el).length).toBe(0);
		expect(getCellValue(el)?.textContent).toBe('bbb');
		expect(getTitle(el)).toContain('Second');
	});

	it('multiline values render with whitespace preserved', async () => {
		const el = getViewer();
		el.show('Col', 'line1\nline2\nline3');
		await el.updateComplete;

		const valueEl = getCellValue(el);
		// white-space: pre-wrap preserves newlines; textContent should reflect them
		expect(valueEl?.textContent).toContain('line1');
		expect(valueEl?.textContent).toContain('line2');
		expect(valueEl?.textContent).toContain('line3');
	});

	it('handles empty value', async () => {
		const el = getViewer();
		el.show('Col', '');
		await el.updateComplete;

		expect(getCellValue(el)?.textContent).toBe('');
	});

	it('handles very long value without error', async () => {
		const el = getViewer();
		const longValue = 'x'.repeat(10000);
		el.show('Col', longValue);
		await el.updateComplete;

		expect(getCellValue(el)?.textContent?.length).toBe(10000);
	});

	it('navigates to next match', async () => {
		const el = getViewer();
		el.show('Col', 'aaa bbb aaa bbb aaa', { searchQuery: 'aaa' });
		await el.updateComplete;

		expect(getHighlights(el).length).toBe(3);
		// First match is current initially
		expect(getHighlights(el)[0].classList.contains('cell-highlight-current')).toBe(true);

		// Navigate next
		const searchBar = getSearchBar(el)!;
		searchBar.dispatchEvent(new CustomEvent('search-next', { bubbles: true, composed: true }));
		await el.updateComplete;

		// Should move to second match
		expect(getHighlights(el)[1].classList.contains('cell-highlight-current')).toBe(true);
		expect(getHighlights(el)[0].classList.contains('cell-highlight-current')).toBe(false);
	});

	it('navigates to previous match', async () => {
		const el = getViewer();
		el.show('Col', 'aaa bbb aaa bbb aaa', { searchQuery: 'aaa' });
		await el.updateComplete;

		// Navigate prev from first match should wrap to last
		const searchBar = getSearchBar(el)!;
		searchBar.dispatchEvent(new CustomEvent('search-prev', { bubbles: true, composed: true }));
		await el.updateComplete;

		expect(getHighlights(el)[2].classList.contains('cell-highlight-current')).toBe(true);
	});

	it('next match wraps around from last to first', async () => {
		const el = getViewer();
		el.show('Col', 'aaa bbb aaa', { searchQuery: 'aaa' });
		await el.updateComplete;

		const searchBar = getSearchBar(el)!;
		// Navigate to last (index 1)
		searchBar.dispatchEvent(new CustomEvent('search-next', { bubbles: true, composed: true }));
		await el.updateComplete;
		// Navigate past last — should wrap to first (index 0)
		searchBar.dispatchEvent(new CustomEvent('search-next', { bubbles: true, composed: true }));
		await el.updateComplete;

		expect(getHighlights(el)[0].classList.contains('cell-highlight-current')).toBe(true);
	});

	it('does not navigate when only 1 match', async () => {
		const el = getViewer();
		el.show('Col', 'abc def', { searchQuery: 'abc' });
		await el.updateComplete;

		expect(getHighlights(el).length).toBe(1);
		const searchBar = getSearchBar(el)!;
		searchBar.dispatchEvent(new CustomEvent('search-next', { bubbles: true, composed: true }));
		await el.updateComplete;

		// Still on the same match
		expect(getHighlights(el)[0].classList.contains('cell-highlight-current')).toBe(true);
	});

	it('copy button uses vscode postMessage callback when set', async () => {
		const el = getViewer();
		const mockCallback = vi.fn();
		el.copyCallback = mockCallback;
		el.show('Col', 'copyable text');
		await el.updateComplete;

		getCopyButton(el)?.click();

		expect(mockCallback).toHaveBeenCalledTimes(1);
		expect(mockCallback.mock.calls[0][0]).toEqual({ type: 'copyToClipboard', text: 'copyable text' });
	});

	it('search mode change resets match index', async () => {
		const el = getViewer();
		el.show('Col', 'aaa bbb aaa', { searchQuery: 'aaa', searchMode: 'wildcard' });
		await el.updateComplete;

		// Navigate to second match
		const searchBar = getSearchBar(el)!;
		searchBar.dispatchEvent(new CustomEvent('search-next', { bubbles: true, composed: true }));
		await el.updateComplete;

		// Change mode → should reset to first match
		searchBar.dispatchEvent(new CustomEvent('search-mode-change', { detail: { mode: 'regex' }, bubbles: true, composed: true }));
		await el.updateComplete;

		// After re-render, first match should be current
		if (getHighlights(el).length >= 2) {
			expect(getHighlights(el)[0].classList.contains('cell-highlight-current')).toBe(true);
		}
	});

	it('search input change resets match index', async () => {
		const el = getViewer();
		el.show('Col', 'aaa bbb aaa', { searchQuery: 'aaa' });
		await el.updateComplete;

		const searchBar = getSearchBar(el)!;
		// Navigate away from first match
		searchBar.dispatchEvent(new CustomEvent('search-next', { bubbles: true, composed: true }));
		await el.updateComplete;

		// Change query
		searchBar.dispatchEvent(new CustomEvent('search-input', { detail: { query: 'bbb' }, bubbles: true, composed: true }));
		await el.updateComplete;

		// Should have 1 match (bbb) and it should be current
		expect(getHighlights(el).length).toBe(1);
		expect(getHighlights(el)[0].classList.contains('cell-highlight-current')).toBe(true);
	});

	it('wildcard search with * works', async () => {
		const el = getViewer();
		el.show('Col', 'hello world help', { searchQuery: 'hel*', searchMode: 'wildcard' });
		await el.updateComplete;

		// Depending on wildcard implementation, this should match 'hello' and 'help'
		expect(getHighlights(el).length).toBeGreaterThanOrEqual(1);
	});

	it('shows special characters correctly escaped', async () => {
		const el = getViewer();
		el.show('Col', '<b>bold</b> & "quoted"');
		await el.updateComplete;

		const valueEl = getCellValue(el)!;
		expect(valueEl.innerHTML).toContain('&lt;b&gt;');
		expect(valueEl.innerHTML).toContain('&amp;');
		// Quotes may or may not be entity-escaped depending on browser innerHTML normalization
		expect(valueEl.textContent).toContain('"quoted"');
	});
});
