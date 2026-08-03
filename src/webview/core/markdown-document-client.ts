import type {
	MarkdownDocumentCommand,
	MarkdownDocumentProjection,
} from '../../shared/markdownDocumentAggregate.js';
import type { MarkdownSectionState } from '../../shared/markdownSectionDefinition.js';
import { pState } from '../shared/persistence-state.js';
import { postMessageToHost } from '../shared/webview-messages.js';

type PendingCommand = {
	epoch: number;
	sourceGeneration: number;
	timeout: ReturnType<typeof setTimeout>;
};

let commandSequence = 0;
let projectionEpoch = 0;
let optimisticDocumentRevision = 0;
let optimisticSectionRevisions: Record<string, number> = {};
let queueBlocked = false;
let failureSequence = 0;
const pendingCommands = new Map<string, PendingCommand>();
const queueWaiters = new Set<() => void>();

function cloneMarkdownSection(section: MarkdownSectionState): MarkdownSectionState {
	return { ...section };
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

function notifyQueueWaiters(): void {
	if (pendingCommands.size > 0) return;
	for (const resolve of queueWaiters) resolve();
	queueWaiters.clear();
}

function synchronizeOptimisticRevisions(projection: MarkdownDocumentProjection): void {
	optimisticDocumentRevision = projection.documentRevision;
	optimisticSectionRevisions = { ...projection.markdownSectionRevisions };
}

function adoptProjection(projection: MarkdownDocumentProjection, synchronizeOptimistic: boolean): void {
	pState.markdownDocumentRevision = projection.documentRevision;
	pState.markdownSectionRevisions = { ...projection.markdownSectionRevisions };
	pState.hostOwnedMarkdownSections = Object.fromEntries(
		projection.markdownSections.map(section => [section.id, cloneMarkdownSection(section)]),
	);
	if (synchronizeOptimistic) synchronizeOptimisticRevisions(projection);
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

export function adoptHostOwnedMarkdownDocument(message: unknown, state: unknown): void {
	const envelope = message && typeof message === 'object' ? message as Record<string, unknown> : {};
	const documentRevision = Number(envelope.documentRevision);
	const sectionRevisions = envelope.markdownSectionRevisions;
	const sourceGeneration = Number(envelope.sourceGeneration);
	const stateRecord = state && typeof state === 'object' ? state as Record<string, unknown> : {};
	const sections = Array.isArray(stateRecord.sections) ? stateRecord.sections : [];
	if (!Number.isSafeInteger(documentRevision) || documentRevision < 0
		|| !sectionRevisions || typeof sectionRevisions !== 'object' || Array.isArray(sectionRevisions)) {
		resetHostOwnedMarkdownDocument();
		return;
	}
	const markdownSections: MarkdownSectionState[] = [];
	for (const section of sections) {
		if (!section || typeof section !== 'object' || (section as Record<string, unknown>).type !== 'markdown') continue;
		const id = String((section as Record<string, unknown>).id || '').trim();
		if (!id) continue;
		markdownSections.push({ ...(section as MarkdownSectionState), id, type: 'markdown' });
	}
	projectionEpoch++;
	if (pendingCommands.size > 0) failureSequence++;
	clearPendingCommands();
	queueBlocked = false;
	pState.hostOwnedMarkdownActive = true;
	pState.markdownSourceGeneration = Number.isSafeInteger(sourceGeneration) && sourceGeneration >= 0
		? sourceGeneration
		: 0;
	adoptProjection({
		documentRevision,
		markdownSectionRevisions: sectionRevisions as Record<string, number>,
		markdownSections,
		orderedSectionIds: sections.map(section => String((section as Record<string, unknown>)?.id || '').trim()).filter(Boolean),
	}, true);
}

export function resetHostOwnedMarkdownDocument(): void {
	pState.hostOwnedMarkdownActive = false;
	pState.markdownDocumentRevision = 0;
	pState.markdownSourceGeneration = 0;
	pState.markdownSectionRevisions = {};
	pState.hostOwnedMarkdownSections = {};
	projectionEpoch++;
	if (pendingCommands.size > 0) failureSequence++;
	clearPendingCommands();
	queueBlocked = false;
	optimisticDocumentRevision = 0;
	optimisticSectionRevisions = {};
}

export function getHostOwnedMarkdownSection(sectionId: string): MarkdownSectionState | undefined {
	const section = pState.hostOwnedMarkdownSections[String(sectionId || '')];
	return section ? cloneMarkdownSection(section) : undefined;
}

function dispatchCommand(command: MarkdownDocumentCommand, applyOptimisticRevision: () => void): void {
	if (queueBlocked) return;
	const commandId = `markdown-command-${Date.now()}-${++commandSequence}`;
	const epoch = projectionEpoch;
	const sourceGeneration = pState.markdownSourceGeneration;
	const expectedDocumentRevision = optimisticDocumentRevision;
	applyOptimisticRevision();
	const timeout = setTimeout(() => {
		const pending = pendingCommands.get(commandId);
		if (!pending || pending.epoch !== epoch) return;
		blockQueueAndReload();
	}, 5_000);
	pendingCommands.set(commandId, { epoch, sourceGeneration, timeout });
	postMessageToHost({
		type: 'markdownDocumentCommand',
		commandId,
		sourceGeneration,
		expectedDocumentRevision,
		command,
	});
}

export function requestHostOwnedMarkdownAdd(
	section: MarkdownSectionState,
	afterSectionId?: string,
): boolean {
	if (!isHostOwnedMarkdownDocument() || pState.restoreInProgress || pState.applyingHostMarkdownProjection || queueBlocked) return false;
	if (Number.isSafeInteger(optimisticSectionRevisions[section.id])) return true;
	dispatchCommand(
		{ type: 'add', section: cloneMarkdownSection(section), ...(afterSectionId ? { afterSectionId } : {}) },
		() => {
			optimisticDocumentRevision++;
			optimisticSectionRevisions[section.id] = 1;
		},
	);
	return true;
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
	dispatchCommand(
		{ type: 'patch', sectionId: section.id, expectedSectionRevision, patch },
		() => {
			optimisticDocumentRevision++;
			optimisticSectionRevisions[section.id] = expectedSectionRevision + 1;
		},
	);
	return true;
}

export function requestHostOwnedMarkdownRemove(sectionId: string): boolean {
	if (!isHostOwnedMarkdownDocument() || pState.restoreInProgress || pState.applyingHostMarkdownProjection || queueBlocked) return false;
	const expectedSectionRevision = optimisticSectionRevisions[sectionId];
	if (!Number.isSafeInteger(expectedSectionRevision)) return false;
	dispatchCommand(
		{ type: 'remove', sectionId, expectedSectionRevision },
		() => {
			optimisticDocumentRevision++;
			delete optimisticSectionRevisions[sectionId];
		},
	);
	return true;
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
	const projection = result.projection && typeof result.projection === 'object'
		? result.projection as unknown as MarkdownDocumentProjection
		: undefined;
	const accepted = result.ok === true
		&& sourceGeneration === pending.sourceGeneration
		&& pending.epoch === projectionEpoch;
	if (accepted && projection && Number.isSafeInteger(projection.documentRevision)) {
		adoptProjection(projection, pendingCommands.size === 0);
		notifyQueueWaiters();
		return { handled: true, accepted: true, projection };
	}
	failureSequence++;
	projectionEpoch++;
	clearPendingCommands();
	if (projection && Number.isSafeInteger(projection.documentRevision)
		&& sourceGeneration === pState.markdownSourceGeneration) {
		queueBlocked = false;
		adoptProjection(projection, true);
		return { handled: true, accepted: false, projection };
	}
	blockQueueAndReload();
	return { handled: true, accepted: false };
}