import { randomUUID } from 'crypto';

import type { CompatSidecarSession } from './compatSidecarSession';

export type CompatSidecarProjectionRequest = Readonly<{
	forceReload?: boolean;
	requestId?: string;
	expectedEditRevision?: number;
	retirePersists?: boolean;
	context?: unknown;
}>;

export type CompatSidecarProjectionAttempt = Readonly<{
	generation: number;
	requestId: string;
	requestSource: 'webview' | 'host';
	sourceText: string;
	forceReload: boolean;
	expectedEditRevision?: number;
	context?: unknown;
	isCurrent: () => boolean;
	reserveReload: () => string | undefined;
	commitActivation: () => boolean;
}>;

export type CompatSidecarReloadResult = Readonly<{
	requestId: string;
	applied: boolean;
	editRevision: number;
}>;

export type CompatSidecarPersistAdmission = Readonly<{
	sourceGeneration: unknown;
	editRevision: unknown;
	requireCurrentGeneration: boolean;
	allowMissingSourceGeneration: boolean;
}>;

export interface CompatSidecarProjectionCoordinatorOptions {
	readonly session: CompatSidecarSession;
	readonly readSourceText: () => string;
	readonly readSourceVersion?: () => number;
	readonly isDisposed: () => boolean;
	readonly disposalSignal?: Promise<void>;
	readonly postProjection: (attempt: CompatSidecarProjectionAttempt) => Promise<boolean>;
	readonly onProjectionSettled?: (
		attempt: CompatSidecarProjectionAttempt,
		applied: boolean,
	) => boolean | void | Promise<boolean | void>;
	readonly initialProjectionMaxAttempts?: number;
	readonly createRequestId?: () => string;
	readonly sameSourceText?: (left: string, right: string) => boolean;
}

export type CompatSidecarOwnedSourceEditRegistration = Readonly<{
	previousText: string;
	complete: (version: number) => boolean;
	cancel: () => void;
}>;

export type CompatSidecarOwnedSourcePersistOwner = Readonly<{
	persistGeneration: number;
	editRevision: number;
}>;

export interface CompatSidecarProjectionCoordinatorContract {
	readonly isInitialized: boolean;
	readonly currentProjectionGeneration: number;
	readonly activeSourceGeneration: number;
	readonly sourceRollbackFailed: boolean;
	project(request?: CompatSidecarProjectionRequest): Promise<boolean>;
	requestDocument(requestId: string, expectedEditRevision?: number): Promise<boolean>;
	requestSourceReload(): Promise<boolean>;
	ensureInitialProjection(requestId?: string): Promise<boolean>;
	completeReload(result: CompatSidecarReloadResult): boolean;
	waitForCurrentProjection(timeoutMs?: number): Promise<boolean>;
	waitForAcknowledgedProjection(sourceGeneration: unknown): Promise<void>;
	registerOwnedSourceEdit(
		sourceGeneration: number, previousText: string, nextText: string, previousVersion: number,
	): CompatSidecarOwnedSourceEditRegistration | undefined;
	adoptOwnedSourceText(
		sourceGeneration: number, previousText: string, nextText: string,
		persistOwner?: CompatSidecarOwnedSourcePersistOwner,
	): Promise<boolean>;
	admitPersist(admission: CompatSidecarPersistAdmission): boolean;
	captureSourceReloadEpoch(): number;
	rollbackSupersededSourceEdit(
		admissionEpoch: number,
		candidateText: string,
		restoreSourceText: (text: string) => Promise<boolean>,
	): Promise<boolean>;
}

export type CompatSidecarProjectionCoordinatorFactory = (
	options: CompatSidecarProjectionCoordinatorOptions,
) => CompatSidecarProjectionCoordinatorContract;

export function createCompatSidecarProjectionReadiness(
	constructionPromise: Promise<CompatSidecarProjectionCoordinatorContract | undefined>,
	outerDisposalSignal: Promise<void>,
	isDisposed: () => boolean,
): () => Promise<boolean> {
	const stopped = outerDisposalSignal.then(() => undefined);
	return async () => {
		if (isDisposed()) return false;
		const deadline = Date.now() + 30_000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const coordinator = await Promise.race([
				constructionPromise,
				stopped,
				new Promise<undefined>(resolve => {
					timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
				}),
			]);
			return !!coordinator && !isDisposed()
				&& await coordinator.waitForCurrentProjection(Math.max(0, deadline - Date.now()));
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	};
}

