import { pState } from '../shared/persistence-state';
import { postMessageToHost } from '../shared/webview-messages';
import { LitElement, html, type TemplateResult, render as litRender } from 'lit';
import { styles } from './kw-query-section.styles.js';
import { customElement, property, state } from 'lit/decorators.js';
import type { DataTableColumn, DataTableOptions } from '../components/kw-data-table.js';
import type { DropdownItem, DropdownAction } from '../components/kw-dropdown.js';
import type { KwCopilotChat } from '../components/kw-copilot-chat.js';
import type { KwSchemaInfo } from '../components/kw-schema-info.js';
import '../components/kw-schema-info.js';
import '../components/kw-dropdown.js';
import '../components/kw-section-shell.js';
import { CopilotChatManagerController } from './copilot-chat-manager.controller.js';
import { schedulePersist } from '../core/persistence.js';
import {
	removeQueryBox,
	__kustoMaximizeQueryBox,
	toggleQueryBoxVisibility,
	promptAddConnectionFromDropdown,
	importConnectionsFromXmlFile,
	__kustoRefreshAllDataSourceDropdowns,
} from '../core/section-factory.js';
import { __kustoOpenShareModal } from './kw-query-toolbar.js';
import { optimizeQueryWithCopilot, acceptOptimizations } from './query-execution.controller.js';
import { QueryConnectionController } from './query-connection.controller.js';
import { QueryExecutionController } from './query-execution.controller.js';

import { formatClusterDisplayName as _formatClusterDisplayName, formatClusterShortName as _formatClusterShortName } from '../shared/clusterUtils.js';

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

// Re-export SchemaInfoState from the extracted component
export type { SchemaInfoState } from '../components/kw-schema-info.js';
import type { SchemaInfoState } from '../components/kw-schema-info.js';

// ─── SVG Icons (matching legacy exactly) ──────────────────────────────────────

const clusterIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M5 3.5h6"/><path d="M4 6h8"/><path d="M3.5 8.5h9"/><path d="M4 11h8"/><path d="M5 13.5h6"/></svg>`;

const databaseIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4"/><path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/><path d="M3 12c0 1.1 2.2 2 5 2s5-.9 5-2"/></svg>`;

const refreshIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 8a4.5 4.5 0 0 1 7.8-3.1"/><polyline points="11.3 2.7 11.3 5.4 8.6 5.4"/><path d="M12.5 8a4.5 4.5 0 0 1-7.8 3.1"/><polyline points="4.7 13.3 4.7 10.6 7.4 10.6"/></svg>`;

const favoriteStarIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 1.4l2.1 4.2 4.6.7-3.4 3.3.8 4.6L8 12l-4.1 2.2.8-4.6L1.3 6.3l4.6-.7L8 1.4z" /></svg>`;

const favoritesListIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 1.4l2.1 4.2 4.6.7-3.4 3.3L8 12l-4.1 2.2.8-4.6L1.3 6.3l4.6-.7L8 1.4z" /><line x1="10" y1="10.5" x2="14.5" y2="10.5" stroke-width="1.4" stroke-linecap="round" /><line x1="10" y1="12.5" x2="14.5" y2="12.5" stroke-width="1.4" stroke-linecap="round" /><line x1="10" y1="14.5" x2="14.5" y2="14.5" stroke-width="1.4" stroke-linecap="round" /></svg>`;

const spinnerSvg = html`<span class="query-spinner" aria-hidden="true"></span>`;

const clusterPickerIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><ellipse cx="8" cy="4" rx="5" ry="2" /><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" /><path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" /></svg>`;

const shareIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 3a2 2 0 1 1-.001 4.001A2 2 0 0 1 12 3zm0 1a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/><path d="M4 6a2 2 0 1 1-.001 4.001A2 2 0 0 1 4 6zm0 1a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/><path d="M12 9a2 2 0 1 1-.001 4.001A2 2 0 0 1 12 9zm0 1a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/><path d="M5.5 7.5l5-2.5M5.5 8.5l5 2.5" stroke="currentColor" stroke-width="1" fill="none"/></svg>`;


// ── Light DOM SVG icons (for elements rendered into the host's light DOM) ─────

/** Compare queries icon: "A vs B" label */
const diffIconLightSvg = html`<span style="font-weight:600;font-size:11px;letter-spacing:0.5px;white-space:nowrap" aria-hidden="true">A vs B</span>`;

