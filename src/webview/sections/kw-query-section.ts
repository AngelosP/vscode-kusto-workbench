import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { styles } from './kw-query-section.styles.js';
import { customElement, property, state } from 'lit/decorators.js';
import type { DataTableColumn, DataTableOptions } from '../components/kw-data-table.js';
import type { DropdownItem, DropdownAction } from '../components/kw-dropdown.js';
import { pushDismissable, removeDismissable } from '../components/dismiss-stack.js';
import '../components/kw-dropdown.js';
import '../components/kw-section-shell.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Serialized shape for .kqlx persistence — must match KqlxSectionV1 query variant. */
export interface QuerySectionData {
	id: string;
	type: 'query';
	name: string;
	favoritesMode?: boolean;
	clusterUrl: string;
	database: string;
	query: string;
	expanded: boolean;
	resultsVisible: boolean;
	resultJson?: string;
	runMode: string;
	cacheEnabled: boolean;
	cacheValue: number;
	cacheUnit: string;
	editorHeightPx?: number;
	resultsHeightPx?: number;
	copilotChatVisible?: boolean;
	copilotChatWidthPx?: number;
}

/** Connection object matching the shape from the extension host. */
export interface KustoConnection {
	id: string;
	name?: string;
	clusterUrl: string;
}

/** Favorite entry (cluster+database pair). */
export interface KustoFavorite {
	clusterUrl: string;
	database: string;
	name?: string;
	label?: string;
}

/** Schema info display state. */
export interface SchemaInfoState {
	status: 'not-loaded' | 'loading' | 'loaded' | 'cached' | 'error';
	statusText?: string;
	tables?: number;
	cols?: number;
	funcs?: number;
	cached?: boolean;
	errorMessage?: string;
}

// ─── SVG Icons (matching legacy exactly) ──────────────────────────────────────

const clusterIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M5 3.5h6"/><path d="M4 6h8"/><path d="M3.5 8.5h9"/><path d="M4 11h8"/><path d="M5 13.5h6"/></svg>`;

const databaseIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4"/><path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/><path d="M3 12c0 1.1 2.2 2 5 2s5-.9 5-2"/></svg>`;

const refreshIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 8a4.5 4.5 0 0 1 7.8-3.1"/><polyline points="11.3 2.7 11.3 5.4 8.6 5.4"/><path d="M12.5 8a4.5 4.5 0 0 1-7.8 3.1"/><polyline points="4.7 13.3 4.7 10.6 7.4 10.6"/></svg>`;

const favoriteStarIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 1.4l2.1 4.2 4.6.7-3.4 3.3.8 4.6L8 12l-4.1 2.2.8-4.6L1.3 6.3l4.6-.7L8 1.4z" /></svg>`;

const favoritesListIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 1.4l2.1 4.2 4.6.7-3.4 3.3L8 12l-4.1 2.2.8-4.6L1.3 6.3l4.6-.7L8 1.4z" /><line x1="10" y1="10.5" x2="14.5" y2="10.5" stroke-width="1.4" stroke-linecap="round" /><line x1="10" y1="12.5" x2="14.5" y2="12.5" stroke-width="1.4" stroke-linecap="round" /><line x1="10" y1="14.5" x2="14.5" y2="14.5" stroke-width="1.4" stroke-linecap="round" /></svg>`;

const schemaInfoIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 1C4.13 1 1 4.13 1 8s3.13 7 7 7 7-3.13 7-7-3.13-7-7-7zm0 12.5c-3.04 0-5.5-2.46-5.5-5.5S4.96 2.5 8 2.5s5.5 2.46 5.5 5.5-2.46 5.5-5.5 5.5zM7.25 5h1.5v1.5h-1.5V5zm0 2.5h1.5v4h-1.5v-4z"/></svg>`;

const spinnerSvg = html`<span class="query-spinner" aria-hidden="true"></span>`;

const clusterPickerIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><ellipse cx="8" cy="4" rx="5" ry="2" /><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" /><path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" /></svg>`;

const shareIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 3a2 2 0 1 1-.001 4.001A2 2 0 0 1 12 3zm0 1a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/><path d="M4 6a2 2 0 1 1-.001 4.001A2 2 0 0 1 4 6zm0 1a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/><path d="M12 9a2 2 0 1 1-.001 4.001A2 2 0 0 1 12 9zm0 1a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/><path d="M5.5 7.5l5-2.5M5.5 8.5l5 2.5" stroke="currentColor" stroke-width="1" fill="none"/></svg>`;




// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeClusterUrlKey(url: string): string {
	let u = String(url || '').trim();
	if (!u) return '';
	if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
	try { return new URL(u).hostname.toLowerCase(); } catch { return u.toLowerCase(); }
}

function clusterShortNameKey(url: string): string {
	const host = normalizeClusterUrlKey(url);
	const dot = host.indexOf('.');
	return dot > 0 ? host.substring(0, dot).toLowerCase() : host;
}

function formatClusterShortName(clusterUrl: string): string {
	try {
		if (typeof window.formatClusterShortName === 'function') {
			return window.formatClusterShortName(clusterUrl);
		}
	} catch { /* ignore */ }
	const raw = String(clusterUrl || '').trim();
	if (!raw) return '';
	const withScheme = /^https?:\/\//i.test(raw) ? raw : ('https://' + raw);
	try {
		const host = new URL(withScheme).hostname;
		return host.split('.')[0] || host;
	} catch { return raw; }
}

function formatFavoriteDisplay(fav: KustoFavorite): { primary: string; suffix: string } {
	const name = String(fav.name || fav.label || '').trim();
	const clusterShort = formatClusterShortName(fav.clusterUrl);
	const db = String(fav.database || '').trim();
	const clusterDb = (clusterShort && db) ? `${clusterShort}.${db}` : (clusterShort || db);
	const primary = name || clusterDb;
	const showSuffix = !!(name && clusterDb && name !== clusterDb);
	return { primary, suffix: showSuffix ? `(${clusterDb})` : '' };
}

