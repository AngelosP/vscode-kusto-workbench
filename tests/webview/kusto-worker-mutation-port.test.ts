import { describe, expect, it, vi } from 'vitest';

import { KustoWorkerMutationPort } from '../../src/webview/shared/kusto-worker-mutation-port.js';

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe('KustoWorkerMutationPort', () => {
	it('serializes whole transactions and keeps the tail alive after rejection', async () => {
		const port = new KustoWorkerMutationPort();
		const gate = deferred();
		const order: string[] = [];
		const first = port.enqueue({ kind: 'primary-apply' }, async () => {
			order.push('first:start');
			await gate.promise;
			order.push('first:end');
			throw new Error('failed');
		});
		const second = port.enqueue({ kind: 'context-switch' }, () => { order.push('second'); });

		expect(order).toEqual([]);
		await vi.waitFor(() => expect(order).toEqual(['first:start']));
		gate.resolve();
		await expect(first).rejects.toThrow('failed');
		await second;
		expect(order).toEqual(['first:start', 'first:end', 'second']);
	});

	it('keeps primary intent, committed revision, and destructive epoch distinct', async () => {
		const port = new KustoWorkerMutationPort();
		const gate = deferred();
		const first = port.enqueue({ kind: 'primary-apply', advancesPrimaryIntent: true }, async transaction => {
			await gate.promise;
			expect(transaction.commit()).toBe(true);
			expect(transaction.commit({ destructive: true })).toBe(true);
		});
		const second = port.enqueue({ kind: 'supplemental-apply' }, transaction => {
			expect(transaction.commit()).toBe(true);
			expect(transaction.isActive()).toBe(true);
		});

		expect(port.getSnapshot()).toEqual({
			primaryIntentGeneration: 1, committedRevision: 0, destructiveEpoch: 0,
		});
		gate.resolve();
		await Promise.all([first, second]);
		expect(port.getSnapshot()).toEqual({
			primaryIntentGeneration: 1, committedRevision: 3, destructiveEpoch: 1,
		});
	});

	it('rejects a late commit and runs recovery only after detached settlement', async () => {
		const port = new KustoWorkerMutationPort();
		const physical = deferred<string>();
		let expire!: () => void;
		let lateCommit = true;
		const recovery = vi.fn();
		const order: string[] = [];
		const leased = port.enqueueLeased({
			request: { kind: 'supplemental-apply' },
			timeoutMs: 100,
			run: async transaction => {
				const value = await physical.promise;
				lateCommit = transaction.commit();
				order.push('physical-settled');
				return value;
			},
			onDetachedSettled: transaction => {
				order.push('recovery');
				recovery(transaction.kind, transaction.commit({ destructive: true }));
			},
			timerApi: {
				setTimer: callback => { expire = callback; return 'timer'; },
				clearTimer: vi.fn(),
			},
		});
		const second = port.enqueue({ kind: 'context-switch' }, () => { order.push('second'); });

		await vi.waitFor(() => expect(expire).toEqual(expect.any(Function)));
		expire();
		await expect(leased).resolves.toEqual({ status: 'timed-out' });
		expect(recovery).not.toHaveBeenCalled();
		expect(order).toEqual([]);
		physical.resolve('late');
		await vi.waitFor(() => expect(recovery).toHaveBeenCalledWith('recovery', true));
		await second;
		expect(lateCommit).toBe(false);
		expect(order).toEqual(['physical-settled', 'recovery', 'second']);
		expect(port.getSnapshot()).toEqual({
			primaryIntentGeneration: 1, committedRevision: 1, destructiveEpoch: 1,
		});
	});
});