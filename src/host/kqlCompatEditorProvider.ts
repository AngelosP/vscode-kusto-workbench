import * as vscode from 'vscode';

import * as crypto from 'crypto';
import * as path from 'path';

import { ConnectionManager } from './connectionManager';
import { QueryEditorProvider } from './queryEditorProvider';
import { hasSqlOwnedDocumentState } from './kqlxEditorProvider';
import type { SqlWorkbenchService } from './sql/sqlWorkbenchService';
import { EditorCursorStatusBar } from './editorCursorStatusBar';
import { stringifyKqlxFile, type KqlxFileV1, type KqlxStateV1 } from './kqlxFormat';
import { renderDiffInWebview } from './diffViewerUtils';
import { normalizeSection, computeChangedSections, formatSectionDiffContent, KqlxEditorProvider, OwnedDocumentEditTracker } from './kqlxEditorProvider';
import type { SectionChangeInfo, ChangedSectionsMessage } from './queryEditorTypes';
import { perfBegin, perfMark } from './perfTrace';
import { getWorkbenchLogger } from './workbenchLogger';
import { createFileOpenTrace } from './fileOpenTrace';
import { addableSectionKindsForDocument, canonicalAddableSectionKind, defaultSectionKindForDocument } from '../shared/documentSectionCapabilities';

const INITIAL_PROJECTION_MAX_ATTEMPTS = 4;
import { resolveKustoConnection } from '../shared/kustoAuth';
import {
	assertCompatPrimaryIdentity,
	buildCompatSidecarFile,
	getCompatSidecarUri,
	hydrateCompatSidecarState,
	isLinkedCompatSidecar,
	parseCompatSidecarText,
	resolveCompatLinkedUri,
	type CompatSidecarFormat,
} from './compatSidecarFormat';
import {
	CompatSidecarStore,
	compatSidecarFileIdentityEquals,
	readCompatSidecarSnapshot,
	withCompatSidecarLock,
	writeCompatSidecarTextOwned,
	type CompatSidecarFileIdentity,
} from './compatSidecarStore';
import { CompatSidecarSession } from './compatSidecarSession';
import { normalizeWorkbenchUriKey } from './workbenchFileTypes';

const KQL_COMPAT_SIDECAR_FORMAT: CompatSidecarFormat = {
	primaryKind: 'query',
	sidecarKind: 'kqlx',
	acceptedFileKinds: ['kqlx', 'mdx'],
};
const PLAIN_KQL_PRIMARY_SECTION_ID = 'compat_primary_query';

/**
 * Compute the sidecar .kqlx URI for a .kql/.csl compat file.
 * Returns undefined if the URI does not end with .kql or .csl.
 */
export function getSidecarKqlxUriForCompat(uri: vscode.Uri): vscode.Uri | undefined {
	return getCompatSidecarUri(uri, ['.kql', '.csl']);
}

/**
 * Resolve a linked query path relative to a .kqlx URI.
 * Supports file URIs, Windows absolute paths, and relative paths.
 */
export function resolveLinkedQueryUri(kqlxUri: vscode.Uri, linkedQueryPath: string): vscode.Uri {
	return resolveCompatLinkedUri(kqlxUri, linkedQueryPath);
}

/**
 * Check whether a sidecar file is linked to a specific compat document.
 */
export function isLinkedSidecarForCompatFile(sidecarUri: vscode.Uri, sidecarFile: KqlxFileV1, compatDocumentUri: vscode.Uri): boolean {
	return isLinkedCompatSidecar(sidecarUri, sidecarFile, compatDocumentUri, KQL_COMPAT_SIDECAR_FORMAT.primaryKind);
}


/**
 * Generate a stable cache key for pending add-kind operations.
 */
export function pendingAddKindKeyForUri(uri: vscode.Uri): string {
	return `kusto.pendingAddKind:${normalizeWorkbenchUriKey(uri)}`;
}


type IncomingWebviewMessage =
	| { type: 'requestDocument' }
	| { type: 'persistDocument'; state: KqlxStateV1; sourceGeneration?: number; reason?: string; editRevision?: number; snapshotId?: string; flushRequestId?: string; flushUnavailableReason?: string; testOnlyNoop?: boolean }
	| { type: 'documentReloadResult'; requestId: string; applied: boolean; editRevision: number }
	| { type: 'requestUpgradeToKqlx'; addKind?: string; state?: KqlxStateV1; editRevision?: number }
	| { type: string; [key: string]: unknown };

type PublishFreshState = <T>(state: KqlxStateV1, publish: (sanitizedState: KqlxStateV1) => Promise<T>) => Promise<T>;

