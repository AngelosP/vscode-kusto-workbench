export type CompatPersistOutcome = Readonly<{ ok: boolean; error?: Error }>;

export type CompatUpgradeLease = Readonly<{
	revision: number;
	finish: () => void;
}>;

export type CompatPersistAdmissionLease = Readonly<{
	waitForTurn: () => Promise<void>;
	queue: <T>(work: (isCurrent: () => boolean) => Promise<T>) => Promise<T>;
	settle: () => void;
}>;

type PendingFinalPersist = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
	claimed?: boolean;
	background?: boolean;
	timedOut?: boolean;
};

type PersistPoster = (
	message: unknown, signal?: AbortSignal, isCurrent?: () => boolean,
) => boolean | PromiseLike<boolean>;

type BackgroundPersist = {
	requestId: string;
	result: Promise<unknown>;
	pending: PendingFinalPersist;
	controller: AbortController;
	runtimeId: string;
	retired: boolean;
	promoted: boolean;
	reported: boolean;
};

type PendingReload = {
	resolve: (applied: boolean) => void;
	timer: ReturnType<typeof setTimeout>;
	arrivalDeadline?: number;
	absoluteCommitDeadline?: number;
	claimed?: boolean;
};

export type CompatReloadReservationOptions = Readonly<{ absoluteCommitDeadline: number }>;

export class CompatSidecarSession {
	private dirty = false;
	private draftBaseText: string | undefined;
	private draftGeneration = 0;
	private persistSequence = 0;
	private persistEpoch = 0;
	private readonly latestPersistSequenceByEpoch = new Map<number, { sequence: number; revision: number }>();
	private pendingPersistAdmissionCount = 0;
	private persistOperationTail: Promise<void> = Promise.resolve();
	private persistTail: Promise<void> = Promise.resolve();
	private upgradeTail: Promise<void> = Promise.resolve();
	private pendingUpgradeCount = 0;
	private closing = false;
	private editRevision = 0;
	private stateEditRevision = 0;
	private finalPersistTail: Promise<void> = Promise.resolve();
	private finalPersistReservations = 0;
	private backgroundPersist?: BackgroundPersist;
	private backgroundRequest?: { post: PersistPoster; report: (error: Error) => void; runtimeId: string };
	private backgroundFollowUp = false;
	private backgroundFrozen = false;
	private capturesClosed = false;
	private backgroundCloseResult?: Promise<{ error?: Error; timedOut?: boolean }>;
	private appliedUnload?: { epoch: number; generation: number };
	private panelVisible: boolean;
	private beforeUnloadObserved = false;
	private resolveBeforeUnload!: () => void;
	private readonly beforeUnload = new Promise<void>(resolve => { this.resolveBeforeUnload = resolve; });
	private readonly pendingFinalPersists = new Map<string, PendingFinalPersist>();
	private readonly pendingReloads = new Map<string, PendingReload>();

	constructor(
		initialPanelVisible: boolean,
		private readonly label: string,
	) {
		this.panelVisible = initialPanelVisible;
	}

	get isDirty(): boolean { return this.dirty; }
	get baseText(): string | undefined { return this.draftBaseText; }
	get generation(): number { return this.draftGeneration; }
	get currentEditRevision(): number { return this.editRevision; }
	get currentStateEditRevision(): number { return this.stateEditRevision; }
	get isClosing(): boolean { return this.closing; }
	get isPanelVisible(): boolean { return this.panelVisible; }
	get hasPendingFinalPersist(): boolean {
		return [...this.pendingFinalPersists.values()].some(pending => !pending.background);
	}
	get hasPendingUpgrade(): boolean { return this.pendingUpgradeCount > 0; }
	hasPendingFinalPersistRequest(requestId: string): boolean {
		return !!requestId && this.pendingFinalPersists.has(requestId);
	}
	claimFinalPersistRequest(requestId: string, incomingRevision?: number): boolean {
		const pending = this.pendingFinalPersists.get(requestId);
		const background = this.backgroundPersist;
		if (!pending && background?.retired && background.requestId === requestId) {
			this.releaseBackgroundPersist(background);
		}
		if (!pending || pending.claimed) return false;
		if (pending.background && background && background.requestId === requestId
			&& incomingRevision !== undefined && this.isStalePersistRevision(incomingRevision)) {
			const followUp = this.backgroundFollowUp;
			this.retireBackgroundPersist();
			this.backgroundFollowUp = followUp;
			this.releaseBackgroundPersist(background);
			return false;
		}
		clearTimeout(pending.timer);
		pending.claimed = true;
		return true;
	}
	hasPendingReloadRequest(requestId: string): boolean {
		const pending = requestId ? this.pendingReloads.get(requestId) : undefined;
		if (!pending) return false;
		if (pending.absoluteCommitDeadline !== undefined) {
			const deadline = pending.claimed ? pending.absoluteCommitDeadline
				: Math.min(pending.arrivalDeadline!, pending.absoluteCommitDeadline);
			if (!Number.isFinite(deadline) || performance.now() >= deadline) {
				this.failReload(requestId);
				return false;
			}
		}
		return true;
	}

