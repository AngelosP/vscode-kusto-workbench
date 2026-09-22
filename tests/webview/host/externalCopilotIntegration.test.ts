import { describe, expect, it, vi } from 'vitest';
import { reconcileCopilotCliIntegration } from '../../../src/host/externalCopilotIntegration';
import type { InstalledExternalMcpConnector } from '../../../src/host/externalMcpConnectorInstaller';

const connector: InstalledExternalMcpConnector = {
	root: 'C:\\connector',
	versionDirectory: 'C:\\connector\\versions\\5.2.0',
	bootstrapPath: 'C:\\connector\\bootstrap.cjs',
	command: 'C:\\connector\\node.exe',
	args: ['C:\\connector\\bootstrap.cjs'],
	connectorVersion: '5.2.0',
	schemaHash: 'a'.repeat(64),
};

describe('Copilot CLI external integration provisioning', () => {
	it('converges the MCP registration before the user-level agent', async () => {
		const calls: string[] = [];
		const registrationRollback = vi.fn(async () => { calls.push('registration rollback'); });
		const agentRollback = vi.fn(async () => { calls.push('agent rollback'); });
		const reconcileRegistration = vi.fn(async () => {
			calls.push('registration');
			return {
				changed: true,
				reloadRequired: true,
				executable: 'copilot.exe',
				rollback: registrationRollback,
			};
		});
		const reconcileAgent = vi.fn(async () => {
			calls.push('agent');
			return {
				changed: true,
				status: 'installed' as const,
				agentPath: 'C:\\Users\\me\\.copilot\\agents\\kusto-workbench.agent.md',
				rollback: agentRollback,
			};
		});

		const result = await reconcileCopilotCliIntegration({
			executable: 'copilot.exe',
			connector,
			agentSourceContent: 'agent',
			reconcileRegistration,
			reconcileAgent,
		});

		expect(calls).toEqual(['registration', 'agent']);
		expect(result).toMatchObject({ changed: true, reloadRequired: true });
		await result.rollback?.();
		expect(calls).toEqual(['registration', 'agent', 'agent rollback', 'registration rollback']);
	});

	it('rolls back a changed registration when agent provisioning fails', async () => {
		const registrationRollback = vi.fn(async () => undefined);
		const failure = new Error('agent conflict');
		const reconcileRegistration = vi.fn(async () => ({
			changed: true,
			reloadRequired: true,
			executable: 'copilot.exe',
			rollback: registrationRollback,
		}));
		const reconcileAgent = vi.fn(async () => { throw failure; });

		await expect(reconcileCopilotCliIntegration({
			executable: 'copilot.exe',
			connector,
			agentSourceContent: 'agent',
			reconcileRegistration,
			reconcileAgent,
		})).rejects.toBe(failure);
		expect(registrationRollback).toHaveBeenCalledOnce();
	});

	it('reports both the provisioning and compensation failures', async () => {
		const failure = new Error('agent conflict');
		const rollbackFailure = new Error('registration rollback failed');
		const reconcileRegistration = vi.fn(async () => ({
			changed: true,
			reloadRequired: true,
			executable: 'copilot.exe',
			rollback: async () => { throw rollbackFailure; },
		}));
		const reconcileAgent = vi.fn(async () => { throw failure; });

		const rejected = await reconcileCopilotCliIntegration({
			executable: 'copilot.exe',
			connector,
			agentSourceContent: 'agent',
			reconcileRegistration,
			reconcileAgent,
		}).catch(error => error);

		expect(rejected).toBeInstanceOf(AggregateError);
		expect((rejected as AggregateError).errors).toEqual([failure, rollbackFailure]);
	});

	it('marks an agent-only change as requiring a new CLI session', async () => {
		const reconcileRegistration = vi.fn(async () => ({
			changed: false,
			reloadRequired: false,
			executable: 'copilot.exe',
		}));
		const reconcileAgent = vi.fn(async () => ({
			changed: true,
			status: 'updated' as const,
			agentPath: 'agent.md',
			rollback: async () => undefined,
		}));

		const result = await reconcileCopilotCliIntegration({
			executable: 'copilot.exe',
			connector,
			agentSourceContent: 'agent',
			reconcileRegistration,
			reconcileAgent,
		});

		expect(result).toMatchObject({ changed: true, reloadRequired: true });
	});

	it('requires a new CLI session when setup retargets the VS Code launch profile', async () => {
		const reconcileRegistration = vi.fn(async () => ({
			changed: false,
			reloadRequired: false,
			executable: 'copilot.exe',
		}));
		const reconcileAgent = vi.fn(async () => ({
			changed: false,
			status: 'current' as const,
			agentPath: 'agent.md',
		}));

		const result = await reconcileCopilotCliIntegration({
			executable: 'copilot.exe',
			connector: { ...connector, launchTargetChanged: true },
			agentSourceContent: 'agent',
			reconcileRegistration,
			reconcileAgent,
		});

		expect(result).toMatchObject({ changed: true, reloadRequired: true });
	});
});