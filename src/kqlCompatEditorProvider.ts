import * as vscode from 'vscode';

import { ConnectionManager } from './connectionManager';
import { QueryEditorProvider } from './queryEditorProvider';

type IncomingWebviewMessage =
	| { type: 'requestDocument' }
	| { type: 'persistDocument'; state: { sections?: Array<{ type?: string; query?: string }> } }
	| { type: string; [key: string]: unknown };

export class KqlCompatEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'kusto.kqlCompatEditor';

	public static register(
		context: vscode.ExtensionContext,
		extensionUri: vscode.Uri,
		connectionManager: ConnectionManager
	): vscode.Disposable {
		const provider = new KqlCompatEditorProvider(context, extensionUri, connectionManager);
		return vscode.window.registerCustomEditorProvider(KqlCompatEditorProvider.viewType, provider, {
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

		// Inform the webview it's operating in compatibility mode.
		try {
			void webviewPanel.webview.postMessage({
				type: 'persistenceMode',
				isSessionFile: false,
				compatibilityMode: true
			});
		} catch {
			// ignore
		}

		const postDocument = () => {
			// For .kql/.csl: the file contents ARE the query text. No .kqlx JSON format.
			const queryText = document.getText();
			void webviewPanel.webview.postMessage({
				type: 'documentData',
				ok: true,
				state: {
					sections: [{ type: 'query', query: queryText }]
				}
			});
		};

		webviewPanel.webview.onDidReceiveMessage(async (message: IncomingWebviewMessage) => {
			if (!message || typeof message.type !== 'string') {
				return;
			}
			switch (message.type) {
				case 'requestDocument':
					postDocument();
					return;
				case 'persistDocument': {
					// Persist ONLY the first query section's text back into the plain-text document.
					const sections = (message as any).state && Array.isArray((message as any).state.sections)
						? ((message as any).state.sections as Array<{ type?: string; query?: string }>)
						: [];
					const firstQuery = sections.find((s) => (s && String(s.type || '') === 'query'));
					const nextText = firstQuery && typeof firstQuery.query === 'string' ? firstQuery.query : '';

					// Avoid toggling dirty state when nothing changed.
					try {
						if (nextText === document.getText()) {
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
					return;
				}
				default:
					await queryEditor.handleWebviewMessage(message as any);
			}
		});
	}
}
