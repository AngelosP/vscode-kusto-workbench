import {
	defaultSectionKindForDocument,
	canonicalSectionKind,
	type AddableSectionKind,
	type WorkbenchDocumentKind,
} from '../../src/shared/documentSectionCapabilities';
import {
	parseKqlxText,
	type KqlxFileV1,
	type KqlxParseResult,
	type KqlxStateV1,
} from '../../src/host/kqlxFormat';
import type { BrowserCompanionState } from './companion-state';
import { getUnsupportedNativeDocumentReason } from '../../src/shared/nativeDocumentValidation';

export type { BrowserCompanionState } from './companion-state';

export type BrowserWorkbenchFile = KqlxFileV1;
export type BrowserWorkbenchParseResult = KqlxParseResult;

export function parseBrowserWorkbenchText(
	text: string,
	options?: Readonly<{
		allowedKinds?: readonly WorkbenchDocumentKind[];
		defaultKind?: WorkbenchDocumentKind;
	}>,
): BrowserWorkbenchParseResult {
	return parseKqlxText(text, options);
}

export function parseBrowserNativeWorkbenchText(
	text: string,
	options?: Readonly<{
		allowedKinds?: readonly WorkbenchDocumentKind[];
		defaultKind?: WorkbenchDocumentKind;
	}>,
): BrowserWorkbenchParseResult {
	const parsed = parseBrowserWorkbenchText(text, options);
	if (!parsed.ok) return parsed;
	const unsupportedReason = getUnsupportedNativeDocumentReason(parsed.file.state);
	return unsupportedReason ? { ok: false, error: unsupportedReason } : parsed;
}

export function browserDefaultSectionKind(kind: WorkbenchDocumentKind): AddableSectionKind {
	return defaultSectionKindForDocument(kind);
}

export function browserCanonicalSectionKind(sectionKind: unknown): string {
	return canonicalSectionKind(sectionKind) ?? String(sectionKind ?? '');
}

export type BrowserCompatibilityStateResult =
	| Readonly<{ ok: true; state: KqlxStateV1 }>
	| Readonly<{ ok: false; error: string }>;

export type BrowserCompatibilityDocumentResult =
	| Readonly<{ ok: true; file: KqlxFileV1 }>
	| Readonly<{ ok: false; error: string }>;

export type BrowserCompatibilityOwner = Readonly<{
	expectedFilename: string;
	rawContentUrl?: string;
	sidecarUrl?: string;
}>;

function normalizeProviderPath(value: string): string {
	const normalized = value.replace(/\\/g, '/');
	const segments: string[] = [];
	for (const segment of normalized.split('/')) {
		if (!segment || segment === '.') continue;
		if (segment === '..') segments.pop();
		else segments.push(segment);
	}
	return `/${segments.join('/')}`;
}

