/**
 * Typed messages sent from the webview to the extension host via postMessage.
 *
 * This is the webview-side counterpart to the host's {@link IncomingWebviewMessage}
 * (in queryEditorTypes.ts). It also includes provider-specific messages that the
 * kqlx/kqlCompat/mdCompat editors handle.
 */
import type { KustoEditorLifecycleIdentity } from '../../shared/kustoSchemaLifecycle.js';
import type { KustoSectionExecutionTarget } from '../../shared/kustoExecution.js';
import type { KustoExecutionRequestIdentity } from '../../shared/kustoExecution.js';
import type { KustoCopilotRequestIdentity, KustoOptimizeRequestIdentity } from '../../shared/kustoExecution.js';
import {
	isDocumentViewWebviewMessageType,
	stampDocumentViewWebviewMessage,
	type DocumentViewWebviewMessage,
	type DocumentViewWebviewMessageInput,
} from '../../shared/documentViewProtocol.js';
import {
	isCompatibilityPersistenceWebviewMessageType,
	stampCompatibilityPersistenceWebviewMessage,
	type CompatibilityPersistenceWebviewMessage,
	type CompatibilityPersistenceWebviewMessageInput,
} from '../../shared/compatibilityPersistenceProtocol.js';
import {
	isKustoSchemaWebviewMessageType,
	parseKustoSchemaWebviewMessage,
	type KustoSchemaWebviewMessage,
} from '../../shared/kustoSchemaProtocol.js';
import { pState } from './persistence-state.js';

let compatibilityDocumentRequestSequence = 0;
const MAX_COMPATIBILITY_DOCUMENT_REQUESTS = 64;

function createCompatibilityDocumentRequestId(): string {
	return `compat-document-request-${Date.now()}-${++compatibilityDocumentRequestSequence}`;
}

// ── Query execution & results ──────────────────────────────────────────────

