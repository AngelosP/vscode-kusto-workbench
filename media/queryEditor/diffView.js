// Reusable dataset diff view for the query editor webview.
//
// Goals:
// - Minimal UI: show only differences by default
// - Clear A vs B distinction per cell
// - Reusable: render into any container, plus a built-in modal host

(function initKustoDiffView() {
	const safeString = (v) => {
		try {
			if (v === null) return 'null';
			if (v === undefined) return 'undefined';
			if (typeof v === 'string') return v;
			return String(v);
		} catch {
			return '[unprintable]';
		}
	};

	const getBoxLabel = (boxId) => {
		try {
			const el = document.getElementById(String(boxId || '') + '_name');
			const name = el ? String(el.value || '').trim() : '';
			return name || String(boxId || '').trim() || 'Dataset';
		} catch {
			return String(boxId || '').trim() || 'Dataset';
		}
	};

	const normalizeCell = (cell) => {
		try {
			if (typeof window.__kustoNormalizeCellForComparison === 'function') {
				return window.__kustoNormalizeCellForComparison(cell);
			}
		} catch { /* ignore */ }
		try {
			// Very small fallback: stringify.
			if (cell === null || cell === undefined) return ['n', null];
			if (typeof cell === 'number') return ['num', isFinite(cell) ? cell : String(cell)];
			if (typeof cell === 'boolean') return ['bool', cell ? 1 : 0];
			if (cell instanceof Date) {
				const ms = cell.getTime();
				return ['date', isFinite(ms) ? ms : String(cell)];
			}
			if (typeof cell === 'object') {
				if (cell && typeof cell === 'object' && 'full' in cell && cell.full !== undefined && cell.full !== null) {
					return normalizeCell(cell.full);
				}
				if (cell && typeof cell === 'object' && 'display' in cell && cell.display !== undefined && cell.display !== null) {
					return normalizeCell(cell.display);
				}
				return ['obj', JSON.stringify(cell)];
			}
			return ['str', String(cell)];
		} catch {
			return ['obj', '[uncomparable]'];
		}
	};

	const formatCellForDisplay = (cell) => {
		try {
			if (cell === null) return 'null';
			if (cell === undefined) return '';

			// Webview table cell wrapper.
			if (cell && typeof cell === 'object') {
				if (cell.isObject) {
					try {
						return JSON.stringify(cell.full !== undefined ? cell.full : cell, null, 0);
					} catch {
						return '[object]';
					}
				}
				if ('full' in cell && cell.full !== undefined && cell.full !== null) {
					return formatCellForDisplay(cell.full);
				}
				if ('display' in cell && cell.display !== undefined && cell.display !== null) {
					return formatCellForDisplay(cell.display);
				}
				try {
					return JSON.stringify(cell);
				} catch {
					return '[object]';
				}
			}

			return String(cell);
		} catch {
			return '[unrenderable]';
		}
	};

	const cellEquals = (a, b) => {
		try {
			const na = normalizeCell(a);
			const nb = normalizeCell(b);
			return JSON.stringify(na) === JSON.stringify(nb);
		} catch {
			return false;
		}
	};

	const getColumns = (state) => {
		try {
			const cols = Array.isArray(state && state.columns) ? state.columns : [];
			return cols.map(c => safeString(c));
		} catch {
			return [];
		}
	};

	const getRows = (state) => {
		try {
			return Array.isArray(state && state.rows) ? state.rows : [];
		} catch {
			return [];
		}
	};

	const buildColumnMappingByName = (state, canonicalNormalizedNames) => {
		try {
			if (typeof window.__kustoBuildNameBasedColumnMapping === 'function') {
				return window.__kustoBuildNameBasedColumnMapping(state, canonicalNormalizedNames);
			}
		} catch { /* ignore */ }

		// Fallback: exact normalized name match, first unused.
		const cols = getColumns(state);
		const used = new Set();
		const normalizeName = (n) => {
			try {
				if (typeof window.__kustoNormalizeColumnNameForComparison === 'function') {
					return window.__kustoNormalizeColumnNameForComparison(n);
				}
			} catch { /* ignore */ }
			return safeString(n).trim().toLowerCase();
		};
		const normalized = cols.map(normalizeName);
		const out = [];
		for (const name of canonicalNormalizedNames) {
			let found = -1;
			for (let i = 0; i < normalized.length; i++) {
				if (used.has(i)) continue;
				if (normalized[i] === name) {
					found = i;
					used.add(i);
					break;
				}
			}
			out.push(found);
		}
		return out;
	};

	const buildPairsByIndex = (aRows, bRows) => {
		const max = Math.max(aRows.length, bRows.length);
		const pairs = [];
		for (let i = 0; i < max; i++) {
			pairs.push({ aRowIndex: i < aRows.length ? i : -1, bRowIndex: i < bRows.length ? i : -1 });
		}
		return pairs;
	};

	const buildPairsByExactRowMatch = (rowKeyForA, rowKeyForB, aRows, bRows) => {
		const aMap = new Map();
		for (let i = 0; i < aRows.length; i++) {
			const key = rowKeyForA(aRows[i]);
			if (!aMap.has(key)) aMap.set(key, []);
			aMap.get(key).push(i);
		}
		const bMap = new Map();
		for (let i = 0; i < bRows.length; i++) {
			const key = rowKeyForB(bRows[i]);
			if (!bMap.has(key)) bMap.set(key, []);
			bMap.get(key).push(i);
		}

		const keys = Array.from(new Set([...
			aMap.keys(),
			...bMap.keys()
		])).sort();

		const pairs = [];
		for (const key of keys) {
			const aList = aMap.get(key) || [];
			const bList = bMap.get(key) || [];
			const count = Math.max(aList.length, bList.length);
			for (let i = 0; i < count; i++) {
				pairs.push({
					aRowIndex: (i < aList.length) ? aList[i] : -1,
					bRowIndex: (i < bList.length) ? bList[i] : -1
				});
			}
		}

		return pairs;
	};

	const buildDiffModelFromStates = (aState, bState, labels, pairingMode) => {
		const aCols = getColumns(aState);
		const bCols = getColumns(bState);
		const aRows = getRows(aState);
		const bRows = getRows(bState);

		let details = null;
		try {
			if (typeof window.__kustoAreResultsEquivalentWithDetails === 'function') {
				details = window.__kustoAreResultsEquivalentWithDetails(aState, bState);
			}
		} catch { /* ignore */ }
		const columnHeaderNamesMatch = !!(details && details.columnHeaderNamesMatch);
		const rowOrderMatches = !!(details && details.rowOrderMatches);

		let columns = [];
		let aMap = null;
		let bMap = null;

		if (columnHeaderNamesMatch) {
			const normalizeName = (n) => {
				try {
					if (typeof window.__kustoNormalizeColumnNameForComparison === 'function') {
						return window.__kustoNormalizeColumnNameForComparison(n);
					}
				} catch { /* ignore */ }
				return safeString(n).trim().toLowerCase();
			};

			const canonical = aCols.map(normalizeName).slice().sort();
			aMap = buildColumnMappingByName(aState, canonical);
			bMap = buildColumnMappingByName(bState, canonical);

			columns = canonical.map((normName, idx) => {
				const aIdx = (aMap && idx < aMap.length) ? aMap[idx] : -1;
				const bIdx = (bMap && idx < bMap.length) ? bMap[idx] : -1;
				const aName = (aIdx >= 0 && aIdx < aCols.length) ? aCols[aIdx] : '';
				const bName = (bIdx >= 0 && bIdx < bCols.length) ? bCols[bIdx] : '';
				const label = aName || bName || normName || ('col_' + String(idx + 1));
				return { key: normName || ('col_' + String(idx + 1)), label, aIndex: aIdx, bIndex: bIdx, aName, bName };
			});
		} else {
			const max = Math.max(aCols.length, bCols.length);
			columns = [];
			for (let i = 0; i < max; i++) {
				columns.push({
					key: String(i),
					label: 'Col ' + String(i + 1),
					aIndex: i < aCols.length ? i : -1,
					bIndex: i < bCols.length ? i : -1,
					aName: i < aCols.length ? aCols[i] : '',
					bName: i < bCols.length ? bCols[i] : ''
				});
			}
		}

		const getCell = (rows, rowIndex, colIndex) => {
			try {
				if (rowIndex < 0) return undefined;
				const row = rows[rowIndex];
				if (!Array.isArray(row)) return undefined;
				if (colIndex < 0) return undefined;
				return row[colIndex];
			} catch {
				return undefined;
			}
		};

		let pairs = [];
		const mode = (pairingMode === 'byIndex') ? 'byIndex' : 'auto';
		if (mode === 'byIndex') {
			pairs = buildPairsByIndex(aRows, bRows);
		} else {
			// Auto:
			// - If order matches, diff by index (best for per-cell diagnostics)
			// - Else, pair exact matches and show unmatched rows as missing
			if (rowOrderMatches) {
				pairs = buildPairsByIndex(aRows, bRows);
			} else {
				let rowKeyForA = null;
				let rowKeyForB = null;
				try {
					if (columnHeaderNamesMatch && typeof window.__kustoRowKeyForComparisonWithColumnMapping === 'function' && aMap && bMap) {
						rowKeyForA = (row) => window.__kustoRowKeyForComparisonWithColumnMapping(row, aMap);
						rowKeyForB = (row) => window.__kustoRowKeyForComparisonWithColumnMapping(row, bMap);
					} else if (typeof window.__kustoRowKeyForComparison === 'function') {
						rowKeyForA = window.__kustoRowKeyForComparison;
						rowKeyForB = window.__kustoRowKeyForComparison;
					}
				} catch { /* ignore */ }

				if (typeof rowKeyForA === 'function' && typeof rowKeyForB === 'function') {
					pairs = buildPairsByExactRowMatch(rowKeyForA, rowKeyForB, aRows, bRows);
				} else {
					pairs = buildPairsByIndex(aRows, bRows);
				}
			}
		}

		const rowModels = pairs.map((p, pairIndex) => {
			const aRowIndex = (p && typeof p.aRowIndex === 'number') ? p.aRowIndex : -1;
			const bRowIndex = (p && typeof p.bRowIndex === 'number') ? p.bRowIndex : -1;
			let hasAnyDiff = false;
			let fullyMatched = true;
			const cells = columns.map((col) => {
				const aVal = getCell(aRows, aRowIndex, col.aIndex);
				const bVal = getCell(bRows, bRowIndex, col.bIndex);
				const aMissing = aRowIndex < 0 || col.aIndex < 0;
				const bMissing = bRowIndex < 0 || col.bIndex < 0;
				let equal = false;
				if (!aMissing && !bMissing) {
					equal = cellEquals(aVal, bVal);
				}
				if (aMissing !== bMissing) {
					hasAnyDiff = true;
					fullyMatched = false;
				} else if (!equal) {
					hasAnyDiff = true;
					fullyMatched = false;
				}
				return {
					aMissing,
					bMissing,
					aText: aMissing ? '' : formatCellForDisplay(aVal),
					bText: bMissing ? '' : formatCellForDisplay(bVal),
					equal
				};
			});
			// If one side missing entirely, it's not a full match.
			if (aRowIndex < 0 || bRowIndex < 0) {
				fullyMatched = false;
				hasAnyDiff = true;
			}
			return {
				pairIndex,
				aRowIndex,
				bRowIndex,
				fullyMatched,
				hasAnyDiff,
				cells
			};
		});

		const colFullyMatched = columns.map((col, colIdx) => {
			let anyCompared = false;
			for (const row of rowModels) {
				const cell = row.cells[colIdx];
				if (!cell) continue;
				if (cell.aMissing || cell.bMissing) {
					return false;
				}
				anyCompared = true;
				if (!cell.equal) {
					return false;
				}
			}
			return anyCompared;
		});

		return {
			aLabel: (labels && labels.aLabel) ? String(labels.aLabel) : 'A',
			bLabel: (labels && labels.bLabel) ? String(labels.bLabel) : 'B',
			columns,
			rows: rowModels,
			colFullyMatched
		};
	};

	const renderInto = (containerEl, model, options) => {
		if (!containerEl) return;
		const opts = (options && typeof options === 'object') ? options : {};
		const hideMatchedRows = (typeof opts.hideMatchedRows === 'boolean') ? opts.hideMatchedRows : true;
		const hideMatchedColumns = (typeof opts.hideMatchedColumns === 'boolean') ? opts.hideMatchedColumns : true;
		const hideMatchedCells = (typeof opts.hideMatchedCells === 'boolean') ? opts.hideMatchedCells : false;

		const m = (model && typeof model === 'object') ? model : { columns: [], rows: [], colFullyMatched: [] };

		const visibleColIndices = [];
		for (let c = 0; c < (m.columns || []).length; c++) {
			if (hideMatchedColumns && m.colFullyMatched && m.colFullyMatched[c]) continue;
			visibleColIndices.push(c);
		}

		const visibleRows = (m.rows || []).filter(r => {
			if (!r) return false;
			if (hideMatchedRows && r.fullyMatched) return false;
			return true;
		});

		const headerColsHtml = visibleColIndices.map((c) => {
			const col = m.columns[c];
			if (!col) return '';
			const aName = String(col.aName || '').trim();
			const bName = String(col.bName || '').trim();
			if (aName && bName && aName !== bName) {
				return (
					'<th class="diff-col">' +
					'<div class="diff-col-label">' + (String(col.label || '')) + '</div>' +
					'<div class="diff-col-names">' +
					'<span class="diff-col-a">' + escapeHtml(m.aLabel) + ': ' + escapeHtml(aName) + '</span>' +
					'<span class="diff-col-b">' + escapeHtml(m.bLabel) + ': ' + escapeHtml(bName) + '</span>' +
					'</div>' +
					'</th>'
				);
			}
			return '<th class="diff-col"><div class="diff-col-label">' + escapeHtml(String(col.label || '')) + '</div></th>';
		}).join('');

		const bodyHtml = visibleRows.map((r) => {
			const rowLabelParts = [];
			if (typeof r.aRowIndex === 'number' && r.aRowIndex >= 0) rowLabelParts.push(escapeHtml(m.aLabel) + ' #' + String(r.aRowIndex + 1));
			if (typeof r.bRowIndex === 'number' && r.bRowIndex >= 0) rowLabelParts.push(escapeHtml(m.bLabel) + ' #' + String(r.bRowIndex + 1));
			const rowLabel = rowLabelParts.length ? rowLabelParts.join(' / ') : 'Row';

			const cellsHtml = visibleColIndices.map((c) => {
				const cell = r.cells[c];
				if (!cell) return '<td class="diff-cell"></td>';

				if (cell.aMissing && cell.bMissing) {
					return '<td class="diff-cell diff-cell-empty"></td>';
				}

				if (!cell.aMissing && !cell.bMissing && cell.equal) {
					if (hideMatchedCells) {
						return '<td class="diff-cell diff-cell-match diff-cell-empty"></td>';
					}
					return '<td class="diff-cell diff-cell-match"><div class="diff-cell-single">' + escapeHtml(cell.aText) + '</div></td>';
				}

				const aLine = cell.aMissing ? '' : ('<div class="diff-cell-line diff-cell-a"><span class="diff-cell-tag">' + escapeHtml(m.aLabel) + '</span><span class="diff-cell-val">' + escapeHtml(cell.aText) + '</span></div>');
				const bLine = cell.bMissing ? '' : ('<div class="diff-cell-line diff-cell-b"><span class="diff-cell-tag">' + escapeHtml(m.bLabel) + '</span><span class="diff-cell-val">' + escapeHtml(cell.bText) + '</span></div>');
				return '<td class="diff-cell diff-cell-diff">' + aLine + bLine + '</td>';
			}).join('');

			return (
				'<tr class="diff-row' + (r.fullyMatched ? ' diff-row-match' : '') + '">' +
				'<th class="diff-row-label">' + rowLabel + '</th>' +
				cellsHtml +
				'</tr>'
			);
		}).join('');

		const emptyHtml = (visibleRows.length === 0)
			? '<div class="diff-empty">No differences to show.</div>'
			: '';

		containerEl.innerHTML = (
			'<div class="diff-view">' +
			'<div class="diff-view-meta">' +
			'<div class="diff-view-meta-item"><span class="diff-meta-label">' + escapeHtml(m.aLabel) + '</span></div>' +
			'<div class="diff-view-meta-item"><span class="diff-meta-label">' + escapeHtml(m.bLabel) + '</span></div>' +
			'</div>' +
			emptyHtml +
			'<div class="diff-table-wrap">' +
			'<table class="diff-table" aria-label="Dataset diff">' +
			'<thead><tr><th class="diff-corner"></th>' + headerColsHtml + '</tr></thead>' +
			'<tbody>' + bodyHtml + '</tbody>' +
			'</table>' +
			'</div>' +
			'</div>'
		);
	};

	const ensureModalHookups = () => {
		try {
			const modal = document.getElementById('diffViewModal');
			if (!modal) return;
			if (modal.__kustoDiffViewWired) return;
			modal.__kustoDiffViewWired = true;

			// Click outside closes.
			modal.addEventListener('click', (ev) => {
				try {
					if (!ev || ev.target !== modal) return;
					if (typeof window.closeDiffView === 'function') {
						window.closeDiffView();
					}
				} catch { /* ignore */ }
			});
		} catch { /* ignore */ }
	};

	window.closeDiffView = function () {
		try {
			const modal = document.getElementById('diffViewModal');
			if (modal && modal.classList) {
				modal.classList.remove('visible');
			}
		} catch { /* ignore */ }
	};

	window.openDiffViewModal = function (args) {
		ensureModalHookups();

		const aBoxId = args && typeof args === 'object' ? String(args.aBoxId || '') : '';
		const bBoxId = args && typeof args === 'object' ? String(args.bBoxId || '') : '';
		if (!aBoxId || !bBoxId) {
			return;
		}

		let aState = null;
		let bState = null;
		try {
			if (typeof window.__kustoGetResultsState === 'function') {
				aState = window.__kustoGetResultsState(aBoxId);
				bState = window.__kustoGetResultsState(bBoxId);
			}
		} catch { /* ignore */ }
		if (!aState || !bState) {
			try {
				if (window.vscode && typeof window.vscode.postMessage === 'function') {
					window.vscode.postMessage({ type: 'showInfo', message: 'No results available to diff yet. Run both queries first.' });
				}
			} catch { /* ignore */ }
			return;
		}

		const aLabel = (args && args.aLabel) ? String(args.aLabel) : getBoxLabel(aBoxId);
		const bLabel = (args && args.bLabel) ? String(args.bLabel) : getBoxLabel(bBoxId);

		const modal = document.getElementById('diffViewModal');
		const titleEl = document.getElementById('diffViewTitle');
		const bodyEl = document.getElementById('diffViewBody');
		if (!modal || !bodyEl) return;
		try { if (titleEl) titleEl.textContent = 'Diff: ' + aLabel + ' vs ' + bLabel; } catch { /* ignore */ }

		const hideMatchedRowsEl = document.getElementById('diffHideMatchedRows');
		const hideMatchedColsEl = document.getElementById('diffHideMatchedCols');
		const hideMatchedCellsEl = document.getElementById('diffHideMatchedCells');

		const readOptions = () => {
			return {
				hideMatchedRows: hideMatchedRowsEl ? !!hideMatchedRowsEl.checked : true,
				hideMatchedColumns: hideMatchedColsEl ? !!hideMatchedColsEl.checked : true,
				hideMatchedCells: hideMatchedCellsEl ? !!hideMatchedCellsEl.checked : false
			};
		};

		let model = null;
		try {
			model = buildDiffModelFromStates(aState, bState, { aLabel, bLabel }, 'auto');
		} catch {
			model = null;
		}

		const rerender = () => {
			try {
				renderInto(bodyEl, model, readOptions());
			} catch { /* ignore */ }
		};

		try {
			if (hideMatchedRowsEl && !hideMatchedRowsEl.__kustoWired) {
				hideMatchedRowsEl.__kustoWired = true;
				hideMatchedRowsEl.addEventListener('change', rerender);
			}
			if (hideMatchedColsEl && !hideMatchedColsEl.__kustoWired) {
				hideMatchedColsEl.__kustoWired = true;
				hideMatchedColsEl.addEventListener('change', rerender);
			}
			if (hideMatchedCellsEl && !hideMatchedCellsEl.__kustoWired) {
				hideMatchedCellsEl.__kustoWired = true;
				hideMatchedCellsEl.addEventListener('change', rerender);
			}
		} catch { /* ignore */ }

		rerender();

		try {
			modal.classList.add('visible');
			// Focus the close button for keyboard users.
			const closeBtn = document.getElementById('diffViewCloseBtn');
			if (closeBtn && typeof closeBtn.focus === 'function') {
				closeBtn.focus();
			}
		} catch { /* ignore */ }
	};

	// Expose a reusable renderer API for non-modal hosts.
	window.__kustoDiffView = window.__kustoDiffView || {};
	window.__kustoDiffView.buildModelFromResultsStates = buildDiffModelFromStates;
	window.__kustoDiffView.render = renderInto;
})();
