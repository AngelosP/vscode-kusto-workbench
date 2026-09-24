import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
	it('registers the MCP connector without installing a second agent', async () => {
		const copilotHomeDirectory = mkdtempSync(join(tmpdir(), 'kw-cli-no-agent-'));
		const agentPath = join(copilotHomeDirectory, 'agents', 'kusto-workbench.agent.md');
		const previousCopilotHome = process.env.COPILOT_HOME;
		const reconcileRegistration = vi.fn(async () => ({
			changed: true,
			reloadRequired: true,
			executable: 'copilot.exe',
		}));
		try {
			process.env.COPILOT_HOME = copilotHomeDirectory;
			const result = await reconcileCopilotCliIntegration({
				executable: 'copilot.exe',
				connector,
				reconcileRegistration,
			});
			expect(reconcileRegistration).toHaveBeenCalledWith({ executable: 'copilot.exe', connector });
			expect(result).toMatchObject({ changed: true, reloadRequired: true });
			expect(existsSync(agentPath)).toBe(false);
		} finally {
			if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME;
			else process.env.COPILOT_HOME = previousCopilotHome;
			rmSync(copilotHomeDirectory, { recursive: true, force: true });
		}
	});

	it('returns the registration rollback when provider enablement fails', async () => {
		const registrationRollback = vi.fn(async () => undefined);
		const reconcileRegistration = vi.fn(async () => {
			return {
				changed: true,
				reloadRequired: true,
				executable: 'copilot.exe',
				rollback: registrationRollback,
			};
		});

		const result = await reconcileCopilotCliIntegration({
			executable: 'copilot.exe',
			connector,
			reconcileRegistration,
		});

		expect(reconcileRegistration).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ changed: true, reloadRequired: true });
		await result.rollback?.();
		expect(registrationRollback).toHaveBeenCalledOnce();
	});

	it('does not require a new session when registration and launch target are unchanged', async () => {
		const reconcileRegistration = vi.fn(async () => ({
			changed: false,
			reloadRequired: false,
			executable: 'copilot.exe',
		}));

		const result = await reconcileCopilotCliIntegration({
			executable: 'copilot.exe',
			connector,
			reconcileRegistration,
		});

		expect(result).toMatchObject({ changed: false, reloadRequired: false });
	});

	it('requires a new CLI session when setup retargets the VS Code launch profile', async () => {
		const reconcileRegistration = vi.fn(async () => ({
			changed: false,
			reloadRequired: false,
			executable: 'copilot.exe',
		}));

		const result = await reconcileCopilotCliIntegration({
			executable: 'copilot.exe',
			connector: { ...connector, launchTargetChanged: true },
			reconcileRegistration,
		});

		expect(result).toMatchObject({ changed: true, reloadRequired: true });
	});
});