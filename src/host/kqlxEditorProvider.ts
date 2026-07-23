import * as vscode from 'vscode';

import * as path from 'path';

import { ConnectionManager } from './connectionManager';
import { QueryEditorProvider } from './queryEditorProvider';
import type { SqlWorkbenchService } from './sql/sqlWorkbenchService';
import { EditorCursorStatusBar } from './editorCursorStatusBar';
import { parseKqlxText, stringifyKqlxFile, type KqlxFileKind, type KqlxStateV1 } from './kqlxFormat';
import { renderDiffInWebview, DIFF_NOISE_KEYS, COMPARISON_NOISE_KEYS } from './diffViewerUtils';
import type { SectionChangeInfo } from './queryEditorTypes';
import { perfBegin, perfMark } from './perfTrace';
import { kustoClusterKey } from '../shared/kustoClusterUrls';
import { getKustoConnectionIdentityKey, normalizeKustoAuthorityId } from '../shared/kustoAuth';
import { getWorkbenchLogger } from './workbenchLogger';
import { createFileOpenTrace } from './fileOpenTrace';
import { normalizeWorkbenchUriKey } from './workbenchFileTypes';
import { CompatSidecarSession } from './compatSidecarSession';


const normalizeClusterUrlKey = (url: string): string => {
	return kustoClusterKey(url);
};

const SQL_SAVE_CANONICAL_WAIT_MS = 500;
const NON_PERSISTENCE_CLOSE_WAIT_MS = 2_000;
const PERSISTENCE_CLOSE_WAIT_MS = 20_000;

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function hasSqlOwnedDocumentState(state: Pick<KqlxStateV1, 'sections'>): boolean {
	const sections = state.sections ?? [];
	const sectionTypesById = new Map(sections.map(section => [String(section.id || '').trim(), String(section.type || '')]));
	return sections.some(section => {
		if (String(section.type || '') === 'sql') return true;
		if (String(section.type || '') === 'query'
			&& String((section as { connectionIdHint?: string }).connectionIdHint || '').trim().startsWith('sql_')) return true;
		const sourceBoxId = String((section as { comparisonSourceBoxId?: string }).comparisonSourceBoxId || '').trim();
		return !!sourceBoxId && sectionTypesById.get(sourceBoxId) === 'sql';
	});
}

export function shouldReloadKqlxAfterDocumentChange(options: {
	isSessionFile: boolean;
	matchesOwnedSessionWrite: boolean;
	webviewInitialized: boolean;
	contentChangeCount: number;
	lastWebviewPersistAt: number;
	now: number;
}): boolean {
	if (!options.webviewInitialized || options.contentChangeCount === 0) return false;
	if (options.isSessionFile) return !options.matchesOwnedSessionWrite;
	return options.now - options.lastWebviewPersistAt >= 500;
}

export class OwnedSessionWriteTracker {
	private readonly pendingTexts = new Set<string>();

	constructor(private latestText: string, private readonly maximumPending = 16) {}

	get latest(): string {
		return this.latestText;
	}

	begin(text: string): { text: string; previous: string } {
		const token = { text, previous: this.latestText };
		this.latestText = text;
		this.pendingTexts.delete(text);
		this.pendingTexts.add(text);
		while (this.pendingTexts.size > this.maximumPending) {
			const oldest = this.pendingTexts.values().next().value;
			if (oldest === undefined) break;
			this.pendingTexts.delete(oldest);
		}
		return token;
	}

	rollback(token: { text: string; previous: string }): void {
		this.pendingTexts.delete(token.text);
		if (this.latestText === token.text) this.latestText = token.previous;
	}

	observe(text: string): boolean {
		if (!this.pendingTexts.has(text)) return false;
		this.pendingTexts.delete(text);
		return true;
	}
}

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

/**
 * Normalize a value for comparison purposes.
 * This handles type coercion and default values so that semantically equivalent
 * states compare as equal regardless of how they were serialized.
 */
export const normalizeValue = (value: unknown, key?: string): unknown => {
	// Handle null/undefined
	if (value === null || value === undefined) {
		return undefined;
	}

	// Handle arrays
	if (Array.isArray(value)) {
		const normalized = value.map((item) => normalizeValue(item));
		// Empty arrays are treated as undefined for comparison
		return normalized.length > 0 ? normalized : undefined;
	}

	// Handle objects (recursively normalize)
	if (typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			const normalized = normalizeValue(v, k);
			// Only include non-undefined values
			if (normalized !== undefined) {
				result[k] = normalized;
			}
		}
		// Empty objects are treated as undefined for comparison
		return Object.keys(result).length > 0 ? result : undefined;
	}

	// Handle strings - empty strings are treated as undefined
	if (typeof value === 'string') {
		const trimmed = value;
		return trimmed !== '' ? trimmed : undefined;
	}

	// Handle numbers - normalize heights and special numeric fields
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			return undefined;
		}
		// Height fields should be rounded positive integers
		if (key && (key.endsWith('HeightPx') || key.endsWith('WidthPx'))) {
			const rounded = Math.round(value);
			return rounded > 0 ? rounded : undefined;
		}
		return value;
	}

	// Booleans and other primitives pass through
	return value;
};

/**
 * Normalize a section for comparison. This handles all section types generically
 * without needing to enumerate every property - any new properties added to sections
 * will automatically be included in comparisons.
 */
export const normalizeSection = (section: unknown): Record<string, unknown> | undefined => {
	if (!section || typeof section !== 'object') {
		return undefined;
	}

	const s = section as Record<string, unknown>;
	const type = String(s.type ?? '');
	
	// Skip unknown section types
	const knownTypes = ['query', 'copilotQuery', 'markdown', 'python', 'url', 'chart', 'transformation', 'html', 'sql'];
	if (!knownTypes.includes(type)) {
		return undefined;
	}

	// Normalize the type (copilotQuery -> query for comparison)
	const normalizedType = (type === 'copilotQuery') ? 'query' : type;
	
	// Collect all normalized properties first, skipping ephemeral UI-state
	// keys (pixel dimensions, visibility toggles, cached results) so that
	// layout-only changes never mark a section as modified.
	const raw: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(s)) {
		if (key === 'type') continue; // Handled separately
		if (COMPARISON_NOISE_KEYS.has(key)) continue; // Ephemeral UI state (heights kept for persistence)
		if (__kustoIsImplicitSectionDefault(key, value)) continue;
		const normalized = normalizeValue(value, key);
		if (normalized !== undefined) {
			raw[key] = normalized;
		}
	}

	// Build the result with a canonical key order so diffs are readable:
	// type → id → title → clusterUrl → database → content key → expanded → everything else (sorted)
	const contentKeys = ['query', 'text', 'code', 'url'];
	const preferredOrder = ['id', 'title', 'clusterUrl', 'database'];
	const result: Record<string, unknown> = { type: normalizedType };

	for (const key of preferredOrder) {
		if (key in raw) { result[key] = raw[key]; }
	}
	for (const key of contentKeys) {
		if (key in raw) { result[key] = raw[key]; }
	}
	if ('expanded' in raw) { result.expanded = raw.expanded; }

	// Remaining keys in sorted order.
	const placed = new Set([...preferredOrder, ...contentKeys, 'expanded']);
	for (const key of Object.keys(raw).sort()) {
		if (!placed.has(key)) { result[key] = raw[key]; }
	}

	return result;
};

function __kustoIsImplicitSectionDefault(key: string, value: unknown): boolean {
	if (key === 'expanded' && value === true) return true;
	if (key === 'resultsVisible' && value === true) return true;
	if (key === 'runMode' && (String(value || '') === 'take100' || String(value || '') === 'top100')) return true;
	if (key === 'cacheEnabled' && value === true) return true;
	if (key === 'cacheValue' && value === 1) return true;
	if (key === 'cacheUnit' && String(value || '') === 'days') return true;
	return false;
}

