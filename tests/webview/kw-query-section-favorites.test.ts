import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { html, render, nothing } from 'lit';
import '../../src/webview/components/kw-dropdown.js';
import '../../src/webview/sections/kw-query-section.js';
import type { KwQuerySection } from '../../src/webview/sections/kw-query-section.js';
import type { KwDropdown } from '../../src/webview/components/kw-dropdown.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	render(nothing, container);
	container.remove();
});

function createSection(boxId = 'test1'): KwQuerySection {
	render(html`<kw-query-section box-id=${boxId}></kw-query-section>`, container);
	return container.querySelector('kw-query-section')! as KwQuerySection;
}

function getFavoritesDropdown(el: KwQuerySection): KwDropdown | null {
	// In favorites mode, the only kw-dropdown is the favorites one
	return el.shadowRoot!.querySelector('.kusto-favorites-combo kw-dropdown') as KwDropdown | null;
}

function getDropdownButtonText(dropdown: KwDropdown): string {
	const btnText = dropdown.shadowRoot!.querySelector('.kusto-dropdown-btn-text');
	return btnText?.textContent?.trim() || '';
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('kw-query-section favorites dropdown', () => {

	it('shows selected favorite label when connection+database match a favorite', async () => {
		const el = createSection();
		await el.updateComplete;

		el.setConnections([
			{ id: 'conn1', clusterUrl: 'https://cluster1.kusto.windows.net' },
		]);
		el.setConnectionId('conn1');
		el.setDatabase('MyDb');
		el.setFavorites([
			{ clusterUrl: 'https://cluster1.kusto.windows.net', database: 'MyDb', name: 'My Favorite' },
		]);
		el.setFavoritesMode(true);
		await el.updateComplete;

		const dropdown = getFavoritesDropdown(el);
		expect(dropdown).not.toBeNull();

		// The selectedId should match the favorite's index
		expect(dropdown!.selectedId).toBe('0');

		await dropdown!.updateComplete;
		// Button text should show the favorite's name, not the placeholder
		const text = getDropdownButtonText(dropdown!);
		expect(text).not.toBe('Select favorite...');
		expect(text).toContain('My Favorite');
	});

	it('shows placeholder when no favorite matches current connection', async () => {
		const el = createSection();
		await el.updateComplete;

		el.setConnections([
			{ id: 'conn1', clusterUrl: 'https://cluster1.kusto.windows.net' },
		]);
		el.setConnectionId('conn1');
		el.setDatabase('OtherDb');
		el.setFavorites([
			{ clusterUrl: 'https://cluster1.kusto.windows.net', database: 'MyDb', name: 'My Favorite' },
		]);
		el.setFavoritesMode(true);
		await el.updateComplete;

		const dropdown = getFavoritesDropdown(el);
		expect(dropdown).not.toBeNull();
		expect(dropdown!.selectedId).toBe('');

		await dropdown!.updateComplete;
		expect(getDropdownButtonText(dropdown!)).toBe('Select favorite...');
	});

	it('shows correct favorite when multiple favorites exist', async () => {
		const el = createSection();
		await el.updateComplete;

		el.setConnections([
			{ id: 'conn1', clusterUrl: 'https://cluster1.kusto.windows.net' },
			{ id: 'conn2', clusterUrl: 'https://cluster2.kusto.windows.net' },
		]);
		el.setConnectionId('conn2');
		el.setDatabase('ProdDb');
		el.setFavorites([
			{ clusterUrl: 'https://cluster1.kusto.windows.net', database: 'DevDb', name: 'Dev' },
			{ clusterUrl: 'https://cluster2.kusto.windows.net', database: 'ProdDb', name: 'Production' },
		]);
		el.setFavoritesMode(true);
		await el.updateComplete;

		const dropdown = getFavoritesDropdown(el);
		expect(dropdown).not.toBeNull();

		// Note: setFavorites sorts alphabetically by name, so Dev=0, Production=1
		expect(dropdown!.selectedId).toBe('1');

		await dropdown!.updateComplete;
		expect(getDropdownButtonText(dropdown!)).toContain('Production');
	});
});
