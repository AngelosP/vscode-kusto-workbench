import * as vscode from 'vscode';

import * as path from 'path';

import { ConnectionManager } from './connectionManager';
import { QueryEditorProvider } from './queryEditorProvider';
import { stringifyKqlxFile, type KqlxFileV1 } from './kqlxFormat';
import { getLastSelectionForUri, onDidRecordSelection } from './selectionTracker';
import { renderDiffInWebview } from './diffViewerUtils';

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
			// VS Code supports a built-in Find widget for webviews.
			// Our `vscode` typings may lag the runtime API, so we set this defensively.
			webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true } as any
		});
	}

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager
	) {}

	/**
	 * Detects if the custom editor is being opened as part of a diff view.
	 * 
	 * VS Code doesn't have a dedicated "custom editor diff" mode - instead, when viewing diffs
	 * for custom editor file types, VS Code opens two instances of the custom editor side-by-side.
	 * 
	 * We detect this by checking if the URI scheme indicates source control (e.g., 'git', 'gitfs').
	 * Returns an object indicating if we're in diff context and which side (original or modified).
	 */
	private detectDiffContext(document: vscode.TextDocument): { isDiff: boolean; originalUri?: vscode.Uri } {
		const uri = document.uri;
		
		// Common source control schemes that indicate this is a historical version
		const scmSchemes = ['git', 'gitfs', 'gitlens', 'pr', 'review', 'vscode-vfs'];
		if (scmSchemes.includes(uri.scheme)) {
			return { isDiff: true, originalUri: uri };
		}
		
		// Check for revision-related query parameters (common patterns used by SCM extensions)
		const query = uri.query || '';
		if (query) {
			// Git extension uses query params like `ref=HEAD` or `ref=~` for staged files
			const revisionPatterns = [/\bref=/i, /\bcommit=/i, /\bsha=/i, /\brevision=/i];
			if (revisionPatterns.some(pattern => pattern.test(query))) {
				return { isDiff: true, originalUri: uri };
			}
		}
		
		// Check if this is the "modified" side of a diff (file: scheme opened alongside a git: scheme)
		// This happens when VS Code opens both sides of a diff for custom editors
		if (uri.scheme === 'file') {
			try {
				const baseFileName = uri.path.split('/').pop() || '';
				const tabGroups = vscode.window.tabGroups.all;
				
				// Check for diff-related tab labels that indicate we're the modified side
				// VS Code uses labels like "filename.kql (Working Tree)" or "filename.kql (Index)" for diffs
				const diffLabelPatterns = [
					/\(Working Tree\)$/i,
					/\(Index\)$/i,
					/\(HEAD\)$/i,
					/↔/,  // Diff arrow in some themes
				];
				
				for (const group of tabGroups) {
					for (const tab of group.tabs) {
						// Check if there's a tab with our filename and a diff-related label
						if (tab.label.includes(baseFileName)) {
							if (diffLabelPatterns.some(pattern => pattern.test(tab.label))) {
								// We found a diff tab for our file - we're in diff context
								return { isDiff: true, originalUri: undefined };
							}
						}
					}
				}
			} catch {
				// Tab API access failed, assume not in diff context
			}
		}
		
		return { isDiff: false };
	}

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
		// Detect if this editor is being opened as part of a diff view.
		// VS Code uses special URI schemes for source control diffs (e.g., 'git', 'gitfs').
		// When in diff mode, render our Monaco-based diff viewer directly in this webview.
		const diffContext = this.detectDiffContext(document);
		if (diffContext.isDiff) {
			if (diffContext.originalUri) {
				// This is the "original" side (git: scheme) - render the diff viewer
				await renderDiffInWebview(webviewPanel, this.extensionUri, diffContext.originalUri);
			} else {
				// This is the "modified" side (file: scheme) - just show a message
				// The diff is already being shown in the other panel
				webviewPanel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>body { display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
.message { text-align: center; opacity: 0.7; }</style></head>
<body><div class="message"><p>Diff view is shown in the left panel</p></div></body></html>`;
			}
			return;
		}

		const disposables: vscode.Disposable[] = [];
		const isDevMode = this.context.extensionMode === vscode.ExtensionMode.Development;
		const isMdSearchDebugEnabled = (): boolean => {
			try {
				if (isDevMode) {
					return true;
				}
				return !!vscode.workspace.getConfiguration('kustoWorkbench').get('debug.mdSearchReveal', false);
			} catch {
				return false;
			}
		};
		let lastDebugKey = '';
		let lastDebugAt = 0;
		const debugPopup = (label: string, detail?: string): void => {
			try {
				if (!isMdSearchDebugEnabled()) {
					return;
				}
				const msg = `[kusto md debug] ${label}${detail ? ` ${detail}` : ''}`;
				const now = Date.now();
				const key = msg;
				if (key === lastDebugKey && now - lastDebugAt < 1200) {
					return;
				}
				lastDebugKey = key;
				lastDebugAt = now;
				void vscode.window.showInformationMessage(msg);
			} catch {
				// ignore
			}
		};

		// IMPORTANT: When opening from VS Code's global Search view, VS Code may briefly create/focus
		// a text editor with the correct selection and then swap to the custom editor. If we wait
		// until after webview initialization to observe the selection, we can miss it.
		// So: capture + listen early, and queue the reveal until the webview is ready.
		let webviewReady = false;
		let pendingRevealRange: vscode.Range | undefined;
		const queueReveal = (range: vscode.Range | undefined): void => {
			if (!range) {
				return;
			}
			if (!webviewReady) {
				pendingRevealRange = range;
				debugPopup('queueReveal(pending)', `${document.uri.toString()} ${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`);
				return;
			}
			debugPopup('queueReveal(sendNow)', `${document.uri.toString()} ${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`);
			postRevealRange(range);
		};
		const captureBestEffortRangeNow = (): vscode.Range | undefined => {
			try {
				const uri = document.uri.toString();
				const active = vscode.window.activeTextEditor;
				if (active && active.document?.uri?.toString() === uri) {
					debugPopup('capture(activeTextEditor)', `${uri} ${active.selection.start.line}:${active.selection.start.character}-${active.selection.end.line}:${active.selection.end.character}`);
					return active.selection;
				}
				const editor = (vscode.window.visibleTextEditors || []).find((e) => e.document?.uri?.toString() === uri);
				if (editor) {
					debugPopup('capture(visibleTextEditor)', `${uri} ${editor.selection.start.line}:${editor.selection.start.character}-${editor.selection.end.line}:${editor.selection.end.character}`);
					return editor.selection;
				}
				const tracked = getLastSelectionForUri(document.uri);
				if (tracked) {
					debugPopup('capture(selectionTracker)', `${uri} ${tracked.start.line}:${tracked.start.character}-${tracked.end.line}:${tracked.end.character}`);
				}
				return tracked;
			} catch {
				return undefined;
			}
		};
		webviewPanel.onDidDispose(() => {
			try {
				for (const d of disposables) {
					try {
						d.dispose();
					} catch {
						// ignore
					}
				}
			} catch {
				// ignore
			}
		});

		const docDir = (() => {
			try {
				if (document.uri.scheme === 'file') {
					return vscode.Uri.file(path.dirname(document.uri.fsPath));
				}
			} catch {
				// ignore
			}
			return undefined;
		})();
		const workspaceFolderUri = (() => {
			try {
				return vscode.workspace.getWorkspaceFolder(document.uri)?.uri;
			} catch {
				return undefined;
			}
		})();

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri, docDir, workspaceFolderUri].filter(Boolean) as vscode.Uri[]
		};

		// Best-effort: if VS Code opened this document with a selection (e.g. from the global Search view),
		// forward that range into the webview so it can reveal it.
		let lastRevealedKey = '';
		const postRevealRange = (range: vscode.Range | undefined): void => {
			if (!range) {
				return;
			}
			const key = `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
			if (key === lastRevealedKey) {
				return;
			}
			lastRevealedKey = key;
			let matchText = '';
			let startOffset: number | undefined;
			let endOffset: number | undefined;
			try {
				// If the range is a Search result selection, include the selected text.
				// The webview can use this to find/highlight in preview mode.
				matchText = range.isEmpty ? '' : document.getText(range);
				startOffset = document.offsetAt(range.start);
				endOffset = document.offsetAt(range.end);
				// Avoid sending very large payloads.
				if (matchText && matchText.length > 500) {
					matchText = matchText.slice(0, 500);
				}
			} catch {
				matchText = '';
				startOffset = undefined;
				endOffset = undefined;
			}
			try {
				debugPopup(
					'postRevealRange(host->webview)',
					`${document.uri.toString()} ${key} matchLen=${matchText ? matchText.length : 0} startOff=${startOffset ?? 'n/a'} endOff=${endOffset ?? 'n/a'}`
				);
				void webviewPanel.webview.postMessage({
					type: 'revealTextRange',
					documentUri: document.uri.toString(),
					start: { line: range.start.line, character: range.start.character },
					end: { line: range.end.line, character: range.end.character },
					matchText,
					startOffset,
					endOffset
				});
			} catch {
				// ignore
			}
		};

		const tryRevealFromVisibleTextEditor = (): void => {
			try {
				const uri = document.uri.toString();
				const active = vscode.window.activeTextEditor;
				if (active && active.document && active.document.uri.toString() === uri) {
					queueReveal(active.selection);
					return;
				}
				const editor = (vscode.window.visibleTextEditors || []).find((e) => e.document?.uri?.toString() === uri);
				if (editor) {
					queueReveal(editor.selection);
					return;
				}
				// Fallback: selection that was applied before the custom editor became visible (e.g., Search view open-at-range).
				queueReveal(getLastSelectionForUri(document.uri));
			} catch {
				// ignore
			}
		};

		// Start listening immediately (before webview initialization), and capture any initial range.
		disposables.push(
			vscode.window.onDidChangeTextEditorSelection((e) => {
				try {
					if (e.textEditor?.document?.uri?.toString() !== document.uri.toString()) {
						return;
					}
					const first = Array.isArray(e.selections) && e.selections.length ? e.selections[0] : e.textEditor.selection;
					queueReveal(first);
				} catch {
					// ignore
				}
			})
		);
		disposables.push(
			vscode.window.onDidChangeActiveTextEditor(() => {
				tryRevealFromVisibleTextEditor();
			})
		);
		disposables.push(
			onDidRecordSelection((e) => {
				try {
					if (!e || e.uri !== document.uri.toString()) {
						return;
					}
					queueReveal(e.range);
				} catch {
					// ignore
				}
			})
		);
		// Grab the best-effort selection immediately.
		try {
			pendingRevealRange = captureBestEffortRangeNow();
		} catch {
			// ignore
		}

		const queryEditor = new QueryEditorProvider(this.extensionUri, this.connectionManager, this.context);
		await queryEditor.initializeWebviewPanel(webviewPanel, { registerMessageHandler: false, hideFooterControls: true });

		// Inform the webview it's operating in Markdown compatibility mode.
		try {
			void webviewPanel.webview.postMessage({
				type: 'persistenceMode',
				isSessionFile: false,
				compatibilityMode: true,
				documentUri: document.uri.toString(),
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
				documentUri: document.uri.toString(),
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
			webviewReady = true;
			debugPopup('webviewReady', document.uri.toString());
			try {
				if (pendingRevealRange) {
					postRevealRange(pendingRevealRange);
				}
			} catch {
				// ignore
			}
			// Try to reveal any selection that existed when the editor was opened.
			// Search-driven selections can land slightly after the custom editor initializes, so retry.
			tryRevealFromVisibleTextEditor();
			try {
				setTimeout(() => tryRevealFromVisibleTextEditor(), 50);
				setTimeout(() => tryRevealFromVisibleTextEditor(), 150);
				setTimeout(() => tryRevealFromVisibleTextEditor(), 350);
			} catch {
				// ignore
			}
		};

		webviewPanel.webview.onDidReceiveMessage(async (message: IncomingWebviewMessage) => {
			if (!message || typeof message.type !== 'string') {
				return;
			}
			switch (message.type) {
				case 'debugMdSearchReveal':
					try {
						const phase = message && typeof (message as any).phase === 'string' ? String((message as any).phase) : 'webview';
						const d = message && typeof (message as any).detail === 'string' ? String((message as any).detail) : '';
						debugPopup(`webview:${phase}`, d);
					} catch {
						// ignore
					}
					break;
				case 'requestDocument':
					// Re-send mode in response to a request (the webview is guaranteed to be listening).
					try {
						void webviewPanel.webview.postMessage({
							type: 'persistenceMode',
							isSessionFile: false,
							compatibilityMode: true,
							documentUri: document.uri.toString(),
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
					// VS Code's text model uses `\n` internally even for CRLF files.
					// Normalize both sides to that representation to avoid false "dirty" edits.
					const normalizeToLf = (text: string): string => {
						try {
							return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
						} catch {
							return String(text ?? '');
						}
					};

					const sections = (message as any).state && Array.isArray((message as any).state.sections)
						? ((message as any).state.sections as Array<{ type?: string; text?: string }>)
						: [];
					const firstMarkdown = sections.find((s) => s && String(s.type || '') === 'markdown');
					const rawNextText = firstMarkdown && typeof firstMarkdown.text === 'string' ? firstMarkdown.text : '';
					const nextText = normalizeToLf(rawNextText);

					try {
						// Only mark dirty if the raw markdown text to be saved has changed.
						const currentText = normalizeToLf(document.getText());
						if (nextText === currentText) {
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
