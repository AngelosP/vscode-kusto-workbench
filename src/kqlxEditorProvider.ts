import * as vscode from 'vscode';

import { ConnectionManager } from './connectionManager';
import { QueryEditorProvider } from './queryEditorProvider';
import { createEmptyKqlxFile, parseKqlxText, stringifyKqlxFile, type KqlxFileV1, type KqlxStateV1 } from './kqlxFormat';

const normalizeClusterUrlKey = (url: string): string => {
	try {
		const raw = String(url || '').trim();
		if (!raw) {
			return '';
		}
		const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
		const u = new URL(withScheme);
		// Lowercase host, drop trailing slashes.
		return (u.origin + u.pathname).replace(/\/+$/g, '').toLowerCase();
	} catch {
		return String(url || '').trim().replace(/\/+$/g, '').toLowerCase();
	}
};

const getDefaultConnectionName = (clusterUrl: string): string => {
	try {
		const raw = String(clusterUrl || '').trim();
		const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
		const u = new URL(withScheme);
		return u.hostname || raw;
	} catch {
		return String(clusterUrl || '').trim() || 'Kusto Cluster';
	}
};

const getClusterShortName = (clusterUrl: string): string => {
	try {
		const raw = String(clusterUrl || '').trim();
		if (!raw) {
			return '';
		}
		const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
		const u = new URL(withScheme);
		const host = String(u.hostname || '').trim();
		if (!host) {
			return raw;
		}
		const first = host.split('.')[0];
		return first || host;
	} catch {
		const raw = String(clusterUrl || '').trim();
		const m = raw.match(/([a-z0-9-]+)(?:\.[a-z0-9.-]+)+/i);
		if (m && m[1]) {
			return m[1];
		}
		return raw;
	}
};

const getClusterShortNameKey = (clusterUrl: string): string => {
	return String(getClusterShortName(clusterUrl) || '').trim().toLowerCase();
};

type ComparableSection =
	| {
			type: 'query';
			name: string;
			expanded: boolean;
			clusterUrl: string;
			database: string;
			query: string;
			resultJson: string;
			runMode: string;
			cacheEnabled: boolean;
			cacheValue: number;
			cacheUnit: string;
			editorHeightPx?: number;
			resultsHeightPx?: number;
		}
	| {
			type: 'markdown';
			title: string;
			text: string;
			expanded: boolean;
			// Back-compat: older files use `tab`.
			tab: 'edit' | 'preview';
			// Newer files store an explicit mode.
			mode: 'preview' | 'markdown' | 'wysiwyg';
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
			outputHeightPx?: number;
		};

type ComparableState = {
	caretDocsEnabled: boolean;
	sections: ComparableSection[];
};

const normalizeHeight = (v: unknown): number | undefined => {
	const n = typeof v === 'number' ? v : undefined;
	if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
		return undefined;
	}
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
					expanded: (typeof (section as any).expanded === 'boolean') ? (section as any).expanded : true,
					clusterUrl: String((section as any).clusterUrl ?? ''),
				database: String((section as any).database ?? ''),
				query: String((section as any).query ?? ''),
				resultJson: String((section as any).resultJson ?? ''),
				runMode: String((section as any).runMode ?? 'take100'),
				cacheEnabled: (typeof (section as any).cacheEnabled === 'boolean') ? (section as any).cacheEnabled : true,
				cacheValue: Number.isFinite((section as any).cacheValue) ? Math.max(1, Math.trunc((section as any).cacheValue)) : 1,
				cacheUnit: String((section as any).cacheUnit ?? 'days'),
				editorHeightPx: normalizeHeight((section as any).editorHeightPx),
				resultsHeightPx: normalizeHeight((section as any).resultsHeightPx)
			});
			continue;
		}
		if (t === 'markdown') {
			const rawMode = String((section as any).mode ?? '').toLowerCase();
			const rawTab = String((section as any).tab ?? '').toLowerCase();
			const mode: 'preview' | 'markdown' | 'wysiwyg' =
				rawMode === 'preview' || rawMode === 'markdown' || rawMode === 'wysiwyg'
					? (rawMode as any)
					: (rawTab === 'preview' ? 'preview' : 'wysiwyg');
			const tab: 'edit' | 'preview' = (rawTab === 'preview' || mode === 'preview') ? 'preview' : 'edit';
			sections.push({
				type: 'markdown',
				title: String((section as any).title ?? 'Markdown'),
				text: String((section as any).text ?? ''),
				expanded: (typeof (section as any).expanded === 'boolean') ? (section as any).expanded : true,
				tab,
				mode,
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
				expanded: (typeof (section as any).expanded === 'boolean') ? (section as any).expanded : false,
				outputHeightPx: normalizeHeight((section as any).outputHeightPx)
			});
			continue;
		}
		// Ignore unknown section types for comparison.
	}
	return { caretDocsEnabled, sections };
};

