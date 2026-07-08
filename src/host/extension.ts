// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { setTestIsolateKustoConnections, testIsolateKustoConnections } from './queryEditorConnection';
import { CachedValuesViewerV2 } from './cachedValuesViewer';
import { ConnectionManagerViewerV2 } from './connectionManagerViewer';
import { SqlConnectionManager } from './sqlConnectionManager';
import { SqlQueryClient } from './sqlClient';
import { KqlCompatEditorProvider } from './kqlCompatEditorProvider';
import { KqlxEditorProvider } from './kqlxEditorProvider';
import { MdCompatEditorProvider } from './mdCompatEditorProvider';
import { SqlCompatEditorProvider } from './sqlCompatEditorProvider';
import { KqlDiagnosticSeverity } from './kqlLanguageService/protocol';
import { KqlLanguageServiceHost } from './kqlLanguageService/host';
import { recordTextEditorSelection } from './selectionTracker';
import { registerKustoWorkbenchTools, KustoWorkbenchToolOrchestrator } from './kustoWorkbenchTools';
import { KustoQueryClient } from './kustoClient';
import { registerRemoteFileOpener } from './remoteFileOpener';
import { openKustoWorkbenchAgentChat } from './copilotChatOpenUtils';
import { exportSkillCommand, checkAndUpdateSkillFiles } from './skillExport';
import { TutorialCatalogService } from './tutorials/tutorialCatalogService';
import { isKustoTutorialTriggerDocument, isKustoTutorialTriggerUri, TutorialNotificationService } from './tutorials/tutorialNotificationService';
import { registerTutorialNotificationTriggers } from './tutorials/tutorialNotificationTriggers';
import { TutorialSubscriptionService } from './tutorials/tutorialSubscriptionService';
import { TutorialViewerPanel, resolveTutorialsEnabledConfigurationTarget } from './tutorials/tutorialViewerPanel';
import { resetDidYouKnowDevelopmentState } from './tutorials/tutorialDevelopmentState';
import { EmbeddedTutorialWebviewRegistry } from './tutorials/embeddedTutorialWebviewHost';
import type { TutorialViewerMode } from '../shared/tutorials/tutorialCatalog';
import { EditorCursorStatusBar } from './editorCursorStatusBar';
import { createEmptyKqlxFile, stringifyKqlxFile, parseKqlxText, type KqlxFileV1 } from './kqlxFormat';
import { kustoClusterKey } from '../shared/kustoClusterUrls';
import { STORAGE_KEYS } from './queryEditorTypes';
import { SCHEMA_CACHE_VERSION, schemaCacheKey, writeCachedSchemaToDisk } from './schemaCache';

import { stsProcessManagerSingleton } from './sql/stsProcessManager';

type TestOpenFileSummary = NonNullable<Awaited<ReturnType<KustoWorkbenchToolOrchestrator['listSections']>>['openFiles']>[number];

