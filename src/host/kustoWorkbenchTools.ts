import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionManager, KustoConnection } from './connectionManager';
import {
	createEmptyKqlxOrMdxFile,
	type DevNoteEntry,
	type KqlxFileKind,
	type KqlxSectionV1,
} from './kqlxFormat';
import { defaultSectionKindForDocument } from '../shared/documentSectionCapabilities';
import { captureSchemaCacheGeneration, readAllCachedSchemasFromDisk, readCachedSchemaFromDiskByCluster, searchCachedSchemas, writeCachedSchemaToDisk, SCHEMA_CACHE_VERSION, schemaCacheKey, schemaPrincipalIdentity, type SchemaCacheGeneration } from './schemaCache';
import { KustoConnectionCache, type KustoConnectionCacheGeneration } from './kustoConnectionCache';
import type { SqlConnection, SqlConnectionManager } from './sqlConnectionManager';
import type { KustoQueryClient } from './kustoClient';
import { countColumns, formatSchemaAsCompactText, formatSchemaWithTokenBudget } from './schemaIndexUtils';
import {
	getPowerBiHtmlValidationDiagnostics,
	type PowerBiDataSource,
} from './powerBiExport';
import { getLegacyDashboardWarnings } from '../shared/htmlDashboardUpgrade';
import type { PortableDashboardDiagnostic } from '../shared/portableDashboardCompiler';
import { classifyWorkbenchUri, classifyWorkbenchUriString, type WorkbenchFileInfo, type WorkbenchFileKind } from './workbenchFileTypes';
import { kustoClusterKey } from '../shared/kustoClusterUrls';
import { getKustoConnectionIdentityKey, resolveStrictKustoConnection } from '../shared/kustoAuth';
import { filterKustoFavoritesForActivePrincipals, migrateKustoFavorites } from './connectionManagerFavorites';
import { sqlConnectionTargetSignature } from '../shared/sqlConnectionIdentity';
import { readCurrentSqlSchemaPrincipalFingerprint } from './sqlEditorSchema';
import type { KustoExecutionRequestIdentity } from '../shared/kustoExecution.js';
import type { KustoLeaveNoTracePolicySnapshot } from './kustoLeaveNoTracePolicyStore';

export type TargetFields = {
	openFileId?: string;
	targetFileUri?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper to extract tool input from invocation options
// VS Code API changed from 'input' to 'parameters' - handle both for compatibility
// ─────────────────────────────────────────────────────────────────────────────

function getToolInput<T>(options: vscode.LanguageModelToolInvocationOptions<T> | vscode.LanguageModelToolInvocationPrepareOptions<T>): T {
	// Try 'input' first (original API), then 'parameters' (new API)
	const opts = options as any;
	return opts.input ?? opts.parameters ?? ({} as T);
}

function raceCancellation<T>(promise: Promise<T>, token: vscode.CancellationToken): Promise<T> {
	if (token.isCancellationRequested) return Promise.reject(new vscode.CancellationError());
	return new Promise<T>((resolve, reject) => {
		let subscription: vscode.Disposable | undefined;
		subscription = token.onCancellationRequested(() => {
			subscription?.dispose();
			reject(new vscode.CancellationError());
		});
		promise.then(
			value => { subscription?.dispose(); resolve(value); },
			error => { subscription?.dispose(); reject(error); },
		);
	});
}

const ASK_KUSTO_COPILOT_DEFAULT_MAX_RESULT_ROWS = 100;
const ASK_KUSTO_COPILOT_MIN_MAX_RESULT_ROWS = 1;
const ASK_KUSTO_COPILOT_MAX_MAX_RESULT_ROWS = 1000;

function normalizeAskKustoCopilotMaxResultRows(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return ASK_KUSTO_COPILOT_DEFAULT_MAX_RESULT_ROWS;
	}
	const integerValue = Math.trunc(value);
	return Math.max(
		ASK_KUSTO_COPILOT_MIN_MAX_RESULT_ROWS,
		Math.min(ASK_KUSTO_COPILOT_MAX_MAX_RESULT_ROWS, integerValue)
	);
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

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter(value => !!value && value.trim().length > 0))];
}