type ProjectionIdentity = Readonly<{
	generation: number;
	sourceText: string;
	expectedEditRevision?: number;
}>;

type OwnedSourceEdit = {
	readonly sourceGeneration: number;
	readonly projectionGeneration: number;
	readonly persistGeneration: number;
	readonly previousText: string;
	readonly previousVersion: number;
	readonly nextText: string;
	version?: number;
};

const DEFAULT_INITIAL_PROJECTION_MAX_ATTEMPTS = 3;
const MAX_INITIAL_PROJECTION_REQUEST_IDS = 64;
const SOURCE_ROLLBACK_MAX_ATTEMPTS = 3;

export class CompatSidecarProjectionCoordinator implements CompatSidecarProjectionCoordinatorContract {
	private projectionGeneration = 0;
	private activeGeneration = 0;
	private activeSourceText: string;
	private ownedSourceEdit: OwnedSourceEdit | undefined;
	private pendingProjection: ProjectionIdentity | undefined;
	private pendingReloadRequestId: string | undefined;
	private readonly projectionSettlements = new Map<number, Promise<boolean>>();
	private acknowledgedProjectionGeneration: number | undefined;
	private initialized = false;
	private initialProjectionRecovery: Promise<boolean> | undefined;
	private initialProjectionRecoverySourceText: string | undefined;
	private initialProjectionExhaustedSourceText: string | undefined;
	private readonly initialProjectionRequestIds = new Set<string>();
	private initialProjectionRestartRequested = false;
	private sourceReloadEpoch = 0;
	private sourceReloadAuthority: Readonly<{ epoch: number; text: string }> | undefined;
	private rollbackFailed = false;
	private rollbackFailedCandidate: string | undefined;
	private readonly initialProjectionMaxAttempts: number;
	private readonly createRequestId: () => string;
	private readonly sameSourceText: (left: string, right: string) => boolean;

	constructor(private readonly options: CompatSidecarProjectionCoordinatorOptions) {
		this.activeSourceText = options.readSourceText();
		this.initialProjectionMaxAttempts = Number.isSafeInteger(options.initialProjectionMaxAttempts)
			&& Number(options.initialProjectionMaxAttempts) > 0
			? Number(options.initialProjectionMaxAttempts)
			: DEFAULT_INITIAL_PROJECTION_MAX_ATTEMPTS;
		this.createRequestId = options.createRequestId ?? (() => `compat-document-${randomUUID()}`);
		this.sameSourceText = options.sameSourceText
			?? ((left, right) => left.replace(/\r\n?/g, '\n') === right.replace(/\r\n?/g, '\n'));
	}

	get isInitialized(): boolean {
		return this.initialized;
	}

	get currentProjectionGeneration(): number {
		return this.projectionGeneration;
	}

	get activeSourceGeneration(): number {
		return this.activeGeneration;
	}

	get sourceRollbackFailed(): boolean {
		return this.rollbackFailed;
	}

	project(request: CompatSidecarProjectionRequest = {}): Promise<boolean> {
		if (this.options.isDisposed()) return Promise.resolve(false);
		const previousGeneration = this.projectionGeneration;
		const previousProjection = this.projectionSettlements.get(previousGeneration);
		const previousActiveGeneration = this.activeGeneration;
		const previousActiveProjection = this.projectionSettlements.get(previousActiveGeneration);
		const projection = this.runProjection(request);
		const generation = this.projectionGeneration;
		this.projectionSettlements.set(generation, projection);
		const release = (settledGeneration: number, settledProjection: Promise<boolean>) => {
			if (this.projectionGeneration !== settledGeneration
				&& this.activeGeneration !== settledGeneration
				&& this.projectionSettlements.get(settledGeneration) === settledProjection) {
				this.projectionSettlements.delete(settledGeneration);
			}
			if (this.acknowledgedProjectionGeneration === settledGeneration) {
				this.acknowledgedProjectionGeneration = undefined;
			}
		};
		const releaseProjection = () => {
			release(generation, projection);
			if (previousActiveProjection) {
				const releasePreviousActive = () => release(previousActiveGeneration, previousActiveProjection);
				void previousActiveProjection.then(releasePreviousActive, releasePreviousActive);
			}
		};
		void projection.then(releaseProjection, releaseProjection);
		if (previousProjection) {
			const releasePrevious = () => release(previousGeneration, previousProjection);
			void previousProjection.then(releasePrevious, releasePrevious);
		}
		return projection;
	}

