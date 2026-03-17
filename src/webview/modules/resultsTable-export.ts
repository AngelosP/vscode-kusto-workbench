// Copy/export, CSV save, split menus, drag selection, context menu —
// extracted from resultsTable.ts
// Window bridge exports at bottom for remaining legacy callers.
export {};

const _win = window;

function __kustoCopyTextToClipboard(text: any) {
	try {
		navigator.clipboard.writeText(text).then(() => {
			// Copied
		}).catch(err => {
			console.error('Failed to copy:', err);
		});
	} catch (err) {
		console.error('Failed to copy:', err);
	}
}

function __kustoGetDisplayRowsInRange(state: any, displayRowMin: any, displayRowMax: any) {
	const disp = Array.isArray(state.displayRowIndices) ? state.displayRowIndices : null;
	const rows = Array.isArray(state.rows) ? state.rows : [];
	const maxDisplay = (disp && disp.length > 0) ? (disp.length - 1) : (rows.length - 1);
	const minIdx = _win.__kustoClampInt(displayRowMin, 0, Math.max(0, maxDisplay));
	const maxIdx = _win.__kustoClampInt(displayRowMax, 0, Math.max(0, maxDisplay));
	const out = [];
	for (let di = minIdx; di <= maxIdx; di++) {
		out.push(disp ? disp[di] : di);
	}
	return out;
}

function __kustoCellToClipboardString(cell: any) {
	// For cells with display/full structure, prefer display for clipboard (it's usually cleaner for dates).
	// This gives us ISO-formatted dates instead of the long timezone strings.
	try {
		if (cell && typeof cell === 'object' && 'display' in cell && cell.display !== undefined && cell.display !== null) {
			let s = String(cell.display);
			s = s.replace(/\r?\n/g, ' ');
			s = s.replace(/\t/g, ' ');
			return s;
		}
	} catch (e) { console.error('[kusto]', e); }

	const raw = _win.__kustoGetRawCellValue(cell);
	if (raw === null || raw === undefined) return '';
	let s = String(raw);
	// Keep clipboard TSV stable.
	s = s.replace(/\r?\n/g, ' ');
	s = s.replace(/\t/g, ' ');
	return s;
}

