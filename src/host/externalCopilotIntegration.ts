import {
	reconcileCopilotCliRegistration,
	type CopilotCliRegistrationResult,
} from './externalMcpClientProvisioning';
import type { InstalledExternalMcpConnector } from './externalMcpConnectorInstaller';

type ReconcileRegistration = typeof reconcileCopilotCliRegistration;

export interface CopilotCliIntegrationResult {
	readonly changed: boolean;
	readonly reloadRequired: boolean;
	readonly registration: CopilotCliRegistrationResult;
	readonly rollback?: () => Promise<void>;
}

export async function reconcileCopilotCliIntegration(options: {
	readonly executable: string;
	readonly connector: InstalledExternalMcpConnector;
	readonly reconcileRegistration?: ReconcileRegistration;
}): Promise<CopilotCliIntegrationResult> {
	const reconcileRegistration = options.reconcileRegistration ?? reconcileCopilotCliRegistration;
	const registration = await reconcileRegistration({
		executable: options.executable,
		connector: options.connector,
	});
	const changed = registration.changed || options.connector.launchTargetChanged === true;
	return {
		changed,
		reloadRequired: registration.reloadRequired || options.connector.launchTargetChanged === true,
		registration,
		...(registration.rollback ? { rollback: registration.rollback } : {}),
	};
}