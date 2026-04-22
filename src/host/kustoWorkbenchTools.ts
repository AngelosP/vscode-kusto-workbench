import * as vscode from 'vscode';
import { ConnectionManager, KustoConnection } from './connectionManager';
import { createEmptyKqlxOrMdxFile, DevNoteEntry, KqlxFileKind, KqlxSectionV1 } from './kqlxFormat';
import { readAllCachedSchemasFromDisk, readCachedSchemaFromDisk, searchCachedSchemas, writeCachedSchemaToDisk, SCHEMA_CACHE_VERSION } from './schemaCache';
import type { SqlConnectionManager } from './sqlConnectionManager';
import type { KustoQueryClient } from './kustoClient';
import { countColumns, formatSchemaAsCompactText, formatSchemaWithTokenBudget } from './schemaIndexUtils';

// ─────────────────────────────────────────────────────────────────────────────
// Helper to extract tool input from invocation options
// VS Code API changed from 'input' to 'parameters' - handle both for compatibility
// ─────────────────────────────────────────────────────────────────────────────

function getToolInput<T>(options: vscode.LanguageModelToolInvocationOptions<T> | vscode.LanguageModelToolInvocationPrepareOptions<T>): T {
	// Try 'input' first (original API), then 'parameters' (new API)
	const opts = options as any;
	return opts.input ?? opts.parameters ?? ({} as T);
}

/**
 * LLMs frequently send literal two-character "\n" sequences in JSON string
 * values instead of actual newline characters. This is especially problematic
 * for markdown content where newlines are structurally significant.
 * This helper replaces those literal escape sequences with real characters.
 */
