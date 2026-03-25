import { LitElement, html, nothing, type TemplateResult, type PropertyValues } from 'lit';
import { styles } from './kw-data-table.styles.js';
import { customElement, property, state } from 'lit/decorators.js';
import { createTable, getCoreRowModel, getSortedRowModel, getFilteredRowModel, type Table, type ColumnDef, type SortingState, type ColumnFiltersState, type Row, type CellContext, type RowSelectionState, type Column } from '@tanstack/table-core';
import type { KwObjectViewer } from './kw-object-viewer.js';
import { rowMatchesFilterSpec, isColumnFiltered, getFilterSpecForColumn, type ColumnFilterSpec } from './kw-filter-dialog.js';
import type { UniqueValuesMode } from './kw-unique-values-dialog.js';
import './kw-filter-dialog.js';
import './kw-sort-dialog.js';
import { highlightMatches } from './search-utils.js';
import { pushDismissable, removeDismissable } from './dismiss-stack.js';
import './kw-search-bar.js';
import { TableVirtualScrollController } from './table-virtual-scroll.controller.js';
import { TableRowJumpController } from './table-row-jump.controller.js';
import { TableSearchController } from './table-search.controller.js';
import { TableSelectionController } from './table-selection.controller.js';

export interface DataTableColumn { name: string; type?: string; }
export interface DataTableOptions {
	label?: string; showExecutionTime?: boolean; executionTime?: string;
	compact?: boolean; showToolbar?: boolean;
	/** Hide the top border of the table container. */
	hideTopBorder?: boolean;
	/** Show save button — fires 'save' CustomEvent when clicked. */
	showSave?: boolean;
	/** Show visibility toggle — fires 'visibility-toggle' CustomEvent. */
	showVisibilityToggle?: boolean;
	/** Initial body visibility (default true). Set to false to start with results hidden. */
	initialBodyVisible?: boolean;
	/** Query metadata — client activity ID and server stats shown in a hover tooltip. */
	metadata?: { clientActivityId?: string; serverStats?: Record<string, unknown> };
}
export type CellValue = string | number | boolean | null | undefined | { display?: string; full?: unknown; isObject?: boolean };
export interface CellRange { rowMin: number; rowMax: number; colMin: number; colMax: number; }

export function getCellDisplayValue(cell: CellValue): string {
	if (cell === null || cell === undefined) return '';
	if (typeof cell === 'string') return cell;
	if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
	if (typeof cell === 'object') {
		if ('display' in cell && cell.display !== undefined) return String(cell.display);
		if ('full' in cell) { const f = cell.full; if (f === null || f === undefined) return ''; if (typeof f === 'string') return f; try { return JSON.stringify(f); } catch { return String(f); } }
	}
	try { return JSON.stringify(cell); } catch { return String(cell); }
}
export function getCellSortValue(cell: CellValue): string | number | boolean | null {
	if (cell === null || cell === undefined) return null;
	if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') return cell;
	if (typeof cell === 'object' && 'full' in cell) { const f = cell.full; if (typeof f === 'number' || typeof f === 'string' || typeof f === 'boolean') return f; }
	return getCellDisplayValue(cell);
}

/**
 * Pure function that builds the tab-separated clipboard text for a data table.
 * Extracted so it can be unit-tested independently.
 */
export function buildClipboardText(
	columns: DataTableColumn[],
	rows: CellValue[][],
	selectionRange: CellRange | null,
	selectedCell: { row: number; col: number } | null,
): string {
	if (selectionRange) {
		const { rowMin, rowMax, colMin, colMax } = selectionRange;
		// A 1×1 range is a single cell — copy just the value, no header.
		if (rowMin === rowMax && colMin === colMax) {
			const row = rows[rowMin];
			if (row) return getCellDisplayValue(row[colMin]);
			return '';
		}
		const lines = [columns.slice(colMin, colMax + 1).map(c => c.name).join('\t')];
		for (let r = rowMin; r <= rowMax; r++) {
			const row = rows[r];
			if (!row) continue;
			const cells: string[] = [];
			for (let c = colMin; c <= colMax; c++) cells.push(getCellDisplayValue(row[c]));
			lines.push(cells.join('\t'));
		}
		return lines.join('\n');
	}
	if (selectedCell) {
		const row = rows[selectedCell.row];
		if (row) return getCellDisplayValue(row[selectedCell.col]);
	}
	const lines = [columns.map(c => c.name).join('\t')];
	for (const row of rows) {
		lines.push(row.map(cell => getCellDisplayValue(cell)).join('\t'));
	}
	return lines.join('\n');
}

// ── Column type inference for sorting ──

export type ColumnSortType = 'string' | 'number' | 'date' | 'boolean';

const _numRx = /^[+-]?(?:\d+\.?\d*|\d*\.?\d+)(?:[eE][+-]?\d+)?$/;

export function tryParseNum(raw: unknown): number | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
	if (typeof raw === 'boolean') return null;
	const s = String(raw).trim();
	if (s === '' || !_numRx.test(s)) return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

const _isoDateRx = /^\d{4}-\d{2}-\d{2}[T ]/;
const _verboseDateRx = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d/i;

export function tryParseDateMs(raw: unknown): number | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === 'number' || typeof raw === 'boolean') return null;
	const s = String(raw).trim();
	if (s.length < 8) return null;
	// Only attempt parse for strings that look like dates, not arbitrary text
	if (!_isoDateRx.test(s) && !_verboseDateRx.test(s)) return null;
	const t = Date.parse(s);
	return Number.isFinite(t) ? t : null;
}

export function kustoTypeToSortType(kustoType: string | undefined): ColumnSortType | null {
	if (!kustoType) return null;
	const t = kustoType.toLowerCase().replace(/^system\./, '');
	switch (t) {
		case 'int': case 'long': case 'real': case 'decimal':
		case 'int32': case 'int64': case 'double': case 'float': return 'number';
		case 'datetime': case 'date': return 'date';
		case 'bool': case 'boolean': return 'boolean';
		case 'string': case 'guid': return 'string';
		default: return null;
	}
}

export function inferColumnTypes(columns: DataTableColumn[], rows: CellValue[][]): ColumnSortType[] {
	return columns.map((col, i) => {
		// 1. Column metadata from Kusto (most reliable)
		const fromMeta = kustoTypeToSortType(col.type);
		if (fromMeta) return fromMeta;

		// 2. Heuristic: sample first non-null values
		let numHits = 0, dateHits = 0, boolHits = 0, sample = 0;
		const limit = Math.min(rows.length, 100);
		for (let r = 0; r < limit; r++) {
			const row = rows[r];
			if (!row) continue;
			const cell = row[i];
			const raw = (typeof cell === 'object' && cell !== null && 'full' in cell) ? cell.full : cell;
			if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) continue;
			sample++;
			if (typeof raw === 'boolean') { boolHits++; continue; }
			if (tryParseNum(raw) !== null) numHits++;
			if (tryParseDateMs(raw) !== null) dateHits++;
		}
		if (sample === 0) return 'string';
		const threshold = Math.max(1, Math.floor(sample * 0.6));
		if (boolHits >= threshold) return 'boolean';
		if (numHits >= threshold) return 'number';
		// Only infer date if not also parseable as numbers
		if (dateHits >= threshold && numHits < threshold) return 'date';
		return 'string';
	});
}
function fmtNum(val: number): string { try { return val.toLocaleString(undefined, { maximumFractionDigits: 20 }); } catch { return String(val); } }
function fmtDateStr(s: string): string | null {
	// ISO 8601 date-time → "YYYY-MM-DD HH:MM:SS"
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
		if (!Number.isFinite(Date.parse(s))) return null;
		return s.replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '');
	}
	// Already in target format
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
	// Verbose Date.toString() format: "Sat Mar 07 2026 18:00:00 GMT-0600 (...)"
	const verbosePattern = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d/i;
	if (verbosePattern.test(s)) {
		const parsed = Date.parse(s);
		if (Number.isFinite(parsed)) {
			const d = new Date(parsed);
			const formatted = d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
			return formatted;
		}
	}
	return null;
}
function fmtStr(s: string): string {
	const t = s.trim();
	// Numeric strings (up to 15 chars to avoid precision loss)
	if (t.length > 0 && t.length <= 15 && /^[+-]?(?:\d+\.?\d*|\d*\.?\d+)$/.test(t)) {
		const n = parseFloat(t);
		if (Number.isFinite(n)) return fmtNum(n);
	}
	// Date strings
	const d = fmtDateStr(t);
	if (d !== null) return d;
	return s;
}
function fmtCell(cell: CellValue): string {
	if (typeof cell === 'number') return fmtNum(cell);
	if (typeof cell === 'string') return fmtStr(cell);
	if (typeof cell === 'object' && cell !== null) {
		if ('display' in cell && cell.display !== undefined) {
			const d = String(cell.display);
			return fmtStr(d);
		}
		if ('full' in cell) {
			if (typeof cell.full === 'number') return fmtNum(cell.full);
			if (typeof cell.full === 'string') return fmtStr(cell.full);
		}
	}
	return getCellDisplayValue(cell);
}
function escHtml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function inRange(range: CellRange | null, row: number, col: number): boolean {
	return !!range && row >= range.rowMin && row <= range.rowMax && col >= range.colMin && col <= range.colMax;
}

