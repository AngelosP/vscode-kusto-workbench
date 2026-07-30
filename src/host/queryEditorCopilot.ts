import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ConnectionManager, KustoConnection } from './connectionManager';
import { KustoQueryClient } from './kustoClient';
import type { SqlConnectionManager } from './sqlConnectionManager';
import type { SqlSchemaService } from './sqlEditorSchema';
import type { SqlQueryClient } from './sqlClient';
import { SqlQueryCancelledError } from './sqlClient';
import { formatQueryResultForCopilot } from './copilotResultPreview';
import { sanitizeStsLogText } from './sql/stsLogSanitizer';
import type { SqlExecutionBroker } from './sql/sqlExecutionBroker';
import { SqlLeaveNoTraceBlockedError } from './sql/sqlLeaveNoTrace';
import { ConversationHistoryEntry, sanitizeConversationHistory, insertMissingToolCallResults, decideNonToolResponse, groupConversationHistoryForProvider, type ToolCallHistoryEntry } from './copilotConversationUtils';
import { schemaCacheKey, schemaPrincipalIdentity, searchCachedSchemas } from './schemaCache';
import { kustoDatabaseKey } from '../shared/kustoClusterUrls';
import { getKustoConnectionIdentityKey } from '../shared/kustoAuth';
import { countColumns, formatSchemaAsCompactText, formatSchemaWithTokenBudget, DEFAULT_SCHEMA_TOKEN_BUDGET_FRACTION, PRUNE_PHASE_DESCRIPTIONS, SchemaPruneResult } from './schemaIndexUtils';
import {
	STORAGE_KEYS,
	CachedSchemaEntry,
	CacheUnit,
	CopilotLocalTool,
	StartCopilotWriteQueryMessage,
	OptimizeQueryMessage,
	IncomingWebviewMessage,
	findPreferredDefaultCopilotModel
} from './queryEditorTypes';
import {
	getCopilotLocalTools as getCopilotLocalToolsFn,
	getSqlCopilotLocalTools as getSqlCopilotLocalToolsFn,
	buildOptimizeQueryPrompt as buildOptimizeQueryPromptFn
} from './copilotPromptUtils';
import { getCopilotFlavorById, type CopilotChatFlavor } from './copilotChatFlavor';
import { openKustoWorkbenchAgentChat } from './copilotChatOpenUtils';
import { convertKustoFunctionDefinitionsToInline } from '../shared/kustoFunctionDefinitions';
import type { WorkbenchLogger } from './workbenchLogger';
import type { KustoComparisonRunIdentity, KustoCopilotRequestIdentity, KustoDispatchIdentity, KustoExecutionProducer, KustoOptimizeRequestIdentity, KustoSectionExecutionOutcome, KustoSectionExecutionTarget, PreparedComparisonSection } from '../shared/kustoExecution.js';
import { hasKustoOptimizeRequestIdentity, kustoCopilotRequestIdentityEquals, kustoOptimizeRequestIdentityEquals } from '../shared/kustoExecution.js';

export const SQL_COPILOT_OWNER_CHANGED_MESSAGE = 'SQL section owner changed. Retry the request.';

/**
 * Interface that the CopilotService uses to call back into the host (QueryEditorProvider).
 */
export interface CopilotServiceHost {
	readonly extensionUri: vscode.Uri;
	readonly context: vscode.ExtensionContext;
	readonly kustoClient: KustoQueryClient;
	readonly connectionManager: ConnectionManager;
	readonly output: WorkbenchLogger;
	readonly sqlExecutionBroker: SqlExecutionBroker;

	postMessage(message: unknown): void | boolean | Thenable<boolean>;
	postKustoPublication(message: unknown): Promise<boolean>;
	findConnection(connectionId: string): KustoConnection | undefined;
	getErrorMessage(error: unknown): string;
	formatQueryExecutionErrorForUser(error: unknown, connection: KustoConnection, db?: string): string;
	logQueryExecutionError(error: unknown, connection: KustoConnection, db: string | undefined, boxId: string, query: string): void;
	normalizeClusterUrlKey(url: string): string;

	getKustoSectionExecutionTarget(boxId: string): KustoSectionExecutionTarget | undefined;
	executeKustoSectionQuery(options: {
		target: KustoSectionExecutionTarget;
		executionId: string;
		producer: KustoExecutionProducer;
		comparisonRun?: KustoComparisonRunIdentity;
		copilotRequestId?: string;
		query: string;
		queryMode?: string;
		cacheEnabled?: boolean;
		cacheValue?: number;
		cacheUnit?: CacheUnit | string;
		ensureResultsVisible?: boolean;
	}): Promise<KustoSectionExecutionOutcome<import('./kustoClient.js').QueryResult>>;
	cancelKustoSectionExecution(target: KustoSectionExecutionTarget, executionId: string): boolean;
	getKustoSectionExecutionAccountPartition(target: KustoSectionExecutionTarget, executionId: string): string | undefined;
	getCurrentKustoConnectionForDispatch(connectionId: string, dispatch: KustoDispatchIdentity): KustoConnection | undefined;
	refreshConnectionsData?(): Promise<void>;
	refreshSqlConnectionsData?(): Promise<void>;
	assertSqlConnectionAllowed(connectionId: string): Promise<void>;
	dispatchSqlConnectionAllowed<T>(connectionId: string, dispatch: () => T | PromiseLike<T>): Promise<T>;
	dispatchSqlResultOwnerAllowed<T>(boxId: string, expectedOwner: SqlResultOwner, dispatch: () => T | PromiseLike<T>): Promise<T>;
	getSqlResultOwner(boxId: string): SqlResultOwner | undefined;
	assertSqlResultOwnerAllowed(boxId: string, expectedOwner: SqlResultOwner): Promise<void>;

	isControlCommand(query: string): boolean;
	appendQueryMode(query: string, mode?: string): string;
	normalizeControlCommandForExecution(query: string): string;
	buildCacheDirective(enabled?: boolean, value?: number, unit?: CacheUnit | string): string | undefined;

	getCachedSchemaFromDisk(cacheKey: string): Promise<CachedSchemaEntry | undefined>;
	saveCachedSchemaToDisk(key: string, entry: CachedSchemaEntry): Promise<void>;

	ensureComparisonBoxInWebview(sourceBoxId: string, query: string, token: vscode.CancellationToken, copilotSequence?: number, kustoRequest?: KustoCopilotRequestIdentity): Promise<PreparedComparisonSection>;
	waitForComparisonSummary(sourceBoxId: string, comparisonBoxId: string, token: vscode.CancellationToken): Promise<{ dataMatches: boolean; headersMatch: boolean }>;
	deleteComparisonSummary(key: string): void;

	requestSectionsFromWebview(): Promise<unknown[] | undefined>;
	revealPanel(): void;
}

export type SqlResultOwner = Readonly<{
	connectionId: string;
	database: string;
	generation: number;
	targetSignature: string;
	principalFingerprint: string;
	revocationGeneration: number;
}>;

type RunningCopilotWriteQuery = {
	cts: vscode.CancellationTokenSource;
	seq: number;
	kustoRequest?: KustoCopilotRequestIdentity;
	queryCancels: Set<() => void>;
	queryCancelsByTargetBoxId: Map<string, Set<() => void>>;
	kustoAccountPartitionGetters: Set<() => string | undefined>;
	kustoFinalRun?: { target: KustoSectionExecutionTarget; executionId: string; getAccountPartition: () => string | undefined };
	sqlFinalRun?: { isCurrent: () => boolean; settleExecution: () => void };
	cleanupCurrentToolTurn?: () => void;
	cleanupCurrentRequestHistory?: () => void;
};

type RunningOptimizeQuery = {
	owner: KustoOptimizeRequestIdentity;
	target: KustoSectionExecutionTarget;
	query: string;
	connectionIdentityKey: string;
	connectionRevision: number;
	clusterEndpoint: string;
	accountPartition?: string;
	leaveNoTraceRevision: number;
	cts: vscode.CancellationTokenSource;
};

type CopilotConversationOwner = {
	flavor: 'kusto' | 'sql';
	connectionId: string;
	kustoRequest?: KustoCopilotRequestIdentity;
	database?: string;
	generation?: number;
	targetSignature?: string;
	principalFingerprint?: string;
	accountPartition?: string;
};

class CopilotExecutionQueryError extends Error {
	readonly originalError: unknown;
	readonly executionQuery: string;
	readonly isCancelled?: boolean;

	constructor(error: unknown, executionQuery: string) {
		super(error instanceof Error ? error.message : String(error));
		this.name = error instanceof Error ? error.name : 'CopilotExecutionQueryError';
		this.originalError = error;
		this.executionQuery = executionQuery;
		if ((error as Record<string, unknown>)?.isCancelled === true) {
			this.isCancelled = true;
		}
	}
}

export class CopilotService {
	private copilotWriteSeq = 0;
	private copilotHistoryEntrySeq = 0;
	private readonly runningOptimizeByBoxId = new Map<string, RunningOptimizeQuery>();
	private readonly runningCopilotWriteQueryByBoxId = new Map<string, RunningCopilotWriteQuery>();
	private readonly copilotGeneralRulesSentPerBox = new Set<string>();
	private readonly copilotDevNotesSentPerBox = new Set<string>();
	private readonly copilotConversationHistoryByBoxId = new Map<string, ConversationHistoryEntry[]>();
	private readonly copilotConversationOwnerByBoxId = new Map<string, CopilotConversationOwner>();
	private readonly copilotExtendedSchemaCache = new Map<string, { timestamp: number; result: string; label: string }>();
	private readonly SCHEMA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

	// Cache for Copilot model selection — avoids calling selectChatModels() on every inline completion request.
	private _cachedInlineModel: vscode.LanguageModelChat | null = null;
	private _cachedInlineModelAt = 0;
	private readonly runningSqlInlineCompletionByBoxId = new Map<string, { connectionId: string; cts: vscode.CancellationTokenSource }>();
	private static readonly INLINE_MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

	constructor(private readonly host: CopilotServiceHost) {}

	private createRunningCopilotWriteQuery(
		boxId: string,
		cts: vscode.CancellationTokenSource,
		seq: number,
		kustoRequest?: KustoCopilotRequestIdentity,
	): RunningCopilotWriteQuery {
		const running: RunningCopilotWriteQuery = {
			cts,
			seq,
			...(kustoRequest ? { kustoRequest } : {}),
			queryCancels: new Set(),
			queryCancelsByTargetBoxId: new Map(),
			kustoAccountPartitionGetters: new Set(),
		};
		this.runningCopilotWriteQueryByBoxId.set(boxId, running);
		return running;
	}

	private cancelTrackedCopilotQueries(running: RunningCopilotWriteQuery): void {
		for (const cancel of running.queryCancels) {
			try {
				cancel();
			} catch {
				// ignore
			}
		}
		running.queryCancels.clear();
		running.queryCancelsByTargetBoxId?.clear();
	}

	private createOneShotCancel(cancel: () => void): () => void {
		let canceled = false;
		return () => {
			if (canceled) return;
			canceled = true;
			cancel();
		};
	}

	private async postRequiredMessage(message: unknown): Promise<void> {
		const delivered = await Promise.resolve(this.host.postMessage(message));
		if (delivered === false) throw new Error('Copilot write-query canceled');
	}

	private settleOwnedCopilotExecutions(running: RunningCopilotWriteQuery): void {
		const kustoFinalRun = running.kustoFinalRun;
		if (kustoFinalRun) this.host.cancelKustoSectionExecution(kustoFinalRun.target, kustoFinalRun.executionId);
		if (running.sqlFinalRun?.isCurrent()) running.sqlFinalRun.settleExecution();
	}

	private trackCopilotQueryCancel(
		boxId: string,
		cts: vscode.CancellationTokenSource,
		seq: number,
		cancel: () => void,
		getAccountPartition?: () => string | undefined,
		targetBoxId = boxId,
	): () => void {
		const running = this.runningCopilotWriteQueryByBoxId.get(boxId);
		if (!running || running.cts !== cts || running.seq !== seq) {
			return () => { /* inactive run */ };
		}
		running.queryCancels.add(cancel);
		running.queryCancelsByTargetBoxId ??= new Map();
		const targetCancels = running.queryCancelsByTargetBoxId.get(targetBoxId) ?? new Set<() => void>();
		targetCancels.add(cancel);
		running.queryCancelsByTargetBoxId.set(targetBoxId, targetCancels);
		if (getAccountPartition) running.kustoAccountPartitionGetters.add(getAccountPartition);
		return () => {
			running.queryCancels.delete(cancel);
			const currentTargetCancels = running.queryCancelsByTargetBoxId.get(targetBoxId);
			currentTargetCancels?.delete(cancel);
			if (currentTargetCancels?.size === 0) running.queryCancelsByTargetBoxId.delete(targetBoxId);
			if (getAccountPartition) running.kustoAccountPartitionGetters.delete(getAccountPartition);
		};
	}

	getCopilotLocalTools(): CopilotLocalTool[] {
		return getCopilotLocalToolsFn();
	}

	getSqlCopilotLocalTools(): CopilotLocalTool[] {
		return getSqlCopilotLocalToolsFn();
	}

	getLocalToolsForFlavor(flavor?: 'kusto' | 'sql'): CopilotLocalTool[] {
		return flavor === 'sql' ? this.getSqlCopilotLocalTools() : this.getCopilotLocalTools();
	}

