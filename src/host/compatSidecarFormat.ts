import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

import { overlayKqlxFileState, type KqlxFileV1, type KqlxStateV1 } from './kqlxFormat';
import { normalizeWorkbenchUriKey } from './workbenchFileTypes';

export type CompatPrimarySectionKind = 'query' | 'sql';
export type CompatSidecarKind = 'kqlx' | 'sqlx';

export type CompatSidecarFormat = Readonly<{
	primaryKind: CompatPrimarySectionKind;
	acceptedPrimaryKinds: readonly string[];
	sidecarKind: CompatSidecarKind;
}>;

export const canonicalCompatSectionType = (value: unknown): string => {
	const type = String((value as Record<string, unknown> | undefined)?.type || '');
	return type === 'copilotQuery' ? 'query' : type;
};

export function hasAmbiguousCompatIdlessSections(file: KqlxFileV1): boolean {
	const counts = new Map<string, number>();
	for (const section of Array.isArray(file.state.sections) ? file.state.sections : []) {
		const record = section as Record<string, unknown>;
		if (String(record.id || '').trim()) continue;
		const type = canonicalCompatSectionType(record);
		const next = (counts.get(type) ?? 0) + 1;
		if (next > 1) return true;
		counts.set(type, next);
	}
	return false;
}

function ensureCompatSectionIds(file: KqlxFileV1): KqlxFileV1 {
	const existing = new Set(file.state.sections
		.map(section => String((section as Record<string, unknown>).id || '').trim())
		.filter(Boolean));
	let changed = false;
	const sections = file.state.sections.map((section, index) => {
		const record = section as Record<string, unknown>;
		if (typeof record.id === 'string' && record.id.trim()) return section;
		const type = (canonicalCompatSectionType(record) || 'section').replace(/[^a-z0-9_-]/gi, '_') || 'section';
		let candidate = `compat_${index + 1}_${type}`;
		let suffix = 1;
		while (existing.has(candidate)) candidate = `compat_${index + 1}_${type}_${suffix++}`;
		existing.add(candidate);
		changed = true;
		return { ...record, id: candidate } as KqlxStateV1['sections'][number];
	});
	return changed ? { ...file, state: { ...file.state, sections } } : file;
}

export function getCompatSidecarUri(uri: vscode.Uri, extensions: readonly string[]): vscode.Uri | undefined {
	try {
		const uriPath = String(uri.path || '').toLowerCase();
		if (!extensions.some(extension => uriPath.endsWith(extension.toLowerCase()))) return undefined;
		return uri.with({ path: `${uri.path}.json` });
	} catch {
		return undefined;
	}
}

export function resolveCompatLinkedUri(sidecarUri: vscode.Uri, linkedPath: string): vscode.Uri {
	try {
		const raw = String(linkedPath || '').trim();
		if (!raw) return sidecarUri;
		try {
			if (/^file:\/\//i.test(raw)) return vscode.Uri.parse(raw);
		} catch {
			// Fall through to path resolution.
		}
		if (/^[a-zA-Z]:[\\/]/.test(raw) || path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw)) {
			return vscode.Uri.file(raw);
		}
		const directory = path.posix.dirname(sidecarUri.path);
		return sidecarUri.with({ path: path.posix.normalize(path.posix.join(directory, raw)) });
	} catch {
		return sidecarUri;
	}
}

export function isLinkedCompatSidecar(
	sidecarUri: vscode.Uri,
	sidecarFile: KqlxFileV1,
	compatDocumentUri: vscode.Uri,
	acceptedPrimaryKinds: readonly string[],
): boolean {
	try {
		const sections = Array.isArray(sidecarFile?.state?.sections) ? sidecarFile.state.sections : [];
		const first = sections[0] as Record<string, unknown> | undefined;
		if (!acceptedPrimaryKinds.includes(String(first?.type || ''))) return false;
		const linkedPath = String(first?.linkedQueryPath || '').trim();
		if (!linkedPath) return false;
		const resolved = resolveCompatLinkedUri(sidecarUri, linkedPath);
		if (resolved.scheme === 'file' && compatDocumentUri.scheme === 'file') {
			try {
				const resolvedRealPath = fs.realpathSync.native(resolved.fsPath);
				const compatRealPath = fs.realpathSync.native(compatDocumentUri.fsPath);
				if (normalizeWorkbenchUriKey(vscode.Uri.file(resolvedRealPath))
					=== normalizeWorkbenchUriKey(vscode.Uri.file(compatRealPath))) return true;
				const resolvedStat = fs.statSync(resolvedRealPath);
				const compatStat = fs.statSync(compatRealPath);
				return resolvedStat.dev === compatStat.dev && resolvedStat.ino !== 0 && resolvedStat.ino === compatStat.ino;
			} catch {
				// Fall back to URI identity when either path does not yet exist.
			}
		}
		return normalizeWorkbenchUriKey(resolved) === normalizeWorkbenchUriKey(compatDocumentUri);
	} catch {
		return false;
	}
}

