import * as vscode from 'vscode';

import { ConnectionManager } from './connectionManager';
import { QueryEditorProvider } from './queryEditorProvider';
import { createEmptyKqlxFile, parseKqlxText, stringifyKqlxFile, type KqlxFileV1, type KqlxStateV1 } from './kqlxFormat';

type ComparableSection =
	| {
			type: 'query';
			name: string;
			connectionId: string;
			database: string;
			query: string;
			resultJson: string;
			runMode: string;
			cacheEnabled: boolean;
			cacheValue: number;
			cacheUnit: string;
			editorHeightPx?: number;
		}
	| {
			type: 'markdown';
			title: string;
			text: string;
			tab: 'edit' | 'preview';
			editorHeightPx?: number;
		}
	| {
			type: 'python';
			code: string;
			output: string;
			editorHeightPx?: number;
		}
	| {
			type: 'url';
			url: string;
			expanded: boolean;
		};

type ComparableState = {
	caretDocsEnabled: boolean;
	sections: ComparableSection[];
};

const normalizeHeight = (v: unknown): number | undefined => {
	const n = typeof v === 'number' ? v : undefined;
	if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
	return Math.round(n);
};

const toComparableState = (s: KqlxStateV1): ComparableState => {
	const caretDocsEnabled = typeof s.caretDocsEnabled === 'boolean' ? s.caretDocsEnabled : true;
	const sections: ComparableSection[] = [];
	for (const section of Array.isArray(s.sections) ? s.sections : []) {
		const t = (section as any)?.type;
		if (t === 'query') {
			sections.push({
				type: 'query',
				name: String((section as any).name ?? ''),
				connectionId: String((section as any).connectionId ?? ''),
				database: String((section as any).database ?? ''),
				query: String((section as any).query ?? ''),
				resultJson: String((section as any).resultJson ?? ''),
				runMode: String((section as any).runMode ?? 'take100'),
				cacheEnabled: (typeof (section as any).cacheEnabled === 'boolean') ? (section as any).cacheEnabled : true,
				cacheValue: Number.isFinite((section as any).cacheValue) ? Math.max(1, Math.trunc((section as any).cacheValue)) : 1,
				cacheUnit: String((section as any).cacheUnit ?? 'days'),
				editorHeightPx: normalizeHeight((section as any).editorHeightPx)
			});
			continue;
		}
		if (t === 'markdown') {
			sections.push({
				type: 'markdown',
				title: String((section as any).title ?? 'Markdown'),
				text: String((section as any).text ?? ''),
				tab: ((section as any).tab === 'preview') ? 'preview' : 'edit',
				editorHeightPx: normalizeHeight((section as any).editorHeightPx)
			});
			continue;
		}
		if (t === 'python') {
			sections.push({
				type: 'python',
				code: String((section as any).code ?? ''),
				output: String((section as any).output ?? ''),
				editorHeightPx: normalizeHeight((section as any).editorHeightPx)
			});
			continue;
		}
		if (t === 'url') {
			sections.push({
				type: 'url',
				url: String((section as any).url ?? ''),
				expanded: (typeof (section as any).expanded === 'boolean') ? (section as any).expanded : false
			});
			continue;
		}
		// Ignore unknown section types for comparison.
	}
	return { caretDocsEnabled, sections };
};

const deepEqual = (a: unknown, b: unknown): boolean => {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (a === null || b === null) return a === b;
	if (typeof a !== 'object') return false;

	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b)) return false;
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) return false;
		}
		return true;
	}

	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	const aKeys = Object.keys(ao).sort();
	const bKeys = Object.keys(bo).sort();
	if (aKeys.length !== bKeys.length) return false;
	for (let i = 0; i < aKeys.length; i++) {
		if (aKeys[i] !== bKeys[i]) return false;
		const k = aKeys[i];
		if (!deepEqual(ao[k], bo[k])) return false;
	}
	return true;
};

type IncomingWebviewMessage =
	| { type: 'requestDocument' }
	| { type: 'persistDocument'; state: KqlxStateV1; flush?: boolean }
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

		// Inform the webview whether it's operating in session mode.
		try {
			void webviewPanel.webview.postMessage({
				type: 'persistenceMode',
				isSessionFile
			});
		} catch {
			// ignore
		}
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

					// If the incoming state is semantically identical to what is already in the document,
					// do not rewrite the file (prevents "Save?" prompts due to JSON formatting/ordering).
					try {
						const parsedCurrent = parseKqlxText(document.getText());
						if (parsedCurrent.ok) {
							const currentComparable = toComparableState(parsedCurrent.file.state);
							const incomingComparable = toComparableState(state);
							if (deepEqual(currentComparable, incomingComparable)) {
								if (isSessionFile && (message as any).flush) {
									try {
										await document.save();
									} catch {
										// ignore
									}
								}
								return;
							}
						}
					} catch {
						// ignore
					}

					const file: KqlxFileV1 = {
						kind: 'kqlx',
						version: 1,
						state
					};
					const nextText = stringifyKqlxFile(file);
					// If nothing changed, avoid toggling the dirty state.
					try {
						if (nextText === document.getText()) {
							// For the session file, still attempt to save if explicitly flushing.
							if (isSessionFile && (message as any).flush) {
								try {
									await document.save();
								} catch {
									// ignore
								}
							}
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

					if (isSessionFile) {
						// For the persistent session file, always save promptly so VS Code never prompts on close.
						try {
							await document.save();
						} catch {
							// ignore
						}
					} else {
						// For user-picked files, saving stays user-controlled (or governed by VS Code autosave settings).
						scheduleSave();
					}
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
