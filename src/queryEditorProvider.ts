import * as vscode from 'vscode';

import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';

import { ConnectionManager, KustoConnection } from './connectionManager';
import { DatabaseSchemaIndex, KustoQueryClient } from './kustoClient';
import { KqlLanguageServiceHost } from './kqlLanguageService/host';
import { getQueryEditorHtml } from './queryEditorHtml';
import { SCHEMA_CACHE_VERSION } from './schemaCache';
import { countColumns } from './schemaIndexUtils';

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

type CachedSchemaEntry = { schema: DatabaseSchemaIndex; timestamp: number; version: number };

type CacheUnit = 'minutes' | 'hours' | 'days';

type StartCopilotWriteQueryMessage = {
	type: 'startCopilotWriteQuery';
	boxId: string;
	connectionId: string;
	database: string;
	currentQuery?: string;
	request: string;
	modelId?: string;
	enabledTools?: string[];
};

type CopilotLocalTool = {
	name: string;
	label: string;
	description: string;
	enabledByDefault?: boolean;
};

type OptimizeQueryMessage = {
	type: 'optimizeQuery';
	query: string;
	connectionId: string;
	database: string;
	boxId: string;
	queryName: string;
	modelId?: string;
	promptText?: string;
};

type ExecuteQueryMessage = {
	type: 'executeQuery';
	query: string;
	connectionId: string;
	boxId: string;
	database?: string;
	queryMode?: string;
	cacheEnabled?: boolean;
	cacheValue?: number;
	cacheUnit?: CacheUnit | string;
};

type CopyAdeLinkMessage = {
	type: 'copyAdeLink';
	query: string;
	connectionId: string;
	database: string;
	boxId: string;
};

type ImportConnectionsFromXmlMessage = {
	type: 'importConnectionsFromXml';
	connections: Array<{ name: string; clusterUrl: string; database?: string }>;
	boxId?: string;
};

type KqlLanguageRequestMessage = {
	type: 'kqlLanguageRequest';
	requestId: string;
	method: 'textDocument/diagnostic' | 'kusto/findTableReferences';
	params: { text: string; connectionId?: string; database?: string; boxId?: string; uri?: string };
};

type FetchControlCommandSyntaxMessage = { type: 'fetchControlCommandSyntax'; requestId: string; commandLower: string; href: string };

type SaveResultsCsvMessage = { type: 'saveResultsCsv'; boxId?: string; csv: string; suggestedFileName?: string };

