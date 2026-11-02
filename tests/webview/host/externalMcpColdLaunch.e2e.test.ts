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
import { copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import extractZip from 'extract-zip';
import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { installExternalMcpConnector } from '../../../src/host/externalMcpConnectorInstaller';
import { acquireExternalMcpRuntimeArchive } from '../../../src/host/externalMcpRuntime';
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

type OperationRequest = { name: string; arguments: Record<string, unknown> };
type ExecuteOperation = (
	request: OperationRequest, options: { timeout: number },
) => Promise<{ content: readonly unknown[] }>;

async function executeAfterExplicitLoading<T>(
	executeOperation: ExecuteOperation, request: OperationRequest, marker: string,
): Promise<T> {
	const deadline = Date.now() + 30_000;
	while (true) {
		const response = await executeOperation(request, { timeout: 60_000 });
		if (textResult(response) !== 'Error: This document is still loading and cannot accept mutations yet.') {
			return jsonResult<T>(response);
		}
		if (Date.now() >= deadline) throw new Error(`${marker}: ${request.name} never became ready.`);
		await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
	}
}

describe('cold-launch explicit-loading retries', () => {
	const request: OperationRequest = {
		name: 'updateMarkdownSection',
		arguments: { instanceId: 'instance-a', openFileId: 'report-a', sectionId: 'markdown-a', text: 'Updated' },
	};
	const reply = (text: string) => ({ content: [{ type: 'text', text }] });
	const loading = 'Error: This document is still loading and cannot accept mutations yet.';

	it('retries only the explicitly rejected operation on the same instance and file', async () => {
		vi.useFakeTimers();
		const execute = vi.fn().mockResolvedValueOnce(reply(loading)).mockResolvedValueOnce(reply('{"success":true}'));
		try {
			const pending = executeAfterExplicitLoading<{ success: boolean }>(execute, request, 'report-a');
			await vi.advanceTimersByTimeAsync(250);
			await expect(pending).resolves.toEqual({ success: true });
			expect(execute).toHaveBeenCalledTimes(2);
			for (const call of execute.mock.calls) {
				expect(call[0]).toBe(request);
				expect(call[1]).toEqual({ timeout: 60_000 });
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		'Error: Request timed out',
		'Error: This document is invalid and its retained sections are read-only.',
		'Error: The targeted Kusto Workbench editor closed before the request was dispatched.',
		`${loading} Additional detail.`,
	])('does not replay a different or ambiguous failure: %s', async error => {
		const execute = vi.fn().mockResolvedValue(reply(error));
		await expect(executeAfterExplicitLoading(execute, request, 'report-a')).rejects.toThrow('Expected a JSON MCP result');
		expect(execute).toHaveBeenCalledOnce();
	});

	it('does not replay an operation whose response was lost', async () => {
		const error = new Error('Connection closed before the response arrived');
		const execute = vi.fn().mockRejectedValue(error);
		await expect(executeAfterExplicitLoading(execute, request, 'report-a')).rejects.toBe(error);
		expect(execute).toHaveBeenCalledOnce();
	});

	it('keeps an explicit unsuccessful result for the caller to assert without retrying', async () => {
		const execute = vi.fn().mockResolvedValue(reply('{"success":false,"error":"Mutation failed"}'));
		await expect(executeAfterExplicitLoading(execute, request, 'report-a'))
			.resolves.toEqual({ success: false, error: 'Mutation failed' });
		expect(execute).toHaveBeenCalledOnce();
	});

	it('fails when the existing readiness deadline expires', async () => {
		vi.useFakeTimers();
		const execute = vi.fn().mockResolvedValue(reply(loading));
		try {
			const result = executeAfterExplicitLoading(execute, request, 'report-a').catch(error => error);
			await vi.advanceTimersByTimeAsync(30_000);
			await expect(result).resolves.toEqual(new Error('report-a: updateMarkdownSection never became ready.'));
			expect(execute).toHaveBeenCalledTimes(121);
		} finally {
			vi.useRealTimers();
		}
	});
});

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

function collectSaveFailures(userDataDirectory: string): string[] {
	const logsDirectory = join(userDataDirectory, 'logs');
	if (!existsSync(logsDirectory)) return [];
	const failures: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const filePath = join(directory, entry.name);
			if (entry.isDirectory()) visit(filePath);
			else if (/^(?:exthost|Kusto Workbench)\.log$/i.test(entry.name)) {
				failures.push(...readFileSync(filePath, 'utf8').split(/\r?\n/)
					.filter(line => line.includes('onWillSaveTextDocument-listener') && line.includes('threw ERROR')
						|| line.includes('[sql-persistence] Final snapshot unavailable; saving fail-closed state:'))
					.map(line => `${filePath.slice(logsDirectory.length + 1)}: ${line}`));
			}
		}
	};
	visit(logsDirectory);
	return failures;
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
		let failure: Error | undefined;
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
				...(process.env.KUSTO_WORKBENCH_MCP_STRESS_RUNTIME_ARCHIVE ? {
					acquireRuntimeArchive: (metadata, cacheDirectory) => acquireExternalMcpRuntimeArchive(
						metadata, cacheDirectory,
						async (_url, destination) => copyFile(process.env.KUSTO_WORKBENCH_MCP_STRESS_RUNTIME_ARCHIVE!, destination),
					),
				} : {}),
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
			const exposedTools = await client.listTools();
			expect(exposedTools.tools.map(tool => tool.name).sort()).toEqual(['execute-tool', 'list-tools']);
			const discovered = jsonResult<{ operations: Array<{ name: string; summary: string }> }>(await client.callTool({
				name: 'list-tools', arguments: {},
			}));
			expect(discovered.operations).toHaveLength(packageJSON.contributes.languageModelTools.length + 4);
			expect(discovered.operations.find(operation => operation.name === 'createKustoFile')?.summary).toBeTruthy();
			expect(discovered.operations[0]).not.toHaveProperty('inputSchema');
			const createSchema = jsonResult<{ inputSchema: { required: string[] } }>(await client.callTool({
				name: 'list-tools', arguments: { name: 'createKustoFile' },
			}));
			expect(createSchema.inputSchema.required).toEqual(expect.arrayContaining(['instanceId', 'filePath', 'fileType']));
			const executeOperation = (
				request: { name: string; arguments: Record<string, unknown> },
				options?: Parameters<Client['callTool']>[1],
			) => client!.callTool({ name: 'execute-tool', arguments: request }, options);
			const cold = jsonResult<{ instances: unknown[] }>(await executeOperation({
				name: 'listWorkbenchInstances',
				arguments: {},
			}));
			expect(cold.instances).toEqual([]);

			const launch = async (workspaceFolder: string) => jsonResult<{
				instanceId: string;
				workspaceFolders: string[];
				compatible: boolean;
			}>(await executeOperation({
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
				executeOperation({
					name: 'createKustoFile',
					arguments: {
						instanceId: first.instanceId,
						fileType: 'kqlx',
						filePath: firstBase,
						initialContent: 'print RoutedInstance = "A"',
						reveal: false,
					},
				}, { timeout: 60_000 }),
				executeOperation({
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
				}>(await executeOperation({
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
			if (process.env.KUSTO_WORKBENCH_RUN_MCP_STRESS === '1') {
				let secondReady = false;
				const secondReadyDeadline = Date.now() + 30_000;
				while (!secondReady && Date.now() < secondReadyDeadline) {
					const listedSecond = jsonResult<{ openFiles: ListedOpenFile[] }>(await executeOperation({
						name: 'listSections', arguments: { instanceId: second.instanceId },
					}, { timeout: 60_000 }));
					secondReady = listedSecond.openFiles.some(file =>
						file.filePath && pathKey(file.filePath) === pathKey(secondPath.filePath) && !!file.sections);
					if (!secondReady) await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
				}
				expect(secondReady).toBe(true);
				for (const concurrency of [1, 4, 8, 16]) {
					const durations: number[] = [];
					for (let startIndex = 0; startIndex < 32; startIndex += concurrency) {
						await Promise.all(Array.from({ length: Math.min(concurrency, 32 - startIndex) }, async (_, offset) => {
							const requestIndex = startIndex + offset;
							const target = requestIndex % 2 === 0 ? first : second;
							const ownPath = requestIndex % 2 === 0 ? firstPath.filePath : secondPath.filePath;
							const otherPath = requestIndex % 2 === 0 ? secondPath.filePath : firstPath.filePath;
							const started = performance.now();
							if (requestIndex % 4 < 2) {
								const checked = jsonResult<{ instanceId: string; compatible: boolean }>(await executeOperation({
									name: 'checkWorkbenchInstance', arguments: { instanceId: target.instanceId },
								}, { timeout: 60_000 }));
								expect(checked).toMatchObject({ instanceId: target.instanceId, compatible: true });
							} else {
								const listed = jsonResult<{ openFiles: ListedOpenFile[] }>(await executeOperation({
									name: 'listSections', arguments: { instanceId: target.instanceId },
								}, { timeout: 60_000 }));
								const paths = listed.openFiles.flatMap(file => file.filePath ? [pathKey(file.filePath)] : []);
								expect(paths).toContain(pathKey(ownPath));
								expect(paths).not.toContain(pathKey(otherPath));
							}
							durations.push(performance.now() - started);
						}));
					}
					durations.sort((left, right) => left - right);
					console.info(`MCP provider concurrency ${concurrency}: 32 calls, p95 ${durations[30].toFixed(1)} ms, max ${durations[31].toFixed(1)} ms`);
				}
			}

			const configuredQuery = await executeAfterExplicitLoading<{ success: boolean }>(executeOperation, {
				name: 'configureKustoQuerySection',
				arguments: {
					instanceId: first.instanceId,
					openFileId: firstOpenFile!.openFileId,
					sectionId: querySection!.id,
					name: 'Routed sample query',
					query: 'datatable(Category:string, Value:long)["Alpha", 3, "Beta", 5]',
					execute: false,
				},
			}, firstPath.filePath);
			expect(configuredQuery.success).toBe(true);

			const markdown = await executeAfterExplicitLoading<{ success: boolean; sectionId: string }>(executeOperation, {
				name: 'addSection',
				arguments: {
					instanceId: first.instanceId,
					openFileId: firstOpenFile!.openFileId,
					type: 'markdown',
					name: 'Summary',
					text: '# Routed report\n\nCreated through the external MCP connector.',
				},
			}, firstPath.filePath);
			expect(markdown.success).toBe(true);
			const updatedMarkdown = await executeAfterExplicitLoading<{ success: boolean }>(executeOperation, {
				name: 'updateMarkdownSection',
				arguments: {
					instanceId: first.instanceId,
					openFileId: firstOpenFile!.openFileId,
					sectionId: markdown.sectionId,
					name: 'Summary',
					text: '# Routed report\n\nThis report survived save, close, and reopen.',
					mode: 'preview',
				},
			}, firstPath.filePath);
			expect(updatedMarkdown.success).toBe(true);

			const chart = await executeAfterExplicitLoading<{ success: boolean; sectionId: string }>(executeOperation, {
				name: 'addSection',
				arguments: {
					instanceId: first.instanceId,
					openFileId: firstOpenFile!.openFileId,
					type: 'chart',
					name: 'Values by category',
					dataSourceId: querySection!.id,
					chartType: 'bar',
				},
			}, firstPath.filePath);
			expect(chart.success).toBe(true);
			const configuredChart = await executeAfterExplicitLoading<{ success: boolean }>(executeOperation, {
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
			}, firstPath.filePath);
			expect(configuredChart.success).toBe(true);

			const saved = await executeAfterExplicitLoading<{ success: boolean; saved: boolean }>(executeOperation, {
				name: 'saveWorkbenchFile',
				arguments: { instanceId: first.instanceId, openFileId: firstOpenFile!.openFileId },
			}, firstPath.filePath);
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
					mode: 'preview',
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

			const closed = await executeAfterExplicitLoading<{ success: boolean; closed: boolean }>(executeOperation, {
				name: 'closeWorkbenchFile',
				arguments: {
					instanceId: first.instanceId,
					openFileId: firstOpenFile!.openFileId,
				},
			}, firstPath.filePath);
			expect(closed).toMatchObject({ success: true, closed: true });
			const reopened = jsonResult<{ success: boolean }>(await executeOperation({
				name: 'activateWorkbenchFile',
				arguments: { instanceId: first.instanceId, targetFileUri: firstPath.filePath },
			}, { timeout: 60_000 }));
			expect(reopened.success).toBe(true);
			let restored: { filePath?: string; sections?: Array<{ id: string; type: string }> } | undefined;
			const reopenDeadline = Date.now() + 30_000;
			while (Date.now() < reopenDeadline && !restored?.sections) {
				const listedAfter = jsonResult<{
					openFiles: Array<{ filePath?: string; sections?: Array<{ id: string; type: string }> }>;
				}>(await executeOperation({
					name: 'listSections',
					arguments: { instanceId: first.instanceId },
				}, { timeout: 60_000 }));
				restored = listedAfter.openFiles.find(file =>
					file.filePath && pathKey(file.filePath) === pathKey(firstPath.filePath));
				if (!restored?.sections) await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
			}
			expect(restored?.sections?.map(section => section.type)).toEqual(['query', 'markdown', 'chart']);

			const revisedMarkdown = '# Routed report\n\nEdited again after reopening.';
			const editedAfterReopen = await executeAfterExplicitLoading<{ success: boolean }>(executeOperation, {
				name: 'updateMarkdownSection',
				arguments: { instanceId: first.instanceId, targetFileUri: firstPath.filePath,
					sectionId: markdown.sectionId, text: revisedMarkdown },
			}, firstPath.filePath);
			expect(editedAfterReopen.success).toBe(true);
			const resaved = await executeAfterExplicitLoading<{ success: boolean; saved: boolean }>(executeOperation, {
				name: 'saveWorkbenchFile',
				arguments: { instanceId: first.instanceId, targetFileUri: firstPath.filePath },
			}, firstPath.filePath);
			expect(resaved).toMatchObject({ success: true, saved: true });
			expect(JSON.parse(readFileSync(firstPath.filePath, 'utf8')).state.sections).toEqual([
				expect.objectContaining(persisted.state.sections[0]),
				expect.objectContaining({ id: markdown.sectionId, type: 'markdown', title: 'Summary', text: revisedMarkdown, mode: 'preview' }),
				expect.objectContaining(persisted.state.sections[2]),
			]);

			const crossSave = jsonResult<{ success: boolean; error?: string }>(await executeOperation({
				name: 'saveWorkbenchFile',
				arguments: { instanceId: second.instanceId, targetFileUri: firstPath.filePath },
			}, { timeout: 60_000 }));
			expect(crossSave.success).toBe(false);
			expect(crossSave.error).toContain('No matching open Kusto Workbench file');
			if (process.env.KUSTO_WORKBENCH_RUN_MCP_STRESS === '1') {
				const findOpenFile = async (instanceId: string, filePath: string): Promise<ListedOpenFile> => {
					const deadline = Date.now() + 30_000;
					while (Date.now() < deadline) {
						const listedFiles = jsonResult<{ openFiles: ListedOpenFile[] }>(await executeOperation({
							name: 'listSections', arguments: { instanceId },
						}, { timeout: 60_000 }));
						const found = listedFiles.openFiles.find(file =>
							file.filePath && pathKey(file.filePath) === pathKey(filePath) && file.sections);
						if (found) return found;
						await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
					}
					throw new Error(`Workbench did not expose the isolated report ${filePath}.`);
				};
				const stressCycles = Number(process.env.KUSTO_WORKBENCH_MCP_STRESS_CYCLES ?? 10);
				expect(Number.isSafeInteger(stressCycles) && stressCycles >= 1 && stressCycles <= 10).toBe(true);
				const started = performance.now();
				await Promise.all([first, second].map(async (instance, instanceIndex) => {
					const workspaceFolder = instanceIndex === 0 ? firstWorkspace : secondWorkspace;
					const otherWorkspace = instanceIndex === 0 ? secondWorkspace : firstWorkspace;
					for (let iteration = 0; iteration < stressCycles; iteration++) {
						const marker = `Window${instanceIndex}-Revision${iteration}`;
						const query = `print Marker = "${marker}"`;
						const markdownText = `# ${marker}`;
						const created = jsonResult<{ success: boolean; filePath: string }>(await executeOperation({
							name: 'createKustoFile', arguments: {
								instanceId: instance.instanceId, fileType: 'kqlx',
								filePath: join(workspaceFolder, `stress-${instanceIndex}-${iteration}`),
								initialContent: query, reveal: false,
							},
						}, { timeout: 60_000 }));
						expect(created.success).toBe(true);
						expect(pathKey(created.filePath)).toBe(pathKey(join(workspaceFolder, `stress-${instanceIndex}-${iteration}.kqlx`)));
						expect(existsSync(join(otherWorkspace, `stress-${instanceIndex}-${iteration}.kqlx`))).toBe(false);
						const openFile = await findOpenFile(instance.instanceId, created.filePath);
						const source = openFile.sections!.find(section => section.type === 'query');
						expect(source).toBeDefined();
						const configured = await executeAfterExplicitLoading<{ success: boolean }>(executeOperation, {
							name: 'configureKustoQuerySection', arguments: {
								instanceId: instance.instanceId, openFileId: openFile.openFileId,
								sectionId: source!.id, name: marker, query, execute: false,
							},
						}, marker);
						expect(configured.success).toBe(true);
						const added = await executeAfterExplicitLoading<{ success: boolean; sectionId: string }>(executeOperation, {
							name: 'addSection', arguments: {
								instanceId: instance.instanceId, openFileId: openFile.openFileId,
								type: 'markdown', name: marker, text: markdownText,
							},
						}, marker);
						expect(added, `${marker}: ${JSON.stringify(added)}`).toMatchObject({ success: true });
						const saved = await executeAfterExplicitLoading<{ success: boolean; saved: boolean }>(executeOperation, {
							name: 'saveWorkbenchFile', arguments: { instanceId: instance.instanceId, openFileId: openFile.openFileId },
						}, marker);
						expect(saved).toMatchObject({ success: true, saved: true });
						const savedText = readFileSync(created.filePath, 'utf8');
						const sections = (JSON.parse(savedText) as { state: { sections: Array<Record<string, unknown>> } }).state.sections;
						expect(sections).toEqual(expect.arrayContaining([
							expect.objectContaining({ id: source!.id, type: 'query', name: marker, query }),
							expect.objectContaining({ id: added.sectionId, type: 'markdown', title: marker, text: markdownText }),
						]));
						const closed = await executeAfterExplicitLoading<{ success: boolean; closed: boolean }>(executeOperation, {
							name: 'closeWorkbenchFile', arguments: { instanceId: instance.instanceId, openFileId: openFile.openFileId },
						}, marker);
						expect(closed).toMatchObject({ success: true, closed: true });
						const activated = jsonResult<{ success: boolean }>(await executeOperation({
							name: 'activateWorkbenchFile', arguments: { instanceId: instance.instanceId, targetFileUri: created.filePath },
						}, { timeout: 60_000 }));
						expect(activated.success).toBe(true);
						const reopened = await findOpenFile(instance.instanceId, created.filePath);
						expect(reopened.sections?.map(section => section.id)).toEqual([source!.id, added.sectionId]);
						expect(readFileSync(created.filePath, 'utf8')).toBe(savedText);
						const edited = await executeAfterExplicitLoading<{ success: boolean }>(executeOperation, {
							name: 'updateMarkdownSection', arguments: {
								instanceId: instance.instanceId, openFileId: reopened.openFileId,
								sectionId: added.sectionId, text: `${markdownText}\n\nEdited after reopen.`,
							},
						}, marker);
						expect(edited.success).toBe(true);
						const resaved = await executeAfterExplicitLoading<{ success: boolean; saved: boolean }>(executeOperation, {
							name: 'saveWorkbenchFile', arguments: { instanceId: instance.instanceId, openFileId: reopened.openFileId },
						}, marker);
						expect(resaved).toMatchObject({ success: true, saved: true });
						const revised = (JSON.parse(readFileSync(created.filePath, 'utf8')) as {
							state: { sections: Array<Record<string, unknown>> };
						}).state.sections;
						expect(revised).toEqual(expect.arrayContaining([
							expect.objectContaining({ id: added.sectionId, title: marker, text: `${markdownText}\n\nEdited after reopen.` }),
						]));
						const finished = await executeAfterExplicitLoading<{ success: boolean; closed: boolean }>(executeOperation, {
							name: 'closeWorkbenchFile', arguments: { instanceId: instance.instanceId, openFileId: reopened.openFileId },
						}, marker);
						expect(finished).toMatchObject({ success: true, closed: true });
					}
					console.info(`MCP window ${instanceIndex}: ${stressCycles} saved/reopened report cycles passed`);
				}));
				console.info(`MCP report cycles: ${stressCycles * 2} total in ${((performance.now() - started) / 1000).toFixed(1)} s`);
			}

			const listed = jsonResult<{ instances: Array<{ instanceId: string }> }>(await executeOperation({
				name: 'listWorkbenchInstances',
				arguments: {},
			}));
			expect(listed.instances.map(instance => instance.instanceId).sort())
				.toEqual([first.instanceId, second.instanceId].sort());
			expect(readdirSync(join(localAppData, 'KustoWorkbench', 'McpConnector', 'launches'))).toHaveLength(2);
			expect(stderr).toBe('');
			if (process.env.KUSTO_WORKBENCH_RUN_MCP_STRESS === '1') {
				expect(existsSync(join(userDataDirectory, 'logs'))).toBe(true);
				expect(collectSaveFailures(userDataDirectory)).toEqual([]);
			}
		} catch (error) {
			failure = new Error(
				`${error instanceof Error ? error.message : String(error)}\n\n${collectVsCodeDiagnostics(userDataDirectory)}`,
				{ cause: error },
			);
			throw failure;
		} finally {
			await client?.close().catch(() => undefined);
			try {
				await stopIsolatedVsCode(userDataDirectory);
			} catch (cleanupError) {
				throw new AggregateError(
					[...(failure ? [failure] : []), cleanupError],
					`Isolated VS Code cleanup failed; retained ${root} for inspection.`,
				);
			}
			if (failure) console.error(`Retained isolated MCP test artifacts at ${root}`);
			else rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	}, process.env.KUSTO_WORKBENCH_RUN_MCP_STRESS === '1' ? 1_200_000 : 540_000);
});