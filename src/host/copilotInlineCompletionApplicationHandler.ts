import type { IncomingWebviewMessage } from './queryEditorTypes';
import type { SqlIssuedOwnerToken, SqlResultOwner } from './sql/sqlEditorSessionRegistry';

type CopilotInlineCompletionMessage = Extract<IncomingWebviewMessage, {
	type: 'requestCopilotInlineCompletion';
}>;

export interface CopilotInlineCompletionApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type CopilotInlineCompletionApplicationHandlerOptions = {
	assertSqlOwnerToken: (boxId: string, ownerToken: string | undefined) => Promise<SqlIssuedOwnerToken>;
	handleCopilotInlineCompletionRequest: (
		message: CopilotInlineCompletionMessage,
		expectedSqlOwner?: SqlResultOwner,
		ownerToken?: string,
	) => Promise<void>;
	postMessage: (message: unknown) => Thenable<boolean>;
};

export class HostCopilotInlineCompletionApplicationHandler
	implements CopilotInlineCompletionApplicationHandler {
	private disposed = false;

	constructor(private readonly options: CopilotInlineCompletionApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		if (message.type !== 'requestCopilotInlineCompletion') return undefined;
		if (this.disposed) return Promise.resolve();
		return this.handleCopilotInlineCompletionRequest(message);
	}

	dispose(): void {
		this.disposed = true;
	}

	private async handleCopilotInlineCompletionRequest(
		message: CopilotInlineCompletionMessage,
	): Promise<void> {
		if (message.flavor !== 'sql') {
			await this.options.handleCopilotInlineCompletionRequest(message);
			return;
		}

		try {
			const issued = await this.options.assertSqlOwnerToken(message.boxId, message.ownerToken);
			await this.options.handleCopilotInlineCompletionRequest(message, issued.owner, issued.token);
		} catch {
			this.options.postMessage({
				type: 'copilotInlineCompletionResult',
				requestId: message.requestId,
				boxId: message.boxId,
				ownerToken: message.ownerToken,
				completions: [],
			});
		}
	}
}