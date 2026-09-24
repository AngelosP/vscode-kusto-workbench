import { createHash } from 'node:crypto';

export interface CanonicalWorkbenchToolContribution {
	readonly name: string;
	readonly toolReferenceName: string;
	readonly displayName?: string;
	readonly modelDescription: string;
	readonly userDescription?: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ExternalMcpToolDefinition {
	readonly name: string;
	readonly registeredName: string;
	readonly title?: string;
	readonly description: string;
	readonly summary: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ExternalMcpCatalog {
	readonly protocolVersion: 1;
	readonly schemaHash: string;
	readonly tools: readonly ExternalMcpToolDefinition[];
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

function routedSchema(schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
		? schema.properties as Readonly<Record<string, unknown>>
		: {};
	const required = Array.isArray(schema.required)
		? schema.required.filter((value): value is string => typeof value === 'string')
		: [];
	return {
		...schema,
		type: 'object',
		properties: {
			instanceId: {
				type: 'string',
				pattern: '.*\\S.*',
				description: 'Exact running Kusto Workbench instance ID from listWorkbenchInstances or launchWorkbenchInstance.',
			},
			...properties,
		},
		required: ['instanceId', ...required.filter(value => value !== 'instanceId')],
	};
}

export function createExternalMcpCatalog(
	contributions: readonly CanonicalWorkbenchToolContribution[],
): ExternalMcpCatalog {
	const names = new Set<string>();
	const registeredNames = new Set<string>();
	const tools = contributions.map(contribution => {
		if (!contribution.toolReferenceName || names.has(contribution.toolReferenceName)) {
			throw new Error(`External MCP tool reference name is missing or duplicated: ${contribution.toolReferenceName || contribution.name}`);
		}
		if (!contribution.name || registeredNames.has(contribution.name)) {
			throw new Error(`External MCP registered tool name is missing or duplicated: ${contribution.name}`);
		}
		names.add(contribution.toolReferenceName);
		registeredNames.add(contribution.name);
		return {
			name: contribution.toolReferenceName,
			registeredName: contribution.name,
			...(contribution.displayName ? { title: contribution.displayName } : {}),
			description: contribution.modelDescription,
			summary: contribution.userDescription || contribution.modelDescription,
			inputSchema: routedSchema(contribution.inputSchema),
		};
	});
	const hashSource = stableJson(tools.map(({ summary: _summary, ...tool }) => tool));
	return {
		protocolVersion: 1,
		schemaHash: createHash('sha256').update(hashSource).digest('hex'),
		tools,
	};
}

export function stripExternalMcpRouting(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
	const { instanceId: _instanceId, ...toolInput } = input as Record<string, unknown>;
	return toolInput;
}