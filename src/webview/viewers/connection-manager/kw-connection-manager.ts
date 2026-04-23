import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { styles } from './kw-connection-manager.styles.js';
import { scrollbarSheet } from '../../shared/scrollbar-styles.js';
import { osStyles } from '../../shared/os-styles.js';
import { OverlayScrollbarsController } from '../../components/overlay-scrollbars.controller.js';
import { customElement, state } from 'lit/decorators.js';
import { ICONS, iconRegistryStyles } from '../../shared/icon-registry.js';
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

// ─── Types ────────────────────────────────────────────────────────────────────

interface KustoConnection {
	id: string;
	name: string;
	clusterUrl: string;
	database?: string;
}

interface KustoFavorite {
	name: string;
	clusterUrl: string;
	database: string;
}

interface Snapshot {
	timestamp: number;
	activeKind?: ConnectionKind;
	connections: KustoConnection[];
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
	storedProcedures?: Array<{ name: string; schema?: string; parametersText?: string; body?: string }>;
}

interface SqlFavorite {
	name: string;
	connectionId: string;
	database: string;
}

interface DatabaseSchema {
	tables?: string[];
	functions?: Array<{ name: string; folder?: string; parametersText?: string; docString?: string; body?: string }>;
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
	let s = String(url || '').trim();
	if (!s) return '';
	if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
	return s.replace(/\/+$/g, '').toLowerCase();
}

