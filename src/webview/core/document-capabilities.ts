import {
	addableSectionKindsForDocument,
	assertDocumentSectionKindsAllowed,
	canonicalAddableSectionKind,
	canonicalSectionKind,
	defaultSectionKindForDocument,
	isKnownSectionKindAllowed,
	isWorkbenchDocumentKind,
	type AddableSectionKind,
	type WorkbenchDocumentKind,
} from '../../shared/documentSectionCapabilities.js';
import { pState } from '../shared/persistence-state.js';

export function getProjectedDocumentKind(): WorkbenchDocumentKind | undefined {
	if (isWorkbenchDocumentKind(pState.documentKind)) return pState.documentKind;
	switch (pState.upgradeRequestType) {
		case 'requestUpgradeToKqlx': return 'kqlx';
		case 'requestUpgradeToSqlx': return 'sqlx';
		case 'requestUpgradeToMdx': return 'mdx';
		default: return undefined;
	}
}

function normalizeProjectedKinds(
	documentKind: WorkbenchDocumentKind,
	values: readonly unknown[],
): AddableSectionKind[] {
	const projectedKinds = new Set<AddableSectionKind>();
	for (const value of values) {
		const sectionKind = canonicalAddableSectionKind(documentKind, value);
		if (sectionKind) projectedKinds.add(sectionKind);
	}
	return addableSectionKindsForDocument(documentKind).filter(sectionKind => projectedKinds.has(sectionKind));
}

export function applyDocumentCapabilityProjection(message: Record<string, unknown>): void {
	if (typeof message.documentKind === 'string') pState.documentKind = message.documentKind;
	if (typeof message.upgradeRequestType === 'string') pState.upgradeRequestType = message.upgradeRequestType;

	const documentKind = getProjectedDocumentKind();
	if (Array.isArray(message.allowedSectionKinds)) {
		pState.allowedSectionKinds = documentKind
			? normalizeProjectedKinds(documentKind, message.allowedSectionKinds)
			: [];
	}
	if (documentKind) {
		const projectedDefault = typeof message.defaultSectionKind === 'string'
			? canonicalAddableSectionKind(documentKind, message.defaultSectionKind)
			: undefined;
		pState.defaultSectionKind = projectedDefault ?? defaultSectionKindForDocument(documentKind);
	} else if (typeof message.defaultSectionKind === 'string') {
		pState.defaultSectionKind = '';
	}
}

export function getAllowedAddSectionKinds(): readonly AddableSectionKind[] {
	const documentKind = getProjectedDocumentKind();
	if (!documentKind || !Array.isArray(pState.allowedSectionKinds)) return [];
	return normalizeProjectedKinds(documentKind, pState.allowedSectionKinds);
}

export type AddSectionAdmission =
	| Readonly<{ ok: true; sectionKind: AddableSectionKind }>
	| Readonly<{ ok: false; error: string }>;

export function getAddSectionAdmission(sectionKind: unknown): AddSectionAdmission {
	const documentKind = getProjectedDocumentKind();
	if (!documentKind) return { ok: false, error: 'The document type does not support adding sections.' };
	const canonicalKind = canonicalSectionKind(sectionKind);
	if (!canonicalKind) return { ok: false, error: `Unknown section type "${String(sectionKind)}".` };
	if (!isKnownSectionKindAllowed(documentKind, canonicalKind)) {
		return { ok: false, error: `Section type "${canonicalKind}" is not supported in .${documentKind} documents.` };
	}
	const addableKind = canonicalAddableSectionKind(documentKind, sectionKind);
	if (!addableKind) return { ok: false, error: `Section type "${canonicalKind}" cannot be added directly.` };
	if (!getAllowedAddSectionKinds().includes(addableKind)) {
		return { ok: false, error: `Section type "${addableKind}" is unavailable in the current document host.` };
	}
	return { ok: true, sectionKind: addableKind };
}

export function getDefaultAddSectionKind(): AddableSectionKind | undefined {
	const documentKind = getProjectedDocumentKind();
	if (!documentKind) return undefined;
	const defaultKind = canonicalAddableSectionKind(documentKind, pState.defaultSectionKind)
		?? defaultSectionKindForDocument(documentKind);
	return getAllowedAddSectionKinds().includes(defaultKind) ? defaultKind : undefined;
}

export function assertProjectedSectionsAllowed(sections: readonly unknown[]): void {
	const documentKind = getProjectedDocumentKind();
	if (documentKind) assertDocumentSectionKindsAllowed(documentKind, sections);
}

export function resetDocumentCapabilityProjectionForTest(): void {
	pState.documentKind = 'kqlx';
	pState.upgradeRequestType = 'requestUpgradeToKqlx';
	pState.allowedSectionKinds = [...addableSectionKindsForDocument('kqlx')];
	pState.defaultSectionKind = defaultSectionKindForDocument('kqlx');
}