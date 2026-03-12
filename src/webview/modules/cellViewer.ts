// Cell Viewer module — converted from legacy/cellViewer.js
// Window bridge exports at bottom for remaining inline onclick callers.
export {};

declare const escapeHtml: (s: string) => string;
declare const escapeRegex: (s: string) => string;
declare const __kustoGetResultsState: ((boxId: string) => {
	columns: any[];
	rows: any[][];
	searchMatches?: { row: number; col: number }[];
} | null) | undefined;

const _win = window as unknown as Record<string, unknown>;

/**
 * State for the cell viewer.
 */
_win.__kustoCellViewerState = null;

function __kustoSetCellViewerNavEnabled(enabled: boolean, matchCount: number): void {
	try {
		// Use embedded nav buttons from search control.
		const prevBtn = document.getElementById('cellViewerSearch_prev') as HTMLButtonElement | null;
		const nextBtn = document.getElementById('cellViewerSearch_next') as HTMLButtonElement | null;
		if (typeof (_win.__kustoSetSearchNavEnabled) === 'function') {
			(_win.__kustoSetSearchNavEnabled as any)(prevBtn, nextBtn, enabled, matchCount);
		} else {
			const canNav = enabled && matchCount > 1;
			if (prevBtn) prevBtn.disabled = !canNav;
			if (nextBtn) nextBtn.disabled = !canNav;
		}
	} catch { /* ignore */ }
}

function __kustoUpdateCellViewerSearchStatus(): void {
	const st = _win.__kustoCellViewerState as any;
	// Use embedded status from search control.
	const statusEl = document.getElementById('cellViewerSearch_status');
	const total = (st && typeof st.matchCount === 'number' && isFinite(st.matchCount)) ? st.matchCount : 0;
	const cur = (st && typeof st.currentMatchIndex === 'number' && isFinite(st.currentMatchIndex)) ? st.currentMatchIndex : 0;
	const hasError = st && st.searchError;
	const hasSearch = st && st.searchTerm;

	if (typeof (_win.__kustoUpdateSearchStatus) === 'function') {
		if (hasError) {
			(_win.__kustoUpdateSearchStatus as any)(statusEl, 0, 0, true, st.searchError);
		} else if (!hasSearch) {
			(_win.__kustoUpdateSearchStatus as any)(statusEl, 0, 0, false, '');
		} else {
			(_win.__kustoUpdateSearchStatus as any)(statusEl, total, cur, false, '');
		}
	}

	if (hasError || !hasSearch || total <= 0) {
		__kustoSetCellViewerNavEnabled(false, 0);
	} else {
		__kustoSetCellViewerNavEnabled(true, total);
	}
}

function __kustoGetCellViewerMatchElement(matchIndex: number): Element | null {
	try {
		const content = document.getElementById('cellViewerContent');
		if (!content) return null;
		return content.querySelector('span.cell-viewer-highlight[data-kusto-match-index="' + String(matchIndex) + '"]');
	} catch {
		return null;
	}
}

function __kustoApplyCellViewerCurrentMatch(scrollIntoView: boolean): void {
	const st = _win.__kustoCellViewerState as any;
	if (!st) return;
	const total = (typeof st.matchCount === 'number' && isFinite(st.matchCount)) ? st.matchCount : 0;
	if (total <= 0) {
		__kustoUpdateCellViewerSearchStatus();
		return;
	}
	let cur = (typeof st.currentMatchIndex === 'number' && isFinite(st.currentMatchIndex)) ? st.currentMatchIndex : 0;
	cur = ((cur % total) + total) % total;
	st.currentMatchIndex = cur;

	try {
		const content = document.getElementById('cellViewerContent');
		if (content) {
			content.querySelectorAll('span.cell-viewer-highlight.cell-viewer-highlight-current')
				.forEach((el) => el.classList.remove('cell-viewer-highlight-current'));
		}
	} catch { /* ignore */ }

	const el = __kustoGetCellViewerMatchElement(cur);
	if (el) {
		try { el.classList.add('cell-viewer-highlight-current'); } catch { /* ignore */ }
		if (scrollIntoView) {
			try {
				el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
			} catch { /* ignore */ }
		}
	}

	__kustoUpdateCellViewerSearchStatus();
}

