'use strict';

const vscode = require('vscode');

const MAIN_EXTENSION_ID = 'angelos-petropoulos.vscode-kusto-workbench';

async function applySetting() {
	const enabled = vscode.workspace.getConfiguration('kustoWorkbench').get('externalTools.enabled', false);
	if (enabled) {
		await vscode.commands.executeCommand('kusto.startExternalMcpProvider');
		return;
	}
	if (vscode.extensions.getExtension(MAIN_EXTENSION_ID)?.isActive) {
		await vscode.commands.executeCommand('kusto.stopExternalMcpProvider');
	}
}

function activate(context) {
	void applySetting().catch(error => console.error('[Kusto Workbench External MCP]', error));
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('kustoWorkbench.externalTools.enabled')) {
			void applySetting().catch(error => console.error('[Kusto Workbench External MCP]', error));
		}
	}));
}

function deactivate() {}

module.exports = { activate, deactivate };
