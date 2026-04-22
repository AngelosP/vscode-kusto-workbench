import type { ReactiveController, ReactiveControllerHost } from 'lit';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConnectionKind = 'kusto' | 'sql';
export type SearchScope = 'cached' | 'refresh-cached' | 'everything';

export interface SearchResult {
	category: string;
	kind: ConnectionKind;
	connectionId: string;
	connectionName: string;
	database?: string;
	name: string;
	parentName?: string;
	matchContext?: string;
}

export interface SearchState {
	query: string;
	scope: SearchScope;
	categories: Record<string, boolean>;
	contentToggles: Record<string, boolean>;
	lastResults: SearchResult[];
	lastSearchTimestamp: number;
}

export interface SearchControllerHost extends ReactiveControllerHost {
	postMessage(msg: unknown): void;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const KUSTO_DEFAULT_CATEGORIES: Record<string, boolean> = {
	clusters: true,
	databases: true,
	tables: true,
	functions: true,
};

const SQL_DEFAULT_CATEGORIES: Record<string, boolean> = {
	servers: true,
	databases: true,
	tables: true,
	views: true,
	storedProcedures: true,
};

const KUSTO_DEFAULT_CONTENT: Record<string, boolean> = {
	tables: false,
	functions: false,
};

const SQL_DEFAULT_CONTENT: Record<string, boolean> = {
	tables: false,
	views: false,
	storedProcedures: false,
};

function defaultCategories(kind: ConnectionKind): Record<string, boolean> {
	return kind === 'sql' ? { ...SQL_DEFAULT_CATEGORIES } : { ...KUSTO_DEFAULT_CATEGORIES };
}

function defaultContentToggles(kind: ConnectionKind): Record<string, boolean> {
	return kind === 'sql' ? { ...SQL_DEFAULT_CONTENT } : { ...KUSTO_DEFAULT_CONTENT };
}

function defaultSearchState(kind: ConnectionKind): SearchState {
	return {
		query: '',
		scope: 'cached',
		categories: defaultCategories(kind),
		contentToggles: defaultContentToggles(kind),
		lastResults: [],
		lastSearchTimestamp: 0,
	};
}

// ─── Scope Descriptors ────────────────────────────────────────────────────────

export interface ScopeDescriptor {
	id: SearchScope;
	label: string;
	description: string;
	tooltip: string;
}

export const SEARCH_SCOPES: ScopeDescriptor[] = [
	{
		id: 'cached',
		label: '⚡ Quick Search',
		description: 'Search your currently cached schemas',
		tooltip: 'Searches schemas already downloaded to your machine — fast, no network calls. Best for connections you regularly use.',
	},
	{
		id: 'refresh-cached',
		label: '🔄 Refresh & Search',
		description: 'Refresh cached schemas, then search',
		tooltip: 'Re-downloads schemas for connections you\'ve used before to pick up any recent changes, then searches. Moderate speed.',
	},
	{
		id: 'everything',
		label: '🌐 Search Everything',
		description: 'Connect to all clusters and search',
		tooltip: 'Connects to every cluster, downloads all database schemas — most thorough but slowest. Use when looking for something across clusters you haven\'t explored yet.',
	},
];

// ─── Category Descriptors ─────────────────────────────────────────────────────

export interface CategoryDescriptor {
	id: string;
	label: string;
	hasContent: boolean;
	contentLabel?: string;
	/** Labels for the two active states: [names-only, names+content]. Only used when hasContent is true. */
	stateLabels?: [string, string];
	/** Split label for 3-state display: [primary, secondary]. When partially on, secondary is dimmed. */
	splitLabel?: [string, string];
	/** Short label for narrow widths. */
	shortLabel?: string;
}

export const KUSTO_CATEGORIES: CategoryDescriptor[] = [
	{ id: 'clusters', label: 'Clusters', hasContent: false, shortLabel: 'Clust' },
	{ id: 'databases', label: 'Databases', hasContent: false, shortLabel: 'DBs' },
	{ id: 'tables', label: 'Tables', hasContent: true, contentLabel: 'Include columns', stateLabels: ['Table Names', 'Tables & Columns'], splitLabel: ['Table Names', '& Columns'], shortLabel: 'Tbl' },
	{ id: 'functions', label: 'Functions', hasContent: true, contentLabel: 'Include body', stateLabels: ['Function Names', 'Functions & Body'], splitLabel: ['Function Names', '& Body'], shortLabel: 'Fn' },
];

export const SQL_CATEGORIES: CategoryDescriptor[] = [
	{ id: 'servers', label: 'Servers', hasContent: false, shortLabel: 'Srv' },
	{ id: 'databases', label: 'Databases', hasContent: false, shortLabel: 'DBs' },
	{ id: 'tables', label: 'Tables', hasContent: true, contentLabel: 'Include columns', stateLabels: ['Table Names', 'Tables & Columns'], splitLabel: ['Table Names', '& Columns'], shortLabel: 'Tbl' },
	{ id: 'views', label: 'Views', hasContent: true, contentLabel: 'Include columns', stateLabels: ['View Names', 'Views & Columns'], splitLabel: ['View Names', '& Columns'], shortLabel: 'View' },
	{ id: 'storedProcedures', label: 'Stored Procedures', hasContent: true, contentLabel: 'Include body', stateLabels: ['Stored Proc Names', 'Stored Procs & Body'], splitLabel: ['Stored Proc Names', '& Body'], shortLabel: 'SP' },
];

// ─── Controller ───────────────────────────────────────────────────────────────

export class ConnectionManagerSearchController implements ReactiveController {
	// ── State ─────────────────────────────────────────────────────────────
	query = '';
	scope: SearchScope = 'cached';
	categories: Record<string, boolean> = {};
	contentToggles: Record<string, boolean> = {};
	results: SearchResult[] = [];
	loading = false;
	refreshing = false;
	progressMessage = '';
	progressCurrent = 0;
	progressTotal = 0;

