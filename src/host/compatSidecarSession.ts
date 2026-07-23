export type CompatPersistOutcome = Readonly<{ ok: boolean; error?: Error }>;

export type CompatUpgradeLease = Readonly<{
	revision: number;
	finish: () => void;
}>;

type PendingFinalPersist = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

type PendingReload = {
	resolve: (applied: boolean) => void;
	timer: ReturnType<typeof setTimeout>;
};

export class CompatSidecarSession {
	private dirty = false;
	private draftBaseText: string | undefined;
	private draftGeneration = 0;
	private persistSequence = 0;
	private persistTail: Promise<void> = Promise.resolve();
	private upgradeTail: Promise<void> = Promise.resolve();
	private closing = false;
	private editRevision = 0;
	private stateEditRevision = 0;
	private finalPersistTail: Promise<void> = Promise.resolve();
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
	get hasPendingFinalPersist(): boolean { return this.pendingFinalPersists.size > 0; }

	isStaleRevision(revision: number): boolean {
		return Number.isSafeInteger(revision) && revision >= 0 && revision < this.editRevision;
	}

	adoptRevision(revision: number, mode: 'max' | 'replace' = 'max'): number {
		if (!Number.isSafeInteger(revision) || revision < 0) return this.editRevision;
		this.editRevision = mode === 'replace' ? revision : Math.max(this.editRevision, revision);
		return this.editRevision;
	}

	setStateRevision(revision: number): void {
		if (Number.isSafeInteger(revision) && revision >= 0) this.stateEditRevision = revision;
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

	queuePersist<T>(
		incomingRevision: number,
		work: (isCurrent: () => boolean) => Promise<T>,
	): Promise<T> {
		if (this.closing) return Promise.reject(new Error(`The ${this.label} metadata session is closing.`));
		const sequence = ++this.persistSequence;
		this.draftGeneration += 1;
		const priorPersist = this.persistTail;
		const upgrades = this.upgradeTail;
		const isCurrent = () => sequence === this.persistSequence && incomingRevision >= this.editRevision;
		const run = Promise.all([
			priorPersist.catch(() => undefined),
			upgrades.catch(() => undefined),
		]).then(() => work(isCurrent));
		this.persistTail = run.then(() => undefined, () => undefined);
		return run;
	}

	enqueueAfterPersists<T>(work: () => Promise<T>): Promise<T> {
		if (this.closing) return Promise.reject(new Error(`The ${this.label} metadata session is closing.`));
		const run = this.persistTail.catch(() => undefined).then(work);
		this.persistTail = run.then(() => undefined, () => undefined);
		return run;
	}

	async waitForPersists(): Promise<void> {
		for (;;) {
			const persists = this.persistTail;
			const upgrades = this.upgradeTail;
			await Promise.all([
				persists,
				upgrades.catch(() => undefined),
			]);
			if (persists === this.persistTail && upgrades === this.upgradeTail) return;
		}
	}

	async beginUpgrade(revision: number): Promise<CompatUpgradeLease | undefined> {
		if (this.closing) return undefined;
		const priorPersist = this.persistTail;
		const priorUpgrade = this.upgradeTail;
		let release!: () => void;
		const leaseDone = new Promise<void>(resolve => { release = resolve; });
		this.upgradeTail = priorUpgrade.catch(() => undefined).then(() => leaseDone);
		await Promise.all([
			priorUpgrade.catch(() => undefined),
			priorPersist.catch(() => undefined),
		]);
		if (this.closing || !Number.isSafeInteger(revision) || revision < this.editRevision) {
			release();
			return undefined;
		}
		this.editRevision = revision;
		let finished = false;
		return Object.freeze({
			revision,
			finish: () => {
				if (finished) return;
				finished = true;
				release();
			},
		});
	}

	requestFinalPersist<T = void>(
		postMessage: (message: unknown) => boolean | PromiseLike<boolean>,
		reason: string,
		timeoutMs = 2_000,
	): Promise<T> {
		const request = this.finalPersistTail.catch(() => undefined).then(async () => {
			const requestId = `final-persist-${Date.now()}-${Math.random().toString(16).slice(2)}`;
			let resolveResponse!: (value: T) => void;
			let rejectResponse!: (error: Error) => void;
			const response = new Promise<T>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
			const timer = setTimeout(() => this.completeFinalPersist(
				requestId,
				new Error(`Timed out waiting for the final ${this.label} metadata snapshot.`),
			), timeoutMs);
			this.pendingFinalPersists.set(requestId, {
				resolve: value => resolveResponse(value as T),
				reject: rejectResponse,
				timer,
			});
			try {
				void Promise.resolve(postMessage({ type: 'requestFinalPersist', requestId, reason })).then(
					delivered => {
						if (!delivered) this.completeFinalPersist(requestId, new Error(`The final ${this.label} metadata snapshot request was not delivered.`));
					},
					error => this.completeFinalPersist(requestId, new Error(`The final ${this.label} metadata snapshot request failed: ${this.errorMessage(error)}`)),
				);
			} catch (error) {
				this.completeFinalPersist(requestId, new Error(`The final ${this.label} metadata snapshot request failed: ${this.errorMessage(error)}`));
			}
			return await response;
		});
		this.finalPersistTail = request.then(() => undefined, () => undefined);
		return request as Promise<T>;
	}

	completeFinalPersist<T = void>(requestId: string, error?: Error, value?: T): boolean {
		const pending = this.pendingFinalPersists.get(requestId);
		if (!pending) return false;
		clearTimeout(pending.timer);
		this.pendingFinalPersists.delete(requestId);
		if (error) pending.reject(error);
		else pending.resolve(value);
		return true;
	}

	async waitForFinalPersists(): Promise<void> {
		await this.finalPersistTail;
	}

	createReloadRequest(timeoutMs = 5_000): { requestId: string; result: Promise<boolean> } {
		const requestId = `document-reload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const result = new Promise<boolean>(resolve => {
			const timer = setTimeout(() => {
				this.pendingReloads.delete(requestId);
				resolve(false);
			}, timeoutMs);
			this.pendingReloads.set(requestId, { resolve, timer });
		});
		return { requestId, result };
	}

	completeReload(requestId: string, applied: boolean, revision: number): boolean {
		const pending = this.pendingReloads.get(requestId);
		if (!pending) return false;
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