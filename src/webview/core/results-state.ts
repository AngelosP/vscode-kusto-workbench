// Cross-section results state map and simplified Lit-only result routing.
// Extracted from resultsTable-render.ts during legacy results table removal.

import { pState } from '../shared/persistence-state';
import { __kustoSetResultsVisible, setQueryExecuting } from '../sections/query-execution.controller';
import { __kustoNotifyResultsUpdated } from './section-factory';
import {
	projectRowsToDeclaredColumns,
	RESULT_ARTIFACT_CONSUMERS_REVOKED_EVENT,
	ResultArtifactStore,
	type ResultArtifactStoreSnapshot,
	type ResultArtifactPublication,
} from '../../shared/resultArtifact.js';
import {
	getKustoResultSets,
	parseKustoResultBatch,
} from '../../shared/kustoResultBatch.js';
export type {
	ResultArtifact,
	ResultArtifactLineage,
	ResultArtifactPolicy,
	ResultArtifactProducer,
	ResultArtifactPublication,
} from '../../shared/resultArtifact.js';

// ── Results state map ────────────────────────────────────────────────────────

const _resultsByBoxId: Record<string, any> = {};
const _resultBatchesByBoxId: Record<string, readonly any[]> = {};
const _selectedResultIndexByBoxId: Record<string, number> = {};
const _resultsRevisionByBoxId: Record<string, number> = {};
const _resultArtifacts = new ResultArtifactStore();
export let currentResult: any = null;

export type ResultsRuntimeSnapshot = Readonly<{
	states: Record<string, any>;
	batchStates?: Record<string, readonly any[]>;
	selectedResultIndices?: Record<string, number>;
	revisions: Record<string, number>;
	artifacts: ResultArtifactStoreSnapshot;
	currentResult: any;
}>;

function copyResultsRecord<T>(source: Record<string, T>): Record<string, T> {
	const copy = Object.create(null) as Record<string, T>;
	Object.defineProperties(copy, Object.getOwnPropertyDescriptors(source));
	return copy;
}

function replaceResultsRecord<T>(target: Record<string, T>, source: Record<string, T>): void {
	for (const key of Reflect.ownKeys(target)) Reflect.deleteProperty(target, key);
	Object.defineProperties(target, Object.getOwnPropertyDescriptors(source));
}

function resultSetPresentationOptions(states: readonly any[]) {
	return states.map((state, resultIndex) => {
		const resolvedIndex = Number.isSafeInteger(state?.resultIndex) ? Number(state.resultIndex) : resultIndex;
		const resultName = typeof state?.metadata?.resultName === 'string'
			? state.metadata.resultName.trim()
			: '';
		return {
			resultIndex: resolvedIndex,
			label: `Result #${resolvedIndex + 1}${resultName ? ` - ${resultName}` : ''}`,
		};
	});
}

export function captureResultsRuntime(): ResultsRuntimeSnapshot {
	return {
		states: copyResultsRecord(_resultsByBoxId),
		batchStates: copyResultsRecord(_resultBatchesByBoxId),
		selectedResultIndices: copyResultsRecord(_selectedResultIndexByBoxId),
		revisions: copyResultsRecord(_resultsRevisionByBoxId),
		artifacts: _resultArtifacts.captureSnapshot(),
		currentResult,
	};
}

