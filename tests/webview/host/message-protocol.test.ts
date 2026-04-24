/**
 * Message Protocol Contract Tests
 *
 * Verifies that the host ↔ webview postMessage protocol stays in sync.
 * This catches protocol drift at test time — when one side adds/removes a
 * message type but the other side isn't updated.
 *
 * NOT behavioral tests — those live in message-handler.test.ts.
 */
import { describe, it, expect } from 'vitest';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';
import type { OutgoingWebviewMessage } from '../../../src/webview/shared/webview-messages';

// ─── Type-level helpers ──────────────────────────────────────────────────────
// These force a compile error if the union discriminants change.

type ExtractType<T> = T extends { type: infer U } ? U : never;

type IncomingType = ExtractType<IncomingWebviewMessage>;
type OutgoingType = ExtractType<OutgoingWebviewMessage>;

// Compile-time check: if a type literal is not a valid discriminant, tsc errors.
function assertIncomingType(_t: IncomingType): void { /* type-only */ }
function assertOutgoingType(_t: OutgoingType): void { /* type-only */ }

// ─── Manually maintained type inventories ────────────────────────────────────
// When you add a new message type, add it here too.
// The tests below verify these arrays stay in sync with each other AND catch
// compile errors when discriminants vanish from the union types.

/**
 * Every `type` discriminant in the host's IncomingWebviewMessage union
 * (queryEditorTypes.ts). These are messages the webview sends to the host's
 * main query editor provider.
 */
const INCOMING_WEBVIEW_MESSAGE_TYPES = [
	'getConnections',
	'getDatabases',
	'refreshDatabases',
	'saveLastSelection',
	'seeCachedValues',
	'resolveResourceUri',
	'requestAddFavorite',
	'removeFavorite',
	'confirmRemoveFavorite',
	'promptImportConnectionsXml',
	'addConnectionsForClusters',
	'showInfo',
	'saveResultsCsv',
	'setCaretDocsEnabled',
	'setAutoTriggerAutocompleteEnabled',
	'setCopilotInlineCompletionsEnabled',
	'requestCopilotInlineCompletion',
	'executePython',
	'fetchUrl',
	'cancelQuery',
	'checkCopilotAvailability',
	'prepareCopilotWriteQuery',
	'startCopilotWriteQuery',
	'cancelCopilotWriteQuery',
	'clearCopilotConversation',
	'removeFromCopilotHistory',
	'prepareOptimizeQuery',
	'cancelOptimizeQuery',
	'optimizeQuery',
	'executeQuery',
	'copyAdeLink',
	'shareToClipboard',
	'prefetchSchema',
	'requestCrossClusterSchema',
	'promptAddConnection',
	'importConnectionsFromXml',
	'kqlLanguageRequest',
	'fetchControlCommandSyntax',
	'openToolResultInEditor',
	'openMarkdownPreview',
	'comparisonBoxEnsured',
	'comparisonSummary',
	'toolResponse',
	'toolStateResponse',
	'openCopilotAgent',
	'copilotChatFirstTimeCheck',
	'showSectionDiff',
	'exportDashboard',
	'getPbiWorkspaces',
	'checkPbiItemExists',
	'publishToPowerBI',
] as const satisfies readonly IncomingType[];

/**
 * Every `type` discriminant in the webview's OutgoingWebviewMessage union
 * (webview-messages.ts). These are messages the webview can send out.
 */
const OUTGOING_WEBVIEW_MESSAGE_TYPES = [
	// Connection & database
	'getConnections',
	'getDatabases',
	'refreshDatabases',
	'saveLastSelection',
	'promptAddConnection',
	'promptImportConnectionsXml',
	'addConnectionsForClusters',
	'importConnectionsFromXml',

	// Favorites
	'requestAddFavorite',
	'removeFavorite',
	'confirmRemoveFavorite',

	// Info & UI
	'showInfo',
	'seeCachedValues',
	'resolveResourceUri',
	'saveResultsCsv',
	'exportDashboard',
	'getPbiWorkspaces',
	'checkPbiItemExists',
	'publishToPowerBI',

	// Settings
	'setCaretDocsEnabled',
	'setAutoTriggerAutocompleteEnabled',
	'setCopilotInlineCompletionsEnabled',

	// Query execution
	'executeQuery',
	'cancelQuery',
	'copyAdeLink',
	'shareToClipboard',

	// Comparisons
	'comparisonBoxEnsured',
	'comparisonSummary',

	// Schema
	'prefetchSchema',
	'requestCrossClusterSchema',
	'kqlLanguageRequest',
	'fetchControlCommandSyntax',

	// Copilot
	'checkCopilotAvailability',
	'prepareCopilotWriteQuery',
	'startCopilotWriteQuery',
	'cancelCopilotWriteQuery',
	'clearCopilotConversation',
	'removeFromCopilotHistory',
	'requestCopilotInlineCompletion',

	// Optimize
	'prepareOptimizeQuery',
	'cancelOptimizeQuery',
	'optimizeQuery',

	// Python / URL
	'executePython',
	'fetchUrl',

	// Tool responses (agent tools)
	'toolResponse',
	'toolStateResponse',
	'openToolResultInEditor',
	'openMarkdownPreview',
	'openCopilotAgent',
	'copilotChatFirstTimeCheck',

	// Section diff
	'showSectionDiff',

	// Debug
	'debugMdSearchReveal',

	// Provider messages (kqlx, kqlCompat, mdCompat, sqlCompat editors — NOT in IncomingWebviewMessage)
	'requestDocument',
	'persistDocument',
	'requestUpgradeToKqlx',
	'requestUpgradeToMdx',
	'requestUpgradeToSqlx',
] as const satisfies readonly OutgoingType[];

