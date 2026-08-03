import { canonicalSectionKind } from './documentSectionCapabilities';
import {
	parseMarkdownSection,
	parseMarkdownSectionPatch,
	patchMarkdownSection,
	type MarkdownSectionState,
} from './markdownSectionDefinition';

type SectionRecord = Record<string, unknown>;

export interface MarkdownDocumentState {
	sections: SectionRecord[];
	[key: string]: unknown;
}

export type MarkdownDocumentCommand =
	| Readonly<{
			type: 'add';
			afterSectionId?: string;
			section: unknown;
	  }>
	| Readonly<{
			type: 'patch';
			sectionId: string;
			expectedSectionRevision: number;
			patch: unknown;
	  }>
	| Readonly<{
			type: 'remove';
			sectionId: string;
			expectedSectionRevision: number;
	  }>;

export interface RevisionedMarkdownDocumentCommand {
	expectedDocumentRevision: number;
	command: MarkdownDocumentCommand;
}

export type MarkdownDocumentCommandErrorCode =
	| 'invalid-command'
	| 'stale-document-revision'
	| 'stale-section-revision'
	| 'duplicate-section-id'
	| 'missing-section'
	| 'invalid-section-anchor';

export interface MarkdownDocumentProjection {
	documentRevision: number;
	markdownSectionRevisions: Readonly<Record<string, number>>;
	markdownSections: readonly MarkdownSectionState[];
	orderedSectionIds: readonly string[];
}

export type MarkdownDocumentTransition =
	| Readonly<{
			ok: true;
			document: MarkdownDocumentAggregate;
			documentRevision: number;
			sectionRevision?: number;
	  }>
	| Readonly<{
			ok: false;
			document: MarkdownDocumentAggregate;
			documentRevision: number;
			error: Readonly<{ code: MarkdownDocumentCommandErrorCode; message: string }>;
	  }>;

export type MarkdownDocumentCreationResult =
	| Readonly<{ ok: true; document: MarkdownDocumentAggregate }>
	| Readonly<{ ok: false; error: string }>;

const isRecord = (value: unknown): value is SectionRecord =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const setOwn = (target: SectionRecord, key: string, value: unknown): void => {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
};

function cloneJsonValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
	if (value === null || typeof value !== 'object') return value;
	const existing = seen.get(value as object);
	if (existing !== undefined) return existing as T;
	if (Array.isArray(value)) {
		const clone: unknown[] = [];
		seen.set(value, clone);
		for (const item of value) clone.push(cloneJsonValue(item, seen));
		return clone as T;
	}
	const clone: SectionRecord = {};
	seen.set(value as object, clone);
	for (const [key, item] of Object.entries(value as SectionRecord)) setOwn(clone, key, cloneJsonValue(item, seen));
	return clone as T;
}

function sectionId(section: SectionRecord): string {
	return typeof section.id === 'string' ? section.id.trim() : '';
}

function isMarkdownSection(section: SectionRecord): boolean {
	return canonicalSectionKind(String(section.type ?? '')) === 'markdown';
}

function commandFailure(
	document: MarkdownDocumentAggregate,
	code: MarkdownDocumentCommandErrorCode,
	message: string,
): MarkdownDocumentTransition {
	return { ok: false, document, documentRevision: document.revision, error: { code, message } };
}

export class MarkdownDocumentAggregate {
	private constructor(
		private readonly state: MarkdownDocumentState,
		public readonly revision: number,
		private readonly sectionRevisions: ReadonlyMap<string, number>,
	) {}

	public static create(state: unknown, revision = 0): MarkdownDocumentCreationResult {
		if (!isRecord(state) || !Array.isArray(state.sections)) {
			return { ok: false, error: 'Document state must contain a section array.' };
		}
		const ids = new Set<string>();
		const revisions = new Map<string, number>();
		const sections: SectionRecord[] = [];
		for (const input of state.sections) {
			if (!isRecord(input)) return { ok: false, error: 'Every document section must be an object.' };
			const id = sectionId(input);
			if (!id) return { ok: false, error: 'Every projected document section must have an ID.' };
			if (ids.has(id)) return { ok: false, error: `Duplicate document section ID "${id}".` };
			ids.add(id);
			if (isMarkdownSection(input)) {
				const parsed = parseMarkdownSection(input);
				if (!parsed.ok) return parsed;
				sections.push(parsed.value as unknown as SectionRecord);
				revisions.set(id, 0);
			} else {
				sections.push(cloneJsonValue(input));
			}
		}
		const clonedState: MarkdownDocumentState = { sections };
		for (const [key, value] of Object.entries(state)) {
			if (key !== 'sections') setOwn(clonedState, key, cloneJsonValue(value));
		}
		return { ok: true, document: new MarkdownDocumentAggregate(clonedState, revision, revisions) };
	}

	public snapshot(): MarkdownDocumentState {
		return cloneJsonValue(this.state);
	}

	public projection(): MarkdownDocumentProjection {
		const markdownSections = this.state.sections
			.filter(isMarkdownSection)
			.map(section => parseMarkdownSection(section))
			.flatMap(result => result.ok ? [result.value] : []);
		return {
			documentRevision: this.revision,
			markdownSectionRevisions: Object.fromEntries(this.sectionRevisions),
			markdownSections,
			orderedSectionIds: this.state.sections.map(sectionId),
		};
	}

	public hasUnmigratedVisualSections(): boolean {
		return this.state.sections.some(section => {
			const kind = canonicalSectionKind(String(section.type ?? ''));
			return !!kind && kind !== 'markdown' && kind !== 'devnotes';
		});
	}

