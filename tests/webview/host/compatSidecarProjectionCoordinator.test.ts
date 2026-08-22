import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
	CompatSidecarProjectionCoordinator,
	type CompatSidecarProjectionAttempt,
} from '../../../src/host/compatSidecarProjectionCoordinator';
import { CompatSidecarSession } from '../../../src/host/compatSidecarSession';

type RecordedProjectionAttempt = CompatSidecarProjectionAttempt & Readonly<{ reloadRequestId: string }>;

function recordProjectionAttempt(
	attempt: CompatSidecarProjectionAttempt,
	attempts: RecordedProjectionAttempt[],
): boolean {
	const reloadRequestId = attempt.reserveReload();
	if (!reloadRequestId) throw new Error('Expected the current projection to reserve a reload waiter.');
	attempts.push({ ...attempt, reloadRequestId });
	return true;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	await vi.waitFor(() => expect(predicate()).toBe(true));
}

describe('CompatSidecarProjectionCoordinator', () => {
	it('admits the established generation-zero baseline before the first projection', () => {
		const coordinator = new CompatSidecarProjectionCoordinator({
			session: new CompatSidecarSession(true, 'KQL'),
			readSourceText: () => 'source',
			isDisposed: () => false,
			postProjection: async () => true,
		});

		expect(coordinator.activeSourceGeneration).toBe(0);
		expect(coordinator.admitPersist({
			sourceGeneration: 0,
			editRevision: 1,
			requireCurrentGeneration: true,
			allowMissingSourceGeneration: false,
		})).toBe(true);
		expect(coordinator.admitPersist({
			sourceGeneration: undefined,
			editRevision: 1,
			requireCurrentGeneration: true,
			allowMissingSourceGeneration: false,
		})).toBe(false);
	});

	it('keeps projection B authoritative after a late A acknowledgement and newer A persist', async () => {
		const session = new CompatSidecarSession(true, 'KQL');
		const attempts: RecordedProjectionAttempt[] = [];
		let sourceText = 'A';
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => sourceText,
			isDisposed: () => false,
			postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
		});

		const projectionA = coordinator.project({ forceReload: true, retirePersists: true });
		await waitFor(() => attempts.length === 1);
		const attemptA = attempts[0];

		sourceText = 'B';
		const projectionB = coordinator.project({ forceReload: true, retirePersists: true });
		await waitFor(() => attempts.length === 2);
		const attemptB = attempts[1];

		expect(coordinator.completeReload({
			requestId: attemptA.reloadRequestId,
			applied: true,
			editRevision: 50,
		})).toBe(false);
		expect(await projectionA).toBe(false);
		expect(session.currentEditRevision).toBe(0);
		expect(coordinator.admitPersist({
			sourceGeneration: attemptA.generation,
			editRevision: 51,
			requireCurrentGeneration: true,
			allowMissingSourceGeneration: false,
		})).toBe(false);

		expect(coordinator.completeReload({
			requestId: attemptB.reloadRequestId,
			applied: true,
			editRevision: 2,
		})).toBe(true);
		expect(await projectionB).toBe(true);
		expect(coordinator.activeSourceGeneration).toBe(attemptB.generation);
		expect(session.currentEditRevision).toBe(2);
	});

	it('settles owner candidates false for a superseded projection and true only for its accepted successor', async () => {
		const attempts: RecordedProjectionAttempt[] = [];
		const settled: Array<{ generation: number; applied: boolean }> = [];
		let sourceText = 'A';
		const coordinator = new CompatSidecarProjectionCoordinator({
			session: new CompatSidecarSession(true, 'KQL'),
			readSourceText: () => sourceText,
			isDisposed: () => false,
			onProjectionSettled: (attempt, applied) => {
				settled.push({ generation: attempt.generation, applied });
			},
			postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
		});

		const projectionA = coordinator.project();
		await waitFor(() => attempts.length === 1);
		sourceText = 'B';
		const projectionB = coordinator.project();
		await waitFor(() => attempts.length === 2);
		coordinator.completeReload({
			requestId: attempts[1].reloadRequestId, applied: true, editRevision: 1,
		});

		expect(await projectionA).toBe(false);
		expect(await projectionB).toBe(true);
		expect(settled).toEqual([
			{ generation: attempts[0].generation, applied: false },
			{ generation: attempts[1].generation, applied: true },
		]);
	});

	it('rejects activation when owner compare-and-commit conflicts', async () => {
		let attempt: RecordedProjectionAttempt | undefined;
		const settled: boolean[] = [];
		const coordinator = new CompatSidecarProjectionCoordinator({
			session: new CompatSidecarSession(true, 'KQL'),
			readSourceText: () => 'source',
			isDisposed: () => false,
			onProjectionSettled: (_attempt, applied) => {
				settled.push(applied);
				return applied ? false : true;
			},
			postProjection: async value => {
				const reloadRequestId = value.reserveReload();
				if (!reloadRequestId) return false;
				attempt = { ...value, reloadRequestId };
				return true;
			},
		});

		const projection = coordinator.project();
		await waitFor(() => !!attempt);
		coordinator.completeReload({ requestId: attempt!.reloadRequestId, applied: true, editRevision: 1 });

		expect(await projection).toBe(false);
		expect(coordinator.activeSourceGeneration).toBe(0);
		expect(settled).toEqual([true]);
		expect(coordinator.admitPersist({
			sourceGeneration: 0, editRevision: 1,
			requireCurrentGeneration: true, allowMissingSourceGeneration: false,
		})).toBe(true);
	});

	it('does not commit owner state when source changes during awaited settlement', async () => {
		let sourceText = 'A';
		let attempt: RecordedProjectionAttempt | undefined;
		let markSettlementStarted!: () => void;
		let releaseSettlement!: () => void;
		const settlementStarted = new Promise<void>(resolve => { markSettlementStarted = resolve; });
		const settlementGate = new Promise<void>(resolve => { releaseSettlement = resolve; });
		let ownerCommits = 0;
		const coordinator = new CompatSidecarProjectionCoordinator({
			session: new CompatSidecarSession(true, 'KQL'),
			readSourceText: () => sourceText,
			isDisposed: () => false,
			onProjectionSettled: async (candidate, applied) => {
				if (!applied) return true;
				markSettlementStarted();
				await settlementGate;
				if (!candidate.isCurrent()) return false;
				ownerCommits++;
				return candidate.commitActivation();
			},
			postProjection: async value => {
				const reloadRequestId = value.reserveReload();
				if (!reloadRequestId) return false;
				attempt = { ...value, reloadRequestId };
				return true;
			},
		});

		const projection = coordinator.project();
		await waitFor(() => !!attempt);
		coordinator.completeReload({ requestId: attempt!.reloadRequestId, applied: true, editRevision: 1 });
		await settlementStarted;
		sourceText = 'B';
		releaseSettlement();

		expect(await projection).toBe(false);
		expect(ownerCommits).toBe(0);
		expect(coordinator.activeSourceGeneration).toBe(0);
	});

	it('waits for acknowledged projection authority before persistence admission', async () => {
		let attempt: RecordedProjectionAttempt | undefined;
		const coordinator = new CompatSidecarProjectionCoordinator({
			session: new CompatSidecarSession(true, 'KQL'),
			readSourceText: () => 'source',
			isDisposed: () => false,
			postProjection: async value => {
				const reloadRequestId = value.reserveReload();
				if (!reloadRequestId) return false;
				attempt = { ...value, reloadRequestId };
				return true;
			},
		});

		const projection = coordinator.project();
		await waitFor(() => !!attempt);
		expect(coordinator.completeReload({
			requestId: attempt!.reloadRequestId,
			applied: true,
			editRevision: 2,
		})).toBe(true);
		await coordinator.waitForAcknowledgedProjection(attempt!.generation);

		expect(coordinator.activeSourceGeneration).toBe(attempt!.generation);
		expect(await projection).toBe(true);
	});

	it('settles no-reservation and thrown projections exactly once', async () => {
		for (const mode of ['no-reservation', 'throw'] as const) {
			const settled: boolean[] = [];
			const coordinator = new CompatSidecarProjectionCoordinator({
				session: new CompatSidecarSession(true, 'KQL'),
				readSourceText: () => 'source',
				isDisposed: () => false,
				onProjectionSettled: (_attempt, applied) => { settled.push(applied); },
				postProjection: async () => {
					if (mode === 'throw') throw new Error('projection failed');
					return true;
				},
			});

			if (mode === 'throw') await expect(coordinator.project()).rejects.toThrow('projection failed');
			else await expect(coordinator.project()).resolves.toBe(false);
			expect(settled).toEqual([false]);
		}
	});

	it('settles timeout and disposal terminals exactly once', async () => {
		for (const mode of ['timeout', 'disposal'] as const) {
			const session = new CompatSidecarSession(true, 'KQL');
			const reload = Promise.withResolvers<boolean>();
			vi.spyOn(session, 'createReloadRequest').mockReturnValueOnce({
				requestId: `${mode}-reload`, result: reload.promise,
			});
			let disposed = false;
			let attempt: CompatSidecarProjectionAttempt | undefined;
			const settled: boolean[] = [];
			const coordinator = new CompatSidecarProjectionCoordinator({
				session,
				readSourceText: () => 'source',
				isDisposed: () => disposed,
				onProjectionSettled: (_attempt, applied) => { settled.push(applied); },
				postProjection: async value => {
					attempt = value;
					return !!value.reserveReload();
				},
			});

			const projection = coordinator.project();
			await waitFor(() => !!attempt);
			if (mode === 'disposal') disposed = true;
			reload.resolve(false);
			expect(await projection).toBe(false);
			expect(settled).toEqual([false]);
		}
	});

	it('recovers after a current request reload fails without letting superseded A demote B', async () => {
		const session = new CompatSidecarSession(true, 'SQL');
		const attempts: RecordedProjectionAttempt[] = [];
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => 'source',
			isDisposed: () => false,
			initialProjectionMaxAttempts: 2,
			postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
		});

		const initial = coordinator.requestDocument('initial');
		await waitFor(() => attempts.length === 1);
		coordinator.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
		expect(await initial).toBe(true);

		const failed = coordinator.requestDocument('failed-current');
		await waitFor(() => attempts.length === 2);
		coordinator.completeReload({ requestId: attempts[1].reloadRequestId, applied: false, editRevision: 0 });
		expect(await failed).toBe(false);
		expect(coordinator.isInitialized).toBe(false);

		const recovery = coordinator.requestDocument('recovery');
		await waitFor(() => attempts.length === 3);
		coordinator.completeReload({ requestId: attempts[2].reloadRequestId, applied: false, editRevision: 0 });
		await waitFor(() => attempts.length === 4);
		coordinator.completeReload({ requestId: attempts[3].reloadRequestId, applied: true, editRevision: 1 });
		expect(await recovery).toBe(true);
		expect(coordinator.isInitialized).toBe(true);

		const requestA = coordinator.requestDocument('A');
		await waitFor(() => attempts.length === 5);
		const requestB = coordinator.requestDocument('B');
		await waitFor(() => attempts.length === 6);
		coordinator.completeReload({ requestId: attempts[5].reloadRequestId, applied: true, editRevision: 2 });
		expect(await requestB).toBe(true);
		expect(await requestA).toBe(false);
		expect(coordinator.isInitialized).toBe(true);
	});

	it('allows a newer local edit to supersede only a pending same-source projection', async () => {
		const session = new CompatSidecarSession(true, 'SQL');
		const attempts: RecordedProjectionAttempt[] = [];
		let sourceText = 'same';
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => sourceText,
			isDisposed: () => false,
			postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
		});

		const initial = coordinator.project({ forceReload: true, retirePersists: true });
		await waitFor(() => attempts.length === 1);
		coordinator.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 1 });
		expect(await initial).toBe(true);

		const pending = coordinator.project({ forceReload: true, expectedEditRevision: 2 });
		await waitFor(() => attempts.length === 2);
		expect(coordinator.admitPersist({
			sourceGeneration: attempts[0].generation,
			editRevision: 3,
			requireCurrentGeneration: true,
			allowMissingSourceGeneration: false,
		})).toBe(true);
		expect(await pending).toBe(false);

		sourceText = 'different';
		const external = coordinator.project({ forceReload: true, expectedEditRevision: 3, retirePersists: true });
		await waitFor(() => attempts.length === 3);
		expect(coordinator.admitPersist({
			sourceGeneration: attempts[0].generation,
			editRevision: 4,
			requireCurrentGeneration: true,
			allowMissingSourceGeneration: false,
		})).toBe(false);
		coordinator.completeReload({ requestId: attempts[2].reloadRequestId, applied: true, editRevision: 3 });
		expect(await external).toBe(true);
	});

	it('keeps projection currentness byte-exact while rollback remains EOL-normalized', async () => {
		const session = new CompatSidecarSession(true, 'KQL');
		let sourceText = 'line 1\r\nline 2';
		let attempt: RecordedProjectionAttempt | undefined;
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => sourceText,
			isDisposed: () => false,
			postProjection: async value => {
				const reloadRequestId = value.reserveReload();
				if (!reloadRequestId) return false;
				attempt = { ...value, reloadRequestId };
				return true;
			},
		});

		const projection = coordinator.project({ forceReload: true });
		await waitFor(() => !!attempt);
		sourceText = 'line 1\nline 2';
		expect(coordinator.completeReload({
			requestId: attempt!.reloadRequestId,
			applied: true,
			editRevision: 1,
		})).toBe(false);
		expect(await projection).toBe(false);
	});

	it('starts the reload deadline only after projection preparation completes', async () => {
		const session = new CompatSidecarSession(true, 'SQL');
		const createReloadRequest = vi.spyOn(session, 'createReloadRequest');
		const preparation = Promise.withResolvers<void>();
		let reloadRequestId = '';
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => 'source',
			isDisposed: () => false,
			postProjection: async attempt => {
				await preparation.promise;
				reloadRequestId = attempt.reserveReload() ?? '';
				return !!reloadRequestId;
			},
		});

		const projection = coordinator.project({ forceReload: true });
		await Promise.resolve();
		expect(createReloadRequest).not.toHaveBeenCalled();
		preparation.resolve();
		await waitFor(() => !!reloadRequestId);
		expect(createReloadRequest).toHaveBeenCalledOnce();
		coordinator.completeReload({ requestId: reloadRequestId, applied: true, editRevision: 1 });
		expect(await projection).toBe(true);
	});

	it.each(['before', 'after'] as const)('cleans reload admission when projection preparation throws %s reservation', async phase => {
		const session = new CompatSidecarSession(true, 'KQL');
		let shouldThrow = true;
		let successfulAttempt: RecordedProjectionAttempt | undefined;
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => 'source',
			isDisposed: () => false,
			postProjection: async attempt => {
				if (shouldThrow && phase === 'before') throw new Error('preparation failed');
				const reloadRequestId = attempt.reserveReload();
				if (!reloadRequestId) return false;
				if (shouldThrow) throw new Error('transport preparation failed');
				successfulAttempt = { ...attempt, reloadRequestId };
				return true;
			},
		});

		await expect(coordinator.project()).rejects.toThrow(
			phase === 'before' ? 'preparation failed' : 'transport preparation failed',
		);
		shouldThrow = false;
		const recovery = coordinator.project();
		await waitFor(() => !!successfulAttempt);
		expect(session.hasPendingReloadRequest(successfulAttempt!.reloadRequestId)).toBe(true);
		coordinator.completeReload({ requestId: successfulAttempt!.reloadRequestId, applied: true, editRevision: 1 });
		expect(await recovery).toBe(true);
	});

	it('treats timeout and duplicate acknowledgements as non-current terminals', async () => {
		const session = new CompatSidecarSession(true, 'SQL');
		const firstReload = Promise.withResolvers<boolean>();
		vi.spyOn(session, 'createReloadRequest').mockReturnValueOnce({
			requestId: 'timed-out-reload',
			result: firstReload.promise,
		});
		let attempt: RecordedProjectionAttempt | undefined;
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => 'source',
			isDisposed: () => false,
			postProjection: async value => {
				const reloadRequestId = value.reserveReload();
				if (!reloadRequestId) return false;
				attempt = { ...value, reloadRequestId };
				return true;
			},
		});

		const timedOut = coordinator.project();
		await waitFor(() => !!attempt);
		firstReload.resolve(false);
		expect(await timedOut).toBe(false);

		attempt = undefined;
		const current = coordinator.project();
		await waitFor(() => !!attempt);
		expect(coordinator.completeReload({ requestId: attempt!.reloadRequestId, applied: true, editRevision: 2 })).toBe(true);
		expect(coordinator.completeReload({ requestId: attempt!.reloadRequestId, applied: true, editRevision: 99 })).toBe(false);
		expect(await current).toBe(true);
		expect(session.currentEditRevision).toBe(2);
	});

	it('retires a waiter when disposal lands after reservation', async () => {
		const session = new CompatSidecarSession(true, 'KQL');
		let disposed = false;
		let reloadRequestId = '';
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => 'source',
			isDisposed: () => disposed,
			postProjection: async attempt => {
				reloadRequestId = attempt.reserveReload() ?? '';
				disposed = true;
				return true;
			},
		});

		expect(await coordinator.project()).toBe(false);
		expect(reloadRequestId).not.toBe('');
		expect(session.hasPendingReloadRequest(reloadRequestId)).toBe(false);
		expect(coordinator.completeReload({ requestId: reloadRequestId, applied: true, editRevision: 1 })).toBe(false);
	});

	it('bounds initial recovery per source and resets only after source changes', async () => {
		const session = new CompatSidecarSession(true, 'KQL');
		let sourceText = 'A';
		let attempts = 0;
		const firstAttempt = Promise.withResolvers<void>();
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => sourceText,
			isDisposed: () => false,
			initialProjectionMaxAttempts: 2,
			postProjection: async () => {
				attempts++;
				if (attempts === 1) await firstAttempt.promise;
				return false;
			},
		});

		const first = coordinator.ensureInitialProjection('initial-request');
		await waitFor(() => attempts === 1);
		const sameSource = coordinator.ensureInitialProjection('same-source-request');
		sourceText = 'B';
		const changedSource = coordinator.ensureInitialProjection('changed-source-request');
		firstAttempt.resolve();
		expect(await first).toBe(false);
		expect(await sameSource).toBe(false);
		expect(await changedSource).toBe(false);
		await waitFor(() => attempts === 3);

		expect(await coordinator.ensureInitialProjection('duplicate-B')).toBe(false);
		expect(attempts).toBe(3);

		sourceText = 'C';
		expect(await coordinator.ensureInitialProjection('changed-to-C')).toBe(false);
		expect(attempts).toBe(5);
		expect(coordinator.isInitialized).toBe(false);
	});

	it('leaves unseen C eligible when A changes to B and then C during the follow-up', async () => {
		const gates = {
			A: Promise.withResolvers<void>(),
			B: Promise.withResolvers<void>(),
		};
		let sourceText = 'A';
		const attemptedSources: string[] = [];
		const coordinator = new CompatSidecarProjectionCoordinator({
			session: new CompatSidecarSession(true, 'KQL'),
			readSourceText: () => sourceText,
			isDisposed: () => false,
			initialProjectionMaxAttempts: 1,
			postProjection: async attempt => {
				attemptedSources.push(attempt.sourceText);
				if (attempt.sourceText === 'A') await gates.A.promise;
				if (attempt.sourceText === 'B') await gates.B.promise;
				return false;
			},
		});

		const initial = coordinator.ensureInitialProjection('A-request');
		await waitFor(() => attemptedSources.includes('A'));
		sourceText = 'B';
		const coalesced = coordinator.ensureInitialProjection('B-request');
		gates.A.resolve();
		await initial;
		await coalesced;
		await waitFor(() => attemptedSources.includes('B'));
		sourceText = 'C';
		const cCoalesced = coordinator.ensureInitialProjection('C-coalesced');
		gates.B.resolve();
		await cCoalesced;

		await coordinator.ensureInitialProjection('C-explicit');
		expect(attemptedSources).toEqual(['A', 'B', 'C']);
		expect(await coordinator.ensureInitialProjection('C-duplicate')).toBe(false);
		expect(attemptedSources).toEqual(['A', 'B', 'C']);
	});

	it('treats CRLF and LF as distinct initial recovery bytes', async () => {
		let sourceText = 'line 1\r\nline 2';
		const attemptedSources: string[] = [];
		const coordinator = new CompatSidecarProjectionCoordinator({
			session: new CompatSidecarSession(true, 'KQL'),
			readSourceText: () => sourceText,
			isDisposed: () => false,
			initialProjectionMaxAttempts: 1,
			postProjection: async attempt => {
				attemptedSources.push(attempt.sourceText);
				return false;
			},
		});

		await coordinator.ensureInitialProjection('crlf');
		expect(await coordinator.ensureInitialProjection('crlf-duplicate')).toBe(false);
		sourceText = 'line 1\nline 2';
		await coordinator.ensureInitialProjection('lf');

		expect(attemptedSources).toEqual(['line 1\r\nline 2', 'line 1\nline 2']);
	});

	it('owns source rollback retries and keeps terminal failure fenced until source authority changes', async () => {
		const session = new CompatSidecarSession(true, 'SQL');
		let sourceText = 'A';
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => sourceText,
			isDisposed: () => false,
			postProjection: async () => false,
		});
		const admissionEpoch = coordinator.captureSourceReloadEpoch();
		sourceText = 'B';
		await coordinator.project({ forceReload: true, retirePersists: true });
		sourceText = 'STALE';
		const restore = vi.fn(async () => false);

		await coordinator.rollbackSupersededSourceEdit(admissionEpoch, 'STALE', restore);
		expect(restore).toHaveBeenCalledTimes(3);
		expect(restore).toHaveBeenCalledWith('B');
		expect(coordinator.sourceRollbackFailed).toBe(true);

		await coordinator.project({ forceReload: true, retirePersists: true });
		expect(coordinator.sourceRollbackFailed).toBe(true);
		sourceText = 'C';
		await coordinator.project({ forceReload: true, retirePersists: true });
		expect(coordinator.sourceRollbackFailed).toBe(false);
	});

	it('keeps duplicated projection authority out of both compatibility providers', () => {
		for (const fileName of ['kqlCompatEditorProvider.ts', 'sqlCompatEditorProvider.ts']) {
			const source = fs.readFileSync(path.join(process.cwd(), 'src', 'host', fileName), 'utf8');
			expect(source).toContain('projectionCoordinatorFactory');
			expect(source).toContain('projectionCoordinator.completeReload');
			expect(source).not.toContain('projectionCoordinator.admitPersist');
			for (const displaced of [
				'postDocumentGeneration',
				'activeSourceGeneration',
				'pendingSourceGeneration',
				'pendingProjectionEditRevision',
				'initialProjectionRecovery',
				'initialProjectionRestartRequested',
				'sourceReloadAuthority',
				'sourceRollbackFailedCandidate',
			]) {
				expect(source).not.toContain(displaced);
			}
		}
		const persistCoordinator = fs.readFileSync(path.join(
			process.cwd(), 'src', 'host', 'compatSidecarPersistCoordinator.ts',
		), 'utf8');
		expect(persistCoordinator).toContain('projection.admitPersist');
	});
});