export function restoreResultsRuntime(snapshot: ResultsRuntimeSnapshot, restorePresentation = false): void {
	const currentStates = copyResultsRecord(_resultsByBoxId);
	const currentArtifactIds = new Map(
		Object.keys(currentStates).map(boxId => [
			boxId,
			_resultArtifacts.getCurrent(boxId, _selectedResultIndexByBoxId[boxId] ?? 0)?.artifactId,
		]),
	);
	const snapshotArtifactIds = new Map(Object.keys(snapshot.states).map(boxId => {
		const selectedIndex = snapshot.selectedResultIndices?.[boxId] ?? 0;
		const indexed = snapshot.artifacts.currentIndexedArtifactIds?.find(
			([sourceBoxId, resultIndex]) => sourceBoxId === boxId && resultIndex === selectedIndex,
		);
		const primary = snapshot.artifacts.currentArtifactIds.find(([sourceBoxId]) => sourceBoxId === boxId);
		return [boxId, indexed?.[2] ?? (selectedIndex === 0 ? primary?.[1] : undefined)] as const;
	}));
	const restoreState = () => {
		replaceResultsRecord(_resultsByBoxId, snapshot.states);
		replaceResultsRecord(_resultBatchesByBoxId, snapshot.batchStates ?? Object.fromEntries(
			Object.entries(snapshot.states).map(([boxId, state]) => [boxId, [state]]),
		));
		replaceResultsRecord(_selectedResultIndexByBoxId, snapshot.selectedResultIndices ?? Object.fromEntries(
			Object.keys(snapshot.states).map(boxId => [boxId, 0]),
		));
		replaceResultsRecord(_resultsRevisionByBoxId, snapshot.revisions);
		_resultArtifacts.restoreSnapshot(snapshot.artifacts);
		currentResult = snapshot.currentResult;
	};
	restoreState();
	if (!restorePresentation) return;
	for (const boxId of Object.keys(currentStates)) {
		if (Object.prototype.hasOwnProperty.call(snapshot.states, boxId)) continue;
		const section = document.getElementById(boxId) as any;
		try { section?.clearResults?.(); } catch (error) { console.error('[kusto]', error); }
		try { __kustoNotifyResultsUpdated(boxId); } catch (error) { console.error('[kusto]', error); }
	}
	for (const [boxId, state] of Object.entries(snapshot.states)) {
		if (currentStates[boxId] === state
			&& currentArtifactIds.get(boxId) === snapshotArtifactIds.get(boxId)) continue;
		const section = document.getElementById(boxId) as any;
		try {
			const states = snapshot.batchStates?.[boxId] ?? [state];
			const selectedResultIndex = snapshot.selectedResultIndices?.[boxId] ?? 0;
			section?.displayResult?.(state, {
				label: 'Results', showExecutionTime: true,
				resultSets: resultSetPresentationOptions(states), selectedResultIndex,
			});
			const artifact = _resultArtifacts.getCurrent(boxId, selectedResultIndex);
			if (artifact) section?.setResultArtifactForCsvExport?.(artifact.artifactId);
		} catch (error) {
			console.error('[kusto]', error);
		}
		try { __kustoNotifyResultsUpdated(boxId); } catch (error) { console.error('[kusto]', error); }
	}
	restoreState();
}

export function resetCurrentResult() {
	currentResult = null;
}

export function getResultsState(boxId: any, resultIndex?: number) {
	if (!boxId) {
		return null;
	}
	if (resultIndex !== undefined) {
		if (!Number.isSafeInteger(resultIndex) || resultIndex < 0) return null;
		return _resultBatchesByBoxId[boxId]?.[resultIndex] ?? null;
	}
	return _resultsByBoxId[boxId] || null;
}

export function getResultsBatchState(boxId: unknown): readonly any[] {
	const id = String(boxId || '').trim();
	return id ? _resultBatchesByBoxId[id] ?? [] : [];
}

export function getSelectedResultIndex(boxId: unknown): number {
	const id = String(boxId || '').trim();
	return id && Number.isSafeInteger(_selectedResultIndexByBoxId[id])
		? _selectedResultIndexByBoxId[id]
		: 0;
}

export function getResultsStateRevision(boxId: any) {
	if (!boxId) {
		return 0;
	}
	return _resultsRevisionByBoxId[boxId] || 0;
}

export function getResultArtifact(artifactId: unknown) {
	return _resultArtifacts.get(String(artifactId || '')) || null;
}

export function getCurrentResultArtifact(boxId: unknown, resultIndex = 0) {
	return _resultArtifacts.getCurrent(String(boxId || ''), resultIndex) || null;
}

export function getResultArtifactByProducerExecution(boxId: unknown, executionId: unknown, resultIndex = 0) {
	return _resultArtifacts.getByProducerExecution(
		String(boxId || ''), String(executionId || ''), resultIndex,
	) || null;
}

export function bindResultArtifactConsumer(consumerId: unknown, sourceBoxId: unknown, artifactId?: unknown) {
	return _resultArtifacts.bind(
		String(consumerId || ''),
		String(sourceBoxId || ''),
		artifactId === undefined ? undefined : String(artifactId || ''),
	);
}

export function bindIndexedResultArtifactConsumer(
	consumerId: unknown,
	sourceBoxId: unknown,
	resultIndex: number,
	artifactId?: unknown,
) {
	return _resultArtifacts.bindIndexed(
		String(consumerId || ''),
		String(sourceBoxId || ''),
		resultIndex,
		artifactId === undefined ? undefined : String(artifactId || ''),
	);
}

