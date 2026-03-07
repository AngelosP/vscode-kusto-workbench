import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
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
	@state() private _expandedAccordion: 'favorites' | 'leaveNoTrace' | 'connections' = 'connections';
	@state() private _sidebarCollapsed = false;
	@state() private _sidebarWidth = 280;

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
		return html`
			<h1>Connection Manager</h1>
			<div class="title-actions">
				<button class="btn primary" @click=${() => this._openModal('add')}>
					${ICONS.add} Add new connection
				</button>
				<button class="btn" @click=${() => this._vscode.postMessage({ type: 'connection.importXml' })}>
					${ICONS.importIcon} Import connections
				</button>
			</div>

			<div class="main-container">
				<!-- Left Panel -->
				<div class="left-panel ${this._sidebarCollapsed ? 'collapsed' : ''}" style="width: ${this._sidebarWidth}px">
					${this._renderFavoritesAccordion()}
					${this._renderLeaveNoTraceAccordion()}
					${this._renderConnectionsAccordion()}
				</div>

				<!-- Splitter -->
				<div class="splitter">
					<button class="splitter-collapse-btn" type="button" title="Toggle sidebar" @click=${() => this._sidebarCollapsed = !this._sidebarCollapsed}>
						${ICONS.sidebar}
					</button>
				</div>

				<!-- Right Panel -->
				<div class="right-panel">
					<div class="right-panel-header">
						<button class="btn-icon" title="Toggle sidebar" @click=${() => this._sidebarCollapsed = !this._sidebarCollapsed}>
							${ICONS.sidebar}
						</button>
						<span class="right-panel-title">Cluster Explorer</span>
					</div>
					${this._renderExplorer()}
				</div>
			</div>

			${this._sidebarCollapsed ? html`
				<button class="panel-toggle" type="button" title="Show sidebar" @click=${() => this._sidebarCollapsed = false}>
					${ICONS.sidebar}
				</button>
			` : nothing}

			${this._modalVisible ? this._renderModal() : nothing}
		`;
	}

	// ── Left Panel: Favorites Accordion ───────────────────────────────────────

	private _renderFavoritesAccordion(): TemplateResult | typeof nothing {
		const snap = this._snapshot;
		const dbFavorites = (snap?.favorites ?? []).filter(f => f.database && f.clusterUrl);
		if (dbFavorites.length === 0) return nothing;

		const isExpanded = this._expandedAccordion === 'favorites';
		const connectionsByUrl: Record<string, KustoConnection> = {};
		for (const c of snap?.connections ?? []) {
			const key = normalizeClusterUrl(c.clusterUrl);
			if (key && !connectionsByUrl[key]) connectionsByUrl[key] = c;
		}

		return html`
			<div class="left-accordion-item ${isExpanded ? 'expanded' : ''}">
				<div class="left-accordion-header" @click=${() => this._toggleAccordion('favorites')}>
					<span class="left-accordion-chevron">${ICONS.chevron}</span>
					<span class="left-accordion-icon fav-icon">${ICONS.starFilled}</span>
					<span class="left-accordion-title">FAVORITES</span>
					<span class="left-accordion-count">${dbFavorites.length}</span>
				</div>
				${isExpanded ? html`
					<div class="left-accordion-body">
						${dbFavorites.map(fav => {
							const conn = connectionsByUrl[normalizeClusterUrl(fav.clusterUrl)];
							const displayName = fav.name || conn?.name || shortClusterName(fav.clusterUrl);
							const detail = shortClusterName(fav.clusterUrl) + '.' + fav.database;
							return html`
								<div class="favorite-item" title="${displayName} — ${detail}"
									@click=${() => this._selectFavorite(fav, conn)}>
									<div class="favorite-row">
										<div class="favorite-name">${displayName}</div>
										<div class="favorite-actions">
											<button class="btn-icon" title="Open in new .kqlx file"
												@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'database.openInNewFile', clusterUrl: fav.clusterUrl, database: fav.database }); }}>${ICONS.newFile}</button>
											<button class="btn-icon" title="Refresh schema"
												@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'database.refreshSchema', clusterUrl: fav.clusterUrl, database: fav.database }); }}>${ICONS.refresh}</button>
											<button class="btn-icon" title="Remove from favorites"
												@click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'favorite.remove', clusterUrl: fav.clusterUrl, database: fav.database }); this._vscode.postMessage({ type: 'requestSnapshot' }); }}>${ICONS.delete}</button>
										</div>
									</div>
									<div class="favorite-detail">${detail}</div>
								</div>`;
						})}
					</div>
				` : nothing}
			</div>
		`;
	}

	// ── Left Panel: Leave No Trace Accordion ──────────────────────────────────

	private _renderLeaveNoTraceAccordion(): TemplateResult | typeof nothing {
		const lntClusters = this._snapshot?.leaveNoTraceClusters ?? [];
		if (lntClusters.length === 0) return nothing;

		const isExpanded = this._expandedAccordion === 'leaveNoTrace';

		return html`
			<div class="left-accordion-item ${isExpanded ? 'expanded' : ''}">
				<div class="left-accordion-header" @click=${() => this._toggleAccordion('leaveNoTrace')}>
					<span class="left-accordion-chevron">${ICONS.chevron}</span>
					<span class="left-accordion-icon lnt-icon">${ICONS.shield}</span>
					<span class="left-accordion-title">LEAVE NO TRACE</span>
					<span class="left-accordion-count">${lntClusters.length}</span>
				</div>
				${isExpanded ? html`
					<div class="left-accordion-body">
						${lntClusters.map(lntUrl => {
							const connName = this._snapshot?.connections?.find(c => normalizeClusterUrl(c.clusterUrl) === normalizeClusterUrl(lntUrl))?.name || shortClusterName(lntUrl);
							return html`
								<div class="favorite-item">
									<div class="favorite-row">
								<span class="lnt-icon">${ICONS.shield}</span>
								<span class="favorite-name">${connName}</span>
								<div class="favorite-actions">
									<button class="btn-icon" title="Remove from Leave No Trace"
										@click=${() => { this._vscode.postMessage({ type: 'leaveNoTrace.remove', clusterUrl: lntUrl }); }}>${ICONS.delete}</button>
										</div>
									</div>
									<div class="favorite-detail">${lntUrl}</div>
								</div>`;
						})}
					</div>
				` : nothing}
			</div>
		`;
	}

	// ── Left Panel: Connections Accordion ──────────────────────────────────────

	private _renderConnectionsAccordion(): TemplateResult {
		const connections = this._snapshot?.connections ?? [];
		const isExpanded = this._expandedAccordion === 'connections';

		return html`
			<div class="left-accordion-item ${isExpanded ? 'expanded' : ''}">
				<div class="left-accordion-header" @click=${() => this._toggleAccordion('connections')}>
					<span class="left-accordion-chevron">${ICONS.chevron}</span>
					<span class="left-accordion-icon">${ICONS.cluster}</span>
					<span class="left-accordion-title">ALL CLUSTERS</span>
					<button class="btn-icon add-btn" title="Add connection" @click=${(e: Event) => { e.stopPropagation(); this._openModal('add'); }}>${ICONS.add}</button>
					<span class="left-accordion-count">${connections.length}</span>
				</div>
				${isExpanded ? html`
					<div class="left-accordion-body">
						${connections.length === 0 ? html`
							<div class="empty-state">
								<div class="empty-state-title">No clusters yet</div>
								<div class="empty-state-text">Add a Kusto cluster to get started.</div>
							</div>
						` : html`
							<ul class="connection-list">
								${connections.map(conn => {
									const isSelected = conn.id === this._selectedConnectionId;
									const fullUrl = /^https?:\/\//i.test(conn.clusterUrl) ? conn.clusterUrl : 'https://' + conn.clusterUrl;
									const isLnt = this._isLeaveNoTrace(conn.clusterUrl);
									return html`
										<li class="connection-item ${isSelected ? 'selected' : ''}"
											@click=${() => this._selectConnection(conn.id)}>
											<div class="connection-row">
												<div class="connection-name">${conn.name}</div>
												<div class="connection-actions">
													${isLnt
														? html`<button class="btn-icon lnt-active" title="Remove from Leave No Trace" @click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'leaveNoTrace.remove', clusterUrl: conn.clusterUrl }); }}>${ICONS.shield}</button>`
														: html`<button class="btn-icon" title="Mark as Leave No Trace" @click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'leaveNoTrace.add', clusterUrl: conn.clusterUrl }); }}>${ICONS.shield}</button>`
													}
													<button class="btn-icon" title="Edit" @click=${(e: Event) => { e.stopPropagation(); this._openModal('edit', conn.id); }}>${ICONS.edit}</button>
													<button class="btn-icon" title="Copy URL" @click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'copyToClipboard', text: conn.clusterUrl }); }}>${ICONS.copy}</button>
													<button class="btn-icon" title="Refresh" @click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'cluster.refreshDatabases', connectionId: conn.id }); }}>${ICONS.refresh}</button>
													<button class="btn-icon" title="Delete" @click=${(e: Event) => { e.stopPropagation(); this._vscode.postMessage({ type: 'connection.delete', id: conn.id }); }}>${ICONS.delete}</button>
												</div>
											</div>
											<div class="connection-url mono">${fullUrl}</div>
										</li>`;
								})}
							</ul>
						`}
					</div>
				` : nothing}
			</div>
		`;
	}

	// ── Right Panel: Explorer ─────────────────────────────────────────────────

	private _renderExplorer(): TemplateResult {
		const conn = this._getSelectedConnection();
		if (!conn || !this._snapshot) {
			return html`
				<div class="right-panel-content">
					<div class="empty-state">
						<div class="empty-state-icon">${ICONS.database}</div>
						<div class="empty-state-title">Select a cluster</div>
						<div class="empty-state-text">Click on a cluster to explore its databases, tables, and functions.</div>
					</div>
				</div>
			`;
		}

		const clusterKey = getClusterCacheKey(conn.clusterUrl);
		const databases = this._snapshot.cachedDatabases[clusterKey] ?? [];
		const isLoading = this._loadingDatabases.has(conn.id);

		return html`
			${this._renderBreadcrumb(conn)}
			<div class="right-panel-content">
				<div class="explorer-list">
					${this._renderExplorerContent(conn, databases, isLoading)}
				</div>
			</div>
		`;
	}

	private _renderBreadcrumb(conn: KustoConnection): TemplateResult {
		const ep = this._explorerPath;
		return html`
			<div class="explorer-breadcrumb">
				<span class="breadcrumb-item ${!ep?.database ? 'current' : ''}" @click=${() => { this._explorerPath = null; }}>
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
			if (databases.length === 0) return html`
				<div class="empty-state">
					<div class="empty-state-text">No databases found.</div>
					<button class="btn" @click=${() => this._vscode.postMessage({ type: 'cluster.refreshDatabases', connectionId: conn.id })}>Refresh</button>
				</div>`;

			return html`${databases.map(db => {
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
			${folders.map(f => html`
				<div class="explorer-list-item" @click=${() => { this._explorerPath = { ...ep, folderPath: [...(ep.folderPath ?? []), f] }; }}>
					<span class="explorer-list-item-icon folder">${ICONS.folder}</span>
					<span class="explorer-list-item-name">${f}</span>
				</div>
			`)}
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
			${folders.map(f => html`
				<div class="explorer-list-item" @click=${() => { this._explorerPath = { ...ep, folderPath: [...(ep.folderPath ?? []), f] }; }}>
					<span class="explorer-list-item-icon folder">${ICONS.folder}</span>
					<span class="explorer-list-item-name">${f}</span>
				</div>
			`)}
			${functions.map(fn => {
				const fnKey = dbKey + '|fn|' + fn.name;
				const isExpanded = this._expandedFunctions.has(fnKey);
				return html`
					<div class="explorer-list-item-wrapper ${isExpanded ? 'expanded' : ''}">
						<div class="explorer-list-item" @click=${() => this._toggleFunction(fnKey)} title="${fn.name}${fn.parametersText ? '(' + fn.parametersText + ')' : ''}">
							<span class="explorer-list-item-chevron ${isExpanded ? 'expanded' : ''}">${ICONS.chevron}</span>
							<span class="explorer-list-item-icon function">${ICONS.function}</span>
							<span class="explorer-list-item-name">${fn.name}</span>
							${fn.parametersText ? html`<span class="explorer-list-item-params">(${fn.parametersText})</span>` : nothing}
						</div>
						${isExpanded ? html`
							<div class="explorer-item-details">
								${fn.docString ? html`<div class="explorer-detail-section"><div class="explorer-detail-label">Description</div><div class="explorer-detail-docstring">${fn.docString}</div></div>` : nothing}
								<div class="explorer-detail-section"><div class="explorer-detail-label">Signature</div><div class="explorer-detail-code">${fn.name}${fn.parametersText || '()'}</div></div>
								${fn.body ? html`<div class="explorer-detail-section"><div class="explorer-detail-label">Implementation</div><pre class="explorer-detail-body">${fn.body}</pre></div>` : nothing}
							</div>
						` : nothing}
					</div>`;
			})}
			${folders.length === 0 && functions.length === 0 ? html`<div class="empty-state"><div class="empty-state-text">No functions in this folder.</div></div>` : nothing}
		`;
	}

	private _renderTablePreview(tableKey: string, tableName: string, data: TablePreview | undefined, conn: KustoConnection, ep: ExplorerPath): TemplateResult {
		if (data?.loading) return html`<div class="explorer-detail-section"><div class="preview-action loading">⏳ Loading preview…</div></div>`;
		if (data?.error) return html`
			<div class="explorer-detail-section">
				<div class="preview-error">${data.error}</div>
				<button class="preview-action" @click=${() => this._vscode.postMessage({ type: 'table.preview', connectionId: conn.id, database: ep.database, tableName })}>📊 Retry preview</button>
			</div>`;
		if (data?.columns && data?.rows) {
			if (data.rows.length === 0) return html`<div class="explorer-detail-section"><div style="font-size: 11px; opacity: 0.7; padding: 4px 0;">Table is empty.</div></div>`;
			// Simple table rendering (without resultsTable.js for now)
			return html`
				<div class="explorer-detail-section">
					<div class="preview-result">
						<div class="preview-result-header">
							<span class="preview-result-info">${data.rowCount} rows${data.executionTime ? ' · ' + data.executionTime : ''}</span>
							<button class="preview-result-dismiss" title="Dismiss" @click=${() => { const next = { ...this._tablePreviewData }; delete next[tableKey]; this._tablePreviewData = next; }}>✕</button>
						</div>
						<div class="preview-table-container">
							<table class="preview-table">
								<thead><tr>${data.columns.map(c => html`<th>${c.name ?? c}</th>`)}</tr></thead>
								<tbody>${data.rows.slice(0, 50).map(row => html`<tr>${(row as unknown[]).map(cell => html`<td>${cell != null ? String(cell) : ''}</td>`)}</tr>`)}</tbody>
							</table>
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

	private _toggleAccordion(section: 'favorites' | 'leaveNoTrace' | 'connections'): void {
		this._expandedAccordion = this._expandedAccordion === section ? 'connections' : section;
	}

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

	// ── Styles ────────────────────────────────────────────────────────────────

	static styles = css`
		*, *::before, *::after { box-sizing: border-box; }

		:host {
			display: block;
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-editor-foreground);
			background: var(--vscode-editor-background);
			padding: 16px;
			margin: 0;
		}

		h1 { font-size: 18px; margin: 0 0 8px 0; font-weight: 600; }
		h2 { font-size: 14px; margin: 0; font-weight: 600; }
		.mono { font-family: var(--vscode-editor-font-family); }

		/* Spinner animation */
		@keyframes spin { to { transform: rotate(360deg); } }
		.spin, :host svg.spin { animation: spin 1s linear infinite; }

		/* Buttons */
		.btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; font-size: 12px; border-radius: 2px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; font-family: inherit; }
		.btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		.btn.primary:hover { background: var(--vscode-button-hoverBackground); }
		.btn svg { width: 14px; height: 14px; fill: currentColor; }

		.btn-icon { width: 28px; height: 28px; padding: 0; border: none; background: transparent; color: var(--vscode-foreground); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; }
		.btn-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
		.btn-icon:active { background: var(--vscode-toolbar-activeBackground); }
		.btn-icon svg { width: 16px; height: 16px; fill: currentColor; }
		.btn-icon.is-favorite { color: #f5c518; }
		.btn-icon.is-favorite svg { fill: #f5c518; }
		.btn-icon.lnt-active { color: var(--vscode-symbolIcon-eventForeground, #d19a66); }

		.title-actions { display: flex; gap: 8px; margin-bottom: 16px; }
		.add-btn { width: 28px; height: 28px; }
		.add-btn svg { width: 18px; height: 18px; }

		/* Main layout */
		.main-container { display: flex; height: calc(100vh - 80px); position: relative; }
		.left-panel { width: 280px; min-width: 200px; max-width: 500px; height: 100%; display: flex; flex-direction: column; flex-shrink: 0; overflow: hidden; margin-right: 8px; transition: width 0.15s ease, min-width 0.15s ease, opacity 0.15s ease; border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; }
		.left-panel.collapsed { width: 0 !important; min-width: 0 !important; opacity: 0; pointer-events: none; margin-right: 0; }
		.splitter { width: 6px; cursor: col-resize; background: transparent; position: relative; flex-shrink: 0; margin-right: 8px; }
		.splitter::after { content: ''; position: absolute; top: 0; bottom: 0; left: 2px; width: 2px; background: transparent; transition: background 0.1s; }
		.splitter:hover::after { background: var(--vscode-focusBorder); }
		.splitter-collapse-btn { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 18px; height: 32px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--vscode-foreground); opacity: 0; transition: opacity 0.15s; z-index: 1; padding: 0; }
		.splitter:hover .splitter-collapse-btn { opacity: 1; }
		.splitter-collapse-btn svg { width: 12px; height: 12px; }
		.right-panel { flex: 1; min-width: 0; display: flex; flex-direction: column; height: 100%; border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; background: var(--vscode-editorWidget-background); overflow: hidden; }
		.panel-toggle { position: fixed; top: 80px; left: 16px; z-index: 100; width: 28px; height: 28px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--vscode-foreground); padding: 0; }
		.panel-toggle svg { width: 16px; height: 16px; }

		/* Right panel header */
		.right-panel-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; height: 42px; box-sizing: border-box; border-bottom: 1px solid var(--vscode-editorWidget-border); background: var(--vscode-editorGroupHeader-tabsBackground); flex-shrink: 0; }
		.right-panel-header svg { width: 16px; height: 16px; }
		.right-panel-title { font-weight: 600; font-size: 13px; }
		.right-panel-content { flex: 1; overflow-y: auto; }

		/* Accordion */
		.left-accordion-item { display: flex; flex-direction: column; flex-shrink: 0; }
		.left-accordion-item:not(:last-child) { border-bottom: 1px solid var(--vscode-editorWidget-border); }
		.left-accordion-item.expanded { flex-shrink: 1; min-height: 0; overflow: hidden; }
		.left-accordion-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; height: 42px; box-sizing: border-box; cursor: pointer; user-select: none; background: var(--vscode-editorGroupHeader-tabsBackground); transition: background 0.1s; flex-shrink: 0; }
		.left-accordion-header:hover { background: var(--vscode-list-hoverBackground); }
		.left-accordion-chevron { width: 16px; height: 16px; flex-shrink: 0; transition: transform 0.15s ease; opacity: 0.7; }
		.left-accordion-chevron svg { width: 14px; height: 14px; fill: currentColor; }
		.left-accordion-header:hover .left-accordion-chevron { opacity: 1; }
		.left-accordion-item.expanded .left-accordion-chevron { transform: rotate(90deg); }
		.left-accordion-icon { width: 16px; height: 16px; flex-shrink: 0; display: flex; align-items: center; }
		.left-accordion-icon svg { width: 16px; height: 16px; fill: currentColor; }
		.fav-icon { color: #f5c518; }
		.fav-icon svg { fill: #f5c518; }
		.left-accordion-title { flex: 1; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
		.left-accordion-count { font-size: 11px; font-weight: 500; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 2px 6px; border-radius: 10px; min-width: 18px; text-align: center; }
		.left-accordion-body { overflow-y: auto; min-height: 0; }

		/* Connection list */
		.connection-list { list-style: none; margin: 0; padding: 0; }
		.connection-item { display: flex; flex-direction: column; padding: 6px 12px; border-bottom: 1px solid var(--vscode-editorWidget-border); cursor: pointer; transition: background 0.1s; }
		.connection-item:last-child { border-bottom: none; }
		.connection-item:hover { background: var(--vscode-list-hoverBackground); }
		.connection-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
		.connection-row { display: flex; align-items: center; gap: 0; }
		.connection-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-right: 4px; flex-shrink: 1; min-width: 0; }
		.connection-url { font-size: 11px; opacity: 0.7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
		.connection-actions { display: flex; gap: 2px; flex-shrink: 0; }
		.connection-actions .btn-icon { opacity: 0; transition: opacity 0.1s; }
		.connection-item:hover .connection-actions .btn-icon { opacity: 1; }
		.connection-actions .btn-icon.lnt-active { opacity: 1; }

		/* Leave No Trace */
		.lnt-icon { color: var(--vscode-symbolIcon-eventForeground, #d19a66); display: flex; align-items: center; flex-shrink: 0; margin-right: 6px; }
		.lnt-icon svg { width: 14px; height: 14px; fill: currentColor; }

		/* Favorites section */
		.favorite-item { display: flex; flex-direction: column; padding: 6px 12px; border-bottom: 1px solid var(--vscode-editorWidget-border); cursor: pointer; transition: background 0.1s; }
		.favorite-item:last-child { border-bottom: none; }
		.favorite-item:hover { background: var(--vscode-list-hoverBackground); }
		.favorite-row { display: flex; align-items: center; gap: 0; }
		.favorite-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-right: 4px; flex-shrink: 1; min-width: 0; }
		.favorite-detail { font-size: 11px; opacity: 0.7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
		.favorite-actions { display: flex; gap: 2px; opacity: 0; transition: opacity 0.1s; flex-shrink: 0; }
		.favorite-item:hover .favorite-actions { opacity: 1; }

		/* Explorer breadcrumb */
		.explorer-breadcrumb { display: flex; align-items: center; gap: 4px; padding: 8px 12px; font-size: 12px; border-bottom: 1px solid var(--vscode-editorWidget-border); background: var(--vscode-sideBar-background); flex-wrap: wrap; flex-shrink: 0; }
		.breadcrumb-item { display: flex; align-items: center; gap: 4px; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 2px 4px; border-radius: 3px; transition: background 0.1s; }
		.breadcrumb-item:hover { background: var(--vscode-list-hoverBackground); text-decoration: underline; }
		.breadcrumb-item.current { color: var(--vscode-foreground); cursor: default; font-weight: 500; }
		.breadcrumb-item.current:hover { background: transparent; text-decoration: none; }
		.breadcrumb-separator { color: var(--vscode-descriptionForeground); opacity: 0.6; }
		.breadcrumb-icon { width: 14px; height: 14px; flex-shrink: 0; display: flex; align-items: center; }
		.breadcrumb-icon svg { width: 14px; height: 14px; fill: currentColor; }

		/* Explorer list */
		.explorer-list { flex: 1; overflow-y: auto; }
		.explorer-list-item { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; transition: background 0.1s; border-bottom: 1px solid var(--vscode-editorWidget-border); }
		.explorer-list-item:last-child { border-bottom: none; }
		.explorer-list-item:hover { background: var(--vscode-list-hoverBackground); }
		.explorer-list-item-icon { width: 16px; height: 16px; flex-shrink: 0; display: flex; align-items: center; }
		.explorer-list-item-icon svg { width: 16px; height: 16px; fill: currentColor; }
		.explorer-list-item-icon.database { color: var(--vscode-symbolIcon-fieldForeground, #75beff); }
		.explorer-list-item-icon.database svg { fill: var(--vscode-symbolIcon-fieldForeground, #75beff); }
		.explorer-list-item-icon.table { color: var(--vscode-symbolIcon-structForeground, #00bcb4); }
		.explorer-list-item-icon.table svg { fill: var(--vscode-symbolIcon-structForeground, #00bcb4); }
		.explorer-list-item-icon.function { color: var(--vscode-symbolIcon-methodForeground, #b180d7); }
		.explorer-list-item-icon.function svg { fill: var(--vscode-symbolIcon-methodForeground, #b180d7); }
		.explorer-list-item-icon.folder { color: var(--vscode-symbolIcon-folderForeground, #dcb67a); }
		.explorer-list-item-icon.folder svg { fill: var(--vscode-symbolIcon-folderForeground, #dcb67a); }
		.explorer-list-item-name { flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
		.explorer-list-item-meta { font-size: 11px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
		.explorer-list-item-params { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; opacity: 0; transition: opacity 0.15s; flex-shrink: 1; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
		.explorer-list-item:hover .explorer-list-item-params { opacity: 1; }
		.explorer-list-item:hover .explorer-list-item-name { flex-shrink: 0; max-width: 60%; }
		.explorer-list-item-actions { display: flex; gap: 2px; flex-shrink: 0; }
		.explorer-list-item-actions .btn-icon { opacity: 0; transition: opacity 0.1s; }
		.explorer-list-item:hover .explorer-list-item-actions .btn-icon { opacity: 1; }
		.explorer-list-item-actions .btn-icon.is-favorite { opacity: 1; }
		.explorer-list-item-chevron { width: 16px; height: 16px; flex-shrink: 0; transition: transform 0.15s ease; opacity: 0.7; display: flex; align-items: center; }
		.explorer-list-item-chevron svg { width: 14px; height: 14px; fill: currentColor; }
		.explorer-list-item-chevron.expanded { transform: rotate(90deg); }
		.explorer-list-item-wrapper { }
		.explorer-item-details { padding: 8px 12px 12px 44px; background: var(--vscode-editorWidget-background); border-top: 1px solid var(--vscode-editorWidget-border); }
		.explorer-detail-section { margin-bottom: 12px; }
		.explorer-detail-section:last-child { margin-bottom: 0; }
		.explorer-detail-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
		.explorer-detail-docstring { font-size: 12px; color: var(--vscode-editor-foreground); line-height: 1.4; white-space: pre-wrap; word-wrap: break-word; }
		.explorer-detail-code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; color: var(--vscode-symbolIcon-methodForeground, #b180d7); padding: 4px 8px; background: rgba(0, 0, 0, 0.1); border-radius: 4px; }
		.explorer-detail-body { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.4; color: var(--vscode-editor-foreground); background: rgba(0, 0, 0, 0.15); border-radius: 4px; padding: 8px 10px; margin: 0; white-space: pre-wrap; word-wrap: break-word; max-height: 200px; overflow-y: auto; }
		.explorer-detail-schema { display: flex; flex-direction: column; gap: 2px; }
		.explorer-schema-row { display: flex; align-items: center; gap: 8px; padding: 3px 8px; font-size: 11px; background: rgba(0, 0, 0, 0.08); border-radius: 3px; }
		.explorer-schema-row:hover { background: rgba(0, 0, 0, 0.15); }
		.explorer-schema-col-name { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.explorer-schema-col-type { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-symbolIcon-typeParameterForeground, #4ec9b0); font-size: 10px; flex-shrink: 0; }

		/* Preview */
		.preview-action { display: flex; align-items: center; gap: 6px; padding: 6px 10px; margin-top: 8px; border-radius: 4px; cursor: pointer; font-size: 11px; color: var(--vscode-textLink-foreground); background: transparent; border: 1px solid var(--vscode-editorWidget-border); font-family: inherit; transition: background 0.15s; }
		.preview-action:hover { background: var(--vscode-list-hoverBackground); }
		.preview-action.loading { opacity: 0.7; pointer-events: none; }
		.preview-action svg { width: 14px; height: 14px; fill: currentColor; }
		.preview-error { margin-top: 8px; padding: 6px 10px; font-size: 11px; color: var(--vscode-errorForeground); background: rgba(255, 0, 0, 0.08); border-radius: 4px; border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(255, 0, 0, 0.3)); }
		.preview-result { margin-top: 8px; }
		.preview-result-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
		.preview-result-info { font-size: 10px; color: var(--vscode-descriptionForeground); }
		.preview-result-dismiss { background: none; border: none; cursor: pointer; color: var(--vscode-descriptionForeground); opacity: 0.7; padding: 2px; }
		.preview-result-dismiss:hover { opacity: 1; }
		.preview-result-dismiss svg { width: 12px; height: 12px; fill: currentColor; }
		.preview-table-container { max-height: 300px; overflow: auto; border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; }
		.preview-table { width: 100%; border-collapse: collapse; font-size: 11px; font-family: var(--vscode-editor-font-family); }
		.preview-table th { padding: 4px 8px; text-align: left; font-weight: 600; border-bottom: 1px solid var(--vscode-editorWidget-border); background: var(--vscode-editorGroupHeader-tabsBackground); position: sticky; top: 0; z-index: 1; }
		.preview-table td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-editorWidget-border); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

		/* Empty + loading states */
		.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px 16px; opacity: 0.7; text-align: center; }
		.empty-state-icon { margin-bottom: 8px; }
		.empty-state-icon svg { width: 32px; height: 32px; }
		.empty-state-title { font-weight: 600; margin-bottom: 4px; }
		.empty-state-text { font-size: 12px; }
		.loading-state { padding: 16px; text-align: center; opacity: 0.7; }
		.loading-state svg { width: 16px; height: 16px; vertical-align: middle; margin-right: 4px; }

		/* Modal */
		.modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.5); z-index: 10000; display: flex; align-items: center; justify-content: center; }
		.modal-content { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; width: 440px; max-width: 90%; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3); }
		.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--vscode-panel-border); }
		.modal-body { padding: 16px 20px; }
		.modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--vscode-panel-border); }
		.form-group { margin-bottom: 12px; }
		.form-group label { display: block; font-size: 12px; margin-bottom: 4px; }
		.form-group input { width: 100%; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px; font-family: inherit; font-size: 13px; }
		.form-group input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
		.form-group input::placeholder { color: var(--vscode-input-placeholderForeground); }
		.test-result { margin-top: 8px; font-size: 12px; }
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-connection-manager': KwConnectionManager;
	}
}
