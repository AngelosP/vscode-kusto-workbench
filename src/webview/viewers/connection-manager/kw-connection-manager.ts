import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { styles } from './kw-connection-manager.styles.js';
import { scrollbarSheet } from '../../shared/scrollbar-styles.js';
import { osStyles } from '../../shared/os-styles.js';
import { OverlayScrollbarsController } from '../../components/overlay-scrollbars.controller.js';
import { customElement, state } from 'lit/decorators.js';
import { ICONS, iconRegistryStyles } from '../../shared/icon-registry.js';
import { registerPageScrollDismissable } from '../../core/page-scroll-dismiss.js';
import { pushDismissable, removeDismissable } from '../../components/dismiss-stack.js';
import type { KustoConnectionFormSubmitDetail } from '../../components/kw-kusto-connection-form.js';
import type { SqlConnectionFormSubmitDetail } from '../../components/kw-sql-connection-form.js';
import '../../components/kw-kusto-connection-form.js';
import '../../components/kw-sql-connection-form.js';
import {
	ConnectionManagerSearchController,
	KUSTO_CATEGORIES,
	SQL_CATEGORIES,
	type SearchResult,
	type SearchControllerHost,
} from './connection-manager-search.controller.js';
import { kustoClusterKey } from '../../shared/clusterUtils.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface KustoConnection {
	id: string;
	name: string;
	clusterUrl: string;
	database?: string;
	authorityId?: string;
	accountPartition?: string;
	authSessionGeneration?: number;
	accountPreference: { mode: 'automatic'; lastSuccessfulAccountId?: string; legacyAccountId?: string } | { mode: 'explicit'; accountId: string };
	selectedAccountId?: string;
}

interface KustoFavorite {
	name: string;
	connectionId: string;
	clusterUrl: string;
	database: string;
}

interface Snapshot {
	revision?: number;
	timestamp: number;
	activeKind?: ConnectionKind;
	connections: KustoConnection[];
	accounts: Array<{ id: string; label: string }>;
	favorites: KustoFavorite[];
	cachedDatabases: Record<string, string[]>;
	expandedClusters: string[];
	leaveNoTraceClusters: string[];
	// SQL
	sqlConnections?: SqlConnectionInfo[];
	sqlCachedDatabases?: Record<string, string[]>;
	sqlExpandedConnections?: string[];
	sqlDialects?: SqlDialectInfo[];
	sqlFavorites?: SqlFavorite[];
	sqlLeaveNoTrace?: string[];
	sqlStateVersions?: { policy: number; principals: number; connections: number };
	sqlAvailable?: boolean;
	// Search
	searchState?: unknown;
}

type ConnectionKind = 'kusto' | 'sql';

type ActiveFilter = 'all' | 'favorites' | 'lnt' | 'search';

interface SqlConnectionInfo {
	id: string;
	name: string;
	dialect: string;
	serverUrl: string;
	port?: number;
	database?: string;
	authType: string;
	username?: string;
	credentialRevision?: number;
}

interface KustoFunctionInfo {
	name: string;
	folder?: string;
	parametersText?: string;
	docString?: string;
	body?: string;
}

interface SqlStoredProcedureInfo {
	name: string;
	schema?: string;
	parametersText?: string;
	body?: string;
}

interface SqlDialectInfo {
	id: string;
	displayName: string;
	defaultPort: number;
	authTypes: Array<{ id: string; displayName: string }>;
}

interface SqlDatabaseSchema {
	tables: string[];
	views?: string[];
	columnsByTable: Record<string, Record<string, string>>;
	storedProcedures?: SqlStoredProcedureInfo[];
}

interface SqlFavorite {
	name: string;
	connectionId: string;
	database: string;
}

interface DatabaseSchema {
	tables?: string[];
	functions?: KustoFunctionInfo[];
	columnTypesByTable?: Record<string, Record<string, string>>;
	tableFolders?: Record<string, string>;
	tableDocStrings?: Record<string, string>;
	columnDocStrings?: Record<string, string>;
}

interface TablePreview {
	loading?: boolean;
	columns?: Array<{ name: string; type?: string }>;
	rows?: unknown[][];
	rowCount?: number;
	executionTime?: string;
	error?: string;
}

type KustoRequestOwner = { requestId: string; accountPartition: string };

interface ExplorerPath {
	connectionId: string;
	database?: string;
	section?: 'tables' | 'functions' | 'table-columns' | 'views';
	folderPath?: string[];
	tableName?: string;
}

