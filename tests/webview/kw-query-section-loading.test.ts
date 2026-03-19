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

function getRefreshButton(el: KwQuerySection): HTMLButtonElement | null {
	return el.shadowRoot!.querySelector('.refresh-btn-wrap button') as HTMLButtonElement | null;
}

function getDatabaseDropdown(el: KwQuerySection): KwDropdown | null {
	return el.shadowRoot!.querySelector('.select-wrapper.half-width:nth-child(2) kw-dropdown') as KwDropdown | null;
}

function hasSpinner(el: KwQuerySection): boolean {
	return el.shadowRoot!.querySelector('.query-spinner') !== null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('kw-query-section loading states', () => {

	it('refresh button shows spinner when setRefreshLoading(true)', async () => {
		const el = createSection();
		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setConnectionId('c1');
		await el.updateComplete;

		el.setRefreshLoading(true);
		await el.updateComplete;

		expect(hasSpinner(el)).toBe(true);
		const btn = getRefreshButton(el);
		expect(btn).not.toBeNull();
		expect(btn!.disabled).toBe(true);
	});

	it('refresh button stops spinner when setRefreshLoading(false)', async () => {
		const el = createSection();
		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setConnectionId('c1');
		await el.updateComplete;

		el.setRefreshLoading(true);
		await el.updateComplete;
		expect(hasSpinner(el)).toBe(true);

		el.setRefreshLoading(false);
		await el.updateComplete;
		expect(hasSpinner(el)).toBe(false);
		const btn = getRefreshButton(el);
		expect(btn!.disabled).toBe(false);
	});

	it('database dropdown shows loading state when setDatabasesLoading(true)', async () => {
		const el = createSection();
		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setConnectionId('c1');
		await el.updateComplete;

		el.setDatabasesLoading(true);
		await el.updateComplete;

		const dropdown = getDatabaseDropdown(el);
		expect(dropdown).not.toBeNull();
		expect(dropdown!.loading).toBe(true);
	});

	it('setDatabases() resets databasesLoading to false (success path)', async () => {
		const el = createSection();
		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setConnectionId('c1');
		await el.updateComplete;

		el.setDatabasesLoading(true);
		await el.updateComplete;

		el.setDatabases(['db1', 'db2']);
		await el.updateComplete;

		const dropdown = getDatabaseDropdown(el);
		expect(dropdown!.loading).toBe(false);
	});

	it('setDatabasesLoading(false) resets loading after error (error path)', async () => {
		const el = createSection();
		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setConnectionId('c1');
		await el.updateComplete;

		// Simulate: refreshDatabases sets both loading flags
		el.setRefreshLoading(true);
		el.setDatabasesLoading(true);
		await el.updateComplete;

		// Verify both are loading
		expect(hasSpinner(el)).toBe(true);
		const dropdown = getDatabaseDropdown(el);
		expect(dropdown!.loading).toBe(true);

		// Simulate: error path must reset both
		el.setRefreshLoading(false);
		el.setDatabasesLoading(false);
		await el.updateComplete;

		// Verify both loading states are cleared
		expect(hasSpinner(el)).toBe(false);
		expect(dropdown!.loading).toBe(false);
		const btn = getRefreshButton(el);
		expect(btn!.disabled).toBe(false);
	});

	it('loading states survive rapid toggle (no stale state)', async () => {
		const el = createSection();
		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setConnectionId('c1');
		await el.updateComplete;

		// Rapid: set loading, then immediately clear
		el.setRefreshLoading(true);
		el.setDatabasesLoading(true);
		el.setRefreshLoading(false);
		el.setDatabasesLoading(false);
		await el.updateComplete;

		expect(hasSpinner(el)).toBe(false);
		const dropdown = getDatabaseDropdown(el);
		expect(dropdown!.loading).toBe(false);
	});
});
