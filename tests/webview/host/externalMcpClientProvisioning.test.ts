import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
	reconcileCopilotCliRegistration,
	removeCopilotCliRegistration,
	type ExecuteClientCommand,
} from '../../../src/host/externalMcpClientProvisioning';
import type { InstalledExternalMcpConnector } from '../../../src/host/externalMcpConnectorInstaller';

const connector: InstalledExternalMcpConnector = {
	root: 'C:\\Users\\me\\AppData\\Local\\KustoWorkbench\\McpConnector',
	versionDirectory: 'C:\\connector\\versions\\5.2.0',
	bootstrapPath: 'C:\\connector\\bootstrap.cjs',
	command: 'C:\\connector\\node.exe',
	args: ['C:\\connector\\bootstrap.cjs'],
	connectorVersion: '5.2.0',
	schemaHash: 'a'.repeat(64),
};

function result(mcpServers: Record<string, unknown>, exitCode = 0) {
	return { exitCode, stdout: JSON.stringify({ mcpServers }), stderr: '' };
}

describe('Copilot CLI MCP provisioning', () => {
	it.runIf(process.platform === 'win32')('converges and removes the registration through a real isolated Copilot CLI home', async () => {
		const home = mkdtempSync(join(tmpdir(), 'kw-copilot-home-'));
		try {
			const where = execFileSync(join(process.env.SystemRoot!, 'System32', 'where.exe'), ['copilot'], { encoding: 'utf8' });
			const executable = where.split(/\r?\n/).map(value => value.trim())
				.find(value => value.toLowerCase().endsWith('.exe'))!;
			const execute: ExecuteClientCommand = (command, args) => new Promise((resolve, reject) => {
				execFile(command, [...args], {
					windowsHide: true,
					timeout: 30_000,
					env: { ...process.env, COPILOT_HOME: home, COPILOT_AUTO_UPDATE: 'false' },
				}, (error, stdout, stderr) => {
					if (error && typeof (error as { code?: unknown }).code !== 'number') reject(error);
					else resolve({
						exitCode: typeof (error as { code?: unknown } | null)?.code === 'number'
							? (error as unknown as { code: number }).code
							: 0,
						stdout,
						stderr,
					});
				});
			});

			const first = await reconcileCopilotCliRegistration({ executable, connector, execute });
			const second = await reconcileCopilotCliRegistration({ executable, connector, execute });
			const removed = await removeCopilotCliRegistration({ executable, connector, execute });
			const list = await execute(executable, ['mcp', 'list', '--json']);

			expect(first.changed).toBe(true);
			expect(second.changed).toBe(false);
			expect(removed).toEqual({ removed: true });
			expect(JSON.parse(list.stdout).mcpServers['kusto-workbench']).toBeUndefined();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}, 60_000);

	it('adds and verifies one user registration through the supported CLI', async () => {
		const execute = vi.fn<ExecuteClientCommand>()
			.mockResolvedValueOnce(result({}))
			.mockResolvedValueOnce({ exitCode: 0, stdout: '{}', stderr: '' })
			.mockResolvedValueOnce(result({
				'kusto-workbench': { type: 'stdio', command: connector.command, args: connector.args, tools: ['*'], source: 'user', enabled: true },
			}));

		const registration = await reconcileCopilotCliRegistration({ executable: 'copilot.exe', connector, execute });

		expect(registration.changed).toBe(true);
		expect(execute.mock.calls[1][1]).toEqual([
			'mcp', 'add', '--tools', '*', '--timeout', '7500000', 'kusto-workbench', '--', connector.command, ...connector.args,
		]);
	});

	it('returns exact compensation for a newly added registration', async () => {
		const execute = vi.fn<ExecuteClientCommand>()
			.mockResolvedValueOnce(result({}))
			.mockResolvedValueOnce({ exitCode: 0, stdout: '{}', stderr: '' })
			.mockResolvedValueOnce(result({
				'kusto-workbench': { type: 'stdio', command: connector.command, args: connector.args, tools: ['*'], source: 'user', enabled: true },
			}))
			.mockResolvedValueOnce(result({
				'kusto-workbench': { type: 'stdio', command: connector.command, args: connector.args, tools: ['*'], source: 'user', enabled: true },
			}))
			.mockResolvedValueOnce({ exitCode: 0, stdout: '{}', stderr: '' })
			.mockResolvedValueOnce(result({}));

		const registration = await reconcileCopilotCliRegistration({ executable: 'copilot.exe', connector, execute });
		await registration.rollback?.();

		expect(execute.mock.calls[4][1]).toEqual(['mcp', 'remove', 'kusto-workbench']);
	});

	it('is idempotent for an exact enabled registration', async () => {
		const exact = { type: 'stdio', command: connector.command, args: connector.args, tools: ['*'], source: 'user', enabled: true };
		const execute = vi.fn<ExecuteClientCommand>()
			.mockResolvedValue(result({ 'kusto-workbench': exact }));

		expect(await reconcileCopilotCliRegistration({ executable: 'copilot.exe', connector, execute }))
			.toMatchObject({ changed: false, reloadRequired: false });
		expect(execute).toHaveBeenCalledTimes(2);
	});

	it('preserves a conflicting user registration instead of attempting a destructive replacement', async () => {
		const execute = vi.fn<ExecuteClientCommand>()
			.mockResolvedValue(result({
				other: { source: 'user' },
				'kusto-workbench': { type: 'stdio', command: 'old.exe', args: [], tools: ['*'], source: 'user', enabled: true },
			}));

		await expect(reconcileCopilotCliRegistration({ executable: 'copilot.exe', connector, execute }))
			.rejects.toThrow('existing registration was not modified');
		expect(execute).toHaveBeenCalledOnce();
	});

	it('preserves a concurrent replacement when verification rejects the added registration', async () => {
		const replacement = {
			type: 'stdio', command: 'unexpected.exe', args: [], tools: ['*'], source: 'user', enabled: true,
		};
		const execute = vi.fn<ExecuteClientCommand>()
			.mockResolvedValueOnce(result({}))
			.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
			.mockResolvedValueOnce(result({ 'kusto-workbench': replacement }))
			.mockResolvedValueOnce(result({ 'kusto-workbench': replacement }));

		await expect(reconcileCopilotCliRegistration({ executable: 'copilot.exe', connector, execute }))
			.rejects.toThrow('could not be removed');
		expect(execute.mock.calls.some(([, args]) => args[1] === 'remove')).toBe(false);
	});

	it('removes a newly added registration when verification throws', async () => {
		const execute = vi.fn<ExecuteClientCommand>()
			.mockResolvedValueOnce(result({}))
			.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'verification unavailable' })
			.mockResolvedValueOnce(result({
				'kusto-workbench': { type: 'stdio', command: connector.command, args: connector.args, tools: ['*'], source: 'user', enabled: true },
			}))
			.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
			.mockResolvedValueOnce(result({}));

		await expect(reconcileCopilotCliRegistration({ executable: 'copilot.exe', connector, execute }))
			.rejects.toThrow('verification unavailable');
		expect(execute.mock.calls[4][1]).toEqual(['mcp', 'remove', 'kusto-workbench']);
	});

	it('does not enable an exact disabled registration owned by another source', async () => {
		const execute = vi.fn<ExecuteClientCommand>().mockResolvedValue(result({
			'kusto-workbench': {
				type: 'stdio', command: connector.command, args: connector.args, tools: ['*'], source: 'workspace', enabled: false,
			},
		}));

		await expect(reconcileCopilotCliRegistration({ executable: 'copilot.exe', connector, execute }))
			.rejects.toThrow('comes from workspace and was not modified');
		expect(execute).toHaveBeenCalledOnce();
	});

	it('disables an existing user registration again when verification fails', async () => {
		const disabled = {
			type: 'stdio', command: connector.command, args: connector.args, tools: ['*'], source: 'user', enabled: false,
		};
		const execute = vi.fn<ExecuteClientCommand>()
			.mockResolvedValueOnce(result({ 'kusto-workbench': disabled }))
			.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'verification unavailable' })
			.mockResolvedValueOnce(result({
				'kusto-workbench': { ...disabled, enabled: true },
			}))
			.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
			.mockResolvedValueOnce(result({ 'kusto-workbench': disabled }));

		await expect(reconcileCopilotCliRegistration({ executable: 'copilot.exe', connector, execute }))
			.rejects.toThrow('verification unavailable');
		expect(execute.mock.calls[1][1]).toEqual(['mcp', 'enable', 'kusto-workbench']);
		expect(execute.mock.calls[4][1]).toEqual(['mcp', 'disable', 'kusto-workbench']);
	});

	it('refuses to overwrite a conflicting non-user source', async () => {
		const execute = vi.fn<ExecuteClientCommand>()
			.mockResolvedValue(result({
				'kusto-workbench': { type: 'stdio', command: 'workspace.exe', args: [], tools: ['*'], source: 'workspace', enabled: true },
			}));

		await expect(reconcileCopilotCliRegistration({ executable: 'copilot.exe', connector, execute }))
			.rejects.toThrow('from workspace');
		expect(execute).toHaveBeenCalledOnce();
	});

	it('removes only the user-owned registration and verifies removal', async () => {
		const exact = {
			type: 'stdio', command: connector.command, args: connector.args, tools: ['*'], source: 'user', enabled: true,
		};
		const execute = vi.fn<ExecuteClientCommand>()
			.mockResolvedValueOnce(result({
				other: { source: 'user' },
				'kusto-workbench': exact,
			}))
			.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
			.mockResolvedValueOnce(result({ other: { source: 'user' } }));

		expect(await removeCopilotCliRegistration({ executable: 'copilot.exe', connector, execute })).toEqual({ removed: true });
		expect(execute.mock.calls[1][1]).toEqual(['mcp', 'remove', 'kusto-workbench']);
	});

	it('preserves a user registration that no longer matches the installed connector', async () => {
		const replacement = {
			type: 'stdio', command: 'replacement.exe', args: ['server.js'], tools: ['*'], source: 'user', enabled: true,
		};
		const execute = vi.fn<ExecuteClientCommand>()
			.mockResolvedValue(result({ 'kusto-workbench': replacement }));

		await expect(removeCopilotCliRegistration({ executable: 'copilot.exe', connector, execute }))
			.rejects.toThrow('different settings');
		expect(execute).toHaveBeenCalledOnce();
	});
});