function companionTargetsOwner(linkedPath: string, owner: BrowserCompatibilityOwner): boolean {
	if (owner.rawContentUrl && owner.sidecarUrl) {
		try {
			const rawUrl = new URL(owner.rawContentUrl);
			const companionUrl = new URL(owner.sidecarUrl);
			const rawProviderPath = rawUrl.searchParams.get('path');
			const companionProviderPath = companionUrl.searchParams.get('path');
			if (rawProviderPath !== null || companionProviderPath !== null) {
				if (rawProviderPath === null || companionProviderPath === null) return false;
				const companionDirectory = companionProviderPath.replace(/\\/g, '/').replace(/\/[^/]*$/, '/');
				return normalizeProviderPath(`${companionDirectory}${linkedPath}`) === normalizeProviderPath(rawProviderPath);
			}
			const linkedUrl = new URL(linkedPath, companionUrl);
			if (linkedUrl.origin !== rawUrl.origin || linkedUrl.pathname !== rawUrl.pathname) return false;
			if (linkedPath.includes('?')) return linkedUrl.search === rawUrl.search;
			return companionUrl.search === rawUrl.search;
		} catch {
			return false;
		}
	}
	return linkedPath.replace(/\\/g, '/').replace(/^\.\//, '') === owner.expectedFilename;
}

export function composeBrowserCompatibilityDocument(
	queryText: string,
	companion: BrowserCompanionState = { status: 'missing' },
	owner?: BrowserCompatibilityOwner,
): BrowserCompatibilityDocumentResult {
	if (companion.status === 'missing') {
		return {
			ok: true,
			file: { kind: 'kqlx', version: 1, state: { sections: [{ type: 'query', query: queryText }] } },
		};
	}
	if (companion.status === 'error') return { ok: false, error: `Failed to load companion file: ${companion.error}` };
	const parsed = parseBrowserWorkbenchText(companion.content, { allowedKinds: ['kqlx'], defaultKind: 'kqlx' });
	if (!parsed.ok) return parsed;
	const sections = parsed.file.state.sections.map(section => ({ ...(section as Record<string, unknown>) }));
	const primary = sections[0];
	if (!primary || browserCanonicalSectionKind(primary.type) !== 'query') {
		return { ok: false, error: 'Invalid companion file: the first section must be the linked Kusto query.' };
	}
	const linkedPath = typeof primary.linkedQueryPath === 'string' ? primary.linkedQueryPath.trim() : '';
	if (!linkedPath) return { ok: false, error: 'Invalid companion file: the first query section is not linked.' };
	if (owner && !companionTargetsOwner(linkedPath, owner)) {
		return { ok: false, error: 'Invalid companion file: linkedQueryPath targets a different file.' };
	}
	primary.query = queryText;
	delete primary.linkedQueryPath;
	return {
		ok: true,
		file: {
			...parsed.file,
			state: { ...parsed.file.state, sections } as KqlxStateV1,
		},
	};
}

export function composeBrowserCompatibilityState(
	queryText: string,
	companion: BrowserCompanionState = { status: 'missing' },
	owner?: BrowserCompatibilityOwner,
): BrowserCompatibilityStateResult {
	const result = composeBrowserCompatibilityDocument(queryText, companion, owner);
	return result.ok ? { ok: true, state: result.file.state } : result;
}

export type BrowserViewerDocumentPayload = Readonly<{
	filename: string;
	content: string;
	companionState: BrowserCompanionState;
	rawContentUrl?: string;
	sidecarUrl?: string;
}>;

export type BrowserViewerDocumentResult =
	| Readonly<{ ok: true; file: KqlxFileV1 }>
	| Readonly<{ ok: false; title: string; error: string }>;

export function parseBrowserViewerDocument(payload: BrowserViewerDocumentPayload): BrowserViewerDocumentResult {
	const filename = String(payload.filename || '');
	const lowerFilename = filename.toLowerCase();
	if (lowerFilename.endsWith('.kqlx') || lowerFilename.endsWith('.mdx')) {
		const expectedKind = lowerFilename.endsWith('.mdx') ? 'mdx' : 'kqlx';
		const parsed = parseBrowserNativeWorkbenchText(payload.content, {
			allowedKinds: [expectedKind],
			defaultKind: expectedKind,
		});
		return parsed.ok ? parsed : { ok: false, title: 'Invalid .kqlx file', error: parsed.error };
	}
	if (lowerFilename.endsWith('.sqlx')) {
		const parsed = parseBrowserNativeWorkbenchText(payload.content, {
			allowedKinds: ['sqlx'],
			defaultKind: 'sqlx',
		});
		return parsed.ok ? parsed : { ok: false, title: 'Invalid .sqlx file', error: parsed.error };
	}
	if (lowerFilename.endsWith('.kql.json') || lowerFilename.endsWith('.csl.json')) {
		const parsed = parseBrowserWorkbenchText(payload.content, { allowedKinds: ['kqlx'] });
		return parsed.ok ? parsed : { ok: false, title: 'Invalid sidecar file', error: parsed.error };
	}
	if (lowerFilename.endsWith('.kql') || lowerFilename.endsWith('.csl')) {
		const composed = composeBrowserCompatibilityDocument(payload.content, payload.companionState, {
			expectedFilename: filename,
			rawContentUrl: payload.rawContentUrl,
			sidecarUrl: payload.sidecarUrl,
		});
		return composed.ok
			? composed
			: { ok: false, title: 'Invalid companion file', error: composed.error };
	}
	return {
		ok: false,
		title: 'Unsupported file type',
		error: 'Supported: .kqlx, .sqlx, .mdx, .kql, .csl, .kql.json, .csl.json',
	};
}