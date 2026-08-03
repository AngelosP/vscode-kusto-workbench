import type {
	MarkdownDocumentCommand,
	MarkdownDocumentProjection,
} from '../../shared/markdownDocumentAggregate.js';
import type { MarkdownSectionState } from '../../shared/markdownSectionDefinition.js';
import {
	parseMarkdownSection,
	parseMarkdownSectionPatch,
	patchMarkdownSection,
} from '../../shared/markdownSectionDefinition.js';
import type { UrlSectionState } from '../../shared/urlSectionDefinition.js';
import {
	parseUrlSection,
	parseUrlSectionPatch,
	patchUrlSection,
} from '../../shared/urlSectionDefinition.js';
import { pState } from '../shared/persistence-state.js';
import { postMessageToHost } from '../shared/webview-messages.js';

type PendingCommand = {
	epoch: number;
	sourceGeneration: number;
	expectedDocumentRevision: number;
	command: MarkdownDocumentCommand;
	expectedProjection: MarkdownDocumentProjection;
	timeout: ReturnType<typeof setTimeout>;
};

let commandSequence = 0;
let projectionEpoch = 0;
let optimisticDocumentRevision = 0;
let optimisticSectionRevisions: Record<string, number> = {};
let optimisticProjection: MarkdownDocumentProjection = {
	documentRevision: 0,
	sectionRevisions: {},
	markdownSectionRevisions: {},
	markdownSections: [],
	urlSections: [],
	orderedSectionIds: [],
};
let queueBlocked = false;
let failureSequence = 0;
const pendingCommands = new Map<string, PendingCommand>();
const queueWaiters = new Set<() => void>();

function cloneMarkdownSection(section: MarkdownSectionState): MarkdownSectionState {
	return { ...section };
}

