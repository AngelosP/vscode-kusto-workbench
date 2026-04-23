import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { styles } from './kw-cached-values.styles.js';
import { scrollbarSheet } from '../../shared/scrollbar-styles.js';
import { osStyles } from '../../shared/os-styles.js';
import { OverlayScrollbarsController } from '../../components/overlay-scrollbars.controller.js';
import { ICONS, iconRegistryStyles } from '../../shared/icon-registry.js';
import { sashSheet } from '../../shared/sash-styles.js';
import { customElement, state, query } from 'lit/decorators.js';
import type { KwObjectViewer } from '../../components/kw-object-viewer.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthSession {
	sessionId?: string;
	account: { id: string; label: string };
	scopes: string[];
	accessToken?: string;
	effectiveToken: string;
	overrideToken?: string;
}

interface StoredAuthAccount {
	id: string;
	label: string;
	lastUsedAt: number;
}

interface Snapshot {
	timestamp: number;
	activeKind: 'kusto' | 'sql';
	auth: {
		sessions: AuthSession[];
		knownAccounts: StoredAuthAccount[];
		clusterAccountMap: Record<string, string>;
	};
	connections: Array<{ id: string; name: string; clusterUrl: string }>;
	cachedDatabases: Record<string, string[]>;
	sqlAuth: {
		sessions: Array<{
			account: { id: string; label: string };
			accessToken?: string;
			effectiveToken: string;
			overrideToken?: string;
		}>;
	};
	sqlConnections: Array<{ id: string; name: string; serverUrl: string; authType: string }>;
	sqlCachedDatabases: Record<string, string[]>;
	sqlServerAccountMap: Record<string, string>;
	cachedSchemaKeys: string[];
}

