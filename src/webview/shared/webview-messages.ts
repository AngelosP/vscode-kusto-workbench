/**
 * Typed messages sent from the webview to the extension host via postMessage.
 *
 * This is the webview-side counterpart to the host's {@link IncomingWebviewMessage}
 * (in queryEditorTypes.ts). It also includes provider-specific messages that the
 * kqlx/kqlCompat/mdCompat editors handle.
 */
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
import {
	isKustoDatabaseDiscoveryWebviewMessageType,
	parseKustoDatabaseDiscoveryWebviewMessage,
	type KustoDatabaseDiscoveryWebviewMessage,
} from '../../shared/kustoDatabaseDiscoveryProtocol.js';
import {
	isSqlDatabaseDiscoveryWebviewMessageType,
	parseSqlDatabaseDiscoveryWebviewMessage,
	type SqlDatabaseDiscoveryWebviewMessage,
} from '../../shared/sqlDatabaseDiscoveryProtocol.js';
import {
	isSqlSchemaWebviewMessageType,
	parseSqlSchemaWebviewMessage,
	type SqlSchemaWebviewMessage,
} from '../../shared/sqlSchemaProtocol.js';
import {
	isKqlLanguageWebviewMessageType,
	parseKqlLanguageWebviewMessage,
	type KqlLanguageWebviewMessage,
} from '../../shared/kqlLanguageProtocol.js';
import {
	isControlCommandSyntaxWebviewMessageType,
	parseControlCommandSyntaxWebviewMessage,
	type ControlCommandSyntaxWebviewMessage,
} from '../../shared/controlCommandSyntaxProtocol.js';
import {
	isResourceUriWebviewMessageType,
	parseResourceUriWebviewMessage,
	type ResourceUriWebviewMessage,
} from '../../shared/resourceUriProtocol.js';
import {
	admitUrlContentWebviewMessage,
	type UrlContentWebviewMessage,
} from '../../shared/urlContentProtocol.js';
import {
	admitPythonExecutionWebviewMessage,
	type PythonExecutionWebviewMessage,
} from '../../shared/pythonExecutionProtocol.js';
import {
	admitArtifactCsvSaveWebviewMessage,
	type ArtifactCsvSaveWebviewMessage,
} from '../../shared/artifactCsvSaveProtocol.js';
import {
	admitSqlStsEditorLanguageWebviewMessage,
	type SqlStsEditorLanguageWebviewMessage,
} from '../../shared/sqlStsEditorLanguageProtocol.js';
import {
	admitSqlConnectionsProjectionWebviewMessage,
	captureSqlConnectionsProjectionWebviewMessage,
	type SqlConnectionsProjectionWebviewMessage,
} from '../../shared/sqlConnectionsProjectionProtocol.js';
import {
	admitKustoConnectionsProjectionWebviewMessage,
	captureKustoConnectionsProjectionWebviewMessage,
	type KustoConnectionsProjectionWebviewMessage,
} from '../../shared/kustoConnectionsProjectionProtocol.js';
import {
	admitQuerySharingWebviewMessage,
	type QuerySharingWebviewMessage,
} from '../../shared/querySharingProtocol.js';
import {
	admitEditingPreferencesWebviewMessage,
	type EditingPreferencesWebviewMessage,
} from '../../shared/editingPreferences.js';
import {
	admitCopilotInlineCompletionWebviewMessage,
	type CopilotInlineCompletionWebviewMessage,
} from '../../shared/copilotInlineCompletionProtocol.js';
import {
	admitKustoPublicationWebviewMessage,
	admitKustoPublicationWebviewMessageFromEnvelope,
	type KustoPublicationWebviewMessage,
} from '../../shared/kustoPublicationProtocol.js';
import type { DevelopmentNoteMutationWebviewMessage } from '../../shared/developmentNoteMutationProtocol.js';
import {
	admitToolStateSnapshotWebviewMessageFromEnvelope,
	type ToolStateSnapshotWebviewMessage,
} from '../../shared/toolStateSnapshotProtocol.js';
import { captureRuntimeMessageEnvelope } from '../../shared/runtimeMessageEnvelope.js';
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
	| KustoPublicationWebviewMessage
	// Connection & database
	| KustoConnectionsProjectionWebviewMessage
	| { type: 'kustoSectionOpen'; boxId: string; sectionInstanceId: string }
	| { type: 'kustoSectionTarget'; boxId: string; sectionInstanceId: string; targetGeneration: number; connectionId?: string; database?: string; connectionRevision?: number; connectionIdentityKey?: string }
	| { type: 'kustoSectionClose'; boxId: string; sectionInstanceId: string }
	| { type: 'kustoExecutionStartedAck'; boxId: string; executionId: string; sectionInstanceId: string; targetGeneration: number; accepted: boolean }
	| OutgoingEditorCursorPositionChangedMessage
	| OutgoingEditorCursorStatusSnapshotRequestMessage
	| KustoDatabaseDiscoveryWebviewMessage
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
	| ResourceUriWebviewMessage
	| { type: 'saveImportedCsv'; csv: string; suggestedFileName?: string }
	| ArtifactCsvSaveWebviewMessage
	| { type: 'cancelDashboardWorkflow'; requestId: string }
	| { type: 'publishToPowerBIAck'; requestId: string; accepted: boolean }
	| { type: 'exportDashboard'; requestId: string; boxId: string; html: string; suggestedFileName?: string; previewHeight?: number; dataSources: Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }> }
	| OutgoingHtmlDashboardUpgradeWithCopilotMessage
	| { type: 'getPbiWorkspaces'; requestId: string; boxId: string }
	| { type: 'checkPbiItemExists'; requestId: string; boxId: string; workspaceId: string; reportId: string }
	| { type: 'publishToPowerBI'; requestId: string; boxId: string; workspaceId: string; reportName: string; pageWidth: number; pageHeight: number; htmlCode: string; dataSources: Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }>; dataMode?: 'import' | 'directQuery'; semanticModelId?: string; reportId?: string; existingReportName?: string; workspaceName?: string; isPersonalWorkspace?: boolean }

	// Settings
	| EditingPreferencesWebviewMessage

	// Query execution
	| OutgoingExecuteQueryMessage
	| { type: 'cancelQuery'; boxId: string; executionId: string; sectionInstanceId: string; targetGeneration: number }
	| QuerySharingWebviewMessage

	// SQL connections & databases
	| SqlConnectionsProjectionWebviewMessage
	| { type: 'sqlSectionOpen'; boxId: string; sectionInstanceId: string }
	| SqlDatabaseDiscoveryWebviewMessage
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
	| SqlSchemaWebviewMessage

	// SQL copilot — unified into Copilot section below

	// Comparisons
	| ({ type: 'comparisonBoxEnsured'; engine?: 'sql' | 'kusto'; requestId: string; sourceBoxId: string; comparisonBoxId: string; kustoTarget?: KustoSectionExecutionTarget } & Partial<KustoCopilotRequestIdentity>)
	| { type: 'sqlComparisonAdmissionAck'; phase: 'staged' | 'committed' | 'finalized' | 'completed' | 'rolledBack'; requestId: string; sourceBoxId: string; comparisonBoxId: string; accepted: boolean }

	// Schema
	| KustoSchemaWebviewMessage
	| SqlStsEditorLanguageWebviewMessage
	| { type: 'sqlComparisonRemoved'; boxId: string; sourceBoxId?: string }
	| KqlLanguageWebviewMessage
	| ControlCommandSyntaxWebviewMessage

	// Copilot
	| { type: 'checkCopilotAvailability'; boxId: string }
	| { type: 'prepareCopilotWriteQuery'; boxId: string; flavor?: 'kusto' | 'sql' }
	| OutgoingStartCopilotWriteQueryMessage
	| ({ type: 'cancelCopilotWriteQuery'; boxId: string; flavor: 'kusto' } & KustoCopilotRequestIdentity)
	| { type: 'cancelCopilotWriteQuery'; boxId: string; flavor?: 'sql' }
	| ({ type: 'clearCopilotConversation'; flavor: 'kusto' } & KustoCopilotRequestIdentity)
	| { type: 'clearCopilotConversation'; boxId: string; flavor?: 'sql' }
	| { type: 'removeFromCopilotHistory'; boxId: string; entryId: string }
	| CopilotInlineCompletionWebviewMessage

	// Optimize
	| ({ type: 'prepareOptimizeQuery'; query: string } & KustoOptimizeRequestIdentity)
	| ({ type: 'cancelOptimizeQuery' } & KustoOptimizeRequestIdentity)
	| OutgoingOptimizeQueryMessage

	// Python / URL
	| PythonExecutionWebviewMessage
	| UrlContentWebviewMessage

	// Tool responses (agent tools)
	| DevelopmentNoteMutationWebviewMessage
	| { type: 'toolResponse'; requestId: string; result: unknown; error?: string }
	| { type: 'toolExecutionStarted'; requestId: string; owner: KustoExecutionRequestIdentity }
	| ToolStateSnapshotWebviewMessage
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

