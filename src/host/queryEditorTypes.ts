import * as vscode from 'vscode';
import { DatabaseSchemaIndex } from './kustoClient';

export const OUTPUT_CHANNEL_NAME = 'Kusto Workbench';

export const STORAGE_KEYS = {
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
	sqlFavorites: 'sql.favorites',
	copilotChatFirstTimeDismissed: 'kusto.copilotChatFirstTimeDismissed'
} as const;

export type KustoFavorite = { name: string; clusterUrl: string; database: string };
export type SqlFavorite = { name: string; connectionId: string; database: string };

export const DEFAULT_PREFERRED_COPILOT_MODEL_ID = 'claude-opus-4.6';

export function findPreferredDefaultCopilotModel(models: vscode.LanguageModelChat[]): vscode.LanguageModelChat | undefined {
	if (models.length === 0) {
		return undefined;
	}
	const preferredModel = models.find(m => m.id === DEFAULT_PREFERRED_COPILOT_MODEL_ID);
	return preferredModel || models[0];
}

export type CachedSchemaEntry = { schema: DatabaseSchemaIndex; timestamp: number; version: number; clusterUrl?: string; database?: string };

export type CacheUnit = 'minutes' | 'hours' | 'days';

export type CopilotLocalTool = {
	name: string;
	label: string;
	description: string;
	enabledByDefault?: boolean;
};

export type StartCopilotWriteQueryMessage = {
	type: 'startCopilotWriteQuery';
	boxId: string;
	flavor: 'kusto' | 'sql';
	connectionId: string;
	serverUrl: string;
	database: string;
	currentQuery?: string;
	request: string;
	modelId?: string;
	enabledTools?: string[];
	queryMode?: string;
	requireToolUse?: boolean;
};

export type OptimizeQueryMessage = {
	type: 'optimizeQuery';
	query: string;
	connectionId: string;
	database: string;
	boxId: string;
	queryName: string;
	modelId?: string;
	promptText?: string;
};

export type ExecuteQueryMessage = {
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

export type ExecuteSqlQueryMessage = {
	type: 'executeSqlQuery';
	query: string;
	sqlConnectionId: string;
	boxId: string;
	database?: string;
	queryMode?: string;
};

export type CopyAdeLinkMessage = {
	type: 'copyAdeLink';
	query: string;
	connectionId: string;
	database: string;
	boxId: string;
};

export type ShareToClipboardMessage = {
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

export type ImportConnectionsFromXmlMessage = {
	type: 'importConnectionsFromXml';
	connections: Array<{ name: string; clusterUrl: string; database?: string }>;
	boxId?: string;
};

export type KqlLanguageRequestMessage = {
	type: 'kqlLanguageRequest';
	requestId: string;
	method: 'textDocument/diagnostic' | 'kusto/findTableReferences';
	params: { text: string; connectionId?: string; database?: string; boxId?: string; uri?: string };
};

export type FetchControlCommandSyntaxMessage = { type: 'fetchControlCommandSyntax'; requestId: string; commandLower: string; href: string };

export type SaveResultsCsvMessage = { type: 'saveResultsCsv'; boxId?: string; csv: string; suggestedFileName?: string };
export type ExportDashboardMessage = {
	type: 'exportDashboard';
	boxId: string;
	html: string;
	suggestedFileName?: string;
	previewHeight?: number;
	dataSources: Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }>;
};
export type GetPbiWorkspacesMessage = { type: 'getPbiWorkspaces'; boxId: string };
export type PublishToPowerBIMessage = {
	type: 'publishToPowerBI';
	boxId: string;
	workspaceId: string;
	reportName: string;
	pageWidth: number;
	pageHeight: number;
	htmlCode: string;
	dataSources: Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }>;
};

