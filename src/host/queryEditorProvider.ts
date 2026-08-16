import * as vscode from 'vscode';
import {
	admitKustoPublicationWebviewMessage,
	admitKustoPublicationWebviewMessageFromEnvelope,
} from '../shared/kustoPublicationProtocol';
import { admitArtifactCsvSaveWebviewMessageFromEnvelope } from '../shared/artifactCsvSaveProtocol';
import { admitDevelopmentNoteMutationWebviewMessage } from '../shared/developmentNoteMutationProtocol';
import {
	admitToolStateSnapshotHostMessage,
	admitToolStateSnapshotWebviewMessageFromEnvelope,
} from '../shared/toolStateSnapshotProtocol';
import {
	admitKustoExecutionStartHostMessage,
	admitKustoExecutionStartWebviewMessageFromEnvelope,
} from '../shared/kustoExecutionStartProtocol';
import {
	admitPowerBiPublishHostMessage,
	admitPowerBiPublishWebviewMessage,
	admitPowerBiPublishWebviewMessageFromEnvelope,
} from '../shared/powerBiPublishProtocol';
import { captureRuntimeMessageEnvelope } from '../shared/runtimeMessageEnvelope';
import * as crypto from 'crypto';
import * as path from 'path';

import { ConnectionManager, KustoConnection } from './connectionManager';
import { KustoQueryClient } from './kustoClient';
import { SqlQueryClient } from './sqlClient';
import { SqlSchemaService } from './sqlEditorSchema';
import { SqlWorkbenchService } from './sql/sqlWorkbenchService';
import {
	sqlResultOwnersEqual,
	type SqlResultOwner,
} from './sql/sqlEditorSessionRegistry';
import { SqlEditorLifecycleCoordinator } from './sql/sqlEditorLifecycleCoordinator';
import { sanitizeStsLogText } from './sql/stsLogSanitizer';
import { KustoConnectionLifecycle } from './kustoConnectionLifecycle';
import { getOwnedSqlDatabaseCacheEntry, SQL_DATABASE_CACHE_STORAGE_KEY } from './sqlDatabaseCache';
import { getQueryEditorHtml } from './queryEditorHtml';
import type { CompatibilityPersistenceEnvelope } from '../shared/compatibilityPersistenceProtocol';
import { MAIN_WEBVIEW_DISPATCHER_READY_TYPE } from './mainWebviewStartupGateway';
import { toolOrchestrator } from './extension';
import { CopilotService, CopilotServiceHost } from './queryEditorCopilot';
import { ConnectionService, ConnectionServiceHost } from './queryEditorConnection';
import { kustoClusterKey } from '../shared/kustoClusterUrls';
import { SchemaService, SchemaServiceHost } from './queryEditorSchema';
import {
	getErrorMessage as getErrorMessageFn,
	formatQueryExecutionErrorForUser as formatQueryExecutionErrorForUserFn,
	isControlCommand as isControlCommandFn,
	appendQueryMode as appendQueryModeFn,
	normalizeControlCommandForExecution as normalizeControlCommandForExecutionFn,
	buildCacheDirective as buildCacheDirectiveFn
} from './queryEditorUtils';
import {
	CachedSchemaEntry,
	CacheUnit,
	IncomingWebviewMessage,
	findPreferredDefaultCopilotModel
} from './queryEditorTypes';
import { EditorCursorStatusBar } from './editorCursorStatusBar';
import { KustoAuthPreferenceService, type KustoAuthPreferenceChange } from './kustoAuthPreferenceService';
import { getKustoConnectionIdentityKey } from '../shared/kustoAuth';
import { EmbeddedTutorialWebviewHost, EmbeddedTutorialWebviewRegistry } from './tutorials/embeddedTutorialWebviewHost';
import { perfMark } from './perfTrace';
import { getWorkbenchLogger, type WorkbenchLogger } from './workbenchLogger';
import type { FileOpenTrace } from './fileOpenTrace';
import { QueryRunCoordinator } from './queryRunCoordinator';
import { KustoExecutionCoordinator } from './kustoExecutionCoordinator';
import { type KustoCopilotRequestIdentity, type KustoDispatchIdentity, type KustoSectionExecutionTarget, type PreparedComparisonSection } from '../shared/kustoExecution';
import {
	HostDashboardApplicationHandler,
	type DashboardApplicationHandler,
} from './dashboardApplicationHandler';
import {
	HostArtifactCsvSaveApplicationHandler,
	type ArtifactCsvSaveApplicationHandler,
} from './artifactCsvSaveApplicationHandler';
import {
	HostPythonExecutionApplicationHandler,
	type PythonExecutionApplicationHandler,
} from './pythonExecutionApplicationHandler';
import {
	HostImportedCsvSaveApplicationHandler,
	type ImportedCsvSaveApplicationHandler,
} from './importedCsvSaveApplicationHandler';
import { showCsvSaveDialogWithDevelopmentTarget } from './developmentCsvSaveTarget';
import {
	HostQuerySharingApplicationHandler,
	type QuerySharingApplicationHandler,
} from './querySharingApplicationHandler';
import {
	HostUrlContentApplicationHandler,
	type UrlContentApplicationHandler,
} from './urlContentApplicationHandler';
import {
	HostControlCommandSyntaxApplicationHandler,
	type ControlCommandSyntaxApplicationHandler,
} from './controlCommandSyntaxApplicationHandler';
import {
	HostResourceUriApplicationHandler,
	type ResourceUriApplicationHandler,
} from './resourceUriApplicationHandler';
import {
	HostCopilotContentOpenApplicationHandler,
	type CopilotContentOpenApplicationHandler,
} from './copilotContentOpenApplicationHandler';
import {
	HostInformationNotificationApplicationHandler,
	type InformationNotificationApplicationHandler,
} from './informationNotificationApplicationHandler';
import {
	HostCachedValuesOpenApplicationHandler,
	type CachedValuesOpenApplicationHandler,
} from './cachedValuesOpenApplicationHandler';
import {
	HostCopilotAgentOpenApplicationHandler,
	type CopilotAgentOpenApplicationHandler,
} from './copilotAgentOpenApplicationHandler';
import {
	HostEditorCursorStatusApplicationHandler,
	type EditorCursorStatusApplicationHandler,
} from './editorCursorStatusApplicationHandler';
import {
	HostEditingPreferencesApplicationHandler,
	type EditingPreferencesApplicationHandler,
} from './editingPreferencesApplicationHandler';
import {
	HostKustoConnectionIntakeApplicationHandler,
	type KustoConnectionIntakeApplicationHandler,
} from './kustoConnectionIntakeApplicationHandler';
import {
	HostKustoConnectionOnboardingApplicationHandler,
	type KustoConnectionOnboardingApplicationHandler,
} from './kustoConnectionOnboardingApplicationHandler';
import {
	HostSqlConnectionOnboardingApplicationHandler,
	type SqlConnectionOnboardingApplicationHandler,
} from './sqlConnectionOnboardingApplicationHandler';
import {
	HostSqlFavoritesApplicationHandler,
	type SqlFavoritesApplicationHandler,
} from './sqlFavoritesApplicationHandler';
import {
	HostKustoFavoritesApplicationHandler,
	type KustoFavoritesApplicationHandler,
} from './kustoFavoritesApplicationHandler';
import {
	HostSqlDatabaseDiscoveryApplicationHandler,
	type SqlDatabaseDiscoveryApplicationHandler,
} from './sqlDatabaseDiscoveryApplicationHandler';
import {
	HostKqlLanguageRequestApplicationHandler,
	type KqlLanguageRequestApplicationHandler,
} from './kqlLanguageRequestApplicationHandler';
import {
	HostSqlLastSelectionApplicationHandler,
	type SqlLastSelectionApplicationHandler,
} from './sqlLastSelectionApplicationHandler';
import {
	HostDevelopmentNoteMutationApplicationHandler,
	type DevelopmentNoteMutationApplicationHandler,
} from './developmentNoteMutationApplicationHandler';
import {
	HostCopilotInlineCompletionApplicationHandler,
	type CopilotInlineCompletionApplicationHandler,
} from './copilotInlineCompletionApplicationHandler';
import {
	HostCopilotAvailabilityApplicationHandler,
	type CopilotAvailabilityApplicationHandler,
} from './copilotAvailabilityApplicationHandler';
import {
	HostCopilotWriteQueryPreparationApplicationHandler,
	type CopilotWriteQueryPreparationApplicationHandler,
} from './copilotWriteQueryPreparationApplicationHandler';
import {
	HostCopilotConversationClearApplicationHandler,
	type CopilotConversationClearApplicationHandler,
} from './copilotConversationClearApplicationHandler';
import {
	HostCopilotHistoryRemovalApplicationHandler,
	type CopilotHistoryRemovalApplicationHandler,
} from './copilotHistoryRemovalApplicationHandler';
import {
	HostCopilotChatFirstTimeApplicationHandler,
	type CopilotChatFirstTimeApplicationHandler,
} from './copilotChatFirstTimeApplicationHandler';
import {
	HostWorkbenchToolSessionApplicationHandler,
	type WorkbenchToolSessionApplicationHandler,
} from './workbenchToolSessionApplicationHandler';
import {
	HostKustoConnectionBrowsingApplicationHandler,
	type KustoConnectionBrowsingApplicationHandler,
} from './kustoConnectionBrowsingApplicationHandler';
import {
	HostCopilotQueryWorkflowApplicationHandler,
	type CopilotQueryWorkflowApplicationHandler,
} from './copilotQueryWorkflowApplicationHandler';
import {
	HostKustoSectionExecutionApplicationHandler,
	type KustoSectionExecutionApplicationHandler,
	type KustoSectionQueryExecutionOptions,
} from './kustoSectionExecutionApplicationHandler';
import {
	HostComparisonPreparationApplicationHandler,
	type ComparisonPreparationApplicationHandler,
} from './comparisonPreparationApplicationHandler';
import {
	HostSqlSectionExecutionApplicationHandler,
	type SqlSectionExecutionApplicationHandler,
} from './sqlSectionExecutionApplicationHandler';
import {
	HostSqlSchemaRequestApplicationHandler,
	type SqlSchemaRequestApplicationHandler,
} from './sqlSchemaRequestApplicationHandler';
import {
	HostSqlConnectionsProjectionApplicationHandler,
	type SqlConnectionsProjectionApplicationHandler,
} from './sqlConnectionsProjectionApplicationHandler';
import {
	HostPersistedResultSanitizationApplicationHandler,
	type PersistedResultSanitizationApplicationHandler,
} from './persistedResultSanitizationApplicationHandler';
import {
	HostKustoConnectionsProjectionApplicationHandler,
	type KustoConnectionsProjectionApplicationHandler,
} from './kustoConnectionsProjectionApplicationHandler';
import {
	HostSqlEditorLifecycleApplicationHandler,
	type SqlEditorLifecycleApplicationHandler,
} from './sqlEditorLifecycleApplicationHandler';
import {
	HostKustoSchemaRequestApplicationHandler,
	type KustoSchemaRequestApplicationHandler,
} from './kustoSchemaRequestApplicationHandler';