const ROW_HEIGHT = 24, OVERSCAN = 10;
const ROW_NUMBER_WIDTH = 40;
const MIN_COL_WIDTH = 60;
const MAX_COL_WIDTH = 520;

/* SVG icon templates */
const ICON = {
	search: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.2"/><path d="M10.4 10.4L14 14"/></svg>`,
	scrollToCol: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5h11"/><path d="M2.5 8h11"/><path d="M2.5 11.5h7"/><path d="M9.5 10.5L13 8l-3.5-2.5"/></svg>`,
	scrollToRow: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3.5h10"/><path d="M3 6.5h10"/><path d="M3 9.5h6"/><path d="M3 12.5h6"/><path d="M12.5 8v5"/><path d="M11 11.5l1.5 1.5 1.5-1.5"/></svg>`,
	sort: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3v10"/><path d="M2 11l2 2 2-2"/><path d="M8 3h5"/><path d="M8 6h4"/><path d="M8 9h3"/></svg>`,
	save: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5h8.2L13.5 4.8V13.5a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z"/><path d="M5 2.8V6h6V2.8"/><path d="M5 14.5V9.5h6v5"/></svg>`,
	copy: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="2" ry="2"/><path d="M3 11V4a2 2 0 0 1 2-2h7"/></svg>`,
	trash: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h10"/><path d="M6 5V3.8c0-.4.3-.8.8-.8h2.4c.4 0 .8.3.8.8V5"/><path d="M5.2 5l.6 8.2c0 .5.4.8.8.8h3c.5 0 .8-.4.8-.8l.6-8.2"/><path d="M7 7.4v4.6"/><path d="M9 7.4v4.6"/></svg>`,
	eye: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z"/><circle cx="8" cy="8" r="2.1"/></svg>`,
	close: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>`,
	closeLarge: html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 4l8 8"/><path d="M12 4L4 12"/></svg>`,
	plus: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3.5v9"/><path d="M3.5 8h9"/></svg>`,
	up: html`<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 5.5L3.5 10l.707.707L8 6.914l3.793 3.793.707-.707L8 5.5z"/></svg>`,
	down: html`<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 10.5l4.5-4.5-.707-.707L8 9.086 4.207 5.293 3.5 6 8 10.5z"/></svg>`,
};

@customElement('kw-data-table')
export class KwDataTable extends LitElement {
	@property({ type: Array }) columns: DataTableColumn[] = [];
	@property({ type: Array }) rows: CellValue[][] = [];
	@property({ attribute: false }) options: DataTableOptions = {};

	@state() private _sorting: SortingState = [];
	@state() private _columnFilters: ColumnFiltersState = [];
	@state() private _columnMenuOpen: number | null = null;
	private _columnMenuPos: { x: number; y: number } = { x: 0, y: 0 };
	@state() private _sortDialogOpen = false;
	@state() private _filterDialogOpen = false;
	@state() private _filterDialogColIndex: number | null = null;
	@state() private _uniqueValuesOpen = false;
	@state() private _uniqueValuesColIndex: number | null = null;
	private _uniqueValuesMode: UniqueValuesMode = 'unique-values';
	@state() private _bodyVisible = true;
	@state() private _metaTooltipVisible = false;
	private _metaTooltipPos = { top: 0, left: 0 };
	private _metaHideTimer: ReturnType<typeof setTimeout> | null = null;
	private _metaCopyDone = false;

	private _initialBodyVisibleApplied = false;
	@state() private _colJumpOpen = false;
	@state() private _colJumpQuery = '';

	// ── Controllers ──
	private _vScrollCtrl = new TableVirtualScrollController(this);
	private _rowJumpCtrl = new TableRowJumpController(this);
	private _searchCtrl = new TableSearchController(this);
	private _selectionCtrl = new TableSelectionController(this);

	private _table: Table<CellValue[]> | null = null;
	private _scrollAtPopupOpen = 0;
	private _columnWidths: number[] = [];
	private _measureCanvas: HTMLCanvasElement | null = null;
	private _lastVisibleRowCount = -1;
	private _prevChromeHeight = 0;
	private _prevSearchVis = false;
	private _prevRowJumpVis = false;
	private _prevColJumpVis = false;
	private _chromeRafPending = false;

	/** Visible row count after current sort/filter state is applied. */
	public getVisibleRowCount(): number {
		return this._table?.getRowModel().rows.length ?? this.rows.length;
	}

	/**
	 * Rebuild virtual-scroll measurements after parent layout moves (for example, section reorder).
	 * Safe to call repeatedly.
	 */
	public refreshLayout(): void {
		requestAnimationFrame(() => {
			if (!this.isConnected) return;
			if (!this._bodyVisible) return;
			this._vScrollCtrl.initVirtualizer();
			this._vScrollCtrl.measure();
			this._vScrollCtrl.syncHeaderScroll();
		});
	}

	/**
	 * Compute the height needed to display all visible rows without scrolling.
	 * Includes the header bar, column thead, all rows, and internal chrome.
	 */
	public getContentHeight(): number {
		const sr = this.shadowRoot;
		if (!sr) return 200;
		const hbarEl = sr.querySelector('.hbar') as HTMLElement | null;
		const headEl = sr.querySelector('.dtable-head-wrap') as HTMLElement | null;
		const hbarH = hbarEl ? hbarEl.getBoundingClientRect().height : 36;
		const headH = headEl ? headEl.getBoundingClientRect().height : 28;
		// Measure actual rendered row height (includes padding + border-bottom).
		const rowSample = sr.querySelector('#dt-body tbody tr:not(.vspacer)') as HTMLElement | null;
		const rowH = rowSample ? rowSample.getBoundingClientRect().height : this._estimatedRowHeight();
		const totalRows = this.getVisibleRowCount();
		const allRowsH = totalRows * (rowH + 1);
		// Measure ALL visible toolbars (search, row-jump, col-jump — each is a .sbar).
		let toolbarsH = 0;
		for (const bar of sr.querySelectorAll('.sbar')) {
			toolbarsH += (bar as HTMLElement).getBoundingClientRect().height;
		}
		// When there are columns but 0 rows, the ".empty-body" placeholder is shown.
		// Measure it so the wrapper height accounts for <thead> + "No matching rows".
		const emptyEl = totalRows === 0 ? sr.querySelector('.empty-body') as HTMLElement | null : null;
		const emptyH = emptyEl ? emptyEl.getBoundingClientRect().height : 0;
		return Math.ceil(hbarH + headH + toolbarsH + allRowsH + emptyH + 25);
	}

