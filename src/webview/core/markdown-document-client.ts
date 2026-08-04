import type {
	MarkdownDocumentCommand,
	MarkdownDocumentProjection,
} from '../../shared/markdownDocumentAggregate.js';
import { parseDocumentViewProjection } from '../../shared/documentViewProtocol.js';
import type { ChartSectionPatch, ChartSectionState } from '../../shared/chartSectionDefinition.js';
import {
	parseChartSection,
	parseChartSectionPatch,
	patchChartSection,
} from '../../shared/chartSectionDefinition.js';
import type { MarkdownSectionState } from '../../shared/markdownSectionDefinition.js';
import {
	parseMarkdownSection,
	parseMarkdownSectionPatch,
	patchMarkdownSection,
} from '../../shared/markdownSectionDefinition.js';
import type { PythonSectionState } from '../../shared/pythonSectionDefinition.js';
import {
	parsePythonSection,
	parsePythonSectionPatch,
	patchPythonSection,
} from '../../shared/pythonSectionDefinition.js';
import type { UrlSectionState } from '../../shared/urlSectionDefinition.js';
import {
	parseUrlSection,
	parseUrlSectionPatch,
	patchUrlSection,
} from '../../shared/urlSectionDefinition.js';
import type {
	TransformationSectionPatch,
	TransformationSectionState,
} from '../../shared/transformationSectionDefinition.js';
import {
	parseTransformationSection,
	parseTransformationSectionPatch,
	patchTransformationSection,
} from '../../shared/transformationSectionDefinition.js';
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
	chartSections: [],
	markdownSections: [],
	pythonSections: [],
	transformationSections: [],
	urlSections: [],
	orderedSectionIds: [],
};
let authoritativeProjection: MarkdownDocumentProjection = {
	documentRevision: 0,
	sectionRevisions: {},
	markdownSectionRevisions: {},
	chartSections: [],
	markdownSections: [],
	pythonSections: [],
	transformationSections: [],
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

function cloneChartSection(section: ChartSectionState): ChartSectionState {
	return patchChartSection(section, {});
}

function clonePythonSection(section: PythonSectionState): PythonSectionState {
	return { ...section };
}

function cloneUrlSection(section: UrlSectionState): UrlSectionState {
	return { ...section };
}

function cloneTransformationSection(section: TransformationSectionState): TransformationSectionState {
	return patchTransformationSection(section, {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseHostOwnedProjection(input: unknown): MarkdownDocumentProjection | undefined {
	const parsed = parseDocumentViewProjection(input);
	return parsed.ok ? parsed.value : undefined;
}

function commandSection(input: unknown):
	| ChartSectionState
	| MarkdownSectionState
	| PythonSectionState
	| TransformationSectionState
	| UrlSectionState
	| undefined {
	const chart = parseChartSection(input);
	if (chart.ok) return chart.value;
	const markdown = parseMarkdownSection(input);
	if (markdown.ok) return markdown.value;
	const python = parsePythonSection(input);
	if (python.ok) return python.value;
	const transformation = parseTransformationSection(input);
	if (transformation.ok) return transformation.value;
	const url = parseUrlSection(input);
	return url.ok ? url.value : undefined;
}

function cloneProjection(projection: MarkdownDocumentProjection): MarkdownDocumentProjection {
	return {
		documentRevision: projection.documentRevision,
		sectionRevisions: { ...projection.sectionRevisions },
		markdownSectionRevisions: { ...projection.markdownSectionRevisions },
		chartSections: projection.chartSections.map(cloneChartSection),
		markdownSections: projection.markdownSections.map(cloneMarkdownSection),
		pythonSections: projection.pythonSections.map(clonePythonSection),
		transformationSections: projection.transformationSections.map(cloneTransformationSection),
		urlSections: projection.urlSections.map(cloneUrlSection),
		orderedSectionIds: [...projection.orderedSectionIds],
	};
}

function projectionWithAcknowledgedOrder(
	projection: MarkdownDocumentProjection,
	acknowledgedOrder: readonly string[],
): MarkdownDocumentProjection {
	const seen = new Set<string>();
	const orderedSectionIds = acknowledgedOrder
		.map(id => String(id || '').trim())
		.filter(id => !!id && !seen.has(id) && !!seen.add(id));
	const ownedIds = new Set([
		...projection.chartSections.map(section => section.id),
		...projection.markdownSections.map(section => section.id),
		...projection.pythonSections.map(section => section.id),
		...projection.transformationSections.map(section => section.id),
		...projection.urlSections.map(section => section.id),
	]);
	for (let index = 0; index < projection.orderedSectionIds.length; index++) {
		const id = projection.orderedSectionIds[index];
		if (!ownedIds.has(id) || seen.has(id)) continue;
		let insertionIndex = orderedSectionIds.length;
		for (let nextIndex = index + 1; nextIndex < projection.orderedSectionIds.length; nextIndex++) {
			const anchorIndex = orderedSectionIds.indexOf(projection.orderedSectionIds[nextIndex]);
			if (anchorIndex >= 0) {
				insertionIndex = anchorIndex;
				break;
			}
		}
		orderedSectionIds.splice(insertionIndex, 0, id);
		seen.add(id);
	}
	const sectionsById = new Map<
		string,
		ChartSectionState | MarkdownSectionState | PythonSectionState | TransformationSectionState | UrlSectionState
	>([
		...projection.chartSections.map(section => [section.id, cloneChartSection(section)] as const),
		...projection.markdownSections.map(section => [section.id, cloneMarkdownSection(section)] as const),
		...projection.pythonSections.map(section => [section.id, clonePythonSection(section)] as const),
		...projection.transformationSections.map(section => [section.id, cloneTransformationSection(section)] as const),
		...projection.urlSections.map(section => [section.id, cloneUrlSection(section)] as const),
	]);
	const ownedInOrder = orderedSectionIds.flatMap(id => {
		const section = sectionsById.get(id);
		return section ? [section] : [];
	});
	return {
		...cloneProjection(projection),
		chartSections: ownedInOrder.filter((section): section is ChartSectionState => section.type === 'chart'),
		markdownSections: ownedInOrder.filter((section): section is MarkdownSectionState => section.type === 'markdown'),
		pythonSections: ownedInOrder.filter((section): section is PythonSectionState => section.type === 'python'),
		transformationSections: ownedInOrder.filter(
			(section): section is TransformationSectionState => section.type === 'transformation',
		),
		urlSections: ownedInOrder.filter((section): section is UrlSectionState => section.type === 'url'),
		orderedSectionIds,
	};
}

function transitionProjection(
	projection: MarkdownDocumentProjection,
	command: MarkdownDocumentCommand,
): MarkdownDocumentProjection | undefined {
	const sectionsById = new Map<
		string,
		ChartSectionState | MarkdownSectionState | PythonSectionState | TransformationSectionState | UrlSectionState
	>([
		...projection.chartSections.map(section => [section.id, cloneChartSection(section)] as const),
		...projection.markdownSections.map(section => [section.id, cloneMarkdownSection(section)] as const),
		...projection.pythonSections.map(section => [section.id, clonePythonSection(section)] as const),
		...projection.transformationSections.map(
			section => [section.id, cloneTransformationSection(section)] as const,
		),
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
		} else if (section.type === 'chart') {
			const patch = parseChartSectionPatch(command.patch);
			if (!patch.ok) return undefined;
			sectionsById.set(section.id, patchChartSection(section, patch.value));
			sectionRevisions[section.id] = command.expectedSectionRevision + 1;
		} else if (section.type === 'markdown') {
			const patch = parseMarkdownSectionPatch(command.patch);
			if (!patch.ok) return undefined;
			sectionsById.set(section.id, patchMarkdownSection(section, patch.value));
			sectionRevisions[section.id] = command.expectedSectionRevision + 1;
		} else if (section.type === 'python') {
			const patch = parsePythonSectionPatch(command.patch);
			if (!patch.ok) return undefined;
			sectionsById.set(section.id, patchPythonSection(section, patch.value));
			sectionRevisions[section.id] = command.expectedSectionRevision + 1;
		} else if (section.type === 'transformation') {
			const patch = parseTransformationSectionPatch(command.patch);
			if (!patch.ok) return undefined;
			sectionsById.set(section.id, patchTransformationSection(section, patch.value));
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
	const chartSections = ownedInOrder.filter(
		(section): section is ChartSectionState => section.type === 'chart',
	);
	const markdownSections = ownedInOrder.filter(
		(section): section is MarkdownSectionState => section.type === 'markdown',
	);
	const pythonSections = ownedInOrder.filter(
		(section): section is PythonSectionState => section.type === 'python',
	);
	const transformationSections = ownedInOrder.filter(
		(section): section is TransformationSectionState => section.type === 'transformation',
	);
	const urlSections = ownedInOrder.filter(
		(section): section is UrlSectionState => section.type === 'url',
	);
	const canonicalSectionRevisions = Object.fromEntries([
		...chartSections.map(section => [section.id, sectionRevisions[section.id]] as const),
		...markdownSections.map(section => [section.id, sectionRevisions[section.id]] as const),
		...pythonSections.map(section => [section.id, sectionRevisions[section.id]] as const),
		...transformationSections.map(section => [section.id, sectionRevisions[section.id]] as const),
		...urlSections.map(section => [section.id, sectionRevisions[section.id]] as const),
	]);
	return {
		documentRevision: projection.documentRevision + 1,
		sectionRevisions: canonicalSectionRevisions,
		markdownSectionRevisions: Object.fromEntries(
			markdownSections.map(section => [section.id, sectionRevisions[section.id]]),
		),
		chartSections,
		markdownSections,
		pythonSections,
		transformationSections,
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
	const leftKeys = Object.keys(left).filter(key => left[key] !== undefined).sort();
	const rightKeys = Object.keys(right).filter(key => right[key] !== undefined).sort();
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

export function isHostOwnedChartDocument(): boolean {
	return isHostOwnedMarkdownDocument();
}

export function isHostOwnedUrlDocument(): boolean {
	return isHostOwnedMarkdownDocument();
}

export function isHostOwnedPythonDocument(): boolean {
	return isHostOwnedMarkdownDocument();
}

export function isHostOwnedTransformationDocument(): boolean {
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
	authoritativeProjection = cloneProjection(projection);
	pState.markdownDocumentRevision = projection.documentRevision;
	pState.documentSectionRevisions = {
		...(projection.sectionRevisions ?? projection.markdownSectionRevisions),
	};
	pState.markdownSectionRevisions = { ...projection.markdownSectionRevisions };
	pState.hostOwnedMarkdownSections = Object.fromEntries(
		projection.markdownSections.map(section => [section.id, cloneMarkdownSection(section)]),
	);
	pState.hostOwnedChartSections = Object.fromEntries(
		projection.chartSections.map(section => [section.id, cloneChartSection(section)]),
	);
	pState.hostOwnedPythonSections = Object.fromEntries(
		projection.pythonSections.map(section => [section.id, clonePythonSection(section)]),
	);
	pState.hostOwnedTransformationSections = Object.fromEntries(
		projection.transformationSections.map(section => [section.id, cloneTransformationSection(section)]),
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
		chartSections: sections.filter(section => isRecord(section) && section.type === 'chart'),
		markdownSections: sections.filter(section => isRecord(section) && section.type === 'markdown'),
		pythonSections: sections.filter(section => isRecord(section) && section.type === 'python'),
		transformationSections: sections.filter(
			section => isRecord(section) && section.type === 'transformation',
		),
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
	pState.hostOwnedChartSections = {};
	pState.hostOwnedPythonSections = {};
	pState.hostOwnedTransformationSections = {};
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
		chartSections: [],
		markdownSections: [],
		pythonSections: [],
		transformationSections: [],
		urlSections: [],
		orderedSectionIds: [],
	};
	authoritativeProjection = cloneProjection(optimisticProjection);
}

export function acknowledgeHostOwnedDocumentOrder(orderedSectionIds: readonly string[]): boolean {
	if (!isHostOwnedMarkdownDocument()) return false;
	const pendingAddedSectionIds = new Set<string>();
	for (const pending of pendingCommands.values()) {
		if (pending.command.type !== 'add') continue;
		const section = commandSection(pending.command.section);
		if (section) pendingAddedSectionIds.add(section.id);
	}
	let rebased = projectionWithAcknowledgedOrder(
		authoritativeProjection,
		orderedSectionIds.filter(id => !pendingAddedSectionIds.has(String(id || '').trim())),
	);
	authoritativeProjection = cloneProjection(rebased);
	for (const pending of pendingCommands.values()) {
		if (pending.epoch !== projectionEpoch
			|| pending.sourceGeneration !== pState.markdownSourceGeneration
			|| pending.expectedDocumentRevision !== rebased.documentRevision) {
			blockQueueAndReload();
			return false;
		}
		const expectedProjection = transitionProjection(rebased, pending.command);
		if (!expectedProjection) {
			blockQueueAndReload();
			return false;
		}
		pending.expectedProjection = cloneProjection(expectedProjection);
		rebased = expectedProjection;
	}
	synchronizeOptimisticProjection(rebased);
	return true;
}

export function getHostOwnedMarkdownSection(sectionId: string): MarkdownSectionState | undefined {
	const section = pState.hostOwnedMarkdownSections[String(sectionId || '')];
	return section ? cloneMarkdownSection(section) : undefined;
}

export function getHostOwnedChartSection(sectionId: string): ChartSectionState | undefined {
	const section = pState.hostOwnedChartSections[String(sectionId || '')];
	return section ? cloneChartSection(section) : undefined;
}

export function getHostOwnedPythonSection(sectionId: string): PythonSectionState | undefined {
	const section = pState.hostOwnedPythonSections[String(sectionId || '')];
	return section ? clonePythonSection(section) : undefined;
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

export function requestHostOwnedChartAdd(section: ChartSectionState, afterSectionId?: string): boolean {
	if (!isHostOwnedChartDocument() || pState.restoreInProgress || pState.applyingHostMarkdownProjection || queueBlocked) return false;
	if (Number.isSafeInteger(optimisticSectionRevisions[section.id])) return true;
	return dispatchCommand({
		type: 'add', section: cloneChartSection(section), ...(afterSectionId ? { afterSectionId } : {}),
	});
}

function createChartPatch(section: ChartSectionState): ChartSectionPatch {
	const snapshot = cloneChartSection(section);
	const patch: ChartSectionPatch = {};
	const patchRecord = patch as unknown as Record<string, unknown>;
	for (const key of [
		'name', 'mode', 'expanded', 'editorHeightPx', 'dataSourceId', 'chartType', 'xColumn',
		'yColumns', 'yColumn', 'tooltipColumns', 'legendColumn', 'legendPosition', 'stackMode',
		'labelColumn', 'valueColumn', 'sourceColumn', 'targetColumn', 'orient', 'sankeyLeftMargin',
		'showDataLabels', 'labelMode', 'labelDensity', 'sortColumn', 'sortDirection', 'xAxisSettings',
		'yAxisSettings', 'legendSettings', 'heatmapSettings', 'chartTitle', 'chartSubtitle',
		'chartTitleAlign', 'validation',
	] as const) {
		patchRecord[key] = snapshot[key] === undefined ? null : snapshot[key];
	}
	return patch;
}

export function requestHostOwnedChartPatch(section: ChartSectionState): boolean {
	if (!isHostOwnedChartDocument() || pState.restoreInProgress || pState.applyingHostMarkdownProjection || queueBlocked) return false;
	const expectedSectionRevision = optimisticSectionRevisions[section.id];
	if (!Number.isSafeInteger(expectedSectionRevision)) return false;
	const patch = createChartPatch(section);
	const current = optimisticProjection.chartSections.find(candidate => candidate.id === section.id);
	if (current && jsonSemanticallyEqual(patchChartSection(current, patch), current)) return true;
	return dispatchCommand({ type: 'patch', sectionId: section.id, expectedSectionRevision, patch });
}

export function requestHostOwnedChartRemove(sectionId: string): boolean {
	if (!isHostOwnedChartDocument() || pState.restoreInProgress || pState.applyingHostMarkdownProjection || queueBlocked) return false;
	const expectedSectionRevision = optimisticSectionRevisions[sectionId];
	if (!Number.isSafeInteger(expectedSectionRevision)) return false;
	return dispatchCommand({ type: 'remove', sectionId, expectedSectionRevision });
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

export function requestHostOwnedPythonAdd(section: PythonSectionState, afterSectionId?: string): boolean {
	if (!isHostOwnedPythonDocument() || pState.restoreInProgress || pState.applyingHostMarkdownProjection || queueBlocked) return false;
	if (Number.isSafeInteger(optimisticSectionRevisions[section.id])) return true;
	return dispatchCommand({
		type: 'add', section: clonePythonSection(section), ...(afterSectionId ? { afterSectionId } : {}),
	});
}

export function requestHostOwnedPythonPatch(section: PythonSectionState): boolean {
	if (!isHostOwnedPythonDocument() || pState.restoreInProgress || pState.applyingHostMarkdownProjection || queueBlocked) return false;
	const expectedSectionRevision = optimisticSectionRevisions[section.id];
	if (!Number.isSafeInteger(expectedSectionRevision)) return false;
	const current = pState.hostOwnedPythonSections[section.id];
	const patch = {
		name: section.name ?? '',
		code: section.code ?? '',
		output: section.output ?? '',
		expanded: section.expanded ?? true,
		editorHeightPx: section.editorHeightPx ?? null,
	};
	const currentComparable = current ? {
		name: current.name ?? '',
		code: current.code ?? '',
		output: current.output ?? '',
		expanded: current.expanded ?? true,
		editorHeightPx: current.editorHeightPx ?? null,
	} : undefined;
	if (pendingCommands.size === 0 && currentComparable
		&& JSON.stringify(patch) === JSON.stringify(currentComparable)) return true;
	return dispatchCommand({ type: 'patch', sectionId: section.id, expectedSectionRevision, patch });
}

export function requestHostOwnedPythonRemove(sectionId: string): boolean {
	if (!isHostOwnedPythonDocument() || pState.restoreInProgress || pState.applyingHostMarkdownProjection || queueBlocked) return false;
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

export function getHostOwnedTransformationSection(
	sectionId: string,
): TransformationSectionState | undefined {
	const section = pState.hostOwnedTransformationSections[String(sectionId || '')];
	return section ? cloneTransformationSection(section) : undefined;
}

export function requestHostOwnedTransformationAdd(
	section: TransformationSectionState,
	afterSectionId?: string,
): boolean {
	if (!isHostOwnedTransformationDocument()
		|| pState.restoreInProgress || pState.applyingHostMarkdownProjection || queueBlocked) return false;
	if (Number.isSafeInteger(optimisticSectionRevisions[section.id])) return true;
	return dispatchCommand({
		type: 'add',
		section: cloneTransformationSection(section),
		...(afterSectionId ? { afterSectionId } : {}),
	});
}

function createTransformationPatch(section: TransformationSectionState): TransformationSectionPatch {
	const snapshot = cloneTransformationSection(section);
	const patch: TransformationSectionPatch = {};
	const patchRecord = patch as unknown as Record<string, unknown>;
	for (const key of [
		'name', 'mode', 'expanded', 'editorHeightPx', 'dataSourceId', 'transformationType',
		'distinctColumn', 'groupByColumns', 'aggregations', 'deriveColumns', 'deriveColumnName',
		'deriveExpression', 'pivotRowKeyColumn', 'pivotColumnKeyColumn', 'pivotValueColumn',
		'pivotAggregation', 'pivotMaxColumns', 'joinRightDataSourceId', 'joinKind', 'joinKeys',
		'joinOmitDuplicateColumns',
	] as const) {
		patchRecord[key] = snapshot[key] === undefined ? null : snapshot[key];
	}
	return patch;
}

export function requestHostOwnedTransformationPatch(section: TransformationSectionState): boolean {
	if (!isHostOwnedTransformationDocument()
		|| pState.restoreInProgress || pState.applyingHostMarkdownProjection || queueBlocked) return false;
	const expectedSectionRevision = optimisticSectionRevisions[section.id];
	if (!Number.isSafeInteger(expectedSectionRevision)) return false;
	const patch = createTransformationPatch(section);
	const current = optimisticProjection.transformationSections.find(candidate => candidate.id === section.id);
	if (current && jsonSemanticallyEqual(patchTransformationSection(current, patch), current)) return true;
	return dispatchCommand({ type: 'patch', sectionId: section.id, expectedSectionRevision, patch });
}

export function requestHostOwnedTransformationRemove(sectionId: string): boolean {
	if (!isHostOwnedTransformationDocument()
		|| pState.restoreInProgress || pState.applyingHostMarkdownProjection || queueBlocked) return false;
	const expectedSectionRevision = optimisticSectionRevisions[sectionId];
	if (!Number.isSafeInteger(expectedSectionRevision)) return false;
	return dispatchCommand({ type: 'remove', sectionId, expectedSectionRevision });
}