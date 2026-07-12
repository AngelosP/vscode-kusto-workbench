import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	awaitKustoSchemaPreparation,
	completeKustoSchemaPreparationDeadline,
	KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS,
	KustoSchemaPreparationTimeoutError,
	observeKustoSchemaPreparationTimeout,
	observeKustoSchemaPreparationOwnerTimeout,
	shouldStopKustoSchemaApplyAfterPendingFlush,
} from '../../src/webview/shared/kusto-schema-preparation-deadline.js';

describe('Kusto schema preparation deadline', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('rejects a preparation wait that does not settle before its deadline', async () => {
		vi.useFakeTimers();
		const result = awaitKustoSchemaPreparation(new Promise<boolean>(() => undefined));
		const rejection = expect(result).rejects.toBeInstanceOf(KustoSchemaPreparationTimeoutError);

		await vi.advanceTimersByTimeAsync(KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS);

		await rejection;
	});

	it('does not settle or cancel the serialized worker operation when the UI deadline expires', async () => {
		vi.useFakeTimers();
		let resolveWorker!: (value: boolean) => void;
		const workerOperation = new Promise<boolean>(resolve => { resolveWorker = resolve; });
		const queuedContinuation = vi.fn();
		const queue = workerOperation.then(queuedContinuation);
		const visibleWait = awaitKustoSchemaPreparation(workerOperation);
		const visibleRejection = expect(visibleWait).rejects.toBeInstanceOf(KustoSchemaPreparationTimeoutError);

		await vi.advanceTimersByTimeAsync(KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS);
		await visibleRejection;
		expect(queuedContinuation).not.toHaveBeenCalled();

		resolveWorker(true);
		await queue;
		expect(queuedContinuation).toHaveBeenCalledWith(true);
	});

	it('observes a timeout without owning or rejecting the worker operation', async () => {
		vi.useFakeTimers();
		let resolveWorker!: (value: number) => void;
		const workerOperation = new Promise<number>(resolve => { resolveWorker = resolve; });
		const onTimeout = vi.fn();
		observeKustoSchemaPreparationTimeout(workerOperation, onTimeout);

		await vi.advanceTimersByTimeAsync(KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS);
		expect(onTimeout).toHaveBeenCalledOnce();

		resolveWorker(3);
		await expect(workerOperation).resolves.toBe(3);
	});

	it('stops focused follow-up only after a terminal pending flush failure', () => {
		expect(shouldStopKustoSchemaApplyAfterPendingFlush(false, 'error')).toBe(true);
		expect(shouldStopKustoSchemaApplyAfterPendingFlush(false, 'preparing')).toBe(false);
		expect(shouldStopKustoSchemaApplyAfterPendingFlush(false, 'idle')).toBe(false);
		expect(shouldStopKustoSchemaApplyAfterPendingFlush(true, 'ready')).toBe(false);
	});

	it('shares one absolute budget across retries for the same preparation generation', async () => {
		vi.useFakeTimers();
		const owner = { boxId: 'query_retry_budget', generation: 7 };
		const firstAttempt = new Promise<boolean>(resolve => {
			setTimeout(() => resolve(false), KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS - 1);
		});
		const firstWait = awaitKustoSchemaPreparation(firstAttempt, owner);

		await vi.advanceTimersByTimeAsync(KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS - 1);
		await expect(firstWait).resolves.toBe(false);

		const retryWait = awaitKustoSchemaPreparation(new Promise<boolean>(() => undefined), owner);
		const retryRejection = expect(retryWait).rejects.toBeInstanceOf(KustoSchemaPreparationTimeoutError);
		await vi.advanceTimersByTimeAsync(1);
		await retryRejection;
	});

	it('starts a fresh budget for a new preparation generation in the same section', async () => {
		vi.useFakeTimers();
		const firstOwner = { boxId: 'query_new_generation', generation: 1 };
		const firstWait = awaitKustoSchemaPreparation(new Promise<boolean>(() => undefined), firstOwner);
		const firstRejection = expect(firstWait).rejects.toBeInstanceOf(KustoSchemaPreparationTimeoutError);
		await vi.advanceTimersByTimeAsync(KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS);
		await firstRejection;

		const nextOwner = { boxId: 'query_new_generation', generation: 2 };
		const nextWait = awaitKustoSchemaPreparation(new Promise<boolean>(() => undefined), nextOwner);
		let settled = false;
		void nextWait.catch(() => { settled = true; });
		await vi.advanceTimersByTimeAsync(KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS - 1);
		expect(settled).toBe(false);
		completeKustoSchemaPreparationDeadline(nextOwner);
	});

	it('terminalizes during retry backoff at the original owner deadline', async () => {
		vi.useFakeTimers();
		const owner = { boxId: 'query_retry_backoff', generation: 3 };
		const onTimeout = vi.fn();
		observeKustoSchemaPreparationOwnerTimeout(owner, onTimeout);
		const firstAttempt = awaitKustoSchemaPreparation(new Promise<boolean>(resolve => {
			setTimeout(() => resolve(false), KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS - 1);
		}), owner);

		await vi.advanceTimersByTimeAsync(KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS - 1);
		await expect(firstAttempt).resolves.toBe(false);
		expect(onTimeout).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(onTimeout).toHaveBeenCalledOnce();
		completeKustoSchemaPreparationDeadline(owner);
	});

	it('does not let an older stale generation replace a newer active budget', async () => {
		vi.useFakeTimers();
		const currentOwner = { boxId: 'query_generation_order', generation: 9 };
		const staleOwner = { boxId: 'query_generation_order', generation: 8 };
		const currentTimeout = vi.fn();
		observeKustoSchemaPreparationOwnerTimeout(currentOwner, currentTimeout);

		const staleWait = awaitKustoSchemaPreparation(new Promise<boolean>(() => undefined), staleOwner);
		const staleRejection = expect(staleWait).rejects.toBeInstanceOf(KustoSchemaPreparationTimeoutError);
		await vi.advanceTimersByTimeAsync(0);
		await staleRejection;
		expect(currentTimeout).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS);
		expect(currentTimeout).toHaveBeenCalledOnce();
		completeKustoSchemaPreparationDeadline(currentOwner);
	});
});