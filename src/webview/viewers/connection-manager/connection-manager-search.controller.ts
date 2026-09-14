import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { connectionSearchIncludes, normalizeConnectionSearchTargets, sameConnectionSearchTargets, type ConnectionSearchScope, type ConnectionSearchTarget } from '../../../shared/connectionSearch.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConnectionKind = 'kusto' | 'sql';
export type SearchScope = ConnectionSearchScope;
export type { ConnectionSearchTarget } from '../../../shared/connectionSearch.js';

export interface SearchResult {
	category: string;
	kind: ConnectionKind;
	connectionId: string;
	connectionName: string;
	database?: string;
	name: string;
	parentName?: string;
	parentKind?: 'table' | 'view';
	columnType?: string;
	matchContext?: string;
	kustoSearchOwnerToken?: string;
}

export interface SearchState {
	kind?: ConnectionKind;
	query: string;
	scope: SearchScope;
	targets?: ConnectionSearchTarget[];
	categories: Record<string, boolean>;
	contentToggles: Record<string, boolean>;
	lastResults: SearchResult[];
	lastSearchTimestamp: number;
	kustoPrincipalFingerprint?: string;
	kustoPolicyVersion?: number;
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

// ─── Category Descriptors ─────────────────────────────────────────────────────

export interface CategoryDescriptor {
	id: string;
	label: string;
	hasContent: boolean;
	contentKey?: string;
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
	{ id: 'tables', label: 'Table Names', hasContent: false, shortLabel: 'Tbl' },
	{ id: 'tableColumns', label: 'Table Columns', hasContent: false, contentKey: 'tables', shortLabel: 'Col' },
	{ id: 'functions', label: 'Function Name', hasContent: false, shortLabel: 'Fn' },
	{ id: 'functionBody', label: 'Function Body', hasContent: false, contentKey: 'functions', shortLabel: 'Body' },
];

export const SQL_CATEGORIES: CategoryDescriptor[] = [
	{ id: 'servers', label: 'Servers', hasContent: false, shortLabel: 'Srv' },
	{ id: 'databases', label: 'Databases', hasContent: false, shortLabel: 'DBs' },
	{ id: 'tables', label: 'Table Names', hasContent: false, shortLabel: 'Tbl' },
	{ id: 'tableColumns', label: 'Table Columns', hasContent: false, contentKey: 'tables', shortLabel: 'Col' },
	{ id: 'views', label: 'Views', hasContent: true, contentLabel: 'Include columns', stateLabels: ['View Names', 'Views & Columns'], splitLabel: ['View Names', '& Columns'], shortLabel: 'View' },
	{ id: 'storedProcedures', label: 'Stored Procedures', hasContent: true, contentLabel: 'Include body', stateLabels: ['Stored Proc Names', 'Stored Procs & Body'], splitLabel: ['Stored Proc Names', '& Body'], shortLabel: 'SP' },
];

// ─── Controller ───────────────────────────────────────────────────────────────

export class ConnectionManagerSearchController implements ReactiveController {
	// ── State ─────────────────────────────────────────────────────────────
	query = '';
	scope: SearchScope = 'selected';
	targets: ConnectionSearchTarget[] = [];
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
	private _editedKinds = new Set<ConnectionKind>();
	private _statesByKind = new Map<ConnectionKind, SearchState>();
	private _kustoSearchOwnerToken = '';
	private _kustoPrincipalFingerprint = '';
	private _kustoPolicyVersion: number | undefined;

	constructor(private readonly host: SearchControllerHost) {
		host.addController(this);
		this.categories = defaultCategories(this._kind);
		this.contentToggles = defaultContentToggles(this._kind);
	}

	hostConnected(): void { /* no-op */ }
	hostDisconnected(): void {
		if (this._saveDebounceTimer) this._saveStateNow();
		if (this._searchDebounceTimer) clearTimeout(this._searchDebounceTimer);
		if (this._saveDebounceTimer) clearTimeout(this._saveDebounceTimer);
		this._cancelActiveSearch();
	}

	// ── Kind ──────────────────────────────────────────────────────────────

	get kind(): ConnectionKind { return this._kind; }
	get canSearch(): boolean { return this.scope !== 'selected' || this.targets.length > 0; }
	get canSearchConnections(): boolean {
		return this.scope !== 'selected' || this.targets.some(target => target.database === undefined);
	}
	get effectiveCategories(): Record<string, boolean> {
		return { ...this.categories, [this._kind === 'sql' ? 'servers' : 'clusters']: this.canSearchConnections && this.categories[this._kind === 'sql' ? 'servers' : 'clusters'] };
	}

