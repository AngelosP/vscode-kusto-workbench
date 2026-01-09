import * as vscode from 'vscode';

import { ConnectionManager } from './connectionManager';
import { QueryEditorProvider } from './queryEditorProvider';
import { stringifyKqlxFile, type KqlxFileV1 } from './kqlxFormat';
import { renderDiffInWebview } from './diffViewerUtils';

type IncomingWebviewMessage =
	| { type: 'requestDocument' }
	| { type: 'persistDocument'; state: { sections?: Array<{ type?: string; query?: string }> } }
	| { type: 'requestUpgradeToKqlx'; addKind?: string }
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

	/**
	 * Detects if the custom editor is being opened as part of a diff view.
	 * 
	 * VS Code doesn't have a dedicated "custom editor diff" mode - instead, when viewing diffs
	 * for custom editor file types, VS Code opens two instances of the custom editor side-by-side:
	 * - Left side: original version (git: scheme or similar)
	 * - Right side: working copy (file: scheme)
	 * 
	 * We detect both sides:
	 * 1. Original side: URI scheme is 'git', 'gitfs', etc. -> Return the URI to render diff
	 * 2. Modified side: file: scheme but another tab with git: scheme exists -> Return undefined but set flag
	 * 
	 * Returns: { isDiff: true, originalUri: Uri } for original side that should render diff,
	 *          { isDiff: true, originalUri: undefined } for modified side that should close,
	 *          { isDiff: false } for normal (non-diff) context
	 */
	private detectDiffContext(document: vscode.TextDocument): { isDiff: boolean; originalUri?: vscode.Uri } {
		const uri = document.uri;
		
		// Common source control schemes that indicate this is a historical version (original side)
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
		
		// For file: scheme, check if this is the "modified" side of a diff
		// by looking for a matching git: scheme tab for the same file
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
			} catch (err) {
				console.error('[KqlCompatEditor] Tab API error:', err);
			}
		}
		
		return { isDiff: false };
	}

	private static pendingAddKindKeyForUri(uri: vscode.Uri): string {
		// On Windows, URI strings can differ in casing/encoding between APIs.
		// Use fsPath for file URIs to keep the key stable across the upgrade/openWith flow.
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

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri]
		};

		const queryEditor = new QueryEditorProvider(this.extensionUri, this.connectionManager, this.context);
		await queryEditor.initializeWebviewPanel(webviewPanel, { registerMessageHandler: false });

		// Best-effort default selection for plain `.kql/.csl` files (no embedded metadata).
		// This is intentionally non-fatal: if we can't infer, the UI falls back to last selection.
		let inferredSelection: { clusterUrl: string; database: string } | undefined;
		try {
			inferredSelection = await queryEditor.inferClusterDatabaseForKqlQuery(document.getText());
		} catch {
			inferredSelection = undefined;
		}

		// Inform the webview it's operating in compatibility mode.
		try {
			void webviewPanel.webview.postMessage({
				type: 'persistenceMode',
				isSessionFile: false,
				compatibilityMode: true,
				documentKind: 'kql',
				compatibilitySingleKind: 'query',
						allowedSectionKinds: ['query', 'chart', 'markdown', 'python', 'url'],
				defaultSectionKind: 'query',
				upgradeRequestType: 'requestUpgradeToKqlx',
				compatibilityTooltip: 'This file is in .kql/.csl mode. Click to upgrade to .kqlx and enable sections.'
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
				compatibilityMode: true,
				documentKind: 'kql',
				compatibilitySingleKind: 'query',
				allowedSectionKinds: ['query', 'chart', 'markdown', 'python', 'url'],
				defaultSectionKind: 'query',
				upgradeRequestType: 'requestUpgradeToKqlx',
				compatibilityTooltip: 'This file is in .kql/.csl mode. Click to upgrade to .kqlx and enable sections.',
				state: {
					sections: [
						{
							type: 'query',
							query: queryText,
							...(inferredSelection ? { clusterUrl: inferredSelection.clusterUrl, database: inferredSelection.database } : {})
						}
					]
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
							documentKind: 'kql',
							compatibilitySingleKind: 'query',
								allowedSectionKinds: ['query', 'chart', 'markdown', 'python', 'url'],
							defaultSectionKind: 'query',
							upgradeRequestType: 'requestUpgradeToKqlx',
							compatibilityTooltip: 'This file is in .kql/.csl mode. Click to upgrade to .kqlx and enable sections.'
						});
					} catch {
						// ignore
					}
					postDocument();
					return;
				case 'requestUpgradeToKqlx': {
					const addKind = (message && typeof message.addKind === 'string') ? message.addKind : '';
					await this.upgradeToKqlxAndReopen(document, webviewPanel, addKind);
					return;
				}
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

	private async upgradeToKqlxAndReopen(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		addKind: string
	): Promise<void> {
		// Only local disk files are upgradeable via rename.
		if (document.uri.scheme !== 'file') {
			void vscode.window.showWarningMessage('This file cannot be upgraded because it is not a local file.');
			return;
		}

		const ext = (document.uri.path || '').toLowerCase();
		const isCompat = ext.endsWith('.kql') || ext.endsWith('.csl');
		if (!isCompat) {
			return;
		}

		const choice = await vscode.window.showInformationMessage(
			'To add sections (Query/Chart/Markdown/Python/URL), this file needs to be upgraded to the .kqlx format. This is a non-destructive change and it’s easy to go back later.',
			{ modal: true },
			'Upgrade to .kqlx'
		);
		if (choice !== 'Upgrade to .kqlx') {
			return;
		}

		try {
			// Ensure latest text is used.
			if (document.isDirty) {
				await document.save();
			}
		} catch {
			// If save fails, still attempt to proceed using current in-memory text.
		}

		const oldUri = document.uri;
		const newUri = oldUri.with({ path: oldUri.path.replace(/\.(kql|csl)$/i, '.kqlx') });
		const normalizedAddKind = ['query', 'chart', 'markdown', 'python', 'url'].includes(String(addKind)) ? String(addKind) : '';

		// Build .kqlx content with the current query as the first section.
		const queryText = document.getText();
		const file: KqlxFileV1 = {
			kind: 'kqlx',
			version: 1,
			state: {
				sections: [{ type: 'query', query: queryText }]
			}
		};
		const newText = stringifyKqlxFile(file);

		// Keep original .kql/.csl file on disk. Create a sibling .kqlx file.
		try {
			await vscode.workspace.fs.stat(newUri);
			void vscode.window.showErrorMessage('A .kqlx file already exists for this document. Please open the existing .kqlx file or rename it before upgrading.');
			return;
		} catch {
			// ok: does not exist
		}
		try {
			await vscode.workspace.fs.writeFile(newUri, new TextEncoder().encode(newText));
		} catch (e) {
			void vscode.window.showErrorMessage(
				'Failed to create the .kqlx file. ' + (e instanceof Error ? e.message : String(e))
			);
			return;
		}

		// Open the new .kqlx in the rich editor. Rename can dispose the current webview mid-flight,
		// so avoid depending on the current panel and retry once on transient disposal errors.
		const pendingKey = KqlCompatEditorProvider.pendingAddKindKeyForUri(newUri);
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
						try { await this.context.workspaceState.update(pendingKey, undefined); } catch { /* ignore */ }
					}
					void vscode.window.showErrorMessage(
						'File was upgraded to .kqlx, but the editor could not be opened automatically. Please reopen the .kqlx file. Details: ' + msg2
					);
					return;
				}
			} else {
				if (normalizedAddKind) {
					try { await this.context.workspaceState.update(pendingKey, undefined); } catch { /* ignore */ }
				}
				void vscode.window.showErrorMessage(
					'File was upgraded to .kqlx, but the editor could not be opened automatically. Please reopen the .kqlx file. Details: ' + msg1
				);
				return;
			}
		}

		try {
			void vscode.window.showInformationMessage('File upgraded to .kqlx.');
		} catch {
			// ignore
		}

		// Close the old compatibility editor panel (the old file no longer exists).
		try {
			webviewPanel.dispose();
		} catch {
			// ignore
		}
	}
}
