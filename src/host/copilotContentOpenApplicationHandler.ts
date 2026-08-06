import * as vscode from 'vscode';

import { getErrorMessage } from './queryEditorUtils';
import type { IncomingWebviewMessage } from './queryEditorTypes';

type OpenToolResultInEditorMessage = Extract<IncomingWebviewMessage, { type: 'openToolResultInEditor' }>;
type OpenMarkdownPreviewMessage = Extract<IncomingWebviewMessage, { type: 'openMarkdownPreview' }>;

export interface CopilotContentOpenApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export class HostCopilotContentOpenApplicationHandler implements CopilotContentOpenApplicationHandler {
	private disposed = false;

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		if (message.type !== 'openToolResultInEditor' && message.type !== 'openMarkdownPreview') return undefined;
		if (this.disposed) return Promise.resolve();
		return message.type === 'openToolResultInEditor'
			? this.openToolResultInEditor(message)
			: this.openMarkdownPreview(message);
	}

	dispose(): void {
		this.disposed = true;
	}

	private async openToolResultInEditor(message: OpenToolResultInEditorMessage): Promise<void> {
		try {
			String(message.tool || 'tool_result').trim();
			const content = String(message.content || '');
			const document = await vscode.workspace.openTextDocument({
				content,
				language: 'plaintext',
			});

			await vscode.window.showTextDocument(document, {
				preview: true,
				viewColumn: vscode.ViewColumn.Beside,
			});
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to open tool result: ${getErrorMessage(error)}`);
		}
	}

	private async openMarkdownPreview(message: OpenMarkdownPreviewMessage): Promise<void> {
		try {
			const uri = vscode.Uri.file(message.filePath);
			await vscode.commands.executeCommand('markdown.showPreview', uri);
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to open markdown preview: ${getErrorMessage(error)}`);
		}
	}
}