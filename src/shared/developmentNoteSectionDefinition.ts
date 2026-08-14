export interface DevelopmentNoteEntry {
	id: string;
	created: string;
	updated: string;
	category: string;
	relatedSectionIds?: string[];
	content: string;
	source: string;
}

export interface PersistedDevelopmentNoteSectionState {
	id?: string;
	type: 'devnotes';
	entries?: DevelopmentNoteEntry[];
}

export interface DevelopmentNoteSectionState extends PersistedDevelopmentNoteSectionState {
	id: string;
}

export interface DevelopmentNoteSectionPatch {
	entries?: DevelopmentNoteEntry[];
}

export type DevelopmentNoteSectionValidationResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);

function parseEntries(input: unknown): DevelopmentNoteSectionValidationResult<DevelopmentNoteEntry[]> {
	if (!Array.isArray(input)) {
		return { ok: false, error: 'Development-note field "entries" must be an array.' };
	}
	const entries: DevelopmentNoteEntry[] = [];
	for (let index = 0; index < input.length; index++) {
		if (!hasOwn(input, String(index)) || !isRecord(input[index])) {
			return { ok: false, error: `Development-note entry ${index} must be an object.` };
		}
		const entry = input[index];
		for (const key of ['id', 'created', 'updated', 'category', 'content', 'source'] as const) {
			if (!hasOwn(entry, key) || typeof entry[key] !== 'string') {
				return { ok: false, error: `Development-note entry ${index} field "${key}" must be a string.` };
			}
		}
		let relatedSectionIds: string[] | undefined;
		if (hasOwn(entry, 'relatedSectionIds')) {
			if (!Array.isArray(entry.relatedSectionIds)) {
				return {
					ok: false,
					error: `Development-note entry ${index} field "relatedSectionIds" must be an array.`,
				};
			}
			relatedSectionIds = [];
			for (let relatedIndex = 0; relatedIndex < entry.relatedSectionIds.length; relatedIndex++) {
				if (!hasOwn(entry.relatedSectionIds, String(relatedIndex))
					|| typeof entry.relatedSectionIds[relatedIndex] !== 'string') {
					return {
						ok: false,
						error: `Development-note entry ${index} field "relatedSectionIds" must contain strings.`,
					};
				}
				relatedSectionIds.push(entry.relatedSectionIds[relatedIndex]);
			}
		}
		entries.push({
			id: entry.id,
			created: entry.created,
			updated: entry.updated,
			category: entry.category,
			...(relatedSectionIds ? { relatedSectionIds } : {}),
			content: entry.content,
			source: entry.source,
		});
	}
	return { ok: true, value: entries };
}

export function parseDevelopmentNoteSection(
	input: unknown,
): DevelopmentNoteSectionValidationResult<DevelopmentNoteSectionState> {
	if (!isRecord(input) || input.type !== 'devnotes') {
		return { ok: false, error: 'Development-note section must be an object with type "devnotes".' };
	}
	const id = typeof input.id === 'string' ? input.id.trim() : '';
	if (!id || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) {
		return { ok: false, error: 'Development-note section must have a safe, non-empty ID.' };
	}
	const value: DevelopmentNoteSectionState = { id, type: 'devnotes' };
	if (hasOwn(input, 'entries')) {
		const entries = parseEntries(input.entries);
		if (!entries.ok) return entries;
		value.entries = entries.value;
	}
	return { ok: true, value };
}

export function parseDevelopmentNoteSectionPatch(
	input: unknown,
): DevelopmentNoteSectionValidationResult<DevelopmentNoteSectionPatch> {
	if (!isRecord(input)) return { ok: false, error: 'Development-note patch must be an object.' };
	const value: DevelopmentNoteSectionPatch = {};
	if (hasOwn(input, 'entries')) {
		const entries = parseEntries(input.entries);
		if (!entries.ok) return entries;
		value.entries = entries.value;
	}
	return { ok: true, value };
}

export function patchDevelopmentNoteSection(
	section: DevelopmentNoteSectionState,
	patch: DevelopmentNoteSectionPatch,
): DevelopmentNoteSectionState {
	const entries = patch.entries ?? section.entries;
	const next: DevelopmentNoteSectionState = {
		...section,
		...patch,
		id: section.id,
		type: 'devnotes',
		...(entries ? { entries: entries.map(entry => ({
			...entry,
			...(entry.relatedSectionIds ? { relatedSectionIds: [...entry.relatedSectionIds] } : {}),
		})) } : {}),
	};
	if (!entries) delete next.entries;
	return next;
}

export function validatePersistedDevelopmentNoteSection(input: unknown): string | undefined {
	if (!isRecord(input) || input.type !== 'devnotes') {
		return 'Development-note section must be an object with type "devnotes".';
	}
	if (!hasOwn(input, 'entries')) return undefined;
	const entries = parseEntries(input.entries);
	return entries.ok ? undefined : entries.error;
}