function formatClusterDisplayName(conn: KustoConnection): string {
	try {
		if (typeof window.formatClusterDisplayName === 'function') {
			return window.formatClusterDisplayName(conn);
		}
	} catch { /* ignore */ }
	if (conn.name) return conn.name;
	let url = conn.clusterUrl || '';
	if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
	try { return new URL(url).hostname; } catch { return url; }
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<kw-query-section>` — Lit web component for a Query section.
 *
 * **Progressive migration**: The connection/database row renders in shadow DOM.
 * The editor, toolbar, action bar, and results remain in light DOM via `<slot>`.
 *
 * The element keeps `class="query-box"` so existing queryEditor.css selectors
 * (`.query-box.is-collapsed`, container queries, etc.) match the light-DOM
 * children directly.
 */
@customElement('kw-query-section')
export class KwQuerySection extends LitElement {

	@property({ type: String, reflect: true, attribute: 'box-id' })
	boxId = '';

	// ── Connection row reactive state ─────────────────────────────────────────

	@state() private _connections: KustoConnection[] = [];
	@state() private _connectionId = '';
	@state() private _desiredClusterUrl = '';
	@state() private _databases: string[] = [];
	@state() private _database = '';
	@state() private _desiredDatabase = '';
	@state() private _databasesLoading = false;
	@state() private _refreshLoading = false;
	@state() private _favoritesMode = false;
	@state() private _favorites: KustoFavorite[] = [];
	@state() private _schemaInfo: SchemaInfoState = { status: 'not-loaded' };

	// ── Header row reactive state ─────────────────────────────────────────────

	@state() private _name = '';
	@state() private _expanded = true;

	// Schema popover open state (dropdowns now managed by <kw-dropdown>)
	@state() private _schemaPopoverOpen = false;

	// Bound handler for close-on-outside-click (schema popover)
	private _closeSchemaPopoverBound = this._closeSchemaPopoverOnOutsideClick.bind(this);

	// Dismiss stack callback for schema popover
	private _dismissSchemaPopover = (): void => { this._schemaPopoverOpen = false; };
	// Bound handler for close-on-scroll (schema popover)
	private _closeSchemaPopoverOnScrollBound = this._closeSchemaPopoverOnScroll.bind(this);

	// ── Styles ────────────────────────────────────────────────────────────────

	static override styles = styles;

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	override connectedCallback(): void {
		super.connectedCallback();
		document.addEventListener('mousedown', this._closeSchemaPopoverBound);
		document.addEventListener('scroll', this._closeSchemaPopoverOnScrollBound, true);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		document.removeEventListener('mousedown', this._closeSchemaPopoverBound);
		document.removeEventListener('scroll', this._closeSchemaPopoverOnScrollBound, true);
	}

	// ── Render ─────────────────────────────────────────────────────────────────

	override render(): TemplateResult {
		return html`
			<div class="header-group" @dropdown-opened=${this._onDropdownOpened}>
				<kw-section-shell
					.name=${this._name}
					.expanded=${this._expanded}
					box-id=${this.boxId}
					name-placeholder="Query Name (optional)"
					@name-change=${this._onShellNameChange}
					@toggle-visibility=${this._onToggleClick}
					@fit-to-contents=${this._onMaximizeClick}
					@section-remove=${this._onShellRemove}>
					<button slot="header-buttons" class="header-tab header-share-btn" type="button"
						title="Share" aria-label="Share"
						@click=${this._onShareClick}>${shareIconSvg}</button>
					<div slot="header-extra">
						${this._renderConnectionRow()}
					</div>
				</kw-section-shell>
			</div>
			<slot></slot>
		`;
	}

	// ── Connection row sub-templates ──────────────────────────────────────────

	private _renderConnectionRow(): TemplateResult {
		if (this._favoritesMode) {
			return html`
				<div class="connection-row">
					${this._renderFavoritesDropdown()}
					${this._renderFavoriteModeBtn()}
					${this._renderSchemaInfoWrapper()}
				</div>
			`;
		}
		return html`
			<div class="connection-row">
				${this._renderClusterDropdown()}
				${this._renderDatabaseDropdown()}
				<span class="refresh-btn-wrap">
					<button type="button" class="icon-btn" title="Refresh database list"
						aria-label="Refresh database list"
						?disabled=${!this._connectionId || this._refreshLoading}
						@click=${this._onRefreshClick}>
						${this._refreshLoading ? spinnerSvg : refreshIconSvg}
					</button>
				</span>
				<span class="favorite-btn-wrap">
					<button type="button" class="icon-btn favorite-btn ${this._isFavorited() ? 'favorite-active' : ''}"
						title="${this._isFavorited() ? 'Remove from favorites' : 'Add to favorites'}"
						aria-label="${this._isFavorited() ? 'Remove from favorites' : 'Add to favorites'}"
						@click=${this._onFavoriteToggle}>
						${favoriteStarIconSvg}
					</button>
				</span>
				${this._renderFavoriteModeBtn()}
				${this._renderSchemaInfoWrapper()}
			</div>
		`;
	}

	private _renderClusterDropdown(): TemplateResult {
		const sorted = [...this._connections].sort((a, b) =>
			formatClusterDisplayName(a).toLowerCase().localeCompare(formatClusterDisplayName(b).toLowerCase())
		);
		const clusterItems: DropdownItem[] = sorted.map(c => ({
			id: c.id,
			label: formatClusterDisplayName(c),
		}));
		const clusterActions: DropdownAction[] = [
			{ id: '__enter_new__', label: 'Enter new cluster…' },
			{ id: '__import_xml__', label: 'Import from .xml file…' },
		];
		return html`
			<div class="select-wrapper half-width" title="Kusto Cluster">
				<kw-dropdown
					.items=${clusterItems}
					.actions=${clusterActions}
					.selectedId=${this._connectionId}
					.placeholder=${'Select Cluster...'}
					.emptyText=${'No connections.'}
					.buttonIcon=${clusterIconSvg}
					@dropdown-select=${this._onClusterSelected}
					@dropdown-action=${this._onClusterAction}
				></kw-dropdown>
			</div>
		`;
	}

	private _renderDatabaseDropdown(): TemplateResult {
		const dbItems: DropdownItem[] = (this._databases || []).map(db => ({ id: db, label: db }));
		return html`
			<div class="select-wrapper half-width" title="Kusto Database">
				<kw-dropdown
					.items=${dbItems}
					.selectedId=${this._database}
					.placeholder=${'Select Database...'}
					.emptyText=${this._databasesLoading ? 'Loading...' : 'No databases.'}
					?disabled=${!this._connectionId}
					?loading=${this._databasesLoading}
					.loadingText=${'Loading databases...'}
					.buttonIcon=${databaseIconSvg}
					@dropdown-select=${this._onDatabaseSelected}
				></kw-dropdown>
			</div>
		`;
	}

	private _renderFavoritesDropdown(): TemplateResult {
		const favItems: DropdownItem[] = (this._favorites || []).map((f, i) => {
			const d = formatFavoriteDisplay(f);
			return {
				id: String(i),
				label: d.primary,
				secondary: d.suffix || undefined,
			};
		});
		const selectedFavIdx = this._getSelectedFavoriteIndex();
		const favActions: DropdownAction[] = [
			{ id: '__other__', label: 'Other...', position: 'bottom' },
		];
		return html`
			<div class="select-wrapper kusto-favorites-combo" title="Favorites">
				<kw-dropdown
					.items=${favItems}
					.actions=${favActions}
					.selectedId=${selectedFavIdx >= 0 ? String(selectedFavIdx) : ''}
					.placeholder=${'Select favorite...'}
					.emptyText=${'No favorites yet.'}
					.showDelete=${true}
					.buttonIcon=${favoritesListIconSvg}
					.compactIconOnly=${true}
					@dropdown-select=${this._onFavoriteSelected}
					@dropdown-action=${this._onFavoriteAction}
					@dropdown-item-delete=${this._onFavoriteRemoved}
				></kw-dropdown>
			</div>
		`;
	}

	private _renderFavoriteModeBtn(): TemplateResult {
		if (!this._favorites.length && !this._favoritesMode) return html``;
		return html`
			<button type="button" class="icon-btn"
				title="${this._favoritesMode ? 'Show cluster and database picker' : 'Show favorites'}"
				aria-label="${this._favoritesMode ? 'Show cluster and database picker' : 'Show favorites'}"
				@click=${this._onFavoritesModeToggle}>
				${this._favoritesMode ? clusterPickerIconSvg : favoritesListIconSvg}
			</button>
		`;
	}

	private _renderSchemaInfoWrapper(): TemplateResult {
		const si = this._schemaInfo;
		const btnClass = [
			'schema-info-btn',
			si.status === 'loading' ? 'is-loading' : '',
			si.status === 'loaded' || si.status === 'cached' ? 'has-schema' : '',
			si.status === 'cached' ? 'is-cached' : '',
			si.status === 'error' ? 'is-error' : '',
			this._schemaPopoverOpen ? 'is-open' : '',
		].filter(Boolean).join(' ');

		return html`
			<div class="schema-info-wrapper">
				<button type="button" class="${btnClass}"
					title="Schema info" aria-label="Schema info"
					aria-haspopup="true" aria-expanded="${this._schemaPopoverOpen ? 'true' : 'false'}"
					@click=${this._toggleSchemaPopover}
					@mousedown=${(e: Event) => e.stopPropagation()}>
					${schemaInfoIconSvg}
				</button>
				${this._schemaPopoverOpen ? this._renderSchemaInfoPopover() : nothing}
			</div>
		`;
	}

	private _renderSchemaInfoPopover(): TemplateResult {
		const si = this._schemaInfo;
		const statusText = si.statusText || (si.status === 'not-loaded' ? 'Not loaded' : si.status === 'loading' ? 'Loading...' : si.status === 'loaded' ? 'Loaded' : si.status === 'cached' ? 'Cached' : si.status === 'error' ? (si.errorMessage || 'Error') : 'Unknown');
		const statusClass = si.status === 'error' ? 'schema-info-status is-error' : 'schema-info-status';
		return html`
			<div class="schema-info-popover" role="tooltip"
				@mousedown=${(e: Event) => e.stopPropagation()}>
				<div class="schema-info-popover-content">
					<div class="schema-info-row">
						<span class="schema-info-label">Status:</span>
						<span class="${statusClass}">${statusText}</span>
					</div>
					${(si.status === 'loaded' || si.status === 'cached') && si.tables !== undefined ? html`
						<div class="schema-info-row">
							<span class="schema-info-label">Tables:</span>
							<span class="schema-info-value">${si.tables}</span>
						</div>
					` : nothing}
					${(si.status === 'loaded' || si.status === 'cached') && si.cols !== undefined ? html`
						<div class="schema-info-row">
							<span class="schema-info-label">Columns:</span>
							<span class="schema-info-value">${si.cols}</span>
						</div>
					` : nothing}
					${(si.status === 'loaded' || si.status === 'cached') && si.funcs !== undefined ? html`
						<div class="schema-info-row">
							<span class="schema-info-label">Functions:</span>
							<span class="schema-info-value">${si.funcs}</span>
						</div>
					` : nothing}
					${si.cached ? html`
						<div class="schema-info-row">
							<span class="schema-info-label">Source:</span>
							<a href="#" class="schema-info-cached-link"
								@click=${(e: Event) => { e.preventDefault(); e.stopPropagation(); this._onSeeCachedValues(); }}>Cached</a>
						</div>
					` : nothing}
					<div class="schema-info-actions">
						<button type="button" class="schema-info-refresh-btn"
							@click=${(e: Event) => { e.stopPropagation(); this._onSchemaRefresh(); }}>
							${refreshIconSvg}
							<span>Refresh Schema</span>
						</button>
					</div>
				</div>
			</div>
		`;
	}

	// ── Schema popover positioning ───────────────────────────────────────────

	override updated(changedProps: Map<string, unknown>): void {
		super.updated(changedProps);
		if (this._schemaPopoverOpen) {
			this._positionSchemaPopover();
		}
		// Manage dismiss stack for schema popover
		if (changedProps.has('_schemaPopoverOpen')) {
			if (this._schemaPopoverOpen) pushDismissable(this._dismissSchemaPopover);
			else removeDismissable(this._dismissSchemaPopover);
		}
	}

	private _positionSchemaPopover(): void {
		const root = this.shadowRoot;
		if (!root) return;
		const popover = root.querySelector('.schema-info-popover') as HTMLElement | null;
		const btn = root.querySelector('.schema-info-btn') as HTMLElement | null;
		if (!popover || !btn) return;
		const rect = btn.getBoundingClientRect();
		// Right-align the popover to the button's right edge.
		popover.style.top = (rect.bottom + 4) + 'px';
		popover.style.left = 'auto';
		// Position after render so we can measure popover width.
		requestAnimationFrame(() => {
			const pr = popover.getBoundingClientRect();
			const left = rect.right - pr.width;
			popover.style.left = Math.max(4, left) + 'px';
			const vw = window.innerWidth || 0;
			const vh = window.innerHeight || 0;
			if (vh > 0 && pr.bottom > vh) {
				popover.style.top = Math.max(0, rect.top - pr.height - 4) + 'px';
			}
		});
	}

	// ── Event handlers ────────────────────────────────────────────────────────

	// ── Header row events ─────────────────────────────────────────────────────

	private _onShellNameChange(e: CustomEvent<{ name: string }>): void {
		this._name = e.detail.name;
		try { window.schedulePersist?.(); } catch { /* ignore */ }
		try { window.__kustoRefreshAllDataSourceDropdowns?.(); } catch { /* ignore */ }
	}

	private _onShareClick(): void {
		try { window.__kustoOpenShareModal?.(this.boxId); } catch { /* ignore */ }
	}

	private _onMaximizeClick(): void {
		try { window.__kustoMaximizeQueryBox?.(this.boxId); } catch { /* ignore */ }
	}

	private _onToggleClick(): void {
		try { window.toggleQueryBoxVisibility?.(this.boxId); } catch { /* ignore */ }
	}

	private _onShellRemove(e: Event): void {
		// Stop propagation so the composed event doesn't bubble further —
		// query sections use a legacy window function for removal.
		e.stopPropagation();
		try { window.removeQueryBox?.(this.boxId); } catch { /* ignore */ }
	}



	// ── Dropdown events ───────────────────────────────────────────────────────

	// Scroll position when schema popover was last opened (for threshold dismiss)
	private _scrollAtSchemaOpen = 0;

	/** Close all <kw-dropdown> instances in this section + schema popover. */
	private _closeAllPopups(): void {
		this._schemaPopoverOpen = false;
		const dropdowns = this.shadowRoot?.querySelectorAll('kw-dropdown');
		dropdowns?.forEach(dd => (dd as any).close());
	}

	/** When any <kw-dropdown> opens, close others + schema popover. */
	private _onDropdownOpened(e: Event): void {
		// Close schema popover
		this._schemaPopoverOpen = false;
		// Close all OTHER dropdowns (the one that just opened handles itself)
		const source = e.target;
		const dropdowns = this.shadowRoot?.querySelectorAll('kw-dropdown');
		dropdowns?.forEach(dd => {
			if (dd !== source) (dd as any).close();
		});
	}

	private _closeSchemaPopoverOnOutsideClick(e: MouseEvent): void {
		if (!this._schemaPopoverOpen) return;
		const path = e.composedPath();
		if (path.includes(this)) return;
		this._schemaPopoverOpen = false;
	}

	private _closeSchemaPopoverOnScroll(e: Event): void {
		if (!this._schemaPopoverOpen) return;
		// Don't dismiss if scrolling inside the popover itself
		const target = e.target as Element | null;
		if (target && this.shadowRoot) {
			const popover = this.shadowRoot.querySelector('.schema-info-popover');
			if (popover && popover.contains(target)) return;
		}
		const scrollY = document.documentElement.scrollTop || document.body.scrollTop || 0;
		if (Math.abs(scrollY - this._scrollAtSchemaOpen) > 20) {
			this._schemaPopoverOpen = false;
		}
	}

	private _toggleSchemaPopover(e: Event): void {
		e.stopPropagation();
		const wasOpen = this._schemaPopoverOpen;
		// Close all popups (including dropdowns)
		this._closeAllPopups();
		if (!wasOpen) {
			this._schemaPopoverOpen = true;
			this._scrollAtSchemaOpen = document.documentElement.scrollTop || document.body.scrollTop || 0;
		}
	}

	private _onClusterAction(e: CustomEvent): void {
		const action = e.detail?.id;
		if (action === '__enter_new__') {
			try { window.promptAddConnectionFromDropdown?.(this.boxId); } catch { /* ignore */ }
		} else if (action === '__import_xml__') {
			try { window.importConnectionsFromXmlFile?.(this.boxId); } catch { /* ignore */ }
		}
	}

	private _onClusterSelected(e: CustomEvent): void {
		const connectionId = e.detail?.id;
		if (!connectionId) return;
		const prev = this._connectionId;
		this._connectionId = connectionId;
		const conn = this._connections.find(c => c.id === connectionId);
		if (conn) this._desiredClusterUrl = conn.clusterUrl || '';
		if (prev !== connectionId) {
			this._database = '';
			this._databases = [];
			this.dispatchEvent(new CustomEvent('connection-changed', {
				detail: { boxId: this.boxId, connectionId, clusterUrl: conn?.clusterUrl || '' },
				bubbles: true, composed: true,
			}));
		}
	}

	private _onDatabaseSelected(e: CustomEvent): void {
		const database = e.detail?.id;
		if (!database) return;
		const prev = this._database;
		this._database = database;
		if (prev !== database) {
			this.dispatchEvent(new CustomEvent('database-changed', {
				detail: { boxId: this.boxId, database },
				bubbles: true, composed: true,
			}));
		}
	}

	private _onRefreshClick(): void {
		this.dispatchEvent(new CustomEvent('refresh-databases', {
			detail: { boxId: this.boxId, connectionId: this._connectionId },
			bubbles: true, composed: true,
		}));
	}

	private _onFavoriteToggle(): void {
		this.dispatchEvent(new CustomEvent('favorite-toggle', {
			detail: { boxId: this.boxId, connectionId: this._connectionId, database: this._database },
			bubbles: true, composed: true,
		}));
	}

	private _onFavoritesModeToggle(): void {
		this._favoritesMode = !this._favoritesMode;
		this.dispatchEvent(new CustomEvent('favorites-mode-changed', {
			detail: { boxId: this.boxId, favoritesMode: this._favoritesMode },
			bubbles: true, composed: true,
		}));
	}

	private _onFavoriteSelected(e: CustomEvent): void {
		const index = parseInt(e.detail?.id, 10);
		const fav = this._favorites[index];
		if (!fav) return;
		// Find the connection that matches this favorite's clusterUrl
		const target = normalizeClusterUrlKey(fav.clusterUrl);
		const conn = this._connections.find(c => normalizeClusterUrlKey(c.clusterUrl) === target);
		if (conn) {
			this._connectionId = conn.id;
			this._desiredClusterUrl = conn.clusterUrl;
			this._desiredDatabase = fav.database;
			// Clear current database and list so schema/autocomplete reloads.
			this._database = '';
			this._databases = [];
			// Dispatch connection-changed so schema gets cleared and databases reload.
			this.dispatchEvent(new CustomEvent('connection-changed', {
				detail: { boxId: this.boxId, connectionId: conn.id, clusterUrl: conn.clusterUrl },
				bubbles: true, composed: true,
			}));
			// Also dispatch favorite-selected for any listeners that need the database hint.
			this.dispatchEvent(new CustomEvent('favorite-selected', {
				detail: { boxId: this.boxId, connectionId: conn.id, clusterUrl: conn.clusterUrl, database: fav.database },
				bubbles: true, composed: true,
			}));
		}
	}

	private _onFavoriteRemoved(e: CustomEvent): void {
		const index = parseInt(e.detail?.id, 10);
		const fav = this._favorites[index];
		if (!fav) return;
		this.dispatchEvent(new CustomEvent('favorite-removed', {
			detail: { boxId: this.boxId, clusterUrl: fav.clusterUrl, database: fav.database },
			bubbles: true, composed: true,
		}));
	}

	private _onFavoriteAction(e: CustomEvent): void {
		const action = e.detail?.id;
		if (action === '__other__') {
			// Switch back to cluster/database mode so the user can pick manually.
			this._favoritesMode = false;
			this.dispatchEvent(new CustomEvent('favorites-mode-changed', {
				detail: { boxId: this.boxId, favoritesMode: false },
				bubbles: true, composed: true,
			}));
		}
	}

	private _onSchemaRefresh(): void {
		this.dispatchEvent(new CustomEvent('schema-refresh', {
			detail: { boxId: this.boxId },
			bubbles: true, composed: true,
		}));
	}

	private _onSeeCachedValues(): void {
		try { window.vscode?.postMessage({ type: 'seeCachedValues' }); } catch { /* ignore */ }
	}

	// ── Public API (called by legacy code) ────────────────────────────────────

	/** Get/set the query section name. */
	public getName(): string { return this._name; }
	public setName(name: string): void { this._name = name; }

	/** Get/set expanded state. */
	public isExpanded(): boolean { return this._expanded; }
	public setExpanded(expanded: boolean): void {
		this._expanded = expanded;
		// Sync the is-collapsed class on the host element for light-DOM CSS rules.
		this.classList.toggle('is-collapsed', !expanded);
	}

	/** Get the currently selected connection ID. */
	public getConnectionId(): string {
		return this._connectionId;
	}

	/** Get the currently selected database name. */
	public getDatabase(): string {
		return this._database;
	}

	/** Get the cluster URL for the current connection. */
	public getClusterUrl(): string {
		const conn = this._connections.find(c => c.id === this._connectionId);
		return conn?.clusterUrl || '';
	}

	/** Set the desired cluster URL (used during restoration). */
	public setDesiredClusterUrl(url: string): void {
		this._desiredClusterUrl = url;
	}

	/** Set the desired database (used during restoration). */
	public setDesiredDatabase(db: string): void {
		this._desiredDatabase = db;
	}

	/** Update available connections. Resolves desired/current/last selection. */
	public setConnections(
		connections: KustoConnection[],
		opts?: { lastConnectionId?: string }
	): void {
		this._connections = connections;
		const lastConnId = opts?.lastConnectionId || '';

		// Resolve best connection ID: prefer desired > current > last
		let resolvedId = '';

		// 1. Try desired cluster URL
		if (this._desiredClusterUrl) {
			const target = normalizeClusterUrlKey(this._desiredClusterUrl);
			const match = connections.find(c => normalizeClusterUrlKey(c.clusterUrl) === target);
			if (!match) {
				// Try short name
				const targetShort = clusterShortNameKey(this._desiredClusterUrl);
				const shortMatch = connections.find(c => clusterShortNameKey(c.clusterUrl) === targetShort);
				if (shortMatch) resolvedId = shortMatch.id;
			} else {
				resolvedId = match.id;
			}
		}

		// 2. Try current selection
		if (!resolvedId && this._connectionId) {
			const match = connections.find(c => c.id === this._connectionId);
			if (match) resolvedId = match.id;
		}

		// 3. Try last used
		if (!resolvedId && lastConnId) {
			const match = connections.find(c => c.id === lastConnId);
			if (match) resolvedId = match.id;
		}

		const prev = this._connectionId;
		this._connectionId = resolvedId;

		// Update desired cluster URL from resolved connection
		if (resolvedId) {
			const conn = connections.find(c => c.id === resolvedId);
			if (conn) this._desiredClusterUrl = conn.clusterUrl;
		}


		// If connection changed, fire event so databases get loaded
		if (prev !== resolvedId && resolvedId) {
			this.dispatchEvent(new CustomEvent('connection-changed', {
				detail: { boxId: this.boxId, connectionId: resolvedId, clusterUrl: this.getClusterUrl() },
				bubbles: true, composed: true,
			}));
		}
	}

	/** Update available databases. Applies desired database if set. */
	public setDatabases(databases: string[], desiredDb?: string): void {
		this._databases = databases;
		this._databasesLoading = false;

		// Priority tiers (strict — no tier may override a higher one):
		// 1. _desiredDatabase: set by file restore or favorite selection. Highest priority.
		// 2. _database: already-active selection (user picked it, or tier 1 applied it earlier).
		//    A background DB refresh must NEVER override the user's current choice.
		// 3. desiredDb: global lastDatabase hint. Only used when nothing else is selected.
		// 4. Auto-select: single-database clusters.

		if (this._desiredDatabase && databases.includes(this._desiredDatabase)) {
			// Tier 1: explicit desired database (from file or favorite)
			const prev = this._database;
			this._database = this._desiredDatabase;
			this._desiredDatabase = '';
			if (prev !== this._database) {
				this.dispatchEvent(new CustomEvent('database-changed', {
					detail: { boxId: this.boxId, database: this._database },
					bubbles: true, composed: true,
				}));
			}
		} else if (this._database && databases.includes(this._database)) {
			// Tier 2: keep current selection
		} else if (desiredDb && databases.includes(desiredDb)) {
			// Tier 3: global lastDatabase fallback (only when nothing else selected)
			const prev = this._database;
			this._database = desiredDb;
			this._desiredDatabase = '';
			if (prev !== desiredDb) {
				this.dispatchEvent(new CustomEvent('database-changed', {
					detail: { boxId: this.boxId, database: desiredDb },
					bubbles: true, composed: true,
				}));
			}
		} else if (databases.length === 1) {
			// Tier 4: auto-select single database
			const db = databases[0];
			const prev = this._database;
			this._database = db;
			this._desiredDatabase = '';
			if (prev !== db) {
				this.dispatchEvent(new CustomEvent('database-changed', {
					detail: { boxId: this.boxId, database: db },
					bubbles: true, composed: true,
				}));
			}
		}
	}

	/** Set databases loading state. */
	public setDatabasesLoading(loading: boolean): void {
		this._databasesLoading = loading;
	}

	/** Set refresh button loading state. */
	public setRefreshLoading(loading: boolean): void {
		this._refreshLoading = loading;
	}

	/** Update schema info display. */
	public setSchemaInfo(info: Partial<SchemaInfoState>): void {
		this._schemaInfo = { ...this._schemaInfo, ...info };
	}

	/** Set favorites mode. */
	public setFavoritesMode(mode: boolean): void {
		this._favoritesMode = mode;
	}

	/** Whether favorites mode is active. */
	public isFavoritesMode(): boolean {
		return this._favoritesMode;
	}

	/** Update available favorites. Sorts alphabetically by name. */
	public setFavorites(favorites: KustoFavorite[]): void {
		const sorted = (Array.isArray(favorites) ? favorites : []).slice().sort((a, b) => {
			const an = String((a?.name) || '').toLowerCase();
			const bn = String((b?.name) || '').toLowerCase();
			return an.localeCompare(bn);
		});
		this._favorites = sorted;
	}

	/** Check if run button should be enabled (has connection + database). */
	public hasConnectionAndDatabase(): boolean {
		return !!(this._connectionId && this._database);
	}

	/** Programmatically set connection ID (e.g. from tool configuration). */
	public setConnectionId(connectionId: string): void {
		if (this._connectionId !== connectionId) {
			this._connectionId = connectionId;
			const conn = this._connections.find(c => c.id === connectionId);
			if (conn) this._desiredClusterUrl = conn.clusterUrl;
		}
	}

	/** Programmatically set database (e.g. from tool configuration). */
	public setDatabase(database: string): void {
		this._database = database;
	}

	// ── Private helpers ───────────────────────────────────────────────────────

	private _isFavorited(): boolean {
		if (!this._connectionId || !this._database) return false;
		const clusterUrl = this.getClusterUrl();
		if (!clusterUrl) return false;
		const target = normalizeClusterUrlKey(clusterUrl);
		const dbLower = this._database.toLowerCase();
		return this._favorites.some(f =>
			normalizeClusterUrlKey(f.clusterUrl) === target && (f.database || '').toLowerCase() === dbLower
		);
	}

	/** Find the index of the favorite matching the current connection+database. Returns -1 if none. */
	private _getSelectedFavoriteIndex(): number {
		if (!this._connectionId) return -1;
		const db = this._database || this._desiredDatabase;
		if (!db) return -1;
		const clusterUrl = this.getClusterUrl();
		if (!clusterUrl) return -1;
		const target = normalizeClusterUrlKey(clusterUrl);
		const dbLower = db.toLowerCase();
		return this._favorites.findIndex(f =>
			normalizeClusterUrlKey(f.clusterUrl) === target && (f.database || '').toLowerCase() === dbLower
		);
	}

	// ── Results via <kw-data-table> ───────────────────────────────────────────

	/**
	 * Display query results using `<kw-data-table>`.
	 * Called from `displayResultForBox()` in resultsTable.js when it detects
	 * that the section element has this method.
	 */
	public displayResult(
		result: { columns?: { name: string; type?: string }[]; rows?: unknown[][]; metadata?: Record<string, unknown> },
		options?: { label?: string; showExecutionTime?: boolean }
	): void {
		const columns: DataTableColumn[] = Array.isArray(result?.columns)
			? result.columns.map(c => {
				// Columns can be plain strings (from Kusto result) or objects { name, type }.
				if (typeof c === 'string') return { name: c, type: '' };
				return { name: String(c?.name || c || ''), type: String(c?.type || '') };
			})
			: [];
		const rows = Array.isArray(result?.rows) ? result.rows : [];
		const metadata = (result?.metadata && typeof result.metadata === 'object') ? result.metadata : {};

		const resultsDiv = document.getElementById(this.boxId + '_results');
		const resultsWrapper = document.getElementById(this.boxId + '_results_wrapper');
		const resizer = document.getElementById(this.boxId + '_results_resizer');
		if (!resultsDiv) return;

		resultsDiv.innerHTML = '';

		if (!columns.length && !rows.length) {
			resultsDiv.innerHTML = '<div class="results-header"><span class="results-title">No results</span></div>';
			if (resultsWrapper) { resultsWrapper.style.display = 'block'; resultsWrapper.style.height = ''; }
			if (resizer) resizer.style.display = 'none';
			return;
		}

		const dt = document.createElement('kw-data-table') as any;
		// Check persisted visibility state.
		let initialBodyVisible = true;
		try {
			const m = window.__kustoResultsVisibleByBoxId;
			if (m && m[this.boxId] === false) initialBodyVisible = false;
		} catch { /* ignore */ }
		// Set options BEFORE columns/rows so _initTable sees initialBodyVisible.
		dt.options = {
			label: options?.label || 'Results',
			showExecutionTime: options?.showExecutionTime !== false,
			executionTime: typeof metadata.executionTime === 'string' ? metadata.executionTime : '',
			showSave: true,
			showVisibilityToggle: true,
			hideTopBorder: true,
			initialBodyVisible,
			metadata: {
				clientActivityId: typeof metadata.clientActivityId === 'string' ? metadata.clientActivityId : undefined,
				serverStats: (metadata.serverStats && typeof metadata.serverStats === 'object') ? metadata.serverStats as Record<string, unknown> : undefined,
			},
		} as DataTableOptions;
		dt.columns = columns;
		dt.rows = rows;

		dt.addEventListener('save', (e: CustomEvent) => {
			try {
				window.vscode?.postMessage({
					type: 'saveResultsCsv',
					csv: e.detail.csv,
					suggestedFileName: e.detail.suggestedFileName,
				});
			} catch { /* ignore */ }
		});

		// Handle visibility toggle: shrink/expand the wrapper directly.
		// Do NOT delegate to legacy toggleQueryResultsVisibility — it looks for
		// .table-container and _results_body which don't exist with <kw-data-table>.
		dt.addEventListener('visibility-toggle', (e: CustomEvent) => {
			const visible = e.detail?.visible ?? true;
			// Update the global map so serialize() picks up the correct value.
			try {
				if (!window.__kustoResultsVisibleByBoxId || typeof window.__kustoResultsVisibleByBoxId !== 'object') {
					window.__kustoResultsVisibleByBoxId = {};
				}
				window.__kustoResultsVisibleByBoxId[this.boxId] = !!visible;
			} catch { /* ignore */ }
			if (resultsWrapper) {
				if (!visible) {
					// Shrink: remember current height, collapse to header-only height.
					const curH = resultsWrapper.style.height;
					if (curH && curH !== 'auto' && curH !== '40px') {
						resultsWrapper.dataset.kustoPreviousHeight = curH;
						// Mark as user-resized so the height is persisted to the .kqlx file
						// and correctly restored when the file is reopened.
						resultsWrapper.dataset.kustoUserResized = 'true';
					}
					// Collapse to just enough for the kw-data-table header bar.
					resultsWrapper.style.height = '40px';
					resultsWrapper.style.overflow = 'hidden';
				} else {
					// Expand: restore previous height.
					const prev = resultsWrapper.dataset.kustoPreviousHeight;
					resultsWrapper.style.height = prev || '300px';
					resultsWrapper.style.overflow = '';
					delete resultsWrapper.dataset.kustoPreviousHeight;
				}
			}
			// Show/hide the resize grip.
			if (resizer) resizer.style.display = visible ? '' : 'none';
			try { window.schedulePersist?.(); } catch { /* ignore */ }
		});

		// Adjust wrapper height when data-table chrome (search bar, row-jump, etc.) toggles.
		dt.addEventListener('chrome-height-change', () => {
			if (!resultsWrapper) return;
			// Skip if collapsed or hidden.
			const curH = parseInt(resultsWrapper.style.height, 10);
			if (!curH || curH <= 40) return;
			requestAnimationFrame(() => {
				if (typeof dt.getContentHeight !== 'function') return;
				const contentH = dt.getContentHeight();
				if (contentH <= 0) return;
				const resizerH = resizer ? resizer.getBoundingClientRect().height : 12;
				const desiredH = contentH + resizerH + 1;
				// Grow or shrink the wrapper to fit, capped to 900px.
				resultsWrapper.style.height = Math.max(120, Math.min(900, desiredH)) + 'px';
			});
		});

		resultsDiv.appendChild(dt);

		// Ensure the results wrapper has proper layout for kw-data-table.
		if (resultsWrapper) {
			resultsWrapper.style.display = 'flex';
			if (!initialBodyVisible) {
				// Start collapsed — just enough for the kw-data-table header bar.
				resultsWrapper.style.height = '40px';
				resultsWrapper.style.overflow = 'hidden';
				if (resizer) resizer.style.display = 'none';
			} else if (!resultsWrapper.dataset.kustoUserResized) {
				// Auto-fit: estimate height from row count, capped to show at most 10 visible rows.
				// Row height is 27px (non-compact). Chrome includes header bar, thead, resizer,
				// border/padding, and extra headroom for scrollbar/sub-pixel rounding.
				const ROW_H = 27;
				const CHROME = 120;
				const MAX_AUTO_ROWS = 10;
				const MAX_AUTO_H = CHROME + (MAX_AUTO_ROWS * ROW_H);
				const estimatedH = CHROME + (rows.length * ROW_H);
				resultsWrapper.style.height = Math.max(120, Math.min(MAX_AUTO_H, estimatedH)) + 'px';
			}
		}
		// Show the resize grip (unless results are hidden).
		if (resizer && initialBodyVisible) resizer.style.display = '';
		// kw-data-table fills available space
		dt.style.display = 'flex';
		dt.style.flexDirection = 'column';
		dt.style.flex = '1 1 auto';
		dt.style.minHeight = '0';
		dt.style.height = '100%';

		// After the data-table renders, refine the height with actual measurements.
		// Cap to ~10 visible rows (same constant as the initial estimate above).
		const REFINE_ROW_H = 27;
		const REFINE_MAX_ROWS = 10;
		const REFINE_CHROME = 120;
		const REFINE_MAX_H = REFINE_CHROME + (REFINE_MAX_ROWS * REFINE_ROW_H);
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (!resultsWrapper || !dt || typeof dt.getContentHeight !== 'function') return;
				if (!initialBodyVisible) return;
				if (resultsWrapper.dataset.kustoUserResized) return;
				const contentH = dt.getContentHeight();
				if (contentH > 0) {
					// Add wrapper chrome: resizer + border-top + padding.
					const resizerH = resizer ? resizer.getBoundingClientRect().height : 12;
					const wrapperBorder = 1; // border-top on .results-wrapper
					const desiredH = contentH + resizerH + wrapperBorder;
					resultsWrapper.style.height = Math.max(120, Math.min(REFINE_MAX_H, desiredH)) + 'px';
				}
			});
		});
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	/**
	 * Serialize to the .kqlx JSON format.
	 * Reads state from light-DOM children by ID — identical output to the
	 * legacy persistence.js DOM-walking code.
	 */
	public serialize(): QuerySectionData {
		const b = this.boxId;

		const name = this._name;

		// Read connection/database from internal state (shadow DOM)
		const connectionId = this._connectionId;
		const database = this._database;

		let favoritesMode: boolean | undefined;
		if (this._favoritesMode) favoritesMode = true;

		const expanded = this._expanded;
		let resultsVisible = true;
		try { const m = window.__kustoResultsVisibleByBoxId; resultsVisible = !(m && m[b] === false); } catch { /* ignore */ }

		const clusterUrl = this.getClusterUrl();

		let query = '';
		try {
			const qe = window.queryEditors;
			if (qe && qe[b] && typeof qe[b].getValue === 'function') {
				query = qe[b].getValue() || '';
			}
		} catch { /* ignore */ }
		if (!query) { try { query = window.__kustoPendingQueryTextByBoxId?.[b] || ''; } catch { /* ignore */ } }

		let resultJson = '';
		try { resultJson = String(window.__kustoQueryResultJsonByBoxId?.[b] || ''); } catch { /* ignore */ }

		const runMode = (window.runModesByBoxId?.[b]) || 'take100';

		const cacheEnabledEl = document.getElementById(b + '_cache_enabled') as HTMLInputElement | null;
		const cacheValueEl = document.getElementById(b + '_cache_value') as HTMLInputElement | null;
		const cacheUnitEl = document.getElementById(b + '_cache_unit') as HTMLSelectElement | null;
		const cacheEnabled = !!(cacheEnabledEl?.checked);
		const cacheValue = parseInt(cacheValueEl?.value || '1', 10) || 1;
		const cacheUnit = cacheUnitEl?.value || 'days';

		let copilotChatVisible: boolean | undefined;
		let copilotChatWidthPx: number | undefined;
		try { const fn = window.__kustoGetCopilotChatVisible; if (typeof fn === 'function') copilotChatVisible = !!fn(b); } catch { /* ignore */ }
		try { const fn = window.__kustoGetCopilotChatWidthPx; if (typeof fn === 'function') { const w = fn(b); if (typeof w === 'number' && Number.isFinite(w)) copilotChatWidthPx = w; } } catch { /* ignore */ }

		const shouldPersist = !!(resultJson && !this._isLeaveNoTrace(clusterUrl));
		const editorHeightPx = this._getEditorHeightPx();
		const resultsHeightPx = this._getResultsHeightPx();

		return {
			id: b, type: 'query', name,
			...(typeof favoritesMode === 'boolean' ? { favoritesMode } : {}),
			clusterUrl, database, query, expanded, resultsVisible,
			...(shouldPersist ? { resultJson } : {}),
			runMode: String(runMode), cacheEnabled, cacheValue, cacheUnit,
			...(editorHeightPx !== undefined ? { editorHeightPx } : {}),
			...(resultsHeightPx !== undefined ? { resultsHeightPx } : {}),
			...(typeof copilotChatVisible === 'boolean' ? { copilotChatVisible } : {}),
			...(typeof copilotChatWidthPx === 'number' ? { copilotChatWidthPx } : {}),
		};
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	private _getEditorHeightPx(): number | undefined {
		try {
			// Check manual height map first (set by drag resize).
			const m = window.__kustoManualQueryEditorHeightPxByBoxId;
			const v = m?.[this.boxId];
			if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.round(v);
			// Measure from the DOM directly — find the editor wrapper and read its inline height.
			const editorEl = document.getElementById(this.boxId + '_query_editor');
			const wrapper = editorEl?.closest('.query-editor-wrapper') as HTMLElement | null;
			if (!wrapper) return undefined;
			// Only persist heights from explicit user resize, not auto-resize.
			if (wrapper.dataset?.kustoAutoResized === 'true') return undefined;
			const inlineH = wrapper.style.height?.trim();
			if (!inlineH || inlineH === 'auto') return undefined;
			const match = inlineH.match(/^(\d+)px$/i);
			if (!match) return undefined;
			return Math.max(0, parseInt(match[1], 10));
		} catch { /* ignore */ }
		return undefined;
	}

	private _getResultsHeightPx(): number | undefined {
		try {
			const wrapper = document.getElementById(this.boxId + '_results_wrapper') as HTMLElement | null;
			if (!wrapper) return undefined;
			if (!wrapper.dataset || wrapper.dataset.kustoUserResized !== 'true') return undefined;
			let inlineH = wrapper.style.height?.trim();
			// When results are hidden the wrapper is collapsed to 40px;
			// return the remembered pre-collapse height instead.
			const prevToggle = wrapper.dataset.kustoPreviousHeight?.trim();
			if (prevToggle && inlineH === '40px') inlineH = prevToggle;
			if (!inlineH || inlineH === 'auto') {
				const prev = wrapper.dataset.kustoPrevHeight?.trim();
				if (prev) inlineH = prev;
			}
			if (!inlineH || inlineH === 'auto') return undefined;
			const match = inlineH.match(/^(\d+)px$/i);
			if (!match) return undefined;
			return Math.max(0, parseInt(match[1], 10));
		} catch { /* ignore */ }
		return undefined;
	}

	private _isLeaveNoTrace(clusterUrl: string): boolean {
		try {
			if (!clusterUrl) return false;
			const list = window.leaveNoTraceClusters;
			if (!Array.isArray(list)) return false;
			const norm = this._normUrl(clusterUrl);
			if (!norm) return false;
			return list.some((u: string) => this._normUrl(String(u || '')) === norm);
		} catch { return false; }
	}

	private _normUrl(url: string): string {
		let u = String(url || '').trim();
		if (!u) return '';
		if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
		return u.replace(/\/+$/g, '').toLowerCase();
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-query-section': KwQuerySection;
	}
}
