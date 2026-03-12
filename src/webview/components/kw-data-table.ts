import { LitElement, html, nothing, type TemplateResult, type PropertyValues } from 'lit';
import { styles } from './kw-data-table.styles.js';
import { customElement, property, state } from 'lit/decorators.js';
import { createTable, getCoreRowModel, getSortedRowModel, getFilteredRowModel, type Table, type ColumnDef, type SortingState, type ColumnFiltersState, type Row, type CellContext, type RowSelectionState, type Column } from '@tanstack/table-core';
import { Virtualizer, elementScroll, observeElementRect, observeElementOffset } from '@tanstack/virtual-core';
import type { KwObjectViewer } from './kw-object-viewer.js';
import { rowMatchesFilterSpec, isColumnFiltered, getFilterSpecForColumn, type ColumnFilterSpec } from './kw-filter-dialog.js';
import './kw-filter-dialog.js';
import './kw-sort-dialog.js';

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
}
export type CellValue = string | number | boolean | null | undefined | { display?: string; full?: unknown; isObject?: boolean };
interface CellRange { rowMin: number; rowMax: number; colMin: number; colMax: number; }
interface VItem { index: number; start: number; size: number; }

function getCellDisplayValue(cell: CellValue): string {
	if (cell === null || cell === undefined) return '';
	if (typeof cell === 'string') return cell;
	if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
	if (typeof cell === 'object') {
		if ('display' in cell && cell.display !== undefined) return String(cell.display);
		if ('full' in cell) { const f = cell.full; if (f === null || f === undefined) return ''; if (typeof f === 'string') return f; try { return JSON.stringify(f); } catch { return String(f); } }
	}
	try { return JSON.stringify(cell); } catch { return String(cell); }
}
function getCellSortValue(cell: CellValue): string | number | boolean | null {
	if (cell === null || cell === undefined) return null;
	if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') return cell;
	if (typeof cell === 'object' && 'full' in cell) { const f = cell.full; if (typeof f === 'number' || typeof f === 'string' || typeof f === 'boolean') return f; }
	return getCellDisplayValue(cell);
}

// ── Column type inference for sorting ──

type ColumnSortType = 'string' | 'number' | 'date' | 'boolean';

const _numRx = /^[+-]?(?:\d+\.?\d*|\d*\.?\d+)(?:[eE][+-]?\d+)?$/;

function tryParseNum(raw: unknown): number | null {
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

function tryParseDateMs(raw: unknown): number | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === 'number' || typeof raw === 'boolean') return null;
	const s = String(raw).trim();
	if (s.length < 8) return null;
	// Only attempt parse for strings that look like dates, not arbitrary text
	if (!_isoDateRx.test(s) && !_verboseDateRx.test(s)) return null;
	const t = Date.parse(s);
	return Number.isFinite(t) ? t : null;
}