/**
 * OutgoingWebviewMessage types that are handled by editor providers
 * (kqlxEditorProvider, kqlCompatEditorProvider, mdCompatEditorProvider)
 * rather than the main queryEditorProvider. These are NOT in IncomingWebviewMessage.
 */
const PROVIDER_ONLY_OUTGOING_TYPES = new Set([
	'requestDocument',
	'persistDocument',
	'requestUpgradeToKqlx',
	'requestUpgradeToMdx',
	'requestUpgradeToSqlx',
	'debugMdSearchReveal',
]);

/**
 * Every `case` label in the webview's message-handler.ts switch statement.
 * These are messages the webview expects to RECEIVE from the host.
 */
const MESSAGE_HANDLER_CASE_LABELS = [
	'controlCommandSyntaxResult',
	'ensureComparisonBox',
	'persistenceMode',
	'upgradedToKqlx',
	'enabledKqlxSidecar',
	'enabledSqlSidecar',
	'connectionsData',
	'updateDevNotes',
	'favoritesData',
	'confirmRemoveFavoriteResult',
	'documentData',
	'revealTextRange',
	'resolveResourceUriResult',
	'kqlLanguageResponse',
	'databasesData',
	'databasesError',
	'importConnectionsXmlText',
	'importConnectionsXmlError',
	'queryResult',
	'queryError',
	'queryCancelled',
	'ensureResultsVisible',
	'pythonResult',
	'pythonError',
	'urlContent',
	'urlError',
	'schemaData',
	'schemaError',
	'crossClusterSchemaData',
	'crossClusterSchemaError',
	'connectionAdded',
	'copilotChatFirstTimeResult',
	'copilotAvailability',
	'optimizeQueryStatus',
	'compareQueryPerformanceWithQuery',
	'optimizeQueryReady',
	'optimizeQueryOptions',
	'optimizeQueryError',
	'copilotWriteQueryOptions',
	'copilotWriteQueryStatus',
	'copilotWriteQuerySetQuery',
	'copilotWriteQueryExecuting',
	'copilotWriteQueryToolResult',
	'copilotExecutedQuery',
	'copilotGeneralQueryRulesLoaded',
	'copilotUserQuerySnapshot',
	'copilotDevNotesContextLoaded',
	'copilotDevNoteToolCall',
	'copilotClarifyingQuestion',
	'copilotWriteQueryDone',
	'copilotInlineCompletionResult',
	'revealSection',
	'requestToolState',
	'toolAddSection',
	'toolRemoveSection',
	'toolCollapseSection',
	'toolReorderSections',
	'toolConfigureQuerySection',
	'toolExecuteQuery',
	'toolUpdateMarkdownSection',
	'toolConfigureChart',
	'toolConfigureTransformation',
	'toolDelegateToKustoWorkbenchCopilot',
	'shareContentReady',
	'resetCopilotModelSelection',
	'changedSections',
] as const;

/**
 * All host→webview message types sent to the MAIN query editor webview.
 * Excludes messages for other webviews (cachedValuesViewer, connectionManagerViewer).
 */
