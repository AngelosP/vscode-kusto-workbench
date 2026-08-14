import type { IncomingWebviewMessage } from './queryEditorTypes';
import type { SqlIssuedOwnerToken, SqlResultOwner } from './sql/sqlEditorSessionRegistry';
import {
	admitCopilotInlineCompletionWebviewMessage,
	parseCopilotInlineCompletionHostMessage,
	type CopilotInlineCompletionHostMessage,
	type CopilotInlineCompletionWebviewMessage,
} from '../shared/copilotInlineCompletionProtocol';

type CopilotInlineCompletionMessage = CopilotInlineCompletionWebviewMessage;

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
	postMessage: (message: CopilotInlineCompletionHostMessage) => Thenable<boolean>;
};

export class HostCopilotInlineCompletionApplicationHandler
	implements CopilotInlineCompletionApplicationHandler {
	private disposed = false;

	constructor(private readonly options: CopilotInlineCompletionApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		const admission = admitCopilotInlineCompletionWebviewMessage(message);
		if (!admission.recognized) return undefined;
		if (!admission.parsed.ok) return Promise.resolve();
		if (this.disposed) return Promise.resolve();
		return this.handleCopilotInlineCompletionRequest(admission.parsed.value);
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
			this.postMessage({
				type: 'copilotInlineCompletionResult',
				requestId: message.requestId,
				boxId: message.boxId,
				ownerToken: message.ownerToken,
				completions: [],
			});
		}
	}

	private postMessage(message: CopilotInlineCompletionHostMessage): void {
		const parsed = parseCopilotInlineCompletionHostMessage(message);
		if (parsed.ok) this.options.postMessage(parsed.value);
	}
}