	private async runProjection(request: CompatSidecarProjectionRequest): Promise<boolean> {
		if (this.options.isDisposed()) return false;
		const sourceText = this.options.readSourceText();
		if (request.retirePersists) {
			this.options.session.retirePersists();
			this.sourceReloadAuthority = { epoch: ++this.sourceReloadEpoch, text: sourceText };
			if (this.rollbackFailedCandidate === undefined
				|| !this.sameSourceText(sourceText, this.rollbackFailedCandidate)) {
				this.rollbackFailed = false;
				this.rollbackFailedCandidate = undefined;
			}
		}

		this.retirePendingProjection();
		this.ownedSourceEdit = undefined;
		const generation = ++this.projectionGeneration;
		const expectedEditRevision = this.validRevision(request.expectedEditRevision);
		const identity: ProjectionIdentity = Object.freeze({
			generation,
			sourceText,
			expectedEditRevision,
		});
		this.pendingProjection = identity;
		let reload: ReturnType<CompatSidecarSession['createReloadRequest']> | undefined;
		let activationCommitted = false;
		const commitActivation = (): boolean => {
			if (activationCommitted) return true;
			if (!this.isProjectionCurrent(identity)) return false;
			this.activeGeneration = identity.generation;
			this.activeSourceText = identity.sourceText;
			if (this.pendingProjection === identity) this.pendingProjection = undefined;
			activationCommitted = true;
			return true;
		};
		const attempt: CompatSidecarProjectionAttempt = Object.freeze({
			generation,
			requestId: request.requestId ?? this.createRequestId(),
			requestSource: request.requestId ? 'webview' : 'host',
			sourceText,
			forceReload: request.forceReload ?? false,
			expectedEditRevision,
			context: request.context,
			isCurrent: () => this.isProjectionCurrent(identity),
			reserveReload: () => {
				if (!this.isProjectionCurrent(identity)) return undefined;
				if (!reload) {
					reload = this.options.session.createReloadRequest();
					this.pendingReloadRequestId = reload.requestId;
				}
				return reload.requestId;
			},
			commitActivation,
		});

		let delivered: boolean;
		try {
			delivered = await this.options.postProjection(attempt);
		} catch (error) {
			if (reload) this.options.session.failReload(reload.requestId);
			await this.options.onProjectionSettled?.(attempt, false);
			throw error;
		}
		if (!reload) {
			await this.options.onProjectionSettled?.(attempt, false);
			return false;
		}
		if (!delivered || !this.isProjectionCurrent(identity)) {
			this.options.session.failReload(reload.requestId);
		}
		const applied = await reload.result;
		if (this.pendingProjection === identity && this.pendingReloadRequestId === reload.requestId) {
			this.pendingReloadRequestId = undefined;
		}
		const appliedCurrent = applied && this.isProjectionCurrent(identity);
		if (!appliedCurrent) {
			await this.options.onProjectionSettled?.(attempt, false);
			return false;
		}
		if (await this.options.onProjectionSettled?.(attempt, true) === false) {
			if (this.pendingProjection === identity) this.pendingProjection = undefined;
			return false;
		}
		return activationCommitted || commitActivation();
	}

	async requestDocument(requestId: string, expectedEditRevision?: number): Promise<boolean> {
		const freshRequest = requestId.startsWith('dispatcher-document-')
			&& !this.initialProjectionRequestIds.has(requestId)
			&& this.initialProjectionRequestIds.size < MAX_INITIAL_PROJECTION_REQUEST_IDS;
		if (freshRequest) this.initialProjectionRequestIds.add(requestId);
		if (!this.initialized) {
			if (freshRequest) this.initialProjectionExhaustedSourceText = undefined;
			return this.ensureInitialProjection(requestId);
		}
		const requestGeneration = this.projectionGeneration + 1;
		const applied = await this.project({
			forceReload: true, requestId, expectedEditRevision, retirePersists: true,
		});
		if (!applied && this.projectionGeneration === requestGeneration) this.initialized = false;
		return applied;
	}

	requestSourceReload(): Promise<boolean> {
		return this.initialized
			? this.project({ forceReload: true, retirePersists: true })
			: this.ensureInitialProjection();
	}

	ensureInitialProjection(requestId?: string): Promise<boolean> {
		return this.ensureInitialProjectionRun(requestId, true);
	}