/**
 * Open the cell viewer for any cell (not just objects).
 */
function openCellViewer(row: number, col: number, boxId: string): void {
	const state = typeof __kustoGetResultsState === 'function' ? __kustoGetResultsState(boxId) : null;
	if (!state || !state.rows || !state.rows[row]) { return; }

	const cell = state.rows[row][col];
	const columnName = __kustoGetCellViewerColumnName(state, col);

	// Extract the raw value from the cell.
	let rawValue = '';
	if (cell === null || cell === undefined) {
		rawValue = cell === null ? 'null' : '';
	} else if (typeof cell === 'object' && cell !== null) {
		if ('full' in cell && cell.full !== undefined && cell.full !== null) {
			rawValue = String(cell.full);
		} else if ('display' in cell && cell.display !== undefined && cell.display !== null) {
			rawValue = String(cell.display);
		} else if (cell.isObject && cell.full) {
			rawValue = String(cell.full);
		} else {
			try {
				rawValue = JSON.stringify(cell, null, 2);
			} catch {
				rawValue = String(cell);
			}
		}
	} else {
		rawValue = String(cell);
	}

	const modal = document.getElementById('cellViewer');
	const titleEl = document.getElementById('cellViewerTitle');
	try { __kustoEnsureCellViewerSearchControl(); } catch { /* ignore */ }
	const searchInput = document.getElementById('cellViewerSearch') as HTMLInputElement | null;
	const searchMode = document.getElementById('cellViewerSearchMode') as HTMLElement | null;
	const content = document.getElementById('cellViewerContent');

	// Set the title.
	try {
		if (titleEl) {
			titleEl.textContent = '';
			titleEl.appendChild(document.createTextNode('Cell viewer for '));
			const strong = document.createElement('strong');
			strong.textContent = columnName;
			titleEl.appendChild(strong);
		}
	} catch { /* ignore */ }

	// Store state.
	_win.__kustoCellViewerState = {
		boxId: boxId,
		row: row,
		col: col,
		columnName: columnName,
		rawValue: rawValue,
		searchTerm: '',
		searchMode: 'wildcard',
		searchError: '',
		matchCount: 0,
		currentMatchIndex: 0
	};

	// Initialize icons if needed.
	try { __kustoEnsureCellViewerCopyIcon(); } catch { /* ignore */ }

	// Check if there's an active data search and if this cell is a search match.
	const dataSearchInput = document.getElementById(boxId + '_data_search') as HTMLInputElement | null;
	const dataSearchMode = document.getElementById(boxId + '_data_search_mode') as HTMLElement | null;
	const dataSearchTerm = dataSearchInput ? dataSearchInput.value : '';
	const isSearchMatch = dataSearchTerm && state.searchMatches &&
		state.searchMatches.some((m: any) => m.row === row && m.col === col);

	const st = _win.__kustoCellViewerState as any;

	if (isSearchMatch) {
		// Pre-populate search with the current search term.
		if (searchInput) searchInput.value = dataSearchTerm;
		try {
			const dataModeVal = dataSearchMode ? ((dataSearchMode as any).dataset.mode || (dataSearchMode as any).value) : null;
			if (searchMode && dataModeVal) {
				(searchMode as any).dataset.mode = String(dataModeVal);
				if (typeof (_win.__kustoUpdateSearchModeToggle) === 'function') (_win.__kustoUpdateSearchModeToggle as any)(searchMode, dataModeVal);
				st.searchMode = String(dataModeVal);
			}
		} catch { /* ignore */ }
		st.searchTerm = dataSearchTerm;
		st.currentMatchIndex = 0;
		st.searchError = '';
	} else {
		if (searchInput) searchInput.value = '';
		try {
			if (searchMode) {
				(searchMode as any).dataset.mode = 'wildcard';
				if (typeof (_win.__kustoUpdateSearchModeToggle) === 'function') (_win.__kustoUpdateSearchModeToggle as any)(searchMode, 'wildcard');
			}
		} catch { /* ignore */ }
		st.searchTerm = '';
		st.searchMode = 'wildcard';
		st.searchError = '';
		st.currentMatchIndex = 0;
	}

	// Render the content.
	__kustoRenderCellViewerContent();
	try { __kustoApplyCellViewerCurrentMatch(true); } catch { /* ignore */ }

	// Show the modal.
	if (modal) modal.classList.add('visible');

	// Focus the search input.
	setTimeout(() => {
		try { if (searchInput) searchInput.focus(); } catch { /* ignore */ }
	}, 50);
}

