import * as vscode from 'vscode';

import * as crypto from 'crypto';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';

import { ConnectionManager } from './connectionManager';
import { QueryEditorProvider } from './queryEditorProvider';
import { hasSqlOwnedDocumentState } from './kqlxEditorProvider';
import type { SqlWorkbenchService } from './sql/sqlWorkbenchService';
import { EditorCursorStatusBar } from './editorCursorStatusBar';
import { parseKqlxText, stringifyKqlxFile, type KqlxFileV1, type KqlxStateV1 } from './kqlxFormat';
import { renderDiffInWebview } from './diffViewerUtils';
import { normalizeSection, computeChangedSections, formatSectionDiffContent, KqlxEditorProvider } from './kqlxEditorProvider';
import type { SectionChangeInfo, ChangedSectionsMessage } from './queryEditorTypes';
import { perfBegin, perfMark } from './perfTrace';
import { getWorkbenchLogger } from './workbenchLogger';
import { createFileOpenTrace } from './fileOpenTrace';
import { resolveKustoConnection } from '../shared/kustoAuth';

/**
 * Compute the sidecar .kqlx URI for a .kql/.csl compat file.
 * Returns undefined if the URI does not end with .kql or .csl.
 */
export function getSidecarKqlxUriForCompat(uri: vscode.Uri): vscode.Uri | undefined {
	try {
		const ext = String(uri.path || '').toLowerCase();
		if (!ext.endsWith('.kql') && !ext.endsWith('.csl')) {
			return undefined;
		}
		return uri.with({ path: uri.path + '.json' });
	} catch {
		return undefined;
	}
}

/**
 * Resolve a linked query path relative to a .kqlx URI.
 * Supports file URIs, Windows absolute paths, and relative paths.
 */
export function resolveLinkedQueryUri(kqlxUri: vscode.Uri, linkedQueryPath: string): vscode.Uri {
	try {
		const raw = String(linkedQueryPath || '').trim();
		if (!raw) {
			return kqlxUri;
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
		const kqlxDir = path.posix.dirname(kqlxUri.path);
		const joined = path.posix.normalize(path.posix.join(kqlxDir, raw));
		return kqlxUri.with({ path: joined });
	} catch {
		return kqlxUri;
	}
}

/**
 * Check whether a sidecar file is linked to a specific compat document.
 */
export function isLinkedSidecarForCompatFile(sidecarUri: vscode.Uri, sidecarFile: KqlxFileV1, compatDocumentUri: vscode.Uri): boolean {
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
		const resolved = resolveLinkedQueryUri(sidecarUri, linked);
		if (resolved.scheme === 'file' && compatDocumentUri.scheme === 'file') {
			return resolved.fsPath.toLowerCase() === compatDocumentUri.fsPath.toLowerCase();
		}
		return resolved.toString() === compatDocumentUri.toString();
	} catch {
		return false;
	}
}


/**
 * Generate a stable cache key for pending add-kind operations.
 */
export function pendingAddKindKeyForUri(uri: vscode.Uri): string {
	try {
		if (uri.scheme === 'file') {
			return `kusto.pendingAddKind:${uri.fsPath.toLowerCase()}`;
		}
	} catch {
		// ignore
	}
	return `kusto.pendingAddKind:${uri.toString()}`;
}


type IncomingWebviewMessage =
	| { type: 'requestDocument' }
	| { type: 'persistDocument'; state: KqlxStateV1; reason?: string; editRevision?: number; snapshotId?: string; flushRequestId?: string; testOnlyNoop?: boolean }
	| { type: 'documentReloadResult'; requestId: string; applied: boolean; editRevision: number }
	| { type: 'requestUpgradeToKqlx'; addKind?: string; state?: KqlxStateV1; editRevision?: number }
	| { type: string; [key: string]: unknown };

type PublishFreshState = <T>(state: KqlxStateV1, publish: (sanitizedState: KqlxStateV1) => Promise<T>) => Promise<T>;

