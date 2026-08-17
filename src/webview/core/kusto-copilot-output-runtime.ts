import type { KustoCopilotRequestIdentity } from '../../shared/kustoExecution.js';

export const ADMITTED_KUSTO_COPILOT_EVENT = 'kusto-workbench-copilot-output';
export const APPLIED_KUSTO_COPILOT_DONE_EVENT = 'kusto-workbench-copilot-done-applied';

export function emitAdmittedKustoCopilotOutput(message: KustoCopilotRequestIdentity & Record<string, unknown>): void {
	window.dispatchEvent(new CustomEvent(ADMITTED_KUSTO_COPILOT_EVENT, { detail: message }));
}

export function emitAppliedKustoCopilotDone(message: KustoCopilotRequestIdentity & Record<string, unknown>): void {
	window.dispatchEvent(new CustomEvent(APPLIED_KUSTO_COPILOT_DONE_EVENT, { detail: message }));
}
