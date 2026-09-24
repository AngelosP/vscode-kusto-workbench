import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	createManagedCopilotCliAgentContent,
	reconcileManagedExternalCustomization,
	removeManagedExternalCustomization,
	removeCopilotCliAgent,
	retireManagedCopilotCliAgent,
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

async function installLegacyAgent(options: { copilotHomeDirectory?: string; sourceContent: string }) {
	const copilotHomeDirectory = options.copilotHomeDirectory ?? resolveCopilotHomeDirectory();
	const managed = await reconcileManagedExternalCustomization({
		path: join(copilotHomeDirectory, 'agents', 'kusto-workbench.agent.md'),
		sourceContent: options.sourceContent,
		artifactName: 'Copilot CLI agent',
	});
	return { changed: managed.changed, status: managed.status, agentPath: managed.path, rollback: managed.rollback };
}

describe('managed customizations and legacy Copilot CLI agent removal', () => {
	it('does not retain the retired Copilot CLI agent source', () => {
		expect(existsSync(resolve('copilot-instructions', 'external-copilot-agent.md'))).toBe(false);
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
			const installed = await installLegacyAgent({ copilotHomeDirectory, sourceContent: firstAgent });
			const initialBytes = readFileSync(agentPath, 'utf8');
			const current = await installLegacyAgent({ copilotHomeDirectory, sourceContent: firstAgent });

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
			await installLegacyAgent({ copilotHomeDirectory, sourceContent: firstAgent });
			const previousBytes = readFileSync(agentPath, 'utf8');
			const updated = await installLegacyAgent({ copilotHomeDirectory, sourceContent: secondAgent });

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
			await installLegacyAgent({ copilotHomeDirectory, sourceContent: firstAgent });
			writeFileSync(agentPath, `${readFileSync(agentPath, 'utf8')}User edit.\n`);
			await expect(installLegacyAgent({ copilotHomeDirectory, sourceContent: secondAgent }))
				.rejects.toThrow('user-edited');
			expect(readFileSync(agentPath, 'utf8')).toContain('User edit.');

			writeFileSync(agentPath, 'user-owned agent\n');
			await expect(installLegacyAgent({ copilotHomeDirectory, sourceContent: firstAgent }))
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
			const installed = await installLegacyAgent({ copilotHomeDirectory, sourceContent: firstAgent });
			await installed.rollback?.();
			expect(existsSync(agentPath)).toBe(false);

			const changed = await installLegacyAgent({ copilotHomeDirectory, sourceContent: firstAgent });
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
			await installLegacyAgent({ copilotHomeDirectory, sourceContent: firstAgent });
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

	it('retires an unchanged legacy agent without touching edited or user-owned files', async () => {
		const copilotHomeDirectory = mkdtempSync(join(tmpdir(), 'kw-copilot-agent-retire-'));
		const agentPath = join(copilotHomeDirectory, 'agents', 'kusto-workbench.agent.md');
		try {
			await installLegacyAgent({ copilotHomeDirectory, sourceContent: firstAgent });
			expect(await retireManagedCopilotCliAgent({ copilotHomeDirectory }))
				.toEqual({ status: 'removed', agentPath });
			expect(existsSync(agentPath)).toBe(false);
			expect(await retireManagedCopilotCliAgent({ copilotHomeDirectory }))
				.toEqual({ status: 'absent', agentPath });

			await installLegacyAgent({ copilotHomeDirectory, sourceContent: firstAgent });
			const edited = `${readFileSync(agentPath, 'utf8')}User edit.\n`;
			writeFileSync(agentPath, edited);
			expect(await retireManagedCopilotCliAgent({ copilotHomeDirectory }))
				.toEqual({ status: 'preserved', agentPath });
			expect(readFileSync(agentPath, 'utf8')).toBe(edited);

			writeFileSync(agentPath, 'user-owned agent\n');
			expect(await retireManagedCopilotCliAgent({ copilotHomeDirectory }))
				.toEqual({ status: 'preserved', agentPath });
			expect(readFileSync(agentPath, 'utf8')).toBe('user-owned agent\n');
		} finally {
			rmSync(copilotHomeDirectory, { recursive: true, force: true });
		}
	});

	it('preserves a concurrent user replacement during managed update and removal', async () => {
		const copilotHomeDirectory = mkdtempSync(join(tmpdir(), 'kw-copilot-agent-race-'));
		const agentPath = join(copilotHomeDirectory, 'agents', 'kusto-workbench.agent.md');
		try {
			await installLegacyAgent({ copilotHomeDirectory, sourceContent: firstAgent });
			await expect(reconcileManagedExternalCustomization({
				path: agentPath,
				sourceContent: secondAgent,
				artifactName: 'Copilot CLI agent',
				beforeCommit: async () => { writeFileSync(agentPath, 'concurrent user replacement\n'); },
			})).rejects.toThrow('changed during update');
			expect(readFileSync(agentPath, 'utf8')).toBe('concurrent user replacement\n');

			rmSync(agentPath, { force: true });
			await installLegacyAgent({ copilotHomeDirectory, sourceContent: firstAgent });
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