import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { workspace } from 'vscode';
import {
	buildWorkbenchMcpToolDefinitions,
	chooseWorkingDirectory,
	createCopilotCliMcpConfig,
	createWorkbenchToolTokenizationOptions,
	isCopilotCliVersionSupported,
	publishCopilotCliLaunchAssets,
	renderCopilotCliAgents,
} from '../../../src/host/copilotCliIntegration';
import { formatSchemaCollectionJsonWithTokenBudget } from '../../../src/host/kustoWorkbenchTools';
import { formatSchemaWithTokenBudget } from '../../../src/host/schemaIndexUtils';

function workspaceFile(path: string): string {
	return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function bodyOf(markdown: string): string {
	const closing = markdown.indexOf('\n---', 4);
	return markdown.slice(closing + 4).trimStart();
}

describe('Copilot CLI integration projections', () => {
	it('derives the exact public MCP catalog from the Workbench manifest and live registrations', () => {
		const manifest = JSON.parse(workspaceFile('package.json'));
		const contributions = manifest.contributes.languageModelTools;
		const registered = contributions.map((tool: { name: string; modelDescription: string; inputSchema: object }) => ({
			name: tool.name,
			description: tool.modelDescription,
			inputSchema: tool.inputSchema,
		}));

		const definitions = buildWorkbenchMcpToolDefinitions(contributions, registered);

		expect(definitions).toHaveLength(26);
		expect(definitions.map(tool => tool.name)).toEqual(contributions.map((tool: { toolReferenceName: string }) => tool.toolReferenceName));
		expect(definitions.map(tool => tool.registeredName)).toEqual(contributions.map((tool: { name: string }) => tool.name));
		expect(definitions[0]?.inputSchema).toBe(contributions[0].inputSchema);
		expect(() => buildWorkbenchMcpToolDefinitions(contributions, registered.slice(1)))
			.toThrow(`Workbench tool is not registered: ${contributions[0].name}`);
		expect(() => buildWorkbenchMcpToolDefinitions(contributions, [
			{ ...registered[0], description: 'drifted' },
			...registered.slice(1),
		])).toThrow(`Workbench tool metadata does not match its live registration: ${contributions[0].name}`);
	});

	it('creates an ephemeral, non-filtering session config for the exact endpoint and tools', () => {
		const config = createCopilotCliMcpConfig({
			serverName: 'kusto-workbench-a1b2c3d4',
			endpoint: 'http://127.0.0.1:43210/mcp',
			toolNames: ['listSections', 'configureChart'],
			token: 'actual-secret',
		});
		const serialized = JSON.stringify(config);

		expect(config).toEqual({
			mcpServers: {
				'kusto-workbench-a1b2c3d4': {
					type: 'http',
					url: 'http://127.0.0.1:43210/mcp',
					headers: { Authorization: 'Bearer actual-secret' },
					tools: ['listSections', 'configureChart'],
					timeout: 7_500_000,
					deferTools: 'never',
					disableToolCache: true,
					filterMapping: 'none',
				},
			},
		});
		expect(serialized).toContain('actual-secret');
	});

	it('renders CLI agents from the same VS Code role bodies with only host bindings changed', () => {
		const mainSource = workspaceFile('copilot-instructions/custom-agent.md');
		const searchSource = workspaceFile('copilot-instructions/custom-subagent-search.md');
		const rendered = renderCopilotCliAgents({
			mainSource,
			searchSource,
			serverName: 'kusto-workbench-a1b2c3d4',
			allToolNames: ['listSections', 'askKustoCopilot', 'configureChart'],
		});

		expect(rendered.main).toContain('name: Kusto Workbench');
		expect(rendered.main).toContain('kusto-workbench-a1b2c3d4/listSections');
		expect(rendered.main).toContain('kusto-workbench-a1b2c3d4/configureChart');
		expect(rendered.search).toContain('name: Kusto Workbench Search');
		expect(rendered.search).toContain('kusto-workbench-a1b2c3d4/askKustoCopilot');
		expect(rendered.main).toContain('Spawn `kusto-workbench-search-cli` sub-agents through `#task`');
		expect(rendered.main).not.toContain('``kusto-workbench-search-cli``');
		expect(bodyOf(rendered.main).replaceAll('#task', '#runSubagent').replaceAll('`kusto-workbench-search-cli`', '`Kusto Workbench Search`'))
			.toBe(bodyOf(mainSource));
		expect(bodyOf(rendered.search)).toBe(bodyOf(searchSource));
		expect(rendered.main).toContain('model: gpt-5.6-sol');
		expect(rendered.main).not.toContain('gpt-5.6-sol@1.0');
		expect(rendered.search).toContain('model: gpt-5.6-sol');
	});

	it('uses the matching Copilot model budget for schema output only', async () => {
		const countTokens = async (text: string) => text.length;
		const selectModels = vi.fn(async (selector: { family?: string }) => selector.family === 'gpt-5.6-sol'
			? [{ maxInputTokens: 100_000, countTokens }]
			: []);
		const cancellation = { isCancellationRequested: false } as never;

		expect(await createWorkbenchToolTokenizationOptions(
			'kusto-workbench_list-sections',
			'gpt-5.6-sol',
			cancellation,
			selectModels,
		)).toBeUndefined();
		expect(selectModels).not.toHaveBeenCalled();

		const options = await createWorkbenchToolTokenizationOptions(
			'kusto-workbench_get-schema',
			'gpt-5.6-sol',
			cancellation,
			selectModels,
		);
		expect(options?.tokenBudget).toBe(40_000);
		expect(await options?.countTokens('abcd')).toBe(4);
		expect(selectModels).toHaveBeenCalledWith({ vendor: 'copilot', family: 'gpt-5.6-sol' });
		expect(await createWorkbenchToolTokenizationOptions(
			'kusto-workbench_refresh-schema',
			'gpt-5.6-sol',
			cancellation,
			selectModels,
		)).toMatchObject({ tokenBudget: 40_000 });
	});

	it('keeps schema output bounded when no Copilot tokenizer is available', async () => {
		const options = await createWorkbenchToolTokenizationOptions(
			'kusto-workbench_get-schema',
			undefined,
			{ isCancellationRequested: false } as never,
			async () => [],
		);

		expect(options?.tokenBudget).toBe(8_192);
		expect(await options?.countTokens('x'.repeat(40))).toBe(10);
		const tables = Array.from({ length: 500 }, (_, index) => `TelemetryTable${index}`);
		const schema = {
			tables,
			columnTypesByTable: Object.fromEntries(tables.map(table => [table, Object.fromEntries(
				Array.from({ length: 20 }, (_, index) => [`VerboseColumn${index}`, 'string']),
			)])),
			functions: [],
		};
		const bounded = await formatSchemaWithTokenBudget(
			'Db',
			schema,
			undefined,
			options!.tokenBudget,
			text => options!.countTokens(text),
		);
		expect(bounded.phase).toBeGreaterThan(0);
		expect(bounded.tokenCount).toBeLessThanOrEqual(options!.tokenBudget);
		expect(await options!.countTokens(bounded.text)).toBe(bounded.tokenCount);
	});

	it('falls back to bounded estimation when model discovery or token counting fails', async () => {
		const cancellation = { isCancellationRequested: false } as never;
		const discoveryFallback = await createWorkbenchToolTokenizationOptions(
			'kusto-workbench_get-schema',
			'gpt-5.6-sol',
			cancellation,
			async () => { throw new Error('models unavailable'); },
		);
		expect(discoveryFallback?.tokenBudget).toBe(8_192);
		expect(await discoveryFallback?.countTokens('x'.repeat(20))).toBe(5);

		const tokenizerFallback = await createWorkbenchToolTokenizationOptions(
			'kusto-workbench_get-schema',
			'gpt-5.6-sol',
			cancellation,
			async () => [{
				maxInputTokens: 100_000,
				countTokens: async () => { throw new Error('tokenizer unavailable'); },
			}],
		);
		expect(tokenizerFallback?.tokenBudget).toBe(40_000);
		expect(await tokenizerFallback?.countTokens('x'.repeat(20))).toBe(5);
	});

	it('does not publish credentials and cleans the session root when agent publication fails', async () => {
		const writeCredential = vi.fn(async () => {});
		const cleanup = vi.fn(async () => {});

		await expect(publishCopilotCliLaunchAssets({
			writeAgents: async () => { throw new Error('agent write failed'); },
			writeCredential,
			cleanup,
		})).rejects.toThrow('agent write failed');
		expect(writeCredential).not.toHaveBeenCalled();
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it('cleans the whole session root when exclusive credential publication fails', async () => {
		const steps: string[] = [];

		await expect(publishCopilotCliLaunchAssets({
			writeAgents: async () => { steps.push('agents'); },
			writeCredential: async () => {
				steps.push('credential');
				throw new Error('credential write failed');
			},
			cleanup: async () => { steps.push('cleanup'); },
		})).rejects.toThrow('credential write failed');
		expect(steps).toEqual(['agents', 'credential', 'cleanup']);
	});

	it('accepts stable supported CLI formats and rejects old or prerelease versions', () => {
		expect(isCopilotCliVersionSupported('GitHub Copilot CLI 1.0.81-6.')).toBe(true);
		expect(isCopilotCliVersionSupported('copilot v1.0.81')).toBe(true);
		expect(isCopilotCliVersionSupported('2.0.0')).toBe(true);
		expect(isCopilotCliVersionSupported('GitHub Copilot CLI 1.0.80')).toBe(false);
		expect(isCopilotCliVersionSupported('GitHub Copilot CLI 1.0.81-beta')).toBe(false);
	});

	it('refuses an empty VS Code window instead of using the user home directory', async () => {
		const previous = workspace.workspaceFolders;
		workspace.workspaceFolders = [];
		try {
			await expect(chooseWorkingDirectory(new AbortController().signal))
				.rejects.toThrow('Open a workspace folder');
		} finally {
			workspace.workspaceFolders = previous;
		}
	});

	it('returns token-bounded valid JSON for cluster-wide schema reads and refreshes', async () => {
		const schemas = Array.from({ length: 40 }, (_, databaseIndex) => ({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: `Database${databaseIndex}`,
			tables: Array.from({ length: 100 }, (_, tableIndex) => `Table${databaseIndex}_${tableIndex}`),
			functions: Array.from({ length: 40 }, (_, functionIndex) => `Function${databaseIndex}_${functionIndex}`),
		}));
		const tokenizationOptions = {
			tokenBudget: 400,
			countTokens: async (text: string) => text.length,
		};
		for (const collectionKey of ['databases', 'schemas'] as const) {
			const text = await formatSchemaCollectionJsonWithTokenBudget(
				{ [collectionKey]: schemas },
				collectionKey,
				tokenizationOptions,
				{ isCancellationRequested: false } as never,
			);
			const parsed = JSON.parse(text);
			expect(text.length).toBeLessThanOrEqual(tokenizationOptions.tokenBudget);
			expect(parsed.truncated).toBe(true);
			expect(parsed.totalDatabaseCount).toBe(40);
			expect(parsed.returnedDatabaseCount).toBeLessThan(40);
			expect(Array.isArray(parsed[collectionKey])).toBe(true);
		}
	});
});