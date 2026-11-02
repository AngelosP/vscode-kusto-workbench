import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import {
	acquireExternalMcpConnectorLock,
	type InstalledExternalMcpConnector,
} from '../../../src/host/externalMcpConnectorInstaller';
import {
	assertExternalToolsConfigurationRegistered,
	createGenericMcpConfiguration,
	disableExternalMcpIntegration,
	executeVsCodeCli,
	installProviderBootstrap,
	removeInstalledExternalMcpConnector,
	runExternalMcpSetup,
	showExternalMcpStatus,
	uninstallProviderBootstrap,
	updateExternalToolsEnabledWithRollback,
} from '../../../src/host/externalMcpSetup';
import { createManagedCopilotCliAgentContent } from '../../../src/host/externalCopilotAgent';
import * as connectorInstaller from '../../../src/host/externalMcpConnectorInstaller';
import * as scoutProvisioning from '../../../src/host/externalScoutMcpProvisioning';
import * as scoutSkill from '../../../src/host/externalScoutSkill';
import * as clientProvisioning from '../../../src/host/externalMcpClientProvisioning';
import * as copilotCode from '../../../src/host/externalCopilotCodeIntegration';

vi.mock('vscode', async importOriginal => {
	const original = await importOriginal<typeof import('vscode')>();
	return {
		...original,
		UIKind: { Desktop: 1, Web: 2 },
		ProgressLocation: { Notification: 15 },
		CancellationError: class extends Error {},
		env: { ...original.env, uiKind: 1 },
	};
});

const connector: InstalledExternalMcpConnector = {
	root: 'C:\\Users\\me\\AppData\\Local\\KustoWorkbench\\McpConnector',
	versionDirectory: 'C:\\connector\\versions\\5.2.0',
	bootstrapPath: 'C:\\connector\\bootstrap.cjs',
	command: 'C:\\connector\\node.exe',
	args: ['C:\\connector\\bootstrap.cjs'],
	connectorVersion: '5.2.0',
	schemaHash: 'a'.repeat(64),
};

function findVsCodeCli(): string | undefined {
	if (process.platform !== 'win32' || !process.env.SystemRoot) return undefined;
	try {
		return execFileSync(join(process.env.SystemRoot, 'System32', 'where.exe'), ['code.cmd'], { encoding: 'utf8' })
			.split(/\r?\n/).map(line => line.trim()).find(line => line.toLowerCase().endsWith('code.cmd'));
	} catch {
		return undefined;
	}
}

const vsCodeCli = findVsCodeCli();

