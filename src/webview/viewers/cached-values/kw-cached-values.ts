import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { styles } from './kw-cached-values.styles.js';
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
	auth: {
		sessions: AuthSession[];
		knownAccounts: StoredAuthAccount[];
		clusterAccountMap: Record<string, string>;
	};
	connections: Array<{ id: string; name: string; clusterUrl: string }>;
	cachedDatabases: Record<string, string[]>;
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

	// ── Reactive state ────────────────────────────────────────────────────────

	@state() private _snapshot: Snapshot | null = null;
	@state() private _selectedDbClusterKey = '';
	@state() private _schemaRequestInFlight = false;

	@query('kw-object-viewer') private _objectViewer!: KwObjectViewer;

	// ── Change-detection keys (replicate original renderAll logic) ─────────

	private _lastAccountsKey = '';
	private _lastAuthKey = '';
	private _lastClusterKey = '';
	private _lastDbKey = '';

	// ── VS Code API bridge ────────────────────────────────────────────────────

	private _vscode!: VsCodeApi;
	private _requestPending = false;
	private _pollInterval: ReturnType<typeof setInterval> | null = null;

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	connectedCallback(): void {
		super.connectedCallback();
		this._vscode = acquireVsCodeApi();
		window.addEventListener('message', this._onMessage);
		this._requestSnapshot();
		this._pollInterval = setInterval(() => this._requestSnapshot(), 2000);
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		window.removeEventListener('message', this._onMessage);
		if (this._pollInterval !== null) {
			clearInterval(this._pollInterval);
			this._pollInterval = null;
		}
	}

	// ── Message handling ──────────────────────────────────────────────────────

	private _onMessage = async (event: MessageEvent) => {
		const msg = event.data;
		if (msg?.type === 'snapshot') {
			this._requestPending = false;
			this._snapshot = msg.snapshot;
		}
		if (msg?.type === 'schemaResult') {
			this._schemaRequestInFlight = false;
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

		return html`
			<h1>Kusto Workbench: Cached Values</h1>
			<div class="small">Last updated: ${timestamp}</div>

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
							<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
								<path d="M6 2.5h4" />
								<path d="M3.5 4.5h9" />
								<path d="M5 4.5l.7 9h4.6l.7-9" />
								<path d="M6.6 7v4.8" />
								<path d="M9.4 7v4.8" />
							</svg>
						</button>
					</div>
				</header>
				<div class="sectionBody" id="dbContent">${this._renderDatabases()}</div>
			</section>

			<kw-object-viewer></kw-object-viewer>
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
			<table>
				<thead><tr>
					<th>Account</th>
					<th>Account Id</th>
					<th class="tokenCol">Token</th>
					<th>Override</th>
					<th>Actions</th>
				</tr></thead>
				<tbody>
					${sessions.map(s => this._renderAuthRow(s))}
				</tbody>
			</table>
		`;
	}

	private _renderAuthRow(session: AuthSession): TemplateResult {
		const account = session.account ?? { id: '', label: '' };
		const overrideVal = session.overrideToken ? String(session.overrideToken) : '';
		return html`
			<tr>
				<td>${account.label}</td>
				<td class="mono">${account.id}</td>
				<td class="tokenCol">
					<div class="rowActions">
						<button class="iconButton" title="Copy token" aria-label="Copy token"
							@click=${() => this._copyToken(account.id)}>
							<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1z"/><path d="M20 5H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h12v14z"/></svg>
						</button>
						<button class="iconButton" title="Delete token" aria-label="Delete token"
							@click=${() => this._clearOverride(account.id)}>
							<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12v2H6V7zm2 3h8l-1 10H9L8 10zm3-6h2v2h-2V4z"/></svg>
						</button>
					</div>
				</td>
				<td>
					<textarea data-override-for="${account.id}" placeholder="(empty = use session token)">${overrideVal}</textarea>
				</td>
				<td>
					<div class="rowActions">
						<button class="iconButton" title="Save override" aria-label="Save override"
							@click=${() => this._saveOverride(account.id)}>
							<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3H5a2 2 0 0 0-2 2v14h18V7l-4-4zm2 14H5V5h11.17L19 7.83V17z"/><path d="M7 5h8v4H7V5z"/></svg>
						</button>
					</div>
				</td>
			</tr>
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
				<div class="pane list scrollPane" tabindex="0" role="listbox" aria-label="Clusters"
					@keydown=${this._onDbListKeydown}>
					${clusterKeys.map(ck => {
						const list = Array.isArray(cached[ck]) ? cached[ck] : [];
						const title = labelByCluster[ck] || ck;
						const isSelected = ck === selected;
						return html`
							<div class="listItem ${isSelected ? 'selected' : ''}"
								@click=${() => this._selectDbCluster(ck)}>
								<div title="${title}">${shortClusterName(ck)}</div>
								<div class="count">${list.length}</div>
							</div>`;
					})}
				</div>
				<div class="pane scrollPane" tabindex="0" aria-label="Databases">
					<div style="padding:10px;">
						<div class="dbDetailHeader">
							<div class="small">${selectedTitle}</div>
							<div class="rowActions">
								<button class="iconButton" title="Refresh the list of cached databases for selected cluster" aria-label="Refresh the list of cached databases for selected cluster"
									@click=${() => this._refreshDatabases(selected)}>
									<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5a7 7 0 0 1 6.32 4H16v2h6V5h-2v2.1A9 9 0 1 0 21 12h-2a7 7 0 1 1-7-7z"/></svg>
								</button>
								<button class="iconButton" title="Delete the list of cached databases for the selected cluster" aria-label="Delete the list of cached databases for the selected cluster"
									@click=${() => this._deleteDatabases(selected)}>
									<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12v2H6V7zm2 3h8l-1 10H9L8 10zm3-6h2v2h-2V4z"/></svg>
								</button>
							</div>
						</div>
						<table>
							<thead><tr><th>Database</th></tr></thead>
							<tbody>
								${selectedList.filter(Boolean).map(db => html`
									<tr><td>
										<button class="linkButton mono" title="View cached schema JSON"
											@click=${() => this._viewSchema(selected, String(db))}>${db}</button>
									</td></tr>
								`)}
							</tbody>
						</table>
					</div>
				</div>
			</div>
		`;
	}

	// ── Event handlers ────────────────────────────────────────────────────────

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
		const ta = this.shadowRoot?.querySelector(`textarea[data-override-for="${CSS.escape(accountId)}"]`) as HTMLTextAreaElement | null;
		const token = ta?.value ?? '';
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

	// ── Styles ────────────────────────────────────────────────────────────────

	static styles = styles;
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-cached-values': KwCachedValues;
	}
}