export function rebindResultArtifactConsumer(consumerId: unknown, sourceBoxId: unknown) {
	const artifactId = bindResultArtifactConsumer(consumerId, sourceBoxId);
	if (!artifactId) unbindResultArtifactConsumer(consumerId);
	return artifactId;
}

export function rebindIndexedResultArtifactConsumer(
	consumerId: unknown,
	sourceBoxId: unknown,
	resultIndex: number,
) {
	const artifactId = bindIndexedResultArtifactConsumer(consumerId, sourceBoxId, resultIndex);
	if (!artifactId) unbindResultArtifactConsumer(consumerId);
	return artifactId;
}

export function getBoundResultArtifact(consumerId: unknown, sourceBoxId?: unknown) {
	return _resultArtifacts.getBound(
		String(consumerId || ''),
		sourceBoxId === undefined ? undefined : String(sourceBoxId || ''),
	) || null;
}

export function unbindResultArtifactConsumer(consumerId: unknown) {
	_resultArtifacts.unbind(String(consumerId || ''));
}

export function setResultsState(boxId: any, state: any, publication: ResultArtifactPublication = {}) {
	return setResultsBatchState(boxId, [state], publication, 0)?.[0];
}

export function setResultsBatchState(
	boxId: any,
	states: readonly any[],
	publication: ResultArtifactPublication = {},
	selectedResultIndex = 0,
	notifyDependents = true,
) {
	if (!boxId) {
		return undefined;
	}
	if (!Array.isArray(states) || states.length === 0
		|| !Number.isSafeInteger(selectedResultIndex) || selectedResultIndex < 0
		|| selectedResultIndex >= states.length) return undefined;
	for (let resultIndex = 0; resultIndex < states.length; resultIndex++) {
		if (states[resultIndex]?.resultIndex !== undefined
			&& states[resultIndex].resultIndex !== resultIndex) return undefined;
	}
	const artifacts = _resultArtifacts.publishBatch(
		String(boxId),
		states.map((state, resultIndex) => ({ resultIndex, ...(state || {}) })),
		publication,
	);
	if (!artifacts) return undefined;
	_resultBatchesByBoxId[boxId] = Object.freeze([...states]);
	_selectedResultIndexByBoxId[boxId] = selectedResultIndex;
	_resultsByBoxId[boxId] = states[selectedResultIndex];
	_resultsRevisionByBoxId[boxId] = (_resultsRevisionByBoxId[boxId] || 0) + 1;
	// Backward-compat: keep the last rendered result as the "current" one.
	currentResult = states[selectedResultIndex];
	// Notify any dependent sections (charts/transformations) that this data source changed.
	if (notifyDependents) {
		try { __kustoNotifyResultsUpdated(boxId); } catch (e) { console.error('[kusto]', e); }
	}
	return artifacts;
}

export function selectResultsState(boxId: unknown, resultIndex: number): boolean {
	const id = String(boxId || '').trim();
	const batch = id ? _resultBatchesByBoxId[id] : undefined;
	if (!batch || !Number.isSafeInteger(resultIndex) || resultIndex < 0 || resultIndex >= batch.length) return false;
	_selectedResultIndexByBoxId[id] = resultIndex;
	_resultsByBoxId[id] = batch[resultIndex];
	currentResult = batch[resultIndex];
	return true;
}

export function retireResultsStateForRerun(boxId: unknown): void {
	const id = String(boxId || '').trim();
	if (!id) return;
	_resultArtifacts.clearCurrentBatch(id);
	delete _resultsByBoxId[id];
	delete _resultBatchesByBoxId[id];
	delete _selectedResultIndexByBoxId[id];
	_resultsRevisionByBoxId[id] = (_resultsRevisionByBoxId[id] || 0) + 1;
	if (currentResult?.boxId === id) currentResult = null;
	try { __kustoNotifyResultsUpdated(id); } catch (e) { console.error('[kusto]', e); }
}

