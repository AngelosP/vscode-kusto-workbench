import * as vscode from 'vscode';

import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

import { ConnectionManager, KustoConnection } from './connectionManager';
import { KustoQueryClient, QueryExecutionError } from './kustoClient';
import { SqlConnectionManager } from './sqlConnectionManager';
import { SqlQueryClient, SqlQueryCancelledError } from './sqlClient';
import { SqlSchemaService } from './sqlEditorSchema';
import { ensureSts } from './sql/stsDownloader';
import { StsProcessManager, stsProcessManagerSingleton } from './sql/stsProcessManager';
import { StsLanguageService } from './sql/stsLanguageService';
import { clearSqlTokenOverride, setSqlServerAccountMapEntry, setSqlTokenOverride } from './sql/sqlAuthState';
import { KqlLanguageServiceHost } from './kqlLanguageService/host';
import { getQueryEditorHtml } from './queryEditorHtml';
import { toolOrchestrator } from './extension';
import { CopilotService, CopilotServiceHost } from './queryEditorCopilot';
import { openKustoWorkbenchAgentChat } from './copilotChatOpenUtils';
import { ConnectionService, ConnectionServiceHost, getClusterShortName } from './queryEditorConnection';
import { SchemaService, SchemaServiceHost } from './queryEditorSchema';
import {
	getErrorMessage as getErrorMessageFn,
	formatQueryExecutionErrorForUser as formatQueryExecutionErrorForUserFn,
	isControlCommand as isControlCommandFn,
	appendQueryMode as appendQueryModeFn,
	buildCacheDirective as buildCacheDirectiveFn
} from './queryEditorUtils';
import { appendSqlQueryMode as appendSqlQueryModeFn } from './sqlEditorUtils';
import {
	OUTPUT_CHANNEL_NAME,
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
import { EmbeddedTutorialWebviewHost, EmbeddedTutorialWebviewRegistry } from './tutorials/embeddedTutorialWebviewHost';

type RunningQueryEntry = {
	cancel: () => void;
	runSeq: number;
	clientActivityId?: string;
};

const GITHUB_ISSUES_URL = 'https://github.com/AngelosP/vscode-kusto-workbench/issues';


export class QueryEditorProvider implements CopilotServiceHost, ConnectionServiceHost, SchemaServiceHost {
	private static cursorOwnerSequence = 0;

	private panel?: vscode.WebviewPanel;
	private readonly cursorOwnerPrefix = `queryEditor:${++QueryEditorProvider.cursorOwnerSequence}:`;
	readonly kustoClient: KustoQueryClient;
	readonly output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	readonly connection: ConnectionService;
	readonly schema: SchemaService;
	private readonly runningQueriesByBoxId = new Map<string, RunningQueryEntry>();

	// SQL support — lazy-initialized.
	private _sqlConnectionManager?: SqlConnectionManager;
	private _sqlClient?: SqlQueryClient;
	private _sqlSchemaService?: SqlSchemaService;
	private _stsProcessManager?: StsProcessManager;
	private _stsLanguageService?: StsLanguageService;
	private _stsInitPromise?: Promise<StsLanguageService | null>;
	private readonly _closedStsBoxIds = new Set<string>();
	private readonly _latestStsConnectSequenceByBoxId = new Map<string, number>();
	private readonly _stsConnectSequenceByBoxId = new Map<string, number>();

	get sqlConnectionManager(): SqlConnectionManager {
		if (!this._sqlConnectionManager) {
			this._sqlConnectionManager = new SqlConnectionManager(this.context);
		}
		return this._sqlConnectionManager;
	}

	get sqlClient(): SqlQueryClient {
		if (!this._sqlClient) {
			this._sqlClient = new SqlQueryClient(this.sqlConnectionManager, this.context);
		}
		return this._sqlClient;
	}

	get sqlSchemaService(): SqlSchemaService {
		if (!this._sqlSchemaService) {
			this._sqlSchemaService = new SqlSchemaService({
				context: this.context,
				sqlClient: this.sqlClient,
				output: this.output,
				postMessage: (msg) => this.postMessage(msg),
			});
		}
		return this._sqlSchemaService;
	}

	private readonly pendingComparisonEnsureByRequestId = new Map<
		string,
		{
			resolve: (comparisonBoxId: string) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
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
	private queryRunSeq = 0;
	private readonly kqlLanguageHost: KqlLanguageServiceHost;
	private readonly resolvedResourceUriCache = new Map<string, string>();
	private readonly controlCommandSyntaxCache = new Map<string, { timestamp: number; syntax: string; withArgs: string[]; error?: string }>();
	private readonly CONTROL_COMMAND_SYNTAX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
	private readonly copilot: CopilotService;
	private configSubscription?: vscode.Disposable;
	private embeddedTutorialHost?: EmbeddedTutorialWebviewHost;
	private embeddedTutorialRegistration?: vscode.Disposable;

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
			this.output.appendLine(`[${new Date().toISOString()}] Query execution failed`);
			this.output.appendLine(`  cluster: ${cluster}`);
			if (database) {
				this.output.appendLine(`  database: ${database}`);
			}
			if (boxId) {
				this.output.appendLine(`  boxId: ${boxId}`);
			}
			this.output.appendLine('  query:');
			this.output.appendLine(query);
			this.output.appendLine('  error:');
			this.output.appendLine(raw);
			this.output.appendLine('');
		} catch {
			// ignore
		}
	}

	constructor(
		readonly extensionUri: vscode.Uri,
		readonly connectionManager: ConnectionManager,
		readonly context: vscode.ExtensionContext,
		private readonly editorCursorStatusBar?: EditorCursorStatusBar
	) {
		this.kustoClient = new KustoQueryClient(this.context);
		this.kqlLanguageHost = new KqlLanguageServiceHost(this.connectionManager, this.context);
		this.connection = new ConnectionService(this);
		this.schema = new SchemaService(this);
		this.copilot = new CopilotService(this);
	}

	async initializeWebviewPanel(
		panel: vscode.WebviewPanel,
		options?: { registerMessageHandler?: boolean; hideFooterControls?: boolean }
	): Promise<void> {
		this.panel = panel;
		// Do NOT set panel.iconPath here — this method is called for custom editors
		// where VS Code owns the panel. Setting iconPath on a custom-editor panel
		// can crash VS Code's renderer-side editor integration ("Unexpected type"
		// in $setIconPath) and break the entire webview. Standalone panels set
		// their icon in openEditor() instead.
		this.panel.webview.html = await getQueryEditorHtml(this.panel.webview, this.extensionUri, this.context, {
			hideFooterControls: !!options?.hideFooterControls
		});
		this.embeddedTutorialHost = new EmbeddedTutorialWebviewHost(this.panel, this.documentUri);
		this.embeddedTutorialRegistration = EmbeddedTutorialWebviewRegistry.register(this.embeddedTutorialHost);

		const shouldRegisterMessageHandler = options?.registerMessageHandler !== false;
		if (shouldRegisterMessageHandler) {
			// Ensure messages from the webview are handled in all host contexts (including custom editors).
			// openEditor() also wires this up for the standalone panel, but custom editors call initializeWebviewPanel().
			this.panel.webview.onDidReceiveMessage((message: IncomingWebviewMessage) => {
				return this.handleWebviewMessage(message);
			});
		}

		// Connect the tool orchestrator to this webview instance
		this.connectToolOrchestrator();

		// Reconnect the orchestrator when this panel becomes visible again
		// (e.g. user switches from another .kqlx tab back to this one).
		this.panel.onDidChangeViewState(() => {
			if (this.panel?.visible) {
				this.connectToolOrchestrator();
			} else {
				this.clearCursorStatusForProvider();
			}
		});

		this.panel.onDidDispose(() => {
			this.clearCursorStatusForProvider();
			this.cancelAllRunningQueries();
			this.disconnectToolOrchestrator();
			this.embeddedTutorialRegistration?.dispose();
			this.embeddedTutorialRegistration = undefined;
			this.embeddedTutorialHost = undefined;
			this.configSubscription?.dispose();
			this.configSubscription = undefined;
			this.panel = undefined;
		});

		this.sendWorkbenchSettings();
		this.watchWorkbenchSettings();
	}

	// Token returned by the orchestrator's connect(), used to guard disconnect.
	private toolOrchestratorToken: number | undefined;

	/** URI string of the backing document (set by custom editor providers before initializeWebviewPanel). */
	documentUri?: string;

	private connectToolOrchestrator(): void {
		if (!toolOrchestrator) return;

		this.toolOrchestratorToken = toolOrchestrator.connect(
			(message: unknown) => this.postMessage(message),
			async () => {
				const sections = await this.requestSectionsFromWebview();
				return sections as Array<{ id?: string; type: string; [key: string]: unknown }> | undefined;
			},
			async (clusterUrl: string) => this.schema.refreshSchemaForTools(clusterUrl),
			this.documentUri
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
			await this.panel?.webview.postMessage({
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
				resolve(sections);
			});
			
			this.postMessage({ type: 'requestToolState', requestId });
		});
	}

	async openEditor(): Promise<void> {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			return;
		}

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
		try {
			const light = vscode.Uri.joinPath(this.extensionUri, 'media', 'images', 'kusto-file-light.svg');
			const dark = vscode.Uri.joinPath(this.extensionUri, 'media', 'images', 'kusto-file-dark.svg');
			this.panel.iconPath = { light, dark };
		} catch {
			// ignore
		}

		this.panel.webview.html = await getQueryEditorHtml(this.panel.webview, this.extensionUri, this.context);


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

		this.panel.onDidDispose(() => {
			this.clearCursorStatusForProvider();
			this.cancelAllRunningQueries();
			this.disconnectToolOrchestrator();
			this.configSubscription?.dispose();
			this.configSubscription = undefined;
			this.panel = undefined;
		});

		this.sendWorkbenchSettings();
		this.watchWorkbenchSettings();
	}

	public async handleWebviewMessage(message: IncomingWebviewMessage): Promise<void> {
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
						try {
							clearTimeout(pending.timer);
						} catch {
							// ignore
						}
						this.pendingComparisonEnsureByRequestId.delete(requestId);
						pending.resolve(comparisonBoxId);
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
				await this.connection.removeFavorite(message.clusterUrl, message.database);
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
				await this.context.globalState.update(STORAGE_KEYS.caretDocsEnabled, !!message.enabled);
				return;
			case 'setAutoTriggerAutocompleteEnabled':
				await this.context.globalState.update(STORAGE_KEYS.autoTriggerAutocompleteEnabled, !!message.enabled);
				return;
			case 'setCopilotInlineCompletionsEnabled':
				await this.context.globalState.update(STORAGE_KEYS.copilotInlineCompletionsEnabled, !!message.enabled);
				return;
			case 'requestCopilotInlineCompletion':
				await this.copilot.handleCopilotInlineCompletionRequest(message);
				return;
			case 'getDatabases':
				await this.connection.sendDatabases(message.connectionId, message.boxId, false);
				return;
			case 'refreshDatabases':
				await this.connection.sendDatabases(message.connectionId, message.boxId, true);
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
				await this.copilot.startCopilotWriteQuery(message, this.sqlConnectionManager, this.sqlSchemaService, this.sqlClient);
				return;
			case 'cancelCopilotWriteQuery':
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
				await this.sendSqlDatabases(message.sqlConnectionId, message.boxId, false);
				return;
			case 'refreshSqlDatabases':
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
				this.cancelRunningQuery(message.boxId, { notifyWebview: true });
				return;
			case 'prefetchSqlSchema':
				await this.prefetchSqlSchema(message.sqlConnectionId, message.database, message.boxId, !!message.forceRefresh);
				return;
			case 'stsRequest':
				await this.handleStsRequest(message.requestId, message.method, message.params);
				return;
			case 'stsDidOpen':
				this.handleStsDidOpen(message.boxId, message.text);
				return;
			case 'stsDidChange':
				this.handleStsDidChange(message.boxId, message.text);
				return;
			case 'stsDidClose':
				this.handleStsDidClose(message.boxId);
				return;
			case 'stsConnect':
				await this.handleStsConnect(message.boxId, message.sqlConnectionId, message.database);
				return;
			case 'prepareSqlCopilotWriteQuery':
				await this.copilot.prepareCopilotWriteQuery(message as any);
				return;
			case 'startSqlCopilotWriteQuery':
				await this.copilot.startSqlCopilotWriteQuery(message as any, this.sqlConnectionManager, this.sqlSchemaService, this.sqlClient);
				return;
			case 'cancelSqlCopilotWriteQuery':
				this.copilot.cancelCopilotWriteQuery(message.boxId);
				return;
			case 'clearSqlCopilotConversation':
				this.copilot.clearCopilotConversation(message.boxId);
				return;
			case 'removeFromSqlCopilotHistory':
				this.copilot.removeFromCopilotHistory(message.boxId, message.entryId);
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
				await this.schema.handleCrossClusterSchemaRequest(message.clusterName, message.database, message.boxId, message.requestToken);
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
			const clusterShortName = getClusterShortName(String(connection.clusterUrl || '').trim());
			if (!clusterShortName) {
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
				`https://dataexplorer.azure.com/clusters/${encodeURIComponent(clusterShortName)}` +
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
						const clusterShortName = getClusterShortName(String(connection.clusterUrl || '').trim());
						if (clusterShortName) {
							const gz = zlib.gzipSync(Buffer.from(trimmedQuery, 'utf8'));
							const encoded = gz.toString('base64').replace(/=+$/g, '');
							adeUrl =
								`https://dataexplorer.azure.com/clusters/${encodeURIComponent(clusterShortName)}` +
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
			console.error('[kusto] Dashboard export error:', e);
			vscode.window.showErrorMessage('Failed to export dashboard: ' + (e instanceof Error ? e.message : String(e)));
		}
	}

	private async getPbiWorkspacesFromWebview(message: { boxId: string }): Promise<void> {
		try {
			const workspaces = await listFabricWorkspaces();
			this.postMessage({ type: 'pbiWorkspacesResult', boxId: message.boxId, ok: true, workspaces });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error('[kusto] Power BI workspaces error:', e);
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
			console.error('[kusto] Power BI publish error:', e);
			this.postMessage({ type: 'publishToPowerBIResult', boxId: message.boxId, ok: false, error: msg });
		}
	}

	private async checkPbiItemExistsFromWebview(message: { boxId: string; workspaceId: string; reportId: string }): Promise<void> {
		try {
			const exists = await checkFabricItemExists(message.workspaceId, message.reportId);
			this.postMessage({ type: 'pbiItemExistsResult', boxId: message.boxId, exists });
		} catch (e) {
			console.warn('[kusto] PBI item existence check failed:', e);
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
			try {
				const lower = picked.fsPath.toLowerCase();
				if (!lower.endsWith('.csv')) {
					targetUri = vscode.Uri.file(picked.fsPath + '.csv');
				}
			} catch {
				// ignore
			}

			await vscode.workspace.fs.writeFile(targetUri, Buffer.from(csv, 'utf8'));
			vscode.window.showInformationMessage(`Saved results to ${targetUri.fsPath}`);
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
		token: vscode.CancellationToken
	): Promise<string> {
		if (!this.panel) {
			throw new Error('Webview panel is not available');
		}
		const requestId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
		return await new Promise<string>((resolve, reject) => {
			if (token.isCancellationRequested) {
				reject(new Error('Canceled'));
				return;
			}

			const timer = setTimeout(() => {
				try {
					this.pendingComparisonEnsureByRequestId.delete(requestId);
				} catch {
					// ignore
				}
				reject(new Error('Timed out while preparing comparison editor'));
			}, 20000);

			this.pendingComparisonEnsureByRequestId.set(requestId, { resolve, reject, timer });

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
				reject(e instanceof Error ? e : new Error(String(e)));
				return;
			}

			try {
				token.onCancellationRequested(() => {
					const pending = this.pendingComparisonEnsureByRequestId.get(requestId);
					if (!pending) {
						return;
					}
					try {
						clearTimeout(pending.timer);
					} catch {
						// ignore
					}
					this.pendingComparisonEnsureByRequestId.delete(requestId);
					pending.reject(new Error('Canceled'));
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
			this.output.appendLine(`[kql-ls] request failed: ${raw}`);
			this.postMessage({
				type: 'kqlLanguageResponse',
				requestId,
				ok: false,
				error: { message: 'KQL language service failed to process the request.' }
			});
		}
	}


	normalizeClusterUrlKey(url: string): string {
		try {
			const raw = String(url || '').trim();
			if (!raw) {
				return '';
			}
			const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
			const u = new URL(withScheme);
			return (u.origin + u.pathname).replace(/\/+$/g, '').toLowerCase();
		} catch {
			return String(url || '').trim().replace(/\/+$/g, '').toLowerCase();
		}
	}

	// ── Delegating wrappers for ConnectionService methods ──
	// These keep the public API stable for external callers and CopilotServiceHost.

	findConnection(connectionId: string): KustoConnection | undefined {
		return this.connection.findConnection(connectionId);
	}

	public async refreshConnectionsData(): Promise<void> {
		await this.sendConnectionsData();
	}

	public async inferClusterDatabaseForKqlQuery(
		queryText: string
	): Promise<{ clusterUrl: string; database: string } | undefined> {
		return this.connection.inferClusterDatabaseForKqlQuery(queryText);
	}

	private async sendConnectionsData(): Promise<void> {
		const caretDocsEnabledStored = this.context.globalState.get<boolean>(STORAGE_KEYS.caretDocsEnabled);
		const caretDocsEnabled = typeof caretDocsEnabledStored === 'boolean' ? caretDocsEnabledStored : true;
		const caretDocsEnabledUserSet = typeof caretDocsEnabledStored === 'boolean';
		const autoTriggerAutocompleteEnabledStored = this.context.globalState.get<boolean>(STORAGE_KEYS.autoTriggerAutocompleteEnabled);
		const autoTriggerAutocompleteEnabled = typeof autoTriggerAutocompleteEnabledStored === 'boolean' ? autoTriggerAutocompleteEnabledStored : true;
		const autoTriggerAutocompleteEnabledUserSet = typeof autoTriggerAutocompleteEnabledStored === 'boolean';
		const copilotInlineCompletionsEnabledStored = this.context.globalState.get<boolean>(STORAGE_KEYS.copilotInlineCompletionsEnabled);
		const vscodeInlineSuggestEnabled = vscode.workspace.getConfiguration('editor').get<boolean>('inlineSuggest.enabled', true);
		const copilotInlineCompletionsEnabled = typeof copilotInlineCompletionsEnabledStored === 'boolean'
			? copilotInlineCompletionsEnabledStored
			: vscodeInlineSuggestEnabled;
		const copilotInlineCompletionsEnabledUserSet = typeof copilotInlineCompletionsEnabledStored === 'boolean';
		await this.connection.sendConnectionsData({
			caretDocsEnabled,
			caretDocsEnabledUserSet,
			autoTriggerAutocompleteEnabled,
			autoTriggerAutocompleteEnabledUserSet,
			copilotInlineCompletionsEnabled,
			copilotInlineCompletionsEnabledUserSet,
			copilotChatFirstTimeDismissed: !!this.context.globalState.get<boolean>(STORAGE_KEYS.copilotChatFirstTimeDismissed)
		});
	}

	cancelRunningQuery(boxId: string, options?: { notifyWebview?: boolean }): void {
		const id = String(boxId || '').trim();
		if (!id) {
			return;
		}
		const running = this.runningQueriesByBoxId.get(id);
		if (!running) {
			if (options?.notifyWebview) {
				this.postMessage({ type: 'queryCancelled', boxId: id });
			}
			return;
		}
		this.runningQueriesByBoxId.delete(id);
		try {
			running.cancel();
		} catch {
			// ignore
		}
		if (options?.notifyWebview) {
			this.postMessage({ type: 'queryCancelled', boxId: id });
		}
	}

	registerRunningQuery(boxId: string, cancel: () => void, runSeq: number, clientActivityId?: string): void {
		this.runningQueriesByBoxId.set(boxId, { cancel, runSeq, clientActivityId });
	}

	unregisterRunningQuery(boxId: string, cancel: () => void, runSeq: number): void {
		const id = String(boxId || '').trim();
		if (!id) {
			return;
		}
		const current = this.runningQueriesByBoxId.get(id);
		if (current?.cancel === cancel && current.runSeq === runSeq) {
			this.runningQueriesByBoxId.delete(id);
		}
	}

	nextQueryRunSeq(): number {
		return ++this.queryRunSeq;
	}

	deleteComparisonSummary(key: string): void {
		this.latestComparisonSummaryByKey.delete(key);
	}

	revealPanel(): void {
		this.panel?.reveal(vscode.ViewColumn.One);
	}


	private cancelAllRunningQueries(): void {
		for (const [, running] of this.runningQueriesByBoxId) {
			try {
				running.cancel();
			} catch {
				// ignore
			}
		}
		this.runningQueriesByBoxId.clear();
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

	postMessage(message: unknown): void {
		void this.panel?.webview.postMessage(message);
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

		const cancelClientKey = boxId ? `${boxId}::${connection.id}` : connection.id;
		const { promise, cancel, clientActivityId } = this.kustoClient.executeQueryCancelable(connection, message.database, finalQuery, cancelClientKey);
		const runSeq = ++this.queryRunSeq;
		const isStillActiveRun = () => {
			if (!boxId) {
				return true;
			}
			const current = this.runningQueriesByBoxId.get(boxId);
			return !!current && current.cancel === cancel && current.runSeq === runSeq;
		};
		if (boxId) {
			this.runningQueriesByBoxId.set(boxId, { cancel, runSeq, clientActivityId });
		}
		try {
			const result = await promise;
			if (isStillActiveRun()) {
				this.postMessage({ type: 'queryResult', result, boxId });
			}
		} catch (error) {
			if ((error as any)?.name === 'QueryCancelledError' || (error as any)?.isCancelled === true) {
				if (isStillActiveRun()) {
					this.postMessage({ type: 'queryCancelled', boxId });
				}
				return;
			}
			if (isStillActiveRun()) {
				this.logQueryExecutionError(error, connection, message.database, boxId, finalQuery);
				const userMessage = this.formatQueryExecutionErrorForUser(error, connection, message.database);
				const clientActivityId = error instanceof QueryExecutionError ? error.clientActivityId : undefined;
				vscode.window.showErrorMessage(userMessage);
				this.postMessage({ type: 'queryError', error: userMessage, boxId, clientActivityId });
			}
		} finally {
			if (boxId) {
				// Only clear if this is still the active run for the box.
				const current = this.runningQueriesByBoxId.get(boxId);
				if (current?.cancel === cancel && current.runSeq === runSeq) {
					this.runningQueriesByBoxId.delete(boxId);
				}
			}
		}
	}

	// ── SQL connection helpers ───────────────────────────────────────────────

	private async sendSqlConnectionsData(): Promise<void> {
		const connections = this.sqlConnectionManager.getConnections();
		const lastSqlConnectionId = this.context.globalState.get<string>('sql.lastConnectionId') || '';
		const lastSqlDatabase = this.context.globalState.get<string>('sql.lastDatabase') || '';
		const cachedSqlDatabases = this.context.globalState.get<Record<string, string[]>>('sql.cachedDatabases') || {};
		this.postMessage({
			type: 'sqlConnectionsData',
			connections,
			lastConnectionId: lastSqlConnectionId,
			lastDatabase: lastSqlDatabase,
			cachedDatabases: cachedSqlDatabases,
			sqlFavorites: this.connection.getSqlFavorites(),
		});
	}

	private async sendSqlDatabases(sqlConnectionId: string, boxId: string, forceRefresh: boolean): Promise<void> {
		const connection = this.sqlConnectionManager.getConnection(sqlConnectionId);
		if (!connection) {
			this.postMessage({ type: 'sqlDatabasesError', boxId, sqlConnectionId, error: 'SQL connection not found.' });
			return;
		}

		const serverKey = String(connection.serverUrl || '').trim().toLowerCase();
		const cached = this.context.globalState.get<Record<string, string[]>>('sql.cachedDatabases') || {};
		const cachedBefore = (cached[serverKey] ?? []).filter(Boolean);

		if (!forceRefresh && cachedBefore.length > 0) {
			this.postMessage({ type: 'sqlDatabasesData', databases: cachedBefore, boxId, sqlConnectionId });
			return;
		}

		try {
			const databases = await this.sqlClient.getDatabases(connection);
			const sorted = databases.slice().sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
			if (serverKey) {
				cached[serverKey] = sorted;
				await this.context.globalState.update('sql.cachedDatabases', cached);
			}
			this.postMessage({ type: 'sqlDatabasesData', databases: sorted, boxId, sqlConnectionId });
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`[${new Date().toISOString()}] Failed to load SQL databases`);
			this.output.appendLine(`  server: ${connection.serverUrl}`);
			this.output.appendLine(`  error: ${errorMessage}`);
			this.output.appendLine('');

			if (cachedBefore.length > 0) {
				this.postMessage({ type: 'sqlDatabasesData', databases: cachedBefore, boxId, sqlConnectionId });
				vscode.window.showWarningMessage(`Failed to refresh SQL database list. Using cached list.`);
				return;
			}

			vscode.window.showErrorMessage(`Failed to load SQL database list: ${errorMessage}`);
			this.postMessage({ type: 'sqlDatabasesError', boxId, sqlConnectionId, error: errorMessage });
		}
	}

	private async prefetchSqlSchema(sqlConnectionId: string, database: string, boxId: string, forceRefresh: boolean): Promise<void> {
		const connection = this.sqlConnectionManager.getConnection(sqlConnectionId);
		if (!connection || !database) {
			return;
		}
		try {
			this.output.appendLine(`[sql-schema] request server=${connection.serverUrl} db=${database} forceRefresh=${forceRefresh}`);
			const { schema, fromCache } = await this.sqlSchemaService.getSchema(connection, database, forceRefresh);
			const tablesCount = schema.tables?.length ?? 0;
			let columnsCount = 0;
			if (schema.columnsByTable) {
				for (const tbl of Object.keys(schema.columnsByTable)) {
					columnsCount += Object.keys(schema.columnsByTable[tbl] || {}).length;
				}
			}
			this.output.appendLine(`[sql-schema] loaded db=${database} tables=${tablesCount} columns=${columnsCount} fromCache=${fromCache}`);
			this.postMessage({
				type: 'sqlSchemaData',
				boxId,
				sqlConnectionId,
				database,
				serverUrl: connection.serverUrl,
				schema,
				schemaMeta: { fromCache, tablesCount, columnsCount },
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`[sql-schema] error db=${database}: ${msg}`);
			this.postMessage({
				type: 'sqlSchemaData',
				boxId,
				sqlConnectionId,
				database,
				serverUrl: connection.serverUrl,
				schema: null,
				schemaMeta: { error: true, errorMessage: msg },
			});
		}
	}

	// ── STS (SqlToolsService) integration ──────────────────────────────────

	private async ensureStsLanguageService(): Promise<StsLanguageService | null> {
		if (this._stsLanguageService) return this._stsLanguageService;
		if (this._stsInitPromise) return this._stsInitPromise;

		this._stsInitPromise = (async () => {
			try {
				// Reuse an existing process manager if another editor already started STS.
				let processManager = stsProcessManagerSingleton.get();
				if (!processManager) {
					const globalStoragePath = this.context.globalStorageUri.fsPath;
					const binaryPath = await ensureSts(globalStoragePath, this.output);
					if (!binaryPath) {
						this.output.appendLine('[sts] STS binary not available — SQL IntelliSense disabled');
						return null;
					}

					const logPath = this.context.logUri.fsPath;
					processManager = new StsProcessManager(binaryPath, logPath, this.output);
					stsProcessManagerSingleton.set(processManager);
					await processManager.start();
				} else {
					await processManager.ready;
				}

				this._stsProcessManager = processManager;
				const languageService = new StsLanguageService(processManager, this.sqlConnectionManager, this.context, this.output);
				this._stsLanguageService = languageService;

				// Forward diagnostics to webview
				languageService.onDiagnostics((event) => {
					this.postMessage({ type: 'stsDiagnostics', boxId: event.boxId, markers: event.markers } as any);
				});

				return languageService;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.output.appendLine(`[sts] Init failed: ${msg}`);
				return null;
			}
		})();

		return this._stsInitPromise;
	}

	private async handleStsRequest(requestId: string, method: string, params: { boxId: string; line: number; column: number }): Promise<void> {
		this.output.appendLine(`[sts-diag] handleStsRequest method=${method} boxId=${params.boxId} L${params.line}:${params.column}`);
		const svc = await this.ensureStsLanguageService();
		if (!svc) {
			this.output.appendLine(`[sts-diag] handleStsRequest → svc=null, returning null`);
			this.postMessage({ type: 'stsResponse', requestId, result: null } as any);
			return;
		}
		try {
			let result: unknown = null;
			switch (method) {
				case 'textDocument/completion':
					result = await svc.getCompletions(params.boxId, params.line, params.column);
					break;
				case 'textDocument/hover':
					result = await svc.getHover(params.boxId, params.line, params.column);
					break;
				case 'textDocument/signatureHelp':
					result = await svc.getSignatureHelp(params.boxId, params.line, params.column);
					break;
				default:
					this.output.appendLine(`[sts] Unknown method: ${method}`);
			}
			this.postMessage({ type: 'stsResponse', requestId, result } as any);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.output.appendLine(`[sts] Request error (${method}): ${msg}`);
			this.postMessage({ type: 'stsResponse', requestId, result: null } as any);
		}
	}

	private handleStsDidOpen(boxId: string, text: string): void {
		const id = String(boxId || '').trim();
		if (!id) return;
		this._closedStsBoxIds.delete(id);
		this.output.appendLine(`[sts-diag] handleStsDidOpen boxId=${id} textLen=${text.length}`);
		this.ensureStsLanguageService().then(svc => {
			if (svc && !this._closedStsBoxIds.has(id)) svc.openDocument(id, text);
		}).catch(() => { /* ignore */ });
	}

	private handleStsDidChange(boxId: string, text: string): void {
		const id = String(boxId || '').trim();
		if (id && !this._closedStsBoxIds.has(id) && this._stsLanguageService) {
			this._stsLanguageService.changeDocument(id, text);
		}
	}

	private handleStsDidClose(boxId: string): void {
		const id = String(boxId || '').trim();
		if (!id) return;
		this._closedStsBoxIds.add(id);
		this._latestStsConnectSequenceByBoxId.delete(id);
		this.output.appendLine(`[sts-diag] handleStsDidClose boxId=${id}`);
		if (this._stsLanguageService) {
			this._stsLanguageService.closeDocument(id);
		}
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
			this.output.appendLine(`[sts-diag] handleStsConnect → stale early failure suppressed boxId=${boxId}: ${message}`);
			return;
		}
		this.output.appendLine(`[sts-diag] handleStsConnect → FAILED boxId=${boxId}: ${message}`);
		this.postMessage({ type: 'stsConnectionState', boxId, state: 'error', error: message } as any);
	}

	private async handleStsConnect(boxId: string, sqlConnectionId: string, database: string): Promise<void> {
		const id = String(boxId || '').trim();
		if (!id || this._closedStsBoxIds.has(id)) {
			this.output.appendLine(`[sts-diag] handleStsConnect skipped closed boxId=${id || '(none)'}`);
			return;
		}
		const connectSequence = this._nextStsConnectSequence(id);
		this.output.appendLine(`[sts-diag] handleStsConnect boxId=${id} connId=${sqlConnectionId} db=${database}`);
		const svc = await this.ensureStsLanguageService();
		if (!svc) {
			this.output.appendLine(`[sts-diag] handleStsConnect → svc=null`);
			this._postCurrentStsConnectError(id, connectSequence, 'SQL Tools Service unavailable');
			return;
		}
		if (!this._isCurrentStsConnect(id, connectSequence)) {
			this.output.appendLine(`[sts-diag] handleStsConnect skipped closed boxId=${id}`);
			return;
		}
		const connection = this.sqlConnectionManager.getConnection(sqlConnectionId);
		if (!connection) {
			this.output.appendLine(`[sts-diag] handleStsConnect → connection not found: ${sqlConnectionId}`);
			this._postCurrentStsConnectError(id, connectSequence, `SQL connection not found: ${sqlConnectionId}`);
			return;
		}
		this.output.appendLine(`[sts-diag] handleStsConnect → connecting to ${connection.serverUrl}/${database} auth=${connection.authType}`);
		try {
			await svc.connectDocument(id, connection, database);
			if (!this._isCurrentStsConnect(id, connectSequence)) {
				this.output.appendLine(`[sts-diag] handleStsConnect → stale success suppressed boxId=${id}`);
				return;
			}
			this.output.appendLine(`[sts-diag] handleStsConnect → SUCCESS boxId=${id}`);
			this.postMessage({ type: 'stsConnectionState', boxId: id, state: 'ready' } as any);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!this._isCurrentStsConnect(id, connectSequence)) {
				this.output.appendLine(`[sts-diag] handleStsConnect → stale failure suppressed boxId=${id}: ${msg}`);
				return;
			}
			this.output.appendLine(`[sts-diag] handleStsConnect → FAILED boxId=${id}: ${msg}`);
			this.postMessage({ type: 'stsConnectionState', boxId: id, state: 'error', error: msg } as any);
		}
	}

	/** Shut down the STS process. Called from extension deactivate(). */
	async stopSts(): Promise<void> {
		if (this._stsProcessManager) {
			await this._stsProcessManager.stop();
			this._stsProcessManager = undefined;
			this._stsLanguageService = undefined;
			this._stsInitPromise = undefined;
		}
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
		if (boxId) {
			this.cancelRunningQuery(boxId);
		}

		const connection = this.sqlConnectionManager.getConnection(message.sqlConnectionId);
		if (!connection) {
			this.postMessage({ type: 'queryError', error: 'SQL connection not found. Please configure a connection.', boxId });
			return;
		}

		if (!message.database) {
			this.postMessage({ type: 'queryError', error: 'Please select a database.', boxId });
			return;
		}

		const cancelClientKey = boxId ? `${boxId}::${connection.id}` : connection.id;
		const queryWithMode = appendSqlQueryModeFn(message.query, message.queryMode);
		const { promise, cancel } = this.sqlClient.executeQueryCancelable(connection, message.database, queryWithMode, cancelClientKey);
		const runSeq = ++this.queryRunSeq;
		const isStillActiveRun = () => {
			if (!boxId) { return true; }
			const current = this.runningQueriesByBoxId.get(boxId);
			return !!current && current.cancel === cancel && current.runSeq === runSeq;
		};
		if (boxId) {
			this.runningQueriesByBoxId.set(boxId, { cancel, runSeq });
		}
		try {
			const result = await promise;
			if (isStillActiveRun()) {
				this.postMessage({ type: 'queryResult', result, boxId });
			}
		} catch (error) {
			if ((error as any)?.isCancelled === true || error instanceof SqlQueryCancelledError) {
				if (isStillActiveRun()) {
					this.postMessage({ type: 'queryCancelled', boxId });
				}
				return;
			}
			if (isStillActiveRun()) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				this.output.appendLine(`[${new Date().toISOString()}] SQL query execution failed`);
				this.output.appendLine(`  server: ${connection.serverUrl}`);
				this.output.appendLine(`  database: ${message.database}`);
				this.output.appendLine(`  boxId: ${boxId}`);
				this.output.appendLine(`  error: ${errorMessage}`);
				this.output.appendLine('');
				// Error is displayed inline in the SQL section — no notification popup
				// (avoids stealing keyboard focus from the Monaco editor).
				this.postMessage({ type: 'queryError', error: errorMessage, boxId });
			}
		} finally {
			if (boxId) {
				const current = this.runningQueriesByBoxId.get(boxId);
				if (current?.cancel === cancel && current.runSeq === runSeq) {
					this.runningQueriesByBoxId.delete(boxId);
				}
			}
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

	// HTML rendering moved to src/queryEditorHtml.ts
}
