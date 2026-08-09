import type * as vscode from 'vscode';

import type { KustoExecutionCoordinator } from './kustoExecutionCoordinator';
import type { IncomingWebviewMessage } from './queryEditorTypes';
import type { SqlEditorLifecycleCoordinator } from './sql/sqlEditorLifecycleCoordinator';
import type { SqlExecutionBroker } from './sql/sqlExecutionBroker';
import type { SqlComparisonOwner } from './sql/sqlEditorSessionRegistry';
import type { SqlWorkbenchService } from './sql/sqlWorkbenchService';
import {
	hasKustoCopilotRequestIdentity,
	kustoCopilotRequestIdentityEquals,
	type KustoCopilotRequestIdentity,
	type PreparedComparisonSection,
} from '../shared/kustoExecution';

type PendingComparisonEnsure = {
	resolve: (comparison: PreparedComparisonSection) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	sourceBoxId: string;
	sqlConnectionId?: string;
	sqlSourceSectionInstanceId?: string;
	sqlSourceTargetGeneration?: number;
	sqlSourceDatabase?: string;
	copilotSequence?: number;
	kustoRequest?: KustoCopilotRequestIdentity;
	comparisonBoxId?: string;
	cancellationDisposable?: vscode.Disposable;
	previousSqlComparisonOwnerCaptured?: boolean;
	previousSqlComparisonOwner?: SqlComparisonOwner;
	provisionalSqlComparisonOwner?: SqlComparisonOwner;
	rollbackInProgress?: boolean;
	rollbackRetryTimer?: ReturnType<typeof setTimeout>;
	completionStarted?: boolean;
	sqlAdmissionAck?: {
		comparisonBoxId: string;
		phase: 'staged' | 'committed' | 'finalized' | 'completed' | 'rolledBack';
		resolve: (accepted: boolean) => void;
		timer: ReturnType<typeof setTimeout>;
	};
};

type KustoComparisonOwner = {
	sourceBoxId: string;
	copilotSequence?: number;
	comparisonRequestId?: string;
};

export interface ComparisonPreparationApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	ensureComparisonBoxInWebview(
		sourceBoxId: string,
		comparisonQuery: string,
		token: vscode.CancellationToken,
		copilotSequence?: number,
		kustoRequest?: KustoCopilotRequestIdentity,
	): Promise<PreparedComparisonSection>;
	rejectPendingComparisonEnsures(sourceBoxId: string): void;
	dispose(): void;
}

export type ComparisonPreparationApplicationHandlerOptions = {
	sqlLifecycle: Pick<SqlEditorLifecycleCoordinator,
		'getConnectionId'
		| 'getSectionInstanceId'
		| 'getGeneration'
		| 'getTarget'
		| 'isSectionCurrent'
		| 'getComparisonOwner'
		| 'setComparisonOwner'
		| 'removeComparisonOwner'>;
	sqlExecutionBroker: Pick<SqlExecutionBroker, 'supersede'>;
	sqlWorkbench: Pick<SqlWorkbenchService, 'assertSqlConnectionAllowed'>;
	kustoExecutionCoordinator: Pick<KustoExecutionCoordinator,
		'openSection' | 'adoptTarget' | 'getActive' | 'cancelExpected'>;
	postMessage(message: unknown): boolean | PromiseLike<boolean>;
	hasWebview(): boolean;
	cancelCopilotQueryTarget(sourceBoxId: string, targetBoxId: string, expectedSequence: number): void;
	cancelCopilotWriteQuery(boxId: string, expectedSequence: number): void;
	createRequestId(): string;
};

