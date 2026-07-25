export class SyntheticRequestTimeoutError extends Error {
	constructor(requestId: string, timeoutMs: number) {
		super(`Synthetic request ${requestId} timed out after ${timeoutMs}ms.`);
		this.name = 'SyntheticRequestTimeoutError';
	}
}

export class SyntheticRequestDisposedError extends Error {
	constructor(requestId: string, reason: string = 'Synthetic request broker disposed.') {
		super(`${reason} (${requestId})`);
		this.name = 'SyntheticRequestDisposedError';
	}
}

type TimerHandle = ReturnType<typeof setTimeout>;

type PendingRequest<TValue, TMetadata> = {
	readonly metadata: TMetadata;
	readonly reject: (reason?: unknown) => void;
	readonly resolve: (value: TValue) => void;
	readonly timer: TimerHandle;
};

export type SyntheticRequestBrokerOptions = Readonly<{
	timeoutMs?: number;
	tombstoneTtlMs?: number;
	maxActive?: number;
	maxTombstones?: number;
	now?: () => number;
	setTimer?: (callback: () => void, timeoutMs: number) => TimerHandle;
	clearTimer?: (handle: TimerHandle) => void;
}>;

export type SyntheticRequestSettlement<TMetadata> = Readonly<{
	kind: 'active' | 'tombstone' | 'unknown';
	metadata?: TMetadata;
}>;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_TOMBSTONE_TTL_MS = 60_000;
const DEFAULT_MAX_ACTIVE = 64;
const DEFAULT_MAX_TOMBSTONES = 256;

export class SyntheticRequestBroker<TValue, TMetadata = undefined> {
	private readonly pending = new Map<string, PendingRequest<TValue, TMetadata>>();
	private readonly tombstones = new Map<string, number>();
	private readonly timeoutMs: number;
	private readonly tombstoneTtlMs: number;
	private readonly maxActive: number;
	private readonly maxTombstones: number;
	private readonly now: () => number;
	private readonly setTimer: (callback: () => void, timeoutMs: number) => TimerHandle;
	private readonly clearTimer: (handle: TimerHandle) => void;

	constructor(options: SyntheticRequestBrokerOptions = {}) {
		this.timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		this.tombstoneTtlMs = Math.max(0, options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS);
		this.maxActive = Math.max(1, options.maxActive ?? DEFAULT_MAX_ACTIVE);
		this.maxTombstones = Math.max(1, options.maxTombstones ?? DEFAULT_MAX_TOMBSTONES);
		this.now = options.now ?? Date.now;
		this.setTimer = options.setTimer ?? ((callback, timeoutMs) => setTimeout(callback, timeoutMs));
		this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle));
	}

	begin(requestId: string, metadata: TMetadata): Promise<TValue> {
		const id = this.normalizeId(requestId);
		if (!id) return Promise.reject(new Error('Synthetic request ID is required.'));
		this.pruneTombstones();
		this.cancel(id, new SyntheticRequestDisposedError(id, 'Synthetic request replaced.'));
		while (this.pending.size >= this.maxActive) {
			const oldestId = this.pending.keys().next().value as string | undefined;
			if (!oldestId) break;
			this.cancel(oldestId, new SyntheticRequestDisposedError(oldestId, 'Synthetic request capacity exceeded.'));
		}
		this.tombstones.delete(id);
		return new Promise<TValue>((resolve, reject) => {
			const timer = this.setTimer(() => {
				const current = this.pending.get(id);
				if (!current) return;
				this.pending.delete(id);
				this.addTombstone(id);
				current.reject(new SyntheticRequestTimeoutError(id, this.timeoutMs));
			}, this.timeoutMs);
			this.pending.set(id, { metadata, reject, resolve, timer });
		});
	}

	isSynthetic(requestId: string): boolean {
		const id = this.normalizeId(requestId);
		if (!id) return false;
		this.pruneTombstones();
		return this.pending.has(id) || this.tombstones.has(id);
	}

	hasActive(requestId: string): boolean {
		return this.pending.has(this.normalizeId(requestId));
	}

	getMetadata(requestId: string): TMetadata | undefined {
		return this.pending.get(this.normalizeId(requestId))?.metadata;
	}

	resolve(requestId: string, value: TValue): SyntheticRequestSettlement<TMetadata> {
		return this.settle(requestId, pending => pending.resolve(value));
	}

	reject(requestId: string, reason: unknown): SyntheticRequestSettlement<TMetadata> {
		return this.settle(requestId, pending => pending.reject(reason));
	}

	cancel(requestId: string, reason: unknown = new SyntheticRequestDisposedError(requestId)): boolean {
		const id = this.normalizeId(requestId);
		const current = this.pending.get(id);
		if (!current) return false;
		this.pending.delete(id);
		this.clearTimer(current.timer);
		this.addTombstone(id);
		current.reject(reason);
		return true;
	}

	cancelWhere(predicate: (metadata: TMetadata, requestId: string) => boolean, reason: unknown): number {
		let canceled = 0;
		for (const [requestId, request] of Array.from(this.pending.entries())) {
			if (!predicate(request.metadata, requestId)) continue;
			if (this.cancel(requestId, reason)) canceled += 1;
		}
		return canceled;
	}

	dispose(reason: string = 'Synthetic request broker disposed.'): void {
		for (const id of Array.from(this.pending.keys())) {
			this.cancel(id, new SyntheticRequestDisposedError(id, reason));
		}
	}

	clearForTests(): void {
		for (const pending of this.pending.values()) this.clearTimer(pending.timer);
		this.pending.clear();
		this.tombstones.clear();
	}

	private settle(
		requestId: string,
		settler: (pending: PendingRequest<TValue, TMetadata>) => void,
	): SyntheticRequestSettlement<TMetadata> {
		const id = this.normalizeId(requestId);
		this.pruneTombstones();
		const current = this.pending.get(id);
		if (current) {
			this.pending.delete(id);
			this.clearTimer(current.timer);
			this.addTombstone(id);
			settler(current);
			return { kind: 'active', metadata: current.metadata };
		}
		return { kind: this.tombstones.has(id) ? 'tombstone' : 'unknown' };
	}

	private addTombstone(requestId: string): void {
		this.tombstones.delete(requestId);
		this.tombstones.set(requestId, this.now() + this.tombstoneTtlMs);
		while (this.tombstones.size > this.maxTombstones) {
			const oldestId = this.tombstones.keys().next().value as string | undefined;
			if (!oldestId) break;
			this.tombstones.delete(oldestId);
		}
	}

	private pruneTombstones(): void {
		const now = this.now();
		for (const [requestId, expiresAt] of this.tombstones) {
			if (expiresAt > now) continue;
			this.tombstones.delete(requestId);
		}
	}

	private normalizeId(value: unknown): string {
		return String(value || '').trim();
	}
}