interface VsCodeApi {
	postMessage(msg: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortClusterName(url: string): string {
	try {
		let s = String(url || '').trim();
		if (!s) return '(unknown)';
		if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
		const parsed = new URL(s);
		const host = String(parsed.hostname || '').toLowerCase();
		const match = host.match(/^([^.]+)/);
		return match ? match[1] : host;
	} catch {
		return String(url || '').substring(0, 20);
	}
}

function normalizeClusterUrl(url: string): string {
	return kustoClusterKey(url);
}

function getClusterCacheKey(clusterUrl: string): string {
	return kustoClusterKey(clusterUrl);
}

const alphabeticCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareAlphabetically(left: string | undefined, right: string | undefined): number {
	return alphabeticCollator.compare(left ?? '', right ?? '');
}

function sortStringsAlphabetically(values: readonly string[] | undefined): string[] {
	return [...(values ?? [])].sort(compareAlphabetically);
}

function sortByAlphabeticLabels<T>(values: readonly T[] | undefined, getLabels: (item: T) => readonly (string | undefined)[]): T[] {
	return [...(values ?? [])].sort((left, right) => {
		const leftLabels = getLabels(left);
		const rightLabels = getLabels(right);
		const labelCount = Math.max(leftLabels.length, rightLabels.length);
		for (let labelIndex = 0; labelIndex < labelCount; labelIndex++) {
			const comparison = compareAlphabetically(leftLabels[labelIndex], rightLabels[labelIndex]);
			if (comparison !== 0) return comparison;
		}
		return 0;
	});
}

function getKustoConnectionLabel(connection: KustoConnection): string {
	return connection.name || shortClusterName(connection.clusterUrl);
}

function sortKustoConnections(connections: readonly KustoConnection[] | undefined): KustoConnection[] {
	return sortByAlphabeticLabels(connections, connection => [getKustoConnectionLabel(connection), connection.clusterUrl, connection.id]);
}

function kustoConnectionIdentity(connection: KustoConnection): string {
	return [connection.clusterUrl, connection.authorityId || '', connection.selectedAccountId || '', connection.accountPartition || '', connection.authSessionGeneration ?? 0, connection.accountPreference?.mode || 'automatic'].join('|');
}

function getSqlConnectionLabel(connection: SqlConnectionInfo): string {
	return connection.name || connection.serverUrl;
}

function sortSqlConnections(connections: readonly SqlConnectionInfo[] | undefined): SqlConnectionInfo[] {
	return sortByAlphabeticLabels(connections, connection => [getSqlConnectionLabel(connection), connection.serverUrl, connection.id]);
}

// ─── Component ────────────────────────────────────────────────────────────────

@customElement('kw-connection-manager')
export class KwConnectionManager extends LitElement {
	private _osCtrl = new OverlayScrollbarsController(this);

	// ── State ─────────────────────────────────────────────────────────────────

	@state() private _snapshot: Snapshot | null = null;
	@state() private _selectedConnectionId: string | null = null;
	@state() private _explorerPath: ExplorerPath | null = null;
	@state() private _expandedTables = new Set<string>();
	@state() private _expandedFunctions = new Set<string>();
	@state() private _expandedFolders = new Set<string>();
	@state() private _databaseSchemas: Record<string, DatabaseSchema> = {};
	@state() private _tablePreviewData: Record<string, TablePreview> = {};
	@state() private _loadingDatabases = new Set<string>();
	@state() private _databaseLoadErrors: Record<string, string> = {};
	@state() private _schemaLoadErrors: Record<string, string> = {};
	@state() private _loadingSchemaKeys = new Set<string>();
	@state() private _refreshingSchemaKeys = new Set<string>();
	private _schemaRequestIds = new Map<string, KustoRequestOwner>();
	private _schemaRefreshRequestIds = new Map<string, KustoRequestOwner>();
	private _previewRequestIds = new Map<string, KustoRequestOwner>();
	@state() private _activeFilter: ActiveFilter = 'all';
	@state() private _refreshMenuOpen = false;
	private _refreshMenuDismissRegistered = false;
	private _dismissRefreshMenu = (): void => this._closeRefreshMenu();

	// Modal state
	@state() private _modalVisible = false;
	@state() private _modalMode: 'add' | 'edit' = 'add';
	@state() private _editingConnectionId: string | null = null;
	@state() private _modalName = '';
	@state() private _modalUrl = '';
	@state() private _modalDb = '';
	@state() private _modalAuthorityId = '';
	@state() private _modalAccountId = '';
	@state() private _testResult = '';
	private _modalReturnFocus: HTMLElement | null = null;

	// SQL modal state
	@state() private _modalServerUrl = '';
	@state() private _modalPort = '';
	@state() private _modalDialect = 'mssql';
	@state() private _modalAuthType = 'aad';
	@state() private _modalUsername = '';
	@state() private _modalPassword = '';
	@state() private _modalChangePassword = false;

	// Multi-type state
	@state() private _activeKind: ConnectionKind = 'kusto';
	@state() private _sqlExplorerPath: ExplorerPath | null = null;
	@state() private _sqlDatabaseSchemas: Record<string, SqlDatabaseSchema> = {};
	@state() private _sqlTablePreviewData: Record<string, TablePreview> = {};
	@state() private _sqlLoadingDatabases = new Set<string>();
	@state() private _sqlDatabaseLoadErrors: Record<string, string> = {};
	@state() private _sqlSchemaLoadErrors: Record<string, string> = {};
	@state() private _sqlLoadingSchemaKeys = new Set<string>();
	private _sqlDatabaseRequestIds = new Map<string, string>();
	private _sqlSchemaRequestIds = new Map<string, string>();
	private _sqlPreviewRequestIds = new Map<string, string>();
	private _stagedKustoPublications = new Map<string, { payload: any; deadline: number; timer: ReturnType<typeof setTimeout> }>();
	private _completedKustoPublications = new Map<string, { accepted: boolean; timer: ReturnType<typeof setTimeout> }>();
	private _sqlTestConnectionRequestId: string | null = null;
	private _latestSnapshotRevision = 0;

	// ── VS Code API ───────────────────────────────────────────────────────────

	private _vscode!: VsCodeApi;

	// ── Search controller ─────────────────────────────────────────────────────

	private _search = new ConnectionManagerSearchController(this as unknown as SearchControllerHost);
	private _removeRefreshMenuScrollDismiss: (() => void) | null = null;
	private _scrollResetGeneration = 0;
	private _scrollClampRetryScheduled = false;
	private _scrollClampRetryCount = 0;
	private _scrollbarUpdateGeneration = 0;

	/** Bridge for the search controller to send messages to the host. */
	postMessage(msg: unknown): void {
		this._vscode.postMessage(msg);
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	connectedCallback(): void {
		super.connectedCallback();
		this._vscode = acquireVsCodeApi();
		window.addEventListener('message', this._onMessage);
		this._vscode.postMessage({ type: 'requestSnapshot' });
		this.addEventListener('click', this._dismissToolsMenu);
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		window.removeEventListener('message', this._onMessage);
		this.removeEventListener('click', this._dismissToolsMenu);
		this._cleanupRefreshMenuScrollDismiss();
	}

	protected override updated(changedProps: PropertyValues): void {
		super.updated(changedProps);
		this._syncScrollOwnerTestState();
		this._clampExplorerScroll();
		if (changedProps.has('_modalVisible')) {
			if (this._modalVisible) {
				const form = this.shadowRoot?.querySelector(this._activeKind === 'sql' ? 'kw-sql-connection-form' : 'kw-kusto-connection-form') as any;
				void form?.updateComplete?.then(() => {
					const selector = this._activeKind === 'sql' ? '[data-testid="sql-conn-server-url"]' : '[data-testid="kusto-conn-cluster-url"]';
					(form.shadowRoot?.querySelector(selector) as HTMLElement | null)?.focus();
				});
			} else if (this._modalReturnFocus?.isConnected) {
				this._modalReturnFocus.focus();
				this._modalReturnFocus = null;
			}
		}
	}

	private _getExplorerScrollElement(): HTMLElement | null {
		return this.shadowRoot?.querySelector<HTMLElement>('.explorer-content') ?? null;
	}

	private _updateExplorerScrollbar(scrollElement: HTMLElement): void {
		this._forceUpdateExplorerScrollbar(scrollElement);
		this._scheduleExplorerScrollbarUpdate(scrollElement, 2);
	}

	private _forceUpdateExplorerScrollbar(scrollElement: HTMLElement): void {
		const instance = this._osCtrl.getInstance(scrollElement);
		if (instance) {
			instance.update(true);
		} else {
			this._osCtrl.rescan();
		}
	}

	private _scheduleExplorerScrollbarUpdate(scrollElement: HTMLElement, remainingFrames: number): void {
		const generation = ++this._scrollbarUpdateGeneration;
		const updateOnNextFrame = (framesLeft: number): void => {
			requestAnimationFrame(() => {
				if (!this.isConnected || generation !== this._scrollbarUpdateGeneration || !scrollElement.isConnected) return;
				this._forceUpdateExplorerScrollbar(scrollElement);
				if (framesLeft > 1) updateOnNextFrame(framesLeft - 1);
			});
		};
		updateOnNextFrame(remainingFrames);
	}

	private _clampExplorerScroll(): void {
		const scrollElement = this._getExplorerScrollElement();
		if (!scrollElement) return;
		if (scrollElement.clientHeight <= 0) {
			this._scheduleExplorerScrollClampRetry();
			return;
		}
		this._scrollClampRetryCount = 0;
		const maxScrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
		if (scrollElement.scrollTop <= maxScrollTop) return;
		scrollElement.scrollTop = maxScrollTop;
		this._updateExplorerScrollbar(scrollElement);
	}

	private _scheduleExplorerScrollClampRetry(): void {
		if (this._scrollClampRetryScheduled) return;
		if (this._scrollClampRetryCount >= 10) return;
		this._scrollClampRetryCount += 1;
		this._scrollClampRetryScheduled = true;
		requestAnimationFrame(() => {
			this._scrollClampRetryScheduled = false;
			const scrollElement = this._getExplorerScrollElement();
			if (!this.isConnected || !scrollElement) return;
			if (scrollElement.clientHeight <= 0) {
				this._scheduleExplorerScrollClampRetry();
				return;
			}
			this._clampExplorerScroll();
		});
	}

	private _scheduleExplorerScrollReset(): void {
		const generation = ++this._scrollResetGeneration;
		void this.updateComplete.then(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))).then(() => {
			if (!this.isConnected || generation !== this._scrollResetGeneration) return;
			const scrollElement = this._getExplorerScrollElement();
			if (!scrollElement) return;
			if (scrollElement.scrollTop !== 0) {
				scrollElement.scrollTop = 0;
			}
			this._updateExplorerScrollbar(scrollElement);
		});
	}

	private _isSameExplorerPath(left: ExplorerPath | null, right: ExplorerPath | null): boolean {
		if (!left || !right) return left === right;
		const leftFolders = left.folderPath ?? [];
		const rightFolders = right.folderPath ?? [];
		return left.connectionId === right.connectionId
			&& (left.database ?? '') === (right.database ?? '')
			&& (left.section ?? '') === (right.section ?? '')
			&& (left.tableName ?? '') === (right.tableName ?? '')
			&& leftFolders.length === rightFolders.length
			&& leftFolders.every((folder, index) => folder === rightFolders[index]);
	}

	private _setKustoExplorerPath(path: ExplorerPath | null): void {
		if (this._isSameExplorerPath(this._explorerPath, path)) return;
		this._explorerPath = path;
		this._scheduleExplorerScrollReset();
	}

	private _setSqlExplorerPath(path: ExplorerPath | null): void {
		if (this._isSameExplorerPath(this._sqlExplorerPath, path)) return;
		this._sqlExplorerPath = path;
		this._scheduleExplorerScrollReset();
	}

	private _setKustoFilter(filter: ActiveFilter): void {
		if (filter === this._activeFilter) return;
		this._activeFilter = filter;
		if (filter === 'search' && this._search.kind !== 'kusto') this._search.setKind('kusto');
		this._validateBreadcrumb();
		this._scheduleExplorerScrollReset();
	}

	private _setSqlFilter(filter: ActiveFilter): void {
		if (filter === this._activeFilter) return;
		this._activeFilter = filter;
		if (filter === 'search' && this._search.kind !== 'sql') this._search.setKind('sql');
		this._validateSqlBreadcrumb();
		this._scheduleExplorerScrollReset();
	}

	private _syncScrollOwnerTestState(): void {
		const content = this.shadowRoot?.querySelector<HTMLElement>('.explorer-content');
		if (!content) {
			delete this.dataset.testScrollOwner;
			return;
		}
		const nestedList = content.querySelector<HTMLElement>('.explorer-list');
		const nestedOverflowY = nestedList ? String(getComputedStyle(nestedList).overflowY || '') : '';
		this.dataset.testScrollOwner = nestedOverflowY === 'auto' || nestedOverflowY === 'scroll' ? 'nested' : 'single';
	}

	private _dismissToolsMenu = (e: Event) => {
		const path = e.composedPath();
		if (this._refreshMenuOpen) {
			const split = this.shadowRoot?.querySelector('.search-refresh-split');
			if (split && !path.includes(split)) {
				this._closeRefreshMenu();
			}
		}
	};

	private _toggleRefreshMenu(): void {
		const nextOpen = !this._refreshMenuOpen;
		this._refreshMenuOpen = nextOpen;
		this._cleanupRefreshMenuScrollDismiss();
		if (nextOpen) {
			pushDismissable(this._dismissRefreshMenu);
			this._refreshMenuDismissRegistered = true;
			this._removeRefreshMenuScrollDismiss = registerPageScrollDismissable(() => this._closeRefreshMenu(), {
				dismissOnWheel: true,
				shouldDismiss: ({ event, kind }) => {
					if (kind !== 'wheel') return true;
					const split = this.shadowRoot?.querySelector('.search-refresh-split');
					return !(split && event.composedPath().includes(split));
				},
			});
		}
	}

	private _closeRefreshMenu(): void {
		this._cleanupRefreshMenuScrollDismiss();
		this._refreshMenuOpen = false;
	}

	private _cleanupRefreshMenuScrollDismiss(): void {
		if (this._refreshMenuDismissRegistered) {
			removeDismissable(this._dismissRefreshMenu);
			this._refreshMenuDismissRegistered = false;
		}
		if (!this._removeRefreshMenuScrollDismiss) return;
		this._removeRefreshMenuScrollDismiss();
		this._removeRefreshMenuScrollDismiss = null;
	}

	private _evictChangedKustoIdentityState(previous: Snapshot | null, next: Snapshot): boolean {
		if (!previous) return false;
		const previousById = new Map(previous.connections.map(connection => [connection.id, connection]));
		const nextById = new Map(next.connections.map(connection => [connection.id, connection]));
		const changedIds = new Set<string>();
		const firstEstablishedIds = new Set<string>();
		for (const [connectionId, previousConnection] of previousById) {
			const nextConnection = nextById.get(connectionId);
			if (!nextConnection || kustoConnectionIdentity(previousConnection) !== kustoConnectionIdentity(nextConnection)) {
				changedIds.add(connectionId);
				if (!previousConnection.accountPartition && nextConnection?.accountPartition) firstEstablishedIds.add(connectionId);
			}
		}
		if (changedIds.size === 0) return false;
		this._search.invalidateKustoResults();
		const belongsToChangedConnection = (key: string) => changedIds.has(String(key || '').split('|')[0]);
		const preserveEstablishingRequest = (key: string, owners: Map<string, KustoRequestOwner>) => {
			const connectionId = String(key || '').split('|')[0];
			const owner = owners.get(key);
			return firstEstablishedIds.has(connectionId) && !!owner && !owner.accountPartition;
		};
		this._databaseSchemas = Object.fromEntries(Object.entries(this._databaseSchemas).filter(([key]) => !belongsToChangedConnection(key)));
		this._tablePreviewData = Object.fromEntries(Object.entries(this._tablePreviewData).filter(([key]) => !belongsToChangedConnection(key)));
		this._schemaLoadErrors = Object.fromEntries(Object.entries(this._schemaLoadErrors).filter(([key]) => !belongsToChangedConnection(key)));
		this._databaseLoadErrors = Object.fromEntries(Object.entries(this._databaseLoadErrors).filter(([key]) => !changedIds.has(key)));
		this._loadingDatabases = new Set([...this._loadingDatabases].filter(connectionId => !changedIds.has(connectionId)));
		this._loadingSchemaKeys = new Set([...this._loadingSchemaKeys].filter(key => !belongsToChangedConnection(key) || preserveEstablishingRequest(key, this._schemaRequestIds)));
		this._refreshingSchemaKeys = new Set([...this._refreshingSchemaKeys].filter(key => !belongsToChangedConnection(key) || preserveEstablishingRequest(key, this._schemaRefreshRequestIds)));
		for (const key of [...this._schemaRequestIds.keys()]) if (belongsToChangedConnection(key) && !preserveEstablishingRequest(key, this._schemaRequestIds)) this._schemaRequestIds.delete(key);
		for (const key of [...this._schemaRefreshRequestIds.keys()]) if (belongsToChangedConnection(key) && !preserveEstablishingRequest(key, this._schemaRefreshRequestIds)) this._schemaRefreshRequestIds.delete(key);
		for (const key of [...this._previewRequestIds.keys()]) if (belongsToChangedConnection(key) && !preserveEstablishingRequest(key, this._previewRequestIds)) this._previewRequestIds.delete(key);
		this._expandedTables = new Set([...this._expandedTables].filter(key => !belongsToChangedConnection(key)));
		this._expandedFunctions = new Set([...this._expandedFunctions].filter(key => !belongsToChangedConnection(key)));
		this._expandedFolders = new Set([...this._expandedFolders].filter(key => !belongsToChangedConnection(key)));
		return true;
	}

	private _evictProtectedSqlState(next: Snapshot): void {
		if (next.sqlAvailable === false) {
			this._sqlDatabaseSchemas = {};
			this._sqlTablePreviewData = {};
			this._sqlSchemaLoadErrors = {};
			this._sqlDatabaseLoadErrors = {};
			this._sqlLoadingDatabases = new Set();
			this._sqlLoadingSchemaKeys = new Set();
			this._sqlDatabaseRequestIds.clear();
			this._sqlSchemaRequestIds.clear();
			this._sqlPreviewRequestIds.clear();
			this._sqlTestConnectionRequestId = null;
			this._testResult = '';
			this._setSqlExplorerPath(null);
			this._search.invalidateSqlResults();
			return;
		}
		const protectedIds = new Set(next.sqlLeaveNoTrace ?? []);
		const isProtectedKey = (key: string) => protectedIds.has(String(key || '').split('|')[0]);
		this._sqlDatabaseSchemas = Object.fromEntries(Object.entries(this._sqlDatabaseSchemas).filter(([key]) => !isProtectedKey(key)));
		this._sqlTablePreviewData = Object.fromEntries(Object.entries(this._sqlTablePreviewData).filter(([key]) => !isProtectedKey(key)));
		this._sqlSchemaLoadErrors = Object.fromEntries(Object.entries(this._sqlSchemaLoadErrors).filter(([key]) => !isProtectedKey(key)));
		this._sqlDatabaseLoadErrors = Object.fromEntries(Object.entries(this._sqlDatabaseLoadErrors).filter(([key]) => !protectedIds.has(key)));
		this._sqlLoadingDatabases = new Set([...this._sqlLoadingDatabases].filter(id => !protectedIds.has(id)));
		this._sqlLoadingSchemaKeys = new Set([...this._sqlLoadingSchemaKeys].filter(key => !isProtectedKey(key)));
		for (const key of [...this._sqlDatabaseRequestIds.keys()]) if (protectedIds.has(key)) this._sqlDatabaseRequestIds.delete(key);
		for (const key of [...this._sqlSchemaRequestIds.keys()]) if (isProtectedKey(key)) this._sqlSchemaRequestIds.delete(key);
		for (const key of [...this._sqlPreviewRequestIds.keys()]) if (isProtectedKey(key)) this._sqlPreviewRequestIds.delete(key);
		if (this._sqlExplorerPath && protectedIds.has(this._sqlExplorerPath.connectionId)) this._setSqlExplorerPath(null);
		this._search.invalidateSqlResults();
	}

	private _evictProtectedKustoState(next: Snapshot): void {
		const protectedClusters = new Set((next.leaveNoTraceClusters || []).map(cluster => kustoClusterKey(cluster)));
		const protectedIds = new Set((next.connections || [])
			.filter(connection => protectedClusters.has(kustoClusterKey(connection.clusterUrl)))
			.map(connection => connection.id));
		if (protectedIds.size === 0) return;
		const isProtectedKey = (key: string) => protectedIds.has(String(key || '').split('|')[0]);
		this._databaseSchemas = Object.fromEntries(Object.entries(this._databaseSchemas).filter(([key]) => !isProtectedKey(key)));
		this._tablePreviewData = Object.fromEntries(Object.entries(this._tablePreviewData).filter(([key]) => !isProtectedKey(key)));
		this._schemaLoadErrors = Object.fromEntries(Object.entries(this._schemaLoadErrors).filter(([key]) => !isProtectedKey(key)));
		this._databaseLoadErrors = Object.fromEntries(Object.entries(this._databaseLoadErrors).filter(([key]) => !protectedIds.has(key)));
		this._loadingDatabases = new Set([...this._loadingDatabases].filter(id => !protectedIds.has(id)));
		this._loadingSchemaKeys = new Set([...this._loadingSchemaKeys].filter(key => !isProtectedKey(key)));
		this._refreshingSchemaKeys = new Set([...this._refreshingSchemaKeys].filter(key => !isProtectedKey(key)));
		for (const key of [...this._schemaRequestIds.keys()]) if (isProtectedKey(key)) this._schemaRequestIds.delete(key);
		for (const key of [...this._schemaRefreshRequestIds.keys()]) if (isProtectedKey(key)) this._schemaRefreshRequestIds.delete(key);
		for (const key of [...this._previewRequestIds.keys()]) if (isProtectedKey(key)) this._previewRequestIds.delete(key);
		this._expandedTables = new Set([...this._expandedTables].filter(key => !isProtectedKey(key)));
		this._expandedFunctions = new Set([...this._expandedFunctions].filter(key => !isProtectedKey(key)));
		this._expandedFolders = new Set([...this._expandedFolders].filter(key => !isProtectedKey(key)));
		if (this._explorerPath && protectedIds.has(this._explorerPath.connectionId)) this._setKustoExplorerPath(null);
		this._search.invalidateKustoResults();
	}

	// ── Message handling ──────────────────────────────────────────────────────

	private _onMessage = (event: MessageEvent) => {
		let msg = event.data;
		if (!msg) return;
		const acknowledge = (accepted: boolean, phase: 'staged' | 'applied' = 'applied') => {
			if (!msg.publicationId) return;
			if (phase === 'applied') {
				const previous = this._completedKustoPublications.get(msg.publicationId);
				if (previous) clearTimeout(previous.timer);
				const timer = setTimeout(() => this._completedKustoPublications.delete(msg.publicationId), 10_000);
				this._completedKustoPublications.set(msg.publicationId, { accepted, timer });
			}
			this._vscode.postMessage({ type: 'kustoPublicationAck', publicationId: msg.publicationId, phase, accepted });
		};
		if (msg.type === 'kustoPublicationStage') {
			const publicationId = String(msg.publicationId || '');
			const deadline = Number(msg.publicationDeadline);
			if (!publicationId || !Number.isFinite(deadline) || deadline < Date.now()) {
				acknowledge(false, 'staged');
				return;
			}
			const previous = this._stagedKustoPublications.get(publicationId);
			if (previous) clearTimeout(previous.timer);
			const timer = setTimeout(() => {
				if (!this._stagedKustoPublications.delete(publicationId)) return;
				this._vscode.postMessage({ type: 'kustoPublicationAck', publicationId, phase: 'applied', accepted: false });
			}, Math.max(0, deadline - Date.now()));
			this._stagedKustoPublications.set(publicationId, { payload: msg.payload, deadline, timer });
			acknowledge(true, 'staged');
			return;
		}
		if (msg.type === 'kustoPublicationCommit') {
			const publicationId = String(msg.publicationId || '');
			const staged = this._stagedKustoPublications.get(publicationId);
			this._stagedKustoPublications.delete(publicationId);
			if (staged) clearTimeout(staged.timer);
			if (!staged || staged.deadline < Date.now()) {
				acknowledge(false, 'applied');
				return;
			}
			msg = { ...(staged.payload || {}), publicationId };
		}
		if (msg.type === 'kustoPublicationRevoke') {
			const publicationId = String(msg.publicationId || '');
			const staged = this._stagedKustoPublications.get(publicationId);
			if (staged) {
				clearTimeout(staged.timer);
				this._stagedKustoPublications.delete(publicationId);
			}
			acknowledge(this._completedKustoPublications.get(publicationId)?.accepted === true, 'applied');
			return;
		}
		if (msg.publicationId && Number(msg.publicationDeadline) < Date.now()) {
			acknowledge(false, 'applied');
			return;
		}

		switch (msg.type) {
			case 'snapshot': {
				const revision = Number(msg.snapshot?.revision) || 0;
				if (revision && revision < this._latestSnapshotRevision) { acknowledge(false); break; }
				if (revision) this._latestSnapshotRevision = revision;
				const kustoIdentityChanged = this._evictChangedKustoIdentityState(this._snapshot, msg.snapshot);
				this._evictProtectedKustoState(msg.snapshot);
				this._evictProtectedSqlState(msg.snapshot);
				this._snapshot = msg.snapshot;
				// Auto-detect active kind
				if (this._snapshot) {
					const previousKind = this._activeKind;
					const hasKusto = (this._snapshot.connections?.length ?? 0) > 0;
					const hasSql = (this._snapshot.sqlConnections?.length ?? 0) > 0;
					const persisted = this._snapshot.activeKind;
					if (persisted === 'sql' && hasSql) {
						this._activeKind = 'sql';
					} else if (persisted === 'kusto' && hasKusto) {
						this._activeKind = 'kusto';
					} else if (hasSql && !hasKusto) {
						this._activeKind = 'sql';
					} else {
						this._activeKind = 'kusto';
					}
					if (this._activeKind !== previousKind) {
						this._scheduleExplorerScrollReset();
					}
					// Restore search state
					const protectedClusters = new Set((this._snapshot.leaveNoTraceClusters || []).map(cluster => kustoClusterKey(cluster)));
					const protectedConnectionIds = new Set((this._snapshot.connections || [])
						.filter(connection => protectedClusters.has(kustoClusterKey(connection.clusterUrl)))
						.map(connection => connection.id));
					const filteredSearchState = this._snapshot.searchState && typeof this._snapshot.searchState === 'object'
						? {
							...(this._snapshot.searchState as any),
							lastResults: Array.isArray((this._snapshot.searchState as any).lastResults)
								? (this._snapshot.searchState as any).lastResults.filter((result: any) => !protectedConnectionIds.has(String(result?.connectionId || '')))
								: [],
						}
						: this._snapshot.searchState;
					const searchState = this._snapshot.sqlAvailable === false
						? { query: '', scope: 'cached', categories: {}, contentToggles: {}, lastResults: [], lastSearchTimestamp: 0 }
						: kustoIdentityChanged && this._activeKind === 'kusto'
						? { ...(filteredSearchState as any), lastResults: [] }
						: filteredSearchState;
					this._search.restoreState(searchState as any, this._activeKind);
				}
				if (!this._selectedConnectionId && this._snapshot?.connections?.length) {
					const sortedConnections = sortKustoConnections(this._snapshot.connections);
					this._selectedConnectionId = sortedConnections[0].id;
					this._vscode.postMessage({ type: 'cluster.expand', connectionId: this._selectedConnectionId });
				}
				acknowledge(true);
				break;
			}
			case 'kustoPolicyChanged': {
				const changedIds = new Set<string>((Array.isArray(msg.connectionIds) ? msg.connectionIds : []).map((id: unknown) => String(id)));
				if (changedIds.size > 0 && this._snapshot) {
					this._evictProtectedKustoState({
						...this._snapshot,
						leaveNoTraceClusters: this._snapshot.connections
							.filter(connection => changedIds.has(connection.id))
							.map(connection => connection.clusterUrl),
					});
					this.requestUpdate();
				}
				break;
			}
			case 'sqlPrincipalChanged':
			case 'sqlOwnerChanged': {
				const changedIds = new Set<string>((Array.isArray(msg.connectionIds) ? msg.connectionIds : []).map((id: unknown) => String(id)));
				const isChangedKey = (key: string) => changedIds.has(String(key || '').split('|')[0]);
				this._sqlDatabaseSchemas = Object.fromEntries(Object.entries(this._sqlDatabaseSchemas).filter(([key]) => !isChangedKey(key)));
				this._sqlTablePreviewData = Object.fromEntries(Object.entries(this._sqlTablePreviewData).filter(([key]) => !isChangedKey(key)));
				this._sqlSchemaLoadErrors = Object.fromEntries(Object.entries(this._sqlSchemaLoadErrors).filter(([key]) => !isChangedKey(key)));
				for (const id of changedIds) delete this._sqlDatabaseLoadErrors[id];
				this._sqlLoadingDatabases = new Set([...this._sqlLoadingDatabases].filter(id => !changedIds.has(id)));
				this._sqlLoadingSchemaKeys = new Set([...this._sqlLoadingSchemaKeys].filter(key => !isChangedKey(key)));
				for (const key of [...this._sqlDatabaseRequestIds.keys()]) if (changedIds.has(key)) this._sqlDatabaseRequestIds.delete(key);
				for (const key of [...this._sqlSchemaRequestIds.keys()]) if (isChangedKey(key)) this._sqlSchemaRequestIds.delete(key);
				for (const key of [...this._sqlPreviewRequestIds.keys()]) if (isChangedKey(key)) this._sqlPreviewRequestIds.delete(key);
				if (this._sqlExplorerPath && changedIds.has(this._sqlExplorerPath.connectionId)) this._setSqlExplorerPath(null);
				if (this._editingConnectionId && changedIds.has(this._editingConnectionId) && this._sqlTestConnectionRequestId) {
					this._sqlTestConnectionRequestId = null;
					if (this._testResult === 'loading') this._testResult = '✗ SQL connection owner changed. Retry the test.';
				}
				this._search.invalidateSqlResults();
				this.requestUpdate();
				break;
			}
			case 'testConnectionStarted':
				this._testResult = 'loading';
				break;
			case 'testConnectionResult':
				this._testResult = msg.success ? `✓ ${msg.message}` : msg.warning ? `⚠ ${msg.message}` : `✗ ${msg.message}`;
				break;
			case 'connectionMutationComplete':
				if (msg.success) this._closeModal();
				else this._testResult = `✗ ${String(msg.error || 'Connection could not be saved.')}`;
				break;
			case 'loadingDatabases':
				this._loadingDatabases = new Set([...this._loadingDatabases, msg.connectionId]);
				this._databaseLoadErrors = { ...this._databaseLoadErrors, [msg.connectionId]: '' };
				break;
			case 'databasesLoaded':
				this._loadingDatabases = new Set([...this._loadingDatabases].filter(id => id !== msg.connectionId));
				this._databaseLoadErrors = { ...this._databaseLoadErrors, [msg.connectionId]: '' };
				this._vscode.postMessage({ type: 'requestSnapshot' });
				acknowledge(true);
				break;
			case 'databasesLoadError':
				this._loadingDatabases = new Set([...this._loadingDatabases].filter(id => id !== msg.connectionId));
				this._databaseLoadErrors = { ...this._databaseLoadErrors, [msg.connectionId]: msg.error || 'Failed to load databases.' };
				break;
			case 'loadingSchema': {
				const dbKey = msg.connectionId + '|' + msg.database;
				if (msg.requestId) this._schemaRequestIds.set(dbKey, { requestId: msg.requestId, accountPartition: String(msg.accountPartition || '') });
				this._loadingSchemaKeys = new Set([...this._loadingSchemaKeys, this._getKustoSchemaKey(msg.connectionId, msg.database)]);
				this._schemaLoadErrors = { ...this._schemaLoadErrors, [dbKey]: '' };
				break;
			}
			case 'schemaLoaded': {
				const dbKey = msg.connectionId + '|' + msg.database;
				const refreshKey = this._getKustoRefreshSchemaKey(msg.connectionId, msg.database);
				const ordinaryOwner = this._schemaRequestIds.get(dbKey);
				const refreshOwner = this._schemaRefreshRequestIds.get(refreshKey);
				if (msg.requestId && ordinaryOwner?.requestId !== msg.requestId && refreshOwner?.requestId !== msg.requestId) { acknowledge(false); break; }
				const connection = this._snapshot?.connections.find(candidate => candidate.id === msg.connectionId);
				if (msg.accountPartition && connection?.accountPartition && connection.accountPartition !== msg.accountPartition) { acknowledge(false); break; }
				if (ordinaryOwner?.requestId === msg.requestId) this._schemaRequestIds.delete(dbKey);
				this._loadingSchemaKeys = new Set([...this._loadingSchemaKeys].filter(key => key !== this._getKustoSchemaKey(msg.connectionId, msg.database)));
				this._databaseSchemas = { ...this._databaseSchemas, [dbKey]: msg.schema };
				this._schemaLoadErrors = { ...this._schemaLoadErrors, [dbKey]: '' };
				acknowledge(true);
				break;
			}
			case 'schemaLoadError': {
				const dbKey = msg.connectionId + '|' + msg.database;
				if (msg.requestId && this._schemaRequestIds.get(dbKey)?.requestId !== msg.requestId) break;
				this._schemaRequestIds.delete(dbKey);
				this._loadingSchemaKeys = new Set([...this._loadingSchemaKeys].filter(key => key !== this._getKustoSchemaKey(msg.connectionId, msg.database)));
				this._schemaLoadErrors = { ...this._schemaLoadErrors, [dbKey]: msg.error || 'Failed to load schema.' };
				break;
			}
			case 'schemaRefreshStarted': {
				const refreshKey = this._getKustoRefreshSchemaKey(msg.connectionId, msg.database);
				if (msg.requestId) this._schemaRefreshRequestIds.set(refreshKey, { requestId: msg.requestId, accountPartition: String(msg.accountPartition || '') });
				this._refreshingSchemaKeys = new Set([...this._refreshingSchemaKeys, refreshKey]);
				break;
			}
			case 'schemaRefreshCompleted': {
				const refreshKey = this._getKustoRefreshSchemaKey(msg.connectionId, msg.database);
				if (msg.requestId && this._schemaRefreshRequestIds.get(refreshKey)?.requestId !== msg.requestId) { acknowledge(false); break; }
				this._schemaRefreshRequestIds.delete(refreshKey);
				this._refreshingSchemaKeys = new Set([...this._refreshingSchemaKeys].filter(key => key !== refreshKey));
				acknowledge(true);
				break;
			}
			case 'tablePreviewLoading': {
				const prevKey = msg.connectionId + '|' + msg.database + '|table|' + msg.tableName;
				if (msg.requestId) this._previewRequestIds.set(prevKey, { requestId: msg.requestId, accountPartition: String(msg.accountPartition || '') });
				this._tablePreviewData = { ...this._tablePreviewData, [prevKey]: { loading: true } };
				break;
			}
			case 'tablePreviewResult': {
				const prevKey = msg.connectionId + '|' + msg.database + '|table|' + msg.tableName;
				if (msg.requestId && this._previewRequestIds.get(prevKey)?.requestId !== msg.requestId) { acknowledge(false); break; }
				const connection = this._snapshot?.connections.find(candidate => candidate.id === msg.connectionId);
				if (msg.accountPartition && connection?.accountPartition && connection.accountPartition !== msg.accountPartition) { acknowledge(false); break; }
				this._previewRequestIds.delete(prevKey);
				if (msg.success) {
					this._tablePreviewData = { ...this._tablePreviewData, [prevKey]: { loading: false, columns: msg.columns, rows: msg.rows, rowCount: msg.rowCount, executionTime: msg.executionTime } };
				} else {
					this._tablePreviewData = { ...this._tablePreviewData, [prevKey]: { loading: false, error: msg.error || 'Failed to load preview.' } };
				}
				acknowledge(true);
				break;
			}
			// SQL messages
			case 'sql.testConnectionStarted':
				if (msg.connectionId && this._editingConnectionId !== msg.connectionId) break;
				if (msg.requestId) this._sqlTestConnectionRequestId = msg.requestId;
				this._testResult = 'loading';
				break;
			case 'sql.testConnectionResult':
				if (msg.requestId && this._sqlTestConnectionRequestId !== msg.requestId) break;
				if (msg.connectionId && this._editingConnectionId !== msg.connectionId) break;
				this._sqlTestConnectionRequestId = null;
				this._testResult = msg.success ? `✓ ${msg.message}` : `✗ ${msg.message}`;
				break;
			case 'sql.loadingDatabases':
				if (msg.requestId) this._sqlDatabaseRequestIds.set(msg.connectionId, msg.requestId);
				this._sqlLoadingDatabases = new Set([...this._sqlLoadingDatabases, msg.connectionId]);
				this._sqlDatabaseLoadErrors = { ...this._sqlDatabaseLoadErrors, [msg.connectionId]: '' };
				break;
			case 'sql.databasesLoaded':
				if (this._snapshot?.sqlLeaveNoTrace?.includes(msg.connectionId)) break;
				if (msg.requestId && this._sqlDatabaseRequestIds.get(msg.connectionId) !== msg.requestId) break;
				this._sqlDatabaseRequestIds.delete(msg.connectionId);
				this._sqlLoadingDatabases = new Set([...this._sqlLoadingDatabases].filter(id => id !== msg.connectionId));
				this._sqlDatabaseLoadErrors = { ...this._sqlDatabaseLoadErrors, [msg.connectionId]: '' };
				this._vscode.postMessage({ type: 'requestSnapshot' });
				break;
			case 'sql.databasesLoadError':
				if (this._snapshot?.sqlLeaveNoTrace?.includes(msg.connectionId)) break;
				if (msg.requestId && this._sqlDatabaseRequestIds.get(msg.connectionId) !== msg.requestId) break;
				this._sqlDatabaseRequestIds.delete(msg.connectionId);
				this._sqlLoadingDatabases = new Set([...this._sqlLoadingDatabases].filter(id => id !== msg.connectionId));
				this._sqlDatabaseLoadErrors = { ...this._sqlDatabaseLoadErrors, [msg.connectionId]: msg.error || 'Failed to load databases.' };
				break;
			case 'sql.loadingSchema': {
				if (this._snapshot?.sqlLeaveNoTrace?.includes(msg.connectionId)) break;
				const sqlDbKey = msg.connectionId + '|' + msg.database;
				if (msg.requestId) this._sqlSchemaRequestIds.set(sqlDbKey, msg.requestId);
				this._sqlLoadingSchemaKeys = new Set([...this._sqlLoadingSchemaKeys, this._getSqlSchemaKey(msg.connectionId, msg.database)]);
				this._sqlSchemaLoadErrors = { ...this._sqlSchemaLoadErrors, [sqlDbKey]: '' };
				break;
			}
			case 'sql.schemaLoaded': {
				if (this._snapshot?.sqlLeaveNoTrace?.includes(msg.connectionId)) break;
				const sqlDbKey = msg.connectionId + '|' + msg.database;
				if (msg.requestId && this._sqlSchemaRequestIds.get(sqlDbKey) !== msg.requestId) break;
				this._sqlSchemaRequestIds.delete(sqlDbKey);
				this._sqlLoadingSchemaKeys = new Set([...this._sqlLoadingSchemaKeys].filter(key => key !== this._getSqlSchemaKey(msg.connectionId, msg.database)));
				this._sqlDatabaseSchemas = { ...this._sqlDatabaseSchemas, [sqlDbKey]: msg.schema };
				this._sqlSchemaLoadErrors = { ...this._sqlSchemaLoadErrors, [sqlDbKey]: '' };
				break;
			}
			case 'sql.schemaLoadError': {
				if (this._snapshot?.sqlLeaveNoTrace?.includes(msg.connectionId)) break;
				const sqlDbKey = msg.connectionId + '|' + msg.database;
				if (msg.requestId && this._sqlSchemaRequestIds.get(sqlDbKey) !== msg.requestId) break;
				this._sqlSchemaRequestIds.delete(sqlDbKey);
				this._sqlLoadingSchemaKeys = new Set([...this._sqlLoadingSchemaKeys].filter(key => key !== this._getSqlSchemaKey(msg.connectionId, msg.database)));
				this._sqlSchemaLoadErrors = { ...this._sqlSchemaLoadErrors, [sqlDbKey]: msg.error || 'Failed to load schema.' };
				break;
			}
			case 'sql.tablePreviewLoading': {
				if (this._snapshot?.sqlLeaveNoTrace?.includes(msg.connectionId)) break;
				const sqlPrevKey = msg.connectionId + '|' + msg.database + '|table|' + msg.tableName;
				if (msg.requestId) this._sqlPreviewRequestIds.set(sqlPrevKey, msg.requestId);
				this._sqlTablePreviewData = { ...this._sqlTablePreviewData, [sqlPrevKey]: { loading: true } };
				break;
			}
			case 'sql.tablePreviewResult': {
				if (this._snapshot?.sqlLeaveNoTrace?.includes(msg.connectionId)) break;
				const sqlPrevKey = msg.connectionId + '|' + msg.database + '|table|' + msg.tableName;
				if (msg.requestId && this._sqlPreviewRequestIds.get(sqlPrevKey) !== msg.requestId) break;
				this._sqlPreviewRequestIds.delete(sqlPrevKey);
				if (msg.success) {
					this._sqlTablePreviewData = { ...this._sqlTablePreviewData, [sqlPrevKey]: { loading: false, columns: msg.columns, rows: msg.rows, rowCount: msg.rowCount, executionTime: msg.executionTime } };
				} else {
					this._sqlTablePreviewData = { ...this._sqlTablePreviewData, [sqlPrevKey]: { loading: false, error: msg.error || 'Failed to load preview.' } };
				}
				break;
			}
			case 'settingsUpdate': {
				try {
					const altColor = typeof msg.alternatingRowColor === 'string' ? msg.alternatingRowColor : '';
					if (altColor === 'off') {
						document.documentElement.style.removeProperty('--kw-alt-row-bg');
					} else if (altColor === 'theme' || !altColor) {
						document.documentElement.style.setProperty('--kw-alt-row-bg', 'color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%)');
					} else {
						document.documentElement.style.setProperty('--kw-alt-row-bg', altColor);
					}
				} catch (e) { console.error('[kusto]', e); }
				break;
			}
			// Search messages
			case 'searchResults': {
				try {
					if (this._activeKind === 'sql' && Array.isArray(msg.results)) {
						const protectedIds = new Set(this._snapshot?.sqlLeaveNoTrace ?? []);
						msg.results = msg.results.filter((result: any) => !protectedIds.has(String(result?.connectionId || '')));
					}
					acknowledge(this._search.handleSearchResults(
						msg.requestId, msg.results, msg.completed, msg.kustoSearchOwnerToken,
					));
				} catch (error) {
					console.error('[kusto] Failed to apply search results', error);
					acknowledge(false);
				}
				break;
			}
			case 'searchProgress':
				this._search.handleSearchProgress(msg.requestId, msg.message, msg.current, msg.total);
				break;
		}
	};

	// ── Computed helpers ──────────────────────────────────────────────────────

	private _isPanelEmpty(): boolean {
		const kind = this._activeKind;
		if (this._activeFilter === 'search') {
			return this._search.results.length === 0;
		}
		if (kind === 'kusto') {
			return (this._snapshot?.connections?.length ?? 0) === 0;
		}
		return (this._snapshot?.sqlConnections?.length ?? 0) === 0;
	}

	private _isLeaveNoTrace(clusterUrl: string): boolean {
		if (!this._snapshot?.leaveNoTraceClusters) return false;
		const normalized = normalizeClusterUrl(clusterUrl);
		return this._snapshot.leaveNoTraceClusters.some(u => normalizeClusterUrl(u) === normalized);
	}

	private _getKustoSchemaKey(connectionId: string, database: string | undefined): string {
		return `${String(connectionId || '').trim()}|${String(database || '').trim().toLowerCase()}`;
	}

	private _getKustoRefreshSchemaKey(connectionId: string, database: string | undefined): string {
		return `${String(connectionId || '').trim()}|${String(database || '').trim().toLowerCase()}`;
	}

	private _getSqlSchemaKey(connectionId: string, database: string | undefined): string {
		return `${String(connectionId || '').trim()}|${String(database || '').trim().toLowerCase()}`;
	}

	private _isKustoSchemaBusy(conn: KustoConnection, database: string | undefined): boolean {
		return this._loadingSchemaKeys.has(this._getKustoSchemaKey(conn.id, database))
			|| this._refreshingSchemaKeys.has(this._getKustoRefreshSchemaKey(conn.id, database));
	}

	private _isSqlSchemaBusy(connectionId: string, database: string | undefined): boolean {
		return this._sqlLoadingSchemaKeys.has(this._getSqlSchemaKey(connectionId, database));
	}

	private _renderRefreshIcon(isBusy: boolean): TemplateResult {
		return isBusy ? ICONS.spinner : ICONS.refresh;
	}

	private _getFavorite(connectionId: string, database: string): KustoFavorite | undefined {
		if (!this._snapshot?.favorites) return undefined;
		const nDb = String(database || '').trim().toLowerCase();
		return this._snapshot.favorites.find(f =>
			f.connectionId === connectionId && String(f.database || '').trim().toLowerCase() === nDb
		);
	}

	private _getSelectedConnection(): KustoConnection | undefined {
		return this._snapshot?.connections?.find(c => c.id === this._selectedConnectionId);
	}

	// ── Render ────────────────────────────────────────────────────────────────

	protected render(): TemplateResult {
		const connections = sortKustoConnections(this._snapshot?.connections);
		const sqlConnections = sortSqlConnections(this._snapshot?.sqlConnections);
		const kind = this._activeKind;

		return html`
			<div class="page-header">
				<h1>Connection Manager</h1>
			</div>

			<div class="picker-actions-row">
				<kw-kind-picker
					data-testid="cm-kind-picker"
					.activeKind=${kind}
					.kustoCount=${connections.length}
					.sqlCount=${sqlConnections.length}
					@kind-changed=${(e: CustomEvent) => this._switchKind(e.detail.kind)}
				></kw-kind-picker>
				<div class="title-actions">
					<button class="header-btn primary" title="Add connection" data-testid="cm-add-connection" @click=${() => this._openModal('add')}>
						${ICONS.add} <span class="header-btn-label">Add connection</span>
					</button>
					${kind === 'kusto' ? html`
						<button class="header-btn secondary" title="Import" data-testid="cm-import-connections" @click=${() => this._vscode.postMessage({ type: 'connection.importXml' })}>
							${ICONS.connectionImport} <span class="header-btn-label">Import</span>
						</button>
						<button class="header-btn secondary" title="Export" data-testid="cm-export-connections" @click=${() => this._vscode.postMessage({ type: 'connection.exportXml' })}>
							${ICONS.connectionExport} <span class="header-btn-label">Export</span>
						</button>
					` : nothing}
				</div>
			</div>

			<div class="explorer-panel" data-testid="cm-explorer-panel" data-test-kind=${kind} data-test-connections=${connections.length} data-test-sql-connections=${sqlConnections.length}>
				${kind === 'kusto' ? this._renderKustoContent() : this._renderSqlContent()}
			</div>

			${this._modalVisible ? this._renderModal() : nothing}
		`;
	}

	private _switchKind(kind: ConnectionKind): void {
		if (kind === this._activeKind) return;
		this._activeKind = kind;
		this._explorerPath = null;
		this._sqlExplorerPath = null;
		this._search.setKind(kind);
		this._scheduleExplorerScrollReset();
		this._vscode.postMessage({ type: 'setActiveKind', kind });
	}

	private _renderKustoContent(): TemplateResult {
		const connections = sortKustoConnections(this._snapshot?.connections);
		const favorites = this._snapshot?.favorites ?? [];
		const lntClusters = this._snapshot?.leaveNoTraceClusters ?? [];
		const hasFavs = favorites.length > 0;
		const hasLnt = lntClusters.length > 0;
		const favoriteConnectionIds = new Set(favorites.map(f => f.connectionId));
		const af = this._activeFilter;

		// Apply filters
		let visibleConnections = connections;
		if (af === 'favorites') {
			visibleConnections = connections.filter(c => favoriteConnectionIds.has(c.id));
		}
		if (af === 'lnt') {
			const lntUrls = new Set(lntClusters.map(u => normalizeClusterUrl(u)));
			visibleConnections = visibleConnections.filter(c => lntUrls.has(normalizeClusterUrl(c.clusterUrl)));
		}

		return html`
			<!-- Filter tabs (always visible) -->
			<div class="filter-bar" data-testid="cm-filter-bar">
				<button class="filter-tab ${af === 'all' ? 'active' : ''}" data-testid="cm-filter-all" @click=${() => this._setKustoFilter('all')}>${ICONS.kustoCluster} <span class="filter-label">All</span></button>
				${hasFavs ? html`<button class="filter-tab fav-tab ${af === 'favorites' ? 'active' : ''}" data-testid="cm-filter-favorites" @click=${() => this._setKustoFilter(af === 'favorites' ? 'all' : 'favorites')}>${ICONS.starFilled} <span class="filter-label">Favorites</span> <span class="filter-count">${favorites.length}</span></button>` : nothing}
				${hasLnt ? html`<button class="filter-tab lnt-tab ${af === 'lnt' ? 'active' : ''}" @click=${() => this._setKustoFilter(af === 'lnt' ? 'all' : 'lnt')}>${ICONS.shield} <span class="filter-label">Leave No Trace</span> <span class="filter-count">${lntClusters.length}</span></button>` : nothing}
				<button class="filter-tab search-tab ${af === 'search' ? 'active' : ''}" data-testid="cm-filter-search" @click=${() => this._setKustoFilter(af === 'search' ? 'all' : 'search')}>${ICONS.toolbarSearch} <span class="filter-label">Search</span></button>
			</div>

			${af === 'search' ? this._renderSearchContent() : html`
				<!-- Breadcrumb (when drilled in) -->
				${this._explorerPath?.connectionId ? this._renderBreadcrumbBar() : nothing}

				<!-- Explorer content -->
				<div class="explorer-content" data-overlay-scroll="x:hidden">
					${this._explorerPath?.connectionId ? this._renderDrilledContent() : this._renderClusterList(visibleConnections, favoriteConnectionIds, lntClusters)}
				</div>
			`}
		`;
	}

	// ── Cluster list (root level — flat, click to drill in) ──────────────────

	private _renderClusterList(connections: KustoConnection[], favoriteConnectionIds: Set<string>, lntClusters: string[]): TemplateResult {
		if (connections.length === 0) {
			const hasFilter = this._activeFilter === 'favorites' || this._activeFilter === 'lnt';
			return html`<div class="empty-state" data-testid="cm-empty-state">
				<div class="empty-state-icon">${ICONS.kustoCluster}</div>
				<div class="empty-state-title">${hasFilter ? 'No matching clusters' : 'No clusters yet'}</div>
				<div class="empty-state-text">${hasFilter ? 'Try removing the filter.' : 'Add a Kusto cluster to get started.'}</div>
			</div>`;
		}

		const lntUrls = new Set(lntClusters.map(u => normalizeClusterUrl(u)));

		return html`${connections.map(conn => {
			const hasFav = favoriteConnectionIds.has(conn.id);
			const isLnt = lntUrls.has(normalizeClusterUrl(conn.clusterUrl));
			const dbCount = this._snapshot?.cachedDatabases?.[conn.id]?.length ?? 0;
			const fullUrl = /^https?:\/\//i.test(conn.clusterUrl) ? conn.clusterUrl : 'https://' + conn.clusterUrl;

			return html`
				<div class="explorer-list-item root-connection-row ${isLnt ? 'is-protected' : ''}" data-testid="cm-kusto-connection-row" data-connection-id=${conn.id} @click=${() => { if (!isLnt) this._drillIntoCluster(conn.id); }}>
					<span class="explorer-list-item-icon cluster">${ICONS.kustoCluster}</span>
					<span class="explorer-list-item-name">${conn.name || shortClusterName(conn.clusterUrl)}</span>
					${hasFav ? html`<span class="conn-badge fav-badge" title="Has favorites">${ICONS.starFilled}</span>` : nothing}
					${isLnt ? html`<span class="conn-badge lnt-badge" title="Leave No Trace">${ICONS.shield}</span>` : nothing}
					<span class="item-sep">·</span>
					<span class="explorer-list-item-url">${fullUrl}</span>
					${conn.authorityId ? html`<span class="item-sep">·</span><span class="explorer-list-item-meta">Tenant: ${conn.authorityId}</span>` : nothing}
					<span class="item-sep">·</span>
					<span class="explorer-list-item-meta">${isLnt ? 'Leave No Trace' : dbCount > 0 ? `${dbCount} database${dbCount !== 1 ? 's' : ''}` : 'click to explore'}</span>
					<div class="explorer-list-item-actions">
						<button class="btn-icon ${isLnt ? 'is-lnt' : ''}" title="${isLnt ? 'Remove from Leave No Trace' : 'Add to Leave No Trace'}"
							@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: isLnt ? 'leaveNoTrace.remove' : 'leaveNoTrace.add', clusterUrl: conn.clusterUrl }); }}>${ICONS.shield}</button>
						<button class="btn-icon" title="Edit" @click=${(e: Event) => { e.stopPropagation(); this._openModal('edit', conn.id); }}>${ICONS.edit}</button>
						${!isLnt ? html`<button class="btn-icon" title="Refresh" @click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'cluster.refreshDatabases', connectionId: conn.id }); }}>${ICONS.refresh}</button>` : nothing}
						<button class="btn-icon" title="Delete" @click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'connection.delete', id: conn.id }); }}>${ICONS.delete}</button>
					</div>
				</div>`;
		})}`;
	}

	private _drillIntoCluster(connId: string): void {
		this._selectedConnectionId = connId;
		this._setKustoExplorerPath({ connectionId: connId });
		this._vscode.postMessage({ type: 'cluster.expand', connectionId: connId });
	}

	/** Trim breadcrumb depth so it stays valid when a filter changes. */
	private _validateBreadcrumb(): void {
		const ep = this._explorerPath;
		if (!ep?.connectionId) return;

		const connections = this._snapshot?.connections ?? [];
		const conn = connections.find(c => c.id === ep.connectionId);
		if (!conn) { this._setKustoExplorerPath(null); return; }

		// Check if the cluster is visible under current filter
		if (this._activeFilter === 'favorites') {
			const favoriteConnectionIds = new Set((this._snapshot?.favorites ?? []).map(f => f.connectionId));
			if (!favoriteConnectionIds.has(conn.id)) { this._setKustoExplorerPath(null); return; }
			// If drilled into a database, check if it's a favorite
			if (ep.database) {
				if (!this._getFavorite(conn.id, ep.database)) { this._setKustoExplorerPath({ connectionId: ep.connectionId }); return; }
			}
		}
		if (this._activeFilter === 'lnt') {
			const lntUrls = new Set((this._snapshot?.leaveNoTraceClusters ?? []).map(u => normalizeClusterUrl(u)));
			if (!lntUrls.has(normalizeClusterUrl(conn.clusterUrl))) { this._setKustoExplorerPath(null); return; }
		}
		// Path is valid — keep it as-is
	}

	// ── Breadcrumb bar ───────────────────────────────────────────────────────

	private _renderBreadcrumbBar(): TemplateResult {
		const conn = this._snapshot?.connections?.find(c => c.id === this._explorerPath?.connectionId);
		if (!conn) return html``;
		return this._renderBreadcrumb(conn);
	}

	// ── Drilled content (databases → tables/functions) ────────────────────────

	private _renderDrilledContent(): TemplateResult {
		const conn = this._snapshot?.connections?.find(c => c.id === this._explorerPath?.connectionId);
		if (!conn) return html`<div class="empty-state"><div class="empty-state-text">Connection not found.</div></div>`;
		const databases = this._snapshot?.cachedDatabases?.[conn.id] ?? [];
		const isLoading = this._loadingDatabases.has(conn.id);

		return html`
			<div class="explorer-list">
				${this._renderExplorerContent(conn, databases, isLoading)}
			</div>
		`;
	}

	private _renderBreadcrumb(conn: KustoConnection): TemplateResult {
		const ep = this._explorerPath;
		const rootLabel = this._activeFilter === 'favorites' ? 'Favorites' : this._activeFilter === 'lnt' ? 'Leave No Trace' : 'All';
		const rootIcon = this._activeFilter === 'favorites' ? ICONS.starFilled : this._activeFilter === 'lnt' ? ICONS.shield : ICONS.kustoCluster;
		const schemaBusy = ep?.database ? this._isKustoSchemaBusy(conn, ep.database) : false;
		return html`
			<div class="explorer-breadcrumb">
				<button class="btn-icon breadcrumb-back" data-testid="cm-breadcrumb-back" title="Go back" @click=${() => this._navigateBack()}>${ICONS.arrowLeft}</button>
				<span class="breadcrumb-item" @click=${() => this._setKustoExplorerPath(null)}>
					<span class="breadcrumb-icon">${rootIcon}</span>${rootLabel}
				</span>
				<span class="breadcrumb-separator">/</span>
				<span class="breadcrumb-item ${!ep?.database ? 'current' : ''}" @click=${() => this._setKustoExplorerPath({ connectionId: conn.id })}>
					<span class="breadcrumb-icon">${ICONS.kustoCluster}</span>${conn.name}
				</span>
				${!ep?.database ? html`
					<button class="btn-icon breadcrumb-refresh" title="Refresh databases"
						@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'cluster.refreshDatabases', connectionId: conn.id }); }}>${this._loadingDatabases.has(conn.id) ? ICONS.spinner : ICONS.refresh}</button>
				` : nothing}
				${ep?.database ? html`
					<span class="breadcrumb-separator">/</span>
					<span class="breadcrumb-item ${!ep.section ? 'current' : ''}" @click=${() => this._setKustoExplorerPath({ ...ep, section: undefined, folderPath: undefined, tableName: undefined })}>
						<span class="breadcrumb-icon">${ICONS.database}</span>${ep.database}
					</span>
					${ep.section && ep.section !== 'table-columns' ? html`
						<span class="breadcrumb-separator">/</span>
						<span class="breadcrumb-item ${!ep.folderPath?.length ? 'current' : ''}" @click=${() => this._setKustoExplorerPath({ ...ep, folderPath: undefined })}>
							<span class="breadcrumb-icon">${ep.section === 'tables' ? ICONS.table : ICONS.function}</span>${ep.section === 'tables' ? 'Tables' : 'Functions'}
						</span>
						${(ep.folderPath ?? []).map((folder, i) => html`
							<span class="breadcrumb-separator">/</span>
							<span class="breadcrumb-item ${i === (ep.folderPath!.length - 1) ? 'current' : ''}"
								@click=${() => this._setKustoExplorerPath({ ...ep, folderPath: ep.folderPath!.slice(0, i + 1) })}>
								<span class="breadcrumb-icon">${ICONS.folder}</span>${folder}
							</span>
						`)}
					` : nothing}
					<button class="btn-icon breadcrumb-refresh" title="Refresh schema for ${ep.database}"
						@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'database.refreshSchema', connectionId: conn.id, clusterUrl: conn.clusterUrl, database: ep.database, source: 'breadcrumb' }); }}>${this._renderRefreshIcon(schemaBusy)}</button>
				` : nothing}
			</div>
		`;
	}

	private _renderExplorerContent(conn: KustoConnection, databases: string[], isLoading: boolean): TemplateResult {
		const ep = this._explorerPath;
		const databaseLoadError = this._databaseLoadErrors[conn.id] || '';

		// Level 1: databases
		if (!ep?.database) {
			if (isLoading) return html`<div class="loading-state">${ICONS.spinner} Loading databases...</div>`;

			// Filter databases when Favorites filter is active
			let visibleDbs = sortStringsAlphabetically(databases);
			if (this._activeFilter === 'favorites') {
				visibleDbs = visibleDbs.filter(db => this._getFavorite(conn.id, db));
			}

			if (visibleDbs.length === 0 && databaseLoadError) {return html`
				<div class="empty-state" data-testid="cm-database-load-error">
					<div class="empty-state-title">Could not load databases</div>
					<div class="empty-state-text">${databaseLoadError}</div>
					<button class="btn" @click=${() => this._vscode.postMessage({ type: 'cluster.refreshDatabases', connectionId: conn.id })}>Retry</button>
				</div>`;}

			if (visibleDbs.length === 0) {return html`
				<div class="empty-state" data-testid="cm-database-empty-state">
					<div class="empty-state-title">${this._activeFilter === 'favorites' ? 'No favorite databases' : 'No databases found'}</div>
					<div class="empty-state-text">${this._activeFilter === 'favorites' ? 'This cluster has no favorite databases under the current filter.' : 'No databases are cached for this cluster yet.'}</div>
					${this._activeFilter !== 'favorites' ? html`<button class="btn" @click=${() => this._vscode.postMessage({ type: 'cluster.refreshDatabases', connectionId: conn.id })}>Refresh</button>` : nothing}
				</div>`;}

			return html`${visibleDbs.map(db => {
				const favorite = this._getFavorite(conn.id, db);
				const isFav = !!favorite;
				const displayName = this._activeFilter === 'favorites' && favorite ? favorite.name : db;
				return html`
					<div class="explorer-list-item" @click=${() => this._navigateToDatabase(conn, db)}>
						<span class="explorer-list-item-icon database">${ICONS.database}</span>
						<span class="explorer-list-item-name">${displayName}</span>
						${this._activeFilter === 'favorites' && favorite ? html`
							<span class="item-sep">·</span>
							<span class="explorer-list-item-meta favorite-context">${db} · ${conn.name || shortClusterName(conn.clusterUrl)}</span>
						` : nothing}
						<div class="explorer-list-item-actions">
							${isFav ? html`
								<button class="btn-icon is-favorite-action" data-testid="cm-favorite-rename" title="Rename favorite"
									@click=${(e: Event) => { e.stopPropagation(); this._renameFavorite(conn, db); }}>${ICONS.edit}</button>
							` : nothing}
							<button class="btn-icon ${isFav ? 'is-favorite' : ''}" data-testid=${isFav ? 'cm-favorite-remove' : 'cm-favorite-add'} title="${isFav ? 'Remove from favorites' : 'Add to favorites'}"
								@click=${(e: Event) => { e.stopPropagation(); this._toggleFavorite(conn, db, isFav); }}>
								${isFav ? ICONS.starFilled : ICONS.star}
							</button>
							<button class="btn-icon" title="Refresh"
								@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'cluster.refreshDatabases', connectionId: conn.id }); }}>${ICONS.refresh}</button>
							<button class="btn-icon" title="Open in new .kqlx file"
								@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'database.openInNewFile', connectionId: conn.id, clusterUrl: conn.clusterUrl, database: db }); }}>${ICONS.newFile}</button>
						</div>
					</div>`;
			})}`;
		}

		// Level 2: tables/functions overview
		const dbKey = conn.id + '|' + ep.database;
		const schema = this._databaseSchemas[dbKey];
		const schemaLoadError = this._schemaLoadErrors[dbKey] || '';
		if (!schema && schemaLoadError) {
			return html`
			<div class="empty-state" data-testid="cm-schema-load-error">
				<div class="empty-state-title">Could not load schema</div>
				<div class="empty-state-text">${schemaLoadError}</div>
				<button class="btn" @click=${() => this._vscode.postMessage({ type: 'database.getSchema', connectionId: conn.id, database: ep.database })}>Retry</button>
			</div>`;
		}
		if (!schema) return html`<div class="loading-state">Loading schema...</div>`;

		if (!ep.section) {
			const tableCount = schema.tables?.length ?? 0;
			const fnCount = schema.functions?.length ?? 0;
			return html`
				${tableCount > 0 ? html`
					<div class="explorer-list-item" @click=${() => this._setKustoExplorerPath({ ...ep, section: 'tables', folderPath: [] })}>
						<span class="explorer-list-item-icon table">${ICONS.table}</span>
						<span class="explorer-list-item-name">Tables</span>
						<span class="explorer-list-item-meta">${tableCount}</span>
					</div>
				` : nothing}
				${fnCount > 0 ? html`
					<div class="explorer-list-item" @click=${() => this._setKustoExplorerPath({ ...ep, section: 'functions', folderPath: [] })}>
						<span class="explorer-list-item-icon function">${ICONS.function}</span>
						<span class="explorer-list-item-name">Functions</span>
						<span class="explorer-list-item-meta">${fnCount}</span>
					</div>
				` : nothing}
				${tableCount === 0 && fnCount === 0 ? html`<div class="empty-state"><div class="empty-state-text">No tables or functions found.</div></div>` : nothing}
			`;
		}

		// Level 3+: tables or functions with folder tree
		if (ep.section === 'tables') return this._renderTablesLevel(conn, schema, ep);
		if (ep.section === 'functions') return this._renderFunctionsLevel(schema, ep);

		return html`<div class="empty-state">Unknown section</div>`;
	}

	private _renderTablesLevel(conn: KustoConnection, schema: DatabaseSchema, ep: ExplorerPath): TemplateResult {
		const tableFolders = schema.tableFolders ?? {};
		const tree = this._buildFolderTree(schema.tables ?? [], t => tableFolders[t]);
		const currentNode = this._getTreeAtPath(tree, ep.folderPath ?? []);
		const folders = sortStringsAlphabetically(Object.keys(currentNode).filter(folderName => folderName !== '__items'));
		const tables = sortStringsAlphabetically((currentNode as { __items?: string[] }).__items);
		const dbKey = conn.id + '|' + ep.database;
		const schemaBusy = this._isKustoSchemaBusy(conn, ep.database);

		return html`
			${folders.map(f => {
				const childCount = this._countTreeItems(currentNode[f]);
				return html`
				<div class="explorer-list-item" @click=${() => this._setKustoExplorerPath({ ...ep, folderPath: [...(ep.folderPath ?? []), f] })}>
					<span class="explorer-list-item-icon folder">${ICONS.folder}</span>
					<span class="explorer-list-item-name">${f}</span>
					<span class="explorer-list-item-meta">${childCount} item${childCount !== 1 ? 's' : ''}</span>
				</div>`;
			})}
			${tables.map(table => {
				const cols = schema.columnTypesByTable?.[table] ?? {};
				const colNames = sortStringsAlphabetically(Object.keys(cols));
				const tableKey = dbKey + '|table|' + table;
				const isExpanded = this._expandedTables.has(tableKey);
				const docString = schema.tableDocStrings?.[table];
				const previewData = this._tablePreviewData[tableKey];

				return html`
					<div class="explorer-list-item-wrapper ${isExpanded ? 'expanded' : ''}">
						<div class="explorer-list-item" @click=${() => this._toggleTable(tableKey)}>
						<span class="explorer-list-item-chevron ${isExpanded ? 'expanded' : ''}">${ICONS.chevron}</span>
						<span class="explorer-list-item-icon table">${ICONS.table}</span>
							<span class="explorer-list-item-name">${table}</span>
							${colNames.length > 0 ? html`<span class="explorer-list-item-meta">${colNames.length} cols</span>` : nothing}
							<div class="explorer-list-item-actions">
								<button class="btn-icon" title="Refresh schema for ${ep.database}"
									@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'database.refreshSchema', connectionId: conn.id, clusterUrl: conn.clusterUrl, database: ep.database, source: 'table' }); }}>${this._renderRefreshIcon(schemaBusy)}</button>
							</div>
						</div>
						${isExpanded ? html`
							<div class="explorer-item-details">
								${docString ? html`<div class="explorer-detail-section"><div class="explorer-detail-label">Description</div><div class="explorer-detail-docstring">${docString}</div></div>` : nothing}
								${colNames.length > 0 ? html`
									<div class="explorer-detail-section">
										<div class="explorer-detail-label">Schema (${colNames.length} columns)</div>
										<div class="explorer-detail-schema">
											${colNames.map(col => this._renderKustoSchemaColumnRow(schema, table, col, cols[col]))}
										</div>
									</div>
								` : nothing}
								${this._renderTablePreview(tableKey, table, previewData, conn, ep)}
							</div>
						` : nothing}
					</div>`;
			})}
			${folders.length === 0 && tables.length === 0 ? html`<div class="empty-state"><div class="empty-state-text">No tables in this folder.</div></div>` : nothing}
		`;
	}

	private _renderFunctionsLevel(schema: DatabaseSchema, ep: ExplorerPath): TemplateResult {
		const fnTree = this._buildFolderTree(schema.functions ?? [], functionInfo => functionInfo.folder);
		const currentNode = this._getTreeAtPath(fnTree, ep.folderPath ?? []);
		const folders = sortStringsAlphabetically(Object.keys(currentNode).filter(folderName => folderName !== '__items'));
		const functions = sortByAlphabeticLabels((currentNode as { __items?: KustoFunctionInfo[] }).__items, functionInfo => [functionInfo.name]);
		const dbKey = (this._explorerPath?.connectionId ?? '') + '|' + ep.database;
		const conn = this._snapshot?.connections?.find(c => c.id === this._explorerPath?.connectionId);
		const schemaBusy = conn ? this._isKustoSchemaBusy(conn, ep.database) : false;

		return html`
			${folders.map(f => {
				const childCount = this._countTreeItems(currentNode[f]);
				return html`
				<div class="explorer-list-item" @click=${() => this._setKustoExplorerPath({ ...ep, folderPath: [...(ep.folderPath ?? []), f] })}>
					<span class="explorer-list-item-icon folder">${ICONS.folder}</span>
					<span class="explorer-list-item-name">${f}</span>
					<span class="explorer-list-item-meta">${childCount} item${childCount !== 1 ? 's' : ''}</span>
				</div>`;
			})}
			${functions.map(fn => {
				const fnKey = dbKey + '|fn|' + fn.name;
				const isExpanded = this._expandedFunctions.has(fnKey);
				return html`
					<div class="explorer-list-item-wrapper ${isExpanded ? 'expanded' : ''}">
						<div class="explorer-list-item" @click=${() => this._toggleFunction(fnKey)} title="${fn.name}${fn.parametersText ? '(' + fn.parametersText + ')' : ' (no parameters)'}">
							<span class="explorer-list-item-chevron ${isExpanded ? 'expanded' : ''}">${ICONS.chevron}</span>
							<span class="explorer-list-item-icon function">${ICONS.function}</span>
							<span class="explorer-list-item-name">${fn.name}</span>
							${fn.parametersText ? html`<span class="explorer-list-item-params">(${fn.parametersText})</span>` : nothing}
							<div class="explorer-list-item-actions">
								<button class="btn-icon" title="Refresh schema for ${ep.database}"
									@click=${(e: Event) => { if (!conn) return; e.stopPropagation(); this._vscode.postMessage({ type: 'database.refreshSchema', connectionId: conn.id, clusterUrl: conn.clusterUrl, database: ep.database, source: 'function' }); }}>${this._renderRefreshIcon(schemaBusy)}</button>
							</div>
						</div>
						${isExpanded ? html`
							<div class="explorer-item-details">
								${fn.docString ? html`<div class="explorer-detail-section"><div class="explorer-detail-label">Description</div><div class="explorer-detail-docstring">${fn.docString}</div></div>` : nothing}
								<div class="explorer-detail-section"><div class="explorer-detail-label">Signature</div><div class="explorer-detail-code">${fn.name}(${fn.parametersText || ''})</div></div>
								${fn.body ? html`<div class="explorer-detail-section"><div class="explorer-detail-label">Implementation</div><pre class="explorer-detail-body">${this._trimFnBody(fn.body)}</pre></div>` : nothing}
							</div>
						` : nothing}
					</div>`;
			})}
			${folders.length === 0 && functions.length === 0 ? html`<div class="empty-state"><div class="empty-state-text">No functions in this folder.</div></div>` : nothing}
		`;
	}

	private _renderTablePreview(tableKey: string, tableName: string, data: TablePreview | undefined, conn: KustoConnection, ep: ExplorerPath): TemplateResult {
		if (data?.loading) return html`<div class="explorer-detail-section"><div class="preview-action loading">${ICONS.spinner} Loading preview…</div></div>`;
		if (data?.error) {return html`
			<div class="explorer-detail-section">
				<div class="preview-error">${data.error}</div>
				<button class="preview-action" @click=${() => this._vscode.postMessage({ type: 'table.preview', connectionId: conn.id, database: ep.database, tableName })}>${ICONS.table} Retry preview</button>
			</div>`;}
		if (data?.columns && data?.rows) {
			if (data.rows.length === 0) return html`<div class="explorer-detail-section"><div style="font-size: 11px; opacity: 0.7; padding: 4px 0; display: flex; align-items: center; gap: 6px;">Table is empty. <button class="btn-icon breadcrumb-refresh" title="Refresh preview" @click=${() => this._vscode.postMessage({ type: 'table.preview', connectionId: conn.id, database: ep.database, tableName })}>${ICONS.refresh}</button></div></div>`;
			const dtColumns = data.columns.map((c: any) => ({ name: typeof c === 'string' ? c : c.name ?? '', type: typeof c === 'object' ? c.type : undefined }));
			const tableHeight = Math.min(500, 90 + data.rows.length * 24);
			return html`
				<div class="explorer-detail-section">
					<div class="preview-result">
						<div class="preview-result-header">
							<span class="preview-result-info">PREVIEW TOP 100 ROWS</span>
							<div class="preview-result-actions">
								<button class="preview-result-dismiss" title="Refresh preview" @click=${() => this._vscode.postMessage({ type: 'table.preview', connectionId: conn.id, database: ep.database, tableName })}>${ICONS.refresh}</button>
								<button class="preview-result-dismiss" title="Dismiss" @click=${() => { const next = { ...this._tablePreviewData }; delete next[tableKey]; this._tablePreviewData = next; }}>${ICONS.close}</button>
							</div>
						</div>
						<div class="preview-table-container">
							<kw-data-table style="height:${tableHeight}px"
								.columns=${dtColumns}
								.rows=${data.rows as any}
								.options=${{ compact: true, showExecutionTime: true, executionTime: data.executionTime }}
								@save=${(e: CustomEvent) => { this._vscode.postMessage({ type: 'saveResultsCsv', csv: e.detail.csv, suggestedFileName: e.detail.suggestedFileName }); }}
							></kw-data-table>
						</div>
					</div>
				</div>`;
		}
		return html`
			<div class="explorer-detail-section">
				<button class="preview-action" @click=${() => this._vscode.postMessage({ type: 'table.preview', connectionId: conn.id, database: ep.database, tableName })}>${ICONS.table} Preview top 100 rows</button>
			</div>`;
	}

	private _getKustoColumnDocString(schema: DatabaseSchema, table: string, column: string): string {
		const docs = schema.columnDocStrings ?? {};
		const exactKey = `${table}.${column}`;
		const exact = docs[exactKey];
		if (exact) return exact;
		const lowerKey = exactKey.toLowerCase();
		const matchedKey = Object.keys(docs).find(key => key.toLowerCase() === lowerKey);
		return matchedKey ? docs[matchedKey] : '';
	}

	private _renderKustoSchemaColumnRow(schema: DatabaseSchema, table: string, column: string, columnType: string): TemplateResult {
		const docString = this._getKustoColumnDocString(schema, table, column);
		return html`
			<div class="explorer-schema-row ${docString ? 'has-doc' : ''}">
				<span class="explorer-schema-col-main">
					<span class="explorer-schema-col-header">
						<span class="explorer-schema-col-name">${column}</span>
						${columnType ? html`<span class="explorer-schema-col-type">(${columnType})</span>` : nothing}
					</span>
					${docString ? html`<span class="explorer-schema-col-doc">${docString}</span>` : nothing}
				</span>
			</div>
		`;
	}

	// ── SQL Content ───────────────────────────────────────────────────────────

	private _renderSqlContent(): TemplateResult {
		const sqlConnections = sortSqlConnections(this._snapshot?.sqlConnections);
		const sqlFavorites = this._snapshot?.sqlFavorites ?? [];
		const sqlLntIds = this._snapshot?.sqlLeaveNoTrace ?? [];
		const hasFavs = sqlFavorites.length > 0;
		const hasLnt = sqlLntIds.length > 0;
		const favConnIds = new Set(sqlFavorites.map(f => f.connectionId));
		const lntSet = new Set(sqlLntIds);
		const af = this._activeFilter;

		// Apply filters
		let visibleConnections = sqlConnections;
		if (af === 'favorites') {
			visibleConnections = sqlConnections.filter(c => favConnIds.has(c.id));
		}
		if (af === 'lnt') {
			visibleConnections = visibleConnections.filter(c => lntSet.has(c.id));
		}

		const ep = this._sqlExplorerPath;

		return html`
			<!-- Filter tabs (always visible) -->
			<div class="filter-bar" data-testid="cm-sql-filter-bar">
				<button class="filter-tab ${af === 'all' ? 'active' : ''}" data-testid="cm-sql-filter-all" @click=${() => this._setSqlFilter('all')}>${ICONS.sqlServer} <span class="filter-label">All</span></button>
				${hasFavs ? html`<button class="filter-tab fav-tab ${af === 'favorites' ? 'active' : ''}" data-testid="cm-sql-filter-favorites" @click=${() => this._setSqlFilter(af === 'favorites' ? 'all' : 'favorites')}>${ICONS.starFilled} <span class="filter-label">Favorites</span> <span class="filter-count">${sqlFavorites.length}</span></button>` : nothing}
				${hasLnt ? html`<button class="filter-tab lnt-tab ${af === 'lnt' ? 'active' : ''}" @click=${() => this._setSqlFilter(af === 'lnt' ? 'all' : 'lnt')}>${ICONS.shield} <span class="filter-label">Leave No Trace</span> <span class="filter-count">${sqlLntIds.length}</span></button>` : nothing}
				<button class="filter-tab search-tab ${af === 'search' ? 'active' : ''}" data-testid="cm-sql-filter-search" @click=${() => this._setSqlFilter(af === 'search' ? 'all' : 'search')}>${ICONS.toolbarSearch} <span class="filter-label">Search</span></button>
			</div>

			${af === 'search' ? this._renderSearchContent() : html`
				<!-- SQL Breadcrumb -->
				${ep?.connectionId ? this._renderSqlBreadcrumb() : nothing}

				<!-- SQL Explorer content -->
				<div class="explorer-content" data-overlay-scroll="x:hidden">
					${ep?.connectionId ? this._renderSqlDrilledContent() : this._renderSqlConnectionList(visibleConnections, favConnIds, lntSet)}
				</div>
			`}
		`;

	}

	private _renderSqlConnectionList(connections: SqlConnectionInfo[], favConnIds: Set<string>, lntSet: Set<string>): TemplateResult {
		if (connections.length === 0) {
			const hasFilter = this._activeFilter === 'favorites' || this._activeFilter === 'lnt';
			return html`<div class="empty-state">
				<div class="empty-state-icon">${ICONS.sqlServer}</div>
				<div class="empty-state-title">${hasFilter ? 'No matching connections' : 'No SQL connections yet'}</div>
				<div class="empty-state-text">${hasFilter ? 'Try removing the filter.' : 'Add a SQL Server connection to get started.'}</div>
			</div>`;
		}

		return html`${connections.map(conn => {
			const dbCount = this._snapshot?.sqlCachedDatabases?.[conn.id]?.length ?? 0;
			const authLabel = conn.authType === 'aad' ? 'AAD' : 'SQL Login';
			const hasFav = favConnIds.has(conn.id);
			const isLnt = lntSet.has(conn.id);
			return html`
				<div class="explorer-list-item root-connection-row" @click=${() => this._drillIntoSqlConnection(conn.id)}>
					<span class="explorer-list-item-icon server">${ICONS.sqlServer}</span>
					<span class="explorer-list-item-name">${conn.name || conn.serverUrl}</span>
					${hasFav ? html`<span class="conn-badge fav-badge" title="Has favorites">${ICONS.starFilled}</span>` : nothing}
					${isLnt ? html`<span class="conn-badge lnt-badge" title="Leave No Trace">${ICONS.shield}</span>` : nothing}
					<span class="item-sep">·</span>
					<span class="explorer-list-item-url">${conn.serverUrl}${conn.port ? ':' + conn.port : ''}</span>
					<span class="item-sep">·</span>
					<span class="explorer-list-item-meta">${authLabel}${dbCount > 0 ? ` · ${dbCount} db${dbCount !== 1 ? 's' : ''}` : ''}</span>
					<div class="explorer-list-item-actions">
						<button class="btn-icon ${isLnt ? 'is-lnt' : ''}" title="${isLnt ? 'Remove from Leave No Trace' : 'Add to Leave No Trace'}"
							@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: isLnt ? 'sql.leaveNoTrace.remove' : 'sql.leaveNoTrace.add', connectionId: conn.id }); }}>${ICONS.shield}</button>
						<button class="btn-icon" title="Edit" @click=${(e: Event) => { e.stopPropagation(); this._openModal('edit', conn.id); }}>${ICONS.edit}</button>
						<button class="btn-icon" title="Refresh" @click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'sql.cluster.refreshDatabases', connectionId: conn.id }); }}>${ICONS.refresh}</button>
						<button class="btn-icon" title="Delete" @click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'sql.connection.delete', id: conn.id }); }}>${ICONS.delete}</button>
					</div>
				</div>`;
		})}`;
	}

	private _drillIntoSqlConnection(connId: string): void {
		this._setSqlExplorerPath({ connectionId: connId });
		this._vscode.postMessage({ type: 'sql.cluster.expand', connectionId: connId });
	}

	private _renderSqlBreadcrumb(): TemplateResult {
		const ep = this._sqlExplorerPath;
		if (!ep) return html``;
		const conn = (this._snapshot?.sqlConnections ?? []).find(c => c.id === ep.connectionId);
		if (!conn) return html``;
		const rootLabel = this._activeFilter === 'favorites' ? 'Favorites' : this._activeFilter === 'lnt' ? 'Leave No Trace' : 'All';
		const rootIcon = this._activeFilter === 'favorites' ? ICONS.starFilled : this._activeFilter === 'lnt' ? ICONS.shield : ICONS.sqlServer;
		const schemaBusy = ep.database ? this._isSqlSchemaBusy(conn.id, ep.database) : false;

		return html`
			<div class="explorer-breadcrumb">
				<button class="btn-icon breadcrumb-back" data-testid="cm-sql-breadcrumb-back" title="Go back" @click=${() => this._navigateSqlBack()}>${ICONS.arrowLeft}</button>
				<span class="breadcrumb-item" @click=${() => this._setSqlExplorerPath(null)}>
					<span class="breadcrumb-icon">${rootIcon}</span>${rootLabel}
				</span>
				<span class="breadcrumb-separator">/</span>
				<span class="breadcrumb-item ${!ep.database ? 'current' : ''}" @click=${() => this._setSqlExplorerPath({ connectionId: conn.id })}>
					<span class="breadcrumb-icon">${ICONS.sqlServer}</span>${conn.name}
				</span>
				${!ep.database ? html`
					<button class="btn-icon breadcrumb-refresh" title="Refresh databases"
						@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'sql.cluster.refreshDatabases', connectionId: conn.id }); }}>${this._sqlLoadingDatabases.has(conn.id) ? ICONS.spinner : ICONS.refresh}</button>
				` : nothing}
				${ep.database ? html`
					<span class="breadcrumb-separator">/</span>
					<span class="breadcrumb-item ${!ep.section ? 'current' : ''}" @click=${() => this._setSqlExplorerPath({ ...ep, section: undefined, folderPath: undefined })}>
						<span class="breadcrumb-icon">${ICONS.database}</span>${ep.database}
					</span>
					${ep.section === 'tables' ? html`
						<span class="breadcrumb-separator">/</span>
						<span class="breadcrumb-item current">
							<span class="breadcrumb-icon">${ICONS.table}</span>Tables
						</span>
					` : nothing}
					${ep.section === 'views' ? html`
						<span class="breadcrumb-separator">/</span>
						<span class="breadcrumb-item current">
							<span class="breadcrumb-icon">${ICONS.table}</span>Views
						</span>
					` : nothing}
					${ep.section === 'functions' ? html`
						<span class="breadcrumb-separator">/</span>
						<span class="breadcrumb-item current">
							<span class="breadcrumb-icon">${ICONS.function}</span>Stored Procedures
						</span>
					` : nothing}
					<button class="btn-icon breadcrumb-refresh" title="Refresh schema for ${ep.database}"
						@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'sql.database.refreshSchema', connectionId: conn.id, database: ep.database, source: 'breadcrumb' }); }}>${this._renderRefreshIcon(schemaBusy)}</button>
				` : nothing}
			</div>
		`;
	}

	private _renderSqlDrilledContent(): TemplateResult {
		const ep = this._sqlExplorerPath;
		if (!ep) return html``;
		const conn = (this._snapshot?.sqlConnections ?? []).find(c => c.id === ep.connectionId);
		if (!conn) return html`<div class="empty-state"><div class="empty-state-text">Connection not found.</div></div>`;

		const databases = this._snapshot?.sqlCachedDatabases?.[conn.id] ?? [];
		const isLoading = this._sqlLoadingDatabases.has(conn.id);
		const databaseLoadError = this._sqlDatabaseLoadErrors[conn.id] || '';

		// Level 1: databases
		if (!ep.database) {
			if (isLoading) return html`<div class="loading-state">${ICONS.spinner} Loading databases...</div>`;

			// Filter databases when Favorites filter is active
			let visibleDbs = sortStringsAlphabetically(databases);
			if (this._activeFilter === 'favorites') {
				visibleDbs = visibleDbs.filter(db => this._getSqlFavorite(conn.id, db));
			}

			if (visibleDbs.length === 0 && databaseLoadError) {
				return html`<div class="empty-state" data-testid="cm-sql-database-load-error">
					<div class="empty-state-title">Could not load databases</div>
					<div class="empty-state-text">${databaseLoadError}</div>
					<button class="btn" @click=${() => this._vscode.postMessage({ type: 'sql.cluster.refreshDatabases', connectionId: conn.id })}>Retry</button>
				</div>`;
			}

			if (visibleDbs.length === 0) {
				return html`<div class="empty-state" data-testid="cm-sql-database-empty-state">
					<div class="empty-state-title">${this._activeFilter === 'favorites' ? 'No favorite databases' : 'No databases found'}</div>
					<div class="empty-state-text">${this._activeFilter === 'favorites' ? 'This connection has no favorite databases under the current filter.' : 'No databases are cached for this connection yet.'}</div>
					${this._activeFilter !== 'favorites' ? html`<button class="btn" @click=${() => this._vscode.postMessage({ type: 'sql.cluster.refreshDatabases', connectionId: conn.id })}>Refresh</button>` : nothing}
				</div>`;
			}
			return html`${visibleDbs.map(db => {
				const favorite = this._getSqlFavorite(conn.id, db);
				const isFav = !!favorite;
				const displayName = this._activeFilter === 'favorites' && favorite ? favorite.name : db;
				return html`
					<div class="explorer-list-item" @click=${() => this._navigateToSqlDatabase(conn, db)}>
						<span class="explorer-list-item-icon database">${ICONS.database}</span>
						<span class="explorer-list-item-name">${displayName}</span>
						${this._activeFilter === 'favorites' && favorite ? html`
							<span class="item-sep">·</span>
							<span class="explorer-list-item-meta favorite-context">${db} · ${conn.name || conn.serverUrl}</span>
						` : nothing}
						<div class="explorer-list-item-actions">
							${isFav ? html`
								<button class="btn-icon is-favorite-action" data-testid="cm-sql-favorite-rename" title="Rename favorite"
									@click=${(e: Event) => { e.stopPropagation(); this._renameSqlFavorite(conn, db); }}>${ICONS.edit}</button>
							` : nothing}
							<button class="btn-icon ${isFav ? 'is-favorite' : ''}" data-testid=${isFav ? 'cm-sql-favorite-remove' : 'cm-sql-favorite-add'} title="${isFav ? 'Remove from favorites' : 'Add to favorites'}"
								@click=${(e: Event) => { e.stopPropagation(); this._toggleSqlFavorite(conn, db, isFav); }}>
								${isFav ? ICONS.starFilled : ICONS.star}
							</button>
							<button class="btn-icon" title="Refresh" @click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'sql.cluster.refreshDatabases', connectionId: conn.id }); }}>${ICONS.refresh}</button>
							<button class="btn-icon" title="Open in new .sqlx file" @click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'sql.database.openInNewFile', connectionId: conn.id, database: db }); }}>${ICONS.newFile}</button>
						</div>
					</div>`;
			})}`;
		}

		// Level 2: tables overview
		const dbKey = conn.id + '|' + ep.database;
		const schema = this._sqlDatabaseSchemas[dbKey];
		const schemaLoadError = this._sqlSchemaLoadErrors[dbKey] || '';
		if (!schema && schemaLoadError) {
			return html`
			<div class="empty-state" data-testid="cm-sql-schema-load-error">
				<div class="empty-state-title">Could not load schema</div>
				<div class="empty-state-text">${schemaLoadError}</div>
				<button class="btn" @click=${() => this._vscode.postMessage({ type: 'sql.database.getSchema', connectionId: conn.id, database: ep.database })}>Retry</button>
			</div>`;
		}
		if (!schema) return html`<div class="loading-state">Loading schema...</div>`;

		if (!ep.section) {
			const tableCount = schema.tables?.length ?? 0;
			const viewCount = schema.views?.length ?? 0;
			const spCount = schema.storedProcedures?.length ?? 0;
			return html`
				${tableCount > 0 ? html`
					<div class="explorer-list-item" @click=${() => this._setSqlExplorerPath({ ...ep, section: 'tables' })}>
						<span class="explorer-list-item-icon table">${ICONS.table}</span>
						<span class="explorer-list-item-name">Tables</span>
						<span class="explorer-list-item-meta">${tableCount}</span>
					</div>
				` : nothing}
				${viewCount > 0 ? html`
					<div class="explorer-list-item" @click=${() => this._setSqlExplorerPath({ ...ep, section: 'views' })}>
						<span class="explorer-list-item-icon table">${ICONS.table}</span>
						<span class="explorer-list-item-name">Views</span>
						<span class="explorer-list-item-meta">${viewCount}</span>
					</div>
				` : nothing}
				${spCount > 0 ? html`
					<div class="explorer-list-item" @click=${() => this._setSqlExplorerPath({ ...ep, section: 'functions' })}>
						<span class="explorer-list-item-icon function">${ICONS.function}</span>
						<span class="explorer-list-item-name">Stored Procedures</span>
						<span class="explorer-list-item-meta">${spCount}</span>
					</div>
				` : nothing}
				${tableCount === 0 && viewCount === 0 && spCount === 0 ? html`<div class="empty-state"><div class="empty-state-text">No tables, views, or stored procedures found.</div></div>` : nothing}
			`;
		}

		// Level 3: table list with expandable columns
		if (ep.section === 'tables') {
			return this._renderSqlTablesLevel(conn, schema, ep);
		}

		// Level 3: views (same rendering as tables)
		if (ep.section === 'views') {
			return this._renderSqlViewsLevel(conn, schema, ep);
		}

		// Level 3: stored procedures
		if (ep.section === 'functions') {
			return this._renderSqlStoredProcedures(schema, ep);
		}

		return html`<div class="empty-state">Unknown section</div>`;
	}

	private _navigateToSqlDatabase(conn: SqlConnectionInfo, db: string): void {
		this._setSqlExplorerPath({ connectionId: conn.id, database: db });
		const dbKey = conn.id + '|' + db;
		if (!this._sqlDatabaseSchemas[dbKey]) {
			this._vscode.postMessage({ type: 'sql.database.getSchema', connectionId: conn.id, database: db });
		}
	}

	private _getSqlFavorite(connectionId: string, database: string): SqlFavorite | undefined {
		if (!this._snapshot?.sqlFavorites) return undefined;
		const nDb = String(database || '').trim().toLowerCase();
		return this._snapshot.sqlFavorites.find(f => f.connectionId === connectionId && String(f.database || '').trim().toLowerCase() === nDb);
	}

	private _toggleSqlFavorite(conn: SqlConnectionInfo, db: string, isFav: boolean): void {
		if (isFav) {
			this._vscode.postMessage({ type: 'sql.favorite.remove', connectionId: conn.id, database: db });
		} else {
			this._vscode.postMessage({ type: 'sql.favorite.promptAdd', connectionId: conn.id, database: db });
		}
	}

	private _renameSqlFavorite(conn: SqlConnectionInfo, db: string): void {
		const favorite = this._getSqlFavorite(conn.id, db);
		if (!favorite) return;
		this._vscode.postMessage({ type: 'sql.favorite.promptRename', connectionId: favorite.connectionId, database: favorite.database });
	}

	/** Trim SQL breadcrumb depth so it stays valid when a filter changes. */
	private _validateSqlBreadcrumb(): void {
		const ep = this._sqlExplorerPath;
		if (!ep?.connectionId) return;

		const connections = this._snapshot?.sqlConnections ?? [];
		const conn = connections.find(c => c.id === ep.connectionId);
		if (!conn) { this._setSqlExplorerPath(null); return; }

		if (this._activeFilter === 'favorites') {
			const favConnIds = new Set((this._snapshot?.sqlFavorites ?? []).map(f => f.connectionId));
			if (!favConnIds.has(conn.id)) { this._setSqlExplorerPath(null); return; }
			if (ep.database) {
				if (!this._getSqlFavorite(conn.id, ep.database)) { this._setSqlExplorerPath({ connectionId: ep.connectionId }); return; }
			}
		}
		if (this._activeFilter === 'lnt') {
			const lntSet = new Set(this._snapshot?.sqlLeaveNoTrace ?? []);
			if (!lntSet.has(conn.id)) { this._setSqlExplorerPath(null); return; }
		}
	}

	private _renderSqlTablesLevel(conn: SqlConnectionInfo, schema: SqlDatabaseSchema, ep: ExplorerPath): TemplateResult {
		const tables = sortStringsAlphabetically(schema.tables);
		const dbKey = conn.id + '|' + ep.database;
		const schemaBusy = this._isSqlSchemaBusy(conn.id, ep.database);

		return html`
			${tables.map(table => {
				const cols = schema.columnsByTable?.[table] ?? {};
				const colNames = sortStringsAlphabetically(Object.keys(cols));
				const tableKey = dbKey + '|table|' + table;
				const isExpanded = this._expandedTables.has(tableKey);
				const previewData = this._sqlTablePreviewData[tableKey];

				return html`
					<div class="explorer-list-item-wrapper ${isExpanded ? 'expanded' : ''}">
						<div class="explorer-list-item" @click=${() => this._toggleTable(tableKey)}>
							<span class="explorer-list-item-chevron ${isExpanded ? 'expanded' : ''}">${ICONS.chevron}</span>
							<span class="explorer-list-item-icon table">${ICONS.table}</span>
							<span class="explorer-list-item-name">${table}</span>
							${colNames.length > 0 ? html`<span class="explorer-list-item-meta">${colNames.length} cols</span>` : nothing}
							<div class="explorer-list-item-actions">
								<button class="btn-icon" title="Refresh schema for ${ep.database}"
									@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'sql.database.refreshSchema', connectionId: conn.id, database: ep.database }); }}>${this._renderRefreshIcon(schemaBusy)}</button>
							</div>
						</div>
						${isExpanded ? html`
							<div class="explorer-item-details">
								${colNames.length > 0 ? html`
									<div class="explorer-detail-section">
										<div class="explorer-detail-label">Schema (${colNames.length} columns)</div>
										<div class="explorer-detail-schema">
											${colNames.map(col => this._renderKustoSchemaColumnRow(schema, table, col, cols[col]))}
										</div>
									</div>
								` : nothing}
								${this._renderSqlTablePreview(tableKey, table, previewData, conn, ep)}
							</div>
						` : nothing}
					</div>`;
			})}
			${tables.length === 0 ? html`<div class="empty-state"><div class="empty-state-text">No tables found.</div></div>` : nothing}
		`;
	}

	private _renderSqlViewsLevel(conn: SqlConnectionInfo, schema: SqlDatabaseSchema, ep: ExplorerPath): TemplateResult {
		const views = sortStringsAlphabetically(schema.views);
		const dbKey = conn.id + '|' + ep.database;
		const schemaBusy = this._isSqlSchemaBusy(conn.id, ep.database);

		return html`
			${views.map(view => {
				const cols = schema.columnsByTable?.[view] ?? {};
				const colNames = sortStringsAlphabetically(Object.keys(cols));
				const viewKey = dbKey + '|table|' + view;
				const isExpanded = this._expandedTables.has(viewKey);
				const previewData = this._sqlTablePreviewData[viewKey];

				return html`
					<div class="explorer-list-item-wrapper ${isExpanded ? 'expanded' : ''}">
						<div class="explorer-list-item" @click=${() => this._toggleTable(viewKey)}>
							<span class="explorer-list-item-chevron ${isExpanded ? 'expanded' : ''}">${ICONS.chevron}</span>
							<span class="explorer-list-item-icon table">${ICONS.table}</span>
							<span class="explorer-list-item-name">${view}</span>
							${colNames.length > 0 ? html`<span class="explorer-list-item-meta">${colNames.length} cols</span>` : nothing}
							<div class="explorer-list-item-actions">
								<button class="btn-icon" title="Refresh schema for ${ep.database}"
									@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'sql.database.refreshSchema', connectionId: conn.id, database: ep.database, source: 'view' }); }}>${this._renderRefreshIcon(schemaBusy)}</button>
							</div>
						</div>
						${isExpanded ? html`
							<div class="explorer-item-details">
								${colNames.length > 0 ? html`
									<div class="explorer-detail-section">
										<div class="explorer-detail-label">Schema (${colNames.length} columns)</div>
										<div class="explorer-detail-schema">
											${colNames.map(col => html`
												<div class="explorer-schema-row">
													<span class="explorer-schema-col-name">${col}</span>
													<span class="explorer-schema-col-type">${cols[col]}</span>
												</div>
											`)}
										</div>
									</div>
								` : nothing}
								${this._renderSqlTablePreview(viewKey, view, previewData, conn, ep)}
							</div>
						` : nothing}
					</div>`;
			})}
			${views.length === 0 ? html`<div class="empty-state"><div class="empty-state-text">No views found.</div></div>` : nothing}
		`;
	}

	private _renderSqlStoredProcedures(schema: SqlDatabaseSchema, ep: ExplorerPath): TemplateResult {
		const procedures = sortByAlphabeticLabels(schema.storedProcedures, storedProcedure => [storedProcedure.name]);
		const dbKey = (this._sqlExplorerPath?.connectionId ?? '') + '|' + ep.database;
		const connectionId = this._sqlExplorerPath?.connectionId ?? '';
		const schemaBusy = this._isSqlSchemaBusy(connectionId, ep.database);

		return html`
			${procedures.map(sp => {
				const spKey = dbKey + '|fn|' + sp.name;
				const isExpanded = this._expandedFunctions.has(spKey);
				return html`
					<div class="explorer-list-item-wrapper ${isExpanded ? 'expanded' : ''}">
						<div class="explorer-list-item" @click=${() => this._toggleFunction(spKey)} title="${sp.name}${sp.parametersText ? '(' + sp.parametersText + ')' : ''}">
							<span class="explorer-list-item-chevron ${isExpanded ? 'expanded' : ''}">${ICONS.chevron}</span>
							<span class="explorer-list-item-icon function">${ICONS.function}</span>
							<span class="explorer-list-item-name">${sp.name}</span>
							${sp.parametersText ? html`<span class="explorer-list-item-params">(${sp.parametersText})</span>` : nothing}
							<div class="explorer-list-item-actions">
								<button class="btn-icon" title="Refresh schema for ${ep.database}"
									@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'sql.database.refreshSchema', connectionId, database: ep.database, source: 'stored procedure' }); }}>${this._renderRefreshIcon(schemaBusy)}</button>
							</div>
						</div>
						${isExpanded ? html`
							<div class="explorer-item-details">
								<div class="explorer-detail-section"><div class="explorer-detail-label">Signature</div><div class="explorer-detail-code">${sp.name}(${sp.parametersText || ''})</div></div>
								${sp.body ? html`<div class="explorer-detail-section"><div class="explorer-detail-label">Implementation</div><pre class="explorer-detail-body">${sp.body}</pre></div>` : nothing}
							</div>
						` : nothing}
					</div>`;
			})}
			${procedures.length === 0 ? html`<div class="empty-state"><div class="empty-state-text">No stored procedures found.</div></div>` : nothing}
		`;
	}

	private _renderSqlTablePreview(tableKey: string, tableName: string, data: TablePreview | undefined, conn: SqlConnectionInfo, ep: ExplorerPath): TemplateResult {
		if (data?.loading) return html`<div class="explorer-detail-section"><div class="preview-action loading">${ICONS.spinner} Loading preview…</div></div>`;
		if (data?.error) {
			return html`
				<div class="explorer-detail-section">
					<div class="preview-error">${data.error}</div>
					<button class="preview-action" @click=${() => this._vscode.postMessage({ type: 'sql.table.preview', connectionId: conn.id, database: ep.database, tableName })}>${ICONS.table} Retry preview</button>
				</div>`;
		}
		if (data?.columns && data?.rows) {
			if (data.rows.length === 0) return html`<div class="explorer-detail-section"><div style="font-size: 11px; opacity: 0.7; padding: 4px 0; display: flex; align-items: center; gap: 6px;">Table is empty. <button class="btn-icon breadcrumb-refresh" title="Refresh preview" @click=${() => this._vscode.postMessage({ type: 'sql.table.preview', connectionId: conn.id, database: ep.database, tableName })}>${ICONS.refresh}</button></div></div>`;
			const dtColumns = data.columns.map((c: any) => ({ name: typeof c === 'string' ? c : c.name ?? '', type: typeof c === 'object' ? c.type : undefined }));
			const sqlTableHeight = Math.min(500, 90 + data.rows.length * 24);
			return html`
				<div class="explorer-detail-section">
					<div class="preview-result">
						<div class="preview-result-header">
							<span class="preview-result-info">PREVIEW TOP 100 ROWS</span>
							<div class="preview-result-actions">
								<button class="preview-result-dismiss" title="Refresh preview" @click=${() => this._vscode.postMessage({ type: 'sql.table.preview', connectionId: conn.id, database: ep.database, tableName })}>${ICONS.refresh}</button>
								<button class="preview-result-dismiss" title="Dismiss" @click=${() => { const next = { ...this._sqlTablePreviewData }; delete next[tableKey]; this._sqlTablePreviewData = next; }}>${ICONS.close}</button>
							</div>
						</div>
						<div class="preview-table-container">
							<kw-data-table style="height:${sqlTableHeight}px"
								.columns=${dtColumns}
								.rows=${data.rows as any}
								.options=${{ compact: true, showExecutionTime: true, executionTime: data.executionTime }}
								@save=${(e: CustomEvent) => { this._vscode.postMessage({ type: 'saveResultsCsv', csv: e.detail.csv, suggestedFileName: e.detail.suggestedFileName }); }}
							></kw-data-table>
						</div>
					</div>
				</div>`;
		}
		return html`
			<div class="explorer-detail-section">
				<button class="preview-action" @click=${() => this._vscode.postMessage({ type: 'sql.table.preview', connectionId: conn.id, database: ep.database, tableName })}>${ICONS.table} Preview top 100 rows</button>
			</div>`;
	}

	// ── Modal ─────────────────────────────────────────────────────────────────

	private _renderModal(): TemplateResult {
		return this._activeKind === 'sql' ? this._renderSqlModal() : this._renderKustoModal();
	}

	private _renderKustoModal(): TemplateResult {
		return html`
			<div class="modal-overlay" data-testid="cm-modal-overlay" @click=${() => this._closeModal()} @keydown=${this._onModalKeydown}>
				<div class="modal-content" data-testid="cm-modal-content" role="dialog" aria-modal="true" aria-labelledby="cm-kusto-modal-title" @click=${(e: Event) => e.stopPropagation()}>
					<div class="modal-header">
						<h2 id="cm-kusto-modal-title">${this._modalMode === 'edit' ? 'Edit Connection' : 'Add Connection'}</h2>
						<button class="btn-icon" data-testid="cm-modal-close" title="Close" aria-label="Close" @click=${() => this._closeModal()}>${ICONS.close}</button>
					</div>
					<div class="modal-body">
						<kw-kusto-connection-form
							.mode=${this._modalMode}
							.name=${this._modalName}
							.clusterUrl=${this._modalUrl}
							.database=${this._modalDb}
							.authorityId=${this._modalAuthorityId}
							.accountId=${this._modalAccountId}
							.accounts=${this._snapshot?.accounts ?? []}
							.showTestButton=${true}
							.testResult=${this._testResult}
							@connection-form-submit=${this._onKustoFormSubmit}
							@connection-form-cancel=${() => this._closeModal()}
							@connection-form-test=${this._testConnection}
						></kw-kusto-connection-form>
					</div>
					<div class="modal-footer">
						<button class="btn" data-testid="cm-modal-cancel" @click=${() => this._closeModal()}>Cancel</button>
						<button class="btn primary" data-testid="cm-modal-save" @click=${() => this._submitKustoForm()}>Save</button>
					</div>
				</div>
			</div>
		`;
	}

	private _renderSqlModal(): TemplateResult {
		const dialects = this._snapshot?.sqlDialects ?? [];
		const isEditing = !!this._editingConnectionId;

		return html`
			<div class="modal-overlay" data-testid="cm-modal-overlay" @click=${() => this._closeModal()}>
				<div class="modal-content" data-testid="cm-modal-content" @click=${(e: Event) => e.stopPropagation()}>
					<div class="modal-header">
						<h2>${isEditing ? 'Edit SQL Connection' : 'Add SQL Connection'}</h2>
						<button class="btn-icon" @click=${() => this._closeModal()}>${ICONS.close}</button>
					</div>
					<div class="modal-body">
						<kw-sql-connection-form
							.mode=${this._modalMode}
							.name=${this._modalName}
							.serverUrl=${this._modalServerUrl}
							.port=${this._modalPort}
							.dialect=${this._modalDialect}
							.authType=${this._modalAuthType}
							.username=${this._modalUsername}
							.password=${this._modalPassword}
							.database=${this._modalDb}
							.dialects=${dialects}
							.showTestButton=${isEditing}
							.testResult=${this._testResult}
							.changePassword=${this._modalChangePassword}
							@sql-connection-form-submit=${this._onSqlFormSubmit}
							@sql-connection-form-cancel=${() => this._closeModal()}
							@sql-connection-form-test=${this._testSqlConnection}
						></kw-sql-connection-form>
					</div>
					<div class="modal-footer">
						<button class="btn" @click=${() => this._closeModal()}>Cancel</button>
						<button class="btn primary" @click=${() => this._submitSqlForm()}>Save</button>
					</div>
				</div>
			</div>
		`;
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	// ── Splitter removed — single panel layout ───────────────────────────────

	private _selectConnection(connId: string): void {
		this._selectedConnectionId = connId;
		this._setKustoExplorerPath(null);
		this._vscode.postMessage({ type: 'cluster.expand', connectionId: connId });
	}

	private _selectFavorite(fav: KustoFavorite, conn: KustoConnection | undefined): void {
		if (conn) {
			this._selectedConnectionId = conn.id;
			this._setKustoExplorerPath({ connectionId: conn.id, database: fav.database });
			this._vscode.postMessage({ type: 'cluster.expand', connectionId: conn.id });
			const dbKey = conn.id + '|' + fav.database;
			if (!this._databaseSchemas[dbKey]) {
				this._vscode.postMessage({ type: 'database.getSchema', connectionId: conn.id, database: fav.database });
			}
		}
	}

	private _navigateToDatabase(conn: KustoConnection, db: string): void {
		this._setKustoExplorerPath({ connectionId: conn.id, database: db });
		const dbKey = conn.id + '|' + db;
		if (!this._databaseSchemas[dbKey]) {
			this._vscode.postMessage({ type: 'database.getSchema', connectionId: conn.id, database: db });
		}
	}

	private _toggleFavorite(conn: KustoConnection, db: string, isFav: boolean): void {
		if (isFav) {
			this._vscode.postMessage({ type: 'favorite.remove', connectionId: conn.id, database: db });
		} else {
			this._vscode.postMessage({ type: 'favorite.promptAdd', connectionId: conn.id, database: db });
		}
	}

	private _renameFavorite(conn: KustoConnection, db: string): void {
		const favorite = this._getFavorite(conn.id, db);
		if (!favorite) return;
		this._vscode.postMessage({ type: 'favorite.promptRename', connectionId: favorite.connectionId, database: favorite.database });
	}

	private _toggleTable(tableKey: string): void {
		const next = new Set(this._expandedTables);
		if (next.has(tableKey)) next.delete(tableKey); else next.add(tableKey);
		this._expandedTables = next;
	}

	private _toggleFunction(fnKey: string): void {
		const next = new Set(this._expandedFunctions);
		if (next.has(fnKey)) next.delete(fnKey); else next.add(fnKey);
		this._expandedFunctions = next;
	}

	private _openModal(mode: 'add' | 'edit', connId?: string): void {
		try {
			this._modalReturnFocus = this.shadowRoot?.activeElement as HTMLElement | null;
		} catch {
			this._modalReturnFocus = null;
		}
		this._modalMode = mode;
		this._editingConnectionId = connId ?? null;
		this._sqlTestConnectionRequestId = null;
		this._testResult = '';
		this._modalChangePassword = false;

		if (this._activeKind === 'sql') {
			// SQL modal
			if (mode === 'edit' && connId && this._snapshot?.sqlConnections) {
				const conn = this._snapshot.sqlConnections.find(c => c.id === connId);
				if (conn) {
					this._modalName = conn.name || '';
					this._modalServerUrl = conn.serverUrl || '';
					this._modalPort = conn.port ? String(conn.port) : '';
					this._modalDialect = conn.dialect || 'mssql';
					this._modalAuthType = conn.authType || 'aad';
					this._modalUsername = conn.username || '';
					this._modalPassword = '';
					this._modalDb = conn.database || '';
				}
			} else {
				this._modalName = '';
				this._modalServerUrl = '';
				this._modalPort = '';
				this._modalDialect = (this._snapshot?.sqlDialects?.[0]?.id) || 'mssql';
				this._modalAuthType = 'aad';
				this._modalUsername = '';
				this._modalPassword = '';
				this._modalDb = '';
				this._modalAuthorityId = '';
				this._modalAccountId = '';
			}
		} else {
			// Kusto modal
			if (mode === 'edit' && connId && this._snapshot) {
				const conn = this._snapshot.connections.find(c => c.id === connId);
				if (conn) {
					this._modalName = conn.name || '';
					this._modalUrl = conn.clusterUrl || '';
					this._modalDb = conn.database || '';
					this._modalAuthorityId = conn.authorityId || '';
					this._modalAccountId = conn.accountPreference?.mode === 'explicit' ? conn.accountPreference.accountId : '';
				}
			} else {
				this._modalName = '';
				this._modalUrl = '';
				this._modalDb = '';
				this._modalAuthorityId = '';
				this._modalAccountId = '';
			}
		}
		this._modalVisible = true;
	}

	private _closeModal(): void {
		const overlay = this.shadowRoot?.querySelector('[data-testid="cm-modal-overlay"]') as HTMLElement | null;
		if (overlay) overlay.style.display = 'none';
		this._modalVisible = false;
		this._editingConnectionId = null;
		this._sqlTestConnectionRequestId = null;
	}

	private _testConnection(e?: CustomEvent<KustoConnectionFormSubmitDetail>): void {
		const detail = e?.detail;
		if (!this._editingConnectionId && !detail?.clusterUrl) {
			this._testResult = 'Enter a cluster URL before testing.';
			return;
		}
		this._testResult = 'loading';
		this._vscode.postMessage({
			type: 'connection.test',
			id: this._editingConnectionId || undefined,
			name: detail?.name,
			clusterUrl: detail?.clusterUrl,
			database: detail?.database,
			authorityId: detail?.authorityId,
			accountId: detail?.accountId,
		});
	}

	private _testSqlConnection = (event: CustomEvent<SqlConnectionFormSubmitDetail>): void => {
		if (!this._editingConnectionId) return;
		this._vscode.postMessage({ type: 'sql.connection.test', id: this._editingConnectionId, ...event.detail });
	};

	private _onModalKeydown = (e: KeyboardEvent) => {
		// Escape on the overlay level (form handles Enter/Escape internally,
		// but clicks on overlay backdrop don't go through the form)
		if (e.key === 'Escape') { this._closeModal(); e.preventDefault(); }
	};

	private _onKustoFormSubmit(e: CustomEvent<KustoConnectionFormSubmitDetail>): void {
		const { name, clusterUrl, database, authorityId, accountId } = e.detail;
		if (!clusterUrl) return;
		if (this._editingConnectionId) {
			this._vscode.postMessage({ type: 'connection.edit', id: this._editingConnectionId, name, clusterUrl, database, authorityId, accountId });
		} else {
			this._vscode.postMessage({ type: 'connection.add', name, clusterUrl, database, authorityId, accountId });
		}
		this._testResult = 'loading';
	}

	private _onSqlFormSubmit(e: CustomEvent<SqlConnectionFormSubmitDetail>): void {
		const d = e.detail;
		if (!d.serverUrl) return;
		const payload: Record<string, unknown> = {
			name: d.name,
			serverUrl: d.serverUrl,
			dialect: d.dialect,
			authType: d.authType,
			database: d.database,
		};
		if (d.port) payload.port = d.port;
		if (d.username !== undefined) payload.username = d.username;
		if (d.password !== undefined) payload.password = d.password;
		if (this._editingConnectionId) {
			this._vscode.postMessage({ type: 'sql.connection.edit', id: this._editingConnectionId, ...payload });
		} else {
			this._vscode.postMessage({ type: 'sql.connection.add', ...payload });
		}
		this._closeModal();
		setTimeout(() => this._vscode.postMessage({ type: 'requestSnapshot' }), 100);
	}

	private _submitKustoForm(): void {
		const form = this.shadowRoot?.querySelector('kw-kusto-connection-form');
		if (form) form.submit();
	}

	private _submitSqlForm(): void {
		const form = this.shadowRoot?.querySelector('kw-sql-connection-form');
		if (form) form.submit();
	}

	private _trimFnBody(body: string): string {
		let s = body.trim();
		if (s.startsWith('{')) s = s.slice(1);
		if (s.endsWith('}')) s = s.slice(0, -1);
		// Remove common leading whitespace (dedent)
		const lines = s.split('\n');
		// Find minimum indentation of non-empty lines
		let minIndent = Infinity;
		for (const line of lines) {
			if (!line.trim()) continue;
			const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
			if (indent < minIndent) minIndent = indent;
		}
		if (minIndent > 0 && minIndent < Infinity) {
			return lines.map(l => l.slice(minIndent)).join('\n').trim();
		}
		return s.trim();
	}

	// ── Back navigation ──────────────────────────────────────────────────────

	private _navigateBack(): void {
		const ep = this._explorerPath;
		if (!ep) return;
		if (ep.folderPath && ep.folderPath.length > 0) {
			this._setKustoExplorerPath({ ...ep, folderPath: ep.folderPath.slice(0, -1) });
		} else if (ep.section) {
			this._setKustoExplorerPath({ ...ep, section: undefined, folderPath: undefined, tableName: undefined });
		} else if (ep.database) {
			this._setKustoExplorerPath({ connectionId: ep.connectionId });
		} else {
			this._setKustoExplorerPath(null);
		}
	}

	private _navigateSqlBack(): void {
		const ep = this._sqlExplorerPath;
		if (!ep) return;
		if (ep.section) {
			this._setSqlExplorerPath({ ...ep, section: undefined, folderPath: undefined });
		} else if (ep.database) {
			this._setSqlExplorerPath({ connectionId: ep.connectionId });
		} else {
			this._setSqlExplorerPath(null);
		}
	}

	// ── Search UI ─────────────────────────────────────────────────────────────

	private _renderSearchContent(): TemplateResult {
		const s = this._search;
		const categories = s.kind === 'sql' ? SQL_CATEGORIES : KUSTO_CATEGORIES;
		const cats = s.categories;
		const RESULT_CAT_MAP: Record<string, string> = { cluster: 'clusters', database: 'databases', table: 'tables', column: 'tables', function: 'functions', server: 'servers', view: 'views', 'stored-procedure': 'storedProcedures' };
		const visibleResults = s.results.filter(r => cats[RESULT_CAT_MAP[r.category] ?? r.category] !== false);
		const resultCount = visibleResults.length;

		const cachedCount = this._activeKind === 'kusto'
			? Object.keys(this._snapshot?.cachedDatabases ?? {}).length
			: Object.keys(this._snapshot?.sqlCachedDatabases ?? {}).length;
		const totalCount = this._activeKind === 'kusto'
			? (this._snapshot?.connections?.length ?? 0)
			: (this._snapshot?.sqlConnections?.length ?? 0);

		return html`
			<div class="search-container" data-testid="cm-search-container">
				<!-- Search input -->
				<div class="search-section-label">What to search for</div>
				<div class="search-input-row">
					<div class="search-input-wrapper">
						<input class="search-input" data-testid="cm-search-input" type="text" placeholder="Search connections, databases, tables…"
							.value=${s.query}
							@input=${(e: Event) => s.setQuery((e.target as HTMLInputElement).value)}
						/>
						${s.loading ? html`<span class="search-input-spinner">${ICONS.spinner}</span>` : nothing}
					</div>
				</div>

				<!-- Refresh progress strip (only for schema refresh operations) -->
				${s.refreshing ? html`
					<div class="search-progress-strip">
						${ICONS.spinner}
						<span class="search-progress-text">${s.progressMessage || 'Refreshing schemas…'}</span>
						${s.progressTotal > 0 ? html`<span class="search-progress-count">${s.progressCurrent}/${s.progressTotal}</span>` : nothing}
						<button class="btn-icon search-progress-dismiss" title="Cancel" @click=${() => s.cancelSearch()}>${ICONS.close}</button>
					</div>
				` : nothing}

				<!-- Category chips + Refresh split-button -->
				<div class="search-categories-row">
					<div class="search-categories" data-testid="cm-search-categories">
						${categories.map(cat => {
							const isOn = s.categories[cat.id];
							const contentOn = isOn && cat.hasContent && s.contentToggles[cat.id];
							const icon = { clusters: ICONS.kustoCluster, databases: ICONS.database, tables: ICONS.table, functions: ICONS.function, servers: ICONS.sqlServer, views: ICONS.table, storedProcedures: ICONS.function }[cat.id] ?? ICONS.kustoCluster;
							const tooltip = isOn && cat.splitLabel ? (contentOn ? `${cat.splitLabel[0]} ${cat.splitLabel[1]}` : cat.splitLabel[0]) : cat.label;
							return html`
							<button class="search-category-chip ${isOn ? 'active' : ''} ${cat.hasContent ? 'has-content' : ''} ${contentOn ? 'content-on' : ''}"
								title=${tooltip}
								@click=${() => s.cycleCategory(cat.id, cat.hasContent)}>
								<span class="search-chip-icon">${icon}</span>
								${isOn && cat.splitLabel ? html`
									<span class="search-chip-label search-chip-text">${cat.splitLabel[0]} <span class="search-chip-secondary ${contentOn ? '' : 'dimmed'}">${cat.splitLabel[1]}</span></span>
								` : html`
									<span class="search-chip-label search-chip-text">${cat.label}</span>
								`}
							</button>
						`;})}
					</div>
					<div class="search-refresh-split">
						<button class="search-refresh-main" @click=${() => s.refreshCachedAndSearch()}>
							<span class="search-refresh-label-always">Refresh</span> <span class="search-refresh-label-extra">schemas</span> <span class="search-refresh-count">(${cachedCount})</span>
						</button>
						<button class="search-refresh-drop ${this._refreshMenuOpen ? 'active' : ''}" @click=${() => this._toggleRefreshMenu()}>
							${ICONS.chevron}
						</button>
						${this._refreshMenuOpen ? html`
							<div class="search-refresh-menu">
								<button class="search-tools-item" @click=${() => { this._closeRefreshMenu(); s.refreshCachedAndSearch(); }}>
									<div class="search-tools-item-title">Refresh connections with cached schemas <span class="search-tools-count">(${cachedCount})</span></div>
									<div class="search-tools-item-desc">These are connections you typically use. Use this to pick up very recent schema changes in them (new tables, etc.) before you use search.</div>
								</button>
								<button class="search-tools-item" @click=${() => { this._closeRefreshMenu(); s.refreshAllAndSearch(); }}>
									<div class="search-tools-item-title">Refresh all connections <span class="search-tools-count">(${totalCount})</span></div>
									<div class="search-tools-item-desc">These are all the connections you have, even ones you have not actually used before. Use this to make sure you have the schema of 100% of your connections before you search.</div>
								</button>
							</div>
						` : nothing}
					</div>
				</div>

				<!-- Results -->
				<!-- Results count (always visible when query present) -->
				${s.query.trim() ? html`
					<div class="search-result-count">
						${s.loading ? html`${resultCount > 0 ? `${resultCount} result${resultCount !== 1 ? 's' : ''} ` : ''}(searching…)` : html`${resultCount} result${resultCount !== 1 ? 's' : ''}`}
						${!s.loading ? html`<button class="btn-icon search-result-rerun" title="Re-run search" @click=${() => s.rerunSearch()}>${ICONS.refresh}</button>` : nothing}
					</div>
				` : nothing}

				<div class="search-results explorer-content" data-overlay-scroll="x:hidden" data-testid="cm-search-results">
					${resultCount === 0 && !s.loading && !s.query.trim() || (s.refreshing && !s.query.trim()) ? html`
						<div class="empty-state">
							<div class="empty-state-icon">${ICONS.toolbarSearch}</div>
							<div class="empty-state-title">Search your connections</div>
							<div class="empty-state-text">Type to search across clusters, databases, tables, functions, and more.</div>
						</div>
					` : nothing}
					${resultCount === 0 && !s.loading && s.query.trim() ? html`
						<div class="empty-state">
							<div class="empty-state-icon">${ICONS.toolbarSearch}</div>
							<div class="empty-state-title">No results</div>
							<div class="empty-state-text">Try a different query, enable more categories, or use a broader search scope.</div>
						</div>
					` : nothing}
					${visibleResults.map(r => {
						const expandable = r.category === 'table' || r.category === 'view' || r.category === 'function' || r.category === 'stored-procedure';
						const itemKey = this._searchResultKey(r);
						const isExpanded = expandable && (r.category === 'function' || r.category === 'stored-procedure' ? this._expandedFunctions.has(itemKey) : this._expandedTables.has(itemKey));
						return html`
						<div class="explorer-list-item-wrapper ${isExpanded ? 'expanded' : ''}">
							<div class="explorer-list-item search-result-item" @click=${() => expandable ? this._toggleSearchResult(r) : this._navigateToSearchResult(r)}>
								${expandable ? html`<span class="explorer-list-item-chevron ${isExpanded ? 'expanded' : ''}">${ICONS.chevron}</span>` : nothing}
								<span class="explorer-list-item-icon ${r.category}">${this._getSearchResultIcon(r.category)}</span>
								<span class="explorer-list-item-name">${r.name}</span>
								<span class="search-result-context">
									${r.parentName ? html`<span class="search-result-parent">${r.parentName} ›</span>` : nothing}
									${r.database ? html`<span class="search-result-db">${r.connectionName} › ${r.database}</span>` : html`<span class="search-result-db">${r.connectionName}</span>`}
								</span>
								${r.matchContext ? html`<span class="search-result-match">${r.matchContext}</span>` : nothing}
							</div>
							${isExpanded ? this._renderSearchResultDetails(r) : nothing}
						</div>
					`;})}
				</div>
			</div>
		`;
	}

	private _getSearchResultIcon(category: string): TemplateResult {
		switch (category) {
			case 'cluster': return ICONS.kustoCluster;
			case 'server': return ICONS.sqlServer;
			case 'database': return ICONS.database;
			case 'table': return ICONS.table;
			case 'view': return ICONS.table;
			case 'function': return ICONS.function;
			case 'stored-procedure': return ICONS.function;
			case 'column': return ICONS.table;
			default: return ICONS.kustoCluster;
		}
	}

	private _searchResultKey(r: SearchResult): string {
		const dbKey = r.connectionId + '|' + (r.database ?? '');
		if (r.category === 'table' || r.category === 'view') return dbKey + '|table|' + r.name;
		if (r.category === 'function' || r.category === 'stored-procedure') return dbKey + '|fn|' + r.name;
		return dbKey + '|' + r.name;
	}

	private _toggleSearchResult(r: SearchResult): void {
		const key = this._searchResultKey(r);
		if (r.category === 'function' || r.category === 'stored-procedure') {
			this._toggleFunction(key);
		} else {
			this._toggleTable(key);
		}
		// Ensure schema is loaded for expansion
		if (r.database) {
			const dbKey = r.connectionId + '|' + r.database;
			if (r.kind === 'kusto' && !this._databaseSchemas[dbKey]) {
				this._vscode.postMessage({ type: 'database.getSchema', connectionId: r.connectionId, database: r.database });
			} else if (r.kind === 'sql' && !this._sqlDatabaseSchemas[dbKey]) {
				this._vscode.postMessage({ type: 'sql.database.getSchema', connectionId: r.connectionId, database: r.database });
			}
		}
	}

	private _renderSearchResultDetails(r: SearchResult): TemplateResult {
		const dbKey = r.connectionId + '|' + (r.database ?? '');
		const tableKey = this._searchResultKey(r);
		if (r.kind === 'kusto') {
			const schema = this._databaseSchemas[dbKey];
			if (!schema) return html`<div class="explorer-item-details"><div class="explorer-detail-section"><span class="explorer-detail-label">Loading schema…</span></div></div>`;
			if (r.category === 'table') {
				const cols = schema.columnTypesByTable?.[r.name] ?? {};
				const colNames = sortStringsAlphabetically(Object.keys(cols));
				const docString = schema.tableDocStrings?.[r.name];
				const conn = this._snapshot?.connections?.find(c => c.id === r.connectionId);
				const ep: ExplorerPath = { connectionId: r.connectionId, database: r.database };
				const previewData = this._tablePreviewData[tableKey];
				return html`<div class="explorer-item-details">
					${docString ? html`<div class="explorer-detail-section"><div class="explorer-detail-label">Description</div><div class="explorer-detail-docstring">${docString}</div></div>` : nothing}
					${colNames.length > 0 ? html`<div class="explorer-detail-section"><div class="explorer-detail-label">Schema (${colNames.length} columns)</div><div class="explorer-detail-schema">${colNames.map(col => this._renderKustoSchemaColumnRow(schema, r.name, col, cols[col]))}</div></div>` : nothing}
					${conn ? this._renderTablePreview(tableKey, r.name, previewData, conn, ep) : nothing}
				</div>`;
			}
			if (r.category === 'function') {
				const fn = schema.functions?.find(f => f.name === r.name);
				if (!fn) return html`<div class="explorer-item-details"><div class="explorer-detail-section"><span class="explorer-detail-label">Function not found in schema</span></div></div>`;
				return html`<div class="explorer-item-details">
					${fn.docString ? html`<div class="explorer-detail-section"><div class="explorer-detail-label">Description</div><div class="explorer-detail-docstring">${fn.docString}</div></div>` : nothing}
					<div class="explorer-detail-section"><div class="explorer-detail-label">Signature</div><div class="explorer-detail-code">${fn.name}(${fn.parametersText || ''})</div></div>
					${fn.body ? html`<div class="explorer-detail-section"><div class="explorer-detail-label">Implementation</div><pre class="explorer-detail-body">${this._trimFnBody(fn.body)}</pre></div>` : nothing}
				</div>`;
			}
		} else {
			const schema = this._sqlDatabaseSchemas[dbKey];
			if (!schema) return html`<div class="explorer-item-details"><div class="explorer-detail-section"><span class="explorer-detail-label">Loading schema…</span></div></div>`;
			if (r.category === 'table' || r.category === 'view') {
				const cols = schema.columnsByTable?.[r.name] ?? {};
				const colNames = sortStringsAlphabetically(Object.keys(cols));
				const conn = this._snapshot?.sqlConnections?.find(c => c.id === r.connectionId);
				const ep: ExplorerPath = { connectionId: r.connectionId, database: r.database };
				const previewData = this._sqlTablePreviewData[tableKey];
				return html`<div class="explorer-item-details">
					${colNames.length > 0 ? html`<div class="explorer-detail-section"><div class="explorer-detail-label">Schema (${colNames.length} columns)</div><div class="explorer-detail-schema">${colNames.map(col => html`<div class="explorer-schema-row"><span class="explorer-schema-col-name">${col}</span><span class="explorer-schema-col-type">${cols[col]}</span></div>`)}</div></div>` : nothing}
					${conn ? this._renderSqlTablePreview(tableKey, r.name, previewData, conn, ep) : nothing}
				</div>`;
			}
			if (r.category === 'stored-procedure') {
				const sp = schema.storedProcedures?.find(s => s.name === r.name);
				if (!sp) return html`<div class="explorer-item-details"><div class="explorer-detail-section"><span class="explorer-detail-label">Stored procedure not found in schema</span></div></div>`;
				return html`<div class="explorer-item-details">
					<div class="explorer-detail-section"><div class="explorer-detail-label">Signature</div><div class="explorer-detail-code">${sp.name}(${sp.parametersText || ''})</div></div>
					${sp.body ? html`<div class="explorer-detail-section"><div class="explorer-detail-label">Implementation</div><pre class="explorer-detail-body">${sp.body}</pre></div>` : nothing}
				</div>`;
			}
		}
		return html``;
	}

	private _navigateToSearchResult(r: SearchResult): void {
		const filterChanged = this._activeFilter !== 'all';
		if (filterChanged) {
			this._activeFilter = 'all';
		}
		if (r.kind === 'kusto') {
			if (r.category === 'cluster' || r.category === 'database') {
				this._setKustoExplorerPath(r.database ? { connectionId: r.connectionId, database: r.database } : { connectionId: r.connectionId });
				this._vscode.postMessage({ type: 'cluster.expand', connectionId: r.connectionId });
				if (r.database) {
					const dbKey = r.connectionId + '|' + r.database;
					if (!this._databaseSchemas[dbKey]) {
						this._vscode.postMessage({ type: 'database.getSchema', connectionId: r.connectionId, database: r.database });
					}
				}
			} else if (r.category === 'table' || r.category === 'column') {
				this._setKustoExplorerPath({ connectionId: r.connectionId, database: r.database, section: 'tables', folderPath: [] });
				this._vscode.postMessage({ type: 'cluster.expand', connectionId: r.connectionId });
				if (r.database) {
					const dbKey = r.connectionId + '|' + r.database;
					if (!this._databaseSchemas[dbKey]) {
						this._vscode.postMessage({ type: 'database.getSchema', connectionId: r.connectionId, database: r.database });
					}
				}
			} else if (r.category === 'function') {
				this._setKustoExplorerPath({ connectionId: r.connectionId, database: r.database, section: 'functions', folderPath: [] });
				this._vscode.postMessage({ type: 'cluster.expand', connectionId: r.connectionId });
				if (r.database) {
					const dbKey = r.connectionId + '|' + r.database;
					if (!this._databaseSchemas[dbKey]) {
						this._vscode.postMessage({ type: 'database.getSchema', connectionId: r.connectionId, database: r.database });
					}
				}
			}
		} else {
			if (r.category === 'server' || r.category === 'database') {
				this._setSqlExplorerPath(r.database ? { connectionId: r.connectionId, database: r.database } : { connectionId: r.connectionId });
				this._vscode.postMessage({ type: 'sql.cluster.expand', connectionId: r.connectionId });
				if (r.database) {
					const dbKey = r.connectionId + '|' + r.database;
					if (!this._sqlDatabaseSchemas[dbKey]) {
						this._vscode.postMessage({ type: 'sql.database.getSchema', connectionId: r.connectionId, database: r.database });
					}
				}
			} else if (r.category === 'table' || r.category === 'column') {
				this._setSqlExplorerPath({ connectionId: r.connectionId, database: r.database, section: 'tables' });
				this._vscode.postMessage({ type: 'sql.cluster.expand', connectionId: r.connectionId });
				if (r.database) {
					const dbKey = r.connectionId + '|' + r.database;
					if (!this._sqlDatabaseSchemas[dbKey]) {
						this._vscode.postMessage({ type: 'sql.database.getSchema', connectionId: r.connectionId, database: r.database });
					}
				}
			} else if (r.category === 'view') {
				this._setSqlExplorerPath({ connectionId: r.connectionId, database: r.database, section: 'views' });
				this._vscode.postMessage({ type: 'sql.cluster.expand', connectionId: r.connectionId });
				if (r.database) {
					const dbKey = r.connectionId + '|' + r.database;
					if (!this._sqlDatabaseSchemas[dbKey]) {
						this._vscode.postMessage({ type: 'sql.database.getSchema', connectionId: r.connectionId, database: r.database });
					}
				}
			} else if (r.category === 'stored-procedure') {
				this._setSqlExplorerPath({ connectionId: r.connectionId, database: r.database, section: 'functions' });
				this._vscode.postMessage({ type: 'sql.cluster.expand', connectionId: r.connectionId });
				if (r.database) {
					const dbKey = r.connectionId + '|' + r.database;
					if (!this._sqlDatabaseSchemas[dbKey]) {
						this._vscode.postMessage({ type: 'sql.database.getSchema', connectionId: r.connectionId, database: r.database });
					}
				}
			}
		}
		if (filterChanged) {
			this._scheduleExplorerScrollReset();
		}
	}

	// ── Folder tree helpers ───────────────────────────────────────────────────

	private _buildFolderTree(items: any[], getFolderFn: (item: any) => string | undefined): any {
		const tree: any = { __items: [] };
		for (const item of items) {
			const folder = getFolderFn(item);
			if (folder) {
				const parts = folder.split('/').filter(Boolean);
				let node = tree;
				for (const part of parts) {
					if (!node[part]) node[part] = { __items: [] };
					node = node[part];
				}
				node.__items.push(item);
			} else {
				tree.__items.push(item);
			}
		}
		return tree;
	}

	private _getTreeAtPath(tree: any, path: string[]): any {
		let node = tree;
		for (const p of path) {
			if (node[p]) node = node[p]; else return { __items: [] };
		}
		return node;
	}

	private _countTreeItems(node: any): number {
		if (!node || typeof node !== 'object') return 0;
		let count = Array.isArray(node.__items) ? node.__items.length : 0;
		for (const key of Object.keys(node)) {
			if (key === '__items') continue;
			count += this._countTreeItems(node[key]);
		}
		return count;
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	static styles = [...osStyles, scrollbarSheet, iconRegistryStyles, styles];
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-connection-manager': KwConnectionManager;
	}
}