const HOST_TO_WEBVIEW_TYPES = [
	// queryEditorProvider.ts
	'requestToolState',
	'queryCancelled',
	'showInfo',
	'shareContentReady',
	'controlCommandSyntaxResult',
	'resolveResourceUriResult',
	'kqlLanguageResponse',
	'pythonResult',
	'pythonError',
	'urlError',
	'urlContent',
	'queryResult',
	'queryError',
	'ensureComparisonBox',

	// queryEditorCopilot.ts
	'copilotWriteQueryStatus',
	'copilotAvailability',
	'copilotInlineCompletionResult',
	'copilotWriteQueryOptions',
	'copilotWriteQueryDone',
	'copilotChatFirstTimeResult',
	'copilotGeneralQueryRulesLoaded',
	'copilotDevNotesContextLoaded',
	'copilotUserQuerySnapshot',
	'copilotWriteQueryToolResult',
	'copilotExecutedQuery',
	'copilotWriteQuerySetQuery',
	'copilotWriteQueryExecuting',
	'copilotDevNoteToolCall',
	'copilotClarifyingQuestion',
	'revealSection',
	'ensureResultsVisible',
	'updateDevNotes',
	'optimizeQueryStatus',
	'optimizeQueryOptions',
	'optimizeQueryError',
	'optimizeQueryReady',

	// queryEditorConnection.ts
	'favoritesData',
	'confirmRemoveFavoriteResult',
	'databasesData',
	'databasesError',
	'connectionsData',
	'connectionAdded',
	'importConnectionsXmlText',
	'importConnectionsXmlError',

	// queryEditorSchema.ts
	'schemaData',
	'schemaError',
	'crossClusterSchemaData',
	'crossClusterSchemaError',

	// Editor providers (kqlx/kqlCompat/mdCompat) — same webview
	'persistenceMode',
	'documentData',
	'upgradedToKqlx',
	'enabledKqlxSidecar',
	'enabledSqlSidecar',
	'revealTextRange',
	'changedSections',

	// extension.ts
	'resetCopilotModelSelection',
] as const;

/**
 * Message types handled in message-handler.ts that are part of the tool/comparison
 * framework, sent via kustoWorkbenchTools.sendToWebview() rather than direct
 * queryEditorProvider/queryEditorCopilot/queryEditorConnection/queryEditorSchema
 * postMessage calls. These are excluded from HOST_TO_WEBVIEW_TYPES because they
 * flow through a different dispatch path.
 */
const TOOL_FRAMEWORK_HANDLER_TYPES = new Set([
	'toolAddSection',
	'toolRemoveSection',
	'toolCollapseSection',
	'toolReorderSections',
	'toolConfigureQuerySection',
	'toolExecuteQuery',
	'toolUpdateMarkdownSection',
	'toolConfigureChart',
	'toolConfigureTransformation',
	'toolDelegateToKustoWorkbenchCopilot',
	'compareQueryPerformanceWithQuery',
]);

/**
 * Host sends `showInfo` to the webview but message-handler.ts has no case for it.
 * This is a known benign inconsistency — VS Code's postMessage is fire-and-forget
 * and the info toast was historically shown differently.
 */