/**
 * Normalize an entire state for comparison. This is used to determine if the
 * incoming state from the webview matches the current document state, to avoid
 * unnecessary writes that would dirty the document.
 * 
 * IMPORTANT: This function is intentionally generic and does NOT enumerate
 * specific properties. When you add new properties to any section type, they
 * will automatically be included in comparisons without any code changes here.
 */
export const normalizeStateForComparison = (s: KqlxStateV1): Record<string, unknown> => {
	const sections: Array<Record<string, unknown>> = [];
	
	for (const section of Array.isArray(s.sections) ? s.sections : []) {
		const normalized = normalizeSection(section);
		if (normalized) {
			sections.push(normalized);
		}
	}

	return {
		caretDocsEnabled: typeof s.caretDocsEnabled === 'boolean' ? s.caretDocsEnabled : true,
		...(typeof s.autoTriggerAutocompleteEnabled === 'boolean'
			? { autoTriggerAutocompleteEnabled: s.autoTriggerAutocompleteEnabled }
			: {}),
		sections
	};
};

export const normalizeHeight = (v: unknown): number | undefined => {
	const n = typeof v === 'number' ? v : undefined;
	if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
		return undefined;
	}
	return Math.round(n);
};

export const deepEqual = (a: unknown, b: unknown): boolean => {
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

/**
 * Compute per-section changes between an incoming state and a saved section cache.
 * Pure function — no side effects — suitable for unit testing.
 *
 * @param diffMode — `'contentAndSettings'` (default) marks a section as changed
 *   if either content or settings differ. `'contentOnly'` only marks a section
 *   as changed if its content differs (new sections are always reported).
 */
export const computeChangedSections = (
	incomingSections: unknown[],
	savedCache: Map<string, Record<string, unknown>>,
	diffMode: 'contentAndSettings' | 'contentOnly' = 'contentAndSettings'
): SectionChangeInfo[] => {
	const changes: SectionChangeInfo[] = [];
	for (const section of incomingSections) {
		const s = section as Record<string, unknown>;
		const id = typeof s.id === 'string' ? s.id : '';
		if (!id) continue;

		const normalized = normalizeSection(section);
		if (!normalized) continue;

		const saved = savedCache.get(id);
		if (!saved) {
			// Section not on disk — it's new.
			changes.push({ id, status: 'new', contentChanged: true, settingsChanged: true });
			continue;
		}

		if (!deepEqual(normalized, saved)) {
			// Determine what kind of change: content vs settings.
			const contentKeys = ['query', 'text', 'code', 'url', 'dataSourceId'];
			let contentChanged = false;
			let settingsChanged = false;
			for (const key of Object.keys(normalized)) {
				if (key === 'type' || key === 'id') continue;
				if (!deepEqual(normalized[key], saved[key])) {
					if (contentKeys.includes(key)) {
						contentChanged = true;
					} else {
						settingsChanged = true;
					}
				}
			}
			// Also check keys present in saved but not in normalized.
			for (const key of Object.keys(saved)) {
				if (key === 'type' || key === 'id') continue;
				if (!(key in normalized) && saved[key] !== undefined) {
					if (contentKeys.includes(key)) {
						contentChanged = true;
					} else {
						settingsChanged = true;
					}
				}
			}
			// In contentOnly mode, only report sections whose content changed.
			const shouldReport = diffMode === 'contentOnly'
				? contentChanged
				: (contentChanged || settingsChanged);
			if (shouldReport) {
				changes.push({ id, status: 'modified', contentChanged, settingsChanged });
			}
		}
	}
	return changes;
};

/**
 * Format a section for diff display. Returns the JSON text for the normalized
 * section settings, and an object with the content text and label if applicable.
 * Pure function — suitable for unit testing.
 */
export const formatSectionDiffContent = (
	normalizedSection: Record<string, unknown> | undefined,
	fallbackLabel: string
): { settingsText: string; content?: { text: string; label: string } } => {
	if (!normalizedSection) {
		return { settingsText: `(${fallbackLabel})` };
	}

	// Strip noise (content keys + ephemeral state) from the settings JSON;
	// content is extracted separately into its own diff tab.
	const settingsText = JSON.stringify(stripDiffNoise(normalizedSection), null, 2);

	const contentKeyByType: Record<string, { key: string; label: string }> = {
		query: { key: 'query', label: 'Kusto' },
		markdown: { key: 'text', label: 'Markdown' },
		python: { key: 'code', label: 'Code' },
		html: { key: 'code', label: 'Code' },
		sql: { key: 'query', label: 'SQL Query' },
	};
	const sectionType = String(normalizedSection.type ?? '');
	const contentInfo = contentKeyByType[sectionType];
	if (contentInfo) {
		const text = typeof normalizedSection[contentInfo.key] === 'string'
			? String(normalizedSection[contentInfo.key])
			: '';
		return { settingsText, content: { text, label: contentInfo.label } };
	}

	return { settingsText };
};

type IncomingWebviewMessage =
	| { type: 'requestDocument' }
	| { type: 'persistDocument'; state: KqlxStateV1; flush?: boolean; flushRequestId?: string; flushUnavailableReason?: string }
	| { type: string; [key: string]: unknown };

/**
 * Return a shallow clone of `section` with noise fields removed.
 * Does NOT mutate the original.
 */
export function stripDiffNoise(section: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(section)) {
		if (!DIFF_NOISE_KEYS.has(k)) {
			result[k] = v;
		}
	}
	return result;
}

export function sanitizeStateForKind(kind: KqlxFileKind, state: KqlxStateV1): KqlxStateV1 {
	if (kind !== 'mdx') {
		return state;
	}
	const sections = Array.isArray(state.sections) ? state.sections : [];
	const filtered = sections.filter((s) => {
		const t = (s as any)?.type;
		return t === 'markdown' || t === 'url' || t === 'transformation' || t === 'devnotes';
	});
	return {
		caretDocsEnabled: state.caretDocsEnabled,
		autoTriggerAutocompleteEnabled: state.autoTriggerAutocompleteEnabled,
		sections: filtered
	};
}

type PublishSqlStateFresh = <R>(
	state: KqlxStateV1,
	publish: (sanitizedState: KqlxStateV1) => Promise<R>,
) => Promise<R>;

export async function publishKqlxTextFresh<R>(
	text: string,
	kind: KqlxFileKind,
	eol: vscode.EndOfLine,
	publishStateFresh: PublishSqlStateFresh,
	publishText: (sanitizedText: string) => Promise<R>,
): Promise<R> {
	const parsed = parseKqlxText(text, {
		allowedKinds: ['kqlx', 'mdx', 'sqlx'],
		defaultKind: kind,
	});
	if (!parsed.ok) {
		throw new Error('Cannot publish a malformed Kusto Workbench document because its SQL privacy state cannot be verified.');
	}
	return publishStateFresh(parsed.file.state, async sanitizedState => {
		const serialized = stringifyKqlxFile({
			kind,
			version: 1,
			state: sanitizeStateForKind(kind, sanitizedState),
		});
		const lf = serialized.replace(/\r\n/g, '\n');
		return publishText(eol === vscode.EndOfLine.CRLF ? lf.replace(/\n/g, '\r\n') : lf);
	});
}

