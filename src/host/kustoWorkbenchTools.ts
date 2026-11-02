import * as vscode from 'vscode';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'node:util';
import { ConnectionManager, KustoConnection } from './connectionManager';
import {
	createKqlxOrMdxFileWithDefaultSection,
	parseKqlxText,
	stringifyKqlxFile,
	type DevNoteEntry,
	type KqlxFileV1,
	type KqlxFileKind,
	type KqlxSectionV1,
} from './kqlxFormat';
import { captureSchemaCacheGeneration, readAllCachedSchemasFromDisk, readCachedSchemaFromDiskByCluster, searchCachedSchemas, writeCachedSchemaToDisk, SCHEMA_CACHE_VERSION, schemaCacheKey, schemaPrincipalIdentity, type SchemaCacheGeneration } from './schemaCache';
import { KustoConnectionCache, type KustoConnectionCacheGeneration } from './kustoConnectionCache';
import type { SqlConnection, SqlConnectionManager } from './sqlConnectionManager';
import type { KustoQueryClient } from './kustoClient';
import { countColumns, formatSchemaAsCompactText, formatSchemaWithTokenBudget } from './schemaIndexUtils';
import {
	getPowerBiHtmlValidationDiagnostics,
} from './powerBiExport';
import { getLegacyDashboardWarnings, parseKwProvenance } from '../shared/htmlDashboardUpgrade';
import type { PortableDashboardDataSource, PortableDashboardDiagnostic } from '../shared/portableDashboardCompiler';
import { classifyWorkbenchUri, classifyWorkbenchUriString, sameNonzeroPhysicalFileIdentity, type WorkbenchFileInfo, type WorkbenchFileKind } from './workbenchFileTypes';
import { kustoClusterKey } from '../shared/kustoClusterUrls';
import { getKustoConnectionIdentityKey, resolveStrictKustoConnection } from '../shared/kustoAuth';
import {
	parseKustoCopilotClarificationRequiredResult,
	type KustoCopilotClarificationRequiredResult,
} from '../shared/kustoCopilotClarificationProtocol.js';
import { filterKustoFavoritesForActivePrincipals, migrateKustoFavorites } from './connectionManagerFavorites';
import { sqlConnectionTargetSignature } from '../shared/sqlConnectionIdentity';
import { readCurrentSqlSchemaPrincipalFingerprint, sqlSchemaPrincipalFingerprint } from './sqlEditorSchema';
import type { KustoExecutionRequestIdentity } from '../shared/kustoExecution.js';
import type { KustoLeaveNoTracePolicySnapshot } from './kustoLeaveNoTracePolicyStore';
import {
	admitDevelopmentNoteMutationWebviewMessage,
	createDevelopmentNoteMutationHostMessage,
	type DevelopmentNoteMutationPayload,
	type DevelopmentNoteMutationWebviewAdmission,
} from '../shared/developmentNoteMutationProtocol.js';
import { captureExpectedKustoTarget, type ExpectedKustoTarget, type ToolStateSection } from '../shared/toolStateSnapshotProtocol.js';
import { isRuntimeProxy } from '../shared/runtimeMessageEnvelope.js';
import type { KustoExecutionPreparation, WorkbenchFileCloseLifecycle } from './workbenchToolSessionApplicationHandler.js';
import { withKqlxDocumentWriteLock } from './kqlxEditorProvider.js';
import { canonicalAddableSectionKind } from '../shared/documentSectionCapabilities.js';
import { createFileOpenTrace, observeFileOpenActivation } from './fileOpenTrace';

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

type SchemaSummaryItem = Readonly<{
	clusterUrl: string;
	database: string;
	tables: string[];
	functions: string[];
}>;

type SchemaCollectionKey = 'databases' | 'schemas';

export async function formatSchemaCollectionJsonWithTokenBudget(
	result: Readonly<{ error?: string }> & Partial<Record<SchemaCollectionKey, SchemaSummaryItem[]>>,
	collectionKey: SchemaCollectionKey,
	tokenizationOptions: vscode.LanguageModelToolTokenizationOptions | undefined,
	token: vscode.CancellationToken,
): Promise<string> {
	const fullText = JSON.stringify(result, null, 2);
	if (!tokenizationOptions || tokenizationOptions.tokenBudget <= 0) return fullText;
	const countTokens = async (text: string) => {
		try {
			return await tokenizationOptions.countTokens(text, token);
		} catch {
			return Math.max(1, Math.ceil(text.length / 4));
		}
	};
	if (await countTokens(fullText) <= tokenizationOptions.tokenBudget) return fullText;

	const source = result[collectionKey] ?? [];
	const error = result.error?.slice(0, 500);
	const candidate = (count: number, nameLimit: number, includeError: boolean) => {
		const entries = source.slice(0, count).map(entry => ({
			clusterUrl: entry.clusterUrl,
			database: entry.database,
			tables: entry.tables.slice(0, nameLimit),
			functions: entry.functions.slice(0, nameLimit),
			...(entry.tables.length > nameLimit ? { tableCount: entry.tables.length } : {}),
			...(entry.functions.length > nameLimit ? { functionCount: entry.functions.length } : {}),
		}));
		return JSON.stringify({
			[collectionKey]: entries,
			...(includeError && error ? { error } : {}),
			truncated: true,
			totalDatabaseCount: source.length,
			returnedDatabaseCount: entries.length,
		}, null, 2);
	};

	let bestText: string | undefined;
	let bestCount = -1;
	let bestNameLimit = -1;
	for (const nameLimit of [100, 25, 5, 0]) {
		let low = 0;
		let high = source.length;
		let fittingCount = -1;
		let fittingText: string | undefined;
		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			const text = candidate(middle, nameLimit, true);
			if (await countTokens(text) <= tokenizationOptions.tokenBudget) {
				fittingCount = middle;
				fittingText = text;
				low = middle + 1;
			} else {
				high = middle - 1;
			}
		}
		if (fittingText && (fittingCount > bestCount || (fittingCount === bestCount && nameLimit > bestNameLimit))) {
			bestText = fittingText;
			bestCount = fittingCount;
			bestNameLimit = nameLimit;
		}
	}
	if (bestText) return bestText;

	const withoutError = candidate(0, 0, false);
	if (await countTokens(withoutError) <= tokenizationOptions.tokenBudget) return withoutError;
	return '{}';
}

type ToolResponseAdmission<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false }>;

function admitKustoCopilotDelegationResult(
	result: unknown,
): ToolResponseAdmission<DelegateToKustoWorkbenchCopilotResult> {
	const clarification = parseKustoCopilotClarificationRequiredResult(result);
	if (clarification.ok) return clarification;
	if (!result || typeof result !== 'object' || isRuntimeProxy(result)) {
		return { ok: false };
	}
	try {
		if (Array.isArray(result)) return { ok: false };
		const prototype = Object.getPrototypeOf(result);
		if (prototype !== Object.prototype && prototype !== null) return { ok: false };
		if (Object.getOwnPropertyDescriptor(result, 'outcome')) return { ok: false };
		const success = Object.getOwnPropertyDescriptor(result, 'success');
		if (!success?.enumerable || !Object.prototype.hasOwnProperty.call(success, 'value')
			|| typeof success.value !== 'boolean') return { ok: false };
		return { ok: true, value: result as DelegateToKustoWorkbenchCopilotResult };
	} catch {
		return { ok: false };
	}
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

export interface CloseWorkbenchFileInput extends TargetFields {
	/** Save the exact dirty backing document before closing. Dirty files are refused by default. */
	saveChanges?: boolean;
}

export interface SaveWorkbenchFileInput extends TargetFields {}

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
	/** For chart sections: zero-based result set index from the source query */
	dataSourceResultIndex?: number;
	/** For chart sections: chart type */
	chartType?: 'line' | 'area' | 'bar' | 'scatter' | 'pie' | 'funnel' | 'sankey' | 'heatmap';
	/** Section name/title */
	name?: string;
}

export type AddSectionResult = {
	sectionId: string;
	success: boolean;
	error?: string;
};

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

export type KustoToolResultSet = {
	resultIndex: number;
	resultName?: string;
	rowCount: number;
	columns: unknown[];
	results: unknown[];
	returnedRowCount: number;
	truncated: boolean;
};

export type ConfigureQuerySectionResult = {
	success: boolean;
	rowCount?: number;
	columns?: unknown[];
	resultPreview?: string;
	resultSets?: KustoToolResultSet[];
	error?: string;
};

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
	dataSourceResultIndex?: number;
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
	dataSourceResultIndex?: number;
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
	joinRightDataSourceResultIndex?: number;
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

export type DelegateToKustoWorkbenchCopilotResult =
	| (KustoCopilotClarificationRequiredResult & { openFileId?: string })
	| {
		success: boolean;
		answer?: string;
		query?: string;
		executed?: boolean;
		rowCount?: number;
		columns?: unknown[];
		results?: unknown[];
		resultSets?: KustoToolResultSet[];
		maxResultRows?: number;
		returnedRowCount?: number;
		truncated?: string;
		error?: string;
		timedOut?: boolean;
	};

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
	dataSources?: PortableDashboardDataSource[];
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
	/** When false, open the Workbench editor without taking focus from the user's current application/editor. */
	reveal?: boolean;
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
interface ToolSection extends ToolStateSection {
	id?: string;
	name?: string;
	title?: string;
	expanded?: boolean;
	clusterUrl?: string;
	database?: string;
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

type CloseWorkbenchFileResult = {
	success: boolean;
	closed: boolean;
	closedTabCount?: number;
	saved?: boolean;
	wasDirty?: boolean;
	openFileId?: string;
	uri?: string;
	logicalUri?: string;
	fileKind?: WorkbenchFileKind;
	filePath?: string;
	fileName?: string;
	error?: string;
};

interface LiveWorkbenchConnection {
	token: number;
	poster: (message: unknown, signal?: AbortSignal, isCurrent?: () => boolean) => unknown;
	stateGetter: () => Promise<ToolSection[] | undefined>;
	captureStateAdmission?: () => (() => boolean);
	prepareKustoExecution?: KustoExecutionPreparation;
	prepareSqlExecution?: () => Promise<void>;
	captureSqlSectionAdmission?: (sectionId: string) => (() => boolean);
	waitForMutationReady?: () => Promise<boolean>;
	reactivate?: () => Promise<boolean>;
	waitForReadReady?: () => Promise<boolean>;
	schemaRefresher: (clusterUrl: string, connectionId: string) => Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }>;
	sqlConnectionResolver?: (sectionId?: string) => string | undefined;
	sqlOwnerResolver?: (sectionId: string) => {
		connectionId: string;
		database: string;
		ownerToken: string;
		generation: number;
	} | undefined;
	closeLifecycle?: WorkbenchFileCloseLifecycle;
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
	private static readonly SQL_TOOL_INSTALLATION_TIMEOUT_MS = 6 * 60_000;
	private static readonly SQL_TOOL_OWNER_READY_TIMEOUT_MS = 10_000;
	private static readonly SQL_TOOL_OWNER_READY_POLL_MS = 50;
	
