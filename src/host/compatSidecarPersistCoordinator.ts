import type {
	CompatibilityPersistencePersistSnapshot,
	CompatibilityPersistenceState,
	CompatibilityPersistenceUnavailableFinalPersist,
} from '../shared/compatibilityPersistenceProtocol';
import type { KqlxFileV1, KqlxStateV1 } from './kqlxFormat';
import type { CompatSidecarProjectionCoordinatorContract } from './compatSidecarProjectionCoordinator';
import type { CompatSidecarSession } from './compatSidecarSession';

export type CompatSidecarPersistMessage =
	| CompatibilityPersistencePersistSnapshot
	| CompatibilityPersistenceUnavailableFinalPersist;

export type CompatSidecarPersistTerminal =
	| 'ignored-final'
	| 'load-error'
	| 'unavailable'
	| 'invalid'
	| 'generation-rejected'
	| 'noop'
	| 'closing'
	| 'stale'
	| 'superseded'
	| 'prepare-failed'
	| 'materialize-failed'
	| 'source-rejected'
	| 'source-drift'
	| 'rollback-failed'
	| 'failed'
	| 'applied';

export type CompatSidecarPersistResult = Readonly<{
	terminal: CompatSidecarPersistTerminal;
	error?: Error;
}>;

export type CompatSidecarPersistAcknowledgement = Readonly<{
	type: 'persistDocumentAck';
	snapshotId: string;
	editRevision: number;
}>;

export interface CompatSidecarPersistPhysicalAdapter {
	captureState(state: CompatibilityPersistenceState): KqlxStateV1;
	validateState(state: KqlxStateV1, allowPendingUpgrade: boolean): void;
	sanitizeState(state: KqlxStateV1): Promise<KqlxStateV1>;
	prepareMaterializedDraft(state: KqlxStateV1): KqlxFileV1 | undefined;
	materializeState(state: KqlxStateV1): Promise<KqlxFileV1 | undefined>;
	serializeMaterialized(file: KqlxFileV1): string;
	getLastWrittenMaterializedText(): string | undefined;
	getPrimaryText(state: KqlxStateV1): string;
	readSourceText(): string;
	applySourceText(text: string): Promise<boolean>;
	requestSourceReload(): void;
	setKnownState(state: KqlxStateV1): void;
	setMaterializedSidecar(file: KqlxFileV1): void;
	publishChanges(state: KqlxStateV1): void;
	notifyPreparationFailure(error: unknown): void;
}

export interface CompatSidecarPersistCoordinatorOptions {
	readonly session: CompatSidecarSession;
	readonly projection: CompatSidecarProjectionCoordinatorContract;
	readonly languageLabel: 'KQL' | 'SQL';
	readonly getLoadError: () => string | undefined;
	readonly allowMissingSourceGeneration: boolean;
	readonly allowTestOnlyNoop: boolean;
	readonly isLive: () => boolean;
	readonly postMessage: (
		message: CompatSidecarPersistAcknowledgement,
	) => boolean | PromiseLike<boolean>;
	readonly warnUnavailable: () => void;
	readonly adapter: CompatSidecarPersistPhysicalAdapter;
}

export interface CompatSidecarPersistCoordinatorContract {
	persist(message: CompatSidecarPersistMessage): Promise<CompatSidecarPersistResult>;
}

export type CompatSidecarPersistCoordinatorFactory = (
	options: CompatSidecarPersistCoordinatorOptions,
) => CompatSidecarPersistCoordinatorContract;

type WorkOutcome = Readonly<{
	terminal: CompatSidecarPersistTerminal;
	ok: boolean;
	error?: Error;
}>;

export class CompatSidecarPersistCoordinator implements CompatSidecarPersistCoordinatorContract {
	constructor(private readonly options: CompatSidecarPersistCoordinatorOptions) {}

