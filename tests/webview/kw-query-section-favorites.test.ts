import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { html, render, nothing } from 'lit';
import '../../src/webview/components/kw-dropdown.js';
import '../../src/webview/sections/kw-query-section.js';
import type { KwQuerySection } from '../../src/webview/sections/kw-query-section.js';
import type { KwDropdown } from '../../src/webview/components/kw-dropdown.js';
import { setKustoFavorites, setQueryBoxes } from '../../src/webview/core/state.js';
import { __kustoUpdateFavoritesUiForAllBoxes } from '../../src/webview/sections/query-connection.controller.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	setKustoFavorites([]);
	setQueryBoxes([]);
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

	it('updates favorites dropdowns for every Kusto section in the current webview', async () => {
		render(html`
			<kw-query-section id="query_a" box-id="query_a"></kw-query-section>
			<kw-query-section id="query_b" box-id="query_b"></kw-query-section>
		`, container);
		const sections = Array.from(container.querySelectorAll('kw-query-section')) as KwQuerySection[];
		for (const el of sections) {
			el.setFavoritesMode(true);
			await el.updateComplete;
		}

		setQueryBoxes(['query_a', 'query_b']);
		setKustoFavorites([
			{ connectionId: 'shared', clusterUrl: 'https://shared.kusto.windows.net', database: 'Samples', name: 'Shared Favorite' },
		]);
		__kustoUpdateFavoritesUiForAllBoxes();
		for (const el of sections) await el.updateComplete;

		for (const el of sections) {
			const dropdown = getFavoritesDropdown(el);
			expect(dropdown).not.toBeNull();
			expect(dropdown!.items.map(item => item.label)).toContain('Shared Favorite');
		}
	});

	it('shows selected favorite label when connection+database match a favorite', async () => {
		const el = createSection();
		await el.updateComplete;

		el.setConnections([
			{ id: 'conn1', clusterUrl: 'https://cluster1.kusto.windows.net' },
		]);
		el.setConnectionId('conn1');
		el.setDatabase('MyDb');
		el.setFavorites([
			{ connectionId: 'conn1', clusterUrl: 'https://cluster1.kusto.windows.net', database: 'MyDb', name: 'My Favorite' },
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

	it('matches favorite short regional host to full ADX connection host', async () => {
		const el = createSection();
		await el.updateComplete;

		el.setConnections([
			{ id: 'conn1', clusterUrl: 'https://semantic-current.westus.kusto.windows.net' },
		]);
		el.setConnectionId('conn1');
		el.setDatabase('TelemetryDb');
		el.setFavorites([
			{ connectionId: 'conn1', clusterUrl: 'semantic-current.westus', database: 'TelemetryDb', name: 'Synthetic Favorite' },
		]);
		el.setFavoritesMode(true);
		await el.updateComplete;

		const dropdown = getFavoritesDropdown(el);
		expect(dropdown).not.toBeNull();
		expect(dropdown!.selectedId).toBe('0');
		expect(el.getClusterUrl()).toBe('https://semantic-current.westus.kusto.windows.net');
		expect(el.getDatabase()).toBe('TelemetryDb');
	});

	it('matches favorite full ADX host to short regional connection host', async () => {
		const el = createSection();
		await el.updateComplete;

		el.setConnections([
			{ id: 'conn1', clusterUrl: 'semantic-current.westus' },
		]);
		el.setConnectionId('conn1');
		el.setDatabase('TelemetryDb');
		el.setFavorites([
			{ connectionId: 'conn1', clusterUrl: 'https://semantic-current.westus.kusto.windows.net', database: 'TelemetryDb', name: 'Synthetic Favorite' },
		]);
		el.setFavoritesMode(true);
		await el.updateComplete;

		const dropdown = getFavoritesDropdown(el);
		expect(dropdown).not.toBeNull();
		expect(dropdown!.selectedId).toBe('0');
		expect(el.getClusterUrl()).toBe('semantic-current.westus');
		expect(el.getDatabase()).toBe('TelemetryDb');
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
			{ connectionId: 'conn1', clusterUrl: 'https://cluster1.kusto.windows.net', database: 'MyDb', name: 'My Favorite' },
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
			{ connectionId: 'conn1', clusterUrl: 'https://cluster1.kusto.windows.net', database: 'DevDb', name: 'Dev' },
			{ connectionId: 'conn2', clusterUrl: 'https://cluster2.kusto.windows.net', database: 'ProdDb', name: 'Production' },
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

	it('keeps a user-selected same-endpoint authority after connections refresh', async () => {
		const el = createSection();
		await el.updateComplete;
		const connections = [
			{ id: 'home', clusterUrl: 'https://shared.kusto.windows.net', authorityId: 'home.example.com' },
			{ id: 'guest', clusterUrl: 'https://shared.kusto.windows.net', authorityId: 'guest.example.com' },
		];
		el.setConnections(connections);
		el.setDesiredClusterUrl(connections[0].clusterUrl);
		el.setDesiredConnectionIdentity(connections[0].authorityId, connections[0].id);
		el.setConnections(connections);
		expect(el.getConnectionId()).toBe('home');

		el.setConnectionId('guest');
		el.setConnections(connections);

		expect(el.getConnectionId()).toBe('guest');
		expect(el.serialize()).toEqual(expect.objectContaining({
			clusterUrl: connections[1].clusterUrl,
			authorityId: 'guest.example.com',
			connectionIdHint: 'guest',
		}));
	});

	it('serializes visible Copilot chat state', async () => {
		const el = createSection();
		await el.updateComplete;

		const chat = el.shadowRoot?.querySelector('kw-copilot-chat') as any;
		if (chat) chat.focusInput = () => undefined;
		el.setCopilotChatVisible(true);

		expect(el.serialize()).toEqual(expect.objectContaining({ copilotChatVisible: true }));
	});
});
