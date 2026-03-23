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
	connectionId: string;
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
	| { type: 'promptImportConnectionsXml'; boxId?: string }
	| { type: 'addConnectionsForClusters'; clusterUrls: string[]; boxId?: string }
	| OutgoingImportConnectionsFromXmlMessage

	// Favorites
	| { type: 'requestAddFavorite'; clusterUrl: string; database: string; defaultName?: string; boxId?: string }
	| { type: 'removeFavorite'; clusterUrl: string; database: string; boxId?: string }
	| { type: 'confirmRemoveFavorite'; requestId: string; label?: string; clusterUrl: string; database: string; boxId?: string }

	// Info & UI
	| { type: 'showInfo'; message: string }
	| { type: 'seeCachedValues' }
	| { type: 'resolveResourceUri'; requestId: string; path: string; baseUri?: string }
	| { type: 'saveResultsCsv'; boxId?: string; csv: string; suggestedFileName?: string }

	// Settings
	| { type: 'setCaretDocsEnabled'; enabled: boolean }
	| { type: 'setAutoTriggerAutocompleteEnabled'; enabled: boolean }
	| { type: 'setCopilotInlineCompletionsEnabled'; enabled: boolean }

	// Query execution
	| OutgoingExecuteQueryMessage
	| { type: 'cancelQuery'; boxId: string }
	| OutgoingCopyAdeLinkMessage
	| OutgoingShareToClipboardMessage

	// Comparisons
	| { type: 'comparisonBoxEnsured'; requestId: string; sourceBoxId: string; comparisonBoxId: string }
	| { type: 'comparisonSummary'; sourceBoxId: string; comparisonBoxId: string; dataMatches: boolean; headersMatch?: boolean; rowOrderMatches?: boolean; columnOrderMatches?: boolean }

	// Schema
	| { type: 'prefetchSchema'; connectionId: string; database: string; boxId: string; forceRefresh?: boolean; requestToken?: string }
	| { type: 'requestCrossClusterSchema'; clusterName: string; database: string; boxId: string; requestToken: string }
	| OutgoingKqlLanguageRequestMessage
	| OutgoingFetchControlCommandSyntaxMessage

	// Copilot
	| { type: 'checkCopilotAvailability'; boxId: string }
	| { type: 'prepareCopilotWriteQuery'; boxId: string }
	| OutgoingStartCopilotWriteQueryMessage
	| { type: 'cancelCopilotWriteQuery'; boxId: string }
	| { type: 'clearCopilotConversation'; boxId: string }
	| { type: 'removeFromCopilotHistory'; boxId: string; entryId: string }
	| { type: 'requestCopilotInlineCompletion'; requestId: string; boxId: string; textBefore: string; textAfter: string }

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

	// Dev notes
	| { type: 'updateDevNotesResponse'; requestId: string; success: boolean }

	// Debug
	| { type: 'debugMdSearchReveal'; phase: string; detail: string }

	// Provider messages (kqlx, kqlCompat, mdCompat editors)
	| { type: 'requestDocument' }
	| { type: 'persistDocument'; state: unknown; flush?: boolean; reason?: string }
	| { type: 'requestUpgradeToKqlx'; addKind?: string; state?: unknown }
	| { type: 'requestUpgradeToMdx'; addKind?: string; state?: unknown };


/**
 * Send a typed message from the webview to the extension host.
 * Safe to call when `window.vscode` is unavailable (e.g. browser-ext standalone) — silently no-ops.
 */
export function postMessageToHost(msg: OutgoingWebviewMessage): void {
	window.vscode?.postMessage(msg);
}
