// Cross-section results state map and simplified Lit-only result routing.
// Extracted from resultsTable-render.ts during legacy results table removal.

import { pState } from '../shared/persistence-state';
import { __kustoTryStoreQueryResult } from './persistence';
import { __kustoSetResultsVisible, setQueryExecuting } from '../sections/query-execution.controller';
import { __kustoNotifyResultsUpdated } from './section-factory';

// ── Results state map ────────────────────────────────────────────────────────

const _resultsByBoxId: Record<string, any> = {};
export let currentResult: any = null;

export function resetCurrentResult() {
	currentResult = null;
}

export function ensureResultsStateMap() {
	return _resultsByBoxId;
}

export function getResultsState(boxId: any) {
	if (!boxId) {
		return null;
	}
	return _resultsByBoxId[boxId] || null;
}

export function setResultsState(boxId: any, state: any) {
	if (!boxId) {
		return;
	}
	_resultsByBoxId[boxId] = state;
	// Backward-compat: keep the last rendered result as the "current" one.
	currentResult = state;
	// Notify any dependent sections (charts/transformations) that this data source changed.
	try { __kustoNotifyResultsUpdated(boxId); } catch (e) { console.error('[kusto]', e); }
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

export function displayResultForBox(result: any, boxId: any, options: any) {
	if (!boxId) { return; }

	// Resolve the section element and delegate to its displayResult() method.
	const sectionEl = document.getElementById(boxId);
	if (sectionEl && typeof (sectionEl as any).displayResult === 'function') {
		(sectionEl as any).displayResult(result, options);
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
	});
	try { __kustoTryStoreQueryResult(boxId, result); } catch (e) { console.error('[kusto]', e); }
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
