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

	const buildCanonicalColumnsSorted = (aState, bState) => {
		const aCols = getColumns(aState);
		const bCols = getColumns(bState);
		const normalizeName = (n) => {
			try {
				if (typeof window.__kustoNormalizeColumnNameForComparison === 'function') {
					return window.__kustoNormalizeColumnNameForComparison(n);
				}
			} catch { /* ignore */ }
			return safeString(n).trim().toLowerCase();
		};

		// Build a *multiset* union of column names (by normalized name), preserving duplicates.
		// This prevents us from collapsing e.g. "Count" + "count" into one column and
		// accidentally masking differences.
		const aNorm = aCols.map(normalizeName);
		const bNorm = bCols.map(normalizeName);

		const labelByBase = new Map();
		for (let i = 0; i < aCols.length; i++) {
			const base = aNorm[i];
			if (!labelByBase.has(base)) labelByBase.set(base, safeString(aCols[i]));
		}
		for (let i = 0; i < bCols.length; i++) {
			const base = bNorm[i];
			if (!labelByBase.has(base)) labelByBase.set(base, safeString(bCols[i]));
		}

		const countByBaseA = new Map();
		for (const base of aNorm) {
			countByBaseA.set(base, (countByBaseA.get(base) || 0) + 1);
		}
		const countByBaseB = new Map();
		for (const base of bNorm) {
			countByBaseB.set(base, (countByBaseB.get(base) || 0) + 1);
		}
		const baseNames = Array.from(new Set([...
			countByBaseA.keys(),
			countByBaseB.keys()
		]));

		const maxCountByBase = new Map();
		for (const base of baseNames) {
			const aCount = countByBaseA.get(base) || 0;
			const bCount = countByBaseB.get(base) || 0;
			maxCountByBase.set(base, Math.max(aCount, bCount));
		}

		const canonical = [];
		for (const base of baseNames) {
			const maxCount = maxCountByBase.get(base) || 0;
			for (let occ = 0; occ < maxCount; occ++) {
				canonical.push({ base, occ });
			}
		}

		canonical.sort((x, y) => {
			const lx = safeString(labelByBase.get(x.base) || x.base).toLowerCase();
			const ly = safeString(labelByBase.get(y.base) || y.base).toLowerCase();
			if (lx < ly) return -1;
			if (lx > ly) return 1;
			if (x.base < y.base) return -1;
			if (x.base > y.base) return 1;
			return x.occ - y.occ;
		});

		const canonicalBasesForMapping = canonical.map(c => c.base);
		const aMap = buildColumnMappingByName(aState, canonicalBasesForMapping);
		const bMap = buildColumnMappingByName(bState, canonicalBasesForMapping);

		const columns = canonical.map((c, idx) => {
			const aIdx = (aMap && idx < aMap.length) ? aMap[idx] : -1;
			const bIdx = (bMap && idx < bMap.length) ? bMap[idx] : -1;
			const aName = (aIdx >= 0 && aIdx < aCols.length) ? aCols[aIdx] : '';
			const bName = (bIdx >= 0 && bIdx < bCols.length) ? bCols[bIdx] : '';
			const baseLabel = safeString(labelByBase.get(c.base) || aName || bName || c.base || ('col_' + String(idx + 1)));
			const needsSuffix = (maxCountByBase.get(c.base) || 0) > 1;
			const label = needsSuffix ? (baseLabel + ' #' + String(c.occ + 1)) : baseLabel;
			const key = (c.base || ('col_' + String(idx + 1))) + '#' + String(c.occ + 1);
			return { key, label, aIndex: aIdx, bIndex: bIdx, aName, bName };
		});

		return { columns, aMap, bMap };
	};

	const buildRowKeyAndDisplayValues = (row, columnSideIndices) => {
		// Build a stable key based on the canonical column order.
		// Important: treat missing columns as a distinct marker (not the same as null).
		const r = Array.isArray(row) ? row : [];
		const keyParts = [];
		const displayValues = [];
		for (const idx of columnSideIndices) {
			if (typeof idx !== 'number' || idx < 0) {
				keyParts.push(['missing-col', 1]);
				displayValues.push('');
				continue;
			}
			const cell = (idx < r.length) ? r[idx] : undefined;
			keyParts.push(normalizeCell(cell));
			displayValues.push(formatCellForDisplay(cell));
		}
		let key = '';
		try {
			key = JSON.stringify(keyParts);
		} catch {
			key = String(keyParts);
		}
		return { key, displayValues };
	};

	const buildPartitionedRows = (aState, bState, columns) => {
		const aRows = getRows(aState);
		const bRows = getRows(bState);

		const aSideIndices = columns.map(c => c.aIndex);
		const bSideIndices = columns.map(c => c.bIndex);

		const aMap = new Map();
		const aRowData = new Array(aRows.length);
		for (let i = 0; i < aRows.length; i++) {
			const rd = buildRowKeyAndDisplayValues(aRows[i], aSideIndices);
			aRowData[i] = rd;
			if (!aMap.has(rd.key)) aMap.set(rd.key, []);
			aMap.get(rd.key).push(i);
		}

		const bMap = new Map();
		const bRowData = new Array(bRows.length);
		for (let i = 0; i < bRows.length; i++) {
			const rd = buildRowKeyAndDisplayValues(bRows[i], bSideIndices);
			bRowData[i] = rd;
			if (!bMap.has(rd.key)) bMap.set(rd.key, []);
			bMap.get(rd.key).push(i);
		}

		const allKeys = Array.from(new Set([...aMap.keys(), ...bMap.keys()]));
		allKeys.sort();

		const common = [];
		const onlyA = [];
		const onlyB = [];

		for (const key of allKeys) {
			const aList = aMap.get(key) || [];
			const bList = bMap.get(key) || [];
			const sharedCount = Math.min(aList.length, bList.length);
			for (let i = 0; i < sharedCount; i++) {
				const aRowIndex = aList[i];
				const bRowIndex = bList[i];
				common.push({
					aRowIndex,
					bRowIndex,
					values: (aRowData[aRowIndex] && aRowData[aRowIndex].displayValues) ? aRowData[aRowIndex].displayValues : []
				});
			}
			for (let i = sharedCount; i < aList.length; i++) {
				const aRowIndex = aList[i];
				onlyA.push({
					aRowIndex,
					values: (aRowData[aRowIndex] && aRowData[aRowIndex].displayValues) ? aRowData[aRowIndex].displayValues : []
				});
			}
			for (let i = sharedCount; i < bList.length; i++) {
				const bRowIndex = bList[i];
				onlyB.push({
					bRowIndex,
					values: (bRowData[bRowIndex] && bRowData[bRowIndex].displayValues) ? bRowData[bRowIndex].displayValues : []
				});
			}
		}

		return { common, onlyA, onlyB };
	};

	const sanitizeDomIdPart = (s) => {
		try {
			return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_');
		} catch {
			return 'x';
		}
	};

	const renderUsingSharedResultsTable = (hostEl, boxId, label, columns, rows) => {
		try {
			if (!hostEl) return;
			if (typeof window.displayResultForBox !== 'function') {
				hostEl.innerHTML = '<div class="diff-empty">Results table renderer not available.</div>';
				return;
			}
			window.displayResultForBox(
				{ columns: Array.isArray(columns) ? columns : [], rows: Array.isArray(rows) ? rows : [], metadata: {} },
				String(boxId || ''),
				{ resultsDiv: hostEl, label: String(label || 'Results'), showExecutionTime: false }
			);
			// Diff-view tables use synthetic boxIds that don't have a surrounding *_results_wrapper.
			// If the user (or previous state) hid results for that boxId, the shared results
			// visibility handler will hide the entire body, making it look like rows are missing.
			try {
				if (!window.__kustoResultsVisibleByBoxId || typeof window.__kustoResultsVisibleByBoxId !== 'object') {
					window.__kustoResultsVisibleByBoxId = {};
				}
				window.__kustoResultsVisibleByBoxId[String(boxId || '')] = true;
				if (typeof window.__kustoApplyResultsVisibility === 'function') {
					window.__kustoApplyResultsVisibility(String(boxId || ''));
				}
				// Belt-and-suspenders: ensure the body isn't hidden.
				const body = document.getElementById(String(boxId || '') + '_results_body');
				if (body) {
					body.style.display = '';
				}
			} catch { /* ignore */ }
		} catch {
			try { hostEl.innerHTML = '<div class="diff-empty">Failed to render table.</div>'; } catch { /* ignore */ }
		}
	};

	const clampSharedResultsTableToMaxRows = (resultsHostEl, maxRows) => {
		try {
			const host = resultsHostEl;
			if (!host) return;
			const tableContainer = host.querySelector('.table-container');
			const table = host.querySelector('table');
			if (!tableContainer || !table) return;
			const rowEls = table.querySelectorAll('tbody tr');

			const max = (typeof maxRows === 'number' && isFinite(maxRows) && maxRows > 0) ? Math.floor(maxRows) : 10;
			// If the table is already short, remove any previous clamp so it can size to content.
			if (rowEls.length <= max) {
				tableContainer.style.maxHeight = '';
				tableContainer.style.height = '';
				tableContainer.style.overflow = '';
				return;
			}
			const headerEl = table.querySelector('thead');
			const headerH = headerEl ? Math.ceil(headerEl.getBoundingClientRect().height) : 0;

			const take = Math.min(max, rowEls.length);
			let rowsH = 0;
			for (let i = 0; i < take; i++) {
				rowsH += Math.ceil(rowEls[i].getBoundingClientRect().height);
			}
			// Fallback heuristic if measurement fails.
			if (!rowsH && take > 0) {
				rowsH = take * 24;
			}
			const extra = 6; // borders/padding
			const capPx = headerH + rowsH + extra;
			tableContainer.style.maxHeight = String(capPx) + 'px';
			tableContainer.style.overflow = 'auto';
		} catch {
			// ignore
		}
	};

	const getCellFromState = (state, rowIndex, colIndex) => {
		try {
			if (!state || rowIndex == null || colIndex == null) return undefined;
			const rows = getRows(state);
			if (rowIndex < 0 || rowIndex >= rows.length) return undefined;
			const row = rows[rowIndex];
			if (!Array.isArray(row)) return undefined;
			if (colIndex < 0) return undefined;
			return row[colIndex];
		} catch {
			return undefined;
		}
	};

	const buildInnerJoinResult = (model, joinColumnKey) => {
		const m = (model && typeof model === 'object') ? model : null;
		if (!m) return { columns: [], rows: [] };
		const columns = Array.isArray(m.columns) ? m.columns : [];
		const partitions = (m.partitions && typeof m.partitions === 'object') ? m.partitions : { onlyA: [], onlyB: [] };
		const onlyA = Array.isArray(partitions.onlyA) ? partitions.onlyA : [];
		const onlyB = Array.isArray(partitions.onlyB) ? partitions.onlyB : [];
		const aState = m._aState;
		const bState = m._bState;

		const selected = columns.find(c => c && String(c.key) === String(joinColumnKey || '')) || null;
		if (!selected) {
			return { columns: [], rows: [] };
		}
		const joinCanonIdx = columns.findIndex(c => c && String(c.key) === String(selected.key));
		if (joinCanonIdx < 0) {
			return { columns: [], rows: [] };
		}
		if (typeof selected.aIndex !== 'number' || selected.aIndex < 0) {
			return { columns: [], rows: [] };
		}
		if (typeof selected.bIndex !== 'number' || selected.bIndex < 0) {
			return { columns: [], rows: [] };
		}

		const aByKey = new Map();
		for (const r of onlyA) {
			if (!r || typeof r.aRowIndex !== 'number') continue;
			const cell = getCellFromState(aState, r.aRowIndex, selected.aIndex);
			// Ignore missing join values.
			if (cell === undefined) continue;
			let key = '';
			try { key = JSON.stringify(normalizeCell(cell)); } catch { try { key = String(normalizeCell(cell)); } catch { key = String(cell); } }
			if (!aByKey.has(key)) aByKey.set(key, { display: formatCellForDisplay(cell), rows: [] });
			aByKey.get(key).rows.push(r);
		}

		const bByKey = new Map();
		for (const r of onlyB) {
			if (!r || typeof r.bRowIndex !== 'number') continue;
			const cell = getCellFromState(bState, r.bRowIndex, selected.bIndex);
			if (cell === undefined) continue;
			let key = '';
			try { key = JSON.stringify(normalizeCell(cell)); } catch { try { key = String(normalizeCell(cell)); } catch { key = String(cell); } }
			if (!bByKey.has(key)) bByKey.set(key, { display: formatCellForDisplay(cell), rows: [] });
			bByKey.get(key).rows.push(r);
		}

		const outRows = [];
		const keys = Array.from(new Set([...aByKey.keys(), ...bByKey.keys()]));
		keys.sort();

		for (const key of keys) {
			const aGroup = aByKey.get(key);
			const bGroup = bByKey.get(key);
			if (!aGroup || !bGroup) continue;
			const joinDisplay = aGroup.display || bGroup.display || '';
			// SQL-style inner join semantics: duplicates form a cross-product.
			for (const aRow of aGroup.rows) {
				for (const bRow of bGroup.rows) {
					const aVals = Array.isArray(aRow.values) ? aRow.values : [];
					const bVals = Array.isArray(bRow.values) ? bRow.values : [];
					const aTrimmed = aVals.filter((_, i) => i !== joinCanonIdx);
					const bTrimmed = bVals.filter((_, i) => i !== joinCanonIdx);
					outRows.push([joinDisplay, ...aTrimmed, ...bTrimmed]);
				}
			}
		}

		const colLabels = columns.map(c => String((c && c.label) ? c.label : ''));
		const aColLabels = colLabels
			.filter((_, i) => i !== joinCanonIdx)
			.map(n => String(m.aLabel || 'A') + '.' + n);
		const bColLabels = colLabels
			.filter((_, i) => i !== joinCanonIdx)
			.map(n => String(m.bLabel || 'B') + '.' + n);
		const outColumns = [String(selected.label || '')]
			.concat(aColLabels)
			.concat(bColLabels);

		return { columns: outColumns, rows: outRows };
	};

	const buildDiffModelFromStates = (aState, bState, labels) => {
		const { columns } = buildCanonicalColumnsSorted(aState, bState);
		const partitions = buildPartitionedRows(aState, bState, columns);
		return {
			aLabel: (labels && labels.aLabel) ? String(labels.aLabel) : 'A',
			bLabel: (labels && labels.bLabel) ? String(labels.bLabel) : 'B',
			columns,
			partitions,
			_aState: aState,
			_bState: bState
		};
	};

	const renderInto = (containerEl, model, options) => {
		if (!containerEl) return;
		const opts = (options && typeof options === 'object') ? options : {};
		const joinColumnKey = (opts && opts.joinColumnKey != null) ? String(opts.joinColumnKey) : '';
		const diffKeyPrefix = sanitizeDomIdPart(opts && opts.diffKeyPrefix ? opts.diffKeyPrefix : 'diff');

		const m = (model && typeof model === 'object') ? model : { columns: [], partitions: { common: [], onlyA: [], onlyB: [] } };
		const columns = Array.isArray(m.columns) ? m.columns : [];
		const partitions = (m.partitions && typeof m.partitions === 'object') ? m.partitions : { common: [], onlyA: [], onlyB: [] };
		const common = Array.isArray(partitions.common) ? partitions.common : [];
		const onlyA = Array.isArray(partitions.onlyA) ? partitions.onlyA : [];
		const onlyB = Array.isArray(partitions.onlyB) ? partitions.onlyB : [];

		const renderSection = (hostId) => {
			return (
				'<section class="diff-section">' +
				'<div class="diff-results-host" id="' + escapeHtml(hostId) + '"></div>' +
				'</section>'
			);
		};

		const joinSelectOptionsHtml = columns.map((c) => {
			const key = c ? String(c.key) : '';
			const label = c ? String(c.label || '') : '';
			const selectedAttr = (key && joinColumnKey && key === joinColumnKey) ? ' selected' : '';
			return '<option value="' + escapeHtml(key) + '"' + selectedAttr + '>' + escapeHtml(label) + '</option>';
		}).join('');

		const joinHostId = diffKeyPrefix + '_join_host';
		const joinSectionHtml = (
			'<section class="diff-section">' +
			'<div class="diff-join-controls">' +
			'<label class="diff-view-toggle" for="diffJoinColumnSelect">Join column</label>' +
			'<select id="diffJoinColumnSelect" class="diff-join-select">' + joinSelectOptionsHtml + '</select>' +
			'</div>' +
			'<div class="diff-results-host" id="' + escapeHtml(joinHostId) + '"></div>' +
			'</section>'
		);

		containerEl.innerHTML = (
			'<div class="diff-view">' +
			renderSection(diffKeyPrefix + '_common_host') +
			renderSection(diffKeyPrefix + '_onlyA_host') +
			renderSection(diffKeyPrefix + '_onlyB_host') +
			joinSectionHtml +
			'</div>'
		);

		// Now that DOM hosts exist, render each section using the shared results table control.
		try {
			const canonicalLabels = columns.map(c => String((c && c.label) ? c.label : ''));
			{
				const host = document.getElementById(diffKeyPrefix + '_common_host');
				renderUsingSharedResultsTable(host, diffKeyPrefix + '_common', 'Rows common to both', canonicalLabels, common.map(r => Array.isArray(r && r.values) ? r.values : []));
				clampSharedResultsTableToMaxRows(host, 10);
			}
			{
				const host = document.getElementById(diffKeyPrefix + '_onlyA_host');
				const cols = ['Row'].concat(canonicalLabels);
				const rows = onlyA.map(r => ['Row #' + String((r && typeof r.aRowIndex === 'number') ? (r.aRowIndex + 1) : ''), ...(Array.isArray(r && r.values) ? r.values : [])]);
				renderUsingSharedResultsTable(host, diffKeyPrefix + '_onlyA', 'Rows only in ' + String(m.aLabel || 'A'), cols, rows);
				clampSharedResultsTableToMaxRows(host, 10);
			}
			{
				const host = document.getElementById(diffKeyPrefix + '_onlyB_host');
				const cols = ['Row'].concat(canonicalLabels);
				const rows = onlyB.map(r => ['Row #' + String((r && typeof r.bRowIndex === 'number') ? (r.bRowIndex + 1) : ''), ...(Array.isArray(r && r.values) ? r.values : [])]);
				renderUsingSharedResultsTable(host, diffKeyPrefix + '_onlyB', 'Rows only in ' + String(m.bLabel || 'B'), cols, rows);
				clampSharedResultsTableToMaxRows(host, 10);
			}
			const joinHost = document.getElementById(joinHostId);
			const join = buildInnerJoinResult(m, joinColumnKey || (columns[0] ? columns[0].key : ''));
			renderUsingSharedResultsTable(joinHost, diffKeyPrefix + '_join', 'Inner join: only in ' + String(m.aLabel || 'A') + ' ⨝ only in ' + String(m.bLabel || 'B'), join.columns, join.rows);
			clampSharedResultsTableToMaxRows(joinHost, 10);
		} catch { /* ignore */ }
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

		let joinColumnKey = '';

		const readOptions = () => {
			const diffKeyPrefix = 'diff_' + sanitizeDomIdPart(aBoxId) + '_' + sanitizeDomIdPart(bBoxId);
			return {
				joinColumnKey: joinColumnKey,
				diffKeyPrefix: diffKeyPrefix
			};
		};

		let model = null;
		try {
			model = buildDiffModelFromStates(aState, bState, { aLabel, bLabel });
		} catch {
			model = null;
		}

		const rerender = () => {
			try {
				if (!joinColumnKey) {
					try {
						const cols = model && Array.isArray(model.columns) ? model.columns : [];
						joinColumnKey = cols && cols.length ? String(cols[0].key || '') : '';
					} catch { /* ignore */ }
				}
				renderInto(bodyEl, model, readOptions());
				const selectEl = document.getElementById('diffJoinColumnSelect');
				if (selectEl) {
					try { selectEl.value = joinColumnKey || ''; } catch { /* ignore */ }
					selectEl.onchange = () => {
						try { joinColumnKey = String(selectEl.value || ''); } catch { joinColumnKey = ''; }
						rerender();
					};
				}
			} catch { /* ignore */ }
		};

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
