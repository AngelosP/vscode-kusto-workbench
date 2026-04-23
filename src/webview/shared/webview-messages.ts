/**
 * Typed messages sent from the webview to the extension host via postMessage.
 *
 * This is the webview-side counterpart to the host's {@link IncomingWebviewMessage}
 * (in queryEditorTypes.ts). It also includes provider-specific messages that the
 * kqlx/kqlCompat/mdCompat editors handle.
 */

// ── Query execution & results ──────────────────────────────────────────────

export type OutgoingExecuteQueryMessage = {
	type: 'executeQuery';
	query: string;
	connectionId: string;
	boxId: string;
	database?: string;
	queryMode?: string;
	cacheEnabled?: boolean;
	cacheValue?: number;
	cacheUnit?: string;
};

export type OutgoingCopyAdeLinkMessage = {
	type: 'copyAdeLink';
	query: string;
	connectionId: string;
	database: string;
	boxId: string;
};

export type OutgoingShareToClipboardMessage = {
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

// ── Copilot ────────────────────────────────────────────────────────────────

export type OutgoingStartCopilotWriteQueryMessage = {
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

export type OutgoingOptimizeQueryMessage = {
	type: 'optimizeQuery';
	query: string;
	connectionId: string;
	database: string;
	boxId: string;
	queryName: string;
	modelId?: string;
	promptText?: string;
};

// ── Schema & language service ──────────────────────────────────────────────

export type OutgoingKqlLanguageRequestMessage = {
	type: 'kqlLanguageRequest';
	requestId: string;
	method: string;
	params: { text: string; connectionId?: string; database?: string; boxId?: string; uri?: string };
};

export type OutgoingFetchControlCommandSyntaxMessage = {
	type: 'fetchControlCommandSyntax';
	requestId: string;
	commandLower: string;
	href: string;
};

// ── Connections & favorites ────────────────────────────────────────────────

export type OutgoingImportConnectionsFromXmlMessage = {
	type: 'importConnectionsFromXml';
	connections: Array<{ name: string; clusterUrl: string; database?: string }>;
	boxId?: string;
};

// ── The union ──────────────────────────────────────────────────────────────

export type OutgoingWebviewMessage =
	// Connection & database
	| { type: 'getConnections' }
	| { type: 'getDatabases'; connectionId: string; boxId: string }
	| { type: 'refreshDatabases'; connectionId: string; boxId: string }
	| { type: 'saveLastSelection'; connectionId: string; database?: string }
	| { type: 'promptAddConnection'; boxId?: string }
	| { type: 'addConnection'; name: string; clusterUrl: string; database?: string; boxId?: string }
	| { type: 'promptImportConnectionsXml'; boxId?: string }
	| { type: 'addConnectionsForClusters'; clusterUrls: string[]; boxId?: string }
	| OutgoingImportConnectionsFromXmlMessage

	// Favorites
	| { type: 'requestAddFavorite'; clusterUrl: string; database: string; defaultName?: string; boxId?: string }
	| { type: 'removeFavorite'; clusterUrl: string; database: string; boxId?: string }
	| { type: 'confirmRemoveFavorite'; requestId: string; label?: string; clusterUrl: string; database: string; boxId?: string }

	// SQL favorites
	| { type: 'requestAddSqlFavorite'; connectionId: string; database: string; defaultName?: string; boxId?: string }
	| { type: 'removeSqlFavorite'; connectionId: string; database: string; boxId?: string }

	// Info & UI
	| { type: 'showInfo'; message: string }
	| { type: 'seeCachedValues' }
	| { type: 'resolveResourceUri'; requestId: string; path: string; baseUri?: string }
	| { type: 'saveResultsCsv'; boxId?: string; csv: string; suggestedFileName?: string }
	| { type: 'exportDashboard'; boxId: string; html: string; suggestedFileName?: string; previewHeight?: number; dataSources: Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }> }
	| { type: 'getPbiWorkspaces'; boxId: string }
	| { type: 'publishToPowerBI'; boxId: string; workspaceId: string; reportName: string; pageWidth: number; pageHeight: number; htmlCode: string; dataSources: Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }> }

	// Settings
	| { type: 'setCaretDocsEnabled'; enabled: boolean }
	| { type: 'setAutoTriggerAutocompleteEnabled'; enabled: boolean }
	| { type: 'setCopilotInlineCompletionsEnabled'; enabled: boolean }

	// Query execution
	| OutgoingExecuteQueryMessage
	| { type: 'cancelQuery'; boxId: string }
	| OutgoingCopyAdeLinkMessage
	| OutgoingShareToClipboardMessage

	// SQL connections & databases
	| { type: 'getSqlConnections' }
	| { type: 'getSqlDatabases'; sqlConnectionId: string; boxId: string }
	| { type: 'refreshSqlDatabases'; sqlConnectionId: string; boxId: string }
	| { type: 'saveSqlLastSelection'; sqlConnectionId: string; database?: string }
	| { type: 'promptAddSqlConnection'; boxId?: string }
	| { type: 'addSqlConnection'; name: string; serverUrl: string; dialect: string; authType: string; database?: string; port?: number; username?: string; password?: string; boxId?: string }
	| { type: 'testSetSqlAuthOverride'; serverUrl: string; accountId: string; token: string }
	| { type: 'testClearSqlAuthOverride'; accountId: string }

	// SQL query execution
	| { type: 'executeSqlQuery'; query: string; sqlConnectionId: string; boxId: string; database?: string; queryMode?: string }
	| { type: 'cancelSqlQuery'; boxId: string }

	// SQL schema
	| { type: 'prefetchSqlSchema'; sqlConnectionId: string; database: string; boxId: string; forceRefresh?: boolean }

	// SQL copilot — unified into Copilot section below

	// Comparisons
	| { type: 'comparisonBoxEnsured'; requestId: string; sourceBoxId: string; comparisonBoxId: string }
	| { type: 'comparisonSummary'; sourceBoxId: string; comparisonBoxId: string; dataMatches: boolean; headersMatch?: boolean; rowOrderMatches?: boolean; columnOrderMatches?: boolean }

	// Schema
	| { type: 'prefetchSchema'; connectionId: string; database: string; boxId: string; forceRefresh?: boolean; requestToken?: string }
	| { type: 'requestCrossClusterSchema'; clusterName: string; database: string; boxId: string; requestToken: string }
	| { type: 'stsRequest'; requestId: string; method: string; params: { boxId: string; line: number; column: number } }
	| { type: 'stsDidOpen'; boxId: string; text: string }
	| { type: 'stsDidChange'; boxId: string; text: string }
	| { type: 'stsDidClose'; boxId: string }
	| { type: 'stsConnect'; boxId: string; sqlConnectionId: string; database: string }
	| OutgoingKqlLanguageRequestMessage
	| OutgoingFetchControlCommandSyntaxMessage

	// Copilot
	| { type: 'checkCopilotAvailability'; boxId: string }
	| { type: 'prepareCopilotWriteQuery'; boxId: string; flavor?: 'kusto' | 'sql' }
	| OutgoingStartCopilotWriteQueryMessage
	| { type: 'cancelCopilotWriteQuery'; boxId: string }
	| { type: 'clearCopilotConversation'; boxId: string }
	| { type: 'removeFromCopilotHistory'; boxId: string; entryId: string }
	| { type: 'requestCopilotInlineCompletion'; requestId: string; boxId: string; textBefore: string; textAfter: string; flavor?: 'kusto' | 'sql' }

	// Optimize
	| { type: 'prepareOptimizeQuery'; query: string; boxId: string }
	| { type: 'cancelOptimizeQuery'; boxId: string }
	| OutgoingOptimizeQueryMessage

	// Python / URL
	| { type: 'executePython'; boxId: string; code: string }
	| { type: 'fetchUrl'; boxId: string; url: string }

	// Tool responses (agent tools)
	| { type: 'toolResponse'; requestId: string; result: unknown; error?: string }
	| { type: 'toolStateResponse'; requestId: string; sections: unknown[] }
	| { type: 'openToolResultInEditor'; boxId: string; tool: string; label: string; content: string }
	| { type: 'openMarkdownPreview'; filePath: string }
	| { type: 'openCopilotAgent' }
	| { type: 'copilotChatFirstTimeCheck'; boxId: string }

	// Debug
	| { type: 'debugMdSearchReveal'; phase: string; detail: string }

	// Section diff
	| { type: 'showSectionDiff'; sectionId: string }

	// Provider messages (kqlx, kqlCompat, mdCompat editors)
	| { type: 'requestDocument' }
	| { type: 'persistDocument'; state: unknown; flush?: boolean; reason?: string }
	| { type: 'requestUpgradeToKqlx'; addKind?: string; state?: unknown }
	| { type: 'requestUpgradeToMdx'; addKind?: string; state?: unknown }
	| { type: 'requestUpgradeToSqlx'; addKind?: string; state?: unknown };


/**
 * Send a typed message from the webview to the extension host.
 * Safe to call when `window.vscode` is unavailable (e.g. browser-ext standalone) — silently no-ops.
 */
export function postMessageToHost(msg: OutgoingWebviewMessage): void {
	window.vscode?.postMessage(msg);
}
