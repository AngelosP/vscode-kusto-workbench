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

function __kustoGetFilterIconSvg(size) {
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

function __kustoGetSelectAllIconSvg(size) {
	const s = (typeof size === 'number' && isFinite(size) && size > 0) ? Math.floor(size) : 14;
	return (
		'<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<rect x="2.5" y="2.5" width="11" height="11" rx="2" ry="2" />' +
		'<path d="M4.8 8.2l2 2 4.5-4.6" />' +
		'</svg>'
	);
}

function __kustoGetDeselectAllIconSvg(size) {
	const s = (typeof size === 'number' && isFinite(size) && size > 0) ? Math.floor(size) : 14;
	return (
		'<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<rect x="2.5" y="2.5" width="11" height="11" rx="2" ry="2" />' +
		'<path d="M4.6 8h6.8" />' +
		'</svg>'
	);
}

const __KUSTO_NULL_EMPTY_KEY = '__kusto_null_empty__';

function __kustoGetCloseIconSvg(size) {
	const s = (typeof size === 'number' && isFinite(size) && size > 0) ? Math.floor(size) : 14;
	return (
		'<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M4 4l8 8" />' +
		'<path d="M12 4l-8 8" />' +
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

function __kustoComputeSortedRowIndices(rows, sortSpec, baseIndices) {
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
	decorated.sort((a, b) => {
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

function __kustoEnsureDisplayRowIndexMaps(state) {
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

function __kustoEnsureColumnFiltersMap(state) {
	if (!state) return {};
	if (!state.columnFilters || typeof state.columnFilters !== 'object') {
		state.columnFilters = {};
	}
	return state.columnFilters;
}

function __kustoGetRawCellValue(cell) {
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

function __kustoIsNullOrEmpty(val) {
	try {
		if (val === null || val === undefined) return true;
		if (typeof val === 'string') return val.trim().length === 0;
		return false;
	} catch {
		return false;
	}
}

function __kustoTryParseNumber(val) {
	if (val === null || val === undefined) return null;
	if (typeof val === 'number') return isFinite(val) ? val : null;
	if (typeof val === 'boolean') return val ? 1 : 0;
	const s = String(val).trim();
	if (!s) return null;
	if (!/^[+-]?(?:\d+\.?\d*|\d*\.?\d+)(?:[eE][+-]?\d+)?$/.test(s)) return null;
	const n = parseFloat(s);
	return isFinite(n) ? n : null;
}

function __kustoTryParseDateMs(val) {
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

function __kustoInferColumnType(state, colIndex, rowIndicesForInference) {
	try {
		const rows = Array.isArray(state && state.rows) ? state.rows : [];
		const indices = Array.isArray(rowIndicesForInference)
			? rowIndicesForInference
			: (Array.isArray(state && state.displayRowIndices) ? state.displayRowIndices : rows.map((_, i) => i));
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

function __kustoGetRowIndicesExcludingColumnFilter(state, excludeColIndex) {
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

function __kustoNormalizeStringForFilter(val) {
	try {
		if (val === null || val === undefined) return '';
		return String(val);
	} catch {
		return '';
	}
}

function __kustoRowMatchesNullPolicy(raw, spec) {
	const isEmpty = __kustoIsNullOrEmpty(raw);
	const includeNullEmpty = !(spec && spec.includeNullEmpty === false);
	const includeNotNullEmpty = !(spec && spec.includeNotNullEmpty === false);
	if (isEmpty) return includeNullEmpty;
	return includeNotNullEmpty;
}

function __kustoRowMatchesColumnFilter(state, rowIdx, colIndex, spec) {
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

			const matchesRule = (rule) => {
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

function __kustoComputeUniqueValueKeys(state, colIndex, rowIndices) {
	const rows = Array.isArray(state && state.rows) ? state.rows : [];
	const indices = Array.isArray(rowIndices) ? rowIndices : rows.map((_, i) => i);
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
	keys.sort((a, b) => {
		const ca = counts.get(a) || 0;
		const cb = counts.get(b) || 0;
		if (cb !== ca) return cb - ca;
		try { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); } catch { return a < b ? -1 : (a > b ? 1 : 0); }
	});
	return { keys, counts, nullCount, truncated };
}

function __kustoNormalizeDraftFilter(state, colIndex, draft) {
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
		const allKeys = ([]).concat((uniq.nullCount > 0) ? [__KUSTO_NULL_EMPTY_KEY] : [], uniq.keys);
		const allowed = Array.isArray(spec.allowedValues) ? spec.allowedValues.filter(v => typeof v === 'string') : [];
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
		rules = rules.filter(r => r && typeof r === 'object' && String(r.op || ''));
		rules = rules.map(r => ({ ...r, join: (String(r.join || '') === 'or') ? 'or' : 'and' }));
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
			const needsRank = rules.some(r => {
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
				sortedValues.sort((a, b) => a - b);
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

function __kustoGetRulesCombineEnabledFromDom(boxId) {
	try {
		const el = document.getElementById(boxId + '_filter_rules_combine_toggle');
		if (!el) return false;
		const v = String(el.getAttribute('aria-checked') || 'false');
		return v === 'true';
	} catch {
		return false;
	}
}

function __kustoSetRulesCombineEnabled(boxId, enabled) {
	try {
		if (window.__kustoActiveFilterPopover) {
			window.__kustoActiveFilterPopover.draftCombine = !!enabled;
		}
		const el = document.getElementById(boxId + '_filter_rules_combine_toggle');
		if (!el) return;
		el.setAttribute('aria-checked', enabled ? 'true' : 'false');
		el.classList.toggle('on', !!enabled);
		el.classList.toggle('off', !enabled);
		el.textContent = enabled ? 'On' : 'Off';
	} catch { /* ignore */ }
}

function __kustoToggleRulesCombine(boxId) {
	try {
		const enabled = __kustoGetRulesCombineEnabledFromDom(boxId);
		__kustoSetRulesCombineEnabled(boxId, !enabled);
	} catch { /* ignore */ }
}

function __kustoGetRulesJoinOpFromDom(boxId) {
	try {
		const el = document.getElementById(boxId + '_filter_rules_join');
		if (!el) return 'and';
		const v = String(el.getAttribute('data-join') || 'and');
		return (v === 'or') ? 'or' : 'and';
	} catch {
		return 'and';
	}
}

function __kustoSetRulesJoinOp(boxId, joinOp) {
	try {
		const op = (String(joinOp) === 'or') ? 'or' : 'and';
		if (window.__kustoActiveFilterPopover) {
			window.__kustoActiveFilterPopover.draftRulesJoinOp = op;
		}
		const el = document.getElementById(boxId + '_filter_rules_join');
		if (el) el.setAttribute('data-join', op);
		const andBtn = document.getElementById(boxId + '_filter_rules_join_and');
		const orBtn = document.getElementById(boxId + '_filter_rules_join_or');
		if (andBtn) andBtn.classList.toggle('active', op === 'and');
		if (orBtn) orBtn.classList.toggle('active', op === 'or');
	} catch { /* ignore */ }
}

function __kustoApplyFiltersAndRerender(boxId) {
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
		const infoSpan = document.getElementById(boxId + '_search_info');
		const prevBtn = document.getElementById(boxId + '_search_prev');
		const nextBtn = document.getElementById(boxId + '_search_next');
		if (infoSpan) infoSpan.textContent = '';
		if (prevBtn) prevBtn.disabled = true;
		if (nextBtn) nextBtn.disabled = true;
		document.querySelectorAll('#' + boxId + '_table td.search-match, #' + boxId + '_table td.search-match-current')
			.forEach(cell => {
				cell.classList.remove('search-match', 'search-match-current');
			});
	} catch { /* ignore */ }

	__kustoEnsureDisplayRowIndexMaps(state);
	__kustoRerenderResultsTable(boxId);
	try { schedulePersist && schedulePersist('filter'); } catch { /* ignore */ }
}

function closeColumnFilterPopover() {
	try {
		if (!window.__kustoActiveFilterPopover) return;
		const { elId } = window.__kustoActiveFilterPopover;
		const el = elId ? document.getElementById(elId) : null;
		if (el) el.remove();
	} catch { /* ignore */ }
	try { window.__kustoActiveFilterPopover = null; } catch { /* ignore */ }
}

function closeColumnFilterDialogOnBackdrop(event) {
	try {
		if (!event || !window.__kustoActiveFilterPopover) return;
		if (event.target !== event.currentTarget) return;
		closeColumnFilterPopover();
	} catch { /* ignore */ }
}

function __kustoEnsureFilterGlobalCloseHandler() {
	if (window.__kustoFilterGlobalCloseHandlerInstalled) return;
	window.__kustoFilterGlobalCloseHandlerInstalled = true;
	document.addEventListener('click', (event) => {
		try {
			if (!window.__kustoActiveFilterPopover) return;
			const elId = window.__kustoActiveFilterPopover.elId;
			const el = elId ? document.getElementById(elId) : null;
			if (!el) {
				window.__kustoActiveFilterPopover = null;
				return;
			}
			const target = event && event.target;
			if (target && (el.contains(target) || (target.closest && target.closest('.column-menu-btn')))) {
				return;
			}
			closeColumnFilterPopover();
		} catch {
			// ignore
		}
	}, true);
}

function openColumnFilter(event, colIndex, boxId) {
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
	window.__kustoActiveFilterPopover = { boxId, colIndex: colIdx, mode, dataType: inferredType, elId: modalId, dialogId };
	dialog.innerHTML = __kustoRenderFilterPopoverHtml(boxId, colIdx);
	document.body.appendChild(modal);
}

function __kustoRenderFilterPopoverHtml(boxId, colIdx) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return '';
	const cols = Array.isArray(state.columns) ? state.columns : [];
	const colName = cols[colIdx] !== undefined ? String(cols[colIdx]) : ('Column ' + String(colIdx));
	const active = window.__kustoActiveFilterPopover;
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
		const allPossibleKeys = ([]).concat((uniq.nullCount > 0) ? [__KUSTO_NULL_EMPTY_KEY] : [], uniq.keys);
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
			'<input type="text" class="kusto-filter-search kusto-filter-values-search" id="' + boxId + '_filter_value_search" placeholder="Search values..." oninput="__kustoFilterSearchValues(\'' + __kustoEscapeJsStringLiteral(boxId) + '\', ' + String(colIdx) + ')" />' +
			'<button type="button" class="kusto-filter-mini-btn" onclick="__kustoFilterSetAllValues(\'' + __kustoEscapeJsStringLiteral(boxId) + '\', ' + String(colIdx) + ', true)" title="Select all" aria-label="Select all"><span class="kusto-filter-mini-btn-icon">' + __kustoGetSelectAllIconSvg(14) + '</span>Select all</button>' +
			'<button type="button" class="kusto-filter-mini-btn" onclick="__kustoFilterSetAllValues(\'' + __kustoEscapeJsStringLiteral(boxId) + '\', ' + String(colIdx) + ', false)" title="Deselect all" aria-label="Deselect all"><span class="kusto-filter-mini-btn-icon">' + __kustoGetDeselectAllIconSvg(14) + '</span>Deselect all</button>' +
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
			uniq.keys.map(k => {
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
		'<button type="button" class="refresh-btn close-btn kusto-filter-close-btn" onclick="closeColumnFilterPopover()" title="Close" aria-label="Close">' + __kustoGetCloseIconSvg(14) + '</button>' +
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
		'<button type="button" class="kusto-filter-btn" onclick="applyColumnFilter(\'' + __kustoEscapeJsStringLiteral(boxId) + '\', ' + String(colIdx) + ')"><span class="kusto-filter-btn-icon">' + __kustoGetFilterIconSvg(14) + '</span>Apply</button>' +
		'</div>'
	);

	return header + modes + '<div class="kusto-filter-body">' + body + '</div>' + footer;
}

function __kustoFilterSearchValues(boxId, colIdx) {
	try {
		const q = String(((document.getElementById(boxId + '_filter_value_search') || {}).value) || '').trim().toLowerCase();
		const list = document.getElementById(boxId + '_filter_values_list');
		if (!list) return;
		const items = Array.from(list.querySelectorAll('label.kusto-filter-value'));
		for (const it of items) {
			const t = String((it && it.getAttribute && it.getAttribute('data-value-text')) || '').toLowerCase();
			it.style.display = (!q || t.includes(q)) ? '' : 'none';
		}
	} catch { /* ignore */ }
}

function __kustoFilterSetAllValues(boxId, colIdx, checked) {
	try {
		const list = document.getElementById(boxId + '_filter_values_list');
		if (!list) return;
		const cbs = Array.from(list.querySelectorAll('input.kusto-filter-value-cb'));
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

function __kustoGetValuesAllowedFromSpec(spec) {
	try {
		if (!spec || typeof spec !== 'object') return null;
		if (spec.kind === 'values' && Array.isArray(spec.allowedValues)) return spec.allowedValues;
		if (spec.kind === 'compound' && spec.values && Array.isArray(spec.values.allowedValues)) return spec.values.allowedValues;
		return null;
	} catch {
		return null;
	}
}

function __kustoGetRulesSpecFromExisting(existing, dataType) {
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
				const r = { op: String(existing.op || '') };
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

function __kustoRenderRulesListHtml(boxId, colIdx, dataType, existing) {
	const ruleSpec = __kustoGetRulesSpecFromExisting(existing, dataType);
	const dt = String(ruleSpec.dataType || dataType || 'string');
	const rules = Array.isArray(ruleSpec.rules) ? ruleSpec.rules.slice() : [];
	// Always show a trailing empty row.
	if (rules.length === 0 || (rules[rules.length - 1] && String(rules[rules.length - 1].op || '') !== '')) {
		rules.push({ op: '' });
	}

	const isUniqueOp = (op) => {
		const v = String(op || '');
		return v === 'isEmpty' || v === 'isNotEmpty';
	};
	const usedUniqueOps = new Set(
		rules
			.map(r => (r && r.op) ? String(r.op) : '')
			.filter(op => op && isUniqueOp(op))
	);
	let lastRealRuleIdx = -1;
	for (let i = 0; i < rules.length; i++) {
		const op = rules[i] && rules[i].op ? String(rules[i].op) : '';
		if (op) lastRealRuleIdx = i;
	}

	const ops = __kustoGetRuleOpsForType(dt);
	const optionsHtml = (selectedOp) => {
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
					.map(o => '<option value="' + o.v + '"' + (op === o.v ? ' selected' : '') + '>' + o.t + '</option>')
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

function __kustoGetRuleOpsForType(dataType) {
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

function __kustoRenderRuleRowInputsHtml(boxId, dataType, rule) {
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

function __kustoCaptureRulesFromDom(boxId) {
	try {
		const list = document.getElementById(boxId + '_filter_rules_list');
		if (!list) return [];
		const rows = Array.from(list.querySelectorAll('.kusto-filter-rule-row'));
		return rows.map(row => {
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

function __kustoSetRuleJoin(boxId, colIdx, ruleIdx, joinOp) {
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
		const andBtn = row.querySelector('.kusto-filter-rule-join-btn.and');
		const orBtn = row.querySelector('.kusto-filter-rule-join-btn.or');
		if (andBtn) andBtn.classList.toggle('active', op === 'and');
		if (orBtn) orBtn.classList.toggle('active', op === 'or');
		try {
			if (window.__kustoActiveFilterPopover) {
				window.__kustoActiveFilterPopover.draftRules = __kustoCaptureRulesFromDom(boxId);
			}
		} catch { /* ignore */ }
	} catch { /* ignore */ }
}

function __kustoOnRuleRowOpChanged(boxId, colIdx, ruleIdx) {
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
			currentRules.push({ op: '' });
		}
		const listEl = document.getElementById(boxId + '_filter_rules_list');
		if (!listEl) return;
		listEl.innerHTML = __kustoRenderRulesListHtml(boxId, colIndex, inferredType, { kind: 'rules', dataType: inferredType, rules: currentRules });
	} catch {
		// ignore
	}
}

function __kustoDeleteRuleRow(boxId, colIdx, ruleIdx) {
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
			rules.push({ op: '' });
		}
		const listEl = document.getElementById(boxId + '_filter_rules_list');
		if (!listEl) return;
		listEl.innerHTML = __kustoRenderRulesListHtml(boxId, colIndex, inferredType, { kind: 'rules', dataType: inferredType, rules });
	} catch {
		// ignore
	}
}

function __kustoRenderRulesEditorHtml(boxId, colIdx, dataType, existing) {
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
		.concat(ops.map(o => '<option value="' + o.v + '"' + (op === o.v ? ' selected' : '') + '>' + o.t + '</option>'))
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

function __kustoToDateTimeLocalValue(isoOrRaw) {
	try {
		const ms = __kustoTryParseDateMs(isoOrRaw);
		if (ms === null) return '';
		const d = new Date(ms);
		const pad = (n) => String(n).padStart(2, '0');
		return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
	} catch {
		return '';
	}
}

function __kustoFromDateTimeLocalValue(v) {
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

function __kustoSetFilterMode(boxId, colIdx, mode) {
	if (!window.__kustoActiveFilterPopover) return;
	// Capture unsaved UI state when switching modes.
	try {
		const current = String(window.__kustoActiveFilterPopover.mode || 'values');
		if (current === 'values') {
			const list = document.getElementById(boxId + '_filter_values_list');
			if (list) {
				const allowed = [];
				const cbs = Array.from(list.querySelectorAll('input.kusto-filter-value-cb'));
				for (const cb of cbs) {
					if (cb && cb.checked) allowed.push(String(cb.value || ''));
				}
				window.__kustoActiveFilterPopover.draftValuesAllowed = allowed;
			}
		} else {
			window.__kustoActiveFilterPopover.draftRules = __kustoCaptureRulesFromDom(boxId);
			window.__kustoActiveFilterPopover.draftCombine = __kustoGetRulesCombineEnabledFromDom(boxId);
		}
	} catch { /* ignore */ }

	window.__kustoActiveFilterPopover.mode = (String(mode) === 'rules') ? 'rules' : 'values';
	const dialogId = window.__kustoActiveFilterPopover.dialogId || window.__kustoActiveFilterPopover.elId;
	const el = dialogId ? document.getElementById(dialogId) : null;
	if (!el) return;
	// Re-infer type against the current context.
	try {
		const state = __kustoGetResultsState(boxId);
		if (state) {
			const base = __kustoGetRowIndicesExcludingColumnFilter(state, colIdx);
			window.__kustoActiveFilterPopover.dataType = __kustoInferColumnType(state, colIdx, base);
		}
	} catch { /* ignore */ }
	el.innerHTML = __kustoRenderFilterPopoverHtml(boxId, colIdx);
}

function __kustoOnFilterOpChanged(boxId, colIdx) {
	try {
		const pop = window.__kustoActiveFilterPopover;
		if (!pop) return;
		const state = __kustoGetResultsState(boxId);
		if (!state) return;
		const baseRowIndices = __kustoGetRowIndicesExcludingColumnFilter(state, colIdx);
		pop.dataType = __kustoInferColumnType(state, colIdx, baseRowIndices);

		const op = String(((document.getElementById(boxId + '_filter_op') || {}).value) || '');
		const a = document.getElementById(boxId + '_filter_a');
		const b = document.getElementById(boxId + '_filter_b');
		const n = document.getElementById(boxId + '_filter_n');
		const last = document.querySelector('#' + (pop.elId || '') + ' .kusto-filter-last');

		if (op === 'isEmpty' || op === 'isNotEmpty') {
			if (a) a.style.display = 'none';
			if (b) b.style.display = 'none';
			if (n) n.style.display = 'none';
			if (last) last.style.display = 'none';
			return;
		}

		if (pop.dataType === 'date') {
			if (a) a.style.display = (op === 'before' || op === 'after' || op === 'between') ? '' : 'none';
			if (b) b.style.display = (op === 'between') ? '' : 'none';
			if (last) last.style.display = (op === 'last') ? '' : 'none';
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

function __kustoFilterToggleAllValues(boxId, colIdx) {
	try {
		const list = document.getElementById(boxId + '_filter_values_list');
		const all = document.getElementById(boxId + '_filter_all');
		if (!list || !all) return;
		const cbs = Array.from(list.querySelectorAll('input.kusto-filter-value-cb'));
		for (const cb of cbs) {
			cb.checked = !!all.checked;
		}
	} catch { /* ignore */ }
}

function applyColumnFilter(boxId, colIdx) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const colIndex = parseInt(String(colIdx), 10);
	if (!isFinite(colIndex) || colIndex < 0) return;
	const filters = __kustoEnsureColumnFiltersMap(state);
	const existing = filters[String(colIndex)] || null;
	const pop = window.__kustoActiveFilterPopover;
	const mode = pop && pop.mode ? String(pop.mode) : 'values';
	const baseRowIndices = __kustoGetRowIndicesExcludingColumnFilter(state, colIndex);
	const inferredType = __kustoInferColumnType(state, colIndex, baseRowIndices);

	let draft = null;
	if (mode === 'values') {
		const list = document.getElementById(boxId + '_filter_values_list');
		const allowed = [];
		if (list) {
			const cbs = Array.from(list.querySelectorAll('input.kusto-filter-value-cb'));
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
		let rules = __kustoCaptureRulesFromDom(boxId);
		rules = Array.isArray(rules) ? rules : [];
		// Drop trailing empty rules.
		rules = rules.filter(r => r && typeof r === 'object' && String(r.op || ''));
		// Normalize rule field shapes based on inferred type.
		rules = rules.map(r => {
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

function clearColumnFilter(boxId, colIdx) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const colIndex = parseInt(String(colIdx), 10);
	if (!isFinite(colIndex) || colIndex < 0) return;
	const filters = __kustoEnsureColumnFiltersMap(state);
	delete filters[String(colIndex)];
	__kustoApplyFiltersAndRerender(boxId);
	closeColumnFilterPopover();
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

	// Update filtered column links.
	try {
		const filters = __kustoEnsureColumnFiltersMap(state);
		for (let i = 0; i < (state.columns || []).length; i++) {
			const el = document.getElementById(boxId + '_filter_link_' + i);
			if (!el) continue;
			const active = !!filters[String(i)];
			el.innerHTML = active
				? ('<a href="#" class="kusto-filtered-link" onclick="openColumnFilter(event, ' + String(i) + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); return false;">(filtered)</a>')
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
	const displayRowIndices = Array.isArray(state.displayRowIndices) ? state.displayRowIndices : rows.map((_, i) => i);
	try {
		const countEl = document.getElementById(boxId + '_results_count');
		if (countEl) {
			const total = rows ? rows.length : 0;
			const shown = displayRowIndices ? displayRowIndices.length : 0;
			countEl.textContent = (shown !== total) ? (String(shown) + ' / ' + String(total)) : String(total);
		}
	} catch { /* ignore */ }

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
		'<strong>' + label + ':</strong> <span id="' + boxId + '_results_count">' + (rows ? rows.length : 0) + '</span> rows / ' + (columns ? columns.length : 0) + ' columns' +
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

	// Search through visible rows (respects current sort/filter)
	const rows = Array.isArray(state.rows) ? state.rows : [];
	const displayRowIndices = Array.isArray(state.displayRowIndices) ? state.displayRowIndices : rows.map((_, i) => i);
	displayRowIndices.forEach((rowIdx) => {
		const row = rows[rowIdx] || [];
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