	async persist(message: CompatSidecarPersistMessage): Promise<CompatSidecarPersistResult> {
		const session = this.options.session;
		const projection = this.options.projection;
		const adapter = this.options.adapter;
		const flushRequestId = this.nonEmptyTrimmed(message.flushRequestId);
		let finalSettlementAttempted = false;
		const settleFinal = (error?: Error): boolean => {
			if (!flushRequestId || finalSettlementAttempted) return false;
			finalSettlementAttempted = true;
			return session.completeFinalPersist(flushRequestId, error);
		};

		if (flushRequestId && !session.hasPendingFinalPersistRequest(flushRequestId)) {
			return { terminal: 'ignored-final' };
		}
		const loadError = this.options.getLoadError();
		if (loadError) {
			const error = new Error(loadError);
			settleFinal(error);
			return { terminal: 'load-error', error };
		}
		if ('flushUnavailableReason' in message) {
			this.options.warnUnavailable();
			settleFinal();
			return { terminal: 'unavailable' };
		}

		const snapshotId = this.nonEmptyTrimmed(message.snapshotId);
		const rawState = adapter.captureState(message.state);
		try {
			adapter.validateState(rawState, session.hasPendingUpgrade);
		} catch (error) {
			const failure = this.asError(error);
			settleFinal(failure);
			return { terminal: 'invalid', error: failure };
		}
		if (!projection.admitPersist({
			sourceGeneration: message.sourceGeneration,
			editRevision: message.editRevision,
			requireCurrentGeneration: !!(snapshotId || flushRequestId),
			allowMissingSourceGeneration: this.options.allowMissingSourceGeneration,
		})) {
			const error = new Error(
				`The final ${this.options.languageLabel} metadata snapshot belonged to an older source projection.`,
			);
			settleFinal(error);
			return { terminal: 'generation-rejected', error };
		}

		if (message.testOnlyNoop === true && this.options.allowTestOnlyNoop) {
			if (session.isStaleRevision(message.editRevision)) {
				const error = this.staleError();
				settleFinal(error);
				return { terminal: 'stale', error };
			}
			session.adoptRevision(message.editRevision, 'replace');
			this.attemptAcknowledgement(snapshotId, session.currentEditRevision);
			settleFinal();
			session.markBeforeUnload(message.reason);
			return { terminal: 'noop' };
		}
		if (session.isClosing) {
			const error = new Error(
				`The ${this.options.languageLabel} metadata editor closed before its final snapshot was admitted.`,
			);
			settleFinal(error);
			return { terminal: 'closing', error };
		}
		if (session.isStaleRevision(message.editRevision)) {
			const error = this.staleError();
			settleFinal(error);
			session.markBeforeUnload(message.reason);
			return { terminal: 'stale', error };
		}

		const incomingEditRevision = message.editRevision;
		const reloadEpochAtAdmission = projection.captureSourceReloadEpoch();
		const run = session.queuePersist(incomingEditRevision, async persistIsCurrent => {
			if (!persistIsCurrent()) return this.supersededOutcome();
			try {
				adapter.validateState(rawState, false);
			} catch (error) {
				return this.failedOutcome('invalid', this.asError(error));
			}
			if (!persistIsCurrent()) return this.supersededOutcome();
			session.adoptRevision(incomingEditRevision);

			let state: KqlxStateV1;
			try {
				state = await adapter.sanitizeState(rawState);
			} catch (error) {
				adapter.notifyPreparationFailure(error);
				return this.failedOutcome(
					'prepare-failed',
					new Error(`Failed to prepare ${this.options.languageLabel} companion metadata: ${this.errorMessage(error)}`),
				);
			}
			if (!persistIsCurrent()) return this.supersededOutcome();

			let validatedDraft: KqlxFileV1 | undefined;
			let materializedSidecar: KqlxFileV1 | undefined;
			try {
				validatedDraft = adapter.prepareMaterializedDraft(state);
				materializedSidecar = await adapter.materializeState(state);
			} catch (error) {
				if (validatedDraft && persistIsCurrent()
					&& this.sameSourceText(adapter.getPrimaryText(state), this.readSourceTextOrEmpty())) {
					adapter.setKnownState(state);
					session.setStateRevision(incomingEditRevision);
					const lastWrittenText = adapter.getLastWrittenMaterializedText();
					const draftText = adapter.serializeMaterialized(validatedDraft);
					session.setMaterializedDirty(draftText !== lastWrittenText, lastWrittenText);
					adapter.publishChanges(state);
				}
				adapter.notifyPreparationFailure(error);
				return this.failedOutcome(
					'materialize-failed',
					new Error(`Failed to materialize ${this.options.languageLabel} companion metadata: ${this.errorMessage(error)}`),
				);
			}
			if (!persistIsCurrent()) return this.supersededOutcome();

			const nextText = adapter.getPrimaryText(state);
			const currentText = this.readSourceTextOrEmpty();
			const textActuallyChanged = !this.sameSourceText(nextText, currentText);
			const wouldBlankFile = !nextText.trim() && !!currentText.trim();
			if (textActuallyChanged && !wouldBlankFile) {
				if (!await adapter.applySourceText(nextText)) {
					return this.failedOutcome(
						'source-rejected',
						new Error(`VS Code rejected the final ${this.options.languageLabel} text update.`),
					);
				}
				if (!this.sameSourceText(adapter.readSourceText(), nextText)) {
					adapter.requestSourceReload();
					return this.failedOutcome('source-drift', this.supersededError());
				}
				if (!persistIsCurrent()) {
					const rolledBack = await projection.rollbackSupersededSourceEdit(
						reloadEpochAtAdmission,
						nextText,
						authoritativeText => adapter.applySourceText(authoritativeText),
					);
					return this.failedOutcome(
						rolledBack ? 'superseded' : 'rollback-failed',
						this.supersededError(),
					);
				}
			}

			if (!persistIsCurrent()) return this.supersededOutcome();
			adapter.setKnownState(state);
			session.setStateRevision(incomingEditRevision);
			if (materializedSidecar) {
				const lastWrittenText = adapter.getLastWrittenMaterializedText();
				const materializedText = adapter.serializeMaterialized(materializedSidecar);
				adapter.setMaterializedSidecar(materializedSidecar);
				session.setMaterializedDirty(materializedText !== lastWrittenText, lastWrittenText);
			}
			adapter.publishChanges(state);
			return { terminal: 'applied', ok: true } as const;
		});
		session.markBeforeUnload(message.reason);

		try {
			const outcome = await run;
			if (!outcome.ok) {
				settleFinal(outcome.error);
				return { terminal: outcome.terminal, error: outcome.error };
			}
			this.attemptAcknowledgement(snapshotId, incomingEditRevision);
			settleFinal();
			return { terminal: 'applied' };
		} catch (error) {
			const failure = new Error(
				`Failed to admit the final ${this.options.languageLabel} metadata snapshot: ${this.errorMessage(error)}`,
			);
			settleFinal(failure);
			return { terminal: 'failed', error: failure };
		}
	}