/** Down chevron for run-mode split dropdown */
const downChevronSvg = html`<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg>`;

/** Cancel/stop icon */
const cancelIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6" /><path d="M5.5 5.5l5 5" /><path d="M10.5 5.5l-5 5" /></svg>`;


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
	return _formatClusterShortName(clusterUrl);
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
	return _formatClusterDisplayName(conn);
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

	/** Whether this is an optimization comparison section. Set by addQueryBox. */
	@property({ type: Boolean, attribute: 'is-comparison' })
	isComparison = false;

	// ── Light DOM content guard ───────────────────────────────────────────────
	// The light DOM body (toolbar, editor, actions, results) is created ONCE in
	// connectedCallback via litRender. It must never be re-rendered because
	// external code (Monaco editor init, Copilot chat install, result rendering)
	// mutates these DOM nodes. The guard flag prevents re-creation on
	// disconnect/reconnect (e.g. section reorder).
	private _lightDomCreated = false;

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
	// ── Header row reactive state ─────────────────────────────────────────────

	@state() private _name = '';
	@state() private _expanded = true;

	// ── ReactiveControllers ──────────────────────────────────────────────────
	public connectionCtrl = new QueryConnectionController(this as any);
	public executionCtrl = new QueryExecutionController(this as any);
	public copilotChatCtrl = new CopilotChatManagerController(this as any);

	// ── Styles ────────────────────────────────────────────────────────────────

	static override styles = styles;

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	override connectedCallback(): void {
		super.connectedCallback();
		// Create the light DOM body once. See _lightDomCreated guard comment above.
		if (!this._lightDomCreated && this.boxId) {
			this._lightDomCreated = true;
			this._createLightDomContent();
		} else if (this._lightDomCreated) {
			// Reorder moves disconnect/reconnect the section node. Re-sync data-table
			// virtual scroll after reattach so body scroll metrics are current.
			this._refreshResultsTableLayoutSoon();
		}
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
	}

	// ── Light DOM content (created once — never re-rendered) ──────────────────

	/**
	 * Populate the host element's light DOM with the query section body:
	 * toolbar, editor clip, action bar, and results wrapper.
	 *
	 * Uses lit-html's `render()` so the template is a clean tagged-template
	 * with proper `@click` handlers instead of inline `onclick="..."` strings.
	 *
	 * **WARNING**: This must only be called ONCE per element. External code
	 * (Monaco, Copilot chat, result tables) mutates these DOM nodes after
	 * creation. A second `litRender` call would clobber those mutations.
	 */
	private _createLightDomContent(): void {
		const id = this.boxId;
		const isComp = this.isComparison;

		// Shorthand helpers for window global calls (conservative — avoids
		// exporting local functions from other modules).
		const callGlobal = (name: string, ...args: unknown[]) => {
			const fn = (window as any)[name];
			if (typeof fn === 'function') fn(...args);
		};

		litRender(html`
			<div class="query-editor-wrapper">
				<kw-query-toolbar box-id=${id}></kw-query-toolbar>
				<div class="qe-editor-clip">
					<div class="qe-caret-docs-banner" id="${id}_caret_docs" style="display:none;" role="status" aria-live="polite">
						<div class="qe-caret-docs-text" id="${id}_caret_docs_text"></div>
					</div>
					<div class="qe-missing-clusters-banner" id="${id}_missing_clusters" style="display:none;" role="status" aria-live="polite">
						<div class="qe-missing-clusters-text" id="${id}_missing_clusters_text"></div>
						<div class="qe-missing-clusters-actions">
							<button type="button" class="unified-btn-primary qe-missing-clusters-btn"
								@click=${() => callGlobal('addMissingClusterConnections', id)}>Add connections</button>
						</div>
					</div>
					<div class="query-editor" id="${id}_query_editor"></div>
					<div class="query-editor-placeholder" id="${id}_query_placeholder">Enter your KQL query here...</div>
				</div>
				<div class="query-editor-resizer" id="${id}_query_resizer" title=${'Drag to resize editor\nDouble-click to fit to contents'}></div>
			</div>
			<div class="query-actions">
				<div class="query-run">
					<div class="unified-btn-split" id="${id}_run_split">
						<button class="unified-btn-split-main" id="${id}_run_btn"
							@click=${() => callGlobal('executeQuery', id)}
							disabled
							title=${'Run Query (take 100)\nSelect a cluster and database first (or select a favorite)'}>▶<span class="run-btn-label"> Run Query (take 100)</span></button>
						<button class="unified-btn-split-toggle" id="${id}_run_toggle"
							@click=${(e: Event) => { callGlobal('toggleRunMenu', id); e.stopPropagation(); }}
							aria-label="Run query options" title="Run query options">${downChevronSvg}</button>
						<div class="unified-btn-split-menu" id="${id}_run_menu" role="menu">
							<div class="unified-btn-split-menu-item" role="menuitem"
								@click=${() => callGlobal('__kustoApplyRunModeFromMenu', id, 'plain')}>Run Query</div>
							<div class="unified-btn-split-menu-item" role="menuitem"
								@click=${() => callGlobal('__kustoApplyRunModeFromMenu', id, 'take100')}>Run Query (take 100)</div>
							<div class="unified-btn-split-menu-item" role="menuitem"
								@click=${() => callGlobal('__kustoApplyRunModeFromMenu', id, 'sample100')}>Run Query (sample 100)</div>
						</div>
					</div>
					${isComp ? html`
						<button class="accept-optimizations-btn" id="${id}_accept_btn"
							@click=${() => acceptOptimizations(id)}
							disabled
							title="Run both queries to compare results. This will be enabled when the optimized query has results."
							aria-label="Accept Optimizations">Accept Optimizations</button>
					` : html`
						<span class="optimize-inline" id="${id}_optimize_inline">
							<button class="optimize-query-btn" id="${id}_optimize_btn"
								@click=${() => optimizeQueryWithCopilot(id, null, { skipExecute: true })}
								title="Compare two queries (A vs B) to check if they return the same data and which one is faster to return results" aria-label="Compare two queries (A vs B)">
								${diffIconLightSvg}
							</button>
						</span>
					`}
					<span class="query-exec-status" id="${id}_exec_status" style="display: none;">
						<span class="query-spinner" aria-hidden="true"></span>
						<span id="${id}_exec_elapsed">0:00</span>
					</span>
					<button class="refresh-btn cancel-btn" id="${id}_cancel_btn"
						@click=${() => callGlobal('cancelQuery', id)}
						style="display: none;" title="Cancel running query" aria-label="Cancel running query">
						${cancelIconSvg}
					</button>
				</div>
				<div class="cache-controls">
					<span class="cache-label" id="${id}_cache_label"
						@click=${() => callGlobal('toggleCachePopup', id)}
						title="Cache the server-side query plan and execution and get the results back from the server instantly">Cache query plan</span>
					<input type="checkbox" id="${id}_cache_enabled" checked
						@change=${() => { callGlobal('toggleCachePill', id); try { schedulePersist(); } catch { /* ignore */ } }}
						class="cache-checkbox" title="Toggle query plan caching" />
					<div class="cache-popup" id="${id}_cache_popup">
						<div class="cache-popup-content">
							<span class="cache-popup-label">Cache query plan for</span>
							<div class="cache-popup-inputs">
								<input type="number" id="${id}_cache_value" value="1" min="1"
									@input=${() => { try { schedulePersist(); } catch { /* ignore */ } }} />
								<select id="${id}_cache_unit"
									@change=${() => { try { schedulePersist(); } catch { /* ignore */ } }}>
									<option value="minutes">Minutes</option>
									<option value="hours">Hours</option>
									<option value="days" selected>Days</option>
								</select>
							</div>
							<div class="cache-info">
								<p>Cache the server-side query plan and execution and get the results back from the server instantly.</p>
								<p>This does not control whether query results are saved in the local file (those are saved automatically).</p>
							</div>
						</div>
					</div>
				</div>
			</div>
			<div class="results-wrapper" id="${id}_results_wrapper" style="display: none;" data-kusto-no-editor-focus="true">
				<div class="results" id="${id}_results"></div>
			</div>
			<div class="query-editor-resizer" id="${id}_results_resizer" title=${'Drag to resize results\nDouble-click to fit to contents'} style="display: none;"></div>
		`, this);
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
					<kw-schema-info
						@schema-refresh=${this._onSchemaRefresh}
						@see-cached-values=${this._onSeeCachedValues}>
					</kw-schema-info>
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
				<kw-schema-info
					@schema-refresh=${this._onSchemaRefresh}
					@see-cached-values=${this._onSeeCachedValues}>
				</kw-schema-info>
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

	// ── Event handlers ────────────────────────────────────────────────────────

	// ── Header row events ─────────────────────────────────────────────────────

	private _onShellNameChange(e: CustomEvent<{ name: string }>): void {
		this._name = e.detail.name;
		try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		try { __kustoRefreshAllDataSourceDropdowns(); } catch (e) { console.error('[kusto]', e); }
	}

	private _onShareClick(): void {
		try { __kustoOpenShareModal(this.boxId); } catch (e) { console.error('[kusto]', e); }
	}

	private _onMaximizeClick(): void {
		try { __kustoMaximizeQueryBox(this.boxId); } catch (e) { console.error('[kusto]', e); }
	}

	private _onToggleClick(): void {
		try { toggleQueryBoxVisibility(this.boxId); } catch (e) { console.error('[kusto]', e); }
	}

	private _onShellRemove(e: Event): void {
		// Stop propagation so the composed event doesn't bubble further —
		// query sections use a legacy window function for removal.
		e.stopPropagation();
		try { removeQueryBox(this.boxId); } catch (e) { console.error('[kusto]', e); }
	}



	// ── Dropdown events ───────────────────────────────────────────────────────

	/** Close all <kw-dropdown> instances in this section + schema popover. */
	private _closeAllPopups(): void {
		this._getSchemaInfoEl()?.close();
		const dropdowns = this.shadowRoot?.querySelectorAll('kw-dropdown');
		dropdowns?.forEach(dd => (dd as any).close());
	}

	/** When any <kw-dropdown> opens, close others + schema popover. */
	private _onDropdownOpened(e: Event): void {
		// Close schema popover
		this._getSchemaInfoEl()?.close();
		// Close all OTHER dropdowns (the one that just opened handles itself)
		const source = e.target;
		const dropdowns = this.shadowRoot?.querySelectorAll('kw-dropdown');
		dropdowns?.forEach(dd => {
			if (dd !== source) (dd as any).close();
		});
	}

	private _onClusterAction(e: CustomEvent): void {
		const action = e.detail?.id;
		if (action === '__enter_new__') {
			try { promptAddConnectionFromDropdown(this.boxId); } catch (e) { console.error('[kusto]', e); }
		} else if (action === '__import_xml__') {
			try { importConnectionsFromXmlFile(this.boxId); } catch (e) { console.error('[kusto]', e); }
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
		try { window.vscode?.postMessage({ type: 'seeCachedValues' }); } catch (e) { console.error('[kusto]', e); }
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

	/** Update schema info display (delegates to <kw-schema-info> child). */
	public setSchemaInfo(info: Partial<SchemaInfoState>): void {
		this._getSchemaInfoEl()?.setInfo(info);
	}

	/** Get the <kw-schema-info> child element. */
	private _getSchemaInfoEl(): KwSchemaInfo | null {
		return this.shadowRoot?.querySelector('kw-schema-info') ?? null;
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

		// Remove stale overlay — fresh results are arriving.
		try { resultsDiv.classList.remove('is-stale'); } catch (e) { console.error('[kusto]', e); }
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
			const m = pState.resultsVisibleByBoxId;
			if (m && m[this.boxId] === false) initialBodyVisible = false;
		} catch (e) { console.error('[kusto]', e); }
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
			} catch (e) { console.error('[kusto]', e); }
		});

		// Handle visibility toggle: shrink/expand the wrapper directly.
		// Do NOT delegate to legacy toggleQueryResultsVisibility — it looks for
		// .table-container and _results_body which don't exist with <kw-data-table>.
		dt.addEventListener('visibility-toggle', (e: CustomEvent) => {
			const visible = e.detail?.visible ?? true;
			// Update the global map so serialize() picks up the correct value.
			try {
				if (!pState.resultsVisibleByBoxId || typeof pState.resultsVisibleByBoxId !== 'object') {
					pState.resultsVisibleByBoxId = {};
				}
				pState.resultsVisibleByBoxId[this.boxId] = !!visible;
			} catch (e) { console.error('[kusto]', e); }
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
			try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		});

		// Adjust wrapper height when data-table chrome (search bar, row-jump, etc.) toggles.
		// Apply the delta so the visible data area stays the same size.
		dt.addEventListener('chrome-height-change', (e: Event) => {
			if (!resultsWrapper) return;
			const curH = parseInt(resultsWrapper.style.height, 10);
			// Skip if collapsed or hidden.
			if (!curH || curH <= 40) return;
			const delta = (e as CustomEvent).detail?.delta ?? 0;
			if (delta === 0) return;
			resultsWrapper.style.height = Math.max(120, Math.min(900, curH + delta)) + 'px';
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
				// Extra height for the "No matching rows" placeholder shown when
				// there are columns (schema) but 0 data rows.
				const EMPTY_MSG_H = (rows.length === 0 && columns.length > 0) ? 50 : 0;
				const MAX_AUTO_ROWS = 10;
				const MAX_AUTO_H = CHROME + (MAX_AUTO_ROWS * ROW_H);
				const estimatedH = CHROME + (rows.length * ROW_H) + EMPTY_MSG_H;
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
					const resizerH = resizer ? resizer.getBoundingClientRect().height : 1;
					const wrapperBorder = 1; // border-top on .results-wrapper
					const desiredH = contentH + resizerH + wrapperBorder;
					resultsWrapper.style.height = Math.max(120, Math.min(REFINE_MAX_H, desiredH)) + 'px';
				}
			});
		});
	}

	// ── Error display ─────────────────────────────────────────────────────────

	/**
	 * Display an error in the results area.
	 * Called from `__kustoRenderErrorUx()` in core/error-renderer.ts when the section
	 * element has this method, or directly from main.ts message handlers.
	 *
	 * @param errorOrModel - Either a pre-built ErrorUxModel (from __kustoBuildErrorUxModel)
	 *   or a raw error string/object that will be displayed as-is.
	 * @param clientActivityId - Optional Kusto client activity ID.
	 */
	public displayError(
		errorOrModel: unknown,
		clientActivityId?: string
	): void {
		const resultsDiv = document.getElementById(this.boxId + '_results');
		const resultsWrapper = document.getElementById(this.boxId + '_results_wrapper');
		const resizer = document.getElementById(this.boxId + '_results_resizer');
		if (!resultsDiv) return;

		// Remove stale overlay.
		try { resultsDiv.classList.remove('is-stale'); } catch (e) { console.error('[kusto]', e); }
		resultsDiv.innerHTML = '';

		// Determine if we received a pre-built model or a raw error.
		const model = (errorOrModel && typeof errorOrModel === 'object' && 'kind' in (errorOrModel as any))
			? errorOrModel as { kind: string; message?: string; pretty?: string; text?: string; location?: { line: number; col: number } | null; autoFindTerm?: string | null }
			: null;

		const container = document.createElement('div');
		container.className = 'results-header kusto-error-ux';
		container.style.color = 'var(--vscode-errorForeground)';

		if (model) {
			if (model.kind === 'none') {
				resultsDiv.classList.remove('visible');
				return;
			}
			if (model.kind === 'badrequest') {
				const msgEl = document.createElement('div');
				const strong = document.createElement('strong');
				strong.textContent = model.message || '';
				msgEl.appendChild(strong);
				if (model.location && model.location.line && model.location.col) {
					const link = document.createElement('a');
					link.href = '#';
					link.className = 'kusto-error-location';
					link.dataset.boxid = this.boxId;
					link.dataset.line = String(model.location.line);
					link.dataset.col = String(model.location.col);
					link.title = `Go to line ${model.location.line}, column ${model.location.col}`;
					link.textContent = ` Line ${model.location.line}, Col ${model.location.col}`;
					msgEl.appendChild(document.createTextNode(' '));
					msgEl.appendChild(link);
				}
				container.appendChild(msgEl);
			} else if (model.kind === 'json') {
				const pre = document.createElement('pre');
				pre.style.cssText = 'margin:0; white-space:pre-wrap; word-break:break-word; font-family: var(--vscode-editor-font-family);';
				pre.textContent = model.pretty || '';
				container.appendChild(pre);
			} else {
				// text
				const lines = String(model.text || '').split(/\r?\n/);
				lines.forEach((line, i) => {
					if (i > 0) container.appendChild(document.createElement('br'));
					container.appendChild(document.createTextNode(line));
				});
			}
		} else {
			// Raw error string — display as-is.
			const raw = (errorOrModel === null || errorOrModel === undefined) ? '' : String(errorOrModel);
			const lines = raw.split(/\r?\n/);
			const strong = document.createElement('strong');
			lines.forEach((line, i) => {
				if (i > 0) strong.appendChild(document.createElement('br'));
				strong.appendChild(document.createTextNode(line));
			});
			container.appendChild(strong);
		}

		// Append client activity ID if present.
		if (clientActivityId && typeof clientActivityId === 'string') {
			const actDiv = document.createElement('div');
			actDiv.className = 'kusto-error-activity-id';
			const label = document.createElement('span');
			label.className = 'kusto-error-activity-id-label';
			label.textContent = 'Client Activity ID:';
			actDiv.appendChild(label);
			actDiv.appendChild(document.createTextNode(' '));
			const value = document.createElement('span');
			value.className = 'kusto-error-activity-id-value';
			value.textContent = clientActivityId;
			actDiv.appendChild(value);
			const copyBtn = document.createElement('button');
			copyBtn.className = 'results-label-tooltip-copy';
			copyBtn.type = 'button';
			copyBtn.title = 'Copy to clipboard';
			copyBtn.setAttribute('aria-label', 'Copy Client Activity ID');
			copyBtn.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="2" ry="2"/><path d="M3 11V4a2 2 0 0 1 2-2h7"/></svg>';
			copyBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				try {
					navigator.clipboard.writeText(clientActivityId).then(() => {
						copyBtn.classList.add('results-footer-copy-done');
						setTimeout(() => copyBtn.classList.remove('results-footer-copy-done'), 1200);
					}).catch(() => { /* ignore */ });
				} catch (e) { console.error('[kusto]', e); }
			});
			actDiv.appendChild(copyBtn);
			container.appendChild(actDiv);
		}

		resultsDiv.appendChild(container);
		resultsDiv.classList.add('visible');
		if (resultsWrapper) {
			resultsWrapper.style.display = 'block';
			// Auto-fit: error/cancellation messages are short — clear any
			// previous data-table height so the wrapper shrinks to content.
			resultsWrapper.style.height = '';
			resultsWrapper.style.overflow = '';
			delete resultsWrapper.dataset.kustoUserResized;
			delete resultsWrapper.dataset.kustoPreviousHeight;
		}
		// No data table to resize — hide the grip.
		if (resizer) resizer.style.display = 'none';

		// Auto-find term in query editor for SEM0139 errors.
		const autoFind = model?.autoFindTerm;
		if (autoFind && typeof window.__kustoAutoFindInQueryEditor === 'function') {
			setTimeout(() => {
				try { window.__kustoAutoFindInQueryEditor(this.boxId, String(autoFind)); } catch (e) { console.error('[kusto]', e); }
			}, 0);
		}
	}

	/**
	 * Display a cancellation message in the results area.
	 */
	public displayCancelled(): void {
		this.displayError('Cancelled.');
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
		try { const m = pState.resultsVisibleByBoxId; resultsVisible = !(m && m[b] === false); } catch (e) { console.error('[kusto]', e); }

		const clusterUrl = this.getClusterUrl();

		let query = '';
		try {
			const qe = window.queryEditors;
			if (qe && qe[b] && typeof qe[b].getValue === 'function') {
				query = qe[b].getValue() || '';
			}
		} catch (e) { console.error('[kusto]', e); }
		if (!query) { try { query = pState.pendingQueryTextByBoxId?.[b] || ''; } catch (e) { console.error('[kusto]', e); } }

		let resultJson = '';
		try { resultJson = String(pState.queryResultJsonByBoxId?.[b] || ''); } catch (e) { console.error('[kusto]', e); }

		const runMode = (window.runModesByBoxId?.[b]) || 'take100';

		const cacheEnabledEl = document.getElementById(b + '_cache_enabled') as HTMLInputElement | null;
		const cacheValueEl = document.getElementById(b + '_cache_value') as HTMLInputElement | null;
		const cacheUnitEl = document.getElementById(b + '_cache_unit') as HTMLSelectElement | null;
		const cacheEnabled = !!(cacheEnabledEl?.checked);
		const cacheValue = parseInt(cacheValueEl?.value || '1', 10) || 1;
		const cacheUnit = cacheUnitEl?.value || 'days';

		let copilotChatWidthPx: number | undefined;
		try { const w = this.copilotChatCtrl.getCopilotChatWidthPx(); if (typeof w === 'number' && Number.isFinite(w)) copilotChatWidthPx = w; } catch (e) { console.error('[kusto]', e); }

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
			...(typeof copilotChatWidthPx === 'number' ? { copilotChatWidthPx } : {}),
		};
	}

	// ── Copilot Chat forwarding (delegates to CopilotChatManagerController) ───

	public getCopilotChatEl(): KwCopilotChat | null { return this.copilotChatCtrl.getCopilotChatEl(); }
	public getCopilotChatVisible(): boolean { return this.copilotChatCtrl.getCopilotChatVisible(); }
	public getCopilotChatWidthPx(): number | undefined { return this.copilotChatCtrl.getCopilotChatWidthPx(); }
	public setCopilotChatWidthPx(widthPx: number): void { this.copilotChatCtrl.setCopilotChatWidthPx(widthPx); }
	public setCopilotChatVisible(visible: boolean): void { this.copilotChatCtrl.setCopilotChatVisible(visible); }
	public toggleCopilotChat(): void { this.copilotChatCtrl.toggleCopilotChat(); }
	public disposeCopilotChat(): void { this.copilotChatCtrl.disposeCopilotChat(); }
	public installCopilotChat(): void { this.copilotChatCtrl.installCopilotChat(); }
	public copilotApplyWriteQueryOptions(models: any, selectedModelId: string, tools: any): void { this.copilotChatCtrl.copilotApplyWriteQueryOptions(models, selectedModelId, tools); }
	public copilotWriteQueryStatus(text: string, detail: string, role: string): void { this.copilotChatCtrl.copilotWriteQueryStatus(text, detail, role); }
	public copilotWriteQuerySetQuery(queryText: string): void { this.copilotChatCtrl.copilotWriteQuerySetQuery(queryText); }
	public copilotWriteQueryDone(ok: boolean, message: string): void { this.copilotChatCtrl.copilotWriteQueryDone(ok, message); }
	public copilotWriteQueryToolResult(toolName: string, label: string, jsonText: string, entryId: string): void { this.copilotChatCtrl.copilotWriteQueryToolResult(toolName, label, jsonText, entryId); }
	public copilotAppendExecutedQuery(query: string, resultSummary: string, errorMessage: string, entryId: string, result: unknown): void { this.copilotChatCtrl.copilotAppendExecutedQuery(query, resultSummary, errorMessage, entryId, result); }
	public copilotAppendGeneralRulesLink(filePath: string, preview: string, entryId: string): void { this.copilotChatCtrl.copilotAppendGeneralRulesLink(filePath, preview, entryId); }
	public copilotAppendClarifyingQuestion(question: string, entryId: string): void { this.copilotChatCtrl.copilotAppendClarifyingQuestion(question, entryId); }
	public copilotAppendQuerySnapshot(queryText: string, entryId: string): void { this.copilotChatCtrl.copilotAppendQuerySnapshot(queryText, entryId); }
	public copilotAppendDevNotesContext(preview: string, entryId: string): void { this.copilotChatCtrl.copilotAppendDevNotesContext(preview, entryId); }
	public copilotAppendDevNoteToolCall(action: string, detail: string, result: string, entryId: string): void { this.copilotChatCtrl.copilotAppendDevNoteToolCall(action, detail, result, entryId); }
	public copilotClearConversation(): void { this.copilotChatCtrl.copilotClearConversation(); }
	public copilotWriteQuerySend(): void { this.copilotChatCtrl.copilotWriteQuerySend(); }
	public copilotWriteQueryCancel(): void { this.copilotChatCtrl.copilotWriteQueryCancel(); }

	// ── Helpers ───────────────────────────────────────────────────────────────

	private _getEditorHeightPx(): number | undefined {
		try {
			// Check manual height map first (set by drag resize).
			const m = pState.manualQueryEditorHeightPxByBoxId;
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
		} catch (e) { console.error('[kusto]', e); }
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
		} catch (e) { console.error('[kusto]', e); }
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

	private _refreshResultsTableLayoutSoon(): void {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				try {
					const table = document.getElementById(this.boxId + '_results')?.querySelector('kw-data-table') as any;
					if (table && typeof table.refreshLayout === 'function') {
						table.refreshLayout();
					}
				} catch (e) { console.error('[kusto]', e); }
			});
		});
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-query-section': KwQuerySection;
	}
}
