import * as vscode from 'vscode';

import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';

import { ConnectionManager, KustoConnection } from './connectionManager';
import { DatabaseSchemaIndex, KustoQueryClient, QueryExecutionError } from './kustoClient';
import { KqlLanguageServiceHost } from './kqlLanguageService/host';
import { getQueryEditorHtml } from './queryEditorHtml';
import { SCHEMA_CACHE_VERSION, searchCachedSchemas } from './schemaCache';
import { countColumns, formatSchemaAsCompactText, formatSchemaWithTokenBudget, DEFAULT_SCHEMA_TOKEN_BUDGET_FRACTION, PRUNE_PHASE_DESCRIPTIONS, SchemaPruneResult } from './schemaIndexUtils';
import { extractKqlSchemaMatchTokens, scoreSchemaMatch } from './kqlSchemaInference';
import { ConversationHistoryEntry, sanitizeConversationHistory, insertMissingToolCallResults } from './copilotConversationUtils';
import { toolOrchestrator } from './extension';

const OUTPUT_CHANNEL_NAME = 'Kusto Workbench';

const STORAGE_KEYS = {
	lastConnectionId: 'kusto.lastConnectionId',
	lastDatabase: 'kusto.lastDatabase',
	cachedDatabases: 'kusto.cachedDatabases',
	cachedSchemas: 'kusto.cachedSchemas',
	caretDocsEnabled: 'kusto.caretDocsEnabled',
	autoTriggerAutocompleteEnabled: 'kusto.autoTriggerAutocompleteEnabled',
	copilotInlineCompletionsEnabled: 'kusto.copilotInlineCompletionsEnabled',
	cachedSchemasMigratedToDisk: 'kusto.cachedSchemasMigratedToDisk',
	lastOptimizeCopilotModelId: 'kusto.optimize.lastCopilotModelId',
	favorites: 'kusto.favorites',
	copilotChatFirstTimeDismissed: 'kusto.copilotChatFirstTimeDismissed'
} as const;

type KustoFavorite = { name: string; clusterUrl: string; database: string };

/**
 * Default preferred Copilot model when user hasn't made a selection.
 * We look for models whose name, id, family, or version contains these substrings (case-insensitive).
 */
const DEFAULT_PREFERRED_COPILOT_MODEL_ID = 'claude-opus-4.6';

/**
 * Finds the preferred default Copilot model from the available models.
 * Looks for a model matching the default preferred ID, falls back to first model.
 */
function findPreferredDefaultCopilotModel(models: vscode.LanguageModelChat[]): vscode.LanguageModelChat | undefined {
	if (models.length === 0) {
		return undefined;
	}
	const preferredModel = models.find(m => m.id === DEFAULT_PREFERRED_COPILOT_MODEL_ID);
	return preferredModel || models[0];
}

type CachedSchemaEntry = { schema: DatabaseSchemaIndex; timestamp: number; version: number; clusterUrl?: string; database?: string };

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
	queryMode?: string;
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

