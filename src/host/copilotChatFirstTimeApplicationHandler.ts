import * as vscode from 'vscode';

import { openKustoWorkbenchAgentChat } from './copilotChatOpenUtils';
import { STORAGE_KEYS, type IncomingWebviewMessage } from './queryEditorTypes';

type CopilotChatFirstTimeMessage = Extract<IncomingWebviewMessage, {
	type: 'copilotChatFirstTimeCheck';
}>;

type CopilotChatFirstTimeAction = 'proceed' | 'openedAgent' | 'dismissed';

export interface CopilotChatFirstTimeApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type CopilotChatFirstTimeApplicationHandlerOptions = {
	globalState: Pick<vscode.Memento, 'get' | 'update'>;
	postMessage: (message: unknown) => void | boolean | Thenable<boolean>;
};

export class HostCopilotChatFirstTimeApplicationHandler
	implements CopilotChatFirstTimeApplicationHandler {
	private disposed = false;

	constructor(private readonly options: CopilotChatFirstTimeApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		if (message.type !== 'copilotChatFirstTimeCheck') return undefined;
		if (this.disposed) return Promise.resolve();
		return this.handleCopilotChatFirstTimeCheck(message);
	}

	dispose(): void {
		this.disposed = true;
	}

	private async handleCopilotChatFirstTimeCheck(message: CopilotChatFirstTimeMessage): Promise<void> {
		const already = this.options.globalState.get<boolean>(STORAGE_KEYS.copilotChatFirstTimeDismissed);
		if (already) {
			this.postResult(message.boxId, 'proceed');
			return;
		}

		await this.options.globalState.update(STORAGE_KEYS.copilotChatFirstTimeDismissed, true);

		const openAgent = 'Open the Kusto Workbench agent';
		const useChat = 'Use this Copilot Chat window';
		const choice = await vscode.window.showInformationMessage(
			'Hello there! Did you know this extension comes with a custom agent called \'Kusto Workbench\' that is available through the VS Code Copilot chat window? You should use that instead of this chat window unless you are very familiar with both and you understand the differences.',
			{ modal: true },
			openAgent,
			useChat,
		);

		if (choice === openAgent) {
			await openKustoWorkbenchAgentChat();
			this.postResult(message.boxId, 'openedAgent');
		} else if (choice === useChat) {
			this.postResult(message.boxId, 'proceed');
		} else {
			this.postResult(message.boxId, 'dismissed');
		}
	}

	private postResult(boxId: string, action: CopilotChatFirstTimeAction): void {
		this.options.postMessage({ type: 'copilotChatFirstTimeResult', boxId, action });
	}
}