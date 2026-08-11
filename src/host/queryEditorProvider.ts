import * as vscode from 'vscode';

import * as crypto from 'crypto';

import { ConnectionManager, KustoConnection } from './connectionManager';
import { KustoQueryClient } from './kustoClient';
import { SqlQueryClient } from './sqlClient';
import { SqlSchemaService, sqlSchemaPrincipalFingerprintForPrincipal } from './sqlEditorSchema';
import { SqlWorkbenchService, type SqlOwnerSnapshot } from './sql/sqlWorkbenchService';
import {
	sqlResultOwnersEqual,
	type SqlResultOwner,
} from './sql/sqlEditorSessionRegistry';
import { SqlEditorLifecycleCoordinator } from './sql/sqlEditorLifecycleCoordinator';
import { sanitizeStsLogText } from './sql/stsLogSanitizer';
import { normalizeSqlServerUrl } from './sql/sqlAuthState';
import { clearSqlTokenOverride, setSqlServerAccountMapEntry, setSqlTokenOverride } from './sql/sqlAuthState';
import { KustoConnectionLifecycle } from './kustoConnectionLifecycle';
import {
	getOwnedSqlDatabaseCacheEntry,
	sqlDatabaseTargetSignature,
	SQL_DATABASE_CACHE_STORAGE_KEY,
} from './sqlDatabaseCache';
import { getQueryEditorHtml } from './queryEditorHtml';
import type { CompatibilityPersistenceEnvelope } from '../shared/compatibilityPersistenceProtocol';
import { MAIN_WEBVIEW_DISPATCHER_READY_TYPE } from './mainWebviewStartupGateway';
import { toolOrchestrator } from './extension';
import { CopilotService, CopilotServiceHost } from './queryEditorCopilot';
import { ConnectionService, ConnectionServiceHost } from './queryEditorConnection';
import { kustoClusterKey } from '../shared/kustoClusterUrls';
import { canonicalSectionKind } from '../shared/documentSectionCapabilities';
import { sqlConnectionTargetSignatureMatches } from '../shared/sqlConnectionIdentity';
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
	STORAGE_KEYS,
	CachedSchemaEntry,
	CacheUnit,
	IncomingWebviewMessage,
	findPreferredDefaultCopilotModel
} from './queryEditorTypes';
import { EditorCursorStatusBar } from './editorCursorStatusBar';
import { KustoAuthPreferenceService, type KustoAuthPreferenceChange } from './kustoAuthPreferenceService';
import type { KustoLeaveNoTracePolicySnapshot } from './kustoLeaveNoTracePolicyStore';
import { getKustoConnectionIdentityKey, resolveKustoConnection } from '../shared/kustoAuth';
import { EmbeddedTutorialWebviewHost, EmbeddedTutorialWebviewRegistry } from './tutorials/embeddedTutorialWebviewHost';
import { perfMark } from './perfTrace';
import { getWorkbenchLogger, type WorkbenchLogger } from './workbenchLogger';
import type { FileOpenTrace } from './fileOpenTrace';
import { getEditingPreferencesData } from './editingPreferences';
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
	private _sqlConnectionsSnapshotRevision = 0;
	private sqlConnectionsSnapshotTail: Promise<boolean> = Promise.resolve(true);
	private readonly sqlPersistenceInvalidationEmitter = new vscode.EventEmitter<void>();
	readonly onDidInvalidateSqlPersistence = this.sqlPersistenceInvalidationEmitter.event;
	private readonly kustoPersistenceInvalidationEmitter = new vscode.EventEmitter<void>();
	readonly onDidInvalidateKustoPersistence = this.kustoPersistenceInvalidationEmitter.event;

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
		});
		this.pythonExecutionApplication = pythonExecutionApplication ?? new HostPythonExecutionApplicationHandler({
			postMessage: message => this.postMessage(message),
		});
		this.importedCsvSaveApplication = importedCsvSaveApplication ?? new HostImportedCsvSaveApplicationHandler();
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
				refreshConnections: () => this.sendConnectionsData(),
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
				refreshConnections: () => this.sendConnectionsData(),
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
		this.kustoFavoritesApplication = kustoFavoritesApplication
			?? new HostKustoFavoritesApplicationHandler({
				context: this.context,
				connectionManager: this.connectionManager,
				kustoClient: this.kustoClient,
				authPreferences: KustoAuthPreferenceService.getInstance(this.context),
				postMessage: message => this.postMessage(message),
				output: this.output,
			});
		this.schema = new SchemaService(this);
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
				invalidatePersistence: () => this.sqlPersistenceInvalidationEmitter.fire(),
				refreshConnectionsData: () => this.sendSqlConnectionsData(),
				prefetchSchema: request => this.sqlSchemaRequestApplication.requestSchema(request),
			},
		});
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
				sendConnectionsData: policyRequestId => this.sendConnectionsData(policyRequestId),
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
				refreshConnectionsData: () => this.sendSqlConnectionsData(),
				output: this.output,
			});
		this.kustoConnectionLifecycle = new KustoConnectionLifecycle(this.connectionManager, {
			invalidateConnections: connectionIds => {
				this.kustoExecutionCoordinator.revokeConnections(connectionIds);
				this.copilot.invalidateKustoConnections([...connectionIds]);
				this.kustoPersistenceInvalidationEmitter.fire();
			},
			invalidatePhysicalTargets: connectionIds => this.kustoExecutionCoordinator.invalidatePhysicalConnections(connectionIds),
			publishIdentityChange: connectionIds => this.postMessage({
				type: 'kustoAuthIdentityChanged', connectionIds: [...connectionIds], reason: 'connection-mutated',
			}),
			refreshConnections: () => this.sendConnectionsData(),
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
			this.kustoPersistenceInvalidationEmitter.fire();
			if (change.reason !== 'success' || change.firstEstablishment !== true) {
				this.postMessage({ type: 'kustoAuthIdentityChanged', connectionIds: change.connectionIds, reason: change.reason });
			}
		}
		void this.sendConnectionsData();
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
	private connectionsDataRevision = 0;
	private connectionsDataTail: Promise<void> = Promise.resolve();

	async requestSectionsFromWebview(purpose?: 'schema-refresh', targetConnectionId?: string): Promise<unknown[] | undefined> {
		return this.workbenchToolSessionApplication.requestSectionsFromWebview(purpose, targetConnectionId);
	}

	updateDevelopmentNotes(message: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
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

	private handlePanelWebviewMessage(input: unknown): void | Promise<void> {
		if (input && typeof input === 'object'
			&& (input as Record<string, unknown>).type === MAIN_WEBVIEW_DISPATCHER_READY_TYPE) return;
		const message = input as IncomingWebviewMessage;
		this.fileOpenTrace?.mark('queryEditorProvider.webviewMessage.received', { type: message?.type });
		return this.handleWebviewMessage(message);
	}

	public async handleWebviewMessage(message: IncomingWebviewMessage): Promise<void> {
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
		if (message.type === 'toolResponse') {
			if (this.developmentNoteMutationApplication.handleMessage(message)) return;
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
		switch (message.type) {
			case 'getSqlConnections':
				await this.sendSqlConnectionsData();
				return;
			case 'sqlSectionOpen':
				this.sqlLifecycle.openSection(message.boxId, message.sectionInstanceId);
				return;
			case 'retireSqlTarget':
				this.sqlLifecycle.retireTarget(message.boxId, message.sectionInstanceId, message.targetGeneration);
				return;
			case 'testSetSqlAuthOverride':
				if (this.context.extensionMode === vscode.ExtensionMode.Production) {
					return;
				}
				await setSqlServerAccountMapEntry(this.context, message.serverUrl, message.accountId);
				await setSqlTokenOverride(this.context, message.accountId, message.token);
				return;
			case 'testClearSqlAuthOverride':
				if (this.context.extensionMode === vscode.ExtensionMode.Production) {
					return;
				}
				await clearSqlTokenOverride(this.context, message.accountId);
				return;
			case 'stsRequest':
				await this.sqlLifecycle.handleLanguageRequest(message.requestId, message.method, message.params);
				return;
			case 'stsDidOpen':
				this.sqlLifecycle.didOpen(message.boxId, message.sectionInstanceId, message.text);
				return;
			case 'stsDidChange':
				await this.sqlLifecycle.didChange(message.boxId, message.sectionInstanceId, message.text);
				return;
			case 'stsDidClose':
				this.sqlLifecycle.didClose(message.boxId, message.sectionInstanceId);
				return;
			case 'stsConnect':
				await this.sqlLifecycle.connect(
					message.boxId, message.sectionInstanceId, message.sqlConnectionId, message.database,
					message.targetGeneration, message.expectedOwner,
				);
				return;
			case 'prefetchSchema':
				await this.schema.prefetchSchema(message.connectionId, message.database, message.boxId, !!message.forceRefresh, message.requestToken, {
					cacheOnly: !!message.cacheOnly,
					silent: !!message.silent,
					reason: message.reason,
				}, message.sectionInstanceId !== undefined && message.targetGeneration !== undefined ? {
					sectionInstanceId: message.sectionInstanceId,
					targetGeneration: message.targetGeneration,
				} : undefined);
				return;
			case 'requestCrossClusterSchema':
				await this.schema.handleCrossClusterSchemaRequest(message.clusterName, message.database, message.boxId, message.requestToken, message.requestSource, message.traceId);
				return;
			default:
				return;
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
		await this.sendConnectionsData();
	}

	public async refreshSqlConnectionsData(): Promise<void> {
		await this.sendSqlConnectionsData();
	}

	public async inferClusterDatabaseForKqlQuery(
		queryText: string
	): Promise<{ clusterUrl: string; database: string; authorityId?: string; connectionIdHint: string } | undefined> {
		return this.connection.inferClusterDatabaseForKqlQuery(queryText);
	}

	public getKustoFavorites() {
		return this.kustoFavoritesApplication.getFavorites();
	}

	private async sendConnectionsData(policyRequestId?: string): Promise<void> {
		const revision = ++this.connectionsDataRevision;
		const send = async () => {
			const { type: _type, revision: editingPreferencesRevision, ...editingPreferences } = getEditingPreferencesData(this.context);
			await this.connection.sendConnectionsData({
				...editingPreferences,
				editingPreferencesRevision,
				connectionsRevision: revision,
				copilotChatFirstTimeDismissed: !!this.context.globalState.get<boolean>(STORAGE_KEYS.copilotChatFirstTimeDismissed),
				...(policyRequestId ? { policyRequestId } : {}),
			});
		};
		this.connectionsDataTail = this.connectionsDataTail.then(send, send);
		await this.connectionsDataTail;
	}

	revealPanel(): void {
		this.panel?.reveal(vscode.ViewColumn.One);
	}


	private cancelAllRunningQueries(): void {
		this.queryRuns.cancelAll();
	}

	postMessage(message: unknown): Thenable<boolean> {
		if (this._panelDisposed) return Promise.resolve(false);
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
		this.copilotQueryWorkflowApplication.dispose();
		this.kustoSectionExecutionApplication.dispose();
		this.comparisonPreparationApplication.dispose();
		this.sqlSectionExecutionApplication.dispose();
		this.copilot.disposeKustoOwners();
		this.copilot.invalidateSqlConnections(
			[], [...this.sqlLifecycle.listComparisonBoxIds()],
		);
		this.sqlLifecycle.disposeSubscriptions();
		this.sqlPersistenceInvalidationEmitter.dispose();
		this.kustoPersistenceInvalidationEmitter.dispose();
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

	// ── SQL connection helpers ───────────────────────────────────────────────

	private async sendSqlConnectionsData(): Promise<boolean> {
		const publish = () => this.publishSqlConnectionsDataSnapshot();
		const result = this.sqlConnectionsSnapshotTail.then(publish, publish);
		this.sqlConnectionsSnapshotTail = result.catch(() => false);
		return result;
	}

	private async publishSqlConnectionsDataSnapshot(): Promise<boolean> {
		const revision = (this._sqlConnectionsSnapshotRevision ?? 0) + 1;
		this._sqlConnectionsSnapshotRevision = revision;
		const capturedConnections = this.sqlConnectionManager.getConnections();
		const cacheEntries = new Map<string, Awaited<ReturnType<typeof getOwnedSqlDatabaseCacheEntry>>>();
		for (const connection of capturedConnections) {
			cacheEntries.set(connection.id, await getOwnedSqlDatabaseCacheEntry(this.context, SQL_DATABASE_CACHE_STORAGE_KEY, connection));
		}
		const lastSqlConnectionId = this.context.globalState.get<string>('sql.lastConnectionId') || '';
		const lastSqlDatabase = this.context.globalState.get<string>('sql.lastDatabase') || '';
		return this.sqlWorkbench.dispatchSqlOwnerSnapshot(async snapshot => {
			const canonicalProtectedIds = snapshot.policy.globallyBlocked
				? new Set(snapshot.connections.map(connection => connection.id))
				: new Set(snapshot.policy.connectionIds);
			const principalByConnectionId = new Map<string, string>();
			const publishedConnections = snapshot.connections.map(connection => {
				const authType = String(connection.authType || '').trim().toLowerCase();
				const principal = authType === 'aad'
					? snapshot.accountsByServer[normalizeSqlServerUrl(connection.serverUrl)]
					: String(connection.username || '').trim();
				const principalFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(connection, principal);
				if (principalFingerprint) principalByConnectionId.set(connection.id, principalFingerprint);
				const revocationGeneration = snapshot.policy.revocationGenerations[connection.id] ?? 0;
				return canonicalProtectedIds.has(connection.id) || !principalFingerprint
					? { ...connection, revocationGeneration }
					: { ...connection, principalFingerprint, revocationGeneration };
			});
			const cachedDatabases = Object.fromEntries(snapshot.connections.flatMap(connection => {
				if (canonicalProtectedIds.has(connection.id)) return [];
				const entry = cacheEntries.get(connection.id);
				if (!entry
					|| entry.targetSignature !== sqlDatabaseTargetSignature(connection)
					|| entry.principalFingerprint !== principalByConnectionId.get(connection.id)) return [];
				return [[connection.id, entry.databases] as const];
			}));
			const delivered = await this.postMessage({
				type: 'sqlConnectionsData',
				revision,
				sqlStateVersions: {
					policy: snapshot.policy.version,
					connections: snapshot.connectionVersion,
					principals: snapshot.principalVersion,
				},
				connections: publishedConnections,
				lastConnectionId: lastSqlConnectionId,
				lastDatabase: lastSqlDatabase,
				cachedDatabases,
				sqlFavorites: this.sqlFavoritesApplication.getFavorites()
					.filter(favorite => !canonicalProtectedIds.has(favorite.connectionId)),
				sqlLeaveNoTrace: [...canonicalProtectedIds],
			});
			return delivered === true;
		});
	}

	public sanitizeSqlLeaveNoTraceState<T extends { sections?: unknown[] }>(state: T): T {
		state = this.stripLegacyResultPayloads(state);
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		this.sqlLifecycle.reconcileComparisonOwners(sections);
		const sectionsById = new Map(
			sections
				.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object')
				.map(section => [String(section.id || '').trim(), section] as const)
				.filter(([id]) => !!id),
		);
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object') return section;
			const boxId = String((section as any).id || '').trim();
			const sectionType = String((section as any).type || '');
			const persistedSourceBoxId = String((section as any).comparisonSourceBoxId || '').trim();
			const persistedSource = persistedSourceBoxId ? sectionsById.get(persistedSourceBoxId) : undefined;
			if (persistedSourceBoxId && !persistedSource && 'resultJson' in section) {
				changed = true;
				const clone = { ...(section as Record<string, unknown>) };
				delete clone.resultJson;
				delete clone.resultArtifact;
				return clone;
			}
			const derivedOwner = boxId ? this.sqlLifecycle.getComparisonOwner(boxId) : undefined;
			const persistedSqlSource = String((persistedSource as any)?.type || '') === 'sql' ? persistedSource : undefined;
			if (sectionType !== 'sql' && !derivedOwner && !persistedSqlSource) return section;
			const connectionId = derivedOwner?.connectionId ?? (boxId ? this.sqlLifecycle.getConnectionId(boxId) : undefined);
			const sourceConnectionId = persistedSourceBoxId ? this.sqlLifecycle.getConnectionId(persistedSourceBoxId) : undefined;
			const persistedConnectionId = String(
				(persistedSqlSource as any)?.connectionIdHint
				|| (section as any).connectionIdHint
				|| '',
			).trim();
			const persistedTargetSignature = String((persistedSqlSource as any)?.targetSignature || (section as any).targetSignature || '');
			let restoredConnectionId: string | undefined;
			if (persistedConnectionId && persistedTargetSignature) {
				const hintedConnection = this.sqlConnectionManager.getConnection(persistedConnectionId);
				if (hintedConnection && sqlConnectionTargetSignatureMatches(hintedConnection, persistedTargetSignature)) {
					restoredConnectionId = hintedConnection.id;
				}
			}
			const hasPersistedOwner = !!persistedConnectionId || !!persistedTargetSignature;
			const requiresPersistedOwner = sectionType === 'sql' || !!persistedSqlSource;
			const effectiveConnectionId = requiresPersistedOwner || hasPersistedOwner
				? restoredConnectionId
				: connectionId ?? sourceConnectionId;
			const serverUrl = String((persistedSqlSource as any)?.serverUrl || (section as any).serverUrl || '').trim().toLowerCase();
			const protectedByRuntimeOwner = !!effectiveConnectionId && this.sqlWorkbench.isLeaveNoTraceConnection(effectiveConnectionId);
			const protectedByRestoredServer = !effectiveConnectionId && !!serverUrl && this.sqlConnectionManager.getConnections().some(connection =>
				this.sqlWorkbench.isLeaveNoTraceConnection(connection.id)
				&& String(connection.serverUrl || '').trim().toLowerCase() === serverUrl
			);
			const sqlOwnedSection = sectionType === 'sql' || !!derivedOwner || !!persistedSqlSource;
			const unresolvedPersistedOwner = sqlOwnedSection && !effectiveConnectionId;
			if ((!protectedByRuntimeOwner && !protectedByRestoredServer && !unresolvedPersistedOwner) || !('resultJson' in section)) return section;
			changed = true;
			const clone = { ...(section as Record<string, unknown>) };
			delete clone.resultJson;
			delete clone.resultArtifact;
			return clone;
		});
		return this.stripOrphanedSqlPrincipalFingerprints(changed ? { ...state, sections: sanitized } : state);
	}

	private stripLegacyResultPayloads<T extends { sections?: unknown[] }>(state: T): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object') return section;
			const record = section as Record<string, unknown>;
			const type = String(record.type || '');
			const canonicalType = canonicalSectionKind(type);
			if ((canonicalType !== 'query' && canonicalType !== 'sql')
				|| !Object.prototype.hasOwnProperty.call(record, 'result')) return section;
			changed = true;
			const clone = { ...record };
			delete clone.result;
			return clone;
		});
		return changed ? { ...state, sections: sanitized } : state;
	}

	private sanitizeKustoLeaveNoTraceStateFromSnapshot<T extends { sections?: unknown[] }>(
		state: T,
		snapshot: KustoLeaveNoTracePolicySnapshot,
	): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		const sectionsById = new Map(sections
			.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object')
			.map(section => [String(section.id || '').trim(), section] as const));
		const protectedClusters = new Set(snapshot.clusterKeys);
		const connections = this.connectionManager.getConnections();
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object' || !('resultJson' in section)) return section;
			const record = section as Record<string, unknown>;
			if (canonicalSectionKind(record.type) !== 'query') return section;
			const sourceBoxId = String(record.comparisonSourceBoxId || '').trim();
			const source = sourceBoxId ? sectionsById.get(sourceBoxId) : undefined;
			if (sourceBoxId && String(source?.type || '') === 'sql') return section;
			const sourceOwnsComparison = !!sourceBoxId && !!source;
			const clusterUrl = String(sourceOwnsComparison ? source.clusterUrl : record.clusterUrl || '').trim();
			const database = String(sourceOwnsComparison ? source.database : record.database || '').trim();
			const authorityId = sourceOwnsComparison ? source.authorityId : record.authorityId;
			const connectionIdHint = sourceOwnsComparison ? source.connectionIdHint : record.connectionIdHint;
			const hasExplicitComparisonOwner = !!String(record.clusterUrl || record.authorityId || record.connectionIdHint || record.database || '').trim();
			const comparisonOwnerMatches = !sourceOwnsComparison || !hasExplicitComparisonOwner || (
				kustoClusterKey(record.clusterUrl) === kustoClusterKey(source.clusterUrl)
				&& String(record.authorityId || '').trim().toLowerCase() === String(source.authorityId || '').trim().toLowerCase()
				&& String(record.connectionIdHint || '').trim() === String(source.connectionIdHint || '').trim()
				&& String(record.database || '').trim().toLowerCase() === String(source.database || '').trim().toLowerCase()
			);
			let ownerMatches = false;
			let currentAccountPartition = '';
			let currentLeaveNoTraceRevision = -1;
			try {
				const resolution = resolveKustoConnection(connections, {
					clusterUrl,
					authorityId,
					connectionIdHint,
				});
				ownerMatches = !!database
					&& resolution.kind === 'matched'
					&& (!String(connectionIdHint || '').trim()
						|| resolution.connection.id === String(connectionIdHint || '').trim());
				if (resolution.kind === 'matched') {
					currentAccountPartition = String(this.kustoClient.getAccountPartition(resolution.connection) || '').trim();
					currentLeaveNoTraceRevision = snapshot.revocationGenerations?.[kustoClusterKey(clusterUrl)] ?? 0;
				}
			} catch {
				ownerMatches = false;
			}
			const protectedResult = snapshot.globallyBlocked || protectedClusters.has(kustoClusterKey(clusterUrl));
			const persistedAccountPartition = String(record.kustoAccountPartition || '').trim();
			const persistedLeaveNoTraceRevision = Number(record.kustoLeaveNoTraceRevision);
			const resultOwnerMatches = !!persistedAccountPartition
				&& persistedAccountPartition === currentAccountPartition
				&& Number.isSafeInteger(persistedLeaveNoTraceRevision)
				&& persistedLeaveNoTraceRevision >= 0
				&& persistedLeaveNoTraceRevision === currentLeaveNoTraceRevision;
			if (comparisonOwnerMatches && ownerMatches && resultOwnerMatches && !protectedResult) return section;
			changed = true;
			const clone = { ...record };
			delete clone.resultJson;
			delete clone.resultArtifact;
			delete clone.kustoAccountPartition;
			delete clone.kustoLeaveNoTraceRevision;
			return clone;
		});
		return changed ? { ...state, sections: sanitized } : state;
	}

	private stripAllKustoOwnedResults<T extends { sections?: unknown[] }>(state: T): T {
		return this.sanitizeKustoLeaveNoTraceStateFromSnapshot(state, {
			clusterKeys: [],
			globallyBlocked: true,
			version: 0,
			revocationGenerations: {},
		});
	}

	private stripOrphanedSqlPrincipalFingerprints<T extends { sections?: unknown[] }>(state: T): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object') return section;
			const record = section as Record<string, unknown>;
			const orphanedArtifact = 'resultArtifact' in record && !String(record.resultJson || '');
			const orphanedSqlPrincipal = String(record.type || '') === 'sql'
				&& ('principalFingerprint' in record || 'revocationGeneration' in record)
				&& !String(record.resultJson || '');
			if (!orphanedArtifact && !orphanedSqlPrincipal) return section;
			changed = true;
			const clone = { ...record };
			if (orphanedArtifact) delete clone.resultArtifact;
			if (orphanedSqlPrincipal) {
				delete clone.principalFingerprint;
				delete clone.revocationGeneration;
			}
			return clone;
		});
		return changed ? { ...state, sections: sanitized } : state;
	}

	private stripAllSqlOwnedResults<T extends { sections?: unknown[] }>(state: T): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		const sectionTypesById = new Map(sections
			.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object')
			.map(section => [String(section.id || '').trim(), String(section.type || '')]));
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object' || !('resultJson' in section)) return section;
			const record = section as Record<string, unknown>;
			const type = String(record.type || '');
			const sourceBoxId = String(record.comparisonSourceBoxId || '').trim();
			const sqlOwned = type === 'sql'
				|| (!!sourceBoxId && (sectionTypesById.get(sourceBoxId) === 'sql' || !sectionTypesById.has(sourceBoxId)));
			if (!sqlOwned) return section;
			changed = true;
			const clone = { ...record };
			delete clone.resultJson;
			delete clone.resultArtifact;
			return clone;
		});
		return this.stripOrphanedSqlPrincipalFingerprints(changed ? { ...state, sections: sanitized } : state);
	}

	private sanitizeSqlPrincipalOwnedResultsFromSnapshot<T extends { sections?: unknown[] }>(state: T, snapshot: SqlOwnerSnapshot): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		const sectionsById = new Map(sections
			.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object')
			.map(section => [String(section.id || '').trim(), section] as const));
		const connectionsById = new Map(snapshot.connections.map(connection => [connection.id, connection]));
		const protectedIds = snapshot.policy.globallyBlocked
			? new Set(snapshot.connections.map(connection => connection.id))
			: new Set(snapshot.policy.connectionIds);
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object' || !('resultJson' in section)) return section;
			const record = section as Record<string, unknown>;
			const sourceBoxId = String(record.comparisonSourceBoxId || '').trim();
			const source = sourceBoxId ? sectionsById.get(sourceBoxId) : undefined;
			const owner = String(source?.type || '') === 'sql' ? source! : record;
			if (String(owner.type || '') !== 'sql') return section;
			const connectionId = String(owner.connectionIdHint || '').trim();
			const targetSignature = String(owner.targetSignature || '');
			const persistedPrincipalFingerprint = String(owner.principalFingerprint || '').trim();
			const persistedRevocationGeneration = Number(owner.revocationGeneration ?? 0);
			const connection = connectionsById.get(connectionId);
			let ownerMatches = !!connection
				&& !protectedIds.has(connectionId)
				&& !!targetSignature
				&& sqlConnectionTargetSignatureMatches(connection, targetSignature)
				&& Number.isSafeInteger(persistedRevocationGeneration)
				&& persistedRevocationGeneration === (snapshot.policy.revocationGenerations[connectionId] ?? 0);
			if (ownerMatches && connection) {
				const authType = String(connection.authType || '').trim().toLowerCase();
				const principal = authType === 'aad'
					? snapshot.accountsByServer[normalizeSqlServerUrl(connection.serverUrl)]
					: String(connection.username || '').trim();
				const currentPrincipalFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(connection, principal);
				ownerMatches = authType === 'aad'
					? !!persistedPrincipalFingerprint && persistedPrincipalFingerprint === currentPrincipalFingerprint
					: !persistedPrincipalFingerprint || persistedPrincipalFingerprint === currentPrincipalFingerprint;
			}
			if (ownerMatches) return section;
			changed = true;
			const clone = { ...record };
			delete clone.resultJson;
			delete clone.resultArtifact;
			return clone;
		});
		return this.stripOrphanedSqlPrincipalFingerprints(changed ? { ...state, sections: sanitized } : state);
	}

	private hasSqlOwnedState(state: { sections?: unknown[] }): boolean {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		const sectionTypesById = new Map(sections
			.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object')
			.map(section => [String(section.id || '').trim(), String(section.type || '')]));
		return sections.some(section => {
			if (!section || typeof section !== 'object') return false;
			if (String((section as Record<string, unknown>).type || '') === 'sql') return true;
			const sourceBoxId = String((section as Record<string, unknown>).comparisonSourceBoxId || '').trim();
			return !!sourceBoxId && sectionTypesById.get(sourceBoxId) === 'sql';
		});
	}

	public async sanitizeSqlLeaveNoTraceStateFresh<T extends { sections?: unknown[] }>(state: T): Promise<T> {
		state = this.stripLegacyResultPayloads(state);
		try {
			return await this.sqlWorkbench.retrySqlOwnerSnapshotAcquisition(async () => {
				return this.connectionManager.runWithLeaveNoTraceSnapshotLock(async kustoSnapshot => {
					const kustoSanitized = this.sanitizeKustoLeaveNoTraceStateFromSnapshot(state, kustoSnapshot);
					const locallySanitized = this.sanitizeSqlLeaveNoTraceState(kustoSanitized);
					if (!this.hasSqlOwnedState(locallySanitized)) return { acquired: true as const, value: locallySanitized };
					return this.sqlWorkbench.tryDispatchSqlOwnerSnapshot(snapshot =>
						this.sanitizeSqlPrincipalOwnedResultsFromSnapshot(locallySanitized, snapshot));
				});
			});
		} catch {
			return this.stripAllSqlOwnedResults(this.stripAllKustoOwnedResults(this.sanitizeSqlLeaveNoTraceState(state)));
		}
	}

	public sanitizeSqlLeaveNoTraceStateFailClosed<T extends { sections?: unknown[] }>(state: T): T {
		state = this.stripLegacyResultPayloads(state);
		const locallySanitized = this.stripAllKustoOwnedResults(this.sanitizeSqlLeaveNoTraceState(state));
		return this.hasSqlOwnedState(locallySanitized)
			? this.stripAllSqlOwnedResults(locallySanitized)
			: locallySanitized;
	}

	public async publishSqlLeaveNoTraceStateFresh<T extends { sections?: unknown[] }, R>(
		state: T,
		publish: (sanitizedState: T) => Promise<R>,
	): Promise<R> {
		state = this.stripLegacyResultPayloads(state);
		return this.sqlWorkbench.retrySqlOwnerSnapshotAcquisition(async () => {
			return this.connectionManager.runWithLeaveNoTraceSnapshotLock(async kustoSnapshot => {
				const kustoSanitized = this.sanitizeKustoLeaveNoTraceStateFromSnapshot(state, kustoSnapshot);
				const locallySanitized = this.sanitizeSqlLeaveNoTraceState(kustoSanitized);
				if (!this.hasSqlOwnedState(locallySanitized)) return { acquired: true as const, value: await publish(locallySanitized) };
				return this.sqlWorkbench.tryRunWithSqlOwnerSnapshotLock(async sqlSnapshot => {
					return publish(this.sanitizeSqlPrincipalOwnedResultsFromSnapshot(locallySanitized, sqlSnapshot));
				});
			});
		});
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
