import { pState } from '../shared/persistence-state';
import type { SectionElement } from '../shared/dom-helpers';
import { postMessageToHost } from '../shared/webview-messages';
import { LitElement, html, nothing, type PropertyValues, type TemplateResult, render as litRender } from 'lit';
import { styles } from './kw-sql-section.styles.js';
import { sectionGlowStyles } from '../shared/section-glow.styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';
import { osStyles } from '../shared/os-styles.js';
import { customElement, property, state } from 'lit/decorators.js';
import type { DropdownItem, DropdownAction } from '../components/kw-dropdown.js';
import type { KwSchemaInfo } from '../components/kw-schema-info.js';
import type { SchemaInfoState } from '../components/kw-schema-info.js';
import type { DataTableColumn, DataTableOptions } from '../components/kw-data-table.js';
import '../components/kw-dropdown.js';
import '../components/kw-schema-info.js';
import '../components/kw-section-shell.js';
import '../components/kw-data-table.js';
import './kw-sql-toolbar.js';
import { maybeAutoScrollWhileDragging } from '../core/utils.js';
import { registerPageScrollDismissable } from '../core/page-scroll-dismiss.js';
import { schedulePersist } from '../core/persistence.js';
import { __kustoForceEditorWritable, __kustoEnsureEditorWritableSoon, __kustoInstallWritableGuard } from '../monaco/writable.js';
import { registerStsProviders, registerStsEditorModel, unregisterStsEditorModel, setStsReady } from '../monaco/sql-sts-providers.js';
import { setActiveMonacoEditor, queryEditorBoxByModelUri, queryEditors } from '../core/state.js';
import { autoTriggerAutocompleteEnabled } from '../core/state.js';
import { getRunMode, setRunMode } from './kw-query-toolbar.js';
import { getRunModeLabelText } from '../shared/comparisonUtils.js';
import { getCurrentMonacoThemeName } from '../monaco/theme.js';
import { prettifySql } from '../monaco/sql-prettify.js';
import { CopilotChatManagerController } from './copilot-chat-manager.controller.js';
import { sqlWebviewFlavor } from './copilot-chat-flavor.js';
import type { SqlConnectionFormSubmitDetail } from '../components/kw-sql-connection-form.js';
import '../components/kw-sql-connection-form.js';
import { ICONS, iconRegistryStyles } from '../shared/icon-registry.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Serialized shape for .kqlx persistence — must match KqlxSectionV1 sql variant. */
export interface SqlSectionData {
	id: string;
	type: 'sql';
	name: string;
	query: string;
	serverUrl?: string;
	database?: string;
	expanded: boolean;
	resultsVisible?: boolean;
	favoritesMode?: boolean;
	resultJson?: string;
	runMode?: string;
	editorHeightPx?: number;
	resultsHeightPx?: number;
	copilotChatVisible?: boolean;
	copilotChatWidthPx?: number;
}

// Monaco editor instance type (subset of monaco.editor.IStandaloneCodeEditor).
interface MonacoEditor {
	getValue(): string;
	setValue(value: string): void;
	getModel(): { getValue(): string; getFullModelRange?(): unknown; setValue?(value: string): void; uri?: { toString(): string }; getLineContent?(lineNumber: number): string } | null;
	getContentHeight(): number;
	getDomNode(): HTMLElement | null;
	layout(dimension?: { width: number; height: number }): void;
	dispose(): void;
	focus(): void;
	trigger(source: string, handlerId: string, payload: unknown): void;
	onDidFocusEditorText(cb: () => void): { dispose(): void };
	onDidFocusEditorWidget(cb: () => void): { dispose(): void };
	onDidChangeModelContent(cb: (e: { changes: Array<{ text: string; range: unknown }> }) => void): { dispose(): void };
	onDidContentSizeChange(cb: () => void): { dispose(): void };
	updateOptions(opts: Record<string, unknown>): void;
	addCommand(keybinding: number, handler: () => void): void;
	pushUndoStop?(): void;
	executeEdits?(source: string, edits: Array<{ range: unknown; text: string }>): void;
	hasTextFocus?(): boolean;
	getPosition?(): { lineNumber: number; column: number } | null;
}

/** SQL connection object matching the shape from SqlConnectionManager. */
export interface SqlConnectionInfo {
	id: string;
	name: string;
	dialect: string;
	serverUrl: string;
	port?: number;
	database?: string;
	authType: string;
	username?: string;
}

// ─── SVG Icons ────────────────────────────────────────────────────────────────

const shareIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 3a2 2 0 1 1-.001 4.001A2 2 0 0 1 12 3zm0 1a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/><path d="M4 6a2 2 0 1 1-.001 4.001A2 2 0 0 1 4 6zm0 1a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/><path d="M12 9a2 2 0 1 1-.001 4.001A2 2 0 0 1 12 9zm0 1a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/><path d="M5.5 7.5l5-2.5M5.5 8.5l5 2.5" stroke="currentColor" stroke-width="1" fill="none"/></svg>`;

const serverIconSvg = ICONS.sqlServer;

const databaseIconSvg = ICONS.database;

const refreshIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 8a4.5 4.5 0 0 1 7.8-3.1"/><polyline points="11.3 2.7 11.3 5.4 8.6 5.4"/><path d="M12.5 8a4.5 4.5 0 0 1-7.8 3.1"/><polyline points="4.7 13.3 4.7 10.6 7.4 10.6"/></svg>`;

const spinnerSvg = html`<span class="query-spinner" aria-hidden="true"></span>`;

// ─── Favorite types & icons ──────────────────────────────────────────────────

type SqlFavoriteInfo = { name: string; connectionId: string; database: string };

const favoriteStarIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 1.4l2.1 4.2 4.6.7-3.4 3.3.8 4.6L8 12l-4.1 2.2.8-4.6L1.3 6.3l4.6-.7L8 1.4z" /></svg>`;

const favoritesListIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 1.4l2.1 4.2 4.6.7-3.4 3.3.8 4.6L8 12l-4.1 2.2.8-4.6L1.3 6.3l4.6-.7L8 1.4z" /><line x1="10" y1="10.5" x2="14.5" y2="10.5" stroke-width="1.4" stroke-linecap="round" /><line x1="10" y1="12.5" x2="14.5" y2="12.5" stroke-width="1.4" stroke-linecap="round" /><line x1="10" y1="14.5" x2="14.5" y2="14.5" stroke-width="1.4" stroke-linecap="round" /></svg>`;

const serverPickerIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="2" y="2" width="12" height="4" rx="1" /><rect x="2" y="10" width="12" height="4" rx="1" /><circle cx="5" cy="4" r="0.8" fill="currentColor" stroke="none" /><circle cx="5" cy="12" r="0.8" fill="currentColor" stroke="none" /><line x1="8" y1="6" x2="8" y2="10" /></svg>`;

function formatSqlFavoriteDisplay(fav: SqlFavoriteInfo, connections?: SqlConnectionInfo[]): { primary: string; suffix: string } {
	const name = String(fav.name || '').trim();
	const connId = String(fav.connectionId || '').trim();
	const db = String(fav.database || '').trim();
	// Resolve connectionId → server display name via the connections list.
	const conn = connections?.find(c => c.id === connId);
	const serverLabel = conn ? (conn.name || conn.serverUrl || connId) : connId;
	const serverDb = (serverLabel && db) ? `${serverLabel}.${db}` : (serverLabel || db);
	const primary = name || serverDb;
	const showSuffix = !!(name && serverDb && name !== serverDb);
	return { primary, suffix: showSuffix ? `(${serverDb})` : '' };
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<kw-sql-section>` — Lit web component for a SQL section.
 *
 * **Hybrid light/shadow DOM** (same pattern as `kw-query-section`):
 * Shadow DOM: section shell header + connection row + missing-connections banner.
 * Light DOM: toolbar, Monaco editor, action bar, results — created once in
 * `connectedCallback` via `litRender(template, this)` and projected through
 * `<slot></slot>`. This avoids Monaco shadow DOM rendering incompatibilities.
 */
@customElement('kw-sql-section')
export class KwSqlSection extends LitElement implements SectionElement {

	static override styles = [...osStyles, scrollbarSheet, iconRegistryStyles, styles, sectionGlowStyles];

	// ── Public properties ─────────────────────────────────────────────────────

	@property({ type: String, reflect: true, attribute: 'box-id' })
	boxId = '';

	@property({ type: String, attribute: 'initial-query' })
	initialQuery = '';

	@property({ type: Number, attribute: 'editor-height-px' })
	editorHeightPx: number | undefined = undefined;

	// ── Internal state ────────────────────────────────────────────────────────

	@state() private _name = '';
	@state() private _expanded = true;
	@state() private _executing = false;
	@state() private _lastError = '';

	private _editorResizeObserver: ResizeObserver | null = null;

	// ── Connection row state ──────────────────────────────────────────────────

	@state() private _connections: SqlConnectionInfo[] = [];
	@state() private _connectionId = '';
	@state() private _desiredServerUrl = '';
	@state() private _databases: string[] = [];
	@state() private _database = '';
	@state() private _desiredDatabase = '';
	@state() private _databasesLoading = false;
	@state() private _refreshLoading = false;
	@state() private _hasResults = false;
	@state() private _showAddSqlModal = false;
	@state() private _elapsedText = '';

	// ── Favorites state ───────────────────────────────────────────────────────

	@state() private _favoritesMode = false;
	@state() private _favorites: SqlFavoriteInfo[] = [];

	/** SQL connection ID from SqlConnectionManager. */
	private _sqlConnectionId = '';
	private _elapsedTimer: ReturnType<typeof setInterval> | null = null;
	private _elapsedStart = 0;