function getClusterCacheKey(clusterUrl: string): string {
	try {
		let u = String(clusterUrl || '').trim();
		if (!u) return '';
		if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
		return String(new URL(u).hostname || '').trim().toLowerCase() || u.toLowerCase();
	} catch { return String(clusterUrl || '').trim().toLowerCase(); }
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
	@state() private _activeFilter: ActiveFilter = 'all';
	@state() private _refreshMenuOpen = false;

	// Modal state
	@state() private _modalVisible = false;
	@state() private _modalMode: 'add' | 'edit' = 'add';
	@state() private _editingConnectionId: string | null = null;
	@state() private _modalName = '';
	@state() private _modalUrl = '';
	@state() private _modalDb = '';
	@state() private _testResult = '';

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

	// ── VS Code API ───────────────────────────────────────────────────────────

	private _vscode!: VsCodeApi;

	// ── Search controller ─────────────────────────────────────────────────────

	private _search = new ConnectionManagerSearchController(this as unknown as SearchControllerHost);

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
	}

	private _dismissToolsMenu = (e: Event) => {
		const path = e.composedPath();
		if (this._refreshMenuOpen) {
			const split = this.shadowRoot?.querySelector('.search-refresh-split');
			if (split && !path.includes(split)) {
				this._refreshMenuOpen = false;
			}
		}
	};

	// ── Message handling ──────────────────────────────────────────────────────

	private _onMessage = (event: MessageEvent) => {
		const msg = event.data;
		if (!msg) return;

		switch (msg.type) {
			case 'snapshot':
				this._snapshot = msg.snapshot;
				// Auto-detect active kind
				if (this._snapshot) {
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
					// Restore search state
					this._search.restoreState(this._snapshot.searchState as any, this._activeKind);
				}
				if (!this._selectedConnectionId && this._snapshot?.connections?.length) {
					this._selectedConnectionId = this._snapshot.connections[0].id;
					this._vscode.postMessage({ type: 'cluster.expand', connectionId: this._selectedConnectionId });
				}
				break;
			case 'testConnectionStarted':
				this._testResult = 'loading';
				break;
			case 'testConnectionResult':
				this._testResult = msg.success ? `✓ ${msg.message}` : `✗ ${msg.message}`;
				break;
			case 'loadingDatabases':
				this._loadingDatabases = new Set([...this._loadingDatabases, msg.connectionId]);
				break;
			case 'databasesLoaded':
				this._loadingDatabases = new Set([...this._loadingDatabases].filter(id => id !== msg.connectionId));
				this._vscode.postMessage({ type: 'requestSnapshot' });
				break;
			case 'databasesLoadError':
				this._loadingDatabases = new Set([...this._loadingDatabases].filter(id => id !== msg.connectionId));
				break;
			case 'schemaLoaded': {
				const dbKey = msg.connectionId + '|' + msg.database;
				this._databaseSchemas = { ...this._databaseSchemas, [dbKey]: msg.schema };
				break;
			}
			case 'schemaRefreshStarted':
				// Could add visual indicator
				break;
			case 'schemaRefreshCompleted':
				// Could remove visual indicator
				break;
			case 'tablePreviewLoading': {
				const prevKey = msg.connectionId + '|' + msg.database + '|table|' + msg.tableName;
				this._tablePreviewData = { ...this._tablePreviewData, [prevKey]: { loading: true } };
				break;
			}
			case 'tablePreviewResult': {
				const prevKey = msg.connectionId + '|' + msg.database + '|table|' + msg.tableName;
				if (msg.success) {
					this._tablePreviewData = { ...this._tablePreviewData, [prevKey]: { loading: false, columns: msg.columns, rows: msg.rows, rowCount: msg.rowCount, executionTime: msg.executionTime } };
				} else {
					this._tablePreviewData = { ...this._tablePreviewData, [prevKey]: { loading: false, error: msg.error || 'Failed to load preview.' } };
				}
				break;
			}
			// SQL messages
			case 'sql.testConnectionStarted':
				this._testResult = 'loading';
				break;
			case 'sql.testConnectionResult':
				this._testResult = msg.success ? `✓ ${msg.message}` : `✗ ${msg.message}`;
				break;
			case 'sql.loadingDatabases':
				this._sqlLoadingDatabases = new Set([...this._sqlLoadingDatabases, msg.connectionId]);
				break;
			case 'sql.databasesLoaded':
				this._sqlLoadingDatabases = new Set([...this._sqlLoadingDatabases].filter(id => id !== msg.connectionId));
				this._vscode.postMessage({ type: 'requestSnapshot' });
				break;
			case 'sql.databasesLoadError':
				this._sqlLoadingDatabases = new Set([...this._sqlLoadingDatabases].filter(id => id !== msg.connectionId));
				break;
			case 'sql.loadingSchema':
				// Could add visual indicator
				break;
			case 'sql.schemaLoaded': {
				const sqlDbKey = msg.connectionId + '|' + msg.database;
				this._sqlDatabaseSchemas = { ...this._sqlDatabaseSchemas, [sqlDbKey]: msg.schema };
				break;
			}
			case 'sql.schemaLoadError':
				// Could add error state
				break;
			case 'sql.tablePreviewLoading': {
				const sqlPrevKey = msg.connectionId + '|' + msg.database + '|table|' + msg.tableName;
				this._sqlTablePreviewData = { ...this._sqlTablePreviewData, [sqlPrevKey]: { loading: true } };
				break;
			}
			case 'sql.tablePreviewResult': {
				const sqlPrevKey = msg.connectionId + '|' + msg.database + '|table|' + msg.tableName;
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
			case 'searchResults':
				this._search.handleSearchResults(msg.requestId, msg.results, msg.completed);
				break;
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

	private _isFavorite(clusterUrl: string, database: string): boolean {
		if (!this._snapshot?.favorites) return false;
		const nUrl = normalizeClusterUrl(clusterUrl);
		const nDb = database.toLowerCase();
		return this._snapshot.favorites.some(f =>
			normalizeClusterUrl(f.clusterUrl) === nUrl && f.database.toLowerCase() === nDb
		);
	}

	private _getSelectedConnection(): KustoConnection | undefined {
		return this._snapshot?.connections?.find(c => c.id === this._selectedConnectionId);
	}

	// ── Render ────────────────────────────────────────────────────────────────

	protected render(): TemplateResult {
		const connections = this._snapshot?.connections ?? [];
		const sqlConnections = this._snapshot?.sqlConnections ?? [];
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
						<button class="header-btn" title="Import" @click=${() => this._vscode.postMessage({ type: 'connection.importXml' })}>
							${ICONS.importIcon} <span class="header-btn-label">Import</span>
						</button>
						<button class="header-btn" title="Export" @click=${() => this._vscode.postMessage({ type: 'connection.exportXml' })}>
							${ICONS.save} <span class="header-btn-label">Export</span>
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
		this._vscode.postMessage({ type: 'setActiveKind', kind });
	}

	private _renderKustoContent(): TemplateResult {
		const connections = this._snapshot?.connections ?? [];
		const favorites = this._snapshot?.favorites ?? [];
		const lntClusters = this._snapshot?.leaveNoTraceClusters ?? [];
		const hasFavs = favorites.length > 0;
		const hasLnt = lntClusters.length > 0;
		const favClusterUrls = new Set(favorites.map(f => normalizeClusterUrl(f.clusterUrl)));
		const af = this._activeFilter;

		// Apply filters
		let visibleConnections = connections;
		if (af === 'favorites') {
			visibleConnections = connections.filter(c => favClusterUrls.has(normalizeClusterUrl(c.clusterUrl)));
		}
		if (af === 'lnt') {
			const lntUrls = new Set(lntClusters.map(u => normalizeClusterUrl(u)));
			visibleConnections = visibleConnections.filter(c => lntUrls.has(normalizeClusterUrl(c.clusterUrl)));
		}

		return html`
			<!-- Filter tabs (always visible) -->
			<div class="filter-bar" data-testid="cm-filter-bar">
				<button class="filter-tab ${af === 'all' ? 'active' : ''}" data-testid="cm-filter-all" @click=${() => { this._activeFilter = 'all'; this._validateBreadcrumb(); }}>${ICONS.kustoCluster} <span class="filter-label">All</span></button>
				${hasFavs ? html`<button class="filter-tab fav-tab ${af === 'favorites' ? 'active' : ''}" @click=${() => { this._activeFilter = af === 'favorites' ? 'all' : 'favorites'; this._validateBreadcrumb(); }}>${ICONS.starFilled} <span class="filter-label">Favorites</span> <span class="filter-count">${favorites.length}</span></button>` : nothing}
				${hasLnt ? html`<button class="filter-tab lnt-tab ${af === 'lnt' ? 'active' : ''}" @click=${() => { this._activeFilter = af === 'lnt' ? 'all' : 'lnt'; this._validateBreadcrumb(); }}>${ICONS.shield} <span class="filter-label">Leave No Trace</span> <span class="filter-count">${lntClusters.length}</span></button>` : nothing}
				<button class="filter-tab search-tab ${af === 'search' ? 'active' : ''}" data-testid="cm-filter-search" @click=${() => { this._activeFilter = af === 'search' ? 'all' : 'search'; if (this._search.kind !== 'kusto') this._search.setKind('kusto'); }}>${ICONS.toolbarSearch} <span class="filter-label">Search</span></button>
			</div>

			${af === 'search' ? this._renderSearchContent() : html`
				<!-- Breadcrumb (when drilled in) -->
				${this._explorerPath?.connectionId ? this._renderBreadcrumbBar() : nothing}

				<!-- Explorer content -->
				<div class="explorer-content" data-overlay-scroll="x:hidden">
					${this._explorerPath?.connectionId ? this._renderDrilledContent() : this._renderClusterList(visibleConnections, favClusterUrls, lntClusters)}
				</div>
			`}
		`;
	}

	// ── Cluster list (root level — flat, click to drill in) ──────────────────

	private _renderClusterList(connections: KustoConnection[], favClusterUrls: Set<string>, lntClusters: string[]): TemplateResult {
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
			const hasFav = favClusterUrls.has(normalizeClusterUrl(conn.clusterUrl));
			const isLnt = lntUrls.has(normalizeClusterUrl(conn.clusterUrl));
			const clusterKey = getClusterCacheKey(conn.clusterUrl);
			const dbCount = this._snapshot?.cachedDatabases?.[clusterKey]?.length ?? 0;
			const fullUrl = /^https?:\/\//i.test(conn.clusterUrl) ? conn.clusterUrl : 'https://' + conn.clusterUrl;

			return html`
				<div class="explorer-list-item" @click=${() => this._drillIntoCluster(conn.id)}>
					<span class="explorer-list-item-icon cluster">${ICONS.kustoCluster}</span>
					<span class="explorer-list-item-name">${conn.name || shortClusterName(conn.clusterUrl)}</span>
					${hasFav ? html`<span class="conn-badge fav-badge" title="Has favorites">${ICONS.starFilled}</span>` : nothing}
					${isLnt ? html`<span class="conn-badge lnt-badge" title="Leave No Trace">${ICONS.shield}</span>` : nothing}
					<span class="item-sep">·</span>
					<span class="explorer-list-item-url">${fullUrl}</span>
					<span class="item-sep">·</span>
					<span class="explorer-list-item-meta">${dbCount > 0 ? `${dbCount} database${dbCount !== 1 ? 's' : ''}` : 'click to explore'}</span>
					<div class="explorer-list-item-actions">
						<button class="btn-icon ${isLnt ? 'is-lnt' : ''}" title="${isLnt ? 'Remove from Leave No Trace' : 'Add to Leave No Trace'}"
							@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: isLnt ? 'leaveNoTrace.remove' : 'leaveNoTrace.add', clusterUrl: conn.clusterUrl }); }}>${ICONS.shield}</button>
						<button class="btn-icon" title="Edit" @click=${(e: Event) => { e.stopPropagation(); this._openModal('edit', conn.id); }}>${ICONS.edit}</button>
						<button class="btn-icon" title="Refresh" @click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'cluster.refreshDatabases', connectionId: conn.id }); }}>${ICONS.refresh}</button>
						<button class="btn-icon" title="Delete" @click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'connection.delete', id: conn.id }); }}>${ICONS.delete}</button>
					</div>
				</div>`;
		})}`;
	}

	private _drillIntoCluster(connId: string): void {
		this._selectedConnectionId = connId;
		this._explorerPath = { connectionId: connId } as any;
		this._vscode.postMessage({ type: 'cluster.expand', connectionId: connId });
	}

	/** Trim breadcrumb depth so it stays valid when a filter changes. */
	private _validateBreadcrumb(): void {
		const ep = this._explorerPath;
		if (!ep?.connectionId) return;

		const connections = this._snapshot?.connections ?? [];
		const conn = connections.find(c => c.id === ep.connectionId);
		if (!conn) { this._explorerPath = null; return; }

		// Check if the cluster is visible under current filter
		if (this._activeFilter === 'favorites') {
			const favUrls = new Set((this._snapshot?.favorites ?? []).map(f => normalizeClusterUrl(f.clusterUrl)));
			if (!favUrls.has(normalizeClusterUrl(conn.clusterUrl))) { this._explorerPath = null; return; }
			// If drilled into a database, check if it's a favorite
			if (ep.database) {
				const favDbs = new Set((this._snapshot?.favorites ?? []).filter(f => normalizeClusterUrl(f.clusterUrl) === normalizeClusterUrl(conn.clusterUrl)).map(f => f.database));
				if (!favDbs.has(ep.database)) { this._explorerPath = { connectionId: ep.connectionId } as any; return; }
			}
		}
		if (this._activeFilter === 'lnt') {
			const lntUrls = new Set((this._snapshot?.leaveNoTraceClusters ?? []).map(u => normalizeClusterUrl(u)));
			if (!lntUrls.has(normalizeClusterUrl(conn.clusterUrl))) { this._explorerPath = null; return; }
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
		const clusterKey = getClusterCacheKey(conn.clusterUrl);
		const databases = this._snapshot?.cachedDatabases?.[clusterKey] ?? [];
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
		return html`
			<div class="explorer-breadcrumb">
				<button class="btn-icon breadcrumb-back" data-testid="cm-breadcrumb-back" title="Go back" @click=${() => this._navigateBack()}>${ICONS.arrowLeft}</button>
				<span class="breadcrumb-item" @click=${() => { this._explorerPath = null; }}>
					<span class="breadcrumb-icon">${rootIcon}</span>${rootLabel}
				</span>
				<span class="breadcrumb-separator">/</span>
				<span class="breadcrumb-item ${!ep?.database ? 'current' : ''}" @click=${() => { this._explorerPath = { connectionId: conn.id, database: undefined } as any; }}>
					<span class="breadcrumb-icon">${ICONS.kustoCluster}</span>${conn.name}
				</span>
				${!ep?.database ? html`
					<button class="btn-icon breadcrumb-refresh" title="Refresh databases"
						@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'cluster.refreshDatabases', connectionId: conn.id }); }}>${this._loadingDatabases.has(conn.id) ? ICONS.spinner : ICONS.refresh}</button>
				` : nothing}
				${ep?.database ? html`
					<span class="breadcrumb-separator">/</span>
					<span class="breadcrumb-item ${!ep.section ? 'current' : ''}" @click=${() => { this._explorerPath = { ...ep, section: undefined, folderPath: undefined, tableName: undefined }; }}>
						<span class="breadcrumb-icon">${ICONS.database}</span>${ep.database}
					</span>
					${ep.section && ep.section !== 'table-columns' ? html`
						<span class="breadcrumb-separator">/</span>
						<span class="breadcrumb-item ${!ep.folderPath?.length ? 'current' : ''}" @click=${() => { this._explorerPath = { ...ep, folderPath: undefined }; }}>
							<span class="breadcrumb-icon">${ep.section === 'tables' ? ICONS.table : ICONS.function}</span>${ep.section === 'tables' ? 'Tables' : 'Functions'}
						</span>
						${(ep.folderPath ?? []).map((folder, i) => html`
							<span class="breadcrumb-separator">/</span>
							<span class="breadcrumb-item ${i === (ep.folderPath!.length - 1) ? 'current' : ''}"
								@click=${() => { this._explorerPath = { ...ep, folderPath: ep.folderPath!.slice(0, i + 1) }; }}>
								<span class="breadcrumb-icon">${ICONS.folder}</span>${folder}
							</span>
						`)}
					` : nothing}
					<button class="btn-icon breadcrumb-refresh" title="Refresh schema for ${ep.database}"
						@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'database.refreshSchema', clusterUrl: conn.clusterUrl, database: ep.database, source: 'breadcrumb' }); }}>${ICONS.refresh}</button>
				` : nothing}
			</div>
		`;
	}

	private _renderExplorerContent(conn: KustoConnection, databases: string[], isLoading: boolean): TemplateResult {
		const ep = this._explorerPath;

		// Level 1: databases
		if (!ep?.database) {
			if (isLoading) return html`<div class="loading-state">${ICONS.spinner} Loading databases...</div>`;

			// Filter databases when Favorites filter is active
			let visibleDbs = databases;
			if (this._activeFilter === 'favorites') {
				const favDbs = new Set((this._snapshot?.favorites ?? []).filter(f => normalizeClusterUrl(f.clusterUrl) === normalizeClusterUrl(conn.clusterUrl)).map(f => f.database));
				visibleDbs = databases.filter(db => favDbs.has(db));
			}

			if (visibleDbs.length === 0) {return html`
				<div class="empty-state">
					<div class="empty-state-text">${this._activeFilter === 'favorites' ? 'No favorite databases in this cluster.' : 'No databases found.'}</div>
					${this._activeFilter !== 'favorites' ? html`<button class="btn" @click=${() => this._vscode.postMessage({ type: 'cluster.refreshDatabases', connectionId: conn.id })}>Refresh</button>` : nothing}
				</div>`;}

			return html`${visibleDbs.map(db => {
				const isFav = this._isFavorite(conn.clusterUrl, db);
				return html`
					<div class="explorer-list-item" @click=${() => this._navigateToDatabase(conn, db)}>
						<span class="explorer-list-item-icon database">${ICONS.database}</span>
						<span class="explorer-list-item-name">${db}</span>
						<div class="explorer-list-item-actions">
							<button class="btn-icon ${isFav ? 'is-favorite' : ''}" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}"
								@click=${(e: Event) => { e.stopPropagation(); this._toggleFavorite(conn, db, isFav); }}>
								${isFav ? ICONS.starFilled : ICONS.star}
							</button>
							<button class="btn-icon" title="Refresh"
								@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'cluster.refreshDatabases', connectionId: conn.id }); }}>${ICONS.refresh}</button>
							<button class="btn-icon" title="Open in new .kqlx file"
								@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'database.openInNewFile', clusterUrl: conn.clusterUrl, database: db }); }}>${ICONS.newFile}</button>
						</div>
					</div>`;
			})}`;
		}

		// Level 2: tables/functions overview
		const dbKey = conn.id + '|' + ep.database;
		const schema = this._databaseSchemas[dbKey];
		if (!schema) return html`<div class="loading-state">${ICONS.spinner} Loading schema...</div>`;

		if (!ep.section) {
			const tableCount = schema.tables?.length ?? 0;
			const fnCount = schema.functions?.length ?? 0;
			return html`
				${tableCount > 0 ? html`
					<div class="explorer-list-item" @click=${() => { this._explorerPath = { ...ep, section: 'tables', folderPath: [] }; }}>
						<span class="explorer-list-item-icon table">${ICONS.table}</span>
						<span class="explorer-list-item-name">Tables</span>
						<span class="explorer-list-item-meta">${tableCount}</span>
					</div>
				` : nothing}
				${fnCount > 0 ? html`
					<div class="explorer-list-item" @click=${() => { this._explorerPath = { ...ep, section: 'functions', folderPath: [] }; }}>
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
		const folders = Object.keys(currentNode).filter(k => k !== '__items').sort();
		const tables = (currentNode as any).__items as string[] ?? [];
		const dbKey = conn.id + '|' + ep.database;

		return html`
			${folders.map(f => {
				const childCount = this._countTreeItems(currentNode[f]);
				return html`
				<div class="explorer-list-item" @click=${() => { this._explorerPath = { ...ep, folderPath: [...(ep.folderPath ?? []), f] }; }}>
					<span class="explorer-list-item-icon folder">${ICONS.folder}</span>
					<span class="explorer-list-item-name">${f}</span>
					<span class="explorer-list-item-meta">${childCount} item${childCount !== 1 ? 's' : ''}</span>
				</div>`;
			})}
			${tables.map(table => {
				const cols = schema.columnTypesByTable?.[table] ?? {};
				const colNames = Object.keys(cols).sort();
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
									@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'database.refreshSchema', clusterUrl: conn.clusterUrl, database: ep.database, source: 'table' }); }}>${ICONS.refresh}</button>
							</div>
						</div>
						${isExpanded ? html`
							<div class="explorer-item-details">
								${docString ? html`<div class="explorer-detail-section"><div class="explorer-detail-label">Description</div><div class="explorer-detail-docstring">${docString}</div></div>` : nothing}
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
								${this._renderTablePreview(tableKey, table, previewData, conn, ep)}
							</div>
						` : nothing}
					</div>`;
			})}
			${folders.length === 0 && tables.length === 0 ? html`<div class="empty-state"><div class="empty-state-text">No tables in this folder.</div></div>` : nothing}
		`;
	}

	private _renderFunctionsLevel(schema: DatabaseSchema, ep: ExplorerPath): TemplateResult {
		const fnTree = this._buildFolderTree(schema.functions ?? [], (f: any) => f.folder);
		const currentNode = this._getTreeAtPath(fnTree, ep.folderPath ?? []);
		const folders = Object.keys(currentNode).filter(k => k !== '__items').sort();
		const functions = (currentNode as any).__items as Array<{ name: string; parametersText?: string; docString?: string; body?: string }> ?? [];
		const dbKey = (this._explorerPath?.connectionId ?? '') + '|' + ep.database;

		return html`
			${folders.map(f => {
				const childCount = this._countTreeItems(currentNode[f]);
				return html`
				<div class="explorer-list-item" @click=${() => { this._explorerPath = { ...ep, folderPath: [...(ep.folderPath ?? []), f] }; }}>
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
									@click=${(e: Event) => { const conn = this._snapshot?.connections?.find(c => c.id === this._explorerPath?.connectionId); if (!conn) return; e.stopPropagation(); this._vscode.postMessage({ type: 'database.refreshSchema', clusterUrl: conn.clusterUrl, database: ep.database, source: 'function' }); }}>${ICONS.refresh}</button>
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

	// ── SQL Content ───────────────────────────────────────────────────────────

	private _renderSqlContent(): TemplateResult {
		const sqlConnections = this._snapshot?.sqlConnections ?? [];
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
				<button class="filter-tab ${af === 'all' ? 'active' : ''}" data-testid="cm-sql-filter-all" @click=${() => { this._activeFilter = 'all'; this._validateSqlBreadcrumb(); }}>${ICONS.sqlServer} <span class="filter-label">All</span></button>
				${hasFavs ? html`<button class="filter-tab fav-tab ${af === 'favorites' ? 'active' : ''}" @click=${() => { this._activeFilter = af === 'favorites' ? 'all' : 'favorites'; this._validateSqlBreadcrumb(); }}>${ICONS.starFilled} <span class="filter-label">Favorites</span> <span class="filter-count">${sqlFavorites.length}</span></button>` : nothing}
				${hasLnt ? html`<button class="filter-tab lnt-tab ${af === 'lnt' ? 'active' : ''}" @click=${() => { this._activeFilter = af === 'lnt' ? 'all' : 'lnt'; this._validateSqlBreadcrumb(); }}>${ICONS.shield} <span class="filter-label">Leave No Trace</span> <span class="filter-count">${sqlLntIds.length}</span></button>` : nothing}
				<button class="filter-tab search-tab ${af === 'search' ? 'active' : ''}" data-testid="cm-sql-filter-search" @click=${() => { this._activeFilter = af === 'search' ? 'all' : 'search'; if (this._search.kind !== 'sql') this._search.setKind('sql'); }}>${ICONS.toolbarSearch} <span class="filter-label">Search</span></button>
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
				<div class="explorer-list-item" @click=${() => this._drillIntoSqlConnection(conn.id)}>
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
		this._sqlExplorerPath = { connectionId: connId };
		this._vscode.postMessage({ type: 'sql.cluster.expand', connectionId: connId });
	}

	private _renderSqlBreadcrumb(): TemplateResult {
		const ep = this._sqlExplorerPath;
		if (!ep) return html``;
		const conn = (this._snapshot?.sqlConnections ?? []).find(c => c.id === ep.connectionId);
		if (!conn) return html``;
		const rootLabel = this._activeFilter === 'favorites' ? 'Favorites' : this._activeFilter === 'lnt' ? 'Leave No Trace' : 'All';
		const rootIcon = this._activeFilter === 'favorites' ? ICONS.starFilled : this._activeFilter === 'lnt' ? ICONS.shield : ICONS.sqlServer;

		return html`
			<div class="explorer-breadcrumb">
				<button class="btn-icon breadcrumb-back" data-testid="cm-sql-breadcrumb-back" title="Go back" @click=${() => this._navigateSqlBack()}>${ICONS.arrowLeft}</button>
				<span class="breadcrumb-item" @click=${() => { this._sqlExplorerPath = null; }}>
					<span class="breadcrumb-icon">${rootIcon}</span>${rootLabel}
				</span>
				<span class="breadcrumb-separator">/</span>
				<span class="breadcrumb-item ${!ep.database ? 'current' : ''}" @click=${() => { this._sqlExplorerPath = { connectionId: conn.id }; }}>
					<span class="breadcrumb-icon">${ICONS.sqlServer}</span>${conn.name}
				</span>
				${!ep.database ? html`
					<button class="btn-icon breadcrumb-refresh" title="Refresh databases"
						@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'sql.cluster.refreshDatabases', connectionId: conn.id }); }}>${this._sqlLoadingDatabases.has(conn.id) ? ICONS.spinner : ICONS.refresh}</button>
				` : nothing}
				${ep.database ? html`
					<span class="breadcrumb-separator">/</span>
					<span class="breadcrumb-item ${!ep.section ? 'current' : ''}" @click=${() => { this._sqlExplorerPath = { ...ep, section: undefined, folderPath: undefined }; }}>
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
						@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'sql.database.refreshSchema', connectionId: conn.id, database: ep.database, source: 'breadcrumb' }); }}>${ICONS.refresh}</button>
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

		// Level 1: databases
		if (!ep.database) {
			if (isLoading) return html`<div class="loading-state">${ICONS.spinner} Loading databases...</div>`;

			// Filter databases when Favorites filter is active
			let visibleDbs = databases;
			if (this._activeFilter === 'favorites') {
				const favDbs = new Set((this._snapshot?.sqlFavorites ?? []).filter(f => f.connectionId === conn.id).map(f => f.database));
				visibleDbs = databases.filter(db => favDbs.has(db));
			}

			if (visibleDbs.length === 0) {
				return html`<div class="empty-state">
					<div class="empty-state-text">${this._activeFilter === 'favorites' ? 'No favorite databases in this connection.' : 'No databases found.'}</div>
					${this._activeFilter !== 'favorites' ? html`<button class="btn" @click=${() => this._vscode.postMessage({ type: 'sql.cluster.refreshDatabases', connectionId: conn.id })}>Refresh</button>` : nothing}
				</div>`;
			}
			return html`${visibleDbs.map(db => {
				const isFav = this._isSqlFavorite(conn.id, db);
				return html`
					<div class="explorer-list-item" @click=${() => this._navigateToSqlDatabase(conn, db)}>
						<span class="explorer-list-item-icon database">${ICONS.database}</span>
						<span class="explorer-list-item-name">${db}</span>
						<div class="explorer-list-item-actions">
							<button class="btn-icon ${isFav ? 'is-favorite' : ''}" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}"
								@click=${(e: Event) => { e.stopPropagation(); this._toggleSqlFavorite(conn, db, isFav); }}>
								${isFav ? ICONS.starFilled : ICONS.star}
							</button>
							<button class="btn-icon" title="Refresh" @click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'sql.cluster.refreshDatabases', connectionId: conn.id }); }}>${ICONS.refresh}</button>
							<button class="btn-icon" title="Open in new .sqlx file" @click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'sql.database.openInNewFile', serverUrl: conn.serverUrl, database: db }); }}>${ICONS.newFile}</button>
						</div>
					</div>`;
			})}`;
		}

		// Level 2: tables overview
		const dbKey = conn.id + '|' + ep.database;
		const schema = this._sqlDatabaseSchemas[dbKey];
		if (!schema) return html`<div class="loading-state">${ICONS.spinner} Loading schema...</div>`;

		if (!ep.section) {
			const tableCount = schema.tables?.length ?? 0;
			const viewCount = schema.views?.length ?? 0;
			const spCount = schema.storedProcedures?.length ?? 0;
			return html`
				${tableCount > 0 ? html`
					<div class="explorer-list-item" @click=${() => { this._sqlExplorerPath = { ...ep, section: 'tables' }; }}>
						<span class="explorer-list-item-icon table">${ICONS.table}</span>
						<span class="explorer-list-item-name">Tables</span>
						<span class="explorer-list-item-meta">${tableCount}</span>
					</div>
				` : nothing}
				${viewCount > 0 ? html`
					<div class="explorer-list-item" @click=${() => { this._sqlExplorerPath = { ...ep, section: 'views' }; }}>
						<span class="explorer-list-item-icon table">${ICONS.table}</span>
						<span class="explorer-list-item-name">Views</span>
						<span class="explorer-list-item-meta">${viewCount}</span>
					</div>
				` : nothing}
				${spCount > 0 ? html`
					<div class="explorer-list-item" @click=${() => { this._sqlExplorerPath = { ...ep, section: 'functions' }; }}>
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
		this._sqlExplorerPath = { connectionId: conn.id, database: db };
		const dbKey = conn.id + '|' + db;
		if (!this._sqlDatabaseSchemas[dbKey]) {
			this._vscode.postMessage({ type: 'sql.database.getSchema', connectionId: conn.id, database: db });
		}
	}

	private _isSqlFavorite(connectionId: string, database: string): boolean {
		if (!this._snapshot?.sqlFavorites) return false;
		const nDb = database.toLowerCase();
		return this._snapshot.sqlFavorites.some(f => f.connectionId === connectionId && f.database.toLowerCase() === nDb);
	}

	private _toggleSqlFavorite(conn: SqlConnectionInfo, db: string, isFav: boolean): void {
		if (isFav) {
			this._vscode.postMessage({ type: 'sql.favorite.remove', connectionId: conn.id, database: db });
		} else {
			this._vscode.postMessage({ type: 'sql.favorite.add', connectionId: conn.id, database: db, name: conn.name });
		}
		this._vscode.postMessage({ type: 'requestSnapshot' });
	}

	/** Trim SQL breadcrumb depth so it stays valid when a filter changes. */
	private _validateSqlBreadcrumb(): void {
		const ep = this._sqlExplorerPath;
		if (!ep?.connectionId) return;

		const connections = this._snapshot?.sqlConnections ?? [];
		const conn = connections.find(c => c.id === ep.connectionId);
		if (!conn) { this._sqlExplorerPath = null; return; }

		if (this._activeFilter === 'favorites') {
			const favConnIds = new Set((this._snapshot?.sqlFavorites ?? []).map(f => f.connectionId));
			if (!favConnIds.has(conn.id)) { this._sqlExplorerPath = null; return; }
			if (ep.database) {
				const favDbs = new Set((this._snapshot?.sqlFavorites ?? []).filter(f => f.connectionId === conn.id).map(f => f.database));
				if (!favDbs.has(ep.database)) { this._sqlExplorerPath = { connectionId: ep.connectionId }; return; }
			}
		}
		if (this._activeFilter === 'lnt') {
			const lntSet = new Set(this._snapshot?.sqlLeaveNoTrace ?? []);
			if (!lntSet.has(conn.id)) { this._sqlExplorerPath = null; return; }
		}
	}

	private _renderSqlTablesLevel(conn: SqlConnectionInfo, schema: SqlDatabaseSchema, ep: ExplorerPath): TemplateResult {
		const tables = (schema.tables ?? []).sort();
		const dbKey = conn.id + '|' + ep.database;

		return html`
			${tables.map(table => {
				const cols = schema.columnsByTable?.[table] ?? {};
				const colNames = Object.keys(cols).sort();
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
									@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'sql.database.refreshSchema', connectionId: conn.id, database: ep.database }); }}>${ICONS.refresh}</button>
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
								${this._renderSqlTablePreview(tableKey, table, previewData, conn, ep)}
							</div>
						` : nothing}
					</div>`;
			})}
			${tables.length === 0 ? html`<div class="empty-state"><div class="empty-state-text">No tables found.</div></div>` : nothing}
		`;
	}

	private _renderSqlViewsLevel(conn: SqlConnectionInfo, schema: SqlDatabaseSchema, ep: ExplorerPath): TemplateResult {
		const views = (schema.views ?? []).sort();
		const dbKey = conn.id + '|' + ep.database;

		return html`
			${views.map(view => {
				const cols = schema.columnsByTable?.[view] ?? {};
				const colNames = Object.keys(cols).sort();
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
									@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'sql.database.refreshSchema', connectionId: conn.id, database: ep.database, source: 'view' }); }}>${ICONS.refresh}</button>
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
		const procedures = schema.storedProcedures ?? [];
		const dbKey = (this._sqlExplorerPath?.connectionId ?? '') + '|' + ep.database;
		const connectionId = this._sqlExplorerPath?.connectionId ?? '';

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
									@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'sql.database.refreshSchema', connectionId, database: ep.database, source: 'stored procedure' }); }}>${ICONS.refresh}</button>
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
			<div class="modal-overlay" data-testid="cm-modal-overlay" @click=${() => this._closeModal()}>
				<div class="modal-content" data-testid="cm-modal-content" @click=${(e: Event) => e.stopPropagation()}>
					<div class="modal-header">
						<h2>${this._modalMode === 'edit' ? 'Edit Connection' : 'Add Connection'}</h2>
						<button class="btn-icon" @click=${() => this._closeModal()}>${ICONS.close}</button>
					</div>
					<div class="modal-body">
						<kw-kusto-connection-form
							.mode=${this._modalMode}
							.name=${this._modalName}
							.clusterUrl=${this._modalUrl}
							.database=${this._modalDb}
							.showTestButton=${!!this._editingConnectionId}
							.testResult=${this._testResult}
							@connection-form-submit=${this._onKustoFormSubmit}
							@connection-form-cancel=${() => this._closeModal()}
							@connection-form-test=${() => this._testConnection()}
						></kw-kusto-connection-form>
					</div>
					<div class="modal-footer">
						<button class="btn" @click=${() => this._closeModal()}>Cancel</button>
						<button class="btn primary" @click=${() => this._submitKustoForm()}>Save</button>
					</div>
				</div>
			</div>
		`;
	}

	private _renderSqlModal(): TemplateResult {
		const dialects = this._snapshot?.sqlDialects ?? [];
		const isEditing = !!this._editingConnectionId;

		return html`
			<div class="modal-overlay" @click=${() => this._closeModal()}>
				<div class="modal-content" @click=${(e: Event) => e.stopPropagation()}>
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
							@sql-connection-form-test=${() => this._testSqlConnection()}
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
		this._explorerPath = null;
		this._vscode.postMessage({ type: 'cluster.expand', connectionId: connId });
	}

	private _selectFavorite(fav: KustoFavorite, conn: KustoConnection | undefined): void {
		if (conn) {
			this._selectedConnectionId = conn.id;
			this._explorerPath = { connectionId: conn.id, database: fav.database };
			this._vscode.postMessage({ type: 'cluster.expand', connectionId: conn.id });
			const dbKey = conn.id + '|' + fav.database;
			if (!this._databaseSchemas[dbKey]) {
				this._vscode.postMessage({ type: 'database.getSchema', connectionId: conn.id, database: fav.database });
			}
		}
	}

	private _navigateToDatabase(conn: KustoConnection, db: string): void {
		this._explorerPath = { connectionId: conn.id, database: db };
		const dbKey = conn.id + '|' + db;
		if (!this._databaseSchemas[dbKey]) {
			this._vscode.postMessage({ type: 'database.getSchema', connectionId: conn.id, database: db });
		}
	}

	private _toggleFavorite(conn: KustoConnection, db: string, isFav: boolean): void {
		if (isFav) {
			this._vscode.postMessage({ type: 'favorite.remove', clusterUrl: conn.clusterUrl, database: db });
		} else {
			this._vscode.postMessage({ type: 'favorite.add', clusterUrl: conn.clusterUrl, database: db, name: conn.name });
		}
		this._vscode.postMessage({ type: 'requestSnapshot' });
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
		this._modalMode = mode;
		this._editingConnectionId = connId ?? null;
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
			}
		} else {
			// Kusto modal
			if (mode === 'edit' && connId && this._snapshot) {
				const conn = this._snapshot.connections.find(c => c.id === connId);
				if (conn) {
					this._modalName = conn.name || '';
					this._modalUrl = conn.clusterUrl || '';
					this._modalDb = conn.database || '';
				}
			} else {
				this._modalName = '';
				this._modalUrl = '';
				this._modalDb = '';
			}
		}
		this._modalVisible = true;
	}

	private _closeModal(): void {
		this._modalVisible = false;
		this._editingConnectionId = null;
	}

	private _testConnection(): void {
		if (!this._editingConnectionId) return;
		this._vscode.postMessage({ type: 'connection.test', id: this._editingConnectionId });
	}

	private _testSqlConnection(): void {
		if (!this._editingConnectionId) return;
		const payload: Record<string, unknown> = { id: this._editingConnectionId };
		// Pass password if authType is sql-login and password was changed
		if (this._modalAuthType === 'sql-login' && this._modalChangePassword && this._modalPassword) {
			payload.password = this._modalPassword;
		}
		this._vscode.postMessage({ type: 'sql.connection.test', ...payload });
	}

	private _onModalKeydown = (e: KeyboardEvent) => {
		// Escape on the overlay level (form handles Enter/Escape internally,
		// but clicks on overlay backdrop don't go through the form)
		if (e.key === 'Escape') { this._closeModal(); e.preventDefault(); }
	};

	private _onKustoFormSubmit(e: CustomEvent<KustoConnectionFormSubmitDetail>): void {
		const { name, clusterUrl, database } = e.detail;
		if (!clusterUrl) return;
		if (this._editingConnectionId) {
			this._vscode.postMessage({ type: 'connection.edit', id: this._editingConnectionId, name, clusterUrl, database });
		} else {
			this._vscode.postMessage({ type: 'connection.add', name, clusterUrl, database });
		}
		this._closeModal();
		setTimeout(() => this._vscode.postMessage({ type: 'requestSnapshot' }), 100);
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
			this._explorerPath = { ...ep, folderPath: ep.folderPath.slice(0, -1) };
		} else if (ep.section) {
			this._explorerPath = { ...ep, section: undefined, folderPath: undefined, tableName: undefined };
		} else if (ep.database) {
			this._explorerPath = { connectionId: ep.connectionId };
		} else {
			this._explorerPath = null;
		}
	}

	private _navigateSqlBack(): void {
		const ep = this._sqlExplorerPath;
		if (!ep) return;
		if (ep.section) {
			this._sqlExplorerPath = { ...ep, section: undefined, folderPath: undefined };
		} else if (ep.database) {
			this._sqlExplorerPath = { connectionId: ep.connectionId };
		} else {
			this._sqlExplorerPath = null;
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
						<button class="search-refresh-drop ${this._refreshMenuOpen ? 'active' : ''}" @click=${() => { this._refreshMenuOpen = !this._refreshMenuOpen; }}>
							${ICONS.chevron}
						</button>
						${this._refreshMenuOpen ? html`
							<div class="search-refresh-menu">
								<button class="search-tools-item" @click=${() => { this._refreshMenuOpen = false; s.refreshCachedAndSearch(); }}>
									<div class="search-tools-item-title">Refresh connections with cached schemas <span class="search-tools-count">(${cachedCount})</span></div>
									<div class="search-tools-item-desc">These are connections you typically use. Use this to pick up very recent schema changes in them (new tables, etc.) before you use search.</div>
								</button>
								<button class="search-tools-item" @click=${() => { this._refreshMenuOpen = false; s.refreshAllAndSearch(); }}>
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
				const colNames = Object.keys(cols).sort();
				const docString = schema.tableDocStrings?.[r.name];
				const conn = this._snapshot?.connections?.find(c => c.id === r.connectionId);
				const ep: ExplorerPath = { connectionId: r.connectionId, database: r.database };
				const previewData = this._tablePreviewData[tableKey];
				return html`<div class="explorer-item-details">
					${docString ? html`<div class="explorer-detail-section"><div class="explorer-detail-label">Description</div><div class="explorer-detail-docstring">${docString}</div></div>` : nothing}
					${colNames.length > 0 ? html`<div class="explorer-detail-section"><div class="explorer-detail-label">Schema (${colNames.length} columns)</div><div class="explorer-detail-schema">${colNames.map(col => html`<div class="explorer-schema-row"><span class="explorer-schema-col-name">${col}</span><span class="explorer-schema-col-type">${cols[col]}</span></div>`)}</div></div>` : nothing}
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
				const colNames = Object.keys(cols).sort();
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
		this._activeFilter = 'all';
		if (r.kind === 'kusto') {
			if (r.category === 'cluster' || r.category === 'database') {
				this._explorerPath = r.database ? { connectionId: r.connectionId, database: r.database } : { connectionId: r.connectionId };
				this._vscode.postMessage({ type: 'cluster.expand', connectionId: r.connectionId });
				if (r.database) {
					const dbKey = r.connectionId + '|' + r.database;
					if (!this._databaseSchemas[dbKey]) {
						this._vscode.postMessage({ type: 'database.getSchema', connectionId: r.connectionId, database: r.database });
					}
				}
			} else if (r.category === 'table' || r.category === 'column') {
				this._explorerPath = { connectionId: r.connectionId, database: r.database, section: 'tables', folderPath: [] };
				this._vscode.postMessage({ type: 'cluster.expand', connectionId: r.connectionId });
				if (r.database) {
					const dbKey = r.connectionId + '|' + r.database;
					if (!this._databaseSchemas[dbKey]) {
						this._vscode.postMessage({ type: 'database.getSchema', connectionId: r.connectionId, database: r.database });
					}
				}
			} else if (r.category === 'function') {
				this._explorerPath = { connectionId: r.connectionId, database: r.database, section: 'functions', folderPath: [] };
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
				this._sqlExplorerPath = r.database ? { connectionId: r.connectionId, database: r.database } : { connectionId: r.connectionId };
				this._vscode.postMessage({ type: 'sql.cluster.expand', connectionId: r.connectionId });
				if (r.database) {
					const dbKey = r.connectionId + '|' + r.database;
					if (!this._sqlDatabaseSchemas[dbKey]) {
						this._vscode.postMessage({ type: 'sql.database.getSchema', connectionId: r.connectionId, database: r.database });
					}
				}
			} else if (r.category === 'table' || r.category === 'column') {
				this._sqlExplorerPath = { connectionId: r.connectionId, database: r.database, section: 'tables' };
				this._vscode.postMessage({ type: 'sql.cluster.expand', connectionId: r.connectionId });
				if (r.database) {
					const dbKey = r.connectionId + '|' + r.database;
					if (!this._sqlDatabaseSchemas[dbKey]) {
						this._vscode.postMessage({ type: 'sql.database.getSchema', connectionId: r.connectionId, database: r.database });
					}
				}
			} else if (r.category === 'view') {
				this._sqlExplorerPath = { connectionId: r.connectionId, database: r.database, section: 'views' };
				this._vscode.postMessage({ type: 'sql.cluster.expand', connectionId: r.connectionId });
				if (r.database) {
					const dbKey = r.connectionId + '|' + r.database;
					if (!this._sqlDatabaseSchemas[dbKey]) {
						this._vscode.postMessage({ type: 'sql.database.getSchema', connectionId: r.connectionId, database: r.database });
					}
				}
			} else if (r.category === 'stored-procedure') {
				this._sqlExplorerPath = { connectionId: r.connectionId, database: r.database, section: 'functions' };
				this._vscode.postMessage({ type: 'sql.cluster.expand', connectionId: r.connectionId });
				if (r.database) {
					const dbKey = r.connectionId + '|' + r.database;
					if (!this._sqlDatabaseSchemas[dbKey]) {
						this._vscode.postMessage({ type: 'sql.database.getSchema', connectionId: r.connectionId, database: r.database });
					}
				}
			}
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
