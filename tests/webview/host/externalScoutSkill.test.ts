import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	reconcileScoutSkill,
	removeScoutSkill,
	resolveScoutSkillPath,
} from '../../../src/host/externalScoutSkill';

const firstSkill = `---
name: kusto-workbench
description: Operate Kusto Workbench through its MCP server.
---

# Kusto Workbench

First version.
`;

describe('Scout-compatible Kusto Workbench skill', () => {
	it('packages a skill that orchestrates the routed MCP tools from natural language', () => {
		const source = readFileSync(resolve('copilot-instructions', 'external-scout-skill.md'), 'utf8');

		expect(source).toContain('name: kusto-workbench');
		expect(source).toContain('description:');
		expect(source).toContain('Do not make the user translate their request into individual tool calls.');
		expect(source).toContain('use `execute-tool` for `getWorkbenchGuidance`');
		expect(source).toContain('`list-tools`');
		expect(source).toContain('pass its exact `instanceId` inside `arguments`');
		expect(source).toContain('do not replay it');
		expect(source).toContain('This document is still loading and cannot accept mutations yet.');
		expect(source).toContain('`reveal: false`');
		expect(source).toContain('`saveWorkbenchFile`');
	});

	it('keeps the compact skill catalog aligned with every canonical operation', () => {
		const source = readFileSync(resolve('copilot-instructions', 'external-scout-skill.md'), 'utf8');
		const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
		const operations = [...source.matchAll(/^\| `([A-Za-z][A-Za-z0-9]+)` \| (.+) \|$/gm)];
		const expected = [
			'getWorkbenchGuidance', 'listWorkbenchInstances', 'checkWorkbenchInstance', 'launchWorkbenchInstance',
			...manifest.contributes.languageModelTools.map((tool: { toolReferenceName: string }) => tool.toolReferenceName),
		];
		expect(operations.map((match: RegExpMatchArray) => match[1]).sort()).toEqual(expected.sort());
		expect(operations.every((match: RegExpMatchArray) => match[2].trim().length > 8)).toBe(true);
	});

	it('uses the documented user skill directory under Copilot home', () => {
		expect(resolveScoutSkillPath('C:\\Users\\me\\.copilot'))
			.toBe(join('C:\\Users\\me\\.copilot', 'skills', 'kusto-workbench', 'SKILL.md'));
	});

	it('installs idempotently and removes only its unchanged managed skill', async () => {
		const copilotHomeDirectory = mkdtempSync(join(tmpdir(), 'kw-scout-skill-'));
		const skillPath = resolveScoutSkillPath(copilotHomeDirectory);
		try {
			const installed = await reconcileScoutSkill({ copilotHomeDirectory, sourceContent: firstSkill });
			const current = await reconcileScoutSkill({ copilotHomeDirectory, sourceContent: firstSkill });

			expect(installed).toMatchObject({ changed: true, status: 'installed', skillPath });
			expect(current).toMatchObject({ changed: false, status: 'current', skillPath });
			expect(await removeScoutSkill({ copilotHomeDirectory })).toEqual({ removed: true, skillPath });
			expect(existsSync(skillPath)).toBe(false);
		} finally {
			rmSync(copilotHomeDirectory, { recursive: true, force: true });
		}
	});

	it('preserves user-edited and unowned skills', async () => {
		const copilotHomeDirectory = mkdtempSync(join(tmpdir(), 'kw-scout-skill-conflict-'));
		const skillPath = resolveScoutSkillPath(copilotHomeDirectory);
		try {
			await reconcileScoutSkill({ copilotHomeDirectory, sourceContent: firstSkill });
			writeFileSync(skillPath, `${readFileSync(skillPath, 'utf8')}User edit.\n`);
			await expect(removeScoutSkill({ copilotHomeDirectory })).rejects.toThrow('user-edited');

			writeFileSync(skillPath, 'user-owned skill\n');
			await expect(reconcileScoutSkill({ copilotHomeDirectory, sourceContent: firstSkill }))
				.rejects.toThrow('not managed by Kusto Workbench');
			expect(readFileSync(skillPath, 'utf8')).toBe('user-owned skill\n');
		} finally {
			rmSync(copilotHomeDirectory, { recursive: true, force: true });
		}
	});
});