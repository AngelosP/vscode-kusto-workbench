import * as vscode from 'vscode';
import { DatabaseSchemaIndex } from './kustoClient';
import type { KustoComparisonRunIdentity, KustoSectionExecutionTarget } from '../shared/kustoExecution';
import type { KustoExecutionRequestIdentity } from '../shared/kustoExecution';
import type { KustoCopilotRequestIdentity, KustoOptimizeRequestIdentity } from '../shared/kustoExecution';
import type { KustoSchemaWebviewMessage } from '../shared/kustoSchemaProtocol';
import type { KustoDatabaseDiscoveryWebviewMessage } from '../shared/kustoDatabaseDiscoveryProtocol';
import type { SqlDatabaseDiscoveryWebviewMessage } from '../shared/sqlDatabaseDiscoveryProtocol';
import type { SqlSchemaWebviewMessage } from '../shared/sqlSchemaProtocol';
import type { KqlLanguageWebviewMessage } from '../shared/kqlLanguageProtocol';
import type { ControlCommandSyntaxWebviewMessage } from '../shared/controlCommandSyntaxProtocol';
import type { ResourceUriWebviewMessage } from '../shared/resourceUriProtocol';
import type { UrlContentWebviewMessage } from '../shared/urlContentProtocol';
import type { PythonExecutionWebviewMessage } from '../shared/pythonExecutionProtocol';
import type { ArtifactCsvSaveWebviewMessage } from '../shared/artifactCsvSaveProtocol';
import type { SqlStsEditorLanguageWebviewMessage } from '../shared/sqlStsEditorLanguageProtocol';
import type { SqlConnectionsProjectionWebviewMessage } from '../shared/sqlConnectionsProjectionProtocol';
import type { KustoConnectionsProjectionWebviewMessage } from '../shared/kustoConnectionsProjectionProtocol';
import type { QuerySharingWebviewMessage } from '../shared/querySharingProtocol';
import type { EditingPreferencesWebviewMessage } from '../shared/editingPreferences';

export const STORAGE_KEYS = {
	lastConnectionId: 'kusto.lastConnectionId',
	lastDatabase: 'kusto.lastDatabase',
	cachedDatabases: 'kusto.cachedDatabases',
	cachedSchemas: 'kusto.cachedSchemas',
	caretDocsEnabled: 'kusto.caretDocsEnabled',
	autoTriggerAutocompleteEnabled: 'kusto.autoTriggerAutocompleteEnabled',
	copilotInlineCompletionsEnabled: 'kusto.copilotInlineCompletionsEnabled',
	editingPreferencesRevision: 'kusto.editingPreferencesRevision',
	cachedSchemasMigratedToDisk: 'kusto.cachedSchemasMigratedToDisk',
	lastOptimizeCopilotModelId: 'kusto.optimize.lastCopilotModelId',
	favorites: 'kusto.favorites',
	sqlFavorites: 'sql.favorites',
	copilotChatFirstTimeDismissed: 'kusto.copilotChatFirstTimeDismissed'
} as const;

export type KustoFavorite = { name: string; connectionId: string; clusterUrl: string; database: string };
export type SqlFavorite = { name: string; connectionId: string; database: string };

export const DEFAULT_PREFERRED_COPILOT_MODEL_ID = 'gpt-5.6-sol@1.0';

export function findPreferredDefaultCopilotModel(models: vscode.LanguageModelChat[]): vscode.LanguageModelChat | undefined {
	if (models.length === 0) {
		return undefined;
	}
	const preferredModel = models.find(m => m.id === DEFAULT_PREFERRED_COPILOT_MODEL_ID);
	return preferredModel || models[0];
}

export type CachedSchemaEntry = {
	schema: DatabaseSchemaIndex;
	timestamp: number;
	version: number;
	clusterUrl?: string;
	database?: string;
	connectionId?: string;
	accountPartition?: string;
};

export type CacheUnit = 'minutes' | 'hours' | 'days';

export type CopilotLocalTool = {
	name: string;
	label: string;
	description: string;
	enabledByDefault?: boolean;
};