	/** Copilot chat controller. */
	readonly copilotCtrl = new CopilotChatManagerController(this as any, sqlWebviewFlavor);

	private _editor: MonacoEditor | null = null;
	private _initRetryCount = 0;
	private _monacoRetryCount = 0;
	private _userResizedEditor = false;
	private _savedQuery: string | null = null;
	private _lastFitHeight = 0;
	private _savedEditorHeightPx: number | undefined;
	private _schemaInfoState: SchemaInfoState = { status: 'not-loaded' };
	private _stsReady = false;
	private _stsDocumentOpened = false;
	private _removeRunMenuScrollDismiss: (() => void) | null = null;

	// ── Auto-trigger autocomplete state ──────────────────────────────────────
	private _autoSuggestTimer: ReturnType<typeof setTimeout> | undefined;
	private _lastSuggestTriggerAt = 0;

	// ── Light DOM content guard ───────────────────────────────────────────────
	// The light DOM body (toolbar, editor, actions, results) is created ONCE in
	// connectedCallback via litRender. It must never be re-rendered because
	// external code (Monaco editor init, Copilot chat install, result rendering)
	// mutates these DOM nodes. The guard flag prevents re-creation on
	// disconnect/reconnect (e.g. section reorder).
	private _lightDomCreated = false;

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
		if (this._savedQuery !== null) {
			this.updateComplete.then(() => this._initEditor());
		}
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this._closeSqlRunMenu();
		this._stopElapsedTimer();
		if (this._autoSuggestTimer !== undefined) { clearTimeout(this._autoSuggestTimer); this._autoSuggestTimer = undefined; }
		if (this._editor) {
			try {
				const model = this._editor.getModel();
				if (model) {
					this._savedQuery = model.getValue();
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		this._disposeEditor();
	}

	override firstUpdated(_changedProperties: PropertyValues): void {
		super.firstUpdated(_changedProperties);

		// Restore persisted height BEFORE _initEditor so the height-apply
		// branch inside _initEditor sees the saved values.
		if (this.editorHeightPx !== undefined) {
			this._savedEditorHeightPx = this.editorHeightPx;
			this._userResizedEditor = true;
		}

		this._initEditor();
	}

	// ── Render ────────────────────────────────────────────────────────────────

	override render() {
		return html`
			<div class="section-root" @dropdown-opened=${this._onDropdownOpened}>
			<kw-section-shell
				.name=${this._name}
				.expanded=${this._expanded}
				box-id=${this.boxId}
				section-type="sql"
				name-placeholder="SQL section name (optional)"
				@name-change=${this._onShellNameChange}
				@toggle-visibility=${this._toggleVisibility}
				@fit-to-contents=${this._onShellFitToContents}>
				<button slot="header-buttons" class="header-share-btn" type="button"
					title="Share" aria-label="Share"
					@click=${this._onShareClick}>${shareIconSvg}</button>
				<div slot="header-extra">
					${this._renderConnectionRow()}
				</div>
			</kw-section-shell>
			${this._expanded ? html`
				${this._renderMissingConnectionsBanner()}
			` : nothing}
			</div>
			<slot></slot>
			${this._showAddSqlModal ? this._renderAddSqlConnectionModal() : nothing}
		`;
	}

	// ── Light DOM content (created once — never re-rendered) ──────────────────

	/**
	 * Populate the host element's light DOM with the SQL section body:
	 * toolbar, editor wrapper (+ copilot split), action bar, and results.
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

		litRender(html`
			<div class="query-editor-wrapper" id="${id}_sql_editor_wrapper">
				<kw-sql-toolbar
					id="${id}_sql_toolbar"
					box-id="${id}"
					@sql-editor-action=${this._onEditorAction}
					@sql-copilot-toggle=${this._onCopilotToggle}
				></kw-sql-toolbar>
				<div class="sql-copilot-editor-pane">
					<div class="qe-editor-clip">
						<div class="query-editor" id="${id}_sql_editor"></div>
						<div class="query-editor-placeholder sql-editor-placeholder" id="${id}_sql_placeholder">Write a T-SQL query...</div>
					</div>
				</div>
			</div>
			<div class="resizer query-editor-resizer" id="${id}_sql_editor_resizer"
				title=${'Drag to resize\nDouble-click to fit to contents'}
				@mousedown=${this._onEditorResizerMouseDown}
				@dblclick=${this._fitToContents}></div>
			<div class="query-actions" id="${id}_sql_actions">
				<div class="query-run">
					<div class="unified-btn-split" id="${id}_sql_run_split">
						<button class="unified-btn-split-main sql-run-btn" id="${id}_sql_run_btn"
							@click=${this._runQuery}
							disabled
							title=${'Run Query (TOP 100)\nSelect a server and database first (or select a favorite)'}>▶<span class="run-btn-label"> Run Query (TOP 100)</span></button>
						<button class="unified-btn-split-toggle" id="${id}_sql_run_toggle"
							@click=${(e: Event) => { this._toggleSqlRunMenu(); e.stopPropagation(); }}
							aria-label="Run query options" title="Run query options">
							<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg>
						</button>
						<div class="unified-btn-split-menu" id="${id}_sql_run_menu" role="menu">
							<div class="unified-btn-split-menu-item" role="menuitem"
								@click=${() => this._applySqlRunMode('plain')}>Run Query</div>
							<div class="unified-btn-split-menu-item" role="menuitem"
								@click=${() => this._applySqlRunMode('top100')}>Run Query (TOP 100)</div>
						</div>
					</div>
					<span class="query-exec-status" id="${id}_sql_exec_status" style="display: none;">
						<span class="query-spinner" aria-hidden="true"></span>
						<span id="${id}_sql_elapsed">0:00</span>
					</span>
					<button class="refresh-btn cancel-btn" id="${id}_sql_cancel_btn"
						style="display: none;"
						@click=${this._cancelQuery}
						title="Cancel running query" aria-label="Cancel running query">
						<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6" /><path d="M5.5 5.5l5 5" /><path d="M10.5 5.5l-5 5" /></svg>
					</button>
				</div>
				<span class="sql-error-label" id="${id}_sql_error_label" style="display: none;"></span>
			</div>
			<div class="results-wrapper" id="${id}_sql_results_wrapper" style="display: none;">
				<div class="sql-results-body" id="${id}_sql_results_body"></div>
			</div>
			<div class="resizer query-editor-resizer" id="${id}_sql_results_resizer" style="display: none;"
				title=${'Drag to resize results\nDouble-click to fit'}
				@mousedown=${this._onResultsResizerMouseDown}
				@dblclick=${this._forceFitResultsToContents}></div>
		`, this, { host: this });
	}

	// ── Share ─────────────────────────────────────────────────────────────────

	private _onShareClick(): void {
		try {
			const modal = document.getElementById('shareModal') as any;
			if (modal) {
				modal.dataset.boxId = this.boxId;
				modal.style.display = 'flex';
			}
		} catch (e) { console.error('[kusto]', e); }
	}

	// ── Missing connections banner ────────────────────────────────────────────

	private _renderMissingConnectionsBanner(): TemplateResult | typeof nothing {
		if (this._connections.length > 0) return nothing;
		return html`
			<div class="sql-missing-connections-banner" role="status" aria-live="polite">
				<span class="sql-missing-connections-text">No SQL connections configured.</span>
				<button type="button" class="sql-missing-connections-btn" data-testid="sql-add-connection"
					@click=${this._onAddConnectionFromBanner}>Add connection</button>
			</div>
		`;
	}

	private _onAddConnectionFromBanner(): void {
		this._showAddSqlModal = true;
	}

	// ── Toolbar ───────────────────────────────────────────────────────────────

	private _onEditorAction(e: CustomEvent): void {
		const action = e.detail?.action;
		if (!this._editor || !action) return;
		switch (action) {
			case 'undo':
				this._editor.trigger('toolbar', 'undo', null);
				break;
			case 'redo':
				this._editor.trigger('toolbar', 'redo', null);
				break;
			case 'toggleComment':
				this._editor.trigger('toolbar', 'editor.action.commentLine', null);
				break;
			case 'search':
				this._editor.trigger('toolbar', 'actions.find', null);
				break;
			case 'replace':
				this._editor.trigger('toolbar', 'editor.action.startFindReplaceAction', null);
				break;
			case 'prettify': {
				const model = this._editor.getModel?.();
				if (!model) break;
				const current = model.getValue();
				const formatted = prettifySql(current);
				if (formatted === current) break;
				try { this._editor.pushUndoStop?.(); } catch { /* ignore */ }
				const fullRange = model.getFullModelRange?.();
				if (fullRange && this._editor.executeEdits) {
					this._editor.executeEdits('sql-prettify', [{ range: fullRange, text: formatted }]);
				} else if (model.setValue) {
					model.setValue(formatted);
				} else {
					this._editor.setValue(formatted);
				}
				try { this._editor.pushUndoStop?.(); } catch { /* ignore */ }
				break;
			}
		}
		// Return focus to the editor after toolbar actions — but not for search/replace
		// which open the find widget (calling focus() would immediately steal focus back).
		if (action !== 'search' && action !== 'replace') {
			try { this._editor.focus(); } catch { /* ignore */ }
		}
	}

	private _onCopilotToggle(): void {
		this.copilotCtrl.toggleCopilotChat();
	}

	// ── Action bar ────────────────────────────────────────────────────────────

	/**
	 * Imperatively sync action bar state in light DOM.
	 * Called from `updated()` whenever reactive state changes.
	 */
	private _syncActionBar(): void {
		const id = this.boxId;
		const runBtn = document.getElementById(id + '_sql_run_btn') as HTMLButtonElement | null;
		const cancelBtn = document.getElementById(id + '_sql_cancel_btn') as HTMLButtonElement | null;
		const execStatus = document.getElementById(id + '_sql_exec_status') as HTMLElement | null;
		const elapsedSpan = document.getElementById(id + '_sql_elapsed') as HTMLElement | null;
		const errorLabel = document.getElementById(id + '_sql_error_label') as HTMLElement | null;

		if (runBtn) {
			runBtn.disabled = !this._sqlConnectionId || !this._database || this._executing;
			const labelText = this._getSqlRunModeLabel();
			const labelSpan = runBtn.querySelector('.run-btn-label');
			if (labelSpan) labelSpan.textContent = ' ' + labelText;
			runBtn.title = labelText + (runBtn.disabled ? '\nSelect a server and database first (or select a favorite)' : '');
		}
		if (cancelBtn) cancelBtn.style.display = this._executing ? '' : 'none';
		if (execStatus) execStatus.style.display = this._executing ? '' : 'none';
		if (elapsedSpan) elapsedSpan.textContent = this._elapsedText || '0:00';
		if (errorLabel) {
			errorLabel.style.display = this._lastError ? '' : 'none';
			errorLabel.textContent = this._lastError;
		}
	}

	/**
	 * Imperatively sync copilot chat toolbar active state in light DOM.
	 */
	private _syncCopilotState(): void {
		// Visibility is now fully managed by the unified CopilotChatManagerController.
		// Nothing to sync here.
	}

	// ── Connection row ────────────────────────────────────────────────────────

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
				${this._renderServerDropdown()}
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

	private _renderServerDropdown(): TemplateResult {
		const sorted = [...this._connections].sort((a, b) =>
			(a.name || a.serverUrl).toLowerCase().localeCompare((b.name || b.serverUrl).toLowerCase())
		);
		const serverItems: DropdownItem[] = sorted.map(c => ({
			id: c.id,
			label: c.name || c.serverUrl,
		}));
		const restoredServerId = '__restored_sql_server__';
		const selectedServerId = this._connectionId || (this._desiredServerUrl ? restoredServerId : '');
		if (!this._connectionId && this._desiredServerUrl) {
			serverItems.unshift({
				id: restoredServerId,
				label: this._desiredServerUrl,
				disabled: true,
			});
		}
		const serverActions: DropdownAction[] = [
			{ id: '__add_new__', label: 'Add new server…' },
		];
		return html`
			<div class="select-wrapper half-width" title="SQL Server">
				<kw-dropdown
					.items=${serverItems}
					.actions=${serverActions}
					.selectedId=${selectedServerId}
					.placeholder=${'Select Server...'}
					.emptyText=${'No SQL connections.'}
					.buttonIcon=${serverIconSvg}
					@dropdown-select=${this._onServerSelected}
					@dropdown-action=${this._onServerAction}
				></kw-dropdown>
			</div>
		`;
	}

	private _renderDatabaseDropdown(): TemplateResult {
		const dbItems: DropdownItem[] = (this._databases || []).map(db => ({ id: db, label: db }));
		const restoredDatabase = !this._database && this._desiredDatabase ? this._desiredDatabase : '';
		if (restoredDatabase && !dbItems.some(item => item.id === restoredDatabase)) {
			dbItems.unshift({ id: restoredDatabase, label: restoredDatabase, disabled: true });
		}
		const selectedDatabase = this._database || restoredDatabase;
		return html`
			<div class="select-wrapper half-width" title="SQL Database">
				<kw-dropdown
					.items=${dbItems}
					.selectedId=${selectedDatabase}
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

	// ── Favorites rendering ───────────────────────────────────────────────────

	private _renderFavoritesDropdown(): TemplateResult {
		const favItems: DropdownItem[] = (this._favorites || []).map((f, i) => {
			const d = formatSqlFavoriteDisplay(f, this._connections);
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
			<div class="select-wrapper sql-favorites-combo" title="Favorites">
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
				title="${this._favoritesMode ? 'Show server and database picker' : 'Show favorites'}"
				aria-label="${this._favoritesMode ? 'Show server and database picker' : 'Show favorites'}"
				@click=${this._onFavoritesModeToggle}>
				${this._favoritesMode ? serverPickerIconSvg : favoritesListIconSvg}
			</button>
		`;
	}

	// ── Favorites event handlers ──────────────────────────────────────────────

	private _onFavoriteToggle(): void {
		this.dispatchEvent(new CustomEvent('sql-favorite-toggle', {
			detail: { boxId: this.boxId, connectionId: this._connectionId, database: this._database },
			bubbles: true, composed: true,
		}));
	}

	private _onFavoritesModeToggle(): void {
		this._favoritesMode = !this._favoritesMode;
		this.dispatchEvent(new CustomEvent('sql-favorites-mode-changed', {
			detail: { boxId: this.boxId, favoritesMode: this._favoritesMode },
			bubbles: true, composed: true,
		}));
	}

	private _onFavoriteSelected(e: CustomEvent): void {
		const index = parseInt(e.detail?.id, 10);
		const fav = this._favorites[index];
		if (!fav) return;
		const targetConnId = fav.connectionId;
		const conn = this._connections.find(c => c.id === targetConnId);
		if (conn) {
			this._connectionId = conn.id;
			this._sqlConnectionId = conn.id;
			this._desiredServerUrl = conn.serverUrl;
			this._desiredDatabase = fav.database;
			this._database = '';
			this._databases = [];
			this.dispatchEvent(new CustomEvent('sql-connection-changed', {
				detail: { boxId: this.boxId, connectionId: conn.id },
				bubbles: true, composed: true,
			}));
			this.dispatchEvent(new CustomEvent('sql-favorite-selected', {
				detail: { boxId: this.boxId, connectionId: conn.id, database: fav.database },
				bubbles: true, composed: true,
			}));
		}
	}

	private _onFavoriteRemoved(e: CustomEvent): void {
		const index = parseInt(e.detail?.id, 10);
		const fav = this._favorites[index];
		if (!fav) return;
		this.dispatchEvent(new CustomEvent('sql-favorite-removed', {
			detail: { boxId: this.boxId, connectionId: fav.connectionId, database: fav.database },
			bubbles: true, composed: true,
		}));
	}

	private _onFavoriteAction(e: CustomEvent): void {
		const action = e.detail?.id;
		if (action === '__other__') {
			this._favoritesMode = false;
			this.dispatchEvent(new CustomEvent('sql-favorites-mode-changed', {
				detail: { boxId: this.boxId, favoritesMode: false },
				bubbles: true, composed: true,
			}));
		}
	}

	private _isFavorited(): boolean {
		if (!this._connectionId || !this._database) return false;
		const connId = this._connectionId;
		const dbLower = this._database.toLowerCase();
		return this._favorites.some(f =>
			f.connectionId === connId && (f.database || '').toLowerCase() === dbLower
		);
	}

	private _getSelectedFavoriteIndex(): number {
		if (!this._connectionId) return -1;
		const db = this._database || this._desiredDatabase;
		if (!db) return -1;
		const connId = this._connectionId;
		const dbLower = db.toLowerCase();
		return this._favorites.findIndex(f =>
			f.connectionId === connId && (f.database || '').toLowerCase() === dbLower
		);
	}

	// ── Connection event handlers ─────────────────────────────────────────────

	private _onDropdownOpened(e: Event): void {
		const source = e.target;
		const dropdowns = this.shadowRoot?.querySelectorAll('kw-dropdown');
		dropdowns?.forEach(dd => {
			if (dd !== source) (dd as any).close();
		});
	}

	private _onServerAction(e: CustomEvent): void {
		const action = e.detail?.id;
		if (action === '__add_new__') {
			this._showAddSqlModal = true;
		}
	}

	private _onAddSqlConnectionSubmit(e: CustomEvent<SqlConnectionFormSubmitDetail>): void {
		this._showAddSqlModal = false;
		this.dispatchEvent(new CustomEvent('sql-add-connection', {
			detail: { ...e.detail, boxId: this.boxId },
			bubbles: true, composed: true,
		}));
	}

	private _onAddSqlConnectionCancel(): void {
		this._showAddSqlModal = false;
	}

	private _renderAddSqlConnectionModal(): TemplateResult {
		return html`
			<div class="add-connection-overlay" @click=${() => this._onAddSqlConnectionCancel()} @keydown=${(e: KeyboardEvent) => {
				if (e.key === 'Escape') { this._onAddSqlConnectionCancel(); e.preventDefault(); }
			}}>
				<div class="add-connection-dialog" @click=${(e: Event) => e.stopPropagation()}>
					<div class="add-connection-header">
						<span class="add-connection-title">Add SQL Connection</span>
						<button class="add-connection-close" @click=${() => this._onAddSqlConnectionCancel()}>
							<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 8.707l3.646 3.647.708-.708L8.707 8l3.647-3.646-.708-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z"/></svg>
						</button>
					</div>
					<div class="add-connection-body">
						<kw-sql-connection-form
							mode="add"
							@sql-connection-form-submit=${this._onAddSqlConnectionSubmit}
							@sql-connection-form-cancel=${() => this._onAddSqlConnectionCancel()}
						></kw-sql-connection-form>
					</div>
					<div class="add-connection-footer">
						<button class="add-connection-btn" data-testid="sql-conn-cancel" @click=${() => this._onAddSqlConnectionCancel()}>Cancel</button>
						<button class="add-connection-btn primary" data-testid="sql-conn-save" @click=${() => this._submitAddSqlForm()}>Save</button>
					</div>
				</div>
			</div>
		`;
	}

	private _submitAddSqlForm(): void {
		const form = this.shadowRoot?.querySelector('kw-sql-connection-form');
		if (form) form.submit();
	}

	private _onServerSelected(e: CustomEvent): void {
		const connectionId = e.detail?.id;
		if (!connectionId) return;
		const prev = this._connectionId;
		this._connectionId = connectionId;
		this._sqlConnectionId = connectionId;
		const conn = this._connections.find(c => c.id === connectionId);
		if (conn) this._desiredServerUrl = conn.serverUrl || '';
		if (prev !== connectionId) {
			this._database = '';
			this._desiredDatabase = '';
			this._databases = [];
			this.dispatchEvent(new CustomEvent('sql-connection-changed', {
				detail: { boxId: this.boxId, connectionId, serverUrl: conn?.serverUrl || '' },
				bubbles: true, composed: true,
			}));
		}
	}

	private _onDatabaseSelected(e: CustomEvent): void {
		const database = e.detail?.id;
		if (!database) return;
		const prev = this._database;
		this._database = database;
		this._desiredDatabase = '';
		if (prev !== database) {
			this._resetSchemaReadiness('loading');
			this.dispatchEvent(new CustomEvent('sql-database-changed', {
				detail: { boxId: this.boxId, database },
				bubbles: true, composed: true,
			}));
			this._connectStsIfReady('db-change');
		}
	}

	private _onRefreshClick(): void {
		this.dispatchEvent(new CustomEvent('sql-refresh-databases', {
			detail: { boxId: this.boxId, connectionId: this._connectionId },
			bubbles: true, composed: true,
		}));
	}

	private _onSchemaRefresh(): void {
		this.dispatchEvent(new CustomEvent('sql-schema-refresh', {
			detail: { boxId: this.boxId },
			bubbles: true, composed: true,
		}));
	}

	private _onSeeCachedValues(): void {
		// SQL doesn't have a cached values viewer — close the popover
		this._getSchemaInfoEl()?.close();
	}

	// ── Copilot adapter methods (CopilotChatManagerHost interface) ────────────

	public getCopilotConnectionId(): string { return this._sqlConnectionId; }
	public getCopilotServerUrl(): string { return this.getServerUrl(); }
	public setCopilotQueryText(text: string): void {
		if (this._editor) {
			this._editor.setValue(text);
			this._editor.focus();
		}
		try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	}
	public getCopilotEditorValue(): string {
		try { return this._editor ? (this._editor.getValue() || '') : ''; } catch { return ''; }
	}
	public focusCopilotEditor(): void {
		try { this._editor?.focus(); } catch (e) { console.error('[kusto]', e); }
	}
	public layoutCopilotEditor(): void {
		if (!this._editor) return;
		requestAnimationFrame(() => {
			try {
				const container = document.getElementById(this.boxId + '_sql_editor');
				if (container && this._editor) {
					const rect = container.getBoundingClientRect();
					if (rect.width > 0 && rect.height > 0) {
						this._editor.layout({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
					}
				}
			} catch { /* ignore */ }
		});
	}

	// ── Copilot ───────────────────────────────────────────────────────────────

	private _onCopilotSplitterMouseDown(_e: MouseEvent): void {
		// Splitter drag is now handled by the unified controller.
	}

	override updated(changedProps: Map<string, unknown>): void {
		super.updated(changedProps);
		// Sync light DOM state imperatively.
		this._syncActionBar();
		this._syncCopilotState();
		this._syncTestStateAttrs();
	}

	private _syncTestStateAttrs(): void {
		this.dataset.testSqlConnection = this._sqlConnectionId ? 'true' : 'false';
		this.dataset.testDatabasesLoading = this._databasesLoading ? 'true' : 'false';
		this.dataset.testHasDatabases = this._databases.length > 0 ? 'true' : 'false';
		this.dataset.testDatabaseCount = String(this._databases.length);
		this.dataset.testDatabaseSelected = this._database ? 'true' : 'false';
		if (this._database) this.dataset.testDatabase = this._database;
		else delete this.dataset.testDatabase;
		this.dataset.testSchemaStatus = this._schemaInfoState.status || 'not-loaded';
		this.dataset.testSchemaReady = (this._schemaInfoState.status === 'loaded' || this._schemaInfoState.status === 'cached') ? 'true' : 'false';
		this.dataset.testStsReady = this._stsReady ? 'true' : 'false';
		this.dataset.testExecuting = this._executing ? 'true' : 'false';
		this.dataset.testHasResults = this._hasResults ? 'true' : 'false';
		this.dataset.testHasError = this._lastError ? 'true' : 'false';
		this.dataset.testResultsVisible = (() => { try { const m = pState.resultsVisibleByBoxId; return (m && m[this.boxId] === false) ? 'false' : 'true'; } catch { return 'true'; } })();
	}

	private _resetSchemaReadiness(status: SchemaInfoState['status'] = 'not-loaded'): void {
		this._schemaInfoState = { status };
		this._stsReady = false;
		this._syncTestStateAttrs();
	}

	// ── Monaco init ───────────────────────────────────────────────────────────

	private _initEditor(): void {
		if (this._editor) {
			return;
		}

		// Editor container lives in light DOM (created by _createLightDomContent).
		const editorDiv = document.getElementById(this.boxId + '_sql_editor');
		if (!editorDiv) {
			if (this._initRetryCount < 10) {
				this._initRetryCount++;
				requestAnimationFrame(() => this._initEditor());
			}
			return;
		}
		this._initRetryCount = 0;

		try {
			// Actively trigger Monaco loading (don't just poll window.monaco).
			// When the session contains only SQL sections and no KQL sections,
			// nothing else triggers the Monaco AMD load.
			const ensureMonaco = (window as any).ensureMonaco as (() => Promise<any>) | undefined;
			if (typeof ensureMonaco === 'function') {
				ensureMonaco().then(() => {
					if (this._editor) return; // already created while we waited
					this._createMonacoEditor(editorDiv);
				}).catch((e: any) => {
					console.error('[kusto] ensureMonaco failed in SQL section:', e);
				});
				return;
			}

			// Fallback: ensureMonaco not yet available, retry
			const monaco = (window as any).monaco;
			if (!monaco?.editor) {
				if (this._monacoRetryCount < 20) {
					this._monacoRetryCount++;
					requestAnimationFrame(() => this._initEditor());
				}
				return;
			}
			this._monacoRetryCount = 0;
			this._createMonacoEditor(editorDiv);
		} catch (e) {
			console.error('[kusto] SQL editor init error:', e);
		}
	}

	private _createMonacoEditor(editorDiv: HTMLElement): void {
		try {
			const monaco = (window as any).monaco;
			if (!monaco?.editor) return;

			// Determine initial value: savedQuery (reconnect) > pending stash > initial attribute > ''
			let initialValue = '';
			if (this._savedQuery !== null) {
				initialValue = this._savedQuery;
				this._savedQuery = null;
			} else {
				const pending = pState.pendingSqlQueryByBoxId?.[this.boxId];
				if (typeof pending === 'string') {
					initialValue = pending;
					delete pState.pendingSqlQueryByBoxId[this.boxId];
				} else if (this.initialQuery) {
					initialValue = this.initialQuery;
				}
			}

			const editor = monaco.editor.create(editorDiv, {
				value: initialValue,
				language: 'sql',
				theme: getCurrentMonacoThemeName(),
				readOnly: false,
				domReadOnly: false,
				minimap: { enabled: false },
				scrollBeyondLastLine: false,
				automaticLayout: false,
				lineNumbers: 'on',
				fontSize: 13,
				wordWrap: 'on',
				wrappingStrategy: 'advanced',
				glyphMargin: false,
				lineDecorationsWidth: 8,
				fixedOverflowWidgets: true,
				overviewRulerLanes: 0,
				hideCursorInOverviewRuler: true,
				renderLineHighlight: 'none',
				padding: { top: 6, bottom: 6 },
				suggestOnTriggerCharacters: false,
				wordBasedSuggestions: 'off',
				scrollbar: { alwaysConsumeMouseWheel: false, horizontal: 'hidden', verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
				// Enable inline suggestions (ghost text completions from Copilot)
				inlineSuggest: { enabled: true },
			});

			this._editor = editor;

			// Register model URI → boxId mapping for STS providers.
			try {
				const model = editor.getModel();
				if (model?.uri) {
					registerStsEditorModel(model.uri.toString(), this.boxId);
					queryEditorBoxByModelUri[model.uri.toString()] = this.boxId;
				}
			} catch (e) { console.error('[kusto]', e); }

			// Register editor instance for inline completions provider lookup.
			try { queryEditors[this.boxId] = editor; } catch (e) { console.error('[kusto]', e); }

			// Register STS-powered Monaco providers (once globally).
			try { registerStsProviders(); } catch (e) { console.error('[kusto]', e); }

			// Hide placeholder once editor has content.
			this._updatePlaceholderVisibility();

		editor.onDidChangeModelContent((changeEvt: { changes: Array<{ text: string; range: unknown }> }) => {
			this._updatePlaceholderVisibility();
			this._markResultsStale();
			try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			if (this._stsDocumentOpened) {
				try {
					postMessageToHost({ type: 'stsDidChange', boxId: this.boxId, text: editor.getValue() } as any);
				} catch (e) { console.error('[kusto]', e); }
			}
			try { this._maybeAutoTriggerAutocomplete(changeEvt); } catch (err) { console.error('[kusto]', err); }
		});

			// Apply persisted editor height.
			if (this._savedEditorHeightPx && this._userResizedEditor) {
				const wrapper = document.getElementById(this.boxId + '_sql_editor_wrapper');
				if (wrapper) {
					wrapper.style.height = `${this._savedEditorHeightPx}px`;
				}
			}

			// Track active editor for global key handlers (Ctrl+Space, paste, etc.).
			try {
				editor.onDidFocusEditorText(() => {
					try { setActiveMonacoEditor(editor); } catch (e) { console.error('[kusto]', e); }
				});
				editor.onDidFocusEditorWidget(() => {
					try { setActiveMonacoEditor(editor); } catch (e) { console.error('[kusto]', e); }
				});
			} catch (e) { console.error('[kusto]', e); }

			// Make editor writable (in case read-only is global default).
			try { __kustoForceEditorWritable(editor); } catch (e) { console.error('[kusto]', e); }
			try { __kustoInstallWritableGuard(editor); } catch (e) { console.error('[kusto]', e); }
			try { __kustoEnsureEditorWritableSoon(editor); } catch (e) { console.error('[kusto]', e); }

			// Shift+Enter → run query.
			try {
				const KeyMod = monaco.KeyMod;
				const KeyCode = monaco.KeyCode;
				editor.addCommand(KeyMod.Shift | KeyCode.Enter, () => this._runQuery());
			} catch (e) { console.error('[kusto]', e); }

			// Ctrl+Shift+Space → trigger Copilot inline suggestion (ghost text).
			try {
				editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Space, () => {
					const action = editor.getAction('editor.action.inlineSuggest.trigger');
					if (action) {
						action.run().catch(() => { /* ignore */ });
					} else {
						editor.trigger('keyboard', 'editor.action.inlineSuggest.trigger', {});
					}
				});
			} catch (e) { console.error('[kusto]', e); }

			// Editor now lives in light DOM — automaticLayout: true works, but
			// we keep manual layout for consistency with Kusto section pattern.
			const layoutEditor = () => {
				try {
					if (editorDiv && this._editor) {
						const rect = editorDiv.getBoundingClientRect();
						if (rect.width > 0 && rect.height > 0) {
							this._editor.layout({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
						}
					}
				} catch { /* ignore */ }
			};

			// Layout on several frames to handle rendering delays.
			requestAnimationFrame(layoutEditor);
			setTimeout(layoutEditor, 50);
			setTimeout(layoutEditor, 200);

			// Close find widget if it auto-opened.
			setTimeout(() => {
				try { editor.trigger('init', 'closeFindWidget', null); } catch { /* ignore */ }
			}, 50);

			// Watch the container for resize (user drag, window resize, etc.)
			try {
				if (editorDiv) {
					this._editorResizeObserver = new ResizeObserver(layoutEditor);
					this._editorResizeObserver.observe(editorDiv);
				}
			} catch (e) { console.error('[kusto]', e); }

			this._connectStsIfReady('init');

		} catch (e) {
			console.error('[kusto] SQL editor init error:', e);
		}
	}

	private _openStsDocumentIfNeeded(): boolean {
		if (this._stsDocumentOpened) return true;
		if (!this._editor) return false;
		try {
			const text = this._editor.getValue();
			console.log(`[sts-diag] stsDidOpen boxId=${this.boxId} textLen=${text.length}`);
			postMessageToHost({ type: 'stsDidOpen', boxId: this.boxId, text } as any);
			this._stsDocumentOpened = true;
			return true;
		} catch (e) {
			console.error('[kusto]', e);
			return false;
		}
	}

	private _connectStsIfReady(reason: string): void {
		if (!this._sqlConnectionId || !this._database) {
			console.log(`[sts-diag] stsConnect SKIPPED (${reason}) boxId=${this.boxId} connId=${this._sqlConnectionId || '(none)'} db=${this._database || '(none)'}`);
			return;
		}
		if (pState.restoreInProgress) {
			console.log(`[sts-diag] stsConnect SKIPPED (${reason}, restore) boxId=${this.boxId} connId=${this._sqlConnectionId} db=${this._database}`);
			return;
		}
		if (!this._openStsDocumentIfNeeded()) return;
		console.log(`[sts-diag] stsConnect (${reason}) boxId=${this.boxId} connId=${this._sqlConnectionId} db=${this._database}`);
		try {
			postMessageToHost({ type: 'stsConnect', boxId: this.boxId, sqlConnectionId: this._sqlConnectionId, database: this._database } as any);
		} catch (e) { console.error('[kusto]', e); }
	}

	private _disposeEditor(): void {
		if (this._stsDocumentOpened) {
			try {
				postMessageToHost({ type: 'stsDidClose', boxId: this.boxId } as any);
			} catch { /* ignore */ }
			this._stsDocumentOpened = false;
		}

		// Unregister model URI mapping and shared editor maps.
		if (this._editor) {
			try {
				const model = this._editor.getModel();
				if (model?.uri) {
					const uriStr = model.uri.toString();
					unregisterStsEditorModel(uriStr);
					delete queryEditorBoxByModelUri[uriStr];
				}
			} catch { /* ignore */ }
			try { delete queryEditors[this.boxId]; } catch { /* ignore */ }
		}

		if (this._editorResizeObserver) {
			try { this._editorResizeObserver.disconnect(); } catch { /* ignore */ }
			this._editorResizeObserver = null;
		}
		if (this._editor) {
			try { this._editor.dispose(); } catch { /* ignore */ }
			this._editor = null;
		}
	}

	private _updatePlaceholderVisibility(): void {
		const placeholder = document.getElementById(this.boxId + '_sql_placeholder');
		if (!placeholder) {
			return;
		}
		const hasContent = this._editor
			? (this._editor.getValue() || '').trim().length > 0
			: false;
		placeholder.style.display = hasContent ? 'none' : '';
	}

	// ── Stale results ─────────────────────────────────────────────────────────

	private _markResultsStale(): void {
		const wrapper = document.getElementById(this.boxId + '_sql_results_wrapper');
		if (wrapper && wrapper.style.display !== 'none') {
			wrapper.classList.add('is-stale');
		}
	}

	private _clearResultsStale(): void {
		const wrapper = document.getElementById(this.boxId + '_sql_results_wrapper');
		if (wrapper) wrapper.classList.remove('is-stale');
	}

	// ── Serialize ─────────────────────────────────────────────────────────────

	public serialize(): SqlSectionData {
		const data: SqlSectionData = {
			id: this.boxId,
			type: 'sql',
			name: this._name,
			query: this._getQueryText(),
			expanded: this._expanded,
		};

		const serverUrl = this.getServerUrl() || this._desiredServerUrl;
		const database = this._database || this._desiredDatabase;

		if (serverUrl) {
			data.serverUrl = serverUrl;
		}
		if (database) {
			data.database = database;
		}
		if (this._favoritesMode) {
			data.favoritesMode = true;
		}

		// Run mode
		try {
			const mode = getRunMode(this.boxId);
			if (mode && mode !== 'top100') {
				data.runMode = mode;
			}
		} catch (e) { console.error('[kusto]', e); }

		const editorH = this._savedEditorHeightPx ?? this._getWrapperHeightPx();
		if (editorH !== undefined) {
			data.editorHeightPx = editorH;
		}

		// Results visibility & height
		try {
			const m = pState.resultsVisibleByBoxId;
			if (m && m[this.boxId] === false) {
				data.resultsVisible = false;
			}
		} catch (e) { console.error('[kusto]', e); }

		try {
			const wrapper = document.getElementById(this.boxId + '_sql_results_wrapper');
			if (wrapper && (wrapper as HTMLElement).dataset.kustoUserResized) {
				const h = parseInt((wrapper as HTMLElement).style.height, 10);
				if (h > 0) data.resultsHeightPx = h;
			}
		} catch (e) { console.error('[kusto]', e); }

		// Copilot chat state
		if (this.copilotCtrl.getCopilotChatVisible()) {
			data.copilotChatVisible = true;
		}
		const chatW = this.copilotCtrl.getCopilotChatWidthPx();
		if (chatW !== undefined) {
			data.copilotChatWidthPx = chatW;
		}

		// Persist query results (stored in-memory by results-state.ts after execution).
		try {
			const rj = pState.queryResultJsonByBoxId?.[this.boxId];
			if (rj) {
				data.resultJson = String(rj);
			}
		} catch (e) { console.error('[kusto]', e); }

		return data;
	}

	private _getQueryText(): string {
		if (this._editor) {
			try {
				const model = this._editor.getModel();
				if (model) {
					return model.getValue();
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		// Fall back to pending stash.
		try {
			const pending = pState.pendingSqlQueryByBoxId;
			if (pending && typeof pending === 'object' && typeof pending[this.boxId] === 'string') {
				return pending[this.boxId];
			}
		} catch (e) { console.error('[kusto]', e); }
		return '';
	}

	private _getWrapperHeightPx(): number | undefined {
		const wrapper = document.getElementById(this.boxId + '_sql_editor_wrapper');
		if (!wrapper || !this._userResizedEditor) {
			return undefined;
		}
		const inlineHeight = wrapper.style.height?.trim();
		if (!inlineHeight || inlineHeight === 'auto') {
			return undefined;
		}
		const m = inlineHeight.match(/^(\d+)px$/i);
		if (!m) {
			return undefined;
		}
		const px = parseInt(m[1], 10);
		return Number.isFinite(px) ? px : undefined;
	}

	// ── Public API ────────────────────────────────────────────────────────────

	public getName(): string { return this._name; }
	public setName(name: string): void { this._name = name; }

	public getQuery(): string { return this._getQueryText(); }
	public setQuery(query: string): void {
		if (this._editor) {
			this._editor.setValue(query);
		} else {
			pState.pendingSqlQueryByBoxId = pState.pendingSqlQueryByBoxId || {};
			pState.pendingSqlQueryByBoxId[this.boxId] = query;
		}
	}

	public getServerUrl(): string {
		const conn = this._connections.find(c => c.id === this._connectionId);
		return conn?.serverUrl || '';
	}

	/** Set the desired server URL (used during restoration). */
	public setDesiredServerUrl(url: string): void {
		this._desiredServerUrl = url;
	}

	/** Set the desired database (used during restoration). */
	public setDesiredDatabase(db: string): void {
		this._desiredDatabase = db;
	}

	/** @deprecated Use setDesiredServerUrl instead. Kept for restore compat. */
	public setServerUrl(url: string): void {
		this._desiredServerUrl = url;
	}

	public getDatabase(): string { return this._database; }
	public setDatabase(db: string): void {
		if (this._database !== db) {
			this._database = db;
			this._resetSchemaReadiness(db ? 'loading' : 'not-loaded');
			return;
		}
		this._database = db;
	}

	public getConnectionId(): string { return this._connectionId; }

	public getSqlConnectionId(): string { return this._sqlConnectionId; }
	public setSqlConnectionId(id: string): void {
		this._sqlConnectionId = id;
		this._connectionId = id;
		if (!id) this._resetSchemaReadiness('not-loaded');
	}

	// ── Favorites public API ──────────────────────────────────────────────────

	public setFavoritesMode(mode: boolean): void {
		this._favoritesMode = mode;
	}

	public isFavoritesMode(): boolean {
		return this._favoritesMode;
	}

	public setFavorites(favorites: SqlFavoriteInfo[]): void {
		const sorted = (Array.isArray(favorites) ? favorites : []).slice().sort((a, b) => {
			const an = String((a?.name) || '').toLowerCase();
			const bn = String((b?.name) || '').toLowerCase();
			return an.localeCompare(bn);
		});
		this._favorites = sorted;
	}

	/** Update available SQL connections. Resolves desired/current/last selection. */
	public setConnections(
		conns: SqlConnectionInfo[],
		opts?: { lastConnectionId?: string },
	): void {
		this._connections = conns;
		const lastConnId = opts?.lastConnectionId || '';

		let resolvedId = '';

		// 1. Try desired server URL
		if (this._desiredServerUrl) {
			const target = this._desiredServerUrl.trim().toLowerCase();
			const match = conns.find(c => (c.serverUrl || '').trim().toLowerCase() === target);
			if (match) resolvedId = match.id;
		}

		// 2. Try current selection
		if (!resolvedId && this._connectionId) {
			const match = conns.find(c => c.id === this._connectionId);
			if (match) resolvedId = match.id;
		}

		// 3. Try last used
		if (!resolvedId && lastConnId) {
			const match = conns.find(c => c.id === lastConnId);
			if (match) resolvedId = match.id;
		}

		const prev = this._connectionId;
		this._connectionId = resolvedId;
		this._sqlConnectionId = resolvedId;
		if (prev !== resolvedId) {
			this._resetSchemaReadiness('not-loaded');
		}

		if (resolvedId) {
			const conn = conns.find(c => c.id === resolvedId);
			if (conn) this._desiredServerUrl = conn.serverUrl;
		}

		if (prev !== resolvedId && resolvedId) {
			this.dispatchEvent(new CustomEvent('sql-connection-changed', {
				detail: { boxId: this.boxId, connectionId: resolvedId, serverUrl: this.getServerUrl(), database: this._desiredDatabase || this._database },
				bubbles: true, composed: true,
			}));
		}
	}

	/** Update available databases. Applies desired database if set. */
	public setDatabases(databases: string[], desiredDb?: string): void {
		const previousDatabase = this._database;
		this._databases = databases;
		this._databasesLoading = false;

		// Priority: desiredDatabase > current > desiredDb (global last) > auto-select single
		if (this._desiredDatabase && databases.includes(this._desiredDatabase)) {
			const prev = this._database;
			this._database = this._desiredDatabase;
			this._desiredDatabase = '';
			if (prev !== this._database) {
				this._resetSchemaReadiness('loading');
				this.dispatchEvent(new CustomEvent('sql-database-changed', {
					detail: { boxId: this.boxId, database: this._database },
					bubbles: true, composed: true,
				}));
			}
		} else if (this._database && databases.includes(this._database)) {
			// Keep current selection
		} else if (desiredDb && databases.includes(desiredDb)) {
			const prev = this._database;
			this._database = desiredDb;
			this._desiredDatabase = '';
			if (prev !== desiredDb) {
				this._resetSchemaReadiness('loading');
				this.dispatchEvent(new CustomEvent('sql-database-changed', {
					detail: { boxId: this.boxId, database: desiredDb },
					bubbles: true, composed: true,
				}));
			}
		} else if (databases.length === 1) {
			const db = databases[0];
			const prev = this._database;
			this._database = db;
			this._desiredDatabase = '';
			if (prev !== db) {
				this._resetSchemaReadiness('loading');
				this.dispatchEvent(new CustomEvent('sql-database-changed', {
					detail: { boxId: this.boxId, database: db },
					bubbles: true, composed: true,
				}));
			}
		}
		if (this._database && this._database !== previousDatabase) {
			this._connectStsIfReady('database-list');
		}
	}

	/** Set databases loading state. */
	public setDatabasesLoading(loading: boolean): void {
		this._databasesLoading = loading;
		this._syncTestStateAttrs();
	}

	/** Set refresh button loading state. */
	public setRefreshLoading(loading: boolean): void {
		this._refreshLoading = loading;
	}

	/** Update schema info display (delegates to <kw-schema-info> child). */
	public setSchemaInfo(info: Partial<SchemaInfoState>): void {
		this._schemaInfoState = { ...this._schemaInfoState, ...info };
		this._getSchemaInfoEl()?.setInfo(info);
		this._syncTestStateAttrs();
	}

	public setStsReady(ready: boolean): void {
		this._stsReady = ready;
		setStsReady(this.boxId, ready);
		this._syncTestStateAttrs();
	}

	// ── Auto-trigger autocomplete ─────────────────────────────────────────────

	/**
	 * Debounced auto-trigger: examines the change event and programmatically
	 * fires editor.action.triggerSuggest when typing looks like it would benefit
	 * from completions.  Adapted from the KQL auto-trigger in monaco.ts.
	 */
	private _maybeAutoTriggerAutocomplete(changeEvent: { changes: Array<{ text: string; range: unknown }> }): void {
		if (!autoTriggerAutocompleteEnabled) return;
		const ed = this._editor;
		if (!ed || !ed.hasTextFocus?.()) return;

		// Determine whether any change should trigger completions.
		let shouldTrigger = false;
		let maxChangeLen = 0;
		for (const change of changeEvent.changes) {
			const text = change.text;
			if (!text) continue; // pure deletion — skip
			if (text.length > maxChangeLen) maxChangeLen = text.length;
			if (/\n/.test(text)) { shouldTrigger = true; continue; }
			if (/[A-Za-z0-9_.,\[\(=]/.test(text)) { shouldTrigger = true; continue; }
		}
		if (!shouldTrigger) return;

		// Skip if the change looks like an autocomplete acceptance (long multi-char insert).
		if (maxChangeLen > 2) return;

		// Debounce — cancel pending trigger and schedule a new one.
		if (this._autoSuggestTimer !== undefined) clearTimeout(this._autoSuggestTimer);
		this._autoSuggestTimer = setTimeout(() => {
			this._autoSuggestTimer = undefined;
			if (!ed.hasTextFocus?.()) return;

			// Rate-limit — at least 180 ms between triggers.
			const now = Date.now();
			if (now - this._lastSuggestTriggerAt < 180) return;

			// End-of-word suppression: if the cursor is at the end of a completed
			// word (word char before cursor, non-word or EOL at cursor), skip.
			try {
				const pos = ed.getPosition?.();
				if (pos) {
					const model = ed.getModel();
					const line = model?.getLineContent?.(pos.lineNumber) ?? '';
					const charBefore = pos.column > 1 ? line[pos.column - 2] : '';
					const charAt = line[pos.column - 1] ?? '';
					if (/\w/.test(charBefore) && !/\w/.test(charAt)) return;
				}
			} catch { /* ignore — proceed with trigger */ }

			this._lastSuggestTriggerAt = now;
			try { ed.trigger('keyboard', 'editor.action.triggerSuggest', {}); } catch { /* ignore */ }
		}, 140);
	}

	/** Get the <kw-schema-info> child element. */
	private _getSchemaInfoEl(): KwSchemaInfo | null {
		return this.shadowRoot?.querySelector('kw-schema-info') ?? null;
	}

	// ── Copilot public API (called from message-handler.ts) ───────────────────

	public getCopilotChatEl() { return this.copilotCtrl.getCopilotChatEl(); }
	public getCopilotChatVisible(): boolean { return this.copilotCtrl.getCopilotChatVisible(); }
	public getCopilotChatWidthPx(): number | undefined { return this.copilotCtrl.getCopilotChatWidthPx(); }
	public setCopilotChatWidthPx(widthPx: number): void { this.copilotCtrl.setCopilotChatWidthPx(widthPx); }

	public setCopilotChatVisible(visible: boolean): void {
		this.copilotCtrl.setCopilotChatVisible(visible);
	}

	public copilotApplyWriteQueryOptions(models: unknown[], selectedModelId: string, tools: unknown[]): void {
		this.copilotCtrl.copilotApplyWriteQueryOptions(models, selectedModelId, tools);
	}

	public copilotWriteQueryStatus(status: string, detail: string, role: string): void {
		this.copilotCtrl.copilotWriteQueryStatus(status, detail, role);
	}

	public copilotWriteQuerySetQuery(queryText: string): void {
		this.copilotCtrl.copilotWriteQuerySetQuery(queryText);
	}

	public copilotWriteQueryDone(ok: boolean, message: string): void {
		this.copilotCtrl.copilotWriteQueryDone(ok, message);
	}

	public copilotWriteQueryToolResult(toolName: string, label: string, jsonText: string, entryId: string): void {
		this.copilotCtrl.copilotWriteQueryToolResult(toolName, label, jsonText, entryId);
	}

	public copilotAppendExecutedQuery(query: string, resultSummary: string, errorMessage: string, entryId: string, result: unknown): void {
		this.copilotCtrl.copilotAppendExecutedQuery(query, resultSummary, errorMessage, entryId, result);
	}

	public copilotAppendGeneralRulesLink(filePath: string, preview: string, entryId: string): void {
		this.copilotCtrl.copilotAppendGeneralRulesLink(filePath, preview, entryId);
	}

	public copilotAppendClarifyingQuestion(question: string, entryId: string): void {
		this.copilotCtrl.copilotAppendClarifyingQuestion(question, entryId);
	}

	public copilotAppendQuerySnapshot(queryText: string, entryId: string): void {
		this.copilotCtrl.copilotAppendQuerySnapshot(queryText, entryId);
	}

	public copilotAppendDevNotesContext(preview: string, entryId: string): void {
		this.copilotCtrl.copilotAppendDevNotesContext(preview, entryId);
	}

	public copilotAppendDevNoteToolCall(action: string, detail: string, result: string, entryId: string): void {
		this.copilotCtrl.copilotAppendDevNoteToolCall(action, detail, result, entryId);
	}

	public copilotClearConversation(): void { this.copilotCtrl.copilotClearConversation(); }
	public copilotWriteQueryCancel(): void { this.copilotCtrl.copilotWriteQueryCancel(); }
	public disposeCopilotChat(): void { this.copilotCtrl.disposeCopilotChat(); }

	/**
	 * Called by the results pipeline (displayResultForBox) when query results arrive.
	 */
	public displayResult(
		result: { columns?: { name: string; type?: string }[]; rows?: unknown[][]; metadata?: Record<string, unknown> },
		options?: { label?: string; showExecutionTime?: boolean },
	): void {
		this._executing = false;
		this._stopElapsedTimer();
		this._clearResultsStale();
		this._lastError = '';
		const columns: DataTableColumn[] = Array.isArray(result?.columns)
			? result.columns.map(c => {
				if (typeof c === 'string') return { name: c, type: '' };
				return { name: String(c?.name || c || ''), type: String(c?.type || '') };
			})
			: [];
		const rows = Array.isArray(result?.rows) ? result.rows : [];
		const metadata = (result?.metadata && typeof result.metadata === 'object') ? result.metadata : {};
		const rowCount = rows.length;
		const execTime = typeof metadata.executionTime === 'string' ? metadata.executionTime : '';

		const resultsBody = document.getElementById(this.boxId + '_sql_results_body');
		const resultsWrapper = document.getElementById(this.boxId + '_sql_results_wrapper');
		const resultsResizer = document.getElementById(this.boxId + '_sql_results_resizer');
		if (!resultsBody) return;

		resultsBody.innerHTML = '';
		this._hasResults = true;

		if (!columns.length && !rows.length) {
			resultsBody.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:var(--vscode-descriptionForeground)">No results</div>';
			if (resultsWrapper) { resultsWrapper.style.display = 'block'; resultsWrapper.style.height = ''; }
			return;
		}

		const dt = document.createElement('kw-data-table') as any;
		let initialBodyVisible = true;
		try {
			const m = pState.resultsVisibleByBoxId;
			if (m && m[this.boxId] === false) initialBodyVisible = false;
		} catch (e) { console.error('[kusto]', e); }

		dt.options = {
			label: options?.label || 'Results',
			showExecutionTime: options?.showExecutionTime !== false,
			executionTime: execTime,
			showSave: true,
			showVisibilityToggle: true,
			hideTopBorder: true,
			initialBodyVisible,
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
			} catch (e2) { console.error('[kusto]', e2); }
		});

		dt.addEventListener('visibility-toggle', (e: CustomEvent) => {
			const visible = e.detail?.visible ?? true;
			try {
				if (!pState.resultsVisibleByBoxId || typeof pState.resultsVisibleByBoxId !== 'object') {
					pState.resultsVisibleByBoxId = {};
				}
				pState.resultsVisibleByBoxId[this.boxId] = !!visible;
			} catch (e2) { console.error('[kusto]', e2); }
			if (resultsWrapper) {
				if (!visible) {
					const curH = resultsWrapper.style.height;
					if (curH && curH !== 'auto' && curH !== '48px') {
						resultsWrapper.dataset.kustoPreviousHeight = curH;
					}
					resultsWrapper.style.height = '48px';
					resultsWrapper.style.overflow = 'hidden';
				} else {
					const prev = resultsWrapper.dataset.kustoPreviousHeight;
					resultsWrapper.style.height = prev || '300px';
					resultsWrapper.style.overflow = '';
					delete resultsWrapper.dataset.kustoPreviousHeight;
				}
			}
			if (resultsResizer) resultsResizer.style.display = visible ? '' : 'none';
			this._hasResults = visible;
			try { schedulePersist(); } catch (e2) { console.error('[kusto]', e2); }
		});

		dt.addEventListener('chrome-height-change', (e: Event) => {
			if (!resultsWrapper) return;
			const curH = parseInt(resultsWrapper.style.height, 10);
			if (!curH || curH <= 40) return;
			const delta = (e as CustomEvent).detail?.delta ?? 0;
			if (delta === 0) return;
			// section-max-height: table content + 10px gap.
			let maxH = curH + delta;
			try {
				const contentH = typeof dt.getContentHeight === 'function' ? dt.getContentHeight() : 0;
				if (contentH > 0) maxH = contentH + 20;
			} catch (e2) { console.error('[kusto]', e2); }
			resultsWrapper.style.height = Math.max(120, Math.min(maxH, curH + delta)) + 'px';
		});

		resultsBody.appendChild(dt);

		if (resultsWrapper) {
			resultsWrapper.style.display = 'flex';
			if (!initialBodyVisible) {
				resultsWrapper.style.height = '48px';
				resultsWrapper.style.overflow = 'hidden';
				this._hasResults = false;
				if (resultsResizer) resultsResizer.style.display = 'none';
			} else if (!resultsWrapper.dataset.kustoUserResized) {
				const ROW_H = 27;
				const CHROME = 120;
				const MAX_AUTO_ROWS = 10;
				const MAX_AUTO_H = CHROME + (MAX_AUTO_ROWS * ROW_H);
				const estimatedH = CHROME + (rows.length * ROW_H);
				resultsWrapper.style.height = Math.max(120, Math.min(MAX_AUTO_H, estimatedH)) + 'px';
			}
		}

		if (resultsResizer) resultsResizer.style.display = initialBodyVisible ? '' : 'none';

		dt.style.display = 'flex';
		dt.style.flexDirection = 'column';
		dt.style.flex = '1 1 auto';
		dt.style.minHeight = '0';
		dt.style.height = '100%';

		// After the data-table renders, recalculate max-height using the full
		// section-max-height / FIT_CAP_PX logic documented in ARCHITECTURE.md.
		// Retry at 50ms, 150ms, and 300ms to account for data-table rendering latency.
		// Skip auto-fit when the user already persisted a custom results height.
		if (initialBodyVisible && !resultsWrapper?.dataset.kustoUserResized) {
			this._fitResultsToContents();
			setTimeout(() => this._fitResultsToContents(), 50);
			setTimeout(() => this._fitResultsToContents(), 150);
			setTimeout(() => this._fitResultsToContents(), 300);
		}
	}

	/**
	 * Called when the host reports an error for this boxId.
	 * Matches the duck-typed contract used by __kustoRenderErrorUx.
	 */
	public displayError(errorOrModel: unknown, _clientActivityId?: string): void {
		this._executing = false;
		this._stopElapsedTimer();
		this._clearResultsStale();

		// Extract a display string from the error. The error-renderer may pass a
		// pre-built ErrorUxModel ({ kind, message?, text?, pretty? }) or a raw string.
		let msg: string;
		if (typeof errorOrModel === 'string') {
			msg = errorOrModel;
		} else if (errorOrModel && typeof errorOrModel === 'object') {
			const m = errorOrModel as { message?: string; text?: string; pretty?: string; kind?: string };
			msg = m.message || m.text || m.pretty || String(errorOrModel);
		} else {
			msg = String(errorOrModel);
		}
		this._lastError = msg;

		const resultsBody = document.getElementById(this.boxId + '_sql_results_body');
		const resultsWrapper = document.getElementById(this.boxId + '_sql_results_wrapper');
		if (!resultsBody) return;

		resultsBody.innerHTML = '';
		this._hasResults = false;
		const errorDiv = document.createElement('div');
		errorDiv.style.cssText = 'padding:8px 12px;font-size:12px;color:var(--vscode-errorForeground);white-space:pre-wrap;word-break:break-word;';
		errorDiv.textContent = msg;
		resultsBody.appendChild(errorDiv);

		if (resultsWrapper) {
			resultsWrapper.style.display = 'block';
			resultsWrapper.style.height = '';
		}
	}

	// ── Execution ─────────────────────────────────────────────────────────────

	private _runQuery(): void {
		if (this._executing || !this._sqlConnectionId || !this._database) {
			return;
		}
		const query = this._getQueryText().trim();
		if (!query) {
			return;
		}
		this._executing = true;
		this._lastError = '';
		this._startElapsedTimer();
		postMessageToHost({
			type: 'executeSqlQuery',
			query,
			sqlConnectionId: this._sqlConnectionId,
			database: this._database,
			boxId: this.boxId,
			queryMode: getRunMode(this.boxId),
		});
	}

	// ── Run mode ──────────────────────────────────────────────────────────────

	private _getSqlRunModeLabel(): string {
		const mode = getRunMode(this.boxId);
		return getRunModeLabelText(mode === 'take100' ? 'top100' : mode);
	}

	private _toggleSqlRunMenu(): void {
		const menu = document.getElementById(this.boxId + '_sql_run_menu') as HTMLElement | null;
		if (!menu) return;
		const next = menu.style.display === 'block' ? 'none' : 'block';
		this._cleanupSqlRunMenuScrollDismiss();
		menu.style.display = next;
		if (next === 'block') {
			this._removeRunMenuScrollDismiss = registerPageScrollDismissable(() => this._closeSqlRunMenu(), {
				dismissOnWheel: true,
				shouldDismiss: ({ event, kind }) => kind !== 'wheel' || !menu.contains(event.target as Node),
			});
		}
	}

	private _closeSqlRunMenu(): void {
		this._cleanupSqlRunMenuScrollDismiss();
		const menu = document.getElementById(this.boxId + '_sql_run_menu') as HTMLElement | null;
		if (menu) menu.style.display = 'none';
	}

	private _cleanupSqlRunMenuScrollDismiss(): void {
		if (!this._removeRunMenuScrollDismiss) return;
		this._removeRunMenuScrollDismiss();
		this._removeRunMenuScrollDismiss = null;
	}

	private _applySqlRunMode(mode: string): void {
		setRunMode(this.boxId, mode);
		this._syncActionBar();
		try {
			this._closeSqlRunMenu();
		} catch (e) { console.error('[kusto]', e); }
		this._runQuery();
	}

	private _cancelQuery(): void {
		postMessageToHost({
			type: 'cancelSqlQuery',
			boxId: this.boxId,
		});
		this._executing = false;
		this._stopElapsedTimer();
	}

	private _startElapsedTimer(): void {
		this._stopElapsedTimer();
		this._elapsedStart = Date.now();
		this._elapsedText = '0:00';
		this._elapsedTimer = setInterval(() => {
			const elapsed = Math.floor((Date.now() - this._elapsedStart) / 1000);
			const mins = Math.floor(elapsed / 60);
			const secs = elapsed % 60;
			this._elapsedText = `${mins}:${secs.toString().padStart(2, '0')}`;
		}, 1000);
	}

	private _stopElapsedTimer(): void {
		if (this._elapsedTimer) {
			clearInterval(this._elapsedTimer);
			this._elapsedTimer = null;
		}
		this._elapsedText = '';
	}

	public setExpanded(expanded: boolean): void {
		this._expanded = expanded;
		if (expanded) {
			this.classList.remove('is-collapsed');
		} else {
			this.classList.add('is-collapsed');
		}
	}

	// ── Shell event handlers ──────────────────────────────────────────────────

	private _onShellNameChange(e: CustomEvent): void {
		this._name = e.detail?.name ?? '';
		try { schedulePersist(); } catch (e2) { console.error('[kusto]', e2); }
	}

	private _toggleVisibility(): void {
		this.setExpanded(!this._expanded);
		try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		if (this._expanded && this._editor) {
			requestAnimationFrame(() => {
				try { this._editor?.layout(); } catch { /* ignore */ }
			});
		}
	}

	/** Cap for fit-to-contents / double-click. Manual drag uses the full content-based max. */
	private static _FIT_CAP_PX = 400;

	/** Measure the non-editor chrome (toolbar) height inside the editor wrapper. */
	private _measureEditorChrome(): number {
		const wrapper = document.getElementById(this.boxId + '_sql_editor_wrapper');
		if (!wrapper) return 0;
		let chrome = 0;
		const toolbarEl = wrapper.querySelector('.query-editor-toolbar') || wrapper.querySelector('kw-sql-toolbar');
		if (toolbarEl) {
			try {
				const cs = getComputedStyle(toolbarEl as HTMLElement);
				if (cs.display !== 'none') {
					const h = (toolbarEl as HTMLElement).getBoundingClientRect().height || 0;
					const mt = parseFloat(cs.marginTop || '0') || 0;
					const mb = parseFloat(cs.marginBottom || '0') || 0;
					chrome += Math.ceil(h + mt + mb);
				}
			} catch { /* ignore */ }
		}
		return chrome;
	}

	/** Shell "Fit to contents" button: fit editor, and results only when visible. */
	private _onShellFitToContents(): void {
		this._fitToContents();
		let resultsVisible = true;
		try { const m = pState.resultsVisibleByBoxId; resultsVisible = !(m && m[this.boxId] === false); } catch (e) { console.error('[kusto]', e); }
		if (resultsVisible) {
			this._fitResultsToContents(true);
			setTimeout(() => this._fitResultsToContents(true), 50);
			setTimeout(() => this._fitResultsToContents(true), 150);
		}
	}

	/** Force-fit results — used for explicit user actions (double-click, toolbar). */
	private _forceFitResultsToContents(): void {
		this._fitResultsToContents(true);
	}

	private _fitToContents(): void {
		if (!this._editor) {
			return;
		}
		const wrapper = document.getElementById(this.boxId + '_sql_editor_wrapper');
		if (!wrapper) {
			return;
		}

		const contentHeight = this._editor.getContentHeight();

		const chrome = this._measureEditorChrome();

		const newH = Math.max(60, Math.min(chrome + contentHeight + 5, KwSqlSection._FIT_CAP_PX));
		wrapper.style.height = `${newH}px`;
		this._lastFitHeight = newH;
		this._savedEditorHeightPx = newH;
		this._userResizedEditor = true;

		requestAnimationFrame(() => {
			try { this._editor?.layout(); } catch { /* ignore */ }
		});
		try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	}

	// ── Resizer ───────────────────────────────────────────────────────────────

	private _onEditorResizerMouseDown(e: MouseEvent): void {
		e.preventDefault();
		const wrapper = document.getElementById(this.boxId + '_sql_editor_wrapper');
		if (!wrapper) {
			return;
		}

		const startY = e.clientY;
		const startHeight = wrapper.offsetHeight;

		const maxEditorH = KwSqlSection._FIT_CAP_PX;

		const onMouseMove = (ev: MouseEvent) => {
			const delta = ev.clientY - startY;
			const newH = Math.max(60, Math.min(maxEditorH, startHeight + delta));
			wrapper.style.height = `${newH}px`;
			this._userResizedEditor = true;
			this._savedEditorHeightPx = newH;
			try { this._editor?.layout(); } catch { /* ignore */ }
			maybeAutoScrollWhileDragging(ev.clientY);
		};

		const onMouseUp = () => {
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
			try { schedulePersist(); } catch (e2) { console.error('[kusto]', e2); }
		};

		document.addEventListener('mousemove', onMouseMove);
		document.addEventListener('mouseup', onMouseUp);
	}

	// ── Results resizer ───────────────────────────────────────────────────────

	private _onResultsResizerMouseDown(e: MouseEvent): void {
		e.preventDefault();
		const wrapper = document.getElementById(this.boxId + '_sql_results_wrapper');
		if (!wrapper) return;

		const startY = e.clientY;
		const startHeight = wrapper.offsetHeight;

		// section-max-height: table content + 10px CSS gap. Manual drag cannot exceed it.
		let maxHeight = Infinity;
		try {
			const dt = wrapper.querySelector('kw-data-table') as any;
			if (dt && typeof dt.getContentHeight === 'function') {
				const contentH = dt.getContentHeight();
				if (contentH > 0) {
					maxHeight = contentH + 20;
				}
			}
		} catch (e2) { console.error('[kusto]', e2); }

		const onMouseMove = (ev: MouseEvent) => {
			const delta = ev.clientY - startY;
			const newH = Math.max(80, Math.min(maxHeight, startHeight + delta));
			wrapper.style.height = `${newH}px`;
			wrapper.dataset.kustoUserResized = 'true';
			maybeAutoScrollWhileDragging(ev.clientY);
		};

		const onMouseUp = () => {
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
			try { schedulePersist(); } catch (e2) { console.error('[kusto]', e2); }
		};

		document.addEventListener('mousemove', onMouseMove);
		document.addEventListener('mouseup', onMouseUp);
	}

	private _fitResultsToContents(force?: boolean): void {
		const wrapper = document.getElementById(this.boxId + '_sql_results_wrapper');
		const dt = wrapper?.querySelector('kw-data-table') as any;
		if (!wrapper || !dt || typeof dt.getContentHeight !== 'function') return;
		const contentH = dt.getContentHeight();
		if (contentH > 0) {
			const sectionMaxH = contentH + 20;
			wrapper.style.height = Math.max(120, Math.min(KwSqlSection._FIT_CAP_PX, sectionMaxH)) + 'px';
			wrapper.dataset.kustoUserResized = 'true';
		}
		try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	}

	/** After section reorder (disconnect/reconnect), refresh kw-data-table layout. */
	private _refreshResultsTableLayoutSoon(): void {
		requestAnimationFrame(() => {
			try {
				const body = document.getElementById(this.boxId + '_sql_results_body');
				const dt = body?.querySelector('kw-data-table') as any;
				if (dt && typeof dt.refreshLayout === 'function') dt.refreshLayout();
			} catch (e) { console.error('[kusto]', e); }
		});
	}
}
