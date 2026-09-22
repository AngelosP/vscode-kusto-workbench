import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureScoutIntegration } from '../../../src/host/externalScoutIntegration';
import {
	inspectScoutMcpRegistration,
	preflightScoutMcpRegistration,
	reconcileScoutMcpRegistration,
	removeScoutMcpRegistration,
} from '../../../src/host/externalScoutMcpProvisioning';

const connector = {
	command: 'C:\\Users\\test user\\AppData\\Local\\KustoWorkbench\\McpConnector\\node.exe',
	args: ['C:\\Users\\test user\\AppData\\Local\\KustoWorkbench\\McpConnector\\bootstrap.cjs'],
};

const manualEntry = {
	builtin: false,
	config: { name: 'Kusto Workbench', type: 'command', command: connector.command, args: connector.args },
	tools: ['listWorkbenchInstances', 'createKustoFile'],
};

describe('Scout MCP registry provisioning', () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function fixture(contents?: string) {
		const root = mkdtempSync(join(tmpdir(), 'kw-scout-registration-'));
		roots.push(root);
		const configPath = join(root, '.scout', 'm-mcp-servers.json');
		const ownershipPath = join(root, 'workbench', 'scout-registration.json');
		mkdirSync(dirname(configPath), { recursive: true });
		if (contents !== undefined) writeFileSync(configPath, contents);
		return { connector, configPath, ownershipPath, isScoutRunning: vi.fn(async () => false) };
	}

	it('recognizes the manually added server without altering its config, tools, or ownership', async () => {
		const original = JSON.stringify({ servers: { kusto_workbench: manualEntry } }, null, 2);
		const options = fixture(original);
		options.isScoutRunning.mockResolvedValue(true);

		expect(await reconcileScoutMcpRegistration(options)).toMatchObject({ changed: false, managed: false, serverKey: 'kusto_workbench' });
		expect(readFileSync(options.configPath, 'utf8')).toBe(original);
		expect(existsSync(options.ownershipPath)).toBe(false);
	});

	it('installs, reopens, and removes only its entry while retaining unrelated and later changes', async () => {
		const original = '{\n  "future": 900719925474099312345,\n  "servers": { "other": { "builtin": false, "config": { "name": "Other", "type": "command", "command": "other.exe", "args": [], "auth": { "opaque": "do-not-touch" } }, "tools": ["other_tool"] } }\n}\n';
		const options = fixture(original);
		const installed = await reconcileScoutMcpRegistration(options);
		const firstBytes = readFileSync(options.configPath, 'utf8');
		const persisted = JSON.parse(firstBytes);
		expect(installed).toMatchObject({ changed: true, managed: true, serverKey: 'kusto_workbench' });
		expect(persisted.servers.kusto_workbench).toEqual({ ...manualEntry, tools: [] });
		expect(firstBytes).toContain('"future": 900719925474099312345');
		expect(persisted.servers.other).toEqual(JSON.parse(original).servers.other);
		expect(await reconcileScoutMcpRegistration(options)).toMatchObject({ changed: false, managed: true });
		expect(readFileSync(options.configPath, 'utf8')).toBe(firstBytes);

		persisted.servers.kusto_workbench.tools = ['listWorkbenchInstances'];
		persisted.servers.later = { builtin: true, tools: [] };
		writeFileSync(options.configPath, JSON.stringify(persisted));
		expect(await removeScoutMcpRegistration(options)).toMatchObject({ removed: true });
		expect(JSON.parse(readFileSync(options.configPath, 'utf8')).servers).toEqual({ other: persisted.servers.other, later: persisted.servers.later });
		expect(existsSync(options.ownershipPath)).toBe(false);
	});

	it('creates Scout defaults on first use without enabling automatic tool approval', async () => {
		const options = fixture();
		await reconcileScoutMcpRegistration(options);
		expect(JSON.parse(readFileSync(options.configPath, 'utf8'))).toEqual({ servers: {
			filesystem: { builtin: true, tools: [] },
			playwright: { builtin: true, tools: [] },
			kusto_workbench: { ...manualEntry, tools: [] },
		} });
	});

	it('does not overwrite Scout running state, malformed JSON, or conflicting registrations', async () => {
		const running = fixture('{"servers":{}}');
		running.isScoutRunning.mockResolvedValue(true);
		await expect(reconcileScoutMcpRegistration(running)).rejects.toThrow('Close Microsoft Scout');
		expect(readFileSync(running.configPath, 'utf8')).toBe('{"servers":{}}');
		const malformed = fixture('{"servers":');
		await expect(reconcileScoutMcpRegistration(malformed)).rejects.toThrow('invalid');
		expect(readFileSync(malformed.configPath, 'utf8')).toBe('{"servers":');
		const conflict = fixture(JSON.stringify({ servers: { kusto_workbench: { ...manualEntry, config: { ...manualEntry.config, command: 'someone-else.exe' } } } }));
		await expect(reconcileScoutMcpRegistration(conflict)).rejects.toThrow('different settings');
		expect(JSON.parse(readFileSync(conflict.configPath, 'utf8')).servers.kusto_workbench.config.command).toBe('someone-else.exe');
	});

	it('preserves manual registrations and edited managed registrations during cleanup', async () => {
		const manual = fixture(JSON.stringify({ servers: { kusto_workbench: manualEntry } }));
		expect(await removeScoutMcpRegistration(manual)).toMatchObject({ removed: false });
		expect(JSON.parse(readFileSync(manual.configPath, 'utf8')).servers.kusto_workbench).toEqual(manualEntry);
		const managed = fixture('{"servers":{}}');
		await reconcileScoutMcpRegistration(managed);
		const edited = JSON.parse(readFileSync(managed.configPath, 'utf8'));
		edited.servers.kusto_workbench.config.timeout = 300;
		writeFileSync(managed.configPath, JSON.stringify(edited));
		await expect(removeScoutMcpRegistration(managed)).rejects.toThrow('changed');
		expect(JSON.parse(readFileSync(managed.configPath, 'utf8')).servers.kusto_workbench.config.timeout).toBe(300);
	});

	it('rolls back only the added entry and refuses to remove a later replacement', async () => {
		const options = fixture('{"servers":{}}');
		const installed = await reconcileScoutMcpRegistration(options);
		const updated = JSON.parse(readFileSync(options.configPath, 'utf8'));
		updated.servers.other = { builtin: true, tools: [] };
		writeFileSync(options.configPath, JSON.stringify(updated));
		await installed.rollback?.();
		expect(JSON.parse(readFileSync(options.configPath, 'utf8')).servers).toEqual({ other: updated.servers.other });
		const reinstalled = await reconcileScoutMcpRegistration(options);
		updated.servers.kusto_workbench.config.command = 'replacement.exe';
		writeFileSync(options.configPath, JSON.stringify(updated));
		await expect(reinstalled.rollback?.()).rejects.toThrow('changed');
		expect(readFileSync(options.configPath, 'utf8')).toContain('replacement.exe');
	});

	it('preserves concurrent edits before registration and removal publish', async () => {
		const options = fixture('{"servers":{}}');
		const concurrent = '{"servers":{"other":{"builtin":true,"tools":[]}},"future":"new"}';
		await expect(reconcileScoutMcpRegistration({ ...options,
			beforeCommit: async () => { writeFileSync(options.configPath, concurrent); },
		})).rejects.toThrow('changed');
		expect(readFileSync(options.configPath, 'utf8')).toBe(concurrent);
		expect(existsSync(options.ownershipPath)).toBe(false);
		await reconcileScoutMcpRegistration(options);
		const ownership = readFileSync(options.ownershipPath, 'utf8');
		await expect(removeScoutMcpRegistration({ ...options,
			beforeCommit: async () => { writeFileSync(options.configPath, concurrent); },
		})).rejects.toThrow('changed');
		expect(readFileSync(options.configPath, 'utf8')).toBe(concurrent);
		expect(readFileSync(options.ownershipPath, 'utf8')).toBe(ownership);
	});

	it('rechecks Scout at commit and preserves registration during running-client cleanup', async () => {
		const options = fixture('{"servers":{}}');
		options.isScoutRunning.mockResolvedValueOnce(false).mockResolvedValue(true);
		await expect(reconcileScoutMcpRegistration(options)).rejects.toThrow('Close Microsoft Scout');
		expect(readFileSync(options.configPath, 'utf8')).toBe('{"servers":{}}');
		options.isScoutRunning.mockResolvedValue(false);
		await reconcileScoutMcpRegistration(options);
		const original = readFileSync(options.configPath, 'utf8');
		options.isScoutRunning.mockResolvedValue(true);
		await expect(removeScoutMcpRegistration(options)).rejects.toThrow('Close Microsoft Scout');
		expect(readFileSync(options.configPath, 'utf8')).toBe(original);
		expect(existsSync(options.ownershipPath)).toBe(true);
	});

	it('preflights without file writes and reports existing manual registration without claiming ownership', async () => {
		const options = fixture();
		options.isScoutRunning.mockResolvedValue(true);
		await expect(preflightScoutMcpRegistration(options)).rejects.toThrow('Close Microsoft Scout');
		expect(existsSync(options.configPath)).toBe(false);
		expect(existsSync(dirname(options.ownershipPath))).toBe(false);
		writeFileSync(options.configPath, JSON.stringify({ servers: { 'kusto-workbench': manualEntry } }));
		await preflightScoutMcpRegistration(options);
		expect(await inspectScoutMcpRegistration(options)).toEqual({ configured: true, managed: false });
	});

	it.each([
		'{"servers":{},"servers":{}}',
		'{"servers":[]}',
		JSON.stringify({ servers: { kusto_workbench: manualEntry, alias: manualEntry } }),
		JSON.stringify({ servers: { kusto_workbench: { ...manualEntry, builtin: true } } }),
		JSON.stringify({ servers: { kusto_workbench: { ...manualEntry, enabled: false } } }),
	])('fails closed for ambiguous or unsupported registry input %#', async original => {
		const options = fixture(original);
		await expect(reconcileScoutMcpRegistration(options)).rejects.toThrow();
		expect(readFileSync(options.configPath, 'utf8')).toBe(original);
		expect(existsSync(options.ownershipPath)).toBe(false);
	});
});

