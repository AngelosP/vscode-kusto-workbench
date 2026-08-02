export const WORKBENCH_DOCUMENT_KINDS = ['kqlx', 'sqlx', 'mdx'] as const;
export type WorkbenchDocumentKind = (typeof WORKBENCH_DOCUMENT_KINDS)[number];

export const CANONICAL_SECTION_KINDS = [
	'query',
	'sql',
	'chart',
	'transformation',
	'markdown',
	'python',
	'url',
	'html',
	'devnotes',
] as const;
export type CanonicalSectionKind = (typeof CANONICAL_SECTION_KINDS)[number];
export type AddableSectionKind = Exclude<CanonicalSectionKind, 'devnotes'>;

export const LEGACY_SECTION_KIND_ALIASES = {
	copilotQuery: 'query',
} as const satisfies Readonly<Record<string, CanonicalSectionKind>>;
export type LegacySectionKind = keyof typeof LEGACY_SECTION_KIND_ALIASES;
export type KnownSectionKind = CanonicalSectionKind | LegacySectionKind;

export type DocumentSectionCapabilities = Readonly<{
	defaultSectionKind: AddableSectionKind;
	allowedSectionKinds: readonly CanonicalSectionKind[];
}>;

export const DOCUMENT_SECTION_CAPABILITIES = {
	kqlx: {
		defaultSectionKind: 'query',
		allowedSectionKinds: [
			'query', 'sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown', 'devnotes',
		],
	},
	sqlx: {
		defaultSectionKind: 'sql',
		allowedSectionKinds: [
			'sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown', 'devnotes',
		],
	},
	mdx: {
		defaultSectionKind: 'markdown',
		allowedSectionKinds: ['markdown', 'url', 'transformation', 'devnotes'],
	},
} as const satisfies Readonly<Record<WorkbenchDocumentKind, DocumentSectionCapabilities>>;

const canonicalSectionKindSet = new Set<string>(CANONICAL_SECTION_KINDS);
const hiddenSectionKindSet = new Set<CanonicalSectionKind>(['devnotes']);

export function isWorkbenchDocumentKind(value: unknown): value is WorkbenchDocumentKind {
	return typeof value === 'string' && (WORKBENCH_DOCUMENT_KINDS as readonly string[]).includes(value);
}

export function canonicalSectionKind(value: unknown): CanonicalSectionKind | undefined {
	if (typeof value !== 'string') return undefined;
	if (canonicalSectionKindSet.has(value)) return value as CanonicalSectionKind;
	if (Object.prototype.hasOwnProperty.call(LEGACY_SECTION_KIND_ALIASES, value)) {
		return LEGACY_SECTION_KIND_ALIASES[value as LegacySectionKind];
	}
	return undefined;
}

export function isKnownSectionKind(value: unknown): value is KnownSectionKind {
	return canonicalSectionKind(value) !== undefined;
}

export function allowedSectionKindsForDocument(kind: WorkbenchDocumentKind): readonly CanonicalSectionKind[] {
	return DOCUMENT_SECTION_CAPABILITIES[kind].allowedSectionKinds;
}

export function addableSectionKindsForDocument(kind: WorkbenchDocumentKind): readonly AddableSectionKind[] {
	const allowedKinds = DOCUMENT_SECTION_CAPABILITIES[kind].allowedSectionKinds as readonly CanonicalSectionKind[];
	return allowedKinds.filter(
		(sectionKind): sectionKind is AddableSectionKind => sectionKind !== 'devnotes',
	);
}

export function defaultSectionKindForDocument(kind: WorkbenchDocumentKind): AddableSectionKind {
	return DOCUMENT_SECTION_CAPABILITIES[kind].defaultSectionKind;
}

export type SectionKindCompatibility = 'allowed' | 'incompatible' | 'unknown';

export function sectionKindCompatibility(
	documentKind: WorkbenchDocumentKind,
	sectionKind: unknown,
): SectionKindCompatibility {
	const canonicalKind = canonicalSectionKind(sectionKind);
	if (!canonicalKind) return 'unknown';
	const allowedKinds = DOCUMENT_SECTION_CAPABILITIES[documentKind].allowedSectionKinds as readonly CanonicalSectionKind[];
	return allowedKinds.includes(canonicalKind)
		? 'allowed'
		: 'incompatible';
}

export function isKnownSectionKindAllowed(
	documentKind: WorkbenchDocumentKind,
	sectionKind: unknown,
): boolean {
	return sectionKindCompatibility(documentKind, sectionKind) === 'allowed';
}

export function canonicalAddableSectionKind(
	documentKind: WorkbenchDocumentKind,
	sectionKind: unknown,
): AddableSectionKind | undefined {
	const canonicalKind = canonicalSectionKind(sectionKind);
	if (!canonicalKind || hiddenSectionKindSet.has(canonicalKind)) return undefined;
	return isKnownSectionKindAllowed(documentKind, canonicalKind) ? canonicalKind as AddableSectionKind : undefined;
}

export type IncompatibleKnownSection = Readonly<{
	documentKind: WorkbenchDocumentKind;
	sectionIndex: number;
	sectionId?: string;
	sectionKind: KnownSectionKind;
	canonicalSectionKind: CanonicalSectionKind;
}>;

export function findIncompatibleKnownSection(
	documentKind: WorkbenchDocumentKind,
	sections: readonly unknown[],
): IncompatibleKnownSection | undefined {
	for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
		const section = sections[sectionIndex];
		if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
		const record = section as Record<string, unknown>;
		const canonicalKind = canonicalSectionKind(record.type);
		if (!canonicalKind || isKnownSectionKindAllowed(documentKind, canonicalKind)) continue;
		const sectionId = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : undefined;
		return {
			documentKind,
			sectionIndex,
			...(sectionId ? { sectionId } : {}),
			sectionKind: record.type as KnownSectionKind,
			canonicalSectionKind: canonicalKind,
		};
	}
	return undefined;
}

export function assertDocumentSectionKindsAllowed(
	documentKind: WorkbenchDocumentKind,
	sections: readonly unknown[],
): void {
	const issue = findIncompatibleKnownSection(documentKind, sections);
	if (issue) throw new Error(formatIncompatibleKnownSection(issue));
}

export function formatIncompatibleKnownSection(issue: IncompatibleKnownSection): string {
	const sectionIdentity = issue.sectionId
		? `section ${issue.sectionIndex} ("${issue.sectionId}")`
		: `section ${issue.sectionIndex}`;
	const canonicalSuffix = issue.sectionKind === issue.canonicalSectionKind
		? ''
		: ` (canonical "${issue.canonicalSectionKind}")`;
	return `Invalid .${issue.documentKind}: ${sectionIdentity} has incompatible known type "${issue.sectionKind}"${canonicalSuffix}.`;
}