interface VsCodeApi {
	postMessage(msg: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(s: unknown): string {
	let str = s !== null && s !== undefined ? String(s) : '';
	str = str.replace(/&/g, '&amp;');
	str = str.replace(/</g, '&lt;');
	str = str.replace(/>/g, '&gt;');
	str = str.replace(/"/g, '&quot;');
	str = str.replace(/'/g, '&#39;');
	return str;
}

function shortClusterName(host: string): string {
	let s = String(host || '').trim();
	const suffix = '.kusto.windows.net';
	const lower = s.toLowerCase();
	if (lower.length >= suffix.length && lower.lastIndexOf(suffix) === (lower.length - suffix.length)) {
		s = s.slice(0, s.length - suffix.length);
	}
	return s || String(host || '');
}

function shortClusterEndpoint(clusterEndpoint: string): string {
	let s = String(clusterEndpoint || '');
	const lower = s.toLowerCase();
	if (lower.indexOf('https://') === 0) {
		s = s.slice(8);
	} else if (lower.indexOf('http://') === 0) {
		s = s.slice(7);
	}
	const slashIdx = s.indexOf('/');
	if (slashIdx >= 0) s = s.slice(0, slashIdx);
	const colonIdx = s.indexOf(':');
	if (colonIdx >= 0) s = s.slice(0, colonIdx);
	const suffix = '.kusto.windows.net';
	const sLower = s.toLowerCase();
	if (sLower.length >= suffix.length && sLower.lastIndexOf(suffix) === (sLower.length - suffix.length)) {
		s = s.slice(0, s.length - suffix.length);
	}
	return s || String(clusterEndpoint || '');
}

function getClusterLabelMap(connections: Array<{ clusterUrl: string; name?: string }>): Record<string, string> {
	const labelByCluster: Record<string, string> = {};
	for (const c of connections) {
		try {
			if (c && c.clusterUrl) {
				const raw = String(c.clusterUrl || '');
				let u = raw;
				if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
				let host = '';
				try {
					host = String(new URL(u).hostname || '').trim().toLowerCase();
				} catch {
					host = String(raw || '').trim().toLowerCase();
				}
				if (host && !labelByCluster[host]) {
					labelByCluster[host] = String(c.clusterUrl || host);
				}
			}
		} catch (e) { console.error('[kusto]', e); }
	}
	return labelByCluster;
}

function shortServerName(serverUrl: string): string {
	let s = String(serverUrl || '').trim();
	const suffix = '.database.windows.net';
	const lower = s.toLowerCase();
	if (lower.length >= suffix.length && lower.lastIndexOf(suffix) === (lower.length - suffix.length)) {
		s = s.slice(0, s.length - suffix.length);
	}
	return s || String(serverUrl || '');
}

/** Group SQL cached databases (keyed by connectionId) into a server-keyed map, using connection metadata for labelling. */
function groupSqlDatabasesByServer(
	sqlCachedDatabases: Record<string, string[]>,
	sqlConnections: Array<{ id: string; serverUrl: string }>,
): { byServer: Record<string, { connectionIds: string[]; databases: string[] }>; serverOrder: string[] } {
	const connById = new Map(sqlConnections.map(c => [c.id, c]));
	const byServer: Record<string, { connectionIds: string[]; databases: string[] }> = {};
	for (const [connId, dbs] of Object.entries(sqlCachedDatabases)) {
		const conn = connById.get(connId);
		const serverUrl = conn ? conn.serverUrl : connId;
		if (!byServer[serverUrl]) {
			byServer[serverUrl] = { connectionIds: [], databases: [] };
		}
		const existing = byServer[serverUrl];
		if (!existing.connectionIds.includes(connId)) existing.connectionIds.push(connId);
		const seen = new Set(existing.databases.map(d => d.toLowerCase()));
		for (const db of dbs) {
			const lower = db.toLowerCase();
			if (!seen.has(lower)) { seen.add(lower); existing.databases.push(db); }
		}
	}
	const serverOrder = Object.keys(byServer);
	serverOrder.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	return { byServer, serverOrder };
}

// ─── Change-detection keys (replicate original behavior) ─────────────────────

function buildAccountsKey(snapshot: Snapshot): string {
	const auth = snapshot?.auth ?? { knownAccounts: [], sessions: [] };
	const known = Array.isArray(auth.knownAccounts) ? auth.knownAccounts : [];
	const sessions = Array.isArray(auth.sessions) ? auth.sessions : [];
	const map: Record<string, string> = {};
	for (const a of known) {
		if (a?.id) map[String(a.id)] = String(a.label || a.id);
	}
	for (const s of sessions) {
		const acc = s?.account;
		if (acc?.id && !map[String(acc.id)]) {
			map[String(acc.id)] = String(acc.label || acc.id);
		}
	}
	const ids = Object.keys(map);
	ids.sort();
	return ids.map(id => id + '=' + map[id]).join('|');
}

function buildAuthKey(snapshot: Snapshot, accountsKey: string): string {
	const sessions = Array.isArray(snapshot?.auth?.sessions) ? snapshot.auth.sessions : [];
	const ids: string[] = [];
	const byId: Record<string, string> = {};
	for (const s of sessions) {
		const acc = s?.account;
		if (acc?.id) {
			const id = String(acc.id);
			ids.push(id);
			byId[id] = s?.overrideToken ? String(s.overrideToken) : '';
		}
	}
	ids.sort();
	const parts = ['accounts=' + String(accountsKey || '')];
	for (const id of ids) parts.push(id + ':ov=' + (byId[id] || ''));
	return parts.join('|');
}

function buildClusterKey(snapshot: Snapshot, accountsKey: string): string {
	const map = snapshot?.auth?.clusterAccountMap && typeof snapshot.auth.clusterAccountMap === 'object' ? snapshot.auth.clusterAccountMap : {};
	const clusters = Object.keys(map);
	clusters.sort();
	const parts = ['accounts=' + String(accountsKey || '')];
	for (const c of clusters) parts.push(String(c) + '=' + String(map[c] || ''));
	return parts.join('|');
}

function buildDbKey(snapshot: Snapshot): string {
	const cached = snapshot?.cachedDatabases && typeof snapshot.cachedDatabases === 'object' ? snapshot.cachedDatabases : {};
	const clusterKeys = Object.keys(cached);
	clusterKeys.sort();
	const labelByCluster = getClusterLabelMap(Array.isArray(snapshot?.connections) ? snapshot.connections : []);
	const parts: string[] = [];
	for (const id of clusterKeys) {
		const list = Array.isArray(cached[id]) ? cached[id] : [];
		parts.push(id + ':' + (labelByCluster[id] || '') + ':' + list.join(String.fromCharCode(31)));
	}
	return parts.join(String.fromCharCode(30));
}

// ─── Component ────────────────────────────────────────────────────────────────

@customElement('kw-cached-values')
export class KwCachedValues extends LitElement {
	private _osCtrl = new OverlayScrollbarsController(this);

	// ── Reactive state ────────────────────────────────────────────────────────

	@state() private _snapshot: Snapshot | null = null;
	@state() private _activeKind: 'kusto' | 'sql' = 'kusto';
	@state() private _selectedDbClusterKey = '';
	@state() private _selectedSqlServerKey = '';
	@state() private _schemaRequestInFlight = false;
	/** Database currently being refreshed (for spinner feedback). */
	@state() private _sqlSchemaRefreshDb = '';
	/** Kusto database currently being refreshed (for spinner feedback). */
	@state() private _kustoSchemaRefreshDb = '';
	/** Set of account IDs whose override input is expanded. */
	@state() private _expandedOverrides = new Set<string>();

	@query('kw-object-viewer') private _objectViewer!: KwObjectViewer;

	// ── Change-detection keys (replicate original renderAll logic) ─────────

	private _lastAccountsKey = '';
	private _lastAuthKey = '';
	private _lastClusterKey = '';
	private _lastDbKey = '';

	// ── VS Code API bridge ────────────────────────────────────────────────────

	private _vscode!: VsCodeApi;
	private _requestPending = false;

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	connectedCallback(): void {
		super.connectedCallback();
		this._vscode = acquireVsCodeApi();
		window.addEventListener('message', this._onMessage);
		this._requestSnapshot();
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		window.removeEventListener('message', this._onMessage);
	}

	// ── Message handling ──────────────────────────────────────────────────────

	private _onMessage = async (event: MessageEvent) => {
		const msg = event.data;
		if (msg?.type === 'snapshot') {
			this._requestPending = false;
			const snap = msg.snapshot as Snapshot;
			this._snapshot = snap;

			// Auto-detect active kind from persisted value + available data (same logic as Connection Manager)
			if (snap) {
				const hasKusto = (snap.connections?.length ?? 0) > 0 || (snap.auth?.sessions?.length ?? 0) > 0;
				const hasSql = (snap.sqlConnections?.length ?? 0) > 0;
				const persisted = snap.activeKind;
				if (persisted === 'sql' && hasSql) this._activeKind = 'sql';
				else if (persisted === 'kusto' && hasKusto) this._activeKind = 'kusto';
				else if (hasSql && !hasKusto) this._activeKind = 'sql';
				else this._activeKind = 'kusto';
			}
		}
		if (msg?.type === 'schemaResult') {
			this._schemaRequestInFlight = false;
			this._sqlSchemaRefreshDb = '';
			this._kustoSchemaRefreshDb = '';
			const db = String(msg.database || '');
			const title = 'Cached schema for ' + (db || '(unknown db)');
			const jsonText = String(msg.json || '');
			// Wait for the component to be available in the shadow DOM
			await this.updateComplete;
			if (this._objectViewer) {
				this._objectViewer.copyCallback = (msg: unknown) => this._vscode.postMessage(msg);
				this._objectViewer.show(title, jsonText);
			}
		}
	};

	private _requestSnapshot(): void {
		if (this._requestPending) return;
		try {
			if (document.visibilityState !== 'visible') return;
		} catch (e) { console.error('[kusto]', e); }
		this._requestPending = true;
		this._vscode.postMessage({ type: 'requestSnapshot' });
	}

	// ── Render ────────────────────────────────────────────────────────────────

	protected render(): TemplateResult {
		const snap = this._snapshot;
		const timestamp = snap ? new Date(snap.timestamp).toLocaleString() : 'Loading…';
		const kind = this._activeKind;
		const kustoCount = snap ? (snap.connections?.length ?? 0) : 0;
		const sqlCount = snap ? (snap.sqlConnections?.length ?? 0) : 0;

		return html`
			<h1 data-testid="cv-title">Cached Values</h1>
			<div class="small" style="display:flex;align-items:center;gap:6px;">Last updated: ${timestamp}
				<button class="iconButton" data-testid="cv-refresh" title="Refresh" aria-label="Refresh"
					@click=${() => this._requestSnapshot()}
					?disabled=${this._requestPending}>
					${ICONS.refresh}
				</button>
			</div>

			<!-- Type selector -->
			<kw-kind-picker
				data-testid="cv-kind-picker"
				.activeKind=${kind}
				.kustoCount=${kustoCount}
				.sqlCount=${sqlCount}
				@kind-changed=${(e: CustomEvent) => this._switchKind(e.detail.kind)}
			></kw-kind-picker>

			${kind === 'kusto' ? this._renderKustoContent() : this._renderSqlContent()}

			<kw-object-viewer></kw-object-viewer>
		`;
	}

	private _switchKind(kind: 'kusto' | 'sql'): void {
		if (kind === this._activeKind) return;
		this._activeKind = kind;
		this._vscode.postMessage({ type: 'setActiveKind', kind });
	}

	// ── Kusto content (existing sections) ────────────────────────────────────

	private _renderKustoContent(): TemplateResult {
		return html`
			<section>
				<header>
					<div>
						<div><strong>Cached authentication tokens</strong></div>
						<div class="small">Shows VS Code auth sessions for Kusto scope, plus optional token overrides.</div>
					</div>
				</header>
				<div class="sectionBody">${this._renderAuth()}</div>
			</section>

			<section>
				<header>
					<div>
						<div><strong>Cached associations of clusters to authentication accounts</strong></div>
						<div class="small">Cluster → preferred account mapping (auth preference cache).</div>
					</div>
				</header>
				<div class="sectionBody">${this._renderClusterMap()}</div>
			</section>

			<section class="dbSection">
				<header>
					<div>
						<div><strong>Cached list of databases (per cluster)</strong></div>
						<div class="small">Select a cluster on the left to view its cached databases.</div>
					</div>
					<div class="rowActions">
						<button class="iconButton" type="button" title="clear all cached schema data" aria-label="clear all cached schema data"
							@click=${this._onSchemaClearAll}>
							${ICONS.trash}
						</button>
					</div>
				</header>
				<div class="sectionBody" id="dbContent">${this._renderDatabases()}</div>
			</section>
		`;
	}

	// ── Auth section ──────────────────────────────────────────────────────────

	private _renderAuth(): TemplateResult | typeof nothing {
		const snap = this._snapshot;
		if (!snap) return nothing;
		const sessions = Array.isArray(snap.auth?.sessions) ? snap.auth.sessions : [];
		if (sessions.length === 0) {
			return html`<div class="small">No cached Kusto auth sessions found.</div>`;
		}
		return html`
			<div class="authCards">
				${sessions.map(s => this._renderAuthRow(s))}
			</div>
		`;
	}

	private _renderAuthRow(session: AuthSession): TemplateResult {
		const account = session.account ?? { id: '', label: '' };
		const overrideVal = session.overrideToken ? String(session.overrideToken) : '';
		const hasOverride = !!overrideVal;
		const isExpanded = this._expandedOverrides.has(account.id);
		return html`
			<div class="authCard">
				<div class="authCardRow">
					${hasOverride ? html`<div class="overrideDot" title="Token override active"></div>` : nothing}
					<div class="authCardInfo">
						<div class="authCardLabel">${account.label}</div>
						<div class="authCardId" title="${account.id}">${account.id}</div>
					</div>
					<div class="authCardActions">
						<button class="iconButton" title="Copy effective token" aria-label="Copy effective token"
							@click=${() => this._copyToken(account.id)}>
							${ICONS.copy}
						</button>
						<button class="iconButton" title="${isExpanded ? 'Hide override' : 'Set token override'}" aria-label="Toggle override"
							@click=${() => this._toggleOverride(account.id)}>
							${ICONS.edit}
						</button>
						${hasOverride ? html`
							<button class="iconButton" title="Clear override" aria-label="Clear override"
								@click=${() => this._clearOverride(account.id)}>
								${ICONS.trash}
							</button>
						` : nothing}
					</div>
				</div>
				${isExpanded ? html`
					<div class="authOverrideRow">
						<span class="overrideLabel">Override</span>
						<input type="text" data-override-for="${account.id}"
							placeholder="Paste token to override"
							.value=${overrideVal}
							@keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') this._saveOverride(account.id); }} />
						<button class="iconButton" title="Save override" aria-label="Save override"
							@click=${() => this._saveOverride(account.id)}>
							${ICONS.save}
						</button>
					</div>
				` : nothing}
			</div>
		`;
	}

	// ── Cluster Map section ───────────────────────────────────────────────────

	private _renderClusterMap(): TemplateResult | typeof nothing {
		const snap = this._snapshot;
		if (!snap) return nothing;
		const map = snap.auth?.clusterAccountMap && typeof snap.auth.clusterAccountMap === 'object' ? snap.auth.clusterAccountMap : {};
		const clusters = Object.keys(map);
		if (clusters.length === 0) {
			return html`<div class="small">No cached cluster/account mapping.</div>`;
		}

		// Build unique accounts list.
		const accountsById = new Map<string, { id: string; label: string }>();
		const known = Array.isArray(snap.auth?.knownAccounts) ? snap.auth.knownAccounts : [];
		const sessions = Array.isArray(snap.auth?.sessions) ? snap.auth.sessions : [];
		for (const a of known) {
			if (a?.id) accountsById.set(a.id, { id: a.id, label: a.label || a.id });
		}
		for (const s of sessions) {
			if (s?.account?.id && !accountsById.has(s.account.id)) {
				accountsById.set(s.account.id, { id: s.account.id, label: s.account.label || s.account.id });
			}
		}
		// Ensure current values appear even if not in known list.
		for (const cluster of clusters) {
			const accountId = map[cluster] ? String(map[cluster]) : '';
			if (accountId && !accountsById.has(accountId)) {
				accountsById.set(accountId, { id: accountId, label: accountId });
			}
		}
		const accounts = [...accountsById.values()];

		return html`
			<table>
				<thead><tr>
					<th>Cluster</th>
					<th>Account</th>
				</tr></thead>
				<tbody>
					${clusters.map(cluster => html`
						<tr>
							<td class="mono" title="${cluster}">${shortClusterEndpoint(cluster)}</td>
							<td>
								<div class="select-wrapper" title="Select account">
									<select @change=${(e: Event) => this._onClusterAccountChange(cluster, e)}>
										<option value="">(none)</option>
										${accounts.map(a => html`
											<option value="${a.id}" ?selected=${a.id === map[cluster]}>${a.label}</option>
										`)}
									</select>
								</div>
							</td>
						</tr>
					`)}
				</tbody>
			</table>
		`;
	}

	// ── Databases section ─────────────────────────────────────────────────────

	private _renderDatabases(): TemplateResult | typeof nothing {
		const snap = this._snapshot;
		if (!snap) return nothing;
		const cached = snap.cachedDatabases && typeof snap.cachedDatabases === 'object' ? snap.cachedDatabases : {};
		const clusterKeys = Object.keys(cached);
		clusterKeys.sort();
		if (clusterKeys.length === 0) {
			return html`<div class="small">No cached database lists.</div>`;
		}

		const labelByCluster = getClusterLabelMap(Array.isArray(snap.connections) ? snap.connections : []);

		// Ensure selection is stable.
		let selected = this._selectedDbClusterKey;
		if (!selected || !clusterKeys.includes(selected)) {
			selected = clusterKeys[0];
			this._selectedDbClusterKey = selected;
		}

		const selectedList = Array.isArray(cached[selected]) ? cached[selected] : [];
		const selectedTitle = labelByCluster[selected] || selected;

		return html`
			<div class="twoPane">
				<div class="pane listPane list scrollPane" data-overlay-scroll="x:hidden" tabindex="0" role="listbox" aria-label="Clusters"
					@keydown=${this._onDbListKeydown}>
					${clusterKeys.map(ck => {
						const list = Array.isArray(cached[ck]) ? cached[ck] : [];
						const title = labelByCluster[ck] || ck;
						const isSelected = ck === selected;
						return html`
							<div class="listItem ${isSelected ? 'selected' : ''}"
								@click=${() => this._selectDbCluster(ck)}>
								<div class="listItemName" title="${title}">${shortClusterName(ck)}</div>
								<div class="count">${list.length}</div>
							</div>`;
					})}
				</div>
				<div class="resizer-v" @mousedown=${this._onSplitterMouseDown}></div>
				<div class="pane detailPane scrollPane" data-overlay-scroll="x:hidden" tabindex="0" aria-label="Databases">
					<div style="padding:10px;">
						<div class="dbDetailHeader">
							<div class="detailUrl" title="${selectedTitle}">${selectedTitle}</div>
							<div class="rowActions">
								<button class="iconButton" title="Refresh the list of cached databases for selected cluster" aria-label="Refresh the list of cached databases for selected cluster"
									@click=${() => this._refreshDatabases(selected)}>
									${ICONS.refresh}
								</button>
								<button class="iconButton" title="Delete the list of cached databases for the selected cluster" aria-label="Delete the list of cached databases for the selected cluster"
									@click=${() => this._deleteDatabases(selected)}>
									${ICONS.trash}
								</button>
							</div>
						</div>
						<div class="dbList">
							${selectedList.filter(Boolean).map(db => {
								const isRefreshing = this._kustoSchemaRefreshDb === String(db);
								const hasCachedSchema = snap.cachedSchemaKeys?.includes(`kusto:${selected}|${db}`);
								return html`
								<div class="dbItem">
									<span class="dbIcon">${ICONS.database}</span>
									${hasCachedSchema
										? html`<button class="linkButton mono" title="View cached schema JSON"
											@click=${() => this._viewSchema(selected, String(db))}>${db}</button>`
										: html`<span class="dbName" title="No cached schema">${db}</span>`
									}
									<div class="dbActions">
										<button class="iconButton${isRefreshing ? ' spinning' : ''}" title="Refresh schema for ${db}" aria-label="Refresh schema for ${db}"
											?disabled=${isRefreshing}
											@click=${() => this._refreshKustoSchema(selected, String(db))}>
											${ICONS.refresh}
										</button>
									</div>
								</div>`;
							})}
						</div>
					</div>
				</div>
			</div>
		`;
	}

	// ── SQL content ──────────────────────────────────────────────────────────

	private _renderSqlContent(): TemplateResult {
		return html`
			<section>
				<header>
					<div>
						<div><strong>Cached SQL authentication tokens</strong></div>
						<div class="small">Shows VS Code auth sessions for the Azure SQL scope (AAD only).</div>
					</div>
				</header>
				<div class="sectionBody">${this._renderSqlAuth()}</div>
			</section>

			<section>
				<header>
					<div>
						<div><strong>Cached associations of servers to authentication</strong></div>
						<div class="small">Server → authentication method (AAD account or SQL Login).</div>
					</div>
				</header>
				<div class="sectionBody">${this._renderSqlServerMap()}</div>
			</section>

			<section class="dbSection">
				<header>
					<div>
						<div><strong>Cached list of databases (per server)</strong></div>
						<div class="small">Select a server on the left to view its cached databases.</div>
					</div>
					<div class="rowActions">
						<button class="iconButton" type="button" title="clear all cached SQL schema data" aria-label="clear all cached SQL schema data"
							@click=${this._onSqlSchemaClearAll}>
							${ICONS.trash}
						</button>
					</div>
				</header>
				<div class="sectionBody" id="sqlDbContent">${this._renderSqlDatabases()}</div>
			</section>
		`;
	}

	private _renderSqlAuth(): TemplateResult | typeof nothing {
		const snap = this._snapshot;
		if (!snap) return nothing;
		const sessions = Array.isArray(snap.sqlAuth?.sessions) ? snap.sqlAuth.sessions : [];
		if (sessions.length === 0) {
			return html`<div class="small">No cached SQL AAD auth sessions found.</div>`;
		}
		return html`
			<div class="authCards">
				${sessions.map(s => this._renderSqlAuthRow(s))}
			</div>
		`;
	}

	private _renderSqlAuthRow(session: { account: { id: string; label: string }; accessToken?: string; overrideToken?: string }): TemplateResult {
		const account = session.account ?? { id: '', label: '' };
		const overrideVal = session.overrideToken ? String(session.overrideToken) : '';
		const hasOverride = !!overrideVal;
		const isExpanded = this._expandedOverrides.has('sql:' + account.id);
		return html`
			<div class="authCard">
				<div class="authCardRow">
					${hasOverride ? html`<div class="overrideDot" title="Token override active"></div>` : nothing}
					<div class="authCardInfo">
						<div class="authCardLabel">${account.label}</div>
						<div class="authCardId" title="${account.id}">${account.id}</div>
					</div>
					<div class="authCardActions">
						<button class="iconButton" title="Copy effective token" aria-label="Copy effective token"
							@click=${() => this._copySqlToken(account.id)}>
							${ICONS.copy}
						</button>
						<button class="iconButton" title="${isExpanded ? 'Hide override' : 'Set token override'}" aria-label="Toggle override"
							@click=${() => this._toggleOverride('sql:' + account.id)}>
							${ICONS.edit}
						</button>
						${hasOverride ? html`
							<button class="iconButton" title="Clear override" aria-label="Clear override"
								@click=${() => this._clearSqlOverride(account.id)}>
								${ICONS.trash}
							</button>
						` : nothing}
					</div>
				</div>
				${isExpanded ? html`
					<div class="authOverrideRow">
						<span class="overrideLabel">Override</span>
						<input type="text" data-sql-override-for="${account.id}"
							placeholder="Paste token to override"
							.value=${overrideVal}
							@keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') this._saveSqlOverride(account.id); }} />
						<button class="iconButton" title="Save override" aria-label="Save override"
							@click=${() => this._saveSqlOverride(account.id)}>
							${ICONS.save}
						</button>
					</div>
				` : nothing}
			</div>
		`;
	}

	private _renderSqlServerMap(): TemplateResult | typeof nothing {
		const snap = this._snapshot;
		if (!snap) return nothing;
		const conns = Array.isArray(snap.sqlConnections) ? snap.sqlConnections : [];
		if (conns.length === 0) {
			return html`<div class="small">No SQL connections configured.</div>`;
		}

		// Group by server URL — show one row per unique server
		const serverMap = this.readSqlServerAccountMap();
		const seen = new Set<string>();
		const rows: Array<{ serverUrl: string; authType: string; connectionId: string }> = [];
		for (const c of conns) {
			const serverLower = c.serverUrl.toLowerCase();
			if (seen.has(serverLower)) continue;
			seen.add(serverLower);
			rows.push({ serverUrl: c.serverUrl, authType: c.authType, connectionId: c.id });
		}

		// Build accounts list for AAD dropdowns
		const accountsById = new Map<string, { id: string; label: string }>();
		const known = Array.isArray(snap.auth?.knownAccounts) ? snap.auth.knownAccounts : [];
		const sessions = Array.isArray(snap.auth?.sessions) ? snap.auth.sessions : [];
		const sqlSessions = Array.isArray(snap.sqlAuth?.sessions) ? snap.sqlAuth.sessions : [];
		for (const a of known) { if (a?.id) accountsById.set(a.id, { id: a.id, label: a.label || a.id }); }
		for (const s of sessions) { if (s?.account?.id && !accountsById.has(s.account.id)) accountsById.set(s.account.id, { id: s.account.id, label: s.account.label || s.account.id }); }
		for (const s of sqlSessions) { if (s?.account?.id && !accountsById.has(s.account.id)) accountsById.set(s.account.id, { id: s.account.id, label: s.account.label || s.account.id }); }
		const accounts = [...accountsById.values()];

		// For AAD connections, if no explicit serverMap entry, auto-detect from SQL AAD sessions
		const effectiveServerMap: Record<string, string> = { ...serverMap };
		for (const row of rows) {
			if (row.authType === 'aad' && !effectiveServerMap[row.serverUrl] && sqlSessions.length > 0) {
				effectiveServerMap[row.serverUrl] = sqlSessions[0].account?.id ?? '';
			}
		}

		return html`
			<table>
				<thead><tr>
					<th>Server</th>
					<th>Authentication</th>
				</tr></thead>
				<tbody>
					${rows.map(row => html`
						<tr>
							<td class="mono" title="${row.serverUrl}">${shortServerName(row.serverUrl)}</td>
							<td>
								${row.authType === 'aad' ? html`
									<div class="select-wrapper" title="Select account">
										<select @change=${(e: Event) => this._onSqlServerAccountChange(row.serverUrl, e)}>
											<option value="">(none)</option>
											${accounts.map(a => html`
												<option value="${a.id}" ?selected=${a.id === effectiveServerMap[row.serverUrl]}>${a.label}</option>
											`)}
										</select>
									</div>
								` : html`
									<button class="linkButton" title="Edit connection" @click=${() => this._editSqlConnection(row.connectionId)}>SQL authentication</button>
								`}
							</td>
						</tr>
					`)}
				</tbody>
			</table>
		`;
	}

	private _renderSqlDatabases(): TemplateResult | typeof nothing {
		const snap = this._snapshot;
		if (!snap) return nothing;
		const sqlCached = snap.sqlCachedDatabases && typeof snap.sqlCachedDatabases === 'object' ? snap.sqlCachedDatabases : {};
		const sqlConns = Array.isArray(snap.sqlConnections) ? snap.sqlConnections : [];
		const { byServer, serverOrder } = groupSqlDatabasesByServer(sqlCached, sqlConns);

		if (serverOrder.length === 0) {
			return html`<div class="small">No cached database lists.</div>`;
		}

		// Ensure selection is stable
		let selected = this._selectedSqlServerKey;
		if (!selected || !serverOrder.includes(selected)) {
			selected = serverOrder[0];
			this._selectedSqlServerKey = selected;
		}

		const entry = byServer[selected];
		const selectedList = entry ? entry.databases : [];
		const selectedConnIds = entry ? entry.connectionIds : [];

		return html`
			<div class="twoPane">
				<div class="pane listPane list scrollPane" data-overlay-scroll="x:hidden" tabindex="0" role="listbox" aria-label="Servers"
					@keydown=${this._onSqlDbListKeydown}>
					${serverOrder.map(srv => {
						const e = byServer[srv];
						const isSelected = srv === selected;
						return html`
							<div class="listItem ${isSelected ? 'selected' : ''}"
								@click=${() => this._selectSqlServer(srv)}>
								<div class="listItemName" title="${srv}">${shortServerName(srv)}</div>
								<div class="count">${e.databases.length}</div>
							</div>`;
					})}
				</div>
				<div class="resizer-v" @mousedown=${this._onSplitterMouseDown}></div>
				<div class="pane detailPane scrollPane" data-overlay-scroll="x:hidden" tabindex="0" aria-label="Databases">
					<div style="padding:10px;">
						<div class="dbDetailHeader">
							<div class="detailUrl" title="${selected}">${selected}</div>
							<div class="rowActions">
								<button class="iconButton" title="Refresh the list of cached databases for selected server" aria-label="Refresh the list of cached databases for selected server"
									@click=${() => { for (const cid of selectedConnIds) this._refreshSqlDatabases(cid); }}>
									${ICONS.refresh}
								</button>
								<button class="iconButton" title="Delete the list of cached databases for the selected server" aria-label="Delete the list of cached databases for the selected server"
									@click=${() => { for (const cid of selectedConnIds) this._deleteSqlDatabases(cid); }}>
									${ICONS.trash}
								</button>
							</div>
						</div>
						<div class="dbList">
							${selectedList.filter(Boolean).map(db => {
								const isRefreshing = this._sqlSchemaRefreshDb === String(db);
								const hasCachedSchema = snap.cachedSchemaKeys?.includes(`sql:${selected}|${db}`);
								return html`
								<div class="dbItem">
									<span class="dbIcon">${ICONS.database}</span>
									${hasCachedSchema
										? html`<button class="linkButton mono" title="View cached SQL schema"
											@click=${() => this._viewSqlSchema(selected, String(db))}>${db}</button>`
										: html`<span class="dbName" title="No cached schema">${db}</span>`
									}
									<div class="dbActions">
										<button class="iconButton${isRefreshing ? ' spinning' : ''}" title="Refresh schema for ${db}" aria-label="Refresh schema for ${db}"
											?disabled=${isRefreshing}
											@click=${() => this._refreshSqlSchema(selected, String(db), selectedConnIds[0] ?? '')}>
											${ICONS.refresh}
										</button>
									</div>
								</div>`;
							})}
						</div>
					</div>
				</div>
			</div>
		`;
	}

	// ── Event handlers ────────────────────────────────────────────────────────

	private _toggleOverride(key: string): void {
		const next = new Set(this._expandedOverrides);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		this._expandedOverrides = next;
	}

	private _copyToken(accountId: string): void {
		const snap = this._snapshot;
		let token = '';
		if (snap?.auth?.sessions) {
			for (const s of snap.auth.sessions) {
				if (s?.account?.id === accountId) {
					token = String(s.effectiveToken || '');
					break;
				}
			}
		}
		this._vscode.postMessage({ type: 'copyToClipboard', text: token });
	}

	private _clearOverride(accountId: string): void {
		this._vscode.postMessage({ type: 'auth.clearTokenOverride', accountId });
		this._requestSnapshot();
	}

	private _saveOverride(accountId: string): void {
		const el = this.shadowRoot?.querySelector(`input[data-override-for="${CSS.escape(accountId)}"]`) as HTMLInputElement | null;
		const token = el?.value ?? '';
		this._vscode.postMessage({ type: 'auth.setTokenOverride', accountId, token });
		this._requestSnapshot();
	}

	private _onSchemaClearAll(): void {
		this._vscode.postMessage({ type: 'schema.clearAll' });
		this._requestSnapshot();
	}

	private _onClusterAccountChange(clusterEndpoint: string, e: Event): void {
		const target = e.target as HTMLSelectElement;
		const accountId = target.value;
		if (accountId) {
			this._vscode.postMessage({ type: 'clusterMap.set', clusterEndpoint, accountId });
		} else {
			this._vscode.postMessage({ type: 'clusterMap.delete', clusterEndpoint });
		}
		this._requestSnapshot();
	}

	private _selectDbCluster(clusterKey: string): void {
		this._selectedDbClusterKey = clusterKey;
	}

	private _onSplitterMouseDown = (e: MouseEvent): void => {
		e.preventDefault();
		const splitter = e.currentTarget as HTMLElement;
		const twoPane = splitter.parentElement!;
		const listPane = twoPane.querySelector('.listPane') as HTMLElement;
		if (!listPane) return;
		const startX = e.clientX;
		const startWidth = listPane.getBoundingClientRect().width;
		splitter.classList.add('is-dragging');
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
		const onMove = (ev: MouseEvent) => {
			const delta = ev.clientX - startX;
			const newWidth = Math.max(120, Math.min(startWidth + delta, twoPane.clientWidth * 0.5));
			listPane.style.width = newWidth + 'px';
		};
		const onUp = () => {
			splitter.classList.remove('is-dragging');
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);
		};
		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);
	};

	private _onDbListKeydown(e: KeyboardEvent): void {
		const key = e.key;
		if (key !== 'ArrowUp' && key !== 'ArrowDown') return;
		const snap = this._snapshot;
		if (!snap) return;
		const cached = snap.cachedDatabases && typeof snap.cachedDatabases === 'object' ? snap.cachedDatabases : {};
		const clusterKeys = Object.keys(cached);
		clusterKeys.sort();
		if (clusterKeys.length === 0) return;
		let idx = clusterKeys.indexOf(this._selectedDbClusterKey);
		if (idx < 0) idx = 0;
		if (key === 'ArrowUp') idx = Math.max(0, idx - 1);
		else idx = Math.min(clusterKeys.length - 1, idx + 1);
		this._selectedDbClusterKey = clusterKeys[idx];
		e.preventDefault();
	}

	private _refreshDatabases(clusterKey: string): void {
		this._vscode.postMessage({ type: 'databases.refresh', clusterKey });
		this._requestSnapshot();
	}

	private _deleteDatabases(clusterKey: string): void {
		this._vscode.postMessage({ type: 'databases.delete', clusterKey });
		this._requestSnapshot();
	}

	private _viewSchema(clusterKey: string, database: string): void {
		if (this._schemaRequestInFlight) return;
		this._schemaRequestInFlight = true;
		this._vscode.postMessage({ type: 'schema.get', clusterKey, database });
	}

	private _refreshKustoSchema(clusterKey: string, database: string): void {
		if (this._kustoSchemaRefreshDb) return;
		this._kustoSchemaRefreshDb = database;
		this._schemaRequestInFlight = true;
		this._vscode.postMessage({ type: 'schema.refresh', clusterKey, database });
	}

	// ── SQL event handlers ────────────────────────────────────────────────────

	private _copySqlToken(accountId: string): void {
		const snap = this._snapshot;
		let token = '';
		if (snap?.sqlAuth?.sessions) {
			for (const s of snap.sqlAuth.sessions) {
				if (s?.account?.id === accountId) {
					token = String(s.effectiveToken || '');
					break;
				}
			}
		}
		this._vscode.postMessage({ type: 'copyToClipboard', text: token });
	}

	private _clearSqlOverride(accountId: string): void {
		this._vscode.postMessage({ type: 'sqlAuth.clearTokenOverride', accountId });
		this._requestSnapshot();
	}

	private _saveSqlOverride(accountId: string): void {
		const el = this.shadowRoot?.querySelector(`input[data-sql-override-for="${CSS.escape(accountId)}"]`) as HTMLInputElement | null;
		const token = el?.value ?? '';
		this._vscode.postMessage({ type: 'sqlAuth.setTokenOverride', accountId, token });
		this._requestSnapshot();
	}

	private _onSqlSchemaClearAll(): void {
		this._vscode.postMessage({ type: 'sqlSchema.clearAll' });
		this._requestSnapshot();
	}

	private _onSqlServerAccountChange(serverUrl: string, e: Event): void {
		const target = e.target as HTMLSelectElement;
		const accountId = target.value;
		if (accountId) {
			this._vscode.postMessage({ type: 'sqlServerMap.set', serverUrl, accountId });
		} else {
			this._vscode.postMessage({ type: 'sqlServerMap.delete', serverUrl });
		}
		this._requestSnapshot();
	}

	private _editSqlConnection(connectionId: string): void {
		this._vscode.postMessage({ type: 'sqlAuth.editConnection', connectionId });
	}

	private _selectSqlServer(serverKey: string): void {
		this._selectedSqlServerKey = serverKey;
	}

	private _onSqlDbListKeydown(e: KeyboardEvent): void {
		const key = e.key;
		if (key !== 'ArrowUp' && key !== 'ArrowDown') return;
		const snap = this._snapshot;
		if (!snap) return;
		const sqlCached = snap.sqlCachedDatabases && typeof snap.sqlCachedDatabases === 'object' ? snap.sqlCachedDatabases : {};
		const sqlConns = Array.isArray(snap.sqlConnections) ? snap.sqlConnections : [];
		const { serverOrder } = groupSqlDatabasesByServer(sqlCached, sqlConns);
		if (serverOrder.length === 0) return;
		let idx = serverOrder.indexOf(this._selectedSqlServerKey);
		if (idx < 0) idx = 0;
		if (key === 'ArrowUp') idx = Math.max(0, idx - 1);
		else idx = Math.min(serverOrder.length - 1, idx + 1);
		this._selectedSqlServerKey = serverOrder[idx];
		e.preventDefault();
	}

	private _refreshSqlDatabases(connectionId: string): void {
		this._vscode.postMessage({ type: 'sqlDatabases.refresh', connectionId });
		this._requestSnapshot();
	}

	private _deleteSqlDatabases(connectionId: string): void {
		this._vscode.postMessage({ type: 'sqlDatabases.delete', connectionId });
		this._requestSnapshot();
	}

	private _viewSqlSchema(serverUrl: string, database: string): void {
		if (this._schemaRequestInFlight) return;
		this._schemaRequestInFlight = true;
		this._vscode.postMessage({ type: 'sqlSchema.get', serverUrl, database });
	}

	private _refreshSqlSchema(serverUrl: string, database: string, connectionId: string): void {
		if (this._sqlSchemaRefreshDb) return;
		this._sqlSchemaRefreshDb = database;
		this._schemaRequestInFlight = true;
		this._vscode.postMessage({ type: 'sqlSchema.refresh', serverUrl, database, connectionId });
	}

	/** Read SQL server → account map from snapshot (webview-side helper). */
	private readSqlServerAccountMap(): Record<string, string> {
		const snap = this._snapshot;
		if (!snap?.sqlServerAccountMap || typeof snap.sqlServerAccountMap !== 'object') return {};
		return snap.sqlServerAccountMap;
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	static styles = [...osStyles, scrollbarSheet, iconRegistryStyles, sashSheet, styles];
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-cached-values': KwCachedValues;
	}
}