	public withAdapterState(state: unknown): MarkdownDocumentAggregate {
		if (!isRecord(state) || !Array.isArray(state.sections)) return this;
		const ownerMarkdown = new Map(this.projection().markdownSections.map(section => [section.id, section]));
		const seenMarkdown = new Set<string>();
		const sections: SectionRecord[] = [];
		for (const input of state.sections) {
			if (!isRecord(input)) continue;
			const id = sectionId(input);
			if (isMarkdownSection(input)) {
				const owned = ownerMarkdown.get(id);
				if (owned) {
					sections.push(cloneJsonValue(owned) as unknown as SectionRecord);
					seenMarkdown.add(id);
				}
				continue;
			}
			sections.push(cloneJsonValue(input));
		}
		for (const section of this.state.sections) {
			if (!isMarkdownSection(section)) continue;
			const id = sectionId(section);
			if (seenMarkdown.has(id)) continue;
			let insertionIndex = sections.length;
			const ownerIndex = this.state.sections.findIndex(candidate => sectionId(candidate) === id);
			for (let index = ownerIndex + 1; index < this.state.sections.length; index++) {
				const nextId = sectionId(this.state.sections[index]);
				const nextIndex = sections.findIndex(candidate => sectionId(candidate) === nextId);
				if (nextIndex >= 0) {
					insertionIndex = nextIndex;
					break;
				}
			}
			sections.splice(insertionIndex, 0, cloneJsonValue(section));
		}
		const nextState: MarkdownDocumentState = { sections };
		for (const [key, value] of Object.entries(state)) {
			if (key !== 'sections') setOwn(nextState, key, cloneJsonValue(value));
		}
		return new MarkdownDocumentAggregate(nextState, this.revision, new Map(this.sectionRevisions));
	}

	public transition(input: RevisionedMarkdownDocumentCommand): MarkdownDocumentTransition {
		if (!Number.isSafeInteger(input.expectedDocumentRevision)
			|| input.expectedDocumentRevision !== this.revision) {
			return commandFailure(
				this,
				'stale-document-revision',
				`Expected document revision ${String(input.expectedDocumentRevision)} but current revision is ${this.revision}.`,
			);
		}
		const command = input.command;
		if (!command || typeof command !== 'object') {
			return commandFailure(this, 'invalid-command', 'Markdown command must be an object.');
		}
		const sections = this.state.sections.map(section => cloneJsonValue(section));
		const revisions = new Map(this.sectionRevisions);

		if (command.type === 'add') {
			const parsed = parseMarkdownSection(command.section);
			if (!parsed.ok) return commandFailure(this, 'invalid-command', parsed.error);
			if (sections.some(section => sectionId(section) === parsed.value.id)) {
				return commandFailure(this, 'duplicate-section-id', `Section "${parsed.value.id}" already exists.`);
			}
			let insertionIndex = sections.length;
			if (command.afterSectionId) {
				const anchorIndex = sections.findIndex(section => sectionId(section) === command.afterSectionId);
				if (anchorIndex < 0) {
					return commandFailure(this, 'invalid-section-anchor', `Section anchor "${command.afterSectionId}" does not exist.`);
				}
				insertionIndex = anchorIndex + 1;
			}
			sections.splice(insertionIndex, 0, parsed.value as unknown as SectionRecord);
			revisions.set(parsed.value.id, 1);
			const document = this.withCommittedState(sections, revisions);
			return { ok: true, document, documentRevision: document.revision, sectionRevision: 1 };
		}

		const commandSectionId = typeof command.sectionId === 'string' ? command.sectionId.trim() : '';
		const sectionIndex = sections.findIndex(section => sectionId(section) === commandSectionId);
		if (sectionIndex < 0 || !isMarkdownSection(sections[sectionIndex])) {
			return commandFailure(this, 'missing-section', `Markdown section "${commandSectionId}" does not exist.`);
		}
		const currentSectionRevision = revisions.get(commandSectionId);
		if (!Number.isSafeInteger(command.expectedSectionRevision)
			|| command.expectedSectionRevision !== currentSectionRevision) {
			return commandFailure(
				this,
				'stale-section-revision',
				`Expected Markdown section revision ${String(command.expectedSectionRevision)} but current revision is ${String(currentSectionRevision)}.`,
			);
		}

		if (command.type === 'remove') {
			sections.splice(sectionIndex, 1);
			revisions.delete(commandSectionId);
			const document = this.withCommittedState(sections, revisions);
			return { ok: true, document, documentRevision: document.revision };
		}
		if (command.type !== 'patch') {
			return commandFailure(this, 'invalid-command', `Unsupported Markdown command "${String((command as { type?: unknown }).type)}".`);
		}
		const parsedCurrent = parseMarkdownSection(sections[sectionIndex]);
		const parsedPatch = parseMarkdownSectionPatch(command.patch);
		if (!parsedCurrent.ok) return commandFailure(this, 'invalid-command', parsedCurrent.error);
		if (!parsedPatch.ok) return commandFailure(this, 'invalid-command', parsedPatch.error);
		const nextSectionRevision = currentSectionRevision! + 1;
		sections[sectionIndex] = patchMarkdownSection(parsedCurrent.value, parsedPatch.value) as unknown as SectionRecord;
		revisions.set(commandSectionId, nextSectionRevision);
		const document = this.withCommittedState(sections, revisions);
		return {
			ok: true,
			document,
			documentRevision: document.revision,
			sectionRevision: nextSectionRevision,
		};
	}

	private withCommittedState(
		sections: SectionRecord[],
		sectionRevisions: ReadonlyMap<string, number>,
	): MarkdownDocumentAggregate {
		const state: MarkdownDocumentState = { sections };
		for (const [key, value] of Object.entries(this.state)) {
			if (key !== 'sections') setOwn(state, key, cloneJsonValue(value));
		}
		return new MarkdownDocumentAggregate(state, this.revision + 1, new Map(sectionRevisions));
	}
}