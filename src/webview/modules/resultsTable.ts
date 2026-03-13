// Results table module — converted from legacy/resultsTable.js
// Window bridge exports at bottom for remaining legacy callers.
import './resultsTable-export';
export {};

const _win = window as unknown as Record<string, any>;

function __kustoCopyClientActivityId(boxId: any) {
	try {
		const el = document.getElementById(boxId + '_client_activity_id');
		const text = el ? el.textContent : '';
		if (text && navigator.clipboard) {
			navigator.clipboard.writeText(text).then(function () {
				// Brief visual feedback
				const btn = el && el.nextElementSibling;
				if (btn) {
					btn.classList.add('results-footer-copy-done');
					setTimeout(function () { btn.classList.remove('results-footer-copy-done'); }, 1200);
				}
			}).catch(function () { /* ignore */ });
		}
	} catch { /* ignore */ }
}

function __kustoGetSearchIconSvg() {
	return (
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<circle cx="7" cy="7" r="4.2" />' +
		'<path d="M10.4 10.4L14 14" />' +
		'</svg>'
	);
}

function __kustoGetScrollToColumnIconSvg() {
	return (
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 3.5h10" />' +
		'<path d="M3 6.5h10" />' +
		'<path d="M3 9.5h6" />' +
		'<path d="M3 12.5h6" />' +
		'<path d="M12.5 8v5" />' +
		'<path d="M11 11.5l1.5 1.5 1.5-1.5" />' +
		'</svg>'
	);
}

function __kustoGetCopyIconSvg() {
	return (
			'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<rect x="5" y="5" width="9" height="9" rx="2" ry="2" />' +
		'<path d="M3 11V4a2 2 0 0 1 2-2h7" />' +
		'</svg>'
	);
}

function __kustoGetSaveIconSvg() {
	return (
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 2.5h8.2L13.5 4.8V13.5a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z" />' +
		'<path d="M5 2.8V6h6V2.8" />' +
		'<path d="M5 14.5V9.5h6v5" />' +
		'</svg>'
	);
}

function __kustoGetFilterIconSvg(size: any) {
	const s = (typeof size === 'number' && isFinite(size) && size > 0) ? Math.floor(size) : 12;
	return (
		'<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M2.5 3.5h11" />' +
		'<path d="M4.5 7.5h7" />' +
		'<path d="M6.5 11.5h3" />' +
		'</svg>'
	);
}

function __kustoGetResultsVisibilityIconSvg() {
	return (
			'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z" />' +
		'<circle cx="8" cy="8" r="2.1" />' +
		'</svg>'
	);
}

function __kustoEnsureResultsShownForTool(boxId: any) {
	try {
		if ((_win.__kustoResultsVisibleByBoxId as any) && (_win.__kustoResultsVisibleByBoxId as any)[boxId] === false) {
			if (typeof (_win.__kustoSetResultsVisible) === 'function') {
				(_win.__kustoSetResultsVisible as any)(boxId, true);
			} else {
				(_win.__kustoResultsVisibleByBoxId as any)[boxId] = true;
				try {
					if (typeof (_win.__kustoApplyResultsVisibility) === 'function') {
						(_win.__kustoApplyResultsVisibility as any)(boxId);
					}
				} catch { /* ignore */ }
			}
		}
	} catch {
		// ignore
	}
}

// Helper function to focus the table container.
// Note: DOM focus can be flaky in VS Code webviews when coming from external apps.
// Instead of fighting focus with timers, we track the last interaction and handle Ctrl+C
// globally (see __kustoEnsureResultsCopyKeyHandlerInstalled).
function __kustoFocusTableContainer(container: any, boxId: any) {
	if (!container) return;
	try {
		(_win.__kustoLastActiveResultsBoxId as any) = boxId;
		(_win.__kustoLastActiveResultsInteractionAt as any) = Date.now();
	} catch { /* ignore */ }
	try { container.focus(); } catch { /* ignore */ }
}

function __kustoEnsureResultsCopyKeyHandlerInstalled() {
	try {
		if ((_win.__kustoResultsCopyKeyHandlerInstalled as any)) return;
		(_win.__kustoResultsCopyKeyHandlerInstalled as any) = true;
	} catch { /* ignore */ }

	document.addEventListener('keydown', (event) => {
		try {
			if (!event || event.defaultPrevented) return;
			if (!(event.ctrlKey || event.metaKey)) return;
			const k = String(event.key || '');
			if (k !== 'c' && k !== 'C') return;

			// If the user is focused in a real text-editing surface, let native copy win.
			// (Unless it's inside the results table container.)
			try {
				const t = event.target as any;
				if (t && t.closest) {
					const inResultsTable = !!t.closest('.table-container');
					const inTextSurface = !!t.closest('input, textarea, [contenteditable="true"]');
					if (inTextSurface && !inResultsTable) {
						return;
					}
				}
			} catch { /* ignore */ }

			const boxId = (typeof (_win.__kustoLastActiveResultsBoxId as any) === 'string') ? (_win.__kustoLastActiveResultsBoxId as any) : '';
			if (!boxId) return;

			// Only override Ctrl+C if the last interaction was with results more recently than Monaco.
			const lastResultsAt = Number((_win.__kustoLastActiveResultsInteractionAt as any) || 0);
			const lastMonacoAt = Number((_win.__kustoLastMonacoInteractionAt as any) || 0);
			if (lastResultsAt <= lastMonacoAt) return;

			const state = typeof __kustoGetResultsState === 'function' ? __kustoGetResultsState(boxId) : null;
			if (!state) return;

			const hasCellSelection = !!state.selectedCell || !!state.cellSelectionRange;
			const hasRowSelection = !!(state.selectedRows && state.selectedRows.size > 0);
			if (!hasCellSelection && !hasRowSelection) return;

			try { event.preventDefault(); } catch { /* ignore */ }
			try { event.stopPropagation(); } catch { /* ignore */ }
			try { if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation(); } catch { /* ignore */ }
			try { _win.copySelectionToClipboard(boxId); } catch { /* ignore */ }
		} catch { /* ignore */ }
	}, true);
}

try { __kustoEnsureResultsCopyKeyHandlerInstalled(); } catch { /* ignore */ }

function __kustoSetResultsToolsVisible(boxId: any, visible: any) {
	const searchBtn = document.getElementById(boxId + '_results_search_btn');
	const columnBtn = document.getElementById(boxId + '_results_column_btn');
	const sortBtn = document.getElementById(boxId + '_results_sort_btn');
	const copyBtn = document.getElementById(boxId + '_results_copy_btn');
	const saveBtn = document.getElementById(boxId + '_results_save_btn');
	const copyMenuBtn = document.getElementById(boxId + '_results_copy_menu_btn');
	const saveMenuBtn = document.getElementById(boxId + '_results_save_menu_btn');
	const copySplit = document.getElementById(boxId + '_results_copy_split');
	const saveSplit = document.getElementById(boxId + '_results_save_split');
	const sep2 = document.getElementById(boxId + '_results_sep_2');
	const display = visible ? '' : 'none';
		try { if (searchBtn) { searchBtn.style.display = display; } } catch { /* ignore */ }
	try { if (columnBtn) { columnBtn.style.display = display; } } catch { /* ignore */ }
	try { if (sortBtn) { sortBtn.style.display = display; } } catch { /* ignore */ }
	try { if (copyBtn) { copyBtn.style.display = display; } } catch { /* ignore */ }
	try { if (saveBtn) { saveBtn.style.display = display; } } catch { /* ignore */ }
	// Split carets follow filtered state; don't force them visible just because tools are shown.
	try {
		if (!visible) {
			if (copyMenuBtn) { copyMenuBtn.style.display = 'none'; }
			if (saveMenuBtn) { saveMenuBtn.style.display = 'none'; }
		} else {
			const state = __kustoGetResultsState(boxId);
			const filtered = _win.__kustoIsResultsFiltered(state);
			if (typeof _win.__kustoSetSplitCaretsVisible === 'function') {
				_win.__kustoSetSplitCaretsVisible(boxId, filtered);
			} else {
				// Fallback: show/hide directly.
				const caretDisplay = filtered ? '' : 'none';
				if (copyMenuBtn) { copyMenuBtn.style.display = caretDisplay; }
				if (saveMenuBtn) { saveMenuBtn.style.display = caretDisplay; }
			}
		}
	} catch { /* ignore */ }
	try { if (copySplit) { copySplit.style.display = display; } } catch { /* ignore */ }
	try { if (saveSplit) { saveSplit.style.display = display; } } catch { /* ignore */ }
	try { if (sep2) { sep2.style.display = display; } } catch { /* ignore */ }
}

function __kustoHideResultsTools(boxId: any) {
	try {
		const searchContainer = document.getElementById(boxId + '_data_search_container');
		if (searchContainer) {
			searchContainer.style.display = 'none';
		}
	} catch { /* ignore */ }
	try {
		const columnContainer = document.getElementById(boxId + '_column_search_container');
		if (columnContainer) {
			columnContainer.style.display = 'none';
		}
	} catch { /* ignore */ }
	try {
		const sortModal = document.getElementById(boxId + '_sort_modal');
		if (sortModal) {
			sortModal.classList.remove('visible');
		}
	} catch { /* ignore */ }
	try {
		const searchBtn = document.getElementById(boxId + '_results_search_btn');
		if (searchBtn) {
			searchBtn.classList.remove('active');
		}
	} catch { /* ignore */ }
	try {
		const columnBtn = document.getElementById(boxId + '_results_column_btn');
		if (columnBtn) {
			columnBtn.classList.remove('active');
		}
	} catch { /* ignore */ }
	try {
		const sortBtn = document.getElementById(boxId + '_results_sort_btn');
		if (sortBtn) {
			sortBtn.classList.remove('active');
		}
	} catch { /* ignore */ }
}

function __kustoGetSortIconSvg() {
	return (
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M5 3v10" />' +
		'<path d="M3.5 5L5 3l1.5 2" />' +
		'<path d="M11 13V3" />' +
		'<path d="M9.5 11L11 13l1.5-2" />' +
		'</svg>'
	);
}

function __kustoGetTrashIconSvg(size: any) {
	const s = (typeof size === 'number' && isFinite(size) && size > 0) ? Math.floor(size) : 14;
	return (
		'<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 4h10" />' +
		'<path d="M6 4V3h4v1" />' +
		'<path d="M5 4l.6 10h4.8L11 4" />' +
		'<path d="M7 7v5" />' +
		'<path d="M9 7v5" />' +
		'</svg>'
	);
}

function __kustoGetSelectAllIconSvg(size: any) {
	const s = (typeof size === 'number' && isFinite(size) && size > 0) ? Math.floor(size) : 14;
	return (
		'<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<rect x="2.5" y="2.5" width="11" height="11" rx="2" ry="2" />' +
		'<path d="M4.8 8.2l2 2 4.5-4.6" />' +
		'</svg>'
	);
}

function __kustoGetDeselectAllIconSvg(size: any) {
	const s = (typeof size === 'number' && isFinite(size) && size > 0) ? Math.floor(size) : 14;
	return (
		'<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<rect x="2.5" y="2.5" width="11" height="11" rx="2" ry="2" />' +
		'</svg>'
	);
}

const __KUSTO_NULL_EMPTY_KEY = '__kusto_null_empty__';

function __kustoGetCloseIconSvg(size: any) {
	const s = (typeof size === 'number' && isFinite(size) && size > 0) ? Math.floor(size) : 14;
	return (
		'<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M4 4l8 8" />' +
		'<path d="M12 4l-8 8" />' +
		'</svg>'
	);
}

function __kustoNormalizeSortDirection(dir: any) {
	return (dir === 'desc') ? 'desc' : 'asc';
}

function __kustoNormalizeSortSpec(spec: any, columnCount: any) {
	const out = [];
	const seen = new Set();
	const list = Array.isArray(spec) ? spec : [];
	for (const item of list) {
		if (!item || typeof item !== 'object') continue;
		const colIndex = parseInt(String(item.colIndex), 10);
		if (!isFinite(colIndex) || colIndex < 0 || colIndex >= columnCount) continue;
		if (seen.has(colIndex)) continue;
		seen.add(colIndex);
		out.push({ colIndex: colIndex, dir: __kustoNormalizeSortDirection(item.dir) });
	}
	return out;
}

function __kustoGetCellSortValue(cell: any) {
	// Prefer underlying values over truncated display values.
	try {
			if (cell === null || cell === undefined) {
			return { kind: 'null', v: null };
		}
		if (typeof cell === 'number') {
			return { kind: 'number', v: cell };
		}
		if (cell instanceof Date) {
			const t = cell.getTime();
			return isFinite(t) ? { kind: 'date', v: t } : { kind: 'string', v: String(cell) };
		}
		if (typeof cell === 'boolean') {
			return { kind: 'number', v: cell ? 1 : 0 };
		}
		if (typeof cell === 'object') {
			if (cell && typeof cell === 'object' && 'full' in cell && cell.full !== undefined && cell.full !== null) {
				return __kustoGetCellSortValue(cell.full);
			}
			if (cell && typeof cell === 'object' && 'display' in cell && cell.display !== undefined && cell.display !== null) {
				return __kustoGetCellSortValue(cell.display);
			}
			// Objects: stringify to get deterministic ordering.
			return { kind: 'string', v: JSON.stringify(cell) };
		}
		const s = String(cell);
		// Numeric strings: sort as numbers.
		const trimmed = s.trim();
		if (/^[+-]?(?:\d+\.?\d*|\d*\.?\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
			const num = parseFloat(trimmed);
			if (isFinite(num)) {
				return { kind: 'number', v: num };
			}
		}
		// Date-like strings: sort as dates (timestamps).
		try {
			const ms = __kustoTryParseDateMs(trimmed);
			if (ms !== null) {
				return { kind: 'date', v: ms };
			}
		} catch { /* ignore */ }
		return { kind: 'string', v: s };
	} catch {
		return { kind: 'string', v: String(cell) };
	}
}

function __kustoCompareSortValues(a: any, b: any) {
	// Nulls always last.
	if (a.kind === 'null' && b.kind === 'null') return 0;
	if (a.kind === 'null') return 1;
	if (b.kind === 'null') return -1;
	if (a.kind === 'date' && b.kind === 'date') {
		if (a.v < b.v) return -1;
		if (a.v > b.v) return 1;
		return 0;
	}
	// Compare date vs non-date by falling back to numeric/string.
	if (a.kind === 'number' && b.kind === 'number') {
		if (a.v < b.v) return -1;
		if (a.v > b.v) return 1;
		return 0;
	}
	const as = String(a.v);
	const bs = String(b.v);
	try {
		return as.localeCompare(bs, undefined, { numeric: true, sensitivity: 'base' });
	} catch {
		if (as < bs) return -1;
		if (as > bs) return 1;
		return 0;
	}
}

function __kustoFormatNumberForDisplay(val: any) {
	try {
		if (val === null || val === undefined) return '';
		const n = (typeof val === 'number') ? val : null;
		if (n === null || !isFinite(n)) return String(val);
		// Avoid surprising formatting for extremely large magnitudes.
		if (Math.abs(n) >= 1e21) return String(val);
		if (Number.isInteger(n)) {
			return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
		}
		return n.toLocaleString(undefined, { maximumFractionDigits: 20 });
	} catch {
		try { return String(val); } catch { return ''; }
	}
}

function __kustoFormatDateForDisplay(dateStr: any) {
	// Convert date strings to a clean format like "2025-01-24 15:30:45".
	// This matches the formatting applied by the Kusto client backend.
	// Handles:
	// - ISO 8601 (e.g., "2025-01-24T15:30:45.123Z")
	// - Verbose Date.toString() format (e.g., "Fri Jan 24 2025 08:30:45 GMT-0800")
	// - Other parseable date strings
	try {
		if (!dateStr || typeof dateStr !== 'string') return null;
		const s = dateStr.trim();
		if (!s) return null;

		// Skip pure numeric strings - don't treat them as dates
		if (/^[+-]?\d+(\.\d+)?$/.test(s)) return null;

		// Quick check: if it's already in our target format "YYYY-MM-DD HH:MM:SS", leave it alone
		if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;

		// Match ISO 8601 date-time patterns - format directly without parsing
		const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
		if (isoPattern.test(s)) {
			const parsed = Date.parse(s);
			if (!isFinite(parsed)) return null;
			// Format: replace T with space, remove milliseconds and Z
			return s.replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '');
		}

		// Try to parse other date formats (e.g., verbose "Fri Jan 24 2025 08:30:45 GMT...")
		// Only attempt this for strings that look like they might be dates
		// (contain month names, or patterns like "Day Mon DD YYYY")
		const verboseDatePattern = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d/i;
		if (verboseDatePattern.test(s)) {
			const parsed = Date.parse(s);
			if (isFinite(parsed)) {
				const d = new Date(parsed);
				// Format as YYYY-MM-DD HH:MM:SS in UTC to match Kusto results
				const formatted = d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
				return formatted;
			}
		}

		return null;
	} catch {
		return null;
	}
}

function __kustoFormatCellDisplayValueForTable(cell: any) {
	try {
		if (cell === null || cell === undefined) return '';
		if (typeof cell === 'number') {
			return __kustoFormatNumberForDisplay(cell);
		}
		if (typeof cell === 'string') {
			const s = cell.trim();
			// Only group reasonably-sized numeric strings to avoid precision loss.
			if (s.length > 0 && s.length <= 15 && /^[+-]?(?:\d+\.?\d*|\d*\.?\d+)$/.test(s)) {
				const num = parseFloat(s);
				if (isFinite(num)) {
					return __kustoFormatNumberForDisplay(num);
				}
			}
			// Format ISO date strings in a friendly way (e.g., "2025-01-24 15:30:45")
			const dateFormatted = __kustoFormatDateForDisplay(s);
			if (dateFormatted !== null) {
				return dateFormatted;
			}
			return cell;
		}
		return cell;
	} catch {
		try { return String(cell); } catch { return ''; }
	}
}

function __kustoComputeSortedRowIndices(rows: any, sortSpec: any, baseIndices: any) {
	const count = Array.isArray(rows) ? rows.length : 0;
	const spec = Array.isArray(sortSpec) ? sortSpec : [];
	const input = Array.isArray(baseIndices) ? baseIndices : null;
	const indices = input ? input.slice() : (() => {
		const tmp = [];
		for (let i = 0; i < count; i++) tmp.push(i);
		return tmp;
	})();
	if (spec.length === 0 || indices.length <= 1) {
		return indices;
	}
	// Stable sort: tie-break by original position in the input list.
	const decorated = indices.map((rowIndex, pos) => ({ rowIndex, pos }));
	decorated.sort((a: any, b: any) => {
		for (const rule of spec) {
			const colIndex = rule.colIndex;
			const dir = rule.dir === 'desc' ? -1 : 1;
			const r1 = rows[a.rowIndex] || [];
			const r2 = rows[b.rowIndex] || [];
			const v1 = __kustoGetCellSortValue(r1[colIndex]);
			const v2 = __kustoGetCellSortValue(r2[colIndex]);
			const cmp = __kustoCompareSortValues(v1, v2);
			if (cmp !== 0) return dir * cmp;
		}
		return a.pos - b.pos;
	});
	return decorated.map(d => d.rowIndex);
}

function __kustoEnsureDisplayRowIndexMaps(state: any) {
	if (!state) return;
	const rows = Array.isArray(state.rows) ? state.rows : [];
	const sortSpec = Array.isArray(state.sortSpec) ? state.sortSpec : [];
	const base = Array.isArray(state.filteredRowIndices) ? state.filteredRowIndices : null;
	state.displayRowIndices = __kustoComputeSortedRowIndices(rows, sortSpec, base);
	// Build inverse map: originalRow -> displayRow.
	const inv = new Array(rows.length);
	for (let displayIdx = 0; displayIdx < state.displayRowIndices.length; displayIdx++) {
		inv[state.displayRowIndices[displayIdx]] = displayIdx;
	}
	state.rowIndexToDisplayIndex = inv;
}

function __kustoEnsureColumnFiltersMap(state: any) {
	if (!state) return {};
	if (!state.columnFilters || typeof state.columnFilters !== 'object') {
		state.columnFilters = {};
	}
	return state.columnFilters;
}

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

function __kustoIsNullOrEmpty(val: any) {
	try {
		if (val === null || val === undefined) return true;
		if (typeof val === 'string') return val.trim().length === 0;
		return false;
	} catch {
		return false;
	}
}

function __kustoTryParseNumber(val: any) {
	if (val === null || val === undefined) return null;
	if (typeof val === 'number') return isFinite(val) ? val : null;
	if (typeof val === 'boolean') return val ? 1 : 0;
	const s = String(val).trim();
	if (!s) return null;
	if (!/^[+-]?(?:\d+\.?\d*|\d*\.?\d+)(?:[eE][+-]?\d+)?$/.test(s)) return null;
	const n = parseFloat(s);
	return isFinite(n) ? n : null;
}

function __kustoTryParseDateMs(val: any) {
	if (val === null || val === undefined) return null;
	if (val instanceof Date) {
		const t = val.getTime();
		return isFinite(t) ? t : null;
	}
	const s = String(val).trim();
	if (!s) return null;
	// Avoid treating numeric-only strings as dates.
	if (/^[+-]?(?:\d+\.?\d*|\d*\.?\d+)$/.test(s)) return null;
	const t = Date.parse(s);
	return isFinite(t) ? t : null;
}

function __kustoInferColumnType(state: any, colIndex: any, rowIndicesForInference: any) {
	try {
		const rows = Array.isArray(state && state.rows) ? state.rows : [];
		const indices = Array.isArray(rowIndicesForInference)
			? rowIndicesForInference
			: (Array.isArray(state && state.displayRowIndices) ? state.displayRowIndices : rows.map((_: any, i: any) => i));
		let seen = 0;
		let objCount = 0;
		let numCount = 0;
		let dateCount = 0;
		for (let k = 0; k < indices.length && seen < 50; k++) {
			const rowIdx = indices[k];
			const row = rows[rowIdx];
			if (!row) continue;
			const raw = __kustoGetRawCellValue(row[colIndex]);
			if (__kustoIsNullOrEmpty(raw)) continue;
			seen++;
			if (raw && typeof raw === 'object') {
				objCount++;
				continue;
			}
			if (__kustoTryParseNumber(raw) !== null) numCount++;
			if (__kustoTryParseDateMs(raw) !== null) dateCount++;
		}
		if (objCount > 0) return 'json';
		if (seen === 0) return 'string';
		const numRatio = numCount / seen;
		const dateRatio = dateCount / seen;
		// Prefer date over number if values look like timestamps.
		if (dateRatio >= 0.8) return 'date';
		if (numRatio >= 0.8) return 'number';
		return 'string';
	} catch {
		return 'string';
	}
}

function __kustoGetRowIndicesExcludingColumnFilter(state: any, excludeColIndex: any) {
	const rows = Array.isArray(state && state.rows) ? state.rows : [];
	let indices = [];
	for (let i = 0; i < rows.length; i++) indices.push(i);
	const filters = __kustoEnsureColumnFiltersMap(state);
	for (const key of Object.keys(filters)) {
		const colIndex = parseInt(String(key), 10);
		if (!isFinite(colIndex) || colIndex < 0) continue;
		if (colIndex === excludeColIndex) continue;
		const spec = filters[key];
		if (!spec) continue;
		indices = indices.filter(rowIdx => __kustoRowMatchesColumnFilter(state, rowIdx, colIndex, spec));
	}
	return indices;
}

function __kustoNormalizeStringForFilter(val: any) {
	try {
		if (val === null || val === undefined) return '';
		return String(val);
	} catch {
		return '';
	}
}

function __kustoRowMatchesNullPolicy(raw: any, spec: any) {
	const isEmpty = __kustoIsNullOrEmpty(raw);
	const includeNullEmpty = !(spec && spec.includeNullEmpty === false);
	const includeNotNullEmpty = !(spec && spec.includeNotNullEmpty === false);
	if (isEmpty) return includeNullEmpty;
	return includeNotNullEmpty;
}

function __kustoRowMatchesColumnFilter(state: any, rowIdx: any, colIndex: any, spec: any): any {
	try {
		const rows = Array.isArray(state && state.rows) ? state.rows : [];
		const row = rows[rowIdx];
		if (!row) return false;
		const raw = __kustoGetRawCellValue(row[colIndex]);
		const isEmpty = __kustoIsNullOrEmpty(raw);
		if (spec && spec.kind === 'compound') {
			const v = spec.values ? __kustoRowMatchesColumnFilter(state, rowIdx, colIndex, spec.values) : true;
			if (!v) return false;
			const r = spec.rules ? __kustoRowMatchesColumnFilter(state, rowIdx, colIndex, spec.rules) : true;
			return r;
		}
		if (spec && spec.kind === 'values') {
			const allowed = Array.isArray(spec.allowedValues) ? spec.allowedValues : [];
			if (isEmpty) return allowed.includes(__KUSTO_NULL_EMPTY_KEY);
			const key = __kustoNormalizeStringForFilter(raw);
			return allowed.includes(key);
		}
		if (spec && spec.kind === 'rules') {
			const t = String(spec.dataType || 'string');
			const fallbackJoinOp = (String(spec.combineOp || 'and') === 'or') ? 'or' : 'and';
			let rules = Array.isArray(spec.rules) ? spec.rules : null;
			// Back-compat: single rule format.
			if (!rules && spec.op) {
				rules = [spec];
			}
			if (!Array.isArray(rules) || rules.length === 0) return true;

			const matchesRule = (rule: any) => {
				if (!rule || typeof rule !== 'object') return null;
				const op = String(rule.op || '');
				if (!op) return null;
				if (op === 'isEmpty') return !!isEmpty;
				if (op === 'isNotEmpty') return !isEmpty;
				if (isEmpty) return false;

				if (t === 'number') {
					const n = __kustoTryParseNumber(raw);
					if (n === null) return false;
					const a = __kustoTryParseNumber(rule.a);
					const b = __kustoTryParseNumber(rule.b);
					if (op === 'lt') return (a !== null) ? (n < a) : true;
					if (op === 'gt') return (a !== null) ? (n > a) : true;
					if (op === 'between') {
						if (a === null || b === null) return true;
						const lo = Math.min(a, b);
						const hi = Math.max(a, b);
						return (n >= lo && n <= hi);
					}
					if (op === 'top') {
						const thr = __kustoTryParseNumber(rule.threshold !== undefined ? rule.threshold : spec.threshold);
						return (thr !== null) ? (n >= thr) : true;
					}
					if (op === 'bottom') {
						const thr = __kustoTryParseNumber(rule.threshold !== undefined ? rule.threshold : spec.threshold);
						return (thr !== null) ? (n <= thr) : true;
					}
					return true;
				}

				if (t === 'date') {
					const ms = __kustoTryParseDateMs(raw);
					if (ms === null) return false;
					const a = __kustoTryParseDateMs(rule.a);
					const b = __kustoTryParseDateMs(rule.b);
					if (op === 'before') return (a !== null) ? (ms < a) : true;
					if (op === 'after') return (a !== null) ? (ms > a) : true;
					if (op === 'between') {
						if (a === null || b === null) return true;
						const lo = Math.min(a, b);
						const hi = Math.max(a, b);
						return (ms >= lo && ms <= hi);
					}
					if (op === 'last') {
						const thr = __kustoTryParseDateMs(rule.threshold !== undefined ? rule.threshold : spec.threshold);
						return (thr !== null) ? (ms >= thr) : true;
					}
					return true;
				}

				if (t === 'json') {
					const hay = (raw && typeof raw === 'object') ? (() => {
						try { return JSON.stringify(raw); } catch { return String(raw); }
					})() : String(raw);
					const needle = String(rule.text || '');
					if (!needle) return null;
					const contains = hay.toLowerCase().includes(needle.toLowerCase());
					if (op === 'contains') return contains;
					if (op === 'notContains') return !contains;
					return true;
				}

				// string
				const s = __kustoNormalizeStringForFilter(raw);
				const needle = String(rule.text || '');
				if (!needle) return null;
				const sLow = s.toLowerCase();
				const nLow = needle.toLowerCase();
				if (op === 'startsWith') return sLow.startsWith(nLow);
				if (op === 'notStartsWith') return !sLow.startsWith(nLow);
				if (op === 'endsWith') return sLow.endsWith(nLow);
				if (op === 'notEndsWith') return !sLow.endsWith(nLow);
				if (op === 'contains') return sLow.includes(nLow);
				if (op === 'notContains') return !sLow.includes(nLow);
				return true;
			};

			// Combine rules left-to-right using each rule's join operator (applies between that rule and the next).
			let acc = false;
			let any = false;
			let prevRule = null;
			for (const rule of rules) {
				const m = matchesRule(rule);
				if (m === null) continue;
				if (!any) {
					acc = !!m;
					any = true;
					prevRule = rule;
					continue;
				}
				const joinOp = (String(((prevRule || {}).join) || '') === 'or') ? 'or' : fallbackJoinOp;
				acc = (joinOp === 'or') ? (acc || !!m) : (acc && !!m);
				prevRule = rule;
			}
			return any ? acc : true;
		}
		return true;
	} catch {
		return true;
	}
}

