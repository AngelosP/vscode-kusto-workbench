import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
	buildWorkbenchMcpToolDefinitions,
	createWorkbenchToolTokenizationOptions,
} from '../../../src/host/workbenchMcpToolAdapter';

describe('Workbench MCP tool adapter', () => {
	it('derives the exact provider catalog from canonical contributions and live registrations', () => {
		const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
		const contributions = manifest.contributes.languageModelTools;
		const registered = contributions.map((tool: { name: string; modelDescription: string; inputSchema: object }) => ({
			name: tool.name,
			description: tool.modelDescription,
			inputSchema: tool.inputSchema,
		}));

		const definitions = buildWorkbenchMcpToolDefinitions(contributions, registered);

		expect(definitions).toHaveLength(contributions.length);
		expect(definitions.map(tool => tool.name)).toEqual(contributions.map((tool: { toolReferenceName: string }) => tool.toolReferenceName));
		expect(definitions.map(tool => tool.registeredName)).toEqual(contributions.map((tool: { name: string }) => tool.name));
		expect(() => buildWorkbenchMcpToolDefinitions(contributions, registered.slice(1)))
			.toThrow(`Workbench tool is not registered: ${contributions[0].name}`);
	});

	it('uses the matching model budget for schema tools only', async () => {
		const countTokens = async (text: string) => text.length;
		const selectModels = vi.fn(async (selector: { family?: string }) => selector.family === 'gpt-5.6-sol'
			? [{ maxInputTokens: 100_000, countTokens }]
			: []);
		const cancellation = { isCancellationRequested: false } as never;

		expect(await createWorkbenchToolTokenizationOptions(
			'kusto-workbench_list-sections', 'gpt-5.6-sol', cancellation, selectModels,
		)).toBeUndefined();
		expect(selectModels).not.toHaveBeenCalled();
		const options = await createWorkbenchToolTokenizationOptions(
			'kusto-workbench_get-schema', 'gpt-5.6-sol', cancellation, selectModels,
		);
		expect(options?.tokenBudget).toBe(40_000);
		expect(await options?.countTokens('abcd')).toBe(4);
	});

	it('uses bounded estimation when model discovery is unavailable', async () => {
		const options = await createWorkbenchToolTokenizationOptions(
			'kusto-workbench_get-schema',
			undefined,
			{ isCancellationRequested: false } as never,
			async () => [],
		);
		expect(options?.tokenBudget).toBe(8_192);
		expect(await options?.countTokens('x'.repeat(40))).toBe(10);
	});
});