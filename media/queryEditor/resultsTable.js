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

function __kustoGetResultsVisibilityIconSvg() {
	return (
			'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z" />' +
		'<circle cx="8" cy="8" r="2.1" />' +
		'</svg>'
	);
}

function __kustoEnsureResultsShownForTool(boxId) {
	try {
		if (window.__kustoResultsVisibleByBoxId && window.__kustoResultsVisibleByBoxId[boxId] === false) {
			if (typeof __kustoSetResultsVisible === 'function') {
				__kustoSetResultsVisible(boxId, true);
			} else {
				window.__kustoResultsVisibleByBoxId[boxId] = true;
				try {
					if (typeof __kustoApplyResultsVisibility === 'function') {
						__kustoApplyResultsVisibility(boxId);
					}
				} catch { /* ignore */ }
			}
		}
	} catch {
		// ignore
	}
}

function __kustoSetResultsToolsVisible(boxId, visible) {
	const searchBtn = document.getElementById(boxId + '_results_search_btn');
	const columnBtn = document.getElementById(boxId + '_results_column_btn');
	const sortBtn = document.getElementById(boxId + '_results_sort_btn');
	const display = visible ? '' : 'none';
	try { if (searchBtn) { searchBtn.style.display = display; } } catch { /* ignore */ }
	try { if (columnBtn) { columnBtn.style.display = display; } } catch { /* ignore */ }
	try { if (sortBtn) { sortBtn.style.display = display; } } catch { /* ignore */ }
}

