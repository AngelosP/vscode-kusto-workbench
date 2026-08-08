import { hasKustoCopilotRequestIdentity } from '../shared/kustoExecution';
import type { IncomingWebviewMessage } from './queryEditorTypes';

type CopilotConversationClearMessage = Extract<IncomingWebviewMessage, {
	type: 'clearCopilotConversation';
}>;

type KustoCopilotConversationClearMessage = Extract<CopilotConversationClearMessage, {
	flavor: 'kusto';
}>;

export interface CopilotConversationClearApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type CopilotConversationClearApplicationHandlerOptions = {
	clearCopilotConversation: (boxId: string) => void | PromiseLike<void>;
	clearKustoCopilotConversation: (
		message: KustoCopilotConversationClearMessage,
	) => boolean | PromiseLike<boolean>;
};

export class HostCopilotConversationClearApplicationHandler
	implements CopilotConversationClearApplicationHandler {
	private disposed = false;

	constructor(private readonly options: CopilotConversationClearApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		if (message.type !== 'clearCopilotConversation') return undefined;
		if (this.disposed) return Promise.resolve();
		return this.clearCopilotConversation(message);
	}

	dispose(): void {
		this.disposed = true;
	}

	private async clearCopilotConversation(message: CopilotConversationClearMessage): Promise<void> {
		if (message.flavor === 'kusto') {
			if (!hasKustoCopilotRequestIdentity(message)) return;
			await this.options.clearKustoCopilotConversation(message);
			return;
		}
		await this.options.clearCopilotConversation(message.boxId);
	}
}
