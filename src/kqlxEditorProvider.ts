import * as vscode from 'vscode';

import { ConnectionManager } from './connectionManager';
import { QueryEditorProvider } from './queryEditorProvider';
import { createEmptyKqlxFile, parseKqlxText, stringifyKqlxFile, type KqlxFileV1, type KqlxStateV1 } from './kqlxFormat';

type IncomingWebviewMessage =
	| { type: 'requestDocument' }
	| { type: 'persistDocument'; state: KqlxStateV1 }
	| { type: string; [key: string]: unknown };

export class KqlxEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'kusto.kqlxEditor';

	public static register(
		context: vscode.ExtensionContext,
		extensionUri: vscode.Uri,
		connectionManager: ConnectionManager
	): vscode.Disposable {
		const provider = new KqlxEditorProvider(context, extensionUri, connectionManager);
		return vscode.window.registerCustomEditorProvider(KqlxEditorProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true }
		});
	}

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager
	) {}

	public async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri]
		};

		const queryEditor = new QueryEditorProvider(this.extensionUri, this.connectionManager, this.context);
		await queryEditor.initializeWebviewPanel(webviewPanel);

		const sessionUri = vscode.Uri.joinPath(this.context.globalStorageUri, 'session.kqlx');
		const isSessionFile = (() => {
			try {
				// On Windows the URI string can vary in encoding/casing; fsPath is the most reliable.
				if (document.uri.scheme === 'file' && sessionUri.scheme === 'file') {
					return document.uri.fsPath.toLowerCase() === sessionUri.fsPath.toLowerCase();
				}
			} catch {
				// ignore
			}
			return document.uri.toString() === sessionUri.toString();
		})();
		let saveTimer: NodeJS.Timeout | undefined;
		const scheduleSave = () => {
			// Only auto-save the persistent session file.
			// For user-picked .kqlx files, saving should remain user-controlled (or governed by VS Code's autosave setting).
			if (!isSessionFile) {
				return;
			}
			try {
				if (saveTimer) {
					clearTimeout(saveTimer);
				}
				// Avoid rapid dirty/clean flicker while typing; still saves soon after the last edit.
				saveTimer = setTimeout(() => {
					saveTimer = undefined;
					void document.save();
				}, 1200);
			} catch {
				// ignore
			}
		};

		const postDocument = () => {
			const parsed = parseKqlxText(document.getText());
			if (!parsed.ok) {
				void webviewPanel.webview.postMessage({
					type: 'documentData',
					ok: false,
					error: parsed.error,
					state: createEmptyKqlxFile().state
				});
				return;
			}
			void webviewPanel.webview.postMessage({
				type: 'documentData',
				ok: true,
				state: parsed.file.state
			});
		};

		const subscriptions: vscode.Disposable[] = [];

		webviewPanel.onDidDispose(() => {
			// Best effort: ensure the session file hits disk even if the debounce hasn't fired yet.
			if (isSessionFile) {
				try {
					if (saveTimer) {
						clearTimeout(saveTimer);
						saveTimer = undefined;
					}
					void document.save();
				} catch {
					// ignore
				}
			}
			for (const s of subscriptions) {
				try { s.dispose(); } catch { /* ignore */ }
			}
			try {
				if (saveTimer) {
					clearTimeout(saveTimer);
					saveTimer = undefined;
				}
			} catch {
				// ignore
			}
		});

		webviewPanel.webview.onDidReceiveMessage(async (message: IncomingWebviewMessage) => {
			if (!message || typeof message.type !== 'string') {
				return;
			}
			switch (message.type) {
				case 'requestDocument':
					// Only load from disk when explicitly requested by the webview.
					postDocument();
					return;
				case 'persistDocument': {
					const rawState = (message as any).state;
					const state: KqlxStateV1 = {
						caretDocsEnabled:
							rawState && typeof rawState.caretDocsEnabled === 'boolean' ? rawState.caretDocsEnabled : undefined,
						sections: rawState && Array.isArray(rawState.sections) ? rawState.sections : []
					};

					const file: KqlxFileV1 = {
						kind: 'kqlx',
						version: 1,
						state
					};
					const nextText = stringifyKqlxFile(file);
					// If nothing changed, avoid toggling the dirty state.
					try {
						if (nextText === document.getText()) {
							scheduleSave();
							return;
						}
					} catch {
						// ignore
					}

					const fullRange = new vscode.Range(
						0,
						0,
						document.lineCount ? document.lineCount - 1 : 0,
						document.lineCount ? document.lineAt(document.lineCount - 1).text.length : 0
					);

					const edit = new vscode.WorkspaceEdit();
					edit.replace(document.uri, fullRange, nextText);
					await vscode.workspace.applyEdit(edit);

					// Save shortly after the last change (debounced) so we don't flicker while typing.
					scheduleSave();
					return;
				}
				default:
					// Forward everything else to the existing query editor handler.
					await queryEditor.handleWebviewMessage(message as any);
			}
		});

		// Do not push document contents automatically.
		// The webview asks for the initial document explicitly (requestDocument).
	}
}