export class KqlCompatEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'kusto.kqlCompatEditor';

	private static readonly allowedSectionKinds: Array<'query' | 'chart' | 'transformation' | 'markdown' | 'python' | 'url' | 'html' | 'sql'> =
		['query', 'sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'];

	private static getSidecarKqlxUriForCompat(uri: vscode.Uri): vscode.Uri | undefined {
		return getSidecarKqlxUriForCompat(uri);
	}

	private static resolveLinkedQueryUri(kqlxUri: vscode.Uri, linkedQueryPath: string): vscode.Uri {
		return resolveLinkedQueryUri(kqlxUri, linkedQueryPath);
	}

	private static isLinkedSidecarForCompatFile(sidecarUri: vscode.Uri, sidecarFile: KqlxFileV1, compatDocumentUri: vscode.Uri): boolean {
		return isLinkedSidecarForCompatFile(sidecarUri, sidecarFile, compatDocumentUri);
	}

	public static register(
		context: vscode.ExtensionContext,
		extensionUri: vscode.Uri,
		connectionManager: ConnectionManager,
		sqlWorkbench: SqlWorkbenchService,
		editorCursorStatusBar?: EditorCursorStatusBar
	): vscode.Disposable {
		const provider = new KqlCompatEditorProvider(context, extensionUri, connectionManager, sqlWorkbench, editorCursorStatusBar);
		return vscode.window.registerCustomEditorProvider(KqlCompatEditorProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true }
		});
	}

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager,
		private readonly sqlWorkbench: SqlWorkbenchService,
		private readonly editorCursorStatusBar?: EditorCursorStatusBar
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
				getWorkbenchLogger().error('[KqlCompatEditor] Tab API error:', err instanceof Error ? err : String(err));
			}
		}
		
		return { isDiff: false };
	}

	private static pendingAddKindKeyForUri(uri: vscode.Uri): string {
		return pendingAddKindKeyForUri(uri);
	}

	public async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		const fileOpenTrace = createFileOpenTrace('kqlCompat', { scheme: document.uri.scheme, path: document.uri.path, visible: webviewPanel.visible, active: webviewPanel.active });
		perfBegin('host.kqlCompat.resolve', {
			scheme: document.uri.scheme,
			path: document.uri.path,
		});
		// Detect if this editor is being opened as part of a diff view.
		// VS Code uses special URI schemes for source control diffs (e.g., 'git', 'gitfs').
		// When in diff mode, render our Monaco-based diff viewer directly in this webview.
		const diffContext = this.detectDiffContext(document);
		fileOpenTrace.mark('diffContext.detected', { isDiff: diffContext.isDiff, hasOriginalUri: !!diffContext.originalUri });
		if (diffContext.isDiff && diffContext.originalUri) {
			// This is the "original" side (git: scheme) of a diff view.
			// Render a Monaco-based diff viewer showing original vs working copy.
			await renderDiffInWebview(webviewPanel, this.extensionUri, diffContext.originalUri);
			return;
		}
		// For the "modified" side (file: scheme) or normal usage, render the regular editor.

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri]
		};
		fileOpenTrace.mark('webview.options.set');

		const queryEditor = new QueryEditorProvider(this.extensionUri, this.connectionManager, this.context, this.sqlWorkbench, this.editorCursorStatusBar);
		queryEditor.fileOpenTrace = fileOpenTrace;
		queryEditor.documentUri = document.uri.toString();
		let handleIncomingWebviewMessage: ((message: IncomingWebviewMessage) => Promise<void>) | undefined;
		const queuedWebviewMessages: IncomingWebviewMessage[] = [];
		const webviewMessageSubscription = webviewPanel.webview.onDidReceiveMessage((message: IncomingWebviewMessage) => {
			if (!message || typeof message.type !== 'string') {
				return;
			}
			fileOpenTrace.mark('webview.message.received', { type: message.type, handlerReady: !!handleIncomingWebviewMessage, queued: queuedWebviewMessages.length });
			if (!handleIncomingWebviewMessage) {
				queuedWebviewMessages.push(message);
				fileOpenTrace.mark('webview.message.queued', { type: message.type, queued: queuedWebviewMessages.length });
				return;
			}
			return handleIncomingWebviewMessage(message);
		});
		let outerDisposed = false;
		const outerDisposalSubscription = webviewPanel.onDidDispose(() => { outerDisposed = true; });
		perfMark('host.kqlCompat.initializeWebview.start');
		fileOpenTrace.mark('initializeWebviewPanel.start');
		await queryEditor.initializeWebviewPanel(webviewPanel, { registerMessageHandler: false, initialDocumentLoading: true });
		if (outerDisposed) {
			webviewMessageSubscription.dispose();
			outerDisposalSubscription.dispose();
			return;
		}
		perfMark('host.kqlCompat.initializeWebview.done');
		fileOpenTrace.mark('initializeWebviewPanel.done');

		// Best-effort default selection for plain `.kql/.csl` files (no embedded metadata).
		// Priority: 1) cached file connection, 2) query-based inference.
		// This is intentionally non-fatal: if we can't resolve, the UI falls back to last selection.
		let cachedFileConnection: { clusterUrl: string; database: string; authorityId?: string; connectionIdHint?: string } | undefined;
		perfMark('host.kqlCompat.cachedFileConnection.start');
		fileOpenTrace.mark('cachedFileConnection.start');
		try {
			if (document.uri.scheme === 'file') {
				const cached = this.connectionManager.getFileConnection(document.uri.fsPath);
				if (cached) {
					const resolution = resolveKustoConnection(this.connectionManager.getConnections(), cached);
					if (resolution.kind === 'matched') {
						cachedFileConnection = {
							clusterUrl: resolution.connection.clusterUrl,
							database: cached.database,
							authorityId: resolution.connection.authorityId,
							connectionIdHint: resolution.connection.id,
						};
					}
				}
			}
		} catch {
			cachedFileConnection = undefined;
		}
		perfMark('host.kqlCompat.cachedFileConnection.done', { found: !!cachedFileConnection });
		fileOpenTrace.mark('cachedFileConnection.done', { found: !!cachedFileConnection });

		let inferredSelection: { clusterUrl: string; database: string; authorityId?: string; connectionIdHint?: string } | undefined;
		if (cachedFileConnection) {
			// Use the cached connection — skip query-based inference.
			inferredSelection = cachedFileConnection;
		} else {
			try {
				perfMark('host.kqlCompat.inference.start', { length: document.getText().length });
				inferredSelection = await queryEditor.inferClusterDatabaseForKqlQuery(document.getText());
				perfMark('host.kqlCompat.inference.done', { found: !!inferredSelection });
			} catch {
				inferredSelection = undefined;
				perfMark('host.kqlCompat.inference.error');
			}
		}

		// Sidecar support: if there is a sibling .kqlx file that links back to this .kql/.csl,
		// use it to store multi-section metadata while keeping the query text in the plain file.
		let sidecarUri: vscode.Uri | undefined;
		let sidecarFile: KqlxFileV1 | undefined;
		let lastWrittenSidecarText: string | undefined;
		let sidecarDirty = false;
		let sidecarDraftBaseText: string | undefined;
		let sidecarDraftGeneration = 0;
		let sidecarPersistSequence = 0;
		let sidecarPersistTail: Promise<void> = Promise.resolve();
		let sidecarUpgradeBarrier: Promise<void> | undefined;
		let sidecarClosing = false;
		let webviewEditRevision = 0;
		let sidecarStateEditRevision = 0;
		let finalPersistRequestTail: Promise<void> = Promise.resolve();
		let lastKnownPanelVisible = webviewPanel.visible === true;
		let beforeUnloadPersistObserved = false;
		let resolveBeforeUnloadPersist!: () => void;
		const beforeUnloadPersist = new Promise<void>(resolve => { resolveBeforeUnloadPersist = resolve; });
		const markBeforeUnloadPersist = (reason: unknown) => {
			if (beforeUnloadPersistObserved || String(reason || '') !== 'beforeunload') return;
			beforeUnloadPersistObserved = true;
			resolveBeforeUnloadPersist();
		};
		const waitForBeforeUnloadPersist = async (timeoutMs = 500): Promise<void> => {
			if (beforeUnloadPersistObserved) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					beforeUnloadPersist,
					new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		};
		const pendingFinalPersistRequests = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
		const pendingReloadResults = new Map<string, { resolve: (applied: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
		perfMark('host.kqlCompat.sidecar.start');
		try {
			sidecarUri = KqlCompatEditorProvider.getSidecarKqlxUriForCompat(document.uri);
			if (sidecarUri && sidecarUri.scheme === 'file') {
				try {
					const bytes = await vscode.workspace.fs.readFile(sidecarUri);
					const text = new TextDecoder().decode(bytes);
					const parsed = parseKqlxText(text, { allowedKinds: ['kqlx', 'mdx'], defaultKind: 'kqlx' });
					if (parsed.ok && KqlCompatEditorProvider.isLinkedSidecarForCompatFile(sidecarUri, parsed.file, document.uri)) {
						sidecarFile = parsed.file;
						lastWrittenSidecarText = text;
					}
				} catch {
					// ignore
				}
			}
		} catch {
			// ignore
		}
		perfMark('host.kqlCompat.sidecar.done', { found: !!sidecarFile });

		let lastKnownSidecarState: KqlxStateV1 | undefined = sidecarFile?.state;
		const freshSidecarFile = async (state: KqlxStateV1): Promise<KqlxFileV1> => {
			const sanitized = await queryEditor.sanitizeSqlLeaveNoTraceStateFresh(state);
			return KqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, sanitized);
		};
		let sidecarWriteTail: Promise<void> = Promise.resolve();
		const withSidecarLock = async <T>(uri: vscode.Uri, work: () => Promise<T>): Promise<T> => {
			if (uri.scheme !== 'file') return work();
			const lockTarget = `${uri.fsPath}.write`;
			await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(lockTarget)));
			const release = await lockfile.lock(lockTarget, {
				realpath: false, stale: 30_000, update: 5_000,
				retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 25 },
			});
			try { return await work(); }
			finally { await release(); }
		};
		const serializeSidecarWrite = async <T>(work: () => Promise<T>): Promise<T> => {
			let result!: T;
			const run = sidecarWriteTail.catch(() => undefined).then(async () => { result = await work(); });
			sidecarWriteTail = run.then(() => undefined, () => undefined);
			await run;
			return result;
		};
		const writeFreshSidecar = async (uri: vscode.Uri, state: KqlxStateV1, expectedCurrentText?: string): Promise<{ file: KqlxFileV1; text: string }> => {
			return serializeSidecarWrite(() => queryEditor.publishSqlLeaveNoTraceStateFresh(state, sanitized => withSidecarLock(uri, async () => {
				const baselineText = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
				if (expectedCurrentText !== undefined && baselineText !== expectedCurrentText) throw new Error('The companion sidecar changed in another window. Reopen it before saving metadata.');
				const file = KqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, sanitized);
				const text = stringifyKqlxFile(file);
				const publishText = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
				if (publishText !== baselineText) throw new Error('The companion sidecar changed in another window. Reopen it before saving metadata.');
				await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
				return { file, text };
			})));
		};
		const repairPersistedSidecar = async (uri: vscode.Uri): Promise<{ file: KqlxFileV1; inputText: string; text: string } | undefined> => {
			return serializeSidecarWrite(async () => {
				for (let attempt = 0; attempt < 3; attempt += 1) {
					const currentText = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
					const parsed = parseKqlxText(currentText, { allowedKinds: ['kqlx', 'mdx'], defaultKind: 'kqlx' });
					if (!parsed.ok || !KqlCompatEditorProvider.isLinkedSidecarForCompatFile(uri, parsed.file, document.uri)) return undefined;
					const publication = await queryEditor.publishSqlLeaveNoTraceStateFresh(parsed.file.state, sanitized => withSidecarLock(uri, async () => {
						const publishText = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
						if (publishText !== currentText) return { raced: true as const };
						const file = KqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, sanitized);
						const text = stringifyKqlxFile(file);
						if (text !== currentText) await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
						return { raced: false as const, value: { file, inputText: currentText, text } };
					}));
					if (publication.raced) continue;
					return publication.value;
				}
				return undefined;
			});
		};
		const writeDraftRecoveryFile = async (uri: vscode.Uri, state: KqlxStateV1): Promise<vscode.Uri> => {
			const recoveryUri = uri.with({ path: `${uri.path}.recovery-${Date.now()}-${crypto.randomUUID()}.json` });
			return serializeSidecarWrite(() => queryEditor.publishSqlLeaveNoTraceStateFresh(state, sanitized => withSidecarLock(uri, async () => {
				const recoveryFile = KqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, sanitized);
				await vscode.workspace.fs.writeFile(recoveryUri, new TextEncoder().encode(stringifyKqlxFile(recoveryFile)));
				return recoveryUri;
			})));
		};
		if (sidecarUri && sidecarFile && lastWrittenSidecarText !== undefined) {
			const repaired = await repairPersistedSidecar(sidecarUri);
			if (repaired) {
				sidecarFile = repaired.file;
				lastKnownSidecarState = repaired.file.state;
				lastWrittenSidecarText = repaired.text;
			}
		}

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
			const htmlPowerBiCompatibilityCheckEnabled = vscode.workspace.getConfiguration('kustoWorkbench').get<boolean>('html.powerBiCompatibilityCheck.enabled', true);
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
					compatibilityTooltip: tooltip,
					firstSectionPinned: sidecarEnabled,
					htmlPowerBiCompatibilityCheckEnabled
				});
			} catch {
				// ignore
			}
		};

		postPersistenceMode();

		// ── Section-level unsaved-changes tracking ──────────────────────────
		// For kqlCompat, changes are detected by comparing the current webview state
		// against the last-saved state. With sidecar: multi-section comparison.
		// Without sidecar: single query section comparison against the .kql file text.
		let savedQueryText = document.getText();
		let savedSidecarSectionCache = new Map<string, Record<string, unknown>>();
		let lastPostedChangesJson = '';

		const rebuildSavedCache = () => {
			savedQueryText = document.getText();
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
						// The webview state has the actual query text, not linkedQueryPath.
						// Reconstruct the normalized saved form with the .kql file's query text
						// so that comparison against the webview state is accurate.
						const merged: Record<string, unknown> = { ...s, query: savedQueryText };
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
				if (outerDisposed) return;
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
					// Single query: compare saved text vs incoming query.
					const firstQuery = incomingState.sections.find((s) => String((s as any)?.type ?? '') === 'query');
					const queryText = firstQuery && typeof (firstQuery as any).query === 'string' ? String((firstQuery as any).query) : '';
					const normalizeEol = (s: string) => s.replace(/\r\n/g, '\n');
					if (normalizeEol(queryText) !== normalizeEol(savedQueryText)) {
						const id = typeof (firstQuery as any)?.id === 'string' ? String((firstQuery as any).id) : '';
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

		const postDocument = async (options?: {
			forceReload?: boolean;
			expectedEditRevision?: number;
			sidecarFileOverride?: KqlxFileV1;
		}): Promise<boolean> => {
			const forceReload = options?.forceReload ?? false;
			perfMark('host.kqlCompat.postDocument.start', { forceReload, sidecarEnabled: !!sidecarFile });
			fileOpenTrace.mark('postDocument.start', { forceReload, sidecarEnabled: !!sidecarFile });
			const htmlPowerBiCompatibilityCheckEnabled = vscode.workspace.getConfiguration('kustoWorkbench').get<boolean>('html.powerBiCompatibilityCheck.enabled', true);
			const queryText = document.getText();
			fileOpenTrace.mark('postDocument.documentText.read', { length: queryText.length });
			const effectiveSidecarFile = options?.sidecarFileOverride ?? sidecarFile;
			const sidecarEnabled = !!effectiveSidecarFile;
			const sidecarName = getSidecarDisplayName();
			let state: KqlxStateV1;
			if (sidecarEnabled && effectiveSidecarFile) {
				const rawSections = Array.isArray(effectiveSidecarFile.state.sections) ? effectiveSidecarFile.state.sections : [];
				const sections: any[] = rawSections.map((s) => ({ ...(s as any) }));
				const firstType = String(sections[0]?.type ?? '');
				if (sections.length === 0 || (firstType !== 'query' && firstType !== 'copilotQuery')) {
					sections.unshift({ type: 'query' });
				}
				sections[0] = { ...(sections[0] as any), type: 'query', query: queryText };
				state = {
					caretDocsEnabled: effectiveSidecarFile.state.caretDocsEnabled,
					autoTriggerAutocompleteEnabled: effectiveSidecarFile.state.autoTriggerAutocompleteEnabled,
					sections
				};
			} else {
				state = {
					sections: [
						{
							type: 'query',
							query: queryText,
							...(inferredSelection ? {
								clusterUrl: inferredSelection.clusterUrl,
								authorityId: inferredSelection.authorityId,
								connectionIdHint: inferredSelection.connectionIdHint,
								database: inferredSelection.database,
							} : {})
						}
					]
				};
			}
			state = hasSqlOwnedDocumentState(state)
				? await queryEditor.sanitizeSqlLeaveNoTraceStateFresh(state)
				: queryEditor.sanitizeSqlLeaveNoTraceState(state);
			const reloadRequestId = options?.expectedEditRevision !== undefined
				? `document-reload-${Date.now()}-${Math.random().toString(16).slice(2)}`
				: undefined;
			let reloadResult: Promise<boolean> | undefined;
			if (reloadRequestId) {
				reloadResult = new Promise<boolean>(resolve => {
					const timer = setTimeout(() => {
						pendingReloadResults.delete(reloadRequestId);
						resolve(false);
					}, 5000);
					pendingReloadResults.set(reloadRequestId, { resolve, timer });
				});
			}
			const delivered = await webviewPanel.webview.postMessage({
				type: 'documentData',
				ok: true,
				forceReload,
				editRevision: webviewEditRevision,
				...(options?.expectedEditRevision !== undefined ? { expectedEditRevision: options.expectedEditRevision } : {}),
				...(reloadRequestId ? { reloadRequestId } : {}),
				documentUri: document.uri.toString(),
				suppressPersistenceForTest: this.context.extensionMode !== vscode.ExtensionMode.Production
					&& process.env.KUSTO_WORKBENCH_E2E_SUPPRESS_PERSISTENCE === '1',
				compatibilityMode: !sidecarEnabled,
				documentKind: 'kql',
				compatibilitySingleKind: 'query',
				allowedSectionKinds: KqlCompatEditorProvider.allowedSectionKinds,
				defaultSectionKind: 'query',
				upgradeRequestType: 'requestUpgradeToKqlx',
				compatibilityTooltip: !sidecarEnabled
					? `This is a .kql/.csl file. To add sections, Kusto Workbench will create a companion metadata file (${sidecarName}) next to it.`
					: '',
				htmlPowerBiCompatibilityCheckEnabled,
				state
			});
			perfMark('host.kqlCompat.documentData.posted', { sections: state.sections.length, sidecarEnabled });
			fileOpenTrace.mark('postDocument.documentData.posted', { sections: state.sections.length, sidecarEnabled, forceReload });
			if (!delivered && reloadRequestId) {
				const pending = pendingReloadResults.get(reloadRequestId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingReloadResults.delete(reloadRequestId);
					pending.resolve(false);
				}
			}
			return reloadResult ? await reloadResult : delivered;
		};

		const completeFinalPersistRequest = (requestId: string, error?: Error) => {
			const pending = pendingFinalPersistRequests.get(requestId);
			if (!pending) return;
			clearTimeout(pending.timer);
			pendingFinalPersistRequests.delete(requestId);
			if (error) pending.reject(error);
			else pending.resolve();
		};
		const requestFinalPersist = (reason: string, timeoutMs = 2_000): Promise<void> => {
			const request = finalPersistRequestTail.catch(() => undefined).then(async () => {
				const requestId = `final-persist-${Date.now()}-${Math.random().toString(16).slice(2)}`;
				let resolveResponse!: () => void;
				let rejectResponse!: (error: Error) => void;
				const response = new Promise<void>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
				const timer = setTimeout(() => completeFinalPersistRequest(requestId, new Error('Timed out waiting for the final KQL metadata snapshot.')), timeoutMs);
				pendingFinalPersistRequests.set(requestId, { resolve: resolveResponse, reject: rejectResponse, timer });
				try {
					void Promise.resolve(webviewPanel.webview.postMessage({ type: 'requestFinalPersist', requestId, reason })).then(
						delivered => {
							if (!delivered) completeFinalPersistRequest(requestId, new Error('The final KQL metadata snapshot request was not delivered.'));
						},
						error => completeFinalPersistRequest(requestId, new Error(`The final KQL metadata snapshot request failed: ${error instanceof Error ? error.message : String(error)}`)),
					);
				} catch (error) {
					completeFinalPersistRequest(requestId, new Error(`The final KQL metadata snapshot request failed: ${error instanceof Error ? error.message : String(error)}`));
				}
				await response;
			});
			finalPersistRequestTail = request.then(() => undefined, () => undefined);
			return request;
		};

		// Track if the webview has initialized and whether it's currently being edited by the user.
		if (outerDisposed) {
			webviewMessageSubscription.dispose();
			outerDisposalSubscription.dispose();
			return;
		}
		const subscriptions: vscode.Disposable[] = [webviewMessageSubscription, outerDisposalSubscription];
		if (typeof (webviewPanel as any).onDidChangeViewState === 'function') {
			subscriptions.push((webviewPanel as any).onDidChangeViewState((event: { webviewPanel: vscode.WebviewPanel }) => {
				lastKnownPanelVisible = event.webviewPanel.visible;
				if (!event.webviewPanel.visible) {
					void requestFinalPersist('hidden').catch(error => {
						if (!outerDisposed) void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
					});
				}
			}));
		}
		subscriptions.push(queryEditor.onDidInvalidateSqlPersistence(() => {
			if (!sidecarUri || !lastKnownSidecarState) return;
			const draftState = lastKnownSidecarState;
			const draftGeneration = sidecarDraftGeneration;
			const repairEditRevision = webviewEditRevision;
			void Promise.all([
				queryEditor.sanitizeSqlLeaveNoTraceStateFresh(draftState),
				repairPersistedSidecar(sidecarUri),
			]).then(async ([sanitizedDraft, repaired]) => {
				const draftUnchanged = sidecarDraftGeneration === draftGeneration && lastKnownSidecarState === draftState;
				if (draftUnchanged) {
					lastKnownSidecarState = sanitizedDraft;
				}
				if (!repaired) return;
				if (sidecarDirty && sidecarDraftBaseText === repaired.inputText) sidecarDraftBaseText = repaired.text;
				if (!sidecarDirty && draftUnchanged
					&& sidecarStateEditRevision === repairEditRevision
					&& webviewEditRevision === repairEditRevision) {
					const applied = await postDocument({
						forceReload: true,
						expectedEditRevision: repairEditRevision,
						sidecarFileOverride: repaired.file,
					});
					if (!applied
						|| sidecarDraftGeneration !== draftGeneration
						|| webviewEditRevision !== repairEditRevision) return;
					sidecarFile = repaired.file;
					lastKnownSidecarState = repaired.file.state;
					sidecarStateEditRevision = repairEditRevision;
					lastWrittenSidecarText = repaired.text;
					sidecarDraftBaseText = undefined;
				} else if (sidecarDirty) {
					lastWrittenSidecarText = repaired.text;
				}
			}).catch(() => undefined);
		}));
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
					void postDocument({ forceReload: true }).catch(() => undefined);
				} catch {
					// ignore
				}
			})
		);

		// When the user explicitly saves the .kql/.csl file, also save the companion .json metadata.
		subscriptions.push(
			vscode.workspace.onWillSaveTextDocument((event) => {
				if (event.document.uri.toString() !== document.uri.toString()) return;
				event.waitUntil(requestFinalPersist('save').then(() => sidecarPersistTail).then(
					() => [] as vscode.TextEdit[],
					error => {
						void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
						throw error;
					},
				));
			})
		);
		subscriptions.push(
			vscode.workspace.onDidSaveTextDocument(async (saved) => {
				try {
					if (saved.uri.toString() !== document.uri.toString()) {
						return;
					}
					const saveWork = sidecarPersistTail.catch(() => undefined).then(async () => {
						// Rebuild saved-change cache and clear indicators.
						savedQueryText = saved.getText();
						if (!sidecarUri || !sidecarFile) {
							postChangedSections([]);
							return;
						}
						if (!lastKnownSidecarState) return;
						if (!sidecarDirty) {
							rebuildSavedCache();
							postChangedSections([]);
							return;
						}
						const { file: persisted, text } = await writeFreshSidecar(sidecarUri, lastKnownSidecarState, sidecarDraftBaseText ?? lastWrittenSidecarText);
						sidecarFile = persisted;
						lastWrittenSidecarText = text;
						sidecarDirty = false;
						sidecarDraftBaseText = undefined;
						sidecarStateEditRevision = webviewEditRevision;
						rebuildSavedCache();
						postChangedSections([]);
					});
					sidecarPersistTail = saveWork.then(() => undefined, () => undefined);
					await saveWork;
				} catch (error) {
					void vscode.window.showErrorMessage(`Failed to save companion metadata: ${error instanceof Error ? error.message : String(error)}`);
				}
			})
		);

		webviewPanel.onDidDispose(() => {
			void (async () => {
				let saveRequested = false;
				try {
					await finalPersistRequestTail;
					if (lastKnownPanelVisible) await waitForBeforeUnloadPersist();
					else await new Promise<void>(resolve => setImmediate(resolve));
					sidecarClosing = true;
					await sidecarPersistTail;
					if (sidecarUri && sidecarFile && lastKnownSidecarState && sidecarDirty) {
						const sidecarUriToSave = sidecarUri;
						const stateToSave = lastKnownSidecarState;
						const sidecarName = getSidecarDisplayName();
						const choice = await vscode.window.showWarningMessage(
							`You have unsaved notebook metadata changes in ${sidecarName}. Save them now?`,
							{ modal: true },
							'Save',
							'Discard'
						);
						if (choice === 'Save') {
							saveRequested = true;
							const { file: persisted, text } = await writeFreshSidecar(sidecarUriToSave, stateToSave, sidecarDraftBaseText ?? lastWrittenSidecarText);
							sidecarFile = persisted;
							lastWrittenSidecarText = text;
							sidecarDirty = false;
							sidecarDraftBaseText = undefined;
							sidecarStateEditRevision = webviewEditRevision;
						}
					}
				} catch (error) {
					if (saveRequested && sidecarUri && lastKnownSidecarState) {
						try {
							const recoveryUri = await writeDraftRecoveryFile(sidecarUri, lastKnownSidecarState);
							void vscode.window.showErrorMessage(`Companion metadata changed before close. The sanitized draft was recovered to ${recoveryUri.fsPath}.`);
						} catch {
							void vscode.window.showErrorMessage(`Failed to save companion metadata: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
				}
				try {
					if (sidecarUri) {
						const repaired = await repairPersistedSidecar(sidecarUri);
						if (repaired) {
							sidecarFile = repaired.file;
							lastWrittenSidecarText = repaired.text;
						}
					}
					await sidecarWriteTail;
				} catch {
					// The sidecar may already be unavailable.
				} finally {
					for (const [requestId] of pendingFinalPersistRequests) {
						completeFinalPersistRequest(requestId, new Error('The KQL metadata editor closed before its final snapshot was confirmed.'));
					}
					for (const [requestId, pending] of pendingReloadResults) {
						clearTimeout(pending.timer);
						pendingReloadResults.delete(requestId);
						pending.resolve(false);
					}
					for (const s of subscriptions) {
						try { s.dispose(); } catch { /* ignore */ }
					}
				}
			})();
		});

		handleIncomingWebviewMessage = async (message: IncomingWebviewMessage) => {
			if (!message || typeof message.type !== 'string') {
				return;
			}
			switch (message.type) {
				case 'documentReloadResult': {
					const requestId = String(message.requestId || '');
					const pending = pendingReloadResults.get(requestId);
					if (pending) {
						clearTimeout(pending.timer);
						pendingReloadResults.delete(requestId);
						const revision = Number(message.editRevision);
						if (Number.isSafeInteger(revision) && revision >= 0) webviewEditRevision = Math.max(webviewEditRevision, revision);
						pending.resolve(message.applied === true);
					}
					return;
				}
				case 'requestDocument':
					perfMark('host.kqlCompat.requestDocument.received');
					fileOpenTrace.mark('requestDocument.received');
					// Re-send mode in response to a request (the webview is guaranteed to be listening).
					postPersistenceMode();
					// In Explorer single-click preview mode, VS Code can reuse the same webview
					// panel for different files. Force reload here so documentData is always
					// re-applied for the current document.
					await postDocument({ forceReload: true });
					webviewInitialized = true;
					perfMark('host.kqlCompat.requestDocument.completed');
					fileOpenTrace.mark('requestDocument.completed');
					return;
				case 'requestUpgradeToKqlx': {
					if (sidecarUpgradeBarrier) await sidecarUpgradeBarrier;
					const upgradeRevision = Number((message as any).editRevision);
					if (!Number.isSafeInteger(upgradeRevision) || upgradeRevision < webviewEditRevision) return;
					webviewEditRevision = upgradeRevision;
					const persistBeforeUpgrade = sidecarPersistTail;
					let releaseUpgrade!: () => void;
					const upgradeBarrier = new Promise<void>(resolve => { releaseUpgrade = resolve; });
					sidecarUpgradeBarrier = upgradeBarrier;
					try {
						await persistBeforeUpgrade.catch(() => undefined);
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
								autoTriggerAutocompleteEnabled:
									rawState && typeof rawState.autoTriggerAutocompleteEnabled === 'boolean'
										? rawState.autoTriggerAutocompleteEnabled
										: undefined,
								sections: rawState && Array.isArray(rawState.sections) ? rawState.sections : []
							};
						}
					} catch {
						// ignore
					}

					if (lastKnownSidecarState) {
						lastKnownSidecarState = await queryEditor.sanitizeSqlLeaveNoTraceStateFresh(lastKnownSidecarState);
					}
					const enabled = await this.enableSidecarKqlxForCompat(
						document,
						inferredSelection,
						lastKnownSidecarState,
						(state, publish) => queryEditor.publishSqlLeaveNoTraceStateFresh(state, publish),
					);
					if (!enabled) {
						return;
					}
					sidecarUri = enabled.uri;
					sidecarFile = enabled.file;
					lastWrittenSidecarText = enabled.text;
					sidecarDraftBaseText = undefined;
					sidecarDirty = false;
					lastKnownSidecarState = enabled.file.state;
					sidecarStateEditRevision = upgradeRevision;
					rebuildSavedCache();
					postPersistenceMode();
					await postDocument({ forceReload: true, expectedEditRevision: upgradeRevision });
					try {
						void webviewPanel.webview.postMessage({ type: 'enabledKqlxSidecar', addKind: normalizedAddKind });
					} catch {
						// ignore
					}
					return;
					} finally {
						releaseUpgrade();
						if (sidecarUpgradeBarrier === upgradeBarrier) sidecarUpgradeBarrier = undefined;
					}
				}
				case 'saveLastSelection': {
					// The user manually changed the connection (via cluster/database dropdowns
					// or favorites picker). Cache the connection for this file immediately
					// so it persists across sessions, completely independent of file saves.
					try {
						if (!sidecarFile && document.uri.scheme === 'file') {
							const connectionId = String((message as any).connectionId || '').trim();
							const database = String((message as any).database || '').trim();
							if (connectionId) {
								const conn = this.connectionManager.getConnections().find(c => c.id === connectionId);
								const clusterUrl = conn ? String(conn.clusterUrl || '').trim() : '';
								if (clusterUrl) {
									await this.connectionManager.setFileConnection(document.uri.fsPath, clusterUrl, database, {
										authorityId: conn?.authorityId,
										connectionIdHint: conn?.id,
									});
									// Keep inferredSelection in sync so postDocument() reflects
									// the latest connection on external-change reload or re-init.
									inferredSelection = { clusterUrl, database, authorityId: conn?.authorityId, connectionIdHint: conn?.id };
								}
							}
						}
					} catch {
						// ignore
					}
					// Fall through to let QueryEditorProvider handle the global last-selection save.
					await queryEditor.handleWebviewMessage(message as any);
					return;
				}
				case 'persistDocument': {
					const snapshotId = String((message as any).snapshotId || '').trim();
					const flushRequestId = String((message as any).flushRequestId || '').trim();
					const testOnlyNoop = (message as any).testOnlyNoop === true
						&& this.context.extensionMode !== vscode.ExtensionMode.Production;
					if (testOnlyNoop) {
						const revision = Number((message as any)?.editRevision);
						const hasRevision = Number.isSafeInteger(revision) && revision >= 0;
						if (hasRevision && revision < webviewEditRevision) {
							if (flushRequestId) completeFinalPersistRequest(flushRequestId, new Error('The final KQL metadata snapshot was stale.'));
							return;
						}
						if (hasRevision) webviewEditRevision = revision;
						if (snapshotId && !outerDisposed) {
							try { void webviewPanel.webview.postMessage({ type: 'persistDocumentAck', snapshotId, editRevision: webviewEditRevision }); }
							catch { /* ignore */ }
						}
						if (flushRequestId) completeFinalPersistRequest(flushRequestId);
						markBeforeUnloadPersist((message as any).reason);
						return;
					}
					if (sidecarClosing) {
						if (flushRequestId) completeFinalPersistRequest(flushRequestId, new Error('The KQL metadata editor closed before its final snapshot was admitted.'));
						return;
					}
					const revision = Number((message as any)?.editRevision);
					const hasRevision = Number.isSafeInteger(revision) && revision >= 0;
					if (hasRevision && revision < webviewEditRevision) {
						if (flushRequestId) completeFinalPersistRequest(flushRequestId, new Error('The final KQL metadata snapshot was stale.'));
						markBeforeUnloadPersist((message as any).reason);
						return;
					}
					if (hasRevision) webviewEditRevision = Math.max(webviewEditRevision, revision);
					const incomingEditRevision = hasRevision ? revision : webviewEditRevision;
					const persistSequence = ++sidecarPersistSequence;
					sidecarDraftGeneration += 1;
					const rawState = (message as any)?.state;
					const incomingRawState: KqlxStateV1 = {
						caretDocsEnabled:
							rawState && typeof rawState.caretDocsEnabled === 'boolean' ? rawState.caretDocsEnabled : undefined,
						autoTriggerAutocompleteEnabled:
							rawState && typeof rawState.autoTriggerAutocompleteEnabled === 'boolean'
								? rawState.autoTriggerAutocompleteEnabled
								: undefined,
						sections: rawState && Array.isArray(rawState.sections) ? rawState.sections : []
					};
					const persistIsCurrent = () => persistSequence === sidecarPersistSequence && incomingEditRevision >= webviewEditRevision;
					const upgradeBeforePersist = sidecarUpgradeBarrier;
					const superseded = () => ({ ok: false as const, error: new Error('The KQL metadata snapshot was superseded before admission.') });
					const run = Promise.all([
						sidecarPersistTail.catch(() => undefined),
						upgradeBeforePersist?.catch(() => undefined) ?? Promise.resolve(),
					]).then(async () => {
						if (!persistIsCurrent()) return superseded();
						lastWebviewPersistAt = Date.now();

						// Persist the first query section's text back into the plain-text document.
						const firstQuery = incomingRawState.sections.find((s) => (s && String((s as any).type || '') === 'query'));
						const nextText = firstQuery && typeof (firstQuery as any).query === 'string' ? String((firstQuery as any).query) : '';
						const currentText = (() => {
							try {
								return document.getText();
							} catch {
								return '';
							}
						})();

					// Normalize line endings before comparing to prevent false dirty state
					// from EOL differences (Monaco normalizes CRLF → LF, but the TextDocument
					// may still have CRLF). Without this, merely selecting a cluster/database
					// on a Windows-EOL .kql file would mark the document dirty.
						const normalizeEol = (s: string) => s.replace(/\r\n/g, '\n');
						const textActuallyChanged = normalizeEol(nextText) !== normalizeEol(currentText);

					// Safety net: never replace non-empty file content with empty text.
					// This protects against race conditions where the webview sends empty
					// query text (e.g., Monaco editor not yet initialized).
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
							if (!await vscode.workspace.applyEdit(edit)) {
								return { ok: false as const, error: new Error('VS Code rejected the final KQL text update.') };
							}
							if (!persistIsCurrent()) return superseded();
						}

						let incomingState: KqlxStateV1;
						try {
							incomingState = await queryEditor.sanitizeSqlLeaveNoTraceStateFresh<KqlxStateV1>(incomingRawState);
						} catch (error) {
							if (persistIsCurrent() && sidecarUri && sidecarFile) {
								lastKnownSidecarState = incomingRawState;
								if (!sidecarDirty) sidecarDraftBaseText = lastWrittenSidecarText;
								sidecarDirty = true;
								computeAndPostChanges(incomingRawState);
							}
							void vscode.window.showErrorMessage(`Failed to prepare companion metadata: ${error instanceof Error ? error.message : String(error)}`);
							return { ok: false as const, error: new Error(`Failed to prepare KQL companion metadata: ${error instanceof Error ? error.message : String(error)}`) };
						}
						if (!persistIsCurrent()) return superseded();

						let persistedSidecar: KqlxFileV1 | undefined;
						if (sidecarUri && sidecarFile) {
							try {
								persistedSidecar = await freshSidecarFile(incomingState);
							} catch (error) {
								if (persistIsCurrent()) {
									lastKnownSidecarState = incomingState;
									if (!sidecarDirty) sidecarDraftBaseText = lastWrittenSidecarText;
									sidecarDirty = true;
									computeAndPostChanges(incomingState);
								}
								void vscode.window.showErrorMessage(`Failed to prepare companion metadata: ${error instanceof Error ? error.message : String(error)}`);
								return { ok: false as const, error: new Error(`Failed to materialize KQL companion metadata: ${error instanceof Error ? error.message : String(error)}`) };
							}
							if (!persistIsCurrent()) return superseded();
						}

						if (!persistIsCurrent()) return superseded();
						lastKnownSidecarState = incomingState;
						sidecarStateEditRevision = incomingEditRevision;
						if (persistedSidecar) {
							const text = stringifyKqlxFile(persistedSidecar);
							const nextDirty = (typeof lastWrittenSidecarText === 'string') ? (text !== lastWrittenSidecarText) : true;
							sidecarFile = persistedSidecar;
							if (nextDirty && !sidecarDirty) sidecarDraftBaseText = lastWrittenSidecarText;
							if (!nextDirty) sidecarDraftBaseText = undefined;
							sidecarDirty = nextDirty;
						}

						// Section-level change detection.
						computeAndPostChanges(incomingState);
						return { ok: true as const };
					});
					sidecarPersistTail = run.then(() => undefined, () => undefined);
					markBeforeUnloadPersist((message as any).reason);
					try {
						const outcome = await run;
						if (!outcome.ok) {
							if (flushRequestId) completeFinalPersistRequest(flushRequestId, outcome.error);
							return;
						}
						if (snapshotId && !outerDisposed) {
							try { void webviewPanel.webview.postMessage({ type: 'persistDocumentAck', snapshotId, editRevision: incomingEditRevision }); }
							catch { /* ignore */ }
						}
						if (flushRequestId) completeFinalPersistRequest(flushRequestId);
					} catch (error) {
						if (flushRequestId) {
							completeFinalPersistRequest(flushRequestId, new Error(`Failed to admit the final KQL metadata snapshot: ${error instanceof Error ? error.message : String(error)}`));
						}
					}
					return;
				}
				case 'showSectionDiff': {
					const sectionId = typeof (message as any).sectionId === 'string' ? String((message as any).sectionId) : '';
					if (!sectionId) return;
					try {
						// Get the saved version from cache.
						const savedNormalized = sidecarFile
							? savedSidecarSectionCache.get(sectionId)
							: undefined;

						// Get the current version from the in-memory state.
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

						// For non-sidecar mode, build a synthetic pair from the .kql text.
						if (!sidecarFile && !currentSection) {
							const queryText = document.getText();
							const sections = Array.isArray(lastKnownSidecarState?.sections) ? lastKnownSidecarState!.sections : [];
							const first = sections.find(s => String((s as any)?.type ?? '') === 'query');
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

						// When diffMode is contentOnly, skip the settings JSON diff entirely.
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
							getWorkbenchLogger().error('[kusto] showSectionDiff error:', err instanceof Error ? err : String(err));
					}
					return;
				}
				default:
					await queryEditor.handleWebviewMessage(message as any);
			}
		};

		for (const queuedMessage of queuedWebviewMessages.splice(0)) {
			fileOpenTrace.mark('webview.message.flushQueued', { type: queuedMessage.type });
			await handleIncomingWebviewMessage(queuedMessage);
		}
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
				autoTriggerAutocompleteEnabled: state.autoTriggerAutocompleteEnabled,
				sections
			}
		};
	}

	private async enableSidecarKqlxForCompat(
		document: vscode.TextDocument,
		inferredSelection: { clusterUrl: string; database: string; authorityId?: string; connectionIdHint?: string } | undefined,
		lastKnownWebviewState?: KqlxStateV1,
		publishStateFresh?: PublishFreshState,
	): Promise<{ uri: vscode.Uri; file: KqlxFileV1; text: string } | undefined> {
		if (document.uri.scheme !== 'file') {
			void vscode.window.showWarningMessage('This feature requires a local .kql/.csl file on disk.');
			return undefined;
		}
		const sidecarUri = KqlCompatEditorProvider.getSidecarKqlxUriForCompat(document.uri);
		if (!sidecarUri) return undefined;
		const targetSidecarUri = sidecarUri;
		const sidecarName = (() => {
			try { return path.posix.basename(sidecarUri.path); }
			catch { return 'sidecar'; }
		})();
		const choice = await vscode.window.showInformationMessage(
			`To add notebook sections, Kusto Workbench will create a companion metadata file (${sidecarName}) next to this file to store metadata (charts, markdown, etc).`,
			{ modal: true },
			'Create companion file',
		);
		if (choice !== 'Create companion file') return undefined;
		let creationBaselineText: string | undefined;
		const lockTarget = `${sidecarUri.fsPath}.write`;
		const adoptLinkedSidecar = async (): Promise<{ uri: vscode.Uri; file: KqlxFileV1; text: string }> => {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const currentText = new TextDecoder().decode(await vscode.workspace.fs.readFile(sidecarUri));
				const parsed = parseKqlxText(currentText, { allowedKinds: ['kqlx', 'mdx'], defaultKind: 'kqlx' });
				if (!parsed.ok || !KqlCompatEditorProvider.isLinkedSidecarForCompatFile(sidecarUri, parsed.file, document.uri)) {
					throw new Error('The companion sidecar changed before it could be adopted.');
				}
				const publication = await (publishStateFresh
					? publishStateFresh(parsed.file.state, publish)
					: publish(parsed.file.state));
				async function publish(state: KqlxStateV1) {
					const release = await lockfile.lock(lockTarget, {
						realpath: false, stale: 30_000, update: 5_000,
						retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 25 },
					});
					try {
						const publishText = new TextDecoder().decode(await vscode.workspace.fs.readFile(targetSidecarUri));
						if (publishText !== currentText) return { raced: true as const };
						const file = KqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, state);
						const text = stringifyKqlxFile(file);
						if (text !== currentText) await vscode.workspace.fs.writeFile(targetSidecarUri, new TextEncoder().encode(text));
						return { raced: false as const, value: { uri: targetSidecarUri, file, text } };
					} finally {
						await release();
					}
				}
				if (publication.raced) continue;
				return publication.value;
			}
			throw new Error('The companion sidecar kept changing before it could be adopted.');
		};

		// If a sidecar already exists, prefer using it if it's already linked.
		try {
			const bytes = await vscode.workspace.fs.readFile(sidecarUri);
			const text = new TextDecoder().decode(bytes);
			const parsed = parseKqlxText(text, { allowedKinds: ['kqlx', 'mdx'], defaultKind: 'kqlx' });
			if (parsed.ok && KqlCompatEditorProvider.isLinkedSidecarForCompatFile(sidecarUri, parsed.file, document.uri)) {
				return await adoptLinkedSidecar();
			}
			const overwrite = await vscode.window.showWarningMessage(
				`A sidecar file (${sidecarName}) already exists next to this .kql/.csl file, but it does not appear to be linked as a companion metadata file. Overwrite it to enable sidecar metadata?`,
				{ modal: true },
				'Overwrite sidecar'
			);
			if (overwrite !== 'Overwrite sidecar') {
				return undefined;
			}
			creationBaselineText = text;
		} catch {
			// does not exist
		}

		// Seed the sidecar with the most recent UI state if we have it.
		// This preserves per-box connection selection and persisted results across the transition.
		const baseState: KqlxStateV1 = (() => {
			try {
				if (lastKnownWebviewState && Array.isArray(lastKnownWebviewState.sections) && lastKnownWebviewState.sections.length > 0) {
					return {
						caretDocsEnabled: lastKnownWebviewState.caretDocsEnabled,
						autoTriggerAutocompleteEnabled: lastKnownWebviewState.autoTriggerAutocompleteEnabled,
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
						...(inferredSelection ? {
							clusterUrl: inferredSelection.clusterUrl,
							authorityId: inferredSelection.authorityId,
							connectionIdHint: inferredSelection.connectionIdHint,
							database: inferredSelection.database,
						} : {})
					} as any
				]
			};
		})();
		let file: KqlxFileV1;
		let text: string;
		const readCurrentText = async (): Promise<string | undefined> => {
			try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(sidecarUri)); }
			catch (error) {
				if ((error as { code?: string })?.code === 'FileNotFound') return undefined;
				throw error;
			}
		};
		try {
			const publication = await (publishStateFresh
				? publishStateFresh(baseState, publish)
				: publish(baseState));
			async function publish(state: KqlxStateV1) {
				const release = await lockfile.lock(lockTarget, {
					realpath: false, stale: 30_000, update: 5_000,
					retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 25 },
				});
				try {
					if (await readCurrentText() !== creationBaselineText) throw new Error('The companion sidecar changed while it was being created.');
					const createdFile = KqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, state);
					const createdText = stringifyKqlxFile(createdFile);
					await vscode.workspace.fs.writeFile(targetSidecarUri, new TextEncoder().encode(createdText));
					return { file: createdFile, text: createdText };
				} finally {
					await release();
				}
			}
			file = publication.file;
			text = publication.text;
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

		return { uri: sidecarUri, file, text };
	}
}
