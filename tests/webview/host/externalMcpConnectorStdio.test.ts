import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

describe('external MCP connector stdio', () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it('exposes only discovery and execution while retaining the full operation catalog', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-connector-cold-'));
		roots.push(root);
		const configPath = join(root, 'config.json');
		writeFileSync(configPath, JSON.stringify({
			schemaVersion: 1,
			connectorVersion: 'test',
			toolManifestPath: resolve('package.json'),
			guidancePath: resolve('copilot-instructions/external-mcp-client.md'),
			discoveryDirectory: join(root, 'discovery'),
			launchDirectory: join(root, 'launches'),
			codeExecutable: process.execPath,
		}), 'utf8');
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [resolve('dist/mcp-connector/connector.cjs'), '--config', configPath],
			stderr: 'pipe',
		});
		let stderr = '';
		transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
		const client = new Client(
			{ name: 'connector-cold-test', version: '1.0.0' },
			{ versionNegotiation: { mode: 'auto' } },
		);
		try {
			await client.connect(transport);
			const listed = await client.listTools();
			const names = listed.tools.map(tool => tool.name);
			const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
			expect(names.sort()).toEqual(['execute-tool', 'list-tools']);
			const catalog = await client.callTool({ name: 'list-tools', arguments: {} });
			expect(catalog.isError).not.toBe(true);
			const operations = JSON.parse((catalog.content[0] as { text: string }).text).operations as { name: string }[];
			expect(operations).toHaveLength(manifest.contributes.languageModelTools.length + 4);
			for (const required of [
				'listWorkbenchInstances',
				'checkWorkbenchInstance',
				'launchWorkbenchInstance',
				'getWorkbenchGuidance',
				'listSections',
				'createKustoFile',
			]) expect(operations.map(operation => operation.name)).toContain(required);

			const details = await client.callTool({ name: 'list-tools', arguments: { name: 'createKustoFile' } });
			expect(details.isError).not.toBe(true);
			expect(JSON.parse((details.content[0] as { text: string }).text).inputSchema.required).toContain('instanceId');

			const result = await client.callTool({ name: 'execute-tool', arguments: { name: 'listWorkbenchInstances', arguments: {} } });
			expect(result.isError).not.toBe(true);
			expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ instances: [] });
			const guidance = await client.callTool({ name: 'execute-tool', arguments: { name: 'getWorkbenchGuidance', arguments: {} } });
			const guidanceText = (guidance.content[0] as { text: string }).text;
			expect(guidanceText).toContain('pass its exact `instanceId` inside `arguments`');
			expect(guidanceText).toContain('`list-tools`');
			expect(guidanceText).toContain('`execute-tool`');
			expect(guidanceText).toContain('do not replay it automatically');
			expect(guidanceText).toContain('This document is still loading and cannot accept mutations yet.');
			expect(guidanceText).not.toContain('#runSubagent');
			if (process.env.KUSTO_WORKBENCH_RUN_MCP_STRESS === '1') {
				for (const concurrency of [1, 4, 8, 16]) {
					const durations: number[] = [];
					for (let startIndex = 0; startIndex < 128; startIndex += concurrency) {
						await Promise.all(Array.from({ length: Math.min(concurrency, 128 - startIndex) }, async (_, offset) => {
							const started = performance.now();
							switch ((startIndex + offset) % 4) {
								case 0: {
									const tools = await client.listTools();
									expect(tools.tools.map(tool => tool.name).sort()).toEqual(['execute-tool', 'list-tools']);
									break;
								}
								case 1: {
									const response = await client.callTool({ name: 'list-tools', arguments: {} });
									expect(response.isError).not.toBe(true);
									expect(JSON.parse((response.content[0] as { text: string }).text).operations)
										.toHaveLength(manifest.contributes.languageModelTools.length + 4);
									break;
								}
								case 2: {
									const response = await client.callTool({ name: 'list-tools', arguments: { name: 'createKustoFile' } });
									expect(response.isError).not.toBe(true);
									expect(JSON.parse((response.content[0] as { text: string }).text).inputSchema.required)
										.toContain('instanceId');
									break;
								}
								default: {
									const response = await client.callTool({
										name: 'execute-tool', arguments: { name: 'listWorkbenchInstances', arguments: {} },
									});
									expect(response.isError).not.toBe(true);
									expect(JSON.parse((response.content[0] as { text: string }).text)).toEqual({ instances: [] });
								}
							}
							durations.push(performance.now() - started);
						}));
					}
					durations.sort((left, right) => left - right);
					console.info(`MCP STDIO concurrency ${concurrency}: 128 calls, p95 ${durations[121].toFixed(1)} ms, max ${durations[127].toFixed(1)} ms`);
				}
				for (let startIndex = 0; startIndex < 128; startIndex += 16) {
					const invalidRequests = await Promise.all(Array.from({ length: 16 }, (_, offset) => client.callTool({
						name: 'execute-tool', arguments: {
							name: 'createKustoFile', arguments: {
								instanceId: 'nonexistent-instance', filePath: join(root, `invalid-${startIndex + offset}`),
							},
						},
					})));
					for (const rejected of invalidRequests) {
						expect(rejected.isError).toBe(true);
						expect((rejected.content[0] as { text: string }).text).toContain('Input schema:');
					}
				}
				expect(existsSync(join(root, 'invalid-0.kqlx'))).toBe(false);
				console.info('MCP STDIO validation: 128 invalid mutations rejected before routing, 16 in flight');
				const staleRequests = await Promise.all(Array.from({ length: 16 }, (_, index) => client.callTool({
					name: 'execute-tool', arguments: {
						name: 'createKustoFile', arguments: {
							instanceId: 'nonexistent-instance', fileType: 'kqlx', filePath: join(root, `stale-${index}`),
						},
					},
				})));
				for (const [index, rejected] of staleRequests.entries()) {
					expect(rejected.isError).toBe(true);
					expect((rejected.content[0] as { text: string }).text).toContain('Unknown or stale Kusto Workbench instance');
					expect(existsSync(join(root, `stale-${index}.kqlx`))).toBe(false);
				}
				console.info('MCP STDIO routing: 16 valid-schema calls rejected for a stale instance without creating files');
			}
		} finally {
			await client.close();
		}
		expect(stderr).toBe('');
	});
});