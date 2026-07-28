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
	account: { id: string; label: string };
}

interface StoredAuthAccount {
	id: string;
	label: string;
	lastUsedAt: number;
}

interface Snapshot {
	revision: number;
	timestamp: number;
	activeKind: 'kusto' | 'sql';
	auth: {
		sessions: AuthSession[];
		knownAccounts: StoredAuthAccount[];
	};
	connections: Array<{
		id: string;
		name: string;
		clusterUrl: string;
		authorityId?: string;
		accountPreference: { mode: 'automatic'; lastSuccessfulAccountId?: string; legacyAccountId?: string } | { mode: 'explicit'; accountId: string };
		selectedAccountId?: string;
		selectedAccountLabel?: string;
		accountPartition?: string;
		hasTokenOverride: boolean;
	}>;
	cachedDatabases: Record<string, string[]>;
	sqlAuth: {
		sessions: Array<{
			account: { id: string; label: string };
			hasOverride: boolean;
		}>;
	};
	sqlConnections: Array<{ id: string; name: string; serverUrl: string; authType: string }>;
	sqlCachedDatabases: Record<string, string[]>;
	sqlLeaveNoTrace: string[];
	sqlStateVersions?: { policy: number; principals: number; connections: number };
	sqlAvailable?: boolean;
	sqlServerAccountMap: Record<string, string>;
	cachedSchemaKeys: string[];
}