	/** Sum of visible toolbar/sbar chrome element heights. */
	private _measureChromeHeight(): number {
		const sr = this.shadowRoot;
		if (!sr) return 0;
		let h = 0;
		for (const bar of sr.querySelectorAll('.sbar')) {
			h += (bar as HTMLElement).getBoundingClientRect().height;
		}
		return h;
	}

	// ── Controller host interface methods ──

	getTableRowCount(): number { return this._table?.getRowModel().rows.length ?? 0; }
	getEstimatedRowHeight(): number { return this._estimatedRowHeight(); }
	getTableRows(): Array<{ original: CellValue[] }> { return this._table?.getRowModel().rows ?? []; }
	getColumnCount(): number { return this.columns.length; }
	getSelectedCol(): number { return this._selectionCtrl.selectedCell?.col ?? 0; }
	scrollToRow(index: number, opts?: { align?: 'auto' | 'center' | 'start' | 'end' }): void { this._vScrollCtrl.scrollToIndex(index, opts); }
	scrollColumnIntoView(col: number): void {
		const el = this.shadowRoot?.querySelector('.vscroll') as HTMLElement | null;
		if (!el) return;
		const colWidths = this._layoutColumns().widths;
		const cellLeft = colWidths.slice(0, col).reduce((sum, w) => sum + w, ROW_NUMBER_WIDTH);
		const cellRight = cellLeft + (colWidths[col] ?? 0);
		const viewLeft = el.scrollLeft;
		const viewRight = viewLeft + el.clientWidth;
		if (cellLeft < viewLeft + ROW_NUMBER_WIDTH) {
			el.scrollLeft = Math.max(0, cellLeft - ROW_NUMBER_WIDTH);
		} else if (cellRight > viewRight) {
			el.scrollLeft = cellRight - el.clientWidth;
		} else {
			return;
		}
		this._vScrollCtrl.syncHeaderScroll();
	}
	setSelectedCell(cell: { row: number; col: number } | null): void { this._selectionCtrl.setSelectedCell(cell); }
	clearSelectionRange(): void { this._selectionCtrl.clearSelectionRange(); }

	// ── Lifecycle ──

	protected willUpdate(changed: PropertyValues): void {
		if (changed.has('columns') || changed.has('rows')) {
			this._initTable();
			this._searchCtrl.reset();
			this._rowJumpCtrl.reset();
		}
	}
	protected firstUpdated(): void {
		this._vScrollCtrl.initVirtualizer();
		this._vScrollCtrl.installViewportResizeWatcher();
		// Row jump scroll callback wired to virtual-scroll controller
		this._rowJumpCtrl.scrollToRow = (row: number) => {
			const col = this._selectionCtrl.selectedCell?.col ?? 0;
			this._selectionCtrl.setSelectedCell({ row, col });
			this._selectionCtrl.clearSelectionRange();
			this._vScrollCtrl.scrollToIndex(row, { align: 'center' });
		};
		document.addEventListener('scroll', this._onDocumentScrollDismiss, { capture: true, passive: true });
	}
	// Stable dismiss callbacks for the dismiss stack
	private _dismissSearch = (): void => { this._searchCtrl.toggle(); };
	private _dismissRowJump = (): void => { this._rowJumpCtrl.toggle(this._table?.getRowModel().rows.length ?? 0); };
	private _dismissColJump = (): void => { this._colJumpOpen = false; this._colJumpQuery = ''; };
	private _dismissColumnMenu = (): void => { this._closeColumnMenu(); };
	private _dismissSortDialog = (): void => { this._sortDialogOpen = false; };
	private _dismissFilterDialog = (): void => { this._closeFilterDialog(); };

	protected updated(changed: PropertyValues): void {
		if (changed.has('columns') || changed.has('rows')) this._vScrollCtrl.initVirtualizer();
		if (changed.has('_bodyVisible') && this._bodyVisible) this._vScrollCtrl.initVirtualizer();
		this._vScrollCtrl.installViewportResizeWatcher();
		this._vScrollCtrl.syncHeaderScroll();
		// Capture scroll position when a popup opens (for threshold-based dismiss)
		if ((changed.has('_columnMenuOpen') && this._columnMenuOpen !== null) ||
			(changed.has('_sortDialogOpen') && this._sortDialogOpen) ||
			(changed.has('_filterDialogOpen') && this._filterDialogOpen)) {
			this._scrollAtPopupOpen = document.documentElement.scrollTop || document.body.scrollTop || 0;
		}
		// Manage dismiss stack for search (controller state)
		const prevSearchVisible = (changed.get('_searchCtrl') as any)?.visible;
		// For controller-driven state, we manually track open/close in the dismiss stack
		// by detecting changes after requestUpdate.
		if (this._colJumpOpen && changed.has('_colJumpOpen')) pushDismissable(this._dismissColJump);
		else if (!this._colJumpOpen && changed.has('_colJumpOpen')) removeDismissable(this._dismissColJump);
		if (changed.has('_columnMenuOpen')) {
			if (this._columnMenuOpen !== null) pushDismissable(this._dismissColumnMenu);
			else removeDismissable(this._dismissColumnMenu);
		}
		if (changed.has('_sortDialogOpen')) {
			if (this._sortDialogOpen) pushDismissable(this._dismissSortDialog);
			else removeDismissable(this._dismissSortDialog);
		}
		if (changed.has('_filterDialogOpen')) {
			if (this._filterDialogOpen) pushDismissable(this._dismissFilterDialog);
			else removeDismissable(this._dismissFilterDialog);
		}
		// Notify parent when tabular chrome (search, row-jump, col-jump) toggles.
		// Track visibility states explicitly and defer measurement to rAF so
		// child components (kw-search-bar, etc.) have fully rendered.
		const sVis = this._searchCtrl.visible;
		const rVis = this._rowJumpCtrl.visible;
		const cVis = this._colJumpOpen;
		const chromeChanged = sVis !== this._prevSearchVis || rVis !== this._prevRowJumpVis || cVis !== this._prevColJumpVis;
		this._prevSearchVis = sVis;
		this._prevRowJumpVis = rVis;
		this._prevColJumpVis = cVis;
		if (chromeChanged && !this._chromeRafPending) {
			this._chromeRafPending = true;
			requestAnimationFrame(() => {
				this._chromeRafPending = false;
				const newH = this._measureChromeHeight();
				const delta = newH - this._prevChromeHeight;
				this._prevChromeHeight = newH;
				if (delta !== 0) {
					this.dispatchEvent(new CustomEvent('chrome-height-change', {
						detail: { delta },
						bubbles: true, composed: true,
					}));
				}
			});
		}
	}
	disconnectedCallback(): void {
		super.disconnectedCallback();
		// Clean up dismiss stack
		removeDismissable(this._dismissSearch);
		removeDismissable(this._dismissRowJump);
		removeDismissable(this._dismissColJump);
		removeDismissable(this._dismissColumnMenu);
		removeDismissable(this._dismissSortDialog);
		removeDismissable(this._dismissFilterDialog);
		document.removeEventListener('mousedown', this._onDocMouseDown);
		document.removeEventListener('scroll', this._onDocumentScrollDismiss, true);
	}

	// ── TanStack Table ──

	private _columnTypes: ColumnSortType[] = [];

