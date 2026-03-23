import * as vscode from 'vscode';

const KUSTO_CHAT_MODE = 'Kusto Workbench';

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Opens Copilot Chat and applies the Kusto Workbench custom mode.
 *
 * Some VS Code builds can ignore the first mode selection while the chat UI
 * initializes. Re-applying shortly after opening makes first click reliable.
 */
export async function openKustoWorkbenchAgentChat(): Promise<void> {
	try {
		await vscode.commands.executeCommand('workbench.action.chat.open', { mode: KUSTO_CHAT_MODE });
	} catch {
		return;
	}

	try {
		await delay(150);
		await vscode.commands.executeCommand('workbench.action.chat.open', { mode: KUSTO_CHAT_MODE });
	} catch {
		// Ignore transient failures; opening chat once is still a useful fallback.
	}
}
