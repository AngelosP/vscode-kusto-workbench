import * as crypto from 'crypto';
import * as os from 'os';
import * as vscode from 'vscode';

import type {
	ArtifactCsvSaveDataMessage,
	CancelArtifactCsvSaveIntentMessage,
	IncomingWebviewMessage,
	RequestArtifactCsvSaveMessage,
} from './queryEditorTypes';
import { notifySavedFile, withCsvExtension } from './savedFileNotification';

const ARTIFACT_CSV_TRANSFER_TIMEOUT_MS = 60_000;
const ARTIFACT_CSV_INTENT_TOMBSTONE_MS = 10 * 60_000;
const ARTIFACT_CSV_MAX_ACTIVE_INTENTS = 8;
const ARTIFACT_CSV_MAX_COMPLETED_INTENTS = 256;

type PendingArtifactCsvSave = {
	exportId: string;
	boxId: string;
	artifactId: string;
	targetUri: vscode.Uri;
	timer: ReturnType<typeof setTimeout>;
};

export type ArtifactCsvSaveApplicationMessage =
	| RequestArtifactCsvSaveMessage
	| ArtifactCsvSaveDataMessage
	| CancelArtifactCsvSaveIntentMessage;

export interface ArtifactCsvSaveApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type ArtifactCsvSaveApplicationHandlerOptions = {
	postMessage: (message: unknown) => Thenable<boolean>;
	isDisposed: () => boolean;
};

export class HostArtifactCsvSaveApplicationHandler implements ArtifactCsvSaveApplicationHandler {
	private readonly pendingArtifactCsvIntentIds = new Set<string>();
	private readonly pendingArtifactCsvSaves = new Map<string, PendingArtifactCsvSave>();
	private readonly completedArtifactCsvIntentIds = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(private readonly options: ArtifactCsvSaveApplicationHandlerOptions) {}

