// @vitest-environment node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	installExternalMcpConnector,
	type InstallExternalMcpConnectorOptions,
} from '../../../src/host/externalMcpConnectorInstaller';

describe.runIf(process.platform === 'win32' && process.arch === 'x64')('external MCP connector installer', () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it('publishes an idempotent stable launcher that runs with the downloaded Node runtime', async () => {
		const localAppData = mkdtempSync(join(tmpdir(), 'kw-connector-install-'));
		roots.push(localAppData);
		const runtimeDirectory = join(localAppData, 'runtime-fixture');
		const runtimeArchive = join(localAppData, 'runtime-fixture.zip');
		mkdirSync(runtimeDirectory);
		copyFileSync(process.execPath, join(runtimeDirectory, 'node.exe'));
		writeFileSync(join(runtimeDirectory, 'LICENSE'), 'Node.js is licensed for use as follows\n');
		execFileSync(
			join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
			['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
				'Compress-Archive -LiteralPath $env:KW_RUNTIME_DIR -DestinationPath $env:KW_RUNTIME_ZIP -CompressionLevel Optimal'],
			{
				windowsHide: true,
				stdio: 'pipe',
				env: { ...process.env, KW_RUNTIME_DIR: runtimeDirectory, KW_RUNTIME_ZIP: runtimeArchive },
			},
		);
		const packageJSON = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
		const context = {
			extensionUri: vscode.Uri.file(resolve('.')),
			extension: { packageJSON },
		} as unknown as vscode.ExtensionContext;
		const options: InstallExternalMcpConnectorOptions = {
			context,
			localAppData,
			systemRoot: process.env.SystemRoot!,
			codeExecutable: process.execPath,
			acquireRuntimeArchive: vi.fn(async (metadata, cacheDirectory) => {
				expect(metadata).toMatchObject({ version: '24.21.0', target: 'win-x64' });
				expect(cacheDirectory).toBe(join(localAppData, 'KustoWorkbench', 'McpConnector', 'runtime-cache'));
				return runtimeArchive;
			}),
		};

		const first = await installExternalMcpConnector(options);
		const firstCurrent = readFileSync(join(first.root, 'current.json'), 'utf8');
		writeFileSync(join(first.root, 'node.exe'), 'corrupt runtime');
		writeFileSync(join(first.versionDirectory, 'connector.cjs'), 'corrupt connector');
		const second = await installExternalMcpConnector(options);
		const installedRuntime = JSON.parse(readFileSync(join(second.root, 'runtime-installed.json'), 'utf8'));
		const installedNodeHash = createHash('sha256').update(readFileSync(second.command)).digest('hex');
		const named = await installExternalMcpConnector({ ...options, profileName: 'Data profile' });
		const namedConfig = JSON.parse(readFileSync(join(named.versionDirectory, 'connector-config.json'), 'utf8'));
		const namedCurrent = readFileSync(join(named.root, 'current.json'), 'utf8');
		const isolated = await installExternalMcpConnector({
			...options,
			codeArguments: ['--user-data-dir', 'C:\\isolated user data'],
		});
		const isolatedConfig = JSON.parse(readFileSync(join(isolated.versionDirectory, 'connector-config.json'), 'utf8'));
		const defaultAgain = await installExternalMcpConnector(options);
		const defaultConfig = JSON.parse(readFileSync(join(defaultAgain.versionDirectory, 'connector-config.json'), 'utf8'));
		const current = JSON.parse(readFileSync(join(defaultAgain.root, 'current.json'), 'utf8'));

		expect(second.bootstrapPath).toBe(first.bootstrapPath);
		expect(second.versionDirectory).toBe(first.versionDirectory);
		expect(second.launchTargetChanged).toBe(false);
		expect(named.versionDirectory).not.toBe(first.versionDirectory);
		expect(named.launchTargetChanged).toBe(true);
		expect(namedConfig.codeArguments).toEqual(['--profile', 'Data profile']);
		expect(isolated.versionDirectory).not.toBe(named.versionDirectory);
		expect(isolatedConfig.codeArguments).toEqual(['--user-data-dir', 'C:\\isolated user data']);
		expect(defaultAgain.versionDirectory).toBe(first.versionDirectory);
		expect(defaultAgain.launchTargetChanged).toBe(true);
		expect(defaultConfig).not.toHaveProperty('codeArguments');
		expect(current.configPath).toBe(join(defaultAgain.versionDirectory, 'connector-config.json'));
		expect(namedCurrent).not.toBe(firstCurrent);
		expect(readFileSync(join(defaultAgain.root, 'current.json'), 'utf8')).toBe(firstCurrent);
		expect(second.command).toBe(join(second.root, 'node.exe'));
		expect(second.args).toEqual([second.bootstrapPath]);
		const guidance = readFileSync(join(second.versionDirectory, 'guidance.md'), 'utf8');
		expect(guidance).toContain('pass its exact `instanceId` inside `arguments`');
		expect(guidance).toContain('`execute-tool`');
		expect(guidance).toContain('do not replay it automatically');
		expect(guidance).not.toContain('#runSubagent');
		expect(installedRuntime).toMatchObject({ version: '24.21.0', target: 'win-x64', nodeSha256: installedNodeHash });
		expect(readFileSync(join(second.root, 'NODE-LICENSE.txt'), 'utf8')).toContain('Node.js is licensed for use as follows');
		expect(readFileSync(join(second.versionDirectory, 'connector.cjs')))
			.toEqual(readFileSync(resolve('dist', 'mcp-connector', 'connector.cjs')));
		expect(options.acquireRuntimeArchive).toHaveBeenCalledTimes(2);

		const transport = new StdioClientTransport({
			command: second.command,
			args: [...second.args],
			stderr: 'pipe',
		});
		let stderr = '';
		transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
		const client = new Client(
			{ name: 'installed-connector-test', version: '1.0.0' },
			{ versionNegotiation: { mode: 'auto' } },
		);
		try {
			await client.connect(transport);
			const tools = await client.listTools();
			expect(tools.tools.map(tool => tool.name).sort()).toEqual(['execute-tool', 'list-tools']);
			const catalog = await client.callTool({ name: 'list-tools', arguments: {} });
			expect(JSON.parse((catalog.content[0] as { text: string }).text).operations)
				.toHaveLength(packageJSON.contributes.languageModelTools.length + 4);
			const instances = await client.callTool({
				name: 'execute-tool', arguments: { name: 'listWorkbenchInstances', arguments: {} },
			});
			expect(JSON.parse((instances.content[0] as { text: string }).text)).toEqual({ instances: [] });
		} finally {
			await client.close();
		}
		expect(stderr).toBe('');
	}, 120_000);
});