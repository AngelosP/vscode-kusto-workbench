import { reconcileScoutSkill, type ScoutSkillResult } from './externalScoutSkill';
import { reconcileScoutMcpRegistration, type ScoutMcpRegistrationResult } from './externalScoutMcpProvisioning';
import type { InstalledExternalMcpConnector } from './externalMcpConnectorInstaller';

type ReconcileScoutSkill = typeof reconcileScoutSkill;

export interface ScoutIntegrationResult {
	readonly changed: boolean;
	readonly requiresNewConversation: boolean;
	readonly requiresRestart: boolean;
	readonly registration: ScoutMcpRegistrationResult;
	readonly skill: ScoutSkillResult;
}

async function compensateScoutSetupFailure(
	error: unknown,
	rollbacks: readonly ((() => Promise<void>) | undefined)[],
): Promise<never> {
	const failures: unknown[] = [];
	for (const rollback of rollbacks) {
		try { await rollback?.(); } catch (rollbackError) { failures.push(rollbackError); }
	}
	if (failures.length > 0) {
		throw new AggregateError(
			[error, ...failures],
			'Scout setup failed and its registration or skill could not be restored. Inspect integration status before retrying.',
		);
	}
	throw error;
}

export async function configureScoutIntegration(options: {
	readonly connector: Pick<InstalledExternalMcpConnector, 'command' | 'args' | 'launchTargetChanged'>;
	readonly skillSourceContent: string;
	readonly reconcileRegistration?: typeof reconcileScoutMcpRegistration;
	readonly reconcileSkill?: ReconcileScoutSkill;
	readonly enableProvider: () => PromiseLike<void>;
}): Promise<ScoutIntegrationResult> {
	const reconcileSkill = options.reconcileSkill ?? reconcileScoutSkill;
	const registration = await (options.reconcileRegistration ?? reconcileScoutMcpRegistration)({ connector: options.connector });
	let skill: ScoutSkillResult | undefined;
	try {
		skill = await reconcileSkill({ sourceContent: options.skillSourceContent });
		await options.enableProvider();
	} catch (error) {
		return compensateScoutSetupFailure(error, [skill?.rollback, registration.rollback]);
	}
	const changed = registration.changed || skill.changed || options.connector.launchTargetChanged === true;
	return {
		changed,
		requiresNewConversation: changed,
		requiresRestart: registration.changed || options.connector.launchTargetChanged === true,
		registration,
		skill,
	};
}