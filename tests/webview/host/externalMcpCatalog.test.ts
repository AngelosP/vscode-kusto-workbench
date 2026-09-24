import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	createExternalMcpCatalog,
	stripExternalMcpRouting,
} from '../../../src/shared/externalMcpCatalog';

describe('external MCP catalog', () => {
	it('mechanically wraps every canonical Workbench tool with explicit instance routing', () => {
		const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
		const contributions = manifest.contributes.languageModelTools;

		const first = createExternalMcpCatalog(contributions);
		const second = createExternalMcpCatalog(contributions);

		expect(first.protocolVersion).toBe(1);
		expect(first.schemaHash).toMatch(/^[a-f0-9]{64}$/);
		expect(second.schemaHash).toBe(first.schemaHash);
		expect(first.tools).toHaveLength(contributions.length);
		expect(first.tools.map(tool => tool.name)).toEqual(contributions.map((tool: { toolReferenceName: string }) => tool.toolReferenceName));
		expect(first.tools.map(tool => tool.registeredName)).toEqual(contributions.map((tool: { name: string }) => tool.name));
		for (const [index, tool] of first.tools.entries()) {
			const original = contributions[index].inputSchema;
			expect(tool.inputSchema.properties.instanceId).toMatchObject({ type: 'string' });
			expect(tool.inputSchema.required).toContain('instanceId');
			for (const required of original.required || []) expect(tool.inputSchema.required).toContain(required);
			expect(tool.inputSchema.anyOf).toEqual(original.anyOf);
		}
	});

	it('removes only connector routing before forwarding canonical tool input', () => {
		expect(stripExternalMcpRouting({ instanceId: 'instance-a', sectionId: 'query_1', execute: true }))
			.toEqual({ sectionId: 'query_1', execute: true });
	});

	it('keeps advisory summaries out of the connector/provider compatibility hash', () => {
		const contribution = {
			name: 'kusto-workbench_list-sections',
			toolReferenceName: 'listSections',
			modelDescription: 'Lists open sections.',
			inputSchema: { type: 'object', properties: {} },
		};
		const original = createExternalMcpCatalog([contribution]);
		const revised = createExternalMcpCatalog([{ ...contribution, userDescription: 'Find sections in an open report.' }]);

		expect(revised.tools[0].summary).toBe('Find sections in an open report.');
		expect(revised.schemaHash).toBe(original.schemaHash);
	});

	it('rejects duplicated public names', () => {
		const contribution = {
			name: 'registered',
			toolReferenceName: 'publicName',
			modelDescription: 'Description',
			inputSchema: { type: 'object', properties: {} },
		};
		expect(() => createExternalMcpCatalog([contribution, { ...contribution, name: 'other' }]))
			.toThrow('missing or duplicated');
	});
});