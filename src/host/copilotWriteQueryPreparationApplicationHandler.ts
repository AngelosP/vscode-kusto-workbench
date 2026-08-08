import type { IncomingWebviewMessage } from './queryEditorTypes';

type CopilotWriteQueryPreparationMessage = Extract<IncomingWebviewMessage, {
	type: 'prepareCopilotWriteQuery';
}>;

export interface CopilotWriteQueryPreparationApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type CopilotWriteQueryPreparationApplicationHandlerOptions = {
	prepareCopilotWriteQuery: (message: CopilotWriteQueryPreparationMessage) => Promise<void>;
};

export class HostCopilotWriteQueryPreparationApplicationHandler
	implements CopilotWriteQueryPreparationApplicationHandler {
	private disposed = false;

	constructor(private readonly options: CopilotWriteQueryPreparationApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		if (message.type !== 'prepareCopilotWriteQuery') return undefined;
		if (this.disposed) return Promise.resolve();
		return this.prepareCopilotWriteQuery(message);
	}

	dispose(): void {
		this.disposed = true;
	}

	private async prepareCopilotWriteQuery(message: CopilotWriteQueryPreparationMessage): Promise<void> {
		await this.options.prepareCopilotWriteQuery(message);
	}
}