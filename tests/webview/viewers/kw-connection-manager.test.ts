import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, nothing, html } from 'lit';
import '../../../src/webview/viewers/connection-manager/kw-connection-manager.js';
import type { KwConnectionManager } from '../../../src/webview/viewers/connection-manager/kw-connection-manager.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Messages captured by the mock VS Code API. */
let postedMessages: unknown[] = [];

/** Provide a fake acquireVsCodeApi for the component. */
function installVsCodeMock(): void {
	(globalThis as any).acquireVsCodeApi = () => ({
		postMessage(msg: unknown) { postedMessages.push(msg); },
	});
}

/** Minimal Kusto connection. */
function kustoConnection(id = 'c1', name = 'MyCluster', clusterUrl = 'https://mycluster.kusto.windows.net') {
	return { id, name, clusterUrl };
}

/** Minimal SQL connection. */
function sqlConnection(id = 'sql1', name = 'MySqlServer', serverUrl = 'myserver.database.windows.net') {
	return { id, name, dialect: 'mssql', serverUrl, port: 1433, authType: 'aad' };
}

/** Build a minimal snapshot. */
function snapshot(overrides: Record<string, unknown> = {}) {
	return {
		connections: [kustoConnection()],
		favorites: [],
		cachedDatabases: { 'mycluster.kusto.windows.net': ['db1', 'db2'] },
		expandedClusters: ['c1'],
		leaveNoTraceClusters: [],
		sqlConnections: [sqlConnection()],
		sqlFavorites: [],
		sqlCachedDatabases: { sql1: ['sqldb1'] },
		sqlExpandedConnections: ['sql1'],
		sqlLeaveNoTrace: [],
		activeKind: 'kusto',
		...overrides,
	};
}

function createElement(): KwConnectionManager {
	render(html`<kw-connection-manager></kw-connection-manager>`, container);
	return container.querySelector('kw-connection-manager')!;
}

/** Inject a snapshot message into the component. */
function sendSnapshot(el: KwConnectionManager, snap: ReturnType<typeof snapshot>) {
	window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', snapshot: snap } }));
}

/** Inject a schema-loaded message. */
function sendSchemaLoaded(el: KwConnectionManager, connectionId: string, database: string, schema: Record<string, unknown> = {}) {
	window.dispatchEvent(new MessageEvent('message', { data: { type: 'schemaLoaded', connectionId, database, schema } }));
}

