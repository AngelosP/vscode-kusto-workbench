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