function __kustoComputeUniqueValueKeys(state: any, colIndex: any, rowIndices: any) {
	const rows = Array.isArray(state && state.rows) ? state.rows : [];
	const indices = Array.isArray(rowIndices) ? rowIndices : rows.map((_: any, i: any) => i);
	const counts = new Map();
	let nullCount = 0;
	let truncated = false;
	const max = 200;
	for (let i = 0; i < indices.length; i++) {
		const row = rows[indices[i]];
		if (!row) continue;
		const raw = __kustoGetRawCellValue(row[colIndex]);
		if (__kustoIsNullOrEmpty(raw)) {
			nullCount++;
			continue;
		}
		const key = __kustoNormalizeStringForFilter(raw);
		counts.set(key, (counts.get(key) || 0) + 1);
		if (counts.size > max) {
			truncated = true;
			break;
		}
	}
	const keys = Array.from(counts.keys());
	keys.sort((a: any, b: any) => {
		const ca = counts.get(a) || 0;
		const cb = counts.get(b) || 0;
		if (cb !== ca) return cb - ca;
		try { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); } catch { return a < b ? -1 : (a > b ? 1 : 0); }
	});
	return { keys, counts, nullCount, truncated };
}

function __kustoNormalizeDraftFilter(state: any, colIndex: any, draft: any): any {
	const spec = (draft && typeof draft === 'object') ? { ...draft } : null;
	if (!spec) return null;

	if (spec.kind === 'compound') {
		const valuesSpec = spec.values && typeof spec.values === 'object' ? spec.values : null;
		const rulesSpec = spec.rules && typeof spec.rules === 'object' ? spec.rules : null;
		const vNorm = valuesSpec ? __kustoNormalizeDraftFilter(state, colIndex, valuesSpec) : null;
		const rNorm = rulesSpec ? __kustoNormalizeDraftFilter(state, colIndex, rulesSpec) : null;
		if (!vNorm && !rNorm) return null;
		if (vNorm && !rNorm) return vNorm;
		if (!vNorm && rNorm) return rNorm;
		return { kind: 'compound', values: vNorm, rules: rNorm };
	}

	if (spec.kind === 'values') {
		const baseRowIndices = __kustoGetRowIndicesExcludingColumnFilter(state, colIndex);
		const uniq = __kustoComputeUniqueValueKeys(state, colIndex, baseRowIndices);
		const allKeys = ([] as any[]).concat((uniq.nullCount > 0) ? [__KUSTO_NULL_EMPTY_KEY] : [], uniq.keys);
		const allowed = Array.isArray(spec.allowedValues) ? spec.allowedValues.filter((v: any) => typeof v === 'string') : [];
		// If user selected all known values, treat as no-op.
		if (allowed.length >= allKeys.length) {
			// Compare as sets.
			const a = new Set(allKeys);
			let all = true;
			for (const k of allowed) {
				if (!a.has(k)) { all = false; break; }
			}
			if (all) return null;
		}
		spec.allowedValues = allowed;
		return spec;
	}

	if (spec.kind === 'rules') {
		const t = String(spec.dataType || 'string');
		spec.combineOp = (String(spec.combineOp || 'and') === 'or') ? 'or' : 'and';
		let rules = Array.isArray(spec.rules) ? spec.rules.slice() : null;
		// Back-compat: single rule format
		if (!rules && spec.op) {
			rules = [{ ...spec }];
		}
		if (!Array.isArray(rules)) rules = [];
		rules = rules.filter((r: any) => r && typeof r === 'object' && String(r.op || ''));
		rules = rules.map((r: any) => ({ ...r, join: (String(r.join || '') === 'or') ? 'or' : 'and' }));
		if (rules.length === 0) return null;
		spec.rules = rules;
		spec.op = undefined;
		spec.a = undefined;
		spec.b = undefined;
		spec.n = undefined;
		spec.unit = undefined;
		spec.text = undefined;
		spec.threshold = undefined;

		// Precompute thresholds for top/bottom/last per rule.
		const baseRowIndices = __kustoGetRowIndicesExcludingColumnFilter(state, colIndex);
		if (t === 'number') {
			const needsRank = rules.some((r: any) => {
				const op = String(r.op || '');
				return op === 'top' || op === 'bottom';
			});
			let sortedValues = null;
			if (needsRank) {
				sortedValues = [];
				for (const rowIdx of baseRowIndices) {
					const row = (state.rows || [])[rowIdx];
					if (!row) continue;
					const raw = __kustoGetRawCellValue(row[colIndex]);
					const v = __kustoTryParseNumber(raw);
					if (v === null) continue;
					sortedValues.push(v);
				}
				sortedValues.sort((a: any, b: any) => a - b);
			}
			for (const r of rules) {
				const op = String(r.op || '');
				if (op !== 'top' && op !== 'bottom') continue;
				const nRaw = parseInt(String(r.n || ''), 10);
				const n = (isFinite(nRaw) && nRaw > 0) ? nRaw : 0;
				if (!sortedValues || sortedValues.length === 0 || n <= 0) continue;
				if (op === 'top') {
					const idx = Math.max(0, sortedValues.length - n);
					r.threshold = sortedValues[idx];
				} else {
					const idx = Math.min(sortedValues.length - 1, Math.max(0, n - 1));
					r.threshold = sortedValues[idx];
				}
			}
		}
		if (t === 'date') {
			for (const r of rules) {
				const op = String(r.op || '');
				if (op !== 'last') continue;
				const nRaw = parseInt(String(r.n || ''), 10);
				const n = (isFinite(nRaw) && nRaw > 0) ? nRaw : 0;
				const unit = String(r.unit || 'days');
				if (n <= 0) continue;
				const now = Date.now();
				let delta = 0;
				if (unit === 'minutes') delta = n * 60 * 1000;
				else if (unit === 'hours') delta = n * 60 * 60 * 1000;
				else if (unit === 'weeks') delta = n * 7 * 24 * 60 * 60 * 1000;
				else if (unit === 'months') delta = n * 30 * 24 * 60 * 60 * 1000;
				else if (unit === 'years') delta = n * 365 * 24 * 60 * 60 * 1000;
				else delta = n * 24 * 60 * 60 * 1000;
				r.threshold = new Date(now - delta).toISOString();
			}
		}
		return spec;
	}

	return null;
}

function __kustoGetRulesCombineEnabledFromDom(boxId: any) {
	try {
		const el = document.getElementById(boxId + '_filter_rules_combine_toggle');
		if (!el) return false;
		const v = String(el.getAttribute('aria-checked') || 'false');
		return v === 'true';
	} catch {
		return false;
	}
}

function __kustoSetRulesCombineEnabled(boxId: any, enabled: any) {
	try {
		if ((_win.__kustoActiveFilterPopover as any)) {
			(_win.__kustoActiveFilterPopover as any).draftCombine = !!enabled;
		}
		const el = document.getElementById(boxId + '_filter_rules_combine_toggle');
		if (!el) return;
		el.setAttribute('aria-checked', enabled ? 'true' : 'false');
		el.classList.toggle('on', !!enabled);
		el.classList.toggle('off', !enabled);
		el.textContent = enabled ? 'On' : 'Off';
	} catch { /* ignore */ }
}

function __kustoToggleRulesCombine(boxId: any) {
	try {
		const enabled = __kustoGetRulesCombineEnabledFromDom(boxId);
		__kustoSetRulesCombineEnabled(boxId, !enabled);
	} catch { /* ignore */ }
}

function __kustoGetRulesJoinOpFromDom(boxId: any) {
	try {
		const el = document.getElementById(boxId + '_filter_rules_join');
		if (!el) return 'and';
		const v = String(el.getAttribute('data-join') || 'and');
		return (v === 'or') ? 'or' : 'and';
	} catch {
		return 'and';
	}
}

function __kustoSetRulesJoinOp(boxId: any, joinOp: any) {
	try {
		const op = (String(joinOp) === 'or') ? 'or' : 'and';
		if ((_win.__kustoActiveFilterPopover as any)) {
			(_win.__kustoActiveFilterPopover as any).draftRulesJoinOp = op;
		}
		const el = document.getElementById(boxId + '_filter_rules_join');
		if (el) el.setAttribute('data-join', op);
		const andBtn = document.getElementById(boxId + '_filter_rules_join_and');
		const orBtn = document.getElementById(boxId + '_filter_rules_join_or');
		if (andBtn) andBtn.classList.toggle('active', op === 'and');
		if (orBtn) orBtn.classList.toggle('active', op === 'or');
	} catch { /* ignore */ }
}

function __kustoApplyFiltersAndRerender(boxId: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const rows = Array.isArray(state.rows) ? state.rows : [];
	const filters = __kustoEnsureColumnFiltersMap(state);
	const keys = Object.keys(filters).filter(k => filters[k]);
	if (keys.length === 0) {
		state.filteredRowIndices = null;
		__kustoEnsureDisplayRowIndexMaps(state);
		__kustoRerenderResultsTable(boxId);
		return;
	}
	let indices = [];
	for (let i = 0; i < rows.length; i++) indices.push(i);
	for (const key of keys) {
		const colIndex = parseInt(String(key), 10);
		if (!isFinite(colIndex) || colIndex < 0) continue;
		const spec = filters[key];
		if (!spec) continue;
		indices = indices.filter(rowIdx => __kustoRowMatchesColumnFilter(state, rowIdx, colIndex, spec));
	}
	state.filteredRowIndices = indices;
	// Search matches are based on visible cells; clear them when filters change.
	try {
		state.searchMatches = [];
		state.currentSearchIndex = -1;
		const statusEl = document.getElementById(boxId + '_data_search_status');
		const prevBtn = document.getElementById(boxId + '_data_search_prev');
		const nextBtn = document.getElementById(boxId + '_data_search_next');
		if (typeof (_win.__kustoUpdateSearchStatus) === 'function') {
			(_win.__kustoUpdateSearchStatus as any)(statusEl, 0, 0, false, '');
		}
		if (typeof (_win.__kustoSetSearchNavEnabled) === 'function') {
			(_win.__kustoSetSearchNavEnabled as any)(prevBtn, nextBtn, false, 0);
		}
		document.querySelectorAll('#' + boxId + '_table td.search-match, #' + boxId + '_table td.search-match-current')
			.forEach(cell => {
				cell.classList.remove('search-match', 'search-match-current');
			});
	} catch { /* ignore */ }

	__kustoEnsureDisplayRowIndexMaps(state);
	__kustoRerenderResultsTable(boxId);
	try { (_win.schedulePersist as any) && (_win.schedulePersist as any)('filter'); } catch { /* ignore */ }
}

function closeColumnFilterPopover() {
	try {
		if (!(_win.__kustoActiveFilterPopover as any)) return;
		const { elId } = (_win.__kustoActiveFilterPopover as any);
		const el = elId ? document.getElementById(elId) : null;
		if (el) el.remove();
	} catch { /* ignore */ }
	try { (_win.__kustoActiveFilterPopover as any) = null; } catch { /* ignore */ }
}

function closeColumnFilterDialogOnBackdrop(event: any) {
	try {
		if (!event || !(_win.__kustoActiveFilterPopover as any)) return;
		if (event.target !== event.currentTarget) return;
		closeColumnFilterPopover();
	} catch { /* ignore */ }
}

function __kustoEnsureFilterGlobalCloseHandler() {
	if ((_win.__kustoFilterGlobalCloseHandlerInstalled as any)) return;
	(_win.__kustoFilterGlobalCloseHandlerInstalled as any) = true;
	document.addEventListener('click', (event) => {
		try {
			if (!(_win.__kustoActiveFilterPopover as any)) return;
			const elId = (_win.__kustoActiveFilterPopover as any).elId;
			const el = elId ? document.getElementById(elId) : null;
			if (!el) {
				(_win.__kustoActiveFilterPopover as any) = null;
				return;
			}
			const target = event && (event as any).target;
			if (target && (el.contains(target as Node) || ((target as any).closest && (target as any).closest('.column-menu-btn')))) {
				return;
			}
			closeColumnFilterPopover();
		} catch {
			// ignore
		}
	}, true);
}

function openColumnFilter(event: any, colIndex: any, boxId: any) {
	try {
		if (event && typeof event.preventDefault === 'function') event.preventDefault();
		if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
	} catch { /* ignore */ }
	__kustoEnsureFilterGlobalCloseHandler();
	try { closeColumnFilterPopover(); } catch { /* ignore */ }

	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const colIdx = parseInt(String(colIndex), 10);
	if (!isFinite(colIdx) || colIdx < 0) return;

	const modalId = boxId + '_filter_modal';
	const dialogId = boxId + '_filter_dialog';
	const modal = document.createElement('div');
	modal.id = modalId;
	modal.className = 'kusto-filter-modal visible';
	modal.setAttribute('onclick', "closeColumnFilterDialogOnBackdrop(event)");
	const dialog = document.createElement('div');
	dialog.id = dialogId;
	dialog.className = 'kusto-filter-dialog';
	dialog.setAttribute('onclick', 'event.stopPropagation();');
	modal.appendChild(dialog);

	// Render
	const filters = __kustoEnsureColumnFiltersMap(state);
	const existing = filters[String(colIdx)] || null;
	const baseRowIndices = __kustoGetRowIndicesExcludingColumnFilter(state, colIdx);
	const inferredType = __kustoInferColumnType(state, colIdx, baseRowIndices);
	const mode = (existing && existing.kind === 'rules') || (existing && existing.kind === 'compound') ? 'rules' : 'values';
	(_win.__kustoActiveFilterPopover as any) = { boxId, colIndex: colIdx, mode, dataType: inferredType, elId: modalId, dialogId };
	dialog.innerHTML = __kustoRenderFilterPopoverHtml(boxId, colIdx);
	document.body.appendChild(modal);
	try { __kustoEnsureFilterPopoverSearchControl(boxId, colIdx); } catch { /* ignore */ }
}

function __kustoEnsureFilterPopoverSearchControl(boxId: any, colIdx: any) {
	try {
		const active = (_win.__kustoActiveFilterPopover as any);
		if (!active || active.boxId !== boxId || active.colIndex !== colIdx) return;
		if (String(active.mode || '') !== 'values') return;

		const host = document.getElementById(boxId + '_filter_value_search_host');
		if (!host) return;
		if (document.getElementById(boxId + '_filter_value_search')) return;

		if (typeof (_win.__kustoCreateSearchControl as any) !== 'function') {
			// Older webview / script load order issue; fall back silently.
			return;
		}

		(_win.__kustoCreateSearchControl as any)(host, {
			inputId: boxId + '_filter_value_search',
			modeId: boxId + '_filter_value_search_mode',
			inputClass: 'kusto-filter-search kusto-filter-values-search kusto-filter-search-with-icon',
			ariaLabel: 'Search values',
			onInput: function () { __kustoFilterSearchValues(boxId, colIdx); }
		});
	} catch { /* ignore */ }
}

function __kustoRenderFilterPopoverHtml(boxId: any, colIdx: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return '';
	const cols = Array.isArray(state.columns) ? state.columns : [];
	const colName = cols[colIdx] !== undefined ? String(cols[colIdx]) : ('Column ' + String(colIdx));
	const active = (_win.__kustoActiveFilterPopover as any);
	const mode = active && active.mode ? String(active.mode) : 'values';
	const dataType = active && active.dataType ? String(active.dataType) : 'string';
	const filters = __kustoEnsureColumnFiltersMap(state);
	const existing = filters[String(colIdx)] || null;

	const modeValuesActive = mode === 'values' ? ' active' : '';
	const modeRulesActive = mode === 'rules' ? ' active' : '';

	let body = '';
	if (mode === 'values') {
		const baseRowIndices = __kustoGetRowIndicesExcludingColumnFilter(state, colIdx);
		const uniq = __kustoComputeUniqueValueKeys(state, colIdx, baseRowIndices);
		const allPossibleKeys = ([] as any[]).concat((uniq.nullCount > 0) ? [__KUSTO_NULL_EMPTY_KEY] : [], uniq.keys);
		const draftAllowed = (active && Array.isArray(active.draftValuesAllowed)) ? active.draftValuesAllowed : null;
		const selected = (
			draftAllowed
				? draftAllowed
				: (existing && existing.kind === 'values' && Array.isArray(existing.allowedValues)
					? existing.allowedValues
					: (existing && existing.kind === 'compound' && existing.values && Array.isArray(existing.values.allowedValues)
						? existing.values.allowedValues
						: allPossibleKeys))
		);
		const selectedSet = new Set(selected);
		const truncNote = uniq.truncated ? '<div class="kusto-filter-note">Too many distinct values; showing first 200.</div>' : '';
		body += (
			'<div class="kusto-filter-section kusto-filter-values-toolbar">' +
			'<div class="kusto-filter-searchbox kusto-filter-values-searchbox">' +
			'<span class="kusto-filter-search-icon" aria-hidden="true">' + __kustoGetSearchIconSvg() + '</span>' +
			'<div id="' + boxId + '_filter_value_search_host"></div>' +
			'</div>' +
			'<div class="kusto-filter-values-actions-row">' +
			'<button type="button" class="kusto-filter-mini-btn" onclick="__kustoFilterSetAllValues(\'' + __kustoEscapeJsStringLiteral(boxId) + '\', ' + String(colIdx) + ', true)" title="Select all" aria-label="Select all"><span class="kusto-filter-mini-btn-icon">' + __kustoGetSelectAllIconSvg(14) + '</span>Select all</button>' +
			'<button type="button" class="kusto-filter-mini-btn" onclick="__kustoFilterSetAllValues(\'' + __kustoEscapeJsStringLiteral(boxId) + '\', ' + String(colIdx) + ', false)" title="Deselect all" aria-label="Deselect all"><span class="kusto-filter-mini-btn-icon">' + __kustoGetDeselectAllIconSvg(14) + '</span>Deselect all</button>' +
			'</div>' +
			'</div>' +
			'<div class="kusto-filter-values-columns" role="group" aria-label="Value list columns">' +
			'<span class="kusto-filter-values-columns-spacer" aria-hidden="true"></span>' +
			'<span class="kusto-filter-values-columns-value">Values</span>' +
			'<span class="kusto-filter-values-columns-count">Number of rows containing it</span>' +
			'</div>' +
			'<div class="kusto-filter-values" id="' + boxId + '_filter_values_list">' +
			((uniq.nullCount > 0)
				? (() => {
					const k = __KUSTO_NULL_EMPTY_KEY;
					const checked = selectedSet.has(k) ? ' checked' : '';
					const cnt = uniq.nullCount || 0;
					return '<label class="kusto-filter-value" data-value-text="null or empty"><input type="checkbox" class="kusto-filter-value-cb" value="' + __kustoEscapeForHtmlAttribute(k) + '"' + checked + ' /> <span class="kusto-filter-value-text">Null or empty</span><span class="kusto-filter-value-count">' + String(cnt) + '</span></label>';
				})()
				: '') +
			uniq.keys.map((k: any) => {
				const checked = selectedSet.has(k) ? ' checked' : '';
				const cnt = uniq.counts.get(k) || 0;
				const dt = String(k || '').toLowerCase();
				return '<label class="kusto-filter-value" data-value-text="' + __kustoEscapeForHtmlAttribute(dt) + '"><input type="checkbox" class="kusto-filter-value-cb" value="' + __kustoEscapeForHtmlAttribute(k) + '"' + checked + ' /> <span class="kusto-filter-value-text">' + __kustoEscapeForHtml(k) + '</span><span class="kusto-filter-value-count">' + String(cnt) + '</span></label>';
			}).join('') +
			'</div>' +
			truncNote
		);
	} else {
		const draftRules = (active && Array.isArray(active.draftRules)) ? active.draftRules : null;
		const rulesExisting = draftRules ? { kind: 'rules', dataType, rules: draftRules } : existing;
		body += (
			'<div class="kusto-filter-section" style="display:block;">' +
			'<div class="kusto-filter-rules" id="' + boxId + '_filter_rules_list">' + __kustoRenderRulesListHtml(boxId, colIdx, dataType, rulesExisting) + '</div>' +
			'</div>'
		);
	}

	const header = (
		'<div class="kusto-filter-header">' +
		'<div class="kusto-filter-title">Filter applied to the column &#39;' + __kustoEscapeForHtml(colName) + '&#39;</div>' +
		'<button type="button" class="unified-btn-secondary unified-btn-icon-only refresh-btn close-btn kusto-filter-close-btn" onclick="closeColumnFilterPopover()" title="Close" aria-label="Close">' + __kustoGetCloseIconSvg(14) + '</button>' +
		'</div>'
	);

	const combineChecked = (active && typeof active.draftCombine === 'boolean')
		? !!active.draftCombine
		: !!(existing && existing.kind === 'compound');
	const rulesTopToggle = (mode === 'rules')
		? (
			'<div class="kusto-filter-rules-combine" aria-label="Apply rules on top of values">' +
			'<span class="kusto-filter-rules-combine-label">Apply these rules on top of the value filters</span>' +
			'<button type="button" id="' + boxId + '_filter_rules_combine_toggle" class="kusto-filter-pill-toggle ' + (combineChecked ? 'on' : 'off') + '" role="switch" aria-checked="' + (combineChecked ? 'true' : 'false') + '" onclick="__kustoToggleRulesCombine(\'' + __kustoEscapeJsStringLiteral(boxId) + '\')">' + (combineChecked ? 'On' : 'Off') + '</button>' +
			'</div>'
		)
		: '';
	const modes = (
		'<div class="kusto-filter-modes-bar">' +
		'<div class="kusto-filter-modes">' +
		'<button type="button" class="kusto-filter-mode-btn' + modeValuesActive + '" onclick="__kustoSetFilterMode(\'' + __kustoEscapeJsStringLiteral(boxId) + '\', ' + String(colIdx) + ', \'values\')">Values</button>' +
		'<button type="button" class="kusto-filter-mode-btn' + modeRulesActive + '" onclick="__kustoSetFilterMode(\'' + __kustoEscapeJsStringLiteral(boxId) + '\', ' + String(colIdx) + ', \'rules\')">Rules</button>' +
		'</div>' +
		rulesTopToggle +
		'</div>'
	);

	const footer = (
		'<div class="kusto-filter-footer">' +
		'<button type="button" class="kusto-filter-btn danger" onclick="clearColumnFilter(\'' + __kustoEscapeJsStringLiteral(boxId) + '\', ' + String(colIdx) + ')"><span class="kusto-filter-btn-icon">' + __kustoGetTrashIconSvg(14) + '</span>Remove</button>' +
		'<button type="button" class="kusto-filter-btn secondary" onclick="closeColumnFilterPopover()"><span class="kusto-filter-btn-icon">' + __kustoGetCloseIconSvg(14) + '</span>Close</button>' +
		'<button type="button" class="kusto-filter-btn" onclick="applyColumnFilter(\'' + __kustoEscapeJsStringLiteral(boxId) + '\', ' + String(colIdx) + ')"><span class="kusto-filter-btn-icon">' + __kustoGetFilterIconSvg(14) + '</span>Apply</button>' +
		'</div>'
	);

	return header + modes + '<div class="kusto-filter-body">' + body + '</div>' + footer;
}

function __kustoFilterSearchValues(boxId: any, colIdx: any) {
	try {
		if (typeof (_win.__kustoGetSearchControlState as any) !== 'function' || typeof (_win.__kustoTryBuildSearchRegex as any) !== 'function') {
			// Backward compat: treat as simple contains.
			const q = String((document.getElementById(boxId + '_filter_value_search') as any || {}).value || '').trim().toLowerCase();
			const list = document.getElementById(boxId + '_filter_values_list');
			if (!list) return;
			const items = Array.from(list.querySelectorAll('label.kusto-filter-value')) as any[];
			for (const it of items) {
				const t = String((it && it.getAttribute && it.getAttribute('data-value-text')) || '').toLowerCase();
				(it as any).style.display = (!q || t.includes(q)) ? '' : 'none';
			}
			return;
		}

		const st = (_win.__kustoGetSearchControlState as any)(boxId + '_filter_value_search', boxId + '_filter_value_search_mode');
		const q = String((st && st.query) ? st.query : '');
		const mode = st && st.mode ? st.mode : 'wildcard';
		const built = (_win.__kustoTryBuildSearchRegex as any)(q, mode);
		const input = document.getElementById(boxId + '_filter_value_search');
		try { if (input) input.title = built && built.error ? String(built.error) : ''; } catch { /* ignore */ }
		const regex = built && built.regex ? built.regex : null;

		const list = document.getElementById(boxId + '_filter_values_list');
		if (!list) return;
		const items = Array.from(list.querySelectorAll('label.kusto-filter-value')) as any[];
		for (const it of items) {
			const t = String((it && it.getAttribute && it.getAttribute('data-value-text')) || '');
			const hit = (!q || !regex) ? true : !!(_win.__kustoRegexTest as any)(regex, t);
			it.style.display = hit ? '' : 'none';
		}
	} catch { /* ignore */ }
}

