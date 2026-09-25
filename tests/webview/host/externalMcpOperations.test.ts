import { describe, expect, it, vi } from 'vitest';
import { createExternalMcpCatalog } from '../../../src/shared/externalMcpCatalog';
import { ExternalMcpConnectorCore, type WorkbenchProviderDescriptor } from '../../../src/connector/externalMcpConnectorCore';
import { createExternalMcpOperations } from '../../../src/connector/externalMcpOperations';

const catalog = createExternalMcpCatalog([{
	name: 'kusto-workbench_create-file',
	toolReferenceName: 'createKustoFile',
	displayName: 'Create Kusto File',
	modelDescription: 'Create a Kusto Workbench file at an exact local path.',
	userDescription: 'Create a new Kusto Workbench notebook.',
	inputSchema: {
		type: 'object',
		properties: {
			filePath: { type: 'string', pattern: '.*\\S.*' },
			fileType: { type: 'string', enum: ['kqlx', 'kql'] },
			openFileId: { type: 'string' },
			targetFileUri: { type: 'string' },
		},
		required: ['filePath', 'fileType'],
		anyOf: [{ required: ['openFileId'] }, { required: ['targetFileUri'] }],
		additionalProperties: false,
	},
}]);

function fixture() {
	const provider: WorkbenchProviderDescriptor = {
		protocolVersion: 1,
		instanceId: 'instance-a',
		displayName: 'Workspace',
		extensionVersion: '5.2.0',
		schemaHash: catalog.schemaHash,
		processId: 42,
		startedAt: '2026-09-24T00:00:00.000Z',
		workspaceFolders: ['C:/reports'],
		endpoint: 'http://127.0.0.1:43210/mcp',
		token: 'secret',
	};
	const dependencies = {
		discoverProviders: vi.fn(async () => [provider]),
		invokeProvider: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'forwarded' }] })),
		launchWorkbench: vi.fn(async () => ({ cleanup: async () => undefined })),
		sleep: vi.fn(async () => undefined),
		createId: vi.fn(() => 'launch-id'),
	};
	const operations = createExternalMcpOperations(catalog, new ExternalMcpConnectorCore(catalog, dependencies), 'Live guidance');
	return { provider, dependencies, operations };
}

