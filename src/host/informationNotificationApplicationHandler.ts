import * as vscode from 'vscode';

import type { IncomingWebviewMessage } from './queryEditorTypes';

export interface InformationNotificationApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): true | undefined;
	dispose(): void;
}

export class HostInformationNotificationApplicationHandler implements InformationNotificationApplicationHandler {
	private disposed = false;

	handleMessage(message: IncomingWebviewMessage): true | undefined {
		if (message.type !== 'showInfo') return undefined;
		if (this.disposed) return true;
		vscode.window.showInformationMessage(message.message);
		return true;
	}

	dispose(): void {
		this.disposed = true;
	}
}