	completeReload(result: CompatSidecarReloadResult): boolean {
		const pending = this.pendingProjection;
		if (!pending || this.pendingReloadRequestId !== result.requestId) {
			this.options.session.failReload(result.requestId);
			return false;
		}
		if (!this.isProjectionCurrent(pending)) {
			this.options.session.failReload(result.requestId);
			return false;
		}
		const completed = this.options.session.completeReload(
			result.requestId,
			result.applied,
			result.editRevision,
		);
		if (completed && result.applied) this.acknowledgedProjectionGeneration = pending.generation;
		return completed;
	}

	async waitForCurrentProjection(timeoutMs = 30_000): Promise<boolean> {
		const deadline = Date.now() + Math.max(0, timeoutMs);
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		let probeTimer: ReturnType<typeof setTimeout> | undefined;
		const expired = new Promise<null>(resolve => {
			deadlineTimer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
		});
		const stopped = this.options.disposalSignal
			? Promise.race([expired, this.options.disposalSignal.then(() => null, () => null)])
			: expired;
		try {
			while (!this.options.isDisposed()) {
				const observationGeneration = this.projectionGeneration;
				const pending = this.pendingProjection;
				const generation = pending?.generation ?? (this.projectionSettlements.has(observationGeneration)
					? observationGeneration : this.activeGeneration);
				const settlement = this.projectionSettlements.get(generation);
				const sourceText = this.readSourceTextSafely();
				const remaining = deadline - Date.now();
				if (remaining <= 0 || generation === 0 || !settlement || this.rollbackFailed
					|| typeof sourceText !== 'string'
					|| (pending
						? pending.generation !== observationGeneration || pending.sourceText !== sourceText
						: this.activeGeneration !== generation || this.activeSourceText !== sourceText)) return false;
				if (this.pendingReloadRequestId
					&& !this.options.session.hasPendingReloadRequest(this.pendingReloadRequestId)
					&& this.acknowledgedProjectionGeneration !== generation) return false;
				const physicalSettlements = generation !== observationGeneration && !pending
					? [...this.projectionSettlements].filter(([retiredGeneration]) =>
						retiredGeneration > generation && retiredGeneration < observationGeneration)
						.map(([, retired]) => retired.then(() => true, () => true))
					: [];
				const fullSettlement = Promise.all([settlement.catch(() => false), ...physicalSettlements])
					.then(([applied]) => applied);
				const applied = await Promise.race([
					fullSettlement,
					stopped,
					new Promise<undefined>(resolve => {
						probeTimer = setTimeout(() => resolve(undefined), Math.min(250, remaining));
					}),
				]);
				if (probeTimer !== undefined) clearTimeout(probeTimer);
				probeTimer = undefined;
				if (applied === null || this.options.isDisposed() || Date.now() >= deadline) return false;
				if (this.projectionGeneration !== observationGeneration || applied === undefined) continue;
				return applied && this.activeGeneration === generation && !this.pendingProjection
					&& !this.rollbackFailed && this.projectionSourceMatches(this.activeSourceText);
			}
			return false;
		} finally {
			if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
			if (probeTimer !== undefined) clearTimeout(probeTimer);
		}
	}

	async waitForAcknowledgedProjection(sourceGeneration: unknown): Promise<void> {
		const generation = Number(sourceGeneration);
		if (!Number.isSafeInteger(generation)
			|| this.acknowledgedProjectionGeneration !== generation) return;
		await this.projectionSettlements.get(generation)?.catch(() => false);
	}

	registerOwnedSourceEdit(
		sourceGeneration: number, previousText: string, nextText: string, previousVersion: number,
	): CompatSidecarOwnedSourceEditRegistration | undefined {
		const observationGeneration = this.projectionGeneration;
		const settlement = this.projectionSettlements.get(sourceGeneration);
		const ownerIsCurrent = () => !this.options.isDisposed() && !this.rollbackFailed && !this.pendingProjection
			&& this.projectionGeneration === observationGeneration && this.activeGeneration === sourceGeneration
			&& this.projectionSettlements.get(sourceGeneration) === settlement
			&& (observationGeneration === sourceGeneration || !this.projectionSettlements.has(observationGeneration));
		if (!settlement || !ownerIsCurrent() || !Number.isSafeInteger(previousVersion) || previousVersion < 0
			|| !this.ownedSourceVersionMatches(previousVersion) || !this.projectionSourceMatches(previousText)) return undefined;
		const preceding = this.ownedSourceEdit;
		if (preceding ? preceding.version === undefined || preceding.sourceGeneration !== sourceGeneration
			|| preceding.projectionGeneration !== observationGeneration || preceding.version !== previousVersion
			|| preceding.nextText !== previousText : this.activeSourceText !== previousText) return undefined;
		const edit: OwnedSourceEdit = {
			sourceGeneration, projectionGeneration: observationGeneration, persistGeneration: this.options.session.generation,
			previousText: preceding?.previousText ?? previousText, previousVersion, nextText,
		};
		this.ownedSourceEdit = edit;
		return Object.freeze({
			previousText: edit.previousText,
			complete: (version: number): boolean => {
				if (this.ownedSourceEdit !== edit || edit.version !== undefined) return false;
				if (!ownerIsCurrent() || version !== edit.previousVersion + 1
					|| this.options.session.generation < edit.persistGeneration
					|| !this.ownedSourceVersionMatches(version) || !this.projectionSourceMatches(edit.nextText)) {
					this.ownedSourceEdit = undefined;
					return false;
				}
				edit.version = version;
				return true;
			},
			cancel: (): void => { if (this.ownedSourceEdit === edit) this.ownedSourceEdit = undefined; },
		});
	}

