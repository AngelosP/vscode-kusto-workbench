import * as vscode from 'vscode';
import { ConnectionManager, KustoConnection } from './connectionManager';
import { KustoQueryClient } from './kustoClient';

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
	| { type: 'databases.delete'; clusterKey: string }
	| { type: 'databases.refresh'; clusterKey: string };

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
	private readonly kustoClient: KustoQueryClient;

	private constructor(
		private readonly context: vscode.ExtensionContext,
		extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager
	) {
		this.kustoClient = new KustoQueryClient(this.context);
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
		return this.migrateCachedDatabasesToClusterKeys(next);
	}

	private getClusterCacheKey(clusterUrlRaw: string): string {
		try {
			let u = String(clusterUrlRaw || '').trim();
			if (!u) {
				return '';
			}
			if (!/^https?:\/\//i.test(u)) {
				u = 'https://' + u;
			}
			const parsed = new URL(u);
			const host = String(parsed.hostname || '').trim().toLowerCase();
			return host || String(clusterUrlRaw || '').trim().toLowerCase();
		} catch {
			return String(clusterUrlRaw || '').trim().toLowerCase();
		}
	}

	private migrateCachedDatabasesToClusterKeys(raw: Record<string, string[]>): Record<string, string[]> {
		const src = raw && typeof raw === 'object' ? raw : {};
		const connections = this.connectionManager.getConnections();
		const connById = new Map<string, KustoConnection>(connections.map((c) => [c.id, c]));

		let changed = false;
		const next: Record<string, string[]> = {};
		for (const [k, v] of Object.entries(src)) {
			const keyRaw = String(k || '').trim();
			if (!keyRaw) {
				changed = true;
				continue;
			}

			const list = (Array.isArray(v) ? v : [])
				.map((d) => String(d || '').trim())
				.filter(Boolean);

			const conn = connById.get(keyRaw);
			const clusterKey = conn ? this.getClusterCacheKey(conn.clusterUrl) : this.getClusterCacheKey(keyRaw);
			if (clusterKey !== keyRaw) {
				changed = true;
			}

			const existing = next[clusterKey] || [];
			const merged = [...existing, ...list]
				.map((d) => String(d || '').trim())
				.filter(Boolean);
			const deduped: string[] = [];
			const seen = new Set<string>();
			for (const d of merged) {
				const lower = d.toLowerCase();
				if (!seen.has(lower)) {
					seen.add(lower);
					deduped.push(d);
				}
			}
			next[clusterKey] = deduped;
		}

		if (changed) {
			void this.context.globalState.update(STORAGE_KEYS.cachedDatabases, next);
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
				// User asked: "Delete token" should forget this account as if never used.
				// We can't delete VS Code's underlying auth session via stable API, but we can
				// forget our extension's persisted account history and mappings.
				try {
					const prevKnown = this.readKnownAccounts();
					const nextKnown = prevKnown.filter(a => String(a?.id || '').trim() !== accountId);
					await this.context.globalState.update(STORAGE_KEYS.knownAccounts, nextKnown);
				} catch { /* ignore */ }
				// Also clear all cached cluster->account associations.
				try { await this.context.globalState.update(STORAGE_KEYS.clusterAccountMap, {}); } catch { /* ignore */ }
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
			case 'databases.delete': {
				const clusterKey = String(msg.clusterKey || '').trim().toLowerCase();
				if (!clusterKey) {
					return;
				}
				const cached = this.readCachedDatabases();
				delete cached[clusterKey];
				await this.context.globalState.update(STORAGE_KEYS.cachedDatabases, cached);
				return;
			}
			case 'databases.refresh': {
				const clusterKey = String(msg.clusterKey || '').trim().toLowerCase();
				if (!clusterKey) {
					return;
				}

				const cached = this.readCachedDatabases();
				const cachedBefore = (cached[clusterKey] ?? []).filter(Boolean);

				// Prefer a saved connection's clusterUrl for this clusterKey when available.
				let connection: KustoConnection | undefined;
				try {
					const conns = this.connectionManager.getConnections();
					for (const c of conns) {
						if (!c || !c.clusterUrl) {
							continue;
						}
						const key = this.getClusterCacheKey(c.clusterUrl);
						if (key === clusterKey) {
							connection = c;
							break;
						}
					}
				} catch {
					connection = undefined;
				}

				if (!connection) {
					// Fallback: construct a minimal connection using the hostname key.
					const url = /^https?:\/\//i.test(clusterKey) ? clusterKey : `https://${clusterKey}`;
					connection = { id: `cluster_${clusterKey}`, name: clusterKey, clusterUrl: url };
				}

				try {
					const databasesRaw = await this.kustoClient.getDatabases(connection, true);
					const databases = (Array.isArray(databasesRaw) ? databasesRaw : [])
						.map((d) => String(d || '').trim())
						.filter(Boolean)
						.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

					// Don't wipe a previously-good cached list with an empty refresh result.
					if (databases.length > 0 || cachedBefore.length === 0) {
						cached[clusterKey] = databases;
						await this.context.globalState.update(STORAGE_KEYS.cachedDatabases, cached);
						return;
					}

					void vscode.window.showWarningMessage(
						"Couldn't refresh the database list (received 0 databases). Keeping the previous cached list."
					);
					return;
				} catch (error) {
					const msgText = this.kustoClient.isAuthenticationError(error)
						? 'Failed to refresh the database list due to an authentication error. Try running a query against the cluster to sign in, then refresh again.'
						: 'Failed to refresh the database list. Check your connection and try again.';
					void vscode.window.showErrorMessage(msgText);
					return;
				}
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
		/* Ensure borders/padding don't cause height overflow + clipping in fixed-height panes. */
		*, *::before, *::after { box-sizing: border-box; }

		/* VS Code injects theme classes on <body> (vscode-light/vscode-dark/etc.) and updates them on theme switch. */
		body.vscode-light, body.vscode-high-contrast-light { color-scheme: light; }
		body.vscode-dark, body.vscode-high-contrast { color-scheme: dark; }

		body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 16px; }
		h1 { font-size: 16px; margin: 0 0 12px 0; }
		.small { opacity: 0.8; font-size: 12px; }
		section { margin: 16px 0; padding: 12px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 0; background: var(--vscode-editorWidget-background); max-height: 500px; overflow: auto; }
		section > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
		.sectionBody { min-height: 0; }
		section.dbSection { overflow: hidden; display: flex; flex-direction: column; height: 500px; }
		section.dbSection > header { flex: 0 0 auto; }
		section.dbSection #dbContent { flex: 1 1 auto; min-height: 0; overflow: hidden; }
		button { font-family: inherit; }
		.iconButton { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent); background: transparent; color: var(--vscode-foreground); cursor: pointer; }
		.iconButton:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
		.iconButton:active { background: var(--vscode-toolbar-activeBackground, var(--vscode-list-activeSelectionBackground)); }
		.iconButton svg { width: 16px; height: 16px; fill: currentColor; }
		table { width: 100%; border-collapse: collapse; }
		th, td { border-bottom: 1px solid var(--vscode-editorWidget-border); padding: 6px 8px; vertical-align: top; }
		th { text-align: left; font-weight: 600; }
		.tokenCol { white-space: nowrap; min-width: 92px; }
		code, pre, textarea, input { font-family: var(--vscode-editor-font-family); }
		textarea { width: 100%; min-height: 56px; }
		.rowActions { display: flex; gap: 6px; flex-wrap: wrap; }
		details pre { white-space: pre-wrap; word-break: break-all; }
		input[type="text"] { width: 100%; }
		select { width: 100%; }

		/* Reuse the dropdown control styling used by the query editor (favorites/cluster/database). */
		.select-wrapper {
			position: relative;
			min-width: 40px;
			display: flex;
			align-items: center;
		}
		.select-wrapper.has-icon .select-icon {
			position: absolute;
			left: 8px;
			top: 50%;
			transform: translateY(-50%);
			pointer-events: none;
			z-index: 1;
			opacity: 0.95;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 16px;
			height: 16px;
		}
		.select-wrapper.has-icon select { padding-left: 28px; }
		.select-wrapper select {
			background: var(--vscode-dropdown-background);
			color: var(--vscode-dropdown-foreground);
			border: 1px solid var(--vscode-dropdown-border);
			padding: 4px 24px 4px 8px;
			font-size: 12px;
			border-radius: 2px;
			width: 100%;
			cursor: pointer;
		}
		.select-wrapper select:disabled { opacity: 0.5; cursor: not-allowed; }

		.mono { font-family: var(--vscode-editor-font-family); }
		.twoPane { display: grid; grid-template-columns: 260px 1fr; gap: 10px; height: 100%; min-height: 0; align-items: stretch; }
		.pane { border: 1px solid var(--vscode-editorWidget-border); border-radius: 0; overflow: hidden; min-height: 0; }
		.list { height: 100%; overflow-y: scroll; overflow-x: hidden; }
		#dbDetail { height: 100%; overflow: auto; }
		.scrollPane:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
		.dbDetailHeader { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }

		/* Make scrollbars visible in webview panes (theme-aware, no hard-coded colors). */
		.scrollPane { scrollbar-gutter: stable; }
		.scrollPane::-webkit-scrollbar { width: 12px; height: 12px; }
		.scrollPane::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 0; }
		.scrollPane::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
		.scrollPane::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground); }
		.scrollPane::-webkit-scrollbar-corner { background: transparent; }
		.listItem { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--vscode-editorWidget-border); cursor: pointer; }
		.listItem:last-child { border-bottom: none; }
		.listItem:hover { background: var(--vscode-list-hoverBackground); }
		.listItem.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
		.listItem .count { opacity: 0.8; font-size: 12px; }
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
		</header>
		<div id="authContent" class="sectionBody"></div>
	</section>

	<section>
		<header>
			<div>
				<div><strong>Cached associations of clusters to authentication accounts</strong></div>
				<div class="small">Cluster → preferred account mapping (auth preference cache).</div>
			</div>
		</header>
		<div id="clusterMapContent" class="sectionBody"></div>
	</section>

	<section class="dbSection">
		<header>
			<div>
				<div><strong>Cached list of databases (per cluster)</strong></div>
				<div class="small">Select a cluster on the left to view its cached databases.</div>
			</div>
		</header>
		<div id="dbContent" class="sectionBody"></div>
	</section>

	<script nonce="${nonce}">
		var vscode = acquireVsCodeApi();
		var lastSnapshot = null;
		var selectedDbClusterKey = '';
		var requestPending = false;
		var lastAccountsKey = '';
		var lastAuthKey = '';
		var lastClusterKey = '';
		var lastDbKey = '';
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

		function isElement(el, tagName) {
			try {
				return !!(el && el.tagName && String(el.tagName).toLowerCase() === String(tagName).toLowerCase());
			} catch {
				return false;
			}
		}

		function getActiveElement() {
			try { return document.activeElement; } catch { return null; }
		}

		function isEditingAuth() {
			var ae = getActiveElement();
			return !!(ae && isElement(ae, 'textarea') && ae.getAttribute && ae.getAttribute('data-override-for'));
		}

		function isEditingClusterMap() {
			var ae = getActiveElement();
			return !!(ae && isElement(ae, 'select') && ae.getAttribute && ae.getAttribute('data-cluster-select'));
		}

		function isEditingDatabases() {
			// Database lists are read-only in this viewer (table display).
			return false;
		}

		function buildAccountsKey(snapshot) {
			var auth = snapshot && snapshot.auth ? snapshot.auth : {};
			var known = getArray(auth.knownAccounts);
			var sessions = getArray(auth.sessions);
			var map = {};
			for (var i = 0; i < known.length; i++) {
				var a = known[i];
				if (a && a.id) {
					map[String(a.id)] = String(a.label || a.id);
				}
			}
			for (var j = 0; j < sessions.length; j++) {
				var s = sessions[j];
				var acc = s && s.account ? s.account : null;
				if (acc && acc.id) {
					if (!map[String(acc.id)]) {
						map[String(acc.id)] = String(acc.label || acc.id);
					}
				}
			}
			var ids = Object.keys(map);
			ids.sort();
			var parts = [];
			for (var k = 0; k < ids.length; k++) {
				var id = ids[k];
				parts.push(id + '=' + map[id]);
			}
			return parts.join('|');
		}

		function buildAuthKey(snapshot, accountsKey) {
			var auth = snapshot && snapshot.auth ? snapshot.auth : {};
			var sessions = getArray(auth.sessions);
			// We avoid including access tokens (huge and not rendered). Overrides affect UI, so include them.
			var ids = [];
			var byId = {};
			for (var i = 0; i < sessions.length; i++) {
				var s = sessions[i];
				var acc = s && s.account ? s.account : null;
				if (acc && acc.id) {
					var id = String(acc.id);
					ids.push(id);
					var ov = (s && s.overrideToken) ? String(s.overrideToken) : '';
					byId[id] = ov;
				}
			}
			ids.sort();
			var parts = ['accounts=' + String(accountsKey || '')];
			for (var j = 0; j < ids.length; j++) {
				var id2 = ids[j];
				parts.push(id2 + ':ov=' + (byId[id2] || ''));
			}
			return parts.join('|');
		}

		function buildClusterKey(snapshot, accountsKey) {
			var auth = snapshot && snapshot.auth ? snapshot.auth : {};
			var map = getObject(auth.clusterAccountMap);
			var clusters = Object.keys(map);
			clusters.sort();
			var parts = ['accounts=' + String(accountsKey || '')];
			for (var i = 0; i < clusters.length; i++) {
				var c = clusters[i];
				parts.push(String(c) + '=' + String(map[c] || ''));
			}
			return parts.join('|');
		}

		function buildDbKey(snapshot) {
			var cached = getObject(snapshot ? snapshot.cachedDatabases : null);
			var clusterKeys = Object.keys(cached);
			clusterKeys.sort();
			var parts = [];
			// Include derived cluster labels so left list stays accurate.
			var conns = getArray(snapshot ? snapshot.connections : null);
			var labelByCluster = {};
			for (var i = 0; i < conns.length; i++) {
				var c = conns[i];
				try {
					if (c && c.clusterUrl) {
						var raw = String(c.clusterUrl || '');
						var u = raw;
						if (u && !/^https?:\\/\\//i.test(u)) {
							u = 'https://' + u;
						}
						var host = '';
						try {
							host = String(new URL(u).hostname || '').trim().toLowerCase();
						} catch {
							host = String(raw || '').trim().toLowerCase();
						}
						if (host && !labelByCluster[host]) {
							labelByCluster[host] = String((c.name || '') + '|' + (c.clusterUrl || ''));
						}
					}
				} catch { /* ignore */ }
			}
			for (var j = 0; j < clusterKeys.length; j++) {
				var id = clusterKeys[j];
				var list = getArray(cached[id]);
				// Preserve order as stored (so UI reflects exact cache), but join into a stable string.
				parts.push(id + ':' + (labelByCluster[id] || '') + ':' + list.join(String.fromCharCode(31)));
			}
			return parts.join(String.fromCharCode(30));
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
			html += '<th class="tokenCol">Token</th>';
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
				html += '<td class="tokenCol">';
				html += '<div class="rowActions">';
				html += '<button class="iconButton" data-copy="token" data-account-id="' + escapeHtml(account.id) + '" title="Copy token" aria-label="Copy token">';
				html += '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1z"/><path d="M20 5H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h12v14z"/></svg>';
				html += '</button>';
				html += '<button class="iconButton" data-clear-override="' + escapeHtml(account.id) + '" title="Delete token" aria-label="Delete token">';
				html += '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12v2H6V7zm2 3h8l-1 10H9L8 10zm3-6h2v2h-2V4z"/></svg>';
				html += '</button>';
				html += '</div>';
				html += '</td>';
				html += '<td>';
				html += '<textarea data-override-for="' + escapeHtml(account.id) + '" placeholder="(empty = use session token)">' + escapeHtml(overrideVal) + '</textarea>';
				html += '</td>';
				html += '<td>';
				html += '<div class="rowActions">';
				html += '<button class="iconButton" data-save-override="' + escapeHtml(account.id) + '" title="Save override" aria-label="Save override">';
				html += '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3H5a2 2 0 0 0-2 2v14h18V7l-4-4zm2 14H5V5h11.17L19 7.83V17z"/><path d="M7 5h8v4H7V5z"/></svg>';
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

			function shortClusterName(clusterEndpoint) {
				var s = String(clusterEndpoint || '');
				var lower = s.toLowerCase();
				if (lower.indexOf('https://') === 0) {
					s = s.slice(8);
				} else if (lower.indexOf('http://') === 0) {
					s = s.slice(7);
				}
				var slashIdx = s.indexOf('/');
				if (slashIdx >= 0) {
					s = s.slice(0, slashIdx);
				}
				var colonIdx = s.indexOf(':');
				if (colonIdx >= 0) {
					s = s.slice(0, colonIdx);
				}
				var suffix = '.kusto.windows.net';
				var sLower = s.toLowerCase();
				var suffixLower = suffix;
				if (sLower.length >= suffixLower.length && sLower.lastIndexOf(suffixLower) === (sLower.length - suffixLower.length)) {
					s = s.slice(0, s.length - suffixLower.length);
				}
				return s || String(clusterEndpoint || '');
			}

			// Build unique accounts list (based on known accounts and any session-derived accounts).
			var knownAccounts = getArray(auth.knownAccounts);
			var sessions = getArray(auth.sessions);
			var seen = {};
			var accounts = [];
			for (var i = 0; i < knownAccounts.length; i++) {
				var a = knownAccounts[i];
				if (a && typeof a.id === 'string' && a.id && !seen[a.id]) {
					seen[a.id] = true;
					accounts.push({ id: a.id, label: a.label || a.id });
				}
			}
			for (var j = 0; j < sessions.length; j++) {
				var s = sessions[j];
				var acc = s && s.account ? s.account : null;
				if (acc && acc.id && !seen[acc.id]) {
					seen[acc.id] = true;
					accounts.push({ id: acc.id, label: acc.label || acc.id });
				}
			}

			var html = '';
			html += '<table>';
			html += '<thead><tr>';
			html += '<th>Cluster</th>';
			html += '<th>Account</th>';
			html += '</tr></thead>';
			html += '<tbody>';
			for (var k = 0; k < clusters.length; k++) {
				var cluster = clusters[k];
				var accountId = map[cluster] ? String(map[cluster]) : '';

				// Ensure current value appears even if it isn't in the known list.
				if (accountId && !seen[accountId]) {
					seen[accountId] = true;
					accounts.push({ id: accountId, label: accountId });
				}

				var selectHtml = '';
				selectHtml += '<div class="select-wrapper" title="Select account">';
				selectHtml += '<select data-cluster-select="' + escapeHtml(cluster) + '">';
				selectHtml += '<option value="">(none)</option>';
				for (var aIdx = 0; aIdx < accounts.length; aIdx++) {
					var opt = accounts[aIdx];
					var sel = (opt.id === accountId) ? ' selected' : '';
					selectHtml += '<option value="' + escapeHtml(opt.id) + '"' + sel + '>' + escapeHtml(opt.label) + '</option>';
				}
				selectHtml += '</select>';
				selectHtml += '</div>';

				html += '<tr>';
				html += '<td class="mono" title="' + escapeHtml(cluster) + '">' + escapeHtml(shortClusterName(cluster)) + '</td>';
				html += '<td>' + selectHtml + '</td>';
				html += '</tr>';
			}
			html += '</tbody></table>';
			el.innerHTML = html;
		}

		function renderDatabases(snapshot) {
			var el = document.getElementById('dbContent');
			var prevList = document.getElementById('dbList');
			var prevScrollTop = 0;
			var prevFocusedId = '';
			try {
				var ae = getActiveElement();
				prevFocusedId = (ae && ae.id) ? String(ae.id) : '';
			} catch { /* ignore */ }
			try {
				prevScrollTop = prevList && typeof prevList.scrollTop === 'number' ? prevList.scrollTop : 0;
			} catch { /* ignore */ }
			var cached = getObject(snapshot ? snapshot.cachedDatabases : null);
			var clusterKeys = Object.keys(cached);
			clusterKeys.sort();
			if (clusterKeys.length === 0) {
				el.innerHTML = '<div class="small">No cached database lists.</div>';
				selectedDbClusterKey = '';
				return;
			}

			function shortClusterName(host) {
				var s = String(host || '').trim();
				var suffix = '.kusto.windows.net';
				var lower = s.toLowerCase();
				if (lower.length >= suffix.length && lower.lastIndexOf(suffix) === (lower.length - suffix.length)) {
					s = s.slice(0, s.length - suffix.length);
				}
				return s || String(host || '');
			}

			// Build cluster label lookup table (from connections).
			var conns = getArray(snapshot ? snapshot.connections : null);
			var labelByCluster = {};
			for (var i = 0; i < conns.length; i++) {
				var c = conns[i];
				try {
					if (c && c.clusterUrl) {
						var raw = String(c.clusterUrl || '');
						var u = raw;
						if (u && !/^https?:\\/\\//i.test(u)) {
							u = 'https://' + u;
						}
						var host = '';
						try {
							host = String(new URL(u).hostname || '').trim().toLowerCase();
						} catch {
							host = String(raw || '').trim().toLowerCase();
						}
						if (host && !labelByCluster[host]) {
							labelByCluster[host] = String(c.clusterUrl || host);
						}
					}
				} catch { /* ignore */ }
			}

			// Ensure selection is stable.
			if (!selectedDbClusterKey) {
				selectedDbClusterKey = clusterKeys[0];
			} else {
				var stillExists = false;
				for (var i = 0; i < clusterKeys.length; i++) {
					if (clusterKeys[i] === selectedDbClusterKey) {
						stillExists = true;
						break;
					}
				}
				if (!stillExists) {
					selectedDbClusterKey = clusterKeys[0];
				}
			}

			var html = '';
			html += '<div class="twoPane">';
			html += '<div class="pane list scrollPane" id="dbList" tabindex="0" role="listbox" aria-label="Clusters">';
			for (var j = 0; j < clusterKeys.length; j++) {
				var clusterKey = clusterKeys[j];
				var list = getArray(cached[clusterKey]);
				var title = labelByCluster[clusterKey] || clusterKey;
				var cls = 'listItem';
				if (clusterKey === selectedDbClusterKey) {
					cls += ' selected';
				}
				html += '<div class="' + cls + '" data-db-select="' + escapeHtml(clusterKey) + '">';
				html += '<div title="' + escapeHtml(title) + '">' + escapeHtml(shortClusterName(clusterKey)) + '</div>';
				html += '<div class="count">' + list.length + '</div>';
				html += '</div>';
			}
			html += '</div>';
			html += '<div class="pane scrollPane" id="dbDetail" tabindex="0" aria-label="Databases">';
			// Detail
			var selected = selectedDbClusterKey;
			var selectedList = getArray(cached[selected]);
			var selectedTitle = labelByCluster[selected] || selected;
			html += '<div style="padding:10px;">';
			html += '<div class="dbDetailHeader">';
			html += '<div class="small">' + escapeHtml(selectedTitle) + '</div>';
			html += '<div class="rowActions">';
			html += '<button class="iconButton" data-db-refresh="' + escapeHtml(selected) + '" title="Refresh the list of cached databases for selected cluster" aria-label="Refresh the list of cached databases for selected cluster">';
			html += '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5a7 7 0 0 1 6.32 4H16v2h6V5h-2v2.1A9 9 0 1 0 21 12h-2a7 7 0 1 1-7-7z"/></svg>';
			html += '</button>';
			html += '<button class="iconButton" data-db-delete="' + escapeHtml(selected) + '" title="Delete the list of cached databases for the selected cluster" aria-label="Delete the list of cached databases for the selected cluster">';
			html += '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12v2H6V7zm2 3h8l-1 10H9L8 10zm3-6h2v2h-2V4z"/></svg>';
			html += '</button>';
			html += '</div>';
			html += '</div>';
			html += '<table>';
			html += '<thead><tr><th>Database</th></tr></thead>';
			html += '<tbody>';
			for (var r = 0; r < selectedList.length; r++) {
				var db = String(selectedList[r] || '').trim();
				if (!db) continue;
				html += '<tr><td class="mono">' + escapeHtml(db) + '</td></tr>';
			}
			html += '</tbody>';
			html += '</table>';
			html += '</div>';
			html += '</div>';
			html += '</div>';
			el.innerHTML = html;
			// Preserve left list scroll position across re-renders (including when selection changes).
			try {
				var nextList = document.getElementById('dbList');
				if (nextList && typeof nextList.scrollTop === 'number') {
					nextList.scrollTop = prevScrollTop;
					// Restore focus if the user was navigating with the keyboard.
					if (prevFocusedId === 'dbList' && nextList.focus) {
						nextList.focus();
					}
					var items = nextList.querySelectorAll('[data-db-select]');
					for (var i = 0; i < items.length; i++) {
						var node = items[i];
						if (!node || !node.getAttribute) continue;
						if (node.getAttribute('data-db-select') === selectedDbClusterKey) {
							if (node.scrollIntoView) {
								node.scrollIntoView({ block: 'nearest' });
							}
							break;
						}
					}
				}
				if (prevFocusedId === 'dbDetail') {
					var nextDetail = document.getElementById('dbDetail');
					if (nextDetail && nextDetail.focus) {
						nextDetail.focus();
					}
				}
			} catch { /* ignore */ }
		}

		function renderAll(snapshot) {
			// Always update the “Last updated” label so we can see refresh is succeeding,
			// even when nothing changed and we skip re-rendering sections.
			try {
				var lastUpdated = document.getElementById('lastUpdated');
				lastUpdated.textContent = 'Last updated: ' + new Date(snapshot.timestamp).toLocaleString();
			} catch { /* ignore */ }

			var accountsKey = buildAccountsKey(snapshot);
			var authKey = buildAuthKey(snapshot, accountsKey);
			var clusterKey = buildClusterKey(snapshot, accountsKey);
			var dbKey = buildDbKey(snapshot);

			// Only re-render the sections that actually changed. This avoids resetting controls while typing.
			var shouldAuth = (accountsKey !== lastAccountsKey) || (authKey !== lastAuthKey);
			var shouldCluster = (accountsKey !== lastAccountsKey) || (clusterKey !== lastClusterKey);
			var shouldDb = (dbKey !== lastDbKey);
			var rendered = false;

			if (shouldAuth && !isEditingAuth()) {
				renderAuth(snapshot);
				rendered = true;
			}
			if (shouldCluster && !isEditingClusterMap()) {
				renderClusterMap(snapshot);
				rendered = true;
			}
			if (shouldDb && !isEditingDatabases()) {
				renderDatabases(snapshot);
				rendered = true;
			}

			// Update keys after any attempted render decision.
			if (shouldAuth || shouldCluster) {
				lastAccountsKey = accountsKey;
			}
			if (shouldAuth) {
				lastAuthKey = authKey;
			}
			if (shouldCluster) {
				lastClusterKey = clusterKey;
			}
			if (shouldDb) {
				lastDbKey = dbKey;
			}

			// (Label updated above on every snapshot.)
		}

		function requestSnapshot() {
			if (requestPending) {
				return;
			}
			try {
				if (document && document.visibilityState && document.visibilityState !== 'visible') {
					return;
				}
			} catch { /* ignore */ }
			requestPending = true;
			vscode.postMessage({ type: 'requestSnapshot' });
		}

		window.addEventListener('message', function (event) {
			var msg = event.data;
			if (msg && msg.type === 'snapshot') {
				requestPending = false;
				lastSnapshot = msg.snapshot;
				// Ignore the snapshot's timestamp for change detection; renderAll will re-render only when data changes.
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
			var dbSelect = closest(t, '[data-db-select]');
			if (dbSelect) {
				var clusterKey = String(dbSelect.getAttribute('data-db-select') || '');
				if (clusterKey) {
					selectedDbClusterKey = clusterKey;
					if (lastSnapshot) {
						renderDatabases(lastSnapshot);
						try {
							var list = document.getElementById('dbList');
							if (list && list.focus) {
								list.focus();
							}
						} catch { /* ignore */ }
					}
				}
				return;
			}

			var dbRefresh = closest(t, '[data-db-refresh]');
			if (dbRefresh) {
				var clusterKey = String(dbRefresh.getAttribute('data-db-refresh') || '');
				if (clusterKey) {
					vscode.postMessage({ type: 'databases.refresh', clusterKey: clusterKey });
					requestSnapshot();
				}
				return;
			}

			var dbDelete = closest(t, '[data-db-delete]');
			if (dbDelete) {
				var clusterKey = String(dbDelete.getAttribute('data-db-delete') || '');
				if (clusterKey) {
					vscode.postMessage({ type: 'databases.delete', clusterKey: clusterKey });
					requestSnapshot();
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

			var clusterDelete = closest(t, '[data-cluster-delete]');
			if (clusterDelete) {
				var clusterEndpoint = String(clusterDelete.getAttribute('data-cluster-delete') || '');
				vscode.postMessage({ type: 'clusterMap.delete', clusterEndpoint: clusterEndpoint });
				requestSnapshot();
				return;
			}


		});

		document.addEventListener('keydown', function (e) {
			var ae = getActiveElement();
			if (!ae || !ae.id || ae.id !== 'dbList') {
				return;
			}
			if (!lastSnapshot) {
				return;
			}
			var key = e && e.key ? String(e.key) : '';
			if (key !== 'ArrowUp' && key !== 'ArrowDown') {
				return;
			}
			var cached = getObject(lastSnapshot ? lastSnapshot.cachedDatabases : null);
			var clusterKeys = Object.keys(cached);
			clusterKeys.sort();
			if (clusterKeys.length === 0) {
				return;
			}
			var idx = -1;
			for (var i = 0; i < clusterKeys.length; i++) {
				if (clusterKeys[i] === selectedDbClusterKey) {
					idx = i;
					break;
				}
			}
			if (idx < 0) {
				idx = 0;
			}
			if (key === 'ArrowUp') {
				idx = Math.max(0, idx - 1);
			} else {
				idx = Math.min(clusterKeys.length - 1, idx + 1);
			}
			selectedDbClusterKey = clusterKeys[idx];
			renderDatabases(lastSnapshot);
			try { if (e && e.preventDefault) e.preventDefault(); } catch { /* ignore */ }
		});

		document.addEventListener('change', function (e) {
			var t = e.target;
			if (!t || t.nodeType !== 1) {
				return;
			}

			var clusterEndpoint = t.getAttribute ? t.getAttribute('data-cluster-select') : null;
			if (clusterEndpoint !== null && clusterEndpoint !== undefined) {
				var accountId = '';
				if (typeof t.value === 'string') {
					accountId = t.value;
				}
				if (accountId) {
					vscode.postMessage({ type: 'clusterMap.set', clusterEndpoint: String(clusterEndpoint), accountId: String(accountId) });
				} else {
					vscode.postMessage({ type: 'clusterMap.delete', clusterEndpoint: String(clusterEndpoint) });
				}
				requestSnapshot();
				return;
			}
		});

		requestSnapshot();
		setInterval(requestSnapshot, 2000);
	</script>
</body>
</html>`;
	}
}
