// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
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
import { TutorialSubscriptionService } from './tutorials/tutorialSubscriptionService';
import { TutorialViewerPanel } from './tutorials/tutorialViewerPanel';
import type { TutorialViewerMode } from '../shared/tutorials/tutorialCatalog';
import { EditorCursorStatusBar } from './editorCursorStatusBar';

import { stsProcessManagerSingleton } from './sql/stsProcessManager';

// Export the tool orchestrator instance so other modules can access it
export let toolOrchestrator: KustoWorkbenchToolOrchestrator | undefined;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
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
			vscode.commands.registerCommand('kustoWorkbench.test.getCursorStatusBar', () => editorCursorStatusBar.getSnapshot())
		);
	}

	const connectionManager = new ConnectionManager(context);
	const kqlLanguageHost = new KqlLanguageServiceHost(connectionManager, context);
	const tutorialCatalogService = new TutorialCatalogService(context);
	const tutorialSubscriptionService = new TutorialSubscriptionService(context);
	const openTutorials = async (selectedCategoryId?: string, preferredMode: TutorialViewerMode = 'standard'): Promise<void> => {
		TutorialViewerPanel.open(context, context.extensionUri, tutorialCatalogService, tutorialSubscriptionService, { selectedCategoryId, preferredMode });
	};

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
