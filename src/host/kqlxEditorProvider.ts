import * as vscode from 'vscode';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import * as lockfile from 'proper-lockfile';

import { ConnectionManager } from './connectionManager';
import { QueryEditorProvider } from './queryEditorProvider';
import type { SqlWorkbenchService } from './sql/sqlWorkbenchService';
import { EditorCursorStatusBar } from './editorCursorStatusBar';
import { overlayKqlxFileState, parseKqlxText, stringifyKqlxFile, type KqlxFileKind, type KqlxFileV1, type KqlxSectionV1, type KqlxStateV1 } from './kqlxFormat';
import { getKqlxPreservedEnvelope, KqlxOverlayConflictError } from './kqlxOverlay';
import { renderDiffInWebview, DIFF_NOISE_KEYS, COMPARISON_NOISE_KEYS } from './diffViewerUtils';
import type { SectionChangeInfo } from './queryEditorTypes';
import { perfBegin, perfMark } from './perfTrace';
import { kustoClusterKey } from '../shared/kustoClusterUrls';
import { getKustoConnectionIdentityKey, normalizeKustoAuthorityId } from '../shared/kustoAuth';
import { getWorkbenchLogger } from './workbenchLogger';
import { createFileOpenTrace } from './fileOpenTrace';
import { normalizeWorkbenchUriKey } from './workbenchFileTypes';
import { CompatSidecarSession } from './compatSidecarSession';
import { publishOwnedFileText } from './ownedFilePublication';
import {
	addableSectionKindsForDocument,
	assertDocumentSectionKindsAllowed,
	canonicalAddableSectionKind,
	canonicalSectionKind,
	defaultSectionKindForDocument,
} from '../shared/documentSectionCapabilities';
import { getUnsupportedNativeDocumentReason } from '../shared/nativeDocumentValidation';
import {
	MarkdownDocumentAggregate,
	type MarkdownDocumentCommand,
} from '../shared/markdownDocumentAggregate';


const normalizeClusterUrlKey = (url: string): string => {
	return kustoClusterKey(url);
};

const NON_PERSISTENCE_CLOSE_WAIT_MS = 2_000;
const NATIVE_SAVE_COMMIT_LEASE_TIMEOUT_MS = 5_000;
const INITIAL_PROJECTION_MAX_ATTEMPTS = 4;
const LINKED_NATIVE_SAVE_RECONCILE_MS = 1_000;
const PLAIN_LINKED_QUERY_EXTENSIONS = ['.kql', '.csl'] as const;

const escapeHtmlText = (value: unknown): string => String(value ?? '')
	.replace(/&/g, '&amp;')
	.replace(/</g, '&lt;')
	.replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;')
	.replace(/'/g, '&#39;');

export function resolveLinkedQueryUri(documentUri: vscode.Uri, linkedPath: string): vscode.Uri {
	if (/^file:\/\//i.test(linkedPath)) return vscode.Uri.parse(linkedPath);
	if (/^[a-zA-Z]:[\\/]/.test(linkedPath) || path.win32.isAbsolute(linkedPath) || path.posix.isAbsolute(linkedPath)) {
		return vscode.Uri.file(linkedPath);
	}
	return documentUri.with({ path: path.posix.normalize(path.posix.join(path.posix.dirname(documentUri.path), linkedPath)) });
}

function getUnsafeLinkedQueryReason(documentUri: vscode.Uri, state: KqlxStateV1): string | undefined {
	const unsupportedSqlLink = getUnsupportedNativeDocumentReason(state);
	if (unsupportedSqlLink) return unsupportedSqlLink;
	for (const section of state.sections) {
		const sectionRecord = section as Record<string, unknown>;
		const linkedPath = typeof sectionRecord.linkedQueryPath === 'string' ? sectionRecord.linkedQueryPath.trim() : '';
		if (canonicalSectionKind(section.type) !== 'query') continue;
		if (!linkedPath) continue;
		const target = resolveLinkedQueryUri(documentUri, linkedPath);
		if (normalizeWorkbenchUriKey(target) === normalizeWorkbenchUriKey(documentUri)) {
			return 'A linked query cannot target the notebook itself.';
		}
		const targetPath = String(target.path || '').toLowerCase();
		if (!PLAIN_LINKED_QUERY_EXTENSIONS.some(extension => targetPath.endsWith(extension))) {
			return 'Linked queries must target a plain .kql or .csl file.';
		}
	}
	return undefined;
}

async function samePhysicalLocalFile(left: vscode.Uri, right: vscode.Uri): Promise<boolean> {
	if (normalizeWorkbenchUriKey(left) === normalizeWorkbenchUriKey(right)) return true;
	if (left.scheme !== 'file' || right.scheme !== 'file') return false;
	try {
		const [leftRealPath, rightRealPath] = await Promise.all([
			fs.promises.realpath(left.fsPath),
			fs.promises.realpath(right.fsPath),
		]);
		if (normalizeWorkbenchUriKey(vscode.Uri.file(leftRealPath))
			=== normalizeWorkbenchUriKey(vscode.Uri.file(rightRealPath))) return true;
		const [leftStat, rightStat] = await Promise.all([
			fs.promises.stat(leftRealPath),
			fs.promises.stat(rightRealPath),
		]);
		return leftStat.dev === rightStat.dev && leftStat.ino !== 0 && leftStat.ino === rightStat.ino;
	} catch {
		return false;
	}
}

type LocalFileIdentity = Readonly<{ realPathKey: string; device: number; inode: number }>;

async function getLocalFileIdentity(uri: vscode.Uri): Promise<LocalFileIdentity | undefined> {
	if (uri.scheme !== 'file') return undefined;
	try {
		const realPath = await fs.promises.realpath(uri.fsPath);
		const stat = await fs.promises.stat(realPath);
		return {
			realPathKey: normalizeWorkbenchUriKey(vscode.Uri.file(realPath)),
			device: stat.dev,
			inode: stat.ino,
		};
	} catch {
		return undefined;
	}
}

function localFileIdentityEquals(left: LocalFileIdentity | undefined, right: LocalFileIdentity | undefined): boolean {
	if (!left || !right) return false;
	if (left.inode !== 0 && right.inode !== 0) {
		return left.device === right.device && left.inode === right.inode;
	}
	return left.realPathKey === right.realPathKey;
}

async function getUnsafeLinkedQueryReasonFresh(documentUri: vscode.Uri, state: KqlxStateV1): Promise<string | undefined> {
	const structuralReason = getUnsafeLinkedQueryReason(documentUri, state);
	if (structuralReason) return structuralReason;
	for (const section of state.sections) {
		if (canonicalSectionKind(section.type) !== 'query') continue;
		const sectionRecord = section as Record<string, unknown>;
		const linkedPath = typeof sectionRecord.linkedQueryPath === 'string' ? sectionRecord.linkedQueryPath.trim() : '';
		if (!linkedPath) continue;
		if (await samePhysicalLocalFile(documentUri, resolveLinkedQueryUri(documentUri, linkedPath))) {
			return 'A linked query cannot target the notebook itself.';
		}
	}
	return undefined;
}
const PERSISTENCE_CLOSE_WAIT_MS = 50_000;

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
		const sourceBoxId = String((section as { comparisonSourceBoxId?: string }).comparisonSourceBoxId || '').trim();
		return !!sourceBoxId && sectionTypesById.get(sourceBoxId) === 'sql';
	});
}

export function shouldReloadKqlxAfterDocumentChange(options: {
	isSessionFile: boolean;
	matchesOwnedSessionWrite: boolean;
	matchesOwnedDocumentEdit: boolean;
	webviewInitialized: boolean;
	contentChangeCount: number;
}): boolean {
	if (!options.webviewInitialized || options.contentChangeCount === 0) return false;
	if (options.isSessionFile) return !options.matchesOwnedSessionWrite;
	return !options.matchesOwnedDocumentEdit;
}

export class OwnedDocumentEditTracker {
	private readonly pending = new Map<string, number>();
	constructor(private readonly keyOf: (text: string) => string = text => text) {}

	begin(text: string): void {
		const key = this.keyOf(text);
		this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
	}

	cancel(text: string): void {
		const key = this.keyOf(text);
		const count = this.pending.get(key) ?? 0;
		if (count <= 1) this.pending.delete(key);
		else this.pending.set(key, count - 1);
	}

	observe(text: string): boolean {
		if (!this.pending.has(this.keyOf(text))) return false;
		this.cancel(text);
		return true;
	}
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
				Object.defineProperty(result, k, {
					value: normalized, enumerable: true, configurable: true, writable: true,
				});
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
const normalizeSectionWithNoise = (
	section: unknown,
	noiseKeys: ReadonlySet<string>,
): Record<string, unknown> | undefined => {
	if (!section || typeof section !== 'object') {
		return undefined;
	}

	const s = section as Record<string, unknown>;
	const type = String(s.type ?? '');
	
	const normalizedType = canonicalSectionKind(type) ?? type;
	
	// Collect all normalized properties first, skipping ephemeral UI-state
	// keys (pixel dimensions, visibility toggles, cached results) so that
	// layout-only changes never mark a section as modified.
	const raw: Record<string, unknown> = Object.create(null);
	for (const [key, value] of Object.entries(s)) {
		if (key === 'type') continue; // Handled separately
		if (noiseKeys.has(key)) continue; // Ephemeral UI state (heights kept for persistence)
		if (__kustoIsImplicitSectionDefault(key, value)) continue;
		const normalized = normalizeValue(value, key);
		if (normalized !== undefined) {
			Object.defineProperty(raw, key, {
				value: normalized, enumerable: true, configurable: true, writable: true,
			});
		}
	}

	// Build the result with a canonical key order so diffs are readable:
	// type → id → title → clusterUrl → database → content key → expanded → everything else (sorted)
	const contentKeys = ['query', 'text', 'code', 'url'];
	const preferredOrder = ['id', 'title', 'clusterUrl', 'database'];
	const result: Record<string, unknown> = Object.create(null);
	Object.defineProperty(result, 'type', {
		value: normalizedType, enumerable: true, configurable: true, writable: true,
	});

	for (const key of preferredOrder) {
		if (Object.prototype.hasOwnProperty.call(raw, key)) { Object.defineProperty(result, key, { value: raw[key], enumerable: true, configurable: true, writable: true }); }
	}
	for (const key of contentKeys) {
		if (Object.prototype.hasOwnProperty.call(raw, key)) { Object.defineProperty(result, key, { value: raw[key], enumerable: true, configurable: true, writable: true }); }
	}
	if (Object.prototype.hasOwnProperty.call(raw, 'expanded')) { Object.defineProperty(result, 'expanded', { value: raw.expanded, enumerable: true, configurable: true, writable: true }); }

	// Remaining keys in sorted order.
	const placed = new Set([...preferredOrder, ...contentKeys, 'expanded']);
	for (const key of Object.keys(raw).sort()) {
		if (!placed.has(key)) { Object.defineProperty(result, key, { value: raw[key], enumerable: true, configurable: true, writable: true }); }
	}

	return result;
};

export const normalizeSection = (section: unknown): Record<string, unknown> | undefined =>
	normalizeSectionWithNoise(section, COMPARISON_NOISE_KEYS);

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

	const stateExtensions: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(s)) {
		if (key === 'sections' || key === 'caretDocsEnabled' || key === 'autoTriggerAutocompleteEnabled') continue;
		const normalized = normalizeValue(value, key);
		if (normalized !== undefined) stateExtensions[key] = normalized;
	}

	return {
		...stateExtensions,
		caretDocsEnabled: typeof s.caretDocsEnabled === 'boolean' ? s.caretDocsEnabled : true,
		...(typeof s.autoTriggerAutocompleteEnabled === 'boolean'
			? { autoTriggerAutocompleteEnabled: s.autoTriggerAutocompleteEnabled }
			: {}),
		sections
	};
};

const clonePersistenceComparable = (
	value: unknown,
	seen = new WeakMap<object, unknown>(),
): unknown => {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
		return undefined;
	}
	if (typeof value !== 'object') return value;
	const existing = seen.get(value);
	if (existing !== undefined) return existing;
	if (Array.isArray(value)) {
		const result: unknown[] = [];
		seen.set(value, result);
		for (const item of value) result.push(clonePersistenceComparable(item, seen) ?? null);
		return result;
	}
	const result: Record<string, unknown> = {};
	seen.set(value, result);
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		const cloned = clonePersistenceComparable(item, seen);
		if (cloned === undefined) continue;
		Object.defineProperty(result, key, {
			value: cloned, enumerable: true, configurable: true, writable: true,
		});
	}
	return result;
};

const normalizeStateForPersistenceComparison = (state: KqlxStateV1): Record<string, unknown> =>
	clonePersistenceComparable(state) as Record<string, unknown>;

export const normalizeKqlxFileForComparison = (
	file: KqlxFileV1,
	state: KqlxStateV1 = file.state,
): Record<string, unknown> => {
	return {
		kind: file.kind,
		version: file.version,
		knownState: normalizeStateForComparison(state),
		preserved: getKqlxPreservedEnvelope(file, state),
	};
};

export const normalizeKqlxFileForPersistenceComparison = (
	file: KqlxFileV1,
	state: KqlxStateV1 = file.state,
): Record<string, unknown> => ({
	kind: file.kind,
	version: file.version,
	knownState: normalizeStateForPersistenceComparison(state),
	preserved: getKqlxPreservedEnvelope(file, state),
});

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
	| { type: 'persistDocument'; state: KqlxStateV1; sourceGeneration?: number; flush?: boolean; flushRequestId?: string; flushUnavailableReason?: string }
	| { type: 'markdownDocumentCommand'; commandId: string; sourceGeneration: number; expectedDocumentRevision: number; command: MarkdownDocumentCommand }
	| { type: 'markdownDocumentCommandBarrierResult'; requestId: string; sourceGeneration: number; documentRevision: number; accepted: boolean }
	| { type: string; [key: string]: unknown };

type MarkdownPersistenceLease = {
	generation: number;
	baseText: string;
	revoked: boolean;
	revocationAuthority?: Readonly<{ generation: number; sourceText: string }>;
	revoke(authority: Readonly<{ generation: number; sourceText: string }>): void;
	settle(): void;
};

type MarkdownDocumentOwnerEntry = {
	document: MarkdownDocumentAggregate;
	sourceText: string;
	queue: MarkdownDocumentOwnerQueue;
};

type MarkdownDocumentOwnerQueue = {
	tail: Promise<void>;
	pendingCommands: number;
	activePersistenceLeases: Set<MarkdownPersistenceLease>;
};

type MarkdownPanelOwnerRegistration = {
	owner?: MarkdownDocumentOwnerEntry;
	requestProjection(): void;
};

