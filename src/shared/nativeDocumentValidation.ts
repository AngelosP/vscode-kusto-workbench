import { canonicalSectionKind } from './documentSectionCapabilities';

export function getUnsupportedNativeDocumentReason(
	state: Readonly<{ sections: readonly unknown[] }>,
): string | undefined {
	for (const section of state.sections) {
		if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
		const record = section as Record<string, unknown>;
		if (canonicalSectionKind(record.type) !== 'sql') continue;
		const linkedPath = typeof record.linkedQueryPath === 'string' ? record.linkedQueryPath.trim() : '';
		if (linkedPath) return 'Native Kusto Workbench documents do not support linkedQueryPath on SQL sections.';
	}
	return undefined;
}
