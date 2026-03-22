import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { buildSearchRegex, createDebouncedSearch, navigateMatch, createRegexCache, type SearchMode } from './search-utils.js';
import { getCellDisplayValue, type CellValue } from './kw-data-table.js';

/** Minimal interface the controller needs from its host element. */
export interface SearchHost extends ReactiveControllerHost, HTMLElement {
	getTableRows(): Array<{ original: CellValue[] }>;
	scrollToRow(index: number, opts?: { align?: 'auto' | 'center' }): void;
	setSelectedCell(cell: { row: number; col: number } | null): void;
	clearSelectionRange(): void;
}

/**
 * Manages search state and match computation for `<kw-data-table>`.
 * The `<kw-search-bar>` component handles the UI — this controller
 * manages the search state and match computation.
 */
export class TableSearchController implements ReactiveController {
	host: SearchHost;

	// ── Public state (read by host in render()) ──
	visible = false;
	query = '';
	mode: SearchMode = 'wildcard';
	matches: Array<{ row: number; col: number }> = [];
	currentMatchIndex = 0;

	// ── Private ──
	private _debouncedSearch = createDebouncedSearch(() => this._execSearch());
	private _regexCache = createRegexCache();

	constructor(host: SearchHost) {
		this.host = host;
		host.addController(this);
	}

	hostConnected(): void { /* no-op */ }

	hostDisconnected(): void {
		this._debouncedSearch.cancel();
	}

	// ── Public API ──

	get searchRegex(): RegExp | null {
		return this._regexCache.get(this.query, this.mode).regex;
	}

	toggle(): void {
		this.visible = !this.visible;
		if (!this.visible) {
			this._debouncedSearch.cancel();
			this.matches = [];
			this.query = '';
		}
		this.host.requestUpdate();
	}

	close(): void {
		if (!this.visible) return;
		this.toggle();
	}

	setQuery(value: string): void {
		this.query = value;
		this._debouncedSearch.trigger();
	}

	setMode(mode: SearchMode): void {
		this.mode = mode;
		this._execSearch();
	}

	nextMatch(): void {
		if (!this.matches.length) return;
		this.currentMatchIndex = navigateMatch(this.currentMatchIndex, this.matches.length, 'next');
		this._goToMatch(this.currentMatchIndex);
		this.host.requestUpdate();
	}

	prevMatch(): void {
		if (!this.matches.length) return;
		this.currentMatchIndex = navigateMatch(this.currentMatchIndex, this.matches.length, 'prev');
		this._goToMatch(this.currentMatchIndex);
		this.host.requestUpdate();
	}

	isMatch(r: number, c: number): boolean {
		return this.matches.some(m => m.row === r && m.col === c);
	}

	isCurMatch(r: number, c: number): boolean {
		const m = this.matches[this.currentMatchIndex];
		return !!m && m.row === r && m.col === c;
	}

	/** Reset state when the underlying data changes. */
	reset(): void {
		this.matches = [];
		this.currentMatchIndex = 0;
	}

	// ── Private ──

	private _execSearch(): void {
		const { regex: rx } = this._regexCache.get(this.query, this.mode);
		const rows = this.host.getTableRows();
		if (!rx || !rows.length) { this.matches = []; this.currentMatchIndex = 0; this.host.requestUpdate(); return; }
		const matches: Array<{ row: number; col: number }> = [];
		for (let r = 0; r < rows.length; r++) {
			for (let c = 0; c < rows[r].original.length; c++) {
				const cell = rows[r].original[c];
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
		}
		this.matches = matches;
		this.currentMatchIndex = 0;
		if (matches.length > 0) this._goToMatch(0);
		this.host.requestUpdate();
	}

	private _goToMatch(i: number): void {
		const m = this.matches[i];
		if (!m) return;
		this.host.setSelectedCell(m);
		this.host.clearSelectionRange();
		this.host.scrollToRow(m.row, { align: 'center' });
	}
}