type IncomingWebviewMessage =
	| { type: 'getConnections' }
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
	| SaveResultsCsvMessage
	| { type: 'setCaretDocsEnabled'; enabled: boolean }
	| { type: 'executePython'; boxId: string; code: string }
	| { type: 'fetchUrl'; boxId: string; url: string }
	| { type: 'cancelQuery'; boxId: string }
	| { type: 'checkCopilotAvailability'; boxId: string }
	| { type: 'prepareCopilotWriteQuery'; boxId: string }
	| StartCopilotWriteQueryMessage
	| { type: 'cancelCopilotWriteQuery'; boxId: string }
	| { type: 'prepareOptimizeQuery'; query: string; boxId: string }
	| { type: 'cancelOptimizeQuery'; boxId: string }
	| OptimizeQueryMessage
	| ExecuteQueryMessage
	| CopyAdeLinkMessage
	| { type: 'prefetchSchema'; connectionId: string; database: string; boxId: string; forceRefresh?: boolean; requestToken?: string }
	| { type: 'promptAddConnection'; boxId?: string }
	| ImportConnectionsFromXmlMessage
	| KqlLanguageRequestMessage
	| FetchControlCommandSyntaxMessage
	| { type: 'comparisonBoxEnsured'; requestId: string; sourceBoxId: string; comparisonBoxId: string }
	| {
			type: 'comparisonSummary';
			sourceBoxId: string;
			comparisonBoxId: string;
			dataMatches: boolean;
			headersMatch?: boolean;
			rowOrderMatches?: boolean;
			columnOrderMatches?: boolean;
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
	private readonly runningCopilotWriteQueryByBoxId = new Map<string, { cts: vscode.CancellationTokenSource; seq: number }>();
	private readonly pendingComparisonEnsureByRequestId = new Map<
		string,
		{
			resolve: (comparisonBoxId: string) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	private readonly latestComparisonSummaryByKey = new Map<
		string,
		{ dataMatches: boolean; headersMatch: boolean; timestamp: number }
	>();
	private readonly pendingComparisonSummaryByKey = new Map<
		string,
		Array<{
			resolve: (summary: { dataMatches: boolean; headersMatch: boolean }) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}>
	>();
	private copilotWriteSeq = 0;
	private queryRunSeq = 0;
	private readonly kqlLanguageHost: KqlLanguageServiceHost;
	private readonly resolvedResourceUriCache = new Map<string, string>();
	private readonly copilotExtendedSchemaCache = new Map<string, { timestamp: number; value: string }>();
	private readonly controlCommandSyntaxCache = new Map<string, { timestamp: number; syntax: string; withArgs: string[]; error?: string }>();
	private readonly CONTROL_COMMAND_SYNTAX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

	private getCopilotLocalTools(): CopilotLocalTool[] {
		return [
			{
				name: 'get_extended_schema',
				label: 'Get extended schema',
				description: 'Provides cached database schema (tables + columns) to improve query correctness.',
				enabledByDefault: true
			},
			{
				name: 'get_query_optimization_best_practices',
				label: 'Get query optimization best practices',
				description: 'Returns the extension\'s query optimization best practices document (optimize-query-rules.md).',
				enabledByDefault: true
			},
			{
				name: 'respond_to_query_performance_optimization_request',
				label: 'Respond to query performance optimization request',
				description:
					'Creates a comparison section with your proposed query, prettifies it, and runs both queries to compare performance.',
				enabledByDefault: true
			},
			{
				name: 'respond_to_all_other_queries',
				label: 'Respond to all other queries',
				description:
					'Returns a runnable query for all other requests. The extension will set it in the editor and run it.',
				enabledByDefault: true
			}
		];
	}

	private async readOptimizeQueryRules(): Promise<string> {
		try {
			const uri = vscode.Uri.joinPath(this.context.extensionUri, 'optimize-query-rules.md');
			const bytes = await vscode.workspace.fs.readFile(uri);
			return new TextDecoder('utf-8').decode(bytes);
		} catch (e) {
			const msg = this.getErrorMessage(e);
			return `Failed to read optimize-query-rules.md: ${msg}`;
		}
	}

	private isCopilotToolEnabled(toolName: string, enabledTools: string[]): boolean {
		const name = this.normalizeToolName(toolName);
		if (!name) return false;
		const tools = this.getCopilotLocalTools();
		if (!Array.isArray(enabledTools) || enabledTools.length === 0) {
			const def = tools.find((t) => this.normalizeToolName(t.name) === name);
			return def ? def.enabledByDefault !== false : false;
		}
		return enabledTools.includes(name);
	}

	private normalizeToolName(value: unknown): string {
		const raw = String(value || '').trim().toLowerCase();
		// Back-compat: old tool name is treated as the new performance-optimization responder.
		if (raw === 'validate_query_performance_improvements') {
			return 'respond_to_query_performance_optimization_request';
		}
		return raw;
	}

	private extractQueryArgument(args: unknown): string {
		try {
			if (args && typeof args === 'object') {
				const a = args as any;
				const q = a.query || a.newQuery;
				if (typeof q === 'string') {
					return q;
				}
				// If JSON parsing failed, we store the raw tool payload under args.raw
				if (typeof a.raw === 'string') {
					return String(a.raw);
				}
			}
		} catch {
			// ignore
		}
		return '';
	}

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
			// Legacy cache stored in globalState (pre disk-cache migration) did not include a schema version.
			const legacy = this.context.globalState.get<Record<string, { schema: DatabaseSchemaIndex; timestamp: number }> | undefined>(
				STORAGE_KEYS.cachedSchemas
			);
			if (legacy && typeof legacy === 'object') {
				const entries = Object.entries(legacy)
					.filter(([, v]) => !!v && typeof v === 'object' && !!(v as any).schema)
					.sort((a, b) => (b[1].timestamp ?? 0) - (a[1].timestamp ?? 0))
					.slice(0, 25);
				for (const [key, entry] of entries) {
					try {
						await this.saveCachedSchemaToDisk(key, { schema: entry.schema, timestamp: entry.timestamp, version: SCHEMA_CACHE_VERSION });
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
		options?: { registerMessageHandler?: boolean; hideFooterControls?: boolean }
	): Promise<void> {
		this.panel = panel;
		try {
			const light = vscode.Uri.joinPath(this.extensionUri, 'media', 'images', 'kusto-file-light.svg');
			const dark = vscode.Uri.joinPath(this.extensionUri, 'media', 'images', 'kusto-file-dark.svg');
			this.panel.iconPath = { light, dark };
		} catch {
			// ignore
		}
		this.panel.webview.html = await getQueryEditorHtml(this.panel.webview, this.extensionUri, this.context, {
			hideFooterControls: !!options?.hideFooterControls
		});

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
			case 'comparisonBoxEnsured':
				try {
					const requestId = String(message.requestId || '');
					const comparisonBoxId = String(message.comparisonBoxId || '');
					const pending = requestId ? this.pendingComparisonEnsureByRequestId.get(requestId) : undefined;
					if (pending) {
						try {
							clearTimeout(pending.timer);
						} catch {
							// ignore
						}
						this.pendingComparisonEnsureByRequestId.delete(requestId);
						pending.resolve(comparisonBoxId);
					}
				} catch {
					// ignore
				}
				return;
			case 'comparisonSummary':
				try {
					const sourceBoxId = String(message.sourceBoxId || '');
					const comparisonBoxId = String(message.comparisonBoxId || '');
					if (!sourceBoxId || !comparisonBoxId) {
						return;
					}
					const key = `${sourceBoxId}::${comparisonBoxId}`;
					const summary = {
						dataMatches: !!message.dataMatches,
						headersMatch: message.headersMatch == null ? true : !!message.headersMatch
					};
					this.latestComparisonSummaryByKey.set(key, { ...summary, timestamp: Date.now() });
					const pending = this.pendingComparisonSummaryByKey.get(key);
					if (pending && pending.length) {
						this.pendingComparisonSummaryByKey.delete(key);
						for (const w of pending) {
							try {
								clearTimeout(w.timer);
							} catch {
								// ignore
							}
							try {
								w.resolve(summary);
							} catch {
								// ignore
							}
						}
					}
				} catch {
					// ignore
				}
				return;
			case 'fetchControlCommandSyntax':
				await this.handleFetchControlCommandSyntax(message);
				return;
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
			case 'saveResultsCsv':
				await this.saveResultsCsvFromWebview(message);
				return;
			case 'checkCopilotAvailability':
				await this.checkCopilotAvailability(message.boxId);
				return;
			case 'prepareCopilotWriteQuery':
				await this.prepareCopilotWriteQuery(message);
				return;
			case 'startCopilotWriteQuery':
				await this.startCopilotWriteQuery(message);
				return;
			case 'cancelCopilotWriteQuery':
				this.cancelCopilotWriteQuery(message.boxId);
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
			case 'copyAdeLink':
				await this.copyAdeLinkFromWebview(message);
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

	private async copyAdeLinkFromWebview(
		message: Extract<IncomingWebviewMessage, { type: 'copyAdeLink' }>
	): Promise<void> {
		try {
			const boxId = String(message.boxId || '').trim();
			const query = String(message.query || '').trim();
			const database = String(message.database || '').trim();
			const connectionId = String(message.connectionId || '').trim();
			if (!query) {
				vscode.window.showInformationMessage('No query text to share.');
				return;
			}
			if (!connectionId) {
				vscode.window.showInformationMessage('Select a cluster connection first.');
				return;
			}
			if (!database) {
				vscode.window.showInformationMessage('Select a database first.');
				return;
			}

			const connection = this.findConnection(connectionId);
			if (!connection) {
				vscode.window.showErrorMessage('Connection not found.');
				return;
			}
			const clusterShortName = this.getClusterShortName(String(connection.clusterUrl || '').trim());
			if (!clusterShortName) {
				vscode.window.showErrorMessage('Could not determine cluster name for the selected connection.');
				return;
			}

			// Azure Data Explorer uses a gzip+base64 payload in the query string.
			let encoded = '';
			try {
				const gz = zlib.gzipSync(Buffer.from(query, 'utf8'));
				encoded = gz.toString('base64').replace(/=+$/g, '');
			} catch {
				vscode.window.showErrorMessage('Failed to encode the query for Azure Data Explorer.');
				return;
			}

			const url =
				`https://dataexplorer.azure.com/clusters/${encodeURIComponent(clusterShortName)}` +
				`/databases/${encodeURIComponent(database)}` +
				`?query=${encodeURIComponent(encoded)}`;

			await vscode.env.clipboard.writeText(url);
			vscode.window.showInformationMessage('Azure Data Explorer link copied to clipboard.');
			try {
				if (boxId) {
					this.postMessage({ type: 'showInfo', message: 'Azure Data Explorer link copied to clipboard.' });
				}
			} catch {
				// ignore
			}
		} catch {
			vscode.window.showErrorMessage('Failed to copy Azure Data Explorer link.');
		}
	}

	private async saveResultsCsvFromWebview(message: SaveResultsCsvMessage): Promise<void> {
		try {
			const csv = String(message.csv || '');
			if (!csv.trim()) {
				vscode.window.showInformationMessage('No results to save.');
				return;
			}

			const suggestedFileName = String(message.suggestedFileName || 'kusto-results.csv') || 'kusto-results.csv';
			const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
			const defaultUri = vscode.Uri.joinPath(baseDir, suggestedFileName);

			const picked = await vscode.window.showSaveDialog({
				defaultUri,
				filters: { CSV: ['csv'] }
			});

			if (!picked) {
				return;
			}

			let targetUri = picked;
			try {
				const lower = picked.fsPath.toLowerCase();
				if (!lower.endsWith('.csv')) {
					targetUri = vscode.Uri.file(picked.fsPath + '.csv');
				}
			} catch {
				// ignore
			}

			await vscode.workspace.fs.writeFile(targetUri, Buffer.from(csv, 'utf8'));
			vscode.window.showInformationMessage(`Saved results to ${targetUri.fsPath}`);
		} catch {
			vscode.window.showErrorMessage('Failed to save results to CSV file.');
		}
	}

	private decodeHtmlEntities(text: string): string {
		try {
			return String(text || '')
				.replace(/&nbsp;/gi, ' ')
				.replace(/&lt;/gi, '<')
				.replace(/&gt;/gi, '>')
				.replace(/&amp;/gi, '&')
				.replace(/&quot;/gi, '"')
				.replace(/&#39;/gi, "'")
				.replace(/&#x27;/gi, "'");
		} catch {
			return String(text || '');
		}
	}

	private extractControlCommandSyntaxFromLearnHtml(html: string): string {
		try {
			const s = String(html || '');
			if (!s.trim()) return '';

			// Prefer a Syntax section.
			let preBlock = '';
			try {
				const m = s.match(/<h2[^>]*>\s*Syntax\s*<\/h2>[\s\S]*?<pre[^>]*>([\s\S]*?)<\/pre>/i);
				if (m?.[1]) preBlock = String(m[1]);
			} catch {
				preBlock = '';
			}

			// Fallback: first code block on the page.
			if (!preBlock) {
				try {
					const m = s.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
					if (m?.[1]) preBlock = String(m[1]);
				} catch {
					preBlock = '';
				}
			}

			if (!preBlock) return '';
			const withoutTags = preBlock
				.replace(/<code[^>]*>/gi, '')
				.replace(/<\/code>/gi, '')
				.replace(/<[^>]+>/g, '');
			const decoded = this.decodeHtmlEntities(withoutTags);
			const normalized = decoded.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
			const lines = normalized.split('\n');
			while (lines.length && !String(lines[0] || '').trim()) lines.shift();
			while (lines.length && !String(lines[lines.length - 1] || '').trim()) lines.pop();
			return lines.join('\n').trim();
		} catch {
			return '';
		}
	}

	private async ensureComparisonBoxInWebview(
		sourceBoxId: string,
		comparisonQuery: string,
		token: vscode.CancellationToken
	): Promise<string> {
		if (!this.panel) {
			throw new Error('Webview panel is not available');
		}
		const requestId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
		return await new Promise<string>((resolve, reject) => {
			if (token.isCancellationRequested) {
				reject(new Error('Canceled'));
				return;
			}

			const timer = setTimeout(() => {
				try {
					this.pendingComparisonEnsureByRequestId.delete(requestId);
				} catch {
					// ignore
				}
				reject(new Error('Timed out while preparing comparison editor'));
			}, 20000);

			this.pendingComparisonEnsureByRequestId.set(requestId, { resolve, reject, timer });

			try {
				this.postMessage({
					type: 'ensureComparisonBox',
					requestId,
					boxId: sourceBoxId,
					query: comparisonQuery
				} as any);
			} catch (e) {
				try {
					clearTimeout(timer);
				} catch {
					// ignore
				}
				this.pendingComparisonEnsureByRequestId.delete(requestId);
				reject(e instanceof Error ? e : new Error(String(e)));
				return;
			}

			try {
				token.onCancellationRequested(() => {
					const pending = this.pendingComparisonEnsureByRequestId.get(requestId);
					if (!pending) {
						return;
					}
					try {
						clearTimeout(pending.timer);
					} catch {
						// ignore
					}
					this.pendingComparisonEnsureByRequestId.delete(requestId);
					pending.reject(new Error('Canceled'));
				});
			} catch {
				// ignore
			}
		});
	}

	private async waitForComparisonSummary(
		sourceBoxId: string,
		comparisonBoxId: string,
		token: vscode.CancellationToken
	): Promise<{ dataMatches: boolean; headersMatch: boolean }> {
		const key = `${sourceBoxId}::${comparisonBoxId}`;
		const existing = this.latestComparisonSummaryByKey.get(key);
		if (existing) {
			return { dataMatches: existing.dataMatches, headersMatch: existing.headersMatch };
		}

		return await new Promise<{ dataMatches: boolean; headersMatch: boolean }>((resolve, reject) => {
			if (token.isCancellationRequested) {
				reject(new Error('Canceled'));
				return;
			}

			const timer = setTimeout(() => {
				try {
					const pending = this.pendingComparisonSummaryByKey.get(key) || [];
					this.pendingComparisonSummaryByKey.set(
						key,
						pending.filter((p) => p.reject !== reject)
					);
					if ((this.pendingComparisonSummaryByKey.get(key) || []).length === 0) {
						this.pendingComparisonSummaryByKey.delete(key);
					}
				} catch {
					// ignore
				}
				reject(new Error('Timed out while waiting for comparison summary'));
			}, 20000);

			const entry = { resolve, reject, timer };
			const pending = this.pendingComparisonSummaryByKey.get(key) || [];
			pending.push(entry);
			this.pendingComparisonSummaryByKey.set(key, pending);

			try {
				token.onCancellationRequested(() => {
					try {
						clearTimeout(timer);
					} catch {
						// ignore
					}
					reject(new Error('Canceled'));
				});
			} catch {
				// ignore
			}
		});
	}

	private extractWithArgsFromSyntax(syntax: string): string[] {
		try {
			const s = String(syntax || '');
			if (!s) return [];
			const m = s.match(/\bwith\s*\(([\s\S]*?)\)/i);
			if (!m?.[1]) return [];
			const inside = String(m[1]);
			const out: string[] = [];
			const seen = new Set<string>();
			for (const mm of inside.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
				const name = String(mm[1] || '').trim();
				if (!name) continue;
				const lower = name.toLowerCase();
				if (seen.has(lower)) continue;
				seen.add(lower);
				out.push(name);
			}
			return out;
		} catch {
			return [];
		}
	}

	private async handleFetchControlCommandSyntax(message: { requestId: string; commandLower: string; href: string }): Promise<void> {
		const requestId = String(message.requestId || '');
		const commandLower = String(message.commandLower || '').toLowerCase();
		const href = String(message.href || '');
		if (!requestId || !commandLower || !href) {
			this.postMessage({ type: 'controlCommandSyntaxResult', requestId, commandLower, ok: false, syntax: '', withArgs: [] } as any);
			return;
		}

		try {
			const now = Date.now();
			const cached = this.controlCommandSyntaxCache.get(commandLower);
			if (cached && (now - cached.timestamp) < this.CONTROL_COMMAND_SYNTAX_CACHE_TTL_MS) {
				this.postMessage({ type: 'controlCommandSyntaxResult', requestId, commandLower, ok: true, syntax: cached.syntax, withArgs: cached.withArgs } as any);
				return;
			}

			const url = new URL(href, 'https://learn.microsoft.com/en-us/kusto/');
			url.searchParams.set('view', 'azure-data-explorer');
			const res = await fetch(url.toString(), { method: 'GET' });
			if (!res.ok) throw new Error(`Failed to fetch control command syntax (HTTP ${res.status})`);
			const html = await res.text();
			const syntax = this.extractControlCommandSyntaxFromLearnHtml(html);
			const withArgs = this.extractWithArgsFromSyntax(syntax);
			this.controlCommandSyntaxCache.set(commandLower, { timestamp: Date.now(), syntax, withArgs });
			this.postMessage({ type: 'controlCommandSyntaxResult', requestId, commandLower, ok: true, syntax, withArgs } as any);
		} catch (err) {
			this.controlCommandSyntaxCache.set(commandLower, { timestamp: Date.now(), syntax: '', withArgs: [], error: this.getErrorMessage(err) });
			this.postMessage({ type: 'controlCommandSyntaxResult', requestId, commandLower, ok: false, syntax: '', withArgs: [] } as any);
		}
	}

	private cancelCopilotWriteQuery(boxId: string): void {
		const id = String(boxId || '').trim();
		if (!id) {
			return;
		}
		const running = this.runningCopilotWriteQueryByBoxId.get(id);
		if (!running) {
			return;
		}
		try {
			this.postMessage({ type: 'copilotWriteQueryStatus', boxId: id, status: 'Canceling…' } as any);
		} catch {
			// ignore
		}
		// Also cancel any in-flight query execution started by the write-query loop.
		this.cancelRunningQuery(id);
		try {
			running.cts.cancel();
		} catch {
			// ignore
		}
	}

	private async prepareCopilotWriteQuery(
		message: Extract<IncomingWebviewMessage, { type: 'prepareCopilotWriteQuery' }>
	): Promise<void> {
		const boxId = String(message.boxId || '').trim();
		if (!boxId) {
			return;
		}
		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			if (models.length === 0) {
				this.postMessage({
					type: 'copilotWriteQueryOptions',
					boxId,
					models: [],
					selectedModelId: '',
					tools: this.getCopilotLocalTools()
				} as any);
				this.postMessage({
					type: 'copilotWriteQueryStatus',
					boxId,
					status:
						'GitHub Copilot is not available. Enable Copilot in VS Code to use this feature.'
				} as any);
				return;
			}

			const modelOptions = models
				.map((m) => ({ id: String(m.id), label: this.formatCopilotModelLabel(m) }))
				.filter((m) => !!m.id);

			const lastModelId = this.context.globalState.get<string>(STORAGE_KEYS.lastOptimizeCopilotModelId);
			const preferredModelId = String(lastModelId || '').trim();
			const selectedModelId =
				preferredModelId && modelOptions.some((m) => m.id === preferredModelId)
					? preferredModelId
					: modelOptions[0]?.id || '';

			this.postMessage({
				type: 'copilotWriteQueryOptions',
				boxId,
				models: modelOptions,
				selectedModelId,
				tools: this.getCopilotLocalTools()
			} as any);
		} catch {
			this.postMessage({
				type: 'copilotWriteQueryOptions',
				boxId,
				models: [],
				selectedModelId: '',
				tools: this.getCopilotLocalTools()
			} as any);
		}
	}

	private extractKustoCodeBlock(text: string): string {
		const raw = String(text || '');
		const codeBlockMatch = raw.match(/```(?:kusto|kql)?\s*\n([\s\S]*?)\n```/i);
		if (codeBlockMatch) {
			return String(codeBlockMatch[1] || '').trim();
		}
		return raw.trim();
	}

	private tryParseCopilotToolCall(text: string): { tool: string; args: any } | undefined {
		const raw = String(text || '').trim();
		const m = raw.match(/^@tool\s+([a-zA-Z0-9_\-]+)\s*([\s\S]*)$/);
		if (!m) {
			return undefined;
		}
		const tool = this.normalizeToolName(m[1]);
		const jsonPart = String(m[2] || '').trim();
		if (!tool) {
			return undefined;
		}
		if (!jsonPart) {
			return { tool, args: {} };
		}
		try {
			return { tool, args: JSON.parse(jsonPart) };
		} catch {
			return { tool, args: { raw: jsonPart } };
		}
	}

	private async getExtendedSchemaToolResult(
		connection: KustoConnection,
		database: string,
		boxId: string,
		token: vscode.CancellationToken
	): Promise<string> {
		const db = String(database || '').trim();
		const clusterKey = this.normalizeClusterUrlKey(connection.clusterUrl || '');
		const memCacheKey = `${clusterKey}|${db}`;
		const diskCacheKey = `${String(connection.clusterUrl || '').trim()}|${db}`;
		const now = Date.now();

		if (token.isCancellationRequested) {
			throw new Error('Copilot write-query canceled');
		}

		try {
			const cached = this.copilotExtendedSchemaCache.get(memCacheKey);
			if (cached && now - cached.timestamp < this.SCHEMA_CACHE_TTL_MS) {
				return cached.value;
			}
		} catch {
			// ignore
		}

		let jsonText = '';
		let label = '';
		try {
			let cached = await this.getCachedSchemaFromDisk(diskCacheKey);
			if (token.isCancellationRequested) {
				throw new Error('Copilot write-query canceled');
			}

			// Auto-refresh the persisted schema if the cache entry is from an older schema version.
			// This improves Copilot correctness over time without requiring explicit user refreshes.
			if (cached?.schema && (cached.version ?? 0) !== SCHEMA_CACHE_VERSION) {
				try {
					const refreshed = await this.kustoClient.getDatabaseSchema(connection, db, true);
					if (token.isCancellationRequested) {
						throw new Error('Copilot write-query canceled');
					}
					const timestamp = Date.now();
					await this.saveCachedSchemaToDisk(diskCacheKey, { schema: refreshed.schema, timestamp, version: SCHEMA_CACHE_VERSION });
					cached = { schema: refreshed.schema, timestamp, version: SCHEMA_CACHE_VERSION };
				} catch {
					// If refresh fails, continue with the cached schema; the JSON will still be useful.
				}
			}

			if (!cached || !cached.schema) {
				label = `${db || '(unknown db)'}: no cached schema`;
				jsonText = JSON.stringify(
					{
						database: db,
						error:
							'No cached schema was found for this database. ' +
							'Try loading schema for autocomplete (or refresh schema), or provide the table/column names in your request.'
					},
					null,
					2
				);
			} else {
				const schema = cached.schema;
				const tablesCount = schema.tables?.length ?? 0;
				const columnsCount = countColumns(schema);
				const functionsCount = schema.functions?.length ?? 0;
				const cacheAgeMs = Math.max(0, now - cached.timestamp);
				label = `${db || '(unknown db)'}: ${tablesCount} tables, ${columnsCount} columns, ${functionsCount} functions`;
				jsonText = JSON.stringify(
					{
						database: db,
						schema,
						meta: {
							cacheAgeMs,
							tablesCount,
							columnsCount,
							functionsCount,
							schemaVersion: cached.version ?? 0
						}
					},
					null,
					2
				);
			}
		} catch (error) {
			const raw = this.getErrorMessage(error);
			label = `${db || '(unknown db)'}: schema lookup failed`;
			jsonText = JSON.stringify({ database: db, error: `Failed to read cached schema: ${raw}` }, null, 2);
		}

		try {
			this.copilotExtendedSchemaCache.set(memCacheKey, { timestamp: now, value: jsonText });
		} catch {
			// ignore
		}

		try {
			this.postMessage({
				type: 'copilotWriteQueryToolResult',
				boxId,
				tool: 'get_extended_schema',
				label,
				json: jsonText
			} as any);
		} catch {
			// ignore
		}

		return jsonText;
	}

	private buildCopilotWriteQueryPrompt(args: {
		request: string;
		clusterUrl: string;
		database: string;
		currentQuery?: string;
		priorAttempts: Array<{ attempt: number; query?: string; error?: string }>;
		toolResult?: string;
		bestPracticesText?: string;
		enabledTools?: string[];
	}): string {
		const request = String(args.request || '').trim();
		const clusterUrl = String(args.clusterUrl || '').trim();
		const database = String(args.database || '').trim();
		const currentQuery = String(args.currentQuery || '').trim();
		const toolResult = typeof args.toolResult === 'string' ? args.toolResult : '';
		const bestPracticesText = typeof args.bestPracticesText === 'string' ? args.bestPracticesText : '';
		const enabledToolSet = new Set((args.enabledTools || []).map((t) => this.normalizeToolName(t)).filter(Boolean));
		const localTools = this.getCopilotLocalTools();
		const isToolEnabled = (name: string) => {
			const n = this.normalizeToolName(name);
			if (!n) return false;
			// If the client didn't send enabledTools, default to tool defaults.
			if ((args.enabledTools || []).length === 0) {
				const def = localTools.find((t) => this.normalizeToolName(t.name) === n);
				return def ? def.enabledByDefault !== false : false;
			}
			return enabledToolSet.has(n);
		};

		const enabledLocalTools = localTools.filter((t) => isToolEnabled(t.name));
		const localToolsText = (() => {
			if (enabledLocalTools.length === 0) {
				return '';
			}
			const lines: string[] = [];
			lines.push('Local tools (REQUIRED response format):');
			for (const t of enabledLocalTools) {
				const n = this.normalizeToolName(t.name);
				if (n === 'get_extended_schema') {
					lines.push('- If you need extended schema to write a correct query, respond with EXACTLY this and nothing else:');
					lines.push('  @tool get_extended_schema {"database":"<database>"}');
					lines.push('- After you receive the tool result, keep using tool calls (do NOT output a ```kusto``` block).');
					continue;
				}
				if (n === 'get_query_optimization_best_practices') {
					lines.push('- If you want to consult the repository\'s optimization best practices, respond with EXACTLY this and nothing else:');
					lines.push('  @tool get_query_optimization_best_practices');
					lines.push('- After you receive the tool result, keep using tool calls (do NOT output a ```kusto``` block).');
					continue;
				}
				if (n === 'respond_to_query_performance_optimization_request') {
					lines.push('- If the user asks you to improve/optimize query performance, your FINAL response MUST be EXACTLY this and nothing else:');
					lines.push('  @tool respond_to_query_performance_optimization_request {"query":"<full kusto query>"}');
					lines.push('- Do not include explanations or code blocks when using this tool.');
					continue;
				}
				if (n === 'respond_to_all_other_queries') {
					lines.push('- For ALL other requests, your FINAL response MUST be EXACTLY this and nothing else:');
					lines.push('  @tool respond_to_all_other_queries {"query":"<full kusto query>"}');
					lines.push('- Do not include explanations or code blocks when using this tool.');
					continue;
				}
				lines.push(`- ${t.name}: ${t.description}`);
			}
			return lines.join('\n') + '\n';
		})();

		const attemptsText = (args.priorAttempts || [])
			.map((a) => {
				const header = `Attempt ${a.attempt}:`;
				const q = a.query ? `Generated query:\n${a.query}` : '';
				const e = a.error ? `Error:\n${a.error}` : '';
				return [header, q, e].filter(Boolean).join('\n');
			})
			.filter(Boolean)
			.join('\n\n');

		return (
			'Role: You are a senior Kusto Query Language (KQL) engineer.\n\n' +
			'Task: Write a complete, runnable KQL query for the user request.\n\n' +
			'Context:\n' +
			`- Cluster: ${clusterUrl || '(unknown)'}\n` +
			`- Database: ${database || '(unknown)'}\n\n` +
			(currentQuery
				? 'Current query (if any):\n```kusto\n' + currentQuery + '\n```\n\n'
				: '') +
			(attemptsText ? 'Prior attempts and errors (fix these):\n' + attemptsText + '\n\n' : '') +
			(toolResult ? 'Tool result (extended schema):\n' + toolResult + '\n\n' : '') +
			(bestPracticesText ? 'Tool result (optimization best practices):\n' + bestPracticesText + '\n\n' : '') +
			'User request:\n' +
			request +
			'\n\n' +
			'Hard constraints:\n' +
			'- You MUST respond with ONLY a single @tool call and nothing else.\n' +
			'- Do NOT output plain text, explanations, bullets, or code blocks (including ```kusto```).\n' +
			'- Use as many tool calls as needed across turns (one per message): get schema, get best practices, then finish with exactly one of the two final tools.\n' +
			'- Always provide the FULL query (not a diff) as the tool argument.\n\n' +
			(localToolsText ? localToolsText : '')
		);
	}

	private async startCopilotWriteQuery(
		message: Extract<IncomingWebviewMessage, { type: 'startCopilotWriteQuery' }>
	): Promise<void> {
		const boxId = String(message.boxId || '').trim();
		const connectionId = String(message.connectionId || '').trim();
		const database = String(message.database || '').trim();
		const request = String(message.request || '').trim();
		const currentQuery = String(message.currentQuery || '').trim();
		const requestedModelId = String(message.modelId || '').trim();
		const enabledToolsRaw = Array.isArray(message.enabledTools) ? message.enabledTools : [];
		const enabledTools = enabledToolsRaw.map((t) => this.normalizeToolName(t)).filter(Boolean);
		if (!boxId) {
			return;
		}
		if (!connectionId || !database || !request) {
			try {
				this.postMessage({
					type: 'copilotWriteQueryDone',
					boxId,
					ok: false,
					message: 'Select a connection and database, then enter what you want the query to do.'
				} as any);
			} catch {
				// ignore
			}
			return;
		}

		// Cancel any prior write-query loop for this box.
		try {
			const existing = this.runningCopilotWriteQueryByBoxId.get(boxId);
			if (existing) {
				existing.cts.cancel();
				this.runningCopilotWriteQueryByBoxId.delete(boxId);
			}
		} catch {
			// ignore
		}

		const cts = new vscode.CancellationTokenSource();
		const seq = ++this.copilotWriteSeq;
		this.runningCopilotWriteQueryByBoxId.set(boxId, { cts, seq });
		const isActive = () => {
			const current = this.runningCopilotWriteQueryByBoxId.get(boxId);
			return !!current && current.cts === cts && current.seq === seq;
		};

		const postStatus = (status: string) => {
			try {
				this.postMessage({ type: 'copilotWriteQueryStatus', boxId, status } as any);
			} catch {
				// ignore
			}
		};

		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			if (models.length === 0) {
				this.postMessage({
					type: 'copilotWriteQueryDone',
					boxId,
					ok: false,
					message: 'GitHub Copilot is not available. Enable Copilot in VS Code to use this feature.'
				} as any);
				return;
			}
			let model: vscode.LanguageModelChat | undefined;
			if (requestedModelId) {
				model = models.find((m) => String(m.id) === requestedModelId);
			}
			if (!model) {
				const lastModelId = this.context.globalState.get<string>(STORAGE_KEYS.lastOptimizeCopilotModelId);
				const preferred = String(lastModelId || '').trim();
				model = preferred ? models.find((m) => String(m.id) === preferred) : undefined;
			}
			if (!model) {
				model = models[0];
			}

			try {
				await this.context.globalState.update(STORAGE_KEYS.lastOptimizeCopilotModelId, String(model.id));
			} catch {
				// ignore
			}
			// Avoid noisy model-selection/status messages in the chat UI.

			const connection = this.findConnection(connectionId);
			if (!connection) {
				this.postMessage({
					type: 'copilotWriteQueryDone',
					boxId,
					ok: false,
					message: 'Connection not found. Select a valid connection and try again.'
				} as any);
				return;
			}

			const priorAttempts: Array<{ attempt: number; query?: string; error?: string }> = [];
			const maxAttempts = 6;
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				if (!isActive() || cts.token.isCancellationRequested) {
					throw new Error('Copilot write-query canceled');
				}
				postStatus(`Generating query (attempt ${attempt}/${maxAttempts})…`);

				let toolResult: string | undefined;
				let bestPracticesText: string | undefined;
				let generatedText = '';
				const maxToolTurns = 3;
				for (let toolTurn = 1; toolTurn <= maxToolTurns; toolTurn++) {
					if (!isActive() || cts.token.isCancellationRequested) {
						throw new Error('Copilot write-query canceled');
					}
					const prompt = this.buildCopilotWriteQueryPrompt({
						request,
						clusterUrl: String(connection.clusterUrl || ''),
						database,
						currentQuery,
						priorAttempts,
						toolResult,
						bestPracticesText,
						enabledTools
					});

					const response = await model.sendRequest(
						[vscode.LanguageModelChatMessage.User(prompt)],
						{},
						cts.token
					);

					generatedText = '';
					for await (const fragment of response.text) {
						if (!isActive() || cts.token.isCancellationRequested) {
							throw new Error('Copilot write-query canceled');
						}
						generatedText += fragment;
					}

					const toolCall = this.tryParseCopilotToolCall(generatedText);
					if (toolCall?.tool === 'get_extended_schema') {
						if (!this.isCopilotToolEnabled('get_extended_schema', enabledTools)) {
							// Treat as a non-answer; the next attempt will (usually) comply with the prompt.
							priorAttempts.push({
								attempt,
								error: 'Copilot requested a local tool that was disabled for this message.'
							});
							postStatus('Copilot requested a disabled tool. Retrying…');
							generatedText = '';
							break;
						}
						const requestedDbRaw = (toolCall.args && typeof toolCall.args === 'object') ? (toolCall.args as any).database : undefined;
						const requestedDb = String(requestedDbRaw || database || '').trim() || database;
						postStatus(`Fetching extended schema…${requestedDb ? ` (${requestedDb})` : ''}`);
						toolResult = await this.getExtendedSchemaToolResult(connection, requestedDb, boxId, cts.token);
						continue;
					}

					if (toolCall?.tool === 'get_query_optimization_best_practices') {
						if (!this.isCopilotToolEnabled('get_query_optimization_best_practices', enabledTools)) {
							priorAttempts.push({
								attempt,
								error: 'Copilot requested a local tool that was disabled for this message.'
							});
							postStatus('Copilot requested a disabled tool. Retrying…');
							generatedText = '';
							break;
						}
						postStatus('Fetching optimization best practices…');
						bestPracticesText = await this.readOptimizeQueryRules();
						try {
							this.postMessage({
								type: 'copilotWriteQueryToolResult',
								boxId,
								tool: 'get_query_optimization_best_practices',
								label: 'optimize-query-rules.md',
								json: bestPracticesText
							} as any);
						} catch {
							// ignore
						}
						continue;
					}

					if (toolCall?.tool === 'respond_to_query_performance_optimization_request') {
						if (!this.isCopilotToolEnabled('respond_to_query_performance_optimization_request', enabledTools)) {
							priorAttempts.push({
								attempt,
								error: 'Copilot requested a local tool that was disabled for this message.'
							});
							postStatus('Copilot requested a disabled tool. Retrying…');
							generatedText = '';
							break;
						}
						const rawQuery = this.extractQueryArgument(toolCall.args);
						const improvedQuery = this.extractKustoCodeBlock(rawQuery).trim();
						if (!improvedQuery) {
							priorAttempts.push({ attempt, error: 'Tool call was missing a non-empty query argument.' });
							postStatus('Tool call missing query argument. Retrying…');
							generatedText = '';
							break;
						}

						// Scenario #2: Two-layer retry logic.
						// - Keep original query unchanged.
						// - Ensure/reuse comparison editor and run execution retries (up to 6) for the comparison query.
						// - After a successful execution, stop. (We do not retry based on result mismatches.)
						const originalQueryForCompare = currentQuery;
						let candidate = improvedQuery;

						postStatus('Preparing comparison editor…');
						let comparisonBoxId = await this.ensureComparisonBoxInWebview(boxId, candidate, cts.token);
						if (!comparisonBoxId) {
							this.postMessage({
								type: 'copilotWriteQueryDone',
								boxId,
								ok: false,
								message: 'Failed to prepare comparison editor.'
							} as any);
							return;
						}

						const executeQueryAndPost = async (targetBoxId: string, queryText: string, cancelSuffix: string) => {
							const queryWithMode = this.appendQueryMode(queryText, 'take100');
							const cacheDirective = this.buildCacheDirective(true, 1, 'days');
							const finalQuery = cacheDirective ? `${cacheDirective}\n${queryWithMode}` : queryWithMode;
							const cancelClientKey = `${targetBoxId}::${connection.id}::validatePerformanceImprovements::${cancelSuffix}`;
							const result = await this.kustoClient.executeQueryCancelable(connection, database, finalQuery, cancelClientKey).promise;
							try {
								this.postMessage({ type: 'queryResult', result, boxId: targetBoxId } as any);
							} catch {
								// ignore
							}
						};

						// Ensure comparison editor exists and has the latest candidate query.
						comparisonBoxId = await this.ensureComparisonBoxInWebview(boxId, candidate, cts.token);
						if (!comparisonBoxId) {
							this.postMessage({
								type: 'copilotWriteQueryDone',
								boxId,
								ok: false,
								message: 'Failed to prepare comparison editor.'
							} as any);
							return;
						}

						// Clear any previously cached summary for this pair so we don't read stale state.
						try {
							this.latestComparisonSummaryByKey.delete(`${boxId}::${comparisonBoxId}`);
						} catch {
							// ignore
						}

						postStatus('Running original query…');
						try {
							await executeQueryAndPost(boxId, originalQueryForCompare, 'source');
						} catch (error) {
							this.logQueryExecutionError(error, connection, database, boxId, originalQueryForCompare);
							try {
								this.postMessage({ type: 'queryError', error: 'Query failed to execute.', boxId } as any);
							} catch {
								// ignore
							}
							this.postMessage({
								type: 'copilotWriteQueryDone',
								boxId,
								ok: false,
								message: 'Query failed to execute.'
							} as any);
							return;
						}

						const maxExecAttempts = 6;
						let executed = false;
						let lastExecErrorText = '';
						for (let execAttempt = 1; execAttempt <= maxExecAttempts; execAttempt++) {
							if (!isActive() || cts.token.isCancellationRequested) {
								throw new Error('Copilot write-query canceled');
							}

							postStatus(`Running comparison query (attempt ${execAttempt}/${maxExecAttempts})…`);
							// Re-ensure in case the comparison box was closed/recreated.
							comparisonBoxId = await this.ensureComparisonBoxInWebview(boxId, candidate, cts.token);
							if (!comparisonBoxId) {
								this.postMessage({
									type: 'copilotWriteQueryDone',
									boxId,
									ok: false,
									message: 'Failed to prepare comparison editor.'
								} as any);
								return;
							}
							try {
								this.latestComparisonSummaryByKey.delete(`${boxId}::${comparisonBoxId}`);
							} catch {
								// ignore
							}

							try {
								await executeQueryAndPost(comparisonBoxId, candidate, 'comparison');
								executed = true;
								break;
							} catch (error) {
								this.logQueryExecutionError(error, connection, database, comparisonBoxId, candidate);
								lastExecErrorText = this.formatQueryExecutionErrorForUser(error, connection, database);
								try {
									this.postMessage({
										type: 'queryError',
										error: 'Query failed to execute.',
										boxId: comparisonBoxId
									} as any);
								} catch {
									// ignore
								}
								if (execAttempt >= maxExecAttempts) {
									this.postMessage({
										type: 'copilotWriteQueryDone',
										boxId,
										ok: false,
										message: 'Query failed to execute.'
									} as any);
									return;
								}

								postStatus('Query failed to execute. Asking Copilot to try again…');
								const fixPrompt =
									'Role: You are a senior Kusto Query Language (KQL) engineer.\n\n' +
									'Task: Produce an optimized version of the original query that is functionally equivalent, but MUST execute successfully.\n\n' +
									`Cluster: ${String(connection.clusterUrl || '')}\n` +
									`Database: ${database}\n\n` +
									'Original query:\n```kusto\n' + originalQueryForCompare + '\n```\n\n' +
									'Candidate optimized query (failed):\n```kusto\n' + candidate + '\n```\n\n' +
									'Execution error:\n' + lastExecErrorText + '\n\n' +
									'Hard constraints:\n' +
										'- Return ONLY a single @tool call and nothing else.\n' +
										'- Use this tool: @tool respond_to_query_performance_optimization_request {"query":"<full kusto query>"}\n';

								const fixResponse = await model.sendRequest(
									[vscode.LanguageModelChatMessage.User(fixPrompt)],
									{},
									cts.token
								);
								let fixText = '';
								for await (const fragment of fixResponse.text) {
									if (!isActive() || cts.token.isCancellationRequested) {
										throw new Error('Copilot write-query canceled');
									}
									fixText += fragment;
								}
								const fixToolCall = this.tryParseCopilotToolCall(fixText);
								const fixedRaw = fixToolCall?.tool === 'respond_to_query_performance_optimization_request'
									? this.extractQueryArgument(fixToolCall.args)
									: '';
								const fixed = this.extractKustoCodeBlock(fixedRaw || fixText).trim();
								if (fixed) {
									candidate = fixed;
								}
							}
						}

						if (!executed) {
							this.postMessage({
								type: 'copilotWriteQueryDone',
								boxId,
								ok: false,
								message: 'Query failed to execute.'
							} as any);
							return;
						}

						this.postMessage({
							type: 'copilotWriteQueryDone',
							boxId,
							ok: true,
							message:
								'Optimized query has been provided, please check the results to make sure the same data is being returned. Keep in mind that count() and dcount() can return slightly different values by design, so we cannot expect a 100% match the entire time.'
						} as any);
						return;
						return;
					}

					if (toolCall?.tool === 'respond_to_all_other_queries') {
						if (!this.isCopilotToolEnabled('respond_to_all_other_queries', enabledTools)) {
							priorAttempts.push({
								attempt,
								error: 'Copilot requested a local tool that was disabled for this message.'
							});
							postStatus('Copilot requested a disabled tool. Retrying…');
							generatedText = '';
							break;
						}

						const rawQuery = this.extractQueryArgument(toolCall.args);
						const query = this.extractKustoCodeBlock(rawQuery).trim();
						if (!query) {
							priorAttempts.push({ attempt, error: 'Tool call was missing a non-empty query argument.' });
							postStatus('Tool call missing query argument. Retrying…');
							generatedText = '';
							break;
						}

						try {
							this.postMessage({ type: 'copilotWriteQuerySetQuery', boxId, query } as any);
						} catch {
							// ignore
						}

						postStatus('Running query…');
						try {
							this.postMessage({ type: 'copilotWriteQueryExecuting', boxId, executing: true } as any);
						} catch {
							// ignore
						}

						// Cancel any in-flight manual run and run using default editor mode.
						this.cancelRunningQuery(boxId);
						const queryWithMode = this.appendQueryMode(query, 'take100');
						const cacheDirective = this.buildCacheDirective(true, 1, 'days');
						const finalQuery = cacheDirective ? `${cacheDirective}\n${queryWithMode}` : queryWithMode;

						const cancelClientKey = `${boxId}::${connection.id}::copilot`;
						const { promise, cancel } = this.kustoClient.executeQueryCancelable(
							connection,
							database,
							finalQuery,
							cancelClientKey
						);
						const runSeq = ++this.queryRunSeq;
						this.runningQueriesByBoxId.set(boxId, { cancel, runSeq });
						try {
							const result = await promise;
							if (isActive()) {
								this.postMessage({ type: 'queryResult', result, boxId } as any);
								// Ensure results are visible even if the user previously hid them.
								this.postMessage({ type: 'ensureResultsVisible', boxId } as any);
								this.postMessage({ type: 'copilotWriteQueryExecuting', boxId, executing: false } as any);
								this.postMessage({
									type: 'copilotWriteQueryDone',
									boxId,
									ok: true,
									message: 'Query ran successfully. Review the results and adjust if needed.'
								} as any);
								return;
							}
						} catch (error) {
							if ((error as any)?.name === 'QueryCancelledError' || (error as any)?.isCancelled === true) {
								if (isActive()) {
									try {
										this.postMessage({ type: 'queryCancelled', boxId } as any);
									} catch {
										// ignore
									}
								}
								throw new Error('Copilot write-query canceled');
							}

							const userMessage = this.formatQueryExecutionErrorForUser(error, connection, database);
							this.logQueryExecutionError(error, connection, database, boxId, finalQuery);
							if (isActive()) {
								try {
									this.postMessage({ type: 'queryError', error: 'Query failed to execute.', boxId } as any);
								} catch {
									// ignore
								}
							}

							priorAttempts.push({ attempt, query, error: userMessage });
							postStatus('Query failed to execute. Retrying…');
							generatedText = '';
							break;
						}
					}

					// Non-tool response or unknown tool: treat as non-compliant and retry.
					priorAttempts.push({ attempt, error: 'Copilot did not respond with a supported @tool call.' });
					postStatus('Copilot returned a non-tool response. Retrying…');
					generatedText = '';
					break;
				}

				// If we reach here, we did not get a valid final tool call this attempt.
				// Continue to the next attempt.
				continue;
			}

			this.postMessage({
				type: 'copilotWriteQueryDone',
				boxId,
				ok: false,
				message: 'I could not produce a query that runs successfully. Review the latest error and refine your request.'
			} as any);
		} catch (err) {
			const msg = this.getErrorMessage(err);
			const canceled = cts.token.isCancellationRequested || /canceled|cancelled/i.test(msg);
			if (canceled) {
				try {
					this.postMessage({
						type: 'copilotWriteQueryDone',
						boxId,
						ok: false,
						message: 'Canceled.'
					} as any);
				} catch {
					// ignore
				}
				return;
			}
			try {
				this.postMessage({
					type: 'copilotWriteQueryDone',
					boxId,
					ok: false,
					message: `Copilot request failed: ${msg}`
				} as any);
			} catch {
				// ignore
			}
		} finally {
			try {
				const current = this.runningCopilotWriteQueryByBoxId.get(boxId);
				if (current?.cts === cts && current.seq === seq) {
					this.runningCopilotWriteQueryByBoxId.delete(boxId);
				}
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
			// Avoid noisy model-selection/status messages in the chat UI.

			postStatus('Sending request to Copilot…');

			const effectivePromptText = String(promptText || '').trim() || this.buildOptimizeQueryPrompt(query);

			const response = await model.sendRequest(
				[vscode.LanguageModelChatMessage.User(effectivePromptText)],
				{},
				cts.token
			);

			postStatus('Waiting for Copilot response…');

			let optimizedQuery = '';
			for await (const fragment of response.text) {
				if (cts.token.isCancellationRequested) {
					throw new Error('Optimization canceled');
				}
				optimizedQuery += fragment;
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

		const formatBytes = (n: number): string => {
			if (!Number.isFinite(n) || n < 0) {
				return '0 B';
			}
			if (n >= 1024 * 1024) {
				return `${(n / (1024 * 1024)).toFixed(1)} MB`;
			}
			if (n >= 1024) {
				return `${Math.round(n / 1024)} KB`;
			}
			return `${n} B`;
		};

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
		const maxBytesForTextLike = 100 * 1024 * 1024; // 100MB cap for URL/CSV content.
		const maxBytesForImages = 5 * 1024 * 1024; // Keep images smaller since they're sent to the webview as a data URI.
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

			const maxBytes = looksLikeImage ? maxBytesForImages : maxBytesForTextLike;

			// Read as bytes so we can support images and other non-text content.
			const ab = await resp.arrayBuffer();
			const bytes = Buffer.from(ab);
			if (bytes.byteLength > maxBytes) {
				this.postMessage({
					type: 'urlError',
					boxId,
					error: `Response too large (${formatBytes(bytes.byteLength)}). Max is ${formatBytes(maxBytes)}.`
				});
				return;
			}

			if (!resp.ok) {
				const status = resp.status;
				const statusText = (resp.statusText || '').trim();
				const hint = (() => {
					if (ctLower.includes('text/html') && pathLower.endsWith('.csv')) {
						return ' The server returned HTML, not CSV. Try using a raw download link.';
					}
					return '';
				})();
				this.postMessage({
					type: 'urlError',
					boxId,
					error: `HTTP ${status}${statusText ? ' ' + statusText : ''}.${hint}`
				});
				return;
			}

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

			// Decode as UTF-8 text for sniffing and rendering.
			let body = bytes.toString('utf8');
			let truncated = false;
			if (body.length > maxChars) {
				body = body.slice(0, maxChars);
				truncated = true;
			}

			const sniff = body.slice(0, 4096).trimStart().toLowerCase();
			const looksLikeHtmlByBody = sniff.startsWith('<!doctype html') || sniff.startsWith('<html') || sniff.startsWith('<head');

			const isCsvByType = ctLower.includes('text/csv') || ctLower.includes('application/csv');
			const isHtmlByType = ctLower.includes('text/html');
			const isCsvByExt = pathLower.endsWith('.csv') && !isHtmlByType && !looksLikeHtmlByBody;
			const kind = (isCsvByType || isCsvByExt)
				? 'csv'
				: ((looksLikeHtml || isHtmlByType || looksLikeHtmlByBody)
					? 'html'
					: (looksLikeText ? 'text' : 'text'));

			this.postMessage({
				type: 'urlContent',
				boxId,
				url: finalUrl,
				contentType,
				status: resp.status,
				kind,
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
			const parsed = JSON.parse(Buffer.from(buf).toString('utf8')) as Partial<CachedSchemaEntry>;
			if (!parsed || !parsed.schema || typeof parsed.timestamp !== 'number') {
				return undefined;
			}
			const version = typeof parsed.version === 'number' && isFinite(parsed.version) ? parsed.version : 0;
			return { schema: parsed.schema, timestamp: parsed.timestamp, version };
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
			const databasesRaw = await this.kustoClient.getDatabases(connection, true, { allowInteractive: false });
			return (Array.isArray(databasesRaw) ? databasesRaw : [])
				.map((d) => String(d || '').trim())
				.filter(Boolean)
				.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
		};

		try {
			let databasesRaw = await this.kustoClient.getDatabases(connection, forceRefresh, { allowInteractive: false });
			let databases = (Array.isArray(databasesRaw) ? databasesRaw : [])
				.map((d) => String(d || '').trim())
				.filter(Boolean)
				.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

			// Multi-account recovery:
			// If the user explicitly clicked refresh and we got an empty list (and we don't have a prior cached list),
			// it's very commonly because we're authenticated with an account that has no access to this cluster.
			// Prompt for a different account and retry once.
			if (forceRefresh && databases.length === 0 && cachedBefore.length === 0) {
				// If the user explicitly clicked refresh and we got an empty list (with no cached list),
				// prompt once to choose an account and retry.
				try {
					await this.kustoClient.reauthenticate(connection, 'clearPreference');
					databases = await fetchAndNormalize();
				} catch {
					// ignore; we'll surface error below
				}

				// If still empty, don't immediately prompt again. Give the user a choice.
				if (databases.length === 0) {
					try {
						const choice = await vscode.window.showWarningMessage(
							"No databases were returned. This is often because the selected account doesn't have access to this cluster.",
							'Try another account',
							'Add account',
							'Cancel'
						);
						if (choice === 'Try another account') {
							await this.kustoClient.reauthenticate(connection, 'clearPreference');
							databases = await fetchAndNormalize();
						} else if (choice === 'Add account') {
							await this.kustoClient.reauthenticate(connection, 'forceNewSession');
							databases = await fetchAndNormalize();
						}
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
			// Auth recovery:
			// - On explicit refresh: retry with interactive auth (existing behavior).
			// - On initial load (not refresh): if there is no cached list, still prompt once so the user can recover.
			const isAuthErr = this.kustoClient.isAuthenticationError(error);
			if (isAuthErr && !forceRefresh && cachedBefore.length > 0) {
				// Keep the editor usable by showing the last known list, but guide the user to re-auth.
				this.postMessage({ type: 'databasesData', databases: cachedBefore, boxId });
				this.postMessage({
					type: 'databasesError',
					boxId,
					error:
						`Couldn't refresh the database list due to an authentication error. Showing the previously cached list.\n` +
						`Use the refresh button and sign in with the correct account for this cluster.`
				});
				return;
			}

			// If we hit an auth-related error, try to re-auth interactively and retry once.
			if ((forceRefresh || cachedBefore.length === 0) && isAuthErr) {
				try {
					await this.kustoClient.reauthenticate(connection, 'clearPreference');
					const databases = await fetchAndNormalize();
					await this.saveCachedDatabases(connectionId, databases);
					this.postMessage({ type: 'databasesData', databases, boxId });
					return;
				} catch {
					// Don't immediately prompt a second time. Give the user control.
					try {
						const choice = await vscode.window.showWarningMessage(
							"Authentication succeeded but the cluster still rejected the request (401/403). Try a different account?",
							'Try another account',
							'Add account',
							'Cancel'
						);
						if (choice === 'Try another account') {
							await this.kustoClient.reauthenticate(connection, 'clearPreference');
							const databases = await fetchAndNormalize();
							await this.saveCachedDatabases(connectionId, databases);
							this.postMessage({ type: 'databasesData', databases, boxId });
							return;
						}
						if (choice === 'Add account') {
							await this.kustoClient.reauthenticate(connection, 'forceNewSession');
							const databases = await fetchAndNormalize();
							await this.saveCachedDatabases(connectionId, databases);
							this.postMessage({ type: 'databasesData', databases, boxId });
							return;
						}
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
			const cachedIsLatest = !!(cached && (cached.version ?? 0) === SCHEMA_CACHE_VERSION);

			// Default path: use persisted cache when it's still fresh.
			// If the cache entry was produced by an older extension version (version mismatch),
			// keep using it immediately for autocomplete, but also refresh it automatically.
			if (!forceRefresh && cached && cachedIsFresh && cachedIsLatest) {
				const schema = cached.schema;
				const tablesCount = schema.tables?.length ?? 0;
				const columnsCount = countColumns(schema);

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

			if (!forceRefresh && cached && cachedIsFresh && !cachedIsLatest) {
				const schema = cached.schema;
				const tablesCount = schema.tables?.length ?? 0;
				const columnsCount = countColumns(schema);

				this.output.appendLine(
					`[schema] loaded (persisted cache, outdated version=${cached.version ?? 0}) db=${database} tables=${tablesCount} columns=${columnsCount}; refreshing…`
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
				// Continue through to fetch a fresh schema below.
				forceRefresh = true;
			}

			const result = await this.kustoClient.getDatabaseSchema(connection, database, forceRefresh);
			const schema = result.schema;

			const tablesCount = schema.tables?.length ?? 0;
			const columnsCount = countColumns(schema);

			this.output.appendLine(
				`[schema] loaded db=${database} tables=${tablesCount} columns=${columnsCount} fromCache=${result.fromCache}`
			);

			// Persist schema across VS Code sessions.
			const timestamp = result.fromCache
				? Date.now() - (result.cacheAgeMs ?? 0)
				: Date.now();
			await this.saveCachedSchemaToDisk(cacheKey, { schema, timestamp, version: SCHEMA_CACHE_VERSION });
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
					const columnsCount = countColumns(schema);

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