type StartCopilotWriteQueryMessageBase = {
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

export type StartCopilotWriteQueryMessage =
	| (StartCopilotWriteQueryMessageBase & KustoCopilotRequestIdentity & { flavor: 'kusto' })
	| (StartCopilotWriteQueryMessageBase & { flavor: 'sql'; sqlOwnerToken?: string });

export type OptimizeQueryMessage = KustoOptimizeRequestIdentity & {
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
	executionId: string;
	sectionInstanceId: string;
	targetGeneration: number;
	producer?: 'manual' | 'copilot' | 'comparison' | 'tool';
	comparisonRun?: KustoComparisonRunIdentity;
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
	sectionInstanceId: string;
	database: string;
	queryMode?: string;
	ownerToken: string;
	executionId: string;
	comparisonSourceBoxId?: string;
	comparisonSourceExecutionId?: string;
	toolExecution?: boolean;
	expectedOwner?: {
		connectionId: string;
		database: string;
		targetSignature: string;
		principalFingerprint: string;
		revocationGeneration: number;
	};
};

export type ImportConnectionsFromXmlMessage = {
	type: 'importConnectionsFromXml';
	connections: Array<{ name: string; clusterUrl: string; database?: string; authorityId?: string }>;
	boxId?: string;
};

export type PowerBiDataMode = 'import' | 'directQuery';

export type SaveImportedCsvMessage = { type: 'saveImportedCsv'; csv: string; suggestedFileName?: string };
export type CancelDashboardWorkflowMessage = { type: 'cancelDashboardWorkflow'; requestId: string };
export type PublishToPowerBIAckMessage = {
	type: 'publishToPowerBIAck';
	requestId: string;
	accepted: boolean;
};
export type ExportDashboardMessage = {
	type: 'exportDashboard';
	requestId: string;
	boxId: string;
	html: string;
	suggestedFileName?: string;
	previewHeight?: number;
	dataSources: Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }>;
};
export type GetPbiWorkspacesMessage = { type: 'getPbiWorkspaces'; requestId: string; boxId: string };
export type CheckPbiItemExistsMessage = {
	type: 'checkPbiItemExists';
	requestId: string;
	boxId: string;
	workspaceId: string;
	reportId: string;
};
export type RequestHtmlDashboardUpgradeWithCopilotMessage = {
	type: 'requestHtmlDashboardUpgradeWithCopilot';
	sectionId: string;
	sectionName?: string;
	targetVersion: number;
	reasons?: string[];
};
export type ShowPowerBiPublishHelpMessage = {
	type: 'showPowerBiPublishHelp';
	requestId: string;
	sectionId: string;
	sectionName?: string;
	targetVersion?: number;
	reasons?: string[];
};
export type ShowPowerBiPartialPublishWarningMessage = {
	type: 'showPowerBiPartialPublishWarning';
	requestId: string;
	sectionId: string;
	sectionName?: string;
	targetVersion?: number;
	reasons?: string[];
};
export type PublishToPowerBIMessage = {
	type: 'publishToPowerBI';
	requestId: string;
	boxId: string;
	workspaceId: string;
	reportName: string;
	pageWidth: number;
	pageHeight: number;
	htmlCode: string;
	dataSources: Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }>;
	dataMode?: PowerBiDataMode;
	/** Present when updating an existing publish (republish). */
	semanticModelId?: string;
	reportId?: string;
	existingReportName?: string;
	workspaceName?: string;
	isPersonalWorkspace?: boolean;
};

export type EditorCursorPositionChangedMessage = {
	type: 'editorCursorPositionChanged';
	boxId?: string;
	editorKind?: 'kusto' | 'sql' | 'html' | 'python' | 'markdown';
	line?: number;
	column?: number;
	visible?: boolean;
	reason?: string;
};

export type EditorCursorStatusSnapshotRequestMessage = {
	type: 'getEditorCursorStatusSnapshot';
	requestId?: string;
};