interface VsCodeApi {
	postMessage(msg: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

function getVsCodeApi(): VsCodeApi {
	const existing = (window as Window & { vscode?: VsCodeApi }).vscode;
	if (existing) return existing;
	const vscode = acquireVsCodeApi();
	try { (window as Window & { vscode?: VsCodeApi }).vscode = vscode; } catch (e) { console.error('[kusto]', e); }
	return vscode;
}

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

/** Keep SQL cached databases partitioned by their exact connection owner. */
export function groupSqlDatabasesByConnection(
	sqlCachedDatabases: Record<string, string[]>,
	sqlConnections: Array<{ id: string; name?: string; serverUrl: string }>,
): {
	byConnection: Record<string, { connectionId: string; connectionName: string; serverUrl: string; databases: string[] }>;
	connectionOrder: string[];
} {
	const connById = new Map(sqlConnections.map(c => [c.id, c]));
	const byConnection: Record<string, { connectionId: string; connectionName: string; serverUrl: string; databases: string[] }> = {};
	for (const [connId, dbs] of Object.entries(sqlCachedDatabases)) {
		const conn = connById.get(connId);
		if (!conn) continue;
		const databases: string[] = [];
		const seen = new Set<string>();
		for (const db of dbs) {
			const lower = db.toLowerCase();
			if (!seen.has(lower)) { seen.add(lower); databases.push(db); }
		}
		byConnection[connId] = {
			connectionId: connId,
			connectionName: String(conn.name || '').trim(),
			serverUrl: conn.serverUrl,
			databases,
		};
	}
	const connectionOrder = Object.keys(byConnection);
	connectionOrder.sort((left, right) => {
		const leftEntry = byConnection[left];
		const rightEntry = byConnection[right];
		const leftLabel = leftEntry.connectionName || leftEntry.serverUrl;
		const rightLabel = rightEntry.connectionName || rightEntry.serverUrl;
		return leftLabel.toLowerCase().localeCompare(rightLabel.toLowerCase()) || left.localeCompare(right);
	});
	return { byConnection, connectionOrder };
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
	const connections = Array.isArray(snapshot?.connections) ? snapshot.connections : [];
	return ['accounts=' + String(accountsKey || ''), ...connections.map(connection => `${connection.id}:${connection.selectedAccountId || ''}:${connection.hasTokenOverride ? 'override' : ''}`)].join('|');
}

function buildClusterKey(snapshot: Snapshot, accountsKey: string): string {
	const parts = ['accounts=' + String(accountsKey || '')];
	for (const connection of snapshot.connections || []) {
		parts.push(`${connection.id}=${connection.accountPreference.mode}:${connection.selectedAccountId || ''}`);
	}
	return parts.join('|');
}

function buildDbKey(snapshot: Snapshot): string {
	const cached = snapshot?.cachedDatabases && typeof snapshot.cachedDatabases === 'object' ? snapshot.cachedDatabases : {};
	const clusterKeys = Object.keys(cached);
	clusterKeys.sort();
	const connectionById = new Map((snapshot?.connections || []).map(connection => [connection.id, connection]));
	const parts: string[] = [];
	for (const id of clusterKeys) {
		const list = Array.isArray(cached[id]) ? cached[id] : [];
		parts.push(id + ':' + (connectionById.get(id)?.clusterUrl || '') + ':' + list.join(String.fromCharCode(31)));
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
	private _latestSnapshotRevision = 0;
	private _stagedKustoPublications = new Map<string, { payload: any; deadline: number; timer: ReturnType<typeof setTimeout> }>();
	private _completedKustoPublications = new Map<string, { accepted: boolean; timer: ReturnType<typeof setTimeout> }>();
	private _schemaRequestOwner: { requestId: string; connectionId: string; accountPartition: string } | undefined;
	private _objectViewerOwner: { connectionId: string; accountPartition: string } | undefined;
	private _sqlSchemaRequestOwner: { requestId: string; connectionId: string } | undefined;
	private _sqlObjectViewerConnectionId = '';

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
		this._vscode = getVsCodeApi();
		window.addEventListener('message', this._onMessage);
		this._requestSnapshot();
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		window.removeEventListener('message', this._onMessage);
	}

	// ── Message handling ──────────────────────────────────────────────────────

	private _onMessage = (event: MessageEvent) => {
		let msg = event.data;
		const acknowledge = (accepted: boolean, phase: 'staged' | 'applied' = 'applied') => {
			if (!msg?.publicationId) return;
			if (phase === 'applied') {
				const previous = this._completedKustoPublications.get(msg.publicationId);
				if (previous) clearTimeout(previous.timer);
				const timer = setTimeout(() => this._completedKustoPublications.delete(msg.publicationId), 10_000);
				this._completedKustoPublications.set(msg.publicationId, { accepted, timer });
			}
			this._vscode.postMessage({ type: 'kustoPublicationAck', publicationId: msg.publicationId, phase, accepted });
		};
		if (msg?.type === 'kustoPublicationStage') {
			const publicationId = String(msg.publicationId || '');
			const deadline = Number(msg.publicationDeadline);
			if (!publicationId || !Number.isFinite(deadline) || deadline < Date.now()) {
				acknowledge(false, 'staged');
				return;
			}
			const previous = this._stagedKustoPublications.get(publicationId);
			if (previous) clearTimeout(previous.timer);
			const timer = setTimeout(() => {
				if (!this._stagedKustoPublications.delete(publicationId)) return;
				this._vscode.postMessage({ type: 'kustoPublicationAck', publicationId, phase: 'applied', accepted: false });
			}, Math.max(0, deadline - Date.now()));
			this._stagedKustoPublications.set(publicationId, { payload: msg.payload, deadline, timer });
			acknowledge(true, 'staged');
			return;
		}
		if (msg?.type === 'kustoPublicationCommit') {
			const publicationId = String(msg.publicationId || '');
			const staged = this._stagedKustoPublications.get(publicationId);
			this._stagedKustoPublications.delete(publicationId);
			if (staged) clearTimeout(staged.timer);
			if (!staged || staged.deadline < Date.now()) {
				acknowledge(false, 'applied');
				return;
			}
			msg = { ...(staged.payload || {}), publicationId };
		}
		if (msg?.type === 'kustoPublicationRevoke') {
			const publicationId = String(msg.publicationId || '');
			const staged = this._stagedKustoPublications.get(publicationId);
			if (staged) clearTimeout(staged.timer);
			this._stagedKustoPublications.delete(publicationId);
			acknowledge(this._completedKustoPublications.get(publicationId)?.accepted === true, 'applied');
			return;
		}
		if (msg?.type === 'kustoOwnerChanged') {
			const changedIds = new Set((Array.isArray(msg.connectionIds) ? msg.connectionIds : []).map(String));
			if (this._schemaRequestOwner && (changedIds.size === 0 || changedIds.has(this._schemaRequestOwner.connectionId))) {
				this._schemaRequestOwner = undefined;
				this._schemaRequestInFlight = false;
				this._kustoSchemaRefreshDb = '';
			}
			if (this._objectViewerOwner && (changedIds.size === 0 || changedIds.has(this._objectViewerOwner.connectionId))) {
				this._objectViewerOwner = undefined;
				this._objectViewer?.hide();
			}
			return;
		}
		if (msg?.type === 'sqlPrincipalChanged' || msg?.type === 'sqlOwnerChanged') {
			const changedIds = new Set((Array.isArray(msg.connectionIds) ? msg.connectionIds : []).map(String));
			if (this._sqlSchemaRequestOwner && changedIds.has(this._sqlSchemaRequestOwner.connectionId)) {
				this._sqlSchemaRequestOwner = undefined;
				this._schemaRequestInFlight = false;
				this._sqlSchemaRefreshDb = '';
			}
			if (this._sqlObjectViewerConnectionId && changedIds.has(this._sqlObjectViewerConnectionId)) {
				this._sqlObjectViewerConnectionId = '';
				this._objectViewer?.hide();
			}
			return;
		}
		if (msg?.type === 'snapshot') {
			const revision = Number(msg.snapshot?.revision) || 0;
			if (revision && revision < this._latestSnapshotRevision) { acknowledge(false); return; }
			if (revision) this._latestSnapshotRevision = revision;
			this._requestPending = false;
			const snap = msg.snapshot as Snapshot;
			const partitionFor = (connectionId: string) => String(snap.connections?.find(connection => connection.id === connectionId)?.accountPartition || '');
			if (this._schemaRequestOwner) {
				const nextPartition = partitionFor(this._schemaRequestOwner.connectionId);
				if (!this._schemaRequestOwner.accountPartition && nextPartition) {
					this._schemaRequestOwner = { ...this._schemaRequestOwner, accountPartition: nextPartition };
				} else if (nextPartition !== this._schemaRequestOwner.accountPartition) {
					this._schemaRequestOwner = undefined;
					this._schemaRequestInFlight = false;
					this._kustoSchemaRefreshDb = '';
				}
			}
			if (this._objectViewerOwner && partitionFor(this._objectViewerOwner.connectionId) !== this._objectViewerOwner.accountPartition) {
				this._objectViewerOwner = undefined;
				this._objectViewer?.hide();
			}
			const allowedSqlIds = new Set((snap.sqlConnections ?? []).map(connection => connection.id));
			if (this._sqlSchemaRequestOwner && !allowedSqlIds.has(this._sqlSchemaRequestOwner.connectionId)) {
				this._sqlSchemaRequestOwner = undefined;
				this._schemaRequestInFlight = false;
				this._sqlSchemaRefreshDb = '';
			}
			if (this._sqlObjectViewerConnectionId && !allowedSqlIds.has(this._sqlObjectViewerConnectionId)) {
				this._sqlObjectViewerConnectionId = '';
				this._objectViewer?.hide();
			}
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
			acknowledge(true);
		}
		if (msg?.type === 'schemaResult') {
			const requestId = String(msg.requestId || '');
			const connectionId = String(msg.connectionId || '');
			const accountPartition = String(msg.accountPartition || '');
			const isKustoResult = !!requestId && !!connectionId;
			const isSqlResult = !!requestId && !!connectionId && !accountPartition;
			if (isSqlResult) {
				const owner = this._sqlSchemaRequestOwner;
				const allowed = this._snapshot?.sqlConnections.some(connection => connection.id === connectionId)
					&& !this._snapshot?.sqlLeaveNoTrace?.includes(connectionId);
				if (!owner || owner.requestId !== requestId || owner.connectionId !== connectionId || !allowed) return;
			} else if (isKustoResult) {
				const owner = this._schemaRequestOwner;
				const currentPartition = String(this._snapshot?.connections.find(connection => connection.id === connectionId)?.accountPartition || '');
				if (!owner || owner.requestId !== requestId || owner.connectionId !== connectionId
					|| owner.accountPartition !== accountPartition || currentPartition !== accountPartition) return;
			}
			this._schemaRequestInFlight = false;
			this._sqlSchemaRefreshDb = '';
			this._kustoSchemaRefreshDb = '';
			const db = String(msg.database || '');
			const title = 'Cached schema for ' + (db || '(unknown db)');
			const jsonText = String(msg.json || '');
			if (isSqlResult) {
				const owner = this._sqlSchemaRequestOwner;
				const allowed = this._snapshot?.sqlConnections.some(connection => connection.id === connectionId)
					&& !this._snapshot?.sqlLeaveNoTrace?.includes(connectionId);
				if (!owner || owner.requestId !== requestId || owner.connectionId !== connectionId || !allowed) return;
				this._sqlSchemaRequestOwner = undefined;
				this._sqlObjectViewerConnectionId = connectionId;
			} else if (isKustoResult) {
				const owner = this._schemaRequestOwner;
				const currentPartition = String(this._snapshot?.connections.find(connection => connection.id === connectionId)?.accountPartition || '');
				if (!owner || owner.requestId !== requestId || owner.accountPartition !== accountPartition || currentPartition !== accountPartition) return;
				this._schemaRequestOwner = undefined;
				this._objectViewerOwner = { connectionId, accountPartition };
			}
			if (!this._objectViewer) { acknowledge(false); return; }
			this._objectViewer.copyCallback = (msg: unknown) => this._vscode.postMessage(msg);
			this._objectViewer.show(title, jsonText);
			acknowledge(true);
		}
		if (msg?.type === 'kustoMutationComplete') this._requestPending = false;
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
			<div class="viewerContent" @wheel=${this._onNestedScrollWheel}>
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
			</div>
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
						<div><strong>Connection authentication preferences</strong></div>
						<div class="small">Tenant and account selection are scoped to each saved connection.</div>
					</div>
				</header>
				<div class="sectionBody">${this._renderClusterMap()}</div>
			</section>

			<section class="dbSection">
				<header>
					<div>
						<div><strong>Cached list of databases (per connection and account)</strong></div>
						<div class="small">Select a connection on the left to view databases cached for its current identity.</div>
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
		return html`
			<div class="authCard">
				<div class="authCardRow">
					<div class="authCardInfo">
						<div class="authCardLabel">${account.label}</div>
						<div class="authCardId" title="${account.id}">${account.id}</div>
					</div>
					<div class="authCardActions">
						<button class="iconButton" title="Forget account" aria-label="Forget account"
							@click=${() => this._forgetAccount(account.id)}>${ICONS.trash}</button>
					</div>
				</div>
			</div>
		`;
	}

	// ── Cluster Map section ───────────────────────────────────────────────────

	private _renderClusterMap(): TemplateResult | typeof nothing {
		const snap = this._snapshot;
		if (!snap) return nothing;
		const connections = Array.isArray(snap.connections) ? snap.connections : [];
		if (connections.length === 0) {
			return html`<div class="small">No saved Kusto connections.</div>`;
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
		for (const connection of connections) {
			const accountId = String(connection.selectedAccountId || '');
			if (accountId && !accountsById.has(accountId)) {
				accountsById.set(accountId, { id: accountId, label: connection.selectedAccountLabel || accountId });
			}
		}
		const accounts = [...accountsById.values()];

		return html`
			<table>
				<thead><tr>
					<th>Connection</th>
					<th>Authority / Tenant</th>
					<th>Account</th>
					<th></th>
				</tr></thead>
				<tbody>
					${connections.map(connection => {
						const selectedAccountId = String(connection.selectedAccountId || '');
						const overrideKey = `${connection.id}|${selectedAccountId}`;
						const isExpanded = !!selectedAccountId && this._expandedOverrides.has(overrideKey);
						return html`
						<tr data-testid="cv-kusto-connection-auth-row" data-connection-id="${connection.id}">
							<td title="${connection.clusterUrl}">${connection.name}</td>
							<td class="mono">${connection.authorityId || 'organizations (default)'}</td>
							<td>
								<div class="select-wrapper" title="Select account">
									<select @change=${(e: Event) => this._onConnectionAccountChange(connection.id, e)}>
										<option value="">Automatic</option>
										${accounts.map(a => html`
											<option value="${a.id}" ?selected=${connection.accountPreference.mode === 'explicit' && a.id === selectedAccountId}>${a.label}</option>
										`)}
									</select>
								</div>
							</td>
							<td class="rowActions">
								${selectedAccountId ? html`
									<button class="iconButton" title="Copy effective token" aria-label="Copy effective token"
										@click=${() => this._copyToken(connection.id, selectedAccountId)}>${ICONS.copy}</button>
									<button class="iconButton" title="${isExpanded ? 'Hide override' : 'Set token override'}" aria-label="Toggle override"
										@click=${() => this._toggleOverride(overrideKey)}>${ICONS.edit}</button>
									${connection.hasTokenOverride ? html`
										<button class="iconButton" title="Clear override" aria-label="Clear override"
											@click=${() => this._clearOverride(connection.id, selectedAccountId)}>${ICONS.trash}</button>
									` : nothing}
								` : nothing}
							</td>
						</tr>
						${isExpanded ? html`<tr><td colspan="4"><div class="authOverrideRow">
							<span class="overrideLabel">Override</span>
							<input type="password" data-override-for="${overrideKey}" placeholder="Paste token to override"
								@keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') this._saveOverride(connection.id, selectedAccountId, overrideKey); }} />
							<button class="iconButton" title="Save override" aria-label="Save override"
								@click=${() => this._saveOverride(connection.id, selectedAccountId, overrideKey)}>${ICONS.save}</button>
						</div></td></tr>` : nothing}
					`;
					})}
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

		const connectionById = new Map((snap.connections || []).map(connection => [connection.id, connection]));

		// Ensure selection is stable.
		let selected = this._selectedDbClusterKey;
		if (!selected || !clusterKeys.includes(selected)) {
			selected = clusterKeys[0];
			this._selectedDbClusterKey = selected;
		}

		const selectedList = Array.isArray(cached[selected]) ? cached[selected] : [];
		const selectedConnection = connectionById.get(selected);
		const selectedTitle = selectedConnection ? `${selectedConnection.name} — ${selectedConnection.clusterUrl}` : selected;

		return html`
			<div class="twoPane">
				<div class="pane listPane list scrollPane" data-overlay-scroll="x:hidden" tabindex="0" role="listbox" aria-label="Connections"
					@keydown=${this._onDbListKeydown}>
					${clusterKeys.map(ck => {
						const list = Array.isArray(cached[ck]) ? cached[ck] : [];
						const connection = connectionById.get(ck);
						const title = connection?.clusterUrl || ck;
						const isSelected = ck === selected;
						return html`
							<div class="listItem ${isSelected ? 'selected' : ''}"
								@click=${() => this._selectDbCluster(ck)}>
								<div class="listItemName" title="${title}">${connection?.name || ck}</div>
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

	private _renderSqlAuthRow(session: { account: { id: string; label: string }; hasOverride: boolean }): TemplateResult {
		const account = session.account ?? { id: '', label: '' };
		const hasOverride = session.hasOverride;
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
						<input type="password" data-sql-override-for="${account.id}"
							placeholder="Paste token to override"
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
		const { byConnection, connectionOrder } = groupSqlDatabasesByConnection(sqlCached, sqlConns);

		if (connectionOrder.length === 0) {
			return html`<div class="small">No cached database lists.</div>`;
		}

		// Ensure selection is stable
		let selected = this._selectedSqlServerKey;
		if (!selected || !connectionOrder.includes(selected)) {
			selected = connectionOrder[0];
			this._selectedSqlServerKey = selected;
		}

		const entry = byConnection[selected];
		const selectedList = entry ? entry.databases : [];
		const selectedConnectionId = entry?.connectionId ?? '';
		const selectedServerUrl = entry?.serverUrl ?? '';

		return html`
			<div class="twoPane">
				<div class="pane listPane list scrollPane" data-overlay-scroll="x:hidden" tabindex="0" role="listbox" aria-label="Servers"
					@keydown=${this._onSqlDbListKeydown}>
					${connectionOrder.map(connectionId => {
						const e = byConnection[connectionId];
						const isSelected = connectionId === selected;
						const label = e.connectionName || shortServerName(e.serverUrl);
						return html`
							<div class="listItem ${isSelected ? 'selected' : ''}"
								@click=${() => this._selectSqlServer(connectionId)}>
								<div class="listItemName" title="${e.serverUrl}">${label}</div>
								<div class="count">${e.databases.length}</div>
							</div>`;
					})}
				</div>
				<div class="resizer-v" @mousedown=${this._onSplitterMouseDown}></div>
				<div class="pane detailPane scrollPane" data-overlay-scroll="x:hidden" tabindex="0" aria-label="Databases">
					<div style="padding:10px;">
						<div class="dbDetailHeader">
							<div class="detailUrl" title="${selectedServerUrl}">${selectedServerUrl}</div>
							<div class="rowActions">
								<button class="iconButton" title="Refresh this connection's cached databases" aria-label="Refresh this connection's cached databases"
									@click=${() => this._refreshSqlDatabases(selectedConnectionId)}>
									${ICONS.refresh}
								</button>
								<button class="iconButton" title="Delete this connection's cached databases" aria-label="Delete this connection's cached databases"
									@click=${() => this._deleteSqlDatabases(selectedConnectionId)}>
									${ICONS.trash}
								</button>
							</div>
						</div>
						<div class="dbList">
							${selectedList.filter(Boolean).map(db => {
								const isRefreshing = this._sqlSchemaRefreshDb === String(db);
								const hasCachedSchema = !!selectedConnectionId && snap.cachedSchemaKeys?.includes(`sql:${selectedConnectionId}|${db}`);
								return html`
								<div class="dbItem">
									<span class="dbIcon">${ICONS.database}</span>
									${hasCachedSchema
										? html`<button class="linkButton mono" title="View cached SQL schema"
											@click=${() => this._viewSqlSchema(selectedServerUrl, String(db), selectedConnectionId)}>${db}</button>`
										: html`<span class="dbName" title="No cached schema">${db}</span>`
									}
									<div class="dbActions">
										<button class="iconButton${isRefreshing ? ' spinning' : ''}" title="Refresh schema for ${db}" aria-label="Refresh schema for ${db}"
											?disabled=${isRefreshing}
											@click=${() => this._refreshSqlSchema(selectedServerUrl, String(db), selectedConnectionId)}>
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

	private _onNestedScrollWheel(event: WheelEvent): void {
		const scrollable = this._findNestedVerticalScroller(event);
		if (!scrollable || !this._canScrollVertically(scrollable, event.deltaY)) return;
		event.stopPropagation();
	}

	private _findNestedVerticalScroller(event: WheelEvent): HTMLElement | null {
		const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
		for (const target of path) {
			if (target === this || target === this.shadowRoot) return null;
			if (!(target instanceof HTMLElement)) continue;
			if (target === this) return null;
			const style = getComputedStyle(target);
			const overflowY = style.overflowY || style.overflow;
			if (overflowY === 'auto' || overflowY === 'scroll') return target;
		}
		return null;
	}

	private _canScrollVertically(element: HTMLElement, deltaY: number): boolean {
		if (!deltaY) return false;
		const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
		if (maxScrollTop <= 0) return false;
		if (deltaY > 0) return element.scrollTop < maxScrollTop;
		return element.scrollTop > 0;
	}

	private _toggleOverride(key: string): void {
		const next = new Set(this._expandedOverrides);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		this._expandedOverrides = next;
	}

	private _copyToken(connectionId: string, accountId: string): void {
		this._vscode.postMessage({ type: 'auth.copyToken', connectionId, accountId });
	}

	private _clearOverride(connectionId: string, accountId: string): void {
		this._requestPending = true;
		this._vscode.postMessage({ type: 'auth.clearTokenOverride', connectionId, accountId });
	}

	private _saveOverride(connectionId: string, accountId: string, overrideKey: string): void {
		const el = this.shadowRoot?.querySelector(`input[data-override-for="${CSS.escape(overrideKey)}"]`) as HTMLInputElement | null;
		const token = el?.value ?? '';
		this._requestPending = true;
		this._vscode.postMessage({ type: 'auth.setTokenOverride', connectionId, accountId, token });
	}

	private _forgetAccount(accountId: string): void {
		this._requestPending = true;
		this._vscode.postMessage({ type: 'auth.forgetAccount', accountId });
	}

	private _onSchemaClearAll(): void {
		this._requestPending = true;
		this._vscode.postMessage({ type: 'schema.clearAll' });
	}

	private _onConnectionAccountChange(connectionId: string, e: Event): void {
		const target = e.target as HTMLSelectElement;
		const accountId = target.value;
		this._requestPending = true;
		this._vscode.postMessage({ type: 'connectionPreference.set', connectionId, ...(accountId ? { accountId } : {}) });
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

	private _refreshDatabases(connectionId: string): void {
		this._requestPending = true;
		this._vscode.postMessage({ type: 'databases.refresh', connectionId });
	}

	private _deleteDatabases(connectionId: string): void {
		this._requestPending = true;
		this._vscode.postMessage({ type: 'databases.delete', connectionId });
	}

	private _viewSchema(connectionId: string, database: string): void {
		if (this._schemaRequestInFlight) return;
		const requestId = `schema-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const accountPartition = String(this._snapshot?.connections.find(connection => connection.id === connectionId)?.accountPartition || '');
		this._schemaRequestOwner = { requestId, connectionId, accountPartition };
		this._schemaRequestInFlight = true;
		this._vscode.postMessage({ type: 'schema.get', requestId, connectionId, database });
	}

	private _refreshKustoSchema(connectionId: string, database: string): void {
		if (this._kustoSchemaRefreshDb) return;
		const requestId = `schema-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const accountPartition = String(this._snapshot?.connections.find(connection => connection.id === connectionId)?.accountPartition || '');
		this._schemaRequestOwner = { requestId, connectionId, accountPartition };
		this._kustoSchemaRefreshDb = database;
		this._schemaRequestInFlight = true;
		this._vscode.postMessage({ type: 'schema.refresh', requestId, connectionId, database });
	}

	// ── SQL event handlers ────────────────────────────────────────────────────

	private _copySqlToken(accountId: string): void {
		this._vscode.postMessage({ type: 'sqlAuth.copyToken', accountId });
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
		const { connectionOrder } = groupSqlDatabasesByConnection(sqlCached, sqlConns);
		if (connectionOrder.length === 0) return;
		let idx = connectionOrder.indexOf(this._selectedSqlServerKey);
		if (idx < 0) idx = 0;
		if (key === 'ArrowUp') idx = Math.max(0, idx - 1);
		else idx = Math.min(connectionOrder.length - 1, idx + 1);
		this._selectedSqlServerKey = connectionOrder[idx];
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

	private _viewSqlSchema(serverUrl: string, database: string, connectionId: string): void {
		if (this._schemaRequestInFlight) return;
		const requestId = `sql-schema-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		this._sqlSchemaRequestOwner = { requestId, connectionId };
		this._schemaRequestInFlight = true;
		this._vscode.postMessage({ type: 'sqlSchema.get', requestId, serverUrl, database, connectionId });
	}

	private _refreshSqlSchema(serverUrl: string, database: string, connectionId: string): void {
		if (this._sqlSchemaRefreshDb) return;
		const requestId = `sql-schema-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		this._sqlSchemaRequestOwner = { requestId, connectionId };
		this._sqlSchemaRefreshDb = database;
		this._schemaRequestInFlight = true;
		this._vscode.postMessage({ type: 'sqlSchema.refresh', requestId, serverUrl, database, connectionId });
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