	private _activeRequestId: string | null = null;
	private _searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _kind: ConnectionKind = 'kusto';

	constructor(private readonly host: SearchControllerHost) {
		host.addController(this);
		this.categories = defaultCategories(this._kind);
		this.contentToggles = defaultContentToggles(this._kind);
	}

	hostConnected(): void { /* no-op */ }
	hostDisconnected(): void {
		if (this._searchDebounceTimer) clearTimeout(this._searchDebounceTimer);
		if (this._saveDebounceTimer) clearTimeout(this._saveDebounceTimer);
	}

	// ── Kind ──────────────────────────────────────────────────────────────

	get kind(): ConnectionKind { return this._kind; }

	setKind(kind: ConnectionKind): void {
		if (kind === this._kind) return;
		this._kind = kind;
		// Reset to kind-appropriate defaults but preserve query/scope/results
		this.categories = defaultCategories(kind);
		this.contentToggles = defaultContentToggles(kind);
		this.loading = false;
		this.progressMessage = '';
		this._cancelActiveSearch();
		this.host.requestUpdate();
	}

	// ── Restore from snapshot ─────────────────────────────────────────────

	restoreState(state: Partial<SearchState> | undefined, kind: ConnectionKind): void {
		this._kind = kind;
		if (!state || typeof state !== 'object') {
			this.query = '';
			this.scope = 'cached';
			this.categories = defaultCategories(kind);
			this.contentToggles = defaultContentToggles(kind);
			this.results = [];
			return;
		}
		this.query = typeof state.query === 'string' ? state.query : '';
		this.scope = (state.scope === 'cached' || state.scope === 'refresh-cached' || state.scope === 'everything') ? state.scope : 'cached';
		this.categories = (state.categories && typeof state.categories === 'object') ? { ...defaultCategories(kind), ...state.categories } : defaultCategories(kind);
		this.contentToggles = (state.contentToggles && typeof state.contentToggles === 'object') ? { ...defaultContentToggles(kind), ...state.contentToggles } : defaultContentToggles(kind);
		this.results = Array.isArray(state.lastResults) ? state.lastResults : [];
		this.host.requestUpdate();
	}

	// ── User actions ──────────────────────────────────────────────────────

	setQuery(query: string): void {
		this.query = query;
		this._debouncedSearch();
		this._debouncedSave();
		this.host.requestUpdate();
	}

	/** Re-run the current search as-is. */
	rerunSearch(): void {
		if (!this.query.trim()) return;
		this._performSearch();
	}

	/** Refresh already-cached schemas, then search. */
	refreshCachedAndSearch(): void {
		this.scope = 'refresh-cached';
		this.refreshing = true;
		if (this.query.trim()) {
			this._performSearch();
		} else {
			this._performRefreshOnly('refresh-cached');
		}
	}

	/** Refresh ALL connections' schemas, then search. */
	refreshAllAndSearch(): void {
		this.scope = 'everything';
		this.refreshing = true;
		if (this.query.trim()) {
			this._performSearch();
		} else {
			this._performRefreshOnly('everything');
		}
	}

	setScope(scope: SearchScope): void {
		this.scope = scope;
		this._debouncedSave();
		this.host.requestUpdate();
	}

	toggleCategory(id: string): void {
		this.categories = { ...this.categories, [id]: !this.categories[id] };
		this._debouncedSave();
		if (this.query.trim()) {
			this._performSearch();
		}
		this.host.requestUpdate();
	}

	toggleContent(id: string): void {
		this.contentToggles = { ...this.contentToggles, [id]: !this.contentToggles[id] };
		this._debouncedSave();
		if (this.query.trim()) {
			this._performSearch();
		}
		this.host.requestUpdate();
	}

