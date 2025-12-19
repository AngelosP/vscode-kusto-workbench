import * as vscode from 'vscode';
import { ConnectionManager, KustoConnection } from './connectionManager';

const VIEW_TITLE = 'Kusto Workbench: Cached Values';

const STORAGE_KEYS = {
	knownAccounts: 'kusto.auth.knownAccounts',
	clusterAccountMap: 'kusto.auth.clusterAccountMap',
	connections: 'kusto.connections',
	cachedDatabases: 'kusto.cachedDatabases'
} as const;

const AUTH = {
	providerId: 'microsoft',
	scope: 'https://kusto.kusto.windows.net/.default'
} as const;

const SECRET_KEYS = {
	tokenOverrideByAccountId: (accountId: string) => `kusto.auth.tokenOverride.${accountId}`
} as const;

type StoredAuthAccount = {
	id: string;
	label: string;
	lastUsedAt: number;
};

type Snapshot = {
	timestamp: number;
	auth: {
		sessions: Array<{
			sessionId?: string;
			account: { id: string; label: string };
			scopes: string[];
			accessToken?: string;
			effectiveToken: string;
			overrideToken?: string;
		}>;
		knownAccounts: StoredAuthAccount[];
		clusterAccountMap: Record<string, string>;
	};
	connections: KustoConnection[];
	cachedDatabases: Record<string, string[]>;
};

type IncomingMessage =
	| { type: 'requestSnapshot' }
	| { type: 'copyToClipboard'; text: string }
	| { type: 'auth.setTokenOverride'; accountId: string; token: string }
	| { type: 'auth.clearTokenOverride'; accountId: string }
	| { type: 'auth.resetAll' }
	| { type: 'clusterMap.set'; clusterEndpoint: string; accountId: string }
	| { type: 'clusterMap.delete'; clusterEndpoint: string }
	| { type: 'clusterMap.resetAll' }
	| { type: 'databases.set'; connectionId: string; databases: string[] }
	| { type: 'databases.delete'; connectionId: string }
	| { type: 'databases.resetAll' };

export class CachedValuesViewer {
	private static current: CachedValuesViewer | undefined;

