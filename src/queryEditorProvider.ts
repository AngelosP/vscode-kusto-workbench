import * as vscode from 'vscode';

import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

import { ConnectionManager, KustoConnection } from './connectionManager';
import { DatabaseSchemaIndex, KustoQueryClient } from './kustoClient';
import { getQueryEditorHtml } from './queryEditorHtml';

const OUTPUT_CHANNEL_NAME = 'Kusto Workbench';

const STORAGE_KEYS = {
	lastConnectionId: 'kusto.lastConnectionId',
	lastDatabase: 'kusto.lastDatabase',
	cachedDatabases: 'kusto.cachedDatabases',
	cachedSchemas: 'kusto.cachedSchemas',
	caretDocsEnabled: 'kusto.caretDocsEnabled',
	cachedSchemasMigratedToDisk: 'kusto.cachedSchemasMigratedToDisk'
} as const;

type CachedSchemaEntry = { schema: DatabaseSchemaIndex; timestamp: number };

type CacheUnit = 'minutes' | 'hours' | 'days';

type IncomingWebviewMessage = { type: 'getConnections' }
	| { type: 'getDatabases'; connectionId: string; boxId: string }
	| { type: 'refreshDatabases'; connectionId: string; boxId: string }
	| { type: 'promptImportConnectionsXml'; boxId?: string }
	| { type: 'addConnectionsForClusters'; clusterUrls: string[]; boxId?: string }
	| { type: 'showInfo'; message: string }
	| { type: 'setCaretDocsEnabled'; enabled: boolean }
	| { type: 'executePython'; boxId: string; code: string }
	| { type: 'fetchUrl'; boxId: string; url: string }
	| { type: 'cancelQuery'; boxId: string }
	| { type: 'checkCopilotAvailability'; boxId: string }
	| { type: 'optimizeQuery'; query: string; connectionId: string; database: string; boxId: string; queryName: string }
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
	| { type: 'prefetchSchema'; connectionId: string; database: string; boxId: string; forceRefresh?: boolean }
	| { type: 'promptAddConnection'; boxId?: string }
	| {
			type: 'importConnectionsFromXml';
			connections: Array<{ name: string; clusterUrl: string; database?: string }>;
			boxId?: string;
		};