function __kustoFilterSetAllValues(boxId: any, colIdx: any, checked: any) {
	try {
		const list = document.getElementById(boxId + '_filter_values_list');
		if (!list) return;
		const cbs = Array.from(list.querySelectorAll('input.kusto-filter-value-cb')) as any[];
		for (const cb of cbs) {
			if (!cb) continue;
			// Only affect currently visible values (e.g. when search is filtering the list).
			const row = cb.closest ? cb.closest('label.kusto-filter-value') : null;
			if (row) {
				const inlineDisplay = (row.style && typeof row.style.display === 'string') ? row.style.display : '';
				if (inlineDisplay === 'none') continue;
				try {
					if (window.getComputedStyle && window.getComputedStyle(row).display === 'none') continue;
				} catch { /* ignore */ }
			}
			cb.checked = !!checked;
		}
	} catch { /* ignore */ }
}

function __kustoGetValuesAllowedFromSpec(spec: any) {
	try {
		if (!spec || typeof spec !== 'object') return null;
		if (spec.kind === 'values' && Array.isArray(spec.allowedValues)) return spec.allowedValues;
		if (spec.kind === 'compound' && spec.values && Array.isArray(spec.values.allowedValues)) return spec.values.allowedValues;
		return null;
	} catch {
		return null;
	}
}

function __kustoGetRulesSpecFromExisting(existing: any, dataType: any) {
	try {
		if (!existing || typeof existing !== 'object') return { dataType, rules: [] };
		if (existing.kind === 'compound' && existing.rules && typeof existing.rules === 'object') {
			const dt = String(existing.rules.dataType || dataType || 'string');
			const rules = Array.isArray(existing.rules.rules) ? existing.rules.rules : [];
			return { dataType: dt, rules };
		}
		if (existing.kind === 'rules') {
			const dt = String(existing.dataType || dataType || 'string');
			if (Array.isArray(existing.rules)) {
				return { dataType: dt, rules: existing.rules };
			}
			// Back-compat: single rule format
			if (existing.op) {
				const r: any = { op: String(existing.op || '') };
				if (existing.a !== undefined) r.a = existing.a;
				if (existing.b !== undefined) r.b = existing.b;
				if (existing.n !== undefined) r.n = existing.n;
				if (existing.unit !== undefined) r.unit = existing.unit;
				if (existing.text !== undefined) r.text = existing.text;
				return { dataType: dt, rules: [r] };
			}
		}
		return { dataType, rules: [] };
	} catch {
		return { dataType, rules: [] };
	}
}

function __kustoRenderRulesListHtml(boxId: any, colIdx: any, dataType: any, existing: any) {
	const ruleSpec = __kustoGetRulesSpecFromExisting(existing, dataType);
	const dt = String(ruleSpec.dataType || dataType || 'string');
	const rules = Array.isArray(ruleSpec.rules) ? ruleSpec.rules.slice() : [];
	// Always show a trailing empty row.
	if (rules.length === 0 || (rules[rules.length - 1] && String(rules[rules.length - 1].op || '') !== '')) {
		rules.push({ op: '' });
	}

	const isUniqueOp = (op: any) => {
		const v = String(op || '');
		return v === 'isEmpty' || v === 'isNotEmpty';
	};
	const usedUniqueOps = new Set(
		rules
			.map((r: any) => (r && r.op) ? String(r.op) : '')
			.filter(op => op && isUniqueOp(op))
	);
	let lastRealRuleIdx = -1;
	for (let i = 0; i < rules.length; i++) {
		const op = rules[i] && rules[i].op ? String(rules[i].op) : '';
		if (op) lastRealRuleIdx = i;
	}

	const ops = __kustoGetRuleOpsForType(dt);
	const optionsHtml = (selectedOp: any) => {
		const op = String(selectedOp || '');
		return ['<option value=""' + (!op ? ' selected' : '') + '>Select…</option>']
			.concat(
				ops
					.filter(o => {
						if (!o || !o.v) return false;
						const v = String(o.v);
						if (!isUniqueOp(v)) return true;
						// Keep the currently-selected unique option visible.
						if (op === v) return true;
						// Hide unique options that are already used by another rule.
						return !usedUniqueOps.has(v);
					})
					.map((o: any) => '<option value="' + o.v + '"' + (op === o.v ? ' selected' : '') + '>' + o.t + '</option>')
			)
			.join('');
	};

	return rules.map((r, idx) => {
		const op = r && r.op ? String(r.op) : '';
		const showDel = !!op;
		const showJoin = !!op && idx < lastRealRuleIdx;
		const join = (r && String(r.join || '') === 'or') ? 'or' : 'and';
		const delHtml = showDel
			? ('<button type="button" class="kusto-filter-rule-del" onclick="__kustoDeleteRuleRow(\'' + __kustoEscapeJsStringLiteral(boxId) + '\', ' + String(colIdx) + ', ' + String(idx) + ')" title="Remove rule" aria-label="Remove rule">' + __kustoGetTrashIconSvg(14) + '</button>')
			: '<span class="kusto-filter-rule-del-spacer"></span>';
		const joinHtml = showJoin
			? (
				'<div class="kusto-filter-rule-join" aria-label="Join rule" role="group">' +
				'<button type="button" class="kusto-filter-rule-join-btn and' + (join === 'and' ? ' active' : '') + '" onclick="__kustoSetRuleJoin(\'' + __kustoEscapeJsStringLiteral(boxId) + '\', ' + String(colIdx) + ', ' + String(idx) + ', \'and\')">And</button>' +
				'<button type="button" class="kusto-filter-rule-join-btn or' + (join === 'or' ? ' active' : '') + '" onclick="__kustoSetRuleJoin(\'' + __kustoEscapeJsStringLiteral(boxId) + '\', ' + String(colIdx) + ', ' + String(idx) + ', \'or\')">Or</button>' +
				'</div>'
			)
			: '<span class="kusto-filter-rule-join-spacer"></span>';

		const inputsHtml = __kustoRenderRuleRowInputsHtml(boxId, dt, r);
		return (
			'<div class="kusto-filter-rule-row" data-rule-idx="' + String(idx) + '" data-join="' + join + '">' +
			delHtml +
			'<select class="kusto-filter-rule-op" onchange="__kustoOnRuleRowOpChanged(\'' + __kustoEscapeJsStringLiteral(boxId) + '\', ' + String(colIdx) + ', ' + String(idx) + ')">' +
			optionsHtml(op) +
			'</select>' +
			inputsHtml +
			joinHtml +
			'</div>'
		);
	}).join('');
}

function __kustoGetRuleOpsForType(dataType: any) {
	const base = [
		{ v: 'isEmpty', t: 'Null or empty' },
		{ v: 'isNotEmpty', t: 'Not null or empty' }
	];
	if (dataType === 'date') {
		return base.concat([
			{ v: 'before', t: 'Before' },
			{ v: 'after', t: 'After' },
			{ v: 'between', t: 'Between' },
			{ v: 'last', t: 'Last…' }
		]);
	}
	if (dataType === 'number') {
		return base.concat([
			{ v: 'lt', t: 'Less than' },
			{ v: 'gt', t: 'Greater than' },
			{ v: 'between', t: 'Between' },
			{ v: 'top', t: 'Top…' },
			{ v: 'bottom', t: 'Last…' }
		]);
	}
	if (dataType === 'json') {
		return base.concat([
			{ v: 'contains', t: 'Contains' },
			{ v: 'notContains', t: 'Does not contain' }
		]);
	}
	return base.concat([
		{ v: 'startsWith', t: 'Starts with' },
		{ v: 'notStartsWith', t: 'Does not start with' },
		{ v: 'endsWith', t: 'Ends with' },
		{ v: 'notEndsWith', t: 'Does not end with' },
		{ v: 'contains', t: 'Contains' },
		{ v: 'notContains', t: 'Does not contain' }
	]);
}

function __kustoRenderRuleRowInputsHtml(boxId: any, dataType: any, rule: any) {
	const op = rule && rule.op ? String(rule.op) : '';
	if (op === 'isEmpty' || op === 'isNotEmpty' || !op) {
		return '<span class="kusto-filter-rule-inputs"></span>';
	}
	if (dataType === 'date') {
		const a = rule && rule.a ? String(rule.a) : '';
		const b = rule && rule.b ? String(rule.b) : '';
		const n = rule && rule.n ? String(rule.n) : '7';
		const unit = rule && rule.unit ? String(rule.unit) : 'days';
		return (
			'<span class="kusto-filter-rule-inputs">' +
			'<input type="datetime-local" class="kusto-filter-rule-a" value="' + __kustoEscapeForHtmlAttribute(__kustoToDateTimeLocalValue(a)) + '" ' + ((op === 'before' || op === 'after' || op === 'between') ? '' : 'style="display:none"') + ' />' +
			'<input type="datetime-local" class="kusto-filter-rule-b" value="' + __kustoEscapeForHtmlAttribute(__kustoToDateTimeLocalValue(b)) + '" ' + (op === 'between' ? '' : 'style="display:none"') + ' />' +
			'<span class="kusto-filter-rule-last" ' + (op === 'last' ? '' : 'style="display:none"') + '>' +
			'<input type="number" min="1" class="kusto-filter-rule-n" value="' + __kustoEscapeForHtmlAttribute(n) + '" />' +
			'<select class="kusto-filter-rule-unit">' +
			['minutes','hours','days','weeks','months','years'].map(u => '<option value="' + u + '"' + (unit === u ? ' selected' : '') + '>' + u + '</option>').join('') +
			'</select>' +
			'</span>' +
			'</span>'
		);
	}
	if (dataType === 'number') {
		const a = rule && rule.a !== undefined ? String(rule.a) : '';
		const b = rule && rule.b !== undefined ? String(rule.b) : '';
		const n = rule && rule.n ? String(rule.n) : '10';
		return (
			'<span class="kusto-filter-rule-inputs">' +
			'<input type="number" class="kusto-filter-rule-a" value="' + __kustoEscapeForHtmlAttribute(a) + '" ' + ((op === 'lt' || op === 'gt' || op === 'between') ? '' : 'style="display:none"') + ' />' +
			'<input type="number" class="kusto-filter-rule-b" value="' + __kustoEscapeForHtmlAttribute(b) + '" ' + (op === 'between' ? '' : 'style="display:none"') + ' />' +
			'<input type="number" min="1" class="kusto-filter-rule-n" value="' + __kustoEscapeForHtmlAttribute(n) + '" ' + ((op === 'top' || op === 'bottom') ? '' : 'style="display:none"') + ' />' +
			'</span>'
		);
	}
	const text = rule && rule.text ? String(rule.text) : '';
	return '<span class="kusto-filter-rule-inputs"><input type="text" class="kusto-filter-rule-text" value="' + __kustoEscapeForHtmlAttribute(text) + '" placeholder="Value…" /></span>';
}

function __kustoCaptureRulesFromDom(boxId: any) {
	try {
		const list = document.getElementById(boxId + '_filter_rules_list');
		if (!list) return [];
		const rows = Array.from(list.querySelectorAll('.kusto-filter-rule-row')) as any[];
		return rows.map((row: any) => {
			const join = String((row && row.getAttribute && row.getAttribute('data-join')) || 'and');
			const op = String(((row.querySelector('.kusto-filter-rule-op') || {}).value) || '');
			const a = (row.querySelector('.kusto-filter-rule-a') || {}).value;
			const b = (row.querySelector('.kusto-filter-rule-b') || {}).value;
			const n = (row.querySelector('.kusto-filter-rule-n') || {}).value;
			const unit = (row.querySelector('.kusto-filter-rule-unit') || {}).value;
			const text = (row.querySelector('.kusto-filter-rule-text') || {}).value;
			return { op, a, b, n, unit, text, join: (join === 'or') ? 'or' : 'and' };
		});
	} catch {
		return [];
	}
}

function __kustoSetRuleJoin(boxId: any, colIdx: any, ruleIdx: any, joinOp: any) {
	try {
		const colIndex = parseInt(String(colIdx), 10);
		const idx = parseInt(String(ruleIdx), 10);
		if (!isFinite(colIndex) || colIndex < 0) return;
		if (!isFinite(idx) || idx < 0) return;
		const list = document.getElementById(boxId + '_filter_rules_list');
		if (!list) return;
		const row = list.querySelector('.kusto-filter-rule-row[data-rule-idx="' + String(idx) + '"]');
		if (!row) return;
		const op = (String(joinOp) === 'or') ? 'or' : 'and';
		row.setAttribute('data-join', op);
		const andBtn = row.querySelector('.kusto-filter-rule-join-btn.and') as any;
		const orBtn = row.querySelector('.kusto-filter-rule-join-btn.or') as any;
		if (andBtn) andBtn.classList.toggle('active', op === 'and');
		if (orBtn) orBtn.classList.toggle('active', op === 'or');
		try {
			if ((_win.__kustoActiveFilterPopover as any)) {
				(_win.__kustoActiveFilterPopover as any).draftRules = __kustoCaptureRulesFromDom(boxId);
			}
		} catch { /* ignore */ }
	} catch { /* ignore */ }
}

function __kustoOnRuleRowOpChanged(boxId: any, colIdx: any, ruleIdx: any) {
	try {
		const state = __kustoGetResultsState(boxId);
		if (!state) return;
		const colIndex = parseInt(String(colIdx), 10);
		const idx = parseInt(String(ruleIdx), 10);
		if (!isFinite(colIndex) || colIndex < 0) return;
		if (!isFinite(idx) || idx < 0) return;
		const base = __kustoGetRowIndicesExcludingColumnFilter(state, colIndex);
		const inferredType = __kustoInferColumnType(state, colIndex, base);
		const existing = (__kustoEnsureColumnFiltersMap(state) || {})[String(colIndex)] || null;
		const currentRules = __kustoCaptureRulesFromDom(boxId);
		// Ensure trailing empty row.
		if (currentRules.length === 0 || String((currentRules[currentRules.length - 1] || {}).op || '') !== '') {
			currentRules.push({ op: '' } as any);
		}
		const listEl = document.getElementById(boxId + '_filter_rules_list');
		if (!listEl) return;
		listEl.innerHTML = __kustoRenderRulesListHtml(boxId, colIndex, inferredType, { kind: 'rules', dataType: inferredType, rules: currentRules });
	} catch {
		// ignore
	}
}

function __kustoDeleteRuleRow(boxId: any, colIdx: any, ruleIdx: any) {
	try {
		const state = __kustoGetResultsState(boxId);
		if (!state) return;
		const colIndex = parseInt(String(colIdx), 10);
		const idx = parseInt(String(ruleIdx), 10);
		if (!isFinite(colIndex) || colIndex < 0) return;
		if (!isFinite(idx) || idx < 0) return;
		const base = __kustoGetRowIndicesExcludingColumnFilter(state, colIndex);
		const inferredType = __kustoInferColumnType(state, colIndex, base);
		const rules = __kustoCaptureRulesFromDom(boxId);
		if (idx >= 0 && idx < rules.length) {
			rules.splice(idx, 1);
		}
		// Ensure trailing empty row.
		if (rules.length === 0 || String((rules[rules.length - 1] || {}).op || '') !== '') {
			rules.push({ op: '' } as any);
		}
		const listEl = document.getElementById(boxId + '_filter_rules_list');
		if (!listEl) return;
		listEl.innerHTML = __kustoRenderRulesListHtml(boxId, colIndex, inferredType, { kind: 'rules', dataType: inferredType, rules });
	} catch {
		// ignore
	}
}

function __kustoRenderRulesEditorHtml(boxId: any, colIdx: any, dataType: any, existing: any) {
	const spec = (existing && existing.kind === 'rules') ? existing : null;
	const op = spec ? String(spec.op || '') : '';
	let ops = [
		{ v: 'isEmpty', t: 'Null or empty' },
		{ v: 'isNotEmpty', t: 'Not null or empty' }
	];
	if (dataType === 'date') {
		ops = ops.concat([
			{ v: 'before', t: 'Before' },
			{ v: 'after', t: 'After' },
			{ v: 'between', t: 'Between' },
			{ v: 'last', t: 'Last…' }
		]);
	} else if (dataType === 'number') {
		ops = ops.concat([
			{ v: 'lt', t: 'Less than' },
			{ v: 'gt', t: 'Greater than' },
			{ v: 'between', t: 'Between' },
			{ v: 'top', t: 'Top…' },
			{ v: 'bottom', t: 'Last…' }
		]);
	} else if (dataType === 'json') {
		ops = ops.concat([
			{ v: 'contains', t: 'Contains' },
			{ v: 'notContains', t: 'Does not contain' }
		]);
	} else {
		ops = ops.concat([
			{ v: 'startsWith', t: 'Starts with' },
			{ v: 'notStartsWith', t: 'Does not start with' },
			{ v: 'endsWith', t: 'Ends with' },
			{ v: 'notEndsWith', t: 'Does not end with' },
			{ v: 'contains', t: 'Contains' },
			{ v: 'notContains', t: 'Does not contain' }
		]);
	}
	const options = ['<option value=""' + (!op ? ' selected' : '') + '>Select…</option>']
		.concat(ops.map((o: any) => '<option value="' + o.v + '"' + (op === o.v ? ' selected' : '') + '>' + o.t + '</option>'))
		.join('');

	let inputs = '';
	if (dataType === 'date') {
		const a = spec && spec.a ? String(spec.a) : '';
		const b = spec && spec.b ? String(spec.b) : '';
		const n = spec && spec.n ? String(spec.n) : '7';
		const unit = spec && spec.unit ? String(spec.unit) : 'days';
		inputs += (
			'<div class="kusto-filter-rule-inputs">' +
			'<input type="datetime-local" id="' + boxId + '_filter_a" value="' + __kustoEscapeForHtmlAttribute(__kustoToDateTimeLocalValue(a)) + '" ' + (op === 'before' || op === 'after' || op === 'between' ? '' : 'style="display:none"') + ' />' +
			'<input type="datetime-local" id="' + boxId + '_filter_b" value="' + __kustoEscapeForHtmlAttribute(__kustoToDateTimeLocalValue(b)) + '" ' + (op === 'between' ? '' : 'style="display:none"') + ' />' +
			'<div class="kusto-filter-last" ' + (op === 'last' ? '' : 'style="display:none"') + '>' +
			'<input type="number" min="1" id="' + boxId + '_filter_n" value="' + __kustoEscapeForHtmlAttribute(n) + '" />' +
			'<select id="' + boxId + '_filter_unit">' +
			['minutes','hours','days','weeks','months','years'].map(u => '<option value="' + u + '"' + (unit === u ? ' selected' : '') + '>' + u + '</option>').join('') +
			'</select>' +
			'</div>' +
			'</div>'
		);
	} else if (dataType === 'number') {
		const a = spec && spec.a !== undefined ? String(spec.a) : '';
		const b = spec && spec.b !== undefined ? String(spec.b) : '';
		const n = spec && spec.n ? String(spec.n) : '10';
		inputs += (
			'<div class="kusto-filter-rule-inputs">' +
			'<input type="number" id="' + boxId + '_filter_a" value="' + __kustoEscapeForHtmlAttribute(a) + '" ' + ((op === 'lt' || op === 'gt' || op === 'between') ? '' : 'style="display:none"') + ' />' +
			'<input type="number" id="' + boxId + '_filter_b" value="' + __kustoEscapeForHtmlAttribute(b) + '" ' + (op === 'between' ? '' : 'style="display:none"') + ' />' +
			'<input type="number" min="1" id="' + boxId + '_filter_n" value="' + __kustoEscapeForHtmlAttribute(n) + '" ' + ((op === 'top' || op === 'bottom') ? '' : 'style="display:none"') + ' />' +
			'</div>'
		);
	} else {
		const text = spec && spec.text ? String(spec.text) : '';
		inputs += '<div class="kusto-filter-rule-inputs"><input type="text" id="' + boxId + '_filter_text" value="' + __kustoEscapeForHtmlAttribute(text) + '" placeholder="Value…" /></div>';
	}

	return (
		'<div class="kusto-filter-rule">' +
		'<select id="' + boxId + '_filter_op" onchange="__kustoOnFilterOpChanged(\'' + __kustoEscapeJsStringLiteral(boxId) + '\', ' + String(colIdx) + ')">' +
		options +
		'</select>' +
		inputs +
		'</div>'
	);
}

function __kustoToDateTimeLocalValue(isoOrRaw: any) {
	try {
		const ms = __kustoTryParseDateMs(isoOrRaw);
		if (ms === null) return '';
		const d = new Date(ms);
		const pad = (n: any) => String(n).padStart(2, '0');
		return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
	} catch {
		return '';
	}
}

function __kustoFromDateTimeLocalValue(v: any) {
	try {
		const s = String(v || '').trim();
		if (!s) return '';
		const t = Date.parse(s);
		if (!isFinite(t)) return '';
		return new Date(t).toISOString();
	} catch {
		return '';
	}
}

function __kustoSetFilterMode(boxId: any, colIdx: any, mode: any) {
	if (!(_win.__kustoActiveFilterPopover as any)) return;
	// Capture unsaved UI state when switching modes.
	try {
		const current = String((_win.__kustoActiveFilterPopover as any).mode || 'values');
		if (current === 'values') {
			const list = document.getElementById(boxId + '_filter_values_list');
			if (list) {
				const allowed = [];
				const cbs = Array.from(list.querySelectorAll('input.kusto-filter-value-cb')) as any[];
				for (const cb of cbs) {
					if (cb && cb.checked) allowed.push(String(cb.value || ''));
				}
				(_win.__kustoActiveFilterPopover as any).draftValuesAllowed = allowed;
			}
		} else {
			(_win.__kustoActiveFilterPopover as any).draftRules = __kustoCaptureRulesFromDom(boxId);
			(_win.__kustoActiveFilterPopover as any).draftCombine = __kustoGetRulesCombineEnabledFromDom(boxId);
		}
	} catch { /* ignore */ }

	(_win.__kustoActiveFilterPopover as any).mode = (String(mode) === 'rules') ? 'rules' : 'values';
	const dialogId = (_win.__kustoActiveFilterPopover as any).dialogId || (_win.__kustoActiveFilterPopover as any).elId;
	const el = dialogId ? document.getElementById(dialogId) : null;
	if (!el) return;
	// Re-infer type against the current context.
	try {
		const state = __kustoGetResultsState(boxId);
		if (state) {
			const base = __kustoGetRowIndicesExcludingColumnFilter(state, colIdx);
			(_win.__kustoActiveFilterPopover as any).dataType = __kustoInferColumnType(state, colIdx, base);
		}
	} catch { /* ignore */ }
	el.innerHTML = __kustoRenderFilterPopoverHtml(boxId, colIdx);
}

function __kustoOnFilterOpChanged(boxId: any, colIdx: any) {
	try {
		const pop = (_win.__kustoActiveFilterPopover as any);
		if (!pop) return;
		const state = __kustoGetResultsState(boxId);
		if (!state) return;
		const baseRowIndices = __kustoGetRowIndicesExcludingColumnFilter(state, colIdx);
		pop.dataType = __kustoInferColumnType(state, colIdx, baseRowIndices);

		const op = String((document.getElementById(boxId + '_filter_op') as any || {}).value || '');
		const a = document.getElementById(boxId + '_filter_a');
		const b = document.getElementById(boxId + '_filter_b');
		const n = document.getElementById(boxId + '_filter_n');
		const last = document.querySelector('#' + (pop.elId || '') + ' .kusto-filter-last');

		if (op === 'isEmpty' || op === 'isNotEmpty') {
			if (a) a.style.display = 'none';
			if (b) b.style.display = 'none';
			if (n) n.style.display = 'none';
			if (last) (last as any).style.display = 'none';
			return;
		}

		if (pop.dataType === 'date') {
			if (a) a.style.display = (op === 'before' || op === 'after' || op === 'between') ? '' : 'none';
			if (b) b.style.display = (op === 'between') ? '' : 'none';
			if (last) (last as any).style.display = (op === 'last') ? '' : 'none';
			return;
		}
		if (pop.dataType === 'number') {
			if (a) a.style.display = (op === 'lt' || op === 'gt' || op === 'between') ? '' : 'none';
			if (b) b.style.display = (op === 'between') ? '' : 'none';
			if (n) n.style.display = (op === 'top' || op === 'bottom') ? '' : 'none';
			return;
		}
	} catch {
		// ignore
	}
}

function __kustoFilterToggleAllValues(boxId: any, colIdx: any) {
	try {
		const list = document.getElementById(boxId + '_filter_values_list');
		const all = document.getElementById(boxId + '_filter_all');
		if (!list || !all) return;
		const cbs = Array.from(list.querySelectorAll('input.kusto-filter-value-cb')) as any[];
		for (const cb of cbs) {
			(cb as any).checked = !!(all as any).checked;
		}
	} catch { /* ignore */ }
}