function __kustoEnsureCellViewerSearchControl(): void {
	try {
		if (document.getElementById('cellViewerSearch')) return;
		const host = document.getElementById('cellViewerSearchHost');
		if (!host) return;
		if (typeof (_win.__kustoCreateSearchControl) !== 'function') return;

		(_win.__kustoCreateSearchControl as any)(host, {
			inputId: 'cellViewerSearch',
			modeId: 'cellViewerSearchMode',
			ariaLabel: 'Search',
			onInput: function () { searchInCellViewer(); },
			onPrev: function () { cellViewerNavigateMatch(-1); },
			onNext: function () { cellViewerNavigateMatch(1); },
			onKeyDown: function (e: KeyboardEvent) {
				if (e.key === 'Enter') {
					e.preventDefault();
					cellViewerNavigateMatch(e.shiftKey ? -1 : 1);
				}
			}
		});
	} catch { /* ignore */ }
}

/**
 * Close the cell viewer modal.
 */
function closeCellViewer(event?: Event): void {
	if (event && event.target !== event.currentTarget && !(event.currentTarget as HTMLElement).classList.contains('cell-viewer-close')) {
		return;
	}

	const modal = document.getElementById('cellViewer');
	if (modal) modal.classList.remove('visible');
	_win.__kustoCellViewerState = null;
}

/**
 * Get the column name for the cell viewer title.
 */
function __kustoGetCellViewerColumnName(state: any, colIndex: number): string {
	try {
		const cols = (state && Array.isArray(state.columns)) ? state.columns : [];
		const col = cols[colIndex];
		if (typeof col === 'string') return col;
		if (col && typeof col === 'object') {
			if (typeof col.name === 'string' && col.name) return col.name;
			if (typeof col.columnName === 'string' && col.columnName) return col.columnName;
			if (typeof col.displayName === 'string' && col.displayName) return col.displayName;
		}
	} catch { /* ignore */ }
	return 'column ' + (colIndex + 1);
}

/**
 * Render the cell viewer content with optional search highlighting.
 */
