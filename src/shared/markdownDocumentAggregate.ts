import { canonicalSectionKind } from './documentSectionCapabilities';
import {
	parseMarkdownSection,
	parseMarkdownSectionPatch,
	patchMarkdownSection,
	type MarkdownSectionState,
} from './markdownSectionDefinition';
import {
	parsePythonSection,
	parsePythonSectionPatch,
	patchPythonSection,
	type PythonSectionState,
} from './pythonSectionDefinition';
import {
	parseUrlSection,
	parseUrlSectionPatch,
	patchUrlSection,
	type UrlSectionState,
} from './urlSectionDefinition';

type SectionRecord = Record<string, unknown>;
type OwnedSectionState = MarkdownSectionState | PythonSectionState | UrlSectionState;
type OwnedSectionKind = OwnedSectionState['type'];

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
	sectionRevisions: Readonly<Record<string, number>>;
	markdownSectionRevisions: Readonly<Record<string, number>>;
	markdownSections: readonly MarkdownSectionState[];
	pythonSections: readonly PythonSectionState[];
	urlSections: readonly UrlSectionState[];
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

function ownedSectionKind(section: SectionRecord): OwnedSectionKind | undefined {
	const kind = canonicalSectionKind(String(section.type ?? ''));
	return kind === 'markdown' || kind === 'python' || kind === 'url' ? kind : undefined;
}

function isOwnedSection(section: SectionRecord): boolean {
	return ownedSectionKind(section) !== undefined;
}

function parseOwnedSection(input: unknown):
	| Readonly<{ ok: true; value: OwnedSectionState }>
	| Readonly<{ ok: false; error: string }> {
	if (!isRecord(input)) return { ok: false, error: 'Host-owned section must be an object.' };
	const kind = ownedSectionKind(input);
	if (kind === 'markdown') return parseMarkdownSection(input);
	if (kind === 'python') return parsePythonSection(input);
	if (kind === 'url') return parseUrlSection(input);
	return { ok: false, error: 'Host-owned section must have type "markdown", "python", or "url".' };
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
			if (isOwnedSection(input)) {
				const parsed = parseOwnedSection(input);
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

	public ownedSections(): readonly OwnedSectionState[] {
		return this.state.sections
			.filter(isOwnedSection)
			.map(section => parseOwnedSection(section))
			.flatMap(result => result.ok ? [result.value] : []);
	}

	public projection(): MarkdownDocumentProjection {
		const ownedSections = this.ownedSections();
		const markdownSections = ownedSections.filter(
			(section): section is MarkdownSectionState => section.type === 'markdown',
		);
		const pythonSections = ownedSections.filter(
			(section): section is PythonSectionState => section.type === 'python',
		);
		const urlSections = ownedSections.filter(
			(section): section is UrlSectionState => section.type === 'url',
		);
		const markdownIds = new Set(markdownSections.map(section => section.id));
		return {
			documentRevision: this.revision,
			sectionRevisions: Object.fromEntries(this.sectionRevisions),
			markdownSectionRevisions: Object.fromEntries(
				[...this.sectionRevisions].filter(([id]) => markdownIds.has(id)),
			),
			markdownSections,
			pythonSections,
			urlSections,
			orderedSectionIds: this.state.sections.map(sectionId),
		};
	}

	public hasUnmigratedVisualSections(): boolean {
		return this.state.sections.some(section => {
			const kind = canonicalSectionKind(String(section.type ?? ''));
			return !!kind && kind !== 'markdown' && kind !== 'python' && kind !== 'url' && kind !== 'devnotes';
		});
	}

	public withAdapterState(state: unknown): MarkdownDocumentAggregate {
		if (!isRecord(state) || !Array.isArray(state.sections)) return this;
		const ownerSections = new Map(this.ownedSections().map(section => [section.id, section]));
		const seenOwnedSections = new Set<string>();
		const sections: SectionRecord[] = [];
		for (const input of state.sections) {
			if (!isRecord(input)) continue;
			const id = sectionId(input);
			if (isOwnedSection(input)) {
				const owned = ownerSections.get(id);
				if (owned) {
					sections.push(cloneJsonValue(owned) as unknown as SectionRecord);
					seenOwnedSections.add(id);
				}
				continue;
			}
			sections.push(cloneJsonValue(input));
		}
		for (const section of this.state.sections) {
			if (!isOwnedSection(section)) continue;
			const id = sectionId(section);
			if (seenOwnedSections.has(id)) continue;
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
			const parsed = parseOwnedSection(command.section);
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
		const currentKind = sectionIndex >= 0 ? ownedSectionKind(sections[sectionIndex]) : undefined;
		if (sectionIndex < 0 || !currentKind) {
			return commandFailure(this, 'missing-section', `Host-owned section "${commandSectionId}" does not exist.`);
		}
		const currentSectionRevision = revisions.get(commandSectionId);
		if (!Number.isSafeInteger(command.expectedSectionRevision)
			|| command.expectedSectionRevision !== currentSectionRevision) {
			const sectionLabel = currentKind === 'markdown'
				? 'Markdown'
				: currentKind === 'python' ? 'Python' : 'URL';
			return commandFailure(
				this,
				'stale-section-revision',
				`Expected ${sectionLabel} section revision ${String(command.expectedSectionRevision)} but current revision is ${String(currentSectionRevision)}.`,
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
		const nextSectionRevision = currentSectionRevision! + 1;
		if (currentKind === 'markdown') {
			const parsedCurrent = parseMarkdownSection(sections[sectionIndex]);
			const parsedPatch = parseMarkdownSectionPatch(command.patch);
			if (!parsedCurrent.ok) return commandFailure(this, 'invalid-command', parsedCurrent.error);
			if (!parsedPatch.ok) return commandFailure(this, 'invalid-command', parsedPatch.error);
			sections[sectionIndex] = patchMarkdownSection(parsedCurrent.value, parsedPatch.value) as unknown as SectionRecord;
		} else if (currentKind === 'python') {
			const parsedCurrent = parsePythonSection(sections[sectionIndex]);
			const parsedPatch = parsePythonSectionPatch(command.patch);
			if (!parsedCurrent.ok) return commandFailure(this, 'invalid-command', parsedCurrent.error);
			if (!parsedPatch.ok) return commandFailure(this, 'invalid-command', parsedPatch.error);
			sections[sectionIndex] = patchPythonSection(parsedCurrent.value, parsedPatch.value) as unknown as SectionRecord;
		} else {
			const parsedCurrent = parseUrlSection(sections[sectionIndex]);
			const parsedPatch = parseUrlSectionPatch(command.patch);
			if (!parsedCurrent.ok) return commandFailure(this, 'invalid-command', parsedCurrent.error);
			if (!parsedPatch.ok) return commandFailure(this, 'invalid-command', parsedPatch.error);
			sections[sectionIndex] = patchUrlSection(parsedCurrent.value, parsedPatch.value) as unknown as SectionRecord;
		}
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