const KNOWN_UNHANDLED_HOST_MESSAGES = new Set([
	'showInfo',
]);

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Message Protocol Contract', () => {

	// ─── Compile-time guards ───────────────────────────────────────────────
	// These calls exist solely for the TypeScript compiler to verify that
	// every string literal in our arrays is a valid union discriminant.
	// A missing or renamed type causes a build-time error, not a runtime failure.

	it('INCOMING_WEBVIEW_MESSAGE_TYPES are valid IncomingWebviewMessage discriminants (compile-time)', () => {
		for (const t of INCOMING_WEBVIEW_MESSAGE_TYPES) {
			assertIncomingType(t);
		}
	});

	it('OUTGOING_WEBVIEW_MESSAGE_TYPES are valid OutgoingWebviewMessage discriminants (compile-time)', () => {
		for (const t of OUTGOING_WEBVIEW_MESSAGE_TYPES) {
			assertOutgoingType(t);
		}
	});

	// ─── Webview → Host direction ──────────────────────────────────────────

	describe('Webview → Host (OutgoingWebviewMessage ↔ IncomingWebviewMessage)', () => {
		it('every outgoing type (excluding provider-only) exists in IncomingWebviewMessage', () => {
			const incoming = new Set<string>(INCOMING_WEBVIEW_MESSAGE_TYPES);
			const missing: string[] = [];
			for (const t of OUTGOING_WEBVIEW_MESSAGE_TYPES) {
				if (!PROVIDER_ONLY_OUTGOING_TYPES.has(t) && !incoming.has(t)) {
					missing.push(t);
				}
			}
			expect(missing, 'Outgoing types missing from IncomingWebviewMessage').toEqual([]);
		});

		it('every IncomingWebviewMessage type exists in OutgoingWebviewMessage', () => {
			const outgoing = new Set<string>(OUTGOING_WEBVIEW_MESSAGE_TYPES);
			const missing: string[] = [];
			for (const t of INCOMING_WEBVIEW_MESSAGE_TYPES) {
				if (!outgoing.has(t)) {
					missing.push(t);
				}
			}
			expect(missing, 'Incoming types missing from OutgoingWebviewMessage').toEqual([]);
		});

		it('no duplicates in outgoing types', () => {
			const seen = new Set<string>();
			const dupes: string[] = [];
			for (const t of OUTGOING_WEBVIEW_MESSAGE_TYPES) {
				if (seen.has(t)) dupes.push(t);
				seen.add(t);
			}
			expect(dupes).toEqual([]);
		});

		it('no duplicates in incoming types', () => {
			const seen = new Set<string>();
			const dupes: string[] = [];
			for (const t of INCOMING_WEBVIEW_MESSAGE_TYPES) {
				if (seen.has(t)) dupes.push(t);
				seen.add(t);
			}
			expect(dupes).toEqual([]);
		});
	});

	// ─── Host → Webview direction ──────────────────────────────────────────

	describe('Host → Webview (host postMessage types ↔ message-handler cases)', () => {
		it('every host→webview type has a handler case (or is known-unhandled)', () => {
			const cases = new Set<string>(MESSAGE_HANDLER_CASE_LABELS);
			const missing: string[] = [];
			for (const t of HOST_TO_WEBVIEW_TYPES) {
				if (!cases.has(t) && !KNOWN_UNHANDLED_HOST_MESSAGES.has(t)) {
					missing.push(t);
				}
			}
			expect(missing, 'Host types with no message-handler case').toEqual([]);
		});

		it('every message-handler case is either a known host type or a tool-framework handler', () => {
			const hostTypes = new Set<string>(HOST_TO_WEBVIEW_TYPES);
			const missing: string[] = [];
			for (const c of MESSAGE_HANDLER_CASE_LABELS) {
				if (!hostTypes.has(c) && !TOOL_FRAMEWORK_HANDLER_TYPES.has(c)) {
					missing.push(c);
				}
			}
			expect(missing, 'Handler cases with no known host sender').toEqual([]);
		});

		it('no duplicates in host→webview types', () => {
			const seen = new Set<string>();
			const dupes: string[] = [];
			for (const t of HOST_TO_WEBVIEW_TYPES) {
				if (seen.has(t)) dupes.push(t);
				seen.add(t);
			}
			expect(dupes).toEqual([]);
		});

		it('no duplicates in message-handler case labels', () => {
			const seen = new Set<string>();
			const dupes: string[] = [];
			for (const t of MESSAGE_HANDLER_CASE_LABELS) {
				if (seen.has(t)) dupes.push(t);
				seen.add(t);
			}
			expect(dupes).toEqual([]);
		});
	});

	// ─── Bidirectional consistency ─────────────────────────────────────────

	describe('Bidirectional consistency', () => {
		it('tool-framework handler types are NOT in HOST_TO_WEBVIEW_TYPES', () => {
			const hostTypes = new Set<string>(HOST_TO_WEBVIEW_TYPES);
			const overlap: string[] = [];
			for (const t of TOOL_FRAMEWORK_HANDLER_TYPES) {
				if (hostTypes.has(t)) overlap.push(t);
			}
			expect(overlap, 'Tool-framework types should not be in HOST_TO_WEBVIEW_TYPES').toEqual([]);
		});

		it('provider-only outgoing types are NOT in IncomingWebviewMessage', () => {
			const incoming = new Set<string>(INCOMING_WEBVIEW_MESSAGE_TYPES);
			const overlap: string[] = [];
			for (const t of PROVIDER_ONLY_OUTGOING_TYPES) {
				if (incoming.has(t)) overlap.push(t);
			}
			expect(overlap, 'Provider-only types should not be in IncomingWebviewMessage').toEqual([]);
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// Message Payload Factories & Snapshots
// ═══════════════════════════════════════════════════════════════════════════════

// Factories build valid, deterministic payloads for the most critical messages.
// They serve two purposes:
// 1. Snapshot tests catch unintentional shape drift
// 2. Reusable fixtures for future behavioral tests

function makeQueryResultMessage() {
	return {
		type: 'queryResult' as const,
		boxId: 'query_1',
		result: {
			columns: [
				{ name: 'Timestamp', type: 'datetime' },
				{ name: 'Value', type: 'real' },
			],
			rows: [
				['2025-01-01T00:00:00Z', 42.5],
				['2025-01-02T00:00:00Z', 99.1],
			],
			metadata: {
				executionTime: '00:00:01.234',
				cluster: 'https://cluster1.kusto.windows.net',
				database: 'Logs',
			},
		},
	};
}

function makeConnectionsDataMessage() {
	return {
		type: 'connectionsData' as const,
		connections: [
			{ id: 'conn_1', name: 'Production', clusterUrl: 'https://cluster1.kusto.windows.net' },
			{ id: 'conn_2', name: 'Staging', clusterUrl: 'https://cluster2.kusto.windows.net' },
		],
		lastConnectionId: 'conn_1',
		lastDatabase: 'Logs',
		cachedDatabases: {
			'cluster1.kusto.windows.net': ['Logs', 'Metrics'],
		},
		favorites: [
			{ name: 'Prod Logs', clusterUrl: 'https://cluster1.kusto.windows.net', database: 'Logs' },
		],
		leaveNoTraceClusters: [],
		devNotesEnabled: false,
		copilotChatFirstTimeDismissed: true,
		caretDocsEnabled: true,
		autoTriggerAutocompleteEnabled: true,
		copilotInlineCompletionsEnabled: true,
		caretDocsEnabledUserSet: false,
		autoTriggerAutocompleteEnabledUserSet: false,
		copilotInlineCompletionsEnabledUserSet: false,
	};
}

function makeFavoritesDataMessage() {
	return {
		type: 'favoritesData' as const,
		favorites: [
			{ name: 'Prod Logs', clusterUrl: 'https://cluster1.kusto.windows.net', database: 'Logs' },
			{ name: 'Dev Metrics', clusterUrl: 'https://cluster2.kusto.windows.net', database: 'Metrics' },
		],
		boxId: 'query_1',
	};
}

function makeSchemaDataMessage() {
	return {
		type: 'schemaData' as const,
		boxId: 'query_1',
		connectionId: 'conn_1',
		database: 'Logs',
		clusterUrl: 'https://cluster1.kusto.windows.net',
		requestToken: 'tok_abc123',
		schema: {
			tables: ['StormEvents', 'PopulationData'],
			columnTypesByTable: {
				StormEvents: { StartTime: 'datetime', State: 'string', EventType: 'string', DamageProperty: 'long' },
				PopulationData: { State: 'string', Population: 'long' },
			},
			functions: [
				{ name: 'GetTopStorms', parameters: '(n:int)', body: 'StormEvents | top n by DamageProperty' },
			],
			rawSchemaJson: { /* opaque blob — shape varies by Kusto version */ },
		},
		schemaMeta: {
			fromCache: false,
			isFailoverToCache: false,
			tablesCount: 2,
			columnsCount: 6,
			functionsCount: 1,
			forceRefresh: false,
		},
	};
}

function makeToolAddSectionMessage() {
	return {
		type: 'toolAddSection' as const,
		requestId: 'req_001',
		input: {
			type: 'query',
			name: 'Top Events',
			query: 'StormEvents | take 10',
			clusterUrl: 'https://cluster1.kusto.windows.net',
			database: 'Logs',
		},
	};
}

function makeToolConfigureChartMessage() {
	return {
		type: 'toolConfigureChart' as const,
		requestId: 'req_002',
		input: {
			sectionId: 'chart_1',
			name: 'Events Over Time',
			chartType: 'line',
			xColumn: 'Timestamp',
			yColumns: ['Count'],
			legendColumn: 'EventType',
			dataSourceId: 'query_1',
		},
	};
}

describe('Message Payload Factories', () => {
	it('queryResult payload shape', () => {
		expect(makeQueryResultMessage()).toMatchSnapshot();
	});

	it('connectionsData payload shape', () => {
		expect(makeConnectionsDataMessage()).toMatchSnapshot();
	});

	it('favoritesData payload shape', () => {
		expect(makeFavoritesDataMessage()).toMatchSnapshot();
	});

	it('schemaData payload shape', () => {
		expect(makeSchemaDataMessage()).toMatchSnapshot();
	});

	it('toolAddSection payload shape', () => {
		expect(makeToolAddSectionMessage()).toMatchSnapshot();
	});

	it('toolConfigureChart payload shape', () => {
		expect(makeToolConfigureChartMessage()).toMatchSnapshot();
	});
});

// ─── Export factories for reuse in other test files ────────────────────────

export {
	makeQueryResultMessage,
	makeConnectionsDataMessage,
	makeFavoritesDataMessage,
	makeSchemaDataMessage,
	makeToolAddSectionMessage,
	makeToolConfigureChartMessage,
};
