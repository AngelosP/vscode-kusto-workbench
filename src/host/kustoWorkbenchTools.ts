import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionManager, KustoConnection } from './connectionManager';
import { createEmptyKqlxOrMdxFile, DevNoteEntry, KqlxFileKind, KqlxSectionV1 } from './kqlxFormat';
import { readAllCachedSchemasFromDisk, readCachedSchemaFromDiskByCluster, searchCachedSchemas, writeCachedSchemaToDisk, SCHEMA_CACHE_VERSION, schemaCacheKey } from './schemaCache';
import type { SqlConnectionManager } from './sqlConnectionManager';
import type { KustoQueryClient } from './kustoClient';
import { countColumns, formatSchemaAsCompactText, formatSchemaWithTokenBudget } from './schemaIndexUtils';
import { getPowerBiHtmlValidationIssues, type PowerBiDataSource } from './powerBiExport';
import { getLegacyDashboardWarnings } from '../shared/htmlDashboardUpgrade';
import { classifyWorkbenchUri, classifyWorkbenchUriString, type WorkbenchFileInfo, type WorkbenchFileKind } from './workbenchFileTypes';
import { kustoClusterKey } from '../shared/kustoClusterUrls';

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

export interface AddSectionInput extends TargetFields {
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
	serverUrl?: string;
	database?: string;
	execute?: boolean;
}

export interface GetSqlSchemaInput extends TargetFields {
	sectionId: string;
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
	poster: (message: unknown) => void;
	stateGetter: () => Promise<ToolSection[] | undefined>;
	schemaRefresher: (clusterUrl: string) => Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }>;
	documentUri?: string;
	documentInfo?: WorkbenchFileInfo;
	logicalUriKey?: string;
	sequence: number;
}

export class KustoWorkbenchToolOrchestrator {
	private static instance: KustoWorkbenchToolOrchestrator | undefined;
	
