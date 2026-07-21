import * as path from 'path';
import * as vscode from 'vscode';

import type { KqlxFileV1, KqlxStateV1 } from './kqlxFormat';

export type CompatPrimarySectionKind = 'query' | 'sql';
export type CompatSidecarKind = 'kqlx' | 'sqlx';

export type CompatSidecarFormat = Readonly<{
	primaryKind: CompatPrimarySectionKind;
	acceptedPrimaryKinds: readonly string[];
	sidecarKind: CompatSidecarKind;
}>;

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
		if (/^[a-zA-Z]:\\/.test(raw) || raw.startsWith('\\\\')) return vscode.Uri.file(raw);
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
			return resolved.fsPath.toLowerCase() === compatDocumentUri.fsPath.toLowerCase();
		}
		return resolved.toString() === compatDocumentUri.toString();
	} catch {
		return false;
	}
}

export function hydrateCompatSidecarState(
	file: KqlxFileV1,
	primaryText: string,
	format: Pick<CompatSidecarFormat, 'primaryKind' | 'acceptedPrimaryKinds'>,
): KqlxStateV1 {
	const rawSections = Array.isArray(file.state.sections) ? file.state.sections : [];
	const sections = rawSections.map(section => ({ ...(section as Record<string, unknown>) }));
	if (sections.length === 0 || !format.acceptedPrimaryKinds.includes(String(sections[0]?.type || ''))) {
		sections.unshift({ type: format.primaryKind });
	}
	sections[0] = { ...sections[0], type: format.primaryKind, query: primaryText };
	delete sections[0].linkedQueryPath;
	return {
		caretDocsEnabled: file.state.caretDocsEnabled,
		autoTriggerAutocompleteEnabled: file.state.autoTriggerAutocompleteEnabled,
		sections: sections as KqlxStateV1['sections'],
	};
}

export function buildCompatSidecarFile(
	compatUri: vscode.Uri,
	state: KqlxStateV1,
	format: CompatSidecarFormat,
): KqlxFileV1 {
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
	return {
		kind: format.sidecarKind,
		version: 1,
		state: {
			caretDocsEnabled: state.caretDocsEnabled,
			autoTriggerAutocompleteEnabled: state.autoTriggerAutocompleteEnabled,
			sections: sections as KqlxStateV1['sections'],
		},
	};
}