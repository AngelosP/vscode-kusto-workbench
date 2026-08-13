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
export type {
	ResultArtifact,
	ResultArtifactLineage,
	ResultArtifactPolicy,
	ResultArtifactProducer,
	ResultArtifactPublication,
} from '../../shared/resultArtifact.js';

// ── Results state map ────────────────────────────────────────────────────────

const _resultsByBoxId: Record<string, any> = {};
const _resultsRevisionByBoxId: Record<string, number> = {};
const _resultArtifacts = new ResultArtifactStore();
export let currentResult: any = null;

export type ResultsRuntimeSnapshot = Readonly<{
	states: Record<string, any>;
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

export function captureResultsRuntime(): ResultsRuntimeSnapshot {
	return {
		states: copyResultsRecord(_resultsByBoxId),
		revisions: copyResultsRecord(_resultsRevisionByBoxId),
		artifacts: _resultArtifacts.captureSnapshot(),
		currentResult,
	};
}

export function restoreResultsRuntime(snapshot: ResultsRuntimeSnapshot, restorePresentation = false): void {
	const currentStates = copyResultsRecord(_resultsByBoxId);
	const currentArtifactIds = new Map(
		Object.keys(currentStates).map(boxId => [boxId, _resultArtifacts.getCurrent(boxId)?.artifactId]),
	);
	const snapshotArtifactIds = new Map(snapshot.artifacts.currentArtifactIds);
	const restoreState = () => {
		replaceResultsRecord(_resultsByBoxId, snapshot.states);
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
			section?.displayResult?.(state, { label: 'Results', showExecutionTime: true });
			const artifact = _resultArtifacts.getCurrent(boxId);
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

export function getResultsState(boxId: any) {
	if (!boxId) {
		return null;
	}
	return _resultsByBoxId[boxId] || null;
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

export function getCurrentResultArtifact(boxId: unknown) {
	return _resultArtifacts.getCurrent(String(boxId || '')) || null;
}

export function getResultArtifactByProducerExecution(boxId: unknown, executionId: unknown) {
	return _resultArtifacts.getByProducerExecution(String(boxId || ''), String(executionId || '')) || null;
}

export function bindResultArtifactConsumer(consumerId: unknown, sourceBoxId: unknown, artifactId?: unknown) {
	return _resultArtifacts.bind(
		String(consumerId || ''),
		String(sourceBoxId || ''),
		artifactId === undefined ? undefined : String(artifactId || ''),
	);
}

export function rebindResultArtifactConsumer(consumerId: unknown, sourceBoxId: unknown) {
	const artifactId = bindResultArtifactConsumer(consumerId, sourceBoxId);
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
	if (!boxId) {
		return undefined;
	}
	const artifact = _resultArtifacts.publish(String(boxId), state || {}, publication);
	if (!artifact) return undefined;
	_resultsByBoxId[boxId] = state;
	_resultsRevisionByBoxId[boxId] = (_resultsRevisionByBoxId[boxId] || 0) + 1;
	// Backward-compat: keep the last rendered result as the "current" one.
	currentResult = state;
	// Notify any dependent sections (charts/transformations) that this data source changed.
	try { __kustoNotifyResultsUpdated(boxId); } catch (e) { console.error('[kusto]', e); }
	return artifact;
}

export function retireResultsStateForRerun(boxId: unknown): void {
	const id = String(boxId || '').trim();
	if (!id) return;
	_resultArtifacts.clearCurrent(id);
	delete _resultsByBoxId[id];
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