function __kustoRenderCellViewerContent(): void {
	const state = _win.__kustoCellViewerState as any;
	if (!state) { return; }

	const content = document.getElementById('cellViewerContent');
	if (!content) { return; }

	const rawValue = state.rawValue || '';
	const searchTerm = state.searchTerm || '';
	const searchMode = state.searchMode || 'wildcard';
	state.searchError = '';

	if (!searchTerm) {
		// No search - just display the raw value with proper escaping.
		content.innerHTML = '';
		content.textContent = rawValue;
		state.matchCount = 0;
		state.currentMatchIndex = 0;
		__kustoUpdateCellViewerSearchStatus();
		return;
	}

	let built: any = { regex: null, error: null };
	try {
		if (typeof (_win.__kustoTryBuildSearchRegex) === 'function') {
			built = (_win.__kustoTryBuildSearchRegex as any)(searchTerm, searchMode);
		} else {
			built = { regex: new RegExp(escapeRegex(String(searchTerm).trim()), 'gi'), error: null };
		}
	} catch {
		built = { regex: null, error: 'Invalid regex. Please fix the pattern.' };
	}

	if (built && built.error) {
		state.searchError = String(built.error);
		content.innerHTML = '';
		content.textContent = rawValue;
		state.matchCount = 0;
		state.currentMatchIndex = 0;
		__kustoUpdateCellViewerSearchStatus();
		return;
	}

	const regex = built && built.regex ? built.regex : null;
	const render = (regex && typeof (_win.__kustoHighlightPlainTextToHtml) === 'function')
		? (_win.__kustoHighlightPlainTextToHtml as any)(rawValue, regex, { highlightClass: 'cell-viewer-highlight', includeMatchIndex: true, maxMatches: 5000 })
		: { html: escapeHtml(String(rawValue || '')), count: 0 };

	state.matchCount = render && typeof render.count === 'number' ? render.count : 0;
	if (!(typeof state.currentMatchIndex === 'number' && isFinite(state.currentMatchIndex))) {
		state.currentMatchIndex = 0;
	}
	if (state.matchCount > 0) {
		state.currentMatchIndex = Math.min(state.matchCount - 1, Math.max(0, state.currentMatchIndex));
	} else {
		state.currentMatchIndex = 0;
	}

	content.innerHTML = render && typeof render.html === 'string' ? render.html : escapeHtml(String(rawValue || ''));
	__kustoApplyCellViewerCurrentMatch(false);
}

/**
 * Handle search input in the cell viewer.
 */
function searchInCellViewer(): void {
	const state = _win.__kustoCellViewerState as any;
	if (!state) { return; }

	try { __kustoEnsureCellViewerSearchControl(); } catch { /* ignore */ }
	let nextTerm = '';
	let nextMode = 'wildcard';
	try {
		if (typeof (_win.__kustoGetSearchControlState) === 'function') {
			const st = (_win.__kustoGetSearchControlState as any)('cellViewerSearch', 'cellViewerSearchMode');
			nextTerm = st ? String(st.query || '') : '';
			nextMode = st && st.mode ? String(st.mode) : 'wildcard';
		} else {
			const searchInput = document.getElementById('cellViewerSearch') as HTMLInputElement | null;
			nextTerm = searchInput ? String(searchInput.value || '') : '';
			nextMode = 'wildcard';
		}
	} catch { /* ignore */ }
	const prevTerm = state.searchTerm;
	const prevMode = state.searchMode;
	state.searchTerm = nextTerm;
	state.searchMode = nextMode;
	state.searchError = '';
	if (String(prevTerm || '') !== String(nextTerm || '') || String(prevMode || '') !== String(nextMode || '')) {
		state.currentMatchIndex = 0;
	}
	__kustoRenderCellViewerContent();
	try { __kustoApplyCellViewerCurrentMatch(true); } catch { /* ignore */ }
}

function cellViewerNextMatch(): void {
	const st = _win.__kustoCellViewerState as any;
	if (!st || !st.searchTerm) return;
	const total = (typeof st.matchCount === 'number' && isFinite(st.matchCount)) ? st.matchCount : 0;
	if (total <= 0) return;
	st.currentMatchIndex = ((st.currentMatchIndex || 0) + 1) % total;
	__kustoApplyCellViewerCurrentMatch(true);
}

function cellViewerPreviousMatch(): void {
	const st = _win.__kustoCellViewerState as any;
	if (!st || !st.searchTerm) return;
	const total = (typeof st.matchCount === 'number' && isFinite(st.matchCount)) ? st.matchCount : 0;
	if (total <= 0) return;
	st.currentMatchIndex = ((st.currentMatchIndex || 0) - 1 + total) % total;
	__kustoApplyCellViewerCurrentMatch(true);
}

/**
 * Navigate to next (+1) or previous (-1) match.
 */
function cellViewerNavigateMatch(delta: number): void {
	if (delta > 0) {
		cellViewerNextMatch();
	} else {
		cellViewerPreviousMatch();
	}
}

