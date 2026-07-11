import { describe, expect, it, vi } from 'vitest';

import { raceSupplementalOperationLease } from '../../src/webview/shared/supplemental-operation-lease';

describe('supplemental operation lease', () => {
	it('returns completed values and clears the timeout', async () => {
		const clearTimer = vi.fn();
		const result = await raceSupplementalOperationLease(
			Promise.resolve('ok'),
			100,
			() => 'timer',
			clearTimer,
		);

		expect(result).toEqual({ status: 'completed', value: 'ok' });
		expect(clearTimer).toHaveBeenCalledWith('timer');
	});

	it('propagates operation rejection and clears the timeout', async () => {
		const failure = new Error('failed');
		const clearTimer = vi.fn();
		await expect(raceSupplementalOperationLease(
			Promise.reject(failure),
			100,
			() => 'timer',
			clearTimer,
		)).rejects.toBe(failure);
		expect(clearTimer).toHaveBeenCalledWith('timer');
	});

	it('releases a never-resolving operation when the lease expires', async () => {
		let expire: (() => void) | undefined;
		const resultPromise = raceSupplementalOperationLease(
			new Promise<never>(() => undefined),
			100,
			callback => { expire = callback; return 'timer'; },
			vi.fn(),
		);

		expire?.();
		await expect(resultPromise).resolves.toEqual({ status: 'timed-out' });
	});

	it('allows a primary queue continuation after a hung supplemental lease', async () => {
		let expire: (() => void) | undefined;
		const supplementalLease = raceSupplementalOperationLease(
			new Promise<never>(() => undefined),
			100,
			callback => { expire = callback; return 'timer'; },
			vi.fn(),
		);
		const primaryOperation = vi.fn(() => 'primary-ready');
		const queue = supplementalLease.then(primaryOperation);

		expire?.();

		await expect(queue).resolves.toBe('primary-ready');
		expect(primaryOperation).toHaveBeenCalledWith({ status: 'timed-out' });
	});
});