function __kustoHideResultsTools(boxId) {
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

function __kustoGetTrashIconSvg(size) {
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

function __kustoNormalizeSortDirection(dir) {
	return (dir === 'desc') ? 'desc' : 'asc';
}

function __kustoNormalizeSortSpec(spec, columnCount) {
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

function __kustoGetCellSortValue(cell) {
	// Prefer underlying values over truncated display values.
	try {
			if (cell === null || cell === undefined) {
			return { kind: 'null', v: null };
		}
		if (typeof cell === 'number') {
			return { kind: 'number', v: cell };
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
		return { kind: 'string', v: s };
	} catch {
		return { kind: 'string', v: String(cell) };
	}
}

function __kustoCompareSortValues(a, b) {
	// Nulls always last.
	if (a.kind === 'null' && b.kind === 'null') return 0;
	if (a.kind === 'null') return 1;
	if (b.kind === 'null') return -1;
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

function __kustoComputeSortedRowIndices(rows, sortSpec) {
	const count = Array.isArray(rows) ? rows.length : 0;
	const indices = [];
	for (let i = 0; i < count; i++) indices.push(i);
	const spec = Array.isArray(sortSpec) ? sortSpec : [];
	if (spec.length === 0 || count <= 1) {
		return indices;
	}
	// Stable sort by decorating with original index.
	indices.sort((i1, i2) => {
		for (const rule of spec) {
			const colIndex = rule.colIndex;
			const dir = rule.dir === 'desc' ? -1 : 1;
			const r1 = rows[i1] || [];
			const r2 = rows[i2] || [];
			const v1 = __kustoGetCellSortValue(r1[colIndex]);
			const v2 = __kustoGetCellSortValue(r2[colIndex]);
			const cmp = __kustoCompareSortValues(v1, v2);
			if (cmp !== 0) return dir * cmp;
		}
		return i1 - i2;
	});
	return indices;
}

function __kustoEnsureDisplayRowIndexMaps(state) {
	if (!state) return;
	const rows = Array.isArray(state.rows) ? state.rows : [];
	const sortSpec = Array.isArray(state.sortSpec) ? state.sortSpec : [];
	state.displayRowIndices = __kustoComputeSortedRowIndices(rows, sortSpec);
	// Build inverse map: originalRow -> displayRow.
	const inv = new Array(rows.length);
	for (let displayIdx = 0; displayIdx < state.displayRowIndices.length; displayIdx++) {
		inv[state.displayRowIndices[displayIdx]] = displayIdx;
	}
	state.rowIndexToDisplayIndex = inv;
}

function __kustoSetSortSpecAndRerender(boxId, nextSpec) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	state.sortSpec = __kustoNormalizeSortSpec(nextSpec, (state.columns || []).length);
	__kustoEnsureDisplayRowIndexMaps(state);
	__kustoRerenderResultsTable(boxId);
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoGetSortRuleIndex(state, colIndex) {
	if (!state || !Array.isArray(state.sortSpec)) return -1;
	for (let i = 0; i < state.sortSpec.length; i++) {
		if (state.sortSpec[i] && state.sortSpec[i].colIndex === colIndex) return i;
	}
	return -1;
}

function handleHeaderSortClick(event, colIndex, boxId) {
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

function sortColumnAscending(colIndex, boxId) {
	__kustoSetSortSpecAndRerender(boxId, [{ colIndex: colIndex, dir: 'asc' }]);
}

function sortColumnDescending(colIndex, boxId) {
	__kustoSetSortSpecAndRerender(boxId, [{ colIndex: colIndex, dir: 'desc' }]);
}

function toggleSortDialog(boxId) {
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

function closeSortDialog(boxId) {
	const modal = document.getElementById(boxId + '_sort_modal');
	if (!modal) return;
	modal.classList.remove('visible');
	try {
		const btn = document.getElementById(boxId + '_results_sort_btn');
		if (btn) btn.classList.remove('active');
	} catch { /* ignore */ }
}

function closeSortDialogOnBackdrop(event, boxId) {
	// Only close if the click hit the backdrop.
	if (event && event.target && event.currentTarget && event.target === event.currentTarget) {
		closeSortDialog(boxId);
	}
}

function __kustoRenderSortDialog(boxId) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const listEl = document.getElementById(boxId + '_sort_list');
	if (!listEl) return;
	const spec = Array.isArray(state.sortSpec) ? state.sortSpec : [];
	const cols = Array.isArray(state.columns) ? state.columns : [];

	const emptyHint = (spec.length === 0)
		? '<div class="kusto-sort-empty">No sort applied.</div>'
		: '';

	const rulesHtml = spec.map((rule, idx) => {
		const colIndex = rule.colIndex;
		const dir = __kustoNormalizeSortDirection(rule.dir);
		const options = cols.map((c, i) => {
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

	const addOptions = cols.map((c, i) => {
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

function __kustoAddSortRuleInline(boxId) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const colSel = document.getElementById(boxId + '_sort_add_col');
	const dirSel = document.getElementById(boxId + '_sort_add_dir');
	if (!colSel || !dirSel) return;
	const colIndex = parseInt(String(colSel.value), 10);
	if (!isFinite(colIndex) || colIndex < 0) return;
	const dir = (String(dirSel.value) === 'desc') ? 'desc' : 'asc';
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

function __kustoWireSortDialogDnD(boxId) {
	const listEl = document.getElementById(boxId + '_sort_list');
	if (!listEl) return;
	const rows = Array.from(listEl.querySelectorAll('.kusto-sort-row[data-sort-idx]'));
	if (rows.length === 0) return;

	// Keep drag state on window to survive re-renders.
	if (!window.__kustoSortDnD) {
		window.__kustoSortDnD = { boxId: null, fromIdx: -1, dragEnabled: false };
	}

	for (const row of rows) {
		row.draggable = true;
		row.addEventListener('dragstart', (e) => {
			const idx = parseInt(String(row.getAttribute('data-sort-idx')), 10);
			if (!isFinite(idx)) return;
			const handle = e && e.target && e.target.closest ? e.target.closest('.kusto-sort-grab') : null;
			if (!handle) {
				// Only allow drag when starting from the grab handle.
				try { e.preventDefault(); } catch { /* ignore */ }
				return;
			}
			window.__kustoSortDnD.boxId = boxId;
			window.__kustoSortDnD.fromIdx = idx;
			row.classList.add('kusto-sort-dragging');
			try {
				e.dataTransfer.effectAllowed = 'move';
				// Some browsers require data to be set.
				e.dataTransfer.setData('text/plain', String(idx));
			} catch { /* ignore */ }
		});

		row.addEventListener('dragend', () => {
			row.classList.remove('kusto-sort-dragging');
			for (const r of rows) r.classList.remove('kusto-sort-drop');
		});

		row.addEventListener('dragover', (e) => {
			try { e.preventDefault(); } catch { /* ignore */ }
			for (const r of rows) r.classList.remove('kusto-sort-drop');
			row.classList.add('kusto-sort-drop');
			try { e.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ }
		});

		row.addEventListener('drop', (e) => {
			try { e.preventDefault(); } catch { /* ignore */ }
			const fromIdx = window.__kustoSortDnD ? window.__kustoSortDnD.fromIdx : -1;
			const toIdx = parseInt(String(row.getAttribute('data-sort-idx')), 10);
			if (!isFinite(fromIdx) || !isFinite(toIdx) || fromIdx === toIdx) return;
			__kustoMoveSortRule(boxId, fromIdx, toIdx);
		});
	}
}

function __kustoMoveSortRule(boxId, fromIdx, toIdx) {
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

function addSortRule(boxId) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const cols = Array.isArray(state.columns) ? state.columns : [];
	if (cols.length === 0) return;
	const spec = Array.isArray(state.sortSpec) ? state.sortSpec.slice() : [];
	// Pick first unused column, else first.
	let colIndex = 0;
	const used = new Set(spec.map(r => r && r.colIndex));
	for (let i = 0; i < cols.length; i++) {
		if (!used.has(i)) { colIndex = i; break; }
	}
	spec.push({ colIndex: colIndex, dir: 'asc' });
	__kustoSetSortSpecAndRerender(boxId, spec);
	__kustoRenderSortDialog(boxId);
}

function clearSort(boxId) {
	__kustoSetSortSpecAndRerender(boxId, []);
	__kustoRenderSortDialog(boxId);
}

function updateSortRuleColumn(ruleIndex, value, boxId) {
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

function updateSortRuleDirection(ruleIndex, value, boxId) {
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

function moveSortRuleUp(ruleIndex, boxId) {
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

function moveSortRuleDown(ruleIndex, boxId) {
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

function removeSortRule(ruleIndex, boxId) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const idx = parseInt(String(ruleIndex), 10);
	const spec = Array.isArray(state.sortSpec) ? state.sortSpec.slice() : [];
	if (!isFinite(idx) || idx < 0 || idx >= spec.length) return;
	spec.splice(idx, 1);
	__kustoSetSortSpecAndRerender(boxId, spec);
	__kustoRenderSortDialog(boxId);
}

function __kustoRerenderResultsTable(boxId) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const table = document.getElementById(boxId + '_table');
	if (!table) return;

	// Update sort indicators.
	try {
		const spec = Array.isArray(state.sortSpec) ? state.sortSpec : [];
		for (let i = 0; i < (state.columns || []).length; i++) {
			const indicator = document.getElementById(boxId + '_sort_ind_' + i);
			if (!indicator) continue;
			const ruleIdx = spec.findIndex(r => r && r.colIndex === i);
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
	const displayRowIndices = Array.isArray(state.displayRowIndices) ? state.displayRowIndices : rows.map((_, i) => i);

	const tbodyHtml = displayRowIndices.map((rowIdx, displayIdx) => {
		const row = rows[rowIdx] || [];
		const trClass = state.selectedRows && state.selectedRows.has(rowIdx) ? ' class="selected-row"' : '';
		return (
			'<tr data-row="' + rowIdx + '"' + trClass + '>' +
			'<td class="row-selector" onclick="toggleRowSelection(' + rowIdx + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\')">' + (displayIdx + 1) + '</td>' +
			row.map((cell, colIdx) => {
				const hasHover = typeof cell === 'object' && cell !== null && 'display' in cell && 'full' in cell;
				const displayValue = hasHover ? cell.display : cell;
				const fullValue = hasHover ? cell.full : cell;
				const isObject = cell && cell.isObject;
				const title = hasHover && displayValue !== fullValue && !isObject ? ' title="' + __kustoEscapeForHtmlAttribute(fullValue) + '"' : '';
				const viewBtn = isObject ? '<button class="object-view-btn" onclick="event.stopPropagation(); openObjectViewer(' + rowIdx + ', ' + colIdx + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\')">View</button>' : '';
				let tdClass = '';
				if (state.selectedCell && state.selectedCell.row === rowIdx && state.selectedCell.col === colIdx) {
					tdClass += (tdClass ? ' ' : '') + 'selected-cell';
				}
				if (matchSet && matchSet.has(String(rowIdx) + ',' + String(colIdx))) {
					tdClass += (tdClass ? ' ' : '') + 'search-match';
					if (currentKey && currentKey === (String(rowIdx) + ',' + String(colIdx))) {
						tdClass += ' search-match-current';
					}
				}
				const classAttr = tdClass ? (' class="' + tdClass + '"') : '';
				return '<td data-row="' + rowIdx + '" data-col="' + colIdx + '"' + classAttr + title + ' onclick="selectCell(' + rowIdx + ', ' + colIdx + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\')">' +
					displayValue + viewBtn +
				'</td>';
			}).join('') +
			'</tr>'
		);
	}).join('');

	try {
		const tbody = table.querySelector('tbody');
		if (tbody) {
			tbody.innerHTML = tbodyHtml;
		}
	} catch { /* ignore */ }
}

function displayResult(result) {
	const boxId = window.lastExecutedBox;
	if (!boxId) { return; }

	setQueryExecuting(boxId, false);

	displayResultForBox(result, boxId, {
		label: 'Results',
		showExecutionTime: true
	});
}

// Ensure these entrypoints are always accessible globally (some hosts/tooling can
// make bare function declarations non-global).
try { window.displayResult = displayResult; } catch { /* ignore */ }
try { window.displayResultForBox = displayResultForBox; } catch { /* ignore */ }

function __kustoEnsureResultsStateMap() {
	if (!window.__kustoResultsByBoxId || typeof window.__kustoResultsByBoxId !== 'object') {
		window.__kustoResultsByBoxId = {};
	}
	return window.__kustoResultsByBoxId;
}

function __kustoGetResultsState(boxId) {
	if (!boxId) {
		return null;
	}
	const map = __kustoEnsureResultsStateMap();
	return map[boxId] || null;
}

function __kustoSetResultsState(boxId, state) {
	if (!boxId) {
		return;
	}
	const map = __kustoEnsureResultsStateMap();
	map[boxId] = state;
	// Backward-compat: keep the last rendered result as the "current" one.
	try { window.currentResult = state; } catch { /* ignore */ }
}

function displayResultForBox(result, boxId, options) {
	if (!boxId) { return; }
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
		selectedRows: new Set(),
		searchMatches: [],
		currentSearchIndex: -1,
		sortSpec: [],
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
	const execPart = (showExecutionTime && execTime) ? (' (Execution time: ' + execTime + ')') : '';

	const searchIconSvg = __kustoGetSearchIconSvg();
	const scrollToColumnIconSvg = __kustoGetScrollToColumnIconSvg();
	const resultsVisibilityIconSvg = __kustoGetResultsVisibilityIconSvg();
	const sortIconSvg = __kustoGetSortIconSvg();

	const stateForRender = __kustoGetResultsState(boxId);
	const displayRowIndices = (stateForRender && Array.isArray(stateForRender.displayRowIndices)) ? stateForRender.displayRowIndices : rows.map((_, i) => i);

	let html =
		'<div class="results-header">' +
		'<div class="results-title-row">' +
		'<strong>' + label + ':</strong> ' + (rows ? rows.length : 0) + ' rows / ' + (columns ? columns.length : 0) + ' columns' +
		execPart +
		'<button class="tool-toggle-btn results-visibility-toggle" id="' + boxId + '_results_toggle" type="button" onclick="toggleQueryResultsVisibility(\'' + boxId + '\')" title="Hide results" aria-label="Hide results">' + resultsVisibilityIconSvg + '</button>' +
		'<button class="tool-toggle-btn" id="' + boxId + '_results_sort_btn" onclick="toggleSortDialog(\'' + boxId + '\')" title="Sort" aria-label="Sort">' + sortIconSvg + '</button>' +
		'<button class="tool-toggle-btn" id="' + boxId + '_results_search_btn" onclick="toggleSearchTool(\'' + boxId + '\')" title="Search data" aria-label="Search data">' + searchIconSvg + '</button>' +
		'<button class="tool-toggle-btn" id="' + boxId + '_results_column_btn" onclick="toggleColumnTool(\'' + boxId + '\')" title="Scroll to column" aria-label="Scroll to column">' + scrollToColumnIconSvg + '</button>' +
		'</div>' +
		'</div>' +
		'<div class="results-body" id="' + boxId + '_results_body">' +
		'<div class="data-search" id="' + boxId + '_data_search_container" style="display: none;">' +
		'<input type="text" placeholder="Search data..." id="' + boxId + '_data_search" ' +
		'oninput="searchData(\'' + boxId + '\')" ' +
		'onkeydown="handleDataSearchKeydown(event, \'' + boxId + '\')" />' +
		'<div class="data-search-nav">' +
		'<button id="' + boxId + '_search_prev" onclick="previousSearchMatch(\'' + boxId + '\')" disabled title="Previous (Shift+Enter)">↑</button>' +
		'<button id="' + boxId + '_search_next" onclick="nextSearchMatch(\'' + boxId + '\')" disabled title="Next (Enter)">↓</button>' +
		'</div>' +
		'<span class="data-search-info" id="' + boxId + '_search_info"></span>' +
		'</div>' +
		'<div class="column-search" id="' + boxId + '_column_search_container" style="display: none;">' +
		'<input type="text" placeholder="Scroll to column..." id="' + boxId + '_column_search" ' +
		'oninput="filterColumns(\'' + boxId + '\')" ' +
		'onkeydown="handleColumnSearchKeydown(event, \'' + boxId + '\')" />' +
		'<div class="column-autocomplete" id="' + boxId + '_column_autocomplete"></div>' +
		'</div>' +
		'<div class="table-container" id="' + boxId + '_table_container" tabindex="0" onkeydown="handleTableKeydown(event, \'' + boxId + '\')">' +
		'<table id="' + boxId + '_table">' +
		'<thead><tr>' +
		'<th class="row-selector">#</th>' +
		columns.map((c, i) =>
			'<th data-col="' + i + '" onclick="handleHeaderSortClick(event, ' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\')">' +
			'<div class="column-header-content">' +
			'<div class="column-header-left">' +
			'<span class="column-name">' + c + '</span>' +
			'<span class="kusto-sort-indicator" id="' + boxId + '_sort_ind_' + i + '"></span>' +
			'</div>' +
			'<button class="column-menu-btn" onclick="toggleColumnMenu(' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); event.stopPropagation();">☰</button>' +
			'<div class="column-menu" id="' + boxId + '_col_menu_' + i + '">' +
			'<div class="column-menu-item" onclick="sortColumnAscending(' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); toggleColumnMenu(' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); event.stopPropagation();">Sort ascending</div>' +
			'<div class="column-menu-item" onclick="sortColumnDescending(' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); toggleColumnMenu(' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); event.stopPropagation();">Sort descending</div>' +
			'<div class="column-menu-item" onclick="showUniqueValues(' + i + ', \'' + boxId + '\')">Unique values</div>' +
			'<div class="column-menu-item" onclick="showDistinctCountPicker(' + i + ', \'' + boxId + '\')">Distinct count by column...</div>' +
			'</div>' +
			'</div>' +
			'</th>'
		).join('') +
		'</tr></thead>' +
		'<tbody>' +
		displayRowIndices.map((rowIdx, displayIdx) => {
			const row = rows[rowIdx] || [];
			return '<tr data-row="' + rowIdx + '">' +
			'<td class="row-selector" onclick="toggleRowSelection(' + rowIdx + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\')">' + (displayIdx + 1) + '</td>' +
			row.map((cell, colIdx) => {
				const hasHover = typeof cell === 'object' && cell !== null && 'display' in cell && 'full' in cell;
				const displayValue = hasHover ? cell.display : cell;
				const fullValue = hasHover ? cell.full : cell;
				const isObject = cell && cell.isObject;
				const title = hasHover && displayValue !== fullValue && !isObject ? ' title="' + __kustoEscapeForHtmlAttribute(fullValue) + '"' : '';
				const viewBtn = isObject ? '<button class="object-view-btn" onclick="event.stopPropagation(); openObjectViewer(' + rowIdx + ', ' + colIdx + ', \'' + boxId + '\')">View</button>' : '';
				return '<td data-row="' + rowIdx + '" data-col="' + colIdx + '"' + title + ' ' +
					'onclick="selectCell(' + rowIdx + ', ' + colIdx + ', \'' + boxId + '\')">' +
					displayValue + viewBtn + '</td>';
			}).join('') +
			'</tr>'
		}).join('') +
		'</tbody>' +
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
	try { __kustoRerenderResultsTable(boxId); } catch { /* ignore */ }
	try {
		if (typeof __kustoApplyResultsVisibility === 'function') {
			__kustoApplyResultsVisibility(boxId);
		}
	} catch {
		// ignore
	}
	try {
		if (typeof __kustoUpdateQueryResultsToggleButton === 'function') {
			__kustoUpdateQueryResultsToggleButton(boxId);
		}
	} catch {
		// ignore
	}
	resultsDiv.classList.add('visible');
}

function __kustoTryExtractJsonFromErrorText(raw) {
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

function __kustoExtractLinePosition(text) {
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

function __kustoNormalizeBadRequestInnerMessage(msg) {
	let s = String(msg || '').trim();
	// Strip boilerplate prefixes commonly returned by Kusto.
	s = s.replace(/^Request is invalid[^:]*:\s*/i, '');
	s = s.replace(/^(Semantic error:|Syntax error:)\s*/i, '');
	return s.trim();
}

function __kustoStripLinePositionTokens(text) {
	let s = String(text || '');
	// Remove any existing [line:position=...] tokens to avoid duplicating adjusted locations.
	s = s.replace(/\s*\[line:position\s*=\s*\d+\s*:\s*\d+\s*\]\s*/gi, ' ');
	// Normalize whitespace.
	s = s.replace(/\s{2,}/g, ' ').trim();
	return s;
}

function __kustoTryExtractAutoFindTermFromMessage(message) {
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

function __kustoBuildErrorUxModel(rawError) {
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

function __kustoMaybeAdjustLocationForCacheLine(boxId, location) {
	if (!location || typeof location !== 'object') {
		return location;
	}
	const bid = String(boxId || '').trim();
	if (!bid) {
		return location;
	}
	let cacheEnabled = false;
	try {
		cacheEnabled = !!(window.__kustoLastRunCacheEnabledByBoxId && window.__kustoLastRunCacheEnabledByBoxId[bid]);
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

function __kustoEscapeForHtml(s) {
	return (typeof escapeHtml === 'function') ? escapeHtml(String(s || '')) : String(s || '');
}

function __kustoEscapeJsStringLiteral(s) {
	return String(s || '')
		.replace(/\\/g, '\\\\')
		.replace(/'/g, "\\'")
		.replace(/"/g, '\\"');
}

function __kustoEscapeForHtmlAttribute(s) {
	// Attribute-safe escaping (quotes included).
	return __kustoEscapeForHtml(s)
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function __kustoRenderErrorUxHtml(boxId, model) {
	if (!model || model.kind === 'none') {
		return '';
	}
	const bid = String(boxId || '');
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
			'</div>'
		);
	}
	// text
	const lines = String(model.text || '').split(/\r?\n/).map(__kustoEscapeForHtml).join('<br>');
	return (
		'<div class="results-header kusto-error-ux" style="color: var(--vscode-errorForeground);">' +
		lines +
		'</div>'
	);
}

// Centralized error UX renderer (hidden when no error).
try {
	window.__kustoRenderErrorUx = function (boxId, error) {
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
				if (typeof __kustoApplyResultsVisibility === 'function') {
					__kustoApplyResultsVisibility(bid);
				}
			} catch { /* ignore */ }
			return;
		}
		const html = __kustoRenderErrorUxHtml(bid, model);
		resultsDiv.innerHTML = html;
		resultsDiv.classList.add('visible');
		try {
			if (typeof __kustoApplyResultsVisibility === 'function') {
				__kustoApplyResultsVisibility(bid);
			}
		} catch { /* ignore */ }
		try {
			if (typeof window.__kustoClampResultsWrapperHeight === 'function') {
				window.__kustoClampResultsWrapperHeight(bid);
			}
		} catch { /* ignore */ }
		// Special UX: on SEM0139, auto-find the unresolved expression in the query editor.
		try {
			if (model && model.autoFindTerm && typeof window.__kustoAutoFindInQueryEditor === 'function') {
				setTimeout(() => {
					try { window.__kustoAutoFindInQueryEditor(bid, String(model.autoFindTerm)); } catch { /* ignore */ }
				}, 0);
			}
		} catch { /* ignore */ }
	};
} catch {
	// ignore
}

// Navigate to a line/column in the query editor and scroll it into view.
try {
	window.__kustoNavigateToQueryLocation = function (event, boxId, line, col) {
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
			const editor = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[bid] : null;
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
	if (!window.__kustoErrorLocationClickHandlerInstalled) {
		window.__kustoErrorLocationClickHandlerInstalled = true;
		document.addEventListener('click', (event) => {
			try {
				const target = event && event.target ? event.target : null;
				if (!target || typeof target.closest !== 'function') {
					return;
				}
				const link = target.closest('a.kusto-error-location');
				if (!link) {
					return;
				}
				const boxId = String(link.getAttribute('data-boxid') || '').trim();
				const line = parseInt(String(link.getAttribute('data-line') || ''), 10);
				const col = parseInt(String(link.getAttribute('data-col') || ''), 10);
				if (!boxId || !isFinite(line) || !isFinite(col)) {
					return;
				}
				if (typeof window.__kustoNavigateToQueryLocation === 'function') {
					window.__kustoNavigateToQueryLocation(event, boxId, line, col);
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

function displayError(error) {
	const boxId = window.lastExecutedBox;
	if (!boxId) { return; }

	setQueryExecuting(boxId, false);

	try {
		if (typeof window.__kustoRenderErrorUx === 'function') {
			window.__kustoRenderErrorUx(boxId, error);
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
	window.__kustoDisplayBoxError = function (boxId, error) {
		const bid = String(boxId || '').trim();
		if (!bid) return;
		try {
			if (typeof window.__kustoRenderErrorUx === 'function') {
				window.__kustoRenderErrorUx(bid, error);
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
	const boxId = window.lastExecutedBox;
	if (!boxId) { return; }

	setQueryExecuting(boxId, false);

	const resultsDiv = document.getElementById(boxId + '_results');
	if (!resultsDiv) { return; }

	resultsDiv.innerHTML =
		'<div class="results-header">' +
		'<strong>Cancelled.</strong>' +
		'</div>';
	resultsDiv.classList.add('visible');
}

function selectCell(row, col, boxId) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }

	// Clear previous selection
	const prevCell = document.querySelector('#' + boxId + '_table td.selected-cell');
	if (prevCell) {
		prevCell.classList.remove('selected-cell');
	}

	// Select new cell
	const cell = document.querySelector('#' + boxId + '_table td[data-row="' + row + '"][data-col="' + col + '"]');
	if (cell) {
		cell.classList.add('selected-cell');
		state.selectedCell = { row, col };

		// Scroll cell into view
		cell.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });

		// Focus the container for keyboard navigation
		const container = document.getElementById(boxId + '_table_container');
		if (container) {
			container.focus();
		}
	}
}

function toggleRowSelection(row, boxId) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }

	const rowElement = document.querySelector('#' + boxId + '_table tr[data-row="' + row + '"]');
	if (!rowElement) { return; }

	if (state.selectedRows.has(row)) {
		state.selectedRows.delete(row);
		rowElement.classList.remove('selected-row');
	} else {
		state.selectedRows.add(row);
		rowElement.classList.add('selected-row');
	}
}

function toggleSearchTool(boxId) {
	__kustoEnsureResultsShownForTool(boxId);
	const container = document.getElementById(boxId + '_data_search_container');
	const button = event.target.closest('.tool-toggle-btn');

	if (container.style.display === 'none') {
		// Close the other tool first
		const columnContainer = document.getElementById(boxId + '_column_search_container');
		if (columnContainer) {
			columnContainer.style.display = 'none';
		}
		// Remove active state from all buttons
		document.querySelectorAll('.tool-toggle-btn').forEach(btn => btn.classList.remove('active'));

		// Show this tool
		container.style.display = 'flex';
		button.classList.add('active');

		// Focus the input
		const input = document.getElementById(boxId + '_data_search');
		if (input) {
			setTimeout(() => input.focus(), 0);
		}
	} else {
		// Hide this tool
		container.style.display = 'none';
		button.classList.remove('active');
	}
}

function toggleColumnTool(boxId) {
	__kustoEnsureResultsShownForTool(boxId);
	const body = document.getElementById(boxId + '_results_body');
	// If results were hidden, the body may still be display:none for a tick.
	try {
		if (body && body.style && body.style.display === 'none') {
			body.style.display = '';
		}
	} catch { /* ignore */ }
	const container = document.getElementById(boxId + '_column_search_container');
	const button = event.target.closest('.tool-toggle-btn');

	if (container.style.display === 'none') {
		// Close the other tool first
		const searchContainer = document.getElementById(boxId + '_data_search_container');
		if (searchContainer) {
			searchContainer.style.display = 'none';
		}
		// Remove active state from all buttons
		document.querySelectorAll('.tool-toggle-btn').forEach(btn => btn.classList.remove('active'));

		// Show this tool
		container.style.display = 'block';
		button.classList.add('active');

		// Focus the input
		const input = document.getElementById(boxId + '_column_search');
		if (input) {
			setTimeout(() => input.focus(), 0);
		}
	} else {
		// Hide this tool
		container.style.display = 'none';
		button.classList.remove('active');
	}
}

function searchData(boxId) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }

	const searchInput = document.getElementById(boxId + '_data_search');
	const searchTerm = searchInput.value.toLowerCase();
	const infoSpan = document.getElementById(boxId + '_search_info');
	const prevBtn = document.getElementById(boxId + '_search_prev');
	const nextBtn = document.getElementById(boxId + '_search_next');

	// Clear previous search highlights
	document.querySelectorAll('#' + boxId + '_table td.search-match, #' + boxId + '_table td.search-match-current')
		.forEach(cell => {
			cell.classList.remove('search-match', 'search-match-current');
		});

	state.searchMatches = [];
	state.currentSearchIndex = -1;

	if (!searchTerm) {
		infoSpan.textContent = '';
		prevBtn.disabled = true;
		nextBtn.disabled = true;
		return;
	}

	// Search through all cells
	state.rows.forEach((row, rowIdx) => {
		row.forEach((cell, colIdx) => {
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
			if (cellText.toLowerCase().includes(searchTerm)) {
				state.searchMatches.push({ row: rowIdx, col: colIdx });
			}
		});
	});

	// Update UI
	const matchCount = state.searchMatches.length;
	if (matchCount > 0) {
		infoSpan.textContent = matchCount + ' match' + (matchCount !== 1 ? 'es' : '');
		prevBtn.disabled = false;
		nextBtn.disabled = false;

		// Highlight all matches
		state.searchMatches.forEach(match => {
			const cell = document.querySelector('#' + boxId + '_table td[data-row="' + match.row + '"][data-col="' + match.col + '"]');
			if (cell) {
				cell.classList.add('search-match');
			}
		});

		// Jump to first match
		state.currentSearchIndex = 0;
		highlightCurrentSearchMatch(boxId);
	} else {
		infoSpan.textContent = 'No matches';
		prevBtn.disabled = true;
		nextBtn.disabled = true;
	}
}

function nextSearchMatch(boxId) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }

	const matches = state.searchMatches;
	if (matches.length === 0) { return; }

	state.currentSearchIndex = (state.currentSearchIndex + 1) % matches.length;
	highlightCurrentSearchMatch(boxId);
}

function previousSearchMatch(boxId) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }

	const matches = state.searchMatches;
	if (matches.length === 0) { return; }

	state.currentSearchIndex = (state.currentSearchIndex - 1 + matches.length) % matches.length;
	highlightCurrentSearchMatch(boxId);
}

function highlightCurrentSearchMatch(boxId) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }

	const matches = state.searchMatches;
	const currentIndex = state.currentSearchIndex;

	if (currentIndex < 0 || currentIndex >= matches.length) { return; }

	// Remove current highlight from all cells
	document.querySelectorAll('#' + boxId + '_table td.search-match-current')
		.forEach(cell => cell.classList.remove('search-match-current'));

	// Highlight current match
	const match = matches[currentIndex];
	const cell = document.querySelector('#' + boxId + '_table td[data-row="' + match.row + '"][data-col="' + match.col + '"]');

	if (cell) {
		cell.classList.add('search-match-current');
		cell.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
	}

	// Update info text
	const infoSpan = document.getElementById(boxId + '_search_info');
	if (infoSpan) {
		infoSpan.textContent = (currentIndex + 1) + ' of ' + matches.length;
	}
}

function handleDataSearchKeydown(event, boxId) {
	if (event.key === 'Enter') {
		event.preventDefault();
		if (event.shiftKey) {
			previousSearchMatch(boxId);
		} else {
			nextSearchMatch(boxId);
		}
	}
}

function handleTableKeydown(event, boxId) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }

	// Handle copy to clipboard (Ctrl+C or Cmd+C)
	if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
		event.preventDefault();
		copySelectionToClipboard(boxId);
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
			selectCell(firstRow, 0, boxId);
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
		selectCell(newRow, newCol, boxId);
	}
}

function filterColumns(boxId) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }

	const input = document.getElementById(boxId + '_column_search');
	const autocomplete = document.getElementById(boxId + '_column_autocomplete');
	if (!input || !autocomplete) { return; }

	const query = input.value.toLowerCase();

	if (!query) {
		autocomplete.classList.remove('visible');
		return;
	}

	const matches = state.columns
		.map((col, idx) => ({ name: col, index: idx }))
		.filter(col => col.name.toLowerCase().includes(query));

	if (matches.length === 0) {
		autocomplete.classList.remove('visible');
		return;
	}

	autocomplete.innerHTML = matches.map((col, idx) =>
		'<div class="column-autocomplete-item' + (idx === 0 ? ' selected' : '') + '" ' +
		'data-col-index="' + col.index + '" ' +
		'onclick="scrollToColumn(' + col.index + ', \'' + boxId + '\')">' +
		col.name + '</div>'
	).join('');

	autocomplete.classList.add('visible');
	window.currentAutocompleteIndex = 0;
}

function handleColumnSearchKeydown(event, boxId) {
	const autocomplete = document.getElementById(boxId + '_column_autocomplete');
	if (!autocomplete || !autocomplete.classList.contains('visible')) { return; }

	const items = autocomplete.querySelectorAll('.column-autocomplete-item');
	if (items.length === 0) { return; }

	if (event.key === 'ArrowDown') {
		event.preventDefault();
		window.currentAutocompleteIndex = (window.currentAutocompleteIndex + 1) % items.length;
		updateAutocompleteSelection(items);
	} else if (event.key === 'ArrowUp') {
		event.preventDefault();
		window.currentAutocompleteIndex = (window.currentAutocompleteIndex - 1 + items.length) % items.length;
		updateAutocompleteSelection(items);
	} else if (event.key === 'Enter') {
		event.preventDefault();
		const selected = items[window.currentAutocompleteIndex];
		if (selected) {
			const colIndex = parseInt(selected.getAttribute('data-col-index'));
			scrollToColumn(colIndex, boxId);
			autocomplete.classList.remove('visible');
			const input = document.getElementById(boxId + '_column_search');
			if (input) { input.value = ''; }
		}
	} else if (event.key === 'Escape') {
		event.preventDefault();
		autocomplete.classList.remove('visible');
	}
}

function updateAutocompleteSelection(items) {
	items.forEach((item, idx) => {
		if (idx === window.currentAutocompleteIndex) {
			item.classList.add('selected');
			item.scrollIntoView({ block: 'nearest' });
		} else {
			item.classList.remove('selected');
		}
	});
}

function scrollToColumn(colIndex, boxId) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }
	const rows = Array.isArray(state.rows) ? state.rows : [];
	if (rows.length === 0) { return; }
	const disp = Array.isArray(state.displayRowIndices) ? state.displayRowIndices : null;
	const firstRow = (disp && disp.length > 0) ? disp[0] : 0;

	// Select first cell in that column first
	selectCell(firstRow, colIndex, boxId);

	// Then scroll the container to center the column
	setTimeout(() => {
		const cell = document.querySelector('#' + boxId + '_table td[data-row="' + firstRow + '"][data-col="' + colIndex + '"]');
		if (cell) {
			cell.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
		}
	}, 100);
}

function copySelectionToClipboard(boxId) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }

	// Check if any rows are selected
	if (state.selectedRows.size > 0) {
		// Copy selected rows in tab-delimited format
		const rowIndices = Array.from(state.selectedRows).sort((a, b) => a - b);
		const textToCopy = rowIndices.map(rowIdx => {
			const row = state.rows[rowIdx];
			return row.join('\t');
		}).join('\n');

		navigator.clipboard.writeText(textToCopy).then(() => {
			console.log('Copied ' + rowIndices.length + ' row(s) to clipboard');
		}).catch(err => {
			console.error('Failed to copy rows:', err);
		});
	} else if (state.selectedCell) {
		// Copy single cell value
		const cell = state.selectedCell;
		const value = state.rows[cell.row][cell.col];

		navigator.clipboard.writeText(value).then(() => {
			console.log('Copied cell value to clipboard:', value);
		}).catch(err => {
			console.error('Failed to copy cell:', err);
		});
	}
}