export class QueryEditorProvider {
	private panel?: vscode.WebviewPanel;
	private readonly kustoClient = new KustoQueryClient();
	private lastConnectionId?: string;
	private lastDatabase?: string;
	private readonly output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	private readonly SCHEMA_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
	private readonly runningQueriesByBoxId = new Map<string, { cancel: () => void }>();

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager,
		private readonly context: vscode.ExtensionContext
	) {
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

	async initializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
		this.panel = panel;
		this.panel.webview.html = await getQueryEditorHtml(this.panel.webview, this.extensionUri, this.context);

		// Ensure messages from the webview are handled in all host contexts (including custom editors).
		// openEditor() also wires this up for the standalone panel, but custom editors call initializeWebviewPanel().
		this.panel.webview.onDidReceiveMessage((message: IncomingWebviewMessage) => {
			return this.handleWebviewMessage(message);
		});

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
			case 'getConnections':
				await this.sendConnectionsData();
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
				await this.prefetchSchema(message.connectionId, message.database, message.boxId, !!message.forceRefresh);
				return;
			case 'importConnectionsFromXml':
				await this.importConnectionsFromXml(message.connections);
				await this.sendConnectionsData();
				return;
			case 'promptAddConnection':
				await this.promptAddConnection(message.boxId);
				return;
			default:
				return;
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

	private async optimizeQueryWithCopilot(
		message: Extract<IncomingWebviewMessage, { type: 'optimizeQuery' }>
	): Promise<void> {
		const { query, connectionId, database, boxId, queryName } = message;

		try {
			// Check if Copilot is available
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			if (models.length === 0) {
				vscode.window.showWarningMessage('GitHub Copilot is not available. Please enable Copilot to use query optimization.');
				this.postMessage({
					type: 'optimizeQueryError',
					boxId,
					error: 'Copilot not available'
				});
				return;
			}

			const model = models[0];

			// Craft the optimization prompt
			const promptText = `You are a Kusto Query Language (KQL) expert. Optimize the following KQL query for performance without changing its functionality or results.

Follow these optimization rules strictly:

1. **Reorder WHERE clauses**: Move the most aggressive and performant filters first. Priority order:
   - Date and numerical column filters (e.g., timestamp > ago(1d))
   - Fast string operations: 'has', 'has_any'
   - Slower string operations: 'contains'

2. **Remove unused columns**: If the final result doesn't use certain columns, add | project statements to limit columns early, or use other techniques to reduce data volume.

3. **Replace EXTEND with SUMMARIZE where possible**: If | extend statements can be reliably replaced by | summarize X by Y statements while producing identical results, make that change. This is especially beneficial if the query already has | summarize statements.

4. **Replace CONTAINS with HAS**: Examine any 'contains' statements and determine if the search term can safely be replaced with 'has' (which is faster).

**CRITICAL**: Only make changes that preserve the exact same query results. Do not take risks that might alter the data returned.

Original query:
\`\`\`kusto
${query}
\`\`\`

Provide ONLY the optimized query wrapped in \`\`\`kusto code block, with no additional explanation or commentary.`;

			const response = await model.sendRequest(
				[vscode.LanguageModelChatMessage.User(promptText)],
				{},
				new vscode.CancellationTokenSource().token
			);

			let optimizedQuery = '';
			for await (const fragment of response.text) {
				optimizedQuery += fragment;
			}

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

			// Return the optimized query to webview for comparison box creation
			this.postMessage({
				type: 'optimizeQueryReady',
				boxId,
				optimizedQuery,
				queryName,
				connectionId,
				database
			});

		} catch (err: any) {
			const errorMsg = err?.message || String(err);
			console.error('Query optimization failed:', err);
			
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
				boxId,
				error: errorMsg
			});
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
		const existingByCluster = new Set(existing.map((c) => (c.clusterUrl || '').trim().toLowerCase()).filter(Boolean));

		let added = 0;
		for (const c of incoming) {
			const name = String(c?.name || '').trim();
			const clusterUrl = String(c?.clusterUrl || '').trim();
			const database = c?.database ? String(c.database).trim() : undefined;
			if (!clusterUrl) {
				continue;
			}
			const key = clusterUrl.toLowerCase();
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

	private getCachedDatabases(): Record<string, string[]> {
		return this.context.globalState.get<Record<string, string[]>>(STORAGE_KEYS.cachedDatabases, {});
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
		const cached = this.getCachedDatabases();
		cached[connectionId] = databases;
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

		this.postMessage({
			type: 'connectionsData',
			connections,
			lastConnectionId: this.lastConnectionId,
			lastDatabase: this.lastDatabase,
			cachedDatabases,
			caretDocsEnabled,
			caretDocsEnabledUserSet
		});
	}

	private async sendDatabases(connectionId: string, boxId: string, forceRefresh: boolean): Promise<void> {
		const connection = this.findConnection(connectionId);
		if (!connection) {
			return;
		}

		try {
			const databasesRaw = await this.kustoClient.getDatabases(connection, forceRefresh);
			const databases = (Array.isArray(databasesRaw) ? databasesRaw : [])
				.map((d) => String(d || '').trim())
				.filter(Boolean)
				.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
			await this.saveCachedDatabases(connectionId, databases);
			this.postMessage({ type: 'databasesData', databases, boxId });
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to fetch databases: ${errorMessage}`);
			this.postMessage({ type: 'databasesData', databases: [], boxId });
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

		const { promise, cancel } = this.kustoClient.executeQueryCancelable(connection, message.database, finalQuery);
		if (boxId) {
			this.runningQueriesByBoxId.set(boxId, { cancel });
		}
		try {
			const result = await promise;
			this.postMessage({ type: 'queryResult', result, boxId });
		} catch (error) {
			if ((error as any)?.name === 'QueryCancelledError' || (error as any)?.isCancelled === true) {
				this.postMessage({ type: 'queryCancelled', boxId });
				return;
			}
			const errorMessage = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Query execution failed: ${errorMessage}`);
			this.postMessage({ type: 'queryError', error: errorMessage, boxId });
		} finally {
			if (boxId) {
				// Only clear if this is still the active run for the box.
				const current = this.runningQueriesByBoxId.get(boxId);
				if (current?.cancel === cancel) {
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
		forceRefresh: boolean
	): Promise<void> {
		const connection = this.findConnection(connectionId);
		if (!connection || !database) {
			return;
		}

		const cacheKey = `${connection.clusterUrl}|${database}`;
		if (forceRefresh) {
			await this.deleteCachedSchemaFromDisk(cacheKey);
		}

		try {
			this.output.appendLine(
				`[schema] request connectionId=${connectionId} db=${database} forceRefresh=${forceRefresh}`
			);

			// Default path: check persisted cache first (survives VS Code sessions).
			if (!forceRefresh) {
				const cached = await this.getCachedSchemaFromDisk(cacheKey);
				if (cached && Date.now() - cached.timestamp < this.SCHEMA_CACHE_TTL_MS) {
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
						schema,
						schemaMeta: {
							fromCache: true,
							cacheAgeMs: Date.now() - cached.timestamp,
							tablesCount,
							columnsCount
						}
					});
					return;
				}
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
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`[schema] error db=${database}: ${errorMessage}`);
			this.postMessage({ type: 'schemaError', boxId, connectionId, database, error: errorMessage });
		}
	}

	// HTML rendering moved to src/queryEditorHtml.ts
}