describe('external MCP progressive operations', () => {
	it('discovers brief summaries and an exact canonical schema on demand', () => {
		const { operations } = fixture();
		const catalogResult = JSON.parse(operations.list().content[0].text);
		expect(catalogResult.schemaHash).toBe(catalog.schemaHash);
		expect(catalogResult.operations).toHaveLength(5);
		expect(catalogResult.operations.find((operation: { name: string }) => operation.name === 'createKustoFile'))
			.toMatchObject({ summary: 'Create a new Kusto Workbench notebook.' });
		expect(catalogResult.operations[0]).not.toHaveProperty('inputSchema');
		const filtered = JSON.parse(operations.list(undefined, 'notebook').content[0].text);
		expect(filtered.operations.map((operation: { name: string }) => operation.name)).toEqual(['createKustoFile']);
		const detailed = JSON.parse(operations.list('createKustoFile').content[0].text);
		expect(detailed.inputSchema).toMatchObject({ required: ['instanceId', 'filePath', 'fileType'] });
		expect(detailed.inputSchema.anyOf).toEqual([{ required: ['openFileId'] }, { required: ['targetFileUri'] }]);
		expect(operations.list('create-kusto-file').isError).toBe(true);
	});

	it('executes an exact operation without forwarding the routing identity', async () => {
		const { operations, dependencies, provider } = fixture();
		const args = { instanceId: 'instance-a', filePath: 'C:/reports/draft', fileType: 'kqlx', openFileId: 'file-a' };
		const result = await operations.execute('createKustoFile', args);
		expect(result.content[0].text).toBe('forwarded');
		expect(dependencies.invokeProvider).toHaveBeenCalledExactlyOnceWith(provider, 'createKustoFile', {
			filePath: args.filePath, fileType: args.fileType, openFileId: args.openFileId,
		}, undefined);
	});

	it.each([
		{ label: 'missing instance', args: { filePath: 'C:/reports/draft', fileType: 'kqlx', openFileId: 'file-a' } },
		{ label: 'missing file identity', args: { instanceId: 'instance-a', filePath: 'C:/reports/draft', fileType: 'kqlx' } },
		{ label: 'invalid kind', args: { instanceId: 'instance-a', filePath: 'C:/reports/draft', fileType: 'python', openFileId: 'file-a' } },
		{ label: 'extra field', args: { instanceId: 'instance-a', filePath: 'C:/reports/draft', fileType: 'kqlx', openFileId: 'file-a', unexpected: 1 } },
		{ label: 'blank path', args: { instanceId: 'instance-a', filePath: ' ', fileType: 'kqlx', openFileId: 'file-a' } },
		{ label: 'not an object', args: ['instance-a'] },
	])('rejects $label with the relevant schema before any provider effects', async ({ args }) => {
		const { operations, dependencies } = fixture();
		const result = await operations.execute('createKustoFile', args);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Input schema:');
		expect(result.content[0].text).toContain('filePath');
		expect(dependencies.discoverProviders).not.toHaveBeenCalled();
		expect(dependencies.invokeProvider).not.toHaveBeenCalled();
	});

	it('reports unknown operations without provider effects', async () => {
		const { operations, dependencies } = fixture();
		expect((await operations.execute('execute-tool', {})).content[0].text).toContain('Unknown Kusto Workbench operation');
		expect(dependencies.discoverProviders).not.toHaveBeenCalled();
	});

	it('supports bootstrap and instance discovery without an instance ID', async () => {
		const { operations, dependencies } = fixture();
		expect((await operations.execute('getWorkbenchGuidance', {})).content[0].text).toBe('Live guidance');
		const instances = await operations.execute('listWorkbenchInstances', {});
		expect(JSON.parse(instances.content[0].text).instances).toHaveLength(1);
		expect(instances.content[0].text).not.toContain('secret');
		expect(dependencies.invokeProvider).not.toHaveBeenCalled();
	});

	it('does not replay a mutation when the provider response is lost', async () => {
		const { operations, dependencies } = fixture();
		dependencies.invokeProvider.mockRejectedValueOnce(new Error('connection closed'));
		const result = await operations.execute('createKustoFile', {
			instanceId: 'instance-a', filePath: 'C:/reports/draft', fileType: 'kqlx', openFileId: 'file-a',
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('may already have completed');
		expect(dependencies.invokeProvider).toHaveBeenCalledOnce();
	});

	it('isolates 64 overlapping calls through lost responses, invalid arguments, and a stale provider', async () => {
		const { provider, dependencies, operations } = fixture();
		const otherProvider = { ...provider, instanceId: 'instance-b', endpoint: 'http://127.0.0.1:43211/mcp' };
		dependencies.discoverProviders.mockResolvedValue([provider, otherProvider]);
		dependencies.invokeProvider.mockImplementation(async (target, _name, input) => {
			if (target.instanceId === provider.instanceId) throw new Error('injected lost response');
			return { content: [{ type: 'text' as const, text: `ok:${input.filePath}` }] };
		});
		const requests = Array.from({ length: 64 }, (_, index) => ({
			instanceId: index % 2 === 0 ? provider.instanceId : otherProvider.instanceId,
			filePath: `C:/reports/stress-${index}`, fileType: 'kqlx', openFileId: `file-${index}`,
		}));
		const results = await Promise.all(requests.map(args => operations.execute('createKustoFile', args)));
		for (const [index, result] of results.entries()) {
			if (index % 2 === 0) {
				expect(result.isError).toBe(true);
				expect(result.content[0].text).toContain('may already have completed');
			} else {
				expect(result.isError).not.toBe(true);
				expect(result.content[0].text).toBe(`ok:${requests[index].filePath}`);
			}
		}
		expect(dependencies.invokeProvider).toHaveBeenCalledTimes(64);
		for (const request of requests) {
			const calls = dependencies.invokeProvider.mock.calls.filter(([, , input]) => input.filePath === request.filePath);
			expect(calls).toHaveLength(1);
			expect(calls[0][0].instanceId).toBe(request.instanceId);
		}

		const invalid = await Promise.all(requests.map(args =>
			operations.execute('createKustoFile', { ...args, fileType: 'unsupported' })));
		expect(invalid.every(result => result.isError && result.content[0].text.includes('Input schema:'))).toBe(true);
		expect(dependencies.discoverProviders).toHaveBeenCalledTimes(64);
		expect(dependencies.invokeProvider).toHaveBeenCalledTimes(64);

		dependencies.discoverProviders.mockResolvedValue([otherProvider]);
		await expect(operations.execute('createKustoFile', requests[0])).rejects.toThrow('Unknown or stale');
		expect((await operations.execute('createKustoFile', requests[1])).content[0].text)
			.toBe(`ok:${requests[1].filePath}`);
		dependencies.discoverProviders.mockResolvedValue([{ ...provider, schemaHash: '0'.repeat(64) }, otherProvider]);
		await expect(operations.execute('createKustoFile', requests[0])).rejects.toThrow('incompatible tool catalog');
		expect(dependencies.invokeProvider).toHaveBeenCalledTimes(65);
	});
});