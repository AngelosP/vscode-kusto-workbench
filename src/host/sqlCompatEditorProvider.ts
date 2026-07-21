import * as vscode from 'vscode';

import * as path from 'path';
import * as lockfile from 'proper-lockfile';

import { ConnectionManager } from './connectionManager';
import { QueryEditorProvider } from './queryEditorProvider';
import type { SqlWorkbenchService } from './sql/sqlWorkbenchService';
import { EditorCursorStatusBar } from './editorCursorStatusBar';
import { parseKqlxText, stringifyKqlxFile, type KqlxFileV1, type KqlxStateV1 } from './kqlxFormat';
import { renderDiffInWebview } from './diffViewerUtils';
import { normalizeSection, computeChangedSections, formatSectionDiffContent, KqlxEditorProvider } from './kqlxEditorProvider';
import type { SectionChangeInfo, ChangedSectionsMessage } from './queryEditorTypes';
import { getWorkbenchLogger } from './workbenchLogger';
import { createFileOpenTrace } from './fileOpenTrace';
import {
	buildCompatSidecarFile,
	getCompatSidecarUri,
	hydrateCompatSidecarState,
	isLinkedCompatSidecar,
	type CompatSidecarFormat,
} from './compatSidecarFormat';
import { CompatSidecarStore } from './compatSidecarStore';
import { CompatSidecarSession } from './compatSidecarSession';

const SQL_COMPAT_SIDECAR_FORMAT: CompatSidecarFormat = {
	primaryKind: 'sql',
	acceptedPrimaryKinds: ['sql'],
	sidecarKind: 'sqlx',
};

type IncomingWebviewMessage =
	| { type: 'requestDocument' }
	| { type: 'persistDocument'; state: KqlxStateV1; reason?: string; editRevision?: number; snapshotId?: string; flushRequestId?: string; testOnlyNoop?: boolean }
	| { type: 'documentReloadResult'; requestId: string; applied: boolean; editRevision: number }
	| { type: 'requestUpgradeToSqlx'; addKind?: string; state?: KqlxStateV1; editRevision?: number }
	| { type: string; [key: string]: unknown };

type PublishFreshState = <T>(state: KqlxStateV1, publish: (sanitizedState: KqlxStateV1) => Promise<T>) => Promise<T>;

/**
 * Compute the sidecar .sql.json URI for a .sql compat file.
 * Returns undefined if the URI does not end with .sql (but not .sqlx).
 */
export function getSidecarJsonUriForSqlCompat(uri: vscode.Uri): vscode.Uri | undefined {
	const uriPath = String(uri.path || '').toLowerCase();
	return uriPath.endsWith('.sqlx') ? undefined : getCompatSidecarUri(uri, ['.sql']);
}

/**
 * Check whether a sidecar file is linked to a specific SQL compat document.
 */
function isLinkedSidecarForSqlFile(sidecarUri: vscode.Uri, sidecarFile: KqlxFileV1, compatDocumentUri: vscode.Uri): boolean {
	return isLinkedCompatSidecar(sidecarUri, sidecarFile, compatDocumentUri, SQL_COMPAT_SIDECAR_FORMAT.acceptedPrimaryKinds);
}

