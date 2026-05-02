import * as vscode from 'vscode';

import * as path from 'path';

import { ConnectionManager } from './connectionManager';
import { QueryEditorProvider } from './queryEditorProvider';
import { EditorCursorStatusBar } from './editorCursorStatusBar';
import { parseKqlxText, stringifyKqlxFile, type KqlxFileV1, type KqlxStateV1 } from './kqlxFormat';
import { renderDiffInWebview } from './diffViewerUtils';
import { normalizeSection, computeChangedSections, formatSectionDiffContent, KqlxEditorProvider } from './kqlxEditorProvider';
import type { SectionChangeInfo, ChangedSectionsMessage } from './queryEditorTypes';

type IncomingWebviewMessage =
	| { type: 'requestDocument' }
	| { type: 'persistDocument'; state: KqlxStateV1; reason?: string }
	| { type: 'requestUpgradeToSqlx'; addKind?: string; state?: KqlxStateV1 }
	| { type: string; [key: string]: unknown };

/**
 * Compute the sidecar .sql.json URI for a .sql compat file.
 * Returns undefined if the URI does not end with .sql (but not .sqlx).
 */
export function getSidecarJsonUriForSqlCompat(uri: vscode.Uri): vscode.Uri | undefined {
	try {
		const p = String(uri.path || '').toLowerCase();
		if (!p.endsWith('.sql') || p.endsWith('.sqlx')) {
			return undefined;
		}
		return uri.with({ path: uri.path + '.json' });
	} catch {
		return undefined;
	}
}

/**
 * Resolve a linked query path relative to a sidecar URI.
 */
function resolveLinkedQueryUri(sidecarUri: vscode.Uri, linkedQueryPath: string): vscode.Uri {
	try {
		const raw = String(linkedQueryPath || '').trim();
		if (!raw) {
			return sidecarUri;
		}
		try {
			if (/^file:\/\//i.test(raw)) {
				return vscode.Uri.parse(raw);
			}
		} catch {
			// ignore
		}
		if (/^[a-zA-Z]:\\/.test(raw) || raw.startsWith('\\\\')) {
			return vscode.Uri.file(raw);
		}
		const dir = path.posix.dirname(sidecarUri.path);
		const joined = path.posix.normalize(path.posix.join(dir, raw));
		return sidecarUri.with({ path: joined });
	} catch {
		return sidecarUri;
	}
}

/**
 * Check whether a sidecar file is linked to a specific SQL compat document.
 */
function isLinkedSidecarForSqlFile(sidecarUri: vscode.Uri, sidecarFile: KqlxFileV1, compatDocumentUri: vscode.Uri): boolean {
	try {
		const sections = Array.isArray(sidecarFile?.state?.sections) ? sidecarFile.state.sections : [];
		const first = sections.length > 0 ? sections[0] : undefined;
		const t = (first as any)?.type;
		if (t !== 'sql') {
			return false;
		}
		const linked = String((first as any)?.linkedQueryPath ?? '').trim();
		if (!linked) {
			return false;
		}
		const resolved = resolveLinkedQueryUri(sidecarUri, linked);
		if (resolved.scheme === 'file' && compatDocumentUri.scheme === 'file') {
			return resolved.fsPath.toLowerCase() === compatDocumentUri.fsPath.toLowerCase();
		}
		return resolved.toString() === compatDocumentUri.toString();
	} catch {
		return false;
	}
}