function unescapeLLMText(text: string): string {
	return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

// ─────────────────────────────────────────────────────────────────────────────
// Types for tool inputs
// ─────────────────────────────────────────────────────────────────────────────

export interface ListConnectionsInput {
	// No input required
}

export interface ListFavoritesInput {
	// No input required
}

export interface GetSchemaInput {
	/** The Kusto cluster URL (e.g., 'https://help.kusto.windows.net'). */
	clusterUrl: string;
	/** Optional: a specific database name. When omitted, returns schemas for all cached databases on the cluster. */
	database?: string;
}

import type { DatabaseSchemaIndex } from './kustoClient';

/** Result from the getSchema orchestrator method. */
export type GetSchemaResult = {
	error?: string;
	/** Returned when a specific database was requested. */
	clusterUrl?: string;
	database?: string;
	schema?: DatabaseSchemaIndex;
	cacheAgeMs?: number;
	/** Returned when no database was specified — lightweight per-db summaries. */
	databases?: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>;
};

export interface RefreshKustoSchemaInput {
	/** The cluster URL for which to refresh the schema (e.g., 'https://help.kusto.windows.net'). */
	clusterUrl: string;
}

export interface SearchCachedSchemasInput {
	/** A regex pattern to search for across table names, column names, function names, and their docstrings. Case-insensitive. */
	pattern: string;
}

export interface ListSectionsInput {
	// No input required
}

export interface AddSectionInput {
	type: 'query' | 'markdown' | 'chart' | 'transformation' | 'url' | 'python' | 'html' | 'sql';
	/** For query sections: initial query text */
	query?: string;
	/** For query sections: cluster URL to connect to */
	clusterUrl?: string;
	/** For query sections: database to connect to */
	database?: string;
	/** For markdown sections: initial text content */
	text?: string;
	/** Alias for text - LLMs may use either property name */
	content?: string;
	/** For URL sections: the URL to embed */
	url?: string;
	/** For HTML sections: initial HTML + JS code */
	code?: string;
	/** For chart sections: data source section ID */
	dataSourceId?: string;
	/** For chart sections: chart type */
	chartType?: 'line' | 'area' | 'bar' | 'scatter' | 'pie' | 'funnel' | 'sankey' | 'heatmap';
	/** Section name/title */
	name?: string;
}

export interface RemoveSectionInput {
	sectionId: string;
}

export interface CollapseSectionInput {
	sectionId: string;
	collapsed: boolean;
}

export interface ReorderSectionsInput {
	/** Array of section IDs in the desired order. All section IDs must be included. Devnotes IDs are accepted but silently ignored (they have no visual position). */
	sectionIds: string[];
}

export interface ConfigureQuerySectionInput {
	sectionId: string;
	/** Optional name/title for the section */
	name?: string;
	query?: string;
	clusterUrl?: string;
	database?: string;
	execute?: boolean;
}

export interface UpdateMarkdownSectionInput {
	sectionId: string;
	/** Optional name/title for the section */
	name?: string;
	text?: string;
	/** Alias for text - LLMs may use either property name */
	content?: string;
	mode?: 'preview' | 'markdown' | 'wysiwyg';
}

export interface ConfigureChartInput {
	sectionId: string;
	/** Optional name/title for the section */
	name?: string;
	dataSourceId?: string;
	chartType?: 'line' | 'area' | 'bar' | 'scatter' | 'pie' | 'funnel' | 'sankey' | 'heatmap';
	xColumn?: string;
	yColumns?: string[];
	legendColumn?: string;
	legendPosition?: 'left' | 'right' | 'top' | 'bottom';
	showDataLabels?: boolean;
	sourceColumn?: string;
	targetColumn?: string;
	valueColumn?: string;
	labelColumn?: string;
	orient?: 'LR' | 'RL' | 'TB' | 'BT';
	sankeyLeftMargin?: number;
	stackMode?: 'normal' | 'stacked' | 'stacked100';
	tooltipColumns?: string[];
	sortColumn?: string;
	sortDirection?: 'asc' | 'desc';
	labelMode?: 'auto' | 'all' | 'top5' | 'top10' | 'topPercent';
	labelDensity?: number;
	chartTitle?: string;
	chartSubtitle?: string;
	chartTitleAlign?: 'left' | 'center' | 'right';
	xAxisSettings?: {
		sortDirection?: '' | 'asc' | 'desc';
		scaleType?: '' | 'category' | 'continuous';
		labelDensity?: number;
		showAxisLabel?: boolean;
		customLabel?: string;
		titleGap?: number;
	};
	yAxisSettings?: {
		showAxisLabel?: boolean;
		customLabel?: string;
		min?: string;
		max?: string;
		seriesColors?: Record<string, string>;
		titleGap?: number;
		sortDirection?: '' | 'asc' | 'desc';
	};
	legendSettings?: {
		position?: 'top' | 'right' | 'bottom' | 'left';
		stackMode?: 'normal' | 'stacked' | 'stacked100';
		gap?: number;
		sortMode?: '' | 'alpha-asc' | 'alpha-desc' | 'value-asc' | 'value-desc';
		topN?: number;
		title?: string;
		showEndLabels?: boolean;
	};
	heatmapSettings?: {
		visualMapPosition?: 'right' | 'left' | 'bottom' | 'top';
		visualMapGap?: number;
		showCellLabels?: boolean;
		cellLabelMode?: 'all' | 'lowest' | 'highest' | 'both';
		cellLabelN?: number;
	};
}

export interface ConfigureTransformationInput {
	sectionId: string;
	/** Optional name/title for the section */
	name?: string;
	dataSourceId?: string;
	transformationType?: 'derive' | 'summarize' | 'distinct' | 'pivot' | 'join';
	// For distinct
	distinctColumn?: string;
	// For summarize
	groupByColumns?: string[];
	aggregations?: Array<{ name?: string; column?: string; function: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'distinct' }>;
	// For derive
	deriveColumns?: Array<{ name: string; expression: string }>;
	// For pivot
	pivotRowKeyColumn?: string;
	pivotColumnKeyColumn?: string;
	pivotValueColumn?: string;
	pivotAggregation?: 'sum' | 'avg' | 'count' | 'first';
	// For join
	joinRightDataSourceId?: string;
	joinKind?: 'inner' | 'leftouter' | 'rightouter' | 'fullouter' | 'leftanti' | 'rightanti' | 'leftsemi' | 'rightsemi';
	joinKeys?: Array<{ left: string; right: string }>;
	joinOmitDuplicateColumns?: boolean;
}

export interface DelegateToKustoWorkbenchCopilotInput {
	/** The question or request to send to Kusto Workbench Copilot */
	question: string;
	/** Optional: The ID of a query section to use. If not provided, one will be created or the first available will be used. */
	sectionId?: string;
	/** Optional: Cluster URL to connect to (e.g., 'https://help.kusto.windows.net'). If not provided, uses the current connection. */
	clusterUrl?: string;
	/** Optional: Database name to use. If not provided, uses the current database. */
	database?: string;
}

export interface ConfigureHtmlSectionInput {
	sectionId: string;
	/** Optional name/title for the section */
	name?: string;
	/** HTML + JS source code */
	code?: string;
	/** Section mode: 'code' for editor, 'preview' for rendered HTML */
	mode?: 'code' | 'preview';
}

export interface CreateFileInput {
	/**
	 * The type of file to create:
	 * - kqlx: Kusto Notebook (rich notebook with multiple sections)
	 * - mdx: Markdown-focused notebook (same format as kqlx, but defaults to markdown-first)
	 * - kql: Plain Kusto query file
	 * - csl: Plain Kusto query file (alternative extension)
	 * - md: Plain markdown file
	 * - kql-sidecar: Creates both a .kql file and its companion .kql.json sidecar file
	 * - csl-sidecar: Creates both a .csl file and its companion .csl.json sidecar file
	 */
	fileType: 'kqlx' | 'mdx' | 'kql' | 'csl' | 'md' | 'kql-sidecar' | 'csl-sidecar';
	/**
	 * The full file path (without extension) where the file should be created.
	 * The LLM must always provide a filePath. If not provided, a default will be generated.
	 * Example: '/path/to/my-queries/analysis' will create 'analysis.kqlx' (or appropriate extension)
	 */
	filePath?: string;
	/**
	 * Optional: Initial content to add to the file.
	 * - For kqlx/mdx: An initial query or markdown text
	 * - For kql/csl/kql-sidecar/csl-sidecar: The initial KQL query
	 * - For md: The initial markdown content
	 */
	initialContent?: string;
}

export interface ManageDevelopmentNotesInput {
	action: 'add' | 'remove' | 'view';
	/** For 'add': the category of the note */
	category?: 'correction' | 'clarification' | 'schema-hint' | 'usage-note' | 'gotcha';
	/** For 'add': concise note content */
	content?: string;
	/** For 'add': optional section IDs this note relates to */
	relatedSectionIds?: string[];
	/** For 'add': optional ID of an existing note this replaces */
	supersedes?: string;
	/** For 'remove': the ID of the note to remove */
	noteId?: string;
}

// ── SQL tool input types ────────────────────────────────────────────────────

export interface ListSqlConnectionsInput {}

export interface ConfigureSqlSectionInput {
	sectionId: string;
	name?: string;
	query?: string;
	serverUrl?: string;
	database?: string;
	execute?: boolean;
}

export interface GetSqlSchemaInput {
	sectionId: string;
}

export interface DelegateToSqlCopilotInput {
	/** The question or request to send to SQL Copilot */
	question: string;
	/** Optional: The ID of a SQL section to use. */
	sectionId?: string;
	/** Optional: Server URL to connect to */
	serverUrl?: string;
	/** Optional: Database name to use */
	database?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper types for favorites
// ─────────────────────────────────────────────────────────────────────────────

interface KustoFavorite {
	name: string;
	clusterUrl: string;
	database: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Orchestrator - manages communication with the active webview
// ─────────────────────────────────────────────────────────────────────────────

// Simplified section type for tool orchestrator (doesn't need full KqlxSectionV1)
interface ToolSection {
	id?: string;
	type: string;
	name?: string;
	title?: string;
	expanded?: boolean;
	clusterUrl?: string;
	database?: string;
	[key: string]: unknown;
}

export class KustoWorkbenchToolOrchestrator {
	private static instance: KustoWorkbenchToolOrchestrator | undefined;
	
	// Callback to post messages to the active webview
	private webviewMessagePoster: ((message: unknown) => void) | undefined;
	// Callback to get the current state from the webview
	private stateGetter: (() => Promise<ToolSection[] | undefined>) | undefined;
	// Callback to force-refresh schema from Kusto and update cache
	private schemaRefresher: ((clusterUrl: string) => Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }>) | undefined;
	// Pending responses from webview
	private pendingResponses = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private responseSeq = 0;
	// Monotonically increasing token to track which editor instance is currently connected.
	// disconnectIfOwner() only clears the callbacks when the caller's token matches,
	// preventing a stale editor from disconnecting a newer active one.
	private connectionToken = 0;

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly connectionManager: ConnectionManager,
		private readonly getSqlConnectionManager: () => SqlConnectionManager,
		private readonly kustoClient: KustoQueryClient
	) {}

	static getInstance(
		context: vscode.ExtensionContext,
		connectionManager: ConnectionManager,
		getSqlConnectionManager: () => SqlConnectionManager,
		kustoClient: KustoQueryClient
	): KustoWorkbenchToolOrchestrator {
		if (!KustoWorkbenchToolOrchestrator.instance) {
			KustoWorkbenchToolOrchestrator.instance = new KustoWorkbenchToolOrchestrator(context, connectionManager, getSqlConnectionManager, kustoClient);
		}
		return KustoWorkbenchToolOrchestrator.instance;
	}

	/**
	 * Connect an editor instance to the orchestrator. Returns a token that must
	 * be passed to {@link disconnectIfOwner} so only the currently-connected
	 * instance can clear the callbacks.
	 */
	connect(
		poster: (message: unknown) => void,
		stateGetter: () => Promise<ToolSection[] | undefined>,
		schemaRefresher: (clusterUrl: string) => Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }>
	): number {
		this.connectionToken++;
		this.webviewMessagePoster = poster;
		this.stateGetter = stateGetter;
		this.schemaRefresher = schemaRefresher;
		return this.connectionToken;
	}

	/**
	 * Disconnect only if the caller holds the current connection token.
	 * This prevents a closing editor from disconnecting a different active one.
	 */
	disconnectIfOwner(token: number): void {
		if (token !== this.connectionToken) return;
		this.webviewMessagePoster = undefined;
		this.stateGetter = undefined;
		this.schemaRefresher = undefined;
	}

	/**
	 * Posts a message directly to the active webview (fire-and-forget).
	 * Used for one-way notifications that don't expect a response.
	 */
	postToActiveWebview(message: unknown): void {
		if (this.webviewMessagePoster) {
			this.webviewMessagePoster(message);
		}
	}

	handleWebviewResponse(requestId: string, result: unknown, error?: string): void {
		const pending = this.pendingResponses.get(requestId);
		if (!pending) return;
		this.pendingResponses.delete(requestId);
		clearTimeout(pending.timer);
		if (error) {
			pending.reject(new Error(error));
		} else {
			pending.resolve(result);
		}
	}

	private async sendToWebview<T>(type: string, payload: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
		if (!this.webviewMessagePoster) {
			throw new Error('Kusto Workbench is not currently open. Please open a .kqlx file or use the Query Editor first.');
		}
		
		const requestId = `tool_${++this.responseSeq}_${Date.now()}`;
		
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingResponses.delete(requestId);
				reject(new Error('Request timed out'));
			}, timeoutMs);
			
			this.pendingResponses.set(requestId, { 
				resolve: resolve as (value: unknown) => void, 
				reject, 
				timer 
			});
			
			this.webviewMessagePoster!({ type, requestId, ...payload });
		});
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Tool implementations
	// ─────────────────────────────────────────────────────────────────────────

	async listConnections(): Promise<{ connections: KustoConnection[] }> {
		const connections = this.connectionManager.getConnections();
		return { connections };
	}

	async listFavorites(): Promise<{ favorites: KustoFavorite[] }> {
		const raw = this.context.globalState.get<unknown>('kusto.favorites');
		if (!Array.isArray(raw)) {
			return { favorites: [] };
		}
		const favorites: KustoFavorite[] = [];
		for (const item of raw) {
			if (!item || typeof item !== 'object') continue;
			const maybe = item as Partial<KustoFavorite>;
			const name = String(maybe.name || '').trim();
			const clusterUrl = String(maybe.clusterUrl || '').trim();
			const database = String(maybe.database || '').trim();
			if (name && clusterUrl && database) {
				favorites.push({ name, clusterUrl, database });
			}
		}
		return { favorites };
	}

	async refreshSchema(input: RefreshKustoSchemaInput): Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }> {
		const clusterUrl = (input.clusterUrl || '').trim();
		if (!clusterUrl) {
			return { schemas: [], error: 'clusterUrl is required.' };
		}
		// Prefer the webview-connected refresher (also updates the editor's live state),
		// but fall back to a direct Kusto client refresh when no file is open.
		if (this.schemaRefresher) {
			return this.schemaRefresher(clusterUrl);
		}
		return this.refreshSchemaDirectly(clusterUrl);
	}

	/**
	 * Refresh schema directly via the Kusto client, without requiring an open editor.
	 * Mirrors the logic in QueryEditorSchema.refreshSchemaForTools.
	 */
	private async refreshSchemaDirectly(clusterUrl: string): Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }> {
		const connections = this.connectionManager.getConnections();
		const normalizedInput = clusterUrl.replace(/\/+$/, '').toLowerCase();
		const connection = connections.find(c => c.clusterUrl.replace(/\/+$/, '').toLowerCase() === normalizedInput)
			?? { id: `ephemeral_${Date.now()}`, name: clusterUrl, clusterUrl };

		const schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }> = [];
		try {
			const databases = await this.kustoClient.getDatabases(connection, true);
			if (databases.length === 0) {
				return { schemas: [], error: 'No databases found on this cluster, or insufficient permissions.' };
			}

			const errors: string[] = [];
			for (const db of databases) {
				try {
					const result = await this.kustoClient.getDatabaseSchema(connection, db, true);
					const schema = result.schema;

					const cacheKey = `${connection.clusterUrl.replace(/\/+$/, '')}|${db}`;
					const timestamp = result.fromCache ? Date.now() - (result.cacheAgeMs ?? 0) : Date.now();
					await writeCachedSchemaToDisk(this.context.globalStorageUri, cacheKey, { schema, timestamp, version: SCHEMA_CACHE_VERSION });

					const tables = schema.tables || [];
					const functions = (schema.functions || []).map(f => typeof f === 'string' ? f : f.name || '').filter(Boolean);
					schemas.push({ clusterUrl: connection.clusterUrl, database: db, tables, functions });
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

	/**
	 * Gets the full DatabaseSchemaIndex for a given cluster + database.
	 *
	 * Resolution order:
	 *  1. Disk cache (fast)
	 *  2. Live fetch via the schema refresher callback (caches the result)
	 *  3. Falls back to an error message if both fail
	 *
	 * When `database` is omitted, returns lightweight summaries for every
	 * cached database on the cluster (no live fetch in that case).
	 */
	async getSchema(input: GetSchemaInput): Promise<GetSchemaResult> {
		const clusterUrl = (input.clusterUrl || '').trim();
		if (!clusterUrl) {
			return { error: 'clusterUrl is required.' };
		}

		const db = (input.database || '').trim();

		// ── Single database requested ─────────────────────────────────
		if (db) {
			const cacheKey = `${clusterUrl.replace(/\/+$/, '')}|${db}`;
			let cached = await readCachedSchemaFromDisk(this.context.globalStorageUri, cacheKey);

				if (!cached?.schema) {
				// Not in cache – try to fetch live
				const refreshResult = this.schemaRefresher
					? await this.schemaRefresher(clusterUrl)
					: await this.refreshSchemaDirectly(clusterUrl);
				if (refreshResult.error && refreshResult.schemas.length === 0) {
					return { error: refreshResult.error };
				}
				// Re-read from disk since the refresher persists to cache
				cached = await readCachedSchemaFromDisk(this.context.globalStorageUri, cacheKey);
			}

			if (!cached?.schema) {
				return {
					error: `No schema found for database "${db}" on cluster "${clusterUrl}". ` +
						'Make sure the database name is correct and that you have permissions to access it. ' +
						'You can use #refreshKustoSchema to force-fetch the latest schema from the cluster.'
				};
			}

			return {
				clusterUrl,
				database: db,
				schema: cached.schema,
				cacheAgeMs: Math.max(0, Date.now() - cached.timestamp),
			};
		}

		// ── No specific database – return summaries for the cluster ──
		const schemas = await readAllCachedSchemasFromDisk(
			this.context.globalStorageUri,
			clusterUrl
		);

		if (schemas.length === 0) {
			// Nothing cached – try a live fetch
			const refreshResult = this.schemaRefresher
				? await this.schemaRefresher(clusterUrl)
				: await this.refreshSchemaDirectly(clusterUrl);
			if (refreshResult.error && refreshResult.schemas.length === 0) {
				return { error: refreshResult.error };
			}
			// Re-read from disk
			const refreshed = await readAllCachedSchemasFromDisk(
				this.context.globalStorageUri,
				clusterUrl
			);
			return { databases: refreshed };
		}

		return { databases: schemas };
	}

	async searchCachedSchemas(input: SearchCachedSchemasInput): Promise<{ matches: unknown[]; count: number; pattern: string; error?: string }> {
		const pattern = (input.pattern || '').trim();
		if (!pattern) {
			return { matches: [], count: 0, pattern: '', error: 'pattern is required and must be a non-empty string.' };
		}
		const matches = await searchCachedSchemas(this.context.globalStorageUri, pattern);
		return { matches, count: matches.length, pattern };
	}

	async listSections(): Promise<{ sections: Array<{ id: string; type: string; name?: string; expanded?: boolean; clusterUrl?: string; serverUrl?: string; database?: string; entries?: unknown[] }> }> {
		if (!this.stateGetter) {
			throw new Error('Kusto Workbench is not currently open.');
		}
		const rawSections = await this.stateGetter();
		if (!rawSections) {
			return { sections: [] };
		}
		const sections = rawSections
			.map((s, idx) => {
				const id = typeof s.id === 'string' ? s.id : `section_${idx}`;
				const type = typeof s.type === 'string' ? s.type : 'unknown';
				const name = typeof s.name === 'string' ? s.name : (typeof s.title === 'string' ? s.title : '');
				const expanded = s.expanded !== false;
				const database = typeof s.database === 'string' ? s.database : '';
				// For devnotes sections, include the entries array so the agent can read them
				if (type === 'devnotes') {
					const entries = Array.isArray(s.entries) ? s.entries : [];
					return { id, type, name, expanded, database, entries };
				}
				// SQL sections use serverUrl instead of clusterUrl
				if (type === 'sql') {
					const serverUrl = typeof s.serverUrl === 'string' ? s.serverUrl : '';
					return { id, type, name, expanded, serverUrl, database };
				}
				const clusterUrl = typeof s.clusterUrl === 'string' ? s.clusterUrl : '';
				return { id, type, name, expanded, clusterUrl, database };
			});
		return { sections };
	}

	/**
	 * Returns the current development notes from the open file, if any.
	 */
	async getDevNotes(): Promise<DevNoteEntry[]> {
		if (!this.stateGetter) {
			return [];
		}
		const rawSections = await this.stateGetter();
		if (!rawSections) {
			return [];
		}
		for (const s of rawSections) {
			if (typeof s.type === 'string' && s.type === 'devnotes' && Array.isArray(s.entries)) {
				return s.entries as DevNoteEntry[];
			}
		}
		return [];
	}

	async manageDevelopmentNotes(input: ManageDevelopmentNotesInput): Promise<{ success: boolean; noteId?: string; notes?: DevNoteEntry[]; error?: string }> {
		if (input.action === 'view') {
			const notes = await this.getDevNotes();
			return { success: true, notes };
		}
		if (input.action === 'add') {
			if (!input.content || !input.category) {
				return { success: false, error: 'Both "content" and "category" are required when adding a development note.' };
			}
			const noteId = `dn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			const entry: DevNoteEntry = {
				id: noteId,
				created: new Date().toISOString(),
				updated: new Date().toISOString(),
				category: input.category,
				content: input.content,
				source: 'agent',
				...(input.relatedSectionIds ? { relatedSectionIds: input.relatedSectionIds } : {}),
			};
			const action = input.supersedes ? 'supersede' : 'add';
			return this.sendToWebview('updateDevNotes', { action, entry, supersededId: input.supersedes });
		} else if (input.action === 'remove') {
			if (!input.noteId) {
				return { success: false, error: '"noteId" is required when removing a development note.' };
			}
			return this.sendToWebview('updateDevNotes', { action: 'remove', noteId: input.noteId });
		}
		return { success: false, error: `Unknown action: ${input.action}` };
	}

	// ── SQL tools ─────────────────────────────────────────────────────────────

	async listSqlConnections(): Promise<{ connections: Array<{ id: string; name: string; serverUrl: string; dialect: string }> }> {
		const conns = this.getSqlConnectionManager().getConnections();
		return { connections: conns.map(c => ({ id: c.id, name: c.name, serverUrl: c.serverUrl, dialect: c.dialect })) };
	}

	async configureSqlSection(input: ConfigureSqlSectionInput): Promise<{ success: boolean; resultPreview?: string }> {
		if (input.query !== undefined) {
			input = { ...input, query: unescapeLLMText(input.query) };
		}
		return this.sendToWebview('toolConfigureSqlSection', { input });
	}

	async getSqlSchema(input: GetSqlSchemaInput): Promise<{ success: boolean; schema?: unknown; error?: string }> {
		return this.sendToWebview('toolGetSqlSchema', { sectionId: input.sectionId });
	}

	async delegateToSqlCopilot(input: DelegateToSqlCopilotInput): Promise<{
		success: boolean;
		answer: string;
		query?: string;
		error?: string;
		timedOut?: boolean;
	}> {
		return this.sendToWebview('toolDelegateToSqlCopilot', { input }, 180000);
	}

	async addSection(input: AddSectionInput): Promise<{ sectionId: string; success: boolean }> {
		// Unescape literal \n sequences that LLMs frequently produce in text content
		const textValue = input.text ?? input.content;
		if (textValue !== undefined) {
			input = { ...input, text: unescapeLLMText(textValue) };
		}
		if (input.query !== undefined) {
			input = { ...input, query: unescapeLLMText(input.query) };
		}
		if (input.code !== undefined) {
			input = { ...input, code: unescapeLLMText(input.code) };
		}
		return this.sendToWebview('toolAddSection', { input });
	}

	async removeSection(input: RemoveSectionInput): Promise<{ success: boolean }> {
		return this.sendToWebview('toolRemoveSection', { sectionId: input.sectionId });
	}

	async collapseSection(input: CollapseSectionInput): Promise<{ success: boolean }> {
		return this.sendToWebview('toolCollapseSection', { sectionId: input.sectionId, collapsed: input.collapsed });
	}

	async reorderSections(input: ReorderSectionsInput): Promise<{ success: boolean; error?: string }> {
		return this.sendToWebview('toolReorderSections', { sectionIds: input.sectionIds });
	}

	async configureQuerySection(input: ConfigureQuerySectionInput): Promise<{ success: boolean; resultPreview?: string }> {
		// Unescape literal \n sequences that LLMs frequently produce in query text
		if (input.query !== undefined) {
			input = { ...input, query: unescapeLLMText(input.query) };
		}
		return this.sendToWebview('toolConfigureQuerySection', { input });
	}

	async updateMarkdownSection(input: UpdateMarkdownSectionInput): Promise<{ success: boolean }> {
		// Unescape literal \n sequences that LLMs frequently produce in markdown text
		const textValue = input.text ?? input.content;
		if (textValue !== undefined) {
			input = { ...input, text: unescapeLLMText(textValue) };
		}
		return this.sendToWebview('toolUpdateMarkdownSection', { input });
	}

	async configureChart(input: ConfigureChartInput): Promise<{ success: boolean }> {
		return this.sendToWebview('toolConfigureChart', { input });
	}

	async configureTransformation(input: ConfigureTransformationInput): Promise<{ success: boolean }> {
		return this.sendToWebview('toolConfigureTransformation', { input });
	}

	async configureHtmlSection(input: ConfigureHtmlSectionInput): Promise<{ success: boolean; sectionId?: string }> {
		if (input.code !== undefined) {
			input = { ...input, code: unescapeLLMText(input.code) };
		}
		return this.sendToWebview('toolConfigureHtmlSection', {
			sectionId: input.sectionId,
			name: input.name,
			code: input.code,
			mode: input.mode,
		});
	}

	async delegateToKustoWorkbenchCopilot(input: DelegateToKustoWorkbenchCopilotInput): Promise<{
		success: boolean;
		answer: string;
		query?: string;
		executed?: boolean;
		rowCount?: number;
		columns?: string[];
		results?: Array<Record<string, unknown>>;
		error?: string;
		timedOut?: boolean;
	}> {
		return this.sendToWebview('toolDelegateToKustoWorkbenchCopilot', { input }, 180000); // 3 minute timeout for Copilot + query execution
	}

	async createFile(input: CreateFileInput): Promise<{
		success: boolean;
		filePath?: string;
		error?: string;
	}> {
		// Unescape literal \n sequences that LLMs frequently produce in text content
		const rawContent = input.initialContent;
		const initialContent = typeof rawContent === 'string' ? unescapeLLMText(rawContent) : rawContent;
		const { fileType, filePath: requestedPath } = input;

		// Determine the file extension and editor to use
		let extension: string;
		let sidecarExtension: string | undefined;
		let editorId: string;
		let isSidecar = false;
		let kqlxKind: KqlxFileKind | undefined;

		switch (fileType) {
			case 'kqlx':
				extension = '.kqlx';
				editorId = 'kusto.kqlxEditor';
				kqlxKind = 'kqlx';
				break;
			case 'mdx':
				extension = '.mdx';
				editorId = 'kusto.kqlxEditor';
				kqlxKind = 'mdx';
				break;
			case 'kql':
				extension = '.kql';
				editorId = 'kusto.kqlCompatEditor';
				break;
			case 'csl':
				extension = '.csl';
				editorId = 'kusto.kqlCompatEditor';
				break;
			case 'md':
				extension = '.md';
				editorId = 'kusto.mdCompatEditor';
				break;
			case 'kql-sidecar':
				extension = '.kql';
				sidecarExtension = '.kql.json';
				editorId = 'kusto.kqlCompatEditor';
				isSidecar = true;
				break;
			case 'csl-sidecar':
				extension = '.csl';
				sidecarExtension = '.csl.json';
				editorId = 'kusto.kqlCompatEditor';
				isSidecar = true;
				break;
			default:
				return { success: false, error: `Unknown file type: ${fileType}` };
		}

		// Determine the file URI
		let fileUri: vscode.Uri | undefined;
		
		if (requestedPath) {
			// Use the provided path (add extension if not present)
			let fullPath = requestedPath;
			if (!fullPath.endsWith(extension)) {
				fullPath = fullPath + extension;
			}
			fileUri = vscode.Uri.file(fullPath);
		} else {
			// Generate a default filename in the workspace folder
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
			if (!workspaceFolder) {
				return { success: false, error: 'No workspace folder open. Please provide a full file path or open a folder first.' };
			}
			
			// Generate a unique filename based on the file type and timestamp
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			const baseName = fileType === 'kqlx' || fileType === 'mdx' 
				? `kusto-notebook-${timestamp}`
				: fileType === 'md'
					? `notes-${timestamp}`
					: `query-${timestamp}`;
			
			fileUri = vscode.Uri.joinPath(workspaceFolder, baseName + extension);
		}

		if (!fileUri) {
			return { success: false, error: 'File creation cancelled' };
		}

		try {
			// Create the file content based on file type
			let content: string;
			
			if (kqlxKind) {
				// Create kqlx/mdx notebook
				const file = createEmptyKqlxOrMdxFile(kqlxKind);
				
				// Add initial content as a section if provided
				if (initialContent) {
					const initialSection: KqlxSectionV1 = {
						type: kqlxKind === 'mdx' ? 'markdown' : 'query',
						expanded: true,
						...(kqlxKind === 'mdx' 
							? { text: initialContent } 
							: { query: initialContent }
						)
					};
					file.state.sections.push(initialSection);
				}
				
				content = JSON.stringify(file, null, 2);
			} else if (fileType === 'md') {
				// Plain markdown file
				content = initialContent || '';
			} else {
				// Plain KQL/CSL file
				content = initialContent || '';
			}

			// Write the main file
			await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));

			// Create sidecar file if needed
			if (isSidecar && sidecarExtension) {
				const sidecarPath = fileUri.fsPath.replace(extension, sidecarExtension);
				const sidecarUri = vscode.Uri.file(sidecarPath);
				
				// Create sidecar with linked query section pointing to the main file.
				// linkedQueryPath must be on the first section (not on state) for
				// isLinkedSidecarForCompatFile() to detect the sidecar correctly.
				const baseName = fileUri.fsPath.split(/[\\/]/).pop() || '';
				const sidecarContent = JSON.stringify({
					kind: 'kqlx',
					version: 1,
					state: {
						sections: [{ type: 'query', linkedQueryPath: baseName }]
					}
				}, null, 2);
				
				await vscode.workspace.fs.writeFile(sidecarUri, new TextEncoder().encode(sidecarContent));
			}

			// Open the file with the appropriate editor
			await vscode.commands.executeCommand('vscode.openWith', fileUri, editorId);

			return { success: true, filePath: fileUri.fsPath };
		} catch (err) {
			return {
				success: false,
				error: `Failed to create file: ${err instanceof Error ? err.message : String(err)}`
			};
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool implementations as LanguageModelTool classes
// ─────────────────────────────────────────────────────────────────────────────

export class ListConnectionsTool implements vscode.LanguageModelTool<ListConnectionsInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		_options: vscode.LanguageModelToolInvocationOptions<ListConnectionsInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.listConnections();
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class ListFavoritesTool implements vscode.LanguageModelTool<ListFavoritesInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		_options: vscode.LanguageModelToolInvocationOptions<ListFavoritesInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.listFavorites();
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class RefreshKustoSchemaTool implements vscode.LanguageModelTool<RefreshKustoSchemaInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<RefreshKustoSchemaInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.refreshSchema(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<RefreshKustoSchemaInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		const input = getToolInput(options);
		const clusterUrl = input?.clusterUrl || 'unknown cluster';
		return {
			invocationMessage: `Refreshing schema for ${clusterUrl}...`
		};
	}
}

export class SearchCachedSchemasTool implements vscode.LanguageModelTool<SearchCachedSchemasInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<SearchCachedSchemasInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.searchCachedSchemas(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<SearchCachedSchemasInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		const input = getToolInput(options);
		const pattern = input?.pattern || '';
		return {
			invocationMessage: `Searching cached schemas for "${pattern}"…`
		};
	}
}

export class GetSchemaTool implements vscode.LanguageModelTool<GetSchemaInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<GetSchemaInput>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.getSchema(getToolInput(options));

			// If the result is an error or a multi-database summary, return as JSON
			if (result.error || result.databases) {
				return new vscode.LanguageModelToolResult([
					new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
				]);
			}

			// Single-database schema: apply token budget pruning (like get_extended_schema)
			const schema = result.schema!;
			const db = result.database || '';
			const tablesCount = schema.tables?.length ?? 0;
			const columnsCount = countColumns(schema);
			const functionsCount = schema.functions?.length ?? 0;
			const schemaMeta = { cacheAgeMs: result.cacheAgeMs, tablesCount, columnsCount, functionsCount };

			const tok = options.tokenizationOptions;
			if (tok && typeof tok.countTokens === 'function' && typeof tok.tokenBudget === 'number' && tok.tokenBudget > 0) {
				try {
					const pruneResult = await formatSchemaWithTokenBudget(
						db, schema, schemaMeta, tok.tokenBudget,
						(text) => tok.countTokens(text, token)
					);
					return new vscode.LanguageModelToolResult([
						new vscode.LanguageModelTextPart(pruneResult.text)
					]);
				} catch {
					// Fall through to unpruned format
				}
			}

			// No token budget info — return full compact text
			const text = formatSchemaAsCompactText(db, schema, schemaMeta);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(text)
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<GetSchemaInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		const input = getToolInput(options);
		const cluster = input?.clusterUrl || 'unknown cluster';
		const db = input?.database;
		return {
			invocationMessage: db
				? `Getting schema for ${db} on ${cluster}…`
				: `Getting schemas for ${cluster}…`
		};
	}
}

export class ListSectionsTool implements vscode.LanguageModelTool<ListSectionsInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		_options: vscode.LanguageModelToolInvocationOptions<ListSectionsInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.listSections();
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class AddSectionTool implements vscode.LanguageModelTool<AddSectionInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<AddSectionInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.addSection(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class RemoveSectionTool implements vscode.LanguageModelTool<RemoveSectionInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<RemoveSectionInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.removeSection(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class CollapseSectionTool implements vscode.LanguageModelTool<CollapseSectionInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CollapseSectionInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.collapseSection(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class ReorderSectionsTool implements vscode.LanguageModelTool<ReorderSectionsInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ReorderSectionsInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.reorderSections(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class ConfigureQuerySectionTool implements vscode.LanguageModelTool<ConfigureQuerySectionInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ConfigureQuerySectionInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.configureQuerySection(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class UpdateMarkdownSectionTool implements vscode.LanguageModelTool<UpdateMarkdownSectionInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<UpdateMarkdownSectionInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.updateMarkdownSection(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class ConfigureChartTool implements vscode.LanguageModelTool<ConfigureChartInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ConfigureChartInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.configureChart(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class ConfigureTransformationTool implements vscode.LanguageModelTool<ConfigureTransformationInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ConfigureTransformationInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.configureTransformation(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class DelegateToKustoWorkbenchCopilotTool implements vscode.LanguageModelTool<DelegateToKustoWorkbenchCopilotInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<DelegateToKustoWorkbenchCopilotInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.delegateToKustoWorkbenchCopilot(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<DelegateToKustoWorkbenchCopilotInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		const input = getToolInput(options);
		const question = input?.question || 'your question';
		return {
			invocationMessage: `Asking Kusto Workbench Copilot: "${question.slice(0, 100)}${question.length > 100 ? '...' : ''}"`
		};
	}
}

export class CreateFileTool implements vscode.LanguageModelTool<CreateFileInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CreateFileInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.createFile(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<CreateFileInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		const input = getToolInput(options);
		const fileType = input?.fileType || 'kqlx';
		const filePath = input?.filePath;
		const message = filePath
			? `Creating ${fileType} file: ${filePath}`
			: `Creating new ${fileType} file...`;
		return {
			invocationMessage: message
		};
	}
}

export class ManageDevelopmentNotesTool implements vscode.LanguageModelTool<ManageDevelopmentNotesInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ManageDevelopmentNotesInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.manageDevelopmentNotes(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ManageDevelopmentNotesInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		const input = getToolInput(options);
		const action = input?.action || 'add';
		const message = action === 'view'
			? 'Reading development notes...'
			: action === 'add'
				? `Saving development note${input?.category ? ` (${input.category})` : ''}...`
				: `Removing development note${input?.noteId ? ` ${input.noteId}` : ''}...`;
		return {
			invocationMessage: message
		};
	}
}

export class ConfigureHtmlSectionTool implements vscode.LanguageModelTool<ConfigureHtmlSectionInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ConfigureHtmlSectionInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.configureHtmlSection(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ConfigureHtmlSectionInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		const input = getToolInput(options);
		const sectionId = input?.sectionId || 'unknown';
		return {
			invocationMessage: `Configuring HTML section ${sectionId}…`
		};
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration helper
// ─────────────────────────────────────────────────────────────────────────────

// ── SQL Tools ─────────────────────────────────────────────────────────────────

export class ListSqlConnectionsTool implements vscode.LanguageModelTool<ListSqlConnectionsInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}
	async invoke(
		_options: vscode.LanguageModelToolInvocationOptions<ListSqlConnectionsInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.listSqlConnections();
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class ConfigureSqlSectionTool implements vscode.LanguageModelTool<ConfigureSqlSectionInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ConfigureSqlSectionInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.configureSqlSection(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class DelegateToSqlCopilotTool implements vscode.LanguageModelTool<DelegateToSqlCopilotInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<DelegateToSqlCopilotInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.delegateToSqlCopilot(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<DelegateToSqlCopilotInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		const input = getToolInput(options);
		const question = input?.question || 'your question';
		return {
			invocationMessage: `Asking SQL Copilot: "${question.slice(0, 100)}${question.length > 100 ? '...' : ''}"`
		};
	}
}

export class GetSqlSchemaTool implements vscode.LanguageModelTool<GetSqlSchemaInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<GetSqlSchemaInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.getSqlSchema(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export function registerKustoWorkbenchTools(
	context: vscode.ExtensionContext,
	connectionManager: ConnectionManager,
	getSqlConnectionManager: () => SqlConnectionManager,
	kustoClient: KustoQueryClient
): KustoWorkbenchToolOrchestrator {
	const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(context, connectionManager, getSqlConnectionManager, kustoClient);

	// Register all tools using the languageModelTools[].name values from package.json
	// This is how VS Code binds the manifest contribution to the implementation
	context.subscriptions.push(
		vscode.lm.registerTool('kusto-workbench_list-connections', new ListConnectionsTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_list-favorites', new ListFavoritesTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_get-schema', new GetSchemaTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_refresh-schema', new RefreshKustoSchemaTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_search-cached-schemas', new SearchCachedSchemasTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_list-sections', new ListSectionsTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_add-section', new AddSectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_remove-section', new RemoveSectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_collapse-section', new CollapseSectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_reorder-sections', new ReorderSectionsTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_configure-query-section', new ConfigureQuerySectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_update-markdown-section', new UpdateMarkdownSectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_configure-chart', new ConfigureChartTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_configure-transformation', new ConfigureTransformationTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_configure-html-section', new ConfigureHtmlSectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_ask-kusto-copilot', new DelegateToKustoWorkbenchCopilotTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_create-file', new CreateFileTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_manage-development-notes', new ManageDevelopmentNotesTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_list-sql-connections', new ListSqlConnectionsTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_configure-sql-section', new ConfigureSqlSectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_get-sql-schema', new GetSqlSchemaTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_ask-sql-copilot', new DelegateToSqlCopilotTool(orchestrator))
	);

	return orchestrator;
}
