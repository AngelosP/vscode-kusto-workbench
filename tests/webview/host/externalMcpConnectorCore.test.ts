import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExternalMcpCatalog } from '../../../src/shared/externalMcpCatalog';
import {
	ExternalMcpConnectorCore,
	type ConnectorToolResult,
	type WorkbenchProviderDescriptor,
} from '../../../src/connector/externalMcpConnectorCore';
import { launchVsCodeWorkbench } from '../../../src/connector/externalMcpConnectorNode';

const catalog = createExternalMcpCatalog([{
	name: 'kusto-workbench_list-sections',
	toolReferenceName: 'listSections',
	displayName: 'List Sections',
	modelDescription: 'List sections.',
	inputSchema: { type: 'object', properties: {} },
}]);

function provider(overrides: Partial<WorkbenchProviderDescriptor> = {}): WorkbenchProviderDescriptor {
	return {
		protocolVersion: 1,
		instanceId: 'instance-a',
		displayName: 'Workspace A',
		extensionVersion: '5.2.0',
		schemaHash: catalog.schemaHash,
		processId: 123,
		startedAt: '2026-09-17T00:00:00.000Z',
		workspaceFolders: ['C:\\work-a'],
		endpoint: 'http://127.0.0.1:43210/mcp',
		token: 'secret-a',
		...overrides,
	};
}

function dependencies(providers: WorkbenchProviderDescriptor[]) {
	const cleanupLaunch = vi.fn(async () => {});
	return {
		discoverProviders: vi.fn(async () => providers),
		invokeProvider: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'forwarded' }] })),
		launchWorkbench: vi.fn(async () => ({ cleanup: cleanupLaunch })),
		cleanupLaunch,
		sleep: vi.fn(async () => {}),
		createId: vi.fn(() => 'launch-1'),
	};
}