export class KqlCompatEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'kusto.kqlCompatEditor';

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
		let outerDisposed = false;
		let delayedBeforeUnloadAdmissionOpen = true;
		let sidecarSession: CompatSidecarSession;
		const webviewMessageSubscription = webviewPanel.webview.onDidReceiveMessage((message: IncomingWebviewMessage) => {
			if (!message || typeof message.type !== 'string') {
				return;
			}
			const delayedBeforeUnload = outerDisposed && delayedBeforeUnloadAdmissionOpen
				&& message.type === 'persistDocument' && String((message as any).reason || '') === 'beforeunload';
			const correlatedFinalPersist = outerDisposed && message.type === 'persistDocument'
				&& sidecarSession?.hasPendingFinalPersistRequest(String((message as any).flushRequestId || ''));
			if (outerDisposed && !delayedBeforeUnload && !correlatedFinalPersist) return;
			fileOpenTrace.mark('webview.message.received', { type: message.type, handlerReady: !!handleIncomingWebviewMessage, queued: queuedWebviewMessages.length });
			if (!handleIncomingWebviewMessage) {
				queuedWebviewMessages.push(message);
				fileOpenTrace.mark('webview.message.queued', { type: message.type, queued: queuedWebviewMessages.length });
				return;
			}
			return handleIncomingWebviewMessage(message);
		});
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
		let sidecarLoadError: string | undefined;
		let lastWrittenSidecarText: string | undefined;
		let lastWrittenSidecarIdentity: CompatSidecarFileIdentity | undefined;
		sidecarSession = new CompatSidecarSession(webviewPanel.visible === true, 'KQL');
		perfMark('host.kqlCompat.sidecar.start');
		try {
			sidecarUri = KqlCompatEditorProvider.getSidecarKqlxUriForCompat(document.uri);
			if (sidecarUri && sidecarUri.scheme === 'file') {
				try {
					const snapshot = await readCompatSidecarSnapshot(sidecarUri);
					const text = snapshot.text;
					const parsed = parseCompatSidecarText(text, KQL_COMPAT_SIDECAR_FORMAT);
					if (!parsed.ok) {
						sidecarLoadError = `The companion metadata file is invalid for a Kusto document. ${parsed.error}`;
					} else if (KqlCompatEditorProvider.isLinkedSidecarForCompatFile(sidecarUri, parsed.file, document.uri)) {
						sidecarFile = parsed.file;
						lastWrittenSidecarText = text;
						lastWrittenSidecarIdentity = snapshot.identity;
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
		const sidecarStore = new CompatSidecarStore({
			compatUri: document.uri,
			parse: text => {
				const parsed = parseCompatSidecarText(text, KQL_COMPAT_SIDECAR_FORMAT);
				return parsed.ok ? parsed.file : undefined;
			},
			isLinked: (uri, file) => KqlCompatEditorProvider.isLinkedSidecarForCompatFile(uri, file, document.uri),
			sanitizeFresh: state => queryEditor.sanitizeSqlLeaveNoTraceStateFresh(state),
			publishFresh: (state, publish) => queryEditor.publishSqlLeaveNoTraceStateFresh(state, publish),
			buildFile: (state, baseFile) => KqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, state, baseFile),
			stringify: stringifyKqlxFile,
		});
		const freshSidecarFile = (state: KqlxStateV1) => sidecarStore.buildFresh(state, sidecarFile);
		const writeFreshSidecar = (uri: vscode.Uri, state: KqlxStateV1, expectedCurrentText?: string) =>
			sidecarStore.writeFresh(uri, state, expectedCurrentText, lastWrittenSidecarIdentity);
		const repairPersistedSidecar = (uri: vscode.Uri) => sidecarStore.repair(uri, lastWrittenSidecarIdentity);
		const writeDraftRecoveryFile = (uri: vscode.Uri, state: KqlxStateV1) => sidecarStore.writeRecovery(uri, state);
		if (sidecarUri && sidecarFile && lastWrittenSidecarText !== undefined) {
			const repaired = await repairPersistedSidecar(sidecarUri);
			if (repaired) {
				sidecarFile = repaired.file;
				lastKnownSidecarState = repaired.file.state;
				lastWrittenSidecarText = repaired.text;
				lastWrittenSidecarIdentity = repaired.identity;
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
			const compatibilityMode = !sidecarEnabled && !sidecarLoadError;
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
					allowedSectionKinds: sidecarLoadError ? [] : addableSectionKindsForDocument('kqlx'),
					defaultSectionKind: defaultSectionKindForDocument('kqlx'),
					upgradeRequestType: 'requestUpgradeToKqlx',
					compatibilityTooltip: tooltip,
					firstSectionPinned: !sidecarLoadError,
					documentMutationAllowed: !sidecarLoadError,
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

		let postDocumentGeneration = 0;
		let activeSourceGeneration = 0;
		let pendingSourceGeneration: number | undefined;
		let pendingProjectionEditRevision: number | undefined;
		let sourceReloadEpoch = 0;
		let sourceReloadAuthority: { epoch: number; text: string } | undefined;
		let sourceRollbackFailed = false;
		let sourceRollbackFailedCandidate: string | undefined;
		const sameSourceText = (left: string, right: string) => left.replace(/\r\n?/g, '\n') === right.replace(/\r\n?/g, '\n');
		const postDocument = async (options?: {
			forceReload?: boolean;
			expectedEditRevision?: number;
			sidecarFileOverride?: KqlxFileV1;
			retirePersists?: boolean;
		}): Promise<boolean> => {
			if (options?.retirePersists) {
				sidecarSession.retirePersists();
				const sourceText = document.getText();
				sourceReloadAuthority = { epoch: ++sourceReloadEpoch, text: sourceText };
				if (sourceRollbackFailedCandidate === undefined || !sameSourceText(sourceText, sourceRollbackFailedCandidate)) {
					sourceRollbackFailed = false;
					sourceRollbackFailedCandidate = undefined;
				}
			}
			const generation = ++postDocumentGeneration;
			pendingSourceGeneration = generation;
			const projectionEditRevision = Number(options?.expectedEditRevision);
			pendingProjectionEditRevision = Number.isSafeInteger(projectionEditRevision) && projectionEditRevision >= 0
				? projectionEditRevision
				: undefined;
			const forceReload = options?.forceReload ?? false;
			perfMark('host.kqlCompat.postDocument.start', { forceReload, sidecarEnabled: !!sidecarFile });
			fileOpenTrace.mark('postDocument.start', { forceReload, sidecarEnabled: !!sidecarFile });
			const htmlPowerBiCompatibilityCheckEnabled = vscode.workspace.getConfiguration('kustoWorkbench').get<boolean>('html.powerBiCompatibilityCheck.enabled', true);
			const queryText = document.getText();
			fileOpenTrace.mark('postDocument.documentText.read', { length: queryText.length });
			if (sidecarLoadError) {
				const reload = sidecarSession.createReloadRequest();
				const delivered = await webviewPanel.webview.postMessage({
					type: 'documentData', ok: false, sourceGeneration: generation, forceReload,
					reloadRequestId: reload.requestId, documentUri: document.uri.toString(),
					documentKind: 'kql', allowedSectionKinds: [], error: sidecarLoadError,
					firstSectionPinned: false, documentMutationAllowed: false,
				});
				if (!delivered) sidecarSession.failReload(reload.requestId);
				const applied = await reload.result;
				return applied && generation === postDocumentGeneration && document.getText() === queryText;
			}
			const effectiveSidecarFile = options?.sidecarFileOverride ?? sidecarFile;
			const sidecarEnabled = !!effectiveSidecarFile;
			const sidecarName = getSidecarDisplayName();
			let state: KqlxStateV1;
			if (sidecarEnabled && effectiveSidecarFile) {
				state = hydrateCompatSidecarState(effectiveSidecarFile, queryText, KQL_COMPAT_SIDECAR_FORMAT);
			} else {
				state = {
					sections: [
						{
							id: PLAIN_KQL_PRIMARY_SECTION_ID,
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
			state = await queryEditor.sanitizeSqlLeaveNoTraceStateFresh(state);
			if (outerDisposed || generation !== postDocumentGeneration || document.getText() !== queryText) return false;
			const requiresApplicationAck = true;
			const reload = requiresApplicationAck
				? sidecarSession.createReloadRequest()
				: undefined;
			const reloadRequestId = reload?.requestId;
			const delivered = await webviewPanel.webview.postMessage({
				type: 'documentData',
				ok: true,
				sourceGeneration: generation,
				forceReload,
				editRevision: sidecarSession.currentEditRevision,
				...(options?.expectedEditRevision !== undefined ? { expectedEditRevision: options.expectedEditRevision } : {}),
				...(reloadRequestId ? { reloadRequestId } : {}),
				documentUri: document.uri.toString(),
				suppressPersistenceForTest: this.context.extensionMode !== vscode.ExtensionMode.Production
					&& process.env.KUSTO_WORKBENCH_E2E_SUPPRESS_PERSISTENCE === '1',
				compatibilityMode: !sidecarEnabled,
				documentKind: 'kql',
				compatibilitySingleKind: 'query',
				allowedSectionKinds: addableSectionKindsForDocument('kqlx'),
				defaultSectionKind: defaultSectionKindForDocument('kqlx'),
				upgradeRequestType: 'requestUpgradeToKqlx',
				compatibilityTooltip: !sidecarEnabled
					? `This is a .kql/.csl file. To add sections, Kusto Workbench will create a companion metadata file (${sidecarName}) next to it.`
					: '',
				firstSectionPinned: true,
				documentMutationAllowed: true,
				htmlPowerBiCompatibilityCheckEnabled,
				state
			});
			if (generation !== postDocumentGeneration || document.getText() !== queryText) {
				if (reloadRequestId) sidecarSession.failReload(reloadRequestId);
				return false;
			}
			perfMark('host.kqlCompat.documentData.posted', { sections: state.sections.length, sidecarEnabled });
			fileOpenTrace.mark('postDocument.documentData.posted', { sections: state.sections.length, sidecarEnabled, forceReload });
			if (!delivered && reloadRequestId) {
				sidecarSession.failReload(reloadRequestId);
			}
			const applied = reload ? await reload.result : delivered;
			const appliedCurrent = applied && generation === postDocumentGeneration && document.getText() === queryText;
			if (appliedCurrent) {
				activeSourceGeneration = generation;
			}
			if (appliedCurrent && pendingSourceGeneration === generation) {
				pendingSourceGeneration = undefined;
				pendingProjectionEditRevision = undefined;
			}
			return appliedCurrent;
		};
		const requestFinalPersist = (reason: string, timeoutMs = 2_000): Promise<void> => {
			return sidecarSession.requestFinalPersist(message => webviewPanel.webview.postMessage(message), reason, timeoutMs);
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
				sidecarSession.setPanelVisible(event.webviewPanel.visible);
				if (!event.webviewPanel.visible) {
					void requestFinalPersist('hidden').catch(error => {
						if (!outerDisposed) void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
					});
				}
			}));
		}
		const repairInvalidatedPersistence = () => {
			if (sidecarSession.isClosing || !sidecarUri || !lastKnownSidecarState) return;
			const repairUri = sidecarUri;
			const draftState = lastKnownSidecarState;
			const draftGeneration = sidecarSession.generation;
			const repairEditRevision = sidecarSession.currentEditRevision;
			void sidecarSession.enqueueAfterPersists(async () => {
				const [sanitizedDraft, repaired] = await Promise.all([
					queryEditor.sanitizeSqlLeaveNoTraceStateFresh(draftState),
					repairPersistedSidecar(repairUri),
				]);
				const draftUnchanged = sidecarSession.generation === draftGeneration && lastKnownSidecarState === draftState;
				if (draftUnchanged) {
					lastKnownSidecarState = sanitizedDraft;
				}
				if (!repaired) return;
				sidecarSession.rebaseDraftBase(repaired.inputText, repaired.text);
				sidecarFile = repaired.file;
				lastWrittenSidecarText = repaired.text;
				lastWrittenSidecarIdentity = repaired.identity;
				if (!sidecarSession.isDirty && draftUnchanged
					&& sidecarSession.currentStateEditRevision === repairEditRevision
					&& sidecarSession.currentEditRevision === repairEditRevision) {
					const applied = await postDocument({
						forceReload: true,
						expectedEditRevision: repairEditRevision,
						sidecarFileOverride: repaired.file,
					});
					if (!applied
						|| sidecarSession.generation !== draftGeneration
						|| sidecarSession.currentEditRevision !== repairEditRevision) return;
					lastKnownSidecarState = repaired.file.state;
					sidecarSession.markClean(repairEditRevision);
				}
			}).catch(() => undefined);
		};
		subscriptions.push(queryEditor.onDidInvalidateSqlPersistence(repairInvalidatedPersistence));
		subscriptions.push(queryEditor.onDidInvalidateKustoPersistence(repairInvalidatedPersistence));
		let webviewInitialized = false;
		const ownedDocumentEdits = new OwnedDocumentEditTracker(text => text.replace(/\r\n?/g, '\n'));
		let activeSourceMutations = 0;
		const applyOwnedSourceEdit = async (edit: vscode.WorkspaceEdit, expectedText: string): Promise<boolean> => {
			activeSourceMutations++;
			ownedDocumentEdits.begin(expectedText);
			try {
				const applied = await vscode.workspace.applyEdit(edit);
				if (!applied) ownedDocumentEdits.cancel(expectedText);
				return applied;
			} finally {
				activeSourceMutations--;
			}
		};
		let initialProjectionRecovery: Promise<boolean> | undefined;
		let initialProjectionRestartRequested = false;
		const postInitialDocument = async (): Promise<boolean> => {
			for (let attempt = 0; attempt < INITIAL_PROJECTION_MAX_ATTEMPTS && !outerDisposed; attempt++) {
				const delivered = await postDocument({ forceReload: true, retirePersists: true });
				if (delivered) return true;
			}
			return false;
		};
		const ensureInitialDocument = (allowFollowUp = true): Promise<boolean> => {
			if (webviewInitialized) return Promise.resolve(true);
			if (initialProjectionRecovery) {
				initialProjectionRestartRequested = true;
				return initialProjectionRecovery;
			}
			const run = postInitialDocument().then(delivered => {
				if (delivered) webviewInitialized = true;
				return delivered;
			});
			initialProjectionRecovery = run;
			const settleInitialProjection = () => {
				initialProjectionRecovery = undefined;
				const restart = !webviewInitialized && initialProjectionRestartRequested && allowFollowUp && !outerDisposed;
				initialProjectionRestartRequested = false;
				if (restart) void ensureInitialDocument(false);
			};
			void run.then(settleInitialProjection, settleInitialProjection);
			return initialProjectionRecovery;
		};

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
						if (initialProjectionRecovery) initialProjectionRestartRequested = true;
						else void ensureInitialDocument();
						return;
					}
					if (ownedDocumentEdits.observe(e.document.getText())) return;
					// Notify the webview that the document changed externally.
					// Use forceReload to ensure the webview updates even if already initialized.
					void postDocument({ forceReload: true, retirePersists: true }).catch(() => undefined);
				} catch {
					// ignore
				}
			})
		);

		// When the user explicitly saves the .kql/.csl file, also save the companion .json metadata.
		subscriptions.push(
			vscode.workspace.onWillSaveTextDocument((event) => {
				if (event.document.uri.toString() !== document.uri.toString()) return;
				if (sourceRollbackFailed || activeSourceMutations > 0) {
					event.waitUntil(Promise.reject(new Error('Cannot save because a source update is still settling or an external reload could not be restored. Reload the file and try again.')));
					return;
				}
				event.waitUntil(requestFinalPersist('save').then(() => sidecarSession.waitForPersists()).then(
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
					if (sidecarSession.isClosing || saved.uri.toString() !== document.uri.toString()) {
						return;
					}
					const saveWork = sidecarSession.enqueueAfterPersists(async () => {
						// Rebuild saved-change cache and clear indicators.
						savedQueryText = saved.getText();
						if (!sidecarUri || !sidecarFile) {
							postChangedSections([]);
							return;
						}
						if (!lastKnownSidecarState) return;
						if (!sidecarSession.isDirty) {
							rebuildSavedCache();
							postChangedSections([]);
							return;
						}
						const { file: persisted, text, identity } = await writeFreshSidecar(sidecarUri, lastKnownSidecarState, sidecarSession.baseText ?? lastWrittenSidecarText);
						sidecarFile = persisted;
						lastWrittenSidecarText = text;
						lastWrittenSidecarIdentity = identity;
						sidecarSession.markClean();
						rebuildSavedCache();
						postChangedSections([]);
					});
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
					await sidecarSession.waitForFinalPersists();
					if (sidecarSession.isPanelVisible) await sidecarSession.waitForBeforeUnload();
					else await new Promise<void>(resolve => setImmediate(resolve));
					delayedBeforeUnloadAdmissionOpen = false;
					sidecarSession.beginClose();
					for (const subscription of subscriptions) {
						try { subscription.dispose(); } catch { /* ignore */ }
					}
					await sidecarSession.waitForPersists();
					if (sidecarUri && sidecarFile && lastKnownSidecarState && sidecarSession.isDirty) {
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
							const { file: persisted, text, identity } = await writeFreshSidecar(sidecarUriToSave, stateToSave, sidecarSession.baseText ?? lastWrittenSidecarText);
							sidecarFile = persisted;
							lastWrittenSidecarText = text;
							lastWrittenSidecarIdentity = identity;
							sidecarSession.markClean();
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
							lastWrittenSidecarIdentity = repaired.identity;
						}
					}
					await sidecarStore.drain();
				} catch {
					// The sidecar may already be unavailable.
				} finally {
					sidecarSession.settleClose();
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
					const revision = Number(message.editRevision);
					sidecarSession.completeReload(requestId, message.applied === true, revision);
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
					webviewInitialized = webviewInitialized
						? await postDocument({ forceReload: true, retirePersists: true })
						: await ensureInitialDocument();
					perfMark('host.kqlCompat.requestDocument.completed');
					fileOpenTrace.mark('requestDocument.completed');
					return;
				case 'requestUpgradeToKqlx': {
					if (sidecarLoadError) {
						void vscode.window.showErrorMessage(sidecarLoadError);
						return;
					}
					const upgradeRevision = Number((message as any).editRevision);
					const upgrade = await sidecarSession.beginUpgrade(upgradeRevision);
					if (!upgrade) return;
					try {
					const addKind = (message && typeof message.addKind === 'string') ? message.addKind : '';
					const normalizedAddKind = canonicalAddableSectionKind('kqlx', addKind) ?? '';

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
					lastWrittenSidecarIdentity = enabled.identity;
					lastKnownSidecarState = enabled.file.state;
					sidecarSession.markClean(upgradeRevision);
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
						upgrade.finish();
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
					if (sidecarLoadError) {
						if (flushRequestId) sidecarSession.completeFinalPersist(flushRequestId, new Error(sidecarLoadError));
						return;
					}
					const incomingSourceGeneration = Number((message as any).sourceGeneration);
					const incomingRevisionForPending = Number((message as any).editRevision);
					const sourceGenerationMissing = !Number.isSafeInteger(incomingSourceGeneration);
					const supersedesPendingProjection = pendingSourceGeneration !== undefined
						&& pendingProjectionEditRevision !== undefined
						&& Number.isSafeInteger(incomingRevisionForPending)
						&& incomingRevisionForPending > pendingProjectionEditRevision
						&& incomingSourceGeneration === activeSourceGeneration;
					if (supersedesPendingProjection) {
						pendingSourceGeneration = undefined;
						pendingProjectionEditRevision = undefined;
						postDocumentGeneration++;
					}
					if ((snapshotId || flushRequestId) && (!supersedesPendingProjection && pendingSourceGeneration !== undefined
						|| (sourceGenerationMissing && this.context.extensionMode === vscode.ExtensionMode.Production)
						|| (!sourceGenerationMissing && incomingSourceGeneration !== activeSourceGeneration))) {
						if (flushRequestId) sidecarSession.completeFinalPersist(flushRequestId, new Error('The final KQL metadata snapshot belonged to an older source projection.'));
						return;
					}
					if (flushRequestId && (message as any).flushUnavailableReason) {
						getWorkbenchLogger().warn('[kusto] KQL metadata snapshot unavailable during save; saving primary text only.');
						sidecarSession.completeFinalPersist(flushRequestId);
						return;
					}
					const testOnlyNoop = (message as any).testOnlyNoop === true
						&& this.context.extensionMode !== vscode.ExtensionMode.Production;
					if (testOnlyNoop) {
						const revision = Number((message as any)?.editRevision);
						const hasRevision = Number.isSafeInteger(revision) && revision >= 0;
						if (hasRevision && sidecarSession.isStaleRevision(revision)) {
							if (flushRequestId) sidecarSession.completeFinalPersist(flushRequestId, new Error('The final KQL metadata snapshot was stale.'));
							return;
						}
						if (hasRevision) sidecarSession.adoptRevision(revision, 'replace');
						if (snapshotId && !outerDisposed) {
							try { void Promise.resolve(webviewPanel.webview.postMessage({ type: 'persistDocumentAck', snapshotId, editRevision: sidecarSession.currentEditRevision })).catch(() => undefined); }
							catch { /* ignore */ }
						}
						if (flushRequestId) sidecarSession.completeFinalPersist(flushRequestId);
						sidecarSession.markBeforeUnload((message as any).reason);
						return;
					}
					if (sidecarSession.isClosing) {
						if (flushRequestId) sidecarSession.completeFinalPersist(flushRequestId, new Error('The KQL metadata editor closed before its final snapshot was admitted.'));
						return;
					}
					const revision = Number((message as any)?.editRevision);
					const hasRevision = Number.isSafeInteger(revision) && revision >= 0;
					if (hasRevision && sidecarSession.isStaleRevision(revision)) {
						if (flushRequestId) sidecarSession.completeFinalPersist(flushRequestId, new Error('The final KQL metadata snapshot was stale.'));
						sidecarSession.markBeforeUnload((message as any).reason);
						return;
					}
					if (hasRevision) sidecarSession.adoptRevision(revision);
					const incomingEditRevision = hasRevision ? revision : sidecarSession.currentEditRevision;
					const reloadEpochAtAdmission = sourceReloadEpoch;
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
					const superseded = () => ({ ok: false as const, error: new Error('The KQL metadata snapshot was superseded before admission.') });
					const run = sidecarSession.queuePersist(incomingEditRevision, async persistIsCurrent => {
						if (!persistIsCurrent()) return superseded();
						if (!sidecarFile) {
							try {
								assertCompatPrimaryIdentity(incomingRawState, 'query', PLAIN_KQL_PRIMARY_SECTION_ID);
								if (incomingRawState.sections.length !== 1) {
									throw new Error('Plain KQL snapshots may contain only the pinned primary section.');
								}
							} catch (error) {
								return { ok: false as const, error: error instanceof Error ? error : new Error(String(error)) };
							}
						}

						let incomingState: KqlxStateV1;
						try {
							incomingState = await queryEditor.sanitizeSqlLeaveNoTraceStateFresh<KqlxStateV1>(incomingRawState);
						} catch (error) {
							void vscode.window.showErrorMessage(`Failed to prepare companion metadata: ${error instanceof Error ? error.message : String(error)}`);
							return { ok: false as const, error: new Error(`Failed to prepare KQL companion metadata: ${error instanceof Error ? error.message : String(error)}`) };
						}
						if (!persistIsCurrent()) return superseded();

						let persistedSidecar: KqlxFileV1 | undefined;
						let validatedSidecarDraft: KqlxFileV1 | undefined;
						try {
							if (sidecarUri && sidecarFile) {
								validatedSidecarDraft = KqlCompatEditorProvider.buildSidecarFileForCompat(
									document.uri,
									incomingState,
									sidecarFile,
								);
							}
							const candidate = await freshSidecarFile(incomingState);
							if (sidecarUri && sidecarFile) persistedSidecar = candidate;
						} catch (error) {
							const primaryQuery = incomingState.sections[0] as Record<string, unknown> | undefined;
							const nextText = typeof primaryQuery?.query === 'string' ? primaryQuery.query : '';
							const currentText = (() => {
								try { return document.getText(); } catch { return ''; }
							})();
							if (validatedSidecarDraft && persistIsCurrent()
								&& nextText.replace(/\r\n/g, '\n') === currentText.replace(/\r\n/g, '\n')) {
								lastKnownSidecarState = incomingState;
								sidecarSession.setStateRevision(incomingEditRevision);
								const text = stringifyKqlxFile(validatedSidecarDraft);
								sidecarSession.setMaterializedDirty(text !== lastWrittenSidecarText, lastWrittenSidecarText);
								computeAndPostChanges(incomingState);
							}
							void vscode.window.showErrorMessage(`Failed to prepare companion metadata: ${error instanceof Error ? error.message : String(error)}`);
							return { ok: false as const, error: new Error(`Failed to materialize KQL companion metadata: ${error instanceof Error ? error.message : String(error)}`) };
						}
						if (!persistIsCurrent()) return superseded();

						// Section zero is the identity-pinned owner of the plain-text document.
						const primaryQuery = incomingState.sections[0] as Record<string, unknown> | undefined;
						const nextText = typeof primaryQuery?.query === 'string' ? primaryQuery.query : '';
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
							if (!await applyOwnedSourceEdit(edit, nextText)) {
								return { ok: false as const, error: new Error('VS Code rejected the final KQL text update.') };
							}
							if (normalizeEol(document.getText()) !== normalizeEol(nextText)) {
								void postDocument({ forceReload: true, retirePersists: true });
								return superseded();
							}
							if (!persistIsCurrent()) {
								const authority = sourceReloadAuthority;
								if (authority && authority.epoch > reloadEpochAtAdmission
									&& sourceReloadAuthority === authority
									&& sameSourceText(document.getText(), nextText)) {
									sourceRollbackFailed = true;
									sourceRollbackFailedCandidate = nextText;
									for (let rollbackAttempt = 0; rollbackAttempt < 3; rollbackAttempt++) {
										if (sourceReloadAuthority !== authority || !sameSourceText(document.getText(), nextText)) break;
										const rollback = new vscode.WorkspaceEdit();
										const lineCount = Math.max(1, document.lineCount || 1);
										rollback.replace(document.uri, new vscode.Range(0, 0, lineCount - 1, document.lineAt(lineCount - 1).text.length), authority.text);
										await applyOwnedSourceEdit(rollback, authority.text);
										if (sameSourceText(document.getText(), authority.text)) break;
									}
									if (sameSourceText(document.getText(), nextText)) {
										sourceRollbackFailed = true;
										sourceRollbackFailedCandidate = nextText;
									} else {
										sourceRollbackFailed = false;
										sourceRollbackFailedCandidate = undefined;
									}
								}
								return superseded();
							}
						}

						if (!persistIsCurrent()) return superseded();
						lastKnownSidecarState = incomingState;
						sidecarSession.setStateRevision(incomingEditRevision);
						if (persistedSidecar) {
							const text = stringifyKqlxFile(persistedSidecar);
							const nextDirty = (typeof lastWrittenSidecarText === 'string') ? (text !== lastWrittenSidecarText) : true;
							sidecarFile = persistedSidecar;
							sidecarSession.setMaterializedDirty(nextDirty, lastWrittenSidecarText);
						}

						// Section-level change detection.
						computeAndPostChanges(incomingState);
						return { ok: true as const };
					});
					sidecarSession.markBeforeUnload((message as any).reason);
					try {
						const outcome = await run;
						if (!outcome.ok) {
							if (flushRequestId) sidecarSession.completeFinalPersist(flushRequestId, outcome.error);
							return;
						}
						if (snapshotId && !outerDisposed) {
							try { void Promise.resolve(webviewPanel.webview.postMessage({ type: 'persistDocumentAck', snapshotId, editRevision: incomingEditRevision })).catch(() => undefined); }
							catch { /* ignore */ }
						}
						if (flushRequestId) sidecarSession.completeFinalPersist(flushRequestId);
					} catch (error) {
						if (flushRequestId) {
							sidecarSession.completeFinalPersist(flushRequestId, new Error(`Failed to admit the final KQL metadata snapshot: ${error instanceof Error ? error.message : String(error)}`));
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

	private static buildSidecarFileForCompat(compatUri: vscode.Uri, state: KqlxStateV1, baseFile?: KqlxFileV1): KqlxFileV1 {
		return buildCompatSidecarFile(compatUri, state, KQL_COMPAT_SIDECAR_FORMAT, baseFile);
	}

	private async enableSidecarKqlxForCompat(
		document: vscode.TextDocument,
		inferredSelection: { clusterUrl: string; database: string; authorityId?: string; connectionIdHint?: string } | undefined,
		lastKnownWebviewState?: KqlxStateV1,
		publishStateFresh?: PublishFreshState,
	): Promise<{ uri: vscode.Uri; file: KqlxFileV1; text: string; identity?: CompatSidecarFileIdentity } | undefined> {
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
		let creationBaselineIdentity: CompatSidecarFileIdentity | undefined;
		const adoptLinkedSidecar = async (): Promise<{ uri: vscode.Uri; file: KqlxFileV1; text: string; identity?: CompatSidecarFileIdentity }> => {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const baseline = await readCompatSidecarSnapshot(sidecarUri);
				const currentText = baseline.text;
				const parsed = parseCompatSidecarText(currentText, KQL_COMPAT_SIDECAR_FORMAT);
				if (!parsed.ok || !KqlCompatEditorProvider.isLinkedSidecarForCompatFile(sidecarUri, parsed.file, document.uri)) {
					throw new Error(!parsed.ok
						? `The companion sidecar became invalid before it could be adopted. ${parsed.error}`
						: 'The companion sidecar changed before it could be adopted.');
				}
				const baselineFile = KqlCompatEditorProvider.buildSidecarFileForCompat(
					document.uri, parsed.file.state, parsed.file,
				);
				const publication = await (publishStateFresh
					? publishStateFresh(baselineFile.state, publish)
					: publish(baselineFile.state));
				async function publish(state: KqlxStateV1) {
					return withCompatSidecarLock(targetSidecarUri, baseline.identity, async () => {
						const locked = await readCompatSidecarSnapshot(targetSidecarUri);
						if (!compatSidecarFileIdentityEquals(baseline.identity, locked.identity)
							|| locked.text !== currentText) return { raced: true as const };
						const file = KqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, state, baselineFile);
						const text = stringifyKqlxFile(file);
						const identity = text !== currentText
							? await writeCompatSidecarTextOwned(targetSidecarUri, text, baseline.identity, currentText)
							: baseline.identity;
						return { raced: false as const, value: { uri: targetSidecarUri, file, text, identity } };
					});
				}
				if (publication.raced) continue;
				return publication.value;
			}
			throw new Error('The companion sidecar kept changing before it could be adopted.');
		};

		// If a sidecar already exists, prefer using it if it's already linked.
		let existingBaseline: Awaited<ReturnType<typeof readCompatSidecarSnapshot>> | undefined;
		try {
			existingBaseline = await readCompatSidecarSnapshot(sidecarUri);
		} catch {
			// does not exist
		}
		if (existingBaseline) {
			const baseline = existingBaseline;
			const text = baseline.text;
			const parsed = parseCompatSidecarText(text, KQL_COMPAT_SIDECAR_FORMAT);
			if (!parsed.ok) {
				void vscode.window.showErrorMessage(`The existing companion sidecar is invalid for a Kusto document. ${parsed.error}`);
				return undefined;
			}
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
			creationBaselineIdentity = baseline.identity;
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
		let identity: CompatSidecarFileIdentity | undefined;
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
				return withCompatSidecarLock(targetSidecarUri, creationBaselineIdentity, async () => {
					if (await readCurrentText() !== creationBaselineText) throw new Error('The companion sidecar changed while it was being created.');
					const createdFile = KqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, state);
					const createdText = stringifyKqlxFile(createdFile);
					const identity = await writeCompatSidecarTextOwned(
						targetSidecarUri, createdText, creationBaselineIdentity, creationBaselineText,
					);
					return { file: createdFile, text: createdText, identity };
				});
			}
			file = publication.file;
			text = publication.text;
			identity = publication.identity;
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

		return { uri: sidecarUri, file, text, identity };
	}
}