export type OutgoingExecuteQueryMessage = {
	type: 'executeQuery';
	query: string;
	connectionId: string;
	boxId: string;
	executionId: string;
	sectionInstanceId: string;
	targetGeneration: number;
	producer?: 'manual' | 'copilot' | 'comparison' | 'tool';
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
	engine: 'kusto' | 'sql';
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

type OutgoingStartCopilotWriteQueryMessageBase = {
	type: 'startCopilotWriteQuery';
	boxId: string;
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

export type OutgoingStartCopilotWriteQueryMessage =
	| (OutgoingStartCopilotWriteQueryMessageBase & KustoCopilotRequestIdentity & { flavor: 'kusto' })
	| (OutgoingStartCopilotWriteQueryMessageBase & { flavor: 'sql'; sqlOwnerToken?: string });

export type OutgoingOptimizeQueryMessage = KustoOptimizeRequestIdentity & {
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
	connections: Array<{ name: string; clusterUrl: string; database?: string; authorityId?: string }>;
	boxId?: string;
};

export type OutgoingEditorCursorPositionChangedMessage = {
	type: 'editorCursorPositionChanged';
	boxId?: string;
	editorKind?: 'kusto' | 'sql' | 'html' | 'python' | 'markdown';
	line?: number;
	column?: number;
	visible?: boolean;
	reason?: string;
};

export type OutgoingEditorCursorStatusSnapshotRequestMessage = {
	type: 'getEditorCursorStatusSnapshot';
	requestId?: string;
};

export type OutgoingHtmlDashboardUpgradeWithCopilotMessage = {
	type: 'requestHtmlDashboardUpgradeWithCopilot';
	sectionId: string;
	sectionName?: string;
	targetVersion: number;
	reasons?: string[];
};

export type OutgoingPowerBiPublishHelpMessage = {
	type: 'showPowerBiPublishHelp';
	requestId: string;
	sectionId: string;
	sectionName?: string;
	targetVersion?: number;
	reasons?: string[];
};

export type OutgoingPowerBiPartialPublishWarningMessage = {
	type: 'showPowerBiPartialPublishWarning';
	requestId: string;
	sectionId: string;
	sectionName?: string;
	targetVersion?: number;
	reasons?: string[];
};

// ── The union ──────────────────────────────────────────────────────────────

export type OutgoingWebviewMessage =
	| { type: 'fileOpenTrace'; event: string; timeMs?: number; sequence?: number; detail?: unknown }
	| { type: 'kustoPublicationAck'; publicationId: string; phase: 'staged' | 'applied'; accepted: boolean }
	// Connection & database
	| { type: 'getConnections'; policyRequestId?: string }
	| { type: 'kustoSectionOpen'; boxId: string; sectionInstanceId: string }
	| { type: 'kustoSectionTarget'; boxId: string; sectionInstanceId: string; targetGeneration: number; connectionId?: string; database?: string; connectionRevision?: number; connectionIdentityKey?: string }
	| { type: 'kustoSectionClose'; boxId: string; sectionInstanceId: string }
	| { type: 'kustoExecutionStartedAck'; boxId: string; executionId: string; sectionInstanceId: string; targetGeneration: number; accepted: boolean }
	| OutgoingEditorCursorPositionChangedMessage
	| OutgoingEditorCursorStatusSnapshotRequestMessage
	| ({ type: 'getDatabases'; connectionId: string; boxId: string; requestToken?: string; requiredDatabase?: string } & Partial<KustoEditorLifecycleIdentity>)
	| ({ type: 'refreshDatabases'; connectionId: string; boxId: string; requestToken?: string; requiredDatabase?: string } & Partial<KustoEditorLifecycleIdentity>)
	| { type: 'saveLastSelection'; connectionId: string; database?: string }
	| { type: 'promptAddConnection'; boxId?: string }
	| { type: 'addConnection'; name: string; clusterUrl: string; database?: string; authorityId?: string; accountId?: string; boxId?: string }
	| { type: 'testKustoConnection'; name?: string; clusterUrl: string; database?: string; authorityId?: string; accountId?: string; boxId?: string }
	| { type: 'promptImportConnectionsXml'; boxId?: string }
	| { type: 'addConnectionsForClusters'; clusterUrls: string[]; boxId?: string }
	| OutgoingImportConnectionsFromXmlMessage

	// Favorites
	| { type: 'requestAddFavorite'; connectionId: string; clusterUrl: string; database: string; defaultName?: string; boxId?: string }
	| { type: 'removeFavorite'; connectionId: string; clusterUrl: string; database: string; boxId?: string }
	| { type: 'confirmRemoveFavorite'; requestId: string; label?: string; connectionId: string; clusterUrl: string; database: string; boxId?: string }

	// SQL favorites
	| { type: 'requestAddSqlFavorite'; connectionId: string; database: string; defaultName?: string; boxId?: string }
	| { type: 'removeSqlFavorite'; connectionId: string; database: string; boxId?: string }

	// Info & UI
	| { type: 'showInfo'; message: string }
	| OutgoingPowerBiPublishHelpMessage
	| OutgoingPowerBiPartialPublishWarningMessage
	| { type: 'seeCachedValues' }
	| { type: 'resolveResourceUri'; requestId: string; path: string; baseUri?: string }
	| { type: 'saveImportedCsv'; csv: string; suggestedFileName?: string }
	| { type: 'requestArtifactCsvSave'; requestId: string; boxId: string; artifactId: string; suggestedFileName?: string }
	| { type: 'artifactCsvSaveData'; requestId: string; boxId: string; artifactId: string; accepted: boolean; csv?: string }
	| { type: 'cancelArtifactCsvSaveIntent'; requestId: string }
	| { type: 'cancelDashboardWorkflow'; requestId: string }
	| { type: 'publishToPowerBIAck'; requestId: string; accepted: boolean }
	| { type: 'exportDashboard'; requestId: string; boxId: string; html: string; suggestedFileName?: string; previewHeight?: number; dataSources: Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }> }
	| OutgoingHtmlDashboardUpgradeWithCopilotMessage
	| { type: 'getPbiWorkspaces'; requestId: string; boxId: string }
	| { type: 'checkPbiItemExists'; requestId: string; boxId: string; workspaceId: string; reportId: string }
	| { type: 'publishToPowerBI'; requestId: string; boxId: string; workspaceId: string; reportName: string; pageWidth: number; pageHeight: number; htmlCode: string; dataSources: Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }>; dataMode?: 'import' | 'directQuery'; semanticModelId?: string; reportId?: string; existingReportName?: string; workspaceName?: string; isPersonalWorkspace?: boolean }

	// Settings
	| { type: 'setCaretDocsEnabled'; enabled: boolean }
	| { type: 'setAutoTriggerAutocompleteEnabled'; enabled: boolean }
	| { type: 'setCopilotInlineCompletionsEnabled'; enabled: boolean }

	// Query execution
	| OutgoingExecuteQueryMessage
	| { type: 'cancelQuery'; boxId: string; executionId: string; sectionInstanceId: string; targetGeneration: number }
	| OutgoingCopyAdeLinkMessage
	| OutgoingShareToClipboardMessage

	// SQL connections & databases
	| { type: 'getSqlConnections' }
	| { type: 'sqlSectionOpen'; boxId: string; sectionInstanceId: string }
	| { type: 'getSqlDatabases'; sqlConnectionId: string; boxId: string; sectionInstanceId: string; targetGeneration: number }
	| { type: 'refreshSqlDatabases'; sqlConnectionId: string; boxId: string; sectionInstanceId: string; targetGeneration: number }
	| { type: 'retireSqlTarget'; boxId: string; sectionInstanceId: string; targetGeneration: number }
	| { type: 'saveSqlLastSelection'; sqlConnectionId: string; database?: string }
	| { type: 'promptAddSqlConnection'; boxId?: string }
	| { type: 'addSqlConnection'; name: string; serverUrl: string; dialect: string; authType: string; database?: string; port?: number; username?: string; password?: string; boxId?: string }
	| { type: 'testSetSqlAuthOverride'; serverUrl: string; accountId: string; token: string }
	| { type: 'testClearSqlAuthOverride'; accountId: string }

	// SQL query execution
	| {
		type: 'executeSqlQuery'; query: string; sqlConnectionId: string; boxId: string; sectionInstanceId: string; database: string; queryMode?: string; ownerToken: string;
		executionId: string;
		toolExecution?: boolean;
		expectedOwner?: { connectionId: string; database: string; targetSignature: string; principalFingerprint: string; revocationGeneration: number };
	}
	| { type: 'cancelSqlQuery'; boxId: string; sectionInstanceId: string; executionId?: string }

	// SQL schema
	| { type: 'prefetchSqlSchema'; sqlConnectionId: string; database: string; boxId: string; sectionInstanceId: string; targetGeneration: number; forceRefresh?: boolean }

	// SQL copilot — unified into Copilot section below

	// Comparisons
	| ({ type: 'comparisonBoxEnsured'; engine?: 'sql' | 'kusto'; requestId: string; sourceBoxId: string; comparisonBoxId: string; kustoTarget?: KustoSectionExecutionTarget } & Partial<KustoCopilotRequestIdentity>)
	| { type: 'sqlComparisonAdmissionAck'; phase: 'staged' | 'committed' | 'finalized' | 'completed' | 'rolledBack'; requestId: string; sourceBoxId: string; comparisonBoxId: string; accepted: boolean }

	// Schema
	| KustoSchemaWebviewMessage
	| { type: 'stsRequest'; requestId: string; method: string; params: { boxId: string; sectionInstanceId: string; line: number; column: number; ownerToken?: string; targetGeneration?: number } }
	| { type: 'stsDidOpen'; boxId: string; sectionInstanceId: string; text: string }
	| { type: 'stsDidChange'; boxId: string; sectionInstanceId: string; text: string }
	| { type: 'stsDidClose'; boxId: string; sectionInstanceId: string }
	| { type: 'sqlComparisonRemoved'; boxId: string; sourceBoxId?: string }
	| {
		type: 'stsConnect'; boxId: string; sectionInstanceId: string; sqlConnectionId: string; database: string; targetGeneration: number;
		expectedOwner?: { connectionId: string; database: string; targetSignature: string; principalFingerprint: string; revocationGeneration: number };
	}
	| OutgoingKqlLanguageRequestMessage
	| OutgoingFetchControlCommandSyntaxMessage

	// Copilot
	| { type: 'checkCopilotAvailability'; boxId: string }
	| { type: 'prepareCopilotWriteQuery'; boxId: string; flavor?: 'kusto' | 'sql' }
	| OutgoingStartCopilotWriteQueryMessage
	| ({ type: 'cancelCopilotWriteQuery'; boxId: string; flavor: 'kusto' } & KustoCopilotRequestIdentity)
	| { type: 'cancelCopilotWriteQuery'; boxId: string; flavor?: 'sql' }
	| ({ type: 'clearCopilotConversation'; flavor: 'kusto' } & KustoCopilotRequestIdentity)
	| { type: 'clearCopilotConversation'; boxId: string; flavor?: 'sql' }
	| { type: 'removeFromCopilotHistory'; boxId: string; entryId: string }
	| { type: 'requestCopilotInlineCompletion'; requestId: string; boxId: string; textBefore: string; textAfter: string; flavor?: 'kusto' | 'sql'; ownerToken?: string }

	// Optimize
	| ({ type: 'prepareOptimizeQuery'; query: string } & KustoOptimizeRequestIdentity)
	| ({ type: 'cancelOptimizeQuery' } & KustoOptimizeRequestIdentity)
	| OutgoingOptimizeQueryMessage

	// Python / URL
	| { type: 'executePython'; boxId: string; code: string }
	| { type: 'fetchUrl'; boxId: string; url: string; requestId: string }

	// Tool responses (agent tools)
	| { type: 'toolResponse'; requestId: string; result: unknown; error?: string }
	| { type: 'toolExecutionStarted'; requestId: string; owner: KustoExecutionRequestIdentity }
	| { type: 'toolStateResponse'; requestId: string; sections: unknown[]; error?: string }
	| { type: 'openToolResultInEditor'; boxId: string; tool: string; label: string; content: string }
	| { type: 'openMarkdownPreview'; filePath: string }
	| { type: 'openCopilotAgent' }
	| { type: 'copilotChatFirstTimeCheck'; boxId: string }

	// Section diff
	| { type: 'showSectionDiff'; sectionId: string }

	// Provider messages (kqlx, kqlCompat, mdCompat editors)
	| { type: 'mainWebviewDispatcherReady' }
	| { type: 'requestDocument'; requestId?: string }
	| { type: 'persistDocument'; state: unknown; sourceGeneration?: number; flush?: boolean; reason?: string; editRevision?: number; snapshotId?: string; flushRequestId?: string; flushUnavailableReason?: string; testOnlyNoop?: boolean }
	| DocumentViewWebviewMessageInput
	| { type: 'requestUpgradeToKqlx'; addKind?: string; state?: unknown; editRevision?: number }
	| { type: 'requestUpgradeToMdx'; addKind?: string; state?: unknown; editRevision?: number }
	| { type: 'requestUpgradeToSqlx'; addKind?: string; state?: unknown; editRevision?: number };