/** Inject a SQL schema-loaded message. */
function sendSqlSchemaLoaded(el: KwConnectionManager, connectionId: string, database: string, schema: Record<string, unknown> = {}) {
	window.dispatchEvent(new MessageEvent('message', { data: { type: 'sql.schemaLoaded', connectionId, database, schema } }));
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let container: HTMLDivElement;

beforeEach(() => {
	postedMessages = [];
	installVsCodeMock();
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	render(nothing, container);
	container.remove();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('kw-connection-manager', () => {

	// ── Breadcrumb refresh ────────────────────────────────────────────────────

	describe('breadcrumb refresh', () => {
		it('Kusto: shows refresh button at cluster level', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;

			// Navigate to cluster level
			const clusterRow = el.shadowRoot!.querySelector('.explorer-list-item');
			expect(clusterRow).not.toBeNull();
			(clusterRow as HTMLElement).click();
			await el.updateComplete;

			const breadcrumbRefresh = el.shadowRoot!.querySelector('.breadcrumb-refresh');
			expect(breadcrumbRefresh).not.toBeNull();
		});

		it('Kusto: cluster-level refresh sends cluster.refreshDatabases', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;

			const clusterRow = el.shadowRoot!.querySelector('.explorer-list-item');
			(clusterRow as HTMLElement).click();
			await el.updateComplete;

			postedMessages = [];
			const refreshBtn = el.shadowRoot!.querySelector('.breadcrumb-refresh') as HTMLButtonElement;
			refreshBtn?.click();
			await el.updateComplete;

			expect(postedMessages).toContainEqual(
				expect.objectContaining({ type: 'cluster.refreshDatabases', connectionId: 'c1' })
			);
		});

		it('Kusto: shows refresh button at database level', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;

			// Drill into cluster
			const clusterRow = el.shadowRoot!.querySelector('.explorer-list-item');
			(clusterRow as HTMLElement).click();
			await el.updateComplete;

			// Drill into database
			const dbRows = el.shadowRoot!.querySelectorAll('.explorer-list-item');
			const dbRow = Array.from(dbRows).find(r => r.textContent?.includes('db1'));
			if (dbRow) (dbRow as HTMLElement).click();
			await el.updateComplete;

			const breadcrumbRefresh = el.shadowRoot!.querySelector('.breadcrumb-refresh');
			expect(breadcrumbRefresh).not.toBeNull();
		});

		it('Kusto: database-level refresh sends database.refreshSchema', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;

			const clusterRow = el.shadowRoot!.querySelector('.explorer-list-item');
			(clusterRow as HTMLElement).click();
			await el.updateComplete;

			const dbRows = el.shadowRoot!.querySelectorAll('.explorer-list-item');
			const dbRow = Array.from(dbRows).find(r => r.textContent?.includes('db1'));
			if (dbRow) (dbRow as HTMLElement).click();
			await el.updateComplete;

			postedMessages = [];
			const refreshBtn = el.shadowRoot!.querySelector('.breadcrumb-refresh') as HTMLButtonElement;
			refreshBtn?.click();
			await el.updateComplete;

			expect(postedMessages).toContainEqual(
				expect.objectContaining({ type: 'database.refreshSchema', database: 'db1' })
			);
		});
	});

	// ── Preview refresh ───────────────────────────────────────────────────────

	describe('preview refresh', () => {
		it('Kusto: empty table shows refresh button', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;

			// Navigate and inject schema + preview data
			const clusterRow = el.shadowRoot!.querySelector('.explorer-list-item');
			(clusterRow as HTMLElement).click();
			await el.updateComplete;

			const dbRows = el.shadowRoot!.querySelectorAll('.explorer-list-item');
			const dbRow = Array.from(dbRows).find(r => r.textContent?.includes('db1'));
			if (dbRow) (dbRow as HTMLElement).click();
			await el.updateComplete;

			// Inject schema
			sendSchemaLoaded(el, 'c1', 'db1', { tables: ['TestTable'], columnTypesByTable: { TestTable: { col1: 'string' } } });
			await el.updateComplete;

			// Navigate to tables
			const tableSection = Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item')).find(r => r.textContent?.includes('Tables'));
			if (tableSection) (tableSection as HTMLElement).click();
			await el.updateComplete;

			// Expand table
			const tableRow = Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item')).find(r => r.textContent?.includes('TestTable'));
			if (tableRow) (tableRow as HTMLElement).click();
			await el.updateComplete;

			// Inject empty preview
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'tablePreviewResult',
				connectionId: 'c1', database: 'db1', tableName: 'TestTable',
				success: true, columns: [{ name: 'col1' }], rows: [], rowCount: 0,
			} }));
			await el.updateComplete;

			// Check for "Table is empty." text and refresh button nearby
			const emptyText = el.shadowRoot!.querySelector('.explorer-item-details');
			expect(emptyText?.textContent).toContain('Table is empty.');
			const refreshInEmpty = emptyText?.querySelector('.breadcrumb-refresh');
			expect(refreshInEmpty).not.toBeNull();
		});

		it('Kusto: results header has refresh button', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;

			const clusterRow = el.shadowRoot!.querySelector('.explorer-list-item');
			(clusterRow as HTMLElement).click();
			await el.updateComplete;

			const dbRows = el.shadowRoot!.querySelectorAll('.explorer-list-item');
			const dbRow = Array.from(dbRows).find(r => r.textContent?.includes('db1'));
			if (dbRow) (dbRow as HTMLElement).click();
			await el.updateComplete;

			sendSchemaLoaded(el, 'c1', 'db1', { tables: ['TestTable'], columnTypesByTable: { TestTable: { col1: 'string' } } });
			await el.updateComplete;

			const tableSection = Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item')).find(r => r.textContent?.includes('Tables'));
			if (tableSection) (tableSection as HTMLElement).click();
			await el.updateComplete;

			const tableRow = Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item')).find(r => r.textContent?.includes('TestTable'));
			if (tableRow) (tableRow as HTMLElement).click();
			await el.updateComplete;

			// Inject preview with rows
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'tablePreviewResult',
				connectionId: 'c1', database: 'db1', tableName: 'TestTable',
				success: true, columns: [{ name: 'col1' }], rows: [['value1']], rowCount: 1,
			} }));
			await el.updateComplete;

			const previewHeader = el.shadowRoot!.querySelector('.preview-result-header');
			expect(previewHeader).not.toBeNull();
			expect(previewHeader?.textContent).toContain('PREVIEW TOP 100 ROWS');
			// Has both refresh and dismiss buttons
			const buttons = previewHeader?.querySelectorAll('.preview-result-dismiss');
			expect(buttons?.length).toBeGreaterThanOrEqual(2);
		});
	});

	// ── Row hover refresh ─────────────────────────────────────────────────────

	describe('row hover refresh icons', () => {
		it('Kusto: table row has refresh button in actions', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;

			const clusterRow = el.shadowRoot!.querySelector('.explorer-list-item');
			(clusterRow as HTMLElement).click();
			await el.updateComplete;

			const dbRows = el.shadowRoot!.querySelectorAll('.explorer-list-item');
			const dbRow = Array.from(dbRows).find(r => r.textContent?.includes('db1'));
			if (dbRow) (dbRow as HTMLElement).click();
			await el.updateComplete;

			sendSchemaLoaded(el, 'c1', 'db1', { tables: ['TestTable'], columnTypesByTable: { TestTable: { col1: 'string' } } });
			await el.updateComplete;

			const tableSection = Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item')).find(r => r.textContent?.includes('Tables'));
			if (tableSection) (tableSection as HTMLElement).click();
			await el.updateComplete;

			// Table row should have actions with refresh
			const tableRow = Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item')).find(r => r.textContent?.includes('TestTable'));
			const actions = tableRow?.querySelector('.explorer-list-item-actions');
			expect(actions).not.toBeNull();
			const refreshBtn = actions?.querySelector('.btn-icon');
			expect(refreshBtn).not.toBeNull();
			expect(refreshBtn?.getAttribute('title')).toContain('Refresh');
		});

		it('Kusto: table row refresh sends database.refreshSchema', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;

			const clusterRow = el.shadowRoot!.querySelector('.explorer-list-item');
			(clusterRow as HTMLElement).click();
			await el.updateComplete;

			const dbRows = el.shadowRoot!.querySelectorAll('.explorer-list-item');
			const dbRow = Array.from(dbRows).find(r => r.textContent?.includes('db1'));
			if (dbRow) (dbRow as HTMLElement).click();
			await el.updateComplete;

			sendSchemaLoaded(el, 'c1', 'db1', { tables: ['TestTable'], columnTypesByTable: { TestTable: { col1: 'string' } } });
			await el.updateComplete;

			const tableSection = Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item')).find(r => r.textContent?.includes('Tables'));
			if (tableSection) (tableSection as HTMLElement).click();
			await el.updateComplete;

			postedMessages = [];
			const tableRow = Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item')).find(r => r.textContent?.includes('TestTable'));
			const refreshBtn = tableRow?.querySelector('.explorer-list-item-actions .btn-icon') as HTMLButtonElement;
			refreshBtn?.click();
			await el.updateComplete;

			expect(postedMessages).toContainEqual(
				expect.objectContaining({ type: 'database.refreshSchema', database: 'db1' })
			);
		});

		it('Kusto: table row refresh click does not toggle expand', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;

			const clusterRow = el.shadowRoot!.querySelector('.explorer-list-item');
			(clusterRow as HTMLElement).click();
			await el.updateComplete;

			const dbRows = el.shadowRoot!.querySelectorAll('.explorer-list-item');
			const dbRow = Array.from(dbRows).find(r => r.textContent?.includes('db1'));
			if (dbRow) (dbRow as HTMLElement).click();
			await el.updateComplete;

			sendSchemaLoaded(el, 'c1', 'db1', { tables: ['TestTable'], columnTypesByTable: { TestTable: { col1: 'string' } } });
			await el.updateComplete;

			const tableSection = Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item')).find(r => r.textContent?.includes('Tables'));
			if (tableSection) (tableSection as HTMLElement).click();
			await el.updateComplete;

			// Before clicking refresh, the table should NOT be expanded (no details visible)
			let details = el.shadowRoot!.querySelector('.explorer-item-details');
			expect(details).toBeNull();

			// Click the refresh button (which has stopPropagation)
			const tableRow = Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item')).find(r => r.textContent?.includes('TestTable'));
			const refreshBtn = tableRow?.querySelector('.explorer-list-item-actions .btn-icon') as HTMLButtonElement;
			refreshBtn?.click();
			await el.updateComplete;

			// After refresh click, table should still NOT be expanded
			details = el.shadowRoot!.querySelector('.explorer-item-details');
			expect(details).toBeNull();
		});

		it('Kusto: function row has refresh button', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;

			const clusterRow = el.shadowRoot!.querySelector('.explorer-list-item');
			(clusterRow as HTMLElement).click();
			await el.updateComplete;

			const dbRows = el.shadowRoot!.querySelectorAll('.explorer-list-item');
			const dbRow = Array.from(dbRows).find(r => r.textContent?.includes('db1'));
			if (dbRow) (dbRow as HTMLElement).click();
			await el.updateComplete;

			sendSchemaLoaded(el, 'c1', 'db1', { tables: [], functions: [{ name: 'MyFunc', parametersText: 'x: int' }] });
			await el.updateComplete;

			const fnSection = Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item')).find(r => r.textContent?.includes('Functions'));
			if (fnSection) (fnSection as HTMLElement).click();
			await el.updateComplete;

			const fnRow = Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item')).find(r => r.textContent?.includes('MyFunc'));
			const actions = fnRow?.querySelector('.explorer-list-item-actions');
			expect(actions).not.toBeNull();
			const refreshBtn = actions?.querySelector('.btn-icon');
			expect(refreshBtn).not.toBeNull();
		});
	});

	// ── Icon rendering ────────────────────────────────────────────────────────

	describe('icon rendering', () => {
		it('renders codicon refresh icon (not SVG) in action buttons', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;

			// The cluster row has hover action buttons including refresh
			const actionBtns = el.shadowRoot!.querySelectorAll('.explorer-list-item-actions .btn-icon');
			const refreshBtn = Array.from(actionBtns).find(btn => btn.getAttribute('title') === 'Refresh');
			if (refreshBtn) {
				// Should contain a codicon span, not an SVG
				const codiconSpan = refreshBtn.querySelector('.codicon.codicon-refresh');
				const svgIcon = refreshBtn.querySelector('svg');
				expect(codiconSpan).not.toBeNull();
				expect(svgIcon).toBeNull();
			}
		});

		it('renders codicon delete icon in action buttons', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;

			const actionBtns = el.shadowRoot!.querySelectorAll('.explorer-list-item-actions .btn-icon');
			const deleteBtn = Array.from(actionBtns).find(btn => btn.getAttribute('title') === 'Delete');
			if (deleteBtn) {
				const codiconSpan = deleteBtn.querySelector('.codicon.codicon-trash');
				expect(codiconSpan).not.toBeNull();
			}
		});

		it('renders codicon edit icon in action buttons', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;

			const actionBtns = el.shadowRoot!.querySelectorAll('.explorer-list-item-actions .btn-icon');
			const editBtn = Array.from(actionBtns).find(btn => btn.getAttribute('title') === 'Edit');
			if (editBtn) {
				const codiconSpan = editBtn.querySelector('.codicon.codicon-edit');
				expect(codiconSpan).not.toBeNull();
			}
		});
	});
});
