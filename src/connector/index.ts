import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createExternalMcpCatalog } from '../shared/externalMcpCatalog';
import { ExternalMcpConnectorCore, type ConnectorToolResult } from './externalMcpConnectorCore';
import { createNodeConnectorDependencies, loadConnectorConfig } from './externalMcpConnectorNode';
import { createExternalMcpOperations } from './externalMcpOperations';

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
	const operations = createExternalMcpOperations(catalog, core, guidance);
	const server = new McpServer({
		name: 'kusto-workbench',
		version: config.connectorVersion,
	}, {
		instructions: 'Call list-tools to discover operations or fetch one schema. Call execute-tool with an operation name and arguments. Start with getWorkbenchGuidance and listWorkbenchInstances; pass the exact instanceId for Workbench operations.',
	});

	server.registerTool('list-tools', {
		title: 'List Kusto Workbench Operations',
		description: 'Discover Kusto Workbench operation names and short summaries. Optionally search with query or request the exact input schema for one name. Use execute-tool to run an operation.',
		inputSchema: fromJsonSchema({
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Exact operation name to get its full input schema.' },
				query: { type: 'string', description: 'Optional case-insensitive search across operation names and summaries.' },
			},
			additionalProperties: false,
		}),
	}, async input => {
		const values = asInput(input);
		return asMcpResult(operations.list(values.name as string | undefined, values.query as string | undefined));
	});
	server.registerTool('execute-tool', {
		title: 'Execute Kusto Workbench Operation',
		description: 'Execute a named Workbench operation with arguments matching its schema from list-tools. To begin, execute getWorkbenchGuidance and listWorkbenchInstances with empty arguments; route Workbench operations using the returned exact instanceId inside arguments. Do not replay a mutation whose response was lost.',
		inputSchema: fromJsonSchema({
			type: 'object',
			properties: {
				name: { type: 'string', pattern: '.*\\S.*', description: 'Exact operation name from list-tools.' },
				arguments: { type: 'object', description: 'Operation arguments; include instanceId for Workbench operations.' },
			},
			required: ['name', 'arguments'],
			additionalProperties: false,
		}),
	}, async (input, context) => {
		const values = asInput(input);
		return asMcpResult(await operations.execute(values.name as string, values.arguments, context.mcpReq.signal));
	});

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