export class SqlCompatEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'kusto.sqlCompatEditor';

	private static readonly allowedSectionKinds: Array<'sql' | 'query' | 'chart' | 'transformation' | 'markdown' | 'python' | 'url' | 'html'> =
		['sql', 'query', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'];

	public static register(
		context: vscode.ExtensionContext,
		extensionUri: vscode.Uri,
		connectionManager: ConnectionManager,
		editorCursorStatusBar?: EditorCursorStatusBar
	): vscode.Disposable {
		const provider = new SqlCompatEditorProvider(context, extensionUri, connectionManager, editorCursorStatusBar);
		return vscode.window.registerCustomEditorProvider(SqlCompatEditorProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true } as any
		});
	}

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager,
		private readonly editorCursorStatusBar?: EditorCursorStatusBar
	) {}

	private detectDiffContext(document: vscode.TextDocument): { isDiff: boolean; originalUri?: vscode.Uri } {
		const uri = document.uri;

		const scmSchemes = ['git', 'gitfs', 'gitlens', 'pr', 'review', 'vscode-vfs'];
		if (scmSchemes.includes(uri.scheme)) {
			return { isDiff: true, originalUri: uri };
		}

		const query = uri.query || '';
		if (query) {
			const revisionPatterns = [/\bref=/i, /\bcommit=/i, /\bsha=/i, /\brevision=/i];
			if (revisionPatterns.some(pattern => pattern.test(query))) {
				return { isDiff: true, originalUri: uri };
			}
		}

		if (uri.scheme === 'file') {
			try {
				const baseFileName = uri.path.split('/').pop() || '';
				const tabGroups = vscode.window.tabGroups.all;

				const diffLabelPatterns = [
					/\(Working Tree\)$/i,
					/\(Index\)$/i,
					/\(HEAD\)$/i,
					/↔/,
				];

				for (const group of tabGroups) {
					for (const tab of group.tabs) {
						if (tab.label.includes(baseFileName)) {
							if (diffLabelPatterns.some(pattern => pattern.test(tab.label))) {
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

	public async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		const diffContext = this.detectDiffContext(document);
		if (diffContext.isDiff && diffContext.originalUri) {
			await renderDiffInWebview(webviewPanel, this.extensionUri, diffContext.originalUri);
			return;
		}

		const disposables: vscode.Disposable[] = [];

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri]
		};

		const queryEditor = new QueryEditorProvider(this.extensionUri, this.connectionManager, this.context, this.editorCursorStatusBar);
		queryEditor.documentUri = document.uri.toString();
		await queryEditor.initializeWebviewPanel(webviewPanel, { registerMessageHandler: false });

		// Sidecar support: if there is a sibling .sql.json file that links back to this .sql,
		// use it to store multi-section metadata while keeping the SQL text in the plain file.
		let sidecarUri: vscode.Uri | undefined;
		let sidecarFile: KqlxFileV1 | undefined;
		let lastWrittenSidecarText: string | undefined;
		let sidecarDirty = false;
		try {
			sidecarUri = getSidecarJsonUriForSqlCompat(document.uri);
			if (sidecarUri && sidecarUri.scheme === 'file') {
				try {
					const bytes = await vscode.workspace.fs.readFile(sidecarUri);
					const text = new TextDecoder().decode(bytes);
					const parsed = parseKqlxText(text, { allowedKinds: ['sqlx', 'kqlx'], defaultKind: 'sqlx' });
					if (parsed.ok && isLinkedSidecarForSqlFile(sidecarUri, parsed.file, document.uri)) {
						sidecarFile = parsed.file;
						lastWrittenSidecarText = text;
					}
				} catch {
					// ignore — sidecar does not exist or is not parseable
				}
			}
		} catch {
			// ignore
		}

		let lastKnownSidecarState: KqlxStateV1 | undefined = sidecarFile?.state;

		const getSidecarDisplayName = (): string => {
			try {
				const u = getSidecarJsonUriForSqlCompat(document.uri);
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
				? `This is a .sql file. To add sections, Kusto Workbench will create a companion metadata file (${sidecarName}) next to it.`
				: '';
			try {
				void webviewPanel.webview.postMessage({
					type: 'persistenceMode',
					isSessionFile: false,
					compatibilityMode,
					documentUri: document.uri.toString(),
					documentKind: 'sql',
					compatibilitySingleKind: 'sql',
					allowedSectionKinds: SqlCompatEditorProvider.allowedSectionKinds,
					defaultSectionKind: 'sql',
					upgradeRequestType: 'requestUpgradeToSqlx',
					compatibilityTooltip: tooltip,
					firstSectionPinned: sidecarEnabled
				});
			} catch {
				// ignore
			}
		};

		postPersistenceMode();

		// ── Section-level unsaved-changes tracking ──────────────────────────
		let savedSqlText = document.getText();
		let savedSidecarSectionCache = new Map<string, Record<string, unknown>>();
		let lastPostedChangesJson = '';

		const rebuildSavedCache = () => {
			savedSqlText = document.getText();
			savedSidecarSectionCache = new Map<string, Record<string, unknown>>();
			if (sidecarFile) {
				const sections = Array.isArray(sidecarFile.state.sections) ? sidecarFile.state.sections : [];
				let isFirst = true;
				for (const section of sections) {
					const s = section as Record<string, unknown>;
					const id = typeof s.id === 'string' ? s.id : '';
					if (!id) continue;

					if (isFirst) {
						isFirst = false;
						// The sidecar's first section stores linkedQueryPath instead of query.
						// Reconstruct the normalized saved form with the .sql file's text
						// so that comparison against the webview state is accurate.
						const merged: Record<string, unknown> = { ...s, query: savedSqlText };
						delete merged.linkedQueryPath;
						const normalized = normalizeSection(merged);
						if (normalized) {
							savedSidecarSectionCache.set(id, normalized);
						}
						continue;
					}

					const normalized = normalizeSection(section);
					if (normalized) {
						savedSidecarSectionCache.set(id, normalized);
					}
				}
			}
		};
		rebuildSavedCache();

		const postChangedSections = (changes: SectionChangeInfo[]) => {
			try {
				const json = JSON.stringify(changes);
				if (json === lastPostedChangesJson) return;
				lastPostedChangesJson = json;
				void webviewPanel.webview.postMessage({
					type: 'changedSections',
					changes
				} satisfies ChangedSectionsMessage);
			} catch {
				// ignore
			}
		};

		const computeAndPostChanges = (incomingState: KqlxStateV1) => {
			try {
				if (sidecarFile) {
					// Multi-section: compare against sidecar cache.
					const sections = Array.isArray(incomingState.sections) ? incomingState.sections : [];
					const diffMode = vscode.workspace.getConfiguration('kustoWorkbench').get<string>('sectionDiffMode', 'contentAndSettings') === 'contentOnly'
						? 'contentOnly' as const
						: 'contentAndSettings' as const;
					const changes = computeChangedSections(sections, savedSidecarSectionCache, diffMode);
					postChangedSections(changes);
				} else {
					// Single SQL section: compare saved text vs incoming query.
					const firstSql = incomingState.sections.find((s) => String((s as any)?.type ?? '') === 'sql');
					const sqlText = firstSql && typeof (firstSql as any).query === 'string' ? String((firstSql as any).query) : '';
					const normalizeEol = (s: string) => s.replace(/\r\n/g, '\n');
					if (normalizeEol(sqlText) !== normalizeEol(savedSqlText)) {
						const id = typeof (firstSql as any)?.id === 'string' ? String((firstSql as any).id) : '';
						if (id) {
							postChangedSections([{ id, status: 'modified', contentChanged: true, settingsChanged: false }]);
						}
					} else {
						postChangedSections([]);
					}
				}
			} catch {
				// ignore
			}
		};

		const postDocument = (options?: { forceReload?: boolean }) => {
			const forceReload = options?.forceReload ?? false;
			const sqlText = document.getText();
			const sidecarEnabled = !!sidecarFile;
			const sidecarName = getSidecarDisplayName();
			let state: KqlxStateV1;
			if (sidecarEnabled && sidecarFile) {
				const rawSections = Array.isArray(sidecarFile.state.sections) ? sidecarFile.state.sections : [];
				const sections: any[] = rawSections.map((s) => ({ ...(s as any) }));
				const firstType = String(sections[0]?.type ?? '');
				if (sections.length === 0 || firstType !== 'sql') {
					sections.unshift({ type: 'sql' });
				}
				sections[0] = { ...(sections[0] as any), type: 'sql', query: sqlText };
				state = {
					caretDocsEnabled: sidecarFile.state.caretDocsEnabled,
					sections
				};
			} else {
				state = {
					sections: [
						{ type: 'sql', query: sqlText }
					]
				};
			}
			void webviewPanel.webview.postMessage({
				type: 'documentData',
				ok: true,
				forceReload,
				documentUri: document.uri.toString(),
				compatibilityMode: !sidecarEnabled,
				documentKind: 'sql',
				compatibilitySingleKind: 'sql',
				allowedSectionKinds: SqlCompatEditorProvider.allowedSectionKinds,
				defaultSectionKind: 'sql',
				upgradeRequestType: 'requestUpgradeToSqlx',
				compatibilityTooltip: !sidecarEnabled
					? `This is a .sql file. To add sections, Kusto Workbench will create a companion metadata file (${sidecarName}) next to it.`
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
					postDocument({ forceReload: true });
				} catch {
					// ignore
				}
			})
		);

		// When the user explicitly saves the .sql file, also save the companion .json metadata.
		subscriptions.push(
			vscode.workspace.onDidSaveTextDocument(async (saved) => {
				try {
					if (saved.uri.toString() !== document.uri.toString()) {
						return;
					}

					// Rebuild saved-change cache and clear indicators.
					savedSqlText = saved.getText();

					if (!sidecarUri || !sidecarFile) {
						postChangedSections([]);
						return;
					}
					if (!lastKnownSidecarState) {
						return;
					}

					// Treat the .sql and its .sql.json sidecar as a single logical document:
					// only write sidecar changes when the user saves the .sql file.
					if (!sidecarDirty) {
						rebuildSavedCache();
						postChangedSections([]);
						return;
					}
					if (!lastKnownSidecarState) {
						return;
					}
					const persisted = SqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, lastKnownSidecarState);
					const text = stringifyKqlxFile(persisted);
					await vscode.workspace.fs.writeFile(sidecarUri, new TextEncoder().encode(text));
					// Keep in-memory sidecar updated to reflect what we just wrote.
					sidecarFile = persisted;
					lastWrittenSidecarText = text;
					sidecarDirty = false;
					rebuildSavedCache();
					postChangedSections([]);
				} catch {
					// ignore
				}
			})
		);

		webviewPanel.onDidDispose(() => {
			// If the user edited the sidecar metadata but didn't save the .sql file,
			// offer to save the sidecar now so changes aren't lost silently.
			try {
				if (sidecarUri && sidecarFile && lastKnownSidecarState && sidecarDirty) {
					const sidecarUriToSave = sidecarUri;
					const stateToSave = lastKnownSidecarState;
					const sidecarName = getSidecarDisplayName();
					void vscode.window
						.showWarningMessage(
							`You have unsaved notebook metadata changes in ${sidecarName}. Save them now?`,
							{ modal: true },
							'Save',
							'Discard'
						)
						.then(async (choice) => {
							try {
								if (choice !== 'Save') {
									return;
								}
								const persisted = SqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, stateToSave);
								const text = stringifyKqlxFile(persisted);
								await vscode.workspace.fs.writeFile(sidecarUriToSave, new TextEncoder().encode(text));
								sidecarFile = persisted;
								lastWrittenSidecarText = text;
								sidecarDirty = false;
							} catch {
								// ignore
							}
						});
				}
			} catch {
				// ignore
			}

			for (const s of [...disposables, ...subscriptions]) {
				try { s.dispose(); } catch { /* ignore */ }
			}
		});

		webviewPanel.webview.onDidReceiveMessage(async (message: IncomingWebviewMessage) => {
			if (!message || typeof message.type !== 'string') {
				return;
			}
			switch (message.type) {
				case 'requestDocument':
					postPersistenceMode();
					postDocument({ forceReload: true });
					webviewInitialized = true;
					return;
				case 'requestUpgradeToSqlx': {
					const addKind = (message && typeof message.addKind === 'string') ? message.addKind : '';
					const normalizedAddKind = SqlCompatEditorProvider.allowedSectionKinds.includes(addKind as any) ? String(addKind) : '';

					// If the webview provided a fresh state snapshot, prefer it for seeding.
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

					const enabled = await this.enableSidecarForSqlCompat(document, lastKnownSidecarState);
					if (!enabled) {
						return;
					}
					sidecarUri = enabled.uri;
					sidecarFile = enabled.file;
					lastKnownSidecarState = enabled.file.state;
					rebuildSavedCache();
					postPersistenceMode();
					postDocument({ forceReload: true });
					try {
						void webviewPanel.webview.postMessage({ type: 'enabledSqlSidecar', addKind: normalizedAddKind });
					} catch {
						// ignore
					}
					return;
				}
				case 'persistDocument': {
					lastWebviewPersistAt = Date.now();

					const rawState = (message as any)?.state;
					const incomingState: KqlxStateV1 = {
						caretDocsEnabled:
							rawState && typeof rawState.caretDocsEnabled === 'boolean' ? rawState.caretDocsEnabled : undefined,
						sections: rawState && Array.isArray(rawState.sections) ? rawState.sections : []
					};
					lastKnownSidecarState = incomingState;

					// Persist the first SQL section's text back into the plain-text document.
					const firstSql = incomingState.sections.find((s) => (s && String((s as any).type || '') === 'sql'));
					const nextText = firstSql && typeof (firstSql as any).query === 'string' ? String((firstSql as any).query) : '';
					const currentText = (() => {
						try {
							return document.getText();
						} catch {
							return '';
						}
					})();

					const normalizeEol = (s: string) => s.replace(/\r\n/g, '\n');
					const textActuallyChanged = normalizeEol(nextText) !== normalizeEol(currentText);
					const wouldBlankFile = !nextText.trim() && !!currentText.trim();

					const fullRange = new vscode.Range(
						0,
						0,
						document.lineCount ? document.lineCount - 1 : 0,
						document.lineCount ? document.lineAt(document.lineCount - 1).text.length : 0
					);
					if (textActuallyChanged && !wouldBlankFile) {
						const edit = new vscode.WorkspaceEdit();
						edit.replace(document.uri, fullRange, nextText);
						await vscode.workspace.applyEdit(edit);
					}

					// If a sidecar is enabled, persist the full multi-section state to the sidecar file.
					try {
						if (sidecarUri && sidecarFile) {
							const persisted = SqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, incomingState);
							const text = stringifyKqlxFile(persisted);
							sidecarFile = persisted;
							sidecarDirty = (typeof lastWrittenSidecarText === 'string') ? (text !== lastWrittenSidecarText) : true;
						}
					} catch {
						// ignore
					}

					computeAndPostChanges(incomingState);
					return;
				}
				case 'showSectionDiff': {
					const sectionId = typeof (message as any).sectionId === 'string' ? String((message as any).sectionId) : '';
					if (!sectionId) return;
					try {
						const savedNormalized = sidecarFile
							? savedSidecarSectionCache.get(sectionId)
							: undefined;

						let currentSection: Record<string, unknown> | undefined;
						if (lastKnownSidecarState) {
							const sections = Array.isArray(lastKnownSidecarState.sections) ? lastKnownSidecarState.sections : [];
							for (const sec of sections) {
								const s = sec as Record<string, unknown>;
								if (s.id === sectionId) {
									currentSection = normalizeSection(sec) ?? undefined;
									break;
								}
							}
						}

						// For non-sidecar mode, build a synthetic pair from the .sql text.
						if (!sidecarFile && !currentSection) {
							const sqlText = document.getText();
							const sections = Array.isArray(lastKnownSidecarState?.sections) ? lastKnownSidecarState!.sections : [];
							const first = sections.find(s => String((s as any)?.type ?? '') === 'sql');
							if (first && (first as any).id === sectionId) {
								currentSection = normalizeSection(first) ?? undefined;
							}
						}

						const saved = formatSectionDiffContent(
							savedNormalized ?? undefined,
							'section does not exist on disk'
						);
						const current = formatSectionDiffContent(
							currentSection ?? undefined,
							'section not found'
						);

						const savedUri = vscode.Uri.parse(
							`kusto-section-diff:saved/${encodeURIComponent(sectionId)}-settings.txt`
						);
						const currentUri = vscode.Uri.parse(
							`kusto-section-diff:current/${encodeURIComponent(sectionId)}-settings.txt`
						);

						KqlxEditorProvider.sectionDiffContents.set(savedUri.toString(), saved.settingsText);
						KqlxEditorProvider.sectionDiffContents.set(currentUri.toString(), current.settingsText);

						const sectionLabel = sectionId.replace(/_/g, ' ');
						const contentChanged = (saved.content?.text ?? '') !== (current.content?.text ?? '')
							&& !!(saved.content || current.content);

						const diffMode = vscode.workspace.getConfiguration('kustoWorkbench').get<string>('sectionDiffMode', 'contentAndSettings');
						const settingsChanged = saved.settingsText !== current.settingsText;
						const showSettingsDiff = diffMode !== 'contentOnly' && settingsChanged;

						if (showSettingsDiff) {
							await vscode.commands.executeCommand(
								'vscode.diff',
								savedUri,
								currentUri,
								`${sectionLabel} (Saved ↔ Current)`,
								{ preview: !contentChanged } as vscode.TextDocumentShowOptions
							);
						}

						if (contentChanged) {
							const label = current.content?.label ?? saved.content?.label ?? 'Content';
							const savedContentUri = vscode.Uri.parse(
								`kusto-section-diff:saved/${encodeURIComponent(sectionId)}-content.txt`
							);
							const currentContentUri = vscode.Uri.parse(
								`kusto-section-diff:current/${encodeURIComponent(sectionId)}-content.txt`
							);
							KqlxEditorProvider.sectionDiffContents.set(savedContentUri.toString(), saved.content?.text ?? '');
							KqlxEditorProvider.sectionDiffContents.set(currentContentUri.toString(), current.content?.text ?? '');
							await vscode.commands.executeCommand(
								'vscode.diff',
								savedContentUri,
								currentContentUri,
								`${sectionLabel} — ${label} (Saved ↔ Current)`
							);
						}
					} catch (err) {
						console.error('[kusto] showSectionDiff error:', err);
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
		if (sections.length === 0 || firstType !== 'sql') {
			sections.unshift({ type: 'sql' });
		}
		sections[0] = { ...(sections[0] as any), type: 'sql', linkedQueryPath: fileName };
		try {
			delete (sections[0] as any).query;
		} catch {
			// ignore
		}
		return {
			kind: 'sqlx',
			version: 1,
			state: {
				caretDocsEnabled: state.caretDocsEnabled,
				sections
			}
		};
	}

	private async enableSidecarForSqlCompat(
		document: vscode.TextDocument,
		lastKnownWebviewState?: KqlxStateV1
	): Promise<{ uri: vscode.Uri; file: KqlxFileV1 } | undefined> {
		if (document.uri.scheme !== 'file') {
			void vscode.window.showWarningMessage('This feature requires a local .sql file on disk.');
			return undefined;
		}
		const sidecarUri = getSidecarJsonUriForSqlCompat(document.uri);
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
			const parsed = parseKqlxText(text, { allowedKinds: ['sqlx', 'kqlx'], defaultKind: 'sqlx' });
			if (parsed.ok && isLinkedSidecarForSqlFile(sidecarUri, parsed.file, document.uri)) {
				return { uri: sidecarUri, file: parsed.file };
			}
			const overwrite = await vscode.window.showWarningMessage(
				`A sidecar file (${sidecarName}) already exists next to this .sql file, but it does not appear to be linked as a companion metadata file. Overwrite it to enable sidecar metadata?`,
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
					{ type: 'sql' } as any
				]
			};
		})();
		const file = SqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, baseState);
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
