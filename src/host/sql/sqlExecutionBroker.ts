import type { QueryRunCoordinator } from '../queryRunCoordinator';

export type SqlExecutionAdmission = Readonly<{
	boxId: string;
	generation: number;
	executionId: string;
	ownerToken?: string;
}>;

export type SqlExecutionPreflight = Readonly<{
	boxId: string;
	generation: number;
	executionId: string;
	ownerToken?: string;
}>;

export type SqlCancelableExecution = {
	cancel: () => void;
	promise?: PromiseLike<unknown>;
};

export type SqlExecutionLease<T extends SqlCancelableExecution> = Readonly<{
	execution: T;
	executionId: string;
	runSeq: number;
	isCurrent: () => boolean;
	cancel: () => void;
	release: () => void;
}>;

export interface SqlExecutionBrokerOptions {
	queryRuns: QueryRunCoordinator;
	getOwnerToken: (boxId: string) => string | undefined;
	postMessage: (message: unknown) => boolean | PromiseLike<boolean>;
}

type PendingAdmission = Readonly<{
	generation: number;
	executionId: string;
	ownerToken?: string;
}>;

export class SqlExecutionBroker {
	private readonly admissionGenerationByBoxId = new Map<string, number>();
	private readonly pendingAdmissionByBoxId = new Map<string, PendingAdmission>();
	private readonly preflightGenerationByBoxId = new Map<string, number>();
	private readonly pendingPreflightByBoxId = new Map<string, PendingAdmission>();

	constructor(private readonly options: SqlExecutionBrokerOptions) {}

	reservePreflight(boxId: string, executionId: string, ownerToken?: string): SqlExecutionPreflight {
		const id = String(boxId || '').trim();
		const correlationId = String(executionId || '').trim();
		if (!id) throw new Error('SQL execution box ID is required.');
		this.retirePreflight(id, true);
		const generation = (this.preflightGenerationByBoxId.get(id) ?? 0) + 1;
		this.preflightGenerationByBoxId.set(id, generation);
		this.pendingPreflightByBoxId.set(id, {
			generation,
			executionId: correlationId,
			...(ownerToken ? { ownerToken } : {}),
		});
		return Object.freeze({
			boxId: id,
			generation,
			executionId: correlationId,
			...(ownerToken ? { ownerToken } : {}),
		});
	}

	isPreflightCurrent(preflight: SqlExecutionPreflight): boolean {
		const pending = this.pendingPreflightByBoxId.get(preflight.boxId);
		return this.preflightGenerationByBoxId.get(preflight.boxId) === preflight.generation
			&& pending?.generation === preflight.generation
			&& pending.executionId === preflight.executionId;
	}

	clearPreflight(preflight: SqlExecutionPreflight): boolean {
		if (!this.isPreflightCurrent(preflight)) return false;
		this.pendingPreflightByBoxId.delete(preflight.boxId);
		return true;
	}

	promotePreflight(preflight: SqlExecutionPreflight): SqlExecutionAdmission | undefined {
		if (!this.clearPreflight(preflight)) return undefined;
		return this.reservePending(preflight.boxId, preflight.executionId, preflight.ownerToken);
	}

	reservePending(boxId: string, executionId: string, ownerToken?: string): SqlExecutionAdmission {
		const id = String(boxId || '').trim();
		const correlationId = String(executionId || '').trim();
		if (!id) throw new Error('SQL execution box ID is required.');

		const effectiveOwnerToken = ownerToken || this.options.getOwnerToken(id);
		this.retirePending(id, true);
		const generation = this.nextAdmissionGeneration(id);
		this.pendingAdmissionByBoxId.set(id, {
			generation,
			executionId: correlationId,
			...(effectiveOwnerToken ? { ownerToken: effectiveOwnerToken } : {}),
		});
		const previous = this.options.queryRuns.get(id);
		this.cancelRunning(id, { notifyWebview: !!previous?.executionId });
		return Object.freeze({
			boxId: id,
			generation,
			executionId: correlationId,
			...(effectiveOwnerToken ? { ownerToken: effectiveOwnerToken } : {}),
		});
	}

	reserve(boxId: string, executionId: string): SqlExecutionAdmission {
		const id = String(boxId || '').trim();
		const correlationId = String(executionId || '').trim();
		if (!id || !correlationId) throw new Error('SQL execution identity is required.');
		const generation = this.supersede(id, { notifyWebview: true });
		const ownerToken = this.options.getOwnerToken(id);
		this.pendingAdmissionByBoxId.set(id, {
			generation,
			executionId: correlationId,
			...(ownerToken ? { ownerToken } : {}),
		});
		return Object.freeze({ boxId: id, generation, executionId: correlationId, ...(ownerToken ? { ownerToken } : {}) });
	}

	supersede(boxId: string, options?: { notifyWebview?: boolean }): number {
		const id = String(boxId || '').trim();
		if (!id) return 0;
		this.retirePreflight(id, options?.notifyWebview === true);
		const generation = this.nextAdmissionGeneration(id);
		const retiredPending = this.retirePending(id, options?.notifyWebview === true);
		this.cancelRunning(id, {
			notifyWebview: retiredPending ? false : options?.notifyWebview === true,
		});
		return generation;
	}

	isAdmissionCurrent(admission: SqlExecutionAdmission): boolean {
		return this.admissionGenerationByBoxId.get(admission.boxId) === admission.generation;
	}

	isPendingCurrent(admission: SqlExecutionAdmission): boolean {
		if (!this.isAdmissionCurrent(admission)) return false;
		const pending = this.pendingAdmissionByBoxId.get(admission.boxId);
		return pending?.generation === admission.generation
			&& pending.executionId === admission.executionId;
	}

