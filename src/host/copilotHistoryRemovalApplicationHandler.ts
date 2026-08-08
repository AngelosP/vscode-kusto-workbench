import type { IncomingWebviewMessage } from './queryEditorTypes';

type CopilotHistoryRemovalMessage = Extract<IncomingWebviewMessage, {
	type: 'removeFromCopilotHistory';
}>;

export interface CopilotHistoryRemovalApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type CopilotHistoryRemovalApplicationHandlerOptions = {
	removeFromCopilotHistory: (boxId: string, entryId: string) => void | PromiseLike<void>;
};

export class HostCopilotHistoryRemovalApplicationHandler
	implements CopilotHistoryRemovalApplicationHandler {
	private disposed = false;

	constructor(private readonly options: CopilotHistoryRemovalApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		if (message.type !== 'removeFromCopilotHistory') return undefined;
		if (this.disposed) return Promise.resolve();
		return this.removeFromCopilotHistory(message);
	}

	dispose(): void {
		this.disposed = true;
	}

	private async removeFromCopilotHistory(message: CopilotHistoryRemovalMessage): Promise<void> {
		await this.options.removeFromCopilotHistory(message.boxId, message.entryId);
	}
}