	/** Cycle a category through its states: off → names → names+content → off (for content categories), or off → on → off. */
	cycleCategory(id: string, hasContent: boolean): void {
		const isOn = this.categories[id];
		const contentOn = this.contentToggles[id];
		if (!isOn) {
			// off → names-only: incremental search to pick up new results
			this.categories = { ...this.categories, [id]: true };
			this.contentToggles = { ...this.contentToggles, [id]: false };
			this._debouncedSave();
			if (this.query.trim()) this._performIncrementalSearch();
		} else if (hasContent && !contentOn) {
			// names → names+content: incremental search to pick up content matches
			this.contentToggles = { ...this.contentToggles, [id]: true };
			this._debouncedSave();
			if (this.query.trim()) this._performIncrementalSearch();
		} else {
			// turning off: just filter client-side, no re-search
			this.categories = { ...this.categories, [id]: false };
			this.contentToggles = { ...this.contentToggles, [id]: false };
			this._debouncedSave();
		}
		this.host.requestUpdate();
	}

	cancelSearch(): void {
		this._cancelActiveSearch();
		this.loading = false;
		this.refreshing = false;
		this.progressMessage = '';
		this.host.requestUpdate();
	}

	// ── Message handling (called by host component's _onMessage) ──────────

	handleSearchResults(requestId: string, results: SearchResult[], completed: boolean): void {
		if (requestId !== this._activeRequestId) return;
		// Deduplicate: build a set of existing result keys, only add genuinely new ones
		const existingKeys = new Set(this.results.map(r => `${r.category}|${r.connectionId}|${r.database ?? ''}|${r.name}|${r.parentName ?? ''}`));
		const newResults = results.filter(r => !existingKeys.has(`${r.category}|${r.connectionId}|${r.database ?? ''}|${r.name}|${r.parentName ?? ''}`));
		if (newResults.length) this.results = [...this.results, ...newResults];
		if (completed) {
			this.loading = false;
			this.refreshing = false;
			this.progressMessage = '';
			this._activeRequestId = null;
		}
		this.host.requestUpdate();
	}

	handleSearchProgress(requestId: string, message: string, current?: number, total?: number): void {
		if (requestId !== this._activeRequestId) return;
		this.progressMessage = message;
		if (typeof current === 'number') this.progressCurrent = current;
		if (typeof total === 'number') this.progressTotal = total;
		this.host.requestUpdate();
	}

	// ── Private ───────────────────────────────────────────────────────────

	private _debouncedSearch(): void {
		if (this._searchDebounceTimer) clearTimeout(this._searchDebounceTimer);
		this._searchDebounceTimer = setTimeout(() => {
			if (this.query.trim()) {
				this.scope = 'cached';
				this._performSearch();
			} else {
				this._cancelActiveSearch();
				this.results = [];
				this.loading = false;
				this.refreshing = false;
				this.progressMessage = '';
				this.host.requestUpdate();
			}
		}, 300);
	}

	private _debouncedSave(): void {
		if (this._saveDebounceTimer) clearTimeout(this._saveDebounceTimer);
		this._saveDebounceTimer = setTimeout(() => {
			this.host.postMessage({
				type: 'search.saveState',
				state: {
					query: this.query,
					scope: this.scope,
					categories: this.categories,
					contentToggles: this.contentToggles,
					lastResults: this.results,
					lastSearchTimestamp: Date.now(),
				} satisfies SearchState,
			});
		}, 500);
	}

	private _performSearch(): void {
		this._cancelActiveSearch();
		const requestId = `search_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		this._activeRequestId = requestId;
		this.results = [];
		this.loading = true;
		this.progressMessage = '';
		this.progressCurrent = 0;
		this.progressTotal = 0;
		this.host.postMessage({
			type: 'search',
			requestId,
			query: this.query.trim(),
			scope: this.scope,
			kind: this._kind,
			categories: this.categories,
			contentToggles: this.contentToggles,
		});
		this.host.requestUpdate();
	}

	/** Like _performSearch but keeps existing results — new results are merged via dedup in handleSearchResults. */
	private _performIncrementalSearch(): void {
		this._cancelActiveSearch();
		const requestId = `search_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		this._activeRequestId = requestId;
		this.loading = true;
		this.progressMessage = '';
		this.progressCurrent = 0;
		this.progressTotal = 0;
		this.host.postMessage({
			type: 'search',
			requestId,
			query: this.query.trim(),
			scope: this.scope,
			kind: this._kind,
			categories: this.categories,
			contentToggles: this.contentToggles,
		});
		this.host.requestUpdate();
	}

	private _cancelActiveSearch(): void {
		if (this._activeRequestId) {
			this.host.postMessage({ type: 'search.cancel', requestId: this._activeRequestId });
			this._activeRequestId = null;
		}
	}

	/** Trigger a refresh without a search query — just refresh schemas and report progress. */
	private _performRefreshOnly(scope: SearchScope): void {
		this._cancelActiveSearch();
		const requestId = `refresh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		this._activeRequestId = requestId;
		this.loading = true;
		this.progressMessage = '';
		this.progressCurrent = 0;
		this.progressTotal = 0;
		// Send search with a wildcard-like query so the host refreshes schemas
		// but we don't expect meaningful results — just progress.
		this.host.postMessage({
			type: 'search',
			requestId,
			query: '.*',
			scope,
			kind: this._kind,
			categories: {},
			contentToggles: {},
		});
		this.host.requestUpdate();
	}
}
