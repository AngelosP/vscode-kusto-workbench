import { describe, expect, it, vi } from 'vitest';
import { completeExternalMcpProviderStartup } from '../../../src/host/externalMcpProviderStartup';

describe('external MCP provider startup', () => {
	it('closes the bound bridge when post-bind discovery initialization fails', async () => {
		const close = vi.fn(async () => undefined);
		const cleanupSucceeded = vi.fn();
		const failure = new Error('provider storage unavailable');

		await expect(completeExternalMcpProviderStartup({ close }, async () => {
			throw failure;
		}, cleanupSucceeded)).rejects.toBe(failure);
		expect(close).toHaveBeenCalledOnce();
		expect(cleanupSucceeded).toHaveBeenCalledOnce();
	});

	it('does not release provisional bridge ownership when startup cleanup fails', async () => {
		const cleanupFailure = new Error('bridge close failed');
		const bridge = { close: vi.fn(async () => { throw cleanupFailure; }) };
		const cleanupSucceeded = vi.fn();

		await expect(completeExternalMcpProviderStartup(bridge, async () => {
			throw new Error('discovery failed');
		}, cleanupSucceeded)).rejects.toThrow('startup and cleanup failed');
		expect(cleanupSucceeded).not.toHaveBeenCalled();
	});

	it('returns both resources without closing either after successful startup', async () => {
		const bridge = { close: vi.fn(async () => undefined) };
		const discovery = { close: vi.fn(async () => undefined) };

		expect(await completeExternalMcpProviderStartup(bridge, async () => discovery))
			.toEqual({ bridge, discovery });
		expect(bridge.close).not.toHaveBeenCalled();
		expect(discovery.close).not.toHaveBeenCalled();
	});
});