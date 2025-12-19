import * as vscode from 'vscode';

import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

import { ConnectionManager, KustoConnection } from './connectionManager';
import { DatabaseSchemaIndex, KustoQueryClient } from './kustoClient';
import { KqlLanguageServiceHost } from './kqlLanguageService/host';
import { getQueryEditorHtml } from './queryEditorHtml';

const OUTPUT_CHANNEL_NAME = 'Kusto Workbench';

const STORAGE_KEYS = {
	lastConnectionId: 'kusto.lastConnectionId',
	lastDatabase: 'kusto.lastDatabase',
	cachedDatabases: 'kusto.cachedDatabases',
	cachedSchemas: 'kusto.cachedSchemas',
	caretDocsEnabled: 'kusto.caretDocsEnabled',
	cachedSchemasMigratedToDisk: 'kusto.cachedSchemasMigratedToDisk',
	lastOptimizeCopilotModelId: 'kusto.optimize.lastCopilotModelId',
	favorites: 'kusto.favorites'
} as const;

type KustoFavorite = { name: string; clusterUrl: string; database: string };

type CachedSchemaEntry = { schema: DatabaseSchemaIndex; timestamp: number };

type CacheUnit = 'minutes' | 'hours' | 'days';

type IncomingWebviewMessage = { type: 'getConnections' }
	| { type: 'getDatabases'; connectionId: string; boxId: string }
	| { type: 'refreshDatabases'; connectionId: string; boxId: string }
	| { type: 'seeCachedValues' }
	| { type: 'resolveResourceUri'; requestId: string; path: string; baseUri?: string }
	| { type: 'requestAddFavorite'; clusterUrl: string; database: string; defaultName?: string; boxId?: string }
	| { type: 'removeFavorite'; clusterUrl: string; database: string; boxId?: string }
	| { type: 'confirmRemoveFavorite'; requestId: string; label?: string; clusterUrl: string; database: string; boxId?: string }
	| { type: 'promptImportConnectionsXml'; boxId?: string }
	| { type: 'addConnectionsForClusters'; clusterUrls: string[]; boxId?: string }
	| { type: 'showInfo'; message: string }
	| { type: 'setCaretDocsEnabled'; enabled: boolean }
	| { type: 'executePython'; boxId: string; code: string }
	| { type: 'fetchUrl'; boxId: string; url: string }
	| { type: 'cancelQuery'; boxId: string }
	| { type: 'checkCopilotAvailability'; boxId: string }
	| { type: 'prepareOptimizeQuery'; query: string; boxId: string }
	| { type: 'cancelOptimizeQuery'; boxId: string }
	| {
			type: 'optimizeQuery';
			query: string;
			connectionId: string;
			database: string;
			boxId: string;
			queryName: string;
			modelId?: string;
			promptText?: string;
		}
	| {
		type: 'executeQuery';
		query: string;
		connectionId: string;
		boxId: string;
		database?: string;
		queryMode?: string;
		cacheEnabled?: boolean;
		cacheValue?: number;
		cacheUnit?: CacheUnit | string;
	}
	| { type: 'prefetchSchema'; connectionId: string; database: string; boxId: string; forceRefresh?: boolean; requestToken?: string }
	| { type: 'promptAddConnection'; boxId?: string }
	| {
			type: 'importConnectionsFromXml';
			connections: Array<{ name: string; clusterUrl: string; database?: string }>;
			boxId?: string;
		}
	| {
		type: 'kqlLanguageRequest';
		requestId: string;
		method: 'textDocument/diagnostic' | 'kusto/findTableReferences';
		params: { text: string; connectionId?: string; database?: string; boxId?: string; uri?: string };
	};

export class QueryEditorProvider {
	private panel?: vscode.WebviewPanel;
	private readonly kustoClient: KustoQueryClient;
	private lastConnectionId?: string;
	private lastDatabase?: string;
	private readonly output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	private readonly SCHEMA_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
	private readonly runningQueriesByBoxId = new Map<string, { cancel: () => void; runSeq: number }>();
	private readonly runningOptimizeByBoxId = new Map<string, vscode.CancellationTokenSource>();
	private queryRunSeq = 0;
	private readonly kqlLanguageHost: KqlLanguageServiceHost;
	private readonly resolvedResourceUriCache = new Map<string, string>();

	private getErrorMessage(error: unknown): string {
		if (error instanceof Error) {
			return error.message;
		}
		return String(error);
	}

	private formatQueryExecutionErrorForUser(error: unknown, connection: KustoConnection, database?: string): string {
		const raw = this.getErrorMessage(error);
		const cleaned = raw.replace(/^Query execution failed:\s*/i, '').trim();
		const lower = cleaned.toLowerCase();
		const cluster = String(connection.clusterUrl || '').trim();
		const dbSuffix = database ? ` (db: ${database})` : '';

		if (lower.includes('failed to get cloud info')) {
			return (
				`Can't connect to cluster ${cluster}${dbSuffix}.\n` +
				`This often happens when VPN is off, Wi‑Fi is down, or your network blocks outbound HTTPS.\n` +
				`Next steps:\n` +
				`- Turn on your VPN (if required)\n` +
				`- Confirm you have internet access\n` +
				`- Verify the cluster URL is correct\n` +
				`- Try again\n` +
				`\n` +
				`Technical details: ${cleaned}`
			);
		}
		if (lower.includes('etimedout') || lower.includes('timeout')) {
			return (
				`Connection timed out reaching ${cluster}${dbSuffix}.\n` +
				`Next steps:\n` +
				`- Turn on your VPN (if required)\n` +
				`- Check Wi‑Fi / network connectivity\n` +
				`- Try again\n` +
				`\n` +
				`Technical details: ${cleaned}`
			);
		}
		if (lower.includes('enotfound') || lower.includes('eai_again') || lower.includes('getaddrinfo')) {
			return (
				`Couldn't resolve the cluster host for ${cluster}${dbSuffix}.\n` +
				`Next steps:\n` +
				`- Verify the cluster URL is correct\n` +
				`- Turn on your VPN (if required)\n` +
				`- Check DNS / network connectivity\n` +
				`\n` +
				`Technical details: ${cleaned}`
			);
		}
		if (lower.includes('econnrefused') || lower.includes('connection refused')) {
			return (
				`Connection was refused by ${cluster}${dbSuffix}.\n` +
				`Next steps:\n` +
				`- Verify the cluster URL is correct\n` +
				`- Check VPN / proxy / firewall rules\n` +
				`- Try again\n` +
				`\n` +
				`Technical details: ${cleaned}`
			);
		}
		if (lower.includes('aads') || lower.includes('aadsts') || lower.includes('unauthorized') || lower.includes('authentication')) {
			return (
				`Authentication failed connecting to ${cluster}${dbSuffix}.\n` +
				`Next steps:\n` +
				`- Re-authenticate (sign in again)\n` +
				`- Confirm you have access to the database\n` +
				`- Try again\n` +
				`\n` +
				`Technical details: ${cleaned}`
			);
		}

		// For typical Kusto semantic/syntax errors, showing the first line is usually helpful.
		const firstLine = cleaned.split(/\r?\n/)[0]?.trim() ?? '';
		const isJsonLike = firstLine.startsWith('{') || firstLine.startsWith('[');
		const isKustoQueryError = /\b(semantic|syntax)\s+error\b/i.test(firstLine);
		const includeSnippet = !!firstLine && !isJsonLike && (isKustoQueryError || firstLine.length <= 160);

		return includeSnippet
			? `Query failed${dbSuffix}: ${firstLine}`
			: `Query failed${dbSuffix}: ${cleaned || 'Unknown error'}`;
	}