type ShareToClipboardMessage = {
	type: 'shareToClipboard';
	boxId: string;
	includeTitle: boolean;
	includeQuery: boolean;
	includeResults: boolean;
	sectionName: string;
	queryText: string;
	connectionId: string;
	database: string;
	columns: string[];
	rowsData: string[][];
	totalRows: number;
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

// ConversationHistoryEntry type is imported from './copilotConversationUtils'

type IncomingWebviewMessage =
	| { type: 'getConnections' }
	| { type: 'getDatabases'; connectionId: string; boxId: string }
	| { type: 'refreshDatabases'; connectionId: string; boxId: string }
	| { type: 'saveLastSelection'; connectionId: string; database?: string }
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
	| { type: 'setAutoTriggerAutocompleteEnabled'; enabled: boolean }
	| { type: 'setCopilotInlineCompletionsEnabled'; enabled: boolean }
	| { type: 'requestCopilotInlineCompletion'; requestId: string; boxId: string; textBefore: string; textAfter: string }
	| { type: 'executePython'; boxId: string; code: string }
	| { type: 'fetchUrl'; boxId: string; url: string }
	| { type: 'cancelQuery'; boxId: string }
	| { type: 'checkCopilotAvailability'; boxId: string }
	| { type: 'prepareCopilotWriteQuery'; boxId: string }
	| StartCopilotWriteQueryMessage
	| { type: 'cancelCopilotWriteQuery'; boxId: string }
	| { type: 'clearCopilotConversation'; boxId: string }
	| { type: 'removeFromCopilotHistory'; boxId: string; entryId: string }
	| { type: 'prepareOptimizeQuery'; query: string; boxId: string }
	| { type: 'cancelOptimizeQuery'; boxId: string }
	| OptimizeQueryMessage
	| ExecuteQueryMessage
	| CopyAdeLinkMessage
	| ShareToClipboardMessage
	| { type: 'prefetchSchema'; connectionId: string; database: string; boxId: string; forceRefresh?: boolean; requestToken?: string }
	| { type: 'requestCrossClusterSchema'; clusterName: string; database: string; boxId: string; requestToken: string }
	| { type: 'promptAddConnection'; boxId?: string }
	| ImportConnectionsFromXmlMessage
	| KqlLanguageRequestMessage
	| FetchControlCommandSyntaxMessage
	| { type: 'openToolResultInEditor'; boxId: string; tool: string; label: string; content: string }
	| { type: 'openMarkdownPreview'; filePath: string }
	| { type: 'comparisonBoxEnsured'; requestId: string; sourceBoxId: string; comparisonBoxId: string }
	| {
			type: 'comparisonSummary';
			sourceBoxId: string;
			comparisonBoxId: string;
			dataMatches: boolean;
			headersMatch?: boolean;
			rowOrderMatches?: boolean;
			columnOrderMatches?: boolean;
		}
	// Tool orchestrator response messages (from webview back to extension)
	| { type: 'toolResponse'; requestId: string; result: unknown; error?: string }
	// Tool orchestrator state request (webview sends current state)
	| { type: 'toolStateResponse'; requestId: string; sections: unknown[] }
	| { type: 'openCopilotAgent' }
	| { type: 'copilotChatFirstTimeCheck'; boxId: string };

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
	private copilotHistoryEntrySeq = 0;
	private readonly kqlLanguageHost: KqlLanguageServiceHost;
	private readonly resolvedResourceUriCache = new Map<string, string>();
	private readonly copilotExtendedSchemaCache = new Map<string, { timestamp: number; result: string; label: string }>();
	private readonly controlCommandSyntaxCache = new Map<string, { timestamp: number; syntax: string; withArgs: string[]; error?: string }>();
	private readonly CONTROL_COMMAND_SYNTAX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
	// Track which boxes have already received general-query-rules.md (first message only)
	private readonly copilotGeneralRulesSentPerBox = new Set<string>();
	// Track which boxes have already received dev notes context (first message only)
	private readonly copilotDevNotesSentPerBox = new Set<string>();
	// Conversation history per box for Copilot Chat
	private readonly copilotConversationHistoryByBoxId = new Map<string, ConversationHistoryEntry[]>();

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
				name: 'execute_kusto_query',
				label: 'Execute Kusto query and read results',
				description: 'Executes a KQL query against the connected cluster and returns the results for analysis.',
				enabledByDefault: true
			},
			{
				name: 'search_cached_schemas',
				label: 'Search cached schemas',
				description: 'Searches all cached database schemas for tables, columns, functions, or docstrings matching a regex pattern.',
				enabledByDefault: true
			},
			{
				name: 'respond_to_query_performance_optimization_request',
				label: 'Respond to query performance optimization or data comparison request',
				description:
					'Creates a comparison section with your proposed query, prettifies it, and runs both queries to compare performance and / or results.',
				enabledByDefault: true
			},
			{
				name: 'respond_to_all_other_queries',
				label: 'Respond to all other queries',
				description:
					'Returns a runnable query for all other requests. The extension will set it in the editor and run it.',
				enabledByDefault: true
			},
			{
				name: 'ask_user_clarifying_question',
				label: 'Ask user clarifying question',
				description:
					'Ask the user a clarifying question when you need more information to write the correct query.',
				enabledByDefault: true
			},
			{
				name: 'update_development_note',
				label: 'Update development note',
				description:
					'Create, update, or remove a development note. Use ONLY for non-obvious corrections, gotchas, schema hints, or clarifications that would prevent repeating mistakes. To remove a note, set content to empty.',
				enabledByDefault: true
			}
		];
	}

	/**
	 * Returns native VS Code LanguageModelChatTool definitions for use with sendRequest().
	 * Only includes tools that are currently enabled.
	 */
	private getCopilotChatTools(enabledTools: string[]): vscode.LanguageModelChatTool[] {
		const localTools = this.getCopilotLocalTools();
		const tools: vscode.LanguageModelChatTool[] = [];

		for (const t of localTools) {
			if (!this.isCopilotToolEnabled(t.name, enabledTools)) {
				continue;
			}
			const n = this.normalizeToolName(t.name);
			if (n === 'get_extended_schema') {
				tools.push({
					name: 'get_extended_schema',
					description: 'Provides cached database schema (tables + columns) to improve query correctness. Call this when you need to know table names, column names, or column types before writing a query.',
					inputSchema: {
						type: 'object',
						properties: {
							database: {
								type: 'string',
								description: 'The database name to get the schema for. Defaults to the currently selected database if omitted.'
							}
						}
					}
				});
			} else if (n === 'get_query_optimization_best_practices') {
				tools.push({
					name: 'get_query_optimization_best_practices',
					description: 'Returns the query optimization best practices document (optimize-query-rules.md). Call this before optimizing queries for performance.',
					inputSchema: {
						type: 'object',
						properties: {}
					}
				});
			} else if (n === 'execute_kusto_query') {
				tools.push({
					name: 'execute_kusto_query',
					description: 'Executes a KQL query against the connected cluster and returns the results for analysis. Use when you need to run a query to analyze data, explore data, or verify something. The query is automatically limited to 100 rows.',
					inputSchema: {
						type: 'object',
						properties: {
							query: {
								type: 'string',
								description: 'The complete KQL query to execute.'
							}
						},
						required: ['query']
					}
				});
			} else if (n === 'search_cached_schemas') {
				tools.push({
					name: 'search_cached_schemas',
					description: 'Searches all cached database schemas for tables, columns, functions, or docstrings matching a regex pattern. Use this to discover relevant tables or columns when you are not sure which ones to use, or to find items by partial name or description. Returns matches across all cached databases.',
					inputSchema: {
						type: 'object',
						properties: {
							pattern: {
								type: 'string',
								description: 'A regex pattern to search for across table names, column names, function names, and their docstrings. Case-insensitive.'
							}
						},
						required: ['pattern']
					}
				});
			} else if (n === 'respond_to_query_performance_optimization_request') {
				tools.push({
					name: 'respond_to_query_performance_optimization_request',
					description: 'Use this as your FINAL response when the user asks to improve or optimize query performance. Creates a side-by-side comparison section with your proposed query and runs both to compare performance and results. Provide the FULL optimized query (not a diff).',
					inputSchema: {
						type: 'object',
						properties: {
							query: {
								type: 'string',
								description: 'The complete optimized KQL query.'
							}
						},
						required: ['query']
					}
				});
			} else if (n === 'respond_to_all_other_queries') {
				tools.push({
					name: 'respond_to_all_other_queries',
					description: 'Use this as your FINAL response for all non-optimization requests. Sets the query in the editor and runs it. Provide the FULL complete KQL query (not a diff).',
					inputSchema: {
						type: 'object',
						properties: {
							query: {
								type: 'string',
								description: 'The complete KQL query to set in the editor and run.'
							}
						},
						required: ['query']
					}
				});
			} else if (n === 'ask_user_clarifying_question') {
				tools.push({
					name: 'ask_user_clarifying_question',
					description: 'Ask the user a clarifying question when you need more information to write the correct query. Use when the request is ambiguous or you need clarification about tables, columns, filters, or logic.',
					inputSchema: {
						type: 'object',
						properties: {
							question: {
								type: 'string',
								description: 'The specific clarifying question to ask the user.'
							}
						},
						required: ['question']
					}
				});
			} else if (n === 'update_development_note') {
				tools.push({
					name: 'update_development_note',
					description: 'Create, update, or remove a development note. Use ONLY for non-obvious corrections, gotchas, schema hints, or clarifications that would prevent repeating mistakes. To remove an existing note, provide its noteId with empty content.',
					inputSchema: {
						type: 'object',
						properties: {
							noteId: {
								type: 'string',
								description: 'The ID of an existing note to update or remove. Omit when creating a new note.'
							},
							category: {
								type: 'string',
								enum: ['correction', 'clarification', 'schema-hint', 'usage-note', 'gotcha'],
								description: 'The category of the note (required when creating or updating).'
							},
							content: {
								type: 'string',
								description: 'Concise note content. Focus on the what and why. Set to empty string to remove the note identified by noteId.'
							},
							relatedSectionIds: {
								type: 'array',
								items: { type: 'string' },
								description: 'Optional IDs of sections this note relates to.'
							}
						},
						required: ['content']
					}
				});
			}
		}

		return tools;
	}

	private async readOptimizeQueryRules(): Promise<string> {
		try {
			const uri = vscode.Uri.joinPath(this.context.extensionUri, 'copilot-instructions', 'optimize-query-rules.md');
			const bytes = await vscode.workspace.fs.readFile(uri);
			return new TextDecoder('utf-8').decode(bytes);
		} catch (e) {
			const msg = this.getErrorMessage(e);
			return `Failed to read copilot-instructions/optimize-query-rules.md: ${msg}`;
		}
	}

	private async readGeneralQueryRules(): Promise<{ content: string; filePath: string } | undefined> {
		// Read from extension's bundled copilot-instructions/general-query-rules.md
		try {
			const uri = vscode.Uri.joinPath(this.context.extensionUri, 'copilot-instructions', 'general-query-rules.md');
			const bytes = await vscode.workspace.fs.readFile(uri);
			return {
				content: new TextDecoder('utf-8').decode(bytes),
				filePath: uri.fsPath
			};
		} catch {
			// File doesn't exist or couldn't be read
			return undefined;
		}
	}

	/**
	 * Reads dev notes entries from the current document state (via webview).
	 * Returns a formatted string if there are any entries, or undefined.
	 */
	private async getDevNotesContent(): Promise<string | undefined> {
		try {
			const sections = await this.requestSectionsFromWebview();
			if (!sections || !Array.isArray(sections)) return undefined;
			const devNotesSection = sections.find((s: any) => s && s.type === 'devnotes') as any;
			if (!devNotesSection || !Array.isArray(devNotesSection.entries) || devNotesSection.entries.length === 0) {
				return undefined;
			}
			const lines: string[] = [];
			for (const entry of devNotesSection.entries) {
				if (!entry || !entry.content) continue;
				const parts = [`- **[${entry.category || 'note'}]**`];
				if (entry.id) parts[0] += ` (id: ${entry.id})`;
				if (entry.updated) parts[0] += ` (${entry.updated})`;
				parts[0] += `: ${entry.content}`;
				lines.push(parts[0]);
			}
			return lines.length > 0 ? lines.join('\n') : undefined;
		} catch {
			return undefined;
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

	private extractQuestionArgument(args: unknown): string {
		try {
			if (args && typeof args === 'object') {
				const a = args as any;
				if (typeof a.question === 'string') {
					return a.question.trim();
				}
				// If JSON parsing failed, we store the raw tool payload under args.raw
				if (typeof a.raw === 'string') {
					return String(a.raw).trim();
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

		// Connect the tool orchestrator to this webview instance
		this.connectToolOrchestrator();

		this.panel.onDidDispose(() => {
			this.cancelAllRunningQueries();
			this.disconnectToolOrchestrator();
			this.panel = undefined;
		});
	}

	private connectToolOrchestrator(): void {
		if (!toolOrchestrator) return;
		
		// Set up the message poster
		toolOrchestrator.setWebviewMessagePoster((message: unknown) => {
			this.postMessage(message);
		});

		// Set up the state getter to retrieve current sections
		toolOrchestrator.setStateGetter(async () => {
			const sections = await this.requestSectionsFromWebview();
			// Cast to the expected type - webview returns untyped objects
			return sections as Array<{ id?: string; type: string; [key: string]: unknown }> | undefined;
		});

		// Set up the schema refresher (force-fetches from Kusto and updates cache)
		toolOrchestrator.setSchemaRefresher(async (clusterUrl: string) => {
			return this.refreshSchemaForTools(clusterUrl);
		});
	}

	private disconnectToolOrchestrator(): void {
		if (!toolOrchestrator) return;
		toolOrchestrator.setWebviewMessagePoster(undefined);
		toolOrchestrator.setStateGetter(undefined);
		toolOrchestrator.setSchemaRefresher(undefined);
	}

	private toolStateResponseResolvers = new Map<string, (sections: unknown[]) => void>();

	private async requestSectionsFromWebview(): Promise<unknown[] | undefined> {
		if (!this.panel) return undefined;
		
		const requestId = `state_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		
		return new Promise<unknown[] | undefined>((resolve) => {
			const timer = setTimeout(() => {
				this.toolStateResponseResolvers.delete(requestId);
				resolve(undefined);
			}, 5000);
			
			this.toolStateResponseResolvers.set(requestId, (sections) => {
				clearTimeout(timer);
				this.toolStateResponseResolvers.delete(requestId);
				resolve(sections);
			});
			
			this.postMessage({ type: 'requestToolState', requestId });
		});
	}

	/**
	 * Force-refreshes the schema for all databases on a given cluster.
	 * Fetches from Kusto, updates both in-memory and disk caches, and returns the schemas.
	 */
	private async refreshSchemaForTools(clusterUrl: string): Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }> {
		// Find a matching connection by cluster URL
		const connections = this.connectionManager.getConnections();
		const normalizedInput = clusterUrl.replace(/\/+$/, '').toLowerCase();
		const connection = connections.find(c => c.clusterUrl.replace(/\/+$/, '').toLowerCase() === normalizedInput);
		if (!connection) {
			// No saved connection — create an ephemeral one so we can still authenticate
			const ephemeral: KustoConnection = { id: `ephemeral_${Date.now()}`, name: clusterUrl, clusterUrl };
			return this.refreshSchemaForConnection(ephemeral);
		}
		return this.refreshSchemaForConnection(connection);
	}

	private async refreshSchemaForConnection(connection: KustoConnection): Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }> {
		const schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }> = [];
		try {
			// Get all databases for this cluster
			const databases = await this.kustoClient.getDatabases(connection, true);
			if (databases.length === 0) {
				return { schemas: [], error: 'No databases found on this cluster, or insufficient permissions.' };
			}

			const errors: string[] = [];
			for (const db of databases) {
				try {
					const result = await this.kustoClient.getDatabaseSchema(connection, db, true);
					const schema = result.schema;

					// Persist to disk cache
					const cacheKey = `${connection.clusterUrl.replace(/\/+$/, '')}|${db}`;
					const timestamp = result.fromCache ? Date.now() - (result.cacheAgeMs ?? 0) : Date.now();
					await this.saveCachedSchemaToDisk(cacheKey, { schema, timestamp, version: SCHEMA_CACHE_VERSION });

					const tables = schema.tables || [];
					const functions = (schema.functions || []).map(f => typeof f === 'string' ? f : f.name || '').filter(Boolean);
					schemas.push({
						clusterUrl: connection.clusterUrl,
						database: db,
						tables,
						functions
					});
				} catch (dbErr) {
					errors.push(`${db}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
				}
			}

			if (errors.length > 0 && schemas.length === 0) {
				return { schemas, error: `Failed to refresh schema for all databases: ${errors.join('; ')}` };
			}
			if (errors.length > 0) {
				return { schemas, error: `Some databases failed: ${errors.join('; ')}` };
			}
			return { schemas };
		} catch (err) {
			return { schemas, error: `Failed to refresh schema: ${err instanceof Error ? err.message : String(err)}` };
		}
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

		// Connect the tool orchestrator to this webview instance
		this.connectToolOrchestrator();

		this.panel.onDidDispose(() => {
			this.cancelAllRunningQueries();
			this.disconnectToolOrchestrator();
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
						headersMatch: message.headersMatch === null || message.headersMatch === undefined ? true : !!message.headersMatch
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
			case 'setAutoTriggerAutocompleteEnabled':
				await this.context.globalState.update(STORAGE_KEYS.autoTriggerAutocompleteEnabled, !!message.enabled);
				return;
			case 'setCopilotInlineCompletionsEnabled':
				await this.context.globalState.update(STORAGE_KEYS.copilotInlineCompletionsEnabled, !!message.enabled);
				return;
			case 'requestCopilotInlineCompletion':
				await this.handleCopilotInlineCompletionRequest(message);
				return;
			case 'getDatabases':
				await this.sendDatabases(message.connectionId, message.boxId, false);
				return;
			case 'refreshDatabases':
				await this.sendDatabases(message.connectionId, message.boxId, true);
				return;
			case 'saveLastSelection':
				{
					const cid = String(message.connectionId || '').trim();
					if (!cid) {
						return;
					}
					await this.saveLastSelection(cid, message.database);
				}
				try {
					// Ensure VS Code Problems reflects the new schema context immediately.
					await vscode.commands.executeCommand('kusto.refreshTextEditorDiagnostics');
				} catch {
					// ignore
				}
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
			case 'clearCopilotConversation':
				this.clearCopilotConversation(message.boxId);
				return;
			case 'openCopilotAgent':
				try {
					await vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'Kusto Workbench' });
				} catch { /* ignore */ }
				return;
			case 'copilotChatFirstTimeCheck':
				await this.handleCopilotChatFirstTimeCheck(message.boxId);
				return;
			case 'removeFromCopilotHistory':
				this.removeFromCopilotHistory(message.boxId, message.entryId);
				return;
			case 'openToolResultInEditor':
				await this.openToolResultInEditor(message);
				return;
			case 'openMarkdownPreview':
				await this.openMarkdownPreview(message.filePath);
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
			case 'shareToClipboard':
				await this.shareToClipboardFromWebview(message);
				return;
			case 'cancelQuery':
				this.cancelRunningQuery(message.boxId);
				// If there was nothing to cancel (query already completed but UI is
				// stuck), send queryCancelled so the webview resets the executing state.
				{
					const bid = String(message.boxId || '').trim();
					if (bid && !this.runningQueriesByBoxId.has(bid)) {
						this.postMessage({ type: 'queryCancelled', boxId: bid });
					}
				}
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
			case 'requestCrossClusterSchema':
				await this.handleCrossClusterSchemaRequest(message.clusterName, message.database, message.boxId, message.requestToken);
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
			case 'toolResponse':
				// Handle response from webview for tool orchestrator commands
				if (toolOrchestrator && message.requestId) {
					toolOrchestrator.handleWebviewResponse(message.requestId, message.result, message.error);
				}
				return;
			case 'toolStateResponse':
				// Handle state response from webview
				{
					const resolver = this.toolStateResponseResolvers.get(message.requestId);
					if (resolver) {
						resolver(message.sections);
					}
				}
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

	private async shareToClipboardFromWebview(
		message: Extract<IncomingWebviewMessage, { type: 'shareToClipboard' }>
	): Promise<void> {
		try {
			const {
				includeTitle, includeQuery, includeResults,
				sectionName, queryText, connectionId, database,
				columns, rowsData, totalRows
			} = message;

			if (!includeTitle && !includeQuery && !includeResults) {
				vscode.window.showInformationMessage('Select at least one section to share.');
				return;
			}

			const htmlParts: string[] = [];
			const textParts: string[] = [];

			// Build the ADE link URL (shared between title HTML and plain text).
			let adeUrl = '';
			try {
				const trimmedQuery = String(queryText || '').trim();
				const trimmedConnectionId = String(connectionId || '').trim();
				const trimmedDatabase = String(database || '').trim();
				if (trimmedQuery && trimmedConnectionId && trimmedDatabase) {
					const connection = this.findConnection(trimmedConnectionId);
					if (connection) {
						const clusterShortName = this.getClusterShortName(String(connection.clusterUrl || '').trim());
						if (clusterShortName) {
							const gz = zlib.gzipSync(Buffer.from(trimmedQuery, 'utf8'));
							const encoded = gz.toString('base64').replace(/=+$/g, '');
							adeUrl =
								`https://dataexplorer.azure.com/clusters/${encodeURIComponent(clusterShortName)}` +
								`/databases/${encodeURIComponent(trimmedDatabase)}` +
								`?query=${encodeURIComponent(encoded)}`;
						}
					}
				}
			} catch {
				// If URL generation fails, just skip the link.
			}

			const escHtml = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

			// 1. Title
			if (includeTitle) {
				const title = sectionName || 'Kusto Query';
				if (adeUrl) {
					htmlParts.push(`<b>${escHtml(title)}</b><br><a href="${escHtml(adeUrl)}">Direct link to query</a>`);
					textParts.push(`${title}\nDirect link to query: ${adeUrl}`);
				} else {
					htmlParts.push(`<b>${escHtml(title)}</b>`);
					textParts.push(title);
				}
			}

			// 2. Query — as a styled code block with a "Query" header.
			if (includeQuery) {
				const q = String(queryText || '').trim();
				if (q) {
					htmlParts.push(
						`<b style="font-size:13px">Query</b>` +
						`<pre style="background:#1e1e1e;color:#d4d4d4;padding:12px 16px;border-radius:6px;font-family:'Cascadia Code','Consolas','Courier New',monospace;font-size:13px;overflow-x:auto;white-space:pre;border:1px solid #333;margin-top:4px"><code class="kql">${escHtml(q)}</code></pre>`
					);
					textParts.push('Query\n' + q);
				}
			}

			// 3. Results — as an HTML table with a "Results" header.
			if (includeResults && Array.isArray(columns) && columns.length > 0 && Array.isArray(rowsData) && rowsData.length > 0) {
				const thCells = columns.map(c => `<th align="left" style="border:1px solid #555;padding:6px 10px;background:#2d2d2d;color:#e0e0e0;text-align:left;font-weight:600;font-size:12px;white-space:nowrap">${escHtml(c)}</th>`).join('');
				const bodyRows = rowsData.map((row, ri) => {
					const bg = ri % 2 === 0 ? '#1e1e1e' : '#252526';
					const cells = row.map(v => `<td align="left" style="border:1px solid #444;padding:4px 10px;color:#d4d4d4;font-size:12px;white-space:nowrap;text-align:left">${escHtml(v)}</td>`).join('');
					return `<tr style="background:${bg}">${cells}</tr>`;
				}).join('');

				// Plain-text fallback table.
				const escCell = (v: string) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
				const headerRow = '| ' + columns.map(escCell).join(' | ') + ' |';
				const separator = '| ' + columns.map(() => '---').join(' | ') + ' |';
				const dataRows = rowsData.map(row =>
					'| ' + row.map(escCell).join(' | ') + ' |'
				).join('\n');

				// Add a summary line when not all rows are included.
				const shownRows = rowsData.length;
				const total = typeof totalRows === 'number' && totalRows > 0 ? totalRows : shownRows;
				const summaryLine = total > shownRows
					? `Showing ${shownRows.toLocaleString()} of ${total.toLocaleString()} rows`
					: `${shownRows.toLocaleString()} rows`;

				htmlParts.push(
					`<b style="font-size:13px">Results</b><br>` +
					`<span style="font-size:11px;color:#888;font-style:italic">${escHtml(summaryLine)}</span>` +
					`<table style="border-collapse:collapse;font-family:'Segoe UI',sans-serif;margin:4px 0"><thead><tr>${thCells}</tr></thead><tbody>${bodyRows}</tbody></table>`
				);

				textParts.push('Results\n' + summaryLine + '\n' + headerRow + '\n' + separator + '\n' + dataRows);
			}

			if (htmlParts.length === 0) {
				vscode.window.showInformationMessage('Nothing to share — the selected sections are empty.');
				return;
			}

			const html = htmlParts.join('<br><br>');
			const text = textParts.join('\n\n');

			// Send the formatted content back to the webview so it can write
			// both text/html and text/plain to the clipboard via the browser API.
			this.postMessage({ type: 'shareContentReady', html, text } as any);
			vscode.window.showInformationMessage('Copied to clipboard and ready to paste into Teams.');
		} catch {
			vscode.window.showErrorMessage('Failed to copy share content to clipboard.');
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

	/**
	 * Clears the Copilot conversation state for a box, so the next message is treated as the first.
	 */
	private clearCopilotConversation(boxId: string): void {
		const id = String(boxId || '').trim();
		if (!id) {
			return;
		}
		// Reset the general rules sent flag so it will be sent again on the next message
		try {
			this.copilotGeneralRulesSentPerBox.delete(id);
		} catch {
			// ignore
		}
		// Clear conversation history
		try {
			this.copilotConversationHistoryByBoxId.delete(id);
		} catch {
			// ignore
		}
	}

	/**
	 * Marks a conversation history entry as removed (truncated).
	 * The entry stays in history but its result is replaced with a placeholder.
	 */
	private removeFromCopilotHistory(boxId: string, entryId: string): void {
		const id = String(boxId || '').trim();
		const eid = String(entryId || '').trim();
		if (!id || !eid) {
			return;
		}
		const history = this.copilotConversationHistoryByBoxId.get(id);
		if (!history) {
			return;
		}
		const entry = history.find((e) => e.id === eid);
		if (entry && (entry.type === 'tool-call' || entry.type === 'general-rules')) {
			entry.removed = true;
		}
	}

	/**
	 * Helper to generate unique history entry IDs
	 */
	private nextHistoryEntryId(boxId: string): string {
		return `${boxId}_hist_${++this.copilotHistoryEntrySeq}`;
	}

	/**
	 * Gets or creates conversation history for a box
	 */
	private getOrCreateConversationHistory(boxId: string): ConversationHistoryEntry[] {
		let history = this.copilotConversationHistoryByBoxId.get(boxId);
		if (!history) {
			history = [];
			this.copilotConversationHistoryByBoxId.set(boxId, history);
		}
		return history;
	}

	/**
	 * Ensures every tool call from the latest assistant message has a corresponding
	 * tool-result entry in the conversation history. Missing results cause 400 errors
	 * with Claude's API ("tool_use ids were found without tool_result blocks").
	 *
	 * Delegates to insertMissingToolCallResults which inserts at the correct
	 * position (right after the owning assistant-message) instead of pushing
	 * to the end of the array — preventing race-condition-induced orphaned
	 * tool_result entries.
	 */
	private ensureAllToolCallsHaveResults(
		history: ConversationHistoryEntry[],
		nativeToolCalls: Array<{ callId: string; name: string; input: any }>,
		boxId: string
	): void {
		insertMissingToolCallResults(history, nativeToolCalls, () => this.nextHistoryEntryId(boxId));
	}

	/**
	 * Opens tool result content in a new VS Code editor tab.
	 */
	private async openToolResultInEditor(
		message: Extract<IncomingWebviewMessage, { type: 'openToolResultInEditor' }>
	): Promise<void> {
		try {
			const tool = String(message.tool || 'tool_result').trim();
			const content = String(message.content || '');

			// Create an untitled document with the content
			const doc = await vscode.workspace.openTextDocument({
				content,
				language: 'plaintext'
			});

			await vscode.window.showTextDocument(doc, {
				preview: true,
				viewColumn: vscode.ViewColumn.Beside
			});
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to open tool result: ${this.getErrorMessage(error)}`);
		}
	}

	/**
	 * Opens a markdown file in VS Code's built-in markdown preview.
	 */
	private async openMarkdownPreview(filePath: string): Promise<void> {
		try {
			const uri = vscode.Uri.file(filePath);
			await vscode.commands.executeCommand('markdown.showPreview', uri);
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to open markdown preview: ${this.getErrorMessage(error)}`);
		}
	}

	/**
	 * Handle inline completion requests from the webview Monaco editor.
	 * Uses VS Code's Language Model API to get Copilot suggestions for KQL.
	 */
	private async handleCopilotInlineCompletionRequest(
		message: Extract<IncomingWebviewMessage, { type: 'requestCopilotInlineCompletion' }>
	): Promise<void> {
		const requestId = String(message.requestId || '').trim();
		const boxId = String(message.boxId || '').trim();
		const textBefore = String(message.textBefore || '');
		const textAfter = String(message.textAfter || '');

		if (!requestId) {
			return;
		}

		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			if (models.length === 0) {
				this.postMessage({
					type: 'copilotInlineCompletionResult',
					requestId,
					boxId,
					completions: [],
					error: 'Copilot not available'
				} as any);
				return;
			}

			// Use the preferred default model
			const model = findPreferredDefaultCopilotModel(models)!;

			// Build a completion prompt tailored for KQL
			const prompt = `You are an expert Kusto Query Language (KQL) assistant providing inline code completions.
Complete the following KQL code. Only return the completion text that should be inserted at the cursor position.
Do NOT include any explanation, markdown formatting, or code fences.
Return ONLY the raw KQL code to complete the line or statement.
If you cannot provide a meaningful completion, return an empty string.

KQL code before cursor:
${textBefore}

KQL code after cursor:
${textAfter}

Completion:`;

			const cts = new vscode.CancellationTokenSource();
			// Set a short timeout for inline completions (they should be fast)
			const timeoutId = setTimeout(() => cts.cancel(), 3000);

			try {
				const response = await model.sendRequest(
					[vscode.LanguageModelChatMessage.User(prompt)],
					{},
					cts.token
				);

				let completionText = '';
				for await (const chunk of response.text) {
					completionText += chunk;
					// Stop early if we get too much text (inline completions should be short)
					if (completionText.length > 500) {
						break;
					}
				}

				clearTimeout(timeoutId);

				// Clean up the completion text
				completionText = completionText.trim();
				// Remove any accidental code fence markers
				completionText = completionText.replace(/^```(?:kusto|kql)?\s*\n?/i, '').replace(/\n?```$/i, '');

				const completions = completionText ? [{ insertText: completionText }] : [];

				this.postMessage({
					type: 'copilotInlineCompletionResult',
					requestId,
					boxId,
					completions
				} as any);
			} catch (err) {
				clearTimeout(timeoutId);
				if (err instanceof vscode.CancellationError) {
					// Request was cancelled (timeout or user action), return empty
					this.postMessage({
						type: 'copilotInlineCompletionResult',
						requestId,
						boxId,
						completions: []
					} as any);
				} else {
					throw err;
				}
			} finally {
				cts.dispose();
			}
		} catch (err) {
			const errorMsg = err instanceof vscode.LanguageModelError
				? `Copilot error: ${err.message}`
				: this.getErrorMessage(err);
			this.postMessage({
				type: 'copilotInlineCompletionResult',
				requestId,
				boxId,
				completions: [],
				error: errorMsg
			} as any);
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
				.filter((m) => !!m.id)
				.sort((a, b) => a.label.localeCompare(b.label));

			const lastModelId = this.context.globalState.get<string>(STORAGE_KEYS.lastOptimizeCopilotModelId);
			const preferredModelId = String(lastModelId || '').trim();
			const defaultModelId = findPreferredDefaultCopilotModel(models)?.id || '';
			const selectedModelId =
				preferredModelId && modelOptions.some((m) => m.id === preferredModelId)
					? preferredModelId
					: defaultModelId;

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

	private async getExtendedSchemaToolResult(
		connection: KustoConnection,
		database: string,
		boxId: string,
		token: vscode.CancellationToken,
		model?: vscode.LanguageModelChat
	): Promise<{ result: string; label: string; prunePhase?: number }> {
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
				return { result: cached.result, label: cached.label };
			}
		} catch {
			// ignore
		}

		let jsonText = '';
		let label = '';
		let prunePhase: number | undefined;
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

				const schemaMeta = { cacheAgeMs, tablesCount, columnsCount, functionsCount };

				// If we have access to the model, apply token-budget-aware progressive pruning
				if (model && typeof model.countTokens === 'function' && typeof model.maxInputTokens === 'number') {
					const tokenBudget = Math.floor(model.maxInputTokens * DEFAULT_SCHEMA_TOKEN_BUDGET_FRACTION);
					const countTokensFn = (text: string) => model.countTokens(text, token);

					try {
						const pruneResult: SchemaPruneResult = await formatSchemaWithTokenBudget(
							db, schema, schemaMeta, tokenBudget, countTokensFn
						);
						jsonText = pruneResult.text;
						prunePhase = pruneResult.phase;

						if (pruneResult.phase > 0) {
							label += ` (${PRUNE_PHASE_DESCRIPTIONS[pruneResult.phase]})`;
						}
					} catch {
						// If token counting fails, fall through to the unpruned format
						jsonText = formatSchemaAsCompactText(db, schema, schemaMeta);
					}
				} else {
					// No model available – use full compact text (original behavior)
					jsonText = formatSchemaAsCompactText(db, schema, schemaMeta);
				}
			}
		} catch (error) {
			const raw = this.getErrorMessage(error);
			label = `${db || '(unknown db)'}: schema lookup failed`;
			jsonText = JSON.stringify({ database: db, error: `Failed to read cached schema: ${raw}` }, null, 2);
		}

		try {
			this.copilotExtendedSchemaCache.set(memCacheKey, { timestamp: now, result: jsonText, label });
		} catch {
			// ignore
		}

		// Return both result and label; caller is responsible for posting message with entryId
		return { result: jsonText, label, prunePhase };
	}

	/**
	 * Builds a multi-message conversation from the history for native tool calling.
	 * Returns an array of LanguageModelChatMessage with proper User/Assistant role alternation.
	 */
	private buildMessagesFromHistory(args: {
		boxId: string;
		clusterUrl: string;
		database: string;
		priorAttempts?: Array<{ attempt: number; query?: string; error?: string }>;
	}): vscode.LanguageModelChatMessage[] {
		const history = this.copilotConversationHistoryByBoxId.get(args.boxId) || [];

		// Sanitize the history to fix any corruption from race conditions
		// (e.g., cancelled requests leaving orphaned or mis-positioned tool-call entries).
		sanitizeConversationHistory(history);

		const messages: vscode.LanguageModelChatMessage[] = [];

		// System preamble as first User message
		const preambleParts: string[] = [];
		preambleParts.push('Role: You are a senior Kusto Query Language (KQL) engineer.');
		preambleParts.push('Task: Write a complete, runnable KQL query for the user request.');
		preambleParts.push('');
		preambleParts.push('Context:');
		preambleParts.push(`- Cluster: ${args.clusterUrl || '(unknown)'}`);
		preambleParts.push(`- Database: ${args.database || '(unknown)'}`);
		preambleParts.push('');
		preambleParts.push('RESPONSE FORMAT RULES:');
		preambleParts.push('- Use the provided tools to accomplish your task. You have access to tools for getting schema, executing queries, and delivering your final query.');
		preambleParts.push('- Use as many tool calls as needed across turns: get schema, get best practices, execute queries, then finish with one of the final response tools.');
		preambleParts.push('- Always provide the FULL query (not a diff) as the tool argument.');
		preambleParts.push('- If you cannot fulfill the request, use the ask_user_clarifying_question tool.');
		messages.push(vscode.LanguageModelChatMessage.User(preambleParts.join('\n')));

		// Build conversation from history entries
		for (const entry of history) {
			if (entry.type === 'general-rules') {
				if (entry.removed) {
					messages.push(vscode.LanguageModelChatMessage.User(
						'[Workspace-specific query rules: truncated from conversation history, refer to your knowledge if needed]'
					));
				} else {
					messages.push(vscode.LanguageModelChatMessage.User(
						'Workspace-specific query rules (from .github/copilot-instructions/general-query-rules.md):\n' + entry.content
					));
				}
			} else if (entry.type === 'devnotes-context') {
				if (entry.removed) {
					messages.push(vscode.LanguageModelChatMessage.User(
						'[Development notes: removed from conversation history]'
					));
				} else {
					messages.push(vscode.LanguageModelChatMessage.User(
						'Development notes for this file (insights from previous sessions — use these to avoid repeating past mistakes):\n' + entry.content
					));
				}
			} else if (entry.type === 'user-message') {
				let text = entry.text;
				if (entry.querySnapshot) {
					text += '\n\nCurrent query in editor:\n```kusto\n' + entry.querySnapshot + '\n```';
				}
				messages.push(vscode.LanguageModelChatMessage.User(text));
			} else if (entry.type === 'assistant-message') {
				// Reconstruct the assistant message with its tool calls
				const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
				if (entry.text) {
					parts.push(new vscode.LanguageModelTextPart(entry.text));
				}
				if (entry.toolCalls) {
					for (const tc of entry.toolCalls) {
						parts.push(new vscode.LanguageModelToolCallPart(tc.callId, tc.name, tc.input));
					}
				}
				if (parts.length > 0) {
					messages.push(vscode.LanguageModelChatMessage.Assistant(parts));
				}
			} else if (entry.type === 'tool-call') {
				// Tool results go as User messages with ToolResultPart
				const resultText = entry.removed
					? '[truncated from conversation history, call tool again if needed]'
					: entry.result;
				messages.push(vscode.LanguageModelChatMessage.User([
					new vscode.LanguageModelToolResultPart(entry.callId, [
						new vscode.LanguageModelTextPart(resultText)
					])
				]));
			}
		}

		// Safety check: verify every assistant tool_use has a matching tool_result.
		// This defends against any code path that might add an assistant-message with
		// tool calls without recording all tool results.
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
				const toolCallParts = msg.content.filter(
					(p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart
				);
				if (toolCallParts.length > 0) {
					// Collect tool_result callIds from the messages that follow
					const resultCallIds = new Set<string>();
					for (let j = i + 1; j < messages.length; j++) {
						for (const part of messages[j].content) {
							if (part instanceof vscode.LanguageModelToolResultPart) {
								resultCallIds.add(part.callId);
							}
						}
						// Stop at the next assistant message
						if (messages[j].role === vscode.LanguageModelChatMessageRole.Assistant) {
							break;
						}
					}
					// Insert missing tool_result messages right after the assistant message
					const missing = toolCallParts.filter(tc => !resultCallIds.has(tc.callId));
					for (let k = missing.length - 1; k >= 0; k--) {
						messages.splice(i + 1, 0, vscode.LanguageModelChatMessage.User([
							new vscode.LanguageModelToolResultPart(missing[k].callId, [
								new vscode.LanguageModelTextPart('[Tool result was not recorded]')
							])
						]));
					}
				}
			}
		}

		// Reverse safety check: verify every tool_result references a tool_use
		// in a preceding assistant message. Remove orphaned tool_results.
		{
			const allToolUseIds = new Set<string>();
			for (const msg of messages) {
				if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
					for (const part of msg.content) {
						if (part instanceof vscode.LanguageModelToolCallPart) {
							allToolUseIds.add(part.callId);
						}
					}
				}
			}
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i];
				if (msg.role === vscode.LanguageModelChatMessageRole.User) {
					const hasOnlyOrphanedToolResults = msg.content.every(
						(p) => p instanceof vscode.LanguageModelToolResultPart && !allToolUseIds.has(p.callId)
					);
					if (hasOnlyOrphanedToolResults && msg.content.length > 0 &&
						msg.content.some((p) => p instanceof vscode.LanguageModelToolResultPart)) {
						messages.splice(i, 1);
					}
				}
			}
		}

		// Prior attempts (within current message execution only)
		const attempts = args.priorAttempts || [];
		if (attempts.length > 0) {
			const attemptsText = attempts
				.map((a) => {
					const parts = [`Attempt ${a.attempt}:`];
					if (a.query) parts.push(`Generated query:\n${a.query}`);
					if (a.error) parts.push(`Error:\n${a.error}`);
					return parts.join('\n');
				})
				.join('\n\n');
			messages.push(vscode.LanguageModelChatMessage.User(
				'Prior attempts and errors (fix these):\n' + attemptsText
			));
		}

		return messages;
	}

	private async handleCopilotChatFirstTimeCheck(boxId: string): Promise<void> {
		const already = this.context.globalState.get<boolean>(STORAGE_KEYS.copilotChatFirstTimeDismissed);
		if (already) {
			// Already dismissed; tell webview to proceed with the embedded copilot chat.
			this.postMessage({ type: 'copilotChatFirstTimeResult', boxId, action: 'proceed' });
			return;
		}

		// Mark as dismissed regardless of the user's choice (they should not see this again).
		await this.context.globalState.update(STORAGE_KEYS.copilotChatFirstTimeDismissed, true);

		const openAgent = 'Open the Kusto Workbench agent';
		const useChat = 'Use this Copilot Chat window';
		const choice = await vscode.window.showInformationMessage(
			'Hello there! Did you know this extension comes with a custom agent called \'Kusto Workbench\' that is available through the VS Code Copilot chat window? You should use that instead of this chat window unless you are very familiar with both and you understand the differences.',
			{ modal: true },
			openAgent,
			useChat
		);

		if (choice === openAgent) {
			// Open the VS Code chat window with the Kusto Workbench agent selected.
			try {
				await vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'Kusto Workbench' });
			} catch { /* ignore */ }
			// Tell webview to update its local flag but do NOT open the embedded chat.
			this.postMessage({ type: 'copilotChatFirstTimeResult', boxId, action: 'openedAgent' });
		} else if (choice === useChat) {
			// Proceed with the normal embedded copilot chat.
			this.postMessage({ type: 'copilotChatFirstTimeResult', boxId, action: 'proceed' });
		} else {
			// Dialog dismissed without a choice; update the flag but do not open anything.
			this.postMessage({ type: 'copilotChatFirstTimeResult', boxId, action: 'dismissed' });
		}
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
		const copilotQueryMode = String(message.queryMode || 'take100').trim();
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

		const postStatus = (status: string, detail?: string) => {
			try {
				this.postMessage({ type: 'copilotWriteQueryStatus', boxId, status, detail: detail || '' } as any);
			} catch {
				// ignore
			}
		};

		const postNarrative = (narrative: string) => {
			const text = String(narrative || '').trim();
			if (!text) return;
			try {
				this.postMessage({ type: 'copilotWriteQueryStatus', boxId, status: text, role: 'assistant' } as any);
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
				model = findPreferredDefaultCopilotModel(models)!;
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

			// Get or create conversation history for this box
			const history = this.getOrCreateConversationHistory(boxId);

			// On first message for this conversation, add general rules to history
			if (!this.copilotGeneralRulesSentPerBox.has(boxId)) {
				const generalRules = await this.readGeneralQueryRules();
				if (generalRules && generalRules.content) {
					const rulesEntryId = this.nextHistoryEntryId(boxId);
					history.push({
						type: 'general-rules',
						id: rulesEntryId,
						content: generalRules.content,
						filePath: generalRules.filePath,
						timestamp: Date.now()
					});
					this.copilotGeneralRulesSentPerBox.add(boxId);

					// Notify webview about general rules
					try {
						this.postMessage({
							type: 'copilotGeneralQueryRulesLoaded',
							boxId,
							entryId: rulesEntryId,
							filePath: generalRules.filePath,
							preview: generalRules.content
						} as any);
					} catch {
						// ignore
					}
				}
			}

			// On first message for this conversation, add dev notes context
			if (!this.copilotDevNotesSentPerBox.has(boxId)) {
				const devNotesContent = await this.getDevNotesContent();
				if (devNotesContent) {
					const devNotesEntryId = this.nextHistoryEntryId(boxId);
					history.push({
						type: 'devnotes-context',
						id: devNotesEntryId,
						content: devNotesContent,
						timestamp: Date.now()
					});
					this.copilotDevNotesSentPerBox.add(boxId);

					// Notify webview about dev notes context injection
					try {
						this.postMessage({
							type: 'copilotDevNotesContextLoaded',
							boxId,
							entryId: devNotesEntryId,
							preview: devNotesContent
						} as any);
					} catch {
						// ignore
					}
				}
			}

			// Add user message to history (with query snapshot if present)
			const userMessageEntryId = this.nextHistoryEntryId(boxId);
			history.push({
				type: 'user-message',
				id: userMessageEntryId,
				text: request,
				querySnapshot: currentQuery || undefined,
				timestamp: Date.now()
			});

			// Notify webview about the user message (with query snapshot if present)
			if (currentQuery) {
				try {
					this.postMessage({
						type: 'copilotUserQuerySnapshot',
						boxId,
						entryId: userMessageEntryId,
						queryText: currentQuery
					} as any);
				} catch {
					// ignore
				}
			}

			const priorAttempts: Array<{ attempt: number; query?: string; error?: string }> = [];
			const tools = this.getCopilotChatTools(enabledTools);

			const maxAttempts = 6;
			const maxToolTurns = 100;
			let toolTurnCount = 0;
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				if (!isActive() || cts.token.isCancellationRequested) {
					throw new Error('Copilot write-query canceled');
				}
				postStatus(`Generating query (attempt ${attempt}/${maxAttempts})…`);

				// Build messages from conversation history (proper multi-message format)
				const messages = this.buildMessagesFromHistory({
					boxId,
					clusterUrl: String(connection.clusterUrl || ''),
					database,
					priorAttempts
				});

				const response = await model.sendRequest(
					messages,
					{ tools },
					cts.token
				);

				// Collect text parts and tool call parts from the response stream
				const nativeToolCalls: vscode.LanguageModelToolCallPart[] = [];
				let responseText = '';
				for await (const part of response.stream) {
					if (!isActive() || cts.token.isCancellationRequested) {
						throw new Error('Copilot write-query canceled');
					}
					if (part instanceof vscode.LanguageModelTextPart) {
						responseText += part.value;
					} else if (part instanceof vscode.LanguageModelToolCallPart) {
						nativeToolCalls.push(part);
					}
				}

				// Display any narrative text the model included
				if (responseText.trim()) {
					postNarrative(responseText.trim());
				}

				if (nativeToolCalls.length === 0) {
					// Model didn't call any tools — treat as non-compliant, retry
					priorAttempts.push({ attempt, error: 'Copilot did not call any tools. The model should use the available tools to respond.' });
					postStatus('Copilot returned a non-tool response. Retrying…', responseText);
					continue;
				}

				// Record the assistant message (with text + tool calls) in conversation history
				const assistantEntryId = this.nextHistoryEntryId(boxId);
				history.push({
					type: 'assistant-message',
					id: assistantEntryId,
					text: responseText,
					toolCalls: nativeToolCalls.map(tc => ({ callId: tc.callId, name: tc.name, input: tc.input })),
					timestamp: Date.now()
				});

				// Process each tool call
				let shouldRetryAttempt = false;
				let hasOptionalToolCalls = false;

				try { // finally → ensure every tool_use gets a matching tool_result
				for (const tc of nativeToolCalls) {
					if (!isActive() || cts.token.isCancellationRequested) {
						throw new Error('Copilot write-query canceled');
					}

					const toolName = this.normalizeToolName(tc.name);

					if (toolName === 'get_extended_schema') {
						const requestedDbRaw = (tc.input as any)?.database;
						const requestedDb = String(requestedDbRaw || database || '').trim() || database;
						const schemaToolResult = await this.getExtendedSchemaToolResult(connection, requestedDb, boxId, cts.token, model);
						
						// Add tool result to conversation history
						const schemaEntryId = this.nextHistoryEntryId(boxId);
						history.push({
							type: 'tool-call',
							id: schemaEntryId,
							callId: tc.callId,
							tool: 'get_extended_schema',
							args: { database: requestedDb },
							result: schemaToolResult.result,
							timestamp: Date.now()
						});
						
						try {
							this.postMessage({
								type: 'copilotWriteQueryToolResult',
								boxId,
								entryId: schemaEntryId,
								tool: 'get_extended_schema',
								label: schemaToolResult.label,
								json: schemaToolResult.result
							} as any);
						} catch {
							// ignore
						}

						// Notify user in the chat window when schema was pruned to fit context
						if (schemaToolResult.prunePhase && schemaToolResult.prunePhase > 0) {
							const phaseDesc = PRUNE_PHASE_DESCRIPTIONS[schemaToolResult.prunePhase as 0 | 1 | 2 | 3 | 4 | 5] || 'reduced';
							postStatus(`Schema was too large for the model\u2019s context window and was automatically reduced (${phaseDesc}). Provide specific table or column names for best results.`);
						}

						hasOptionalToolCalls = true;
						continue;
					}

					if (toolName === 'get_query_optimization_best_practices') {
						const bestPracticesResult = await this.readOptimizeQueryRules();
						
						const bpEntryId = this.nextHistoryEntryId(boxId);
						history.push({
							type: 'tool-call',
							id: bpEntryId,
							callId: tc.callId,
							tool: 'get_query_optimization_best_practices',
							result: bestPracticesResult,
							timestamp: Date.now()
						});
						
						try {
							this.postMessage({
								type: 'copilotWriteQueryToolResult',
								boxId,
								entryId: bpEntryId,
								tool: 'get_query_optimization_best_practices',
								label: 'optimize-query-rules.md',
								json: bestPracticesResult
							} as any);
						} catch {
							// ignore
						}
						hasOptionalToolCalls = true;
						continue;
					}

					if (toolName === 'execute_kusto_query') {
						const rawQuery = this.extractQueryArgument(tc.input);
						const query = this.extractKustoCodeBlock(rawQuery).trim();
						if (!query) {
							// Add error result for the tool call
							const errEntryId = this.nextHistoryEntryId(boxId);
							history.push({
								type: 'tool-call',
								id: errEntryId,
								callId: tc.callId,
								tool: 'execute_kusto_query',
								args: tc.input,
								result: 'Error: query argument was empty. Please provide a non-empty KQL query.',
								timestamp: Date.now()
							});
							hasOptionalToolCalls = true;
							continue;
						}
						try {
							const isControl = this.isControlCommand(query);
							const queryWithLimit = this.appendQueryMode(query, copilotQueryMode);
							const cacheDirective = isControl ? '' : this.buildCacheDirective(true, 1, 'days');
							const finalQuery = cacheDirective ? `${cacheDirective}\n${queryWithLimit}` : queryWithLimit;
							const cancelClientKey = `${boxId}::${connection.id}::executeForCopilot`;
							const result = await this.kustoClient.executeQueryCancelable(connection, database, finalQuery, cancelClientKey).promise;

							// Format query results for the LLM
							let queryResultText = '';
							const columns = result.columns || [];
							const rows = result.rows || [];
							if (rows.length > 0) {
								const maxRows = Math.min(rows.length, 50);
								const displayRows = rows.slice(0, maxRows);
								queryResultText = `Query results (${rows.length} rows${rows.length > maxRows ? `, showing first ${maxRows}` : ''}):\n`;
								queryResultText += columns.join('\t') + '\n';
								for (const row of displayRows) {
									queryResultText += row.map((v: any) => {
										if (v === null || v === undefined) return '';
										if (typeof v === 'object') return JSON.stringify(v);
										return String(v);
									}).join('\t') + '\n';
								}
							} else {
								queryResultText = 'Query returned no results.';
							}

							const execEntryId = this.nextHistoryEntryId(boxId);
							history.push({
								type: 'tool-call',
								id: execEntryId,
								callId: tc.callId,
								tool: 'execute_kusto_query',
								args: { query },
								result: queryResultText,
								timestamp: Date.now()
							});

							try {
								this.postMessage({
									type: 'copilotExecutedQuery',
									boxId,
									entryId: execEntryId,
									query,
									resultSummary: rows.length > 0 ? `${rows.length} rows` : 'No results',
									result
								} as any);
							} catch {
								// ignore
							}
							hasOptionalToolCalls = true;
							continue;
						} catch (e) {
							const errMsg = this.getErrorMessage(e);
							
							const execErrEntryId = this.nextHistoryEntryId(boxId);
							history.push({
								type: 'tool-call',
								id: execErrEntryId,
								callId: tc.callId,
								tool: 'execute_kusto_query',
								args: { query },
								result: `Query execution error: ${errMsg}`,
								timestamp: Date.now()
							});
							
							try {
								this.postMessage({
									type: 'copilotExecutedQuery',
									boxId,
									entryId: execErrEntryId,
									query,
									resultSummary: 'Error',
									errorMessage: errMsg
								} as any);
							} catch {
								// ignore
							}
							hasOptionalToolCalls = true;
							continue;
						}
					}

					if (toolName === 'search_cached_schemas') {
						const rawPattern = String((tc.input as any)?.pattern || '').trim();
						if (!rawPattern) {
							const errEntryId = this.nextHistoryEntryId(boxId);
							history.push({
								type: 'tool-call',
								id: errEntryId,
								callId: tc.callId,
								tool: 'search_cached_schemas',
								args: tc.input,
								result: 'Error: pattern argument was empty. Please provide a non-empty regex pattern.',
								timestamp: Date.now()
							});
							hasOptionalToolCalls = true;
							continue;
						}

						try {
							const searchMatches = await searchCachedSchemas(this.context.globalStorageUri, rawPattern);
							let resultText: string;
							if (searchMatches.length === 0) {
								resultText = `No matches found for pattern: ${rawPattern}`;
							} else {
								resultText = `Found ${searchMatches.length} match${searchMatches.length === 1 ? '' : 'es'} for pattern "${rawPattern}":\n`;
								resultText += JSON.stringify(searchMatches, null, 2);
							}

							const label = searchMatches.length === 0
								? `No matches for "${rawPattern}"`
								: `${searchMatches.length} match${searchMatches.length === 1 ? '' : 'es'} for "${rawPattern}"`;

							const searchEntryId = this.nextHistoryEntryId(boxId);
							history.push({
								type: 'tool-call',
								id: searchEntryId,
								callId: tc.callId,
								tool: 'search_cached_schemas',
								args: { pattern: rawPattern },
								result: resultText,
								timestamp: Date.now()
							});

							try {
								this.postMessage({
									type: 'copilotWriteQueryToolResult',
									boxId,
									entryId: searchEntryId,
									tool: 'search_cached_schemas',
									label,
									json: resultText
								} as any);
							} catch {
								// ignore
							}
						} catch (e) {
							const errMsg = this.getErrorMessage(e);
							const searchErrEntryId = this.nextHistoryEntryId(boxId);
							history.push({
								type: 'tool-call',
								id: searchErrEntryId,
								callId: tc.callId,
								tool: 'search_cached_schemas',
								args: { pattern: rawPattern },
								result: `Search error: ${errMsg}`,
								timestamp: Date.now()
							});

							try {
								this.postMessage({
									type: 'copilotWriteQueryToolResult',
									boxId,
									entryId: searchErrEntryId,
									tool: 'search_cached_schemas',
									label: `Search failed: ${errMsg}`,
									json: `Search error: ${errMsg}`
								} as any);
							} catch {
								// ignore
							}
						}
						hasOptionalToolCalls = true;
						continue;
					}

					if (toolName === 'respond_to_query_performance_optimization_request') {
						const rawQuery = this.extractQueryArgument(tc.input);
						const improvedQuery = this.extractKustoCodeBlock(rawQuery).trim();
						if (!improvedQuery) {
							priorAttempts.push({ attempt, error: 'Tool call was missing a non-empty query argument.' });
							postStatus('Tool call missing query argument. Retrying…');
							shouldRetryAttempt = true;
							break;
						}

						// Scenario #2: Two-layer retry logic.
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
							const queryWithMode = this.appendQueryMode(queryText, copilotQueryMode);
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

								// Use native tool calling for the fix prompt too
								postStatus('Query failed to execute. Asking Copilot to try again…');
								const fixTool: vscode.LanguageModelChatTool = {
									name: 'respond_to_query_performance_optimization_request',
									description: 'Provide the fixed optimized query.',
									inputSchema: {
										type: 'object',
										properties: {
											query: { type: 'string', description: 'The complete fixed KQL query.' }
										},
										required: ['query']
									}
								};
								const fixMessages = [
									vscode.LanguageModelChatMessage.User(
										'Role: You are a senior Kusto Query Language (KQL) engineer.\n\n' +
										'Task: Produce an optimized version of the original query that is functionally equivalent, but MUST execute successfully.\n\n' +
										`Cluster: ${String(connection.clusterUrl || '')}\n` +
										`Database: ${database}\n\n` +
										'Original query:\n```kusto\n' + originalQueryForCompare + '\n```\n\n' +
										'Candidate optimized query (failed):\n```kusto\n' + candidate + '\n```\n\n' +
										'Execution error:\n' + lastExecErrorText + '\n\n' +
										'Use the respond_to_query_performance_optimization_request tool to provide your fixed query.'
									)
								];

								const fixResponse = await model.sendRequest(
									fixMessages,
									{ tools: [fixTool], toolMode: vscode.LanguageModelChatToolMode.Required },
									cts.token
								);
								let fixedQuery = '';
								for await (const fixPart of fixResponse.stream) {
									if (!isActive() || cts.token.isCancellationRequested) {
										throw new Error('Copilot write-query canceled');
									}
									if (fixPart instanceof vscode.LanguageModelToolCallPart) {
										const rawQ = this.extractQueryArgument(fixPart.input);
										fixedQuery = this.extractKustoCodeBlock(rawQ).trim();
									}
								}
								if (fixedQuery) {
									candidate = fixedQuery;
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
					}

					if (toolName === 'respond_to_all_other_queries') {
						const rawQuery = this.extractQueryArgument(tc.input);
						const query = this.extractKustoCodeBlock(rawQuery).trim();
						if (!query) {
							priorAttempts.push({ attempt, error: 'Tool call was missing a non-empty query argument.' });
							postStatus('Tool call missing query argument. Retrying…');
							shouldRetryAttempt = true;
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

						this.cancelRunningQuery(boxId);
						const queryWithMode = this.appendQueryMode(query, copilotQueryMode);
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
								// Reset the executing spinner but don't send queryCancelled —
								// the copilotWriteQueryDone 'Canceled.' notification handles it.
								if (isActive()) {
									try {
										this.postMessage({ type: 'copilotWriteQueryExecuting', boxId, executing: false } as any);
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
							shouldRetryAttempt = true;
							break;
						}
					}

					if (toolName === 'update_development_note') {
						const args = (tc.input && typeof tc.input === 'object') ? tc.input as any : {};
						const content = String(args.content || '').trim();
						const noteId = args.noteId ? String(args.noteId).trim() : '';
						const category = String(args.category || 'usage-note').trim();
						let toolResult: string;
						let effectiveAction: 'save' | 'remove';

						if (!content && noteId) {
							// Empty content + noteId = remove
							effectiveAction = 'remove';
							this.postMessage({
								type: 'updateDevNotes',
								action: 'remove',
								noteId
							} as any);
							toolResult = `Development note removed (id: ${noteId}).`;
						} else if (!content) {
							toolResult = 'Error: content is required when creating a new note. To remove an existing note, provide its noteId with empty content.';
							effectiveAction = 'save';
						} else {
							// Create or update (noteId provided = supersede the old note)
							effectiveAction = 'save';
							const newNoteId = 'devnote_' + Date.now();
							const now = new Date().toISOString();
							const entry = {
								id: newNoteId,
								created: now,
								updated: now,
								category,
								content,
								source: 'copilot',
								...(Array.isArray(args.relatedSectionIds) && args.relatedSectionIds.length > 0 ? { relatedSectionIds: args.relatedSectionIds } : {})
							};
							this.postMessage({
								type: 'updateDevNotes',
								action: noteId ? 'supersede' : 'add',
								entry,
								supersededId: noteId || undefined
							} as any);
							toolResult = `Development note saved (id: ${newNoteId}, category: ${category}).` +
								(noteId ? ` Superseded note: ${noteId}.` : '');
						}

						const noteEntryId = this.nextHistoryEntryId(boxId);
						history.push({
							type: 'tool-call',
							id: noteEntryId,
							callId: tc.callId,
							tool: 'update_development_note',
							args: { noteId, category, content },
							result: toolResult,
							timestamp: Date.now()
						});
						try {
							this.postMessage({
								type: 'copilotDevNoteToolCall',
								boxId,
								entryId: noteEntryId,
								action: effectiveAction,
								category,
								content: content || noteId,
								result: toolResult
							} as any);
						} catch { /* ignore */ }
						continue;
					}

					if (toolName === 'ask_user_clarifying_question') {
						const question = this.extractQuestionArgument(tc.input);
						if (!question) {
							priorAttempts.push({ attempt, error: 'Tool call was missing a non-empty question argument.' });
							postStatus('Tool call missing question argument. Retrying…');
							shouldRetryAttempt = true;
							break;
						}

						// Add the clarifying question to conversation history
						const questionEntryId = this.nextHistoryEntryId(boxId);
						history.push({
							type: 'tool-call',
							id: questionEntryId,
							callId: tc.callId,
							tool: 'ask_user_clarifying_question',
							args: { question },
							result: 'Question displayed to user. Awaiting response.',
							timestamp: Date.now()
						});

						try {
							this.postMessage({
								type: 'copilotClarifyingQuestion',
								boxId,
								entryId: questionEntryId,
								question
							} as any);
						} catch {
							// ignore
						}

						vscode.window.showInformationMessage(
							'Kusto Copilot has a clarifying question for you.',
							'View'
						).then(selection => {
							if (selection === 'View') {
								this.panel?.reveal(vscode.ViewColumn.One);
							}
						});

						this.postMessage({
							type: 'copilotWriteQueryDone',
							boxId,
							ok: true,
							message: ''
						} as any);
						return;
					}
				} // End of for (const tc of nativeToolCalls)
				} finally {
					// Guarantee every tool_use in the assistant message gets a tool_result
					// in the conversation history. Without this, retries/returns can leave
					// orphaned tool_use entries which cause 400 errors from the LLM API.
					this.ensureAllToolCallsHaveResults(history, nativeToolCalls, boxId);
				}

				if (shouldRetryAttempt) {
					continue;
				}

				if (hasOptionalToolCalls) {
					// Optional tool calls were processed; loop back for the next LLM turn
					toolTurnCount++;
					if (toolTurnCount >= maxToolTurns) {
						priorAttempts.push({ attempt, error: 'Too many tool turns without a final response.' });
						postStatus('Too many tool turns. Retrying…');
						continue;
					}
					// Decrement attempt counter since this wasn't a failure, just a tool turn
					attempt--;
					continue;
				}
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
				.filter(m => !!m.id)
				.sort((a, b) => a.label.localeCompare(b.label));

			const lastModelId = this.context.globalState.get<string>(STORAGE_KEYS.lastOptimizeCopilotModelId);
			const preferredModelId = String(lastModelId || '').trim();
			const defaultModelId = findPreferredDefaultCopilotModel(models)?.id || '';
			const selectedModelId = preferredModelId && modelOptions.some(m => m.id === preferredModelId)
				? preferredModelId
				: defaultModelId;

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
				model = findPreferredDefaultCopilotModel(models)!;
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
		// Persist clusterUrl and database in the cache file so enumeration can
		// identify schemas without needing to reverse the SHA1 filename hash.
		const pipeIdx = cacheKey.indexOf('|');
		const enriched: CachedSchemaEntry = {
			...entry,
			clusterUrl: entry.clusterUrl ?? (pipeIdx >= 0 ? cacheKey.slice(0, pipeIdx) : undefined),
			database: entry.database ?? (pipeIdx >= 0 ? cacheKey.slice(pipeIdx + 1) : undefined)
		};
		const json = JSON.stringify(enriched);
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
		const autoTriggerAutocompleteEnabledStored = this.context.globalState.get<boolean>(STORAGE_KEYS.autoTriggerAutocompleteEnabled);
		const autoTriggerAutocompleteEnabled = typeof autoTriggerAutocompleteEnabledStored === 'boolean' ? autoTriggerAutocompleteEnabledStored : true;
		const autoTriggerAutocompleteEnabledUserSet = typeof autoTriggerAutocompleteEnabledStored === 'boolean';

		// Automatically trigger Copilot inline completions: check both our extension setting and VS Code's global inline suggest setting
		const copilotInlineCompletionsEnabledStored = this.context.globalState.get<boolean>(STORAGE_KEYS.copilotInlineCompletionsEnabled);
		// Default to following VS Code's editor.inlineSuggest.enabled setting
		const vscodeInlineSuggestEnabled = vscode.workspace.getConfiguration('editor').get<boolean>('inlineSuggest.enabled', true);
		// Our setting defaults to matching VS Code's setting (if user hasn't explicitly set it)
		const copilotInlineCompletionsEnabled = typeof copilotInlineCompletionsEnabledStored === 'boolean'
			? copilotInlineCompletionsEnabledStored
			: vscodeInlineSuggestEnabled;
		const copilotInlineCompletionsEnabledUserSet = typeof copilotInlineCompletionsEnabledStored === 'boolean';

		const favorites = this.getFavorites();
		const leaveNoTraceClusters = this.connectionManager.getLeaveNoTraceClusters();
		this.postMessage({
			type: 'connectionsData',
			connections,
			lastConnectionId: this.lastConnectionId,
			lastDatabase: this.lastDatabase,
			cachedDatabases,
			favorites,
			caretDocsEnabled,
			caretDocsEnabledUserSet,
			autoTriggerAutocompleteEnabled,
			autoTriggerAutocompleteEnabledUserSet,
			copilotInlineCompletionsEnabled,
			copilotInlineCompletionsEnabledUserSet,
			leaveNoTraceClusters,
			devNotesEnabled: true,
			copilotChatFirstTimeDismissed: !!this.context.globalState.get<boolean>(STORAGE_KEYS.copilotChatFirstTimeDismissed)
		});
	}

	/**
	 * Best-effort inference for plain `.kql/.csl` files (no embedded cluster/db metadata):
	 *
	 * - Extract table + function identifiers from the query
	 * - Compare against *cached* schemas we can locate via cached database lists
	 * - Pick the (clusterUrl, database) with the highest match score
	 */
	public async inferClusterDatabaseForKqlQuery(
		queryText: string
	): Promise<{ clusterUrl: string; database: string } | undefined> {
		const text = String(queryText ?? '').trim();
		if (!text) {
			return undefined;
		}

		const tokens = extractKqlSchemaMatchTokens(text);
		if (!tokens.allNamesLower.size) {
			return undefined;
		}

		const favorites = this.getFavorites();
		const favoriteKeys = new Set<string>();
		for (const f of favorites) {
			try {
				favoriteKeys.add(this.favoriteKey(f.clusterUrl, f.database));
			} catch {
				// ignore
			}
		}

		const cachedDatabases = this.getCachedDatabases();
		const connections = this.connectionManager.getConnections();

		// Avoid worst-case blowups when users have large cached DB lists.
		const MAX_CANDIDATES = 300;
		let candidatesSeen = 0;

		let best:
			| { clusterUrl: string; database: string; score: number; isFavorite: boolean }
			| undefined;

		for (const conn of connections) {
			const clusterUrl = String(conn?.clusterUrl || '').trim();
			if (!clusterUrl) continue;
			const clusterKey = this.getClusterCacheKey(clusterUrl);
			const dbList = (cachedDatabases && clusterKey && cachedDatabases[clusterKey]) ? cachedDatabases[clusterKey] : [];
			if (!Array.isArray(dbList) || dbList.length === 0) continue;

			for (const dbRaw of dbList) {
				if (candidatesSeen >= MAX_CANDIDATES) break;
				const database = String(dbRaw || '').trim();
				if (!database) continue;
				candidatesSeen++;

				const cacheKey = `${clusterUrl}|${database}`;
				const cached = await this.getCachedSchemaFromDisk(cacheKey);
				const schema = cached?.schema;
				if (!schema) continue;

				const score = scoreSchemaMatch(tokens, schema);
				if (score <= 0) continue;

				const isFavorite = favoriteKeys.has(this.favoriteKey(clusterUrl, database));

				if (!best) {
					best = { clusterUrl, database, score, isFavorite };
					continue;
				}

				if (score > best.score) {
					best = { clusterUrl, database, score, isFavorite };
					continue;
				}
				if (score === best.score) {
					// Tie-breaker: prefer favorites (UX), then stable sort by cluster/db.
					if (isFavorite && !best.isFavorite) {
						best = { clusterUrl, database, score, isFavorite };
						continue;
					}
					if (isFavorite === best.isFavorite) {
						const a = `${clusterUrl.toLowerCase()}|${database.toLowerCase()}`;
						const b = `${best.clusterUrl.toLowerCase()}|${best.database.toLowerCase()}`;
						if (a < b) {
							best = { clusterUrl, database, score, isFavorite };
						}
					}
				}
			}

			if (candidatesSeen >= MAX_CANDIDATES) break;
		}

		if (!best) {
			return undefined;
		}
		return { clusterUrl: best.clusterUrl, database: best.database };
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

		// If we have cached data and this is NOT a force refresh, return cached data immediately
		// without making a network call. This prevents network timeouts when offline (e.g., VPN disconnected)
		// while still providing a good UX with cached data showing instantly.
		if (!forceRefresh && cachedBefore.length > 0) {
			this.postMessage({ type: 'databasesData', databases: cachedBefore, boxId, connectionId });
			return;
		}

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
				this.postMessage({ type: 'databasesData', databases, boxId, connectionId });
				return;
			}

			// Empty refresh result but we have cached data - send cached data and notify user
			this.postMessage({ type: 'databasesData', databases: cachedBefore, boxId, connectionId });
			void vscode.window.showWarningMessage(
				`Couldn't refresh the database list (received 0 databases). Using cached list.`,
				'More Info'
			).then(selection => {
				if (selection === 'More Info') {
					void vscode.window.showInformationMessage(
						`If you expected databases here, try refreshing again and sign in with a different account.`,
						{ modal: true }
					);
				}
			});
		} catch (error) {
			// Auth recovery:
			// - On explicit refresh: retry with interactive auth (existing behavior).
			// - On initial load (not refresh): if there is no cached list, still prompt once so the user can recover.
			const isAuthErr = this.kustoClient.isAuthenticationError(error);
			if (isAuthErr && !forceRefresh && cachedBefore.length > 0) {
				// Keep the editor usable by showing the last known list, but guide the user to re-auth via notification.
				this.postMessage({ type: 'databasesData', databases: cachedBefore, boxId, connectionId });
				void vscode.window.showWarningMessage(
					`Couldn't refresh the database list due to an authentication error. Using cached list.`,
					'More Info'
				).then(selection => {
					if (selection === 'More Info') {
						void vscode.window.showInformationMessage(
							`Use the refresh button and sign in with the correct account for this cluster.`,
							{ modal: true }
						);
					}
				});
				return;
			}

			// If we hit an auth-related error, try to re-auth interactively and retry once.
			if ((forceRefresh || cachedBefore.length === 0) && isAuthErr) {
				try {
					await this.kustoClient.reauthenticate(connection, 'clearPreference');
					const databases = await fetchAndNormalize();
					await this.saveCachedDatabases(connectionId, databases);
					this.postMessage({ type: 'databasesData', databases, boxId, connectionId });
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
							this.postMessage({ type: 'databasesData', databases, boxId, connectionId });
							return;
						}
						if (choice === 'Add account') {
							await this.kustoClient.reauthenticate(connection, 'forceNewSession');
							const databases = await fetchAndNormalize();
							await this.saveCachedDatabases(connectionId, databases);
							this.postMessage({ type: 'databasesData', databases, boxId, connectionId });
							return;
						}
					} catch {
						// fall through to error UI
					}
				}
			}

			const userMessage = this.formatQueryExecutionErrorForUser(error, connection);
			const action = forceRefresh ? 'refresh' : 'load';

			// If we have cached data, use it and show a notification instead of inline error
			if (cachedBefore.length > 0) {
				this.postMessage({ type: 'databasesData', databases: cachedBefore, boxId, connectionId });
				void vscode.window.showWarningMessage(
					`Failed to ${action} database list. Using cached list.`,
					'More Info'
				).then(selection => {
					if (selection === 'More Info') {
						void vscode.window.showInformationMessage(userMessage, { modal: true });
					}
				});
				return;
			}

			// No cached data - show VS Code error notification and send error to webview for UI state
			void vscode.window.showErrorMessage(`Failed to ${action} database list.`, 'More Info').then(selection => {
				if (selection === 'More Info') {
					void vscode.window.showInformationMessage(userMessage, { modal: true });
				}
			});
			this.postMessage({
				type: 'databasesError',
				boxId,
				connectionId,
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
		// Control commands (starting with '.') should not have cache directives prepended
		const isControl = this.isControlCommand(message.query);
		const cacheDirective = isControl ? '' : this.buildCacheDirective(message.cacheEnabled, message.cacheValue, message.cacheUnit);
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
				const clientActivityId = error instanceof QueryExecutionError ? error.clientActivityId : undefined;
				vscode.window.showErrorMessage(userMessage);
				this.postMessage({ type: 'queryError', error: userMessage, boxId, clientActivityId });
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

	/**
	 * Checks if a query is a Kusto control command (starts with '.').
	 * Control commands like `.show function`, `.show databases`, etc. cannot
	 * have operators like `| take 100` appended to them.
	 */
	private isControlCommand(query: string): boolean {
		const trimmed = (query ?? '').replace(/^\s+/, '');
		// Skip leading comments
		let i = 0;
		while (i < trimmed.length) {
			// Skip whitespace
			while (i < trimmed.length && /\s/.test(trimmed[i])) i++;
			if (i >= trimmed.length) return false;
			// Skip line comments
			if (trimmed[i] === '/' && trimmed[i + 1] === '/') {
				const nl = trimmed.indexOf('\n', i + 2);
				if (nl < 0) return false;
				i = nl + 1;
				continue;
			}
			// Skip block comments
			if (trimmed[i] === '/' && trimmed[i + 1] === '*') {
				const end = trimmed.indexOf('*/', i + 2);
				if (end < 0) return false;
				i = end + 2;
				continue;
			}
			// Check if first non-comment character is a dot
			return trimmed[i] === '.';
		}
		return false;
	}

	private appendQueryMode(query: string, queryMode?: string): string {
		// Control commands (starting with '.') cannot have operators appended
		if (this.isControlCommand(query)) {
			return query;
		}

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
					clusterUrl: connection.clusterUrl,
					requestToken,
					schema,
					schemaMeta: {
						fromCache: true,
						cacheAgeMs: cachedAgeMs,
						tablesCount,
						columnsCount,
						functionsCount: schema.functions?.length ?? 0
					}
				});
				return;
			}

			// If we have cached data (even if stale or outdated version) and this is NOT a force refresh,
			// return the cached data immediately without making a network call.
			// This prevents network timeouts when offline (e.g., VPN disconnected).
			if (!forceRefresh && cached) {
				const schema = cached.schema;
				const tablesCount = schema.tables?.length ?? 0;
				const columnsCount = countColumns(schema);

				this.output.appendLine(
					`[schema] loaded (persisted cache, stale/outdated) db=${database} tables=${tablesCount} columns=${columnsCount}`
				);
				this.postMessage({
					type: 'schemaData',
					boxId,
					connectionId,
					database,
					clusterUrl: connection.clusterUrl,
					requestToken,
					schema,
					schemaMeta: {
						fromCache: true,
						cacheAgeMs: cachedAgeMs,
						tablesCount,
						columnsCount,
						functionsCount: schema.functions?.length ?? 0
					}
				});
				return;
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
				clusterUrl: connection.clusterUrl,
				requestToken,
				schema,
				schemaMeta: {
					fromCache: result.fromCache,
					cacheAgeMs: result.cacheAgeMs,
					tablesCount,
					columnsCount,
					functionsCount: schema.functions?.length ?? 0,
					debug: result.debug,
					forceRefresh
				}
			});
		} catch (error) {
			const rawMessage = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`[schema] error db=${database}: ${rawMessage}`);

			// If we have any cached schema (even stale), keep using it for autocomplete.
			// For a user-initiated refresh we still show an error message, but we don't wipe the cache.
			const userMessage = this.formatQueryExecutionErrorForUser(error, connection, database);
			try {
				const cached = await this.getCachedSchemaFromDisk(cacheKey);
				if (cached && cached.schema) {
					const schema = cached.schema;
					const tablesCount = schema.tables?.length ?? 0;
					const columnsCount = countColumns(schema);
					const hasRawSchemaJson = !!schema.rawSchemaJson;

					this.output.appendLine(
						`[schema] using cached schema after failure db=${database} tables=${tablesCount} columns=${columnsCount} hasRawSchemaJson=${hasRawSchemaJson}`
					);
					this.postMessage({
						type: 'schemaData',
						boxId,
						connectionId,
						database,
						clusterUrl: connection.clusterUrl,
						requestToken,
						schema,
						schemaMeta: {
							fromCache: true,
							cacheAgeMs: Date.now() - cached.timestamp,
							tablesCount,
							columnsCount,
							functionsCount: schema.functions?.length ?? 0,
							// Indicate this is a fallback after a failed refresh
							isFailoverToCache: true,
							hasRawSchemaJson
						}
					});

					// Always show a VS Code notification when we fail to refresh schema (even for automatic refreshes).
					// This helps users understand why autocomplete might not be working optimally.
					const notificationMessage = hasRawSchemaJson
						? `Failed to refresh schema for ${database}. Using cached schema for autocomplete.`
						: `Failed to refresh schema for ${database}. Cached schema is outdated and autocomplete may not work.`;
					void vscode.window.showWarningMessage(notificationMessage, 'More Info').then(selection => {
						if (selection === 'More Info') {
							void vscode.window.showInformationMessage(userMessage, { modal: true });
						}
					});

					// Note: We don't send a schemaError message here since we successfully fell back to cached schema.
					// The VS Code notification is sufficient, and the schema summary already shows the appropriate status.
					return;
				}
			} catch {
				// ignore and fall through to posting schemaError
			}

			const action = forceRefresh ? 'refresh' : 'load';
			// Show VS Code notification for total failure (no cache available)
			void vscode.window.showErrorMessage(`Failed to ${action} schema for ${database}.`, 'More Info').then(selection => {
				if (selection === 'More Info') {
					void vscode.window.showInformationMessage(userMessage, { modal: true });
				}
			});
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

	/**
	 * Handle cross-cluster schema requests from the webview.
	 * When the user references cluster('X').database('Y') in a query,
	 * monaco-kusto needs the schema for that database to provide autocomplete.
	 */
	private async handleCrossClusterSchemaRequest(
		clusterName: string,
		database: string,
		boxId: string,
		requestToken: string
	): Promise<void> {
		// Normalize the cluster name to a URL
		let clusterUrl = clusterName.trim();
		if (clusterUrl && !clusterUrl.includes('.')) {
			// If it's a short name like 'help', assume Azure Data Explorer pattern
			clusterUrl = `https://${clusterUrl}.kusto.windows.net`;
		} else if (clusterUrl && !clusterUrl.startsWith('https://') && !clusterUrl.startsWith('http://')) {
			clusterUrl = `https://${clusterUrl}`;
		}

		// Find a connection that matches this cluster URL
		const connections = this.connectionManager.getConnections();
		
		const connection = connections.find(c => {
			const connUrl = String(c.clusterUrl || '').trim().toLowerCase();
			const targetUrl = clusterUrl.toLowerCase();
			// Match by exact URL or by hostname
			if (connUrl === targetUrl) { return true; }
			try {
				const connHostname = new URL(connUrl.startsWith('http') ? connUrl : `https://${connUrl}`).hostname;
				const targetHostname = new URL(targetUrl).hostname;
				return connHostname === targetHostname;
			} catch {
				return false;
			}
		});

		if (!connection) {
			this.postMessage({
				type: 'crossClusterSchemaError',
				clusterName,
				database,
				boxId,
				requestToken,
				error: `No connection available for cluster "${clusterName}". Add a connection to get autocomplete support.`
			});
			return;
		}

		try {
			const cacheKey = `${connection.clusterUrl}|${database}`;

			// Try to load from cache first
			const cached = await this.getCachedSchemaFromDisk(cacheKey);
			const cachedAgeMs = cached ? Date.now() - cached.timestamp : undefined;
			const cachedIsFresh = !!(cached && typeof cachedAgeMs === 'number' && cachedAgeMs < this.SCHEMA_CACHE_TTL_MS);

			if (cached && cachedIsFresh && cached.schema.rawSchemaJson) {
				this.postMessage({
					type: 'crossClusterSchemaData',
					clusterName,
					clusterUrl: connection.clusterUrl,
					database,
					boxId,
					requestToken,
					rawSchemaJson: cached.schema.rawSchemaJson
				});
				return;
			}

			// If we have stale cached data with rawSchemaJson, use it instead of making a network call
			// This prevents network timeouts when offline (e.g., VPN disconnected)
			if (cached && cached.schema.rawSchemaJson) {
				this.postMessage({
					type: 'crossClusterSchemaData',
					clusterName,
					clusterUrl: connection.clusterUrl,
					database,
					boxId,
					requestToken,
					rawSchemaJson: cached.schema.rawSchemaJson
				});
				return;
			}

			// Fetch fresh schema
			const result = await this.kustoClient.getDatabaseSchema(connection, database, false);
			const schema = result.schema;

			// Cache the result
			const timestamp = result.fromCache
				? Date.now() - (result.cacheAgeMs ?? 0)
				: Date.now();
			await this.saveCachedSchemaToDisk(cacheKey, { schema, timestamp, version: SCHEMA_CACHE_VERSION });

			if (schema.rawSchemaJson) {
				this.postMessage({
					type: 'crossClusterSchemaData',
					clusterName,
					clusterUrl: connection.clusterUrl,
					database,
					boxId,
					requestToken,
					rawSchemaJson: schema.rawSchemaJson
				});
			} else {
				this.postMessage({
					type: 'crossClusterSchemaError',
					clusterName,
					database,
					boxId,
					requestToken,
					error: `Schema loaded but missing raw format required for autocomplete.`
				});
			}
		} catch (error) {
			const rawMessage = error instanceof Error ? error.message : String(error);
			const userMessage = this.formatQueryExecutionErrorForUser(error, connection, database);
			this.postMessage({
				type: 'crossClusterSchemaError',
				clusterName,
				database,
				boxId,
				requestToken,
				error: `Failed to load schema for ${clusterName}.${database}.\n${userMessage}`
			});
		}
	}

	// HTML rendering moved to src/queryEditorHtml.ts
}