export class HostComparisonPreparationApplicationHandler
	implements ComparisonPreparationApplicationHandler {
	private readonly pendingComparisonEnsureByRequestId = new Map<string, PendingComparisonEnsure>();
	private readonly comparisonOwnerByBoxId = new Map<string, KustoComparisonOwner>();
	private disposed = false;

	constructor(private readonly options: ComparisonPreparationApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		switch (message.type) {
			case 'sqlComparisonAdmissionAck':
				if (this.disposed) return Promise.resolve();
				this.handleSqlComparisonAdmissionAck(message);
				return Promise.resolve();
			case 'comparisonBoxEnsured':
				if (this.disposed) return Promise.resolve();
				return this.handleComparisonBoxEnsured(message);
			case 'sqlComparisonRemoved':
				if (this.disposed) return Promise.resolve();
				this.handleSqlComparisonRemoved(message);
				return Promise.resolve();
			default:
				return undefined;
		}
	}

	async ensureComparisonBoxInWebview(
		sourceBoxId: string,
		comparisonQuery: string,
		token: vscode.CancellationToken,
		copilotSequence?: number,
		kustoRequest?: KustoCopilotRequestIdentity,
	): Promise<PreparedComparisonSection> {
		if (this.disposed) throw new Error('Canceled');
		if (!this.options.hasWebview()) throw new Error('Webview panel is not available');
		const requestId = this.options.createRequestId();
		const sqlConnectionId = this.options.sqlLifecycle.getConnectionId(sourceBoxId);
		const sqlSourceSectionInstanceId = sqlConnectionId
			? String(this.options.sqlLifecycle.getSectionInstanceId(sourceBoxId) || '').trim()
			: '';
		const sqlSourceTargetGeneration = sqlConnectionId
			? this.options.sqlLifecycle.getGeneration(sourceBoxId)
			: undefined;
		const sqlSourceDatabase = sqlConnectionId
			? String(this.options.sqlLifecycle.getTarget(sourceBoxId)?.database || '').trim()
			: '';
		if (sqlConnectionId && this.options.sqlLifecycle.getComparisonOwner(sourceBoxId)) {
			throw new Error('A derived SQL comparison cannot be used as another comparison source.');
		}
		if (sqlConnectionId && (!sqlSourceSectionInstanceId || !Number.isSafeInteger(sqlSourceTargetGeneration)
			|| !sqlSourceDatabase)) {
			throw new Error('SQL comparison source lifecycle identity is unavailable.');
		}
		if (sqlConnectionId) await this.options.sqlWorkbench.assertSqlConnectionAllowed(sqlConnectionId);
		return await new Promise<PreparedComparisonSection>((resolve, reject) => {
			if (token.isCancellationRequested || this.disposed) {
				reject(new Error('Canceled'));
				return;
			}

			let pending!: PendingComparisonEnsure;
			const timer = setTimeout(() => {
				this.settlePendingComparisonEnsure(
					requestId,
					pending,
					{ error: new Error('Timed out while preparing comparison editor') },
				);
			}, 20_000);

			pending = {
				resolve,
				reject,
				timer,
				sourceBoxId,
				...(sqlConnectionId ? { sqlConnectionId } : {}),
				...(sqlSourceSectionInstanceId ? { sqlSourceSectionInstanceId } : {}),
				...(sqlSourceTargetGeneration !== undefined ? { sqlSourceTargetGeneration } : {}),
				...(sqlSourceDatabase ? { sqlSourceDatabase } : {}),
				...(copilotSequence !== undefined ? { copilotSequence } : {}),
				...(kustoRequest ? { kustoRequest } : {}),
			};
			this.pendingComparisonEnsureByRequestId.set(requestId, pending);

			try {
				this.options.postMessage({
					type: 'ensureComparisonBox',
					requestId,
					boxId: sourceBoxId,
					query: comparisonQuery,
					engine: sqlConnectionId ? 'sql' : 'kusto',
					...(sqlSourceSectionInstanceId ? {
						sourceSectionInstanceId: sqlSourceSectionInstanceId,
						sourceTargetGeneration: sqlSourceTargetGeneration,
					} : {}),
					...(kustoRequest || {}),
				});
			} catch (error) {
				try { clearTimeout(timer); } catch { /* ignore */ }
				this.pendingComparisonEnsureByRequestId.delete(requestId);
				try { pending.cancellationDisposable?.dispose(); } catch { /* ignore */ }
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}

			try {
				pending.cancellationDisposable = token.onCancellationRequested(() => {
					const current = this.pendingComparisonEnsureByRequestId.get(requestId);
					if (!current) return;
					this.settlePendingComparisonEnsure(requestId, current, { error: new Error('Canceled') });
				});
			} catch {
				// ignore
			}
		});
	}

	rejectPendingComparisonEnsures(sourceBoxId: string): void {
		if (this.disposed) return;
		for (const [requestId, pending] of [...this.pendingComparisonEnsureByRequestId]) {
			if (pending.sourceBoxId === sourceBoxId) {
				this.settlePendingComparisonEnsure(requestId, pending, { error: new Error('Canceled') });
			}
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const [requestId, pending] of [...this.pendingComparisonEnsureByRequestId]) {
			this.settlePendingComparisonEnsure(requestId, pending, { error: new Error('Canceled') });
		}
		this.comparisonOwnerByBoxId.clear();
	}

	private handleSqlComparisonAdmissionAck(
		message: Extract<IncomingWebviewMessage, { type: 'sqlComparisonAdmissionAck' }>,
	): void {
		const requestId = String(message.requestId || '').trim();
		const comparisonBoxId = String(message.comparisonBoxId || '').trim();
		const pending = requestId ? this.pendingComparisonEnsureByRequestId.get(requestId) : undefined;
		const admissionAck = pending?.sqlAdmissionAck;
		if (!pending || !admissionAck
			|| comparisonBoxId !== admissionAck.comparisonBoxId
			|| message.phase !== admissionAck.phase
			|| String(message.sourceBoxId || '').trim() !== pending.sourceBoxId) return;
		if (message.phase === 'finalized' && message.accepted === true) {
			this.markCompletionStarted(pending);
		}
		admissionAck.resolve(message.accepted === true);
	}

	private async handleComparisonBoxEnsured(
		message: Extract<IncomingWebviewMessage, { type: 'comparisonBoxEnsured' }>,
	): Promise<void> {
		try {
			const requestId = String(message.requestId || '');
			const comparisonBoxId = String(message.comparisonBoxId || '');
			const pending = requestId ? this.pendingComparisonEnsureByRequestId.get(requestId) : undefined;
			if (!pending) {
				if (message.engine === 'sql' && requestId && comparisonBoxId) {
					void this.options.postMessage({
						type: 'sqlComparisonAdmissionRollback', requestId,
						sourceBoxId: String(message.sourceBoxId || ''), comparisonBoxId,
					});
				}
				return;
			}
			if (String(message.sourceBoxId || '').trim() !== pending.sourceBoxId) return;
			if (pending.sqlConnectionId && comparisonBoxId) pending.comparisonBoxId = comparisonBoxId;
			if (pending.kustoRequest && (!hasKustoCopilotRequestIdentity(message)
				|| !kustoCopilotRequestIdentityEquals(pending.kustoRequest, message))) return;
			if (pending.sqlConnectionId && (
				String(message.sourceSectionInstanceId || '') !== pending.sqlSourceSectionInstanceId
				|| Number(message.sourceTargetGeneration) !== pending.sqlSourceTargetGeneration
				|| this.options.sqlLifecycle.getSectionInstanceId(pending.sourceBoxId)
					!== pending.sqlSourceSectionInstanceId
				|| this.options.sqlLifecycle.getGeneration(pending.sourceBoxId)
					!== pending.sqlSourceTargetGeneration
				|| this.options.sqlLifecycle.getConnectionId(pending.sourceBoxId) !== pending.sqlConnectionId
			)) {
				this.settlePendingComparisonEnsure(requestId, pending, {
					error: new Error('SQL comparison source changed before preparation completed.'),
				});
				return;
			}
			if (!comparisonBoxId) {
				this.settlePendingComparisonEnsure(requestId, pending, {
					error: new Error('Comparison source was missing, stale, or unavailable.'),
				});
				return;
			}
			if (pending.sqlConnectionId) {
				const comparisonSectionInstanceId = String(message.comparisonSectionInstanceId || '').trim();
				const comparisonTargetGeneration = Number(message.comparisonTargetGeneration);
				const comparisonConnectionId = String(message.comparisonConnectionId || '').trim();
				const comparisonDatabase = String(message.comparisonDatabase || '').trim();
				const comparisonTarget = this.options.sqlLifecycle.getTarget(comparisonBoxId);
				if (comparisonBoxId === pending.sourceBoxId
					|| !comparisonSectionInstanceId || !Number.isSafeInteger(comparisonTargetGeneration)
					|| comparisonConnectionId !== pending.sqlConnectionId
					|| comparisonDatabase.toLowerCase() !== String(pending.sqlSourceDatabase || '').toLowerCase()
					|| !this.options.sqlLifecycle.isSectionCurrent(comparisonBoxId, comparisonSectionInstanceId)
					|| this.options.sqlLifecycle.getGeneration(comparisonBoxId) !== comparisonTargetGeneration
					|| comparisonTarget?.connectionId !== pending.sqlConnectionId
					|| String(comparisonTarget?.database || '').toLowerCase()
						!== String(pending.sqlSourceDatabase || '').toLowerCase()) {
					this.settlePendingComparisonEnsure(requestId, pending, {
						error: new Error('SQL comparison target was missing, stale, self-referential, or mismatched.'),
					});
					return;
				}
			}
			pending.comparisonBoxId = comparisonBoxId;
			if (comparisonBoxId && !pending.sqlConnectionId) {
				this.comparisonOwnerByBoxId.set(comparisonBoxId, {
					sourceBoxId: pending.sourceBoxId,
					...(pending.copilotSequence !== undefined ? { copilotSequence: pending.copilotSequence } : {}),
					comparisonRequestId: requestId,
				});
			}
			if (pending.sqlConnectionId && comparisonBoxId) {
				const provisionalOwner = {
					sourceBoxId: pending.sourceBoxId,
					connectionId: pending.sqlConnectionId,
					...(pending.copilotSequence !== undefined ? { copilotSequence: pending.copilotSequence } : {}),
					comparisonRequestId: requestId,
				};
				pending.previousSqlComparisonOwner = this.options.sqlLifecycle.getComparisonOwner(comparisonBoxId);
				pending.previousSqlComparisonOwnerCaptured = true;
				pending.provisionalSqlComparisonOwner = provisionalOwner;
				try {
					await this.options.sqlWorkbench.assertSqlConnectionAllowed(pending.sqlConnectionId);
					const currentPending = this.pendingComparisonEnsureByRequestId.get(requestId);
					const currentOwner = this.options.sqlLifecycle.getComparisonOwner(comparisonBoxId);
					const currentSourceTarget = this.options.sqlLifecycle.getTarget(pending.sourceBoxId);
					const currentComparisonTarget = this.options.sqlLifecycle.getTarget(comparisonBoxId);
					const identityStillCurrent = currentSourceTarget?.connectionId === pending.sqlConnectionId
						&& String(currentSourceTarget.database || '').toLowerCase()
							=== String(pending.sqlSourceDatabase || '').toLowerCase()
						&& currentSourceTarget.generation === pending.sqlSourceTargetGeneration
						&& this.options.sqlLifecycle.getSectionInstanceId(pending.sourceBoxId)
							=== pending.sqlSourceSectionInstanceId
						&& currentComparisonTarget?.connectionId === pending.sqlConnectionId
						&& String(currentComparisonTarget.database || '').toLowerCase()
							=== String(pending.sqlSourceDatabase || '').toLowerCase()
						&& currentComparisonTarget.generation === Number(message.comparisonTargetGeneration)
						&& this.options.sqlLifecycle.getSectionInstanceId(comparisonBoxId)
							=== String(message.comparisonSectionInstanceId || '');
					if (currentPending !== pending || currentOwner !== pending.previousSqlComparisonOwner
						|| !identityStillCurrent) {
						if (currentPending === pending) {
							this.settlePendingComparisonEnsure(requestId, pending, {
								error: new Error('SQL comparison source or target changed during policy admission.'),
							});
						}
						return;
					}
				} catch (error) {
					const currentPending = this.pendingComparisonEnsureByRequestId.get(requestId);
					if (currentPending !== pending
						|| this.options.sqlLifecycle.getComparisonOwner(comparisonBoxId)
							!== pending.previousSqlComparisonOwner) {
						if (currentPending === pending) {
							this.settlePendingComparisonEnsure(requestId, pending, { error: new Error('Canceled') });
						}
						return;
					}
					this.options.postMessage({
						type: 'sqlCopilotPolicyChanged',
						boxIds: [pending.sourceBoxId, comparisonBoxId],
					});
					this.settlePendingComparisonEnsure(requestId, pending, {
						error: error instanceof Error ? error : new Error(String(error)),
					});
					return;
				}
			}
			if (!pending.sqlConnectionId) {
				const target = message.kustoTarget;
				if (!target || target.boxId !== comparisonBoxId
					|| !this.options.kustoExecutionCoordinator.openSection(target.boxId, target.sectionInstanceId)
					|| !this.options.kustoExecutionCoordinator.adoptTarget(target)) {
					this.settlePendingComparisonEnsure(
						requestId,
						pending,
						{ error: new Error('Comparison target was not ready.') },
					);
					return;
				}
			}
			if (pending.sqlConnectionId) {
				const admitted = await this.waitForSqlComparisonAdmission(
					requestId, pending, comparisonBoxId, 'staged',
				);
				if (!admitted) {
					if (this.pendingComparisonEnsureByRequestId.get(requestId) === pending) {
						this.settlePendingComparisonEnsure(requestId, pending, {
							error: new Error('SQL comparison admission was not applied by the editor.'),
						});
					}
					return;
				}
				const committed = await this.waitForSqlComparisonAdmission(
					requestId, pending, comparisonBoxId, 'committed',
				);
				if (!committed || this.pendingComparisonEnsureByRequestId.get(requestId) !== pending) {
					if (this.pendingComparisonEnsureByRequestId.get(requestId) === pending) {
						this.settlePendingComparisonEnsure(requestId, pending, {
							error: new Error('SQL comparison commit was not applied by the editor.'),
						});
					}
					return;
				}
				if (this.options.sqlLifecycle.getComparisonOwner(comparisonBoxId)
					!== pending.previousSqlComparisonOwner || !pending.provisionalSqlComparisonOwner) {
					this.settlePendingComparisonEnsure(requestId, pending, {
						error: new Error('SQL comparison ownership changed before commit completed.'),
					});
					return;
				}
				const finalized = await this.waitForSqlComparisonAdmission(
					requestId, pending, comparisonBoxId, 'finalized',
				);
				if (!finalized || this.pendingComparisonEnsureByRequestId.get(requestId) !== pending) {
					if (this.pendingComparisonEnsureByRequestId.get(requestId) === pending) {
						this.settlePendingComparisonEnsure(requestId, pending, {
							error: new Error('SQL comparison final validation was not applied by the editor.'),
						});
					}
					return;
				}
				this.markCompletionStarted(pending);
				let completed = false;
				while (!completed && !this.disposed
					&& this.pendingComparisonEnsureByRequestId.get(requestId) === pending) {
					completed = await this.waitForSqlComparisonAdmission(
						requestId, pending, comparisonBoxId, 'completed',
					);
					if (!completed && !this.disposed
						&& this.pendingComparisonEnsureByRequestId.get(requestId) === pending) {
						await new Promise<void>(resolve => setTimeout(resolve, 100));
					}
				}
				if (!completed || this.pendingComparisonEnsureByRequestId.get(requestId) !== pending) return;
				const currentSourceTarget = this.options.sqlLifecycle.getTarget(pending.sourceBoxId);
				const currentComparisonTarget = this.options.sqlLifecycle.getTarget(comparisonBoxId);
				const identitiesRemainCurrent = currentSourceTarget?.connectionId === pending.sqlConnectionId
					&& String(currentSourceTarget.database || '').toLowerCase()
						=== String(pending.sqlSourceDatabase || '').toLowerCase()
					&& currentSourceTarget.generation === pending.sqlSourceTargetGeneration
					&& this.options.sqlLifecycle.getSectionInstanceId(pending.sourceBoxId)
						=== pending.sqlSourceSectionInstanceId
					&& currentComparisonTarget?.connectionId === pending.sqlConnectionId
					&& String(currentComparisonTarget.database || '').toLowerCase()
						=== String(pending.sqlSourceDatabase || '').toLowerCase()
					&& currentComparisonTarget.generation === Number(message.comparisonTargetGeneration)
					&& this.options.sqlLifecycle.getSectionInstanceId(comparisonBoxId)
						=== String(message.comparisonSectionInstanceId || '');
				if (!identitiesRemainCurrent
					|| this.options.sqlLifecycle.getComparisonOwner(comparisonBoxId)
						!== pending.previousSqlComparisonOwner) {
					this.settlePendingComparisonEnsure(requestId, pending, {
						error: new Error('SQL comparison target changed after completion.'),
					}, { rollbackConfirmed: true });
					return;
				}
				this.options.sqlLifecycle.setComparisonOwner(
					comparisonBoxId,
					pending.provisionalSqlComparisonOwner,
				);
				void this.options.postMessage({
					type: 'sqlComparisonAdmissionRelease', outcome: 'completed', requestId,
					sourceBoxId: pending.sourceBoxId, comparisonBoxId,
				});
			}
			this.settlePendingComparisonEnsure(requestId, pending, {
				comparison: {
					boxId: comparisonBoxId,
					...(message.kustoTarget ? { kustoTarget: message.kustoTarget } : {}),
				},
			});
		} catch {
			// ignore
		}
	}

	private handleSqlComparisonRemoved(
		message: Extract<IncomingWebviewMessage, { type: 'sqlComparisonRemoved' }>,
	): void {
		const comparisonBoxId = String(message.boxId || '').trim();
		if (!comparisonBoxId) return;
		const pendingEntry = [...this.pendingComparisonEnsureByRequestId]
			.find(([, pending]) => pending.comparisonBoxId === comparisonBoxId);
		const pendingOwner = this.options.sqlLifecycle.getComparisonOwner(comparisonBoxId);
		const pendingProposalOwner = pendingEntry?.[1].provisionalSqlComparisonOwner;
		if (pendingEntry) {
			this.settlePendingComparisonEnsure(
				pendingEntry[0],
				pendingEntry[1],
				{ error: new Error('Canceled') },
				{ removalConfirmed: pendingEntry[1].completionStarted === true },
			);
		}
		const sqlOwner = this.options.sqlLifecycle.getComparisonOwner(comparisonBoxId);
		const owner = sqlOwner ?? pendingOwner ?? pendingProposalOwner
			?? this.comparisonOwnerByBoxId.get(comparisonBoxId);
		if (!owner) return;
		if (sqlOwner) {
			this.options.sqlExecutionBroker.supersede(comparisonBoxId, { notifyWebview: true });
			this.options.sqlLifecycle.removeComparisonOwner(comparisonBoxId);
		} else {
			this.comparisonOwnerByBoxId.delete(comparisonBoxId);
		}
		if (owner.comparisonRequestId) {
			const pending = this.pendingComparisonEnsureByRequestId.get(owner.comparisonRequestId);
			if (pending) {
				this.settlePendingComparisonEnsure(
					owner.comparisonRequestId, pending, { error: new Error('Canceled') },
				);
			}
		}
		if (!sqlOwner) {
			const active = this.options.kustoExecutionCoordinator.getActive(comparisonBoxId);
			if (active) this.options.kustoExecutionCoordinator.cancelExpected(active);
		}
		if (owner.copilotSequence !== undefined) {
			this.options.cancelCopilotQueryTarget(owner.sourceBoxId, comparisonBoxId, owner.copilotSequence);
		}
		const messageSourceBoxId = String(message.sourceBoxId || '').trim();
		if (messageSourceBoxId !== owner.sourceBoxId) return;
		if (owner.copilotSequence !== undefined) {
			this.options.cancelCopilotWriteQuery(owner.sourceBoxId, owner.copilotSequence);
		}
	}

	private markCompletionStarted(pending: PendingComparisonEnsure): void {
		if (pending.completionStarted) return;
		pending.completionStarted = true;
		try { clearTimeout(pending.timer); } catch { /* ignore */ }
		try { pending.cancellationDisposable?.dispose(); } catch { /* ignore */ }
		pending.cancellationDisposable = undefined;
	}

	private settlePendingComparisonEnsure(
		requestId: string,
		pending: PendingComparisonEnsure,
		outcome: { comparison: PreparedComparisonSection } | { error: Error },
		options: { rollbackConfirmed?: boolean; removalConfirmed?: boolean } = {},
	): void {
		if (this.pendingComparisonEnsureByRequestId.get(requestId) !== pending) return;
		const terminalWithoutRollback = options.rollbackConfirmed === true
			|| options.removalConfirmed === true;
		if ('error' in outcome && pending.completionStarted
			&& !terminalWithoutRollback && !this.disposed) return;
		if ('error' in outcome && pending.sqlConnectionId && pending.comparisonBoxId
			&& !terminalWithoutRollback && !this.disposed) {
			void this.rollbackPendingSqlComparison(requestId, pending, outcome.error);
			return;
		}
		this.pendingComparisonEnsureByRequestId.delete(requestId);
		try { clearTimeout(pending.timer); } catch { /* ignore */ }
		try { if (pending.rollbackRetryTimer) clearTimeout(pending.rollbackRetryTimer); } catch { /* ignore */ }
		try { pending.cancellationDisposable?.dispose(); } catch { /* ignore */ }
		if (pending.sqlAdmissionAck) {
			const admissionAck = pending.sqlAdmissionAck;
			pending.sqlAdmissionAck = undefined;
			try { clearTimeout(admissionAck.timer); } catch { /* ignore */ }
			admissionAck.resolve(false);
		}
		if ('error' in outcome) {
			const comparisonBoxId = String(pending.comparisonBoxId || '').trim();
			if (comparisonBoxId
				&& this.comparisonOwnerByBoxId.get(comparisonBoxId)?.comparisonRequestId === requestId) {
				this.comparisonOwnerByBoxId.delete(comparisonBoxId);
			}
			if (comparisonBoxId
				&& this.options.sqlLifecycle.getComparisonOwner(comparisonBoxId)?.comparisonRequestId === requestId) {
				this.options.sqlLifecycle.removeComparisonOwner(comparisonBoxId);
			}
			pending.reject(outcome.error);
			return;
		}
		pending.resolve(outcome.comparison);
	}

	private async rollbackPendingSqlComparison(
		requestId: string,
		pending: PendingComparisonEnsure,
		error: Error,
	): Promise<void> {
		if (this.pendingComparisonEnsureByRequestId.get(requestId) !== pending || pending.rollbackInProgress) return;
		pending.rollbackInProgress = true;
		try { clearTimeout(pending.timer); } catch { /* ignore */ }
		if (pending.sqlAdmissionAck) {
			const currentAck = pending.sqlAdmissionAck;
			pending.sqlAdmissionAck = undefined;
			try { clearTimeout(currentAck.timer); } catch { /* ignore */ }
			currentAck.resolve(false);
		}
		const comparisonBoxId = String(pending.comparisonBoxId || '').trim();
		let rolledBack = false;
		for (let attempt = 0; attempt < 3 && !rolledBack; attempt += 1) {
			if (this.pendingComparisonEnsureByRequestId.get(requestId) !== pending || this.disposed) return;
			rolledBack = await this.waitForSqlComparisonAdmission(
				requestId, pending, comparisonBoxId, 'rolledBack',
			);
		}
		if (this.pendingComparisonEnsureByRequestId.get(requestId) !== pending) return;
		if (!rolledBack) {
			pending.rollbackInProgress = false;
			pending.rollbackRetryTimer = setTimeout(() => {
				pending.rollbackRetryTimer = undefined;
				void this.rollbackPendingSqlComparison(requestId, pending, error);
			}, 1_000);
			return;
		}
		pending.rollbackInProgress = false;
		void this.options.postMessage({
			type: 'sqlComparisonAdmissionRelease', outcome: 'rolledBack', requestId,
			sourceBoxId: pending.sourceBoxId, comparisonBoxId,
		});
		this.settlePendingComparisonEnsure(requestId, pending, { error }, { rollbackConfirmed: true });
	}

	private waitForSqlComparisonAdmission(
		requestId: string,
		pending: PendingComparisonEnsure,
		comparisonBoxId: string,
		phase: 'staged' | 'committed' | 'finalized' | 'completed' | 'rolledBack',
	): Promise<boolean> {
		if (this.pendingComparisonEnsureByRequestId.get(requestId) !== pending) return Promise.resolve(false);
		return new Promise<boolean>(resolve => {
			let settled = false;
			const complete = (accepted: boolean) => {
				if (settled) return;
				settled = true;
				const admissionAck = pending.sqlAdmissionAck;
				if (admissionAck?.comparisonBoxId === comparisonBoxId && admissionAck.phase === phase) {
					pending.sqlAdmissionAck = undefined;
					try { clearTimeout(admissionAck.timer); } catch { /* ignore */ }
				}
				resolve(accepted);
			};
			const timer = setTimeout(() => complete(false), 5_000);
			pending.sqlAdmissionAck = { comparisonBoxId, phase, resolve: complete, timer };
			void Promise.resolve(this.options.postMessage({
				type: phase === 'staged' ? 'sqlComparisonAdmission'
					: phase === 'committed' ? 'sqlComparisonAdmissionCommit'
						: phase === 'finalized' ? 'sqlComparisonAdmissionFinalize'
							: phase === 'completed' ? 'sqlComparisonAdmissionComplete'
								: 'sqlComparisonAdmissionRollback',
				requestId, sourceBoxId: pending.sourceBoxId, comparisonBoxId,
				...(phase === 'staged' ? { accepted: true } : {}),
			})).then(delivered => {
				if (delivered === false) complete(false);
			}, () => complete(false));
		});
	}
}
