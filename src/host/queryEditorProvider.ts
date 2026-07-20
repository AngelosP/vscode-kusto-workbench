import * as vscode from 'vscode';

import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

import { ConnectionManager, KustoConnection } from './connectionManager';
import { KustoQueryClient, QueryExecutionError } from './kustoClient';
import { SqlQueryClient, SqlQueryCancelledError } from './sqlClient';
import { readCurrentSqlSchemaPrincipalFingerprint, SqlSchemaService, sqlSchemaPrincipalFingerprint, sqlSchemaPrincipalFingerprintForPrincipal } from './sqlEditorSchema';
import { StsProcessManager } from './sql/stsProcessManager';
import { StsLanguageService } from './sql/stsLanguageService';
import { SqlWorkbenchService, type SqlOwnerSnapshot } from './sql/sqlWorkbenchService';
import {
	SqlEditorOwnershipRegistry,
	sqlResultOwnersEqual,
	type SqlResultOwner,
} from './sql/sqlEditorOwnershipRegistry';
import { sanitizeStsLogText } from './sql/stsLogSanitizer';
import { normalizeSqlServerUrl } from './sql/sqlAuthState';
import { clearSqlTokenOverride, setSqlServerAccountMapEntry, setSqlTokenOverride } from './sql/sqlAuthState';
import {
	beginSqlDatabaseCacheRequest,
	getOwnedSqlDatabaseCacheEntry,
	getOwnedSqlDatabaseLists,
	sqlDatabaseTargetSignature,
	SQL_DATABASE_CACHE_STORAGE_KEY,
	writeOwnedSqlDatabaseCacheEntry,
} from './sqlDatabaseCache';
import { KqlLanguageServiceHost } from './kqlLanguageService/host';
import { getQueryEditorHtml } from './queryEditorHtml';
import { toolOrchestrator } from './extension';
import { CopilotService, CopilotServiceHost, SQL_COPILOT_OWNER_CHANGED_MESSAGE } from './queryEditorCopilot';
import { openKustoWorkbenchAgentChat } from './copilotChatOpenUtils';
import { ConnectionService, ConnectionServiceHost } from './queryEditorConnection';
import { exportAzureDataExplorerClusterPath, kustoClusterKey } from '../shared/kustoClusterUrls';
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
import { appendSqlQueryMode as appendSqlQueryModeFn } from './sqlEditorUtils';
import {
	STORAGE_KEYS,
	CachedSchemaEntry,
	CacheUnit,
	IncomingWebviewMessage,
	SaveResultsCsvMessage,
	ExportDashboardMessage,
	RequestHtmlDashboardUpgradeWithCopilotMessage,
	ShowPowerBiPublishHelpMessage,
	ShowPowerBiPartialPublishWarningMessage,
	ShowPowerBiUnsupportedVisualHelpMessage,
	PublishToPowerBIMessage,
	findPreferredDefaultCopilotModel
} from './queryEditorTypes';
import { exportHtmlToPowerBI, findUnsupportedPowerBiBindings, normalizePowerBiDataMode, type PowerBiDataMode } from './powerBiExport';
import { listFabricWorkspaces, publishToPowerBIService, checkFabricItemExists } from './powerBiPublish';
import { EditorCursorStatusBar } from './editorCursorStatusBar';
import { KustoAuthPreferenceService } from './kustoAuthPreferenceService';
import { resolveKustoConnection, resolveStrictKustoConnection } from '../shared/kustoAuth';
import { EmbeddedTutorialWebviewHost, EmbeddedTutorialWebviewRegistry } from './tutorials/embeddedTutorialWebviewHost';
import { notifySavedFile, withCsvExtension } from './savedFileNotification';
import { perfMark } from './perfTrace';
import { getWorkbenchLogger, type WorkbenchLogger } from './workbenchLogger';
import type { FileOpenTrace } from './fileOpenTrace';
import { getEditingPreferencesData, setEditingPreference } from './editingPreferences';
import { QueryRunCoordinator } from './queryRunCoordinator';

type PendingComparisonEnsure = {
	resolve: (comparisonBoxId: string) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	sourceBoxId: string;
	sqlConnectionId?: string;
	copilotSequence?: number;
	comparisonBoxId?: string;
	cancellationDisposable?: vscode.Disposable;
};

const GITHUB_ISSUES_URL = 'https://github.com/AngelosP/vscode-kusto-workbench/issues';


export class QueryEditorProvider implements CopilotServiceHost, ConnectionServiceHost, SchemaServiceHost {
	private static cursorOwnerSequence = 0;

	private panel?: vscode.WebviewPanel;
	private _panelDisposed = true;
	private readonly cursorOwnerPrefix = `queryEditor:${++QueryEditorProvider.cursorOwnerSequence}:`;
	readonly kustoClient: KustoQueryClient;
	readonly output: WorkbenchLogger = getWorkbenchLogger();
	readonly connection: ConnectionService;
	readonly schema: SchemaService;
	private _queryRunCoordinator?: QueryRunCoordinator;

	private get queryRuns(): QueryRunCoordinator {
		return this._queryRunCoordinator ??= new QueryRunCoordinator();
	}

	// SQL editor-scoped services. Connection/runtime ownership is extension-scoped.
	private _sqlSchemaService?: SqlSchemaService;
	private _stsLanguageService?: StsLanguageService;
	private _stsInitPromise?: Promise<StsLanguageService | null>;
	private _sqlEditorSessionDisposed = false;
	private readonly _closedStsBoxIds = new Set<string>();
	private readonly _openedStsBoxIds = new Set<string>();
	private readonly _pendingStsTextByBoxId = new Map<string, string>();
	private readonly _sqlConnectionIdByBoxId = new Map<string, string>();
	private readonly _sqlComparisonOwnerByBoxId = new Map<string, {
		sourceBoxId: string;
		connectionId: string;
		copilotSequence?: number;
		comparisonRequestId?: string;
	}>();
	private readonly _comparisonOwnerByBoxId = new Map<string, {
		sourceBoxId: string;
		copilotSequence?: number;
		comparisonRequestId?: string;
	}>();
	private readonly _sqlDatabaseByBoxId = new Map<string, string>();
	private readonly _sqlTargetGenerationByBoxId = new Map<string, number>();
	private readonly _sqlOwnerTokenByBoxId = new Map<string, { token: string; owner: SqlResultOwner }>();
	private _sqlOwnershipRegistry?: SqlEditorOwnershipRegistry;
	private readonly _sqlDatabaseRequestIdByBoxId = new Map<string, string>();
	private readonly _sqlRunAdmissionGenerationByBoxId = new Map<string, number>();
	private readonly _pendingSqlRunAdmissionByBoxId = new Map<string, { generation: number; executionId: string; ownerToken?: string }>();
	private readonly _sqlCopilotPreflightByBoxId = new Map<string, { generation: number; active: boolean }>();
	private _sqlConnectionsSnapshotRevision = 0;
	private readonly _latestStsConnectSequenceByBoxId = new Map<string, number>();
	private readonly _stsConnectSequenceByBoxId = new Map<string, number>();
	private readonly sqlLeaveNoTraceSubscription: vscode.Disposable;
	private readonly stsRuntimeSubscription: vscode.Disposable;
	private readonly sqlConnectionsSubscription: vscode.Disposable;
	private readonly sqlPrincipalsSubscription: vscode.Disposable;
	private readonly sqlPersistenceInvalidationEmitter = new vscode.EventEmitter<void>();
	readonly onDidInvalidateSqlPersistence = this.sqlPersistenceInvalidationEmitter.event;
	private sqlConnectionSignatureById = new Map<string, string>();

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

	private get sqlOwnership(): SqlEditorOwnershipRegistry {
		const options = {
			context: this.context,
			sqlWorkbench: this.sqlWorkbench,
			connectionIdByBoxId: this._sqlConnectionIdByBoxId,
			comparisonOwnerByBoxId: this._sqlComparisonOwnerByBoxId,
			databaseByBoxId: this._sqlDatabaseByBoxId,
			targetGenerationByBoxId: this._sqlTargetGenerationByBoxId,
			ownerTokenByBoxId: this._sqlOwnerTokenByBoxId,
		};
		if (!this._sqlOwnershipRegistry?.matches(options)) {
			this._sqlOwnershipRegistry = new SqlEditorOwnershipRegistry(options);
		}
		return this._sqlOwnershipRegistry;
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
		return this.sqlOwnership.dispatchOwnerAllowed(boxId, expectedOwner, dispatch);
	}

	getSqlResultOwner(boxId: string): SqlResultOwner | undefined {
		return this.sqlOwnership.getOwner(boxId);
	}

	private async getCanonicalSqlResultOwner(boxId: string): Promise<SqlResultOwner | undefined> {
		return this.sqlOwnership.getCanonicalOwner(boxId);
	}

	async assertSqlResultOwnerAllowed(boxId: string, expectedOwner: SqlResultOwner): Promise<void> {
		await this.sqlOwnership.assertOwnerAllowed(boxId, expectedOwner);
	}

	private sqlResultOwnersEqual(left: SqlResultOwner | undefined, right: SqlResultOwner | undefined): boolean {
		return sqlResultOwnersEqual(left, right);
	}

	private async issueSqlOwnerToken(boxId: string, expectedOwner: SqlResultOwner): Promise<string> {
		return this.sqlOwnership.issueOwnerToken(
			boxId,
			expectedOwner,
			id => this.getCanonicalSqlResultOwner(id),
			(id, owner, dispatch) => this.dispatchSqlResultOwnerAllowed(id, owner, dispatch),
		);
	}

	private async assertSqlOwnerToken(boxId: string, token: string | undefined): Promise<{ token: string; owner: SqlResultOwner }> {
		return this.sqlOwnership.assertOwnerToken(
			boxId,
			token,
			(id, owner) => this.assertSqlResultOwnerAllowed(id, owner),
		);
	}

	private readonly pendingComparisonEnsureByRequestId = new Map<string, PendingComparisonEnsure>();