function applyColumnFilter(boxId: any, colIdx: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const colIndex = parseInt(String(colIdx), 10);
	if (!isFinite(colIndex) || colIndex < 0) return;
	const filters = __kustoEnsureColumnFiltersMap(state);
	const existing = filters[String(colIndex)] || null;
	const pop = (_win.__kustoActiveFilterPopover as any);
	const mode = pop && pop.mode ? String(pop.mode) : 'values';
	const baseRowIndices = __kustoGetRowIndicesExcludingColumnFilter(state, colIndex);
	const inferredType = __kustoInferColumnType(state, colIndex, baseRowIndices);

	let draft = null;
	if (mode === 'values') {
		const list = document.getElementById(boxId + '_filter_values_list');
		const allowed = [];
		if (list) {
			const cbs = Array.from(list.querySelectorAll('input.kusto-filter-value-cb')) as any[];
			for (const cb of cbs) {
				if (cb && cb.checked) {
					allowed.push(String(cb.value || ''));
				}
			}
		}
		if (existing && existing.kind === 'compound' && existing.rules) {
			draft = { kind: 'compound', values: { kind: 'values', allowedValues: allowed }, rules: existing.rules };
		} else {
			draft = { kind: 'values', allowedValues: allowed };
		}
	} else {
		const combine = __kustoGetRulesCombineEnabledFromDom(boxId);
		let rules: any[] = __kustoCaptureRulesFromDom(boxId);
		rules = Array.isArray(rules) ? rules : [];
		// Drop trailing empty rules.
		rules = rules.filter((r: any) => r && typeof r === 'object' && String(r.op || ''));
		// Normalize rule field shapes based on inferred type.
		rules = rules.map((r: any) => {
			const op = String(r.op || '');
			const join = (r && String(r.join || '') === 'or') ? 'or' : 'and';
			if (inferredType === 'date') {
				return {
					op,
					join,
					a: __kustoFromDateTimeLocalValue(String(r.a || '')),
					b: __kustoFromDateTimeLocalValue(String(r.b || '')),
					n: String(r.n || ''),
					unit: String(r.unit || 'days')
				};
			}
			if (inferredType === 'number') {
				return { op, join, a: String(r.a || ''), b: String(r.b || ''), n: String(r.n || '') };
			}
			if (inferredType === 'json') {
				return { op, join, text: String(r.text || '') };
			}
			return { op, join, text: String(r.text || '') };
		});
		const rulesSpec = { kind: 'rules', dataType: inferredType, rules };
		if (combine) {
			const allowed = __kustoGetValuesAllowedFromSpec(existing)
				|| (pop && Array.isArray(pop.draftValuesAllowed) ? pop.draftValuesAllowed : null);
			if (Array.isArray(allowed) && allowed.length > 0) {
				draft = { kind: 'compound', values: { kind: 'values', allowedValues: allowed }, rules: rulesSpec };
			} else {
				draft = rulesSpec;
			}
		} else {
			draft = rulesSpec;
		}
	}

	const normalized = __kustoNormalizeDraftFilter(state, colIndex, draft);
	if (!normalized) {
		delete filters[String(colIndex)];
	} else {
		filters[String(colIndex)] = normalized;
	}
	__kustoApplyFiltersAndRerender(boxId);
	closeColumnFilterPopover();
}

function clearColumnFilter(boxId: any, colIdx: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const colIndex = parseInt(String(colIdx), 10);
	if (!isFinite(colIndex) || colIndex < 0) return;
	const filters = __kustoEnsureColumnFiltersMap(state);
	delete filters[String(colIndex)];
	__kustoApplyFiltersAndRerender(boxId);
	closeColumnFilterPopover();
}

function __kustoSetSortSpecAndRerender(boxId: any, nextSpec: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	state.sortSpec = __kustoNormalizeSortSpec(nextSpec, (state.columns || []).length);
	__kustoEnsureDisplayRowIndexMaps(state);
	try {
		const v = __kustoGetVirtualizationState(state);
		if (v) {
			v.lastStart = -1;
			v.lastEnd = -1;
			v.lastDisplayVersion = -1;
		}
	} catch { /* ignore */ }
	__kustoRerenderResultsTable(boxId);
	try { (_win.schedulePersist as any) && (_win.schedulePersist as any)(); } catch { /* ignore */ }
}

function __kustoGetSortRuleIndex(state: any, colIndex: any) {
	if (!state || !Array.isArray(state.sortSpec)) return -1;
	for (let i = 0; i < state.sortSpec.length; i++) {
		if (state.sortSpec[i] && state.sortSpec[i].colIndex === colIndex) return i;
	}
	return -1;
}

function handleHeaderSortClick(event: any, colIndex: any, boxId: any) {
	try { __kustoEnsureResultsShownForTool(boxId); } catch { /* ignore */ }
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const isMulti = !!(event && (event.shiftKey || event.ctrlKey || event.metaKey));
	const spec = Array.isArray(state.sortSpec) ? state.sortSpec.slice() : [];
	const idx = __kustoGetSortRuleIndex(state, colIndex);

	if (!isMulti) {
		// Single-column sort.
		if (idx === 0 && spec.length === 1) {
			spec[0] = { colIndex: colIndex, dir: (spec[0].dir === 'asc') ? 'desc' : 'asc' };
		} else {
			spec.length = 0;
			spec.push({ colIndex: colIndex, dir: 'asc' });
		}
		__kustoSetSortSpecAndRerender(boxId, spec);
		return;
	}

	// Multi-sort: add/toggle while preserving order.
	if (idx >= 0) {
		spec[idx] = { colIndex: colIndex, dir: (spec[idx].dir === 'asc') ? 'desc' : 'asc' };
	} else {
		spec.push({ colIndex: colIndex, dir: 'asc' });
	}
	__kustoSetSortSpecAndRerender(boxId, spec);
}

function sortColumnAscending(colIndex: any, boxId: any) {
	__kustoSetSortSpecAndRerender(boxId, [{ colIndex: colIndex, dir: 'asc' }]);
}

function sortColumnDescending(colIndex: any, boxId: any) {
	__kustoSetSortSpecAndRerender(boxId, [{ colIndex: colIndex, dir: 'desc' }]);
}

function toggleSortDialog(boxId: any) {
	try { __kustoEnsureResultsShownForTool(boxId); } catch { /* ignore */ }
	const modal = document.getElementById(boxId + '_sort_modal');
	if (!modal) return;
	const btn = document.getElementById(boxId + '_results_sort_btn');
	const willOpen = !modal.classList.contains('visible');
	if (willOpen) {
		modal.classList.add('visible');
		try { if (btn) btn.classList.add('active'); } catch { /* ignore */ }
		__kustoRenderSortDialog(boxId);
	} else {
		modal.classList.remove('visible');
		try { if (btn) btn.classList.remove('active'); } catch { /* ignore */ }
	}
}

function closeSortDialog(boxId: any) {
	const modal = document.getElementById(boxId + '_sort_modal');
	if (!modal) return;
	modal.classList.remove('visible');
	try {
		const btn = document.getElementById(boxId + '_results_sort_btn');
		if (btn) btn.classList.remove('active');
	} catch { /* ignore */ }
}

function closeSortDialogOnBackdrop(event: any, boxId: any) {
	// Only close if the click hit the backdrop.
	if (event && event.target && event.currentTarget && event.target === event.currentTarget) {
		closeSortDialog(boxId);
	}
}

function __kustoRenderSortDialog(boxId: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const listEl = document.getElementById(boxId + '_sort_list');
	if (!listEl) return;
	const spec = Array.isArray(state.sortSpec) ? state.sortSpec : [];
	const cols = Array.isArray(state.columns) ? state.columns : [];

	const emptyHint = (spec.length === 0)
		? '<div class="kusto-sort-empty">No sort applied.</div>'
		: '';

	const rulesHtml = spec.map((rule: any, idx: any) => {
		const colIndex = rule.colIndex;
		const dir = __kustoNormalizeSortDirection(rule.dir);
		const options = cols.map((c: any, i: any) => {
			const selected = (i === colIndex) ? ' selected' : '';
			return '<option value="' + String(i) + '"' + selected + '>' + __kustoEscapeForHtml(String(c ?? '')) + '</option>';
		}).join('');
		return (
			'<div class="kusto-sort-row" data-sort-idx="' + String(idx) + '">' +
			'<button type="button" class="kusto-sort-grab" title="Drag to reorder" aria-label="Drag to reorder">⋮⋮</button>' +
			'<button type="button" class="kusto-sort-remove" onclick="removeSortRule(' + String(idx) + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\')" title="Remove" aria-label="Remove" tabindex="0">' + __kustoGetTrashIconSvg(14) + '</button>' +
			'<div class="kusto-sort-order" aria-hidden="true">' + String(idx + 1) + '</div>' +
			'<select class="kusto-sort-col" aria-label="Sort column" onchange="updateSortRuleColumn(' + String(idx) + ', this.value, \'' + __kustoEscapeJsStringLiteral(boxId) + '\')">' +
			options +
			'</select>' +
			'<select class="kusto-sort-dir" aria-label="Sort direction" onchange="updateSortRuleDirection(' + String(idx) + ', this.value, \'' + __kustoEscapeJsStringLiteral(boxId) + '\')">' +
			'<option value="none">None</option>' +
			'<option value="asc"' + (dir === 'asc' ? ' selected' : '') + '>Ascending</option>' +
			'<option value="desc"' + (dir === 'desc' ? ' selected' : '') + '>Descending</option>' +
			'</select>' +
			'</div>'
		);
	}).join('');

	const addOptions = cols.map((c: any, i: any) => {
		return '<option value="' + String(i) + '">' + __kustoEscapeForHtml(String(c ?? '')) + '</option>';
	}).join('');

	const addRow = (
		'<div class="kusto-sort-add-row">' +
		'<div class="kusto-sort-add-label">Add sort</div>' +
		'<select class="kusto-sort-col" id="' + boxId + '_sort_add_col" aria-label="Add sort column">' +
		'<option value="" selected>Select a column…</option>' +
		addOptions +
		'</select>' +
		'<select class="kusto-sort-dir" id="' + boxId + '_sort_add_dir" aria-label="Add sort direction">' +
		'<option value="asc" selected>Ascending</option>' +
		'<option value="desc">Descending</option>' +
		'</select>' +
		'<button type="button" class="kusto-sort-add-btn" onclick="__kustoAddSortRuleInline(\'' + __kustoEscapeJsStringLiteral(boxId) + '\')" title="Add" aria-label="Add">+</button>' +
		'</div>'
	);

	listEl.innerHTML = emptyHint + rulesHtml + addRow;
	try { __kustoWireSortDialogDnD(boxId); } catch { /* ignore */ }
}

function __kustoAddSortRuleInline(boxId: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const colSel = document.getElementById(boxId + '_sort_add_col');
	const dirSel = document.getElementById(boxId + '_sort_add_dir');
	if (!colSel || !dirSel) return;
	const colIndex = parseInt(String((colSel as any).value), 10);
	if (!isFinite(colIndex) || colIndex < 0) return;
	const dir = (String((dirSel as any).value) === 'desc') ? 'desc' : 'asc';
	const spec = Array.isArray(state.sortSpec) ? state.sortSpec.slice() : [];
	// Remove any existing rule for the column.
	for (let i = spec.length - 1; i >= 0; i--) {
		if (spec[i] && spec[i].colIndex === colIndex) {
			spec.splice(i, 1);
		}
	}
	spec.push({ colIndex: colIndex, dir: dir });
	__kustoSetSortSpecAndRerender(boxId, spec);
	__kustoRenderSortDialog(boxId);
}

function __kustoWireSortDialogDnD(boxId: any) {
	const listEl = document.getElementById(boxId + '_sort_list');
	if (!listEl) return;
	const rows = Array.from(listEl.querySelectorAll('.kusto-sort-row[data-sort-idx]')) as any[];
	if (rows.length === 0) return;

	// Keep drag state on window to survive re-renders.
	if (!(_win.__kustoSortDnD as any)) {
		(_win.__kustoSortDnD as any) = { boxId: null, fromIdx: -1, dragEnabled: false };
	}

	for (const row of rows) {
		(row as any).draggable = true;
		row.addEventListener('dragstart', (e: any) => {
			const idx = parseInt(String(row.getAttribute('data-sort-idx')), 10);
			if (!isFinite(idx)) return;
			const handle = e && e.target && (e.target as HTMLElement).closest ? (e.target as HTMLElement).closest('.kusto-sort-grab') : null;
			if (!handle) {
				// Only allow drag when starting from the grab handle.
				try { e.preventDefault(); } catch { /* ignore */ }
				return;
			}
			(_win.__kustoSortDnD as any).boxId = boxId;
			(_win.__kustoSortDnD as any).fromIdx = idx;
			row.classList.add('kusto-sort-dragging');
			try {
				(e as any).dataTransfer.effectAllowed = 'move';
				// Some browsers require data to be set.
				(e as any).dataTransfer.setData('text/plain', String(idx));
			} catch { /* ignore */ }
		});

		row.addEventListener('dragend', () => {
			row.classList.remove('kusto-sort-dragging');
			for (const r of rows) r.classList.remove('kusto-sort-drop');
		});

		row.addEventListener('dragover', (e: any) => {
			try { e.preventDefault(); } catch { /* ignore */ }
			for (const r of rows) r.classList.remove('kusto-sort-drop');
			row.classList.add('kusto-sort-drop');
			try { (e as any).dataTransfer.dropEffect = 'move'; } catch { /* ignore */ }
		});

		row.addEventListener('drop', (e: any) => {
			try { e.preventDefault(); } catch { /* ignore */ }
			const fromIdx = (_win.__kustoSortDnD as any) ? (_win.__kustoSortDnD as any).fromIdx : -1;
			const toIdx = parseInt(String(row.getAttribute('data-sort-idx')), 10);
			if (!isFinite(fromIdx) || !isFinite(toIdx) || fromIdx === toIdx) return;
			__kustoMoveSortRule(boxId, fromIdx, toIdx);
		});
	}
}

function __kustoMoveSortRule(boxId: any, fromIdx: any, toIdx: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const spec = Array.isArray(state.sortSpec) ? state.sortSpec.slice() : [];
	const f = parseInt(String(fromIdx), 10);
	const t = parseInt(String(toIdx), 10);
	if (!isFinite(f) || !isFinite(t) || f < 0 || t < 0 || f >= spec.length || t >= spec.length) return;
	const item = spec.splice(f, 1)[0];
	spec.splice(t, 0, item);
	__kustoSetSortSpecAndRerender(boxId, spec);
	__kustoRenderSortDialog(boxId);
}

function addSortRule(boxId: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const cols = Array.isArray(state.columns) ? state.columns : [];
	if (cols.length === 0) return;
	const spec = Array.isArray(state.sortSpec) ? state.sortSpec.slice() : [];
	// Pick first unused column, else first.
	let colIndex = 0;
	const used = new Set(spec.map((r: any) => r && r.colIndex));
	for (let i = 0; i < cols.length; i++) {
		if (!used.has(i)) { colIndex = i; break; }
	}
	spec.push({ colIndex: colIndex, dir: 'asc' });
	__kustoSetSortSpecAndRerender(boxId, spec);
	__kustoRenderSortDialog(boxId);
}

function clearSort(boxId: any) {
	__kustoSetSortSpecAndRerender(boxId, []);
	__kustoRenderSortDialog(boxId);
}

function updateSortRuleColumn(ruleIndex: any, value: any, boxId: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const idx = parseInt(String(ruleIndex), 10);
	const colIndex = parseInt(String(value), 10);
	const spec = Array.isArray(state.sortSpec) ? state.sortSpec.slice() : [];
	if (!isFinite(idx) || idx < 0 || idx >= spec.length) return;
	if (!isFinite(colIndex)) return;
	// Prevent duplicates by removing any existing rule for the chosen column.
	for (let i = spec.length - 1; i >= 0; i--) {
		if (i !== idx && spec[i] && spec[i].colIndex === colIndex) {
			spec.splice(i, 1);
			if (i < idx) {
				// We removed an earlier item; the target index shifted.
				return updateSortRuleColumn(idx - 1, value, boxId);
			}
		}
	}
	const dir = spec[idx] ? spec[idx].dir : 'asc';
	spec[idx] = { colIndex: colIndex, dir: __kustoNormalizeSortDirection(dir) };
	__kustoSetSortSpecAndRerender(boxId, spec);
	__kustoRenderSortDialog(boxId);
}

function updateSortRuleDirection(ruleIndex: any, value: any, boxId: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const idx = parseInt(String(ruleIndex), 10);
	const spec = Array.isArray(state.sortSpec) ? state.sortSpec.slice() : [];
	if (!isFinite(idx) || idx < 0 || idx >= spec.length) return;
	if (String(value) === 'none') {
		spec.splice(idx, 1);
		__kustoSetSortSpecAndRerender(boxId, spec);
		__kustoRenderSortDialog(boxId);
		return;
	}
	const colIndex = spec[idx] ? spec[idx].colIndex : 0;
	spec[idx] = { colIndex: colIndex, dir: __kustoNormalizeSortDirection(value) };
	__kustoSetSortSpecAndRerender(boxId, spec);
	__kustoRenderSortDialog(boxId);
}

function moveSortRuleUp(ruleIndex: any, boxId: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const idx = parseInt(String(ruleIndex), 10);
	const spec = Array.isArray(state.sortSpec) ? state.sortSpec.slice() : [];
	if (!isFinite(idx) || idx <= 0 || idx >= spec.length) return;
	const tmp = spec[idx - 1];
	spec[idx - 1] = spec[idx];
	spec[idx] = tmp;
	__kustoSetSortSpecAndRerender(boxId, spec);
	__kustoRenderSortDialog(boxId);
}

function moveSortRuleDown(ruleIndex: any, boxId: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const idx = parseInt(String(ruleIndex), 10);
	const spec = Array.isArray(state.sortSpec) ? state.sortSpec.slice() : [];
	if (!isFinite(idx) || idx < 0 || idx >= (spec.length - 1)) return;
	const tmp = spec[idx + 1];
	spec[idx + 1] = spec[idx];
	spec[idx] = tmp;
	__kustoSetSortSpecAndRerender(boxId, spec);
	__kustoRenderSortDialog(boxId);
}

function removeSortRule(ruleIndex: any, boxId: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const idx = parseInt(String(ruleIndex), 10);
	const spec = Array.isArray(state.sortSpec) ? state.sortSpec.slice() : [];
	if (!isFinite(idx) || idx < 0 || idx >= spec.length) return;
	spec.splice(idx, 1);
	__kustoSetSortSpecAndRerender(boxId, spec);
	__kustoRenderSortDialog(boxId);
}

function __kustoRerenderResultsTable(boxId: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const table = document.getElementById(boxId + '_table');
	if (!table) return;

	try { __kustoRerenderResultsTableBody(boxId, undefined); } catch { /* ignore */ }
	return;
}

function __kustoGetVirtualizationState(state: any) {
	if (!state || typeof state !== 'object') return null;
	if (!state.__kustoVirtual) {
		state.__kustoVirtual = {
			enabled: false,
			rowHeight: 22,
			overScan: 5,
			lastStart: -1,
			lastEnd: -1,
			lastDisplayVersion: -1,
			lastVisualVersion: -1,
			rafPending: false,
			resizeObserver: null,
			scrollEl: null,
			scrollHandler: null,
			observedEls: [],
			theadHeight: 0
		};
	}
	return state.__kustoVirtual;
}

function __kustoResolveVirtualScrollElement(containerEl: any) {
	if (!containerEl) return null;
	// Prefer the table container itself when it is scrollable.
	try {
		const sh = Math.max(0, containerEl.scrollHeight || 0);
		const ch = Math.max(0, containerEl.clientHeight || 0);
		if (sh > (ch + 1)) return containerEl;
	} catch { /* ignore */ }

	// Otherwise, find the nearest scrollable ancestor.
	let el = null;
	try { el = containerEl.parentElement; } catch { el = null; }
	for (let i = 0; el && i < 12; i++) {
		try {
			const sh = Math.max(0, el.scrollHeight || 0);
			const ch = Math.max(0, el.clientHeight || 0);
			if (sh > (ch + 1)) {
				let oy = '';
				try { oy = String(window.getComputedStyle(el).overflowY || '').toLowerCase(); } catch { oy = ''; }
				if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
					return el;
				}
			}
		} catch { /* ignore */ }
		try { el = el.parentElement; } catch { el = null; }
	}

	// Fallback to document scroller.
	try {
		const se = document.scrollingElement || document.documentElement;
		if (se) {
			const sh = Math.max(0, se.scrollHeight || 0);
			const ch = Math.max(0, se.clientHeight || 0);
			if (sh > (ch + 1)) return se;
		}
	} catch { /* ignore */ }

	return containerEl;
}

function __kustoResolveScrollSourceForEvent(ev: any, containerEl: any) {
	try {
		if (!containerEl) return null;
		const t = ev && ev.target ? ev.target : null;
		// Scroll events do not bubble; when we capture on document, the target can be the
		// actual scroller (element) or the document.
		if (t && t.nodeType === 9) {
			try { return document.scrollingElement || document.documentElement || null; } catch { return null; }
		}
		if (t && t.nodeType === 1) {
			let el = t;
			for (let i = 0; el && i < 16; i++) {
				try {
					// Only consider ancestors related to this table container.
					if (!el.contains(containerEl) && !containerEl.contains(el)) {
						// Keep climbing; a higher ancestor might contain both.
						el = el.parentElement;
						continue;
					}
					const sh = Math.max(0, el.scrollHeight || 0);
					const ch = Math.max(0, el.clientHeight || 0);
					if (sh > (ch + 1)) {
						let oy = '';
						try { oy = String(window.getComputedStyle(el).overflowY || '').toLowerCase(); } catch { oy = ''; }
						if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
							return el;
						}
					}
				} catch { /* ignore */ }
				try { el = el.parentElement; } catch { el = null; }
			}
		}
	} catch { /* ignore */ }
	return __kustoResolveVirtualScrollElement(containerEl);
}