const deepEqual = (a: unknown, b: unknown): boolean => {
	if (a === b) {
		return true;
	}
	if (typeof a !== typeof b) {
		return false;
	}
	if (a === null || b === null) {
		return a === b;
	}
	if (typeof a !== 'object') {
		return false;
	}

	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b)) {
			return false;
		}
		if (a.length !== b.length) {
			return false;
		}
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) {
				return false;
			}
		}
		return true;
	}

	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	const aKeys = Object.keys(ao).sort();
	const bKeys = Object.keys(bo).sort();
	if (aKeys.length !== bKeys.length) {
		return false;
	}
	for (let i = 0; i < aKeys.length; i++) {
		if (aKeys[i] !== bKeys[i]) {
			return false;
		}
		const k = aKeys[i];
		if (!deepEqual(ao[k], bo[k])) {
			return false;
		}
	}
	return true;
};

type IncomingWebviewMessage =
	| { type: 'requestDocument' }
	| { type: 'persistDocument'; state: KqlxStateV1; flush?: boolean }
	| { type: string; [key: string]: unknown };

export class KqlxEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'kusto.kqlxEditor';

	private static pendingAddKindKeyForUri(uri: vscode.Uri): string {
		// On Windows, URI strings can differ in casing/encoding between APIs.
		// Use fsPath for file URIs so the key matches what the compat editor stored.
		try {
			if (uri.scheme === 'file') {
				return `kusto.pendingAddKind:${uri.fsPath.toLowerCase()}`;
			}
		} catch {
			// ignore
		}
		return `kusto.pendingAddKind:${uri.toString()}`;
	}

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
		await queryEditor.initializeWebviewPanel(webviewPanel, { registerMessageHandler: false });

		// If we were just upgraded from .kql/.csl -> .kqlx as part of an add-section action,
		// grab the pending add kind now and notify the webview once it is initialized.
		let pendingAddKind = '';
		try {
			const k = this.context.workspaceState.get<string>(KqlxEditorProvider.pendingAddKindKeyForUri(document.uri));
			if (typeof k === 'string') {
				pendingAddKind = k;
			}
		} catch {
			// ignore
		}

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

		let pendingAddKindDelivered = false;
		let saveTimer: NodeJS.Timeout | undefined;
		let lastSavedText = document.getText();
		let lastSavedEol = document.eol;
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

		const ensureConnectionsForState = async (state: KqlxStateV1): Promise<boolean> => {
			const urls: string[] = [];
			try {
				for (const sec of Array.isArray(state.sections) ? state.sections : []) {
					if (!sec || (sec as any).type !== 'query') {
						continue;
					}
					const clusterUrl = String((sec as any).clusterUrl || '').trim();
					if (clusterUrl) {
						urls.push(clusterUrl);
					}
				}
			} catch {
				// ignore
			}
			const uniqueKeys = new Map<string, string>();
			for (const u of urls) {
				const k = getClusterShortNameKey(u);
				if (k && !uniqueKeys.has(k)) {
					uniqueKeys.set(k, u);
				}
			}

			if (uniqueKeys.size === 0) {
				return false;
			}

			const existing = this.connectionManager.getConnections();
			const existingKeys = new Set(existing.map((c) => getClusterShortNameKey(c.clusterUrl || '')).filter(Boolean));

			let added = 0;
			for (const [, originalUrl] of uniqueKeys) {
				const key = getClusterShortNameKey(originalUrl);
				if (!key || existingKeys.has(key)) {
					continue;
				}
				let clusterUrl = String(originalUrl || '').trim();
				if (clusterUrl && !/^https?:\/\//i.test(clusterUrl)) {
					clusterUrl = 'https://' + clusterUrl.replace(/^\/+/, '');
				}
				await this.connectionManager.addConnection({
					name: getClusterShortName(clusterUrl || originalUrl) || getDefaultConnectionName(clusterUrl || originalUrl),
					clusterUrl: clusterUrl || originalUrl
				});
				existingKeys.add(key);
				added++;
			}

			return added > 0;
		};

		const postDocument = async () => {
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

			let connectionsChanged = false;
			try {
				connectionsChanged = await ensureConnectionsForState(parsed.file.state);
			} catch {
				// ignore
			}
			if (connectionsChanged) {
				try {
					await queryEditor.refreshConnectionsData();
				} catch {
					// ignore
				}
			}

			void webviewPanel.webview.postMessage({
				type: 'documentData',
				ok: true,
				state: parsed.file.state
			});
		};

		const subscriptions: vscode.Disposable[] = [];
		subscriptions.push(
			vscode.workspace.onDidSaveTextDocument((saved) => {
				try {
					if (saved.uri.toString() !== document.uri.toString()) {
						return;
					}
					lastSavedText = saved.getText();
					lastSavedEol = saved.eol;
				} catch {
					// ignore
				}
			})
		);

		const normalizeTextToEol = (text: string, eol: vscode.EndOfLine): string => {
			try {
				const lf = String(text ?? '').replace(/\r\n/g, '\n');
				return eol === vscode.EndOfLine.CRLF ? lf.replace(/\n/g, '\r\n') : lf;
			} catch {
				return String(text ?? '');
			}
		};

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
					await postDocument();

					// If we were upgraded from .kql/.csl and a specific "add" action triggered the upgrade,
					// deliver that intent now (after the webview has definitely attached its message listener).
					if (!pendingAddKindDelivered && pendingAddKind) {
						try {
							void webviewPanel.webview.postMessage({ type: 'upgradedToKqlx', addKind: pendingAddKind });
							pendingAddKindDelivered = true;
						} catch {
							// ignore
						}
						try {
							await this.context.workspaceState.update(
								KqlxEditorProvider.pendingAddKindKeyForUri(document.uri),
								undefined
							);
						} catch {
							// ignore
						}
					}
					return;
				case 'persistDocument': {
					const persistReason = (() => {
						try {
							const r = (message as any)?.reason;
							return typeof r === 'string' ? r : '';
						} catch {
							return '';
						}
					})();
					const rawState = (message as any).state;
					const state: KqlxStateV1 = {
						caretDocsEnabled:
							rawState && typeof rawState.caretDocsEnabled === 'boolean' ? rawState.caretDocsEnabled : undefined,
						sections: rawState && Array.isArray(rawState.sections) ? rawState.sections : []
					};

					const incomingComparable = toComparableState(state);
					const currentText = document.getText();

					let incomingMatchesDisk = false;
					let diskTextForMatch = '';

					// If the incoming state matches what was last saved (even if the in-memory document has
					// different formatting), restore that exact saved text. This allows VS Code to clear the
					// dirty indicator when a user "returns" to the saved state.
					let nextText = '';
					try {
						const parsedSaved = parseKqlxText(lastSavedText);
						if (parsedSaved.ok) {
							const savedComparable = toComparableState(parsedSaved.file.state);
							if (deepEqual(savedComparable, incomingComparable)) {
								nextText = normalizeTextToEol(lastSavedText, lastSavedEol);
							}
						}
					} catch {
						// ignore
					}

					// Fallback: if we couldn't match the last-saved snapshot (e.g. it was never saved in this
					// session), try reading from disk/workspace FS.
					if (!nextText) {
						try {
							const bytes = await vscode.workspace.fs.readFile(document.uri);
							const diskText = normalizeTextToEol(new TextDecoder('utf-8').decode(bytes), document.eol);
							const parsedDisk = parseKqlxText(diskText);
							if (parsedDisk.ok) {
								const diskComparable = toComparableState(parsedDisk.file.state);
								if (deepEqual(diskComparable, incomingComparable)) {
									incomingMatchesDisk = true;
									diskTextForMatch = diskText;
									nextText = diskText;
								}
							}
						} catch {
							// ignore
						}
					}

					// If we're handling a reorder persist and we matched lastSavedText, verify it's also
					// identical to disk so we can safely clear VS Code's dirty flag without saving changes.
					if (!incomingMatchesDisk && persistReason === 'reorder' && nextText) {
						try {
							const bytes = await vscode.workspace.fs.readFile(document.uri);
							const diskText = normalizeTextToEol(new TextDecoder('utf-8').decode(bytes), document.eol);
							if (diskText && diskText === nextText) {
								const parsedDisk = parseKqlxText(diskText);
								if (parsedDisk.ok) {
									const diskComparable = toComparableState(parsedDisk.file.state);
									if (deepEqual(diskComparable, incomingComparable)) {
										incomingMatchesDisk = true;
										diskTextForMatch = diskText;
									}
								}
							}
						} catch {
							// ignore
						}
					}

					// If the incoming state is semantically identical to what is already in the in-memory document,
					// and we didn't need to restore on-disk text, do not rewrite (prevents "Save?" prompts due to
					// JSON formatting/ordering).
					if (!nextText) {
						try {
							const parsedCurrent = parseKqlxText(currentText);
							if (parsedCurrent.ok) {
								const currentComparable = toComparableState(parsedCurrent.file.state);
								if (deepEqual(currentComparable, incomingComparable)) {
									// If this persist is from a reorder and the state matches disk, force a save to clear
									// the dirty flag (VS Code sometimes keeps custom editors dirty even after reverting).
									if (!isSessionFile && persistReason === 'reorder' && incomingMatchesDisk) {
										try {
											if (diskTextForMatch && diskTextForMatch === currentText && document.isDirty) {
												await document.save();
											}
										} catch {
											// ignore
										}
									}
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
							}
						} catch {
							// ignore
						}
					}

					if (!nextText) {
						const file: KqlxFileV1 = {
							kind: 'kqlx',
							version: 1,
							state
						};
						nextText = normalizeTextToEol(stringifyKqlxFile(file), document.eol);
					}
					// If nothing changed, avoid toggling the dirty state.
					try {
						if (nextText === currentText) {
							if (!isSessionFile && persistReason === 'reorder' && incomingMatchesDisk) {
								try {
									if (diskTextForMatch && diskTextForMatch === currentText && document.isDirty) {
										await document.save();
									}
								} catch {
									// ignore
								}
							}
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
						document.positionAt(0),
						document.positionAt(currentText.length)
					);

					const edit = new vscode.WorkspaceEdit();
					edit.replace(document.uri, fullRange, nextText);
					await vscode.workspace.applyEdit(edit);

					// If we just restored the file back to the exact on-disk content due to a reorder undo,
					// force a save to ensure VS Code clears the dirty flag.
					if (!isSessionFile && persistReason === 'reorder' && incomingMatchesDisk) {
						try {
							if (diskTextForMatch && diskTextForMatch === nextText && document.isDirty) {
								await document.save();
							}
						} catch {
							// ignore
						}
					}

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
