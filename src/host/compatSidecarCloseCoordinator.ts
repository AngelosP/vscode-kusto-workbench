import type * as vscode from 'vscode';

import type { KqlxStateV1 } from './kqlxFormat';
import type { CompatSidecarSession } from './compatSidecarSession';

type CloseGateway = Readonly<{
	closeRetiredInboundAdmission(): Promise<void>;
}>;

export type CompatSidecarCloseDraft = Readonly<{
	uri: vscode.Uri;
	state: KqlxStateV1;
	displayName: string;
}>;

export type CompatSidecarCloseFinalization = Readonly<{
	gateway: CloseGateway;
	subscriptions: readonly vscode.Disposable[];
	captureDraft(): CompatSidecarCloseDraft | undefined;
	promptSave(displayName: string): PromiseLike<'Save' | 'Discard' | undefined>;
	saveDraft(draft: CompatSidecarCloseDraft): Promise<void>;
	recoverDraft(draft: CompatSidecarCloseDraft): Promise<vscode.Uri>;
	notifyRecovered(uri: vscode.Uri): void;
	notifySaveFailed(error: unknown): void;
	repair(): Promise<void>;
	drainStore(): Promise<void>;
}>;

export type CompatSidecarCloseCoordinatorOptions = Readonly<{
	session: CompatSidecarSession;
	yieldTurn?: () => Promise<void>;
}>;

export type CompatSidecarCloseFailureCleanup = Readonly<{
	gateway: CloseGateway;
	subscriptions: readonly vscode.Disposable[];
}>;

export interface CompatSidecarCloseCoordinatorPort {
	allowRetiredInbound(message: unknown): boolean;
	isPendingFinalPersistReply(message: unknown): boolean;
	configure(finalization: CompatSidecarCloseFinalization): void;
	failInitialization(cleanup: CompatSidecarCloseFailureCleanup): Promise<void>;
	disposePanel(): Promise<void>;
}

export type CompatSidecarCloseCoordinatorFactory = (
	options: CompatSidecarCloseCoordinatorOptions,
) => CompatSidecarCloseCoordinatorPort;

export class CompatSidecarCloseCoordinator implements CompatSidecarCloseCoordinatorPort {
	private finalization?: CompatSidecarCloseFinalization;
	private panelDisposed = false;
	private closeStarted = false;
	private retiredAdmissionOpen = true;
	private readonly disposedSubscriptions = new Set<vscode.Disposable>();
	private resolveClose!: () => void;
	private readonly closeResult = new Promise<void>(resolve => { this.resolveClose = resolve; });

	constructor(private readonly options: CompatSidecarCloseCoordinatorOptions) {}

	allowRetiredInbound(message: unknown): boolean {
		if (!this.retiredAdmissionOpen || !isPersistDocumentMessage(message)) return false;
		if (String(message.reason || '') === 'beforeunload') return true;
		return this.options.session.hasPendingFinalPersistRequest(String(message.flushRequestId || ''));
	}

	isPendingFinalPersistReply(message: unknown): boolean {
		return isPersistDocumentMessage(message)
			&& this.options.session.hasPendingFinalPersistRequest(String(message.flushRequestId || ''));
	}

	configure(finalization: CompatSidecarCloseFinalization): void {
		if (this.finalization && this.finalization !== finalization) {
			throw new Error('The compatibility close coordinator is already configured.');
		}
		this.finalization = finalization;
		this.startCloseIfReady();
	}

	disposePanel(): Promise<void> {
		this.panelDisposed = true;
		this.startCloseIfReady();
		return this.closeResult;
	}

	failInitialization(cleanup: CompatSidecarCloseFailureCleanup): Promise<void> {
		if (this.closeStarted) return this.closeResult;
		this.closeStarted = true;
		this.retiredAdmissionOpen = false;
		void this.runInitializationFailure(cleanup).then(this.resolveClose, this.resolveClose);
		return this.closeResult;
	}

	private startCloseIfReady(): void {
		if (!this.panelDisposed || this.closeStarted || !this.finalization) return;
		this.closeStarted = true;
		void this.runClose(this.finalization).then(this.resolveClose, this.resolveClose);
	}

	private async runClose(finalization: CompatSidecarCloseFinalization): Promise<void> {
		let attemptedDraft: CompatSidecarCloseDraft | undefined;
		try {
			await this.options.session.waitForFinalPersists();
			if (this.options.session.isPanelVisible) {
				await this.options.session.waitForBeforeUnload();
			} else {
				await (this.options.yieldTurn?.() ?? new Promise<void>(resolve => setImmediate(resolve)));
			}
			this.retiredAdmissionOpen = false;
			await finalization.gateway.closeRetiredInboundAdmission();
			this.options.session.beginClose();
			this.disposeSubscriptions(finalization.subscriptions);
			await this.options.session.waitForPersists();

			const draft = this.options.session.isDirty ? finalization.captureDraft() : undefined;
			if (draft) {
				let choice: 'Save' | 'Discard' | undefined;
				try {
					choice = await finalization.promptSave(draft.displayName);
				} catch (error) {
					attemptedDraft = draft;
					throw error;
				}
				if (choice === 'Save') {
					attemptedDraft = draft;
					await finalization.saveDraft(draft);
				} else if (choice !== 'Discard') {
					attemptedDraft = draft;
					throw new Error('The companion metadata close prompt ended without a Save or Discard choice.');
				}
			}
		} catch (error) {
			if (attemptedDraft) {
				try {
					const recoveryUri = await finalization.recoverDraft(attemptedDraft);
					try { finalization.notifyRecovered(recoveryUri); } catch { /* ignore */ }
				} catch {
					try { finalization.notifySaveFailed(error); } catch { /* ignore */ }
				}
			}
		}

		try {
			await finalization.repair();
		} catch {
			// The sidecar may already be unavailable.
		}
		try {
			await finalization.drainStore();
		} catch {
			// The sidecar may already be unavailable.
		} finally {
			this.options.session.settleClose();
			this.disposeSubscriptions(finalization.subscriptions);
		}
	}

	private async runInitializationFailure(cleanup: CompatSidecarCloseFailureCleanup): Promise<void> {
		try {
			await cleanup.gateway.closeRetiredInboundAdmission();
		} catch {
			// Initialization already failed; continue terminal cleanup.
		}
		this.options.session.beginClose();
		this.disposeSubscriptions(cleanup.subscriptions);
		try {
			await this.options.session.waitForPersists();
		} catch {
			// Persist failures cannot prevent terminal settlement.
		} finally {
			this.options.session.settleClose();
			this.disposeSubscriptions(cleanup.subscriptions);
		}
	}

	private disposeSubscriptions(subscriptions: readonly vscode.Disposable[]): void {
		for (const subscription of subscriptions) {
			if (this.disposedSubscriptions.has(subscription)) continue;
			this.disposedSubscriptions.add(subscription);
			try { subscription.dispose(); } catch { /* ignore */ }
		}
	}
}

function isPersistDocumentMessage(message: unknown): message is Record<string, unknown> {
	return !!message
		&& typeof message === 'object'
		&& !Array.isArray(message)
		&& (message as Record<string, unknown>).type === 'persistDocument';
}