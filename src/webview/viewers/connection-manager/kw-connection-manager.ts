import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { styles } from './kw-connection-manager.styles.js';
import { customElement, state } from 'lit/decorators.js';
import { ICONS } from '../../components/icons.js';

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
	connections: KustoConnection[];
	favorites: KustoFavorite[];
	cachedDatabases: Record<string, string[]>;
	expandedClusters: string[];
	leaveNoTraceClusters: string[];
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
	section?: 'tables' | 'functions' | 'table-columns';
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
	@state() private _filterFavorites = false;
	@state() private _filterLnt = false;

	// Modal state
	@state() private _modalVisible = false;
	@state() private _modalMode: 'add' | 'edit' = 'add';
	@state() private _editingConnectionId: string | null = null;
	@state() private _modalName = '';
	@state() private _modalUrl = '';
	@state() private _modalDb = '';
	@state() private _testResult = '';

	// ── VS Code API ───────────────────────────────────────────────────────────

	private _vscode!: VsCodeApi;

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	connectedCallback(): void {
		super.connectedCallback();
		this._vscode = acquireVsCodeApi();
		window.addEventListener('message', this._onMessage);
		this._vscode.postMessage({ type: 'requestSnapshot' });
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		window.removeEventListener('message', this._onMessage);
	}

	// ── Message handling ──────────────────────────────────────────────────────

	private _onMessage = (event: MessageEvent) => {
		const msg = event.data;
		if (!msg) return;

		switch (msg.type) {
			case 'snapshot':
				this._snapshot = msg.snapshot;
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
		}
	};

	// ── Computed helpers ──────────────────────────────────────────────────────

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
		const favorites = this._snapshot?.favorites ?? [];
		const lntClusters = this._snapshot?.leaveNoTraceClusters ?? [];
		const hasFavs = favorites.length > 0;
		const hasLnt = lntClusters.length > 0;
		const favClusterUrls = new Set(favorites.map(f => normalizeClusterUrl(f.clusterUrl)));

		// Apply filters
		let visibleConnections = connections;
		if (this._filterFavorites) {
			visibleConnections = connections.filter(c => favClusterUrls.has(normalizeClusterUrl(c.clusterUrl)));
		}
		if (this._filterLnt) {
			const lntUrls = new Set(lntClusters.map(u => normalizeClusterUrl(u)));
			visibleConnections = visibleConnections.filter(c => lntUrls.has(normalizeClusterUrl(c.clusterUrl)));
		}

		return html`
			<div class="page-header">
				<h1>Connection Manager</h1>
				<div class="title-actions">
					<button class="header-btn primary" @click=${() => this._openModal('add')}>
						${ICONS.add} Add connection
					</button>
					<button class="header-btn" @click=${() => this._vscode.postMessage({ type: 'connection.importXml' })}>
						${ICONS.importIcon} Import
					</button>
					<button class="header-btn" @click=${() => this._vscode.postMessage({ type: 'connection.exportXml' })}>
						${ICONS.save} Export
					</button>
				</div>
			</div>

			<div class="explorer-panel">
				<!-- Filter tabs -->
				${hasFavs || hasLnt ? html`
				<div class="filter-bar">
					<button class="filter-tab ${!this._filterFavorites && !this._filterLnt ? 'active' : ''}" @click=${() => { this._filterFavorites = false; this._filterLnt = false; this._validateBreadcrumb(); }}>${ICONS.cluster} <span class="filter-label">All</span></button>
					${hasFavs ? html`<button class="filter-tab fav-tab ${this._filterFavorites ? 'active' : ''}" @click=${() => { this._filterFavorites = !this._filterFavorites; this._filterLnt = false; this._validateBreadcrumb(); }}>${ICONS.starFilled} <span class="filter-label">Favorites</span> <span class="filter-count">${favorites.length}</span></button>` : nothing}
					${hasLnt ? html`<button class="filter-tab lnt-tab ${this._filterLnt ? 'active' : ''}" @click=${() => { this._filterLnt = !this._filterLnt; this._filterFavorites = false; this._validateBreadcrumb(); }}>${ICONS.shield} <span class="filter-label">Leave No Trace</span> <span class="filter-count">${lntClusters.length}</span></button>` : nothing}
				</div>
				` : nothing}

				<!-- Breadcrumb (when drilled in) -->
				${this._explorerPath?.connectionId ? this._renderBreadcrumbBar() : nothing}

				<!-- Explorer content -->
				<div class="explorer-content">
					${this._explorerPath?.connectionId ? this._renderDrilledContent() : this._renderClusterList(visibleConnections, favClusterUrls, lntClusters)}
				</div>
			</div>

			${this._modalVisible ? this._renderModal() : nothing}
		`;
	}

	// ── Cluster list (root level — flat, click to drill in) ──────────────────

	private _renderClusterList(connections: KustoConnection[], favClusterUrls: Set<string>, lntClusters: string[]): TemplateResult {
		if (connections.length === 0) {
			const hasFilter = this._filterFavorites || this._filterLnt;
			return html`<div class="empty-state">
				<div class="empty-state-icon">${ICONS.cluster}</div>
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
					<span class="explorer-list-item-icon">${ICONS.cluster}</span>
					<span class="explorer-list-item-name">${conn.name || shortClusterName(conn.clusterUrl)}</span>
					${hasFav ? html`<span class="conn-badge fav-badge" title="Has favorites">${ICONS.starFilled}</span>` : nothing}
					${isLnt ? html`<span class="conn-badge lnt-badge" title="Leave No Trace">${ICONS.shield}</span>` : nothing}
					<span class="item-sep">·</span>
					<span class="explorer-list-item-url">${fullUrl}</span>
					<span class="item-sep">·</span>
					<span class="explorer-list-item-meta">${dbCount > 0 ? `${dbCount} database${dbCount !== 1 ? 's' : ''}` : 'click to explore'}</span>
					<div class="explorer-list-item-actions">
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
		if (this._filterFavorites) {
			const favUrls = new Set((this._snapshot?.favorites ?? []).map(f => normalizeClusterUrl(f.clusterUrl)));
			if (!favUrls.has(normalizeClusterUrl(conn.clusterUrl))) { this._explorerPath = null; return; }
			// If drilled into a database, check if it's a favorite
			if (ep.database) {
				const favDbs = new Set((this._snapshot?.favorites ?? []).filter(f => normalizeClusterUrl(f.clusterUrl) === normalizeClusterUrl(conn.clusterUrl)).map(f => f.database));
				if (!favDbs.has(ep.database)) { this._explorerPath = { connectionId: ep.connectionId } as any; return; }
			}
		}
		if (this._filterLnt) {
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
		const rootLabel = this._filterFavorites ? 'Favorites' : this._filterLnt ? 'Leave No Trace' : 'All';
		const rootIcon = this._filterFavorites ? ICONS.starFilled : this._filterLnt ? ICONS.shield : ICONS.cluster;
		return html`
			<div class="explorer-breadcrumb">
				<span class="breadcrumb-item" @click=${() => { this._explorerPath = null; }}>
					<span class="breadcrumb-icon">${rootIcon}</span>${rootLabel}
				</span>
				<span class="breadcrumb-separator">/</span>
				<span class="breadcrumb-item ${!ep?.database ? 'current' : ''}" @click=${() => { this._explorerPath = { connectionId: conn.id, database: undefined } as any; }}>
					<span class="breadcrumb-icon">${ICONS.cluster}</span>${conn.name}
				</span>
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
			if (this._filterFavorites) {
				const favDbs = new Set((this._snapshot?.favorites ?? []).filter(f => normalizeClusterUrl(f.clusterUrl) === normalizeClusterUrl(conn.clusterUrl)).map(f => f.database));
				visibleDbs = databases.filter(db => favDbs.has(db));
			}

			if (visibleDbs.length === 0) {return html`
				<div class="empty-state">
					<div class="empty-state-text">${this._filterFavorites ? 'No favorite databases in this cluster.' : 'No databases found.'}</div>
					${!this._filterFavorites ? html`<button class="btn" @click=${() => this._vscode.postMessage({ type: 'cluster.refreshDatabases', connectionId: conn.id })}>Refresh</button>` : nothing}
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
			if (data.rows.length === 0) return html`<div class="explorer-detail-section"><div style="font-size: 11px; opacity: 0.7; padding: 4px 0;">Table is empty.</div></div>`;
			const dtColumns = data.columns.map((c: any) => ({ name: typeof c === 'string' ? c : c.name ?? '', type: typeof c === 'object' ? c.type : undefined }));
			return html`
				<div class="explorer-detail-section">
					<div class="preview-result">
						<div class="preview-result-header">
							<span class="preview-result-info">PREVIEW TOP 100 ROWS</span>
							<button class="preview-result-dismiss" title="Dismiss" @click=${() => { const next = { ...this._tablePreviewData }; delete next[tableKey]; this._tablePreviewData = next; }}>${ICONS.close}</button>
						</div>
						<div class="preview-table-container">
							<kw-data-table style="height:500px"
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

	// ── Modal ─────────────────────────────────────────────────────────────────

	private _renderModal(): TemplateResult {
		return html`
			<div class="modal-overlay" @click=${() => this._closeModal()}>
				<div class="modal-content" @click=${(e: Event) => e.stopPropagation()} @keydown=${this._onModalKeydown}>
					<div class="modal-header">
						<h2>${this._modalMode === 'edit' ? 'Edit Connection' : 'Add Connection'}</h2>
						<button class="btn-icon" @click=${() => this._closeModal()}>${ICONS.close}</button>
					</div>
					<div class="modal-body">
						<div class="form-group">
							<label>Connection Name *</label>
							<input type="text" .value=${this._modalName} @input=${(e: Event) => this._modalName = (e.target as HTMLInputElement).value} placeholder="My Cluster" />
						</div>
						<div class="form-group">
							<label>Cluster URL *</label>
							<input type="text" .value=${this._modalUrl} @input=${(e: Event) => this._modalUrl = (e.target as HTMLInputElement).value} placeholder="https://mycluster.kusto.windows.net" />
						</div>
						<div class="form-group">
							<label>Default Database</label>
							<input type="text" .value=${this._modalDb} @input=${(e: Event) => this._modalDb = (e.target as HTMLInputElement).value} placeholder="(optional)" />
						</div>
						${this._editingConnectionId ? html`
							<button class="btn" @click=${() => this._testConnection()}>Test Connection</button>
							${this._testResult === 'loading' ? html`<div class="test-result">${ICONS.spinner} Testing connection...</div>` : this._testResult ? html`<div class="test-result">${this._testResult}</div>` : nothing}
						` : nothing}
					</div>
					<div class="modal-footer">
						<button class="btn" @click=${() => this._closeModal()}>Cancel</button>
						<button class="btn primary" @click=${() => this._saveConnection()}>Save</button>
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
		this._modalVisible = true;
	}

	private _closeModal(): void {
		this._modalVisible = false;
		this._editingConnectionId = null;
	}

	private _saveConnection(): void {
		if (!this._modalName.trim() || !this._modalUrl.trim()) return;
		if (this._editingConnectionId) {
			this._vscode.postMessage({ type: 'connection.edit', id: this._editingConnectionId, name: this._modalName.trim(), clusterUrl: this._modalUrl.trim(), database: this._modalDb.trim() || undefined });
		} else {
			this._vscode.postMessage({ type: 'connection.add', name: this._modalName.trim(), clusterUrl: this._modalUrl.trim(), database: this._modalDb.trim() || undefined });
		}
		this._closeModal();
		setTimeout(() => this._vscode.postMessage({ type: 'requestSnapshot' }), 100);
	}

	private _testConnection(): void {
		if (!this._editingConnectionId) return;
		this._vscode.postMessage({ type: 'connection.test', id: this._editingConnectionId });
	}

	private _onModalKeydown = (e: KeyboardEvent) => {
		if (e.key === 'Enter') { this._saveConnection(); e.preventDefault(); }
		if (e.key === 'Escape') { this._closeModal(); e.preventDefault(); }
	};

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

	static styles = styles;
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-connection-manager': KwConnectionManager;
	}
}
