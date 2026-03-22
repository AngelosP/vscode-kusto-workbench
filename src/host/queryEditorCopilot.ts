import * as vscode from 'vscode';
import { KustoConnection } from './connectionManager';
import { KustoQueryClient } from './kustoClient';
import { ConversationHistoryEntry, sanitizeConversationHistory, insertMissingToolCallResults } from './copilotConversationUtils';
import { SCHEMA_CACHE_VERSION, searchCachedSchemas } from './schemaCache';
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
	buildOptimizeQueryPrompt as buildOptimizeQueryPromptFn
} from './copilotPromptUtils';

/**
 * Interface that the CopilotService uses to call back into the host (QueryEditorProvider).
 */
export interface CopilotServiceHost {
	readonly extensionUri: vscode.Uri;
	readonly context: vscode.ExtensionContext;
	readonly kustoClient: KustoQueryClient;
	readonly output: vscode.OutputChannel;

	postMessage(message: unknown): void;
	findConnection(connectionId: string): KustoConnection | undefined;
	getErrorMessage(error: unknown): string;
	formatQueryExecutionErrorForUser(error: unknown, connection: KustoConnection, db?: string): string;
	logQueryExecutionError(error: unknown, connection: KustoConnection, db: string | undefined, boxId: string, query: string): void;
	normalizeClusterUrlKey(url: string): string;

	cancelRunningQuery(boxId: string): void;
	registerRunningQuery(boxId: string, cancel: () => void, runSeq: number): void;
	nextQueryRunSeq(): number;

	isControlCommand(query: string): boolean;
	appendQueryMode(query: string, mode?: string): string;
	buildCacheDirective(enabled?: boolean, value?: number, unit?: CacheUnit | string): string | undefined;

	getCachedSchemaFromDisk(cacheKey: string): Promise<CachedSchemaEntry | undefined>;
	saveCachedSchemaToDisk(key: string, entry: CachedSchemaEntry): Promise<void>;

	ensureComparisonBoxInWebview(sourceBoxId: string, query: string, token: vscode.CancellationToken): Promise<string>;
	waitForComparisonSummary(sourceBoxId: string, comparisonBoxId: string, token: vscode.CancellationToken): Promise<{ dataMatches: boolean; headersMatch: boolean }>;
	deleteComparisonSummary(key: string): void;

	requestSectionsFromWebview(): Promise<unknown[] | undefined>;
	revealPanel(): void;
}

export class CopilotService {
	private copilotWriteSeq = 0;
	private copilotHistoryEntrySeq = 0;
	private readonly runningOptimizeByBoxId = new Map<string, vscode.CancellationTokenSource>();
	private readonly runningCopilotWriteQueryByBoxId = new Map<string, { cts: vscode.CancellationTokenSource; seq: number }>();
	private readonly copilotGeneralRulesSentPerBox = new Set<string>();
	private readonly copilotDevNotesSentPerBox = new Set<string>();
	private readonly copilotConversationHistoryByBoxId = new Map<string, ConversationHistoryEntry[]>();
	private readonly copilotExtendedSchemaCache = new Map<string, { timestamp: number; result: string; label: string }>();
	private readonly SCHEMA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

	// Cache for Copilot model selection — avoids calling selectChatModels() on every inline completion request.
	private _cachedInlineModel: vscode.LanguageModelChat | null = null;
	private _cachedInlineModelAt = 0;
	private static readonly INLINE_MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

	constructor(private readonly host: CopilotServiceHost) {}

