import type { IncomingWebviewMessage } from './queryEditorTypes';

type CopilotAvailabilityMessage = Extract<IncomingWebviewMessage, {
	type: 'checkCopilotAvailability';
}>;

export interface CopilotAvailabilityApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type CopilotAvailabilityApplicationHandlerOptions = {
	checkCopilotAvailability: (boxId: string) => Promise<void>;
};

export class HostCopilotAvailabilityApplicationHandler
	implements CopilotAvailabilityApplicationHandler {
	private disposed = false;

	constructor(private readonly options: CopilotAvailabilityApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		if (message.type !== 'checkCopilotAvailability') return undefined;
		if (this.disposed) return Promise.resolve();
		return this.checkCopilotAvailability(message);
	}

	dispose(): void {
		this.disposed = true;
	}

	private async checkCopilotAvailability(message: CopilotAvailabilityMessage): Promise<void> {
		await this.options.checkCopilotAvailability(message.boxId);
	}
}