function __kustoCellToCsvString(cell: any) {
	// For cells with display/full structure, prefer display for CSV (it's usually cleaner for dates).
	// This gives us ISO-formatted dates instead of the long timezone strings.
	let raw;
	try {
		if (cell && typeof cell === 'object' && 'display' in cell && cell.display !== undefined && cell.display !== null) {
			raw = cell.display;
		} else {
			raw = _win.__kustoGetRawCellValue(cell);
		}
	} catch {
		raw = _win.__kustoGetRawCellValue(cell);
	}

	if (raw === null || raw === undefined) return '';
	let s = String(raw);
	// RFC4180-ish: quote if needed, escape quotes by doubling them.
	const needsQuotes = /[",\r\n]/.test(s);
	if (needsQuotes) {
		s = s.replace(/"/g, '""');
		s = '"' + s + '"';
	}
	return s;
}

function __kustoGetVisibleResultsAsCsv(boxId: any) {
	return __kustoGetResultsAsCsv(boxId, 'visible');
}

function __kustoGetAllResultsAsCsv(boxId: any) {
	return __kustoGetResultsAsCsv(boxId, 'all');
}

function __kustoGetResultsAsCsv(boxId: any, mode: any) {
	const state = _win.__kustoGetResultsState(boxId);
	if (!state) return '';

	try { _win.__kustoEnsureDisplayRowIndexMaps(state); } catch (e) { console.error('[kusto]', e); }
	const cols = Array.isArray(state.columns) ? state.columns : [];
	const rows = Array.isArray(state.rows) ? state.rows : [];
	const disp = Array.isArray(state.displayRowIndices) ? state.displayRowIndices : null;
	const rowIndices = (mode === 'visible') ? (disp ? disp : rows.map((_: any, i: any) => i)) : rows.map((_: any, i: any) => i);

	const header = cols.map((c: any) => __kustoCellToCsvString(c)).join(',');
	const body = rowIndices.map((rowIdx: any) => {
		const row = rows[rowIdx] || [];
		return row.map((cell: any) => __kustoCellToCsvString(cell)).join(',');
	}).join('\r\n');

	// Always end with newline so CSV viewers behave nicely.
	return header + (body ? ('\r\n' + body) : '') + '\r\n';
}


function __kustoMakeSafeCsvFileNameFromLabel(label: any) {
	try {
		let base = String(label || '').trim();
		if (!base) {
			return 'kusto-results.csv';
		}
		// Windows filename sanitization.
		base = base.replace(/[\\/:*?"<>|]/g, '_');
		base = base.replace(/\s+/g, ' ').trim();
		base = base.replace(/[\.\s]+$/g, '');
		if (!base) {
			return 'kusto-results.csv';
		}
		if (!base.toLowerCase().endsWith('.csv')) {
			base = base + '.csv';
		}
		return base;
	} catch {
		return 'kusto-results.csv';
	}
}


function __kustoSaveResultsToCsvFile(boxId: any, sectionLabel: any, mode: any) {
	try {
		const csv = (mode === 'visible') ? __kustoGetVisibleResultsAsCsv(boxId) : __kustoGetAllResultsAsCsv(boxId);
		if (!csv || !csv.trim()) {
			try { _win.vscode && _win.vscode.postMessage && _win.vscode.postMessage({ type: 'showInfo', message: 'No results to save.' }); } catch (e) { console.error('[kusto]', e); }
			return;
		}
		if (typeof _win.vscode === 'undefined' || !_win.vscode || typeof _win.vscode.postMessage !== 'function') {
			// vscode API unavailable - cannot show a message
			return;
		}
		_win.vscode.postMessage({
			type: 'saveResultsCsv',
			boxId: boxId,
			csv: csv,
			suggestedFileName: __kustoMakeSafeCsvFileNameFromLabel(sectionLabel)
		});
	} catch (err) {
		console.error('Failed to prepare CSV:', err);
		try { _win.vscode && _win.vscode.postMessage && _win.vscode.postMessage({ type: 'showInfo', message: 'Failed to save results to file.' }); } catch (e) { console.error('[kusto]', e); }
	}
}

// Back-compat entrypoint (still used by older markup/hosts).
function saveVisibleResultsToCsvFile(boxId: any, sectionLabel: any) {
	__kustoSaveResultsToCsvFile(boxId, sectionLabel, 'visible');
}

function __kustoIsResultsFiltered(state: any) {
	try {
		if (!state) return false;
		const rows = Array.isArray(state.rows) ? state.rows : [];
		const disp = Array.isArray(state.displayRowIndices) ? state.displayRowIndices : null;
		if (disp && disp.length !== rows.length) return true;
		if (state.filteredRowIndices && Array.isArray(state.filteredRowIndices) && state.filteredRowIndices.length !== rows.length) return true;
		const filters = state.columnFilters && typeof state.columnFilters === 'object' ? state.columnFilters : null;
		if (filters) {
			for (const k of Object.keys(filters)) {
				if (__kustoIsFilterSpecActive(filters[k])) return true;
			}
		}
		return false;
	} catch {
		return false;
	}
}

function __kustoIsFilterSpecActive(spec: any): any {
	try {
		if (!spec) return false;
		if (typeof spec !== 'object') return true;
		const kind = String(spec.kind || '');
		if (kind === 'compound') {
			return __kustoIsFilterSpecActive(spec.values) || __kustoIsFilterSpecActive(spec.rules);
		}
		if (kind === 'values') {
			// Any persisted values spec is considered an active filter (normalization should have removed no-ops).
			return true;
		}
		if (kind === 'rules') {
			const rules = Array.isArray(spec.rules) ? spec.rules : null;
			// Empty rules is a no-op; don't treat it as filtered.
			if (!rules || rules.length === 0) {
				// Back-compat: single-rule form.
				if (spec.op) return true;
				return false;
			}
			// Consider active only if at least one rule has an operator.
			return rules.some((r: any) => r && typeof r === 'object' && String(r.op || ''));
		}
		// Unknown spec shapes: treat as active.
		return true;
	} catch {
		return false;
	}
}

function __kustoOnSavePrimary(boxId: any, sectionLabel: any) {
	const state = _win.__kustoGetResultsState(boxId);
	const filtered = __kustoIsResultsFiltered(state);
	// Default: when filtered, save the filtered view; otherwise, save full results.
	__kustoSaveResultsToCsvFile(boxId, sectionLabel, filtered ? 'visible' : 'all');
}

function __kustoOnSaveSecondary(boxId: any, sectionLabel: any) {
	const state = _win.__kustoGetResultsState(boxId);
	const filtered = __kustoIsResultsFiltered(state);
	// When filtered, secondary is the full/unfiltered export.
	__kustoSaveResultsToCsvFile(boxId, sectionLabel, filtered ? 'all' : 'visible');
}

function __kustoHideSplitMenu() {
	try {
		if (_win.__kustoSplitMenuEl) {
			_win.__kustoSplitMenuEl.remove();
		}
	} catch (e) { console.error('[kusto]', e); }
	try { _win.__kustoSplitMenuEl = null; } catch (e) { console.error('[kusto]', e); }
}

function __kustoShowSplitMenu(anchorEl: any, label: any, onClick: any) {
	__kustoShowSplitMenuItems(anchorEl, [{ label, onClick }]);
}

function __kustoShowSplitMenuItems(anchorEl: any, items: any) {
	try { __kustoHideSplitMenu(); } catch (e) { console.error('[kusto]', e); }
	try {
		if (!anchorEl) return;
		const safeItems = Array.isArray(items) ? items : [];
		if (safeItems.length === 0) return;

		const r = anchorEl.getBoundingClientRect();
		const el = document.createElement('div');
		el.className = 'kusto-split-menu';
		el.style.position = 'fixed';
		el.style.left = Math.round(r.left) + 'px';
		el.style.top = Math.round(r.bottom + 4) + 'px';
		el.style.zIndex = '3000';
		el.style.visibility = 'hidden';

		for (const it of safeItems) {
			if (!it || !it.label) continue;
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'kusto-split-menu-item';
			btn.textContent = it.label;
			btn.addEventListener('click', (ev: any) => {
				try { ev.preventDefault(); ev.stopPropagation(); } catch (e) { console.error('[kusto]', e); }
				try { __kustoHideSplitMenu(); } catch (e) { console.error('[kusto]', e); }
				try { it.onClick && it.onClick(); } catch (e) { console.error('[kusto]', e); }
			});
			el.appendChild(btn);
		}

		_win.__kustoSplitMenuEl = el;
		document.body.appendChild(el);

		// Auto-size to content, but clamp to viewport and keep on-screen.
		try {
			const margin = 8;
			const maxW = Math.max(120, (window && window.innerWidth ? (window.innerWidth - margin * 2) : 400));
			// Use scrollWidth for a true fit-to-contents measurement.
			el.style.width = 'max-content';
			el.style.maxWidth = String(maxW) + 'px';
			const desiredW = Math.min((el.scrollWidth || 0) || maxW, maxW);
			el.style.width = Math.round(desiredW) + 'px';
			let left = Math.round(r.left);
			if ((left + desiredW) > (window.innerWidth - margin)) {
				left = Math.round(window.innerWidth - margin - desiredW);
			}
			if (left < margin) left = margin;
			el.style.left = String(left) + 'px';
		} catch (e) { console.error('[kusto]', e); }
		try { el.style.visibility = ''; } catch (e) { console.error('[kusto]', e); }
		setTimeout(() => {
			try {
				document.addEventListener('mousedown', function __kustoSplitMenuDismiss(ev) {
					try {
						if (!_win.__kustoSplitMenuEl) {
							document.removeEventListener('mousedown', __kustoSplitMenuDismiss);
							return;
						}
						if (_win.__kustoSplitMenuEl.contains(ev.target as HTMLElement) || anchorEl.contains(ev.target as HTMLElement)) return;
						__kustoHideSplitMenu();
						document.removeEventListener('mousedown', __kustoSplitMenuDismiss);
					} catch (e) { console.error('[kusto]', e); }
				});
			} catch (e) { console.error('[kusto]', e); }
		}, 0);
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoSetSplitCaretsVisible(boxId: any, visible: any) {
	try {
		const saveCaret = document.getElementById(boxId + '_results_save_menu_btn');
		const copyCaret = document.getElementById(boxId + '_results_copy_menu_btn');
		const saveSplit = document.getElementById(boxId + '_results_save_split');
		const copySplit = document.getElementById(boxId + '_results_copy_split');
		const display = visible ? '' : 'none';
		if (saveCaret) saveCaret.style.display = display;
		if (copyCaret) copyCaret.style.display = display;
		// When carets are hidden, make the primary button look like a normal (non-split) button.
		if (saveSplit) saveSplit.classList.toggle('kusto-split-single', !visible);
		if (copySplit) copySplit.classList.toggle('kusto-split-single', !visible);
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoUpdateSplitButtonState(boxId: any) {
	try {
		const state = _win.__kustoGetResultsState(boxId);
		const filtered = __kustoIsResultsFiltered(state);
		__kustoSetSplitCaretsVisible(boxId, filtered);
		if (!filtered) {
			try { __kustoHideSplitMenu(); } catch (e) { console.error('[kusto]', e); }
		}

		const saveBtn = document.getElementById(boxId + '_results_save_btn');
		const copyBtn = document.getElementById(boxId + '_results_copy_btn');
		const saveTooltip = filtered ? 'Save filtered results' : 'Save results to file';
		const copyTooltip = filtered ? 'Copy filtered results to clipboard' : 'Copy results to clipboard';
		if (saveBtn) { saveBtn.title = saveTooltip; saveBtn.setAttribute('aria-label', saveTooltip); }
		if (copyBtn) { copyBtn.title = copyTooltip; copyBtn.setAttribute('aria-label', copyTooltip); }
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoOnSaveMenu(boxId: any, sectionLabel: any, anchor: any) {
	try {
		const state = _win.__kustoGetResultsState(boxId);
		if (!__kustoIsResultsFiltered(state)) return;
		__kustoShowSplitMenuItems(anchor, [
			{ label: 'Save filtered results', onClick: () => __kustoSaveResultsToCsvFile(boxId, sectionLabel, 'visible') },
			{ label: 'Save all results', onClick: () => __kustoSaveResultsToCsvFile(boxId, sectionLabel, 'all') }
		]);
	} catch (e) { console.error('[kusto]', e); }
}

// Drag selection support: allow mouse-drag to select a rectangular range of cells.
function __kustoEnsureDragSelectionHandlers(boxId: any) {
	try {
		if (!boxId) return;
		const containerId = boxId + '_table_container';
		const container = document.getElementById(containerId);
		if (!container) return;
		// Avoid installing multiple handlers.
		if ((container as any).__kustoDragHandlersInstalled) return;

		let isDragging = false;
		let anchorCell: any = null; // {row, col}

		const getCellFromEvent = (ev: any) => {
			try {
				const td = ev.target && ev.target.closest ? ev.target.closest('td[data-row][data-col]') : null;
				if (!td) return null;
				const r = parseInt(td.getAttribute('data-row'), 10);
				const c = parseInt(td.getAttribute('data-col'), 10);
				if (!isFinite(r) || !isFinite(c)) return null;
				return { row: r, col: c };
			} catch {
				return null;
			}
		};

		const onMouseDown = (ev: any) => {
			try {
				// Only left button
				if (ev.button !== 0) return;
				// Don't steal clicks from interactive controls within cells (e.g. the object/JSON viewer button).
				try {
					const t = ev.target;
					if (t && t.closest && t.closest('button, a, input, textarea, select')) {
						return;
					}
				} catch (e) { console.error('[kusto]', e); }
				const cell = getCellFromEvent(ev);
				// Always focus the container on mousedown, even if not clicking a cell.
				// This ensures the table container receives focus for keyboard navigation and copy.
				ev.preventDefault();
				_win.__kustoFocusTableContainer(container, boxId);
				if (!cell) return;

				const state = _win.__kustoGetResultsState(boxId);
				if (!state) return;

				// Double-click: open the cell viewer.
				// IMPORTANT: drag-selection owns cell interactions (mousedown/mousemove) and also
				// triggers a re-render, so native `dblclick` and inline `onclick` are unreliable.
				let isSyntheticDoubleClick = false;
				try {
					const now = Date.now();
					const last = state.__kustoLastCellMouseDown;
					const sameCell = !!(last && last.row === cell.row && last.col === cell.col);
					const withinWindow = !!(last && isFinite(last.t) && (now - last.t) <= 400);
					if (sameCell && withinWindow && !ev.shiftKey) {
						isSyntheticDoubleClick = true;
					}
					state.__kustoLastCellMouseDown = { row: cell.row, col: cell.col, t: now };
				} catch (e) { console.error('[kusto]', e); }

				// If clicking on an already selected single cell (not extending with shift), deselect it.
				const isClickedCellFocused = state.selectedCell &&
					state.selectedCell.row === cell.row &&
					state.selectedCell.col === cell.col;
				const isSingleCellRange = state.cellSelectionRange &&
					state.cellSelectionRange.colMin === state.cellSelectionRange.colMax &&
					state.cellSelectionAnchor &&
					state.cellSelectionAnchor.row === cell.row &&
					state.cellSelectionAnchor.col === cell.col;

				if (isClickedCellFocused && isSingleCellRange && !ev.shiftKey) {
					// If this is a rapid second click, open the cell viewer instead of clearing selection.
					if (isSyntheticDoubleClick) {
						try {
						if (typeof _win.openCellViewer === 'function') {
							_win.openCellViewer(cell.row, cell.col, boxId);
						} else {
							console.warn('[kusto-query-editor] openCellViewer() not available (did cellViewer.js load?)');
							}
						} catch (e) { console.error('[kusto]', e); }
						return;
					}

					// Clear all cell selection.
					state.selectedCell = null;
					state.cellSelectionAnchor = null;
					state.cellSelectionRange = null;
					anchorCell = null;
					isDragging = false;
					try { _win.__kustoBumpVisualVersion(state); } catch (e) { console.error('[kusto]', e); }
					try { _win.__kustoRerenderResultsTable(boxId); } catch (e) { console.error('[kusto]', e); }
					return;
				}

				// If shift key, extend from existing anchor/caret; otherwise set new anchor
				const extend = !!ev.shiftKey;
				if (!extend) {
					anchorCell = cell;
				} else {
					// use existing anchor if present
					if (state.cellSelectionAnchor) {
						anchorCell = { row: state.cellSelectionAnchor.row, col: state.cellSelectionAnchor.col };
					} else {
						anchorCell = cell;
					}
				}

				isDragging = true;
				// Apply initial selection
				_win.__kustoSetCellSelectionState(boxId, state, cell.row, cell.col, { extend: extend });
				_win.__kustoRerenderResultsTable(boxId);

				// If this was a synthetic double click (same cell, quickly), open the viewer.
				if (isSyntheticDoubleClick) {
					try {
						if (typeof _win.openCellViewer === 'function') {
							_win.openCellViewer(cell.row, cell.col, boxId);
						} else {
							console.warn('[kusto-query-editor] openCellViewer() not available (did cellViewer.js load?)');
						}
					} catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
		};

		const onMouseMove = (ev: any) => {
			try {
				if (!isDragging) return;
				const cell = getCellFromEvent(ev);
				if (!cell) return;
				const state = _win.__kustoGetResultsState(boxId);
				if (!state) return;
				// When dragging, always extend from the anchor we captured on mousedown.
				if (anchorCell) {
					state.cellSelectionAnchor = { row: anchorCell.row, col: anchorCell.col };
				}
				_win.__kustoSetCellSelectionState(boxId, state, cell.row, cell.col, { extend: true });
				_win.__kustoRerenderResultsTable(boxId);
			} catch (e) { console.error('[kusto]', e); }
		};

		const onMouseUp = (ev: any) => {
			try {
				if (!isDragging) return;
				isDragging = false;
				const state = _win.__kustoGetResultsState(boxId);
				if (!state) return;
				// final selection already applied in mousemove/mousedown; ensure focus
				try { const containerEl = document.getElementById(boxId + '_table_container'); if (containerEl) containerEl.focus(); } catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
		};

		// Attach on the container and document for global mouseup
		container.addEventListener('mousedown', onMouseDown);
		container.addEventListener('mousemove', onMouseMove);
		document.addEventListener('mouseup', onMouseUp);

		// Mark installed and keep references for possible cleanup.
		(container as any).__kustoDragHandlersInstalled = true;
		(container as any).__kustoDragHandlers = { onMouseDown, onMouseMove, onMouseUp };
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoRemoveDragSelectionHandlers(boxId: any) {
	try {
		if (!boxId) return;
		const container = document.getElementById(boxId + '_table_container');
		if (!container || !(container as any).__kustoDragHandlersInstalled) return;
		const h = (container as any).__kustoDragHandlers || {};
		if (h.onMouseDown) container.removeEventListener('mousedown', h.onMouseDown);
		if (h.onMouseMove) container.removeEventListener('mousemove', h.onMouseMove);
		if (h.onMouseUp) document.removeEventListener('mouseup', h.onMouseUp);
		(container as any).__kustoDragHandlersInstalled = false;
		(container as any).__kustoDragHandlers = null;
	} catch (e) { console.error('[kusto]', e); }
}

function copyVisibleResultsToClipboard(boxId: any) {
	__kustoCopyResultsToClipboard(boxId, 'visible');
}

function copyAllResultsToClipboard(boxId: any) {
	__kustoCopyResultsToClipboard(boxId, 'all');
}

function __kustoCopyResultsToClipboard(boxId: any, mode: any) {
	const state = _win.__kustoGetResultsState(boxId);
	if (!state) { return; }

	try { _win.__kustoEnsureDisplayRowIndexMaps(state); } catch (e) { console.error('[kusto]', e); }
	const cols = Array.isArray(state.columns) ? state.columns : [];
	const rows = Array.isArray(state.rows) ? state.rows : [];
	const disp = Array.isArray(state.displayRowIndices) ? state.displayRowIndices : null;
	const rowIndices = (mode === 'visible') ? (disp ? disp : rows.map((_: any, i: any) => i)) : rows.map((_: any, i: any) => i);

	const header = cols.map((c: any) => __kustoCellToClipboardString(c)).join('\t');
	const body = rowIndices.map((rowIdx: any) => {
		const row = rows[rowIdx] || [];
		return row.map((cell: any) => __kustoCellToClipboardString(cell)).join('\t');
	}).join('\n');

	const text = header + (body ? ('\n' + body) : '');
	__kustoCopyTextToClipboard(text);
}

function __kustoOnCopyPrimary(boxId: any) {
	const state = _win.__kustoGetResultsState(boxId);
	const filtered = __kustoIsResultsFiltered(state);
	// Default: when filtered, copy the filtered view; otherwise, copy full results.
	__kustoCopyResultsToClipboard(boxId, filtered ? 'visible' : 'all');
}

function __kustoOnCopySecondary(boxId: any) {
	const state = _win.__kustoGetResultsState(boxId);
	const filtered = __kustoIsResultsFiltered(state);
	// When filtered, secondary is the full/unfiltered copy.
	__kustoCopyResultsToClipboard(boxId, filtered ? 'all' : 'visible');
}

function __kustoOnCopyMenu(boxId: any, anchor: any) {
	try {
		const state = _win.__kustoGetResultsState(boxId);
		if (!__kustoIsResultsFiltered(state)) return;
		__kustoShowSplitMenuItems(anchor, [
			{ label: 'Copy filtered results to clipboard', onClick: () => __kustoCopyResultsToClipboard(boxId, 'visible') },
			{ label: 'Copy all results to clipboard', onClick: () => __kustoCopyResultsToClipboard(boxId, 'all') }
		]);
	} catch (e) { console.error('[kusto]', e); }
}

function copySelectionToClipboard(boxId: any) {
	const state = _win.__kustoGetResultsState(boxId);
	if (!state) { return; }

	try { _win.__kustoEnsureDisplayRowIndexMaps(state); } catch (e) { console.error('[kusto]', e); }

	const columns = Array.isArray(state.columns) ? state.columns : [];

	// Prefer a cell range selection.
	if (state.cellSelectionRange && typeof state.cellSelectionRange === 'object') {
		const r = state.cellSelectionRange;
		if (isFinite(r.displayRowMin) && isFinite(r.displayRowMax) && isFinite(r.colMin) && isFinite(r.colMax)) {
			// Only include headers if entire rows are selected (all columns).
			const isEntireRowSelection = r.colMin === 0 && r.colMax === columns.length - 1;

			const rowIndices = __kustoGetDisplayRowsInRange(state, r.displayRowMin, r.displayRowMax);
			const dataLines = rowIndices.map(rowIdx => {
				const row = (state.rows && state.rows[rowIdx]) ? state.rows[rowIdx] : [];
				const cells = [];
				for (let col = r.colMin; col <= r.colMax; col++) {
					cells.push(__kustoCellToClipboardString(row[col]));
				}
				return cells.join('\t');
			});

			if (isEntireRowSelection) {
				// Build header row for the selected columns.
				const headerCells = [];
				for (let col = r.colMin; col <= r.colMax; col++) {
					headerCells.push(__kustoCellToClipboardString(columns[col] || ''));
				}
				const headerLine = headerCells.join('\t');
				__kustoCopyTextToClipboard([headerLine, ...dataLines].join('\n'));
			} else {
				// Partial column selection (specific cells): no headers.
				__kustoCopyTextToClipboard(dataLines.join('\n'));
			}
			return;
		}
	}

	// Next: selected rows.
	if (state.selectedRows && state.selectedRows.size > 0) {
		// Build header row for all columns.
		const headerLine = columns.map((col: any) => __kustoCellToClipboardString(col)).join('\t');

		const rowIndices = Array.from(state.selectedRows).sort((a: any, b: any) => a - b);
		const dataLines = rowIndices.map(rowIdx => {
			const row = state.rows[rowIdx as number] || [];
			return row.map((cell: any) => __kustoCellToClipboardString(cell)).join('\t');
		});
		__kustoCopyTextToClipboard([headerLine, ...dataLines].join('\n'));
		return;
	}

	// Finally: single cell (no header for single cell copy).
	if (state.selectedCell) {
		const cell = state.selectedCell;
		const value = (state.rows && state.rows[cell.row]) ? state.rows[cell.row][cell.col] : '';
		__kustoCopyTextToClipboard(__kustoCellToClipboardString(value));
	}
}

function __kustoHideContextMenu() {
	try {
		if (_win.__kustoContextMenuEl) {
			_win.__kustoContextMenuEl.remove();
		}
	} catch (e) { console.error('[kusto]', e); }
	try { _win.__kustoContextMenuEl = null; } catch (e) { console.error('[kusto]', e); }
}

function handleTableContextMenu(event: any, boxId: any) {
	try {
		if (!event) return;
		event.preventDefault();
		event.stopPropagation();
	} catch (e) { console.error('[kusto]', e); }

	const state = _win.__kustoGetResultsState(boxId);
	if (!state) { return; }

	// If right-clicking a column header, open the column menu at the cursor.
	try {
		const th = event.target && event.target.closest ? event.target.closest('th[data-col]') : null;
		if (th) {
			const colIdx = parseInt(th.getAttribute('data-col'), 10);
			if (isFinite(colIdx) && typeof _win.toggleColumnMenu === 'function') {
				// Close any open column menu first, then open at the right-clicked column.
				try { if (typeof _win.__kustoCloseAllColumnMenus === 'function') _win.__kustoCloseAllColumnMenus(); } catch (e) { console.error('[kusto]', e); }
				_win.toggleColumnMenu(colIdx, boxId);
				// Reposition the menu to the cursor instead of the ☰ button.
				try {
					const menuEl = document.getElementById(boxId + '_col_menu_' + colIdx);
					if (menuEl) {
						menuEl.style.position = 'fixed';
						menuEl.style.left = (event.clientX || 0) + 'px';
						menuEl.style.top = (event.clientY || 0) + 'px';
					}
				} catch (e) { console.error('[kusto]', e); }
			}
			return;
		}
	} catch (e) { console.error('[kusto]', e); }

	// If right-clicking a cell, make it the focus cell first.
	try {
		const td = event.target && event.target.closest ? event.target.closest('td[data-row][data-col]') : null;
		if (td) {
			const r = parseInt(td.getAttribute('data-row'), 10);
			const c = parseInt(td.getAttribute('data-col'), 10);
			if (isFinite(r) && isFinite(c)) {
				// Only change the selection/focus if the clicked cell is NOT already part of
				// the current selection (range or selected rows). This preserves an existing
				// rectangular selection so the user can right-click -> Copy the whole range.
				try {
					const state = _win.__kustoGetResultsState(boxId);
					let clickedInsideRange = false;
					if (state) {
						// Check cellSelectionRange (which uses display row indices).
						const range = (state && state.cellSelectionRange && typeof state.cellSelectionRange === 'object') ? state.cellSelectionRange : null;
						if (range) {
							const inv = Array.isArray(state.rowIndexToDisplayIndex) ? state.rowIndexToDisplayIndex : null;
							const displayIdx = (inv && isFinite(inv[r])) ? inv[r] : r;
							if (isFinite(displayIdx) && isFinite(range.displayRowMin) && isFinite(range.displayRowMax) && isFinite(range.colMin) && isFinite(range.colMax)) {
								if (displayIdx >= range.displayRowMin && displayIdx <= range.displayRowMax && c >= range.colMin && c <= range.colMax) {
									clickedInsideRange = true;
								}
							}
						}
						// Check selected rows
						if (!clickedInsideRange && state.selectedRows && state.selectedRows.has && state.selectedRows.has(r)) {
							clickedInsideRange = true;
						}
						// Check single selectedCell
						if (!clickedInsideRange && state.selectedCell && state.selectedCell.row === r && state.selectedCell.col === c) {
							clickedInsideRange = true;
						}
					}
					if (!clickedInsideRange) {
						_win.selectCell(event, r, c, boxId);
					}
				} catch (e) { console.error('[kusto]', e); }
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	__kustoHideContextMenu();

	// Minimal context menu with just Copy.
	const menu = document.createElement('div');
	menu.className = 'kusto-context-menu';
	menu.style.left = String(event.pageX || 0) + 'px';
	menu.style.top = String(event.pageY || 0) + 'px';
	menu.innerHTML = '<button type="button" class="kusto-context-menu-item">Copy</button>';

	const btn = menu.querySelector('button') as any;
	if (btn) {
		btn.addEventListener('click', (e: any) => {
			try { e.preventDefault(); e.stopPropagation(); } catch (e) { console.error('[kusto]', e); }
			copySelectionToClipboard(boxId);
			__kustoHideContextMenu();
		});
	}

	document.body.appendChild(menu);
	try { _win.__kustoContextMenuEl = menu; } catch (e) { console.error('[kusto]', e); }

	setTimeout(() => {
		try {
			const onDocMouseDown = (e: any) => {
				try {
					if (!menu.contains(e.target as Node)) {
						__kustoHideContextMenu();
						document.removeEventListener('mousedown', onDocMouseDown, true);
					}
				} catch (e) { console.error('[kusto]', e); }
			};
			document.addEventListener('mousedown', onDocMouseDown, true);
		} catch (e) { console.error('[kusto]', e); }
	}, 0);
}


// ── Fixed-position tooltip for results title row ──
// Uses position:fixed so the tooltip escapes any overflow:hidden ancestors.
// A delegated mouseenter/mouseleave handler positions and shows/hides using a class.

// ── Window bridges for remaining legacy callers ──
window.__kustoCopyTextToClipboard = __kustoCopyTextToClipboard;
window.__kustoGetDisplayRowsInRange = __kustoGetDisplayRowsInRange;
window.__kustoCellToClipboardString = __kustoCellToClipboardString;
window.__kustoCellToCsvString = __kustoCellToCsvString;
window.__kustoGetVisibleResultsAsCsv = __kustoGetVisibleResultsAsCsv;
window.__kustoGetAllResultsAsCsv = __kustoGetAllResultsAsCsv;
window.__kustoGetResultsAsCsv = __kustoGetResultsAsCsv;
window.__kustoMakeSafeCsvFileNameFromLabel = __kustoMakeSafeCsvFileNameFromLabel;
window.__kustoSaveResultsToCsvFile = __kustoSaveResultsToCsvFile;
window.saveVisibleResultsToCsvFile = saveVisibleResultsToCsvFile;
window.__kustoIsResultsFiltered = __kustoIsResultsFiltered;
window.__kustoIsFilterSpecActive = __kustoIsFilterSpecActive;
window.__kustoOnSavePrimary = __kustoOnSavePrimary;
window.__kustoOnSaveSecondary = __kustoOnSaveSecondary;
window.__kustoHideSplitMenu = __kustoHideSplitMenu;
window.__kustoShowSplitMenu = __kustoShowSplitMenu;
window.__kustoShowSplitMenuItems = __kustoShowSplitMenuItems;
window.__kustoSetSplitCaretsVisible = __kustoSetSplitCaretsVisible;
window.__kustoUpdateSplitButtonState = __kustoUpdateSplitButtonState;
window.__kustoOnSaveMenu = __kustoOnSaveMenu;
window.__kustoEnsureDragSelectionHandlers = __kustoEnsureDragSelectionHandlers;
window.__kustoRemoveDragSelectionHandlers = __kustoRemoveDragSelectionHandlers;
window.copyVisibleResultsToClipboard = copyVisibleResultsToClipboard;
window.copyAllResultsToClipboard = copyAllResultsToClipboard;
window.__kustoCopyResultsToClipboard = __kustoCopyResultsToClipboard;
window.__kustoOnCopyPrimary = __kustoOnCopyPrimary;
window.__kustoOnCopySecondary = __kustoOnCopySecondary;
window.__kustoOnCopyMenu = __kustoOnCopyMenu;
window.copySelectionToClipboard = copySelectionToClipboard;
window.__kustoHideContextMenu = __kustoHideContextMenu;
window.handleTableContextMenu = handleTableContextMenu;
