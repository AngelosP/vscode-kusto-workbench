// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { QueryEditorProvider } from './queryEditorProvider';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	console.log('Kusto Query Editor extension is now active');

	// Initialize connection manager
	const connectionManager = new ConnectionManager(context);

	// Register query editor provider
	const queryEditorProvider = new QueryEditorProvider(context.extensionUri, connectionManager);

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('kusto.openQueryEditor', () => {
			queryEditorProvider.openEditor();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kusto.manageConnections', () => {
			connectionManager.showConnectionManager();
		})
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
