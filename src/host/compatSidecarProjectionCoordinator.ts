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
	readonly isDisposed: () => boolean;
	readonly postProjection: (attempt: CompatSidecarProjectionAttempt) => Promise<boolean>;
	readonly onProjectionSettled?: (
		attempt: CompatSidecarProjectionAttempt,
		applied: boolean,
	) => boolean | void | Promise<boolean | void>;
	readonly initialProjectionMaxAttempts?: number;
	readonly createRequestId?: () => string;
	readonly sameSourceText?: (left: string, right: string) => boolean;
}

export interface CompatSidecarProjectionCoordinatorContract {
	readonly isInitialized: boolean;
	readonly activeSourceGeneration: number;
	readonly sourceRollbackFailed: boolean;
	project(request?: CompatSidecarProjectionRequest): Promise<boolean>;
	requestDocument(requestId: string, expectedEditRevision?: number): Promise<boolean>;
	requestSourceReload(): Promise<boolean>;
	ensureInitialProjection(requestId?: string): Promise<boolean>;
	completeReload(result: CompatSidecarReloadResult): boolean;
	waitForAcknowledgedProjection(sourceGeneration: unknown): Promise<void>;
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

type ProjectionIdentity = Readonly<{
	generation: number;
	sourceText: string;
	expectedEditRevision?: number;
}>;

const DEFAULT_INITIAL_PROJECTION_MAX_ATTEMPTS = 3;
const SOURCE_ROLLBACK_MAX_ATTEMPTS = 3;

export class CompatSidecarProjectionCoordinator implements CompatSidecarProjectionCoordinatorContract {
	private projectionGeneration = 0;
	private activeGeneration = 0;
	private activeSourceText: string;
	private pendingProjection: ProjectionIdentity | undefined;
	private pendingReloadRequestId: string | undefined;
	private readonly projectionSettlements = new Map<number, Promise<boolean>>();
	private acknowledgedProjectionGeneration: number | undefined;
	private initialized = false;
	private initialProjectionRecovery: Promise<boolean> | undefined;
	private initialProjectionRecoverySourceText: string | undefined;
	private initialProjectionExhaustedSourceText: string | undefined;
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

	get activeSourceGeneration(): number {
		return this.activeGeneration;
	}

	get sourceRollbackFailed(): boolean {
		return this.rollbackFailed;
	}

	project(request: CompatSidecarProjectionRequest = {}): Promise<boolean> {
		if (this.options.isDisposed()) return Promise.resolve(false);
		const projection = this.runProjection(request);
		const generation = this.projectionGeneration;
		this.projectionSettlements.set(generation, projection);
		const release = () => {
			if (this.projectionSettlements.get(generation) === projection) {
				this.projectionSettlements.delete(generation);
			}
			if (this.acknowledgedProjectionGeneration === generation) {
				this.acknowledgedProjectionGeneration = undefined;
			}
		};
		void projection.then(release, release);
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
		if (!this.initialized) return this.ensureInitialProjection(requestId);
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

	async waitForAcknowledgedProjection(sourceGeneration: unknown): Promise<void> {
		const generation = Number(sourceGeneration);
		if (!Number.isSafeInteger(generation)
			|| this.acknowledgedProjectionGeneration !== generation) return;
		await this.projectionSettlements.get(generation)?.catch(() => false);
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