	async adoptOwnedSourceText(
		sourceGeneration: number, previousText: string, nextText: string,
		persistOwner?: CompatSidecarOwnedSourcePersistOwner,
	): Promise<boolean> {
		const observationGeneration = this.projectionGeneration;
		const settlement = this.projectionSettlements.get(sourceGeneration);
		const edit = this.ownedSourceEdit;
		const persistGeneration = persistOwner?.persistGeneration ?? edit?.persistGeneration;
		const ownsSource = () => !this.options.isDisposed() && !this.rollbackFailed && !this.pendingProjection
			&& this.projectionGeneration === observationGeneration && this.activeGeneration === sourceGeneration
			&& this.activeSourceText === previousText && this.projectionSourceMatches(nextText)
			&& edit !== undefined && this.ownedSourceEdit === edit && edit.version !== undefined
			&& edit.sourceGeneration === sourceGeneration && edit.projectionGeneration === observationGeneration
			&& persistGeneration !== undefined && edit.persistGeneration <= persistGeneration
			&& persistGeneration === this.options.session.generation
			&& (!persistOwner || Number.isSafeInteger(persistOwner.editRevision) && persistOwner.editRevision >= 0
				&& this.options.session.currentStateEditRevision === persistOwner.editRevision
				&& this.options.session.currentEditRevision === persistOwner.editRevision)
			&& edit.previousText === previousText && edit.nextText === nextText && this.ownedSourceVersionMatches(edit.version)
			&& this.projectionSettlements.get(sourceGeneration) === settlement
			&& (observationGeneration === sourceGeneration || !this.projectionSettlements.has(observationGeneration));
		if (!settlement || !ownsSource() || !await settlement.catch(() => false) || !ownsSource()) return false;
		this.activeSourceText = nextText;
		this.ownedSourceEdit = undefined;
		return true;
	}

	private ownedSourceVersionMatches(version: number): boolean {
		try {
			return !this.options.readSourceVersion || this.options.readSourceVersion() === version;
		} catch {
			return false;
		}
	}

	admitPersist(admission: CompatSidecarPersistAdmission): boolean {
		const incomingSourceGeneration = Number(admission.sourceGeneration);
		const incomingEditRevision = Number(admission.editRevision);
		const sourceGenerationMissing = !Number.isSafeInteger(incomingSourceGeneration);
		const pending = this.pendingProjection;
		const supersedesPendingProjection = !!pending
			&& pending.expectedEditRevision !== undefined
			&& Number.isSafeInteger(incomingEditRevision)
			&& incomingEditRevision > pending.expectedEditRevision
			&& incomingSourceGeneration === this.activeGeneration
			&& pending.sourceText === this.activeSourceText
			&& this.projectionSourceMatches(this.activeSourceText);

		if (supersedesPendingProjection) {
			this.retirePendingProjection();
			this.projectionGeneration += 1;
		}
		if (!admission.requireCurrentGeneration) return true;
		if (!supersedesPendingProjection && this.pendingProjection) return false;
		if (sourceGenerationMissing) return admission.allowMissingSourceGeneration;
		return incomingSourceGeneration === this.activeGeneration;
	}

	captureSourceReloadEpoch(): number {
		return this.sourceReloadEpoch;
	}

