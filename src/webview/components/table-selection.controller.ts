import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type { CellRange, CellValue } from './kw-data-table.js';
import { buildClipboardText, getCellDisplayValue, type DataTableColumn } from './kw-data-table.js';

/** Resolve row/col from a MouseEvent target inside the table body. */
function cellFromEvent(e: MouseEvent): { row: number; col: number } | null {
	const td = (e.target as HTMLElement).closest('td');
	if (!td) return null;
	const tr = td.closest('tr');
	if (!tr) return null;
	const rowIdx = tr.dataset.idx;
	if (rowIdx === undefined) return null;
	const tds = Array.from(tr.querySelectorAll('td'));
	const ci = tds.indexOf(td) - 1; // -1 for row-num td
	if (ci < 0) return null;
	return { row: parseInt(rowIdx, 10), col: ci };
}

/** Minimal interface the controller needs from its host element. */
export interface SelectionHost extends ReactiveControllerHost, HTMLElement {
	columns: DataTableColumn[];
	getTableRows(): Array<{ original: CellValue[] }>;
	getColumnCount(): number;
	scrollToRow(index: number, opts?: { align?: 'auto' | 'center' }): void;
	scrollColumnIntoView(col: number): void;
}

/**
 * Manages cell/range selection, mouse drag selection, keyboard navigation,
 * select-all, and clipboard copy for `<kw-data-table>`.
 */
export class TableSelectionController implements ReactiveController {
	host: SelectionHost;

	// ── Public state (read by host in render()) ──
	selectedCell: { row: number; col: number } | null = null;
	selectionRange: CellRange | null = null;
	rowSelection: Record<string, boolean> = {};

	// ── Private ──
	private _selectionAnchor: { row: number; col: number } | null = null;
	private _isDragging = false;

	/**
	 * The controller whose table the user last interacted with.
	 * Only this instance is allowed to claim copy / select-all events.
	 */
	private static _activeInstance: TableSelectionController | null = null;

	constructor(host: SelectionHost) {
		this.host = host;
		host.addController(this);
	}

	hostConnected(): void {
		document.addEventListener('copy', this._onDocumentCopy, true);
		document.addEventListener('keydown', this._onDocumentKeydown, true);
	}

	hostDisconnected(): void {
		if (TableSelectionController._activeInstance === this) TableSelectionController._activeInstance = null;
		document.removeEventListener('mouseup', this._onMouseUp);
		document.removeEventListener('mousemove', this._onMouseMove);
		document.removeEventListener('copy', this._onDocumentCopy, true);
		document.removeEventListener('keydown', this._onDocumentKeydown, true);
	}

	// ── Public API ──

	/** Mark this table as the one the user is interacting with, clearing any stale selection in the previous table. */
	private _becomeActive(): void {
		const prev = TableSelectionController._activeInstance;
		if (prev && prev !== this) prev.clear();
		TableSelectionController._activeInstance = this;
	}

	clear(): void {
		this.selectedCell = null;
		this.selectionRange = null;
		this._selectionAnchor = null;
		this.host.requestUpdate();
	}

	setSelectedCell(cell: { row: number; col: number } | null): void {
		this.selectedCell = cell;
		this.host.requestUpdate();
	}

	clearSelectionRange(): void {
		this.selectionRange = null;
	}

	selectAll(): void {
		this._becomeActive();
		const rows = this.host.getTableRows();
		const mr = (rows.length || 1) - 1;
		const mc = this.host.getColumnCount() - 1;
		this.selectedCell = { row: 0, col: 0 };
		this._selectionAnchor = { row: 0, col: 0 };
		this.selectionRange = { rowMin: 0, rowMax: mr, colMin: 0, colMax: mc };
		this.host.requestUpdate();
	}