type MarkdownSaveLease = {
	owner?: MarkdownDocumentOwnerEntry;
	sourceGeneration: number;
	settle(): void;
};

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
		allowedKinds: [kind],
		defaultKind: kind,
	});
	if (!parsed.ok) {
		throw new Error(`Cannot publish a malformed Kusto Workbench document because its SQL privacy state cannot be verified. ${parsed.error}`);
	}
	const unsupportedLinkedSectionReason = getUnsupportedNativeDocumentReason(parsed.file.state);
	if (unsupportedLinkedSectionReason) {
		throw new Error(`Cannot publish an unsupported linked section. ${unsupportedLinkedSectionReason}`);
	}
	return publishStateFresh(parsed.file.state, async sanitizedState => {
		assertDocumentSectionKindsAllowed(kind, sanitizedState.sections);
		const file = overlayKqlxFileState(
			parsed.file,
			sanitizedState,
			kind,
		);
		const unsupportedSanitizedLink = getUnsupportedNativeDocumentReason(file.state);
		if (unsupportedSanitizedLink) {
			throw new Error(`Cannot publish an unsupported linked section. ${unsupportedSanitizedLink}`);
		}
		const serialized = stringifyKqlxFile(file);
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
	private readonly markdownDocuments = new Map<string, MarkdownDocumentOwnerEntry>();
	private readonly markdownDocumentQueues = new Map<string, MarkdownDocumentOwnerQueue>();
	private readonly markdownPanelOwners = new Map<string, Map<vscode.WebviewPanel, MarkdownPanelOwnerRegistration>>();

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

	private static isNativeSaveCoordinator(uri: vscode.Uri, panel: vscode.WebviewPanel): boolean {
		const panels = KqlxEditorProvider.openPanelsByUri.get(KqlxEditorProvider.panelKey(uri));
		return !panels?.size || [...panels].at(-1) === panel;
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
		const hasActiveEditor = () => KqlxEditorProvider.hasOpenOrClosingEditors(uri);
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

	private static hasOpenOrClosingEditors(uri: vscode.Uri): boolean {
		const key = KqlxEditorProvider.panelKey(uri);
		return !!KqlxEditorProvider.openPanelsByUri.get(key)?.size
			|| !!KqlxEditorProvider.closingEditorsByUri.get(key)?.size;
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
			supportsMultipleEditorsPerDocument: false,
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
	) {
		this.context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
			const key = normalizeWorkbenchUriKey(document.uri);
			const entry = this.markdownDocuments.get(key);
			const queue = this.markdownDocumentQueues.get(key);
			if (!entry && !queue) return;
			void (async () => {
				if (!await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, PERSISTENCE_CLOSE_WAIT_MS)) return;
				while (queue && this.markdownDocumentQueues.get(key) === queue) {
					const observedTail = queue.tail;
					await observedTail.catch(() => undefined);
					if (queue.tail !== observedTail) continue;
					if (KqlxEditorProvider.hasOpenOrClosingEditors(document.uri)) return;
					if (this.markdownDocuments.get(key) === entry) this.markdownDocuments.delete(key);
					if (this.markdownDocumentQueues.get(key) === queue) this.markdownDocumentQueues.delete(key);
					return;
				}
			})();
		}));
	}

	private async readProjectionSourceTextForDocument(
		document: vscode.TextDocument,
		isSessionFile: boolean,
	): Promise<string> {
		if (!isSessionFile) return document.getText();
		try {
			return new TextDecoder().decode(await vscode.workspace.fs.readFile(document.uri));
		} catch {
			return document.getText();
		}
	}

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
		const initialParse = parseKqlxText(document.getText(), {
			allowedKinds: [documentKindForPerf],
			defaultKind: documentKindForPerf,
		});
		const unsafeLinkedQueryReason = initialParse.ok
			? await getUnsafeLinkedQueryReasonFresh(document.uri, initialParse.file.state)
			: undefined;
		if (!initialParse.ok || unsafeLinkedQueryReason) {
			webviewPanel.webview.options = { enableScripts: false };
			const reason = initialParse.ok ? unsafeLinkedQueryReason : initialParse.error;
			webviewPanel.webview.html = `<h2>Invalid Kusto Workbench file</h2><p>${escapeHtmlText(reason)}</p><p>Read-only to prevent data loss. Open with the Text Editor to repair.</p>`;
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
		let delayedBeforeUnloadAdmissionOpen = true;
		let retireMarkdownPanelOwner = () => undefined;
		const isDelayedSessionPersistenceMessage = (message: IncomingWebviewMessage): boolean =>
			outerDisposed && delayedBeforeUnloadAdmissionOpen && !closeFinalizationAbandoned
			&& isSessionFile && (
				(message.type === 'persistDocument' && String((message as any).reason || '') === 'beforeunload')
				|| message.type === 'markdownDocumentCommand'
			);
		const runIncomingWebviewMessage = (message: IncomingWebviewMessage): Promise<void> => {
			const handler = handleIncomingWebviewMessage;
			const delayedSessionPersistence = isDelayedSessionPersistenceMessage(message);
			if (!handler || (outerDisposed && !delayedSessionPersistence)) return Promise.resolve();
			let settleAdmission!: () => void;
			const admission = new Promise<void>(resolve => { settleAdmission = resolve; });
			admittedWebviewHandlers.add(admission);
			const persistenceCritical = message.type === 'persistDocument'
				|| message.type === 'requestDocument'
				|| message.type === 'markdownDocumentCommand';
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
			const delayedSessionPersistence = message && typeof message.type === 'string'
				&& isDelayedSessionPersistenceMessage(message);
			if ((outerDisposed && !delayedSessionPersistence) || !message || typeof message.type !== 'string') {
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
		const deliverWebviewMessage = async (message: unknown): Promise<boolean> => {
			if (outerDisposed) return false;
			try {
				return await Promise.resolve(webviewPanel.webview.postMessage(message)) !== false;
			} catch {
				return false;
			}
		};
		const outerDisposalSubscription = webviewPanel.onDidDispose(() => {
			outerDisposed = true;
			retireMarkdownPanelOwner();
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
		const allowedSectionKinds = addableSectionKindsForDocument(documentKind);
		const defaultSectionKind = defaultSectionKindForDocument(documentKind);

		// If we were just upgraded from a single-section format to a rich format as part of an add-section action,
		// grab the pending add kind now and notify the webview once it is initialized.
		let pendingAddKind = '';
		try {
			const k = this.context.workspaceState.get<string>(KqlxEditorProvider.pendingAddKindKeyForUri(document.uri));
			if (typeof k === 'string') {
				pendingAddKind = canonicalAddableSectionKind(documentKind, k) ?? '';
			}
		} catch {
			// ignore
		}

		const sessionUri = vscode.Uri.joinPath(this.context.globalStorageUri, 'session.kqlx');
		const isSessionFile = (() => {
			return normalizeWorkbenchUriKey(document.uri) === normalizeWorkbenchUriKey(sessionUri);
		})();
		const readProjectionSourceText = (): Promise<string> =>
			this.readProjectionSourceTextForDocument(document, isSessionFile);
		const isProjectionSourceCurrent = async (text: string): Promise<boolean> =>
			(await readProjectionSourceText()) === text;

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
		let lastSavedIdentity = await getLocalFileIdentity(document.uri);
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
					allowedKinds: [documentKind],
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
		type LinkedQuerySectionIdentity = { type: 'query'; id: string; occurrence: number };
		type LinkedQueryDescriptor = { uri: vscode.Uri; path: string; identity: LinkedQuerySectionIdentity };
		let linkedQuerySectionIdentity: LinkedQuerySectionIdentity | undefined;
		let linkedQueryLoadGeneration = 0;
		let postDocumentGeneration = 0;
		let activeProjectionGeneration = 0;
		let activeProjectionSourceText = document.getText();
		let linkedQueryDocument: vscode.TextDocument | undefined;
		let lastSavedLinkedQueryText = '';
		let hydratedLinkedQueryText: string | undefined;
		let linkedContentRevision = 0;
		let linkedQueryHydrationFailed = false;
		let linkedQueryPhysicalIdentity: LocalFileIdentity | undefined;
		let linkedWriteTail: Promise<void> = Promise.resolve();
		let linkedRollbackFailed = false;
		const sameLinkedUri = (left: vscode.Uri | undefined, right: vscode.Uri | undefined): boolean => !!left && !!right
			&& normalizeWorkbenchUriKey(left) === normalizeWorkbenchUriKey(right);
		const sameLinkedText = (left: string, right: string) => left.replace(/\r\n?/g, '\n') === right.replace(/\r\n?/g, '\n');
		const setHydratedLinkedQueryText = (text: string | undefined): void => {
			const changed = hydratedLinkedQueryText === undefined || text === undefined
				? hydratedLinkedQueryText !== text
				: !sameLinkedText(hydratedLinkedQueryText, text);
			hydratedLinkedQueryText = text;
			if (changed) linkedContentRevision++;
		};
		// Track the last text we wrote directly to disk for session files.
		// Pending identities suppress each matching document event even when writes are observed out of order.
		const ownedSessionWrites = new OwnedSessionWriteTracker(isSessionFile ? lastSavedText : '');

		const sectionIdentityAt = (sections: readonly KqlxSectionV1[], targetIndex: number): LinkedQuerySectionIdentity | undefined => {
			const target = sections[targetIndex] as any;
			const rawType = String(target?.type || '');
			if (canonicalSectionKind(rawType) !== 'query') return undefined;
			const type = 'query' as const;
			const id = String(target?.id || '').trim();
			let occurrence = 0;
			for (let index = 0; index < targetIndex; index++) {
				const candidate = sections[index] as any;
				const candidateType = String(candidate?.type || '');
				if (canonicalSectionKind(candidateType) === 'query'
					&& String(candidate?.id || '').trim() === id) occurrence++;
			}
			return { type, id, occurrence };
		};
		const findLinkedQuerySectionIndex = (
			sections: readonly KqlxSectionV1[],
			identity: LinkedQuerySectionIdentity | undefined = linkedQuerySectionIdentity,
		): number => {
			if (!identity) return -1;
			let occurrence = 0;
			for (let index = 0; index < sections.length; index++) {
				const candidate = sections[index] as any;
				const candidateType = String(candidate?.type || '');
				if (canonicalSectionKind(candidateType) !== 'query'
					|| String(candidate?.id || '').trim() !== identity.id) continue;
				if (occurrence === identity.occurrence) return index;
				occurrence++;
			}
			return -1;
		};
		const withLinkedQueryText = (state: KqlxStateV1, query: string): KqlxStateV1 => {
			const sections = Array.isArray(state.sections) ? state.sections : [];
			const index = findLinkedQuerySectionIndex(sections);
			if (index < 0) return state;
			const nextSections = [...sections];
			nextSections[index] = { ...(sections[index] as any), query };
			return { ...state, sections: nextSections };
		};
		const getLinkedQueryDescriptorFromState = (state: KqlxStateV1): LinkedQueryDescriptor | undefined => {
			try {
				const sections = Array.isArray(state.sections) ? state.sections : [];
				const linkedIndex = sections.findIndex(section => {
					const candidate = section as any;
					const type = String(candidate?.type || '');
					return canonicalSectionKind(type) === 'query' && !!String(candidate?.linkedQueryPath || '').trim();
				});
				if (linkedIndex < 0) return undefined;
				const linked = String((sections[linkedIndex] as any).linkedQueryPath).trim();
				const identity = sectionIdentityAt(sections, linkedIndex);
				return identity ? { uri: resolveLinkedQueryUri(document.uri, linked), path: linked, identity } : undefined;
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
		const withOwnedFileLock = async <T>(
			uri: vscode.Uri,
			work: () => Promise<T>,
			expectedIdentity?: LocalFileIdentity,
		): Promise<T> => {
			if (uri.scheme !== 'file') return work();
			const identity = expectedIdentity ?? await getLocalFileIdentity(uri);
			const identityKey = identity && identity.inode !== 0
				? `inode:${identity.device}:${identity.inode}`
				: `path:${identity?.realPathKey ?? normalizeWorkbenchUriKey(uri)}`;
			const digest = createHash('sha256').update(identityKey).digest('hex');
			const lockTarget = path.join(os.tmpdir(), 'vscode-kusto-workbench-document-locks', `${digest}.write`);
			await fs.promises.mkdir(path.dirname(lockTarget), { recursive: true });
			const release = await lockfile.lock(lockTarget, {
				realpath: false,
				stale: 30_000,
				update: 5_000,
				retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 25 },
			});
			try {
				return await work();
			} finally {
				await release();
			}
		};
		const writeOwnedLocalFileText = async (
			uri: vscode.Uri,
			identity: LocalFileIdentity,
			expectedText: string,
			nextText: string,
		): Promise<boolean> => withOwnedFileLock(uri, async () => {
			if (!localFileIdentityEquals(identity, await getLocalFileIdentity(uri))) return false;
			const handle = await fs.promises.open(uri.fsPath, 'r+');
			try {
				const stat = await handle.stat();
				if (stat.dev !== identity.device || (identity.inode !== 0 && stat.ino !== identity.inode)) return false;
				await publishOwnedFileText(handle, identity, expectedText, nextText);
			} finally {
				await handle.close();
			}
			if (!localFileIdentityEquals(identity, await getLocalFileIdentity(uri))) return false;
			return await tryReadTextFile(uri) === nextText;
		}, identity);

		const getOrOpenLinkedQueryDocument = async (uri: vscode.Uri | undefined = linkedQueryUri): Promise<vscode.TextDocument | undefined> => {
			try {
				if (!uri) {
					return undefined;
				}
				if (uri.scheme !== 'file') {
					return undefined;
				}
				if (linkedQueryDocument && sameLinkedUri(linkedQueryDocument.uri, uri)) {
					return linkedQueryDocument;
				}
				linkedQueryDocument = undefined;
				const existing = vscode.workspace.textDocuments.find((d) => sameLinkedUri(d.uri, uri));
				if (existing) {
					linkedQueryDocument = existing;
					return existing;
				}
				const opened = await vscode.workspace.openTextDocument(uri);
				if (sameLinkedUri(linkedQueryUri, uri)) linkedQueryDocument = opened;
				return opened;
			} catch {
				return undefined;
			}
		};

		const runWithLinkedWriteLease = async <T>(work: () => Promise<T>): Promise<T> => {
			const previousLinkedWrite = linkedWriteTail;
			let releaseLinkedWrite!: () => void;
			const linkedWrite = new Promise<void>(resolve => { releaseLinkedWrite = resolve; });
			linkedWriteTail = previousLinkedWrite.catch(() => undefined).then(() => linkedWrite);
			await previousLinkedWrite.catch(() => undefined);
			try {
				return await work();
			} finally {
				releaseLinkedWrite();
			}
		};

		const applyLinkedQueryTextWithinLease = async (
			text: string,
			isRequestCurrent: () => boolean = () => true,
		): Promise<boolean> => {
			try {
				const generation = linkedQueryLoadGeneration;
				const uri = linkedQueryUri;
				const expectedText = hydratedLinkedQueryText;
				const expectedPhysicalIdentity = linkedQueryPhysicalIdentity;
				if (!isRequestCurrent() || closeFinalizationAbandoned || linkedQueryHydrationFailed
					|| !uri || expectedText === undefined || generation !== postDocumentGeneration) return false;
				if (uri.scheme !== 'file') return text === expectedText;
				if (!expectedPhysicalIdentity) return false;
				if (await samePhysicalLocalFile(document.uri, uri)
					|| !localFileIdentityEquals(expectedPhysicalIdentity, await getLocalFileIdentity(uri))) return false;
				const linkedDoc = await getOrOpenLinkedQueryDocument(uri);
				if (!linkedDoc || !isRequestCurrent()) {
					return false;
				}
				const ownerIsCurrent = () => isRequestCurrent()
					&& !closeFinalizationAbandoned
					&& !linkedQueryHydrationFailed
					&& linkedQueryLoadGeneration === generation
					&& postDocumentGeneration === generation
					&& sameLinkedUri(linkedQueryUri, uri)
					&& localFileIdentityEquals(linkedQueryPhysicalIdentity, expectedPhysicalIdentity)
					&& hydratedLinkedQueryText === expectedText;
				if (!ownerIsCurrent()) return false;
				if (await samePhysicalLocalFile(document.uri, uri)
					|| !localFileIdentityEquals(expectedPhysicalIdentity, await getLocalFileIdentity(uri))) return false;
				const current = linkedDoc.getText();
				const wasDirty = linkedDoc.isDirty;
				if (!sameLinkedText(current, expectedText) && !sameLinkedText(current, text)) {
					return false;
				}
				if (sameLinkedText(current, text)) {
					setHydratedLinkedQueryText(current);
					return true;
				}
				const fullRange = new vscode.Range(
					linkedDoc.positionAt(0),
					linkedDoc.positionAt(current.length)
				);
				const edit = new vscode.WorkspaceEdit();
				edit.replace(linkedDoc.uri, fullRange, text);
				if (!ownerIsCurrent()) return false;
				const applied = await vscode.workspace.applyEdit(edit);
				if (!applied) return false;
				await new Promise<void>(resolve => setImmediate(resolve));
				const appliedText = linkedDoc.getText();
				if (!sameLinkedText(appliedText, text)) {
					// A different value means a newer direct edit won the race; never overwrite it.
					return false;
				}
				const physicalIdentityIsCurrent = !await samePhysicalLocalFile(document.uri, uri)
					&& localFileIdentityEquals(expectedPhysicalIdentity, await getLocalFileIdentity(uri));
				if (!ownerIsCurrent() || !physicalIdentityIsCurrent) {
					if (sameLinkedText(appliedText, text)) {
						for (let rollbackAttempt = 0; rollbackAttempt < 3; rollbackAttempt++) {
							if (!sameLinkedText(linkedDoc.getText(), text)) break;
							const rollback = new vscode.WorkspaceEdit();
							rollback.replace(
								linkedDoc.uri,
								new vscode.Range(linkedDoc.positionAt(0), linkedDoc.positionAt(linkedDoc.getText().length)),
								current,
							);
							await vscode.workspace.applyEdit(rollback);
							if (linkedDoc.getText() === current) break;
						}
						if (linkedDoc.getText() !== current) {
							linkedRollbackFailed = true;
							getWorkbenchLogger().warn('[kusto] Failed to roll back a stale linked-query edit.');
						} else if (!wasDirty && !await samePhysicalLocalFile(document.uri, uri)
							&& localFileIdentityEquals(expectedPhysicalIdentity, await getLocalFileIdentity(uri))) {
							const durableText = await tryReadTextFile(uri);
							const restored = durableText === current || (durableText === text
								&& await writeOwnedLocalFileText(uri, expectedPhysicalIdentity, text, current));
							const saved = restored && (!linkedDoc.isDirty || await linkedDoc.save());
							if (!saved || await tryReadTextFile(uri) !== current
								|| !localFileIdentityEquals(expectedPhysicalIdentity, await getLocalFileIdentity(uri))) {
								linkedRollbackFailed = true;
								getWorkbenchLogger().warn('[kusto] Failed to durably save a rolled-back linked-query edit.');
							}
						}
					}
					return false;
				}
				setHydratedLinkedQueryText(appliedText);
				return true;
			} catch {
				return false;
			}
		};

		const applyLinkedQueryTextToDocument = (
			text: string,
			isRequestCurrent: () => boolean = () => true,
		): Promise<boolean> => runWithLinkedWriteLease(
			() => applyLinkedQueryTextWithinLease(text, isRequestCurrent),
		);
		const saveCurrentLinkedQueryDocument = async (): Promise<boolean> => {
			if (linkedRollbackFailed) return false;
			const targetDocument = linkedQueryDocument;
			const targetUri = linkedQueryUri;
			const targetIdentity = linkedQueryPhysicalIdentity;
			const targetGeneration = linkedQueryLoadGeneration;
			if (!targetDocument) return false;
			await linkedWriteTail.catch(() => undefined);
			if (!targetUri || !targetIdentity
				|| linkedQueryDocument !== targetDocument
				|| !sameLinkedUri(targetDocument.uri, targetUri)
				|| linkedQueryLoadGeneration !== targetGeneration
				|| !sameLinkedUri(linkedQueryUri, targetUri)
				|| !localFileIdentityEquals(linkedQueryPhysicalIdentity, targetIdentity)
				|| await samePhysicalLocalFile(document.uri, targetUri)
				|| !localFileIdentityEquals(targetIdentity, await getLocalFileIdentity(targetUri))) return false;
			const expectedText = targetDocument.getText();
			const durableBeforeSave = await tryReadTextFile(targetUri);
			if (durableBeforeSave === undefined || durableBeforeSave !== lastSavedLinkedQueryText) return false;
			if (durableBeforeSave !== expectedText
				&& !await writeOwnedLocalFileText(targetUri, targetIdentity, durableBeforeSave, expectedText)) return false;
			if (!sameLinkedText(targetDocument.getText(), expectedText)
				|| !localFileIdentityEquals(targetIdentity, await getLocalFileIdentity(targetUri))) return false;
			const durableText = await tryReadTextFile(targetUri);
			if (durableText !== expectedText) return false;
			lastSavedLinkedQueryText = expectedText;
			return true;
		};
		const restoreLinkedSaveSnapshot = async (
			uri: vscode.Uri,
			identity: LocalFileIdentity | undefined,
			targetDocument: vscode.TextDocument | undefined,
			candidateText: string,
			priorBufferText: string | undefined,
			priorDurableText: string | undefined,
		): Promise<boolean> => {
			if (!identity || !targetDocument || priorBufferText === undefined || priorDurableText === undefined
				|| !localFileIdentityEquals(identity, await getLocalFileIdentity(uri))) return false;
			let durableRestored = false;
			const currentDurableText = await tryReadTextFile(uri);
			if (currentDurableText === priorDurableText) {
				durableRestored = true;
			} else if (currentDurableText === candidateText) {
				durableRestored = await writeOwnedLocalFileText(uri, identity, candidateText, priorDurableText)
					.then(async () => await tryReadTextFile(uri) === priorDurableText, () => false);
			}
			let bufferRestored = !sameLinkedText(targetDocument.getText(), candidateText);
			if (!bufferRestored) {
				const bufferRollback = new vscode.WorkspaceEdit();
				bufferRollback.replace(
					targetDocument.uri,
					new vscode.Range(targetDocument.positionAt(0), targetDocument.positionAt(targetDocument.getText().length)),
					priorBufferText,
				);
				bufferRestored = await vscode.workspace.applyEdit(bufferRollback)
					&& sameLinkedText(targetDocument.getText(), priorBufferText);
			}
			const restored = durableRestored && bufferRestored
				&& localFileIdentityEquals(identity, await getLocalFileIdentity(uri));
			if (durableRestored && sameLinkedUri(linkedQueryUri, uri)
				&& linkedQueryDocument === targetDocument
				&& localFileIdentityEquals(linkedQueryPhysicalIdentity, identity)) {
				lastSavedLinkedQueryText = priorDurableText;
				setHydratedLinkedQueryText(targetDocument.getText());
				if (restored) linkedRollbackFailed = false;
			}
			return restored;
		};
		type LinkedContentOwner = {
			uri: vscode.Uri;
			identity: LocalFileIdentity;
			document: vscode.TextDocument;
			loadGeneration: number;
			contentRevision: number;
			bufferText: string;
			hydratedText: string;
			lastSavedText: string;
		};
		type LinkedSaveTransaction = {
			uri: vscode.Uri;
			identity: LocalFileIdentity;
			document: vscode.TextDocument;
			candidateText: string;
			priorBufferText: string;
			priorDurableText: string;
			notebookCandidateText: string;
			notebookPriorDurableText: string;
		};
		type PendingLinkedNativeSave = LinkedSaveTransaction & {
			rollbackContentRevision?: number;
		};
		type LinkedSaveAttempt =
			| { ok: true; transaction: Omit<LinkedSaveTransaction, 'notebookCandidateText' | 'notebookPriorDurableText'> }
			| { ok: false; reason: 'owner-changed' | 'durable-changed' | 'update-failed' | 'save-failed' };
		const captureLinkedContentOwner = (): LinkedContentOwner | undefined => {
			if (!linkedQueryUri || !linkedQueryPhysicalIdentity || !linkedQueryDocument
				|| hydratedLinkedQueryText === undefined) return undefined;
			return {
				uri: linkedQueryUri,
				identity: linkedQueryPhysicalIdentity,
				document: linkedQueryDocument,
				loadGeneration: linkedQueryLoadGeneration,
				contentRevision: linkedContentRevision,
				bufferText: linkedQueryDocument.getText(),
				hydratedText: hydratedLinkedQueryText,
				lastSavedText: lastSavedLinkedQueryText,
			};
		};
		const linkedContentTargetIsCurrent = (owner: LinkedContentOwner): boolean =>
			linkedQueryDocument === owner.document
			&& sameLinkedUri(linkedQueryUri, owner.uri)
			&& linkedQueryLoadGeneration === owner.loadGeneration
			&& postDocumentGeneration === owner.loadGeneration
			&& localFileIdentityEquals(linkedQueryPhysicalIdentity, owner.identity);
		const linkedContentRevisionIsCurrent = (owner: LinkedContentOwner): boolean =>
			linkedContentTargetIsCurrent(owner)
			&& linkedContentRevision === owner.contentRevision
			&& hydratedLinkedQueryText !== undefined
			&& sameLinkedText(hydratedLinkedQueryText, owner.hydratedText);
		const linkedContentBaselineIsCurrent = (owner: LinkedContentOwner): boolean =>
			linkedContentRevisionIsCurrent(owner)
			&& sameLinkedText(owner.document.getText(), owner.bufferText);
		const applyAndSaveLinkedQueryForOwner = async (
			candidateText: string,
			owner: LinkedContentOwner,
			requestIsCurrent: () => boolean,
		): Promise<LinkedSaveAttempt> => {
			return runWithLinkedWriteLease(async () => {
				let candidateApplied = false;
				let priorDurableText: string | undefined;
				const rollback = async (): Promise<void> => {
					if (priorDurableText === undefined) return;
					let durableRestored = false;
					try {
						const durableText = await tryReadTextFile(owner.uri);
						if (durableText === priorDurableText) {
							durableRestored = true;
						} else if (durableText === candidateText
							&& localFileIdentityEquals(owner.identity, await getLocalFileIdentity(owner.uri))) {
							await writeOwnedLocalFileText(
								owner.uri, owner.identity, candidateText, priorDurableText,
							);
							durableRestored = await tryReadTextFile(owner.uri) === priorDurableText;
						}
					} catch {
						durableRestored = false;
					}
					let bufferRestored = !candidateApplied || !sameLinkedText(owner.document.getText(), candidateText);
					if (candidateApplied && sameLinkedText(owner.document.getText(), candidateText)) {
						const edit = new vscode.WorkspaceEdit();
						edit.replace(
							owner.document.uri,
							new vscode.Range(owner.document.positionAt(0), owner.document.positionAt(owner.document.getText().length)),
							owner.bufferText,
						);
						bufferRestored = await vscode.workspace.applyEdit(edit)
							&& sameLinkedText(owner.document.getText(), owner.bufferText);
						if (bufferRestored) setHydratedLinkedQueryText(owner.bufferText);
					}
					if (durableRestored) lastSavedLinkedQueryText = priorDurableText;
					if (!durableRestored || !bufferRestored) linkedRollbackFailed = true;
				};
				try {
					if (!requestIsCurrent() || !linkedContentBaselineIsCurrent(owner)) {
						return { ok: false, reason: 'owner-changed' };
					}
					if (await samePhysicalLocalFile(document.uri, owner.uri)
						|| !localFileIdentityEquals(owner.identity, await getLocalFileIdentity(owner.uri))) {
						return { ok: false, reason: 'save-failed' };
					}
					priorDurableText = await tryReadTextFile(owner.uri);
					if (priorDurableText === undefined || priorDurableText !== owner.lastSavedText
						|| lastSavedLinkedQueryText !== owner.lastSavedText) {
						return { ok: false, reason: 'durable-changed' };
					}
					if (!requestIsCurrent() || !linkedContentBaselineIsCurrent(owner)) {
						return { ok: false, reason: 'owner-changed' };
					}
					const applied = await applyLinkedQueryTextWithinLease(
						candidateText,
						() => requestIsCurrent() && linkedContentRevisionIsCurrent(owner),
					);
					if (!applied) return { ok: false, reason: 'update-failed' };
					candidateApplied = !sameLinkedText(owner.bufferText, candidateText);
					const candidateRevision = linkedContentRevision;
					const candidateIsCurrent = () => requestIsCurrent()
						&& linkedContentTargetIsCurrent(owner)
						&& linkedContentRevision === candidateRevision
						&& hydratedLinkedQueryText !== undefined
						&& sameLinkedText(hydratedLinkedQueryText, candidateText)
						&& sameLinkedText(owner.document.getText(), candidateText);
					if (!candidateIsCurrent()) {
						await rollback();
						return { ok: false, reason: 'owner-changed' };
					}
					if (priorDurableText !== candidateText) {
						await writeOwnedLocalFileText(owner.uri, owner.identity, priorDurableText, candidateText);
					}
					if (!candidateIsCurrent()) {
						await rollback();
						return { ok: false, reason: 'owner-changed' };
					}
					if (!localFileIdentityEquals(owner.identity, await getLocalFileIdentity(owner.uri))
						|| await tryReadTextFile(owner.uri) !== candidateText) {
						await rollback();
						return { ok: false, reason: 'save-failed' };
					}
					lastSavedLinkedQueryText = candidateText;
					return { ok: true, transaction: {
						uri: owner.uri, identity: owner.identity, document: owner.document,
						candidateText, priorBufferText: owner.bufferText, priorDurableText,
					} };
				} catch {
					await rollback();
					return { ok: false, reason: 'save-failed' };
				}
			});
		};
		let pendingLinkedNativeSave: PendingLinkedNativeSave | undefined;
		let rolledBackLinkedNativeSave: PendingLinkedNativeSave | undefined;
		let pendingLinkedRollback: Promise<boolean> | undefined;
		let pendingLinkedReconciliationTimer: ReturnType<typeof setTimeout> | undefined;
		const clearPendingLinkedNativeSave = () => {
			if (!pendingLinkedNativeSave) return;
			pendingLinkedNativeSave = undefined;
			if (pendingLinkedReconciliationTimer) clearTimeout(pendingLinkedReconciliationTimer);
			pendingLinkedReconciliationTimer = undefined;
		};
		const rollbackPendingLinkedNativeSave = async (retainForLateCommit = false): Promise<boolean> => {
			if (pendingLinkedRollback) return pendingLinkedRollback;
			const pending = pendingLinkedNativeSave;
			if (!pending) return true;
			const rollback = (async () => {
				const restored = await restoreLinkedSaveSnapshot(
					pending.uri, pending.identity, pending.document, pending.candidateText,
					pending.priorBufferText, pending.priorDurableText,
				);
				if (!restored) linkedRollbackFailed = true;
				if (restored && retainForLateCommit) {
					pending.rollbackContentRevision = linkedContentRevision;
					rolledBackLinkedNativeSave = pending;
				}
				if (pendingLinkedNativeSave === pending) clearPendingLinkedNativeSave();
				return restored;
			})();
			pendingLinkedRollback = rollback;
			try {
				return await rollback;
			} finally {
				if (pendingLinkedRollback === rollback) pendingLinkedRollback = undefined;
			}
		};
		const confirmPendingLinkedNativeSaveFromDisk = async (): Promise<boolean> => {
			const pending = pendingLinkedNativeSave;
			if (!pending || document.uri.scheme !== 'file') return false;
			if (pending.notebookCandidateText === pending.notebookPriorDurableText) return false;
			const notebookDiskText = await tryReadTextFile(document.uri);
			if (notebookDiskText !== pending.notebookCandidateText) return false;
			return true;
		};
		const retainLinkedNativeSaveUntilNotebookCommit = (
			uri: vscode.Uri,
			identity: LocalFileIdentity,
			targetDocument: vscode.TextDocument,
			candidateText: string,
			priorBufferText: string,
			priorDurableText: string,
			notebookCandidateText: string,
			notebookPriorDurableText: string,
		): void => {
			clearPendingLinkedNativeSave();
			rolledBackLinkedNativeSave = undefined;
			pendingLinkedNativeSave = {
				uri, identity, document: targetDocument, candidateText, priorBufferText, priorDurableText,
				notebookCandidateText, notebookPriorDurableText,
			};
			const pending = pendingLinkedNativeSave;
			pendingLinkedReconciliationTimer = setTimeout(() => {
				if (pendingLinkedNativeSave !== pending || outerDisposed) return;
				const reconciliation = (async () => {
					if (!await confirmPendingLinkedNativeSaveFromDisk()) await rollbackPendingLinkedNativeSave(true);
				})();
				linkedSaveTasks.add(reconciliation);
				void reconciliation.finally(() => linkedSaveTasks.delete(reconciliation));
			}, LINKED_NATIVE_SAVE_RECONCILE_MS);
		};
		const reapplyRolledBackLinkedNativeSave = async (rolledBack: PendingLinkedNativeSave): Promise<boolean> => {
			const rollbackRevision = rolledBack.rollbackContentRevision;
			const replayOwner = captureLinkedContentOwner();
			if (rolledBackLinkedNativeSave !== rolledBack
				|| rollbackRevision === undefined
				|| !replayOwner
				|| !sameLinkedUri(linkedQueryUri, rolledBack.uri)
				|| linkedQueryDocument !== rolledBack.document
				|| !localFileIdentityEquals(linkedQueryPhysicalIdentity, rolledBack.identity)
				|| replayOwner.contentRevision !== rollbackRevision
				|| !sameLinkedText(replayOwner.bufferText, rolledBack.priorBufferText)
				|| !sameLinkedText(replayOwner.hydratedText, rolledBack.priorBufferText)
				|| await tryReadTextFile(rolledBack.uri) !== rolledBack.priorDurableText) {
				if (rolledBackLinkedNativeSave === rolledBack) rolledBackLinkedNativeSave = undefined;
				return false;
			}
			const attempt = await applyAndSaveLinkedQueryForOwner(
				rolledBack.candidateText,
				replayOwner,
				() => rolledBackLinkedNativeSave === rolledBack,
			);
			if (!attempt.ok) {
				if (rolledBackLinkedNativeSave === rolledBack) rolledBackLinkedNativeSave = undefined;
				void vscode.window.showErrorMessage('The linked query could not be restored after the delayed notebook Save. Save the notebook again.');
				return false;
			}
			if (rolledBackLinkedNativeSave === rolledBack) rolledBackLinkedNativeSave = undefined;
			return true;
		};
		const waitForPendingLinkedNativeSaveCommit = async (timeoutMs = 500): Promise<boolean> => {
			const deadline = Date.now() + timeoutMs;
			while (pendingLinkedNativeSave && Date.now() < deadline) {
				if (await confirmPendingLinkedNativeSaveFromDisk()) return true;
				await new Promise<void>(resolve => setTimeout(resolve, 20));
			}
			return !pendingLinkedNativeSave || await confirmPendingLinkedNativeSaveFromDisk();
		};
		const saveSessionSnapshot = async (
			notebookText: string,
			isRequestCurrent: () => boolean,
			allowDisposed = false,
			getStaleAuthorityText: () => string | undefined = () => undefined,
		): Promise<boolean> => {
			if (linkedQueryUri && !await saveCurrentLinkedQueryDocument()) return false;
			return saveSessionFileToDisk(notebookText, isRequestCurrent, allowDisposed, getStaleAuthorityText);
		};

		const injectLinkedQueryText = async (
			state: KqlxStateV1,
			generation: number,
			rawText: string,
		): Promise<KqlxStateV1 | undefined> => {
			const descriptor = getLinkedQueryDescriptorFromState(state);
			if (!descriptor) {
				if (generation !== postDocumentGeneration || !await isProjectionSourceCurrent(rawText)) return undefined;
				linkedQueryUri = undefined;
				linkedQueryPathRaw = '';
				linkedQuerySectionIdentity = undefined;
				linkedQueryDocument = undefined;
				linkedQueryLoadGeneration = generation;
				setHydratedLinkedQueryText(undefined);
				linkedQueryHydrationFailed = false;
				linkedQueryPhysicalIdentity = undefined;
				return state;
			}
			const previousLinkedDocument = linkedQueryDocument;
			const previousPhysicalIdentity = linkedQueryPhysicalIdentity;
			let [text, physicalIdentity] = await Promise.all([
				tryReadTextFile(descriptor.uri),
				getLocalFileIdentity(descriptor.uri),
			]);
			if (generation !== postDocumentGeneration || !await isProjectionSourceCurrent(rawText)) return undefined;
			linkedQueryUri = descriptor.uri;
			linkedQueryPathRaw = descriptor.path;
			linkedQuerySectionIdentity = descriptor.identity;
			linkedQueryLoadGeneration = generation;
			linkedQueryPhysicalIdentity = physicalIdentity;
			if (typeof text !== 'string' || (descriptor.uri.scheme === 'file' && !physicalIdentity)) {
				linkedQueryHydrationFailed = true;
				setHydratedLinkedQueryText(undefined);
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
				const linkedDocument = await getOrOpenLinkedQueryDocument(descriptor.uri);
				if (!linkedDocument && descriptor.uri.scheme === 'file') {
					linkedQueryHydrationFailed = true;
					setHydratedLinkedQueryText(undefined);
					return state;
				}
				if (linkedDocument) {
					const bufferText = linkedDocument.getText();
					const identityRemainedBound = previousLinkedDocument === linkedDocument
						&& localFileIdentityEquals(previousPhysicalIdentity, physicalIdentity);
					if (!identityRemainedBound && !sameLinkedText(bufferText, text)) {
						linkedQueryHydrationFailed = true;
						setHydratedLinkedQueryText(undefined);
						linkedQueryDocument = undefined;
						return state;
					}
					text = bufferText;
				}
			} catch {
				// ignore
			}
			try {
				if (generation !== postDocumentGeneration || !await isProjectionSourceCurrent(rawText)) return undefined;
				setHydratedLinkedQueryText(text);
				linkedQueryHydrationFailed = false;
				linkedRollbackFailed = false;
				const sections = [...state.sections];
				const index = findLinkedQuerySectionIndex(sections, descriptor.identity);
				if (index < 0) return state;
				sections[index] = { ...(sections[index] as any), query: text };
				return { ...state, sections };
			} catch {
				return state;
			}
		};
		const projectedSectionIdsBySourceText = new Map<string, string[]>();
		const ensureProjectedSectionIds = (state: KqlxStateV1, sourceText: string): KqlxStateV1 => {
			let projectedSectionIds = projectedSectionIdsBySourceText.get(sourceText);
			if (!projectedSectionIds) {
				projectedSectionIds = state.sections.map(section => {
					const id = String((section as any)?.id || '').trim();
					return id || `section_${randomUUID()}`;
				});
				projectedSectionIdsBySourceText.set(sourceText, projectedSectionIds);
				while (projectedSectionIdsBySourceText.size > 8) {
					projectedSectionIdsBySourceText.delete(projectedSectionIdsBySourceText.keys().next().value!);
				}
			}
			let changed = false;
			const sections = state.sections.map((section, index) => {
				const current = section as Record<string, unknown>;
				if (typeof current.id === 'string' && current.id.trim()) return section;
				changed = true;
				return { ...current, id: projectedSectionIds![index] || `section_${randomUUID()}` } as KqlxSectionV1;
			});
			return changed ? { ...state, sections } : state;
		};
		const markdownDocumentKey = normalizeWorkbenchUriKey(document.uri);
		let activeMarkdownOwnerEntry: MarkdownDocumentOwnerEntry | undefined;
		const panelOwnerRegistration: MarkdownPanelOwnerRegistration = {
			requestProjection: () => undefined,
		};
		const panelOwners = this.markdownPanelOwners.get(markdownDocumentKey)
			?? new Map<vscode.WebviewPanel, MarkdownPanelOwnerRegistration>();
		panelOwners.set(webviewPanel, panelOwnerRegistration);
		this.markdownPanelOwners.set(markdownDocumentKey, panelOwners);
		let panelOwnerRetired = false;
		retireMarkdownPanelOwner = () => {
			if (panelOwnerRetired) return;
			panelOwnerRetired = true;
			const current = this.markdownPanelOwners.get(markdownDocumentKey);
			if (!current || current.get(webviewPanel) !== panelOwnerRegistration) return;
			current.delete(webviewPanel);
			const canonicalOwner = this.markdownDocuments.get(markdownDocumentKey);
			if (canonicalOwner && canonicalOwner === panelOwnerRegistration.owner) {
				const replacement = [...current.values()].reverse().find(candidate => !!candidate.owner);
				const nextPanel = replacement ?? [...current.values()].at(-1);
				nextPanel?.requestProjection();
			}
			if (current.size === 0) this.markdownPanelOwners.delete(markdownDocumentKey);
		};
		const isLocalNativeSaveCoordinator = () => {
			const canonicalOwner = this.markdownDocuments.get(markdownDocumentKey);
			const canonicalOwnerIsLive = !!canonicalOwner
				&& [...(this.markdownPanelOwners.get(markdownDocumentKey)?.values() ?? [])]
					.some(registration => registration.owner === canonicalOwner);
			return canonicalOwnerIsLive
				? activeMarkdownOwnerEntry === canonicalOwner
				: KqlxEditorProvider.isNativeSaveCoordinator(document.uri, webviewPanel);
		};
		const markdownDocumentQueue = (() => {
			const existing = this.markdownDocumentQueues.get(markdownDocumentKey);
			if (existing) return existing;
			const created: MarkdownDocumentOwnerQueue = {
				tail: Promise.resolve(),
				pendingCommands: 0,
				activePersistenceLeases: new Set(),
			};
			this.markdownDocumentQueues.set(markdownDocumentKey, created);
			return created;
		})();
		const ensureMarkdownDocumentOwner = (
			sourceText: string,
			state: KqlxStateV1,
			install = true,
		): MarkdownDocumentOwnerEntry => {
			let entry = this.markdownDocuments.get(markdownDocumentKey);
			if (!install) {
				const incoming = MarkdownDocumentAggregate.create(state, entry ? entry.document.revision : 0);
				if (!incoming.ok) throw new Error(`Cannot materialize host-owned Markdown state: ${incoming.error}`);
				const sameOwnedSections = !!entry && JSON.stringify(incoming.document.ownedSections())
					=== JSON.stringify(entry.document.ownedSections());
				const created = sameOwnedSections
					? { ok: true as const, document: entry!.document.withAdapterState(state) }
					: MarkdownDocumentAggregate.create(state, entry ? entry.document.revision + 1 : 0);
				if (!created.ok) throw new Error(`Cannot materialize host-owned Markdown state: ${created.error}`);
				return {
					document: created.document,
					sourceText,
					queue: markdownDocumentQueue,
				};
			}
			if (entry && entry.sourceText === sourceText) return entry;
			const incoming = MarkdownDocumentAggregate.create(state, entry ? entry.document.revision : 0);
			if (!incoming.ok) throw new Error(`Cannot materialize host-owned Markdown state: ${incoming.error}`);
			if (entry && JSON.stringify(incoming.document.ownedSections())
				=== JSON.stringify(entry.document.ownedSections())) {
				entry.document = entry.document.withAdapterState(state);
				entry.sourceText = sourceText;
				return entry;
			}
			const created = entry
				? MarkdownDocumentAggregate.create(state, entry.document.revision + 1)
				: incoming;
			if (!created.ok) throw new Error(`Cannot materialize host-owned Markdown state: ${created.error}`);
			entry = {
				document: created.document,
				sourceText,
				queue: markdownDocumentQueue,
			};
			this.markdownDocuments.set(markdownDocumentKey, entry);
			return entry;
		};
		const acquireMarkdownPersistenceLease = async (
			entry: MarkdownDocumentOwnerEntry,
			generation: number,
			baseText: string,
		): Promise<MarkdownPersistenceLease> => {
			const previousMarkdownWork = entry.queue.tail;
			let resolveLease!: () => void;
			const persistenceLease = new Promise<void>(resolve => { resolveLease = resolve; });
			let settled = false;
			const lease: MarkdownPersistenceLease = {
				generation,
				baseText,
				revoked: false,
				revoke: authority => {
					lease.revoked = true;
					if (!lease.revocationAuthority
						|| authority.generation >= lease.revocationAuthority.generation) {
						lease.revocationAuthority = authority;
					}
				},
				settle: () => {
					if (settled) return;
					settled = true;
					entry.queue.activePersistenceLeases.delete(lease);
					resolveLease();
				},
			};
			entry.queue.activePersistenceLeases.add(lease);
			entry.queue.tail = previousMarkdownWork.catch(() => undefined).then(() => persistenceLease);
			await previousMarkdownWork.catch(() => undefined);
			return lease;
		};
		let invalidateMarkdownBarriersForGeneration: (generation: number) => void = () => undefined;
		const activateProjection = (
			generation: number,
			sourceText: string,
			owner: MarkdownDocumentOwnerEntry | undefined,
		): void => {
			persistRequestGeneration++;
			const reloadEpoch = ++sourceReloadEpoch;
			sourceReloadAuthority = { epoch: reloadEpoch, text: sourceText };
			if (sourceRollbackFailedCandidate === undefined || sourceText !== sourceRollbackFailedCandidate) {
				sourceRollbackFailed = false;
				sourceRollbackFailedCandidate = undefined;
			}
			activeProjectionGeneration = generation;
			activeProjectionSourceText = sourceText;
			const previousPanelOwner = panelOwnerRegistration.owner;
			activeMarkdownOwnerEntry = owner;
			panelOwnerRegistration.owner = owner;
			if (owner) this.markdownDocuments.set(markdownDocumentKey, owner);
			else if (this.markdownDocuments.get(markdownDocumentKey) === previousPanelOwner) {
				this.markdownDocuments.delete(markdownDocumentKey);
			}
			invalidateMarkdownBarriersForGeneration(generation);
			const entry = owner ?? this.markdownDocuments.get(markdownDocumentKey);
			for (const lease of [...(entry?.queue.activePersistenceLeases ?? [])]) {
				if (lease.generation !== generation) lease.revoke({ generation, sourceText });
			}
		};
		const overlayOwnedMarkdownState = (
			baseState: KqlxStateV1,
			owner: MarkdownDocumentAggregate,
		): KqlxStateV1 => owner.withAdapterState(baseState).snapshot() as KqlxStateV1;
		const rebaseMarkdownOwnerFromSource = (
			owner: MarkdownDocumentOwnerEntry,
			sourceText: string,
			state: KqlxStateV1,
		): boolean => {
			if (owner.sourceText === sourceText) return true;
			const incoming = MarkdownDocumentAggregate.create(state, owner.document.revision);
			if (!incoming.ok) return false;
			if (JSON.stringify(incoming.document.ownedSections())
				!== JSON.stringify(owner.document.ownedSections())) return false;
			owner.document = owner.document.withAdapterState(state);
			owner.sourceText = sourceText;
			return true;
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
			const linkedIndex = findLinkedQuerySectionIndex(sections);
			if (linkedIndex >= 0) {
				const linkedSection = sections[linkedIndex] as any;
				if (linkedQueryPathRaw) linkedSection.linkedQueryPath = linkedQueryPathRaw;
				delete linkedSection.query;
			}
			return { ...state, sections: sections as any };
		};
		const stateForComparison = (state: KqlxStateV1): KqlxStateV1 => {
			if (!linkedQueryUri || !state.sections.length) return state;
			const sections = state.sections.map(section => ({ ...(section as any) }));
			const linkedIndex = findLinkedQuerySectionIndex(sections);
			if (linkedIndex >= 0 && linkedQueryPathRaw) {
				(sections[linkedIndex] as any).linkedQueryPath = linkedQueryPathRaw;
			}
			return { ...state, sections: sections as any };
		};
		const overlayDocumentFile = (baseText: string, state: KqlxStateV1): KqlxFileV1 => {
			const parsed = parseKqlxText(baseText, {
				allowedKinds: [documentKind],
				defaultKind: documentKind,
			});
			if (!parsed.ok) {
				throw new Error(`Cannot persist a malformed Kusto Workbench document: ${parsed.error}`);
			}
			const unsafeReason = getUnsafeLinkedQueryReason(document.uri, parsed.file.state);
			if (unsafeReason) throw new Error(`Cannot persist an unsafe linked query: ${unsafeReason}`);
			const projectedBase: KqlxFileV1 = {
				...parsed.file,
				state: ensureProjectedSectionIds(parsed.file.state, baseText),
			};
			const file = overlayKqlxFileState(projectedBase, stateForDocument(state), documentKind);
			const candidateUnsafeReason = getUnsafeLinkedQueryReason(document.uri, file.state);
			if (candidateUnsafeReason) throw new Error(`Cannot persist an unsafe linked query: ${candidateUnsafeReason}`);
			return file;
		};
		const overlayDocumentState = (baseText: string, state: KqlxStateV1): KqlxStateV1 => {
			return overlayDocumentFile(baseText, state).state;
		};
		const overlayComparisonFile = (baseText: string, state: KqlxStateV1): KqlxFileV1 => {
			const parsed = parseKqlxText(baseText, {
				allowedKinds: [documentKind], defaultKind: documentKind,
			});
			if (!parsed.ok) throw new Error(`Cannot compare a malformed Kusto Workbench document: ${parsed.error}`);
			const projectedBase = { ...parsed.file, state: ensureProjectedSectionIds(parsed.file.state, baseText) };
			return overlayKqlxFileState(projectedBase, stateForComparison(state), documentKind);
		};
		const serializeDocumentState = (state: KqlxStateV1, baseText: string = document.getText()): string => {
			const file = overlayDocumentFile(baseText, state);
			return normalizeTextToEol(stringifyKqlxFile(file), document.eol);
		};

		let _persistChain: Promise<void> = Promise.resolve();
		const ownedDocumentEdits = new OwnedDocumentEditTracker();
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
		let persistRequestGeneration = 0;
		let persistDecisionTail: Promise<void> = Promise.resolve();
		let sourceReloadEpoch = 0;
		let sourceReloadAuthority: { epoch: number; text: string } | undefined;
		let sourceRollbackFailed = false;
		let sourceRollbackFailedCandidate: string | undefined;
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
			const expectedIdentity = lastSavedIdentity;
			await withOwnedFileLock(document.uri, async () => {
				if (document.uri.scheme === 'file' && (!expectedIdentity
					|| !localFileIdentityEquals(expectedIdentity, await getLocalFileIdentity(document.uri)))) {
					throw new Error('The Kusto Workbench session changed physical identity before publication.');
				}
				const currentDiskText = new TextDecoder().decode(await vscode.workspace.fs.readFile(document.uri));
				if (currentDiskText !== lastSavedText) {
					throw new Error('The Kusto Workbench session changed in another window. Reload it before saving.');
				}
				const writeToken = ownedSessionWrites.begin(nextText);
				try {
					if (document.uri.scheme === 'file' && expectedIdentity) {
						const handle = await fs.promises.open(document.uri.fsPath, 'r+');
						try {
							const stat = await handle.stat();
							if (stat.dev !== expectedIdentity.device || (expectedIdentity.inode !== 0 && stat.ino !== expectedIdentity.inode)) {
								throw new Error('The Kusto Workbench session changed physical identity before publication.');
							}
							await publishOwnedFileText(handle, expectedIdentity, currentDiskText, nextText);
						} finally {
							await handle.close();
						}
					} else {
						await vscode.workspace.fs.writeFile(document.uri, new TextEncoder().encode(nextText));
					}
					const publishedIdentity = await getLocalFileIdentity(document.uri);
					if (document.uri.scheme === 'file'
						&& !localFileIdentityEquals(expectedIdentity, publishedIdentity)) {
						throw new Error('The Kusto Workbench session changed physical identity during publication.');
					}
					const publishedText = new TextDecoder().decode(await vscode.workspace.fs.readFile(document.uri));
					if (publishedText !== nextText) throw new Error('The Kusto Workbench session changed during publication.');
					lastSavedText = nextText;
					lastSavedIdentity = publishedIdentity;
				} catch (error) {
					ownedSessionWrites.rollback(writeToken);
					throw error;
				}
			}, expectedIdentity);
		};

		// For session files, write directly to disk without going through the document edit cycle.
		// This avoids the dirty indicator flickering that happens with applyEdit→save.
		const saveSessionFileToDisk = async (
			text: string,
			isRequestCurrent: () => boolean = () => true,
			allowDisposed = false,
			getStaleAuthorityText: () => string | undefined = () => undefined,
		): Promise<boolean> => {
			if (!isSessionFile || (outerDisposed && !allowDisposed) || !isRequestCurrent()) {
				return false;
			}
			try {
				return await serializeSqlSaveRepair(async () => {
					const restoreStaleCandidate = async (candidateText: string): Promise<void> => {
						const authorityText = getStaleAuthorityText();
						if (authorityText === undefined || authorityText === candidateText) return;
						try {
							const durableText = new TextDecoder().decode(await vscode.workspace.fs.readFile(document.uri));
							if (durableText === candidateText && lastSavedText === candidateText) {
								await writeOwnedSessionText(authorityText, allowDisposed);
							}
						} catch {
							sourceRollbackFailed = true;
							sourceRollbackFailedCandidate = candidateText;
						}
					};
					if ((outerDisposed && !allowDisposed) || !isRequestCurrent()) {
						await restoreStaleCandidate(text);
						return false;
					}
					text = await publishSerializedNotebookTextFresh(text, async sanitizedText => {
						if ((outerDisposed && !allowDisposed) || !isRequestCurrent()) return sanitizedText;
						let currentDiskText: string | undefined;
						if (sanitizedText === ownedSessionWrites.latest) {
							try {
								currentDiskText = new TextDecoder().decode(await vscode.workspace.fs.readFile(document.uri));
							} catch {
								currentDiskText = undefined;
							}
						}
						if (sanitizedText !== ownedSessionWrites.latest || currentDiskText !== sanitizedText) {
							await writeOwnedSessionText(sanitizedText, allowDisposed);
						}
						return sanitizedText;
					});
					if ((outerDisposed && !allowDisposed) || !isRequestCurrent()) {
						await restoreStaleCandidate(text);
						return false;
					}
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
				allowedKinds: [documentKind],
				defaultKind: documentKind,
			});
			if (!currentFile.ok) return;
			const repairedText = await sanitizeSerializedNotebookTextFresh(startingText);
			if (closeFinalizationAbandoned) return;
			if (repairedText === startingText) return;
			let repairedBufferText = '';
			let mayAutoSaveRepair = false;
			await (_persistChain = _persistChain.catch(() => undefined).then(async () => {
				for (let attempt = 0; attempt < 3; attempt++) {
					if (closeFinalizationAbandoned) return;
					const latestText = document.getText();
					const latestReloadEpoch = sourceReloadEpoch;
					const latestRepair = await sanitizeSerializedNotebookTextFresh(latestText);
					if (closeFinalizationAbandoned) return;
					if (document.getText() !== latestText || sourceReloadEpoch !== latestReloadEpoch) continue;
					if (latestRepair === latestText) return;
					mayAutoSaveRepair = !startedDirty && !document.isDirty && latestText === startingText;
					const edit = new vscode.WorkspaceEdit();
					edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(latestText.length)), latestRepair);
					lastWebviewPersistAt = Date.now();
					if (!await applyOwnedSourceEdit(edit, latestRepair)) {
						throw new Error('VS Code rejected the SQL privacy repair edit.');
					}
					if (sourceReloadEpoch !== latestReloadEpoch || document.getText() !== latestRepair) {
						mayAutoSaveRepair = false;
						const authority = sourceReloadAuthority;
						if (authority && authority.epoch > latestReloadEpoch && document.getText() === latestRepair) {
							sourceRollbackFailed = true;
							sourceRollbackFailedCandidate = latestRepair;
							for (let rollbackAttempt = 0; rollbackAttempt < 3; rollbackAttempt++) {
								if (sourceReloadAuthority !== authority || document.getText() !== latestRepair) break;
								const rollback = new vscode.WorkspaceEdit();
								rollback.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(latestRepair.length)), authority.text);
								lastWebviewPersistAt = Date.now();
								await applyOwnedSourceEdit(rollback, authority.text);
								if (document.getText() === authority.text) break;
							}
							if (document.getText() !== latestRepair) {
								sourceRollbackFailed = false;
								sourceRollbackFailedCandidate = undefined;
							}
						}
						void postDocument({ forceReload: true });
						return;
					}
					repairedBufferText = latestRepair;
					return;
				}
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
					if (!sec || canonicalSectionKind(t) !== 'query') {
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

		const projectionSession = new CompatSidecarSession(false, 'Kusto Workbench projection');
		const pendingProjectionActivations = new Map<string, {
			generation: number;
			sourceText: string;
			owner?: MarkdownDocumentOwnerEntry;
		}>();
		let projectionActivationTail: Promise<void> = Promise.resolve();
		let markdownCommandBarrierSupported = false;
		const createProjectionReload = (
			generation: number,
			sourceText: string,
			owner?: MarkdownDocumentOwnerEntry,
		) => {
			const reload = projectionSession.createReloadRequest();
			const activation = { generation, sourceText, owner };
			pendingProjectionActivations.set(reload.requestId, activation);
			void reload.result.then(() => {
				if (pendingProjectionActivations.get(reload.requestId) === activation) {
					pendingProjectionActivations.delete(reload.requestId);
				}
			});
			return reload;
		};
		const postDocument = async (options?: { forceReload?: boolean }): Promise<boolean> => {
			if (outerDisposed) return false;
			const generation = ++postDocumentGeneration;
			const forceReload = options?.forceReload ?? false;
			const suppressPersistenceForTest = this.context.extensionMode !== vscode.ExtensionMode.Production
				&& process.env.KUSTO_WORKBENCH_E2E_SUPPRESS_PERSISTENCE === '1';
			perfMark('host.kqlx.postDocument.start', { forceReload });
			fileOpenTrace.mark('postDocument.start', { forceReload });
			const htmlPowerBiCompatibilityCheckEnabled = vscode.workspace.getConfiguration('kustoWorkbench').get<boolean>('html.powerBiCompatibilityCheck.enabled', true);
			const rawText = await readProjectionSourceText();
			perfMark('host.kqlx.documentText.read', { length: rawText.length });
			fileOpenTrace.mark('postDocument.documentText.read', { length: rawText.length });
			const parsed = parseKqlxText(rawText, {
				allowedKinds: [documentKind],
				defaultKind: documentKind
			});
			perfMark('host.kqlx.parse.done', { ok: parsed.ok });
			fileOpenTrace.mark('postDocument.parse.done', { ok: parsed.ok });
			if (!parsed.ok) {
				const reload = createProjectionReload(generation, rawText);
				const delivered = await deliverWebviewMessage({
					type: 'documentData',
					ok: false,
					reloadRequestId: reload.requestId,
					sourceGeneration: generation,
					forceReload,
					documentUri: document.uri.toString(),
					suppressPersistenceForTest,
					error: parsed.error,
					htmlPowerBiCompatibilityCheckEnabled,
				});
				fileOpenTrace.mark('postDocument.documentData.posted', { ok: false, forceReload });
				if (!delivered) {
					pendingProjectionActivations.delete(reload.requestId);
					projectionSession.failReload(reload.requestId);
				}
				const applied = await reload.result;
				const accepted = applied && !outerDisposed
					&& generation === postDocumentGeneration
					&& await isProjectionSourceCurrent(rawText);
				return accepted;
			}
			const unsafeReason = await getUnsafeLinkedQueryReasonFresh(document.uri, parsed.file.state);
			if (outerDisposed || generation !== postDocumentGeneration || !await isProjectionSourceCurrent(rawText)) return false;
			if (unsafeReason) {
				linkedQueryUri = undefined;
				linkedQueryPathRaw = '';
				linkedQuerySectionIdentity = undefined;
				linkedQueryDocument = undefined;
				linkedQueryLoadGeneration = generation;
				linkedQueryPhysicalIdentity = undefined;
				const reload = createProjectionReload(generation, rawText);
				const delivered = await deliverWebviewMessage({
					type: 'documentData', ok: false, forceReload, sourceGeneration: generation,
					reloadRequestId: reload.requestId,
					documentUri: document.uri.toString(), suppressPersistenceForTest,
					error: unsafeReason, htmlPowerBiCompatibilityCheckEnabled,
				});
				if (!delivered) {
					pendingProjectionActivations.delete(reload.requestId);
					projectionSession.failReload(reload.requestId);
				}
				const applied = await reload.result;
				const accepted = applied && !outerDisposed
					&& generation === postDocumentGeneration
					&& await isProjectionSourceCurrent(rawText);
				return accepted;
			}

			let sanitizedState = ensureProjectedSectionIds(parsed.file.state, rawText);
			sanitizedState = await queryEditor.sanitizeSqlLeaveNoTraceStateFresh(sanitizedState);
			assertDocumentSectionKindsAllowed(documentKind, sanitizedState.sections);
			if (outerDisposed || generation !== postDocumentGeneration || !await isProjectionSourceCurrent(rawText)) return false;
			perfMark('host.kqlx.sanitize.done', { sections: Array.isArray(sanitizedState.sections) ? sanitizedState.sections.length : 0 });
			fileOpenTrace.mark('postDocument.sanitize.done', { sections: Array.isArray(sanitizedState.sections) ? sanitizedState.sections.length : 0 });
			const hydratedState = await injectLinkedQueryText(sanitizedState, generation, rawText);
			if (!hydratedState || outerDisposed || generation !== postDocumentGeneration || !await isProjectionSourceCurrent(rawText)) return false;
			perfMark('host.kqlx.injectLinkedQuery.done', { sections: Array.isArray(hydratedState.sections) ? hydratedState.sections.length : 0 });
			fileOpenTrace.mark('postDocument.injectLinkedQuery.done', { sections: Array.isArray(hydratedState.sections) ? hydratedState.sections.length : 0 });
			const sanitizedOutboundState = await queryEditor.sanitizeSqlLeaveNoTraceStateFresh(hydratedState);
			if (outerDisposed || generation !== postDocumentGeneration || !await isProjectionSourceCurrent(rawText)) return false;
			const markdownOwner = ensureMarkdownDocumentOwner(rawText, sanitizedOutboundState, false);
			const outboundState = overlayOwnedMarkdownState(sanitizedOutboundState, markdownOwner.document);
			const markdownProjection = markdownOwner.document.projection();

			const reload = createProjectionReload(generation, rawText, markdownOwner);
			const delivered = await deliverWebviewMessage({
				type: 'documentData',
				ok: true,
				reloadRequestId: reload.requestId,
				sourceGeneration: generation,
				forceReload,
				documentUri: document.uri.toString(),
				suppressPersistenceForTest,
				htmlPowerBiCompatibilityCheckEnabled,
				state: outboundState
				, documentRevision: markdownProjection.documentRevision
				, sectionRevisions: markdownProjection.sectionRevisions
				, markdownSectionRevisions: markdownProjection.markdownSectionRevisions
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
			if (!delivered) {
				pendingProjectionActivations.delete(reload.requestId);
				projectionSession.failReload(reload.requestId);
			}
			const applied = await reload.result;
			const accepted = applied && !outerDisposed
				&& generation === postDocumentGeneration
				&& await isProjectionSourceCurrent(rawText);
			if (!accepted && this.markdownDocuments.get(markdownDocumentKey) === markdownOwner
				&& activeMarkdownOwnerEntry && activeMarkdownOwnerEntry !== markdownOwner) {
				this.markdownDocuments.set(markdownDocumentKey, activeMarkdownOwnerEntry);
			}
			return accepted;
		};
		panelOwnerRegistration.requestProjection = () => {
			if (!outerDisposed) void postDocument({ forceReload: true });
		};

		const subscriptions: vscode.Disposable[] = [webviewMessageSubscription, outerDisposalSubscription];
		const finalPersistSession = new CompatSidecarSession(false, 'Kusto Workbench document');
		const markdownBarrierRequests = new Map<string, {
			sourceGeneration: number;
			resolve: (lease: MarkdownSaveLease | undefined) => void;
			timer: NodeJS.Timeout;
			expired: Promise<void>;
			expire: () => void;
		}>();
		const reserveMarkdownSaveLease = (
			owner: MarkdownDocumentOwnerEntry | undefined,
			sourceGeneration: number,
		): MarkdownSaveLease => {
			if (!owner) return { sourceGeneration, settle: () => undefined };
			const previousWork = owner.queue.tail;
			let release!: () => void;
			const leaseDone = new Promise<void>(resolve => { release = resolve; });
			let settled = false;
			owner.queue.tail = previousWork.catch(() => undefined).then(() => leaseDone);
			return {
				owner,
				sourceGeneration,
				settle: () => {
					if (settled) return;
					settled = true;
					release();
				},
			};
		};
		const settleMarkdownBarrier = (
			requestId: string,
			pending: (typeof markdownBarrierRequests extends Map<string, infer T> ? T : never),
			lease?: MarkdownSaveLease,
		): void => {
			if (markdownBarrierRequests.get(requestId) !== pending) return;
			clearTimeout(pending.timer);
			markdownBarrierRequests.delete(requestId);
			pending.expire();
			pending.resolve(lease);
		};
		invalidateMarkdownBarriersForGeneration = generation => {
			for (const [requestId, pending] of markdownBarrierRequests) {
				if (pending.sourceGeneration !== generation) settleMarkdownBarrier(requestId, pending);
			}
		};
		const requestMarkdownCommandBarrier = (): Promise<MarkdownSaveLease | undefined> => {
			const requestId = `markdown-save-barrier-${randomUUID()}`;
			const sourceGeneration = activeProjectionGeneration;
			return new Promise(resolve => {
				let expire!: () => void;
				const expired = new Promise<void>(expiredResolve => { expire = expiredResolve; });
				const timer = setTimeout(() => {
					const pending = markdownBarrierRequests.get(requestId);
					if (pending) settleMarkdownBarrier(requestId, pending);
				}, 5_000);
				markdownBarrierRequests.set(requestId, { sourceGeneration, resolve, timer, expired, expire });
				void deliverWebviewMessage({
					type: 'requestMarkdownCommandBarrier', requestId, sourceGeneration,
				}).then(delivered => {
					if (delivered) return;
					const pending = markdownBarrierRequests.get(requestId);
					if (!pending) return;
					settleMarkdownBarrier(requestId, pending);
				});
			});
		};
		let nativeSaveGeneration = 0;
		let pendingNativeResultRestore: { rowFreeText: string; candidateText: string; generation: number } | undefined;
		let canonicalResultRestoreSaveInProgress = false;
		let canonicalResultRestoreTail: Promise<void> = Promise.resolve();
		const nativeSavePreparations = new Set<Promise<void>>();
		type NativeMarkdownSaveLeaseRecord = {
			lease: MarkdownSaveLease;
			expectedText: string;
			timer: NodeJS.Timeout;
		};
		const activeNativeMarkdownSaveLeases = new Set<MarkdownSaveLease>();
		const nativeMarkdownSaveLeases: NativeMarkdownSaveLeaseRecord[] = [];
		const settleActiveNativeMarkdownSaveLease = (lease: MarkdownSaveLease) => {
			activeNativeMarkdownSaveLeases.delete(lease);
			lease.settle();
		};
		const settleNativeMarkdownSaveLeaseRecord = (index: number) => {
			if (index < 0 || index >= nativeMarkdownSaveLeases.length) return;
			const record = nativeMarkdownSaveLeases.splice(index, 1)[0];
			clearTimeout(record.timer);
			settleActiveNativeMarkdownSaveLease(record.lease);
		};
		const settleNativeMarkdownSaveLease = (savedText: string) => {
			const index = nativeMarkdownSaveLeases.findIndex(record => record.expectedText === savedText);
			settleNativeMarkdownSaveLeaseRecord(index);
		};
		const retainNativeMarkdownSaveLease = (lease: MarkdownSaveLease, expectedText: string): boolean => {
			if (outerDisposed || !activeNativeMarkdownSaveLeases.has(lease)) return false;
			const record = { lease, expectedText } as NativeMarkdownSaveLeaseRecord;
			record.timer = setTimeout(() => {
				settleNativeMarkdownSaveLeaseRecord(nativeMarkdownSaveLeases.indexOf(record));
			}, NATIVE_SAVE_COMMIT_LEASE_TIMEOUT_MS);
			record.timer.unref?.();
			nativeMarkdownSaveLeases.push(record);
			return true;
		};
		const settleAllNativeMarkdownSaveLeases = () => {
			while (nativeMarkdownSaveLeases.length > 0) settleNativeMarkdownSaveLeaseRecord(0);
			for (const lease of [...activeNativeMarkdownSaveLeases]) settleActiveNativeMarkdownSaveLease(lease);
		};
		const linkedSaveTasks = new Set<Promise<void>>();
		let nativeSaveStateVersion = 0;
		const nativeSaveStateWaiters = new Set<() => void>();
		const notifyNativeSaveStateChanged = () => {
			nativeSaveStateVersion++;
			for (const resolve of [...nativeSaveStateWaiters]) resolve();
			nativeSaveStateWaiters.clear();
		};
		const waitForNativeSaveStateChange = (version: number): Promise<void> => {
			if (nativeSaveStateVersion !== version || closeFinalizationAbandoned) return Promise.resolve();
			return new Promise(resolve => nativeSaveStateWaiters.add(resolve));
		};
		const prepareAtomicSqlSaveText = async (currentText: string): Promise<string> => {
			return sanitizeSerializedNotebookTextFailClosed(currentText);
		};
		const restoreCanonicalNativeResults = async (pending: { rowFreeText: string; candidateText: string; generation: number }): Promise<void> => {
			if (closeFinalizationAbandoned || pending.generation !== nativeSaveGeneration || document.isDirty || document.getText() !== pending.rowFreeText) return;
			const rowFreeVersion = document.version;
			try {
			await publishSerializedNotebookTextFresh(pending.candidateText, async admittedText => {
				if (closeFinalizationAbandoned || pending.generation !== nativeSaveGeneration || document.version !== rowFreeVersion
					|| document.isDirty || document.getText() !== pending.rowFreeText || admittedText === pending.rowFreeText) return false;
				canonicalResultRestoreSaveInProgress = true;
				try {
					const currentText = document.getText();
					const edit = new vscode.WorkspaceEdit();
					edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(currentText.length)), admittedText);
					lastWebviewPersistAt = Date.now();
					if (!await vscode.workspace.applyEdit(edit)) return false;
					const admittedVersion = document.version;
					if (pending.generation !== nativeSaveGeneration || document.getText() !== admittedText) return false;
					if (await document.save()) return true;
					if (pending.generation !== nativeSaveGeneration || document.version !== admittedVersion || document.getText() !== admittedText) return false;
					const rollbackText = document.getText();
					const rollback = new vscode.WorkspaceEdit();
					rollback.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(rollbackText.length)), pending.rowFreeText);
					lastWebviewPersistAt = Date.now();
					await vscode.workspace.applyEdit(rollback);
					return false;
				} catch {
					const rollbackText = document.getText();
					if (pending.generation === nativeSaveGeneration && document.version === rowFreeVersion + 1
						&& rollbackText !== pending.rowFreeText) {
						const rollback = new vscode.WorkspaceEdit();
						rollback.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(rollbackText.length)), pending.rowFreeText);
						lastWebviewPersistAt = Date.now();
						await vscode.workspace.applyEdit(rollback);
					}
					return false;
				} finally {
					canonicalResultRestoreSaveInProgress = false;
				}
			});
			} catch {
				// The native save already committed the row-free snapshot.
			}
		};
		subscriptions.push(queryEditor.onDidInvalidateSqlPersistence(() => {
			void repairPersistedSqlState().catch(() => undefined);
		}));
		subscriptions.push(queryEditor.onDidInvalidateKustoPersistence(() => {
			void repairPersistedSqlState().catch(() => undefined);
		}));
		if (!isSessionFile) {
			subscriptions.push(vscode.workspace.onWillSaveTextDocument(event => {
				if (event.document.uri.toString() !== document.uri.toString()) return;
				if (!isLocalNativeSaveCoordinator()) return;
				if (canonicalResultRestoreSaveInProgress) {
					event.waitUntil(Promise.resolve([]));
					return;
				}
				if (outerDisposed) {
					event.waitUntil(Promise.resolve([]));
					return;
				}
				const preparation = (async () => {
					let markdownSaveLease: MarkdownSaveLease | undefined;
					let retainedMarkdownSaveLease = false;
					try {
					if (sourceRollbackFailed) throw new Error('Cannot save because an external reload could not be restored. Reload the file and try again.');
					if (pendingLinkedNativeSave && !await rollbackPendingLinkedNativeSave()) {
						throw new Error('Cannot save because a previous linked-query Save could not be rolled back.');
					}
					if (markdownCommandBarrierSupported) {
						markdownSaveLease = await requestMarkdownCommandBarrier();
						if (!markdownSaveLease) {
							throw Object.assign(
								new Error('Cannot save because pending Markdown commands did not settle. Reload the file and try again.'),
								{ markdownBarrierFailed: true },
							);
						}
						activeNativeMarkdownSaveLeases.add(markdownSaveLease);
						if (outerDisposed) {
							throw Object.assign(new Error('Cannot save because the editor closed while reserving Markdown state.'), {
								markdownBarrierFailed: true,
							});
						}
					}
					if (activeSourceMutations > 0) {
						throw new Error('Cannot save because a source update is still settling. Reload the file and try again.');
					}
					const currentText = document.getText();
					const saveProjectionGeneration = markdownSaveLease?.sourceGeneration ?? activeProjectionGeneration;
					const saveMarkdownOwner = markdownSaveLease
						? markdownSaveLease.owner
						: activeMarkdownOwnerEntry;
					const saveLinkedUri = linkedQueryUri;
					const saveLinkedGeneration = linkedQueryLoadGeneration;
					const saveLinkedIdentity = linkedQueryPhysicalIdentity;
					const saveOwnerIsCurrent = () => activeProjectionGeneration === saveProjectionGeneration
						&& (saveMarkdownOwner
							? activeMarkdownOwnerEntry === saveMarkdownOwner
								&& this.markdownDocuments.get(markdownDocumentKey) === saveMarkdownOwner
							: activeMarkdownOwnerEntry === undefined
								&& this.markdownDocuments.get(markdownDocumentKey) === undefined)
						&& document.getText() === currentText
						&& (!saveLinkedUri || linkedQueryLoadGeneration === saveLinkedGeneration)
						&& ((!saveLinkedUri && !linkedQueryUri) || (!!saveLinkedUri && sameLinkedUri(linkedQueryUri, saveLinkedUri)))
						&& (!saveLinkedUri || localFileIdentityEquals(linkedQueryPhysicalIdentity, saveLinkedIdentity));
					let sanitizedText: string;
					try {
						if (!saveOwnerIsCurrent()) throw new Error('The Markdown document owner changed before Save could capture it.');
						const parsedCurrent = parseKqlxText(currentText, {
							allowedKinds: [documentKind], defaultKind: documentKind,
						});
						if (!parsedCurrent.ok) throw new Error(parsedCurrent.error);
						const projectedCurrentState = ensureProjectedSectionIds(parsedCurrent.file.state, currentText);
						const sourceHasOwnedSections = projectedCurrentState.sections.some(section => {
							const kind = canonicalSectionKind(String((section as any)?.type || ''));
							return kind === 'markdown' || kind === 'python' || kind === 'url';
						});
						if ((!saveMarkdownOwner && sourceHasOwnedSections)
							|| (saveMarkdownOwner && !rebaseMarkdownOwnerFromSource(saveMarkdownOwner, currentText, projectedCurrentState))
							|| !saveOwnerIsCurrent()) {
							throw new Error('The source Markdown changed before its projection was acknowledged.');
						}
						const adapterState = await finalPersistSession.requestFinalPersist<KqlxStateV1>(
							message => webviewPanel.webview.postMessage(message), 'save', 1_000,
						);
						const saveState = saveMarkdownOwner
							? overlayOwnedMarkdownState(adapterState, saveMarkdownOwner.document)
							: adapterState;
						if (!saveOwnerIsCurrent()) throw Object.assign(new Error('The linked-query target changed while Save was waiting for the final snapshot.'), { linkedQueryWriteFailed: true });
						const saveLinkedContentOwner = saveLinkedUri ? captureLinkedContentOwner() : undefined;
						if (saveLinkedUri && !saveLinkedContentOwner) {
							throw Object.assign(new Error('The linked query file could not be updated.'), { linkedQueryWriteFailed: true });
						}
						if (saveLinkedUri && saveLinkedContentOwner
							&& (!sameLinkedUri(saveLinkedContentOwner.uri, saveLinkedUri)
							|| !localFileIdentityEquals(saveLinkedContentOwner.identity, saveLinkedIdentity))) {
							throw Object.assign(new Error('The linked-query target changed while Save was capturing its final snapshot.'), { linkedQueryWriteFailed: true });
						}
						const candidateText = serializeDocumentState(saveState);
						sanitizedText = await prepareAtomicSqlSaveText(candidateText);
						if (!saveOwnerIsCurrent()) throw Object.assign(new Error('The linked-query target changed while Save was preparing notebook persistence.'), { linkedQueryWriteFailed: true });
						if (saveLinkedUri) {
							const linkedIndex = findLinkedQuerySectionIndex(saveState.sections);
							if (linkedIndex < 0 || !saveLinkedContentOwner) {
								throw Object.assign(new Error('The linked query file could not be updated.'), { linkedQueryWriteFailed: true });
							}
							const candidateQuery = String((saveState.sections[linkedIndex] as any).query || '');
							const attempt = await applyAndSaveLinkedQueryForOwner(
								candidateQuery, saveLinkedContentOwner, saveOwnerIsCurrent,
							);
							if (!attempt.ok) {
								const message = attempt.reason === 'owner-changed'
									? 'The linked-query target changed during durable Save.'
									: attempt.reason === 'durable-changed'
										? 'The linked query file changed on disk before Save.'
										: attempt.reason === 'update-failed'
											? 'The linked query file could not be updated.'
											: 'The linked query file could not be saved.';
								throw Object.assign(new Error(message), { linkedQueryWriteFailed: true });
							}
							const transaction = attempt.transaction;
							retainLinkedNativeSaveUntilNotebookCommit(
								transaction.uri, transaction.identity, transaction.document, transaction.candidateText,
								transaction.priorBufferText, transaction.priorDurableText, sanitizedText, lastSavedText,
							);
							if (!saveOwnerIsCurrent()) throw Object.assign(new Error('The linked-query target changed during Save.'), { linkedQueryWriteFailed: true });
						}
						pendingNativeResultRestore = { rowFreeText: sanitizedText, candidateText, generation: ++nativeSaveGeneration };
						notifyNativeSaveStateChanged();
					} catch (error) {
						if (error instanceof KqlxOverlayConflictError
							|| (error instanceof Error && error.name === 'KqlxOverlayConflictError')) throw error;
						if ((error as any)?.markdownBarrierFailed === true) throw error;
						if ((error as any)?.linkedQueryWriteFailed === true) throw error;
						if (linkedQueryUri) {
							throw new Error(`Cannot save a linked-query notebook without its final editor snapshot: ${error instanceof Error ? error.message : String(error)}`);
						}
						nativeSaveGeneration++;
						pendingNativeResultRestore = undefined;
						notifyNativeSaveStateChanged();
						getWorkbenchLogger().warn(`[sql-persistence] Final snapshot unavailable; saving fail-closed state: ${error instanceof Error ? error.message : String(error)}`);
						sanitizedText = await sanitizeSerializedNotebookTextFailClosed(document.getText());
					}
					const freshText = document.getText();
					const edits = sanitizedText === freshText
						? []
						: [vscode.TextEdit.replace(
							new vscode.Range(document.positionAt(0), document.positionAt(freshText.length)),
							sanitizedText,
						)];
					if (markdownSaveLease) {
						retainedMarkdownSaveLease = retainNativeMarkdownSaveLease(markdownSaveLease, sanitizedText);
						if (!retainedMarkdownSaveLease) {
							throw Object.assign(new Error('Cannot save because the editor closed before Markdown state could commit.'), {
								markdownBarrierFailed: true,
							});
						}
					}
					return edits;
					} finally {
						if (!retainedMarkdownSaveLease && markdownSaveLease) {
							settleActiveNativeMarkdownSaveLease(markdownSaveLease);
						}
					}
				})();
				const trackedPreparation = preparation.then(() => undefined, () => undefined);
				nativeSavePreparations.add(trackedPreparation);
				void trackedPreparation.then(() => {
					nativeSavePreparations.delete(trackedPreparation);
					notifyNativeSaveStateChanged();
				});
				event.waitUntil(preparation);
			}));
		}
		subscriptions.push(
			vscode.workspace.onDidSaveTextDocument((saved) => {
				try {
					if (normalizeWorkbenchUriKey(saved.uri) !== normalizeWorkbenchUriKey(document.uri)) {
						if (sameLinkedUri(linkedQueryUri, saved.uri)) {
							lastSavedLinkedQueryText = saved.getText();
						}
						return;
					}
					const canonicalSave = canonicalResultRestoreSaveInProgress;
					if (!canonicalSave) settleNativeMarkdownSaveLease(saved.getText());
					let linkedNativeSaveHandled = false;
					const pendingLinkedSave = pendingLinkedNativeSave;
					if (pendingLinkedSave) {
						linkedNativeSaveHandled = true;
						if (saved.getText() === pendingLinkedSave.notebookCandidateText) {
							if (pendingLinkedRollback) {
								const reapplyTask = pendingLinkedRollback.then(() => {
									const rolledBack = rolledBackLinkedNativeSave;
									return rolledBack ? reapplyRolledBackLinkedNativeSave(rolledBack) : true;
								}).then(() => undefined, () => undefined);
								linkedSaveTasks.add(reapplyTask);
								void reapplyTask.finally(() => linkedSaveTasks.delete(reapplyTask));
							} else clearPendingLinkedNativeSave();
						}
						else {
							const rollbackTask = rollbackPendingLinkedNativeSave().then(() => undefined, () => undefined);
							linkedSaveTasks.add(rollbackTask);
							void rollbackTask.finally(() => linkedSaveTasks.delete(rollbackTask));
						}
					} else if (rolledBackLinkedNativeSave) {
						linkedNativeSaveHandled = true;
						const rolledBack = rolledBackLinkedNativeSave;
						if (saved.getText() === rolledBack.notebookCandidateText) {
							const reapplyTask = reapplyRolledBackLinkedNativeSave(rolledBack).then(() => undefined, () => undefined);
							linkedSaveTasks.add(reapplyTask);
							void reapplyTask.finally(() => linkedSaveTasks.delete(reapplyTask));
						} else rolledBackLinkedNativeSave = undefined;
					}
					lastSavedText = saved.getText();
					lastSavedEol = saved.eol;
					// Rebuild section change cache and notify webview that everything is clean.
					rebuildSavedSectionCache(lastSavedText);
					postChangedSectionsClear();
					// Best-effort: when the notebook metadata file is saved, also save the linked query file.
					try {
						if (!linkedNativeSaveHandled && linkedQueryDocument && linkedQueryDocument.isDirty) {
							const saveTask = saveCurrentLinkedQueryDocument().then(() => undefined, () => undefined);
							linkedSaveTasks.add(saveTask);
							void saveTask.finally(() => linkedSaveTasks.delete(saveTask));
						}
					} catch {
						// ignore
					}
					if (canonicalSave) return;
					const pending = pendingNativeResultRestore;
					pendingNativeResultRestore = undefined;
					if (pending && saved.getText() === pending.rowFreeText) {
						canonicalResultRestoreTail = canonicalResultRestoreTail
							.then(() => restoreCanonicalNativeResults(pending), () => restoreCanonicalNativeResults(pending));
					} else {
						void repairPersistedSqlState().catch(() => undefined);
					}
					notifyNativeSaveStateChanged();
				} catch {
					notifyNativeSaveStateChanged();
					// ignore
				}
			})
		);

		// Track if the webview has initialized and whether it's currently being edited by the user.
		// This helps us avoid refreshing the webview for changes that originated from the webview itself.
		let webviewInitialized = false;
		let initialProjectionRecovery: Promise<boolean> | undefined;
		let initialProjectionRestartRequested = false;
		const postInitialDocument = async (): Promise<boolean> => {
			for (let attempt = 0; attempt < INITIAL_PROJECTION_MAX_ATTEMPTS && !outerDisposed; attempt++) {
				const delivered = await postDocument({ forceReload: attempt > 0 });
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
					const currentText = e.document.getText();
					const matchesOwnedDocumentEdit = ownedDocumentEdits.observe(currentText);
					if (!webviewInitialized && e.contentChanges.length > 0) {
						if (initialProjectionRecovery) initialProjectionRestartRequested = true;
						else void ensureInitialDocument();
						return;
					}
					if (!shouldReloadKqlxAfterDocumentChange({
						isSessionFile,
						matchesOwnedSessionWrite: isSessionFile && ownedSessionWrites.observe(currentText),
						matchesOwnedDocumentEdit,
						webviewInitialized,
						contentChangeCount: e.contentChanges.length,
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
					settleAllNativeMarkdownSaveLeases();
					for (const [requestId, pending] of markdownBarrierRequests) {
						settleMarkdownBarrier(requestId, pending);
					}
					projectionSession.settleClose();
					finalPersistSession.settleClose();
					if (saveTimer) {
						clearTimeout(saveTimer);
						saveTimer = undefined;
					}
					const persistenceDrain = (async () => {
						if (isSessionFile) await finalPersistSession.waitForBeforeUnload(500);
						delayedBeforeUnloadAdmissionOpen = false;
						await Promise.allSettled([...admittedPersistenceHandlers]);
						while (linkedSaveTasks.size > 0 || nativeSavePreparations.size > 0) {
							if (linkedSaveTasks.size > 0) await Promise.allSettled([...linkedSaveTasks]);
							if (nativeSavePreparations.size > 0) await Promise.allSettled([...nativeSavePreparations]);
						}
						settleAllNativeMarkdownSaveLeases();
						if (pendingLinkedNativeSave && !await waitForPendingLinkedNativeSaveCommit()) {
							await rollbackPendingLinkedNativeSave(true);
						}
						while (!closeFinalizationAbandoned) {
							if (linkedSaveTasks.size > 0) {
								await Promise.allSettled([...linkedSaveTasks]);
								continue;
							}
							if (nativeSavePreparations.size > 0) {
								await Promise.allSettled([...nativeSavePreparations]);
								continue;
							}
							const observedGeneration = nativeSaveGeneration;
							const observedTail = canonicalResultRestoreTail;
							await observedTail;
							if (closeFinalizationAbandoned) return;
							if (nativeSavePreparations.size === 0
								&& !pendingNativeResultRestore
								&& nativeSaveGeneration === observedGeneration
								&& canonicalResultRestoreTail === observedTail) break;
							const observedStateVersion = nativeSaveStateVersion;
							if (nativeSavePreparations.size === 0 && pendingNativeResultRestore) {
								await waitForNativeSaveStateChange(observedStateVersion);
							}
						}
						if (closeFinalizationAbandoned) return;
						await repairPersistedSqlState(true);
						if (closeFinalizationAbandoned) return;
						await _persistChain;
						await sqlSaveRepairTail;
						await _persistChain;
					})();
					if (!await settlesWithin(persistenceDrain, PERSISTENCE_CLOSE_WAIT_MS)) {
						closeFinalizationAbandoned = true;
						notifyNativeSaveStateChanged();
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
			const delayedSessionPersistence = message && typeof message.type === 'string'
				&& isDelayedSessionPersistenceMessage(message);
			if ((outerDisposed && !delayedSessionPersistence) || !message || typeof message.type !== 'string') {
				return;
			}
			switch (message.type) {
				case 'documentReloadResult': {
						const priorActivation = projectionActivationTail;
						const activationOperation = priorActivation.catch(() => undefined).then(async () => {
							const requestId = String((message as any).requestId || '');
							const applied = (message as any).applied === true;
							const activation = pendingProjectionActivations.get(requestId);
							if (!activation || !projectionSession.hasPendingReloadRequest(requestId)) {
								pendingProjectionActivations.delete(requestId);
								return;
							}
							const accepted = applied
								&& !outerDisposed
								&& activation.generation === postDocumentGeneration
								&& await isProjectionSourceCurrent(activation.sourceText)
								&& pendingProjectionActivations.get(requestId) === activation
								&& projectionSession.hasPendingReloadRequest(requestId);
							const completed = projectionSession.completeReload(
								requestId,
								accepted,
								Number((message as any).editRevision),
							);
							pendingProjectionActivations.delete(requestId);
							if (!completed) return;
							if ((message as any).markdownCommandBarrierSupported === true) {
								markdownCommandBarrierSupported = true;
							}
							if (accepted) {
								activateProjection(activation.generation, activation.sourceText, activation.owner);
							}
						});
						projectionActivationTail = activationOperation.then(() => undefined, () => undefined);
						await activationOperation;
					return;
				}
				case 'requestDocument':
					perfMark('host.kqlx.requestDocument.received');
					fileOpenTrace.mark('requestDocument.received');
					// Re-send mode/capabilities in response to a request (the webview is guaranteed to be listening).
					postPersistenceMode();
					// Only load from disk when explicitly requested by the webview.
					const delivered = webviewInitialized
						? await postDocument({ forceReload: true })
						: await ensureInitialDocument();
					if (outerDisposed) return;
					webviewInitialized = delivered;
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
				case 'markdownDocumentCommandBarrierResult': {
					await projectionActivationTail;
					const requestId = String((message as any).requestId || '').trim();
					const pending = markdownBarrierRequests.get(requestId);
					if (!pending) return;
					if ((message as any).accepted !== true
						|| Number((message as any).sourceGeneration) !== pending.sourceGeneration
						|| pending.sourceGeneration !== activeProjectionGeneration) {
						settleMarkdownBarrier(requestId, pending);
						return;
					}
					const entry = this.markdownDocuments.get(markdownDocumentKey);
					if (entry) {
						while (markdownBarrierRequests.get(requestId) === pending) {
							const observedTail = entry.queue.tail;
							await Promise.race([observedTail.catch(() => undefined), pending.expired]);
							if (markdownBarrierRequests.get(requestId) !== pending) return;
							if (entry.queue.tail === observedTail) break;
						}
					}
					if (markdownBarrierRequests.get(requestId) !== pending) return;
					const currentEntry = this.markdownDocuments.get(markdownDocumentKey);
					const accepted = pending.sourceGeneration === activeProjectionGeneration
						&& currentEntry === entry
						&& activeMarkdownOwnerEntry === entry
						&& (!entry || Number((message as any).documentRevision) === entry.document.revision);
					settleMarkdownBarrier(
						requestId,
						pending,
						accepted ? reserveMarkdownSaveLease(entry, pending.sourceGeneration) : undefined,
					);
					return;
				}
				case 'markdownDocumentCommand': {
					await projectionActivationTail;
					const commandId = String((message as any).commandId || '').trim();
					if (!commandId) return;
					const commandGeneration = Number((message as any).sourceGeneration);
					const entry = activeMarkdownOwnerEntry;
					let commandResult: Record<string, unknown> | undefined;
					const rejectCommand = (code: string, messageText: string) => {
						if (commandResult) return;
						const owner = activeMarkdownOwnerEntry ?? entry;
						commandResult = {
							type: 'markdownDocumentCommandResult', commandId, ok: false,
							sourceGeneration: activeProjectionGeneration,
							documentRevision: owner?.document.revision ?? 0,
							error: { code, message: messageText },
							...(owner ? { projection: owner.document.projection() } : {}),
						};
					};
					const rejectStaleCommand = () => rejectCommand(
						'stale-document-owner',
						`The Markdown command belonged to a retired document owner (generation=${commandGeneration}/${activeProjectionGeneration}, active=${activeMarkdownOwnerEntry === entry}, mapped=${this.markdownDocuments.get(markdownDocumentKey) === entry}).`,
					);
					const deliverCommandResult = async () => {
						if (commandResult && !outerDisposed) {
							await deliverWebviewMessage({ ...commandResult, type: 'markdownDocumentCommandResult' });
						}
					};
					const isCommandCurrent = () => !!entry
						&& Number.isSafeInteger(commandGeneration)
						&& commandGeneration === activeProjectionGeneration
						&& activeMarkdownOwnerEntry === entry
						&& this.markdownDocuments.get(markdownDocumentKey) === entry
						&& (!outerDisposed || isSessionFile)
						&& !closeFinalizationAbandoned;
					if (!entry || !isCommandCurrent()) {
						rejectStaleCommand();
						await deliverCommandResult();
						return;
					}
					const allowDisposedSessionCommand = isSessionFile;
					const previousCommandTail = entry.queue.tail;
					entry.queue.pendingCommands++;
					const operation = previousCommandTail.catch(() => undefined).then(async () => {
						const currentText = await readProjectionSourceText();
						const currentFile = parseKqlxText(currentText, {
							allowedKinds: [documentKind], defaultKind: documentKind,
						});
						if (!currentFile.ok) {
							rejectCommand('invalid-document-source', currentFile.error);
							return;
						}
						const projectedState = ensureProjectedSectionIds(currentFile.file.state, currentText);
						if (!isCommandCurrent() || !rebaseMarkdownOwnerFromSource(entry, currentText, projectedState)) {
							rejectStaleCommand();
							return;
						}
						if (!isCommandCurrent()) {
							commandResult = {
								type: 'markdownDocumentCommandResult', commandId, ok: false,
								sourceGeneration: activeProjectionGeneration,
								documentRevision: entry.document.revision,
								error: { code: 'stale-source-generation', message: 'The Markdown command belonged to an older document projection.' },
								projection: entry.document.projection(),
							};
							return;
						}
						const transition = entry.document.transition({
							expectedDocumentRevision: Number((message as any).expectedDocumentRevision),
							command: (message as any).command,
						});
						if (!transition.ok) {
							commandResult = {
								type: 'markdownDocumentCommandResult', commandId, ok: false,
								sourceGeneration: activeProjectionGeneration,
								documentRevision: transition.documentRevision,
								error: transition.error,
								projection: transition.document.projection(),
							};
							return;
						}
						const candidateText = serializeDocumentState(transition.document.snapshot() as KqlxStateV1, currentText);
						if (!isCommandCurrent()) {
							rejectStaleCommand();
							return;
						}
						let applied = false;
						if (isSessionFile) {
							applied = await saveSessionFileToDisk(
								candidateText,
								isCommandCurrent,
								allowDisposedSessionCommand,
								() => activeProjectionSourceText,
							);
						} else if (document.getText() === currentText) {
							const edit = new vscode.WorkspaceEdit();
							edit.replace(
								document.uri,
								new vscode.Range(document.positionAt(0), document.positionAt(currentText.length)),
								candidateText,
							);
							lastWebviewPersistAt = Date.now();
							applied = await applyOwnedSourceEdit(edit, candidateText)
								&& document.getText() === candidateText;
							if (applied && !isCommandCurrent()) {
								applied = false;
								const rollbackText = commandGeneration === activeProjectionGeneration
									? currentText
									: activeProjectionSourceText;
								if (document.getText() === candidateText && rollbackText !== candidateText) {
									const rollback = new vscode.WorkspaceEdit();
									rollback.replace(
										document.uri,
										new vscode.Range(document.positionAt(0), document.positionAt(candidateText.length)),
										rollbackText,
									);
									lastWebviewPersistAt = Date.now();
									await applyOwnedSourceEdit(rollback, rollbackText);
									if (document.getText() === candidateText) {
										sourceRollbackFailed = true;
										sourceRollbackFailedCandidate = candidateText;
									}
								}
							}
						}
						if (!applied || !isCommandCurrent()) {
							commandResult = {
								type: 'markdownDocumentCommandResult', commandId, ok: false,
								sourceGeneration: activeProjectionGeneration,
								documentRevision: entry.document.revision,
								error: { code: 'document-write-failed', message: 'The Markdown command could not update the document.' },
								projection: entry.document.projection(),
							};
							return;
						}
						entry.document = transition.document;
						entry.sourceText = candidateText;
						commandResult = {
							type: 'markdownDocumentCommandResult', commandId, ok: true,
							sourceGeneration: activeProjectionGeneration,
							documentRevision: transition.documentRevision,
							...(transition.sectionRevision !== undefined ? { sectionRevision: transition.sectionRevision } : {}),
							projection: transition.document.projection(),
						};
					}).catch(error => {
						rejectCommand(
							'markdown-command-failed',
							error instanceof Error ? error.message : String(error),
						);
					}).finally(() => {
						entry.queue.pendingCommands = Math.max(0, entry.queue.pendingCommands - 1);
					});
					entry.queue.tail = operation.then(() => undefined, () => undefined);
					await operation;
					if (!commandResult) rejectCommand('markdown-command-not-applied', 'The Markdown command completed without updating the document.');
					await deliverCommandResult();
					return;
				}
				case 'persistDocument': {
					await projectionActivationTail;
					const flushRequestId = (message as any).flushRequestId;
					const flushUnavailableReason = (message as any).flushUnavailableReason;
					const snapshotId = String((message as any).snapshotId || '').trim();
					const incomingSourceGeneration = Number((message as any).sourceGeneration);
					const sourceGenerationMissing = !Number.isSafeInteger(incomingSourceGeneration);
					if ((snapshotId || flushRequestId) && ((sourceGenerationMissing && this.context.extensionMode === vscode.ExtensionMode.Production)
						|| (!sourceGenerationMissing && incomingSourceGeneration !== activeProjectionGeneration))) {
						if (flushRequestId) {
							finalPersistSession.completeFinalPersist(
								flushRequestId,
								new Error(`The final document snapshot belonged to source generation ${String((message as any).sourceGeneration)}, but the active generation is ${activeProjectionGeneration}.`),
							);
						}
						return;
					}
					const incomingEditRevision = Number((message as any).editRevision);
					finalPersistSession.markBeforeUnload((message as any).reason);
					if (flushRequestId) {
						persistRequestGeneration++;
					}
					if (flushRequestId && flushUnavailableReason) {
						finalPersistSession.completeFinalPersist(
							flushRequestId,
							new Error(`Final document snapshot unavailable: ${flushUnavailableReason}`),
						);
						return;
					}
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
					assertDocumentSectionKindsAllowed(documentKind, incomingState.sections);
					const markdownOwner = activeMarkdownOwnerEntry
						?? this.markdownDocuments.get(markdownDocumentKey);
					let markdownPersistenceLease: MarkdownPersistenceLease | undefined;
					let persistenceBaseText = markdownOwner?.sourceText ?? await readProjectionSourceText();
					if (markdownOwner && !flushRequestId) {
						const leaseGeneration = Number.isSafeInteger(incomingSourceGeneration)
							? incomingSourceGeneration
							: activeProjectionGeneration;
						markdownPersistenceLease = await acquireMarkdownPersistenceLease(
							markdownOwner,
							leaseGeneration,
							persistenceBaseText,
						);
						if (activeMarkdownOwnerEntry !== markdownOwner
							|| this.markdownDocuments.get(markdownDocumentKey) !== markdownOwner
							|| markdownPersistenceLease.revoked
							|| leaseGeneration !== activeProjectionGeneration) {
							markdownPersistenceLease.settle();
							return;
						}
						persistenceBaseText = await readProjectionSourceText();
						markdownPersistenceLease.baseText = persistenceBaseText;
						const durableBase = parseKqlxText(persistenceBaseText, {
							allowedKinds: [documentKind], defaultKind: documentKind,
						});
						if (durableBase.ok) {
							const durableState = ensureProjectedSectionIds(durableBase.file.state, persistenceBaseText);
							if (!rebaseMarkdownOwnerFromSource(markdownOwner, persistenceBaseText, durableState)) {
								markdownPersistenceLease.settle();
								return;
							}
						}
					}
					let state: KqlxStateV1;
					try {
						state = markdownOwner
							? overlayOwnedMarkdownState(incomingState, markdownOwner.document)
							: incomingState;
					} catch (error) {
						markdownPersistenceLease?.settle();
						throw error;
					}
					if (flushRequestId) {
						finalPersistSession.completeFinalPersist(flushRequestId, undefined, state);
						markdownPersistenceLease?.settle();
						return;
					}
					const persistGeneration = ++persistRequestGeneration;
					const reloadEpochAtAdmission = sourceReloadEpoch;
					const persistReason = String((message as any).reason || '');
					const allowDisposedPersist = isSessionFile && persistReason === 'beforeunload';
					const isPersistCurrent = () => (allowDisposedPersist || !outerDisposed)
						&& !closeFinalizationAbandoned
						&& persistRequestGeneration === persistGeneration
						&& (!markdownPersistenceLease || (
							markdownOwner?.queue.activePersistenceLeases.has(markdownPersistenceLease) === true
							&& !markdownPersistenceLease.revoked
							&& markdownPersistenceLease.generation === activeProjectionGeneration
						));
					const previousPersistDecision = persistDecisionTail;
					let releasePersistDecision!: () => void;
					const persistDecision = new Promise<void>(resolve => { releasePersistDecision = resolve; });
					persistDecisionTail = previousPersistDecision.catch(() => undefined).then(() => persistDecision);
					await previousPersistDecision.catch(() => undefined);
					let saveDocumentAfterDecision = false;
					let persistAccepted = false;
					let linkedSessionRollback: {
						uri: vscode.Uri;
						identity: LocalFileIdentity;
						document: vscode.TextDocument;
						candidateText: string;
						priorBufferText: string;
						priorDurableText: string;
					} | undefined;
					try {
						if (!isPersistCurrent()) return;
					// Track that the webview is persisting, so we don't treat the resulting
					// onDidChangeTextDocument event as an external change.
					lastWebviewPersistAt = Date.now();

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

					// If this notebook links a query to an external file, keep the link stable
					// and persist query edits into that linked file (so Save can save both).
					if (linkedQueryUri && Array.isArray(state.sections) && state.sections.length > 0) {
							const linkedIndex = findLinkedQuerySectionIndex(state.sections);
							if (linkedIndex >= 0) {
								const linkedSection = state.sections[linkedIndex] as any;
								if (linkedQueryPathRaw) {
									linkedSection.linkedQueryPath = linkedQueryPathRaw;
								}
								const q = typeof linkedSection.query === 'string' ? String(linkedSection.query) : '';
								const priorLinkedDocument = isSessionFile ? await getOrOpenLinkedQueryDocument() : undefined;
								const priorBufferText = priorLinkedDocument?.getText();
								const priorDurableText = isSessionFile && linkedQueryUri ? await tryReadTextFile(linkedQueryUri) : undefined;
								const priorIdentity = linkedQueryPhysicalIdentity;
								if (!await applyLinkedQueryTextToDocument(q, isPersistCurrent)) {
									throw new Error('The linked query file could not be updated.');
								}
								if (isSessionFile && linkedQueryUri && priorIdentity && priorLinkedDocument
									&& priorBufferText !== undefined && priorDurableText !== undefined) {
									linkedSessionRollback = {
										uri: linkedQueryUri, identity: priorIdentity, document: priorLinkedDocument,
										candidateText: priorLinkedDocument.getText(), priorBufferText, priorDurableText,
									};
								}
							}
						}
					if (!isPersistCurrent()) return;
					const persistSessionWithRollback = async (sessionText: string): Promise<boolean> => {
						const saved = await saveSessionSnapshot(
							sessionText,
							isPersistCurrent,
							allowDisposedPersist,
							() => markdownPersistenceLease?.revocationAuthority?.sourceText
								?? markdownPersistenceLease?.baseText
								?? persistenceBaseText,
						);
						if (saved || !linkedSessionRollback) return saved;
						const rollback = linkedSessionRollback;
						linkedSessionRollback = undefined;
						const restored = await restoreLinkedSaveSnapshot(
							rollback.uri, rollback.identity, rollback.document, rollback.candidateText,
							rollback.priorBufferText, rollback.priorDurableText,
						);
						if (!restored) linkedRollbackFailed = true;
						return false;
					};

					const currentText = isSessionFile ? persistenceBaseText : document.getText();
					const incomingComparable = normalizeKqlxFileForPersistenceComparison(overlayComparisonFile(currentText, state));

					let incomingMatchesDisk = false;
					let diskTextForMatch = '';

					// If the incoming state matches what was last saved (even if the in-memory document has
					// different formatting), restore that exact saved text. This allows VS Code to clear the
					// dirty indicator when a user "returns" to the saved state.
					let nextText = '';
					try {
						const parsedSaved = parseKqlxText(lastSavedText, {
							allowedKinds: [documentKind],
							defaultKind: documentKind
						});
						if (parsedSaved.ok) {
							const savedState = (() => {
								try {
									if (!linkedQueryUri) return parsedSaved.file.state;
									return withLinkedQueryText(
										ensureProjectedSectionIds(parsedSaved.file.state, lastSavedText),
										lastSavedLinkedQueryText,
									);
								} catch {
									return parsedSaved.file.state;
								}
							})();
							const savedComparable = normalizeKqlxFileForPersistenceComparison(parsedSaved.file, savedState);
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
							if (!isPersistCurrent()) return;
							const diskText = normalizeTextToEol(new TextDecoder('utf-8').decode(bytes), document.eol);
							const parsedDisk = parseKqlxText(diskText, {
								allowedKinds: [documentKind],
								defaultKind: documentKind
							});
							if (parsedDisk.ok) {
								const diskState = (() => {
									try {
										if (!linkedQueryUri) return parsedDisk.file.state;
										let linkedText = '';
										try {
											linkedText = linkedQueryDocument ? linkedQueryDocument.getText() : lastSavedLinkedQueryText;
										} catch {
											linkedText = lastSavedLinkedQueryText;
										}
										return withLinkedQueryText(
											ensureProjectedSectionIds(parsedDisk.file.state, diskText),
											linkedText,
										);
									} catch {
										return parsedDisk.file.state;
									}
								})();
								const diskComparable = normalizeKqlxFileForPersistenceComparison(parsedDisk.file, diskState);
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
							if (!isPersistCurrent()) return;
							const diskText = normalizeTextToEol(new TextDecoder('utf-8').decode(bytes), document.eol);
							if (diskText && diskText === nextText) {
								const parsedDisk = parseKqlxText(diskText, {
									allowedKinds: [documentKind],
									defaultKind: documentKind
								});
								if (parsedDisk.ok) {
									const diskComparable = normalizeKqlxFileForPersistenceComparison(parsedDisk.file);
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
								allowedKinds: [documentKind],
								defaultKind: documentKind
							});
							if (parsedCurrent.ok) {
								const currentState = (() => {
									try {
										if (!linkedQueryUri) return parsedCurrent.file.state;
										let linkedText = '';
										try {
											linkedText = linkedQueryDocument ? linkedQueryDocument.getText() : lastSavedLinkedQueryText;
										} catch {
											linkedText = lastSavedLinkedQueryText;
										}
										return withLinkedQueryText(
											ensureProjectedSectionIds(parsedCurrent.file.state, currentText),
											linkedText,
										);
									} catch {
										return parsedCurrent.file.state;
									}
								})();
								const currentComparable = normalizeKqlxFileForPersistenceComparison(parsedCurrent.file, currentState);
								if (deepEqual(currentComparable, incomingComparable)) {
									// If this persist is from a reorder and the state matches disk, force a save to clear
									// the dirty flag (VS Code sometimes keeps custom editors dirty even after reverting).
									if (!isSessionFile && persistReason === 'reorder' && incomingMatchesDisk) {
										try {
											if (diskTextForMatch && diskTextForMatch === currentText && document.isDirty) {
												saveDocumentAfterDecision = true;
											}
										} catch {
											// ignore
										}
									}
									// For session files, ensure the current content is written to disk.
									// This handles cases where the in-memory state matches what we want,
									// but the disk content might be stale (e.g., results just added).
									if (isSessionFile) {
										persistAccepted = await persistSessionWithRollback(currentText);
									} else {
										persistAccepted = true;
									}
									return;
								}
							}
						} catch {
							// ignore
						}
					}

					// The snapshot is still pending until this fresh policy pass and publication succeed.
					const freshState = await queryEditor.sanitizeSqlLeaveNoTraceStateFresh(state);
					assertDocumentSectionKindsAllowed(documentKind, freshState.sections);
					if (!isPersistCurrent()) return;
					const policyChangedState = !deepEqual(
						normalizeStateForPersistenceComparison(freshState),
						normalizeStateForPersistenceComparison(state),
					);
					if (!nextText || policyChangedState) {
						nextText = serializeDocumentState(freshState, currentText);
					}
					// If nothing changed, avoid toggling the dirty state.
					try {
						if (nextText === currentText) {
							if (!isSessionFile && persistReason === 'reorder' && incomingMatchesDisk) {
								try {
									if (diskTextForMatch && diskTextForMatch === currentText && document.isDirty) {
										saveDocumentAfterDecision = true;
									}
								} catch {
									// ignore
								}
							}
							// For session files, ensure the current content is written to disk.
							if (isSessionFile) {
								persistAccepted = await persistSessionWithRollback(currentText);
							} else {
								persistAccepted = true;
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
						persistAccepted = await persistSessionWithRollback(nextText);
						return;
					}
					if (!isPersistCurrent()) return;

					// For non-session files, use the standard edit→save cycle.
					// Serialize through _persistChain so applyEdit calls never overlap.
						const editAttempt = _persistChain.catch(() => undefined).then(async () => {
							if (!isPersistCurrent()) return false;
						let baseText = currentText;
						let candidateText = nextText;
						for (let attempt = 0; attempt < 3; attempt++) {
							candidateText = await sanitizeSerializedNotebookTextFresh(candidateText);
								if (!isPersistCurrent()) return false;
							const latestText = document.getText();
							if (latestText !== baseText) {
								baseText = latestText;
								candidateText = serializeDocumentState(freshState, latestText);
								continue;
							}
							const fullRange = new vscode.Range(
								document.positionAt(0),
								document.positionAt(latestText.length)
							);
							const edit = new vscode.WorkspaceEdit();
							edit.replace(document.uri, fullRange, candidateText);
							lastWebviewPersistAt = Date.now();
								if (!await applyOwnedSourceEdit(edit, candidateText)) continue;
								if (document.getText() !== candidateText) {
									void postDocument({ forceReload: true });
									return false;
								}
								if (!isPersistCurrent()) {
									const leaseLostAuthority = !!markdownPersistenceLease && (
										markdownPersistenceLease.revoked
										|| markdownOwner?.queue.activePersistenceLeases.has(markdownPersistenceLease) !== true
										|| markdownPersistenceLease.generation !== activeProjectionGeneration
									);
									const authority = leaseLostAuthority
										? {
											epoch: sourceReloadEpoch,
											text: markdownPersistenceLease?.revocationAuthority?.sourceText
												?? markdownPersistenceLease?.baseText
												?? persistenceBaseText,
										}
										: sourceReloadAuthority;
									if (authority && (leaseLostAuthority || authority.epoch > reloadEpochAtAdmission)
										&& (leaseLostAuthority || sourceReloadAuthority === authority)
										&& document.getText() === candidateText) {
										sourceRollbackFailed = true;
										sourceRollbackFailedCandidate = candidateText;
										for (let rollbackAttempt = 0; rollbackAttempt < 3; rollbackAttempt++) {
											if ((!leaseLostAuthority && sourceReloadAuthority !== authority)
												|| document.getText() !== candidateText) break;
											const rollback = new vscode.WorkspaceEdit();
											rollback.replace(
												document.uri,
												new vscode.Range(document.positionAt(0), document.positionAt(candidateText.length)),
												authority.text,
											);
											lastWebviewPersistAt = Date.now();
											await applyOwnedSourceEdit(rollback, authority.text);
											if (document.getText() === authority.text) break;
										}
										if (document.getText() === candidateText) {
											sourceRollbackFailed = true;
											sourceRollbackFailedCandidate = candidateText;
										} else {
											sourceRollbackFailed = false;
											sourceRollbackFailedCandidate = undefined;
										}
									}
									return false;
								}
							nextText = candidateText;
								return true;
						}
						throw new Error('The Kusto Workbench document kept changing during persistence.');
						});
						_persistChain = editAttempt.then(() => undefined, () => undefined);
						const editApplied = await editAttempt;
						if (!editApplied) return;
						persistAccepted = true;

					// If we just restored the file back to the exact on-disk content due to a reorder undo,
					// force a save to ensure VS Code clears the dirty flag.
					if (persistReason === 'reorder' && incomingMatchesDisk) {
						try {
							if (diskTextForMatch && diskTextForMatch === nextText && document.isDirty) {
								saveDocumentAfterDecision = true;
							}
						} catch {
							// ignore
						}
					}

					// For user-picked files, saving stays user-controlled (or governed by VS Code autosave settings).
					scheduleSave();
					return;
					} finally {
						try {
							if (!persistAccepted && linkedSessionRollback) {
								const rollback = linkedSessionRollback;
								linkedSessionRollback = undefined;
								try {
									const restored = await restoreLinkedSaveSnapshot(
										rollback.uri, rollback.identity, rollback.document, rollback.candidateText,
										rollback.priorBufferText, rollback.priorDurableText,
									);
									if (!restored) linkedRollbackFailed = true;
								} catch {
									linkedRollbackFailed = true;
									getWorkbenchLogger().warn('[kusto] Failed to restore a linked-query snapshot after persistence failure.');
								}
							}
							if (persistAccepted && markdownOwner
								&& activeMarkdownOwnerEntry === markdownOwner
								&& this.markdownDocuments.get(markdownDocumentKey) === markdownOwner) {
								try {
									const acceptedText = await readProjectionSourceText();
									const acceptedFile = parseKqlxText(acceptedText, {
										allowedKinds: [documentKind], defaultKind: documentKind,
									});
									if (acceptedFile.ok) {
										markdownOwner.document = markdownOwner.document.withAdapterState(
											ensureProjectedSectionIds(acceptedFile.file.state, acceptedText),
										);
										markdownOwner.sourceText = acceptedText;
									}
								} catch {
									// A later source event will rematerialize the adapter state.
								}
							}
							if (persistAccepted && snapshotId && Number.isSafeInteger(incomingEditRevision) && !outerDisposed) {
								try {
									await webviewPanel.webview.postMessage({
										type: 'persistDocumentAck', snapshotId, editRevision: incomingEditRevision,
									});
								} catch {
									// A lost acknowledgement keeps the webview snapshot pending and retryable.
								}
							}
						} finally {
							releasePersistDecision();
							markdownPersistenceLease?.settle();
						}
						if (saveDocumentAfterDecision && !outerDisposed) {
							try { await document.save(); } catch { /* ignore */ }
						}
					}
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
							allowedKinds: [documentKind],
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