export function clearResultsState(boxId: any) {
	if (!boxId) return;
	const revocation = _resultArtifacts.revokeSource(String(boxId));
	if (revocation.revokedConsumerIds.length) {
		window.dispatchEvent(new CustomEvent(RESULT_ARTIFACT_CONSUMERS_REVOKED_EVENT, {
			detail: { sourceBoxId: String(boxId), consumerIds: revocation.revokedConsumerIds },
		}));
	}
	const affectedBoxIds = revocation.affectedSourceIds;
	for (const affectedBoxId of affectedBoxIds) {
		if (!_resultArtifacts.getCurrent(affectedBoxId)) {
			delete _resultsByBoxId[affectedBoxId];
			delete _resultBatchesByBoxId[affectedBoxId];
			delete _selectedResultIndexByBoxId[affectedBoxId];
			_resultsRevisionByBoxId[affectedBoxId] = (_resultsRevisionByBoxId[affectedBoxId] || 0) + 1;
			if (currentResult?.boxId === affectedBoxId) currentResult = null;
		}
		try { __kustoNotifyResultsUpdated(affectedBoxId); } catch (e) { console.error('[kusto]', e); }
	}
}

// ── Raw cell value extraction ────────────────────────────────────────────────
// Used by charts, transformations, and other cross-section consumers.

export function getRawCellValue(cell: any) {
	try {
		if (cell === null || cell === undefined) return null;
		if (typeof cell === 'object') {
			if (cell && typeof cell === 'object' && 'full' in cell && cell.full !== undefined && cell.full !== null) {
				return getRawCellValue(cell.full);
			}
			if (cell && typeof cell === 'object' && 'display' in cell && cell.display !== undefined && cell.display !== null) {
				return getRawCellValue(cell.display);
			}
			return cell;
		}
		return cell;
	} catch {
		return cell;
	}
}

// ── Ensure results shown for tool ────────────────────────────────────────────

export function ensureResultsShownForTool(boxId: any) {
	try {
		if (pState.resultsVisibleByBoxId && pState.resultsVisibleByBoxId[boxId] === false) {
			__kustoSetResultsVisible(boxId, true);
		}
	} catch (e) { console.error('[kusto]', e); }
}

// ── Lit-only display routing ─────────────────────────────────────────────────

function createResultRuntimeState(boxId: string, resultIndex: number, result: any) {
	const columns = Array.isArray(result?.columns) ? result.columns : [];
	const sourceRows = Array.isArray(result?.rows) ? result.rows : [];
	const rows = projectRowsToDeclaredColumns(columns, sourceRows);
	const metadata = result?.metadata && typeof result.metadata === 'object' ? result.metadata : {};
	const displayRowIndices = rows.map((_: unknown, index: number) => index);
	return {
		resultIndex,
		boxId,
		columns,
		rows,
		metadata,
		selectedCell: null,
		cellSelectionAnchor: null,
		cellSelectionRange: null,
		selectedRows: new Set(),
		searchMatches: [],
		currentSearchIndex: -1,
		sortSpec: [],
		columnFilters: {},
		filteredRowIndices: null,
		displayRowIndices,
		rowIndexToDisplayIndex: [...displayRowIndices],
	};
}

export function displayResultBatchForBox(result: unknown, boxIdValue: unknown, options: any): boolean {
	const boxId = String(boxIdValue || '').trim();
	if (!boxId) return false;
	const parsed = parseKustoResultBatch(result);
	if (!parsed.ok) return false;
	const resultSets = getKustoResultSets(parsed.value);
	const selectedResultIndex = options?.selectedResultIndex === undefined
		? 0
		: Number(options.selectedResultIndex);
	if (!Number.isSafeInteger(selectedResultIndex) || selectedResultIndex < 0
		|| selectedResultIndex >= resultSets.length) return false;
	const section = document.getElementById(boxId) as any;
	if (!section || typeof section.displayResult !== 'function') return false;
	const snapshot = captureResultsRuntime();
	let presentationSnapshot: unknown;
	try { presentationSnapshot = section.captureResultPresentation?.(); } catch { return false; }
	const states = resultSets.map(set => createResultRuntimeState(boxId, set.resultIndex, set));
	const artifacts = setResultsBatchState(
		boxId, states, options?.artifactPublication || {}, selectedResultIndex, false,
	);
	if (!artifacts) return false;
	const resultSetOptions = resultSetPresentationOptions(resultSets);
	let accepted = false;
	try {
		accepted = section.displayResult(states[selectedResultIndex], {
			...options,
			selectedResultIndex,
			resultSets: resultSetOptions,
			deferCsvRelease: true,
		}) !== false;
	} catch (error) {
		console.error('[kusto] Failed to render Kusto result batch:', error);
	}
	if (!accepted) {
		restoreResultsRuntime(snapshot, false);
		try { section.restoreResultPresentation?.(presentationSnapshot); } catch (error) { console.error('[kusto]', error); }
		return false;
	}
	try {
		section.setResultArtifactForCsvExport?.(artifacts[selectedResultIndex].artifactId);
	} catch (error) {
		console.error('[kusto] Failed to register Kusto batch CSV artifact:', error);
	}
	try { __kustoNotifyResultsUpdated(boxId); } catch (error) { console.error('[kusto]', error); }
	return true;
}