	// Legacy fallback callbacks for the latest connected editor, including the standalone Query Editor.
	private webviewMessagePoster: ((message: unknown) => void) | undefined;
	private stateGetter: (() => Promise<ToolSection[] | undefined>) | undefined;
	private schemaRefresher: ((clusterUrl: string, connectionId: string) => Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }>) | undefined;
	private activeDocumentUri: string | undefined;
	private latestConnectionToken: number | undefined;
	private readonly liveConnections = new Map<number, LiveWorkbenchConnection>();
	private readonly renamedWorkbenchFiles = new Map<string, WorkbenchFileInfo>();
	private readonly deferredRenamedTabClosures = new Map<string, {
		oldUri: vscode.Uri;
		newUri: vscode.Uri;
		newLogicalUriKey: string;
	}>();
	private readonly pendingResponseDrainWaiters = new Set<{
		logicalUriKeys: ReadonlySet<string>;
		resolve: () => void;
	}>();
	private readonly backgroundFileOperations = new Map<string, Promise<void>>();
	private readonly backgroundMutationBlocks = new Map<string, number>();
	private readonly hostOwnedBackgroundFiles = new Map<string, string | undefined>();
	private readonly backgroundUserInteractionTransfers = new Map<string, Promise<void>>();
	private readonly backgroundOpeningFiles = new Set<string>();
	private readonly backgroundProgrammaticSelections = new Set<string>();
	private readonly backgroundOpeningTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly preparedBackgroundRenames = new Map<string, {
		logicalUriKeys: readonly string[];
		files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[];
		blockMoves: readonly { oldLogicalUriKey: string; newLogicalUriKey: string }[];
		cleanupTimer?: ReturnType<typeof setTimeout>;
	}>();
	// Pending responses from webview
	private pendingResponses = new Map<string, {
		resolve: (value: unknown) => void;
		reject: (err: Error) => void;
		timer?: ReturnType<typeof setTimeout>;
		cancellationSubscription?: vscode.Disposable;
		controller: AbortController;
		connectionToken: number;
		kustoExecution?: KustoExecutionRequestIdentity;
		waitForRename?: boolean;
		admitResult?: (result: unknown) => ToolResponseAdmission<unknown>;
	}>();
	private readonly developmentNoteMutationRequestIds = new Set<string>();
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
		poster: (message: unknown, signal?: AbortSignal, isCurrent?: () => boolean) => unknown,
		stateGetter: () => Promise<ToolSection[] | undefined>,
		schemaRefresher: (clusterUrl: string, connectionId: string) => Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }>,
		documentUri?: string,
		sqlConnectionResolver?: (sectionId?: string) => string | undefined,
		sqlOwnerResolver?: LiveWorkbenchConnection['sqlOwnerResolver'],
		closeLifecycle?: WorkbenchFileCloseLifecycle,
		waitForMutationReady?: () => Promise<boolean>,
		reactivate?: () => Promise<boolean>,
		waitForReadReady?: () => Promise<boolean>,
		captureStateAdmission?: () => (() => boolean),
		prepareKustoExecution?: KustoExecutionPreparation,
		prepareSqlExecution?: () => Promise<void>,
		captureSqlSectionAdmission?: (sectionId: string) => (() => boolean),
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
			...(closeLifecycle ? { closeLifecycle } : {}),
			...(waitForMutationReady ? { waitForMutationReady } : {}),
			...(reactivate ? { reactivate } : {}),
			...(waitForReadReady ? { waitForReadReady } : {}),
			...(captureStateAdmission ? { captureStateAdmission } : {}),
			...(prepareKustoExecution ? { prepareKustoExecution } : {}),
			...(prepareSqlExecution ? { prepareSqlExecution } : {}),
			...(captureSqlSectionAdmission ? { captureSqlSectionAdmission } : {}),
			...(documentUri ? { documentUri } : {}),
			...(documentInfo ? { documentInfo, logicalUriKey: documentInfo.logicalUriKey } : {}),
			sequence: this.connectionToken,
		};
		this.liveConnections.set(entry.token, entry);
		this.applyLatestConnection(entry);
		return this.connectionToken;
	}

	activateConnection(token: number): boolean {
		const connection = this.liveConnections.get(token);
		if (!connection) return false;
		this.applyLatestConnection(connection);
		return true;
	}

	isConnectionCurrent(token: number): boolean {
		return this.liveConnections.has(token);
	}

	evictActiveConnectionForTest(): boolean {
		if (this.latestConnectionToken === undefined) return false;
		this.disconnectIfOwner(this.latestConnectionToken);
		return true;
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
			this.developmentNoteMutationRequestIds.delete(requestId);
			pending.controller.abort();
			if (pending.timer) clearTimeout(pending.timer);
			pending.cancellationSubscription?.dispose();
			pending.reject(new Error('The owning Kusto Workbench editor closed before the request completed.'));
		}
		this.flushDeferredRenamedTabClosures();
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

	private getToolConnectionForFile(file: InternalOpenWorkbenchFileSummary): LiveWorkbenchConnection | undefined {
		return this.hostOwnedBackgroundFiles.has(file.logicalUriKey)
			? undefined
			: this.getLatestLiveConnectionForKey(file.logicalUriKey);
	}

	isHostOwnedBackgroundFile(uri: vscode.Uri): boolean {
		const file = classifyWorkbenchUri(uri, { includeOptionalPlainText: true });
		return !!file && this.hostOwnedBackgroundFiles.has(file.logicalUriKey)
			&& !this.backgroundUserInteractionTransfers.has(file.logicalUriKey);
	}

	transferBackgroundOwnershipOnUserInteraction(uri: vscode.Uri): Promise<void> {
		const file = classifyWorkbenchUri(uri, { includeOptionalPlainText: true });
		if (!file || !this.hostOwnedBackgroundFiles.has(file.logicalUriKey)) return Promise.resolve();
		const key = file.logicalUriKey;
		const pending = this.backgroundUserInteractionTransfers.get(key);
		if (pending) return pending;
		this.addBackgroundMutationBlock(key);
		const transfer = (async () => {
			await this.waitForBackgroundFileOperation(key);
			this.hostOwnedBackgroundFiles.delete(key);
			this.backgroundProgrammaticSelections.delete(key);
			this.clearBackgroundOpeningLease(key);
		})().finally(() => {
			this.backgroundUserInteractionTransfers.delete(key);
			this.removeBackgroundMutationBlock(key);
		});
		this.backgroundUserInteractionTransfers.set(key, transfer);
		return transfer;
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
			if (this.wasRenamedSourceRecreated(current, renamed)) {
				this.renamedWorkbenchFiles.delete(key);
				return current;
			}
			current = renamed;
			if (renamed.logicalUriKey === key) {
				return renamed;
			}
		}
		return current;
	}

	private wasRenamedSourceRecreated(source: WorkbenchFileInfo, target: WorkbenchFileInfo): boolean {
		if (source.logicalUriKey === target.logicalUriKey
			|| source.logicalUri.scheme !== 'file'
			|| target.logicalUri.scheme !== 'file'
			|| !fs.existsSync(source.logicalUri.fsPath)) return false;
		if (!fs.existsSync(target.logicalUri.fsPath)) return true;
		try {
			const sourceStat = fs.statSync(source.logicalUri.fsPath, { bigint: true });
			const targetStat = fs.statSync(target.logicalUri.fsPath, { bigint: true });
			return !sameNonzeroPhysicalFileIdentity(sourceStat, targetStat);
		} catch {
			return true;
		}
	}

	private backgroundRenameKey(oldUri: vscode.Uri, newUri: vscode.Uri): string {
		return `${oldUri.toString()}\n${newUri.toString()}`;
	}

	private trackedWorkbenchFileInfos(): WorkbenchFileInfo[] {
		const byKey = new Map<string, WorkbenchFileInfo>();
		for (const connection of this.liveConnections.values()) {
			if (connection.documentInfo) byKey.set(connection.documentInfo.logicalUriKey, connection.documentInfo);
		}
		for (const file of this.collectOpenWorkbenchFiles().openFiles) {
			const info = classifyWorkbenchUriString(file.logicalUri, { includeOptionalPlainText: true });
			if (info) byKey.set(info.logicalUriKey, info);
		}
		for (const info of this.renamedWorkbenchFiles.values()) byKey.set(info.logicalUriKey, info);
		return [...byKey.values()];
	}

	private descendantRenameUri(candidate: vscode.Uri, oldRoot: vscode.Uri, newRoot: vscode.Uri): vscode.Uri | undefined {
		if (candidate.scheme !== oldRoot.scheme || candidate.authority !== oldRoot.authority) return undefined;
		const normalize = (value: string) => {
			const pathValue = value.replace(/\\/g, '/').replace(/\/+$/, '');
			return process.platform === 'win32' && candidate.scheme === 'file' ? pathValue.toLowerCase() : pathValue;
		};
		const candidatePath = normalize(candidate.path);
		const oldPath = normalize(oldRoot.path);
		if (!oldPath || !candidatePath.startsWith(`${oldPath}/`)) return undefined;
		const suffix = candidate.path.replace(/\\/g, '/').slice(oldRoot.path.replace(/\\/g, '/').replace(/\/+$/, '').length);
		const newPath = `${newRoot.path.replace(/\\/g, '/').replace(/\/+$/, '')}${suffix}`;
		return newRoot.with({ path: newPath });
	}

	private expandWorkbenchRenameFiles(
		files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[],
	): Array<{ rootKey: string; oldUri: vscode.Uri; newUri: vscode.Uri }> {
		const expanded = new Map<string, { rootKey: string; oldUri: vscode.Uri; newUri: vscode.Uri }>();
		const tracked = this.trackedWorkbenchFileInfos();
		for (const file of files) {
			const rootKey = this.backgroundRenameKey(file.oldUri, file.newUri);
			const oldInfo = classifyWorkbenchUri(file.oldUri, { includeOptionalPlainText: true });
			const newInfo = classifyWorkbenchUri(file.newUri, { includeOptionalPlainText: true });
			if (oldInfo && newInfo) {
				expanded.set(rootKey, { rootKey, oldUri: file.oldUri, newUri: file.newUri });
				continue;
			}
			for (const info of tracked) {
				const newUri = this.descendantRenameUri(info.logicalUri, file.oldUri, file.newUri);
				if (!newUri || !classifyWorkbenchUri(newUri, { includeOptionalPlainText: true })) continue;
				const pairKey = `${rootKey}\n${info.logicalUri.toString()}\n${newUri.toString()}`;
				expanded.set(pairKey, { rootKey, oldUri: info.logicalUri, newUri });
			}
		}
		return [...expanded.values()];
	}

	private async workspaceUriExists(uri: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(uri);
			return true;
		} catch (error) {
			if (this.isWorkspaceFileNotFound(error)) return false;
			throw error;
		}
	}

	private schedulePreparedRenameCancellationProbe(key: string, oldUri: vscode.Uri, newUri: vscode.Uri): void {
		const prepared = this.preparedBackgroundRenames.get(key);
		if (!prepared || prepared.cleanupTimer) return;
		prepared.cleanupTimer = setTimeout(() => {
			void (async () => {
				const current = this.preparedBackgroundRenames.get(key);
				if (!current) return;
				try {
					const [oldExists, newExists] = await Promise.all([
						this.workspaceUriExists(oldUri),
						this.workspaceUriExists(newUri),
					]);
					if (oldExists && !newExists) {
						this.clearPreparedBackgroundRename(key);
						return;
					}
				} catch {
					// Keep the fence when cancellation cannot be proven.
				}
				current.cleanupTimer = undefined;
				this.schedulePreparedRenameCancellationProbe(key, oldUri, newUri);
			})().catch(() => undefined);
		}, 30_000);
	}

	private clearPreparedBackgroundRename(key: string): void {
		const prepared = this.preparedBackgroundRenames.get(key);
		if (!prepared) return;
		this.preparedBackgroundRenames.delete(key);
		if (prepared.cleanupTimer) clearTimeout(prepared.cleanupTimer);
		for (const logicalUriKey of prepared.logicalUriKeys) {
			this.removeBackgroundMutationBlock(logicalUriKey);
		}
	}

	private remapRenamedWorkbenchFiles(
		files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[],
	): Array<{ oldUri: vscode.Uri; newUri: vscode.Uri; oldLogicalUriKey: string; newLogicalUriKey: string }> {
		const remapped: Array<{
			oldUri: vscode.Uri;
			newUri: vscode.Uri;
			oldLogicalUriKey: string;
			newLogicalUriKey: string;
		}> = [];
		for (const file of files) {
			const oldInfo = classifyWorkbenchUri(file.oldUri, { includeOptionalPlainText: true });
			const newInfo = classifyWorkbenchUri(file.newUri, { includeOptionalPlainText: true });
			if (!oldInfo || !newInfo) {
				continue;
			}
			const previousInfo = this.resolveRenamedWorkbenchFileInfo(oldInfo);
			const previousKeys = new Set([oldInfo.logicalUriKey, previousInfo.logicalUriKey]);
			let wasHostOwned = false;
			let wasOpening = false;
			let wasProgrammaticallySelected = false;
			let mutationBlockCount = 0;
			for (const key of previousKeys) {
				wasHostOwned = this.hostOwnedBackgroundFiles.delete(key) || wasHostOwned;
				wasOpening = this.backgroundOpeningFiles.has(key) || wasOpening;
				wasProgrammaticallySelected = this.backgroundProgrammaticSelections.delete(key) || wasProgrammaticallySelected;
				this.clearBackgroundOpeningLease(key);
				mutationBlockCount += this.backgroundMutationBlocks.get(key) ?? 0;
				this.backgroundMutationBlocks.delete(key);
			}
			if (wasHostOwned) this.hostOwnedBackgroundFiles.set(newInfo.logicalUriKey, undefined);
			if (wasHostOwned && wasProgrammaticallySelected) {
				this.backgroundProgrammaticSelections.add(newInfo.logicalUriKey);
			}
			if (wasOpening) {
				this.backgroundOpeningFiles.add(newInfo.logicalUriKey);
				this.scheduleBackgroundOpeningLeaseRelease(newInfo.logicalUriKey);
			}
			if (mutationBlockCount > 0) {
				this.backgroundMutationBlocks.set(
					newInfo.logicalUriKey,
					(this.backgroundMutationBlocks.get(newInfo.logicalUriKey) ?? 0) + mutationBlockCount,
				);
			}
			this.renamedWorkbenchFiles.set(oldInfo.logicalUriKey, newInfo);
			if (previousInfo.logicalUriKey !== oldInfo.logicalUriKey) {
				this.renamedWorkbenchFiles.set(previousInfo.logicalUriKey, newInfo);
			}
			for (const [aliasKey, aliasTarget] of [...this.renamedWorkbenchFiles]) {
				if (aliasKey === newInfo.logicalUriKey) continue;
				const resolvedTarget = this.resolveRenamedWorkbenchFileInfo(aliasTarget);
				if (aliasTarget.logicalUriKey === previousInfo.logicalUriKey
					|| aliasTarget.logicalUriKey === oldInfo.logicalUriKey
					|| resolvedTarget.logicalUriKey === previousInfo.logicalUriKey
					|| resolvedTarget.logicalUriKey === oldInfo.logicalUriKey) {
					this.renamedWorkbenchFiles.set(aliasKey, newInfo);
				}
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
			remapped.push({
				oldUri: file.oldUri,
				newUri: file.newUri,
				oldLogicalUriKey: oldInfo.logicalUriKey,
				newLogicalUriKey: newInfo.logicalUriKey,
			});
		}
		return remapped;
	}

	async prepareFilesRename(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
		const backgroundKeys = new Set<string>();
		const pendingResponseKeys = new Set<string>();
		const expanded = this.expandWorkbenchRenameFiles(files);
		for (const file of files) {
			this.clearPreparedBackgroundRename(this.backgroundRenameKey(file.oldUri, file.newUri));
		}
		for (const file of expanded) {
			const oldInfo = classifyWorkbenchUri(file.oldUri, { includeOptionalPlainText: true });
			const newInfo = classifyWorkbenchUri(file.newUri, { includeOptionalPlainText: true });
			if (!oldInfo || !newInfo) continue;
			const currentInfo = this.resolveRenamedWorkbenchFileInfo(oldInfo);
			pendingResponseKeys.add(oldInfo.logicalUriKey);
			pendingResponseKeys.add(currentInfo.logicalUriKey);
			const ownedKeys = [oldInfo.logicalUriKey, currentInfo.logicalUriKey]
				.filter((key, index, keys) => keys.indexOf(key) === index && this.hostOwnedBackgroundFiles.has(key));
			if (ownedKeys.length > 0) {
				const renameKey = file.rootKey;
				for (const key of ownedKeys) {
					if (!backgroundKeys.has(key)) {
						backgroundKeys.add(key);
						this.addBackgroundMutationBlock(key);
					}
				}
				const rootFiles = expanded
					.filter(candidate => candidate.rootKey === renameKey)
					.map(candidate => ({ oldUri: candidate.oldUri, newUri: candidate.newUri }));
				const existing = this.preparedBackgroundRenames.get(renameKey);
				this.preparedBackgroundRenames.set(renameKey, {
					logicalUriKeys: [...new Set([...(existing?.logicalUriKeys ?? []), ...ownedKeys])],
					files: rootFiles,
					blockMoves: [
						...(existing?.blockMoves ?? []),
						...ownedKeys.map(oldLogicalUriKey => ({ oldLogicalUriKey, newLogicalUriKey: newInfo.logicalUriKey })),
					],
				});
			}
		}
		await Promise.all([...backgroundKeys].map(key => this.waitForBackgroundFileOperation(key)));
		await this.waitForPendingResponses(pendingResponseKeys);
		for (const file of files) {
			const renameKey = this.backgroundRenameKey(file.oldUri, file.newUri);
			const prepared = this.preparedBackgroundRenames.get(renameKey);
			if (!prepared) continue;
			this.schedulePreparedRenameCancellationProbe(renameKey, file.oldUri, file.newUri);
		}
	}

	async handleFilesRenamed(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
		const immediateTabClosures: Array<{ oldUri: vscode.Uri; newUri: vscode.Uri }> = [];
		const preparedRenames = files.map(file => {
			const key = this.backgroundRenameKey(file.oldUri, file.newUri);
			return { key, prepared: this.preparedBackgroundRenames.get(key) };
		});
		for (const { prepared } of preparedRenames) {
			if (prepared?.cleanupTimer) clearTimeout(prepared.cleanupTimer);
		}
		const effectiveFiles = preparedRenames.flatMap(({ prepared }, index) =>
			prepared?.files ?? this.expandWorkbenchRenameFiles([files[index]]).map(file => ({ oldUri: file.oldUri, newUri: file.newUri }))
		);
		const remapped = this.remapRenamedWorkbenchFiles(effectiveFiles);
		try {
			for (const file of remapped) {
				if (this.hasPendingResponseForLogicalUriKey(file.newLogicalUriKey)) {
					this.deferredRenamedTabClosures.set(file.oldLogicalUriKey, {
						oldUri: file.oldUri,
						newUri: file.newUri,
						newLogicalUriKey: file.newLogicalUriKey,
					});
				} else {
					immediateTabClosures.push({ oldUri: file.oldUri, newUri: file.newUri });
				}
			}
			await this.closeRenamedWorkbenchTabs(immediateTabClosures);
		} finally {
			for (let index = 0; index < preparedRenames.length; index++) {
				const { key, prepared } = preparedRenames[index];
				this.preparedBackgroundRenames.delete(key);
				if (!prepared) continue;
				for (const move of prepared.blockMoves) {
					this.removeBackgroundMutationBlock(move.newLogicalUriKey);
				}
			}
		}
	}

	async handleTabsClosed(tabs: readonly vscode.Tab[]): Promise<void> {
		const keys = new Set<string>();
		for (const tab of tabs) {
			const tabInput = this.getTabInputUri(tab.input);
			const info = tabInput ? classifyWorkbenchUri(tabInput.uri, {
				viewType: tabInput.viewType,
				includeOptionalPlainText: true,
			}) : undefined;
			if (info && this.hostOwnedBackgroundFiles.has(info.logicalUriKey)) keys.add(info.logicalUriKey);
		}
		for (const key of keys) this.addBackgroundMutationBlock(key);
		try {
			await Promise.all([...keys].map(key => this.waitForBackgroundFileOperation(key)));
			for (const key of keys) {
				this.hostOwnedBackgroundFiles.delete(key);
				this.backgroundProgrammaticSelections.delete(key);
				this.clearBackgroundOpeningLease(key);
			}
		} finally {
			for (const key of keys) this.removeBackgroundMutationBlock(key);
		}
	}

	async handleTabsActivated(tabs: readonly vscode.Tab[]): Promise<void> {
		const keys = new Set<string>();
		const activeGroup = vscode.window.tabGroups.activeTabGroup;
		if (!activeGroup?.isActive || !activeGroup.activeTab) return;
		const activeInput = this.getTabInputUri(activeGroup.activeTab.input);
		const activeFile = activeInput ? classifyWorkbenchUri(activeInput.uri, {
			viewType: activeInput.viewType, includeOptionalPlainText: true,
		}) : undefined;
		for (const key of this.backgroundProgrammaticSelections) {
			if (key !== activeFile?.logicalUriKey) this.backgroundProgrammaticSelections.delete(key);
		}
		for (const tab of tabs) {
			if (!tab.isActive || tab !== activeGroup.activeTab) continue;
			const tabInput = this.getTabInputUri(tab.input);
			const info = tabInput ? classifyWorkbenchUri(tabInput.uri, {
				viewType: tabInput.viewType,
				includeOptionalPlainText: true,
			}) : undefined;
			if (info
				&& this.hostOwnedBackgroundFiles.has(info.logicalUriKey)
				&& !this.backgroundOpeningFiles.has(info.logicalUriKey)
				&& !this.backgroundProgrammaticSelections.has(info.logicalUriKey)) keys.add(info.logicalUriKey);
		}
		for (const key of keys) this.addBackgroundMutationBlock(key);
		try {
			await Promise.all([...keys].map(key => this.waitForBackgroundFileOperation(key)));
			const currentGroup = vscode.window.tabGroups.activeTabGroup;
			const currentTab = currentGroup?.isActive ? currentGroup.activeTab : undefined;
			const currentInput = currentTab?.isActive ? this.getTabInputUri(currentTab.input) : undefined;
			const currentFile = currentInput ? classifyWorkbenchUri(currentInput.uri, {
				viewType: currentInput.viewType, includeOptionalPlainText: true,
			}) : undefined;
			for (const key of keys) {
				if (currentFile?.logicalUriKey !== key || this.backgroundProgrammaticSelections.has(key)) continue;
				this.hostOwnedBackgroundFiles.delete(key);
				this.clearBackgroundOpeningLease(key);
			}
		} finally {
			for (const key of keys) this.removeBackgroundMutationBlock(key);
		}
	}

	private hasPendingResponseForLogicalUriKey(logicalUriKey: string): boolean {
		for (const pending of this.pendingResponses.values()) {
			if (pending.waitForRename === true
				&& this.liveConnections.get(pending.connectionToken)?.logicalUriKey === logicalUriKey) return true;
		}
		return false;
	}

	private waitForPendingResponses(logicalUriKeys: ReadonlySet<string>): Promise<void> {
		if (![...logicalUriKeys].some(key => this.hasPendingResponseForLogicalUriKey(key))) {
			return Promise.resolve();
		}
		return new Promise(resolve => {
			this.pendingResponseDrainWaiters.add({ logicalUriKeys, resolve });
		});
	}

	private flushDeferredRenamedTabClosures(): void {
		const ready: Array<{ oldUri: vscode.Uri; newUri: vscode.Uri }> = [];
		for (const [oldLogicalUriKey, deferred] of this.deferredRenamedTabClosures) {
			if (this.hasPendingResponseForLogicalUriKey(deferred.newLogicalUriKey)) continue;
			this.deferredRenamedTabClosures.delete(oldLogicalUriKey);
			ready.push({ oldUri: deferred.oldUri, newUri: deferred.newUri });
		}
		if (ready.length > 0) void this.closeRenamedWorkbenchTabs(ready);
		for (const waiter of [...this.pendingResponseDrainWaiters]) {
			if ([...waiter.logicalUriKeys].some(key => this.hasPendingResponseForLogicalUriKey(key))) continue;
			this.pendingResponseDrainWaiters.delete(waiter);
			waiter.resolve();
		}
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
				connection: this.getToolConnectionForFile(explicitTarget),
			};
		}

		if (activeFile) {
			return {
				openFiles,
				activeFile,
				hasActiveUnsupportedFile,
				explicitTargetRequested,
				connection: this.getToolConnectionForFile(activeFile),
			};
		}
		return { openFiles, hasActiveUnsupportedFile, explicitTargetRequested, connection: hasActiveUnsupportedFile ? undefined : this.getLatestLiveConnection() };
	}

	private isRichWorkbenchFile(file: InternalOpenWorkbenchFileSummary): file is InternalOpenWorkbenchFileSummary & { fileKind: KqlxFileKind } {
		return file.fileKind === 'kqlx' || file.fileKind === 'mdx' || file.fileKind === 'sqlx';
	}

	private async prepareBackgroundLiveOperation(
		targetFields: TargetFields,
		cancellationToken?: vscode.CancellationToken,
	): Promise<{ connection?: LiveWorkbenchConnection; isCurrent?: () => boolean }> {
		const target = this.resolveToolTarget(targetFields);
		const file = target.explicitTarget;
		if (target.connection || !file || !this.hostOwnedBackgroundFiles.has(file.logicalUriKey)) return { connection: target.connection };
		const connection = this.getLatestLiveConnectionForKey(file.logicalUriKey);
		if (!connection) return {};
		if (cancellationToken?.isCancellationRequested) throw new vscode.CancellationError();
		const acquisition = this.acquireHostOwnedBackgroundLifecycle(file.logicalUriKey);
		let release: (() => void) | undefined;
		try {
			release = cancellationToken ? await raceCancellation(acquisition, cancellationToken) : await acquisition;
			const document = await this.getBackgroundDocument(file);
			const version = document.version;
			const source = document.getText();
			const waitForReady = connection.waitForReadReady ?? connection.waitForMutationReady;
			const readiness = waitForReady?.() ?? Promise.resolve(false);
			if (!await (cancellationToken ? raceCancellation(readiness, cancellationToken) : readiness)) {
				throw new Error('This document is still loading and cannot accept mutations yet.');
			}
			if (cancellationToken?.isCancellationRequested) throw new vscode.CancellationError();
			const admission = connection.captureStateAdmission?.();
			const isCurrent = () => this.liveConnections.get(connection.token) === connection
				&& connection.logicalUriKey === file.logicalUriKey
				&& document.version === version && document.getText() === source
				&& admission?.() !== false;
			if (!isCurrent()) {
				throw new Error('The targeted Workbench editor changed before background ownership could transfer.');
			}
			this.hostOwnedBackgroundFiles.delete(file.logicalUriKey);
			this.backgroundProgrammaticSelections.delete(file.logicalUriKey);
			this.clearBackgroundOpeningLease(file.logicalUriKey);
			return { connection, isCurrent };
		} catch (error) {
			if (!release) void acquisition.then(complete => complete?.(), () => undefined);
			throw error;
		} finally {
			release?.();
		}
	}

	private async getBackgroundDocument(file: InternalOpenWorkbenchFileSummary): Promise<vscode.TextDocument> {
		const existing = vscode.workspace.textDocuments.find(document =>
			classifyWorkbenchUri(document.uri, { includeOptionalPlainText: true })?.openFileId === file.openFileId
		);
		return existing ?? vscode.workspace.openTextDocument(vscode.Uri.parse(file.logicalUri));
	}

	private parseBackgroundFile(file: InternalOpenWorkbenchFileSummary, document: vscode.TextDocument): KqlxFileV1 {
		if (!this.isRichWorkbenchFile(file)) {
			throw new Error(`Background section changes are not supported for ${file.fileKind} files.`);
		}
		const parsed = parseKqlxText(document.getText(), {
			allowedKinds: [file.fileKind],
			defaultKind: file.fileKind,
		});
		if (!parsed.ok) throw new Error(parsed.error);
		return parsed.file;
	}

	private sectionId(section: KqlxSectionV1, index: number): string {
		return typeof section.id === 'string' && section.id.trim() ? section.id.trim() : `section_${index}`;
	}

	private findBackgroundSection(file: KqlxFileV1, sectionId: string): KqlxSectionV1 | undefined {
		const index = file.state.sections.findIndex((section, sectionIndex) =>
			this.sectionId(section, sectionIndex) === sectionId
		);
		return index < 0 ? undefined : file.state.sections[index];
	}

	private setBackgroundSectionField(section: KqlxSectionV1, key: string, value: unknown): boolean {
		if (value === undefined) return false;
		const record = section as Record<string, unknown>;
		if (isDeepStrictEqual(record[key], value)) return false;
		record[key] = value;
		return true;
	}

	private stabilizeBackgroundSectionId(section: KqlxSectionV1, sectionId: string, changed: boolean): void {
		if (changed && !section.id) section.id = sectionId;
	}

	private async runBackgroundFileOperation<T>(logicalUriKey: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.backgroundFileOperations.get(logicalUriKey) ?? Promise.resolve();
		const result = previous.catch(() => undefined).then(operation);
		const completion = result.then(() => undefined, () => undefined);
		this.backgroundFileOperations.set(logicalUriKey, completion);
		try {
			return await result;
		} finally {
			if (this.backgroundFileOperations.get(logicalUriKey) === completion) {
				this.backgroundFileOperations.delete(logicalUriKey);
			}
		}
	}

	private async waitForBackgroundFileOperation(logicalUriKey: string): Promise<void> {
		await this.backgroundFileOperations.get(logicalUriKey)?.catch(() => undefined);
	}

	private addBackgroundMutationBlock(logicalUriKey: string): void {
		this.backgroundMutationBlocks.set(
			logicalUriKey,
			(this.backgroundMutationBlocks.get(logicalUriKey) ?? 0) + 1,
		);
	}

	private removeBackgroundMutationBlock(logicalUriKey: string): void {
		const next = (this.backgroundMutationBlocks.get(logicalUriKey) ?? 0) - 1;
		if (next > 0) this.backgroundMutationBlocks.set(logicalUriKey, next);
		else this.backgroundMutationBlocks.delete(logicalUriKey);
	}

	private clearBackgroundOpeningLease(logicalUriKey: string): void {
		this.backgroundOpeningFiles.delete(logicalUriKey);
		const timer = this.backgroundOpeningTimers.get(logicalUriKey);
		if (timer) clearTimeout(timer);
		this.backgroundOpeningTimers.delete(logicalUriKey);
	}

	private scheduleBackgroundOpeningLeaseRelease(logicalUriKey: string): void {
		const existing = this.backgroundOpeningTimers.get(logicalUriKey);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.backgroundOpeningFiles.delete(logicalUriKey);
			this.backgroundOpeningTimers.delete(logicalUriKey);
		}, 250);
		this.backgroundOpeningTimers.set(logicalUriKey, timer);
	}

	private async acquireHostOwnedBackgroundLifecycle(logicalUriKey: string): Promise<(() => void) | undefined> {
		if (!this.hostOwnedBackgroundFiles.has(logicalUriKey)) return undefined;
		if ((this.backgroundMutationBlocks.get(logicalUriKey) ?? 0) > 0) {
			throw new Error('The targeted background Workbench file is already changing lifecycle state.');
		}
		this.addBackgroundMutationBlock(logicalUriKey);
		const previous = this.backgroundFileOperations.get(logicalUriKey) ?? Promise.resolve();
		let releaseGate!: () => void;
		const gate = new Promise<void>(resolve => { releaseGate = resolve; });
		const tail = previous.catch(() => undefined).then(() => gate);
		this.backgroundFileOperations.set(logicalUriKey, tail);
		await previous.catch(() => undefined);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.removeBackgroundMutationBlock(logicalUriKey);
			releaseGate();
			void tail.finally(() => {
				if (this.backgroundFileOperations.get(logicalUriKey) === tail) {
					this.backgroundFileOperations.delete(logicalUriKey);
				}
			}).catch(() => undefined);
		};
	}

	private async mutateBackgroundFile<T>(
		target: ReturnType<KustoWorkbenchToolOrchestrator['resolveToolTarget']>,
		mutation: (file: KqlxFileV1) => { result: T; changed: boolean },
	): Promise<T | undefined> {
		const file = target.explicitTarget;
		if (target.connection || !file || !this.isRichWorkbenchFile(file)
			|| !target.openFiles.some(openFile => openFile.openFileId === file.openFileId)) {
			return undefined;
		}
		const key = file.logicalUriKey;
		if ((this.backgroundMutationBlocks.get(key) ?? 0) > 0) {
			throw new Error('The targeted background Workbench file is changing lifecycle state. Retry after the current activation, rename, or close completes.');
		}
		return this.runBackgroundFileOperation<T | undefined>(key, async () => {
			if (this.getLatestLiveConnectionForKey(file.logicalUriKey)
				&& !this.hostOwnedBackgroundFiles.has(file.logicalUriKey)) return undefined;
			const document = await this.getBackgroundDocument(file);
			let result: T | undefined;
			await withKqlxDocumentWriteLock(document.uri, async () => {
				if (this.getLatestLiveConnectionForKey(file.logicalUriKey)
					&& !this.hostOwnedBackgroundFiles.has(file.logicalUriKey)) return;
				const parsed = this.parseBackgroundFile(file, document);
				const mutationResult = mutation(parsed);
				result = mutationResult.result;
				if (!mutationResult.changed) return;
				const serialized = stringifyKqlxFile(parsed);
				const validation = parseKqlxText(serialized, {
					allowedKinds: [file.fileKind],
					defaultKind: file.fileKind,
				});
				if (!validation.ok) throw new Error(validation.error);
				const edit = new vscode.WorkspaceEdit();
				edit.replace(
					document.uri,
					new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
					serialized,
				);
				if (!await vscode.workspace.applyEdit(edit)) {
					throw new Error('VS Code declined the background Workbench document edit.');
				}
			});
			return result;
		});
	}

	private createBackgroundSection(file: KqlxFileV1, input: AddSectionInput, sectionId: string): KqlxSectionV1 | undefined {
		const sectionType = canonicalAddableSectionKind(file.kind, input.type);
		if (!sectionType) return undefined;
		const base = { id: sectionId, type: sectionType, expanded: true };
		switch (sectionType) {
			case 'query':
				return {
					...base,
					...(input.name ? { name: input.name } : {}),
					...(input.query !== undefined ? { query: input.query } : {}),
					...(input.clusterUrl !== undefined ? { clusterUrl: input.clusterUrl } : {}),
					...(input.connectionId !== undefined ? { connectionIdHint: input.connectionId } : {}),
					...(input.database !== undefined ? { database: input.database } : {}),
				};
			case 'sql':
				return {
					...base,
					...(input.name ? { name: input.name } : {}),
					...(input.query !== undefined ? { query: input.query } : {}),
				};
			case 'markdown':
				return {
					...base,
					...(input.name ? { title: input.name } : {}),
					...(input.text !== undefined ? { text: input.text } : {}),
				};
			case 'chart':
				return {
					...base,
					...(input.name ? { name: input.name } : {}),
					...(input.dataSourceId !== undefined ? { dataSourceId: input.dataSourceId } : {}),
					...(input.dataSourceResultIndex !== undefined ? { dataSourceResultIndex: input.dataSourceResultIndex } : {}),
					...(input.chartType !== undefined ? { chartType: input.chartType } : {}),
				};
			case 'transformation':
				return {
					...base,
					...(input.name ? { name: input.name } : {}),
					...(input.dataSourceId !== undefined ? { dataSourceId: input.dataSourceId } : {}),
					...(input.dataSourceResultIndex !== undefined ? { dataSourceResultIndex: input.dataSourceResultIndex } : {}),
				};
			case 'python':
				return { ...base, ...(input.name ? { name: input.name } : {}), ...(input.code !== undefined ? { code: input.code } : {}) };
			case 'url':
				return { ...base, ...(input.name ? { name: input.name } : {}), ...(input.url !== undefined ? { url: input.url } : {}) };
			case 'html':
				return { ...base, ...(input.name ? { name: input.name } : {}), ...(input.code !== undefined ? { code: input.code } : {}) };
		}
	}

	private async getBackgroundSections(file: InternalOpenWorkbenchFileSummary): Promise<ToolSectionSummary[] | undefined> {
		if (!this.isRichWorkbenchFile(file)) return undefined;
		await this.waitForBackgroundFileOperation(file.logicalUriKey);
		const document = await this.getBackgroundDocument(file);
		const parsed = this.parseBackgroundFile(file, document);
		const rawSections = parsed.state.sections.map((section, index) => ({
			...section,
			id: this.sectionId(section, index),
		})) as ToolSection[];
		const sectionTypeById = new Map(rawSections.map(section => [
			String(section.id || '').trim(),
			String(section.type || ''),
		]));
		const hasSqlOwner = rawSections.some(section => {
			if (String(section.type || '') === 'sql') return true;
			const sourceBoxId = String((section as Record<string, unknown>).comparisonSourceBoxId || '').trim();
			return !!sourceBoxId && sectionTypeById.get(sourceBoxId) === 'sql';
		});
		const protectedIds = hasSqlOwner ? await this.getProtectedSqlConnectionIds() : new Set<string>();
		return rawSections
			.filter(section => {
				const record = section as Record<string, unknown>;
				const comparisonSourceBoxId = String(record.comparisonSourceBoxId || '').trim();
				if (String(section.type || '') !== 'sql'
					&& (!comparisonSourceBoxId || sectionTypeById.get(comparisonSourceBoxId) !== 'sql')) return true;
				const connectionId = String(record.connectionIdHint || '').trim();
				return !!connectionId && !protectedIds.has(connectionId);
			})
			.map((section, index) => this.summarizeToolSection(section, index));
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

	handleDevelopmentNoteMutationResponse(message: unknown): boolean {
		return this.handleDevelopmentNoteMutationResponseAdmission(
			admitDevelopmentNoteMutationWebviewMessage(message),
		);
	}

	handleDevelopmentNoteMutationResponseAdmission(
		admission: DevelopmentNoteMutationWebviewAdmission,
	): boolean {
		if (!admission.recognized || !admission.requestId
			|| !this.developmentNoteMutationRequestIds.has(admission.requestId)) return false;
		if (!admission.parsed.ok) return true;
		const response = admission.parsed.value;
		this.settleWebviewResponse(response.requestId, response.result, response.error, true);
		return true;
	}

	hasPendingDevelopmentNoteMutationResponse(): boolean {
		return this.developmentNoteMutationRequestIds.size > 0;
	}

	handleWebviewResponse(requestId: string, result: unknown, error?: string): void {
		this.settleWebviewResponse(requestId, result, error, false);
	}

	private settleWebviewResponse(
		requestId: string,
		result: unknown,
		error: string | undefined,
		allowDevelopmentNoteMutation: boolean,
	): void {
		if (!allowDevelopmentNoteMutation && this.developmentNoteMutationRequestIds.has(requestId)) return;
		const pending = this.pendingResponses.get(requestId);
		if (!pending) return;
		if (!error && pending.admitResult) {
			const admission = pending.admitResult(result);
			if (!admission.ok) return;
			result = admission.value;
		}
		this.pendingResponses.delete(requestId);
		this.developmentNoteMutationRequestIds.delete(requestId);
		pending.controller.abort();
		this.flushDeferredRenamedTabClosures();
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
		admitResult?: (result: unknown) => ToolResponseAdmission<T>,
		isCurrent?: () => boolean,
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
		const readiness = type === 'toolGetHtmlDashboardContext' && target.connection.waitForReadReady
			? target.connection.waitForReadReady() : target.connection.waitForMutationReady?.();
		if (readiness && !await (cancellationToken ? raceCancellation(readiness, cancellationToken) : readiness)) {
			throw new Error('This document is still loading and cannot accept mutations yet.');
		}
		if (!this.liveConnections.has(target.connection.token)) {
			throw new Error('The targeted Kusto Workbench editor closed before the request was dispatched.');
		}
		if (cancellationToken?.isCancellationRequested) throw new vscode.CancellationError();
		if (isCurrent?.() === false) throw new Error('The targeted Workbench editor changed before the request was dispatched.');
		
		const requestId = `tool_${++this.responseSeq}_${Date.now()}`;
		const developmentNoteRequest = type === 'updateDevNotes'
			? createDevelopmentNoteMutationHostMessage(requestId, payload)
			: undefined;
		if (developmentNoteRequest && !developmentNoteRequest.ok) {
			throw new Error(developmentNoteRequest.error);
		}
		const outboundMessage = developmentNoteRequest?.ok
			? developmentNoteRequest.value
			: { type, requestId, ...payload };
		
		return new Promise<T>((resolve, reject) => {
			const controller = new AbortController();
			let pending!: {
				resolve: (value: unknown) => void; reject: (err: Error) => void;
				timer?: ReturnType<typeof setTimeout>; cancellationSubscription?: vscode.Disposable;
				controller: AbortController;
				connectionToken: number; kustoExecution?: KustoExecutionRequestIdentity;
				waitForRename?: boolean;
				admitResult?: (result: unknown) => ToolResponseAdmission<unknown>;
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
					this.developmentNoteMutationRequestIds.delete(requestId);
					pending.controller.abort();
					this.flushDeferredRenamedTabClosures();
					pending.cancellationSubscription?.dispose();
					try { cancelKustoExecution(); } catch { /* preserve timeout */ }
					try { onTimeout?.(target.connection!, requestId); } catch { /* preserve timeout */ }
					reject(new Error('Request timed out'));
				}, timeoutMs);
			pending = {
				resolve: resolve as (value: unknown) => void, 
				reject, 
				timer,
				controller,
				connectionToken: target.connection!.token,
				...(type === 'toolDelegateToKustoWorkbenchCopilot' ? { waitForRename: true } : {}),
				...(admitResult ? { admitResult: admitResult as (result: unknown) => ToolResponseAdmission<unknown> } : {}),
			};
			this.pendingResponses.set(requestId, pending);
			if (developmentNoteRequest) this.developmentNoteMutationRequestIds.add(requestId);
			const cancelPending = () => {
				if (this.pendingResponses.get(requestId) !== pending) return;
				this.pendingResponses.delete(requestId);
				this.developmentNoteMutationRequestIds.delete(requestId);
				pending.controller.abort();
				this.flushDeferredRenamedTabClosures();
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
				posted = isCurrent
					? target.connection!.poster(outboundMessage, controller.signal, isCurrent)
					: target.connection!.poster(outboundMessage, controller.signal);
			} catch (error) {
				this.pendingResponses.delete(requestId);
				this.developmentNoteMutationRequestIds.delete(requestId);
				pending.controller.abort();
				this.flushDeferredRenamedTabClosures();
				if (timer) clearTimeout(timer);
				pending.cancellationSubscription?.dispose();
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			void Promise.resolve(posted).then(delivered => {
				if (delivered === true || this.pendingResponses.get(requestId) !== pending) return;
				this.pendingResponses.delete(requestId);
				this.developmentNoteMutationRequestIds.delete(requestId);
				pending.controller.abort();
				this.flushDeferredRenamedTabClosures();
				if (timer) clearTimeout(timer);
				pending.cancellationSubscription?.dispose();
				reject(new Error('The targeted Kusto Workbench editor rejected the request.'));
			}, error => {
				if (this.pendingResponses.get(requestId) !== pending) return;
				this.pendingResponses.delete(requestId);
				this.developmentNoteMutationRequestIds.delete(requestId);
				pending.controller.abort();
				this.flushDeferredRenamedTabClosures();
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

	private async getSectionsForConnection(
		connection: LiveWorkbenchConnection,
		file?: InternalOpenWorkbenchFileSummary,
		registerAdmission?: (admission: () => boolean) => void,
	): Promise<ToolSectionSummary[] | undefined> {
		if (this.liveConnections.get(connection.token) !== connection) return undefined;
		const rawSections = await connection.stateGetter();
		if (!Array.isArray(rawSections) || this.liveConnections.get(connection.token) !== connection) return undefined;
		const snapshotAdmission = connection.captureStateAdmission?.() ?? (() => true);
		const sectionTypeById = new Map((rawSections ?? []).map(section => [String(section?.id || '').trim(), String(section?.type || '')]));
		const hasSqlOwner = (rawSections ?? []).some(section => {
			if (String(section?.type || '') === 'sql') return true;
			const sourceBoxId = String((section as any)?.comparisonSourceBoxId || '').trim();
			return !!sourceBoxId && sectionTypeById.get(sourceBoxId) === 'sql';
		});
		const protectedIds = hasSqlOwner ? await this.getProtectedSqlConnectionIds() : new Set<string>();
		if (this.liveConnections.get(connection.token) !== connection) return undefined;
		const seedHash = file?.fileKind === 'sqlx' ? this.hostOwnedBackgroundFiles.get(file.logicalUriKey) : undefined;
		const onlySection = rawSections.length === 1 ? rawSections[0] : undefined;
		if (file && seedHash && onlySection?.type === 'sql' && typeof onlySection.id === 'string' && onlySection.id.trim()
			&& !(onlySection as Record<string, unknown>).comparisonSourceBoxId && !connection.sqlConnectionResolver?.(onlySection.id)
			&& this.isHostOwnedBackgroundFile(vscode.Uri.parse(file.logicalUri))) {
			try {
				const id = onlySection.id;
				const ownerIsCurrent = () => this.liveConnections.get(connection.token) === connection
					&& this.isHostOwnedBackgroundFile(vscode.Uri.parse(file.logicalUri)) && this.hostOwnedBackgroundFiles.get(file.logicalUriKey) === seedHash
					&& !connection.sqlConnectionResolver?.(id) && snapshotAdmission();
				await this.waitForBackgroundFileOperation(file.logicalUriKey);
				if (!ownerIsCurrent()) return undefined;
				const document = await this.getBackgroundDocument(file);
				if (!ownerIsCurrent()) return undefined;
				const text = document.getText();
				const version = document.version;
				const isCurrent = () => ownerIsCurrent()
					&& vscode.workspace.textDocuments.includes(document) && document.version === version && document.getText() === text;
				if (!isCurrent()) return undefined;
				if (createHash('sha256').update(text, 'utf8').digest('hex') !== seedHash) return [];
				const originalSection = this.parseBackgroundFile(file, document).state.sections[0];
				if (originalSection?.type !== 'sql' || originalSection.query !== onlySection.query) return [];
				registerAdmission?.(isCurrent);
				return [{ id, type: 'sql' }];
			} catch { return undefined; }
		}
		if (this.liveConnections.get(connection.token) !== connection) return undefined;
		return rawSections
			?.filter(section => {
				const sectionId = String(section?.id || '').trim();
				const connectionId = connection.sqlConnectionResolver?.(sectionId);
				const comparisonSourceBoxId = String((section as any)?.comparisonSourceBoxId || '').trim();
				if (String(section?.type || '') === 'sql' || (comparisonSourceBoxId && sectionTypeById.get(comparisonSourceBoxId) === 'sql')) {
					return connectionId ? !protectedIds.has(connectionId) : false;
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
		const connectionsByOpenFileId = new Map<string, LiveWorkbenchConnection>();
		const structuralAdmissions = new Map<string, () => boolean>();
		await Promise.all(openFiles.map(async (file) => {
			const internal = target.openFiles.find(openFile => openFile.openFileId === file.openFileId);
			const connection = internal ? this.getLatestLiveConnectionForKey(internal.logicalUriKey) : undefined;
			if (!connection) {
				file.isLiveWorkbench = false;
				file.isReadOnlyFallback = true;
				if (internal) {
					try {
						const sections = await this.getBackgroundSections(internal);
						if (sections) {
							file.sections = sections;
							sectionsByOpenFileId.set(file.openFileId, sections);
						}
					} catch (error) {
						file.sectionsUnavailable = true;
						file.error = error instanceof Error ? error.message : String(error);
					}
				}
				return;
			}
			connectionsByOpenFileId.set(file.openFileId, connection);
			try {
				const liveSections = await this.getSectionsForConnection(connection, internal, admission => structuralAdmissions.set(file.openFileId, admission));
				file.isLiveWorkbench = liveSections !== undefined;
				file.isReadOnlyFallback = false;
				if (liveSections === undefined) {
					file.sectionsUnavailable = true;
					file.error = 'The targeted Kusto Workbench editor could not provide a current live section snapshot.';
				}
				const sections = liveSections ?? (internal ? await this.getBackgroundSections(internal) : undefined);
				if (sections) {
					file.sections = sections;
					sectionsByOpenFileId.set(file.openFileId, sections);
				} else {
					file.sectionsUnavailable = true;
					file.error = 'Sections are unavailable for this open file.';
				}
			} catch (error) {
				file.isLiveWorkbench = false;
				file.isReadOnlyFallback = false;
				file.sectionsUnavailable = true;
				const message = error instanceof Error ? error.message : String(error);
				file.error = message.trim() ? message : 'The targeted Kusto Workbench editor could not provide a current live section snapshot.';
			}
		}));
		const targetOpenFileId = target.explicitTarget?.openFileId ?? target.activeFile?.openFileId ?? target.connection?.documentInfo?.openFileId;
		const targetSections = target.connection && !targetOpenFileId ? await this.getSectionsForConnection(target.connection) : undefined;
		for (const file of openFiles) {
			const connection = connectionsByOpenFileId.get(file.openFileId);
			const structuralAdmission = structuralAdmissions.get(file.openFileId);
			if (structuralAdmission) {
				let current = false;
				try { current = structuralAdmission(); } catch {}
				if (!current) {
					file.isLiveWorkbench = false;
					file.sectionsUnavailable = true;
					file.error = 'The targeted Kusto Workbench editor changed while collecting its live section snapshot.';
					delete file.sections;
					sectionsByOpenFileId.delete(file.openFileId);
				}
			}
			if (!connection || this.liveConnections.get(connection.token) === connection) continue;
			file.isLiveWorkbench = false;
			file.isReadOnlyFallback = false;
			file.sectionsUnavailable = true;
			file.error = 'The targeted Kusto Workbench editor closed while collecting its live section snapshot.';
			delete file.sections;
			sectionsByOpenFileId.delete(file.openFileId);
		}
		if (!target.connection || this.liveConnections.get(target.connection.token) !== target.connection) {
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
		const sections = targetOpenFileId ? sectionsByOpenFileId.get(targetOpenFileId) : targetSections;
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
		const connection = target.connection;
		if (!connection || this.liveConnections.get(connection.token) !== connection) {
			throw new Error('The targeted Kusto Workbench editor is not available for reading development notes.');
		}
		const rawSections = await connection.stateGetter();
		if (this.liveConnections.get(connection.token) !== connection) {
			throw new Error('The targeted Kusto Workbench editor closed while reading development notes.');
		}
		if (!Array.isArray(rawSections)) {
			throw new Error('The targeted Kusto Workbench editor could not provide its development-note snapshot.');
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
			try {
				const notes = await this.getDevNotes(target);
				return { success: true, notes };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					success: false,
					error: message.trim() ? message : 'The targeted Kusto Workbench editor could not provide its development-note snapshot.',
				};
			}
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
			const mutation: DevelopmentNoteMutationPayload = input.supersedes
				? { action: 'supersede', entry, supersededId: input.supersedes }
				: { action: 'add', entry };
			return this.sendToWebview('updateDevNotes', mutation, 30000, target);
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
		cancellationToken?: vscode.CancellationToken,
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
		if (!connectionId || !database) throw new Error('SQL section owner is not ready.');
		if (!capturedConnection.sqlOwnerResolver) {
			if (!ownerToken) throw new Error('SQL section owner is not ready.');
			return { sectionId: resolvedSectionId, connectionId, database, ownerToken };
		}
		const validateOwner = (liveOwner: NonNullable<ReturnType<NonNullable<LiveWorkbenchConnection['sqlOwnerResolver']>>>) => {
			if (liveOwner.connectionId !== connectionId || liveOwner.database !== database
				|| (ownerToken && liveOwner.ownerToken !== ownerToken)) {
				throw new Error('SQL section owner changed during tool preflight.');
			}
			return {
				sectionId: resolvedSectionId,
				connectionId: liveOwner.connectionId,
				database: liveOwner.database,
				ownerToken: liveOwner.ownerToken,
				generation: liveOwner.generation,
			};
		};
		const currentOwner = capturedConnection.sqlOwnerResolver(resolvedSectionId);
		if (currentOwner) return validateOwner(currentOwner);
		if (ownerToken) throw new Error('SQL section owner disappeared during tool preflight.');

		const deadline = Date.now() + KustoWorkbenchToolOrchestrator.SQL_TOOL_OWNER_READY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (cancellationToken?.isCancellationRequested) throw new vscode.CancellationError();
			if (!this.liveConnections.has(capturedConnection.token)) {
				throw new Error('The targeted Kusto Workbench editor closed during SQL tool preflight.');
			}
			if (capturedConnection.sqlConnectionResolver?.(resolvedSectionId) !== connectionId) {
				throw new Error('SQL section connection changed during tool preflight.');
			}
			const readyOwner = capturedConnection.sqlOwnerResolver(resolvedSectionId);
			if (readyOwner) {
				const latestSections = await capturedConnection.stateGetter();
				const latestSection = (Array.isArray(latestSections) ? latestSections : [])
					.find(candidate => candidate?.type === 'sql' && String(candidate.id || '') === resolvedSectionId);
				if (!latestSection) throw new Error('SQL section disappeared during tool preflight.');
				const latestConnectionId = String((latestSection as any).connectionId
					|| capturedConnection.sqlConnectionResolver?.(resolvedSectionId) || '').trim();
				const latestDatabase = String((latestSection as any).database || '').trim();
				const latestOwnerToken = String((latestSection as any).ownerToken || '').trim();
				if (latestConnectionId !== connectionId || latestDatabase !== database
					|| (latestOwnerToken && latestOwnerToken !== readyOwner.ownerToken)) {
					throw new Error('SQL section owner changed during tool preflight.');
				}
				return validateOwner(readyOwner);
			}
			const delay = new Promise<void>(resolve => setTimeout(resolve, KustoWorkbenchToolOrchestrator.SQL_TOOL_OWNER_READY_POLL_MS));
			await (cancellationToken ? raceCancellation(delay, cancellationToken) : delay);
		}
		throw new Error('SQL section owner did not become ready before tool preflight timed out.');
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
		if (input.query !== undefined) input = { ...input, query: unescapeLLMText(input.query) };
		const resolvedTarget = this.resolveToolTarget(target);
		let operationCurrent: (() => boolean) | undefined;
		if (!resolvedTarget.connection && input.execute) {
			const operation = await this.prepareBackgroundLiveOperation(target, cancellationToken);
			resolvedTarget.connection = operation.connection;
			operationCurrent = operation.isCurrent;
		}
		const capturedConnection = resolvedTarget.connection;
		if (!capturedConnection || !this.liveConnections.has(capturedConnection.token)) {
			if (input.execute) {
				throw new Error('Background SQL execution requires a live Workbench editor.');
			}
			const backgroundTarget = resolvedTarget.explicitTarget;
			if (!backgroundTarget || !this.hostOwnedBackgroundFiles.has(backgroundTarget.logicalUriKey)) {
				throw new Error('Kusto Workbench is not currently open with a live editor for SQL configuration.');
			}
			if (cancellationToken?.isCancellationRequested) throw new vscode.CancellationError();
			let aliasRequired = false;
			let structuralAdmission: (() => boolean) | undefined;
			const document = vscode.workspace.textDocuments.find(candidate =>
				classifyWorkbenchUri(candidate.uri, { includeOptionalPlainText: true })?.openFileId === backgroundTarget.openFileId);
			if (document && backgroundTarget.fileKind === 'sqlx'
				&& !this.findBackgroundSection(this.parseBackgroundFile(backgroundTarget, document), input.sectionId)) {
				aliasRequired = true;
				const source = document.getText();
				const version = document.version;
				const seedHash = this.hostOwnedBackgroundFiles.get(backgroundTarget.logicalUriKey);
				const connection = this.getLatestLiveConnectionForKey(backgroundTarget.logicalUriKey);
				const runtimeAdmission = connection?.captureStateAdmission?.();
				if (!seedHash || !connection || !runtimeAdmission || !this.isHostOwnedBackgroundFile(document.uri)
					|| createHash('sha256').update(source, 'utf8').digest('hex') !== seedHash) return { success: false };
				const sections = await this.getSectionsForConnection(connection, backgroundTarget, admission => { structuralAdmission = admission; });
				if (cancellationToken?.isCancellationRequested) throw new vscode.CancellationError();
				const proof = structuralAdmission;
				if (!proof || !isDeepStrictEqual(sections, [{ id: input.sectionId, type: 'sql' }])) return { success: false };
				structuralAdmission = () => !document.isClosed && vscode.workspace.textDocuments.includes(document)
					&& document.version === version && document.getText() === source
					&& connection.logicalUriKey === backgroundTarget.logicalUriKey && runtimeAdmission() && proof();
				if (!structuralAdmission()) return { success: false };
			}
			let requestedConnection: ReturnType<SqlConnectionManager['getConnection']>;
			if (input.connectionId) {
				requestedConnection = this.getSqlConnectionManager().getConnection(String(input.connectionId));
				if (!requestedConnection) {
					throw new Error(`SQL connection "${input.connectionId}" was not found. Use list-sql-connections first.`);
				}
			} else if (input.serverUrl) {
				const matching = this.getSqlConnectionManager().getConnections().filter(connection =>
					String(connection.serverUrl || '').trim().toLowerCase().includes(String(input.serverUrl || '').trim().toLowerCase()),
				);
				if (matching.length !== 1) {
					throw new Error('SQL server target is missing or ambiguous. Pass connectionId from list-sql-connections.');
				}
				requestedConnection = matching[0];
			}
			let assertRequestedConnectionCurrent: (() => void) | undefined;
			if (requestedConnection) {
				const connectionId = requestedConnection.id;
				const revocationGeneration = this.getSqlRevocationGeneration?.(connectionId) ?? 0;
				const targetSignature = sqlConnectionTargetSignature(requestedConnection);
				assertRequestedConnectionCurrent = () => {
					if (cancellationToken?.isCancellationRequested) throw new vscode.CancellationError();
					const current = this.getSqlConnectionManager().getConnection(connectionId);
					if (!current || sqlConnectionTargetSignature(current) !== targetSignature
						|| (this.getSqlRevocationGeneration?.(connectionId) ?? 0) !== revocationGeneration) {
						throw new Error('SQL connection changed or was revoked before background configuration.');
					}
				};
				await this.refreshSqlLeaveNoTracePolicy?.();
				await this.assertSqlConnectionAllowed?.(requestedConnection.id);
				await this.getSqlConnectionManager().assertConnectionCurrent(requestedConnection);
				assertRequestedConnectionCurrent();
			}
			const background = await this.mutateBackgroundFile<{ success: boolean }>(resolvedTarget, file => {
				if (cancellationToken?.isCancellationRequested) throw new vscode.CancellationError();
				assertRequestedConnectionCurrent?.();
				if (aliasRequired && structuralAdmission?.() !== true) return { result: { success: false }, changed: false };
				const section = this.findBackgroundSection(file, input.sectionId) ?? (aliasRequired ? file.state.sections[0] : undefined);
				if (!section || section.type !== 'sql') return { result: { success: false }, changed: false };
				let changed = false;
				changed = this.setBackgroundSectionField(section, 'name', input.name) || changed;
				changed = this.setBackgroundSectionField(section, 'query', input.query) || changed;
				changed = this.setBackgroundSectionField(section, 'database', input.database) || changed;
				if (requestedConnection) {
					changed = this.setBackgroundSectionField(section, 'serverUrl', requestedConnection.serverUrl) || changed;
					changed = this.setBackgroundSectionField(section, 'connectionIdHint', requestedConnection.id) || changed;
					changed = this.setBackgroundSectionField(
						section, 'targetSignature', sqlConnectionTargetSignature(requestedConnection),
					) || changed;
				}
				this.stabilizeBackgroundSectionId(section, input.sectionId, changed);
				return { result: { success: true }, changed };
			});
			if (background) return background;
			throw new Error('Kusto Workbench is not currently open with a live editor for SQL configuration.');
		}
		if (input.execute) {
			const sectionAdmission = !input.connectionId && !input.serverUrl && input.database === undefined
				? capturedConnection.captureSqlSectionAdmission?.(input.sectionId) : undefined;
			const inheritedCurrent = operationCurrent;
			const admission = capturedConnection.captureStateAdmission?.();
			const documentUri = capturedConnection.documentUri;
			const logicalUriKey = capturedConnection.logicalUriKey;
			const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === documentUri);
			const version = document?.version;
			const source = document?.getText();
			operationCurrent = () => !cancellationToken?.isCancellationRequested
				&& this.liveConnections.get(capturedConnection.token) === capturedConnection
				&& capturedConnection.documentUri === documentUri && capturedConnection.logicalUriKey === logicalUriKey
				&& (!document || (!document.isClosed && vscode.workspace.textDocuments.includes(document)
					&& document.version === version && document.getText() === source))
				&& inheritedCurrent?.() !== false && admission?.() !== false && sectionAdmission?.() !== false;
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
		if (input.execute && requestedConnectionId && !String(input.database || '').trim()) {
			throw new Error('database is required when retargeting and executing a SQL section.');
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
		let operationOwnerToken = '';
		if (input.execute && !operationDatabase) {
			const sections = await capturedConnection.stateGetter();
			const section = sections?.find(candidate => candidate?.type === 'sql'
				&& String(candidate.id || '') === String(input.sectionId || ''));
			operationDatabase = String(section?.database || '').trim();
			operationOwnerToken = String(section?.ownerToken || '').trim();
		}
		if (input.execute && !operationDatabase) throw new Error('SQL section database is unavailable before execution.');
		const requestsTargetConfiguration = !!requestedConnection || input.database !== undefined;
		if (input.execute && !capturedConnection.sqlOwnerResolver) {
			throw new Error('SQL section owner resolver is unavailable before execution.');
		}
		let expectedReadyOwner: ReturnType<NonNullable<LiveWorkbenchConnection['sqlOwnerResolver']>>;
		if (input.execute && !requestsTargetConfiguration) {
			const liveOwner = capturedConnection.sqlOwnerResolver?.(String(input.sectionId || ''));
			if ((!liveOwner && operationOwnerToken)
				|| (liveOwner && (liveOwner.connectionId !== operationConnectionId || liveOwner.database !== operationDatabase
					|| (operationOwnerToken && liveOwner.ownerToken !== operationOwnerToken)))) {
				throw new Error('SQL section owner changed before execution.');
			}
			if (liveOwner) expectedReadyOwner = { ...liveOwner };
		}
		if (input.execute) {
			const sourceCurrent = operationCurrent;
			const savedConnection = { ...operationConnection };
			operationCurrent = () => sourceCurrent?.() !== false
				&& isDeepStrictEqual(savedConnection, this.getSqlConnectionManager().getConnection(operationConnectionId))
				&& sqlSchemaPrincipalFingerprint(this.context, savedConnection) === operationPrincipalFingerprint
				&& (this.getSqlRevocationGeneration?.(operationConnectionId) ?? 0) === operationRevocationGeneration
				&& (!expectedReadyOwner || isDeepStrictEqual(expectedReadyOwner, capturedConnection.sqlOwnerResolver?.(input.sectionId)));
			if (cancellationToken?.isCancellationRequested) throw new vscode.CancellationError();
			if (!operationCurrent()) throw new Error('The targeted Workbench editor changed before SQL installation preparation.');
			if (capturedConnection.prepareSqlExecution) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const deadline = new Promise<never>((_resolve, reject) => {
						timer = setTimeout(() => reject(new Error('SQL Tools Service installation preparation timed out.')),
							KustoWorkbenchToolOrchestrator.SQL_TOOL_INSTALLATION_TIMEOUT_MS);
					});
					const preparation = Promise.race([capturedConnection.prepareSqlExecution(), deadline]);
					await (cancellationToken ? raceCancellation(preparation, cancellationToken) : preparation);
				} finally {
					if (timer) clearTimeout(timer);
				}
			}
			if (!requestsTargetConfiguration && !expectedReadyOwner) {
				const readyOwner = await this.resolveSqlToolSection(capturedConnection, input.sectionId, cancellationToken);
				if (readyOwner.connectionId !== operationConnectionId || readyOwner.database !== operationDatabase
					|| readyOwner.generation === undefined) {
					throw new Error('SQL section owner changed during tool preflight.');
				}
				expectedReadyOwner = {
					connectionId: readyOwner.connectionId, database: readyOwner.database,
					ownerToken: readyOwner.ownerToken, generation: readyOwner.generation,
				};
			}
			await this.refreshSqlLeaveNoTracePolicy?.();
			await this.assertSqlConnectionAllowed?.(operationConnectionId);
			await this.getSqlConnectionManager().assertConnectionCurrent(operationConnection);
			if (await readCurrentSqlSchemaPrincipalFingerprint(this.context, operationConnection) !== operationPrincipalFingerprint) {
				throw new Error('SQL connection principal changed during installation preparation.');
			}
			if (cancellationToken?.isCancellationRequested) throw new vscode.CancellationError();
			if (!operationCurrent()) throw new Error('The targeted Workbench editor changed during SQL installation preparation.');
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
				? (connection, requestId) => { connection.poster({
					type: 'toolCancelSqlExecution', requestId,
					sectionId: input.sectionId, executionId,
				}); }
				: undefined,
			capturedConnection,
			cancellationToken,
			undefined,
			operationCurrent,
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

	async getSqlSchema(input: GetSqlSchemaInput, cancellationToken?: vscode.CancellationToken): Promise<{ success: boolean; schema?: unknown; error?: string }> {
		const { target, rest } = this.splitTargetFields(input);
		const resolvedTarget = this.resolveToolTarget(target);
		const capturedConnection = resolvedTarget.connection;
		const resolvedSection = await this.resolveSqlToolSection(capturedConnection, rest.sectionId, cancellationToken);
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
		const result = await this.sendToWebview<{ success: boolean; schema?: unknown; error?: string; owner?: { connectionId?: string; database?: string; ownerToken?: string } }>('toolGetSqlSchema', { sectionId }, 30000, target, undefined, capturedConnection, cancellationToken);
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
		const resolvedSection = await this.resolveSqlToolSection(capturedConnection, rest.sectionId, cancellationToken);
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

	async addSection(input: AddSectionInput): Promise<AddSectionResult> {
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
			if (!preflight.input) return { sectionId: '', success: false, error: preflight.error };
			input = preflight.input;
		}
		const resolvedTarget = this.resolveToolTarget(target);
		const background = resolvedTarget.connection ? undefined : await this.mutateBackgroundFile<AddSectionResult>(resolvedTarget, file => {
			const sectionId = `${input.type}_${randomUUID()}`;
			const section = this.createBackgroundSection(file, input, sectionId);
			if (!section) {
				return {
					result: { sectionId: '', success: false, error: `Section type "${input.type}" is not supported in .${file.kind} files.` },
					changed: false,
				};
			}
			file.state.sections.push(section);
			return { result: { sectionId, success: true }, changed: true };
		});
		if (background) return background;
		return this.sendToWebview('toolAddSection', { input }, 30000, target);
	}

	async removeSection(input: RemoveSectionInput, cancellationToken?: vscode.CancellationToken): Promise<{ success: boolean }> {
		const { target, rest } = this.splitTargetFields(input);
		const operation = await this.prepareBackgroundLiveOperation(target, cancellationToken);
		return this.sendToWebview('toolRemoveSection', { sectionId: rest.sectionId }, 30000, target,
			undefined, operation.connection, cancellationToken, undefined, operation.isCurrent);
	}

	async collapseSection(input: CollapseSectionInput): Promise<{ success: boolean }> {
		const { target, rest } = this.splitTargetFields(input);
		return this.sendToWebview('toolCollapseSection', { sectionId: rest.sectionId, collapsed: rest.collapsed }, 30000, target);
	}

	async reorderSections(input: ReorderSectionsInput): Promise<{ success: boolean; error?: string }> {
		const { target, rest } = this.splitTargetFields(input);
		return this.sendToWebview('toolReorderSections', { sectionIds: rest.sectionIds }, 30000, target);
	}

	async configureQuerySection(input: ConfigureQuerySectionInput, cancellationToken?: vscode.CancellationToken): Promise<ConfigureQuerySectionResult> {
		const { target, rest } = this.splitTargetFields(input);
		input = rest as ConfigureQuerySectionInput;
		const requiresExpectedTarget = input.execute === true && !(input.connectionId || input.clusterUrl || input.database);
		let expectedKustoTarget: ExpectedKustoTarget | undefined;
		// Unescape literal \n sequences that LLMs frequently produce in query text
		if (input.query !== undefined) {
			input = { ...input, query: unescapeLLMText(input.query) };
		}
		const preflight = this.preflightKustoToolTarget(input);
		if (!preflight.input) return { success: false, resultPreview: '', error: preflight.error };
		input = preflight.input;
		const resolvedTarget = this.resolveToolTarget(target);
		let operationCurrent: (() => boolean) | undefined;
		if (!resolvedTarget.connection && input.execute) {
			const operation = await this.prepareBackgroundLiveOperation(target, cancellationToken);
			resolvedTarget.connection = operation.connection;
			operationCurrent = operation.isCurrent;
		}
		if (!resolvedTarget.connection && input.execute) {
			return { success: false, error: 'Background query execution requires a live Workbench editor.' };
		}
		if (input.execute && resolvedTarget.connection?.prepareKustoExecution) {
			const connection = resolvedTarget.connection;
			const inheritedCurrent = operationCurrent;
			let admission: (() => boolean) | undefined;
			let runtimeAdmission: (() => boolean) | undefined;
			let retired = false;
			const documentUri = connection.documentUri;
			const logicalUriKey = connection.logicalUriKey;
			const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === documentUri);
			const version = document?.version;
			const savedTarget = this.connectionManager.getConnections().find(candidate => candidate.id === input.connectionId);
			let savedConnection = savedTarget ? Object.freeze({ ...savedTarget }) : undefined;
			let incarnation = savedConnection ? this.connectionManager.getConnectionIncarnation?.(savedConnection.id) : undefined;
			operationCurrent = () => !retired && !cancellationToken?.isCancellationRequested
				&& this.liveConnections.get(connection.token) === connection
				&& connection.documentUri === documentUri && connection.logicalUriKey === logicalUriKey
				&& (!document || (!document.isClosed && vscode.workspace.textDocuments.includes(document) && document.version === version))
				&& inheritedCurrent?.() !== false && runtimeAdmission?.() !== false && admission?.() !== false
				&& (!savedConnection || (isDeepStrictEqual(savedConnection,
					this.connectionManager.getConnections().find(candidate => candidate.id === savedConnection!.id))
					&& this.connectionManager.getConnectionIncarnation?.(savedConnection.id) === incarnation));
			if (cancellationToken?.isCancellationRequested) throw new vscode.CancellationError();
			if (!operationCurrent()) throw new Error('The targeted Workbench editor changed before Kusto execution preparation.');
			let timer: ReturnType<typeof setTimeout> | undefined;
			let prepared = false;
			try {
				const deadline = new Promise<boolean>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error('Kusto execution preparation timed out.')), 30_000);
				});
				const preparation = Promise.race([
					connection.prepareKustoExecution!(async isCurrent => {
						runtimeAdmission = isCurrent;
						admission = connection.captureStateAdmission?.();
						if (!operationCurrent!()) return false;
						if (!savedConnection) {
							const sections = await connection.stateGetter();
							if (!operationCurrent!()) return false;
							const section = sections?.find(candidate => candidate.id === input.sectionId);
							if (!section || (section.type !== 'query' && section.type !== 'copilotQuery')
								|| typeof section.connectionId !== 'string' || !section.connectionId.trim()
								|| typeof section.clusterUrl !== 'string' || !section.clusterUrl.trim()) {
								throw new Error('The targeted query section has no saved Kusto connection.');
							}
							if (requiresExpectedTarget) {
								const captured = captureExpectedKustoTarget({
									sectionId: section.id, sectionInstanceId: section.sectionInstanceId,
									targetGeneration: section.targetGeneration, connectionId: section.connectionId,
									clusterUrl: section.clusterUrl, database: section.database,
								});
								if (!captured.ok) throw new Error(`The targeted query section has no complete Kusto execution target: ${captured.error}`);
								expectedKustoTarget = captured.value;
							}
							const effectiveTarget = this.preflightKustoToolTarget({ connectionId: section.connectionId, clusterUrl: section.clusterUrl });
							if (!effectiveTarget.input) throw new Error(effectiveTarget.error);
							const current = this.connectionManager.getConnections().find(candidate => candidate.id === effectiveTarget.input!.connectionId);
							if (!current) return false;
							savedConnection = Object.freeze({ ...current });
							incarnation = this.connectionManager.getConnectionIncarnation?.(current.id);
						}
						return operationCurrent!();
					}),
					deadline,
				]);
				prepared = await (cancellationToken ? raceCancellation(preparation, cancellationToken) : preparation);
				if (!prepared) {
					throw new Error('Kusto connections could not be prepared for execution.');
				}
			} finally {
				retired = !prepared;
				if (timer) clearTimeout(timer);
			}
			const revalidated = this.preflightKustoToolTarget(input);
			if (!revalidated.input) return { success: false, resultPreview: '', error: revalidated.error };
			if (!operationCurrent()) throw new Error('The targeted Workbench editor changed during Kusto execution preparation.');
		}
		if (requiresExpectedTarget && !expectedKustoTarget) {
			return { success: false, error: 'The targeted query section has no complete Kusto execution target.' };
		}
		const background = resolvedTarget.connection ? undefined : await this.mutateBackgroundFile<ConfigureQuerySectionResult>(resolvedTarget, file => {
			const section = this.findBackgroundSection(file, input.sectionId);
			if (!section || (section.type !== 'query' && section.type !== 'copilotQuery')) {
				return { result: { success: false, error: `Query section not found: ${input.sectionId}` }, changed: false };
			}
			let changed = false;
			changed = this.setBackgroundSectionField(section, 'name', input.name) || changed;
			changed = this.setBackgroundSectionField(section, 'query', input.query) || changed;
			changed = this.setBackgroundSectionField(section, 'clusterUrl', input.clusterUrl) || changed;
			changed = this.setBackgroundSectionField(section, 'connectionIdHint', input.connectionId) || changed;
			changed = this.setBackgroundSectionField(section, 'database', input.database) || changed;
			this.stabilizeBackgroundSectionId(section, input.sectionId, changed);
			return { result: { success: true }, changed };
		});
		if (background) return background;
		const queryTimeoutMinutes = vscode.workspace.getConfiguration('kustoWorkbench').get<number>('queryTimeout', 20);
		const timeoutMs = input.execute
			? (queryTimeoutMinutes > 0 ? queryTimeoutMinutes * 60_000 + 30_000 : null)
			: 30000;
		return this.sendToWebview('toolConfigureQuerySection', { input, ...(expectedKustoTarget ? { expectedKustoTarget } : {}) }, timeoutMs, target,
			undefined, resolvedTarget.connection, cancellationToken, undefined, operationCurrent);
	}

	async updateMarkdownSection(input: UpdateMarkdownSectionInput): Promise<{ success: boolean }> {
		const { target, rest } = this.splitTargetFields(input);
		input = rest as UpdateMarkdownSectionInput;
		// Unescape literal \n sequences that LLMs frequently produce in markdown text
		const textValue = input.text ?? input.content;
		if (textValue !== undefined) {
			input = { ...input, text: unescapeLLMText(textValue) };
		}
		const resolvedTarget = this.resolveToolTarget(target);
		// Keep source-backed IDs on the host path; runtime-only IDs need a live handoff.
		let backgroundSectionMissing = false;
		const background = resolvedTarget.connection ? undefined : await this.mutateBackgroundFile<{ success: boolean } | undefined>(resolvedTarget, file => {
			const section = this.findBackgroundSection(file, input.sectionId);
			if (!section) {
				backgroundSectionMissing = true;
				return { result: undefined, changed: false };
			}
			if (section.type !== 'markdown') return { result: { success: false }, changed: false };
			let changed = false;
			changed = this.setBackgroundSectionField(section, 'title', input.name) || changed;
			changed = this.setBackgroundSectionField(section, 'text', input.text) || changed;
			changed = this.setBackgroundSectionField(section, 'mode', input.mode) || changed;
			this.stabilizeBackgroundSectionId(section, input.sectionId, changed);
			return { result: { success: true }, changed };
		});
		if (background) return background;
		const operation = resolvedTarget.connection ? { connection: resolvedTarget.connection }
			: await this.prepareBackgroundLiveOperation(target);
		if (!operation.connection && backgroundSectionMissing) return { success: false };
		return this.sendToWebview('toolUpdateMarkdownSection', { input }, 30000, target,
			undefined, operation.connection, undefined, undefined, operation.isCurrent);
	}

	async configureChart(input: ConfigureChartInput): Promise<{ success: boolean }> {
		const { target, rest } = this.splitTargetFields(input);
		const resolvedTarget = this.resolveToolTarget(target);
		const background = resolvedTarget.connection ? undefined : await this.mutateBackgroundFile<{ success: boolean }>(resolvedTarget, file => {
			const section = this.findBackgroundSection(file, rest.sectionId);
			if (!section || section.type !== 'chart') return { result: { success: false }, changed: false };
			const { sectionId: _sectionId, ...patch } = rest;
			let changed = false;
			for (const [key, value] of Object.entries(patch)) {
				changed = this.setBackgroundSectionField(section, key, value) || changed;
			}
			this.stabilizeBackgroundSectionId(section, rest.sectionId, changed);
			return { result: { success: true }, changed };
		});
		if (background) return background;
		return this.sendToWebview('toolConfigureChart', { input: rest }, 30000, target);
	}

	async configureTransformation(input: ConfigureTransformationInput): Promise<{ success: boolean }> {
		const { target, rest } = this.splitTargetFields(input);
		const resolvedTarget = this.resolveToolTarget(target);
		const background = resolvedTarget.connection ? undefined : await this.mutateBackgroundFile<{ success: boolean }>(resolvedTarget, file => {
			const section = this.findBackgroundSection(file, rest.sectionId);
			if (!section || section.type !== 'transformation') return { result: { success: false }, changed: false };
			const { sectionId: _sectionId, ...patch } = rest;
			let changed = false;
			if (patch.dataSourceId !== undefined && patch.dataSourceResultIndex === undefined) {
				changed = this.setBackgroundSectionField(section, 'dataSourceResultIndex', 0) || changed;
			}
			if (patch.joinRightDataSourceId !== undefined && patch.joinRightDataSourceResultIndex === undefined) {
				changed = this.setBackgroundSectionField(section, 'joinRightDataSourceResultIndex', 0) || changed;
			}
			for (const [key, value] of Object.entries(patch)) {
				changed = this.setBackgroundSectionField(section, key, value) || changed;
			}
			this.stabilizeBackgroundSectionId(section, rest.sectionId, changed);
			return { result: { success: true }, changed };
		});
		if (background) return background;
		return this.sendToWebview('toolConfigureTransformation', { input: rest }, 30000, target);
	}

	async configureHtmlSection(input: ConfigureHtmlSectionInput): Promise<{ success: boolean; sectionId?: string }> {
		const { target, rest } = this.splitTargetFields(input);
		input = rest as ConfigureHtmlSectionInput;
		if (input.code !== undefined) {
			input = { ...input, code: unescapeLLMText(input.code) };
		}
		const resolvedTarget = this.resolveToolTarget(target);
		const background = resolvedTarget.connection ? undefined : await this.mutateBackgroundFile<{ success: boolean; sectionId?: string }>(resolvedTarget, file => {
			const section = this.findBackgroundSection(file, input.sectionId);
			if (!section || section.type !== 'html') return { result: { success: false }, changed: false };
			let changed = false;
			changed = this.setBackgroundSectionField(section, 'name', input.name) || changed;
			changed = this.setBackgroundSectionField(section, 'code', input.code) || changed;
			changed = this.setBackgroundSectionField(section, 'mode', input.mode) || changed;
			if (input.code !== undefined) {
				const factSectionId = String(parseKwProvenance(input.code)?.model?.fact?.sectionId || '').trim();
				changed = this.setBackgroundSectionField(
					section, 'dataSourceIds', factSectionId ? [factSectionId] : [],
				) || changed;
			}
			this.stabilizeBackgroundSectionId(section, input.sectionId, changed);
			return { result: { success: true }, changed };
		});
		if (background) return background;
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
		if (dataSources.length === 0) issues.push('No usable saved fact data source found. Check the referenced query section, result index and dashboard data permission.');
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
		const warnings = getLegacyDashboardWarnings(code);
		const factResultIndex = parseKwProvenance(code)?.model?.fact?.resultIndex ?? 0;
		if (factResultIndex > 0) {
			warnings.push(
				`Dashboard preview uses Result ${factResultIndex + 1} (index ${factResultIndex}), but Power BI publishing supports Result 1 only.`,
			);
		}
		return {
			success: !!context.success,
			valid: !!context.success && uniqueIssues.length === 0,
			sectionId,
			issues: uniqueIssues,
			diagnostics,
			warnings: uniqueStrings(warnings),
			hasProvenance: !!context.hasProvenance,
			bindingCount: context.bindingCount || 0,
			dataSourceCount: dataSources.length,
			factColumns: context.factColumns || [],
			filePath,
			fileName,
			...(context.error ? { error: context.error } : {}),
		};
	}

	async delegateToKustoWorkbenchCopilot(
		input: DelegateToKustoWorkbenchCopilotInput,
		cancellationToken?: vscode.CancellationToken,
	): Promise<DelegateToKustoWorkbenchCopilotResult> {
		const { target, rest } = this.splitTargetFields(input);
		const preflight = this.preflightKustoToolTarget(rest);
		if (!preflight.input) return { success: false, error: preflight.error };
		const resolvedTarget = this.resolveToolTarget(target);
		const capturedConnection = resolvedTarget.connection;
		if (!capturedConnection) {
			if (resolvedTarget.explicitTarget) {
				throw new Error('The targeted Kusto Workbench file is open without a live Workbench editor. Reopen it with Kusto Workbench before editing or executing sections.');
			}
			if (resolvedTarget.activeFile) {
				throw new Error('The active Kusto Workbench file is open without a live Workbench editor. Reopen it with Kusto Workbench before editing or executing sections.');
			}
			throw new Error('Kusto Workbench is not currently open. Please open a supported Kusto Workbench file or use the Query Editor first.');
		}
		const normalizedInput = {
			...preflight.input,
			maxResultRows: normalizeAskKustoCopilotMaxResultRows(input.maxResultRows)
		};
		const result = await this.sendToWebview<DelegateToKustoWorkbenchCopilotResult>(
			'toolDelegateToKustoWorkbenchCopilot',
			{ input: normalizedInput },
			null,
			target,
			(connection, requestId) => connection.poster({ type: 'toolCancelKustoCopilot', requestId }),
			capturedConnection,
			cancellationToken,
			admitKustoCopilotDelegationResult,
		);
		const clarification = parseKustoCopilotClarificationRequiredResult(result);
		if (!clarification.ok) return result;
		const currentFile = capturedConnection.documentInfo
			? this.resolveRenamedWorkbenchFileInfo(capturedConnection.documentInfo)
			: undefined;
		const openFileId = currentFile?.openFileId;
		return Object.freeze({
			...clarification.value,
			...(openFileId ? { openFileId } : {}),
		});
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

	private isWorkspaceFileNotFound(error: unknown): boolean {
		const code = error && typeof error === 'object' && 'code' in error
			? String((error as { code?: unknown }).code || '')
			: '';
		const message = error instanceof Error ? error.message : String(error);
		return code === 'FileNotFound' || code === 'ENOENT' || /\bENOENT\b/.test(message);
	}

	private async assertWorkspaceFileAbsent(uri: vscode.Uri): Promise<void> {
		try {
			await vscode.workspace.fs.stat(uri);
		} catch (error) {
			if (this.isWorkspaceFileNotFound(error)) return;
			throw error;
		}
		throw new Error(`A file already exists at ${uri.fsPath || uri.toString()}. Choose a new path; existing files are never overwritten.`);
	}

	private async getCreatedFileIdentity(uri: vscode.Uri): Promise<Readonly<{ dev: bigint; ino: bigint }> | undefined> {
		if (uri.scheme !== 'file') return undefined;
		try {
			const stat = await fs.promises.stat(uri.fsPath, { bigint: true });
			return Object.freeze({ dev: stat.dev, ino: stat.ino });
		} catch {
			return undefined;
		}
	}

	private async rollbackCreatedFile(
		uri: vscode.Uri,
		expectedIdentity: Readonly<{ dev: bigint; ino: bigint }> | undefined,
		expectedHash: string,
	): Promise<void> {
		if (!expectedIdentity) {
			try {
				await vscode.workspace.fs.stat(uri);
			} catch (error) {
				if (this.isWorkspaceFileNotFound(error)) return;
				throw error;
			}
			throw new Error(`Could not verify ownership of the partially created file ${uri.fsPath || uri.toString()}; it was left untouched.`);
		}
		const quarantineUri = uri.with({ path: `${uri.path}.${randomUUID()}.rollback` });
		try {
			await vscode.workspace.fs.rename(uri, quarantineUri, { overwrite: false });
		} catch (error) {
			if (this.isWorkspaceFileNotFound(error)) return;
			throw error;
		}
		const movedIdentity = await this.getCreatedFileIdentity(quarantineUri);
		let movedHash = '';
		try {
			movedHash = createHash('sha256').update(await vscode.workspace.fs.readFile(quarantineUri)).digest('hex');
		} catch {
			// Preserve an unreadable candidate rather than deleting bytes we cannot verify.
		}
		if (movedIdentity && sameNonzeroPhysicalFileIdentity(expectedIdentity, movedIdentity)
			&& movedHash === expectedHash) {
			await vscode.workspace.fs.delete(quarantineUri);
			return;
		}
		try {
			await vscode.workspace.fs.rename(quarantineUri, uri, { overwrite: false });
		} catch (restoreError) {
			throw new AggregateError(
				[restoreError],
				`A replacement file was preserved at ${quarantineUri.fsPath || quarantineUri.toString()} because its original path could not be restored.`,
			);
		}
	}

	private async createWorkspaceFilesExclusive(
		files: readonly { uri: vscode.Uri; content: string }[],
	): Promise<void> {
		await Promise.all(files.map(file => this.assertWorkspaceFileAbsent(file.uri)));
		const staged: Array<{
			temporaryUri: vscode.Uri;
			targetUri: vscode.Uri;
			identity?: Readonly<{ dev: bigint; ino: bigint }>;
			expectedHash: string;
			published: boolean;
		}> = [];
		try {
			for (const file of files) {
				const temporaryUri = file.uri.with({ path: `${file.uri.path}.${randomUUID()}.tmp` });
				const stagedFile = {
					temporaryUri,
					targetUri: file.uri,
					identity: undefined as Readonly<{ dev: bigint; ino: bigint }> | undefined,
					expectedHash: createHash('sha256').update(file.content, 'utf8').digest('hex'),
					published: false,
				};
				staged.push(stagedFile);
				await vscode.workspace.fs.writeFile(temporaryUri, new TextEncoder().encode(file.content));
				stagedFile.identity = await this.getCreatedFileIdentity(temporaryUri);
			}
			for (const file of staged) {
				await vscode.workspace.fs.rename(file.temporaryUri, file.targetUri, { overwrite: false });
				file.published = true;
			}
		} catch (error) {
			const cleanupErrors: unknown[] = [];
			for (const file of [...staged].reverse()) {
				try {
					await this.rollbackCreatedFile(
						file.published ? file.targetUri : file.temporaryUri,
						file.identity,
						file.expectedHash,
					);
				} catch (cleanupError) {
					cleanupErrors.push(cleanupError);
				}
			}
			if (cleanupErrors.length > 0) {
				const message = error instanceof Error ? error.message : String(error);
				throw new AggregateError([error, ...cleanupErrors], `${message} Cleanup of partially created files was incomplete.`);
			}
			throw error;
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
		let uriHash: string | undefined;
		try { uriHash = createHash('sha256').update(effectiveInfo.logicalUriKey).digest('hex'); } catch {}
		const trace = createFileOpenTrace('activate', { uriHash });
		let releaseBackgroundLifecycle: (() => void) | undefined;
		let diagnosticPhase: 'lifecycle' | 'openWith' | 'recovery' | 'release' = 'lifecycle';
		const observation = observeFileOpenActivation(trace, effectiveInfo.logicalUri, () => ({
			phase: diagnosticPhase,
			backgroundOwnerMember: this.hostOwnedBackgroundFiles.has(effectiveInfo.logicalUriKey),
			backgroundOperationMember: this.backgroundFileOperations.has(effectiveInfo.logicalUriKey),
			mutationBlockCount: this.backgroundMutationBlocks.get(effectiveInfo.logicalUriKey) ?? 0,
		}));
		try {
			this.clearBackgroundOpeningLease(effectiveInfo.logicalUriKey);
			trace.mark('lifecycle.start');
			releaseBackgroundLifecycle = await this.acquireHostOwnedBackgroundLifecycle(effectiveInfo.logicalUriKey);
			trace.mark('lifecycle.done');
		} catch (error) {
			try {
				trace.mark('lifecycle.failed');
				return {
					success: false,
					openFileId: effectiveInfo.openFileId,
					uri: effectiveInfo.uriString,
					logicalUri: effectiveInfo.logicalUriString,
					fileKind: effectiveInfo.fileKind,
					...(effectiveInfo.filePath ? { filePath: effectiveInfo.filePath } : {}),
					...(effectiveInfo.fileName ? { fileName: effectiveInfo.fileName } : {}),
					error: error instanceof Error ? error.message : String(error),
				};
			} finally { try { observation.dispose(); } catch {} }
		}
		try {
			try {
				diagnosticPhase = 'openWith';
				trace.mark('openWith.start');
				await vscode.commands.executeCommand('vscode.openWith', effectiveInfo.logicalUri, editorId, {
					viewColumn: vscode.ViewColumn.Active,
					preserveFocus: false,
				});
				trace.mark('openWith.done');
			} catch (error) {
				trace.mark('openWith.failed');
				return {
					success: false,
					openFileId: effectiveInfo.openFileId,
					uri: effectiveInfo.uriString,
					logicalUri: effectiveInfo.logicalUriString,
					fileKind: effectiveInfo.fileKind,
					...(effectiveInfo.filePath ? { filePath: effectiveInfo.filePath } : {}),
					...(effectiveInfo.fileName ? { fileName: effectiveInfo.fileName } : {}),
					error: error instanceof Error ? error.message : String(error),
				};
			}
			this.hostOwnedBackgroundFiles.delete(effectiveInfo.logicalUriKey);
			this.backgroundProgrammaticSelections.delete(effectiveInfo.logicalUriKey);
			const liveConnection = this.getLatestLiveConnectionForKey(effectiveInfo.logicalUriKey);
			let activationFailed = false;
			let activationError: string | undefined;
			if (liveConnection) {
				this.activateConnection(liveConnection.token);
				try {
					diagnosticPhase = 'recovery';
					trace.mark('recovery.start', { callback: !!liveConnection.reactivate });
					const ready = liveConnection.reactivate
						? await liveConnection.reactivate()
						: await this.getSectionsForConnection(liveConnection) !== undefined;
					const current = this.liveConnections.get(liveConnection.token) === liveConnection;
					trace.mark('recovery.done', { ready, current });
					if (!ready || !current) {
						activationFailed = true;
						activationError = 'The targeted Kusto Workbench editor could not restore its live section bridge.';
					}
				} catch (error) {
					trace.mark('recovery.failed');
					activationFailed = true;
					const message = error instanceof Error ? error.message : String(error);
					activationError = message.trim() ? message : 'The targeted Kusto Workbench editor could not restore its live section bridge.';
				}
			}
			trace.mark('result', { success: !activationFailed, live: !!liveConnection && !activationFailed });
			return {
				success: !activationFailed,
				openFileId: effectiveInfo.openFileId,
				uri: effectiveInfo.uriString,
				logicalUri: effectiveInfo.logicalUriString,
				fileKind: effectiveInfo.fileKind,
				...(effectiveInfo.filePath ? { filePath: effectiveInfo.filePath } : {}),
				...(effectiveInfo.fileName ? { fileName: effectiveInfo.fileName } : {}),
				isLiveWorkbench: !!liveConnection && !activationFailed,
				isReadOnlyFallback: !liveConnection,
				...(activationError ? { error: activationError } : {}),
			};
		} finally {
			diagnosticPhase = 'release';
			try { releaseBackgroundLifecycle?.(); }
			finally { try { observation.dispose(); } catch {} }
		}
	}

	async closeWorkbenchFile(input: CloseWorkbenchFileInput): Promise<CloseWorkbenchFileResult> {
		const openFileId = typeof input.openFileId === 'string' ? input.openFileId.trim() : '';
		const targetFileUri = typeof input.targetFileUri === 'string' ? input.targetFileUri.trim() : '';
		if (!openFileId && !targetFileUri) {
			return {
				success: false,
				closed: false,
				error: 'Closing a Workbench file requires an explicit openFileId or targetFileUri from #listSections.',
			};
		}
		let target: ReturnType<KustoWorkbenchToolOrchestrator['resolveToolTarget']>;
		try {
			target = this.resolveToolTarget(input);
		} catch (error) {
			return { success: false, closed: false, error: error instanceof Error ? error.message : String(error) };
		}
		const file = target.explicitTarget ?? target.activeFile;
		if (!file) {
			return {
				success: false,
				closed: false,
				error: 'No open Kusto Workbench file was found. Use #listSections and pass openFileId or targetFileUri.',
			};
		}

		const collectMatchingEditors = (): { tabs: vscode.Tab[]; documents: vscode.TextDocument[] } => {
			const matchingTabs: vscode.Tab[] = [];
			const tabUris: vscode.Uri[] = [];
			for (const group of vscode.window.tabGroups.all || []) {
				for (const tab of group.tabs || []) {
					const tabInput = this.getTabInputUri(tab.input);
					if (!tabInput) continue;
					const tabInfo = classifyWorkbenchUri(tabInput.uri, {
						viewType: tabInput.viewType,
						includeOptionalPlainText: true,
					});
					if (!tabInfo || tabInfo.logicalUriKey !== file.logicalUriKey) continue;
					matchingTabs.push(tab);
					tabUris.push(tabInput.uri);
				}
			}
			return {
				tabs: matchingTabs,
				documents: vscode.workspace.textDocuments.filter(document =>
					tabUris.some(uri => this.isSameUriExact(document.uri, uri))),
			};
		};
		const metadata = {
			openFileId: file.openFileId,
			uri: file.uri,
			logicalUri: file.logicalUri,
			fileKind: file.fileKind,
			...(file.filePath ? { filePath: file.filePath } : {}),
			...(file.fileName ? { fileName: file.fileName } : {}),
		};
		let releaseBackgroundLifecycle: (() => void) | undefined;
		try {
			releaseBackgroundLifecycle = await this.acquireHostOwnedBackgroundLifecycle(file.logicalUriKey);
		} catch (error) {
			return { success: false, closed: false, ...metadata, error: error instanceof Error ? error.message : String(error) };
		}
		try {
		const initialEditors = collectMatchingEditors();
		const { tabs, documents } = initialEditors;
		if (tabs.length === 0) {
			return { success: false, closed: false, ...metadata, error: 'The targeted Kusto Workbench file is not open as an editor tab.' };
		}
		const requiresCloseLifecycle = tabs.some(tab => {
			const viewType = this.getTabInputUri(tab.input)?.viewType;
			return viewType === 'kusto.kqlCompatEditor' || viewType === 'kusto.sqlCompatEditor';
		});
		if (requiresCloseLifecycle && !target.connection?.closeLifecycle) {
			return {
				success: false, closed: false, ...metadata,
				error: 'The targeted compatibility editor close state is unavailable. Reactivate the file and retry.',
			};
		}

		const hasDirtyCompanionEditor = () => (vscode.window.tabGroups.all || []).some(group =>
			(group.tabs || []).some(tab => {
				const tabInput = this.getTabInputUri(tab.input);
				const tabInfo = tabInput ? classifyWorkbenchUri(tabInput.uri, {
					viewType: tabInput.viewType,
					includeOptionalPlainText: true,
				}) : undefined;
				return tabInfo?.logicalUriKey === file.logicalUriKey && tabInfo.isSidecar && tab.isDirty;
			})) || vscode.workspace.textDocuments.some(document => {
			const documentInfo = classifyWorkbenchUri(document.uri, { includeOptionalPlainText: true });
			return documentInfo?.logicalUriKey === file.logicalUriKey && documentInfo.isSidecar && document.isDirty;
		});
		const competingCompanionResult = (): CloseWorkbenchFileResult => ({
			success: false, closed: false, wasDirty: true, ...metadata,
			error: 'The companion metadata editor has unsaved changes. Resolve that editor manually before closing the Workbench file.',
		});
		if (requiresCloseLifecycle && hasDirtyCompanionEditor()) {
			return competingCompanionResult();
		}
		let lifecycleDirty = false;
		try {
			lifecycleDirty = await target.connection?.closeLifecycle?.inspectDirty() ?? false;
		} catch (error) {
			return {
				success: false, closed: false, ...metadata,
				error: `The targeted Workbench file's close state could not be verified: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		if (requiresCloseLifecycle && hasDirtyCompanionEditor()) {
			return competingCompanionResult();
		}
		const wasDirty = lifecycleDirty || tabs.some(tab => tab.isDirty) || documents.some(document => document.isDirty);
		if (wasDirty && input.saveChanges !== true) {
			return {
				success: false,
				closed: false,
				wasDirty: true,
				...metadata,
				error: 'The targeted Workbench file has unsaved changes. Pass saveChanges=true to save that exact file before closing.',
			};
		}

		let saved = false;
		if (wasDirty) {
			if (target.connection?.closeLifecycle) {
				if (hasDirtyCompanionEditor()) return competingCompanionResult();
				try {
					await target.connection.closeLifecycle.save();
				} catch (error) {
					return {
						success: false, closed: false, wasDirty: true, ...metadata,
						error: `The targeted Workbench file could not be saved: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
				if (hasDirtyCompanionEditor()) return competingCompanionResult();
			}
			const dirtyDocuments = documents.filter(document => document.isDirty);
			if (dirtyDocuments.length === 0 && !target.connection?.closeLifecycle) {
				return {
					success: false, closed: false, wasDirty: true, ...metadata,
					error: 'The targeted Workbench tab is dirty, but its backing document is unavailable for an exact save.',
				};
			}
			for (const document of dirtyDocuments) {
				try {
					if (!await document.save()) {
						return {
							success: false, closed: false, wasDirty: true, ...metadata,
							error: 'The targeted Workbench file could not be saved, so it was not closed.',
						};
					}
				} catch (error) {
					return {
						success: false, closed: false, wasDirty: true, ...metadata,
						error: `The targeted Workbench file could not be saved: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
			}
			let remainsLifecycleDirty = false;
			try {
				remainsLifecycleDirty = await target.connection?.closeLifecycle?.inspectDirty() ?? false;
			} catch (error) {
				return {
					success: false, closed: false, wasDirty: true, ...metadata,
					error: `The targeted Workbench file's saved state could not be verified: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			if (requiresCloseLifecycle && hasDirtyCompanionEditor()) return competingCompanionResult();
			const settledEditors = collectMatchingEditors();
			if (settledEditors.tabs.length === 0) {
				return {
					success: false, closed: false, saved, wasDirty: true, ...metadata,
					error: 'The targeted Workbench file closed before its saved state could be verified.',
				};
			}
			if (remainsLifecycleDirty || settledEditors.tabs.some(tab => tab.isDirty)
				|| settledEditors.documents.some(document => document.isDirty)) {
				return {
					success: false, closed: false, wasDirty: true, ...metadata,
					error: 'The targeted Workbench file remained dirty after saving, so it was not closed.',
				};
			}
			saved = true;
		}

		try {
			if (requiresCloseLifecycle && hasDirtyCompanionEditor()) return competingCompanionResult();
			const closingEditors = collectMatchingEditors();
			if (closingEditors.tabs.length === 0) {
				return {
					success: false, closed: false, saved, wasDirty, ...metadata,
					error: 'The targeted Kusto Workbench file is no longer open as an editor tab.',
				};
			}
			if (closingEditors.tabs.some(tab => tab.isDirty)
				|| closingEditors.documents.some(document => document.isDirty)) {
				return {
					success: false, closed: false, saved, wasDirty: true, ...metadata,
					error: 'The targeted Workbench file changed while closing, so it was left open.',
				};
			}
			const uniqueTabs = [...new Set(closingEditors.tabs)];
			const closed = await vscode.window.tabGroups.close(uniqueTabs, true);
			if (closed) {
				this.hostOwnedBackgroundFiles.delete(file.logicalUriKey);
				this.backgroundProgrammaticSelections.delete(file.logicalUriKey);
				this.clearBackgroundOpeningLease(file.logicalUriKey);
			}
			return closed
				? { success: true, closed: true, closedTabCount: uniqueTabs.length, saved, wasDirty, ...metadata }
				: { success: false, closed: false, saved, wasDirty, ...metadata, error: 'VS Code did not close the targeted Workbench file.' };
		} catch (error) {
			return {
				success: false, closed: false, saved, wasDirty, ...metadata,
				error: `VS Code could not close the targeted Workbench file: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		} finally {
			releaseBackgroundLifecycle?.();
		}
	}

	async saveWorkbenchFile(input: SaveWorkbenchFileInput): Promise<{
		success: boolean;
		saved: boolean;
		wasDirty?: boolean;
		openFileId?: string;
		filePath?: string;
		error?: string;
	}> {
		const openFileId = typeof input.openFileId === 'string' ? input.openFileId.trim() : '';
		const targetFileUri = typeof input.targetFileUri === 'string' ? input.targetFileUri.trim() : '';
		if (!openFileId && !targetFileUri) {
			return { success: false, saved: false, error: 'Saving a Workbench file requires an explicit openFileId or targetFileUri from #listSections.' };
		}
		let target: ReturnType<KustoWorkbenchToolOrchestrator['resolveToolTarget']>;
		try {
			target = this.resolveToolTarget(input);
		} catch (error) {
			return { success: false, saved: false, error: error instanceof Error ? error.message : String(error) };
		}
		const file = target.explicitTarget ?? target.activeFile;
		if (!file) return { success: false, saved: false, error: 'No matching open Kusto Workbench file was found.' };
		if (target.explicitTargetRequested
			&& !target.openFiles.some(openFile => openFile.openFileId === file.openFileId)) {
			return { success: false, saved: false, error: 'No matching open Kusto Workbench file was found.' };
		}
		const metadata = {
			openFileId: file.openFileId,
			...(file.filePath ? { filePath: file.filePath } : {}),
		};
		let releaseBackgroundLifecycle: (() => void) | undefined;
		try {
			releaseBackgroundLifecycle = await this.acquireHostOwnedBackgroundLifecycle(file.logicalUriKey);
		} catch (error) {
			return { success: false, saved: false, ...metadata, error: error instanceof Error ? error.message : String(error) };
		}
		try {
			const matchingDocuments = () => vscode.workspace.textDocuments.filter(document => {
				const info = classifyWorkbenchUri(document.uri, { includeOptionalPlainText: true });
				return info?.logicalUriKey === file.logicalUriKey;
			});
			const matchingTabs = () => (vscode.window.tabGroups.all || []).flatMap(group => group.tabs || []).filter(tab => {
				const tabInput = this.getTabInputUri(tab.input);
				const info = tabInput ? classifyWorkbenchUri(tabInput.uri, {
					viewType: tabInput.viewType,
					includeOptionalPlainText: true,
				}) : undefined;
				return info?.logicalUriKey === file.logicalUriKey;
			});
			let lifecycleDirty = false;
			try {
				lifecycleDirty = await target.connection?.closeLifecycle?.inspectDirty() ?? false;
			} catch (error) {
				return { success: false, saved: false, ...metadata, error: `The targeted Workbench file's save state could not be inspected: ${error instanceof Error ? error.message : String(error)}` };
			}
			const documents = matchingDocuments();
			const wasDirty = lifecycleDirty || documents.some(document => document.isDirty) || matchingTabs().some(tab => tab.isDirty);
			if (!wasDirty) return { success: true, saved: false, wasDirty: false, ...metadata };
			try {
				await target.connection?.closeLifecycle?.save();
				for (const document of matchingDocuments().filter(document => document.isDirty)) {
					if (!await document.save()) throw new Error('The backing document declined the save request.');
				}
				const remainsLifecycleDirty = await target.connection?.closeLifecycle?.inspectDirty() ?? false;
				if (remainsLifecycleDirty
					|| matchingDocuments().some(document => document.isDirty)
					|| matchingTabs().some(tab => tab.isDirty)) {
					return { success: false, saved: false, wasDirty: true, ...metadata, error: 'The targeted Workbench file remained dirty after saving.' };
				}
				return { success: true, saved: true, wasDirty: true, ...metadata };
			} catch (error) {
				return { success: false, saved: false, wasDirty: true, ...metadata, error: `The targeted Workbench file could not be saved: ${error instanceof Error ? error.message : String(error)}` };
			}
		} finally {
			releaseBackgroundLifecycle?.();
		}
	}

	async createFile(input: CreateFileInput): Promise<{
		success: boolean;
		filePath?: string;
		openRequested?: boolean;
		opened?: boolean;
		warning?: string;
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
			const filesToCreate: Array<{ uri: vscode.Uri; content: string }> = [];
			
			if (kqlxKind) {
				const file = createKqlxOrMdxFileWithDefaultSection(kqlxKind, initialContent || '');
				content = JSON.stringify(file, null, 2);
			} else if (fileType === 'md') {
				// Plain markdown file
				content = initialContent || '';
			} else {
				// Plain KQL/CSL file
				content = initialContent || '';
			}

			filesToCreate.push({ uri: fileUri, content });

			// Create sidecar file if needed
			if (isSidecar && sidecarExtension) {
				const sidecarUri = fileUri.with({
					path: `${fileUri.path.slice(0, -extension.length)}${sidecarExtension}`,
				});
				
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
				
				filesToCreate.push({ uri: sidecarUri, content: sidecarContent });
			}
			await this.createWorkspaceFilesExclusive(filesToCreate);

			const backgroundInfo = input.reveal === false && kqlxKind
				? classifyWorkbenchUri(fileUri, { includeOptionalPlainText: true })
				: undefined;
			if (backgroundInfo) {
				this.hostOwnedBackgroundFiles.set(backgroundInfo.logicalUriKey, fileType === 'sqlx' ? createHash('sha256').update(content, 'utf8').digest('hex') : undefined);
				this.backgroundOpeningFiles.add(backgroundInfo.logicalUriKey);
				this.backgroundProgrammaticSelections.add(backgroundInfo.logicalUriKey);
			}

			// Open the file with the appropriate editor
			try {
				await vscode.commands.executeCommand('vscode.openWith', fileUri, editorId, {
					preview: false,
					preserveFocus: input.reveal === false,
				});
			} catch (error) {
				if (backgroundInfo) {
					this.hostOwnedBackgroundFiles.delete(backgroundInfo.logicalUriKey);
					this.backgroundProgrammaticSelections.delete(backgroundInfo.logicalUriKey);
					this.clearBackgroundOpeningLease(backgroundInfo.logicalUriKey);
				}
				return {
					success: true,
					filePath: fileUri.fsPath,
					openRequested: true,
					opened: false,
					warning: `The file was created but could not be opened in Kusto Workbench: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			if (backgroundInfo) this.scheduleBackgroundOpeningLeaseRelease(backgroundInfo.logicalUriKey);

			return { success: true, filePath: fileUri.fsPath, openRequested: true };
		} catch (err) {
			const failedInfo = fileUri ? classifyWorkbenchUri(fileUri, { includeOptionalPlainText: true }) : undefined;
			if (failedInfo) {
				this.hostOwnedBackgroundFiles.delete(failedInfo.logicalUriKey);
				this.backgroundProgrammaticSelections.delete(failedInfo.logicalUriKey);
				this.clearBackgroundOpeningLease(failedInfo.logicalUriKey);
			}
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
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.refreshSchema(getToolInput(options));
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(await formatSchemaCollectionJsonWithTokenBudget(
					result,
					'schemas',
					options.tokenizationOptions,
					token,
				))
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

			// Multi-database summaries retain valid JSON while respecting the caller's token budget.
			if (result.databases) {
				return new vscode.LanguageModelToolResult([
					new vscode.LanguageModelTextPart(await formatSchemaCollectionJsonWithTokenBudget(
						result,
						'databases',
						options.tokenizationOptions,
						token,
					))
				]);
			}
			if (result.error) {
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

export class CloseWorkbenchFileTool implements vscode.LanguageModelTool<CloseWorkbenchFileInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CloseWorkbenchFileInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const result = await this.orchestrator.closeWorkbenchFile(getToolInput(options));
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
		]);
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<CloseWorkbenchFileInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		const input = getToolInput(options);
		return {
			invocationMessage: `Closing Workbench file ${input?.openFileId || input?.targetFileUri || ''}...`,
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
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.removeSection(getToolInput(options), token);
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

export class SaveWorkbenchFileTool implements vscode.LanguageModelTool<SaveWorkbenchFileInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<SaveWorkbenchFileInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const result = await this.orchestrator.saveWorkbenchFile(getToolInput(options));
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))]);
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
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.getSqlSchema(getToolInput(options), token);
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
		vscode.lm.registerTool('kusto-workbench_close-workbench-file', new CloseWorkbenchFileTool(orchestrator)),
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
		vscode.lm.registerTool('kusto-workbench_save-workbench-file', new SaveWorkbenchFileTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_manage-development-notes', new ManageDevelopmentNotesTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_list-sql-connections', new ListSqlConnectionsTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_configure-sql-section', new ConfigureSqlSectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_get-sql-schema', new GetSqlSchemaTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_ask-sql-copilot', new DelegateToSqlCopilotTool(orchestrator))
	);

	return orchestrator;
}
