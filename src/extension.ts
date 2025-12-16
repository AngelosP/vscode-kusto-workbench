// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { KqlCompatEditorProvider } from './kqlCompatEditorProvider';
import { KqlxEditorProvider } from './kqlxEditorProvider';
import { KqlDiagnosticSeverity } from './kqlLanguageService/protocol';
import { KqlLanguageServiceHost } from './kqlLanguageService/host';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	console.log('Kusto Query Editor extension is now active');

	// Initialize connection manager
	const connectionManager = new ConnectionManager(context);
	const kqlLanguageHost = new KqlLanguageServiceHost(connectionManager, context);

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
				}
			}, delayMs)
		);
	};

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument((doc) => scheduleDiagnostics(doc, 0))
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
	context.subscriptions.push(KqlxEditorProvider.register(context, context.extensionUri, connectionManager));
	// Register .kql/.csl compatibility custom editor
	context.subscriptions.push(KqlCompatEditorProvider.register(context, context.extensionUri, connectionManager));

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
		vscode.commands.registerCommand('kusto.manageConnections', () => {
			connectionManager.showConnectionManager();
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
		vscode.commands.registerCommand('kusto.saveKqlxAs', async () => {
			// Delegate to VS Code's built-in Save As for the active editor/document.
			await vscode.commands.executeCommand('workbench.action.files.saveAs');
		})
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
