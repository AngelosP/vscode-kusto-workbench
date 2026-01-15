import * as vscode from 'vscode';

import * as path from 'path';

import { ConnectionManager } from './connectionManager';
import { QueryEditorProvider } from './queryEditorProvider';
import { parseKqlxText, stringifyKqlxFile, type KqlxFileV1, type KqlxStateV1 } from './kqlxFormat';
import { renderDiffInWebview } from './diffViewerUtils';

type IncomingWebviewMessage =
	| { type: 'requestDocument' }
	| { type: 'persistDocument'; state: KqlxStateV1; reason?: string }
	| { type: 'requestUpgradeToKqlx'; addKind?: string; state?: KqlxStateV1 }
	| { type: string; [key: string]: unknown };

export class KqlCompatEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'kusto.kqlCompatEditor';

	private static readonly allowedSectionKinds: Array<'query' | 'chart' | 'transformation' | 'markdown' | 'python' | 'url'> =
		['query', 'chart', 'transformation', 'markdown', 'python', 'url'];

	private static getSidecarKqlxUriForCompat(uri: vscode.Uri): vscode.Uri | undefined {
		try {
			const ext = String(uri.path || '').toLowerCase();
			if (!ext.endsWith('.kql') && !ext.endsWith('.csl')) {
				return undefined;
			}
			// Sidecar naming: <filename>.kql.json or <filename>.csl.json
			return uri.with({ path: uri.path + '.json' });
		} catch {
			return undefined;
		}
	}

	private static resolveLinkedQueryUri(kqlxUri: vscode.Uri, linkedQueryPath: string): vscode.Uri {
		try {
			const raw = String(linkedQueryPath || '').trim();
			if (!raw) {
				return kqlxUri;
			}
			// Support file URIs.
			try {
				if (/^file:\/\//i.test(raw)) {
					return vscode.Uri.parse(raw);
				}
			} catch {
				// ignore
			}

			// Support Windows absolute paths.
			if (/^[a-zA-Z]:\\/.test(raw) || raw.startsWith('\\\\')) {
				return vscode.Uri.file(raw);
			}

			// Treat as path relative to the .kqlx file.
			const kqlxDir = path.posix.dirname(kqlxUri.path);
			const joined = path.posix.normalize(path.posix.join(kqlxDir, raw));
			return kqlxUri.with({ path: joined });
		} catch {
			return kqlxUri;
		}
	}

	private static isLinkedSidecarForCompatFile(sidecarUri: vscode.Uri, sidecarFile: KqlxFileV1, compatDocumentUri: vscode.Uri): boolean {
		try {
			const sections = Array.isArray(sidecarFile?.state?.sections) ? sidecarFile.state.sections : [];
			const first = sections.length > 0 ? sections[0] : undefined;
			const t = (first as any)?.type;
			if (t !== 'query' && t !== 'copilotQuery') {
				return false;
			}
			const linked = String((first as any)?.linkedQueryPath ?? '').trim();
			if (!linked) {
				return false;
			}
			const resolved = KqlCompatEditorProvider.resolveLinkedQueryUri(sidecarUri, linked);
			if (resolved.scheme === 'file' && compatDocumentUri.scheme === 'file') {
				return resolved.fsPath.toLowerCase() === compatDocumentUri.fsPath.toLowerCase();
			}
			return resolved.toString() === compatDocumentUri.toString();
		} catch {
			return false;
		}
	}

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

		// Sidecar support: if there is a sibling .kqlx file that links back to this .kql/.csl,
		// use it to store multi-section metadata while keeping the query text in the plain file.
		let sidecarUri: vscode.Uri | undefined;
		let sidecarFile: KqlxFileV1 | undefined;
		try {
			sidecarUri = KqlCompatEditorProvider.getSidecarKqlxUriForCompat(document.uri);
			if (sidecarUri && sidecarUri.scheme === 'file') {
				try {
					const bytes = await vscode.workspace.fs.readFile(sidecarUri);
					const text = new TextDecoder().decode(bytes);
					const parsed = parseKqlxText(text, { allowedKinds: ['kqlx', 'mdx'], defaultKind: 'kqlx' });
					if (parsed.ok && KqlCompatEditorProvider.isLinkedSidecarForCompatFile(sidecarUri, parsed.file, document.uri)) {
						sidecarFile = parsed.file;
					}
				} catch {
					// ignore
				}
			}
		} catch {
			// ignore
		}

		let lastKnownSidecarState: KqlxStateV1 | undefined = sidecarFile?.state;

		const getSidecarDisplayName = (): string => {
			try {
				const u = KqlCompatEditorProvider.getSidecarKqlxUriForCompat(document.uri);
				if (!u) return 'sidecar';
				return path.posix.basename(u.path);
			} catch {
				return 'sidecar';
			}
		};

		const postPersistenceMode = () => {
			const sidecarEnabled = !!sidecarFile;
			const compatibilityMode = !sidecarEnabled;
			const sidecarName = getSidecarDisplayName();
			const tooltip = compatibilityMode
				? `This is a .kql/.csl file. To add sections, Kusto Workbench will create a companion metadata file (${sidecarName}) next to it.`
				: '';
			try {
				void webviewPanel.webview.postMessage({
					type: 'persistenceMode',
					isSessionFile: false,
					compatibilityMode,
					documentKind: 'kql',
					compatibilitySingleKind: 'query',
					allowedSectionKinds: KqlCompatEditorProvider.allowedSectionKinds,
					defaultSectionKind: 'query',
					upgradeRequestType: 'requestUpgradeToKqlx',
					compatibilityTooltip: tooltip
				});
			} catch {
				// ignore
			}
		};

		postPersistenceMode();

		const postDocument = (options?: { forceReload?: boolean }) => {
			const forceReload = options?.forceReload ?? false;
			const queryText = document.getText();
			const sidecarEnabled = !!sidecarFile;
			const sidecarName = getSidecarDisplayName();
			let state: KqlxStateV1;
			if (sidecarEnabled && sidecarFile) {
				const rawSections = Array.isArray(sidecarFile.state.sections) ? sidecarFile.state.sections : [];
				const sections: any[] = rawSections.map((s) => ({ ...(s as any) }));
				const firstType = String(sections[0]?.type ?? '');
				if (sections.length === 0 || (firstType !== 'query' && firstType !== 'copilotQuery')) {
					sections.unshift({ type: 'query' });
				}
				sections[0] = { ...(sections[0] as any), type: 'query', query: queryText };
				state = {
					caretDocsEnabled: sidecarFile.state.caretDocsEnabled,
					sections
				};
			} else {
				state = {
					sections: [
						{
							type: 'query',
							query: queryText,
							...(inferredSelection ? { clusterUrl: inferredSelection.clusterUrl, database: inferredSelection.database } : {})
						}
					]
				};
			}
			void webviewPanel.webview.postMessage({
				type: 'documentData',
				ok: true,
				forceReload,
				compatibilityMode: !sidecarEnabled,
				documentKind: 'kql',
				compatibilitySingleKind: 'query',
				allowedSectionKinds: KqlCompatEditorProvider.allowedSectionKinds,
				defaultSectionKind: 'query',
				upgradeRequestType: 'requestUpgradeToKqlx',
				compatibilityTooltip: !sidecarEnabled
					? `This is a .kql/.csl file. To add sections, Kusto Workbench will create a companion metadata file (${sidecarName}) next to it.`
					: '',
				state
			});
		};

		// Track if the webview has initialized and whether it's currently being edited by the user.
		const subscriptions: vscode.Disposable[] = [];
		let webviewInitialized = false;
		let lastWebviewPersistAt = 0;

		// Listen for external file changes (e.g., from Copilot, git, or other processes).
		subscriptions.push(
			vscode.workspace.onDidChangeTextDocument((e) => {
				try {
					if (e.document.uri.toString() !== document.uri.toString()) {
						return;
					}
					if (e.contentChanges.length === 0) {
						return;
					}
					if (!webviewInitialized) {
						return;
					}
					const now = Date.now();
					if (now - lastWebviewPersistAt < 500) {
						return;
					}
					// Notify the webview that the document changed externally.
					// Use forceReload to ensure the webview updates even if already initialized.
					postDocument({ forceReload: true });
				} catch {
					// ignore
				}
			})
		);

		// When the user explicitly saves the .kql/.csl file, also save the companion .json metadata.
		subscriptions.push(
			vscode.workspace.onDidSaveTextDocument(async (saved) => {
				try {
					if (!sidecarUri || !sidecarFile) {
						return;
					}
					if (saved.uri.toString() !== document.uri.toString()) {
						return;
					}
					if (!lastKnownSidecarState) {
						return;
					}
					const persisted = KqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, lastKnownSidecarState);
					const text = stringifyKqlxFile(persisted);
					await vscode.workspace.fs.writeFile(sidecarUri, new TextEncoder().encode(text));
					// Keep in-memory sidecar updated to reflect what we just wrote.
					sidecarFile = persisted;
				} catch {
					// ignore
				}
			})
		);

		webviewPanel.onDidDispose(() => {
			for (const s of subscriptions) {
				try { s.dispose(); } catch { /* ignore */ }
			}
		});

		webviewPanel.webview.onDidReceiveMessage(async (message: IncomingWebviewMessage) => {
			if (!message || typeof message.type !== 'string') {
				return;
			}
			switch (message.type) {
				case 'requestDocument':
					// Re-send mode in response to a request (the webview is guaranteed to be listening).
					postPersistenceMode();
					postDocument();
					webviewInitialized = true;
					return;
				case 'requestUpgradeToKqlx': {
					const addKind = (message && typeof message.addKind === 'string') ? message.addKind : '';
					const normalizedAddKind = KqlCompatEditorProvider.allowedSectionKinds.includes(addKind as any) ? String(addKind) : '';

					// If the webview provided a fresh state snapshot (e.g., user clicked add-chart right
					// after executing and the debounced persist hasn't fired), prefer it for seeding.
					try {
						const rawState = (message as any)?.state;
						if (rawState && typeof rawState === 'object') {
							lastKnownSidecarState = {
								caretDocsEnabled:
									rawState && typeof rawState.caretDocsEnabled === 'boolean' ? rawState.caretDocsEnabled : undefined,
								sections: rawState && Array.isArray(rawState.sections) ? rawState.sections : []
							};
						}
					} catch {
						// ignore
					}

					const enabled = await this.enableSidecarKqlxForCompat(document, inferredSelection, lastKnownSidecarState);
					if (!enabled) {
						return;
					}
					sidecarUri = enabled.uri;
					sidecarFile = enabled.file;
					lastKnownSidecarState = enabled.file.state;
					postPersistenceMode();
					postDocument({ forceReload: true });
					try {
						void webviewPanel.webview.postMessage({ type: 'enabledKqlxSidecar', addKind: normalizedAddKind });
					} catch {
						// ignore
					}
					return;
				}
				case 'persistDocument': {
					// Track that the webview is persisting, so we don't treat the resulting
					// onDidChangeTextDocument event as an external change.
					lastWebviewPersistAt = Date.now();

					const rawState = (message as any)?.state;
					const incomingState: KqlxStateV1 = {
						caretDocsEnabled:
							rawState && typeof rawState.caretDocsEnabled === 'boolean' ? rawState.caretDocsEnabled : undefined,
						sections: rawState && Array.isArray(rawState.sections) ? rawState.sections : []
					};
					lastKnownSidecarState = incomingState;

					// Persist the first query section's text back into the plain-text document.
					const firstQuery = incomingState.sections.find((s) => (s && String((s as any).type || '') === 'query'));
					const nextText = firstQuery && typeof (firstQuery as any).query === 'string' ? String((firstQuery as any).query) : '';
					const currentText = (() => {
						try {
							return document.getText();
						} catch {
							return '';
						}
					})();

					const fullRange = new vscode.Range(
						0,
						0,
						document.lineCount ? document.lineCount - 1 : 0,
						document.lineCount ? document.lineAt(document.lineCount - 1).text.length : 0
					);
					if (nextText !== currentText) {
						const edit = new vscode.WorkspaceEdit();
						edit.replace(document.uri, fullRange, nextText);
						await vscode.workspace.applyEdit(edit);
					}

					// If a sidecar is enabled, persist the full multi-section state to the sidecar file.
					try {
						if (sidecarUri && sidecarFile) {
							const persisted = KqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, incomingState);
							const text = stringifyKqlxFile(persisted);
							await vscode.workspace.fs.writeFile(sidecarUri, new TextEncoder().encode(text));
							sidecarFile = persisted;
						}
					} catch {
						// ignore
					}
					return;
				}
				default:
					await queryEditor.handleWebviewMessage(message as any);
			}
		});
	}

	private static buildSidecarFileForCompat(compatUri: vscode.Uri, state: KqlxStateV1): KqlxFileV1 {
		const fileName = path.posix.basename(compatUri.path);
		const sectionsRaw = Array.isArray(state.sections) ? state.sections : [];
		const sections: any[] = sectionsRaw.map((s) => ({ ...(s as any) }));
		const firstType = String(sections[0]?.type ?? '');
		if (sections.length === 0 || (firstType !== 'query' && firstType !== 'copilotQuery')) {
			sections.unshift({ type: 'query' });
		}
		sections[0] = { ...(sections[0] as any), type: 'query', linkedQueryPath: fileName };
		try {
			delete (sections[0] as any).query;
		} catch {
			// ignore
		}
		return {
			kind: 'kqlx',
			version: 1,
			state: {
				caretDocsEnabled: state.caretDocsEnabled,
				sections
			}
		};
	}

	private async enableSidecarKqlxForCompat(
		document: vscode.TextDocument,
		inferredSelection: { clusterUrl: string; database: string } | undefined,
		lastKnownWebviewState?: KqlxStateV1
	): Promise<{ uri: vscode.Uri; file: KqlxFileV1 } | undefined> {
		if (document.uri.scheme !== 'file') {
			void vscode.window.showWarningMessage('This feature requires a local .kql/.csl file on disk.');
			return undefined;
		}
		const sidecarUri = KqlCompatEditorProvider.getSidecarKqlxUriForCompat(document.uri);
		if (!sidecarUri) {
			return undefined;
		}
		const sidecarName = (() => {
			try {
				return path.posix.basename(sidecarUri.path);
			} catch {
				return 'sidecar';
			}
		})();

		const choice = await vscode.window.showInformationMessage(
			`To add notebook sections, Kusto Workbench will create a companion metadata file (${sidecarName}) next to this file to store metadata (charts, markdown, etc).`,
			{ modal: true },
			'Create companion file'
		);
		if (choice !== 'Create companion file') {
			return undefined;
		}

		// If a sidecar already exists, prefer using it if it's already linked.
		try {
			const bytes = await vscode.workspace.fs.readFile(sidecarUri);
			const text = new TextDecoder().decode(bytes);
			const parsed = parseKqlxText(text, { allowedKinds: ['kqlx', 'mdx'], defaultKind: 'kqlx' });
			if (parsed.ok && KqlCompatEditorProvider.isLinkedSidecarForCompatFile(sidecarUri, parsed.file, document.uri)) {
				return { uri: sidecarUri, file: parsed.file };
			}
			const overwrite = await vscode.window.showWarningMessage(
				`A sidecar file (${sidecarName}) already exists next to this .kql/.csl file, but it does not appear to be linked as a companion metadata file. Overwrite it to enable sidecar metadata?`,
				{ modal: true },
				'Overwrite sidecar'
			);
			if (overwrite !== 'Overwrite sidecar') {
				return undefined;
			}
		} catch {
			// does not exist
		}

		// Ensure latest text is used.
		try {
			if (document.isDirty) {
				await document.save();
			}
		} catch {
			// ignore
		}

		// Seed the sidecar with the most recent UI state if we have it.
		// This preserves per-box connection selection and persisted results across the transition.
		const baseState: KqlxStateV1 = (() => {
			try {
				if (lastKnownWebviewState && Array.isArray(lastKnownWebviewState.sections) && lastKnownWebviewState.sections.length > 0) {
					return {
						caretDocsEnabled: lastKnownWebviewState.caretDocsEnabled,
						sections: lastKnownWebviewState.sections
					};
				}
			} catch {
				// ignore
			}
			return {
				sections: [
					{
						type: 'query',
						...(inferredSelection ? { clusterUrl: inferredSelection.clusterUrl, database: inferredSelection.database } : {})
					} as any
				]
			};
		})();
		const file = KqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, baseState);
		const text = stringifyKqlxFile(file);
		try {
			await vscode.workspace.fs.writeFile(sidecarUri, new TextEncoder().encode(text));
		} catch (e) {
			void vscode.window.showErrorMessage(
				`Failed to create the companion sidecar file (${sidecarName}). ` + (e instanceof Error ? e.message : String(e))
			);
			return undefined;
		}

		try {
			void vscode.window.showInformationMessage(`Companion sidecar metadata file created: ${sidecarName}`);
		} catch {
			// ignore
		}

		return { uri: sidecarUri, file };
	}
}