export function hydrateCompatSidecarState(
	file: KqlxFileV1,
	primaryText: string,
	format: Pick<CompatSidecarFormat, 'primaryKind' | 'acceptedPrimaryKinds'>,
): KqlxStateV1 {
	file = ensureCompatSectionIds(file);
	const rawSections = Array.isArray(file.state.sections) ? file.state.sections : [];
	const sections = rawSections.map(section => ({ ...(section as Record<string, unknown>) }));
	if (sections.length === 0 || !format.acceptedPrimaryKinds.includes(String(sections[0]?.type || ''))) {
		sections.unshift({ type: format.primaryKind });
	}
	sections[0] = { ...sections[0], type: format.primaryKind, query: primaryText };
	delete sections[0].linkedQueryPath;
	return {
		...file.state,
		sections: sections as KqlxStateV1['sections'],
	};
}

export function buildCompatSidecarFile(
	compatUri: vscode.Uri,
	state: KqlxStateV1,
	format: CompatSidecarFormat,
	baseFile?: KqlxFileV1,
): KqlxFileV1 {
	const projectsExactBaseline = !!baseFile && state === baseFile.state;
	const sections = (Array.isArray(state.sections) ? state.sections : [])
		.map(section => ({ ...(section as Record<string, unknown>) }));
	if (sections.length === 0 || !format.acceptedPrimaryKinds.includes(String(sections[0]?.type || ''))) {
		sections.unshift({ type: format.primaryKind });
	}
	sections[0] = {
		...sections[0],
		type: format.primaryKind,
		linkedQueryPath: path.posix.basename(compatUri.path),
	};
	delete sections[0].query;
	const projected: KqlxFileV1 = {
		kind: format.sidecarKind,
		version: 1,
		state: {
			...state,
			sections: sections as KqlxStateV1['sections'],
		},
	};
	const materializedBase = baseFile ? ensureCompatSectionIds(baseFile) : undefined;
	let projectedState = projected.state;
	let overlayBase = materializedBase;
	if (baseFile && materializedBase) {
		const generatedIdsByType = new Map<string, string[]>();
		baseFile.state.sections.forEach((section, index) => {
			if (String((section as Record<string, unknown>).id || '').trim()) return;
			const id = String((materializedBase.state.sections[index] as Record<string, unknown>)?.id || '');
			const type = canonicalCompatSectionType(section);
			generatedIdsByType.set(type, [...(generatedIdsByType.get(type) ?? []), id]);
		});
		const ambiguousTypes = new Set([...generatedIdsByType].filter(([, ids]) => ids.length > 1).map(([type]) => type));
		const projectedHasAmbiguousIdless = projectedState.sections.some(section =>
			!String((section as Record<string, unknown>).id || '').trim()
			&& ambiguousTypes.has(canonicalCompatSectionType(section)),
		);
		if (projectedHasAmbiguousIdless) {
			if (projectsExactBaseline && projectedState.sections.length === materializedBase.state.sections.length) {
				projectedState = {
					...projectedState,
					sections: projectedState.sections.map((section, index) => {
						const baseSection = materializedBase.state.sections[index] as Record<string, unknown> | undefined;
						const record = section as Record<string, unknown>;
						const id = String(baseSection?.id || '');
						return id && canonicalCompatSectionType(record) === canonicalCompatSectionType(baseSection)
							? { ...record, id } as KqlxStateV1['sections'][number]
							: section;
					}),
				};
			} else {
				overlayBase = undefined;
			}
		} else {
			const queues = new Map([...generatedIdsByType].map(([type, ids]) => [type, [...ids]]));
			projectedState = {
				...projectedState,
				sections: projectedState.sections.map(section => {
					const record = section as Record<string, unknown>;
					if (String(record.id || '').trim()) return section;
					const id = queues.get(canonicalCompatSectionType(record))?.shift();
					return id ? { ...record, id } as KqlxStateV1['sections'][number] : section;
				}),
			};
		}
	}
	const merged = overlayBase
		? overlayKqlxFileState(overlayBase, projectedState, format.sidecarKind)
		: projected;
	return ensureCompatSectionIds(merged);
}