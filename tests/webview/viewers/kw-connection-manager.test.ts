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

function listItemNames(el: KwConnectionManager): string[] {
	return Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item-name'))
		.map(node => (node.textContent ?? '').trim());
}

function columnNames(el: KwConnectionManager): string[] {
	return Array.from(el.shadowRoot!.querySelectorAll('.explorer-schema-col-name'))
		.map(node => (node.textContent ?? '').trim());
}

function clickListItemByName(el: KwConnectionManager, name: string): void {
	const row = Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item'))
		.find(item => item.querySelector('.explorer-list-item-name')?.textContent?.trim() === name);
	expect(row).not.toBeUndefined();
	(row as HTMLElement).click();
}

function clickBreadcrumbByText(el: KwConnectionManager, text: string): void {
	const breadcrumb = Array.from(el.shadowRoot!.querySelectorAll('.breadcrumb-item'))
		.find(item => item.textContent?.includes(text));
	expect(breadcrumb).not.toBeUndefined();
	(breadcrumb as HTMLElement).click();
}

function clickButtonByTestId(el: KwConnectionManager, testId: string): void {
	const button = el.shadowRoot!.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
	expect(button).not.toBeNull();
	button!.click();
}

function messageTypes(): string[] {
	return postedMessages
		.map(message => (message && typeof message === 'object' && 'type' in message ? String((message as { type?: unknown }).type) : ''))
		.filter(Boolean);
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

	// ── Alphabetical ordering ──────────────────────────────────────────────────

	describe('alphabetical sorting', () => {
		it('Kusto: sorts clusters by displayed name', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({
				connections: [
					kustoConnection('c-zeta', 'zeta Cluster', 'https://zeta.kusto.windows.net'),
					kustoConnection('c-alpha', 'alpha Cluster', 'https://alpha.kusto.windows.net'),
					kustoConnection('c-beta', 'Beta Cluster', 'https://beta.kusto.windows.net'),
				],
				cachedDatabases: {},
			}));
			await el.updateComplete;

			expect(listItemNames(el)).toEqual(['alpha Cluster', 'Beta Cluster', 'zeta Cluster']);
			expect(postedMessages).toContainEqual(expect.objectContaining({ type: 'cluster.expand', connectionId: 'c-alpha' }));
		});

		it('Kusto: sorts databases, folders, tables, and columns while keeping folders first', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({
				cachedDatabases: { 'mycluster.kusto.windows.net': ['zetaDb', 'AlphaDb', 'betaDb'] },
			}));
			await el.updateComplete;

			clickListItemByName(el, 'MyCluster');
			await el.updateComplete;
			expect(listItemNames(el)).toEqual(['AlphaDb', 'betaDb', 'zetaDb']);

			clickListItemByName(el, 'AlphaDb');
			await el.updateComplete;
			sendSchemaLoaded(el, 'c1', 'AlphaDb', {
				tables: ['zRoot', 'betaRoot', 'AlphaRoot', 'zChild', 'alphaChild'],
				tableFolders: { zChild: 'Zoo', alphaChild: 'Apple' },
				columnTypesByTable: {
					AlphaRoot: { zCol: 'string', alphaCol: 'long', BetaCol: 'int' },
				},
			});
			await el.updateComplete;

			clickListItemByName(el, 'Tables');
			await el.updateComplete;
			expect(listItemNames(el)).toEqual(['Apple', 'Zoo', 'AlphaRoot', 'betaRoot', 'zRoot']);

			clickListItemByName(el, 'AlphaRoot');
			await el.updateComplete;
			expect(columnNames(el)).toEqual(['alphaCol', 'BetaCol', 'zCol']);
		});

		it('Kusto: sorts function folders and functions while keeping folders first', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({
				cachedDatabases: { 'mycluster.kusto.windows.net': ['AlphaDb'] },
			}));
			await el.updateComplete;

			clickListItemByName(el, 'MyCluster');
			await el.updateComplete;
			clickListItemByName(el, 'AlphaDb');
			await el.updateComplete;
			sendSchemaLoaded(el, 'c1', 'AlphaDb', {
				tables: [],
				functions: [
					{ name: 'zRoot' },
					{ name: 'alphaRoot' },
					{ name: 'zChild', folder: 'Zoo' },
					{ name: 'alphaChild', folder: 'Apple' },
				],
			});
			await el.updateComplete;

			clickListItemByName(el, 'Functions');
			await el.updateComplete;
			expect(listItemNames(el)).toEqual(['Apple', 'Zoo', 'alphaRoot', 'zRoot']);
		});

		it('SQL: sorts connections, databases, schema objects, and columns without mutating schema arrays', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({
				activeKind: 'sql',
				connections: [],
				cachedDatabases: {},
				sqlConnections: [
					sqlConnection('sql-zeta', 'zeta Server', 'zeta.database.windows.net'),
					sqlConnection('sql-alpha', 'alpha Server', 'alpha.database.windows.net'),
					sqlConnection('sql-beta', 'Beta Server', 'beta.database.windows.net'),
				],
				sqlCachedDatabases: {
					'sql-alpha': ['zetaDb', 'AlphaDb', 'betaDb'],
					'sql-beta': [],
					'sql-zeta': [],
				},
			}));
			await el.updateComplete;
			expect(listItemNames(el)).toEqual(['alpha Server', 'Beta Server', 'zeta Server']);

			clickListItemByName(el, 'alpha Server');
			await el.updateComplete;
			expect(listItemNames(el)).toEqual(['AlphaDb', 'betaDb', 'zetaDb']);

			clickListItemByName(el, 'AlphaDb');
			await el.updateComplete;
			const sqlSchema = {
				tables: ['zTable', 'AlphaTable'],
				views: ['zView', 'AlphaView'],
				storedProcedures: [{ name: 'zProc' }, { name: 'AlphaProc' }],
				columnsByTable: {
					AlphaTable: { zCol: 'int', alphaCol: 'nvarchar' },
					AlphaView: { zViewCol: 'int', alphaViewCol: 'nvarchar' },
				},
			};
			sendSqlSchemaLoaded(el, 'sql-alpha', 'AlphaDb', sqlSchema);
			await el.updateComplete;

			clickListItemByName(el, 'Tables');
			await el.updateComplete;
			expect(listItemNames(el)).toEqual(['AlphaTable', 'zTable']);
			clickListItemByName(el, 'AlphaTable');
			await el.updateComplete;
			expect(columnNames(el)).toEqual(['alphaCol', 'zCol']);

			clickBreadcrumbByText(el, 'AlphaDb');
			await el.updateComplete;
			clickListItemByName(el, 'Views');
			await el.updateComplete;
			expect(listItemNames(el)).toEqual(['AlphaView', 'zView']);

			clickBreadcrumbByText(el, 'AlphaDb');
			await el.updateComplete;
			clickListItemByName(el, 'Stored Procedures');
			await el.updateComplete;
			expect(listItemNames(el)).toEqual(['AlphaProc', 'zProc']);
			expect(sqlSchema.tables).toEqual(['zTable', 'AlphaTable']);
			expect(sqlSchema.views).toEqual(['zView', 'AlphaView']);
			expect(sqlSchema.storedProcedures.map(procedure => procedure.name)).toEqual(['zProc', 'AlphaProc']);
		});
	});

	// ── Favorites ───────────────────────────────────────────────────────────────

	describe('favorites', () => {
		it('Kusto: add favorite requests a friendly-name prompt', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;

			clickListItemByName(el, 'MyCluster');
			await el.updateComplete;

			postedMessages = [];
			clickButtonByTestId(el, 'cm-favorite-add');
			await el.updateComplete;

			expect(postedMessages).toEqual([
				expect.objectContaining({ type: 'favorite.promptAdd', clusterUrl: 'https://mycluster.kusto.windows.net', database: 'db1' }),
			]);
		});

		it('Kusto: renders favorite friendly names in Favorites mode with case-insensitive database matching', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({
				favorites: [{ name: 'Friendly Kusto DB', clusterUrl: 'https://MYCLUSTER.kusto.windows.net/', database: 'DB1' }],
			}));
			await el.updateComplete;

			clickButtonByTestId(el, 'cm-filter-favorites');
			await el.updateComplete;
			clickListItemByName(el, 'MyCluster');
			await el.updateComplete;

			expect(listItemNames(el)).toEqual(['Friendly Kusto DB']);
			expect(el.shadowRoot!.textContent).toContain('db1 · MyCluster');
		});

		it('Kusto: rename and remove favorite actions post identity messages without navigating the row', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({
				favorites: [{ name: 'Friendly Kusto DB', clusterUrl: 'https://MYCLUSTER.kusto.windows.net/', database: 'DB1' }],
			}));
			await el.updateComplete;

			clickListItemByName(el, 'MyCluster');
			await el.updateComplete;

			postedMessages = [];
			clickButtonByTestId(el, 'cm-favorite-rename');
			await el.updateComplete;

			expect(postedMessages).toEqual([
				expect.objectContaining({ type: 'favorite.promptRename', clusterUrl: 'https://MYCLUSTER.kusto.windows.net/', database: 'DB1' }),
			]);
			expect(messageTypes()).not.toContain('database.getSchema');

			postedMessages = [];
			clickButtonByTestId(el, 'cm-favorite-remove');
			await el.updateComplete;

			expect(postedMessages).toEqual([
				expect.objectContaining({ type: 'favorite.remove', clusterUrl: 'https://mycluster.kusto.windows.net', database: 'db1' }),
			]);
		});

		it('SQL: add favorite requests a friendly-name prompt', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({ activeKind: 'sql', connections: [], cachedDatabases: {} }));
			await el.updateComplete;

			clickListItemByName(el, 'MySqlServer');
			await el.updateComplete;

			postedMessages = [];
			clickButtonByTestId(el, 'cm-sql-favorite-add');
			await el.updateComplete;

			expect(postedMessages).toEqual([
				expect.objectContaining({ type: 'sql.favorite.promptAdd', connectionId: 'sql1', database: 'sqldb1' }),
			]);
		});

		it('SQL: renders favorite friendly names in Favorites mode with case-insensitive database matching', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({
				activeKind: 'sql',
				connections: [],
				cachedDatabases: {},
				sqlFavorites: [{ name: 'Friendly SQL DB', connectionId: 'sql1', database: 'SQLDB1' }],
			}));
			await el.updateComplete;

			clickButtonByTestId(el, 'cm-sql-filter-favorites');
			await el.updateComplete;
			clickListItemByName(el, 'MySqlServer');
			await el.updateComplete;

			expect(listItemNames(el)).toEqual(['Friendly SQL DB']);
			expect(el.shadowRoot!.textContent).toContain('sqldb1 · MySqlServer');
		});

		it('SQL: rename and remove favorite actions post identity messages without navigating the row', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({
				activeKind: 'sql',
				connections: [],
				cachedDatabases: {},
				sqlFavorites: [{ name: 'Friendly SQL DB', connectionId: 'sql1', database: 'SQLDB1' }],
			}));
			await el.updateComplete;

			clickListItemByName(el, 'MySqlServer');
			await el.updateComplete;

			postedMessages = [];
			clickButtonByTestId(el, 'cm-sql-favorite-rename');
			await el.updateComplete;

			expect(postedMessages).toEqual([
				expect.objectContaining({ type: 'sql.favorite.promptRename', connectionId: 'sql1', database: 'SQLDB1' }),
			]);
			expect(messageTypes()).not.toContain('sql.database.getSchema');

			postedMessages = [];
			clickButtonByTestId(el, 'cm-sql-favorite-remove');
			await el.updateComplete;

			expect(postedMessages).toEqual([
				expect.objectContaining({ type: 'sql.favorite.remove', connectionId: 'sql1', database: 'sqldb1' }),
			]);
		});
	});

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