function cloneUrlSection(section: UrlSectionState): UrlSectionState {
	return { ...section };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseRevisionRecord(input: unknown, expectedIds: readonly string[]): Record<string, number> | undefined {
	if (!isRecord(input)) return undefined;
	const keys = Object.keys(input);
	const expected = new Set(expectedIds);
	if (keys.length !== expected.size || keys.some(key => !expected.has(key))) return undefined;
	const revisions: Record<string, number> = {};
	for (const id of expectedIds) {
		const revision = input[id];
		if (!Number.isSafeInteger(revision) || Number(revision) < 0) return undefined;
		revisions[id] = Number(revision);
	}
	return revisions;
}

function parseHostOwnedProjection(input: unknown): MarkdownDocumentProjection | undefined {
	if (!isRecord(input)) return undefined;
	const documentRevision = input.documentRevision;
	if (!Number.isSafeInteger(documentRevision) || Number(documentRevision) < 0) return undefined;
	if (!Array.isArray(input.markdownSections)
		|| !Array.isArray(input.urlSections)
		|| !Array.isArray(input.orderedSectionIds)) return undefined;

	const markdownSections: MarkdownSectionState[] = [];
	for (const section of input.markdownSections) {
		const parsed = parseMarkdownSection(section);
		if (!parsed.ok) return undefined;
		markdownSections.push(parsed.value);
	}
	const urlSections: UrlSectionState[] = [];
	for (const section of input.urlSections) {
		const parsed = parseUrlSection(section);
		if (!parsed.ok) return undefined;
		urlSections.push(parsed.value);
	}
	const ownedIds = [...markdownSections.map(section => section.id), ...urlSections.map(section => section.id)];
	if (new Set(ownedIds).size !== ownedIds.length) return undefined;
	const orderedSectionIds = input.orderedSectionIds.map(value => typeof value === 'string' ? value.trim() : '');
	if (orderedSectionIds.some(id => !id) || new Set(orderedSectionIds).size !== orderedSectionIds.length) return undefined;
	const orderedIds = new Set(orderedSectionIds);
	if (ownedIds.some(id => !orderedIds.has(id))) return undefined;

	const markdownIds = markdownSections.map(section => section.id);
	const markdownSectionRevisions = parseRevisionRecord(input.markdownSectionRevisions, markdownIds);
	const sectionRevisions = parseRevisionRecord(
		input.sectionRevisions,
		ownedIds,
	);
	if (!markdownSectionRevisions || !sectionRevisions) return undefined;
	return {
		documentRevision: Number(documentRevision),
		sectionRevisions,
		markdownSectionRevisions,
		markdownSections,
		urlSections,
		orderedSectionIds,
	};
}

function commandSection(input: unknown): MarkdownSectionState | UrlSectionState | undefined {
	const markdown = parseMarkdownSection(input);
	if (markdown.ok) return markdown.value;
	const url = parseUrlSection(input);
	return url.ok ? url.value : undefined;
}

function cloneProjection(projection: MarkdownDocumentProjection): MarkdownDocumentProjection {
	return {
		documentRevision: projection.documentRevision,
		sectionRevisions: { ...projection.sectionRevisions },
		markdownSectionRevisions: { ...projection.markdownSectionRevisions },
		markdownSections: projection.markdownSections.map(cloneMarkdownSection),
		urlSections: projection.urlSections.map(cloneUrlSection),
		orderedSectionIds: [...projection.orderedSectionIds],
	};
}

function transitionProjection(
	projection: MarkdownDocumentProjection,
	command: MarkdownDocumentCommand,
): MarkdownDocumentProjection | undefined {
	const sectionsById = new Map<string, MarkdownSectionState | UrlSectionState>([
		...projection.markdownSections.map(section => [section.id, cloneMarkdownSection(section)] as const),
		...projection.urlSections.map(section => [section.id, cloneUrlSection(section)] as const),
	]);
	const orderedSectionIds = [...projection.orderedSectionIds];
	const sectionRevisions = { ...projection.sectionRevisions };

	if (command.type === 'add') {
		const section = commandSection(command.section);
		if (!section || sectionsById.has(section.id) || orderedSectionIds.includes(section.id)) return undefined;
		let insertionIndex = orderedSectionIds.length;
		if (command.afterSectionId) {
			const anchorIndex = orderedSectionIds.indexOf(command.afterSectionId);
			if (anchorIndex < 0) return undefined;
			insertionIndex = anchorIndex + 1;
		}
		orderedSectionIds.splice(insertionIndex, 0, section.id);
		sectionsById.set(section.id, section);
		sectionRevisions[section.id] = 1;
	} else {
		const section = sectionsById.get(command.sectionId);
		if (!section || sectionRevisions[command.sectionId] !== command.expectedSectionRevision) return undefined;
		if (command.type === 'remove') {
			sectionsById.delete(command.sectionId);
			delete sectionRevisions[command.sectionId];
			const index = orderedSectionIds.indexOf(command.sectionId);
			if (index < 0) return undefined;
			orderedSectionIds.splice(index, 1);
		} else if (section.type === 'markdown') {
			const patch = parseMarkdownSectionPatch(command.patch);
			if (!patch.ok) return undefined;
			sectionsById.set(section.id, patchMarkdownSection(section, patch.value));
			sectionRevisions[section.id] = command.expectedSectionRevision + 1;
		} else {
			const patch = parseUrlSectionPatch(command.patch);
			if (!patch.ok) return undefined;
			sectionsById.set(section.id, patchUrlSection(section, patch.value));
			sectionRevisions[section.id] = command.expectedSectionRevision + 1;
		}
	}

	const ownedInOrder = orderedSectionIds.flatMap(id => {
		const section = sectionsById.get(id);
		return section ? [section] : [];
	});
	const markdownSections = ownedInOrder.filter(
		(section): section is MarkdownSectionState => section.type === 'markdown',
	);
	const urlSections = ownedInOrder.filter(
		(section): section is UrlSectionState => section.type === 'url',
	);
	const canonicalSectionRevisions = Object.fromEntries([
		...markdownSections.map(section => [section.id, sectionRevisions[section.id]] as const),
		...urlSections.map(section => [section.id, sectionRevisions[section.id]] as const),
	]);
	return {
		documentRevision: projection.documentRevision + 1,
		sectionRevisions: canonicalSectionRevisions,
		markdownSectionRevisions: Object.fromEntries(
			markdownSections.map(section => [section.id, sectionRevisions[section.id]]),
		),
		markdownSections,
		urlSections,
		orderedSectionIds,
	};
}

function jsonSemanticallyEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right)
			&& left.length === right.length
			&& left.every((value, index) => jsonSemanticallyEqual(value, right[index]));
	}
	if (!isRecord(left) || !isRecord(right)) return false;
	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	return leftKeys.length === rightKeys.length
		&& leftKeys.every((key, index) => key === rightKeys[index]
			&& jsonSemanticallyEqual(left[key], right[key]));
}

