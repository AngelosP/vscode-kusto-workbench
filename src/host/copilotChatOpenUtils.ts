import * as vscode from 'vscode';

const KUSTO_CHAT_MODE = 'Kusto Workbench';

export type OpenKustoWorkbenchAgentChatOptions = {
	query?: string;
	submit?: boolean;
};

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Opens Copilot Chat and applies the Kusto Workbench custom mode.
 *
 * Some VS Code builds can ignore the first mode selection while the chat UI
 * initializes. Re-applying shortly after opening makes first click reliable.
 */
export async function openKustoWorkbenchAgentChat(options: OpenKustoWorkbenchAgentChatOptions = {}): Promise<boolean> {
	const query = typeof options.query === 'string' ? options.query.trim() : '';
	try {
		await vscode.commands.executeCommand('workbench.action.chat.open', { mode: KUSTO_CHAT_MODE });
	} catch {
		return false;
	}

	try {
		await delay(150);
		if (query) {
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				mode: KUSTO_CHAT_MODE,
				query,
				isPartialQuery: options.submit === false,
			});
		} else {
			await vscode.commands.executeCommand('workbench.action.chat.open', { mode: KUSTO_CHAT_MODE });
		}
		return true;
	} catch {
		// Ignore transient failures; opening chat once is still a useful fallback.
		return !query;
	}
}