export type IncomingWebviewMessage =
	| KustoConnectionsProjectionWebviewMessage
	| { type: 'kustoPublicationAck'; publicationId: string; phase: 'staged' | 'applied'; accepted: boolean }
	| { type: 'fileOpenTrace'; event: string; timeMs?: number; sequence?: number; detail?: unknown }
	| EditorCursorPositionChangedMessage
	| EditorCursorStatusSnapshotRequestMessage
	| KustoDatabaseDiscoveryWebviewMessage
	| { type: 'saveLastSelection'; connectionId: string; database?: string }
	| { type: 'seeCachedValues' }
	| ResourceUriWebviewMessage
	| { type: 'requestAddFavorite'; connectionId: string; clusterUrl: string; database: string; defaultName?: string; boxId?: string }
	| { type: 'removeFavorite'; connectionId: string; clusterUrl: string; database: string; boxId?: string }
	| { type: 'confirmRemoveFavorite'; requestId: string; label?: string; connectionId: string; clusterUrl: string; database: string; boxId?: string }
	| { type: 'promptImportConnectionsXml'; boxId?: string }
	| { type: 'addConnectionsForClusters'; clusterUrls: string[]; boxId?: string }
	| { type: 'showInfo'; message: string }
	| ShowPowerBiPublishHelpMessage
	| ShowPowerBiPartialPublishWarningMessage
	| SaveImportedCsvMessage
	| ArtifactCsvSaveWebviewMessage
	| CancelDashboardWorkflowMessage
	| PublishToPowerBIAckMessage
	| ExportDashboardMessage
	| RequestHtmlDashboardUpgradeWithCopilotMessage
	| GetPbiWorkspacesMessage
	| CheckPbiItemExistsMessage
	| PublishToPowerBIMessage
	| EditingPreferencesWebviewMessage
	| { type: 'requestCopilotInlineCompletion'; requestId: string; boxId: string; textBefore: string; textAfter: string; flavor?: 'kusto' | 'sql'; ownerToken?: string }
	| PythonExecutionWebviewMessage
	| UrlContentWebviewMessage
	| { type: 'kustoSectionOpen'; boxId: string; sectionInstanceId: string }
	| { type: 'kustoSectionTarget'; boxId: string; sectionInstanceId: string; targetGeneration: number; connectionId?: string; database?: string; connectionRevision?: number; connectionIdentityKey?: string }
	| { type: 'kustoSectionClose'; boxId: string; sectionInstanceId: string }
	| { type: 'kustoExecutionStartedAck'; boxId: string; executionId: string; sectionInstanceId: string; targetGeneration: number; accepted: boolean }
	| { type: 'cancelQuery'; boxId: string; executionId: string; sectionInstanceId: string; targetGeneration: number }
	| { type: 'checkCopilotAvailability'; boxId: string }
	| { type: 'prepareCopilotWriteQuery'; boxId: string; flavor?: 'kusto' | 'sql' }
	| StartCopilotWriteQueryMessage
	| ({ type: 'cancelCopilotWriteQuery'; boxId: string; flavor: 'kusto' } & KustoCopilotRequestIdentity)
	| { type: 'cancelCopilotWriteQuery'; boxId: string; flavor?: 'sql' }
	| ({ type: 'clearCopilotConversation'; flavor: 'kusto' } & KustoCopilotRequestIdentity)
	| { type: 'clearCopilotConversation'; boxId: string; flavor?: 'sql' }
	| { type: 'removeFromCopilotHistory'; boxId: string; entryId: string }
	| ({ type: 'prepareOptimizeQuery'; query: string } & KustoOptimizeRequestIdentity)
	| ({ type: 'cancelOptimizeQuery' } & KustoOptimizeRequestIdentity)
	| OptimizeQueryMessage
	| ExecuteQueryMessage
	| SqlConnectionsProjectionWebviewMessage
	| { type: 'sqlSectionOpen'; boxId: string; sectionInstanceId: string }
	| SqlDatabaseDiscoveryWebviewMessage
	| { type: 'retireSqlTarget'; boxId: string; sectionInstanceId: string; targetGeneration: number }
	| { type: 'saveSqlLastSelection'; sqlConnectionId: string; database?: string }
	| { type: 'promptAddSqlConnection'; boxId?: string }
	| { type: 'addSqlConnection'; name: string; serverUrl: string; dialect: string; authType: string; database?: string; port?: number; username?: string; password?: string; boxId?: string }
	| { type: 'testSetSqlAuthOverride'; serverUrl: string; accountId: string; token: string }
	| { type: 'testClearSqlAuthOverride'; accountId: string }
	| ExecuteSqlQueryMessage
	| { type: 'cancelSqlQuery'; boxId: string; sectionInstanceId: string; executionId?: string }
	| SqlSchemaWebviewMessage
	| { type: 'requestAddSqlFavorite'; connectionId: string; database: string; defaultName?: string; boxId?: string }
	| { type: 'removeSqlFavorite'; connectionId: string; database: string; boxId?: string }
	| QuerySharingWebviewMessage
	| KustoSchemaWebviewMessage
	| SqlStsEditorLanguageWebviewMessage
	| { type: 'sqlComparisonRemoved'; boxId: string; sourceBoxId?: string }
	| { type: 'promptAddConnection'; boxId?: string }
	| { type: 'addConnection'; name: string; clusterUrl: string; database?: string; authorityId?: string; accountId?: string; boxId?: string }
	| { type: 'testKustoConnection'; name?: string; clusterUrl: string; database?: string; authorityId?: string; accountId?: string; boxId?: string }
	| ImportConnectionsFromXmlMessage
	| KqlLanguageWebviewMessage
	| ControlCommandSyntaxWebviewMessage
	| { type: 'openToolResultInEditor'; boxId: string; tool: string; label: string; content: string }
	| { type: 'openMarkdownPreview'; filePath: string }
	| ({
		type: 'comparisonBoxEnsured'; engine?: 'sql' | 'kusto'; requestId: string; sourceBoxId: string; comparisonBoxId: string;
		kustoTarget?: KustoSectionExecutionTarget;
		sourceSectionInstanceId?: string; sourceTargetGeneration?: number;
		comparisonSectionInstanceId?: string; comparisonTargetGeneration?: number;
		comparisonConnectionId?: string; comparisonDatabase?: string;
	} & Partial<KustoCopilotRequestIdentity>)
	| {
		type: 'sqlComparisonAdmissionAck'; phase: 'staged' | 'committed' | 'finalized' | 'completed' | 'rolledBack'; requestId: string; sourceBoxId: string;
		comparisonBoxId: string; accepted: boolean;
	}
	| { type: 'toolResponse'; requestId: string; result: unknown; error?: string }
	| { type: 'toolExecutionStarted'; requestId: string; owner: KustoExecutionRequestIdentity }
	| { type: 'toolStateResponse'; requestId: string; sections: unknown[]; error?: string }
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

export type { EditingPreferencesDataMessage } from '../shared/editingPreferences';