	async rollbackSupersededSourceEdit(
		admissionEpoch: number,
		candidateText: string,
		restoreSourceText: (text: string) => Promise<boolean>,
	): Promise<boolean> {
		const authority = this.sourceReloadAuthority;
		if (!authority
			|| authority.epoch <= admissionEpoch
			|| this.sourceReloadAuthority !== authority
			|| !this.rollbackSourceMatches(candidateText)) return true;

		this.rollbackFailed = true;
		this.rollbackFailedCandidate = candidateText;
		for (let attempt = 0; attempt < SOURCE_ROLLBACK_MAX_ATTEMPTS; attempt++) {
			if (this.sourceReloadAuthority !== authority || !this.rollbackSourceMatches(candidateText)) break;
			await restoreSourceText(authority.text);
			if (this.rollbackSourceMatches(authority.text)) break;
		}
		if (this.rollbackSourceMatches(candidateText)) return false;
		this.rollbackFailed = false;
		this.rollbackFailedCandidate = undefined;
		return true;
	}

	private ensureInitialProjectionRun(requestId: string | undefined, allowFollowUp: boolean): Promise<boolean> {
		if (this.initialized) return Promise.resolve(true);
		if (this.initialProjectionRecovery) {
			const sourceText = this.readSourceTextSafely();
			if (sourceText !== undefined && this.initialProjectionRecoverySourceText !== undefined
				&& sourceText !== this.initialProjectionRecoverySourceText) {
				this.initialProjectionRestartRequested = true;
			}
			return this.initialProjectionRecovery;
		}
		const sourceText = this.readSourceTextSafely();
		if (sourceText === undefined) return Promise.resolve(false);
		if (this.initialProjectionExhaustedSourceText !== undefined
			&& sourceText === this.initialProjectionExhaustedSourceText) {
			return Promise.resolve(false);
		}
		this.initialProjectionRecoverySourceText = sourceText;
		const run = this.postInitialProjection(sourceText, requestId).then(delivered => {
			if (delivered) {
				this.initialized = true;
				this.initialProjectionExhaustedSourceText = undefined;
			}
			return delivered;
		});
		this.initialProjectionRecovery = run;
		const settle = () => {
			if (this.initialProjectionRecovery !== run) return;
			const settledSourceText = this.readSourceTextSafely() ?? sourceText;
			this.initialProjectionRecovery = undefined;
			this.initialProjectionRecoverySourceText = undefined;
			const restart = !this.initialized
				&& this.initialProjectionRestartRequested
				&& sourceText !== settledSourceText
				&& allowFollowUp
				&& !this.options.isDisposed();
			this.initialProjectionRestartRequested = false;
			if (!this.initialized) this.initialProjectionExhaustedSourceText = sourceText;
			if (restart) {
				this.initialProjectionExhaustedSourceText = undefined;
				void this.ensureInitialProjectionRun(undefined, false).catch(() => undefined);
			}
		};
		void run.then(settle, settle);
		return run;
	}

	private readSourceTextSafely(): string | undefined {
		try {
			return this.options.readSourceText();
		} catch {
			return undefined;
		}
	}

	private async postInitialProjection(sourceText: string, requestId?: string): Promise<boolean> {
		for (let attempt = 0;
			attempt < this.initialProjectionMaxAttempts && !this.options.isDisposed();
			attempt++) {
			const currentSourceText = this.readSourceTextSafely();
			if (currentSourceText === undefined || sourceText !== currentSourceText) return false;
			if (await this.project({ forceReload: true, requestId, retirePersists: true })) return true;
		}
		return false;
	}

	private retirePendingProjection(): void {
		const pending = this.pendingProjection;
		if (!pending) return;
		if (this.pendingReloadRequestId) this.options.session.failReload(this.pendingReloadRequestId);
		this.pendingReloadRequestId = undefined;
		this.pendingProjection = undefined;
	}

	private isProjectionCurrent(identity: ProjectionIdentity): boolean {
		return !this.options.isDisposed()
			&& this.pendingProjection === identity
			&& this.projectionGeneration === identity.generation
			&& this.projectionSourceMatches(identity.sourceText);
	}

	private projectionSourceMatches(expected: string): boolean {
		try {
			return this.options.readSourceText() === expected;
		} catch {
			return false;
		}
	}

	private rollbackSourceMatches(expected: string): boolean {
		try {
			return this.sameSourceText(this.options.readSourceText(), expected);
		} catch {
			return false;
		}
	}

	private validRevision(value: unknown): number | undefined {
		const revision = Number(value);
		return Number.isSafeInteger(revision) && revision >= 0 ? revision : undefined;
	}
}
