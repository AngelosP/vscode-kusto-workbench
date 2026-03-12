import * as vscode from 'vscode';
import { ConnectionManager, KustoConnection } from './connectionManager';
import { KustoQueryClient } from './kustoClient';
import { getSchemaCacheDirUri, readCachedSchemaFromDisk } from './schemaCache';
import { countColumns } from './schemaIndexUtils';

/**
 * Cached Values Viewer — uses Lit web components for the UI.
 * The extension host handles message routing and data access;
 * the webview renders via the <kw-cached-values> Lit component.
 */

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

export class CachedValuesViewerV2 {
	private static current: CachedValuesViewerV2 | undefined;

	public static open(context: vscode.ExtensionContext, extensionUri: vscode.Uri, connectionManager: ConnectionManager, viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active): void {
		if (CachedValuesViewerV2.current) {
			CachedValuesViewerV2.current.panel.webview.html = CachedValuesViewerV2.current.buildHtml(CachedValuesViewerV2.current.panel.webview);
			CachedValuesViewerV2.current.panel.reveal(viewColumn);
			return;
		}
		CachedValuesViewerV2.current = new CachedValuesViewerV2(context, extensionUri, connectionManager, viewColumn);
	}

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly kustoClient: KustoQueryClient;

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager,
		viewColumn: vscode.ViewColumn
	) {
		this.kustoClient = new KustoQueryClient(this.context);
		this.panel = vscode.window.createWebviewPanel(
			'kusto.cachedValuesV2',
			VIEW_TITLE,
			{ viewColumn, preserveFocus: false },
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
		CachedValuesViewerV2.current = undefined;
		for (const d of this.disposables) {
			try { d.dispose(); } catch { /* ignore */ }
		}
	}

	// ─── Data layer ────────────────────────────────────────────────────────

	private readKnownAccounts(): StoredAuthAccount[] {
		const raw = this.context.globalState.get<StoredAuthAccount[] | undefined>(STORAGE_KEYS.knownAccounts);
		return Array.isArray(raw)
			? raw.filter(a => a && typeof a.id === 'string' && typeof a.label === 'string' && typeof (a as any).lastUsedAt === 'number')
			: [];
	}

	private readClusterAccountMap(): Record<string, string> {
		const raw = this.context.globalState.get<Record<string, string> | undefined>(STORAGE_KEYS.clusterAccountMap);
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
		const next: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw)) {
			if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim()) next[k] = v;
		}
		return next;
	}

	private readCachedDatabases(): Record<string, string[]> {
		const raw = this.context.globalState.get<Record<string, string[]> | undefined>(STORAGE_KEYS.cachedDatabases);
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
		const next: Record<string, string[]> = {};
		for (const [k, v] of Object.entries(raw)) {
			if (typeof k !== 'string' || !k.trim()) continue;
			if (!Array.isArray(v)) continue;
			next[k] = v.map(x => String(x || '').trim()).filter(Boolean);
		}
		return this.migrateCachedDatabasesToClusterKeys(next);
	}

	private getClusterCacheKey(clusterUrlRaw: string): string {
		try {
			let u = String(clusterUrlRaw || '').trim();
			if (!u) return '';
			if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
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
			if (!keyRaw) { changed = true; continue; }
			const list = (Array.isArray(v) ? v : []).map((d) => String(d || '').trim()).filter(Boolean);
			const conn = connById.get(keyRaw);
			const clusterKey = conn ? this.getClusterCacheKey(conn.clusterUrl) : this.getClusterCacheKey(keyRaw);
			if (clusterKey !== keyRaw) changed = true;
			const existing = next[clusterKey] || [];
			const merged = [...existing, ...list].map((d) => String(d || '').trim()).filter(Boolean);
			const deduped: string[] = [];
			const seen = new Set<string>();
			for (const d of merged) { const lower = d.toLowerCase(); if (!seen.has(lower)) { seen.add(lower); deduped.push(d); } }
			next[clusterKey] = deduped;
		}
		if (changed) void this.context.globalState.update(STORAGE_KEYS.cachedDatabases, next);
		return next;
	}

	private async buildSnapshot(): Promise<Snapshot> {
		const knownAccounts = this.readKnownAccounts();
		const clusterAccountMap = this.readClusterAccountMap();
		const connections = this.connectionManager.getConnections();
		const cachedDatabases = this.readCachedDatabases();
		const accountsById = new Map<string, { id: string; label: string }>();
		for (const a of knownAccounts) accountsById.set(a.id, { id: a.id, label: a.label });
		for (const accountId of Object.values(clusterAccountMap)) {
			if (!accountsById.has(accountId)) accountsById.set(accountId, { id: accountId, label: accountId });
		}
		const sessionRows = await Promise.all(
			[...accountsById.values()].map(async (account) => {
				let session: vscode.AuthenticationSession | undefined;
				try { session = await vscode.authentication.getSession(AUTH.providerId, [AUTH.scope], { silent: true, account }); } catch { session = undefined; }
				let overrideToken: string | undefined;
				try { overrideToken = (await this.context.secrets.get(SECRET_KEYS.tokenOverrideByAccountId(account.id))) ?? undefined; } catch { overrideToken = undefined; }
				const accessToken = session?.accessToken;
				const effectiveToken = (overrideToken && overrideToken.trim()) ? overrideToken : (accessToken ?? '');
				return { sessionId: session?.id, account: { id: account.id, label: account.label }, scopes: session?.scopes ? [...session.scopes] : [AUTH.scope], accessToken, effectiveToken, overrideToken };
			})
		);
		return { timestamp: Date.now(), auth: { sessions: sessionRows, knownAccounts, clusterAccountMap }, connections, cachedDatabases };
	}

	// ─── Message handling ──────────────────────────────────────────────────

	private async onMessage(msg: IncomingMessage): Promise<void> {
		switch (msg.type) {
			case 'requestSnapshot': {
				const snapshot = await this.buildSnapshot();
				this.panel.webview.postMessage({ type: 'snapshot', snapshot });
				return;
			}
			case 'copyToClipboard': {
				try { await vscode.env.clipboard.writeText(String(msg.text ?? '')); void vscode.window.setStatusBarMessage('Copied to clipboard', 1500); } catch { void vscode.window.showErrorMessage('Could not copy to clipboard.'); }
				return;
			}
			case 'auth.setTokenOverride': {
				const accountId = String(msg.accountId || '').trim();
				if (!accountId) return;
				await this.context.secrets.store(SECRET_KEYS.tokenOverrideByAccountId(accountId), String(msg.token ?? ''));
				return;
			}
			case 'auth.clearTokenOverride': {
				const accountId = String(msg.accountId || '').trim();
				if (!accountId) return;
				try { await this.context.secrets.delete(SECRET_KEYS.tokenOverrideByAccountId(accountId)); } catch { /* ignore */ }
				try { const prevKnown = this.readKnownAccounts(); const nextKnown = prevKnown.filter(a => String(a?.id || '').trim() !== accountId); await this.context.globalState.update(STORAGE_KEYS.knownAccounts, nextKnown); } catch { /* ignore */ }
				try { await this.context.globalState.update(STORAGE_KEYS.clusterAccountMap, {}); } catch { /* ignore */ }
				return;
			}
			case 'auth.resetAll': {
				const known = this.readKnownAccounts();
				const map = this.readClusterAccountMap();
				const accountIds = new Set<string>([...known.map(a => a.id), ...Object.values(map)]);
				await Promise.all([...accountIds].filter(Boolean).map(async (accountId) => { try { await this.context.secrets.delete(SECRET_KEYS.tokenOverrideByAccountId(accountId)); } catch { /* ignore */ } }));
				await this.context.globalState.update(STORAGE_KEYS.knownAccounts, undefined);
				await this.context.globalState.update(STORAGE_KEYS.clusterAccountMap, undefined);
				return;
			}
			case 'clusterMap.set': {
				const clusterEndpoint = String(msg.clusterEndpoint || '').trim();
				const accountId = String(msg.accountId || '').trim();
				if (!clusterEndpoint || !accountId) return;
				const prev = this.readClusterAccountMap();
				prev[clusterEndpoint] = accountId;
				await this.context.globalState.update(STORAGE_KEYS.clusterAccountMap, prev);
				return;
			}
			case 'clusterMap.delete': {
				const clusterEndpoint = String(msg.clusterEndpoint || '').trim();
				if (!clusterEndpoint) return;
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
				if (!clusterKey) return;
				const cached = this.readCachedDatabases();
				delete cached[clusterKey];
				await this.context.globalState.update(STORAGE_KEYS.cachedDatabases, cached);
				return;
			}
			case 'databases.refresh': {
				const clusterKey = String(msg.clusterKey || '').trim().toLowerCase();
				if (!clusterKey) return;
				const cached = this.readCachedDatabases();
				const cachedBefore = (cached[clusterKey] ?? []).filter(Boolean);
				let connection: KustoConnection | undefined;
				try { const conns = this.connectionManager.getConnections(); for (const c of conns) { if (!c?.clusterUrl) continue; if (this.getClusterCacheKey(c.clusterUrl) === clusterKey) { connection = c; break; } } } catch { connection = undefined; }
				if (!connection) { const url = /^https?:\/\//i.test(clusterKey) ? clusterKey : `https://${clusterKey}`; connection = { id: `cluster_${clusterKey}`, name: clusterKey, clusterUrl: url }; }
				try {
					const databasesRaw = await this.kustoClient.getDatabases(connection, true);
					const databases = (Array.isArray(databasesRaw) ? databasesRaw : []).map((d) => String(d || '').trim()).filter(Boolean).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
					if (databases.length > 0 || cachedBefore.length === 0) { cached[clusterKey] = databases; await this.context.globalState.update(STORAGE_KEYS.cachedDatabases, cached); return; }
					void vscode.window.showWarningMessage("Couldn't refresh the database list (received 0 databases). Keeping the previous cached list.");
					return;
				} catch (error) {
					const msgText = this.kustoClient.isAuthenticationError(error) ? 'Failed to refresh the database list due to an authentication error. Try running a query against the cluster to sign in, then refresh again.' : 'Failed to refresh the database list. Check your connection and try again.';
					void vscode.window.showErrorMessage(msgText);
					return;
				}
			}
			case 'schema.clearAll': {
				try { await this.context.globalState.update(STORAGE_KEYS.cachedDatabases, {}); } catch { /* ignore */ }
				try { await this.context.globalState.update('kusto.cacheClearEpoch', Date.now()); } catch { /* ignore */ }
				try { const dir = getSchemaCacheDirUri(this.context.globalStorageUri); await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false }); } catch { /* ignore */ }
				try { void vscode.window.setStatusBarMessage('Cleared cached schema data', 2000); } catch { /* ignore */ }
				return;
			}
			case 'schema.get': {
				const clusterKey = String(msg.clusterKey || '').trim().toLowerCase();
				const database = String(msg.database || '').trim();
				if (!clusterKey || !database) return;
				let clusterUrl = '';
				try { const conns = this.connectionManager.getConnections(); for (const c of conns) { if (!c?.clusterUrl) continue; if (this.getClusterCacheKey(c.clusterUrl) === clusterKey) { clusterUrl = String(c.clusterUrl || '').trim(); break; } } } catch { clusterUrl = ''; }
				if (!clusterUrl) clusterUrl = /^https?:\/\//i.test(clusterKey) ? clusterKey : `https://${clusterKey}`;
				const cacheKey = `${clusterUrl}|${database}`;
				let jsonText = '';
				let ok = false;
				try {
					const cached = await readCachedSchemaFromDisk(this.context.globalStorageUri, cacheKey);
					if (!cached?.schema) {
						jsonText = JSON.stringify({ cluster: clusterUrl, database, error: 'No cached schema was found for this database. Try loading schema for autocomplete (or refresh schema), then try again.' }, null, 2);
						ok = false;
					} else {
						const schema = cached.schema;
						const tablesCount = schema.tables?.length ?? 0;
						const columnsCount = countColumns(schema);
						const functionsCount = schema.functions?.length ?? 0;
						const cacheAgeMs = Math.max(0, Date.now() - cached.timestamp);
						jsonText = JSON.stringify({ cluster: clusterUrl, database, schema, meta: { cacheAgeMs, tablesCount, columnsCount, functionsCount, timestamp: cached.timestamp } }, null, 2);
						ok = true;
					}
				} catch {
					jsonText = JSON.stringify({ cluster: clusterUrl, database, error: 'Failed to read cached schema from disk.' }, null, 2);
					ok = false;
				}
				try { this.panel.webview.postMessage({ type: 'schemaResult', clusterKey, database, ok, json: jsonText }); } catch { /* ignore */ }
				return;
			}
			default:
				return;
		}
	}

	// ─── HTML shell (loads Lit bundle + renders <kw-cached-values>) ─────────

	private buildHtml(webview: vscode.Webview): string {
		const nonce = String(Date.now()) + Math.random().toString(16).slice(2);
		const bundleUri = webview
			.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'webview.bundle.js'))
			.toString();
		const csp = [
			"default-src 'none'",
			"img-src data:",
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`script-src 'nonce-${nonce}' ${webview.cspSource}`,
			`connect-src ${webview.cspSource}`
		].join('; ');

		return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${VIEW_TITLE}</title>
</head>
<body>
	<kw-cached-values></kw-cached-values>
	<script nonce="${nonce}" src="${bundleUri}"></script>
</body>
</html>`;
	}
}