export const runtimeOutgoingWebviewMessageTypes = [
	'fileOpenTrace',
	'getConnections',
	'kustoPublicationAck',
	'kustoSectionOpen',
	'kustoSectionTarget',
	'kustoSectionClose',
	'kustoExecutionStartedAck',
	'editorCursorPositionChanged',
	'getEditorCursorStatusSnapshot',
	'getDatabases',
	'refreshDatabases',
	'saveLastSelection',
	'promptAddConnection',
	'addConnection',
	'testKustoConnection',
	'promptImportConnectionsXml',
	'addConnectionsForClusters',
	'importConnectionsFromXml',
	'requestAddFavorite',
	'removeFavorite',
	'confirmRemoveFavorite',
	'requestAddSqlFavorite',
	'removeSqlFavorite',
	'showInfo',
	'showPowerBiPublishHelp',
	'showPowerBiPartialPublishWarning',
	'seeCachedValues',
	'resolveResourceUri',
	'saveImportedCsv',
	'requestArtifactCsvSave',
	'artifactCsvSaveData',
	'cancelArtifactCsvSaveIntent',
	'cancelDashboardWorkflow',
	'publishToPowerBIAck',
	'exportDashboard',
	'getPbiWorkspaces',
	'checkPbiItemExists',
	'publishToPowerBI',
	'setCaretDocsEnabled',
	'setAutoTriggerAutocompleteEnabled',
	'setCopilotInlineCompletionsEnabled',
	'executeQuery',
	'cancelQuery',
	'executeSqlQuery',
	'cancelSqlQuery',
	'copyAdeLink',
	'shareToClipboard',
	'getSqlConnections',
	'sqlSectionOpen',
	'getSqlDatabases',
	'refreshSqlDatabases',
	'retireSqlTarget',
	'saveSqlLastSelection',
	'promptAddSqlConnection',
	'addSqlConnection',
	'testSetSqlAuthOverride',
	'testClearSqlAuthOverride',
	'prefetchSqlSchema',
	'comparisonBoxEnsured',
	'sqlComparisonAdmissionAck',
	'sqlComparisonRemoved',
	'prefetchSchema',
	'requestCrossClusterSchema',
	'stsRequest',
	'stsDidOpen',
	'stsDidChange',
	'stsDidClose',
	'stsConnect',
	'kqlLanguageRequest',
	'fetchControlCommandSyntax',
	'checkCopilotAvailability',
	'prepareCopilotWriteQuery',
	'startCopilotWriteQuery',
	'cancelCopilotWriteQuery',
	'clearCopilotConversation',
	'removeFromCopilotHistory',
	'requestCopilotInlineCompletion',
	'prepareOptimizeQuery',
	'cancelOptimizeQuery',
	'optimizeQuery',
	'executePython',
	'fetchUrl',
	'toolResponse',
	'toolExecutionStarted',
	'toolStateResponse',
	'openToolResultInEditor',
	'openMarkdownPreview',
	'openCopilotAgent',
	'copilotChatFirstTimeCheck',
	'requestHtmlDashboardUpgradeWithCopilot',
	'showSectionDiff',
	'mainWebviewDispatcherReady',
	'requestDocument',
	'persistDocument',
	'documentReloadResult',
	'requestUpgradeToKqlx',
	'requestUpgradeToMdx',
	'requestUpgradeToSqlx',
	'markdownDocumentCommand',
	'markdownDocumentCommandBarrierResult',
] as const satisfies readonly OutgoingWebviewMessage['type'][];

