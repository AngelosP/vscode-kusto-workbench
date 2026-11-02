import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CompatSidecarSession } from '../../../src/host/compatSidecarSession';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function finalRequestId(message: unknown): string {
	if (!message || typeof message !== 'object' || !('requestId' in message)
		|| typeof message.requestId !== 'string' || !message.requestId) {
		throw new Error('Expected a correlated final persist request');
	}
	return message.requestId;
}

describe('CompatSidecarSession background captures', () => {
	const sessions: CompatSidecarSession[] = [];
	const create = () => {
		const session = new CompatSidecarSession(false, 'KQL');
		sessions.push(session);
		const sent: string[] = [];
		const post = vi.fn((message: unknown) => { sent.push(finalRequestId(message)); return true; });
		const report = vi.fn();
		return { session, sent, post, report };
	};
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(async () => {
		for (const session of sessions.splice(0)) session.settleClose();
		await vi.runAllTimersAsync();
		vi.useRealTimers();
	});

	it('accepts a delayed background reply without adding it to the final-request tail', async () => {
		const { session, sent, post, report } = create();
		session.requestBackgroundPersist(post, report);
		await vi.advanceTimersByTimeAsync(5_000);
		await session.waitForFinalPersists();
		expect(sent).toHaveLength(1);
		expect(report).not.toHaveBeenCalled();
		expect(session.hasPendingFinalPersist).toBe(false);
		expect(session.claimFinalPersistRequest(sent[0])).toBe(true);
		expect(session.claimFinalPersistRequest(sent[0])).toBe(false);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(session.completeFinalPersist(sent[0], undefined, { available: true })).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(report).not.toHaveBeenCalled();
	});

	it('coalesces a thousand visibility changes into one capture and one follow-up', async () => {
		const { session, sent, post, report } = create();
		session.requestBackgroundPersist(post, report);
		for (let index = 0; index < 1_000; index++) {
			session.setPanelVisible(true);
			session.setPanelVisible(false);
			session.requestBackgroundPersist(post, report);
		}
		expect(sent).toHaveLength(1);
		session.claimFinalPersistRequest(sent[0]);
		session.completeFinalPersist(sent[0]);
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(2);
		session.claimFinalPersistRequest(sent[1]);
		session.completeFinalPersist(sent[1]);
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(2);
		expect(report).not.toHaveBeenCalled();
	});

	it('preserves one coalesced follow-up when an obsolete live background reply arrives', async () => {
		const { session, sent, post, report } = create();
		session.requestBackgroundPersist(post, report);
		session.requestBackgroundPersist(post, report);
		const admission = session.reservePersistAdmission(2);
		const generation = session.generation;
		expect(session.currentEditRevision).toBe(0);
		expect(session.claimFinalPersistRequest(sent[0], 1)).toBe(false);
		expect(session.generation).toBe(generation);
		expect(sent).toHaveLength(2);
		admission.settle();
		expect(session.claimFinalPersistRequest(sent[1], 2)).toBe(true);
		session.completeFinalPersist(sent[1]);
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(2);
		expect(report).not.toHaveBeenCalled();
	});

	it.each(['false', 'reject'] as const)('ignores a late %s delivery result after a background reply is claimed', async failure => {
		const { session, sent, report } = create();
		const delivery = deferred<boolean>();
		session.requestBackgroundPersist(message => {
			sent.push(finalRequestId(message));
			return delivery.promise;
		}, report);
		expect(session.claimFinalPersistRequest(sent[0])).toBe(true);
		if (failure === 'false') delivery.resolve(false);
		else delivery.reject(new Error('late delivery failure'));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(session.hasPendingFinalPersistRequest(sent[0])).toBe(true);
		expect(report).not.toHaveBeenCalled();
		expect(session.completeFinalPersist(sent[0], undefined, { available: true })).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(report).not.toHaveBeenCalled();
	});

	it('reserves queued Save priority synchronously and rejects an obsolete background reply', async () => {
		const { session, sent, post, report } = create();
		session.requestBackgroundPersist(post, report);
		const backgroundId = sent[0];
		const saved = session.requestFinalPersist<number>(post, 'save');
		session.requestBackgroundPersist(post, report);
		const nextSave = session.requestFinalPersist<number>(post, 'save');
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(2);
		expect(session.claimFinalPersistRequest(backgroundId)).toBe(false);
		expect(session.completeFinalPersist(backgroundId)).toBe(false);
		session.claimFinalPersistRequest(sent[1]);
		session.completeFinalPersist(sent[1], undefined, 1);
		await expect(saved).resolves.toBe(1);
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(3);
		session.claimFinalPersistRequest(sent[2]);
		session.completeFinalPersist(sent[2], undefined, 2);
		await expect(nextSave).resolves.toBe(2);
		expect(report).not.toHaveBeenCalled();
	});

	it.each(['reload', 'upgrade'] as const)('retires unclaimed background ownership before %s changes admission', async transition => {
		const { session, sent, post, report } = create();
		session.requestBackgroundPersist(post, report);
		const requestId = sent[0];
		if (transition === 'reload') session.retirePersists();
		else (await session.beginUpgrade(7))?.finish();
		const generation = session.generation;
		const revision = session.currentEditRevision;
		expect(session.claimFinalPersistRequest(requestId)).toBe(false);
		expect(session.generation).toBe(generation);
		expect(session.currentEditRevision).toBe(revision);
		await vi.advanceTimersByTimeAsync(0);
		expect(report).not.toHaveBeenCalled();
	});

	it('retains one possibly-sent token until a final roundtrip releases it', async () => {
		const { session, sent, report } = create();
		const delivery = deferred<boolean>();
		const post = vi.fn((message: unknown) => {
			sent.push(finalRequestId(message));
			return sent.length === 1 ? delivery.promise : true;
		});
		session.requestBackgroundPersist(post, report, 'runtime-A');
		session.retirePersists();
		for (let index = 0; index < 1_000; index++) session.requestBackgroundPersist(post, report, 'runtime-A');
		expect(sent).toHaveLength(1);
		const saved = session.requestFinalPersist(post, 'save');
		await vi.advanceTimersByTimeAsync(0);
		session.requestBackgroundPersist(post, report, 'runtime-A');
		expect(sent).toHaveLength(2);
		session.claimFinalPersistRequest(sent[1]);
		session.completeFinalPersist(sent[1]);
		await saved;
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(3);
		delivery.reject(new Error('late obsolete transport failure'));
		await vi.advanceTimersByTimeAsync(0);
		expect(session.hasPendingFinalPersistRequest(sent[2])).toBe(true);
		expect(report).not.toHaveBeenCalled();
	});

	it('releases obsolete transport only for an actual runtime replacement', async () => {
		const { session, sent, post, report } = create();
		session.requestBackgroundPersist(post, report, 'runtime-A');
		session.retirePersists();
		session.requestBackgroundPersist(post, report, 'runtime-A');
		expect(sent).toHaveLength(1);
		session.requestBackgroundPersist(post, report, 'runtime-B');
		expect(sent).toHaveLength(2);
		expect(session.claimFinalPersistRequest(sent[0])).toBe(false);
		expect(session.hasPendingFinalPersistRequest(sent[1])).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(report).not.toHaveBeenCalled();
	});

	it('keeps the existing native custom final deadline after background preemption', async () => {
		const { session, sent, post, report } = create();
		session.requestBackgroundPersist(post, report);
		const settled = vi.fn();
		const saved = session.requestFinalPersist(post, 'save', 1_000).then(settled, settled);
		await vi.advanceTimersByTimeAsync(999);
		expect(settled).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await saved;
		expect(settled).toHaveBeenCalledExactlyOnceWith(new Error('Timed out waiting for the final KQL metadata snapshot.'));
		expect(session.claimFinalPersistRequest(sent[0])).toBe(false);
		expect(report).not.toHaveBeenCalled();
	});

	it('reports a genuine capture failure once and allows a later user-triggered attempt', async () => {
		const { session, sent, post, report } = create();
		session.requestBackgroundPersist(post, report);
		session.claimFinalPersistRequest(sent[0]);
		const error = new Error('capture failed');
		session.completeFinalPersist(sent[0], error);
		await vi.advanceTimersByTimeAsync(0);
		expect(report).toHaveBeenCalledExactlyOnceWith(error);
		expect(sent).toHaveLength(1);
		session.requestBackgroundPersist(post, report);
		expect(sent).toHaveLength(2);
	});

	it.each(['none', 'observed', 'applied', 'applied then retired'] as const)(
		'defers close timeout reporting until the final unload state is %s',
		async unload => {
			const { session, sent, post, report } = create();
			session.requestBackgroundPersist(post, report);
			session.freezeBackgroundPersists();
			let closed = false;
			const closing = session.waitForFinalPersists().then(() => { closed = true; });
			await vi.advanceTimersByTimeAsync(1_999);
			expect(closed).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await closing;
			expect(report).not.toHaveBeenCalled();
			if (unload !== 'none') session.markBeforeUnload('beforeunload');
			if (unload.startsWith('applied')) session.markAppliedBeforeUnload('beforeunload', session.generation);
			if (unload === 'applied then retired') session.retirePersists();
			expect((await session.getBackgroundCloseError())?.message).toBe(unload === 'applied'
				? undefined : 'Timed out waiting for the final KQL metadata snapshot.');
			session.requestBackgroundPersist(post, report);
			expect(sent).toHaveLength(1);
		},
	);

	it('joins a claimed capture on close without arming another arrival deadline', async () => {
		const { session, sent, post, report } = create();
		session.requestBackgroundPersist(post, report);
		session.claimFinalPersistRequest(sent[0]);
		session.freezeBackgroundPersists();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(session.hasPendingFinalPersistRequest(sent[0])).toBe(true);
		session.completeFinalPersist(sent[0]);
		await session.waitForFinalPersists();
		expect(await session.getBackgroundCloseError()).toBeUndefined();
		expect(report).not.toHaveBeenCalled();
	});

	it('does not hide a genuine capture failure behind a successfully applied unload', async () => {
		const { session, sent, post, report } = create();
		const error = new Error('Failed to capture the KQL metadata snapshot.');
		session.requestBackgroundPersist(post, report);
		expect(session.claimFinalPersistRequest(sent[0])).toBe(true);
		session.freezeBackgroundPersists();
		session.markAppliedBeforeUnload('beforeunload', session.generation);
		session.completeFinalPersist(sent[0], error);
		await session.waitForFinalPersists();
		expect(await session.getBackgroundCloseError()).toBe(error);
		expect(report).not.toHaveBeenCalled();
	});

	it('does not resurrect a retired background token during close', async () => {
		const { session, sent, post, report } = create();
		session.requestBackgroundPersist(post, report);
		session.retirePersists();
		session.freezeBackgroundPersists();
		await session.waitForFinalPersists();
		expect(await session.getBackgroundCloseError()).toBeUndefined();
		expect(session.claimFinalPersistRequest(sent[0])).toBe(false);
		session.settleClose();
		session.requestBackgroundPersist(post, report);
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(1);
		expect(report).not.toHaveBeenCalled();
	});
});

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

	it('claims a final reply once without completing it or releasing the next request early', async () => {
		vi.useFakeTimers();
		const session = new CompatSidecarSession(true, 'KQL');
		const sent: string[] = [];
		const post = (message: unknown) => { sent.push(finalRequestId(message)); return true; };
		const firstSettled = vi.fn();
		const secondSettled = vi.fn();
		const first = session.requestFinalPersist<number>(post, 'hidden').then(firstSettled, firstSettled);
		let second: Promise<unknown> | undefined;
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(session.claimFinalPersistRequest('other-request')).toBe(false);
			expect(session.claimFinalPersistRequest(sent[0])).toBe(true);
			expect(session.claimFinalPersistRequest(sent[0])).toBe(false);
			second = session.requestFinalPersist(post, 'save').then(secondSettled, secondSettled);
			await vi.advanceTimersByTimeAsync(2_100);
			expect(sent).toHaveLength(1);
			expect(firstSettled).not.toHaveBeenCalled();
			expect(secondSettled).not.toHaveBeenCalled();
			expect(session.hasPendingFinalPersistRequest(sent[0])).toBe(true);

			expect(session.completeFinalPersist(sent[0], undefined, 17)).toBe(true);
			await first;
			await vi.advanceTimersByTimeAsync(0);
			expect(firstSettled).toHaveBeenCalledExactlyOnceWith(17);
			expect(sent).toHaveLength(2);
			expect(session.claimFinalPersistRequest(sent[0])).toBe(false);
			expect(session.claimFinalPersistRequest(sent[1])).toBe(true);
			await vi.advanceTimersByTimeAsync(2_100);
			expect(secondSettled).not.toHaveBeenCalled();
			const failure = new Error('admission failed after receipt');
			expect(session.completeFinalPersist(sent[1], failure)).toBe(true);
			await second;
			expect(secondSettled).toHaveBeenCalledExactlyOnceWith(failure);
			expect(session.hasPendingFinalPersist).toBe(false);
		} finally {
			session.settleClose();
			await vi.runAllTimersAsync();
			await Promise.all([first, second]);
			vi.useRealTimers();
		}
	});

	it.each(['delivered', 'pending'] as const)('keeps the exact two-second reply deadline when delivery is %s', async delivery => {
		vi.useFakeTimers();
		const session = new CompatSidecarSession(true, 'SQL');
		let requestId = '';
		const settled = vi.fn();
		const pending = session.requestFinalPersist(message => {
			requestId = finalRequestId(message);
			return delivery === 'delivered' ? true : new Promise<boolean>(() => undefined);
		}, 'save').then(settled, settled);
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(session.claimFinalPersistRequest('unrelated')).toBe(false);
			await vi.advanceTimersByTimeAsync(1_999);
			expect(settled).not.toHaveBeenCalled();
			expect(session.hasPendingFinalPersistRequest(requestId)).toBe(true);
			await vi.advanceTimersByTimeAsync(1);
			await pending;
			expect(settled).toHaveBeenCalledExactlyOnceWith(new Error('Timed out waiting for the final SQL metadata snapshot.'));
			expect(session.claimFinalPersistRequest(requestId)).toBe(false);
			expect(session.completeFinalPersist(requestId)).toBe(false);
		} finally {
			session.settleClose();
			await vi.runAllTimersAsync();
			await pending;
			vi.useRealTimers();
		}
	});

	it.each(['false', 'reject', 'throw'] as const)('does not replace a claimed reply with a late %s transport result', async mode => {
		vi.useFakeTimers();
		const session = new CompatSidecarSession(true, 'KQL');
		const delivery = deferred<boolean>();
		let requestId = '';
		const settled = vi.fn();
		const pending = session.requestFinalPersist<string>(message => {
			requestId = finalRequestId(message);
			if (mode === 'throw') {
				expect(session.claimFinalPersistRequest(requestId)).toBe(true);
				throw new Error('late transport failure');
			}
			return delivery.promise;
		}, 'save').then(settled, settled);
		try {
			await vi.advanceTimersByTimeAsync(0);
			if (mode !== 'throw') expect(session.claimFinalPersistRequest(requestId)).toBe(true);
			if (mode === 'false') delivery.resolve(false);
			if (mode === 'reject') delivery.reject(new Error('late transport failure'));
			await vi.advanceTimersByTimeAsync(2_100);
			expect(settled).not.toHaveBeenCalled();
			expect(session.hasPendingFinalPersistRequest(requestId)).toBe(true);
			expect(session.completeFinalPersist(requestId, undefined, 'admitted')).toBe(true);
			await pending;
			expect(settled).toHaveBeenCalledExactlyOnceWith('admitted');
		} finally {
			session.settleClose();
			await vi.runAllTimersAsync();
			await pending;
			vi.useRealTimers();
		}
	});

	it.each(['false', 'reject', 'throw'] as const)('preserves %s delivery failures before any reply arrives', async mode => {
		vi.useFakeTimers();
		const session = new CompatSidecarSession(true, 'KQL');
		const settled = vi.fn();
		const pending = session.requestFinalPersist(() => {
			if (mode === 'throw') throw new Error('transport failure');
			return mode === 'false' ? false : Promise.reject(new Error('transport failure'));
		}, 'save').then(settled, settled);
		try {
			await vi.advanceTimersByTimeAsync(0);
			await pending;
			expect(settled).toHaveBeenCalledExactlyOnceWith(new Error(mode === 'false'
				? 'The final KQL metadata snapshot request was not delivered.'
				: 'The final KQL metadata snapshot request failed: transport failure'));
			expect(session.hasPendingFinalPersist).toBe(false);
		} finally {
			session.settleClose();
			await vi.runAllTimersAsync();
			await pending;
			vi.useRealTimers();
		}
	});

	it('rejects a claimed but unfinished snapshot during close settlement', async () => {
		vi.useFakeTimers();
		const session = new CompatSidecarSession(true, 'SQL');
		let requestId = '';
		const settled = vi.fn();
		const pending = session.requestFinalPersist(message => {
			requestId = finalRequestId(message);
			return true;
		}, 'hidden').then(settled, settled);
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(session.claimFinalPersistRequest(requestId)).toBe(true);
			session.settleClose();
			await pending;
			expect(settled).toHaveBeenCalledExactlyOnceWith(
				new Error('The SQL metadata editor closed before its final snapshot was confirmed.'),
			);
			expect(session.hasPendingFinalPersist).toBe(false);
			expect(session.claimFinalPersistRequest(requestId)).toBe(false);
		} finally {
			session.settleClose();
			await vi.runAllTimersAsync();
			await pending;
			vi.useRealTimers();
		}
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