	claimReloadRequest(requestId: string): boolean {
		const pending = this.pendingReloads.get(requestId);
		if (!pending || pending.claimed || pending.absoluteCommitDeadline === undefined
			|| !this.hasPendingReloadRequest(requestId)) return false;
		clearTimeout(pending.timer);
		pending.claimed = true;
		pending.timer = setTimeout(() => {
			if (this.pendingReloads.get(requestId) === pending) this.failReload(requestId);
		}, Math.max(0, pending.absoluteCommitDeadline - performance.now()));
		return true;
	}

	isStaleRevision(revision: number): boolean {
		return Number.isSafeInteger(revision) && revision >= 0 && revision < this.editRevision;
	}

	isStalePersistRevision(revision: number): boolean {
		const queuedRevision = this.latestPersistSequenceByEpoch.get(this.persistEpoch)?.revision;
		return this.isStaleRevision(revision) || (Number.isSafeInteger(revision) && revision >= 0
			&& queuedRevision !== undefined && revision < queuedRevision);
	}

	adoptRevision(revision: number, mode: 'max' | 'replace' = 'max'): number {
		if (!Number.isSafeInteger(revision) || revision < 0) return this.editRevision;
		this.editRevision = mode === 'replace' ? revision : Math.max(this.editRevision, revision);
		return this.editRevision;
	}

	setStateRevision(revision: number): void {
		if (Number.isSafeInteger(revision) && revision >= 0) this.stateEditRevision = revision;
	}

	retirePersists(): void {
		this.retireBackgroundPersist();
		this.persistEpoch += 1;
		this.latestPersistSequenceByEpoch.clear();
		this.draftGeneration += 1;
	}

	markDirty(lastWrittenText?: string): void {
		if (!this.dirty) this.draftBaseText = lastWrittenText;
		this.dirty = true;
	}

	setMaterializedDirty(nextDirty: boolean, lastWrittenText?: string): void {
		if (nextDirty && !this.dirty) this.draftBaseText = lastWrittenText;
		if (!nextDirty) this.draftBaseText = undefined;
		this.dirty = nextDirty;
	}

	markClean(revision = this.editRevision): void {
		this.dirty = false;
		this.draftBaseText = undefined;
		this.setStateRevision(revision);
	}

	rebaseDraftBase(inputText: string, replacementText: string): void {
		if (this.dirty && this.draftBaseText === inputText) this.draftBaseText = replacementText;
	}

	reservePersistAdmission(incomingRevision: number): CompatPersistAdmissionLease {
		this.pendingPersistAdmissionCount++;
		const operation = this.reservePersistOperation();
		const currentness = this.reservePersistCurrentness(incomingRevision);
		const applicableUpgradeTail = this.upgradeTail;
		let settled = false;
		return Object.freeze({
			waitForTurn: operation.waitForTurn,
			queue: work => this.queuePersistWithCurrentness(
				currentness.isCurrent,
				work,
				applicableUpgradeTail,
			),
			settle: () => {
				if (settled) return;
				settled = true;
				this.pendingPersistAdmissionCount--;
				currentness.settle();
				operation.settle();
			},
		});
	}

	queuePersist<T>(
		incomingRevision: number,
		work: (isCurrent: () => boolean) => Promise<T>,
	): Promise<T> {
		if (this.closing) return Promise.reject(new Error(`The ${this.label} metadata session is closing.`));
		const currentness = this.reservePersistCurrentness(incomingRevision);
		const run = this.queuePersistWithCurrentness(currentness.isCurrent, work);
		void run.then(currentness.settle, currentness.settle);
		return run;
	}

	private queuePersistWithCurrentness<T>(
		isCurrent: () => boolean,
		work: (isCurrent: () => boolean) => Promise<T>,
		upgrades = this.upgradeTail,
	): Promise<T> {
		const priorPersist = this.persistTail;
		const run = Promise.all([
			priorPersist.catch(() => undefined),
			upgrades.catch(() => undefined),
		]).then(() => work(isCurrent));
		this.persistTail = run.then(() => undefined, () => undefined);
		return run;
	}

