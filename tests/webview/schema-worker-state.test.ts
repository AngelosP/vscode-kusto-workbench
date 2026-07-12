import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	beginKustoPreparation,
	disposeKustoPreparation,
	discardStalePendingSchemaWorkerUpdate,
	getKustoPreparationState,
	getKustoPreparationToken,
	isSchemaWorkerReady,
	isKustoPreparationCurrent,
	isSchemaEnhancementFailed,
	isSchemaEnhancementPending,
	isSchemaEnhancementReady,
	markSchemaEnhancementFailed,
	markSchemaEnhancementCanceled,
	markSchemaEnhancementPending,
	markSchemaEnhancementReady,
	markSchemaWorkerApplyFailed,
	markSchemaWorkerApplyPending,
	markSchemaWorkerReady,
	failKustoPreparation,
	isSchemaWorkerApplyRequired,
	requireSchemaWorkerApply,
	registerKustoSchemaApplyRequester,
	requestKustoSchemaApplyForBox,
	pendingSchemaWorkerUpdateByBoxId,
	reviseKustoPreparation,
	schemaEnhancementReadyByBoxId,
	schemaWorkerReadyByBoxId,
	subscribeKustoPreparation,
	updateKustoPreparation,
	waitForSchemaWorkerReady,
} from '../../src/webview/core/state';
import {
	KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS,
} from '../../src/webview/shared/kusto-schema-preparation-deadline.js';

