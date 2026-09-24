import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/server';
import type { ExternalMcpCatalog } from '../shared/externalMcpCatalog';
import type { ConnectorToolResult } from './externalMcpConnectorCore';
import { ExternalMcpConnectorCore } from './externalMcpConnectorCore';

interface WorkbenchOperation {
	readonly name: string;
	readonly title: string;
	readonly summary: string;
	readonly description: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
	invoke(argumentsValue: Record<string, unknown>, signal?: AbortSignal): Promise<ConnectorToolResult>;
}

function textResult(value: unknown): ConnectorToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errorResult(message: string, inputSchema?: Readonly<Record<string, unknown>>): ConnectorToolResult {
	return {
		isError: true,
		content: [{ type: 'text', text: `Error: ${message}${inputSchema ? `\nInput schema: ${JSON.stringify(inputSchema)}` : ''}` }],
	};
}

export function createExternalMcpOperations(catalog: ExternalMcpCatalog, core: ExternalMcpConnectorCore, guidance: string) {
	const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
	const operations: WorkbenchOperation[] = [
		{
			name: 'listWorkbenchInstances', title: 'List Kusto Workbench Instances',
			summary: 'List eligible running Workbench windows and their exact instance IDs.',
			description: 'Lists eligible running Kusto Workbench VS Code instances. Results never include discovery endpoints or credentials.',
			inputSchema: emptySchema,
			invoke: (_argumentsValue, signal) => core.listInstances(signal),
		},
		{
			name: 'checkWorkbenchInstance', title: 'Check Kusto Workbench Instance',
			summary: 'Check that an exact Workbench instance is still running and compatible.',
			description: 'Checks that one exact Kusto Workbench instance is still running and compatible.',
			inputSchema: {
				type: 'object',
				properties: { instanceId: { type: 'string', pattern: '.*\\S.*' } },
				required: ['instanceId'], additionalProperties: false,
			},
			invoke: (args, signal) => core.checkInstance(args.instanceId as string, signal),
		},
		{
			name: 'launchWorkbenchInstance', title: 'Launch Kusto Workbench Instance',
			summary: 'Launch a VS Code window for an existing local workspace folder.',
			description: 'Launches a new VS Code window for an existing local workspace folder and waits for its Kusto Workbench provider to become ready.',
			inputSchema: {
				type: 'object', properties: {
					workspaceFolder: { type: 'string', pattern: '.*\\S.*' },
					timeoutMs: { type: 'integer', minimum: 1000, maximum: 180000 },
				},
				required: ['workspaceFolder'], additionalProperties: false,
			},
			invoke: (args, signal) => core.launchInstance({
				workspaceFolder: args.workspaceFolder as string,
				...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs as number } : {}),
			}, signal),
		},
		{
			name: 'getWorkbenchGuidance', title: 'Get Kusto Workbench Guidance',
			summary: 'Get the current external Workbench workflow and safety guidance.',
			description: 'Returns the portable Kusto Workbench tool workflow and safety guidance.',
			inputSchema: emptySchema,
			invoke: async () => ({ content: [{ type: 'text', text: guidance }] }),
		},
		...catalog.tools.map(tool => ({
			name: tool.name,
			title: tool.title ?? tool.name,
			summary: tool.summary,
			description: tool.description,
			inputSchema: tool.inputSchema,
			invoke: (args: Record<string, unknown>, signal?: AbortSignal) => core.invokeWorkbenchTool(tool.name, args, signal),
		})),
	];
	const validator = new AjvJsonSchemaValidator();
	const byName = new Map(operations.map(operation => [operation.name, {
		operation,
		validate: validator.getValidator<Record<string, unknown>>(operation.inputSchema as JsonSchemaType),
	}]));
	if (byName.size !== operations.length) throw new Error('External MCP operation names must be unique.');

	return {
		list(name?: string, query?: string): ConnectorToolResult {
			if (name !== undefined) {
				const operation = byName.get(name)?.operation;
				return operation
					? textResult({ schemaHash: catalog.schemaHash, name: operation.name, title: operation.title,
						description: operation.description, inputSchema: operation.inputSchema })
					: errorResult(`Unknown Kusto Workbench operation: ${name}. Call list-tools to find an operation.`);
			}
			const search = query?.trim().toLowerCase();
			return textResult({
				schemaHash: catalog.schemaHash,
				operations: operations.filter(operation => !search
					|| `${operation.name} ${operation.title} ${operation.summary}`.toLowerCase().includes(search))
					.map(operation => ({ name: operation.name, title: operation.title, summary: operation.summary })),
			});
		},
		async execute(name: string, argumentsValue: unknown, signal?: AbortSignal): Promise<ConnectorToolResult> {
			const entry = byName.get(name);
			if (!entry) return errorResult(`Unknown Kusto Workbench operation: ${name}. Call list-tools to find an operation.`);
			const validated = entry.validate(argumentsValue);
			if (!validated.valid) {
				return errorResult(`Invalid arguments for ${name}: ${validated.errorMessage}`, entry.operation.inputSchema);
			}
			return entry.operation.invoke(validated.data, signal);
		},
	};
}