	enqueueAfterPersists<T>(work: () => Promise<T>): Promise<T> {
		if (this.closing) return Promise.reject(new Error(`The ${this.label} metadata session is closing.`));
		this.persistEpoch += 1;
		if (this.pendingPersistAdmissionCount === 0 && this.pendingUpgradeCount === 0) {
			return this.enqueueAfterPersistTail(work);
		}
		const operation = this.reservePersistOperation();
		const applicablePersistTail = this.persistTail;
		const applicableUpgradeTail = this.upgradeTail;
		return (async () => {
			try {
				await operation.waitForTurn();
				if (this.closing) throw new Error(`The ${this.label} metadata session is closing.`);
				return await this.enqueueAfterPersistTail(
					work,
					applicablePersistTail,
					applicableUpgradeTail,
				);
			} finally {
				operation.settle();
			}
		})();
	}

	private enqueueAfterPersistTail<T>(
		work: () => Promise<T>,
		persists = this.persistTail,
		upgrades = this.upgradeTail,
	): Promise<T> {
		const run = Promise.all([
			persists.catch(() => undefined),
			upgrades.catch(() => undefined),
		]).then(work);
		this.persistTail = run.then(() => undefined, () => undefined);
		return run;
	}

	async waitForPersists(): Promise<void> {
		for (;;) {
			const operations = this.persistOperationTail;
			const persists = this.persistTail;
			const upgrades = this.upgradeTail;
			await Promise.all([
				operations,
				persists,
				upgrades.catch(() => undefined),
			]);
			if (operations === this.persistOperationTail
				&& persists === this.persistTail
				&& upgrades === this.upgradeTail) return;
		}
	}

	private reservePersistOperation(): Readonly<{ waitForTurn: () => Promise<void>; settle: () => void }> {
		const priorOperation = this.persistOperationTail;
		let settleOperation!: () => void;
		const operationDone = new Promise<void>(resolve => { settleOperation = resolve; });
		this.persistOperationTail = priorOperation.catch(() => undefined).then(() => operationDone);
		let settled = false;
		return Object.freeze({
			waitForTurn: () => priorOperation.catch(() => undefined),
			settle: () => {
				if (settled) return;
				settled = true;
				settleOperation();
			},
		});
	}

	private reservePersistCurrentness(incomingRevision: number): Readonly<{
		isCurrent: () => boolean;
		settle: () => void;
	}> {
		const epoch = this.persistEpoch;
		const sequence = ++this.persistSequence;
		this.latestPersistSequenceByEpoch.set(epoch, { sequence, revision: incomingRevision });
		this.draftGeneration += 1;
		let settled = false;
		return Object.freeze({
			isCurrent: () => this.latestPersistSequenceByEpoch.get(epoch)?.sequence === sequence
				&& incomingRevision >= this.editRevision,
			settle: () => {
				if (settled) return;
				settled = true;
				if (this.latestPersistSequenceByEpoch.get(epoch)?.sequence === sequence) {
					this.latestPersistSequenceByEpoch.delete(epoch);
				}
			},
		});
	}

	async beginUpgrade(revision: number): Promise<CompatUpgradeLease | undefined> {
		if (this.closing) return undefined;
		this.retireBackgroundPersist();
		this.persistEpoch += 1;
		this.pendingUpgradeCount += 1;
		const priorOperations = this.persistOperationTail;
		const priorPersist = this.persistTail;
		const priorUpgrade = this.upgradeTail;
		let release!: () => void;
		const leaseDone = new Promise<void>(resolve => { release = resolve; });
		this.upgradeTail = priorUpgrade.catch(() => undefined).then(() => leaseDone);
		await Promise.all([
			priorOperations.catch(() => undefined),
			priorUpgrade.catch(() => undefined),
			priorPersist.catch(() => undefined),
		]);
		if (this.closing || !Number.isSafeInteger(revision) || revision < this.editRevision) {
			release();
			this.pendingUpgradeCount -= 1;
			return undefined;
		}
		this.editRevision = revision;
		let finished = false;
		return Object.freeze({
			revision,
			finish: () => {
				if (finished) return;
				finished = true;
				this.pendingUpgradeCount -= 1;
				release();
			},
		});
	}

	requestFinalPersist<T = void>(
		postMessage: PersistPoster,
		reason: string,
		timeoutMs = 2_000,
	): Promise<T> {
		this.finalPersistReservations++;
		this.retireBackgroundPersist();
		const request = this.finalPersistTail.catch(() => undefined).then(async () => {
			try {
				if (this.capturesClosed) throw new Error(`The ${this.label} metadata editor is closed.`);
				const capture = this.reserveFinalPersist(false);
				this.armFinalPersistDeadline(capture.requestId, capture.pending, timeoutMs);
				this.sendPersistRequest(capture.requestId, postMessage, reason);
				return await capture.result as T;
			} finally {
				this.finalPersistReservations--;
				this.startBackgroundPersist();
			}
		});
		this.finalPersistTail = request.then(() => undefined, () => undefined);
		return request;
	}

