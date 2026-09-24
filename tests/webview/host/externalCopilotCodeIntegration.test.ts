import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureCopilotCodeIntegration, createCopilotCodePluginFiles, discoverCopilotCodeTargets, inspectCopilotCodeIntegration, removeCopilotCodeIntegration } from '../../../src/host/externalCopilotCodeIntegration';
import type { ExecuteClientCommand } from '../../../src/host/externalMcpClientProvisioning';

const skillSource = '---\nname: kusto-workbench\ndescription: Operate Workbench.\n---\nUse exact instanceId.\n';

describe('Microsoft Copilot Code integration', () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function fixture() {
		const localAppData = mkdtempSync(join(tmpdir(), 'kw-copilot-code-'));
		roots.push(localAppData);
		const userData = join(localAppData, 'Microsoft', 'Copilot', 'User Data');
		return { localAppData, userData };
	}

	function installRuntime(userData: string, version: string, apiVersion = 4) {
		const directory = join(userData, 'CopilotCodeTabRuntime', version);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, 'copilot.exe'), 'isolated executable fixture');
		writeFileSync(join(directory, 'github_copilot.dll'), 'isolated runtime fixture');
		writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 2, name: 'Copilot Code Tab Runtime', version, api_version: apiVersion }));
		return join(directory, 'copilot.exe');
	}

	function integrationFixture() {
		const { localAppData, userData } = fixture();
		const accountId = 'a'.repeat(32);
		const codeHome = join(userData, 'CopilotCodingHome', accountId);
		mkdirSync(codeHome, { recursive: true });
		const target = { accountId, executable: installRuntime(userData, '0.1.229.0'), copilotHomeDirectory: codeHome };
		const connector = { command: 'C:\\Workbench\\node.exe', args: ['C:\\Workbench\\bootstrap.cjs'], connectorVersion: '5.2.0' };
		const registryPath = join(codeHome, 'config.json');
		let current: { name: string; enabled: boolean; cache_path: string; source: { source: string; path: string } } | undefined;
		const persist = () => writeFileSync(registryPath, JSON.stringify({ installedPlugins: current ? [current] : [], untouched: 'preserve' }));
		const execute = vi.fn<ExecuteClientCommand>(async (executable, args) => {
			expect(executable).toBe(target.executable);
			if (args[0] === 'plugin' && args[1] === 'install') {
				const source = args[2];
				const cache = join(codeHome, 'installed-plugins', '_direct', basename(source));
				mkdirSync(dirname(cache), { recursive: true });
				cpSync(source, cache, { recursive: true });
				current = { name: 'kusto-workbench', enabled: true, cache_path: cache, source: { source: 'local', path: source } };
				persist();
			} else if (args[0] === 'plugin' && args[1] === 'uninstall') {
				current = undefined;
				persist();
			} else if (args[0] === 'mcp') {
				return { exitCode: 0, stderr: '', stdout: JSON.stringify({ mcpServers: current ? {
					'kusto-workbench': { ...JSON.parse(readFileSync(join(current.cache_path, 'mcp.json'), 'utf8')).mcpServers['kusto-workbench'], source: 'plugin', sourcePlugin: 'kusto-workbench', enabled: true },
				} : {} }) };
			} else if (args[0] === 'skill') {
				return { exitCode: 0, stderr: '', stdout: JSON.stringify(current ? [{ name: 'kusto-workbench', enabled: true, source: 'plugin', path: join(current.cache_path, 'skills', 'kusto-workbench') }] : []) };
			} else throw new Error('Unexpected Code management command.');
			return { exitCode: 0, stderr: '', stdout: '' };
		});
		const enableProvider = vi.fn(async () => undefined);
		return { options: { target, localAppData, connector, skillSourceContent: skillSource, execute, enableProvider }, registryPath, current: () => current };
	}

	it('resolves Code account homes separately from the terminal CLI and Scout homes', async () => {
		const { localAppData, userData } = fixture();
		installRuntime(userData, '0.1.9.0');
		const executable = installRuntime(userData, '0.1.229.0');
		const accountId = 'a'.repeat(32);
		const copilotHomeDirectory = join(userData, 'CopilotCodingHome', accountId);
		mkdirSync(copilotHomeDirectory, { recursive: true });

		expect(await discoverCopilotCodeTargets(localAppData)).toEqual([{ accountId, executable, copilotHomeDirectory }]);
	});

	it('discovers a supported Code runtime with a UTF-8 BOM in its manifest without rewriting it', async () => {
		const { localAppData, userData } = fixture();
		const executable = installRuntime(userData, '0.1.229.0');
		const manifestPath = join(dirname(executable), 'manifest.json');
		const manifestBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(manifestPath)]);
		writeFileSync(manifestPath, manifestBytes);
		const accountId = 'a'.repeat(32);
		const copilotHomeDirectory = join(userData, 'CopilotCodingHome', accountId);
		mkdirSync(copilotHomeDirectory, { recursive: true });

		await expect(discoverCopilotCodeTargets(localAppData)).resolves.toEqual([{ accountId, executable, copilotHomeDirectory }]);
		expect(readFileSync(manifestPath)).toEqual(manifestBytes);
		expect(existsSync(join(localAppData, 'KustoWorkbench'))).toBe(false);
	});

	it('returns every initialized account instead of choosing by folder order or recency', async () => {
		const { localAppData, userData } = fixture();
		const executable = installRuntime(userData, '0.1.229.0');
		for (const accountId of ['b'.repeat(32), 'a'.repeat(32), 'not-an-account']) {
			mkdirSync(join(userData, 'CopilotCodingHome', accountId), { recursive: true });
		}
		const targets = await discoverCopilotCodeTargets(localAppData);
		expect(targets.map(target => target.accountId)).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
		expect(targets.every(target => target.executable === executable)).toBe(true);
	});

	it('requires Code to be initialized and never creates an account home implicitly', async () => {
		const { localAppData, userData } = fixture();
		await expect(discoverCopilotCodeTargets(localAppData)).rejects.toThrow('open Copilot');
		installRuntime(userData, '0.1.229.0');
		await expect(discoverCopilotCodeTargets(localAppData)).rejects.toThrow('Code');
	});

	it.each(['', '\uFEFF'])('rejects an unknown runtime contract with prefix %j rather than configuring a different Copilot host', async prefix => {
		const { localAppData, userData } = fixture();
		const executable = installRuntime(userData, '0.1.229.0', 99);
		const manifestPath = join(dirname(executable), 'manifest.json');
		writeFileSync(manifestPath, prefix + readFileSync(manifestPath, 'utf8'));
		mkdirSync(join(userData, 'CopilotCodingHome', 'a'.repeat(32)), { recursive: true });
		await expect(discoverCopilotCodeTargets(localAppData)).rejects.toThrow('runtime format is not supported');
	});

	it.each(['', '\uFEFF'])('rejects malformed runtime manifest JSON with prefix %j', async prefix => {
		const { localAppData, userData } = fixture();
		const executable = installRuntime(userData, '0.1.229.0');
		const manifestPath = join(dirname(executable), 'manifest.json');
		const content = `${prefix}{"manifest_version":`;
		writeFileSync(manifestPath, content);
		mkdirSync(join(userData, 'CopilotCodingHome', 'a'.repeat(32)), { recursive: true });

		await expect(discoverCopilotCodeTargets(localAppData)).rejects.toThrow('runtime manifest is invalid');
		expect(readFileSync(manifestPath, 'utf8')).toBe(content);
	});

	it('skips an incomplete newer runtime being downloaded without selecting an unknown API contract', async () => {
		const { localAppData, userData } = fixture();
		const executable = installRuntime(userData, '0.1.229.0');
		mkdirSync(join(userData, 'CopilotCodeTabRuntime', '0.1.230.0'));
		mkdirSync(join(userData, 'CopilotCodingHome', 'a'.repeat(32)), { recursive: true });
		expect((await discoverCopilotCodeTargets(localAppData))[0].executable).toBe(executable);
	});

	it('bundles the portable skill and exact STDIO server in an Agent Plugins 1.0 package', () => {
		const connector = { command: 'C:\\Users\\Test User\\McpConnector\\node.exe', args: ['C:\\Users\\Test User\\McpConnector\\bootstrap.cjs'], connectorVersion: '5.2.0' };
		const skill = '---\nname: kusto-workbench\ndescription: Operate Workbench\n---\nUse exact instanceId.\n';
		const files = createCopilotCodePluginFiles(connector, skill);
		expect(files.map(file => file.relativePath)).toEqual(['plugin.json', 'mcp.json', 'skills/kusto-workbench/SKILL.md']);
		expect(JSON.parse(files[0].content)).toMatchObject({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'kusto-workbench', version: '5.2.0' });
		expect(JSON.parse(files[1].content)).toEqual({
			$schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
			mcpServers: { 'kusto-workbench': { type: 'stdio', command: connector.command, args: connector.args } },
		});
		expect(files[2].content).toBe(skill);
		expect(files.every(file => !file.content.includes('allow-all-tools'))).toBe(true);
	});

	it('installs, rechecks, updates, and removes the exact Code plugin without changing another client home', async () => {
		const { options, registryPath } = integrationFixture();
		const otherHome = join(options.localAppData, 'terminal-cli-home');
		mkdirSync(otherHome);
		writeFileSync(join(otherHome, 'mcp-config.json'), 'unrelated client sentinel');
		expect(await configureCopilotCodeIntegration(options)).toEqual({ changed: true, managed: true, requiresClientReload: true });
		const installedBytes = readFileSync(registryPath, 'utf8');
		expect(await configureCopilotCodeIntegration(options)).toEqual({ changed: false, managed: true, requiresClientReload: false });
		expect(readFileSync(registryPath, 'utf8')).toBe(installedBytes);
		expect(await configureCopilotCodeIntegration({ ...options, connector: { ...options.connector, connectorVersion: '5.2.1' } })).toMatchObject({ changed: true });
		expect(await removeCopilotCodeIntegration(options)).toEqual({ removed: true, existingPreserved: false });
		expect(JSON.parse(readFileSync(registryPath, 'utf8'))).toEqual({ installedPlugins: [], untouched: 'preserve' });
		expect(readFileSync(join(otherHome, 'mcp-config.json'), 'utf8')).toBe('unrelated client sentinel');
	});

	it('compensates a new plugin and restores the previous plugin if enabling the provider fails', async () => {
		const { options, current } = integrationFixture();
		options.enableProvider.mockRejectedValueOnce(new Error('setting failed'));
		await expect(configureCopilotCodeIntegration(options)).rejects.toThrow('setting failed');
		expect(current()).toBeUndefined();
		await configureCopilotCodeIntegration(options);
		const previous = current();
		options.enableProvider.mockRejectedValueOnce(new Error('setting failed again'));
		await expect(configureCopilotCodeIntegration({ ...options, connector: { ...options.connector, connectorVersion: '5.2.1' } })).rejects.toThrow('setting failed again');
		expect(current()).toEqual(previous);
	});

	it('restores the previous plugin when a failed update has already removed its registration', async () => {
		const { options, current } = integrationFixture();
		await configureCopilotCodeIntegration(options);
		const previous = current();
		const realExecute = options.execute.getMockImplementation()!;
		let failNextInstall = true;
		options.execute.mockImplementation(async (command, args, signal) => {
			if (args[0] === 'plugin' && args[1] === 'install' && failNextInstall) {
				failNextInstall = false;
				await realExecute(command, ['plugin', 'uninstall', 'kusto-workbench'], signal);
				return { exitCode: 1, stdout: '', stderr: 'failed after removing old entry' };
			}
			return realExecute(command, args, signal);
		});
		await expect(configureCopilotCodeIntegration({ ...options, connector: { ...options.connector, connectorVersion: '5.2.1' } })).rejects.toThrow('plugin install');
		expect(current()).toEqual(previous);
	});

	it('preserves an unowned matching plugin and refuses user-edited managed content', async () => {
		const { options, current } = integrationFixture();
		await configureCopilotCodeIntegration(options);
		const receiptPath = join(options.localAppData, 'KustoWorkbench', 'CopilotCode', options.target.accountId, 'receipt.json');
		const receiptBytes = readFileSync(receiptPath, 'utf8');
		rmSync(receiptPath);
		expect(await configureCopilotCodeIntegration(options)).toMatchObject({ changed: false, managed: false });
		expect(await removeCopilotCodeIntegration(options)).toEqual({ removed: false, existingPreserved: true });
		writeFileSync(receiptPath, receiptBytes);
		writeFileSync(join(current()!.cache_path, 'skills', 'kusto-workbench', 'SKILL.md'), 'user changes');
		await expect(configureCopilotCodeIntegration(options)).rejects.toThrow('changed');
		await expect(removeCopilotCodeIntegration(options)).rejects.toThrow('changed');
		expect(readFileSync(join(current()!.cache_path, 'skills', 'kusto-workbench', 'SKILL.md'), 'utf8')).toBe('user changes');
	});

	it.runIf(process.platform === 'win32' && process.env.KUSTO_WORKBENCH_RUN_CODE_DESKTOP_SMOKE === '1')('loads Workbench in a running Local Code session and returns real instance identities', async () => {
		const accountId = process.env.KUSTO_WORKBENCH_CODE_DESKTOP_ACCOUNT;
		const targets = await discoverCopilotCodeTargets();
		const target = targets.find(candidate => candidate.accountId === accountId);
		expect(target, 'Set KUSTO_WORKBENCH_CODE_DESKTOP_ACCOUNT to the exact account shown in the running Code app').toBeDefined();
		expect(await inspectCopilotCodeIntegration(target!)).toBe(true);
		const systemRoot = process.env.SystemRoot;
		if (!systemRoot) throw new Error('SystemRoot is required for the desktop Code smoke check.');
		const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$apps = @(Get-Process -Name copilotapp | Where-Object { $_.MainWindowHandle -ne 0 })
if ($apps.Count -ne 1) { throw 'Open exactly one Copilot desktop window for this read-only smoke check.' }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($apps[0].MainWindowHandle)
$controls = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$names = @($controls | Where-Object { -not $_.Current.IsOffscreen } | ForEach-Object { $_.Current.Name })
$texts = @($controls | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text } | ForEach-Object { $_.Current.Name.Trim() })
[PSCustomObject]@{
    probeSession = ($names -contains 'New session: Workbench Connectivity Probe')
    localSession = ($names -contains 'Local sessions')
    workbenchSkill = ($texts -contains 'kusto-workbench')
	toolCallsCompleted = (@($names | Where-Object { $_ -match '(?i)^Completed Kusto workbench execute tool and [1-9][0-9]* other tool call' }).Count -gt 0)
    discoverySucceeded = ($texts -contains 'Success.' -and $texts -contains 'Instances:')
    stillGenerating = ($names -contains 'Stop generating response')
    instanceIds = @($texts | Where-Object { $_ -match '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' })
} | ConvertTo-Json -Compress
`;
		const state = JSON.parse(execFileSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
			['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })) as {
			probeSession: boolean;
			localSession: boolean;
			workbenchSkill: boolean;
			toolCallsCompleted: boolean;
			discoverySucceeded: boolean;
			stillGenerating: boolean;
			instanceIds: string[];
		};
		expect(state, 'Open a new Workbench Connectivity Probe in Local Code using execute-tool for guidance and instance listing').toMatchObject({
			probeSession: true, localSession: true, workbenchSkill: true, toolCallsCompleted: true, discoverySucceeded: true, stillGenerating: false,
		});
		expect(state.instanceIds.length).toBeGreaterThan(0);
		const { Client } = await import('@modelcontextprotocol/client');
		const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
		const connectorRoot = join(process.env.LOCALAPPDATA!, 'KustoWorkbench', 'McpConnector');
		const client = new Client({ name: 'workbench-code-smoke', version: '1.0.0' });
		const transport = new StdioClientTransport({
			command: join(connectorRoot, 'node.exe'), args: [join(connectorRoot, 'bootstrap.cjs')],
			env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
		});
		try {
			await client.connect(transport);
			const result = await client.callTool({
				name: 'execute-tool', arguments: { name: 'listWorkbenchInstances', arguments: {} },
			});
			expect(result.isError).not.toBe(true);
			const text = result.content.find(part => part.type === 'text');
			if (!text || text.type !== 'text') throw new Error('Workbench discovery did not return text.');
			const discovered = JSON.parse(text.text) as { instances: { instanceId: string }[] };
			for (const instanceId of state.instanceIds) {
				expect(discovered.instances.some(instance => instance.instanceId === instanceId), 'Code must return a real, still-running Workbench instance').toBe(true);
			}
		} finally {
			await client.close();
			await transport.close();
		}
	}, 60_000);

	it.runIf(process.env.KUSTO_WORKBENCH_COPILOT_CODE_RUNTIME !== undefined)('installs and removes the plugin through the actual Code backend in an isolated home', () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-real-code-plugin-'));
		roots.push(root);
		const pluginPath = join(root, 'plugin source');
		const codeHome = join(root, 'code-home');
		mkdirSync(codeHome);
		const files = createCopilotCodePluginFiles({ command: process.execPath, args: [join(root, 'bootstrap.cjs')], connectorVersion: '5.2.0' },
			'---\nname: kusto-workbench\ndescription: Operate Workbench from Code.\n---\nUse exact instanceId.\n');
		for (const file of files) {
			const destination = join(pluginPath, file.relativePath);
			mkdirSync(dirname(destination), { recursive: true });
			writeFileSync(destination, file.content);
		}
		const invoke = (args: string[]) => execFileSync(process.env.KUSTO_WORKBENCH_COPILOT_CODE_RUNTIME!, args, {
			cwd: codeHome, encoding: 'utf8', timeout: 30_000, windowsHide: true,
			env: { ...process.env, COPILOT_HOME: codeHome, COPILOT_AUTO_UPDATE: 'false' },
		});
		const installed = invoke(['plugin', 'install', pluginPath]);
		const servers = JSON.parse(invoke(['mcp', 'list', '--json']));
		const skills = JSON.parse(invoke(['skill', 'list', '--json']));
		expect(installed).toContain('installed successfully');
		expect(servers.mcpServers['kusto-workbench']).toMatchObject({ command: process.execPath, args: [join(root, 'bootstrap.cjs')] });
		expect(JSON.stringify(skills)).toContain('kusto-workbench');
		invoke(['plugin', 'uninstall', 'kusto-workbench']);
		expect(JSON.parse(invoke(['mcp', 'list', '--json'])).mcpServers['kusto-workbench']).toBeUndefined();
	}, 120_000);

	it.runIf(process.env.KUSTO_WORKBENCH_COPILOT_CODE_RUNTIME !== undefined)('converges and rolls back through actual Code backend commands in an isolated account', async () => {
		const { options, registryPath } = integrationFixture();
		const actualOptions = { ...options, execute: undefined, target: { ...options.target, executable: process.env.KUSTO_WORKBENCH_COPILOT_CODE_RUNTIME! } };
		expect(await configureCopilotCodeIntegration(actualOptions)).toMatchObject({ changed: true, managed: true });
		const receiptPath = join(options.localAppData, 'KustoWorkbench', 'CopilotCode', options.target.accountId, 'receipt.json');
		expect(existsSync(receiptPath)).toBe(true);
		expect(await configureCopilotCodeIntegration(actualOptions)).toMatchObject({ changed: false, managed: true });
		const before = readFileSync(receiptPath, 'utf8');
		await expect(configureCopilotCodeIntegration({ ...actualOptions, connector: { ...options.connector, connectorVersion: '5.2.1' }, enableProvider: async () => { throw new Error('setting failure'); } })).rejects.toThrow('setting failure');
		expect(readFileSync(receiptPath, 'utf8')).toBe(before);
		expect(await removeCopilotCodeIntegration(actualOptions)).toEqual({ removed: true, existingPreserved: false });
		expect(readFileSync(registryPath, 'utf8')).not.toContain('"name": "kusto-workbench"');
	}, 120_000);
});