function __kustoGetVirtualScrollMetrics(scrollEl: any, containerEl: any) {
	let scrollTop = 0;
	let clientH = 0;
	try {
		if (scrollEl && containerEl && scrollEl !== containerEl) {
			// When the scroll container is an ancestor (or the document), compute effective
			// scrollTop as the amount the table container's top has scrolled past the top
			// of the scroll viewport. Compute clientH as the visible intersection height.
			const sRect = scrollEl.getBoundingClientRect ? scrollEl.getBoundingClientRect() : null;
			const cRect = containerEl.getBoundingClientRect ? containerEl.getBoundingClientRect() : null;
			if (sRect && cRect) {
				scrollTop = Math.max(0, Math.floor((sRect.top - cRect.top) || 0));
				const visTop = Math.max(cRect.top, sRect.top);
				const visBottom = Math.min(cRect.bottom, sRect.bottom);
				clientH = Math.max(0, Math.floor(visBottom - visTop));
			}
			if (!clientH) {
				try { clientH = Math.max(0, Math.floor(containerEl.clientHeight || 0)); } catch { /* ignore */ }
			}
		} else if (containerEl) {
			try { scrollTop = Math.max(0, Math.floor(containerEl.scrollTop || 0)); } catch { /* ignore */ }
			try { clientH = Math.max(0, Math.floor(containerEl.clientHeight || 0)); } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
	return { scrollTop, clientH };
}

function __kustoBumpVisualVersion(state: any) {
	try {
		if (!state || typeof state !== 'object') return;
		const cur = (typeof state.__kustoVisualVersion === 'number' && isFinite(state.__kustoVisualVersion))
			? state.__kustoVisualVersion
			: 0;
		state.__kustoVisualVersion = cur + 1;
	} catch { /* ignore */ }
}

function __kustoComputeVirtualRange(state: any, containerEl: any, displayRowIndices: any, options: any) {
	const v = __kustoGetVirtualizationState(state);
	const total = Array.isArray(displayRowIndices) ? displayRowIndices.length : 0;
	if (!v || !containerEl || total <= 0) {
		return { start: 0, end: total };
	}
	const rowH = Math.max(12, Math.floor(v.rowHeight || 22));
	let scrollTop = 0;
	let clientH = 0;
	try {
		// Always prefer the container's own scroll position when it is scrollable.
		// Using a cached scrollSourceEl (which can be e.g. the document scroller, set by an
		// unrelated document-level scroll event) would give wrong metrics and cause the
		// virtual window to get "stuck" at its initial position.
		let effectiveScrollEl = null;
		try {
			const sh = Math.max(0, containerEl.scrollHeight || 0);
			const ch = Math.max(0, containerEl.clientHeight || 0);
			if (sh > (ch + 1)) {
				effectiveScrollEl = containerEl;
			}
		} catch { /* ignore */ }
		if (!effectiveScrollEl) {
			effectiveScrollEl = (options && options.scrollEl) ? options.scrollEl : __kustoResolveVirtualScrollElement(containerEl);
		}
		const m = __kustoGetVirtualScrollMetrics(effectiveScrollEl, containerEl);
		scrollTop = Math.max(0, Math.floor(m.scrollTop || 0));
		clientH = Math.max(0, Math.floor(m.clientH || 0));
	} catch { /* ignore */ }

	// Subtract the thead height so scrollTop maps to the data row area, not the header.
	const theadH = Math.max(0, Math.floor(v.theadHeight || 0));
	const dataScrollTop = Math.max(0, scrollTop - theadH);

	const visibleCount = Math.max(1, Math.ceil(clientH / rowH));
	const overscan = Math.max(4, Math.floor(v.overScan || 5));
	// Compute the first visible row index from the scroll position.
	const topRow = Math.floor(dataScrollTop / rowH);
	// Start `overscan` rows above the viewport, end `overscan` rows below it.
	// Unlike `end = start + visibleCount + 2*overscan`, this formula ensures `end`
	// tracks the actual viewport bottom even when `start` is clamped to 0 near the
	// top of the list. The old formula created an over-extended window at the top
	// (e.g. 47 rows for a 7-row viewport), causing the window to stay stuck at
	// [0, 47) until the user scrolled past 600+ pixels into the empty spacer.
	let start = Math.max(0, topRow - overscan);
	let end = Math.min(total, topRow + visibleCount + overscan);

	// If a specific display row should be visible (selected cell, current search match),
	// expand/shift the window so it is included.
	const forceDisplayRow = options && isFinite(options.forceDisplayRow) ? Math.floor(options.forceDisplayRow) : null;
	if (forceDisplayRow !== null && forceDisplayRow >= 0 && forceDisplayRow < total) {
		if (forceDisplayRow < start) {
			start = Math.max(0, forceDisplayRow - overscan);
			end = Math.min(total, Math.max(end, forceDisplayRow + visibleCount + overscan));
		} else if (forceDisplayRow >= end) {
			end = Math.min(total, forceDisplayRow + overscan + 1);
			start = Math.max(0, Math.min(start, forceDisplayRow - visibleCount - overscan));
		}
	}

	return { start, end };
}

function __kustoBuildResultsTableRowHtml(rowIdx: any, displayIdx: any, state: any, boxId: any, matchSet: any, currentKey: any) {
	const rows = Array.isArray(state.rows) ? state.rows : [];
	const row = rows[rowIdx] || [];
	const range = (state && state.cellSelectionRange && typeof state.cellSelectionRange === 'object') ? state.cellSelectionRange : null;
	const trClass = state.selectedRows && state.selectedRows.has(rowIdx) ? ' class="selected-row"' : '';
	const boxIdArg = __kustoEscapeForHtmlAttribute(JSON.stringify(String(boxId)));
	return (
		'<tr data-row="' + rowIdx + '"' + trClass + '>' +
		'<td class="row-selector" onclick="toggleRowSelection(' + rowIdx + ', ' + boxIdArg + '); event.stopPropagation();">' + (displayIdx + 1) + '</td>' +
		row.map((cell: any, colIdx: any) => {
			const hasHover = typeof cell === 'object' && cell !== null && 'display' in cell && 'full' in cell;
			const displayValue = hasHover ? cell.display : cell;
			const fullValue = hasHover ? cell.full : cell;
			const isObject = cell && cell.isObject;
			const title = hasHover && displayValue !== fullValue && !isObject ? ' title="' + __kustoEscapeForHtmlAttribute(fullValue) + '"' : '';
			const viewBtn = isObject ? '<button class="object-view-btn" onclick="event.stopPropagation(); openObjectViewer(' + rowIdx + ', ' + colIdx + ', ' + boxIdArg + ')">View</button>' : '';
			const cellHtml = isObject ? '' : __kustoFormatCellDisplayValueForTable(displayValue);
			let tdClass = '';
			if (range && isFinite(range.displayRowMin) && isFinite(range.displayRowMax) && isFinite(range.colMin) && isFinite(range.colMax)) {
				if (displayIdx >= range.displayRowMin && displayIdx <= range.displayRowMax && colIdx >= range.colMin && colIdx <= range.colMax) {
					tdClass += (tdClass ? ' ' : '') + 'selected-cell';
				}
			}
			if (state.selectedCell && state.selectedCell.row === rowIdx && state.selectedCell.col === colIdx) {
				tdClass += (tdClass ? ' ' : '') + 'selected-cell-focus';
			}
			if (matchSet && matchSet.has(String(rowIdx) + ',' + String(colIdx))) {
				tdClass += (tdClass ? ' ' : '') + 'search-match';
				if (currentKey && currentKey === (String(rowIdx) + ',' + String(colIdx))) {
					tdClass += ' search-match-current';
				}
			}
			const classAttr = tdClass ? (' class="' + tdClass + '"') : '';
			const dblClickHandler = ' ondblclick="handleCellDoubleClick(event, ' + rowIdx + ', ' + colIdx + ', ' + boxIdArg + ')"';
			return '<td data-row="' + rowIdx + '" data-col="' + colIdx + '"' + classAttr + title + ' onclick="selectCell(' + rowIdx + ', ' + colIdx + ', ' + boxIdArg + ')"' + dblClickHandler + '>' +
				cellHtml + viewBtn +
			'</td>';
		}).join('') +
		'</tr>'
	);
}

function __kustoRerenderResultsTableBody(boxId: any, options: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }
	const table = document.getElementById(boxId + '_table');
	if (!table) { return; }
	const container = document.getElementById(boxId + '_table_container');
	const boxIdArg = __kustoEscapeForHtmlAttribute(JSON.stringify(String(boxId)));

	// Update sort indicators.
	try {
		const spec = Array.isArray(state.sortSpec) ? state.sortSpec : [];
		for (let i = 0; i < (state.columns || []).length; i++) {
			const indicator = document.getElementById(boxId + '_sort_ind_' + i);
			if (!indicator) continue;
			const ruleIdx = spec.findIndex((r: any) => r && r.colIndex === i);
			if (ruleIdx < 0) {
				indicator.innerHTML = '';
				continue;
			}
			const dir = __kustoNormalizeSortDirection(spec[ruleIdx].dir);
			const arrow = (dir === 'desc') ? '▼' : '▲';
			const ord = spec.length > 1 ? ('<span class="kusto-sort-priority">' + String(ruleIdx + 1) + '</span>') : '';
			indicator.innerHTML = arrow + ord;
		}
	} catch { /* ignore */ }

	// Update filtered column links.
	try {
		const filters = __kustoEnsureColumnFiltersMap(state);
		for (let i = 0; i < (state.columns || []).length; i++) {
			const el = document.getElementById(boxId + '_filter_link_' + i);
			if (!el) continue;
			const active = _win.__kustoIsFilterSpecActive(filters[String(i)]);
			el.innerHTML = active
				? ('<a href="#" class="kusto-filtered-link" onclick="openColumnFilter(event, ' + String(i) + ', ' + boxIdArg + '); return false;">(filtered)</a>')
				: '';
		}
	} catch { /* ignore */ }

	// Build fast lookup for search matches.
	let matchSet = null;
	let currentKey = null;
	try {
		const matches = Array.isArray(state.searchMatches) ? state.searchMatches : [];
		if (matches.length > 0) {
			matchSet = new Set();
			for (const m of matches) {
				if (!m) continue;
				matchSet.add(String(m.row) + ',' + String(m.col));
			}
			const cur = (state.currentSearchIndex >= 0 && state.currentSearchIndex < matches.length) ? matches[state.currentSearchIndex] : null;
			if (cur) currentKey = String(cur.row) + ',' + String(cur.col);
		}
	} catch { /* ignore */ }

	const rows = Array.isArray(state.rows) ? state.rows : [];
	const cols = Array.isArray(state.columns) ? state.columns : [];
	const displayRowIndices = Array.isArray(state.displayRowIndices) ? state.displayRowIndices : rows.map((_: any, i: any) => i);

	try {
		const countEl = document.getElementById(boxId + '_results_count');
		if (countEl) {
			const total = rows ? rows.length : 0;
			const shown = displayRowIndices ? displayRowIndices.length : 0;
			// When results were truncated during persistence (file too large), show the
			// original row count alongside the restored count so the user knows why the
			// number is smaller than expected.
			const meta = (state && state.metadata && typeof state.metadata === 'object') ? state.metadata : {};
			const wasTruncated = !!meta.persistedTruncated;
			const originalTotal = (wasTruncated && typeof meta.persistedTotalRows === 'number' && isFinite(meta.persistedTotalRows))
				? meta.persistedTotalRows
				: 0;
			let countText = '';
			if (shown !== total) {
				countText = String(shown) + ' / ' + String(total);
			} else {
				countText = String(total);
			}
			if (wasTruncated && originalTotal > total) {
				countText += ' (of ' + String(originalTotal) + ' \u2014 truncated to fit file)';
			}
			countEl.textContent = countText;
		}
	} catch { /* ignore */ }

	// Enable virtualization only for larger results.
	const v = __kustoGetVirtualizationState(state);
	const virtualThreshold = 500;
	try { if (v) v.enabled = (displayRowIndices.length > virtualThreshold); } catch { /* ignore */ }

	// Determine which display row should be forced into view (selected cell or current search match).
	// IMPORTANT: Only apply forceDisplayRow for programmatic navigation (initial render, search,
	// keyboard cell navigation). During user-initiated scrolling, forceDisplayRow would anchor the
	// virtual window to the selected cell and prevent it from advancing as the user scrolls.
	const _reason = (options && options.reason) ? options.reason : '';
	const _isScrollDriven = (_reason === 'scroll' || _reason === 'resize' || _reason === 'spacer-visible' || _reason === 'spacer-visible-deferred');
	let forceDisplayRow = null;
	try {
		if (v && v.enabled && !_isScrollDriven) {
			const inv = Array.isArray(state.rowIndexToDisplayIndex) ? state.rowIndexToDisplayIndex : null;
			if (state.selectedCell && inv && isFinite(inv[state.selectedCell.row])) {
				forceDisplayRow = inv[state.selectedCell.row];
			} else if (state.searchMatches && state.currentSearchIndex >= 0 && state.currentSearchIndex < state.searchMatches.length) {
				const m = state.searchMatches[state.currentSearchIndex];
				if (m && inv && isFinite(inv[m.row])) {
					forceDisplayRow = inv[m.row];
				}
			}
		}
	} catch { /* ignore */ }

	const visibleRange = (v && v.enabled)
		? __kustoComputeVirtualRange(state, container, displayRowIndices, { forceDisplayRow, scrollEl: (v && v.scrollSourceEl) ? v.scrollSourceEl : null })
		: { start: 0, end: displayRowIndices.length };

	const colSpan = (cols ? cols.length : 0) + 1;
	const rowH = v ? Math.max(12, Math.floor(v.rowHeight || 22)) : 22;
	const topPad = (v && v.enabled) ? (visibleRange.start * rowH) : 0;
	const bottomPad = (v && v.enabled) ? ((displayRowIndices.length - visibleRange.end) * rowH) : 0;
	const displayVersion = (typeof state.__kustoDisplayRowVersion === 'number' && isFinite(state.__kustoDisplayRowVersion))
		? state.__kustoDisplayRowVersion
		: 0;
	const visualVersion = (typeof state.__kustoVisualVersion === 'number' && isFinite(state.__kustoVisualVersion))
		? state.__kustoVisualVersion
		: 0;

	let tbodyHtml = '';
	if (v && v.enabled && topPad > 0) {
		// Spacer rows must reliably contribute to table height so the scroll container
		// gets a real scrollbar. Some table layouts ignore an empty cell's height, so
		// include an inner block element and set height on both TR + TD.
		tbodyHtml += '<tr class="kusto-virtual-spacer" aria-hidden="true" style="height:' + topPad + 'px;">' +
			'<td colspan="' + colSpan + '" style="height:' + topPad + 'px; min-height:' + topPad + 'px; padding:0; border:0;">' +
			'<div style="height:' + topPad + 'px; overflow:hidden; font-size:0; line-height:0;"></div>' +
			'</td></tr>';
	}
	for (let displayIdx = visibleRange.start; displayIdx < visibleRange.end; displayIdx++) {
		const rowIdx = displayRowIndices[displayIdx];
		tbodyHtml += __kustoBuildResultsTableRowHtml(rowIdx, displayIdx, state, boxId, matchSet, currentKey);
	}
	if (v && v.enabled && bottomPad > 0) {
		tbodyHtml += '<tr class="kusto-virtual-spacer" aria-hidden="true" style="height:' + bottomPad + 'px;">' +
			'<td colspan="' + colSpan + '" style="height:' + bottomPad + 'px; min-height:' + bottomPad + 'px; padding:0; border:0;">' +
			'<div style="height:' + bottomPad + 'px; overflow:hidden; font-size:0; line-height:0;"></div>' +
			'</td></tr>';
	}

	try {
		const tbody = table.querySelector('tbody') as any;
		if (tbody) {
			if (!v || !v.enabled || v.lastStart !== visibleRange.start || v.lastEnd !== visibleRange.end || v.lastDisplayVersion !== displayVersion || v.lastVisualVersion !== visualVersion) {
				// Save scrollTop before innerHTML replacement. Replacing tbody content can
				// cause the browser to momentarily recalculate scroll metrics. If the content
				// height drops briefly (between removing old content and rendering new), the
				// browser clamps scrollTop to 0, which causes the virtual window to jump back
				// to the beginning. Restoring scrollTop after the update prevents this.
				let savedScrollTop = -1;
				try {
					if (container) savedScrollTop = container.scrollTop;
				} catch { /* ignore */ }
				tbody.innerHTML = tbodyHtml;
				// Restore scrollTop immediately after DOM update.
				try {
					if (container && savedScrollTop > 0 && Math.abs(container.scrollTop - savedScrollTop) > 1) {
						container.scrollTop = savedScrollTop;
					}
				} catch { /* ignore */ }
				if (v && v.enabled) {
					v.lastStart = visibleRange.start;
					v.lastEnd = visibleRange.end;
					v.lastDisplayVersion = displayVersion;
					v.lastVisualVersion = visualVersion;
				}
			}
		}
	} catch { /* ignore */ }

	// Measure row height and thead height once (after first render) to make virtualization accurate.
	try {
		if (v && v.enabled) {
			let needsRerender = false;
			// Measure actual data row height.
			// Re-measure if rowHeight was never set, is still the default (22),
			// or was set from a hidden-element measurement (12 = Math.max(12, 0)).
			// When the table is inside a display:none tree, getBoundingClientRect()
			// returns 0, so Math.max(12, 0) = 12 locks in a bogus value. The
			// condition below ensures we re-measure until a real (> 12) value is
			// obtained.
			if (!v.rowHeight || v.rowHeight <= 12 || v.rowHeight === 22) {
				const sample = table.querySelector('tbody tr[data-row]') as any;
				if (sample) {
					const h = Math.max(12, Math.round(sample.getBoundingClientRect().height || 0));
					if (h && isFinite(h) && h > 12 && h !== v.rowHeight) {
						v.rowHeight = h;
						needsRerender = true;
					}
				}
			}
			// Measure thead height so scrollTop-to-row-index mapping accounts for the header.
			if (!v.theadHeight) {
				const thead = table.querySelector('thead') as any;
				if (thead) {
					const th = Math.max(0, Math.round(thead.getBoundingClientRect().height || 0));
					if (th && isFinite(th)) {
						v.theadHeight = th;
						needsRerender = true;
					}
				}
			}
			if (needsRerender) {
				v.lastStart = -1;
				v.lastEnd = -1;
				// Re-render immediately with corrected measurements so spacer heights are
				// accurate from the start, preventing scroll jumps and empty regions.
				try { __kustoRerenderResultsTableBody(boxId, { reason: 'measurement' }); } catch { /* ignore */ }
				return; // the recursive call already handled the rest
			}
		}
	} catch { /* ignore */ }

	// Attach scroll/resize handlers for virtualization.
	// IMPORTANT: the actual scroller can differ by host (query results vs URL/CSV embeds).
	// Always attach to the table container, and also attach to the resolved scroll element
	// (which can be an ancestor) to avoid missing scroll events.
	try {
		if (container) {
			const st = __kustoGetResultsState(boxId);
			const vv = __kustoGetVirtualizationState(st);
			const scrollEl = __kustoResolveVirtualScrollElement(container);
			if (vv && scrollEl) {
				if (!vv.scrollHandler) {
					vv.scrollHandler = (ev: any) => {
						try {
							// Ignore scroll/wheel events that clearly don't relate to this table.
							try {
								const cont = document.getElementById(boxId + '_table_container');
								const t = ev && ev.target ? ev.target : null;
								if (cont && t && t !== cont) {
									if (t.nodeType === 1) {
										const te = t;
										// If the scroll target neither contains the container nor is contained by it,
										// it's unrelated (e.g. a different scrollable panel).
										if (!te.contains(cont) && !cont.contains(te)) {
											return;
										}
									}
								}
							} catch { /* ignore */ }

							// Record the actual scroll source so range calculation matches the host's scroll behavior.
							// IMPORTANT: only update scrollSourceEl when the source is directly related
							// to this table (the container or one of its ancestors that contains it).
							// Document-level captured events from unrelated scrollers (or the document
							// scroller itself) would corrupt the cached source, causing all subsequent
							// range calculations to use wrong metrics and making the virtual window
							// appear "stuck" — showing only the initial ~30 rows.
							try {
								const cont = document.getElementById(boxId + '_table_container');
								if (cont) {
									const src = __kustoResolveScrollSourceForEvent(ev, cont);
									// Only store the source if it is the container itself or a direct
									// scrollable ancestor that actually contains the table. The document
									// scrolling element should not override a more specific source.
									if (src && src !== document.scrollingElement && src !== document.documentElement) {
										vv.scrollSourceEl = src;
									} else if (src && !vv.scrollSourceEl) {
										// Only use document scroller as fallback if nothing better was found
										vv.scrollSourceEl = src;
									}
								}
							} catch { /* ignore */ }

							const st2 = __kustoGetResultsState(boxId);
							const vv2 = __kustoGetVirtualizationState(st2);
							if (!vv2) {
								return;
							}
							// The enabled flag may be stale if the state object was replaced
							// (e.g. displayResultForBox creates a new state). Re-derive it
							// from the actual row count so the handler doesn't silently die.
							if (!vv2.enabled) {
								const rows2 = Array.isArray(st2.rows) ? st2.rows : [];
								const disp2 = Array.isArray(st2.displayRowIndices) ? st2.displayRowIndices : rows2;
								if (disp2.length > 500) {
									vv2.enabled = true;
								} else {
									return; // genuinely small result, no virtualization needed
								}
							}
							if (vv2.rafPending) {
								return;
							}
							vv2.rafPending = true;
							// Use setTimeout(0) instead of requestAnimationFrame for coalescing.
							// RAF callbacks can be delayed or skipped in VS Code webviews under
							// certain conditions (e.g. background tabs, rapid scrolling during
							// layout recalculations). setTimeout(0) ensures the callback fires
							// on the next event-loop turn regardless of rendering state.
							setTimeout(() => {
								vv2.rafPending = false;
								try { __kustoRerenderResultsTableBody(boxId, { reason: 'scroll' }); } catch { /* ignore */ }
							}, 0);
						} catch { /* ignore */ }
					};
				}
				// Always listen on the table container (ideal scroller in most hosts).
				try { container.addEventListener('scroll', vv.scrollHandler, { passive: true }); } catch { /* ignore */ }
				try { container.addEventListener('wheel', vv.scrollHandler, { passive: true }); } catch { /* ignore */ }

				try {
					if (vv.scrollEl && vv.scrollEl !== scrollEl && vv.scrollHandler) {
						vv.scrollEl.removeEventListener('scroll', vv.scrollHandler);
					}
				} catch { /* ignore */ }
				try {
					if (scrollEl !== container) {
						scrollEl.addEventListener('scroll', vv.scrollHandler, { passive: true });
						try { scrollEl.addEventListener('wheel', vv.scrollHandler, { passive: true }); } catch { /* ignore */ }
					}
					vv.scrollEl = scrollEl;
				} catch { /* ignore */ }

				// Fallback: capture scroll/wheel at the document level.
				// Scroll events do not bubble, and in some hosts the scroller can be an ancestor or the
				// document itself. Capturing ensures we still get notified.
				try {
					if (!vv.documentCaptureAttached) {
						vv.documentCaptureAttached = true;
						document.addEventListener('scroll', vv.scrollHandler, { passive: true, capture: true });
						document.addEventListener('wheel', vv.scrollHandler, { passive: true, capture: true });
					}
				} catch { /* ignore */ }

				try {
					if (typeof ResizeObserver !== 'undefined') {
						if (!vv.resizeObserver) {
							vv.resizeObserver = new ResizeObserver(() => {
								try {
									const st3 = __kustoGetResultsState(boxId);
									const vv3 = __kustoGetVirtualizationState(st3);
									if (vv3) {
										vv3.lastStart = -1;
										vv3.lastEnd = -1;
									}
									__kustoRerenderResultsTableBody(boxId, { reason: 'resize' });
								} catch { /* ignore */ }
							});
						}
						if (vv.resizeObserver && Array.isArray(vv.observedEls)) {
							if (vv.observedEls.indexOf(container) < 0) {
								vv.resizeObserver.observe(container);
								vv.observedEls.push(container);
							}
							if (scrollEl && vv.observedEls.indexOf(scrollEl) < 0) {
								vv.resizeObserver.observe(scrollEl);
								vv.observedEls.push(scrollEl);
							}
						}
					}
				} catch { /* ignore */ }

				// IntersectionObserver fallback: when a virtual spacer row becomes visible, it
				// means the user has scrolled to the edge of the rendered window. Trigger a
				// re-render to materialize the next batch of rows. This is more robust than
				// relying solely on scroll events, which can be missed or coalesced away.
				try {
					if (typeof IntersectionObserver !== 'undefined' && vv.enabled) {
						if (!vv.spacerObserver) {
							vv.spacerObserver = new IntersectionObserver((entries) => {
								try {
									if (vv._suppressSpacerCallback) return;
									let anyVisible = false;
									for (const entry of entries) {
										if (entry.isIntersecting) { anyVisible = true; break; }
									}
									if (!anyVisible) return;
									// Debounce: at most one re-render per 50ms from the observer.
									if (vv._spacerRenderPending) return;
									vv._spacerRenderPending = true;
									setTimeout(() => {
										vv._spacerRenderPending = false;
										try { __kustoRerenderResultsTableBody(boxId, { reason: 'spacer-visible' }); } catch { /* ignore */ }
									}, 50);
								} catch { /* ignore */ }
							}, { root: container, threshold: 0 });
						}
						// Disconnect old observations and observe the current spacer rows.
						try { vv.spacerObserver.disconnect(); } catch { /* ignore */ }
						// Suppress callbacks briefly so that observing freshly-rendered spacers doesn't
						// immediately trigger a re-render loop.
						vv._suppressSpacerCallback = true;
						try {
							const spacers = table.querySelectorAll('tbody tr.kusto-virtual-spacer');
							for (const sp of spacers) {
								vv.spacerObserver.observe(sp);
							}
						} catch { /* ignore */ }
						setTimeout(() => {
							vv._suppressSpacerCallback = false;
							// After suppression ends, manually check if any observed spacer is
							// visible. The initial observe() callback fires immediately (and was
							// suppressed), but IntersectionObserver won't fire again until the
							// intersection *changes*. So if a spacer was already visible when
							// observed, we'd never get another callback. Re-check now.
							try {
								const obs = vv.spacerObserver;
								if (obs && typeof obs.takeRecords === 'function') {
									const records = obs.takeRecords();
									let anyVisible = false;
									for (const entry of records) {
										if (entry.isIntersecting) { anyVisible = true; break; }
									}
									if (anyVisible && !vv._spacerRenderPending) {
										vv._spacerRenderPending = true;
										setTimeout(() => {
											vv._spacerRenderPending = false;
											try { __kustoRerenderResultsTableBody(boxId, { reason: 'spacer-visible-deferred' }); } catch { /* ignore */ }
										}, 50);
									}
								}
							} catch { /* ignore */ }
						}, 100);
					}
				} catch { /* ignore */ }
			}
		}
	} catch { /* ignore */ }

	try { _win.__kustoEnsureDragSelectionHandlers(boxId); } catch { /* ignore */ }
	try { _win.__kustoUpdateSplitButtonState(boxId); } catch { /* ignore */ }
}

function displayResult(result: any) {
	const boxId = (_win.lastExecutedBox as any);
	if (!boxId) { return; }

	(_win.setQueryExecuting as any)(boxId, false);

	displayResultForBox(result, boxId, {
		label: 'Results',
		showExecutionTime: true
	});
}

// Ensure these entrypoints are always accessible globally (some hosts/tooling can
// make bare function declarations non-global).
try { (window as any).displayResult = displayResult; } catch { /* ignore */ }
try { (window as any).displayResultForBox = displayResultForBox; } catch { /* ignore */ }

function __kustoEnsureResultsStateMap() {
	if (!(_win.__kustoResultsByBoxId as any) || typeof (_win.__kustoResultsByBoxId as any) !== 'object') {
		(_win.__kustoResultsByBoxId as any) = {};
	}
	return (_win.__kustoResultsByBoxId as any);
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
	try { (_win.currentResult as any) = state; } catch { /* ignore */ }
	// Notify any dependent sections (charts/transformations) that this data source changed.
	try {
		if (typeof (_win.__kustoNotifyResultsUpdated as any) === 'function') {
			(_win.__kustoNotifyResultsUpdated as any)(boxId);
		}
	} catch { /* ignore */ }
}

function displayResultForBox(result: any, boxId: any, options: any) {
	if (!boxId) { return; }

	// If the section is a <kw-query-section> Lit element, delegate to displayResult().
	if (!(options && options.resultsDiv)) {
		try {
			const sectionEl = document.getElementById(boxId);
			if (sectionEl && typeof (sectionEl as any).displayResult === 'function') {
				(sectionEl as any).displayResult(result, options);
				// Still update global results state for cross-section dependencies.
				const cols = Array.isArray(result && result.columns) ? result.columns : [];
				const rws = Array.isArray(result && result.rows) ? result.rows : [];
				const meta = (result && result.metadata && typeof result.metadata === 'object') ? result.metadata : {};
				__kustoSetResultsState(boxId, {
					boxId, columns: cols, rows: rws, metadata: meta,
					selectedCell: null, cellSelectionAnchor: null, cellSelectionRange: null,
					selectedRows: new Set(), searchMatches: [], currentSearchIndex: -1,
					sortSpec: [], columnFilters: {}, filteredRowIndices: null,
					displayRowIndices: null, rowIndexToDisplayIndex: null
				});
				try { __kustoEnsureDisplayRowIndexMaps(__kustoGetResultsState(boxId)); } catch { /* ignore */ }
				try { (_win.__kustoTryStoreQueryResult as any)(boxId, result); } catch { /* ignore */ }
				try { _win.__kustoUpdateSplitButtonState(boxId); } catch { /* ignore */ }
				return;
			}
		} catch { /* ignore — fall through to legacy rendering */ }
	}

	const resultsDiv = (options && options.resultsDiv) ? options.resultsDiv : document.getElementById(boxId + '_results');
	if (!resultsDiv) { return; }

	const columns = Array.isArray(result && result.columns) ? result.columns : [];
	const rows = Array.isArray(result && result.rows) ? result.rows : [];
	const metadata = (result && result.metadata && typeof result.metadata === 'object') ? result.metadata : {};
	__kustoSetResultsState(boxId, {
		boxId: boxId,
		columns: columns,
		rows: rows,
		metadata: metadata,
		selectedCell: null,
		cellSelectionAnchor: null,
		cellSelectionRange: null,
		selectedRows: new Set(),
		searchMatches: [],
		currentSearchIndex: -1,
		sortSpec: [],
		columnFilters: {},
		filteredRowIndices: null,
		displayRowIndices: null,
		rowIndexToDisplayIndex: null
	});
	try {
		const st = __kustoGetResultsState(boxId);
		if (st) {
			__kustoEnsureDisplayRowIndexMaps(st);
		}
	} catch { /* ignore */ }

	const label = (options && typeof options.label === 'string' && options.label) ? options.label : 'Results';
	const showExecutionTime = !(options && options.showExecutionTime === false);
	const execTime = metadata && typeof metadata.executionTime === 'string' ? metadata.executionTime : '';
	const execPart = (showExecutionTime && execTime) ? ('<span class="results-exec-info"> (Execution time: ' + execTime + ')</span>') : '';

	const searchIconSvg = __kustoGetSearchIconSvg();
	const scrollToColumnIconSvg = __kustoGetScrollToColumnIconSvg();
	const resultsVisibilityIconSvg = __kustoGetResultsVisibilityIconSvg();
	const sortIconSvg = __kustoGetSortIconSvg();
	const copyIconSvg = __kustoGetCopyIconSvg();
	const saveIconSvg = __kustoGetSaveIconSvg();
	const toolsIconSvg = '<span class="codicon codicon-tools" aria-hidden="true"></span>';
	const chevronDownSvg = '<svg class="results-tools-dropdown-caret" width="12" height="12" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg>';

	const stateForRender = __kustoGetResultsState(boxId);
	const displayRowIndices = (stateForRender && Array.isArray(stateForRender.displayRowIndices)) ? stateForRender.displayRowIndices : rows.map((_: any, i: any) => i);

	// Build the collapsed Tools dropdown menu (shown when width is narrow)
	const toolsDropdownHtml =
		'<div class="results-tools-dropdown" id="' + boxId + '_results_tools_dropdown">' +
		'<button class="results-tools-dropdown-btn" id="' + boxId + '_results_tools_dropdown_btn" type="button" onclick="__kustoToggleResultsToolsDropdown(\'' + boxId + '\'); event.stopPropagation();" title="Tools" aria-label="Tools" aria-haspopup="listbox" aria-expanded="false">' +
		toolsIconSvg + chevronDownSvg +
		'</button>' +
		'<div class="results-tools-dropdown-menu" id="' + boxId + '_results_tools_dropdown_menu" role="listbox" tabindex="-1">' +
		'<div class="results-tools-dropdown-item results-visibility-item" id="' + boxId + '_tools_dd_visibility" onclick="__kustoResultsToolsDropdownAction(\'' + boxId + '\', \'visibility\');" title="Show/Hide results">' + resultsVisibilityIconSvg + '<span id="' + boxId + '_tools_dd_visibility_label">Hide results</span></div>' +
		'<div class="results-tools-dropdown-sep results-visibility-item"></div>' +
		'<div class="results-tools-dropdown-item" id="' + boxId + '_tools_dd_search" onclick="__kustoResultsToolsDropdownAction(\'' + boxId + '\', \'search\');" title="Search data">' + searchIconSvg + '<span>Search</span></div>' +
		'<div class="results-tools-dropdown-item" id="' + boxId + '_tools_dd_column" onclick="__kustoResultsToolsDropdownAction(\'' + boxId + '\', \'column\');" title="Scroll to column">' + scrollToColumnIconSvg + '<span>Go to column</span></div>' +
		'<div class="results-tools-dropdown-item" id="' + boxId + '_tools_dd_sort" onclick="__kustoResultsToolsDropdownAction(\'' + boxId + '\', \'sort\');" title="Sort">' + sortIconSvg + '<span>Sort</span></div>' +
		'<div class="results-tools-dropdown-sep"></div>' +
		'<div class="results-tools-dropdown-item" id="' + boxId + '_tools_dd_save" onclick="__kustoResultsToolsDropdownAction(\'' + boxId + '\', \'save\');" title="Save results to file">' + saveIconSvg + '<span>Save</span></div>' +
		'<div class="results-tools-dropdown-item" id="' + boxId + '_tools_dd_copy" onclick="__kustoResultsToolsDropdownAction(\'' + boxId + '\', \'copy\');" title="Copy results to clipboard">' + copyIconSvg + '<span>Copy</span></div>' +
		'</div>' +
		'</div>';

	const clientActivityId = metadata && typeof metadata.clientActivityId === 'string' ? metadata.clientActivityId : '';
	const serverStats = (metadata && metadata.serverStats && typeof metadata.serverStats === 'object') ? metadata.serverStats : null;
	const hasTooltipContent = !!(clientActivityId || serverStats);
	const titleRowTooltipClass = hasTooltipContent ? ' results-label-tooltip-anchor' : '';

	// Build rich tooltip HTML with activity ID + server stats
	let resultsLabelTooltipHtml = '';
	if (hasTooltipContent) {
		let tooltipRows = '';

		// Activity ID row
		if (clientActivityId) {
			tooltipRows +=
				'<div class="results-label-tooltip-row">' +
				'<span class="results-label-tooltip-title">Client Activity ID</span>' +
				'<span class="results-label-tooltip-value" id="' + boxId + '_client_activity_id">' + clientActivityId + '</span>' +
				'<button class="results-label-tooltip-copy" type="button" onclick="event.stopPropagation(); __kustoCopyClientActivityId(\'' + __kustoEscapeJsStringLiteral(boxId) + '\')" title="Copy to clipboard" aria-label="Copy Client Activity ID">' +
				copyIconSvg +
				'</button>' +
				'</div>';
		}

		// Server stats rows
		if (serverStats) {
			const fmtCpuMs = function(ms: any) {
				if (ms < 1000) { return ms.toFixed(1) + 'ms'; }
				return (ms / 1000).toFixed(3) + 's';
			};
			const fmtBytes = function(bytes: any) {
				if (bytes == null || !isFinite(bytes)) { return '?'; }
				if (bytes < 1024) { return bytes + ' B'; }
				if (bytes < 1024 * 1024) { return (bytes / 1024).toFixed(1) + ' KB'; }
				if (bytes < 1024 * 1024 * 1024) { return (bytes / (1024 * 1024)).toFixed(1) + ' MB'; }
				return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
			};
			const fmtNum = function(n: any) { return n == null ? '?' : Number(n).toLocaleString(); };

			const statRow = function(label: any, value: any) {
				return '<div class="results-label-tooltip-row results-label-tooltip-stat-row">' +
					'<span class="results-label-tooltip-title">' + label + '</span>' +
					'<span class="results-label-tooltip-value">' + value + '</span>' +
					'</div>';
			};

			tooltipRows += '<div class="results-label-tooltip-separator"></div>';

			if (serverStats.cpuTimeMs != null && isFinite(serverStats.cpuTimeMs)) {
				tooltipRows += statRow('Server CPU', fmtCpuMs(serverStats.cpuTimeMs));
			} else if (serverStats.cpuTime) {
				tooltipRows += statRow('Server CPU', serverStats.cpuTime);
			}
			if (serverStats.peakMemoryPerNode != null && isFinite(serverStats.peakMemoryPerNode)) {
				tooltipRows += statRow('Peak memory', fmtBytes(serverStats.peakMemoryPerNode));
			}
			if (serverStats.extentsScanned != null) {
				var extLabel = fmtNum(serverStats.extentsScanned);
				if (serverStats.extentsTotal != null) {
					extLabel += ' / ' + fmtNum(serverStats.extentsTotal);
				}
				tooltipRows += statRow('Extents scanned', extLabel);
			}
			// Cache
			var memHits = typeof serverStats.memoryCacheHits === 'number' ? serverStats.memoryCacheHits : null;
			var memMisses = typeof serverStats.memoryCacheMisses === 'number' ? serverStats.memoryCacheMisses : null;
			if (memHits != null || memMisses != null) {
				var total = (memHits || 0) + (memMisses || 0);
				var rate = total > 0 ? ((memHits || 0) / total * 100).toFixed(1) + '%' : 'N/A';
				tooltipRows += statRow('Memory cache', rate + ' (' + fmtNum(memHits || 0) + ' hits, ' + fmtNum(memMisses || 0) + ' misses)');
			}
			var diskHits = typeof serverStats.diskCacheHits === 'number' ? serverStats.diskCacheHits : null;
			var diskMisses = typeof serverStats.diskCacheMisses === 'number' ? serverStats.diskCacheMisses : null;
			if (diskHits != null || diskMisses != null) {
				var dTotal = (diskHits || 0) + (diskMisses || 0);
				var dRate = dTotal > 0 ? ((diskHits || 0) / dTotal * 100).toFixed(1) + '%' : 'N/A';
				tooltipRows += statRow('Disk cache', dRate + ' (' + fmtNum(diskHits || 0) + ' hits, ' + fmtNum(diskMisses || 0) + ' misses)');
			}
			if (serverStats.shardHotHitBytes != null || serverStats.shardHotMissBytes != null) {
				tooltipRows += statRow('Shard hot cache', fmtBytes(serverStats.shardHotHitBytes || 0) + ' hit / ' + fmtBytes(serverStats.shardHotMissBytes || 0) + ' miss');
			}
			if (serverStats.serverRowCount != null) {
				tooltipRows += statRow('Server row count', fmtNum(serverStats.serverRowCount));
			}
			if (serverStats.serverTableSize != null) {
				tooltipRows += statRow('Result size', fmtBytes(serverStats.serverTableSize));
			}
		}

		resultsLabelTooltipHtml =
			'<div class="results-label-tooltip" id="' + boxId + '_activity_id_tooltip">' +
			tooltipRows +
			'</div>';
	}

	const wasTruncated = !!metadata.persistedTruncated;
	const originalTotal = (wasTruncated && typeof metadata.persistedTotalRows === 'number' && isFinite(metadata.persistedTotalRows))
		? metadata.persistedTotalRows : 0;
	const initialRowCountText = (rows ? rows.length : 0) +
		(wasTruncated && originalTotal > (rows ? rows.length : 0)
			? ' (of ' + String(originalTotal) + ' \u2014 truncated to fit file)'
			: '');

	let html =
		'<div class="results-header">' +
		'<div class="results-title-row' + titleRowTooltipClass + '">' +
		'<strong>' + label + ':</strong><span class="results-row-col-info"> <span id="' + boxId + '_results_count">' + initialRowCountText + '</span> rows / ' + (columns ? columns.length : 0) + ' columns</span>' +
		execPart +
		'<button class="unified-btn-secondary tool-toggle-btn results-visibility-toggle" id="' + boxId + '_results_toggle" type="button" onclick="toggleQueryResultsVisibility(\'' + boxId + '\')" title="Hide results" aria-label="Hide results">' + resultsVisibilityIconSvg + '</button>' +
		resultsLabelTooltipHtml +
		'</div>' +
		'<div class="results-tools-row">' +
		// Collapsed Tools dropdown (visible when narrow)
		toolsDropdownHtml +
		// Individual tool buttons (visible when wide enough)
		'<div class="results-tools-individual">' +
		'<button class="unified-btn-secondary tool-toggle-btn" id="' + boxId + '_results_search_btn" onclick="toggleSearchTool(\'' + boxId + '\')" title="Search data" aria-label="Search data">' + searchIconSvg + '</button>' +
		'<button class="unified-btn-secondary tool-toggle-btn" id="' + boxId + '_results_column_btn" onclick="toggleColumnTool(\'' + boxId + '\')" title="Scroll to column" aria-label="Scroll to column">' + scrollToColumnIconSvg + '</button>' +
		'<button class="unified-btn-secondary tool-toggle-btn" id="' + boxId + '_results_sort_btn" onclick="toggleSortDialog(\'' + boxId + '\')" title="Sort" aria-label="Sort">' + sortIconSvg + '</button>' +
		'<span class="results-sep" id="' + boxId + '_results_sep_2" aria-hidden="true"></span>' +
		'<span class="kusto-split-btn" id="' + boxId + '_results_save_split">' +
		'<button class="unified-btn-secondary tool-toggle-btn tool-save-results-btn" id="' + boxId + '_results_save_btn" onclick="__kustoOnSavePrimary(\'' + boxId + '\', \'' + __kustoEscapeJsStringLiteral(label) + '\')" title="Save results to file" aria-label="Save results to file">' + saveIconSvg + '</button>' +
		'<button class="unified-btn-secondary tool-toggle-btn kusto-split-caret" id="' + boxId + '_results_save_menu_btn" style="display: none;" onclick="__kustoOnSaveMenu(\'' + boxId + '\', \'' + __kustoEscapeJsStringLiteral(label) + '\', this)" title="More save options" aria-label="More save options"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg></button>' +
		'</span>' +
		'<span class="kusto-split-btn" id="' + boxId + '_results_copy_split">' +
		'<button class="unified-btn-secondary tool-toggle-btn tool-copy-results-btn" id="' + boxId + '_results_copy_btn" onclick="__kustoOnCopyPrimary(\'' + boxId + '\')" title="Copy results to clipboard" aria-label="Copy results to clipboard">' + copyIconSvg + '</button>' +
		'<button class="unified-btn-secondary tool-toggle-btn kusto-split-caret" id="' + boxId + '_results_copy_menu_btn" style="display: none;" onclick="__kustoOnCopyMenu(\'' + boxId + '\', this)" title="More copy options" aria-label="More copy options"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg></button>' +
		'</span>' +
		'</div>' +
		'</div>' +
		'</div>' +
		'<div class="results-body" id="' + boxId + '_results_body" data-kusto-no-editor-focus="true">' +
		'<div class="data-search" id="' + boxId + '_data_search_container" style="display: none;">' +
		'<div class="kusto-search-host" id="' + boxId + '_data_search_host"></div>' +
		'</div>' +
		'<div class="column-search" id="' + boxId + '_column_search_container" style="display: none;">' +
		'<div class="kusto-search-host" id="' + boxId + '_column_search_host"></div>' +
		'<div class="column-autocomplete" id="' + boxId + '_column_autocomplete"></div>' +
		'</div>' +
		'<div class="table-container" id="' + boxId + '_table_container" tabindex="0" data-kusto-no-editor-focus="true" onkeydown="handleTableKeydown(event, \'' + boxId + '\')" oncontextmenu="handleTableContextMenu(event, \'' + boxId + '\')">' +
		'<table id="' + boxId + '_table">' +
		'<thead><tr>' +
		'<th class="row-selector">#</th>' +
		columns.map((c: any, i: any) =>
			'<th data-col="' + i + '" onclick="handleHeaderSortClick(event, ' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\')">' +
			'<div class="column-header-content">' +
			'<div class="column-header-left">' +
			'<span class="column-name">' + c + '</span>' +
			'<span class="kusto-filter-link-host" id="' + boxId + '_filter_link_' + i + '"></span>' +
			'<span class="kusto-sort-indicator" id="' + boxId + '_sort_ind_' + i + '"></span>' +
			'</div>' +
			'<button class="column-menu-btn" onclick="toggleColumnMenu(' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); event.stopPropagation();">☰</button>' +
			'<div class="column-menu" id="' + boxId + '_col_menu_' + i + '">' +
			'<div class="column-menu-item" onclick="sortColumnAscending(' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); toggleColumnMenu(' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); event.stopPropagation();">Sort ascending</div>' +
			'<div class="column-menu-item" onclick="sortColumnDescending(' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); toggleColumnMenu(' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); event.stopPropagation();">Sort descending</div>' +
			'<div class="column-menu-item" onclick="openColumnFilter(event, ' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); toggleColumnMenu(' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); event.stopPropagation();">Filter...</div>' +
			'<div class="column-menu-item" onclick="showUniqueValues(' + i + ', \'' + boxId + '\')">Unique values</div>' +
			'<div class="column-menu-item" onclick="showDistinctCountPicker(' + i + ', \'' + boxId + '\')">Distinct count by column...</div>' +
			'</div>' +
			'</div>' +
			'</th>'
		).join('') +
		'</tr></thead>' +
		'<tbody></tbody>' +
		'</table>' +
		'</div>' +
		'</div>' +
		'<div class="kusto-sort-modal" id="' + boxId + '_sort_modal" onclick="closeSortDialogOnBackdrop(event, \'' + __kustoEscapeJsStringLiteral(boxId) + '\')">' +
		'<div class="kusto-sort-dialog" onclick="event.stopPropagation();">' +
		'<div class="kusto-sort-header">' +
		'<button type="button" class="kusto-sort-close" onclick="closeSortDialog(\'' + __kustoEscapeJsStringLiteral(boxId) + '\')" title="Close" aria-label="Close">' + __kustoGetTrashIconSvg(14) + '</button>' +
		'<div><strong>Sort</strong></div>' +
		'</div>' +
		'<div class="kusto-sort-body">' +
		'<div id="' + boxId + '_sort_list"></div>' +
		'</div>' +
		'</div>' +
		'</div>';

	resultsDiv.innerHTML = html;
	try { __kustoEnsureResultsSearchControls(boxId); } catch { /* ignore */ }
	// Ensure the results UI establishes a consistent scroll surface everywhere it is embedded.
	// Some hosts (e.g. URL/CSV) don't have the same wrapper DOM as query results, so we
	// apply minimal inline flex/overflow styles to make virtualization + selection reliable.
	try {
		resultsDiv.style.display = 'flex';
		resultsDiv.style.flexDirection = 'column';
		resultsDiv.style.flex = '1 1 auto';
		resultsDiv.style.minHeight = '0';
		resultsDiv.style.minWidth = '0';
		resultsDiv.style.overflow = 'hidden';
	} catch { /* ignore */ }
	try {
		const body = document.getElementById(boxId + '_results_body');
		if (body && body.style) {
			body.style.display = 'flex';
			body.style.flexDirection = 'column';
			body.style.flex = '1 1 auto';
			body.style.minHeight = '0';
			body.style.overflow = 'hidden';
		}
	} catch { /* ignore */ }
	try {
		const container = document.getElementById(boxId + '_table_container');
		if (container && container.style) {
			container.style.display = 'block';
			container.style.flex = '1 1 auto';
			container.style.minHeight = '0';
			container.style.minWidth = '0';
			container.style.maxHeight = 'none';
			container.style.overflowX = 'auto';
			container.style.overflowY = 'auto';
		}
	} catch { /* ignore */ }
	try { __kustoRerenderResultsTableBody(boxId, { reason: 'initial' }); } catch { /* ignore */ }
	// Some hosts (notably URL/CSV previews) can inject the table before the container has a
	// real height, so virtualization may bind scroll handlers to the wrong element until a
	// later rerender (e.g. on click). Do a one-time post-layout rerender to rebind.
	// Use setTimeout instead of requestAnimationFrame because RAF can be delayed or
	// skipped entirely in VS Code webview environments (background tabs, rapid layout
	// recalculations). Two nested setTimeout(0) calls approximate double-RAF timing
	// while guaranteeing execution.
	try {
		const st = __kustoGetResultsState(boxId);
		if (st && !st.__kustoPostLayoutRerenderScheduled) {
			st.__kustoPostLayoutRerenderScheduled = true;
			setTimeout(() => {
				setTimeout(() => {
					try { __kustoRerenderResultsTableBody(boxId, { reason: 'post-layout' }); } catch { /* ignore */ }
				}, 0);
			}, 0);
		}
	} catch { /* ignore */ }
	try { _win.__kustoUpdateSplitButtonState(boxId); } catch { /* ignore */ }
	try {
		if (typeof (_win.__kustoApplyResultsVisibility) === 'function') {
			(_win.__kustoApplyResultsVisibility as any)(boxId);
		}
	} catch {
		// ignore
	}
	try {
		if (typeof (_win.__kustoUpdateQueryResultsToggleButton) === 'function') {
			(_win.__kustoUpdateQueryResultsToggleButton as any)(boxId);
		}
	} catch {
		// ignore
	}
	resultsDiv.classList.add('visible');
}