function kustoTypeToSortType(kustoType: string | undefined): ColumnSortType | null {
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

function inferColumnTypes(columns: DataTableColumn[], rows: CellValue[][]): ColumnSortType[] {
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
function escRx(s: string): string { return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'); }
function buildRx(q: string, mode: 'wildcard' | 'regex'): RegExp | null {
	const t = q.trim(); if (!t) return null;
	const p = mode === 'regex' ? t : t.split('*').map(escRx).join('.*?');
	try { const r = new RegExp(p, 'gi'); if (new RegExp(r.source, r.flags.replace(/g/g, '')).test('')) return null; return r; } catch { return null; }
}
function inRange(range: CellRange | null, row: number, col: number): boolean {
	return !!range && row >= range.rowMin && row <= range.rowMax && col >= range.colMin && col <= range.colMax;
}
/** Resolve row/col from a MouseEvent target inside the table body */
function cellFromEvent(e: MouseEvent): { row: number; col: number } | null {
	const td = (e.target as HTMLElement).closest('td');
	if (!td) return null;
	const tr = td.closest('tr');
	if (!tr) return null;
	const rowIdx = tr.dataset.idx;
	if (rowIdx === undefined) return null;
	// Column index: skip the row-number <td class="rn">
	const tds = Array.from(tr.querySelectorAll('td'));
	const ci = tds.indexOf(td) - 1; // -1 for row-num td
	if (ci < 0) return null;
	return { row: parseInt(rowIdx, 10), col: ci };
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
	close: html`<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>`,
	closeLarge: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8"/><path d="M12 4L4 12"/></svg>`,
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
	@state() private _rowSelection: RowSelectionState = {};
	@state() private _selectedCell: { row: number; col: number } | null = null;
	@state() private _selectionRange: CellRange | null = null;
	private _selectionAnchor: { row: number; col: number } | null = null;
	@state() private _searchVisible = false;
	@state() private _searchQuery = '';
	@state() private _searchMode: 'wildcard' | 'regex' = 'wildcard';
	@state() private _searchMatches: Array<{ row: number; col: number }> = [];
	@state() private _currentMatchIndex = 0;
	@state() private _columnMenuOpen: number | null = null;
	private _columnMenuPos: { x: number; y: number } = { x: 0, y: 0 };
	@state() private _sortDialogOpen = false;
	@state() private _filterDialogOpen = false;
	@state() private _filterDialogColIndex: number | null = null;
	@state() private _bodyVisible = true;
	@state() private _colJumpOpen = false;
	@state() private _colJumpQuery = '';
	@state() private _rowJumpVisible = false;
	@state() private _rowJumpQuery = '';
	@state() private _rowJumpTargets: number[] = [];
	@state() private _currentRowJumpIndex = 0;
	@state() private _rowJumpError = '';

	// TanStack Virtual state
	@state() private _vItems: VItem[] = [];
	@state() private _vTotalSize = 0;
	@state() private _viewportW = 0;

	private _table: Table<CellValue[]> | null = null;
	private _virtualizer: Virtualizer<HTMLDivElement, Element> | null = null;
	private _resizeObs: ResizeObserver | null = null;
	private _viewportResizeObs: ResizeObserver | null = null;
	private _isDragging = false;
	private _virtualizerCleanup: (() => void) | null = null;
	private _syncRaf = 0;
	private _lastVStart = -1;
	private _lastVEnd = -1;
	private _lastVTopOffset = 0;
	private _lastViewportW = 0;
	private _columnWidths: number[] = [];
	private _measureCanvas: HTMLCanvasElement | null = null;
	private _lastVisibleRowCount = -1;

	/** Visible row count after current sort/filter state is applied. */
	public getVisibleRowCount(): number {
		return this._table?.getRowModel().rows.length ?? this.rows.length;
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
		const searchBarH = this._searchVisible ? ((sr.querySelector('.sbar') as HTMLElement | null)?.getBoundingClientRect().height ?? 0) : 0;
		return Math.ceil(hbarH + headH + searchBarH + allRowsH + 25);
	}

	// ── Lifecycle ──

	protected willUpdate(changed: PropertyValues): void {
		if (changed.has('columns') || changed.has('rows')) {
			this._initTable();
			this._searchMatches = [];
			this._currentMatchIndex = 0;
			this._rowJumpTargets = [];
			this._currentRowJumpIndex = 0;
			this._rowJumpError = '';
		}
	}
	protected firstUpdated(): void {
		this._initVirtualizer();
		this._installViewportResizeWatcher();
		document.addEventListener('copy', this._onDocumentCopy, true);
		document.addEventListener('keydown', this._onDocumentKeydown, true);
	}
	protected updated(changed: PropertyValues): void {
		if (changed.has('columns') || changed.has('rows')) this._initVirtualizer();
		// When body becomes visible again after being hidden, the scroll container
		// was removed and re-created — the virtualizer needs re-initialization.
		if (changed.has('_bodyVisible') && this._bodyVisible) this._initVirtualizer();
		this._installViewportResizeWatcher();
		this._syncHeaderScroll();
	}
	disconnectedCallback(): void {
		super.disconnectedCallback();
		this._resizeObs?.disconnect();
		this._viewportResizeObs?.disconnect();
		this._virtualizerCleanup?.();
		this._virtualizerCleanup = null;
		this._virtualizer = null;
		document.removeEventListener('mouseup', this._onMouseUp);
		document.removeEventListener('mousemove', this._onMouseMove);
		document.removeEventListener('mousedown', this._onDocMouseDown);
		document.removeEventListener('copy', this._onDocumentCopy, true);
		document.removeEventListener('keydown', this._onDocumentKeydown, true);
		window.removeEventListener('resize', this._onViewportResize);
	}

	// ── TanStack Table ──

	private _columnTypes: ColumnSortType[] = [];

	private _initTable(): void {
		if (!this.columns.length) { this._table = null; this._columnTypes = []; return; }
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
			state: { sorting: this._sorting, columnFilters: this._columnFilters, rowSelection: this._rowSelection, columnPinning: { left: [], right: [] }, columnVisibility: {}, columnOrder: [] },
			onStateChange: () => {}, renderFallbackValue: null,
			onSortingChange: (u) => { this._sorting = typeof u === 'function' ? u(this._sorting) : u; this._table?.setOptions(p => ({ ...p, state: { ...p.state, sorting: this._sorting } })); this._updateVCount(); },
			onColumnFiltersChange: (u) => { this._columnFilters = typeof u === 'function' ? u(this._columnFilters) : u; this._table?.setOptions(p => ({ ...p, state: { ...p.state, columnFilters: this._columnFilters } })); this._columnWidths = this._computeColumnWidths(); this._updateVCount(); this.requestUpdate(); },
			onRowSelectionChange: (u) => { this._rowSelection = typeof u === 'function' ? u(this._rowSelection) : u; this._table?.setOptions(p => ({ ...p, state: { ...p.state, rowSelection: this._rowSelection } })); },
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
	// ── TanStack Virtual ──

	private _initVirtualizer(): void {
		this._virtualizer = null;
		// Need to wait for the scroll container to exist and have dimensions
		requestAnimationFrame(() => {
			const el = this.shadowRoot?.querySelector('.vscroll') as HTMLDivElement | null;
			if (!el) return;
			if (el.clientHeight > 0) { this._createVirtualizer(el); return; }
			// Container not laid out yet — watch for it
			this._resizeObs?.disconnect();
			this._resizeObs = new ResizeObserver((entries) => {
				for (const e of entries) {
					if (e.contentRect.height > 0) {
						this._resizeObs?.disconnect(); this._resizeObs = null;
						this._createVirtualizer(el);
						break;
					}
				}
			});
			this._resizeObs.observe(el);
		});
	}

	private _createVirtualizer(el: HTMLDivElement): void {
		const count = this._table?.getRowModel().rows.length ?? 0;
		const estimate = this._estimatedRowHeight();
		this._virtualizerCleanup?.();
		this._virtualizer = new Virtualizer({
			count, getScrollElement: () => el, estimateSize: () => estimate, overscan: OVERSCAN,
			scrollToFn: elementScroll, observeElementRect, observeElementOffset,
			onChange: this._onVirtualizerChange,
		});
		// _didMount() returns a cleanup function and starts internal bookkeeping.
		this._virtualizerCleanup = this._virtualizer._didMount();
		// _willUpdate() connects the scroll element observations (ResizeObserver, scroll events).
		this._virtualizer._willUpdate();
		this._sync();
	}

	private _sync(): void {
		if (!this._virtualizer) return;
		const items = this._virtualizer.getVirtualItems();
		const totalSize = this._virtualizer.getTotalSize();
		const vw = (this.shadowRoot?.querySelector('.vscroll') as HTMLElement | null)?.clientWidth ?? 0;
		// Only trigger a Lit re-render if something actually changed.
		const start = items.length > 0 ? items[0].index : -1;
		const end = items.length > 0 ? items[items.length - 1].index : -1;
		const topOff = items.length > 0 ? items[0].start : 0;
		if (start === this._lastVStart && end === this._lastVEnd
			&& totalSize === this._vTotalSize && topOff === this._lastVTopOffset
			&& vw === this._lastViewportW) return;
		this._lastVStart = start;
		this._lastVEnd = end;
		this._lastVTopOffset = topOff;
		this._lastViewportW = vw;
		this._vItems = items.map(i => ({ index: i.index, start: i.start, size: i.size }));
		this._vTotalSize = totalSize;
		this._viewportW = vw;
	}

	private _scheduleSync = (): void => {
		if (this._syncRaf) return;
		this._syncRaf = requestAnimationFrame(() => {
			this._syncRaf = 0;
			this._sync();
		});
	};

	private _installViewportResizeWatcher(): void {
		if (!this.shadowRoot) return;
		const vscroll = this.shadowRoot.querySelector('.vscroll') as HTMLElement | null;
		if (!vscroll) return;
		if (!this._viewportResizeObs) {
			this._viewportResizeObs = new ResizeObserver(() => this._onViewportResize());
			window.addEventListener('resize', this._onViewportResize, { passive: true });
		}
		this._viewportResizeObs.disconnect();
		this._viewportResizeObs.observe(vscroll);
	}

	private _onViewportResize = (): void => {
		const vw = (this.shadowRoot?.querySelector('.vscroll') as HTMLElement | null)?.clientWidth ?? 0;
		if (vw <= 0 || vw === this._viewportW) return;
		this._viewportW = vw;
		this._lastViewportW = -1;
		this.requestUpdate();
		this._syncHeaderScroll();
		if (this._virtualizer) {
			this._virtualizer.measure();
			this._sync();
		}
	};

	private _onVirtualizerChange = (_instance: Virtualizer<HTMLDivElement, Element>, sync: boolean): void => {
		if (sync) this._sync();
		else this._scheduleSync();
	};

	private _updateVCount(): void {
		if (!this._virtualizer) { this._initVirtualizer(); this._emitVisibleRowCountChange(); return; }
		const count = this._table?.getRowModel().rows.length ?? 0;
		const estimate = this._estimatedRowHeight();
		this._virtualizer.setOptions({
			count,
			getScrollElement: () => this.shadowRoot?.querySelector('.vscroll') as HTMLDivElement,
			estimateSize: () => estimate,
			overscan: OVERSCAN,
			scrollToFn: elementScroll,
			observeElementRect,
			observeElementOffset,
			onChange: this._onVirtualizerChange,
		});
		// Scroll to top so the view resets for the new sort/filter order.
		const el = this.shadowRoot?.querySelector('.vscroll') as HTMLElement | null;
		if (el) el.scrollTop = 0;
		this._lastVStart = -1;
		this._lastVEnd = -1;
		this._lastVTopOffset = 0;
		this._virtualizer.measure();
		this._sync();
		this._syncHeaderScroll();
		this._emitVisibleRowCountChange();
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
		if (this._viewportW > 0) return this._viewportW;
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

	private _estimatedRowHeight(): number {
		return (this.options.compact ?? false) ? 21 : 27;
	}

	private _syncHeaderScroll(): void {
		const vscroll = this.shadowRoot?.querySelector('.vscroll') as HTMLElement | null;
		const headWrap = this.shadowRoot?.querySelector('.dtable-head-wrap') as HTMLElement | null;
		if (!vscroll || !headWrap) return;
		headWrap.scrollLeft = vscroll.scrollLeft;
	}

	// ── Search ──

	private _execSearch(): void {
		const rx = buildRx(this._searchQuery, this._searchMode);
		if (!rx || !this._table) { this._searchMatches = []; this._currentMatchIndex = 0; return; }
		const matches: Array<{ row: number; col: number }> = [];
		const rows = this._table.getRowModel().rows;
		for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].original.length; c++) {
			const cell = rows[r].original[c];
			// For object/complex cells, search the full JSON content, not just the display text
			let searchText: string;
			if (typeof cell === 'object' && cell !== null && 'full' in cell) {
				const f = cell.full;
				searchText = typeof f === 'string' ? f : (f !== null && f !== undefined ? JSON.stringify(f) : '');
			} else {
				searchText = getCellDisplayValue(cell);
			}
			rx.lastIndex = 0;
			if (rx.test(searchText)) matches.push({ row: r, col: c });
		}
		this._searchMatches = matches; this._currentMatchIndex = 0;
		if (matches.length > 0) this._goToMatch(0);
	}
	private _goToMatch(i: number): void {
		const m = this._searchMatches[i]; if (!m) return;
		this._selectedCell = m; this._selectionRange = null;
		this._virtualizer?.scrollToIndex(m.row, { align: 'center' });
		// Scroll the matched cell's column into view after render
		this.updateComplete.then(() => {
			const vscroll = this.shadowRoot?.querySelector('.vscroll') as HTMLElement | null;
			if (!vscroll) return;
			// Find the <td> with .mc (current match) class
			const cell = vscroll.querySelector('td.mc') as HTMLElement | null;
			if (cell) cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		});
	}
	private _nextMatch(): void { if (!this._searchMatches.length) return; this._currentMatchIndex = (this._currentMatchIndex + 1) % this._searchMatches.length; this._goToMatch(this._currentMatchIndex); }
	private _prevMatch(): void { if (!this._searchMatches.length) return; this._currentMatchIndex = (this._currentMatchIndex - 1 + this._searchMatches.length) % this._searchMatches.length; this._goToMatch(this._currentMatchIndex); }
	private _isMatch(r: number, c: number): boolean { return this._searchMatches.some(m => m.row === r && m.col === c); }
	private _isCurMatch(r: number, c: number): boolean { const m = this._searchMatches[this._currentMatchIndex]; return !!m && m.row === r && m.col === c; }


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
this._updateVCount();
this.requestUpdate();
}

	// ── Scroll To Row ──

	private _parseRowJumpTargets(query: string, maxRows: number): { targets: number[]; error: string } {
		const txt = query.trim();
		if (!txt) return { targets: [], error: '' };
		if (maxRows <= 0) return { targets: [], error: 'No rows available' };

		const tokens = txt.split(',').map(t => t.trim()).filter(Boolean);
		if (!tokens.length) return { targets: [], error: '' };

		const out: number[] = [];
		const seen = new Set<number>();
		for (const token of tokens) {
			const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
			if (rangeMatch) {
				const start = parseInt(rangeMatch[1], 10);
				const end = parseInt(rangeMatch[2], 10);
				if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < 1) {
					return { targets: [], error: `Invalid row range: ${token}` };
				}
				const lo = Math.min(start, end);
				const hi = Math.max(start, end);
				for (let oneBased = lo; oneBased <= hi; oneBased++) {
					if (oneBased > maxRows) continue;
					const zeroBased = oneBased - 1;
					if (!seen.has(zeroBased)) {
						seen.add(zeroBased);
						out.push(zeroBased);
					}
				}
				continue;
			}

			if (!/^\d+$/.test(token)) return { targets: [], error: `Invalid row number: ${token}` };
			const oneBased = parseInt(token, 10);
			if (!Number.isFinite(oneBased) || oneBased < 1) return { targets: [], error: `Invalid row number: ${token}` };
			if (oneBased > maxRows) continue;
			const zeroBased = oneBased - 1;
			if (!seen.has(zeroBased)) {
				seen.add(zeroBased);
				out.push(zeroBased);
			}
		}

		if (!out.length) return { targets: [], error: `No rows in range (1-${maxRows})` };
		return { targets: out, error: '' };
	}

	private _execRowJump(totalRows: number): void {
		const parsed = this._parseRowJumpTargets(this._rowJumpQuery, totalRows);
		this._rowJumpTargets = parsed.targets;
		this._rowJumpError = parsed.error;
		this._currentRowJumpIndex = 0;
		if (!parsed.error && parsed.targets.length > 0) this._goToRowTarget(0);
	}

	private _goToRowTarget(index: number): void {
		const row = this._rowJumpTargets[index];
		if (row === undefined) return;
		const col = this._selectedCell?.col ?? 0;
		this._selectedCell = { row, col };
		this._selectionRange = null;
		this._selectionAnchor = { row, col };
		this._virtualizer?.scrollToIndex(row, { align: 'center' });
	}

	private _nextRowTarget = (): void => {
		if (!this._rowJumpTargets.length) return;
		this._currentRowJumpIndex = (this._currentRowJumpIndex + 1) % this._rowJumpTargets.length;
		this._goToRowTarget(this._currentRowJumpIndex);
	};

	private _prevRowTarget = (): void => {
		if (!this._rowJumpTargets.length) return;
		this._currentRowJumpIndex = (this._currentRowJumpIndex - 1 + this._rowJumpTargets.length) % this._rowJumpTargets.length;
		this._goToRowTarget(this._currentRowJumpIndex);
	};

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
		const items = this._vItems;
		const useVirtual = items.length > 0;
		let topSpacer = 0;
		let visibleRows: Array<{ index: number; row: Row<CellValue[]> }>;
		if (useVirtual) {
			topSpacer = items[0].start;
			visibleRows = items.map(vi => ({ index: vi.index, row: allRows[vi.index] })).filter(vr => vr.row);
		} else {
			// Virtualizer not initialized yet — show empty body so .vscroll exists
			// for the virtualizer to attach to. Once _willUpdate() fires the
			// observations, onChange triggers _sync() which populates _vItems and
			// Lit re-renders with the virtualized rows.
			visibleRows = [];
		}

		return html`
		<div class="dt ${compact ? 'compact' : ''} ${hideTopBorder ? 'no-top-border' : ''}">
			${this._renderHeader(totalRows, showToolbar)}
			${this._searchVisible ? this._renderSearch() : nothing}
			${this._rowJumpVisible ? this._renderRowJump(totalRows) : nothing}
			${this._colJumpOpen ? this._renderColJump() : nothing}
			${this._bodyVisible ? html`
			<div class="vscroll" @keydown=${this._onKeydown} tabindex="0"
				@scroll=${this._onBodyScroll}
				@mousedown=${this._onTableMouseDown}>
			<div class="dtable-head-wrap">
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
				<div style="height:${this._vTotalSize}px;position:relative;">
				<table class="dtable" id="dt-body" style="position:absolute;top:${topSpacer}px;left:0;width:${tableWidth}px;min-width:${tableWidth}px;">
					<colgroup>
						<col style="width:${ROW_NUMBER_WIDTH}px;min-width:${ROW_NUMBER_WIDTH}px;max-width:${ROW_NUMBER_WIDTH}px;" />
						${colWidths.map(width => html`<col style="width:${width}px;min-width:${width}px;max-width:${width}px;" />`)}
					</colgroup>
					<tbody>
						${visibleRows.map(({ index, row }) => {
							const isSel = this._selectedCell?.row === index;
							return html`<tr class="${isSel ? 'sel-row' : ''}" data-idx="${index}">
								<td class="rn" @click=${(e: MouseEvent) => this._selRow(e, index)}>${index + 1}</td>
								${row.getVisibleCells().map((cell, ci) => {
							const raw = cell.getValue() as CellValue, display = fmtCell(raw);
								const isObj = typeof raw === 'object' && raw !== null && 'isObject' in raw && raw.isObject;
								const isFocus = this._selectedCell?.row === index && this._selectedCell?.col === ci;
								const isInRng = inRange(this._selectionRange, index, ci);
								const isM = this._searchMatches.length > 0 && this._isMatch(index, ci);
								const isCM = isM && this._isCurMatch(index, ci);
								let cls = isFocus ? 'cf' : isInRng ? 'cr' : '';
								if (isCM) cls += ' mc'; else if (isM) cls += ' mh';
								if (isObj) {
									return html`<td class="${cls} obj-cell" title="${escHtml(getCellDisplayValue(raw))}"><button class="obj-btn" @click=${(e: MouseEvent) => { e.stopPropagation(); this._openObjectViewer(index, ci); }}>View</button></td>`;
								}
								return html`<td class="${cls}" title="${escHtml(getCellDisplayValue(raw))}" @dblclick=${(e: MouseEvent) => { if (this._isCellObject(index, ci)) { e.stopPropagation(); this._openObjectViewer(index, ci); } }}>${display}</td>`;
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
			<kw-object-viewer></kw-object-viewer>
		</div>`;
	}

	private _renderHeader(totalRows: number, showToolbar: boolean): TemplateResult {
		const showVis = this.options.showVisibilityToggle ?? false;
		const isFiltered = totalRows < this.rows.length;
		const rowSummary = isFiltered
			? `${totalRows} of ${this.rows.length} rows (filtered)`
			: `${totalRows} row${totalRows !== 1 ? 's' : ''}`;
		return html`<div class="hbar">
			<span class="hinfo">${this.options.label ? html`<strong>${this.options.label}:</strong> ` : nothing}${rowSummary} / ${this.columns.length} col${this.columns.length !== 1 ? 's' : ''}${this.options.executionTime && this.options.showExecutionTime ? html` <span class="et">(${this.options.executionTime})</span>` : nothing}${showVis ? html` <button class="tbtn ${!this._bodyVisible ? 'act' : ''}" title="${this._bodyVisible ? 'Hide results' : 'Show results'}" @click=${this._toggleBody}>${ICON.eye}</button>` : nothing}</span>
			${(showToolbar && this._bodyVisible) ? html`<div class="tb">
				<button class="tbtn ${this._searchVisible ? 'act' : ''}" title="Search data" @click=${() => this._toggleSearch()}>${ICON.search}</button>
				<button class="tbtn ${this._rowJumpVisible ? 'act' : ''}" title="Scroll to row" @click=${() => this._toggleRowJump(totalRows)}>${ICON.scrollToRow}</button>
				<button class="tbtn ${this._colJumpOpen ? 'act' : ''}" title="Scroll to column" @click=${() => { this._colJumpOpen = !this._colJumpOpen; this._colJumpQuery = ''; }}>${ICON.scrollToCol}</button>
				<button class="tbtn ${this._sortDialogOpen ? 'act' : ''}" title="Sort" @click=${() => this._sortDialogOpen = !this._sortDialogOpen}>${ICON.sort}</button>
				<span class="sep"></span>
				<button class="tbtn" title="Save results to file" @click=${() => this._save()}>${ICON.save}</button>
				<button class="tbtn" title="Copy (Ctrl+C)" @click=${() => this._copy()}>${ICON.copy}</button>
				${this._sorting.length > 0 ? html`<button class="tbtn" title="Clear sort" @click=${this._clearSort}>✕ Sort</button>` : nothing}
			</div>` : nothing}
		</div>`;
	}

	private _renderRowJump(totalRows: number): TemplateResult {
		const rc = this._rowJumpTargets.length;
		const statusText = this._rowJumpError
			? this._rowJumpError
			: (this._rowJumpQuery.trim()
				? (rc > 0 ? `(${this._currentRowJumpIndex + 1}/${rc})` : `Enter rows 1-${totalRows}`)
				: `Max row: ${totalRows}`);
		const statusClass = this._rowJumpError ? 'sc-status err' : 'sc-status';
		return html`<div class="sbar">
			<div class="sc">
				<svg class="sc-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10"/><path d="M3 7.5h10"/><path d="M3 10.5h6"/><path d="M11.5 9.5v4"/><path d="M10.2 12.2l1.3 1.3 1.3-1.3"/></svg>
				<input type="text" class="sinp row-jump-inp" placeholder="Scroll to row (e.g. 1, 120, 500)..." autocomplete="off" spellcheck="false" .value=${this._rowJumpQuery}
					@input=${(e: Event) => { this._rowJumpQuery = (e.target as HTMLInputElement).value; this._execRowJump(totalRows); }}
					@keydown=${(e: KeyboardEvent) => {
						if (e.key === 'Enter') { e.shiftKey ? this._prevRowTarget() : this._nextRowTarget(); e.preventDefault(); }
						if (e.key === 'Escape') { this._toggleRowJump(totalRows); e.preventDefault(); }
					}} />
				<span class="${statusClass}">${statusText}</span>
			</div>
			<button class="nb" title="Close" @click=${() => this._toggleRowJump(totalRows)}>${ICON.close}</button>
		</div>`;
	}

	private _renderSearch(): TemplateResult {
		const mc = this._searchMatches.length;
		const statusText = this._searchQuery.trim() ? (mc > 0 ? `(${this._currentMatchIndex + 1}/${mc})` : 'No matches') : '';
		return html`<div class="sbar">
			<div class="sc">
				<svg class="sc-icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.5 6.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0zm-.82 4.12a5 5 0 1 1 .707-.707l3.536 3.536-.707.707-3.536-3.536z"/></svg>
				<input type="text" class="sinp search-inp" placeholder="Search..." autocomplete="off" spellcheck="false" .value=${this._searchQuery}
					@input=${(e: Event) => { this._searchQuery = (e.target as HTMLInputElement).value; this._execSearch(); }}
					@keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') { e.shiftKey ? this._prevMatch() : this._nextMatch(); e.preventDefault(); } if (e.key === 'Escape') { this._toggleSearch(); e.preventDefault(); } }} />
				${statusText ? html`<span class="sc-status">${statusText}</span>` : nothing}
				<button class="sc-mode" title="${this._searchMode === 'regex' ? 'Regex' : 'Wildcard'}" @click=${() => { this._searchMode = this._searchMode === 'regex' ? 'wildcard' : 'regex'; this._execSearch(); }}><span class="ml">${this._searchMode === 'regex' ? '.*' : '*'}</span></button>
				<span class="sc-div"></span>
				<button class="sc-nav" title="Previous" ?disabled=${mc < 2} @click=${this._prevMatch}>${ICON.up}</button>
				<button class="sc-nav" title="Next" ?disabled=${mc < 2} @click=${this._nextMatch}>${ICON.down}</button>
			</div>
			<button class="nb" title="Close" @click=${() => this._toggleSearch()}>${ICON.close}</button>
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
						if (e.key === 'Escape') { this._colJumpOpen = false; e.preventDefault(); }
						if (e.key === 'Enter' && filtered.length > 0) { this._scrollToCol(filtered[0].idx); this._colJumpOpen = false; e.preventDefault(); }
						if (e.key === 'ArrowDown') { const first = this.shadowRoot?.querySelector('.cj-item') as HTMLElement; first?.focus(); e.preventDefault(); }
					}} />
				<div class="cj-list">
					${filtered.length > 0 ? filtered.map(c => html`<div class="cj-item" tabindex="0"
						@click=${() => { this._scrollToCol(c.idx); this._colJumpOpen = false; }}
						@keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') { this._scrollToCol(c.idx); this._colJumpOpen = false; e.preventDefault(); } }}>${c.name}</div>`) : html`<div class="cj-empty">No columns match</div>`}
				</div>
			</div>
			<button class="nb" title="Close" @click=${() => { this._colJumpOpen = false; }}>${ICON.close}</button>
		</div>`;
	}

	private _renderTh(h: any): TemplateResult {
		const col = h.column as Column<CellValue[]>, sd = col.getIsSorted(), si = this._sorting.findIndex(s => s.id === col.id), ci = parseInt(col.id);
		const isFiltered = isColumnFiltered(ci, this._columnFilters);
		return html`<th @click=${(e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.cm-btn') && !(e.target as HTMLElement).closest('.filtered-link')) col.toggleSorting(undefined, e.shiftKey); }} class="${sd ? 'sorted' : ''}">
			<div class="thc"><span class="thn">${col.columnDef.header}${isFiltered ? html`<a href="#" class="filtered-link" @click=${(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); this._openFilterDialog(ci); }}>(filtered)</a>` : nothing}</span>
				${sd ? html`<span class="si2">${sd === 'asc' ? '↑' : '↓'}${this._sorting.length > 1 ? html`<sup>${si + 1}</sup>` : nothing}</span>` : nothing}
				<button class="cm-btn" @click=${(e: MouseEvent) => { e.stopPropagation(); this._openColumnMenu(ci, e); }}>☰</button>
			</div>
		</th>`;
	}

	private _openColumnMenu(ci: number, e: MouseEvent): void {
		if (this._columnMenuOpen === ci) { this._closeColumnMenu(); return; }
		const btn = e.currentTarget as HTMLElement;
		const rect = btn.getBoundingClientRect();
		this._columnMenuPos = { x: rect.right, y: rect.bottom + 2 };
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
		</div>`;
	}


	// ── Mouse drag selection ──

	private _clearSelection(): void {
		this._selectedCell = null;
		this._selectionRange = null;
		this._selectionAnchor = null;
	}

	private _onTableMouseDown = (e: MouseEvent) => {
		// Only handle left-click on data cells (not row-number, not header)
		if (e.button !== 0) return;
		(this.shadowRoot?.querySelector('.vscroll') as HTMLElement | null)?.focus();
		const pos = cellFromEvent(e);
		if (!pos) return;
		// Clicking the already-selected single cell toggles it off.
		if (this._selectedCell?.row === pos.row && this._selectedCell?.col === pos.col && this._selectionRange === null) {
			this._clearSelection();
			e.preventDefault();
			return;
		}
		// Start drag
		this._isDragging = true;
		this._selectionAnchor = pos;
		this._selectedCell = pos;
		this._selectionRange = null;
		document.addEventListener('mousemove', this._onMouseMove);
		document.addEventListener('mouseup', this._onMouseUp);
		e.preventDefault(); // prevent text selection
	};

	private _onMouseMove = (e: MouseEvent) => {
		if (!this._isDragging || !this._selectionAnchor) return;
		// Find cell under mouse — the event target may be outside shadow DOM during drag
		const el = this.shadowRoot?.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
		if (!el) return;
		const td = el.closest?.('td');
		if (!td) return;
		const tr = td.closest('tr');
		if (!tr || tr.dataset.idx === undefined) return;
		const tds = Array.from(tr.querySelectorAll('td'));
		const ci = tds.indexOf(td) - 1;
		if (ci < 0) return;
		const row = parseInt(tr.dataset.idx, 10);
		this._selectedCell = { row, col: ci };
		this._selectionRange = {
			rowMin: Math.min(this._selectionAnchor.row, row),
			rowMax: Math.max(this._selectionAnchor.row, row),
			colMin: Math.min(this._selectionAnchor.col, ci),
			colMax: Math.max(this._selectionAnchor.col, ci),
		};
	};

	private _onMouseUp = () => {
		this._isDragging = false;
		document.removeEventListener('mousemove', this._onMouseMove);
		document.removeEventListener('mouseup', this._onMouseUp);
	};

	// ── Events ──

	private _selRow(e: MouseEvent, row: number): void {
		const mc = this.columns.length - 1;
		if (e.shiftKey && this._selectionAnchor) {
			// Extend selection from anchor row to clicked row (full rows)
			this._selectionRange = { rowMin: Math.min(this._selectionAnchor.row, row), rowMax: Math.max(this._selectionAnchor.row, row), colMin: 0, colMax: mc };
			this._selectedCell = { row, col: 0 };
		} else {
			// Clicking the already-selected single row toggles it off.
			const isSameSingleRow =
				this._selectedCell?.row === row &&
				this._selectedCell?.col === 0 &&
				this._selectionRange?.rowMin === row &&
				this._selectionRange?.rowMax === row &&
				this._selectionRange?.colMin === 0 &&
				this._selectionRange?.colMax === mc;
			if (isSameSingleRow) {
				this._clearSelection();
				return;
			}
			this._selectedCell = { row, col: 0 };
			this._selectionRange = { rowMin: row, rowMax: row, colMin: 0, colMax: mc };
			this._selectionAnchor = { row, col: 0 };
		}
	}
	private _onKeydown = (e: KeyboardEvent) => {
		if ((e.ctrlKey || e.metaKey) && e.key === 'f') { this._toggleSearch(); e.preventDefault(); return; }
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') { this._toggleRowJump(this._table?.getRowModel().rows.length ?? 0); e.preventDefault(); return; }
		if ((e.ctrlKey || e.metaKey) && e.key === 'a') { this._selAll(); e.preventDefault(); return; }
		if (!this._selectedCell) return;
		const { row, col } = this._selectedCell, mR = (this._table?.getRowModel().rows.length ?? 1) - 1, mC = this.columns.length - 1;
		let nr = row, nc = col;
		switch (e.key) {
			case 'ArrowUp': nr = Math.max(0, row - 1); break; case 'ArrowDown': nr = Math.min(mR, row + 1); break;
			case 'ArrowLeft': nc = Math.max(0, col - 1); break; case 'ArrowRight': nc = Math.min(mC, col + 1); break;
			case 'Home': nc = 0; if (e.ctrlKey) nr = 0; break; case 'End': nc = mC; if (e.ctrlKey) nr = mR; break;
			case 'PageUp': nr = Math.max(0, row - 20); break; case 'PageDown': nr = Math.min(mR, row + 20); break;
			case 'c': if (e.ctrlKey || e.metaKey) { this._copy(); e.preventDefault(); } return;
			default: return;
		}
		e.preventDefault();
		if (e.shiftKey) { if (!this._selectionAnchor) this._selectionAnchor = { row, col }; this._selectionRange = { rowMin: Math.min(this._selectionAnchor.row, nr), rowMax: Math.max(this._selectionAnchor.row, nr), colMin: Math.min(this._selectionAnchor.col, nc), colMax: Math.max(this._selectionAnchor.col, nc) }; }
		else { this._selectionRange = null; this._selectionAnchor = { row: nr, col: nc }; }
		this._selectedCell = { row: nr, col: nc }; this._virtualizer?.scrollToIndex(nr, { align: 'auto' });
	};

	// ── Actions ──

	private _toggleSearch(): void { this._searchVisible = !this._searchVisible; if (this._searchVisible) requestAnimationFrame(() => { const i = this.shadowRoot?.querySelector('.search-inp') as HTMLInputElement; i?.focus(); i?.select(); }); else { this._searchMatches = []; this._searchQuery = ''; } }
	private _toggleRowJump(totalRows: number): void {
		this._rowJumpVisible = !this._rowJumpVisible;
		if (this._rowJumpVisible) {
			requestAnimationFrame(() => {
				const i = this.shadowRoot?.querySelector('.row-jump-inp') as HTMLInputElement;
				i?.focus();
				i?.select();
			});
			this._execRowJump(totalRows);
		} else {
			this._rowJumpTargets = [];
			this._rowJumpQuery = '';
			this._currentRowJumpIndex = 0;
			this._rowJumpError = '';
		}
	}
	private _toggleBody(): void { this._bodyVisible = !this._bodyVisible; this.dispatchEvent(new CustomEvent('visibility-toggle', { detail: { visible: this._bodyVisible }, bubbles: true, composed: true })); }
	private _onSortChange = (e: CustomEvent<{ sorting: SortingState }>): void => {
		this._sorting = e.detail.sorting;
		this._table?.setOptions(p => ({ ...p, state: { ...p.state, sorting: this._sorting } }));
		this._updateVCount();
		this._sortDialogOpen = false;
	};
	private _clearSort(): void { this._sorting = []; this._table?.setOptions(p => ({ ...p, state: { ...p.state, sorting: [] } })); this._sortDialogOpen = false; this._updateVCount(); }
	private _selAll(): void { const mr = (this._table?.getRowModel().rows.length ?? 1) - 1, mc = this.columns.length - 1; this._selectedCell = { row: 0, col: 0 }; this._selectionAnchor = { row: 0, col: 0 }; this._selectionRange = { rowMin: 0, rowMax: mr, colMin: 0, colMax: mc }; }
	private _scrollToCol(ci: number): void {
		const el = this.shadowRoot?.querySelector('.vscroll') as HTMLElement | null;
		if (!el) return;
		const colWidths = this._layoutColumns().widths;
		const left = colWidths.slice(0, ci).reduce((sum, width) => sum + width, ROW_NUMBER_WIDTH);
		el.scrollLeft = Math.max(0, left - ROW_NUMBER_WIDTH);
		this._syncHeaderScroll();
	}

	private _onBodyScroll = (): void => {
		this._syncHeaderScroll();
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
		// Pass the current search query if this cell is a search match
		const isMatch = this._searchMatches.some(m => m.row === rowIdx && m.col === colIdx);
		viewer.show(`Object viewer for ${colName}`, jsonText, isMatch ? { searchQuery: this._searchQuery, searchMode: this._searchMode } : undefined);
	}
	private _copy(): void {
		const text = this._buildClipboardText();
		if (!text) return;
		this._writeTextToClipboard(text);
	}

	private _buildClipboardText(): string {
		if (!this._table) return '';
		const rows = this._table.getRowModel().rows;
		if (this._selectionRange) {
			const { rowMin, rowMax, colMin, colMax } = this._selectionRange;
			const lines = [this.columns.slice(colMin, colMax + 1).map(c => c.name).join('\t')];
			for (let r = rowMin; r <= rowMax; r++) {
				const row = rows[r];
				if (!row) continue;
				const cells: string[] = [];
				for (let c = colMin; c <= colMax; c++) cells.push(getCellDisplayValue(row.original[c]));
				lines.push(cells.join('\t'));
			}
			return lines.join('\n');
		}
		if (this._selectedCell) {
			const row = rows[this._selectedCell.row];
			if (row) return getCellDisplayValue(row.original[this._selectedCell.col]);
		}
		const lines = [this.columns.map(c => c.name).join('\t')];
		for (const row of rows) {
			lines.push(row.original.map(cell => getCellDisplayValue(cell)).join('\t'));
		}
		return lines.join('\n');
	}

	private _writeTextToClipboard(text: string): void {
		const value = text == null ? '' : String(text);
		try {
			if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
				navigator.clipboard.writeText(value);
				return;
			}
		} catch { /* ignore */ }
		try {
			const ta = document.createElement('textarea');
			ta.value = value;
			ta.setAttribute('readonly', '');
			ta.style.position = 'fixed';
			ta.style.left = '-1000px';
			ta.style.top = '-1000px';
			document.body.appendChild(ta);
			ta.select();
			document.execCommand('copy');
			document.body.removeChild(ta);
		} catch { /* ignore */ }
	}

	private _onDocumentCopy = (e: ClipboardEvent): void => {
		if (!this._isSelectionInThisTable()) return;
		const text = this._buildClipboardText();
		if (!text) return;
		try {
			e.preventDefault();
			e.stopPropagation();
			if (e.clipboardData) {
				e.clipboardData.setData('text/plain', text);
				return;
			}
		} catch { /* ignore */ }
		this._writeTextToClipboard(text);
	};

	private _onDocumentKeydown = (e: KeyboardEvent): void => {
		if (e.key === 'Escape' && this._isKeyboardEventInsideThisTable(e)) {
			if (this._closeAllPopups()) {
				e.preventDefault();
				e.stopPropagation();
			}
			return;
		}
		if (!(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 'c') return;
		if (!this._isSelectionInThisTable()) return;
		e.preventDefault();
		e.stopPropagation();
		this._copy();
	};

	private _isKeyboardEventInsideThisTable(e: KeyboardEvent): boolean {
		try {
			const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
			if (Array.isArray(path) && path.includes(this)) return true;
		} catch { /* ignore */ }
		const active = document.activeElement as HTMLElement | null;
		if (active && this.contains(active)) return true;
		return false;
	}

	private _closeAllPopups(): boolean {
		let closedAny = false;
		if (this._columnMenuOpen !== null) {
			this._closeColumnMenu();
			closedAny = true;
		}
		if (this._sortDialogOpen) {
			this._sortDialogOpen = false;
			closedAny = true;
		}
		if (this._filterDialogOpen) {
			this._closeFilterDialog();
			closedAny = true;
		}
		if (this._searchVisible) {
			this._toggleSearch();
			closedAny = true;
		}
		if (this._rowJumpVisible) {
			this._toggleRowJump(this._table?.getRowModel().rows.length ?? 0);
			closedAny = true;
		}
		if (this._colJumpOpen) {
			this._colJumpOpen = false;
			this._colJumpQuery = '';
			closedAny = true;
		}
		return closedAny;
	}

	private _isSelectionInThisTable(): boolean {
		if (!this._selectedCell && !this._selectionRange) return false;
		const active = document.activeElement as HTMLElement | null;
		if (active && this.contains(active)) return true;
		// Fallback: if the component is visible and has an active selection, allow copy.
		return this.isConnected;
	}
	private _copyCol(ci: number): void { if (!this._table) return; const rows = this._table.getRowModel().rows; const text = this.columns[ci].name + '\n' + rows.map(r => getCellDisplayValue(r.original[ci])).join('\n'); try { navigator.clipboard.writeText(text); } catch {} }
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