	private settlePendingComparisonEnsure(
		requestId: string,
		pending: PendingComparisonEnsure,
		outcome: { comparisonBoxId: string } | { error: Error },
	): void {
		if (this.pendingComparisonEnsureByRequestId.get(requestId) !== pending) return;
		this.pendingComparisonEnsureByRequestId.delete(requestId);
		try { clearTimeout(pending.timer); } catch { /* ignore */ }
		try { pending.cancellationDisposable?.dispose(); } catch { /* ignore */ }
		if ('error' in outcome) {
			const comparisonBoxId = String(pending.comparisonBoxId || '').trim();
			if (comparisonBoxId
				&& this._comparisonOwnerByBoxId.get(comparisonBoxId)?.comparisonRequestId === requestId) {
				this._comparisonOwnerByBoxId.delete(comparisonBoxId);
			}
			if (comparisonBoxId
				&& this._sqlComparisonOwnerByBoxId.get(comparisonBoxId)?.comparisonRequestId === requestId) {
				this._sqlComparisonOwnerByBoxId.delete(comparisonBoxId);
			}
			pending.reject(outcome.error);
			return;
		}
		pending.resolve(outcome.comparisonBoxId);
	}
	private readonly latestComparisonSummaryByKey = new Map<
		string,
		{ dataMatches: boolean; headersMatch: boolean; timestamp: number }
	>();
	private readonly pendingComparisonSummaryByKey = new Map<
		string,
		Array<{
			resolve: (summary: { dataMatches: boolean; headersMatch: boolean }) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}>
	>();
	private readonly kqlLanguageHost: KqlLanguageServiceHost;
	private readonly resolvedResourceUriCache = new Map<string, string>();
	private readonly controlCommandSyntaxCache = new Map<string, { timestamp: number; syntax: string; withArgs: string[]; error?: string }>();
	private readonly CONTROL_COMMAND_SYNTAX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
	private readonly copilot: CopilotService;
	private configSubscription?: vscode.Disposable;
	private authPreferenceSubscription?: vscode.Disposable;
	private embeddedTutorialHost?: EmbeddedTutorialWebviewHost;
	private embeddedTutorialRegistration?: vscode.Disposable;
	fileOpenTrace?: FileOpenTrace;

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
		private readonly editorCursorStatusBar?: EditorCursorStatusBar
	) {
		this.kustoClient = new KustoQueryClient(this.context, undefined, this.connectionManager);
		this.authPreferenceSubscription = KustoAuthPreferenceService.getInstance(this.context).onDidChange(change => {
			this.copilot.invalidateKustoConnections(change.connectionIds, {
				preserveEstablishingAccountPartition: change.reason === 'success' ? change.accountPartition : undefined,
			});
			if (change.reason !== 'success') {
				this.postMessage({ type: 'kustoAuthIdentityChanged', connectionIds: change.connectionIds, reason: change.reason });
			}
			void this.sendConnectionsData();
		});
		this.kqlLanguageHost = new KqlLanguageServiceHost(this.connectionManager, this.context);
		this.connection = new ConnectionService(this);
		this.schema = new SchemaService(this);
		this.copilot = new CopilotService(this);
		this.sqlLeaveNoTraceSubscription = this.sqlWorkbench.onDidChangeLeaveNoTrace(change => {
			this.applySqlLeaveNoTraceChange(change.connectionIds, change.invalidatedConnectionIds);
		});
		this.stsRuntimeSubscription = this.sqlWorkbench.runtime.onDidChangeProcessManager(change => {
			void this.handleStsRuntimeManagerChange(!!change.current);
		});
		this.sqlConnectionSignatureById = new Map(this.sqlConnectionManager.getConnections().map(connection => [
			connection.id,
			sqlDatabaseTargetSignature(connection),
		]));
		this.sqlConnectionsSubscription = this.sqlConnectionManager.onDidChangeConnections(connections => {
			void this.handleSqlConnectionsChanged(connections);
		});
		this.sqlPrincipalsSubscription = this.sqlWorkbench.onDidChangeSqlPrincipals(change => {
			void this.handleSqlPrincipalsChanged(change.connectionIds);
		});
	}

	async initializeWebviewPanel(
		panel: vscode.WebviewPanel,
		options?: { registerMessageHandler?: boolean; hideFooterControls?: boolean; initialDocumentLoading?: boolean }
	): Promise<void> {
		this._sqlEditorSessionDisposed = false;
		this._panelDisposed = false;
		perfMark('host.queryEditorProvider.initialize.start', { initialDocumentLoading: !!options?.initialDocumentLoading });
		this.fileOpenTrace?.mark('queryEditorProvider.initialize.start', { visible: panel.visible, active: panel.active, viewType: panel.viewType, documentUri: this.documentUri });
		this.connection.activate();
		this.fileOpenTrace?.mark('queryEditorProvider.connection.activate.done');
		this.panel = panel;
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
			initialDocumentLoading: !!options?.initialDocumentLoading
		});
		if (this._panelDisposed || this.panel !== panel) return;
		webview.html = html;
		perfMark('host.queryEditorProvider.htmlAssigned');
		this.fileOpenTrace?.mark('queryEditorProvider.html.assigned');
		this.embeddedTutorialHost = new EmbeddedTutorialWebviewHost(this.panel, this.documentUri);
		this.embeddedTutorialRegistration = EmbeddedTutorialWebviewRegistry.register(this.embeddedTutorialHost);
		this.fileOpenTrace?.mark('queryEditorProvider.embeddedTutorial.registered');

		const shouldRegisterMessageHandler = options?.registerMessageHandler !== false;
		if (shouldRegisterMessageHandler) {
			// Ensure messages from the webview are handled in all host contexts (including custom editors).
			// openEditor() also wires this up for the standalone panel, but custom editors call initializeWebviewPanel().
			this.panel.webview.onDidReceiveMessage((message: IncomingWebviewMessage) => {
				this.fileOpenTrace?.mark('queryEditorProvider.webviewMessage.received', { type: message?.type });
				return this.handleWebviewMessage(message);
			});
		}
		this.fileOpenTrace?.mark('queryEditorProvider.messageHandler.configured', { shouldRegisterMessageHandler });

		// Connect the tool orchestrator to this webview instance
		this.connectToolOrchestrator();
		this.fileOpenTrace?.mark('queryEditorProvider.toolOrchestrator.connected');

		// Reconnect the orchestrator when this panel becomes visible again
		// (e.g. user switches from another .kqlx tab back to this one).
		this.panel.onDidChangeViewState(() => {
			this.fileOpenTrace?.mark('queryEditorProvider.viewState.changed', { visible: this.panel?.visible, active: this.panel?.active });
			if (this.panel?.visible) {
				this.connectToolOrchestrator();
			} else {
				this.clearCursorStatusForProvider();
			}
		});

		this.sendWorkbenchSettings();
		this.watchWorkbenchSettings();
		perfMark('host.queryEditorProvider.initialize.end');
		this.fileOpenTrace?.mark('queryEditorProvider.initialize.end');
	}

	// Token returned by the orchestrator's connect(), used to guard disconnect.
	private toolOrchestratorToken: number | undefined;

	/** URI string of the backing document (set by custom editor providers before initializeWebviewPanel). */
	documentUri?: string;

	private connectToolOrchestrator(): void {
		if (!toolOrchestrator) return;
		if (this.toolOrchestratorToken !== undefined) {
			toolOrchestrator.activateConnection(this.toolOrchestratorToken);
			return;
		}

		this.toolOrchestratorToken = toolOrchestrator.connect(
			(message: unknown) => this.postMessage(message),
			async () => {
				const sections = await this.requestSectionsFromWebview();
				return sections as Array<{ id?: string; type: string; [key: string]: unknown }> | undefined;
			},
			async (clusterUrl: string, connectionId: string) => {
				const sections = await this.requestSectionsFromWebview() ?? [];
				const connections = this.connectionManager.getConnections();
				const targets = sections.flatMap(section => {
					const candidate = section as { id?: unknown; type?: unknown; connectionId?: unknown; schemaRequestToken?: unknown; clusterUrl?: unknown; authorityId?: unknown; connectionIdHint?: unknown; database?: unknown };
					if (candidate.type !== 'query' && candidate.type !== 'copilotQuery') return [];
					const boxId = String(candidate.id || '').trim();
					const database = String(candidate.database || '').trim();
					const runtimeConnectionId = String(candidate.connectionId || '').trim();
					const resolution = runtimeConnectionId
						? resolveStrictKustoConnection(connections, { clusterUrl: candidate.clusterUrl, connectionId: runtimeConnectionId })
						: resolveKustoConnection(connections, candidate);
					return boxId && database && resolution.kind === 'matched' && resolution.connection.id === connectionId
						? [{ boxId, database, requestToken: String(candidate.schemaRequestToken || '').trim() || undefined }]
						: [];
				});
				return this.schema.refreshSchemaForTools(clusterUrl, connectionId, targets);
			},
			this.documentUri,
			(sectionId?: string) => {
				const id = String(sectionId || '').trim();
				if (id) return this._sqlComparisonOwnerByBoxId.get(id)?.connectionId ?? this._sqlConnectionIdByBoxId.get(id);
				for (const connectionId of this._sqlConnectionIdByBoxId.values()) return connectionId;
				return undefined;
			},
			(sectionId: string) => {
				const id = String(sectionId || '').trim();
				if (!id) return undefined;
				const derivedOwner = this._sqlComparisonOwnerByBoxId.get(id);
				const sourceBoxId = derivedOwner?.sourceBoxId ?? id;
				const issued = this._sqlOwnerTokenByBoxId.get(id) ?? this._sqlOwnerTokenByBoxId.get(sourceBoxId);
				const connectionId = derivedOwner?.connectionId ?? this._sqlConnectionIdByBoxId.get(sourceBoxId);
				const database = this._sqlDatabaseByBoxId.get(sourceBoxId);
				if (!issued || !connectionId || !database || issued.owner.connectionId !== connectionId || issued.owner.database !== database) return undefined;
				return { connectionId, database, ownerToken: issued.token, generation: issued.owner.generation };
			},
		);
	}

	private disconnectToolOrchestrator(): void {
		if (!toolOrchestrator || this.toolOrchestratorToken === undefined) return;
		toolOrchestrator.disconnectIfOwner(this.toolOrchestratorToken);
		this.toolOrchestratorToken = undefined;
	}

	private getCursorStatusOwnerId(message: { boxId?: string; editorKind?: string }): string {
		const boxId = typeof message.boxId === 'string' && message.boxId.trim() ? message.boxId.trim() : '';
		const editorKind = typeof message.editorKind === 'string' && message.editorKind.trim() ? message.editorKind.trim() : 'editor';
		return `${this.cursorOwnerPrefix}${boxId || editorKind}`;
	}

	private handleEditorCursorPositionChanged(message: IncomingWebviewMessage & { type: 'editorCursorPositionChanged' }): void {
		if (!this.editorCursorStatusBar || !this.panel?.visible) {
			return;
		}
		this.editorCursorStatusBar.update(this.getCursorStatusOwnerId(message), message);
	}

	private async postEditorCursorStatusSnapshot(message: IncomingWebviewMessage & { type: 'getEditorCursorStatusSnapshot' }): Promise<void> {
		if (this.context.extensionMode === vscode.ExtensionMode.Production) {
			return;
		}
		try {
			await this.postMessage({
				type: 'editorCursorStatusSnapshot',
				requestId: message.requestId,
				snapshot: this.editorCursorStatusBar?.getSnapshot() ?? { visible: false, text: '' }
			});
		} catch {
			// ignore test-only snapshot failures
		}
	}

	private clearCursorStatusForProvider(): void {
		this.editorCursorStatusBar?.clearOwnerPrefix(this.cursorOwnerPrefix);
	}

	private toolStateResponseResolvers = new Map<string, (sections?: unknown[]) => void>();
	private connectionsDataRevision = 0;
	private connectionsDataTail: Promise<void> = Promise.resolve();

	async requestSectionsFromWebview(): Promise<unknown[] | undefined> {
		if (!this.panel) return undefined;
		
		const requestId = `state_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		
		return new Promise<unknown[] | undefined>((resolve) => {
			const timer = setTimeout(() => {
				this.toolStateResponseResolvers.delete(requestId);
				resolve(undefined);
			}, 5000);
			
			this.toolStateResponseResolvers.set(requestId, (sections) => {
				clearTimeout(timer);
				this.toolStateResponseResolvers.delete(requestId);
				if (sections) this.rebuildSqlComparisonOwners(sections);
				resolve(sections);
			});
			
			this.postMessage({ type: 'requestToolState', requestId });
		});
	}

	private rebuildSqlComparisonOwners(sections: unknown[]): void {
		const records = (Array.isArray(sections) ? sections : [])
			.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object');
		const ids = new Set(records.map(section => String(section.id || '').trim()).filter(Boolean));
		for (const boxId of [...this._sqlComparisonOwnerByBoxId.keys()]) {
			const owner = this._sqlComparisonOwnerByBoxId.get(boxId);
			if (!ids.has(boxId) || !owner || !ids.has(owner.sourceBoxId)) this._sqlComparisonOwnerByBoxId.delete(boxId);
		}
		for (const section of records) {
			const comparisonBoxId = String(section.id || '').trim();
			const sourceBoxId = String(section.comparisonSourceBoxId || '').trim();
			if (!comparisonBoxId || !sourceBoxId || !ids.has(sourceBoxId)) continue;
			const source = records.find(candidate => String(candidate.id || '').trim() === sourceBoxId);
			if (String(source?.type || '') !== 'sql') continue;
			const connectionId = this._sqlConnectionIdByBoxId.get(sourceBoxId);
			if (!connectionId) continue;
			const existing = this._sqlComparisonOwnerByBoxId.get(comparisonBoxId);
			if (!existing || existing.sourceBoxId !== sourceBoxId || existing.connectionId !== connectionId) {
				this._sqlComparisonOwnerByBoxId.set(comparisonBoxId, { sourceBoxId, connectionId });
			}
		}
	}

	async openEditor(): Promise<void> {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			return;
		}
		this.connection.activate();
		this._sqlEditorSessionDisposed = false;
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
		webview.html = html;


		this.panel.webview.onDidReceiveMessage((message: IncomingWebviewMessage) => {
			return this.handleWebviewMessage(message);
		});

		// Connect the tool orchestrator to this webview instance
		this.connectToolOrchestrator();

		// Reconnect the orchestrator when this panel becomes visible again
		this.panel.onDidChangeViewState(() => {
			if (this.panel?.visible) {
				this.connectToolOrchestrator();
			} else {
				this.clearCursorStatusForProvider();
			}
		});

		this.sendWorkbenchSettings();
		this.watchWorkbenchSettings();
	}

	public async handleWebviewMessage(message: IncomingWebviewMessage): Promise<void> {
		if (message?.type === 'fileOpenTrace') {
			this.fileOpenTrace?.mark(`webview.${message.event}`, { timeMs: message.timeMs, sequence: message.sequence, detail: message.detail });
			return;
		}
		if (this.embeddedTutorialHost?.handleMessage(message)) {
			return;
		}
		switch (message.type) {
			case 'editorCursorPositionChanged':
				this.handleEditorCursorPositionChanged(message);
				return;
			case 'getEditorCursorStatusSnapshot':
				await this.postEditorCursorStatusSnapshot(message);
				return;
			case 'comparisonBoxEnsured':
				try {
					const requestId = String(message.requestId || '');
					const comparisonBoxId = String(message.comparisonBoxId || '');
					const pending = requestId ? this.pendingComparisonEnsureByRequestId.get(requestId) : undefined;
					if (pending) {
						pending.comparisonBoxId = comparisonBoxId;
						if (comparisonBoxId) {
							this._comparisonOwnerByBoxId.set(comparisonBoxId, {
								sourceBoxId: pending.sourceBoxId,
								...(pending.copilotSequence !== undefined ? { copilotSequence: pending.copilotSequence } : {}),
								comparisonRequestId: requestId,
							});
						}
						if (pending.sqlConnectionId && comparisonBoxId) {
							const provisionalOwner = {
								sourceBoxId: pending.sourceBoxId,
								connectionId: pending.sqlConnectionId,
								...(pending.copilotSequence !== undefined ? { copilotSequence: pending.copilotSequence } : {}),
								comparisonRequestId: requestId,
							};
							this._sqlComparisonOwnerByBoxId.set(comparisonBoxId, provisionalOwner);
							try {
								await this.sqlWorkbench.assertSqlConnectionAllowed(pending.sqlConnectionId);
								const currentPending = this.pendingComparisonEnsureByRequestId.get(requestId);
								const currentOwner = this._sqlComparisonOwnerByBoxId.get(comparisonBoxId);
								if (currentPending !== pending || currentOwner?.comparisonRequestId !== requestId) {
									if (currentPending === pending) {
										this.settlePendingComparisonEnsure(requestId, pending, { error: new Error('Canceled') });
									}
									return;
								}
							} catch (error) {
								const currentPending = this.pendingComparisonEnsureByRequestId.get(requestId);
								if (currentPending !== pending
									|| this._sqlComparisonOwnerByBoxId.get(comparisonBoxId)?.comparisonRequestId !== requestId) {
									if (currentPending === pending) {
										this.settlePendingComparisonEnsure(requestId, pending, { error: new Error('Canceled') });
									}
									return;
								}
								this.postMessage({ type: 'sqlCopilotPolicyChanged', boxIds: [pending.sourceBoxId, comparisonBoxId] });
								this.settlePendingComparisonEnsure(requestId, pending, {
									error: error instanceof Error ? error : new Error(String(error)),
								});
								return;
							}
						}
						this.settlePendingComparisonEnsure(requestId, pending, { comparisonBoxId });
					}
				} catch {
					// ignore
				}
				return;
			case 'comparisonSummary':
				try {
					const sourceBoxId = String(message.sourceBoxId || '');
					const comparisonBoxId = String(message.comparisonBoxId || '');
					if (!sourceBoxId || !comparisonBoxId) {
						return;
					}
					const key = `${sourceBoxId}::${comparisonBoxId}`;
					const summary = {
						dataMatches: !!message.dataMatches,
						headersMatch: message.headersMatch === null || message.headersMatch === undefined ? true : !!message.headersMatch
					};
					this.latestComparisonSummaryByKey.set(key, { ...summary, timestamp: Date.now() });
					const pending = this.pendingComparisonSummaryByKey.get(key);
					if (pending && pending.length) {
						this.pendingComparisonSummaryByKey.delete(key);
						for (const w of pending) {
							try {
								clearTimeout(w.timer);
							} catch {
								// ignore
							}
							try {
								w.resolve(summary);
							} catch {
								// ignore
							}
						}
					}
				} catch {
					// ignore
				}
				return;
			case 'fetchControlCommandSyntax':
				await this.handleFetchControlCommandSyntax(message);
				return;
			case 'resolveResourceUri':
				await this.resolveResourceUri(message);
				return;
			case 'getConnections':
				await this.sendConnectionsData();
				return;
			case 'seeCachedValues':
				await vscode.commands.executeCommand('kusto.seeCachedValues');
				return;
			case 'requestAddFavorite':
				await this.connection.promptAddFavorite(message);
				return;
			case 'removeFavorite':
				await this.connection.removeFavorite(message.connectionId, message.database);
				return;
			case 'confirmRemoveFavorite':
				await this.connection.confirmRemoveFavorite(message);
				return;
			case 'requestAddSqlFavorite':
				await this.connection.promptAddSqlFavorite(message);
				return;
			case 'removeSqlFavorite':
				await this.connection.removeSqlFavorite(message.connectionId, message.database);
				return;
			case 'addConnectionsForClusters':
				await this.connection.addConnectionsForClusters(message.clusterUrls);
				await this.sendConnectionsData();
				return;
			case 'promptImportConnectionsXml':
				await this.connection.promptImportConnectionsXml(message.boxId);
				return;
			case 'setCaretDocsEnabled':
				await this.updateEditingPreference(STORAGE_KEYS.caretDocsEnabled, !!message.enabled);
				return;
			case 'setAutoTriggerAutocompleteEnabled':
				await this.updateEditingPreference(STORAGE_KEYS.autoTriggerAutocompleteEnabled, !!message.enabled);
				return;
			case 'setCopilotInlineCompletionsEnabled':
				await this.updateEditingPreference(STORAGE_KEYS.copilotInlineCompletionsEnabled, !!message.enabled);
				return;
			case 'requestCopilotInlineCompletion':
				if (message.flavor === 'sql') {
					try {
						const issued = await this.assertSqlOwnerToken(message.boxId, message.ownerToken);
						await this.copilot.handleCopilotInlineCompletionRequest(message, issued.owner, issued.token);
					} catch {
						this.postMessage({
							type: 'copilotInlineCompletionResult', requestId: message.requestId,
							boxId: message.boxId, ownerToken: message.ownerToken, completions: [],
						});
					}
				} else {
					await this.copilot.handleCopilotInlineCompletionRequest(message);
				}
				return;
			case 'getDatabases':
				await this.connection.sendDatabases(message.connectionId, message.boxId, {
					mode: 'passive',
					requestToken: message.requestToken,
					requiredDatabase: message.requiredDatabase,
				});
				return;
			case 'refreshDatabases':
				await this.connection.sendDatabases(message.connectionId, message.boxId, {
					mode: 'interactive-refresh',
					requestToken: message.requestToken,
					requiredDatabase: message.requiredDatabase,
				});
				return;
			case 'saveLastSelection':
				{
					const cid = String(message.connectionId || '').trim();
					if (!cid) {
						return;
					}
					await this.connection.saveLastSelection(cid, message.database);
				}
				try {
					await vscode.commands.executeCommand('kusto.refreshTextEditorDiagnostics');
				} catch {
					// ignore
				}
				return;
			case 'showInfo':
				vscode.window.showInformationMessage(message.message);
				return;
			case 'showPowerBiPublishHelp':
				await this.showPowerBiPublishHelp(message as ShowPowerBiPublishHelpMessage);
				return;
			case 'showPowerBiPartialPublishWarning':
				await this.showPowerBiPartialPublishWarning(message as ShowPowerBiPartialPublishWarningMessage);
				return;
			case 'showPowerBiUnsupportedVisualHelp':
				await this.showPowerBiUnsupportedVisualHelp(message as ShowPowerBiUnsupportedVisualHelpMessage);
				return;
			case 'saveResultsCsv':
				await this.saveResultsCsvFromWebview(message);
				return;
			case 'exportDashboard':
				await this.exportDashboardFromWebview(message as ExportDashboardMessage);
				return;
			case 'requestHtmlDashboardUpgradeWithCopilot':
				await this.requestHtmlDashboardUpgradeWithCopilot(message as RequestHtmlDashboardUpgradeWithCopilotMessage);
				return;
			case 'getPbiWorkspaces':
				await this.getPbiWorkspacesFromWebview(message as any);
				return;
			case 'publishToPowerBI':
				await this.publishToPowerBIFromWebview(message as PublishToPowerBIMessage);
				return;
			case 'checkPbiItemExists':
				await this.checkPbiItemExistsFromWebview(message as any);
				return;
			case 'checkCopilotAvailability':
				await this.copilot.checkCopilotAvailability(message.boxId);
				return;
			case 'prepareCopilotWriteQuery':
				await this.copilot.prepareCopilotWriteQuery(message);
				return;
			case 'startCopilotWriteQuery':
				if (message.flavor === 'sql') {
					const previous = this._sqlCopilotPreflightByBoxId.get(message.boxId);
					const generation = (previous?.generation ?? 0) + 1;
					this._sqlCopilotPreflightByBoxId.set(message.boxId, { generation, active: true });
					const isCurrentPreflight = () => {
						const current = this._sqlCopilotPreflightByBoxId.get(message.boxId);
						return current?.generation === generation && current.active;
					};
					try { await this.assertSqlOwnerToken(message.boxId, message.sqlOwnerToken); }
					catch {
						if (isCurrentPreflight()) {
							this.postMessage({
								type: 'copilotWriteQueryDone', boxId: message.boxId, ok: false,
								message: SQL_COPILOT_OWNER_CHANGED_MESSAGE, ownerToken: String(message.sqlOwnerToken || ''),
							});
						}
						return;
					}
					if (!isCurrentPreflight()) return;
					const run = this.copilot.startCopilotWriteQuery(message, this.sqlConnectionManager, this.sqlSchemaService, this.sqlClient);
					if (isCurrentPreflight()) this._sqlCopilotPreflightByBoxId.set(message.boxId, { generation, active: false });
					await run;
					return;
				}
				await this.copilot.startCopilotWriteQuery(message, this.sqlConnectionManager, this.sqlSchemaService, this.sqlClient);
				return;
			case 'cancelCopilotWriteQuery':
				{
					const preflight = this._sqlCopilotPreflightByBoxId.get(message.boxId);
					if (preflight?.active) {
						this._sqlCopilotPreflightByBoxId.set(message.boxId, { generation: preflight.generation + 1, active: false });
						const ownerToken = this._sqlOwnerTokenByBoxId.get(message.boxId)?.token;
						this.postMessage({ type: 'copilotWriteQueryDone', boxId: message.boxId, ok: false, message: 'Canceled.', ...(ownerToken ? { ownerToken } : {}) });
					}
				}
				this.copilot.cancelCopilotWriteQuery(message.boxId);
				return;
			case 'clearCopilotConversation':
				this.copilot.clearCopilotConversation(message.boxId);
				return;
			case 'openCopilotAgent':
				await openKustoWorkbenchAgentChat();
				return;
			case 'copilotChatFirstTimeCheck':
				await this.copilot.handleCopilotChatFirstTimeCheck(message.boxId);
				return;
			case 'removeFromCopilotHistory':
				this.copilot.removeFromCopilotHistory(message.boxId, message.entryId);
				return;
			case 'openToolResultInEditor':
				await this.openToolResultInEditor(message);
				return;
			case 'openMarkdownPreview':
				await this.openMarkdownPreview(message.filePath);
				return;
			case 'prepareOptimizeQuery':
				await this.copilot.prepareOptimizeQuery(message);
				return;
			case 'cancelOptimizeQuery':
				this.copilot.cancelOptimizeQuery(message.boxId);
				return;
			case 'optimizeQuery':
				await this.copilot.optimizeQueryWithCopilot(message);
				return;
			case 'executeQuery':
				await this.executeQueryFromWebview(message);
				return;
			case 'getSqlConnections':
				await this.sendSqlConnectionsData();
				return;
			case 'getSqlDatabases':
				if (!this.adoptSqlTarget(message.boxId, message.sqlConnectionId, undefined, message.targetGeneration)) return;
				await this.sendSqlDatabases(message.sqlConnectionId, message.boxId, false);
				return;
			case 'refreshSqlDatabases':
				if (!this.adoptSqlTarget(message.boxId, message.sqlConnectionId, undefined, message.targetGeneration)) return;
				await this.sendSqlDatabases(message.sqlConnectionId, message.boxId, true);
				return;
			case 'saveSqlLastSelection':
				{
					const cid = String(message.sqlConnectionId || '').trim();
					if (cid) {
						await this.context.globalState.update('sql.lastConnectionId', cid);
						if (message.database !== undefined) {
							await this.context.globalState.update('sql.lastDatabase', message.database);
						}
					}
				}
				return;
			case 'promptAddSqlConnection':
				await this.promptAddSqlConnection(message.boxId);
				return;
			case 'addSqlConnection':
				await this.addSqlConnectionFromWebview(message);
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
			case 'executeSqlQuery':
				await this.executeSqlQueryFromWebview(message);
				return;
			case 'cancelSqlQuery':
				if (message.executionId) {
					const pendingExecutionId = this._pendingSqlRunAdmissionByBoxId.get(message.boxId)?.executionId;
					const runningExecutionId = this.queryRuns.get(message.boxId)?.executionId;
					if (message.executionId !== pendingExecutionId && message.executionId !== runningExecutionId) return;
				}
				this.supersedeSqlRunAdmission(message.boxId, { notifyWebview: true });
				return;
			case 'prefetchSqlSchema':
				if (!this.adoptSqlTarget(message.boxId, message.sqlConnectionId, message.database, message.targetGeneration)) return;
				await this.prefetchSqlSchema(message.sqlConnectionId, message.database, message.boxId, !!message.forceRefresh);
				return;
			case 'stsRequest':
				await this.handleStsRequest(message.requestId, message.method, message.params);
				return;
			case 'stsDidOpen':
				this.handleStsDidOpen(message.boxId, message.text);
				return;
			case 'stsDidChange':
				await this.handleStsDidChange(message.boxId, message.text);
				return;
			case 'stsDidClose':
				this.handleStsDidClose(message.boxId);
				return;
			case 'sqlComparisonRemoved': {
				const comparisonBoxId = String(message.boxId || '').trim();
				if (!comparisonBoxId) return;
				const comparisonOwner = this._comparisonOwnerByBoxId.get(comparisonBoxId);
				const sqlOwner = this._sqlComparisonOwnerByBoxId.get(comparisonBoxId);
				const owner = sqlOwner ?? comparisonOwner;
				if (!owner) return;
				this._comparisonOwnerByBoxId.delete(comparisonBoxId);
				this._sqlComparisonOwnerByBoxId.delete(comparisonBoxId);
				this._sqlOwnerTokenByBoxId.delete(comparisonBoxId);
				this.deleteComparisonSummary(`${owner.sourceBoxId}::${comparisonBoxId}`);
				if (owner.comparisonRequestId) {
					const pending = this.pendingComparisonEnsureByRequestId.get(owner.comparisonRequestId);
					if (pending) {
						this.settlePendingComparisonEnsure(owner.comparisonRequestId, pending, { error: new Error('Canceled') });
					}
				}
				if (sqlOwner) this.supersedeSqlRunAdmission(comparisonBoxId, { notifyWebview: true });
				else this.cancelRunningQuery(comparisonBoxId, { notifyWebview: true });
				if (owner.copilotSequence !== undefined) {
					this.copilot.cancelCopilotQueryTarget(owner.sourceBoxId, comparisonBoxId, owner.copilotSequence);
				}
				const messageSourceBoxId = String(message.sourceBoxId || '').trim();
				if (messageSourceBoxId !== owner.sourceBoxId) return;
				if (owner.copilotSequence !== undefined) {
					this.copilot.cancelCopilotWriteQuery(owner.sourceBoxId, owner.copilotSequence);
				}
				return;
			}
			case 'stsConnect':
				await this.handleStsConnect(message.boxId, message.sqlConnectionId, message.database, message.targetGeneration, message.expectedOwner);
				return;
			case 'copyAdeLink':
				await this.copyAdeLinkFromWebview(message);
				return;
			case 'shareToClipboard':
				await this.shareToClipboardFromWebview(message);
				return;
			case 'cancelQuery':
				if (this.queryRuns.get(message.boxId)?.executionId !== message.executionId) return;
				this.cancelRunningQuery(message.boxId, { notifyWebview: true });
				return;
			case 'executePython':
				await this.executePythonFromWebview(message);
				return;
			case 'fetchUrl':
				await this.fetchUrlFromWebview(message);
				return;
			case 'prefetchSchema':
				await this.schema.prefetchSchema(message.connectionId, message.database, message.boxId, !!message.forceRefresh, message.requestToken, {
					cacheOnly: !!message.cacheOnly,
					silent: !!message.silent,
					reason: message.reason,
				});
				return;
			case 'requestCrossClusterSchema':
				await this.schema.handleCrossClusterSchemaRequest(message.clusterName, message.database, message.boxId, message.requestToken, message.requestSource, message.traceId);
				return;
			case 'importConnectionsFromXml':
				await this.connection.importConnectionsFromXml(message.connections);
				await this.sendConnectionsData();
				return;
			case 'promptAddConnection':
				await this.connection.promptAddConnection(message.boxId);
				return;
			case 'addConnection':
				await this.connection.addConnectionFromWebview(message);
				return;
			case 'testKustoConnection':
				await this.connection.testConnectionFromWebview(message);
				return;
			case 'kqlLanguageRequest':
				await this.handleKqlLanguageRequest(message);
				return;
			case 'toolResponse':
				// Handle response from webview for tool orchestrator commands
				if (toolOrchestrator && message.requestId) {
					toolOrchestrator.handleWebviewResponse(message.requestId, message.result, message.error);
				}
				return;
			case 'toolStateResponse':
				// Handle state response from webview
				{
					const resolver = this.toolStateResponseResolvers.get(message.requestId);
					if (resolver) {
						resolver(message.sections);
					}
				}
				return;
			default:
				return;
		}
	}

	private async copyAdeLinkFromWebview(
		message: Extract<IncomingWebviewMessage, { type: 'copyAdeLink' }>
	): Promise<void> {
		try {
			const boxId = String(message.boxId || '').trim();
			const query = String(message.query || '').trim();
			const database = String(message.database || '').trim();
			const connectionId = String(message.connectionId || '').trim();
			if (!query) {
				vscode.window.showInformationMessage('No query text to share.');
				return;
			}
			if (!connectionId) {
				vscode.window.showInformationMessage('Select a cluster connection first.');
				return;
			}
			if (!database) {
				vscode.window.showInformationMessage('Select a database first.');
				return;
			}

			const connection = this.connection.findConnection(connectionId);
			if (!connection) {
				vscode.window.showErrorMessage('Connection not found.');
				return;
			}
			const adxClusterPath = exportAzureDataExplorerClusterPath(String(connection.clusterUrl || '').trim());
			if (!adxClusterPath) {
				vscode.window.showErrorMessage('Could not determine cluster name for the selected connection.');
				return;
			}

			// Azure Data Explorer uses a gzip+base64 payload in the query string.
			let encoded = '';
			try {
				const gz = zlib.gzipSync(Buffer.from(query, 'utf8'));
				encoded = gz.toString('base64').replace(/=+$/g, '');
			} catch {
				vscode.window.showErrorMessage('Failed to encode the query for Azure Data Explorer.');
				return;
			}

			const url =
				`https://dataexplorer.azure.com/clusters/${encodeURIComponent(adxClusterPath)}` +
				`/databases/${encodeURIComponent(database)}` +
				`?query=${encodeURIComponent(encoded)}`;

			await vscode.env.clipboard.writeText(url);
			vscode.window.showInformationMessage('Azure Data Explorer link copied to clipboard.');
			try {
				if (boxId) {
					this.postMessage({ type: 'showInfo', message: 'Azure Data Explorer link copied to clipboard.' });
				}
			} catch {
				// ignore
			}
		} catch {
			vscode.window.showErrorMessage('Failed to copy Azure Data Explorer link.');
		}
	}

	private async shareToClipboardFromWebview(
		message: Extract<IncomingWebviewMessage, { type: 'shareToClipboard' }>
	): Promise<void> {
		try {
			const {
				includeTitle, includeQuery, includeResults,
				sectionName, queryText, connectionId, database,
				columns, rowsData, totalRows
			} = message;

			if (!includeTitle && !includeQuery && !includeResults) {
				vscode.window.showInformationMessage('Select at least one section to share.');
				return;
			}

			const htmlParts: string[] = [];
			const textParts: string[] = [];

			// Build the ADE link URL (shared between title HTML and plain text).
			let adeUrl = '';
			try {
				const trimmedQuery = String(queryText || '').trim();
				const trimmedConnectionId = String(connectionId || '').trim();
				const trimmedDatabase = String(database || '').trim();
				if (trimmedQuery && trimmedConnectionId && trimmedDatabase) {
					const connection = this.connection.findConnection(trimmedConnectionId);
					if (connection) {
						const adxClusterPath = exportAzureDataExplorerClusterPath(String(connection.clusterUrl || '').trim());
						if (adxClusterPath) {
							const gz = zlib.gzipSync(Buffer.from(trimmedQuery, 'utf8'));
							const encoded = gz.toString('base64').replace(/=+$/g, '');
							adeUrl =
								`https://dataexplorer.azure.com/clusters/${encodeURIComponent(adxClusterPath)}` +
								`/databases/${encodeURIComponent(trimmedDatabase)}` +
								`?query=${encodeURIComponent(encoded)}`;
						}
					}
				}
			} catch {
				// If URL generation fails, just skip the link.
			}

			const escHtml = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

			// 1. Title
			if (includeTitle) {
				const title = sectionName || 'Kusto Query';
				if (adeUrl) {
					htmlParts.push(`<b>${escHtml(title)}</b><br><a href="${escHtml(adeUrl)}">Direct link to query</a>`);
					textParts.push(`${title}\nDirect link to query: ${adeUrl}`);
				} else {
					htmlParts.push(`<b>${escHtml(title)}</b>`);
					textParts.push(title);
				}
			}

			// 2. Query â€” as a styled code block with a "Query" header.
			if (includeQuery) {
				const q = String(queryText || '').trim();
				if (q) {
					htmlParts.push(
						`<b style="font-size:13px">Query</b>` +
						`<pre style="background:#1e1e1e;color:#d4d4d4;padding:12px 16px;border-radius:6px;font-family:'Cascadia Code','Consolas','Courier New',monospace;font-size:13px;overflow-x:auto;white-space:pre;border:1px solid #333;margin-top:4px"><code class="kql">${escHtml(q)}</code></pre>`
					);
					textParts.push('Query\n' + q);
				}
			}

			// 3. Results â€” as an HTML table with a "Results" header.
			if (includeResults && Array.isArray(columns) && columns.length > 0 && Array.isArray(rowsData) && rowsData.length > 0) {
				const thCells = columns.map(c => `<th align="left" style="border:1px solid #555;padding:6px 10px;background:#2d2d2d;color:#e0e0e0;text-align:left;font-weight:600;font-size:12px;white-space:nowrap">${escHtml(c)}</th>`).join('');
				const bodyRows = rowsData.map((row, ri) => {
					const bg = ri % 2 === 0 ? '#1e1e1e' : '#252526';
					const cells = row.map(v => `<td align="left" style="border:1px solid #444;padding:4px 10px;color:#d4d4d4;font-size:12px;white-space:nowrap;text-align:left">${escHtml(v)}</td>`).join('');
					return `<tr style="background:${bg}">${cells}</tr>`;
				}).join('');

				// Plain-text fallback table.
				const escCell = (v: string) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
				const headerRow = '| ' + columns.map(escCell).join(' | ') + ' |';
				const separator = '| ' + columns.map(() => '---').join(' | ') + ' |';
				const dataRows = rowsData.map(row =>
					'| ' + row.map(escCell).join(' | ') + ' |'
				).join('\n');

				// Add a summary line when not all rows are included.
				const shownRows = rowsData.length;
				const total = typeof totalRows === 'number' && totalRows > 0 ? totalRows : shownRows;
				const summaryLine = total > shownRows
					? `Showing ${shownRows.toLocaleString()} of ${total.toLocaleString()} rows`
					: `${shownRows.toLocaleString()} rows`;

				htmlParts.push(
					`<b style="font-size:13px">Results</b><br>` +
					`<span style="font-size:11px;color:#888;font-style:italic">${escHtml(summaryLine)}</span>` +
					`<table style="border-collapse:collapse;font-family:'Segoe UI',sans-serif;margin:4px 0"><thead><tr>${thCells}</tr></thead><tbody>${bodyRows}</tbody></table>`
				);

				textParts.push('Results\n' + summaryLine + '\n' + headerRow + '\n' + separator + '\n' + dataRows);
			}

			if (htmlParts.length === 0) {
				vscode.window.showInformationMessage('Nothing to share â€” the selected sections are empty.');
				return;
			}

			const html = htmlParts.join('<br><br>');
			const text = textParts.join('\n\n');

			// Send the formatted content back to the webview so it can write
			// both text/html and text/plain to the clipboard via the browser API.
			this.postMessage({ type: 'shareContentReady', html, text });
			vscode.window.showInformationMessage('Copied to clipboard and ready to paste into Teams.');
		} catch {
			vscode.window.showErrorMessage('Failed to copy share content to clipboard.');
		}
	}

	private async showPowerBiPublishHelp(message: ShowPowerBiPublishHelpMessage): Promise<void> {
		const sectionId = String(message.sectionId || '').trim();
		const sectionName = String(message.sectionName || '').trim();
		const sectionLabel = sectionName || sectionId || 'this HTML section';
		const fixAction = 'Fix it using Kusto Workbench';
		const selection = await vscode.window.showWarningMessage(
			`Power BI publish needs query-backed data bindings for ${sectionLabel}. Ask Kusto Workbench to add or fix the provenance block, connect it to query results, and then try publishing again.`,
			fixAction,
		);
		if (selection !== fixAction || !sectionId) return;
		await this.requestHtmlDashboardUpgradeWithCopilot({
			type: 'requestHtmlDashboardUpgradeWithCopilot',
			sectionId,
			sectionName: sectionName || undefined,
			targetVersion: Number.isFinite(message.targetVersion) ? Number(message.targetVersion) : 1,
			reasons: Array.isArray(message.reasons) ? message.reasons : undefined,
		});
	}

	private async showPowerBiPartialPublishWarning(message: ShowPowerBiPartialPublishWarningMessage): Promise<void> {
		const requestId = String(message.requestId || '').trim();
		const sectionId = String(message.sectionId || '').trim();
		const sectionName = String(message.sectionName || '').trim();
		const sectionLabel = sectionName || sectionId || 'this HTML section';
		const targetVersion = Number.isFinite(message.targetVersion) ? Number(message.targetVersion) : 1;
		const reasons = Array.isArray(message.reasons) ? message.reasons : undefined;
		const publishAnywayAction = 'Publish anyway';
		const fixAction = 'Fix with Kusto Workbench';
		const selection = await vscode.window.showWarningMessage(
			`Power BI can publish ${sectionLabel}, but Kusto Workbench found visuals or interactions that Power BI export cannot fully reproduce. Publish anyway to continue with the exportable parts, or ask Kusto Workbench to make the section 100% compatible with Power BI exporting first.`,
			publishAnywayAction,
			fixAction,
		);

		const postResult = (action: 'publishAnyway' | 'fixWithKustoWorkbench' | 'dismissed'): void => {
			if (!sectionId || !requestId) return;
			this.postMessage({
				type: 'powerBiPartialPublishWarningResult',
				boxId: sectionId,
				requestId,
				action,
			});
		};

		if (selection === publishAnywayAction) {
			postResult('publishAnyway');
			return;
		}

		if (selection === fixAction) {
			postResult('fixWithKustoWorkbench');
			if (!sectionId) return;
			await this.requestHtmlDashboardUpgradeWithCopilot({
				type: 'requestHtmlDashboardUpgradeWithCopilot',
				sectionId,
				sectionName: sectionName || undefined,
				targetVersion,
				reasons,
			});
			return;
		}

		postResult('dismissed');
	}

	private async showPowerBiUnsupportedVisualHelp(message: ShowPowerBiUnsupportedVisualHelpMessage): Promise<void> {
		const openIssuesAction = 'Ask for it';
		const text = String(message.message || '').trim() || 'Power BI export does not support this chart type yet.';
		const selection = await vscode.window.showInformationMessage(text, openIssuesAction);
		if (selection === openIssuesAction) {
			await vscode.env.openExternal(vscode.Uri.parse(GITHUB_ISSUES_URL));
		}
	}

	private async requestHtmlDashboardUpgradeWithCopilot(message: RequestHtmlDashboardUpgradeWithCopilotMessage): Promise<void> {
		const sectionId = String(message.sectionId || '').trim();
		if (!sectionId) return;
		const prompt = this.buildHtmlDashboardUpgradePrompt(message);
		const opened = await openKustoWorkbenchAgentChat({ query: prompt, submit: true });
		if (!opened) {
			void vscode.window.showWarningMessage('Kusto Workbench could not start the Power BI upgrade chat automatically. Open the Kusto Workbench agent and ask it to make this HTML section exportable to Power BI.');
		}
	}

	private buildHtmlDashboardUpgradePrompt(message: RequestHtmlDashboardUpgradeWithCopilotMessage): string {
		const sectionId = String(message.sectionId || '').trim();
		const sectionName = String(message.sectionName || '').trim();
		const targetVersion = Number.isFinite(message.targetVersion) ? message.targetVersion : 1;
		const reasons = Array.isArray(message.reasons)
			? message.reasons.map(reason => String(reason || '').trim()).filter(reason => reason.length > 0)
			: [];
		const sectionLabel = sectionName ? `${sectionName} (${sectionId})` : sectionId;
		const reasonText = reasons.length > 0
			? reasons.map(reason => `- ${reason}`).join('\n')
			: '- The section is behind the current Power BI export contract.';

		return [
			`Upgrade HTML section ${sectionLabel} to the latest Kusto Workbench HTML dashboard Power BI export contract (version ${targetVersion}).`,
			'',
			'Make the dashboard 100% compatible with Power BI exporting before publishing.',
			'Preserve the dashboard look, layout, interactivity, and data semantics unless the Power BI export contract requires a change.',
			'Use provenance bindings and KustoWorkbench.renderChart, KustoWorkbench.renderTable, or KustoWorkbench.renderRepeatedTable where appropriate so the dashboard exports cleanly to Power BI.',
			'Do not make unrelated notebook changes.',
			'',
			'Issues detected:',
			reasonText,
			'',
			'After updating the section, validate the dashboard and fix any remaining export issues.'
		].join('\n');
	}

	private async exportDashboardFromWebview(message: ExportDashboardMessage): Promise<void> {
		try {
			const htmlContent = String(message.html || '');
			if (!htmlContent.trim()) {
				vscode.window.showInformationMessage('No HTML content to export.');
				return;
			}

			const baseName = String(message.suggestedFileName || '').trim() || 'dashboard';
			const fileName = baseName.toLowerCase().endsWith('.html') || baseName.toLowerCase().endsWith('.htm')
				? baseName
				: baseName + '.html';
			const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
			const defaultUri = vscode.Uri.joinPath(baseDir, fileName);

			const picked = await vscode.window.showSaveDialog({
				defaultUri,
				filters: {
					'HTML Files': ['html', 'htm'],
					'Power BI Project': ['pbip'],
				},
			});

			if (!picked) return;

			const lower = picked.fsPath.toLowerCase();

			if (lower.endsWith('.pbip')) {
				// ── Power BI export path ───────────────────────────────────
				if (!message.dataSources || message.dataSources.length === 0) {
					vscode.window.showWarningMessage('No data bindings found. Add a provenance block with data source references before exporting to Power BI.');
					return;
				}

				const unsupportedBindings = findUnsupportedPowerBiBindings(htmlContent);
				if (unsupportedBindings.length > 0) {
					vscode.window.showWarningMessage(`Power BI export supports scalar, table, repeatedTable, pivot, bar, pie, and line bindings. Unsupported bindings: ${unsupportedBindings.join(', ')}.`);
					return;
				}

				const projectName = path.basename(picked.fsPath).replace(/\.pbip$/i, '');
				const folderUri = vscode.Uri.file(path.dirname(picked.fsPath));
				const sectionName = message.dataSources[0]?.name || 'KustoHtmlDashboard';

				await exportHtmlToPowerBI(
					{ htmlCode: htmlContent, sectionName, projectName, dataSources: message.dataSources, dataMode: 'import', previewHeight: message.previewHeight },
					folderUri,
				);

				const action = await vscode.window.showInformationMessage(
					`Power BI project exported to ${folderUri.fsPath}. Open the .pbip file in Power BI Desktop.`,
					'Open Folder',
					'Upload to Power BI',
				);
				if (action === 'Open Folder') {
					await vscode.commands.executeCommand('revealFileInOS', folderUri);
				} else if (action === 'Upload to Power BI') {
					this.postMessage({
						type: 'openPublishPbiDialog',
						boxId: message.boxId,
						htmlCode: htmlContent,
						dataSources: message.dataSources,
						previewHeight: message.previewHeight,
						suggestedName: projectName,
					});
				}
			} else {
				// ── HTML export path ───────────────────────────────────────
				let targetUri = picked;
				if (!lower.endsWith('.html') && !lower.endsWith('.htm')) {
					targetUri = vscode.Uri.file(picked.fsPath + '.html');
				}

				await vscode.workspace.fs.writeFile(targetUri, Buffer.from(htmlContent, 'utf8'));
				vscode.window.showInformationMessage(`Saved HTML to ${targetUri.fsPath}`);
			}
		} catch (e) {
			this.output.error('[kusto] Dashboard export error:', e instanceof Error ? e : String(e));
			vscode.window.showErrorMessage('Failed to export dashboard: ' + (e instanceof Error ? e.message : String(e)));
		}
	}

	private async getPbiWorkspacesFromWebview(message: { boxId: string }): Promise<void> {
		try {
			const workspaces = await listFabricWorkspaces();
			this.postMessage({ type: 'pbiWorkspacesResult', boxId: message.boxId, ok: true, workspaces });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.output.error('[kusto] Power BI workspaces error:', e instanceof Error ? e : String(e));
			this.postMessage({ type: 'pbiWorkspacesResult', boxId: message.boxId, ok: false, error: msg });
		}
	}

	private async publishToPowerBIFromWebview(message: PublishToPowerBIMessage): Promise<void> {
		try {
			const unsupportedBindings = findUnsupportedPowerBiBindings(message.htmlCode);
			if (unsupportedBindings.length > 0) {
				const msg = `Power BI publish supports scalar, table, repeatedTable, pivot, bar, pie, and line bindings. Unsupported bindings: ${unsupportedBindings.join(', ')}.`;
				vscode.window.showWarningMessage(msg);
				this.postMessage({ type: 'publishToPowerBIResult', boxId: message.boxId, ok: false, error: msg });
				return;
			}

			const hasExistingIds = !!(message.semanticModelId && message.reportId);
			const dataMode: PowerBiDataMode = normalizePowerBiDataMode(message.dataMode, hasExistingIds ? 'directQuery' : 'import');
			if (dataMode === 'import' && message.dataSources.some(ds => this.connectionManager.isLeaveNoTrace(ds.clusterUrl))) {
				const msg = 'Import mode cannot be used with Leave No Trace clusters because it stores query results in Power BI. Select DirectQuery to keep data in Kusto.';
				vscode.window.showWarningMessage(msg);
				this.postMessage({ type: 'publishToPowerBIResult', boxId: message.boxId, ok: false, error: msg });
				return;
			}

			const result = await publishToPowerBIService({
				workspaceId: message.workspaceId,
				reportName: message.reportName,
				pageWidth: message.pageWidth,
				pageHeight: message.pageHeight,
				htmlCode: message.htmlCode,
				dataSources: message.dataSources,
				dataMode,
				semanticModelId: message.semanticModelId,
				reportId: message.reportId,
				existingReportName: message.existingReportName,
				isPersonalWorkspace: message.isPersonalWorkspace,
			});
			this.postMessage({ type: 'publishToPowerBIResult', boxId: message.boxId, ok: true,
				reportUrl: result.reportUrl, scheduleConfigured: result.scheduleConfigured,
				initialRefreshTriggered: result.initialRefreshTriggered, dataMode: result.dataMode,
				semanticModelId: result.semanticModelId, reportId: result.reportId,
				workspaceId: message.workspaceId, reportName: message.reportName,
				workspaceName: message.workspaceName });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.output.error('[kusto] Power BI publish error:', e instanceof Error ? e : String(e));
			this.postMessage({ type: 'publishToPowerBIResult', boxId: message.boxId, ok: false, error: msg });
		}
	}

	private async checkPbiItemExistsFromWebview(message: { boxId: string; workspaceId: string; reportId: string }): Promise<void> {
		try {
			const exists = await checkFabricItemExists(message.workspaceId, message.reportId);
			this.postMessage({ type: 'pbiItemExistsResult', boxId: message.boxId, exists });
		} catch (e) {
			this.output.warn('[kusto] PBI item existence check failed:', e);
			this.postMessage({ type: 'pbiItemExistsResult', boxId: message.boxId, exists: false });
		}
	}

	private async saveResultsCsvFromWebview(message: SaveResultsCsvMessage): Promise<void> {
		try {
			const csv = String(message.csv || '');
			if (!csv.trim()) {
				vscode.window.showInformationMessage('No results to save.');
				return;
			}

			const suggestedFileName = String(message.suggestedFileName || 'kusto-results.csv') || 'kusto-results.csv';
			const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
			const defaultUri = vscode.Uri.joinPath(baseDir, suggestedFileName);

			const picked = await vscode.window.showSaveDialog({
				defaultUri,
				filters: { CSV: ['csv'] }
			});

			if (!picked) {
				return;
			}

			let targetUri = picked;
			try { targetUri = withCsvExtension(picked); } catch { /* ignore */ }

			await vscode.workspace.fs.writeFile(targetUri, Buffer.from(csv, 'utf8'));
			await notifySavedFile(targetUri, `Saved results to ${targetUri.fsPath}`);
		} catch {
			vscode.window.showErrorMessage('Failed to save results to CSV file.');
		}
	}

	private decodeHtmlEntities(text: string): string {
		try {
			return String(text || '')
				.replace(/&nbsp;/gi, ' ')
				.replace(/&lt;/gi, '<')
				.replace(/&gt;/gi, '>')
				.replace(/&amp;/gi, '&')
				.replace(/&quot;/gi, '"')
				.replace(/&#39;/gi, "'")
				.replace(/&#x27;/gi, "'");
		} catch {
			return String(text || '');
		}
	}

	private extractControlCommandSyntaxFromLearnHtml(html: string): string {
		try {
			const s = String(html || '');
			if (!s.trim()) return '';

			// Prefer a Syntax section.
			let preBlock = '';
			try {
				const m = s.match(/<h2[^>]*>\s*Syntax\s*<\/h2>[\s\S]*?<pre[^>]*>([\s\S]*?)<\/pre>/i);
				if (m?.[1]) preBlock = String(m[1]);
			} catch {
				preBlock = '';
			}

			// Fallback: first code block on the page.
			if (!preBlock) {
				try {
					const m = s.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
					if (m?.[1]) preBlock = String(m[1]);
				} catch {
					preBlock = '';
				}
			}

			if (!preBlock) return '';
			const withoutTags = preBlock
				.replace(/<code[^>]*>/gi, '')
				.replace(/<\/code>/gi, '')
				.replace(/<[^>]+>/g, '');
			const decoded = this.decodeHtmlEntities(withoutTags);
			const normalized = decoded.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
			const lines = normalized.split('\n');
			while (lines.length && !String(lines[0] || '').trim()) lines.shift();
			while (lines.length && !String(lines[lines.length - 1] || '').trim()) lines.pop();
			return lines.join('\n').trim();
		} catch {
			return '';
		}
	}

	async ensureComparisonBoxInWebview(
		sourceBoxId: string,
		comparisonQuery: string,
		token: vscode.CancellationToken,
		copilotSequence?: number,
	): Promise<string> {
		if (!this.panel) {
			throw new Error('Webview panel is not available');
		}
		const requestId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
		const sqlConnectionId = this._sqlConnectionIdByBoxId.get(sourceBoxId);
		if (sqlConnectionId) await this.sqlWorkbench.assertSqlConnectionAllowed(sqlConnectionId);
		return await new Promise<string>((resolve, reject) => {
			if (token.isCancellationRequested) {
				reject(new Error('Canceled'));
				return;
			}

			let pending!: PendingComparisonEnsure;
			const timer = setTimeout(() => {
				this.settlePendingComparisonEnsure(requestId, pending, { error: new Error('Timed out while preparing comparison editor') });
			}, 20000);

			pending = {
				resolve,
				reject,
				timer,
				sourceBoxId,
				...(sqlConnectionId ? { sqlConnectionId } : {}),
				...(copilotSequence !== undefined ? { copilotSequence } : {}),
			};
			this.pendingComparisonEnsureByRequestId.set(requestId, pending);

			try {
				this.postMessage({
					type: 'ensureComparisonBox',
					requestId,
					boxId: sourceBoxId,
					query: comparisonQuery
				});
			} catch (e) {
				try {
					clearTimeout(timer);
				} catch {
					// ignore
				}
				this.pendingComparisonEnsureByRequestId.delete(requestId);
				try { pending.cancellationDisposable?.dispose(); } catch { /* ignore */ }
				reject(e instanceof Error ? e : new Error(String(e)));
				return;
			}

			try {
				pending.cancellationDisposable = token.onCancellationRequested(() => {
					const pending = this.pendingComparisonEnsureByRequestId.get(requestId);
					if (!pending) {
						return;
					}
					this.settlePendingComparisonEnsure(requestId, pending, { error: new Error('Canceled') });
				});
			} catch {
				// ignore
			}
		});
	}

	async waitForComparisonSummary(
		sourceBoxId: string,
		comparisonBoxId: string,
		token: vscode.CancellationToken
	): Promise<{ dataMatches: boolean; headersMatch: boolean }> {
		const key = `${sourceBoxId}::${comparisonBoxId}`;
		const existing = this.latestComparisonSummaryByKey.get(key);
		if (existing) {
			return { dataMatches: existing.dataMatches, headersMatch: existing.headersMatch };
		}

		return await new Promise<{ dataMatches: boolean; headersMatch: boolean }>((resolve, reject) => {
			if (token.isCancellationRequested) {
				reject(new Error('Canceled'));
				return;
			}

			const timer = setTimeout(() => {
				try {
					const pending = this.pendingComparisonSummaryByKey.get(key) || [];
					this.pendingComparisonSummaryByKey.set(
						key,
						pending.filter((p) => p.reject !== reject)
					);
					if ((this.pendingComparisonSummaryByKey.get(key) || []).length === 0) {
						this.pendingComparisonSummaryByKey.delete(key);
					}
				} catch {
					// ignore
				}
				reject(new Error('Timed out while waiting for comparison summary'));
			}, 20000);

			const entry = { resolve, reject, timer };
			const pending = this.pendingComparisonSummaryByKey.get(key) || [];
			pending.push(entry);
			this.pendingComparisonSummaryByKey.set(key, pending);

			try {
				token.onCancellationRequested(() => {
					try {
						clearTimeout(timer);
					} catch {
						// ignore
					}
					reject(new Error('Canceled'));
				});
			} catch {
				// ignore
			}
		});
	}

	private extractWithArgsFromSyntax(syntax: string): string[] {
		try {
			const s = String(syntax || '');
			if (!s) return [];
			const m = s.match(/\bwith\s*\(([\s\S]*?)\)/i);
			if (!m?.[1]) return [];
			const inside = String(m[1]);
			const out: string[] = [];
			const seen = new Set<string>();
			for (const mm of inside.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
				const name = String(mm[1] || '').trim();
				if (!name) continue;
				const lower = name.toLowerCase();
				if (seen.has(lower)) continue;
				seen.add(lower);
				out.push(name);
			}
			return out;
		} catch {
			return [];
		}
	}

	private async handleFetchControlCommandSyntax(message: { requestId: string; commandLower: string; href: string }): Promise<void> {
		const requestId = String(message.requestId || '');
		const commandLower = String(message.commandLower || '').toLowerCase();
		const href = String(message.href || '');
		if (!requestId || !commandLower || !href) {
			this.postMessage({ type: 'controlCommandSyntaxResult', requestId, commandLower, ok: false, syntax: '', withArgs: [] });
			return;
		}

		try {
			const now = Date.now();
			const cached = this.controlCommandSyntaxCache.get(commandLower);
			if (cached && (now - cached.timestamp) < this.CONTROL_COMMAND_SYNTAX_CACHE_TTL_MS) {
				this.postMessage({ type: 'controlCommandSyntaxResult', requestId, commandLower, ok: true, syntax: cached.syntax, withArgs: cached.withArgs });
				return;
			}

			const url = new URL(href, 'https://learn.microsoft.com/en-us/kusto/');
			url.searchParams.set('view', 'azure-data-explorer');
			const res = await fetch(url.toString(), { method: 'GET' });
			if (!res.ok) throw new Error(`Failed to fetch control command syntax (HTTP ${res.status})`);
			const html = await res.text();
			const syntax = this.extractControlCommandSyntaxFromLearnHtml(html);
			const withArgs = this.extractWithArgsFromSyntax(syntax);
			this.controlCommandSyntaxCache.set(commandLower, { timestamp: Date.now(), syntax, withArgs });
			this.postMessage({ type: 'controlCommandSyntaxResult', requestId, commandLower, ok: true, syntax, withArgs });
		} catch (err) {
			this.controlCommandSyntaxCache.set(commandLower, { timestamp: Date.now(), syntax: '', withArgs: [], error: this.getErrorMessage(err) });
			this.postMessage({ type: 'controlCommandSyntaxResult', requestId, commandLower, ok: false, syntax: '', withArgs: [] });
		}
	}


	/**
	 * Opens tool result content in a new VS Code editor tab.
	 */
	private async openToolResultInEditor(
		message: Extract<IncomingWebviewMessage, { type: 'openToolResultInEditor' }>
	): Promise<void> {
		try {
			const tool = String(message.tool || 'tool_result').trim();
			const content = String(message.content || '');

			// Create an untitled document with the content
			const doc = await vscode.workspace.openTextDocument({
				content,
				language: 'plaintext'
			});

			await vscode.window.showTextDocument(doc, {
				preview: true,
				viewColumn: vscode.ViewColumn.Beside
			});
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to open tool result: ${this.getErrorMessage(error)}`);
		}
	}

	/**
	 * Opens a markdown file in VS Code's built-in markdown preview.
	 */
	private async openMarkdownPreview(filePath: string): Promise<void> {
		try {
			const uri = vscode.Uri.file(filePath);
			await vscode.commands.executeCommand('markdown.showPreview', uri);
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to open markdown preview: ${this.getErrorMessage(error)}`);
		}
	}



	private async resolveResourceUri(message: Extract<IncomingWebviewMessage, { type: 'resolveResourceUri' }>): Promise<void> {
		const requestId = String(message.requestId || '');
		const rawPath = String(message.path || '');
		const rawBase = typeof message.baseUri === 'string' ? String(message.baseUri || '') : '';

		const reply = (payload: { ok: boolean; uri?: string; error?: string }) => {
			try {
				this.postMessage({ type: 'resolveResourceUriResult', requestId, ...payload });
			} catch {
				// ignore
			}
		};

		if (!requestId) {
			return;
		}
		if (!rawPath.trim()) {
			reply({ ok: false, error: 'Empty path.' });
			return;
		}

		// Do not rewrite/serve remote URLs. ToastUI can load those directly (subject to CSP).
		const lower = rawPath.trim().toLowerCase();
		if (
			lower.startsWith('http://') ||
			lower.startsWith('https://') ||
			lower.startsWith('data:') ||
			lower.startsWith('blob:') ||
			lower.startsWith('vscode-webview://') ||
			lower.startsWith('vscode-resource:')
		) {
			reply({ ok: true, uri: rawPath.trim() });
			return;
		}

		// We only support resolving file-based documents for now.
		let baseUri: vscode.Uri | null = null;
		try {
			if (rawBase) {
				baseUri = vscode.Uri.parse(rawBase);
			}
		} catch {
			baseUri = null;
		}
		if (!baseUri || baseUri.scheme !== 'file') {
			reply({ ok: false, error: 'Missing or unsupported baseUri. Only local files are supported.' });
			return;
		}

		let targetUri: vscode.Uri;
		try {
			// Normalize markdown-style paths (always forward slashes).
			const normalized = rawPath.replace(/\\/g, '/');

			// Markdown sometimes uses leading-slash paths to mean "workspace root".
			// On Windows, path.isAbsolute('/foo') is true but it is not a meaningful local path.
			if (normalized.startsWith('/')) {
				const wf = vscode.workspace.getWorkspaceFolder(baseUri);
				const rel = normalized.replace(/^\/+/, '');
				if (wf && rel) {
					targetUri = vscode.Uri.joinPath(wf.uri, ...rel.split('/'));
				} else {
					const baseDir = path.dirname(baseUri.fsPath);
					const resolvedFsPath = path.resolve(baseDir, rel);
					targetUri = vscode.Uri.file(resolvedFsPath);
				}
			} else {
				const isWindowsAbsolute = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//');
				const isPosixAbsolute = !isWindowsAbsolute && path.posix.isAbsolute(normalized);
				if (isWindowsAbsolute || (isPosixAbsolute && process.platform !== 'win32')) {
					targetUri = vscode.Uri.file(normalized);
				} else {
					const baseDir = path.dirname(baseUri.fsPath);
					const resolvedFsPath = path.resolve(baseDir, normalized);
					targetUri = vscode.Uri.file(resolvedFsPath);
				}
			}
		} catch (e) {
			reply({ ok: false, error: `Failed to resolve path: ${this.getErrorMessage(e)}` });
			return;
		}

		const cacheKey = `${baseUri.toString()}::${rawPath}`;
		const cached = this.resolvedResourceUriCache.get(cacheKey);
		if (cached) {
			reply({ ok: true, uri: cached });
			return;
		}

		try {
			await vscode.workspace.fs.stat(targetUri);
		} catch {
			reply({ ok: false, error: 'File not found.' });
			return;
		}

		if (!this.panel) {
			reply({ ok: false, error: 'Webview panel is not available.' });
			return;
		}

		try {
			const webviewUri = this.panel.webview.asWebviewUri(targetUri).toString();
			this.resolvedResourceUriCache.set(cacheKey, webviewUri);
			reply({ ok: true, uri: webviewUri });
		} catch (e) {
			reply({ ok: false, error: `Failed to create webview URI: ${this.getErrorMessage(e)}` });
		}
	}

	private async handleKqlLanguageRequest(
		message: Extract<IncomingWebviewMessage, { type: 'kqlLanguageRequest' }>
	): Promise<void> {
		const requestId = String(message.requestId || '').trim();
		if (!requestId) {
			return;
		}
		try {
			const params = message.params && typeof message.params === 'object' ? message.params : { text: '' };
			switch (message.method) {
				case 'textDocument/diagnostic': {
					const result = await this.kqlLanguageHost.getDiagnostics(params);
					this.postMessage({ type: 'kqlLanguageResponse', requestId, ok: true, result });
					return;
				}
				case 'kusto/findTableReferences': {
					const result = await this.kqlLanguageHost.findTableReferences(params);
					this.postMessage({ type: 'kqlLanguageResponse', requestId, ok: true, result });
					return;
				}
				default:
					this.postMessage({
						type: 'kqlLanguageResponse',
						requestId,
						ok: false,
						error: { message: 'Unsupported method.' }
					});
					return;
			}
		} catch (error) {
			const raw = this.getErrorMessage(error);
			this.output.error(`[kql-ls] request failed: ${raw}`);
			this.postMessage({
				type: 'kqlLanguageResponse',
				requestId,
				ok: false,
				error: { message: 'KQL language service failed to process the request.' }
			});
		}
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

	private async postSqlOwnerMessageAllowed(
		boxId: string,
		expectedOwner: SqlResultOwner,
		message: Record<string, unknown>,
		isCurrent: () => boolean = () => true,
	): Promise<boolean> {
		return this.dispatchSqlResultOwnerAllowed(boxId, expectedOwner, async () => {
			if (!isCurrent()) return false;
			return await this.postMessage(message) === true;
		});
	}

	private async postSqlConnectionMessageAllowed(
		connection: import('./sqlConnectionManager').SqlConnection,
		message: Record<string, unknown>,
		isCurrent: () => boolean = () => true,
	): Promise<boolean> {
		const principalFingerprint = await readCurrentSqlSchemaPrincipalFingerprint(this.context, connection);
		if (!principalFingerprint) throw new Error('SQL principal is unavailable before canonical dispatch admission.');
		return this.sqlWorkbench.dispatchSqlOwnerAllowed(
			connection,
			principalFingerprint,
			this.sqlWorkbench.leaveNoTracePolicy.getRevocationGeneration(connection.id),
			async () => {
				if (!isCurrent()) return false;
				return await this.postMessage(message) === true;
			},
		);
	}

	private async updateEditingPreference(
		key: typeof STORAGE_KEYS.caretDocsEnabled | typeof STORAGE_KEYS.autoTriggerAutocompleteEnabled | typeof STORAGE_KEYS.copilotInlineCompletionsEnabled,
		enabled: boolean,
	): Promise<void> {
		const preferences = await setEditingPreference(this.context, key, enabled);
		if (toolOrchestrator) {
			await toolOrchestrator.postToAllWebviews(preferences);
		} else {
			await this.postMessage(preferences);
		}
	}

	public async inferClusterDatabaseForKqlQuery(
		queryText: string
	): Promise<{ clusterUrl: string; database: string; authorityId?: string; connectionIdHint: string } | undefined> {
		return this.connection.inferClusterDatabaseForKqlQuery(queryText);
	}

	private async sendConnectionsData(): Promise<void> {
		const revision = ++this.connectionsDataRevision;
		const send = async () => {
			const { type: _type, revision: editingPreferencesRevision, ...editingPreferences } = getEditingPreferencesData(this.context);
			await this.connection.sendConnectionsData({
				...editingPreferences,
				editingPreferencesRevision,
				connectionsRevision: revision,
				copilotChatFirstTimeDismissed: !!this.context.globalState.get<boolean>(STORAGE_KEYS.copilotChatFirstTimeDismissed)
			});
		};
		this.connectionsDataTail = this.connectionsDataTail.then(send, send);
		await this.connectionsDataTail;
	}

	cancelRunningQuery(boxId: string, options?: { notifyWebview?: boolean }): Thenable<boolean> | undefined {
		const id = String(boxId || '').trim();
		if (!id) {
			return;
		}
		const ownerToken = this._sqlOwnerTokenByBoxId?.get(id)?.token;
		const running = this.queryRuns.get(id);
		if (!running) {
			return;
		}
		this.queryRuns.cancel(id);
		if (options?.notifyWebview) {
			return this.postMessage({
				type: 'queryCancelled', boxId: id,
				...(ownerToken ? { ownerToken } : {}),
				...(running.executionId ? { executionId: running.executionId } : {}),
			});
		}
		return undefined;
	}

	supersedeSqlRunAdmission(boxId: string, options?: { notifyWebview?: boolean }): number {
		const id = String(boxId || '').trim();
		if (!id) return 0;
		const generation = (this._sqlRunAdmissionGenerationByBoxId.get(id) ?? 0) + 1;
		this._sqlRunAdmissionGenerationByBoxId.set(id, generation);
		const retiredPending = this.retirePendingSqlRunAdmission(id, options?.notifyWebview === true);
		this.cancelRunningQuery(id, retiredPending ? { notifyWebview: false } : options);
		return generation;
	}

	private retirePendingSqlRunAdmission(boxId: string, notifyWebview: boolean): boolean {
		const pending = this._pendingSqlRunAdmissionByBoxId.get(boxId);
		if (!pending) return false;
		this._pendingSqlRunAdmissionByBoxId.delete(boxId);
		if (notifyWebview) {
			this.postMessage({
				type: 'queryCancelled', boxId,
				...(pending.ownerToken ? { ownerToken: pending.ownerToken } : {}),
				executionId: pending.executionId,
			});
		}
		return true;
	}

	startSqlRunUnderAdmission<T extends { cancel: () => void; promise?: PromiseLike<unknown> }>(
		boxId: string,
		expectedGeneration: number,
		start: () => T,
		executionId?: string,
	): { execution: T; runSeq: number } {
		const id = String(boxId || '').trim();
		if (!id || this._sqlRunAdmissionGenerationByBoxId.get(id) !== expectedGeneration) {
			throw new Error('SQL Copilot write-query canceled');
		}
		const execution = start();
		if (this._sqlRunAdmissionGenerationByBoxId.get(id) !== expectedGeneration) {
			if (execution.promise) void Promise.resolve(execution.promise).catch(() => undefined);
			try { execution.cancel(); } catch { /* ignore */ }
			throw new Error('SQL Copilot write-query canceled');
		}
		const runSeq = this.queryRuns.nextSequence();
		this.queryRuns.register(id, { cancel: execution.cancel, runSeq, ...(executionId ? { executionId } : {}) });
		return { execution, runSeq };
	}

	isSqlRunAdmissionCurrent(boxId: string, expectedGeneration: number, cancel: () => void, runSeq: number): boolean {
		const id = String(boxId || '').trim();
		return !!id
			&& this._sqlRunAdmissionGenerationByBoxId.get(id) === expectedGeneration
			&& this.queryRuns.isCurrent(id, cancel, runSeq);
	}

	reserveRunningQueryReplacement(boxId: string, executionId: string): {
		cancel: () => void;
		runSeq: number;
		previousCancellationDelivery: Promise<boolean>;
	} {
		const id = String(boxId || '').trim();
		const reservationCancel = () => { /* coordinator reservation */ };
		const runSeq = this.queryRuns.nextSequence();
		const previous = this.queryRuns.replaceAndCancel(id, {
			cancel: reservationCancel,
			runSeq,
			executionId,
		});
		const previousCancellationDelivery = previous?.executionId
			? Promise.resolve(this.postMessage({
				type: 'queryCancelled', boxId: id, executionId: previous.executionId,
			})).then(delivered => delivered === true, () => false)
			: Promise.resolve(true);
		return { cancel: reservationCancel, runSeq, previousCancellationDelivery };
	}

	promoteRunningQueryReservation(
		boxId: string,
		reservationCancel: () => void,
		runSeq: number,
		cancel: () => void,
		clientActivityId: string | undefined,
		executionId: string,
	): boolean {
		return this.queryRuns.replaceIfCurrent(boxId, reservationCancel, runSeq, {
			cancel,
			runSeq,
			clientActivityId,
			executionId,
		});
	}

	registerRunningQuery(boxId: string, cancel: () => void, runSeq: number, clientActivityId?: string, executionId?: string): void {
		this.queryRuns.register(boxId, { cancel, runSeq, clientActivityId, ...(executionId ? { executionId } : {}) });
	}

	unregisterRunningQuery(boxId: string, cancel: () => void, runSeq: number): void {
		const id = String(boxId || '').trim();
		if (!id) {
			return;
		}
		this.queryRuns.unregister(id, cancel, runSeq);
	}

	nextQueryRunSeq(): number {
		return this.queryRuns.nextSequence();
	}

	isRunningQueryCurrent(boxId: string, cancel: () => void, runSeq: number): boolean {
		const id = String(boxId || '').trim();
		return !!id && this.queryRuns.isCurrent(id, cancel, runSeq);
	}

	deleteComparisonSummary(key: string): void {
		this.latestComparisonSummaryByKey.delete(key);
	}

	revealPanel(): void {
		this.panel?.reveal(vscode.ViewColumn.One);
	}


	private cancelAllRunningQueries(): void {
		this.queryRuns.cancelAll();
	}

	private async executePythonFromWebview(
		message: Extract<IncomingWebviewMessage, { type: 'executePython' }>
	): Promise<void> {
		const boxId = String(message.boxId || '').trim();
		const code = String(message.code || '');
		if (!boxId) {
			return;
		}

		const timeoutMs = 15000;
		const maxBytes = 200 * 1024;
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;

		const runOnce = (cmd: string, args: string[]) => {
			return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
				let stdout = '';
				let stderr = '';
				let done = false;
				let killedByTimeout = false;
				const child = spawn(cmd, args, {
					cwd,
					shell: false,
					stdio: ['pipe', 'pipe', 'pipe']
				});

				const timer = setTimeout(() => {
					killedByTimeout = true;
					try {
						child.kill();
					} catch {
						// ignore
					}
				}, timeoutMs);

				const append = (current: string, chunk: Buffer) => {
					if (current.length >= maxBytes) {
						return current;
					}
					const toAdd = chunk.toString('utf8');
					const next = current + toAdd;
					return next.length > maxBytes ? next.slice(0, maxBytes) : next;
				};

				child.stdout?.on('data', (d: Buffer) => {
					stdout = append(stdout, d);
				});
				child.stderr?.on('data', (d: Buffer) => {
					stderr = append(stderr, d);
				});
				child.on('error', (err) => {
					if (done) {
						return;
					}
					done = true;
					clearTimeout(timer);
					reject(err);
				});
				child.on('close', (exitCode) => {
					if (done) {
						return;
					}
					done = true;
					clearTimeout(timer);
					if (killedByTimeout) {
						stderr = (stderr ? stderr + '\n' : '') + `Timed out after ${Math.round(timeoutMs / 1000)}s.`;
					}
					resolve({ stdout, stderr, exitCode: typeof exitCode === 'number' ? exitCode : -1 });
				});

				try {
					child.stdin?.write(code);
					child.stdin?.end();
				} catch {
					// ignore
				}
			});
		};

		const candidates: Array<{ cmd: string; args: string[] }> = [
			{ cmd: 'python', args: ['-'] },
			{ cmd: 'python3', args: ['-'] },
			{ cmd: 'py', args: ['-'] }
		];

		let lastError: unknown = undefined;
		for (const c of candidates) {
			try {
				const result = await runOnce(c.cmd, c.args);
				this.postMessage({ type: 'pythonResult', boxId, ...result });
				return;
			} catch (e: any) {
				lastError = e;
				// Command not found: try the next candidate.
				if (e && (e.code === 'ENOENT' || String(e.message || '').includes('ENOENT'))) {
					continue;
				}
				// Other errors: stop early.
				break;
			}
		}

		const errMsg = lastError && typeof (lastError as any).message === 'string'
			? (lastError as any).message
			: 'Python execution failed (python not found?).';
		this.postMessage({ type: 'pythonError', boxId, error: errMsg });
	}

	private async fetchUrlFromWebview(message: Extract<IncomingWebviewMessage, { type: 'fetchUrl' }>): Promise<void> {
		const boxId = String(message.boxId || '').trim();
		const rawUrl = String(message.url || '').trim();
		if (!boxId) {
			return;
		}

		const formatBytes = (n: number): string => {
			if (!Number.isFinite(n) || n < 0) {
				return '0 B';
			}
			if (n >= 1024 * 1024) {
				return `${(n / (1024 * 1024)).toFixed(1)} MB`;
			}
			if (n >= 1024) {
				return `${Math.round(n / 1024)} KB`;
			}
			return `${n} B`;
		};

		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			this.postMessage({ type: 'urlError', boxId, error: 'Invalid URL.' });
			return;
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			this.postMessage({ type: 'urlError', boxId, error: 'Only http/https URLs are supported.' });
			return;
		}

		const timeoutMs = 15000;
		const maxChars = 200000;
		const maxBytesForTextLike = 100 * 1024 * 1024; // 100MB cap for URL/CSV content.
		const maxBytesForImages = 5 * 1024 * 1024; // Keep images smaller since they're sent to the webview as a data URI.
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), timeoutMs);
		try {
			const resp = await fetch(url.toString(), {
				redirect: 'follow',
				signal: ac.signal
			});
			const contentType = resp.headers.get('content-type') || '';
			const ctLower = contentType.toLowerCase();
			const finalUrl = resp.url || url.toString();

			const pathLower = (() => {
				try {
					return new URL(finalUrl).pathname.toLowerCase();
				} catch {
					return '';
				}
			})();

			const looksLikeCsv = ctLower.includes('text/csv') || ctLower.includes('application/csv') || pathLower.endsWith('.csv');
			const looksLikeHtml = ctLower.includes('text/html') || pathLower.endsWith('.html') || pathLower.endsWith('.htm');
			const looksLikeImage = ctLower.startsWith('image/');
			const looksLikeText = ctLower.startsWith('text/') || ctLower.includes('json') || ctLower.includes('xml') || ctLower.includes('yaml');

			const maxBytes = looksLikeImage ? maxBytesForImages : maxBytesForTextLike;

			// Read as bytes so we can support images and other non-text content.
			const ab = await resp.arrayBuffer();
			const bytes = Buffer.from(ab);
			if (bytes.byteLength > maxBytes) {
				this.postMessage({
					type: 'urlError',
					boxId,
					error: `Response too large (${formatBytes(bytes.byteLength)}). Max is ${formatBytes(maxBytes)}.`
				});
				return;
			}

			if (!resp.ok) {
				const status = resp.status;
				const statusText = (resp.statusText || '').trim();
				const hint = (() => {
					if (ctLower.includes('text/html') && pathLower.endsWith('.csv')) {
						return ' The server returned HTML, not CSV. Try using a raw download link.';
					}
					return '';
				})();
				this.postMessage({
					type: 'urlError',
					boxId,
					error: `HTTP ${status}${statusText ? ' ' + statusText : ''}.${hint}`
				});
				return;
			}

			if (looksLikeImage) {
				const mime = contentType.split(';')[0].trim() || 'image/*';
				const base64 = bytes.toString('base64');
				const dataUri = `data:${mime};base64,${base64}`;
				this.postMessage({
					type: 'urlContent',
					boxId,
					url: finalUrl,
					contentType,
					status: resp.status,
					kind: 'image',
					dataUri,
					byteLength: bytes.byteLength
				});
				return;
			}

			// Decode as UTF-8 text for sniffing and rendering.
			let body = bytes.toString('utf8');
			let truncated = false;
			if (body.length > maxChars) {
				body = body.slice(0, maxChars);
				truncated = true;
			}

			const sniff = body.slice(0, 4096).trimStart().toLowerCase();
			const looksLikeHtmlByBody = sniff.startsWith('<!doctype html') || sniff.startsWith('<html') || sniff.startsWith('<head');

			const isCsvByType = ctLower.includes('text/csv') || ctLower.includes('application/csv');
			const isHtmlByType = ctLower.includes('text/html');
			const isCsvByExt = pathLower.endsWith('.csv') && !isHtmlByType && !looksLikeHtmlByBody;
			const kind = (isCsvByType || isCsvByExt)
				? 'csv'
				: ((looksLikeHtml || isHtmlByType || looksLikeHtmlByBody)
					? 'html'
					: (looksLikeText ? 'text' : 'text'));

			this.postMessage({
				type: 'urlContent',
				boxId,
				url: finalUrl,
				contentType,
				status: resp.status,
				kind,
				body,
				truncated,
				byteLength: bytes.byteLength
			});
		} catch (e: any) {
			const msg = e?.name === 'AbortError'
				? `Timed out after ${Math.round(timeoutMs / 1000)}s.`
				: (typeof e?.message === 'string' ? e.message : 'Failed to fetch URL.');
			this.postMessage({ type: 'urlError', boxId, error: msg });
		} finally {
			clearTimeout(timer);
		}
	}

	postMessage(message: unknown): Thenable<boolean> {
		if (this._panelDisposed) return Promise.resolve(false);
		try {
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
		panel.onDidDispose(() => {
			if (this.panel !== panel) return;
			this._panelDisposed = true;
			this.copilot.dispose();
			this.disposePendingWebviewRequests();
			this.sqlLeaveNoTraceSubscription.dispose();
			this.stsRuntimeSubscription.dispose();
			this.sqlConnectionsSubscription.dispose();
			this.sqlPrincipalsSubscription.dispose();
			this.sqlPersistenceInvalidationEmitter.dispose();
			this.fileOpenTrace?.mark('queryEditorProvider.dispose.start');
			this.disposeSqlEditorSession();
			this.clearCursorStatusForProvider();
			this.cancelAllRunningQueries();
			this.kustoClient.dispose();
			this.disconnectToolOrchestrator();
			this.connection.dispose();
			this.embeddedTutorialRegistration?.dispose();
			this.embeddedTutorialRegistration = undefined;
			this.embeddedTutorialHost = undefined;
			this.configSubscription?.dispose();
			this.configSubscription = undefined;
			this.authPreferenceSubscription?.dispose();
			this.authPreferenceSubscription = undefined;
			this.panel = undefined;
		});
	}

	private disposePendingWebviewRequests(): void {
		const error = new Error('The query editor closed before the webview request completed.');
		for (const [requestId, pending] of [...this.pendingComparisonEnsureByRequestId]) {
			this.settlePendingComparisonEnsure(requestId, pending, { error });
		}
		for (const pending of this.pendingComparisonSummaryByKey.values()) {
			for (const entry of pending) {
				try { clearTimeout(entry.timer); } catch { /* ignore */ }
				entry.reject(error);
			}
		}
		this.pendingComparisonSummaryByKey.clear();
		this.latestComparisonSummaryByKey.clear();
		for (const resolve of this.toolStateResponseResolvers.values()) resolve(undefined);
		this.toolStateResponseResolvers.clear();
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

	private async executeQueryFromWebview(
		message: Extract<IncomingWebviewMessage, { type: 'executeQuery' }>
	): Promise<void> {
		const boxId = String(message.boxId || '').trim();
		const executionId = String(message.executionId || '').trim();
		if (!boxId || !executionId) return;
		if (boxId) {
			// If the user runs again in the same box, cancel the previous run.
			this.cancelRunningQuery(boxId);
		}
		let preflightCancelled = false;
		const cancelPreflight = () => { preflightCancelled = true; };
		const runSeq = this.queryRuns.nextSequence();
		this.queryRuns.register(boxId, { cancel: cancelPreflight, runSeq, executionId });
		try {
			await this.connection.saveLastSelection(message.connectionId, message.database);
		} catch (error) {
			this.output.warn(`[query] Failed to save the last selection: ${sanitizeStsLogText(error instanceof Error ? error.message : error)}`);
		}
		if (preflightCancelled || !this.queryRuns.isCurrent(boxId, cancelPreflight, runSeq)) return;

		const connection = this.connection.findConnection(message.connectionId);
		if (!connection) {
			vscode.window.showErrorMessage('Connection not found');
			this.postMessage({ type: 'queryError', error: 'Connection not found', boxId, executionId });
			this.queryRuns.unregister(boxId, cancelPreflight, runSeq);
			return;
		}

		if (!message.database) {
			vscode.window.showErrorMessage('Please select a database');
			this.postMessage({ type: 'queryError', error: 'Please select a database', boxId, executionId });
			this.queryRuns.unregister(boxId, cancelPreflight, runSeq);
			return;
		}

		const queryWithMode = this.appendQueryMode(message.query, message.queryMode);
		// Control commands (starting with '.') should not have cache directives prepended
		const isControl = this.isControlCommand(message.query);
		const cacheDirective = isControl ? '' : this.buildCacheDirective(message.cacheEnabled, message.cacheValue, message.cacheUnit);
		const finalQuery = cacheDirective ? `${cacheDirective}\n${queryWithMode}` : queryWithMode;
		const executionQuery = this.normalizeControlCommandForExecution(finalQuery);

		const cancelClientKey = boxId ? `${boxId}::${connection.id}` : connection.id;
		let execution;
		try {
			execution = this.kustoClient.executeQueryCancelable(connection, message.database, executionQuery, cancelClientKey);
		} catch (error) {
			if (this.queryRuns.isCurrent(boxId, cancelPreflight, runSeq)) {
				this.queryRuns.unregister(boxId, cancelPreflight, runSeq);
				const userMessage = this.formatQueryExecutionErrorForUser(error, connection, message.database);
				this.postMessage({ type: 'queryError', error: userMessage, boxId, executionId });
			}
			return;
		}
		const { promise, cancel, clientActivityId } = execution;
		if (!this.queryRuns.replaceIfCurrent(boxId, cancelPreflight, runSeq, { cancel, runSeq, clientActivityId, executionId })) {
			try { cancel(); } catch { /* stale transport cleanup */ }
			return;
		}
		const isStillActiveRun = () => {
			if (!boxId) {
				return true;
			}
			return this.isRunningQueryCurrent(boxId, cancel, runSeq);
		};
		try {
			const result = await promise;
			if (isStillActiveRun()) {
				const producingAccountPartition = execution.getAccountPartition();
				await this.refreshConnectionsData();
				if (isStillActiveRun()
					&& producingAccountPartition
					&& this.kustoClient.getAccountPartition(connection) === producingAccountPartition) {
					this.postMessage({ type: 'queryResult', result, boxId, executionId });
				}
			}
		} catch (error) {
			if ((error as any)?.name === 'QueryCancelledError' || (error as any)?.isCancelled === true) {
				if (isStillActiveRun()) {
					this.postMessage({ type: 'queryCancelled', boxId, executionId });
				}
				return;
			}
			if (isStillActiveRun()) {
				this.logQueryExecutionError(error, connection, message.database, boxId, executionQuery);
				const userMessage = this.formatQueryExecutionErrorForUser(error, connection, message.database);
				const clientActivityId = error instanceof QueryExecutionError ? error.clientActivityId : undefined;
				vscode.window.showErrorMessage(userMessage);
				this.postMessage({ type: 'queryError', error: userMessage, boxId, clientActivityId, executionId });
			}
		} finally {
			if (boxId) {
				this.unregisterRunningQuery(boxId, cancel, runSeq);
			}
		}
	}

	// ── SQL connection helpers ───────────────────────────────────────────────

	private async sendSqlConnectionsData(): Promise<void> {
		const revision = (this._sqlConnectionsSnapshotRevision ?? 0) + 1;
		this._sqlConnectionsSnapshotRevision = revision;
		const capturedConnections = this.sqlConnectionManager.getConnections();
		const cacheEntries = new Map<string, Awaited<ReturnType<typeof getOwnedSqlDatabaseCacheEntry>>>();
		for (const connection of capturedConnections) {
			cacheEntries.set(connection.id, await getOwnedSqlDatabaseCacheEntry(this.context, SQL_DATABASE_CACHE_STORAGE_KEY, connection));
		}
		const lastSqlConnectionId = this.context.globalState.get<string>('sql.lastConnectionId') || '';
		const lastSqlDatabase = this.context.globalState.get<string>('sql.lastDatabase') || '';
		if (revision !== this._sqlConnectionsSnapshotRevision) return;
		await this.sqlWorkbench.dispatchSqlOwnerSnapshot(snapshot => {
			if (revision !== this._sqlConnectionsSnapshotRevision) return;
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
			return this.postMessage({
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
				sqlFavorites: this.connection.getSqlFavorites()
					.filter(favorite => !canonicalProtectedIds.has(favorite.connectionId)),
				sqlLeaveNoTrace: [...canonicalProtectedIds],
			});
		});
	}

	private adoptSqlTarget(
		boxId: string,
		connectionId: string,
		database: string | undefined,
		targetGeneration: number,
	): boolean {
		const id = String(boxId || '').trim();
		const nextConnectionId = String(connectionId || '').trim();
		const generation = Number(targetGeneration);
		if (!id || !nextConnectionId || !Number.isSafeInteger(generation) || generation < 0) return false;

		const currentGeneration = this._sqlTargetGenerationByBoxId.get(id);
		if (currentGeneration !== undefined && generation < currentGeneration) return false;
		const currentConnectionId = this._sqlConnectionIdByBoxId.get(id);
		const currentDatabase = this._sqlDatabaseByBoxId.get(id);
		const hasDatabase = database !== undefined;
		const nextDatabase = hasDatabase ? String(database || '').trim() : undefined;

		if (currentGeneration === generation) {
			if ((currentConnectionId && currentConnectionId !== nextConnectionId)
				|| (hasDatabase && currentDatabase !== undefined && currentDatabase !== nextDatabase)) return false;
			this._sqlConnectionIdByBoxId.set(id, nextConnectionId);
			if (hasDatabase) {
				if (nextDatabase) this._sqlDatabaseByBoxId.set(id, nextDatabase);
				else this._sqlDatabaseByBoxId.delete(id);
			}
			return true;
		}

		this.supersedeSqlRunAdmission(id, { notifyWebview: true });
		this._sqlTargetGenerationByBoxId.set(id, generation);
		this._sqlConnectionIdByBoxId.set(id, nextConnectionId);
		this._sqlOwnerTokenByBoxId.delete(id);
		if (hasDatabase && nextDatabase) this._sqlDatabaseByBoxId.set(id, nextDatabase);
		else this._sqlDatabaseByBoxId.delete(id);
		return true;
	}

	private async sendSqlDatabases(sqlConnectionId: string, boxId: string, forceRefresh: boolean): Promise<void> {
		const connection = this.sqlConnectionManager.getConnection(sqlConnectionId);
		const requestId = `sql-db-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		this._sqlDatabaseRequestIdByBoxId.set(boxId, requestId);
		const generation = this._sqlTargetGenerationByBoxId.get(boxId) ?? 0;
		this.postMessage({ type: 'sqlDatabasesLoading', requestId, targetGeneration: generation, boxId, sqlConnectionId });
		if (!connection) {
			this.postMessage({ type: 'sqlDatabasesError', requestId, targetGeneration: generation, boxId, sqlConnectionId, error: 'SQL connection not found.' });
			return;
		}
		const targetSignature = sqlDatabaseTargetSignature(connection);
		const startingPrincipalFingerprint = sqlSchemaPrincipalFingerprint(this.context, connection);
		let cacheRequest;
		try {
			cacheRequest = await beginSqlDatabaseCacheRequest(this.context, SQL_DATABASE_CACHE_STORAGE_KEY, connection);
		} catch {
			if (this._sqlDatabaseRequestIdByBoxId.get(boxId) === requestId) {
				this.postMessage({ type: 'sqlDatabasesError', requestId, targetGeneration: generation, boxId, sqlConnectionId, error: 'SQL connection is changing. Try again when the update completes.' });
			}
			return;
		}
		let acceptedPrincipalFingerprint = startingPrincipalFingerprint;
		const isCurrentRequestOwner = (): boolean => {
			const current = this.sqlConnectionManager.getConnection(connection.id);
			const currentPrincipalFingerprint = current ? sqlSchemaPrincipalFingerprint(this.context, current) : undefined;
			return !!current
				&& sqlDatabaseTargetSignature(current) === targetSignature
				&& (acceptedPrincipalFingerprint === undefined || currentPrincipalFingerprint === acceptedPrincipalFingerprint)
				&& this._sqlDatabaseRequestIdByBoxId.get(boxId) === requestId
				&& this._sqlConnectionIdByBoxId.get(boxId) === sqlConnectionId
				&& (this._sqlTargetGenerationByBoxId.get(boxId) ?? 0) === generation;
		};
		const assertCurrentOwner = async (requireEstablishedPrincipal = false): Promise<void> => {
			await this.sqlWorkbench.assertSqlConnectionAllowed(connection.id);
			await this.sqlConnectionManager.assertConnectionCurrent(connection);
			const current = this.sqlConnectionManager.getConnection(connection.id);
			const currentPrincipalFingerprint = current ? await readCurrentSqlSchemaPrincipalFingerprint(this.context, current) : undefined;
			if (!isCurrentRequestOwner()) {
				throw new Error('SQL database target changed while loading.');
			}
			if (acceptedPrincipalFingerprint !== undefined && currentPrincipalFingerprint !== acceptedPrincipalFingerprint) {
				throw new Error('SQL database principal changed while loading.');
			}
			if (requireEstablishedPrincipal) {
				if (!currentPrincipalFingerprint) throw new Error('SQL database identity unavailable after loading.');
				acceptedPrincipalFingerprint = currentPrincipalFingerprint;
			}
		};
		try {
			await assertCurrentOwner();
		} catch (error) {
			if (!isCurrentRequestOwner()) return;
			this.postMessage({ type: 'sqlDatabasesError', requestId, targetGeneration: generation, boxId, sqlConnectionId, error: error instanceof Error ? error.message : String(error) });
			return;
		}
		const isCurrentOwner = () => this._sqlConnectionIdByBoxId.get(boxId) === sqlConnectionId;

		const cachedBefore = (await getOwnedSqlDatabaseCacheEntry(this.context, SQL_DATABASE_CACHE_STORAGE_KEY, connection))?.databases ?? [];

		if (!forceRefresh && cachedBefore.length > 0) {
			try {
				await assertCurrentOwner();
				await this.postSqlConnectionMessageAllowed(connection, {
					type: 'sqlDatabasesData', requestId, targetGeneration: generation, databases: cachedBefore, boxId, sqlConnectionId,
				}, isCurrentRequestOwner);
			} catch {
				// A newer request or target owns this section now.
			}
			return;
		}

		try {
			const databases = await this.sqlClient.getDatabases(connection);
			const sorted = databases.slice().sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
			await assertCurrentOwner(true);
			await writeOwnedSqlDatabaseCacheEntry(
					this.context,
					SQL_DATABASE_CACHE_STORAGE_KEY,
					connection,
					acceptedPrincipalFingerprint!,
					sorted,
					cacheRequest,
					() => assertCurrentOwner(),
				);
			await assertCurrentOwner();
				await this.postSqlConnectionMessageAllowed(connection, {
					type: 'sqlDatabasesData', requestId, targetGeneration: generation, databases: sorted, boxId, sqlConnectionId,
				}, isCurrentRequestOwner);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			try {
				await assertCurrentOwner();
			} catch {
				return;
			}
			const loggedError = sanitizeStsLogText(errorMessage);
			this.output.error([
				`[${new Date().toISOString()}] Failed to load SQL databases`,
				`  error: ${this.sqlWorkbench.isLeaveNoTraceConnection(connection.id) ? 'Leave No Trace blocked SQL metadata logging.' : loggedError}`,
			].join('\n'));

			if (cachedBefore.length > 0) {
				try {
					await assertCurrentOwner();
					await this.postSqlConnectionMessageAllowed(connection, {
						type: 'sqlDatabasesData', requestId, targetGeneration: generation, databases: cachedBefore, boxId, sqlConnectionId,
					}, isCurrentRequestOwner);
				} catch { /* Leave No Trace blocks fallback metadata. */ }
				vscode.window.showWarningMessage(`Failed to refresh SQL database list. Using cached list.`);
				return;
			}

			vscode.window.showErrorMessage(`Failed to load SQL database list: ${errorMessage}`);
			if (isCurrentOwner()) this.postMessage({ type: 'sqlDatabasesError', requestId, targetGeneration: generation, boxId, sqlConnectionId, error: errorMessage });
		}
	}

	private async prefetchSqlSchema(sqlConnectionId: string, database: string, boxId: string, forceRefresh: boolean): Promise<void> {
		const connection = this.sqlConnectionManager.getConnection(sqlConnectionId);
		if (!connection || !database) {
			return;
		}
		const owner = this.getSqlResultOwner(boxId);
		if (!owner || owner.connectionId !== sqlConnectionId || owner.database !== database) return;
		try {
			this.output.info(`[sql-schema] request forceRefresh=${forceRefresh}`);
			const { schema, fromCache } = await this.sqlSchemaService.getSchema(connection, database, forceRefresh);
			const tablesCount = schema.tables?.length ?? 0;
			let columnsCount = 0;
			if (schema.columnsByTable) {
				for (const tbl of Object.keys(schema.columnsByTable)) {
					columnsCount += Object.keys(schema.columnsByTable[tbl] || {}).length;
				}
			}
			await this.dispatchSqlResultOwnerAllowed(boxId, owner, () => {
				if (!this.sqlResultOwnersEqual(this.getSqlResultOwner(boxId), owner)) return;
				this.output.info(`[sql-schema] loaded tables=${tablesCount} columns=${columnsCount} fromCache=${fromCache}`);
				this.postMessage({
					type: 'sqlSchemaData',
					boxId,
					sqlConnectionId,
					database,
					targetGeneration: owner.generation,
					serverUrl: connection.serverUrl,
					schema,
					schemaMeta: { fromCache, tablesCount, columnsCount },
				});
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			try {
				await this.dispatchSqlResultOwnerAllowed(boxId, owner, () => {
					if (!this.sqlResultOwnersEqual(this.getSqlResultOwner(boxId), owner)) return;
					this.output.error(`[sql-schema] error: ${sanitizeStsLogText(msg)}`);
					this.postMessage({
						type: 'sqlSchemaData',
						boxId,
						sqlConnectionId,
						database,
						targetGeneration: owner.generation,
						serverUrl: connection.serverUrl,
						schema: null,
						schemaMeta: { error: true, errorMessage: msg },
					});
				});
			} catch {
				this.output.warn('[sql-schema] Request failed after owner invalidation; details suppressed.');
			}
		}
	}

	// ── STS (SqlToolsService) integration ──────────────────────────────────

	private async ensureStsLanguageService(): Promise<StsLanguageService | null> {
		if (this._stsLanguageService) return this._stsLanguageService;
		if (this._stsInitPromise) return this._stsInitPromise;

		const attempt = (async () => {
			try {
				// Reuse an existing process manager if another editor already started STS.
				const processManager = await this.sqlWorkbench.runtime.getProcessManager();
				if (this._sqlEditorSessionDisposed || !this.panel) return null;

				const languageService = new StsLanguageService(
					processManager,
					this.sqlConnectionManager,
					this.context,
					this.output,
					undefined,
					this.sqlWorkbench.leaveNoTracePolicy,
					(connection, principal, revocation, dispatch) => this.sqlWorkbench.dispatchSqlOwnerAllowed(connection, principal, revocation, dispatch),
				);
				this._stsLanguageService = languageService;

				// Forward diagnostics to webview
				languageService.onDiagnostics((event) => {
					if (!event.owner || !Number.isSafeInteger(event.owner.generation)) return;
					const owner: SqlResultOwner = { ...event.owner, generation: Number(event.owner.generation) };
					if (!this.sqlResultOwnersEqual(this.getSqlResultOwner(event.boxId), owner)) return;
					// StsLanguageService invokes this callback synchronously inside composite owner admission.
					this.postMessage({ type: 'stsDiagnostics', boxId: event.boxId, markers: event.markers });
				});

				return languageService;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.output.error(`[sts] Init failed: ${sanitizeStsLogText(msg)}`);
				return null;
			}
		})();
		this._stsInitPromise = attempt;
		try {
			return await attempt;
		} finally {
			if (this._stsInitPromise === attempt) this._stsInitPromise = undefined;
		}
	}

	private async handleStsRequest(requestId: string, method: string, params: {
		boxId: string; line: number; column: number; ownerToken?: string; targetGeneration?: number;
	}): Promise<void> {
		this.output.info(`[sts-diag] handleStsRequest method=${method} boxId=${params.boxId} L${params.line}:${params.column}`);
		const postNull = () => this.postMessage({
			type: 'stsResponse', requestId, result: null,
			ownerToken: String(params.ownerToken || ''), targetGeneration: Number(params.targetGeneration),
		} as any);
		const connectionId = this._sqlConnectionIdByBoxId.get(params.boxId);
		if (!connectionId || this.sqlWorkbench.isLeaveNoTraceConnection(connectionId) || !this._openedStsBoxIds.has(params.boxId)) {
			postNull();
			return;
		}
		let expectedOwner: SqlResultOwner;
		let issuedOwnerToken: string;
		try {
			const issued = await this.assertSqlOwnerToken(params.boxId, params.ownerToken);
			expectedOwner = issued.owner;
			issuedOwnerToken = issued.token;
			if (expectedOwner.connectionId !== connectionId || expectedOwner.generation !== Number(params.targetGeneration)) {
				throw new Error('SQL language owner unavailable.');
			}
		} catch {
			postNull();
			return;
		}
		const svc = await this.ensureStsLanguageService();
		if (!svc) {
			this.output.warn(`[sts-diag] handleStsRequest → svc=null, returning null`);
			postNull();
			return;
		}
		try {
			let result: unknown = null;
			switch (method) {
				case 'textDocument/completion':
					result = await svc.getCompletions(params.boxId, params.line, params.column, expectedOwner);
					break;
				case 'textDocument/hover':
					result = await svc.getHover(params.boxId, params.line, params.column, expectedOwner);
					break;
				case 'textDocument/signatureHelp':
					result = await svc.getSignatureHelp(params.boxId, params.line, params.column, expectedOwner);
					break;
				default:
					this.output.warn(`[sts] Unknown method: ${method}`);
			}
			await this.assertSqlResultOwnerAllowed(params.boxId, expectedOwner);
			if (this._stsLanguageService !== svc) throw new Error('SQL language service changed before response admission.');
			await this.postSqlOwnerMessageAllowed(params.boxId, expectedOwner, {
				type: 'stsResponse', requestId, result, ownerToken: issuedOwnerToken, targetGeneration: expectedOwner.generation,
			}, () =>
				this._stsLanguageService === svc && this.sqlResultOwnersEqual(this.getSqlResultOwner(params.boxId), expectedOwner));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			try {
				await this.dispatchSqlResultOwnerAllowed(params.boxId, expectedOwner, () => {
					if (this._stsLanguageService !== svc || !this.sqlResultOwnersEqual(this.getSqlResultOwner(params.boxId), expectedOwner)) return;
					this.output.error(`[sts] Request error (${method}): ${sanitizeStsLogText(msg)}`);
				});
			} catch {
				this.output.warn('[sts] Language request failed after owner invalidation; details suppressed.');
			}
			postNull();
		}
	}

	private handleStsDidOpen(boxId: string, text: string): void {
		const id = String(boxId || '').trim();
		if (!id) return;
		this._closedStsBoxIds.delete(id);
		this._pendingStsTextByBoxId.set(id, text);
		this.output.info(`[sts-diag] handleStsDidOpen boxId=${id} textLen=${text.length}`);
	}

	private async handleStsDidChange(boxId: string, text: string): Promise<void> {
		const id = String(boxId || '').trim();
		if (id) this._pendingStsTextByBoxId.set(id, text);
		if (id && !this._closedStsBoxIds.has(id) && this._openedStsBoxIds.has(id) && this._stsLanguageService) {
			const connectionId = this._sqlConnectionIdByBoxId.get(id);
			if (!connectionId) return;
			try {
				await this.sqlWorkbench.assertSqlConnectionAllowed(connectionId);
				await this._stsLanguageService.changeDocument(id, text);
			} catch {
				// Policy changes close the owner through the shared policy subscription.
			}
		}
	}

	private handleStsDidClose(boxId: string): void {
		const id = String(boxId || '').trim();
		if (!id) return;
		this.supersedeSqlRunAdmission(id, { notifyWebview: true });
		this.copilot.cancelCopilotWriteQuery(id);
		this._closedStsBoxIds.add(id);
		this._openedStsBoxIds.delete(id);
		this._pendingStsTextByBoxId.delete(id);
		this._sqlConnectionIdByBoxId.delete(id);
		this._sqlDatabaseByBoxId.delete(id);
		this._sqlDatabaseRequestIdByBoxId.delete(id);
		this._sqlRunAdmissionGenerationByBoxId.delete(id);
		this._sqlTargetGenerationByBoxId.delete(id);
		this._sqlOwnerTokenByBoxId.delete(id);
		for (const [comparisonBoxId, owner] of [...this._sqlComparisonOwnerByBoxId]) {
			if (owner.sourceBoxId !== id) continue;
			this.supersedeSqlRunAdmission(comparisonBoxId, { notifyWebview: true });
			this.copilot.cancelCopilotWriteQuery(comparisonBoxId);
			this._sqlComparisonOwnerByBoxId.delete(comparisonBoxId);
		}
		this._latestStsConnectSequenceByBoxId.delete(id);
		this.output.info(`[sts-diag] handleStsDidClose boxId=${id}`);
		if (this._stsLanguageService) {
			this._stsLanguageService.closeDocument(id);
		}
	}

	private disposeSqlEditorSession(): void {
		this._sqlEditorSessionDisposed = true;
		try { this._stsLanguageService?.dispose(); } catch { /* ignore */ }
		this._stsLanguageService = undefined;
		this._stsInitPromise = undefined;
		this._closedStsBoxIds.clear();
		this._openedStsBoxIds.clear();
		this._pendingStsTextByBoxId.clear();
		this._sqlConnectionIdByBoxId.clear();
		this._sqlDatabaseByBoxId.clear();
		this._sqlDatabaseRequestIdByBoxId.clear();
		this._sqlRunAdmissionGenerationByBoxId.clear();
		this._pendingSqlRunAdmissionByBoxId.clear();
		this._sqlCopilotPreflightByBoxId.clear();
		this._sqlTargetGenerationByBoxId.clear();
		this._sqlOwnerTokenByBoxId.clear();
		this._comparisonOwnerByBoxId.clear();
		this._sqlComparisonOwnerByBoxId.clear();
		this._sqlOwnershipRegistry = undefined;
		this._latestStsConnectSequenceByBoxId.clear();
		this._stsConnectSequenceByBoxId.clear();
	}

	private _nextStsConnectSequence(boxId: string): number {
		const sequence = (this._stsConnectSequenceByBoxId.get(boxId) || 0) + 1;
		this._stsConnectSequenceByBoxId.set(boxId, sequence);
		this._latestStsConnectSequenceByBoxId.set(boxId, sequence);
		return sequence;
	}

	private _isCurrentStsConnect(boxId: string, sequence: number): boolean {
		return !this._closedStsBoxIds.has(boxId) && this._latestStsConnectSequenceByBoxId.get(boxId) === sequence;
	}

	private _postCurrentStsConnectError(boxId: string, sequence: number, message: string): void {
		if (!this._isCurrentStsConnect(boxId, sequence)) {
			this.output.info(`[sts-diag] handleStsConnect → stale early failure suppressed boxId=${boxId}: ${sanitizeStsLogText(message)}`);
			return;
		}
		this.output.error(`[sts-diag] handleStsConnect → FAILED boxId=${boxId}: ${sanitizeStsLogText(message)}`);
		this.postMessage({
			type: 'stsConnectionState', boxId, state: 'error', error: message,
			targetGeneration: this._sqlTargetGenerationByBoxId.get(boxId) ?? 0,
		} as any);
	}

	private async handleStsConnect(
		boxId: string,
		sqlConnectionId: string,
		database: string,
		targetGeneration?: number,
		expectedOwner?: { connectionId: string; database: string; targetSignature: string; principalFingerprint: string; revocationGeneration: number },
	): Promise<void> {
		const id = String(boxId || '').trim();
		if (!id || this._closedStsBoxIds.has(id)) {
			this.output.info(`[sts-diag] handleStsConnect skipped closed boxId=${id || '(none)'}`);
			return;
		}
		const previousOwner = this._sqlOwnerTokenByBoxId.get(id)?.owner ?? this.getSqlResultOwner(id);
		if (!this.adoptSqlTarget(id, sqlConnectionId, database, Number(targetGeneration))) {
			this.output.info(`[sts-diag] handleStsConnect skipped stale target boxId=${id}`);
			return;
		}
		const connectSequence = this._nextStsConnectSequence(id);
		if (this._openedStsBoxIds.has(id)) {
			if (previousOwner) this._stsLanguageService?.closeDocumentForOwner(id, previousOwner);
			this._openedStsBoxIds.delete(id);
		}
		this.output.info(`[sts-diag] handleStsConnect boxId=${id}`);
		const connection = this.sqlConnectionManager.getConnection(sqlConnectionId);
		if (!connection) {
			this.output.warn('[sts-diag] handleStsConnect → connection not found');
			this._postCurrentStsConnectError(id, connectSequence, `SQL connection not found: ${sqlConnectionId}`);
			return;
		}
		const assertExpectedOwner = async () => {
			if (!expectedOwner) return;
			if (expectedOwner.connectionId !== connection.id
				|| expectedOwner.database !== database
				|| expectedOwner.targetSignature !== sqlDatabaseTargetSignature(connection)
				|| expectedOwner.revocationGeneration !== (this.sqlWorkbench.leaveNoTracePolicy.getRevocationGeneration?.(connection.id) ?? 0)) {
				throw new Error('SQL tool execution target changed before STS connection.');
			}
			await this.sqlConnectionManager.assertConnectionCurrent(connection);
			if (await readCurrentSqlSchemaPrincipalFingerprint(this.context, connection) !== expectedOwner.principalFingerprint) {
				throw new Error('SQL tool execution principal changed before STS connection.');
			}
		};
		if (this.sqlWorkbench.isLeaveNoTraceConnection(connection.id)) {
			this._postCurrentStsConnectError(id, connectSequence, 'SQL Tools Service cannot be used with this Leave No Trace connection because it may buffer results on disk.');
			return;
		}
		try {
			await this.sqlWorkbench.assertSqlConnectionAllowed(connection.id);
			await assertExpectedOwner();
		} catch (error) {
			this._postCurrentStsConnectError(id, connectSequence, error instanceof Error ? error.message : String(error));
			return;
		}
		const stsOwner = await this.getCanonicalSqlResultOwner(id);
		if (!stsOwner || stsOwner.connectionId !== connection.id || stsOwner.database !== database) {
			this._postCurrentStsConnectError(id, connectSequence, 'SQL result owner changed before STS connection.');
			return;
		}
		if (expectedOwner && (expectedOwner.targetSignature !== stsOwner.targetSignature
			|| expectedOwner.principalFingerprint !== stsOwner.principalFingerprint
			|| expectedOwner.revocationGeneration !== stsOwner.revocationGeneration)) {
			this._postCurrentStsConnectError(id, connectSequence, 'SQL tool execution owner changed before STS connection.');
			return;
		}
		const svc = await this.ensureStsLanguageService();
		if (!svc) {
			this.output.warn(`[sts-diag] handleStsConnect → svc=null`);
			this._postCurrentStsConnectError(id, connectSequence, 'SQL Tools Service unavailable');
			return;
		}
		if (!this._isCurrentStsConnect(id, connectSequence)) {
			this.output.info(`[sts-diag] handleStsConnect skipped closed boxId=${id}`);
			return;
		}
		this.output.info(`[sts-diag] handleStsConnect → connecting auth=${connection.authType}`);
		const closeCandidateOwner = () => {
			if (svc.closeDocumentForOwner(id, stsOwner)) {
				this._openedStsBoxIds.delete(id);
				return true;
			}
			return false;
		};
		try {
			await assertExpectedOwner();
			if (!this._isCurrentStsConnect(id, connectSequence)) return;
			if (!this._openedStsBoxIds.has(id)) {
				await svc.openDocument(id, this._pendingStsTextByBoxId.get(id) || '', connection, stsOwner);
				if (!this._isCurrentStsConnect(id, connectSequence)) {
					closeCandidateOwner();
					return;
				}
				this._openedStsBoxIds.add(id);
			}
			await assertExpectedOwner();
			if (!this._isCurrentStsConnect(id, connectSequence)) {
				closeCandidateOwner();
				return;
			}
			await svc.connectDocument(id, connection, database, stsOwner);
			if (!this._isCurrentStsConnect(id, connectSequence)) {
				closeCandidateOwner();
				return;
			}
			await this.sqlWorkbench.assertSqlConnectionAllowed(connection.id);
			if (!this._isCurrentStsConnect(id, connectSequence)) {
				this.output.info(`[sts-diag] handleStsConnect → stale success suppressed boxId=${id}`);
				closeCandidateOwner();
				return;
			}
			const connectedOwner = await this.getCanonicalSqlResultOwner(id);
			if (!this._isCurrentStsConnect(id, connectSequence)) {
				closeCandidateOwner();
				return;
			}
			if (!connectedOwner || !this.sqlResultOwnersEqual(connectedOwner, stsOwner)) {
				throw new Error('SQL result owner changed before connection admission.');
			}
			if (!this._isCurrentStsConnect(id, connectSequence)) {
				closeCandidateOwner();
				return;
			}
			const ownerToken = await this.issueSqlOwnerToken(id, connectedOwner);
			if (!this._isCurrentStsConnect(id, connectSequence)) {
				closeCandidateOwner();
				return;
			}
			this.output.info(`[sts-diag] handleStsConnect → SUCCESS boxId=${id}`);
			this.postMessage({
				type: 'stsConnectionState', boxId: id, state: 'ready', ownerToken,
				connectionId: connectedOwner.connectionId, database: connectedOwner.database,
				targetGeneration: connectedOwner.generation,
			} as any);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			closeCandidateOwner();
			if (!this._isCurrentStsConnect(id, connectSequence)) {
				this.output.info(`[sts-diag] handleStsConnect → stale failure suppressed boxId=${id}: ${sanitizeStsLogText(msg)}`);
				return;
			}
			this.output.error(`[sts-diag] handleStsConnect → FAILED boxId=${id}: ${sanitizeStsLogText(msg)}`);
			this.postMessage({
				type: 'stsConnectionState', boxId: id, state: 'error', error: msg,
				targetGeneration: this._sqlTargetGenerationByBoxId.get(id) ?? 0,
			} as any);
		}
	}

	private async handleStsRuntimeManagerChange(hasCurrentManager: boolean): Promise<void> {
		if (this._sqlEditorSessionDisposed) return;
		if (!hasCurrentManager) {
			if (!this._stsLanguageService && !this._stsInitPromise) return;
			try { this._stsLanguageService?.dispose(); } catch { /* ignore */ }
			this._stsLanguageService = undefined;
			this._stsInitPromise = undefined;
			this._openedStsBoxIds.clear();
			return;
		}
		if (this._stsInitPromise && !this._stsLanguageService) {
			const initialized = await this._stsInitPromise;
			if (initialized) return;
		}
		const targets = [...this._sqlConnectionIdByBoxId.entries()]
			.filter(([boxId]) => !this._closedStsBoxIds.has(boxId) && !!this._sqlDatabaseByBoxId.get(boxId))
			.map(([boxId, connectionId]) => ({
				boxId, connectionId,
				database: this._sqlDatabaseByBoxId.get(boxId) || '',
				generation: this._sqlTargetGenerationByBoxId.get(boxId) ?? 0,
				sequence: this._nextStsConnectSequence(boxId),
			}));
		if (targets.length === 0) return;
		const service = await this.ensureStsLanguageService();
		if (!service) return;
		for (const target of targets) {
			const { boxId, connectionId, database, generation, sequence } = target;
			const isCurrent = () => this._isCurrentStsConnect(boxId, sequence)
				&& this._sqlConnectionIdByBoxId.get(boxId) === connectionId
				&& this._sqlDatabaseByBoxId.get(boxId) === database
				&& (this._sqlTargetGenerationByBoxId.get(boxId) ?? 0) === generation;
			const connection = this.sqlConnectionManager.getConnection(connectionId);
			if (!connection || !database || !isCurrent()) continue;
			let expectedOwner: SqlResultOwner | undefined;
			let candidateOpenAttempted = false;
			const closeCandidate = () => {
				if (!candidateOpenAttempted || !expectedOwner) return;
				if (service.closeDocumentForOwner(boxId, expectedOwner)) this._openedStsBoxIds.delete(boxId);
				candidateOpenAttempted = false;
			};
			try {
				await this.sqlWorkbench.assertSqlConnectionAllowed(connectionId);
				if (!isCurrent()) continue;
				expectedOwner = await this.getCanonicalSqlResultOwner(boxId);
				if (!expectedOwner || expectedOwner.connectionId !== connectionId || expectedOwner.database !== database || expectedOwner.generation !== generation) continue;
				candidateOpenAttempted = true;
				await service.openDocument(boxId, this._pendingStsTextByBoxId.get(boxId) || '', connection, expectedOwner);
				if (!isCurrent()) { closeCandidate(); continue; }
				this._openedStsBoxIds.add(boxId);
				await service.connectDocument(boxId, connection, database, expectedOwner);
				await this.sqlWorkbench.assertSqlConnectionAllowed(connectionId);
				if (!isCurrent()) { closeCandidate(); continue; }
				const connectedOwner = await this.getCanonicalSqlResultOwner(boxId);
				if (!this.sqlResultOwnersEqual(connectedOwner, expectedOwner)) { closeCandidate(); continue; }
				const ownerToken = await this.issueSqlOwnerToken(boxId, expectedOwner);
				if (!isCurrent()) { closeCandidate(); continue; }
				this.postMessage({
					type: 'stsConnectionState', boxId, state: 'ready', ownerToken,
					connectionId, database, targetGeneration: generation,
				} as any);
				candidateOpenAttempted = false;
			} catch (error) {
				closeCandidate();
				if (!isCurrent()) continue;
				this.postMessage({
					type: 'stsConnectionState', boxId, state: 'error',
					error: error instanceof Error ? error.message : String(error),
				} as any);
			}
		}
	}

	private async handleSqlConnectionsChanged(connections: readonly import('./sqlConnectionManager').SqlConnection[]): Promise<void> {
		const nextSignatures = new Map(connections.map(connection => [connection.id, sqlDatabaseTargetSignature(connection)]));
		const changedIds = new Set<string>();
		for (const [connectionId, signature] of this.sqlConnectionSignatureById) {
			if (nextSignatures.get(connectionId) !== signature) changedIds.add(connectionId);
		}
		for (const connectionId of nextSignatures.keys()) {
			if (!this.sqlConnectionSignatureById.has(connectionId)) changedIds.add(connectionId);
		}
		this.sqlConnectionSignatureById = nextSignatures;
		if (changedIds.size === 0) {
			await this.sendSqlConnectionsData();
			return;
		}
		this.sqlPersistenceInvalidationEmitter.fire();

		const comparisonBoxIds = [...this._sqlComparisonOwnerByBoxId]
			.filter(([, owner]) => changedIds.has(owner.connectionId))
			.map(([boxId]) => boxId);
		this.copilot.invalidateSqlConnections([...changedIds], comparisonBoxIds);
		for (const comparisonBoxId of comparisonBoxIds) this.supersedeSqlRunAdmission(comparisonBoxId, { notifyWebview: true });
		for (const [boxId, connectionId] of this._sqlConnectionIdByBoxId) {
			if (!changedIds.has(connectionId)) continue;
			this.supersedeSqlRunAdmission(boxId, { notifyWebview: true });
			const targetGeneration = (this._sqlTargetGenerationByBoxId.get(boxId) ?? 0) + 1;
			this._sqlTargetGenerationByBoxId.set(boxId, targetGeneration);
			this._sqlOwnerTokenByBoxId.delete(boxId);
			this._sqlDatabaseRequestIdByBoxId.delete(boxId);
			if (this._openedStsBoxIds.delete(boxId)) this._stsLanguageService?.closeDocument(boxId);
			this._latestStsConnectSequenceByBoxId.delete(boxId);
			this.postMessage({ type: 'sqlConnectionOwnerChanged', boxId, connectionId, targetGeneration });
		}
		await this.sendSqlConnectionsData();
	}

	private async handleSqlPrincipalsChanged(connectionIds: readonly string[]): Promise<void> {
		const changedIds = new Set(connectionIds);
		if (changedIds.size === 0) return;
		this.sqlPersistenceInvalidationEmitter.fire();
		const comparisonBoxIds = [...this._sqlComparisonOwnerByBoxId]
			.filter(([, owner]) => changedIds.has(owner.connectionId))
			.map(([boxId]) => boxId);
		this.copilot.invalidateSqlConnections([...changedIds], comparisonBoxIds);
		for (const comparisonBoxId of comparisonBoxIds) this.supersedeSqlRunAdmission(comparisonBoxId, { notifyWebview: true });
		for (const [boxId, connectionId] of this._sqlConnectionIdByBoxId) {
			if (!changedIds.has(connectionId)) continue;
			this.supersedeSqlRunAdmission(boxId, { notifyWebview: true });
			const targetGeneration = (this._sqlTargetGenerationByBoxId.get(boxId) ?? 0) + 1;
			this._sqlTargetGenerationByBoxId.set(boxId, targetGeneration);
			this._sqlOwnerTokenByBoxId.delete(boxId);
			if (this._openedStsBoxIds.delete(boxId)) this._stsLanguageService?.closeDocument(boxId);
			this._latestStsConnectSequenceByBoxId.delete(boxId);
			this.postMessage({ type: 'sqlConnectionOwnerChanged', boxId, connectionId, targetGeneration });
		}
		await this.sendSqlConnectionsData();
	}

	private applySqlLeaveNoTraceChange(connectionIds: string[], invalidatedConnectionIds: string[]): void {
		const currentlyProtected = new Set(connectionIds);
		const invalidated = new Set(invalidatedConnectionIds);
		const comparisonBoxIds = [...this._sqlComparisonOwnerByBoxId]
			.filter(([, owner]) => invalidated.has(owner.connectionId))
			.map(([boxId]) => boxId);
		const sourceBoxIds = [...this._sqlConnectionIdByBoxId]
			.filter(([, connectionId]) => invalidated.has(connectionId))
			.map(([boxId]) => boxId);
		for (const comparisonBoxId of comparisonBoxIds) {
			this.supersedeSqlRunAdmission(comparisonBoxId, { notifyWebview: true });
		}
		for (const boxId of sourceBoxIds) {
			this.supersedeSqlRunAdmission(boxId, { notifyWebview: true });
		}
		this.postMessage({ type: 'sqlLeaveNoTraceData', connectionIds });
		void this.sendSqlConnectionsData();
		if (invalidatedConnectionIds.length === 0) return;
		this.sqlPersistenceInvalidationEmitter.fire();
		this.copilot.invalidateSqlConnections(invalidatedConnectionIds, comparisonBoxIds);
		for (const comparisonBoxId of comparisonBoxIds) {
			const owner = this._sqlComparisonOwnerByBoxId.get(comparisonBoxId);
			if (owner) this.deleteComparisonSummary(`${owner.sourceBoxId}::${comparisonBoxId}`);
		}
		for (const boxId of sourceBoxIds) {
			const connectionId = this._sqlConnectionIdByBoxId.get(boxId);
			this._sqlOwnerTokenByBoxId.delete(boxId);
			if (this._openedStsBoxIds.delete(boxId)) this._stsLanguageService?.closeDocument(boxId);
			this._latestStsConnectSequenceByBoxId.delete(boxId);
			if (connectionId && currentlyProtected.has(connectionId)) {
				this.postMessage({
					type: 'stsConnectionState', boxId, state: 'error',
					error: 'SQL Tools Service is disabled for this Leave No Trace connection.',
				} as any);
			} else if (connectionId) {
				const targetGeneration = (this._sqlTargetGenerationByBoxId.get(boxId) ?? 0) + 1;
				this._sqlTargetGenerationByBoxId.set(boxId, targetGeneration);
				this.postMessage({ type: 'sqlConnectionOwnerChanged', boxId, connectionId, targetGeneration });
			}
		}
	}

	public sanitizeSqlLeaveNoTraceState<T extends { sections?: unknown[] }>(state: T): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
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
				return clone;
			}
			const persistedSqlSource = String((persistedSource as any)?.type || '') === 'sql' ? persistedSource : undefined;
			const directConnectionHint = String((section as any).connectionIdHint || '').trim();
			const legacySqlComparison = sectionType === 'query' && !persistedSourceBoxId
				&& directConnectionHint.startsWith('sql_');
			if (sectionType !== 'sql' && !persistedSqlSource && !legacySqlComparison) return section;
			const connectionId = boxId ? this._sqlConnectionIdByBoxId.get(boxId) : undefined;
			const sourceConnectionId = persistedSourceBoxId ? this._sqlConnectionIdByBoxId.get(persistedSourceBoxId) : undefined;
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
			if (legacySqlComparison && 'resultJson' in section) {
				changed = true;
				const clone = { ...(section as Record<string, unknown>) };
				delete clone.resultJson;
				return clone;
			}
			const serverUrl = String((persistedSqlSource as any)?.serverUrl || (section as any).serverUrl || '').trim().toLowerCase();
			const protectedByRuntimeOwner = !!effectiveConnectionId && this.sqlWorkbench.isLeaveNoTraceConnection(effectiveConnectionId);
			const protectedByRestoredServer = !effectiveConnectionId && !!serverUrl && this.sqlConnectionManager.getConnections().some(connection =>
				this.sqlWorkbench.isLeaveNoTraceConnection(connection.id)
				&& String(connection.serverUrl || '').trim().toLowerCase() === serverUrl
			);
			const sqlOwnedSection = sectionType === 'sql' || !!persistedSqlSource || legacySqlComparison;
			const unresolvedPersistedOwner = sqlOwnedSection && !effectiveConnectionId;
			if ((!protectedByRuntimeOwner && !protectedByRestoredServer && !unresolvedPersistedOwner) || !('resultJson' in section)) return section;
			changed = true;
			const clone = { ...(section as Record<string, unknown>) };
			delete clone.resultJson;
			return clone;
		});
		return this.stripOrphanedSqlPrincipalFingerprints(changed ? { ...state, sections: sanitized } : state);
	}

	private stripOrphanedSqlPrincipalFingerprints<T extends { sections?: unknown[] }>(state: T): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object') return section;
			const record = section as Record<string, unknown>;
			if (String(record.type || '') !== 'sql'
				|| (!('principalFingerprint' in record) && !('revocationGeneration' in record))
				|| ('resultJson' in record && !!String(record.resultJson || ''))) return section;
			changed = true;
			const clone = { ...record };
			delete clone.principalFingerprint;
			delete clone.revocationGeneration;
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
				|| (type === 'query' && String(record.connectionIdHint || '').trim().startsWith('sql_'))
				|| (!!sourceBoxId && (sectionTypesById.get(sourceBoxId) === 'sql' || !sectionTypesById.has(sourceBoxId)));
			if (!sqlOwned) return section;
			changed = true;
			const clone = { ...record };
			delete clone.resultJson;
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
			return clone;
		});
		return this.stripOrphanedSqlPrincipalFingerprints(changed ? { ...state, sections: sanitized } : state);
	}

	private async sanitizeSqlPrincipalOwnedResultsFresh<T extends { sections?: unknown[] }>(state: T): Promise<T> {
		return this.sqlWorkbench.dispatchSqlOwnerSnapshot(snapshot => this.sanitizeSqlPrincipalOwnedResultsFromSnapshot(state, snapshot));
	}

	private hasSqlOwnedState(state: { sections?: unknown[] }): boolean {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		const sectionTypesById = new Map(sections
			.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object')
			.map(section => [String(section.id || '').trim(), String(section.type || '')]));
		return sections.some(section => {
			if (!section || typeof section !== 'object') return false;
			if (String((section as Record<string, unknown>).type || '') === 'sql') return true;
			if (String((section as Record<string, unknown>).type || '') === 'query'
				&& String((section as Record<string, unknown>).connectionIdHint || '').trim().startsWith('sql_')) return true;
			const sourceBoxId = String((section as Record<string, unknown>).comparisonSourceBoxId || '').trim();
			return !!sourceBoxId && sectionTypesById.get(sourceBoxId) === 'sql';
		});
	}

	public async sanitizeSqlLeaveNoTraceStateFresh<T extends { sections?: unknown[] }>(state: T): Promise<T> {
		const locallySanitized = this.sanitizeSqlLeaveNoTraceState(state);
		if (!this.hasSqlOwnedState(locallySanitized)) return locallySanitized;
		try {
			return await this.sanitizeSqlPrincipalOwnedResultsFresh(locallySanitized);
		} catch {
			return this.stripAllSqlOwnedResults(locallySanitized);
		}
	}

	public async publishSqlLeaveNoTraceStateFresh<T extends { sections?: unknown[] }, R>(
		state: T,
		publish: (sanitizedState: T) => Promise<R>,
	): Promise<R> {
		const locallySanitized = this.sanitizeSqlLeaveNoTraceState(state);
		if (!this.hasSqlOwnedState(locallySanitized)) return publish(locallySanitized);
		return this.sqlWorkbench.runWithSqlOwnerSnapshotLock(async snapshot => {
			return publish(this.sanitizeSqlPrincipalOwnedResultsFromSnapshot(locallySanitized, snapshot));
		});
	}

	private async promptAddSqlConnection(boxId?: string): Promise<void> {
		const serverUrl = await vscode.window.showInputBox({
			prompt: 'SQL Server address',
			placeHolder: 'myserver.database.windows.net',
			ignoreFocusOut: true,
		});
		if (!serverUrl) {
			return;
		}

		const authType = await vscode.window.showQuickPick(
			[
				{ label: 'Azure AD (default)', id: 'aad' },
				{ label: 'SQL Login (username/password)', id: 'sql-login' },
			],
			{ placeHolder: 'Authentication type', ignoreFocusOut: true },
		);
		if (!authType) {
			return;
		}

		let username: string | undefined;
		let password: string | undefined;
		if (authType.id === 'sql-login') {
			username = await vscode.window.showInputBox({
				prompt: 'Username',
				placeHolder: 'sa',
				ignoreFocusOut: true,
			});
			if (!username) {
				return;
			}
			password = await vscode.window.showInputBox({
				prompt: 'Password',
				password: true,
				ignoreFocusOut: true,
			});
			if (password === undefined) {
				return;
			}
		}

		const name = (await vscode.window.showInputBox({
			prompt: 'Connection name (optional)',
			placeHolder: serverUrl.trim(),
			ignoreFocusOut: true,
		})) || '';

		const newConn = await this.sqlConnectionManager.addConnection(
			{
				name: name.trim() || serverUrl.trim(),
				dialect: 'mssql',
				serverUrl: serverUrl.trim(),
				authType: authType.id,
				username,
			},
			password,
		);

		await this.context.globalState.update('sql.lastConnectionId', newConn.id);

		this.postMessage({
			type: 'sqlConnectionAdded',
			boxId,
			connectionId: newConn.id,
			connections: this.sqlConnectionManager.getConnections(),
		});
	}

	private async addSqlConnectionFromWebview(
		message: Extract<IncomingWebviewMessage, { type: 'addSqlConnection' }>
	): Promise<void> {
		const serverUrl = String(message.serverUrl || '').trim();
		if (!serverUrl) return;
		const name = String(message.name || '').trim() || serverUrl;

		const newConn = await this.sqlConnectionManager.addConnection(
			{
				name,
				dialect: message.dialect || 'mssql',
				serverUrl,
				authType: message.authType || 'aad',
				username: message.username,
				port: message.port,
				database: message.database,
			},
			message.password,
		);

		await this.context.globalState.update('sql.lastConnectionId', newConn.id);

		this.postMessage({
			type: 'sqlConnectionAdded',
			boxId: message.boxId,
			connectionId: newConn.id,
			connections: this.sqlConnectionManager.getConnections(),
		});
	}

	private async executeSqlQueryFromWebview(
		message: Extract<IncomingWebviewMessage, { type: 'executeSqlQuery' }>
	): Promise<void> {
		const boxId = String(message.boxId || '').trim();
		const executionId = String(message.executionId || '').trim();
		if (boxId) this.retirePendingSqlRunAdmission(boxId, true);
		const admissionGeneration = boxId
			? (this._sqlRunAdmissionGenerationByBoxId.get(boxId) ?? 0) + 1
			: 0;
		if (boxId) {
			this._sqlRunAdmissionGenerationByBoxId.set(boxId, admissionGeneration);
			if (executionId) {
				this._pendingSqlRunAdmissionByBoxId.set(boxId, {
					generation: admissionGeneration, executionId,
					...(message.ownerToken ? { ownerToken: message.ownerToken } : {}),
				});
			}
		}
		const admissionIsCurrent = () => !boxId || this._sqlRunAdmissionGenerationByBoxId.get(boxId) === admissionGeneration;
		const clearPendingAdmission = () => {
			const pending = this._pendingSqlRunAdmissionByBoxId.get(boxId);
			if (pending?.generation === admissionGeneration && pending.executionId === executionId) {
				this._pendingSqlRunAdmissionByBoxId.delete(boxId);
			}
		};
		let issuedOwner: { token: string; owner: SqlResultOwner } | undefined;
		if (boxId) {
			const superseded = this.queryRuns.get(boxId);
			this.cancelRunningQuery(boxId, { notifyWebview: !!superseded?.executionId });
			try {
				issuedOwner = await this.assertSqlOwnerToken(boxId, message.ownerToken);
				if (!admissionIsCurrent()) return;
			} catch (error) {
				if (!admissionIsCurrent()) return;
				clearPendingAdmission();
				this.postMessage({
					type: 'queryError', error: error instanceof Error ? error.message : String(error), boxId, ownerToken: message.ownerToken,
					...(message.executionId ? { executionId: message.executionId } : {}),
				});
				return;
			}
		}

		const connection = this.sqlConnectionManager.getConnection(message.sqlConnectionId);
		if (!connection) {
			clearPendingAdmission();
			this.postMessage({ type: 'queryError', error: 'SQL connection not found. Please configure a connection.', boxId, ownerToken: issuedOwner?.token ?? message.ownerToken, ...(executionId ? { executionId } : {}) });
			return;
		}

		if (!message.database) {
			clearPendingAdmission();
			this.postMessage({ type: 'queryError', error: 'Please select a database.', boxId, ownerToken: issuedOwner?.token ?? message.ownerToken, ...(executionId ? { executionId } : {}) });
			return;
		}

		const resultOwner = issuedOwner?.owner ?? (boxId ? this.getSqlResultOwner(boxId) : undefined);
		if (boxId && (!resultOwner || resultOwner.connectionId !== connection.id || resultOwner.database !== message.database)) {
			clearPendingAdmission();
			this.postMessage({ type: 'queryError', error: 'SQL section target changed. Run the query again.', boxId, ownerToken: issuedOwner?.token ?? message.ownerToken, ...(executionId ? { executionId } : {}) });
			return;
		}
		if (message.toolExecution) {
			const expected = message.expectedOwner;
			if (!message.executionId || !expected || !resultOwner
				|| expected.connectionId !== resultOwner.connectionId
				|| expected.database !== resultOwner.database
				|| expected.targetSignature !== resultOwner.targetSignature
				|| expected.principalFingerprint !== resultOwner.principalFingerprint
				|| expected.revocationGeneration !== resultOwner.revocationGeneration) {
				clearPendingAdmission();
				this.postMessage({
					type: 'queryError', error: 'SQL tool execution owner changed before query dispatch.', boxId,
					ownerToken: issuedOwner?.token, executionId: message.executionId,
				});
				return;
			}
		}
		const queryWithMode = appendSqlQueryModeFn(message.query, message.queryMode);
		let cancel: (() => void) | undefined;
		let runSeq = 0;
		const isStillActiveRun = () => {
			if (!admissionIsCurrent()) return false;
			if (!cancel) { return true; }
			if (!boxId) { return true; }
			return this.isRunningQueryCurrent(boxId, cancel, runSeq);
		};
		try {
			if (!admissionIsCurrent()) return;
			if (boxId && executionId) {
				const pending = this._pendingSqlRunAdmissionByBoxId.get(boxId);
				if (pending?.generation !== admissionGeneration || pending.executionId !== executionId) return;
			}
			const handle = this.sqlClient.executeQueryCancelable(connection, message.database, queryWithMode);
			cancel = handle.cancel;
			runSeq = this.nextQueryRunSeq();
			if (boxId) {
				clearPendingAdmission();
				this.queryRuns.register(boxId, { cancel, runSeq, ...(executionId ? { executionId } : {}) });
			}
			const { promise } = handle;
			const result = await promise;
			if (isStillActiveRun()) {
				await this.sendSqlConnectionsData();
				if (boxId && resultOwner) await this.assertSqlResultOwnerAllowed(boxId, resultOwner);
				else await this.sqlWorkbench.assertSqlConnectionAllowed(connection.id);
				if (!isStillActiveRun()) return;
				const delivered = await this.postSqlOwnerMessageAllowed(
					boxId,
					resultOwner!,
					{ type: 'queryResult', result, boxId, ownerToken: issuedOwner?.token, ...(message.executionId ? { executionId: message.executionId } : {}) },
					isStillActiveRun,
				);
				if (!delivered && isStillActiveRun()) {
					this.output.warn(`[sql] Result delivery failed for execution ${executionId}.`);
				}
			}
		} catch (error) {
			if ((error as any)?.isCancelled === true || error instanceof SqlQueryCancelledError) {
				if (isStillActiveRun()) {
					try {
						if (boxId && resultOwner) {
							const delivered = await this.postSqlOwnerMessageAllowed(
								boxId,
								resultOwner,
								{ type: 'queryCancelled', boxId, ownerToken: issuedOwner?.token, ...(executionId ? { executionId } : {}) },
								isStillActiveRun,
							);
							if (!delivered && isStillActiveRun()) {
								this.output.warn(`[sql] Cancellation delivery failed for execution ${executionId}.`);
							}
						} else if (isStillActiveRun()) {
							this.postMessage({ type: 'queryCancelled', boxId, ...(executionId ? { executionId } : {}) });
						}
					} catch { /* owner invalidation provides the terminal UI state */ }
				}
				return;
			}
			if (isStillActiveRun()) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				// Error is displayed inline in the SQL section — no notification popup
				// (avoids stealing keyboard focus from the Monaco editor).
				try {
					if (boxId && resultOwner) {
						await this.dispatchSqlResultOwnerAllowed(boxId, resultOwner, () => {
							if (!isStillActiveRun()) return;
							this.output.error([
								`[${new Date().toISOString()}] SQL query execution failed`,
								`  boxId: ${boxId}`,
								`  error: ${sanitizeStsLogText(errorMessage)}`,
							].join('\n'));
							this.postMessage({ type: 'queryError', error: errorMessage, boxId, ownerToken: issuedOwner?.token, ...(executionId ? { executionId } : {}) });
						});
					} else if (isStillActiveRun()) {
						this.output.error(`[sql] Query execution failed without an owned section: ${sanitizeStsLogText(errorMessage)}`);
						this.postMessage({ type: 'queryError', error: errorMessage, boxId, ...(executionId ? { executionId } : {}) });
					}
				} catch {
					this.output.warn('[sql] Query failed after owner invalidation; error details suppressed.');
				}
			}
		} finally {
			clearPendingAdmission();
			if (boxId && cancel) this.unregisterRunningQuery(boxId, cancel, runSeq);
		}
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
