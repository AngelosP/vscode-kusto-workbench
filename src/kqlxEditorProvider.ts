import * as vscode from 'vscode';

import * as path from 'path';

import { ConnectionManager } from './connectionManager';
import { QueryEditorProvider } from './queryEditorProvider';
import { createEmptyKqlxFile, parseKqlxText, stringifyKqlxFile, type KqlxFileKind, type KqlxFileV1, type KqlxStateV1 } from './kqlxFormat';
import { renderDiffInWebview } from './diffViewerUtils';

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
			resultsVisible: boolean;
			clusterUrl: string;
			database: string;
			linkedQueryPath: string;
			query: string;
			resultJson: string;
			runMode: string;
			cacheEnabled: boolean;
			cacheValue: number;
			cacheUnit: string;
			editorHeightPx?: number;
			resultsHeightPx?: number;
			copilotChatVisible: boolean;
			copilotChatWidthPx?: number;
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
		}
	| {
			type: 'chart';
			name: string;
			mode: 'edit' | 'preview';
			expanded: boolean;
			dataSourceId: string;
			chartType: string;
			xColumn: string;
			yColumn: string;
			yColumns: string[];
			legendColumn: string;
			legendPosition: string;
			labelColumn: string;
			valueColumn: string;
			tooltipColumns: string[];
			showDataLabels: boolean;
			editorHeightPx?: number;
		}
	| {
			type: 'transformation';
			name: string;
			mode: 'edit' | 'preview';
			expanded: boolean;
			dataSourceId: string;
			transformationType: string;
			distinctColumn: string;
			groupByColumns: string[];
			aggregations: Array<{ name: string; column: string; function: string }>;
			deriveColumns: Array<{ name: string; expression: string }>;
			pivotRowKeyColumn: string;
			pivotColumnKeyColumn: string;
			pivotValueColumn: string;
			pivotAggregation: string;
			pivotMaxColumns: number;
			editorHeightPx?: number;
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
		if (t === 'query' || t === 'copilotQuery') {
			sections.push({
				type: 'query',
				name: String((section as any).name ?? ''),
				expanded: (typeof (section as any).expanded === 'boolean') ? (section as any).expanded : true,
				resultsVisible: (typeof (section as any).resultsVisible === 'boolean') ? (section as any).resultsVisible : true,
				clusterUrl: String((section as any).clusterUrl ?? ''),
				database: String((section as any).database ?? ''),
				linkedQueryPath: String((section as any).linkedQueryPath ?? ''),
				query: String((section as any).query ?? ''),
				resultJson: String((section as any).resultJson ?? ''),
				runMode: String((section as any).runMode ?? 'take100'),
				cacheEnabled: (typeof (section as any).cacheEnabled === 'boolean') ? (section as any).cacheEnabled : true,
				cacheValue: Number.isFinite((section as any).cacheValue) ? Math.max(1, Math.trunc((section as any).cacheValue)) : 1,
				cacheUnit: String((section as any).cacheUnit ?? 'days'),
				editorHeightPx: normalizeHeight((section as any).editorHeightPx),
				resultsHeightPx: normalizeHeight((section as any).resultsHeightPx),
				copilotChatVisible: (typeof (section as any).copilotChatVisible === 'boolean') ? (section as any).copilotChatVisible : (t === 'copilotQuery'),
				copilotChatWidthPx: normalizeHeight((section as any).copilotChatWidthPx)
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
		if (t === 'chart') {
			const rawMode = String((section as any).mode ?? 'edit').toLowerCase();
			const mode: 'edit' | 'preview' = (rawMode === 'preview') ? 'preview' : 'edit';
			sections.push({
				type: 'chart',
				name: String((section as any).name ?? ''),
				mode,
				expanded: (typeof (section as any).expanded === 'boolean') ? (section as any).expanded : true,
				dataSourceId: String((section as any).dataSourceId ?? ''),
				chartType: String((section as any).chartType ?? ''),
				xColumn: String((section as any).xColumn ?? ''),
				yColumn: String((section as any).yColumn ?? ''),
				yColumns: Array.isArray((section as any).yColumns) ? (section as any).yColumns.map((c: any) => String(c ?? '')).filter(Boolean) : [],
				legendColumn: String((section as any).legendColumn ?? ''),
				legendPosition: String((section as any).legendPosition ?? ''),
				labelColumn: String((section as any).labelColumn ?? ''),
				valueColumn: String((section as any).valueColumn ?? ''),
				tooltipColumns: Array.isArray((section as any).tooltipColumns) ? (section as any).tooltipColumns.map((c: any) => String(c ?? '')).filter(Boolean) : [],
				showDataLabels: (typeof (section as any).showDataLabels === 'boolean') ? (section as any).showDataLabels : false,
				editorHeightPx: normalizeHeight((section as any).editorHeightPx)
			});
			continue;
		}
		if (t === 'transformation') {
			const rawMode = String((section as any).mode ?? 'edit').toLowerCase();
			const mode: 'edit' | 'preview' = (rawMode === 'preview') ? 'preview' : 'edit';
			sections.push({
				type: 'transformation',
				name: String((section as any).name ?? ''),
				mode,
				expanded: (typeof (section as any).expanded === 'boolean') ? (section as any).expanded : true,
				dataSourceId: String((section as any).dataSourceId ?? ''),
				transformationType: String((section as any).transformationType ?? ''),
				distinctColumn: String((section as any).distinctColumn ?? ''),
				groupByColumns: Array.isArray((section as any).groupByColumns) ? (section as any).groupByColumns.map((c: any) => String(c ?? '')).filter(Boolean) : [],
				aggregations: Array.isArray((section as any).aggregations)
					? (section as any).aggregations
						.filter((a: any) => a && typeof a === 'object')
						.map((a: any) => ({
							name: String(a.name ?? ''),
							column: String(a.column ?? ''),
							function: String(a.function ?? '')
						}))
					: [],
				deriveColumns: Array.isArray((section as any).deriveColumns)
					? (section as any).deriveColumns
						.filter((d: any) => d && typeof d === 'object')
						.map((d: any) => ({
							name: String(d.name ?? ''),
							expression: String(d.expression ?? '')
						}))
					: [],
				pivotRowKeyColumn: String((section as any).pivotRowKeyColumn ?? ''),
				pivotColumnKeyColumn: String((section as any).pivotColumnKeyColumn ?? ''),
				pivotValueColumn: String((section as any).pivotValueColumn ?? ''),
				pivotAggregation: String((section as any).pivotAggregation ?? ''),
				pivotMaxColumns: Number.isFinite((section as any).pivotMaxColumns) ? Math.max(1, Math.trunc((section as any).pivotMaxColumns)) : 0,
				editorHeightPx: normalizeHeight((section as any).editorHeightPx)
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

	private static getDocumentKind(document: vscode.TextDocument): KqlxFileKind {
		try {
			const p = String(document.uri?.path || '').toLowerCase();
			if (p.endsWith('.mdx')) {
				return 'mdx';
			}
		} catch {
			// ignore
		}
		return 'kqlx';
	}

	private static getAllowedSectionKinds(
		kind: KqlxFileKind
	): Array<'query' | 'chart' | 'transformation' | 'markdown' | 'python' | 'url'> {
		// .mdx is intended to be "notebook-like markdown"; we still allow URL and Transformations
		// so users can fetch CSV and reshape it.
		return kind === 'mdx'
			? ['markdown', 'url', 'transformation']
			: ['query', 'chart', 'transformation', 'markdown', 'python', 'url'];
	}

	private static sanitizeStateForKind(kind: KqlxFileKind, state: KqlxStateV1): KqlxStateV1 {
		if (kind !== 'mdx') {
			return state;
		}
		const sections = Array.isArray(state.sections) ? state.sections : [];
		const filtered = sections.filter((s) => {
			const t = (s as any)?.type;
			return t === 'markdown' || t === 'url' || t === 'transformation';
		});
		return {
			caretDocsEnabled: state.caretDocsEnabled,
			sections: filtered
		};
	}

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

		const queryEditor = new QueryEditorProvider(this.extensionUri, this.connectionManager, this.context);
		await queryEditor.initializeWebviewPanel(webviewPanel, { registerMessageHandler: false });

		const documentKind = KqlxEditorProvider.getDocumentKind(document);
		const allowedSectionKinds = KqlxEditorProvider.getAllowedSectionKinds(documentKind);
		const defaultSectionKind: 'query' | 'markdown' = documentKind === 'mdx' ? 'markdown' : 'query';

		// If we were just upgraded from a single-section format to a rich format as part of an add-section action,
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

		// Inform the webview whether it's operating in session mode, and which section kinds are allowed.
		const postPersistenceMode = () => {
			try {
				void webviewPanel.webview.postMessage({
					type: 'persistenceMode',
					isSessionFile,
					documentUri: document.uri.toString(),
					compatibilityMode: false,
					documentKind,
					allowedSectionKinds,
					defaultSectionKind
				});
			} catch {
				// ignore
			}
		};
		postPersistenceMode();

		let pendingAddKindDelivered = false;
		let saveTimer: NodeJS.Timeout | undefined;
		let lastSavedText = document.getText();
		let lastSavedEol = document.eol;
		let linkedQueryUri: vscode.Uri | undefined;
		let linkedQueryPathRaw = '';
		let linkedQueryDocument: vscode.TextDocument | undefined;
		let lastSavedLinkedQueryText = '';
		// Track the last text we wrote directly to disk for session files.
		// This helps avoid redundant writes and keeps lastSavedText in sync.
		let lastDirectDiskWrite = isSessionFile ? lastSavedText : '';

		const getLinkedQueryUriFromState = (state: KqlxStateV1): vscode.Uri | undefined => {
			try {
				const sections = Array.isArray(state.sections) ? state.sections : [];
				if (sections.length === 0) {
					return undefined;
				}
				const first = sections[0] as any;
				const t = String(first?.type ?? '');
				if (t !== 'query' && t !== 'copilotQuery') {
					return undefined;
				}
				const linked = String(first?.linkedQueryPath ?? '').trim();
				if (!linked) {
					return undefined;
				}
				linkedQueryPathRaw = linked;
				// Relative to the .kqlx file location by default.
				if (/^file:\/\//i.test(linked)) {
					return vscode.Uri.parse(linked);
				}
				if (/^[a-zA-Z]:\\/.test(linked) || linked.startsWith('\\\\')) {
					return vscode.Uri.file(linked);
				}
				return document.uri.with({ path: path.posix.normalize(path.posix.join(path.posix.dirname(document.uri.path), linked)) });
			} catch {
				return undefined;
			}
		};

		const tryReadTextFile = async (uri: vscode.Uri): Promise<string | undefined> => {
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				return new TextDecoder().decode(bytes);
			} catch {
				return undefined;
			}
		};

		const getOrOpenLinkedQueryDocument = async (): Promise<vscode.TextDocument | undefined> => {
			try {
				if (!linkedQueryUri) {
					return undefined;
				}
				if (linkedQueryUri.scheme !== 'file') {
					return undefined;
				}
				if (linkedQueryDocument && linkedQueryDocument.uri.toString() === linkedQueryUri.toString()) {
					return linkedQueryDocument;
				}
				const existing = vscode.workspace.textDocuments.find((d) => d.uri.toString() === linkedQueryUri!.toString());
				if (existing) {
					linkedQueryDocument = existing;
					return existing;
				}
				linkedQueryDocument = await vscode.workspace.openTextDocument(linkedQueryUri);
				return linkedQueryDocument;
			} catch {
				return undefined;
			}
		};

		const applyLinkedQueryTextToDocument = async (text: string): Promise<boolean> => {
			try {
				const linkedDoc = await getOrOpenLinkedQueryDocument();
				if (!linkedDoc) {
					return false;
				}
				const current = linkedDoc.getText();
				if (current === text) {
					return true;
				}
				const fullRange = new vscode.Range(
					linkedDoc.positionAt(0),
					linkedDoc.positionAt(current.length)
				);
				const edit = new vscode.WorkspaceEdit();
				edit.replace(linkedDoc.uri, fullRange, text);
				await vscode.workspace.applyEdit(edit);
				return true;
			} catch {
				return false;
			}
		};

		const injectLinkedQueryText = async (state: KqlxStateV1): Promise<KqlxStateV1> => {
			const link = getLinkedQueryUriFromState(state);
			linkedQueryUri = link;
			if (!link) {
				return state;
			}
			const text = await tryReadTextFile(link);
			if (typeof text !== 'string') {
				try {
					void vscode.window.showWarningMessage('This notebook links to a query file that could not be read. The query editor will start empty until the file is available.');
				} catch {
					// ignore
				}
				return state;
			}
			// Record last-saved linked query so dirty-state comparison can be stable.
			lastSavedLinkedQueryText = text;
			try {
				// Keep an in-memory TextDocument so we can mark it dirty and save it alongside the .kqlx.
				await getOrOpenLinkedQueryDocument();
			} catch {
				// ignore
			}
			try {
				const sections = Array.isArray(state.sections) ? state.sections : [];
				if (sections.length === 0) {
					return state;
				}
				const first = { ...(sections[0] as any), query: text };
				return { caretDocsEnabled: state.caretDocsEnabled, sections: [first, ...sections.slice(1)] as any };
			} catch {
				return state;
			}
		};

		// For session files, write directly to disk without going through the document edit cycle.
		// This avoids the dirty indicator flickering that happens with applyEdit→save.
		const saveSessionFileToDisk = async (text: string): Promise<boolean> => {
			if (!isSessionFile) {
				return false;
			}
			try {
				// Skip if the text is identical to what we last wrote.
				if (text === lastDirectDiskWrite) {
					return true;
				}
				const bytes = new TextEncoder().encode(text);
				await vscode.workspace.fs.writeFile(document.uri, bytes);
				lastDirectDiskWrite = text;
				lastSavedText = text;
				lastSavedEol = document.eol;
				return true;
			} catch {
				return false;
			}
		};

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
					const t = (sec as any)?.type;
					if (!sec || (t !== 'query' && t !== 'copilotQuery')) {
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

		const postDocument = async (options?: { forceReload?: boolean }) => {
			const forceReload = options?.forceReload ?? false;
			const parsed = parseKqlxText(document.getText(), {
				allowedKinds: documentKind === 'mdx' ? ['mdx', 'kqlx'] : ['kqlx', 'mdx'],
				defaultKind: documentKind
			});
			if (!parsed.ok) {
				void webviewPanel.webview.postMessage({
					type: 'documentData',
					ok: false,
					forceReload,
					documentUri: document.uri.toString(),
					error: parsed.error,
					state: createEmptyKqlxFile().state
				});
				return;
			}

			const sanitizedState = KqlxEditorProvider.sanitizeStateForKind(documentKind, parsed.file.state);
			const hydratedState = await injectLinkedQueryText(sanitizedState);

			let connectionsChanged = false;
			try {
				connectionsChanged = await ensureConnectionsForState(hydratedState);
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
				forceReload,
				documentUri: document.uri.toString(),
				state: hydratedState
			});
		};

		const subscriptions: vscode.Disposable[] = [];
		subscriptions.push(
			vscode.workspace.onDidSaveTextDocument((saved) => {
				try {
					if (saved.uri.toString() !== document.uri.toString()) {
						if (linkedQueryUri && saved.uri.toString() === linkedQueryUri.toString()) {
							lastSavedLinkedQueryText = saved.getText();
						}
						return;
					}
					lastSavedText = saved.getText();
					lastSavedEol = saved.eol;
					// Best-effort: when the notebook metadata file is saved, also save the linked query file.
					try {
						if (linkedQueryDocument && linkedQueryDocument.isDirty) {
							void linkedQueryDocument.save();
						}
					} catch {
						// ignore
					}
				} catch {
					// ignore
				}
			})
		);

		// Track if the webview has initialized and whether it's currently being edited by the user.
		// This helps us avoid refreshing the webview for changes that originated from the webview itself.
		let webviewInitialized = false;
		let lastWebviewPersistAt = 0;

		// Listen for external file changes (e.g., from Copilot, git, or other processes).
		// When the document changes externally, refresh the webview to show the new content.
		subscriptions.push(
			vscode.workspace.onDidChangeTextDocument((e) => {
				try {
					if (e.document.uri.toString() !== document.uri.toString()) {
						return;
					}
					// Skip if no actual content changes (metadata-only changes).
					if (e.contentChanges.length === 0) {
						return;
					}
					// Skip if webview hasn't initialized yet (will get content on requestDocument).
					if (!webviewInitialized) {
						return;
					}
					// Skip if the change likely originated from the webview (within 500ms of a persist).
					// This avoids unnecessary round-trips when the user is editing in the webview.
					const now = Date.now();
					if (now - lastWebviewPersistAt < 500) {
						return;
					}
					// Notify the webview that the document changed externally.
					// Use forceReload to ensure the webview updates even if already initialized.
					void postDocument({ forceReload: true });
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
			// For session files, we use direct disk writes (saveSessionFileToDisk) which bypass
			// the in-memory document. The in-memory document may be stale, so we should NOT
			// save it here as that would overwrite the correct content on disk.
			// For non-session files, ensure any pending saves complete.
			if (!isSessionFile) {
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
					// Re-send mode/capabilities in response to a request (the webview is guaranteed to be listening).
					postPersistenceMode();
					// Only load from disk when explicitly requested by the webview.
					await postDocument();
					webviewInitialized = true;

					// If we were upgraded and a specific "add" action triggered the upgrade,
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
					// Track that the webview is persisting, so we don't treat the resulting
					// onDidChangeTextDocument event as an external change.
					lastWebviewPersistAt = Date.now();

					const persistReason = (() => {
						try {
							const r = (message as any)?.reason;
							return typeof r === 'string' ? r : '';
						} catch {
							return '';
						}
					})();
					const rawState = (message as any).state;
					const incomingState: KqlxStateV1 = {
						caretDocsEnabled:
							rawState && typeof rawState.caretDocsEnabled === 'boolean' ? rawState.caretDocsEnabled : undefined,
						sections: rawState && Array.isArray(rawState.sections) ? rawState.sections : []
					};
					const state = KqlxEditorProvider.sanitizeStateForKind(documentKind, incomingState);

					// If this notebook links its first query to an external file, keep the link stable
					// and persist query edits into that linked file (so Save can save both).
					try {
						if (linkedQueryUri && Array.isArray(state.sections) && state.sections.length > 0) {
							const first = state.sections[0] as any;
							const t = String(first?.type ?? '');
							if (t === 'query' || t === 'copilotQuery') {
								if (linkedQueryPathRaw) {
									first.linkedQueryPath = linkedQueryPathRaw;
								}
								const q = typeof first.query === 'string' ? String(first.query) : '';
								await applyLinkedQueryTextToDocument(q);
							}
						}
					} catch {
						// ignore
					}

					const incomingComparable = toComparableState(state);
					const currentText = document.getText();

					let incomingMatchesDisk = false;
					let diskTextForMatch = '';

					// If the incoming state matches what was last saved (even if the in-memory document has
					// different formatting), restore that exact saved text. This allows VS Code to clear the
					// dirty indicator when a user "returns" to the saved state.
					let nextText = '';
					try {
						const parsedSaved = parseKqlxText(lastSavedText, {
							allowedKinds: documentKind === 'mdx' ? ['mdx', 'kqlx'] : ['kqlx', 'mdx'],
							defaultKind: documentKind
						});
						if (parsedSaved.ok) {
							const savedState = (() => {
								try {
									if (!linkedQueryUri) return parsedSaved.file.state;
									const secs = Array.isArray(parsedSaved.file.state.sections) ? parsedSaved.file.state.sections : [];
									if (secs.length === 0) return parsedSaved.file.state;
									const first = secs[0] as any;
									if (!first || !String(first.linkedQueryPath || '')) return parsedSaved.file.state;
									const injected = { ...first, query: lastSavedLinkedQueryText };
									return { caretDocsEnabled: parsedSaved.file.state.caretDocsEnabled, sections: [injected, ...secs.slice(1)] as any };
								} catch {
									return parsedSaved.file.state;
								}
							})();
							const savedComparable = toComparableState(savedState);
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
							const parsedDisk = parseKqlxText(diskText, {
								allowedKinds: documentKind === 'mdx' ? ['mdx', 'kqlx'] : ['kqlx', 'mdx'],
								defaultKind: documentKind
							});
							if (parsedDisk.ok) {
								const diskState = (() => {
									try {
										if (!linkedQueryUri) return parsedDisk.file.state;
										const secs = Array.isArray(parsedDisk.file.state.sections) ? parsedDisk.file.state.sections : [];
										if (secs.length === 0) return parsedDisk.file.state;
										const first = secs[0] as any;
										if (!first || !String(first.linkedQueryPath || '')) return parsedDisk.file.state;
										let linkedText = '';
										try {
											linkedText = linkedQueryDocument ? linkedQueryDocument.getText() : lastSavedLinkedQueryText;
										} catch {
											linkedText = lastSavedLinkedQueryText;
										}
										const injected = { ...first, query: linkedText };
										return { caretDocsEnabled: parsedDisk.file.state.caretDocsEnabled, sections: [injected, ...secs.slice(1)] as any };
									} catch {
										return parsedDisk.file.state;
									}
								})();
								const diskComparable = toComparableState(diskState);
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
								const parsedDisk = parseKqlxText(diskText, {
									allowedKinds: documentKind === 'mdx' ? ['mdx', 'kqlx'] : ['kqlx', 'mdx'],
									defaultKind: documentKind
								});
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
							const parsedCurrent = parseKqlxText(currentText, {
								allowedKinds: documentKind === 'mdx' ? ['mdx', 'kqlx'] : ['kqlx', 'mdx'],
								defaultKind: documentKind
							});
							if (parsedCurrent.ok) {
								const currentState = (() => {
									try {
										if (!linkedQueryUri) return parsedCurrent.file.state;
										const secs = Array.isArray(parsedCurrent.file.state.sections) ? parsedCurrent.file.state.sections : [];
										if (secs.length === 0) return parsedCurrent.file.state;
										const first = secs[0] as any;
										if (!first || !String(first.linkedQueryPath || '')) return parsedCurrent.file.state;
										let linkedText = '';
										try {
											linkedText = linkedQueryDocument ? linkedQueryDocument.getText() : lastSavedLinkedQueryText;
										} catch {
											linkedText = lastSavedLinkedQueryText;
										}
										const injected = { ...first, query: linkedText };
										return { caretDocsEnabled: parsedCurrent.file.state.caretDocsEnabled, sections: [injected, ...secs.slice(1)] as any };
									} catch {
										return parsedCurrent.file.state;
									}
								})();
								const currentComparable = toComparableState(currentState);
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
									// For session files, ensure the current content is written to disk.
									// This handles cases where the in-memory state matches what we want,
									// but the disk content might be stale (e.g., results just added).
									if (isSessionFile) {
										await saveSessionFileToDisk(currentText);
									}
									return;
								}
							}
						} catch {
							// ignore
						}
					}

					if (!nextText) {
						const stateForSave: KqlxStateV1 = (() => {
							try {
								if (!linkedQueryUri) {
									return state;
								}
								const sections = Array.isArray(state.sections) ? state.sections.map((s) => ({ ...(s as any) })) : [];
								if (sections.length === 0) {
									return state;
								}
								const first = sections[0] as any;
								const t = String(first?.type ?? '');
								if (t === 'query' || t === 'copilotQuery') {
									if (linkedQueryPathRaw) {
										first.linkedQueryPath = linkedQueryPathRaw;
									}
									delete first.query;
								}
								return { caretDocsEnabled: state.caretDocsEnabled, sections: sections as any };
							} catch {
								return state;
							}
						})();
						const file: KqlxFileV1 = {
							kind: documentKind,
							version: 1,
							state: stateForSave
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
							// For session files, ensure the current content is written to disk.
							if (isSessionFile) {
								await saveSessionFileToDisk(currentText);
							}
							return;
						}
					} catch {
						// ignore
					}

					// For session files, write directly to disk without going through the document
					// edit cycle. This avoids the dirty indicator flickering that happens with
					// applyEdit→save and ensures results are always persisted.
					if (isSessionFile) {
						await saveSessionFileToDisk(nextText);
						return;
					}

					// For non-session files, use the standard edit→save cycle.
					const fullRange = new vscode.Range(
						document.positionAt(0),
						document.positionAt(currentText.length)
					);

					const edit = new vscode.WorkspaceEdit();
					edit.replace(document.uri, fullRange, nextText);
					await vscode.workspace.applyEdit(edit);

					// If we just restored the file back to the exact on-disk content due to a reorder undo,
					// force a save to ensure VS Code clears the dirty flag.
					if (persistReason === 'reorder' && incomingMatchesDisk) {
						try {
							if (diskTextForMatch && diskTextForMatch === nextText && document.isDirty) {
								await document.save();
							}
						} catch {
							// ignore
						}
					}

					// For user-picked files, saving stays user-controlled (or governed by VS Code autosave settings).
					scheduleSave();
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