export class QueryEditorProvider implements CopilotServiceHost, ConnectionServiceHost, SchemaServiceHost {
	private static readonly activeProviders = new Set<QueryEditorProvider>();

	private static activeProviderForTest(): QueryEditorProvider {
		const candidates = [...QueryEditorProvider.activeProviders]
			.filter(provider => !provider._panelDisposed && !!provider.panel
				&& provider.context.extensionMode !== vscode.ExtensionMode.Production);
		const provider = candidates.find(candidate => candidate.panel?.active)
			?? candidates.find(candidate => candidate.panel?.visible)
			?? candidates.at(-1);
		if (!provider) throw new Error('No active Kusto Workbench editor is available.');
		return provider;
	}

	static async prepareSqlComparisonForTest(sourceBoxId: string, query: string): Promise<PreparedComparisonSection> {
		const provider = QueryEditorProvider.activeProviderForTest();
		const cancellation = new vscode.CancellationTokenSource();
		try {
			return await provider.ensureComparisonBoxInWebview(sourceBoxId, query, cancellation.token);
		} finally {
			cancellation.dispose();
		}
	}

	static async assertNestedSqlComparisonRejectedForTest(query: string): Promise<void> {
		const provider = QueryEditorProvider.activeProviderForTest();
		const comparisonBoxIds = provider.sqlLifecycle.listComparisonBoxIds();
		if (comparisonBoxIds.length !== 1) {
			throw new Error(`Expected exactly one committed SQL comparison, found ${comparisonBoxIds.length}.`);
		}
		try {
			await QueryEditorProvider.prepareSqlComparisonForTest(comparisonBoxIds[0], query);
		} catch (error) {
			if (error instanceof Error && error.message.includes('cannot be used as another comparison source')) return;
			throw error;
		}
		throw new Error('Nested SQL comparison preparation unexpectedly succeeded.');
	}

	private panel?: vscode.WebviewPanel;
	private panelDisposalSubscription?: vscode.Disposable;
	private _panelDisposed = true;
	readonly kustoClient: KustoQueryClient;
	readonly output: WorkbenchLogger = getWorkbenchLogger();
	readonly connection: ConnectionService;
	readonly schema: SchemaService;
	private _queryRunCoordinator?: QueryRunCoordinator;
	private _kustoExecutionCoordinator?: KustoExecutionCoordinator;
	readonly dashboardApplication: DashboardApplicationHandler;
	readonly artifactCsvSaveApplication: ArtifactCsvSaveApplicationHandler;
	readonly pythonExecutionApplication: PythonExecutionApplicationHandler;
	readonly importedCsvSaveApplication: ImportedCsvSaveApplicationHandler;
	readonly querySharingApplication: QuerySharingApplicationHandler;
	readonly urlContentApplication: UrlContentApplicationHandler;
	readonly controlCommandSyntaxApplication: ControlCommandSyntaxApplicationHandler;
	readonly resourceUriApplication: ResourceUriApplicationHandler;
	readonly copilotContentOpenApplication: CopilotContentOpenApplicationHandler;
	readonly informationNotificationApplication: InformationNotificationApplicationHandler;
	readonly cachedValuesOpenApplication: CachedValuesOpenApplicationHandler;
	readonly copilotAgentOpenApplication: CopilotAgentOpenApplicationHandler;
	readonly editorCursorStatusApplication: EditorCursorStatusApplicationHandler;
	readonly editingPreferencesApplication: EditingPreferencesApplicationHandler;
	readonly kustoConnectionIntakeApplication: KustoConnectionIntakeApplicationHandler;
	readonly kustoConnectionOnboardingApplication: KustoConnectionOnboardingApplicationHandler;
	readonly sqlConnectionOnboardingApplication: SqlConnectionOnboardingApplicationHandler;
	readonly sqlFavoritesApplication: SqlFavoritesApplicationHandler;
	readonly kustoFavoritesApplication: KustoFavoritesApplicationHandler;
	readonly sqlDatabaseDiscoveryApplication: SqlDatabaseDiscoveryApplicationHandler;
	readonly kqlLanguageRequestApplication: KqlLanguageRequestApplicationHandler;
	readonly sqlLastSelectionApplication: SqlLastSelectionApplicationHandler;
	readonly developmentNoteMutationApplication: DevelopmentNoteMutationApplicationHandler;
	readonly copilotInlineCompletionApplication: CopilotInlineCompletionApplicationHandler;
	readonly copilotAvailabilityApplication: CopilotAvailabilityApplicationHandler;
	readonly copilotWriteQueryPreparationApplication: CopilotWriteQueryPreparationApplicationHandler;
	readonly copilotConversationClearApplication: CopilotConversationClearApplicationHandler;
	readonly copilotHistoryRemovalApplication: CopilotHistoryRemovalApplicationHandler;
	readonly copilotChatFirstTimeApplication: CopilotChatFirstTimeApplicationHandler;
	readonly workbenchToolSessionApplication: WorkbenchToolSessionApplicationHandler;
	readonly kustoConnectionBrowsingApplication: KustoConnectionBrowsingApplicationHandler;
	readonly copilotQueryWorkflowApplication: CopilotQueryWorkflowApplicationHandler;
	readonly kustoSectionExecutionApplication: KustoSectionExecutionApplicationHandler;
	readonly comparisonPreparationApplication: ComparisonPreparationApplicationHandler;
	readonly sqlSectionExecutionApplication: SqlSectionExecutionApplicationHandler;
	readonly sqlSchemaRequestApplication: SqlSchemaRequestApplicationHandler;
	readonly sqlConnectionsProjectionApplication: SqlConnectionsProjectionApplicationHandler;
	readonly persistedResultSanitizationApplication: PersistedResultSanitizationApplicationHandler;
	readonly kustoConnectionsProjectionApplication: KustoConnectionsProjectionApplicationHandler;
	readonly sqlEditorLifecycleApplication: SqlEditorLifecycleApplicationHandler;
	readonly kustoSchemaRequestApplication: KustoSchemaRequestApplicationHandler;
	readonly onDidInvalidateSqlPersistence: vscode.Event<void>;
	readonly onDidInvalidateKustoPersistence: vscode.Event<void>;

	private get queryRuns(): QueryRunCoordinator {
		return this._queryRunCoordinator ??= new QueryRunCoordinator();
	}

