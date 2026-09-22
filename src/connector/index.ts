import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createExternalMcpCatalog } from '../shared/externalMcpCatalog';
import { ExternalMcpConnectorCore, type ConnectorToolResult } from './externalMcpConnectorCore';
import { createNodeConnectorDependencies, loadConnectorConfig } from './externalMcpConnectorNode';

function configArgument(argv: readonly string[]): string {
	const index = argv.indexOf('--config');
	if (index < 0 || !argv[index + 1]) throw new Error('Kusto Workbench connector requires --config <path>.');
	return resolve(argv[index + 1]);
}

function asMcpResult(result: ConnectorToolResult) {
	return {
		content: [...result.content],
		...(result.isError ? { isError: true } : {}),
	};
}

function asInput(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function main(): Promise<void> {
	const config = await loadConnectorConfig(configArgument(process.argv.slice(2)));
	const manifest = JSON.parse(await readFile(config.toolManifestPath, 'utf8'));
	const catalog = createExternalMcpCatalog(manifest.contributes.languageModelTools);
	const guidance = await readFile(config.guidancePath, 'utf8');
	const core = new ExternalMcpConnectorCore(catalog, createNodeConnectorDependencies(config));
	const server = new McpServer({
		name: 'kusto-workbench',
		version: config.connectorVersion,
	}, {
		instructions: 'Use listWorkbenchInstances or launchWorkbenchInstance first. Every Workbench operation requires the exact instanceId. Use getWorkbenchGuidance for the complete workflow.',
	});

	server.registerTool('listWorkbenchInstances', {
		title: 'List Kusto Workbench Instances',
		description: 'Lists eligible running Kusto Workbench VS Code instances. Results never include discovery endpoints or credentials.',
		inputSchema: fromJsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
	}, async (_input, context) => asMcpResult(await core.listInstances(context.mcpReq.signal)));
	server.registerTool('checkWorkbenchInstance', {
		title: 'Check Kusto Workbench Instance',
		description: 'Checks that one exact Kusto Workbench instance is still running and compatible.',
		inputSchema: fromJsonSchema({
			type: 'object',
			properties: { instanceId: { type: 'string', pattern: '.*\\S.*' } },
			required: ['instanceId'],
			additionalProperties: false,
		}),
	}, async input => asMcpResult(await core.checkInstance(String(asInput(input).instanceId))));
	server.registerTool('launchWorkbenchInstance', {
		title: 'Launch Kusto Workbench Instance',
		description: 'Launches a new VS Code window for an existing local workspace folder and waits for its Kusto Workbench provider to become ready.',
		inputSchema: fromJsonSchema({
			type: 'object',
			properties: {
				workspaceFolder: { type: 'string', pattern: '.*\\S.*' },
				timeoutMs: { type: 'integer', minimum: 1000, maximum: 180000 },
			},
			required: ['workspaceFolder'],
			additionalProperties: false,
		}),
	}, async (input, context) => {
		const values = asInput(input);
		return asMcpResult(await core.launchInstance({
			workspaceFolder: String(values.workspaceFolder),
			...(typeof values.timeoutMs === 'number' ? { timeoutMs: values.timeoutMs } : {}),
		}, context.mcpReq.signal));
	});
	server.registerTool('getWorkbenchGuidance', {
		title: 'Get Kusto Workbench Guidance',
		description: 'Returns the portable Kusto Workbench tool workflow and safety guidance.',
		inputSchema: fromJsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
	}, async () => ({ content: [{ type: 'text' as const, text: guidance }] }));

	for (const tool of catalog.tools) {
		server.registerTool(tool.name, {
			...(tool.title ? { title: tool.title } : {}),
			description: tool.description,
			inputSchema: fromJsonSchema(tool.inputSchema),
		}, async (input, context) => asMcpResult(await core.invokeWorkbenchTool(tool.name, input, context.mcpReq.signal)));
	}

	const transport = new StdioServerTransport();
	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		void server.close().finally(() => {
			process.exitCode = 0;
			process.stdin.unref();
		});
	};
	process.stdin.once('end', shutdown);
	process.stdin.once('close', shutdown);
	process.once('SIGTERM', shutdown);
	await server.connect(transport);
}

console.log = (...values: unknown[]) => console.error(...values);
console.info = (...values: unknown[]) => console.error(...values);
console.debug = (...values: unknown[]) => console.error(...values);

void main().catch(error => {
	console.error(`Kusto Workbench connector failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});