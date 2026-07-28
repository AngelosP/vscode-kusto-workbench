import type { KustoCopilotRequestIdentity } from '../../shared/kustoExecution.js';

export const ADMITTED_KUSTO_COPILOT_EVENT = 'kusto-workbench-copilot-output';

export function emitAdmittedKustoCopilotOutput(message: KustoCopilotRequestIdentity & Record<string, unknown>): void {
	window.dispatchEvent(new CustomEvent(ADMITTED_KUSTO_COPILOT_EVENT, { detail: message }));
}
