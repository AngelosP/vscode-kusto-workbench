import { describe, expect, it, vi } from 'vitest';
import { ExternalMcpProviderStateCoordinator } from '../../../src/host/externalMcpProviderStateCoordinator';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
	return { promise, resolve };
}

function provider() {
	return {
		start: vi.fn(async () => undefined),
		stop: vi.fn(async () => undefined),
		dispose: vi.fn(async () => undefined),
	};
}

describe('external MCP provider state coordinator', () => {
	it('neutralizes a delayed provider load before a later disable resolves', async () => {
		const loading = deferred<ReturnType<typeof provider>>();
		const managed = provider();
		const coordinator = new ExternalMcpProviderStateCoordinator(() => loading.promise);

		const enabling = coordinator.setEnabled(true);
		await vi.waitFor(() => expect((coordinator as any).providerPromise).toBeDefined());
		let disableSettled = false;
		const disabling = coordinator.setEnabled(false).then(() => { disableSettled = true; });
		await Promise.resolve();
		expect(disableSettled).toBe(false);
		loading.resolve(managed);
		await Promise.all([enabling, disabling]);

		expect(managed.start).not.toHaveBeenCalled();
		expect(managed.stop).toHaveBeenCalled();
	});

	it('stops a provider when disable supersedes an in-flight start', async () => {
		const startGate = deferred<void>();
		const managed = provider();
		managed.start.mockImplementation(() => startGate.promise);
		const coordinator = new ExternalMcpProviderStateCoordinator(async () => managed);

		const enabling = coordinator.setEnabled(true);
		await vi.waitFor(() => expect(managed.start).toHaveBeenCalledOnce());
		const disabling = coordinator.setEnabled(false);
		startGate.resolve();
		await Promise.all([enabling, disabling]);

		expect(managed.stop).toHaveBeenCalled();
	});

	it('disposes a provider whose lazy load was already in flight', async () => {
		const loading = deferred<ReturnType<typeof provider>>();
		const managed = provider();
		const coordinator = new ExternalMcpProviderStateCoordinator(() => loading.promise);
		const enabling = coordinator.setEnabled(true);
		await vi.waitFor(() => expect((coordinator as any).providerPromise).toBeDefined());

		const disposal = coordinator.dispose();
		loading.resolve(managed);
		await Promise.all([enabling, disposal]);

		expect(managed.start).not.toHaveBeenCalled();
		expect(managed.dispose).toHaveBeenCalledOnce();
	});

	it('retries provider disposal after a transient cleanup failure', async () => {
		const managed = provider();
		managed.dispose
			.mockRejectedValueOnce(new Error('transient cleanup failure'))
			.mockResolvedValue(undefined);
		const coordinator = new ExternalMcpProviderStateCoordinator(async () => managed);
		await coordinator.setEnabled(true);

		await expect(coordinator.dispose()).rejects.toThrow('transient cleanup failure');
		await expect(coordinator.dispose()).resolves.toBeUndefined();
		expect(managed.dispose).toHaveBeenCalledTimes(2);
	});
});
