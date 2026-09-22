import { join } from 'node:path';
import { homedir } from 'node:os';
import {
	reconcileManagedExternalCustomization,
	removeManagedExternalCustomization,
	type CopilotCliAgentStatus,
} from './externalCopilotAgent';

export interface ScoutSkillResult {
	readonly changed: boolean;
	readonly status: CopilotCliAgentStatus;
	readonly skillPath: string;
	readonly rollback?: () => Promise<void>;
}

export function resolveScoutSkillPath(
	copilotHomeDirectory = join(homedir(), '.copilot'),
): string {
	return join(copilotHomeDirectory, 'skills', 'kusto-workbench', 'SKILL.md');
}

export async function reconcileScoutSkill(options: {
	readonly sourceContent: string;
	readonly copilotHomeDirectory?: string;
}): Promise<ScoutSkillResult> {
	const managed = await reconcileManagedExternalCustomization({
		path: resolveScoutSkillPath(options.copilotHomeDirectory),
		sourceContent: options.sourceContent,
		artifactName: 'Scout-compatible Kusto Workbench skill',
	});
	return {
		changed: managed.changed,
		status: managed.status,
		skillPath: managed.path,
		...(managed.rollback ? { rollback: managed.rollback } : {}),
	};
}

export async function removeScoutSkill(options: {
	readonly copilotHomeDirectory?: string;
} = {}): Promise<{ removed: boolean; skillPath: string }> {
	const removed = await removeManagedExternalCustomization({
		path: resolveScoutSkillPath(options.copilotHomeDirectory),
		artifactName: 'Scout-compatible Kusto Workbench skill',
	});
	return { removed: removed.removed, skillPath: removed.path };
}