	private get kustoExecutionCoordinator(): KustoExecutionCoordinator {
		return this._kustoExecutionCoordinator ??= new KustoExecutionCoordinator({
			queryRuns: this.queryRuns,
			postMessage: message => this.postKustoPublication(message),
			getCurrentConnectionOwner: connectionId => {
				const connection = this.connectionManager.getConnections().find(candidate => candidate.id === connectionId);
				if (!connection) return undefined;
				try {
					return Object.freeze({
						connectionRevision: this.connectionManager.getConnectionIncarnation(connection.id),
						connectionIdentityKey: getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId),
					});
				} catch { return undefined; }
			},
		});
	}

	postKustoPublication(message: unknown): Promise<boolean> {
		return this.kustoSectionExecutionApplication.postKustoPublication(message);
	}

	getKustoSectionExecutionTarget(boxId: string): KustoSectionExecutionTarget | undefined {
		return this.kustoSectionExecutionApplication.getKustoSectionExecutionTarget(boxId);
	}

	cancelKustoSectionExecution(target: KustoSectionExecutionTarget, executionId: string): boolean {
		return this.kustoSectionExecutionApplication.cancelKustoSectionExecution(target, executionId);
	}

	getKustoSectionExecutionAccountPartition(target: KustoSectionExecutionTarget, executionId: string): string | undefined {
		return this.kustoSectionExecutionApplication
			.getKustoSectionExecutionAccountPartition(target, executionId);
	}

	getCurrentKustoConnectionForDispatch(
		connectionId: string,
		dispatch: KustoDispatchIdentity,
	): KustoConnection | undefined {
		return this.kustoSectionExecutionApplication
			.getCurrentKustoConnectionForDispatch(connectionId, dispatch);
	}

	// SQL schema responses and persistence remain provider adapters. Editor lifecycle
	// state is owned by SqlEditorLifecycleCoordinator; shared runtime state stays in SqlWorkbenchService.
	private _sqlSchemaService?: SqlSchemaService;
	private readonly sqlLifecycle: SqlEditorLifecycleCoordinator;

	get sqlExecutionBroker() {
		return this.sqlLifecycle.executionBroker;
	}

	get sqlConnectionManager() {
		return this.sqlWorkbench.connectionManager;
	}

	get sqlClient(): SqlQueryClient {
		return this.sqlWorkbench.client;
	}

	get sqlSchemaService(): SqlSchemaService {
		if (!this._sqlSchemaService) {
			this._sqlSchemaService = new SqlSchemaService({
				context: this.context,
				sqlClient: this.sqlClient,
				output: this.output,
				assertSqlConnectionAllowed: connectionId => this.sqlWorkbench.assertSqlConnectionAllowed(connectionId),
				getCurrentSqlConnection: connectionId => this.sqlConnectionManager.getConnection(connectionId),
				postMessage: (msg) => this.postMessage(msg),
			});
		}
		return this._sqlSchemaService;
	}

	assertSqlConnectionAllowed(connectionId: string): Promise<void> {
		return this.sqlWorkbench.assertSqlConnectionAllowed(connectionId);
	}

	dispatchSqlConnectionAllowed<T>(connectionId: string, dispatch: () => T | PromiseLike<T>): Promise<T> {
		return this.sqlWorkbench.dispatchSqlConnectionAllowed(connectionId, dispatch);
	}

	dispatchSqlResultOwnerAllowed<T>(
		boxId: string,
		expectedOwner: SqlResultOwner,
		dispatch: () => T | PromiseLike<T>,
	): Promise<T> {
		return this.sqlLifecycle.dispatchResultOwnerAllowed(boxId, expectedOwner, dispatch);
	}

	getSqlResultOwner(boxId: string): SqlResultOwner | undefined {
		return this.sqlLifecycle.getResultOwner(boxId);
	}

	private async getCanonicalSqlResultOwner(boxId: string): Promise<SqlResultOwner | undefined> {
		return this.sqlLifecycle.getCanonicalResultOwner(boxId);
	}

	async assertSqlResultOwnerAllowed(boxId: string, expectedOwner: SqlResultOwner): Promise<void> {
		await this.sqlLifecycle.assertResultOwnerAllowed(boxId, expectedOwner);
	}

	private sqlResultOwnersEqual(left: SqlResultOwner | undefined, right: SqlResultOwner | undefined): boolean {
		return sqlResultOwnersEqual(left, right);
	}

	private async assertSqlOwnerToken(boxId: string, token: string | undefined): Promise<{ token: string; owner: SqlResultOwner }> {
		return this.sqlLifecycle.assertOwnerToken(boxId, token);
	}
	private readonly copilot: CopilotService;
	private configSubscription?: vscode.Disposable;
	private authPreferenceSubscription?: vscode.Disposable;
	private readonly kustoConnectionLifecycle: KustoConnectionLifecycle;
	private embeddedTutorialHost?: EmbeddedTutorialWebviewHost;
	private embeddedTutorialRegistration?: vscode.Disposable;
	private messageTransport?: (message: unknown) => Thenable<boolean>;
	fileOpenTrace?: FileOpenTrace;

	setMessageTransport(transport: ((message: unknown) => Thenable<boolean>) | undefined): void {
		this.messageTransport = transport;
	}

	getErrorMessage(error: unknown): string {
		return getErrorMessageFn(error);
	}

	formatQueryExecutionErrorForUser(error: unknown, connection: KustoConnection, database?: string): string {
		const raw = this.getErrorMessage(error);
		return formatQueryExecutionErrorForUserFn(raw, connection.clusterUrl, database);
	}

	logQueryExecutionError(error: unknown, connection: KustoConnection, database: string | undefined, boxId: string, query: string): void {
		try {
			const raw = this.getErrorMessage(error);
			const cluster = String(connection.clusterUrl || '').trim();
			this.output.error([
				`[${new Date().toISOString()}] Query execution failed`,
				`  cluster: ${cluster}`,
				...(database ? [`  database: ${database}`] : []),
				...(boxId ? [`  boxId: ${boxId}`] : []),
				'  query:',
				query,
				'  error:',
				raw,
			].join('\n'));
		} catch {
			// ignore
		}
	}

	constructor(
		readonly extensionUri: vscode.Uri,
		readonly connectionManager: ConnectionManager,
		readonly context: vscode.ExtensionContext,
		private readonly sqlWorkbench: SqlWorkbenchService,
		editorCursorStatusBar?: EditorCursorStatusBar,
		dashboardApplication?: DashboardApplicationHandler,
		artifactCsvSaveApplication?: ArtifactCsvSaveApplicationHandler,
		pythonExecutionApplication?: PythonExecutionApplicationHandler,
		importedCsvSaveApplication?: ImportedCsvSaveApplicationHandler,
		querySharingApplication?: QuerySharingApplicationHandler,
		urlContentApplication?: UrlContentApplicationHandler,
		controlCommandSyntaxApplication?: ControlCommandSyntaxApplicationHandler,
		resourceUriApplication?: ResourceUriApplicationHandler,
		copilotContentOpenApplication?: CopilotContentOpenApplicationHandler,
		informationNotificationApplication?: InformationNotificationApplicationHandler,
		cachedValuesOpenApplication?: CachedValuesOpenApplicationHandler,
		copilotAgentOpenApplication?: CopilotAgentOpenApplicationHandler,
		editorCursorStatusApplication?: EditorCursorStatusApplicationHandler,
		editingPreferencesApplication?: EditingPreferencesApplicationHandler,
		kustoConnectionIntakeApplication?: KustoConnectionIntakeApplicationHandler,
		kustoConnectionOnboardingApplication?: KustoConnectionOnboardingApplicationHandler,
		sqlConnectionOnboardingApplication?: SqlConnectionOnboardingApplicationHandler,
		sqlFavoritesApplication?: SqlFavoritesApplicationHandler,
		kustoFavoritesApplication?: KustoFavoritesApplicationHandler,
		sqlDatabaseDiscoveryApplication?: SqlDatabaseDiscoveryApplicationHandler,
		kqlLanguageRequestApplication?: KqlLanguageRequestApplicationHandler,
		sqlLastSelectionApplication?: SqlLastSelectionApplicationHandler,
		developmentNoteMutationApplication?: DevelopmentNoteMutationApplicationHandler,
		copilotInlineCompletionApplication?: CopilotInlineCompletionApplicationHandler,
		copilotAvailabilityApplication?: CopilotAvailabilityApplicationHandler,
		copilotWriteQueryPreparationApplication?: CopilotWriteQueryPreparationApplicationHandler,
		copilotConversationClearApplication?: CopilotConversationClearApplicationHandler,
		copilotHistoryRemovalApplication?: CopilotHistoryRemovalApplicationHandler,
		copilotChatFirstTimeApplication?: CopilotChatFirstTimeApplicationHandler,
		workbenchToolSessionApplication?: WorkbenchToolSessionApplicationHandler,
		kustoConnectionBrowsingApplication?: KustoConnectionBrowsingApplicationHandler,
		copilotQueryWorkflowApplication?: CopilotQueryWorkflowApplicationHandler,
		kustoSectionExecutionApplication?: KustoSectionExecutionApplicationHandler,
		comparisonPreparationApplication?: ComparisonPreparationApplicationHandler,
		sqlSectionExecutionApplication?: SqlSectionExecutionApplicationHandler,
		sqlSchemaRequestApplication?: SqlSchemaRequestApplicationHandler,
		sqlConnectionsProjectionApplication?: SqlConnectionsProjectionApplicationHandler,
		persistedResultSanitizationApplication?: PersistedResultSanitizationApplicationHandler,
		kustoConnectionsProjectionApplication?: KustoConnectionsProjectionApplicationHandler,
		sqlEditorLifecycleApplication?: SqlEditorLifecycleApplicationHandler,
		kustoSchemaRequestApplication?: KustoSchemaRequestApplicationHandler,
	) {
		this.kustoClient = new KustoQueryClient(this.context, undefined, this.connectionManager);
		this.dashboardApplication = dashboardApplication ?? new HostDashboardApplicationHandler({
			postMessage: message => this.postMessage(message),
			isDisposed: () => this._panelDisposed,
			output: this.output,
			connectionManager: this.connectionManager,
		});
		this.artifactCsvSaveApplication = artifactCsvSaveApplication ?? new HostArtifactCsvSaveApplicationHandler({
			postMessage: message => this.postMessage(message),
			isDisposed: () => this._panelDisposed,
			showSaveDialog: showCsvSaveDialogWithDevelopmentTarget,
		});
		this.pythonExecutionApplication = pythonExecutionApplication ?? new HostPythonExecutionApplicationHandler({
			postMessage: message => this.postMessage(message),
		});
		this.importedCsvSaveApplication = importedCsvSaveApplication ?? new HostImportedCsvSaveApplicationHandler({
			showSaveDialog: showCsvSaveDialogWithDevelopmentTarget,
		});
		this.querySharingApplication = querySharingApplication ?? new HostQuerySharingApplicationHandler({
			findConnection: connectionId => this.connection.findConnection(connectionId),
			postMessage: message => this.postMessage(message),
		});
		this.urlContentApplication = urlContentApplication ?? new HostUrlContentApplicationHandler({
			postMessage: message => this.postMessage(message),
		});
		this.controlCommandSyntaxApplication = controlCommandSyntaxApplication ?? new HostControlCommandSyntaxApplicationHandler({
			postMessage: message => this.postMessage(message),
		});
		this.resourceUriApplication = resourceUriApplication ?? new HostResourceUriApplicationHandler({
			postMessage: message => this.postMessage(message),
			asWebviewUri: uri => this.panel?.webview.asWebviewUri(uri),
		});
		this.copilotContentOpenApplication = copilotContentOpenApplication
			?? new HostCopilotContentOpenApplicationHandler();
		this.informationNotificationApplication = informationNotificationApplication
			?? new HostInformationNotificationApplicationHandler();
		this.cachedValuesOpenApplication = cachedValuesOpenApplication
			?? new HostCachedValuesOpenApplicationHandler();
		this.copilotAgentOpenApplication = copilotAgentOpenApplication
			?? new HostCopilotAgentOpenApplicationHandler();
		this.editorCursorStatusApplication = editorCursorStatusApplication
			?? new HostEditorCursorStatusApplicationHandler({
				statusBar: editorCursorStatusBar,
				extensionMode: this.context.extensionMode,
				postMessage: message => this.postMessage(message),
			});
		this.editingPreferencesApplication = editingPreferencesApplication
			?? new HostEditingPreferencesApplicationHandler({
				context: this.context,
				getPublisher: () => toolOrchestrator,
				postMessage: message => this.postMessage(message),
			});
		this.kustoConnectionIntakeApplication = kustoConnectionIntakeApplication
			?? new HostKustoConnectionIntakeApplicationHandler({
				connectionManager: this.connectionManager,
				postMessage: message => this.postMessage(message),
				refreshConnections: () => this.kustoConnectionsProjectionApplication.refresh(),
			});
		this.authPreferenceSubscription = KustoAuthPreferenceService.getInstance(this.context).onDidChange(change => {
			this.handleKustoAuthPreferenceChange(change);
		});
		this.connection = new ConnectionService(this);
		this.kustoConnectionOnboardingApplication = kustoConnectionOnboardingApplication
			?? new HostKustoConnectionOnboardingApplicationHandler({
				connectionManager: this.connectionManager,
				authPreferences: KustoAuthPreferenceService.getInstance(this.context),
				kustoClient: this.kustoClient,
				saveLastSelection: (connectionId, database) => this.connection.saveLastSelection(connectionId, database),
				getLastSelection: () => ({
					lastConnectionId: this.connection.getLastConnectionId(),
					lastDatabase: this.connection.getLastDatabase(),
				}),
				postMessage: message => this.postMessage(message),
				refreshConnections: () => this.kustoConnectionsProjectionApplication.refresh(),
				output: this.output,
			});
		this.sqlConnectionOnboardingApplication = sqlConnectionOnboardingApplication
			?? new HostSqlConnectionOnboardingApplicationHandler({
				connectionManager: this.sqlConnectionManager,
				globalState: this.context.globalState,
				postMessage: message => this.postMessage(message),
			});
		this.sqlFavoritesApplication = sqlFavoritesApplication
			?? new HostSqlFavoritesApplicationHandler({
				connectionManager: this.sqlConnectionManager,
				globalState: this.context.globalState,
				postMessage: message => this.postMessage(message),
				output: this.output,
			});
		this.sqlConnectionsProjectionApplication = sqlConnectionsProjectionApplication
			?? new HostSqlConnectionsProjectionApplicationHandler({
				applicationState: this.context.globalState,
				connectionManager: this.sqlConnectionManager,
				workbench: this.sqlWorkbench,
				readDatabaseCache: connection => getOwnedSqlDatabaseCacheEntry(
					this.context,
					SQL_DATABASE_CACHE_STORAGE_KEY,
					connection,
				),
				getFavorites: () => this.sqlFavoritesApplication.getFavorites(),
				postMessage: message => this.postMessage(message),
			});
		this.kustoFavoritesApplication = kustoFavoritesApplication
			?? new HostKustoFavoritesApplicationHandler({
				context: this.context,
				connectionManager: this.connectionManager,
				kustoClient: this.kustoClient,
				authPreferences: KustoAuthPreferenceService.getInstance(this.context),
				postMessage: message => this.postMessage(message),
				output: this.output,
			});
		this.kustoConnectionsProjectionApplication = kustoConnectionsProjectionApplication
			?? new HostKustoConnectionsProjectionApplicationHandler({
				context: this.context,
				connectionManager: this.connectionManager,
				authPreferences: KustoAuthPreferenceService.getInstance(this.context),
				kustoClient: this.kustoClient,
				getLastSelection: () => ({
					lastConnectionId: this.connection.getLastConnectionId(),
					lastDatabase: this.connection.getLastDatabase(),
				}),
				getCachedDatabases: () => this.connection.getCachedDatabases(),
				getFavorites: () => this.kustoFavoritesApplication.getFavorites(),
				postMessage: message => this.postMessage(message),
				postKustoPublication: message => this.postKustoPublication(message),
			});
		this.schema = new SchemaService(this);
		this.kustoSchemaRequestApplication = kustoSchemaRequestApplication
			?? new HostKustoSchemaRequestApplicationHandler({ schema: this.schema });
		this.sqlLifecycle = new SqlEditorLifecycleCoordinator({
			context: this.context,
			sqlWorkbench: this.sqlWorkbench,
			queryRuns: this.queryRuns,
			output: this.output,
			hasWebview: () => !!this.panel && !this._panelDisposed,
			effects: {
				postMessage: message => this.postMessage(message),
				cancelCopilotWriteQuery: (boxId, expectedSequence) => this.copilot.cancelCopilotWriteQuery(boxId, expectedSequence),
				cancelCopilotQueryTarget: (sourceBoxId, targetBoxId, expectedSequence) =>
					this.copilot.cancelCopilotQueryTarget(sourceBoxId, targetBoxId, expectedSequence),
				invalidateSqlCopilot: (connectionIds, comparisonBoxIds) =>
					this.copilot.invalidateSqlConnections([...connectionIds], [...comparisonBoxIds]),
				rejectPendingComparisonEnsures: sourceBoxId =>
					this.comparisonPreparationApplication?.rejectPendingComparisonEnsures(sourceBoxId),
				invalidatePersistence: () => this.persistedResultSanitizationApplication.invalidateSqlPersistence(),
				refreshConnectionsData: () => this.sqlConnectionsProjectionApplication.refresh(),
				prefetchSchema: request => this.sqlSchemaRequestApplication.requestSchema(request),
			},
		});
		this.sqlEditorLifecycleApplication = sqlEditorLifecycleApplication
			?? new HostSqlEditorLifecycleApplicationHandler({
				context: this.context,
				lifecycle: this.sqlLifecycle,
			});
		this.persistedResultSanitizationApplication = persistedResultSanitizationApplication
			?? new HostPersistedResultSanitizationApplicationHandler({
				connectionManager: this.connectionManager,
				kustoClient: this.kustoClient,
				sqlConnectionManager: this.sqlConnectionManager,
				sqlLifecycle: this.sqlLifecycle,
				sqlWorkbench: this.sqlWorkbench,
			});
		this.onDidInvalidateSqlPersistence =
			this.persistedResultSanitizationApplication.onDidInvalidateSqlPersistence;
		this.onDidInvalidateKustoPersistence =
			this.persistedResultSanitizationApplication.onDidInvalidateKustoPersistence;
		this.sqlSchemaRequestApplication = sqlSchemaRequestApplication
			?? new HostSqlSchemaRequestApplicationHandler({
				lifecycle: this.sqlLifecycle,
				connectionManager: this.sqlConnectionManager,
				getSchemaService: () => this.sqlSchemaService,
				postMessage: message => this.postMessage(message),
				output: this.output,
			});
		this.sqlDatabaseDiscoveryApplication = sqlDatabaseDiscoveryApplication
			?? new HostSqlDatabaseDiscoveryApplicationHandler({
				context: this.context,
				lifecycle: this.sqlLifecycle,
				workbench: this.sqlWorkbench,
				connectionManager: this.sqlConnectionManager,
				client: this.sqlClient,
				postMessage: message => this.postMessage(message),
				output: this.output,
			});
		this.kqlLanguageRequestApplication = kqlLanguageRequestApplication
			?? new HostKqlLanguageRequestApplicationHandler({
				connectionManager: this.connectionManager,
				context: this.context,
				postMessage: message => this.postMessage(message),
				output: this.output,
			});
		this.sqlLastSelectionApplication = sqlLastSelectionApplication
			?? new HostSqlLastSelectionApplicationHandler({
				globalState: this.context.globalState,
			});
		this.developmentNoteMutationApplication = developmentNoteMutationApplication
			?? new HostDevelopmentNoteMutationApplicationHandler({
				postMessage: message => this.postMessage(message),
				isAvailable: () => !!this.panel,
			});
		this.copilotInlineCompletionApplication = copilotInlineCompletionApplication
			?? new HostCopilotInlineCompletionApplicationHandler({
				assertSqlOwnerToken: (boxId, ownerToken) => this.assertSqlOwnerToken(boxId, ownerToken),
				handleCopilotInlineCompletionRequest: (message, expectedSqlOwner, ownerToken) =>
					this.copilot.handleCopilotInlineCompletionRequest(message, expectedSqlOwner, ownerToken),
				postMessage: message => this.postMessage(message),
			});
		this.copilotAvailabilityApplication = copilotAvailabilityApplication
			?? new HostCopilotAvailabilityApplicationHandler({
				checkCopilotAvailability: boxId => this.copilot.checkCopilotAvailability(boxId),
			});
		this.copilotWriteQueryPreparationApplication = copilotWriteQueryPreparationApplication
			?? new HostCopilotWriteQueryPreparationApplicationHandler({
				prepareCopilotWriteQuery: message => this.copilot.prepareCopilotWriteQuery(message),
			});
		this.copilotConversationClearApplication = copilotConversationClearApplication
			?? new HostCopilotConversationClearApplicationHandler({
				clearCopilotConversation: boxId => this.copilot.clearCopilotConversation(boxId),
				clearKustoCopilotConversation: message => this.copilot.clearKustoCopilotConversation(message),
			});
		this.copilotHistoryRemovalApplication = copilotHistoryRemovalApplication
			?? new HostCopilotHistoryRemovalApplicationHandler({
				removeFromCopilotHistory: (boxId, entryId) =>
					this.copilot.removeFromCopilotHistory(boxId, entryId),
			});
		this.copilotChatFirstTimeApplication = copilotChatFirstTimeApplication
			?? new HostCopilotChatFirstTimeApplicationHandler({
				globalState: this.context.globalState,
				postMessage: message => this.postMessage(message),
			});
		this.workbenchToolSessionApplication = workbenchToolSessionApplication
			?? new HostWorkbenchToolSessionApplicationHandler({
				getOrchestrator: () => toolOrchestrator,
				postMessage: message => this.postMessage(message),
				isAvailable: () => !!this.panel,
				getDocumentUri: () => this.documentUri,
				connectionManager: this.connectionManager,
				schema: this.schema,
				sqlLifecycle: this.sqlLifecycle,
			});
		this.kustoConnectionBrowsingApplication = kustoConnectionBrowsingApplication
			?? new HostKustoConnectionBrowsingApplicationHandler({
				sendConnectionsData: async policyRequestId => {
					await this.kustoConnectionsProjectionApplication.refresh(policyRequestId);
				},
				sendDatabases: (connectionId, boxId, request) =>
					this.connection.sendDatabases(connectionId, boxId, request),
				saveLastSelection: (connectionId, database) =>
					this.connection.saveLastSelection(connectionId, database),
				refreshTextEditorDiagnostics: () =>
					vscode.commands.executeCommand('kusto.refreshTextEditorDiagnostics'),
			});
		this.copilot = new CopilotService(this);
		this.copilotQueryWorkflowApplication = copilotQueryWorkflowApplication
			?? new HostCopilotQueryWorkflowApplicationHandler({
				copilot: this.copilot,
				sqlExecutionBroker: this.sqlExecutionBroker,
				sqlLifecycle: this.sqlLifecycle,
				getSqlConnectionManager: () => this.sqlConnectionManager,
				getSqlSchemaService: () => this.sqlSchemaService,
				getSqlClient: () => this.sqlClient,
				postMessage: message => this.postMessage(message),
			});
		this.kustoSectionExecutionApplication = kustoSectionExecutionApplication
			?? new HostKustoSectionExecutionApplicationHandler({
				coordinator: this.kustoExecutionCoordinator,
				kustoClient: this.kustoClient,
				connection: this.connection,
				connectionManager: this.connectionManager,
				postMessage: message => this.postMessage(message),
				refreshConnectionsData: () => this.refreshConnectionsData(),
				cancelKustoCopilotSection: (boxId, sectionInstanceId) =>
					this.copilot.cancelKustoCopilotSection(boxId, sectionInstanceId),
				getErrorMessage: error => this.getErrorMessage(error),
				formatQueryExecutionErrorForUser: (error, connection, database) =>
					this.formatQueryExecutionErrorForUser(error, connection, database),
				logQueryExecutionError: (error, connection, database, boxId, query) =>
					this.logQueryExecutionError(error, connection, database, boxId, query),
				appendQueryMode: (query, queryMode) => this.appendQueryMode(query, queryMode),
				isControlCommand: query => this.isControlCommand(query),
				normalizeControlCommandForExecution: query => this.normalizeControlCommandForExecution(query),
				buildCacheDirective: (enabled, value, unit) => this.buildCacheDirective(enabled, value, unit),
				showErrorMessage: message => { void vscode.window.showErrorMessage(message); },
				isDisposed: () => this._panelDisposed,
				createPublicationId: () => crypto.randomUUID(),
				now: () => Date.now(),
			});
		this.comparisonPreparationApplication = comparisonPreparationApplication
			?? new HostComparisonPreparationApplicationHandler({
				sqlLifecycle: this.sqlLifecycle,
				sqlExecutionBroker: this.sqlExecutionBroker,
				sqlWorkbench: this.sqlWorkbench,
				kustoExecutionCoordinator: this.kustoExecutionCoordinator,
				postMessage: message => this.postMessage(message),
				hasWebview: () => !!this.panel,
				cancelCopilotQueryTarget: (sourceBoxId, targetBoxId, expectedSequence) =>
					this.copilot.cancelCopilotQueryTarget(sourceBoxId, targetBoxId, expectedSequence),
				cancelCopilotWriteQuery: (boxId, expectedSequence) =>
					this.copilot.cancelCopilotWriteQuery(boxId, expectedSequence),
				createRequestId: () => crypto.randomUUID(),
			});
		this.sqlSectionExecutionApplication = sqlSectionExecutionApplication
			?? new HostSqlSectionExecutionApplicationHandler({
				sqlLifecycle: this.sqlLifecycle,
				sqlExecutionBroker: this.sqlExecutionBroker,
				sqlWorkbench: this.sqlWorkbench,
				connectionManager: this.sqlConnectionManager,
				client: this.sqlClient,
				postMessage: message => this.postMessage(message),
				refreshConnectionsData: () => this.sqlConnectionsProjectionApplication.refresh(),
				output: this.output,
			});
		this.kustoConnectionLifecycle = new KustoConnectionLifecycle(this.connectionManager, {
			invalidateConnections: connectionIds => {
				this.kustoExecutionCoordinator.revokeConnections(connectionIds);
				this.copilot.invalidateKustoConnections([...connectionIds]);
				this.persistedResultSanitizationApplication.invalidateKustoPersistence();
			},
			invalidatePhysicalTargets: connectionIds => this.kustoExecutionCoordinator.invalidatePhysicalConnections(connectionIds),
			publishIdentityChange: connectionIds => this.postMessage({
				type: 'kustoAuthIdentityChanged', connectionIds: [...connectionIds], reason: 'connection-mutated',
			}),
			refreshConnections: () => this.kustoConnectionsProjectionApplication.refresh(),
		});
		this.sqlLifecycle.startSession();
	}

	private handleKustoAuthPreferenceChange(change: KustoAuthPreferenceChange): void {
		const establishingAccountPartition = change.reason === 'success' && change.firstEstablishment === true
			? change.accountPartition
			: undefined;
		if (change.connectionIds.length > 0) {
			this.kustoExecutionCoordinator.revokeConnections(
				change.connectionIds,
				establishingAccountPartition,
			);
			this.copilot.invalidateKustoConnections(change.connectionIds, {
				preserveEstablishingAccountPartition: establishingAccountPartition,
			});
			this.persistedResultSanitizationApplication.invalidateKustoPersistence();
			if (change.reason !== 'success' || change.firstEstablishment !== true) {
				this.postMessage({ type: 'kustoAuthIdentityChanged', connectionIds: change.connectionIds, reason: change.reason });
			}
		}
		void this.kustoConnectionsProjectionApplication.refresh();
	}

	async initializeWebviewPanel(
		panel: vscode.WebviewPanel,
		options?: {
			registerMessageHandler?: boolean;
			hideFooterControls?: boolean;
			initialDocumentLoading?: boolean;
			compatibilityPersistence?: CompatibilityPersistenceEnvelope;
		}
	): Promise<void> {
		this.sqlLifecycle.startSession();
		this._panelDisposed = false;
		perfMark('host.queryEditorProvider.initialize.start', { initialDocumentLoading: !!options?.initialDocumentLoading });
		this.fileOpenTrace?.mark('queryEditorProvider.initialize.start', { visible: panel.visible, active: panel.active, viewType: panel.viewType, documentUri: this.documentUri });
		this.kustoFavoritesApplication.activate();
		this.fileOpenTrace?.mark('queryEditorProvider.connection.activate.done');
		this.panel = panel;
		this.editorCursorStatusApplication.setPanelVisible(panel.visible);
		QueryEditorProvider.activeProviders.add(this);
		this.registerPanelDisposal(panel);
		// Do NOT set panel.iconPath here — this method is called for custom editors
		// where VS Code owns the panel. Setting iconPath on a custom-editor panel
		// can crash VS Code's renderer-side editor integration ("Unexpected type"
		// in $setIconPath) and break the entire webview. Standalone panels set
		// their icon in openEditor() instead.
		this.fileOpenTrace?.mark('queryEditorProvider.html.load.start');
		const webview = panel.webview;
		const html = await getQueryEditorHtml(webview, this.extensionUri, this.context, {
			hideFooterControls: !!options?.hideFooterControls,
			initialDocumentLoading: !!options?.initialDocumentLoading,
			documentTitle: this.documentUri ? path.posix.basename(vscode.Uri.parse(this.documentUri).path) : undefined,
			compatibilityPersistence: options?.compatibilityPersistence,
		});
		if (this._panelDisposed || this.panel !== panel) return;
		this.editorCursorStatusApplication.setPanelVisible(panel.visible);
		webview.html = html;
		perfMark('host.queryEditorProvider.htmlAssigned');
		this.fileOpenTrace?.mark('queryEditorProvider.html.assigned');
		this.embeddedTutorialHost = new EmbeddedTutorialWebviewHost(
			this.panel,
			this.documentUri,
			message => this.postMessage(message),
		);
		this.embeddedTutorialRegistration = EmbeddedTutorialWebviewRegistry.register(this.embeddedTutorialHost);
		this.fileOpenTrace?.mark('queryEditorProvider.embeddedTutorial.registered');

		const shouldRegisterMessageHandler = options?.registerMessageHandler !== false;
		if (shouldRegisterMessageHandler) {
			// Ensure messages from the webview are handled in all host contexts (including custom editors).
			// openEditor() also wires this up for the standalone panel, but custom editors call initializeWebviewPanel().
			this.panel.webview.onDidReceiveMessage(input => this.handlePanelWebviewMessage(input));
		}
		this.fileOpenTrace?.mark('queryEditorProvider.messageHandler.configured', { shouldRegisterMessageHandler });

		// Connect the tool orchestrator to this webview instance
		this.workbenchToolSessionApplication.activate();
		this.fileOpenTrace?.mark('queryEditorProvider.toolOrchestrator.connected');

		// Reconnect the orchestrator when this panel becomes visible again
		// (e.g. user switches from another .kqlx tab back to this one).
		this.panel.onDidChangeViewState(() => {
			this.fileOpenTrace?.mark('queryEditorProvider.viewState.changed', { visible: this.panel?.visible, active: this.panel?.active });
			const visible = this.panel?.visible === true;
			this.editorCursorStatusApplication.setPanelVisible(visible);
			if (visible) {
				this.workbenchToolSessionApplication.activate();
			}
		});

		this.sendWorkbenchSettings();
		this.watchWorkbenchSettings();
		perfMark('host.queryEditorProvider.initialize.end');
		this.fileOpenTrace?.mark('queryEditorProvider.initialize.end');
	}

	/** URI string of the backing document (set by custom editor providers before initializeWebviewPanel). */
	documentUri?: string;
	async requestSectionsFromWebview(purpose?: 'schema-refresh', targetConnectionId?: string): Promise<unknown[] | undefined> {
		return this.workbenchToolSessionApplication.requestSectionsFromWebview(purpose, targetConnectionId);
	}

	updateDevelopmentNotes(message: import('../shared/developmentNoteMutationProtocol').DevelopmentNoteMutationPayload): Promise<{ success: boolean; error?: string }> {
		return this.developmentNoteMutationApplication.updateDevelopmentNotes(message);
	}

	async openEditor(): Promise<void> {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			return;
		}
		this.kustoFavoritesApplication.activate();
		this.sqlLifecycle.startSession();
		this._panelDisposed = false;

		this.panel = vscode.window.createWebviewPanel(
			'kustoQueryEditor',
			'Kusto Query Editor',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [this.extensionUri],
				retainContextWhenHidden: true
			}
		);
		const panel = this.panel;
		this.editorCursorStatusApplication.setPanelVisible(panel.visible);
		this.registerPanelDisposal(panel);
		try {
			const light = vscode.Uri.joinPath(this.extensionUri, 'media', 'images', 'kusto-file-light.svg');
			const dark = vscode.Uri.joinPath(this.extensionUri, 'media', 'images', 'kusto-file-dark.svg');
			this.panel.iconPath = { light, dark };
		} catch {
			// ignore
		}

		const webview = panel.webview;
		const html = await getQueryEditorHtml(webview, this.extensionUri, this.context);
		if (this._panelDisposed || this.panel !== panel) return;
		this.editorCursorStatusApplication.setPanelVisible(panel.visible);
		webview.html = html;


		this.panel.webview.onDidReceiveMessage(input => this.handlePanelWebviewMessage(input));

		// Connect the tool orchestrator to this webview instance
		this.workbenchToolSessionApplication.activate();

		// Reconnect the orchestrator when this panel becomes visible again
		this.panel.onDidChangeViewState(() => {
			const visible = this.panel?.visible === true;
			this.editorCursorStatusApplication.setPanelVisible(visible);
			if (visible) {
				this.workbenchToolSessionApplication.activate();
			}
		});

		this.sendWorkbenchSettings();
		this.watchWorkbenchSettings();
	}

	private handleDevelopmentNoteMutationResponse(input: unknown): boolean {
		const admission = admitDevelopmentNoteMutationWebviewMessage(input);
		if (!admission.recognized) return false;
		const copilotClaimed = this.developmentNoteMutationApplication?.handleResponseAdmission
			? this.developmentNoteMutationApplication.handleResponseAdmission(admission)
			: this.developmentNoteMutationApplication?.handleMessage(input) === true;
		if (copilotClaimed) return true;
		const agentClaimed = this.workbenchToolSessionApplication
			?.handleDevelopmentNoteMutationResponseAdmission
			? this.workbenchToolSessionApplication.handleDevelopmentNoteMutationResponseAdmission(admission)
			: this.workbenchToolSessionApplication?.handleDevelopmentNoteMutationResponse?.(input) === true;
		if (agentClaimed) return true;
		if (!admission.parsed.ok && !admission.requestId) {
			return this.developmentNoteMutationApplication?.hasPendingResponse?.() === true
				|| this.workbenchToolSessionApplication
					?.hasPendingDevelopmentNoteMutationResponse?.() === true;
		}
		return false;
	}

	private handlePanelWebviewMessage(input: unknown): void | Promise<void> {
		const envelope = captureRuntimeMessageEnvelope(input);
		if (!envelope.ok) return;
		input = envelope.value;
		const publicationAdmission = admitKustoPublicationWebviewMessageFromEnvelope(
			envelope.descriptorSnapshot,
		);
		if (publicationAdmission.recognized) {
			if (!publicationAdmission.parsed.ok) return;
			input = publicationAdmission.parsed.value;
		}
		const artifactCsvSaveAdmission = admitArtifactCsvSaveWebviewMessageFromEnvelope(
			envelope.descriptorSnapshot,
		);
		if (artifactCsvSaveAdmission.recognized) {
			if (!artifactCsvSaveAdmission.parsed.ok) return;
			input = artifactCsvSaveAdmission.parsed.value;
		}
		const toolStateAdmission = admitToolStateSnapshotWebviewMessageFromEnvelope(
			envelope.descriptorSnapshot,
		);
		if (toolStateAdmission.recognized) {
			if (!toolStateAdmission.parsed.ok) return;
			input = toolStateAdmission.parsed.value;
		}
		const executionStartAdmission = admitKustoExecutionStartWebviewMessageFromEnvelope(
			envelope.descriptorSnapshot,
		);
		if (executionStartAdmission.recognized) {
			if (!executionStartAdmission.parsed.ok) return;
			input = executionStartAdmission.parsed.value;
		}
		const powerBiPublishAdmission = admitPowerBiPublishWebviewMessageFromEnvelope(
			envelope.descriptorSnapshot,
		);
		if (powerBiPublishAdmission.recognized) {
			if (!powerBiPublishAdmission.parsed.ok) return;
			input = powerBiPublishAdmission.parsed.value;
		}
		if (this.handleDevelopmentNoteMutationResponse(input)) return;
		if (input && typeof input === 'object'
			&& (input as Record<string, unknown>).type === MAIN_WEBVIEW_DISPATCHER_READY_TYPE) return;
		const message = input as IncomingWebviewMessage;
		this.fileOpenTrace?.mark('queryEditorProvider.webviewMessage.received', { type: message?.type });
		return this.handleWebviewMessage(message, true);
	}

	public async handleWebviewMessage(
		message: IncomingWebviewMessage,
		developmentNoteMutationResponseChecked = false,
	): Promise<void> {
		const powerBiPublishAdmission = admitPowerBiPublishWebviewMessage(message);
		if (powerBiPublishAdmission.recognized) {
			if (!powerBiPublishAdmission.parsed.ok) return;
			message = powerBiPublishAdmission.parsed.value;
		}
		const publicationAdmission = admitKustoPublicationWebviewMessage(message);
		if (publicationAdmission.recognized) {
			if (!publicationAdmission.parsed.ok) return;
			message = publicationAdmission.parsed.value;
		}
		if (!developmentNoteMutationResponseChecked
			&& this.handleDevelopmentNoteMutationResponse(message)) return;
		if (message?.type === 'fileOpenTrace') {
			this.fileOpenTrace?.mark(`webview.${message.event}`, { timeMs: message.timeMs, sequence: message.sequence, detail: message.detail });
			return;
		}
		if (this.embeddedTutorialHost?.handleMessage(message)) {
			return;
		}
		const dashboardApplicationMessage = this.dashboardApplication?.handleMessage(message);
		if (dashboardApplicationMessage) {
			await dashboardApplicationMessage;
			return;
		}
		const artifactCsvSaveApplicationMessage = this.artifactCsvSaveApplication?.handleMessage(message);
		if (artifactCsvSaveApplicationMessage) {
			await artifactCsvSaveApplicationMessage;
			return;
		}
		const pythonExecutionApplicationMessage = this.pythonExecutionApplication?.handleMessage(message);
		if (pythonExecutionApplicationMessage) {
			await pythonExecutionApplicationMessage;
			return;
		}
		const importedCsvSaveApplicationMessage = this.importedCsvSaveApplication?.handleMessage(message);
		if (importedCsvSaveApplicationMessage) {
			await importedCsvSaveApplicationMessage;
			return;
		}
		const querySharingApplicationMessage = this.querySharingApplication?.handleMessage(message);
		if (querySharingApplicationMessage) {
			await querySharingApplicationMessage;
			return;
		}
		const urlContentApplicationMessage = this.urlContentApplication?.handleMessage(message);
		if (urlContentApplicationMessage) {
			await urlContentApplicationMessage;
			return;
		}
		const controlCommandSyntaxApplicationMessage = this.controlCommandSyntaxApplication?.handleMessage(message);
		if (controlCommandSyntaxApplicationMessage) {
			await controlCommandSyntaxApplicationMessage;
			return;
		}
		const resourceUriApplicationMessage = this.resourceUriApplication?.handleMessage(message);
		if (resourceUriApplicationMessage) {
			await resourceUriApplicationMessage;
			return;
		}
		const cachedValuesOpenApplicationMessage = this.cachedValuesOpenApplication?.handleMessage(message);
		if (cachedValuesOpenApplicationMessage) {
			await cachedValuesOpenApplicationMessage;
			return;
		}
		const copilotAgentOpenApplicationMessage = this.copilotAgentOpenApplication?.handleMessage(message);
		if (copilotAgentOpenApplicationMessage) {
			await copilotAgentOpenApplicationMessage;
			return;
		}
		const copilotContentOpenApplicationMessage = this.copilotContentOpenApplication?.handleMessage(message);
		if (copilotContentOpenApplicationMessage) {
			await copilotContentOpenApplicationMessage;
			return;
		}
		if (this.informationNotificationApplication?.handleMessage(message)) {
			return;
		}
		const editorCursorStatusApplicationMessage = this.editorCursorStatusApplication?.handleMessage(message);
		if (editorCursorStatusApplicationMessage) {
			if (editorCursorStatusApplicationMessage !== true) {
				await editorCursorStatusApplicationMessage;
			}
			return;
		}
		const editingPreferencesApplicationMessage = this.editingPreferencesApplication?.handleMessage(message);
		if (editingPreferencesApplicationMessage) {
			await editingPreferencesApplicationMessage;
			return;
		}
		const kustoConnectionIntakeApplicationMessage = this.kustoConnectionIntakeApplication?.handleMessage(message);
		if (kustoConnectionIntakeApplicationMessage) {
			await kustoConnectionIntakeApplicationMessage;
			return;
		}
		const kustoConnectionOnboardingApplicationMessage = this.kustoConnectionOnboardingApplication?.handleMessage(message);
		if (kustoConnectionOnboardingApplicationMessage) {
			await kustoConnectionOnboardingApplicationMessage;
			return;
		}
		const sqlConnectionOnboardingApplicationMessage = this.sqlConnectionOnboardingApplication?.handleMessage(message);
		if (sqlConnectionOnboardingApplicationMessage) {
			await sqlConnectionOnboardingApplicationMessage;
			return;
		}
		const sqlFavoritesApplicationMessage = this.sqlFavoritesApplication?.handleMessage(message);
		if (sqlFavoritesApplicationMessage) {
			await sqlFavoritesApplicationMessage;
			return;
		}
		const kustoFavoritesApplicationMessage = this.kustoFavoritesApplication?.handleMessage(message);
		if (kustoFavoritesApplicationMessage) {
			await kustoFavoritesApplicationMessage;
			return;
		}
		const sqlDatabaseDiscoveryApplicationMessage = this.sqlDatabaseDiscoveryApplication?.handleMessage(message);
		if (sqlDatabaseDiscoveryApplicationMessage) {
			await sqlDatabaseDiscoveryApplicationMessage;
			return;
		}
		const sqlSchemaRequestApplicationMessage = this.sqlSchemaRequestApplication?.handleMessage(message);
		if (sqlSchemaRequestApplicationMessage) {
			await sqlSchemaRequestApplicationMessage;
			return;
		}
		const sqlConnectionsProjectionApplicationMessage
			= this.sqlConnectionsProjectionApplication?.handleMessage(message);
		if (sqlConnectionsProjectionApplicationMessage) {
			await sqlConnectionsProjectionApplicationMessage;
			return;
		}
		const kqlLanguageRequestApplicationMessage = this.kqlLanguageRequestApplication?.handleMessage(message);
		if (kqlLanguageRequestApplicationMessage) {
			await kqlLanguageRequestApplicationMessage;
			return;
		}
		const sqlLastSelectionApplicationMessage = this.sqlLastSelectionApplication?.handleMessage(message);
		if (sqlLastSelectionApplicationMessage) {
			await sqlLastSelectionApplicationMessage;
			return;
		}
		const copilotInlineCompletionApplicationMessage = this.copilotInlineCompletionApplication?.handleMessage(message);
		if (copilotInlineCompletionApplicationMessage) {
			await copilotInlineCompletionApplicationMessage;
			return;
		}
		const copilotAvailabilityApplicationMessage = this.copilotAvailabilityApplication?.handleMessage(message);
		if (copilotAvailabilityApplicationMessage) {
			await copilotAvailabilityApplicationMessage;
			return;
		}
		const copilotWriteQueryPreparationApplicationMessage
			= this.copilotWriteQueryPreparationApplication?.handleMessage(message);
		if (copilotWriteQueryPreparationApplicationMessage) {
			await copilotWriteQueryPreparationApplicationMessage;
			return;
		}
		const copilotConversationClearApplicationMessage
			= this.copilotConversationClearApplication?.handleMessage(message);
		if (copilotConversationClearApplicationMessage) {
			await copilotConversationClearApplicationMessage;
			return;
		}
		const copilotHistoryRemovalApplicationMessage
			= this.copilotHistoryRemovalApplication?.handleMessage(message);
		if (copilotHistoryRemovalApplicationMessage) {
			await copilotHistoryRemovalApplicationMessage;
			return;
		}
		const copilotChatFirstTimeApplicationMessage
			= this.copilotChatFirstTimeApplication?.handleMessage(message);
		if (copilotChatFirstTimeApplicationMessage) {
			await copilotChatFirstTimeApplicationMessage;
			return;
		}
		const workbenchToolSessionApplicationMessage
			= this.workbenchToolSessionApplication?.handleMessage(message);
		if (workbenchToolSessionApplicationMessage) {
			await workbenchToolSessionApplicationMessage;
			return;
		}
		const kustoConnectionBrowsingApplicationMessage
			= this.kustoConnectionBrowsingApplication?.handleMessage(message);
		if (kustoConnectionBrowsingApplicationMessage) {
			await kustoConnectionBrowsingApplicationMessage;
			return;
		}
		const copilotQueryWorkflowApplicationMessage
			= this.copilotQueryWorkflowApplication?.handleMessage(message);
		if (copilotQueryWorkflowApplicationMessage) {
			await copilotQueryWorkflowApplicationMessage;
			return;
		}
		const kustoSectionExecutionApplicationMessage
			= this.kustoSectionExecutionApplication?.handleMessage(message);
		if (kustoSectionExecutionApplicationMessage) {
			await kustoSectionExecutionApplicationMessage;
			return;
		}
		const comparisonPreparationApplicationMessage
			= this.comparisonPreparationApplication?.handleMessage(message);
		if (comparisonPreparationApplicationMessage) {
			await comparisonPreparationApplicationMessage;
			return;
		}
		const sqlSectionExecutionApplicationMessage
			= this.sqlSectionExecutionApplication?.handleMessage(message);
		if (sqlSectionExecutionApplicationMessage) {
			await sqlSectionExecutionApplicationMessage;
			return;
		}
		const sqlEditorLifecycleApplicationMessage
			= this.sqlEditorLifecycleApplication?.handleMessage(message);
		if (sqlEditorLifecycleApplicationMessage) {
			await sqlEditorLifecycleApplicationMessage;
			return;
		}
		const kustoSchemaRequestApplicationMessage
			= this.kustoSchemaRequestApplication?.handleMessage(message);
		if (kustoSchemaRequestApplicationMessage) {
			await kustoSchemaRequestApplicationMessage;
		}
	}

	async ensureComparisonBoxInWebview(
		sourceBoxId: string,
		comparisonQuery: string,
		token: vscode.CancellationToken,
		copilotSequence?: number,
		kustoRequest?: KustoCopilotRequestIdentity,
	): Promise<PreparedComparisonSection> {
		return this.comparisonPreparationApplication.ensureComparisonBoxInWebview(
			sourceBoxId,
			comparisonQuery,
			token,
			copilotSequence,
			kustoRequest,
		);
	}

	normalizeClusterUrlKey(url: string): string {
		return kustoClusterKey(url);
	}

	// ── Delegating wrappers for ConnectionService methods ──
	// These keep the public API stable for external callers and CopilotServiceHost.

	findConnection(connectionId: string): KustoConnection | undefined {
		return this.connection.findConnection(connectionId);
	}

	public async refreshConnectionsData(): Promise<void> {
		await this.kustoConnectionsProjectionApplication.refresh();
	}

	public async refreshSqlConnectionsData(): Promise<void> {
		await this.sqlConnectionsProjectionApplication.refresh();
	}

	public async inferClusterDatabaseForKqlQuery(
		queryText: string
	): Promise<{ clusterUrl: string; database: string; authorityId?: string; connectionIdHint: string } | undefined> {
		return this.connection.inferClusterDatabaseForKqlQuery(queryText);
	}

	public getKustoFavorites() {
		return this.kustoFavoritesApplication.getFavorites();
	}

	revealPanel(): void {
		this.panel?.reveal(vscode.ViewColumn.One);
	}


	private cancelAllRunningQueries(): void {
		this.queryRuns.cancelAll();
	}

	postMessage(message: unknown): Thenable<boolean> {
		if (this._panelDisposed) return Promise.resolve(false);
		const executionStartAdmission = admitKustoExecutionStartHostMessage(message);
		if (executionStartAdmission.recognized) {
			if (!executionStartAdmission.parsed.ok) return Promise.resolve(false);
			message = executionStartAdmission.parsed.value;
		}
		const toolStateAdmission = admitToolStateSnapshotHostMessage(message);
		if (toolStateAdmission.recognized) {
			if (!toolStateAdmission.parsed.ok) return Promise.resolve(false);
			message = toolStateAdmission.parsed.value;
		}
		const powerBiPublishAdmission = admitPowerBiPublishHostMessage(message);
		if (powerBiPublishAdmission.recognized) {
			if (!powerBiPublishAdmission.parsed.ok) return Promise.resolve(false);
			message = powerBiPublishAdmission.parsed.value;
		}
		try {
			if (this.messageTransport) {
				return Promise.resolve(this.messageTransport(message)).catch(error => {
					if (!this._panelDisposed) {
						this.output.warn(`[webview] postMessage failed: ${sanitizeStsLogText(error instanceof Error ? error.message : error)}`);
					}
					return false;
				});
			}
			const panel = this.panel;
			if (!panel) return Promise.resolve(false);
			const delivery = panel.webview.postMessage(message);
			return Promise.resolve(delivery).catch(error => {
				if (!this._panelDisposed) {
					this.output.warn(`[webview] postMessage failed: ${sanitizeStsLogText(error instanceof Error ? error.message : error)}`);
				}
				return false;
			});
		} catch (error) {
			if (!this._panelDisposed) {
				this.output.warn(`[webview] postMessage failed: ${sanitizeStsLogText(error instanceof Error ? error.message : error)}`);
			}
			return Promise.resolve(false);
		}
	}

	private registerPanelDisposal(panel: vscode.WebviewPanel): void {
		this.panelDisposalSubscription?.dispose();
		this.panelDisposalSubscription = panel.onDidDispose(() => this.disposePanel(panel));
	}

	disposePanel(panel: vscode.WebviewPanel): void {
		if (this.panel !== panel || this._panelDisposed) return;
		this._panelDisposed = true;
		QueryEditorProvider.activeProviders.delete(this);
		this.panelDisposalSubscription?.dispose();
		this.panelDisposalSubscription = undefined;
		this.dashboardApplication.dispose();
		this.artifactCsvSaveApplication.dispose();
		this.pythonExecutionApplication.dispose();
		this.importedCsvSaveApplication.dispose();
		this.querySharingApplication.dispose();
		this.urlContentApplication.dispose();
		this.controlCommandSyntaxApplication.dispose();
		this.resourceUriApplication.dispose();
		this.copilotContentOpenApplication.dispose();
		this.informationNotificationApplication.dispose();
		this.cachedValuesOpenApplication.dispose();
		this.copilotAgentOpenApplication.dispose();
		this.developmentNoteMutationApplication.dispose();
		this.copilotInlineCompletionApplication.dispose();
		this.copilotAvailabilityApplication.dispose();
		this.copilotWriteQueryPreparationApplication.dispose();
		this.copilotConversationClearApplication.dispose();
		this.copilotHistoryRemovalApplication.dispose();
		this.copilotChatFirstTimeApplication.dispose();
		this.workbenchToolSessionApplication.dispose();
		this.kustoConnectionBrowsingApplication.dispose();
		this.kustoConnectionsProjectionApplication.dispose();
		this.copilotQueryWorkflowApplication.dispose();
		this.kustoSectionExecutionApplication.dispose();
		this.comparisonPreparationApplication.dispose();
		this.sqlSectionExecutionApplication.dispose();
		this.sqlEditorLifecycleApplication.dispose();
		this.kustoSchemaRequestApplication.dispose();
		this.sqlConnectionsProjectionApplication.dispose();
		this.copilot.disposeKustoOwners();
		this.copilot.invalidateSqlConnections(
			[], [...this.sqlLifecycle.listComparisonBoxIds()],
		);
		this.sqlLifecycle.disposeSubscriptions();
		this.persistedResultSanitizationApplication.dispose();
		this.fileOpenTrace?.mark('queryEditorProvider.dispose.start');
		this.sqlLifecycle.dispose();
		this.editorCursorStatusApplication.dispose();
		this.editingPreferencesApplication.dispose();
		this.kustoConnectionIntakeApplication.dispose();
		this.kustoConnectionOnboardingApplication.dispose();
		this.sqlConnectionOnboardingApplication.dispose();
		this.sqlFavoritesApplication.dispose();
		this.kustoFavoritesApplication.dispose();
		this.sqlDatabaseDiscoveryApplication.dispose();
		this.sqlSchemaRequestApplication.dispose();
		this.kqlLanguageRequestApplication.dispose();
		this.sqlLastSelectionApplication.dispose();
		this.kustoExecutionCoordinator.dispose();
		this.cancelAllRunningQueries();
		this.kustoClient.dispose();
		this.embeddedTutorialRegistration?.dispose();
		this.embeddedTutorialRegistration = undefined;
		this.embeddedTutorialHost = undefined;
		this.configSubscription?.dispose();
		this.configSubscription = undefined;
		this.authPreferenceSubscription?.dispose();
		this.authPreferenceSubscription = undefined;
		this.kustoConnectionLifecycle.dispose();
		this.panel = undefined;
	}

	// ── Alternating row color setting ──────────────────────────────────────────

	private sendWorkbenchSettings(): void {
		const configuration = vscode.workspace.getConfiguration('kustoWorkbench');
		const alternatingRowColor = configuration.get<string>('alternatingRowColor', 'theme');
		const htmlPowerBiCompatibilityCheckEnabled = configuration.get<boolean>('html.powerBiCompatibilityCheck.enabled', true);
		this.postMessage({ type: 'settingsUpdate', alternatingRowColor, htmlPowerBiCompatibilityCheckEnabled });
	}

	private watchWorkbenchSettings(): void {
		this.configSubscription?.dispose();
		this.configSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('kustoWorkbench.alternatingRowColor') || e.affectsConfiguration('kustoWorkbench.html.powerBiCompatibilityCheck.enabled')) {
				this.sendWorkbenchSettings();
			}
		});
	}

	// ── Schema cache wrappers for CopilotServiceHost / ConnectionServiceHost ──

	async getCachedSchemaFromDisk(cacheKey: string): Promise<CachedSchemaEntry | undefined> {
		return this.schema.getCachedSchemaFromDisk(cacheKey);
	}

	async saveCachedSchemaToDisk(cacheKey: string, entry: CachedSchemaEntry): Promise<void> {
		return this.schema.saveCachedSchemaToDisk(cacheKey, entry);
	}

	async executeKustoSectionQuery(options: KustoSectionQueryExecutionOptions) {
		return this.kustoSectionExecutionApplication.executeKustoSectionQuery(options);
	}

	public sanitizeSqlLeaveNoTraceState<T extends { sections?: unknown[] }>(state: T): T {
		return this.persistedResultSanitizationApplication.sanitizeSqlLeaveNoTraceState(state);
	}

	public sanitizeSqlLeaveNoTraceStateFresh<T extends { sections?: unknown[] }>(state: T): Promise<T> {
		return this.persistedResultSanitizationApplication.sanitizeSqlLeaveNoTraceStateFresh(state);
	}

	public sanitizeSqlLeaveNoTraceStateFailClosed<T extends { sections?: unknown[] }>(state: T): T {
		return this.persistedResultSanitizationApplication.sanitizeSqlLeaveNoTraceStateFailClosed(state);
	}

	public publishSqlLeaveNoTraceStateFresh<T extends { sections?: unknown[] }, R>(
		state: T,
		publish: (sanitizedState: T) => Promise<R>,
	): Promise<R> {
		return this.persistedResultSanitizationApplication.publishSqlLeaveNoTraceStateFresh(state, publish);
	}

	buildCacheDirective(
		cacheEnabled?: boolean,
		cacheValue?: number,
		cacheUnit?: CacheUnit | string
	): string | undefined {
		return buildCacheDirectiveFn(cacheEnabled, cacheValue, cacheUnit);
	}

	isControlCommand(query: string): boolean {
		return isControlCommandFn(query);
	}

	appendQueryMode(query: string, queryMode?: string): string {
		return appendQueryModeFn(query, queryMode);
	}

	normalizeControlCommandForExecution(query: string): string {
		return normalizeControlCommandForExecutionFn(query);
	}

	// HTML rendering moved to src/queryEditorHtml.ts
}
