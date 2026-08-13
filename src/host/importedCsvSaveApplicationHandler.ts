import * as os from 'os';
import * as vscode from 'vscode';

import type { IncomingWebviewMessage, SaveImportedCsvMessage } from './queryEditorTypes';
import { notifySavedFile, withCsvExtension } from './savedFileNotification';

export interface ImportedCsvSaveApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type ImportedCsvSaveApplicationHandlerOptions = {
	showSaveDialog?: (options: vscode.SaveDialogOptions) => Thenable<vscode.Uri | undefined>;
};

export class HostImportedCsvSaveApplicationHandler implements ImportedCsvSaveApplicationHandler {
	private disposed = false;

	constructor(private readonly options: ImportedCsvSaveApplicationHandlerOptions = {}) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		if (message.type !== 'saveImportedCsv') return undefined;
		return this.saveImportedCsv(message);
	}

	dispose(): void {
		this.disposed = true;
	}

	private async saveImportedCsv(message: SaveImportedCsvMessage): Promise<void> {
		if (this.disposed) return;
		try {
			const csv = String(message.csv || '');
			if (!csv.trim()) {
				void vscode.window.showInformationMessage('No results to save.');
				return;
			}

			const suggestedFileName = String(message.suggestedFileName || 'kusto-results.csv') || 'kusto-results.csv';
			const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
			const picked = await (this.options.showSaveDialog ?? vscode.window.showSaveDialog)({
				defaultUri: vscode.Uri.joinPath(baseDir, suggestedFileName),
				filters: { CSV: ['csv'] },
			});
			if (!picked || this.disposed) return;

			let targetUri = picked;
			try { targetUri = withCsvExtension(picked); } catch { /* ignore */ }

			await vscode.workspace.fs.writeFile(targetUri, Buffer.from(csv, 'utf8'));
			await notifySavedFile(targetUri, `Saved results to ${targetUri.fsPath}`);
		} catch {
			if (!this.disposed) {
				void vscode.window.showErrorMessage('Failed to save results to CSV file.');
			}
		}
	}
}