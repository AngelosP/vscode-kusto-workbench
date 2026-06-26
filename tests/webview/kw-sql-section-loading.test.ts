import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { html, render, nothing } from 'lit';
import '../../src/webview/components/kw-dropdown.js';
import '../../src/webview/sections/kw-sql-section.js';
import type { KwSqlSection } from '../../src/webview/sections/kw-sql-section.js';

let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	render(nothing, container);
	container.remove();
});

function createSection(boxId = 'sql_test1'): KwSqlSection {
	render(html`<kw-sql-section box-id=${boxId}></kw-sql-section>`, container);
	return container.querySelector('kw-sql-section')! as KwSqlSection;
}

describe('kw-sql-section loading states', () => {
	it('preserves restored server intent until a matching SQL connection is available', async () => {
		const el = createSection();
		const connectionEvents: CustomEvent[] = [];
		el.addEventListener('sql-connection-changed', event => connectionEvents.push(event as CustomEvent));

		el.setDesiredServerUrl('tcp:saved.database.windows.net,1433');
		el.setDesiredDatabase('SavedDb');
		el.setConnections([
			{ id: 'existing', name: 'Existing', serverUrl: 'tcp:existing.database.windows.net,1433', dialect: 'mssql', authType: 'aad' },
		], { lastConnectionId: 'existing' });
		await el.updateComplete;

		expect(el.getConnectionId()).toBe('');
		expect(el.getSqlConnectionId()).toBe('');
		expect(el.getServerUrl()).toBe('');
		expect(connectionEvents).toHaveLength(0);

		el.setConnections([
			{ id: 'existing', name: 'Existing', serverUrl: 'tcp:existing.database.windows.net,1433', dialect: 'mssql', authType: 'aad' },
			{ id: 'saved', name: 'Saved', serverUrl: 'tcp:saved.database.windows.net,1433', dialect: 'mssql', authType: 'aad' },
		], { lastConnectionId: 'existing' });
		await el.updateComplete;

		expect(el.getConnectionId()).toBe('saved');
		expect(el.getSqlConnectionId()).toBe('saved');
		expect(el.getServerUrl()).toBe('tcp:saved.database.windows.net,1433');
		expect(connectionEvents).toHaveLength(1);
		expect(connectionEvents[0].detail).toMatchObject({
			boxId: 'sql_test1',
			connectionId: 'saved',
			serverUrl: 'tcp:saved.database.windows.net,1433',
			database: 'SavedDb',
		});
	});
});