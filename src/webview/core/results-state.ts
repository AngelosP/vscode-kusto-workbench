// Cross-section results state map and simplified Lit-only result routing.
// Extracted from resultsTable-render.ts during legacy results table removal.

import { pState } from '../shared/persistence-state';
import { __kustoSetResultsVisible, setQueryExecuting } from '../sections/query-execution.controller';
import { __kustoNotifyResultsUpdated } from './section-factory';
import {
	ResultArtifactStore,
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
		return;
	}
	_resultArtifacts.publish(String(boxId), state || {}, publication);
	_resultsByBoxId[boxId] = state;
	_resultsRevisionByBoxId[boxId] = (_resultsRevisionByBoxId[boxId] || 0) + 1;
	// Backward-compat: keep the last rendered result as the "current" one.
	currentResult = state;
	// Notify any dependent sections (charts/transformations) that this data source changed.
	try { __kustoNotifyResultsUpdated(boxId); } catch (e) { console.error('[kusto]', e); }
}

export function clearResultsState(boxId: any) {
	if (!boxId) return;
	const affectedBoxIds = _resultArtifacts.revokeSource(String(boxId));
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

	// Resolve the section element and delegate to its displayResult() method.
	const sectionEl = document.getElementById(boxId);
	if (!sectionEl) {
		clearResultsState(boxId);
		return false;
	}
	if (sectionEl && typeof (sectionEl as any).displayResult === 'function') {
		const accepted = (sectionEl as any).displayResult(result, options);
		if (accepted === false) {
			clearResultsState(boxId);
			return false;
		}
	}

	// Update global results state for cross-section dependencies (charts, diff, etc.).
	const cols = Array.isArray(result && result.columns) ? result.columns : [];
	const rws = Array.isArray(result && result.rows) ? result.rows : [];
	const meta = (result && result.metadata && typeof result.metadata === 'object') ? result.metadata : {};

	const displayRowIndices: number[] = [];
	const rowIndexToDisplayIndex: number[] = [];
	for (let i = 0; i < rws.length; i++) {
		displayRowIndices.push(i);
		rowIndexToDisplayIndex.push(i);
	}

	setResultsState(boxId, {
		boxId, columns: cols, rows: rws, metadata: meta,
		selectedCell: null, cellSelectionAnchor: null, cellSelectionRange: null,
		selectedRows: new Set(), searchMatches: [], currentSearchIndex: -1,
		sortSpec: [], columnFilters: {}, filteredRowIndices: null,
		displayRowIndices, rowIndexToDisplayIndex
	}, options?.artifactPublication || {});
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
