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
});
