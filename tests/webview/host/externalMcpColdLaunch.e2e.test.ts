// @vitest-environment node

import { execFile, execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import extractZip from 'extract-zip';
import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { installExternalMcpConnector } from '../../../src/host/externalMcpConnectorInstaller';
import { executeVsCodeCli } from '../../../src/host/externalMcpSetup';

const enabled = process.platform === 'win32'
	&& process.arch === 'x64'
	&& process.env.KUSTO_WORKBENCH_RUN_COLD_MCP_E2E === '1';
const { pack: packVsix } = createRequire(join(resolve('.'), 'package.json'))(
	resolve('node_modules', '@vscode', 'vsce', 'out', 'package.js'),
) as {
	pack(options: {
		cwd: string;
		packagePath: string;
		version: string;
		updatePackageJson: boolean;
		dependencies: boolean;
	}): Promise<unknown>;
};

function environment(overrides: Record<string, string>): Record<string, string> {
	return {
		...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
		...overrides,
	};
}

function pathKey(value: string): string {
	return resolve(value).replace(/\//g, '\\').toLowerCase();
}

function textResult(result: { content: readonly unknown[] }): string {
	const text = result.content.find((part): part is { type: 'text'; text: string } =>
		!!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text');
	if (!text) throw new Error('MCP tool result did not contain text.');
	return text.text;
}

function jsonResult<T>(result: { content: readonly unknown[] }): T {
	const text = textResult(result);
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`Expected a JSON MCP result, received: ${text}`, { cause: error });
	}
}

function collectVsCodeDiagnostics(userDataDirectory: string): string {
	const logsDirectory = join(userDataDirectory, 'logs');
	if (!existsSync(logsDirectory)) return 'VS Code did not create a logs directory.';
	const paths: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.name.endsWith('.log')) paths.push(path);
		}
	};
	visit(logsDirectory);
	const lines = paths
		.filter(path => /(?:main|renderer|exthost|extensionTelemetry|cli|Kusto Workbench)\.log$/i.test(path))
		.flatMap(path => readFileSync(path, 'utf8').split(/\r?\n/)
			.map(line => `${path.slice(logsDirectory.length + 1)}: ${line}`));
	return lines.slice(-200).join('\n') || `No relevant lines found in ${paths.length} VS Code log files.`;
}

function findVsCode(): { commandFile: string; executable: string } {
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot) throw new Error('SystemRoot is unavailable.');
	const commandFile = execFileSync(join(systemRoot, 'System32', 'where.exe'), ['code.cmd'], { encoding: 'utf8' })
		.split(/\r?\n/).map(line => line.trim()).find(line => line.toLowerCase().endsWith('code.cmd'));
	if (!commandFile) throw new Error('The supported VS Code CLI was not found.');
	const executable = join(dirname(dirname(commandFile)), 'Code.exe');
	if (!existsSync(executable)) throw new Error(`VS Code executable was not found at ${executable}.`);
	return { commandFile, executable };
}

function runPowerShell(script: string, overrides: Record<string, string>): Promise<string> {
	const executable = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
	return new Promise((resolvePromise, reject) => {
		execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
			windowsHide: true,
			timeout: 30_000,
			env: environment(overrides),
		}, (error, stdout) => error ? reject(error) : resolvePromise(stdout));
	});
}

