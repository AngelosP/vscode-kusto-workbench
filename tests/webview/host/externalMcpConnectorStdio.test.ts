import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

	it('lists management and canonical Workbench tools without a running provider', async () => {
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
			expect(names).toHaveLength(manifest.contributes.languageModelTools.length + 4);
			for (const required of [
				'listWorkbenchInstances',
				'checkWorkbenchInstance',
				'launchWorkbenchInstance',
				'getWorkbenchGuidance',
				'listSections',
				'createKustoFile',
			]) expect(names).toContain(required);

			const result = await client.callTool({ name: 'listWorkbenchInstances', arguments: {} });
			expect(result.isError).not.toBe(true);
			expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ instances: [] });
			const guidance = await client.callTool({ name: 'getWorkbenchGuidance', arguments: {} });
			const guidanceText = (guidance.content[0] as { text: string }).text;
			expect(guidanceText).toContain('pass its exact `instanceId` to every Workbench tool call');
			expect(guidanceText).toContain('do not replay it automatically');
			expect(guidanceText).not.toContain('#runSubagent');
		} finally {
			await client.close();
		}
		expect(stderr).toBe('');
	});
});