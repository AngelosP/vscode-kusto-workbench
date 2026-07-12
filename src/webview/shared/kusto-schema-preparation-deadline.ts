import { raceSupplementalOperationLease } from './supplemental-operation-lease.js';

export const KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS = 30_000;

export type KustoSchemaPreparationDeadlineOwner = Readonly<{
	boxId: string;
	generation: number;
}>;

export class KustoSchemaPreparationTimeoutError extends Error {
	constructor() {
		super('Kusto schema preparation timed out.');
		this.name = 'KustoSchemaPreparationTimeoutError';
	}
}

class KustoSchemaPreparationDeadlineTracker {
	private readonly deadlineByBoxId = new Map<string, {
		generation: number;
		deadlineAt: number;
		timer?: ReturnType<typeof setTimeout>;
		observers: Set<() => void>;
	}>();

	private getOrCreate(owner: KustoSchemaPreparationDeadlineOwner, now: number): {
		generation: number;
		deadlineAt: number;
		timer?: ReturnType<typeof setTimeout>;
		observers: Set<() => void>;
	} | undefined {
		const boxId = String(owner.boxId || '').trim();
		const generation = Number(owner.generation);
		if (!boxId || !Number.isFinite(generation)) return undefined;

		const current = this.deadlineByBoxId.get(boxId);
		if (current?.generation === generation) return current;
		if (current && generation < current.generation) return undefined;
		if (current?.timer) clearTimeout(current.timer);

		const next = {
			generation,
			deadlineAt: now + KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS,
			observers: new Set<() => void>(),
		};
		this.deadlineByBoxId.set(boxId, next);
		return next;
	}

	remainingMs(owner: KustoSchemaPreparationDeadlineOwner | undefined, now: number = Date.now()): number {
		if (!owner) return KUSTO_SCHEMA_PREPARATION_TIMEOUT_MS;
		const tracked = this.getOrCreate(owner, now);
		if (!tracked) return 0;
		return Math.max(0, tracked.deadlineAt - now);
	}

	observe(owner: KustoSchemaPreparationDeadlineOwner, onTimeout: () => void, now: number = Date.now()): void {
		const boxId = String(owner.boxId || '').trim();
		const tracked = this.getOrCreate(owner, now);
		if (!tracked) {
			queueMicrotask(onTimeout);
			return;
		}
		tracked.observers.add(onTimeout);
		if (tracked.timer) return;
		tracked.timer = setTimeout(() => {
			tracked.timer = undefined;
			for (const observer of Array.from(tracked.observers)) observer();
			tracked.observers.clear();
		}, Math.max(0, tracked.deadlineAt - now));
	}

	complete(owner: KustoSchemaPreparationDeadlineOwner): void {
		const boxId = String(owner.boxId || '').trim();
		const tracked = this.deadlineByBoxId.get(boxId);
		if (!tracked || tracked.generation !== owner.generation) return;
		if (tracked.timer) clearTimeout(tracked.timer);
		this.deadlineByBoxId.delete(boxId);
	}
}

const preparationDeadlines = new KustoSchemaPreparationDeadlineTracker();

export async function awaitKustoSchemaPreparation<T>(
	operation: Promise<T>,
	owner?: KustoSchemaPreparationDeadlineOwner,
): Promise<T> {
	const lease = await raceSupplementalOperationLease(operation, preparationDeadlines.remainingMs(owner));
	if (lease.status === 'timed-out') {
		throw new KustoSchemaPreparationTimeoutError();
	}
	return lease.value;
}

export function observeKustoSchemaPreparationTimeout<T>(
	operation: Promise<T>,
	onTimeout: () => void,
	owner?: KustoSchemaPreparationDeadlineOwner,
): void {
	void awaitKustoSchemaPreparation(operation, owner).catch((error: unknown) => {
		if (error instanceof KustoSchemaPreparationTimeoutError) onTimeout();
	});
}

export function shouldStopKustoSchemaApplyAfterPendingFlush(applied: boolean, preparationStatus: string): boolean {
	return !applied && preparationStatus === 'error';
}

export function observeKustoSchemaPreparationOwnerTimeout(
	owner: KustoSchemaPreparationDeadlineOwner,
	onTimeout: () => void,
): void {
	preparationDeadlines.observe(owner, onTimeout);
}

export function completeKustoSchemaPreparationDeadline(owner: KustoSchemaPreparationDeadlineOwner): void {
	preparationDeadlines.complete(owner);
}