	selectRow(e: MouseEvent, row: number): void {
		this._becomeActive();
		const mc = this.host.getColumnCount() - 1;
		if (e.shiftKey && this._selectionAnchor) {
			this.selectionRange = {
				rowMin: Math.min(this._selectionAnchor.row, row),
				rowMax: Math.max(this._selectionAnchor.row, row),
				colMin: 0, colMax: mc,
			};
			this.selectedCell = { row, col: 0 };
		} else {
			const isSameSingleRow =
				this.selectedCell?.row === row &&
				this.selectedCell?.col === 0 &&
				this.selectionRange?.rowMin === row &&
				this.selectionRange?.rowMax === row &&
				this.selectionRange?.colMin === 0 &&
				this.selectionRange?.colMax === mc;
			if (isSameSingleRow) { this.clear(); return; }
			this.selectedCell = { row, col: 0 };
			this.selectionRange = { rowMin: row, rowMax: row, colMin: 0, colMax: mc };
			this._selectionAnchor = { row, col: 0 };
		}
		this.host.requestUpdate();
	}

	onTableMouseDown(e: MouseEvent): void {
		if (e.button !== 0) return;
		this._becomeActive();
		(this.host.shadowRoot?.querySelector('.vscroll') as HTMLElement | null)?.focus();
		const pos = cellFromEvent(e);
		if (!pos) return;
		if (this.selectedCell?.row === pos.row && this.selectedCell?.col === pos.col && this.selectionRange === null) {
			this.clear();
			e.preventDefault();
			return;
		}
		this._isDragging = true;
		this._selectionAnchor = pos;
		this.selectedCell = pos;
		this.selectionRange = null;
		document.addEventListener('mousemove', this._onMouseMove);
		document.addEventListener('mouseup', this._onMouseUp);
		e.preventDefault();
		this.host.requestUpdate();
	}

	handleKeydown(e: KeyboardEvent): void {
		if ((e.ctrlKey || e.metaKey) && e.key === 'a') { this.selectAll(); e.preventDefault(); return; }
		if (!this.selectedCell) return;
		this._becomeActive();
		const { row, col } = this.selectedCell;
		const rows = this.host.getTableRows();
		const mR = (rows.length || 1) - 1;
		const mC = this.host.getColumnCount() - 1;
		let nr = row, nc = col;
		switch (e.key) {
			case 'ArrowUp': nr = Math.max(0, row - 1); break;
			case 'ArrowDown': nr = Math.min(mR, row + 1); break;
			case 'ArrowLeft': nc = Math.max(0, col - 1); break;
			case 'ArrowRight': nc = Math.min(mC, col + 1); break;
			case 'Home': nc = 0; if (e.ctrlKey) nr = 0; break;
			case 'End': nc = mC; if (e.ctrlKey) nr = mR; break;
			case 'PageUp': nr = Math.max(0, row - 20); break;
			case 'PageDown': nr = Math.min(mR, row + 20); break;
			case 'c': if (e.ctrlKey || e.metaKey) { this.copy(); e.preventDefault(); } return;
			default: return;
		}
		e.preventDefault();
		if (e.shiftKey) {
			if (!this._selectionAnchor) this._selectionAnchor = { row, col };
			this.selectionRange = {
				rowMin: Math.min(this._selectionAnchor.row, nr),
				rowMax: Math.max(this._selectionAnchor.row, nr),
				colMin: Math.min(this._selectionAnchor.col, nc),
				colMax: Math.max(this._selectionAnchor.col, nc),
			};
		} else {
			this.selectionRange = null;
			this._selectionAnchor = { row: nr, col: nc };
		}
		this.selectedCell = { row: nr, col: nc };
		this.host.scrollToRow(nr, { align: 'auto' });
		this.host.scrollColumnIntoView(nc);
		this.host.requestUpdate();
	}

	copy(): void {
		const text = this._buildClipboardText();
		if (!text) return;
		this._writeTextToClipboard(text);
	}

