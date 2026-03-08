import { LitElement, html, css, nothing, type TemplateResult, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { createTable, getCoreRowModel, getSortedRowModel, getFilteredRowModel, type Table, type ColumnDef, type SortingState, type ColumnFiltersState, type Row, type CellContext, type RowSelectionState, type Column } from '@tanstack/table-core';
import { Virtualizer, elementScroll, observeElementRect, observeElementOffset } from '@tanstack/virtual-core';
import type { KwObjectViewer } from './kw-object-viewer.js';

export interface DataTableColumn { name: string; type?: string; }
export interface DataTableOptions {
	label?: string; showExecutionTime?: boolean; executionTime?: string;
	compact?: boolean; showToolbar?: boolean;
	/** Show save button — fires 'save' CustomEvent when clicked. */
	showSave?: boolean;
	/** Show visibility toggle — fires 'visibility-toggle' CustomEvent. */
	showVisibilityToggle?: boolean;
}
type CellValue = string | number | boolean | null | undefined | { display?: string; full?: unknown; isObject?: boolean };
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
function fmtNum(val: number): string { try { return val.toLocaleString(undefined, { maximumFractionDigits: 20 }); } catch { return String(val); } }
function fmtCell(cell: CellValue): string {
	if (typeof cell === 'number') return fmtNum(cell);
	if (typeof cell === 'object' && cell !== null && 'full' in cell && typeof cell.full === 'number') return fmtNum(cell.full);
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

const ROW_HEIGHT = 28, OVERSCAN = 10;

/* SVG icon templates */
const ICON = {
	search: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.2"/><path d="M10.4 10.4L14 14"/></svg>`,
	scrollToCol: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3.5h10"/><path d="M3 6.5h10"/><path d="M3 9.5h6"/><path d="M3 12.5h6"/><path d="M12.5 8v5"/><path d="M11 11.5l1.5 1.5 1.5-1.5"/></svg>`,
	sort: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3v10"/><path d="M2 11l2 2 2-2"/><path d="M8 3h5"/><path d="M8 6h4"/><path d="M8 9h3"/></svg>`,
	save: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5h8.2L13.5 4.8V13.5a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z"/><path d="M5 2.8V6h6V2.8"/><path d="M5 14.5V9.5h6v5"/></svg>`,
	copy: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="2" ry="2"/><path d="M3 11V4a2 2 0 0 1 2-2h7"/></svg>`,
	eye: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z"/><circle cx="8" cy="8" r="2.1"/></svg>`,
	close: html`<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>`,
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
	@state() private _bodyVisible = true;
	@state() private _colJumpOpen = false;
	@state() private _colJumpQuery = '';

	// TanStack Virtual state
	@state() private _vItems: VItem[] = [];
	@state() private _vTotalSize = 0;

	private _table: Table<CellValue[]> | null = null;
	private _virtualizer: Virtualizer<HTMLDivElement, Element> | null = null;
	private _resizeObs: ResizeObserver | null = null;
	private _isDragging = false;

	// ── Lifecycle ──

	protected willUpdate(changed: PropertyValues): void {
		if (changed.has('columns') || changed.has('rows')) { this._initTable(); this._searchMatches = []; this._currentMatchIndex = 0; }
	}
	protected firstUpdated(): void { this._initVirtualizer(); }
	protected updated(changed: PropertyValues): void { if (changed.has('columns') || changed.has('rows')) this._initVirtualizer(); }
	disconnectedCallback(): void { super.disconnectedCallback(); this._resizeObs?.disconnect(); this._virtualizer = null; document.removeEventListener('mouseup', this._onMouseUp); document.removeEventListener('mousemove', this._onMouseMove); document.removeEventListener('mousedown', this._onDocMouseDown); }

	// ── TanStack Table ──

	private _initTable(): void {
		if (!this.columns.length) { this._table = null; return; }
		const defs: ColumnDef<CellValue[]>[] = this.columns.map((col, i) => ({
			id: String(i), header: col.name, accessorFn: (row: CellValue[]) => row[i],
			cell: (info: CellContext<CellValue[], unknown>) => info.getValue(),
			sortingFn: (rA: Row<CellValue[]>, rB: Row<CellValue[]>) => {
				const a = getCellSortValue(rA.original[i]), b = getCellSortValue(rB.original[i]);
				if (a === null && b === null) return 0; if (a === null) return 1; if (b === null) return -1;
				if (typeof a === 'number' && typeof b === 'number') return a - b;
				return String(a).localeCompare(String(b));
			},
		}));
		this._table = createTable({ columns: defs, data: this.rows,
			state: { sorting: this._sorting, columnFilters: this._columnFilters, rowSelection: this._rowSelection, columnPinning: { left: [], right: [] }, columnVisibility: {}, columnOrder: [] },
			onStateChange: () => {}, renderFallbackValue: null,
			onSortingChange: (u) => { this._sorting = typeof u === 'function' ? u(this._sorting) : u; this._table?.setOptions(p => ({ ...p, state: { ...p.state, sorting: this._sorting } })); this._updateVCount(); },
			onColumnFiltersChange: (u) => { this._columnFilters = typeof u === 'function' ? u(this._columnFilters) : u; this._table?.setOptions(p => ({ ...p, state: { ...p.state, columnFilters: this._columnFilters } })); this._updateVCount(); },
			onRowSelectionChange: (u) => { this._rowSelection = typeof u === 'function' ? u(this._rowSelection) : u; this._table?.setOptions(p => ({ ...p, state: { ...p.state, rowSelection: this._rowSelection } })); },
			getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getFilteredRowModel: getFilteredRowModel(), enableMultiSort: true,
		});
		this._table.setOptions(prev => ({ ...prev }));
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
		this._virtualizer = new Virtualizer({
			count, getScrollElement: () => el, estimateSize: () => ROW_HEIGHT, overscan: OVERSCAN,
			scrollToFn: elementScroll, observeElementRect, observeElementOffset,
			onChange: () => this._sync(),
		});
		this._sync();
	}

	private _sync(): void {
		if (!this._virtualizer) return;
		const items = this._virtualizer.getVirtualItems();
		this._vItems = items.map(i => ({ index: i.index, start: i.start, size: i.size }));
		this._vTotalSize = this._virtualizer.getTotalSize();
	}

	private _updateVCount(): void {
		if (!this._virtualizer) { this._initVirtualizer(); return; }
		const count = this._table?.getRowModel().rows.length ?? 0;
		this._virtualizer.setOptions({
			count, getScrollElement: () => this.shadowRoot?.querySelector('.vscroll') as HTMLDivElement,
			estimateSize: () => ROW_HEIGHT, overscan: OVERSCAN,
			scrollToFn: elementScroll, observeElementRect, observeElementOffset,
		});
		this._virtualizer.measure();
		this._sync();
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

	// ── Render ──

	protected render(): TemplateResult {
		if (!this._table || !this.columns.length) return html`<div class="empty">No data</div>`;
		const table = this._table, allRows = table.getRowModel().rows, totalRows = allRows.length;
		const compact = this.options.compact ?? false, showToolbar = this.options.showToolbar !== false;
		const colSpan = this.columns.length + 1;

		// Spacer-row virtualization
		const items = this._vItems;
		const useVirtual = items.length > 0;
		let topSpacer = 0, bottomSpacer = 0;
		let visibleRows: Array<{ index: number; row: Row<CellValue[]> }>;
		if (useVirtual) {
			topSpacer = items[0].start;
			const last = items[items.length - 1];
			bottomSpacer = Math.max(0, this._vTotalSize - (last.start + last.size));
			visibleRows = items.map(vi => ({ index: vi.index, row: allRows[vi.index] })).filter(vr => vr.row);
		} else {
			const batch = Math.min(totalRows, 100);
			visibleRows = allRows.slice(0, batch).map((row, i) => ({ index: i, row }));
		}

		return html`
		<div class="dt ${compact ? 'compact' : ''}">
			${this._renderHeader(totalRows, showToolbar)}
			${this._searchVisible ? this._renderSearch() : nothing}
			${this._colJumpOpen ? this._renderColJump() : nothing}
			${this._bodyVisible ? html`
			<div class="vscroll" @keydown=${this._onKeydown} tabindex="0"
				@mousedown=${this._onTableMouseDown}>
				<table class="dtable">
					<thead><tr>
						<th class="rn-h">#</th>
						${table.getHeaderGroups()[0]?.headers.map(h => this._renderTh(h))}
					</tr></thead>
					<tbody>
						${topSpacer > 0 ? html`<tr class="vspacer" aria-hidden="true"><td colspan="${colSpan}" style="height:${topSpacer}px;"></td></tr>` : nothing}
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
						${bottomSpacer > 0 ? html`<tr class="vspacer" aria-hidden="true"><td colspan="${colSpan}" style="height:${bottomSpacer}px;"></td></tr>` : nothing}
					</tbody>
				</table>
				${totalRows === 0 ? html`<div class="empty-body">No matching rows</div>` : nothing}
			</div>` : html`<div class="hidden-msg">Results hidden</div>`}
			${this._sortDialogOpen ? this._renderSortDialog() : nothing}
			${this._columnMenuOpen !== null ? this._renderColumnMenu() : nothing}
			<kw-object-viewer></kw-object-viewer>
		</div>`;
	}

	private _renderHeader(totalRows: number, showToolbar: boolean): TemplateResult {
		const showVis = this.options.showVisibilityToggle ?? false;
		return html`<div class="hbar">
			<span class="hinfo">${this.options.label ? html`<strong>${this.options.label}:</strong> ` : nothing}${totalRows < this.rows.length ? `${totalRows} / ${this.rows.length}` : totalRows} row${totalRows !== 1 ? 's' : ''} / ${this.columns.length} col${this.columns.length !== 1 ? 's' : ''}${this.options.executionTime && this.options.showExecutionTime ? html` <span class="et">(${this.options.executionTime})</span>` : nothing}</span>
			${showVis ? html`<button class="tbtn ${!this._bodyVisible ? 'act' : ''}" title="${this._bodyVisible ? 'Hide results' : 'Show results'}" @click=${this._toggleBody}>${ICON.eye}</button>` : nothing}
			${showToolbar ? html`<div class="tb">
				<button class="tbtn ${this._searchVisible ? 'act' : ''}" title="Search data" @click=${() => this._toggleSearch()}>${ICON.search}</button>
				<button class="tbtn ${this._colJumpOpen ? 'act' : ''}" title="Scroll to column" @click=${() => { this._colJumpOpen = !this._colJumpOpen; this._colJumpQuery = ''; }}>${ICON.scrollToCol}</button>
				<button class="tbtn ${this._sortDialogOpen ? 'act' : ''}" title="Sort" @click=${() => this._sortDialogOpen = !this._sortDialogOpen}>${ICON.sort}</button>
				<span class="sep"></span>
				<button class="tbtn" title="Save results to file" @click=${() => this._save()}>${ICON.save}</button>
				<button class="tbtn" title="Copy (Ctrl+C)" @click=${() => this._copy()}>${ICON.copy}</button>
				${this._sorting.length > 0 ? html`<button class="tbtn" title="Clear sort" @click=${this._clearSort}>✕ Sort</button>` : nothing}
			</div>` : nothing}
		</div>`;
	}

	private _renderSearch(): TemplateResult {
		const mc = this._searchMatches.length;
		const statusText = this._searchQuery.trim() ? (mc > 0 ? `(${this._currentMatchIndex + 1}/${mc})` : 'No matches') : '';
		return html`<div class="sbar">
			<div class="sc">
				<svg class="sc-icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.5 6.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0zm-.82 4.12a5 5 0 1 1 .707-.707l3.536 3.536-.707.707-3.536-3.536z"/></svg>
				<input type="text" class="sinp" placeholder="Search..." autocomplete="off" spellcheck="false" .value=${this._searchQuery}
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
		return html`<th @click=${(e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.cm-btn')) col.toggleSorting(undefined, e.shiftKey); }} class="${sd ? 'sorted' : ''}">
			<div class="thc"><span class="thn">${col.columnDef.header}</span>
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
			<div class="cms"></div>
			<div class="cmi" @click=${() => { this._copyCol(ci); this._closeColumnMenu(); }}>Copy column values</div>
		</div>`;
	}

	private _renderSortDialog(): TemplateResult {
		const unusedCols = this.columns.map((c, i) => ({ name: c.name, idx: i })).filter(c => !this._sorting.some(s => s.id === String(c.idx)));
		return html`<div class="sd-bg" @click=${() => this._sortDialogOpen = false}><div class="sd" @click=${(e: Event) => e.stopPropagation()}>
			<div class="sd-h">
				<strong>Sort</strong>
				<button class="nb sd-x" title="Close" @click=${() => this._sortDialogOpen = false}>${ICON.close}</button>
			</div>
			<div class="sd-b">
				${this._sorting.length === 0 ? html`<div class="sd-e">No sort applied.</div>` : nothing}
				${this._sorting.map((rule, idx) => html`<div class="sr">
					<span class="sr-ord">${idx + 1}</span>
					<button class="sr-rm" title="Remove" @click=${() => this._rmSort(idx)}>${ICON.close}</button>
					<select class="sr-col" .value=${rule.id} @change=${(e: Event) => this._updSortCol(idx, (e.target as HTMLSelectElement).value)}>${this.columns.map((c, i) => html`<option value="${i}" ?selected=${rule.id === String(i)}>${c.name}</option>`)}</select>
					<select class="sr-dir" .value=${rule.desc ? 'desc' : 'asc'} @change=${(e: Event) => this._updSortDir(idx, (e.target as HTMLSelectElement).value)}><option value="asc">Ascending</option><option value="desc">Descending</option></select>
				</div>`)}
				<div class="sr-add">
					<span class="sr-add-label">Add sort</span>
					<select class="sr-col" id="sr-add-col">
						<option value="" selected>Select a column…</option>
						${unusedCols.map(c => html`<option value="${c.idx}">${c.name}</option>`)}
					</select>
					<select class="sr-dir" id="sr-add-dir"><option value="asc" selected>Ascending</option><option value="desc">Descending</option></select>
					<button class="sr-add-btn" title="Add" @click=${this._addSortInline}>+</button>
				</div>
			</div>
			<div class="sd-f">
				<button class="sd-btn sd-btn-danger" @click=${() => { this._clearSort(); }}>Remove Sort</button>
				<button class="sd-btn" @click=${() => this._applySortDialog()}>Apply</button>
			</div>
		</div></div>`;
	}

	// ── Mouse drag selection ──

	private _onTableMouseDown = (e: MouseEvent) => {
		// Only handle left-click on data cells (not row-number, not header)
		if (e.button !== 0) return;
		const pos = cellFromEvent(e);
		if (!pos) return;
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
			this._selectedCell = { row, col: 0 };
			this._selectionRange = { rowMin: row, rowMax: row, colMin: 0, colMax: mc };
			this._selectionAnchor = { row, col: 0 };
		}
	}
	private _onKeydown = (e: KeyboardEvent) => {
		if ((e.ctrlKey || e.metaKey) && e.key === 'f') { this._toggleSearch(); e.preventDefault(); return; }
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

	private _toggleSearch(): void { this._searchVisible = !this._searchVisible; if (this._searchVisible) requestAnimationFrame(() => { const i = this.shadowRoot?.querySelector('.sinp') as HTMLInputElement; i?.focus(); i?.select(); }); else { this._searchMatches = []; this._searchQuery = ''; } }
	private _toggleBody(): void { this._bodyVisible = !this._bodyVisible; this.dispatchEvent(new CustomEvent('visibility-toggle', { detail: { visible: this._bodyVisible }, bubbles: true, composed: true })); }
	private _addSortInline = (): void => {
		const colSel = this.shadowRoot?.querySelector('#sr-add-col') as HTMLSelectElement | null;
		const dirSel = this.shadowRoot?.querySelector('#sr-add-dir') as HTMLSelectElement | null;
		if (!colSel || !dirSel) return;
		const colIdx = colSel.value;
		if (!colIdx) return;
		const desc = dirSel.value === 'desc';
		// Remove existing rule for this column
		const next = this._sorting.filter(s => s.id !== colIdx);
		next.push({ id: colIdx, desc });
		this._sorting = next;
		this._table?.setOptions(p => ({ ...p, state: { ...p.state, sorting: this._sorting } }));
		this._updateVCount();
	};
	private _applySortDialog(): void {
		// If user picked a column in the "Add sort" row but didn't click "+", apply it automatically
		this._addSortInline();
		this._sortDialogOpen = false;
	}
	private _clearSort(): void { this._sorting = []; this._table?.setOptions(p => ({ ...p, state: { ...p.state, sorting: [] } })); this._sortDialogOpen = false; this._updateVCount(); }
	private _rmSort(idx: number): void { this._sorting = this._sorting.filter((_, i) => i !== idx); this._table?.setOptions(p => ({ ...p, state: { ...p.state, sorting: this._sorting } })); this._updateVCount(); }
	private _updSortCol(idx: number, id: string): void { const n = [...this._sorting]; n[idx] = { ...n[idx], id }; this._sorting = n; this._table?.setOptions(p => ({ ...p, state: { ...p.state, sorting: this._sorting } })); this._updateVCount(); }
	private _updSortDir(idx: number, dir: string): void { const n = [...this._sorting]; n[idx] = { ...n[idx], desc: dir === 'desc' }; this._sorting = n; this._table?.setOptions(p => ({ ...p, state: { ...p.state, sorting: this._sorting } })); this._updateVCount(); }
	private _selAll(): void { const mr = (this._table?.getRowModel().rows.length ?? 1) - 1, mc = this.columns.length - 1; this._selectedCell = { row: 0, col: 0 }; this._selectionAnchor = { row: 0, col: 0 }; this._selectionRange = { rowMin: 0, rowMax: mr, colMin: 0, colMax: mc }; }
	private _scrollToCol(ci: number): void {
		const el = this.shadowRoot?.querySelector('.vscroll') as HTMLElement | null;
		if (!el) return;
		const th = el.querySelectorAll('thead th')[ci + 1] as HTMLElement | null; // +1 for row-num
		if (!th) return;
		// Account for the sticky row-number column width so the target column isn't hidden behind it
		const rnHeader = el.querySelector('thead th.rn-h') as HTMLElement | null;
		const stickyWidth = rnHeader ? rnHeader.offsetWidth : 42;
		const thLeft = th.offsetLeft;
		el.scrollLeft = Math.max(0, thLeft - stickyWidth);
	}
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
		if (!this._table) return; const rows = this._table.getRowModel().rows; let text = '';
		if (this._selectionRange) { const { rowMin, rowMax, colMin, colMax } = this._selectionRange; const lines = [this.columns.slice(colMin, colMax + 1).map(c => c.name).join('\t')]; for (let r = rowMin; r <= rowMax; r++) { const row = rows[r]; if (!row) continue; const cells = []; for (let c = colMin; c <= colMax; c++) cells.push(getCellDisplayValue(row.original[c])); lines.push(cells.join('\t')); } text = lines.join('\n'); }
		else if (this._selectedCell) { const row = rows[this._selectedCell.row]; if (row) text = getCellDisplayValue(row.original[this._selectedCell.col]); }
		if (text) try { navigator.clipboard.writeText(text); } catch {}
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

	static styles = css`
		*,*::before,*::after{box-sizing:border-box}
		:host{display:block;min-height:60px;position:relative}
		.dt{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;border:1px solid var(--vscode-panel-border);border-radius:2px}

		/* Header bar */
		.hbar{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;font-size:12px;color:var(--vscode-descriptionForeground);background:var(--vscode-editor-background);flex-shrink:0;gap:8px;border-bottom:1px solid var(--vscode-panel-border)}
		.hinfo{display:flex;align-items:center;gap:6px;flex-shrink:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.et{opacity:.7}
		.tb{display:flex;gap:2px;align-items:center;flex-shrink:0}
		.sep{width:1px;height:14px;background:var(--vscode-panel-border);margin:0 3px}
		.tbtn{display:inline-flex;align-items:center;gap:4px;padding:3px 5px;font-size:11px;border:none;background:transparent;color:var(--vscode-descriptionForeground);border-radius:2px;cursor:pointer;font-family:inherit}
		.tbtn:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}.tbtn.act{color:var(--vscode-foreground);background:var(--vscode-toolbar-activeBackground,var(--vscode-toolbar-hoverBackground))}.tbtn svg{stroke:currentColor;fill:none}

		/* Search bar */
		.sbar{display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);flex-shrink:0}
		.sc{position:relative;display:flex;align-items:center;flex:1;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:2px}
		.sc:focus-within{border-color:var(--vscode-focusBorder)}
		.sc-icon{position:absolute;left:6px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--vscode-input-placeholderForeground);opacity:.7;flex-shrink:0}
		.sinp{flex:1;padding:4px 8px 4px 26px;font-size:12px;font-family:inherit;background:transparent;color:var(--vscode-input-foreground);border:none;outline:none;min-width:0}.sinp::placeholder{color:var(--vscode-input-placeholderForeground)}
		.sc-status{font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap;padding:0 4px;flex-shrink:0;pointer-events:none}
		.sc-mode{width:20px;height:18px;padding:0;border:none;background:transparent;color:var(--vscode-input-foreground);opacity:.7;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;border-radius:2px;font-size:11px;flex-shrink:0}.sc-mode:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground)}.ml{font-family:monospace;font-weight:bold}
		.sc-div{width:1px;height:14px;background:var(--vscode-input-foreground);opacity:.25;flex-shrink:0;margin:0 2px}
		.sc-nav{width:20px;height:18px;padding:0;border:none;background:transparent;color:var(--vscode-input-foreground);opacity:.7;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;border-radius:2px;flex-shrink:0}.sc-nav:hover:not(:disabled){opacity:1;background:var(--vscode-toolbar-hoverBackground)}.sc-nav:disabled{opacity:.35;cursor:default}
		.nb{width:22px;height:22px;padding:0;border:none;background:transparent;color:var(--vscode-foreground);cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:2px}.nb:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground)}.nb:disabled{opacity:.35;cursor:default}

		/* Column jump — searchable dropdown */
		.cj-wrap{flex:1;position:relative;display:flex;flex-direction:column;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:2px}
		.cj-wrap:focus-within{border-color:var(--vscode-focusBorder)}
		.cj-inp{padding:4px 8px;font-size:12px;font-family:inherit;background:transparent;color:var(--vscode-input-foreground);border:none;outline:none}.cj-inp::placeholder{color:var(--vscode-input-placeholderForeground)}
		.cj-list{max-height:150px;overflow-y:auto;border-top:1px solid var(--vscode-panel-border)}
		.cj-item{padding:4px 8px;font-size:12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;outline:none}.cj-item:hover,.cj-item:focus{background:var(--vscode-list-hoverBackground)}
		.cj-empty{padding:4px 8px;font-size:11px;color:var(--vscode-descriptionForeground);opacity:.7}

		/* Scroll container — the focus outline is on .dt instead */
		.vscroll{flex:1 1 0;overflow:auto;min-height:0}
		.dt:focus-within{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
		.vscroll:focus{outline:none}

		/* Single data table matching original resultsTable.js styles */
		.dtable{width:max-content;min-width:100%;border-collapse:collapse;font-size:12px;user-select:none}
		th,td{text-align:left;padding:6px 8px;border-right:1px solid var(--vscode-panel-border);border-bottom:1px solid var(--vscode-panel-border);white-space:nowrap;position:relative;max-width:75ch;overflow:hidden;text-overflow:ellipsis}
		td{background:var(--vscode-editor-background)}
		th{font-weight:600;background:var(--vscode-list-hoverBackground);position:sticky;top:0;z-index:2;cursor:pointer;user-select:none}
		th:hover{background:var(--vscode-list-activeSelectionBackground,var(--vscode-list-hoverBackground))}th.sorted{font-weight:700}
		.thc{display:flex;align-items:center;gap:4px}.thn{flex:1;overflow:hidden;text-overflow:ellipsis;min-width:0}
		.si2{font-size:11px;opacity:.85;flex-shrink:0;line-height:1}.si2 sup{font-size:8px;margin-left:2px}
		.cm-btn{width:20px;height:20px;padding:0;border:none;background:transparent;color:var(--vscode-foreground);cursor:pointer;opacity:.5;display:flex;align-items:center;justify-content:center;border-radius:2px;font-size:11px;flex-shrink:0}
		.cm-btn:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground)}

		/* Row number column: sticky left with double right border (matches original) */
		.rn-h{width:40px;min-width:40px;max-width:40px;text-align:center;padding:6px 2px;cursor:default;position:sticky;left:0;z-index:100;background:var(--vscode-list-hoverBackground);border-right:2px solid var(--vscode-panel-border)}
		.rn{width:40px;min-width:40px;max-width:40px;text-align:center;font-size:12px;opacity:.5;padding:6px 2px;cursor:pointer;position:sticky;left:0;z-index:1;background:var(--vscode-editor-background);border-right:2px solid var(--vscode-panel-border)}
		.rn:hover{background:var(--vscode-list-hoverBackground);opacity:.8}

		/* Object View button */
		.obj-btn{padding:2px 8px;font-size:11px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-button-border,transparent);border-radius:3px;cursor:pointer;font-family:inherit}.obj-btn:hover{background:var(--vscode-button-secondaryHoverBackground)}
		.obj-cell{text-align:center}

		/* Column menu */
		.cm{position:fixed;z-index:10000;background:var(--vscode-menu-background,var(--vscode-editor-background));border:1px solid var(--vscode-menu-border,var(--vscode-panel-border));border-radius:4px;padding:4px 0;min-width:160px;box-shadow:0 4px 12px rgba(0,0,0,.3);transform:translateX(-100%)}
		.cmi{padding:4px 12px;font-size:12px;cursor:pointer;white-space:nowrap}.cmi:hover{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground))}
		.cms{height:1px;background:var(--vscode-menu-separatorBackground,var(--vscode-panel-border));margin:4px 0}

		/* Spacer rows */
		.vspacer td{padding:0;border:0;border-right:0;line-height:0;font-size:0;background:transparent}

		/* Selection (matching original exactly) */
		.sel-row td{background:var(--vscode-list-inactiveSelectionBackground)}
		.sel-row .rn{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);opacity:1}
		.cr{background:var(--vscode-list-activeSelectionBackground)!important;color:var(--vscode-list-activeSelectionForeground)}
		.cf{background:var(--vscode-list-activeSelectionBackground)!important;color:var(--vscode-list-activeSelectionForeground);outline:2px solid var(--vscode-focusBorder);outline-offset:-2px}
		.mh{background:var(--vscode-editor-findMatchHighlightBackground)!important}
		.mc{background:var(--vscode-editor-findMatchBackground)!important;outline:1px solid var(--vscode-editor-findMatchBorder)}

		.empty,.empty-body,.hidden-msg{padding:16px;text-align:center;opacity:.7;font-size:12px}

		/* Sort dialog — matches original kusto-sort-dialog */
		.sd-bg{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center}
		.sd{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:4px;width:520px;max-width:calc(100% - 24px);max-height:80%;display:flex;flex-direction:column;box-shadow:0 4px 20px rgba(0,0,0,.3)}
		.sd-h{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border)}
		.sd-x{flex-shrink:0}
		.sd-b{padding:10px 12px;overflow:auto}
		.sd-f{display:flex;justify-content:flex-end;gap:8px;padding:10px 12px;border-top:1px solid var(--vscode-panel-border)}
		.sd-btn{padding:4px 12px;font-size:12px;font-family:inherit;border-radius:2px;cursor:pointer;border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.sd-btn:hover{background:var(--vscode-button-secondaryHoverBackground)}
		.sd-btn-danger{color:var(--vscode-errorForeground)}
		.sd-e{font-size:12px;color:var(--vscode-descriptionForeground);padding:6px 2px}
		.sr{display:grid;grid-template-columns:26px 28px 1fr 140px;gap:8px;align-items:center;padding:6px 4px;border-radius:4px}
		.sr:hover{background:var(--vscode-list-hoverBackground)}
		.sr-ord{text-align:right;font-size:11px;color:var(--vscode-descriptionForeground)}
		.sr-rm{padding:0;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:1px solid transparent;border-radius:2px;color:var(--vscode-errorForeground);cursor:pointer}.sr-rm:hover{background:var(--vscode-button-secondaryHoverBackground);border-color:var(--vscode-input-border)}
		.sr-col,.sr-dir{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);border-radius:2px;padding:4px 6px;font-size:12px;font-family:inherit}
		.sr-add{display:grid;grid-template-columns:1fr 1fr 140px 32px;gap:8px;align-items:center;padding:8px 4px 4px;border-top:1px solid var(--vscode-panel-border);margin-top:6px}
		.sr-add-label{font-size:11px;color:var(--vscode-descriptionForeground)}
		.sr-add-btn{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-button-border,transparent);border-radius:4px;width:32px;height:28px;cursor:pointer;font-size:16px;line-height:1;padding:0}.sr-add-btn:hover{background:var(--vscode-button-secondaryHoverBackground)}

		/* Compact mode overrides */
		.compact th,.compact td{padding:4px 6px;font-size:11px}.compact .hbar{padding:3px 6px;font-size:11px}
		.compact .rn{font-size:10px;width:32px;min-width:32px;max-width:32px;padding:4px 2px}.compact .rn-h{width:32px;min-width:32px;max-width:32px;padding:4px 2px}
	`;
}
declare global { interface HTMLElementTagNameMap { 'kw-data-table': KwDataTable; } }