function projectionsEqual(left: MarkdownDocumentProjection, right: MarkdownDocumentProjection): boolean {
	return jsonSemanticallyEqual(left, right);
}

function isNativeNotebookKind(): boolean {
	return pState.documentKind === 'kqlx'
		|| pState.documentKind === 'sqlx'
		|| pState.documentKind === 'mdx';
}

export function isHostOwnedMarkdownDocument(): boolean {
	return pState.hostOwnedMarkdownActive === true
		&& isNativeNotebookKind()
		&& !pState.compatibilityMode
		&& pState.documentRuntimeActive === true;
}

export function isHostOwnedUrlDocument(): boolean {
	return isHostOwnedMarkdownDocument();
}

function notifyQueueWaiters(): void {
	if (pendingCommands.size > 0) return;
	for (const resolve of queueWaiters) resolve();
	queueWaiters.clear();
}

function synchronizeOptimisticProjection(projection: MarkdownDocumentProjection): void {
	optimisticProjection = cloneProjection(projection);
	optimisticDocumentRevision = optimisticProjection.documentRevision;
	optimisticSectionRevisions = { ...optimisticProjection.sectionRevisions };
}

function adoptProjection(projection: MarkdownDocumentProjection, synchronizeOptimistic: boolean): void {
	pState.markdownDocumentRevision = projection.documentRevision;
	pState.documentSectionRevisions = {
		...(projection.sectionRevisions ?? projection.markdownSectionRevisions),
	};
	pState.markdownSectionRevisions = { ...projection.markdownSectionRevisions };
	pState.hostOwnedMarkdownSections = Object.fromEntries(
		projection.markdownSections.map(section => [section.id, cloneMarkdownSection(section)]),
	);
	pState.hostOwnedUrlSections = Object.fromEntries(
		(projection.urlSections ?? []).map(section => [section.id, cloneUrlSection(section)]),
	);
	if (synchronizeOptimistic) synchronizeOptimisticProjection(projection);
}

function clearPendingCommands(): void {
	for (const pending of pendingCommands.values()) clearTimeout(pending.timeout);
	pendingCommands.clear();
	notifyQueueWaiters();

}

function requestAuthoritativeReload(): void {
	postMessageToHost({ type: 'requestDocument' });

}

function blockQueueAndReload(): void {
	queueBlocked = true;
	failureSequence++;
	projectionEpoch++;
	clearPendingCommands();
	requestAuthoritativeReload();
}

export function adoptHostOwnedMarkdownDocument(message: unknown, state: unknown): boolean {
	const envelope = message && typeof message === 'object' ? message as Record<string, unknown> : {};
	const sourceGeneration = Number(envelope.sourceGeneration);
	const stateRecord = state && typeof state === 'object' ? state as Record<string, unknown> : {};
	const sections = Array.isArray(stateRecord.sections) ? stateRecord.sections : [];
	const projection = parseHostOwnedProjection({
		documentRevision: envelope.documentRevision,
		sectionRevisions: envelope.sectionRevisions,
		markdownSectionRevisions: envelope.markdownSectionRevisions,
		markdownSections: sections.filter(section => isRecord(section) && section.type === 'markdown'),
		urlSections: sections.filter(section => isRecord(section) && section.type === 'url'),
		orderedSectionIds: sections.map(section => isRecord(section) && typeof section.id === 'string' ? section.id : ''),
	});
	if (!projection || !Number.isSafeInteger(sourceGeneration) || sourceGeneration < 0) {
		resetHostOwnedMarkdownDocument();
		return false;
	}
	projectionEpoch++;
	if (pendingCommands.size > 0) failureSequence++;
	clearPendingCommands();
	queueBlocked = false;
	pState.hostOwnedMarkdownActive = true;
	pState.markdownSourceGeneration = sourceGeneration;
	adoptProjection(projection, true);
	return true;
}