	getCopilotChatTools(enabledTools: string[]): vscode.LanguageModelChatTool[] {
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

	getSqlCopilotChatTools(enabledTools: string[]): vscode.LanguageModelChatTool[] {
		const localTools = this.getSqlCopilotLocalTools();
		const tools: vscode.LanguageModelChatTool[] = [];

		for (const t of localTools) {
			if (!this.isCopilotToolEnabled(t.name, enabledTools)) continue;
			const n = this.normalizeToolName(t.name);
			if (n === 'get_sql_schema') {
				tools.push({
					name: 'get_sql_schema',
					description: 'Provides the connected SQL database schema (tables + columns) to improve query correctness. Call this when you need to know table names, column names, or column types before writing a query.',
					inputSchema: { type: 'object', properties: {} }
				});
			} else if (n === 'get_query_optimization_best_practices') {
				tools.push({
					name: 'get_query_optimization_best_practices',
					description: 'Returns the SQL query optimization best practices document (optimize-sql-rules.md). Call this before optimizing queries for performance.',
					inputSchema: { type: 'object', properties: {} }
				});
			} else if (n === 'execute_sql_query') {
				tools.push({
					name: 'execute_sql_query',
					description: 'Executes a T-SQL query against the connected SQL server and returns the results (limited to 100 rows). Use when you need to run a query to analyze data, explore data, or verify something.',
					inputSchema: {
						type: 'object',
						properties: {
							query: { type: 'string', description: 'The complete T-SQL query to execute.' }
						},
						required: ['query']
					}
				});
			} else if (n === 'respond_to_query_performance_optimization_request') {
				tools.push({
					name: 'respond_to_query_performance_optimization_request',
					description: 'Use this as your FINAL response when the user asks to improve or optimize query performance. Creates a side-by-side comparison section with your proposed query and runs both to compare performance and results. Provide the FULL optimized query (not a diff).',
					inputSchema: {
						type: 'object',
						properties: {
							query: { type: 'string', description: 'The complete optimized T-SQL query.' }
						},
						required: ['query']
					}
				});
			} else if (n === 'respond_to_sql_query') {
				tools.push({
					name: 'respond_to_sql_query',
					description: 'Use this as your FINAL response. Sets the T-SQL query in the editor and runs it. Provide the FULL complete T-SQL query (not a diff).',
					inputSchema: {
						type: 'object',
						properties: {
							query: { type: 'string', description: 'The complete T-SQL query to set in the editor and run.' }
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
							question: { type: 'string', description: 'The specific clarifying question to ask the user.' }
						},
						required: ['question']
					}
				});
			}
		}
		return tools;
	}

	async readOptimizeQueryRules(flavor?: 'kusto' | 'sql'): Promise<string> {
		const fileName = flavor === 'sql' ? 'optimize-sql-rules.md' : 'optimize-query-rules.md';
		try {
			const uri = vscode.Uri.joinPath(this.host.context.extensionUri, 'copilot-instructions', fileName);
			const bytes = await vscode.workspace.fs.readFile(uri);
			return new TextDecoder('utf-8').decode(bytes);
		} catch (e) {
			const msg = this.host.getErrorMessage(e);
			return `Failed to read copilot-instructions/${fileName}: ${msg}`;
		}
	}

	async readGeneralQueryRules(): Promise<{ content: string; filePath: string } | undefined> {
		try {
			const uri = vscode.Uri.joinPath(this.host.context.extensionUri, 'copilot-instructions', 'general-query-rules.md');
			const bytes = await vscode.workspace.fs.readFile(uri);
			return {
				content: new TextDecoder('utf-8').decode(bytes),
				filePath: uri.fsPath
			};
		} catch {
			return undefined;
		}
	}

	async getDevNotesContent(): Promise<string | undefined> {
		try {
			const sections = await this.host.requestSectionsFromWebview();
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

	isCopilotToolEnabled(toolName: string, enabledTools: string[]): boolean {
		const name = this.normalizeToolName(toolName);
		if (!name) return false;
		const tools = this.getCopilotLocalTools();
		if (!Array.isArray(enabledTools) || enabledTools.length === 0) {
			const def = tools.find((t) => this.normalizeToolName(t.name) === name);
			return def ? def.enabledByDefault !== false : false;
		}
		return enabledTools.includes(name);
	}

	normalizeToolName(value: unknown): string {
		const raw = String(value || '').trim().toLowerCase();
		if (raw === 'validate_query_performance_improvements') {
			return 'respond_to_query_performance_optimization_request';
		}
		return raw;
	}

	private toHistoryToolCalls(
		nativeToolCalls: vscode.LanguageModelToolCallPart[],
		tools: vscode.LanguageModelChatTool[]
	): Array<{ callId: string; name: string; input: object }> {
		const offeredToolNames = new Set(tools.map((tool) => this.normalizeToolName(tool.name)).filter(Boolean));
		return nativeToolCalls
			.map((tc) => ({
				callId: String(tc.callId || '').trim(),
				name: this.normalizeToolName(tc.name),
				input: tc.input && typeof tc.input === 'object' ? tc.input as object : {}
			}))
			.filter((tc) => !!tc.callId && !!tc.name && offeredToolNames.has(tc.name));
	}

	private extractQueryArgument(args: unknown): string {
		try {
			if (args && typeof args === 'object') {
				const a = args as any;
				const q = a.query || a.newQuery;
				if (typeof q === 'string') {
					return q;
				}
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
				if (typeof a.raw === 'string') {
					return String(a.raw).trim();
				}
			}
		} catch {
			// ignore
		}
		return '';
	}

	extractKustoCodeBlock(text: string): string {
		const raw = String(text || '');
		const codeBlockMatch = raw.match(/```(?:kusto|kql)?\s*\n([\s\S]*?)\n```/i);
		if (codeBlockMatch) {
			return String(codeBlockMatch[1] || '').trim();
		}
		return raw.trim();
	}

	private getRunnableKustoQuery(query: string): string {
		try {
			return convertKustoFunctionDefinitionsToInline(query) || query;
		} catch {
			return query;
		}
	}

	formatCopilotModelLabel(model: vscode.LanguageModelChat): string {
		const vendor = String(model.vendor ?? 'copilot');
		const family = String(model.family ?? '').trim();
		const version = String(model.version ?? '').trim();
		const name = String(model.name ?? '').trim();
		const id = String(model.id ?? '').trim();

		const primary = name || [family, version].filter(Boolean).join(' ') || id || 'model';
		return vendor && vendor !== 'copilot' ? `${vendor}: ${primary}` : primary;
	}

	private nextHistoryEntryId(boxId: string): string {
		return `${boxId}_hist_${++this.copilotHistoryEntrySeq}`;
	}

	private getOrCreateConversationHistory(boxId: string): ConversationHistoryEntry[] {
		let history = this.copilotConversationHistoryByBoxId.get(boxId);
		if (!history) {
			history = [];
			this.copilotConversationHistoryByBoxId.set(boxId, history);
		}
		return history;
	}

	private ensureAllToolCallsHaveResults(
		history: ConversationHistoryEntry[],
		nativeToolCalls: Array<{ callId: string; name: string; input: any }>,
		boxId: string
	): void {
		insertMissingToolCallResults(history, nativeToolCalls, () => this.nextHistoryEntryId(boxId));
	}

	private appendToolCallHistoryResult(
		history: ConversationHistoryEntry[],
		boxId: string,
		callId: unknown,
		tool: string,
		args: unknown,
		result: string
	): string {
		const entryId = this.nextHistoryEntryId(boxId);
		history.push({
			type: 'tool-call',
			id: entryId,
			callId: String(callId || '').trim(),
			tool,
			args,
			result,
			timestamp: Date.now()
		});
		return entryId;
	}

	private appendToolResultBatchMessage(
		messages: vscode.LanguageModelChatMessage[],
		entries: ToolCallHistoryEntry[]
	): void {
		const previous = messages[messages.length - 1];
		if (!previous || previous.role !== vscode.LanguageModelChatMessageRole.Assistant) {
			return;
		}
		const previousToolCallIds = new Set(
			previous.content
				.filter((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart)
				.map((part) => part.callId)
		);
		const resultParts = entries
			.filter((entry) => previousToolCallIds.has(entry.callId))
			.map((entry) => {
				const resultText = entry.removed
					? '[truncated from conversation history, call tool again if needed]'
					: entry.result;
				return new vscode.LanguageModelToolResultPart(entry.callId, [
					new vscode.LanguageModelTextPart(resultText)
				]);
			});
		if (resultParts.length > 0) {
			messages.push(vscode.LanguageModelChatMessage.User(resultParts));
		}
	}

	private createPlaceholderToolResultPart(callId: string): vscode.LanguageModelToolResultPart {
		return new vscode.LanguageModelToolResultPart(callId, [
			new vscode.LanguageModelTextPart('[Tool result was not recorded]')
		]);
	}

	private isPlaceholderToolResultPart(part: vscode.LanguageModelToolResultPart): boolean {
		const text = part.content
			.filter((contentPart): contentPart is vscode.LanguageModelTextPart => contentPart instanceof vscode.LanguageModelTextPart)
			.map((contentPart) => contentPart.value)
			.join('\n')
			.trim();
		return text === '[Tool result was not recorded]' ||
			text === '[Tool call was not processed — the turn ended before a result could be produced.]';
	}

	private sanitizeProviderToolMessageSequence(
		messages: vscode.LanguageModelChatMessage[]
	): vscode.LanguageModelChatMessage[] {
		const sanitized: vscode.LanguageModelChatMessage[] = [];
		for (let i = 0; i < messages.length; i++) {
			const message = messages[i];

			if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
				const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
				const toolCallParts: vscode.LanguageModelToolCallPart[] = [];
				const seenToolCallIds = new Set<string>();

				for (const part of message.content) {
					if (part instanceof vscode.LanguageModelTextPart) {
						assistantParts.push(part);
						continue;
					}
					if (part instanceof vscode.LanguageModelToolCallPart) {
						const callId = String(part.callId || '').trim();
						const name = String(part.name || '').trim();
						if (!callId || !name || seenToolCallIds.has(callId)) {
							continue;
						}
						seenToolCallIds.add(callId);
						const normalized = callId === part.callId && name === part.name
							? part
							: new vscode.LanguageModelToolCallPart(callId, name, part.input);
						assistantParts.push(normalized);
						toolCallParts.push(normalized);
					}
				}

				if (assistantParts.length === 0) {
					continue;
				}

				sanitized.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

				if (toolCallParts.length === 0) {
					continue;
				}

				const expectedCallIds = new Set(toolCallParts.map((part) => part.callId));
				const resultPartsByCallId = new Map<string, vscode.LanguageModelToolResultPart>();
				const deferredUserMessages: vscode.LanguageModelTextPart[][] = [];
				let scanEnd = i + 1;

				while (scanEnd < messages.length && messages[scanEnd].role !== vscode.LanguageModelChatMessageRole.Assistant) {
					const candidate = messages[scanEnd];
					if (candidate.role === vscode.LanguageModelChatMessageRole.User) {
						const deferredUserParts: vscode.LanguageModelTextPart[] = [];
						for (const part of candidate.content) {
							if (part instanceof vscode.LanguageModelToolResultPart) {
								const callId = String(part.callId || '').trim();
								if (expectedCallIds.has(callId)) {
									const normalizedPart = callId === part.callId
										? part
										: new vscode.LanguageModelToolResultPart(callId, part.content);
									const existing = resultPartsByCallId.get(callId);
									if (!existing || (this.isPlaceholderToolResultPart(existing) && !this.isPlaceholderToolResultPart(normalizedPart))) {
										resultPartsByCallId.set(callId, normalizedPart);
									}
								}
							} else if (part instanceof vscode.LanguageModelTextPart) {
								deferredUserParts.push(part);
							}
						}
						if (deferredUserParts.length > 0) {
							deferredUserMessages.push(deferredUserParts);
						}
					}
					scanEnd++;
				}

				for (const toolCall of toolCallParts) {
					if (!resultPartsByCallId.has(toolCall.callId)) {
						resultPartsByCallId.set(toolCall.callId, this.createPlaceholderToolResultPart(toolCall.callId));
					}
				}

				const resultParts = toolCallParts.map((toolCall) => resultPartsByCallId.get(toolCall.callId)!);
				sanitized.push(vscode.LanguageModelChatMessage.User(resultParts));
				for (const deferredUserParts of deferredUserMessages) {
					sanitized.push(vscode.LanguageModelChatMessage.User(deferredUserParts));
				}
				if (scanEnd > i + 1) {
					i = scanEnd - 1;
				}
				continue;
			}

			if (message.role === vscode.LanguageModelChatMessageRole.User) {
				const hasToolResults = message.content.some((part) => part instanceof vscode.LanguageModelToolResultPart);
				if (!hasToolResults) {
					sanitized.push(message);
					continue;
				}
				const textParts = message.content.filter(
					(part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart
				);
				if (textParts.length > 0) {
					sanitized.push(vscode.LanguageModelChatMessage.User(textParts));
				}
				continue;
			}

			sanitized.push(message);
		}
		return sanitized;
	}

	cancelCopilotWriteQuery(boxId: string, expectedSequence?: number, expectedKustoRequest?: KustoCopilotRequestIdentity): void {
		const id = String(boxId || '').trim();
		if (!id) {
			return;
		}
		const running = this.runningCopilotWriteQueryByBoxId.get(id);
		if (!running || (expectedSequence !== undefined && running.seq !== expectedSequence)
			|| (expectedKustoRequest && (!running.kustoRequest
				|| !kustoCopilotRequestIdentityEquals(running.kustoRequest, expectedKustoRequest)))) {
			return;
		}
		running.cleanupCurrentToolTurn?.();
		this.settleOwnedCopilotExecutions(running);
		try {
			this.host.postMessage({
				type: 'copilotWriteQueryStatus', boxId: id, status: 'Canceling…',
				...(running.kustoRequest || {}),
			});
		} catch {
			// ignore
		}
		this.cancelTrackedCopilotQueries(running);
		try {
			running.cts.cancel();
		} catch {
			// ignore
		}
	}

	cancelKustoCopilotSection(boxId: string, sectionInstanceId: string): void {
		const id = String(boxId || '').trim();
		const instanceId = String(sectionInstanceId || '').trim();
		const running = this.runningCopilotWriteQueryByBoxId.get(id);
		if (running?.kustoRequest?.sectionInstanceId === instanceId) {
			this.cancelCopilotWriteQuery(id, running.seq, running.kustoRequest);
			this.runningCopilotWriteQueryByBoxId.delete(id);
		}
		const owner = this.copilotConversationOwnerByBoxId.get(id);
		if (owner?.flavor === 'kusto' && owner.kustoRequest?.sectionInstanceId === instanceId) {
			this.clearCopilotConversation(id);
			this.copilotConversationOwnerByBoxId.delete(id);
		}
		const optimize = this.runningOptimizeByBoxId.get(id);
		if (optimize?.owner.sectionInstanceId === instanceId) {
			this.retireRunningOptimize(optimize);
		}
	}

	disposeKustoOwners(): void {
		for (const [boxId, running] of [...this.runningCopilotWriteQueryByBoxId]) {
			if (!running.kustoRequest) continue;
			running.cleanupCurrentToolTurn?.();
			this.settleOwnedCopilotExecutions(running);
			this.cancelTrackedCopilotQueries(running);
			try { running.cts.cancel(); } catch { /* ignore */ }
			this.runningCopilotWriteQueryByBoxId.delete(boxId);
		}
		for (const running of this.runningOptimizeByBoxId.values()) {
			try { running.cts.cancel(); } catch { /* ignore */ }
			running.cts.dispose();
		}
		this.runningOptimizeByBoxId.clear();
		for (const [boxId, owner] of [...this.copilotConversationOwnerByBoxId]) {
			if (owner.flavor !== 'kusto') continue;
			this.clearCopilotConversation(boxId);
			this.copilotConversationOwnerByBoxId.delete(boxId);
		}
	}

	cancelCopilotQueryTarget(sourceBoxId: string, targetBoxId: string, expectedSequence: number): void {
		const running = this.runningCopilotWriteQueryByBoxId.get(String(sourceBoxId || '').trim());
		if (!running || running.seq !== expectedSequence) return;
		const targetCancels = running.queryCancelsByTargetBoxId?.get(String(targetBoxId || '').trim());
		if (!targetCancels) return;
		for (const cancel of [...targetCancels]) {
			try {
				cancel();
			} catch {
				// ignore
			}
			running.queryCancels.delete(cancel);
		}
		running.queryCancelsByTargetBoxId.delete(String(targetBoxId || '').trim());
	}

	clearCopilotConversation(boxId: string): void {
		const id = String(boxId || '').trim();
		if (!id) {
			return;
		}
		try {
			this.copilotGeneralRulesSentPerBox.delete(id);
		} catch {
			// ignore
		}
		try {
			this.copilotDevNotesSentPerBox.delete(id);
		} catch {
			// ignore
		}
		try {
			this.copilotConversationHistoryByBoxId.delete(id);
		} catch {
			// ignore
		}
	}

	clearKustoCopilotConversation(expected: KustoCopilotRequestIdentity): boolean {
		const owner = this.copilotConversationOwnerByBoxId.get(expected.boxId);
		if (owner?.flavor !== 'kusto' || !owner.kustoRequest
			|| !kustoCopilotRequestIdentityEquals(owner.kustoRequest, expected)) return false;
		this.clearCopilotConversation(expected.boxId);
		this.copilotConversationOwnerByBoxId.delete(expected.boxId);
		return true;
	}

	invalidateKustoConnections(connectionIds: readonly string[], options?: { preserveEstablishingAccountPartition?: string }): void {
		const affected = new Set(connectionIds.map(connectionId => String(connectionId || '').trim()).filter(Boolean));
		const affectsAll = affected.size === 0;
		const establishingPartition = String(options?.preserveEstablishingAccountPartition || '').trim();
		for (const running of [...this.runningOptimizeByBoxId.values()]) {
			if (!affectsAll && !affected.has(running.target.connectionId)) continue;
			const connection = this.host.findConnection(running.target.connectionId);
			const currentPartition = String(connection ? this.host.kustoClient.getAccountPartition(connection) || '' : '').trim();
			if (!running.accountPartition && establishingPartition && currentPartition === establishingPartition) {
				running.accountPartition = establishingPartition;
				continue;
			}
			try { running.cts.cancel(); } catch { /* ignore */ }
			void this.settleRejectedOptimizePublication(running, 'Optimization canceled');
		}
		const affectedOwners: Array<{ boxId: string; request: KustoCopilotRequestIdentity }> = [];
		for (const [boxId, owner] of [...this.copilotConversationOwnerByBoxId]) {
			if (owner.flavor !== 'kusto' || (!affectsAll && !affected.has(owner.connectionId))) continue;
			const running = this.runningCopilotWriteQueryByBoxId.get(boxId);
			const preservesFirstEstablishment = !!running
				&& !owner.accountPartition
				&& !!establishingPartition
				&& ([...running.kustoAccountPartitionGetters].some(getPartition => getPartition() === establishingPartition)
					|| running.kustoFinalRun?.getAccountPartition() === establishingPartition);
			if (preservesFirstEstablishment) {
				owner.accountPartition = establishingPartition;
				continue;
			}
			if (owner.kustoRequest) affectedOwners.push({ boxId, request: owner.kustoRequest });
			if (running) {
				this.cancelTrackedCopilotQueries(running);
				if (running.kustoFinalRun) {
					this.host.cancelKustoSectionExecution(running.kustoFinalRun.target, running.kustoFinalRun.executionId);
				}
				try { running.cts.cancel(); } catch { /* ignore */ }
				this.runningCopilotWriteQueryByBoxId.delete(boxId);
			}
			this.clearCopilotConversation(boxId);
			this.copilotDevNotesSentPerBox.delete(boxId);
			this.copilotConversationOwnerByBoxId.delete(boxId);
		}
		for (const affected of affectedOwners) {
			this.host.postMessage({ type: 'kustoCopilotIdentityChanged', ...affected.request });
		}
	}

	invalidateSqlConnections(connectionIds: readonly string[], derivedBoxIds: readonly string[] = []): void {
		const affected = new Set(connectionIds.map(connectionId => String(connectionId || '').trim()).filter(Boolean));
		const affectsAll = affected.size === 0;
		const affectedBoxIds: string[] = [];
		for (const [boxId, running] of [...this.runningSqlInlineCompletionByBoxId]) {
			if (!affectsAll && !affected.has(running.connectionId)) continue;
			try { running.cts.cancel(); } catch { /* ignore */ }
			running.cts.dispose();
			this.runningSqlInlineCompletionByBoxId.delete(boxId);
			affectedBoxIds.push(boxId);
		}
		for (const [boxId, owner] of [...this.copilotConversationOwnerByBoxId]) {
			if (owner.flavor !== 'sql' || (!affectsAll && !affected.has(owner.connectionId))) continue;
			affectedBoxIds.push(boxId);
			const running = this.runningCopilotWriteQueryByBoxId.get(boxId);
			if (running) {
				this.cancelTrackedCopilotQueries(running);
				this.host.sqlExecutionBroker.supersede(boxId, { notifyWebview: true });
				try { running.cts.cancel(); } catch { /* ignore */ }
				this.runningCopilotWriteQueryByBoxId.delete(boxId);
			}
			this.clearCopilotConversation(boxId);
			this.copilotDevNotesSentPerBox.delete(boxId);
			this.copilotConversationOwnerByBoxId.delete(boxId);
		}
		const boxIds = [...new Set([
			...affectedBoxIds,
			...derivedBoxIds.map(boxId => String(boxId || '').trim()).filter(Boolean),
		])];
		if (boxIds.length > 0) {
			this.host.postMessage({ type: 'sqlCopilotPolicyChanged', boxIds });
		}
	}

	removeFromCopilotHistory(boxId: string, entryId: string): void {
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

	async checkCopilotAvailability(boxId: string): Promise<void> {
		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			const available = models.length > 0;

			this.host.postMessage({
				type: 'copilotAvailability',
				boxId,
				available
			});
		} catch {
			this.host.postMessage({
				type: 'copilotAvailability',
				boxId,
				available: false
			});
		}
	}

	async handleCopilotInlineCompletionRequest(
		message: Extract<IncomingWebviewMessage, { type: 'requestCopilotInlineCompletion' }>,
		expectedSqlOwner?: SqlResultOwner,
		ownerToken?: string,
	): Promise<void> {
		const requestId = String(message.requestId || '').trim();
		const boxId = String(message.boxId || '').trim();
		const textBefore = String(message.textBefore || '');
		const textAfter = String(message.textAfter || '');
		const flavor = message.flavor === 'sql' ? 'sql' : 'kusto';

		if (!requestId) {
			return;
		}
		if (flavor === 'sql' && !expectedSqlOwner) return;

		const postResult = (completions: Array<{ insertText: string }>, error?: string) => this.host.postMessage({
			type: 'copilotInlineCompletionResult', requestId, boxId, completions,
			...(ownerToken ? { ownerToken } : {}), ...(error ? { error } : {}),
		});
		const cts = new vscode.CancellationTokenSource();
		if (expectedSqlOwner) {
			const previous = this.runningSqlInlineCompletionByBoxId.get(boxId);
			try { previous?.cts.cancel(); } catch { /* ignore */ }
			previous?.cts.dispose();
			this.runningSqlInlineCompletionByBoxId.set(boxId, { connectionId: expectedSqlOwner.connectionId, cts });
		}
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const assertInlineOwner = async () => {
			if (!expectedSqlOwner) return;
			if (cts.token.isCancellationRequested) throw new vscode.CancellationError();
			await this.host.assertSqlResultOwnerAllowed(boxId, expectedSqlOwner);
			if (cts.token.isCancellationRequested) throw new vscode.CancellationError();
		};

		try {
			await assertInlineOwner();
			// Use cached model if available (avoids ~200-500ms selectChatModels latency per request).
			let model = this._cachedInlineModel;
			if (!model || Date.now() - this._cachedInlineModelAt > CopilotService.INLINE_MODEL_CACHE_TTL_MS) {
				const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
				if (models.length === 0) {
					postResult([], 'Copilot not available');
					return;
				}
				model = findPreferredDefaultCopilotModel(models)!;
				this._cachedInlineModel = model;
				this._cachedInlineModelAt = Date.now();
			}
			await assertInlineOwner();

			// Trim context to the most relevant portion to keep the prompt small and fast.
			// For inline completions, the last ~2000 chars before cursor and ~500 after
			// is more than enough context.
			const maxBefore = 2000;
			const maxAfter = 500;
			const trimmedBefore = textBefore.length > maxBefore ? textBefore.slice(-maxBefore) : textBefore;
			const trimmedAfter = textAfter.length > maxAfter ? textAfter.slice(0, maxAfter) : textAfter;

			const prompt = flavor === 'sql'
				? `You are an expert T-SQL (Microsoft SQL Server) assistant providing inline code completions.
Complete the following T-SQL code. Only return the completion text that should be inserted at the cursor position.
Do NOT include any explanation, markdown formatting, or code fences.
Return ONLY the raw T-SQL code to complete the line or statement.
If you cannot provide a meaningful completion, return an empty string.

T-SQL code before cursor:
${trimmedBefore}

T-SQL code after cursor:
${trimmedAfter}

Completion:`
				: `You are an expert Kusto Query Language (KQL) assistant providing inline code completions.
Complete the following KQL code. Only return the completion text that should be inserted at the cursor position.
Do NOT include any explanation, markdown formatting, or code fences.
Return ONLY the raw KQL code to complete the line or statement.
If you cannot provide a meaningful completion, return an empty string.

KQL code before cursor:
${trimmedBefore}

KQL code after cursor:
${trimmedAfter}

Completion:`;

			timeoutId = setTimeout(() => cts.cancel(), 8000);

			try {
				await assertInlineOwner();
				const sendRequest = () => model.sendRequest(
					[vscode.LanguageModelChatMessage.User(prompt)], {}, cts.token
				);
				const response = expectedSqlOwner
					? await this.host.dispatchSqlResultOwnerAllowed(boxId, expectedSqlOwner, sendRequest)
					: await sendRequest();

				let completionText = '';
				for await (const chunk of response.text) {
					completionText += chunk;
					if (completionText.length > 500) {
						break;
					}
				}

				clearTimeout(timeoutId);
				timeoutId = undefined;

				completionText = completionText.trim();
				completionText = flavor === 'sql'
					? completionText.replace(/^```(?:sql|tsql|t-sql)?\s*\n?/i, '').replace(/\n?```$/i, '')
					: completionText.replace(/^```(?:kusto|kql)?\s*\n?/i, '').replace(/\n?```$/i, '');

				const completions = completionText ? [{ insertText: completionText }] : [];
				await assertInlineOwner();
				if (expectedSqlOwner) {
					await this.host.dispatchSqlResultOwnerAllowed(boxId, expectedSqlOwner, () => postResult(completions));
				} else {
					postResult(completions);
				}
			} catch (err) {
				if (timeoutId) clearTimeout(timeoutId);
				timeoutId = undefined;
				if (err instanceof vscode.CancellationError) {
					postResult([]);
				} else {
					throw err;
				}
			}
		} catch (err) {
			const errorMsg = err instanceof vscode.LanguageModelError
				? `Copilot error: ${err.message}`
				: this.host.getErrorMessage(err);
			postResult([], errorMsg);
		} finally {
			if (timeoutId) clearTimeout(timeoutId);
			if (this.runningSqlInlineCompletionByBoxId.get(boxId)?.cts === cts) {
				this.runningSqlInlineCompletionByBoxId.delete(boxId);
			}
			cts.dispose();
		}
	}

	async prepareCopilotWriteQuery(
		message: Extract<IncomingWebviewMessage, { type: 'prepareCopilotWriteQuery' }>
	): Promise<void> {
		const boxId = String(message.boxId || '').trim();
		if (!boxId) {
			return;
		}
		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			if (models.length === 0) {
				this.host.postMessage({
					type: 'copilotWriteQueryOptions',
					boxId,
					models: [],
					selectedModelId: '',
					tools: this.getLocalToolsForFlavor(message.flavor)
				});
				this.host.postMessage({
					type: 'copilotWriteQueryStatus',
					boxId,
					status:
						'GitHub Copilot is not available. Enable Copilot in VS Code to use this feature.'
				});
				return;
			}

			const modelOptions = models
				.map((m) => ({ id: String(m.id), label: this.formatCopilotModelLabel(m) }))
				.filter((m) => !!m.id)
				.sort((a, b) => a.label.localeCompare(b.label));

			const lastModelId = this.host.context.globalState.get<string>(STORAGE_KEYS.lastOptimizeCopilotModelId);
			const preferredModelId = String(lastModelId || '').trim();
			const defaultModelId = findPreferredDefaultCopilotModel(models)?.id || '';
			const selectedModelId =
				preferredModelId && modelOptions.some((m) => m.id === preferredModelId)
					? preferredModelId
					: defaultModelId;

			this.host.postMessage({
				type: 'copilotWriteQueryOptions',
				boxId,
				models: modelOptions,
				selectedModelId,
				tools: this.getLocalToolsForFlavor(message.flavor)
			});
		} catch {
			this.host.postMessage({
				type: 'copilotWriteQueryOptions',
				boxId,
				models: [],
				selectedModelId: '',
				tools: this.getLocalToolsForFlavor(message.flavor)
			});
		}
	}

	private async getExtendedSchemaToolResult(
		connection: KustoConnection,
		database: string,
		_boxId: string,
		token: vscode.CancellationToken,
		model?: vscode.LanguageModelChat
	): Promise<{ result: string; label: string; prunePhase?: number }> {
		const db = String(database || '').trim();
		const accountPartition = this.host.kustoClient.getAccountPartition(connection);
		const diskCacheKey = accountPartition
			? schemaCacheKey(connection.clusterUrl || '', db, connection.id, accountPartition)
			: '';
		const memCacheKey = diskCacheKey;
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
			const cached = diskCacheKey ? await this.host.getCachedSchemaFromDisk(diskCacheKey) : undefined;
			if (token.isCancellationRequested) {
				throw new Error('Copilot write-query canceled');
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
						jsonText = formatSchemaAsCompactText(db, schema, schemaMeta);
					}
				} else {
					jsonText = formatSchemaAsCompactText(db, schema, schemaMeta);
				}
			}
		} catch (error) {
			if (token.isCancellationRequested) throw error;
			const raw = this.host.getErrorMessage(error);
			label = `${db || '(unknown db)'}: schema lookup failed`;
			jsonText = JSON.stringify({ database: db, error: `Failed to read cached schema: ${raw}` }, null, 2);
		}

		if (token.isCancellationRequested) throw new Error('Copilot write-query canceled');
		try {
			if (memCacheKey) this.copilotExtendedSchemaCache.set(memCacheKey, { timestamp: now, result: jsonText, label });
		} catch {
			// ignore
		}

		return { result: jsonText, label, prunePhase };
	}