const runtimeOutgoingWebviewMessageTypeSet = new Set<string>(runtimeOutgoingWebviewMessageTypes);


/**
 * Send a typed message from the webview to the extension host.
 * Safe to call when `window.vscode` is unavailable (e.g. browser-ext standalone) — silently no-ops.
 */
export function postMessageToHost(msg: OutgoingWebviewMessage): void {
	const envelope = captureRuntimeMessageEnvelope(msg);
	if (!envelope.ok || !runtimeOutgoingWebviewMessageTypeSet.has(envelope.value.type)) {
		console.error('[kusto] Rejected invalid outbound message envelope.');
		return;
	}
	let message = envelope.value as unknown as OutgoingWebviewMessage;
	const rawKustoPublicationAdmission = admitKustoPublicationWebviewMessageFromEnvelope(
		envelope.descriptorSnapshot,
	);
	if (rawKustoPublicationAdmission.recognized) {
		if (!rawKustoPublicationAdmission.parsed.ok) {
			console.error('[kusto] Rejected invalid Kusto publication acknowledgement:', rawKustoPublicationAdmission.parsed.error);
			return;
		}
		message = rawKustoPublicationAdmission.parsed.value;
	}
	const rawToolStateAdmission = rawKustoPublicationAdmission.recognized
		? { recognized: false as const }
		: admitToolStateSnapshotWebviewMessageFromEnvelope(envelope.descriptorSnapshot);
	if (rawToolStateAdmission.recognized) {
		if (!rawToolStateAdmission.parsed.ok) {
			console.error('[kusto] Rejected invalid tool-state response:', rawToolStateAdmission.parsed.error);
			return;
		}
		message = rawToolStateAdmission.parsed.value;
	}
	let outbound: OutgoingWebviewMessage | DocumentViewWebviewMessage | CompatibilityPersistenceWebviewMessage = message;
	const kustoPublicationAdmission = admitKustoPublicationWebviewMessage(message);
	const editingPreferencesAdmission = kustoPublicationAdmission.recognized
		? { recognized: false as const }
		: admitEditingPreferencesWebviewMessage(message);
	const copilotInlineCompletionAdmission = editingPreferencesAdmission.recognized
		? { recognized: false as const }
		: admitCopilotInlineCompletionWebviewMessage(message);
	const kustoConnectionsProjectionAdmission = editingPreferencesAdmission.recognized
		|| copilotInlineCompletionAdmission.recognized
		? { recognized: false as const }
		: admitKustoConnectionsProjectionWebviewMessage(message);
	const sqlConnectionsProjectionAdmission = kustoConnectionsProjectionAdmission.recognized
		? { recognized: false as const }
		: admitSqlConnectionsProjectionWebviewMessage(message);
	const stsEditorLanguageAdmission = sqlConnectionsProjectionAdmission.recognized
		? { recognized: false as const }
		: admitSqlStsEditorLanguageWebviewMessage(message);
	const artifactCsvSaveAdmission = stsEditorLanguageAdmission.recognized
		? { recognized: false as const }
		: admitArtifactCsvSaveWebviewMessage(message);
	const pythonExecutionAdmission = stsEditorLanguageAdmission.recognized || artifactCsvSaveAdmission.recognized
		? { recognized: false as const }
		: admitPythonExecutionWebviewMessage(message);
	const querySharingAdmission = stsEditorLanguageAdmission.recognized
		|| artifactCsvSaveAdmission.recognized || pythonExecutionAdmission.recognized
		? { recognized: false as const }
		: admitQuerySharingWebviewMessage(message);
	const urlContentAdmission = stsEditorLanguageAdmission.recognized
		|| artifactCsvSaveAdmission.recognized || pythonExecutionAdmission.recognized
		|| querySharingAdmission.recognized
		? { recognized: false as const }
		: admitUrlContentWebviewMessage(message);
	if (kustoPublicationAdmission.recognized) {
		if (!kustoPublicationAdmission.parsed.ok) {
			console.error('[kusto] Rejected invalid Kusto publication acknowledgement:', kustoPublicationAdmission.parsed.error);
			return;
		}
		outbound = kustoPublicationAdmission.parsed.value;
	} else if (editingPreferencesAdmission.recognized) {
		if (!editingPreferencesAdmission.parsed.ok) {
			console.error('[kusto] Rejected invalid editing preferences webview message:', editingPreferencesAdmission.parsed.error);
			return;
		}
		outbound = editingPreferencesAdmission.parsed.value;
	} else if (copilotInlineCompletionAdmission.recognized) {
		if (!copilotInlineCompletionAdmission.parsed.ok) {
			console.error('[kusto] Rejected invalid Copilot inline-completion webview message:', copilotInlineCompletionAdmission.parsed.error);
			return;
		}
		outbound = copilotInlineCompletionAdmission.parsed.value;
	} else if (kustoConnectionsProjectionAdmission.recognized) {
		if (!kustoConnectionsProjectionAdmission.parsed.ok) {
			console.error('[kusto] Rejected invalid Kusto connections projection webview message:', kustoConnectionsProjectionAdmission.parsed.error);
			return;
		}
		const captured = captureKustoConnectionsProjectionWebviewMessage(kustoConnectionsProjectionAdmission.parsed.value);
		if (!captured.ok) {
			console.error('[kusto] Rejected unstable Kusto connections projection webview message:', captured.error);
			return;
		}
		outbound = captured.value;
	} else if (sqlConnectionsProjectionAdmission.recognized) {
		if (!sqlConnectionsProjectionAdmission.parsed.ok) {
			console.error('[kusto] Rejected invalid SQL connections projection webview message:', sqlConnectionsProjectionAdmission.parsed.error);
			return;
		}
		const captured = captureSqlConnectionsProjectionWebviewMessage(sqlConnectionsProjectionAdmission.parsed.value);
		if (!captured.ok) {
			console.error('[kusto] Rejected unstable SQL connections projection webview message:', captured.error);
			return;
		}
		outbound = captured.value;
	} else if (stsEditorLanguageAdmission.recognized) {
		if (!stsEditorLanguageAdmission.parsed.ok) {
			console.error('[kusto] Rejected invalid SQL STS editor-language webview message:', stsEditorLanguageAdmission.parsed.error);
			return;
		}
		outbound = stsEditorLanguageAdmission.parsed.value;
	} else if (artifactCsvSaveAdmission.recognized) {
		if (!artifactCsvSaveAdmission.parsed.ok) {
			console.error('[kusto] Rejected invalid artifact CSV save webview message:', artifactCsvSaveAdmission.parsed.error);
			return;
		}
		outbound = artifactCsvSaveAdmission.parsed.value;
	} else if (pythonExecutionAdmission.recognized) {
		if (!pythonExecutionAdmission.parsed.ok) {
			console.error('[kusto] Rejected invalid Python execution webview message:', pythonExecutionAdmission.parsed.error);
			return;
		}
		outbound = pythonExecutionAdmission.parsed.value;
	} else if (querySharingAdmission.recognized) {
		if (!querySharingAdmission.parsed.ok) {
			console.error('[kusto] Rejected invalid query sharing webview message:', querySharingAdmission.parsed.error);
			return;
		}
		outbound = querySharingAdmission.parsed.value;
	} else if (urlContentAdmission.recognized) {
		if (!urlContentAdmission.parsed.ok) {
			console.error('[kusto] Rejected invalid URL content webview message:', urlContentAdmission.parsed.error);
			return;
		}
		outbound = urlContentAdmission.parsed.value;
	} else if (pState.compatibilityPersistenceViewSessionId && isCompatibilityPersistenceWebviewMessageType(message)) {
		const input = message.type === 'requestDocument'
			? {
				type: 'requestDocument' as const,
				requestId: typeof message.requestId === 'string' && message.requestId.trim()
					? message.requestId.trim()
					: createCompatibilityDocumentRequestId(),
			}
			: message as unknown as CompatibilityPersistenceWebviewMessageInput;
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
	} else if (pState.documentViewSessionId && isDocumentViewWebviewMessageType(message)) {
		const parsed = stampDocumentViewWebviewMessage(
			pState.documentViewSessionId,
			message as DocumentViewWebviewMessageInput,
		);
		if (!parsed.ok) {
			console.error('[kusto] Rejected invalid document-view webview message:', parsed.error);
			return;
		}
		outbound = parsed.value;
	} else if (isKustoDatabaseDiscoveryWebviewMessageType(message)) {
		const parsed = parseKustoDatabaseDiscoveryWebviewMessage(message);
		if (!parsed.ok) {
			console.error('[kusto] Rejected invalid Kusto database discovery webview message:', parsed.error);
			return;
		}
		outbound = parsed.value;
	} else if (isSqlDatabaseDiscoveryWebviewMessageType(message)) {
		const parsed = parseSqlDatabaseDiscoveryWebviewMessage(message);
		if (!parsed.ok) {
			console.error('[kusto] Rejected invalid SQL database discovery webview message:', parsed.error);
			return;
		}
		outbound = parsed.value;
	} else if (isSqlSchemaWebviewMessageType(message)) {
		const parsed = parseSqlSchemaWebviewMessage(message);
		if (!parsed.ok) {
			console.error('[kusto] Rejected invalid SQL schema webview message:', parsed.error);
			return;
		}
		outbound = parsed.value;
	} else if (isKqlLanguageWebviewMessageType(message)) {
		const parsed = parseKqlLanguageWebviewMessage(message);
		if (!parsed.ok) {
			console.error('[kusto] Rejected invalid KQL language webview message:', parsed.error);
			return;
		}
		outbound = parsed.value;
	} else if (isControlCommandSyntaxWebviewMessageType(message)) {
		const parsed = parseControlCommandSyntaxWebviewMessage(message);
		if (!parsed.ok) {
			console.error('[kusto] Rejected invalid control-command syntax webview message:', parsed.error);
			return;
		}
		outbound = parsed.value;
	} else if (isResourceUriWebviewMessageType(message)) {
		const parsed = parseResourceUriWebviewMessage(message);
		if (!parsed.ok) {
			console.error('[kusto] Rejected invalid resource URI webview message:', parsed.error);
			return;
		}
		outbound = parsed.value;
	} else if (isKustoSchemaWebviewMessageType(message)) {
		const parsed = parseKustoSchemaWebviewMessage(message);
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