export function resetHostOwnedMarkdownDocument(): void {
	pState.hostOwnedMarkdownActive = false;
	pState.markdownDocumentRevision = 0;
	pState.markdownSourceGeneration = 0;
	pState.markdownSectionRevisions = {};
	pState.documentSectionRevisions = {};
	pState.hostOwnedMarkdownSections = {};
	pState.hostOwnedUrlSections = {};
	projectionEpoch++;
	if (pendingCommands.size > 0) failureSequence++;
	clearPendingCommands();
	queueBlocked = false;
	optimisticDocumentRevision = 0;
	optimisticSectionRevisions = {};
	optimisticProjection = {
		documentRevision: 0,
		sectionRevisions: {},
		markdownSectionRevisions: {},
		markdownSections: [],
		urlSections: [],
		orderedSectionIds: [],
	};
}

export function getHostOwnedMarkdownSection(sectionId: string): MarkdownSectionState | undefined {
	const section = pState.hostOwnedMarkdownSections[String(sectionId || '')];
	return section ? cloneMarkdownSection(section) : undefined;
}

export function getHostOwnedUrlSection(sectionId: string): UrlSectionState | undefined {
	const section = pState.hostOwnedUrlSections[String(sectionId || '')];
	return section ? cloneUrlSection(section) : undefined;
}

function dispatchCommand(command: MarkdownDocumentCommand): boolean {
	if (queueBlocked) return false;
	const commandId = `markdown-command-${Date.now()}-${++commandSequence}`;
	const epoch = projectionEpoch;
	const sourceGeneration = pState.markdownSourceGeneration;
	const expectedDocumentRevision = optimisticDocumentRevision;
	const expectedProjection = transitionProjection(optimisticProjection, command);
	if (!expectedProjection) return false;
	synchronizeOptimisticProjection(expectedProjection);
	const timeout = setTimeout(() => {
		const pending = pendingCommands.get(commandId);
		if (!pending || pending.epoch !== epoch) return;
		blockQueueAndReload();
	}, 5_000);
	pendingCommands.set(commandId, {
		epoch, sourceGeneration, expectedDocumentRevision, command,
		expectedProjection: cloneProjection(expectedProjection), timeout,
	});
	postMessageToHost({
		type: 'markdownDocumentCommand',
		commandId,
		sourceGeneration,
		expectedDocumentRevision,
		command,
	});
	return true;
}

export function requestHostOwnedMarkdownAdd(
	section: MarkdownSectionState,
	afterSectionId?: string,
): boolean {
	if (!isHostOwnedMarkdownDocument() || pState.restoreInProgress || pState.applyingHostMarkdownProjection || queueBlocked) return false;
	if (Number.isSafeInteger(optimisticSectionRevisions[section.id])) return true;
	return dispatchCommand({
		type: 'add', section: cloneMarkdownSection(section), ...(afterSectionId ? { afterSectionId } : {}),
	});
}

export function requestHostOwnedMarkdownPatch(section: MarkdownSectionState): boolean {
	if (!isHostOwnedMarkdownDocument() || pState.restoreInProgress || pState.applyingHostMarkdownProjection || queueBlocked) return false;
	const expectedSectionRevision = optimisticSectionRevisions[section.id];
	if (!Number.isSafeInteger(expectedSectionRevision)) return false;
	const current = pState.hostOwnedMarkdownSections[section.id];
		const patch = {
			title: section.title ?? '',
			text: section.text ?? '',
			tab: section.tab ?? 'edit',
			expanded: section.expanded ?? true,
			mode: section.mode ?? 'wysiwyg',
			editorHeightPx: section.editorHeightPx ?? null,
		};
	const currentComparable = current ? {
			title: current.title ?? '', text: current.text ?? '', tab: current.tab ?? 'edit',
			expanded: current.expanded ?? true, mode: current.mode ?? 'wysiwyg',
			editorHeightPx: current.editorHeightPx ?? null,
	} : undefined;
	if (pendingCommands.size === 0 && currentComparable
		&& JSON.stringify(patch) === JSON.stringify(currentComparable)) return true;
	return dispatchCommand({ type: 'patch', sectionId: section.id, expectedSectionRevision, patch });
}

export function requestHostOwnedMarkdownRemove(sectionId: string): boolean {
	if (!isHostOwnedMarkdownDocument() || pState.restoreInProgress || pState.applyingHostMarkdownProjection || queueBlocked) return false;
	const expectedSectionRevision = optimisticSectionRevisions[sectionId];
	if (!Number.isSafeInteger(expectedSectionRevision)) return false;
	return dispatchCommand({ type: 'remove', sectionId, expectedSectionRevision });
}

