import * as vscode from 'vscode';

import type { EditorCursorStatusBar } from './editorCursorStatusBar';
import type { IncomingWebviewMessage } from './queryEditorTypes';

type EditorCursorPositionChangedMessage = Extract<IncomingWebviewMessage, { type: 'editorCursorPositionChanged' }>;
type EditorCursorStatusSnapshotRequestMessage = Extract<IncomingWebviewMessage, { type: 'getEditorCursorStatusSnapshot' }>;

export interface EditorCursorStatusApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): true | Promise<void> | undefined;
	setPanelVisible(visible: boolean): void;
	dispose(): void;
}

export type EditorCursorStatusApplicationHandlerOptions = {
	statusBar?: Pick<EditorCursorStatusBar, 'update' | 'getSnapshot' | 'clearOwnerPrefix'>;
	extensionMode: vscode.ExtensionMode;
	postMessage: (message: unknown) => Thenable<boolean>;
};

export class HostEditorCursorStatusApplicationHandler implements EditorCursorStatusApplicationHandler {
	private static ownerSequence = 0;

	private readonly ownerPrefix = `queryEditor:${++HostEditorCursorStatusApplicationHandler.ownerSequence}:`;
	private panelVisible = false;
	private disposed = false;

	constructor(private readonly options: EditorCursorStatusApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): true | Promise<void> | undefined {
		if (message.type === 'editorCursorPositionChanged') {
			if (!this.disposed) this.update(message);
			return true;
		}
		if (message.type === 'getEditorCursorStatusSnapshot') {
			if (this.disposed || this.options.extensionMode === vscode.ExtensionMode.Production) {
				return Promise.resolve();
			}
			return this.postSnapshot(message);
		}
		return undefined;
	}

	setPanelVisible(visible: boolean): void {
		if (this.disposed) return;
		this.panelVisible = visible;
		if (!visible) this.clear();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.panelVisible = false;
		this.clear();
	}

	private update(message: EditorCursorPositionChangedMessage): void {
		if (!this.options.statusBar || !this.panelVisible) return;
		this.options.statusBar.update(this.getOwnerId(message), message);
	}

	private getOwnerId(message: EditorCursorPositionChangedMessage): string {
		const boxId = typeof message.boxId === 'string' && message.boxId.trim() ? message.boxId.trim() : '';
		const editorKind = typeof message.editorKind === 'string' && message.editorKind.trim()
			? message.editorKind.trim()
			: 'editor';
		return `${this.ownerPrefix}${boxId || editorKind}`;
	}

	private async postSnapshot(message: EditorCursorStatusSnapshotRequestMessage): Promise<void> {
		try {
			await this.postMessage({
				type: 'editorCursorStatusSnapshot',
				requestId: message.requestId,
				snapshot: this.options.statusBar?.getSnapshot() ?? { visible: false, text: '' },
			});
		} catch {
			// Ignore development-only snapshot transport failures.
		}
	}

	private postMessage(message: unknown): Thenable<boolean> {
		return this.options.postMessage(message);
	}

	private clear(): void {
		this.options.statusBar?.clearOwnerPrefix(this.ownerPrefix);
	}
}