	setKind(kind: ConnectionKind): void {
		if (kind === this._kind) return;
		this._clearSearchDebounce();
		if (this._saveDebounceTimer) this._saveStateNow();
		this._statesByKind.set(this._kind, { ...this._captureState(), lastResults: [] });
		this._cancelActiveSearch();
		this._kind = kind;
		const state = this._statesByKind.get(kind);
		this.query = state?.query ?? '';
		this.scope = state?.scope ?? 'selected';
		this.targets = normalizeConnectionSearchTargets(state?.targets);
		// Reset to kind-appropriate defaults; result ownership never crosses kinds.
		this.categories = { ...defaultCategories(kind), ...state?.categories };
		this.contentToggles = { ...defaultContentToggles(kind), ...state?.contentToggles };
		this.results = [];
		this.loading = false;
		this.refreshing = false;
		this.progressMessage = '';
		this._cancelActiveSearch();
		this.host.requestUpdate();
	}

	// ── Restore from snapshot ─────────────────────────────────────────────

	restoreState(state: Partial<SearchState> | undefined, kind: ConnectionKind, fromSnapshot = false): void {
		if (fromSnapshot && kind !== this._kind) this.setKind(kind);
		if (fromSnapshot && this._editedKinds.has(kind)) return;
		if (state?.kind && state.kind !== kind) state = undefined;
		const previousKind = this._kind;
		const previousQuery = this.query;
		const previousScope = this.scope;
		const previousTargets = this.targets;
		const previousResults = this.results;
		this._kind = kind;
		if (!state || typeof state !== 'object') {
			this._clearSearchDebounce();
			this.cancelSearch();
			this.query = '';
			this.scope = 'selected';
			this.targets = [];
			this.categories = defaultCategories(kind);
			this.contentToggles = defaultContentToggles(kind);
			this.results = [];
			return;
		}
		const restoredQuery = typeof state.query === 'string' ? state.query : '';
		const restoredScope = (state.scope === 'selected' || state.scope === 'cached' || state.scope === 'everything') ? state.scope : 'cached';
		const restoredTargets = normalizeConnectionSearchTargets(state.targets);
		if (previousKind !== kind || restoredQuery !== previousQuery || restoredScope !== previousScope
			|| !sameConnectionSearchTargets(previousTargets, restoredTargets)) {
			this._clearSearchDebounce();
			this.cancelSearch();
		}
		const restoredResults = Array.isArray(state.lastResults) ? state.lastResults : [];
		const shouldKeepLiveResults = previousKind === kind
			&& restoredQuery.trim().length > 0
			&& restoredQuery === previousQuery
			&& restoredScope === previousScope
			&& sameConnectionSearchTargets(previousTargets, restoredTargets)
			&& previousResults.length > 0
			&& restoredResults.length === 0;

		this.query = restoredQuery;
		this.scope = restoredScope;
		this.targets = restoredTargets;
		this.categories = (state.categories && typeof state.categories === 'object') ? { ...defaultCategories(kind), ...state.categories } : defaultCategories(kind);
		this.contentToggles = (state.contentToggles && typeof state.contentToggles === 'object') ? { ...defaultContentToggles(kind), ...state.contentToggles } : defaultContentToggles(kind);
		this.results = (shouldKeepLiveResults ? previousResults : restoredResults).filter(result =>
			result.kind === kind && (this.scope !== 'selected' || connectionSearchIncludes(this.targets, result.connectionId, result.database)));
		this._kustoSearchOwnerToken = '';
		this._kustoPrincipalFingerprint = typeof state.kustoPrincipalFingerprint === 'string' ? state.kustoPrincipalFingerprint : '';
		this._kustoPolicyVersion = Number.isSafeInteger(state.kustoPolicyVersion) ? state.kustoPolicyVersion : undefined;
		this.host.requestUpdate();
	}

	// ── User actions ──────────────────────────────────────────────────────

