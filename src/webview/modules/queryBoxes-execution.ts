// Query execution, result handling, comparison, optimization — extracted from queryBoxes.ts
// Window bridge exports at bottom for remaining legacy callers.
export {};

const _win = window;

function __kustoSetResultsVisible( boxId: any, visible: any) {
	try {
		if (!window.__kustoResultsVisibleByBoxId || typeof window.__kustoResultsVisibleByBoxId !== 'object') {
			window.__kustoResultsVisibleByBoxId = {};
		}
		window.__kustoResultsVisibleByBoxId[boxId] = !!visible;
	} catch { /* ignore */ }
	try { __kustoUpdateQueryResultsToggleButton(boxId); } catch { /* ignore */ }
	try { __kustoApplyResultsVisibility(boxId); } catch { /* ignore */ }
}

function __kustoLockCacheForBenchmark( boxId: any) {
	const msg = 'When doing performance benchmarks we cannot use caching.';
	try {
		const checkbox = document.getElementById(boxId + '_cache_enabled') as any;
		const valueInput = document.getElementById(boxId + '_cache_value') as any;
		const unitSelect = document.getElementById(boxId + '_cache_unit') as any;
		if (checkbox) {
			checkbox.checked = false;
			checkbox.disabled = true;
			checkbox.title = msg;
			try {
				const label = checkbox.closest('label');
				if (label) {
					label.title = msg;
				}
			} catch { /* ignore */ }
		}
		if (valueInput) {
			valueInput.disabled = true;
			valueInput.title = msg;
		}
		if (unitSelect) {
			unitSelect.disabled = true;
			unitSelect.title = msg;
		}
		try { _win.toggleCacheControls(boxId); } catch { /* ignore */ }
		try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
	} catch {
		// ignore
	}
}

function __kustoNormalizeCellForComparison( cell: any) {
	const stripNumericGrouping = (s: any) => {
		try {
			return String(s).trim().replace(/[, _]/g, '');
		} catch {
			return '';
		}
	};
	const isNumericString = (s: any) => {
		try {
			const t = stripNumericGrouping(s);
			if (!t) return false;
			return /^[+-]?(?:\d+\.?\d*|\d*\.?\d+)(?:[eE][+-]?\d+)?$/.test(t);
		} catch {
			return false;
		}
	};
	const tryParseDateMs = (v: any) => {
		try {
			if (v instanceof Date) {
				const t = v.getTime();
				return isFinite(t) ? t : null;
			}
			const s = String(v).trim();
			if (!s) return null;
			// Don't treat pure numbers as dates.
			if (isNumericString(s)) return null;
			// First attempt: native parse
			let t = Date.parse(s);
			if (isFinite(t)) return t;
			// Kusto-ish: "YYYY-MM-DD HH:mm:ss(.fffffff)?(Z)?" -> convert to ISO-ish
			let iso = s;
			if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(iso)) {
				iso = iso.replace(' ', 'T');
			}
			// Trim fractional seconds beyond milliseconds for JS Date.parse
			iso = iso.replace(/\.(\d{3})\d+/, '.$1');
			// If it looks like a timestamp but lacks timezone, treat as UTC to stabilize comparisons.
			if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(iso)) {
				iso = iso + 'Z';
			}
			t = Date.parse(iso);
			return isFinite(t) ? t : null;
		} catch {
			return null;
		}
	};
	const stableStringify = (obj: any) => {
		const seen = new Set();
		const walk = (v: any): any => {
			if (v === null || v === undefined) return v;
			const t = typeof v;
			if (t === 'string' || t === 'number' || t === 'boolean') return v;
			if (v instanceof Date) {
				const ms = v.getTime();
				return isFinite(ms) ? { $date: ms } : { $date: String(v) };
			}
			if (t !== 'object') return String(v);
			if (seen.has(v)) return '[circular]';
			seen.add(v);
			if (Array.isArray(v)) {
				return v.map(walk);
			}
			const out: any = {};
			for (const k of Object.keys(v).sort()) {
				try {
					out[k] = walk(v[k]);
				} catch {
					out[k] = '[unreadable]';
				}
			}
			seen.delete(v);
			return out;
		};
		try {
			return JSON.stringify(walk(obj));
		} catch {
			try { return String(obj); } catch { return '[unstringifiable]'; }
		}
	};
	const normalize = (v: any) => {
		try {
			if (v === null || v === undefined) return ['n', null];
			const t = typeof v;
			if (t === 'number') {
				return ['num', isFinite(v) ? v : String(v)];
			}
			if (t === 'boolean') return ['bool', v ? 1 : 0];
			if (t === 'string') {
				const s = String(v);
				if (isNumericString(s)) {
					const num = parseFloat(stripNumericGrouping(s));
					if (isFinite(num)) return ['num', num];
				}
				const ms = tryParseDateMs(s);
				if (ms !== null) return ['date', ms];
				return ['str', s];
			}
			if (v instanceof Date) {
				const ms = v.getTime();
				return ['date', isFinite(ms) ? ms : String(v)];
			}
			if (t !== 'object') return ['p', t, String(v)];
			// Common table-cell wrapper used by this webview.
			if (v && typeof v === 'object' && 'full' in v && v.full !== undefined && v.full !== null) {
				return normalize(v.full);
			}
			if (v && typeof v === 'object' && 'display' in v && v.display !== undefined && v.display !== null) {
				return normalize(v.display);
			}
			return ['obj', stableStringify(v)];
		} catch {
			try { return ['obj', String(v)]; } catch { return ['obj', '[uncomparable]']; }
		}
	};

	try {
		return normalize(cell);
	} catch {
		try { return ['obj', String(cell)]; } catch { return ['obj', '[uncomparable]']; }
	}
}

function __kustoRowKeyForComparison( row: any) {
	try {
		const r = Array.isArray(row) ? row : [];
		const norm = r.map(__kustoNormalizeCellForComparison);
		return JSON.stringify(norm);
	} catch {
		try { return String(row); } catch { return '[uncomparable-row]'; }
	}
}

function __kustoNormalizeColumnNameForComparison( name: any) {
	try {
		// Columns can be plain strings or {name, type} objects (Kusto column metadata).
		if (name && typeof name === 'object' && 'name' in name) {
			return String(name.name == null ? '' : name.name).trim().toLowerCase();
		}
		return String(name == null ? '' : name).trim().toLowerCase();
	} catch {
		return '';
	}
}

function __kustoGetNormalizedColumnNameList( state: any) {
	try {
		const cols = Array.isArray(state && state.columns) ? state.columns : [];
		return cols.map(__kustoNormalizeColumnNameForComparison);
	} catch {
		return [];
	}
}

