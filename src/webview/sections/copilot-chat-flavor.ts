/**
 * Webview-side flavor configuration for the copilot chat panel.
 *
 * Captures all DOM, messaging, and behavior differences between
 * Kusto and SQL sections so the controller is fully generic.
 */

export type CopilotChatFlavorId = 'kusto' | 'sql';

export interface WebviewCopilotFlavor {
	readonly id: CopilotChatFlavorId;

	// ── Message type names (webview → host) ────────────────────────────────
	readonly startMessageType: string;
	readonly cancelMessageType: string;
	readonly clearMessageType: string;
	readonly prepareMessageType: string;
	readonly removeHistoryMessageType: string;

	// ── DOM identifiers ────────────────────────────────────────────────────
	/** Prefix inserted between boxId and `_copilot_*` suffixes, e.g. '' for Kusto, '_sql' for SQL. */
	readonly domIdInfix: string;
	/** CSS class prefix for the split container, e.g. 'kusto' or 'sql'. */
	readonly cssClassPrefix: string;
	/** CSS class added to the split container to hide the chat pane. */
	readonly hiddenClass: string;
	/** Tag name of the toolbar element, e.g. 'kw-query-toolbar' or 'kw-sql-toolbar'. */
	readonly toolbarTagName: string;

	// ── Validation ─────────────────────────────────────────────────────────
	/** Message shown when no connection is selected. */
	readonly noConnectionMessage: string;

	// ── Tool panel customization ───────────────────────────────────────────
	/** Tool names treated as "Final step" group in the tools panel. */
	readonly finalToolNames: Set<string>;
	/** Tool name whose executed query results show an "insert as section" button. Null to disable. */
	readonly insertQueryToolName: string | null;

	// ── Feature flags ──────────────────────────────────────────────────────
	/** Whether the `copilot-insert-query` event should create a new query section. */
	readonly supportsInsertQuery: boolean;
	/** Whether the `copilot-open-agent` event should be wired. */
	readonly supportsOpenAgent: boolean;
	/** Whether the `copilot-open-preview` event should be wired. */
	readonly supportsOpenPreview: boolean;
	/** Whether to include `currentQuery` and `queryMode` in the start message. */
	readonly includesQueryContext: boolean;
	/** Tip text shown in the initial notification. Null to suppress. */
	readonly tipHtml: string | null;
}

export const kustoWebviewFlavor: WebviewCopilotFlavor = {
	id: 'kusto',

	startMessageType: 'startCopilotWriteQuery',
	cancelMessageType: 'cancelCopilotWriteQuery',
	clearMessageType: 'clearCopilotConversation',
	prepareMessageType: 'prepareCopilotWriteQuery',
	removeHistoryMessageType: 'removeFromCopilotHistory',

	domIdInfix: '',
	cssClassPrefix: 'kusto',
	hiddenClass: 'kusto-copilot-chat-hidden',
	toolbarTagName: 'kw-query-toolbar',

	noConnectionMessage: 'Select a cluster connection first.',

	finalToolNames: new Set([
		'respond_to_query_performance_optimization_request',
		'respond_to_all_other_queries',
		'ask_user_clarifying_question',
	]),
	insertQueryToolName: 'execute_kusto_query',

	supportsInsertQuery: true,
	supportsOpenAgent: true,
	supportsOpenPreview: true,
	includesQueryContext: true,
	tipHtml: 'Tip: If the ask is very challenging or broad, use the <a href="#" class="copilot-open-agent-link">Kusto Workbench custom agent</a> instead.',
};

export const sqlWebviewFlavor: WebviewCopilotFlavor = {
	id: 'sql',

	startMessageType: 'startCopilotWriteQuery',
	cancelMessageType: 'cancelCopilotWriteQuery',
	clearMessageType: 'clearCopilotConversation',
	prepareMessageType: 'prepareCopilotWriteQuery',
	removeHistoryMessageType: 'removeFromCopilotHistory',

	domIdInfix: '_sql',
	cssClassPrefix: 'sql',
	hiddenClass: 'sql-copilot-chat-hidden',
	toolbarTagName: 'kw-sql-toolbar',

	noConnectionMessage: 'Select a SQL connection first.',

	finalToolNames: new Set([
		'respond_to_query_performance_optimization_request',
		'respond_to_sql_query',
		'ask_user_clarifying_question',
	]),
	insertQueryToolName: 'execute_sql_query',

	supportsInsertQuery: true,
	supportsOpenAgent: true,
	supportsOpenPreview: true,
	includesQueryContext: true,
	tipHtml: 'Tip: If the ask is very challenging or broad, use the <a href="#" class="copilot-open-agent-link">Kusto Workbench custom agent</a> instead.',
};