	// Legacy fallback callbacks for the latest connected editor, including the standalone Query Editor.
	private webviewMessagePoster: ((message: unknown) => void) | undefined;
	private stateGetter: (() => Promise<ToolSection[] | undefined>) | undefined;
	private schemaRefresher: ((clusterUrl: string) => Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }>) | undefined;
	private activeDocumentUri: string | undefined;
	private latestConnectionToken: number | undefined;
	private readonly liveConnections = new Map<number, LiveWorkbenchConnection>();
	private readonly renamedWorkbenchFiles = new Map<string, WorkbenchFileInfo>();
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
		schemaRefresher: (clusterUrl: string) => Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }>,
		documentUri?: string
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
			...(documentUri ? { documentUri } : {}),
			...(documentInfo ? { documentInfo, logicalUriKey: documentInfo.logicalUriKey } : {}),
			sequence: this.connectionToken,
		};
		this.liveConnections.set(entry.token, entry);
		this.applyLatestConnection(entry);
		return this.connectionToken;
	}

	/**
	 * Disconnect only if the caller holds the current connection token.
	 * This prevents a closing editor from disconnecting a different active one.
	 */
	disconnectIfOwner(token: number): void {
		this.liveConnections.delete(token);
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

	private async sendToWebview<T>(type: string, payload: Record<string, unknown>, timeoutMs = 30000, targetFields: TargetFields = {}): Promise<T> {
		const target = this.resolveToolTarget(targetFields);
		if (!target.connection) {
			if (target.explicitTarget) {
				throw new Error('The targeted Kusto Workbench file is open without a live Workbench editor. Reopen it with Kusto Workbench before editing or executing sections.');
			}
			if (target.activeFile) {
				throw new Error('The active Kusto Workbench file is open without a live Workbench editor. Reopen it with Kusto Workbench before editing or executing sections.');
			}
			throw new Error('Kusto Workbench is not currently open. Please open a supported Kusto Workbench file or use the Query Editor first.');
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
			
			target.connection!.poster({ type, requestId, ...payload });
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
		const target = this.resolveToolTarget();
		if (target.connection?.schemaRefresher) {
			return target.connection.schemaRefresher(clusterUrl);
		}
		return this.refreshSchemaDirectly(clusterUrl);
	}

	/**
	 * Refresh schema directly via the Kusto client, without requiring an open editor.
	 * Mirrors the logic in QueryEditorSchema.refreshSchemaForTools.
	 */
	private async refreshSchemaDirectly(clusterUrl: string): Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }> {
		const connections = this.connectionManager.getConnections();
		const normalizedInput = kustoClusterKey(clusterUrl);
		const connection = connections.find(c => kustoClusterKey(c.clusterUrl) === normalizedInput)
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

					const cacheKey = schemaCacheKey(connection.clusterUrl, db);
					const timestamp = result.fromCache ? Date.now() - (result.cacheAgeMs ?? 0) : Date.now();
					await writeCachedSchemaToDisk(this.context.globalStorageUri, cacheKey, { schema, timestamp, version: SCHEMA_CACHE_VERSION, clusterUrl: connection.clusterUrl, database: db });

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
			let cached = await readCachedSchemaFromDiskByCluster(this.context.globalStorageUri, clusterUrl, db);

				if (!cached?.schema) {
				// Not in cache – try to fetch live
				const target = this.resolveToolTarget();
				const refreshResult = target.connection?.schemaRefresher
					? await target.connection.schemaRefresher(clusterUrl)
					: await this.refreshSchemaDirectly(clusterUrl);
				if (refreshResult.error && refreshResult.schemas.length === 0) {
					return { error: refreshResult.error };
				}
				// Re-read from disk since the refresher persists to cache
				cached = await readCachedSchemaFromDiskByCluster(this.context.globalStorageUri, clusterUrl, db);
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
			const target = this.resolveToolTarget();
			const refreshResult = target.connection?.schemaRefresher
				? await target.connection.schemaRefresher(clusterUrl)
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
		return rawSections?.map((section, index) => this.summarizeToolSection(section, index));
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
		const conns = this.getSqlConnectionManager().getConnections();
		return { connections: conns.map(c => ({ id: c.id, name: c.name, serverUrl: c.serverUrl, dialect: c.dialect })) };
	}

	async configureSqlSection(input: ConfigureSqlSectionInput): Promise<{ success: boolean; resultPreview?: string }> {
		const { target, rest } = this.splitTargetFields(input);
		input = rest as ConfigureSqlSectionInput;
		if (input.query !== undefined) {
			input = { ...input, query: unescapeLLMText(input.query) };
		}
		return this.sendToWebview('toolConfigureSqlSection', { input }, 30000, target);
	}

	async getSqlSchema(input: GetSqlSchemaInput): Promise<{ success: boolean; schema?: unknown; error?: string }> {
		const { target, rest } = this.splitTargetFields(input);
		return this.sendToWebview('toolGetSqlSchema', { sectionId: rest.sectionId }, 30000, target);
	}

	async delegateToSqlCopilot(input: DelegateToSqlCopilotInput): Promise<{
		success: boolean;
		answer: string;
		query?: string;
		error?: string;
		timedOut?: boolean;
	}> {
		const { target, rest } = this.splitTargetFields(input);
		return this.sendToWebview('toolDelegateToSqlCopilot', { input: rest }, 180000, target);
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

	async configureQuerySection(input: ConfigureQuerySectionInput): Promise<{ success: boolean; resultPreview?: string }> {
		const { target, rest } = this.splitTargetFields(input);
		input = rest as ConfigureQuerySectionInput;
		// Unescape literal \n sequences that LLMs frequently produce in query text
		if (input.query !== undefined) {
			input = { ...input, query: unescapeLLMText(input.query) };
		}
		return this.sendToWebview('toolConfigureQuerySection', { input }, 30000, target);
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
		if ((context.bindingCount || 0) === 0) issues.push('No provenance bindings found. Add bindings for every exportable scalar, table, repeated table, pivot, and chart.');
		if (dataSources.length === 0) issues.push('No runnable fact data source found. Run the fact query and ensure provenance model.fact.sectionId points at that query section.');
		issues.push(...getPowerBiHtmlValidationIssues(code, dataSources));

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

	async delegateToKustoWorkbenchCopilot(input: DelegateToKustoWorkbenchCopilotInput): Promise<{
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
		const normalizedInput = {
			...rest,
			maxResultRows: normalizeAskKustoCopilotMaxResultRows(input.maxResultRows)
		};
		return this.sendToWebview('toolDelegateToKustoWorkbenchCopilot', { input: normalizedInput }, 180000, target); // 3 minute timeout for Copilot + query execution
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
