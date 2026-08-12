import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import '../../src/webview/sections/kw-query-toolbar.js';
import type { KwQueryToolbar } from '../../src/webview/sections/kw-query-toolbar.js';
import { toggleRunMenu } from '../../src/webview/sections/kw-query-toolbar.js';

let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
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
});