// Export the tool orchestrator instance so other modules can access it
export let toolOrchestrator: KustoWorkbenchToolOrchestrator | undefined;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	void vscode.commands.executeCommand('setContext', 'kustoWorkbench.devMode', context.extensionMode !== vscode.ExtensionMode.Production);

	// Configure editor associations for .kql and .csl files based on settings
	const updateEditorAssociations = async (): Promise<void> => {
		try {
			const config = vscode.workspace.getConfiguration('kustoWorkbench');
			const openKqlFiles = config.get<boolean>('openKqlFiles', true);
			const openCslFiles = config.get<boolean>('openCslFiles', true);
			const openMdFiles = config.get<boolean>('openMdFiles', false);
			const openSqlFiles = config.get<boolean>('openSqlFiles', false);

			const workbenchConfig = vscode.workspace.getConfiguration('workbench');
			const currentAssociations = workbenchConfig.get<Record<string, string>>('editorAssociations') || {};

			// Create a copy to modify
			const newAssociations = { ...currentAssociations };
			let changed = false;

			// Handle .kql files
			const kqlAssociation = openKqlFiles ? KqlCompatEditorProvider.viewType : 'default';
			if (newAssociations['*.kql'] !== kqlAssociation) {
				newAssociations['*.kql'] = kqlAssociation;
				changed = true;
			}

			// Handle .csl files
			const cslAssociation = openCslFiles ? KqlCompatEditorProvider.viewType : 'default';
			if (newAssociations['*.csl'] !== cslAssociation) {
				newAssociations['*.csl'] = cslAssociation;
				changed = true;
			}

			// Handle .md files
			const mdAssociation = openMdFiles ? MdCompatEditorProvider.viewType : 'default';
			if (newAssociations['*.md'] !== mdAssociation) {
				newAssociations['*.md'] = mdAssociation;
				changed = true;
			}

			// Handle .sql files
			const sqlAssociation = openSqlFiles ? SqlCompatEditorProvider.viewType : 'default';
			if (newAssociations['*.sql'] !== sqlAssociation) {
				newAssociations['*.sql'] = sqlAssociation;
				changed = true;
			}

			if (changed) {
				await workbenchConfig.update('editorAssociations', newAssociations, vscode.ConfigurationTarget.Global);
			}
		} catch (err) {
			// Non-fatal: avoid breaking activation if we can't update associations
			console.error('[Kusto Workbench] Failed to update editor associations:', err);
		}
	};

	// Update associations on activation and when settings change
	void updateEditorAssociations();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('kustoWorkbench.openKqlFiles') || e.affectsConfiguration('kustoWorkbench.openCslFiles') || e.affectsConfiguration('kustoWorkbench.openMdFiles') || e.affectsConfiguration('kustoWorkbench.openSqlFiles')) {
				void updateEditorAssociations();
			}
		})
	);

	// Initialize status bar integration and connection manager
	const editorCursorStatusBar = new EditorCursorStatusBar();
	context.subscriptions.push(editorCursorStatusBar);
	if (context.extensionMode !== vscode.ExtensionMode.Production) {
		context.subscriptions.push(
			vscode.commands.registerCommand('kustoWorkbench.test.getCursorStatusBar', () => editorCursorStatusBar.getSnapshot()),
			vscode.commands.registerCommand('kustoWorkbench.test.setIsolatedKustoConnections', (enabled: boolean = true) => {
				setTestIsolateKustoConnections(!!enabled);
			}),
			vscode.commands.registerCommand('kustoWorkbench.test.clearIsolatedKustoConnections', () => {
				setTestIsolateKustoConnections(false);
			})
		);
	}

	const connectionManager = new ConnectionManager(context);
	if (context.extensionMode !== vscode.ExtensionMode.Production) {
		const testPrefix = 'E2E Identity Checklist';
		const textDiagnosticsTestName = 'E2E Text Diagnostics Seed';
		const textDiagnosticsTestCluster = 'https://kw-diagnostics-seed.kusto.windows.net';
		const textDiagnosticsTestDatabase = 'SeedDb';
		const testClusters = [
			'https://identity-prod.kusto.windows.net',
			'https://identity-nonprod.kusto.windows.net',
			'https://identity-foo.kusto.windows.net',
			'https://identity-foobar.kusto.windows.net',
			'https://identityadx.westus.kusto.windows.net',
		];
		const testClusterKeys = new Set(testClusters.map(cluster => kustoClusterKey(cluster)).filter(Boolean));
		const isTestCluster = (value: unknown): boolean => testClusterKeys.has(kustoClusterKey(String(value || '')));
		const cleanupIdentityChecklistState = async (): Promise<void> => {
			for (const connection of connectionManager.getConnections()) {
				if (String(connection.name || '').startsWith(testPrefix) || isTestCluster(connection.clusterUrl)) {
					await connectionManager.removeConnection(connection.id);
				}
			}
			const favoritesRaw = context.globalState.get<unknown>(STORAGE_KEYS.favorites);
			if (Array.isArray(favoritesRaw)) {
				await context.globalState.update(STORAGE_KEYS.favorites, favoritesRaw.filter((favorite: any) =>
					!String(favorite?.name || '').startsWith(testPrefix) && !isTestCluster(favorite?.clusterUrl)
				));
			}
			const cachedRaw = context.globalState.get<Record<string, string[]> | undefined>(STORAGE_KEYS.cachedDatabases) || {};
			const cachedNext: Record<string, string[]> = {};
			for (const [key, value] of Object.entries(cachedRaw)) {
				if (!isTestCluster(key)) {
					cachedNext[key] = value;
				}
			}
			await context.globalState.update(STORAGE_KEYS.cachedDatabases, cachedNext);
			for (const cluster of testClusters) {
				await connectionManager.removeLeaveNoTrace(cluster);
			}
		};

		context.subscriptions.push(
			vscode.commands.registerCommand('kustoWorkbench.test.cleanupKustoIdentityChecklist', cleanupIdentityChecklistState),
			vscode.commands.registerCommand('kustoWorkbench.test.seedKustoTextDiagnosticsState', async () => {
				for (const connection of connectionManager.getConnections()) {
					if (String(connection.name || '') === textDiagnosticsTestName || kustoClusterKey(connection.clusterUrl) === kustoClusterKey(textDiagnosticsTestCluster)) {
						await connectionManager.removeConnection(connection.id);
					}
				}
				const seedConnection = await connectionManager.addConnection({
					name: textDiagnosticsTestName,
					clusterUrl: textDiagnosticsTestCluster,
					database: textDiagnosticsTestDatabase
				});
				await context.globalState.update(STORAGE_KEYS.lastConnectionId, seedConnection.id);
				await context.globalState.update(STORAGE_KEYS.lastDatabase, textDiagnosticsTestDatabase);
				await context.globalState.update('kusto.fileConnectionCache', {});
				const cachedDatabases = context.globalState.get<Record<string, string[]> | undefined>(STORAGE_KEYS.cachedDatabases) || {};
				cachedDatabases[kustoClusterKey(textDiagnosticsTestCluster)] = [textDiagnosticsTestDatabase];
				await context.globalState.update(STORAGE_KEYS.cachedDatabases, cachedDatabases);
				const schema = {
					tables: ['KnownOnly'],
					columnTypesByTable: {
						KnownOnly: {
							Timestamp: 'datetime',
							Value: 'long'
						}
					}
				};
				const cacheKey = schemaCacheKey(textDiagnosticsTestCluster, textDiagnosticsTestDatabase);
				await writeCachedSchemaToDisk(context.globalStorageUri, cacheKey, {
					schema,
					timestamp: Date.now(),
					version: SCHEMA_CACHE_VERSION,
					clusterUrl: textDiagnosticsTestCluster,
					database: textDiagnosticsTestDatabase
				});
				return { connectionId: seedConnection.id, clusterUrl: textDiagnosticsTestCluster, database: textDiagnosticsTestDatabase };
			}),
			vscode.commands.registerCommand('kustoWorkbench.test.seedKustoIdentityChecklist', async () => {
				await cleanupIdentityChecklistState();
				const seeds = [
					{ name: `${testPrefix} Prod`, clusterUrl: 'https://identity-prod.kusto.windows.net', database: 'ChecklistDb' },
					{ name: `${testPrefix} Nonprod`, clusterUrl: 'https://identity-nonprod.kusto.windows.net', database: 'ChecklistDb' },
					{ name: `${testPrefix} Foo`, clusterUrl: 'https://identity-foo.kusto.windows.net', database: 'ChecklistDb' },
					{ name: `${testPrefix} Foobar`, clusterUrl: 'https://identity-foobar.kusto.windows.net', database: 'ChecklistDb' },
					{ name: `${testPrefix} Regional`, clusterUrl: 'https://identityadx.westus.kusto.windows.net', database: 'ChecklistDb' },
				];
				const added = [] as Array<{ id: string; name: string; clusterUrl: string; database?: string }>;
				for (const seed of seeds) {
					added.push(await connectionManager.addConnection(seed));
				}
				const cached = context.globalState.get<Record<string, string[]> | undefined>(STORAGE_KEYS.cachedDatabases) || {};
				cached[kustoClusterKey('identityadx.westus')] = ['ChecklistDb', 'CachedOnlyDb'];
				await context.globalState.update(STORAGE_KEYS.cachedDatabases, cached);
				const favoritesRaw = context.globalState.get<unknown>(STORAGE_KEYS.favorites);
				const favorites = Array.isArray(favoritesRaw) ? favoritesRaw.filter((favorite: any) =>
					!String(favorite?.name || '').startsWith(testPrefix) && !isTestCluster(favorite?.clusterUrl)
				) : [];
				favorites.push({ name: `${testPrefix} Regional Favorite`, clusterUrl: 'https://identityadx.westus.kusto.windows.net', database: 'ChecklistDb' });
				await context.globalState.update(STORAGE_KEYS.favorites, favorites);
				await connectionManager.addLeaveNoTrace('https://identityadx.westus.kusto.windows.net');
				return { added, cachedKey: kustoClusterKey('identityadx.westus') };
			}),
			vscode.commands.registerCommand('kustoWorkbench.test.assertClipboardContains', async (expected: string) => {
				const text = await vscode.env.clipboard.readText();
				const needle = String(expected || '');
				if (!needle || !text.includes(needle)) {
					throw new Error(`Clipboard did not contain ${JSON.stringify(needle)}. Clipboard=${JSON.stringify(text.slice(0, 500))}`);
				}
				return text;
			})
		);
	}
	const kqlLanguageHost = new KqlLanguageServiceHost(connectionManager, context);
	const tutorialCatalogService = new TutorialCatalogService(context);
	const tutorialSubscriptionService = new TutorialSubscriptionService(context);
	const openTutorials = async (selectedCategoryId?: string, preferredMode: TutorialViewerMode = 'standard'): Promise<void> => {
		TutorialViewerPanel.open(context, context.extensionUri, tutorialCatalogService, tutorialSubscriptionService, { selectedCategoryId, preferredMode });
	};
	const openTutorialPopup = async (selectedCategoryId?: string, preferredMode: TutorialViewerMode = 'standard', triggerDocument?: vscode.TextDocument): Promise<boolean> => {
		if (triggerDocument) {
			return await EmbeddedTutorialWebviewRegistry.showForDocument(triggerDocument.uri.toString(), {
				context,
				catalogService: tutorialCatalogService,
				subscriptionService: tutorialSubscriptionService,
			}, { selectedCategoryId, preferredMode });
		}
		await openTutorials(selectedCategoryId, preferredMode);
		return true;
	};
	const tutorialNotificationService = new TutorialNotificationService(context, tutorialCatalogService, tutorialSubscriptionService, openTutorialPopup);
	registerTutorialNotificationTriggers(context, tutorialNotificationService);
	if (context.extensionMode !== vscode.ExtensionMode.Production) {
		const getActiveTutorialTriggerDocument = async (): Promise<vscode.TextDocument | undefined> => {
			const activeDocument = vscode.window.activeTextEditor?.document;
			const activeTabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
			const activeTabUri = activeTabInput instanceof vscode.TabInputText || activeTabInput instanceof vscode.TabInputCustom
				? activeTabInput.uri
				: undefined;
			const activeTabDocument = activeTabUri !== undefined && isKustoTutorialTriggerUri(activeTabUri)
				? await vscode.workspace.openTextDocument(activeTabUri)
				: undefined;
			if (activeDocument !== undefined && isKustoTutorialTriggerDocument(activeDocument)) {
				return activeDocument;
			}
			if (activeTabDocument !== undefined) {
				return activeTabDocument;
			}
			return vscode.workspace.textDocuments.find(doc => isKustoTutorialTriggerDocument(doc));
		};

		const resetDidYouKnowState = async (options?: { openIfKustoFileOpen?: boolean; silent?: boolean }) => {
			const configuration = vscode.workspace.getConfiguration('kustoWorkbench');
			const configurationTarget = resolveTutorialsEnabledConfigurationTarget(
				configuration.inspect<boolean>('didYouKnow.enabled'),
				(vscode.workspace.workspaceFolders?.length ?? 0) > 0,
			);
			await configuration.update('didYouKnow.enabled', true, configurationTarget);

			const result = await resetDidYouKnowDevelopmentState(context, tutorialCatalogService);
			tutorialNotificationService.reloadPendingPopups();

			const triggerDocument = await getActiveTutorialTriggerDocument();
			const openedCompact = options?.openIfKustoFileOpen === true && triggerDocument !== undefined;
			if (openedCompact) {
				await tutorialNotificationService.checkOnKustoFileOpen(triggerDocument);
			}

			if (options?.silent !== true) {
				void vscode.window.showInformationMessage(
					`Reset Did you know state: ${result.contentCount} unread item${result.contentCount === 1 ? '' : 's'} across ${result.categoryCount} categor${result.categoryCount === 1 ? 'y' : 'ies'}.`,
				);
			}
			return { ...result, openedCompact };
		};

		context.subscriptions.push(
			vscode.commands.registerCommand('kustoWorkbench.test.resetDidYouKnowState', resetDidYouKnowState),
			vscode.commands.registerCommand('kustoWorkbench.test.openEmbeddedDidYouKnow', async () => {
				const triggerDocument = await getActiveTutorialTriggerDocument();
				return triggerDocument !== undefined
					? await openTutorialPopup(undefined, 'compact', triggerDocument)
					: false;
			}),
		);
	}

	// Shared SQL lazy-init (used by both editor provider and connection manager viewer)
	let _sqlConnectionManager: SqlConnectionManager | undefined;
	let _sqlClient: SqlQueryClient | undefined;
	const getSqlConnectionManager = (): SqlConnectionManager => {
		if (!_sqlConnectionManager) { _sqlConnectionManager = new SqlConnectionManager(context); }
		return _sqlConnectionManager;
	};
	const getSqlClient = (): SqlQueryClient => {
		if (!_sqlClient) { _sqlClient = new SqlQueryClient(getSqlConnectionManager(), context); }
		return _sqlClient;
	};

	// Register Kusto Workbench tools for VS Code Copilot Chat integration
	const toolKustoClient = new KustoQueryClient(context);
	toolOrchestrator = registerKustoWorkbenchTools(context, connectionManager, getSqlConnectionManager, toolKustoClient);
	context.subscriptions.push(
		vscode.workspace.onDidRenameFiles((event) => {
			void toolOrchestrator?.handleFilesRenamed(event.files).catch(() => {
				// Ignore rename bookkeeping failures; VS Code remains the source of truth.
			});
		})
	);
	if (context.extensionMode !== vscode.ExtensionMode.Production) {
		context.subscriptions.push(
			vscode.commands.registerCommand('kustoWorkbench.test.runOpenFileTargetingScenario', async (modeOrWorkspacePath?: string, workspacePath?: string) => {
				if (!toolOrchestrator) {
					throw new Error('Kusto Workbench tools are not initialized.');
				}
				const mode = modeOrWorkspacePath === 'real-editors' || modeOrWorkspacePath === 'real-editors-forced-failure'
					? modeOrWorkspacePath
					: 'synthetic';
				const workspacePathCandidate = mode === 'real-editors' || mode === 'real-editors-forced-failure' ? workspacePath : modeOrWorkspacePath;
				const providedWorkspacePath = typeof workspacePathCandidate === 'string' && workspacePathCandidate.trim() && !workspacePathCandidate.includes('$')
					? vscode.Uri.file(workspacePathCandidate.trim())
					: undefined;
				const root = providedWorkspacePath ?? vscode.workspace.workspaceFolders?.[0]?.uri ?? context.extensionUri;

				if (mode === 'real-editors' || mode === 'real-editors-forced-failure') {
					const resultDir = vscode.Uri.joinPath(root, 'tests', 'vscode-extension-tester', 'runs', 'default');
					await vscode.workspace.fs.createDirectory(resultDir);
					const scenarioDir = vscode.Uri.joinPath(resultDir, 'agent-open-file-targeting-real');
					await vscode.workspace.fs.createDirectory(scenarioDir);
					const resultUri = vscode.Uri.joinPath(resultDir, 'agent-open-file-targeting-real-result.json');
					try { await vscode.workspace.fs.delete(resultUri); } catch { /* ignore stale cleanup */ }
					const writeRealResult = async (result: Record<string, unknown>) => {
						const markers = Object.entries(result).filter(([, value]) => value === true).map(([key]) => `${key}:true`);
						await vscode.workspace.fs.writeFile(resultUri, new TextEncoder().encode(JSON.stringify({ ...result, markers }, null, 2)));
					};

					const buildFile = (query: string, name: string): KqlxFileV1 => {
						const file = createEmptyKqlxFile();
						file.state.sections.push({ id: 'query_1', type: 'query', name, expanded: true, query });
						return file;
					};

					const activeUri = vscode.Uri.joinPath(scenarioDir, 'active-real.kqlx');
					const targetUri = vscode.Uri.joinPath(scenarioDir, 'target-real.kqlx');
					const activeInitialText = stringifyKqlxFile(buildFile('print "active original"', 'Active real'));
					const targetInitialText = stringifyKqlxFile(buildFile('print "target original"', 'Target real'));
					await vscode.workspace.fs.writeFile(activeUri, new TextEncoder().encode(activeInitialText));
					await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(targetInitialText));

					const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
					await vscode.commands.executeCommand('workbench.action.closeAllEditors');
					await vscode.commands.executeCommand('vscode.openWith', activeUri, KqlxEditorProvider.viewType, { viewColumn: vscode.ViewColumn.One, preview: false, preserveFocus: false });
					await vscode.commands.executeCommand('vscode.openWith', targetUri, KqlxEditorProvider.viewType, { viewColumn: vscode.ViewColumn.Beside, preview: false, preserveFocus: false });
					await vscode.commands.executeCommand('vscode.openWith', activeUri, KqlxEditorProvider.viewType, { viewColumn: vscode.ViewColumn.One, preview: false, preserveFocus: false });
					let forcedFailureTriggered = false;
					try {
						let listed: Awaited<ReturnType<typeof toolOrchestrator.listSections>> | undefined;
						let activeFile: TestOpenFileSummary | undefined;
						let targetFile: TestOpenFileSummary | undefined;
						for (let attempt = 0; attempt < 40; attempt++) {
							listed = await toolOrchestrator.listSections();
							const openFiles = Array.isArray(listed.openFiles) ? listed.openFiles : [];
							activeFile = openFiles.find(file => file.fileName === 'active-real.kqlx');
							targetFile = openFiles.find(file => file.fileName === 'target-real.kqlx');
							if (activeFile?.isLiveWorkbench && activeFile.isActive && Array.isArray(activeFile.sections) && activeFile.sections.length > 0
								&& targetFile?.isLiveWorkbench && targetFile.isActive === false && Array.isArray(targetFile.sections) && targetFile.sections.length > 0
								&& targetFile.openFileId && activeFile.openFileId && targetFile.openFileId !== activeFile.openFileId) {
								break;
							}
							await delay(250);
						}
						if (!activeFile?.isLiveWorkbench || !activeFile.isActive || !Array.isArray(activeFile.sections) || activeFile.sections.length === 0) {
							throw new Error('Active real editor did not become live and active.');
						}
						if (!targetFile?.isLiveWorkbench || targetFile.isActive !== false || !Array.isArray(targetFile.sections) || targetFile.sections.length === 0 || !targetFile.openFileId) {
							throw new Error('Target real editor did not become live and non-active.');
						}
						const activeQuerySectionId = activeFile.sections.find(section => section.type === 'query')?.id ?? activeFile.sections[0]?.id;
						const targetQuerySectionId = targetFile.sections.find(section => section.type === 'query')?.id ?? targetFile.sections[0]?.id;
						if (!activeQuerySectionId) {
							throw new Error('Active real editor did not report a query section ID.');
						}
						if (!targetQuerySectionId) {
							await writeRealResult({
								scenario: 'real-editors',
								error: 'Target real editor did not report a query section ID.',
								activeFile,
								targetFile,
								listed,
							});
							throw new Error('Target real editor did not report a query section ID.');
						}

						let configureResult: { success: boolean; resultPreview?: string } | undefined;
						let configureError = '';
						for (let attempt = 0; attempt < 20; attempt++) {
							try {
								configureResult = await toolOrchestrator.configureQuerySection({ sectionId: targetQuerySectionId, query: 'print "target updated"', openFileId: targetFile.openFileId });
								if (configureResult.success) {
									break;
								}
								configureError = 'configureQuerySection returned success=false';
							} catch (err) {
								configureError = err instanceof Error ? err.message : String(err);
							}
							await delay(250);
						}
						if (!configureResult?.success) {
							await writeRealResult({
								scenario: 'real-editors',
								error: 'Target configureQuerySection did not report success.',
								configureError,
								targetQuerySectionId,
								activeFile,
								targetFile,
								listed,
							});
							throw new Error('Target configureQuerySection did not report success.');
						}

						const parseQuery = (text: string): string => {
							const parsed = parseKqlxText(text, { allowedKinds: ['kqlx'], defaultKind: 'kqlx' });
							if (!parsed.ok) return '';
							const section = parsed.file.state.sections.find(sec => (sec as any).id === 'query_1') as { query?: string } | undefined;
							return section?.query ?? '';
						};

						let targetDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === targetUri.toString());
						for (let attempt = 0; attempt < 20; attempt++) {
							targetDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === targetUri.toString());
							if (targetDocument && parseQuery(targetDocument.getText()) === 'print "target updated"') {
								break;
							}
							await delay(250);
						}
						if (!targetDocument || parseQuery(targetDocument.getText()) !== 'print "target updated"') {
							await writeRealResult({
								scenario: 'real-editors',
								error: 'Target document did not receive the updated query in memory.',
								configureResult,
								targetQuerySectionId,
								targetDocumentText: targetDocument?.getText() ?? '',
								activeFile,
								targetFile,
								listed,
							});
							throw new Error('Target document did not receive the updated query in memory.');
						}
						const activeDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === activeUri.toString());
						const activeMemoryQuery = activeDocument ? parseQuery(activeDocument.getText()) : '';
						const activeMemoryUnchanged = activeMemoryQuery === 'print "active original"' && !String(activeDocument?.getText() ?? '').includes('target updated');
						if (mode === 'real-editors-forced-failure') {
							forcedFailureTriggered = true;
							return { scenario: 'real-editors-forced-failure', forcedFailureTriggered };
						}
						await targetDocument.save();

						let activeDiskText = '';
						let targetDiskText = '';
						for (let attempt = 0; attempt < 20; attempt++) {
							activeDiskText = new TextDecoder().decode(await vscode.workspace.fs.readFile(activeUri));
							targetDiskText = new TextDecoder().decode(await vscode.workspace.fs.readFile(targetUri));
							if (parseQuery(targetDiskText) === 'print "target updated"') {
								break;
							}
							await delay(250);
						}
						const activeQuery = parseQuery(activeDiskText);
						const targetQuery = parseQuery(targetDiskText);
						const result = {
							scenario: 'real-editors',
							realEditorsOpened: !!activeFile && !!targetFile,
							nonActiveOpenFileIdTargeted: targetQuery === 'print "target updated"',
							activeFileMemoryUnchanged: activeMemoryUnchanged,
							activeFileDiskUnchanged: activeQuery === 'print "active original"' && !activeDiskText.includes('target updated'),
							targetFileDiskChanged: targetQuery === 'print "target updated"' && !targetDiskText.includes('target original'),
							duplicateSectionIdsVerified: activeQuerySectionId === targetQuerySectionId,
							activeQuerySectionId,
							targetQuerySectionId,
							activeFilePath: activeUri.fsPath,
							targetFilePath: targetUri.fsPath,
						};
						await writeRealResult(result);
						return result;
					} finally {
						let cleanupSavedDirtyDocs = false;
						for (const uri of [activeUri, targetUri]) {
							try {
								const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
								if (document?.isDirty) {
									await document.save();
									cleanupSavedDirtyDocs = true;
								}
							} catch {
								// Best-effort cleanup; closeAllEditors still runs below.
							}
						}
						await vscode.commands.executeCommand('workbench.action.closeAllEditors');
						if (mode === 'real-editors-forced-failure') {
							let cleanupClosedEditors = false;
							let cleanupNoLiveEditors = false;
							let cleanupOpenFiles: Array<{ fileName?: string }> = [];
							for (let attempt = 0; attempt < 20; attempt++) {
								const cleanupListed = await toolOrchestrator.listSections().catch(() => ({ openFiles: [] }));
								cleanupOpenFiles = Array.isArray(cleanupListed.openFiles) ? cleanupListed.openFiles : [];
								const tempFiles = cleanupOpenFiles.filter(file => file.fileName === 'active-real.kqlx' || file.fileName === 'target-real.kqlx');
								cleanupClosedEditors = tempFiles.length === 0;
								cleanupNoLiveEditors = !tempFiles.some(file => (file as { isLiveWorkbench?: boolean }).isLiveWorkbench === true);
								if (cleanupNoLiveEditors) {
									break;
								}
								await delay(250);
							}
							const cleanupResult = {
								scenario: 'real-editors-forced-failure',
								forcedFailureTriggered,
								cleanupSavedDirtyDocs,
								cleanupClosedEditors,
								cleanupNoLiveEditors,
								cleanupOpenFiles,
							};
							await writeRealResult(cleanupResult);
							return cleanupResult;
						}
					}
				}

				const activeUri = vscode.Uri.joinPath(root, 'agent-open-file-targeting-active.kqlx');
				const targetUri = vscode.Uri.joinPath(root, 'agent-open-file-targeting-target.kqlx');
				const activeMessages: unknown[] = [];
				const targetMessages: unknown[] = [];
				const activeToken = toolOrchestrator.connect(
					(message) => activeMessages.push(message),
					async () => [{ id: 'query_1', type: 'query', name: 'Active file' }],
					async () => ({ schemas: [] }),
					activeUri.toString()
				);
				const targetToken = toolOrchestrator.connect(
					(message) => targetMessages.push(message),
					async () => [{ id: 'query_1', type: 'query', name: 'Target file' }],
					async () => ({ schemas: [] }),
					targetUri.toString()
				);
				try {
					const listed = await toolOrchestrator.listSections();
					const openFiles = Array.isArray(listed.openFiles) ? listed.openFiles : [];
					const targetFile = openFiles.find(file => file.fileName === 'agent-open-file-targeting-target.kqlx');
					if (!targetFile?.openFileId) {
						throw new Error('Target file openFileId was not returned by listSections.');
					}
					const configurePromise = toolOrchestrator.configureQuerySection({
						sectionId: 'query_1',
						query: 'print "explicit target"',
						openFileId: targetFile.openFileId,
					});
					const posted = targetMessages[0] as { requestId?: string; input?: { query?: string } } | undefined;
					if (!posted?.requestId) {
						throw new Error('No tool message was posted to the explicit target file.');
					}
					toolOrchestrator.handleWebviewResponse(posted.requestId, { success: true });
					await configurePromise;
					const result = {
						explicitTargetUpdatedNonActive: targetMessages.length === 1 && posted.input?.query === 'print "explicit target"',
						activeFilePreserved: activeMessages.length === 0,
						openFilesIncludedBoth: openFiles.some(file => file.fileName === 'agent-open-file-targeting-active.kqlx')
							&& openFiles.some(file => file.fileName === 'agent-open-file-targeting-target.kqlx'),
					};
					const markers = Object.entries(result).filter(([, value]) => value).map(([key]) => `${key}:true`);
					const resultDir = vscode.Uri.joinPath(root, 'tests', 'vscode-extension-tester', 'runs', 'default');
					await vscode.workspace.fs.createDirectory(resultDir);
					const resultUri = vscode.Uri.joinPath(resultDir, 'agent-open-file-targeting-result.json');
					await vscode.workspace.fs.writeFile(resultUri, new TextEncoder().encode(JSON.stringify({ ...result, markers }, null, 2)));
					return result;
				} finally {
					toolOrchestrator.disconnectIfOwner(activeToken);
					toolOrchestrator.disconnectIfOwner(targetToken);
				}
			}),
			vscode.commands.registerCommand('kustoWorkbench.test.runRenameOpenFilesScenario', async () => {
				if (!toolOrchestrator) {
					throw new Error('Kusto Workbench tools are not initialized.');
				}
				const orchestrator = toolOrchestrator;

				const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? context.extensionUri;
				const resultDir = vscode.Uri.joinPath(root, 'tests', 'vscode-extension-tester', 'runs', 'default');
				await vscode.workspace.fs.createDirectory(resultDir);
				const scenarioDir = vscode.Uri.joinPath(resultDir, 'rename-open-files');
				try { await vscode.workspace.fs.delete(scenarioDir, { recursive: true, useTrash: false }); } catch { /* ignore stale cleanup */ }
				await vscode.workspace.fs.createDirectory(scenarioDir);
				const resultUri = vscode.Uri.joinPath(resultDir, 'rename-open-files-result.json');
				try { await vscode.workspace.fs.delete(resultUri); } catch { /* ignore stale cleanup */ }

				const writeResult = async (result: Record<string, unknown>) => {
					const markers = Object.entries(result).filter(([, value]) => value === true).map(([key]) => `${key}:true`);
					await vscode.workspace.fs.writeFile(resultUri, new TextEncoder().encode(JSON.stringify({ ...result, markers }, null, 2)));
				};

				const buildFile = (query: string, name: string): KqlxFileV1 => {
					const file = createEmptyKqlxFile();
					file.state.sections.push({ id: 'query_1', type: 'query', name, expanded: true, query });
					return file;
				};

				const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
				const fileNameEquals = (actual: string | undefined, expected: string): boolean => String(actual || '') === expected;
				const tabSnapshot = () => {
					const tabs: Array<{ label: string; uri: string; fileName: string }> = [];
					try {
						for (const group of vscode.window.tabGroups.all || []) {
							for (const tab of group.tabs || []) {
								const input = tab.input as { uri?: vscode.Uri } | undefined;
								const uri = input?.uri;
								tabs.push({
									label: String(tab.label || ''),
									uri: uri?.toString() ?? '',
									fileName: uri?.scheme === 'file' ? uri.fsPath.split(/[\\/]/).pop() || '' : uri?.path.split('/').pop() || '',
								});
							}
						}
					} catch {
						// ignore
					}
					return tabs;
				};

				const waitForRenameState = async (expectedName: string, oldName: string) => {
					let listed: Awaited<ReturnType<typeof orchestrator.listSections>> | undefined;
					let tabs: ReturnType<typeof tabSnapshot> = [];
					for (let attempt = 0; attempt < 50; attempt++) {
						listed = await orchestrator.listSections().catch(() => undefined);
						tabs = tabSnapshot();
						const openFiles = Array.isArray(listed?.openFiles) ? listed.openFiles : [];
						const expectedFile = openFiles.find(file => fileNameEquals(file.fileName, expectedName));
						const oldOpenFile = openFiles.find(file => fileNameEquals(file.fileName, oldName));
						const oldTab = tabs.find(tab => tab.fileName === oldName || tab.label === oldName);
						if (expectedFile?.isLiveWorkbench && Array.isArray(expectedFile.sections) && expectedFile.sections.length > 0 && !oldOpenFile && !oldTab) {
							return { listed, tabs, expectedFile };
						}
						await delay(250);
					}
					throw new Error(`Rename state did not settle for ${oldName} -> ${expectedName}: ${JSON.stringify({ listed, tabs }, null, 2)}`);
				};

				const pinnedOldName = 'GetBlahBlah.kqlx';
				const pinnedNewName = 'getBlahBlah.kqlx';
				const previewOldName = 'PreviewRenameSource.kqlx';
				const previewNewName = 'PreviewRenameTarget.kqlx';
				const pinnedOldUri = vscode.Uri.joinPath(scenarioDir, pinnedOldName);
				const pinnedNewUri = vscode.Uri.joinPath(scenarioDir, pinnedNewName);
				const previewOldUri = vscode.Uri.joinPath(scenarioDir, previewOldName);
				const previewNewUri = vscode.Uri.joinPath(scenarioDir, previewNewName);

				await vscode.workspace.fs.writeFile(pinnedOldUri, new TextEncoder().encode(stringifyKqlxFile(buildFile('print "pinned before rename"', 'Pinned case rename'))));
				await vscode.workspace.fs.writeFile(previewOldUri, new TextEncoder().encode(stringifyKqlxFile(buildFile('print "preview before rename"', 'Preview rename'))));

				try {
					await vscode.commands.executeCommand('workbench.action.closeAllEditors');

					await vscode.commands.executeCommand('vscode.openWith', pinnedOldUri, KqlxEditorProvider.viewType, { viewColumn: vscode.ViewColumn.One, preview: false, preserveFocus: false });
					await waitForRenameState(pinnedOldName, '__no_old_pinned__');
					await vscode.workspace.fs.rename(pinnedOldUri, pinnedNewUri, { overwrite: false });
					await orchestrator.handleFilesRenamed([{ oldUri: pinnedOldUri, newUri: pinnedNewUri }]);
					const pinnedAfter = await waitForRenameState(pinnedNewName, pinnedOldName);

					await vscode.commands.executeCommand('vscode.openWith', previewOldUri, KqlxEditorProvider.viewType, { viewColumn: vscode.ViewColumn.Active, preview: true, preserveFocus: false });
					await waitForRenameState(previewOldName, '__no_old_preview__');
					await vscode.workspace.fs.rename(previewOldUri, previewNewUri, { overwrite: false });
					await orchestrator.handleFilesRenamed([{ oldUri: previewOldUri, newUri: previewNewUri }]);
					const previewAfter = await waitForRenameState(previewNewName, previewOldName);

					const pinnedOpenFiles = Array.isArray(pinnedAfter.listed?.openFiles) ? pinnedAfter.listed.openFiles : [];
					const previewOpenFiles = Array.isArray(previewAfter.listed?.openFiles) ? previewAfter.listed.openFiles : [];
					const pinnedTabs = pinnedAfter.tabs;
					const previewTabs = previewAfter.tabs;
					const result = {
						scenario: 'rename-open-files',
						pinnedCaseRenameNewVisible: pinnedOpenFiles.some(file => file.fileName === pinnedNewName),
						pinnedCaseRenameOldAbsent: !pinnedOpenFiles.some(file => file.fileName === pinnedOldName) && !pinnedTabs.some(tab => tab.fileName === pinnedOldName || tab.label === pinnedOldName),
						pinnedCaseRenameLive: pinnedOpenFiles.some(file => file.fileName === pinnedNewName && file.isLiveWorkbench === true && Array.isArray(file.sections) && file.sections.length > 0),
						previewRenameNewVisible: previewOpenFiles.some(file => file.fileName === previewNewName),
						previewRenameOldAbsent: !previewOpenFiles.some(file => file.fileName === previewOldName) && !previewTabs.some(tab => tab.fileName === previewOldName || tab.label === previewOldName),
						previewRenameLive: previewOpenFiles.some(file => file.fileName === previewNewName && file.isLiveWorkbench === true && Array.isArray(file.sections) && file.sections.length > 0),
						noDuplicateOldAndNew: !previewOpenFiles.some(file => file.fileName === previewOldName) && !pinnedOpenFiles.some(file => file.fileName === pinnedOldName),
						pinnedOpenFiles,
						previewOpenFiles,
						pinnedTabs,
						previewTabs,
					};
					await writeResult(result);
					await vscode.commands.executeCommand('notifications.clearAll');
					return result;
				} catch (err) {
					const result = {
						scenario: 'rename-open-files',
						error: err instanceof Error ? err.message : String(err),
						openFiles: await orchestrator.listSections().catch(error => ({ error: error instanceof Error ? error.message : String(error) })),
						tabs: tabSnapshot(),
					};
					await writeResult(result);
					throw err;
				}
			})
		);
	}

	// Best-effort diagnostics for plain text editors ("Reopen With" → Text Editor)
	// Uses last selected connection/database from the notebook experience.
	const kqlDiagnostics = vscode.languages.createDiagnosticCollection('kusto-workbench');
	context.subscriptions.push(kqlDiagnostics);
	const diagTimers = new Map<string, NodeJS.Timeout>();
	const isKqlDoc = (doc: vscode.TextDocument): boolean => {
		const lang = String(doc.languageId || '').toLowerCase();
		if (lang === 'kql') {
			return true;
		}
		const p = String(doc.uri?.path || '').toLowerCase();
		return p.endsWith('.kql') || p.endsWith('.csl');
	};
	const scheduleDiagnostics = (doc: vscode.TextDocument, delayMs: number = 250): void => {
		if (!isKqlDoc(doc)) {
			return;
		}
		const key = doc.uri.toString();
		const existing = diagTimers.get(key);
		if (existing) {
			clearTimeout(existing);
		}
		diagTimers.set(
			key,
			setTimeout(async () => {
				try {
					const result = await kqlLanguageHost.getDiagnostics({ text: doc.getText(), uri: doc.uri.toString() });
					const vsDiagnostics = (result.diagnostics || []).map((d) => {
						const range = new vscode.Range(
							d.range.start.line,
							d.range.start.character,
							d.range.end.line,
							d.range.end.character
						);
						const severity =
							d.severity === KqlDiagnosticSeverity.Error
							? vscode.DiagnosticSeverity.Error
							: d.severity === KqlDiagnosticSeverity.Warning
								? vscode.DiagnosticSeverity.Warning
								: d.severity === KqlDiagnosticSeverity.Information
									? vscode.DiagnosticSeverity.Information
									: vscode.DiagnosticSeverity.Hint;
						const diag = new vscode.Diagnostic(range, d.message, severity);
						if (d.code) {
							diag.code = d.code;
						}
						if (d.source) {
							diag.source = d.source;
						}
						return diag;
					});
					kqlDiagnostics.set(doc.uri, vsDiagnostics);
				} catch {
					// Non-fatal: avoid spamming users with background errors.
					// But DO clear stale diagnostics so Problems reflects the current best-effort state.
					try {
						kqlDiagnostics.set(doc.uri, []);
					} catch {
						// ignore
					}
				}
			}, delayMs)
		);
	};

	// Allow other parts of the extension (e.g. webviews) to request an immediate refresh.
	context.subscriptions.push(
		vscode.commands.registerCommand('kusto.refreshTextEditorDiagnostics', async () => {
			try {
				for (const doc of vscode.workspace.textDocuments || []) {
					scheduleDiagnostics(doc, 0);
				}
			} catch {
				// ignore
			}
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument((doc) => {
			scheduleDiagnostics(doc, 0);
			// Best-effort: capture any selection that VS Code may apply during open
			// (e.g., clicking a result in the global Search view).
			try {
				const uri = doc?.uri?.toString();
				if (!uri) {
					return;
				}
				const snapshot = () => {
					try {
						const active = vscode.window.activeTextEditor;
						if (active && active.document?.uri?.toString() === uri) {
							recordTextEditorSelection(active);
							return;
						}
						const visible = (vscode.window.visibleTextEditors || []).find((e) => e.document?.uri?.toString() === uri);
						if (visible) {
							recordTextEditorSelection(visible);
						}
					} catch {
						// ignore
					}
				};
				snapshot();
				setTimeout(snapshot, 50);
				setTimeout(snapshot, 150);
				setTimeout(snapshot, 350);
			} catch {
				// ignore
			}
		})
	);
	context.subscriptions.push(
		vscode.window.onDidChangeTextEditorSelection((e) => {
			try {
				recordTextEditorSelection(e.textEditor);
			} catch {
				// ignore
			}
		})
	);
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			try {
				if (editor) {
					recordTextEditorSelection(editor);
				}
			} catch {
				// ignore
			}
		})
	);
	context.subscriptions.push(
		vscode.window.onDidChangeVisibleTextEditors((editors) => {
			try {
				for (const editor of editors || []) {
					try {
						recordTextEditorSelection(editor);
					} catch {
						// ignore
					}
				}
			} catch {
				// ignore
			}
		})
	);
	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument((e) => scheduleDiagnostics(e.document, 250))
	);
	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument((doc) => {
			try {
				kqlDiagnostics.delete(doc.uri);
			} catch {
				// ignore
			}
			const key = doc.uri.toString();
			const t = diagTimers.get(key);
			if (t) {
				clearTimeout(t);
			}
			diagTimers.delete(key);
		})
	);
	// Also run for already-open documents on activation.
	for (const doc of vscode.workspace.textDocuments) {
		scheduleDiagnostics(doc, 0);
	}

	// Register .kqlx custom editor
	context.subscriptions.push(KqlxEditorProvider.register(context, context.extensionUri, connectionManager, editorCursorStatusBar));
	// Register .kql/.csl compatibility custom editor
	context.subscriptions.push(KqlCompatEditorProvider.register(context, context.extensionUri, connectionManager, editorCursorStatusBar));
	// Register .md compatibility custom editor (upgrade to .mdx for multi-section)
	context.subscriptions.push(MdCompatEditorProvider.register(context, context.extensionUri, connectionManager, editorCursorStatusBar));
	// Register .sql compatibility custom editor (upgrade to .sqlx for multi-section)
	context.subscriptions.push(SqlCompatEditorProvider.register(context, context.extensionUri, connectionManager, editorCursorStatusBar));
	if (context.extensionMode !== vscode.ExtensionMode.Production) {
		const resolveDevMarkdownUri = (relativePath = 'CHANGELOG.md'): vscode.Uri => {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? context.extensionUri;
			const segments = String(relativePath || 'CHANGELOG.md').split(/[\\/]+/).filter(Boolean);
			return vscode.Uri.joinPath(root, ...segments);
		};
		context.subscriptions.push(
			vscode.commands.registerCommand('kustoWorkbench.test.openMdCompatFile', async (relativePath = 'CHANGELOG.md') => {
				const uri = resolveDevMarkdownUri(relativePath);
				await vscode.commands.executeCommand('vscode.openWith', uri, MdCompatEditorProvider.viewType, {
					viewColumn: vscode.ViewColumn.Active,
					preserveFocus: false,
				});
				return uri.toString();
			}),
			vscode.commands.registerCommand('kustoWorkbench.test.openMdCompatFileViaAssociation', async (relativePath = 'CHANGELOG.md') => {
				const uri = resolveDevMarkdownUri(relativePath);
				const workbenchConfig = vscode.workspace.getConfiguration('workbench');
				const original = workbenchConfig.get<Record<string, string>>('editorAssociations') || {};
				const next = { ...original, '*.md': MdCompatEditorProvider.viewType };
				try {
					await workbenchConfig.update('editorAssociations', next, vscode.ConfigurationTarget.Global);
					await vscode.commands.executeCommand('vscode.open', uri);
					return uri.toString();
				} finally {
					try {
						await workbenchConfig.update('editorAssociations', original, vscode.ConfigurationTarget.Global);
					} catch {
						// ignore cleanup failures in tests
					}
				}
			})
		);
	}

	// Register URI handler and "Open Remote File" command
	registerRemoteFileOpener(context);

	// Register Activity Bar quick access view
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('kustoWorkbench.quickAccess', {
			resolveWebviewView(webviewView: vscode.WebviewView) {
				webviewView.webview.options = {
					enableScripts: true,
					localResourceRoots: [context.extensionUri]
				};
				const queryEditorIconDarkUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'images', 'kusto-file-dark.svg'));
				const queryEditorIconLightUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'images', 'kusto-file-light.svg'));
				webviewView.webview.html = `<!DOCTYPE html>
<html>
<head>
	<link rel="stylesheet" href="https://unpkg.com/@vscode/codicons@0.0.35/dist/codicon.css">
	<style>
		* { box-sizing: border-box; }
		body { 
			padding: 12px; 
			font-family: var(--vscode-font-family); 
			color: var(--vscode-foreground); 
			margin: 0;
		}
		
		.section {
			margin-bottom: 20px;
		}
		.section:last-child { margin-bottom: 0; }
		
		.section-header {
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.5px;
			color: var(--vscode-descriptionForeground);
			margin-bottom: 10px;
			padding-bottom: 6px;
			border-bottom: 1px solid var(--vscode-widget-border);
		}
		
		.card {
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-widget-border);
			border-radius: 6px;
			padding: 12px;
			margin-bottom: 10px;
		}
		.card:last-child { margin-bottom: 0; }
		.card.featured {
			border-color: var(--vscode-focusBorder);
			background: color-mix(in srgb, var(--vscode-focusBorder) 8%, var(--vscode-editor-background));
		}
		
		.card-title {
			font-size: 13px;
			font-weight: 600;
			margin-bottom: 6px;
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.card-title .codicon {
			font-size: 16px;
			opacity: 0.85;
		}
		.card-title-icon {
			width: 16px;
			height: 16px;
			flex: 0 0 16px;
			opacity: 0.85;
		}
		.theme-icon-light { display: none; }
		body.vscode-light .theme-icon-dark,
		body.vscode-high-contrast-light .theme-icon-dark { display: none; }
		body.vscode-light .theme-icon-light,
		body.vscode-high-contrast-light .theme-icon-light { display: inline-block; }
		
		.card-desc { 
			font-size: 12px; 
			opacity: 0.8; 
			margin-bottom: 10px;
			line-height: 1.5;
		}
		
		.button { 
			display: flex;
			align-items: center;
			justify-content: center;
			width: 100%;
			gap: 6px;
			padding: 8px 12px; 
			background: var(--vscode-button-background); 
			color: var(--vscode-button-foreground); 
			border: none; 
			border-radius: 4px;
			cursor: pointer;
			font-size: 13px;
			font-family: inherit;
		}
		.button:hover { background: var(--vscode-button-hoverBackground); }
	</style>
</head>
<body>
	<div class="section">
		<div class="section-header">Get Started</div>
		<div class="card featured">
			<div class="card-title">
				<img class="card-title-icon theme-icon-dark" src="${queryEditorIconDarkUri}" alt="" aria-hidden="true">
				<img class="card-title-icon theme-icon-light" src="${queryEditorIconLightUri}" alt="" aria-hidden="true">
				Query Playground
			</div>
			<div class="card-desc">New here? Start with the playground, it auto-saves your work. Use <strong>File → Save As...</strong> anytime to save it to disk. Default shortcut is <strong>CTRL+SHIFT+ALT+K.</strong></div>
			<button class="button" onclick="sendCommand('openQueryEditor')">Open Query Editor</button>
		</div>
		<div class="card">
			<div class="card-title">
				<i class="codicon codicon-rocket"></i> Agent-First Tutorial
			</div>
			<div class="card-desc">Let the VS Code agent build queries and charts for you, the fastest way to go from question to insight.</div>
			<button class="button" onclick="sendCommand('openWalkthroughAgent')">Start Tutorial</button>
		</div>
		<div class="card">
			<div class="card-title">
				<i class="codicon codicon-edit"></i> Editor-First Tutorial
			</div>
			<div class="card-desc">Write KQL queries, explore results, build charts, and use Copilot for the boring stuff.</div>
			<button class="button" onclick="sendCommand('openWalkthroughEditor')">Start Tutorial</button>
		</div>
		<div class="card">
			<div class="card-title">
				<i class="codicon codicon-export"></i> Export Agent Skill
			</div>
			<div class="card-desc">Export a SKILL.md file that teaches any Copilot agent how to operate Kusto Workbench. Share with your team or keep it local.</div>
			<button class="button" onclick="sendCommand('exportSkill')">Export Skill...</button>
		</div>
	</div>

	<div class="section">
		<div class="section-header">Files</div>
		<div class="card">
			<div class="card-title">
				<i class="codicon codicon-folder-opened"></i> Open Existing File
			</div>
			<div class="card-desc">The extension works with .kql, .csl, and .kqlx files. Open via Explorer or use the button below.</div>
			<button class="button" onclick="sendCommand('openKqlFile')">Browse Files...</button>
		</div>
		<div class="card">
			<div class="card-title">
				<i class="codicon codicon-new-file"></i> Create New Notebook
			</div>
			<div class="card-desc">Want to save from the start? Create a new .kqlx file on disk.</div>
			<button class="button" onclick="sendCommand('createKqlxFile')">Create .kqlx File...</button>
		</div>
		<div class="card">
			<div class="card-title">
				<i class="codicon codicon-cloud-download"></i> Open Remote File
			</div>
			<div class="card-desc">Open a .kqlx, .sqlx, or .kql file from a URL. Supports GitHub links (public &amp; private repos) and SharePoint sharing links.</div>
			<button class="button" onclick="sendCommand('openRemoteFile')">Open from URL...</button>
		</div>
	</div>

	<div class="section">
		<div class="section-header">Settings & Data</div>
		<div class="card">
			<div class="card-title">
				<i class="codicon codicon-database"></i> Cached Data
			</div>
			<div class="card-desc">View or clear cached auth tokens and schemas.</div>
			<button class="button" onclick="sendCommand('seeCachedValues')">View Cache</button>
		</div>
		<div class="card">
			<div class="card-title">
				<i class="codicon codicon-plug"></i> Connections
			</div>
			<div class="card-desc">Manage cluster connections. Use this to add or remove clusters, add or remove favorites, and flag / unflag clusters as 'Leave No Trace'.</div>
			<button class="button" onclick="sendCommand('manageConnections')">Manage...</button>
		</div>
		<div class="card">
			<div class="card-title">
				<i class="codicon codicon-settings-gear"></i> Settings
			</div>
			<div class="card-desc">Configure Kusto Workbench preferences and behavior. You can even hide this activity bar icon.</div>
			<button class="button" onclick="sendCommand('openSettings')">Open Settings</button>
		</div>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		function sendCommand(cmd) {
			vscode.postMessage({ command: cmd });
		}
	</script>
</body>
</html>`;
				webviewView.webview.onDidReceiveMessage(async (message: { command: string }) => {
					switch (message.command) {
						case 'openQueryEditor':
							await vscode.commands.executeCommand('kusto.openQueryEditor');
							break;
						case 'openKqlFile': {
							const uris = await vscode.window.showOpenDialog({
								canSelectMany: false,
								filters: { 'Kusto Files': ['kql', 'csl', 'kqlx'] },
								title: 'Open Kusto File'
							});
							if (uris && uris.length > 0) {
								await vscode.commands.executeCommand('vscode.open', uris[0]);
							}
							break;
						}
						case 'createKqlxFile': {
							const uri = await vscode.window.showSaveDialog({
								filters: { 'Kusto Notebook': ['kqlx'] },
								saveLabel: 'Create',
								title: 'Create new .kqlx file'
							});
							if (uri) {
								await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(''));
								await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor');
							}
							break;
						}
						case 'seeCachedValues':
							await vscode.commands.executeCommand('kusto.seeCachedValues');
							break;
						case 'manageConnections':
							await vscode.commands.executeCommand('kusto.manageConnections');
							break;
						case 'openSettings':
							await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:angelos-petropoulos.vscode-kusto-workbench');
							break;
						case 'openRemoteFile':
							await vscode.commands.executeCommand('kusto.openRemoteFile');
							break;
						case 'openWalkthroughAgent':
							await vscode.commands.executeCommand('kusto.openTutorials', 'agent');
							break;
						case 'openWalkthroughEditor':
							await vscode.commands.executeCommand('kusto.openTutorials', 'editor');
							break;					case 'exportSkill':
						await vscode.commands.executeCommand('kusto.exportSkill');
						break;					}
				});
			}
		})
	);

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('kusto.openQueryEditor', async () => {
			// Open the persistent session file (survives restarts/crashes).
			await vscode.workspace.fs.createDirectory(context.globalStorageUri);
			const sessionUri = vscode.Uri.joinPath(context.globalStorageUri, 'session.kqlx');
			if (testIsolateKustoConnections) {
				await vscode.workspace.fs.writeFile(sessionUri, new TextEncoder().encode(''));
			}
			try {
				await vscode.workspace.fs.stat(sessionUri);
			} catch {
				// Create empty file; webview will initialize with a default query box and persist.
				await vscode.workspace.fs.writeFile(sessionUri, new TextEncoder().encode(''));
			}

			await vscode.commands.executeCommand('vscode.openWith', sessionUri, KqlxEditorProvider.viewType, {
				viewColumn: vscode.ViewColumn.One
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kusto.openTutorials', async (categoryId?: string) => {
			await openTutorials(typeof categoryId === 'string' ? categoryId : undefined, 'standard');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kusto.manageConnections', () => {
			ConnectionManagerViewerV2.open(context, context.extensionUri, connectionManager, { getSqlConnectionManager, getSqlClient });
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kusto.deleteAllConnections', async () => {
			const confirm = await vscode.window.showWarningMessage(
				'Delete all saved Kusto connections?',
				{ modal: true, detail: 'This removes all saved cluster connections from this machine.' },
				'Delete'
			);
			if (confirm !== 'Delete') {
				return;
			}
			const removed = await connectionManager.clearConnections();
			void vscode.window.showInformationMessage(
				removed > 0 ? `Deleted ${removed} connection${removed === 1 ? '' : 's'}.` : 'No saved connections to delete.'
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kusto.openKqlxFile', async () => {
			const pick = await vscode.window.showOpenDialog({
				canSelectMany: false,
				openLabel: 'Open .kqlx',
				filters: { 'Kusto Session': ['kqlx'] }
			});
			if (!pick || pick.length === 0) {
				return;
			}
			await vscode.commands.executeCommand('vscode.openWith', pick[0], KqlxEditorProvider.viewType, {
				viewColumn: vscode.ViewColumn.One
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kusto.openMdxFile', async () => {
			const pick = await vscode.window.showOpenDialog({
				canSelectMany: false,
				openLabel: 'Open .mdx',
				filters: { 'Markdown Notebook': ['mdx'] }
			});
			if (!pick || pick.length === 0) {
				return;
			}
			await vscode.commands.executeCommand('vscode.openWith', pick[0], KqlxEditorProvider.viewType, {
				viewColumn: vscode.ViewColumn.One
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kusto.saveKqlxAs', async () => {
			// Delegate to VS Code's built-in Save As for the active editor/document.
			await vscode.commands.executeCommand('workbench.action.files.saveAs');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kusto.seeCachedValues', async () => {
			CachedValuesViewerV2.open(context, context.extensionUri, connectionManager, { getSqlConnectionManager, getSqlClient });
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kusto.showDevelopmentNotes', async () => {
			if (!toolOrchestrator) {
				vscode.window.showWarningMessage('Kusto Workbench is not initialized yet.');
				return;
			}
			try {
				const notes = await toolOrchestrator.getDevNotes();
				if (notes.length === 0) {
					vscode.window.showInformationMessage('No development notes in the current file.');
					return;
				}
				const lines: string[] = [
					`# Development Notes (${notes.length})`,
					'',
				];
				for (const note of notes) {
					lines.push(`## [${note.category}] — ${note.source}`);
					lines.push('');
					lines.push(note.content);
					lines.push('');
					lines.push(`- **ID:** ${note.id}`);
					lines.push(`- **Created:** ${note.created}`);
					if (note.updated !== note.created) {
						lines.push(`- **Updated:** ${note.updated}`);
					}
					if (note.relatedSectionIds && note.relatedSectionIds.length > 0) {
						lines.push(`- **Related sections:** ${note.relatedSectionIds.join(', ')}`);
					}
					lines.push('');
					lines.push('---');
					lines.push('');
				}
				const doc = await vscode.workspace.openTextDocument({
					content: lines.join('\n'),
					language: 'markdown'
				});
				await vscode.window.showTextDocument(doc, { preview: true });
			} catch (err) {
				vscode.window.showErrorMessage(`Failed to read development notes: ${err instanceof Error ? err.message : String(err)}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kusto.resetCopilotModelSelection', async () => {
			// Clear extension globalState (this is the source of truth now).
			try {
				await context.globalState.update('kusto.optimize.lastCopilotModelId', undefined);
			} catch {
				// ignore
			}

			// Also notify any active webview to clear local caches and refresh UI.
			try {
				toolOrchestrator?.postToActiveWebview({ type: 'resetCopilotModelSelection' });
			} catch {
				// ignore
			}

			void vscode.window.showInformationMessage('Reset Copilot model selection. New editors will use the default model.');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kusto.openCustomAgent', async () => {
			await openKustoWorkbenchAgentChat();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kusto.exportSkill', async () => {
			await exportSkillCommand(context);
		})
	);

	// Fire-and-forget: update previously exported skill files if the template changed.
	void checkAndUpdateSkillFiles(context);
}

// This method is called when your extension is deactivated
export async function deactivate() {
	const pm = stsProcessManagerSingleton.get();
	if (pm) {
		await pm.stop();
	}
}