	private logQueryExecutionError(error: unknown, connection: KustoConnection, database: string | undefined, boxId: string, query: string): void {
		try {
			const raw = this.getErrorMessage(error);
			const cluster = String(connection.clusterUrl || '').trim();
			this.output.appendLine(`[${new Date().toISOString()}] Query execution failed`);
			this.output.appendLine(`  cluster: ${cluster}`);
			if (database) {
				this.output.appendLine(`  database: ${database}`);
			}
			if (boxId) {
				this.output.appendLine(`  boxId: ${boxId}`);
			}
			this.output.appendLine('  query:');
			this.output.appendLine(query);
			this.output.appendLine('  error:');
			this.output.appendLine(raw);
			this.output.appendLine('');
		} catch {
			// ignore
		}
	}

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager,
		private readonly context: vscode.ExtensionContext
	) {
		this.kustoClient = new KustoQueryClient(this.context);
		this.kqlLanguageHost = new KqlLanguageServiceHost(this.connectionManager, this.context);
		this.loadLastSelection();
		// Avoid storing large schema payloads in globalState (causes warnings and slows down).
		// Best-effort migration of a small recent subset, then clear the legacy globalState cache.
		void this.migrateCachedSchemasToDiskOnce();
	}

	private getSchemaCacheDirUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.context.globalStorageUri, 'schemaCache');
	}

	private getSchemaCacheFileUri(cacheKey: string): vscode.Uri {
		const hash = crypto.createHash('sha1').update(cacheKey, 'utf8').digest('hex');
		return vscode.Uri.joinPath(this.getSchemaCacheDirUri(), `${hash}.json`);
	}

	private async migrateCachedSchemasToDiskOnce(): Promise<void> {
		try {
			const already = this.context.globalState.get<boolean>(STORAGE_KEYS.cachedSchemasMigratedToDisk);
			if (already) {
				return;
			}
			const legacy = this.context.globalState.get<Record<string, CachedSchemaEntry> | undefined>(
				STORAGE_KEYS.cachedSchemas
			);
			if (legacy && typeof legacy === 'object') {
				const entries = Object.entries(legacy)
					.filter(([, v]) => !!v && typeof v === 'object' && !!(v as any).schema)
					.sort((a, b) => (b[1].timestamp ?? 0) - (a[1].timestamp ?? 0))
					.slice(0, 25);
				for (const [key, entry] of entries) {
					try {
						await this.saveCachedSchemaToDisk(key, entry);
					} catch {
						// ignore
					}
				}
			}
			// Clear legacy cache to stop VS Code "large extension state" warnings.
			await this.context.globalState.update(STORAGE_KEYS.cachedSchemas, undefined);
			await this.context.globalState.update(STORAGE_KEYS.cachedSchemasMigratedToDisk, true);
		} catch {
			// ignore
		}
	}

	async initializeWebviewPanel(
		panel: vscode.WebviewPanel,
		options?: { registerMessageHandler?: boolean }
	): Promise<void> {
		this.panel = panel;
		try {
			const light = vscode.Uri.joinPath(this.extensionUri, 'media', 'images', 'kusto-file-light.svg');
			const dark = vscode.Uri.joinPath(this.extensionUri, 'media', 'images', 'kusto-file-dark.svg');
			this.panel.iconPath = { light, dark };
		} catch {
			// ignore
		}
		this.panel.webview.html = await getQueryEditorHtml(this.panel.webview, this.extensionUri, this.context);

		const shouldRegisterMessageHandler = options?.registerMessageHandler !== false;
		if (shouldRegisterMessageHandler) {
			// Ensure messages from the webview are handled in all host contexts (including custom editors).
			// openEditor() also wires this up for the standalone panel, but custom editors call initializeWebviewPanel().
			this.panel.webview.onDidReceiveMessage((message: IncomingWebviewMessage) => {
				return this.handleWebviewMessage(message);
			});
		}

		this.panel.onDidDispose(() => {
			this.cancelAllRunningQueries();
			this.panel = undefined;
		});
	}

	async openEditor(): Promise<void> {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			return;
		}

		this.panel = vscode.window.createWebviewPanel(
			'kustoQueryEditor',
			'Kusto Query Editor',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [this.extensionUri],
				retainContextWhenHidden: true
			}
		);
		try {
			const light = vscode.Uri.joinPath(this.extensionUri, 'media', 'images', 'kusto-file-light.svg');
			const dark = vscode.Uri.joinPath(this.extensionUri, 'media', 'images', 'kusto-file-dark.svg');
			this.panel.iconPath = { light, dark };
		} catch {
			// ignore
		}

		this.panel.webview.html = await getQueryEditorHtml(this.panel.webview, this.extensionUri, this.context);


		this.panel.webview.onDidReceiveMessage((message: IncomingWebviewMessage) => {
			return this.handleWebviewMessage(message);
		});

		this.panel.onDidDispose(() => {
			this.cancelAllRunningQueries();
			this.panel = undefined;
		});
	}

	public async handleWebviewMessage(message: IncomingWebviewMessage): Promise<void> {
		switch (message.type) {
			case 'resolveResourceUri':
				await this.resolveResourceUri(message);
				return;
			case 'getConnections':
				await this.sendConnectionsData();
				return;
			case 'seeCachedValues':
				await vscode.commands.executeCommand('kusto.seeCachedValues');
				return;
			case 'requestAddFavorite':
				await this.promptAddFavorite(message);
				return;
			case 'removeFavorite':
				await this.removeFavorite(message.clusterUrl, message.database);
				return;
			case 'confirmRemoveFavorite':
				await this.confirmRemoveFavorite(message);
				return;
			case 'addConnectionsForClusters':
				await this.addConnectionsForClusters(message.clusterUrls);
				await this.sendConnectionsData();
				return;
			case 'promptImportConnectionsXml':
				await this.promptImportConnectionsXml(message.boxId);
				return;
			case 'setCaretDocsEnabled':
				await this.context.globalState.update(STORAGE_KEYS.caretDocsEnabled, !!message.enabled);
				return;
			case 'getDatabases':
				await this.sendDatabases(message.connectionId, message.boxId, false);
				return;
			case 'refreshDatabases':
				await this.sendDatabases(message.connectionId, message.boxId, true);
				return;
			case 'showInfo':
				vscode.window.showInformationMessage(message.message);
				return;
			case 'checkCopilotAvailability':
				await this.checkCopilotAvailability(message.boxId);
				return;
			case 'prepareOptimizeQuery':
				await this.prepareOptimizeQuery(message);
				return;
			case 'cancelOptimizeQuery':
				this.cancelOptimizeQuery(message.boxId);
				return;
			case 'optimizeQuery':
				await this.optimizeQueryWithCopilot(message);
				return;
			case 'executeQuery':
				await this.executeQueryFromWebview(message);
				return;
			case 'cancelQuery':
				this.cancelRunningQuery(message.boxId);
				return;
			case 'executePython':
				await this.executePythonFromWebview(message);
				return;
			case 'fetchUrl':
				await this.fetchUrlFromWebview(message);
				return;
			case 'prefetchSchema':
				await this.prefetchSchema(message.connectionId, message.database, message.boxId, !!message.forceRefresh, message.requestToken);
				return;
			case 'importConnectionsFromXml':
				await this.importConnectionsFromXml(message.connections);
				await this.sendConnectionsData();
				return;
			case 'promptAddConnection':
				await this.promptAddConnection(message.boxId);
				return;
			case 'kqlLanguageRequest':
				await this.handleKqlLanguageRequest(message);
				return;
			default:
				return;
		}
	}

	private async resolveResourceUri(message: Extract<IncomingWebviewMessage, { type: 'resolveResourceUri' }>): Promise<void> {
		const requestId = String(message.requestId || '');
		const rawPath = String(message.path || '');
		const rawBase = typeof message.baseUri === 'string' ? String(message.baseUri || '') : '';

		const reply = (payload: { ok: boolean; uri?: string; error?: string }) => {
			try {
				this.postMessage({ type: 'resolveResourceUriResult', requestId, ...payload } as any);
			} catch {
				// ignore
			}
		};

		if (!requestId) {
			return;
		}
		if (!rawPath.trim()) {
			reply({ ok: false, error: 'Empty path.' });
			return;
		}

		// Do not rewrite/serve remote URLs. ToastUI can load those directly (subject to CSP).
		const lower = rawPath.trim().toLowerCase();
		if (
			lower.startsWith('http://') ||
			lower.startsWith('https://') ||
			lower.startsWith('data:') ||
			lower.startsWith('blob:') ||
			lower.startsWith('vscode-webview://') ||
			lower.startsWith('vscode-resource:')
		) {
			reply({ ok: true, uri: rawPath.trim() });
			return;
		}

		// We only support resolving file-based documents for now.
		let baseUri: vscode.Uri | null = null;
		try {
			if (rawBase) {
				baseUri = vscode.Uri.parse(rawBase);
			}
		} catch {
			baseUri = null;
		}
		if (!baseUri || baseUri.scheme !== 'file') {
			reply({ ok: false, error: 'Missing or unsupported baseUri. Only local files are supported.' });
			return;
		}

		let targetUri: vscode.Uri;
		try {
			// Normalize markdown-style paths (always forward slashes).
			const normalized = rawPath.replace(/\\/g, '/');

			// Markdown sometimes uses leading-slash paths to mean "workspace root".
			// On Windows, path.isAbsolute('/foo') is true but it is not a meaningful local path.
			if (normalized.startsWith('/')) {
				const wf = vscode.workspace.getWorkspaceFolder(baseUri);
				const rel = normalized.replace(/^\/+/, '');
				if (wf && rel) {
					targetUri = vscode.Uri.joinPath(wf.uri, ...rel.split('/'));
				} else {
					const baseDir = path.dirname(baseUri.fsPath);
					const resolvedFsPath = path.resolve(baseDir, rel);
					targetUri = vscode.Uri.file(resolvedFsPath);
				}
			} else {
				const isWindowsAbsolute = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//');
				const isPosixAbsolute = !isWindowsAbsolute && path.posix.isAbsolute(normalized);
				if (isWindowsAbsolute || (isPosixAbsolute && process.platform !== 'win32')) {
					targetUri = vscode.Uri.file(normalized);
				} else {
					const baseDir = path.dirname(baseUri.fsPath);
					const resolvedFsPath = path.resolve(baseDir, normalized);
					targetUri = vscode.Uri.file(resolvedFsPath);
				}
			}
		} catch (e) {
			reply({ ok: false, error: `Failed to resolve path: ${this.getErrorMessage(e)}` });
			return;
		}

		const cacheKey = `${baseUri.toString()}::${rawPath}`;
		const cached = this.resolvedResourceUriCache.get(cacheKey);
		if (cached) {
			reply({ ok: true, uri: cached });
			return;
		}

		try {
			await vscode.workspace.fs.stat(targetUri);
		} catch {
			reply({ ok: false, error: 'File not found.' });
			return;
		}

		if (!this.panel) {
			reply({ ok: false, error: 'Webview panel is not available.' });
			return;
		}

		try {
			const webviewUri = this.panel.webview.asWebviewUri(targetUri).toString();
			this.resolvedResourceUriCache.set(cacheKey, webviewUri);
			reply({ ok: true, uri: webviewUri });
		} catch (e) {
			reply({ ok: false, error: `Failed to create webview URI: ${this.getErrorMessage(e)}` });
		}
	}

	private async handleKqlLanguageRequest(
		message: Extract<IncomingWebviewMessage, { type: 'kqlLanguageRequest' }>
	): Promise<void> {
		const requestId = String(message.requestId || '').trim();
		if (!requestId) {
			return;
		}
		try {
			const params = message.params && typeof message.params === 'object' ? message.params : { text: '' };
			switch (message.method) {
				case 'textDocument/diagnostic': {
					const result = await this.kqlLanguageHost.getDiagnostics(params);
					this.postMessage({ type: 'kqlLanguageResponse', requestId, ok: true, result });
					return;
				}
				case 'kusto/findTableReferences': {
					const result = await this.kqlLanguageHost.findTableReferences(params);
					this.postMessage({ type: 'kqlLanguageResponse', requestId, ok: true, result });
					return;
				}
				default:
					this.postMessage({
						type: 'kqlLanguageResponse',
						requestId,
						ok: false,
						error: { message: 'Unsupported method.' }
					});
					return;
			}
		} catch (error) {
			const raw = this.getErrorMessage(error);
			this.output.appendLine(`[kql-ls] request failed: ${raw}`);
			this.postMessage({
				type: 'kqlLanguageResponse',
				requestId,
				ok: false,
				error: { message: 'KQL language service failed to process the request.' }
			});
		}
	}

	private cancelOptimizeQuery(boxId: string): void {
		const id = String(boxId || '').trim();
		if (!id) {
			return;
		}
		const running = this.runningOptimizeByBoxId.get(id);
		if (!running) {
			return;
		}
		try {
			this.postMessage({ type: 'optimizeQueryStatus', boxId: id, status: 'Canceling…' } as any);
		} catch {
			// ignore
		}
		try {
			running.cancel();
		} catch {
			// ignore
		}
	}

	private normalizeClusterUrlKey(url: string): string {
		try {
			const raw = String(url || '').trim();
			if (!raw) {
				return '';
			}
			const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
			const u = new URL(withScheme);
			return (u.origin + u.pathname).replace(/\/+$/g, '').toLowerCase();
		} catch {
			return String(url || '').trim().replace(/\/+$/g, '').toLowerCase();
		}
	}

	private ensureHttpsUrl(url: string): string {
		const raw = String(url || '').trim();
		if (!raw) {
			return '';
		}
		if (/^https?:\/\//i.test(raw)) {
			return raw;
		}
		return `https://${raw.replace(/^\/+/, '')}`;
	}

	private getDefaultConnectionName(clusterUrl: string): string {
		try {
			const withScheme = this.ensureHttpsUrl(clusterUrl);
			const u = new URL(withScheme);
			return u.hostname || withScheme;
		} catch {
			return String(clusterUrl || '').trim() || 'Kusto Cluster';
		}
	}

	private getClusterShortNameKey(clusterUrl: string): string {
		try {
			const withScheme = this.ensureHttpsUrl(clusterUrl);
			const u = new URL(withScheme);
			const host = String(u.hostname || '').trim();
			const first = host ? host.split('.')[0] : '';
			return String(first || host || clusterUrl || '').trim().toLowerCase();
		} catch {
			return String(clusterUrl || '').trim().toLowerCase();
		}
	}

	private async addConnectionsForClusters(clusterUrls: string[]): Promise<void> {
		const urls = Array.isArray(clusterUrls) ? clusterUrls : [];
		if (!urls.length) {
			return;
		}

		const existing = this.connectionManager.getConnections();
		const existingKeys = new Set(existing.map((c) => this.getClusterShortNameKey(c.clusterUrl || '')).filter(Boolean));

		for (const u of urls) {
			const original = String(u || '').trim();
			if (!original) {
				continue;
			}
			const key = this.getClusterShortNameKey(original);
			if (!key || existingKeys.has(key)) {
				continue;
			}
			const clusterUrl = this.ensureHttpsUrl(original);
			await this.connectionManager.addConnection({
				name: this.getDefaultConnectionName(clusterUrl),
				clusterUrl,
				database: undefined
			});
			existingKeys.add(key);
		}
	}

	private async promptImportConnectionsXml(boxId?: string): Promise<void> {
		try {
			const localAppData = process.env.LOCALAPPDATA;
			const base = localAppData && localAppData.trim()
				? localAppData.trim()
				: path.join(os.homedir(), 'AppData', 'Local');
			const defaultFolder = path.join(base, 'Kusto.Explorer');
			const defaultUri = vscode.Uri.file(defaultFolder);

			const picked = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				defaultUri,
				openLabel: 'Import',
				filters: {
					'XML files': ['xml'],
					'All files': ['*']
				}
			});
			if (!picked || picked.length === 0) {
				return;
			}
			const uri = picked[0];
			const bytes = await vscode.workspace.fs.readFile(uri);
			const text = new TextDecoder('utf-8').decode(bytes);
			this.postMessage({
				type: 'importConnectionsXmlText',
				boxId,
				text,
				fileName: path.basename(uri.fsPath)
			});
		} catch (e: any) {
			const error = typeof e?.message === 'string' ? e.message : String(e);
			this.postMessage({ type: 'importConnectionsXmlError', boxId, error });
		}
	}

	public async refreshConnectionsData(): Promise<void> {
		await this.sendConnectionsData();
	}

	private cancelRunningQuery(boxId: string): void {
		const id = String(boxId || '').trim();
		if (!id) {
			return;
		}
		const running = this.runningQueriesByBoxId.get(id);
		if (!running) {
			return;
		}
		try {
			running.cancel();
		} catch {
			// ignore
		}
	}

	private async checkCopilotAvailability(boxId: string): Promise<void> {
		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			const available = models.length > 0;
			
			this.postMessage({
				type: 'copilotAvailability',
				boxId,
				available
			});
		} catch (err) {
			// Copilot not available
			this.postMessage({
				type: 'copilotAvailability',
				boxId,
				available: false
			});
		}
	}

	private formatCopilotModelLabel(model: vscode.LanguageModelChat): string {
		const vendor = String((model as any).vendor ?? 'copilot');
		const family = String((model as any).family ?? '').trim();
		const version = String((model as any).version ?? '').trim();
		const name = String((model as any).name ?? '').trim();
		const id = String((model as any).id ?? '').trim();

		const primary = name || [family, version].filter(Boolean).join(' ') || id || 'model';
		return vendor && vendor !== 'copilot' ? `${vendor}: ${primary}` : primary;
	}

	private buildOptimizeQueryPrompt(query: string): string {
		return `Role: You are a senior Kusto Query Language (KQL) performance engineer.

Task: Rewrite the KQL query below to improve performance while preserving **exactly** the same output rows and values (same schema, same grouping keys, same aggregations, same results).

Hard constraints:
- Do **not** change functionality, semantics, or returned results in any way.
- If you are not 100% sure a change is equivalent, **do not** make it.
- Keep the query readable and idiomatic KQL.

Optimization rules (apply in this order, as applicable):
1) Push the most selective filters as early as possible (ideally immediately after the table):
	- Highest priority: time filters and numeric/boolean filters
	- Next: fast string operators like \`has\`, \`has_any\`
	- Last: slower string operators like \`contains\`, regex
2) Consolidate transformations with \`summarize\` when equivalent:
	- If \`extend\` outputs are only used as \`summarize by\` keys or aggregates, move/inline them into \`summarize\` instead of carrying them earlier.
3) Project away unused columns early (especially before heavy operators):
	- Add \`project\` / \`project-away\` to reduce carried columns, but only if it cannot affect semantics.
	- For dynamic/JSON fields, prefer extracting only what is needed (and only when needed).
4) Replace \`contains\` with \`has\` only when it is guaranteed to be equivalent for the given literal and data (no false negatives/positives).

Output format:
- Return **ONLY** the optimized query in a single \`\`\`kusto\`\`\` code block.
- No explanation, no bullets, no extra text.

Original query:
\`\`\`kusto
${query}
\`\`\``;
	}

	private async prepareOptimizeQuery(
		message: Extract<IncomingWebviewMessage, { type: 'prepareOptimizeQuery' }>
	): Promise<void> {
		const boxId = String(message.boxId || '').trim();
		const query = String(message.query || '');
		if (!boxId) {
			return;
		}

		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			if (models.length === 0) {
				this.postMessage({
					type: 'optimizeQueryError',
					boxId,
					error: 'Copilot not available'
				});
				return;
			}

			const modelOptions = models
				.map(m => ({ id: String(m.id), label: this.formatCopilotModelLabel(m) }))
				.filter(m => !!m.id);

			const lastModelId = this.context.globalState.get<string>(STORAGE_KEYS.lastOptimizeCopilotModelId);
			const preferredModelId = String(lastModelId || '').trim();
			const selectedModelId = preferredModelId && modelOptions.some(m => m.id === preferredModelId)
				? preferredModelId
				: (modelOptions[0]?.id || '');

			this.postMessage({
				type: 'optimizeQueryOptions',
				boxId,
				models: modelOptions,
				selectedModelId,
				promptText: this.buildOptimizeQueryPrompt(query)
			});
		} catch (err: any) {
			const errorMsg = err?.message || String(err);
			console.error('Failed to prepare optimize query options:', err);
			this.postMessage({
				type: 'optimizeQueryError',
				boxId,
				error: errorMsg
			});
		}
	}

	private async optimizeQueryWithCopilot(
		message: Extract<IncomingWebviewMessage, { type: 'optimizeQuery' }>
	): Promise<void> {
		const { query, connectionId, database, boxId, queryName, modelId, promptText } = message;
		const id = String(boxId || '').trim();
		if (!id) {
			return;
		}

		// Cancel any prior optimization for this box.
		try {
			const existing = this.runningOptimizeByBoxId.get(id);
			if (existing) {
				existing.cancel();
				this.runningOptimizeByBoxId.delete(id);
			}
		} catch {
			// ignore
		}
		const cts = new vscode.CancellationTokenSource();
		this.runningOptimizeByBoxId.set(id, cts);

		const postStatus = (status: string) => {
			try {
				this.postMessage({ type: 'optimizeQueryStatus', boxId: id, status } as any);
			} catch {
				// ignore
			}
		};

		try {
			postStatus('Selecting Copilot model…');
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			if (models.length === 0) {
				vscode.window.showWarningMessage('GitHub Copilot is not available. Please enable Copilot to use query optimization.');
				this.postMessage({
					type: 'optimizeQueryError',
					boxId: id,
					error: 'Copilot not available'
				});
				return;
			}
			const requestedModelId = String(modelId || '').trim();
			let model: vscode.LanguageModelChat | undefined;
			if (requestedModelId) {
				model = models.find(m => m.id === requestedModelId);
			}
			if (!model) {
				model = models[0];
			}
			try {
				await this.context.globalState.update(STORAGE_KEYS.lastOptimizeCopilotModelId, String(model.id));
			} catch {
				// ignore
			}
			try {
				postStatus(`Using model: ${this.formatCopilotModelLabel(model)}`);
			} catch {
				// ignore
			}

			postStatus('Sending request to Copilot…');

			const effectivePromptText = String(promptText || '').trim() || this.buildOptimizeQueryPrompt(query);

			const response = await model.sendRequest(
				[vscode.LanguageModelChatMessage.User(effectivePromptText)],
				{},
				cts.token
			);

			postStatus('Waiting for Copilot response…');

			let optimizedQuery = '';
			let lastProgressUpdate = 0;
			for await (const fragment of response.text) {
				if (cts.token.isCancellationRequested) {
					throw new Error('Optimization canceled');
				}
				optimizedQuery += fragment;
				const now = Date.now();
				if (now - lastProgressUpdate > 600) {
					lastProgressUpdate = now;
					postStatus(`Receiving response… (${optimizedQuery.length} chars)`);
				}
			}

			postStatus('Parsing optimized query…');

			// Extract the query from markdown code block
			const codeBlockMatch = optimizedQuery.match(/```(?:kusto|kql)?\s*\n([\s\S]*?)\n```/);
			if (codeBlockMatch) {
				optimizedQuery = codeBlockMatch[1].trim();
			} else {
				// If no code block, use the entire response trimmed
				optimizedQuery = optimizedQuery.trim();
			}

			if (!optimizedQuery) {
				throw new Error('Failed to extract optimized query from Copilot response');
			}

			postStatus('Done. Creating comparison…');

			// Return the optimized query to webview for comparison box creation
			this.postMessage({
				type: 'optimizeQueryReady',
				boxId: id,
				optimizedQuery,
				queryName,
				connectionId,
				database
			});

		} catch (err: any) {
			const errorMsg = err?.message || String(err);
			console.error('Query optimization failed:', err);
			const canceled = cts.token.isCancellationRequested || /cancel/i.test(errorMsg);
			if (canceled) {
				try {
					this.postMessage({ type: 'optimizeQueryError', boxId: id, error: 'Optimization canceled' });
				} catch {
					// ignore
				}
				return;
			}
			
			if (err instanceof vscode.LanguageModelError) {
				if (err.cause instanceof Error && err.cause.message.includes('off_topic')) {
					vscode.window.showWarningMessage('Copilot declined to optimize this query.');
				} else {
					vscode.window.showErrorMessage(`Copilot error: ${err.message}`);
				}
			} else {
				vscode.window.showErrorMessage(`Failed to optimize query: ${errorMsg}`);
			}

			this.postMessage({
				type: 'optimizeQueryError',
				boxId: id,
				error: errorMsg
			});
		} finally {
			try {
				this.runningOptimizeByBoxId.delete(id);
			} catch {
				// ignore
			}
			try {
				cts.dispose();
			} catch {
				// ignore
			}
		}
	}

	private cancelAllRunningQueries(): void {
		for (const [, running] of this.runningQueriesByBoxId) {
			try {
				running.cancel();
			} catch {
				// ignore
			}
		}
		this.runningQueriesByBoxId.clear();
	}

	private async executePythonFromWebview(
		message: Extract<IncomingWebviewMessage, { type: 'executePython' }>
	): Promise<void> {
		const boxId = String(message.boxId || '').trim();
		const code = String(message.code || '');
		if (!boxId) {
			return;
		}

		const timeoutMs = 15000;
		const maxBytes = 200 * 1024;
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;

		const runOnce = (cmd: string, args: string[]) => {
			return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
				let stdout = '';
				let stderr = '';
				let done = false;
				let killedByTimeout = false;
				const child = spawn(cmd, args, {
					cwd,
					shell: false,
					stdio: ['pipe', 'pipe', 'pipe']
				});

				const timer = setTimeout(() => {
					killedByTimeout = true;
					try {
						child.kill();
					} catch {
						// ignore
					}
				}, timeoutMs);

				const append = (current: string, chunk: Buffer) => {
					if (current.length >= maxBytes) {
						return current;
					}
					const toAdd = chunk.toString('utf8');
					const next = current + toAdd;
					return next.length > maxBytes ? next.slice(0, maxBytes) : next;
				};

				child.stdout?.on('data', (d: Buffer) => {
					stdout = append(stdout, d);
				});
				child.stderr?.on('data', (d: Buffer) => {
					stderr = append(stderr, d);
				});
				child.on('error', (err) => {
					if (done) {
						return;
					}
					done = true;
					clearTimeout(timer);
					reject(err);
				});
				child.on('close', (exitCode) => {
					if (done) {
						return;
					}
					done = true;
					clearTimeout(timer);
					if (killedByTimeout) {
						stderr = (stderr ? stderr + '\n' : '') + `Timed out after ${Math.round(timeoutMs / 1000)}s.`;
					}
					resolve({ stdout, stderr, exitCode: typeof exitCode === 'number' ? exitCode : -1 });
				});

				try {
					child.stdin?.write(code);
					child.stdin?.end();
				} catch {
					// ignore
				}
			});
		};

		const candidates: Array<{ cmd: string; args: string[] }> = [
			{ cmd: 'python', args: ['-'] },
			{ cmd: 'python3', args: ['-'] },
			{ cmd: 'py', args: ['-'] }
		];

		let lastError: unknown = undefined;
		for (const c of candidates) {
			try {
				const result = await runOnce(c.cmd, c.args);
				this.postMessage({ type: 'pythonResult', boxId, ...result });
				return;
			} catch (e: any) {
				lastError = e;
				// Command not found: try the next candidate.
				if (e && (e.code === 'ENOENT' || String(e.message || '').includes('ENOENT'))) {
					continue;
				}
				// Other errors: stop early.
				break;
			}
		}

		const errMsg = lastError && typeof (lastError as any).message === 'string'
			? (lastError as any).message
			: 'Python execution failed (python not found?).';
		this.postMessage({ type: 'pythonError', boxId, error: errMsg });
	}

	private async fetchUrlFromWebview(message: Extract<IncomingWebviewMessage, { type: 'fetchUrl' }>): Promise<void> {
		const boxId = String(message.boxId || '').trim();
		const rawUrl = String(message.url || '').trim();
		if (!boxId) {
			return;
		}
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			this.postMessage({ type: 'urlError', boxId, error: 'Invalid URL.' });
			return;
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			this.postMessage({ type: 'urlError', boxId, error: 'Only http/https URLs are supported.' });
			return;
		}

		const timeoutMs = 15000;
		const maxChars = 200000;
		const maxBytes = 5 * 1024 * 1024; // 5MB cap for binary content (images/pages/etc.)
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), timeoutMs);
		try {
			const resp = await fetch(url.toString(), {
				redirect: 'follow',
				signal: ac.signal
			});
			const contentType = resp.headers.get('content-type') || '';
			const ctLower = contentType.toLowerCase();
			const finalUrl = resp.url || url.toString();

			// Read as bytes so we can support images and other non-text content.
			const ab = await resp.arrayBuffer();
			const bytes = Buffer.from(ab);
			if (bytes.byteLength > maxBytes) {
				this.postMessage({
					type: 'urlError',
					boxId,
					error: `Response too large (${Math.round(bytes.byteLength / 1024)} KB). Max is ${Math.round(maxBytes / 1024)} KB.`
				});
				return;
			}

			const pathLower = (() => {
				try {
					return new URL(finalUrl).pathname.toLowerCase();
				} catch {
					return '';
				}
			})();

			const looksLikeCsv = ctLower.includes('text/csv') || ctLower.includes('application/csv') || pathLower.endsWith('.csv');
			const looksLikeHtml = ctLower.includes('text/html') || pathLower.endsWith('.html') || pathLower.endsWith('.htm');
			const looksLikeImage = ctLower.startsWith('image/');
			const looksLikeText = ctLower.startsWith('text/') || ctLower.includes('json') || ctLower.includes('xml') || ctLower.includes('yaml');

			if (looksLikeImage) {
				const mime = contentType.split(';')[0].trim() || 'image/*';
				const base64 = bytes.toString('base64');
				const dataUri = `data:${mime};base64,${base64}`;
				this.postMessage({
					type: 'urlContent',
					boxId,
					url: finalUrl,
					contentType,
					status: resp.status,
					kind: 'image',
					dataUri,
					byteLength: bytes.byteLength
				});
				return;
			}

			// Default: decode as UTF-8 text.
			let body = bytes.toString('utf8');
			let truncated = false;
			if (body.length > maxChars) {
				body = body.slice(0, maxChars);
				truncated = true;
			}

			this.postMessage({
				type: 'urlContent',
				boxId,
				url: finalUrl,
				contentType,
				status: resp.status,
				kind: looksLikeCsv ? 'csv' : (looksLikeHtml ? 'html' : (looksLikeText ? 'text' : 'text')),
				body,
				truncated,
				byteLength: bytes.byteLength
			});
		} catch (e: any) {
			const msg = e?.name === 'AbortError'
				? `Timed out after ${Math.round(timeoutMs / 1000)}s.`
				: (typeof e?.message === 'string' ? e.message : 'Failed to fetch URL.');
			this.postMessage({ type: 'urlError', boxId, error: msg });
		} finally {
			clearTimeout(timer);
		}
	}

	private async promptAddConnection(boxId?: string): Promise<void> {
		const clusterUrlRaw = await vscode.window.showInputBox({
			prompt: 'Cluster URL',
			placeHolder: 'https://mycluster.region.kusto.windows.net',
			ignoreFocusOut: true
		});
		if (!clusterUrlRaw) {
			return;
		}

		let clusterUrl = clusterUrlRaw.trim();
		if (!/^https?:\/\//i.test(clusterUrl)) {
			clusterUrl = 'https://' + clusterUrl.replace(/^\/+/, '');
		}

		const name =
			(await vscode.window.showInputBox({
				prompt: 'Connection name (optional)',
				placeHolder: 'My cluster',
				ignoreFocusOut: true
			})) || '';
		const database =
			(await vscode.window.showInputBox({
				prompt: 'Default database (optional)',
				placeHolder: 'MyDatabase',
				ignoreFocusOut: true
			})) || '';

		const newConn = await this.connectionManager.addConnection({
			name: name.trim() || clusterUrl,
			clusterUrl,
			database: database.trim() || undefined
		});
		await this.saveLastSelection(newConn.id, newConn.database);

		// Notify webview so it can pick the newly created connection in the right box.
		this.postMessage({
			type: 'connectionAdded',
			boxId,
			connectionId: newConn.id,
			lastConnectionId: this.lastConnectionId,
			lastDatabase: this.lastDatabase,
			connections: this.connectionManager.getConnections(),
			cachedDatabases: this.getCachedDatabases()
		});
	}

	private async importConnectionsFromXml(
		connections: Array<{ name: string; clusterUrl: string; database?: string }>
	): Promise<void> {
		const incoming = Array.isArray(connections) ? connections : [];
		if (!incoming.length) {
			return;
		}

		const existing = this.connectionManager.getConnections();
		const existingByCluster = new Set(existing.map((c) => this.normalizeClusterUrlKey(c.clusterUrl || '')).filter(Boolean));

		let added = 0;
		for (const c of incoming) {
			const name = String(c?.name || '').trim();
			const clusterUrlRaw = String(c?.clusterUrl || '').trim();
			const database = c?.database ? String(c.database).trim() : undefined;
			if (!clusterUrlRaw) {
				continue;
			}
			const clusterUrl = this.ensureHttpsUrl(clusterUrlRaw).replace(/\/+$/g, '');
			const key = this.normalizeClusterUrlKey(clusterUrl);
			if (existingByCluster.has(key)) {
				continue;
			}
			await this.connectionManager.addConnection({
				name: name || clusterUrl,
				clusterUrl,
				database
			});
			existingByCluster.add(key);
			added++;
		}

		if (added > 0) {
			void vscode.window.showInformationMessage(`Imported ${added} Kusto connection${added === 1 ? '' : 's'}.`);
		} else {
			void vscode.window.showInformationMessage('No new connections were imported (they may already exist).');
		}
	}

	private postMessage(message: unknown): void {
		void this.panel?.webview.postMessage(message);
	}

	private loadLastSelection(): void {
		this.lastConnectionId = this.context.globalState.get<string>(STORAGE_KEYS.lastConnectionId);
		this.lastDatabase = this.context.globalState.get<string>(STORAGE_KEYS.lastDatabase);
	}

	private getFavorites(): KustoFavorite[] {
		const raw = this.context.globalState.get<unknown>(STORAGE_KEYS.favorites);
		if (!Array.isArray(raw)) {
			return [];
		}
		const out: KustoFavorite[] = [];
		for (const item of raw) {
			if (!item || typeof item !== 'object') {
				continue;
			}
			const maybe = item as Partial<KustoFavorite>;
			const name = String(maybe.name || '').trim();
			const clusterUrl = String(maybe.clusterUrl || '').trim();
			const database = String(maybe.database || '').trim();
			if (!name || !clusterUrl || !database) {
				continue;
			}
			out.push({ name, clusterUrl, database });
		}
		return out;
	}

	private normalizeFavoriteClusterUrl(clusterUrl: string): string {
		const normalized = this.ensureHttpsUrl(String(clusterUrl || '').trim());
		return normalized.replace(/\/+$/g, '');
	}

	private favoriteKey(clusterUrl: string, database: string): string {
		const c = this.normalizeClusterUrlKey(clusterUrl);
		const d = String(database || '').trim().toLowerCase();
		return `${c}|${d}`;
	}

	private getClusterShortName(clusterUrl: string): string {
		try {
			const withScheme = this.ensureHttpsUrl(clusterUrl);
			const u = new URL(withScheme);
			const host = String(u.hostname || '').trim();
			if (!host) {
				return this.getDefaultConnectionName(clusterUrl);
			}
			return host.split('.')[0] || host;
		} catch {
			return this.getDefaultConnectionName(clusterUrl);
		}
	}

	private async setFavorites(favorites: KustoFavorite[], boxId?: string): Promise<void> {
		await this.context.globalState.update(STORAGE_KEYS.favorites, favorites);
		await this.sendFavoritesData(boxId);
	}

	private async sendFavoritesData(boxId?: string): Promise<void> {
		const payload: any = { type: 'favoritesData', favorites: this.getFavorites() };
		if (boxId) {
			payload.boxId = boxId;
		}
		this.postMessage(payload);
	}

	private getCachedDatabases(): Record<string, string[]> {
		// Cached database lists are keyed by *cluster* (hostname), not by connection id.
		// We also support migrating legacy connection-id keyed entries.
		const raw = this.context.globalState.get<Record<string, string[]>>(STORAGE_KEYS.cachedDatabases, {});
		return this.migrateCachedDatabasesToClusterKeys(raw);
	}

	private getClusterCacheKey(clusterUrlRaw: string): string {
		try {
			const withScheme = this.ensureHttpsUrl(String(clusterUrlRaw || '').trim());
			const u = new URL(withScheme);
			const host = String(u.hostname || '').trim().toLowerCase();
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
			// Merge (dedupe) to avoid multiple lists for the same cluster.
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
			// Best-effort: persist the migrated form so future reads are stable.
			void this.context.globalState.update(STORAGE_KEYS.cachedDatabases, next);
		}
		return next;
	}

	private async getCachedSchemaFromDisk(cacheKey: string): Promise<CachedSchemaEntry | undefined> {
		try {
			const fileUri = this.getSchemaCacheFileUri(cacheKey);
			const buf = await vscode.workspace.fs.readFile(fileUri);
			const parsed = JSON.parse(Buffer.from(buf).toString('utf8')) as CachedSchemaEntry;
			if (!parsed || !parsed.schema || typeof parsed.timestamp !== 'number') {
				return undefined;
			}
			return parsed;
		} catch {
			return undefined;
		}
	}

	private async saveCachedSchemaToDisk(cacheKey: string, entry: CachedSchemaEntry): Promise<void> {
		const dir = this.getSchemaCacheDirUri();
		await vscode.workspace.fs.createDirectory(dir);
		const fileUri = this.getSchemaCacheFileUri(cacheKey);
		const json = JSON.stringify(entry);
		await vscode.workspace.fs.writeFile(fileUri, Buffer.from(json, 'utf8'));
	}

	private async deleteCachedSchemaFromDisk(cacheKey: string): Promise<void> {
		try {
			const fileUri = this.getSchemaCacheFileUri(cacheKey);
			await vscode.workspace.fs.delete(fileUri, { useTrash: false });
		} catch {
			// ignore
		}
	}

	private async saveCachedDatabases(connectionId: string, databases: string[]): Promise<void> {
		const connection = this.findConnection(connectionId);
		if (!connection) {
			return;
		}
		const clusterKey = this.getClusterCacheKey(connection.clusterUrl);
		if (!clusterKey) {
			return;
		}
		const cached = this.getCachedDatabases();
		cached[clusterKey] = databases;
		await this.context.globalState.update(STORAGE_KEYS.cachedDatabases, cached);
	}

	private async saveLastSelection(connectionId: string, database?: string): Promise<void> {
		this.lastConnectionId = connectionId;
		this.lastDatabase = database;
		await this.context.globalState.update(STORAGE_KEYS.lastConnectionId, connectionId);
		await this.context.globalState.update(STORAGE_KEYS.lastDatabase, database);
	}

	private findConnection(connectionId: string): KustoConnection | undefined {
		return this.connectionManager.getConnections().find((c) => c.id === connectionId);
	}

	private async sendConnectionsData(): Promise<void> {
		const connections = this.connectionManager.getConnections();
		const cachedDatabases = this.getCachedDatabases();
		const caretDocsEnabledStored = this.context.globalState.get<boolean>(STORAGE_KEYS.caretDocsEnabled);
		const caretDocsEnabled = typeof caretDocsEnabledStored === 'boolean' ? caretDocsEnabledStored : true;
		const caretDocsEnabledUserSet = typeof caretDocsEnabledStored === 'boolean';
		const favorites = this.getFavorites();

		this.postMessage({
			type: 'connectionsData',
			connections,
			lastConnectionId: this.lastConnectionId,
			lastDatabase: this.lastDatabase,
			cachedDatabases,
			favorites,
			caretDocsEnabled,
			caretDocsEnabledUserSet
		});
	}

	private async promptAddFavorite(
		message: Extract<IncomingWebviewMessage, { type: 'requestAddFavorite' }>
	): Promise<void> {
		const clusterUrlRaw = String(message.clusterUrl || '').trim();
		const databaseRaw = String(message.database || '').trim();
		if (!clusterUrlRaw || !databaseRaw) {
			return;
		}
		const clusterUrl = this.normalizeFavoriteClusterUrl(clusterUrlRaw);
		const database = databaseRaw;
		const defaultName =
			String(message.defaultName || '').trim() || `${this.getClusterShortName(clusterUrl)}.${database}`;

		const picked = await vscode.window.showInputBox({
			title: 'Add to favorites',
			prompt: 'Enter a friendly name for this cluster + database',
			value: defaultName,
			ignoreFocusOut: true
		});
		const name = typeof picked === 'string' ? picked.trim() : '';
		if (!name) {
			return;
		}
		await this.addOrUpdateFavorite({ name, clusterUrl, database }, message.boxId);
	}

	private async addOrUpdateFavorite(favorite: KustoFavorite, boxId?: string): Promise<void> {
		const name = String(favorite.name || '').trim();
		const clusterUrl = this.normalizeFavoriteClusterUrl(String(favorite.clusterUrl || '').trim());
		const database = String(favorite.database || '').trim();
		if (!name || !clusterUrl || !database) {
			return;
		}
		const key = this.favoriteKey(clusterUrl, database);
		const current = this.getFavorites();
		const next: KustoFavorite[] = [];
		let replaced = false;
		for (const f of current) {
			const fk = this.favoriteKey(f.clusterUrl, f.database);
			if (fk === key) {
				next.push({ name, clusterUrl, database });
				replaced = true;
			} else {
				next.push(f);
			}
		}
		if (!replaced) {
			next.push({ name, clusterUrl, database });
		}
		await this.setFavorites(next, boxId);
	}

	private async removeFavorite(clusterUrlRaw: string, databaseRaw: string): Promise<void> {
		const clusterUrl = this.normalizeFavoriteClusterUrl(String(clusterUrlRaw || '').trim());
		const database = String(databaseRaw || '').trim();
		if (!clusterUrl || !database) {
			return;
		}
		const key = this.favoriteKey(clusterUrl, database);
		const current = this.getFavorites();
		const next = current.filter((f) => this.favoriteKey(f.clusterUrl, f.database) !== key);
		await this.setFavorites(next);
	}

	private async confirmRemoveFavorite(
		message: Extract<IncomingWebviewMessage, { type: 'confirmRemoveFavorite' }>
	): Promise<void> {
		const requestId = String(message.requestId || '').trim();
		const clusterUrl = this.normalizeFavoriteClusterUrl(String(message.clusterUrl || '').trim());
		const database = String(message.database || '').trim();
		const label = String(message.label || '').trim();
		if (!requestId) {
			return;
		}

		let ok = false;
		try {
			const display = label || (clusterUrl && database ? `${clusterUrl} (${database})` : 'this favorite');
			const choice = await vscode.window.showWarningMessage(
				`Remove "${display}" from favorites?`,
				{ modal: true },
				'Remove'
			);
			ok = choice === 'Remove';
		} catch {
			ok = false;
		}

		this.postMessage({
			type: 'confirmRemoveFavoriteResult',
			requestId,
			ok,
			clusterUrl,
			database,
			boxId: message.boxId
		});
	}

	private async sendDatabases(connectionId: string, boxId: string, forceRefresh: boolean): Promise<void> {
		const connection = this.findConnection(connectionId);
		if (!connection) {
			return;
		}
		const clusterKey = this.getClusterCacheKey(connection.clusterUrl);
		const cachedBefore = (this.getCachedDatabases()[clusterKey] ?? []).filter(Boolean);

		const fetchAndNormalize = async (): Promise<string[]> => {
			const databasesRaw = await this.kustoClient.getDatabases(connection, true);
			return (Array.isArray(databasesRaw) ? databasesRaw : [])
				.map((d) => String(d || '').trim())
				.filter(Boolean)
				.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
		};

		try {
			let databasesRaw = await this.kustoClient.getDatabases(connection, forceRefresh);
			let databases = (Array.isArray(databasesRaw) ? databasesRaw : [])
				.map((d) => String(d || '').trim())
				.filter(Boolean)
				.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

			// Multi-account recovery:
			// If the user explicitly clicked refresh and we got an empty list (and we don't have a prior cached list),
			// it's very commonly because we're authenticated with an account that has no access to this cluster.
			// Prompt for a different account and retry once.
			if (forceRefresh && databases.length === 0 && cachedBefore.length === 0) {
				// First: clear session preference so the user can choose a different existing account.
				try {
					await this.kustoClient.reauthenticate(connection, 'clearPreference');
					databases = await fetchAndNormalize();
				} catch {
					// ignore; we'll either retry below or surface error
				}

				// If still empty, force a new session (sign in / add account) and retry once.
				if (databases.length === 0) {
					try {
						await this.kustoClient.reauthenticate(connection, 'forceNewSession');
						databases = await fetchAndNormalize();
					} catch {
						// ignore
					}
				}
			}

			// Don't wipe a previously-good cached list with an empty refresh result.
			if (!forceRefresh || databases.length > 0 || cachedBefore.length === 0) {
				await this.saveCachedDatabases(connectionId, databases);
				this.postMessage({ type: 'databasesData', databases, boxId });
				return;
			}

			this.postMessage({ type: 'databasesData', databases: cachedBefore, boxId });
			this.postMessage({
				type: 'databasesError',
				boxId,
				error:
					`Couldn't refresh the database list (received 0 databases). Continuing to use the previous list.\n` +
					`If you expected databases here, try refreshing again and sign in with a different account.`
			});
		} catch (error) {
			// If the user explicitly requested a refresh and we hit an auth-related error,
			// try to re-auth interactively and retry once.
			if (forceRefresh && this.kustoClient.isAuthenticationError(error)) {
				try {
					await this.kustoClient.reauthenticate(connection, 'clearPreference');
					const databases = await fetchAndNormalize();
					await this.saveCachedDatabases(connectionId, databases);
					this.postMessage({ type: 'databasesData', databases, boxId });
					return;
				} catch {
					try {
						await this.kustoClient.reauthenticate(connection, 'forceNewSession');
						const databases = await fetchAndNormalize();
						await this.saveCachedDatabases(connectionId, databases);
						this.postMessage({ type: 'databasesData', databases, boxId });
						return;
					} catch {
						// fall through to error UI
					}
				}
			}

			const userMessage = this.formatQueryExecutionErrorForUser(error, connection);
			const action = forceRefresh ? 'refresh' : 'load';
			this.postMessage({
				type: 'databasesError',
				boxId,
				error: `Failed to ${action} database list.\n${userMessage}`
			});
		}
	}

	private async executeQueryFromWebview(
		message: Extract<IncomingWebviewMessage, { type: 'executeQuery' }>
	): Promise<void> {
		await this.saveLastSelection(message.connectionId, message.database);

		const boxId = String(message.boxId || '').trim();
		if (boxId) {
			// If the user runs again in the same box, cancel the previous run.
			this.cancelRunningQuery(boxId);
		}

		const connection = this.findConnection(message.connectionId);
		if (!connection) {
			vscode.window.showErrorMessage('Connection not found');
			return;
		}

		if (!message.database) {
			vscode.window.showErrorMessage('Please select a database');
			return;
		}

		const queryWithMode = this.appendQueryMode(message.query, message.queryMode);
		const cacheDirective = this.buildCacheDirective(message.cacheEnabled, message.cacheValue, message.cacheUnit);
		const finalQuery = cacheDirective ? `${cacheDirective}\n${queryWithMode}` : queryWithMode;

		const cancelClientKey = boxId ? `${boxId}::${connection.id}` : connection.id;
		const { promise, cancel } = this.kustoClient.executeQueryCancelable(connection, message.database, finalQuery, cancelClientKey);
		const runSeq = ++this.queryRunSeq;
		const isStillActiveRun = () => {
			if (!boxId) {
				return true;
			}
			const current = this.runningQueriesByBoxId.get(boxId);
			return !!current && current.cancel === cancel && current.runSeq === runSeq;
		};
		if (boxId) {
			this.runningQueriesByBoxId.set(boxId, { cancel, runSeq });
		}
		try {
			const result = await promise;
			if (isStillActiveRun()) {
				this.postMessage({ type: 'queryResult', result, boxId });
			}
		} catch (error) {
			if ((error as any)?.name === 'QueryCancelledError' || (error as any)?.isCancelled === true) {
				if (isStillActiveRun()) {
					this.postMessage({ type: 'queryCancelled', boxId });
				}
				return;
			}
			if (isStillActiveRun()) {
				this.logQueryExecutionError(error, connection, message.database, boxId, finalQuery);
				const userMessage = this.formatQueryExecutionErrorForUser(error, connection, message.database);
				vscode.window.showErrorMessage(userMessage);
				this.postMessage({ type: 'queryError', error: userMessage, boxId });
			}
		} finally {
			if (boxId) {
				// Only clear if this is still the active run for the box.
				const current = this.runningQueriesByBoxId.get(boxId);
				if (current?.cancel === cancel && current.runSeq === runSeq) {
					this.runningQueriesByBoxId.delete(boxId);
				}
			}
		}
	}

	private buildCacheDirective(
		cacheEnabled?: boolean,
		cacheValue?: number,
		cacheUnit?: CacheUnit | string
	): string | undefined {
		if (!cacheEnabled || !cacheValue || !cacheUnit) {
			return undefined;
		}

		const unit = String(cacheUnit).toLowerCase();
		let timespan: string | undefined;
		switch (unit) {
			case 'minutes':
				timespan = `time(${cacheValue}m)`;
				break;
			case 'hours':
				timespan = `time(${cacheValue}h)`;
				break;
			case 'days':
				timespan = `time(${cacheValue}d)`;
				break;
			default:
				return undefined;
		}

		return `set query_results_cache_max_age = ${timespan};`;
	}

	private appendQueryMode(query: string, queryMode?: string): string {
		const mode = (queryMode ?? '').toLowerCase();
		let fragment = '';
		switch (mode) {
			case 'take100':
				fragment = '| take 100';
				break;
			case 'sample100':
				fragment = '| sample 100';
				break;
			case 'plain':
			case '':
			default:
				return query;
		}

		const base = query.replace(/\s+$/g, '').replace(/;+\s*$/g, '');
		return `${base}\n${fragment}`;
	}

	private async prefetchSchema(
		connectionId: string,
		database: string,
		boxId: string,
		forceRefresh: boolean,
		requestToken?: string
	): Promise<void> {
		const connection = this.findConnection(connectionId);
		if (!connection || !database) {
			return;
		}

		const cacheKey = `${connection.clusterUrl}|${database}`;
		// IMPORTANT: Never delete persisted schema cache up-front.
		// If a refresh fails (e.g. offline/VPN), we want to keep using the cached schema
		// for autocomplete until the next successful refresh.

		try {
			this.output.appendLine(
				`[schema] request connectionId=${connectionId} db=${database} forceRefresh=${forceRefresh}`
			);

			// Read persisted cache once so we can (a) use it when fresh, and (b) fall back to it on errors.
			const cached = await this.getCachedSchemaFromDisk(cacheKey);
			const cachedAgeMs = cached ? Date.now() - cached.timestamp : undefined;
			const cachedIsFresh = !!(cached && typeof cachedAgeMs === 'number' && cachedAgeMs < this.SCHEMA_CACHE_TTL_MS);

			// Default path: use persisted cache when it's still fresh.
			if (!forceRefresh && cached && cachedIsFresh) {
				const schema = cached.schema;
				const tablesCount = schema.tables?.length ?? 0;
				let columnsCount = 0;
				for (const cols of Object.values(schema.columnsByTable || {})) {
					columnsCount += cols.length;
				}

				this.output.appendLine(
					`[schema] loaded (persisted cache) db=${database} tables=${tablesCount} columns=${columnsCount}`
				);
				this.postMessage({
					type: 'schemaData',
					boxId,
					connectionId,
					database,
					requestToken,
					schema,
					schemaMeta: {
						fromCache: true,
						cacheAgeMs: cachedAgeMs,
						tablesCount,
						columnsCount
					}
				});
				return;
			}

			const result = await this.kustoClient.getDatabaseSchema(connection, database, forceRefresh);
			const schema = result.schema;

			const tablesCount = schema.tables?.length ?? 0;
			let columnsCount = 0;
			for (const cols of Object.values(schema.columnsByTable || {})) {
				columnsCount += cols.length;
			}

			this.output.appendLine(
				`[schema] loaded db=${database} tables=${tablesCount} columns=${columnsCount} fromCache=${result.fromCache}`
			);

			// Persist schema across VS Code sessions.
			const timestamp = result.fromCache
				? Date.now() - (result.cacheAgeMs ?? 0)
				: Date.now();
			await this.saveCachedSchemaToDisk(cacheKey, { schema, timestamp });
			if (tablesCount === 0 || columnsCount === 0) {
				const d = result.debug;
				if (d) {
					this.output.appendLine(`[schema] debug command=${d.commandUsed ?? ''}`);
					this.output.appendLine(`[schema] debug columns=${(d.primaryColumns ?? []).join(', ')}`);
					this.output.appendLine(
						`[schema] debug sampleRowType=${d.sampleRowType ?? ''} keys=${(d.sampleRowKeys ?? []).join(', ')}`
					);
					this.output.appendLine(`[schema] debug sampleRowPreview=${d.sampleRowPreview ?? ''}`);
				}
			}

			this.postMessage({
				type: 'schemaData',
				boxId,
				connectionId,
				database,
				requestToken,
				schema,
				schemaMeta: {
					fromCache: result.fromCache,
					cacheAgeMs: result.cacheAgeMs,
					tablesCount,
					columnsCount,
					debug: result.debug
				}
			});
		} catch (error) {
			const rawMessage = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`[schema] error db=${database}: ${rawMessage}`);

			// If we have any cached schema (even stale), keep using it for autocomplete.
			// For a user-initiated refresh we still show an error message, but we don't wipe the cache.
			try {
				const cached = await this.getCachedSchemaFromDisk(cacheKey);
				if (cached && cached.schema) {
					const schema = cached.schema;
					const tablesCount = schema.tables?.length ?? 0;
					let columnsCount = 0;
					for (const cols of Object.values(schema.columnsByTable || {})) {
						columnsCount += cols.length;
					}

					this.output.appendLine(
						`[schema] using cached schema after failure db=${database} tables=${tablesCount} columns=${columnsCount}`
					);
					this.postMessage({
						type: 'schemaData',
						boxId,
						connectionId,
						database,
						requestToken,
						schema,
						schemaMeta: {
							fromCache: true,
							cacheAgeMs: Date.now() - cached.timestamp,
							tablesCount,
							columnsCount
						}
					});

					// Only show an in-UI error when the user explicitly requested a refresh.
					if (forceRefresh) {
						const userMessage = this.formatQueryExecutionErrorForUser(error, connection, database);
						this.postMessage({
							type: 'schemaError',
							boxId,
							connectionId,
							database,
							requestToken,
							error: `Failed to refresh schema. Using cached schema for autocomplete.\n${userMessage}`
						});
					}
					return;
				}
			} catch {
				// ignore and fall through to posting schemaError
			}

			const userMessage = this.formatQueryExecutionErrorForUser(error, connection, database);
			const action = forceRefresh ? 'refresh' : 'load';
			this.postMessage({
				type: 'schemaError',
				boxId,
				connectionId,
				database,
				requestToken,
				error: `Failed to ${action} schema.\n${userMessage}`
			});
		}
	}

	// HTML rendering moved to src/queryEditorHtml.ts
}
