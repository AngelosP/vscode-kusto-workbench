import { describe, expect, it, vi } from 'vitest';

import { CompatSidecarSession } from '../../../src/host/compatSidecarSession';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

describe('CompatSidecarSession', () => {
	it('admits only the newest queued revision after an older persist pauses', async () => {
		const session = new CompatSidecarSession(true, 'SQL');
		const gate = deferred<void>();
		const admitted: number[] = [];
		session.adoptRevision(1);
		const first = session.queuePersist(1, async isCurrent => {
			await gate.promise;
			if (isCurrent()) admitted.push(1);
		});
		session.adoptRevision(2);
		const second = session.queuePersist(2, async isCurrent => {
			if (isCurrent()) admitted.push(2);
		});
		gate.resolve();
		await Promise.all([first, second]);

		expect(admitted).toEqual([2]);
	});

	it('holds newer persists behind an upgrade lease', async () => {
		const session = new CompatSidecarSession(true, 'KQL');
		expect(session.hasPendingUpgrade).toBe(false);
		const upgrade = await session.beginUpgrade(1);
		expect(session.hasPendingUpgrade).toBe(true);
		const work = vi.fn();
		const persist = session.queuePersist(1, async () => { work(); });
		await Promise.resolve();
		expect(work).not.toHaveBeenCalled();

		upgrade?.finish();
		expect(session.hasPendingUpgrade).toBe(false);
		await persist;
		expect(work).toHaveBeenCalledOnce();
	});

	it.each(['KQL', 'SQL'])('lets a reserved %s persist finish before a later upgrade', async label => {
		const session = new CompatSidecarSession(true, label);
		const admission = session.reservePersistAdmission(1);
		let firstWasCurrent = false;
		let upgradeSettled = false;
		const upgrade = session.beginUpgrade(2).then(value => {
			upgradeSettled = true;
			return value;
		});
		const laterAdmission = session.reservePersistAdmission(3);
		let laterRan = false;
		const laterPersist = (async () => {
			try {
				await laterAdmission.waitForTurn();
				await laterAdmission.queue(async () => { laterRan = true; });
			} finally {
				laterAdmission.settle();
			}
		})();
		await Promise.resolve();
		expect(upgradeSettled).toBe(false);
		expect(laterRan).toBe(false);

		await admission.waitForTurn();
		await admission.queue(async isCurrent => { firstWasCurrent = isCurrent(); });
		admission.settle();
		const lease = await upgrade;

		expect(firstWasCurrent).toBe(true);
		expect(lease?.revision).toBe(2);
		expect(laterRan).toBe(false);
		lease?.finish();
		await laterPersist;
		expect(laterRan).toBe(true);
		await expect(session.waitForPersists()).resolves.toBeUndefined();
	});

	it.each(['KQL', 'SQL'])('holds %s Save behind an already-active upgrade', async label => {
		const session = new CompatSidecarSession(true, label);
		const upgrade = await session.beginUpgrade(1);
		expect(upgrade).toBeDefined();
		const work = vi.fn();
		const save = session.enqueueAfterPersists(async () => { work(); });

		await Promise.resolve();
		expect(work).not.toHaveBeenCalled();
		upgrade?.finish();
		await save;

		expect(work).toHaveBeenCalledOnce();
	});

	it('tracks dirty baselines and rebases only the matching draft', () => {
		const session = new CompatSidecarSession(true, 'SQL');
		session.markDirty('baseline-a');
		session.rebaseDraftBase('other', 'baseline-b');
		expect(session.baseText).toBe('baseline-a');

		session.rebaseDraftBase('baseline-a', 'baseline-b');
		expect(session.baseText).toBe('baseline-b');
		session.markClean(3);
		expect(session.isDirty).toBe(false);
		expect(session.currentStateEditRevision).toBe(3);
	});

	it('orders repair rebase before a later save selects its baseline', async () => {
		const session = new CompatSidecarSession(true, 'KQL');
		const repairGate = deferred<void>();
		const observedBaselines: Array<string | undefined> = [];
		session.markDirty('original');
		const repair = session.enqueueAfterPersists(async () => {
			await repairGate.promise;
			session.rebaseDraftBase('original', 'repaired');
		});
		const save = session.enqueueAfterPersists(async () => {
			observedBaselines.push(session.baseText);
		});

		repairGate.resolve();
		await Promise.all([repair, save]);
		expect(observedBaselines).toEqual(['repaired']);
	});

	it('orders persist A, Save, then persist B by invocation watermark', async () => {
		const session = new CompatSidecarSession(true, 'KQL');
		const firstGate = deferred<void>();
		const order: string[] = [];
		const firstAdmission = session.reservePersistAdmission(1);
		const firstPersist = (async () => {
			try {
				await firstAdmission.waitForTurn();
				await firstGate.promise;
				await firstAdmission.queue(async () => { order.push('persist-A'); });
			} finally {
				firstAdmission.settle();
				firstAdmission.settle();
			}
		})();
		const save = session.enqueueAfterPersists(async () => { order.push('save'); });
		const secondAdmission = session.reservePersistAdmission(2);
		const secondPersist = (async () => {
			try {
				await secondAdmission.waitForTurn();
				await secondAdmission.queue(async () => { order.push('persist-B'); });
			} finally {
				secondAdmission.settle();
			}
		})();
		await Promise.resolve();
		expect(order).toEqual([]);
		firstGate.resolve();

		await Promise.all([firstPersist, save, secondPersist]);
		expect(order).toEqual(['persist-A', 'save', 'persist-B']);
	});

	it('lets a local persist queued during repair notification use the repaired baseline', async () => {
		const session = new CompatSidecarSession(true, 'SQL');
		const reloadGate = deferred<void>();
		let committedBaseline = 'original';
		const repair = session.enqueueAfterPersists(async () => {
			committedBaseline = 'repaired';
			await reloadGate.promise;
		});
		const observed: string[] = [];
		const localPersist = session.queuePersist(0, async () => {
			observed.push(committedBaseline);
		});

		reloadGate.resolve();
		await Promise.all([repair, localPersist]);
		expect(observed).toEqual(['repaired']);
	});

	it('correlates final persist and reload responses', async () => {
		const session = new CompatSidecarSession(true, 'SQL');
		let finalRequestId = '';
		const final = session.requestFinalPersist<{ marker: string }>(message => {
			finalRequestId = String((message as any).requestId);
			return true;
		}, 'save');
		await vi.waitFor(() => expect(session.hasPendingFinalPersist).toBe(true));
		expect(session.completeFinalPersist('stale-request', undefined, { marker: 'stale' })).toBe(false);
		expect(session.completeFinalPersist(finalRequestId, undefined, { marker: 'current' })).toBe(true);
		await expect(final).resolves.toEqual({ marker: 'current' });

		const reload = session.createReloadRequest();
		expect(session.completeReload(reload.requestId, true, 4)).toBe(true);
		await expect(reload.result).resolves.toBe(true);
		expect(session.currentEditRevision).toBe(4);
	});

	it.each([4_999, 5_000])('checks native ACK arrival at %i ms before the timer callback runs', async elapsed => {
		vi.useFakeTimers();
		const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
		try {
			const session = new CompatSidecarSession(true, 'native');
			const reload = session.createReloadRequest(5_000, { absoluteCommitDeadline: 30_000 });
			clock.mockReturnValue(elapsed);
			expect(session.claimReloadRequest(reload.requestId)).toBe(elapsed < 5_000);
			expect(session.hasPendingReloadRequest(reload.requestId)).toBe(elapsed < 5_000);
			if (elapsed < 5_000) session.failReload(reload.requestId);
			await expect(reload.result).resolves.toBe(false);
			expect(session.claimReloadRequest(reload.requestId)).toBe(false);
			expect(session.completeReload(reload.requestId, true, 99)).toBe(false);
			expect(session.currentEditRevision).toBe(0);
		} finally {
			clock.mockRestore();
			vi.useRealTimers();
		}
	});

	it('keeps an on-time native ACK pending past arrival until its canonical commit', async () => {
		vi.useFakeTimers();
		const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
		try {
			const session = new CompatSidecarSession(true, 'native');
			const reload = session.createReloadRequest(5_000, { absoluteCommitDeadline: 30_000 });
			let settled = false;
			void reload.result.then(() => { settled = true; });
			clock.mockReturnValue(97);
			vi.advanceTimersByTime(97);
			expect(session.claimReloadRequest(reload.requestId)).toBe(true);
			clock.mockReturnValue(5_297);
			vi.advanceTimersByTime(5_200);
			await Promise.resolve();
			expect(settled).toBe(false);
			expect(session.hasPendingReloadRequest(reload.requestId)).toBe(true);
			clock.mockReturnValue(29_999);
			expect(session.completeReload(reload.requestId, true, 4)).toBe(true);
			await expect(reload.result).resolves.toBe(true);
			expect(session.hasPendingReloadRequest(reload.requestId)).toBe(false);
			expect(session.currentEditRevision).toBe(4);
		} finally {
			clock.mockRestore();
			vi.useRealTimers();
		}
	});

	it('does not renew the native owner deadline on delayed reservation or duplicate ACK', async () => {
		vi.useFakeTimers();
		const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
		const timers = vi.spyOn(globalThis, 'setTimeout');
		try {
			const session = new CompatSidecarSession(true, 'native');
			const reload = session.createReloadRequest(5_000, { absoluteCommitDeadline: 30_000 });
			clock.mockReturnValue(4_999);
			vi.advanceTimersByTime(4_999);
			expect(session.claimReloadRequest(reload.requestId)).toBe(true);
			expect(timers.mock.calls.map(call => call[1])).toEqual([5_000, 25_001]);
			clock.mockReturnValue(20_000);
			expect(session.claimReloadRequest(reload.requestId)).toBe(false);
			expect(timers).toHaveBeenCalledTimes(2);
			clock.mockReturnValue(30_000);
			expect(session.hasPendingReloadRequest(reload.requestId)).toBe(false);
			await expect(reload.result).resolves.toBe(false);
			expect(session.completeReload(reload.requestId, true, 7)).toBe(false);
			expect(session.currentEditRevision).toBe(0);
		} finally {
			timers.mockRestore();
			clock.mockRestore();
			vi.useRealTimers();
		}
	});

	it.each(['callback', 'pending check', 'commit'] as const)('expires a reserved native commit through %s', async expiry => {
		vi.useFakeTimers();
		const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
		try {
			const session = new CompatSidecarSession(true, 'native');
			const reload = session.createReloadRequest(5_000, { absoluteCommitDeadline: 30_000 });
			clock.mockReturnValue(100);
			vi.advanceTimersByTime(100);
			expect(session.claimReloadRequest(reload.requestId)).toBe(true);
			clock.mockReturnValue(30_000);
			if (expiry === 'callback') vi.advanceTimersByTime(29_900);
			else if (expiry === 'pending check') expect(session.hasPendingReloadRequest(reload.requestId)).toBe(false);
			else expect(session.completeReload(reload.requestId, true, 8)).toBe(false);
			await expect(reload.result).resolves.toBe(false);
			expect(session.hasPendingReloadRequest(reload.requestId)).toBe(false);
			expect(session.claimReloadRequest(reload.requestId)).toBe(false);
			expect(session.currentEditRevision).toBe(0);
		} finally {
			clock.mockRestore();
			vi.useRealTimers();
		}
	});

	it('caps native ACK arrival by the already-running owner operation deadline', async () => {
		vi.useFakeTimers();
		const clock = vi.spyOn(performance, 'now').mockReturnValue(28_000);
		try {
			const session = new CompatSidecarSession(true, 'native');
			const reload = session.createReloadRequest(5_000, { absoluteCommitDeadline: 30_000 });
			clock.mockReturnValue(30_000);
			expect(session.claimReloadRequest(reload.requestId)).toBe(false);
			await expect(reload.result).resolves.toBe(false);
			expect(session.completeReload(reload.requestId, true, 9)).toBe(false);
		} finally {
			clock.mockRestore();
			vi.useRealTimers();
		}
	});

	it('ignores a negative native ACK after a positive claim without consuming or adopting it', async () => {
		vi.useFakeTimers();
		const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
		try {
			const session = new CompatSidecarSession(true, 'native');
			const reload = session.createReloadRequest(5_000, { absoluteCommitDeadline: 30_000 });
			expect(session.completeReload(reload.requestId, true, 99)).toBe(false);
			expect(session.claimReloadRequest('unknown')).toBe(false);
			expect(session.claimReloadRequest(reload.requestId)).toBe(true);
			expect(session.completeReload(reload.requestId, false, 99)).toBe(false);
			expect(session.hasPendingReloadRequest(reload.requestId)).toBe(true);
			expect(session.currentEditRevision).toBe(0);
			expect(session.completeReload(reload.requestId, true, 3)).toBe(true);
			await expect(reload.result).resolves.toBe(true);
		} finally {
			clock.mockRestore();
			vi.useRealTimers();
		}
	});

	it('settles an unclaimed negative native ACK immediately', async () => {
		const session = new CompatSidecarSession(true, 'native');
		const reload = session.createReloadRequest(5_000, { absoluteCommitDeadline: performance.now() + 30_000 });
		expect(session.completeReload(reload.requestId, false, 2)).toBe(true);
		await expect(reload.result).resolves.toBe(false);
		expect(session.claimReloadRequest(reload.requestId)).toBe(false);
		expect(session.currentEditRevision).toBe(2);
	});

	it.each(['failure', 'close'] as const)('settles a claimed native ACK false on %s', async outcome => {
		const session = new CompatSidecarSession(true, 'native');
		const reload = session.createReloadRequest(5_000, { absoluteCommitDeadline: performance.now() + 30_000 });
		expect(session.claimReloadRequest(reload.requestId)).toBe(true);
		if (outcome === 'failure') expect(session.failReload(reload.requestId)).toBe(true);
		else { session.beginClose(); session.settleClose(); }
		await expect(reload.result).resolves.toBe(false);
		expect(session.hasPendingReloadRequest(reload.requestId)).toBe(false);
		expect(session.completeReload(reload.requestId, true, 99)).toBe(false);
		expect(session.currentEditRevision).toBe(0);
	});

	it('keeps default compatibility reload semantics without a native owner deadline', async () => {
		vi.useFakeTimers();
		const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
		try {
			const session = new CompatSidecarSession(true, 'SQL');
			const reload = session.createReloadRequest();
			clock.mockReturnValue(60_000);
			expect(session.claimReloadRequest(reload.requestId)).toBe(false);
			expect(session.hasPendingReloadRequest(reload.requestId)).toBe(true);
			expect(session.completeReload(reload.requestId, true, 4)).toBe(true);
			await expect(reload.result).resolves.toBe(true);
			const expired = session.createReloadRequest();
			vi.advanceTimersByTime(5_000);
			await expect(expired.result).resolves.toBe(false);
			expect(session.completeReload(expired.requestId, true, 99)).toBe(false);
			expect(session.currentEditRevision).toBe(4);
		} finally {
			clock.mockRestore();
			vi.useRealTimers();
		}
	});

	it('settles outstanding waiters when closing', async () => {
		const session = new CompatSidecarSession(true, 'KQL');
		const final = session.requestFinalPersist(() => true, 'save', 10_000);
		const reload = session.createReloadRequest(10_000);
		await vi.waitFor(() => expect(session.hasPendingFinalPersist).toBe(true));

		session.beginClose();
		session.settleClose();

		await expect(final).rejects.toThrow('closed');
		await expect(reload.result).resolves.toBe(false);
		expect(session.isClosing).toBe(true);
	});

	it('seals persist and repair queues once close begins', async () => {
		const session = new CompatSidecarSession(true, 'SQL');
		const gate = deferred<void>();
		const admitted = session.enqueueAfterPersists(async () => { await gate.promise; });

		session.beginClose();
		await expect(session.queuePersist(0, async () => undefined)).rejects.toThrow('closing');
		await expect(session.enqueueAfterPersists(async () => undefined)).rejects.toThrow('closing');

		gate.resolve();
		await admitted;
		await expect(session.waitForPersists()).resolves.toBeUndefined();
	});

	it.each(['KQL', 'SQL'])('waits for an active %s upgrade before close drain completes', async label => {
		const session = new CompatSidecarSession(true, label);
		const upgrade = await session.beginUpgrade(1);
		session.beginClose();
		let drained = false;
		const drain = session.waitForPersists().then(() => { drained = true; });
		await Promise.resolve();

		expect(drained).toBe(false);
		expect(await session.beginUpgrade(2)).toBeUndefined();
		upgrade?.finish();
		await drain;
		expect(drained).toBe(true);
	});

	it('rejects an upgrade that was waiting when close began', async () => {
		const session = new CompatSidecarSession(true, 'SQL');
		const first = await session.beginUpgrade(1);
		const second = session.beginUpgrade(2);
		session.beginClose();
		first?.finish();

		await expect(second).resolves.toBeUndefined();
		await expect(session.waitForPersists()).resolves.toBeUndefined();
	});

	it('serializes three upgrades and keeps every waiter in the close barrier', async () => {
		const session = new CompatSidecarSession(true, 'KQL');
		const first = await session.beginUpgrade(1);
		const secondResult = session.beginUpgrade(2);
		const thirdResult = session.beginUpgrade(3);
		let thirdSettled = false;
		void thirdResult.then(() => { thirdSettled = true; });

		first?.finish();
		const second = await secondResult;
		await Promise.resolve();
		expect(second?.revision).toBe(2);
		expect(thirdSettled).toBe(false);

		session.beginClose();
		let drained = false;
		const drain = session.waitForPersists().then(() => { drained = true; });
		await Promise.resolve();
		expect(drained).toBe(false);

		second?.finish();
		await expect(thirdResult).resolves.toBeUndefined();
		await drain;
		expect(drained).toBe(true);
	});
});