	private _initTable(): void {
		if (!this.columns.length) { this._table = null; this._columnTypes = []; return; }
		// Apply initial body visibility from options (once).
		if (!this._initialBodyVisibleApplied && this.options.initialBodyVisible === false) {
			this._bodyVisible = false;
			this._initialBodyVisibleApplied = true;
		} else {
			this._initialBodyVisibleApplied = true;
		}
		this._columnWidths = this._computeColumnWidths();
		this._columnTypes = inferColumnTypes(this.columns, this.rows);
		const colTypes = this._columnTypes;
		const defs: ColumnDef<CellValue[]>[] = this.columns.map((col, i) => ({
			id: String(i), header: col.name, accessorFn: (row: CellValue[]) => row[i],
			cell: (info: CellContext<CellValue[], unknown>) => info.getValue(),
			filterFn: (row, _columnId, filterValue) => rowMatchesFilterSpec(row.original[i], filterValue as ColumnFilterSpec | null),
			sortingFn: (rA: Row<CellValue[]>, rB: Row<CellValue[]>) => {
				const a = getCellSortValue(rA.original[i]), b = getCellSortValue(rB.original[i]);
				if (a === null && b === null) return 0; if (a === null) return 1; if (b === null) return -1;
				const ct = colTypes[i];
				if (ct === 'number') {
					const na = typeof a === 'number' ? a : tryParseNum(a);
					const nb = typeof b === 'number' ? b : tryParseNum(b);
					if (na !== null && nb !== null) return na - nb;
					if (na !== null) return -1;
					if (nb !== null) return 1;
				} else if (ct === 'date') {
					const da = tryParseDateMs(a), db = tryParseDateMs(b);
					if (da !== null && db !== null) return da - db;
					if (da !== null) return -1;
					if (db !== null) return 1;
				} else if (ct === 'boolean') {
					const ba = typeof a === 'boolean' ? a : String(a).toLowerCase() === 'true';
					const bb = typeof b === 'boolean' ? b : String(b).toLowerCase() === 'true';
					return ba === bb ? 0 : ba ? -1 : 1;
				}
				// Fallback: native numbers or string compare
				if (typeof a === 'number' && typeof b === 'number') return a - b;
				return String(a).localeCompare(String(b));
			},
		}));
		this._table = createTable({ columns: defs, data: this.rows,
			state: { sorting: this._sorting, columnFilters: this._columnFilters, rowSelection: this._selectionCtrl.rowSelection, columnPinning: { left: [], right: [] }, columnVisibility: {}, columnOrder: [] },
			onStateChange: () => {}, renderFallbackValue: null,
			onSortingChange: (u) => { this._sorting = typeof u === 'function' ? u(this._sorting) : u; this._table?.setOptions(p => ({ ...p, state: { ...p.state, sorting: this._sorting } })); this._vScrollCtrl.updateCount(); },
			onColumnFiltersChange: (u) => { this._columnFilters = typeof u === 'function' ? u(this._columnFilters) : u; this._table?.setOptions(p => ({ ...p, state: { ...p.state, columnFilters: this._columnFilters } })); this._columnWidths = this._computeColumnWidths(); this._vScrollCtrl.updateCount(); this.requestUpdate(); },
			onRowSelectionChange: (u) => { this._selectionCtrl.rowSelection = typeof u === 'function' ? u(this._selectionCtrl.rowSelection) : u; this._table?.setOptions(p => ({ ...p, state: { ...p.state, rowSelection: this._selectionCtrl.rowSelection } })); },
			getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getFilteredRowModel: getFilteredRowModel(), enableMultiSort: true,
		});
		this._table.setOptions(prev => ({ ...prev }));
		this._emitVisibleRowCountChange();
	}

	private _emitVisibleRowCountChange(): void {
		const visibleRows = this._table?.getRowModel().rows.length ?? this.rows.length;
		if (visibleRows === this._lastVisibleRowCount) return;
		this._lastVisibleRowCount = visibleRows;
		this.dispatchEvent(new CustomEvent('visible-row-count-change', {
			detail: { visibleRows },
			bubbles: true,
			composed: true,
		}));
	}
	// ── TanStack Virtual (delegated to controller) ──

	private _estimatedRowHeight(): number {
		return (this.options.compact ?? false) ? 21 : 27;
	}

	// ── Stable table layout ──