	public static open(context: vscode.ExtensionContext, extensionUri: vscode.Uri, connectionManager: ConnectionManager): void {
		if (CachedValuesViewer.current) {
			// If the panel is already open, refresh HTML so any runtime fixes apply immediately.
			CachedValuesViewer.current.panel.webview.html = CachedValuesViewer.current.buildHtml(CachedValuesViewer.current.panel.webview);
			CachedValuesViewer.current.panel.reveal(vscode.ViewColumn.Active);
			return;
		}
		CachedValuesViewer.current = new CachedValuesViewer(context, extensionUri, connectionManager);
	}

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	private constructor(
		private readonly context: vscode.ExtensionContext,
		extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager
	) {
		this.panel = vscode.window.createWebviewPanel(
			'kusto.cachedValues',
			VIEW_TITLE,
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [extensionUri]
			}
		);

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage((msg: IncomingMessage) => void this.onMessage(msg), null, this.disposables);
		this.panel.webview.html = this.buildHtml(this.panel.webview);
	}

	private dispose(): void {
		CachedValuesViewer.current = undefined;
		for (const d of this.disposables) {
			try { d.dispose(); } catch { /* ignore */ }
		}
	}

	private readKnownAccounts(): StoredAuthAccount[] {
		const raw = this.context.globalState.get<StoredAuthAccount[] | undefined>(STORAGE_KEYS.knownAccounts);
		return Array.isArray(raw)
			? raw.filter(a => a && typeof a.id === 'string' && typeof a.label === 'string' && typeof (a as any).lastUsedAt === 'number')
			: [];
	}

	private readClusterAccountMap(): Record<string, string> {
		const raw = this.context.globalState.get<Record<string, string> | undefined>(STORAGE_KEYS.clusterAccountMap);
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			return {};
		}
		const next: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw)) {
			if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim()) {
				next[k] = v;
			}
		}
		return next;
	}

	private readCachedDatabases(): Record<string, string[]> {
		const raw = this.context.globalState.get<Record<string, string[]> | undefined>(STORAGE_KEYS.cachedDatabases);
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			return {};
		}
		const next: Record<string, string[]> = {};
		for (const [k, v] of Object.entries(raw)) {
			if (typeof k !== 'string' || !k.trim()) {
				continue;
			}
			if (!Array.isArray(v)) {
				continue;
			}
			next[k] = v.map(x => String(x || '').trim()).filter(Boolean);
		}
		return next;
	}

	private async buildSnapshot(): Promise<Snapshot> {
		const knownAccounts = this.readKnownAccounts();
		const clusterAccountMap = this.readClusterAccountMap();
		const connections = this.connectionManager.getConnections();
		const cachedDatabases = this.readCachedDatabases();

		// VS Code's stable API doesn't expose list-all-sessions in this project setup,
		// so we derive accounts from our own stored auth history + cluster preference map,
		// and then attempt a silent session fetch per account.
		const accountsById = new Map<string, { id: string; label: string }>();
		for (const a of knownAccounts) {
			accountsById.set(a.id, { id: a.id, label: a.label });
		}
		for (const accountId of Object.values(clusterAccountMap)) {
			if (!accountsById.has(accountId)) {
				accountsById.set(accountId, { id: accountId, label: accountId });
			}
		}

		const sessionRows = await Promise.all(
			[...accountsById.values()].map(async (account) => {
				let session: vscode.AuthenticationSession | undefined;
				try {
					session = await vscode.authentication.getSession(
						AUTH.providerId,
						[AUTH.scope],
						{ silent: true, account }
					);
				} catch {
					session = undefined;
				}

				let overrideToken: string | undefined;
				try {
					overrideToken = (await this.context.secrets.get(SECRET_KEYS.tokenOverrideByAccountId(account.id))) ?? undefined;
				} catch {
					overrideToken = undefined;
				}
				const accessToken = session?.accessToken;
				const effectiveToken = (overrideToken && overrideToken.trim())
					? overrideToken
					: (accessToken ?? '');
				return {
					sessionId: session?.id,
					account: { id: account.id, label: account.label },
					scopes: session?.scopes ? [...session.scopes] : [AUTH.scope],
					accessToken,
					effectiveToken,
					overrideToken
				};
			})
		);

		return {
			timestamp: Date.now(),
			auth: {
				sessions: sessionRows,
				knownAccounts,
				clusterAccountMap
			},
			connections,
			cachedDatabases
		};
	}

	private async onMessage(msg: IncomingMessage): Promise<void> {
		switch (msg.type) {
			case 'requestSnapshot': {
				const snapshot = await this.buildSnapshot();
				this.panel.webview.postMessage({ type: 'snapshot', snapshot });
				return;
			}
			case 'copyToClipboard': {
				try {
					await vscode.env.clipboard.writeText(String(msg.text ?? ''));
					void vscode.window.setStatusBarMessage('Copied to clipboard', 1500);
				} catch {
					void vscode.window.showErrorMessage('Could not copy to clipboard.');
				}
				return;
			}
			case 'auth.setTokenOverride': {
				const accountId = String(msg.accountId || '').trim();
				if (!accountId) {
					return;
				}
				await this.context.secrets.store(SECRET_KEYS.tokenOverrideByAccountId(accountId), String(msg.token ?? ''));
				return;
			}
			case 'auth.clearTokenOverride': {
				const accountId = String(msg.accountId || '').trim();
				if (!accountId) {
					return;
				}
				try { await this.context.secrets.delete(SECRET_KEYS.tokenOverrideByAccountId(accountId)); } catch { /* ignore */ }
				return;
			}
			case 'auth.resetAll': {
				// Reset our persisted auth-related caches and any token overrides we know about.
				const known = this.readKnownAccounts();
				const map = this.readClusterAccountMap();
				const accountIds = new Set<string>([
					...known.map(a => a.id),
					...Object.values(map)
				]);
				await Promise.all(
					[...accountIds]
						.filter(Boolean)
						.map(async (accountId) => {
							try { await this.context.secrets.delete(SECRET_KEYS.tokenOverrideByAccountId(accountId)); } catch { /* ignore */ }
						})
				);
				await this.context.globalState.update(STORAGE_KEYS.knownAccounts, undefined);
				await this.context.globalState.update(STORAGE_KEYS.clusterAccountMap, undefined);
				return;
			}
			case 'clusterMap.set': {
				const clusterEndpoint = String(msg.clusterEndpoint || '').trim();
				const accountId = String(msg.accountId || '').trim();
				if (!clusterEndpoint || !accountId) {
					return;
				}
				const prev = this.readClusterAccountMap();
				prev[clusterEndpoint] = accountId;
				await this.context.globalState.update(STORAGE_KEYS.clusterAccountMap, prev);
				return;
			}
			case 'clusterMap.delete': {
				const clusterEndpoint = String(msg.clusterEndpoint || '').trim();
				if (!clusterEndpoint) {
					return;
				}
				const prev = this.readClusterAccountMap();
				delete prev[clusterEndpoint];
				await this.context.globalState.update(STORAGE_KEYS.clusterAccountMap, prev);
				return;
			}
			case 'clusterMap.resetAll': {
				await this.context.globalState.update(STORAGE_KEYS.clusterAccountMap, {});
				return;
			}
			case 'databases.set': {
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) {
					return;
				}
				const dbs = (Array.isArray(msg.databases) ? msg.databases : [])
					.map(x => String(x || '').trim())
					.filter(Boolean);
				const cached = this.readCachedDatabases();
				cached[connectionId] = dbs;
				await this.context.globalState.update(STORAGE_KEYS.cachedDatabases, cached);
				return;
			}
			case 'databases.delete': {
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) {
					return;
				}
				const cached = this.readCachedDatabases();
				delete cached[connectionId];
				await this.context.globalState.update(STORAGE_KEYS.cachedDatabases, cached);
				return;
			}
			case 'databases.resetAll': {
				await this.context.globalState.update(STORAGE_KEYS.cachedDatabases, {});
				return;
			}
			default:
				return;
		}
	}

	private buildHtml(webview: vscode.Webview): string {
		const nonce = String(Date.now()) + Math.random().toString(16).slice(2);
		const csp = [
			"default-src 'none'",
			"img-src data:",
			"style-src 'unsafe-inline'",
			`script-src 'nonce-${nonce}'`
		].join('; ');

		return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${VIEW_TITLE}</title>
	<style>
		:root { color-scheme: light dark; }
		body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-editor-foreground); padding: 16px; }
		h1 { font-size: 16px; margin: 0 0 12px 0; }
		.small { opacity: 0.8; font-size: 12px; }
		section { margin: 16px 0; padding: 12px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; }
		section > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
		button { font-family: inherit; }
		.iconButton { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent); background: transparent; color: var(--vscode-foreground); cursor: pointer; }
		.iconButton:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
		.iconButton:active { background: var(--vscode-toolbar-activeBackground, var(--vscode-list-activeSelectionBackground)); }
		.iconButton svg { width: 16px; height: 16px; fill: currentColor; }
		table { width: 100%; border-collapse: collapse; }
		th, td { border-bottom: 1px solid var(--vscode-editorWidget-border); padding: 6px 8px; vertical-align: top; }
		th { text-align: left; font-weight: 600; }
		code, pre, textarea, input { font-family: var(--vscode-editor-font-family); }
		textarea { width: 100%; min-height: 56px; }
		.rowActions { display: flex; gap: 6px; flex-wrap: wrap; }
		details pre { white-space: pre-wrap; word-break: break-all; }
		input[type="text"] { width: 100%; }
		.mono { font-family: var(--vscode-editor-font-family); }
		.twoPane { display: grid; grid-template-columns: 260px 1fr; gap: 10px; min-height: 220px; }
		.pane { border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; overflow: hidden; }
		.list { max-height: 320px; overflow: auto; }
		.listItem { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--vscode-editorWidget-border); cursor: pointer; }
		.listItem:last-child { border-bottom: none; }
		.listItem:hover { background: var(--vscode-list-hoverBackground); }
		.listItem.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
		.listItem .count { opacity: 0.8; font-size: 12px; }
		.dbToolbar { display: flex; gap: 6px; align-items: center; }
	</style>