function __kustoDoColumnHeaderNamesMatch( sourceState: any, comparisonState: any) {
	try {
		const a = __kustoGetNormalizedColumnNameList(sourceState).slice().sort();
		const b = __kustoGetNormalizedColumnNameList(comparisonState).slice().sort();
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function __kustoGetColumnDifferences( sourceState: any, comparisonState: any) {
	// Returns { onlyInA: string[], onlyInB: string[] } with original (non-normalized) column names.
	try {
		const aCols = Array.isArray(sourceState && sourceState.columns) ? sourceState.columns : [];
		const bCols = Array.isArray(comparisonState && comparisonState.columns) ? comparisonState.columns : [];
		const aNorm = aCols.map(__kustoNormalizeColumnNameForComparison);
		const bNorm = bCols.map(__kustoNormalizeColumnNameForComparison);
		const aSet = new Set(aNorm);
		const bSet = new Set(bNorm);
		const onlyInA = [];
		const onlyInB = [];
		for (let i = 0; i < aCols.length; i++) {
			if (!bSet.has(aNorm[i])) {
				onlyInA.push(String(aCols[i]));
			}
		}
		for (let i = 0; i < bCols.length; i++) {
			if (!aSet.has(bNorm[i])) {
				onlyInB.push(String(bCols[i]));
			}
		}
		return { onlyInA, onlyInB };
	} catch {
		return { onlyInA: [], onlyInB: [] };
	}
}

function __kustoDoColumnOrderMatch( sourceState: any, comparisonState: any) {
	try {
		const a = __kustoGetNormalizedColumnNameList(sourceState);
		const b = __kustoGetNormalizedColumnNameList(comparisonState);
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function __kustoDoRowOrderMatch( sourceState: any, comparisonState: any) {
	try {
		const aRows = Array.isArray(sourceState && sourceState.rows) ? sourceState.rows : [];
		const bRows = Array.isArray(comparisonState && comparisonState.rows) ? comparisonState.rows : [];
		if (aRows.length !== bRows.length) return false;
		// Build column mapping by name for consistent comparison.
		const columnHeaderNamesMatch = __kustoDoColumnHeaderNamesMatch(sourceState, comparisonState);
		if (!columnHeaderNamesMatch) return false;
		const canonicalNames = __kustoGetNormalizedColumnNameList(sourceState).slice().sort();
		const aMap = __kustoBuildNameBasedColumnMapping(sourceState, canonicalNames);
		const bMap = __kustoBuildNameBasedColumnMapping(comparisonState, canonicalNames);
		const rowKeyForA = (row: any) => __kustoRowKeyForComparisonWithColumnMapping(row, aMap);
		const rowKeyForB = (row: any) => __kustoRowKeyForComparisonWithColumnMapping(row, bMap);
		for (let i = 0; i < aRows.length; i++) {
			if (rowKeyForA(aRows[i]) !== rowKeyForB(bRows[i])) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

function __kustoBuildColumnIndexMapForNames( state: any) {
	const cols = Array.isArray(state && state.columns) ? state.columns : [];
	const map = new Map();
	for (let i = 0; i < cols.length; i++) {
		const n = __kustoNormalizeColumnNameForComparison(cols[i]);
		if (!map.has(n)) {
			map.set(n, []);
		}
		map.get(n).push(i);
	}
	return map;
}

function __kustoBuildNameBasedColumnMapping( state: any, canonicalNames: any) {
	try {
		const map = __kustoBuildColumnIndexMapForNames(state);
		const mapping = [];
		for (const name of canonicalNames) {
			const list = map.get(name) || [];
			mapping.push(list.length ? list.shift() : -1);
			map.set(name, list);
		}
		return mapping;
	} catch {
		return [];
	}
}

function __kustoRowKeyForComparisonWithColumnMapping( row: any, mapping: any) {
	try {
		const r = Array.isArray(row) ? row : [];
		const norm = (mapping || []).map((idx: any) => __kustoNormalizeCellForComparison(idx >= 0 ? r[idx] : undefined));
		return JSON.stringify(norm);
	} catch {
		try { return String(row); } catch { return '[uncomparable-row]'; }
	}
}

function __kustoRowKeyForComparisonIgnoringColumnOrder( row: any) {
	try {
		const r = Array.isArray(row) ? row : [];
		const parts = r.map(__kustoNormalizeCellForComparison).map((c: any) => {
			try { return JSON.stringify(c); } catch { return String(c); }
		});
		parts.sort();
		return JSON.stringify(parts);
	} catch {
		try { return String(row); } catch { return '[uncomparable-row]'; }
	}
}

function __kustoAreResultsEquivalentWithDetails( sourceState: any, comparisonState: any) {
	try {
		const aCols = Array.isArray(sourceState && sourceState.columns) ? sourceState.columns : [];
		const bCols = Array.isArray(comparisonState && comparisonState.columns) ? comparisonState.columns : [];
		if (aCols.length !== bCols.length) {
			return {
				dataMatches: false,
				rowOrderMatches: false,
				columnOrderMatches: false,
				columnHeaderNamesMatch: false,
				reason: 'columnCountMismatch',
				columnCountA: aCols.length,
				columnCountB: bCols.length
			};
		}

		const aRows = Array.isArray(sourceState && sourceState.rows) ? sourceState.rows : [];
		const bRows = Array.isArray(comparisonState && comparisonState.rows) ? comparisonState.rows : [];
		if (aRows.length !== bRows.length) {
			return {
				dataMatches: false,
				rowOrderMatches: false,
				columnOrderMatches: false,
				columnHeaderNamesMatch: __kustoDoColumnHeaderNamesMatch(sourceState, comparisonState),
				reason: 'rowCountMismatch',
				rowCountA: aRows.length,
				rowCountB: bRows.length
			};
		}

		const columnHeaderNamesMatch = __kustoDoColumnHeaderNamesMatch(sourceState, comparisonState);
		const columnOrderMatches = __kustoDoColumnOrderMatch(sourceState, comparisonState);

		// Data equivalence prioritizes values:
		// - ignore row order always
		// - ignore column order always
		// - ignore column header names when needed
		let rowKeyForA = null;
		let rowKeyForB = null;
		let rowOrderMatches = false;

		if (columnHeaderNamesMatch) {
			// Align columns by header name (case-insensitive) using a canonical sorted name list.
			const canonicalNames = __kustoGetNormalizedColumnNameList(sourceState).slice().sort();
			const aMap = __kustoBuildNameBasedColumnMapping(sourceState, canonicalNames);
			const bMap = __kustoBuildNameBasedColumnMapping(comparisonState, canonicalNames);
			rowKeyForA = (row: any) => __kustoRowKeyForComparisonWithColumnMapping(row, aMap);
			rowKeyForB = (row: any) => __kustoRowKeyForComparisonWithColumnMapping(row, bMap);
			// Row order matches means: after aligning columns by name, each row matches in sequence.
			rowOrderMatches = true;
			for (let i = 0; i < aRows.length; i++) {
				if (rowKeyForA(aRows[i]) !== rowKeyForB(bRows[i])) {
					rowOrderMatches = false;
					break;
				}
			}
		} else {
			// No reliable column-name alignment; compare each row as an unordered multiset of cell values.
			rowKeyForA = __kustoRowKeyForComparisonIgnoringColumnOrder;
			rowKeyForB = __kustoRowKeyForComparisonIgnoringColumnOrder;
			rowOrderMatches = true;
			for (let i = 0; i < aRows.length; i++) {
				if (rowKeyForA(aRows[i]) !== rowKeyForB(bRows[i])) {
					rowOrderMatches = false;
					break;
				}
			}
		}

		const counts = new Map();
		for (const row of aRows) {
			const key = rowKeyForA(row);
			counts.set(key, (counts.get(key) || 0) + 1);
		}
		for (const row of bRows) {
			const key = rowKeyForB(row);
			const prev = counts.get(key) || 0;
			if (prev <= 0) {
				return {
					dataMatches: false,
					rowOrderMatches,
					columnOrderMatches,
					columnHeaderNamesMatch,
					reason: 'extraOrMismatchedRow',
					firstMismatchedRowKey: key
				};
			}
			if (prev === 1) {
				counts.delete(key);
			} else {
				counts.set(key, prev - 1);
			}
		}
		const dataMatches = counts.size === 0;
		if (!dataMatches) {
			let firstMissingKey = '';
			try {
				for (const k of counts.keys()) { firstMissingKey = k; break; }
			} catch { /* ignore */ }
			return {
				dataMatches,
				rowOrderMatches,
				columnOrderMatches,
				columnHeaderNamesMatch,
				reason: 'missingRow',
				firstMismatchedRowKey: firstMissingKey
			};
		}
		return { dataMatches, rowOrderMatches, columnOrderMatches, columnHeaderNamesMatch };
	} catch {
		return {
			dataMatches: false,
			rowOrderMatches: false,
			columnOrderMatches: false,
			columnHeaderNamesMatch: false,
			reason: 'exception'
		};
	}
}

function __kustoAreResultsEquivalent( sourceState: any, comparisonState: any) {
	try {
		return !!__kustoAreResultsEquivalentWithDetails(sourceState, comparisonState).dataMatches;
	} catch {
		return false;
	}
}

function __kustoDoResultHeadersMatch( sourceState: any, comparisonState: any) {
	try {
		// Historical name: keep behavior for any callers that expect strict header equality.
		const aCols = Array.isArray(sourceState && sourceState.columns) ? sourceState.columns : [];
		const bCols = Array.isArray(comparisonState && comparisonState.columns) ? comparisonState.columns : [];
		if (aCols.length !== bCols.length) return false;
		for (let i = 0; i < aCols.length; i++) {
			if (String(aCols[i]) !== String(bCols[i])) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function __kustoUpdateAcceptOptimizationsButton( comparisonBoxId: any, enabled: any, tooltip: any) {
	const btn = document.getElementById(comparisonBoxId + '_accept_btn') as any;
	if (!btn) {
		return;
	}
	btn.disabled = !enabled;
	btn.title = tooltip || (enabled ? 'Accept Optimizations' : 'Accept Optimizations is enabled when the optimized query has results.');
	btn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
}

function acceptOptimizations( comparisonBoxId: any) {
	try {
		const meta = (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) ? _win.optimizationMetadataByBoxId[comparisonBoxId] : null;
		const sourceBoxId = meta && meta.sourceBoxId ? meta.sourceBoxId : '';
		const optimizedQuery = meta && typeof meta.optimizedQuery === 'string' ? meta.optimizedQuery : '';
		if (!sourceBoxId || !optimizedQuery) {
			return;
		}
		if (_win.queryEditors[sourceBoxId] && typeof _win.queryEditors[sourceBoxId].setValue === 'function') {
			_win.queryEditors[sourceBoxId].setValue(optimizedQuery);
			try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
		}
		try { __kustoSetLinkedOptimizationMode(sourceBoxId, comparisonBoxId, false); } catch { /* ignore */ }
		// Remove comparison box and clear metadata links.
		try { _win.removeQueryBox(comparisonBoxId); } catch { /* ignore */ }
		try {
			if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
				delete _win.optimizationMetadataByBoxId[comparisonBoxId];
				if (_win.optimizationMetadataByBoxId[sourceBoxId]) {
					delete _win.optimizationMetadataByBoxId[sourceBoxId];
				}
			}
		} catch { /* ignore */ }
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Optimizations accepted: source query updated.' }); } catch { /* ignore */ }
	} catch {
		// ignore
	}
}

function __kustoUpdateQueryResultsToggleButton( boxId: any) {
	const btn = document.getElementById(boxId + '_results_toggle') as any;
	if (!btn) {
		return;
	}
	let visible = true;
	try {
		visible = !(window.__kustoResultsVisibleByBoxId && window.__kustoResultsVisibleByBoxId[boxId] === false);
	} catch { /* ignore */ }
	btn.classList.toggle('is-active', visible);
	btn.setAttribute('aria-selected', visible ? 'true' : 'false');
	btn.title = visible ? 'Hide results' : 'Show results';
	btn.setAttribute('aria-label', visible ? 'Hide results' : 'Show results');
}

function __kustoUpdateComparisonSummaryToggleButton( boxId: any) {
	const btn = document.getElementById(boxId + '_summary_toggle') as any;
	if (!btn) {
		return;
	}
	let visible = true;
	try {
		visible = !(window.__kustoComparisonSummaryVisibleByBoxId && window.__kustoComparisonSummaryVisibleByBoxId[boxId] === false);
	} catch { /* ignore */ }
	btn.classList.toggle('is-active', visible);
	btn.setAttribute('aria-selected', visible ? 'true' : 'false');
	btn.title = visible ? 'Hide comparison summary' : 'Show comparison summary';
	btn.setAttribute('aria-label', visible ? 'Hide comparison summary' : 'Show comparison summary');
}

function __kustoApplyResultsVisibility( boxId: any) {
	const wrapper = document.getElementById(boxId + '_results_wrapper') as any;
	if (!wrapper) {
		// Support non-query-box results (e.g. URL CSV preview) that render a results block
		// without the surrounding *_results_wrapper.
		let visible = true;
		try {
			visible = !(window.__kustoResultsVisibleByBoxId && window.__kustoResultsVisibleByBoxId[boxId] === false);
		} catch { /* ignore */ }
		try {
			const body = document.getElementById(boxId + '_results_body') as any;
			if (body) {
				body.style.display = visible ? '' : 'none';
			}
		} catch { /* ignore */ }
		try {
			const resultsDiv = document.getElementById(boxId + '_results') as any;
			if (resultsDiv && resultsDiv.classList) {
				resultsDiv.classList.toggle('is-results-hidden', !visible);
			}
		} catch { /* ignore */ }
		try {
			if (typeof _win.__kustoSetResultsToolsVisible === 'function') {
				_win.__kustoSetResultsToolsVisible(boxId, visible);
			}
			if (!visible && typeof _win.__kustoHideResultsTools === 'function') {
				_win.__kustoHideResultsTools(boxId);
			}
		} catch { /* ignore */ }
		return;
	}
	let visible = true;
	try {
		visible = !(window.__kustoResultsVisibleByBoxId && window.__kustoResultsVisibleByBoxId[boxId] === false);
	} catch { /* ignore */ }
	// Only show wrapper when there's content.
	const resultsDiv = document.getElementById(boxId + '_results') as any;
	const hasContent = !!(resultsDiv && String(resultsDiv.innerHTML || '').trim());
	let hasTable = false;
	try {
		hasTable = !!(resultsDiv && resultsDiv.querySelector && (resultsDiv.querySelector('.table-container') || resultsDiv.querySelector('kw-data-table')));
	} catch { /* ignore */ }

	// <kw-data-table> manages its own show/hide internally.
	// Respect the persisted visibility state; don't unconditionally show everything.
	if (resultsDiv && resultsDiv.querySelector && resultsDiv.querySelector('kw-data-table')) {
		wrapper.style.display = 'flex';
		const resizer = document.getElementById(boxId + '_results_resizer') as any;
		let visible = true;
		try {
			visible = !(window.__kustoResultsVisibleByBoxId && window.__kustoResultsVisibleByBoxId[boxId] === false);
		} catch { /* ignore */ }
		if (!visible) {
			// Collapsed: header-only height, hide resizer.
			// Preserve the current height so toggling results back on restores it.
			const curH = wrapper.style.height;
			if (curH && curH !== 'auto' && curH !== '40px') {
				try { wrapper.dataset.kustoPreviousHeight = curH; } catch { /* ignore */ }
			}
			wrapper.style.height = '40px';
			wrapper.style.overflow = 'hidden';
			if (resizer) resizer.style.display = 'none';
		} else {
			if (resizer) resizer.style.display = '';
			// Restore previous height if available.
			const prev = wrapper.dataset?.kustoPreviousHeight;
			if (prev) {
				wrapper.style.height = prev;
				wrapper.style.overflow = '';
				try { delete wrapper.dataset.kustoPreviousHeight; } catch { /* ignore */ }
			} else if (!wrapper.style.height || wrapper.style.height === 'auto') {
				wrapper.style.height = '300px';
			}
		}
		return;
	}

	wrapper.style.display = hasContent ? 'flex' : 'none';
	if (hasContent) {
		const body = document.getElementById(boxId + '_results_body') as any;
		if (body) {
			body.style.display = visible ? '' : 'none';
		}
		try {
			if (typeof _win.__kustoSetResultsToolsVisible === 'function') {
				_win.__kustoSetResultsToolsVisible(boxId, visible);
			}
			if (!visible && typeof _win.__kustoHideResultsTools === 'function') {
				_win.__kustoHideResultsTools(boxId);
			}
		} catch { /* ignore */ }
		const resizer = document.getElementById(boxId + '_results_resizer') as any;
		if (resizer) {
			// Cleaner UI: only show the resize handle when a successful results table is rendered.
			resizer.style.display = (visible && hasTable) ? '' : 'none';
		}
		try {
			if (!visible) {
				// Collapse to just the header (minimum height needed).
				if (wrapper.style.height && wrapper.style.height !== 'auto') {
					wrapper.dataset.kustoPreviousHeight = wrapper.style.height;
				}
				wrapper.style.height = 'auto';
				wrapper.style.minHeight = '0';
			} else if (!hasTable) {
				// Error-only (or non-table) content: hug content and hide resizer.
				try {
					if (wrapper.style.height && wrapper.style.height !== 'auto') {
						wrapper.dataset.kustoPrevSuccessHeight = wrapper.style.height;
					}
				} catch { /* ignore */ }
				wrapper.style.height = 'auto';
				wrapper.style.minHeight = '0';
			} else {
				// Successful results table: allow resizing.
				wrapper.style.minHeight = '120px';
				if (!wrapper.style.height || wrapper.style.height === 'auto') {
					if (wrapper.dataset.kustoPreviousHeight) {
						wrapper.style.height = wrapper.dataset.kustoPreviousHeight;
					} else if (wrapper.dataset.kustoPrevSuccessHeight) {
						wrapper.style.height = wrapper.dataset.kustoPrevSuccessHeight;
					} else {
						wrapper.style.height = '240px';
					}
				}
				// Guardrail: never allow the wrapper to become so tall that the table can't scroll.
				// A huge persisted/previous height makes the container as tall as the full table,
				// which removes the scrollbar and kills virtualization performance.
				try {
					const m = String(wrapper.style.height || '').trim().match(/^([0-9]+)px$/i);
					if (m) {
						const px = parseInt(m[1], 10);
						if (isFinite(px)) {
							const clamped = Math.max(120, Math.min(900, px));
							if (clamped !== px) {
								wrapper.style.height = clamped + 'px';
							}
						}
					}
				} catch { /* ignore */ }
			}
		} catch { /* ignore */ }
	}
}

function __kustoApplyComparisonSummaryVisibility( boxId: any) {
	const box = document.getElementById(boxId) as any;
	if (!box) {
		return;
	}
	const banner = box.querySelector('.comparison-summary-banner');
	if (!banner) {
		return;
	}
	try {
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId && _win.optimizationMetadataByBoxId[boxId] && _win.optimizationMetadataByBoxId[boxId].isComparison) {
			banner.style.display = '';
			return;
		}
	} catch { /* ignore */ }
	let visible = true;
	try {
		visible = !(window.__kustoComparisonSummaryVisibleByBoxId && window.__kustoComparisonSummaryVisibleByBoxId[boxId] === false);
	} catch { /* ignore */ }
	banner.style.display = visible ? '' : 'none';
}

function toggleQueryResultsVisibility( boxId: any) {
	try {
		if (!window.__kustoResultsVisibleByBoxId || typeof window.__kustoResultsVisibleByBoxId !== 'object') {
			window.__kustoResultsVisibleByBoxId = {};
		}
		const current = !(window.__kustoResultsVisibleByBoxId[boxId] === false);
		window.__kustoResultsVisibleByBoxId[boxId] = !current;
	} catch { /* ignore */ }
	try { __kustoUpdateQueryResultsToggleButton(boxId); } catch { /* ignore */ }
	try { __kustoApplyResultsVisibility(boxId); } catch { /* ignore */ }
	try {
		if (typeof window.__kustoOnResultsVisibilityToggled === 'function') {
			window.__kustoOnResultsVisibilityToggled(boxId);
		}
	} catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function toggleComparisonSummaryVisibility( boxId: any) {
	try {
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId && _win.optimizationMetadataByBoxId[boxId] && _win.optimizationMetadataByBoxId[boxId].isComparison) {
			// Optimized sections always show summary.
			return;
		}
	} catch { /* ignore */ }
	try {
		if (!window.__kustoComparisonSummaryVisibleByBoxId || typeof window.__kustoComparisonSummaryVisibleByBoxId !== 'object') {
			window.__kustoComparisonSummaryVisibleByBoxId = {};
		}
		const current = !(window.__kustoComparisonSummaryVisibleByBoxId[boxId] === false);
		window.__kustoComparisonSummaryVisibleByBoxId[boxId] = !current;
	} catch { /* ignore */ }
	try { __kustoUpdateComparisonSummaryToggleButton(boxId); } catch { /* ignore */ }
	try { __kustoApplyComparisonSummaryVisibility(boxId); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoEnsureCacheBackupMap() {
	if (!window.__kustoCacheBackupByBoxId || typeof window.__kustoCacheBackupByBoxId !== 'object') {
		window.__kustoCacheBackupByBoxId = {};
	}
	return window.__kustoCacheBackupByBoxId;
}

function __kustoBackupCacheSettings( boxId: any) {
	if (!boxId) {
		return;
	}
	const map = __kustoEnsureCacheBackupMap();
	if (map[boxId]) {
		return;
	}
	try {
		const enabledEl = document.getElementById(boxId + '_cache_enabled') as any;
		const valueEl = document.getElementById(boxId + '_cache_value') as any;
		const unitEl = document.getElementById(boxId + '_cache_unit') as any;
		map[boxId] = {
			enabled: enabledEl ? !!enabledEl.checked : true,
			value: valueEl ? (parseInt(valueEl.value) || 1) : 1,
			unit: unitEl ? String(unitEl.value || 'days') : 'days'
		};
	} catch {
		// ignore
	}
}

function __kustoRestoreCacheSettings( boxId: any) {
	if (!boxId) {
		return;
	}
	const map = __kustoEnsureCacheBackupMap();
	const backup = map[boxId];
	if (!backup) {
		// Ensure controls are re-enabled if we had disabled them.
		try {
			const enabledEl = document.getElementById(boxId + '_cache_enabled') as any;
			const valueEl = document.getElementById(boxId + '_cache_value') as any;
			const unitEl = document.getElementById(boxId + '_cache_unit') as any;
			if (enabledEl) { enabledEl.disabled = false; enabledEl.title = ''; }
			if (valueEl) { valueEl.disabled = false; valueEl.title = ''; }
			if (unitEl) { unitEl.disabled = false; unitEl.title = ''; }
			try { _win.toggleCacheControls(boxId); } catch { /* ignore */ }
		} catch { /* ignore */ }
		return;
	}
	try {
		const enabledEl = document.getElementById(boxId + '_cache_enabled') as any;
		const valueEl = document.getElementById(boxId + '_cache_value') as any;
		const unitEl = document.getElementById(boxId + '_cache_unit') as any;
		if (enabledEl) {
			enabledEl.checked = !!backup.enabled;
			enabledEl.disabled = false;
			enabledEl.title = '';
			try {
				const label = enabledEl.closest('label');
				if (label) { label.title = ''; }
			} catch { /* ignore */ }
		}
		if (valueEl) {
			valueEl.value = String(backup.value || 1);
			valueEl.disabled = false;
			valueEl.title = '';
		}
		if (unitEl) {
			unitEl.value = String(backup.unit || 'days');
			unitEl.disabled = false;
			unitEl.title = '';
		}
		try { _win.toggleCacheControls(boxId); } catch { /* ignore */ }
	} catch {
		// ignore
	}
	try { delete map[boxId]; } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoEnsureRunModeBackupMap() {
	if (!window.__kustoRunModeBackupByBoxId || typeof window.__kustoRunModeBackupByBoxId !== 'object') {
		window.__kustoRunModeBackupByBoxId = {};
	}
	return window.__kustoRunModeBackupByBoxId;
}

function __kustoBackupRunMode( boxId: any) {
	if (!boxId) return;
	const map = __kustoEnsureRunModeBackupMap();
	// Only back up once per optimization session.
	if (map[boxId] && typeof map[boxId].mode === 'string') {
		return;
	}
	try {
		map[boxId] = { mode: String(_win.getRunMode(boxId) || 'take100') };
	} catch {
		map[boxId] = { mode: 'take100' };
	}
}

function __kustoRestoreRunMode( boxId: any) {
	if (!boxId) return;
	const map = __kustoEnsureRunModeBackupMap();
	const backup = map[boxId];
	if (!backup || typeof backup.mode !== 'string') {
		return;
	}
	try {
		_win.setRunMode(boxId, String(backup.mode || 'take100'));
	} catch { /* ignore */ }
	try { delete map[boxId]; } catch { /* ignore */ }
}

function __kustoSetLinkedOptimizationMode( sourceBoxId: any, comparisonBoxId: any, active: any) {
	const ids = [String(sourceBoxId || '').trim(), String(comparisonBoxId || '').trim()].filter(Boolean);
	for (const id of ids) {
		const el = document.getElementById(id) as any;
		if (!el) continue;
		if (active) {
			try { __kustoBackupCacheSettings(id); } catch { /* ignore */ }
			try { __kustoBackupRunMode(id); } catch { /* ignore */ }
			try { _win.setRunMode(id, 'plain'); } catch { /* ignore */ }
			el.classList.add('has-linked-optimization');
		} else {
			el.classList.remove('has-linked-optimization');
			try { __kustoRestoreCacheSettings(id); } catch { /* ignore */ }
			try { __kustoRestoreRunMode(id); } catch { /* ignore */ }
		}
	}
}

// Toggle buttons, toolbar actions, share modal, toolbar overflow, tools dropdown,
// run modes, and global dropdown dismiss handlers are in queryBoxes-toolbar.ts.

function displayComparisonSummary( sourceBoxId: any, comparisonBoxId: any) {
	const sourceState = _win.__kustoGetResultsState(sourceBoxId);
	const comparisonState = _win.__kustoGetResultsState(comparisonBoxId);
	
	if (!sourceState || !comparisonState) {
		return;
	}

	const escapeHtml = (s: any) => {
		return String(s ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	};
	const getBoxLabel = (boxId: any) => {
		try {
			const name = _win.__kustoGetSectionName(boxId);
			return name || String(boxId || '').trim() || 'Dataset';
		} catch {
			return String(boxId || '').trim() || 'Dataset';
		}
	};
	const sourceLabel = getBoxLabel(sourceBoxId);
	const comparisonLabel = getBoxLabel(comparisonBoxId);
	const pluralRows = (n: any) => (Number(n) === 1 ? 'row' : 'rows');
	
	const sourceRows = sourceState.rows ? sourceState.rows.length : 0;
	const comparisonRows = comparisonState.rows ? comparisonState.rows.length : 0;
	const sourceCols = sourceState.columns ? sourceState.columns.length : 0;
	const comparisonCols = comparisonState.columns ? comparisonState.columns.length : 0;
	
	// Extract execution times
	const sourceExecTime = sourceState.metadata && sourceState.metadata.executionTime || '';
	const comparisonExecTime = comparisonState.metadata && comparisonState.metadata.executionTime || '';
	
	// Parse execution times (e.g., "123ms" or "1.23s")
	const parseExecTime = (timeStr: any) => {
		if (!timeStr) return null;
		const match = timeStr.match(/([\d.]+)\s*(ms|s)/);
		if (!match) return null;
		const value = parseFloat(match[1]);
		const unit = match[2];
		return unit === 's' ? value * 1000 : value; // Convert to ms
	};
	
	const sourceMs = parseExecTime(sourceExecTime);
	const comparisonMs = parseExecTime(comparisonExecTime);
	
	let perfMessage = '';
	if (sourceMs !== null && comparisonMs !== null && sourceMs > 0) {
		const diff = sourceMs - comparisonMs;
		const percentChange = ((diff / sourceMs) * 100).toFixed(1);
		if (diff > 0) {
			perfMessage = `<span style="color: #89d185;">\u2713 ${percentChange}% faster (${sourceExecTime} \u2192 ${comparisonExecTime})</span>`;
		} else if (diff < 0) {
			perfMessage = `<span style="color: #f48771;">\u26a0 ${Math.abs(Number(percentChange))}% slower (${sourceExecTime} \u2192 ${comparisonExecTime})</span>`;
		} else {
			perfMessage = `<span style="color: #cccccc;">\u2248 Same performance (${sourceExecTime})</span>`;
		}
	} else if (sourceExecTime && comparisonExecTime) {
		perfMessage = `<span style="color: #cccccc;">${sourceExecTime} \u2192 ${comparisonExecTime}</span>`;
	}

	// ─── Server-side statistics comparison ───
	const sourceStats = (sourceState.metadata && sourceState.metadata.serverStats) || null;
	const comparisonStats = (comparisonState.metadata && comparisonState.metadata.serverStats) || null;

	// Helper: format a delta metric line.
	// sourceVal/comparisonVal are numbers (or null/undefined to skip).
	// options: { emoji, label, formatter, lowerIsBetter (default true), unit (for raw fallback) }
	const formatDelta = (sourceVal: any, comparisonVal: any, opts: any) => {
		const emoji = opts.emoji || '';
		const label = opts.label || '';
		const fmt = opts.formatter || ((v: any) => String(v));
		const lowerIsBetter = opts.lowerIsBetter !== false;

		if (sourceVal == null || comparisonVal == null || !isFinite(sourceVal) || !isFinite(comparisonVal)) {
			return null; // not available
		}

		const sFormatted = fmt(sourceVal);
		const cFormatted = fmt(comparisonVal);

		if (sourceVal === 0 && comparisonVal === 0) {
			return `<div class="comparison-metric">${emoji} ${label}: <span style="color: #cccccc;">${sFormatted} \u2192 ${cFormatted} (no change)</span></div>`;
		}

		const diff = sourceVal - comparisonVal;
		if (diff === 0) {
			return `<div class="comparison-metric">${emoji} ${label}: <span style="color: #cccccc;">${sFormatted} \u2192 ${cFormatted} (no change)</span></div>`;
		}

		const base = sourceVal !== 0 ? sourceVal : 1;
		const pct = Math.abs((diff / base) * 100).toFixed(1);
		// "improved" means lower-is-better and value went down, or higher-is-better and value went up.
		const improved = lowerIsBetter ? (diff > 0) : (diff < 0);
		const verb = lowerIsBetter ? (improved ? 'less' : 'more') : (improved ? 'more' : 'less');
		const color = improved ? '#89d185' : '#f48771';
		const icon = improved ? '\u2713' : '\u26a0';

		return `<div class="comparison-metric">${emoji} ${label}: <span style="color: ${color};">${icon} ${pct}% ${verb} (${sFormatted} \u2192 ${cFormatted})</span></div>`;
	};

	// Formatters
	const fmtCpuMs = (ms: any) => {
		if (ms < 1000) { return ms.toFixed(1) + 'ms'; }
		return (ms / 1000).toFixed(3) + 's';
	};
	const fmtBytes = (bytes: any) => {
		if (bytes == null || !isFinite(bytes)) { return '?'; }
		if (bytes < 1024) { return bytes + ' B'; }
		if (bytes < 1024 * 1024) { return (bytes / 1024).toFixed(1) + ' KB'; }
		if (bytes < 1024 * 1024 * 1024) { return (bytes / (1024 * 1024)).toFixed(1) + ' MB'; }
		return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
	};
	const fmtNum = (n: any) => {
		if (n == null) { return '?'; }
		return Number(n).toLocaleString();
	};

	// Build per-metric lines (only shown when server stats are available for both)
	let cpuMessage = null;
	let memoryMessage = null;
	let extentsMessage = null;
	let cacheMessage = null;

	if (sourceStats && comparisonStats) {
		cpuMessage = formatDelta(sourceStats.cpuTimeMs, comparisonStats.cpuTimeMs, {
			emoji: '\uD83D\uDDA5\uFE0F', label: 'Server CPU', formatter: fmtCpuMs, lowerIsBetter: true
		});
		memoryMessage = formatDelta(sourceStats.peakMemoryPerNode, comparisonStats.peakMemoryPerNode, {
			emoji: '\uD83D\uDCBE', label: 'Peak memory', formatter: fmtBytes, lowerIsBetter: true
		});
		extentsMessage = formatDelta(sourceStats.extentsScanned, comparisonStats.extentsScanned, {
			emoji: '\uD83D\uDCCA', label: 'Extents scanned', formatter: fmtNum, lowerIsBetter: true
		});

		// Cache hit rate: compute as percentage hits/(hits+misses), compare the rates.
		const cacheRate = (stats: any) => {
			const mh = typeof stats.memoryCacheHits === 'number' ? stats.memoryCacheHits : 0;
			const mm = typeof stats.memoryCacheMisses === 'number' ? stats.memoryCacheMisses : 0;
			const dh = typeof stats.diskCacheHits === 'number' ? stats.diskCacheHits : 0;
			const dm = typeof stats.diskCacheMisses === 'number' ? stats.diskCacheMisses : 0;
			const hits = mh + dh;
			const total = hits + mm + dm;
			return total > 0 ? (hits / total) * 100 : null;
		};
		const sourceRate = cacheRate(sourceStats);
		const comparisonRate = cacheRate(comparisonStats);
		const fmtRate = (r: any) => r.toFixed(1) + '%';
		cacheMessage = formatDelta(sourceRate, comparisonRate, {
			emoji: '\uD83C\uDFAF', label: 'Cache hit rate', formatter: fmtRate, lowerIsBetter: false
		});
	}
	
	// Check data consistency.
	// Data matches if:
	// 1. Same columns (names match, order doesn't matter)
	// 2. Same rows (no unmatched rows in either dataset, order doesn't matter)
	const columnHeaderNamesMatch = __kustoDoColumnHeaderNamesMatch(sourceState, comparisonState);
	
	let rowsMatch = false;
	let commonCount = 0;
	let onlyACount = 0;
	let onlyBCount = 0;
	let countsLabel = '';
	try {
		const dv = (window && window.__kustoDiffView) ? window.__kustoDiffView : null;
		if (dv && typeof dv.buildModelFromResultsStates === 'function') {
			const model = dv.buildModelFromResultsStates(sourceState, comparisonState, { aLabel: sourceLabel, bLabel: comparisonLabel });
			const p = (model && model.partitions && typeof model.partitions === 'object') ? model.partitions : null;
			commonCount = Array.isArray(p && p.common) ? p.common.length : 0;
			onlyACount = Array.isArray(p && p.onlyA) ? p.onlyA.length : 0;
			onlyBCount = Array.isArray(p && p.onlyB) ? p.onlyB.length : 0;
			countsLabel =
				' (' +
				String(commonCount) + ' matching ' + pluralRows(commonCount) +
				', ' +
				String(onlyACount) + ' unmatched ' + pluralRows(onlyACount) + ' in ' + _win.escapeHtml(sourceLabel) +
				', ' +
				String(onlyBCount) + ' unmatched ' + pluralRows(onlyBCount) + ' in ' + _win.escapeHtml(comparisonLabel) +
				')';
			rowsMatch = (onlyACount === 0 && onlyBCount === 0);
		}
	} catch { /* ignore */ }

	// Data matches only if both columns AND rows match.
	const dataMatches = columnHeaderNamesMatch && rowsMatch;

	// Additional metadata for warnings (order differences don't affect data matching).
	const rowOrderMatches = __kustoDoRowOrderMatch(sourceState, comparisonState);
	const columnOrderMatches = __kustoDoColumnOrderMatch(sourceState, comparisonState);
	const warningNeeded = dataMatches && !(rowOrderMatches && columnOrderMatches);

	const yesNo = (v: any) => (v ? 'yes' : 'no');
	const warningTitle =
		'Order of rows matches: ' + yesNo(rowOrderMatches) + '\n' +
		'Order of columns matches: ' + yesNo(columnOrderMatches) + '\n' +
		'Names of column headers match: ' + yesNo(columnHeaderNamesMatch);

	let dataMessage = '';
	if (dataMatches) {
		dataMessage =
			'<span class="comparison-data-match">\u2713 Data matches</span>' +
			(warningNeeded
				? '<span class="comparison-warning-icon" title="' + warningTitle.replace(/"/g, '&quot;') + '">\u26a0</span>'
				: '');
	} else {
		// Determine if the difference is in columns, rows, or both.
		const columnDiff = __kustoGetColumnDifferences(sourceState, comparisonState);
		const hasColumnDiff = columnDiff.onlyInA.length > 0 || columnDiff.onlyInB.length > 0;
		const hasRowDiff = onlyACount > 0 || onlyBCount > 0;

		let diffLabel = '';
		let diffTitle = 'View diff';
		if (hasColumnDiff && !hasRowDiff) {
			// Only column differences
			const parts = [];
			if (columnDiff.onlyInA.length > 0) {
				parts.push(String(columnDiff.onlyInA.length) + ' missing ' + (columnDiff.onlyInA.length === 1 ? 'column' : 'columns') + ' in ' + _win.escapeHtml(comparisonLabel));
			}
			if (columnDiff.onlyInB.length > 0) {
				parts.push(String(columnDiff.onlyInB.length) + ' extra ' + (columnDiff.onlyInB.length === 1 ? 'column' : 'columns') + ' in ' + _win.escapeHtml(comparisonLabel));
			}
			diffLabel = ' (' + parts.join(', ') + ')';
			const titleParts = ['View diff'];
			if (columnDiff.onlyInA.length > 0) {
				titleParts.push('Missing in ' + comparisonLabel + ': ' + columnDiff.onlyInA.join(', '));
			}
			if (columnDiff.onlyInB.length > 0) {
				titleParts.push('Extra in ' + comparisonLabel + ': ' + columnDiff.onlyInB.join(', '));
			}
			diffTitle = titleParts.join('\n');
		} else if (hasRowDiff && !hasColumnDiff) {
			// Only row differences
			diffLabel = ' (' +
				String(commonCount) + ' matching ' + pluralRows(commonCount) +
				', ' +
				String(onlyACount) + ' unmatched ' + pluralRows(onlyACount) + ' in ' + _win.escapeHtml(sourceLabel) +
				', ' +
				String(onlyBCount) + ' unmatched ' + pluralRows(onlyBCount) + ' in ' + _win.escapeHtml(comparisonLabel) +
				')';
			diffTitle = 'View diff\nUnmatched rows: ' + String(onlyACount) + ' in ' + sourceLabel + ', ' + String(onlyBCount) + ' in ' + comparisonLabel;
		} else if (hasColumnDiff && hasRowDiff) {
			// Both column and row differences
			const colParts = [];
			if (columnDiff.onlyInA.length > 0) {
				colParts.push(String(columnDiff.onlyInA.length) + ' missing');
			}
			if (columnDiff.onlyInB.length > 0) {
				colParts.push(String(columnDiff.onlyInB.length) + ' extra');
			}
			diffLabel = ' (' + colParts.join('/') + ' columns, ' +
				String(onlyACount + onlyBCount) + ' unmatched ' + pluralRows(onlyACount + onlyBCount) + ')';
			diffTitle = 'View diff\nColumn differences and row differences detected.';
		}

		// Use JSON.stringify to produce a valid JS string literal (double-quoted) so the
		// inline onclick handler never breaks due to escaping.
		const aBoxIdLit = JSON.stringify(String(sourceBoxId || ''));
		const bBoxIdLit = JSON.stringify(String(comparisonBoxId || ''));
		dataMessage =
			'<span class="comparison-data-diff-icon" aria-hidden="true">\u26a0</span> ' +
			'<a href="#" class="comparison-data-diff comparison-diff-link" ' +
			"onclick='try{openDiffViewModal({ aBoxId: " + aBoxIdLit + ", bBoxId: " + bBoxIdLit + " })}catch{}; return false;' " +
			'title="' + diffTitle.replace(/"/g, '&quot;') + '">Data differs' + diffLabel + '</a>';
	}
	
	// Create or update comparison summary banner
	const comparisonBox = document.getElementById(comparisonBoxId) as any;
	if (!comparisonBox) {
		return;
	}
	
	// Find or create the banner element
	let banner = comparisonBox.querySelector('.comparison-summary-banner');
	if (!banner) {
		banner = document.createElement('div');
		banner.className = 'comparison-summary-banner';
		// Insert banner right before the editor wrapper (below the header).
		const editorWrapper = comparisonBox.querySelector('.query-editor-wrapper');
		if (editorWrapper && editorWrapper.parentNode) {
			editorWrapper.parentNode.insertBefore(banner, editorWrapper);
		}
	}
	
	banner.innerHTML = `
		<div class="comparison-summary-content">
			<strong>How do the two queries compare?</strong>
			<div class="comparison-metrics">
				<div class="comparison-metric">\u26a1 Execution speed: ${perfMessage}</div>
				${cpuMessage || ''}
				${memoryMessage || ''}
				${extentsMessage || ''}
				${cacheMessage || ''}
				<div class="comparison-metric">\ud83d\udccb Data returned: ${dataMessage}</div>
			</div>
		</div>
	`;
	try {
		const acceptTooltip = dataMatches
			? (warningNeeded
				? 'Data matches, but row/column ordering or header details differ. Accept optimizations with caution.'
				: 'Results match. Accept optimizations.')
			: 'Results differ. Accept optimizations is enabled — review the diff before accepting.';
		__kustoUpdateAcceptOptimizationsButton(comparisonBoxId, true, acceptTooltip);
	} catch { /* ignore */ }
	try { __kustoApplyComparisonSummaryVisibility(comparisonBoxId); } catch { /* ignore */ }

	// Notify the extension backend so it can coordinate validation retries.
	try {
		(_win.vscode as any).postMessage({
			type: 'comparisonSummary',
			sourceBoxId: String(sourceBoxId || ''),
			comparisonBoxId: String(comparisonBoxId || ''),
			dataMatches: !!dataMatches,
			headersMatch: !!columnHeaderNamesMatch,
			rowOrderMatches: !!rowOrderMatches,
			columnOrderMatches: !!columnOrderMatches
		});
	} catch { /* ignore */ }
}

function __kustoEnsureOptimizePrepByBoxId() {
	try {
		if (!window.__kustoOptimizePrepByBoxId || typeof window.__kustoOptimizePrepByBoxId !== 'object') {
			window.__kustoOptimizePrepByBoxId = {};
		}
		return window.__kustoOptimizePrepByBoxId;
	} catch {
		return {};
	}
}

function __kustoHideOptimizePromptForBox( boxId: any) {
	const host = document.getElementById(boxId + '_optimize_config') as any;
	if (host) {
		host.style.display = 'none';
		host.innerHTML = '';
	}
	try {
		const pending = __kustoEnsureOptimizePrepByBoxId();
		delete pending[boxId];
	} catch { /* ignore */ }

	try {
		const optimizeBtn = document.getElementById(boxId + '_optimize_btn') as any;
		if (optimizeBtn) {
			optimizeBtn.disabled = false;
			if (optimizeBtn.dataset && optimizeBtn.dataset.originalContent) {
				optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
				delete optimizeBtn.dataset.originalContent;
			}
		}
	} catch { /* ignore */ }

	try {
		__kustoSetOptimizeInProgress(boxId, false, '');
	} catch { /* ignore */ }
	try {
		if (typeof window.__kustoUpdateRunEnabledForBox === 'function') {
			window.__kustoUpdateRunEnabledForBox(boxId);
		}
	} catch { /* ignore */ }
}

function __kustoSetOptimizeInProgress( boxId: any, inProgress: any, statusText: any) {
	try {
		const statusEl = document.getElementById(boxId + '_optimize_status') as any;
		const cancelBtn = document.getElementById(boxId + '_optimize_cancel') as any;
		const optimizeBtn = document.getElementById(boxId + '_optimize_btn') as any;
		if (!statusEl || !cancelBtn) {
			return;
		}
		const on = !!inProgress;
		try {
			if (optimizeBtn && optimizeBtn.dataset) {
				if (on) {
					optimizeBtn.dataset.kustoOptimizeInProgress = '1';
					optimizeBtn.disabled = true;
				} else {
					delete optimizeBtn.dataset.kustoOptimizeInProgress;
				}
			}
		} catch { /* ignore */ }
		statusEl.style.display = on ? '' : 'none';
		cancelBtn.style.display = on ? '' : 'none';
		if (on) {
			statusEl.textContent = String(statusText || 'Optimizing…');
			cancelBtn.disabled = false;

			try {
				const text = String(statusText || '');
				const shouldStartSpinner = /waiting\s+for\s+copilot\s+response/i.test(text);
				const spinnerAlreadyOn = !!(optimizeBtn && optimizeBtn.dataset && optimizeBtn.dataset.kustoOptimizeSpinnerActive === '1');
				if (optimizeBtn && (shouldStartSpinner || spinnerAlreadyOn)) {
					if (!optimizeBtn.dataset.originalContent) {
						optimizeBtn.dataset.originalContent = optimizeBtn.innerHTML;
					}
					optimizeBtn.dataset.kustoOptimizeSpinnerActive = '1';
					optimizeBtn.innerHTML = '<span class="query-spinner" aria-hidden="true"></span>';
				}
			} catch { /* ignore */ }
		} else {
			statusEl.textContent = '';
			cancelBtn.disabled = false;
			try {
				if (optimizeBtn && optimizeBtn.dataset) {
					delete optimizeBtn.dataset.kustoOptimizeSpinnerActive;
					if (optimizeBtn.dataset.originalContent) {
						optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
						delete optimizeBtn.dataset.originalContent;
					}
				}
			} catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
}

function __kustoUpdateOptimizeStatus( boxId: any, statusText: any) {
	try {
		const statusEl = document.getElementById(boxId + '_optimize_status') as any;
		if (!statusEl) return;
		statusEl.textContent = String(statusText || '');
	} catch { /* ignore */ }
}

function __kustoCancelOptimizeQuery( boxId: any) {
	try {
		__kustoUpdateOptimizeStatus(boxId, 'Canceling…');
		const cancelBtn = document.getElementById(boxId + '_optimize_cancel') as any;
		if (cancelBtn) {
			cancelBtn.disabled = true;
		}
	} catch { /* ignore */ }
	try {
		(_win.vscode as any).postMessage({
			type: 'cancelOptimizeQuery',
			boxId: String(boxId || '')
		});
	} catch { /* ignore */ }
}

function __kustoShowOptimizePromptLoading( boxId: any) {
	const host = document.getElementById(boxId + '_optimize_config') as any;
	if (!host) {
		return;
	}
	host.style.display = 'block';
	host.innerHTML =
		'<div class="optimize-config-inner">' +
		'<div class="optimize-config-loading">Loading optimization options…</div>' +
		'<div class="optimize-config-actions">' +
		'<button type="button" class="optimize-config-cancel-btn" onclick="__kustoHideOptimizePromptForBox(\'' + boxId + '\')">Cancel</button>' +
		'</div>' +
		'</div>';
}

const __kustoOptimizeModelStorageKey = 'kusto.optimize.lastModelId';

function __kustoGetLastOptimizeModelId() {
	try {
		const state = (typeof _win.vscode !== 'undefined' && _win.vscode && (_win.vscode as any).getState) ? ((_win.vscode as any).getState() || {}) : {};
		if (state && state.lastOptimizeModelId) {
			return String(state.lastOptimizeModelId);
		}
	} catch { /* ignore */ }
	try {
		return String(localStorage.getItem(__kustoOptimizeModelStorageKey) || '');
	} catch { /* ignore */ }
	return '';
}

function __kustoSetLastOptimizeModelId( modelId: any) {
	const id = String(modelId || '');
	try {
		const state = (typeof _win.vscode !== 'undefined' && _win.vscode && (_win.vscode as any).getState) ? ((_win.vscode as any).getState() || {}) : {};
		state.lastOptimizeModelId = id;
		if (typeof _win.vscode !== 'undefined' && _win.vscode && (_win.vscode as any).setState) {
			(_win.vscode as any).setState(state);
		}
	} catch { /* ignore */ }
	try {
		if (id) {
			localStorage.setItem(__kustoOptimizeModelStorageKey, id);
		}
	} catch { /* ignore */ }
}

function __kustoApplyOptimizeQueryOptions( boxId: any, models: any, selectedModelId: any, promptText: any) {
	const host = document.getElementById(boxId + '_optimize_config') as any;
	if (!host) {
		return;
	}

	const safeModels = Array.isArray(models) ? models : [];
	host.style.display = 'block';
	host.innerHTML =
		'<div class="optimize-config-inner">' +
		'<div class="optimize-config-row">' +
		'<label class="optimize-config-label" for="' + boxId + '_optimize_model">Model</label>' +
		'<select class="optimize-config-select" id="' + boxId + '_optimize_model"></select>' +
		'</div>' +
		'<div class="optimize-config-row">' +
		'<label class="optimize-config-label" for="' + boxId + '_optimize_prompt">Prompt</label>' +
		'<textarea class="optimize-config-textarea" id="' + boxId + '_optimize_prompt" spellcheck="false"></textarea>' +
		'</div>' +
		'<div class="optimize-config-actions">' +
		'<button type="button" class="optimize-config-run-btn" onclick="__kustoRunOptimizeQueryWithOverrides(\'' + boxId + '\')">Optimize</button>' +
		'<button type="button" class="optimize-config-cancel-btn" onclick="__kustoHideOptimizePromptForBox(\'' + boxId + '\')">Cancel</button>' +
		'</div>' +
		'</div>';

	const selectEl = document.getElementById(boxId + '_optimize_model') as any;
	if (selectEl) {
		selectEl.innerHTML = '';
		for (const m of safeModels) {
			if (!m || !m.id) {
				continue;
			}
			const opt = document.createElement('option');
			opt.value = String(m.id);
			const label = String(m.label || m.id);
			const id = String(m.id);
			opt.textContent = (label && label !== id) ? label + ' (' + id + ')' : id;
			opt.setAttribute('data-short-label', label);
			selectEl.appendChild(opt);
		}

		const preferredModelId = __kustoGetLastOptimizeModelId();
		let preferredExists = false;
		if (preferredModelId) {
			for (let i = 0; i < selectEl.options.length; i++) {
				if (selectEl.options[i].value === preferredModelId) {
					preferredExists = true;
					break;
				}
			}
		}

		if (preferredExists) {
			selectEl.value = preferredModelId;
		} else if (selectedModelId) {
			selectEl.value = String(selectedModelId);
		}
		if (!selectEl.value && selectEl.options && selectEl.options.length > 0) {
			selectEl.selectedIndex = 0;
		}
	}

	const promptEl = document.getElementById(boxId + '_optimize_prompt') as any;
	if (promptEl) {
		promptEl.value = String(promptText || '');
	}
}

function __kustoRunOptimizeQueryWithOverrides( boxId: any) {
	const pending = __kustoEnsureOptimizePrepByBoxId();
	const req = pending[boxId];
	if (!req) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Optimization request is no longer available. Please try again.' }); } catch { /* ignore */ }
		__kustoHideOptimizePromptForBox(boxId);
		return;
	}

	// Optimization naming rule:
	// - If the source section has no name, assign the next available letter (A, B, C, ...)
	// - The optimized section will then use "<source name> (optimized)"
	try {
		let sourceName = _win.__kustoGetSectionName(boxId);
		if (!sourceName && typeof window.__kustoPickNextAvailableSectionLetterName === 'function') {
			sourceName = window.__kustoPickNextAvailableSectionLetterName(boxId);
			_win.__kustoSetSectionName(boxId, sourceName);
			try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
		}
		if (sourceName) {
			req.queryName = sourceName;
		}
	} catch { /* ignore */ }

	const modelId = (document.getElementById(boxId + '_optimize_model') as any || {}).value || '';
	const promptText = (document.getElementById(boxId + '_optimize_prompt') as any || {}).value || '';
	try {
		__kustoSetLastOptimizeModelId(modelId);
	} catch { /* ignore */ }

	// Close prompt UI and show spinner on the main optimize button
	try {
		const host = document.getElementById(boxId + '_optimize_config') as any;
		if (host) {
			host.style.display = 'none';
			host.innerHTML = '';
		}
	} catch { /* ignore */ }

	const optimizeBtn = document.getElementById(boxId + '_optimize_btn') as any;
	if (optimizeBtn) {
		optimizeBtn.disabled = true;
		const originalContent = optimizeBtn.innerHTML;
		optimizeBtn.dataset.originalContent = originalContent;
	}
	try {
		__kustoSetOptimizeInProgress(boxId, true, 'Starting optimization…');
	} catch { /* ignore */ }

	try {
		(_win.vscode as any).postMessage({
			type: 'optimizeQuery',
			query: String(req.query || ''),
			connectionId: String(req.connectionId || ''),
			database: String(req.database || ''),
			boxId,
			queryName: String(req.queryName || ''),
			modelId: String(modelId || ''),
			promptText: String(promptText || '')
		});
		delete pending[boxId];
	} catch (err: any) {
		console.error('Error sending optimization request:', err);
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Failed to start query optimization' }); } catch { /* ignore */ }
		// Restore button state
		if (optimizeBtn) {
			optimizeBtn.disabled = false;
			if (optimizeBtn.dataset.originalContent) {
				optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
				delete optimizeBtn.dataset.originalContent;
			}
		}
		__kustoHideOptimizePromptForBox(boxId);
	}
}

async function optimizeQueryWithCopilot( boxId: any, comparisonQueryOverride: any, options: any) {
	const editor = _win.queryEditors[boxId];
	if (!editor) {
		return '';
	}
	const model = editor.getModel();
	if (!model) {
		return '';
	}

	const shouldExecute = !(options && options.skipExecute === true);
	const isManualCompareOnly = !shouldExecute;

	// Defensive: opening the comparison/diff view should never trigger/keep any
	// optimize (LLM) prompt state. If the optimize prompt was open or pending from
	// earlier, clear it so the diff view remains strictly non-LLM.
	if (isManualCompareOnly) {
		try { __kustoHideOptimizePromptForBox(boxId); } catch { /* ignore */ }
		try { __kustoSetOptimizeInProgress(boxId, false, ''); } catch { /* ignore */ }
	}

	// Hide results to keep the UI focused during comparison setup.
	try { __kustoSetResultsVisible(boxId, false); } catch { /* ignore */ }

	const query = model.getValue() || '';
	if (!query.trim()) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'No query to compare' }); } catch { /* ignore */ }
		return '';
	}
	const overrideText = (typeof comparisonQueryOverride === 'string') ? String(comparisonQueryOverride || '') : '';
	if (comparisonQueryOverride != null && !overrideText.trim()) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'No comparison query provided' }); } catch { /* ignore */ }
		return '';
	}
	// Optimization naming rule (applies when we are creating an "optimized" comparison section):
	// - If the source section has no name, assign the next available letter (A, B, C, ...)
	// - Name the optimized section "<source name> (optimized)"
	//
	// This applies to:
	// - The Copilot optimize flow (optimized override query provided)
	// - The "Compare two queries" button (creates the optimized comparison section first)
	const isCompareButtonScenario = isManualCompareOnly && (comparisonQueryOverride == null);
	const isOptimizeScenario = ((comparisonQueryOverride != null) && !!overrideText.trim()) || isCompareButtonScenario;
	let sourceNameForOptimize = '';
	let desiredOptimizedName = '';
	if (isOptimizeScenario) {
		try {
			const nameInput = null;
			sourceNameForOptimize = _win.__kustoGetSectionName(boxId);
			if (!sourceNameForOptimize && typeof window.__kustoPickNextAvailableSectionLetterName === 'function') {
				sourceNameForOptimize = window.__kustoPickNextAvailableSectionLetterName(boxId);
				_win.__kustoSetSectionName(boxId, sourceNameForOptimize);
				try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
			}
			if (sourceNameForOptimize) {
				desiredOptimizedName = sourceNameForOptimize + ' (optimized)';
			}
		} catch { /* ignore */ }
	}
	
	const connectionId = _win.__kustoGetConnectionId(boxId);
	const database = _win.__kustoGetDatabase(boxId);
	if (!connectionId) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Please select a cluster connection' }); } catch { /* ignore */ }
		return '';
	}
	if (!database) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Please select a database' }); } catch { /* ignore */ }
		return '';
	}

	// If a comparison already exists for this source, reuse it.
	try {
		const existingComparisonBoxId = (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId && _win.optimizationMetadataByBoxId[boxId])
			? _win.optimizationMetadataByBoxId[boxId].comparisonBoxId
			: '';
		if (existingComparisonBoxId) {
			const comparisonBoxEl = document.getElementById(existingComparisonBoxId) as any;
			const comparisonEditor = _win.queryEditors && _win.queryEditors[existingComparisonBoxId];
			if (comparisonBoxEl && comparisonEditor && typeof comparisonEditor.setValue === 'function') {
				let nextComparisonQuery = overrideText.trim() ? overrideText : query;
				try {
					if (typeof window.__kustoPrettifyKustoText === 'function') {
						nextComparisonQuery = window.__kustoPrettifyKustoText(nextComparisonQuery);
					}
				} catch { /* ignore */ }
				try { comparisonEditor.setValue(nextComparisonQuery); } catch { /* ignore */ }
				try {
					if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
						_win.optimizationMetadataByBoxId[existingComparisonBoxId] = _win.optimizationMetadataByBoxId[existingComparisonBoxId] || {};
						_win.optimizationMetadataByBoxId[existingComparisonBoxId].sourceBoxId = boxId;
						_win.optimizationMetadataByBoxId[existingComparisonBoxId].isComparison = true;
						_win.optimizationMetadataByBoxId[existingComparisonBoxId].originalQuery = _win.queryEditors[boxId] ? _win.queryEditors[boxId].getValue() : query;
						_win.optimizationMetadataByBoxId[existingComparisonBoxId].optimizedQuery = nextComparisonQuery;
						_win.optimizationMetadataByBoxId[boxId] = _win.optimizationMetadataByBoxId[boxId] || {};
						_win.optimizationMetadataByBoxId[boxId].comparisonBoxId = existingComparisonBoxId;
					}
				} catch { /* ignore */ }
				try {
					if (typeof __kustoSetLinkedOptimizationMode === 'function') {
						__kustoSetLinkedOptimizationMode(boxId, existingComparisonBoxId, true);
					}
				} catch { /* ignore */ }
				// Set the comparison box name.
				try {
					if (desiredOptimizedName) {
						_win.__kustoSetSectionName(existingComparisonBoxId, desiredOptimizedName);
						try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
					} else {
						const currentName = _win.__kustoGetSectionName(existingComparisonBoxId);
						let shouldReplace = !currentName;
						if (!shouldReplace) {
							const upper = currentName.toUpperCase();
							if (upper.endsWith(' (COMPARISON)') || upper.endsWith(' (OPTIMIZED)')) {
								shouldReplace = true;
							}
						}
						if (shouldReplace) {
							_win.__kustoSetSectionName(existingComparisonBoxId, _win.__kustoPickNextAvailableSectionLetterName(existingComparisonBoxId));
							try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
						}
					}
				} catch { /* ignore */ }
				try {
					if (typeof __kustoSetResultsVisible === 'function') {
						__kustoSetResultsVisible(boxId, false);
						__kustoSetResultsVisible(existingComparisonBoxId, false);
					}
				} catch { /* ignore */ }
				if (shouldExecute) {
					try {
						executeQuery(boxId);
						setTimeout(() => {
							try { executeQuery(existingComparisonBoxId); } catch { /* ignore */ }
						}, 100);
					} catch { /* ignore */ }
				}
				return existingComparisonBoxId;
			}
			// Stale mapping: comparison was removed; clear and fall back to creating a new one.
			try {
				if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
					delete _win.optimizationMetadataByBoxId[boxId];
					delete _win.optimizationMetadataByBoxId[existingComparisonBoxId];
				}
			} catch { /* ignore */ }
		}
	} catch { /* ignore */ }

	// Do not auto-name the source section for plain comparisons.
	// For optimization scenarios, we already ensured a name above.
	let queryName = sourceNameForOptimize || _win.__kustoGetSectionName(boxId);
	if (!desiredOptimizedName && isOptimizeScenario && queryName) {
		desiredOptimizedName = queryName + ' (optimized)';
	}

	// Create a comparison query box below the source box.
	// If a query override is provided, compare source query vs the provided query.
	let comparisonQuery = overrideText.trim() ? overrideText : query;
	try {
		if (typeof window.__kustoPrettifyKustoText === 'function') {
			comparisonQuery = window.__kustoPrettifyKustoText(comparisonQuery);
		}
	} catch { /* ignore */ }

	let comparisonBoxId = '';
	try {
		comparisonBoxId = _win.addQueryBox({
			id: 'query_cmp_' + Date.now(),
			initialQuery: comparisonQuery,
			isComparison: true,
			defaultResultsVisible: false
		});
	} catch (err: any) {
		console.error('Error creating comparison box:', err);
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Failed to create comparison section' }); } catch { /* ignore */ }
		return '';
	}

	try {
		if (typeof __kustoSetResultsVisible === 'function') {
			__kustoSetResultsVisible(boxId, false);
			__kustoSetResultsVisible(comparisonBoxId, false);
		}
	} catch { /* ignore */ }
	try {
		if (typeof __kustoSetLinkedOptimizationMode === 'function') {
			__kustoSetLinkedOptimizationMode(boxId, comparisonBoxId, true);
		}
	} catch { /* ignore */ }

	// Store comparison metadata (reuses the existing optimization comparison flow).
	try {
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
			_win.optimizationMetadataByBoxId[comparisonBoxId] = {
				sourceBoxId: boxId,
				isComparison: true,
				originalQuery: _win.queryEditors[boxId] ? _win.queryEditors[boxId].getValue() : query,
				optimizedQuery: comparisonQuery
			};
			_win.optimizationMetadataByBoxId[boxId] = {
				comparisonBoxId: comparisonBoxId
			};
		}
	} catch { /* ignore */ }

	// Position the comparison box right after the source box.
	try {
		const sourceBox = document.getElementById(boxId) as any;
		const comparisonBox = document.getElementById(comparisonBoxId) as any;
		if (sourceBox && comparisonBox && sourceBox.parentNode) {
			sourceBox.parentNode.insertBefore(comparisonBox, sourceBox.nextSibling);
		}
	} catch { /* ignore */ }

	// Set connection and database to match source.
	try {
		const compKwEl = _win.__kustoGetQuerySectionElement(comparisonBoxId);
		if (compKwEl) {
			if (typeof compKwEl.setConnectionId === 'function') compKwEl.setConnectionId(connectionId);
			if (typeof compKwEl.setDesiredDatabase === 'function') compKwEl.setDesiredDatabase(database);
			compKwEl.dispatchEvent(new CustomEvent('connection-changed', {
				detail: { boxId: comparisonBoxId, connectionId: connectionId },
				bubbles: true, composed: true,
			}));
			setTimeout(() => {
				try {
					if (typeof compKwEl.setDatabase === 'function') compKwEl.setDatabase(database);
				} catch { /* ignore */ }
			}, 100);
		}
	} catch { /* ignore */ }

	// Set the query name.
	try {
		if (desiredOptimizedName) {
			_win.__kustoSetSectionName(comparisonBoxId, desiredOptimizedName);
		} else {
			const existing = _win.__kustoGetSectionName(comparisonBoxId);
			if (!existing) {
				_win.__kustoSetSectionName(comparisonBoxId, _win.__kustoPickNextAvailableSectionLetterName(comparisonBoxId));
			}
		}
	} catch { /* ignore */ }

	if (shouldExecute) {
		// Execute both queries for comparison.
		try {
			executeQuery(boxId);
			setTimeout(() => {
				try { executeQuery(comparisonBoxId); } catch { /* ignore */ }
			}, 100);
		} catch { /* ignore */ }
	}

	return comparisonBoxId;
}

// ── Run readiness, execution core ──

function __kustoIsValidConnectionIdForRun( connectionId: any) {
	const cid = String(connectionId || '').trim();
	if (!cid) return false;
	if (cid === '__enter_new__' || cid === '__import_xml__') return false;
	return true;
}

function __kustoGetEffectiveSelectionOwnerIdForRun( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return '';
	try {
		if (typeof window.__kustoGetSelectionOwnerBoxId === 'function') {
			return String(window.__kustoGetSelectionOwnerBoxId(id) || id).trim();
		}
	} catch { /* ignore */ }
	return id;
}

function __kustoIsRunSelectionReady( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return false;

	const ownerId = __kustoGetEffectiveSelectionOwnerIdForRun(id);

	// If a favorites selection is still staging/applying, don't allow Run.
	try {
		const pending1 = !!(_win.pendingFavoriteSelectionByBoxId && _win.pendingFavoriteSelectionByBoxId[id]);
		const pending2 = !!(_win.pendingFavoriteSelectionByBoxId && _win.pendingFavoriteSelectionByBoxId[ownerId]);
		if (pending1 || pending2) {
			return false;
		}
	} catch { /* ignore */ }

	const connectionId = _win.__kustoGetConnectionId(ownerId);
	const database = _win.__kustoGetDatabase(ownerId);

	if (!__kustoIsValidConnectionIdForRun(connectionId)) return false;
	if (!database) return false;

	// If DB selection is still being resolved (favorites/restore), block Run.
	try {
		const dbEl: any = null; // Legacy: never defined, kept for safety
		const desiredPending = !!(dbEl && dbEl.dataset && String(dbEl.dataset.desired || '').trim());
		if (desiredPending) return false;
	} catch { /* ignore */ }
	try {
		if (false) return false; // Legacy: dbEl was never defined in this function
	} catch { /* ignore */ }

	return true;
}

function __kustoHasValidFavoriteSelection( ownerBoxId: any) {
	try {
		const id = String(ownerBoxId || '').trim();
		if (!id) return false;
		// Treat "favorite selected" as: the current (clusterUrl, db) matches a known favorite.
		const clusterUrl = (typeof _win.__kustoGetCurrentClusterUrlForBox === 'function')
			? String(_win.__kustoGetCurrentClusterUrlForBox(id) || '').trim()
			: '';
		const db = (typeof _win.__kustoGetCurrentDatabaseForBox === 'function')
			? String(_win.__kustoGetCurrentDatabaseForBox(id) || '').trim()
			: '';
		if (!clusterUrl || !db) return false;
		return typeof _win.__kustoFindFavorite === 'function' ? !!_win.__kustoFindFavorite(clusterUrl, db) : false;
	} catch {
		return false;
	}
}

function __kustoClearSchemaSummaryIfNoSelection( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const ownerId = __kustoGetEffectiveSelectionOwnerIdForRun(id);
	let connectionId = _win.__kustoGetConnectionId(ownerId);
	let database = _win.__kustoGetDatabase(ownerId);

	// If neither a database nor a favorite is selected, blank the schema summary to avoid stale counts.
	const hasValidCluster = typeof __kustoIsValidConnectionIdForRun === 'function'
		? __kustoIsValidConnectionIdForRun(connectionId)
		: !!connectionId;
	const shouldClear = ((!hasValidCluster || !database) && !__kustoHasValidFavoriteSelection(ownerId));

	// Keep the schema refresh button in sync: hide it when selection isn't valid.
	try {
		const btn = document.getElementById(id + '_schema_refresh') as any;
		if (btn) {
			btn.style.display = shouldClear ? 'none' : '';
		}
	} catch { /* ignore */ }

	if (shouldClear) {
		try {
			if (_win.schemaByBoxId) {
				delete _win.schemaByBoxId[id];
			}
		} catch { /* ignore */ }
		try {
			if (typeof _win.setSchemaLoadedSummary === 'function') {
				_win.setSchemaLoadedSummary(id, '', '', false);
			}
		} catch { /* ignore */ }
	}
}

window.__kustoUpdateRunEnabledForBox = function (boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const runBtn = document.getElementById(id + '_run_btn') as any;
	const runToggle = document.getElementById(id + '_run_toggle') as any;
	const disabledTooltip = 'Select a cluster and database first (or select a favorite)';

	// If a query is currently executing for this box, keep disabled.
	try {
		if (_win.queryExecutionTimers && _win.queryExecutionTimers[id]) {
			if (runBtn) runBtn.disabled = true;
			if (runToggle) runToggle.disabled = true;
			return;
		}
	} catch { /* ignore */ }

	// Also keep schema summary in sync with selection state.
	try { __kustoClearSchemaSummaryIfNoSelection(id); } catch { /* ignore */ }

	const enabled = __kustoIsRunSelectionReady(id);
	if (runBtn) {
		runBtn.disabled = !enabled;
		try {
			// When disabled, provide a helpful tooltip instead of looking "broken".
			const modeLabel = _win.getRunModeLabelText(_win.getRunMode(id));
			runBtn.title = enabled ? modeLabel : (modeLabel + '\n' + disabledTooltip);
			// Also keep ARIA label helpful when disabled.
			runBtn.setAttribute('aria-label', enabled ? modeLabel : disabledTooltip);
		} catch { /* ignore */ }
	}
	// Keep the split dropdown usable so users can change run mode even before selection is ready.
	if (runToggle) runToggle.disabled = false;
};

window.__kustoUpdateRunEnabledForAllBoxes = function () {
	try {
		for (const id of (_win.queryBoxes || [])) {
			try { window.__kustoUpdateRunEnabledForBox(id); } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
};

function formatElapsed( ms: any) {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes + ':' + seconds.toString().padStart(2, '0');
}

function setQueryExecuting( boxId: any, executing: any) {
	const runBtn = document.getElementById(boxId + '_run_btn') as any;
	const runToggle = document.getElementById(boxId + '_run_toggle') as any;
	const status = document.getElementById(boxId + '_exec_status') as any;
	const elapsed = document.getElementById(boxId + '_exec_elapsed') as any;
	const cancelBtn = document.getElementById(boxId + '_cancel_btn') as any;

	if (_win.queryExecutionTimers[boxId]) {
		clearInterval(_win.queryExecutionTimers[boxId]);
		delete _win.queryExecutionTimers[boxId];
	}

	if (executing) {
		if (runBtn) {
			runBtn.disabled = true;
		}
		if (runToggle) {
			runToggle.disabled = true;
		}
		if (cancelBtn) {
			cancelBtn.disabled = false;
			cancelBtn.style.display = 'flex';
		}
		_win.closeRunMenu(boxId);
		if (status) {
			status.style.display = 'inline-flex';
		}
		if (elapsed) {
			elapsed.textContent = '0:00';
		}

		// Clear stale results/errors from the previous query so the user
		// doesn't see an old error while a new query is running.
		try {
			const resultsDiv = document.getElementById(boxId + '_results') as any;
			if (resultsDiv) {
				resultsDiv.innerHTML = '';
				resultsDiv.classList.remove('visible');
			}
		} catch { /* ignore */ }

		const start = performance.now();
		_win.queryExecutionTimers[boxId] = setInterval(() => {
			if (elapsed) {
				elapsed.textContent = formatElapsed(performance.now() - start);
			}
		}, 1000);
		return;
	}

	try {
		if (typeof window.__kustoUpdateRunEnabledForBox === 'function') {
			window.__kustoUpdateRunEnabledForBox(boxId);
		} else {
			if (runBtn) {
				runBtn.disabled = false;
			}
			if (runToggle) {
				runToggle.disabled = false;
			}
		}
	} catch {
		if (runBtn) {
			runBtn.disabled = false;
		}
		if (runToggle) {
			runToggle.disabled = false;
		}
	}
	if (cancelBtn) {
		cancelBtn.disabled = true;
		cancelBtn.style.display = 'none';
	}
	if (status) {
		status.style.display = 'none';
	}
}

function cancelQuery( boxId: any) {
	try {
		const cancelBtn = document.getElementById(boxId + '_cancel_btn') as any;
		if (cancelBtn) {
			cancelBtn.disabled = true;
		}
	} catch {
		// ignore
	}
	try {
		(_win.vscode as any).postMessage({ type: 'cancelQuery', boxId: boxId });
	} catch {
		// ignore
	}
}

function executeQuery( boxId: any, mode?: any) {
	const effectiveMode = mode || _win.getRunMode(boxId);
	try {
		if (typeof window.__kustoClearAutoFindInQueryEditor === 'function') {
			window.__kustoClearAutoFindInQueryEditor(boxId);
		}
	} catch { /* ignore */ }
	const __kustoExtractStatementAtCursor = (editor: any) => {
		try {
			if (typeof window.__kustoExtractStatementTextAtCursor === 'function') {
				return window.__kustoExtractStatementTextAtCursor(editor);
			}
		} catch { /* ignore */ }
		try {
			if (!editor || typeof editor.getModel !== 'function' || typeof editor.getPosition !== 'function') {
				return null;
			}
			const model = editor.getModel();
			const pos = editor.getPosition();
			if (!model || !pos || typeof model.getLineCount !== 'function') {
				return null;
			}
			const cursorLine = pos.lineNumber;
			if (typeof cursorLine !== 'number' || !isFinite(cursorLine) || cursorLine < 1) {
				return null;
			}
			const lineCount = model.getLineCount();
			if (!lineCount || cursorLine > lineCount) {
				return null;
			}

			// Statements are separated by one or more blank lines.
			// Blank lines inside triple-backtick (```) multi-line string literals are NOT separators.
			const blocks = [];
			let inBlock = false;
			let startLine = 1;
			let inTripleBacktick = false;
			for (let ln = 1; ln <= lineCount; ln++) {
				let lineText = '';
				try { lineText = model.getLineContent(ln); } catch { lineText = ''; }
				// Track triple-backtick state.
				let tripleCount = 0;
				for (let ci = 0; ci < lineText.length - 2; ci++) {
					if (lineText[ci] === '`' && lineText[ci + 1] === '`' && lineText[ci + 2] === '`') {
						tripleCount++;
						ci += 2;
					}
				}
				if (tripleCount % 2 === 1) inTripleBacktick = !inTripleBacktick;
				if (inTripleBacktick) {
					if (!inBlock) { startLine = ln; inBlock = true; }
					continue;
				}
				const isBlank = !String(lineText || '').trim();
				if (isBlank) {
					if (inBlock) {
						blocks.push({ startLine, endLine: ln - 1 });
						inBlock = false;
					}
					continue;
				}
				if (!inBlock) {
					startLine = ln;
					inBlock = true;
				}
			}
			if (inBlock) {
				blocks.push({ startLine, endLine: lineCount });
			}

			const block = blocks.find((b: any) => cursorLine >= b.startLine && cursorLine <= b.endLine);
			if (!block) {
				// Cursor is on a blank separator line (or the editor is empty).
				return null;
			}

			const endCol = (typeof model.getLineMaxColumn === 'function')
				? model.getLineMaxColumn(block.endLine)
				: 1;
			const range = {
				startLineNumber: block.startLine,
				startColumn: 1,
				endLineNumber: block.endLine,
				endColumn: endCol
			};
			let text = '';
			try {
				text = (typeof model.getValueInRange === 'function') ? model.getValueInRange(range) : '';
			} catch {
				text = '';
			}
			const trimmed = String(text || '').trim();
			return trimmed || null;
		} catch {
			return null;
		}
	};

	const editor = _win.queryEditors[boxId] ? _win.queryEditors[boxId] : null;
	let query = editor ? editor.getValue() : '';
	// If the editor has multiple statements (blank-line separated), run only the statement at cursor.
	// IMPORTANT: Do NOT add checks for hasTextFocus or activeQueryEditorBoxId here!
	// When clicking the Run button, the editor loses focus before this code executes, which would
	// cause the full editor content to be sent instead of just the active statement. This was a
	// regression bug - always check for multiple statements and extract at cursor unconditionally.
	try {
		if (editor) {
			const model = editor.getModel && editor.getModel();
			const blocks = (model && typeof window.__kustoGetStatementBlocksFromModel === 'function')
				? window.__kustoGetStatementBlocksFromModel(model)
				: [];
			const hasMultipleStatements = blocks && blocks.length > 1;
			if (hasMultipleStatements) {
				const statement = __kustoExtractStatementAtCursor(editor);
				if (statement) {
					query = statement;
				} else {
					// Cursor is on a separator line between statements.
					try {
						(_win.vscode as any).postMessage({
							type: 'showInfo',
							message: 'Place the cursor inside a query statement (not on a separator) to run that statement.'
						});
					} catch { /* ignore */ }
					return;
				}
			}
		}
	} catch { /* ignore */ }
	let connectionId = _win.__kustoGetConnectionId(boxId);
	let database = _win.__kustoGetDatabase(boxId);
	let cacheEnabled = (document.getElementById(boxId + '_cache_enabled') as any).checked;
	const cacheValue = parseInt((document.getElementById(boxId + '_cache_value') as any).value) || 1;
	const cacheUnit = (document.getElementById(boxId + '_cache_unit') as any).value;

	let sourceBoxIdForComparison = '';
	let isComparisonBox = false;

	// In optimized/comparison sections, inherit connection/database from the source box.
	try {
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
			const meta = _win.optimizationMetadataByBoxId[boxId];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				const sourceBoxId = meta.sourceBoxId;
				isComparisonBox = true;
				sourceBoxIdForComparison = String(sourceBoxId || '');
				const srcConnId = _win.__kustoGetConnectionId(sourceBoxId);
				const srcDb = _win.__kustoGetDatabase(sourceBoxId);
				if (srcConnId) {
					connectionId = srcConnId;
				}
				if (srcDb) {
					database = srcDb;
				}
			}
			// While linked optimization exists, always disable caching for benchmark runs.
			const hasLinkedOptimization = !!(meta && meta.isComparison)
				|| !!(_win.optimizationMetadataByBoxId[boxId] && _win.optimizationMetadataByBoxId[boxId].comparisonBoxId);
			if (hasLinkedOptimization) {
				cacheEnabled = false;
			}
		}
	} catch { /* ignore */ }

	// Cache consistency policy for comparisons:
	// If the source box was last executed with caching enabled, rerun it once with caching disabled
	// before (or alongside) running the comparison box. This avoids cached-vs-live drift causing
	// false mismatches when queries are otherwise unchanged.
	try {
		if (isComparisonBox && sourceBoxIdForComparison) {
			const cacheMap = window.__kustoLastRunCacheEnabledByBoxId;
			const sourceLastRunUsedCaching = !!(cacheMap && typeof cacheMap === 'object' && cacheMap[sourceBoxIdForComparison]);
			if (sourceLastRunUsedCaching) {
				// Prevent transient comparisons against stale cached source results.
				try {
					if (window.__kustoResultsByBoxId && typeof window.__kustoResultsByBoxId === 'object') {
						delete window.__kustoResultsByBoxId[sourceBoxIdForComparison];
					}
				} catch { /* ignore */ }
				try {
					_win.__kustoLog(boxId, 'run.compare.rerunSourceNoCache', 'Rerunning source query with caching disabled', {
						sourceBoxId: sourceBoxIdForComparison
					});
				} catch { /* ignore */ }
				try {
					// This run will inherit the linked-optimization behavior and force cacheEnabled=false.
					executeQuery(sourceBoxIdForComparison, effectiveMode);
				} catch { /* ignore */ }
			}
		}
	} catch { /* ignore */ }

	// Safety: if a favorites switch is still pending/applying, do not run.
	try {
		const pending = !!(_win.pendingFavoriteSelectionByBoxId && _win.pendingFavoriteSelectionByBoxId[boxId]);
		const dbEl = document.getElementById(boxId + '_database') as any;
		const desiredPending = !!(dbEl && dbEl.dataset && dbEl.dataset.desired);
		const dbDisabled = !!(dbEl && dbEl.disabled);
		if (pending || desiredPending || dbDisabled) {
			_win.__kustoLog(boxId, 'run.blocked', 'Blocked run because selection is still updating', {
				pending,
				desiredPending,
				dbDisabled,
				connectionId,
				database
			}, 'warn');
			try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Waiting for the selected favorite to finish applying (loading databases/schema). Try Run again in a moment.' }); } catch { /* ignore */ }
			return;
		}
	} catch { /* ignore */ }

	if (!query.trim()) {
		return;
	}

	if (!connectionId) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Please select a cluster connection' }); } catch { /* ignore */ }
		return;
	}
	if (!database) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Please select a database' }); } catch { /* ignore */ }
		return;
	}
	_win.__kustoLog(boxId, 'run.start', 'Executing query', { connectionId, database, queryMode: effectiveMode });

	setQueryExecuting(boxId, true);
	_win.closeRunMenu(boxId);

	// Track the effective cacheEnabled value for this run.
	// When caching is enabled, the extension injects an extra (hidden) first line,
	// so error line numbers need to be adjusted for the visible editor.
	try {
		if (!window.__kustoLastRunCacheEnabledByBoxId || typeof window.__kustoLastRunCacheEnabledByBoxId !== 'object') {
			window.__kustoLastRunCacheEnabledByBoxId = {};
		}
		window.__kustoLastRunCacheEnabledByBoxId[boxId] = !!cacheEnabled;
	} catch { /* ignore */ }

	// Store the last executed box for result display
	window.lastExecutedBox = boxId;

	(_win.vscode as any).postMessage({
		type: 'executeQuery',
		query,
		queryMode: effectiveMode,
		connectionId,
		database,
		boxId,
		cacheEnabled,
		cacheValue,
		cacheUnit
	});
}

