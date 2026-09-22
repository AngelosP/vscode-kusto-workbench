import { describe, expect, it, vi } from 'vitest';
import {
	DefaultExternalMcpProviderIntegration,
	externalMcpRestartDelay,
} from '../../../src/host/externalMcpProviderIntegration';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
	return { promise, resolve };
}

function integration() {
	return new DefaultExternalMcpProviderIntegration({} as any, {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	});
}

describe('external MCP provider lifecycle', () => {
	it('uses capped exponential backoff for repeated runtime discovery failures', () => {
		expect([0, 1, 2, 3, 4, 5, 6, 7].map(externalMcpRestartDelay))
			.toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
	});
	it('closes a provider when stop supersedes an in-flight start', async () => {
		const managed = integration();
		const startGate = deferred<void>();
		const discovery = { close: vi.fn(async () => undefined) };
		const bridge = { close: vi.fn(async () => undefined) };
		vi.spyOn(managed as any, 'startCore').mockImplementation(async () => {
			await startGate.promise;
			(managed as any).discovery = discovery;
			(managed as any).bridge = bridge;
		});

		const starting = managed.start();
		await vi.waitFor(() => expect((managed as any).startCore).toHaveBeenCalledOnce());
		const stopping = managed.stop();
		startGate.resolve();
		await Promise.all([starting, stopping]);

		expect(managed.isRunning()).toBe(false);
		expect(discovery.close).toHaveBeenCalled();
		expect(bridge.close).toHaveBeenCalled();
	});

	it('clears a successfully closed bridge while retaining a failed discovery for retry', async () => {
		const managed = integration();
		const discovery = { close: vi.fn().mockRejectedValueOnce(new Error('discovery close failed')).mockResolvedValue(undefined) };
		const bridge = { close: vi.fn(async () => undefined) };
		(managed as any).discovery = discovery;
		(managed as any).bridge = bridge;

		await expect(managed.stop()).rejects.toThrow('External MCP provider shutdown failed');
		expect((managed as any).bridge).toBeUndefined();
		expect((managed as any).discovery).toBe(discovery);

		await expect(managed.stop()).resolves.toBeUndefined();
		expect((managed as any).discovery).toBeUndefined();
	});

	it('retries disposal until every retained resource closes', async () => {
		const managed = integration();
		const discovery = {
			close: vi.fn().mockRejectedValueOnce(new Error('transient discovery cleanup failure')).mockResolvedValue(undefined),
		};
		const bridge = { close: vi.fn(async () => undefined) };
		(managed as any).discovery = discovery;
		(managed as any).bridge = bridge;

		await expect(managed.dispose()).rejects.toThrow('External MCP provider shutdown failed');
		expect((managed as any).bridge).toBeUndefined();
		expect((managed as any).discovery).toBe(discovery);
		await expect(managed.dispose()).resolves.toBeUndefined();
		expect(discovery.close).toHaveBeenCalledTimes(2);
		expect((managed as any).discovery).toBeUndefined();
	});

	it('retries a retained provisional bridge after startup cleanup fails', async () => {
		const managed = integration();
		const bridge = {
			close: vi.fn().mockRejectedValueOnce(new Error('startup bridge cleanup failed')).mockResolvedValue(undefined),
		};
		(managed as any).bridge = bridge;
		(managed as any).ready = false;

		await expect(managed.stop()).rejects.toThrow('External MCP provider shutdown failed');
		expect((managed as any).bridge).toBe(bridge);
		await expect(managed.stop()).resolves.toBeUndefined();
		expect(bridge.close).toHaveBeenCalledTimes(2);
		expect((managed as any).bridge).toBeUndefined();
	});

	it('restarts discovery when workspace folders change while running', async () => {
		const managed = integration();
		const reconcile = vi.spyOn(managed as any, 'enqueueReconcile').mockResolvedValue(undefined);
		(managed as any).desiredRunning = true;

		(managed as any).handleWorkspaceFoldersChanged();

		expect((managed as any).restartRequested).toBe(true);
		expect(reconcile).toHaveBeenCalledOnce();
	});
});