	setQuery(query: string): void {
		if (query === this.query) return;
		this.cancelSearch();
		this.results = [];
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

	setScope(scope: SearchScope): void {
		if (scope === this.scope) return;
		this.scope = scope;
		this._restartForTargets();
	}

	setTargets(targets: readonly ConnectionSearchTarget[]): void {
		const nextTargets = normalizeConnectionSearchTargets(targets);
		if (this.scope === 'selected' && sameConnectionSearchTargets(this.targets, nextTargets)) return;
		this.targets = nextTargets;
		this.scope = 'selected';
		this._restartForTargets();
	}

	private _restartForTargets(): void {
		this._clearSearchDebounce();
		this.cancelSearch();
		this.results = [];
		if (this.canSearch && this.query.trim()) this._debouncedSearch();
		this._editedKinds.add(this._kind);
		this._saveStateNow();
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
		this._clearSearchDebounce();
		this._cancelActiveSearch();
		this.loading = false;
		this.refreshing = false;
		this.progressMessage = '';
		this.host.requestUpdate();
	}

	invalidateKustoResults(): void {
		if (this._kind !== 'kusto') return;
		this._cancelActiveSearch();
		this.results = [];
		this.loading = false;
		this.refreshing = false;
		this.progressMessage = '';
		this._saveStateNow();
		this.host.requestUpdate();
	}

	invalidateSqlResults(): void {
		if (this._kind !== 'sql') return;
		this._cancelActiveSearch();
		this.results = [];
		this.loading = false;
		this.refreshing = false;
		this.progressMessage = '';
		this._saveStateNow();
		this.host.requestUpdate();
	}

	// ── Message handling (called by host component's _onMessage) ──────────

	handleSearchResults(requestId: string, results: SearchResult[], completed: boolean, kustoSearchOwnerToken?: string): boolean {
		if (requestId !== this._activeRequestId) return false;
		if (this._kind === 'kusto') {
			const token = String(kustoSearchOwnerToken || '').trim();
			if (!token || (this._kustoSearchOwnerToken && this._kustoSearchOwnerToken !== token)) return false;
			this._kustoSearchOwnerToken = token;
		}
		// Deduplicate: build a set of existing result keys, only add genuinely new ones
		const existingKeys = new Set(this.results.map(r => `${r.category}|${r.connectionId}|${r.database ?? ''}|${r.name}|${r.parentName ?? ''}`));
		const newResults = results
			.filter(result => result.kind === this._kind)
			.filter(result => this.scope !== 'selected' || connectionSearchIncludes(this.targets, result.connectionId, result.database))
			.filter(r => !existingKeys.has(`${r.category}|${r.connectionId}|${r.database ?? ''}|${r.name}|${r.parentName ?? ''}`))
			.map(result => this._kind === 'kusto' ? { ...result, kustoSearchOwnerToken: this._kustoSearchOwnerToken } : result);
		if (newResults.length) this.results = [...this.results, ...newResults];
		if (completed) {
			this.loading = false;
			this.refreshing = false;
			this.progressMessage = '';
			this._activeRequestId = null;
			this._saveStateNow();
		}
		this.host.requestUpdate();
		return true;
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
		this._clearSearchDebounce();
		this._searchDebounceTimer = setTimeout(() => {
			this._searchDebounceTimer = null;
			if (this.canSearch && this.query.trim()) {
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

	private _clearSearchDebounce(): void {
		if (this._searchDebounceTimer) clearTimeout(this._searchDebounceTimer);
		this._searchDebounceTimer = null;
	}

	private _debouncedSave(): void {
		this._editedKinds.add(this._kind);
		if (this._saveDebounceTimer) clearTimeout(this._saveDebounceTimer);
		this._saveDebounceTimer = setTimeout(() => {
			this._saveDebounceTimer = null;
			this._saveStateNow();
		}, 500);
	}

	private _saveStateNow(): void {
		if (this._saveDebounceTimer) {
			clearTimeout(this._saveDebounceTimer);
			this._saveDebounceTimer = null;
		}
		this.host.postMessage({ type: 'search.saveState', kind: this._kind, state: this._captureState() });
	}

	private _captureState(): SearchState {
		return {
			kind: this._kind,
			query: this.query,
			scope: this.scope,
			targets: this.targets.map(target => ({ ...target })),
			categories: { ...this.categories },
			contentToggles: { ...this.contentToggles },
			lastResults: [...this.results],
			lastSearchTimestamp: Date.now(),
			...(this._kind === 'kusto' && this._kustoPrincipalFingerprint
				? { kustoPrincipalFingerprint: this._kustoPrincipalFingerprint }
				: {}),
			...(this._kind === 'kusto' && this._kustoPolicyVersion !== undefined
				? { kustoPolicyVersion: this._kustoPolicyVersion }
				: {}),
		};
	}

	private _performSearch(): void {
		this._clearSearchDebounce();
		if (!this.canSearch) return;
		this._cancelActiveSearch();
		const requestId = `search_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		this._activeRequestId = requestId;
		this._kustoSearchOwnerToken = '';
		this.results = [];
		this.loading = true;
		this.refreshing = this.scope !== 'cached';
		this.progressMessage = '';
		this.progressCurrent = 0;
		this.progressTotal = 0;
		this.host.postMessage({
			type: 'search',
			requestId,
			query: this.query.trim(),
			scope: this.scope,
			kind: this._kind,
			...(this.scope === 'selected' ? { targets: this.targets.map(target => ({ ...target })) } : {}),
			categories: this.effectiveCategories,
			contentToggles: this.contentToggles,
		});
		this.host.requestUpdate();
	}

	/** Like _performSearch but keeps existing results — new results are merged via dedup in handleSearchResults. */
	private _performIncrementalSearch(): void {
		this._clearSearchDebounce();
		if (!this.canSearch) return;
		this._cancelActiveSearch();
		const requestId = `search_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		this._activeRequestId = requestId;
		this._kustoSearchOwnerToken = '';
		this.loading = true;
		this.refreshing = this.scope !== 'cached';
		this.progressMessage = '';
		this.progressCurrent = 0;
		this.progressTotal = 0;
		this.host.postMessage({
			type: 'search',
			requestId,
			query: this.query.trim(),
			scope: this.scope,
			kind: this._kind,
			...(this.scope === 'selected' ? { targets: this.targets.map(target => ({ ...target })) } : {}),
			categories: this.effectiveCategories,
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

}