	requestBackgroundPersist(post: PersistPoster, report: (error: Error) => void, runtimeId = ''): void {
		if (this.backgroundFrozen || this.capturesClosed || this.closing) return;
		const previous = this.backgroundPersist;
		if (previous && runtimeId && previous.runtimeId && previous.runtimeId !== runtimeId
			&& !previous.pending.claimed) {
			this.retireBackgroundPersist();
			this.releaseBackgroundPersist(previous);
		} else if (previous && !previous.runtimeId) {
			previous.runtimeId = runtimeId;
		}
		this.backgroundRequest = { post, report, runtimeId };
		this.backgroundFollowUp = true;
		this.startBackgroundPersist();
	}

	private startBackgroundPersist(): void {
		const request = this.backgroundRequest;
		if (!request || !this.backgroundFollowUp || this.backgroundPersist || this.finalPersistReservations
			|| this.backgroundFrozen || this.capturesClosed || this.closing || this.panelVisible) return;
		this.backgroundFollowUp = false;
		const capture = this.reserveFinalPersist(true);
		const background: BackgroundPersist = {
			...capture, controller: new AbortController(), runtimeId: request.runtimeId,
			retired: false, promoted: false, reported: false,
		};
		this.backgroundPersist = background;
		const finish = (error?: unknown) => {
			try {
				if (error && !background.retired && !background.promoted && !this.capturesClosed) {
					background.reported = true;
					request.report(error instanceof Error ? error : new Error(String(error)));
				}
			} finally {
				if (!background.retired) this.releaseBackgroundPersist(background);
			}
		};
		void capture.result.then(() => finish(), finish)
			.catch(error => console.error('[kusto] Background snapshot reporting failed:', error));
		this.sendPersistRequest(capture.requestId, request.post, 'hidden', background);
	}

	private releaseBackgroundPersist(background: BackgroundPersist): void {
		if (this.backgroundPersist !== background) return;
		this.backgroundPersist = undefined;
		this.startBackgroundPersist();
	}

	private retireBackgroundPersist(): void {
		this.backgroundFollowUp = false;
		const background = this.backgroundPersist;
		if (!background || background.retired || background.promoted || background.pending.claimed
			|| !this.pendingFinalPersists.has(background.requestId)) return;
		background.retired = true;
		background.controller.abort();
		this.completeFinalPersist(background.requestId, new Error('Background metadata capture was superseded.'));
	}

	freezeBackgroundPersists(): void {
		if (this.backgroundFrozen) return;
		this.backgroundFrozen = true;
		this.backgroundFollowUp = false;
		const background = this.backgroundPersist;
		if (!background || background.retired) return;
		background.promoted = true;
		background.pending.background = false;
		if (!background.pending.claimed && this.pendingFinalPersists.has(background.requestId)) {
			this.armFinalPersistDeadline(background.requestId, background.pending, 2_000);
		}
		this.backgroundCloseResult = background.result.then(
			() => ({}),
			error => background.reported ? {} : {
				error: error instanceof Error ? error : new Error(String(error)),
				timedOut: background.pending.timedOut,
			},
		);
		this.finalPersistTail = Promise.all([this.finalPersistTail, this.backgroundCloseResult]).then(() => undefined);
	}

	async getBackgroundCloseError(): Promise<Error | undefined> {
		const result = await this.backgroundCloseResult;
		if (result?.timedOut && this.appliedUnload?.epoch === this.persistEpoch
			&& this.appliedUnload.generation === this.draftGeneration) return undefined;
		return result?.error;
	}

	markAppliedBeforeUnload(reason: unknown, generation: number): void {
		if (reason === 'beforeunload' && generation === this.draftGeneration) {
			this.appliedUnload = { epoch: this.persistEpoch, generation };
		}
	}

