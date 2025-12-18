import * as vscode from 'vscode';

import { ConnectionManager } from './connectionManager';
import { QueryEditorProvider } from './queryEditorProvider';
import { stringifyKqlxFile, type KqlxFileV1 } from './kqlxFormat';

type IncomingWebviewMessage =
	| { type: 'requestDocument' }
	| { type: 'persistDocument'; state: { sections?: Array<{ type?: string; text?: string }> } }
	| { type: 'requestUpgradeToMdx'; addKind?: string }
	| { type: string; [key: string]: unknown };

export class MdCompatEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'kusto.mdCompatEditor';

	public static register(
		context: vscode.ExtensionContext,
		extensionUri: vscode.Uri,
		connectionManager: ConnectionManager
	): vscode.Disposable {
		const provider = new MdCompatEditorProvider(context, extensionUri, connectionManager);
		return vscode.window.registerCustomEditorProvider(MdCompatEditorProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true }
		});
	}

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager
	) {}

	private static pendingAddKindKeyForUri(uri: vscode.Uri): string {
		// Keep in sync with KqlxEditorProvider's pendingAddKindKeyForUri implementation.
		try {
			if (uri.scheme === 'file') {
				return `kusto.pendingAddKind:${uri.fsPath.toLowerCase()}`;
			}
		} catch {
			// ignore
		}
		return `kusto.pendingAddKind:${uri.toString()}`;
	}

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
		await queryEditor.initializeWebviewPanel(webviewPanel, { registerMessageHandler: false });

		// Inform the webview it's operating in Markdown compatibility mode.
		try {
			void webviewPanel.webview.postMessage({
				type: 'persistenceMode',
				isSessionFile: false,
				compatibilityMode: true,
				documentKind: 'md',
				compatibilitySingleKind: 'markdown',
				allowedSectionKinds: ['markdown', 'url'],
				defaultSectionKind: 'markdown',
				upgradeRequestType: 'requestUpgradeToMdx',
				compatibilityTooltip: 'This file is in .md mode. Click to upgrade to .mdx and enable sections.'
			});
		} catch {
			// ignore
		}

		const postDocument = () => {
			const markdownText = document.getText();
			void webviewPanel.webview.postMessage({
				type: 'documentData',
				ok: true,
				compatibilityMode: true,
				documentKind: 'md',
				compatibilitySingleKind: 'markdown',
				allowedSectionKinds: ['markdown', 'url'],
				defaultSectionKind: 'markdown',
				upgradeRequestType: 'requestUpgradeToMdx',
				compatibilityTooltip: 'This file is in .md mode. Click to upgrade to .mdx and enable sections.',
				state: {
					sections: [{ type: 'markdown', text: markdownText, title: 'Markdown' }]
				}
			});
		};

		webviewPanel.webview.onDidReceiveMessage(async (message: IncomingWebviewMessage) => {
			if (!message || typeof message.type !== 'string') {
				return;
			}
			switch (message.type) {
				case 'requestDocument':
					// Re-send mode in response to a request (the webview is guaranteed to be listening).
					try {
						void webviewPanel.webview.postMessage({
							type: 'persistenceMode',
							isSessionFile: false,
							compatibilityMode: true,
							documentKind: 'md',
							compatibilitySingleKind: 'markdown',
							allowedSectionKinds: ['markdown', 'url'],
							defaultSectionKind: 'markdown',
							upgradeRequestType: 'requestUpgradeToMdx',
							compatibilityTooltip: 'This file is in .md mode. Click to upgrade to .mdx and enable sections.'
						});
					} catch {
						// ignore
					}
					postDocument();
					return;
				case 'requestUpgradeToMdx': {
					const addKind = message && typeof message.addKind === 'string' ? message.addKind : '';
					await this.upgradeToMdxAndReopen(document, webviewPanel, addKind);
					return;
				}
				case 'persistDocument': {
					const normalizeTextToEol = (text: string, eol: vscode.EndOfLine): string => {
						try {
							const lf = String(text ?? '').replace(/\r\n/g, '\n');
							return eol === vscode.EndOfLine.CRLF ? lf.replace(/\n/g, '\r\n') : lf;
						} catch {
							return String(text ?? '');
						}
					};

					const sections = (message as any).state && Array.isArray((message as any).state.sections)
						? ((message as any).state.sections as Array<{ type?: string; text?: string }>)
						: [];
					const firstMarkdown = sections.find((s) => s && String(s.type || '') === 'markdown');
					const rawNextText = firstMarkdown && typeof firstMarkdown.text === 'string' ? firstMarkdown.text : '';
					const nextText = normalizeTextToEol(rawNextText, document.eol);

					try {
						// Only mark dirty if the raw markdown text to be saved has changed.
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

	private async upgradeToMdxAndReopen(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		addKind: string
	): Promise<void> {
		if (document.uri.scheme !== 'file') {
			void vscode.window.showWarningMessage('This file cannot be upgraded because it is not a local file.');
			return;
		}

		const ext = (document.uri.path || '').toLowerCase();
		const isCompat = ext.endsWith('.md') && !ext.endsWith('.mdx');
		if (!isCompat) {
			return;
		}

		const choice = await vscode.window.showInformationMessage(
			'To add sections (Markdown/URL), this file needs to be upgraded to the .mdx format. This is a non-destructive change and it’s easy to go back later.',
			{ modal: true },
			'Upgrade to .mdx'
		);
		if (choice !== 'Upgrade to .mdx') {
			return;
		}

		try {
			if (document.isDirty) {
				await document.save();
			}
		} catch {
			// If save fails, still attempt to proceed using current in-memory text.
		}

		const oldUri = document.uri;
		const newUri = oldUri.with({ path: oldUri.path.replace(/\.md$/i, '.mdx') });
		const normalizedAddKind = ['markdown', 'url'].includes(String(addKind)) ? String(addKind) : '';

		const markdownText = document.getText();
		const file: KqlxFileV1 = {
			kind: 'mdx',
			version: 1,
			state: {
				sections: [{ type: 'markdown', text: markdownText, title: 'Markdown' }]
			}
		};
		const newText = stringifyKqlxFile(file);

		try {
			await vscode.workspace.fs.stat(newUri);
			void vscode.window.showErrorMessage('A .mdx file already exists for this document. Please open the existing .mdx file or rename it before upgrading.');
			return;
		} catch {
			// ok: does not exist
		}

		try {
			await vscode.workspace.fs.writeFile(newUri, new TextEncoder().encode(newText));
		} catch (e) {
			void vscode.window.showErrorMessage('Failed to create the .mdx file. ' + (e instanceof Error ? e.message : String(e)));
			return;
		}

		const pendingKey = MdCompatEditorProvider.pendingAddKindKeyForUri(newUri);
		if (normalizedAddKind) {
			try {
				await this.context.workspaceState.update(pendingKey, normalizedAddKind);
			} catch {
				// ignore
			}
		}

		const tryOpenWith = async (): Promise<void> => {
			await vscode.commands.executeCommand('vscode.openWith', newUri, 'kusto.kqlxEditor', {
				viewColumn: vscode.ViewColumn.Active
			});
		};

		try {
			await tryOpenWith();
		} catch (e1) {
			const msg1 = e1 instanceof Error ? e1.message : String(e1);
			const looksTransient = /disposed/i.test(msg1);
			if (looksTransient) {
				try {
					await new Promise((r) => setTimeout(r, 75));
					await tryOpenWith();
				} catch (e2) {
					const msg2 = e2 instanceof Error ? e2.message : String(e2);
					if (normalizedAddKind) {
						try {
							await this.context.workspaceState.update(pendingKey, undefined);
						} catch {
							/* ignore */
						}
					}
					void vscode.window.showErrorMessage(
						'File was upgraded to .mdx, but the editor could not be opened automatically. Please reopen the .mdx file. Details: ' + msg2
					);
					return;
				}
			} else {
				if (normalizedAddKind) {
					try {
						await this.context.workspaceState.update(pendingKey, undefined);
					} catch {
						/* ignore */
					}
				}
				void vscode.window.showErrorMessage(
					'File was upgraded to .mdx, but the editor could not be opened automatically. Please reopen the .mdx file. Details: ' + msg1
				);
				return;
			}
		}

		try {
			void vscode.window.showInformationMessage('File upgraded to .mdx.');
		} catch {
			// ignore
		}

		try {
			webviewPanel.dispose();
		} catch {
			// ignore
		}
	}
}