	clearPending(admission: SqlExecutionAdmission): boolean {
		if (!this.isPendingCurrent(admission)) return false;
		this.pendingAdmissionByBoxId.delete(admission.boxId);
		return true;
	}

	start<T extends SqlCancelableExecution>(
		admission: SqlExecutionAdmission,
		start: () => T,
	): SqlExecutionLease<T> {
		if (!this.clearPending(admission)) throw new Error('SQL Copilot write-query canceled');
		let execution: T;
		try {
			execution = start();
		} catch (error) { throw error; }
		if (!this.isAdmissionCurrent(admission)) {
			if (execution.promise) void Promise.resolve(execution.promise).catch(() => undefined);
			try { execution.cancel(); } catch { /* exact cancellation is best effort */ }
			throw new Error('SQL Copilot write-query canceled');
		}
		const runSeq = this.options.queryRuns.nextSequence();
		this.options.queryRuns.register(admission.boxId, {
			cancel: execution.cancel,
			runSeq,
			executionId: admission.executionId || undefined,
		});
		let released = false;
		return Object.freeze({
			execution,
			executionId: admission.executionId,
			runSeq,
			isCurrent: () => this.isLeaseCurrent(admission, execution.cancel, runSeq),
			cancel: () => {
				if (!this.isLeaseCurrent(admission, execution.cancel, runSeq)) return;
				this.cancelRunning(admission.boxId);
			},
			release: () => {
				if (released) return;
				released = true;
				this.options.queryRuns.unregister(admission.boxId, execution.cancel, runSeq);
			},
		});
	}

	isLeaseCurrent(admission: SqlExecutionAdmission, cancel: () => void, runSeq: number): boolean {
		return this.isAdmissionCurrent(admission)
			&& this.options.queryRuns.isCurrent(admission.boxId, cancel, runSeq);
	}

	cancelExpected(boxId: string, executionId?: string, notifyWebview = true): boolean {
		const id = String(boxId || '').trim();
		if (!id) return false;
		const expectedExecutionId = String(executionId || '').trim();
		if (expectedExecutionId) {
			const preflightExecutionId = this.pendingPreflightByBoxId.get(id)?.executionId;
			const pendingExecutionId = this.pendingAdmissionByBoxId.get(id)?.executionId;
			const runningExecutionId = this.options.queryRuns.get(id)?.executionId;
			if (expectedExecutionId === preflightExecutionId) {
				return this.retirePreflight(id, notifyWebview);
			}
			if (expectedExecutionId === pendingExecutionId) {
				const retired = this.retirePending(id, notifyWebview);
				if (retired) this.nextAdmissionGeneration(id);
				return retired;
			}
			if (expectedExecutionId === runningExecutionId) {
				this.nextAdmissionGeneration(id);
				void this.cancelRunning(id, { notifyWebview });
				return true;
			}
			return false;
		}
		this.retirePreflight(id, notifyWebview);
		this.supersede(id, { notifyWebview });
		return true;
	}

	cancelRunning(boxId: string, options?: { notifyWebview?: boolean }): Promise<boolean> | undefined {
		const id = String(boxId || '').trim();
		if (!id) return undefined;
		const ownerToken = this.options.getOwnerToken(id);
		const running = this.options.queryRuns.get(id);
		if (!running) return undefined;
		this.options.queryRuns.cancel(id);
		if (!options?.notifyWebview || !running.executionId) return undefined;
		return this.postCancellation(id, running.executionId, ownerToken);
	}

	clear(): void {
		this.admissionGenerationByBoxId.clear();
		this.pendingAdmissionByBoxId.clear();
		this.preflightGenerationByBoxId.clear();
		this.pendingPreflightByBoxId.clear();
	}

	clearBox(boxId: string): void {
		const id = String(boxId || '').trim();
		if (!id) return;
		this.admissionGenerationByBoxId.set(id, (this.admissionGenerationByBoxId.get(id) ?? 0) + 1);
		this.pendingAdmissionByBoxId.delete(id);
		this.preflightGenerationByBoxId.set(id, (this.preflightGenerationByBoxId.get(id) ?? 0) + 1);
		this.pendingPreflightByBoxId.delete(id);
	}

	private nextAdmissionGeneration(boxId: string): number {
		const generation = (this.admissionGenerationByBoxId.get(boxId) ?? 0) + 1;
		this.admissionGenerationByBoxId.set(boxId, generation);
		return generation;
	}

	private retirePending(boxId: string, notifyWebview: boolean): boolean {
		const pending = this.pendingAdmissionByBoxId.get(boxId);
		if (!pending) return false;
		this.pendingAdmissionByBoxId.delete(boxId);
		if (notifyWebview) void this.postCancellation(boxId, pending.executionId, pending.ownerToken);
		return true;
	}

	private retirePreflight(boxId: string, notifyWebview: boolean): boolean {
		const pending = this.pendingPreflightByBoxId.get(boxId);
		if (!pending) return false;
		this.pendingPreflightByBoxId.delete(boxId);
		if (notifyWebview && pending.executionId) {
			void this.postCancellation(boxId, pending.executionId, pending.ownerToken);
		}
		return true;
	}

	private postCancellation(boxId: string, executionId: string, ownerToken?: string): Promise<boolean> {
		try {
			return Promise.resolve(this.options.postMessage({
				type: 'queryCancelled', boxId,
				...(ownerToken ? { ownerToken } : {}),
				executionId,
			})).then(delivered => delivered === true, () => false);
		} catch {
			return Promise.resolve(false);
		}
	}
}