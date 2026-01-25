import * as vscode from 'vscode';
import { ConnectionManager, KustoConnection } from './connectionManager';
import { KustoQueryClient } from './kustoClient';
import { getSchemaCacheDirUri, readCachedSchemaFromDisk } from './schemaCache';
import { countColumns } from './schemaIndexUtils';

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
	| { type: 'databases.refresh'; clusterKey: string }
	| { type: 'schema.clearAll' }
	| { type: 'schema.get'; clusterKey: string; database: string };

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
		private readonly extensionUri: vscode.Uri,
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
				localResourceRoots: [this.extensionUri]
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
			case 'schema.clearAll': {
				// Clear all cached database lists + all cached schema JSON files (all clusters / all databases).
				try {
					await this.context.globalState.update(STORAGE_KEYS.cachedDatabases, {});
				} catch {
					// ignore
				}
				try {
					await this.context.globalState.update('kusto.cacheClearEpoch', Date.now());
				} catch {
					// ignore
				}
				try {
					const dir = getSchemaCacheDirUri(this.context.globalStorageUri);
					await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
				} catch {
					// ignore (directory might not exist yet)
				}
				try {
					void vscode.window.setStatusBarMessage('Cleared cached schema data', 2000);
				} catch {
					// ignore
				}
				return;
			}
			case 'schema.get': {
				const clusterKey = String(msg.clusterKey || '').trim().toLowerCase();
				const database = String(msg.database || '').trim();
				if (!clusterKey || !database) {
					return;
				}

				// Prefer a saved connection's clusterUrl for this clusterKey when available.
				let clusterUrl = '';
				try {
					const conns = this.connectionManager.getConnections();
					for (const c of conns) {
						if (!c || !c.clusterUrl) {
							continue;
						}
						const key = this.getClusterCacheKey(c.clusterUrl);
						if (key === clusterKey) {
							clusterUrl = String(c.clusterUrl || '').trim();
							break;
						}
					}
				} catch {
					clusterUrl = '';
				}
				if (!clusterUrl) {
					clusterUrl = /^https?:\/\//i.test(clusterKey) ? clusterKey : `https://${clusterKey}`;
				}

				const cacheKey = `${clusterUrl}|${database}`;
				let jsonText = '';
				let ok = false;
				try {
					const cached = await readCachedSchemaFromDisk(this.context.globalStorageUri, cacheKey);
					const now = Date.now();
					if (!cached || !cached.schema) {
						jsonText = JSON.stringify(
							{
								cluster: clusterUrl,
								database,
								error:
									'No cached schema was found for this database. ' +
									'Try loading schema for autocomplete (or refresh schema), then try again.'
							},
							null,
							2
						);
						ok = false;
					} else {
						const schema = cached.schema;
						const tablesCount = schema.tables?.length ?? 0;
						const columnsCount = countColumns(schema);
						const functionsCount = schema.functions?.length ?? 0;
						const cacheAgeMs = Math.max(0, now - cached.timestamp);
						jsonText = JSON.stringify(
							{
								cluster: clusterUrl,
								database,
								schema,
								meta: {
									cacheAgeMs,
									tablesCount,
									columnsCount,
									functionsCount,
									timestamp: cached.timestamp
								}
							},
							null,
							2
						);
						ok = true;
					}
				} catch {
					jsonText = JSON.stringify(
						{
							cluster: clusterUrl,
							database,
							error: 'Failed to read cached schema from disk.'
						},
						null,
						2
					);
					ok = false;
				}

				try {
					this.panel.webview.postMessage({
						type: 'schemaResult',
						clusterKey,
						database,
						ok,
						json: jsonText
					});
				} catch {
					// ignore
				}
				return;
			}
			default:
				return;
		}
	}

	private buildHtml(webview: vscode.Webview): string {
		const nonce = String(Date.now()) + Math.random().toString(16).slice(2);
		const objectViewerJsUri = webview
			.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'queryEditor', 'objectViewer.js'))
			.toString();
		const csp = [
			"default-src 'none'",
			"img-src data:",
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`script-src 'nonce-${nonce}' ${webview.cspSource}`
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
		.linkButton { background: transparent; border: 0; padding: 0; margin: 0; color: var(--vscode-textLink-foreground); cursor: pointer; }
		.linkButton:hover { text-decoration: underline; }
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

		/* Reuse the Query Editor's object/JSON viewer (modal) styling. */
		.refresh-btn {
			background: transparent;
			border: 1px solid var(--vscode-input-border);
			color: var(--vscode-foreground);
			cursor: pointer;
			padding: 0;
			font-size: 12px;
			border-radius: 4px;
			display: flex;
			align-items: center;
			justify-content: center;
			line-height: 0;
			min-width: 28px;
			width: 28px;
			height: 28px;
		}
		.refresh-btn svg { display: block; }
		.refresh-btn.close-btn { border: none; }
		.refresh-btn:hover { background: var(--vscode-list-hoverBackground); }
		.refresh-btn:active { opacity: 0.7; }

		.tool-toggle-btn {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
			border: 1px solid var(--vscode-button-border);
			border-radius: 2px;
			padding: 4px 8px;
			cursor: pointer;
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 14px;
		}
		.tool-toggle-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.tool-toggle-btn.is-active {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}

		.object-view-btn {
			margin: 0;
			padding: 2px 6px;
			font-size: 11px;
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
			border: 1px solid var(--vscode-button-border);
			border-radius: 3px;
			cursor: pointer;
			display: inline-flex;
			align-items: center;
			vertical-align: baseline;
		}
		.object-view-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

		.object-viewer-modal {
			display: none;
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background: rgba(0, 0, 0, 0.6);
			z-index: 10000;
			align-items: center;
			justify-content: center;
		}
		.object-viewer-modal.visible { display: flex; }
		.object-viewer-content {
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			width: 80%;
			max-width: 1200px;
			height: 80%;
			display: flex;
			flex-direction: column;
			box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
		}
		.object-viewer-header {
			padding: 12px 16px;
			border-bottom: 1px solid var(--vscode-panel-border);
			display: flex;
			justify-content: space-between;
			align-items: center;
			background: var(--vscode-editorGroupHeader-tabsBackground);
		}
		.object-viewer-header h3 { margin: 0; font-size: 14px; font-weight: 600; }
		.object-viewer-search { display: flex; gap: 8px; align-items: center; flex: 1; margin: 0 16px; }
		.object-viewer-search-results { font-size: 11px; color: var(--vscode-descriptionForeground); }

		/* Reusable search control (input + embedded mode toggle + nav buttons). */
		.kusto-search-control {
			position: relative;
			display: inline-flex;
			align-items: center;
			flex: 1 1 auto;
			min-width: 0;
			width: 100%;
			max-width: 350px;
		}
		.kusto-search-control input::placeholder {
			color: var(--vscode-input-placeholderForeground);
			opacity: 1;
		}
		.kusto-search-control input {
			flex: 1 1 auto;
			min-width: 0;
			padding: 4px 8px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 2px;
		}
		.kusto-search-control .kusto-search-input {
			padding-left: 26px !important;
			padding-right: 98px !important;
		}
		.kusto-search-icon {
			position: absolute;
			left: 6px;
			top: 50%;
			transform: translateY(-50%);
			pointer-events: none;
			color: var(--vscode-input-placeholderForeground);
			opacity: 0.7;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			z-index: 1;
		}
		.kusto-search-icon svg { display: block; }
		.kusto-search-status {
			position: absolute;
			right: 71px;
			top: 50%;
			transform: translateY(-50%);
			display: inline-flex;
			align-items: center;
			line-height: 1;
			font-size: inherit;
			color: var(--vscode-descriptionForeground);
			pointer-events: none;
			white-space: nowrap;
			user-select: none;
		}
		.kusto-search-status-error { color: var(--vscode-errorForeground); }
		.kusto-search-mode-toggle {
			position: absolute;
			right: 49px;
			top: 50%;
			transform: translateY(-50%);
			width: 20px;
			height: 18px;
			padding: 0;
			border: none;
			background: transparent;
			color: var(--vscode-input-foreground);
			opacity: 0.7;
			cursor: pointer;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			border-radius: 2px;
		}
		.kusto-search-mode-toggle:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
		.kusto-search-mode-toggle svg { display: block; }
		.kusto-search-nav-divider {
			position: absolute;
			right: 48px;
			top: 50%;
			transform: translateY(-50%);
			width: 1px;
			height: 14px;
			background: var(--vscode-input-foreground);
			opacity: 0.25;
			pointer-events: none;
		}
		.kusto-search-nav-btn {
			position: absolute;
			top: 50%;
			transform: translateY(-50%);
			width: 20px;
			height: 18px;
			padding: 0;
			border: none;
			background: transparent;
			color: var(--vscode-input-foreground);
			opacity: 0.7;
			cursor: pointer;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			border-radius: 2px;
		}
		.kusto-search-nav-btn:hover:not(:disabled) { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
		.kusto-search-nav-btn:disabled { opacity: 0.35; cursor: default; }
		.kusto-search-nav-btn svg { display: block; }
		.kusto-search-prev { right: 26px; }
		.kusto-search-next { right: 4px; }
		.object-viewer-body { flex: 1; overflow: auto; padding: 16px; }
		.object-viewer-section {
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			background: var(--vscode-editor-background);
			margin-bottom: 12px;
		}
		.object-viewer-section-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
			padding: 10px 12px;
			border-bottom: 1px solid var(--vscode-panel-border);
			background: var(--vscode-editorGroupHeader-tabsBackground);
		}
		.object-viewer-props-section .object-viewer-section-header { justify-content: flex-start; }
		.object-viewer-props-section .object-viewer-section-title { flex: 1; }
		.object-viewer-section-title {
			font-size: 12px;
			font-weight: 600;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.object-viewer-back-btn {
			padding: 4px 8px;
			min-width: 28px;
			height: 28px;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border-color: var(--vscode-button-border);
		}
		.object-viewer-back-btn:hover { background: var(--vscode-button-hoverBackground); }
		.object-viewer-props-section .object-viewer-section-title { white-space: normal; overflow: visible; text-overflow: clip; }
		.object-viewer-crumb {
			background: transparent;
			border: none;
			padding: 0;
			margin: 0;
			font: inherit;
			color: var(--vscode-textLink-foreground);
			cursor: pointer;
			text-decoration: none;
		}
		.object-viewer-crumb:hover { background: transparent; text-decoration: underline; }
		.object-viewer-crumb:focus { outline: none; background: transparent; }
		.object-viewer-crumb:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; background: transparent; }
		.object-viewer-crumb:disabled { color: var(--vscode-foreground); cursor: default; text-decoration: none; opacity: 0.9; }
		.object-viewer-crumb-sep { color: var(--vscode-descriptionForeground); padding: 0 6px; user-select: none; }
		.object-viewer-props-table {
			width: 100%;
			border-collapse: collapse;
			font-size: 12px;
			font-family: var(--vscode-font-family);
			user-select: text;
		}
		.object-viewer-props-table td {
			padding: 6px 10px;
			border-top: 1px solid var(--vscode-panel-border);
			vertical-align: top;
			word-break: break-word;
			user-select: text;
		}
		.object-viewer-prop-key-cell { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
		.object-viewer-prop-key-text { flex: 1; min-width: 0; word-break: break-word; }
		.object-viewer-prop-copy-btn { min-width: 22px; width: 22px; height: 22px; opacity: 0; pointer-events: none; user-select: none; }
		.object-viewer-props-table tr:hover .object-viewer-prop-copy-btn,
		.object-viewer-props-table tr:focus-within .object-viewer-prop-copy-btn { opacity: 1; pointer-events: auto; }
		.object-viewer-raw-actions { display: inline-flex; gap: 4px; align-items: center; }
		.object-viewer-props-table td:first-child { width: 35%; max-width: 360px; font-family: var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); }
		.object-viewer-props-table td:last-child { font-family: var(--vscode-editor-font-family); vertical-align: middle; }
		.object-viewer-props-table tr.search-match td { background: var(--vscode-editor-findMatchHighlightBackground); outline: 1px solid var(--vscode-editor-findMatchHighlightBorder); outline-offset: -1px; }
		.object-viewer-raw-body { padding: 10px 12px; }
		.object-viewer-json { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); white-space: pre; line-height: 1.6; }
		.object-viewer-json-wrap { white-space: pre-wrap; word-break: break-word; overflow-x: hidden; }
		.json-key { color: var(--vscode-symbolIcon-propertyForeground); }
		.json-string { color: var(--vscode-symbolIcon-stringForeground); }
		.json-number { color: var(--vscode-symbolIcon-numberForeground); }
		.json-boolean { color: var(--vscode-symbolIcon-booleanForeground); }
		.json-null { color: var(--vscode-symbolIcon-nullForeground); }
		.json-highlight { background: var(--vscode-editor-findMatchHighlightBackground); border-radius: 2px; }
		.json-highlight-active { background: var(--vscode-editor-findMatchBackground); outline: 1px solid var(--vscode-editor-findMatchBorder); }
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
			<div class="rowActions">
				<button id="schemaClearAll" class="iconButton" type="button" title="clear all cached schema data" aria-label="clear all cached schema data">
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
		<div id="dbContent" class="sectionBody"></div>
	</section>

	<!-- Object Viewer Modal (reused from query results viewer) -->
	<div id="objectViewer" class="object-viewer-modal">
		<div class="object-viewer-content">
			<div class="object-viewer-header">
				<h3 id="objectViewerTitle"></h3>
				<div class="object-viewer-search">
					<div id="objectViewerSearchHost"></div>
					<span class="object-viewer-search-results" id="objectViewerSearchResults"></span>
				</div>
				<button class="refresh-btn close-btn object-viewer-close" type="button" title="Close" aria-label="Close">
					<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">
						<path d="M4 4l8 8" />
						<path d="M12 4L4 12" />
					</svg>
				</button>
			</div>
			<div class="object-viewer-body">
				<div class="object-viewer-section object-viewer-props-section">
					<div class="object-viewer-section-header">
						<button id="objectViewerBackBtn" class="tool-toggle-btn object-viewer-back-btn" type="button" title="Back" aria-label="Back" style="display:none;">←</button>
						<div class="object-viewer-section-title" id="objectViewerPropsTitle"></div>
					</div>
					<table class="object-viewer-props-table" id="objectViewerPropsTable" aria-label="Properties"></table>
				</div>

				<div class="object-viewer-section object-viewer-raw-section">
					<div class="object-viewer-section-header">
						<div class="object-viewer-section-title">Raw value</div>
						<div class="object-viewer-raw-actions">
							<button id="objectViewerRawCopy" class="tool-toggle-btn object-viewer-raw-copy" type="button" title="Copy to clipboard" aria-label="Copy to clipboard"></button>
							<button id="objectViewerRawToggle" class="tool-toggle-btn object-viewer-raw-toggle" type="button" title="Hide raw value" aria-label="Hide raw value"></button>
						</div>
					</div>
					<div id="objectViewerRawBody" class="object-viewer-raw-body">
						<div id="objectViewerContent" class="object-viewer-json object-viewer-json-wrap"></div>
					</div>
				</div>
			</div>
		</div>
	</div>

	<script nonce="${nonce}" src="${objectViewerJsUri}"></script>

	<script nonce="${nonce}">
		var vscode = acquireVsCodeApi();
		var lastSnapshot = null;
		var selectedDbClusterKey = '';
		var schemaRequestInFlight = false;
		var requestPending = false;
		var objectViewerHandlersInit = false;

		// Helper for escaping regex special characters (needed by searchInObjectViewer fallback path).
		function escapeRegex(str) {
			return String(str || '').replace(/[-/\\^$*+?.()|[\\]{}]/g, '\\$&');
		}

		// Count regex matches in text (needed by searchInObjectViewer for match count display).
		window.__kustoCountRegexMatches = function(regex, text, maxMatches) {
			if (!regex) return 0;
			var s = String(text || '');
			var limit = (typeof maxMatches === 'number' && isFinite(maxMatches) && maxMatches > 0) ? Math.floor(maxMatches) : 5000;
			var count = 0;
			try {
				regex.lastIndex = 0;
				var m;
				while ((m = regex.exec(s)) !== null) {
					count++;
					if (count >= limit) break;
					if (!m[0]) {
						regex.lastIndex = regex.lastIndex + 1;
					}
				}
			} catch { /* ignore */ }
			return count;
		};

		// Highlight text nodes matching regex (needed by searchInObjectViewer for raw JSON highlighting).
		window.__kustoHighlightElementTextNodes = function(rootEl, regex, highlightClass) {
			if (!rootEl) return 0;
			if (!regex) return 0;
			var cls = String(highlightClass || 'kusto-search-highlight');

			var total = 0;
			var walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
			var nodes = [];
			try {
				var node;
				while ((node = walker.nextNode())) nodes.push(node);
			} catch { /* ignore */ }

			for (var i = 0; i < nodes.length; i++) {
				var n = nodes[i];
				try {
					var text = String(n.textContent || '');
					if (!text) continue;
					regex.lastIndex = 0;
					if (!regex.test(text)) continue;

					regex.lastIndex = 0;
					var frag = document.createDocumentFragment();
					var lastIndex = 0;
					var m;
					while ((m = regex.exec(text)) !== null) {
						var start = m.index;
						var matchText = m[0];
						if (!matchText) break;
						if (start > lastIndex) {
							frag.appendChild(document.createTextNode(text.slice(lastIndex, start)));
						}
						var span = document.createElement('span');
						span.className = cls;
						span.textContent = matchText;
						frag.appendChild(span);
						total++;
						lastIndex = start + matchText.length;
					}
					if (lastIndex < text.length) {
						frag.appendChild(document.createTextNode(text.slice(lastIndex)));
					}
					if (n.parentNode) {
						n.parentNode.insertBefore(frag, n);
						n.parentNode.removeChild(n);
					}
				} catch { /* ignore */ }
			}
			return total;
		};

		// Search control creation and helpers.
		var SEARCH_MODE_WILDCARD = 'wildcard';
		var SEARCH_MODE_REGEX = 'regex';
		var searchControlCreated = false;
		var currentSearchMatchIndex = 0;
		var currentSearchMatches = [];

		function __kustoGetSearchIconSvg() {
			return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.5 6.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0zm-.82 4.12a5 5 0 1 1 .707-.707l3.536 3.536-.707.707-3.536-3.536z"/></svg>';
		}
		function __kustoGetWildcardIconSvg() {
			return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><text x="3" y="12" font-size="11" font-weight="bold" font-family="monospace">*</text></svg>';
		}
		function __kustoGetRegexIconSvg() {
			return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><text x="1" y="12" font-size="10" font-weight="bold" font-family="monospace">.*</text></svg>';
		}
		function __kustoGetChevronUpSvg() {
			return '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 5.5L3.5 10l.707.707L8 6.914l3.793 3.793.707-.707L8 5.5z"/></svg>';
		}
		function __kustoGetChevronDownSvg() {
			return '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 10.5l4.5-4.5-.707-.707L8 9.086 4.207 5.293 3.5 6 8 10.5z"/></svg>';
		}

		function __kustoUpdateSearchModeToggle(btn, mode) {
			if (!btn) return;
			var isRegex = (mode === SEARCH_MODE_REGEX);
			btn.innerHTML = isRegex ? __kustoGetRegexIconSvg() : __kustoGetWildcardIconSvg();
			btn.title = isRegex
				? 'Regex mode (click to switch to Wildcard)'
				: 'Wildcard mode (click to switch to Regex)';
			try { btn.setAttribute('aria-label', btn.title); } catch { /* ignore */ }
		}

		function __kustoSetSearchNavEnabled(prevBtn, nextBtn, enabled, matchCount) {
			var count = (typeof matchCount === 'number' && matchCount > 1) ? matchCount : 0;
			var canNav = enabled && count > 1;
			if (prevBtn) prevBtn.disabled = !canNav;
			if (nextBtn) nextBtn.disabled = !canNav;
		}

		window.__kustoGetSearchControlState = function(inputId, modeId) {
			try {
				var input = document.getElementById(inputId);
				var modeEl = document.getElementById(modeId);
				var modeVal = modeEl ? (modeEl.dataset.mode || modeEl.value || SEARCH_MODE_WILDCARD) : SEARCH_MODE_WILDCARD;
				return {
					query: String((input && input.value) ? input.value : '').trim(),
					mode: (modeVal === SEARCH_MODE_REGEX) ? SEARCH_MODE_REGEX : SEARCH_MODE_WILDCARD
				};
			} catch {
				return { query: '', mode: SEARCH_MODE_WILDCARD };
			}
		};

		window.__kustoTryBuildSearchRegex = function(query, mode) {
			var q = String(query || '').trim();
			var m = (mode === SEARCH_MODE_REGEX) ? SEARCH_MODE_REGEX : SEARCH_MODE_WILDCARD;
			if (!q) return { regex: null, error: null, mode: m };

			var pattern = '';
			if (m === SEARCH_MODE_REGEX) {
				pattern = q;
			} else {
				pattern = q.split('*').map(escapeRegex).join('.*?');
			}

			try {
				var regex = new RegExp(pattern, 'gi');
				try {
					var nonGlobal = new RegExp(regex.source, regex.flags.replace(/g/g, ''));
					if (nonGlobal.test('')) {
						return { regex: null, error: 'Pattern matches empty text', mode: m };
					}
				} catch { /* ignore */ }
				return { regex: regex, error: null, mode: m };
			} catch {
				return { regex: null, error: 'Invalid regex', mode: m };
			}
		};

		function createSearchControl() {
			if (searchControlCreated) return;
			var host = document.getElementById('objectViewerSearchHost');
			if (!host) return;

			searchControlCreated = true;
			host.textContent = '';

			var wrapper = document.createElement('div');
			wrapper.className = 'kusto-search-control';

			var searchIcon = document.createElement('span');
			searchIcon.className = 'kusto-search-icon';
			searchIcon.innerHTML = __kustoGetSearchIconSvg();
			searchIcon.setAttribute('aria-hidden', 'true');

			var input = document.createElement('input');
			input.type = 'text';
			input.id = 'objectViewerSearch';
			input.className = 'kusto-search-input';
			input.placeholder = 'Search...';
			input.autocomplete = 'off';
			try { input.spellcheck = false; } catch { /* ignore */ }

			var statusEl = document.createElement('span');
			statusEl.className = 'kusto-search-status';
			statusEl.id = 'objectViewerSearch_status';

			var toggleBtn = document.createElement('button');
			toggleBtn.type = 'button';
			toggleBtn.id = 'objectViewerSearchMode';
			toggleBtn.className = 'kusto-search-mode-toggle';
			toggleBtn.dataset.mode = SEARCH_MODE_WILDCARD;
			__kustoUpdateSearchModeToggle(toggleBtn, SEARCH_MODE_WILDCARD);

			var prevBtn = document.createElement('button');
			prevBtn.type = 'button';
			prevBtn.className = 'kusto-search-nav-btn kusto-search-prev';
			prevBtn.id = 'objectViewerSearch_prev';
			prevBtn.innerHTML = __kustoGetChevronUpSvg();
			prevBtn.title = 'Previous match (Shift+Enter)';
			prevBtn.setAttribute('aria-label', 'Previous match');
			prevBtn.disabled = true;

			var nextBtn = document.createElement('button');
			nextBtn.type = 'button';
			nextBtn.className = 'kusto-search-nav-btn kusto-search-next';
			nextBtn.id = 'objectViewerSearch_next';
			nextBtn.innerHTML = __kustoGetChevronDownSvg();
			nextBtn.title = 'Next match (Enter)';
			nextBtn.setAttribute('aria-label', 'Next match');
			nextBtn.disabled = true;

			var navDivider = document.createElement('span');
			navDivider.className = 'kusto-search-nav-divider';
			navDivider.setAttribute('aria-hidden', 'true');

			input.addEventListener('input', function() {
				currentSearchMatchIndex = 0;
				try { searchInObjectViewer(); } catch { /* ignore */ }
				collectSearchMatches();
				updateSearchNavState();
			});

			input.addEventListener('keydown', function(e) {
				if (e.key === 'Enter') {
					if (e.shiftKey) {
						navigateToPrevMatch();
					} else {
						navigateToNextMatch();
					}
					e.preventDefault();
				}
			});

			toggleBtn.addEventListener('click', function() {
				var current = String(toggleBtn.dataset.mode || SEARCH_MODE_WILDCARD);
				var next = (current === SEARCH_MODE_REGEX) ? SEARCH_MODE_WILDCARD : SEARCH_MODE_REGEX;
				toggleBtn.dataset.mode = next;
				__kustoUpdateSearchModeToggle(toggleBtn, next);
				currentSearchMatchIndex = 0;
				try { searchInObjectViewer(); } catch { /* ignore */ }
				collectSearchMatches();
				updateSearchNavState();
			});

			prevBtn.addEventListener('click', function() { navigateToPrevMatch(); });
			nextBtn.addEventListener('click', function() { navigateToNextMatch(); });

			wrapper.appendChild(searchIcon);
			wrapper.appendChild(input);
			wrapper.appendChild(statusEl);
			wrapper.appendChild(toggleBtn);
			wrapper.appendChild(navDivider);
			wrapper.appendChild(prevBtn);
			wrapper.appendChild(nextBtn);
			host.appendChild(wrapper);
		}

		function updateSearchNavState() {
			var prevBtn = document.getElementById('objectViewerSearch_prev');
			var nextBtn = document.getElementById('objectViewerSearch_next');
			var statusEl = document.getElementById('objectViewerSearch_status');
			var count = currentSearchMatches.length;

			__kustoSetSearchNavEnabled(prevBtn, nextBtn, true, count);

			if (statusEl) {
				if (count > 0) {
					statusEl.textContent = '(' + (currentSearchMatchIndex + 1) + '/' + count + ')';
				} else {
					statusEl.textContent = '';
				}
			}
		}

		function collectSearchMatches() {
			currentSearchMatches = [];
			var content = document.getElementById('objectViewerContent');
			if (!content) return;
			var highlights = content.querySelectorAll('.json-highlight');
			for (var i = 0; i < highlights.length; i++) {
				currentSearchMatches.push(highlights[i]);
			}
		}

		function scrollToMatch(index) {
			if (index < 0 || index >= currentSearchMatches.length) return;
			var el = currentSearchMatches[index];
			if (!el) return;

			// Remove active class from all
			for (var i = 0; i < currentSearchMatches.length; i++) {
				currentSearchMatches[i].classList.remove('json-highlight-active');
			}
			el.classList.add('json-highlight-active');

			try {
				el.scrollIntoView({ behavior: 'smooth', block: 'center' });
			} catch {
				try { el.scrollIntoView(true); } catch { /* ignore */ }
			}
		}

		function navigateToNextMatch() {
			collectSearchMatches();
			if (currentSearchMatches.length === 0) return;
			currentSearchMatchIndex = (currentSearchMatchIndex + 1) % currentSearchMatches.length;
			scrollToMatch(currentSearchMatchIndex);
			updateSearchNavState();
		}

		function navigateToPrevMatch() {
			collectSearchMatches();
			if (currentSearchMatches.length === 0) return;
			currentSearchMatchIndex = (currentSearchMatchIndex - 1 + currentSearchMatches.length) % currentSearchMatches.length;
			scrollToMatch(currentSearchMatchIndex);
			updateSearchNavState();
		}

				function openSchemaJsonViewer(title, jsonText) {
					var modal = document.getElementById('objectViewer');
					var titleEl = document.getElementById('objectViewerTitle');
					if (!modal) {
						return;
					}

					// Create the search control if not already created.
					createSearchControl();

					// Reset search state.
					currentSearchMatchIndex = 0;
					currentSearchMatches = [];

					var searchInput = document.getElementById('objectViewerSearch');
					try {
						if (titleEl) {
							titleEl.textContent = '';
							titleEl.appendChild(document.createTextNode(title));
						}
					} catch { /* ignore */ }
					try {
						// Initialize the raw toggle/copy glyphs.
						if (typeof __kustoEnsureObjectViewerRawToggleIcon === 'function') {
							__kustoEnsureObjectViewerRawToggleIcon();
						}
						if (typeof __kustoEnsureObjectViewerRawCopyIcon === 'function') {
							__kustoEnsureObjectViewerRawCopyIcon();
						}
					} catch { /* ignore */ }
					try {
						window.__kustoObjectViewerRawVisible = true;
						var rawBody = document.getElementById('objectViewerRawBody');
						if (rawBody) { rawBody.style.display = ''; }
						var rawToggle = document.getElementById('objectViewerRawToggle');
						if (rawToggle) { rawToggle.classList.add('is-active'); }
					} catch { /* ignore */ }

					var rootValue = null;
					try {
						if (typeof __kustoParseMaybeJson === 'function') {
							rootValue = __kustoParseMaybeJson(jsonText);
						} else {
							rootValue = jsonText;
						}
					} catch {
						rootValue = jsonText;
					}

					window.__kustoObjectViewerState = {
						columnName: title,
						stack: [{ label: title, value: rootValue }]
					};
					try {
						if (searchInput) {
							searchInput.value = '';
						}
						var sr = document.getElementById('objectViewerSearchResults');
						if (sr) { sr.textContent = ''; }
					} catch { /* ignore */ }
					try {
						if (typeof __kustoRenderObjectViewer === 'function') {
							__kustoRenderObjectViewer();
						}
					} catch { /* ignore */ }
					try {
						modal.classList.add('visible');
					} catch { /* ignore */ }
				}
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

		function initObjectViewerHandlersOnce() {
			if (objectViewerHandlersInit) {
				return;
			}
			objectViewerHandlersInit = true;
			try {
				var modal = document.getElementById('objectViewer');
				if (modal) {
					modal.addEventListener('click', function (e) {
						try { closeObjectViewer(e); } catch { /* ignore */ }
					});
				}
				var content = modal ? modal.querySelector('.object-viewer-content') : null;
				if (content) {
					content.addEventListener('click', function (e) {
						try { e.stopPropagation(); } catch { /* ignore */ }
					});
				}
				var closeBtn = modal ? modal.querySelector('.object-viewer-close') : null;
				if (closeBtn) {
					closeBtn.addEventListener('click', function (e) {
						try { e.preventDefault(); } catch { /* ignore */ }
						try { closeObjectViewer(); } catch { /* ignore */ }
					});
				}
				var searchInput = document.getElementById('objectViewerSearch');
				if (searchInput) {
					searchInput.addEventListener('input', function () {
						try { searchInObjectViewer(); } catch { /* ignore */ }
					});
				}
				var backBtn = document.getElementById('objectViewerBackBtn');
				if (backBtn) {
					backBtn.addEventListener('click', function (e) {
						try { e.preventDefault(); } catch { /* ignore */ }
						try { objectViewerNavigateBack(); } catch { /* ignore */ }
					});
				}
				var rawCopyBtn = document.getElementById('objectViewerRawCopy');
				if (rawCopyBtn) {
					rawCopyBtn.addEventListener('click', function (e) {
						try { e.preventDefault(); } catch { /* ignore */ }
						try { copyObjectViewerRawToClipboard(); } catch { /* ignore */ }
					});
				}
				var rawToggleBtn = document.getElementById('objectViewerRawToggle');
				if (rawToggleBtn) {
					rawToggleBtn.addEventListener('click', function (e) {
						try { e.preventDefault(); } catch { /* ignore */ }
						try { toggleObjectViewerRaw(); } catch { /* ignore */ }
					});
				}
			} catch {
				// ignore
			}
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
				html += '<tr><td>';
				html += '<button class="linkButton mono" data-db-schema="1" data-cluster-key="' + escapeHtml(selected) + '" data-db-name="' + escapeHtml(db) + '" title="View cached schema JSON">' + escapeHtml(db) + '</button>';
				html += '</td></tr>';
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
				return;
			}
			if (msg && msg.type === 'schemaResult') {
				schemaRequestInFlight = false;
				var db = String(msg.database || '');
				var jsonText = String(msg.json || '');
				var title = 'Cached schema for ' + (db ? db : '(unknown db)');
				openSchemaJsonViewer(title, jsonText);
			}
		});

		initObjectViewerHandlersOnce();

		document.addEventListener('click', function (e) {
			var t = e.target;
			if (!t || t.nodeType !== 1) {
				return;
			}

			var schemaClearAll = closest(t, '#schemaClearAll');
			if (schemaClearAll) {
				vscode.postMessage({ type: 'schema.clearAll' });
				requestSnapshot();
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

			var dbSchemaBtn = closest(t, '[data-db-schema]');
			if (dbSchemaBtn) {
				var clusterKey = String(dbSchemaBtn.getAttribute('data-cluster-key') || '');
				var dbName = String(dbSchemaBtn.getAttribute('data-db-name') || '');
				if (clusterKey && dbName) {
					if (!schemaRequestInFlight) {
						schemaRequestInFlight = true;
						vscode.postMessage({ type: 'schema.get', clusterKey: clusterKey, database: dbName });
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