	private _computeColumnWidths(): number[] {
		return this.columns.map((col, ci) => {
			const headerLabel = isColumnFiltered(ci, this._columnFilters) ? `${col.name} (filtered)` : col.name;
			let width = this._measureHeaderWidth(headerLabel);
			for (let ri = 0; ri < this.rows.length; ri++) {
				const row = this.rows[ri];
				if (!row) continue;
				const value = fmtCell(row[ci]);
				width = Math.max(width, this._measureCellWidth(value));
				if (width >= MAX_COL_WIDTH) return MAX_COL_WIDTH;
			}
			return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.ceil(width)));
		});
	}

	private _measureHeaderWidth(text: string): number {
		// Header includes label + sort indicator/menu button chrome from legacy table UI.
		return this._measureTextWidth(text) + 48;
	}

	private _measureCellWidth(text: string): number {
		// Cell text plus left/right padding from table CSS.
		return this._measureTextWidth(text) + 18;
	}

	private _measureTextWidth(text: string): number {
		const canvas = this._measureCanvas ?? (this._measureCanvas = document.createElement('canvas'));
		const ctx = canvas.getContext('2d');
		if (!ctx) return Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, text.length * 7));
		const cs = getComputedStyle(this);
		const fontFamilyVar = cs.getPropertyValue('--vscode-editor-font-family').trim();
		const fontFamily = fontFamilyVar || cs.fontFamily || 'Segoe WPC, Segoe UI, sans-serif';
		const fontSize = (this.options.compact ?? false) ? 11 : 12;
		ctx.font = `400 ${fontSize}px ${fontFamily}`;
		return ctx.measureText(text.slice(0, 500)).width;
	}

	private _viewportWidth(): number {
		if (this._vScrollCtrl.viewportW > 0) return this._vScrollCtrl.viewportW;
		const vscroll = this.shadowRoot?.querySelector('.vscroll') as HTMLElement | null;
		if (vscroll && vscroll.clientWidth > 0) return vscroll.clientWidth;
		const dt = this.shadowRoot?.querySelector('.dt') as HTMLElement | null;
		if (dt && dt.clientWidth > 0) return dt.clientWidth;
		return this.clientWidth;
	}

	private _layoutColumns(): { widths: number[]; tableWidth: number } {
		const base = this._columnWidths.length ? this._columnWidths : this.columns.map(() => MIN_COL_WIDTH);
		const viewport = Math.max(0, this._viewportWidth());
		const available = Math.max(0, viewport - ROW_NUMBER_WIDTH);
		const baseTotal = base.reduce((sum, w) => sum + w, 0);

		// Overflow mode: use fit-to-content widths (already max-capped) and allow horizontal scroll.
		if (base.length === 0 || available <= 0 || baseTotal >= available) {
			return { widths: base, tableWidth: ROW_NUMBER_WIDTH + baseTotal };
		}

		// Fit mode: everything can fit. Keep fit widths and let one column absorb remaining space.
		const widths = [...base];
		const extra = available - baseTotal;
		if (extra > 0) {
			let flexIdx = 0;
			let maxW = widths[0] ?? 0;
			for (let i = 1; i < widths.length; i++) {
				if (widths[i] >= maxW) {
					maxW = widths[i];
					flexIdx = i;
				}
			}
			const scrollbarSlack = 2;
			widths[flexIdx] += Math.max(0, extra - scrollbarSlack);
		}
		const tableWidth = Math.max(ROW_NUMBER_WIDTH + widths.reduce((sum, w) => sum + w, 0), viewport - 1);
		return { widths, tableWidth };
	}

	// ── Filter (delegated to <kw-filter-dialog>) ──

	private _openFilterDialog(colIndex: number): void {
		this._closeColumnMenu();
		this._filterDialogColIndex = colIndex;
		this._filterDialogOpen = true;
	}

	private _closeFilterDialog(): void {
		this._filterDialogOpen = false;
		this._filterDialogColIndex = null;
	}

	// ── Unique values (delegated to <kw-unique-values-dialog>) ──

	private _openUniqueValues(colIndex: number, mode: UniqueValuesMode): void {
		this._closeColumnMenu();
		this._uniqueValuesColIndex = colIndex;
		this._uniqueValuesMode = mode;
		this._uniqueValuesOpen = true;
		this.updateComplete.then(() => {
			const dlg = this.shadowRoot?.querySelector('kw-unique-values-dialog') as any;
			dlg?.show();
		});
	}

	private _closeUniqueValues(): void {
		this._uniqueValuesOpen = false;
		this._uniqueValuesColIndex = null;
	}

	private _onFilterApply = (e: CustomEvent<{ colIndex: number; filterSpec: ColumnFilterSpec | null }>): void => {
		const { colIndex, filterSpec } = e.detail;
		const id = String(colIndex);
		const next = this._columnFilters.filter(f => f.id !== id);
		if (filterSpec) next.push({ id, value: filterSpec });
		this._setColumnFilters(next);
		this._closeFilterDialog();
	};

	private _setColumnFilters(next: ColumnFiltersState): void {
		this._columnFilters = next;
		this._table?.setOptions(p => ({ ...p, state: { ...p.state, columnFilters: this._columnFilters } }));
		this._columnWidths = this._computeColumnWidths();
		this._vScrollCtrl.updateCount();
		this.requestUpdate();
	}

	// ── Render ──

	protected render(): TemplateResult {
		if (!this._table || !this.columns.length) return html`<div class="empty">No data</div>`;
		const table = this._table, allRows = table.getRowModel().rows, totalRows = allRows.length;
		const compact = this.options.compact ?? false, showToolbar = this.options.showToolbar !== false;
		const hideTopBorder = this.options.hideTopBorder ?? false;
		const layout = this._layoutColumns();
		const colWidths = layout.widths;
		const tableWidth = layout.tableWidth;

		// Virtual scroll: compute visible rows and their offset
		const items = this._vScrollCtrl.vItems;
		const useVirtual = items.length > 0;
		let topSpacer = 0;
		let visibleRows: Array<{ index: number; row: Row<CellValue[]> }>;
		if (useVirtual) {
			topSpacer = items[0].start;
			visibleRows = items.map(vi => ({ index: vi.index, row: allRows[vi.index] })).filter(vr => vr.row);
		} else {
			visibleRows = [];
		}

		const sel = this._selectionCtrl;
		const search = this._searchCtrl;

		return html`
		<div class="dt ${compact ? 'compact' : ''} ${hideTopBorder ? 'no-top-border' : ''}">
			${this._renderHeader(totalRows, showToolbar)}
			${search.visible ? this._renderSearch() : nothing}
			${this._rowJumpCtrl.visible ? this._renderRowJump(totalRows) : nothing}
			${this._colJumpOpen ? this._renderColJump() : nothing}
			${this._bodyVisible ? html`
			<div class="vscroll" @keydown=${this._onKeydown} tabindex="0"
				@scroll=${this._onBodyScroll}
				@mousedown=${(e: MouseEvent) => sel.onTableMouseDown(e)}>
			<div class="dtable-head-wrap" style="min-width:${tableWidth}px;">
				<table class="dtable" id="dt-head" style="width:${tableWidth}px;min-width:${tableWidth}px;">
					<colgroup>
						<col style="width:${ROW_NUMBER_WIDTH}px;min-width:${ROW_NUMBER_WIDTH}px;max-width:${ROW_NUMBER_WIDTH}px;" />
						${colWidths.map(width => html`<col style="width:${width}px;min-width:${width}px;max-width:${width}px;" />`)}
					</colgroup>
					<thead><tr>
						<th class="rn-h">#</th>
						${table.getHeaderGroups()[0]?.headers.map(h => this._renderTh(h))}
					</tr></thead>
				</table>
			</div>
				<div style="height:${this._vScrollCtrl.vTotalSize}px;position:relative;">
				<table class="dtable" id="dt-body" style="position:absolute;top:${topSpacer}px;left:0;width:${tableWidth}px;min-width:${tableWidth}px;">
					<colgroup>
						<col style="width:${ROW_NUMBER_WIDTH}px;min-width:${ROW_NUMBER_WIDTH}px;max-width:${ROW_NUMBER_WIDTH}px;" />
						${colWidths.map(width => html`<col style="width:${width}px;min-width:${width}px;max-width:${width}px;" />`)}
					</colgroup>
					<tbody>
						${visibleRows.map(({ index, row }) => {
							const isSel = sel.selectedCell?.row === index;
							return html`<tr class="${isSel ? 'sel-row' : ''}" data-idx="${index}">
								<td class="rn" @click=${(e: MouseEvent) => sel.selectRow(e, index)}>${index + 1}</td>
								${row.getVisibleCells().map((cell, ci) => {
							const raw = cell.getValue() as CellValue, display = fmtCell(raw);
								const isObj = typeof raw === 'object' && raw !== null && 'isObject' in raw && raw.isObject;
								const isFocus = sel.selectedCell?.row === index && sel.selectedCell?.col === ci;
								const isInRng = inRange(sel.selectionRange, index, ci);
								const isM = search.matches.length > 0 && search.isMatch(index, ci);
								const isCM = isM && search.isCurMatch(index, ci);
								let cls = isFocus ? 'cf' : isInRng ? 'cr' : '';
								if (isCM) cls += ' mc'; else if (isM) cls += ' mh';
								if (isObj) {
									return html`<td class="${cls} obj-cell" title="${escHtml(getCellDisplayValue(raw))}"><a class="obj-link" href="#" @click=${(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); this._openObjectViewer(index, ci); }}>View</a></td>`;
								}
								const cellContent = isM && search.searchRegex ? highlightMatches(display, search.searchRegex, isCM ? 'hl-cur' : 'hl') : display;
								return html`<td class="${cls}" title="${escHtml(getCellDisplayValue(raw))}" @dblclick=${(e: MouseEvent) => { if (this._isCellObject(index, ci)) { e.stopPropagation(); this._openObjectViewer(index, ci); } }}>${cellContent}</td>`;
								})}
							</tr>`;
						})}
					</tbody>
				</table>
				</div>
				${totalRows === 0 ? html`<div class="empty-body">No matching rows</div>` : nothing}
			</div>` : nothing}
			${this._sortDialogOpen ? html`<kw-sort-dialog
				.columns=${this.columns}
				.sorting=${this._sorting}
				@sort-change=${this._onSortChange}
				@sort-close=${() => this._sortDialogOpen = false}
			></kw-sort-dialog>` : nothing}
			${this._filterDialogOpen ? html`<kw-filter-dialog
				.columns=${this.columns}
				.rows=${this.rows}
				.colIndex=${this._filterDialogColIndex}
				.columnFilters=${this._columnFilters}
				@filter-apply=${this._onFilterApply}
				@filter-close=${() => this._closeFilterDialog()}
			></kw-filter-dialog>` : nothing}
			${this._columnMenuOpen !== null ? this._renderColumnMenu() : nothing}
			${this._uniqueValuesOpen ? html`<kw-unique-values-dialog
				.columns=${this.columns}
				.rows=${this.rows}
				.colIndex=${this._uniqueValuesColIndex ?? 0}
				.mode=${this._uniqueValuesMode}
				@unique-values-close=${() => this._closeUniqueValues()}
			></kw-unique-values-dialog>` : nothing}
			<kw-object-viewer></kw-object-viewer>
		</div>`;
	}

	private _renderHeader(totalRows: number, showToolbar: boolean): TemplateResult {
		const showVis = this.options.showVisibilityToggle ?? false;
		const isFiltered = totalRows < this.rows.length;
		const rowSummary = isFiltered
			? `${totalRows} of ${this.rows.length} rows (filtered)`
			: `${totalRows} row${totalRows !== 1 ? 's' : ''}`;
		const meta = this.options.metadata;
		const hasTooltip = !!(meta && (meta.clientActivityId || meta.serverStats));
		return html`<div class="hbar">
			<span class="hinfo${hasTooltip ? ' hinfo-anchor' : ''}" @mouseenter=${hasTooltip ? this._showMetaTooltip : nothing} @mouseleave=${hasTooltip ? this._scheduleHideMetaTooltip : nothing}>${this.options.label ? html`<strong>${this.options.label}:</strong> ` : nothing}${rowSummary} / ${this.columns.length} col${this.columns.length !== 1 ? 's' : ''}${this.options.executionTime && this.options.showExecutionTime ? html` <span class="et">(${this.options.executionTime})</span>` : nothing}${showVis ? html` <button class="tbtn vis-toggle ${this._bodyVisible ? 'act' : ''}" title="${this._bodyVisible ? 'Hide results' : 'Show results'}" @click=${this._toggleBody}>${ICON.eye}</button>${!this._bodyVisible ? html`<span class="hidden-hint" @click=${this._toggleBody}>(results hidden from view, click to show them)</span>` : nothing}` : nothing}</span>
			${(showToolbar && this._bodyVisible) ? html`<div class="tb">
				<button class="tbtn ${this._searchCtrl.visible ? 'act' : ''}" title="Search data" @click=${() => this._toggleSearch()}>${ICON.search}</button>
				<button class="tbtn ${this._rowJumpCtrl.visible ? 'act' : ''}" title="Scroll to row" @click=${() => this._toggleRowJump(totalRows)}>${ICON.scrollToRow}</button>
				<button class="tbtn ${this._colJumpOpen ? 'act' : ''}" title="Scroll to column" @click=${() => { this._colJumpOpen = !this._colJumpOpen; this._colJumpQuery = ''; }}>${ICON.scrollToCol}</button>
				<button class="tbtn ${this._sortDialogOpen ? 'act' : ''}" title="Sort" @click=${() => this._sortDialogOpen = !this._sortDialogOpen}>${ICON.sort}</button>
				<span class="sep"></span>
				<button class="tbtn" title="Save results to file" @click=${() => this._save()}>${ICON.save}</button>
				<button class="tbtn" title="Copy (Ctrl+C)" @click=${() => this._selectionCtrl.copy()}>${ICON.copy}</button>
				${this._sorting.length > 0 ? html`<button class="tbtn tbtn-text" title="Clear sort" @click=${this._clearSort}>✕ Sort</button>` : nothing}
			</div>` : nothing}
			${this._metaTooltipVisible && hasTooltip ? this._renderMetaTooltip() : nothing}
		</div>`;
	}

	// ── Metadata tooltip (Client Activity ID + Server Stats) ──

	private _metaShowTimer: ReturnType<typeof setTimeout> | null = null;

	private _showMetaTooltip(e: MouseEvent): void {
		if (this._metaHideTimer) { clearTimeout(this._metaHideTimer); this._metaHideTimer = null; }
		if (this._metaTooltipVisible) return;
		const el = e.currentTarget as HTMLElement;
		this._metaShowTimer = setTimeout(() => {
			this._metaShowTimer = null;
			const rect = el.getBoundingClientRect();
			this._metaTooltipPos = { top: rect.bottom + 4, left: rect.left };
			this._metaTooltipVisible = true;
		}, 500);
	}

	private _scheduleHideMetaTooltip = (): void => {
		if (this._metaShowTimer) { clearTimeout(this._metaShowTimer); this._metaShowTimer = null; }
		if (this._metaHideTimer) clearTimeout(this._metaHideTimer);
		this._metaHideTimer = setTimeout(() => { this._metaTooltipVisible = false; }, 120);
	};

	private _cancelHideMetaTooltip = (): void => {
		if (this._metaHideTimer) { clearTimeout(this._metaHideTimer); this._metaHideTimer = null; }
	};

	private _copyActivityId(): void {
		const id = this.options.metadata?.clientActivityId;
		if (!id) return;
		navigator.clipboard.writeText(id).then(() => {
			this._metaCopyDone = true;
			this.requestUpdate();
			setTimeout(() => { this._metaCopyDone = false; this.requestUpdate(); }, 1200);
		}).catch(() => { /* ignore */ });
	}

	private _renderMetaTooltip(): TemplateResult {
		const meta = this.options.metadata!;
		const ss = meta.serverStats as Record<string, any> | null ?? null;
		const fmtCpuMs = (ms: number) => ms < 1000 ? ms.toFixed(1) + 'ms' : (ms / 1000).toFixed(3) + 's';
		const fmtBytes = (bytes: unknown) => {
			const b = Number(bytes);
			// eslint-disable-next-line eqeqeq
			if (bytes == null || !isFinite(b)) return '?';
			if (b < 1024) return b + ' B';
			if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
			if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
			return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
		};
		// eslint-disable-next-line eqeqeq
		const fmtNum = (n: unknown) => n == null ? '?' : Number(n).toLocaleString();

		const statRows: TemplateResult[] = [];
		if (ss) {
			// eslint-disable-next-line eqeqeq
			if (ss.cpuTimeMs != null && isFinite(ss.cpuTimeMs)) {
				statRows.push(html`<div class="mt-row mt-stat"><span class="mt-title">Server CPU</span><span class="mt-val">${fmtCpuMs(ss.cpuTimeMs)}</span></div>`);
			} else if (ss.cpuTime) {
				statRows.push(html`<div class="mt-row mt-stat"><span class="mt-title">Server CPU</span><span class="mt-val">${ss.cpuTime}</span></div>`);
			}
			// eslint-disable-next-line eqeqeq
			if (ss.peakMemoryPerNode != null && isFinite(ss.peakMemoryPerNode)) {
				statRows.push(html`<div class="mt-row mt-stat"><span class="mt-title">Peak memory</span><span class="mt-val">${fmtBytes(ss.peakMemoryPerNode)}</span></div>`);
			}
			// eslint-disable-next-line eqeqeq
			if (ss.extentsScanned != null) {
				// eslint-disable-next-line eqeqeq
				const ext = fmtNum(ss.extentsScanned) + (ss.extentsTotal != null ? ' / ' + fmtNum(ss.extentsTotal) : '');
				statRows.push(html`<div class="mt-row mt-stat"><span class="mt-title">Extents scanned</span><span class="mt-val">${ext}</span></div>`);
			}
			const memHits = typeof ss.memoryCacheHits === 'number' ? ss.memoryCacheHits : null;
			const memMisses = typeof ss.memoryCacheMisses === 'number' ? ss.memoryCacheMisses : null;
			// eslint-disable-next-line eqeqeq
			if (memHits != null || memMisses != null) {
				const total = (memHits || 0) + (memMisses || 0);
				const rate = total > 0 ? ((memHits || 0) / total * 100).toFixed(1) + '%' : 'N/A';
				statRows.push(html`<div class="mt-row mt-stat"><span class="mt-title">Memory cache</span><span class="mt-val">${rate} (${fmtNum(memHits || 0)} hits, ${fmtNum(memMisses || 0)} misses)</span></div>`);
			}
			const diskHits = typeof ss.diskCacheHits === 'number' ? ss.diskCacheHits : null;
			const diskMisses = typeof ss.diskCacheMisses === 'number' ? ss.diskCacheMisses : null;
			// eslint-disable-next-line eqeqeq
			if (diskHits != null || diskMisses != null) {
				const dTotal = (diskHits || 0) + (diskMisses || 0);
				const dRate = dTotal > 0 ? ((diskHits || 0) / dTotal * 100).toFixed(1) + '%' : 'N/A';
				statRows.push(html`<div class="mt-row mt-stat"><span class="mt-title">Disk cache</span><span class="mt-val">${dRate} (${fmtNum(diskHits || 0)} hits, ${fmtNum(diskMisses || 0)} misses)</span></div>`);
			}
			// eslint-disable-next-line eqeqeq
			if (ss.shardHotHitBytes != null || ss.shardHotMissBytes != null) {
				statRows.push(html`<div class="mt-row mt-stat"><span class="mt-title">Shard hot cache</span><span class="mt-val">${fmtBytes(ss.shardHotHitBytes || 0)} hit / ${fmtBytes(ss.shardHotMissBytes || 0)} miss</span></div>`);
			}
			// eslint-disable-next-line eqeqeq
			if (ss.serverRowCount != null) {
				statRows.push(html`<div class="mt-row mt-stat"><span class="mt-title">Server row count</span><span class="mt-val">${fmtNum(ss.serverRowCount)}</span></div>`);
			}
			// eslint-disable-next-line eqeqeq
			if (ss.serverTableSize != null) {
				statRows.push(html`<div class="mt-row mt-stat"><span class="mt-title">Result size</span><span class="mt-val">${fmtBytes(ss.serverTableSize)}</span></div>`);
			}
		}

		return html`<div class="mt-popup" style="top:${this._metaTooltipPos.top}px;left:${this._metaTooltipPos.left}px"
			@mouseenter=${this._cancelHideMetaTooltip}
			@mouseleave=${this._scheduleHideMetaTooltip}>
			${meta.clientActivityId ? html`<div class="mt-row">
				<span class="mt-title">Client Activity ID</span>
				<span class="mt-val">${meta.clientActivityId}</span>
				<button class="mt-copy${this._metaCopyDone ? ' mt-copy-done' : ''}" title="Copy to clipboard" @click=${() => this._copyActivityId()}>
					<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M4 4h1V2.5A1.5 1.5 0 0 1 6.5 1h7A1.5 1.5 0 0 1 15 2.5v7a1.5 1.5 0 0 1-1.5 1.5H12v1h1.5A2.5 2.5 0 0 0 16 9.5v-7A2.5 2.5 0 0 0 13.5 0h-7A2.5 2.5 0 0 0 4 2.5V4z"/><path d="M2.5 5A2.5 2.5 0 0 0 0 7.5v6A2.5 2.5 0 0 0 2.5 16h6a2.5 2.5 0 0 0 2.5-2.5v-6A2.5 2.5 0 0 0 8.5 5h-6zM1 7.5A1.5 1.5 0 0 1 2.5 6h6A1.5 1.5 0 0 1 10 7.5v6a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 1 13.5v-6z"/></svg>
				</button>
			</div>` : nothing}
			${statRows.length > 0 ? html`${meta.clientActivityId ? html`<div class="mt-sep"></div>` : nothing}${statRows}` : nothing}
		</div>`;
	}

	private _renderRowJump(totalRows: number): TemplateResult {
		const rj = this._rowJumpCtrl;
		const rc = rj.targets.length;
		const statusText = rj.error
			? rj.error
			: (rj.query.trim()
				? (rc > 0 ? `(${rj.currentIndex + 1}/${rc})` : `Enter rows 1-${totalRows}`)
				: `Max row: ${totalRows}`);
		const statusClass = rj.error ? 'sc-status err' : 'sc-status';
		return html`<div class="sbar">
			<div class="sc">
				<svg class="sc-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10"/><path d="M3 7.5h10"/><path d="M3 10.5h6"/><path d="M11.5 9.5v4"/><path d="M10.2 12.2l1.3 1.3 1.3-1.3"/></svg>
				<input type="text" class="sinp row-jump-inp" placeholder="Scroll to row (e.g. 1, 120, 500)..." autocomplete="off" spellcheck="false" .value=${rj.query}
					@input=${(e: Event) => { rj.setQuery((e.target as HTMLInputElement).value, totalRows); }}
					@keydown=${(e: KeyboardEvent) => {
						if (e.key === 'Enter') { e.shiftKey ? rj.prevTarget() : rj.nextTarget(); e.preventDefault(); }
					}} />
				<span class="${statusClass}">${statusText}</span>
			</div>
			<button class="close-mini" title="Close" @click=${() => this._toggleRowJump(totalRows)}>${ICON.closeLarge}</button>
		</div>`;
	}

	private _renderSearch(): TemplateResult {
		const s = this._searchCtrl;
		return html`<div class="sbar">
			<kw-search-bar
				.query=${s.query}
				.mode=${s.mode}
				.matchCount=${s.matches.length}
				.currentMatch=${s.currentMatchIndex}
				.showClose=${true}
				.showStatus=${true}
				@search-input=${(e: CustomEvent) => { s.setQuery(e.detail.query); }}
				@search-mode-change=${(e: CustomEvent) => { s.setMode(e.detail.mode); }}
				@search-next=${() => s.nextMatch()}
				@search-prev=${() => s.prevMatch()}
				@search-close=${() => this._toggleSearch()}
			></kw-search-bar>
		</div>`;
	}

	private _renderColJump(): TemplateResult {
		const q = this._colJumpQuery.trim().toLowerCase();
		const filtered = this.columns.map((c, i) => ({ name: c.name, idx: i })).filter(c => !q || c.name.toLowerCase().includes(q));
		return html`<div class="sbar">
			<div class="cj-wrap">
				<input type="text" class="cj-inp" placeholder="Scroll to column..." autocomplete="off" spellcheck="false" .value=${this._colJumpQuery}
					@input=${(e: Event) => { this._colJumpQuery = (e.target as HTMLInputElement).value; }}
					@keydown=${(e: KeyboardEvent) => {
						if (e.key === 'Enter' && filtered.length > 0) { this._scrollToCol(filtered[0].idx); this._colJumpOpen = false; e.preventDefault(); }
						if (e.key === 'ArrowDown') { const first = this.shadowRoot?.querySelector('.cj-item') as HTMLElement; first?.focus(); e.preventDefault(); }
					}} />
				<div class="cj-list">
					${filtered.length > 0 ? filtered.map(c => html`<div class="cj-item" tabindex="0"
						@click=${() => { this._scrollToCol(c.idx); this._colJumpOpen = false; }}
						@keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') { this._scrollToCol(c.idx); this._colJumpOpen = false; e.preventDefault(); } }}>${c.name}</div>`) : html`<div class="cj-empty">No columns match</div>`}
				</div>
			</div>
			<button class="close-mini cj-close" title="Close" @click=${() => { this._colJumpOpen = false; }}>${ICON.closeLarge}</button>
		</div>`;
	}

	private _renderTh(h: any): TemplateResult {
		const col = h.column as Column<CellValue[]>, sd = col.getIsSorted(), si = this._sorting.findIndex(s => s.id === col.id), ci = parseInt(col.id);
		const isFiltered = isColumnFiltered(ci, this._columnFilters);
		return html`<th @click=${(e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.cm-btn') && !(e.target as HTMLElement).closest('.filtered-link')) col.toggleSorting(undefined, e.shiftKey); }}
			@contextmenu=${(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); this._openColumnMenuAt(ci, e.clientX, e.clientY); }}
			class="${sd ? 'sorted' : ''}">
			<div class="thc"><span class="thn">${col.columnDef.header}${sd ? html`<span class="si2">${sd === 'asc' ? '↑' : '↓'}${this._sorting.length > 1 ? html`<sup>${si + 1}</sup>` : nothing}</span>` : nothing}${isFiltered ? html`<a href="#" class="filtered-link" @click=${(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); this._openFilterDialog(ci); }}>(filtered)</a>` : nothing}</span>
				<button class="cm-btn" @click=${(e: MouseEvent) => { e.stopPropagation(); this._openColumnMenu(ci, e); }}>☰</button>
			</div>
		</th>`;
	}

	private _openColumnMenu(ci: number, e: MouseEvent): void {
		if (this._columnMenuOpen === ci) { this._closeColumnMenu(); return; }
		const btn = e.currentTarget as HTMLElement;
		const rect = btn.getBoundingClientRect();
		this._openColumnMenuAt(ci, rect.right, rect.bottom + 2);
	}

	private _openColumnMenuAt(ci: number, x: number, y: number): void {
		if (this._columnMenuOpen === ci) { this._closeColumnMenu(); return; }
		this._columnMenuPos = { x, y };
		this._columnMenuOpen = ci;
		// Defer so this click doesn't immediately trigger the close handler
		requestAnimationFrame(() => document.addEventListener('mousedown', this._onDocMouseDown));
	}

	private _closeColumnMenu(): void {
		this._columnMenuOpen = null;
		document.removeEventListener('mousedown', this._onDocMouseDown);
	}

	private _onDocMouseDown = (e: MouseEvent) => {
		// composedPath() gives the real target inside shadow DOM
		const path = e.composedPath();
		const menu = this.shadowRoot?.querySelector('.cm');
		if (menu && path.includes(menu)) return;
		this._closeColumnMenu();
	};

	private _renderColumnMenu(): TemplateResult {
		const ci = this._columnMenuOpen!;
		const col = this._table?.getHeaderGroups()[0]?.headers[ci]?.column as Column<CellValue[]> | undefined;
		if (!col) return html``;
		return html`<div class="cm" style="left:${this._columnMenuPos.x}px;top:${this._columnMenuPos.y}px;" @click=${(e: Event) => e.stopPropagation()}>
			<div class="cmi" @click=${() => { col.toggleSorting(false, false); this._closeColumnMenu(); }}>Sort ascending</div>
			<div class="cmi" @click=${() => { col.toggleSorting(true, false); this._closeColumnMenu(); }}>Sort descending</div>
			${col.getIsSorted() ? html`<div class="cmi" @click=${() => { col.clearSorting(); this._closeColumnMenu(); }}>Remove sort</div>` : nothing}
			<div class="cmi" @click=${() => this._openFilterDialog(ci)}>Filter...</div>
			<div class="cms"></div>
			<div class="cmi" @click=${() => { this._copyCol(ci); this._closeColumnMenu(); }}>Copy column values</div>
			<div class="cms"></div>
			<div class="cmi" @click=${() => this._openUniqueValues(ci, 'unique-values')}>Show unique values</div>
			${this.columns.length >= 2 ? html`<div class="cmi" @click=${() => this._openUniqueValues(ci, 'unique-count')}>Unique count by column</div>` : nothing}
		</div>`;
	}


	// ── Events (delegated to controllers) ──

	private _onKeydown = (e: KeyboardEvent) => {
		if ((e.ctrlKey || e.metaKey) && e.key === 'f') { this._toggleSearch(); e.preventDefault(); return; }
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') { this._toggleRowJump(this._table?.getRowModel().rows.length ?? 0); e.preventDefault(); return; }
		this._selectionCtrl.handleKeydown(e);
	};

	// ── Actions ──

	private _toggleSearch(): void {
		this._searchCtrl.toggle();
		if (this._searchCtrl.visible) {
			pushDismissable(this._dismissSearch);
			this.updateComplete.then(() => {
				this.shadowRoot?.querySelector('kw-search-bar')?.focus();
			});
		} else {
			removeDismissable(this._dismissSearch);
		}
		// chrome-height-change is now emitted centrally from updated()
	}
	private _toggleRowJump(totalRows: number): void {
		this._rowJumpCtrl.toggle(totalRows);
		if (this._rowJumpCtrl.visible) {
			pushDismissable(this._dismissRowJump);
			requestAnimationFrame(() => {
				const i = this.shadowRoot?.querySelector('.row-jump-inp') as HTMLInputElement;
				i?.focus();
				i?.select();
			});
		} else {
			removeDismissable(this._dismissRowJump);
		}
		// chrome-height-change is now emitted centrally from updated()
	}
	private _toggleBody(): void { this._bodyVisible = !this._bodyVisible; this.dispatchEvent(new CustomEvent('visibility-toggle', { detail: { visible: this._bodyVisible }, bubbles: true, composed: true })); }
	private _onSortChange = (e: CustomEvent<{ sorting: SortingState }>): void => {
		this._sorting = e.detail.sorting;
		this._table?.setOptions(p => ({ ...p, state: { ...p.state, sorting: this._sorting } }));
		this._vScrollCtrl.updateCount();
		this._sortDialogOpen = false;
	};
	private _clearSort(): void { this._sorting = []; this._table?.setOptions(p => ({ ...p, state: { ...p.state, sorting: [] } })); this._sortDialogOpen = false; this._vScrollCtrl.updateCount(); }
	private _scrollToCol(ci: number): void {
		const el = this.shadowRoot?.querySelector('.vscroll') as HTMLElement | null;
		if (!el) return;
		const colWidths = this._layoutColumns().widths;
		const left = colWidths.slice(0, ci).reduce((sum, width) => sum + width, ROW_NUMBER_WIDTH);
		el.scrollLeft = Math.max(0, left - ROW_NUMBER_WIDTH);
		this._vScrollCtrl.syncHeaderScroll();
	}

	private _onBodyScroll = (): void => {
		this._vScrollCtrl.syncHeaderScroll();
	};
	private _isCellObject(rowIdx: number, colIdx: number): boolean {
		if (!this._table) return false;
		const row = this._table.getRowModel().rows[rowIdx];
		if (!row) return false;
		const cell = row.original[colIdx];
		return typeof cell === 'object' && cell !== null && 'full' in cell && typeof (cell as any).full === 'string' && ((cell as any).full.trim().startsWith('{') || (cell as any).full.trim().startsWith('['));
	}
	private _openObjectViewer(rowIdx: number, colIdx: number): void {
		if (!this._table) return;
		const row = this._table.getRowModel().rows[rowIdx];
		if (!row) return;
		const cell = row.original[colIdx] as CellValue;
		const colName = this.columns[colIdx]?.name ?? `Column ${colIdx}`;
		let jsonText: string;
		if (typeof cell === 'object' && cell !== null && 'full' in cell) {
			jsonText = typeof cell.full === 'string' ? cell.full : JSON.stringify(cell.full);
		} else {
			jsonText = getCellDisplayValue(cell);
		}
		const viewer = this.shadowRoot?.querySelector('kw-object-viewer') as KwObjectViewer | null;
		if (!viewer) return;
		const search = this._searchCtrl;
		const isMatch = search.matches.some(m => m.row === rowIdx && m.col === colIdx);
		viewer.show(`Object viewer for ${colName}`, jsonText, isMatch ? { searchQuery: search.query, searchMode: search.mode } : undefined);
	}

	private _onDocumentScrollDismiss = (): void => {
		if (!this._columnMenuOpen && this._columnMenuOpen !== 0 && !this._sortDialogOpen && !this._filterDialogOpen) return;
		const scrollY = document.documentElement.scrollTop || document.body.scrollTop || 0;
		if (Math.abs(scrollY - this._scrollAtPopupOpen) <= 20) return;
		this._columnMenuOpen = null;
		this._sortDialogOpen = false;
		this._filterDialogOpen = false;
	};

	private _copyCol(ci: number): void { if (!this._table) return; const rows = this._table.getRowModel().rows; const text = this.columns[ci].name + '\n' + rows.map(r => getCellDisplayValue(r.original[ci])).join('\n'); try { navigator.clipboard.writeText(text); } catch (e) { console.error('[kusto]', e); } }
	private _save(): void {
		if (!this._table) return;
		const rows = this._table.getRowModel().rows;
		const header = this.columns.map(c => this._csvEsc(c.name)).join(',');
		const lines = rows.map(r => r.original.map(cell => this._csvEsc(getCellDisplayValue(cell))).join(','));
		const csv = header + '\n' + lines.join('\n');
		this.dispatchEvent(new CustomEvent('save', { detail: { csv, suggestedFileName: (this.options.label || 'results') + '.csv' }, bubbles: true, composed: true }));
	}
	private _csvEsc(val: string): string {
		if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) return '"' + val.replace(/"/g, '""') + '"';
		return val;
	}

	// ── Styles ──

	static styles = styles;
}
declare global { interface HTMLElementTagNameMap { 'kw-data-table': KwDataTable; } }