function __kustoEnsureResultsSearchControls(boxId: any) {
	try {
		if (typeof (_win.__kustoCreateSearchControl as any) !== 'function') return;

		const dataHost = document.getElementById(boxId + '_data_search_host');
		if (dataHost && !document.getElementById(boxId + '_data_search')) {
			(_win.__kustoCreateSearchControl as any)(dataHost, {
				inputId: boxId + '_data_search',
				modeId: boxId + '_data_search_mode',
				ariaLabel: 'Search data',
				onInput: function () { searchData(boxId); },
				onKeyDown: function (e: any) { handleDataSearchKeydown(e, boxId); },
				onPrev: function () { previousSearchMatch(boxId); },
				onNext: function () { nextSearchMatch(boxId); }
			});
		}

		const colHost = document.getElementById(boxId + '_column_search_host');
		if (colHost && !document.getElementById(boxId + '_column_search')) {
			(_win.__kustoCreateSearchControl as any)(colHost, {
				inputId: boxId + '_column_search',
				modeId: boxId + '_column_search_mode',
				ariaLabel: 'Scroll to column',
				onInput: function () { filterColumns(boxId); },
				onKeyDown: function (e: any) { handleColumnSearchKeydown(e, boxId); }
			});
		}
	} catch { /* ignore */ }
}

function __kustoTryExtractJsonFromErrorText(raw: any) {
	const text = String(raw || '');
	const firstObj = text.indexOf('{');
	const firstArr = text.indexOf('[');
	let start = -1;
	let end = -1;
	if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) {
		start = firstObj;
		end = text.lastIndexOf('}');
	} else if (firstArr >= 0) {
		start = firstArr;
		end = text.lastIndexOf(']');
	}
	if (start < 0 || end < 0 || end <= start) {
		return null;
	}
	const candidate = text.slice(start, end + 1);
	try {
		return JSON.parse(candidate);
	} catch {
		// Best-effort: if the message contains extra trailing characters after JSON, try trimming.
		try {
			const trimmed = candidate.trim();
			return JSON.parse(trimmed);
		} catch {
			// ignore
		}
		return null;
	}
}

function __kustoExtractLinePosition(text: any) {
	const s = String(text || '');
	const m = s.match(/\[line:position\s*=\s*(\d+)\s*:\s*(\d+)\s*\]/i);
	if (!m) {
		return null;
	}
	const line = parseInt(m[1], 10);
	const col = parseInt(m[2], 10);
	if (!isFinite(line) || !isFinite(col) || line <= 0 || col <= 0) {
		return null;
	}
	return { line, col, token: `[line:position=${line}:${col}]` };
}

function __kustoNormalizeBadRequestInnerMessage(msg: any) {
	let s = String(msg || '').trim();
	// Strip boilerplate prefixes commonly returned by Kusto.
	s = s.replace(/^Request is invalid[^:]*:\s*/i, '');
	s = s.replace(/^(Semantic error:|Syntax error:)\s*/i, '');
	return s.trim();
}

function __kustoStripLinePositionTokens(text: any) {
	let s = String(text || '');
	// Remove any existing [line:position=...] tokens to avoid duplicating adjusted locations.
	s = s.replace(/\s*\[line:position\s*=\s*\d+\s*:\s*\d+\s*\]\s*/gi, ' ');
	// Normalize whitespace.
	s = s.replace(/\s{2,}/g, ' ').trim();
	return s;
}