export function requestHostOwnedUrlAdd(section: UrlSectionState, afterSectionId?: string): boolean {
	if (!isHostOwnedUrlDocument() || pState.restoreInProgress || pState.applyingHostMarkdownProjection || queueBlocked) return false;
	if (Number.isSafeInteger(optimisticSectionRevisions[section.id])) return true;
	return dispatchCommand({
		type: 'add', section: cloneUrlSection(section), ...(afterSectionId ? { afterSectionId } : {}),
	});
}

export function requestHostOwnedUrlPatch(section: UrlSectionState): boolean {
	if (!isHostOwnedUrlDocument() || pState.restoreInProgress || pState.applyingHostMarkdownProjection || queueBlocked) return false;
	const expectedSectionRevision = optimisticSectionRevisions[section.id];
	if (!Number.isSafeInteger(expectedSectionRevision)) return false;
	const current = pState.hostOwnedUrlSections[section.id];
	const patch = {
		name: section.name ?? '',
		url: section.url ?? '',
		expanded: section.expanded ?? true,
		outputHeightPx: section.outputHeightPx ?? null,
		imageSizeMode: section.imageSizeMode ?? null,
		imageAlign: section.imageAlign ?? null,
		imageOverflow: section.imageOverflow ?? null,
	};
	const currentComparable = current ? {
		name: current.name ?? '',
		url: current.url ?? '',
		expanded: current.expanded === true,
		outputHeightPx: current.outputHeightPx ?? null,
		imageSizeMode: current.imageSizeMode ?? null,
		imageAlign: current.imageAlign ?? null,
		imageOverflow: current.imageOverflow ?? null,
	} : undefined;
	if (pendingCommands.size === 0 && currentComparable
		&& JSON.stringify(patch) === JSON.stringify(currentComparable)) return true;
	return dispatchCommand({ type: 'patch', sectionId: section.id, expectedSectionRevision, patch });
}

export function requestHostOwnedUrlRemove(sectionId: string): boolean {
	if (!isHostOwnedUrlDocument() || pState.restoreInProgress || pState.applyingHostMarkdownProjection || queueBlocked) return false;
	const expectedSectionRevision = optimisticSectionRevisions[sectionId];
	if (!Number.isSafeInteger(expectedSectionRevision)) return false;
	return dispatchCommand({ type: 'remove', sectionId, expectedSectionRevision });
}

export async function waitForHostOwnedMarkdownCommands(): Promise<boolean> {
	if (!isHostOwnedMarkdownDocument()) return true;
	const observedFailureSequence = failureSequence;
	if (pendingCommands.size > 0) {
		await new Promise<void>(resolve => queueWaiters.add(resolve));
	}
	return !queueBlocked && failureSequence === observedFailureSequence;
}

export function handleHostOwnedMarkdownCommandResult(message: unknown): {
	handled: boolean;
	accepted: boolean;
	projection?: MarkdownDocumentProjection;
} {
	if (!message || typeof message !== 'object') return { handled: false, accepted: false };
	const result = message as Record<string, unknown>;
	const commandId = String(result.commandId || '').trim();
	const pending = pendingCommands.get(commandId);
	if (!pending) return { handled: false, accepted: false };
	pendingCommands.delete(commandId);
	clearTimeout(pending.timeout);
	const sourceGeneration = Number(result.sourceGeneration);
	const projection = parseHostOwnedProjection(result.projection);
	const accepted = result.ok === true
		&& sourceGeneration === pending.sourceGeneration
		&& pending.epoch === projectionEpoch
		&& !!projection
		&& projectionsEqual(projection, pending.expectedProjection);
	if (accepted && projection) {
		adoptProjection(projection, pendingCommands.size === 0);
		notifyQueueWaiters();
		return { handled: true, accepted: true, projection };
	}
	if (result.ok === true) {
		blockQueueAndReload();
		return { handled: true, accepted: false };
	}
	failureSequence++;
	projectionEpoch++;
	clearPendingCommands();
	if (projection && sourceGeneration === pState.markdownSourceGeneration) {
		queueBlocked = false;
		adoptProjection(projection, true);
		return { handled: true, accepted: false, projection };
	}
	blockQueueAndReload();
	return { handled: true, accepted: false };
}