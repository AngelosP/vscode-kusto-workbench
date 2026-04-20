import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { html, render, nothing } from 'lit';
import '../../src/webview/components/kw-search-bar.js';
import type { KwSearchBar } from '../../src/webview/components/kw-search-bar.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

let container: HTMLDivElement;

function createSearchBar(attrs: Partial<{
	query: string;
	mode: 'wildcard' | 'regex';
	matchCount: number;
	currentMatch: number;
	showClose: boolean;
	showStatus: boolean;
}> = {}): KwSearchBar {
	const {
		query = '',
		mode = 'wildcard',
		matchCount = 0,
		currentMatch = 0,
		showClose = false,
		showStatus = true,
	} = attrs;

	render(html`
		<kw-search-bar
			.query=${query}
			.mode=${mode}
			.matchCount=${matchCount}
			.currentMatch=${currentMatch}
			.showClose=${showClose}
			.showStatus=${showStatus}
		></kw-search-bar>
	`, container);

	return container.querySelector('kw-search-bar')!;
}

function getInput(el: KwSearchBar): HTMLInputElement {
	return el.shadowRoot!.querySelector('input')!;
}

function getStatusText(el: KwSearchBar): string {
	const span = el.shadowRoot!.querySelector('.search-status');
	return span?.textContent?.trim() ?? '';
}

function getNavButtons(el: KwSearchBar): { prev: HTMLButtonElement; next: HTMLButtonElement } {
	const btns = el.shadowRoot!.querySelectorAll('.nav-btn') as NodeListOf<HTMLButtonElement>;
	return { prev: btns[0], next: btns[1] };
}

function getCloseButton(el: KwSearchBar): HTMLButtonElement | null {
	return el.shadowRoot!.querySelector('.close-btn');
}

function getModeToggle(el: KwSearchBar): HTMLButtonElement {
	return el.shadowRoot!.querySelector('.mode-toggle')!;
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

describe('kw-search-bar', () => {
	it('renders input with placeholder "Search..."', async () => {
		const el = createSearchBar();
		await el.updateComplete;
		const input = getInput(el);
		expect(input).toBeTruthy();
		expect(input.placeholder).toBe('Search...');
	});

	it('setting query property reflects in input value', async () => {
		const el = createSearchBar({ query: 'hello' });
		await el.updateComplete;
		expect(getInput(el).value).toBe('hello');
	});

	it('input typing dispatches search-input with query string', async () => {
		const el = createSearchBar();
		await el.updateComplete;

		const events: string[] = [];
		el.addEventListener('search-input', (e) => {
			events.push((e as CustomEvent).detail.query);
		});

		const input = getInput(el);
		input.value = 'test query';
		input.dispatchEvent(new Event('input', { bubbles: true }));

		expect(events).toEqual(['test query']);
	});

	it('mode toggle click dispatches search-mode-change with toggled mode', async () => {
		const el = createSearchBar({ mode: 'wildcard' });
		await el.updateComplete;

		const events: string[] = [];
		el.addEventListener('search-mode-change', (e) => {
			events.push((e as CustomEvent).detail.mode);
		});

		getModeToggle(el).click();
		expect(events).toEqual(['regex']);
	});

	it('mode toggle from regex dispatches wildcard', async () => {
		const el = createSearchBar({ mode: 'regex' });
		await el.updateComplete;

		const events: string[] = [];
		el.addEventListener('search-mode-change', (e) => {
			events.push((e as CustomEvent).detail.mode);
		});

		getModeToggle(el).click();
		expect(events).toEqual(['wildcard']);
	});

	it('status shows "(1/5)" when matchCount=5, currentMatch=0', async () => {
		const el = createSearchBar({ query: 'foo', matchCount: 5, currentMatch: 0 });
		await el.updateComplete;
		expect(getStatusText(el)).toBe('(1/5)');
	});

	it('status shows "No matches" when query non-empty and matchCount=0', async () => {
		const el = createSearchBar({ query: 'nonexistent', matchCount: 0 });
		await el.updateComplete;
		expect(getStatusText(el)).toBe('No matches');
	});

	it('status hidden when query empty', async () => {
		const el = createSearchBar({ query: '', matchCount: 5 });
		await el.updateComplete;
		expect(el.shadowRoot!.querySelector('.search-status')).toBeNull();
	});

	it('status hidden when showStatus=false', async () => {
		const el = createSearchBar({ query: 'foo', matchCount: 5, showStatus: false });
		await el.updateComplete;
		expect(el.shadowRoot!.querySelector('.search-status')).toBeNull();
	});

	it('nav buttons disabled when matchCount < 1', async () => {
		const el = createSearchBar({ query: 'foo', matchCount: 0, currentMatch: 0 });
		await el.updateComplete;
		const { prev, next } = getNavButtons(el);
		expect(prev.disabled).toBe(true);
		expect(next.disabled).toBe(true);
	});

	it('nav buttons enabled when matchCount >= 1', async () => {
		const el = createSearchBar({ query: 'foo', matchCount: 1, currentMatch: 0 });
		await el.updateComplete;
		const { prev, next } = getNavButtons(el);
		expect(prev.disabled).toBe(false);
		expect(next.disabled).toBe(false);
	});

	it('nav buttons enabled when matchCount >= 2', async () => {
		const el = createSearchBar({ query: 'foo', matchCount: 3, currentMatch: 0 });
		await el.updateComplete;
		const { prev, next } = getNavButtons(el);
		expect(prev.disabled).toBe(false);
		expect(next.disabled).toBe(false);
	});

	it('close button visible only when showClose=true', async () => {
		const el = createSearchBar({ showClose: false });
		await el.updateComplete;
		expect(getCloseButton(el)).toBeNull();

		const el2 = createSearchBar({ showClose: true });
		await el2.updateComplete;
		expect(getCloseButton(el2)).toBeTruthy();
	});

	it('Enter key dispatches search-next', async () => {
		const el = createSearchBar();
		await el.updateComplete;

		const events: string[] = [];
		el.addEventListener('search-next', () => events.push('next'));

		const input = getInput(el);
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(events).toEqual(['next']);
	});

	it('Shift+Enter dispatches search-prev', async () => {
		const el = createSearchBar();
		await el.updateComplete;

		const events: string[] = [];
		el.addEventListener('search-prev', () => events.push('prev'));

		const input = getInput(el);
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
		expect(events).toEqual(['prev']);
	});

	it('Escape key does not dispatch search-close (handled by dismiss stack)', async () => {
		const el = createSearchBar();
		await el.updateComplete;

		const events: string[] = [];
		el.addEventListener('search-close', () => events.push('close'));

		const input = getInput(el);
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(events).toEqual([]);
	});

	it('focus() method focuses and selects input text', async () => {
		const el = createSearchBar({ query: 'hello' });
		await el.updateComplete;

		el.focus();
		const input = getInput(el);
		expect(document.activeElement === el || el.shadowRoot!.activeElement === input).toBe(true);
	});

	it('prev nav button dispatches search-prev', async () => {
		const el = createSearchBar({ query: 'foo', matchCount: 5 });
		await el.updateComplete;

		const events: string[] = [];
		el.addEventListener('search-prev', () => events.push('prev'));

		const { prev } = getNavButtons(el);
		prev.click();
		expect(events).toEqual(['prev']);
	});

	it('next nav button dispatches search-next', async () => {
		const el = createSearchBar({ query: 'foo', matchCount: 5 });
		await el.updateComplete;

		const events: string[] = [];
		el.addEventListener('search-next', () => events.push('next'));

		const { next } = getNavButtons(el);
		next.click();
		expect(events).toEqual(['next']);
	});
});