async function stopIsolatedVsCode(userDataDirectory: string): Promise<void> {
	const script = String.raw`
$needle = $env:KW_TEST_USER_DATA
$processes = @(Get-CimInstance Win32_Process -Filter "Name='Code.exe'" |
  Where-Object { [string]$_.CommandLine -like "*$needle*" })
$processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
	await runPowerShell(script, { KW_TEST_USER_DATA: userDataDirectory });
	for (let attempt = 0; attempt < 100; attempt++) {
		const count = Number((await runPowerShell(String.raw`
$needle = $env:KW_TEST_USER_DATA
@((Get-CimInstance Win32_Process -Filter "Name='Code.exe'") |
  Where-Object { [string]$_.CommandLine -like "*$needle*" }).Count
`, { KW_TEST_USER_DATA: userDataDirectory })).trim());
		if (count === 0) return;
		await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
	}
	throw new Error('Isolated VS Code processes remained after cleanup.');
}

describe.runIf(enabled)('external MCP cold launch', () => {
	it('launches two explicit instances and keeps background file operations isolated', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-cold-mcp-e2e-'));
		const localAppData = join(root, 'local app data');
		const userDataDirectory = join(root, 'user data');
		const extensionsDirectory = join(root, 'extensions');
		const firstWorkspace = join(root, 'workspace-a');
		const secondWorkspace = join(root, 'workspace-b');
		const extensionRoot = resolve('.');
		const mainVsix = join(root, 'kusto-workbench.vsix');
		const extractedPackage = join(root, 'packaged-extension');
		const vsCode = findVsCode();
		mkdirSync(join(userDataDirectory, 'User'), { recursive: true });
		mkdirSync(firstWorkspace, { recursive: true });
		mkdirSync(secondWorkspace, { recursive: true });
		writeFileSync(join(userDataDirectory, 'User', 'settings.json'), `${JSON.stringify({
			'kustoWorkbench.externalTools.enabled': true,
			'workbench.startupEditor': 'none',
			'security.workspace.trust.enabled': false,
			'telemetry.telemetryLevel': 'off',
			'update.mode': 'none',
			'extensions.autoCheckUpdates': false,
			'extensions.autoUpdate': false,
		}, null, 2)}\n`);

		const cli = {
			commandFile: vsCode.commandFile,
			profileArgs: ['--user-data-dir', userDataDirectory, '--extensions-dir', extensionsDirectory],
		};
		let client: Client | undefined;
		try {
			await packVsix({
				cwd: extensionRoot,
				packagePath: mainVsix,
				version: '5.2.0',
				updatePackageJson: false,
				dependencies: false,
			});
			await extractZip(mainVsix, { dir: extractedPackage });
			const packagedExtensionRoot = join(extractedPackage, 'extension');
			const bootstrapVsix = join(packagedExtensionRoot, 'dist', 'mcp-connector', 'kusto-workbench-mcp-bootstrap.vsix');
			const packageJSON = JSON.parse(readFileSync(join(packagedExtensionRoot, 'package.json'), 'utf8'));
			const context = {
				extensionUri: vscode.Uri.file(packagedExtensionRoot),
				extension: { packageJSON },
			} as unknown as vscode.ExtensionContext;
			expect(existsSync(bootstrapVsix)).toBe(true);
			await executeVsCodeCli(cli, ['--install-extension', mainVsix, '--force']);
			await executeVsCodeCli(cli, ['--install-extension', bootstrapVsix, '--force']);
			const installedExtensions = await executeVsCodeCli(cli, ['--list-extensions']);
			expect(installedExtensions.toLowerCase()).toContain('angelos-petropoulos.vscode-kusto-workbench');
			expect(installedExtensions.toLowerCase()).toContain('angelos-petropoulos.kusto-workbench-mcp-bootstrap');

			const connector = await installExternalMcpConnector({
				context,
				localAppData,
				systemRoot: process.env.SystemRoot!,
				codeExecutable: vsCode.executable,
				codeArguments: [
					'--user-data-dir', userDataDirectory,
					'--extensions-dir', extensionsDirectory,
					'--disable-updates',
					'--disable-workspace-trust',
					'--skip-welcome',
					'--skip-release-notes',
				],
			});
			const transport = new StdioClientTransport({
				command: connector.command,
				args: [...connector.args],
				env: environment({
					LOCALAPPDATA: localAppData,
					KUSTO_WORKBENCH_E2E_BYPASS_FIRST_LAUNCH: '1',
				}),
				stderr: 'pipe',
			});
			let stderr = '';
			transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
			client = new Client(
				{ name: 'kusto-workbench-cold-launch-e2e', version: '1.0.0' },
				{ versionNegotiation: { mode: 'auto' } },
			);
			await client.connect(transport);
			const cold = jsonResult<{ instances: unknown[] }>(await client.callTool({
				name: 'listWorkbenchInstances',
				arguments: {},
			}));
			expect(cold.instances).toEqual([]);

			const launch = async (workspaceFolder: string) => jsonResult<{
				instanceId: string;
				workspaceFolders: string[];
				compatible: boolean;
			}>(await client!.callTool({
				name: 'launchWorkbenchInstance',
				arguments: {
					workspaceFolder,
					timeoutMs: Number(process.env.KUSTO_WORKBENCH_COLD_LAUNCH_TIMEOUT_MS || 120_000),
				},
			}, {
				timeout: Number(process.env.KUSTO_WORKBENCH_COLD_LAUNCH_TIMEOUT_MS || 120_000) + 30_000,
				maxTotalTimeout: Number(process.env.KUSTO_WORKBENCH_COLD_LAUNCH_TIMEOUT_MS || 120_000) + 30_000,
			}));
			const first = await launch(firstWorkspace);
			const second = await launch(secondWorkspace);
			expect(first.compatible).toBe(true);
			expect(second.compatible).toBe(true);
			expect(first.instanceId).not.toBe(second.instanceId);
			expect(first.workspaceFolders.map(pathKey)).toContain(pathKey(firstWorkspace));
			expect(second.workspaceFolders.map(pathKey)).toContain(pathKey(secondWorkspace));

			const firstBase = join(firstWorkspace, 'instance-a-report');
			const secondBase = join(secondWorkspace, 'instance-b-report');
			const [firstCreated, secondCreated] = await Promise.all([
				client.callTool({
					name: 'createKustoFile',
					arguments: {
						instanceId: first.instanceId,
						fileType: 'kqlx',
						filePath: firstBase,
						initialContent: 'print RoutedInstance = "A"',
						reveal: false,
					},
				}, { timeout: 60_000 }),
				client.callTool({
					name: 'createKustoFile',
					arguments: {
						instanceId: second.instanceId,
						fileType: 'kqlx',
						filePath: secondBase,
						initialContent: 'print RoutedInstance = "B"',
						reveal: false,
					},
				}, { timeout: 60_000 }),
			]);
			const firstPath = jsonResult<{ success: boolean; filePath: string }>(firstCreated);
			const secondPath = jsonResult<{ success: boolean; filePath: string }>(secondCreated);
			expect(firstPath.success).toBe(true);
			expect(secondPath.success).toBe(true);
			expect(readFileSync(secondPath.filePath, 'utf8')).toContain('RoutedInstance = \\"B\\"');

			type ListedOpenFile = {
				openFileId: string;
				filePath?: string;
				sections?: Array<{ id: string; type: string }>;
			};
			let firstOpenFile: ListedOpenFile | undefined;
			let querySection: { id: string; type: string } | undefined;
			const editorReadyDeadline = Date.now() + 30_000;
			while (Date.now() < editorReadyDeadline && !querySection) {
				const listedBefore = jsonResult<{
					sections: Array<{ id: string; type: string }>;
					openFiles: ListedOpenFile[];
				}>(await client.callTool({
					name: 'listSections',
					arguments: { instanceId: first.instanceId },
				}, { timeout: 60_000 }));
				firstOpenFile = listedBefore.openFiles.find(file =>
					file.filePath && pathKey(file.filePath) === pathKey(firstPath.filePath));
				querySection = firstOpenFile?.sections?.find(section => section.type === 'query');
				if (!querySection) await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
			}
			expect(firstOpenFile).toBeDefined();
			expect(querySection).toBeDefined();

			const configuredQuery = jsonResult<{ success: boolean }>(await client.callTool({
				name: 'configureKustoQuerySection',
				arguments: {
					instanceId: first.instanceId,
					openFileId: firstOpenFile!.openFileId,
					sectionId: querySection!.id,
					name: 'Routed sample query',
					query: 'datatable(Category:string, Value:long)["Alpha", 3, "Beta", 5]',
					execute: false,
				},
			}, { timeout: 60_000 }));
			expect(configuredQuery.success).toBe(true);

			const markdown = jsonResult<{ success: boolean; sectionId: string }>(await client.callTool({
				name: 'addSection',
				arguments: {
					instanceId: first.instanceId,
					openFileId: firstOpenFile!.openFileId,
					type: 'markdown',
					name: 'Summary',
					text: '# Routed report\n\nCreated through the external MCP connector.',
				},
			}, { timeout: 60_000 }));
			expect(markdown.success).toBe(true);
			const updatedMarkdown = jsonResult<{ success: boolean }>(await client.callTool({
				name: 'updateMarkdownSection',
				arguments: {
					instanceId: first.instanceId,
					openFileId: firstOpenFile!.openFileId,
					sectionId: markdown.sectionId,
					name: 'Summary',
					text: '# Routed report\n\nThis report survived save, close, and reopen.',
					mode: 'preview',
				},
			}, { timeout: 60_000 }));
			expect(updatedMarkdown.success).toBe(true);

			const chart = jsonResult<{ success: boolean; sectionId: string }>(await client.callTool({
				name: 'addSection',
				arguments: {
					instanceId: first.instanceId,
					openFileId: firstOpenFile!.openFileId,
					type: 'chart',
					name: 'Values by category',
					dataSourceId: querySection!.id,
					chartType: 'bar',
				},
			}, { timeout: 60_000 }));
			expect(chart.success).toBe(true);
			const configuredChart = jsonResult<{ success: boolean }>(await client.callTool({
				name: 'configureChart',
				arguments: {
					instanceId: first.instanceId,
					openFileId: firstOpenFile!.openFileId,
					sectionId: chart.sectionId,
					name: 'Values by category',
					dataSourceId: querySection!.id,
					chartType: 'bar',
					xColumn: 'Category',
					yColumns: ['Value'],
					showDataLabels: true,
				},
			}, { timeout: 60_000 }));
			expect(configuredChart.success).toBe(true);

			const saved = jsonResult<{ success: boolean; saved: boolean }>(await client.callTool({
				name: 'saveWorkbenchFile',
				arguments: { instanceId: first.instanceId, openFileId: firstOpenFile!.openFileId },
			}, { timeout: 60_000 }));
			expect(saved.success).toBe(true);
			expect(saved.saved).toBe(true);
			const persisted = JSON.parse(readFileSync(firstPath.filePath, 'utf8')) as {
				state: { sections: Array<Record<string, unknown>> };
			};
			expect(persisted.state.sections).toEqual(expect.arrayContaining([
				expect.objectContaining({
					id: querySection!.id,
					type: 'query',
					name: 'Routed sample query',
					query: 'datatable(Category:string, Value:long)["Alpha", 3, "Beta", 5]',
				}),
				expect.objectContaining({
					id: markdown.sectionId,
					type: 'markdown',
					title: 'Summary',
					text: '# Routed report\n\nThis report survived save, close, and reopen.',
				}),
				expect.objectContaining({
					id: chart.sectionId,
					type: 'chart',
					name: 'Values by category',
					dataSourceId: querySection!.id,
					chartType: 'bar',
					xColumn: 'Category',
					yColumns: ['Value'],
				}),
			]));

			const closed = jsonResult<{ success: boolean; closed: boolean }>(await client.callTool({
				name: 'closeWorkbenchFile',
				arguments: {
					instanceId: first.instanceId,
					openFileId: firstOpenFile!.openFileId,
				},
			}, { timeout: 60_000 }));
			expect(closed).toMatchObject({ success: true, closed: true });
			const reopened = jsonResult<{ success: boolean }>(await client.callTool({
				name: 'activateWorkbenchFile',
				arguments: { instanceId: first.instanceId, targetFileUri: firstPath.filePath },
			}, { timeout: 60_000 }));
			expect(reopened.success).toBe(true);
			let restored: { filePath?: string; sections?: Array<{ id: string; type: string }> } | undefined;
			const reopenDeadline = Date.now() + 30_000;
			while (Date.now() < reopenDeadline && !restored?.sections) {
				const listedAfter = jsonResult<{
					openFiles: Array<{ filePath?: string; sections?: Array<{ id: string; type: string }> }>;
				}>(await client.callTool({
					name: 'listSections',
					arguments: { instanceId: first.instanceId },
				}, { timeout: 60_000 }));
				restored = listedAfter.openFiles.find(file =>
					file.filePath && pathKey(file.filePath) === pathKey(firstPath.filePath));
				if (!restored?.sections) await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
			}
			expect(restored?.sections?.map(section => section.type)).toEqual(['query', 'markdown', 'chart']);

			const crossSave = jsonResult<{ success: boolean; error?: string }>(await client.callTool({
				name: 'saveWorkbenchFile',
				arguments: { instanceId: second.instanceId, targetFileUri: firstPath.filePath },
			}, { timeout: 60_000 }));
			expect(crossSave.success).toBe(false);
			expect(crossSave.error).toContain('No matching open Kusto Workbench file');

			const listed = jsonResult<{ instances: Array<{ instanceId: string }> }>(await client.callTool({
				name: 'listWorkbenchInstances',
				arguments: {},
			}));
			expect(listed.instances.map(instance => instance.instanceId).sort())
				.toEqual([first.instanceId, second.instanceId].sort());
			expect(readdirSync(join(localAppData, 'KustoWorkbench', 'McpConnector', 'launches'))).toHaveLength(2);
			expect(stderr).toBe('');
		} catch (error) {
			await stopIsolatedVsCode(userDataDirectory).catch(() => undefined);
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}\n\n${collectVsCodeDiagnostics(userDataDirectory)}`,
				{ cause: error },
			);
		} finally {
			await client?.close().catch(() => undefined);
			await stopIsolatedVsCode(userDataDirectory).catch(() => undefined);
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	}, 540_000);
});