</head>
<body>
	<h1>${VIEW_TITLE}</h1>
	<div class="small" id="lastUpdated">Loading…</div>

	<section>
		<header>
			<div>
				<div><strong>Cached authentication tokens</strong></div>
				<div class="small">Shows VS Code auth sessions for Kusto scope, plus optional token overrides.</div>
			</div>
			<div class="rowActions">
				<button class="iconButton" id="authReset" title="Reset auth cache" aria-label="Reset auth cache">
					<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5a7 7 0 0 1 6.32 4H16v2h6V5h-2v2.1A9 9 0 1 0 21 12h-2a7 7 0 1 1-7-7z"/></svg>
				</button>
			</div>
		</header>
		<div id="authContent"></div>
	</section>

	<section>
		<header>
			<div>
				<div><strong>Cached kusto connections</strong></div>
				<div class="small">Cluster → preferred account mapping (auth preference cache).</div>
			</div>
			<div class="rowActions">
				<button class="iconButton" id="clusterMapReset" title="Reset cluster/account map" aria-label="Reset cluster/account map">
					<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5a7 7 0 0 1 6.32 4H16v2h6V5h-2v2.1A9 9 0 1 0 21 12h-2a7 7 0 1 1-7-7z"/></svg>
				</button>
			</div>
		</header>
		<div id="clusterMapContent"></div>
	</section>

	<section>
		<header>
			<div>
				<div><strong>Cached database lists</strong></div>
				<div class="small">Select a cluster on the left to view and edit its cached databases.</div>
			</div>
			<div class="rowActions">
				<div class="dbToolbar">
					<button class="iconButton" id="dbSaveSelected" title="Save selected" aria-label="Save selected">
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3H5a2 2 0 0 0-2 2v14h18V7l-4-4zm2 14H5V5h11.17L19 7.83V17z"/><path d="M12 12a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm-5-7h8v4H7V5z"/></svg>
					</button>
					<button class="iconButton" id="dbCopySelected" title="Copy selected" aria-label="Copy selected">
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1z"/><path d="M20 5H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h12v14z"/></svg>
					</button>
					<button class="iconButton" id="dbResetSelected" title="Reset selected" aria-label="Reset selected">
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5a7 7 0 0 1 6.32 4H16v2h6V5h-2v2.1A9 9 0 1 0 21 12h-2a7 7 0 1 1-7-7z"/></svg>
					</button>
					<button class="iconButton" id="dbReset" title="Reset database cache" aria-label="Reset database cache">
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12v2H6V7zm2 3h8l-1 10H9L8 10zm3-6h2v2h-2V4z"/></svg>
					</button>
				</div>
			</div>
		</header>
		<div id="dbContent"></div>
	</section>

	<script nonce="${nonce}">
		var vscode = acquireVsCodeApi();
		var lastSnapshot = null;
		var selectedDbConnectionId = '';
		var LF = String.fromCharCode(10);
		var CR = String.fromCharCode(13);

		function escapeHtml(s) {
			var str = '';
			if (s !== null && s !== undefined) {
				str = String(s);
			}
			// Avoid replaceAll (and avoid fragile escapes in template literals).
			str = str.replace(/&/g, '&amp;');
			str = str.replace(/</g, '&lt;');
			str = str.replace(/>/g, '&gt;');
			str = str.replace(/"/g, '&quot;');
			str = str.replace(/'/g, '&#39;');
			return str;
		}

		function getArray(val) {
			return Array.isArray(val) ? val : [];
		}

		function getObject(val) {
			if (!val || typeof val !== 'object' || Array.isArray(val)) {
				return {};
			}
			return val;
		}

		function matchesSelector(el, selector) {
			var fn = el.matches || el.msMatchesSelector || el.webkitMatchesSelector;
			return fn ? fn.call(el, selector) : false;
		}

		function closest(el, selector) {
			var cur = el;
			while (cur && cur.nodeType === 1) {
				if (matchesSelector(cur, selector)) {
					return cur;
				}
				cur = cur.parentElement;
			}
			return null;
		}

		function findByDataAttr(tagName, attrName, attrValue) {
			var selector = tagName + '[' + attrName + ']';
			var nodes = document.querySelectorAll(selector);
			for (var i = 0; i < nodes.length; i++) {
				var node = nodes[i];
				if (node && node.getAttribute && node.getAttribute(attrName) === attrValue) {
					return node;
				}
			}
			return null;
		}

		function renderAuth(snapshot) {
			var el = document.getElementById('authContent');
			var auth = snapshot && snapshot.auth ? snapshot.auth : {};
			var sessions = getArray(auth.sessions);
			if (sessions.length === 0) {
				el.innerHTML = '<div class="small">No cached Kusto auth sessions found.</div>';
				return;
			}

			var html = '';
			html += '<table>';
			html += '<thead><tr>';
			html += '<th>Account</th>';
			html += '<th>Account Id</th>';
			html += '<th>Session Id</th>';
			html += '<th>Token</th>';
			html += '<th>Override</th>';
			html += '<th>Actions</th>';
			html += '</tr></thead>';
			html += '<tbody>';
			for (var i = 0; i < sessions.length; i++) {
				var s = sessions[i];
				var account = s && s.account ? s.account : { id: '', label: '' };
				var effectiveToken = s && s.effectiveToken ? String(s.effectiveToken) : '';
				var overrideVal = '';
				if (s && s.overrideToken) {
					overrideVal = String(s.overrideToken);
				}

				html += '<tr>';
				html += '<td>' + escapeHtml(account.label) + '</td>';
				html += '<td class="mono">' + escapeHtml(account.id) + '</td>';
				var sessionId = s && s.sessionId ? String(s.sessionId) : '';
				html += '<td class="mono">' + escapeHtml(sessionId) + '</td>';
				html += '<td>';
				html += '<button class="iconButton" data-copy="token" data-account-id="' + escapeHtml(account.id) + '" title="Copy token" aria-label="Copy token">';
				html += '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1z"/><path d="M20 5H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h12v14z"/></svg>';
				html += '</button>';
				html += '</td>';
				html += '<td>';
				html += '<textarea data-override-for="' + escapeHtml(account.id) + '" placeholder="(empty = use session token)">' + escapeHtml(overrideVal) + '</textarea>';
				html += '</td>';
				html += '<td>';
				html += '<div class="rowActions">';
				html += '<button class="iconButton" data-save-override="' + escapeHtml(account.id) + '" title="Save override" aria-label="Save override">';
				html += '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3H5a2 2 0 0 0-2 2v14h18V7l-4-4zm2 14H5V5h11.17L19 7.83V17z"/><path d="M7 5h8v4H7V5z"/></svg>';
				html += '</button>';
				html += '<button class="iconButton" data-clear-override="' + escapeHtml(account.id) + '" title="Clear override" aria-label="Clear override">';
				html += '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12v2H6V7zm2 3h8l-1 10H9L8 10zm3-6h2v2h-2V4z"/></svg>';
				html += '</button>';
				html += '</div>';
				html += '</td>';
				html += '</tr>';
			}
			html += '</tbody></table>';
			el.innerHTML = html;
		}

		function renderClusterMap(snapshot) {
			var el = document.getElementById('clusterMapContent');
			var auth = snapshot && snapshot.auth ? snapshot.auth : {};
			var map = getObject(auth.clusterAccountMap);
			var clusters = Object.keys(map);
			if (clusters.length === 0) {
				el.innerHTML = '<div class="small">No cached cluster/account mapping.</div>';
				return;
			}

			// Build label + token lookup tables.
			var knownAccounts = getArray(auth.knownAccounts);
			var labelById = {};
			for (var i = 0; i < knownAccounts.length; i++) {
				var a = knownAccounts[i];
				if (a && typeof a.id === 'string') {
					labelById[a.id] = a.label || '';
				}
			}

			var sessions = getArray(auth.sessions);
			var tokenByAccountId = {};
			for (var j = 0; j < sessions.length; j++) {
				var s = sessions[j];
				var account = s && s.account ? s.account : null;
				if (account && account.id) {
					tokenByAccountId[account.id] = s && s.effectiveToken ? String(s.effectiveToken) : '';
				}
			}

			var html = '';
			html += '<table>';
			html += '<thead><tr>';
			html += '<th>Cluster</th>';
			html += '<th>Account</th>';
			html += '<th>Account Id</th>';
			html += '<th>Token</th>';
			html += '<th>Actions</th>';
			html += '</tr></thead>';
			html += '<tbody>';
			for (var k = 0; k < clusters.length; k++) {
				var cluster = clusters[k];
				var accountId = map[cluster] ? String(map[cluster]) : '';
				var label = labelById[accountId] || '';
				var token = tokenByAccountId[accountId] || '';
				html += '<tr>';
				html += '<td class="mono">' + escapeHtml(cluster) + '</td>';
				html += '<td>' + escapeHtml(label) + '</td>';
				html += '<td><input type="text" value="' + escapeHtml(accountId) + '" data-cluster-account-id="' + escapeHtml(cluster) + '" /></td>';
				html += '<td><details><summary>Show token</summary><pre>' + escapeHtml(token) + '</pre></details></td>';
				html += '<td><div class="rowActions">';
				html += '<button class="iconButton" data-cluster-save="' + escapeHtml(cluster) + '" title="Save" aria-label="Save">';
				html += '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3H5a2 2 0 0 0-2 2v14h18V7l-4-4zm2 14H5V5h11.17L19 7.83V17z"/><path d="M7 5h8v4H7V5z"/></svg>';
				html += '</button>';
				html += '<button class="iconButton" data-cluster-copy="' + escapeHtml(cluster) + '" title="Copy" aria-label="Copy">';
				html += '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1z"/><path d="M20 5H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h12v14z"/></svg>';
				html += '</button>';
				html += '<button class="iconButton" data-cluster-delete="' + escapeHtml(cluster) + '" title="Delete" aria-label="Delete">';
				html += '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12v2H6V7zm2 3h8l-1 10H9L8 10zm3-6h2v2h-2V4z"/></svg>';
				html += '</button>';
				html += '</div></td>';
				html += '</tr>';
			}
			html += '</tbody></table>';
			el.innerHTML = html;
		}

		function renderDatabases(snapshot) {
			var el = document.getElementById('dbContent');
			var cached = getObject(snapshot ? snapshot.cachedDatabases : null);
			var connectionIds = Object.keys(cached);
			if (connectionIds.length === 0) {
				el.innerHTML = '<div class="small">No cached database lists.</div>';
				selectedDbConnectionId = '';
				return;
			}

			// Build connection lookup table.
			var connById = {};
			var conns = getArray(snapshot ? snapshot.connections : null);
			for (var i = 0; i < conns.length; i++) {
				var c = conns[i];
				if (c && c.id) {
					connById[c.id] = c;
				}
			}

			// Ensure selection is stable.
			if (!selectedDbConnectionId) {
				selectedDbConnectionId = connectionIds[0];
			} else {
				var stillExists = false;
				for (var i = 0; i < connectionIds.length; i++) {
					if (connectionIds[i] === selectedDbConnectionId) {
						stillExists = true;
						break;
					}
				}
				if (!stillExists) {
					selectedDbConnectionId = connectionIds[0];
				}
			}

			var html = '';
			html += '<div class="twoPane">';
			html += '<div class="pane list" id="dbList">';
			for (var j = 0; j < connectionIds.length; j++) {
				var connectionId = connectionIds[j];
				var list = getArray(cached[connectionId]);
				var conn = connById[connectionId];
				var title = connectionId;
				if (conn && conn.name && conn.clusterUrl) {
					title = conn.name + ' — ' + conn.clusterUrl;
				}
				var cls = 'listItem';
				if (connectionId === selectedDbConnectionId) {
					cls += ' selected';
				}
				html += '<div class="' + cls + '" data-db-select="' + escapeHtml(connectionId) + '">';
				html += '<div>' + escapeHtml(title) + '</div>';
				html += '<div class="count">' + list.length + '</div>';
				html += '</div>';
			}
			html += '</div>';
			html += '<div class="pane" id="dbDetail">';
			// Detail
			var selected = selectedDbConnectionId;
			var selectedList = getArray(cached[selected]);
			var databasesText = selectedList.join(LF);
			var selectedConn = connById[selected];
			var selectedTitle = selected;
			if (selectedConn && selectedConn.name && selectedConn.clusterUrl) {
				selectedTitle = selectedConn.name + ' — ' + selectedConn.clusterUrl;
			}
			html += '<div style="padding:10px;">';
			html += '<div class="small" style="margin-bottom:6px;">' + escapeHtml(selectedTitle) + '</div>';
			html += '<textarea data-dbs-selected="1" data-dbs-for="' + escapeHtml(selected) + '">' + escapeHtml(databasesText) + '</textarea>';
			html += '</div>';
			html += '</div>';
			html += '</div>';
			el.innerHTML = html;
		}

		function renderAll(snapshot) {
			var lastUpdated = document.getElementById('lastUpdated');
			lastUpdated.textContent = 'Last updated: ' + new Date(snapshot.timestamp).toLocaleString();
			renderAuth(snapshot);
			renderClusterMap(snapshot);
			renderDatabases(snapshot);
		}

		function requestSnapshot() {
			vscode.postMessage({ type: 'requestSnapshot' });
		}

		window.addEventListener('message', function (event) {
			var msg = event.data;
			if (msg && msg.type === 'snapshot') {
				lastSnapshot = msg.snapshot;
				renderAll(lastSnapshot);
			}
		});

		document.addEventListener('click', function (e) {
			var t = e.target;
			if (!t || t.nodeType !== 1) {
				return;
			}

			if (t.id === 'authReset') {
				vscode.postMessage({ type: 'auth.resetAll' });
				requestSnapshot();
				return;
			}
			if (t.id === 'clusterMapReset') {
				vscode.postMessage({ type: 'clusterMap.resetAll' });
				requestSnapshot();
				return;
			}
			if (t.id === 'dbReset') {
				vscode.postMessage({ type: 'databases.resetAll' });
				requestSnapshot();
				return;
			}
			if (t.id === 'dbSaveSelected') {
				var connectionId = selectedDbConnectionId;
				if (!connectionId) {
					return;
				}
				var ta = findByDataAttr('textarea', 'data-dbs-for', connectionId);
				var text = '';
				if (ta && typeof ta.value === 'string') {
					text = ta.value;
				}
				var normalized = String(text).split(CR).join('');
				var parts = normalized.split(LF);
				var dbs = [];
				for (var i = 0; i < parts.length; i++) {
					var val = String(parts[i] || '').trim();
					if (val) {
						dbs.push(val);
					}
				}
				vscode.postMessage({ type: 'databases.set', connectionId: connectionId, databases: dbs });
				requestSnapshot();
				return;
			}
			if (t.id === 'dbCopySelected') {
				var connectionId = selectedDbConnectionId;
				if (!connectionId) {
					return;
				}
				var snap = lastSnapshot;
				var dbs = [];
				if (snap && snap.cachedDatabases && typeof snap.cachedDatabases === 'object') {
					var v = snap.cachedDatabases[connectionId];
					if (Array.isArray(v)) {
						dbs = v;
					}
				}
				vscode.postMessage({ type: 'copyToClipboard', text: JSON.stringify(dbs, null, 2) });
				return;
			}
			if (t.id === 'dbResetSelected') {
				var connectionId = selectedDbConnectionId;
				if (!connectionId) {
					return;
				}
				vscode.postMessage({ type: 'databases.delete', connectionId: connectionId });
				requestSnapshot();
				return;
			}

			var dbSelect = closest(t, '[data-db-select]');
			if (dbSelect) {
				var connectionId = String(dbSelect.getAttribute('data-db-select') || '');
				if (connectionId) {
					selectedDbConnectionId = connectionId;
					if (lastSnapshot) {
						renderDatabases(lastSnapshot);
					}
				}
				return;
			}

			var copyBtn = closest(t, '[data-copy="token"]');
			if (copyBtn) {
				var accountId = String(copyBtn.getAttribute('data-account-id') || '');
				var snap = lastSnapshot;
				var token = '';
				if (snap && snap.auth && Array.isArray(snap.auth.sessions)) {
					var sessions = snap.auth.sessions;
					for (var i = 0; i < sessions.length; i++) {
						var s = sessions[i];
						if (s && s.account && s.account.id === accountId) {
							token = String(s.effectiveToken || '');
							break;
						}
					}
				}
				vscode.postMessage({ type: 'copyToClipboard', text: token });
				return;
			}

			var saveOverride = closest(t, '[data-save-override]');
			if (saveOverride) {
				var accountId = String(saveOverride.getAttribute('data-save-override') || '');
				var ta = findByDataAttr('textarea', 'data-override-for', accountId);
				var tokenVal = '';
				if (ta && typeof ta.value === 'string') {
					tokenVal = ta.value;
				}
				vscode.postMessage({ type: 'auth.setTokenOverride', accountId: accountId, token: tokenVal });
				requestSnapshot();
				return;
			}

			var clearOverride = closest(t, '[data-clear-override]');
			if (clearOverride) {
				var accountId = String(clearOverride.getAttribute('data-clear-override') || '');
				vscode.postMessage({ type: 'auth.clearTokenOverride', accountId: accountId });
				requestSnapshot();
				return;
			}

			var clusterSave = closest(t, '[data-cluster-save]');
			if (clusterSave) {
				var clusterEndpoint = String(clusterSave.getAttribute('data-cluster-save') || '');
				var inp = findByDataAttr('input', 'data-cluster-account-id', clusterEndpoint);
				var accountId = '';
				if (inp && typeof inp.value === 'string') {
					accountId = inp.value;
				}
				vscode.postMessage({ type: 'clusterMap.set', clusterEndpoint: clusterEndpoint, accountId: accountId });
				requestSnapshot();
				return;
			}

			var clusterCopy = closest(t, '[data-cluster-copy]');
			if (clusterCopy) {
				var clusterEndpoint = String(clusterCopy.getAttribute('data-cluster-copy') || '');
				var snap = lastSnapshot;
				var accountId = '';
				if (snap && snap.auth && snap.auth.clusterAccountMap && typeof snap.auth.clusterAccountMap === 'object') {
					accountId = String(snap.auth.clusterAccountMap[clusterEndpoint] || '');
				}
				vscode.postMessage({ type: 'copyToClipboard', text: JSON.stringify({ clusterEndpoint: clusterEndpoint, accountId: accountId }, null, 2) });
				return;
			}

			var clusterDelete = closest(t, '[data-cluster-delete]');
			if (clusterDelete) {
				var clusterEndpoint = String(clusterDelete.getAttribute('data-cluster-delete') || '');
				vscode.postMessage({ type: 'clusterMap.delete', clusterEndpoint: clusterEndpoint });
				requestSnapshot();
				return;
			}


		});

		requestSnapshot();
		setInterval(requestSnapshot, 1500);
	</script>
</body>
</html>`;
	}
}
