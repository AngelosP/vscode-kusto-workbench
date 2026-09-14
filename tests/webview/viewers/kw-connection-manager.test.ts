import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, nothing, html } from 'lit';
import '../../../src/webview/components/kw-data-table.js';
import '../../../src/webview/components/kw-kind-picker.js';
import '../../../src/webview/viewers/connection-manager/kw-connection-manager.js';
import type { KwConnectionManager } from '../../../src/webview/viewers/connection-manager/kw-connection-manager.js';
import type { ConnectionKind, ConnectionSearchTarget, SearchResult, SearchState } from '../../../src/webview/viewers/connection-manager/connection-manager-search.controller.js';
import { ConnectionManagerSearchController } from '../../../src/webview/viewers/connection-manager/connection-manager-search.controller.js';
import { styles as connectionManagerStyles } from '../../../src/webview/viewers/connection-manager/kw-connection-manager.styles.js';

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
	return { id, name, clusterUrl, accountPreference: { mode: 'automatic' as const } };
}

/** Minimal SQL connection. */
function sqlConnection(id = 'sql1', name = 'MySqlServer', serverUrl = 'myserver.database.windows.net') {
	return { id, name, dialect: 'mssql', serverUrl, port: 1433, authType: 'aad' };
}

/** Build a minimal snapshot. */
function snapshot(overrides: Record<string, unknown> = {}) {
	return {
		connections: [kustoConnection()],
		accounts: [],
		favorites: [],
		cachedDatabases: { c1: ['db1', 'db2'] },
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

function searchTargetLabels(el: KwConnectionManager): string[] {
	return Array.from(el.shadowRoot!.querySelectorAll('[data-testid="cm-search-target-label"]'))
		.map(node => (node.textContent ?? '').trim());
}

function columnNames(el: KwConnectionManager): string[] {
	return Array.from(el.shadowRoot!.querySelectorAll('.explorer-schema-col-name'))
		.map(node => (node.textContent ?? '').trim());
}

function columnDocStrings(el: KwConnectionManager): string[] {
	return Array.from(el.shadowRoot!.querySelectorAll('.explorer-schema-col-doc'))
		.map(node => (node.textContent ?? '').trim());
}

function columnHeaders(el: KwConnectionManager): string[] {
	return Array.from(el.shadowRoot!.querySelectorAll('.explorer-schema-col-header'))
		.map(node => (node.textContent ?? '').replace(/\s+/g, ' ').trim());
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

async function selectSearchScope(el: KwConnectionManager, value: 'selected' | 'cached' | 'everything'): Promise<void> {
	const select = el.shadowRoot!.querySelector<HTMLSelectElement>('[data-testid="cm-search-scope"]');
	expect(select).toBeInstanceOf(HTMLSelectElement);
	select!.value = value;
	select!.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
	await el.updateComplete;
}

async function selectSearchKind(el: KwConnectionManager, kind: ConnectionKind): Promise<void> {
	const picker = el.shadowRoot!.querySelector('kw-kind-picker')!;
	await picker.updateComplete;
	const button = picker.shadowRoot!.querySelector<HTMLButtonElement>(`button[title="${kind === 'sql' ? 'SQL' : 'Kusto'}"]`);
	expect(button).not.toBeNull();
	button!.click();
	await el.updateComplete;
	await picker.updateComplete;
}

function hasSpinner(element: Element | null | undefined): boolean {
	return !!element?.querySelector('.spin');
}

function explorerContent(el: KwConnectionManager): HTMLElement {
	const content = el.shadowRoot!.querySelector('.explorer-content') as HTMLElement | null;
	expect(content).not.toBeNull();
	return content!;
}

function setScrollMetrics(element: HTMLElement, scrollHeight: number, clientHeight: number): void {
	Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight });
	Object.defineProperty(element, 'clientHeight', { configurable: true, value: clientHeight });
}

async function nextFrame(): Promise<void> {
	await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
}

function messageTypes(): string[] {
	return postedMessages
		.map(message => (message && typeof message === 'object' && 'type' in message ? String((message as { type?: unknown }).type) : ''))
		.filter(Boolean);
}

function searchResult(overrides: Partial<SearchResult> = {}): SearchResult {
	return {
		category: 'table',
		kind: 'kusto',
		connectionId: 'c1',
		connectionName: 'MyCluster',
		database: 'db1',
		name: 'Orders',
		...overrides,
	};
}

const searchKinds = [
	{ kind: 'kusto', connectionId: 'c1', connectionName: 'MyCluster', database: 'db1', secondDatabase: 'db2', otherConnectionId: 'c2', otherConnectionName: 'OtherCluster', connectionCategory: 'clusters' },
	{ kind: 'sql', connectionId: 'sql1', connectionName: 'MySqlServer', database: 'sqldb1', secondDatabase: 'sqldb2', otherConnectionId: 'sql2', otherConnectionName: 'OtherSqlServer', connectionCategory: 'servers' },
] as const;

function searchSnapshot(kind: ConnectionKind, overrides: Record<string, unknown> = {}) {
	return snapshot({
		activeKind: kind,
		connections: [kustoConnection(), kustoConnection('c2', 'OtherCluster', 'https://other.kusto.windows.net')],
		cachedDatabases: { c1: ['db1', 'db2'], c2: ['ArchiveDb'] },
		sqlConnections: [sqlConnection(), sqlConnection('sql2', 'OtherSqlServer', 'other.database.windows.net')],
		sqlCachedDatabases: { sql1: ['sqldb1', 'sqldb2'], sql2: ['ArchiveDb'] },
		...overrides,
	});
}

async function openSearch(kind: ConnectionKind, overrides: Record<string, unknown> = {}): Promise<KwConnectionManager> {
	const el = createElement();
	sendSnapshot(el, searchSnapshot(kind, overrides));
	await el.updateComplete;
	clickButtonByTestId(el, kind === 'sql' ? 'cm-sql-filter-search' : 'cm-filter-search');
	await el.updateComplete;
	return el;
}

function searchControl<ElementType extends HTMLElement = HTMLElement>(el: KwConnectionManager, testId: string, attributes = ''): ElementType {
	const selector = `[data-testid="${testId}"]${attributes}`;
	const control = el.shadowRoot!.querySelector<ElementType>(selector);
	expect(control, selector).not.toBeNull();
	return control!;
}

async function clickSearchTarget(el: KwConnectionManager, control: 'cluster' | 'database' | 'expand', connectionId: string, database?: string): Promise<void> {
	const attributes = `[data-connection-id="${connectionId}"]${database === undefined ? '' : `[data-database="${database}"]`}`;
	searchControl(el, `cm-search-target-${control}`, attributes).click();
	await el.updateComplete;
}

async function typeSearchInput(el: KwConnectionManager, testId: string, value: string): Promise<void> {
	const input = searchControl<HTMLInputElement>(el, testId);
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
	await el.updateComplete;
}

function savedSearchMessages(): Array<{ type: 'search.saveState'; kind: ConnectionKind; state: SearchState }> {
	return postedMessages.filter((message): message is { type: 'search.saveState'; kind: ConnectionKind; state: SearchState } =>
		!!message && typeof message === 'object' && 'type' in message && message.type === 'search.saveState');
}

type CapturedSearchRequest = Pick<SearchState, 'query' | 'scope' | 'categories' | 'contentToggles'> & {
	type: 'search';
	requestId: string;
	kind: ConnectionKind;
	targets?: ConnectionSearchTarget[];
};

function searchRequests(): CapturedSearchRequest[] {
	return postedMessages.filter((message): message is CapturedSearchRequest =>
		!!message && typeof message === 'object' && 'type' in message && message.type === 'search');
}

function sendSearchResults(requestId: string, results: SearchResult[], completed = false): void {
	window.dispatchEvent(new MessageEvent('message', { data: {
		type: 'searchResults', requestId, results, completed, kustoSearchOwnerToken: 'control-owner',
	} }));
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
	it('keeps a protected SQL connection visible with an unmark action', async () => {
		const el = createElement();
		sendSnapshot(el, snapshot({
			activeKind: 'sql',
			connections: [],
			sqlConnections: [sqlConnection('sql1', 'Protected SQL')],
			sqlLeaveNoTrace: ['sql1'],
			sqlCachedDatabases: {},
		}));
		await el.updateComplete;
		(el as any)._activeKind = 'sql';
		(el as any)._activeFilter = 'lnt';
		el.requestUpdate();
		await el.updateComplete;

		expect(el.shadowRoot!.textContent).toContain('Protected SQL');
		const unmark = el.shadowRoot!.querySelector('button[title="Remove from Leave No Trace"]') as HTMLButtonElement;
		expect(unmark).toBeTruthy();
		unmark.click();
		expect(postedMessages).toContainEqual({ type: 'sql.leaveNoTrace.remove', connectionId: 'sql1' });
	});

	it('keeps a protected Kusto row manageable but disables exploration and refresh', async () => {
		const el = createElement();
		const connection = kustoConnection('c1', 'Protected', 'https://protected.kusto.windows.net');
		sendSnapshot(el, snapshot({
			connections: [connection], cachedDatabases: {}, favorites: [], expandedClusters: [],
			leaveNoTraceClusters: [connection.clusterUrl],
		}));
		await el.updateComplete;
		postedMessages = [];

		const row = el.shadowRoot!.querySelector('[data-testid="cm-kusto-connection-row"]') as HTMLElement;
		row.click();
		await el.updateComplete;

		expect((el as any)._explorerPath).toBeNull();
		expect(el.shadowRoot!.textContent).toContain('Leave No Trace');
		expect(Array.from(el.shadowRoot!.querySelectorAll('button')).some(button => button.getAttribute('title') === 'Refresh')).toBe(false);
		expect(postedMessages).not.toContainEqual(expect.objectContaining({ type: 'cluster.expand' }));
	});

	it('settles an in-flight SQL test when its owner is invalidated', async () => {
		const el = createElement();
		(el as any)._editingConnectionId = 'sql1';
		window.dispatchEvent(new MessageEvent('message', { data: {
			type: 'sql.testConnectionStarted', connectionId: 'sql1', requestId: 'test-1',
		} }));
		expect((el as any)._testResult).toBe('loading');

		window.dispatchEvent(new MessageEvent('message', { data: {
			type: 'sqlOwnerChanged', connectionIds: ['sql1'],
		} }));

		expect((el as any)._sqlTestConnectionRequestId).toBeNull();
		expect((el as any)._testResult).toContain('owner changed');
	});

	it('ignores a SQL snapshot delivered after a newer revision', async () => {
		const el = createElement() as KwConnectionManager & Record<string, any>;
		sendSnapshot(el, snapshot({ revision: 2, sqlLeaveNoTrace: ['sql1'], sqlCachedDatabases: {} }));
		sendSnapshot(el, snapshot({ revision: 1, sqlLeaveNoTrace: [], sqlCachedDatabases: { sql1: ['StaleDb'] } }));
		await el.updateComplete;

		expect(el._snapshot.sqlLeaveNoTrace).toEqual(['sql1']);
		expect(el._snapshot.sqlCachedDatabases).toEqual({});
	});

	it('purges affected SQL schema, preview, loading, and request state when the principal changes', async () => {
		const el = createElement() as KwConnectionManager & Record<string, any>;
		el._activeKind = 'sql';
		el._sqlExplorerPath = { kind: 'sql', connectionId: 'sql1', database: 'Db', segments: [] };
		el._sqlDatabaseSchemas = { 'sql1|Db': { tables: ['Secret'] }, 'sql2|Db': { tables: ['Safe'] } };
		el._sqlTablePreviewData = { 'sql1|Db|Secret': { rows: [['secret']] }, 'sql2|Db|Safe': { rows: [['safe']] } };
		el._sqlSchemaLoadErrors = { 'sql1|Db': 'old', 'sql2|Db': 'keep' };
		el._sqlDatabaseLoadErrors = { sql1: 'old', sql2: 'keep' };
		el._sqlLoadingDatabases = new Set(['sql1', 'sql2']);
		el._sqlLoadingSchemaKeys = new Set(['sql1|Db', 'sql2|Db']);
		el._sqlDatabaseRequestIds = new Map([['sql1', 'request-1'], ['sql2', 'request-2']]);
		el._sqlSchemaRequestIds = new Map([['sql1|Db', 'schema-1'], ['sql2|Db', 'schema-2']]);
		el._sqlPreviewRequestIds = new Map([['sql1|Db|Secret', 'preview-1'], ['sql2|Db|Safe', 'preview-2']]);

		window.dispatchEvent(new MessageEvent('message', { data: { type: 'sqlPrincipalChanged', connectionIds: ['sql1'] } }));
		await el.updateComplete;

		expect(el._sqlDatabaseSchemas).toEqual({ 'sql2|Db': { tables: ['Safe'] } });
		expect(el._sqlTablePreviewData).toEqual({ 'sql2|Db|Safe': { rows: [['safe']] } });
		expect(el._sqlLoadingDatabases).toEqual(new Set(['sql2']));
		expect(el._sqlLoadingSchemaKeys).toEqual(new Set(['sql2|Db']));
		expect(el._sqlDatabaseRequestIds.has('sql1')).toBe(false);
		expect(el._sqlSchemaRequestIds.has('sql1|Db')).toBe(false);
		expect(el._sqlPreviewRequestIds.has('sql1|Db|Secret')).toBe(false);
		expect(el._sqlExplorerPath).toBeNull();
	});

	it('purges affected SQL state when the saved target changes under the same ID', async () => {
		const el = createElement() as KwConnectionManager & Record<string, any>;
		el._sqlDatabaseSchemas = { 'sql1|Db': { tables: ['OldTarget'] } };
		el._sqlTablePreviewData = { 'sql1|Db|OldTarget': { rows: [['old']] } };

		window.dispatchEvent(new MessageEvent('message', { data: { type: 'sqlOwnerChanged', connectionIds: ['sql1'] } }));
		await el.updateComplete;

		expect(el._sqlDatabaseSchemas).toEqual({});
		expect(el._sqlTablePreviewData).toEqual({});
	});

	it('purges every SQL state surface when SQL becomes unavailable', async () => {
		const el = createElement() as KwConnectionManager & Record<string, any>;
		el._activeKind = 'sql';
		el._sqlExplorerPath = { connectionId: 'sql1', database: 'SecretDb' };
		el._sqlDatabaseSchemas = { 'sql1|SecretDb': { tables: ['Secret'] } };
		el._sqlTablePreviewData = { 'sql1|SecretDb|Secret': { rows: [['secret']] } };
		el._sqlTestConnectionRequestId = 'test-secret';

		sendSnapshot(el, snapshot({
			revision: 2, sqlAvailable: false, sqlConnections: [], sqlCachedDatabases: {},
			searchState: { query: 'Secret', scope: 'cached', lastResults: [{ kind: 'sql', name: 'Secret' }] },
		}));
		await el.updateComplete;

		expect(el._sqlExplorerPath).toBeNull();
		expect(el._sqlDatabaseSchemas).toEqual({});
		expect(el._sqlTablePreviewData).toEqual({});
		expect(el._sqlTestConnectionRequestId).toBeNull();
		expect(el._search.results).toEqual([]);
	});

	// ── Header actions ─────────────────────────────────────────────────────────

	describe('header actions', () => {
		it('Kusto: import and export use secondary header button styling', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;

			const add = el.shadowRoot!.querySelector('[data-testid="cm-add-connection"]') as HTMLButtonElement | null;
			const importButton = el.shadowRoot!.querySelector('[data-testid="cm-import-connections"]') as HTMLButtonElement | null;
			const exportButton = el.shadowRoot!.querySelector('[data-testid="cm-export-connections"]') as HTMLButtonElement | null;

			expect(add).not.toBeNull();
			expect(importButton).not.toBeNull();
			expect(exportButton).not.toBeNull();
			expect(add!.classList.contains('primary')).toBe(true);
			expect(add!.classList.contains('secondary')).toBe(false);
			expect(importButton!.classList.contains('secondary')).toBe(true);
			expect(importButton!.classList.contains('primary')).toBe(false);
			expect(exportButton!.classList.contains('secondary')).toBe(true);
			expect(exportButton!.classList.contains('primary')).toBe(false);
		});
	});

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
				cachedDatabases: { c1: ['zetaDb', 'AlphaDb', 'betaDb'] },
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

		it('Kusto: shows column docstrings in expanded table schema rows', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({
				cachedDatabases: { c1: ['AlphaDb'] },
			}));
			await el.updateComplete;

			clickListItemByName(el, 'MyCluster');
			await el.updateComplete;
			clickListItemByName(el, 'AlphaDb');
			await el.updateComplete;
			sendSchemaLoaded(el, 'c1', 'AlphaDb', {
				tables: ['AlphaRoot'],
				columnTypesByTable: {
					AlphaRoot: { alphaCol: 'long', zCol: 'string' },
				},
				columnDocStrings: {
					'AlphaRoot.alphaCol': 'Primary event count for the current window',
				},
			});
			await el.updateComplete;

			clickListItemByName(el, 'Tables');
			await el.updateComplete;
			clickListItemByName(el, 'AlphaRoot');
			await el.updateComplete;

			expect(columnNames(el)).toEqual(['alphaCol', 'zCol']);
			expect(columnHeaders(el)).toEqual(['alphaCol (long)', 'zCol (string)']);
			expect(columnDocStrings(el)).toEqual(['Primary event count for the current window']);
		});

		it('Kusto: sorts function folders and functions while keeping folders first', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({
				cachedDatabases: { c1: ['AlphaDb'] },
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
		it('clamps impossible explorer scroll after content shrinks without a filter change', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({
				connections: Array.from({ length: 32 }, (_, index) =>
					kustoConnection(`c-${index}`, `Cluster ${String(index).padStart(2, '0')}`, `https://cluster-${index}.kusto.windows.net`)
				),
				cachedDatabases: {},
			}));
			await el.updateComplete;

			const content = explorerContent(el);
			setScrollMetrics(content, 2400, 300);
			content.scrollTop = 1600;

			setScrollMetrics(content, 700, 300);
			el.requestUpdate();
			await el.updateComplete;

			expect(content.scrollTop).toBe(400);
		});

		it('retries explorer scroll clamp until a zero-height viewport becomes measurable', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({
				connections: Array.from({ length: 32 }, (_, index) =>
					kustoConnection(`c-${index}`, `Cluster ${String(index).padStart(2, '0')}`, `https://cluster-${index}.kusto.windows.net`)
				),
				cachedDatabases: {},
			}));
			await el.updateComplete;

			const content = explorerContent(el);
			setScrollMetrics(content, 700, 0);
			content.scrollTop = 1600;

			el.requestUpdate();
			await el.updateComplete;
			setScrollMetrics(content, 700, 300);
			await nextFrame();

			expect(content.scrollTop).toBe(400);
		});

		it('resets explorer scroll when a snapshot changes the active kind', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({
				connections: Array.from({ length: 32 }, (_, index) =>
					kustoConnection(`c-${index}`, `Cluster ${String(index).padStart(2, '0')}`, `https://cluster-${index}.kusto.windows.net`)
				),
				cachedDatabases: {},
				sqlConnections: [sqlConnection('sql-target', 'SQL Target')],
				sqlCachedDatabases: { 'sql-target': ['SqlDb'] },
			}));
			await el.updateComplete;

			const content = explorerContent(el);
			setScrollMetrics(content, 2400, 300);
			content.scrollTop = 900;

			sendSnapshot(el, snapshot({
				activeKind: 'sql',
				connections: [],
				cachedDatabases: {},
				sqlConnections: [sqlConnection('sql-target', 'SQL Target')],
				sqlCachedDatabases: { 'sql-target': ['SqlDb'] },
			}));
			await el.updateComplete;
			await nextFrame();

			expect(explorerContent(el).scrollTop).toBe(0);
			expect(listItemNames(el)).toEqual(['SQL Target']);
		});

		it('Kusto: resets stale root scroll when Favorites shortens the connection list', async () => {
			const connections = Array.from({ length: 32 }, (_, index) =>
				kustoConnection(`c-${index}`, `Cluster ${String(index).padStart(2, '0')}`, `https://cluster-${index}.kusto.windows.net`)
			);
			const favoriteConnection = connections[29];
			const el = createElement();
			sendSnapshot(el, snapshot({
				connections,
				favorites: [{ name: 'Favorite DB', connectionId: 'c-29', clusterUrl: favoriteConnection.clusterUrl, database: 'FavDb' }],
				cachedDatabases: { 'c-29': ['FavDb'] },
			}));
			await el.updateComplete;

			const content = explorerContent(el);
			setScrollMetrics(content, 2400, 300);
			content.scrollTop = 1600;

			clickButtonByTestId(el, 'cm-filter-favorites');
			await el.updateComplete;
			await nextFrame();

			expect(content.scrollTop).toBe(0);
			expect(listItemNames(el)).toEqual(['Cluster 29']);
		});

		it('Kusto: keeps valid scroll when clicking the already active All filter', async () => {
			const connections = Array.from({ length: 32 }, (_, index) =>
				kustoConnection(`c-${index}`, `Cluster ${String(index).padStart(2, '0')}`, `https://cluster-${index}.kusto.windows.net`)
			);
			const el = createElement();
			sendSnapshot(el, snapshot({ connections, cachedDatabases: {} }));
			await el.updateComplete;

			const content = explorerContent(el);
			setScrollMetrics(content, 2400, 300);
			content.scrollTop = 600;

			clickButtonByTestId(el, 'cm-filter-all');
			await el.updateComplete;
			await nextFrame();

			expect(content.scrollTop).toBe(600);
		});

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
				expect.objectContaining({ type: 'favorite.promptAdd', connectionId: 'c1', database: 'db1' }),
			]);
		});

		it('Kusto: renders favorite friendly names in Favorites mode with case-insensitive database matching', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({
				favorites: [{ name: 'Friendly Kusto DB', connectionId: 'c1', clusterUrl: 'https://MYCLUSTER.kusto.windows.net/', database: 'DB1' }],
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
				favorites: [{ name: 'Friendly Kusto DB', connectionId: 'c1', clusterUrl: 'https://MYCLUSTER.kusto.windows.net/', database: 'DB1' }],
			}));
			await el.updateComplete;

			clickListItemByName(el, 'MyCluster');
			await el.updateComplete;

			postedMessages = [];
			clickButtonByTestId(el, 'cm-favorite-rename');
			await el.updateComplete;

			expect(postedMessages).toEqual([
				expect.objectContaining({ type: 'favorite.promptRename', connectionId: 'c1', database: 'DB1' }),
			]);
			expect(messageTypes()).not.toContain('database.getSchema');

			postedMessages = [];
			clickButtonByTestId(el, 'cm-favorite-remove');
			await el.updateComplete;

			expect(postedMessages).toEqual([
				expect.objectContaining({ type: 'favorite.remove', connectionId: 'c1', database: 'db1' }),
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

		it('SQL: resets stale root scroll when Favorites shortens the connection list', async () => {
			const sqlConnections = Array.from({ length: 32 }, (_, index) =>
				sqlConnection(`sql-${index}`, `SQL Server ${String(index).padStart(2, '0')}`, `server-${index}.database.windows.net`)
			);
			const favoriteConnection = sqlConnections[29];
			const el = createElement();
			sendSnapshot(el, snapshot({
				activeKind: 'sql',
				connections: [],
				cachedDatabases: {},
				sqlConnections,
				sqlCachedDatabases: { [favoriteConnection.id]: ['FavDb'] },
				sqlFavorites: [{ name: 'Favorite SQL DB', connectionId: favoriteConnection.id, database: 'FavDb' }],
			}));
			await el.updateComplete;

			const content = explorerContent(el);
			setScrollMetrics(content, 2400, 300);
			content.scrollTop = 1600;

			clickButtonByTestId(el, 'cm-sql-filter-favorites');
			await el.updateComplete;
			await nextFrame();

			expect(content.scrollTop).toBe(0);
			expect(listItemNames(el)).toEqual(['SQL Server 29']);
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

	// ── Search state ───────────────────────────────────────────────────────────

	describe('connection form modal', () => {
		describe('snapshot active kind', () => {
			it.each(['sql', 'kusto'] as const)('keeps explicit empty %s selection and first-add draft after host snapshot', async kind => {
				const el = createElement();
				const otherKind = kind === 'sql' ? 'kusto' : 'sql';
				const initialSnapshot = snapshot({
					revision: 1, activeKind: otherKind, sqlAvailable: true,
					connections: kind === 'sql' ? [kustoConnection()] : [],
					sqlConnections: kind === 'sql' ? [] : [sqlConnection()],
					cachedDatabases: {}, sqlCachedDatabases: {},
				});
				sendSnapshot(el, initialSnapshot);
				await el.updateComplete;
				await selectSearchKind(el, kind);
				expect(postedMessages).toContainEqual({ type: 'setActiveKind', kind });
				clickButtonByTestId(el, 'cm-add-connection');
				await el.updateComplete;
				const form = el.shadowRoot!.querySelector(`kw-${kind}-connection-form`) as HTMLElement & { updateComplete: Promise<unknown> };
				expect(form).not.toBeNull();
				await form.updateComplete;
				expect(form).toMatchObject({ mode: 'add' });
				const fieldSelector = `[data-testid="${kind === 'sql' ? 'sql-conn-server' : 'kusto-conn-cluster-url'}"]`;
				const input = form.shadowRoot!.querySelector<HTMLInputElement>(fieldSelector)!;
				const draft = kind === 'sql' ? 'draft.database.windows.net' : 'draft.kusto.windows.net';
				expect(input).not.toBeNull();
				input.value = draft;
				input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
				await form.updateComplete;

				sendSnapshot(el, { ...initialSnapshot, revision: 2, activeKind: kind });
				await el.updateComplete;
				expect(el.shadowRoot!.querySelector('kw-kind-picker')).toMatchObject({ activeKind: kind });
				expect(el.shadowRoot!.querySelector(`kw-${kind}-connection-form`)).toBe(form);
				expect(el.shadowRoot!.querySelector(`kw-${otherKind}-connection-form`)).toBeNull();
				await form.updateComplete;
				expect(form).toMatchObject({ mode: 'add' });
				expect(form.shadowRoot!.querySelector<HTMLInputElement>(fieldSelector)?.value).toBe(draft);
			});

			it.each([false, true])('keeps Kusto active when SQL is unavailable and hasSql=%s', async hasSql => {
				const el = createElement();
				sendSnapshot(el, snapshot({
					activeKind: 'sql', sqlAvailable: false, connections: [], cachedDatabases: {},
					sqlConnections: hasSql ? [sqlConnection()] : [], sqlCachedDatabases: {},
				}));
				await el.updateComplete;
				expect(el.shadowRoot!.querySelector('kw-kind-picker')).toMatchObject({ activeKind: 'kusto' });
				clickButtonByTestId(el, 'cm-add-connection');
				await el.updateComplete;
				expect(el.shadowRoot!.querySelector('kw-kusto-connection-form')).toMatchObject({ mode: 'add' });
				expect(el.shadowRoot!.querySelector('kw-sql-connection-form')).toBeNull();
			});

			it.each([undefined, 'invalid'])('auto-selects SQL for a %s persisted kind with only SQL connections', async activeKind => {
				const el = createElement();
				sendSnapshot(el, snapshot({ activeKind, connections: [], cachedDatabases: {} }));
				await el.updateComplete;
				expect(el.shadowRoot!.querySelector('kw-kind-picker')).toMatchObject({ activeKind: 'sql' });
				expect(listItemNames(el)).toEqual(['MySqlServer']);
			});
		});

		it('opens the replacement native dialog when a snapshot changes connection kind', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({ sqlConnections: [], sqlCachedDatabases: {} }));
			await el.updateComplete;
			clickButtonByTestId(el, 'cm-add-connection');
			await el.updateComplete;
			expect(el.shadowRoot!.querySelector<HTMLDialogElement>('dialog[data-testid="cm-modal-overlay"]')?.open).toBe(true);

			sendSnapshot(el, snapshot({ activeKind: 'sql', connections: [], cachedDatabases: {} }));
			await el.updateComplete;

			const dialog = el.shadowRoot!.querySelector<HTMLDialogElement>('dialog[data-testid="cm-modal-overlay"]');
			expect(dialog?.open).toBe(true);
			const form = dialog?.querySelector('kw-sql-connection-form') as any;
			expect(form).not.toBeNull();
			expect(dialog?.querySelector('kw-kusto-connection-form')).toBeNull();
			await form.updateComplete;
			await nextFrame();
			expect(form.shadowRoot?.activeElement).toBe(form.shadowRoot?.querySelector('[data-testid="sql-conn-server"]'));
		});

		it('focuses the SQL server field when opening a normal Add dialog', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({ activeKind: 'sql' }));
			await el.updateComplete;
			clickButtonByTestId(el, 'cm-add-connection');
			await el.updateComplete;

			const form = el.shadowRoot!.querySelector('kw-sql-connection-form') as any;
			await form.updateComplete;
			await nextFrame();

			expect(form.shadowRoot?.activeElement).toBe(form.shadowRoot?.querySelector('[data-testid="sql-conn-server"]'));
		});

		it('resets a Kusto edit to a clean SQL Add before submission', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;
			(el as any)._openModal('edit', 'c1');
			await el.updateComplete;

			sendSnapshot(el, snapshot({ activeKind: 'sql' }));
			await el.updateComplete;
			const form = el.shadowRoot!.querySelector('kw-sql-connection-form') as any;
			expect(form.mode).toBe('add');
			expect(form.name).toBe('');
			expect(form.serverUrl).toBe('');
			expect((el as any)._editingConnectionId).toBeNull();

			postedMessages = [];
			form.dispatchEvent(new CustomEvent('sql-connection-form-submit', {
				detail: { name: 'New SQL', serverUrl: 'new.database.windows.net', dialect: 'mssql', authType: 'aad' },
				bubbles: true,
				composed: true,
			}));

			expect(postedMessages).toContainEqual(expect.objectContaining({
				type: 'sql.connection.add', serverUrl: 'new.database.windows.net',
			}));
			expect(messageTypes()).not.toContain('sql.connection.edit');
			await new Promise(resolve => setTimeout(resolve, 110));
		});

		it('resets a SQL edit to a clean Kusto Add before submission', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({ activeKind: 'sql' }));
			await el.updateComplete;
			(el as any)._openModal('edit', 'sql1');
			await el.updateComplete;

			sendSnapshot(el, snapshot({ activeKind: 'kusto' }));
			await el.updateComplete;
			const form = el.shadowRoot!.querySelector('kw-kusto-connection-form') as any;
			expect(form.mode).toBe('add');
			expect(form.name).toBe('');
			expect(form.clusterUrl).toBe('');
			expect((el as any)._editingConnectionId).toBeNull();

			postedMessages = [];
			form.dispatchEvent(new CustomEvent('connection-form-submit', {
				detail: { name: 'New Kusto', clusterUrl: 'https://new.kusto.windows.net', database: '' },
				bubbles: true,
				composed: true,
			}));

			expect(postedMessages).toContainEqual(expect.objectContaining({
				type: 'connection.add', clusterUrl: 'https://new.kusto.windows.net',
			}));
			expect(messageTypes()).not.toContain('connection.edit');
		});

		it('bounds modal content and gives its body a vertical scroll owner', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;
			clickButtonByTestId(el, 'cm-add-connection');
			await el.updateComplete;

			const dialog = el.shadowRoot!.querySelector<HTMLDialogElement>('dialog[data-testid="cm-modal-overlay"]')!;
			const content = dialog.querySelector<HTMLElement>('.modal-content')!;
			const body = dialog.querySelector<HTMLElement>('.modal-body')!;
			expect(getComputedStyle(dialog).overflow).toBe('hidden');
			expect(getComputedStyle(content).display).toBe('grid');
			expect(getComputedStyle(body).overflowY).toBe('auto');
		});

		it('focuses the Kusto cluster field and restores the Add button on Escape', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({ connections: [], cachedDatabases: {}, sqlConnections: [], sqlCachedDatabases: {} }));
			await el.updateComplete;
			const addButton = el.shadowRoot!.querySelector('[data-testid="cm-add-connection"]') as HTMLButtonElement;
			addButton.focus();
			addButton.click();
			await el.updateComplete;

			const form = el.shadowRoot!.querySelector('kw-kusto-connection-form') as any;
			await form.updateComplete;
			const clusterInput = form.shadowRoot!.querySelector('[data-testid="kusto-conn-cluster-url"]');
			expect(form.shadowRoot!.activeElement).toBe(clusterInput);

			clusterInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
			await el.updateComplete;
			expect(el.shadowRoot!.querySelector('[data-testid="cm-modal-overlay"]')).toBeNull();
			expect(el.shadowRoot!.querySelector('.modal-content')).toBeNull();
			expect(el.shadowRoot!.querySelector('kw-kusto-connection-form')).toBeNull();
			expect(el.shadowRoot!.activeElement).toBe(addButton);
		});

		it('Kusto: add modal shows Test Connection and posts draft details', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({ connections: [], cachedDatabases: {}, sqlConnections: [], sqlCachedDatabases: {} }));
			await el.updateComplete;

			clickButtonByTestId(el, 'cm-add-connection');
			await el.updateComplete;

			const form = el.shadowRoot!.querySelector('kw-kusto-connection-form') as HTMLElement & { updateComplete: Promise<unknown> };
			expect(form).not.toBeNull();
			await form.updateComplete;

			const formRoot = form.shadowRoot!;
			const testButton = Array.from(formRoot.querySelectorAll('button'))
				.find(button => button.textContent?.includes('Test Connection')) as HTMLButtonElement | undefined;
			expect(testButton).not.toBeUndefined();

			const inputs = Array.from(formRoot.querySelectorAll('input'));
			inputs[0].value = 'Draft Kusto';
			inputs[0].dispatchEvent(new Event('input', { bubbles: true, composed: true }));
			inputs[1].value = 'draft.kusto.windows.net';
			inputs[1].dispatchEvent(new Event('input', { bubbles: true, composed: true }));
			inputs[2].value = 'Samples';
			inputs[2].dispatchEvent(new Event('input', { bubbles: true, composed: true }));

			postedMessages = [];
			testButton!.click();
			await el.updateComplete;

			expect(postedMessages).toContainEqual(expect.objectContaining({
				type: 'connection.test',
				name: 'Draft Kusto',
				clusterUrl: 'draft.kusto.windows.net',
				database: 'Samples',
			}));
		});

		it('SQL: ignores stale test completions and accepts only the current modal request', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({ activeKind: 'sql', connections: [], cachedDatabases: {} }));
			await el.updateComplete;
			(el as any)._openModal('edit', 'sql1');
			await el.updateComplete;

			window.dispatchEvent(new MessageEvent('message', {
				data: { type: 'sql.testConnectionStarted', connectionId: 'sql1', requestId: 'test-old' },
			}));
			window.dispatchEvent(new MessageEvent('message', {
				data: { type: 'sql.testConnectionStarted', connectionId: 'sql1', requestId: 'test-current' },
			}));
			window.dispatchEvent(new MessageEvent('message', {
				data: { type: 'sql.testConnectionResult', connectionId: 'sql1', requestId: 'test-old', success: true, message: 'old success' },
			}));

			expect((el as any)._testResult).toBe('loading');

			window.dispatchEvent(new MessageEvent('message', {
				data: { type: 'sql.testConnectionResult', connectionId: 'sql1', requestId: 'test-current', success: true, message: 'current success' },
			}));

			expect((el as any)._testResult).toBe('✓ current success');

			(el as any)._closeModal();
			window.dispatchEvent(new MessageEvent('message', {
				data: { type: 'sql.testConnectionResult', connectionId: 'sql1', requestId: 'test-current', success: false, message: 'late failure' },
			}));
			expect((el as any)._testResult).toBe('✓ current success');
		});

		it('SQL: Test Connection forwards the child form draft password without saving', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({
				activeKind: 'sql', connections: [], cachedDatabases: {},
				sqlConnections: [{ ...sqlConnection(), authType: 'sql-login', username: 'ReportUser' }],
			}));
			await el.updateComplete;
			(el as any)._openModal('edit', 'sql1');
			await el.updateComplete;
			const form = el.shadowRoot!.querySelector('kw-sql-connection-form') as HTMLElement & { updateComplete: Promise<unknown> };
			await form.updateComplete;
			const changePassword = form.shadowRoot!.querySelector('[data-testid="sql-conn-change-password"]') as HTMLInputElement;
			changePassword.checked = true;
			changePassword.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
			await form.updateComplete;
			const password = form.shadowRoot!.querySelector('[data-testid="sql-conn-password"]') as HTMLInputElement;
			password.value = 'draft-password';
			password.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
			postedMessages = [];

			(form.shadowRoot!.querySelector('[data-testid="sql-conn-test"]') as HTMLButtonElement).click();

			expect(postedMessages).toContainEqual({
				type: 'sql.connection.test', id: 'sql1', name: 'MySqlServer',
				serverUrl: 'myserver.database.windows.net', port: 1433, dialect: 'mssql',
				authType: 'sql-login', username: 'ReportUser', database: undefined,
				password: 'draft-password',
			});
			expect(messageTypes()).not.toContain('sql.connection.edit');
	});
	});

	// ── Search state ───────────────────────────────────────────────────────────

	describe('search state', () => {
		it.each(searchKinds)('$kind: shows a column type inline and reveals the expanded source table with the column selected', async ({ kind, connectionId, database }) => {
			const result = { ...searchResult({ kind, connectionId, database, category: 'column', parentName: 'Orders', name: 'DurationMs' }), columnType: 'long' };
			const el = await openSearch(kind, { searchState: {
				kind, scope: 'selected', query: 'DurationMs', targets: [{ connectionId, database }],
				categories: { tables: false }, contentToggles: { tables: true }, lastResults: [result],
			} });
			const schema = {
				tables: ['Orders'], tableFolders: { Orders: 'Observability/API' },
				columnTypesByTable: { Orders: { DurationMs: 'long', Other: 'string' } },
				columnsByTable: { Orders: { DurationMs: 'long', Other: 'string' } },
			};
			if (kind === 'kusto') sendSchemaLoaded(el, connectionId, database, schema);
			else sendSqlSchemaLoaded(el, connectionId, database, schema);
			await el.updateComplete;
			const row = el.shadowRoot!.querySelector<HTMLElement>('.search-result-item')!;
			expect(row.querySelector('.explorer-list-item-name')?.textContent).toBe('DurationMs');
			expect(row.querySelector('[data-testid="cm-search-column-type"]')?.textContent).toBe('(long)');
			row.click();
			await el.updateComplete;
			await nextFrame();
			await el.updateComplete;
			expect(el.shadowRoot!.querySelector('[data-testid="cm-search-container"]')).toBeNull();
			const selected = el.shadowRoot!.querySelector<HTMLElement>('[data-testid="cm-schema-column"][data-selected="true"]');
			expect(selected).not.toBeNull();
			expect(selected?.dataset.table).toBe('Orders');
			expect(selected?.dataset.column).toBe('DurationMs');
			expect(selected?.closest('.explorer-list-item-wrapper')?.classList.contains('expanded')).toBe(true);
			if (kind === 'kusto') {
				expect(Array.from(el.shadowRoot!.querySelectorAll('.breadcrumb-item'), crumb => crumb.textContent?.trim())).toContain('API');
			}
		});

		it.each(searchKinds)('$kind: keeps exact column type suffixes before context and omits unknown loaded types', async ({ kind, connectionId, database }) => {
			const columnType = kind === 'kusto' ? 'dynamic' : 'decimal(18, 4)';
			const results = [
				searchResult({ kind, connectionId, database, category: 'column', parentName: 'Orders', name: 'Known', columnType }),
				searchResult({ kind, connectionId, database, category: 'column', parentName: 'Orders', name: 'Unknown' }),
				searchResult({ kind, connectionId, database, category: 'column', parentName: 'Orders', name: 'Empty', columnType: '' }),
			];
			const el = await openSearch(kind, { searchState: {
				kind, scope: 'cached', query: 'column', categories: { tables: false },
				contentToggles: { tables: true }, lastResults: results,
			} });
			const schema = {
				tables: ['Orders'], columnTypesByTable: { Orders: { Known: columnType } },
				columnsByTable: { Orders: { Known: columnType } },
			};
			if (kind === 'kusto') sendSchemaLoaded(el, connectionId, database, schema);
			else sendSqlSchemaLoaded(el, connectionId, database, schema);
			await el.updateComplete;

			const known = searchControl(el, 'cm-search-result', '[data-category="column"][data-name="Known"]');
			const suffix = known.querySelector<HTMLElement>('[data-testid="cm-search-column-type"]')!;
			expect(suffix?.textContent).toBe(`(${columnType})`);
			expect(known.querySelector('.explorer-list-item-name')?.nextElementSibling).toBe(suffix);
			expect(suffix.nextElementSibling).toBe(known.querySelector('.search-result-context'));
			expect(suffix.hidden).toBe(false);
			expect(getComputedStyle(suffix).display).not.toBe('none');
			for (const name of ['Unknown', 'Empty']) {
				const row = searchControl(el, 'cm-search-result', `[data-category="column"][data-name="${name}"]`);
				expect(row.querySelector('[data-testid="cm-search-column-type"]')).toBeNull();
				expect(row.textContent).not.toContain('()');
				expect(row.querySelector('.explorer-list-item-name')?.nextElementSibling).toBe(row.querySelector('.search-result-context'));
			}
		});

		describe('column search navigation', () => {
			const sources = [
				{ ...searchKinds[0], label: 'Kusto nested table', parentKind: 'table' },
				{ ...searchKinds[1], label: 'SQL table', parentKind: 'table' },
				{ ...searchKinds[1], label: 'SQL view', parentKind: 'view' },
			] as const;

			afterEach(() => vi.restoreAllMocks());

			function sourceSchema(parentKind: 'table' | 'view' = 'table') {
				const columns = { Orders: { DurationMs: 'long', Other: 'string' }, OtherOrders: { DurationMs: 'string' } };
				return {
					tables: parentKind === 'view' ? ['TableOnly'] : ['Orders', 'OtherOrders'],
					views: parentKind === 'view' ? ['Orders', 'OtherOrders'] : [],
					tableFolders: { Orders: 'Observability/API', OtherOrders: 'Observability/API' },
					columnTypesByTable: columns, columnsByTable: columns,
				};
			}

			async function settleColumnReveal(el: KwConnectionManager): Promise<void> {
				await el.updateComplete;
				await nextFrame();
				await el.updateComplete;
				await nextFrame();
				await el.updateComplete;
			}

			async function openColumnSearch(kind: ConnectionKind, results: SearchResult[]): Promise<KwConnectionManager> {
				return openSearch(kind, { searchState: {
					kind, scope: 'cached', query: 'DurationMs', categories: {},
					contentToggles: { tables: true, ...(kind === 'sql' ? { views: true } : {}) }, lastResults: results,
				} });
			}

			function resultControl(el: KwConnectionManager, result: SearchResult): HTMLElement {
				return searchControl(el, 'cm-search-result', `[data-category="${result.category}"][data-connection-id="${result.connectionId}"][data-database="${result.database}"][data-parent="${result.parentName ?? ''}"][data-name="${result.name}"]`);
			}

			function expectSelectedColumn(el: KwConnectionManager, table = 'Orders', column = 'DurationMs'): HTMLElement {
				const selected = el.shadowRoot!.querySelectorAll<HTMLElement>('[data-testid="cm-schema-column"][data-selected="true"]');
				expect(selected).toHaveLength(1);
				const row = selected[0];
				expect(row.dataset.table).toBe(table);
				expect(row.dataset.column).toBe(column);
				expect(row.getAttribute('aria-current')).toBe('true');
				expect(row.getAttribute('tabindex')).toBe('-1');
				expect(row.closest('.explorer-list-item-wrapper')?.classList.contains('expanded')).toBe(true);
				expect(el.shadowRoot!.activeElement).toBe(row);
				return row;
			}

			it.each(sources.flatMap(source => ['cached', 'delayed'].map(availability => ({ ...source, availability }))))('$label: $availability schema reveals only the exact source and preserves search after Back', async ({ kind, connectionId, connectionName, database, secondDatabase, parentKind, availability }) => {
				const result = searchResult({ kind, connectionId, connectionName, database, category: 'column', parentName: 'Orders', parentKind, name: 'DurationMs', columnType: 'long' });
				const results = [{ ...result, parentName: 'OtherOrders' }, { ...result, database: secondDatabase }, result];
				const el = await openSearch(kind, { searchState: {
					kind, scope: availability === 'delayed' ? 'selected' : parentKind === 'view' ? 'everything' : 'cached', query: 'DurationMs',
					targets: [{ connectionId, database }, { connectionId, database: secondDatabase }],
					categories: kind === 'kusto' ? { clusters: false, databases: false, tables: false, functions: true } : { servers: false, databases: false, tables: false, views: true, storedProcedures: false },
					contentToggles: kind === 'kusto' ? { tables: true, functions: true } : { tables: true, views: true, storedProcedures: true },
					lastResults: results,
				} });
				const schema = sourceSchema(parentKind);
				const sendSchema = kind === 'kusto' ? sendSchemaLoaded : sendSqlSchemaLoaded;
				sendSchema(el, connectionId, secondDatabase, schema);
				if (availability === 'cached') sendSchema(el, connectionId, database, schema);
				else {
					el.shadowRoot!.querySelector<HTMLButtonElement>('button[title="Re-run search"]')!.click();
					await el.updateComplete;
					const request = searchRequests().at(-1)!;
					expect(request).toMatchObject({ kind, query: 'DurationMs' });
					sendSearchResults(request.requestId, results, true);
				}
				await settleColumnReveal(el);
				const { query, scope, targets, categories, contentToggles } = el._search;
				const expectedSearch = structuredClone({ query, scope, targets, categories, contentToggles, results });
				const categoryStates = () => Array.from(el.shadowRoot!.querySelectorAll('[data-testid="cm-search-category"]'), chip => [chip.getAttribute('data-category'), chip.getAttribute('aria-pressed'), chip.classList.contains('content-on')]);
				const expectedCategories = categoryStates();
				const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
				const selectContents = vi.spyOn(Range.prototype, 'selectNodeContents');
				postedMessages = [];

				resultControl(el, result).click();
				await settleColumnReveal(el);
				const requestType = kind === 'kusto' ? 'database.getSchema' : 'sql.database.getSchema';
				expect(postedMessages.filter(message => (message as { type?: string }).type === requestType)).toEqual(availability === 'cached' ? [] : [{ type: requestType, connectionId, database }]);
				if (availability === 'delayed') {
					const prefix = kind === 'kusto' ? '' : 'sql.';
					for (const requestId of ['column-old', 'column-current']) {
						window.dispatchEvent(new MessageEvent('message', { data: { type: `${prefix}loadingSchema`, connectionId, database, requestId } }));
					}
					for (const terminal of [
						{ type: `${prefix}schemaLoaded`, requestId: 'column-old', schema },
						{ type: `${prefix}schemaLoadError`, requestId: 'column-unrelated', error: 'Wrong request' },
					]) {
						window.dispatchEvent(new MessageEvent('message', { data: { ...terminal, connectionId, database } }));
						await settleColumnReveal(el);
						expect(el.shadowRoot!.querySelector('[data-testid="cm-schema-column"]')).toBeNull();
						expect(scrollIntoView).not.toHaveBeenCalled();
						expect(selectContents).not.toHaveBeenCalled();
					}
					window.dispatchEvent(new MessageEvent('message', { data: { type: `${prefix}schemaLoaded`, connectionId, database, requestId: 'column-current', schema } }));
					await settleColumnReveal(el);
				}

				const selected = expectSelectedColumn(el);
				expect(scrollIntoView.mock.contexts).toEqual([selected]);
				expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
				expect(selectContents).toHaveBeenCalledExactlyOnceWith(selected.querySelector('.explorer-schema-col-name'));
				const breadcrumbs = Array.from(el.shadowRoot!.querySelectorAll('.breadcrumb-item'), crumb => crumb.textContent?.trim());
				expect(breadcrumbs).toContain(database);
				expect(breadcrumbs).not.toContain(secondDatabase);
				expect(breadcrumbs).toContain(parentKind === 'view' ? 'Views' : 'Tables');
				if (kind === 'kusto') expect(breadcrumbs.slice(-2)).toEqual(['Observability', 'API']);
				clickListItemByName(el, 'OtherOrders');
				await settleColumnReveal(el);
				const other = searchControl(el, 'cm-schema-column', '[data-table="OtherOrders"][data-column="DurationMs"]');
				expect(other.dataset.selected).toBe('false');
				expect(other.getAttribute('aria-current')).toBeNull();
				expectSelectedColumn(el);
				expect(selectContents).toHaveBeenCalledTimes(1);

				clickButtonByTestId(el, kind === 'kusto' ? 'cm-breadcrumb-back' : 'cm-sql-breadcrumb-back');
				await settleColumnReveal(el);
				expect(el.shadowRoot!.querySelector('[data-testid="cm-schema-column"][data-selected="true"]')).toBeNull();
				expect(listItemNames(el)).toContain(kind === 'kusto' ? 'API' : 'Tables');
				expect(listItemNames(el)).not.toContain('Orders');
				clickButtonByTestId(el, kind === 'kusto' ? 'cm-filter-search' : 'cm-sql-filter-search');
				await settleColumnReveal(el);
				expect(searchControl<HTMLInputElement>(el, 'cm-search-input').value).toBe(query);
				expect(searchControl<HTMLSelectElement>(el, 'cm-search-scope').value).toBe(scope);
				expect(categoryStates()).toEqual(expectedCategories);
				expect(el._search).toMatchObject(expectedSearch);
				expect(resultControl(el, result).querySelector('[data-testid="cm-search-column-type"]')?.textContent).toBe('(long)');
				expect(searchRequests()).toEqual([]);
				expect(selectContents).toHaveBeenCalledTimes(1);
			});

			it.each(searchKinds)('$kind: Back during a pending schema retires the column without reopening or stealing focus', async ({ kind, connectionId, database }) => {
				const result = searchResult({ kind, connectionId, database, category: 'column', parentName: 'Orders', name: 'DurationMs', columnType: 'long' });
				const el = await openColumnSearch(kind, [result]);
				resultControl(el, result).click();
				await settleColumnReveal(el);
				const prefix = kind === 'kusto' ? '' : 'sql.';
				window.dispatchEvent(new MessageEvent('message', { data: { type: `${prefix}loadingSchema`, connectionId, database, requestId: 'pending-column' } }));
				await el.updateComplete;
				const backId = kind === 'kusto' ? 'cm-breadcrumb-back' : 'cm-sql-breadcrumb-back';
				clickButtonByTestId(el, backId);
				await settleColumnReveal(el);
				const back = searchControl(el, backId);
				back.focus();
				const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
				const selectContents = vi.spyOn(Range.prototype, 'selectNodeContents');

				window.dispatchEvent(new MessageEvent('message', { data: { type: `${prefix}schemaLoaded`, connectionId, database, requestId: 'pending-column', schema: sourceSchema() } }));
				await settleColumnReveal(el);

				expect(listItemNames(el)).toContain('Tables');
				expect(listItemNames(el)).not.toContain('Orders');
				expect(el.shadowRoot!.querySelector('[data-testid="cm-schema-column"]')).toBeNull();
				expect(el.shadowRoot!.activeElement).toBe(back);
				expect(scrollIntoView).not.toHaveBeenCalled();
				expect(selectContents).not.toHaveBeenCalled();
				clickButtonByTestId(el, kind === 'kusto' ? 'cm-filter-search' : 'cm-sql-filter-search');
				await settleColumnReveal(el);
				expect(resultControl(el, result)).not.toBeNull();
				expect(el._search.results).toEqual([result]);
				expect(searchRequests()).toEqual([]);
			});

			it.each(searchKinds)('$kind: a newer column or source wins while the first schema is pending', async ({ kind, connectionId, database, secondDatabase }) => {
				const first = searchResult({ kind, connectionId, database, category: 'column', parentName: 'Orders', name: 'DurationMs', columnType: 'long' });
				const next = searchResult({ ...first, database: kind === 'kusto' ? database : secondDatabase, parentName: kind === 'kusto' ? 'Orders' : 'OtherOrders', name: kind === 'kusto' ? 'Other' : 'DurationMs', parentKind: kind === 'kusto' ? 'table' : 'view' });
				const el = await openColumnSearch(kind, [first, next]);
				const sendSchema = kind === 'kusto' ? sendSchemaLoaded : sendSqlSchemaLoaded;
				const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
				const selectContents = vi.spyOn(Range.prototype, 'selectNodeContents');
				resultControl(el, first).click();
				await settleColumnReveal(el);
				clickButtonByTestId(el, kind === 'kusto' ? 'cm-filter-search' : 'cm-sql-filter-search');
				await el.updateComplete;
				resultControl(el, next).click();
				await settleColumnReveal(el);
				expect(el.shadowRoot!.querySelector('[data-testid="cm-schema-column"]')).toBeNull();

				sendSchema(el, connectionId, database, sourceSchema());
				await settleColumnReveal(el);
				if (kind === 'sql') {
					expect(el.shadowRoot!.querySelector('[data-testid="cm-schema-column"]')).toBeNull();
					expect(scrollIntoView).not.toHaveBeenCalled();
					expect(selectContents).not.toHaveBeenCalled();
					sendSchema(el, connectionId, secondDatabase, sourceSchema('view'));
					await settleColumnReveal(el);
				}

				const selected = expectSelectedColumn(el, next.parentName, next.name);
				expect(scrollIntoView.mock.contexts).toEqual([selected]);
				expect(selectContents).toHaveBeenCalledExactlyOnceWith(selected.querySelector('.explorer-schema-col-name'));
				expect(Array.from(el.shadowRoot!.querySelectorAll('.breadcrumb-item'), crumb => crumb.textContent?.trim())).toContain(next.database);
				sendSchema(el, connectionId, database, sourceSchema());
				await settleColumnReveal(el);
				expectSelectedColumn(el, next.parentName, next.name);
				expect(scrollIntoView).toHaveBeenCalledTimes(1);
				expect(selectContents).toHaveBeenCalledTimes(1);
			});

			it.each(searchKinds)('$kind: expanding another table or view result keeps a late column reveal out of Search', async ({ kind, connectionId, database }) => {
				const first = searchResult({ kind, connectionId, database, category: 'column', parentName: 'Orders', name: 'DurationMs' });
				const next = searchResult({ kind, connectionId, database, category: kind === 'kusto' ? 'table' : 'view', name: 'OtherOrders' });
				const el = await openColumnSearch(kind, [first, next]);
				resultControl(el, first).click();
				await settleColumnReveal(el);
				clickButtonByTestId(el, kind === 'kusto' ? 'cm-filter-search' : 'cm-sql-filter-search');
				await el.updateComplete;
				resultControl(el, next).click();
				await settleColumnReveal(el);
				const input = searchControl<HTMLInputElement>(el, 'cm-search-input');
				input.focus();
				const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
				const selectContents = vi.spyOn(Range.prototype, 'selectNodeContents');
				const sendSchema = kind === 'kusto' ? sendSchemaLoaded : sendSqlSchemaLoaded;

				sendSchema(el, connectionId, database, sourceSchema(kind === 'kusto' ? 'table' : 'view'));
				await settleColumnReveal(el);

				expect(searchControl(el, 'cm-search-container')).not.toBeNull();
				const expanded = resultControl(el, next).closest('.explorer-list-item-wrapper')!;
				expect(expanded.classList.contains('expanded')).toBe(true);
				expect(Array.from(expanded.querySelectorAll('.explorer-schema-col-name'), column => column.textContent)).toEqual(['DurationMs']);
				expect(expanded.querySelector('.explorer-schema-row.selected')).toBeNull();
				expect(expanded.querySelector('[aria-current="true"]')).toBeNull();
				expect(el.shadowRoot!.querySelector('[data-testid="cm-schema-column"][data-selected="true"]')).toBeNull();
				expect(el.shadowRoot!.activeElement).toBe(input);
				expect(scrollIntoView).not.toHaveBeenCalled();
				expect(selectContents).not.toHaveBeenCalled();
			});

			it.each([sources[0], sources[2]].flatMap(source => ['table', 'column'].map(missing => ({ ...source, missing }))))('$label: a missing $missing never selects a same-name alternative or reschedules frames', async ({ kind, connectionId, database, parentKind, missing }) => {
				const result = searchResult({ kind, connectionId, database, category: 'column', parentName: 'Orders', parentKind, name: 'DurationMs' });
				const el = await openColumnSearch(kind, [result]);
				const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
				const selectContents = vi.spyOn(Range.prototype, 'selectNodeContents');
				resultControl(el, result).click();
				await settleColumnReveal(el);
				const columns = { Orders: { Other: 'string' }, OtherOrders: { DurationMs: 'string' } };
				const schema = {
					...sourceSchema(parentKind),
					...(missing === 'table' ? { tables: ['OtherOrders'], views: [] } : { columnTypesByTable: columns, columnsByTable: columns }),
				};
				const sendSchema = kind === 'kusto' ? sendSchemaLoaded : sendSqlSchemaLoaded;
				sendSchema(el, connectionId, database, schema);
				await settleColumnReveal(el);
				clickListItemByName(el, 'OtherOrders');
				await settleColumnReveal(el);
				const other = searchControl(el, 'cm-schema-column', '[data-table="OtherOrders"][data-column="DurationMs"]');
				expect(other.dataset.selected).toBe('false');
				expect(el.shadowRoot!.querySelector('[data-testid="cm-schema-column"][data-table="Orders"][data-column="DurationMs"]')).toBeNull();
				expect(el.shadowRoot!.querySelector('[data-testid="cm-schema-column"][data-selected="true"]')).toBeNull();
				const content = explorerContent(el);
				setScrollMetrics(content, 600, 600);
				await settleColumnReveal(el);
				const markup = content.innerHTML;
				const frames = vi.spyOn(window, 'requestAnimationFrame');

				await settleColumnReveal(el);

				expect(frames).toHaveBeenCalledTimes(2);
				expect(el.isUpdatePending).toBe(false);
				expect(content.innerHTML).toBe(markup);
				expect(scrollIntoView).not.toHaveBeenCalled();
				expect(selectContents).not.toHaveBeenCalled();
			});

			it.each([sources[0], sources[2]])('$label: manual collapse, reopen, and parent navigation never bounce back to the column', async ({ kind, connectionId, database, parentKind }) => {
				const result = searchResult({ kind, connectionId, database, category: 'column', parentName: 'Orders', parentKind, name: 'DurationMs' });
				const el = await openColumnSearch(kind, [result]);
				const sendSchema = kind === 'kusto' ? sendSchemaLoaded : sendSqlSchemaLoaded;
				sendSchema(el, connectionId, database, sourceSchema(parentKind));
				await el.updateComplete;
				const selectContents = vi.spyOn(Range.prototype, 'selectNodeContents');
				resultControl(el, result).click();
				await settleColumnReveal(el);
				expectSelectedColumn(el);

				clickListItemByName(el, 'Orders');
				await settleColumnReveal(el);
				expect(el.shadowRoot!.querySelector('[data-testid="cm-schema-column"][data-table="Orders"]')).toBeNull();
				expect(listItemNames(el)).toContain('Orders');
				expect(selectContents).toHaveBeenCalledTimes(1);
				clickListItemByName(el, 'Orders');
				await settleColumnReveal(el);
				expectSelectedColumn(el);
				expect(selectContents).toHaveBeenCalledTimes(2);
				clickBreadcrumbByText(el, kind === 'kusto' ? 'Observability' : database);
				await settleColumnReveal(el);
				expect(listItemNames(el)).toContain(kind === 'kusto' ? 'API' : 'Views');
				expect(listItemNames(el)).not.toContain('Orders');
				expect(el.shadowRoot!.querySelector('[data-testid="cm-schema-column"][data-selected="true"]')).toBeNull();
				clickListItemByName(el, kind === 'kusto' ? 'API' : 'Views');
				await settleColumnReveal(el);
				const column = searchControl(el, 'cm-schema-column', '[data-table="Orders"][data-column="DurationMs"]');
				expect(column.dataset.selected).toBe('false');
				expect(column.getAttribute('aria-current')).toBeNull();
				expect(el.shadowRoot!.activeElement).not.toBe(column);
				expect(selectContents).toHaveBeenCalledTimes(2);
			});

			it('retires a queued reveal when manual navigation reuses the connected schema row', async () => {
				const result = searchResult({ category: 'column', parentName: 'Orders', name: 'DurationMs' });
				const el = await openColumnSearch('kusto', [result]);
				sendSchemaLoaded(el, 'c1', 'db1', { ...sourceSchema(), tableFolders: {} });
				await el.updateComplete;
				const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
				const selectContents = vi.spyOn(Range.prototype, 'selectNodeContents');
				resultControl(el, result).click();
				await el.updateComplete;
				const column = searchControl(el, 'cm-schema-column', '[data-table="Orders"][data-column="DurationMs"]');
				expect(column.dataset.selected).toBe('true');

				clickBreadcrumbByText(el, 'Tables');
				await el.updateComplete;
				expect(column.isConnected).toBe(true);
				expect(searchControl(el, 'cm-schema-column', '[data-table="Orders"][data-column="DurationMs"]')).toBe(column);
				expect(column.dataset.selected).toBe('false');
				const back = searchControl(el, 'cm-breadcrumb-back');
				back.focus();
				await settleColumnReveal(el);

				expect(el.shadowRoot!.activeElement).toBe(back);
				expect(scrollIntoView).not.toHaveBeenCalled();
				expect(selectContents).not.toHaveBeenCalled();
			});

			describe('text Selection ownership', () => {
				beforeEach(() => window.getSelection()!.removeAllRanges());
				afterEach(() => window.getSelection()!.removeAllRanges());

				it.each([
					{ ...sources[0], reuseRow: true },
					...sources.map(source => ({ ...source, reuseRow: false })),
				])('$label: Back clears the completed selection before rendering the parent (reused row: $reuseRow)', async ({ kind, connectionId, database, parentKind, reuseRow }) => {
					const result = searchResult({ kind, connectionId, database, category: 'column', parentName: 'Orders', parentKind, name: 'DurationMs' });
					const other = searchResult({ ...result, parentName: 'OtherOrders' });
					const el = await openColumnSearch(kind, [result, other]);
					const schema = sourceSchema(parentKind);
					if (reuseRow) schema.tableFolders.OtherOrders = 'Observability';
					const sendSchema = kind === 'kusto' ? sendSchemaLoaded : sendSqlSchemaLoaded;
					sendSchema(el, connectionId, database, schema);
					await el.updateComplete;
					if (reuseRow) {
						resultControl(el, other).click();
						await settleColumnReveal(el);
						expectSelectedColumn(el, 'OtherOrders');
						clickButtonByTestId(el, 'cm-filter-search');
						await settleColumnReveal(el);
					}
					resultControl(el, result).click();
					await settleColumnReveal(el);
					const column = expectSelectedColumn(el);
					const name = column.querySelector<HTMLElement>('.explorer-schema-col-name')!;
					const selection = window.getSelection()!;
					expect(selection.rangeCount).toBe(1);
					expect(selection.toString()).toBe('DurationMs');
					const range = selection.getRangeAt(0);
					expect(range.startContainer).toBe(name);
					expect(range.startOffset).toBe(0);
					expect(range.endContainer).toBe(name);
					expect(range.endOffset).toBe(name.childNodes.length);

					clickButtonByTestId(el, kind === 'kusto' ? 'cm-breadcrumb-back' : 'cm-sql-breadcrumb-back');
					expect(column.isConnected).toBe(true);
					expect(selection.rangeCount).toBe(0);
					expect(selection.toString()).toBe('');
					await settleColumnReveal(el);

					if (reuseRow) {
						const reused = searchControl(el, 'cm-schema-column', '[data-table="OtherOrders"][data-column="DurationMs"]');
						expect(listItemNames(el)).toEqual(['API', 'OtherOrders']);
						expect(reused).toBe(column);
						expect(reused.querySelector('.explorer-schema-col-name')).toBe(name);
						expect(reused.dataset.selected).toBe('false');
					} else {
						expect(column.isConnected).toBe(false);
						expect(listItemNames(el)).toContain(kind === 'kusto' ? 'API' : parentKind === 'view' ? 'Views' : 'Tables');
					}
					expect(el.shadowRoot!.querySelector('[data-testid="cm-schema-column"][data-selected="true"]')).toBeNull();
					expect(selection.rangeCount).toBe(0);
					expect(selection.toString()).toBe('');
				});

				it.each(searchKinds.flatMap(source => ['component', 'outside'].map(location => ({ ...source, location }))))('$kind: Back preserves replacement text selected in $location', async ({ kind, connectionId, database, location }) => {
					const result = searchResult({ kind, connectionId, database, category: 'column', parentName: 'Orders', name: 'DurationMs' });
					const el = await openColumnSearch(kind, [result]);
					const sendSchema = kind === 'kusto' ? sendSchemaLoaded : sendSqlSchemaLoaded;
					sendSchema(el, connectionId, database, sourceSchema());
					await el.updateComplete;
					resultControl(el, result).click();
					await settleColumnReveal(el);
					expectSelectedColumn(el);
					const selection = window.getSelection()!;
					expect(selection.rangeCount).toBe(1);
					expect(selection.toString()).toBe('DurationMs');
					const text = location === 'component'
						? searchControl(el, kind === 'kusto' ? 'cm-filter-all' : 'cm-sql-filter-all').querySelector<HTMLElement>('.filter-label')!
						: document.createElement('span');
					if (location === 'outside') {
						text.textContent = 'Outside connection manager';
						container.appendChild(text);
					}
					const userRange = document.createRange();
					userRange.selectNodeContents(text);
					selection.removeAllRanges();
					selection.addRange(userRange);
					const expectedText = text.textContent;
					expect(selection.toString()).toBe(expectedText);
					const removeRanges = vi.spyOn(selection, 'removeAllRanges');

					clickButtonByTestId(el, kind === 'kusto' ? 'cm-breadcrumb-back' : 'cm-sql-breadcrumb-back');
					expect(removeRanges).not.toHaveBeenCalled();
					expect(selection.rangeCount).toBe(1);
					await settleColumnReveal(el);

					expect(text.isConnected).toBe(true);
					expect(removeRanges).not.toHaveBeenCalled();
					expect(selection.rangeCount).toBe(1);
					expect(selection.getRangeAt(0)).toBe(userRange);
					expect(userRange.startContainer).toBe(text);
					expect(userRange.startOffset).toBe(0);
					expect(userRange.endContainer).toBe(text);
					expect(userRange.endOffset).toBe(text.childNodes.length);
					expect(selection.toString()).toBe(expectedText);
					expect(el.shadowRoot!.querySelector('[data-testid="cm-schema-column"][data-selected="true"]')).toBeNull();
				});

				it.each(['start', 'end'] as const)('preserves an in-place %s offset change when parent navigation retains the column node', async boundary => {
					const result = searchResult({ category: 'column', parentName: 'Orders', name: 'DurationMs' });
					const el = await openColumnSearch('kusto', [result]);
					sendSchemaLoaded(el, 'c1', 'db1', { ...sourceSchema(), tableFolders: {} });
					await el.updateComplete;
					resultControl(el, result).click();
					await settleColumnReveal(el);
					const column = expectSelectedColumn(el);
					const name = column.querySelector<HTMLElement>('.explorer-schema-col-name')!;
					const selection = window.getSelection()!;
					expect(selection.rangeCount).toBe(1);
					expect(selection.toString()).toBe('DurationMs');
					const userRange = selection.getRangeAt(0);
					if (boundary === 'start') userRange.setStart(name, userRange.startOffset + 1);
					else userRange.setEnd(name, userRange.endOffset - 1);
					const expectedRange = userRange.cloneRange();
					const expectedText = userRange.toString();
					const removeRanges = vi.spyOn(selection, 'removeAllRanges');

					clickBreadcrumbByText(el, 'Tables');
					expect(removeRanges).not.toHaveBeenCalled();
					await settleColumnReveal(el);

					expect(searchControl(el, 'cm-schema-column', '[data-table="Orders"][data-column="DurationMs"]')).toBe(column);
					expect(column.querySelector('.explorer-schema-col-name')).toBe(name);
					expect(column.dataset.selected).toBe('false');
					expect(removeRanges).not.toHaveBeenCalled();
					expect(selection.rangeCount).toBe(1);
					expect(selection.getRangeAt(0)).toBe(userRange);
					expect(userRange.startContainer).toBe(expectedRange.startContainer);
					expect(userRange.startOffset).toBe(expectedRange.startOffset);
					expect(userRange.endContainer).toBe(expectedRange.endContainer);
					expect(userRange.endOffset).toBe(expectedRange.endOffset);
					expect(selection.toString()).toBe(expectedText);
				});

				it.each(['owned', 'outside'] as const)('disconnect clears only the owned range with an %s selection', async ownership => {
					const result = searchResult({ category: 'column', parentName: 'Orders', name: 'DurationMs' });
					const el = await openColumnSearch('kusto', [result]);
					sendSchemaLoaded(el, 'c1', 'db1', sourceSchema());
					await el.updateComplete;
					resultControl(el, result).click();
					await settleColumnReveal(el);
					expectSelectedColumn(el);
					const selection = window.getSelection()!;
					expect(selection.rangeCount).toBe(1);
					expect(selection.toString()).toBe('DurationMs');
					const outside = document.createElement('span');
					outside.textContent = 'Outside connection manager';
					container.appendChild(outside);
					const userRange = document.createRange();
					userRange.selectNodeContents(outside);
					if (ownership === 'outside') {
						selection.removeAllRanges();
						selection.addRange(userRange);
					}
					const removeRanges = vi.spyOn(selection, 'removeAllRanges');

					el.remove();

					expect(el.isConnected).toBe(false);
					expect(removeRanges).toHaveBeenCalledTimes(ownership === 'owned' ? 1 : 0);
					expect(selection.rangeCount).toBe(ownership === 'owned' ? 0 : 1);
					expect(selection.toString()).toBe(ownership === 'owned' ? '' : outside.textContent);
					if (ownership === 'outside') {
						expect(outside.isConnected).toBe(true);
						expect(selection.getRangeAt(0)).toBe(userRange);
						expect(userRange.startContainer).toBe(outside);
						expect(userRange.startOffset).toBe(0);
						expect(userRange.endContainer).toBe(outside);
						expect(userRange.endOffset).toBe(outside.childNodes.length);
					}
				});
			});
		});

		it('preserves database-only targets while typing and cancels a superseded scope', async () => {
			vi.useFakeTimers();
			try {
				const postMessage = vi.fn();
				const search = new ConnectionManagerSearchController({ addController: vi.fn(), removeController: vi.fn(), requestUpdate: vi.fn(), updateComplete: Promise.resolve(true), postMessage });
				search.setTargets([{ connectionId: 'c1', database: 'db1' }]);
				search.setQuery('orders');
				await vi.advanceTimersByTimeAsync(300);
				const request = postMessage.mock.calls.map(([message]) => message).find(message => message.type === 'search');
				expect(request).toMatchObject({ scope: 'selected', targets: [{ connectionId: 'c1', database: 'db1' }], categories: { clusters: false, databases: true, tables: true } });
				expect(search.canSearchConnections).toBe(false);
				search.setQuery('orders2');
				await vi.advanceTimersByTimeAsync(300);
				expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'search', scope: 'selected', query: 'orders2' }));
				search.setScope('cached');
				expect(search.handleSearchResults(request.requestId, [searchResult()], true, 'owner')).toBe(false);
				expect(search.canSearchConnections).toBe(true);
				await vi.advanceTimersByTimeAsync(500);
				expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'search', scope: 'cached', categories: expect.objectContaining({ clusters: true }) }));
				expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'search.saveState', state: expect.objectContaining({ scope: 'cached', targets: [{ connectionId: 'c1', database: 'db1' }] }) }));
				search.hostDisconnected();
			} finally {
				vi.useRealTimers();
			}
		});

		it('does not search an empty custom selection and restores its selected targets', async () => {
			vi.useFakeTimers();
			try {
				const postMessage = vi.fn();
				const search = new ConnectionManagerSearchController({ addController: vi.fn(), removeController: vi.fn(), requestUpdate: vi.fn(), updateComplete: Promise.resolve(true), postMessage });
				search.setQuery('orders');
				await vi.advanceTimersByTimeAsync(500);
				expect(search.canSearch).toBe(false);
				expect(postMessage.mock.calls.some(([message]) => message.type === 'search')).toBe(false);
				search.restoreState({ scope: 'selected', query: 'orders', targets: [{ connectionId: 'c1', database: 'db1' }, { connectionId: 'c2' }], lastResults: [searchResult(), searchResult({ connectionId: 'outside' })] }, 'kusto');
				expect(search.canSearch).toBe(true);
				expect(search.canSearchConnections).toBe(true);
				expect(search.results).toEqual([searchResult()]);
				search.setTargets([]);
				await vi.advanceTimersByTimeAsync(500);
				expect(search.results).toEqual([]);
				expect(postMessage.mock.calls.some(([message]) => message.type === 'search')).toBe(false);
				search.hostDisconnected();
			} finally {
				vi.useRealTimers();
			}
		});

		describe('search controller lifecycle', () => {
			let search: ConnectionManagerSearchController;

			beforeEach(() => {
				vi.useFakeTimers();
				search = new ConnectionManagerSearchController({
					addController: vi.fn(), removeController: vi.fn(), requestUpdate: vi.fn(), updateComplete: Promise.resolve(true),
					postMessage(message: unknown) { postedMessages.push(message); },
				});
			});
			afterEach(() => {
				search.hostDisconnected();
				vi.useRealTimers();
			});

			describe.each(searchKinds)('$kind', ({ kind, connectionId, connectionName, database, secondDatabase, connectionCategory }) => {
				beforeEach(() => search.setKind(kind));

				it.each(['toggleCategory', 'toggleContent'] as const)('invalidates a pending query debounce when %s restarts a search', async action => {
					search.setTargets([{ connectionId, database }]);
					search.setQuery('orders');
					search[action]('tables');
					expect(searchRequests()).toHaveLength(1);
					expect(searchRequests()[0]).toMatchObject({
						kind, query: 'orders', scope: 'selected', targets: [{ connectionId, database }],
						categories: { [connectionCategory]: false, tables: action !== 'toggleCategory' },
						contentToggles: { tables: action === 'toggleContent' },
					});
					await vi.advanceTimersByTimeAsync(500);
					expect(searchRequests()).toHaveLength(1);
					expect(messageTypes()).not.toContain('search.cancel');
					expect(savedSearchMessages().at(-1)?.state).toMatchObject({
						kind, query: 'orders', scope: 'selected', targets: [{ connectionId, database }],
						categories: { tables: action !== 'toggleCategory' },
						contentToggles: { tables: action === 'toggleContent' },
					});
				});

				it('rejects older snapshot targets after edits, kind handoff, and an explicit clear', async () => {
					const olderState: Partial<SearchState> = {
						kind, query: 'old-query', scope: 'selected', targets: [{ connectionId, database }],
						lastResults: [searchResult({ kind, connectionId, connectionName, database, name: 'OldOrders' })],
					};
					search.restoreState(olderState, kind, true);
					search.setQuery('latest-query');
					search.setTargets([{ connectionId, database: secondDatabase }]);
					await vi.advanceTimersByTimeAsync(300);
					const request = searchRequests().at(-1)!;
					expect(search.handleSearchResults(request.requestId, [searchResult({ kind, connectionId, connectionName, database: secondDatabase })], true, 'live-owner')).toBe(true);
					const liveResults = [...search.results];
					postedMessages = [];
					search.restoreState(olderState, kind, true);
					expect(search).toMatchObject({ query: 'latest-query', scope: 'selected', targets: [{ connectionId, database: secondDatabase }], results: liveResults });
					expect(postedMessages).toEqual([]);

					search.setKind(kind === 'kusto' ? 'sql' : 'kusto');
					search.restoreState(olderState, kind, true);
					expect(search).toMatchObject({ kind, query: 'latest-query', scope: 'selected', targets: [{ connectionId, database: secondDatabase }], results: [] });
					search.setTargets([]);
					search.restoreState(olderState, kind, true);
					expect(search.targets).toEqual([]);
					expect(search.results).toEqual([]);
					expect(search.canSearch).toBe(false);
					await vi.advanceTimersByTimeAsync(500);
					expect(searchRequests()).toEqual([]);
					expect(savedSearchMessages().at(-1)).toMatchObject({ kind, state: { kind, query: 'latest-query', scope: 'selected', targets: [], lastResults: [] } });
				});

				it('saves Apply and Clear immediately, including a query still waiting for debounce', async () => {
					search.setTargets([{ connectionId, database }]);
					expect(messageTypes()).toEqual(['search.saveState']);
					const applied = savedSearchMessages()[0];
					expect(applied).toMatchObject({ kind, state: { kind, scope: 'selected', query: '', targets: [{ connectionId, database }], lastResults: [] } });
					search.setQuery('orders');
					search.setTargets([]);
					expect(savedSearchMessages()).toHaveLength(2);
					expect(savedSearchMessages()[1]).toMatchObject({ kind, state: { kind, scope: 'selected', query: 'orders', targets: [], lastResults: [] } });
					expect(applied.state.targets).toEqual([{ connectionId, database }]);
					await vi.advanceTimersByTimeAsync(500);
					expect(savedSearchMessages()).toHaveLength(2);
					expect(searchRequests()).toEqual([]);
				});

				it('rejects a restored state tagged with the other kind, including its preferences and results', () => {
					const otherKind = kind === 'kusto' ? 'sql' : 'kusto';
					const categories = { ...search.categories };
					const contentToggles = { ...search.contentToggles };
					search.restoreState({
						kind: otherKind, query: 'foreign-query', scope: 'everything',
						targets: [{ connectionId: 'foreign-connection', database: 'ForeignDb' }],
						categories: { [otherKind === 'sql' ? 'servers' : 'clusters']: false, tables: false },
						contentToggles: { tables: true }, lastResults: [searchResult({ kind: otherKind, name: 'ForeignOrders' })],
					}, kind, true);
					expect(search).toMatchObject({ kind, scope: 'selected', query: '', targets: [], categories, contentToggles, results: [], loading: false });
					expect(search.canSearch).toBe(false);
					expect(postedMessages).toEqual([]);
				});

				it('cancels request A immediately on typing B and ignores A before and after B starts', async () => {
					search.setTargets([{ connectionId, database }]);
					search.setQuery('query-A');
					await vi.advanceTimersByTimeAsync(300);
					const requestA = searchRequests().at(-1)!;
					const resultA = searchResult({ kind, connectionId, connectionName, database, name: 'OrdersA' });
					expect(search.handleSearchResults(requestA.requestId, [resultA], false, 'owner-A')).toBe(true);
					search.handleSearchProgress(requestA.requestId, 'A progress', 1, 2);
					postedMessages = [];
					search.setQuery('query-B');
					expect(postedMessages).toEqual([{ type: 'search.cancel', requestId: requestA.requestId }]);
					expect(search).toMatchObject({ query: 'query-B', loading: false, refreshing: false, results: [], progressMessage: '' });
					expect(search.handleSearchResults(requestA.requestId, [resultA], true, 'owner-A')).toBe(false);
					search.handleSearchProgress(requestA.requestId, 'Stale A progress', 2, 2);
					expect(search.progressMessage).toBe('');
					await vi.advanceTimersByTimeAsync(299);
					expect(searchRequests()).toEqual([]);
					await vi.advanceTimersByTimeAsync(1);
					expect(searchRequests()).toHaveLength(1);
					const requestB = searchRequests()[0];
					expect(requestB).toMatchObject({ kind, query: 'query-B', scope: 'selected', targets: [{ connectionId, database }], categories: { [connectionCategory]: false } });
					expect(requestB.requestId).not.toBe(requestA.requestId);
					search.handleSearchProgress(requestB.requestId, 'B progress', 1, 2);
					expect(search.handleSearchResults(requestA.requestId, [resultA], true, 'owner-A')).toBe(false);
					search.handleSearchProgress(requestA.requestId, 'Stale A progress', 2, 2);
					expect(search).toMatchObject({ results: [], loading: true, progressMessage: 'B progress' });
					const resultB = searchResult({ kind, connectionId, connectionName, database, name: 'OrdersB' });
					expect(search.handleSearchResults(requestB.requestId, [resultB], true, 'owner-B')).toBe(true);
					expect(search.results).toHaveLength(1);
					expect(search.results[0]).toMatchObject(resultB);
					expect(search.loading).toBe(false);
					expect(savedSearchMessages().at(-1)?.state).toMatchObject({ kind, query: 'query-B', targets: [{ connectionId, database }], lastResults: search.results });
				});

				it.each([
					['refresh-cached', 'cached'],
					['everything', 'everything'],
				] as const)('restores legacy %s as %s without requiring selected targets', (legacyScope, expectedScope) => {
					search.restoreState({
						query: 'legacy-orders', scope: legacyScope, categories: { [connectionCategory]: false },
						contentToggles: { tables: true }, lastResults: [],
					}, kind, true);
					expect(search.scope).toBe(expectedScope);
					expect(search.targets).toEqual([]);
					expect(search.canSearch).toBe(true);
					search.rerunSearch();
					const request = searchRequests().at(-1)!;
					expect(request).toMatchObject({ kind, query: 'legacy-orders', scope: expectedScope, categories: { [connectionCategory]: false }, contentToggles: { tables: true } });
					expect(request).not.toHaveProperty('targets');
					expect(search.refreshing).toBe(expectedScope === 'everything');
					expect(search.handleSearchResults(request.requestId, [searchResult({ kind, connectionId, connectionName, database })], true, 'legacy-owner')).toBe(true);
					expect(savedSearchMessages().at(-1)).toMatchObject({ kind, state: { kind, scope: expectedScope, targets: [] } });
				});
			});

			it('remembers distinct per-kind preferences without sharing targets, results, or active requests', async () => {
				search.setTargets([{ connectionId: 'c1', database: 'db1' }]);
				search.toggleCategory('clusters');
				search.toggleContent('tables');
				search.setQuery('kusto-orders');
				await vi.advanceTimersByTimeAsync(300);
				const kustoRequest = searchRequests().at(-1)!;
				expect(search.handleSearchResults(kustoRequest.requestId, [searchResult()], false, 'kusto-owner')).toBe(true);
				search.handleSearchProgress(kustoRequest.requestId, 'Kusto progress', 1, 2);
				search.setKind('sql');
				expect(postedMessages).toContainEqual({ type: 'search.cancel', requestId: kustoRequest.requestId });
				expect(search).toMatchObject({ kind: 'sql', query: '', scope: 'selected', targets: [], results: [], loading: false, refreshing: false, progressMessage: '' });
				expect(search.categories).toEqual({ servers: true, databases: true, tables: true, views: true, storedProcedures: true });
				expect(search.contentToggles).toEqual({ tables: false, views: false, storedProcedures: false });
				expect(search.handleSearchResults(kustoRequest.requestId, [searchResult()], true, 'kusto-owner')).toBe(false);

				search.setTargets([{ connectionId: 'sql1', database: 'sqldb1' }]);
				search.setScope('everything');
				search.toggleCategory('servers');
				search.cycleCategory('views', true);
				search.setQuery('sql-orders');
				await vi.advanceTimersByTimeAsync(300);
				const sqlRequest = searchRequests().at(-1)!;
				expect(sqlRequest).toMatchObject({ kind: 'sql', scope: 'everything', query: 'sql-orders' });
				expect(sqlRequest).not.toHaveProperty('targets');
				const sqlResult = searchResult({ kind: 'sql', connectionId: 'sql1', database: 'sqldb1', name: 'SqlOrders' });
				expect(search.handleSearchResults(sqlRequest.requestId, [sqlResult], false)).toBe(true);
				search.handleSearchProgress(sqlRequest.requestId, 'SQL progress', 1, 2);
				search.setKind('kusto');
				expect(postedMessages).toContainEqual({ type: 'search.cancel', requestId: sqlRequest.requestId });
				expect(search).toMatchObject({ kind: 'kusto', query: 'kusto-orders', scope: 'selected', targets: [{ connectionId: 'c1', database: 'db1' }], results: [], loading: false, refreshing: false, progressMessage: '' });
				expect(search.categories).toEqual({ clusters: false, databases: true, tables: true, functions: true });
				expect(search.contentToggles).toEqual({ tables: true, functions: false });
				expect(search.handleSearchResults(sqlRequest.requestId, [sqlResult], true)).toBe(false);

				search.restoreState({ kind: 'sql', query: 'obsolete-sql', scope: 'cached', targets: [] }, 'sql', true);
				expect(search).toMatchObject({ kind: 'sql', query: 'sql-orders', scope: 'everything', targets: [{ connectionId: 'sql1', database: 'sqldb1' }], results: [], loading: false, progressMessage: '' });
				expect(search.categories).toEqual({ servers: false, databases: true, tables: true, views: true, storedProcedures: true });
				expect(search.contentToggles).toEqual({ tables: false, views: true, storedProcedures: false });
				await vi.advanceTimersByTimeAsync(500);
				expect(searchRequests()).toHaveLength(2);
				for (const saved of savedSearchMessages()) {
					expect(saved.state.kind).toBe(saved.kind);
					expect(saved.state.targets?.every(target => target.connectionId === (saved.kind === 'sql' ? 'sql1' : 'c1'))).toBe(true);
					expect(saved.state.lastResults.every(result => result.kind === saved.kind)).toBe(true);
				}
			});
		});

		it.each([
			{ kind: 'kusto', connectionId: 'c1', database: 'db1', category: 'tables', contentCategory: 'tableColumns', nameLabel: 'Table Names', contentLabel: 'Table Columns', resultCategory: 'table' },
			{ kind: 'kusto', connectionId: 'c1', database: 'db1', category: 'functions', contentCategory: 'functionBody', nameLabel: 'Function Name', contentLabel: 'Function Body', resultCategory: 'function' },
			{ kind: 'sql', connectionId: 'sql1', database: 'sqldb1', category: 'tables', contentCategory: 'tableColumns', nameLabel: 'Table Names', contentLabel: 'Table Columns', resultCategory: 'table' },
		] as const)('$kind: independently toggles $category and $contentCategory through all four states and restored interaction', async ({ kind, connectionId, database, category, contentCategory, nameLabel, contentLabel, resultCategory }) => {
			vi.useFakeTimers();
			try {
				const categories = kind === 'sql'
					? { servers: false, databases: false, tables: true, views: false, storedProcedures: false }
					: { clusters: false, databases: false, tables: false, functions: false, [category]: true };
				const targets = [{ connectionId, database }];
				let el = await openSearch(kind, { searchState: { kind, query: '', scope: 'selected', targets, categories } });
				const nameResult = searchResult({ kind, connectionId, database, category: resultCategory, name: 'Orders' });
				const contentResult = searchResult({ kind, connectionId, database, category: resultCategory === 'table' ? 'column' : 'function', name: 'ContentMatch', parentName: 'Orders', matchContext: 'orders in content' });
				for (const [id, label, pressed] of [[category, nameLabel, 'true'], [contentCategory, contentLabel, 'false']]) {
					const button = searchControl<HTMLButtonElement>(el, 'cm-search-category', `[data-category="${id}"]`);
					expect(button.textContent?.trim()).toBe(label);
					expect(button.getAttribute('aria-label')).toBe(label);
					expect(button.title).toBe(label);
					expect(button.getAttribute('aria-pressed')).toBe(pressed);
				}
				const nameIcon = searchControl(el, 'cm-search-category', `[data-category="${category}"]`).querySelector('.search-chip-icon');
				const contentIcon = searchControl(el, 'cm-search-category', `[data-category="${contentCategory}"]`).querySelector('.search-chip-icon');
				expect(nameIcon?.querySelector('svg, .codicon')).not.toBeNull();
				expect(contentIcon?.querySelector('svg, .codicon')).not.toBeNull();
				expect(nameIcon?.innerHTML).not.toBe(contentIcon?.innerHTML);
				await typeSearchInput(el, 'cm-search-input', 'orders');
				await vi.advanceTimersByTimeAsync(300);
				sendSearchResults(searchRequests().at(-1)!.requestId, [nameResult]);
				await el.updateComplete;
				expect(listItemNames(el)).toEqual(['Orders']);

				for (const [id, names, content] of [
					[category, false, false], [contentCategory, false, true], [category, true, true], [contentCategory, true, false],
				] as const) {
					const previousRequest = searchRequests().at(-1)!;
					const previousCount = searchRequests().length;
					searchControl<HTMLButtonElement>(el, 'cm-search-category', `[data-category="${id}"]`).click();
					await el.updateComplete;
					expect(searchRequests()).toHaveLength(previousCount + 1);
					const request = searchRequests().at(-1)!;
					expect(request).toMatchObject({ kind, query: 'orders', scope: 'selected', targets, categories: { [category]: names }, contentToggles: { [category]: content } });
					expect(request.categories).not.toHaveProperty(contentCategory);
					expect(request.contentToggles).not.toHaveProperty(contentCategory);
					expect(searchControl(el, 'cm-search-category', `[data-category="${category}"]`).getAttribute('aria-pressed')).toBe(String(names));
					expect(searchControl(el, 'cm-search-category', `[data-category="${contentCategory}"]`).getAttribute('aria-pressed')).toBe(String(content));
					expect(listItemNames(el)).toEqual([]);
					sendSearchResults(previousRequest.requestId, [nameResult, contentResult], true);
					await el.updateComplete;
					expect(listItemNames(el)).toEqual([]);
					const results = [...(names ? [nameResult] : []), ...(content ? [contentResult] : [])];
					sendSearchResults(request.requestId, results);
					await el.updateComplete;
					expect(listItemNames(el)).toEqual(results.map(result => result.name));
					await vi.advanceTimersByTimeAsync(500);
					expect(searchRequests()).toHaveLength(previousCount + 1);
					const saved = savedSearchMessages().at(-1)!;
					expect(saved.state).toMatchObject({ kind, query: 'orders', scope: 'selected', targets, categories: { [category]: names }, contentToggles: { [category]: content } });
					expect(saved.state.lastResults.map(result => result.name)).toEqual(results.map(result => result.name));
					if (!names) {
						expect(Object.values(request.categories).every(value => value === false)).toBe(true);
						const serialized = JSON.stringify(saved.state);
						const previous = el;
						render(nothing, container);
						el = await openSearch(kind, { searchState: JSON.parse(serialized) });
						expect(el).not.toBe(previous);
						expect(searchControl(el, 'cm-search-category', `[data-category="${category}"]`).getAttribute('aria-pressed')).toBe('false');
						expect(searchControl(el, 'cm-search-category', `[data-category="${contentCategory}"]`).getAttribute('aria-pressed')).toBe(String(content));
						expect(listItemNames(el)).toEqual(results.map(result => result.name));
						expect(JSON.stringify(saved.state)).toBe(serialized);
					}
				}
			} finally {
				render(nothing, container);
				vi.useRealTimers();
			}
		});

		it.each([
			{ category: 'views', resultCategory: 'column' },
			{ category: 'storedProcedures', resultCategory: 'stored-procedure' },
		] as const)('keeps SQL $category three-state and its content independent of table flags', async ({ category, resultCategory }) => {
			vi.useFakeTimers();
			try {
				const el = await openSearch('sql', { searchState: {
					kind: 'sql', scope: 'selected', targets: [{ connectionId: 'sql1', database: 'sqldb1' }],
					categories: { servers: false, databases: false, tables: false, views: false, storedProcedures: false, [category]: true },
				} });
				const control = searchControl<HTMLButtonElement>(el, 'cm-search-category', `[data-category="${category}"]`);
				expect(control.getAttribute('aria-pressed')).toBe('true');
				expect(control.classList.contains('content-on')).toBe(false);
				await typeSearchInput(el, 'cm-search-input', 'orders');
				control.click();
				await el.updateComplete;
				expect(control.classList.contains('content-on')).toBe(true);
				await vi.advanceTimersByTimeAsync(500);
				expect(searchRequests()).toHaveLength(1);
				expect(searchRequests()[0]).toMatchObject({ categories: { tables: false, [category]: true }, contentToggles: { tables: false, [category]: true } });
				sendSearchResults(searchRequests()[0].requestId, [searchResult({ kind: 'sql', connectionId: 'sql1', database: 'sqldb1', category: resultCategory, name: 'ContentMatch', parentName: 'Orders' })], true);
				await el.updateComplete;
				expect(listItemNames(el)).toEqual(['ContentMatch']);
				for (const names of [false, true]) {
					control.click();
					await el.updateComplete;
					expect(control.getAttribute('aria-pressed')).toBe(String(names));
					expect(control.classList.contains('content-on')).toBe(false);
					if (!names) expect(listItemNames(el)).toEqual([]);
					await vi.advanceTimersByTimeAsync(500);
					expect(savedSearchMessages().at(-1)?.state).toMatchObject({ categories: { tables: false, [category]: names }, contentToggles: { tables: false, [category]: false } });
				}
			} finally {
				render(nothing, container);
				vi.useRealTimers();
			}
		});

		describe.each(searchKinds)('$kind search target controls', ({ kind, connectionId, connectionName, database, secondDatabase, otherConnectionId, otherConnectionName, connectionCategory }) => {
			beforeEach(() => vi.useFakeTimers());
			afterEach(() => {
				render(nothing, container);
				vi.useRealTimers();
			});

			it('starts selected-empty with only Where to search and the native scope options', async () => {
				const el = await openSearch(kind);
				const scope = searchControl<HTMLSelectElement>(el, 'cm-search-scope');
				expect(scope).toBeInstanceOf(HTMLSelectElement);
				expect(scope.value).toBe('selected');
				expect(Array.from(scope.options, option => [option.value, option.textContent])).toEqual([
					['selected', 'Specific cluster(s) or database(s)'], ['cached', 'All cached connections (fast)'], ['everything', 'All connections (slow)'],
				]);
				expect(Array.from(el.shadowRoot!.querySelectorAll('.search-section-label'), label => label.textContent?.trim())).toEqual(['Where to search']);
				expect(searchTargetLabels(el)).toEqual([]);
				const picker = searchControl<HTMLButtonElement>(el, 'cm-search-target-picker');
				expect(searchControl(el, 'cm-search-targets').lastElementChild).toBe(picker);
				expect(picker.title).toBe(`Add ${connectionCategory} or databases`);
				expect(picker.getAttribute('aria-label')).toBe(picker.title);
				expect(picker.textContent?.trim()).toBe('');
				expect(picker.querySelector('svg, .codicon')).not.toBeNull();
				for (const testId of ['cm-search-input', 'cm-search-categories', 'cm-search-results']) {
					expect(el.shadowRoot!.querySelector(`[data-testid="${testId}"]`)).toBeNull();
				}
				postedMessages = [];
				await vi.advanceTimersByTimeAsync(500);
				expect(messageTypes()).not.toContain('search');

				for (const selectedScope of ['cached', 'everything'] as const) {
					await selectSearchScope(el, selectedScope);
					expect(scope.value).toBe(selectedScope);
					expect(searchControl(el, 'cm-search-input')).toBeInstanceOf(HTMLInputElement);
					expect(searchControl(el, 'cm-search-category', `[data-category="${connectionCategory}"]`)).toBeInstanceOf(HTMLButtonElement);
					expect(el.shadowRoot!.querySelector('[data-testid="cm-search-target-picker"]')).toBeNull();
					expect(savedSearchMessages().at(-1)).toMatchObject({ kind, state: { kind, scope: selectedScope, targets: [] } });
				}
				await selectSearchScope(el, 'selected');
				expect(el.shadowRoot!.querySelector('[data-testid="cm-search-input"]')).toBeNull();
				expect(messageTypes()).not.toContain('search');
			});

			it.each(['whole', 'database-only', 'mixed'] as const)('applies %s targets with labelled tags and matching category controls', async selection => {
				const el = await openSearch(kind);
				clickButtonByTestId(el, 'cm-search-target-picker');
				await el.updateComplete;
				const targets: ConnectionSearchTarget[] = [];
				const labels: string[] = [];
				if (selection === 'database-only') {
					await clickSearchTarget(el, 'expand', connectionId);
					await clickSearchTarget(el, 'database', connectionId, database);
					targets.push({ connectionId, database });
					labels.push(`${connectionName} / ${database}`);
				} else {
					await clickSearchTarget(el, 'cluster', connectionId);
					targets.push({ connectionId });
					labels.push(`${connectionName} (all databases)`);
				}
				if (selection === 'mixed') {
					await clickSearchTarget(el, 'expand', otherConnectionId);
					await clickSearchTarget(el, 'database', otherConnectionId, 'ArchiveDb');
					targets.push({ connectionId: otherConnectionId, database: 'ArchiveDb' });
					labels.push(`${otherConnectionName} / ArchiveDb`);
				}
				postedMessages = [];
				clickButtonByTestId(el, 'cm-search-target-apply');
				expect(savedSearchMessages()).toHaveLength(1);
				expect(savedSearchMessages()[0]).toMatchObject({ kind, state: { kind, scope: 'selected', targets, query: '', lastResults: [] } });
				await el.updateComplete;
				expect(searchTargetLabels(el)).toEqual(labels);
				const tags = Array.from(el.shadowRoot!.querySelectorAll<HTMLElement>('[data-testid="cm-search-target-tag"]'));
				expect(tags).toHaveLength(targets.length);
				for (const [index, tag] of tags.entries()) {
					expect(tag.title).toBe(labels[index]);
					expect(tag.querySelector<HTMLElement>('[data-testid="cm-search-target-label"]')?.title).toBe(labels[index]);
					const remove = tag.querySelector<HTMLButtonElement>('[data-testid="cm-search-target-remove"]')!;
					expect(remove.type).toBe('button');
					expect(remove.title).toBe(`Remove ${labels[index]}`);
					expect(remove.getAttribute('aria-label')).toBe(remove.title);
					for (const element of [tag, remove]) {
						expect(element.dataset.connectionId).toBe(targets[index].connectionId);
						expect(element.dataset.database).toBe(targets[index].database ?? '');
					}
				}
				expect(searchControl(el, 'cm-search-targets').lastElementChild).toBe(searchControl(el, 'cm-search-target-picker'));
				expect(searchControl(el, 'cm-search-input')).toBeInstanceOf(HTMLInputElement);
				const expectedCategories = kind === 'kusto' ? ['clusters', 'databases', 'tables', 'tableColumns', 'functions', 'functionBody'] : ['servers', 'databases', 'tables', 'tableColumns', 'views', 'storedProcedures'];
				expect(Array.from(el.shadowRoot!.querySelectorAll('[data-testid="cm-search-category"]'), chip => chip.getAttribute('data-category')))
					.toEqual(expectedCategories.filter(category => selection !== 'database-only' || category !== connectionCategory));
				if (selection === 'database-only') {
					expect(el.shadowRoot!.querySelector(`[data-testid="cm-search-category"][data-category="${connectionCategory}"]`)).toBeNull();
				}
				expect(messageTypes()).not.toContain('search');
			});

			it('converts all databases to specific children on uncheck and restores an indeterminate parent', async () => {
				const el = await openSearch(kind);
				clickButtonByTestId(el, 'cm-search-target-picker');
				await el.updateComplete;
				await clickSearchTarget(el, 'cluster', connectionId);
				clickButtonByTestId(el, 'cm-search-target-apply');
				await el.updateComplete;
				clickButtonByTestId(el, 'cm-search-target-picker');
				await el.updateComplete;
				await clickSearchTarget(el, 'expand', connectionId);
				const parent = searchControl<HTMLInputElement>(el, 'cm-search-target-cluster', `[data-connection-id="${connectionId}"]`);
				expect(parent.checked).toBe(true);
				expect(parent.indeterminate).toBe(false);
				for (const child of [database, secondDatabase]) {
					expect(searchControl<HTMLInputElement>(el, 'cm-search-target-database', `[data-database="${child}"]`).checked).toBe(true);
				}
				await clickSearchTarget(el, 'database', connectionId, database);
				expect(parent.checked).toBe(false);
				expect(parent.indeterminate).toBe(true);
				expect(parent.getAttribute('aria-checked')).toBe('mixed');
				expect(searchControl<HTMLInputElement>(el, 'cm-search-target-database', `[data-database="${database}"]`).checked).toBe(false);
				expect(searchControl<HTMLInputElement>(el, 'cm-search-target-database', `[data-database="${secondDatabase}"]`).checked).toBe(true);
				expect(searchTargetLabels(el)).toEqual([`${connectionName} (all databases)`]);
				clickButtonByTestId(el, 'cm-search-target-apply');
				await el.updateComplete;
				expect(savedSearchMessages().at(-1)?.state.targets).toEqual([{ connectionId, database: secondDatabase }]);
				expect(searchTargetLabels(el)).toEqual([`${connectionName} / ${secondDatabase}`]);
				expect(el.shadowRoot!.querySelector(`[data-testid="cm-search-category"][data-category="${connectionCategory}"]`)).toBeNull();
				clickButtonByTestId(el, 'cm-search-target-picker');
				await el.updateComplete;
				expect(searchControl<HTMLInputElement>(el, 'cm-search-target-cluster', `[data-connection-id="${connectionId}"]`).indeterminate).toBe(true);
				expect(searchControl<HTMLInputElement>(el, 'cm-search-target-database', `[data-database="${secondDatabase}"]`).checked).toBe(true);
			});

			it('isolates Cancel from applied targets and does not mutate earlier save messages', async () => {
				const el = await openSearch(kind);
				clickButtonByTestId(el, 'cm-search-target-picker');
				await el.updateComplete;
				await clickSearchTarget(el, 'expand', connectionId);
				await clickSearchTarget(el, 'database', connectionId, database);
				clickButtonByTestId(el, 'cm-search-target-apply');
				await el.updateComplete;
				const applied = savedSearchMessages().at(-1)!;
				postedMessages = [];
				clickButtonByTestId(el, 'cm-search-target-picker');
				await el.updateComplete;
				await clickSearchTarget(el, 'cluster', connectionId);
				expect(searchTargetLabels(el)).toEqual([`${connectionName} / ${database}`]);
				expect(savedSearchMessages()).toEqual([]);
				clickButtonByTestId(el, 'cm-search-target-cancel');
				await el.updateComplete;
				expect(el.shadowRoot!.querySelector('[data-testid="cm-search-target-dialog"]')).toBeNull();
				expect(savedSearchMessages()).toEqual([]);
				clickButtonByTestId(el, 'cm-search-target-picker');
				await el.updateComplete;
				expect(searchControl<HTMLInputElement>(el, 'cm-search-target-cluster', `[data-connection-id="${connectionId}"]`).indeterminate).toBe(true);
				expect(searchControl<HTMLInputElement>(el, 'cm-search-target-database', `[data-database="${database}"]`).checked).toBe(true);
				expect(searchControl<HTMLInputElement>(el, 'cm-search-target-database', `[data-database="${secondDatabase}"]`).checked).toBe(false);
				await clickSearchTarget(el, 'database', connectionId, secondDatabase);
				clickButtonByTestId(el, 'cm-search-target-apply');
				await el.updateComplete;
				expect(savedSearchMessages()).toHaveLength(1);
				expect(savedSearchMessages()[0].state.targets).toEqual([{ connectionId, database }, { connectionId, database: secondDatabase }]);
				expect(applied.state.targets).toEqual([{ connectionId, database }]);
				expect(el.shadowRoot!.querySelector(`[data-testid="cm-search-category"][data-category="${connectionCategory}"]`)).toBeNull();
				expect(messageTypes()).not.toContain('search');
			});

			it('matches database names case-insensitively and expands their parent without discovery', async () => {
				const el = await openSearch(kind);
				clickButtonByTestId(el, 'cm-search-target-picker');
				await el.updateComplete;
				postedMessages = [];
				expect(searchControl(el, 'cm-search-target-expand', `[data-connection-id="${connectionId}"]`).getAttribute('aria-expanded')).toBe('false');
				await typeSearchInput(el, 'cm-search-target-filter', `  ${database.toUpperCase()}  `);
				expect(searchControl(el, 'cm-search-target-expand', `[data-connection-id="${connectionId}"]`).getAttribute('aria-expanded')).toBe('true');
				expect(Array.from(el.shadowRoot!.querySelectorAll('[data-testid="cm-search-target-database"]'), checkbox => checkbox.getAttribute('data-database'))).toEqual([database]);
				expect(el.shadowRoot!.querySelector(`[data-testid="cm-search-target-cluster"][data-connection-id="${otherConnectionId}"]`)).toBeNull();
				await typeSearchInput(el, 'cm-search-target-filter', '');
				expect(el.shadowRoot!.querySelectorAll('[data-testid="cm-search-target-cluster"]')).toHaveLength(2);
				expect(el.shadowRoot!.querySelectorAll('[data-testid="cm-search-target-database"]')).toHaveLength(2);
				await typeSearchInput(el, 'cm-search-target-filter', 'no-matching-database');
				expect(searchControl(el, 'cm-search-target-dialog').textContent).toContain(`No matching ${connectionCategory} or databases.`);
				expect(postedMessages).toEqual([]);
			});

			it('loads unknown databases through host messages, retries failure, and refreshes an empty list', async () => {
				const cacheKey = kind === 'sql' ? 'sqlCachedDatabases' : 'cachedDatabases';
				const prefix = kind === 'sql' ? 'sql.' : '';
				const el = await openSearch(kind, { revision: 1, [cacheKey]: {} });
				clickButtonByTestId(el, 'cm-search-target-picker');
				await el.updateComplete;
				postedMessages = [];
				await clickSearchTarget(el, 'cluster', connectionId);
				await clickSearchTarget(el, 'cluster', connectionId);
				expect(postedMessages).toEqual([]);
				await clickSearchTarget(el, 'expand', connectionId);
				expect(postedMessages).toEqual([{ type: `${prefix}cluster.expand`, connectionId }]);
				expect(searchControl(el, 'cm-search-target-unloaded').textContent).toContain('Databases not loaded.');
				clickButtonByTestId(el, 'cm-search-target-load');
				expect(postedMessages.at(-1)).toEqual({ type: `${prefix}cluster.refreshDatabases`, connectionId });
				window.dispatchEvent(new MessageEvent('message', { data: { type: `${prefix}loadingDatabases`, connectionId, requestId: 'load-1' } }));
				await el.updateComplete;
				expect(searchControl(el, 'cm-search-target-loading').getAttribute('role')).toBe('status');
				postedMessages = [];
				await clickSearchTarget(el, 'expand', connectionId);
				await clickSearchTarget(el, 'expand', connectionId);
				expect(postedMessages).toEqual([]);
				window.dispatchEvent(new MessageEvent('message', { data: { type: `${prefix}databasesLoadError`, connectionId, requestId: 'load-1', error: 'Backend diagnostic details' } }));
				await el.updateComplete;
				expect(el.shadowRoot!.querySelector('[data-testid="cm-search-target-loading"]')).toBeNull();
				expect(searchControl(el, 'cm-search-target-error').textContent).toContain('Could not load databases.');
				expect(searchControl(el, 'cm-search-target-error').getAttribute('role')).toBe('alert');
				expect(searchControl(el, 'cm-search-target-dialog').textContent).not.toContain('Backend diagnostic details');
				clickButtonByTestId(el, 'cm-search-target-retry');
				expect(postedMessages).toEqual([{ type: `${prefix}cluster.refreshDatabases`, connectionId }]);
				window.dispatchEvent(new MessageEvent('message', { data: { type: `${prefix}loadingDatabases`, connectionId, requestId: 'load-2' } }));
				await el.updateComplete;
				expect(el.shadowRoot!.querySelector('[data-testid="cm-search-target-error"]')).toBeNull();
				window.dispatchEvent(new MessageEvent('message', { data: { type: `${prefix}databasesLoaded`, connectionId, requestId: 'load-2' } }));
				expect(postedMessages.at(-1)).toEqual({ type: 'requestSnapshot' });
				sendSnapshot(el, searchSnapshot(kind, { revision: 2, [cacheKey]: { [connectionId]: [] } }));
				await el.updateComplete;
				expect(searchControl(el, 'cm-search-target-empty').textContent).toContain('No databases found.');
				postedMessages = [];
				clickButtonByTestId(el, 'cm-search-target-refresh');
				expect(postedMessages).toEqual([{ type: `${prefix}cluster.refreshDatabases`, connectionId }]);
				window.dispatchEvent(new MessageEvent('message', { data: { type: `${prefix}loadingDatabases`, connectionId, requestId: 'load-3' } }));
				window.dispatchEvent(new MessageEvent('message', { data: { type: `${prefix}databasesLoaded`, connectionId, requestId: 'load-3' } }));
				expect(postedMessages.at(-1)).toEqual({ type: 'requestSnapshot' });
				sendSnapshot(el, searchSnapshot(kind, { revision: 3, [cacheKey]: { [connectionId]: [database, secondDatabase] } }));
				await el.updateComplete;
				expect(el.shadowRoot!.querySelector('[data-testid="cm-search-target-loading"]')).toBeNull();
				expect(el.shadowRoot!.querySelector('[data-testid="cm-search-target-empty"]')).toBeNull();
				expect(el.shadowRoot!.querySelectorAll('[data-testid="cm-search-target-database"]')).toHaveLength(2);
				await clickSearchTarget(el, 'database', connectionId, database);
				clickButtonByTestId(el, 'cm-search-target-apply');
				await el.updateComplete;
				expect(savedSearchMessages().at(-1)?.state.targets).toEqual([{ connectionId, database }]);
				expect(searchTargetLabels(el)).toEqual([`${connectionName} / ${database}`]);
			});

			it.each(['clear', 'change'] as const)('roundtrips a real saveState into a fresh component, then %s and saves without stale restoration', async action => {
				const el = await openSearch(kind, { revision: 1 });
				clickButtonByTestId(el, 'cm-search-target-picker');
				await el.updateComplete;
				await clickSearchTarget(el, 'cluster', connectionId);
				await clickSearchTarget(el, 'expand', otherConnectionId);
				await clickSearchTarget(el, 'database', otherConnectionId, 'ArchiveDb');
				clickButtonByTestId(el, 'cm-search-target-apply');
				await el.updateComplete;
				searchControl<HTMLButtonElement>(el, 'cm-search-category', '[data-category="tableColumns"]').click();
				await typeSearchInput(el, 'cm-search-input', 'orders');
				await vi.advanceTimersByTimeAsync(300);
				const request = searchRequests().at(-1)!;
				const targets = [{ connectionId }, { connectionId: otherConnectionId, database: 'ArchiveDb' }];
				expect(request).toMatchObject({ kind, query: 'orders', scope: 'selected', targets, contentToggles: { tables: true } });
				const results = [
					searchResult({ kind, connectionId, connectionName, database }),
					searchResult({ kind, connectionId: otherConnectionId, connectionName: otherConnectionName, database: 'ArchiveDb', name: 'ArchiveOrders' }),
				];
				window.dispatchEvent(new MessageEvent('message', { data: {
					type: 'searchResults', requestId: request.requestId, results, completed: true, kustoSearchOwnerToken: 'roundtrip-owner',
				} }));
				await el.updateComplete;
				expect(listItemNames(el)).toEqual(['Orders', 'ArchiveOrders']);
				const saved = savedSearchMessages().at(-1)!;
				expect(saved).toMatchObject({ kind, state: { kind, query: 'orders', scope: 'selected', targets, contentToggles: { tables: true } } });
				expect(saved.state.lastResults.map(result => result.name)).toEqual(['Orders', 'ArchiveOrders']);
				const serializedState = JSON.stringify(saved.state);
				render(nothing, container);

				const restored = await openSearch(kind, { revision: 2, searchState: JSON.parse(serializedState) });
				expect(restored).not.toBe(el);
				expect(searchControl<HTMLSelectElement>(restored, 'cm-search-scope').value).toBe('selected');
				expect(searchControl<HTMLInputElement>(restored, 'cm-search-input').value).toBe('orders');
				expect(searchTargetLabels(restored)).toEqual([`${connectionName} (all databases)`, `${otherConnectionName} / ArchiveDb`]);
				expect(searchControl(restored, 'cm-search-category', '[data-category="tableColumns"]').getAttribute('aria-pressed')).toBe('true');
				expect(listItemNames(restored)).toEqual(['Orders', 'ArchiveOrders']);
				postedMessages = [];
				clickButtonByTestId(restored, 'cm-search-target-picker');
				await restored.updateComplete;
				expect(searchControl<HTMLInputElement>(restored, 'cm-search-target-cluster', `[data-connection-id="${connectionId}"]`).checked).toBe(true);
				expect(searchControl<HTMLInputElement>(restored, 'cm-search-target-cluster', `[data-connection-id="${otherConnectionId}"]`).indeterminate).toBe(true);
				if (action === 'clear') {
					await clickSearchTarget(restored, 'cluster', connectionId);
					await clickSearchTarget(restored, 'database', otherConnectionId, 'ArchiveDb');
				} else {
					await clickSearchTarget(restored, 'expand', connectionId);
					await clickSearchTarget(restored, 'database', connectionId, database);
				}
				expect(listItemNames(restored)).toEqual(['Orders', 'ArchiveOrders']);
				expect(savedSearchMessages()).toEqual([]);
				const nextTargets = action === 'clear' ? [] : [
					{ connectionId: otherConnectionId, database: 'ArchiveDb' }, { connectionId, database: secondDatabase },
				];
				clickButtonByTestId(restored, 'cm-search-target-apply');
				expect(savedSearchMessages()).toHaveLength(1);
				expect(savedSearchMessages()[0].state).toMatchObject({ kind, query: 'orders', scope: 'selected', targets: nextTargets, categories: saved.state.categories, contentToggles: saved.state.contentToggles, lastResults: [] });
				await restored.updateComplete;
				expect(listItemNames(restored)).toEqual([]);
				sendSnapshot(restored, searchSnapshot(kind, { revision: 3, searchState: JSON.parse(serializedState) }));
				await restored.updateComplete;
				expect(listItemNames(restored)).toEqual([]);
				expect(el.isConnected).toBe(false);
				expect(JSON.stringify(saved.state)).toBe(serializedState);
				if (action === 'clear') {
					expect(searchTargetLabels(restored)).toEqual([]);
					for (const testId of ['cm-search-input', 'cm-search-categories', 'cm-search-results']) {
						expect(restored.shadowRoot!.querySelector(`[data-testid="${testId}"]`)).toBeNull();
					}
					await vi.advanceTimersByTimeAsync(500);
					expect(searchRequests()).toEqual([]);
				} else {
					expect(searchTargetLabels(restored)).toEqual([`${otherConnectionName} / ArchiveDb`, `${connectionName} / ${secondDatabase}`]);
					expect(restored.shadowRoot!.querySelector(`[data-testid="cm-search-category"][data-category="${connectionCategory}"]`)).toBeNull();
					expect(searchControl(restored, 'cm-search-category', '[data-category="tableColumns"]').getAttribute('aria-pressed')).toBe('true');
					await vi.advanceTimersByTimeAsync(300);
					expect(searchRequests()).toHaveLength(1);
					const nextRequest = searchRequests()[0];
					expect(nextRequest).toMatchObject({ kind, query: 'orders', scope: 'selected', targets: nextTargets, categories: { [connectionCategory]: false }, contentToggles: { tables: true } });
					window.dispatchEvent(new MessageEvent('message', { data: {
						type: 'searchResults', requestId: nextRequest.requestId,
						results: [searchResult({ kind, connectionId, connectionName, database: secondDatabase, name: 'ChangedOrders' })],
						completed: true, kustoSearchOwnerToken: 'changed-owner',
					} }));
					await restored.updateComplete;
					expect(listItemNames(restored)).toEqual(['ChangedOrders']);
					expect(savedSearchMessages().at(-1)?.state.targets).toEqual(nextTargets);
				}
			});

			it('removes restored mixed tags by exact database owner, toggles after reopen, and clears the last target with keyboard focus', async () => {
				const thirdConnectionId = kind === 'sql' ? 'sql3' : 'c3';
				const thirdConnectionName = kind === 'sql' ? 'ThirdSqlServer' : 'ThirdCluster';
				const sharedDatabase = 'SharedDb';
				const setup = {
					[kind === 'sql' ? 'sqlConnections' : 'connections']: kind === 'sql'
						? [sqlConnection(), sqlConnection(otherConnectionId, otherConnectionName, 'other.database.windows.net'), sqlConnection(thirdConnectionId, thirdConnectionName, 'third.database.windows.net')]
						: [kustoConnection(), kustoConnection(otherConnectionId, otherConnectionName, 'https://other.kusto.windows.net'), kustoConnection(thirdConnectionId, thirdConnectionName, 'https://third.kusto.windows.net')],
					[kind === 'sql' ? 'sqlCachedDatabases' : 'cachedDatabases']: { [connectionId]: [database, secondDatabase], [otherConnectionId]: [sharedDatabase], [thirdConnectionId]: [sharedDatabase] },
				};
				const el = await openSearch(kind, { ...setup, revision: 1 });
				clickButtonByTestId(el, 'cm-search-target-picker');
				await el.updateComplete;
				await clickSearchTarget(el, 'cluster', connectionId);
				for (const ownerId of [otherConnectionId, thirdConnectionId]) {
					await clickSearchTarget(el, 'expand', ownerId);
					await clickSearchTarget(el, 'database', ownerId, sharedDatabase);
				}
				clickButtonByTestId(el, 'cm-search-target-apply');
				await el.updateComplete;
				searchControl<HTMLButtonElement>(el, 'cm-search-category', '[data-category="tables"]').click();
				searchControl<HTMLButtonElement>(el, 'cm-search-category', '[data-category="tableColumns"]').click();
				await typeSearchInput(el, 'cm-search-input', 'orders');
				await vi.advanceTimersByTimeAsync(300);
				const originalRequest = searchRequests().at(-1)!;
				const results = [
					searchResult({ kind, connectionId: otherConnectionId, connectionName: otherConnectionName, database: sharedDatabase, category: 'column', name: 'OrderId', parentName: 'Orders' }),
					searchResult({ kind, connectionId: thirdConnectionId, connectionName: thirdConnectionName, database: sharedDatabase, category: 'column', name: 'OrderId', parentName: 'Orders' }),
				];
				sendSearchResults(originalRequest.requestId, results, true);
				await el.updateComplete;
				const saved = savedSearchMessages().at(-1)!;
				const serialized = JSON.stringify(saved.state);
				render(nothing, container);
				const restored = await openSearch(kind, { ...setup, revision: 2, searchState: JSON.parse(serialized) });
				expect(restored).not.toBe(el);
				const labels = [`${connectionName} (all databases)`, `${otherConnectionName} / ${sharedDatabase}`, `${thirdConnectionName} / ${sharedDatabase}`];
				expect(searchTargetLabels(restored)).toEqual(labels);
				expect(searchControl<HTMLInputElement>(restored, 'cm-search-input').value).toBe('orders');
				expect(searchControl(restored, 'cm-search-category', '[data-category="tables"]').getAttribute('aria-pressed')).toBe('false');
				expect(searchControl(restored, 'cm-search-category', '[data-category="tableColumns"]').getAttribute('aria-pressed')).toBe('true');
				expect(listItemNames(restored)).toEqual(['OrderId', 'OrderId']);
				postedMessages = [];
				for (const dismissal of ['cancel', 'Escape']) {
					clickButtonByTestId(restored, 'cm-search-target-picker');
					await restored.updateComplete;
					expect(searchControl<HTMLInputElement>(restored, 'cm-search-target-cluster', `[data-connection-id="${connectionId}"]`).checked).toBe(true);
					for (const ownerId of [otherConnectionId, thirdConnectionId]) {
						expect(searchControl<HTMLInputElement>(restored, 'cm-search-target-cluster', `[data-connection-id="${ownerId}"]`).indeterminate).toBe(true);
						expect(searchControl<HTMLInputElement>(restored, 'cm-search-target-database', `[data-connection-id="${ownerId}"][data-database="${sharedDatabase}"]`).checked).toBe(true);
					}
					await clickSearchTarget(restored, 'cluster', connectionId);
					if (dismissal === 'cancel') clickButtonByTestId(restored, 'cm-search-target-cancel');
					else searchControl(restored, 'cm-search-target-filter').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true }));
					await restored.updateComplete;
					expect(searchTargetLabels(restored)).toEqual(labels);
					expect(listItemNames(restored)).toEqual(['OrderId', 'OrderId']);
					expect(restored.shadowRoot!.activeElement).toBe(searchControl(restored, 'cm-search-target-picker'));
					expect(savedSearchMessages()).toEqual([]);
					expect(searchRequests()).toEqual([]);
				}

				const wholeRemove = searchControl<HTMLButtonElement>(restored, 'cm-search-target-remove', `[data-connection-id="${connectionId}"][data-database=""]`);
				wholeRemove.focus();
				wholeRemove.click();
				const databaseTargets = [{ connectionId: otherConnectionId, database: sharedDatabase }, { connectionId: thirdConnectionId, database: sharedDatabase }];
				expect(savedSearchMessages()).toHaveLength(1);
				expect(savedSearchMessages()[0].state).toMatchObject({ kind, scope: 'selected', targets: databaseTargets, query: 'orders', categories: { [connectionCategory]: true, tables: false }, contentToggles: { tables: true }, lastResults: [] });
				await restored.updateComplete;
				expect(searchTargetLabels(restored)).toEqual(labels.slice(1));
				expect(restored.shadowRoot!.querySelector(`[data-testid="cm-search-category"][data-category="${connectionCategory}"]`)).toBeNull();
				expect(restored.shadowRoot!.querySelector('[data-testid="cm-search-target-dialog"]')).toBeNull();
				expect(restored.shadowRoot!.activeElement).toBe(searchControl(restored, 'cm-search-target-remove', `[data-connection-id="${otherConnectionId}"]`));
				expect(listItemNames(restored)).toEqual([]);
				searchControl<HTMLButtonElement>(restored, 'cm-search-category', '[data-category="tables"]').click();
				await restored.updateComplete;
				const retargeted = searchRequests().at(-1)!;
				expect(retargeted).toMatchObject({ kind, query: 'orders', scope: 'selected', targets: databaseTargets, categories: { [connectionCategory]: false, tables: true }, contentToggles: { tables: true } });
				sendSearchResults(originalRequest.requestId, results, true);
				await restored.updateComplete;
				expect(listItemNames(restored)).toEqual([]);
				sendSearchResults(retargeted.requestId, results);
				await vi.advanceTimersByTimeAsync(500);
				await restored.updateComplete;
				expect(searchRequests()).toHaveLength(1);
				expect(listItemNames(restored)).toEqual(['OrderId', 'OrderId']);
				expect(savedSearchMessages().at(-1)?.state).toMatchObject({ targets: databaseTargets, categories: { tables: true }, contentToggles: { tables: true } });

				searchControl<HTMLButtonElement>(restored, 'cm-search-target-remove', `[data-connection-id="${thirdConnectionId}"][data-database="${sharedDatabase}"]`).click();
				expect(postedMessages).toContainEqual({ type: 'search.cancel', requestId: retargeted.requestId });
				expect(savedSearchMessages().at(-1)?.state.targets).toEqual([databaseTargets[0]]);
				await restored.updateComplete;
				expect(searchTargetLabels(restored)).toEqual([labels[1]]);
				expect(restored.shadowRoot!.activeElement).toBe(searchControl(restored, 'cm-search-target-picker'));
				expect(restored.shadowRoot!.querySelector('[data-testid="cm-search-target-dialog"]')).toBeNull();
				await vi.advanceTimersByTimeAsync(300);
				const remainingRequest = searchRequests().at(-1)!;
				expect(remainingRequest).toMatchObject({ kind, query: 'orders', scope: 'selected', targets: [databaseTargets[0]], categories: { [connectionCategory]: false, tables: true }, contentToggles: { tables: true } });
				sendSearchResults(retargeted.requestId, results, true);
				await restored.updateComplete;
				expect(listItemNames(restored)).toEqual([]);
				sendSearchResults(remainingRequest.requestId, results);
				await restored.updateComplete;
				expect(listItemNames(restored)).toEqual(['OrderId']);
				expect(searchControl(restored, 'cm-search-results').textContent).toContain(otherConnectionName);
				expect(searchControl(restored, 'cm-search-results').textContent).not.toContain(thirdConnectionName);

				postedMessages = [];
				searchControl<HTMLButtonElement>(restored, 'cm-search-target-remove', `[data-connection-id="${otherConnectionId}"][data-database="${sharedDatabase}"]`).click();
				expect(messageTypes()).toEqual(['search.cancel', 'search.saveState']);
				expect(postedMessages[0]).toEqual({ type: 'search.cancel', requestId: remainingRequest.requestId });
				expect(savedSearchMessages()[0].state).toMatchObject({ kind, query: 'orders', scope: 'selected', targets: [], categories: { tables: true }, contentToggles: { tables: true }, lastResults: [] });
				await restored.updateComplete;
				expect(searchTargetLabels(restored)).toEqual([]);
				expect(restored.shadowRoot!.activeElement).toBe(searchControl(restored, 'cm-search-target-picker'));
				for (const testId of ['cm-search-input', 'cm-search-categories', 'cm-search-results', 'cm-search-target-dialog']) {
					expect(restored.shadowRoot!.querySelector(`[data-testid="${testId}"]`)).toBeNull();
				}
				sendSearchResults(remainingRequest.requestId, results, true);
				await vi.advanceTimersByTimeAsync(500);
				expect(searchRequests()).toEqual([]);
				expect(savedSearchMessages()).toHaveLength(1);
				expect(JSON.stringify(saved.state)).toBe(serialized);
			});

			it('keeps protected tag labels redacted and removable without opening the picker or discovering databases', async () => {
				const el = await openSearch(kind, {
					...(kind === 'sql' ? { sqlLeaveNoTrace: [connectionId] } : { leaveNoTraceClusters: [kustoConnection().clusterUrl] }),
					searchState: { kind, scope: 'selected', query: '', targets: [{ connectionId, database: 'HiddenDb' }] },
				});
				const label = `${connectionName} (Leave No Trace)`;
				expect(searchTargetLabels(el)).toEqual([label]);
				expect(searchControl(el, 'cm-search-target-tag').title).toBe(label);
				expect(searchControl(el, 'cm-search-target-remove').title).toBe(`Remove ${label}`);
				expect(searchControl(el, 'cm-search-targets').textContent).not.toContain('HiddenDb');
				postedMessages = [];
				clickButtonByTestId(el, 'cm-search-target-remove');
				await el.updateComplete;
				expect(searchTargetLabels(el)).toEqual([]);
				expect(el.shadowRoot!.querySelector('[data-testid="cm-search-target-dialog"]')).toBeNull();
				expect(messageTypes()).toEqual(['search.saveState']);
				expect(savedSearchMessages()[0].state.targets).toEqual([]);
			});

			it('disables protected checkboxes and expansion without exposing cached databases or starting discovery', async () => {
				const el = await openSearch(kind, kind === 'sql'
					? { sqlLeaveNoTrace: [connectionId], sqlCachedDatabases: { [connectionId]: ['HiddenDb'] } }
					: { leaveNoTraceClusters: [kustoConnection().clusterUrl], cachedDatabases: { [connectionId]: ['HiddenDb'] } });
				postedMessages = [];
				clickButtonByTestId(el, 'cm-search-target-picker');
				await el.updateComplete;
				const checkbox = searchControl<HTMLInputElement>(el, 'cm-search-target-cluster', `[data-connection-id="${connectionId}"]`);
				const expand = searchControl<HTMLButtonElement>(el, 'cm-search-target-expand', `[data-connection-id="${connectionId}"]`);
				expect(checkbox.disabled).toBe(true);
				expect(expand.disabled).toBe(true);
				checkbox.click();
				expand.click();
				await el.updateComplete;
				expect(checkbox.checked).toBe(false);
				expect(expand.getAttribute('aria-expanded')).toBe('false');
				expect(searchControl(el, 'cm-search-target-dialog').textContent).toContain('Leave No Trace');
				expect(searchControl(el, 'cm-search-target-dialog').textContent).not.toContain('HiddenDb');
				expect(el.shadowRoot!.querySelector(`[data-testid="cm-search-target-database"][data-connection-id="${connectionId}"]`)).toBeNull();
				clickButtonByTestId(el, 'cm-search-target-apply');
				await el.updateComplete;
				expect(el.shadowRoot!.querySelector('[data-testid="cm-search-input"]')).toBeNull();
				expect(postedMessages).toEqual([]);
			});
		});

		it('keeps source CSS wrapping tags, truncating labels and fixing control sizes without changing compact search scrolling', () => {
			const rule = (selector: string) => connectionManagerStyles.cssText.match(new RegExp(`\\.${selector}\\s*\\{([^}]+)\\}`))?.[1] ?? '';
			const targets = rule('search-targets');
			expect(targets).toContain('flex-wrap: wrap;');
			expect(targets).toContain('min-width: 0;');
			expect(targets).toContain('max-width: 100%;');
			expect(targets).not.toMatch(/(?:border|background|box-shadow):/);
			expect(rule('search-target-tag')).toContain('max-width: 100%;');
			for (const property of ['min-width: 0;', 'overflow: hidden;', 'text-overflow: ellipsis;', 'white-space: nowrap;']) {
				expect(rule('search-target-label')).toContain(property);
			}
			for (const [selector, size] of [['search-target-picker', '28px'], ['search-target-remove', '22px']]) {
				for (const property of [`flex: 0 0 ${size};`, `width: ${size};`, `height: ${size};`]) expect(rule(selector)).toContain(property);
			}
			for (const selector of ['search-container', 'search-results', 'explorer-panel\\.search-active']) {
				expect(rule(selector)).toContain('flex: 0 1 auto;');
				expect(rule(selector)).toContain('min-height: 0;');
			}
			expect(rule('search-container')).toContain('overflow: visible;');
		});

		it('preserves edited Kusto preferences and clears SQL rows when SQL becomes unavailable', async () => {
			vi.useFakeTimers();
			try {
				const el = await openSearch('kusto', { revision: 1 });
				clickButtonByTestId(el, 'cm-search-target-picker');
				await el.updateComplete;
				await clickSearchTarget(el, 'expand', 'c1');
				await clickSearchTarget(el, 'database', 'c1', 'db1');
				clickButtonByTestId(el, 'cm-search-target-apply');
				await el.updateComplete;
				searchControl<HTMLButtonElement>(el, 'cm-search-category', '[data-category="tableColumns"]').click();
				await typeSearchInput(el, 'cm-search-input', 'kusto-orders');
				await vi.advanceTimersByTimeAsync(300);
				const kustoRequest = searchRequests().at(-1)!;
				window.dispatchEvent(new MessageEvent('message', { data: {
					type: 'searchResults', requestId: kustoRequest.requestId, results: [searchResult()], completed: true, kustoSearchOwnerToken: 'kusto-owner',
				} }));
				await el.updateComplete;
				const kustoState = savedSearchMessages().at(-1)!.state;
				expect(listItemNames(el)).toEqual(['Orders']);
				await selectSearchKind(el, 'sql');
				expect(postedMessages).toContainEqual({ type: 'setActiveKind', kind: 'sql' });
				expect(el.shadowRoot!.querySelector('[data-testid="cm-search-input"]')).toBeNull();
				expect(listItemNames(el)).toEqual([]);
				clickButtonByTestId(el, 'cm-search-target-picker');
				await el.updateComplete;
				await clickSearchTarget(el, 'cluster', 'sql1');
				clickButtonByTestId(el, 'cm-search-target-apply');
				await el.updateComplete;
				expect(searchControl(el, 'cm-search-category', '[data-category="tableColumns"]').getAttribute('aria-pressed')).toBe('false');
				await typeSearchInput(el, 'cm-search-input', 'private-sql');
				await vi.advanceTimersByTimeAsync(300);
				const sqlRequest = searchRequests().at(-1)!;
				const sqlResult = searchResult({ kind: 'sql', connectionId: 'sql1', connectionName: 'MySqlServer', database: 'sqldb1', name: 'PrivateSqlOrders' });
				window.dispatchEvent(new MessageEvent('message', { data: { type: 'searchResults', requestId: sqlRequest.requestId, results: [sqlResult], completed: false } }));
				await el.updateComplete;
				expect(listItemNames(el)).toEqual(['PrivateSqlOrders']);
				await vi.advanceTimersByTimeAsync(200);
				const sqlState = savedSearchMessages().at(-1)!.state;
				expect(sqlState).toMatchObject({ kind: 'sql', query: 'private-sql', targets: [{ connectionId: 'sql1' }], lastResults: [sqlResult] });

				sendSnapshot(el, searchSnapshot('sql', { revision: 2, sqlAvailable: false, sqlConnections: [], sqlCachedDatabases: {}, searchState: sqlState }));
				await el.updateComplete;
				expect(postedMessages).toContainEqual({ type: 'search.cancel', requestId: sqlRequest.requestId });
				expect(searchControl(el, 'cm-explorer-panel').getAttribute('data-test-kind')).toBe('kusto');
				expect(searchControl<HTMLSelectElement>(el, 'cm-search-scope').value).toBe(kustoState.scope);
				expect(searchControl<HTMLInputElement>(el, 'cm-search-input').value).toBe(kustoState.query);
				expect(searchTargetLabels(el)).toEqual(['MyCluster / db1']);
				expect(searchControl(el, 'cm-search-category', '[data-category="tableColumns"]').getAttribute('aria-pressed')).toBe('true');
				expect(listItemNames(el)).toEqual([]);
				expect(el.shadowRoot!.textContent).not.toContain('PrivateSqlOrders');
				window.dispatchEvent(new MessageEvent('message', { data: { type: 'searchResults', requestId: sqlRequest.requestId, results: [sqlResult], completed: true } }));
				await el.updateComplete;
				expect(listItemNames(el)).toEqual([]);
				clickButtonByTestId(el, 'cm-search-target-picker');
				await el.updateComplete;
				expect(searchControl<HTMLInputElement>(el, 'cm-search-target-database', '[data-connection-id="c1"][data-database="db1"]').checked).toBe(true);
				expect(el.shadowRoot!.querySelector('[data-testid="cm-search-target-cluster"][data-connection-id="sql1"]')).toBeNull();
				clickButtonByTestId(el, 'cm-search-target-cancel');
				await el.updateComplete;
			} finally {
				render(nothing, container);
				vi.useRealTimers();
			}
		});

		it('preserves active SQL search results when picker discovery refreshes metadata and the draft is cancelled', async () => {
			vi.useFakeTimers();
			try {
				const el = await openSearch('sql', { revision: 1, sqlCachedDatabases: { sql1: ['sqldb1'] } });
				clickButtonByTestId(el, 'cm-search-target-picker');
				await el.updateComplete;
				await clickSearchTarget(el, 'cluster', 'sql1');
				clickButtonByTestId(el, 'cm-search-target-apply');
				await el.updateComplete;
				await typeSearchInput(el, 'cm-search-input', 'Orders');
				await vi.advanceTimersByTimeAsync(500);
				const request = searchRequests().at(-1)!;
				const result = searchResult({ kind: 'sql', connectionId: 'sql1', database: 'sqldb1' });
				window.dispatchEvent(new MessageEvent('message', { data: { type: 'searchResults', requestId: request.requestId, results: [result], completed: false } }));
				await el.updateComplete;
				const savedState = savedSearchMessages().at(-1)!.state;
				postedMessages = [];
				clickButtonByTestId(el, 'cm-search-target-picker');
				await el.updateComplete;
				await clickSearchTarget(el, 'expand', 'sql2');
				expect(postedMessages).toContainEqual({ type: 'sql.cluster.expand', connectionId: 'sql2' });
				sendSnapshot(el, searchSnapshot('sql', { revision: 2, searchState: savedState }));
				await el.updateComplete;
				clickButtonByTestId(el, 'cm-search-target-cancel');
				await el.updateComplete;
				expect(listItemNames(el)).toEqual(['Orders']);
				expect(el.shadowRoot!.querySelector('.search-input-spinner')).not.toBeNull();
				expect(messageTypes()).not.toContain('search.cancel');
				expect(messageTypes()).not.toContain('search.saveState');
				window.dispatchEvent(new MessageEvent('message', { data: { type: 'searchResults', requestId: request.requestId, results: [{ ...result, name: 'Orders2' }], completed: true } }));
				await el.updateComplete;
				expect(listItemNames(el)).toEqual(['Orders', 'Orders2']);
			} finally {
				render(nothing, container);
				vi.useRealTimers();
			}
		});

		it.each(searchKinds)('$kind: exposes Cancel for a category-triggered scoped search and ignores its late result', async ({ kind, connectionId, database }) => {
			vi.useFakeTimers();
			try {
				const el = await openSearch(kind);
				clickButtonByTestId(el, 'cm-search-target-picker');
				await el.updateComplete;
				await clickSearchTarget(el, 'cluster', connectionId);
				clickButtonByTestId(el, 'cm-search-target-apply');
				await el.updateComplete;
				await typeSearchInput(el, 'cm-search-input', 'Orders');
				await vi.advanceTimersByTimeAsync(500);
				const firstRequest = searchRequests().at(-1)!;
				const result = searchResult({ kind, connectionId, database });
				window.dispatchEvent(new MessageEvent('message', { data: { type: 'searchResults', requestId: firstRequest.requestId, results: [result], completed: true, kustoSearchOwnerToken: 'owner-token' } }));
				await el.updateComplete;
				expect(listItemNames(el)).toEqual(['Orders']);
				expect(el.shadowRoot!.querySelector('.search-progress-dismiss')).toBeNull();
				searchControl<HTMLButtonElement>(el, 'cm-search-category', '[data-category="tableColumns"]').click();
				await el.updateComplete;
				const nextRequest = searchRequests().at(-1)!;
				expect(nextRequest.requestId).not.toBe(firstRequest.requestId);
				expect(nextRequest).toMatchObject({ scope: 'selected', targets: [{ connectionId }], contentToggles: { tables: true } });
				const cancel = el.shadowRoot!.querySelector<HTMLButtonElement>('.search-progress-dismiss');
				expect(cancel).not.toBeNull();
				cancel!.click();
				await el.updateComplete;
				expect(postedMessages).toContainEqual({ type: 'search.cancel', requestId: nextRequest.requestId });
				window.dispatchEvent(new MessageEvent('message', { data: { type: 'searchResults', requestId: nextRequest.requestId, results: [{ ...result, name: 'LateOrders' }], completed: true, kustoSearchOwnerToken: 'owner-token' } }));
				await vi.advanceTimersByTimeAsync(500);
				await el.updateComplete;
				expect(listItemNames(el)).toEqual([]);
				expect(searchRequests()).toHaveLength(2);
				expect(el.shadowRoot!.querySelector('.search-input-spinner')).toBeNull();
			} finally {
				render(nothing, container);
				vi.useRealTimers();
			}
		});

		it.each(searchKinds)('$kind: cancels the search target draft on Escape and returns focus to the picker', async ({ kind, connectionId }) => {
			const el = await openSearch(kind);

			const picker = el.shadowRoot!.querySelector<HTMLButtonElement>('[data-testid="cm-search-target-picker"]')!;
			picker.focus();
			picker.click();
			await el.updateComplete;
			const dialog = el.shadowRoot!.querySelector<HTMLDialogElement>('[data-testid="cm-search-target-dialog"]')!;
			const filter = dialog.querySelector<HTMLInputElement>('[data-testid="cm-search-target-filter"]')!;
			expect(dialog.open).toBe(true);
			expect(el.shadowRoot!.activeElement).toBe(filter);
			const checkbox = dialog.querySelector<HTMLInputElement>(`[data-testid="cm-search-target-cluster"][data-connection-id="${connectionId}"]`)!;
			checkbox.click();
			await el.updateComplete;
			expect(checkbox.checked).toBe(true);
			postedMessages = [];

			filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true }));
			await el.updateComplete;

			expect(el.shadowRoot!.querySelector('[data-testid="cm-search-target-dialog"]')).toBeNull();
			expect(el.shadowRoot!.activeElement).toBe(picker);
			expect(el.shadowRoot!.querySelector('[data-testid="cm-search-input"]')).toBeNull();
			expect(messageTypes()).not.toContain('search.saveState');
			picker.click();
			await el.updateComplete;
			expect(el.shadowRoot!.querySelector<HTMLInputElement>(`[data-testid="cm-search-target-cluster"][data-connection-id="${connectionId}"]`)!.checked).toBe(false);
		});

		it('acknowledges staged search results only after the live request applies', async () => {
			vi.useFakeTimers();
			try {
				const el = createElement();
				sendSnapshot(el, snapshot());
				await el.updateComplete;
				clickButtonByTestId(el, 'cm-filter-search');
				await el.updateComplete;
				await selectSearchScope(el, 'cached');
				const input = el.shadowRoot!.querySelector('[data-testid="cm-search-input"]') as HTMLInputElement;
				input.value = 'orders';
				input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
				await vi.advanceTimersByTimeAsync(300);
				const requestId = String((postedMessages.find(message => (message as any)?.type === 'search') as any)?.requestId || '');

				for (const [publicationId, resultRequestId, expected] of [
					['live-publication', requestId, true],
					['stale-publication', 'stale-request', false],
				] as const) {
					window.dispatchEvent(new MessageEvent('message', { data: {
						type: 'kustoPublicationStage', publicationId, publicationDeadline: Date.now() + 1_000,
						payload: {
							type: 'searchResults', requestId: resultRequestId, results: [searchResult()], completed: false,
							kustoSearchOwnerToken: 'owner-token',
						},
					} }));
					window.dispatchEvent(new MessageEvent('message', { data: { type: 'kustoPublicationCommit', publicationId } }));
					expect(postedMessages).toContainEqual({ type: 'kustoPublicationAck', publicationId, phase: 'applied', accepted: expected });
				}
				await el.updateComplete;
				expect(listItemNames(el)).toContain('Orders');
			} finally {
				vi.useRealTimers();
			}
		});

		it('Kusto: preserves completed search results when returning to the tab with a stale snapshot', async () => {
			vi.useFakeTimers();
			try {
				const el = createElement();
				sendSnapshot(el, snapshot());
				await el.updateComplete;

				clickButtonByTestId(el, 'cm-filter-search');
				await el.updateComplete;
				await selectSearchScope(el, 'cached');

				const input = el.shadowRoot!.querySelector('[data-testid="cm-search-input"]') as HTMLInputElement | null;
				expect(input).not.toBeNull();
				input!.value = 'orders';
				input!.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
				await el.updateComplete;
				await vi.advanceTimersByTimeAsync(300);
				await el.updateComplete;

				const searchMessage = postedMessages.find((message): message is {
					type: 'search';
					requestId: string;
					query: string;
					categories: SearchState['categories'];
					contentToggles: SearchState['contentToggles'];
				} => Boolean(message && typeof message === 'object' && (message as { type?: unknown }).type === 'search'));
				expect(searchMessage).toEqual(expect.objectContaining({ query: 'orders', scope: 'cached', kind: 'kusto' }));

				const completedResult = searchResult();
				window.dispatchEvent(new MessageEvent('message', {
					data: {
						type: 'searchResults', requestId: searchMessage!.requestId, results: [completedResult], completed: true,
						kustoSearchOwnerToken: 'owner-token',
					},
				}));
				await el.updateComplete;
				expect(listItemNames(el)).toContain('Orders');

				sendSnapshot(el, snapshot({
					searchState: {
						query: 'orders',
						scope: 'cached',
						categories: searchMessage!.categories,
						contentToggles: searchMessage!.contentToggles,
						lastResults: [],
						lastSearchTimestamp: Date.now(),
					} satisfies SearchState,
				}));
				await el.updateComplete;

				expect(listItemNames(el)).toContain('Orders');
				expect(el.shadowRoot!.textContent).not.toContain('No results');
			} finally {
				vi.useRealTimers();
			}
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

		it('Kusto: schema loading state has no duplicate inline spinner', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;

			clickListItemByName(el, 'MyCluster');
			await el.updateComplete;
			clickListItemByName(el, 'db1');
			await el.updateComplete;

			const loading = el.shadowRoot!.querySelector('.loading-state');
			expect(loading?.textContent).toContain('Loading schema...');
			expect(hasSpinner(loading)).toBe(false);
		});

		it('Kusto: database-level refresh shows spinner while schema refresh is in flight', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;

			clickListItemByName(el, 'MyCluster');
			await el.updateComplete;
			clickListItemByName(el, 'db1');
			await el.updateComplete;

			let refreshBtn = el.shadowRoot!.querySelector('.breadcrumb-refresh') as HTMLButtonElement | null;
			expect(hasSpinner(refreshBtn)).toBe(false);

			window.dispatchEvent(new MessageEvent('message', { data: { type: 'schemaRefreshStarted', connectionId: 'c1', clusterUrl: 'https://mycluster.kusto.windows.net', database: 'db1' } }));
			await el.updateComplete;
			refreshBtn = el.shadowRoot!.querySelector('.breadcrumb-refresh') as HTMLButtonElement | null;
			expect(hasSpinner(refreshBtn)).toBe(true);

			window.dispatchEvent(new MessageEvent('message', { data: { type: 'schemaRefreshCompleted', connectionId: 'c1', clusterUrl: 'https://mycluster.kusto.windows.net', database: 'db1', success: true } }));
			await el.updateComplete;
			refreshBtn = el.shadowRoot!.querySelector('.breadcrumb-refresh') as HTMLButtonElement | null;
			expect(hasSpinner(refreshBtn)).toBe(false);
		});
	});

	// ── Preview refresh ───────────────────────────────────────────────────────

	describe('load error states', () => {
		it('Kusto: drilled cluster with no cached databases shows an empty state, not a blank panel', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({ cachedDatabases: { c1: [] } }));
			await el.updateComplete;

			clickListItemByName(el, 'MyCluster');
			await el.updateComplete;

			const emptyState = el.shadowRoot!.querySelector('[data-testid="cm-database-empty-state"]') as HTMLElement | null;
			expect(emptyState).not.toBeNull();
			expect(emptyState?.textContent).toContain('No databases found');
			expect(emptyState?.textContent).toContain('Refresh');
			expect(el.shadowRoot!.querySelector('[data-testid="cm-database-load-error"]')).toBeNull();
			expect(el.shadowRoot!.textContent).not.toContain('Loading databases');

			postedMessages = [];
			(emptyState!.querySelector('button') as HTMLButtonElement).click();
			expect(postedMessages).toContainEqual(expect.objectContaining({ type: 'cluster.refreshDatabases', connectionId: 'c1' }));
		});

		it('Kusto: database load failure shows retry instead of a misleading empty state', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({ cachedDatabases: {} }));
			await el.updateComplete;

			clickListItemByName(el, 'MyCluster');
			await el.updateComplete;
			window.dispatchEvent(new MessageEvent('message', { data: { type: 'databasesLoadError', connectionId: 'c1', error: 'Auth expired' } }));
			await el.updateComplete;

			const errorState = el.shadowRoot!.querySelector('[data-testid="cm-database-load-error"]') as HTMLElement | null;
			expect(errorState?.textContent).toContain('Could not load databases');
			expect(errorState?.textContent).toContain('Auth expired');

			postedMessages = [];
			(errorState!.querySelector('button') as HTMLButtonElement).click();
			expect(postedMessages).toContainEqual(expect.objectContaining({ type: 'cluster.refreshDatabases', connectionId: 'c1' }));
		});

		it('Kusto: schema load failure shows retry instead of loading forever', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({ cachedDatabases: { c1: ['db1'] } }));
			await el.updateComplete;

			clickListItemByName(el, 'MyCluster');
			await el.updateComplete;
			clickListItemByName(el, 'db1');
			await el.updateComplete;
			window.dispatchEvent(new MessageEvent('message', { data: { type: 'schemaLoadError', connectionId: 'c1', database: 'db1', error: 'Schema unavailable' } }));
			await el.updateComplete;

			const errorState = el.shadowRoot!.querySelector('[data-testid="cm-schema-load-error"]') as HTMLElement | null;
			expect(errorState?.textContent).toContain('Could not load schema');
			expect(errorState?.textContent).toContain('Schema unavailable');

			postedMessages = [];
			(errorState!.querySelector('button') as HTMLButtonElement).click();
			expect(postedMessages).toContainEqual(expect.objectContaining({ type: 'database.getSchema', connectionId: 'c1', database: 'db1' }));
		});

		it('SQL: database load failure shows retry instead of a misleading empty state', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({ activeKind: 'sql', connections: [], cachedDatabases: {}, sqlCachedDatabases: { sql1: [] } }));
			await el.updateComplete;

			clickListItemByName(el, 'MySqlServer');
			await el.updateComplete;
			window.dispatchEvent(new MessageEvent('message', { data: { type: 'sql.databasesLoadError', connectionId: 'sql1', error: 'Login failed' } }));
			await el.updateComplete;

			const dbError = el.shadowRoot!.querySelector('[data-testid="cm-sql-database-load-error"]') as HTMLElement | null;
			expect(dbError?.textContent).toContain('Could not load databases');
			expect(dbError?.textContent).toContain('Login failed');

			postedMessages = [];
			(dbError!.querySelector('button') as HTMLButtonElement).click();
			expect(postedMessages).toContainEqual(expect.objectContaining({ type: 'sql.cluster.refreshDatabases', connectionId: 'sql1' }));
		});

		it('SQL: schema load failure shows retry instead of loading forever', async () => {
			const el = createElement();

			sendSnapshot(el, snapshot({ activeKind: 'sql', connections: [], cachedDatabases: {}, sqlCachedDatabases: { sql1: ['sqldb1'] } }));
			await el.updateComplete;
			clickListItemByName(el, 'MySqlServer');
			await el.updateComplete;
			clickListItemByName(el, 'sqldb1');
			await el.updateComplete;
			window.dispatchEvent(new MessageEvent('message', { data: { type: 'sql.schemaLoadError', connectionId: 'sql1', database: 'sqldb1', error: 'Schema timeout' } }));
			await el.updateComplete;

			const schemaError = el.shadowRoot!.querySelector('[data-testid="cm-sql-schema-load-error"]') as HTMLElement | null;
			expect(schemaError?.textContent).toContain('Could not load schema');
			expect(schemaError?.textContent).toContain('Schema timeout');

			postedMessages = [];
			(schemaError!.querySelector('button') as HTMLButtonElement).click();
			expect(postedMessages).toContainEqual(expect.objectContaining({ type: 'sql.database.getSchema', connectionId: 'sql1', database: 'sqldb1' }));
		});
	});

	// ── Preview refresh ───────────────────────────────────────────────────────

	describe('preview refresh', () => {
		it('evicts protected Kusto schemas and previews without resurrecting them after unmarking', async () => {
			const el = createElement();
			const connection = { ...kustoConnection(), accountPartition: 'partition-a' };
			sendSnapshot(el, snapshot({ connections: [connection], leaveNoTraceClusters: [], searchState: {
				query: 'Secret', scope: 'cached', categories: {}, contentToggles: {},
				lastResults: [{ category: 'table', kind: 'kusto', connectionId: 'c1', connectionName: 'Cluster', database: 'db1', name: 'Secret' }],
				lastSearchTimestamp: Date.now(),
			} }));
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'loadingSchema', connectionId: 'c1', database: 'db1', requestId: 'schema-protected', accountPartition: 'partition-a',
			} }));
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'schemaLoaded', connectionId: 'c1', database: 'db1', requestId: 'schema-protected', accountPartition: 'partition-a',
				schema: { tables: ['Secret'], columnTypesByTable: { Secret: {} } },
			} }));
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'tablePreviewLoading', connectionId: 'c1', database: 'db1', tableName: 'Secret', requestId: 'preview-protected', accountPartition: 'partition-a',
			} }));
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'tablePreviewResult', connectionId: 'c1', database: 'db1', tableName: 'Secret', requestId: 'preview-protected', accountPartition: 'partition-a',
				success: true, columns: [{ name: 'value' }], rows: [['SECRET']], rowCount: 1,
			} }));
			expect((el as any)._databaseSchemas['c1|db1']).toBeDefined();
			expect((el as any)._tablePreviewData['c1|db1|table|Secret']).toBeDefined();

			sendSnapshot(el, snapshot({ connections: [connection], leaveNoTraceClusters: [connection.clusterUrl] }));
			expect((el as any)._databaseSchemas['c1|db1']).toBeUndefined();
			expect((el as any)._tablePreviewData['c1|db1|table|Secret']).toBeUndefined();
			expect((el as any)._search.results).toEqual([]);

			sendSnapshot(el, snapshot({ connections: [connection], leaveNoTraceClusters: [] }));
			expect((el as any)._databaseSchemas['c1|db1']).toBeUndefined();
			expect((el as any)._tablePreviewData['c1|db1|table|Secret']).toBeUndefined();
			expect((el as any)._search.results).toEqual([]);
		});

		it('evicts Kusto schema and preview state when the connection identity changes', async () => {
			const el = createElement();
			const identityA = kustoConnection();
			sendSnapshot(el, snapshot({
				connections: [{ ...identityA, authorityId: 'tenant-a', selectedAccountId: 'account', accountPartition: 'partition-a' }],
			}));
			await el.updateComplete;
			sendSchemaLoaded(el, 'c1', 'db1', { tables: ['SecretA'], columnTypesByTable: { SecretA: {} } });
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'tablePreviewResult', connectionId: 'c1', database: 'db1', tableName: 'SecretA',
				success: true, columns: [{ name: 'value' }], rows: [['from-a']], rowCount: 1,
			} }));
			expect((el as any)._databaseSchemas['c1|db1']).toBeDefined();
			expect((el as any)._tablePreviewData['c1|db1|table|SecretA']).toBeDefined();
			(el as any)._search.results = [{ category: 'table', kind: 'kusto', connectionId: 'c1', connectionName: 'Cluster', database: 'db1', name: 'SecretA' }];

			sendSnapshot(el, snapshot({
				connections: [{ ...identityA, authorityId: 'tenant-a', selectedAccountId: 'account', accountPartition: 'partition-b' }],
				searchState: {
					query: 'SecretA', scope: 'cached', categories: {}, contentToggles: {},
					lastResults: [{ category: 'table', kind: 'kusto', connectionId: 'c1', connectionName: 'Cluster', database: 'db1', name: 'SecretA' }],
					lastSearchTimestamp: Date.now(),
				},
			}));
			await el.updateComplete;

			expect((el as any)._databaseSchemas['c1|db1']).toBeUndefined();
			expect((el as any)._tablePreviewData['c1|db1|table|SecretA']).toBeUndefined();
			expect((el as any)._search.results).toEqual([]);

			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'schemaLoaded', connectionId: 'c1', database: 'db1', accountPartition: 'partition-a',
				schema: { tables: ['LateSecretA'], columnTypesByTable: { LateSecretA: {} } },
			} }));
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'tablePreviewResult', connectionId: 'c1', database: 'db1', tableName: 'LateSecretA', accountPartition: 'partition-a',
				success: true, columns: [{ name: 'value' }], rows: [['late-a']], rowCount: 1,
			} }));

			expect((el as any)._databaseSchemas['c1|db1']).toBeUndefined();
			expect((el as any)._tablePreviewData['c1|db1|table|LateSecretA']).toBeUndefined();
		});

		it('evicts retained Kusto metadata after same-account session recreation', async () => {
			const el = createElement();
			const connection = { ...kustoConnection(), selectedAccountId: 'account-a', accountPartition: 'partition-a' };
			sendSnapshot(el, snapshot({ connections: [{ ...connection, authSessionGeneration: 0 }] }));
			sendSchemaLoaded(el, 'c1', 'db1', { tables: ['OldSessionTable'], columnTypesByTable: { OldSessionTable: {} } });
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'tablePreviewResult', connectionId: 'c1', database: 'db1', tableName: 'OldSessionTable',
				success: true, columns: [{ name: 'value' }], rows: [['OLD_SESSION_ROW']], rowCount: 1,
			} }));
			(el as any)._search.results = [{
				category: 'table', kind: 'kusto', connectionId: 'c1', connectionName: 'Cluster',
				database: 'db1', name: 'OldSessionTable',
			}];

			sendSnapshot(el, snapshot({ connections: [{ ...connection, authSessionGeneration: 1 }] }));
			await el.updateComplete;

			expect((el as any)._databaseSchemas['c1|db1']).toBeUndefined();
			expect((el as any)._tablePreviewData['c1|db1|table|OldSessionTable']).toBeUndefined();
			expect((el as any)._search.results).toEqual([]);
		});

		it('ignores stale schema and preview terminal messages after a newer request starts', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({
				connections: [{ ...kustoConnection(), accountPartition: 'partition-b' }],
			}));
			await el.updateComplete;

			window.dispatchEvent(new MessageEvent('message', { data: { type: 'loadingSchema', connectionId: 'c1', database: 'db1', requestId: 'schema-b' } }));
			window.dispatchEvent(new MessageEvent('message', { data: { type: 'tablePreviewLoading', connectionId: 'c1', database: 'db1', tableName: 'Events', requestId: 'preview-b' } }));
			window.dispatchEvent(new MessageEvent('message', { data: { type: 'schemaLoadError', connectionId: 'c1', database: 'db1', requestId: 'schema-a', error: 'old error' } }));
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'tablePreviewResult', connectionId: 'c1', database: 'db1', tableName: 'Events', requestId: 'preview-a',
				success: true, rows: [['old']], columns: [{ name: 'value' }], rowCount: 1,
			} }));

			expect((el as any)._loadingSchemaKeys.has('c1|db1')).toBe(true);
			expect((el as any)._schemaLoadErrors['c1|db1']).toBe('');
			expect((el as any)._tablePreviewData['c1|db1|table|Events']).toEqual({ loading: true });
		});

		it('applies schemaLoaded owned by an in-flight refresh request', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({ connections: [{ ...kustoConnection(), accountPartition: 'partition-a' }] }));
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'schemaRefreshStarted', connectionId: 'c1', database: 'db1', requestId: 'refresh-1', accountPartition: 'partition-a',
			} }));
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'schemaLoaded', connectionId: 'c1', database: 'db1', requestId: 'refresh-1', accountPartition: 'partition-a',
				schema: { tables: ['RefreshedTable'], columnTypesByTable: { RefreshedTable: {} } },
			} }));

			expect((el as any)._databaseSchemas['c1|db1']).toEqual(expect.objectContaining({ tables: ['RefreshedTable'] }));
		});

		it('preserves an unresolved first-sign-in preview request through the establishing snapshot', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({ connections: [{ ...kustoConnection(), accountPartition: undefined }] }));
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'tablePreviewLoading', connectionId: 'c1', database: 'db1', tableName: 'Events', requestId: 'preview-first',
			} }));
			sendSnapshot(el, snapshot({ connections: [{ ...kustoConnection(), accountPartition: 'partition-first' }] }));
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'tablePreviewResult', connectionId: 'c1', database: 'db1', tableName: 'Events', requestId: 'preview-first', accountPartition: 'partition-first',
				success: true, columns: [{ name: 'value' }], rows: [['ready']], rowCount: 1,
			} }));

			expect((el as any)._tablePreviewData['c1|db1|table|Events']).toEqual(expect.objectContaining({ loading: false, rows: [['ready']] }));
		});

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

		it('Kusto: compact table previews expose the same complex preview control without changing row height', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;
			(el.shadowRoot!.querySelector('.explorer-list-item') as HTMLElement).click();
			await el.updateComplete;
			const dbRow = Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item'))
				.find(row => row.textContent?.includes('db1')) as HTMLElement | undefined;
			dbRow?.click();
			await el.updateComplete;
			sendSchemaLoaded(el, 'c1', 'db1', {
				tables: ['TestTable'], columnTypesByTable: { TestTable: { Details: 'dynamic' } },
			});
			await el.updateComplete;
			const tables = Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item'))
				.find(row => row.textContent?.includes('Tables')) as HTMLElement | undefined;
			tables?.click();
			await el.updateComplete;
			const tableRow = Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item'))
				.find(row => row.textContent?.includes('TestTable')) as HTMLElement | undefined;
			tableRow?.click();
			await el.updateComplete;

			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'tablePreviewResult', connectionId: 'c1', database: 'db1', tableName: 'TestTable',
				success: true, columns: [{ name: 'Details', type: 'dynamic' }],
				rows: [[{ display: '[object]', full: '{"requestId":"R-1"}', isObject: true }]], rowCount: 1,
			} }));
			await el.updateComplete;
			const table = el.shadowRoot!.querySelector('kw-data-table') as any;
			await table.updateComplete;
			expect(table.options.compact).toBe(true);
			expect(table.getEstimatedRowHeight()).toBe(21);
			table.shadowRoot.querySelector('[data-testid="complex-preview-toggle"]').click();
			await table.updateComplete;
			expect(table.shadowRoot.querySelector('[data-testid="complex-preview-controls"]')).toBeTruthy();
			expect(table.captureComplexPreviewState()).toEqual({ enabled: true, maxCharacters: 75 });
			expect(table.rows[0][0]).toEqual(expect.objectContaining({ isObject: true }));
			expect(table.getEstimatedRowHeight()).toBe(21);
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

		it('Kusto: function row refresh shows spinner while schema refresh is in flight', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot());
			await el.updateComplete;

			clickListItemByName(el, 'MyCluster');
			await el.updateComplete;
			clickListItemByName(el, 'db1');
			await el.updateComplete;

			sendSchemaLoaded(el, 'c1', 'db1', { tables: [], functions: [{ name: 'AgentHealth', folder: 'Agents' }] });
			await el.updateComplete;

			clickListItemByName(el, 'Functions');
			await el.updateComplete;
			clickListItemByName(el, 'Agents');
			await el.updateComplete;

			let functionRow = Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item'))
				.find(row => row.querySelector('.explorer-list-item-name')?.textContent?.trim() === 'AgentHealth');
			let refreshBtn = functionRow?.querySelector('.explorer-list-item-actions .btn-icon');
			expect(hasSpinner(refreshBtn)).toBe(false);

			window.dispatchEvent(new MessageEvent('message', { data: { type: 'schemaRefreshStarted', connectionId: 'c1', clusterUrl: 'https://mycluster.kusto.windows.net', database: 'db1' } }));
			await el.updateComplete;

			functionRow = Array.from(el.shadowRoot!.querySelectorAll('.explorer-list-item'))
				.find(row => row.querySelector('.explorer-list-item-name')?.textContent?.trim() === 'AgentHealth');
			refreshBtn = functionRow?.querySelector('.explorer-list-item-actions .btn-icon');
			expect(hasSpinner(refreshBtn)).toBe(true);
		});

		it('SQL: database-level refresh shows spinner while schema load is in flight', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({ activeKind: 'sql', connections: [], cachedDatabases: {} }));
			await el.updateComplete;

			clickListItemByName(el, 'MySqlServer');
			await el.updateComplete;
			clickListItemByName(el, 'sqldb1');
			await el.updateComplete;

			let refreshBtn = el.shadowRoot!.querySelector('.breadcrumb-refresh') as HTMLButtonElement | null;
			expect(hasSpinner(refreshBtn)).toBe(false);

			window.dispatchEvent(new MessageEvent('message', { data: { type: 'sql.loadingSchema', connectionId: 'sql1', database: 'sqldb1' } }));
			await el.updateComplete;
			refreshBtn = el.shadowRoot!.querySelector('.breadcrumb-refresh') as HTMLButtonElement | null;
			expect(hasSpinner(refreshBtn)).toBe(true);

			window.dispatchEvent(new MessageEvent('message', { data: { type: 'sql.schemaLoaded', connectionId: 'sql1', database: 'sqldb1', schema: { tables: [], columnsByTable: {} } } }));
			await el.updateComplete;
			refreshBtn = el.shadowRoot!.querySelector('.breadcrumb-refresh') as HTMLButtonElement | null;
			expect(hasSpinner(refreshBtn)).toBe(false);
		});

		it('SQL: schema loading state has no duplicate inline spinner', async () => {
			const el = createElement();
			sendSnapshot(el, snapshot({ activeKind: 'sql', connections: [], cachedDatabases: {} }));
			await el.updateComplete;

			clickListItemByName(el, 'MySqlServer');
			await el.updateComplete;
			clickListItemByName(el, 'sqldb1');
			await el.updateComplete;

			const loading = el.shadowRoot!.querySelector('.loading-state');
			expect(loading?.textContent).toContain('Loading schema...');
			expect(hasSpinner(loading)).toBe(false);
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