	private postMessage(message: unknown): Thenable<boolean> {
		return this.options.postMessage(message);
	}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		switch (message.type) {
			case 'requestArtifactCsvSave':
				return this.requestArtifactCsvSave(message);
			case 'artifactCsvSaveData':
				return this.acceptArtifactCsvSaveData(message);
			case 'cancelArtifactCsvSaveIntent':
				this.cancelArtifactCsvSaveIntent(message);
				return Promise.resolve();
			default:
				return undefined;
		}
	}

	dispose(): void {
		this.pendingArtifactCsvIntentIds.clear();
		for (const [requestId, pending] of [...this.pendingArtifactCsvSaves]) {
			this.pendingArtifactCsvSaves.delete(requestId);
			clearTimeout(pending.timer);
		}
		for (const timer of this.completedArtifactCsvIntentIds.values()) clearTimeout(timer);
		this.completedArtifactCsvIntentIds.clear();
	}

	private async requestArtifactCsvSave(message: RequestArtifactCsvSaveMessage): Promise<void> {
		const exportId = String(message.requestId || '').trim();
		const boxId = String(message.boxId || '').trim();
		const artifactId = String(message.artifactId || '').trim();
		if (!exportId || !boxId || !artifactId || this.pendingArtifactCsvIntentIds.has(exportId)
			|| this.completedArtifactCsvIntentIds.has(exportId)) return;
		if (this.pendingArtifactCsvIntentIds.size >= ARTIFACT_CSV_MAX_ACTIVE_INTENTS) {
			this.completeArtifactCsvIntent(exportId);
			await this.postMessage({ type: 'cancelArtifactCsvSave', exportId });
			return;
		}

		this.pendingArtifactCsvIntentIds.add(exportId);
		try {
			const suggestedFileName = String(message.suggestedFileName || 'kusto-results.csv') || 'kusto-results.csv';
			const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
			const picked = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.joinPath(baseDir, suggestedFileName),
				filters: { CSV: ['csv'] },
			});
			if (!this.pendingArtifactCsvIntentIds.has(exportId)) return;
			if (!picked) {
				this.completeArtifactCsvIntent(exportId);
				await this.postMessage({ type: 'cancelArtifactCsvSave', exportId });
				return;
			}
			if (this.options.isDisposed()) {
				this.completeArtifactCsvIntent(exportId);
				return;
			}

			let targetUri = picked;
			try { targetUri = withCsvExtension(picked); } catch { /* ignore */ }
			const requestId = `artifact-csv-${crypto.randomUUID()}`;
			const timer = setTimeout(() => {
				const pending = this.pendingArtifactCsvSaves.get(requestId);
				if (!pending) return;
				this.pendingArtifactCsvSaves.delete(requestId);
				this.completeArtifactCsvIntent(pending.exportId);
				void this.postMessage({ type: 'cancelArtifactCsvSave', exportId: pending.exportId });
				if (!this.options.isDisposed()) {
					void vscode.window.showErrorMessage('Timed out preparing results for CSV export.');
				}
			}, ARTIFACT_CSV_TRANSFER_TIMEOUT_MS);
			this.pendingArtifactCsvSaves.set(requestId, { exportId, boxId, artifactId, targetUri, timer });
			const posted = await this.postMessage({
				type: 'requestArtifactCsvSaveData', requestId, exportId, boxId, artifactId,
			});
			if (!posted) {
				const pending = this.pendingArtifactCsvSaves.get(requestId);
				if (pending) {
					this.pendingArtifactCsvSaves.delete(requestId);
					clearTimeout(pending.timer);
				}
				this.completeArtifactCsvIntent(exportId);
				await this.postMessage({ type: 'cancelArtifactCsvSave', exportId });
			}
		} catch {
			this.completeArtifactCsvIntent(exportId);
			await this.postMessage({ type: 'cancelArtifactCsvSave', exportId });
			void vscode.window.showErrorMessage('Failed to save results to CSV file.');
		}
	}

	private async acceptArtifactCsvSaveData(message: ArtifactCsvSaveDataMessage): Promise<void> {
		const requestId = String(message.requestId || '').trim();
		const pending = this.pendingArtifactCsvSaves.get(requestId);
		if (!pending
			|| pending.boxId !== String(message.boxId || '').trim()
			|| pending.artifactId !== String(message.artifactId || '').trim()) return;

		this.pendingArtifactCsvSaves.delete(requestId);
		clearTimeout(pending.timer);
		this.completeArtifactCsvIntent(pending.exportId);
		const csv = typeof message.csv === 'string' ? message.csv : '';
		if (message.accepted !== true || !csv.trim()) {
			void vscode.window.showInformationMessage('Results are no longer available for CSV export.');
			return;
		}
		try {
			await vscode.workspace.fs.writeFile(pending.targetUri, Buffer.from(csv, 'utf8'));
			await notifySavedFile(pending.targetUri, `Saved results to ${pending.targetUri.fsPath}`);
		} catch {
			void vscode.window.showErrorMessage('Failed to save results to CSV file.');
		}
	}

	private cancelArtifactCsvSaveIntent(message: CancelArtifactCsvSaveIntentMessage): void {
		const exportId = String(message.requestId || '').trim();
		if (!exportId) return;
		let knownIntent = this.pendingArtifactCsvIntentIds.has(exportId);
		for (const [requestId, pending] of [...this.pendingArtifactCsvSaves]) {
			if (pending.exportId !== exportId) continue;
			knownIntent = true;
			this.pendingArtifactCsvSaves.delete(requestId);
			clearTimeout(pending.timer);
		}
		if (knownIntent) this.completeArtifactCsvIntent(exportId);
	}

	private completeArtifactCsvIntent(exportId: string): void {
		this.pendingArtifactCsvIntentIds.delete(exportId);
		const previous = this.completedArtifactCsvIntentIds.get(exportId);
		if (previous) clearTimeout(previous);
		if (!previous && this.completedArtifactCsvIntentIds.size >= ARTIFACT_CSV_MAX_COMPLETED_INTENTS) {
			const oldest = this.completedArtifactCsvIntentIds.entries().next().value as [string, ReturnType<typeof setTimeout>] | undefined;
			if (oldest) {
				clearTimeout(oldest[1]);
				this.completedArtifactCsvIntentIds.delete(oldest[0]);
			}
		}
		const timer = setTimeout(
			() => this.completedArtifactCsvIntentIds.delete(exportId),
			ARTIFACT_CSV_INTENT_TOMBSTONE_MS,
		);
		this.completedArtifactCsvIntentIds.set(exportId, timer);
	}
}