export class KqlxEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'kusto.kqlxEditor';
	private static readonly openPanelsByUri = new Map<string, Set<vscode.WebviewPanel>>();
	private static readonly closingEditorsByUri = new Map<string, Set<object>>();
	private static readonly panelChangeListenersByUri = new Map<string, Set<() => void>>();

	/** In-memory store for section diff virtual documents (saved and current snapshots). */
	public static readonly sectionDiffContents = new Map<string, string>();

	/** Whether the virtual document provider for section diffs has been registered. */
	private static sectionDiffProviderRegistered = false;

	private static panelKey(uri: vscode.Uri): string {
		return normalizeWorkbenchUriKey(uri);
	}

	private static notifyPanelChange(key: string): void {
		for (const listener of KqlxEditorProvider.panelChangeListenersByUri.get(key) ?? []) listener();
	}

	public static trackOpenEditor(uri: vscode.Uri, panel: vscode.WebviewPanel): vscode.Disposable & {
		beginClosing(): void;
		finishClosing(): void;
	} {
		const key = KqlxEditorProvider.panelKey(uri);
		const panels = KqlxEditorProvider.openPanelsByUri.get(key) ?? new Set<vscode.WebviewPanel>();
		panels.add(panel);
		KqlxEditorProvider.openPanelsByUri.set(key, panels);
		KqlxEditorProvider.notifyPanelChange(key);
		const closingToken = {};
		let state: 'open' | 'closing' | 'finished' = 'open';
		const removeOpenPanel = () => {
			const current = KqlxEditorProvider.openPanelsByUri.get(key);
			current?.delete(panel);
			if (current?.size === 0) KqlxEditorProvider.openPanelsByUri.delete(key);
		};
		const beginClosing = () => {
			if (state !== 'open') return;
			state = 'closing';
			removeOpenPanel();
			const closing = KqlxEditorProvider.closingEditorsByUri.get(key) ?? new Set<object>();
			closing.add(closingToken);
			KqlxEditorProvider.closingEditorsByUri.set(key, closing);
			KqlxEditorProvider.notifyPanelChange(key);
		};
		const finishClosing = () => {
			if (state === 'finished') return;
			if (state === 'open') removeOpenPanel();
			if (state === 'closing') {
				const closing = KqlxEditorProvider.closingEditorsByUri.get(key);
				closing?.delete(closingToken);
				if (closing?.size === 0) KqlxEditorProvider.closingEditorsByUri.delete(key);
			}
			state = 'finished';
			KqlxEditorProvider.notifyPanelChange(key);
		};
		return { dispose: finishClosing, beginClosing, finishClosing };
	}

	private static revealOpenEditor(uri: vscode.Uri, viewColumn: vscode.ViewColumn): boolean {
		const key = KqlxEditorProvider.panelKey(uri);
		const panels = KqlxEditorProvider.openPanelsByUri.get(key);
		if (!panels?.size) return false;
		for (const panel of [...panels].reverse()) {
			try {
				panel.reveal(viewColumn, false);
				return true;
			} catch {
				panels.delete(panel);
			}
		}
		if (panels.size === 0) KqlxEditorProvider.openPanelsByUri.delete(key);
		return false;
	}

	public static async revealOpenEditorWhenReady(
		uri: vscode.Uri,
		viewColumn: vscode.ViewColumn,
		timeoutMs = 0,
	): Promise<boolean> {
		if (KqlxEditorProvider.revealOpenEditor(uri, viewColumn)) return true;
		if (timeoutMs <= 0) return false;
		const key = KqlxEditorProvider.panelKey(uri);
		return new Promise<boolean>(resolve => {
			let settled = false;
			const listeners = KqlxEditorProvider.panelChangeListenersByUri.get(key) ?? new Set<() => void>();
			const finish = (revealed: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				listeners.delete(onChange);
				if (listeners.size === 0) KqlxEditorProvider.panelChangeListenersByUri.delete(key);
				resolve(revealed);
			};
			const onChange = () => {
				if (KqlxEditorProvider.revealOpenEditor(uri, viewColumn)) finish(true);
			};
			listeners.add(onChange);
			KqlxEditorProvider.panelChangeListenersByUri.set(key, listeners);
			const timer = setTimeout(() => finish(false), timeoutMs);
			onChange();
		});
	}

	public static async waitForOpenEditorsClosed(uri: vscode.Uri, timeoutMs = 30_000): Promise<boolean> {
		const key = KqlxEditorProvider.panelKey(uri);
		const hasActiveEditor = () => !!KqlxEditorProvider.openPanelsByUri.get(key)?.size
			|| !!KqlxEditorProvider.closingEditorsByUri.get(key)?.size;
		if (!hasActiveEditor()) return true;
		return new Promise<boolean>(resolve => {
			let settled = false;
			const listeners = KqlxEditorProvider.panelChangeListenersByUri.get(key) ?? new Set<() => void>();
			const finish = (closed: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				listeners.delete(onChange);
				if (listeners.size === 0) KqlxEditorProvider.panelChangeListenersByUri.delete(key);
				resolve(closed);
			};
			const onChange = () => {
				if (!hasActiveEditor()) finish(true);
			};
			listeners.add(onChange);
			KqlxEditorProvider.panelChangeListenersByUri.set(key, listeners);
			const timer = setTimeout(() => finish(false), timeoutMs);
			onChange();
		});
	}

	private static getDocumentKind(document: vscode.TextDocument): KqlxFileKind {
		try {
			const p = String(document.uri?.path || '').toLowerCase();
			if (p.endsWith('.mdx')) {
				return 'mdx';
			}
			if (p.endsWith('.sqlx')) {
				return 'sqlx';
			}
		} catch {
			// ignore
		}
		return 'kqlx';
	}

	private static getAllowedSectionKinds(
		kind: KqlxFileKind
	): Array<'query' | 'chart' | 'transformation' | 'markdown' | 'python' | 'url' | 'html' | 'sql'> {
		if (kind === 'mdx') {
			return ['markdown', 'url', 'transformation'];
		}
		if (kind === 'sqlx') {
			return ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'];
		}
		return ['query', 'sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'];
	}

	private static pendingAddKindKeyForUri(uri: vscode.Uri): string {
		return `kusto.pendingAddKind:${normalizeWorkbenchUriKey(uri)}`;
	}

	public static register(
		context: vscode.ExtensionContext,
		extensionUri: vscode.Uri,
		connectionManager: ConnectionManager,
		sqlWorkbench: SqlWorkbenchService,
		editorCursorStatusBar?: EditorCursorStatusBar
	): vscode.Disposable {
		// Register the virtual document provider for section diffs (once).
		if (!KqlxEditorProvider.sectionDiffProviderRegistered) {
			KqlxEditorProvider.sectionDiffProviderRegistered = true;
			context.subscriptions.push(
				vscode.workspace.registerTextDocumentContentProvider('kusto-section-diff', {
					provideTextDocumentContent(uri: vscode.Uri): string {
						return KqlxEditorProvider.sectionDiffContents.get(uri.toString()) ?? '';
					}
				})
			);
		}

		const provider = new KqlxEditorProvider(context, extensionUri, connectionManager, sqlWorkbench, editorCursorStatusBar);
		return vscode.window.registerCustomEditorProvider(KqlxEditorProvider.viewType, provider, {
			// VS Code supports a built-in Find widget for webviews.
			// Our `vscode` typings may lag the runtime API, so we set this defensively.
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
		const documentKindForPerf = KqlxEditorProvider.getDocumentKind(document);
		const fileOpenTrace = createFileOpenTrace('kqlx', {
			documentKind: documentKindForPerf,
			scheme: document.uri.scheme,
			path: document.uri.path,
			visible: webviewPanel.visible,
			active: webviewPanel.active,
		});
		perfBegin('host.kqlx.resolve', {
			documentKind: documentKindForPerf,
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
		const openEditorRegistration = KqlxEditorProvider.trackOpenEditor(document.uri, webviewPanel);
		if (!parseKqlxText(document.getText(), {
			allowedKinds: ['kqlx', 'mdx', 'sqlx'],
			defaultKind: documentKindForPerf,
		}).ok) {
			webviewPanel.webview.options = { enableScripts: false };
			webviewPanel.webview.html = '<h2>Invalid Kusto Workbench file</h2><p>Read-only to prevent data loss. Open with the Text Editor to repair.</p>';
			webviewPanel.onDidDispose(() => openEditorRegistration.dispose());
			return;
		}
		// For the "modified" side (file: scheme) or normal usage, render the regular editor.
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
		fileOpenTrace.mark('webview.options.set', { localResourceRoots: [this.extensionUri, docDir, workspaceFolderUri].filter(Boolean).length });

		const queryEditor = new QueryEditorProvider(this.extensionUri, this.connectionManager, this.context, this.sqlWorkbench, this.editorCursorStatusBar);
		queryEditor.fileOpenTrace = fileOpenTrace;
		queryEditor.documentUri = document.uri.toString();
		let handleIncomingWebviewMessage: ((message: IncomingWebviewMessage) => Promise<void>) | undefined;
		const queuedWebviewMessages: IncomingWebviewMessage[] = [];
		const admittedWebviewHandlers = new Set<Promise<void>>();
		const admittedPersistenceHandlers = new Set<Promise<void>>();
		let outerDisposed = false;
		let closeFinalizationAbandoned = false;
		const runIncomingWebviewMessage = (message: IncomingWebviewMessage): Promise<void> => {
			const handler = handleIncomingWebviewMessage;
			if (!handler || outerDisposed) return Promise.resolve();
			let settleAdmission!: () => void;
			const admission = new Promise<void>(resolve => { settleAdmission = resolve; });
			admittedWebviewHandlers.add(admission);
			const persistenceCritical = message.type === 'persistDocument' || message.type === 'requestDocument';
			if (persistenceCritical) admittedPersistenceHandlers.add(admission);
			let handling: Promise<void>;
			try {
				handling = handler(message);
			} catch (error) {
				handling = Promise.reject(error);
			}
			return handling
				.catch(error => {
					getWorkbenchLogger().warn('[kusto] webview message failed:', error instanceof Error ? error : String(error));
				})
				.finally(() => {
					admittedWebviewHandlers.delete(admission);
					admittedPersistenceHandlers.delete(admission);
					settleAdmission();
				});
		};
		const webviewMessageSubscription = webviewPanel.webview.onDidReceiveMessage((message: IncomingWebviewMessage) => {
			if (outerDisposed || !message || typeof message.type !== 'string') {
				return;
			}
			fileOpenTrace.mark('webview.message.received', { type: message.type, handlerReady: !!handleIncomingWebviewMessage, queued: queuedWebviewMessages.length });
			if (!handleIncomingWebviewMessage) {
				queuedWebviewMessages.push(message);
				fileOpenTrace.mark('webview.message.queued', { type: message.type, queued: queuedWebviewMessages.length });
				return;
			}
			return runIncomingWebviewMessage(message);
		});
		const postWebviewMessage = (message: unknown): boolean => {
			if (outerDisposed) return false;
			try {
				void webviewPanel.webview.postMessage(message);
				return true;
			} catch {
				return false;
			}
		};
		const outerDisposalSubscription = webviewPanel.onDidDispose(() => {
			outerDisposed = true;
			openEditorRegistration.beginClosing();
		});
		fileOpenTrace.mark('initializeWebviewPanel.start');
		try {
			await queryEditor.initializeWebviewPanel(webviewPanel, { registerMessageHandler: false, initialDocumentLoading: true });
		} catch (error) {
			webviewMessageSubscription.dispose();
			outerDisposalSubscription.dispose();
			openEditorRegistration.dispose();
			throw error;
		}
		if (outerDisposed) {
			webviewMessageSubscription.dispose();
			outerDisposalSubscription.dispose();
			openEditorRegistration.finishClosing();
			return;
		}
		fileOpenTrace.mark('initializeWebviewPanel.done');

		perfMark('host.kqlx.webviewInitialized');
		const documentKind = documentKindForPerf;
		const allowedSectionKinds = KqlxEditorProvider.getAllowedSectionKinds(documentKind);
		const defaultSectionKind: 'query' | 'markdown' | 'sql' = documentKind === 'mdx' ? 'markdown' : documentKind === 'sqlx' ? 'sql' : 'query';

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
			return normalizeWorkbenchUriKey(document.uri) === normalizeWorkbenchUriKey(sessionUri);
		})();

		// Inform the webview whether it's operating in session mode, and which section kinds are allowed.
		const postPersistenceMode = () => {
			const htmlPowerBiCompatibilityCheckEnabled = vscode.workspace.getConfiguration('kustoWorkbench').get<boolean>('html.powerBiCompatibilityCheck.enabled', true);
			postWebviewMessage({
				type: 'persistenceMode',
				isSessionFile,
				documentUri: document.uri.toString(),
				compatibilityMode: false,
				documentKind,
				allowedSectionKinds,
				defaultSectionKind,
				htmlPowerBiCompatibilityCheckEnabled
			});
		};
		postPersistenceMode();

		let pendingAddKindDelivered = false;
		let saveTimer: NodeJS.Timeout | undefined;
		let lastSavedText = document.getText();
		let lastSavedEol = document.eol;

		// ── Section-level unsaved-changes tracking ──────────────────────────
		// A cache of normalized sections from the last-saved text, keyed by section id.
		// Rebuilt on save, load, and reload. Used to detect per-section changes.
		let savedSectionCache = new Map<string, Record<string, unknown>>();
		// Track the set of known section IDs on disk, so we can detect new sections.
		let savedSectionIds = new Set<string>();
		// Last change set sent to the webview, to avoid redundant posts.
		let lastPostedChangesJson = '';

		const rebuildSavedSectionCache = (text: string) => {
			const cache = new Map<string, Record<string, unknown>>();
			const ids = new Set<string>();
			try {
				const parsed = parseKqlxText(text, {
					allowedKinds: ['kqlx', 'mdx', 'sqlx'],
					defaultKind: documentKind
				});
				if (parsed.ok) {
					for (const section of parsed.file.state.sections) {
						const s = section as Record<string, unknown>;
						const id = typeof s.id === 'string' ? s.id : '';
						if (!id) continue;
						const normalized = normalizeSection(section);
						if (normalized) {
							cache.set(id, normalized);
							ids.add(id);
						}
					}
				}
			} catch {
				// ignore
			}
			savedSectionCache = cache;
			savedSectionIds = ids;
		};

		// Build initial cache from the document on disk.
		rebuildSavedSectionCache(lastSavedText);

		const computeChangedSectionsForState = (incomingState: KqlxStateV1): SectionChangeInfo[] => {
			const sections = Array.isArray(incomingState.sections) ? incomingState.sections : [];
			const diffMode = vscode.workspace.getConfiguration('kustoWorkbench').get<string>('sectionDiffMode', 'contentAndSettings') === 'contentOnly'
				? 'contentOnly' as const
				: 'contentAndSettings' as const;
			return computeChangedSections(sections, savedSectionCache, diffMode);
		};

		const postChangedSections = (changes: SectionChangeInfo[]) => {
			try {
				const json = JSON.stringify(changes);
				if (json === lastPostedChangesJson) return; // Deduplicate.
				lastPostedChangesJson = json;
				postWebviewMessage({
					type: 'changedSections',
					changes
				} satisfies import('./queryEditorTypes').ChangedSectionsMessage);
			} catch {
				// ignore
			}
		};

		const postChangedSectionsClear = () => {
			postChangedSections([]);
		};
		let linkedQueryUri: vscode.Uri | undefined;
		let linkedQueryPathRaw = '';
		let linkedQueryDocument: vscode.TextDocument | undefined;
		let lastSavedLinkedQueryText = '';
		// Track the last text we wrote directly to disk for session files.
		// Pending identities suppress each matching document event even when writes are observed out of order.
		const ownedSessionWrites = new OwnedSessionWriteTracker(isSessionFile ? lastSavedText : '');

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
				if (closeFinalizationAbandoned) return false;
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
				if (closeFinalizationAbandoned) return false;
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
				return {
					caretDocsEnabled: state.caretDocsEnabled,
					autoTriggerAutocompleteEnabled: state.autoTriggerAutocompleteEnabled,
					sections: [first, ...sections.slice(1)] as any,
				};
			} catch {
				return state;
			}
		};

		const sanitizeSerializedNotebookTextFresh = async (text: string): Promise<string> => {
			return publishKqlxTextFresh(
				text,
				documentKind,
				document.eol,
				(state, publish) => queryEditor.publishSqlLeaveNoTraceStateFresh(state, publish),
				async sanitizedText => sanitizedText,
			);
		};
		const sanitizeSerializedNotebookTextFailClosed = async (text: string): Promise<string> => {
			return publishKqlxTextFresh(
				text,
				documentKind,
				document.eol,
				async (state, publish) => publish(queryEditor.sanitizeSqlLeaveNoTraceStateFailClosed(state)),
				async sanitizedText => sanitizedText,
			);
		};
		const publishSerializedNotebookTextFresh = <R>(
			text: string,
			publishText: (sanitizedText: string) => Promise<R>,
		): Promise<R> => publishKqlxTextFresh(
			text,
			documentKind,
			document.eol,
			(state, publish) => queryEditor.publishSqlLeaveNoTraceStateFresh(state, publish),
			publishText,
		);
		const normalizeTextToEol = (text: string, eol: vscode.EndOfLine): string => {
			const lf = String(text ?? '').replace(/\r\n/g, '\n');
			return eol === vscode.EndOfLine.CRLF ? lf.replace(/\n/g, '\r\n') : lf;
		};
		const stateForDocument = (state: KqlxStateV1): KqlxStateV1 => {
			if (!linkedQueryUri || !state.sections.length) return state;
			const sections = state.sections.map(section => ({ ...(section as any) }));
			const first = sections[0] as any;
			if (first?.type === 'query' || first?.type === 'copilotQuery') {
				if (linkedQueryPathRaw) first.linkedQueryPath = linkedQueryPathRaw;
				delete first.query;
			}
			return { ...state, sections: sections as any };
		};
		const serializeDocumentState = (state: KqlxStateV1): string => normalizeTextToEol(stringifyKqlxFile({
			kind: documentKind, version: 1, state: stateForDocument(state),
		}), document.eol);

		let _persistChain: Promise<void> = Promise.resolve();
		let lastWebviewPersistAt = 0;
		let sqlSaveRepairTail: Promise<void> = Promise.resolve();
		const serializeSqlSaveRepair = async <T>(work: () => Promise<T>): Promise<T> => {
			let result!: T;
			const run = sqlSaveRepairTail.catch(() => undefined).then(async () => { result = await work(); });
			sqlSaveRepairTail = run.then(() => undefined, () => undefined);
			await run;
			return result;
		};
		const writeOwnedSessionText = async (nextText: string, allowDisposed = false): Promise<void> => {
			if (closeFinalizationAbandoned || (outerDisposed && !allowDisposed)) {
				throw new Error('The Kusto Workbench session editor was disposed before persistence completed.');
			}
			const writeToken = ownedSessionWrites.begin(nextText);
			try {
				await vscode.workspace.fs.writeFile(document.uri, new TextEncoder().encode(nextText));
			} catch (error) {
				ownedSessionWrites.rollback(writeToken);
				throw error;
			}
		};

		// For session files, write directly to disk without going through the document edit cycle.
		// This avoids the dirty indicator flickering that happens with applyEdit→save.
		const saveSessionFileToDisk = async (text: string): Promise<boolean> => {
			if (!isSessionFile || outerDisposed) {
				return false;
			}
			try {
				return await serializeSqlSaveRepair(async () => {
					if (outerDisposed) return false;
					text = await publishSerializedNotebookTextFresh(text, async sanitizedText => {
						if (outerDisposed) return sanitizedText;
						if (sanitizedText !== ownedSessionWrites.latest) await writeOwnedSessionText(sanitizedText);
						return sanitizedText;
					});
					if (outerDisposed) return false;
					lastSavedText = text;
					lastSavedEol = document.eol;
					return true;
				});
			} catch {
				return false;
			}
		};

		const repairPersistedSqlState = (allowDisposed = false): Promise<void> => serializeSqlSaveRepair(async () => {
			if (closeFinalizationAbandoned || (outerDisposed && !allowDisposed)) return;
			const startingText = document.getText();
			const startedDirty = document.isDirty;
			if (isSessionFile) {
				const diskText = new TextDecoder().decode(await vscode.workspace.fs.readFile(document.uri));
				const repairedText = await publishSerializedNotebookTextFresh(diskText, async sanitizedText => {
					if (closeFinalizationAbandoned) return sanitizedText;
					if (sanitizedText !== diskText) await writeOwnedSessionText(sanitizedText, allowDisposed);
					return sanitizedText;
				});
				lastSavedText = repairedText;
				return;
			}
			const currentFile = parseKqlxText(startingText, {
				allowedKinds: ['kqlx', 'mdx', 'sqlx'],
				defaultKind: documentKind,
			});
			if (currentFile.ok && !hasSqlOwnedDocumentState(currentFile.file.state)) {
				return;
			}
			const repairedText = await sanitizeSerializedNotebookTextFresh(startingText);
			if (closeFinalizationAbandoned) return;
			if (repairedText === startingText) return;
			let repairedBufferText = '';
			let mayAutoSaveRepair = false;
			await (_persistChain = _persistChain.then(async () => {
				if (closeFinalizationAbandoned) return;
				const latestText = document.getText();
				const latestRepair = await sanitizeSerializedNotebookTextFresh(latestText);
				if (closeFinalizationAbandoned) return;
				if (latestRepair === latestText) return;
				mayAutoSaveRepair = !startedDirty && !document.isDirty && latestText === startingText;
				const edit = new vscode.WorkspaceEdit();
				edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(latestText.length)), latestRepair);
				lastWebviewPersistAt = Date.now();
				if (!await vscode.workspace.applyEdit(edit)) {
					throw new Error('VS Code rejected the SQL privacy repair edit.');
				}
				repairedBufferText = latestRepair;
			}));
			if (mayAutoSaveRepair && repairedBufferText
				&& document.isDirty && document.getText() === repairedBufferText) {
				await document.save();
			}
		});

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
			const requestedConnections: Array<{ clusterUrl: string; authorityId?: string }> = [];
			for (const sec of Array.isArray(state.sections) ? state.sections : []) {
				try {
					const t = (sec as any)?.type;
					if (!sec || (t !== 'query' && t !== 'copilotQuery')) {
						continue;
					}
					const clusterUrl = String((sec as any).clusterUrl || '').trim();
					if (clusterUrl) {
						requestedConnections.push({
							clusterUrl,
							authorityId: normalizeKustoAuthorityId((sec as any).authorityId),
						});
					}
				} catch {
					// Keep malformed portable authorities unresolved without blocking valid sections.
				}
			}
			const uniqueKeys = new Map<string, { clusterUrl: string; authorityId?: string }>();
			for (const requested of requestedConnections) {
				const k = getKustoConnectionIdentityKey(requested.clusterUrl, requested.authorityId);
				if (k && !uniqueKeys.has(k)) {
					uniqueKeys.set(k, requested);
				}
			}

			if (uniqueKeys.size === 0) {
				return false;
			}

			const existing = this.connectionManager.getConnections();
			const existingKeys = new Set(existing.flatMap((connection) => {
				try {
					const key = getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId);
					return key ? [key] : [];
				} catch {
					return [];
				}
			}));

			let added = 0;
			for (const [, requested] of uniqueKeys) {
				const originalUrl = requested.clusterUrl;
				const key = getKustoConnectionIdentityKey(originalUrl, requested.authorityId);
				if (!key || existingKeys.has(key)) {
					continue;
				}
				let clusterUrl = String(originalUrl || '').trim();
				if (clusterUrl && !/^https?:\/\//i.test(clusterUrl)) {
					clusterUrl = 'https://' + clusterUrl.replace(/^\/+/, '');
				}
				await this.connectionManager.addConnection({
					name: getClusterShortName(clusterUrl || originalUrl) || getDefaultConnectionName(clusterUrl || originalUrl),
					clusterUrl: clusterUrl || originalUrl,
					authorityId: requested.authorityId,
				});
				existingKeys.add(key);
				added++;
			}

			return added > 0;
		};

		const postDocument = async (options?: { forceReload?: boolean }) => {
			if (outerDisposed) return;
			const forceReload = options?.forceReload ?? false;
			const suppressPersistenceForTest = this.context.extensionMode !== vscode.ExtensionMode.Production
				&& process.env.KUSTO_WORKBENCH_E2E_SUPPRESS_PERSISTENCE === '1';
			perfMark('host.kqlx.postDocument.start', { forceReload });
			fileOpenTrace.mark('postDocument.start', { forceReload });
			const htmlPowerBiCompatibilityCheckEnabled = vscode.workspace.getConfiguration('kustoWorkbench').get<boolean>('html.powerBiCompatibilityCheck.enabled', true);
			const rawText = document.getText();
			perfMark('host.kqlx.documentText.read', { length: rawText.length });
			fileOpenTrace.mark('postDocument.documentText.read', { length: rawText.length });
			const parsed = parseKqlxText(rawText, {
				allowedKinds: ['kqlx', 'mdx', 'sqlx'],
				defaultKind: documentKind
			});
			perfMark('host.kqlx.parse.done', { ok: parsed.ok });
			fileOpenTrace.mark('postDocument.parse.done', { ok: parsed.ok });
			if (!parsed.ok) {
				postWebviewMessage({
					type: 'documentData',
					ok: false,
					forceReload,
					documentUri: document.uri.toString(),
					suppressPersistenceForTest,
					error: parsed.error,
					htmlPowerBiCompatibilityCheckEnabled,
				});
				fileOpenTrace.mark('postDocument.documentData.posted', { ok: false, forceReload });
				return;
			}

			let sanitizedState = sanitizeStateForKind(documentKind, parsed.file.state);
			if (hasSqlOwnedDocumentState(sanitizedState)) {
				sanitizedState = sanitizeStateForKind(documentKind, await queryEditor.sanitizeSqlLeaveNoTraceStateFresh(sanitizedState));
			}
			if (outerDisposed) return;
			perfMark('host.kqlx.sanitize.done', { sections: Array.isArray(sanitizedState.sections) ? sanitizedState.sections.length : 0 });
			fileOpenTrace.mark('postDocument.sanitize.done', { sections: Array.isArray(sanitizedState.sections) ? sanitizedState.sections.length : 0 });
			const hydratedState = await injectLinkedQueryText(sanitizedState);
			if (outerDisposed) return;
			perfMark('host.kqlx.injectLinkedQuery.done', { sections: Array.isArray(hydratedState.sections) ? hydratedState.sections.length : 0 });
			fileOpenTrace.mark('postDocument.injectLinkedQuery.done', { sections: Array.isArray(hydratedState.sections) ? hydratedState.sections.length : 0 });
			const outboundState = hasSqlOwnedDocumentState(hydratedState)
				? await queryEditor.sanitizeSqlLeaveNoTraceStateFresh(hydratedState)
				: queryEditor.sanitizeSqlLeaveNoTraceState(hydratedState);
			if (outerDisposed) return;

			postWebviewMessage({
				type: 'documentData',
				ok: true,
				forceReload,
				documentUri: document.uri.toString(),
				suppressPersistenceForTest,
				htmlPowerBiCompatibilityCheckEnabled,
				state: outboundState
			});
			perfMark('host.kqlx.documentData.posted', { sections: Array.isArray(outboundState.sections) ? outboundState.sections.length : 0 });
			fileOpenTrace.mark('postDocument.documentData.posted', { ok: true, forceReload, sections: Array.isArray(outboundState.sections) ? outboundState.sections.length : 0 });

			void (async () => {
				let connectionsChanged = false;
				try {
					if (outerDisposed) return;
					perfMark('host.kqlx.ensureConnections.start');
					fileOpenTrace.mark('ensureConnections.start');
					connectionsChanged = await ensureConnectionsForState(outboundState);
					perfMark('host.kqlx.ensureConnections.done', { connectionsChanged });
					fileOpenTrace.mark('ensureConnections.done', { connectionsChanged });
				} catch {
					// ignore
				}
				if (connectionsChanged && !outerDisposed) {
					try {
						await queryEditor.refreshConnectionsData();
					} catch {
						// ignore
					}
				}
			})();
		};

		const subscriptions: vscode.Disposable[] = [webviewMessageSubscription, outerDisposalSubscription];
		const finalPersistSession = new CompatSidecarSession(false, 'Kusto Workbench document');
		type PendingSqlSavePublication = {
			release: () => void;
			settled: Promise<void>;
			timer: ReturnType<typeof setTimeout>;
		};
		let pendingSqlSavePublication: PendingSqlSavePublication | undefined;
		const releasePendingSqlSavePublication = (): void => {
			const pending = pendingSqlSavePublication;
			if (!pending) return;
			pendingSqlSavePublication = undefined;
			clearTimeout(pending.timer);
			pending.release();
			void pending.settled;
		};
		const prepareAtomicSqlSaveText = async (currentText: string): Promise<string> => {
			const parsed = parseKqlxText(currentText, {
				allowedKinds: ['kqlx', 'mdx', 'sqlx'],
				defaultKind: documentKind,
			});
			if (!parsed.ok || !hasSqlOwnedDocumentState(parsed.file.state)) {
				return sanitizeSerializedNotebookTextFresh(currentText);
			}
			const failClosedText = await sanitizeSerializedNotebookTextFailClosed(currentText);
			releasePendingSqlSavePublication();
			let releasePublication!: () => void;
			const publicationHold = new Promise<void>(resolve => { releasePublication = resolve; });
			let decideCanonical!: (useCanonical: boolean) => void;
			const canonicalDecision = new Promise<boolean>(resolve => { decideCanonical = resolve; });
			let resolveStarted!: (text: string) => void;
			let rejectStarted!: (error: unknown) => void;
			let callbackStarted = false;
			const started = new Promise<string>((resolve, reject) => {
				resolveStarted = resolve;
				rejectStarted = reject;
			});
			const publication = publishSerializedNotebookTextFresh(currentText, async sanitizedText => {
				callbackStarted = true;
				resolveStarted(sanitizedText);
				if (!await canonicalDecision) return sanitizedText;
				await publicationHold;
				return sanitizedText;
			});
			const settled = publication.then(
				() => undefined,
				error => {
					if (!callbackStarted) rejectStarted(error);
					else getWorkbenchLogger().warn(`[sql-persistence] Save publication failed: ${error instanceof Error ? error.message : String(error)}`);
				},
			);
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const outcome = await Promise.race([
				started.then(
					text => ({ kind: 'canonical' as const, text }),
					error => ({ kind: 'failed' as const, error }),
				),
				new Promise<{ kind: 'timeout' }>(resolve => {
					timeout = setTimeout(() => resolve({ kind: 'timeout' }), SQL_SAVE_CANONICAL_WAIT_MS);
				}),
			]);
			if (timeout) clearTimeout(timeout);
			if (outcome.kind !== 'canonical') {
				decideCanonical(false);
				if (outcome.kind === 'failed') {
					getWorkbenchLogger().warn(`[sql-persistence] Canonical save sanitation failed; using fail-closed text: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`);
				} else {
					getWorkbenchLogger().warn('[sql-persistence] Canonical save sanitation exceeded the save budget; using fail-closed text.');
				}
				return failClosedText;
			}
			decideCanonical(true);
			const sanitizedText = outcome.text;
			const timer = setTimeout(() => {
				if (pendingSqlSavePublication?.release !== releasePublication) return;
				getWorkbenchLogger().warn('[sql-persistence] Timed out waiting for the SQL-safe document save to complete.');
				releasePendingSqlSavePublication();
			}, 30_000);
			pendingSqlSavePublication = { release: releasePublication, settled, timer };
			return sanitizedText;
		};
		subscriptions.push(queryEditor.onDidInvalidateSqlPersistence(() => {
			void repairPersistedSqlState().catch(() => undefined);
		}));
		if (!isSessionFile) {
			subscriptions.push(vscode.workspace.onWillSaveTextDocument(event => {
				if (event.document.uri.toString() !== document.uri.toString()) return;
				event.waitUntil((async () => {
					const currentText = document.getText();
					let sanitizedText: string;
					try {
						const saveState = await finalPersistSession.requestFinalPersist<KqlxStateV1>(
							message => webviewPanel.webview.postMessage(message), 'save', 1_000,
						);
						if (linkedQueryUri) {
							const first = saveState.sections[0] as any;
							if (first?.type === 'query' || first?.type === 'copilotQuery') {
								await applyLinkedQueryTextToDocument(String(first.query || ''));
							}
						}
						sanitizedText = await prepareAtomicSqlSaveText(serializeDocumentState(saveState));
					} catch (error) {
						releasePendingSqlSavePublication();
						getWorkbenchLogger().warn(`[sql-persistence] Final snapshot unavailable; saving fail-closed state: ${error instanceof Error ? error.message : String(error)}`);
						sanitizedText = await sanitizeSerializedNotebookTextFailClosed(document.getText());
					}
					const freshText = document.getText();
					if (sanitizedText === freshText) return [];
					return [vscode.TextEdit.replace(
						new vscode.Range(document.positionAt(0), document.positionAt(freshText.length)),
						sanitizedText,
					)];
				})());
			}));
		}
		subscriptions.push(
			vscode.workspace.onDidSaveTextDocument((saved) => {
				try {
					if (saved.uri.toString() !== document.uri.toString()) {
						if (linkedQueryUri && saved.uri.toString() === linkedQueryUri.toString()) {
							lastSavedLinkedQueryText = saved.getText();
						}
						return;
					}
					releasePendingSqlSavePublication();
					lastSavedText = saved.getText();
					lastSavedEol = saved.eol;
					// Rebuild section change cache and notify webview that everything is clean.
					rebuildSavedSectionCache(lastSavedText);
					postChangedSectionsClear();
					// Best-effort: when the notebook metadata file is saved, also save the linked query file.
					try {
						if (linkedQueryDocument && linkedQueryDocument.isDirty) {
							void linkedQueryDocument.save();
						}
					} catch {
						// ignore
					}
					void repairPersistedSqlState().catch(() => undefined);
				} catch {
					// ignore
				}
			})
		);

		// Track if the webview has initialized and whether it's currently being edited by the user.
		// This helps us avoid refreshing the webview for changes that originated from the webview itself.
		let webviewInitialized = false;

		// Serialization chain: each applyEdit waits for the previous one to finish.
		// This prevents concurrent applyEdit calls that cause VS Code's
		// "has changed in the meantime" validation error.

		// Listen for external file changes (e.g., from Copilot, git, or other processes).
		// When the document changes externally, refresh the webview to show the new content.
		subscriptions.push(
			vscode.workspace.onDidChangeTextDocument((e) => {
				try {
					if (outerDisposed) return;
					if (e.document.uri.toString() !== document.uri.toString()) {
						return;
					}
					const now = Date.now();
					const currentText = e.document.getText();
					if (!shouldReloadKqlxAfterDocumentChange({
						isSessionFile,
						matchesOwnedSessionWrite: isSessionFile && ownedSessionWrites.observe(currentText),
						webviewInitialized,
						contentChangeCount: e.contentChanges.length,
						lastWebviewPersistAt,
						now,
					})) return;
					// Notify the webview that the document changed externally.
					// Use forceReload to ensure the webview updates even if already initialized.
					void postDocument({ forceReload: true });
				} catch {
					// ignore
				}
			})
		);

		webviewPanel.onDidDispose(() => {
			void (async () => {
				try {
					finalPersistSession.settleClose();
					releasePendingSqlSavePublication();
					if (saveTimer) {
						clearTimeout(saveTimer);
						saveTimer = undefined;
					}
					const persistenceDrain = (async () => {
						await Promise.allSettled([...admittedPersistenceHandlers]);
						if (closeFinalizationAbandoned) return;
						await repairPersistedSqlState(true);
						if (closeFinalizationAbandoned) return;
						await _persistChain;
						await sqlSaveRepairTail;
						await _persistChain;
					})();
					if (!await settlesWithin(persistenceDrain, PERSISTENCE_CLOSE_WAIT_MS)) {
						closeFinalizationAbandoned = true;
						getWorkbenchLogger().warn('[kusto] Timed out draining Kusto Workbench persistence during close.');
					}
					if (!await settlesWithin(Promise.allSettled([...admittedWebviewHandlers]), NON_PERSISTENCE_CLOSE_WAIT_MS)) {
						getWorkbenchLogger().warn('[kusto] Timed out draining non-persistence webview work during close.');
					}
				} catch {
					// The document may already have been closed by VS Code.
				} finally {
					for (const s of subscriptions) {
						try { s.dispose(); } catch { /* ignore */ }
					}
					openEditorRegistration.finishClosing();
				}
			})();
		});

		handleIncomingWebviewMessage = async (message: IncomingWebviewMessage) => {
			if (outerDisposed || !message || typeof message.type !== 'string') {
				return;
			}
			switch (message.type) {
				case 'requestDocument':
					perfMark('host.kqlx.requestDocument.received');
					fileOpenTrace.mark('requestDocument.received');
					// Re-send mode/capabilities in response to a request (the webview is guaranteed to be listening).
					postPersistenceMode();
					// Only load from disk when explicitly requested by the webview.
					await postDocument();
					if (outerDisposed) return;
					webviewInitialized = true;
					await repairPersistedSqlState();
					perfMark('host.kqlx.requestDocument.completed');
					fileOpenTrace.mark('requestDocument.completed');

					// If we were upgraded and a specific "add" action triggered the upgrade,
					// deliver that intent now (after the webview has definitely attached its message listener).
					if (!pendingAddKindDelivered && pendingAddKind) {
						try {
							pendingAddKindDelivered = postWebviewMessage({ type: 'upgradedToKqlx', addKind: pendingAddKind });
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
					const flushRequestId = (message as any).flushRequestId;
					const flushUnavailableReason = (message as any).flushUnavailableReason;
					if (flushRequestId && flushUnavailableReason) {
						finalPersistSession.completeFinalPersist(
							flushRequestId,
							new Error(`Final document snapshot unavailable: ${flushUnavailableReason}`),
						);
						return;
					}
					// Track that the webview is persisting, so we don't treat the resulting
					// onDidChangeTextDocument event as an external change.
					lastWebviewPersistAt = Date.now();

					const persistReason = (message as any).reason || '';
					const rawState = (message as any).state;
					const incomingState = queryEditor.sanitizeSqlLeaveNoTraceState<KqlxStateV1>({
						caretDocsEnabled:
							rawState && typeof rawState.caretDocsEnabled === 'boolean' ? rawState.caretDocsEnabled : undefined,
						autoTriggerAutocompleteEnabled:
							rawState && typeof rawState.autoTriggerAutocompleteEnabled === 'boolean'
								? rawState.autoTriggerAutocompleteEnabled
								: undefined,
						sections: rawState && Array.isArray(rawState.sections) ? rawState.sections : []
					});
					const state = sanitizeStateForKind(documentKind, incomingState);
					if (flushRequestId) {
						finalPersistSession.completeFinalPersist(flushRequestId, undefined, state);
						return;
					}

					// ── Section-level change detection ──────────────────────────────
					// Compute changed sections from the incoming state vs the on-disk cache.
					// This runs on every persist, before any early return, so the webview always
					// gets up-to-date change indicators regardless of whether the persist
					// short-circuits (e.g. state matches disk).
					try {
						const changes = computeChangedSectionsForState(state);
						postChangedSections(changes);
					} catch {
						// ignore — change indicators are non-critical
					}

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

					const incomingComparable = normalizeStateForComparison(state);
					const currentText = document.getText();

					let incomingMatchesDisk = false;
					let diskTextForMatch = '';

					// If the incoming state matches what was last saved (even if the in-memory document has
					// different formatting), restore that exact saved text. This allows VS Code to clear the
					// dirty indicator when a user "returns" to the saved state.
					let nextText = '';
					try {
						const parsedSaved = parseKqlxText(lastSavedText, {
							allowedKinds: ['kqlx', 'mdx', 'sqlx'],
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
									return {
										caretDocsEnabled: parsedSaved.file.state.caretDocsEnabled,
										autoTriggerAutocompleteEnabled: parsedSaved.file.state.autoTriggerAutocompleteEnabled,
										sections: [injected, ...secs.slice(1)] as any,
									};
								} catch {
									return parsedSaved.file.state;
								}
							})();
							const savedComparable = normalizeStateForComparison(savedState);
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
								allowedKinds: ['kqlx', 'mdx', 'sqlx'],
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
										return {
											caretDocsEnabled: parsedDisk.file.state.caretDocsEnabled,
											autoTriggerAutocompleteEnabled: parsedDisk.file.state.autoTriggerAutocompleteEnabled,
											sections: [injected, ...secs.slice(1)] as any,
										};
									} catch {
										return parsedDisk.file.state;
									}
								})();
								const diskComparable = normalizeStateForComparison(diskState);
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
									allowedKinds: ['kqlx', 'mdx', 'sqlx'],
									defaultKind: documentKind
								});
								if (parsedDisk.ok) {
									const diskComparable = normalizeStateForComparison(parsedDisk.file.state);
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
								allowedKinds: ['kqlx', 'mdx', 'sqlx'],
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
										return {
											caretDocsEnabled: parsedCurrent.file.state.caretDocsEnabled,
											autoTriggerAutocompleteEnabled: parsedCurrent.file.state.autoTriggerAutocompleteEnabled,
											sections: [injected, ...secs.slice(1)] as any,
										};
									} catch {
										return parsedCurrent.file.state;
									}
								})();
								const currentComparable = normalizeStateForComparison(currentState);
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

					const freshState = sanitizeStateForKind(
						documentKind,
						await queryEditor.sanitizeSqlLeaveNoTraceStateFresh(state),
					);
					const policyChangedState = !deepEqual(
						normalizeStateForComparison(freshState),
						normalizeStateForComparison(state),
					);
					if (!nextText || policyChangedState) {
						nextText = serializeDocumentState(freshState);
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
					// Serialize through _persistChain so applyEdit calls never overlap.
					await (_persistChain = _persistChain.then(async () => {
						nextText = await sanitizeSerializedNotebookTextFresh(nextText);
						if (closeFinalizationAbandoned) return;
						// Re-read the document text immediately before building the edit range.
						// The earlier `currentText` may be stale if async processing or another
						// persist cycle modified the document in the meantime.
						const freshText = document.getText();
						const fullRange = new vscode.Range(
							document.positionAt(0),
							document.positionAt(freshText.length)
						);

						const edit = new vscode.WorkspaceEdit();
						edit.replace(document.uri, fullRange, nextText);
						// Refresh the timestamp right before the write so the onDidChangeTextDocument
						// guard still holds even if the earlier async processing took >500ms.
						lastWebviewPersistAt = Date.now();
						await vscode.workspace.applyEdit(edit);
					}).catch(() => undefined));

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
				case 'showSectionDiff': {
					const sectionId = typeof (message as any).sectionId === 'string' ? String((message as any).sectionId) : '';
					if (!sectionId) return;
					try {
						// Get the saved version of this section from cache.
						const savedNormalized = savedSectionCache.get(sectionId);
						// Get the current version from the in-memory state.
						const currentText = document.getText();
						const parsedCurrent = parseKqlxText(currentText, {
							allowedKinds: ['kqlx', 'mdx', 'sqlx'],
							defaultKind: documentKind
						});
						let currentSection: Record<string, unknown> | undefined;
						if (parsedCurrent.ok) {
							for (const sec of parsedCurrent.file.state.sections) {
								const s = sec as Record<string, unknown>;
								if (s.id === sectionId) {
									currentSection = normalizeSection(sec) ?? undefined;
									break;
								}
							}
						}

						const savedText = savedNormalized
							? JSON.stringify(stripDiffNoise(savedNormalized), null, 2)
							: '(section does not exist on disk)';
						const currentSectionText = currentSection
							? JSON.stringify(stripDiffNoise(currentSection), null, 2)
							: '(section not found)';

						const savedUri = vscode.Uri.parse(
							`kusto-section-diff:saved/${encodeURIComponent(sectionId)}-settings.txt`
						);
						const currentUri = vscode.Uri.parse(
							`kusto-section-diff:current/${encodeURIComponent(sectionId)}-settings.txt`
						);

						KqlxEditorProvider.sectionDiffContents.set(savedUri.toString(), savedText);
						KqlxEditorProvider.sectionDiffContents.set(currentUri.toString(), currentSectionText);

						const sectionLabel = sectionId.replace(/_/g, ' ');

						// For content-bearing sections, also open a dedicated content diff.
						const contentKeyByType: Record<string, { key: string; label: string }> = {
							query: { key: 'query', label: 'Kusto' },
							markdown: { key: 'text', label: 'Markdown' },
							python: { key: 'code', label: 'Code' },
							html: { key: 'code', label: 'Code' },
							sql: { key: 'query', label: 'SQL Query' },
						};
						const sectionType = String(currentSection?.type ?? savedNormalized?.type ?? '');
						const contentInfo = contentKeyByType[sectionType];

						// Pre-compute whether a content diff will follow so we can
						// pin the settings tab only when needed.
						let contentChanged = false;
						let savedContent = '';
						let currentContent = '';
						if (contentInfo) {
							savedContent = typeof savedNormalized?.[contentInfo.key] === 'string'
								? String(savedNormalized[contentInfo.key])
								: '';
							currentContent = typeof currentSection?.[contentInfo.key] === 'string'
								? String(currentSection[contentInfo.key])
								: '';
							contentChanged = savedContent !== currentContent;
						}

						// When diffMode is contentOnly, skip the settings JSON diff entirely.
						const diffMode = vscode.workspace.getConfiguration('kustoWorkbench').get<string>('sectionDiffMode', 'contentAndSettings');
						const settingsChanged = savedText !== currentSectionText;
						const showSettingsDiff = diffMode !== 'contentOnly' && settingsChanged;

						if (showSettingsDiff) {
							// Open the settings diff first, pinned (preview: false) so the content
							// diff that follows doesn't replace it.
							await vscode.commands.executeCommand(
								'vscode.diff',
								savedUri,
								currentUri,
								`${sectionLabel} (Saved ↔ Current)`,
								// Pin this tab only when a content diff will follow.
								{ preview: !contentChanged } as vscode.TextDocumentShowOptions
							);
						}

						// Only open the content diff if the content actually changed;
						// otherwise the JSON settings diff is sufficient.
						if (contentChanged) {
							const savedContentUri = vscode.Uri.parse(
								`kusto-section-diff:saved/${encodeURIComponent(sectionId)}-content.txt`
							);
							const currentContentUri = vscode.Uri.parse(
								`kusto-section-diff:current/${encodeURIComponent(sectionId)}-content.txt`
							);

							KqlxEditorProvider.sectionDiffContents.set(savedContentUri.toString(), savedContent);
							KqlxEditorProvider.sectionDiffContents.set(currentContentUri.toString(), currentContent);

							await vscode.commands.executeCommand(
								'vscode.diff',
								savedContentUri,
								currentContentUri,
								`${sectionLabel} — ${contentInfo!.label} (Saved ↔ Current)`
							);
						}
					} catch (err) {
							getWorkbenchLogger().error('[kusto] showSectionDiff error:', err instanceof Error ? err : String(err));
					}
					return;
				}

				default:
					// Forward everything else to the existing query editor handler.
					await queryEditor.handleWebviewMessage(message as any);
			}
		};

		for (const queuedMessage of queuedWebviewMessages.splice(0)) {
			fileOpenTrace.mark('webview.message.flushQueued', { type: queuedMessage.type });
			await runIncomingWebviewMessage(queuedMessage);
		}

		// Do not push document contents automatically.
		// The webview asks for the initial document explicitly (requestDocument).
	}
}

