import type * as vscode from 'vscode';

import type { IncomingWebviewMessage } from './queryEditorTypes';

type SqlLastSelectionMessage = Extract<IncomingWebviewMessage, {
	type: 'saveSqlLastSelection';
}>;

export interface SqlLastSelectionApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type SqlLastSelectionApplicationHandlerOptions = {
	globalState: Pick<vscode.Memento, 'update'>;
};

export class HostSqlLastSelectionApplicationHandler implements SqlLastSelectionApplicationHandler {
	private disposed = false;

	constructor(private readonly options: SqlLastSelectionApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		if (message.type !== 'saveSqlLastSelection') return undefined;
		if (this.disposed) return Promise.resolve();
		return this.saveLastSelection(message);
	}

	dispose(): void {
		this.disposed = true;
	}

	private async saveLastSelection(message: SqlLastSelectionMessage): Promise<void> {
		const sqlConnectionId = String(message.sqlConnectionId || '').trim();
		if (!sqlConnectionId) return;

		await this.options.globalState.update('sql.lastConnectionId', sqlConnectionId);
		if (message.database !== undefined) {
			await this.options.globalState.update('sql.lastDatabase', message.database);
		}
	}
}