	isSelectionInThisTable(): boolean {
		if (!this.selectedCell && !this.selectionRange) return false;
		// When a modal viewer (object viewer, cell viewer) inside the table's
		// shadow DOM is open, the user is interacting with the viewer — don't
		// claim copy events for the underlying table selection.
		try {
			const sr = this.host.shadowRoot;
			if (sr) {
				const ov = sr.querySelector('kw-object-viewer') as HTMLElement & { open?: boolean } | null;
				if (ov && ov.open) return false;
				const cv = sr.querySelector('kw-cell-viewer') as HTMLElement & { open?: boolean } | null;
				if (cv && cv.open) return false;
			}
		} catch { /* ignore */ }
		const active = document.activeElement as HTMLElement | null;
		if (active && this.host.contains(active)) return true;
		// Focus is on a specific element outside this table — don't claim the event.
		if (active && active !== document.body && active !== document.documentElement) return false;
		return TableSelectionController._activeInstance === this;
	}

	// ── Private ──

	private _onMouseMove = (e: MouseEvent) => {
		if (!this._isDragging || !this._selectionAnchor) return;
		const el = this.host.shadowRoot?.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
		if (!el) return;
		const td = el.closest?.('td');
		if (!td) return;
		const tr = td.closest('tr');
		if (!tr || tr.dataset.idx === undefined) return;
		const tds = Array.from(tr.querySelectorAll('td'));
		const ci = tds.indexOf(td) - 1;
		if (ci < 0) return;
		const row = parseInt(tr.dataset.idx, 10);
		this.selectedCell = { row, col: ci };
		this.selectionRange = {
			rowMin: Math.min(this._selectionAnchor.row, row),
			rowMax: Math.max(this._selectionAnchor.row, row),
			colMin: Math.min(this._selectionAnchor.col, ci),
			colMax: Math.max(this._selectionAnchor.col, ci),
		};
		this.host.requestUpdate();
	};

	private _onMouseUp = () => {
		this._isDragging = false;
		document.removeEventListener('mousemove', this._onMouseMove);
		document.removeEventListener('mouseup', this._onMouseUp);
	};

	private _onDocumentCopy = (e: ClipboardEvent): void => {
		if (!this.isSelectionInThisTable()) return;
		const text = this._buildClipboardText();
		if (!text) return;
		try {
			e.preventDefault();
			e.stopPropagation();
			if (typeof (e as any).stopImmediatePropagation === 'function') (e as any).stopImmediatePropagation();
			if (e.clipboardData) { e.clipboardData.setData('text/plain', text); return; }
		} catch (err) { console.error('[kusto]', err); }
		this._writeTextToClipboard(text);
	};

	private _onDocumentKeydown = (e: KeyboardEvent): void => {
		if (!(e.ctrlKey || e.metaKey)) return;
		const key = String(e.key).toLowerCase();
		const active = document.activeElement as HTMLElement | null;
		const target = (e.target as HTMLElement | null);
		const activeInHost = !!(active && this.host.contains(active));
		const targetInHost = !!(target && this.host.contains(target));

		if (key === 'a') {
			if (!activeInHost && !targetInHost) return;
			// Don't hijack Ctrl+A while user is editing text inside table chrome.
			const editable = (active ?? target);
			if (editable && (
				editable instanceof HTMLInputElement ||
				editable instanceof HTMLTextAreaElement ||
				editable.isContentEditable
			)) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			if (typeof (e as any).stopImmediatePropagation === 'function') (e as any).stopImmediatePropagation();
			this.selectAll();
			return;
		}

		if (key !== 'c') return;
		if (!this.isSelectionInThisTable()) return;
		e.preventDefault();
		e.stopPropagation();
		if (typeof (e as any).stopImmediatePropagation === 'function') (e as any).stopImmediatePropagation();
		this.copy();
	};

	private _buildClipboardText(): string {
		const rows = this.host.getTableRows().map(r => r.original);
		return buildClipboardText(this.host.columns, rows, this.selectionRange, this.selectedCell);
	}

	private _writeTextToClipboard(text: string): void {
		const value = text == null ? '' : String(text); // eslint-disable-line eqeqeq
		try {
			if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
				navigator.clipboard.writeText(value).catch(() => { /* ignore */ });
				return;
			}
		} catch (e) { console.error('[kusto]', e); }
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
		} catch (e) { console.error('[kusto]', e); }
	}
}