function extractMarkdownSection(source: string, heading: string): string {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const startMatch = new RegExp(`^## ${escaped}\\s*$`, 'm').exec(source);
	if (!startMatch) return source;
	const start = startMatch.index;
	const rest = source.slice(start + startMatch[0].length);
	const nextHeading = /^##\s+/m.exec(rest);
	return source.slice(start, nextHeading ? start + startMatch[0].length + nextHeading.index : source.length).trim();
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
	/** Optional saved connection ID. Required when multiple authority-specific connections share a cluster URL. */
	connectionId?: string;
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

export interface RefreshKustoSchemaInput extends TargetFields {
	/** The cluster URL for which to refresh the schema (e.g., 'https://help.kusto.windows.net'). */
	clusterUrl: string;
	/** Optional saved connection ID. Required when multiple authority-specific connections share a cluster URL. */
	connectionId?: string;
}

export interface SearchCachedSchemasInput {
	/** A regex pattern to search for across table names, column names, function names, and their docstrings. Case-insensitive. */
	pattern: string;
}

export interface ListSectionsInput {
	// No input required
}

export interface AddSectionInput extends TargetFields {
	type: 'query' | 'markdown' | 'chart' | 'transformation' | 'url' | 'python' | 'html' | 'sql';
	/** For query sections: initial query text */
	query?: string;
	/** For query sections: cluster URL to connect to */
	clusterUrl?: string;
	/** For query sections: exact saved connection ID from listKustoConnections. Required when the endpoint is ambiguous. */
	connectionId?: string;
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

export interface RemoveSectionInput extends TargetFields {
	sectionId: string;
}

export interface CollapseSectionInput extends TargetFields {
	sectionId: string;
	collapsed: boolean;
}

export interface ReorderSectionsInput extends TargetFields {
	/** Array of section IDs in the desired order. All section IDs must be included. Devnotes IDs are accepted but silently ignored (they have no visual position). */
	sectionIds: string[];
}

export interface ConfigureQuerySectionInput extends TargetFields {
	sectionId: string;
	/** Optional name/title for the section */
	name?: string;
	query?: string;
	clusterUrl?: string;
	/** Exact saved connection ID from listKustoConnections. Required when the endpoint is ambiguous. */
	connectionId?: string;
	database?: string;
	execute?: boolean;
}

export interface UpdateMarkdownSectionInput extends TargetFields {
	sectionId: string;
	/** Optional name/title for the section */
	name?: string;
	text?: string;
	/** Alias for text - LLMs may use either property name */
	content?: string;
	mode?: 'preview' | 'markdown' | 'wysiwyg';
}

export interface ConfigureChartInput extends TargetFields {
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

export interface ConfigureTransformationInput extends TargetFields {
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

export interface DelegateToKustoWorkbenchCopilotInput extends TargetFields {
	/** The question or request to send to Kusto Workbench Copilot */
	question: string;
	/** Optional: The ID of a query section to use. If not provided, one will be created or the first available will be used. */
	sectionId?: string;
	/** Optional: Cluster URL to connect to (e.g., 'https://help.kusto.windows.net'). If not provided, uses the current connection. */
	clusterUrl?: string;
	/** Optional exact saved connection ID from listKustoConnections. Required when clusterUrl is ambiguous. */
	connectionId?: string;
	/** Optional: Database name to use. If not provided, uses the current database. */
	database?: string;
	/** Optional: Maximum rows returned in the tool response. Defaults to 100. */
	maxResultRows?: number;
}

export interface ConfigureHtmlSectionInput extends TargetFields {
	sectionId: string;
	/** Optional name/title for the section */
	name?: string;
	/** HTML + JS source code */
	code?: string;
	/** Section mode: 'code' for editor, 'preview' for rendered HTML */
	mode?: 'code' | 'preview';
}

export interface GetHtmlDashboardGuideInput {
	/** Which portion of the dashboard guide to return. */
	mode?: 'checklist' | 'template' | 'full';
}

export interface ValidateHtmlDashboardInput extends TargetFields {
	/** The ID of the HTML section to validate. */
	sectionId: string;
}

interface HtmlDashboardContextResult {
	success?: boolean;
	sectionId?: string;
	name?: string;
	code?: string;
	previewHeight?: number;
	hasProvenance?: boolean;
	bindingCount?: number;
	dataSources?: PowerBiDataSource[];
	factColumns?: Array<{ name: string; type: string }>;
	error?: string;
}

export interface ValidateHtmlDashboardResult {
	success: boolean;
	valid: boolean;
	sectionId: string;
	issues: string[];
	diagnostics: PortableDashboardDiagnostic[];
	warnings: string[];
	hasProvenance: boolean;
	bindingCount: number;
	dataSourceCount: number;
	factColumns: Array<{ name: string; type: string }>;
	filePath?: string;
	fileName?: string;
	error?: string;
}

export interface CreateFileInput {
	/**
	 * The type of file to create:
	 * - kqlx: Kusto Notebook (rich notebook with multiple sections)
	 * - sqlx: SQL Notebook (SQL plus derived and presentation sections)
	 * - mdx: Markdown-focused notebook (same format as kqlx, but defaults to markdown-first)
	 * - kql: Plain Kusto query file
	 * - csl: Plain Kusto query file (alternative extension)
	 * - md: Plain markdown file
	 * - kql-sidecar: Creates both a .kql file and its companion .kql.json sidecar file
	 * - csl-sidecar: Creates both a .csl file and its companion .csl.json sidecar file
	 */
	fileType: 'kqlx' | 'sqlx' | 'mdx' | 'kql' | 'csl' | 'md' | 'kql-sidecar' | 'csl-sidecar';
	/**
	 * The full file path (without extension) where the file should be created.
	 * The LLM must always provide a filePath. If not provided, a default will be generated.
	 * Example: '/path/to/my-queries/analysis' will create 'analysis.kqlx' (or appropriate extension)
	 */
	filePath?: string;
	/**
	 * Optional: Initial content to add to the file.
	 * - For kqlx/sqlx/mdx: Initial Kusto, SQL, or markdown text
	 * - For kql/csl/kql-sidecar/csl-sidecar: The initial KQL query
	 * - For md: The initial markdown content
	 */
	initialContent?: string;
}

export interface ManageDevelopmentNotesInput {
	action: 'add' | 'remove' | 'view';
	/** Optional: target a specific open Workbench file returned by #listSections. */
	openFileId?: string;
	/** Optional: target a specific Workbench file URI. */
	targetFileUri?: string;
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

export interface ConfigureSqlSectionInput extends TargetFields {
	sectionId: string;
	name?: string;
	query?: string;
	connectionId?: string;
	serverUrl?: string;
	database?: string;
	execute?: boolean;
}

export interface GetSqlSchemaInput extends TargetFields {
	/** Optional: defaults to the first ready SQL section in the targeted editor. */
	sectionId?: string;
}

export interface DelegateToSqlCopilotInput extends TargetFields {
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
	connectionId: string;
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

type ToolSectionSummary = {
	id: string;
	type: string;
	name?: string;
	expanded?: boolean;
	clusterUrl?: string;
	serverUrl?: string;
	database?: string;
	entries?: unknown[];
};

type OpenWorkbenchFileSummary = {
	openFileId: string;
	uri: string;
	logicalUri: string;
	fileKind: WorkbenchFileKind;
	filePath?: string;
	fileName?: string;
	sidecarFor?: string;
	isActive: boolean;
	isLiveWorkbench: boolean;
	isReadOnlyFallback: boolean;
	sections?: ToolSectionSummary[];
	sectionsUnavailable?: boolean;
	error?: string;
};

type InternalOpenWorkbenchFileSummary = OpenWorkbenchFileSummary & {
	logicalUriKey: string;
	priority: number;
};

type ListSectionsResult = {
	sections: ToolSectionSummary[];
	filePath?: string;
	fileName?: string;
	openFiles?: OpenWorkbenchFileSummary[];
};

type ActivationResult = {
	success: boolean;
	openFileId?: string;
	uri?: string;
	logicalUri?: string;
	fileKind?: WorkbenchFileKind;
	filePath?: string;
	fileName?: string;
	isLiveWorkbench?: boolean;
	isReadOnlyFallback?: boolean;
	error?: string;
};

interface LiveWorkbenchConnection {
	token: number;
	poster: (message: unknown) => unknown;
	stateGetter: () => Promise<ToolSection[] | undefined>;
	schemaRefresher: (clusterUrl: string, connectionId: string) => Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }>;
	sqlConnectionResolver?: (sectionId?: string) => string | undefined;
	sqlOwnerResolver?: (sectionId: string) => {
		connectionId: string;
		database: string;
		ownerToken: string;
		generation: number;
	} | undefined;
	documentUri?: string;
	documentInfo?: WorkbenchFileInfo;
	logicalUriKey?: string;
	sequence: number;
}

type KustoToolMetadataOwner = Readonly<{
	connection: KustoConnection;
	connectionIdentityKey: string;
	connectionIncarnation: number;
	accountPartition?: string;
	authSessionGeneration: number;
	leaveNoTraceRevision: number;
	databaseCacheGeneration: KustoConnectionCacheGeneration;
	schemaCacheGeneration: SchemaCacheGeneration;
}>;

type KustoToolSchemaResult = Readonly<{
	database: string;
	schema: DatabaseSchemaIndex;
	accountPartition: string;
	cacheGeneration: SchemaCacheGeneration;
	timestamp: number;
}>;

type KustoMetadataCacheRead<T> =
	| Readonly<{ kind: 'found'; value: T }>
	| Readonly<{ kind: 'missing' | 'rejected' }>;

class KustoMetadataOwnerChangedError extends Error {
	constructor() {
		super('Kusto metadata owner changed before the operation could be admitted.');
		this.name = 'KustoMetadataOwnerChangedError';
	}
}

function cacheGenerationMatches(
	current: KustoConnectionCacheGeneration | SchemaCacheGeneration,
	expected: KustoConnectionCacheGeneration | SchemaCacheGeneration,
): boolean {
	return current.global === expected.global
		&& current.connection === expected.connection
		&& current.partition === expected.partition;
}

export class KustoWorkbenchToolOrchestrator {
	private static instance: KustoWorkbenchToolOrchestrator | undefined;
	
	// Legacy fallback callbacks for the latest connected editor, including the standalone Query Editor.
	private webviewMessagePoster: ((message: unknown) => void) | undefined;
	private stateGetter: (() => Promise<ToolSection[] | undefined>) | undefined;
	private schemaRefresher: ((clusterUrl: string, connectionId: string) => Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }>) | undefined;
	private activeDocumentUri: string | undefined;
	private latestConnectionToken: number | undefined;
	private readonly liveConnections = new Map<number, LiveWorkbenchConnection>();
	private readonly renamedWorkbenchFiles = new Map<string, WorkbenchFileInfo>();
	// Pending responses from webview
	private pendingResponses = new Map<string, {
		resolve: (value: unknown) => void;
		reject: (err: Error) => void;
		timer?: ReturnType<typeof setTimeout>;
		cancellationSubscription?: vscode.Disposable;
		connectionToken: number;
		kustoExecution?: KustoExecutionRequestIdentity;
	}>();
	private responseSeq = 0;
	private readonly kustoConnectionCache: KustoConnectionCache;
	// Monotonically increasing token to track which editor instance is currently connected.
	// disconnectIfOwner() only clears the callbacks when the caller's token matches,
	// preventing a stale editor from disconnecting a newer active one.
	private connectionToken = 0;

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly connectionManager: ConnectionManager,
		private readonly getSqlConnectionManager: () => SqlConnectionManager,
		private readonly kustoClient: KustoQueryClient,
		private readonly refreshSqlLeaveNoTracePolicy?: () => Promise<string[]>,
		private readonly assertSqlConnectionAllowed?: (connectionId: string) => Promise<void>,
		private readonly getSqlRevocationGeneration?: (connectionId: string) => number,
		private readonly dispatchSqlOwnerAllowed?: <T>(
			connection: SqlConnection,
			principalFingerprint: string,
			revocationGeneration: number,
			dispatch: () => T | PromiseLike<T>,
		) => Promise<T>,
	) {
		this.kustoConnectionCache = new KustoConnectionCache(this.context);
	}

	static getInstance(
		context: vscode.ExtensionContext,
		connectionManager: ConnectionManager,
		getSqlConnectionManager: () => SqlConnectionManager,
		kustoClient: KustoQueryClient,
		refreshSqlLeaveNoTracePolicy?: () => Promise<string[]>,
		assertSqlConnectionAllowed?: (connectionId: string) => Promise<void>,
		getSqlRevocationGeneration?: (connectionId: string) => number,
		dispatchSqlOwnerAllowed?: <T>(connection: SqlConnection, principalFingerprint: string, revocationGeneration: number, dispatch: () => T | PromiseLike<T>) => Promise<T>,
	): KustoWorkbenchToolOrchestrator {
		if (!KustoWorkbenchToolOrchestrator.instance) {
			KustoWorkbenchToolOrchestrator.instance = new KustoWorkbenchToolOrchestrator(
				context,
				connectionManager,
				getSqlConnectionManager,
				kustoClient,
				refreshSqlLeaveNoTracePolicy,
				assertSqlConnectionAllowed,
				getSqlRevocationGeneration,
				dispatchSqlOwnerAllowed,
			);
		}
		return KustoWorkbenchToolOrchestrator.instance;
	}

	/**
	 * Connect an editor instance to the orchestrator. Returns a token that must
	 * be passed to {@link disconnectIfOwner} so only the currently-connected
	 * instance can clear the callbacks.
	 */
	connect(
		poster: (message: unknown) => unknown,
		stateGetter: () => Promise<ToolSection[] | undefined>,
		schemaRefresher: (clusterUrl: string, connectionId: string) => Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }>,
		documentUri?: string,
		sqlConnectionResolver?: (sectionId?: string) => string | undefined,
		sqlOwnerResolver?: LiveWorkbenchConnection['sqlOwnerResolver'],
	): number {
		this.connectionToken++;
		const classifiedDocumentInfo = documentUri
			? classifyWorkbenchUriString(documentUri, { includeOptionalPlainText: true })
			: undefined;
		const documentInfo = classifiedDocumentInfo
			? this.resolveRenamedWorkbenchFileInfo(classifiedDocumentInfo)
			: undefined;
		const entry: LiveWorkbenchConnection = {
			token: this.connectionToken,
			poster,
			stateGetter,
			schemaRefresher,
			...(sqlConnectionResolver ? { sqlConnectionResolver } : {}),
			...(sqlOwnerResolver ? { sqlOwnerResolver } : {}),
			...(documentUri ? { documentUri } : {}),
			...(documentInfo ? { documentInfo, logicalUriKey: documentInfo.logicalUriKey } : {}),
			sequence: this.connectionToken,
		};
		this.liveConnections.set(entry.token, entry);
		this.applyLatestConnection(entry);
		return this.connectionToken;
	}

	activateConnection(token: number): void {
		const connection = this.liveConnections.get(token);
		if (connection) this.applyLatestConnection(connection);
	}

	/**
	 * Disconnect only if the caller holds the current connection token.
	 * This prevents a closing editor from disconnecting a different active one.
	 */
	disconnectIfOwner(token: number): void {
		this.liveConnections.delete(token);
		for (const [requestId, pending] of [...this.pendingResponses]) {
			if (pending.connectionToken !== token) continue;
			this.pendingResponses.delete(requestId);
			if (pending.timer) clearTimeout(pending.timer);
			pending.cancellationSubscription?.dispose();
			pending.reject(new Error('The owning Kusto Workbench editor closed before the request completed.'));
		}
		if (this.latestConnectionToken !== token) {
			return;
		}
		this.applyLatestConnection(this.getLatestLiveConnection());
	}

	private applyLatestConnection(entry: LiveWorkbenchConnection | undefined): void {
		this.latestConnectionToken = entry?.token;
		this.webviewMessagePoster = entry?.poster;
		this.stateGetter = entry?.stateGetter;
		this.schemaRefresher = entry?.schemaRefresher;
		this.activeDocumentUri = entry?.documentUri;
	}

	private getLatestLiveConnection(): LiveWorkbenchConnection | undefined {
		let latest: LiveWorkbenchConnection | undefined;
		for (const entry of this.liveConnections.values()) {
			if (!latest || entry.sequence > latest.sequence) {
				latest = entry;
			}
		}
		return latest;
	}

	private getLatestLiveConnectionForKey(logicalUriKey: string): LiveWorkbenchConnection | undefined {
		let latest: LiveWorkbenchConnection | undefined;
		for (const entry of this.liveConnections.values()) {
			if (entry.logicalUriKey !== logicalUriKey) {
				continue;
			}
			if (!latest || entry.sequence > latest.sequence) {
				latest = entry;
			}
		}
		return latest;
	}

	private resolveRenamedWorkbenchFileInfo(info: WorkbenchFileInfo): WorkbenchFileInfo {
		let current = info;
		const seen = new Set<string>();
		for (let step = 0; step < 10; step++) {
			const key = current.logicalUriKey;
			if (seen.has(key)) {
				return current;
			}
			seen.add(key);

			const renamed = this.renamedWorkbenchFiles.get(key);
			if (!renamed) {
				return current;
			}
			current = renamed;
			if (renamed.logicalUriKey === key) {
				return renamed;
			}
		}
		return current;
	}

	async handleFilesRenamed(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
		for (const file of files) {
			const oldInfo = classifyWorkbenchUri(file.oldUri, { includeOptionalPlainText: true });
			const newInfo = classifyWorkbenchUri(file.newUri, { includeOptionalPlainText: true });
			if (!oldInfo || !newInfo) {
				continue;
			}
			const previousInfo = this.resolveRenamedWorkbenchFileInfo(oldInfo);
			this.renamedWorkbenchFiles.set(oldInfo.logicalUriKey, newInfo);
			if (previousInfo.logicalUriKey !== oldInfo.logicalUriKey) {
				this.renamedWorkbenchFiles.set(previousInfo.logicalUriKey, newInfo);
			}

			for (const entry of this.liveConnections.values()) {
				if (entry.logicalUriKey !== oldInfo.logicalUriKey && entry.logicalUriKey !== previousInfo.logicalUriKey) {
					continue;
				}
				entry.documentUri = newInfo.uriString;
				entry.documentInfo = newInfo;
				entry.logicalUriKey = newInfo.logicalUriKey;
				if (this.latestConnectionToken === entry.token) {
					this.applyLatestConnection(entry);
				}
			}
		}
		await this.closeRenamedWorkbenchTabs(files);
	}

	private isSameUriExact(left: vscode.Uri, right: vscode.Uri): boolean {
		try {
			if (left.scheme === 'file' && right.scheme === 'file') {
				return left.fsPath === right.fsPath;
			}
		} catch {
			// ignore
		}
		return left.toString() === right.toString();
	}

	private async closeRenamedWorkbenchTabs(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
		try {
			if (typeof vscode.window.tabGroups.close !== 'function') {
				return;
			}

			const tabsToClose: vscode.Tab[] = [];
			for (const file of files) {
				for (const group of vscode.window.tabGroups.all || []) {
					for (const tab of group.tabs || []) {
						const tabInput = this.getTabInputUri(tab.input);
						if (!tabInput || !this.isSameUriExact(tabInput.uri, file.oldUri)) {
							continue;
						}
						const info = classifyWorkbenchUri(tabInput.uri, {
							viewType: tabInput.viewType,
							includeOptionalPlainText: true,
						});
						if (info) {
							tabsToClose.push(tab);
						}
					}
				}
			}

			const uniqueTabs = [...new Set(tabsToClose)];
			if (uniqueTabs.length > 0) {
				await vscode.window.tabGroups.close(uniqueTabs, true);
			}
		} catch {
			// Best-effort cleanup only; inventory canonicalization still protects tool behavior.
		}
	}

	private getTabInputUri(input: unknown): { uri: vscode.Uri; viewType?: string } | undefined {
		try {
			if (input instanceof vscode.TabInputText) {
				return { uri: input.uri };
			}
			if (input instanceof vscode.TabInputCustom) {
				return { uri: input.uri, viewType: input.viewType };
			}
		} catch {
			// Fall through to structural checks for test doubles and older typings.
		}
		try {
			const maybe = input as { uri?: unknown; viewType?: unknown };
			if (maybe?.uri && typeof (maybe.uri as vscode.Uri).toString === 'function') {
				return {
					uri: maybe.uri as vscode.Uri,
					...(typeof maybe.viewType === 'string' ? { viewType: maybe.viewType } : {}),
				};
			}
		} catch {
			// ignore
		}
		return undefined;
	}

	private summarizeOpenFile(
		info: WorkbenchFileInfo,
		isActive: boolean,
		isLiveWorkbench: boolean,
		priority: number
	): InternalOpenWorkbenchFileSummary {
		return {
			openFileId: info.openFileId,
			uri: info.uriString,
			logicalUri: info.logicalUriString,
			logicalUriKey: info.logicalUriKey,
			fileKind: info.fileKind,
			...(info.filePath ? { filePath: info.filePath } : {}),
			...(info.fileName ? { fileName: info.fileName } : {}),
			...(info.sidecarFor ? { sidecarFor: info.sidecarFor } : {}),
			isActive,
			isLiveWorkbench,
			isReadOnlyFallback: !isLiveWorkbench,
			priority,
		};
	}

	private collectOpenWorkbenchFiles(): { openFiles: InternalOpenWorkbenchFileSummary[]; activeFile?: InternalOpenWorkbenchFileSummary; hasActiveUnsupportedFile: boolean } {
		type Candidate = { uri: vscode.Uri; viewType?: string; isActive: boolean; priority: number; includeOptionalPlainText?: boolean; source?: 'tab' | 'textEditor' | 'workspaceDocument' | 'liveConnection' };
		const candidates: Candidate[] = [];
		let hasActiveUnsupportedFile = false;
		const pushCandidate = (candidate: Candidate | undefined): void => {
			if (!candidate) return;
			candidates.push(candidate);
		};
		const resolveExistingFileUri = (uri: vscode.Uri): vscode.Uri | undefined => {
			try {
				if (uri.scheme !== 'file') {
					return uri;
				}
				if (!fs.existsSync(uri.fsPath)) {
					return undefined;
				}
				const dir = path.dirname(uri.fsPath);
				const base = path.basename(uri.fsPath);
				const actualBase = fs.readdirSync(dir).find(entry => entry.toLowerCase() === base.toLowerCase());
				return actualBase && actualBase !== base
					? vscode.Uri.file(path.join(dir, actualBase))
					: uri;
			} catch {
				return uri;
			}
		};

		try {
			const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
			const activeInput = this.getTabInputUri(activeTab?.input);
			if (activeInput) {
				pushCandidate({ ...activeInput, isActive: true, priority: 0, source: 'tab' });
				if (!classifyWorkbenchUri(activeInput.uri, { viewType: activeInput.viewType })) {
					hasActiveUnsupportedFile = true;
				}
			}
		} catch {
			// ignore
		}

		try {
			let priority = 10;
			for (const group of vscode.window.tabGroups.all || []) {
				for (const tab of group.tabs || []) {
					const tabInput = this.getTabInputUri(tab.input);
					if (!tabInput) continue;
					pushCandidate({ ...tabInput, isActive: group.isActive === true && tab.isActive === true, priority: priority++, source: 'tab' });
				}
			}
		} catch {
			// ignore
		}

		try {
			const activeEditor = vscode.window.activeTextEditor;
			if (activeEditor?.document?.uri) {
				pushCandidate({ uri: activeEditor.document.uri, isActive: true, priority: 100, source: 'textEditor' });
				if (!classifyWorkbenchUri(activeEditor.document.uri)) {
					hasActiveUnsupportedFile = true;
				}
			}
		} catch {
			// ignore
		}

		try {
			let priority = 200;
			for (const editor of vscode.window.visibleTextEditors || []) {
				if (editor?.document?.uri) {
					pushCandidate({ uri: editor.document.uri, isActive: false, priority: priority++, source: 'textEditor' });
				}
			}
		} catch {
			// ignore
		}

		try {
			let priority = 300;
			for (const document of vscode.workspace.textDocuments || []) {
				if (document?.uri) {
					const existingUri = resolveExistingFileUri(document.uri);
					if (existingUri) {
						pushCandidate({ uri: existingUri, isActive: false, priority: priority++, source: 'workspaceDocument' });
					}
				}
			}
		} catch {
			// ignore
		}

		for (const entry of this.liveConnections.values()) {
			if (entry.documentInfo) {
				pushCandidate({ uri: entry.documentInfo.uri, isActive: false, priority: 400 + entry.sequence, includeOptionalPlainText: true, source: 'liveConnection' });
			}
		}

		const byLogicalUri = new Map<string, InternalOpenWorkbenchFileSummary>();
		for (const candidate of candidates) {
			const classifiedInfo = classifyWorkbenchUri(candidate.uri, {
				viewType: candidate.viewType,
				includeOptionalPlainText: candidate.includeOptionalPlainText === true,
			});
			if (!classifiedInfo) continue;
			const info = this.resolveRenamedWorkbenchFileInfo(classifiedInfo);
			const isLiveWorkbench = this.getLatestLiveConnectionForKey(info.logicalUriKey) !== undefined;
			const summary = this.summarizeOpenFile(info, candidate.isActive, isLiveWorkbench, candidate.priority);
			const existing = byLogicalUri.get(summary.logicalUriKey);
			if (!existing) {
				byLogicalUri.set(summary.logicalUriKey, summary);
				continue;
			}
			const shouldReplaceIdentity = summary.isActive && !existing.isActive || summary.priority < existing.priority;
			byLogicalUri.set(summary.logicalUriKey, {
				...(shouldReplaceIdentity ? summary : existing),
				isActive: existing.isActive || summary.isActive,
				isLiveWorkbench: existing.isLiveWorkbench || summary.isLiveWorkbench,
				isReadOnlyFallback: !(existing.isLiveWorkbench || summary.isLiveWorkbench),
				priority: Math.min(existing.priority, summary.priority),
			});
		}

		const openFiles = [...byLogicalUri.values()].sort((a, b) => a.priority - b.priority);
		return { openFiles, activeFile: openFiles.find(file => file.isActive), hasActiveUnsupportedFile };
	}

	private toPublicOpenFiles(openFiles: InternalOpenWorkbenchFileSummary[]): OpenWorkbenchFileSummary[] {
		return openFiles.map(({ logicalUriKey: _logicalUriKey, priority: _priority, ...file }) => file);
	}

	private normalizeTargetFileUri(value: string): WorkbenchFileInfo | undefined {
		const raw = String(value || '').trim();
		if (!raw) {
			return undefined;
		}
		try {
			if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
				return classifyWorkbenchUri(vscode.Uri.file(raw), { includeOptionalPlainText: true });
			}
		} catch {
			// ignore
		}
		try {
			return classifyWorkbenchUriString(raw, { includeOptionalPlainText: true });
		} catch {
			// ignore
		}
		try {
			return classifyWorkbenchUri(vscode.Uri.file(raw), { includeOptionalPlainText: true });
		} catch {
			return undefined;
		}
	}

	private splitTargetFields<T extends TargetFields>(input: T): { target: TargetFields; rest: Omit<T, keyof TargetFields> } {
		const { openFileId, targetFileUri, ...rest } = input;
		return {
			target: {
				...(typeof openFileId === 'string' && openFileId.trim() ? { openFileId: openFileId.trim() } : {}),
				...(typeof targetFileUri === 'string' && targetFileUri.trim() ? { targetFileUri: targetFileUri.trim() } : {}),
			},
			rest: rest as Omit<T, keyof TargetFields>,
		};
	}

	private resolveToolTarget(targetFields: TargetFields = {}): { connection?: LiveWorkbenchConnection; activeFile?: InternalOpenWorkbenchFileSummary; openFiles: InternalOpenWorkbenchFileSummary[]; hasActiveUnsupportedFile: boolean; explicitTarget?: InternalOpenWorkbenchFileSummary; explicitTargetRequested: boolean } {
		const { openFiles, activeFile, hasActiveUnsupportedFile } = this.collectOpenWorkbenchFiles();
		const openFileId = typeof targetFields.openFileId === 'string' ? targetFields.openFileId.trim() : '';
		const rawTargetFileUri = typeof targetFields.targetFileUri === 'string' ? targetFields.targetFileUri.trim() : '';
		const targetFileInfo = rawTargetFileUri
			? this.normalizeTargetFileUri(rawTargetFileUri)
			: undefined;
		const targetFileUriId = targetFileInfo?.openFileId ?? '';
		const explicitTargetRequested = !!openFileId || !!rawTargetFileUri;

		if (rawTargetFileUri && !targetFileInfo) {
			throw new Error(`targetFileUri is not a supported Kusto Workbench file: ${rawTargetFileUri}`);
		}

		if (openFileId && targetFileUriId && openFileId !== targetFileUriId) {
			throw new Error('openFileId and targetFileUri refer to different Workbench files. Use only one target or make them agree.');
		}

		const explicitOpenFileId = openFileId || targetFileUriId;
		if (explicitOpenFileId) {
			let explicitTarget = openFiles.find(file => file.openFileId === explicitOpenFileId);
			if (!explicitTarget && targetFileInfo) {
				explicitTarget = this.summarizeOpenFile(targetFileInfo, false, false, 0);
			}
			if (!explicitTarget) {
				throw new Error(`Target Workbench file not found: ${explicitOpenFileId}. Use #listSections to get current openFileId values.`);
			}
			return {
				openFiles,
				activeFile,
				hasActiveUnsupportedFile,
				explicitTarget,
				explicitTargetRequested,
				connection: this.getLatestLiveConnectionForKey(explicitTarget.logicalUriKey),
			};
		}

		if (activeFile) {
			return {
				openFiles,
				activeFile,
				hasActiveUnsupportedFile,
				explicitTargetRequested,
				connection: this.getLatestLiveConnectionForKey(activeFile.logicalUriKey),
			};
		}
		return { openFiles, hasActiveUnsupportedFile, explicitTargetRequested, connection: hasActiveUnsupportedFile ? undefined : this.getLatestLiveConnection() };
	}

	/**
	 * Posts a message directly to the active webview (fire-and-forget).
	 * Used for one-way notifications that don't expect a response.
	 */
	postToActiveWebview(message: unknown): void {
		const target = this.resolveToolTarget();
		if (target.connection) {
			target.connection.poster(message);
		}
	}

	async postToAllWebviews(message: unknown): Promise<{ attempted: number; delivered: number }> {
		const connections = [...this.liveConnections.values()];
		let delivered = 0;
		await Promise.all(connections.map(async connection => {
			try {
				const result = await Promise.resolve(connection.poster(message));
				if (result !== false) {
					delivered++;
				}
			} catch {
				// A disposed webview must not prevent other live editors from updating.
			}
		}));
		return { attempted: connections.length, delivered };
	}

	handleWebviewResponse(requestId: string, result: unknown, error?: string): void {
		const pending = this.pendingResponses.get(requestId);
		if (!pending) return;
		this.pendingResponses.delete(requestId);
		if (pending.timer) clearTimeout(pending.timer);
		pending.cancellationSubscription?.dispose();
		if (error) {
			pending.reject(new Error(error));
		} else {
			pending.resolve(result);
		}
	}

	handleKustoExecutionStarted(requestId: string, owner: KustoExecutionRequestIdentity): void {
		const pending = this.pendingResponses.get(requestId);
		if (!pending) return;
		pending.kustoExecution = owner;
	}

	private async sendToWebview<T>(
		type: string,
		payload: Record<string, unknown>,
		timeoutMs: number | null = 30000,
		targetFields: TargetFields = {},
		onTimeout?: (connection: LiveWorkbenchConnection, requestId: string) => void,
		capturedConnection?: LiveWorkbenchConnection,
		cancellationToken?: vscode.CancellationToken,
	): Promise<T> {
		const target = capturedConnection
			? { connection: capturedConnection, openFiles: [], hasActiveUnsupportedFile: false, explicitTargetRequested: false }
			: this.resolveToolTarget(targetFields);
		if (!target.connection) {
			if (target.explicitTarget) {
				throw new Error('The targeted Kusto Workbench file is open without a live Workbench editor. Reopen it with Kusto Workbench before editing or executing sections.');
			}
			if (target.activeFile) {
				throw new Error('The active Kusto Workbench file is open without a live Workbench editor. Reopen it with Kusto Workbench before editing or executing sections.');
			}
			throw new Error('Kusto Workbench is not currently open. Please open a supported Kusto Workbench file or use the Query Editor first.');
		}
		if (!this.liveConnections.has(target.connection.token)) {
			throw new Error('The targeted Kusto Workbench editor closed before the request was dispatched.');
		}
		if (cancellationToken?.isCancellationRequested) throw new vscode.CancellationError();
		
		const requestId = `tool_${++this.responseSeq}_${Date.now()}`;
		
		return new Promise<T>((resolve, reject) => {
			let pending!: {
				resolve: (value: unknown) => void; reject: (err: Error) => void;
				timer?: ReturnType<typeof setTimeout>; cancellationSubscription?: vscode.Disposable;
				connectionToken: number; kustoExecution?: KustoExecutionRequestIdentity;
			};
			const cancelKustoExecution = () => {
				target.connection!.poster({
					type: 'toolCancelKustoExecution',
					requestId,
					...(pending.kustoExecution ? { owner: pending.kustoExecution } : {}),
				});
			};
			const timer = timeoutMs === null ? undefined : setTimeout(() => {
					const pending = this.pendingResponses.get(requestId);
					if (!pending) return;
					this.pendingResponses.delete(requestId);
					pending.cancellationSubscription?.dispose();
					try { cancelKustoExecution(); } catch { /* preserve timeout */ }
					try { onTimeout?.(target.connection!, requestId); } catch { /* preserve timeout */ }
					reject(new Error('Request timed out'));
				}, timeoutMs);
			pending = {
				resolve: resolve as (value: unknown) => void, 
				reject, 
				timer,
				connectionToken: target.connection!.token,
			};
			this.pendingResponses.set(requestId, pending);
			const cancelPending = () => {
				if (this.pendingResponses.get(requestId) !== pending) return;
				this.pendingResponses.delete(requestId);
				if (timer) clearTimeout(timer);
				pending.cancellationSubscription?.dispose();
				try { cancelKustoExecution(); } catch { /* preserve cancellation */ }
				try { onTimeout?.(target.connection!, requestId); } catch { /* preserve cancellation */ }
				reject(new vscode.CancellationError());
			};
			pending.cancellationSubscription = cancellationToken?.onCancellationRequested(cancelPending);
			if (cancellationToken?.isCancellationRequested) {
				if (this.pendingResponses.get(requestId) === pending) cancelPending();
				else pending.cancellationSubscription?.dispose();
				return;
			}
			let posted: unknown;
			try {
				posted = target.connection!.poster({ type, requestId, ...payload });
			} catch (error) {
				this.pendingResponses.delete(requestId);
				if (timer) clearTimeout(timer);
				pending.cancellationSubscription?.dispose();
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			void Promise.resolve(posted).then(delivered => {
				if (delivered === true || this.pendingResponses.get(requestId) !== pending) return;
				this.pendingResponses.delete(requestId);
				if (timer) clearTimeout(timer);
				pending.cancellationSubscription?.dispose();
				reject(new Error('The targeted Kusto Workbench editor rejected the request.'));
			}, error => {
				if (this.pendingResponses.get(requestId) !== pending) return;
				this.pendingResponses.delete(requestId);
				if (timer) clearTimeout(timer);
				pending.cancellationSubscription?.dispose();
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Tool implementations
	// ─────────────────────────────────────────────────────────────────────────

	async listConnections(): Promise<{ connections: Array<{ id: string; name: string; clusterUrl: string; database?: string }> }> {
		const connections = this.connectionManager.getConnections().map(connection => ({
			id: connection.id,
			name: connection.name,
			clusterUrl: connection.clusterUrl,
			...(connection.database ? { database: connection.database } : {}),
		}));
		return { connections };
	}

	private resolveSavedKustoConnection(clusterUrl: string, connectionId?: string): { connection?: KustoConnection; error?: string } {
		const connections = this.connectionManager.getConnections();
		const resolution = resolveStrictKustoConnection(connections, { clusterUrl, connectionId });
		if (resolution.kind === 'matched') return { connection: resolution.connection };
		if (resolution.kind === 'ambiguous') return { error: 'Multiple saved connections match this cluster. Pass connectionId from list-connections.' };
		if (resolution.kind === 'mismatch') return { error: 'The supplied connectionId does not match the requested cluster URL.' };
		return { error: 'No saved connection matches this cluster and connectionId.' };
	}

	private preflightKustoToolTarget<T extends { clusterUrl?: string; connectionId?: string }>(input: T): { input?: T; error?: string } {
		const clusterUrl = String(input.clusterUrl || '').trim();
		const connectionId = String(input.connectionId || '').trim();
		if (!clusterUrl) {
			return connectionId
				? { error: 'connectionId requires clusterUrl.' }
				: { input };
		}
		const resolved = this.resolveSavedKustoConnection(clusterUrl, connectionId);
		if (!resolved.connection) return { error: resolved.error };
		return { input: { ...input, clusterUrl: resolved.connection.clusterUrl, connectionId: resolved.connection.id } };
	}

	private createKustoMetadataOwner(
		connection: KustoConnection,
		policy: KustoLeaveNoTracePolicySnapshot,
	): KustoToolMetadataOwner {
		const accountPartition = String(this.kustoClient.getAccountPartition(connection) || '').trim() || undefined;
		return Object.freeze({
			connection: Object.freeze({ ...connection }),
			connectionIdentityKey: getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId),
			connectionIncarnation: this.connectionManager.getConnectionIncarnation(connection.id),
			...(accountPartition ? { accountPartition } : {}),
			authSessionGeneration: this.kustoClient.getConnectionSessionGeneration(connection),
			leaveNoTraceRevision: policy.revocationGenerations[kustoClusterKey(connection.clusterUrl)] ?? 0,
			databaseCacheGeneration: this.kustoConnectionCache.captureGeneration(connection.id, accountPartition || ''),
			schemaCacheGeneration: captureSchemaCacheGeneration(this.context.globalStorageUri, connection.id, accountPartition || ''),
		});
	}

	private async captureKustoMetadataOwner(connection: KustoConnection): Promise<{ owner?: KustoToolMetadataOwner; error?: string }> {
		try {
			const expectedIdentity = getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId);
			return await this.connectionManager.runWithLeaveNoTraceSnapshotLock(async policy => {
				const current = this.connectionManager.getConnections().find(candidate => candidate.id === connection.id);
				if (!current || getKustoConnectionIdentityKey(current.clusterUrl, current.authorityId) !== expectedIdentity) {
					return { error: 'The saved Kusto connection changed before metadata access started.' };
				}
				if (policy.globallyBlocked) {
					return { error: 'Kusto metadata is unavailable while Leave No Trace policy recovery is blocked.' };
				}
				if (new Set(policy.clusterKeys).has(kustoClusterKey(current.clusterUrl))) {
					return { error: 'Kusto metadata is unavailable because this cluster is protected by Leave No Trace.' };
				}
				return { owner: this.createKustoMetadataOwner(current, policy) };
			});
		} catch (error) {
			return { error: `Kusto metadata ownership could not be established: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	private currentKustoMetadataConnection(
		owner: KustoToolMetadataOwner,
		policy: KustoLeaveNoTracePolicySnapshot,
		expectedAccountPartition?: string,
		databaseCacheGeneration?: KustoConnectionCacheGeneration,
		schemaCacheGenerations: readonly SchemaCacheGeneration[] = [],
	): KustoConnection | undefined {
		const current = this.connectionManager.getConnections().find(candidate => candidate.id === owner.connection.id);
		if (!current || policy.globallyBlocked || new Set(policy.clusterKeys).has(kustoClusterKey(current.clusterUrl))) return undefined;
		try {
			if (this.connectionManager.getConnectionIncarnation(current.id) !== owner.connectionIncarnation
				|| getKustoConnectionIdentityKey(current.clusterUrl, current.authorityId) !== owner.connectionIdentityKey
				|| this.kustoClient.getConnectionSessionGeneration(current) !== owner.authSessionGeneration
				|| (policy.revocationGenerations[kustoClusterKey(current.clusterUrl)] ?? 0) !== owner.leaveNoTraceRevision) return undefined;
			const currentPartition = String(this.kustoClient.getAccountPartition(current) || '').trim() || undefined;
			if (owner.accountPartition && currentPartition !== owner.accountPartition) return undefined;
			if (expectedAccountPartition && currentPartition !== expectedAccountPartition) return undefined;
			if (databaseCacheGeneration && !cacheGenerationMatches(
				this.kustoConnectionCache.captureGeneration(current.id, expectedAccountPartition || owner.accountPartition || ''),
				databaseCacheGeneration,
			)) return undefined;
			if (schemaCacheGenerations.some(expected => !cacheGenerationMatches(
				captureSchemaCacheGeneration(this.context.globalStorageUri, current.id, expectedAccountPartition || owner.accountPartition || ''),
				expected,
			))) return undefined;
			return current;
		} catch {
			return undefined;
		}
	}

	private async startKustoMetadataDispatch<T>(
		owner: KustoToolMetadataOwner,
		expectedAccountPartition: string | undefined,
		dispatch: (connection: KustoConnection) => Promise<T>,
	): Promise<T> {
		await this.kustoClient.waitForProviderAccountRefresh();
		const started = await this.connectionManager.runWithLeaveNoTraceSnapshotLock(async policy => {
			const checkCapturedCacheGenerations = !!owner.accountPartition
				&& (!expectedAccountPartition || expectedAccountPartition === owner.accountPartition);
			const current = this.currentKustoMetadataConnection(
				owner,
				policy,
				expectedAccountPartition,
				checkCapturedCacheGenerations ? owner.databaseCacheGeneration : undefined,
				checkCapturedCacheGenerations ? [owner.schemaCacheGeneration] : [],
			);
			if (!current) return undefined;
			let promise: Promise<T>;
			try { promise = dispatch(Object.freeze({ ...current })); }
			catch (error) { promise = Promise.reject(error); }
			return { promise };
		});
		if (!started) throw new KustoMetadataOwnerChangedError();
		return started.promise;
	}

	private kustoMetadataDispatchGate(
		owner: KustoToolMetadataOwner,
		expectedAccountPartition?: string,
	) {
		return async <T>(
			_connection: KustoConnection,
			accountPartition: string,
			authSessionGeneration: number,
			policy: KustoLeaveNoTracePolicySnapshot,
			dispatch: () => T | PromiseLike<T>,
		): Promise<T> => {
			if (authSessionGeneration !== owner.authSessionGeneration
				|| (expectedAccountPartition && accountPartition !== expectedAccountPartition)
				|| (owner.accountPartition && accountPartition !== owner.accountPartition)
				|| !this.currentKustoMetadataConnection(owner, policy, accountPartition)) {
				throw new KustoMetadataOwnerChangedError();
			}
			return await dispatch();
		};
	}

	private async readCachedSchemaForOwner(
		owner: KustoToolMetadataOwner,
		database: string,
	): Promise<KustoMetadataCacheRead<GetSchemaResult>> {
		const accountPartition = owner.accountPartition;
		if (!accountPartition) return { kind: 'missing' };
		const cached = await readCachedSchemaFromDiskByCluster(
			this.context.globalStorageUri,
			owner.connection.clusterUrl,
			database,
			owner.connection.id,
			accountPartition,
		);
		if (!cached?.schema) return { kind: 'missing' };
		const admitted = await this.admitKustoMetadataOwner(
			owner,
			accountPartition,
			{ schemas: [owner.schemaCacheGeneration] },
			current => ({
				clusterUrl: current.clusterUrl,
				database,
				schema: cached.schema,
				cacheAgeMs: Math.max(0, Date.now() - cached.timestamp),
			}),
		);
		return admitted.admitted && admitted.value
			? { kind: 'found', value: admitted.value }
			: { kind: 'rejected' };
	}

	private async readCachedSchemaSummariesForOwner(
		owner: KustoToolMetadataOwner,
	): Promise<KustoMetadataCacheRead<NonNullable<GetSchemaResult['databases']>>> {
		const accountPartition = owner.accountPartition;
		if (!accountPartition) return { kind: 'missing' };
		const principalIdentity = schemaPrincipalIdentity(owner.connection.id, accountPartition);
		const schemas = await readAllCachedSchemasFromDisk(
			this.context.globalStorageUri,
			owner.connection.clusterUrl,
			undefined,
			new Set(principalIdentity ? [principalIdentity] : []),
		);
		if (schemas.length === 0) return { kind: 'missing' };
		const admitted = await this.admitKustoMetadataOwner(
			owner,
			accountPartition,
			{ schemas: [owner.schemaCacheGeneration] },
			() => schemas,
		);
		return admitted.admitted && admitted.value
			? { kind: 'found', value: admitted.value }
			: { kind: 'rejected' };
	}

	private async captureActiveKustoMetadataOwners(): Promise<Map<string, KustoToolMetadataOwner>> {
		return this.connectionManager.runWithLeaveNoTraceSnapshotLock(async policy => {
			const owners = new Map<string, KustoToolMetadataOwner>();
			if (policy.globallyBlocked) return owners;
			const protectedClusters = new Set(policy.clusterKeys);
			for (const connection of this.connectionManager.getConnections()) {
				if (protectedClusters.has(kustoClusterKey(connection.clusterUrl))) continue;
				try {
					const owner = this.createKustoMetadataOwner(connection, policy);
					if (owner.accountPartition) owners.set(connection.id, owner);
				} catch {
					// Invalid or incomplete connection identities are not eligible cache owners.
				}
			}
			return owners;
		});
	}

	private async admitKustoMetadataOwner<T>(
		owner: KustoToolMetadataOwner,
		expectedAccountPartition: string,
		cacheGenerations: {
			database?: KustoConnectionCacheGeneration;
			schemas?: readonly SchemaCacheGeneration[];
		},
		apply: (connection: KustoConnection) => T | PromiseLike<T>,
	): Promise<{ admitted: boolean; value?: T }> {
		await this.kustoClient.waitForProviderAccountRefresh();
		return this.connectionManager.runWithLeaveNoTraceSnapshotLock(async policy => {
			const current = this.currentKustoMetadataConnection(
				owner,
				policy,
				expectedAccountPartition,
				cacheGenerations.database,
				cacheGenerations.schemas,
			);
			if (!current) return { admitted: false };
			return { admitted: true, value: await apply(current) };
		});
	}

	async listFavorites(): Promise<{ favorites: KustoFavorite[] }> {
		const raw = this.context.globalState.get<unknown>('kusto.favorites');
		const connections = this.connectionManager.getConnections();
		const partitions = new Map(connections.map(connection => {
			let partition: string | undefined;
			try { partition = this.kustoClient.getAccountPartition(connection); } catch { partition = undefined; }
			return [connection.id, partition];
		}));
		const favorites = filterKustoFavoritesForActivePrincipals(migrateKustoFavorites(raw, connections, partitions), partitions);
		return { favorites };
	}

	async refreshSchema(input: RefreshKustoSchemaInput): Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }> {
		const clusterUrl = (input.clusterUrl || '').trim();
		if (!clusterUrl) {
			return { schemas: [], error: 'clusterUrl is required.' };
		}
		const resolved = this.resolveSavedKustoConnection(clusterUrl, input.connectionId);
		if (!resolved.connection) return { schemas: [], error: resolved.error };
		return this.refreshSchemaDirectly(resolved.connection.clusterUrl, resolved.connection.id);
	}

	/**
	 * Refresh schema directly via the Kusto client, without requiring an open editor.
	 * Mirrors the logic in QueryEditorSchema.refreshSchemaForTools.
	 */
	private async refreshSchemaDirectly(clusterUrl: string, connectionId?: string): Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }> {
		const resolved = this.resolveSavedKustoConnection(clusterUrl, connectionId);
		if (!resolved.connection) return { schemas: [], error: resolved.error };
		const captured = await this.captureKustoMetadataOwner(resolved.connection);
		if (!captured.owner) return { schemas: [], error: captured.error || 'Kusto metadata ownership could not be established.' };
		const owner = captured.owner;
		const connection = owner.connection;

		try {
			const discovery = await this.kustoClient.getDatabasesWithIdentity(owner.connection, true, {
					traceId: randomUUID(), source: 'language-model-tool-schema-refresh', persistCache: false,
					dispatchAuthenticated: this.kustoMetadataDispatchGate(owner, owner.accountPartition),
				});
			const accountPartition = String(discovery.accountPartition || '').trim();
			if (!accountPartition || !discovery.cacheGeneration) throw new KustoMetadataOwnerChangedError();

			const errors: string[] = [];
			const refreshed: KustoToolSchemaResult[] = [];
			for (const db of discovery.databases) {
				try {
					const result = await this.kustoClient.getDatabaseSchema(owner.connection, db, true, {
							traceId: randomUUID(), source: 'language-model-tool-schema-refresh', persistCache: false,
							dispatchAuthenticated: this.kustoMetadataDispatchGate(owner, accountPartition),
						});
					const schema = result.schema;
					if (result.accountPartition !== accountPartition || !result.cacheGeneration) throw new KustoMetadataOwnerChangedError();
					refreshed.push(Object.freeze({
						database: db,
						schema,
						accountPartition,
						cacheGeneration: result.cacheGeneration,
						timestamp: result.fromCache ? Date.now() - (result.cacheAgeMs ?? 0) : Date.now(),
					}));
				} catch (dbErr) {
					if (dbErr instanceof KustoMetadataOwnerChangedError) throw dbErr;
					errors.push(`${db}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
				}
			}

			const admitted = await this.admitKustoMetadataOwner(
				owner,
				accountPartition,
				{ database: discovery.cacheGeneration, schemas: refreshed.map(entry => entry.cacheGeneration) },
				async current => {
					if (discovery.databases.length > 0 && !await this.kustoConnectionCache.setDatabases(
						current.id, accountPartition, discovery.databases, discovery.cacheGeneration,
					)) throw new KustoMetadataOwnerChangedError();
					for (const entry of refreshed) {
						const cacheKey = schemaCacheKey(current.clusterUrl, entry.database, current.id, accountPartition);
						await writeCachedSchemaToDisk(this.context.globalStorageUri, cacheKey, {
							schema: entry.schema,
							timestamp: entry.timestamp,
							version: SCHEMA_CACHE_VERSION,
							clusterUrl: current.clusterUrl,
							database: entry.database,
							connectionId: current.id,
							accountPartition,
						}, entry.cacheGeneration);
						if (!cacheGenerationMatches(
							captureSchemaCacheGeneration(this.context.globalStorageUri, current.id, accountPartition),
							entry.cacheGeneration,
						)) throw new KustoMetadataOwnerChangedError();
					}
					const schemas = refreshed.map(entry => ({
						clusterUrl: current.clusterUrl,
						database: entry.database,
						tables: entry.schema.tables || [],
						functions: (entry.schema.functions || []).map(fn => typeof fn === 'string' ? fn : fn.name || '').filter(Boolean),
					}));
					if (discovery.databases.length === 0) return { schemas: [], error: 'No databases found on this cluster, or insufficient permissions.' };
					if (errors.length > 0 && schemas.length === 0) return { schemas, error: `Failed to refresh schema for all databases: ${errors.join('; ')}` };
					if (errors.length > 0) return { schemas, error: `Some databases failed: ${errors.join('; ')}` };
					return { schemas };
				},
			);
			if (!admitted.admitted || !admitted.value) throw new KustoMetadataOwnerChangedError();
			return admitted.value;
		} catch (err) {
			if (err instanceof KustoMetadataOwnerChangedError) return { schemas: [], error: err.message };
			return { schemas: [], error: `Failed to refresh schema: ${err instanceof Error ? err.message : String(err)}` };
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
		const resolved = this.resolveSavedKustoConnection(clusterUrl, input.connectionId);
		if (!resolved.connection) return { error: resolved.error };
		let captured = await this.captureKustoMetadataOwner(resolved.connection);
		if (!captured.owner) return { error: captured.error || 'Kusto metadata ownership could not be established.' };
		let owner = captured.owner;

		// ── Single database requested ─────────────────────────────────
		if (db) {
			let cached = await this.readCachedSchemaForOwner(owner, db);
			if (cached.kind === 'rejected') return { error: 'Kusto metadata owner changed while the schema cache was being read.' };
			if (cached.kind === 'missing') {
				const refreshResult = await this.refreshSchemaDirectly(clusterUrl, owner.connection.id);
				if (refreshResult.error && refreshResult.schemas.length === 0) {
					return { error: refreshResult.error };
				}
				const current = this.resolveSavedKustoConnection(clusterUrl, owner.connection.id);
				if (!current.connection) return { error: current.error };
				captured = await this.captureKustoMetadataOwner(current.connection);
				if (!captured.owner) return { error: captured.error || 'Kusto metadata ownership changed after schema refresh.' };
				owner = captured.owner;
				cached = await this.readCachedSchemaForOwner(owner, db);
			}

			if (cached.kind !== 'found') {
				return {
					error: `No schema found for database "${db}" on cluster "${clusterUrl}". ` +
						'Make sure the database name is correct and that you have permissions to access it. ' +
						'You can use #refreshKustoSchema to force-fetch the latest schema from the cluster.'
				};
			}
			return cached.value;
		}

		// ── No specific database – return summaries for the cluster ──
		let schemas = await this.readCachedSchemaSummariesForOwner(owner);
		if (schemas.kind === 'rejected') return { error: 'Kusto metadata owner changed while schema summaries were being read.' };
		if (schemas.kind === 'missing') {
			const refreshResult = await this.refreshSchemaDirectly(clusterUrl, owner.connection.id);
			if (refreshResult.error && refreshResult.schemas.length === 0) {
				return { error: refreshResult.error };
			}
			const current = this.resolveSavedKustoConnection(clusterUrl, owner.connection.id);
			if (!current.connection) return { error: current.error };
			captured = await this.captureKustoMetadataOwner(current.connection);
			if (!captured.owner) return { error: captured.error || 'Kusto metadata ownership changed after schema refresh.' };
			owner = captured.owner;
			schemas = await this.readCachedSchemaSummariesForOwner(owner);
		}
		if (schemas.kind !== 'found') return { error: 'Kusto metadata owner changed before schema summaries could be admitted.' };
		return { databases: schemas.value };
	}

	async searchCachedSchemas(input: SearchCachedSchemasInput): Promise<{ matches: unknown[]; count: number; pattern: string; error?: string }> {
		const pattern = (input.pattern || '').trim();
		if (!pattern) {
			return { matches: [], count: 0, pattern: '', error: 'pattern is required and must be a non-empty string.' };
		}
		const owners = await this.captureActiveKustoMetadataOwners();
		const principalIdentities = new Set([...owners.values()].flatMap(owner => {
			const identity = schemaPrincipalIdentity(owner.connection.id, owner.accountPartition);
			return identity ? [identity] : [];
		}));
		if (principalIdentities.size === 0) return { matches: [], count: 0, pattern };
		const matches = await searchCachedSchemas(this.context.globalStorageUri, pattern, 200, principalIdentities);
		await this.kustoClient.waitForProviderAccountRefresh();
		const admittedConnectionIds = await this.connectionManager.runWithLeaveNoTraceSnapshotLock(async policy => {
			const admitted = new Set<string>();
			for (const connectionId of new Set(matches.map(match => match.connectionId))) {
				const owner = owners.get(connectionId);
				if (owner?.accountPartition && this.currentKustoMetadataConnection(
					owner,
					policy,
					owner.accountPartition,
					undefined,
					[owner.schemaCacheGeneration],
				)) admitted.add(connectionId);
			}
			return admitted;
		});
		const publicMatches = matches
			.filter(match => admittedConnectionIds.has(match.connectionId))
			.map(({ connectionId, ...match }) => ({ connectionId, ...match }));
		return { matches: publicMatches, count: publicMatches.length, pattern };
	}

	private summarizeToolSection(s: ToolSection, idx: number): ToolSectionSummary {
		const id = typeof s.id === 'string' ? s.id : `section_${idx}`;
		const type = typeof s.type === 'string' ? s.type : 'unknown';
		const name = typeof s.name === 'string' ? s.name : (typeof s.title === 'string' ? s.title : '');
		const expanded = s.expanded !== false;
		const database = typeof s.database === 'string' ? s.database : '';
		if (type === 'devnotes') {
			const entries = Array.isArray(s.entries) ? s.entries : [];
			return { id, type, name, expanded, database, entries };
		}
		if (type === 'sql') {
			const serverUrl = typeof s.serverUrl === 'string' ? s.serverUrl : '';
			return { id, type, name, expanded, serverUrl, database };
		}
		const clusterUrl = typeof s.clusterUrl === 'string' ? s.clusterUrl : '';
		return { id, type, name, expanded, clusterUrl, database };
	}

	private async getSectionsForConnection(connection: LiveWorkbenchConnection): Promise<ToolSectionSummary[] | undefined> {
		const rawSections = await connection.stateGetter();
		const sectionTypeById = new Map((rawSections ?? []).map(section => [String(section?.id || '').trim(), String(section?.type || '')]));
		const hasSqlOwner = (rawSections ?? []).some(section => {
			if (String(section?.type || '') === 'sql') return true;
			const sourceBoxId = String((section as any)?.comparisonSourceBoxId || '').trim();
			return !!sourceBoxId && sectionTypeById.get(sourceBoxId) === 'sql';
		});
		const protectedIds = hasSqlOwner ? await this.getProtectedSqlConnectionIds() : new Set<string>();
		return rawSections
			?.filter(section => {
				const sectionId = String(section?.id || '').trim();
				const connectionId = connection.sqlConnectionResolver?.(sectionId);
				const comparisonSourceBoxId = String((section as any)?.comparisonSourceBoxId || '').trim();
				if (String(section?.type || '') === 'sql' || (comparisonSourceBoxId && sectionTypeById.get(comparisonSourceBoxId) === 'sql')) {
					return !!connectionId && !protectedIds.has(connectionId);
				}
				return true;
			})
			.map((section, index) => this.summarizeToolSection(section, index));
	}

	private async getProtectedSqlConnectionIds(): Promise<Set<string>> {
		const ids = await this.refreshSqlLeaveNoTracePolicy?.() ?? [];
		return new Set(ids.map(id => String(id || '').trim()).filter(Boolean));
	}

	async listSections(): Promise<ListSectionsResult> {
		const target = this.resolveToolTarget();
		const openFiles = this.toPublicOpenFiles(target.openFiles);
		const sectionsByOpenFileId = new Map<string, ToolSectionSummary[]>();
		await Promise.all(openFiles.map(async (file) => {
			const internal = target.openFiles.find(openFile => openFile.openFileId === file.openFileId);
			const connection = internal ? this.getLatestLiveConnectionForKey(internal.logicalUriKey) : undefined;
			if (!connection) {
				return;
			}
			try {
				const sections = await this.getSectionsForConnection(connection);
				if (sections) {
					file.sections = sections;
					sectionsByOpenFileId.set(file.openFileId, sections);
				} else {
					file.sectionsUnavailable = true;
					file.error = 'Sections are unavailable for this open file.';
				}
			} catch (err) {
				file.sectionsUnavailable = true;
				file.error = err instanceof Error ? err.message : String(err);
			}
		}));
		if (!target.connection) {
			const file = target.activeFile ?? (target.hasActiveUnsupportedFile ? undefined : target.openFiles[0]);
			if (file) {
				return {
					sections: [],
					...(file.filePath ? { filePath: file.filePath } : {}),
					...(file.fileName ? { fileName: file.fileName } : {}),
					openFiles,
				};
			}
			if (openFiles.length) {
				return { sections: [], openFiles };
			}
			throw new Error('Kusto Workbench is not currently open.');
		}
		const targetOpenFileId = target.explicitTarget?.openFileId ?? target.activeFile?.openFileId ?? target.connection.documentInfo?.openFileId;
		const sections = targetOpenFileId ? sectionsByOpenFileId.get(targetOpenFileId) : await this.getSectionsForConnection(target.connection);
		if (!sections) {
			return { sections: [], ...(openFiles.length ? { openFiles } : {}) };
		}

		// Include the active document's file path and name when available.
		const file = target.activeFile && target.connection.logicalUriKey === target.activeFile.logicalUriKey
			? target.activeFile
			: target.connection.documentInfo;
		const result: ListSectionsResult = {
			sections,
			...(file?.filePath ? { filePath: file.filePath } : {}),
			...(file?.fileName ? { fileName: file.fileName } : {}),
			...(openFiles.length ? { openFiles } : {}),
		};
		return result;
	}

	/**
	 * Returns the current development notes from the open file, if any.
	 */
	async getDevNotes(targetFields: TargetFields = {}): Promise<DevNoteEntry[]> {
		const target = this.resolveToolTarget(targetFields);
		if (!target.connection) {
			return [];
		}
		const rawSections = await target.connection.stateGetter();
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
		const { target, rest } = this.splitTargetFields(input);
		input = rest as ManageDevelopmentNotesInput;
		if (input.action === 'view') {
			const notes = await this.getDevNotes(target);
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
			return this.sendToWebview('updateDevNotes', { action, entry, supersededId: input.supersedes }, 30000, target);
		} else if (input.action === 'remove') {
			if (!input.noteId) {
				return { success: false, error: '"noteId" is required when removing a development note.' };
			}
			return this.sendToWebview('updateDevNotes', { action: 'remove', noteId: input.noteId }, 30000, target);
		}
		return { success: false, error: `Unknown action: ${input.action}` };
	}

	// ── SQL tools ─────────────────────────────────────────────────────────────

	async listSqlConnections(): Promise<{ connections: Array<{ id: string; name: string; serverUrl: string; dialect: string }> }> {
		const protectedIds = await this.getProtectedSqlConnectionIds();
		const conns = this.getSqlConnectionManager().getConnections().filter(connection => !protectedIds.has(connection.id));
		return { connections: conns.map(c => ({ id: c.id, name: c.name, serverUrl: c.serverUrl, dialect: c.dialect })) };
	}

	private async resolveSqlToolSection(
		capturedConnection: LiveWorkbenchConnection | undefined,
		sectionId?: string,
	): Promise<{ sectionId: string; connectionId: string; database: string; ownerToken: string; generation?: number }> {
		if (!capturedConnection || !this.liveConnections.has(capturedConnection.token)) {
			throw new Error('The targeted Kusto Workbench editor is not available for SQL tool preflight.');
		}
		const sections = await capturedConnection.stateGetter();
		const requestedId = String(sectionId || '').trim();
		const sqlSections = (Array.isArray(sections) ? sections : []).filter(section => section?.type === 'sql');
		const section = requestedId
			? sqlSections.find(candidate => String(candidate.id || '') === requestedId)
			: sqlSections.find(candidate => String((candidate as any).ownerToken || '').trim()) ?? sqlSections[0];
		if (!section) throw new Error(requestedId ? `SQL section "${requestedId}" was not found.` : 'No SQL section is available in the targeted editor.');
		const resolvedSectionId = String(section.id || '').trim();
		const connectionId = String((section as any).connectionId || capturedConnection.sqlConnectionResolver?.(resolvedSectionId) || '').trim();
		const database = String((section as any).database || '').trim();
		const ownerToken = String((section as any).ownerToken || '').trim();
		if (!connectionId || !database || !ownerToken) throw new Error('SQL section owner is not ready.');
		const liveOwner = capturedConnection.sqlOwnerResolver?.(resolvedSectionId);
		if (capturedConnection.sqlOwnerResolver) {
			if (!liveOwner) throw new Error('SQL section owner disappeared during tool preflight.');
			if (liveOwner.connectionId !== connectionId || liveOwner.database !== database || liveOwner.ownerToken !== ownerToken) {
				throw new Error('SQL section owner changed during tool preflight.');
			}
		}
		return { sectionId: resolvedSectionId, connectionId, database, ownerToken, ...(liveOwner ? { generation: liveOwner.generation } : {}) };
	}

	private assertLiveSqlToolOwner(
		capturedConnection: LiveWorkbenchConnection,
		expected: { sectionId: string; connectionId: string; database: string; ownerToken: string; generation?: number },
	): void {
		if (!this.liveConnections.has(capturedConnection.token)) {
			throw new Error('The targeted Kusto Workbench editor closed before tool result admission.');
		}
		if (capturedConnection.sqlOwnerResolver) {
			const liveOwner = capturedConnection.sqlOwnerResolver(expected.sectionId);
			if (!liveOwner) throw new Error('SQL section owner disappeared before tool result admission.');
			if (liveOwner.connectionId !== expected.connectionId
				|| liveOwner.database !== expected.database
				|| liveOwner.ownerToken !== expected.ownerToken
				|| (expected.generation !== undefined && liveOwner.generation !== expected.generation)) {
				throw new Error('SQL section owner changed before tool result admission.');
			}
			return;
		}
		if (capturedConnection.sqlConnectionResolver?.(expected.sectionId) !== expected.connectionId) {
			throw new Error('SQL section connection changed before tool result admission.');
		}
	}

	private async admitSqlToolResult<T>(
		connection: SqlConnection,
		principalFingerprint: string,
		revocationGeneration: number,
		validate: () => void,
		result: T,
	): Promise<T> {
		if (this.dispatchSqlOwnerAllowed) {
			return this.dispatchSqlOwnerAllowed(connection, principalFingerprint, revocationGeneration, () => {
				validate();
				return result;
			});
		}
		await this.assertSqlConnectionAllowed?.(connection.id);
		await this.getSqlConnectionManager().assertConnectionCurrent(connection);
		if (await readCurrentSqlSchemaPrincipalFingerprint(this.context, connection) !== principalFingerprint) {
			throw new Error('SQL connection principal changed before tool result admission.');
		}
		validate();
		return result;
	}

	async configureSqlSection(input: ConfigureSqlSectionInput, cancellationToken?: vscode.CancellationToken): Promise<{ success: boolean; resultPreview?: string }> {
		const { target, rest } = this.splitTargetFields(input);
		input = rest as ConfigureSqlSectionInput;
		const resolvedTarget = this.resolveToolTarget(target);
		const capturedConnection = resolvedTarget.connection;
		if (!capturedConnection || !this.liveConnections.has(capturedConnection.token)) {
			throw new Error('Kusto Workbench is not currently open with a live editor for SQL configuration.');
		}
		const existingConnectionId = capturedConnection?.sqlConnectionResolver?.(input.sectionId);
		let requestedConnectionId: string | undefined;
		let requestedConnection: ReturnType<SqlConnectionManager['getConnection']>;
		let requestedTargetSignature: string | undefined;
		if (input.connectionId) {
			const connection = this.getSqlConnectionManager().getConnection(String(input.connectionId));
			if (!connection) throw new Error(`SQL connection "${input.connectionId}" was not found. Use list-sql-connections first.`);
			requestedConnectionId = connection.id;
			requestedConnection = connection;
			requestedTargetSignature = sqlConnectionTargetSignature(connection);
			await this.refreshSqlLeaveNoTracePolicy?.();
			await this.assertSqlConnectionAllowed?.(connection.id);
		} else if (input.serverUrl) {
			const matching = this.getSqlConnectionManager().getConnections().filter(connection =>
				String(connection.serverUrl || '').trim().toLowerCase().includes(String(input.serverUrl || '').trim().toLowerCase()),
			);
			if (matching.length !== 1) throw new Error('SQL server target is missing or ambiguous. Pass connectionId from list-sql-connections.');
			requestedConnectionId = matching[0].id;
			requestedConnection = matching[0];
			requestedTargetSignature = sqlConnectionTargetSignature(matching[0]);
			await this.refreshSqlLeaveNoTracePolicy?.();
			await this.assertSqlConnectionAllowed?.(matching[0].id);
		}
		if (!existingConnectionId && !requestedConnectionId) {
			throw new Error(`SQL section "${input.sectionId}" has no live connection owner. Pass connectionId from list-sql-connections.`);
		}
		if (existingConnectionId) {
			await this.refreshSqlLeaveNoTracePolicy?.();
			await this.assertSqlConnectionAllowed?.(existingConnectionId);
		}
		const operationConnectionId = requestedConnectionId ?? existingConnectionId!;
		const operationConnection = this.getSqlConnectionManager().getConnection(operationConnectionId);
		if (!operationConnection) throw new Error('SQL section connection owner disappeared before configuration.');
		const operationTargetSignature = sqlConnectionTargetSignature(operationConnection);
		await this.getSqlConnectionManager().assertConnectionCurrent(operationConnection);
		const operationPrincipalFingerprint = input.execute
			? await readCurrentSqlSchemaPrincipalFingerprint(this.context, operationConnection)
			: undefined;
		const operationRevocationGeneration = this.getSqlRevocationGeneration?.(operationConnectionId) ?? 0;
		if (input.execute && !operationPrincipalFingerprint) throw new Error('SQL section principal is unavailable before execution.');
		let operationDatabase = String(input.database || '').trim();
		if (input.execute && !operationDatabase) {
			const sections = await capturedConnection.stateGetter();
			const section = sections?.find(candidate => String(candidate?.id || '') === String(input.sectionId || ''));
			operationDatabase = String(section?.database || '').trim();
		}
		if (input.execute && !operationDatabase) throw new Error('SQL section database is unavailable before execution.');
		const requestsTargetConfiguration = !!requestedConnection || input.database !== undefined;
		if (input.execute && !capturedConnection.sqlOwnerResolver) {
			throw new Error('SQL section owner resolver is unavailable before execution.');
		}
		if (input.execute && !requestsTargetConfiguration) {
			const liveOwner = capturedConnection.sqlOwnerResolver?.(String(input.sectionId || ''));
			if (!liveOwner || liveOwner.connectionId !== operationConnectionId || liveOwner.database !== operationDatabase) {
				throw new Error('SQL section owner changed before execution.');
			}
		}
		if (input.query !== undefined) {
			input = { ...input, query: unescapeLLMText(input.query) };
		}
		const configuredMinutes = vscode.workspace.getConfiguration('kustoWorkbench').get<number>('sqlQueryTimeout', 20);
		const executionTimeoutMs = configuredMinutes > 0 ? (configuredMinutes * 60_000) + 30_000 : null;
		const executionId = input.execute ? `sql-tool-${randomUUID()}` : undefined;
		const result = await this.sendToWebview<{
			success: boolean;
			resultPreview?: string;
			executionOwner?: { connectionId?: string; database?: string; ownerToken?: string; generation?: number };
			executionId?: string;
		}>(
			'toolConfigureSqlSection',
			{
				input: {
					...input,
					...(executionId ? { executionId } : {}),
					...(requestsTargetConfiguration ? {
						resolvedConnection: requestedConnection ?? operationConnection,
						requestedTargetSignature: requestedTargetSignature ?? operationTargetSignature,
					} : {}),
					...(input.execute ? {
						expectedExecutionOwner: {
							connectionId: operationConnectionId,
							database: operationDatabase,
							targetSignature: operationTargetSignature,
							principalFingerprint: operationPrincipalFingerprint,
								revocationGeneration: operationRevocationGeneration,
						},
					} : {}),
				},
			},
			input.execute ? executionTimeoutMs : 30_000,
			target,
			input.execute
				? connection => { connection.poster({ type: 'toolCancelSqlExecution', sectionId: input.sectionId, executionId }); }
				: undefined,
			capturedConnection,
			cancellationToken,
		);
		if (!this.liveConnections.has(capturedConnection.token)) {
			throw new Error('The targeted Kusto Workbench editor closed during SQL configuration.');
		}
		const finalConnectionId = capturedConnection.sqlConnectionResolver?.(input.sectionId);
		if (!finalConnectionId) throw new Error('SQL section connection owner disappeared during configuration.');
		if (finalConnectionId !== operationConnectionId) {
			throw new Error('SQL section did not adopt the requested connection owner.');
		}
		const finalConnection = this.getSqlConnectionManager().getConnection(operationConnectionId);
		if (!finalConnection || sqlConnectionTargetSignature(finalConnection) !== operationTargetSignature) {
			throw new Error('SQL connection target changed during tool execution.');
		}
		await this.getSqlConnectionManager().assertConnectionCurrent(finalConnection);
		if (operationPrincipalFingerprint
			&& await readCurrentSqlSchemaPrincipalFingerprint(this.context, finalConnection) !== operationPrincipalFingerprint) {
			throw new Error('SQL connection principal changed during tool execution.');
		}
		await this.refreshSqlLeaveNoTracePolicy?.();
		await this.assertSqlConnectionAllowed?.(finalConnectionId);
		const publicResult = {
			success: result.success,
			...(result.resultPreview !== undefined ? { resultPreview: result.resultPreview } : {}),
		};
		if (!input.execute || !operationPrincipalFingerprint) return publicResult;
		if (!executionId || String(result.executionId || '') !== executionId) {
			throw new Error('SQL tool execution receipt ID is invalid.');
		}
		const executionOwner = {
			connectionId: String(result.executionOwner?.connectionId || '').trim(),
			database: String(result.executionOwner?.database || '').trim(),
			ownerToken: String(result.executionOwner?.ownerToken || '').trim(),
			generation: Number(result.executionOwner?.generation),
		};
		if (executionOwner.connectionId !== operationConnectionId
			|| executionOwner.database !== operationDatabase
			|| !executionOwner.ownerToken
			|| !Number.isSafeInteger(executionOwner.generation)) {
			throw new Error('SQL tool execution owner receipt is invalid.');
		}
		this.assertLiveSqlToolOwner(capturedConnection, {
			sectionId: String(input.sectionId || ''), ...executionOwner,
		});
		return this.admitSqlToolResult(
			operationConnection,
			operationPrincipalFingerprint,
			operationRevocationGeneration,
			() => {
				if (!this.liveConnections.has(capturedConnection.token)
					|| capturedConnection.sqlConnectionResolver?.(input.sectionId) !== operationConnectionId) {
					throw new Error('SQL section owner changed before tool result admission.');
				}
				this.assertLiveSqlToolOwner(capturedConnection, {
					sectionId: String(input.sectionId || ''), ...executionOwner,
				});
			},
			publicResult,
		);
	}

	async getSqlSchema(input: GetSqlSchemaInput): Promise<{ success: boolean; schema?: unknown; error?: string }> {
		const { target, rest } = this.splitTargetFields(input);
		const resolvedTarget = this.resolveToolTarget(target);
		const capturedConnection = resolvedTarget.connection;
		const resolvedSection = await this.resolveSqlToolSection(capturedConnection, rest.sectionId);
		const { sectionId, connectionId, database: expectedDatabase, ownerToken: expectedOwnerToken, generation } = resolvedSection;
		await this.refreshSqlLeaveNoTracePolicy?.();
		await this.assertSqlConnectionAllowed?.(connectionId);
		const connection = this.getSqlConnectionManager().getConnection(connectionId);
		if (!connection) throw new Error('SQL section connection owner disappeared while reading schema.');
		const targetSignature = sqlConnectionTargetSignature(connection);
		await this.getSqlConnectionManager().assertConnectionCurrent(connection);
		const principalFingerprint = await readCurrentSqlSchemaPrincipalFingerprint(this.context, connection);
		if (!principalFingerprint) throw new Error('SQL section principal is unavailable while reading schema.');
		const revocationGeneration = this.getSqlRevocationGeneration?.(connectionId) ?? 0;
		const result = await this.sendToWebview<{ success: boolean; schema?: unknown; error?: string; owner?: { connectionId?: string; database?: string; ownerToken?: string } }>('toolGetSqlSchema', { sectionId }, 30000, target, undefined, capturedConnection);
		if (capturedConnection?.sqlConnectionResolver?.(sectionId) !== connectionId) {
			throw new Error('SQL section connection changed while reading schema.');
		}
		const finalConnection = this.getSqlConnectionManager().getConnection(connectionId);
		if (!finalConnection || sqlConnectionTargetSignature(finalConnection) !== targetSignature) throw new Error('SQL connection target changed while reading schema.');
		await this.getSqlConnectionManager().assertConnectionCurrent(finalConnection);
		if (await readCurrentSqlSchemaPrincipalFingerprint(this.context, finalConnection) !== principalFingerprint) throw new Error('SQL connection principal changed while reading schema.');
		const responseOwnerMatches = String(result.owner?.connectionId || '') === connectionId
			&& String(result.owner?.database || '') === expectedDatabase
			&& String(result.owner?.ownerToken || '') === expectedOwnerToken;
		if (!responseOwnerMatches && (result.success !== false || result.schema !== undefined)) {
			throw new Error('SQL schema response owner changed before admission.');
		}
		await this.refreshSqlLeaveNoTracePolicy?.();
		await this.assertSqlConnectionAllowed?.(connectionId);
		return this.admitSqlToolResult(
			connection,
			principalFingerprint,
			revocationGeneration,
			() => {
				this.assertLiveSqlToolOwner(capturedConnection, {
					sectionId, connectionId, database: expectedDatabase, ownerToken: expectedOwnerToken, generation,
				});
				const ownerMatches = String(result.owner?.connectionId || '') === connectionId
					&& String(result.owner?.database || '') === expectedDatabase
					&& String(result.owner?.ownerToken || '') === expectedOwnerToken;
				if (!ownerMatches && (result.success !== false || result.schema !== undefined)) {
					throw new Error('SQL schema response owner changed before admission.');
				}
			},
			result,
		);
	}

	async delegateToSqlCopilot(input: DelegateToSqlCopilotInput, cancellationToken?: vscode.CancellationToken): Promise<{
		success: boolean;
		answer: string;
		query?: string;
		error?: string;
		timedOut?: boolean;
	}> {
		const { target, rest } = this.splitTargetFields(input);
		const resolvedTarget = this.resolveToolTarget(target);
		const capturedConnection = resolvedTarget.connection;
		const resolvedSection = await this.resolveSqlToolSection(capturedConnection, rest.sectionId);
		const { sectionId, connectionId, database: expectedDatabase, ownerToken: expectedOwnerToken, generation } = resolvedSection;
		await this.refreshSqlLeaveNoTracePolicy?.();
		await this.assertSqlConnectionAllowed?.(connectionId);
		const connection = this.getSqlConnectionManager().getConnection(connectionId);
		if (!connection) throw new Error('SQL section connection owner disappeared during Copilot delegation.');
		const targetSignature = sqlConnectionTargetSignature(connection);
		await this.getSqlConnectionManager().assertConnectionCurrent(connection);
		const principalFingerprint = await readCurrentSqlSchemaPrincipalFingerprint(this.context, connection);
		if (!principalFingerprint) throw new Error('SQL section principal is unavailable during Copilot delegation.');
		const revocationGeneration = this.getSqlRevocationGeneration?.(connectionId) ?? 0;
		const result = await this.sendToWebview<{
			success: boolean;
			answer: string;
			query?: string;
			error?: string;
			timedOut?: boolean;
			owner?: { connectionId?: string; database?: string; ownerToken?: string };
		}>('toolDelegateToSqlCopilot', {
			input: {
				...rest,
				sectionId,
				expectedOwnerToken,
				expectedConnectionId: connectionId,
				expectedDatabase,
			},
		}, 180000, target, (editor, requestId) => {
			editor.poster({
				type: 'toolCancelSqlCopilot', requestId, sectionId,
				expectedOwnerToken,
			});
		}, capturedConnection, cancellationToken);
		if (capturedConnection?.sqlConnectionResolver?.(sectionId) !== connectionId) {
			throw new Error('SQL section connection changed during Copilot delegation.');
		}
		const finalConnection = this.getSqlConnectionManager().getConnection(connectionId);
		if (!finalConnection || sqlConnectionTargetSignature(finalConnection) !== targetSignature) throw new Error('SQL connection target changed during Copilot delegation.');
		await this.getSqlConnectionManager().assertConnectionCurrent(finalConnection);
		if (await readCurrentSqlSchemaPrincipalFingerprint(this.context, finalConnection) !== principalFingerprint) throw new Error('SQL connection principal changed during Copilot delegation.');
		const responseOwnerMatches = String(result.owner?.connectionId || '') === connectionId
			&& String(result.owner?.database || '') === expectedDatabase
			&& String(result.owner?.ownerToken || '') === expectedOwnerToken;
		if (!responseOwnerMatches && (result.success !== false || !!result.query)) {
			throw new Error('SQL Copilot response owner changed before admission.');
		}
		await this.refreshSqlLeaveNoTracePolicy?.();
		await this.assertSqlConnectionAllowed?.(connectionId);
		return this.admitSqlToolResult(
			connection,
			principalFingerprint,
			revocationGeneration,
			() => {
				this.assertLiveSqlToolOwner(capturedConnection, {
					sectionId, connectionId, database: expectedDatabase, ownerToken: expectedOwnerToken, generation,
				});
				const ownerMatches = String(result.owner?.connectionId || '') === connectionId
					&& String(result.owner?.database || '') === expectedDatabase
					&& String(result.owner?.ownerToken || '') === expectedOwnerToken;
				if (!ownerMatches && (result.success !== false || !!result.query)) {
					throw new Error('SQL Copilot response owner changed before admission.');
				}
			},
			result,
		);
	}

	async addSection(input: AddSectionInput): Promise<{ sectionId: string; success: boolean }> {
		const { target, rest } = this.splitTargetFields(input);
		input = rest as AddSectionInput;
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
		if (input.type === 'query') {
			const preflight = this.preflightKustoToolTarget(input);
			if (!preflight.input) return { sectionId: '', success: false, error: preflight.error } as { sectionId: string; success: boolean };
			input = preflight.input;
		}
		return this.sendToWebview('toolAddSection', { input }, 30000, target);
	}

	async removeSection(input: RemoveSectionInput): Promise<{ success: boolean }> {
		const { target, rest } = this.splitTargetFields(input);
		return this.sendToWebview('toolRemoveSection', { sectionId: rest.sectionId }, 30000, target);
	}

	async collapseSection(input: CollapseSectionInput): Promise<{ success: boolean }> {
		const { target, rest } = this.splitTargetFields(input);
		return this.sendToWebview('toolCollapseSection', { sectionId: rest.sectionId, collapsed: rest.collapsed }, 30000, target);
	}

	async reorderSections(input: ReorderSectionsInput): Promise<{ success: boolean; error?: string }> {
		const { target, rest } = this.splitTargetFields(input);
		return this.sendToWebview('toolReorderSections', { sectionIds: rest.sectionIds }, 30000, target);
	}

	async configureQuerySection(input: ConfigureQuerySectionInput, cancellationToken?: vscode.CancellationToken): Promise<{ success: boolean; resultPreview?: string }> {
		const { target, rest } = this.splitTargetFields(input);
		input = rest as ConfigureQuerySectionInput;
		// Unescape literal \n sequences that LLMs frequently produce in query text
		if (input.query !== undefined) {
			input = { ...input, query: unescapeLLMText(input.query) };
		}
		const preflight = this.preflightKustoToolTarget(input);
		if (!preflight.input) return { success: false, resultPreview: '', error: preflight.error } as { success: boolean; resultPreview?: string };
		input = preflight.input;
		const queryTimeoutMinutes = vscode.workspace.getConfiguration('kustoWorkbench').get<number>('queryTimeout', 20);
		const timeoutMs = input.execute
			? (queryTimeoutMinutes > 0 ? queryTimeoutMinutes * 60_000 + 30_000 : null)
			: 30000;
		return this.sendToWebview('toolConfigureQuerySection', { input }, timeoutMs, target, undefined, undefined, cancellationToken);
	}

	async updateMarkdownSection(input: UpdateMarkdownSectionInput): Promise<{ success: boolean }> {
		const { target, rest } = this.splitTargetFields(input);
		input = rest as UpdateMarkdownSectionInput;
		// Unescape literal \n sequences that LLMs frequently produce in markdown text
		const textValue = input.text ?? input.content;
		if (textValue !== undefined) {
			input = { ...input, text: unescapeLLMText(textValue) };
		}
		return this.sendToWebview('toolUpdateMarkdownSection', { input }, 30000, target);
	}

	async configureChart(input: ConfigureChartInput): Promise<{ success: boolean }> {
		const { target, rest } = this.splitTargetFields(input);
		return this.sendToWebview('toolConfigureChart', { input: rest }, 30000, target);
	}

	async configureTransformation(input: ConfigureTransformationInput): Promise<{ success: boolean }> {
		const { target, rest } = this.splitTargetFields(input);
		return this.sendToWebview('toolConfigureTransformation', { input: rest }, 30000, target);
	}

	async configureHtmlSection(input: ConfigureHtmlSectionInput): Promise<{ success: boolean; sectionId?: string }> {
		const { target, rest } = this.splitTargetFields(input);
		input = rest as ConfigureHtmlSectionInput;
		if (input.code !== undefined) {
			input = { ...input, code: unescapeLLMText(input.code) };
		}
		return this.sendToWebview('toolConfigureHtmlSection', {
			sectionId: input.sectionId,
			name: input.name,
			code: input.code,
			mode: input.mode,
		}, 30000, target);
	}

	async getHtmlDashboardGuide(input: GetHtmlDashboardGuideInput): Promise<{ mode: 'checklist' | 'template' | 'full'; content: string }> {
		const mode = input.mode || 'checklist';
		const guideUri = vscode.Uri.joinPath(this.context.extensionUri, 'copilot-instructions', 'html-dashboard-rules.md');
		const raw = await vscode.workspace.fs.readFile(guideUri);
		const guide = Buffer.from(raw).toString('utf8');
		let content = guide;
		if (mode === 'checklist') {
			content = extractMarkdownSection(guide, 'Dashboard Checklist');
		} else if (mode === 'template') {
			content = extractMarkdownSection(guide, 'Starter Template');
		}
		return { mode, content };
	}

	async validateHtmlDashboard(input: ValidateHtmlDashboardInput): Promise<ValidateHtmlDashboardResult> {
		const { target, rest } = this.splitTargetFields(input);
		input = rest as ValidateHtmlDashboardInput;
		const sectionId = (input.sectionId || '').trim();
		if (!sectionId) {
			return {
				success: false,
				valid: false,
				sectionId: '',
				issues: ['sectionId is required.'],
				diagnostics: [],
				warnings: [],
				hasProvenance: false,
				bindingCount: 0,
				dataSourceCount: 0,
				factColumns: [],
				error: 'sectionId is required.',
			};
		}

		let context: HtmlDashboardContextResult;
		try {
			context = await this.sendToWebview<HtmlDashboardContextResult>('toolGetHtmlDashboardContext', { sectionId }, 30000, target);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				success: false,
				valid: false,
				sectionId,
				issues: [message],
				diagnostics: [],
				warnings: [],
				hasProvenance: false,
				bindingCount: 0,
				dataSourceCount: 0,
				factColumns: [],
				error: message,
			};
		}

		const code = context.code || '';
		const dataSources = Array.isArray(context.dataSources) ? context.dataSources : [];
		const issues: string[] = [];
		if (!context.success) issues.push(context.error || 'Unable to read HTML dashboard context.');
		if (!code.trim()) issues.push('HTML section has no dashboard code.');
		if (!context.hasProvenance) issues.push('Missing application/kw-provenance block. Upgrade this dashboard to the latest provenance contract before finalizing.');
		if (dataSources.length === 0) issues.push('No runnable fact data source found. Run the fact query and ensure provenance model.fact.sectionId points at that query section.');
		const diagnostics = getPowerBiHtmlValidationDiagnostics(code, dataSources);
		issues.push(...diagnostics
			.filter(diagnostic => diagnostic.code !== 'missing-provenance')
			.map(diagnostic => diagnostic.message));

		let filePath: string | undefined;
		let fileName: string | undefined;
		const resolvedTarget = this.resolveToolTarget(target);
		const file = resolvedTarget.explicitTarget
			?? (resolvedTarget.activeFile && resolvedTarget.connection?.logicalUriKey === resolvedTarget.activeFile.logicalUriKey
				? resolvedTarget.activeFile
				: resolvedTarget.connection?.documentInfo);
		filePath = file?.filePath;
		fileName = file?.fileName;

		const uniqueIssues = uniqueStrings(issues);
		return {
			success: !!context.success,
			valid: !!context.success && uniqueIssues.length === 0,
			sectionId,
			issues: uniqueIssues,
			diagnostics,
			warnings: uniqueStrings(getLegacyDashboardWarnings(code)),
			hasProvenance: !!context.hasProvenance,
			bindingCount: context.bindingCount || 0,
			dataSourceCount: dataSources.length,
			factColumns: context.factColumns || [],
			filePath,
			fileName,
			...(context.error ? { error: context.error } : {}),
		};
	}

	async delegateToKustoWorkbenchCopilot(input: DelegateToKustoWorkbenchCopilotInput, cancellationToken?: vscode.CancellationToken): Promise<{
		success: boolean;
		answer: string;
		query?: string;
		executed?: boolean;
		rowCount?: number;
		columns?: string[];
		results?: Array<Record<string, unknown>>;
		maxResultRows?: number;
		returnedRowCount?: number;
		truncated?: string;
		error?: string;
		timedOut?: boolean;
	}> {
		const { target, rest } = this.splitTargetFields(input);
		const preflight = this.preflightKustoToolTarget(rest);
		if (!preflight.input) return { success: false, answer: '', error: preflight.error };
		const normalizedInput = {
			...preflight.input,
			maxResultRows: normalizeAskKustoCopilotMaxResultRows(input.maxResultRows)
		};
		return this.sendToWebview(
			'toolDelegateToKustoWorkbenchCopilot',
			{ input: normalizedInput },
			180000,
			target,
			(connection, requestId) => connection.poster({ type: 'toolCancelKustoCopilot', requestId }),
			undefined,
			cancellationToken,
		);
	}

	private getEditorIdForWorkbenchFile(info: WorkbenchFileInfo): string | undefined {
		switch (info.fileKind) {
			case 'kqlx':
			case 'mdx':
			case 'sqlx':
				return 'kusto.kqlxEditor';
			case 'kql':
			case 'csl':
			case 'kql-sidecar':
			case 'csl-sidecar':
				return 'kusto.kqlCompatEditor';
			case 'sql':
			case 'sql-sidecar':
				return 'kusto.sqlCompatEditor';
			case 'md':
				return 'kusto.mdCompatEditor';
			default:
				return undefined;
		}
	}

	async activateWorkbenchFile(input: TargetFields): Promise<ActivationResult> {
		const targetFileInfo = input.targetFileUri ? this.normalizeTargetFileUri(input.targetFileUri) : undefined;
		const target = this.resolveToolTarget(input);
		const file = target.explicitTarget ?? target.activeFile;
		const info = targetFileInfo
			?? (file ? classifyWorkbenchUriString(file.logicalUri, { includeOptionalPlainText: true }) : undefined)
			?? target.connection?.documentInfo;
		if (!file && !info) {
			return { success: false, error: 'No target Workbench file was found. Use #listSections to get current openFileId values.' };
		}
		const effectiveInfo = info ?? (file ? classifyWorkbenchUriString(file.logicalUri, { includeOptionalPlainText: true }) : undefined);
		if (!effectiveInfo) {
			return { success: false, error: 'The target is not a supported Kusto Workbench file.' };
		}
		const editorId = this.getEditorIdForWorkbenchFile(effectiveInfo);
		if (!editorId) {
			return { success: false, error: 'No Workbench editor is available for the target file.' };
		}
		try {
			await vscode.commands.executeCommand('vscode.openWith', effectiveInfo.logicalUri, editorId, {
				viewColumn: vscode.ViewColumn.Active,
				preserveFocus: false,
			});
		} catch (err) {
			return {
				success: false,
				openFileId: effectiveInfo.openFileId,
				uri: effectiveInfo.uriString,
				logicalUri: effectiveInfo.logicalUriString,
				fileKind: effectiveInfo.fileKind,
				...(effectiveInfo.filePath ? { filePath: effectiveInfo.filePath } : {}),
				...(effectiveInfo.fileName ? { fileName: effectiveInfo.fileName } : {}),
				error: err instanceof Error ? err.message : String(err),
			};
		}
		const liveConnection = this.getLatestLiveConnectionForKey(effectiveInfo.logicalUriKey);
		return {
			success: true,
			openFileId: effectiveInfo.openFileId,
			uri: effectiveInfo.uriString,
			logicalUri: effectiveInfo.logicalUriString,
			fileKind: effectiveInfo.fileKind,
			...(effectiveInfo.filePath ? { filePath: effectiveInfo.filePath } : {}),
			...(effectiveInfo.fileName ? { fileName: effectiveInfo.fileName } : {}),
			isLiveWorkbench: !!liveConnection,
			isReadOnlyFallback: !liveConnection,
		};
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
			case 'sqlx':
				extension = '.sqlx';
				editorId = 'kusto.kqlxEditor';
				kqlxKind = 'sqlx';
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
			const baseName = fileType === 'kqlx' || fileType === 'sqlx' || fileType === 'mdx'
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
					const initialSectionKind = defaultSectionKindForDocument(kqlxKind);
					const initialSection = {
						type: initialSectionKind,
						expanded: true,
						...(initialSectionKind === 'markdown' ? { text: initialContent } : { query: initialContent }),
					} as KqlxSectionV1;
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

export class ActivateWorkbenchFileTool implements vscode.LanguageModelTool<TargetFields> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<TargetFields>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.activateWorkbenchFile(getToolInput(options));
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
		options: vscode.LanguageModelToolInvocationPrepareOptions<TargetFields>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		const input = getToolInput(options);
		return {
			invocationMessage: `Activating Workbench file ${input?.openFileId || input?.targetFileUri || ''}...`
		};
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
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.configureQuerySection(getToolInput(options), token);
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
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.delegateToKustoWorkbenchCopilot(getToolInput(options), token);
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

export class GetHtmlDashboardGuideTool implements vscode.LanguageModelTool<GetHtmlDashboardGuideInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<GetHtmlDashboardGuideInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.getHtmlDashboardGuide(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(result.content)
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<GetHtmlDashboardGuideInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		const input = getToolInput(options);
		return {
			invocationMessage: `Reading HTML dashboard guide (${input?.mode || 'checklist'})...`
		};
	}
}

export class ValidateHtmlDashboardTool implements vscode.LanguageModelTool<ValidateHtmlDashboardInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ValidateHtmlDashboardInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.validateHtmlDashboard(getToolInput(options));
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
		options: vscode.LanguageModelToolInvocationPrepareOptions<ValidateHtmlDashboardInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		const input = getToolInput(options);
		return {
			invocationMessage: `Validating HTML dashboard ${input?.sectionId || 'unknown'}...`
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
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await raceCancellation(this.orchestrator.configureSqlSection(getToolInput(options), token), token);
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
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.delegateToSqlCopilot(getToolInput(options), token);
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
	kustoClient: KustoQueryClient,
	refreshSqlLeaveNoTracePolicy?: () => Promise<string[]>,
	assertSqlConnectionAllowed?: (connectionId: string) => Promise<void>,
	getSqlRevocationGeneration?: (connectionId: string) => number,
	dispatchSqlOwnerAllowed?: <T>(connection: SqlConnection, principalFingerprint: string, revocationGeneration: number, dispatch: () => T | PromiseLike<T>) => Promise<T>,
): KustoWorkbenchToolOrchestrator {
	const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
		context,
		connectionManager,
		getSqlConnectionManager,
		kustoClient,
		refreshSqlLeaveNoTracePolicy,
		assertSqlConnectionAllowed,
		getSqlRevocationGeneration,
		dispatchSqlOwnerAllowed,
	);

	// Register all tools using the languageModelTools[].name values from package.json
	// This is how VS Code binds the manifest contribution to the implementation
	context.subscriptions.push(
		vscode.lm.registerTool('kusto-workbench_list-connections', new ListConnectionsTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_list-favorites', new ListFavoritesTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_get-schema', new GetSchemaTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_refresh-schema', new RefreshKustoSchemaTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_search-cached-schemas', new SearchCachedSchemasTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_list-sections', new ListSectionsTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_activate-workbench-file', new ActivateWorkbenchFileTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_add-section', new AddSectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_remove-section', new RemoveSectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_collapse-section', new CollapseSectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_reorder-sections', new ReorderSectionsTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_configure-query-section', new ConfigureQuerySectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_update-markdown-section', new UpdateMarkdownSectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_configure-chart', new ConfigureChartTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_configure-transformation', new ConfigureTransformationTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_configure-html-section', new ConfigureHtmlSectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_get-html-dashboard-guide', new GetHtmlDashboardGuideTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_validate-html-dashboard', new ValidateHtmlDashboardTool(orchestrator)),
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