/**
 * Send a typed message from the webview to the extension host.
 * Safe to call when `window.vscode` is unavailable (e.g. browser-ext standalone) — silently no-ops.
 */
export function postMessageToHost(msg: OutgoingWebviewMessage): void {
	let outbound: OutgoingWebviewMessage | DocumentViewWebviewMessage | CompatibilityPersistenceWebviewMessage = msg;
	if (pState.compatibilityPersistenceViewSessionId && isCompatibilityPersistenceWebviewMessageType(msg)) {
		const input = msg.type === 'requestDocument'
			? {
				type: 'requestDocument' as const,
				requestId: typeof msg.requestId === 'string' && msg.requestId.trim()
					? msg.requestId.trim()
					: createCompatibilityDocumentRequestId(),
			}
			: msg as unknown as CompatibilityPersistenceWebviewMessageInput;
		const parsed = stampCompatibilityPersistenceWebviewMessage(
			pState.compatibilityPersistenceViewSessionId,
			input,
			pState.documentKind === 'kql' || pState.documentKind === 'sql'
				? pState.documentKind
				: undefined,
		);
		if (!parsed.ok) {
			console.error('[kusto] Rejected invalid compatibility persistence webview message:', parsed.error);
			return;
		}
		if (parsed.value.type === 'requestDocument') {
			pState.compatibilityPersistenceDocumentRequestIds.add(parsed.value.requestId);
			while (pState.compatibilityPersistenceDocumentRequestIds.size > MAX_COMPATIBILITY_DOCUMENT_REQUESTS) {
				pState.compatibilityPersistenceDocumentRequestIds.delete(
					pState.compatibilityPersistenceDocumentRequestIds.values().next().value!,
				);
			}
		}
		outbound = parsed.value;
	} else if (pState.documentViewSessionId && isDocumentViewWebviewMessageType(msg)) {
		const parsed = stampDocumentViewWebviewMessage(
			pState.documentViewSessionId,
			msg as DocumentViewWebviewMessageInput,
		);
		if (!parsed.ok) {
			console.error('[kusto] Rejected invalid document-view webview message:', parsed.error);
			return;
		}
		outbound = parsed.value;
	} else if (isKustoSchemaWebviewMessageType(msg)) {
		const parsed = parseKustoSchemaWebviewMessage(msg);
		if (!parsed.ok) {
			console.error('[kusto] Rejected invalid Kusto schema webview message:', parsed.error);
			return;
		}
		outbound = parsed.value;
	}
	const e2eCaptureHostMessage = (window as any).__e2eCaptureHostMessage;
	if (typeof e2eCaptureHostMessage === 'function') {
		if (e2eCaptureHostMessage(outbound) === false) {
			return;
		}
	}
	window.vscode?.postMessage(outbound);
}