// ── Window bridges for remaining legacy callers ──
window.__kustoSetResultsVisible = __kustoSetResultsVisible;
window.__kustoLockCacheForBenchmark = __kustoLockCacheForBenchmark;
window.__kustoNormalizeCellForComparison = __kustoNormalizeCellForComparison;
window.__kustoRowKeyForComparison = __kustoRowKeyForComparison;
window.__kustoNormalizeColumnNameForComparison = __kustoNormalizeColumnNameForComparison;
window.__kustoGetNormalizedColumnNameList = __kustoGetNormalizedColumnNameList;
window.__kustoDoColumnHeaderNamesMatch = __kustoDoColumnHeaderNamesMatch;
window.__kustoGetColumnDifferences = __kustoGetColumnDifferences;
window.__kustoDoColumnOrderMatch = __kustoDoColumnOrderMatch;
window.__kustoDoRowOrderMatch = __kustoDoRowOrderMatch;
window.__kustoBuildColumnIndexMapForNames = __kustoBuildColumnIndexMapForNames;
window.__kustoBuildNameBasedColumnMapping = __kustoBuildNameBasedColumnMapping;
window.__kustoRowKeyForComparisonWithColumnMapping = __kustoRowKeyForComparisonWithColumnMapping;
window.__kustoRowKeyForComparisonIgnoringColumnOrder = __kustoRowKeyForComparisonIgnoringColumnOrder;
window.__kustoAreResultsEquivalentWithDetails = __kustoAreResultsEquivalentWithDetails;
window.__kustoAreResultsEquivalent = __kustoAreResultsEquivalent;
window.__kustoDoResultHeadersMatch = __kustoDoResultHeadersMatch;
window.__kustoUpdateAcceptOptimizationsButton = __kustoUpdateAcceptOptimizationsButton;
window.acceptOptimizations = acceptOptimizations;
window.__kustoUpdateQueryResultsToggleButton = __kustoUpdateQueryResultsToggleButton;
window.__kustoUpdateComparisonSummaryToggleButton = __kustoUpdateComparisonSummaryToggleButton;
window.__kustoApplyResultsVisibility = __kustoApplyResultsVisibility;
window.__kustoApplyComparisonSummaryVisibility = __kustoApplyComparisonSummaryVisibility;
window.toggleQueryResultsVisibility = toggleQueryResultsVisibility;
window.toggleComparisonSummaryVisibility = toggleComparisonSummaryVisibility;
window.__kustoEnsureCacheBackupMap = __kustoEnsureCacheBackupMap;
window.__kustoBackupCacheSettings = __kustoBackupCacheSettings;
window.__kustoRestoreCacheSettings = __kustoRestoreCacheSettings;
window.__kustoEnsureRunModeBackupMap = __kustoEnsureRunModeBackupMap;
window.__kustoBackupRunMode = __kustoBackupRunMode;
window.__kustoRestoreRunMode = __kustoRestoreRunMode;
window.__kustoSetLinkedOptimizationMode = __kustoSetLinkedOptimizationMode;
window.displayComparisonSummary = displayComparisonSummary;
window.__kustoEnsureOptimizePrepByBoxId = __kustoEnsureOptimizePrepByBoxId;
window.__kustoHideOptimizePromptForBox = __kustoHideOptimizePromptForBox;
window.__kustoSetOptimizeInProgress = __kustoSetOptimizeInProgress;
window.__kustoUpdateOptimizeStatus = __kustoUpdateOptimizeStatus;
window.__kustoCancelOptimizeQuery = __kustoCancelOptimizeQuery;
window.__kustoShowOptimizePromptLoading = __kustoShowOptimizePromptLoading;
window.__kustoGetLastOptimizeModelId = __kustoGetLastOptimizeModelId;
window.__kustoSetLastOptimizeModelId = __kustoSetLastOptimizeModelId;
window.__kustoApplyOptimizeQueryOptions = __kustoApplyOptimizeQueryOptions;
window.__kustoRunOptimizeQueryWithOverrides = __kustoRunOptimizeQueryWithOverrides;
window.optimizeQueryWithCopilot = optimizeQueryWithCopilot;
window.__kustoIsValidConnectionIdForRun = __kustoIsValidConnectionIdForRun;
window.__kustoGetEffectiveSelectionOwnerIdForRun = __kustoGetEffectiveSelectionOwnerIdForRun;
window.__kustoIsRunSelectionReady = __kustoIsRunSelectionReady;
window.__kustoHasValidFavoriteSelection = __kustoHasValidFavoriteSelection;
window.__kustoClearSchemaSummaryIfNoSelection = __kustoClearSchemaSummaryIfNoSelection;
window.formatElapsed = formatElapsed;
window.setQueryExecuting = setQueryExecuting;
window.cancelQuery = cancelQuery;
window.executeQuery = executeQuery;
