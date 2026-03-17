// Cross-section results state map and simplified Lit-only result routing.
// Extracted from resultsTable-render.ts during legacy results table removal.
export {};

const _win = window;

// ── Results state map ────────────────────────────────────────────────────────

function __kustoEnsureResultsStateMap() {
	if (!_win.__kustoResultsByBoxId || typeof _win.__kustoResultsByBoxId !== 'object') {
		_win.__kustoResultsByBoxId = {};
	}
	return _win.__kustoResultsByBoxId;
}

function __kustoGetResultsState(boxId: any) {
	if (!boxId) {
		return null;
	}
	const map = __kustoEnsureResultsStateMap();
	return map[boxId] || null;
}

function __kustoSetResultsState(boxId: any, state: any) {
	if (!boxId) {
		return;
	}
	const map = __kustoEnsureResultsStateMap();
	map[boxId] = state;
	// Backward-compat: keep the last rendered result as the "current" one.
	try { _win.currentResult = state; } catch (e) { console.error('[kusto]', e); }
	// Notify any dependent sections (charts/transformations) that this data source changed.
	try {
		if (typeof _win.__kustoNotifyResultsUpdated === 'function') {
			_win.__kustoNotifyResultsUpdated(boxId);
		}
	} catch (e) { console.error('[kusto]', e); }
}

// ── Raw cell value extraction ────────────────────────────────────────────────
// Used by charts, transformations, and other cross-section consumers.

function __kustoGetRawCellValue(cell: any) {
	try {
		if (cell === null || cell === undefined) return null;
		if (typeof cell === 'object') {
			if (cell && typeof cell === 'object' && 'full' in cell && cell.full !== undefined && cell.full !== null) {
				return __kustoGetRawCellValue(cell.full);
			}
			if (cell && typeof cell === 'object' && 'display' in cell && cell.display !== undefined && cell.display !== null) {
				return __kustoGetRawCellValue(cell.display);
			}
			return cell;
		}
		return cell;
	} catch {
		return cell;
	}
}

// ── Ensure results shown for tool ────────────────────────────────────────────

function __kustoEnsureResultsShownForTool(boxId: any) {
	try {
		if (_win.__kustoResultsVisibleByBoxId && _win.__kustoResultsVisibleByBoxId[boxId] === false) {
			if (typeof (_win.__kustoSetResultsVisible) === 'function') {
				_win.__kustoSetResultsVisible(boxId, true);
			} else {
				_win.__kustoResultsVisibleByBoxId[boxId] = true;
				try {
					if (typeof (_win.__kustoApplyResultsVisibility) === 'function') {
						_win.__kustoApplyResultsVisibility(boxId);
					}
				} catch (e) { console.error('[kusto]', e); }
			}
		}
	} catch (e) { console.error('[kusto]', e); }
}

// ── Lit-only display routing ─────────────────────────────────────────────────

function displayResultForBox(result: any, boxId: any, options: any) {
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

	__kustoSetResultsState(boxId, {
		boxId, columns: cols, rows: rws, metadata: meta,
		selectedCell: null, cellSelectionAnchor: null, cellSelectionRange: null,
		selectedRows: new Set(), searchMatches: [], currentSearchIndex: -1,
		sortSpec: [], columnFilters: {}, filteredRowIndices: null,
		displayRowIndices, rowIndexToDisplayIndex
	});
	try { _win.__kustoTryStoreQueryResult(boxId, result); } catch (e) { console.error('[kusto]', e); }
}

/**
 * Wrapper that routes to displayResultForBox using lastExecutedBox.
 * Called by persistence.ts when restoring saved results from .kqlx files.
 */
function displayResult(result: any) {
	const boxId = _win.lastExecutedBox;
	if (!boxId) { return; }

	try { _win.setQueryExecuting(boxId, false); } catch (e) { console.error('[kusto]', e); }

	displayResultForBox(result, boxId, {
		label: 'Results',
		showExecutionTime: true
	});
}

function displayCancelled() {
	const boxId = _win.lastExecutedBox;
	if (!boxId) { return; }

	try { _win.setQueryExecuting(boxId, false); } catch (e) { console.error('[kusto]', e); }

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

// ── Window bridge exports ────────────────────────────────────────────────────
window.__kustoEnsureResultsStateMap = __kustoEnsureResultsStateMap;
window.__kustoGetResultsState = __kustoGetResultsState;
window.__kustoSetResultsState = __kustoSetResultsState;
window.__kustoGetRawCellValue = __kustoGetRawCellValue;
window.__kustoEnsureResultsShownForTool = __kustoEnsureResultsShownForTool;
window.displayResultForBox = displayResultForBox;
window.displayResult = displayResult;
window.displayCancelled = displayCancelled;
