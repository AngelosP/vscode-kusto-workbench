export type KustoWorkerMutationKind =
	| 'primary-apply'
	| 'context-switch'
	| 'enhancement'
	| 'supplemental-apply'
	| 'identity-clear'
	| 'visibility-clear'
	| 'recovery';

export type KustoWorkerMutationSnapshot = Readonly<{
	primaryIntentGeneration: number;
	committedRevision: number;
	destructiveEpoch: number;
}>;

export type KustoWorkerMutationRequest = Readonly<{
	kind: KustoWorkerMutationKind;
	advancesPrimaryIntent?: boolean;
}>;

export type KustoWorkerMutationTransaction = Readonly<{
	id: number;
	kind: KustoWorkerMutationKind;
	primaryIntentGeneration: number;
	isActive(): boolean;
	commit(options?: { destructive?: boolean }): boolean;
	getSnapshot(): KustoWorkerMutationSnapshot;
}>;

export type KustoWorkerMutationLeaseResult<T> =
	| Readonly<{ status: 'completed'; value: T }>
	| Readonly<{ status: 'timed-out' }>;

export type KustoWorkerDetachedOutcome<T> =
	| Readonly<{ status: 'fulfilled'; value: T }>
	| Readonly<{ status: 'rejected'; error: unknown }>;

type TimerApi = Readonly<{
	setTimer(callback: () => void, delayMs: number): unknown;
	clearTimer(timer: unknown): void;
}>;

const defaultTimerApi: TimerApi = {
	setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

type InternalTransaction = {
	id: number;
	kind: KustoWorkerMutationKind;
	primaryIntentGeneration: number;
	active: boolean;
	commitsAllowed: boolean;
};

export class KustoWorkerMutationPort {
	private tail: Promise<void> = Promise.resolve();
	private transactionSequence = 0;
	private primaryIntentGeneration = 0;
	private committedRevision = 0;
	private destructiveEpoch = 0;
	private activeTransaction?: InternalTransaction;

	getSnapshot(): KustoWorkerMutationSnapshot {
		return Object.freeze({
			primaryIntentGeneration: this.primaryIntentGeneration,
			committedRevision: this.committedRevision,
			destructiveEpoch: this.destructiveEpoch,
		});
	}

	enqueue<T>(
		request: KustoWorkerMutationRequest,
		run: (transaction: KustoWorkerMutationTransaction) => T | PromiseLike<T>,
	): Promise<T> {
		const internal = this.createTransaction(request);
		const execute = async (): Promise<T> => {
			internal.active = true;
			this.activeTransaction = internal;
			try {
				return await run(this.publicTransaction(internal));
			} finally {
				internal.active = false;
				if (this.activeTransaction === internal) this.activeTransaction = undefined;
			}
		};
		const result = this.tail.then(execute, execute);
		this.tail = result.then(() => undefined, () => undefined);
		return result;
	}

	enqueueLeased<T>(args: {
		request: KustoWorkerMutationRequest;
		timeoutMs: number;
		run(transaction: KustoWorkerMutationTransaction): Promise<T>;
		onTimeout?(transaction: KustoWorkerMutationTransaction): void;
		onDetachedSettled?(
			transaction: KustoWorkerMutationTransaction,
			outcome: KustoWorkerDetachedOutcome<T>,
		): void | PromiseLike<void>;
		timerApi?: TimerApi;
	}): Promise<KustoWorkerMutationLeaseResult<T>> {
		let resolveLease!: (result: KustoWorkerMutationLeaseResult<T>) => void;
		let rejectLease!: (error: unknown) => void;
		const lease = new Promise<KustoWorkerMutationLeaseResult<T>>((resolve, reject) => {
			resolveLease = resolve;
			rejectLease = reject;
		});
		const queued = this.enqueue(args.request, async transaction => {
			const timerApi = args.timerApi ?? defaultTimerApi;
			let state: 'pending' | 'completed' | 'timed-out' = 'pending';
			const didTimeOut = () => state === 'timed-out';
			const timer = timerApi.setTimer(() => {
				if (state !== 'pending') return;
				state = 'timed-out';
				this.revokeTransaction(transaction);
				try { args.onTimeout?.(transaction); } catch { /* caller owns reporting */ }
				resolveLease(Object.freeze({ status: 'timed-out' }));
			}, Math.max(0, args.timeoutMs));
			let outcome: KustoWorkerDetachedOutcome<T>;
			try {
				const value = await args.run(transaction);
				outcome = Object.freeze({ status: 'fulfilled', value });
				if (state === 'pending') {
					state = 'completed';
					timerApi.clearTimer(timer);
					resolveLease(Object.freeze({ status: 'completed', value }));
				}
			} catch (error) {
				outcome = Object.freeze({ status: 'rejected', error });
				if (state === 'pending') {
					state = 'completed';
					timerApi.clearTimer(timer);
					rejectLease(error);
				}
			}
			if (didTimeOut() && args.onDetachedSettled) {
				await this.runInlineRecovery(args.onDetachedSettled, outcome);
			}
		});
		void queued.catch(() => undefined);
		return lease;
	}

	isPrimaryIntentCurrent(generation: number): boolean {
		return this.primaryIntentGeneration === generation;
	}

	private publicTransaction(internal: InternalTransaction): KustoWorkerMutationTransaction {
		return Object.freeze({
			id: internal.id,
			kind: internal.kind,
			primaryIntentGeneration: internal.primaryIntentGeneration,
			isActive: () => internal.active && internal.commitsAllowed && this.activeTransaction === internal,
			commit: options => {
				if (!internal.active || !internal.commitsAllowed || this.activeTransaction !== internal) return false;
				this.committedRevision += 1;
				if (options?.destructive) this.destructiveEpoch += 1;
				return true;
			},
			getSnapshot: () => this.getSnapshot(),
		});
	}

	private createTransaction(request: KustoWorkerMutationRequest): InternalTransaction {
		return {
			id: ++this.transactionSequence,
			kind: request.kind,
			primaryIntentGeneration: request.advancesPrimaryIntent
				? ++this.primaryIntentGeneration
				: this.primaryIntentGeneration,
			active: false,
			commitsAllowed: true,
		};
	}

	private revokeTransaction(transaction: KustoWorkerMutationTransaction): void {
		if (this.activeTransaction?.id === transaction.id) {
			this.activeTransaction.commitsAllowed = false;
		}
	}

	private async runInlineRecovery<T>(
		recover: (transaction: KustoWorkerMutationTransaction, outcome: KustoWorkerDetachedOutcome<T>) => void | PromiseLike<void>,
		outcome: KustoWorkerDetachedOutcome<T>,
	): Promise<void> {
		if (this.activeTransaction) {
			this.activeTransaction.active = false;
			this.activeTransaction.commitsAllowed = false;
		}
		const recovery = this.createTransaction({ kind: 'recovery', advancesPrimaryIntent: true });
		recovery.active = true;
		this.activeTransaction = recovery;
		try {
			await recover(this.publicTransaction(recovery), outcome);
		} finally {
			recovery.active = false;
			recovery.commitsAllowed = false;
			if (this.activeTransaction === recovery) this.activeTransaction = undefined;
		}
	}
}