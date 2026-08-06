import { openKustoWorkbenchAgentChat } from './copilotChatOpenUtils';
import type { IncomingWebviewMessage } from './queryEditorTypes';

export interface CopilotAgentOpenApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export class HostCopilotAgentOpenApplicationHandler implements CopilotAgentOpenApplicationHandler {
	private disposed = false;

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		if (message.type !== 'openCopilotAgent') return undefined;
		if (this.disposed) return Promise.resolve();
		return this.openCopilotAgent();
	}

	dispose(): void {
		this.disposed = true;
	}

	private async openCopilotAgent(): Promise<void> {
		await openKustoWorkbenchAgentChat();
	}
}