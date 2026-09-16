import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../../src/webview/sections/kw-query-toolbar.js';
import type { KwQueryToolbar } from '../../src/webview/sections/kw-query-toolbar.js';
import { toggleRunMenu } from '../../src/webview/sections/kw-query-toolbar.js';
import { removeQueryBox } from '../../src/webview/core/section-factory.js';
import { queryBoxes } from '../../src/webview/core/state.js';

let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	document.querySelectorAll<HTMLElement>('.cache-popup').forEach(popup =>
		(popup as HTMLElement & { _kustoCacheClose?: () => void })._kustoCacheClose?.());
	queryBoxes.length = 0;
	container.remove();
});

describe('Kusto toolbar menu dismissal', () => {
	it('closes the Tools submenu with Escape', async () => {
		const toolbar = document.createElement('kw-query-toolbar') as KwQueryToolbar;
		toolbar.boxId = 'query_menu';
		container.appendChild(toolbar);
		await toolbar.updateComplete;

		(toolbar.querySelector('button[aria-label="Tools"]') as HTMLButtonElement).click();
		await toolbar.updateComplete;
		expect(toolbar.querySelector('button[aria-label="Tools"]')?.getAttribute('aria-expanded')).toBe('true');

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await toolbar.updateComplete;

		expect(toolbar.querySelector('button[aria-label="Tools"]')?.getAttribute('aria-expanded')).toBe('false');
	});

	it('closes the run-mode menu with Escape', () => {
		const menu = document.createElement('div');
		menu.id = 'query_run_run_menu';
		menu.style.display = 'none';
		container.appendChild(menu);

		toggleRunMenu('query_run');
		expect(menu.style.display).toBe('block');

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

		expect(menu.style.display).toBe('none');
	});

	it('keeps the run-mode menu open when a press starts inside and releases outside', () => {
		const boxId = 'query_drag_release';
		const menu = document.createElement('div');
		menu.id = `${boxId}_run_menu`;
		menu.className = 'unified-btn-split-menu';
		menu.style.display = 'none';
		container.appendChild(menu);
		queryBoxes.push(boxId);

		toggleRunMenu(boxId);
		menu.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
		document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
		document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
		expect(menu.style.display).toBe('block');

		document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
		expect(menu.style.display).toBe('none');
	});

	it('keeps the cache popup open when a press starts inside and releases outside', async () => {
		const boxId = 'query_cache_drag';
		const label = document.createElement('span');
		label.id = `${boxId}_cache_label`;
		const popup = document.createElement('div') as HTMLElement & { _kustoCacheClose?: () => void };
		popup.id = `${boxId}_cache_popup`;
		popup.className = 'cache-popup';
		const input = document.createElement('input');
		popup.appendChild(input);
		container.append(label, popup);

		window.toggleCachePopup(boxId);
		await new Promise(resolve => setTimeout(resolve, 0));
		input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
		document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
		document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
		expect(popup.classList.contains('open')).toBe(true);

		document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
		expect(popup.classList.contains('open')).toBe(false);
	});

	it('does not install a stale cache-popup listener after immediate close', () => {
		vi.useFakeTimers();
		const addListener = vi.spyOn(document, 'addEventListener');
		const boxId = 'query_cache_immediate_close';
		const label = document.createElement('span');
		label.id = `${boxId}_cache_label`;
		const popup = document.createElement('div');
		popup.id = `${boxId}_cache_popup`;
		popup.className = 'cache-popup';
		container.append(label, popup);

		try {
			window.toggleCachePopup(boxId);
			window.toggleCachePopup(boxId);
			vi.runOnlyPendingTimers();
			expect(addListener.mock.calls.some(([type]) => type === 'mousedown')).toBe(false);
		} finally {
			addListener.mockRestore();
			vi.useRealTimers();
		}
	});

	it('keeps a section-mode popup open when a press starts inside and releases outside', () => {
		const dropdown = document.createElement('div');
		dropdown.className = 'section-mode-dropdown';
		const menu = document.createElement('div');
		menu.className = 'section-mode-dropdown-menu';
		menu.style.display = 'block';
		dropdown.appendChild(menu);
		container.appendChild(dropdown);

		menu.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
		document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
		document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
		expect(menu.style.display).toBe('block');

		document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
		expect(menu.style.display).toBe('none');
	});

	it('retires the run-mode menu before programmatic section removal', () => {
		const section = document.createElement('div');
		section.id = 'query_removed';
		const menu = document.createElement('div');
		menu.id = 'query_removed_run_menu';
		menu.style.display = 'none';
		section.appendChild(menu);
		container.appendChild(section);
		toggleRunMenu('query_removed');
		expect(menu.style.display).toBe('block');

		removeQueryBox('query_removed');

		expect(menu.style.display).toBe('none');
		expect(document.getElementById('query_removed')).toBeNull();
	});
});