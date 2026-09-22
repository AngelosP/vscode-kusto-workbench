import {
	reconcileCopilotCliAgent,
	type CopilotCliAgentResult,
} from './externalCopilotAgent';
import {
	reconcileCopilotCliRegistration,
	type CopilotCliRegistrationResult,
} from './externalMcpClientProvisioning';
import type { InstalledExternalMcpConnector } from './externalMcpConnectorInstaller';

type ReconcileRegistration = typeof reconcileCopilotCliRegistration;
type ReconcileAgent = typeof reconcileCopilotCliAgent;

export interface CopilotCliIntegrationResult {
	readonly changed: boolean;
	readonly reloadRequired: boolean;
	readonly registration: CopilotCliRegistrationResult;
	readonly agent: CopilotCliAgentResult;
	readonly rollback?: () => Promise<void>;
}

async function compensateProvisioningFailure(
	error: unknown,
	rollback: (() => Promise<void>) | undefined,
): Promise<never> {
	if (!rollback) throw error;
	try {
		await rollback();
	} catch (rollbackError) {
		throw new AggregateError(
			[error, rollbackError],
			'Copilot CLI agent setup failed and the MCP registration could not be restored.',
		);
	}
	throw error;
}

async function runRollbacks(rollbacks: readonly (() => Promise<void>)[]): Promise<void> {
	const failures: unknown[] = [];
	for (const rollback of rollbacks) {
		try {
			await rollback();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) {
		throw new AggregateError(failures, 'Copilot CLI integration rollback did not complete.');
	}
}

export async function reconcileCopilotCliIntegration(options: {
	readonly executable: string;
	readonly connector: InstalledExternalMcpConnector;
	readonly agentSourceContent: string;
	readonly copilotHomeDirectory?: string;
	readonly reconcileRegistration?: ReconcileRegistration;
	readonly reconcileAgent?: ReconcileAgent;
}): Promise<CopilotCliIntegrationResult> {
	const reconcileRegistration = options.reconcileRegistration ?? reconcileCopilotCliRegistration;
	const reconcileAgent = options.reconcileAgent ?? reconcileCopilotCliAgent;
	const registration = await reconcileRegistration({
		executable: options.executable,
		connector: options.connector,
	});
	let agent: CopilotCliAgentResult;
	try {
		agent = await reconcileAgent({
			sourceContent: options.agentSourceContent,
			...(options.copilotHomeDirectory ? { copilotHomeDirectory: options.copilotHomeDirectory } : {}),
		});
	} catch (error) {
		return compensateProvisioningFailure(error, registration.rollback);
	}
	const rollbacks = [agent.rollback, registration.rollback]
		.filter((rollback): rollback is () => Promise<void> => rollback !== undefined);
	const changed = registration.changed || agent.changed || options.connector.launchTargetChanged === true;
	return {
		changed,
		reloadRequired: registration.reloadRequired || agent.changed || options.connector.launchTargetChanged === true,
		registration,
		agent,
		...(rollbacks.length > 0 ? { rollback: () => runRollbacks(rollbacks) } : {}),
	};
}