	private attemptAcknowledgement(snapshotId: string, editRevision: number): void {
		if (!snapshotId || !this.options.isLive()) return;
		try {
			void Promise.resolve(this.options.postMessage({
				type: 'persistDocumentAck',
				snapshotId,
				editRevision,
			})).catch(() => undefined);
		} catch {
			// Acknowledgement transport does not change the admitted snapshot.
		}
	}

	private readSourceTextOrEmpty(): string {
		try {
			return this.options.adapter.readSourceText();
		} catch {
			return '';
		}
	}

	private sameSourceText(left: string, right: string): boolean {
		return left.replace(/\r\n/g, '\n') === right.replace(/\r\n/g, '\n');
	}

	private staleError(): Error {
		return new Error(`The final ${this.options.languageLabel} metadata snapshot was stale.`);
	}

	private supersededError(): Error {
		return new Error(`The ${this.options.languageLabel} metadata snapshot was superseded before admission.`);
	}

	private supersededOutcome(): WorkOutcome {
		return this.failedOutcome('superseded', this.supersededError());
	}

	private failedOutcome(terminal: CompatSidecarPersistTerminal, error: Error): WorkOutcome {
		return { terminal, ok: false, error };
	}

	private nonEmptyTrimmed(value: unknown): string {
		return typeof value === 'string' ? value.trim() : '';
	}

	private asError(error: unknown): Error {
		return error instanceof Error ? error : new Error(String(error));
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}