export function displayResultForBox(result: any, boxId: any, options: any): boolean {
	if (!boxId) { return false; }
	const cols = Array.isArray(result?.columns) ? result.columns : [];
	const sourceRows = Array.isArray(result?.rows) ? result.rows : [];
	const rws = projectRowsToDeclaredColumns(cols, sourceRows);
	const meta = (result?.metadata && typeof result.metadata === 'object') ? result.metadata : {};
	const normalizedResult = rws === sourceRows
		? result
		: { ...result, columns: cols, rows: rws, metadata: meta };

	// Resolve the section element and delegate to its displayResult() method.
	const sectionEl = document.getElementById(boxId);
	if (!sectionEl) {
		clearResultsState(boxId);
		return false;
	}
	if (sectionEl && typeof (sectionEl as any).displayResult === 'function') {
		const accepted = (sectionEl as any).displayResult(normalizedResult, options);
		if (accepted === false) {
			clearResultsState(boxId);
			return false;
		}
	}

	// Update global results state for cross-section dependencies (charts, diff, etc.).
	const displayRowIndices: number[] = [];
	const rowIndexToDisplayIndex: number[] = [];
	for (let i = 0; i < rws.length; i++) {
		displayRowIndices.push(i);
		rowIndexToDisplayIndex.push(i);
	}

	let artifact;
	try {
		artifact = setResultsState(boxId, {
			boxId, columns: cols, rows: rws, metadata: meta,
			selectedCell: null, cellSelectionAnchor: null, cellSelectionRange: null,
			selectedRows: new Set(), searchMatches: [], currentSearchIndex: -1,
			sortSpec: [], columnFilters: {}, filteredRowIndices: null,
			displayRowIndices, rowIndexToDisplayIndex
		}, options?.artifactPublication || {});
	} catch (e) {
		console.error('[kusto] Failed to publish result artifact:', e);
	}
	if (!artifact) {
		try { (sectionEl as any).clearResults?.(); } catch (e) { console.error('[kusto]', e); }
		clearResultsState(boxId);
		return false;
	}
	if (typeof (sectionEl as any).setResultArtifactForCsvExport === 'function') {
		(sectionEl as any).setResultArtifactForCsvExport(artifact.artifactId);
	}
	return true;
}

/**
 * Wrapper that routes to displayResultForBox using lastExecutedBox.
 * Called by persistence.ts when restoring saved results from .kqlx files.
 */
export function displayResult(result: any) {
	const boxId = pState.lastExecutedBox;
	if (!boxId) { return; }

	try { setQueryExecuting(boxId, false); } catch (e) { console.error('[kusto]', e); }

	displayResultForBox(result, boxId, {
		label: 'Results',
		showExecutionTime: true
	});
}

export function displayCancelled() {
	const boxId = pState.lastExecutedBox;
	if (!boxId) { return; }

	try { setQueryExecuting(boxId, false); } catch (e) { console.error('[kusto]', e); }

	// Delegate to the Lit section element if available.
	const sectionEl = document.getElementById(boxId);
	if (sectionEl && typeof (sectionEl as any).displayError === 'function') {
		(sectionEl as any).displayError('Cancelled.');
		return;
	}

	// Fallback: write into the results div directly.
	const resultsDiv = document.getElementById(boxId + '_results');
	if (!resultsDiv) { return; }
	resultsDiv.innerHTML =
		'<div class="results-header">' +
		'<strong>Cancelled.</strong>' +
		'</div>';
	resultsDiv.classList.add('visible');
}

// Window bridges removed (D8) — getResultsState exported, all consumers use ES imports.