describe('ExternalMcpConnectorCore', () => {
	it('lists sanitized compatible instances without discovery credentials', async () => {
		const deps = dependencies([provider(), provider({ instanceId: 'instance-b', token: 'secret-b' })]);
		const core = new ExternalMcpConnectorCore(catalog, deps);

		const result = await core.listInstances();

		const text = result.content[0].text;
		expect(text).toContain('instance-a');
		expect(text).toContain('instance-b');
		expect(text).not.toContain('secret-a');
		expect(text).not.toContain('secret-b');
		expect(text).not.toContain('43210');
	});

	it('routes only to the explicitly selected instance and strips connector fields', async () => {
		const target = provider({ instanceId: 'instance-b', token: 'secret-b' });
		const deps = dependencies([provider(), target]);
		const core = new ExternalMcpConnectorCore(catalog, deps);

		const result = await core.invokeWorkbenchTool('listSections', {
			instanceId: 'instance-b',
			openFileId: 'file-1',
		});

		expect(result.content[0].text).toBe('forwarded');
		expect(deps.invokeProvider).toHaveBeenCalledWith(
			target,
			'listSections',
			{ openFileId: 'file-1' },
			undefined,
		);
	});

	it('rejects unknown and incompatible instances without redirecting', async () => {
		const incompatible = provider({ instanceId: 'instance-old', schemaHash: '0'.repeat(64) });
		const deps = dependencies([provider(), incompatible]);
		const core = new ExternalMcpConnectorCore(catalog, deps);

		await expect(core.checkInstance('missing')).rejects.toThrow('Unknown or stale');
		await expect(core.checkInstance('instance-old')).rejects.toThrow('incompatible tool catalog');
		expect(deps.invokeProvider).not.toHaveBeenCalled();
	});

	it('retries a transient exact-instance discovery gap before invocation', async () => {
		const target = provider();
		const deps = dependencies([]);
		deps.discoverProviders.mockResolvedValueOnce([]).mockResolvedValue([target]);
		const core = new ExternalMcpConnectorCore(catalog, deps);

		const result = await core.invokeWorkbenchTool('listSections', { instanceId: target.instanceId });

		expect(result.content[0].text).toBe('forwarded');
		expect(deps.discoverProviders).toHaveBeenCalledTimes(2);
		expect(deps.invokeProvider).toHaveBeenCalledOnce();
	});

	it('correlates a launched window by launch request instead of selecting another instance', async () => {
		const deps = dependencies([provider()]);
		deps.discoverProviders
			.mockResolvedValueOnce([provider()])
			.mockResolvedValue([provider({ instanceId: 'instance-new', launchRequestId: 'launch-1' })]);
		const core = new ExternalMcpConnectorCore(catalog, deps);

		const result = await core.launchInstance({ workspaceFolder: 'C:\\reports' });

		expect(deps.launchWorkbench).toHaveBeenCalledWith({ workspaceFolder: 'C:\\reports', launchRequestId: 'launch-1' });
		expect(deps.cleanupLaunch).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain('instance-new');
		expect(result.content[0].text).not.toContain('secret-a');
	});

	it('removes launch correlation state when launch polling is cancelled', async () => {
		const deps = dependencies([provider()]);
		const cancellation = new AbortController();
		deps.sleep.mockImplementation(async () => { cancellation.abort(new Error('cancelled by client')); });
		const core = new ExternalMcpConnectorCore(catalog, deps);

		await expect(core.launchInstance({ workspaceFolder: 'C:\\reports' }, cancellation.signal))
			.rejects.toThrow('cancelled by client');
		expect(deps.cleanupLaunch).toHaveBeenCalledOnce();
	});

	it('reports a timed-out detached launch as ambiguous before retry', async () => {
		const deps = dependencies([]);
		const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(1_001);
		const core = new ExternalMcpConnectorCore(catalog, deps);
		try {
			const result = await core.launchInstance({ workspaceFolder: 'C:\\reports', timeoutMs: 1_000 });

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain('may still become ready');
			expect(result.content[0].text).toContain('Call listWorkbenchInstances');
			expect(result.content[0].text).toContain('before retrying launchWorkbenchInstance');
			expect(deps.cleanupLaunch).toHaveBeenCalledOnce();
			expect(deps.cleanupLaunch).toHaveBeenCalledWith({ preserveForLateLaunch: true });
		} finally {
			now.mockRestore();
		}
	});

	it('retains timeout ambiguity guidance when launch correlation cleanup fails', async () => {
		const deps = dependencies([]);
		deps.cleanupLaunch.mockRejectedValue(new Error('cleanup denied'));
		const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(1_001);
		const core = new ExternalMcpConnectorCore(catalog, deps);
		try {
			const result = await core.launchInstance({ workspaceFolder: 'C:\\reports', timeoutMs: 1_000 });

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain('may still become ready');
			expect(result.content[0].text).toContain('before retrying launchWorkbenchInstance');
			expect(result.content[0].text).toContain('cleanup denied');
		} finally {
			now.mockRestore();
		}
	});

	it('never retries an ambiguous Workbench mutation', async () => {
		const deps = dependencies([provider()]);
		deps.invokeProvider.mockRejectedValue(new Error('connection closed'));
		const core = new ExternalMcpConnectorCore(catalog, deps);

		const result = await core.invokeWorkbenchTool('listSections', { instanceId: 'instance-a' });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('may already have completed');
		expect(deps.invokeProvider).toHaveBeenCalledOnce();
	});

	it('rediscovers a restarted provider endpoint without changing the instance handle', async () => {
		const before = provider({ endpoint: 'http://127.0.0.1:41000/mcp', token: 'before-secret' });
		const after = provider({ endpoint: 'http://127.0.0.1:42000/mcp', token: 'after-secret' });
		const deps = dependencies([before]);
		deps.discoverProviders.mockResolvedValueOnce([before]).mockResolvedValue([after]);
		const core = new ExternalMcpConnectorCore(catalog, deps);

		await core.invokeWorkbenchTool('listSections', { instanceId: 'instance-a' });
		await core.invokeWorkbenchTool('listSections', { instanceId: 'instance-a' });

		expect(deps.invokeProvider.mock.calls[0][0]).toBe(before);
		expect(deps.invokeProvider.mock.calls[1][0]).toBe(after);
	});

	it('keeps overlapping work and cancellation isolated across explicit instances', async () => {
		const first = provider({ instanceId: 'instance-a' });
		const second = provider({ instanceId: 'instance-b', endpoint: 'http://127.0.0.1:43211/mcp', token: 'secret-b' });
		const deps = dependencies([first, second]);
		const releaseSecond = deferred<ConnectorToolResult>();
		deps.invokeProvider.mockImplementation(async (target, _name, _input, signal) => {
			if (target.instanceId === 'instance-b') return releaseSecond.promise;
			return new Promise((_resolve, reject) => {
				signal?.addEventListener('abort', () => reject(new Error('first cancelled')), { once: true });
			});
		});
		const core = new ExternalMcpConnectorCore(catalog, deps);
		const firstCancellation = new AbortController();

		const firstCall = core.invokeWorkbenchTool('listSections', { instanceId: 'instance-a' }, firstCancellation.signal);
		const secondCall = core.invokeWorkbenchTool('listSections', { instanceId: 'instance-b' });
		await vi.waitFor(() => expect(deps.invokeProvider).toHaveBeenCalledTimes(2));
		firstCancellation.abort();
		releaseSecond.resolve({ content: [{ type: 'text', text: 'second completed' }] });

		expect((await firstCall).isError).toBe(true);
		expect((await secondCall).content[0].text).toBe('second completed');
	});

	it('rejects a stopped instance while another instance continues', async () => {
		const first = provider({ instanceId: 'instance-a' });
		const second = provider({ instanceId: 'instance-b', endpoint: 'http://127.0.0.1:43211/mcp', token: 'secret-b' });
		const deps = dependencies([first, second]);
		const core = new ExternalMcpConnectorCore(catalog, deps);
		deps.discoverProviders.mockResolvedValue([second]);

		await expect(core.checkInstance('instance-a')).rejects.toThrow('Unknown or stale');
		expect((await core.invokeWorkbenchTool('listSections', { instanceId: 'instance-b' })).content[0].text)
			.toBe('forwarded');
	});

	it('removes launch correlation state when the VS Code process exits unsuccessfully', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-launch-failure-'));
		const workspaceFolder = join(root, 'workspace');
		const launchDirectory = join(root, 'launches');
		mkdirSync(workspaceFolder);
		try {
			await expect(launchVsCodeWorkbench({
				schemaVersion: 1,
				connectorVersion: '5.2.0',
				toolManifestPath: join(root, 'tools.json'),
				guidancePath: join(root, 'guidance.md'),
				discoveryDirectory: join(root, 'discovery'),
				launchDirectory,
				codeExecutable: process.execPath,
				codeArguments: ['-e', 'process.exit(7)', '--'],
			}, { workspaceFolder, launchRequestId: 'failed-launch' }))
				.rejects.toThrow('exited with code 7');
			expect(existsSync(join(launchDirectory, 'failed-launch.code-workspace'))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('preserves ambiguous launch correlation state for delayed startup until explicit cleanup', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-launch-ambiguous-'));
		const workspaceFolder = join(root, 'workspace');
		const launchDirectory = join(root, 'launches');
		mkdirSync(workspaceFolder);
		try {
			const launch = await launchVsCodeWorkbench({
				schemaVersion: 1,
				connectorVersion: '5.2.0',
				toolManifestPath: join(root, 'tools.json'),
				guidancePath: join(root, 'guidance.md'),
				discoveryDirectory: join(root, 'discovery'),
				launchDirectory,
				codeExecutable: process.execPath,
				codeArguments: ['-e', 'process.exit(0)', '--'],
			}, { workspaceFolder, launchRequestId: 'ambiguous-launch' });
			const workspacePath = join(launchDirectory, 'ambiguous-launch.code-workspace');

			await launch.cleanup({ preserveForLateLaunch: true });
			expect(existsSync(workspacePath)).toBe(true);
			await launch.cleanup();
			expect(existsSync(workspacePath)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		'\\\\server\\share\\workspace',
		'\\\\?\\C:\\workspace',
		'\\\\.\\C:\\workspace',
		'//server/share/workspace',
		'//?/C:/workspace',
		'//./C:/workspace',
	])('rejects non-local workspace path %s before filesystem access', async workspaceFolder => {
		await expect(launchVsCodeWorkbench({
			schemaVersion: 1,
			connectorVersion: '5.2.0',
			toolManifestPath: 'C:\\tools.json',
			guidancePath: 'C:\\guidance.md',
			discoveryDirectory: 'C:\\discovery',
			launchDirectory: 'C:\\launches',
			codeExecutable: process.execPath,
		}, { workspaceFolder, launchRequestId: 'remote-launch' }))
			.rejects.toThrow('UNC and device paths are not supported');
	});
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}