export class SqlCompatEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'kusto.sqlCompatEditor';

	private static readonly allowedSectionKinds: Array<'sql' | 'query' | 'chart' | 'transformation' | 'markdown' | 'python' | 'url' | 'html'> =
		['sql', 'query', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'];

	public static register(
		context: vscode.ExtensionContext,
		extensionUri: vscode.Uri,
		connectionManager: ConnectionManager,
		sqlWorkbench: SqlWorkbenchService,
		editorCursorStatusBar?: EditorCursorStatusBar
	): vscode.Disposable {
		const provider = new SqlCompatEditorProvider(context, extensionUri, connectionManager, sqlWorkbench, editorCursorStatusBar);
		return vscode.window.registerCustomEditorProvider(SqlCompatEditorProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true } as any
		});
	}

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager,
		private readonly sqlWorkbench: SqlWorkbenchService,
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
		const fileOpenTrace = createFileOpenTrace('sqlCompat', { scheme: document.uri.scheme, path: document.uri.path, visible: webviewPanel.visible, active: webviewPanel.active });
		const diffContext = this.detectDiffContext(document);
		fileOpenTrace.mark('diffContext.detected', { isDiff: diffContext.isDiff, hasOriginalUri: !!diffContext.originalUri });
		if (diffContext.isDiff && diffContext.originalUri) {
			await renderDiffInWebview(webviewPanel, this.extensionUri, diffContext.originalUri);
			return;
		}

		const disposables: vscode.Disposable[] = [];

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
		fileOpenTrace.mark('initializeWebviewPanel.start');
		await queryEditor.initializeWebviewPanel(webviewPanel, { registerMessageHandler: false, initialDocumentLoading: true });
		if (outerDisposed) {
			webviewMessageSubscription.dispose();
			outerDisposalSubscription.dispose();
			return;
		}
		fileOpenTrace.mark('initializeWebviewPanel.done');

		// Sidecar support: if there is a sibling .sql.json file that links back to this .sql,
		// use it to store multi-section metadata while keeping the SQL text in the plain file.
		let sidecarUri: vscode.Uri | undefined;
		let sidecarFile: KqlxFileV1 | undefined;
		let lastWrittenSidecarText: string | undefined;
		const sidecarSession = new CompatSidecarSession(webviewPanel.visible === true, 'SQL');
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
		const sidecarStore = new CompatSidecarStore({
			compatUri: document.uri,
			parse: text => {
				const parsed = parseKqlxText(text, { allowedKinds: ['sqlx', 'kqlx'], defaultKind: 'sqlx' });
				return parsed.ok ? parsed.file : undefined;
			},
			isLinked: (uri, file) => isLinkedSidecarForSqlFile(uri, file, document.uri),
			sanitizeFresh: state => queryEditor.sanitizeSqlLeaveNoTraceStateFresh(state),
			publishFresh: (state, publish) => queryEditor.publishSqlLeaveNoTraceStateFresh(state, publish),
			buildFile: state => SqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, state),
			stringify: stringifyKqlxFile,
		});
		const freshSidecarFile = (state: KqlxStateV1) => sidecarStore.buildFresh(state);
		const writeFreshSidecar = (uri: vscode.Uri, state: KqlxStateV1, expectedCurrentText?: string) =>
			sidecarStore.writeFresh(uri, state, expectedCurrentText);
		const repairPersistedSidecar = (uri: vscode.Uri) => sidecarStore.repair(uri);
		const writeDraftRecoveryFile = (uri: vscode.Uri, state: KqlxStateV1) => sidecarStore.writeRecovery(uri, state);
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
			const htmlPowerBiCompatibilityCheckEnabled = vscode.workspace.getConfiguration('kustoWorkbench').get<boolean>('html.powerBiCompatibilityCheck.enabled', true);
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
					firstSectionPinned: sidecarEnabled,
					htmlPowerBiCompatibilityCheckEnabled
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

		const postDocument = async (options?: {
			forceReload?: boolean;
			expectedEditRevision?: number;
			sidecarFileOverride?: KqlxFileV1;
		}): Promise<boolean> => {
			const forceReload = options?.forceReload ?? false;
			fileOpenTrace.mark('postDocument.start', { forceReload, sidecarEnabled: !!sidecarFile });
			const htmlPowerBiCompatibilityCheckEnabled = vscode.workspace.getConfiguration('kustoWorkbench').get<boolean>('html.powerBiCompatibilityCheck.enabled', true);
			const sqlText = document.getText();
			fileOpenTrace.mark('postDocument.documentText.read', { length: sqlText.length });
			const effectiveSidecarFile = options?.sidecarFileOverride ?? sidecarFile;
			const sidecarEnabled = !!effectiveSidecarFile;
			const sidecarName = getSidecarDisplayName();
			let state: KqlxStateV1;
			if (sidecarEnabled && effectiveSidecarFile) {
				state = hydrateCompatSidecarState(effectiveSidecarFile, sqlText, SQL_COMPAT_SIDECAR_FORMAT);
			} else {
				state = {
					sections: [
						{ type: 'sql', query: sqlText }
					]
				};
			}
			state = await queryEditor.sanitizeSqlLeaveNoTraceStateFresh(state);
			const reload = options?.expectedEditRevision !== undefined
				? sidecarSession.createReloadRequest()
				: undefined;
			const reloadRequestId = reload?.requestId;
			const delivered = await webviewPanel.webview.postMessage({
				type: 'documentData',
				ok: true,
				forceReload,
				editRevision: sidecarSession.currentEditRevision,
				...(options?.expectedEditRevision !== undefined ? { expectedEditRevision: options.expectedEditRevision } : {}),
				...(reloadRequestId ? { reloadRequestId } : {}),
				documentUri: document.uri.toString(),
				suppressPersistenceForTest: this.context.extensionMode !== vscode.ExtensionMode.Production
					&& process.env.KUSTO_WORKBENCH_E2E_SUPPRESS_PERSISTENCE === '1',
				compatibilityMode: !sidecarEnabled,
				documentKind: 'sql',
				compatibilitySingleKind: 'sql',
				allowedSectionKinds: SqlCompatEditorProvider.allowedSectionKinds,
				defaultSectionKind: 'sql',
				upgradeRequestType: 'requestUpgradeToSqlx',
				compatibilityTooltip: !sidecarEnabled
					? `This is a .sql file. To add sections, Kusto Workbench will create a companion metadata file (${sidecarName}) next to it.`
					: '',
				htmlPowerBiCompatibilityCheckEnabled,
				state
			});
			fileOpenTrace.mark('postDocument.documentData.posted', { sections: state.sections.length, sidecarEnabled, forceReload });
			if (!delivered && reloadRequestId) {
				sidecarSession.failReload(reloadRequestId);
			}
			return reload ? await reload.result : delivered;
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
		subscriptions.push(queryEditor.onDidInvalidateSqlPersistence(() => {
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
				if (!sidecarSession.isDirty && draftUnchanged
					&& sidecarSession.currentStateEditRevision === repairEditRevision
					&& sidecarSession.currentEditRevision === repairEditRevision) {
					sidecarFile = repaired.file;
					lastWrittenSidecarText = repaired.text;
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
				} else if (sidecarSession.isDirty) {
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
					void postDocument({ forceReload: true }).catch(() => undefined);
				} catch {
					// ignore
				}
			})
		);

		// When the user explicitly saves the .sql file, also save the companion .json metadata.
		subscriptions.push(
			vscode.workspace.onWillSaveTextDocument((event) => {
				if (event.document.uri.toString() !== document.uri.toString()) return;
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
						savedSqlText = saved.getText();
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
						const { file: persisted, text } = await writeFreshSidecar(sidecarUri, lastKnownSidecarState, sidecarSession.baseText ?? lastWrittenSidecarText);
						sidecarFile = persisted;
						lastWrittenSidecarText = text;
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
							const { file: persisted, text } = await writeFreshSidecar(sidecarUriToSave, stateToSave, sidecarSession.baseText ?? lastWrittenSidecarText);
							sidecarFile = persisted;
							lastWrittenSidecarText = text;
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
						}
					}
					await sidecarStore.drain();
				} catch {
					// The sidecar may already be unavailable.
				} finally {
					sidecarSession.settleClose();
					for (const s of [...disposables, ...subscriptions]) {
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
					fileOpenTrace.mark('requestDocument.received');
					postPersistenceMode();
					await postDocument({ forceReload: true });
					webviewInitialized = true;
					fileOpenTrace.mark('requestDocument.completed');
					return;
				case 'requestUpgradeToSqlx': {
					const upgradeRevision = Number((message as any).editRevision);
					const upgrade = await sidecarSession.beginUpgrade(upgradeRevision);
					if (!upgrade) return;
					try {
					const addKind = (message && typeof message.addKind === 'string') ? message.addKind : '';
					const normalizedAddKind = SqlCompatEditorProvider.allowedSectionKinds.includes(addKind as any) ? String(addKind) : '';

					// If the webview provided a fresh state snapshot, prefer it for seeding.
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
					const enabled = await this.enableSidecarForSqlCompat(
						document,
						lastKnownSidecarState,
						(state, publish) => queryEditor.publishSqlLeaveNoTraceStateFresh(state, publish),
					);
					if (!enabled) {
						return;
					}
					sidecarUri = enabled.uri;
					sidecarFile = enabled.file;
					lastWrittenSidecarText = enabled.text;
					lastKnownSidecarState = enabled.file.state;
					sidecarSession.markClean(upgradeRevision);
					rebuildSavedCache();
					postPersistenceMode();
					await postDocument({ forceReload: true, expectedEditRevision: upgradeRevision });
					try {
						void webviewPanel.webview.postMessage({ type: 'enabledSqlSidecar', addKind: normalizedAddKind });
					} catch {
						// ignore
					}
					return;
					} finally {
						upgrade.finish();
					}
				}
				case 'persistDocument': {
					const snapshotId = String((message as any).snapshotId || '').trim();
					const flushRequestId = String((message as any).flushRequestId || '').trim();
					const testOnlyNoop = (message as any).testOnlyNoop === true
						&& this.context.extensionMode !== vscode.ExtensionMode.Production;
					if (testOnlyNoop) {
						const revision = Number((message as any)?.editRevision);
						const hasRevision = Number.isSafeInteger(revision) && revision >= 0;
						if (hasRevision && sidecarSession.isStaleRevision(revision)) {
							if (flushRequestId) sidecarSession.completeFinalPersist(flushRequestId, new Error('The final SQL metadata snapshot was stale.'));
							return;
						}
						if (hasRevision) sidecarSession.adoptRevision(revision, 'replace');
						if (snapshotId && !outerDisposed) {
							try { void webviewPanel.webview.postMessage({ type: 'persistDocumentAck', snapshotId, editRevision: sidecarSession.currentEditRevision }); }
							catch { /* ignore */ }
						}
						if (flushRequestId) sidecarSession.completeFinalPersist(flushRequestId);
						sidecarSession.markBeforeUnload((message as any).reason);
						return;
					}
					if (sidecarSession.isClosing) {
						if (flushRequestId) sidecarSession.completeFinalPersist(flushRequestId, new Error('The SQL metadata editor closed before its final snapshot was admitted.'));
						return;
					}
					const revision = Number((message as any)?.editRevision);
					const hasRevision = Number.isSafeInteger(revision) && revision >= 0;
					if (hasRevision && sidecarSession.isStaleRevision(revision)) {
						if (flushRequestId) sidecarSession.completeFinalPersist(flushRequestId, new Error('The final SQL metadata snapshot was stale.'));
						sidecarSession.markBeforeUnload((message as any).reason);
						return;
					}
					if (hasRevision) sidecarSession.adoptRevision(revision);
					const incomingEditRevision = hasRevision ? revision : sidecarSession.currentEditRevision;
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
					const superseded = () => ({ ok: false as const, error: new Error('The SQL metadata snapshot was superseded before admission.') });
					const run = sidecarSession.queuePersist(incomingEditRevision, async persistIsCurrent => {
						if (!persistIsCurrent()) return superseded();
						lastWebviewPersistAt = Date.now();

						// Persist the first SQL section's text back into the plain-text document.
						const firstSql = incomingRawState.sections.find((s) => (s && String((s as any).type || '') === 'sql'));
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
							if (!await vscode.workspace.applyEdit(edit)) {
								return { ok: false as const, error: new Error('VS Code rejected the final SQL text update.') };
							}
							if (!persistIsCurrent()) return superseded();
						}

						let incomingState: KqlxStateV1;
						try {
							incomingState = await queryEditor.sanitizeSqlLeaveNoTraceStateFresh<KqlxStateV1>(incomingRawState);
						} catch (error) {
							if (persistIsCurrent() && sidecarUri && sidecarFile) {
								lastKnownSidecarState = incomingRawState;
								sidecarSession.markDirty(lastWrittenSidecarText);
								computeAndPostChanges(incomingRawState);
							}
							void vscode.window.showErrorMessage(`Failed to prepare companion metadata: ${error instanceof Error ? error.message : String(error)}`);
							return { ok: false as const, error: new Error(`Failed to prepare SQL companion metadata: ${error instanceof Error ? error.message : String(error)}`) };
						}
						if (!persistIsCurrent()) return superseded();

						let persistedSidecar: KqlxFileV1 | undefined;
						if (sidecarUri && sidecarFile) {
							try {
								persistedSidecar = await freshSidecarFile(incomingState);
							} catch (error) {
								if (persistIsCurrent()) {
									lastKnownSidecarState = incomingState;
									sidecarSession.markDirty(lastWrittenSidecarText);
									computeAndPostChanges(incomingState);
								}
								void vscode.window.showErrorMessage(`Failed to prepare companion metadata: ${error instanceof Error ? error.message : String(error)}`);
								return { ok: false as const, error: new Error(`Failed to materialize SQL companion metadata: ${error instanceof Error ? error.message : String(error)}`) };
							}
							if (!persistIsCurrent()) return superseded();
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
							try { void webviewPanel.webview.postMessage({ type: 'persistDocumentAck', snapshotId, editRevision: incomingEditRevision }); }
							catch { /* ignore */ }
						}
						if (flushRequestId) sidecarSession.completeFinalPersist(flushRequestId);
					} catch (error) {
						if (flushRequestId) {
							sidecarSession.completeFinalPersist(flushRequestId, new Error(`Failed to admit the final SQL metadata snapshot: ${error instanceof Error ? error.message : String(error)}`));
						}
					}
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
		return buildCompatSidecarFile(compatUri, state, SQL_COMPAT_SIDECAR_FORMAT);
	}

	private async enableSidecarForSqlCompat(
		document: vscode.TextDocument,
		lastKnownWebviewState?: KqlxStateV1,
		publishStateFresh?: PublishFreshState,
	): Promise<{ uri: vscode.Uri; file: KqlxFileV1; text: string } | undefined> {
		if (document.uri.scheme !== 'file') {
			void vscode.window.showWarningMessage('This feature requires a local .sql file on disk.');
			return undefined;
		}
		const sidecarUri = getSidecarJsonUriForSqlCompat(document.uri);
		if (!sidecarUri) {
			return undefined;
		}
		const targetSidecarUri = sidecarUri;
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

		let creationBaselineText: string | undefined;
		const lockTarget = `${sidecarUri.fsPath}.write`;
		const adoptLinkedSidecar = async (): Promise<{ uri: vscode.Uri; file: KqlxFileV1; text: string }> => {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const currentText = new TextDecoder().decode(await vscode.workspace.fs.readFile(sidecarUri));
				const parsed = parseKqlxText(currentText, { allowedKinds: ['sqlx', 'kqlx'], defaultKind: 'sqlx' });
				if (!parsed.ok || !isLinkedSidecarForSqlFile(sidecarUri, parsed.file, document.uri)) {
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
						const file = SqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, state);
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
			const parsed = parseKqlxText(text, { allowedKinds: ['sqlx', 'kqlx'], defaultKind: 'sqlx' });
			if (parsed.ok && isLinkedSidecarForSqlFile(sidecarUri, parsed.file, document.uri)) {
				return await adoptLinkedSidecar();
			}
			const overwrite = await vscode.window.showWarningMessage(
				`A sidecar file (${sidecarName}) already exists next to this .sql file, but it does not appear to be linked as a companion metadata file. Overwrite it to enable sidecar metadata?`,
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
					{ type: 'sql' } as any
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
					const createdFile = SqlCompatEditorProvider.buildSidecarFileForCompat(document.uri, state);
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