	private buildMessagesFromHistory(args: {
		boxId: string;
		clusterUrl: string;
		database: string;
		priorAttempts?: Array<{ attempt: number; query?: string; error?: string }>;
	}): vscode.LanguageModelChatMessage[] {
		const history = this.copilotConversationHistoryByBoxId.get(args.boxId) || [];

		sanitizeConversationHistory(history);

		const messages: vscode.LanguageModelChatMessage[] = [];

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

		for (const batch of groupConversationHistoryForProvider(history)) {
			if (batch.type === 'tool-results') {
				this.appendToolResultBatchMessage(messages, batch.entries);
				continue;
			}
			const entry = batch.entry;
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
			}
		}

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

		return this.sanitizeProviderToolMessageSequence(messages);
	}

	async handleCopilotChatFirstTimeCheck(boxId: string): Promise<void> {
		const already = this.host.context.globalState.get<boolean>(STORAGE_KEYS.copilotChatFirstTimeDismissed);
		if (already) {
			this.host.postMessage({ type: 'copilotChatFirstTimeResult', boxId, action: 'proceed' });
			return;
		}

		await this.host.context.globalState.update(STORAGE_KEYS.copilotChatFirstTimeDismissed, true);

		const openAgent = 'Open the Kusto Workbench agent';
		const useChat = 'Use this Copilot Chat window';
		const choice = await vscode.window.showInformationMessage(
			'Hello there! Did you know this extension comes with a custom agent called \'Kusto Workbench\' that is available through the VS Code Copilot chat window? You should use that instead of this chat window unless you are very familiar with both and you understand the differences.',
			{ modal: true },
			openAgent,
			useChat
		);

		if (choice === openAgent) {
			await openKustoWorkbenchAgentChat();
			this.host.postMessage({ type: 'copilotChatFirstTimeResult', boxId, action: 'openedAgent' });
		} else if (choice === useChat) {
			this.host.postMessage({ type: 'copilotChatFirstTimeResult', boxId, action: 'proceed' });
		} else {
			this.host.postMessage({ type: 'copilotChatFirstTimeResult', boxId, action: 'dismissed' });
		}
	}

	async startCopilotWriteQuery(
		message: Extract<IncomingWebviewMessage, { type: 'startCopilotWriteQuery' }>,
		sqlConnectionManager?: SqlConnectionManager,
		sqlSchemaService?: SqlSchemaService,
		sqlClient?: SqlQueryClient,
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
		const requireToolUse = message.requireToolUse === true;
		const kustoRequest: KustoCopilotRequestIdentity | undefined = message.flavor === 'kusto'
			? Object.freeze({
				boxId,
				copilotRequestId: String(message.copilotRequestId || '').trim(),
				sectionInstanceId: String(message.sectionInstanceId || '').trim(),
				targetGeneration: Number(message.targetGeneration),
			})
			: undefined;
		const postRequestMessage = (payload: Record<string, unknown>) => this.host.postMessage({
			boxId,
			...payload,
			...(kustoRequest || {}),
		});
		const postRequiredRequestMessage = async (payload: Record<string, unknown>): Promise<void> => {
			const delivered = await Promise.resolve(postRequestMessage(payload));
			if (delivered === false) throw new Error('Copilot write-query canceled');
		};
		if (!boxId) {
			return;
		}
		if (message.flavor === 'kusto' && (!kustoRequest?.copilotRequestId
			|| !kustoRequest.sectionInstanceId || !Number.isSafeInteger(kustoRequest.targetGeneration)
			|| kustoRequest.targetGeneration < 0)) return;
		if (!connectionId || !database || !request) {
			try {
				postRequestMessage({
					type: 'copilotWriteQueryDone',
					boxId,
					ok: false,
					message: 'Select a connection and database, then enter what you want the query to do.'
				});
			} catch {
				// ignore
			}
			return;
		}

		// If this is a SQL-flavored request, delegate to the SQL flow
		if (message.flavor === 'sql' && sqlConnectionManager && sqlSchemaService && sqlClient) {
			await this.startSqlCopilotWriteQuery(
				{ boxId, sqlConnectionId: connectionId, database, request, currentQuery, modelId: requestedModelId, enabledTools, sqlOwnerToken: message.sqlOwnerToken } as any,
				sqlConnectionManager,
				sqlSchemaService,
				sqlClient
			);
			return;
		}
		if (message.flavor !== 'kusto') return;
		if (!kustoRequest) return;
		const requestSectionInstanceId = message.sectionInstanceId;
		const requestTargetGeneration = message.targetGeneration;
		const connection = this.host.findConnection(connectionId);
		if (!connection) {
			postRequestMessage({
				type: 'copilotWriteQueryDone',
				boxId,
				ok: false,
				message: 'Connection not found. Select a valid connection and try again.'
			});
			return;
		}

		const previousOwner = this.copilotConversationOwnerByBoxId.get(boxId);
		if (previousOwner && (previousOwner.flavor !== 'kusto' || previousOwner.connectionId !== connectionId
			|| !previousOwner.kustoRequest
			|| previousOwner.kustoRequest.boxId !== kustoRequest.boxId
			|| previousOwner.kustoRequest.sectionInstanceId !== kustoRequest.sectionInstanceId
			|| previousOwner.kustoRequest.targetGeneration !== kustoRequest.targetGeneration)) {
			this.clearCopilotConversation(boxId);
		}
		this.copilotConversationOwnerByBoxId.set(boxId, {
			flavor: 'kusto',
			connectionId,
			kustoRequest,
			accountPartition: this.host.kustoClient.getAccountPartition(connection),
		});

		try {
			const existing = this.runningCopilotWriteQueryByBoxId.get(boxId);
			if (existing) {
				existing.cleanupCurrentRequestHistory?.();
				this.settleOwnedCopilotExecutions(existing);
				this.cancelTrackedCopilotQueries(existing);
				existing.cts.cancel();
				this.runningCopilotWriteQueryByBoxId.delete(boxId);
			}
		} catch {
			// ignore
		}

		const cts = new vscode.CancellationTokenSource();
		const seq = ++this.copilotWriteSeq;
		const runningRequest = this.createRunningCopilotWriteQuery(boxId, cts, seq, kustoRequest);
		let requestHistory: ConversationHistoryEntry[] | undefined;
		let requestHistoryStart = -1;
		runningRequest.cleanupCurrentRequestHistory = () => {
			runningRequest.cleanupCurrentToolTurn?.();
			if (!requestHistory || requestHistoryStart < 0) return;
			const removedEntries = requestHistory.splice(requestHistoryStart);
			if (removedEntries.some(entry => entry.type === 'general-rules')) {
				this.copilotGeneralRulesSentPerBox.delete(boxId);
			}
			if (removedEntries.some(entry => entry.type === 'devnotes-context')) {
				this.copilotDevNotesSentPerBox.delete(boxId);
			}
			requestHistoryStart = -1;
		};
		const isActive = () => {
			const current = this.runningCopilotWriteQueryByBoxId.get(boxId);
			return !!current && current.cts === cts && current.seq === seq;
		};
		const assertActiveRequest = () => {
			if (!isActive() || cts.token.isCancellationRequested) {
				throw new Error('Copilot write-query canceled');
			}
		};

		const postStatus = (status: string, detail?: string) => {
			try {
				postRequestMessage({ type: 'copilotWriteQueryStatus', boxId, status, detail: detail || '' });
			} catch {
				// ignore
			}
		};

		const postNarrative = (narrative: string) => {
			const text = String(narrative || '').trim();
			if (!text) return;
			try {
				postRequestMessage({ type: 'copilotWriteQueryStatus', boxId, status: text, role: 'assistant' });
			} catch {
				// ignore
			}
		};

		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			assertActiveRequest();
			if (models.length === 0) {
				postRequestMessage({
					type: 'copilotWriteQueryDone',
					boxId,
					ok: false,
					message: 'GitHub Copilot is not available. Enable Copilot in VS Code to use this feature.'
				});
				return;
			}
			let model: vscode.LanguageModelChat | undefined;
			if (requestedModelId) {
				model = models.find((m) => String(m.id) === requestedModelId);
			}
			if (!model) {
				const lastModelId = this.host.context.globalState.get<string>(STORAGE_KEYS.lastOptimizeCopilotModelId);
				const preferred = String(lastModelId || '').trim();
				model = preferred ? models.find((m) => String(m.id) === preferred) : undefined;
			}
			if (!model) {
				model = findPreferredDefaultCopilotModel(models)!;
			}

			try {
				await this.host.context.globalState.update(STORAGE_KEYS.lastOptimizeCopilotModelId, String(model.id));
			} catch {
				// ignore
			}
			assertActiveRequest();

			const history = this.getOrCreateConversationHistory(boxId);
			requestHistory = history;
			requestHistoryStart = history.length;

			if (!this.copilotGeneralRulesSentPerBox.has(boxId)) {
				const generalRules = await this.readGeneralQueryRules();
				assertActiveRequest();
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

					try {
						postRequestMessage({
							type: 'copilotGeneralQueryRulesLoaded',
							boxId,
							entryId: rulesEntryId,
							filePath: generalRules.filePath,
							preview: generalRules.content
						});
					} catch {
						// ignore
					}
				}
			}

			if (!this.copilotDevNotesSentPerBox.has(boxId)) {
				const devNotesContent = await this.getDevNotesContent();
				assertActiveRequest();
				if (devNotesContent) {
					const devNotesEntryId = this.nextHistoryEntryId(boxId);
					history.push({
						type: 'devnotes-context',
						id: devNotesEntryId,
						content: devNotesContent,
						timestamp: Date.now()
					});
					this.copilotDevNotesSentPerBox.add(boxId);

					try {
						postRequestMessage({
							type: 'copilotDevNotesContextLoaded',
							boxId,
							entryId: devNotesEntryId,
							preview: devNotesContent
						});
					} catch {
						// ignore
					}
				}
			}

			assertActiveRequest();
			const userMessageEntryId = this.nextHistoryEntryId(boxId);
			history.push({
				type: 'user-message',
				id: userMessageEntryId,
				text: request,
				querySnapshot: currentQuery || undefined,
				timestamp: Date.now()
			});

			if (currentQuery) {
				try {
					postRequestMessage({
						type: 'copilotUserQuerySnapshot',
						boxId,
						entryId: userMessageEntryId,
						queryText: currentQuery
					});
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
				assertActiveRequest();

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

				if (nativeToolCalls.length === 0) {
					const decision = decideNonToolResponse(requireToolUse);

					// Post narrative only if the decision allows it (rejected attempts
					// show what the model said; accepted text-only responses use the
					// narrative as the final display so postNarrative is also allowed).
					if (responseText.trim() && !decision.suppressNarrative) {
						postNarrative(responseText.trim());
					}

					if (!decision.accept) {
						priorAttempts.push({ attempt, error: decision.priorAttemptError! });
						postStatus(decision.statusMessage!, responseText);
						continue;
					}

					// Accept the text-only response (manual user chat).
					// Post the narrative as the final rendered message, and send a
					// done signal with empty message to avoid duplicate rendering.
					if (responseText.trim()) {
						postNarrative(responseText.trim());
					}

					const textEntryId = this.nextHistoryEntryId(boxId);
					history.push({
						type: 'assistant-message',
						id: textEntryId,
						text: responseText,
						toolCalls: [],
						timestamp: Date.now()
					});

					postRequestMessage({
						type: 'copilotWriteQueryDone',
						boxId,
						ok: true,
						message: ''
					});
					return;
				}

				const historyToolCalls = this.toHistoryToolCalls(nativeToolCalls, tools);
				if (historyToolCalls.length === 0) {
					priorAttempts.push({ attempt, error: 'Copilot returned malformed tool calls without valid tool names.' });
					postStatus('Copilot returned malformed tool calls. Retrying…');
					continue;
				}

				// Has tool calls — post any accompanying narrative text.
				if (responseText.trim()) {
					postNarrative(responseText.trim());
				}

				const assistantEntryId = this.nextHistoryEntryId(boxId);
				const assistantHistoryEntry: ConversationHistoryEntry = {
					type: 'assistant-message',
					id: assistantEntryId,
					text: responseText,
					toolCalls: historyToolCalls,
					timestamp: Date.now()
				};
				history.push(assistantHistoryEntry);

				let shouldRetryAttempt = false;
				let hasOptionalToolCalls = false;
				let toolTurnSuperseded = false;
				const removeSupersededToolTurnHistory = () => {
					if (toolTurnSuperseded) return;
					toolTurnSuperseded = true;
					const toolCallIds = new Set(historyToolCalls.map(toolCall => toolCall.callId));
					for (let index = history.length - 1; index >= 0; index--) {
						const entry = history[index];
						if (entry === assistantHistoryEntry
							|| (entry.type === 'tool-call' && toolCallIds.has(entry.callId))) {
							history.splice(index, 1);
						}
					}
				};
				const runningRequest = this.runningCopilotWriteQueryByBoxId.get(boxId);
				if (runningRequest?.cts === cts && runningRequest.seq === seq) {
					runningRequest.cleanupCurrentToolTurn = removeSupersededToolTurnHistory;
				}
				const settleSupersededQueryRun = () => {
					removeSupersededToolTurnHistory();
					if (!isActive() || cts.token.isCancellationRequested) return;
					try {
						postRequestMessage({ type: 'copilotWriteQueryDone', boxId, ok: false, message: '' });
					} catch {
						// ignore
					}
				};

				try {
				for (const tc of nativeToolCalls) {
					if (!isActive() || cts.token.isCancellationRequested) {
						throw new Error('Copilot write-query canceled');
					}

					const toolName = this.normalizeToolName(tc.name);

					if (toolName === 'get_extended_schema') {
						const requestedDbRaw = (tc.input as any)?.database;
						const requestedDb = String(requestedDbRaw || database || '').trim() || database;
						const schemaToolResult = await this.getExtendedSchemaToolResult(connection, requestedDb, boxId, cts.token, model);
						assertActiveRequest();

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
							postRequestMessage({
								type: 'copilotWriteQueryToolResult',
								boxId,
								entryId: schemaEntryId,
								tool: 'get_extended_schema',
								label: schemaToolResult.label,
								json: schemaToolResult.result
							});
						} catch {
							// ignore
						}

						if (schemaToolResult.prunePhase && schemaToolResult.prunePhase > 0) {
							const phaseDesc = PRUNE_PHASE_DESCRIPTIONS[schemaToolResult.prunePhase as 0 | 1 | 2 | 3 | 4 | 5] || 'reduced';
							postStatus(`Schema was too large for the model\u2019s context window and was automatically reduced (${phaseDesc}). Provide specific table or column names for best results.`);
						}

						hasOptionalToolCalls = true;
						continue;
					}

					if (toolName === 'get_query_optimization_best_practices') {
						const bestPracticesResult = await this.readOptimizeQueryRules();
						assertActiveRequest();

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
							postRequestMessage({
								type: 'copilotWriteQueryToolResult',
								boxId,
								entryId: bpEntryId,
								tool: 'get_query_optimization_best_practices',
								label: 'optimize-query-rules.md',
								json: bestPracticesResult
							});
						} catch {
							// ignore
						}
						hasOptionalToolCalls = true;
						continue;
					}

					if (toolName === 'execute_kusto_query') {
						const rawQuery = this.extractQueryArgument(tc.input);
						const query = this.extractKustoCodeBlock(rawQuery).trim();
						const effectiveQuery = this.getRunnableKustoQuery(query);
						if (!query) {
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
							const isControl = this.host.isControlCommand(effectiveQuery);
							const queryWithLimit = this.host.appendQueryMode(effectiveQuery, copilotQueryMode);
							const cacheDirective = isControl ? '' : this.host.buildCacheDirective(true, 1, 'days');
							const finalQuery = cacheDirective ? `${cacheDirective}\n${queryWithLimit}` : queryWithLimit;
							const executionQuery = this.host.normalizeControlCommandForExecution(finalQuery);
							const cancelClientKey = `${boxId}::${connection.id}::executeForCopilot`;
							let dispatchIdentity: KustoDispatchIdentity | undefined;
							const execution = this.host.kustoClient.executeQueryCancelable(
								connection,
								database,
								executionQuery,
								cancelClientKey,
								{ onDispatch: identity => { dispatchIdentity = identity; } },
							);
							const untrack = this.trackCopilotQueryCancel(boxId, cts, seq, execution.cancel, execution.getAccountPartition);
							const result = await execution.promise.finally(untrack);
							if (!isActive() || cts.token.isCancellationRequested) {
								throw new Error('Copilot write-query canceled');
							}
							const producingAccountPartition = execution.getAccountPartition();
							await this.host.kustoClient.waitForProviderAccountRefresh();
							if (!isActive() || cts.token.isCancellationRequested) {
								throw new Error('Copilot write-query canceled');
							}
							await this.host.refreshConnectionsData?.();
							if (!isActive() || cts.token.isCancellationRequested) {
								throw new Error('Copilot write-query canceled');
							}
							if (!dispatchIdentity) throw new Error('Copilot write-query canceled');
							const currentConnection = this.host.getCurrentKustoConnectionForDispatch(connection.id, dispatchIdentity);
							if (!producingAccountPartition || !currentConnection
								|| this.host.kustoClient.getAccountPartition(currentConnection) !== producingAccountPartition) {
								this.invalidateKustoConnections([connection.id]);
								throw new Error('Copilot write-query canceled');
							}
							const policyAdmission = await this.host.connectionManager.admitLeaveNoTraceRevision(
								dispatchIdentity.clusterEndpoint,
								dispatchIdentity.leaveNoTraceRevision,
								async () => {
									const admittedConnection = this.host.getCurrentKustoConnectionForDispatch(connection.id, dispatchIdentity!);
									if (!isActive() || cts.token.isCancellationRequested
										|| !admittedConnection
										|| this.host.kustoClient.getAccountPartition(admittedConnection) !== producingAccountPartition) return false;
									const rows = result.rows || [];
									const execEntryId = this.nextHistoryEntryId(boxId);
									const delivery = await this.host.postKustoPublication({
										type: 'copilotExecutedQuery',
										...kustoRequest,
										entryId: execEntryId,
										query: effectiveQuery,
										resultSummary: rows.length > 0 ? `${rows.length} rows` : 'No results',
										result,
									});
									if (delivery === false || !isActive() || cts.token.isCancellationRequested) return false;
									history.push({
										type: 'tool-call',
										id: execEntryId,
										callId: tc.callId,
										tool: 'execute_kusto_query',
										args: { query: effectiveQuery },
										result: formatQueryResultForCopilot(result),
										timestamp: Date.now(),
									});
									return true;
								},
							);
							if (!policyAdmission.admitted || policyAdmission.value !== true) {
								throw new Error('Copilot write-query canceled');
							}
							hasOptionalToolCalls = true;
							continue;
						} catch (e) {
							const errMsg = this.host.getErrorMessage(e);
							if (!isActive() || cts.token.isCancellationRequested || (e as Record<string, unknown>)?.isCancelled === true || /canceled|cancelled/i.test(errMsg)) {
								throw new Error('Copilot write-query canceled');
							}

							const execErrEntryId = this.nextHistoryEntryId(boxId);
							history.push({
								type: 'tool-call',
								id: execErrEntryId,
								callId: tc.callId,
								tool: 'execute_kusto_query',
								args: { query: effectiveQuery },
								result: `Query execution error: ${errMsg}`,
								timestamp: Date.now()
							});

							try {
								postRequestMessage({
									type: 'copilotExecutedQuery',
									boxId,
									entryId: execErrEntryId,
									query: effectiveQuery,
									resultSummary: 'Error',
									errorMessage: errMsg
								});
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
							const principalIdentities = new Set<string>();
							for (const connection of this.host.connectionManager.getConnections()) {
								let partition: string | undefined;
								try { partition = this.host.kustoClient.getAccountPartition(connection); } catch { partition = undefined; }
								const identity = schemaPrincipalIdentity(connection.id, partition);
								if (identity) principalIdentities.add(identity);
							}
							const searchMatches = await searchCachedSchemas(this.host.context.globalStorageUri, rawPattern, 200, principalIdentities);
							assertActiveRequest();
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
								postRequestMessage({
									type: 'copilotWriteQueryToolResult',
									boxId,
									entryId: searchEntryId,
									tool: 'search_cached_schemas',
									label,
									json: resultText
								});
							} catch {
								// ignore
							}
						} catch (e) {
							if (!isActive() || cts.token.isCancellationRequested) throw new Error('Copilot write-query canceled');
							const errMsg = this.host.getErrorMessage(e);
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
								postRequestMessage({
									type: 'copilotWriteQueryToolResult',
									boxId,
									entryId: searchErrEntryId,
									tool: 'search_cached_schemas',
									label: `Search failed: ${errMsg}`,
									json: `Search error: ${errMsg}`
								});
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
							this.appendToolCallHistoryResult(history, boxId, tc.callId, toolName, tc.input, 'Error: query argument was empty.');
							priorAttempts.push({ attempt, error: 'Tool call was missing a non-empty query argument.' });
							postStatus('Tool call missing query argument. Retrying…');
							shouldRetryAttempt = true;
							break;
						}

						const originalQueryForCompare = this.getRunnableKustoQuery(currentQuery);
						let candidate = this.getRunnableKustoQuery(improvedQuery);
						const sameDataTarget = (left: KustoSectionExecutionTarget, right: KustoSectionExecutionTarget) =>
							left.connectionId === right.connectionId && left.database.toLowerCase() === right.database.toLowerCase();
						postStatus('Preparing comparison editor…');
						let preparedComparison = await this.host.ensureComparisonBoxInWebview(boxId, candidate, cts.token, seq, kustoRequest);
						let comparisonBoxId = preparedComparison.boxId;
						if (!comparisonBoxId || !preparedComparison.kustoTarget) {
							this.appendToolCallHistoryResult(history, boxId, tc.callId, toolName, { query: candidate }, 'Error: failed to prepare comparison editor.');
							postRequestMessage({
								type: 'copilotWriteQueryDone',
								boxId,
								ok: false,
								message: 'Failed to prepare comparison editor.'
							});
							return;
						}
						const preparedSourceTarget = this.host.getKustoSectionExecutionTarget(boxId);
						if (!preparedSourceTarget || !sameDataTarget(preparedSourceTarget, preparedComparison.kustoTarget)) {
							throw new Error('Kusto comparison target changed.');
						}

						const executeQueryAndPost = async (
							target: KustoSectionExecutionTarget,
							queryText: string,
							comparisonRunForExecution?: (executionId: string) => KustoComparisonRunIdentity,
						) => {
							const executionId = `kusto-comparison-${randomUUID()}`;
							const comparisonRun = comparisonRunForExecution?.(executionId);
							const cancel = () => this.host.cancelKustoSectionExecution(target, executionId);
							const untrack = this.trackCopilotQueryCancel(
								boxId, cts, seq, cancel,
								() => this.host.getKustoSectionExecutionAccountPartition(target, executionId),
								target.boxId,
							);
							try {
								const outcome = await this.host.executeKustoSectionQuery({
									target,
									executionId,
									producer: 'comparison',
									...(comparisonRun ? { comparisonRun } : {}),
									copilotRequestId: kustoRequest.copilotRequestId,
									query: queryText,
									queryMode: copilotQueryMode,
									cacheEnabled: true,
									cacheValue: 1,
									cacheUnit: 'days',
								});
								if (!isActive() || cts.token.isCancellationRequested || outcome.status !== 'success') {
									throw new CopilotExecutionQueryError(new Error(outcome.error || 'Copilot write-query canceled'), queryText);
								}
								return executionId;
							} catch (error) {
								throw error instanceof CopilotExecutionQueryError
									? error
									: new CopilotExecutionQueryError(error, queryText);
							} finally {
								untrack();
							}
						};

						try {
							this.host.deleteComparisonSummary(`${boxId}::${comparisonBoxId}`);
						} catch {
							// ignore
						}

						try {
							let sourceExecutionIdForComparison = '';
							postStatus('Running original query…');
							try {
								const sourceTarget = this.host.getKustoSectionExecutionTarget(boxId);
								if (!sourceTarget) throw new Error('Kusto source target changed.');
								sourceExecutionIdForComparison = await executeQueryAndPost(
									sourceTarget,
									originalQueryForCompare,
									executionId => ({
										sourceBoxId: boxId,
										sourceExecutionId: executionId,
										comparisonBoxId,
									}),
								);
							} catch (error) {
								const originalError = error instanceof CopilotExecutionQueryError ? error.originalError : error;
								const errMsg = this.host.getErrorMessage(originalError);
								if (!isActive() || cts.token.isCancellationRequested || (originalError as Record<string, unknown>)?.isCancelled === true || /canceled|cancelled/i.test(errMsg)) {
									throw new Error('Copilot write-query canceled');
								}
								this.appendToolCallHistoryResult(history, boxId, tc.callId, toolName, { query: candidate }, `Error: original query failed to execute: ${this.host.formatQueryExecutionErrorForUser(originalError, connection, database)}`);
								postRequestMessage({
									type: 'copilotWriteQueryDone',
									boxId,
									ok: false,
									message: 'Query failed to execute.'
								});
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
								preparedComparison = await this.host.ensureComparisonBoxInWebview(boxId, candidate, cts.token, seq, kustoRequest);
								comparisonBoxId = preparedComparison.boxId;
								if (!comparisonBoxId || !preparedComparison.kustoTarget) {
									this.appendToolCallHistoryResult(history, boxId, tc.callId, toolName, { query: candidate }, 'Error: failed to prepare comparison editor.');
									postRequestMessage({
										type: 'copilotWriteQueryDone',
										boxId,
										ok: false,
										message: 'Failed to prepare comparison editor.'
									});
									return;
								}
								const currentSourceTarget = this.host.getKustoSectionExecutionTarget(boxId);
								if (!currentSourceTarget || !sameDataTarget(currentSourceTarget, preparedComparison.kustoTarget)) {
									throw new Error('Kusto comparison target changed.');
								}
								try {
									this.host.deleteComparisonSummary(`${boxId}::${comparisonBoxId}`);
								} catch {
									// ignore
								}

								try {
									if (!sourceExecutionIdForComparison) throw new Error('Kusto comparison source artifact identity is unavailable.');
									await executeQueryAndPost(
										preparedComparison.kustoTarget,
										candidate,
										() => ({ sourceBoxId: boxId, sourceExecutionId: sourceExecutionIdForComparison, comparisonBoxId }),
									);
									executed = true;
									break;
								} catch (error) {
									const originalError = error instanceof CopilotExecutionQueryError ? error.originalError : error;
									const errMsg = this.host.getErrorMessage(originalError);
									if (!isActive() || cts.token.isCancellationRequested || (originalError as Record<string, unknown>)?.isCancelled === true || /canceled|cancelled/i.test(errMsg)) {
										throw new Error('Copilot write-query canceled');
									}
									lastExecErrorText = this.host.formatQueryExecutionErrorForUser(originalError, connection, database);
									if (execAttempt >= maxExecAttempts) {
										this.appendToolCallHistoryResult(history, boxId, tc.callId, toolName, { query: candidate }, `Error: optimized query failed to execute: ${lastExecErrorText || errMsg}`);
										postRequestMessage({
											type: 'copilotWriteQueryDone',
											boxId,
											ok: false,
											message: 'Query failed to execute.'
										});
										return;
									}

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
										candidate = this.getRunnableKustoQuery(fixedQuery);
									}
								}
							}

							if (!executed || !isActive() || cts.token.isCancellationRequested) {
								throw new Error('Copilot write-query canceled');
							}

							await postRequiredRequestMessage({
								type: 'copilotWriteQueryDone',
								boxId,
								ok: true,
								message:
									'Optimized query has been provided, please check the results to make sure the same data is being returned. Keep in mind that count() and dcount() can return slightly different values by design, so we cannot expect a 100% match the entire time.'
							});
							this.appendToolCallHistoryResult(history, boxId, tc.callId, toolName, { query: candidate }, 'Comparison ready. Optimized query executed successfully.');
							return;
						} catch (error) { throw error; }
					}

					if (toolName === 'respond_to_all_other_queries') {
						const rawQuery = this.extractQueryArgument(tc.input);
						const query = this.extractKustoCodeBlock(rawQuery).trim();
						const effectiveQuery = this.getRunnableKustoQuery(query);
						if (!query) {
							this.appendToolCallHistoryResult(history, boxId, tc.callId, toolName, tc.input, 'Error: query argument was empty.');
							priorAttempts.push({ attempt, error: 'Tool call was missing a non-empty query argument.' });
							postStatus('Tool call missing query argument. Retrying…');
							shouldRetryAttempt = true;
							break;
						}

						try {
							postRequestMessage({ type: 'copilotWriteQuerySetQuery', boxId, query: effectiveQuery });
						} catch {
							// ignore
						}

						postStatus('Running query…');
						const target = this.host.getKustoSectionExecutionTarget(boxId);
						if (!target
							|| target.sectionInstanceId !== requestSectionInstanceId
							|| target.targetGeneration !== requestTargetGeneration
							|| target.connectionId !== connection.id
							|| target.database.toLowerCase() !== database.toLowerCase()) {
							throw new Error('Kusto section target changed before Copilot execution.');
						}
						const executionId = `kusto-copilot-${randomUUID()}`;
						const runningRequest = this.runningCopilotWriteQueryByBoxId.get(boxId);
						const finalRun = {
							target,
							executionId,
							getAccountPartition: () => this.host.getKustoSectionExecutionAccountPartition(target, executionId),
						};
						if (runningRequest?.cts === cts && runningRequest.seq === seq) runningRequest.kustoFinalRun = finalRun;
						try {
							const outcome = await this.host.executeKustoSectionQuery({
								target,
								executionId,
								producer: 'copilot',
								copilotRequestId: kustoRequest.copilotRequestId,
								query: effectiveQuery,
								queryMode: copilotQueryMode,
								cacheEnabled: true,
								cacheValue: 1,
								cacheUnit: 'days',
								ensureResultsVisible: true,
							});
							if (cts.token.isCancellationRequested) {
								throw new Error('Copilot write-query canceled');
							}
							if (!isActive()) {
								removeSupersededToolTurnHistory();
								return;
							}
							if (outcome.status === 'superseded') {
								settleSupersededQueryRun();
								return;
							}
							if (outcome.status === 'cancelled') {
								throw new Error('Copilot write-query canceled');
							}
							if (outcome.status === 'failed') {
								throw new Error(outcome.error || 'Query failed to execute.');
							}
							this.appendToolCallHistoryResult(history, boxId, tc.callId, toolName, { query: effectiveQuery }, 'Query ran successfully.');
							postRequestMessage({
								type: 'copilotWriteQueryDone',
								boxId,
								ok: true,
								message: 'Query ran successfully. Review the results and adjust if needed.'
							});
							return;
						} catch (error) {
							if (!isActive()) {
								removeSupersededToolTurnHistory();
								return;
							}
							if (cts.token.isCancellationRequested) {
								throw new Error('Copilot write-query canceled');
							}
							if ((error as Record<string, unknown>)?.name === 'QueryCancelledError' || (error as Record<string, unknown>)?.isCancelled === true) {
								throw new Error('Copilot write-query canceled');
							}
							if (!isActive()) return;

							const userMessage = this.host.formatQueryExecutionErrorForUser(error, connection, database);

							priorAttempts.push({ attempt, query: effectiveQuery, error: userMessage });
							this.appendToolCallHistoryResult(history, boxId, tc.callId, toolName, { query: effectiveQuery }, `Query execution error: ${userMessage}`);
							postStatus('Query failed to execute. Retrying…');
							shouldRetryAttempt = true;
							break;
						} finally {
							const currentRequest = this.runningCopilotWriteQueryByBoxId.get(boxId);
							if (currentRequest?.kustoFinalRun === finalRun) currentRequest.kustoFinalRun = undefined;
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
							effectiveAction = 'remove';
							postRequestMessage({
								type: 'updateDevNotes',
								action: 'remove',
								noteId
							});
							toolResult = `Development note removed (id: ${noteId}).`;
						} else if (!content) {
							toolResult = 'Error: content is required when creating a new note. To remove an existing note, provide its noteId with empty content.';
							effectiveAction = 'save';
						} else {
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
							postRequestMessage({
								type: 'updateDevNotes',
								action: noteId ? 'supersede' : 'add',
								entry,
								supersededId: noteId || undefined
							});
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
							postRequestMessage({
								type: 'copilotDevNoteToolCall',
								boxId,
								entryId: noteEntryId,
								action: effectiveAction,
								category,
								content: content || noteId,
								result: toolResult
							});
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
							postRequestMessage({
								type: 'copilotClarifyingQuestion',
								boxId,
								entryId: questionEntryId,
								question
							});
						} catch {
							// ignore
						}

						vscode.window.showInformationMessage(
							'Kusto Copilot has a clarifying question for you.',
							'View'
						).then(selection => {
							if (selection === 'View') {
								this.host.revealPanel();
								// Expand and scroll to the section so the user can find the question.
								try {
									postRequestMessage({
										type: 'revealSection',
										boxId,
									});
								} catch { /* ignore */ }
							}
						});

						postRequestMessage({
							type: 'copilotWriteQueryDone',
							boxId,
							ok: true,
							message: ''
						});
						return;
					}
				}
				} finally {
					if (!isActive() || cts.token.isCancellationRequested) removeSupersededToolTurnHistory();
					else if (!toolTurnSuperseded) this.ensureAllToolCallsHaveResults(history, historyToolCalls, boxId);
					const currentRequest = this.runningCopilotWriteQueryByBoxId.get(boxId);
					if (currentRequest?.cleanupCurrentToolTurn === removeSupersededToolTurnHistory) {
						currentRequest.cleanupCurrentToolTurn = undefined;
					}
				}

				if (shouldRetryAttempt) {
					continue;
				}

				if (hasOptionalToolCalls) {
					toolTurnCount++;
					if (toolTurnCount >= maxToolTurns) {
						priorAttempts.push({ attempt, error: 'Too many tool turns without a final response.' });
						postStatus('Too many tool turns. Retrying…');
						continue;
					}
					attempt--;
					continue;
				}
			}

			postRequestMessage({
				type: 'copilotWriteQueryDone',
				boxId,
				ok: false,
				message: 'I could not produce a query that runs successfully. Review the latest error and refine your request.'
			});
		} catch (err) {
			if (!isActive()) return;
			const msg = this.host.getErrorMessage(err);
			const canceled = cts.token.isCancellationRequested || /canceled|cancelled/i.test(msg);
			if (canceled) {
				try {
					postRequestMessage({
						type: 'copilotWriteQueryDone',
						boxId,
						ok: false,
						message: 'Canceled.'
					});
				} catch {
					// ignore
				}
				return;
			}
			try {
				postRequestMessage({
					type: 'copilotWriteQueryDone',
					boxId,
					ok: false,
					message: `Copilot request failed: ${msg}`
				});
			} catch {
				// ignore
			}
		} finally {
			try {
				const current = this.runningCopilotWriteQueryByBoxId.get(boxId);
				if (current?.cts === cts && current.seq === seq) {
					current.cleanupCurrentToolTurn = undefined;
					current.cleanupCurrentRequestHistory = undefined;
					this.cancelTrackedCopilotQueries(current);
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

	buildOptimizeQueryPrompt(query: string): string {
		return buildOptimizeQueryPromptFn(query);
	}

	private createRunningOptimize(owner: KustoOptimizeRequestIdentity, query: string): RunningOptimizeQuery | undefined {
		const target = this.host.getKustoSectionExecutionTarget(owner.boxId);
		if (!target
			|| target.sectionInstanceId !== owner.sectionInstanceId
			|| target.targetGeneration !== owner.targetGeneration) return undefined;
		const connection = this.host.findConnection(target.connectionId);
		if (!connection) return undefined;
		let connectionIdentityKey: string;
		try { connectionIdentityKey = getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId); } catch { return undefined; }
		const accountPartition = String(this.host.kustoClient.getAccountPartition(connection) || '').trim() || undefined;
		if (!connectionIdentityKey) return undefined;
		const cts = new vscode.CancellationTokenSource();
		return {
			owner,
			target,
			query,
			connectionIdentityKey,
			connectionRevision: this.host.connectionManager.getConnectionIncarnation(connection.id),
			clusterEndpoint: connection.clusterUrl,
			...(accountPartition ? { accountPartition } : {}),
			leaveNoTraceRevision: this.host.connectionManager.getLeaveNoTraceRevision(connection.clusterUrl),
			cts,
		};
	}

	private retireRunningOptimize(running: RunningOptimizeQuery): void {
		if (this.runningOptimizeByBoxId.get(running.owner.boxId) === running) {
			this.runningOptimizeByBoxId.delete(running.owner.boxId);
		}
		try { running.cts.cancel(); } catch { /* ignore */ }
		try { running.cts.dispose(); } catch { /* ignore */ }
	}

	private async postRunningOptimizeMessage(running: RunningOptimizeQuery, payload: Record<string, unknown>): Promise<boolean> {
		if (this.runningOptimizeByBoxId.get(running.owner.boxId) !== running || running.cts.token.isCancellationRequested) return false;
		const target = this.host.getKustoSectionExecutionTarget(running.owner.boxId);
		if (!target
			|| target.sectionInstanceId !== running.target.sectionInstanceId
			|| target.targetGeneration !== running.target.targetGeneration
			|| target.connectionId !== running.target.connectionId
			|| target.database.toLowerCase() !== running.target.database.toLowerCase()) return false;
		return (await this.host.connectionManager.admitLeaveNoTraceRevision(
			running.clusterEndpoint,
			running.leaveNoTraceRevision,
			async () => {
				if (this.runningOptimizeByBoxId.get(running.owner.boxId) !== running || running.cts.token.isCancellationRequested) return false;
				const connection = this.host.findConnection(running.target.connectionId);
				const currentAccountPartition = String(connection ? this.host.kustoClient.getAccountPartition(connection) || '' : '').trim();
				if (!connection
					|| this.host.connectionManager.getConnectionIncarnation(connection.id) !== running.connectionRevision
					|| getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId) !== running.connectionIdentityKey
					|| !currentAccountPartition
					|| (!!running.accountPartition && currentAccountPartition !== running.accountPartition)) return false;
				running.accountPartition ??= currentAccountPartition;
				return this.host.postKustoPublication({ ...payload, ...running.owner });
			},
		)).value === true;
	}

	private async settleRejectedOptimizePublication(running: RunningOptimizeQuery, error: string): Promise<void> {
		if (this.runningOptimizeByBoxId.get(running.owner.boxId) !== running) return;
		const target = this.host.getKustoSectionExecutionTarget(running.owner.boxId);
		if (target
			&& target.sectionInstanceId === running.owner.sectionInstanceId
			&& target.targetGeneration === running.owner.targetGeneration) {
			await this.host.postKustoPublication({ type: 'optimizeQueryError', error, ...running.owner });
		}
		this.retireRunningOptimize(running);
	}

	async prepareOptimizeQuery(
		message: Extract<IncomingWebviewMessage, { type: 'prepareOptimizeQuery' }>
	): Promise<void> {
		const boxId = String(message.boxId || '').trim();
		const query = String(message.query || '');
		if (!boxId || !hasKustoOptimizeRequestIdentity(message)) {
			return;
		}
		const owner = Object.freeze({
			boxId, optimizeRequestId: message.optimizeRequestId,
			sectionInstanceId: message.sectionInstanceId, targetGeneration: message.targetGeneration,
		});
		const existing = this.runningOptimizeByBoxId.get(boxId);
		if (existing) this.retireRunningOptimize(existing);
		const running = this.createRunningOptimize(owner, query);
		if (!running) {
			await Promise.resolve(this.host.postMessage({ type: 'optimizeQueryError', error: 'The query target changed. Try optimization again.', ...owner }));
			return;
		}
		this.runningOptimizeByBoxId.set(boxId, running);

		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			if (models.length === 0) {
				if (!await this.postRunningOptimizeMessage(running, {
					type: 'optimizeQueryError',
					error: 'Copilot not available',
				})) await this.settleRejectedOptimizePublication(running, 'Copilot not available');
				else this.retireRunningOptimize(running);
				return;
			}

			const modelOptions = models
				.map(m => ({ id: String(m.id), label: this.formatCopilotModelLabel(m) }))
				.filter(m => !!m.id)
				.sort((a, b) => a.label.localeCompare(b.label));

			const lastModelId = this.host.context.globalState.get<string>(STORAGE_KEYS.lastOptimizeCopilotModelId);
			const preferredModelId = String(lastModelId || '').trim();
			const defaultModelId = findPreferredDefaultCopilotModel(models)?.id || '';
			const selectedModelId = preferredModelId && modelOptions.some(m => m.id === preferredModelId)
				? preferredModelId
				: defaultModelId;

			if (!await this.postRunningOptimizeMessage(running, {
				type: 'optimizeQueryOptions',
				models: modelOptions,
				selectedModelId,
				promptText: this.buildOptimizeQueryPrompt(query),
			})) {
				await this.settleRejectedOptimizePublication(running, 'Authentication or privacy state changed while preparing optimization.');
			}
		} catch (err: any) {
			if (this.runningOptimizeByBoxId.get(boxId) !== running) return;
			const errorMsg = err?.message || String(err);
			this.host.output.error('Failed to prepare optimize query options:', err instanceof Error ? err : String(err));
			if (!await this.postRunningOptimizeMessage(running, {
				type: 'optimizeQueryError',
				error: errorMsg,
			})) await this.settleRejectedOptimizePublication(running, errorMsg);
			else this.retireRunningOptimize(running);
		}
	}

	cancelOptimizeQuery(expected: KustoOptimizeRequestIdentity): void {
		if (!hasKustoOptimizeRequestIdentity(expected)) {
			return;
		}
		const running = this.runningOptimizeByBoxId.get(expected.boxId);
		if (!running || !kustoOptimizeRequestIdentityEquals(running.owner, expected)) {
			return;
		}
		this.retireRunningOptimize(running);
	}

	async optimizeQueryWithCopilot(
		message: Extract<IncomingWebviewMessage, { type: 'optimizeQuery' }>
	): Promise<void> {
		const { query, connectionId, database, boxId, queryName, modelId, promptText } = message;
		const id = String(boxId || '').trim();
		if (!id || !hasKustoOptimizeRequestIdentity(message)) {
			return;
		}
		const owner = Object.freeze({
			boxId: id, optimizeRequestId: message.optimizeRequestId,
			sectionInstanceId: message.sectionInstanceId, targetGeneration: message.targetGeneration,
		});
		let running = this.runningOptimizeByBoxId.get(id);
		if (!running || !kustoOptimizeRequestIdentityEquals(running.owner, owner) || running.query !== String(query || '')) {
			if (running) this.retireRunningOptimize(running);
			running = this.createRunningOptimize(owner, String(query || ''));
			if (!running) {
				await Promise.resolve(this.host.postMessage({ type: 'optimizeQueryError', error: 'The query target changed. Try optimization again.', ...owner }));
				return;
			}
			this.runningOptimizeByBoxId.set(id, running);
		}
		const cts = running.cts;
		const isActive = () => {
			const current = this.runningOptimizeByBoxId.get(id);
			return current === running && kustoOptimizeRequestIdentityEquals(current.owner, owner);
		};
		const postOwnedMessage = (payload: Record<string, unknown>) => this.postRunningOptimizeMessage(running!, payload);

		const postStatus = async (status: string) => {
			try {
				return await postOwnedMessage({ type: 'optimizeQueryStatus', status });
			} catch {
				return false;
			}
		};

		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			if (models.length === 0) {
				vscode.window.showWarningMessage('GitHub Copilot is not available. Please enable Copilot to use query optimization.');
				if (!await postOwnedMessage({
					type: 'optimizeQueryError',
					error: 'Copilot not available'
				})) await this.settleRejectedOptimizePublication(running, 'Copilot not available');
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
				await this.host.context.globalState.update(STORAGE_KEYS.lastOptimizeCopilotModelId, String(model.id));
			} catch {
				// ignore
			}

			if (!await postStatus('Sending request to Copilot…')) {
				await this.settleRejectedOptimizePublication(running, 'Optimization canceled because the query target or privacy state changed.');
				return;
			}

			const effectivePromptText = String(promptText || '').trim() || this.buildOptimizeQueryPrompt(query);

			const response = await model.sendRequest(
				[vscode.LanguageModelChatMessage.User(effectivePromptText)],
				{},
				cts.token
			);

			if (!await postStatus('Waiting for Copilot response…')) {
				await this.settleRejectedOptimizePublication(running, 'Optimization canceled because the query target or privacy state changed.');
				return;
			}

			let optimizedQuery = '';
			for await (const fragment of response.text) {
				if (cts.token.isCancellationRequested) {
					throw new Error('Optimization canceled');
				}
				optimizedQuery += fragment;
			}

			if (!await postStatus('Parsing optimized query…')) {
				await this.settleRejectedOptimizePublication(running, 'Optimization canceled because the query target or privacy state changed.');
				return;
			}

			const codeBlockMatch = optimizedQuery.match(/```(?:kusto|kql)?\s*\n([\s\S]*?)\n```/);
			if (codeBlockMatch) {
				optimizedQuery = codeBlockMatch[1].trim();
			} else {
				optimizedQuery = optimizedQuery.trim();
			}

			if (!optimizedQuery) {
				throw new Error('Failed to extract optimized query from Copilot response');
			}

			optimizedQuery = this.getRunnableKustoQuery(optimizedQuery);

			if (!await postStatus('Done. Creating comparison…')) {
				await this.settleRejectedOptimizePublication(running, 'Optimization canceled because the query target or privacy state changed.');
				return;
			}

			if (!await postOwnedMessage({
				type: 'optimizeQueryReady',
				optimizedQuery,
				queryName,
				connectionId,
				database
			})) await this.settleRejectedOptimizePublication(running, 'Optimization canceled because the query target or privacy state changed.');

		} catch (err: any) {
			if (!isActive()) return;
			const errorMsg = err?.message || String(err);
			this.host.output.error('Query optimization failed:', err instanceof Error ? err : String(err));
			const canceled = cts.token.isCancellationRequested || /cancel/i.test(errorMsg);
			if (canceled) {
				try {
					if (!await postOwnedMessage({ type: 'optimizeQueryError', error: 'Optimization canceled' })) {
						await this.settleRejectedOptimizePublication(running, 'Optimization canceled');
					}
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

			if (!await postOwnedMessage({
				type: 'optimizeQueryError',
				error: errorMsg
			})) await this.settleRejectedOptimizePublication(running, errorMsg);
		} finally {
			try {
				if (this.runningOptimizeByBoxId.get(id) === running) this.retireRunningOptimize(running);
			} catch {
				// ignore
			}
			try {
				if (!cts.token.isCancellationRequested) cts.dispose();
			} catch {
				// ignore
			}
		}
	}

	// ── SQL Copilot ───────────────────────────────────────────────────────────

	private buildSqlMessagesFromHistory(args: {
		boxId: string;
		serverUrl: string;
		database: string;
		schemaText: string;
		priorAttempts?: Array<{ attempt: number; query?: string; error?: string }>;
	}, requestHistory?: ConversationHistoryEntry[]): vscode.LanguageModelChatMessage[] {
		const history = requestHistory ?? this.copilotConversationHistoryByBoxId.get(args.boxId) ?? [];
		sanitizeConversationHistory(history);

		const messages: vscode.LanguageModelChatMessage[] = [];

		const preambleParts: string[] = [];
		preambleParts.push('Role: You are a senior T-SQL engineer.');
		preambleParts.push('Task: Write a complete, runnable T-SQL query for the user request.');
		preambleParts.push('');
		preambleParts.push('Context:');
		preambleParts.push(`- Server: ${args.serverUrl || '(unknown)'}`);
		preambleParts.push(`- Database: ${args.database || '(unknown)'}`);
		if (args.schemaText) {
			preambleParts.push(`\nDatabase Schema:\n${args.schemaText}`);
		}
		preambleParts.push('');
		preambleParts.push('RESPONSE FORMAT RULES:');
		preambleParts.push('- Use the provided tools to accomplish your task. You have access to tools for getting schema, executing queries, and delivering your final query.');
		preambleParts.push('- Use as many tool calls as needed across turns: get schema, execute queries, then finish with the respond_to_sql_query tool.');
		preambleParts.push('- Always provide the FULL query (not a diff) as the tool argument.');
		preambleParts.push('- If you cannot fulfill the request, use the ask_user_clarifying_question tool.');
		messages.push(vscode.LanguageModelChatMessage.User(preambleParts.join('\n')));

		for (const batch of groupConversationHistoryForProvider(history)) {
			if (batch.type === 'tool-results') {
				this.appendToolResultBatchMessage(messages, batch.entries);
				continue;
			}
			const entry = batch.entry;
			if (entry.type === 'general-rules') {
				if (entry.removed) {
					messages.push(vscode.LanguageModelChatMessage.User(
						'[SQL query rules: truncated from conversation history, refer to your knowledge if needed]'
					));
				} else {
					messages.push(vscode.LanguageModelChatMessage.User(
						'SQL query rules (from copilot-instructions/sql-query-rules.md):\n' + entry.content
					));
				}
			} else if (entry.type === 'user-message') {
				let text = entry.text;
				if (entry.querySnapshot) {
					text += '\n\nCurrent query in editor:\n```sql\n' + entry.querySnapshot + '\n```';
				}
				messages.push(vscode.LanguageModelChatMessage.User(text));
			} else if (entry.type === 'assistant-message') {
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
			}
		}

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

		return this.sanitizeProviderToolMessageSequence(messages);
	}

	async startSqlCopilotWriteQuery(
		message: {
			boxId: string;
			sqlConnectionId: string;
			database: string;
			request: string;
			currentQuery?: string;
			modelId?: string;
			enabledTools?: string[];
			sqlOwnerToken?: string;
		},
		sqlConnectionManager: SqlConnectionManager,
		sqlSchemaService: SqlSchemaService,
		sqlClient?: SqlQueryClient,
	): Promise<void> {
		const boxId = String(message.boxId || '').trim();
		const sqlConnectionId = String(message.sqlConnectionId || '').trim();
		const database = String(message.database || '').trim();
		const request = String(message.request || '').trim();
		const currentQuery = String(message.currentQuery || '').trim();
		const requestedModelId = String(message.modelId || '').trim();
		const enabledToolsRaw = Array.isArray(message.enabledTools) ? message.enabledTools : [];
		const enabledTools = enabledToolsRaw.map((t) => this.normalizeToolName(t)).filter(Boolean);
		const ownerToken = String(message.sqlOwnerToken || '');
		const postSqlMessage = (outgoing: Record<string, unknown>) => this.host.postMessage({ ...outgoing, ownerToken });
		if (!boxId || !sqlConnectionId || !database || !request) {
			postSqlMessage({
				type: 'copilotWriteQueryDone', boxId,
				ok: false, message: 'Select a SQL connection and database, then enter what you want the query to do.',
			});
			return;
		}

		try {
			const existing = this.runningCopilotWriteQueryByBoxId.get(boxId);
			if (existing) {
				existing.cleanupCurrentRequestHistory?.();
				this.settleOwnedCopilotExecutions(existing);
				this.cancelTrackedCopilotQueries(existing);
				existing.cts.cancel();
				this.runningCopilotWriteQueryByBoxId.delete(boxId);
			}
		} catch { /* ignore */ }
		const cts = new vscode.CancellationTokenSource();
		const seq = ++this.copilotWriteSeq;
		this.createRunningCopilotWriteQuery(boxId, cts, seq);
		const isActive = () => {
			const current = this.runningCopilotWriteQueryByBoxId.get(boxId);
			return !!current && current.cts === cts && current.seq === seq;
		};
		const finishPreflight = (message?: string) => {
			if (message && isActive()) {
				postSqlMessage({ type: 'copilotWriteQueryDone', boxId, ok: false, message });
			}
			const current = this.runningCopilotWriteQueryByBoxId.get(boxId);
			if (current?.cts === cts && current.seq === seq) this.runningCopilotWriteQueryByBoxId.delete(boxId);
			try { cts.dispose(); } catch { /* ignore */ }
		};
		try {
			await this.host.assertSqlConnectionAllowed(sqlConnectionId);
		} catch {
			finishPreflight(cts.token.isCancellationRequested ? 'Canceled.' : SQL_COPILOT_OWNER_CHANGED_MESSAGE);
			return;
		}
		if (!isActive() || cts.token.isCancellationRequested) {
			finishPreflight(isActive() ? 'Canceled.' : undefined);
			return;
		}
		const requestOwner = this.host.getSqlResultOwner(boxId);
		if (!requestOwner || requestOwner.connectionId !== sqlConnectionId || requestOwner.database !== database) {
			finishPreflight('SQL section target changed. Retry the request.');
			return;
		}
		const assertRequestOwner = (targetBoxId: string = boxId) => this.host.assertSqlResultOwnerAllowed(targetBoxId, requestOwner);
		const previousOwner = this.copilotConversationOwnerByBoxId.get(boxId);
		if (previousOwner && (
			previousOwner.flavor !== 'sql'
			|| previousOwner.connectionId !== sqlConnectionId
			|| previousOwner.database !== database
			|| previousOwner.generation !== requestOwner.generation
			|| previousOwner.targetSignature !== requestOwner.targetSignature
			|| previousOwner.principalFingerprint !== requestOwner.principalFingerprint
		)) {
			this.clearCopilotConversation(boxId);
		}
		try {
			await this.host.dispatchSqlResultOwnerAllowed(boxId, requestOwner, () => {
				this.copilotConversationOwnerByBoxId.set(boxId, {
					flavor: 'sql', connectionId: sqlConnectionId, database,
					generation: requestOwner.generation, targetSignature: requestOwner.targetSignature,
					principalFingerprint: requestOwner.principalFingerprint,
				});
			});
		} catch {
			finishPreflight(cts.token.isCancellationRequested ? 'Canceled.' : SQL_COPILOT_OWNER_CHANGED_MESSAGE);
			return;
		}
		if (!isActive() || cts.token.isCancellationRequested) {
			finishPreflight(isActive() ? 'Canceled.' : undefined);
			return;
		}
		const history = structuredClone(this.copilotConversationHistoryByBoxId.get(boxId) ?? []);
		let requestIncludesGeneralRules = this.copilotGeneralRulesSentPerBox.has(boxId);
		const assertActiveOwner = async (targetBoxId: string = boxId) => {
			if (!isActive() || cts.token.isCancellationRequested) throw new Error('SQL Copilot write-query canceled');
			await assertRequestOwner(targetBoxId);
			if (!isActive() || cts.token.isCancellationRequested) throw new Error('SQL Copilot write-query canceled');
		};
		const dispatchActiveOwner = <T>(targetBoxId: string, dispatch: () => T | PromiseLike<T>) =>
			this.host.dispatchSqlResultOwnerAllowed(targetBoxId, requestOwner, () => {
				if (!isActive() || cts.token.isCancellationRequested) throw new Error('SQL Copilot write-query canceled');
				return dispatch();
			});
		const startCopilotSqlExecution = async <T extends { cancel: () => void }>(
			targetBoxId: string,
			start: () => T,
			publishedQuery?: string,
			comparisonSource?: { sourceBoxId: string; sourceExecutionId: string },
		) => {
			const executionId = `sql-copilot-${randomUUID()}`;
			const preflight = this.host.sqlExecutionBroker.reservePreflight(targetBoxId, executionId);
			let lease;
			let publishedStart = false;
			let settled = false;
			const settleExecution = () => {
				if (!publishedStart || settled) return;
				settled = true;
				try {
					this.host.postMessage({
						type: 'copilotWriteQueryExecuting', boxId: targetBoxId, executing: false,
						executionId, ownerToken,
					});
				} catch { /* best effort */ }
			};
			try {
				await assertActiveOwner(targetBoxId);
				const admission = this.host.sqlExecutionBroker.promotePreflight(preflight);
				if (!admission) throw new Error('SQL Copilot write-query canceled');
				if (publishedQuery !== undefined) {
					await dispatchActiveOwner(targetBoxId, () => this.postRequiredMessage({
						type: 'copilotWriteQueryExecuting', boxId: targetBoxId, executing: true,
						executionId, ownerToken, query: publishedQuery,
						...(comparisonSource || {}),
					}));
					publishedStart = true;
					await assertActiveOwner(targetBoxId);
					if (!this.host.sqlExecutionBroker.isPendingCurrent(admission)) {
						throw new Error('SQL Copilot write-query canceled');
					}
				}
				lease = this.host.sqlExecutionBroker.start(admission, () => {
					const started = start();
					const originalCancel = started.cancel;
					started.cancel = this.createOneShotCancel(() => originalCancel.call(started));
					return started;
				});
			} catch (error) {
				this.host.sqlExecutionBroker.clearPreflight(preflight);
				this.host.sqlExecutionBroker.cancelExpected(targetBoxId, executionId, false);
				settleExecution();
				throw error;
			}
			const untrack = this.trackCopilotQueryCancel(boxId, cts, seq, () => {
				settleExecution();
				lease.cancel();
			}, undefined, targetBoxId);
			return {
				execution: lease.execution,
				runSeq: lease.runSeq,
				executionId: lease.executionId,
				isCurrent: lease.isCurrent,
				settleExecution,
				release: () => {
					untrack();
					lease.release();
				},
			};
		};
		const commitRequestHistory = async (afterCommit?: () => void) => {
			await assertActiveOwner();
			await dispatchActiveOwner(boxId, () => {
				this.copilotConversationHistoryByBoxId.set(boxId, history);
				if (requestIncludesGeneralRules) this.copilotGeneralRulesSentPerBox.add(boxId);
				afterCommit?.();
			});
		};

		const postStatus = (text: string, detail?: string) => {
			void dispatchActiveOwner(boxId, () => {
				try { postSqlMessage({ type: 'copilotWriteQueryStatus', boxId, status: text, detail: detail || '' }); } catch { /* ignore */ }
			}).catch(() => undefined);
		};
		const postNarrative = (text: string) => {
			try {
				postSqlMessage({ type: 'copilotWriteQueryStatus', boxId, status: text, role: 'assistant' });
			} catch { /* ignore */ }
		};

		try {
			await assertActiveOwner();
			// 1. Select model.
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			if (models.length === 0) {
				await dispatchActiveOwner(boxId, () => {
					postSqlMessage({ type: 'copilotWriteQueryDone', boxId, ok: false, message: 'GitHub Copilot is not available.' });
				});
				return;
			}
			let model = requestedModelId
				? models.find(m => m.id === requestedModelId) || null
				: null;
			if (!model) model = findPreferredDefaultCopilotModel(models) || models[0];
			if (requestedModelId && requestedModelId !== model.id) {
				await this.host.context.globalState.update(STORAGE_KEYS.lastOptimizeCopilotModelId, model.id);
			}

			// 2. Get SQL schema context (pre-fetched for preamble).
			const connection = sqlConnectionManager.getConnection(sqlConnectionId);
			let schemaText = '';
			if (connection) {
				const schemaAbort = new AbortController();
				const schemaCancellation = cts.token.onCancellationRequested?.(() => schemaAbort.abort());
				try {
					await assertActiveOwner();
					const { schema } = await sqlSchemaService.getSchema(connection, database, false, {
						signal: schemaAbort.signal,
						expectedOwner: {
							targetSignature: requestOwner.targetSignature,
							principalFingerprint: requestOwner.principalFingerprint,
						},
					});
					await assertActiveOwner();
					if (schema?.tables?.length) {
						const parts: string[] = [];
						for (const tableName of schema.tables) {
							const cols = schema.columnsByTable?.[tableName];
							if (cols) {
								const colDefs = Object.entries(cols).map(([n, t]) => `  ${n} (${t})`).join('\n');
								parts.push(`Table: ${tableName}\n${colDefs}`);
							} else {
								parts.push(`Table: ${tableName}`);
							}
						}
						schemaText = parts.join('\n\n');
					}
				} catch (e) {
					await assertActiveOwner();
					try {
						await dispatchActiveOwner(boxId, () => {
							this.host.output.warn(`[sql-copilot] schema fetch error: ${sanitizeStsLogText(e)}`);
						});
					} catch {
						this.host.output.warn('[sql-copilot] Schema fetch failed after owner invalidation; details suppressed.');
					}
				} finally {
					schemaCancellation?.dispose();
				}
			}

			// 3. Load SQL query rules.
			let sqlRulesText = '';
			let sqlRulesFilePath = '';
			try {
				const rulesPath = vscode.Uri.joinPath(this.host.extensionUri, 'copilot-instructions', 'sql-query-rules.md');
				const buf = await vscode.workspace.fs.readFile(rulesPath);
				sqlRulesText = Buffer.from(buf).toString('utf8');
				sqlRulesFilePath = rulesPath.fsPath;
			} catch { /* ignore — rules file is optional */ }
			await assertActiveOwner();

			// 4. Build conversation history.
			// Insert rules on first turn.
			if (sqlRulesText && !requestIncludesGeneralRules) {
				requestIncludesGeneralRules = true;
				const rulesEntryId = this.nextHistoryEntryId(boxId);
				await dispatchActiveOwner(boxId, () => {
					history.push({ type: 'general-rules', content: sqlRulesText, filePath: sqlRulesFilePath, id: rulesEntryId, timestamp: Date.now() });
					try { postSqlMessage({
						type: 'copilotGeneralQueryRulesLoaded', boxId, entryId: rulesEntryId,
						filePath: sqlRulesFilePath, preview: sqlRulesText,
					});
					} catch { /* ignore */ }
				});
			}

			// User message.
			const userMessageEntryId = this.nextHistoryEntryId(boxId);
			await dispatchActiveOwner(boxId, () => {
				history.push({ type: 'user-message', text: request, id: userMessageEntryId, querySnapshot: currentQuery || undefined, timestamp: Date.now() });
				if (currentQuery) {
					try { postSqlMessage({ type: 'copilotUserQuerySnapshot', boxId, entryId: userMessageEntryId, queryText: currentQuery }); } catch { /* ignore */ }
				}
			});

			// 5. Build tools and run agentic loop.
			const tools = this.getSqlCopilotChatTools(enabledTools);
			const priorAttempts: Array<{ attempt: number; query?: string; error?: string }> = [];
			const serverUrl = connection?.serverUrl || '(unknown)';

			const maxAttempts = 6;
			const maxToolTurns = 100;
			let toolTurnCount = 0;
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				await assertActiveOwner();
				if (!isActive() || cts.token.isCancellationRequested) {
					throw new Error('SQL Copilot write-query canceled');
				}
				postStatus(`Generating query (attempt ${attempt}/${maxAttempts})…`);

				const messages = this.buildSqlMessagesFromHistory({
					boxId, serverUrl, database, schemaText, priorAttempts
				}, history);

				await assertActiveOwner();
				const response = await this.host.dispatchSqlResultOwnerAllowed(
					boxId,
					requestOwner,
					() => model.sendRequest(messages, { tools }, cts.token),
				);

				const nativeToolCalls: vscode.LanguageModelToolCallPart[] = [];
				let responseText = '';
				for await (const part of response.stream) {
					if (!isActive() || cts.token.isCancellationRequested) {
						throw new Error('SQL Copilot write-query canceled');
					}
					if (part instanceof vscode.LanguageModelTextPart) {
						responseText += part.value;
					} else if (part instanceof vscode.LanguageModelToolCallPart) {
						nativeToolCalls.push(part);
					}
				}
				await assertActiveOwner();

				if (nativeToolCalls.length === 0) {
					// No tool calls — accept the text response
					const decision = decideNonToolResponse(false);
					const assistantEntryId = this.nextHistoryEntryId(boxId);
					await dispatchActiveOwner(boxId, () => {
						if (responseText.trim() && !decision.suppressNarrative) postNarrative(responseText.trim());
						history.push({
							type: 'assistant-message', id: assistantEntryId, text: responseText, timestamp: Date.now(),
						});
						this.copilotConversationHistoryByBoxId.set(boxId, history);
						if (requestIncludesGeneralRules) this.copilotGeneralRulesSentPerBox.add(boxId);
						postSqlMessage({ type: 'copilotWriteQueryDone', boxId, ok: true, message: '' });
					});
					return;
				}

				const historyToolCalls = this.toHistoryToolCalls(nativeToolCalls, tools);
				if (historyToolCalls.length === 0) {
					priorAttempts.push({ attempt, error: 'Copilot returned malformed tool calls without valid tool names.' });
					postStatus('Copilot returned malformed tool calls. Retrying…');
					continue;
				}

				// Record assistant message with tool calls
				const assistantEntryId = this.nextHistoryEntryId(boxId);
				await dispatchActiveOwner(boxId, () => {
					history.push({
						type: 'assistant-message', id: assistantEntryId, text: responseText,
						toolCalls: historyToolCalls, timestamp: Date.now(),
					});
					if (responseText.trim()) postNarrative(responseText.trim());
				});

				// Process tool calls
				let shouldRetryAttempt = false;
				let hasOptionalToolCalls = false;

				try {
				for (const tc of nativeToolCalls) {
						await assertActiveOwner();
					if (!isActive()) throw new Error('SQL Copilot write-query canceled');
					const toolName = this.normalizeToolName(tc.name);

					if (toolName === 'get_sql_schema') {
						const schemaResult = schemaText || 'No schema available.';
						const schemaEntryId = this.nextHistoryEntryId(boxId);
						await dispatchActiveOwner(boxId, () => {
							history.push({
								type: 'tool-call', id: schemaEntryId, callId: tc.callId,
								tool: 'get_sql_schema', args: {}, result: schemaResult, timestamp: Date.now(),
							});
							try { postSqlMessage({
								type: 'copilotWriteQueryToolResult', boxId, entryId: schemaEntryId,
								tool: 'get_sql_schema', label: `Schema: ${database}`, json: schemaResult,
							}); } catch { /* ignore */ }
						});
						hasOptionalToolCalls = true;
						continue;
					}

					if (toolName === 'get_query_optimization_best_practices') {
						const bestPracticesResult = await this.readOptimizeQueryRules('sql');
						await assertActiveOwner();
						const bpEntryId = this.nextHistoryEntryId(boxId);
						await dispatchActiveOwner(boxId, () => {
							history.push({
								type: 'tool-call', id: bpEntryId, callId: tc.callId,
								tool: 'get_query_optimization_best_practices', result: bestPracticesResult, timestamp: Date.now(),
							});
							try { postSqlMessage({
								type: 'copilotWriteQueryToolResult', boxId, entryId: bpEntryId,
								tool: 'get_query_optimization_best_practices', label: 'optimize-sql-rules.md', json: bestPracticesResult,
							}); } catch { /* ignore */ }
						});
						hasOptionalToolCalls = true;
						continue;
					}

					if (toolName === 'execute_sql_query') {
						const query = this.extractQueryArgument(tc.input);
						if (!query) {
							const errEntryId = this.nextHistoryEntryId(boxId);
							history.push({
								type: 'tool-call', id: errEntryId, callId: tc.callId,
								tool: 'execute_sql_query', args: tc.input,
								result: 'Error: query argument was empty.', timestamp: Date.now()
							});
							hasOptionalToolCalls = true;
							continue;
						}
						if (!sqlClient || !connection) {
							const errEntryId = this.nextHistoryEntryId(boxId);
							history.push({
								type: 'tool-call', id: errEntryId, callId: tc.callId,
								tool: 'execute_sql_query', args: { query },
								result: 'Error: SQL client not available.', timestamp: Date.now()
							});
							hasOptionalToolCalls = true;
							continue;
						}
						let admitted: {
							execution: ReturnType<SqlQueryClient['executeQueryCancelable']>;
							runSeq: number;
							executionId: string;
							isCurrent: () => boolean;
							release: () => void;
						} | undefined;
						try {
							const limitedQuery = query.replace(/;\s*$/, '');
							const hasTop = /\bTOP\b/i.test(limitedQuery);
							const finalExecQuery = hasTop ? limitedQuery : limitedQuery.replace(
								/\bSELECT\b/i, 'SELECT TOP 100'
							);
							admitted = await startCopilotSqlExecution(
								boxId,
								() => sqlClient.executeQueryCancelable(connection, database, finalExecQuery),
							);
							const activeAdmission = admitted;
							const result = await activeAdmission.execution.promise;
								if (!activeAdmission.isCurrent() || !isActive() || cts.token.isCancellationRequested) {
									throw new Error('SQL Copilot write-query canceled');
								}

								await assertActiveOwner();
								if (!activeAdmission.isCurrent()) throw new Error('SQL Copilot write-query canceled');
								const rows = result.rows || [];
								const queryResultText = formatQueryResultForCopilot(result);

								const execEntryId = this.nextHistoryEntryId(boxId);
								await this.host.refreshSqlConnectionsData?.();
								await assertActiveOwner();
								if (!activeAdmission.isCurrent()) throw new Error('SQL Copilot write-query canceled');
							await this.host.dispatchSqlResultOwnerAllowed(boxId, requestOwner, () => {
								if (!activeAdmission.isCurrent() || !isActive() || cts.token.isCancellationRequested) throw new Error('SQL Copilot write-query canceled');
									history.push({
										type: 'tool-call', id: execEntryId, callId: tc.callId,
										tool: 'execute_sql_query', args: { query },
										result: queryResultText, timestamp: Date.now()
									});
									try {
										postSqlMessage({
											type: 'copilotExecutedQuery', boxId,
											entryId: execEntryId, query,
											resultSummary: rows.length > 0 ? `${rows.length} rows` : 'No results', executionId: activeAdmission.executionId,
											result
										});
									} catch { /* ignore */ }
							});
							hasOptionalToolCalls = true;
							continue;
						} catch (e) {
							if (!admitted?.isCurrent() || e instanceof SqlLeaveNoTraceBlockedError) throw new Error('SQL Copilot write-query canceled');
							await assertActiveOwner();
							if (!admitted.isCurrent()) throw new Error('SQL Copilot write-query canceled');
							const errMsg = e instanceof Error ? e.message : String(e);
							if (!isActive() || cts.token.isCancellationRequested || e instanceof SqlQueryCancelledError || (e as any)?.isCancelled === true || /canceled|cancelled/i.test(errMsg)) {
								throw new Error('SQL Copilot write-query canceled');
							}
							const execErrEntryId = this.nextHistoryEntryId(boxId);
							await dispatchActiveOwner(boxId, () => {
								if (!admitted?.isCurrent()) throw new Error('SQL Copilot write-query canceled');
								history.push({
									type: 'tool-call', id: execErrEntryId, callId: tc.callId,
									tool: 'execute_sql_query', args: { query },
									result: `Query execution error: ${errMsg}`, timestamp: Date.now(),
								});
								try { postSqlMessage({
									type: 'copilotExecutedQuery', boxId, entryId: execErrEntryId, query,
									resultSummary: 'Error', errorMessage: errMsg, executionId: admitted.executionId,
								}); } catch { /* ignore */ }
							});
							hasOptionalToolCalls = true;
							continue;
						} finally {
							admitted?.release();
						}
					}

					if (toolName === 'respond_to_query_performance_optimization_request') {
						const rawQuery = this.extractQueryArgument(tc.input);
						const improvedQuery = rawQuery.replace(/```(?:sql|tsql)?\s*\n([\s\S]*?)```/gi, '$1').trim();
						if (!improvedQuery) {
							this.appendToolCallHistoryResult(history, boxId, tc.callId, toolName, tc.input, 'Error: query argument was empty.');
							priorAttempts.push({ attempt, error: 'Tool call was missing a non-empty query argument.' });
							postStatus('Tool call missing query argument. Retrying…');
							shouldRetryAttempt = true;
							break;
						}

						const originalQueryForCompare = currentQuery;

						postStatus('Preparing comparison editor…');
						let comparisonOutcome!: Promise<{ ok: true; comparison: PreparedComparisonSection } | { ok: false; error: unknown }>;
						await dispatchActiveOwner(boxId, () => {
							comparisonOutcome = this.host.ensureComparisonBoxInWebview(boxId, improvedQuery, cts.token, seq).then(
								comparison => ({ ok: true as const, comparison }),
								error => ({ ok: false as const, error }),
							);
						});
						const preparedComparison = await comparisonOutcome;
						if (!preparedComparison.ok) throw preparedComparison.error;
						const comparisonBoxId = preparedComparison.comparison.boxId;
						await assertActiveOwner();
						if (!comparisonBoxId) {
							this.appendToolCallHistoryResult(history, boxId, tc.callId, toolName, { query: improvedQuery }, 'Error: failed to prepare comparison editor.');
							await commitRequestHistory(() => {
								postSqlMessage({ type: 'copilotWriteQueryDone', boxId, ok: false, message: 'Failed to prepare comparison editor.' });
							});
							return;
						}

						try {
							this.host.deleteComparisonSummary(`${boxId}::${comparisonBoxId}`);
						} catch { /* ignore */ }

						// Run both queries if sqlClient is available
						if (sqlClient && connection) {
							const comparisonAdmissions: Array<{
								executionId: string;
								isCurrent: () => boolean;
								settleExecution: () => void;
								release: () => void;
							}> = [];
							const executeSqlAndPost = async (
								targetBoxId: string,
								queryText: string,
								cancelSuffix: string,
								failureMessage: string,
							) => {
								const admitted = await startCopilotSqlExecution(
									targetBoxId,
									() => sqlClient.executeQueryCancelable(connection, database, queryText),
									queryText,
									targetBoxId === comparisonBoxId && comparisonAdmissions[0]
										? { sourceBoxId: boxId, sourceExecutionId: comparisonAdmissions[0].executionId }
										: undefined,
								);
								let retained = false;
								try {
									const result = await admitted.execution.promise;
									if (!admitted.isCurrent() || !isActive() || cts.token.isCancellationRequested) throw new Error('SQL Copilot write-query canceled');
									await assertActiveOwner(targetBoxId);
									if (!admitted.isCurrent() || !isActive() || cts.token.isCancellationRequested) throw new Error('SQL Copilot write-query canceled');
									await this.host.refreshSqlConnectionsData?.();
									await assertActiveOwner(targetBoxId);
									if (!admitted.isCurrent()) throw new Error('SQL Copilot write-query canceled');
									await this.host.dispatchSqlResultOwnerAllowed(targetBoxId, requestOwner, async () => {
										if (!admitted.isCurrent() || !isActive() || cts.token.isCancellationRequested) throw new Error('SQL Copilot write-query canceled');
										await this.postRequiredMessage({
											type: 'queryResult', result, boxId: targetBoxId,
											executionId: admitted.executionId, ownerToken, query: queryText,
											connectionId: requestOwner.connectionId, database: requestOwner.database,
										});
										if (!admitted.isCurrent() || !isActive() || cts.token.isCancellationRequested) throw new Error('SQL Copilot write-query canceled');
									});
									retained = true;
									return admitted;
								} catch (error) {
									if (!admitted.isCurrent()) throw new Error('SQL Copilot write-query canceled');
									await assertActiveOwner(targetBoxId);
									if (!admitted.isCurrent()) throw new Error('SQL Copilot write-query canceled');
									const errMsg = error instanceof Error ? error.message : String(error);
									if (!isActive() || cts.token.isCancellationRequested || error instanceof SqlQueryCancelledError || (error as any)?.isCancelled === true || /canceled|cancelled/i.test(errMsg)) {
										throw new Error('SQL Copilot write-query canceled');
									}
									await dispatchActiveOwner(targetBoxId, () => {
										if (!admitted.isCurrent()) throw new Error('SQL Copilot write-query canceled');
										this.host.output.error(`[sql-copilot] ${cancelSuffix} query execution error: ${sanitizeStsLogText(errMsg)}`);
										try { postSqlMessage({ type: 'queryError', error: failureMessage, boxId: targetBoxId, executionId: admitted.executionId }); } catch { /* ignore */ }
									});
									throw error;
								} finally {
									if (!retained) admitted.release();
								}
							};

							try {
								postStatus('Running original query…');
								comparisonAdmissions.push(await executeSqlAndPost(boxId, originalQueryForCompare, 'source', 'Original query failed to execute.'));
								if (comparisonAdmissions.some(admission => !admission.isCurrent())) throw new Error('SQL Copilot write-query canceled');

								postStatus('Running optimized query…');
								comparisonAdmissions.push(await executeSqlAndPost(comparisonBoxId, improvedQuery, 'comparison', 'Optimized query failed to execute.'));
								if (comparisonAdmissions.some(admission => !admission.isCurrent())) throw new Error('SQL Copilot write-query canceled');

								await dispatchActiveOwner(boxId, async () => {
									if (comparisonAdmissions.some(admission => !admission.isCurrent())) throw new Error('SQL Copilot write-query canceled');
									await this.postRequiredMessage({
										type: 'copilotWriteQueryDone', boxId, ok: true,
										message: 'Comparison ready. Review the results side by side.', ownerToken,
									});
									if (comparisonAdmissions.some(admission => !admission.isCurrent())) throw new Error('SQL Copilot write-query canceled');
								});
								this.appendToolCallHistoryResult(history, boxId, tc.callId, toolName, { query: improvedQuery }, 'Comparison ready. Review the results side by side.');
								await commitRequestHistory();
								return;
							} finally {
								for (const admission of comparisonAdmissions.splice(0)) admission.release();
							}
						}

						this.appendToolCallHistoryResult(history, boxId, tc.callId, toolName, { query: improvedQuery }, 'Comparison ready. Review the results side by side.');
						await commitRequestHistory(() => {
							postSqlMessage({ type: 'copilotWriteQueryDone', boxId, ok: true, message: 'Comparison ready. Review the results side by side.' });
						});
						return;
					}

					if (toolName === 'respond_to_sql_query') {
						const rawQuery = this.extractQueryArgument(tc.input);
						const query = rawQuery.replace(/```(?:sql|tsql)?\s*\n([\s\S]*?)```/gi, '$1').trim();
						if (!query) {
							this.appendToolCallHistoryResult(history, boxId, tc.callId, toolName, tc.input, 'Error: query argument was empty.');
							priorAttempts.push({ attempt, error: 'Tool call was missing a non-empty query argument.' });
							postStatus('Tool call missing query argument. Retrying…');
							shouldRetryAttempt = true;
							break;
						}

						await assertActiveOwner();
						await dispatchActiveOwner(boxId, () => {
							try { postSqlMessage({ type: 'copilotWriteQuerySetQuery', boxId, query }); } catch { /* ignore */ }
						});

						// Auto-run the query
						if (sqlClient && connection) {
							postStatus('Running query…');
							const admitted = await startCopilotSqlExecution(
								boxId,
								() => sqlClient.executeQueryCancelable(connection, database, query),
								query,
							);
							const runningRequest = this.runningCopilotWriteQueryByBoxId.get(boxId);
							const sqlFinalRun = { isCurrent: admitted.isCurrent, settleExecution: admitted.settleExecution };
							if (runningRequest?.cts === cts && runningRequest.seq === seq) runningRequest.sqlFinalRun = sqlFinalRun;
							const { promise } = admitted.execution;
							try {
								const result = await promise;
								if (isActive() && admitted.isCurrent()) {
									await this.host.refreshSqlConnectionsData?.();
									await assertActiveOwner();
									if (!admitted.isCurrent()) throw new Error('SQL Copilot write-query canceled');
									await this.host.dispatchSqlResultOwnerAllowed(boxId, requestOwner, () => {
										if (!admitted.isCurrent() || !isActive() || cts.token.isCancellationRequested) throw new Error('SQL Copilot write-query canceled');
										this.appendToolCallHistoryResult(history, boxId, tc.callId, toolName, { query }, 'Query ran successfully.');
										this.copilotConversationHistoryByBoxId.set(boxId, history);
										if (requestIncludesGeneralRules) this.copilotGeneralRulesSentPerBox.add(boxId);
										postSqlMessage({
											type: 'queryResult', result, boxId, executionId: admitted.executionId,
											query, connectionId: requestOwner.connectionId, database: requestOwner.database,
										});
										postSqlMessage({ type: 'ensureResultsVisible', boxId });
										admitted.settleExecution();
										postSqlMessage({
											type: 'copilotWriteQueryDone', boxId,
											ok: true, message: 'Query ran successfully. Review the results and adjust if needed.'
										});
									});
									return;
								}
								throw new Error('SQL Copilot write-query canceled');
							} catch (error) {
								if (!admitted.isCurrent() || error instanceof SqlLeaveNoTraceBlockedError) throw new Error('SQL Copilot write-query canceled');
								await assertActiveOwner();
								if (error instanceof SqlQueryCancelledError || (error as any)?.isCancelled === true) {
									if (isActive() && admitted.isCurrent()) {
										await dispatchActiveOwner(boxId, () => {
											if (!admitted.isCurrent()) throw new Error('SQL Copilot write-query canceled');
											admitted.settleExecution();
										});
									}
									throw new Error('SQL Copilot write-query canceled');
								}
								const errorMessage = error instanceof Error ? error.message : String(error);
								if (isActive() && admitted.isCurrent()) {
									await dispatchActiveOwner(boxId, () => {
										if (!admitted.isCurrent()) throw new Error('SQL Copilot write-query canceled');
										this.host.output.error(`[sql-copilot] query execution error: ${sanitizeStsLogText(errorMessage)}`);
										try { postSqlMessage({ type: 'queryError', error: 'Query failed to execute.', boxId, executionId: admitted.executionId }); } catch { /* ignore */ }
									});
								}
								if (!admitted.isCurrent()) throw new Error('SQL Copilot write-query canceled');
								await dispatchActiveOwner(boxId, () => {
									if (!admitted.isCurrent()) throw new Error('SQL Copilot write-query canceled');
									priorAttempts.push({ attempt, query, error: errorMessage });
									this.appendToolCallHistoryResult(history, boxId, tc.callId, toolName, { query }, `Query execution error: ${errorMessage}`);
									try {
										postSqlMessage({
											type: 'copilotWriteQueryStatus', boxId, status: 'Query failed to execute. Retrying…', detail: '',
										});
									} catch { /* ignore */ }
								});
								shouldRetryAttempt = true;
								break;
							} finally {
								const currentRequest = this.runningCopilotWriteQueryByBoxId.get(boxId);
								if (currentRequest?.sqlFinalRun === sqlFinalRun) currentRequest.sqlFinalRun = undefined;
								admitted.release();
							}
						} else {
							// No sqlClient — just set the query and finish
							this.appendToolCallHistoryResult(history, boxId, tc.callId, toolName, { query }, 'Query set in editor.');
							await commitRequestHistory(() => {
								postSqlMessage({ type: 'copilotWriteQueryDone', boxId, ok: true, message: '' });
							});
							return;
						}
					}

					if (toolName === 'ask_user_clarifying_question') {
						const question = this.extractQuestionArgument(tc.input);
						if (!question) {
							priorAttempts.push({ attempt, error: 'Tool call was missing a non-empty question argument.' });
							postStatus('Tool call missing question argument. Retrying…');
							shouldRetryAttempt = true;
							break;
						}

						const questionEntryId = this.nextHistoryEntryId(boxId);
						await dispatchActiveOwner(boxId, () => {
							history.push({
								type: 'tool-call', id: questionEntryId, callId: tc.callId,
								tool: 'ask_user_clarifying_question', args: { question },
								result: 'Question displayed to user. Awaiting response.', timestamp: Date.now(),
							});
							this.copilotConversationHistoryByBoxId.set(boxId, history);
							if (requestIncludesGeneralRules) this.copilotGeneralRulesSentPerBox.add(boxId);
							try { postSqlMessage({ type: 'copilotClarifyingQuestion', boxId, entryId: questionEntryId, question }); } catch { /* ignore */ }
							postSqlMessage({ type: 'copilotWriteQueryDone', boxId, ok: true, message: '' });
						});
						return;
					}
				}
				} finally {
					this.ensureAllToolCallsHaveResults(history, historyToolCalls, boxId);
				}

				if (shouldRetryAttempt) {
					continue;
				}

				if (hasOptionalToolCalls) {
					toolTurnCount++;
					if (toolTurnCount >= maxToolTurns) {
						priorAttempts.push({ attempt, error: 'Too many tool turns without a final response.' });
						postStatus('Too many tool turns. Retrying…');
						continue;
					}
					attempt--;
					continue;
				}
			}

			await commitRequestHistory(() => {
				postSqlMessage({
					type: 'copilotWriteQueryDone', boxId,
					ok: false, message: 'I could not produce a query that runs successfully. Review the latest error and refine your request.',
				});
			});
		} catch (err: unknown) {
			if (!isActive()) return;
			const msg = err instanceof Error ? err.message : String(err);
			const canceled = cts.token.isCancellationRequested || /canceled|cancelled/i.test(msg);
			if (canceled) {
				try {
					await this.host.dispatchSqlResultOwnerAllowed(boxId, requestOwner, () => {
						if (isActive()) postSqlMessage({ type: 'copilotWriteQueryDone', boxId, ok: false, message: 'Canceled.' });
					});
				} catch { /* stale owner suppresses terminal output */ }
			} else {
				try {
					await dispatchActiveOwner(boxId, () => {
						this.host.output.error(`[sql-copilot] error: ${sanitizeStsLogText(msg)}`);
						postSqlMessage({ type: 'copilotWriteQueryDone', boxId, ok: false, message: msg });
					});
				} catch {
					this.host.output.warn('[sql-copilot] Request failed after owner invalidation; error details suppressed.');
				}
			}
		} finally {
			try {
				const current = this.runningCopilotWriteQueryByBoxId.get(boxId);
				if (current?.cts === cts && current.seq === seq) {
					this.cancelTrackedCopilotQueries(current);
					this.runningCopilotWriteQueryByBoxId.delete(boxId);
				}
			} catch { /* ignore */ }
			try { cts.dispose(); } catch { /* ignore */ }
		}
	}
}
