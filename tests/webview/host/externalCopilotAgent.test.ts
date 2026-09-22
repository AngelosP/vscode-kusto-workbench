import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	createManagedCopilotCliAgentContent,
	reconcileManagedExternalCustomization,
	reconcileCopilotCliAgent,
	removeManagedExternalCustomization,
	removeCopilotCliAgent,
	resolveCopilotHomeDirectory,
} from '../../../src/host/externalCopilotAgent';

const firstAgent = `---
name: Kusto Workbench
target: github-copilot
tools: ['kusto-workbench/*']
---

# Kusto Workbench

First version.
`;

const secondAgent = firstAgent.replace('First version.', 'Second version.');

describe('Copilot CLI user-level agent', () => {
	it('packages a GitHub Copilot agent that orchestrates the routed MCP tool set', () => {
		const source = readFileSync(resolve('copilot-instructions', 'external-copilot-agent.md'), 'utf8');

		expect(source).toContain('name: Kusto Workbench');
		expect(source).toContain('target: github-copilot');
		expect(source).toContain('kusto-workbench/*');
		expect(source).toContain('Do not make the user translate their request into individual tool calls.');
		expect(source).toContain('call `getWorkbenchGuidance`');
		expect(source).toContain('pass its exact `instanceId` to every Workbench tool call');
		expect(source).toContain('do not replay it');
		expect(source).toContain('`reveal: false`');
		expect(source).toContain('`saveWorkbenchFile`');
	});

	it('uses COPILOT_HOME when present and otherwise the documented user directory', () => {
		expect(resolveCopilotHomeDirectory({ COPILOT_HOME: 'C:\\isolated-copilot' }, 'C:\\Users\\me'))
			.toBe('C:\\isolated-copilot');
		expect(resolveCopilotHomeDirectory({}, 'C:\\Users\\me'))
			.toBe(join('C:\\Users\\me', '.copilot'));
	});

	it('installs once and leaves an exact managed agent untouched', async () => {
		const copilotHomeDirectory = mkdtempSync(join(tmpdir(), 'kw-copilot-agent-'));
		const agentPath = join(copilotHomeDirectory, 'agents', 'kusto-workbench.agent.md');
		try {
			const installed = await reconcileCopilotCliAgent({ copilotHomeDirectory, sourceContent: firstAgent });
			const initialBytes = readFileSync(agentPath, 'utf8');
			const current = await reconcileCopilotCliAgent({ copilotHomeDirectory, sourceContent: firstAgent });

			expect(installed).toMatchObject({ changed: true, status: 'installed', agentPath });
			expect(initialBytes).toBe(createManagedCopilotCliAgentContent(firstAgent));
			expect(current).toMatchObject({ changed: false, status: 'current', agentPath });
			expect(readFileSync(agentPath, 'utf8')).toBe(initialBytes);
		} finally {
			rmSync(copilotHomeDirectory, { recursive: true, force: true });
		}
	});

	it('updates an untouched managed agent and can restore it exactly', async () => {
		const copilotHomeDirectory = mkdtempSync(join(tmpdir(), 'kw-copilot-agent-update-'));
		const agentPath = join(copilotHomeDirectory, 'agents', 'kusto-workbench.agent.md');
		try {
			await reconcileCopilotCliAgent({ copilotHomeDirectory, sourceContent: firstAgent });
			const previousBytes = readFileSync(agentPath, 'utf8');
			const updated = await reconcileCopilotCliAgent({ copilotHomeDirectory, sourceContent: secondAgent });

			expect(updated).toMatchObject({ changed: true, status: 'updated', agentPath });
			expect(readFileSync(agentPath, 'utf8')).toBe(createManagedCopilotCliAgentContent(secondAgent));
			await updated.rollback?.();
			expect(readFileSync(agentPath, 'utf8')).toBe(previousBytes);
		} finally {
			rmSync(copilotHomeDirectory, { recursive: true, force: true });
		}
	});

	it('preserves unowned and user-edited agent files', async () => {
		const copilotHomeDirectory = mkdtempSync(join(tmpdir(), 'kw-copilot-agent-conflict-'));
		const agentsDirectory = join(copilotHomeDirectory, 'agents');
		const agentPath = join(agentsDirectory, 'kusto-workbench.agent.md');
		try {
			await reconcileCopilotCliAgent({ copilotHomeDirectory, sourceContent: firstAgent });
			writeFileSync(agentPath, `${readFileSync(agentPath, 'utf8')}User edit.\n`);
			await expect(reconcileCopilotCliAgent({ copilotHomeDirectory, sourceContent: secondAgent }))
				.rejects.toThrow('user-edited');
			expect(readFileSync(agentPath, 'utf8')).toContain('User edit.');

			writeFileSync(agentPath, 'user-owned agent\n');
			await expect(reconcileCopilotCliAgent({ copilotHomeDirectory, sourceContent: firstAgent }))
				.rejects.toThrow('not managed by Kusto Workbench');
			expect(readFileSync(agentPath, 'utf8')).toBe('user-owned agent\n');
		} finally {
			rmSync(copilotHomeDirectory, { recursive: true, force: true });
		}
	});

	it('rolls back a fresh install only while its bytes remain unchanged', async () => {
		const copilotHomeDirectory = mkdtempSync(join(tmpdir(), 'kw-copilot-agent-rollback-'));
		const agentPath = join(copilotHomeDirectory, 'agents', 'kusto-workbench.agent.md');
		try {
			const installed = await reconcileCopilotCliAgent({ copilotHomeDirectory, sourceContent: firstAgent });
			await installed.rollback?.();
			expect(existsSync(agentPath)).toBe(false);

			const changed = await reconcileCopilotCliAgent({ copilotHomeDirectory, sourceContent: firstAgent });
			writeFileSync(agentPath, `${readFileSync(agentPath, 'utf8')}User edit.\n`);
			await expect(changed.rollback?.()).rejects.toThrow('user-edited');
			expect(existsSync(agentPath)).toBe(true);
		} finally {
			rmSync(copilotHomeDirectory, { recursive: true, force: true });
		}
	});

	it('removes only an unchanged managed agent', async () => {
		const copilotHomeDirectory = mkdtempSync(join(tmpdir(), 'kw-copilot-agent-remove-'));
		const agentPath = join(copilotHomeDirectory, 'agents', 'kusto-workbench.agent.md');
		try {
			await reconcileCopilotCliAgent({ copilotHomeDirectory, sourceContent: firstAgent });
			expect(await removeCopilotCliAgent({ copilotHomeDirectory })).toEqual({ removed: true, agentPath });
			expect(existsSync(agentPath)).toBe(false);
			expect(await removeCopilotCliAgent({ copilotHomeDirectory })).toEqual({ removed: false, agentPath });

			writeFileSync(agentPath, 'user-owned agent\n');
			await expect(removeCopilotCliAgent({ copilotHomeDirectory }))
				.rejects.toThrow('not managed by Kusto Workbench');
			expect(readFileSync(agentPath, 'utf8')).toBe('user-owned agent\n');
		} finally {
			rmSync(copilotHomeDirectory, { recursive: true, force: true });
		}
	});

	it('preserves a concurrent user replacement during managed update and removal', async () => {
		const copilotHomeDirectory = mkdtempSync(join(tmpdir(), 'kw-copilot-agent-race-'));
		const agentPath = join(copilotHomeDirectory, 'agents', 'kusto-workbench.agent.md');
		try {
			await reconcileCopilotCliAgent({ copilotHomeDirectory, sourceContent: firstAgent });
			await expect(reconcileManagedExternalCustomization({
				path: agentPath,
				sourceContent: secondAgent,
				artifactName: 'Copilot CLI agent',
				beforeCommit: async () => { writeFileSync(agentPath, 'concurrent user replacement\n'); },
			})).rejects.toThrow('changed during update');
			expect(readFileSync(agentPath, 'utf8')).toBe('concurrent user replacement\n');

			rmSync(agentPath, { force: true });
			await reconcileCopilotCliAgent({ copilotHomeDirectory, sourceContent: firstAgent });
			await expect(removeManagedExternalCustomization({
				path: agentPath,
				artifactName: 'Copilot CLI agent',
				beforeCommit: async () => { writeFileSync(agentPath, 'concurrent user replacement\n'); },
			})).rejects.toThrow('changed during removal');
			expect(readFileSync(agentPath, 'utf8')).toBe('concurrent user replacement\n');
		} finally {
			rmSync(copilotHomeDirectory, { recursive: true, force: true });
		}
	});
});