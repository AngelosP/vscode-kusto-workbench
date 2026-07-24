import * as vscode from 'vscode';

import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import * as crypto from 'crypto';

import { ConnectionManager, KustoConnection } from './connectionManager';
import { KustoQueryClient, QueryExecutionError } from './kustoClient';
import { SqlQueryClient, SqlQueryCancelledError } from './sqlClient';
import { readCurrentSqlSchemaPrincipalFingerprint, SqlSchemaService, sqlSchemaPrincipalFingerprint, sqlSchemaPrincipalFingerprintForPrincipal } from './sqlEditorSchema';
import { SqlWorkbenchService, type SqlOwnerSnapshot } from './sql/sqlWorkbenchService';
import {
	sqlResultOwnersEqual,
	type SqlResultOwner,
} from './sql/sqlEditorSessionRegistry';
import {
	type SqlExecutionAdmission,
	type SqlExecutionLease,
} from './sql/sqlExecutionBroker';
import { SqlEditorLifecycleCoordinator } from './sql/sqlEditorLifecycleCoordinator';
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
const SQL_COPILOT_PREFLIGHT_EXECUTION_ID = 'sql-copilot-owner-preflight';


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

	// SQL schema responses and persistence remain provider adapters. Editor lifecycle
	// state is owned by SqlEditorLifecycleCoordinator; shared runtime state stays in SqlWorkbenchService.
	private _sqlSchemaService?: SqlSchemaService;
	private readonly sqlLifecycle: SqlEditorLifecycleCoordinator;
	private readonly _comparisonOwnerByBoxId = new Map<string, {
		sourceBoxId: string;
		copilotSequence?: number;
		comparisonRequestId?: string;
	}>();
	private _sqlConnectionsSnapshotRevision = 0;
	private sqlConnectionsSnapshotTail: Promise<boolean> = Promise.resolve(true);
	private readonly sqlPersistenceInvalidationEmitter = new vscode.EventEmitter<void>();
	readonly onDidInvalidateSqlPersistence = this.sqlPersistenceInvalidationEmitter.event;

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

	async assertSqlResultOwnerProtection(boxId: string, expectedOwner: SqlResultOwner, expectedProtected: boolean): Promise<void> {
		await this.sqlLifecycle.assertResultOwnerProtection(boxId, expectedOwner, expectedProtected);
	}

	private sqlResultOwnersEqual(left: SqlResultOwner | undefined, right: SqlResultOwner | undefined): boolean {
		return sqlResultOwnersEqual(left, right);
	}

	private async assertSqlOwnerToken(boxId: string, token: string | undefined): Promise<{ token: string; owner: SqlResultOwner }> {
		return this.sqlLifecycle.assertOwnerToken(boxId, token);
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
				&& this.sqlLifecycle.getComparisonOwner(comparisonBoxId)?.comparisonRequestId === requestId) {
				this.sqlLifecycle.removeComparisonOwner(comparisonBoxId);
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
				rejectPendingComparisonEnsures: sourceBoxId => {
					for (const [requestId, pending] of [...this.pendingComparisonEnsureByRequestId]) {
						if (pending.sourceBoxId === sourceBoxId) {
							this.settlePendingComparisonEnsure(requestId, pending, { error: new Error('Canceled') });
						}
					}
				},
				deleteComparisonSummary: (sourceBoxId, comparisonBoxId) =>
					this.deleteComparisonSummary(`${sourceBoxId}::${comparisonBoxId}`),
				invalidatePersistence: () => this.sqlPersistenceInvalidationEmitter.fire(),
				refreshConnectionsData: () => this.sendSqlConnectionsData(),
				prefetchSchema: (connectionId, database, boxId, forceRefresh) =>
					this.prefetchSqlSchema(connectionId, database, boxId, forceRefresh),
			},
		});
		this.copilot = new CopilotService(this);
		this.sqlLifecycle.startSession();
	}

	async initializeWebviewPanel(
		panel: vscode.WebviewPanel,
		options?: { registerMessageHandler?: boolean; hideFooterControls?: boolean; initialDocumentLoading?: boolean }
	): Promise<void> {
		this.sqlLifecycle.startSession();
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
				if (id) return this.sqlLifecycle.getConnectionId(id);
				return this.sqlLifecycle.getFirstConnectionId();
			},
			(sectionId: string) => {
				const id = String(sectionId || '').trim();
				return id ? this.sqlLifecycle.getReadyToolOwner(id) : undefined;
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

	private toolStateResponseResolvers = new Map<string, (sections: unknown[]) => void>();
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
				this.rebuildSqlComparisonOwners(sections);
				resolve(sections);
			});
			
			this.postMessage({ type: 'requestToolState', requestId });
		});
	}

	private rebuildSqlComparisonOwners(sections: unknown[]): void {
		this.sqlLifecycle.reconcileComparisonOwners(sections);
	}

	async openEditor(): Promise<void> {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			return;
		}
		this.connection.activate();
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
						if (comparisonBoxId && !pending.sqlConnectionId) {
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
							this.sqlLifecycle.setComparisonOwner(comparisonBoxId, provisionalOwner);
							try {
								await this.sqlWorkbench.assertSqlConnectionAllowed(pending.sqlConnectionId);
								const currentPending = this.pendingComparisonEnsureByRequestId.get(requestId);
								const currentOwner = this.sqlLifecycle.getComparisonOwner(comparisonBoxId);
								if (currentPending !== pending || currentOwner?.comparisonRequestId !== requestId) {
									if (currentPending === pending) {
										this.settlePendingComparisonEnsure(requestId, pending, { error: new Error('Canceled') });
									}
									return;
								}
							} catch (error) {
								const currentPending = this.pendingComparisonEnsureByRequestId.get(requestId);
								if (currentPending !== pending
									|| this.sqlLifecycle.getComparisonOwner(comparisonBoxId)?.comparisonRequestId !== requestId) {
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
					const preflight = this.sqlExecutionBroker.reservePreflight(
						message.boxId, SQL_COPILOT_PREFLIGHT_EXECUTION_ID, message.sqlOwnerToken,
					);
					try { await this.assertSqlOwnerToken(message.boxId, message.sqlOwnerToken); }
					catch {
						if (this.sqlExecutionBroker.clearPreflight(preflight)) {
							this.postMessage({
								type: 'copilotWriteQueryDone', boxId: message.boxId, ok: false,
								message: SQL_COPILOT_OWNER_CHANGED_MESSAGE, ownerToken: String(message.sqlOwnerToken || ''),
							});
						}
						return;
					}
					if (!this.sqlExecutionBroker.clearPreflight(preflight)) return;
					await this.copilot.startCopilotWriteQuery(message, this.sqlConnectionManager, this.sqlSchemaService, this.sqlClient);
					return;
				}
				await this.copilot.startCopilotWriteQuery(message, this.sqlConnectionManager, this.sqlSchemaService, this.sqlClient);
				return;
			case 'cancelCopilotWriteQuery':
				{
					const canceledPreflight = this.sqlExecutionBroker.cancelExpected(
						message.boxId, SQL_COPILOT_PREFLIGHT_EXECUTION_ID, false,
					);
					if (canceledPreflight) {
						const ownerToken = this.sqlLifecycle.getOwnerToken(message.boxId);
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
			case 'sqlSectionOpen':
				this.sqlLifecycle.openSection(message.boxId, message.sectionInstanceId);
				return;
			case 'getSqlDatabases':
				if (!this.sqlLifecycle.adoptTarget(
					message.boxId, message.sectionInstanceId, message.sqlConnectionId, undefined, message.targetGeneration,
				)) return;
				await this.sendSqlDatabases(message.sqlConnectionId, message.boxId, message.sectionInstanceId, false);
				return;
			case 'refreshSqlDatabases':
				if (!this.sqlLifecycle.adoptTarget(
					message.boxId, message.sectionInstanceId, message.sqlConnectionId, undefined, message.targetGeneration,
				)) return;
				await this.sendSqlDatabases(message.sqlConnectionId, message.boxId, message.sectionInstanceId, true);
				return;
			case 'retireSqlTarget':
				this.sqlLifecycle.retireTarget(message.boxId, message.sectionInstanceId, message.targetGeneration);
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
				if (!this.sqlLifecycle.isSectionCurrent(message.boxId, message.sectionInstanceId)) return;
				this.sqlExecutionBroker.cancelExpected(message.boxId, message.executionId, true);
				return;
			case 'prefetchSqlSchema':
				if (!this.sqlLifecycle.adoptTarget(
					message.boxId, message.sectionInstanceId, message.sqlConnectionId, message.database, message.targetGeneration,
				)) return;
				await this.prefetchSqlSchema(message.sqlConnectionId, message.database, message.boxId, !!message.forceRefresh);
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
			case 'sqlComparisonRemoved': {
				const comparisonBoxId = String(message.boxId || '').trim();
				if (!comparisonBoxId) return;
				const sqlOwner = this.sqlLifecycle.getComparisonOwner(comparisonBoxId);
				const owner = sqlOwner ?? this._comparisonOwnerByBoxId.get(comparisonBoxId);
				if (!owner) return;
				if (sqlOwner) {
					this.sqlExecutionBroker.supersede(comparisonBoxId, { notifyWebview: true });
					this.sqlLifecycle.removeComparisonOwner(comparisonBoxId);
				} else {
					this._comparisonOwnerByBoxId.delete(comparisonBoxId);
				}
				this.deleteComparisonSummary(`${owner.sourceBoxId}::${comparisonBoxId}`);
				if (owner.comparisonRequestId) {
					const pending = this.pendingComparisonEnsureByRequestId.get(owner.comparisonRequestId);
					if (pending) {
						this.settlePendingComparisonEnsure(owner.comparisonRequestId, pending, { error: new Error('Canceled') });
					}
				}
				if (!sqlOwner) this.cancelRunningQuery(comparisonBoxId, { notifyWebview: true });
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
				await this.sqlLifecycle.connect(
					message.boxId, message.sectionInstanceId, message.sqlConnectionId, message.database,
					message.targetGeneration, message.expectedOwner,
				);
				return;
			case 'copyAdeLink':
				await this.copyAdeLinkFromWebview(message);
				return;
			case 'shareToClipboard':
				await this.shareToClipboardFromWebview(message);
				return;
			case 'cancelQuery':
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
		const sqlConnectionId = this.sqlLifecycle.getConnectionId(sourceBoxId);
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
	): Promise<void> {
		await this.dispatchSqlResultOwnerAllowed(boxId, expectedOwner, () => {
			if (isCurrent()) this.postMessage(message);
		});
	}

	private async postSqlOwnerMessageProtection(
		boxId: string,
		expectedOwner: SqlResultOwner,
		expectedProtected: boolean,
		message: Record<string, unknown>,
		isCurrent: () => boolean = () => true,
	): Promise<void> {
		await this.sqlLifecycle.dispatchResultOwnerProtection(boxId, expectedOwner, expectedProtected, () => {
			if (isCurrent()) this.postMessage(message);
		});
	}

	private async postSqlConnectionMessageAllowed(
		connection: import('./sqlConnectionManager').SqlConnection,
		message: Record<string, unknown>,
		isCurrent: () => boolean = () => true,
	): Promise<void> {
		const principalFingerprint = await readCurrentSqlSchemaPrincipalFingerprint(this.context, connection);
		if (!principalFingerprint) throw new Error('SQL principal is unavailable before canonical dispatch admission.');
		await this.sqlWorkbench.dispatchSqlOwnerAllowed(
			connection,
			principalFingerprint,
			this.sqlWorkbench.leaveNoTracePolicy.getRevocationGeneration(connection.id),
			() => {
			if (isCurrent()) this.postMessage(message);
			},
		);
	}

	private async postSqlConnectionMessageProtection(
		connection: import('./sqlConnectionManager').SqlConnection,
		expectedProtected: boolean,
		message: Record<string, unknown>,
		isCurrent: () => boolean = () => true,
	): Promise<void> {
		const principalFingerprint = await readCurrentSqlSchemaPrincipalFingerprint(this.context, connection);
		if (!principalFingerprint) throw new Error('SQL principal is unavailable before protected dispatch admission.');
		await this.sqlWorkbench.dispatchSqlOwnerProtection(
			connection,
			principalFingerprint,
			this.sqlWorkbench.leaveNoTracePolicy.getRevocationGeneration(connection.id),
			expectedProtected,
			() => {
				if (isCurrent()) this.postMessage(message);
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

	cancelRunningQuery(boxId: string, options?: { notifyWebview?: boolean }): void {
		const id = String(boxId || '').trim();
		if (!id) {
			return;
		}
		const running = this.queryRuns.get(id);
		if (!running) {
			if (options?.notifyWebview) {
				this.postMessage({ type: 'queryCancelled', boxId: id });
			}
			return;
		}
		this.queryRuns.cancel(id);
		if (options?.notifyWebview) {
			this.postMessage({
				type: 'queryCancelled', boxId: id,
				...(running.executionId ? { executionId: running.executionId } : {}),
			});
		}
	}

	registerRunningQuery(boxId: string, cancel: () => void, runSeq: number, clientActivityId?: string): void {
		this.queryRuns.register(boxId, { cancel, runSeq, clientActivityId });
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
			this.copilot.invalidateSqlConnections(
				[], [...this.sqlLifecycle.listComparisonBoxIds()],
			);
			this.sqlLifecycle.disposeSubscriptions();
			this.sqlPersistenceInvalidationEmitter.dispose();
			this.fileOpenTrace?.mark('queryEditorProvider.dispose.start');
			this.sqlLifecycle.dispose();
			this._comparisonOwnerByBoxId.clear();
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
		await this.connection.saveLastSelection(message.connectionId, message.database);

		const boxId = String(message.boxId || '').trim();
		if (boxId) {
			// If the user runs again in the same box, cancel the previous run.
			this.cancelRunningQuery(boxId);
		}

		const connection = this.connection.findConnection(message.connectionId);
		if (!connection) {
			vscode.window.showErrorMessage('Connection not found');
			return;
		}

		if (!message.database) {
			vscode.window.showErrorMessage('Please select a database');
			return;
		}

		const queryWithMode = this.appendQueryMode(message.query, message.queryMode);
		// Control commands (starting with '.') should not have cache directives prepended
		const isControl = this.isControlCommand(message.query);
		const cacheDirective = isControl ? '' : this.buildCacheDirective(message.cacheEnabled, message.cacheValue, message.cacheUnit);
		const finalQuery = cacheDirective ? `${cacheDirective}\n${queryWithMode}` : queryWithMode;
		const executionQuery = this.normalizeControlCommandForExecution(finalQuery);

		const cancelClientKey = boxId ? `${boxId}::${connection.id}` : connection.id;
		const execution = this.kustoClient.executeQueryCancelable(connection, message.database, executionQuery, cancelClientKey);
		const { promise, cancel, clientActivityId } = execution;
		const runSeq = this.nextQueryRunSeq();
		const isStillActiveRun = () => {
			if (!boxId) {
				return true;
			}
			return this.isRunningQueryCurrent(boxId, cancel, runSeq);
		};
		if (boxId) {
			this.registerRunningQuery(boxId, cancel, runSeq, clientActivityId);
		}
		try {
			const result = await promise;
			if (isStillActiveRun()) {
				const producingAccountPartition = execution.getAccountPartition();
				await this.refreshConnectionsData();
				if (isStillActiveRun()
					&& producingAccountPartition
					&& this.kustoClient.getAccountPartition(connection) === producingAccountPartition) {
					this.postMessage({ type: 'queryResult', result, boxId });
				}
			}
		} catch (error) {
			if ((error as any)?.name === 'QueryCancelledError' || (error as any)?.isCancelled === true) {
				if (isStillActiveRun()) {
					this.postMessage({ type: 'queryCancelled', boxId });
				}
				return;
			}
			if (isStillActiveRun()) {
				this.logQueryExecutionError(error, connection, message.database, boxId, executionQuery);
				const userMessage = this.formatQueryExecutionErrorForUser(error, connection, message.database);
				const clientActivityId = error instanceof QueryExecutionError ? error.clientActivityId : undefined;
				vscode.window.showErrorMessage(userMessage);
				this.postMessage({ type: 'queryError', error: userMessage, boxId, clientActivityId });
			}
		} finally {
			if (boxId) {
				this.unregisterRunningQuery(boxId, cancel, runSeq);
			}
		}
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
				sqlFavorites: this.connection.getSqlFavorites()
					.filter(favorite => !canonicalProtectedIds.has(favorite.connectionId)),
				sqlLeaveNoTrace: [...canonicalProtectedIds],
			});
			return delivered === true;
		});
	}

	private async sendSqlDatabases(
		sqlConnectionId: string,
		boxId: string,
		sectionInstanceId: string,
		forceRefresh: boolean,
	): Promise<void> {
		const ticket = this.sqlLifecycle.beginDatabaseRequest(sqlConnectionId, boxId, sectionInstanceId);
		if (!ticket) return;
		const connection = this.sqlConnectionManager.getConnection(sqlConnectionId);
		const { requestId, targetGeneration: generation } = ticket;
		this.postMessage({ type: 'sqlDatabasesLoading', requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId });
		if (!connection) {
			this.postMessage({ type: 'sqlDatabasesError', requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId, error: 'SQL connection not found.' });
			return;
		}
		if (this.sqlWorkbench.isLeaveNoTraceConnection(connection.id)) {
			const protectedGeneration = this.sqlWorkbench.leaveNoTracePolicy.getRevocationGeneration(connection.id);
			const isCurrentProtectedOwner = () => this.sqlLifecycle.isDatabaseRequestCurrent(ticket)
				&& this.sqlWorkbench.isLeaveNoTraceConnection(connection.id)
				&& this.sqlWorkbench.leaveNoTracePolicy.getRevocationGeneration(connection.id) === protectedGeneration;
			try {
				const databases = (await this.sqlClient.getDatabases(connection)).slice()
					.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
				await this.postSqlConnectionMessageProtection(connection, true, {
					type: 'sqlDatabasesData', requestId, targetGeneration: generation,
					databases, boxId, sectionInstanceId, sqlConnectionId,
				}, isCurrentProtectedOwner);
			} catch (error) {
				if (!isCurrentProtectedOwner()) return;
				const message = error instanceof Error ? error.message : String(error);
				this.output.warn(`[sql-lnt] Isolated database discovery failed: ${sanitizeStsLogText(message)}`);
				this.postMessage({
					type: 'sqlDatabasesError', requestId, targetGeneration: generation,
					boxId, sectionInstanceId, sqlConnectionId, error: message,
				});
			}
			return;
		}
		const targetSignature = sqlDatabaseTargetSignature(connection);
		const startingPrincipalFingerprint = sqlSchemaPrincipalFingerprint(this.context, connection);
		let cacheRequest;
		try {
			cacheRequest = await beginSqlDatabaseCacheRequest(this.context, SQL_DATABASE_CACHE_STORAGE_KEY, connection);
		} catch {
			if (this.sqlLifecycle.isDatabaseRequestCurrent(ticket)) {
				this.postMessage({ type: 'sqlDatabasesError', requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId, error: 'SQL connection is changing. Try again when the update completes.' });
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
				&& this.sqlLifecycle.isDatabaseRequestCurrent(ticket);
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
			this.postMessage({
				type: 'sqlDatabasesError', requestId, targetGeneration: generation,
				boxId, sectionInstanceId, sqlConnectionId,
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		const isCurrentOwner = () => this.sqlLifecycle.isDatabaseSectionOwnerCurrent(ticket);

		const cachedBefore = (await getOwnedSqlDatabaseCacheEntry(this.context, SQL_DATABASE_CACHE_STORAGE_KEY, connection))?.databases ?? [];

		if (!forceRefresh && cachedBefore.length > 0) {
			try {
				await assertCurrentOwner();
				await this.postSqlConnectionMessageAllowed(connection, {
					type: 'sqlDatabasesData', requestId, targetGeneration: generation, databases: cachedBefore, boxId, sectionInstanceId, sqlConnectionId,
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
					type: 'sqlDatabasesData', requestId, targetGeneration: generation, databases: sorted, boxId, sectionInstanceId, sqlConnectionId,
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
						type: 'sqlDatabasesData', requestId, targetGeneration: generation, databases: cachedBefore, boxId, sectionInstanceId, sqlConnectionId,
					}, isCurrentRequestOwner);
				} catch { /* Leave No Trace blocks fallback metadata. */ }
				vscode.window.showWarningMessage(`Failed to refresh SQL database list. Using cached list.`);
				return;
			}

			vscode.window.showErrorMessage(`Failed to load SQL database list: ${errorMessage}`);
			if (isCurrentOwner()) this.postMessage({ type: 'sqlDatabasesError', requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId, error: errorMessage });
		}
	}

	private async prefetchSqlSchema(sqlConnectionId: string, database: string, boxId: string, forceRefresh: boolean): Promise<void> {
		const connection = this.sqlConnectionManager.getConnection(sqlConnectionId);
		const sectionInstanceId = this.sqlLifecycle.getSectionInstanceId(boxId);
		if (!connection || !database || !sectionInstanceId) {
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
				if (!this.sqlLifecycle.isSectionCurrent(boxId, sectionInstanceId)
					|| !this.sqlResultOwnersEqual(this.getSqlResultOwner(boxId), owner)) return;
				this.output.info(`[sql-schema] loaded tables=${tablesCount} columns=${columnsCount} fromCache=${fromCache}`);
				this.postMessage({
					type: 'sqlSchemaData',
					boxId,
					sectionInstanceId,
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
					if (!this.sqlLifecycle.isSectionCurrent(boxId, sectionInstanceId)
						|| !this.sqlResultOwnersEqual(this.getSqlResultOwner(boxId), owner)) return;
					this.output.error(`[sql-schema] error: ${sanitizeStsLogText(msg)}`);
					this.postMessage({
						type: 'sqlSchemaData',
						boxId,
						sectionInstanceId,
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

	public sanitizeSqlLeaveNoTraceState<T extends { sections?: unknown[] }>(state: T): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		this.rebuildSqlComparisonOwners(sections);
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
			const derivedOwner = boxId ? this.sqlLifecycle.getComparisonOwner(boxId) : undefined;
			const persistedSqlSource = String((persistedSource as any)?.type || '') === 'sql' ? persistedSource : undefined;
			const directConnectionHint = String((section as any).connectionIdHint || '').trim();
			const legacySqlComparison = sectionType === 'query' && !persistedSourceBoxId
				&& directConnectionHint.startsWith('sql_');
			if (sectionType !== 'sql' && !derivedOwner && !persistedSqlSource && !legacySqlComparison) return section;
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
			const sqlOwnedSection = sectionType === 'sql' || !!derivedOwner || !!persistedSqlSource || legacySqlComparison;
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

	public sanitizeSqlLeaveNoTraceStateFailClosed<T extends { sections?: unknown[] }>(state: T): T {
		const locallySanitized = this.sanitizeSqlLeaveNoTraceState(state);
		return this.hasSqlOwnedState(locallySanitized)
			? this.stripAllSqlOwnedResults(locallySanitized)
			: locallySanitized;
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
		if (!boxId || !executionId || !this.sqlLifecycle.isSectionCurrent(boxId, message.sectionInstanceId)) return;

		const preflight = this.sqlExecutionBroker.reservePreflight(boxId, executionId, message.ownerToken);
		const protectedExecution = this.sqlWorkbench.isLeaveNoTraceConnection(message.sqlConnectionId);
		let admission: SqlExecutionAdmission | undefined;
		let lease: SqlExecutionLease<ReturnType<SqlQueryClient['executeQueryCancelable']>> | undefined;
		const isStillActiveRun = () => {
			if (lease) return lease.isCurrent();
			if (admission) return this.sqlExecutionBroker.isAdmissionCurrent(admission);
			return this.sqlExecutionBroker.isPreflightCurrent(preflight);
		};
		const postCurrentError = (error: string, ownerToken?: string) => {
			const isCurrent = isStillActiveRun();
			this.sqlExecutionBroker.clearPreflight(preflight);
			if (!isCurrent) return;
			this.postMessage({
				type: 'queryError', error, boxId,
				...(ownerToken ? { ownerToken } : {}),
				executionId,
			});
		};
		let issuedOwner: { token: string; owner: SqlResultOwner } | undefined;
		try {
			issuedOwner = protectedExecution
				? await this.sqlLifecycle.assertOwnerTokenProtection(boxId, message.ownerToken, true)
				: await this.assertSqlOwnerToken(boxId, message.ownerToken);
			if (!isStillActiveRun()
				|| !this.sqlLifecycle.isSectionCurrent(boxId, message.sectionInstanceId)) {
				this.sqlExecutionBroker.clearPreflight(preflight);
				return;
			}
		} catch (error) {
			postCurrentError(error instanceof Error ? error.message : String(error), message.ownerToken);
			return;
		}

		const connection = this.sqlConnectionManager.getConnection(message.sqlConnectionId);
		if (!connection) {
			postCurrentError('SQL connection not found. Please configure a connection.', issuedOwner.token);
			return;
		}

		if (!message.database) {
			postCurrentError('Please select a database.', issuedOwner.token);
			return;
		}

		const resultOwner = issuedOwner.owner;
		if (resultOwner.connectionId !== connection.id || resultOwner.database !== message.database) {
			postCurrentError('SQL section target changed. Run the query again.', issuedOwner.token);
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
				postCurrentError('SQL tool execution owner changed before query dispatch.', issuedOwner.token);
				return;
			}
		}
		const queryWithMode = appendSqlQueryModeFn(message.query, message.queryMode);
		try {
			if (!isStillActiveRun()
				|| !this.sqlLifecycle.isSectionCurrent(boxId, message.sectionInstanceId)) return;
			admission = this.sqlExecutionBroker.promotePreflight(preflight);
			if (!admission) return;
			lease = this.sqlExecutionBroker.start(admission, () =>
				this.sqlClient.executeQueryCancelable(connection, message.database, queryWithMode));
			const result = await lease.execution.promise;
			if (isStillActiveRun()) {
				await this.sendSqlConnectionsData();
				if (protectedExecution) await this.assertSqlResultOwnerProtection(boxId, resultOwner, true);
				else await this.assertSqlResultOwnerAllowed(boxId, resultOwner);
				if (!isStillActiveRun()) return;
				const resultMessage = { type: 'queryResult', result, boxId, ownerToken: issuedOwner.token, executionId };
				if (protectedExecution) {
					await this.postSqlOwnerMessageProtection(boxId, resultOwner, true, resultMessage, isStillActiveRun);
				} else {
					await this.postSqlOwnerMessageAllowed(boxId, resultOwner, resultMessage, isStillActiveRun);
				}
			}
		} catch (error) {
			if ((error as any)?.isCancelled === true || error instanceof SqlQueryCancelledError) {
				if (isStillActiveRun()) {
					try {
						const cancelledMessage = { type: 'queryCancelled', boxId, ownerToken: issuedOwner.token, executionId };
						if (protectedExecution) {
							await this.postSqlOwnerMessageProtection(boxId, resultOwner, true, cancelledMessage, isStillActiveRun);
						} else {
							await this.postSqlOwnerMessageAllowed(boxId, resultOwner, cancelledMessage, isStillActiveRun);
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
					const postError = () => {
						if (!isStillActiveRun()) return;
						if (protectedExecution) {
							this.output.warn('[sql-lnt] Isolated SQL query failed; details were not logged.');
						} else {
							this.output.error([
								`[${new Date().toISOString()}] SQL query execution failed`,
								`  boxId: ${boxId}`,
								`  error: ${sanitizeStsLogText(errorMessage)}`,
							].join('\n'));
						}
						this.postMessage({ type: 'queryError', error: errorMessage, boxId, ownerToken: issuedOwner.token, executionId });
					};
					if (protectedExecution) {
						await this.sqlLifecycle.dispatchResultOwnerProtection(boxId, resultOwner, true, postError);
					} else {
						await this.dispatchSqlResultOwnerAllowed(boxId, resultOwner, postError);
					}
				} catch {
					this.output.warn('[sql] Query failed after owner invalidation; error details suppressed.');
				}
			}
		} finally {
			this.sqlExecutionBroker.clearPreflight(preflight);
			if (admission) this.sqlExecutionBroker.clearPending(admission);
			lease?.release();
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