describe('external MCP setup', () => {
	it.each(['available', 'missing', 'directory', 'download-failed'] as const)(
		'prepares the isolated VS Code CLI before Windows CI verification (%s)', async scenario => {
			const workflow = readFileSync(resolve('.github/workflows/build.yml'), 'utf8');
			const windows = workflow.slice(workflow.indexOf('  connector-runtime-windows:'));
			const preparation = windows.indexOf('      - name: Prepare isolated VS Code CLI');
			const verification = windows.indexOf('      - name: Verify packaged Windows connector');
			const coldLaunch = windows.indexOf('      - name: Verify packaged cold launch and report lifecycle');
			expect(preparation).toBeGreaterThanOrEqual(0);
			expect(preparation).toBeLessThan(verification);
			expect(preparation).toBeLessThan(coldLaunch);
			expect(windows.slice(verification, coldLaunch)).toContain('tests/webview/host/externalMcpConnectorCore.test.ts');
			const script = windows.slice(preparation, verification).match(/^\s+node -e "(.+)"\r?$/m)?.[1];
			if (!script) throw new Error('Windows CI does not contain its executable portable CLI setup.');
			const root = mkdtempSync(join(tmpdir(), 'kw-ci-vscode-cli-'));
			const executable = join(root, 'Code.exe');
			const cli = join(root, 'bin', 'code.cmd');
			const githubPath = join(root, 'github-path');
			const download = vi.fn().mockResolvedValue(executable);
			if (scenario === 'download-failed') download.mockRejectedValue(new Error('Download unavailable'));
			const resolveCli = vi.fn().mockReturnValue(cli);
			const output = { log: vi.fn(), error: vi.fn() };
			const processState: { env: { GITHUB_PATH: string }; exitCode?: number } = { env: { GITHUB_PATH: githubPath } };
			mkdirSync(dirname(cli));
			if (scenario === 'available') writeFileSync(cli, '@echo off\r\n');
			if (scenario === 'directory') mkdirSync(cli);
			const dependencies: Record<string, unknown> = {
				'node:fs': { appendFileSync, statSync },
				'node:path': { dirname },
				'@vscode/test-electron': { downloadAndUnzipVSCode: download, resolveCliPathFromVSCodeExecutablePath: resolveCli },
			};
			try {
				await runInNewContext(script, {
					require: (name: string) => {
						if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected CI setup dependency: ${name}`);
						return dependencies[name];
					},
					process: processState,
					console: output,
				});
				expect(download).toHaveBeenCalledOnce();
				if (scenario === 'available') {
					expect(resolveCli).toHaveBeenCalledExactlyOnceWith(executable);
					expect(readFileSync(githubPath, 'utf8')).toBe(`${dirname(cli)}\n`);
					expect(processState.exitCode).toBeUndefined();
					expect(output.error).not.toHaveBeenCalled();
					expect(output.log).toHaveBeenCalledOnce();
				} else {
					expect(existsSync(githubPath)).toBe(false);
					expect(processState.exitCode).toBe(1);
					expect(output.error).toHaveBeenCalledOnce();
					expect(output.log).not.toHaveBeenCalled();
					if (scenario === 'download-failed') expect(resolveCli).not.toHaveBeenCalled();
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it('requires the current configuration registry before setup mutates integration state', () => {
		expect(() => assertExternalToolsConfigurationRegistered(undefined))
			.toThrow('Developer: Reload Window');
		expect(() => assertExternalToolsConfigurationRegistered({ defaultValue: false }))
			.not.toThrow();
	});

	it('provides portable stdio fields without pretending every client shares one file format', () => {
		expect(createGenericMcpConfiguration(connector)).toEqual({
			mcpServers: {
				'kusto-workbench': {
					type: 'stdio',
					command: connector.command,
					args: connector.args,
					tools: ['*'],
				},
			},
		});
	});

	it('preflights automatic Scout registration before installing shared connector state', () => {
		const source = readFileSync(resolve('src/host/externalMcpSetup.ts'), 'utf8');
		const setup = source.slice(source.indexOf('export async function runExternalMcpSetup'));
		expect(setup.indexOf('await preflightScoutMcpRegistration')).toBeLessThan(setup.indexOf('await acquireExternalMcpConnectorLock'));
		expect(source).toMatch(/configureScoutIntegration\(\{\s+connector,/);
		expect(source).toContain('close Scout before first-time registration');
		expect(source).toContain('Tool approvals remain controlled by Scout.');
		expect(source).not.toContain('createScoutSetupInstructions');
	});

	it.runIf(process.platform === 'win32').each([true, false])('configures the selected Scout client, checks status, and removes only owned artifacts (new registration: %s)', async registrationChanged => {
		const cliRoot = mkdtempSync(join(tmpdir(), 'kw-scout-setup-cli-'));
		mkdirSync(join(cliRoot, 'bin'));
		writeFileSync(join(cliRoot, 'bin', 'code.cmd'), '@echo off\r\necho angelos-petropoulos.vscode-kusto-workbench@5.2.0\r\necho angelos-petropoulos.kusto-workbench-mcp-bootstrap@0.0.0\r\n');
		const originalWindow = Object.getOwnPropertyDescriptors(vscode.window);
		const originalExecPath = process.execPath;
		const events: string[] = [];
		const getConfiguration = vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
			inspect: () => ({ defaultValue: false }),
			get: () => true,
			update: vi.fn(async () => { events.push('provider'); }),
		} as never);
		const register = vi.spyOn(scoutProvisioning, 'reconcileScoutMcpRegistration').mockImplementation(async () => {
			events.push('registration');
			return { changed: registrationChanged, managed: registrationChanged, serverKey: 'kusto_workbench' };
		});
		const preflight = vi.spyOn(scoutProvisioning, 'preflightScoutMcpRegistration').mockResolvedValue(undefined);
		const inspect = vi.spyOn(scoutProvisioning, 'inspectScoutMcpRegistration').mockResolvedValue({ configured: true, managed: registrationChanged });
		const remove = vi.spyOn(scoutProvisioning, 'removeScoutMcpRegistration').mockResolvedValue({ removed: registrationChanged });
		const installSkill = vi.spyOn(scoutSkill, 'reconcileScoutSkill').mockImplementation(async () => {
			events.push('skill');
			return { changed: registrationChanged, status: registrationChanged ? 'installed' : 'current', skillPath: 'isolated/SKILL.md' };
		});
		const removeSkill = vi.spyOn(scoutSkill, 'removeScoutSkill').mockResolvedValue({ removed: true, skillPath: 'isolated/SKILL.md' });
		const lock = vi.spyOn(connectorInstaller, 'acquireExternalMcpConnectorLock').mockResolvedValue(async () => undefined);
		const install = vi.spyOn(connectorInstaller, 'installExternalMcpConnector').mockResolvedValue(connector);
		const list = vi.spyOn(clientProvisioning, 'executeClientCommand').mockResolvedValue({ exitCode: 0, stdout: '{"mcpServers":{}}', stderr: '' });
		const pick = vi.fn().mockResolvedValueOnce({ clientKind: 'scout' }).mockResolvedValueOnce({ value: 'default' });
		const info = vi.fn();
		const warning = vi.fn().mockResolvedValue('Continue');
		Object.assign(vscode.window, {
			showQuickPick: pick, showInformationMessage: info, showWarningMessage: warning,
			withProgress: async (_options: unknown, action: () => Promise<unknown>) => action(),
		});
		process.execPath = join(cliRoot, 'Code.exe');
		try {
			const context = { extensionUri: vscode.Uri.file(resolve('.')), extension: { packageJSON: { version: '5.2.0' } } } as unknown as vscode.ExtensionContext;
			const result = await runExternalMcpSetup(context, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
			expect(result).toEqual({ client: 'scout', integrationEnabled: true, fullyConfigured: true, requiresClientReload: registrationChanged });
			expect(events).toEqual(['registration', 'skill', 'provider']);
			expect(preflight).toHaveBeenCalledOnce();
			expect(register).toHaveBeenCalledWith({ connector });
			expect(installSkill.mock.calls[0][0].sourceContent).toContain('# Kusto Workbench Skill');
			expect(info.mock.calls[0][0]).toContain(registrationChanged ? 'Open or restart Scout' : 'Start a new conversation');
			await showExternalMcpStatus();
			expect(info.mock.calls[1][0]).toContain(registrationChanged ? 'Scout: configured, managed' : 'Scout: configured, existing registration');
			pick.mockResolvedValueOnce([{ id: 'scout' }]);
			inspect.mockResolvedValue({ configured: !registrationChanged, managed: false });
			await disableExternalMcpIntegration();
			expect(remove).toHaveBeenCalledOnce();
			expect(removeSkill).toHaveBeenCalledOnce();
			if (!registrationChanged) expect(warning.mock.calls.at(-1)?.[0]).toContain('preserved because Workbench did not create it');
		} finally {
			process.execPath = originalExecPath;
			for (const key of ['showQuickPick', 'showInformationMessage', 'showWarningMessage', 'withProgress']) {
				const descriptor = originalWindow[key];
				if (descriptor) Object.defineProperty(vscode.window, key, descriptor);
				else Reflect.deleteProperty(vscode.window, key);
			}
			for (const mock of [getConfiguration, register, preflight, inspect, remove, installSkill, removeSkill, lock, install, list]) mock.mockRestore();
			rmSync(cliRoot, { recursive: true, force: true });
		}
	});

	it('restores a changed client registration when provider enablement fails', async () => {
		const settingError = new Error('setting write failed');
		const rollback = vi.fn(async () => undefined);

		await expect(updateExternalToolsEnabledWithRollback(
			async () => { throw settingError; },
			rollback,
		)).rejects.toBe(settingError);
		expect(rollback).toHaveBeenCalledOnce();
	});

	it.runIf(process.platform === 'win32').each(['fresh', 'managed', 'edited', 'unowned', 'enable-failed'] as const)(
		'configures Copilot CLI without a second agent and retires only owned legacy content (%s)', async legacy => {
			const root = mkdtempSync(join(tmpdir(), 'kw-cli-setup-'));
			const bin = join(root, 'bin');
			const copilotHomeDirectory = join(root, 'copilot-home');
			const agentPath = join(copilotHomeDirectory, 'agents', 'kusto-workbench.agent.md');
			mkdirSync(bin);
			mkdirSync(join(copilotHomeDirectory, 'agents'), { recursive: true });
			copyFileSync(join(process.env.SystemRoot!, 'System32', 'where.exe'), join(bin, 'copilot.exe'));
			const executable = realpathSync.native(join(bin, 'copilot.exe'));
			writeFileSync(join(bin, 'code.cmd'), '@echo off\r\necho angelos-petropoulos.vscode-kusto-workbench@5.2.0\r\necho angelos-petropoulos.kusto-workbench-mcp-bootstrap@0.0.0\r\n');
			const legacyContent = createManagedCopilotCliAgentContent('---\nname: Kusto Workbench\n---\nLegacy agent.\n');
			if (legacy !== 'fresh') writeFileSync(agentPath, legacy === 'unowned' ? 'user-owned agent\n' : legacy === 'edited' ? `${legacyContent}User edit.\n` : legacyContent);
			const previousEnvironment = { LOCALAPPDATA: process.env.LOCALAPPDATA, COPILOT_HOME: process.env.COPILOT_HOME, PATH: process.env.PATH };
			const previousExecPath = process.execPath;
			const originalWindow = Object.getOwnPropertyDescriptors(vscode.window);
			process.env.LOCALAPPDATA = root;
			process.env.COPILOT_HOME = copilotHomeDirectory;
			process.env.PATH = `${bin}${delimiter}${previousEnvironment.PATH || ''}`;
			process.execPath = join(root, 'Code.exe');
			const pick = vi.fn().mockResolvedValueOnce({ clientKind: 'copilot-cli' }).mockResolvedValueOnce({ value: 'default' });
			const info = vi.fn();
			const warning = vi.fn().mockResolvedValue('Continue');
			Object.assign(vscode.window, { showQuickPick: pick, showWarningMessage: warning, showInformationMessage: info,
				withProgress: async (_options: unknown, action: () => Promise<unknown>) => action() });
			const rollback = vi.fn(async () => undefined);
			const registration = vi.spyOn(clientProvisioning, 'reconcileCopilotCliRegistration').mockResolvedValue({
				changed: false, reloadRequired: false, executable, rollback,
			});
			const configuration = vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
				inspect: () => ({ defaultValue: false }),
				update: vi.fn(async () => {
					expect(existsSync(agentPath)).toBe(legacy !== 'fresh');
					if (legacy === 'enable-failed') throw new Error('provider write failed');
				}),
			} as never);
			const lock = vi.spyOn(connectorInstaller, 'acquireExternalMcpConnectorLock').mockResolvedValue(async () => undefined);
			const install = vi.spyOn(connectorInstaller, 'installExternalMcpConnector').mockResolvedValue(connector);
			const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
			try {
				const context = { extensionUri: vscode.Uri.file(resolve('.')), extension: { packageJSON: { version: '5.2.0' } } } as unknown as vscode.ExtensionContext;
				if (legacy === 'enable-failed') {
					await expect(runExternalMcpSetup(context, logger)).rejects.toThrow('provider write failed');
					expect(rollback).toHaveBeenCalledOnce();
					expect(readFileSync(agentPath, 'utf8')).toBe(legacyContent);
					return;
				}
				const result = await runExternalMcpSetup(context, logger);
				expect(registration).toHaveBeenCalledWith({ executable, connector });
				expect(result).toEqual({ client: 'copilot-cli', integrationEnabled: true, fullyConfigured: true, requiresClientReload: legacy === 'managed' });
				expect(existsSync(agentPath)).toBe(legacy === 'edited' || legacy === 'unowned');
				if (legacy === 'edited' || legacy === 'unowned') {
					expect(readFileSync(agentPath, 'utf8')).toBe(legacy === 'edited' ? `${legacyContent}User edit.\n` : 'user-owned agent\n');
					expect(warning).toHaveBeenCalledTimes(2);
				} else {
					expect(warning).toHaveBeenCalledOnce();
				}
				expect(info).toHaveBeenCalledWith(expect.stringContaining('no agent switch is needed.'));
			} finally {
				process.execPath = previousExecPath;
				for (const [key, value] of Object.entries(previousEnvironment)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
				for (const key of ['showQuickPick', 'showWarningMessage', 'showInformationMessage', 'withProgress']) {
					const descriptor = originalWindow[key];
					if (descriptor) Object.defineProperty(vscode.window, key, descriptor);
					else Reflect.deleteProperty(vscode.window, key);
				}
				for (const mock of [configuration, registration, lock, install]) mock.mockRestore();
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it.runIf(process.platform === 'win32').each([true, false])('offers Microsoft Copilot Code separately and configures only its selected account (reload: %s)', async requiresClientReload => {
		const root = mkdtempSync(join(tmpdir(), 'kw-code-setup-cli-'));
		mkdirSync(join(root, 'bin'));
		writeFileSync(join(root, 'bin', 'code.cmd'), '@echo off\r\necho angelos-petropoulos.vscode-kusto-workbench@5.2.0\r\necho angelos-petropoulos.kusto-workbench-mcp-bootstrap@0.0.0\r\n');
		const target = { accountId: 'a'.repeat(32), executable: join(root, 'copilot.exe'), copilotHomeDirectory: join(root, 'code-account') };
		const originalWindow = Object.getOwnPropertyDescriptors(vscode.window);
		const originalExecPath = process.execPath;
		const pick = vi.fn().mockResolvedValueOnce({ clientKind: 'copilot-code' }).mockResolvedValueOnce({ value: 'default' });
		const info = vi.fn();
		Object.assign(vscode.window, { showQuickPick: pick, showWarningMessage: vi.fn().mockResolvedValue('Continue'), showInformationMessage: info,
			withProgress: async (_options: unknown, action: () => Promise<unknown>) => action() });
		const configuration = vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ inspect: () => ({ defaultValue: false }), get: () => true, update: vi.fn().mockResolvedValue(undefined) } as never);
		const discover = vi.spyOn(copilotCode, 'discoverCopilotCodeTargets').mockResolvedValue([target]);
		const preflight = vi.spyOn(copilotCode, 'preflightCopilotCodeIntegration').mockResolvedValue(undefined);
		const configure = vi.spyOn(copilotCode, 'configureCopilotCodeIntegration').mockResolvedValue({ changed: requiresClientReload, managed: true, requiresClientReload });
		const inspect = vi.spyOn(copilotCode, 'inspectCopilotCodeIntegration').mockResolvedValue(true);
		const remove = vi.spyOn(copilotCode, 'removeCopilotCodeIntegration').mockResolvedValue({ removed: true, existingPreserved: false });
		const lock = vi.spyOn(connectorInstaller, 'acquireExternalMcpConnectorLock').mockResolvedValue(async () => undefined);
		const install = vi.spyOn(connectorInstaller, 'installExternalMcpConnector').mockResolvedValue(connector);
		const cli = vi.spyOn(clientProvisioning, 'executeClientCommand').mockResolvedValue({ exitCode: 0, stdout: '{"mcpServers":{}}', stderr: '' });
		const scout = vi.spyOn(scoutProvisioning, 'inspectScoutMcpRegistration').mockResolvedValue({ configured: false, managed: false });
		process.execPath = join(root, 'Code.exe');
		try {
			const context = { extensionUri: vscode.Uri.file(resolve('.')), extension: { packageJSON: { version: '5.2.0' } } } as unknown as vscode.ExtensionContext;
			expect(await runExternalMcpSetup(context, { info: vi.fn(), warn: vi.fn(), error: vi.fn() })).toEqual({ client: 'copilot-code', integrationEnabled: true, fullyConfigured: true, requiresClientReload });
			expect((pick.mock.calls[0][0] as { label: string }[]).map(item => item.label)).toEqual(['Copilot CLI', 'Microsoft Scout', 'Microsoft Copilot (Code)', 'Other MCP client...']);
			expect(configure.mock.calls[0][0]).toMatchObject({ target, connector });
			expect(configure.mock.calls[0][0].skillSourceContent).toContain('# Kusto Workbench Skill');
			expect(preflight).toHaveBeenCalledBefore(install);
			expect(info.mock.calls[0][0]).toContain('Local Code session');
			expect(info.mock.calls[0][0]).toContain('may not appear in Customize');
			expect(info.mock.calls[0][0]).toContain('MCP tool approval prompts');
			expect(info.mock.calls[0][0]).not.toContain('Code > Customize');
			expect(info.mock.calls[0][0].includes('Quit and reopen Copilot')).toBe(requiresClientReload);
			await showExternalMcpStatus();
			expect(info.mock.calls[1][0]).toContain('1 of 1 Code accounts');
			pick.mockResolvedValueOnce([{ id: 'copilot-code' }]);
			await disableExternalMcpIntegration();
			expect(remove).toHaveBeenCalledWith({ target, localAppData: process.env.LOCALAPPDATA });
		} finally {
			process.execPath = originalExecPath;
			for (const key of ['showQuickPick', 'showWarningMessage', 'showInformationMessage', 'withProgress']) {
				const descriptor = originalWindow[key];
				if (descriptor) Object.defineProperty(vscode.window, key, descriptor); else Reflect.deleteProperty(vscode.window, key);
			}
			for (const mock of [configuration, discover, preflight, configure, inspect, remove, lock, install, cli, scout]) mock.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('cancels Code account selection before any selected cleanup changes state', async () => {
		const localAppData = mkdtempSync(join(tmpdir(), 'kw-cancel-code-cleanup-'));
		const previousLocalAppData = process.env.LOCALAPPDATA;
		process.env.LOCALAPPDATA = localAppData;
		const originalPick = Object.getOwnPropertyDescriptor(vscode.window, 'showQuickPick');
		const pick = vi.fn().mockResolvedValueOnce([{ id: 'provider' }, { id: 'copilot-code' }]).mockResolvedValueOnce(undefined);
		Object.assign(vscode.window, { showQuickPick: pick });
		const update = vi.fn();
		const configuration = vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ inspect: () => ({ defaultValue: false }), update } as never);
		const discover = vi.spyOn(copilotCode, 'discoverCopilotCodeTargets').mockResolvedValue(['a', 'b'].map(letter => ({ accountId: letter.repeat(32), executable: 'copilot.exe', copilotHomeDirectory: letter })));
		const lock = vi.spyOn(connectorInstaller, 'acquireExternalMcpConnectorLock');
		try {
			await disableExternalMcpIntegration();
			expect(update).not.toHaveBeenCalled();
			expect(lock).not.toHaveBeenCalled();
		} finally {
			if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
			else process.env.LOCALAPPDATA = previousLocalAppData;
			configuration.mockRestore(); discover.mockRestore(); lock.mockRestore();
			if (originalPick) Object.defineProperty(vscode.window, 'showQuickPick', originalPick); else Reflect.deleteProperty(vscode.window, 'showQuickPick');
			rmSync(localAppData, { recursive: true, force: true });
		}
	});

	it('keeps heavy Workbench startup off and assigns startup activation only to the tiny bootstrap', () => {
		const main = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
		const bootstrap = JSON.parse(readFileSync(resolve('external-mcp-bootstrap/package.json'), 'utf8'));

		expect(main.activationEvents).not.toContain('onStartupFinished');
		expect(bootstrap.activationEvents).toEqual(['onStartupFinished']);
		expect(bootstrap.extensionKind).toEqual(['ui']);
		expect(readFileSync(resolve('external-mcp-bootstrap/extension.js'), 'utf8'))
			.toContain("get('externalTools.enabled', false)");
	});

	it.runIf(process.platform === 'win32')('uses the supported profile-aware code.cmd install and uninstall lifecycle', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-code-cli-'));
		const cliDirectory = join(root, 'CLI with spaces');
		mkdirSync(cliDirectory);
		const commandFile = join(cliDirectory, 'code.cmd');
		const driverPath = join(cliDirectory, 'driver.cjs');
		writeFileSync(commandFile, `@echo off\r\n"${process.execPath}" "%~dp0driver.cjs" %*\r\n`);
		writeFileSync(driverPath, String.raw`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const marker = path.join(__dirname, 'installed');
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\n');
if (args.includes('--install-extension')) fs.writeFileSync(marker, 'yes');
if (args.includes('--uninstall-extension')) fs.rmSync(marker, { force: true });
if (args.includes('--list-extensions')) {
  const version = args.includes('--show-versions') ? '@5.2.0' : '';
  const profileIndex = args.indexOf('--profile');
  const profileName = profileIndex >= 0 ? args[profileIndex + 1] : '';
  console.log('angelos-petropoulos.vscode-kusto-workbench' + (profileName === 'Old profile' ? '@5.1.1' : version));
  if (fs.existsSync(marker)) console.log('angelos-petropoulos.kusto-workbench-mcp-bootstrap' + version);
}
`);
		const cli = { commandFile, profileArgs: ['--profile', 'Data profile'] };
		const context = {
			extensionUri: vscode.Uri.file(root),
			extension: { packageJSON: { version: '5.2.0' } },
		} as unknown as vscode.ExtensionContext;
		try {
			await installProviderBootstrap({ context, cli });
			await uninstallProviderBootstrap(cli);
			let calls = readFileSync(join(cliDirectory, 'calls.jsonl'), 'utf8')
				.trim().split(/\r?\n/).map(line => JSON.parse(line) as string[]);
			expect(calls).toHaveLength(6);
			expect(calls.every(call => call[0] === '--profile' && call[1] === 'Data profile')).toBe(true);
			expect(calls[0].slice(2)).toEqual(['--list-extensions', '--show-versions']);
			expect(calls[1].slice(2)).toEqual([
				'--install-extension',
				vscode.Uri.joinPath(context.extensionUri, 'dist', 'mcp-connector', 'kusto-workbench-mcp-bootstrap.vsix').fsPath,
				'--force',
			]);
			expect(calls[2].slice(2)).toEqual(['--list-extensions', '--show-versions']);
			expect(calls[3].slice(2)).toEqual(['--list-extensions']);
			expect(calls[4].slice(2)).toEqual(['--uninstall-extension', 'angelos-petropoulos.kusto-workbench-mcp-bootstrap']);
			expect(calls[5].slice(2)).toEqual(['--list-extensions']);

			await expect(installProviderBootstrap({
				context,
				cli: { commandFile, profileArgs: ['--profile', 'Old profile'] },
			})).rejects.toThrow('has Kusto Workbench 5.1.1 installed, but this setup requires 5.2.0');
			expect(existsSync(join(cliDirectory, 'installed'))).toBe(false);

			await expect(installProviderBootstrap({
				context,
				cli: { commandFile, profileArgs: ['--profile', 'Data & AI'] },
			})).rejects.toThrow('characters unsupported by the command-line installer');
			calls = readFileSync(join(cliDirectory, 'calls.jsonl'), 'utf8')
				.trim().split(/\r?\n/).map(line => JSON.parse(line) as string[]);
			expect(calls).toHaveLength(7);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.runIf(vsCodeCli !== undefined)('installs and removes the companion through a real isolated VS Code CLI', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-real-code-cli-'));
		const userDataDirectory = join(root, 'user data');
		const extensionsDirectory = join(root, 'extensions');
		const vsixPath = join(root, 'bootstrap.vsix');
		try {
			execFileSync(process.execPath, [
				resolve('node_modules', '@vscode', 'vsce', 'vsce'),
				'package',
				'--no-dependencies',
				'-o',
				vsixPath,
			], { cwd: resolve('external-mcp-bootstrap'), stdio: 'pipe' });
			const cli = {
				commandFile: vsCodeCli!,
				profileArgs: ['--user-data-dir', userDataDirectory, '--extensions-dir', extensionsDirectory],
			};
			await executeVsCodeCli(cli, ['--install-extension', vsixPath, '--force']);
			let installed = await executeVsCodeCli(cli, ['--list-extensions', '--show-versions']);
			expect(installed.toLowerCase()).toContain('angelos-petropoulos.kusto-workbench-mcp-bootstrap@');

			await executeVsCodeCli(cli, ['--uninstall-extension', 'angelos-petropoulos.kusto-workbench-mcp-bootstrap']);
			installed = await executeVsCodeCli(cli, ['--list-extensions']);
			expect(installed.toLowerCase()).not.toContain('angelos-petropoulos.kusto-workbench-mcp-bootstrap');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	it('does not preselect optional client cleanup when disabling the provider', async () => {
		const localAppData = mkdtempSync(join(tmpdir(), 'kw-cleanup-selection-'));
		const previousLocalAppData = process.env.LOCALAPPDATA;
		process.env.LOCALAPPDATA = localAppData;
		const showQuickPick = vi.fn().mockResolvedValue([{ id: 'provider' }]);
		Object.assign(vscode.window, { showQuickPick });
		const update = vi.fn().mockResolvedValue(undefined);
		const getConfiguration = vi.spyOn(vscode.workspace, 'getConfiguration')
			.mockReturnValue({ inspect: () => ({ defaultValue: false }), update } as never);
		const lock = vi.spyOn(connectorInstaller, 'acquireExternalMcpConnectorLock').mockResolvedValue(async () => undefined);
		try {
			await disableExternalMcpIntegration();
			const choices = showQuickPick.mock.calls[0][0] as Array<{ id: string; picked: boolean }>;
			expect(choices.find(choice => choice.id === 'provider')?.picked).toBe(true);
			expect(choices.find(choice => choice.id === 'copilot')?.picked).toBe(false);
			expect(choices.find(choice => choice.id === 'connector')?.picked).toBe(false);
			expect(update).toHaveBeenCalledWith('externalTools.enabled', false, vscode.ConfigurationTarget.Global);
		} finally {
			if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
			else process.env.LOCALAPPDATA = previousLocalAppData;
			delete (vscode.window as Partial<typeof vscode.window> & { showQuickPick?: unknown }).showQuickPick;
			getConfiguration.mockRestore();
			lock.mockRestore();
			rmSync(localAppData, { recursive: true, force: true });
		}
	});

	it('removes only the installed local connector directory', async () => {
		const localAppData = mkdtempSync(join(tmpdir(), 'kw-remove-connector-'));
		const connectorRoot = join(localAppData, 'KustoWorkbench', 'McpConnector');
		const staleQuarantine = join(localAppData, 'KustoWorkbench', '.mcp-connector-remove-stale');
		mkdirSync(connectorRoot, { recursive: true });
		mkdirSync(staleQuarantine, { recursive: true });
		writeFileSync(join(connectorRoot, 'current.json'), '{}');
		writeFileSync(join(staleQuarantine, 'node.exe'), 'stale');
		try {
			await removeInstalledExternalMcpConnector(localAppData);
			expect(existsSync(connectorRoot)).toBe(false);
			expect(existsSync(staleQuarantine)).toBe(false);
			expect(existsSync(localAppData)).toBe(true);
		} finally {
			rmSync(localAppData, { recursive: true, force: true });
		}
	});

	it('serializes connector removal with installation', async () => {
		const localAppData = mkdtempSync(join(tmpdir(), 'kw-remove-connector-lock-'));
		const connectorRoot = join(localAppData, 'KustoWorkbench', 'McpConnector');
		mkdirSync(connectorRoot, { recursive: true });
		writeFileSync(join(connectorRoot, 'current.json'), '{}');
		const release = await acquireExternalMcpConnectorLock(localAppData);
		let completed = false;
		const removal = removeInstalledExternalMcpConnector(localAppData).then(() => { completed = true; });
		try {
			await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
			expect(completed).toBe(false);
			expect(existsSync(connectorRoot)).toBe(true);
		} finally {
			await release();
		}
		try {
			await removal;
			expect(existsSync(connectorRoot)).toBe(false);
		} finally {
			rmSync(localAppData, { recursive: true, force: true });
		}
	});

	it('serializes provider disable with connector setup', async () => {
		const localAppData = mkdtempSync(join(tmpdir(), 'kw-disable-provider-lock-'));
		const priorLocalAppData = process.env.LOCALAPPDATA;
		process.env.LOCALAPPDATA = localAppData;
		const showQuickPick = vi.fn().mockResolvedValue([{ id: 'provider' }]);
		Object.assign(vscode.window, { showQuickPick });
		const update = vi.fn().mockResolvedValue(undefined);
		const getConfiguration = vi.spyOn(vscode.workspace, 'getConfiguration')
			.mockReturnValue({ inspect: () => ({ defaultValue: false }), update } as never);
		const release = await acquireExternalMcpConnectorLock(localAppData);
		const disabling = disableExternalMcpIntegration();
		try {
			await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
			expect(update).not.toHaveBeenCalled();
		} finally {
			await release();
		}
		try {
			await disabling;
			expect(update).toHaveBeenCalledWith('externalTools.enabled', false, vscode.ConfigurationTarget.Global);
		} finally {
			if (priorLocalAppData === undefined) delete process.env.LOCALAPPDATA;
			else process.env.LOCALAPPDATA = priorLocalAppData;
			delete (vscode.window as Partial<typeof vscode.window> & { showQuickPick?: unknown }).showQuickPick;
			getConfiguration.mockRestore();
			rmSync(localAppData, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform === 'win32')('does not partially disable integration when the Windows security lock is unavailable', async () => {
		const localAppData = mkdtempSync(join(tmpdir(), 'kw-cleanup-unavailable-lock-'));
		const previousLocalAppData = process.env.LOCALAPPDATA;
		process.env.LOCALAPPDATA = localAppData;
		const showQuickPick = vi.fn().mockResolvedValue([{ id: 'provider' }, { id: 'copilot' }]);
		Object.assign(vscode.window, { showQuickPick });
		const update = vi.fn().mockResolvedValue(undefined);
		const getConfiguration = vi.spyOn(vscode.workspace, 'getConfiguration')
			.mockReturnValue({ inspect: () => ({ defaultValue: false }), update } as never);
		const systemRoot = process.env.SystemRoot;
		delete process.env.SystemRoot;
		try {
			await expect(disableExternalMcpIntegration()).rejects.toThrow('Windows system directory is unavailable');
			expect(update).not.toHaveBeenCalled();
		} finally {
			if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
			else process.env.LOCALAPPDATA = previousLocalAppData;
			if (systemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = systemRoot;
			delete (vscode.window as Partial<typeof vscode.window> & { showQuickPick?: unknown }).showQuickPick;
			getConfiguration.mockRestore();
			rmSync(localAppData, { recursive: true, force: true });
		}
	});

	it('continues selected cleanup after an independent step fails', async () => {
		const localAppData = mkdtempSync(join(tmpdir(), 'kw-best-effort-cleanup-'));
		const connectorRoot = join(localAppData, 'KustoWorkbench', 'McpConnector');
		mkdirSync(connectorRoot, { recursive: true });
		writeFileSync(join(connectorRoot, 'current.json'), '{}');
		const showQuickPick = vi.fn().mockResolvedValue([{ id: 'other' }, { id: 'connector' }]);
		Object.assign(vscode.window, { showQuickPick });
		const clipboard = { writeText: vi.fn().mockRejectedValue(new Error('clipboard unavailable')) };
		Object.assign(vscode.env, { clipboard });
		const update = vi.fn().mockResolvedValue(undefined);
		const getConfiguration = vi.spyOn(vscode.workspace, 'getConfiguration')
			.mockReturnValue({ inspect: () => ({ defaultValue: false }), update } as never);
		const previousLocalAppData = process.env.LOCALAPPDATA;
		process.env.LOCALAPPDATA = localAppData;
		try {
			await expect(disableExternalMcpIntegration()).rejects.toThrow('clipboard unavailable');
			expect(existsSync(connectorRoot)).toBe(false);
			expect(update).toHaveBeenCalledWith('externalTools.enabled', false, vscode.ConfigurationTarget.Global);
		} finally {
			if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
			else process.env.LOCALAPPDATA = previousLocalAppData;
			delete (vscode.env as Partial<typeof vscode.env> & { clipboard?: unknown }).clipboard;
			delete (vscode.window as Partial<typeof vscode.window> & { showQuickPick?: unknown }).showQuickPick;
			getConfiguration.mockRestore();
			rmSync(localAppData, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform === 'win32')('continues provider and managed-agent cleanup when Copilot CLI is unavailable', async () => {
		const localAppData = mkdtempSync(join(tmpdir(), 'kw-cleanup-no-copilot-'));
		const copilotHomeDirectory = join(localAppData, 'copilot-home');
		const agentPath = join(copilotHomeDirectory, 'agents', 'kusto-workbench.agent.md');
		const previousLocalAppData = process.env.LOCALAPPDATA;
		const previousPath = process.env.PATH;
		const previousCopilotHome = process.env.COPILOT_HOME;
		process.env.LOCALAPPDATA = localAppData;
		process.env.COPILOT_HOME = copilotHomeDirectory;
		process.env.PATH = '';
		const showQuickPick = vi.fn().mockResolvedValue([{ id: 'provider' }, { id: 'copilot' }]);
		Object.assign(vscode.window, { showQuickPick });
		const update = vi.fn().mockResolvedValue(undefined);
		const getConfiguration = vi.spyOn(vscode.workspace, 'getConfiguration')
			.mockReturnValue({ inspect: () => ({ defaultValue: false }), update } as never);
		try {
			mkdirSync(join(copilotHomeDirectory, 'agents'), { recursive: true });
			writeFileSync(agentPath, createManagedCopilotCliAgentContent('---\nname: Kusto Workbench\n---\nManaged test agent.\n'));
			expect(existsSync(agentPath)).toBe(true);
			await expect(disableExternalMcpIntegration()).rejects.toThrow('GitHub Copilot CLI');
			expect(update).toHaveBeenCalledWith('externalTools.enabled', false, vscode.ConfigurationTarget.Global);
			expect(existsSync(agentPath)).toBe(false);
		} finally {
			if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
			else process.env.LOCALAPPDATA = previousLocalAppData;
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME;
			else process.env.COPILOT_HOME = previousCopilotHome;
			delete (vscode.window as Partial<typeof vscode.window> & { showQuickPick?: unknown }).showQuickPick;
			getConfiguration.mockRestore();
			rmSync(localAppData, { recursive: true, force: true });
		}
	});
});