	getCopilotLocalTools(): CopilotLocalTool[] {
		return getCopilotLocalToolsFn();
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

	async readOptimizeQueryRules(): Promise<string> {
		try {
			const uri = vscode.Uri.joinPath(this.host.context.extensionUri, 'copilot-instructions', 'optimize-query-rules.md');
			const bytes = await vscode.workspace.fs.readFile(uri);
			return new TextDecoder('utf-8').decode(bytes);
		} catch (e) {
			const msg = this.host.getErrorMessage(e);
			return `Failed to read copilot-instructions/optimize-query-rules.md: ${msg}`;
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

	cancelCopilotWriteQuery(boxId: string): void {
		const id = String(boxId || '').trim();
		if (!id) {
			return;
		}
		const running = this.runningCopilotWriteQueryByBoxId.get(id);
		if (!running) {
			return;
		}
		try {
			this.host.postMessage({ type: 'copilotWriteQueryStatus', boxId: id, status: 'Canceling…' });
		} catch {
			// ignore
		}
		this.host.cancelRunningQuery(id);
		try {
			running.cts.cancel();
		} catch {
			// ignore
		}
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
			this.copilotConversationHistoryByBoxId.delete(id);
		} catch {
			// ignore
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
			// Use cached model if available (avoids ~200-500ms selectChatModels latency per request).
			let model = this._cachedInlineModel;
			if (!model || Date.now() - this._cachedInlineModelAt > CopilotService.INLINE_MODEL_CACHE_TTL_MS) {
				const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
				if (models.length === 0) {
					this.host.postMessage({
						type: 'copilotInlineCompletionResult',
						requestId,
						boxId,
						completions: [],
						error: 'Copilot not available'
					});
					return;
				}
				model = findPreferredDefaultCopilotModel(models)!;
				this._cachedInlineModel = model;
				this._cachedInlineModelAt = Date.now();
			}

			// Trim context to the most relevant portion to keep the prompt small and fast.
			// For inline completions, the last ~2000 chars before cursor and ~500 after
			// is more than enough context.
			const maxBefore = 2000;
			const maxAfter = 500;
			const trimmedBefore = textBefore.length > maxBefore ? textBefore.slice(-maxBefore) : textBefore;
			const trimmedAfter = textAfter.length > maxAfter ? textAfter.slice(0, maxAfter) : textAfter;

			const prompt = `You are an expert Kusto Query Language (KQL) assistant providing inline code completions.
Complete the following KQL code. Only return the completion text that should be inserted at the cursor position.
Do NOT include any explanation, markdown formatting, or code fences.
Return ONLY the raw KQL code to complete the line or statement.
If you cannot provide a meaningful completion, return an empty string.

KQL code before cursor:
${trimmedBefore}

KQL code after cursor:
${trimmedAfter}

Completion:`;

			const cts = new vscode.CancellationTokenSource();
			const timeoutId = setTimeout(() => cts.cancel(), 8000);

			try {
				const response = await model.sendRequest(
					[vscode.LanguageModelChatMessage.User(prompt)],
					{},
					cts.token
				);

				let completionText = '';
				for await (const chunk of response.text) {
					completionText += chunk;
					if (completionText.length > 500) {
						break;
					}
				}

				clearTimeout(timeoutId);

				completionText = completionText.trim();
				completionText = completionText.replace(/^```(?:kusto|kql)?\s*\n?/i, '').replace(/\n?```$/i, '');

				const completions = completionText ? [{ insertText: completionText }] : [];

				this.host.postMessage({
					type: 'copilotInlineCompletionResult',
					requestId,
					boxId,
					completions
				});
			} catch (err) {
				clearTimeout(timeoutId);
				if (err instanceof vscode.CancellationError) {
					this.host.postMessage({
						type: 'copilotInlineCompletionResult',
						requestId,
						boxId,
						completions: []
					});
				} else {
					throw err;
				}
			} finally {
				cts.dispose();
			}
		} catch (err) {
			const errorMsg = err instanceof vscode.LanguageModelError
				? `Copilot error: ${err.message}`
				: this.host.getErrorMessage(err);
			this.host.postMessage({
				type: 'copilotInlineCompletionResult',
				requestId,
				boxId,
				completions: [],
				error: errorMsg
			});
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
					tools: this.getCopilotLocalTools()
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
				tools: this.getCopilotLocalTools()
			});
		} catch {
			this.host.postMessage({
				type: 'copilotWriteQueryOptions',
				boxId,
				models: [],
				selectedModelId: '',
				tools: this.getCopilotLocalTools()
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
		const clusterKey = this.host.normalizeClusterUrlKey(connection.clusterUrl || '');
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
			let cached = await this.host.getCachedSchemaFromDisk(diskCacheKey);
			if (token.isCancellationRequested) {
				throw new Error('Copilot write-query canceled');
			}

			if (cached?.schema && (cached.version ?? 0) !== SCHEMA_CACHE_VERSION) {
				try {
					const refreshed = await this.host.kustoClient.getDatabaseSchema(connection, db, true);
					if (token.isCancellationRequested) {
						throw new Error('Copilot write-query canceled');
					}
					const timestamp = Date.now();
					await this.host.saveCachedSchemaToDisk(diskCacheKey, { schema: refreshed.schema, timestamp, version: SCHEMA_CACHE_VERSION });
					cached = { schema: refreshed.schema, timestamp, version: SCHEMA_CACHE_VERSION };
				} catch {
					// If refresh fails, continue with the cached schema
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
			const raw = this.host.getErrorMessage(error);
			label = `${db || '(unknown db)'}: schema lookup failed`;
			jsonText = JSON.stringify({ database: db, error: `Failed to read cached schema: ${raw}` }, null, 2);
		}

		try {
			this.copilotExtendedSchemaCache.set(memCacheKey, { timestamp: now, result: jsonText, label });
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

		// Safety: verify every assistant tool_use has a matching tool_result
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
				const toolCallParts = msg.content.filter(
					(p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart
				);
				if (toolCallParts.length > 0) {
					const resultCallIds = new Set<string>();
					for (let j = i + 1; j < messages.length; j++) {
						for (const part of messages[j].content) {
							if (part instanceof vscode.LanguageModelToolResultPart) {
								resultCallIds.add(part.callId);
							}
						}
						if (messages[j].role === vscode.LanguageModelChatMessageRole.Assistant) {
							break;
						}
					}
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

		// Reverse safety: remove orphaned tool_results
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
			try {
				await vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'Kusto Workbench' });
			} catch { /* ignore */ }
			this.host.postMessage({ type: 'copilotChatFirstTimeResult', boxId, action: 'openedAgent' });
		} else if (choice === useChat) {
			this.host.postMessage({ type: 'copilotChatFirstTimeResult', boxId, action: 'proceed' });
		} else {
			this.host.postMessage({ type: 'copilotChatFirstTimeResult', boxId, action: 'dismissed' });
		}
	}

	async startCopilotWriteQuery(
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
				this.host.postMessage({
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
				this.host.postMessage({ type: 'copilotWriteQueryStatus', boxId, status, detail: detail || '' });
			} catch {
				// ignore
			}
		};

		const postNarrative = (narrative: string) => {
			const text = String(narrative || '').trim();
			if (!text) return;
			try {
				this.host.postMessage({ type: 'copilotWriteQueryStatus', boxId, status: text, role: 'assistant' });
			} catch {
				// ignore
			}
		};

		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			if (models.length === 0) {
				this.host.postMessage({
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

			const connection = this.host.findConnection(connectionId);
			if (!connection) {
				this.host.postMessage({
					type: 'copilotWriteQueryDone',
					boxId,
					ok: false,
					message: 'Connection not found. Select a valid connection and try again.'
				});
				return;
			}

			const history = this.getOrCreateConversationHistory(boxId);

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

					try {
						this.host.postMessage({
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
						this.host.postMessage({
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
					this.host.postMessage({
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

				if (responseText.trim()) {
					postNarrative(responseText.trim());
				}

				if (nativeToolCalls.length === 0) {
					priorAttempts.push({ attempt, error: 'Copilot did not call any tools. The model should use the available tools to respond.' });
					postStatus('Copilot returned a non-tool response. Retrying…', responseText);
					continue;
				}

				const assistantEntryId = this.nextHistoryEntryId(boxId);
				history.push({
					type: 'assistant-message',
					id: assistantEntryId,
					text: responseText,
					toolCalls: nativeToolCalls.map(tc => ({ callId: tc.callId, name: tc.name, input: tc.input })),
					timestamp: Date.now()
				});

				let shouldRetryAttempt = false;
				let hasOptionalToolCalls = false;

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
							this.host.postMessage({
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
							this.host.postMessage({
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
							const isControl = this.host.isControlCommand(query);
							const queryWithLimit = this.host.appendQueryMode(query, copilotQueryMode);
							const cacheDirective = isControl ? '' : this.host.buildCacheDirective(true, 1, 'days');
							const finalQuery = cacheDirective ? `${cacheDirective}\n${queryWithLimit}` : queryWithLimit;
							const cancelClientKey = `${boxId}::${connection.id}::executeForCopilot`;
							const result = await this.host.kustoClient.executeQueryCancelable(connection, database, finalQuery, cancelClientKey).promise;

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
								this.host.postMessage({
									type: 'copilotExecutedQuery',
									boxId,
									entryId: execEntryId,
									query,
									resultSummary: rows.length > 0 ? `${rows.length} rows` : 'No results',
									result
								});
							} catch {
								// ignore
							}
							hasOptionalToolCalls = true;
							continue;
						} catch (e) {
							const errMsg = this.host.getErrorMessage(e);

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
								this.host.postMessage({
									type: 'copilotExecutedQuery',
									boxId,
									entryId: execErrEntryId,
									query,
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
							const searchMatches = await searchCachedSchemas(this.host.context.globalStorageUri, rawPattern);
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
								this.host.postMessage({
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
								this.host.postMessage({
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
							priorAttempts.push({ attempt, error: 'Tool call was missing a non-empty query argument.' });
							postStatus('Tool call missing query argument. Retrying…');
							shouldRetryAttempt = true;
							break;
						}

						const originalQueryForCompare = currentQuery;
						let candidate = improvedQuery;

						postStatus('Preparing comparison editor…');
						let comparisonBoxId = await this.host.ensureComparisonBoxInWebview(boxId, candidate, cts.token);
						if (!comparisonBoxId) {
							this.host.postMessage({
								type: 'copilotWriteQueryDone',
								boxId,
								ok: false,
								message: 'Failed to prepare comparison editor.'
							});
							return;
						}

						const executeQueryAndPost = async (targetBoxId: string, queryText: string, cancelSuffix: string) => {
							const queryWithMode = this.host.appendQueryMode(queryText, copilotQueryMode);
							const cacheDirective = this.host.buildCacheDirective(true, 1, 'days');
							const finalQuery = cacheDirective ? `${cacheDirective}\n${queryWithMode}` : queryWithMode;
							const cancelClientKey = `${targetBoxId}::${connection.id}::validatePerformanceImprovements::${cancelSuffix}`;
							const result = await this.host.kustoClient.executeQueryCancelable(connection, database, finalQuery, cancelClientKey).promise;
							try {
								this.host.postMessage({ type: 'queryResult', result, boxId: targetBoxId });
							} catch {
								// ignore
							}
						};

						comparisonBoxId = await this.host.ensureComparisonBoxInWebview(boxId, candidate, cts.token);
						if (!comparisonBoxId) {
							this.host.postMessage({
								type: 'copilotWriteQueryDone',
								boxId,
								ok: false,
								message: 'Failed to prepare comparison editor.'
							});
							return;
						}

						try {
							this.host.deleteComparisonSummary(`${boxId}::${comparisonBoxId}`);
						} catch {
							// ignore
						}

						postStatus('Running original query…');
						try {
							await executeQueryAndPost(boxId, originalQueryForCompare, 'source');
						} catch (error) {
							this.host.logQueryExecutionError(error, connection, database, boxId, originalQueryForCompare);
							try {
								this.host.postMessage({ type: 'queryError', error: 'Query failed to execute.', boxId });
							} catch {
								// ignore
							}
							this.host.postMessage({
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
							comparisonBoxId = await this.host.ensureComparisonBoxInWebview(boxId, candidate, cts.token);
							if (!comparisonBoxId) {
								this.host.postMessage({
									type: 'copilotWriteQueryDone',
									boxId,
									ok: false,
									message: 'Failed to prepare comparison editor.'
								});
								return;
							}
							try {
								this.host.deleteComparisonSummary(`${boxId}::${comparisonBoxId}`);
							} catch {
								// ignore
							}

							try {
								await executeQueryAndPost(comparisonBoxId, candidate, 'comparison');
								executed = true;
								break;
							} catch (error) {
								this.host.logQueryExecutionError(error, connection, database, comparisonBoxId, candidate);
								lastExecErrorText = this.host.formatQueryExecutionErrorForUser(error, connection, database);
								try {
									this.host.postMessage({
										type: 'queryError',
										error: 'Query failed to execute.',
										boxId: comparisonBoxId
									});
								} catch {
									// ignore
								}
								if (execAttempt >= maxExecAttempts) {
									this.host.postMessage({
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
									candidate = fixedQuery;
								}
							}
						}

						if (!executed) {
							this.host.postMessage({
								type: 'copilotWriteQueryDone',
								boxId,
								ok: false,
								message: 'Query failed to execute.'
							});
							return;
						}

						this.host.postMessage({
							type: 'copilotWriteQueryDone',
							boxId,
							ok: true,
							message:
								'Optimized query has been provided, please check the results to make sure the same data is being returned. Keep in mind that count() and dcount() can return slightly different values by design, so we cannot expect a 100% match the entire time.'
						});
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
							this.host.postMessage({ type: 'copilotWriteQuerySetQuery', boxId, query });
						} catch {
							// ignore
						}

						postStatus('Running query…');
						try {
							this.host.postMessage({ type: 'copilotWriteQueryExecuting', boxId, executing: true });
						} catch {
							// ignore
						}

						this.host.cancelRunningQuery(boxId);
						const queryWithMode = this.host.appendQueryMode(query, copilotQueryMode);
						const cacheDirective = this.host.buildCacheDirective(true, 1, 'days');
						const finalQuery = cacheDirective ? `${cacheDirective}\n${queryWithMode}` : queryWithMode;

						const cancelClientKey = `${boxId}::${connection.id}::copilot`;
						const { promise, cancel } = this.host.kustoClient.executeQueryCancelable(
							connection,
							database,
							finalQuery,
							cancelClientKey
						);
						const runSeq = this.host.nextQueryRunSeq();
						this.host.registerRunningQuery(boxId, cancel, runSeq);
						try {
							const result = await promise;
							if (isActive()) {
								this.host.postMessage({ type: 'queryResult', result, boxId });
								this.host.postMessage({ type: 'ensureResultsVisible', boxId });
								this.host.postMessage({ type: 'copilotWriteQueryExecuting', boxId, executing: false });
								this.host.postMessage({
									type: 'copilotWriteQueryDone',
									boxId,
									ok: true,
									message: 'Query ran successfully. Review the results and adjust if needed.'
								});
								return;
							}
						} catch (error) {
							if ((error as Record<string, unknown>)?.name === 'QueryCancelledError' || (error as Record<string, unknown>)?.isCancelled === true) {
								if (isActive()) {
									try {
										this.host.postMessage({ type: 'copilotWriteQueryExecuting', boxId, executing: false });
									} catch {
										// ignore
									}
								}
								throw new Error('Copilot write-query canceled');
							}

							const userMessage = this.host.formatQueryExecutionErrorForUser(error, connection, database);
							this.host.logQueryExecutionError(error, connection, database, boxId, finalQuery);
							if (isActive()) {
								try {
									this.host.postMessage({ type: 'queryError', error: 'Query failed to execute.', boxId });
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
							effectiveAction = 'remove';
							this.host.postMessage({
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
							this.host.postMessage({
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
							this.host.postMessage({
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
							this.host.postMessage({
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
							}
						});

						this.host.postMessage({
							type: 'copilotWriteQueryDone',
							boxId,
							ok: true,
							message: ''
						});
						return;
					}
				}
				} finally {
					this.ensureAllToolCallsHaveResults(history, nativeToolCalls, boxId);
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

			this.host.postMessage({
				type: 'copilotWriteQueryDone',
				boxId,
				ok: false,
				message: 'I could not produce a query that runs successfully. Review the latest error and refine your request.'
			});
		} catch (err) {
			const msg = this.host.getErrorMessage(err);
			const canceled = cts.token.isCancellationRequested || /canceled|cancelled/i.test(msg);
			if (canceled) {
				try {
					this.host.postMessage({
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
				this.host.postMessage({
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

	async prepareOptimizeQuery(
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
				this.host.postMessage({
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

			const lastModelId = this.host.context.globalState.get<string>(STORAGE_KEYS.lastOptimizeCopilotModelId);
			const preferredModelId = String(lastModelId || '').trim();
			const defaultModelId = findPreferredDefaultCopilotModel(models)?.id || '';
			const selectedModelId = preferredModelId && modelOptions.some(m => m.id === preferredModelId)
				? preferredModelId
				: defaultModelId;

			this.host.postMessage({
				type: 'optimizeQueryOptions',
				boxId,
				models: modelOptions,
				selectedModelId,
				promptText: this.buildOptimizeQueryPrompt(query)
			});
		} catch (err: any) {
			const errorMsg = err?.message || String(err);
			console.error('Failed to prepare optimize query options:', err);
			this.host.postMessage({
				type: 'optimizeQueryError',
				boxId,
				error: errorMsg
			});
		}
	}

	cancelOptimizeQuery(boxId: string): void {
		const id = String(boxId || '').trim();
		if (!id) {
			return;
		}
		const running = this.runningOptimizeByBoxId.get(id);
		if (!running) {
			return;
		}
		try {
			this.host.postMessage({ type: 'optimizeQueryStatus', boxId: id, status: 'Canceling…' });
		} catch {
			// ignore
		}
		try {
			running.cancel();
		} catch {
			// ignore
		}
	}

	async optimizeQueryWithCopilot(
		message: Extract<IncomingWebviewMessage, { type: 'optimizeQuery' }>
	): Promise<void> {
		const { query, connectionId, database, boxId, queryName, modelId, promptText } = message;
		const id = String(boxId || '').trim();
		if (!id) {
			return;
		}

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
				this.host.postMessage({ type: 'optimizeQueryStatus', boxId: id, status });
			} catch {
				// ignore
			}
		};

		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			if (models.length === 0) {
				vscode.window.showWarningMessage('GitHub Copilot is not available. Please enable Copilot to use query optimization.');
				this.host.postMessage({
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
				await this.host.context.globalState.update(STORAGE_KEYS.lastOptimizeCopilotModelId, String(model.id));
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
			for await (const fragment of response.text) {
				if (cts.token.isCancellationRequested) {
					throw new Error('Optimization canceled');
				}
				optimizedQuery += fragment;
			}

			postStatus('Parsing optimized query…');

			const codeBlockMatch = optimizedQuery.match(/```(?:kusto|kql)?\s*\n([\s\S]*?)\n```/);
			if (codeBlockMatch) {
				optimizedQuery = codeBlockMatch[1].trim();
			} else {
				optimizedQuery = optimizedQuery.trim();
			}

			if (!optimizedQuery) {
				throw new Error('Failed to extract optimized query from Copilot response');
			}

			postStatus('Done. Creating comparison…');

			this.host.postMessage({
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
					this.host.postMessage({ type: 'optimizeQueryError', boxId: id, error: 'Optimization canceled' });
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

			this.host.postMessage({
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
}
