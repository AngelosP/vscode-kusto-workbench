import type { CopilotInlineCompletion } from '../../shared/copilotInlineCompletionProtocol.js';
import { copilotInlineCompletionRequests } from '../core/state.js';

export function handleCopilotInlineCompletionResult(
	requestId: string,
	completions: CopilotInlineCompletion[],
): void {
	const pending = copilotInlineCompletionRequests[requestId];
	if (!pending || typeof pending.resolve !== 'function') return;
	delete copilotInlineCompletionRequests[requestId];
	pending.resolve(completions);
}