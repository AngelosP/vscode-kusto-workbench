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

	it('bounds and coalesces initial recovery with one requested follow-up', async () => {
		const session = new CompatSidecarSession(true, 'KQL');
		let attempts = 0;
		const firstAttempt = Promise.withResolvers<void>();
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => 'source',
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
		const coalesced = coordinator.ensureInitialProjection('coalesced-request');
		firstAttempt.resolve();
		expect(await first).toBe(false);
		expect(await coalesced).toBe(false);
		await waitFor(() => attempts === 4);
		expect(coordinator.isInitialized).toBe(false);
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
