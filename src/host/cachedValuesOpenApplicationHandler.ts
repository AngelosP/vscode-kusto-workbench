import * as vscode from 'vscode';

import type { IncomingWebviewMessage } from './queryEditorTypes';

export interface CachedValuesOpenApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export class HostCachedValuesOpenApplicationHandler implements CachedValuesOpenApplicationHandler {
	private disposed = false;

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		if (message.type !== 'seeCachedValues') return undefined;
		if (this.disposed) return Promise.resolve();
		return this.openCachedValues();
	}

	dispose(): void {
		this.disposed = true;
	}

	private async openCachedValues(): Promise<void> {
		await vscode.commands.executeCommand('kusto.seeCachedValues');
	}
}