describe('schema worker readiness state', () => {
	beforeEach(() => {
		for (const key of Object.keys(schemaWorkerReadyByBoxId)) {
			delete schemaWorkerReadyByBoxId[key];
		}
		for (const key of Object.keys(schemaEnhancementReadyByBoxId)) {
			delete schemaEnhancementReadyByBoxId[key];
		}
	});

	it('matches schema readiness by model URI when provided', () => {
		markSchemaWorkerReady('query_1', 'cluster|db', 'sig-1', 'inmemory://model/old');

		expect(isSchemaWorkerReady('query_1', 'cluster|db')).toBe(true);
		expect(isSchemaWorkerReady('query_1', 'cluster|db', 'inmemory://model/old')).toBe(true);
		expect(isSchemaWorkerReady('query_1', 'cluster|db', 'inmemory://model/new')).toBe(false);
	});

	it('waits for the matching model URI instead of resolving from stale ready state', async () => {
		const waiting = waitForSchemaWorkerReady('query_1', 'cluster|db', 1000, 'inmemory://model/new');
		markSchemaWorkerReady('query_1', 'cluster|db', 'sig-1', 'inmemory://model/old');
		markSchemaWorkerReady('query_1', 'cluster|db', 'sig-1', 'inmemory://model/new');

		await expect(waiting).resolves.toBe(true);
	});

	it('does not resolve a model-specific waiter from a stale failure on another model', async () => {
		const waiting = waitForSchemaWorkerReady('query_1', 'cluster|db', 1000, 'inmemory://model/new');
		markSchemaWorkerApplyFailed('query_1', 'cluster|db', 'inmemory://model/old');
		markSchemaWorkerReady('query_1', 'cluster|db', 'sig-1', 'inmemory://model/new');

		await expect(waiting).resolves.toBe(true);
	});

	it('ignores stale preparation revisions and settles blockers only for the current delivery', () => {
		const first = beginKustoPreparation('query_1', {
			stage: 'schema',
			blockers: ['schema', 'worker', 'enhancement'],
			target: { connectionId: 'c1', database: 'Db1' },
		})!;
		const second = reviseKustoPreparation(first, {
			removeBlockers: ['schema'],
			target: { schemaKey: 'cluster|db1', schemaSignature: 'sig-1', modelUri: 'inmemory://model/1' },
		})!;

		expect(isKustoPreparationCurrent(first)).toBe(false);
		expect(updateKustoPreparation(first, { removeBlockers: ['worker', 'enhancement'] })).toBe(false);
		expect(updateKustoPreparation(second, { removeBlockers: ['worker'] })).toBe(true);
		expect(getKustoPreparationState('query_1')).toMatchObject({
			status: 'preparing',
			stage: 'enhancing',
			blockers: ['enhancement'],
		});
		expect(updateKustoPreparation(second, { removeBlockers: ['enhancement'] })).toBe(true);
		expect(getKustoPreparationState('query_1')).toMatchObject({ status: 'ready', stage: 'ready', blockers: [] });
	});

	it('keeps removal tombstones monotonic so old same-id work cannot revive a section', () => {
		const oldToken = beginKustoPreparation('query_reused', { stage: 'schema', blockers: ['schema'] })!;
		disposeKustoPreparation('query_reused');
		const recreated = beginKustoPreparation('query_reused', { stage: 'schema', blockers: ['schema'] })!;

		expect(recreated.generation).toBeGreaterThan(oldToken.generation);
		expect(updateKustoPreparation(oldToken, { removeBlockers: ['schema'] })).toBe(false);
		expect(getKustoPreparationState('query_reused').status).toBe('preparing');
	});

	it('publishes immutable preparation snapshots to subscribers', () => {
		const statuses: string[] = [];
		const unsubscribe = subscribeKustoPreparation('query_subscribed', state => statuses.push(`${state.status}:${state.stage}`));
		const token = beginKustoPreparation('query_subscribed', { stage: 'schema', blockers: ['schema'] })!;
		updateKustoPreparation(token, { removeBlockers: ['schema'] });
		unsubscribe();

		expect(statuses).toEqual(['idle:idle', 'preparing:schema', 'ready:ready']);
		expect(Object.isFrozen(getKustoPreparationState('query_subscribed'))).toBe(true);
	});

	it('ties worker facts to the matching preparation transaction', () => {
		const token = beginKustoPreparation('query_worker', {
			stage: 'waiting-worker',
			blockers: ['worker'],
			target: { schemaKey: 'cluster|db', schemaSignature: 'sig-1', modelUri: 'inmemory://model/1' },
		})!;
		markSchemaWorkerApplyPending('query_worker', 'cluster|db', 'sig-1', 'inmemory://model/1', token);
		markSchemaWorkerReady('query_worker', 'cluster|db', 'sig-1', 'inmemory://model/1', token);

		expect(getKustoPreparationState('query_worker').status).toBe('ready');
		expect(isSchemaWorkerReady('query_worker', 'cluster|db', 'inmemory://model/1')).toBe(true);
	});

	it('clears schema and worker blockers when an already-loaded schema is adopted by the exact model', () => {
		const token = beginKustoPreparation('query_adopted', {
			stage: 'schema',
			blockers: ['schema', 'worker'],
			target: { schemaKey: 'cluster|db', modelUri: 'inmemory://model/1' },
		})!;

		markSchemaWorkerReady('query_adopted', 'cluster|db', undefined, 'inmemory://model/1', token);

		expect(getKustoPreparationState('query_adopted')).toMatchObject({ status: 'ready', stage: 'ready', blockers: [] });
	});

	it('ends preparation when the exact base worker is ready while enhancement continues', () => {
		const token = beginKustoPreparation('query_enhancement', {
			stage: 'waiting-worker',
			blockers: ['worker', 'enhancement'],
			target: { schemaKey: 'cluster|db', schemaSignature: 'sig-1', modelUri: 'inmemory://model/1' },
		})!;
		markSchemaEnhancementPending('query_enhancement', 'cluster|db', 'sig-1', 'inmemory://model/1', token);
		markSchemaWorkerReady('query_enhancement', 'cluster|db', 'sig-1', 'inmemory://model/1', token);

		expect(isSchemaEnhancementPending('query_enhancement', 'cluster|db', 'sig-1', 'inmemory://model/1')).toBe(true);
		expect(getKustoPreparationState('query_enhancement')).toMatchObject({ status: 'ready', stage: 'ready', blockers: [] });

		markSchemaEnhancementReady('query_enhancement', 'cluster|db', 'sig-1', 'inmemory://model/1', token);
		expect(isSchemaEnhancementReady('query_enhancement', 'cluster|db', 'sig-1', 'inmemory://model/1')).toBe(true);
		expect(getKustoPreparationState('query_enhancement').status).toBe('ready');
	});

	it('keeps reusable worker readiness when background enhancement fails', () => {
		const token = beginKustoPreparation('query_enhancement_error', {
			stage: 'enhancing',
			blockers: ['enhancement'],
			target: { schemaKey: 'cluster|db', schemaSignature: 'sig-1', modelUri: 'inmemory://model/1' },
		})!;
		markSchemaWorkerReady('query_enhancement_error', 'cluster|db', 'sig-1', 'inmemory://model/1');
		markSchemaEnhancementFailed('query_enhancement_error', 'cluster|db', 'sig-1', 'inmemory://model/1', token);

		expect(isSchemaEnhancementFailed('query_enhancement_error', 'cluster|db', 'sig-1', 'inmemory://model/1')).toBe(true);
		expect(isSchemaWorkerReady('query_enhancement_error', 'cluster|db', 'inmemory://model/1')).toBe(true);
		expect(getKustoPreparationState('query_enhancement_error')).toMatchObject({ status: 'ready', stage: 'ready', blockers: [] });
	});

	it('terminalizes a secondary restore owner and rejects late readiness after its deadline', async () => {
		vi.useFakeTimers();
		try {
			const boxId = 'query_secondary_restore';
			const schemaKey = 'cluster|db';
			const schemaSignature = 'sig-1';
			const modelUri = 'inmemory://model/secondary';
			const token = beginKustoPreparation(boxId, {
				stage: 'ready',
				blockers: [],
				target: { schemaKey, schemaSignature, modelUri },
			})!;
			markSchemaWorkerReady(boxId, schemaKey, schemaSignature, modelUri, token);
			markSchemaWorkerApplyPending(boxId, schemaKey, schemaSignature, modelUri, token);
			let resolveRestore!: (value: number) => void;
			const restoreOperation = new Promise<number>(resolve => { resolveRestore = resolve; });
			await vi.advanceTimersByTimeAsync(KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS);
			expect(getKustoPreparationState(boxId)).toMatchObject({ status: 'error', stage: 'error', blockers: [] });

			resolveRestore(1);
			await restoreOperation;
			markSchemaWorkerReady(boxId, schemaKey, schemaSignature, modelUri, token);
			expect(getKustoPreparationState(boxId)).toMatchObject({ status: 'error', stage: 'error', blockers: [] });
			expect(isSchemaWorkerReady(boxId, schemaKey, modelUri)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('gives an aged ready section a fresh worker-preparation episode', async () => {
		vi.useFakeTimers();
		try {
			const boxId = 'query_aged_ready';
			const schemaKey = 'cluster|db';
			const schemaSignature = 'sig-1';
			const modelUri = 'inmemory://model/aged';
			const token = beginKustoPreparation(boxId, {
				stage: 'waiting-worker',
				blockers: ['worker'],
				target: { schemaKey, schemaSignature, modelUri },
			})!;
			markSchemaWorkerApplyPending(boxId, schemaKey, schemaSignature, modelUri, token);
			markSchemaWorkerReady(boxId, schemaKey, schemaSignature, modelUri, token);
			await vi.advanceTimersByTimeAsync(KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS + 5_000);

			markSchemaWorkerApplyPending(boxId, schemaKey, schemaSignature, modelUri, token);
			await vi.advanceTimersByTimeAsync(KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS - 1);
			expect(getKustoPreparationState(boxId)).toMatchObject({ status: 'preparing', blockers: ['worker'] });

			await vi.advanceTimersByTimeAsync(1);
			expect(getKustoPreparationState(boxId)).toMatchObject({ status: 'error', stage: 'error', blockers: [] });
		} finally {
			vi.useRealTimers();
		}
	});

	it('settles a canceled background enhancement without changing readiness', () => {
		const token = beginKustoPreparation('query_enhancement_canceled', {
			stage: 'waiting-worker',
			blockers: ['worker'],
			target: { schemaKey: 'cluster|db', schemaSignature: 'sig-1', modelUri: 'inmemory://model/1' },
		})!;
		markSchemaEnhancementPending('query_enhancement_canceled', 'cluster|db', 'sig-1', 'inmemory://model/1', token);
		markSchemaWorkerReady('query_enhancement_canceled', 'cluster|db', 'sig-1', 'inmemory://model/1', token);
		markSchemaEnhancementCanceled('query_enhancement_canceled', 'cluster|db', 'sig-1', 'inmemory://model/1', token);

		expect(isSchemaEnhancementFailed('query_enhancement_canceled', 'cluster|db', 'sig-1', 'inmemory://model/1')).toBe(true);
		expect(getKustoPreparationState('query_enhancement_canceled')).toMatchObject({ status: 'ready', stage: 'ready', blockers: [] });
	});

	it('settles exact canceled enhancement state after its preparation token is superseded', () => {
		const token = beginKustoPreparation('query_enhancement_superseded', {
			stage: 'waiting-worker',
			blockers: ['worker'],
			target: { schemaKey: 'cluster|db', schemaSignature: 'sig-1', modelUri: 'inmemory://model/1' },
		})!;
		markSchemaEnhancementPending('query_enhancement_superseded', 'cluster|db', 'sig-1', 'inmemory://model/1', token);
		beginKustoPreparation('query_enhancement_superseded', {
			stage: 'schema',
			blockers: ['schema'],
			target: { schemaKey: 'cluster|other', schemaSignature: 'sig-2', modelUri: 'inmemory://model/1' },
		});

		markSchemaEnhancementCanceled('query_enhancement_superseded', 'cluster|db', 'sig-1', 'inmemory://model/1', token);

		expect(isSchemaEnhancementFailed('query_enhancement_superseded', 'cluster|db', 'sig-1', 'inmemory://model/1')).toBe(true);
	});

	it('keeps an error terminal when old worker and enhancement callbacks finish late', () => {
		const token = beginKustoPreparation('query_terminal_error', {
			stage: 'waiting-worker',
			blockers: ['worker', 'enhancement'],
			target: { schemaKey: 'cluster|db', schemaSignature: 'sig-1', modelUri: 'inmemory://model/1' },
		})!;

		markSchemaWorkerApplyFailed('query_terminal_error', 'cluster|db', 'inmemory://model/1', token);
		const failed = getKustoPreparationState('query_terminal_error');
		expect(failed).toMatchObject({ status: 'error', stage: 'error', blockers: [] });
		expect(failed.revision).toBeGreaterThan(token.revision);

		markSchemaWorkerReady('query_terminal_error', 'cluster|db', 'sig-1', 'inmemory://model/1', token);
		markSchemaEnhancementReady('query_terminal_error', 'cluster|db', 'sig-1', 'inmemory://model/1', token);

		expect(getKustoPreparationState('query_terminal_error')).toEqual(failed);
		expect(isSchemaWorkerReady('query_terminal_error', 'cluster|db', 'inmemory://model/1')).toBe(false);
	});

	it('ignores a delayed failure from an older signature on the same model', () => {
		const oldToken = beginKustoPreparation('query_superseded_failure', {
			stage: 'waiting-worker',
			blockers: ['worker', 'enhancement'],
			target: { schemaKey: 'cluster|db', schemaSignature: 'sig-old', modelUri: 'inmemory://model/1' },
		})!;
		const newToken = beginKustoPreparation('query_superseded_failure', {
			stage: 'waiting-worker',
			blockers: ['worker', 'enhancement'],
			target: { schemaKey: 'cluster|db', schemaSignature: 'sig-new', modelUri: 'inmemory://model/1' },
		})!;

		markSchemaWorkerApplyFailed('query_superseded_failure', 'cluster|db', 'inmemory://model/1', oldToken);

		expect(isKustoPreparationCurrent(newToken, { schemaKey: 'cluster|db', schemaSignature: 'sig-new', modelUri: 'inmemory://model/1' })).toBe(true);
		expect(getKustoPreparationState('query_superseded_failure')).toMatchObject({
			status: 'preparing',
			blockers: ['worker', 'enhancement'],
			target: { schemaSignature: 'sig-new' },
		});
		expect(schemaWorkerReadyByBoxId.query_superseded_failure).toBeUndefined();
	});

	it('does not let a late fallback refresh erase a terminal worker error', () => {
		const token = beginKustoPreparation('query_late_fallback', {
			stage: 'refreshing',
			blockers: ['refresh', 'worker'],
			target: { schemaKey: 'cluster|db', schemaSignature: 'sig-1', modelUri: 'inmemory://model/1' },
			usableFallback: true,
		})!;
		markSchemaWorkerApplyFailed('query_late_fallback', 'cluster|db', 'inmemory://model/1', token);
		const currentToken = getKustoPreparationToken('query_late_fallback');

		expect(failKustoPreparation(currentToken, 'Background schema refresh failed.', true)).toBe(true);
		expect(getKustoPreparationState('query_late_fallback')).toMatchObject({
			status: 'error',
			stage: 'error',
			usableFallback: true,
		});
	});

	it('keeps a mandatory worker apply latched until successful worker readiness', () => {
		requireSchemaWorkerApply('query_reapply');
		expect(isSchemaWorkerApplyRequired('query_reapply')).toBe(true);

		markSchemaWorkerReady('query_reapply', 'cluster|db', 'sig-1', 'inmemory://model/1');
		expect(isSchemaWorkerApplyRequired('query_reapply')).toBe(false);
	});

	it('deletes a deferred schema record when its preparation token is stale', () => {
		const token = beginKustoPreparation('query_pending', {
			stage: 'waiting-worker',
			blockers: ['worker'],
			target: { schemaKey: 'cluster|db', schemaSignature: 'sig-1' },
		})!;
		pendingSchemaWorkerUpdateByBoxId.query_pending = {
			rawSchemaJson: {},
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Db',
			schemaKey: 'cluster|db',
			schemaSignature: 'sig-1',
			preparationToken: token,
		};
		beginKustoPreparation('query_pending', { stage: 'schema', blockers: ['schema'] });

		expect(discardStalePendingSchemaWorkerUpdate('query_pending')).toBe(true);
		expect(pendingSchemaWorkerUpdateByBoxId.query_pending).toBeUndefined();
	});

	it('routes controller schema apply requests to Monaco without a window bridge', () => {
		const requester = vi.fn(() => true);
		const dispose = registerKustoSchemaApplyRequester(requester);

		expect(requestKustoSchemaApplyForBox('query_1', false)).toBe(true);
		expect(requester).toHaveBeenCalledWith('query_1', false);
		dispose();
	});

	it('drains the latest queued schema apply when Monaco registers later', () => {
		const unavailable = vi.fn(() => false);
		const disposeUnavailable = registerKustoSchemaApplyRequester(unavailable);
		expect(requestKustoSchemaApplyForBox('query_delayed', false)).toBe(true);
		expect(requestKustoSchemaApplyForBox('query_delayed', true)).toBe(true);
		disposeUnavailable();

		const ready = vi.fn(() => true);
		const disposeReady = registerKustoSchemaApplyRequester(ready);
		expect(ready).toHaveBeenCalledWith('query_delayed', true);
		disposeReady();
	});

	it('does not drain a removed section apply into a recreated section with the same id', () => {
		const unavailable = vi.fn(() => false);
		const disposeUnavailable = registerKustoSchemaApplyRequester(unavailable);
		beginKustoPreparation('query_recreated', { stage: 'schema', blockers: ['schema'] });
		requestKustoSchemaApplyForBox('query_recreated');
		disposeKustoPreparation('query_recreated');
		disposeUnavailable();

		const ready = vi.fn(() => true);
		const disposeReady = registerKustoSchemaApplyRequester(ready);

		expect(ready).not.toHaveBeenCalledWith('query_recreated', expect.anything());
		disposeReady();
	});
});
