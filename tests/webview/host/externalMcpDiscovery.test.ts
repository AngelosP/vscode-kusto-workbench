// @vitest-environment node

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	parseDiscoveryAnnouncement,
	parseWorkbenchProviderDescriptor,
	discoverProvidersFromDirectory,
	DiscoveryResponseReader,
	queryDiscoveryPipe,
} from '../../../src/connector/externalMcpConnectorNode';
import {
	EXTERNAL_MCP_DISCOVERY_HELPER_SCRIPT,
	startExternalMcpDiscovery,
} from '../../../src/host/externalMcpDiscovery';

describe.runIf(process.platform === 'win32')('external MCP discovery', () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	async function terminateParent(parent: ReturnType<typeof spawn>): Promise<void> {
		if (parent.exitCode !== null || parent.signalCode !== null) return;
		const closed = new Promise<void>((resolve, reject) => {
			parent.once('close', () => resolve());
			parent.once('error', reject);
		});
		parent.kill();
		await closed;
	}

	// Real startup and shutdown retain their separate 10s and 5s production deadlines.
	it('returns credentials only through a current-user pipe and cleans its public announcement', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-discovery-'));
		roots.push(root);
		const discoveryDirectory = join(root, 'announcements');
		const helperScriptPath = join(root, 'discovery-helper.ps1');
		writeFileSync(helperScriptPath, EXTERNAL_MCP_DISCOVERY_HELPER_SCRIPT, 'utf8');
		const powerShellExecutable = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
		const descriptor = {
			protocolVersion: 1 as const,
			instanceId: 'instance-a',
			displayName: 'Workspace A',
			extensionVersion: '5.2.0',
			schemaHash: 'a'.repeat(64),
			processId: process.pid,
			startedAt: '2026-09-17T00:00:00.000Z',
			workspaceFolders: ['C:\\workspace'],
			endpoint: 'http://127.0.0.1:43210/mcp',
			token: 'provider-secret',
		};
		const server = await startExternalMcpDiscovery({
			descriptor,
			discoveryDirectory,
			helperScriptPath,
			powerShellExecutable,
			logger: { error: vi.fn(), warn: vi.fn() },
		});
		try {
			const announcementText = readFileSync(server.announcementPath, 'utf8');
			expect(announcementText).toContain('instance-a');
			expect(announcementText).not.toContain(descriptor.token);
			expect(announcementText).not.toContain(descriptor.endpoint);
			const announcement = JSON.parse(announcementText);
			expect(await queryDiscoveryPipe(announcement)).toEqual(descriptor);
		} finally {
			await server.close();
		}
		expect(() => readFileSync(server.announcementPath, 'utf8')).toThrow();
	}, 30_000);

	it('rejects non-local pipe and provider endpoint announcements', () => {
		expect(() => parseDiscoveryAnnouncement({
			protocolVersion: 1,
			instanceId: 'instance-a',
			pipeName: '\\\\remote-host\\pipe\\kusto-workbench-9aa11f33-3778-46b8-aebb-39dd49b87940',
		})).toThrow('Invalid Kusto Workbench discovery announcement');
		expect(() => parseWorkbenchProviderDescriptor({
			protocolVersion: 1,
			instanceId: 'instance-a',
			displayName: 'Workspace A',
			extensionVersion: '5.2.0',
			schemaHash: 'a'.repeat(64),
			processId: process.pid,
			startedAt: '2026-09-17T00:00:00.000Z',
			workspaceFolders: ['C:\\workspace'],
			endpoint: 'http://example.test:43210/mcp',
			token: 'provider-secret',
		})).toThrow('IPv4 loopback');
	});

	it('decodes a non-ASCII descriptor split inside a UTF-8 sequence', () => {
		const line = `${JSON.stringify({ displayName: '分析資料', workspaceFolders: ['C:\\資料'] })}\n`;
		const bytes = Buffer.from(line, 'utf8');
		const multibyteStart = bytes.indexOf(Buffer.from('分', 'utf8'));
		const reader = new DiscoveryResponseReader();

		expect(reader.append(bytes.subarray(0, multibyteStart + 1))).toBeUndefined();
		expect(reader.append(bytes.subarray(multibyteStart + 1))).toBe(line.slice(0, -1));
	});

	it('coalesces concurrent discovery rounds while preserving both callers', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-discovery-single-flight-'));
		roots.push(root);
		const instanceId = 'instance-single-flight';
		writeFileSync(join(root, `${instanceId}.json`), JSON.stringify({
			protocolVersion: 1,
			instanceId,
			pipeName: '\\\\.\\pipe\\kusto-workbench-9aa11f33-3778-46b8-aebb-39dd49b87940',
		}));
		const provider = {
			protocolVersion: 1 as const,
			instanceId,
			displayName: 'Single flight',
			extensionVersion: '5.2.0',
			schemaHash: 'a'.repeat(64),
			processId: process.pid,
			startedAt: '2026-09-17T00:00:00.000Z',
			workspaceFolders: ['C:\\workspace'],
			endpoint: 'http://127.0.0.1:43210/mcp',
			token: 'provider-secret',
		};
		const query = vi.fn(async () => provider);

		const [first, second] = await Promise.all([
			discoverProvidersFromDirectory(root, undefined, query),
			discoverProvidersFromDirectory(root, undefined, query),
		]);

		expect(first).toEqual([provider]);
		expect(second).toEqual([provider]);
		expect(query).toHaveBeenCalledOnce();
	});

	it('retries a live announcement across the named-pipe rearm gap', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-discovery-rearm-'));
		roots.push(root);
		const instanceId = 'instance-rearm';
		writeFileSync(join(root, `${instanceId}.json`), JSON.stringify({
			protocolVersion: 1,
			instanceId,
			pipeName: '\\\\.\\pipe\\kusto-workbench-9aa11f33-3778-46b8-aebb-39dd49b87940',
		}));
		const provider = {
			protocolVersion: 1 as const,
			instanceId,
			displayName: 'Rearmed provider',
			extensionVersion: '5.2.0',
			schemaHash: 'a'.repeat(64),
			processId: process.pid,
			startedAt: '2026-09-17T00:00:00.000Z',
			workspaceFolders: ['C:\\workspace'],
			endpoint: 'http://127.0.0.1:43210/mcp',
			token: 'provider-secret',
		};
		const query = vi.fn()
			.mockRejectedValueOnce(new Error('pipe is rearming'))
			.mockResolvedValue(provider);

		expect(await discoverProvidersFromDirectory(root, undefined, query)).toEqual([provider]);
		expect(query).toHaveBeenCalledTimes(2);
	});

	it('removes its announcement when the parent process exits abruptly', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-discovery-parent-'));
		roots.push(root);
		const discoveryDirectory = join(root, 'announcements');
		const helperScriptPath = join(root, 'discovery-helper.ps1');
		writeFileSync(helperScriptPath, EXTERNAL_MCP_DISCOVERY_HELPER_SCRIPT, 'utf8');
		const powerShellExecutable = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
		const parent = spawn(powerShellExecutable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 60'], {
			windowsHide: true,
			stdio: 'ignore',
		});
		const unexpectedClose = vi.fn();
		const server = await startExternalMcpDiscovery({
			descriptor: {
				protocolVersion: 1,
				instanceId: 'instance-parent',
				displayName: 'Workspace Parent',
				extensionVersion: '5.2.0',
				schemaHash: 'a'.repeat(64),
				processId: process.pid,
				startedAt: '2026-09-17T00:00:00.000Z',
				workspaceFolders: ['C:\\workspace'],
				endpoint: 'http://127.0.0.1:43210/mcp',
				token: 'provider-secret',
			},
			discoveryDirectory,
			helperScriptPath,
			powerShellExecutable,
			parentProcessId: parent.pid!,
			logger: { error: vi.fn(), warn: vi.fn() },
			onUnexpectedClose: unexpectedClose,
		});
		await terminateParent(parent);
		await vi.waitFor(() => {
			expect(unexpectedClose).toHaveBeenCalledOnce();
			expect(existsSync(server.announcementPath)).toBe(false);
		}, { timeout: 15_000 });
		await server.close();
	}, 20_000);

	it('does not arm runtime recovery when the helper exits before publication', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-discovery-startup-failure-'));
		roots.push(root);
		const onUnexpectedClose = vi.fn();
		await expect(startExternalMcpDiscovery({
			descriptor: {
				protocolVersion: 1,
				instanceId: 'instance-startup-failure',
				displayName: 'Startup failure',
				extensionVersion: '5.2.0',
				schemaHash: 'a'.repeat(64),
				processId: process.pid,
				startedAt: '2026-09-17T00:00:00.000Z',
				workspaceFolders: ['C:\\workspace'],
				endpoint: 'http://127.0.0.1:43210/mcp',
				token: 'provider-secret',
			},
			discoveryDirectory: join(root, 'announcements'),
			helperScriptPath: join(root, 'missing-helper.ps1'),
			powerShellExecutable: process.execPath,
			logger: { error: vi.fn(), warn: vi.fn() },
			onUnexpectedClose,
		})).rejects.toThrow();
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(onUnexpectedClose).not.toHaveBeenCalled();
	});

	it('retains a provisional discovery owner when startup cleanup fails', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-discovery-provisional-retry-'));
		roots.push(root);
		let provisional: { close(): Promise<void> } | undefined;
		let cleanupSucceeded = false;
		let failCleanup = true;
		await expect(startExternalMcpDiscovery({
			descriptor: {
				protocolVersion: 1,
				instanceId: 'instance-provisional-retry',
				displayName: 'Provisional retry',
				extensionVersion: '5.2.0',
				schemaHash: 'a'.repeat(64),
				processId: process.pid,
				startedAt: '2026-09-17T00:00:00.000Z',
				workspaceFolders: ['C:\\workspace'],
				endpoint: 'http://127.0.0.1:43210/mcp',
				token: 'provider-secret',
			},
			discoveryDirectory: join(root, 'announcements'),
			helperScriptPath: join(root, 'missing-helper.ps1'),
			powerShellExecutable: process.execPath,
			logger: { error: vi.fn(), warn: vi.fn() },
			onProvisionalServer: server => { provisional = server; },
			onStartupCleanupSucceeded: () => { cleanupSucceeded = true; },
			removePath: async path => {
				if (failCleanup) {
					failCleanup = false;
					throw new Error('synthetic startup cleanup failure');
				}
				await rm(path, { force: true });
			},
		})).rejects.toThrow('startup and cleanup failed');
		expect(provisional).toBeDefined();
		expect(cleanupSucceeded).toBe(false);
		await expect(provisional!.close()).resolves.toBeUndefined();
	});

	it('retries shutdown cleanup after a transient announcement deletion failure', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-discovery-close-retry-'));
		roots.push(root);
		const helperScriptPath = join(root, 'discovery-helper.ps1');
		writeFileSync(helperScriptPath, EXTERNAL_MCP_DISCOVERY_HELPER_SCRIPT, 'utf8');
		let announcementPath = '';
		let failedOnce = false;
		const server = await startExternalMcpDiscovery({
			descriptor: {
				protocolVersion: 1,
				instanceId: 'instance-close-retry',
				displayName: 'Close retry',
				extensionVersion: '5.2.0',
				schemaHash: 'a'.repeat(64),
				processId: process.pid,
				startedAt: '2026-09-17T00:00:00.000Z',
				workspaceFolders: ['C:\\workspace'],
				endpoint: 'http://127.0.0.1:43210/mcp',
				token: 'provider-secret',
			},
			discoveryDirectory: join(root, 'announcements'),
			helperScriptPath,
			powerShellExecutable: join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
			logger: { error: vi.fn(), warn: vi.fn() },
			removePath: async path => {
				if (path === announcementPath && !failedOnce) {
					failedOnce = true;
					throw new Error('synthetic announcement deletion failure');
				}
				await rm(path, { force: true });
			},
		});
		announcementPath = server.announcementPath;

		await expect(server.close()).rejects.toThrow('shutdown failed');
		await expect(server.close()).resolves.toBeUndefined();
		expect(existsSync(server.announcementPath)).toBe(false);
	}, 15_000);

	it('observes an unexpected-exit announcement deletion failure and retries it on close', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-discovery-unexpected-cleanup-'));
		roots.push(root);
		const helperScriptPath = join(root, 'discovery-helper.ps1');
		writeFileSync(helperScriptPath, EXTERNAL_MCP_DISCOVERY_HELPER_SCRIPT, 'utf8');
		const parent = spawn(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
			'-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 60',
		], { windowsHide: true, stdio: 'ignore' });
		let announcementPath = '';
		let failedOnce = false;
		const logger = { error: vi.fn(), warn: vi.fn() };
		const unexpectedClose = vi.fn();
		const server = await startExternalMcpDiscovery({
			descriptor: {
				protocolVersion: 1,
				instanceId: 'instance-unexpected-cleanup',
				displayName: 'Unexpected cleanup',
				extensionVersion: '5.2.0',
				schemaHash: 'a'.repeat(64),
				processId: process.pid,
				startedAt: '2026-09-17T00:00:00.000Z',
				workspaceFolders: ['C:\\workspace'],
				endpoint: 'http://127.0.0.1:43210/mcp',
				token: 'provider-secret',
			},
			discoveryDirectory: join(root, 'announcements'),
			helperScriptPath,
			powerShellExecutable: join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
			parentProcessId: parent.pid!,
			logger,
			onUnexpectedClose: unexpectedClose,
			removePath: async path => {
				if (path === announcementPath && !failedOnce) {
					failedOnce = true;
					throw new Error('synthetic unexpected deletion failure');
				}
				await rm(path, { force: true });
			},
		});
		announcementPath = server.announcementPath;
		await terminateParent(parent);
		await vi.waitFor(() => {
			expect(unexpectedClose).toHaveBeenCalledOnce();
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('will be retried'));
		}, { timeout: 15_000 });
		await expect(server.close()).resolves.toBeUndefined();
		expect(existsSync(server.announcementPath)).toBe(false);
	}, 20_000);
});