export type IncomingWebviewMessage =
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
	| ExportDashboardMessage
	| GetPbiWorkspacesMessage
	| PublishToPowerBIMessage
	| { type: 'setCaretDocsEnabled'; enabled: boolean }
	| { type: 'setAutoTriggerAutocompleteEnabled'; enabled: boolean }
	| { type: 'setCopilotInlineCompletionsEnabled'; enabled: boolean }
	| { type: 'requestCopilotInlineCompletion'; requestId: string; boxId: string; textBefore: string; textAfter: string; flavor?: 'kusto' | 'sql' }
	| { type: 'executePython'; boxId: string; code: string }
	| { type: 'fetchUrl'; boxId: string; url: string }
	| { type: 'cancelQuery'; boxId: string }
	| { type: 'checkCopilotAvailability'; boxId: string }
	| { type: 'prepareCopilotWriteQuery'; boxId: string; flavor?: 'kusto' | 'sql' }
	| StartCopilotWriteQueryMessage
	| { type: 'cancelCopilotWriteQuery'; boxId: string }
	| { type: 'clearCopilotConversation'; boxId: string }
	| { type: 'removeFromCopilotHistory'; boxId: string; entryId: string }
	| { type: 'prepareOptimizeQuery'; query: string; boxId: string }
	| { type: 'cancelOptimizeQuery'; boxId: string }
	| OptimizeQueryMessage
	| ExecuteQueryMessage
	| { type: 'getSqlConnections' }
	| { type: 'getSqlDatabases'; sqlConnectionId: string; boxId: string }
	| { type: 'refreshSqlDatabases'; sqlConnectionId: string; boxId: string }
	| { type: 'saveSqlLastSelection'; sqlConnectionId: string; database?: string }
	| { type: 'promptAddSqlConnection'; boxId?: string }
	| { type: 'addSqlConnection'; name: string; serverUrl: string; dialect: string; authType: string; database?: string; port?: number; username?: string; password?: string; boxId?: string }
	| { type: 'testSetSqlAuthOverride'; serverUrl: string; accountId: string; token: string }
	| { type: 'testClearSqlAuthOverride'; accountId: string }
	| ExecuteSqlQueryMessage
	| { type: 'cancelSqlQuery'; boxId: string }
	| { type: 'prefetchSqlSchema'; sqlConnectionId: string; database: string; boxId: string; forceRefresh?: boolean }
	| { type: 'prepareSqlCopilotWriteQuery'; boxId: string }
	| { type: 'startSqlCopilotWriteQuery'; boxId: string; sqlConnectionId: string; database: string; request: string; modelId?: string; enabledTools?: string[] }
	| { type: 'cancelSqlCopilotWriteQuery'; boxId: string }
	| { type: 'clearSqlCopilotConversation'; boxId: string }
	| { type: 'removeFromSqlCopilotHistory'; boxId: string; entryId: string }
	| { type: 'requestAddSqlFavorite'; connectionId: string; database: string; defaultName?: string; boxId?: string }
	| { type: 'removeSqlFavorite'; connectionId: string; database: string; boxId?: string }
	| CopyAdeLinkMessage
	| ShareToClipboardMessage
	| { type: 'prefetchSchema'; connectionId: string; database: string; boxId: string; forceRefresh?: boolean; requestToken?: string }
	| { type: 'requestCrossClusterSchema'; clusterName: string; database: string; boxId: string; requestToken: string }
	| { type: 'stsRequest'; requestId: string; method: string; params: { boxId: string; line: number; column: number } }
	| { type: 'stsDidOpen'; boxId: string; text: string }
	| { type: 'stsDidChange'; boxId: string; text: string }
	| { type: 'stsDidClose'; boxId: string }
	| { type: 'stsConnect'; boxId: string; sqlConnectionId: string; database: string }
	| { type: 'promptAddConnection'; boxId?: string }
	| { type: 'addConnection'; name: string; clusterUrl: string; database?: string; boxId?: string }
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
	| { type: 'toolResponse'; requestId: string; result: unknown; error?: string }
	| { type: 'toolStateResponse'; requestId: string; sections: unknown[] }
	| { type: 'openCopilotAgent' }
	| { type: 'copilotChatFirstTimeCheck'; boxId: string }
	| { type: 'showSectionDiff'; sectionId: string };

// ── Section-level unsaved-changes types ─────────────────────────────────────

/** Per-section change descriptor sent from host to webview. */
export type SectionChangeInfo = {
	id: string;
	status: 'modified' | 'new';
	contentChanged: boolean;
	settingsChanged: boolean;
};

/** Host→webview message carrying per-section unsaved-change indicators. */
export type ChangedSectionsMessage = {
	type: 'changedSections';
	changes: SectionChangeInfo[];
};