describe('Scout external integration provisioning', () => {
	it('registers the MCP server and skill before enabling the provider', async () => {
		const calls: string[] = [];
		const skillRollback = vi.fn(async () => { calls.push('skill rollback'); });
		const reconcileRegistration = vi.fn(async () => {
			calls.push('registration');
			return { changed: true, managed: true, serverKey: 'kusto_workbench', rollback: async () => { calls.push('registration rollback'); } };
		});
		const reconcileSkill = vi.fn(async () => {
			calls.push('skill');
			return {
				changed: true,
				status: 'installed' as const,
				skillPath: 'C:\\Users\\me\\.copilot\\skills\\kusto-workbench\\SKILL.md',
				rollback: skillRollback,
			};
		});
		const enableProvider = vi.fn(async () => { calls.push('provider'); });

		const result = await configureScoutIntegration({
			connector,
			skillSourceContent: 'skill',
			reconcileRegistration,
			reconcileSkill,
			enableProvider,
		});

		expect(calls).toEqual(['registration', 'skill', 'provider']);
		expect(result).toMatchObject({ changed: true, requiresNewConversation: true, requiresRestart: true });
	});

	it('rolls back a newly registered server when skill installation fails', async () => {
		const failure = new Error('skill conflict');
		const registrationRollback = vi.fn(async () => undefined);

		await expect(configureScoutIntegration({
			connector,
			skillSourceContent: 'skill',
			reconcileRegistration: async () => ({ changed: true, managed: true, serverKey: 'kusto_workbench', rollback: registrationRollback }),
			reconcileSkill: async () => { throw failure; },
			enableProvider: async () => undefined,
		})).rejects.toBe(failure);
		expect(registrationRollback).toHaveBeenCalledOnce();
	});

	it('rolls back the skill and registration in reverse order when provider enablement fails', async () => {
		const failure = new Error('setting unavailable');
		const rollbackOrder: string[] = [];
		const skillRollback = vi.fn(async () => { rollbackOrder.push('skill'); });
		const reconcileSkill = vi.fn(async () => ({
			changed: true,
			status: 'updated' as const,
			skillPath: 'SKILL.md',
			rollback: skillRollback,
		}));

		await expect(configureScoutIntegration({
			connector,
			skillSourceContent: 'skill',
			reconcileRegistration: async () => ({ changed: true, managed: true, serverKey: 'kusto_workbench', rollback: async () => { rollbackOrder.push('registration'); } }),
			reconcileSkill,
			enableProvider: async () => { throw failure; },
		})).rejects.toBe(failure);
		expect(skillRollback).toHaveBeenCalledOnce();
		expect(rollbackOrder).toEqual(['skill', 'registration']);
	});

	it('reports both the setup and rollback failures', async () => {
		const failure = new Error('setting unavailable');
		const rollbackFailure = new Error('skill rollback failed');
		const registrationRollback = vi.fn(async () => undefined);
		const reconcileSkill = vi.fn(async () => ({
			changed: true,
			status: 'updated' as const,
			skillPath: 'SKILL.md',
			rollback: async () => { throw rollbackFailure; },
		}));

		const rejected = await configureScoutIntegration({
			connector,
			skillSourceContent: 'skill',
			reconcileRegistration: async () => ({ changed: true, managed: true, serverKey: 'kusto_workbench', rollback: registrationRollback }),
			reconcileSkill,
			enableProvider: async () => { throw failure; },
		}).catch(error => error);

		expect(rejected).toBeInstanceOf(AggregateError);
		expect((rejected as AggregateError).errors).toEqual([failure, rollbackFailure]);
		expect(registrationRollback).toHaveBeenCalledOnce();
	});

	it('does not install a skill or enable the provider after a registry conflict', async () => {
		const reconcileSkill = vi.fn();
		const enableProvider = vi.fn();
		await expect(configureScoutIntegration({ connector, skillSourceContent: 'skill', reconcileSkill, enableProvider,
			reconcileRegistration: async () => { throw new Error('registration conflict'); },
		})).rejects.toThrow('registration conflict');
		expect(reconcileSkill).not.toHaveBeenCalled();
		expect(enableProvider).not.toHaveBeenCalled();
	});
});