function __kustoTryExtractAutoFindTermFromMessage(message: any) {
	try {
		const msg = String(message || '');
		if (!msg.trim()) return null;
		// Kusto common pitfall: calling notempty() with no args.
		// Example: "SEM0219: notempty(): function expects 1 argument(s)."
		// Auto-find "notempty" so users can quickly fix occurrences.
		try {
			const lower = msg.toLowerCase();
			const looksLikeSem0219 = lower.includes('sem0219');
			const looksLikeArity1 = lower.includes('function expects 1 argument');
			const mentionsNotEmpty = /\bnotempty\b/i.test(msg);
			if ((looksLikeSem0219 || looksLikeArity1) && mentionsNotEmpty) {
				return 'notempty';
			}
		} catch { /* ignore */ }
		// Specific common cases (more precise patterns first).
		let m = msg.match(/\bSEM0139\b\s*:\s*Failed\s+to\s+resolve\s+expression\s*(['"])(.*?)\1/i);
		if (!m) {
			m = msg.match(/\bSEM0260\b\s*:\s*Unknown\s+function\s*:\s*(['"])(.*?)\1/i);
		}
		// SEM0100 and similar: the useful token is often the identifier in `named 'X'`.
		if (!m) {
			m = msg.match(/\bnamed\s*(['"])(.*?)\1/i);
		}
		// Generic semantic error pattern: SEMxxxx ... 'token'
		if (!m) {
			m = msg.match(/\bSEM\d{4}\b[^\n\r]*?(['"])(.*?)\1/i);
		}
		if (m && m[2]) {
			const t = String(m[2]);
			// Avoid pathological cases (huge extracted strings).
			if (t.length > 0 && t.length <= 400) {
				return t;
			}
		}
	} catch { /* ignore */ }
	return null;
}

function __kustoBuildErrorUxModel(rawError: any) {
	const raw = (rawError === null || rawError === undefined) ? '' : String(rawError);
	if (!raw.trim()) {
		return { kind: 'none' };
	}

	const json = __kustoTryExtractJsonFromErrorText(raw);
	if (json && json.error && typeof json.error === 'object') {
		const code = String(json.error.code || '').trim();
		if (code === 'General_BadRequest') {
			const inner = (json.error.innererror && typeof json.error.innererror === 'object') ? json.error.innererror : null;
			const candidateMsg =
				(inner && (inner['@message'] || inner.message)) ||
				(json.error['@message'] || json.error.message) ||
				raw;
			const normalized = __kustoNormalizeBadRequestInnerMessage(candidateMsg);
			let loc = __kustoExtractLinePosition(candidateMsg) || __kustoExtractLinePosition(normalized) || __kustoExtractLinePosition(raw);
			if (!loc && inner) {
				try {
					const line = parseInt(inner['@line'] || inner.line || '', 10);
					const col = parseInt(inner['@pos'] || inner.pos || '', 10);
					if (isFinite(line) && isFinite(col) && line > 0 && col > 0) {
						loc = { line, col, token: `[line:position=${line}:${col}]` };
					}
				} catch { /* ignore */ }
			}
			const autoFindTerm = __kustoTryExtractAutoFindTermFromMessage(String(normalized || candidateMsg || ''));
			return { kind: 'badrequest', message: normalized || raw, location: loc || null, autoFindTerm };
		}

		try {
			return { kind: 'json', pretty: JSON.stringify(json, null, 2) };
		} catch {
			// fall through
		}
	}

	// Not JSON (or unparseable): display as wrapped text.
	return {
		kind: 'text',
		text: raw,
		autoFindTerm: __kustoTryExtractAutoFindTermFromMessage(raw)
	};
}

function __kustoMaybeAdjustLocationForCacheLine(boxId: any, location: any) {
	if (!location || typeof location !== 'object') {
		return location;
	}
	const bid = String(boxId || '').trim();
	if (!bid) {
		return location;
	}
	let cacheEnabled = false;
	try {
		cacheEnabled = !!((_win.__kustoLastRunCacheEnabledByBoxId as any) && (_win.__kustoLastRunCacheEnabledByBoxId as any)[bid]);
	} catch {
		cacheEnabled = false;
	}
	if (!cacheEnabled) {
		return location;
	}
	const line = parseInt(String(location.line || ''), 10);
	const col = parseInt(String(location.col || ''), 10);
	if (!isFinite(line) || line <= 0) {
		return location;
	}
	const nextLine = Math.max(1, line - 1);
	return {
		...location,
		line: nextLine,
		col: isFinite(col) && col > 0 ? col : location.col,
		token: `[line:position=${nextLine}:${isFinite(col) && col > 0 ? col : (location.col || 1)}]`
	};
}

function __kustoEscapeForHtml(s: any) {
	return (typeof (_win.escapeHtml) === 'function') ? (_win.escapeHtml as any)(String(s || '')) : String(s || '');
}

function __kustoEscapeJsStringLiteral(s: any) {
	return String(s || '')
		.replace(/\\/g, '\\\\')
		.replace(/'/g, "\\'")
		.replace(/"/g, '\\"');
}

function __kustoEscapeForHtmlAttribute(s: any) {
	// Attribute-safe escaping (quotes included).
	return __kustoEscapeForHtml(s)
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function __kustoRenderActivityIdInlineHtml(boxId: any, clientActivityId: any) {
	if (!clientActivityId || typeof clientActivityId !== 'string') {
		return '';
	}
	const bid = String(boxId || '');
	const copyIconSvg = __kustoGetCopyIconSvg();
	return (
		'<div class="kusto-error-activity-id">' +
		'<span class="kusto-error-activity-id-label">Client Activity ID:</span> ' +
		'<span class="kusto-error-activity-id-value" id="' + bid + '_client_activity_id">' + __kustoEscapeForHtml(clientActivityId) + '</span>' +
		'<button class="results-label-tooltip-copy" type="button" onclick="event.stopPropagation(); __kustoCopyClientActivityId(\'' + __kustoEscapeJsStringLiteral(bid) + '\')" title="Copy to clipboard" aria-label="Copy Client Activity ID">' +
		copyIconSvg +
		'</button>' +
		'</div>'
	);
}

function __kustoRenderErrorUxHtml(boxId: any, model: any, clientActivityId: any) {
	if (!model || model.kind === 'none') {
		return '';
	}
	const bid = String(boxId || '');
	const activityIdHtml = __kustoRenderActivityIdInlineHtml(bid, clientActivityId);
	if (model.kind === 'badrequest') {
		const msgEsc = __kustoEscapeForHtml(model.message);
		let locHtml = '';
		if (model.location && model.location.line && model.location.col) {
			const line = model.location.line;
			const col = model.location.col;
			const tokenEsc = __kustoEscapeForHtml(`Line ${line}, Col ${col}`);
			locHtml =
				' <a href="#" class="kusto-error-location"' +
				' data-boxid="' + __kustoEscapeForHtmlAttribute(bid) + '"' +
				' data-line="' + String(line) + '"' +
				' data-col="' + String(col) + '"' +
				' title="Go to line ' + String(line) + ', column ' + String(col) + '">' +
				tokenEsc +
				'</a>';
		}
		return (
			'<div class="results-header kusto-error-ux" style="color: var(--vscode-errorForeground);">' +
			'<div><strong>' + msgEsc + '</strong>' + locHtml + '</div>' +
			activityIdHtml +
			'</div>'
		);
	}
	if (model.kind === 'json') {
		const pre = __kustoEscapeForHtml(model.pretty);
		return (
			'<div class="results-header kusto-error-ux" style="color: var(--vscode-errorForeground);">' +
			'<pre style="margin:0; white-space:pre-wrap; word-break:break-word; font-family: var(--vscode-editor-font-family);">' +
			pre +
			'</pre>' +
			activityIdHtml +
			'</div>'
		);
	}
	// text
	const lines = String(model.text || '').split(/\r?\n/).map(__kustoEscapeForHtml).join('<br>');
	return (
		'<div class="results-header kusto-error-ux" style="color: var(--vscode-errorForeground);">' +
		lines +
		activityIdHtml +
		'</div>'
	);
}

// Centralized error UX renderer (hidden when no error).
try {
	(window as any).__kustoRenderErrorUx = function (boxId: any, error: any, clientActivityId: any) {
		const bid = String(boxId || '').trim();
		if (!bid) return;
		try { __kustoEnsureResultsShownForTool(bid); } catch { /* ignore */ }
		const resultsDiv = document.getElementById(bid + '_results');
		if (!resultsDiv) return;
		const model = __kustoBuildErrorUxModel(error);
		try {
			if (model && model.location) {
				model.location = __kustoMaybeAdjustLocationForCacheLine(bid, model.location);
			}
		} catch { /* ignore */ }
		try {
			if (model && model.kind === 'badrequest' && model.location && model.message) {
				model.message = __kustoStripLinePositionTokens(model.message);
			}
		} catch { /* ignore */ }
		if (!model || model.kind === 'none') {
			resultsDiv.innerHTML = '';
			try {
				if (resultsDiv.classList) {
					resultsDiv.classList.remove('visible');
				}
			} catch { /* ignore */ }
			try {
				if (typeof (_win.__kustoApplyResultsVisibility) === 'function') {
					(_win.__kustoApplyResultsVisibility as any)(bid);
				}
			} catch { /* ignore */ }
			return;
		}
		const html = __kustoRenderErrorUxHtml(bid, model, clientActivityId);
		resultsDiv.innerHTML = html;
		resultsDiv.classList.add('visible');
		try {
			if (typeof (_win.__kustoApplyResultsVisibility) === 'function') {
				(_win.__kustoApplyResultsVisibility as any)(bid);
			}
		} catch { /* ignore */ }
		try {
			if (typeof (_win.__kustoClampResultsWrapperHeight as any) === 'function') {
				(_win.__kustoClampResultsWrapperHeight as any)(bid);
			}
		} catch { /* ignore */ }
		// Special UX: on SEM0139, auto-find the unresolved expression in the query editor.
		try {
			if (model && model.autoFindTerm && typeof (_win.__kustoAutoFindInQueryEditor as any) === 'function') {
				setTimeout(() => {
					try { (_win.__kustoAutoFindInQueryEditor as any)(bid, String(model.autoFindTerm)); } catch { /* ignore */ }
				}, 0);
			}
		} catch { /* ignore */ }
	};
} catch {
	// ignore
}

// Navigate to a line/column in the query editor and scroll it into view.
try {
	(window as any).__kustoNavigateToQueryLocation = function (event: any, boxId: any, line: any, col: any) {
		try {
			if (event && typeof event.preventDefault === 'function') {
				event.preventDefault();
			}
			if (event && typeof event.stopPropagation === 'function') {
				event.stopPropagation();
			}
		} catch { /* ignore */ }
		const bid = String(boxId || '').trim();
		const ln = parseInt(String(line), 10);
		const cn = parseInt(String(col), 10);
		if (!bid || !isFinite(ln) || !isFinite(cn) || ln <= 0 || cn <= 0) {
			return;
		}
		try {
			const boxEl = document.getElementById(bid);
			if (boxEl && typeof boxEl.scrollIntoView === 'function') {
				boxEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
			}
		} catch { /* ignore */ }
		try {
			const editor = (typeof (_win.queryEditors as any) !== 'undefined' && (_win.queryEditors as any)) ? (_win.queryEditors as any)[bid] : null;
			if (!editor) return;
			const pos = { lineNumber: ln, column: cn };
			try { editor.focus(); } catch { /* ignore */ }
			try { if (typeof editor.setPosition === 'function') editor.setPosition(pos); } catch { /* ignore */ }
			try { if (typeof editor.revealPositionInCenter === 'function') editor.revealPositionInCenter(pos); } catch { /* ignore */ }
			try {
				if (typeof editor.setSelection === 'function') {
					editor.setSelection({ startLineNumber: ln, startColumn: cn, endLineNumber: ln, endColumn: cn });
				}
			} catch { /* ignore */ }
		} catch {
			// ignore
		}
	};
} catch {
	// ignore
}

// Delegated click handler for clickable error locations.
try {
	if (!(_win.__kustoErrorLocationClickHandlerInstalled as any)) {
		(_win.__kustoErrorLocationClickHandlerInstalled as any) = true;
		document.addEventListener('click', (event) => {
			try {
				const target = event && event.target ? event.target : null;
				if (!target || typeof (target as any).closest !== 'function') {
					return;
				}
				const link = (target as any).closest('a.kusto-error-location');
				if (!link) {
					return;
				}
				const boxId = String(link.getAttribute('data-boxid') || '').trim();
				const line = parseInt(String(link.getAttribute('data-line') || ''), 10);
				const col = parseInt(String(link.getAttribute('data-col') || ''), 10);
				if (!boxId || !isFinite(line) || !isFinite(col)) {
					return;
				}
				if (typeof (_win.__kustoNavigateToQueryLocation as any) === 'function') {
					(_win.__kustoNavigateToQueryLocation as any)(event, boxId, line, col);
					return;
				}
			} catch {
				// ignore
			}
		}, true);
	}
} catch {
	// ignore
}

function displayError(error: any) {
	const boxId = (_win.lastExecutedBox as any);
	if (!boxId) { return; }

	(_win.setQueryExecuting as any)(boxId, false);

	try {
		if (typeof (_win.__kustoRenderErrorUx as any) === 'function') {
			(_win.__kustoRenderErrorUx as any)(boxId, error);
			return;
		}
	} catch { /* ignore */ }
	const resultsDiv = document.getElementById(boxId + '_results');
	if (!resultsDiv) { return; }
	const raw = (error === null || error === undefined) ? '' : String(error);
	const esc = raw.split(/\r?\n/).map(__kustoEscapeForHtml).join('<br>');
	resultsDiv.innerHTML = '<div class="results-header" style="color: var(--vscode-errorForeground);">' + esc + '</div>';
	resultsDiv.classList.add('visible');
}

// Display a non-query error message in a specific box's results area.
// Used for auxiliary actions like refreshing databases.
try {
	(window as any).__kustoDisplayBoxError = function (boxId: any, error: any) {
		const bid = String(boxId || '').trim();
		if (!bid) return;
		try {
			if (typeof (_win.__kustoRenderErrorUx as any) === 'function') {
				(_win.__kustoRenderErrorUx as any)(bid, error);
				return;
			}
		} catch { /* ignore */ }
		try { __kustoEnsureResultsShownForTool(bid); } catch { /* ignore */ }
		const resultsDiv = document.getElementById(bid + '_results');
		if (!resultsDiv) return;
		const raw = (error === null || error === undefined) ? '' : String(error);
		const esc = raw.split(/\r?\n/).map(__kustoEscapeForHtml).join('<br>');
		resultsDiv.innerHTML = '<div class="results-header" style="color: var(--vscode-errorForeground);">' + esc + '</div>';
		resultsDiv.classList.add('visible');
	};
} catch {
	// ignore
}

function displayCancelled() {
	const boxId = (_win.lastExecutedBox as any);
	if (!boxId) { return; }

	(_win.setQueryExecuting as any)(boxId, false);

	const resultsDiv = document.getElementById(boxId + '_results');
	if (!resultsDiv) { return; }

	resultsDiv.innerHTML =
		'<div class="results-header">' +
		'<strong>Cancelled.</strong>' +
		'</div>';
	resultsDiv.classList.add('visible');
}

function __kustoClampInt(value: any, min: any, max: any) {
	const n = parseInt(String(value), 10);
	if (!isFinite(n)) return min;
	if (n < min) return min;
	if (n > max) return max;
	return n;
}

function __kustoTryGetDomEventFromInlineHandler(explicitEvent: any) {
	try {
		if (explicitEvent && typeof explicitEvent === 'object') {
			return explicitEvent;
		}
	} catch { /* ignore */ }
	try {
		// In inline handlers, many browsers expose a global `event`.
		if (typeof window !== 'undefined' && window && window.event) {
			return window.event;
		}
	} catch { /* ignore */ }
	return null;
}

function __kustoSetCellSelectionState(boxId: any, state: any, nextRow: any, nextCol: any, options: any) {
	if (!state) return;
	try { __kustoEnsureDisplayRowIndexMaps(state); } catch { /* ignore */ }

	const rows = Array.isArray(state.rows) ? state.rows : [];
	const cols = Array.isArray(state.columns) ? state.columns : [];
	const maxRow = Math.max(0, rows.length - 1);
	const maxCol = Math.max(0, cols.length - 1);
	const row = __kustoClampInt(nextRow, 0, maxRow);
	const col = __kustoClampInt(nextCol, 0, maxCol);

	const extend = !!(options && options.extend);
	let anchor = state.cellSelectionAnchor;
	if (!extend || !anchor) {
		anchor = { row, col };
	}
	state.cellSelectionAnchor = anchor;
	state.selectedCell = { row, col };

	const disp = Array.isArray(state.displayRowIndices) ? state.displayRowIndices : null;
	const inv = Array.isArray(state.rowIndexToDisplayIndex) ? state.rowIndexToDisplayIndex : null;
	const aDisplay = (inv && isFinite(inv[anchor.row])) ? inv[anchor.row] : anchor.row;
	const fDisplay = (inv && isFinite(inv[row])) ? inv[row] : row;

	state.cellSelectionRange = {
		displayRowMin: Math.min(aDisplay, fDisplay),
		displayRowMax: Math.max(aDisplay, fDisplay),
		colMin: Math.min(anchor.col, col),
		colMax: Math.max(anchor.col, col)
	};

	// Clearing row-selection avoids ambiguity about what Ctrl+C will copy.
	try { if (state.selectedRows && state.selectedRows.size > 0) state.selectedRows.clear(); } catch { /* ignore */ }
	try { __kustoBumpVisualVersion(state); } catch { /* ignore */ }
}

function selectCell(a: any, b: any, c: any, d: any) {
	// Backward-compatible signature:
	// - selectCell(row, col, boxId)
	// - selectCell(event, row, col, boxId)
	const hasEventSignature = (arguments.length >= 4);
	const ev = __kustoTryGetDomEventFromInlineHandler(hasEventSignature ? a : null);
	const row = hasEventSignature ? b : a;
	const col = hasEventSignature ? c : b;
	const boxId = hasEventSignature ? d : c;

	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }

	// Record that results were interacted with (used by global Ctrl+C handler).
	try {
		(_win.__kustoLastActiveResultsBoxId as any) = boxId;
		(_win.__kustoLastActiveResultsInteractionAt as any) = Date.now();
	} catch { /* ignore */ }

	// NOTE: Native `dblclick` doesn't reliably fire because a single click triggers a full
	// re-render of the results table, replacing the clicked <td>. Detect a rapid second click
	// on the same cell and treat it as a "double click".
	let isSyntheticDoubleClick = false;
	try {
		const isClickEvent = !!(ev && (ev.type === 'click' || ev.type === 'mousedown' || ev.type === 'pointerdown'));
		if (isClickEvent) {
			const now = Date.now();
			const last = state.__kustoLastCellClick;
			const sameCell = !!(last && last.row === row && last.col === col);
			const withinWindow = !!(last && isFinite(last.t) && (now - last.t) <= 400);
			if (sameCell && withinWindow && !(ev && ev.shiftKey)) {
				isSyntheticDoubleClick = true;
			}
			state.__kustoLastCellClick = { row, col, t: now };
		}
	} catch { /* ignore */ }

	// If clicking on an already selected single cell (not extending with shift), deselect it.
	// Check if the clicked cell is the current focus cell and is the only cell selected.
	const isClickedCellFocused = state.selectedCell &&
		state.selectedCell.row === row &&
		state.selectedCell.col === col;
	const isSingleCellRange = state.cellSelectionRange &&
		state.cellSelectionRange.colMin === state.cellSelectionRange.colMax &&
		state.cellSelectionAnchor &&
		state.cellSelectionAnchor.row === row &&
		state.cellSelectionAnchor.col === col;

	if (isClickedCellFocused && isSingleCellRange && !(ev && ev.shiftKey)) {
		// If this is a rapid second click, open the cell viewer instead of toggling selection off.
		if (isSyntheticDoubleClick) {
			try {
				if (typeof (_win.openCellViewer) === 'function') {
					(_win.openCellViewer as any)(row, col, boxId);
				}
			} catch { /* ignore */ }
			return;
		}

		// Otherwise, clear all cell selection.
		state.selectedCell = null;
		state.cellSelectionAnchor = null;
		state.cellSelectionRange = null;
		try { __kustoBumpVisualVersion(state); } catch { /* ignore */ }
		try { __kustoRerenderResultsTable(boxId); } catch { /* ignore */ }
		return;
	}

	__kustoSetCellSelectionState(boxId, state, row, col, {
		extend: !!(ev && ev.shiftKey)
	});

	try { __kustoRerenderResultsTable(boxId); } catch { /* ignore */ }

	// If this was a synthetic double click, open the cell viewer after selection.
	if (isSyntheticDoubleClick) {
		try {
			if (typeof (_win.openCellViewer) === 'function') {
				(_win.openCellViewer as any)(row, col, boxId);
			}
		} catch { /* ignore */ }
		return;
	}

	// Scroll focus cell into view
	try {
		const cellEl = document.querySelector('#' + boxId + '_table td[data-row="' + state.selectedCell.row + '"][data-col="' + state.selectedCell.col + '"]') as any;
		if (cellEl) {
			cellEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
		}
	} catch { /* ignore */ }

	// Focus the container for keyboard navigation
	try {
		const container = document.getElementById(boxId + '_table_container');
		if (container) {
			__kustoFocusTableContainer(container, boxId);
		}
	} catch { /* ignore */ }
}

function toggleRowSelection(row: any, boxId: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }

	// Record that results were interacted with (used by global Ctrl+C handler).
	try {
		(_win.__kustoLastActiveResultsBoxId as any) = boxId;
		(_win.__kustoLastActiveResultsInteractionAt as any) = Date.now();
	} catch { /* ignore */ }

	// Try to get the event for shift-key detection.
	const ev = __kustoTryGetDomEventFromInlineHandler(null);
	const isShift = !!(ev && ev.shiftKey);

	try { __kustoEnsureDisplayRowIndexMaps(state); } catch { /* ignore */ }

	// SHIFT+click: select range from last selected row (anchor) to clicked row.
	if (isShift && state.rowSelectionAnchor !== undefined && state.rowSelectionAnchor !== null) {
		const anchor = state.rowSelectionAnchor;
		const minRow = Math.min(anchor, row);
		const maxRow = Math.max(anchor, row);
		// Add all rows in range to selection.
		for (let r = minRow; r <= maxRow; r++) {
			state.selectedRows.add(r);
		}
	} else {
		// Normal click: toggle single row.
		if (state.selectedRows.has(row)) {
			state.selectedRows.delete(row);
		} else {
			state.selectedRows.add(row);
			// Set anchor for future shift-click range selection.
			state.rowSelectionAnchor = row;
		}
	}

	// Clear cell selection when row selection changes to avoid ambiguity.
	try {
		state.selectedCell = null;
		state.cellSelectionAnchor = null;
		state.cellSelectionRange = null;
		__kustoBumpVisualVersion(state);
		__kustoRerenderResultsTable(boxId);
	} catch { /* ignore */ }

	// Focus the container for keyboard navigation (including Ctrl+C).
	try {
		const container = document.getElementById(boxId + '_table_container');
		if (container) {
			__kustoFocusTableContainer(container, boxId);
		}
	} catch { /* ignore */ }
}

// ============================================
// Responsive Results Tools Dropdown
// ============================================

/**
 * Update the active/toggle state of dropdown items based on current tool state.
 */
function __kustoUpdateResultsToolsDropdownState(boxId: any) {
	try {
		const searchContainer = document.getElementById(boxId + '_data_search_container');
		const columnContainer = document.getElementById(boxId + '_column_search_container');
		const sortModal = document.getElementById(boxId + '_sort_modal');
		const resultsBody = document.getElementById(boxId + '_results_body');

		const searchActive = searchContainer && searchContainer.style.display !== 'none';
		const columnActive = columnContainer && columnContainer.style.display !== 'none';
		const sortActive = sortModal && sortModal.style.display === 'flex';
		const resultsHidden = resultsBody && resultsBody.style.display === 'none';

		const searchItem = document.getElementById(boxId + '_tools_dd_search');
		const columnItem = document.getElementById(boxId + '_tools_dd_column');
		const sortItem = document.getElementById(boxId + '_tools_dd_sort');
		const visibilityLabel = document.getElementById(boxId + '_tools_dd_visibility_label');

		if (searchItem) searchItem.classList.toggle('is-active', !!searchActive);
		if (columnItem) columnItem.classList.toggle('is-active', !!columnActive);
		if (sortItem) sortItem.classList.toggle('is-active', !!sortActive);
		if (visibilityLabel) visibilityLabel.textContent = resultsHidden ? 'Show results' : 'Hide results';
	} catch { /* ignore */ }
}

/**
 * Handle action from the Tools dropdown menu.
 * Closes the dropdown and executes the action.
 */
function __kustoResultsToolsDropdownAction(boxId: any, action: any) {
	// Close the dropdown immediately
	__kustoCloseResultsToolsDropdown(boxId);

	// Execute the action
	switch (action) {
		case 'visibility':
			(_win.toggleQueryResultsVisibility as any)(boxId);
			break;
		case 'search':
			toggleSearchTool(boxId);
			break;
		case 'column':
			toggleColumnTool(boxId);
			break;
		case 'sort':
			toggleSortDialog(boxId);
			break;
		case 'save':
			_win.__kustoOnSavePrimary(boxId, 'Results');
			break;
		case 'copy':
			_win.__kustoOnCopyPrimary(boxId);
			break;
	}
}

/**
 * Toggle the collapsed Tools dropdown menu for the results header.
 * This menu is shown when the container is too narrow to display individual tool buttons.
 */
function __kustoToggleResultsToolsDropdown(boxId: any) {
	const btn = document.getElementById(boxId + '_results_tools_dropdown_btn');
	const menu = document.getElementById(boxId + '_results_tools_dropdown_menu');
	if (!btn || !menu) return;

	const isOpen = menu.classList.contains('is-open');

	// Close all other results tools dropdowns first
	try {
		document.querySelectorAll('.results-tools-dropdown-menu.is-open').forEach(m => {
			if (m !== menu) {
				m.classList.remove('is-open');
				const otherId = m.id.replace('_results_tools_dropdown_menu', '');
				const otherBtn = document.getElementById(otherId + '_results_tools_dropdown_btn');
				if (otherBtn) otherBtn.setAttribute('aria-expanded', 'false');
			}
		});
	} catch { /* ignore */ }

	if (isOpen) {
		// Close the menu
		menu.classList.remove('is-open');
		btn.setAttribute('aria-expanded', 'false');
	} else {
		// Open the menu and position it below the button
		menu.classList.add('is-open');
		btn.setAttribute('aria-expanded', 'true');

		// Update active states before showing
		__kustoUpdateResultsToolsDropdownState(boxId);

		// Check if container is ultra-narrow (< 150px) to show visibility toggle in menu
		try {
			const header = btn.closest('.results-header');
			if (header) {
				const headerWidth = header.getBoundingClientRect().width;
				menu.classList.toggle('show-visibility-item', headerWidth < 150);
			}
		} catch { /* ignore */ }

		// Position the menu using fixed positioning
		try {
			const rect = btn.getBoundingClientRect();
			menu.style.top = (rect.bottom + 2) + 'px';
			// Align to the right edge of the button
			const menuWidth = menu.offsetWidth || 150;
			menu.style.left = Math.max(0, rect.right - menuWidth) + 'px';
		} catch { /* ignore */ }
	}
}

/**
 * Close the collapsed Tools dropdown menu.
 */
function __kustoCloseResultsToolsDropdown(boxId: any) {
	const btn = document.getElementById(boxId + '_results_tools_dropdown_btn');
	const menu = document.getElementById(boxId + '_results_tools_dropdown_menu');
	if (menu) menu.classList.remove('is-open');
	if (btn) btn.setAttribute('aria-expanded', 'false');
}

/**
 * Close all results tools dropdowns (global).
 */
function __kustoCloseAllResultsToolsDropdowns() {
	try {
		document.querySelectorAll('.results-tools-dropdown-menu.is-open').forEach(m => {
			m.classList.remove('is-open');
		});
		document.querySelectorAll('.results-tools-dropdown-btn[aria-expanded="true"]').forEach(btn => {
			btn.setAttribute('aria-expanded', 'false');
		});
	} catch { /* ignore */ }
}

// Close results tools dropdown when clicking outside
document.addEventListener('click', function (e: any) {
	try {
		if (!(e.target as HTMLElement).closest('.results-tools-dropdown')) {
			__kustoCloseAllResultsToolsDropdowns();
		}
	} catch { /* ignore */ }
});

// ============================================

function toggleSearchTool(boxId: any) {
	__kustoEnsureResultsShownForTool(boxId);
	const container = document.getElementById(boxId + '_data_search_container');
	const button = (window as any).event && (window as any).event.target && (window as any).event.target.closest('.tool-toggle-btn');

	if (container!.style.display === 'none') {
		// Close the other tool first
		const columnContainer = document.getElementById(boxId + '_column_search_container');
		if (columnContainer) {
			columnContainer.style.display = 'none';
		}
		// Remove active state from all buttons
		document.querySelectorAll('.tool-toggle-btn').forEach(btn => btn.classList.remove('active'));

		// Show this tool
		container!.style.display = 'flex';
		button.classList.add('active');

		// Focus the input
		const input = document.getElementById(boxId + '_data_search');
		if (input) {
			setTimeout(() => input.focus(), 0);
		}
	} else {
		// Hide this tool
		container!.style.display = 'none';
		button.classList.remove('active');
	}
}

function toggleColumnTool(boxId: any) {
	__kustoEnsureResultsShownForTool(boxId);
	const body = document.getElementById(boxId + '_results_body');
	// If results were hidden, the body may still be display:none for a tick.
	try {
		if (body && body.style && body.style.display === 'none') {
			body.style.display = '';
		}
	} catch { /* ignore */ }
	const container = document.getElementById(boxId + '_column_search_container');
	const button = (window as any).event && (window as any).event.target && (window as any).event.target.closest('.tool-toggle-btn');

	if (container!.style.display === 'none') {
		// Close the other tool first
		const searchContainer = document.getElementById(boxId + '_data_search_container');
		if (searchContainer) {
			searchContainer.style.display = 'none';
		}
		// Remove active state from all buttons
		document.querySelectorAll('.tool-toggle-btn').forEach(btn => btn.classList.remove('active'));

		// Show this tool
		container!.style.display = 'block';
		button.classList.add('active');

		// Focus the input
		const input = document.getElementById(boxId + '_column_search');
		if (input) {
			setTimeout(() => input.focus(), 0);
		}
	} else {
		// Hide this tool
		container!.style.display = 'none';
		button.classList.remove('active');
	}
}

function searchData(boxId: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }

	let query = '';
	let mode = 'wildcard';
	let built: any = { regex: null, error: null };
	try {
		if (typeof (_win.__kustoGetSearchControlState as any) === 'function' && typeof (_win.__kustoTryBuildSearchRegex as any) === 'function') {
			const st = (_win.__kustoGetSearchControlState as any)(boxId + '_data_search', boxId + '_data_search_mode');
			query = String((st && st.query) ? st.query : '');
			mode = st && st.mode ? st.mode : 'wildcard';
			built = (_win.__kustoTryBuildSearchRegex as any)(query, mode);
		} else {
			const searchInput = document.getElementById(boxId + '_data_search');
			query = searchInput ? String((searchInput as any).value || '') : '';
			mode = 'wildcard';
			built = { regex: query ? new RegExp((_win.escapeRegex as any)(String(query).trim()), 'gi') : null, error: null };
		}
	} catch { /* ignore */ }
	const regex = built && built.regex ? built.regex : null;
	// Use embedded status and nav elements from search control.
	const statusEl = document.getElementById(boxId + '_data_search_status');
	const prevBtn = document.getElementById(boxId + '_data_search_prev');
	const nextBtn = document.getElementById(boxId + '_data_search_next');

	// Clear previous search highlights
	document.querySelectorAll('#' + boxId + '_table td.search-match, #' + boxId + '_table td.search-match-current')
		.forEach(cell => {
			cell.classList.remove('search-match', 'search-match-current');
		});

	state.searchMatches = [];
	state.currentSearchIndex = -1;
	try { __kustoBumpVisualVersion(state); } catch { /* ignore */ }

	if (!String(query || '').trim()) {
		if (typeof (_win.__kustoUpdateSearchStatus) === 'function') {
			(_win.__kustoUpdateSearchStatus as any)(statusEl, 0, 0, false, '');
		}
		if (typeof (_win.__kustoSetSearchNavEnabled) === 'function') {
			(_win.__kustoSetSearchNavEnabled as any)(prevBtn, nextBtn, false, 0);
		}
		return;
	}

	if (built && built.error) {
		if (typeof (_win.__kustoUpdateSearchStatus) === 'function') {
			(_win.__kustoUpdateSearchStatus as any)(statusEl, 0, 0, true, built.error);
		}
		if (typeof (_win.__kustoSetSearchNavEnabled) === 'function') {
			(_win.__kustoSetSearchNavEnabled as any)(prevBtn, nextBtn, false, 0);
		}
		return;
	}

	// Search through visible rows (respects current sort/filter)
	const rows = Array.isArray(state.rows) ? state.rows : [];
	const displayRowIndices = Array.isArray(state.displayRowIndices) ? state.displayRowIndices : rows.map((_: any, i: any) => i);
	displayRowIndices.forEach((rowIdx: any) => {
		const row = rows[rowIdx] || [];
		row.forEach((cell: any, colIdx: any) => {
			let cellText = '';

			// Extract searchable text from cell
			if (typeof cell === 'object' && cell !== null) {
				// If it's a formatted cell object, search in both display and full values
				if ('display' in cell) {
					cellText = cell.display + ' ' + (cell.full || '');
				} else {
					cellText = JSON.stringify(cell);
				}
			} else {
				cellText = String(cell);
			}

			// Check if search term is in cell text
			if (regex && typeof (_win.__kustoRegexTest as any) === 'function' ? (_win.__kustoRegexTest as any)(regex, cellText) : cellText.toLowerCase().includes(String(query).toLowerCase())) {
				state.searchMatches.push({ row: rowIdx, col: colIdx });
			}
		});
	});

	// Update UI
	const matchCount = state.searchMatches.length;
	if (matchCount > 0) {
		// Jump to first match
		state.currentSearchIndex = 0;
		try { __kustoBumpVisualVersion(state); } catch { /* ignore */ }
		if (typeof (_win.__kustoUpdateSearchStatus) === 'function') {
			(_win.__kustoUpdateSearchStatus as any)(statusEl, matchCount, 0, false, '');
		}
		if (typeof (_win.__kustoSetSearchNavEnabled) === 'function') {
			(_win.__kustoSetSearchNavEnabled as any)(prevBtn, nextBtn, true, matchCount);
		}
		highlightCurrentSearchMatch(boxId);
	} else {
		if (typeof (_win.__kustoUpdateSearchStatus) === 'function') {
			(_win.__kustoUpdateSearchStatus as any)(statusEl, 0, 0, false, '');
		}
		if (typeof (_win.__kustoSetSearchNavEnabled) === 'function') {
			(_win.__kustoSetSearchNavEnabled as any)(prevBtn, nextBtn, false, 0);
		}
	}
}

function nextSearchMatch(boxId: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }

	const matches = state.searchMatches;
	if (matches.length === 0) { return; }

	state.currentSearchIndex = (state.currentSearchIndex + 1) % matches.length;
	try { __kustoBumpVisualVersion(state); } catch { /* ignore */ }
	highlightCurrentSearchMatch(boxId);
}

function previousSearchMatch(boxId: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }

	const matches = state.searchMatches;
	if (matches.length === 0) { return; }

	state.currentSearchIndex = (state.currentSearchIndex - 1 + matches.length) % matches.length;
	try { __kustoBumpVisualVersion(state); } catch { /* ignore */ }
	highlightCurrentSearchMatch(boxId);
}

function highlightCurrentSearchMatch(boxId: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }

	const matches = state.searchMatches;
	const currentIndex = state.currentSearchIndex;

	if (currentIndex < 0 || currentIndex >= matches.length) { return; }

	// Re-render so virtualization can materialize the current match row/cell.
	try { __kustoRerenderResultsTable(boxId); } catch { /* ignore */ }

	const match = matches[currentIndex];
	const cell = document.querySelector('#' + boxId + '_table td[data-row="' + match.row + '"][data-col="' + match.col + '"]') as any;
	if (cell) {
		cell.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
	}

	// Update status text using embedded status element.
	const statusEl = document.getElementById(boxId + '_data_search_status');
	if (typeof (_win.__kustoUpdateSearchStatus) === 'function') {
		(_win.__kustoUpdateSearchStatus as any)(statusEl, matches.length, currentIndex, false, '');
	}
}

function handleDataSearchKeydown(event: any, boxId: any) {
	if (event.key === 'Enter') {
		event.preventDefault();
		if (event.shiftKey) {
			previousSearchMatch(boxId);
		} else {
			nextSearchMatch(boxId);
		}
	}
}

function handleTableKeydown(event: any, boxId: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }

	// Handle copy to clipboard (Ctrl+C or Cmd+C)
	if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
		event.preventDefault();
		_win.copySelectionToClipboard(boxId);
		return;
	}

	const cell = state.selectedCell;
	if (!cell) {
		// If no cell selected, select first cell
		if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
			event.preventDefault();
			// First displayed row (respects current sort)
			const disp = Array.isArray(state.displayRowIndices) ? state.displayRowIndices : null;
			const firstRow = (disp && disp.length > 0) ? disp[0] : 0;
			selectCell(event, firstRow, 0, boxId);
		}
		return;
	}

	let newRow = cell.row;
	let newCol = cell.col;
	const rows = Array.isArray(state.rows) ? state.rows : [];
	const disp = Array.isArray(state.displayRowIndices) ? state.displayRowIndices : null;
	const inv = Array.isArray(state.rowIndexToDisplayIndex) ? state.rowIndexToDisplayIndex : null;
	const currentDisplayRow = (disp && inv && isFinite(inv[cell.row])) ? inv[cell.row] : cell.row;
	const maxDisplayRow = (disp && disp.length > 0) ? (disp.length - 1) : (rows.length - 1);
	const maxCol = state.columns.length - 1;

	switch (event.key) {
		case 'ArrowRight':
			if (newCol < maxCol) {
				newCol++;
				event.preventDefault();
			}
			break;
		case 'ArrowLeft':
			if (newCol > 0) {
				newCol--;
				event.preventDefault();
			}
			break;
		case 'ArrowDown':
				if (currentDisplayRow < maxDisplayRow) {
					const nextDisplay = currentDisplayRow + 1;
					newRow = (disp && disp.length > 0) ? disp[nextDisplay] : (cell.row + 1);
				event.preventDefault();
			}
			break;
		case 'ArrowUp':
				if (currentDisplayRow > 0) {
					const prevDisplay = currentDisplayRow - 1;
					newRow = (disp && disp.length > 0) ? disp[prevDisplay] : (cell.row - 1);
				event.preventDefault();
			}
			break;
		case 'Home':
			if (event.ctrlKey) {
					newRow = (disp && disp.length > 0) ? disp[0] : 0;
				newCol = 0;
			} else {
				newCol = 0;
			}
			event.preventDefault();
			break;
		case 'End':
			if (event.ctrlKey) {
					newRow = (disp && disp.length > 0) ? disp[maxDisplayRow] : maxDisplayRow;
				newCol = maxCol;
			} else {
				newCol = maxCol;
			}
			event.preventDefault();
			break;
		default:
			return;
	}

	if (newRow !== cell.row || newCol !== cell.col) {
		selectCell(event, newRow, newCol, boxId);
	}
}

function filterColumns(boxId: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }

	const input = document.getElementById(boxId + '_column_search');
	const autocomplete = document.getElementById(boxId + '_column_autocomplete');
	if (!input || !autocomplete) { return; }

	let query = '';
	let mode = 'wildcard';
	let built: any = { regex: null, error: null };
	try {
		if (typeof (_win.__kustoGetSearchControlState as any) === 'function' && typeof (_win.__kustoTryBuildSearchRegex as any) === 'function') {
			const st = (_win.__kustoGetSearchControlState as any)(boxId + '_column_search', boxId + '_column_search_mode');
			query = String((st && st.query) ? st.query : '');
			mode = st && st.mode ? st.mode : 'wildcard';
			built = (_win.__kustoTryBuildSearchRegex as any)(query, mode);
		} else {
			query = String((input as any).value || '');
			built = { regex: query ? new RegExp((_win.escapeRegex as any)(String(query).trim()), 'gi') : null, error: null };
		}
	} catch { /* ignore */ }
	const regex = built && built.regex ? built.regex : null;

	if (!String(query || '').trim()) {
		autocomplete.classList.remove('visible');
		return;
	}
	if (built && built.error) {
		autocomplete.classList.remove('visible');
		return;
	}

	const matches = state.columns
		.map((col: any, idx: any) => ({ name: col, index: idx }))
		.filter((col: any) => regex ? (typeof (_win.__kustoRegexTest as any) === 'function' ? (_win.__kustoRegexTest as any)(regex, col.name) : col.name.toLowerCase().includes(String(query).toLowerCase())) : false);

	if (matches.length === 0) {
		autocomplete.classList.remove('visible');
		return;
	}

	autocomplete.innerHTML = matches.map((col: any, idx: any) =>
		'<div class="column-autocomplete-item' + (idx === 0 ? ' selected' : '') + '" ' +
		'data-col-index="' + col.index + '" ' +
		'onclick="scrollToColumn(' + col.index + ', \'' + boxId + '\')">' +
		col.name + '</div>'
	).join('');

	autocomplete.classList.add('visible');
	(_win.currentAutocompleteIndex as any) = 0;
}

function handleColumnSearchKeydown(event: any, boxId: any) {
	const autocomplete = document.getElementById(boxId + '_column_autocomplete');
	if (!autocomplete || !autocomplete.classList.contains('visible')) { return; }

	const items = autocomplete.querySelectorAll('.column-autocomplete-item');
	if (items.length === 0) { return; }

	if (event.key === 'ArrowDown') {
		event.preventDefault();
		(_win.currentAutocompleteIndex as any) = ((_win.currentAutocompleteIndex as any) + 1) % items.length;
		updateAutocompleteSelection(items);
	} else if (event.key === 'ArrowUp') {
		event.preventDefault();
		(_win.currentAutocompleteIndex as any) = ((_win.currentAutocompleteIndex as any) - 1 + items.length) % items.length;
		updateAutocompleteSelection(items);
	} else if (event.key === 'Enter') {
		event.preventDefault();
		const selected = items[(_win.currentAutocompleteIndex as any)];
		if (selected) {
			const colIndex = parseInt(selected.getAttribute('data-col-index') || '');
			scrollToColumn(colIndex, boxId);
			autocomplete.classList.remove('visible');
			const input = document.getElementById(boxId + '_column_search');
			if (input) { (input as any).value = ''; }
		}
	} else if (event.key === 'Escape') {
		event.preventDefault();
		autocomplete.classList.remove('visible');
	}
}

function updateAutocompleteSelection(items: any) {
	items.forEach((item: any, idx: any) => {
		if (idx === (_win.currentAutocompleteIndex as any)) {
			item.classList.add('selected');
			item.scrollIntoView({ block: 'nearest' });
		} else {
			item.classList.remove('selected');
		}
	});
}

function scrollToColumn(colIndex: any, boxId: any) {
	// When selecting a column via keyboard or mouse, always close the autocomplete dropdown.
	try {
		const autocomplete = document.getElementById(boxId + '_column_autocomplete');
		if (autocomplete) {
			autocomplete.classList.remove('visible');
		}
		const input = document.getElementById(boxId + '_column_search');
		if (input) {
			(input as any).value = '';
		}
		(_win.currentAutocompleteIndex as any) = 0;
	} catch { /* ignore */ }

	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }
	const rows = Array.isArray(state.rows) ? state.rows : [];
	if (rows.length === 0) { return; }
	const disp = Array.isArray(state.displayRowIndices) ? state.displayRowIndices : null;
	const firstRow = (disp && disp.length > 0) ? disp[0] : 0;

	// Select first cell in that column first
	selectCell(null, firstRow, colIndex, boxId);

	// Then scroll the container to center the column
	setTimeout(() => {
		const cell = document.querySelector('#' + boxId + '_table td[data-row="' + firstRow + '"][data-col="' + colIndex + '"]') as any;
		if (cell) {
			cell.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
		}
	}, 100);
}


// Copy/export, CSV save, split menus, drag selection, and context menu
// are in resultsTable-export.ts.

// A delegated mouseenter/mouseleave handler positions and shows/hides using a class.
(function __kustoInitResultsLabelTooltipPositioning() {
	var _hideTimer: any = null;

	function positionAndShow(anchor: any) {
		var tooltip = anchor.querySelector('.results-label-tooltip') as any;
		if (!tooltip) return;
		clearTimeout(_hideTimer);
		// Make it visible first so we can measure it
		tooltip.classList.add('is-visible');
		var rect = anchor.getBoundingClientRect();
		var ttRect = tooltip.getBoundingClientRect();
		var top = rect.bottom + 4;
		var left = rect.left;
		// Prevent overflowing the right edge of the viewport
		if (left + ttRect.width > window.innerWidth - 8) {
			left = Math.max(8, window.innerWidth - ttRect.width - 8);
		}
		// Prevent overflowing the bottom edge — flip above if needed
		if (top + ttRect.height > window.innerHeight - 8) {
			top = Math.max(8, rect.top - ttRect.height - 4);
		}
		tooltip.style.top = top + 'px';
		tooltip.style.left = left + 'px';
	}

	function scheduleHide(tooltip: any) {
		clearTimeout(_hideTimer);
		_hideTimer = setTimeout(function() {
			tooltip.classList.remove('is-visible');
		}, 120);
	}

	document.addEventListener('mouseenter', function (e: any) {
		var anchor = (e.target as HTMLElement).closest && (e.target as HTMLElement).closest('.results-label-tooltip-anchor');
		if (anchor) {
			positionAndShow(anchor);
		}
		// Keep tooltip open while hovering the tooltip itself
		var tt = (e.target as HTMLElement).closest && (e.target as HTMLElement).closest('.results-label-tooltip');
		if (tt && tt.classList.contains('is-visible')) {
			clearTimeout(_hideTimer);
		}
	}, true);

	document.addEventListener('mouseleave', function (e: any) {
		var anchor = (e.target as HTMLElement).closest && (e.target as HTMLElement).closest('.results-label-tooltip-anchor');
		if (anchor) {
			var tooltip = anchor.querySelector('.results-label-tooltip') as any;
			if (tooltip) scheduleHide(tooltip);
		}
		var tt = (e.target as HTMLElement).closest && (e.target as HTMLElement).closest('.results-label-tooltip');
		if (tt) {
			scheduleHide(tt);
		}
	}, true);
})();

// ── Window bridge exports for remaining legacy callers ──
(window as any).__kustoCopyClientActivityId = __kustoCopyClientActivityId;
(window as any).__kustoGetSearchIconSvg = __kustoGetSearchIconSvg;
(window as any).__kustoGetScrollToColumnIconSvg = __kustoGetScrollToColumnIconSvg;
(window as any).__kustoGetCopyIconSvg = __kustoGetCopyIconSvg;
(window as any).__kustoGetSaveIconSvg = __kustoGetSaveIconSvg;
(window as any).__kustoGetFilterIconSvg = __kustoGetFilterIconSvg;
(window as any).__kustoGetResultsVisibilityIconSvg = __kustoGetResultsVisibilityIconSvg;
(window as any).__kustoEnsureResultsShownForTool = __kustoEnsureResultsShownForTool;
(window as any).__kustoFocusTableContainer = __kustoFocusTableContainer;
(window as any).__kustoEnsureResultsCopyKeyHandlerInstalled = __kustoEnsureResultsCopyKeyHandlerInstalled;
(window as any).__kustoSetResultsToolsVisible = __kustoSetResultsToolsVisible;
(window as any).__kustoHideResultsTools = __kustoHideResultsTools;
(window as any).__kustoGetSortIconSvg = __kustoGetSortIconSvg;
(window as any).__kustoGetTrashIconSvg = __kustoGetTrashIconSvg;
(window as any).__kustoGetSelectAllIconSvg = __kustoGetSelectAllIconSvg;
(window as any).__kustoGetDeselectAllIconSvg = __kustoGetDeselectAllIconSvg;
(window as any).__kustoGetCloseIconSvg = __kustoGetCloseIconSvg;
(window as any).__kustoNormalizeSortDirection = __kustoNormalizeSortDirection;
(window as any).__kustoNormalizeSortSpec = __kustoNormalizeSortSpec;
(window as any).__kustoGetCellSortValue = __kustoGetCellSortValue;
(window as any).__kustoCompareSortValues = __kustoCompareSortValues;
(window as any).__kustoFormatNumberForDisplay = __kustoFormatNumberForDisplay;
(window as any).__kustoFormatDateForDisplay = __kustoFormatDateForDisplay;
(window as any).__kustoFormatCellDisplayValueForTable = __kustoFormatCellDisplayValueForTable;
(window as any).__kustoComputeSortedRowIndices = __kustoComputeSortedRowIndices;
(window as any).__kustoEnsureDisplayRowIndexMaps = __kustoEnsureDisplayRowIndexMaps;
(window as any).__kustoEnsureColumnFiltersMap = __kustoEnsureColumnFiltersMap;
(window as any).__kustoGetRawCellValue = __kustoGetRawCellValue;
(window as any).__kustoIsNullOrEmpty = __kustoIsNullOrEmpty;
(window as any).__kustoTryParseNumber = __kustoTryParseNumber;
(window as any).__kustoTryParseDateMs = __kustoTryParseDateMs;
(window as any).__kustoInferColumnType = __kustoInferColumnType;
(window as any).__kustoGetRowIndicesExcludingColumnFilter = __kustoGetRowIndicesExcludingColumnFilter;
(window as any).__kustoNormalizeStringForFilter = __kustoNormalizeStringForFilter;
(window as any).__kustoRowMatchesNullPolicy = __kustoRowMatchesNullPolicy;
(window as any).__kustoRowMatchesColumnFilter = __kustoRowMatchesColumnFilter;
(window as any).__kustoComputeUniqueValueKeys = __kustoComputeUniqueValueKeys;
(window as any).__kustoNormalizeDraftFilter = __kustoNormalizeDraftFilter;
(window as any).__kustoGetRulesCombineEnabledFromDom = __kustoGetRulesCombineEnabledFromDom;
(window as any).__kustoSetRulesCombineEnabled = __kustoSetRulesCombineEnabled;
(window as any).__kustoToggleRulesCombine = __kustoToggleRulesCombine;
(window as any).__kustoGetRulesJoinOpFromDom = __kustoGetRulesJoinOpFromDom;
(window as any).__kustoSetRulesJoinOp = __kustoSetRulesJoinOp;
(window as any).__kustoApplyFiltersAndRerender = __kustoApplyFiltersAndRerender;
(window as any).closeColumnFilterPopover = closeColumnFilterPopover;
(window as any).closeColumnFilterDialogOnBackdrop = closeColumnFilterDialogOnBackdrop;
(window as any).__kustoEnsureFilterGlobalCloseHandler = __kustoEnsureFilterGlobalCloseHandler;
(window as any).openColumnFilter = openColumnFilter;
(window as any).__kustoEnsureFilterPopoverSearchControl = __kustoEnsureFilterPopoverSearchControl;
(window as any).__kustoRenderFilterPopoverHtml = __kustoRenderFilterPopoverHtml;
(window as any).__kustoFilterSearchValues = __kustoFilterSearchValues;
(window as any).__kustoFilterSetAllValues = __kustoFilterSetAllValues;
(window as any).__kustoGetValuesAllowedFromSpec = __kustoGetValuesAllowedFromSpec;
(window as any).__kustoGetRulesSpecFromExisting = __kustoGetRulesSpecFromExisting;
(window as any).__kustoRenderRulesListHtml = __kustoRenderRulesListHtml;
(window as any).__kustoGetRuleOpsForType = __kustoGetRuleOpsForType;
(window as any).__kustoRenderRuleRowInputsHtml = __kustoRenderRuleRowInputsHtml;
(window as any).__kustoCaptureRulesFromDom = __kustoCaptureRulesFromDom;
(window as any).__kustoSetRuleJoin = __kustoSetRuleJoin;
(window as any).__kustoOnRuleRowOpChanged = __kustoOnRuleRowOpChanged;
(window as any).__kustoDeleteRuleRow = __kustoDeleteRuleRow;
(window as any).__kustoRenderRulesEditorHtml = __kustoRenderRulesEditorHtml;
(window as any).__kustoToDateTimeLocalValue = __kustoToDateTimeLocalValue;
(window as any).__kustoFromDateTimeLocalValue = __kustoFromDateTimeLocalValue;
(window as any).__kustoSetFilterMode = __kustoSetFilterMode;
(window as any).__kustoOnFilterOpChanged = __kustoOnFilterOpChanged;
(window as any).__kustoFilterToggleAllValues = __kustoFilterToggleAllValues;
(window as any).applyColumnFilter = applyColumnFilter;
(window as any).clearColumnFilter = clearColumnFilter;
(window as any).__kustoSetSortSpecAndRerender = __kustoSetSortSpecAndRerender;
(window as any).__kustoGetSortRuleIndex = __kustoGetSortRuleIndex;
(window as any).handleHeaderSortClick = handleHeaderSortClick;
(window as any).sortColumnAscending = sortColumnAscending;
(window as any).sortColumnDescending = sortColumnDescending;
(window as any).toggleSortDialog = toggleSortDialog;
(window as any).closeSortDialog = closeSortDialog;
(window as any).closeSortDialogOnBackdrop = closeSortDialogOnBackdrop;
(window as any).__kustoRenderSortDialog = __kustoRenderSortDialog;
(window as any).__kustoAddSortRuleInline = __kustoAddSortRuleInline;
(window as any).__kustoWireSortDialogDnD = __kustoWireSortDialogDnD;
(window as any).__kustoMoveSortRule = __kustoMoveSortRule;
(window as any).addSortRule = addSortRule;
(window as any).clearSort = clearSort;
(window as any).updateSortRuleColumn = updateSortRuleColumn;
(window as any).updateSortRuleDirection = updateSortRuleDirection;
(window as any).moveSortRuleUp = moveSortRuleUp;
(window as any).moveSortRuleDown = moveSortRuleDown;
(window as any).removeSortRule = removeSortRule;
(window as any).__kustoRerenderResultsTable = __kustoRerenderResultsTable;
(window as any).__kustoGetVirtualizationState = __kustoGetVirtualizationState;
(window as any).__kustoResolveVirtualScrollElement = __kustoResolveVirtualScrollElement;
(window as any).__kustoResolveScrollSourceForEvent = __kustoResolveScrollSourceForEvent;
(window as any).__kustoGetVirtualScrollMetrics = __kustoGetVirtualScrollMetrics;
(window as any).__kustoBumpVisualVersion = __kustoBumpVisualVersion;
(window as any).__kustoComputeVirtualRange = __kustoComputeVirtualRange;
(window as any).__kustoBuildResultsTableRowHtml = __kustoBuildResultsTableRowHtml;
(window as any).__kustoRerenderResultsTableBody = __kustoRerenderResultsTableBody;
(window as any).displayResult = displayResult;
(window as any).__kustoEnsureResultsStateMap = __kustoEnsureResultsStateMap;
(window as any).__kustoGetResultsState = __kustoGetResultsState;
(window as any).__kustoSetResultsState = __kustoSetResultsState;
(window as any).displayResultForBox = displayResultForBox;
(window as any).__kustoEnsureResultsSearchControls = __kustoEnsureResultsSearchControls;
(window as any).__kustoTryExtractJsonFromErrorText = __kustoTryExtractJsonFromErrorText;
(window as any).__kustoExtractLinePosition = __kustoExtractLinePosition;
(window as any).__kustoNormalizeBadRequestInnerMessage = __kustoNormalizeBadRequestInnerMessage;
(window as any).__kustoStripLinePositionTokens = __kustoStripLinePositionTokens;
(window as any).__kustoTryExtractAutoFindTermFromMessage = __kustoTryExtractAutoFindTermFromMessage;
(window as any).__kustoBuildErrorUxModel = __kustoBuildErrorUxModel;
(window as any).__kustoMaybeAdjustLocationForCacheLine = __kustoMaybeAdjustLocationForCacheLine;
(window as any).__kustoEscapeForHtml = __kustoEscapeForHtml;
(window as any).__kustoEscapeJsStringLiteral = __kustoEscapeJsStringLiteral;
(window as any).__kustoEscapeForHtmlAttribute = __kustoEscapeForHtmlAttribute;
(window as any).__kustoRenderActivityIdInlineHtml = __kustoRenderActivityIdInlineHtml;
(window as any).__kustoRenderErrorUxHtml = __kustoRenderErrorUxHtml;
(window as any).displayError = displayError;
(window as any).displayCancelled = displayCancelled;
(window as any).__kustoClampInt = __kustoClampInt;
(window as any).__kustoTryGetDomEventFromInlineHandler = __kustoTryGetDomEventFromInlineHandler;
(window as any).__kustoSetCellSelectionState = __kustoSetCellSelectionState;
(window as any).selectCell = selectCell;
(window as any).toggleRowSelection = toggleRowSelection;
(window as any).__kustoUpdateResultsToolsDropdownState = __kustoUpdateResultsToolsDropdownState;
(window as any).__kustoResultsToolsDropdownAction = __kustoResultsToolsDropdownAction;
(window as any).__kustoToggleResultsToolsDropdown = __kustoToggleResultsToolsDropdown;
(window as any).__kustoCloseResultsToolsDropdown = __kustoCloseResultsToolsDropdown;
(window as any).__kustoCloseAllResultsToolsDropdowns = __kustoCloseAllResultsToolsDropdowns;
(window as any).toggleSearchTool = toggleSearchTool;
(window as any).toggleColumnTool = toggleColumnTool;
(window as any).searchData = searchData;
(window as any).nextSearchMatch = nextSearchMatch;
(window as any).previousSearchMatch = previousSearchMatch;
(window as any).highlightCurrentSearchMatch = highlightCurrentSearchMatch;
(window as any).handleDataSearchKeydown = handleDataSearchKeydown;
(window as any).handleTableKeydown = handleTableKeydown;
(window as any).filterColumns = filterColumns;
(window as any).handleColumnSearchKeydown = handleColumnSearchKeydown;
(window as any).updateAutocompleteSelection = updateAutocompleteSelection;
(window as any).scrollToColumn = scrollToColumn;
// Copy/export, CSV save, split menus, drag selection, and context menu bridges are in resultsTable-export.ts.