/**
 * Copy the cell viewer content to clipboard.
 */
function copyCellViewerToClipboard(): void {
	const state = _win.__kustoCellViewerState as any;
	if (!state) { return; }

	const content = document.getElementById('cellViewerContent');
	let textToCopy = '';

	// Check if there's a selection within the content.
	try {
		const sel = window.getSelection && window.getSelection();
		const hasSelection = sel && !sel.isCollapsed && typeof sel.toString === 'function' && sel.toString();
		const inContent = sel && sel.anchorNode && sel.focusNode && content && content.contains(sel.anchorNode) && content.contains(sel.focusNode);
		if (hasSelection && inContent) {
			textToCopy = sel!.toString();
		}
	} catch { /* ignore */ }

	// Fall back to the full raw value.
	if (!textToCopy) {
		textToCopy = state.rawValue || '';
	}

	if (typeof (_win.__kustoWriteTextToClipboard) === 'function') {
		(_win.__kustoWriteTextToClipboard as any)(textToCopy);
	}
}

/**
 * Ensure the copy icon is set on the cell viewer copy button.
 */
function __kustoEnsureCellViewerCopyIcon(): void {
	const btn = document.getElementById('cellViewerCopy') as any;
	if (!btn) { return; }
	if (btn.__kustoHasIcon) { return; }
	btn.__kustoHasIcon = true;
	try {
		if (typeof (_win.__kustoGetCopyIconSvg) === 'function') {
			btn.innerHTML = (_win.__kustoGetCopyIconSvg as any)(16);
		} else {
			btn.innerHTML = (
				'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
				'<rect x="5" y="5" width="9" height="9" rx="2" />' +
				'<path d="M3 11V4c0-1.1.9-2 2-2h7" />' +
				'</svg>'
			);
		}
	} catch {
		btn.textContent = 'Copy';
	}
}

/**
 * Handle double-click on a table cell to open the cell viewer.
 */
function handleCellDoubleClick(event: Event, row: number, col: number, boxId: string): void {
	try {
		event.stopPropagation();
		event.preventDefault();
	} catch { /* ignore */ }
	openCellViewer(row, col, boxId);
}

/**
 * Handle keyboard navigation in the cell viewer.
 */
function handleCellViewerKeydown(event: KeyboardEvent): void {
	if (!_win.__kustoCellViewerState) { return; }

	if (event.key === 'Escape') {
		closeCellViewer();
		event.preventDefault();
		return;
	}

	if (event.key === 'Enter') {
		try {
			if (event.shiftKey) {
				cellViewerPreviousMatch();
			} else {
				cellViewerNextMatch();
			}
			event.preventDefault();
		} catch { /* ignore */ }
		return;
	}
	if (event.key === 'F3') {
		try {
			if (event.shiftKey) {
				cellViewerPreviousMatch();
			} else {
				cellViewerNextMatch();
			}
			event.preventDefault();
		} catch { /* ignore */ }
		return;
	}
}

// Register global keydown handler for cell viewer when it's open.
document.addEventListener('keydown', function(event) {
	const modal = document.getElementById('cellViewer');
	if (modal && modal.classList.contains('visible')) {
		handleCellViewerKeydown(event);
	}
});

// ======================================================================
// Window bridge: expose globals for remaining legacy callers / onclick
// ======================================================================
_win.openCellViewer = openCellViewer;
_win.closeCellViewer = closeCellViewer;
_win.handleCellDoubleClick = handleCellDoubleClick;
_win.copyCellViewerToClipboard = copyCellViewerToClipboard;
_win.searchInCellViewer = searchInCellViewer;
_win.cellViewerNavigateMatch = cellViewerNavigateMatch;
_win.cellViewerNextMatch = cellViewerNextMatch;
_win.cellViewerPreviousMatch = cellViewerPreviousMatch;
_win.handleCellViewerKeydown = handleCellViewerKeydown;