	private reserveFinalPersist(background: boolean): {
		requestId: string; result: Promise<unknown>; pending: PendingFinalPersist;
	} {
		const requestId = `final-persist-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		let resolve!: (value: unknown) => void;
		let reject!: (error: Error) => void;
		const result = new Promise<unknown>((accept, fail) => { resolve = accept; reject = fail; });
		const pending = { resolve, reject, background };
		this.pendingFinalPersists.set(requestId, pending);
		return { requestId, result, pending };
	}

	private armFinalPersistDeadline(requestId: string, pending: PendingFinalPersist, timeoutMs: number): void {
		pending.timer = setTimeout(() => {
			if (pending.claimed) return;
			pending.timedOut = true;
			this.completeFinalPersist(requestId, new Error(`Timed out waiting for the final ${this.label} metadata snapshot.`));
		}, timeoutMs);
	}

	private sendPersistRequest(requestId: string, post: PersistPoster, reason: string, background?: BackgroundPersist): void {
		const fail = (error: Error) => {
			if (!this.pendingFinalPersists.get(requestId)?.claimed) this.completeFinalPersist(requestId, error);
			if (background?.retired) this.releaseBackgroundPersist(background);
		};
		try {
			void Promise.resolve(post(
				{ type: 'requestFinalPersist', requestId, reason },
				background?.controller.signal,
				background ? () => !background.retired && !this.capturesClosed : undefined,
			)).then(
				delivered => {
					if (!delivered) fail(new Error(`The final ${this.label} metadata snapshot request was not delivered.`));
				},
				error => fail(new Error(`The final ${this.label} metadata snapshot request failed: ${this.errorMessage(error)}`)),
			);
		} catch (error) {
			fail(new Error(`The final ${this.label} metadata snapshot request failed: ${this.errorMessage(error)}`));
		}
	}

	completeFinalPersist<T = void>(requestId: string, error?: Error, value?: T): boolean {
		const pending = this.pendingFinalPersists.get(requestId);
		if (!pending) return false;
		clearTimeout(pending.timer);
		this.pendingFinalPersists.delete(requestId);
		if (!pending.background && !error && this.backgroundPersist?.retired) {
			this.releaseBackgroundPersist(this.backgroundPersist);
		}
		if (error) pending.reject(error);
		else pending.resolve(value);
		return true;
	}

	async waitForFinalPersists(): Promise<void> {
		await this.finalPersistTail;
	}

	createReloadRequest(
		timeoutMs = 5_000,
		options?: CompatReloadReservationOptions,
	): { requestId: string; result: Promise<boolean> } {
		const requestId = `document-reload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const arrivalDeadline = options ? performance.now() + timeoutMs : undefined;
		const result = new Promise<boolean>(resolve => {
			const timer = setTimeout(() => this.failReload(requestId), options
				? Math.max(0, Math.min(arrivalDeadline!, options.absoluteCommitDeadline) - performance.now())
				: timeoutMs);
			this.pendingReloads.set(requestId, {
				resolve, timer,
				...(options ? { arrivalDeadline, absoluteCommitDeadline: options.absoluteCommitDeadline, claimed: false } : {}),
			});
		});
		return { requestId, result };
	}

	completeReload(requestId: string, applied: boolean, revision: number): boolean {
		const pending = this.pendingReloads.get(requestId);
		if (!pending || !this.hasPendingReloadRequest(requestId)) return false;
		if (pending.absoluteCommitDeadline !== undefined && pending.claimed !== applied) return false;
		clearTimeout(pending.timer);
		this.pendingReloads.delete(requestId);
		this.adoptRevision(revision);
		pending.resolve(applied);
		return true;
	}

	failReload(requestId: string): boolean {
		const pending = this.pendingReloads.get(requestId);
		if (!pending) return false;
		clearTimeout(pending.timer);
		this.pendingReloads.delete(requestId);
		pending.resolve(false);
		return true;
	}

	setPanelVisible(visible: boolean): void {
		this.panelVisible = visible;
	}

	markBeforeUnload(reason: unknown): void {
		if (this.beforeUnloadObserved || String(reason || '') !== 'beforeunload') return;
		this.beforeUnloadObserved = true;
		this.resolveBeforeUnload();
	}

	async waitForBeforeUnload(timeoutMs = 500): Promise<void> {
		if (this.beforeUnloadObserved) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.beforeUnload,
				new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	beginClose(): void {
		this.closing = true;
	}

	settleClose(): void {
		this.capturesClosed = true;
		this.backgroundFrozen = true;
		this.backgroundFollowUp = false;
		this.backgroundRequest = undefined;
		this.backgroundPersist?.controller.abort();
		this.backgroundPersist = undefined;
		for (const requestId of [...this.pendingFinalPersists.keys()]) {
			this.completeFinalPersist(requestId, new Error(`The ${this.label} metadata editor closed before its final snapshot was confirmed.`));
		}
		for (const [requestId, pending] of this.pendingReloads) {
			clearTimeout(pending.timer);
			this.pendingReloads.delete(requestId);
			pending.resolve(false);
		}
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}