import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { DataTableColumn, CellValue } from '../components/kw-data-table.js';
import '../components/kw-data-table.js';

// ── Pure diff-model helpers (ported from legacy diffView.ts) ──

const safeString = (v: unknown): string => {
	try {
		if (v === null) return 'null';
		if (v === undefined) return 'undefined';
		if (typeof v === 'string') return v;
		return String(v);
	} catch { return '[unprintable]'; }
};

const _win = window;

const normalizeCell = (cell: unknown): unknown[] => {
	try {
		if (typeof _win.__kustoNormalizeCellForComparison === 'function') {
			return _win.__kustoNormalizeCellForComparison(cell);
		}
	} catch (e) { console.error('[kusto]', e); }
	if (cell === null || cell === undefined) return ['n', null];
	if (typeof cell === 'number') return ['num', isFinite(cell) ? cell : String(cell)];
	if (typeof cell === 'boolean') return ['bool', cell ? 1 : 0];
	if (cell instanceof Date) { const ms = cell.getTime(); return ['date', isFinite(ms) ? ms : String(cell)]; }
	if (typeof cell === 'object') {
		const obj = cell as Record<string, unknown>;
		if ('full' in obj && obj.full !== undefined && obj.full !== null) return normalizeCell(obj.full);
		if ('display' in obj && obj.display !== undefined && obj.display !== null) return normalizeCell(obj.display);
		return ['obj', JSON.stringify(cell)];
	}
	return ['str', String(cell)];
};

const formatCellForDisplay = (cell: unknown): string => {
	if (cell === null) return 'null';
	if (cell === undefined) return '';
	if (typeof cell === 'object') {
		const obj = cell as Record<string, unknown>;
		if (obj.isObject) { try { return JSON.stringify(obj.full !== undefined ? obj.full : cell, null, 0); } catch { return '[object]'; } }
		if ('full' in obj && obj.full !== undefined && obj.full !== null) return formatCellForDisplay(obj.full);
		if ('display' in obj && obj.display !== undefined && obj.display !== null) return formatCellForDisplay(obj.display);
		try { return JSON.stringify(cell); } catch { return '[object]'; }
	}
	return String(cell);
};

const getColumns = (state: any): string[] => {
	try {
		return (Array.isArray(state?.columns) ? state.columns : []).map((c: unknown) => {
			// Columns can be plain strings or {name, type} objects (Kusto column metadata).
			if (c && typeof c === 'object' && 'name' in (c as any)) return safeString((c as any).name);
			return safeString(c);
		});
	} catch { return []; }
};

const getRows = (state: any): unknown[][] => {
	try { return Array.isArray(state?.rows) ? state.rows : []; } catch { return []; }
};

const buildColumnMappingByName = (state: any, canonicalNormalizedNames: string[]): number[] => {
	try {
		if (typeof (_win.__kustoBuildNameBasedColumnMapping) === 'function') {
			return _win.__kustoBuildNameBasedColumnMapping(state, canonicalNormalizedNames);
		}
	} catch (e) { console.error('[kusto]', e); }
	const cols = getColumns(state);
	const used = new Set<number>();
	const normName = (n: unknown) => {
		try { if (typeof (_win.__kustoNormalizeColumnNameForComparison) === 'function') return _win.__kustoNormalizeColumnNameForComparison!(n); } catch (e) { console.error('[kusto]', e); }
		return safeString(n).trim().toLowerCase();
	};
	const normalized = cols.map(normName);
	return canonicalNormalizedNames.map(name => {
		for (let i = 0; i < normalized.length; i++) {
			if (!used.has(i) && normalized[i] === name) { used.add(i); return i; }
		}
		return -1;
	});
};

interface CanonicalColumn { key: string; label: string; aIndex: number; bIndex: number; aName: string; bName: string; }

const buildCanonicalColumnsSorted = (aState: any, bState: any): { columns: CanonicalColumn[] } => {
	const aCols = getColumns(aState);
	const bCols = getColumns(bState);
	const normName = (n: unknown) => {
		try { if (typeof (_win.__kustoNormalizeColumnNameForComparison) === 'function') return _win.__kustoNormalizeColumnNameForComparison!(n); } catch (e) { console.error('[kusto]', e); }
		return safeString(n).trim().toLowerCase();
	};
	const aNorm = aCols.map(normName);
	const bNorm = bCols.map(normName);

	const labelByBase = new Map<string, string>();
	for (let i = 0; i < aCols.length; i++) { const b = aNorm[i]; if (!labelByBase.has(b)) labelByBase.set(b, safeString(aCols[i])); }
	for (let i = 0; i < bCols.length; i++) { const b = bNorm[i]; if (!labelByBase.has(b)) labelByBase.set(b, safeString(bCols[i])); }

	const countA = new Map<string, number>();
	for (const b of aNorm) countA.set(b, (countA.get(b) || 0) + 1);
	const countB = new Map<string, number>();
	for (const b of bNorm) countB.set(b, (countB.get(b) || 0) + 1);

	const baseNames = Array.from(new Set([...countA.keys(), ...countB.keys()]));
	const maxCount = new Map<string, number>();
	for (const b of baseNames) maxCount.set(b, Math.max(countA.get(b) || 0, countB.get(b) || 0));

	const canonical: { base: string; occ: number }[] = [];
	for (const b of baseNames) { for (let o = 0; o < (maxCount.get(b) || 0); o++) canonical.push({ base: b, occ: o }); }
	canonical.sort((x, y) => {
		const lx = safeString(labelByBase.get(x.base) || x.base).toLowerCase();
		const ly = safeString(labelByBase.get(y.base) || y.base).toLowerCase();
		if (lx < ly) return -1; if (lx > ly) return 1;
		if (x.base < y.base) return -1; if (x.base > y.base) return 1;
		return x.occ - y.occ;
	});

	const canonBases = canonical.map(c => c.base);
	const aMap = buildColumnMappingByName(aState, canonBases);
	const bMap = buildColumnMappingByName(bState, canonBases);

	const columns: CanonicalColumn[] = canonical.map((c, idx) => {
		const aIdx = aMap[idx] ?? -1, bIdx = bMap[idx] ?? -1;
		const aName = aIdx >= 0 && aIdx < aCols.length ? aCols[aIdx] : '';
		const bName = bIdx >= 0 && bIdx < bCols.length ? bCols[bIdx] : '';
		const baseLabel = safeString(labelByBase.get(c.base) || aName || bName || c.base || ('col_' + (idx + 1)));
		const needsSuffix = (maxCount.get(c.base) || 0) > 1;
		const label = needsSuffix ? (baseLabel + ' #' + (c.occ + 1)) : baseLabel;
		const key = (c.base || ('col_' + (idx + 1))) + '#' + (c.occ + 1);
		return { key, label, aIndex: aIdx, bIndex: bIdx, aName, bName };
	});

	return { columns };
};

interface RowKeyResult { key: string; displayValues: string[]; }

const buildRowKeyAndDisplayValues = (row: unknown[], columnSideIndices: number[]): RowKeyResult => {
	const r = Array.isArray(row) ? row : [];
	const keyParts: unknown[] = [];
	const displayValues: string[] = [];
	for (const idx of columnSideIndices) {
		if (typeof idx !== 'number' || idx < 0) { keyParts.push(['missing-col', 1]); displayValues.push(''); continue; }
		const cell = idx < r.length ? r[idx] : undefined;
		keyParts.push(normalizeCell(cell));
		displayValues.push(formatCellForDisplay(cell));
	}
	let key = '';
	try { key = JSON.stringify(keyParts); } catch { key = String(keyParts); }
	return { key, displayValues };
};

interface Partition { aRowIndex: number; bRowIndex: number; values: string[]; }
interface OnlyRow { aRowIndex?: number; bRowIndex?: number; values: string[]; }
interface Partitions { common: Partition[]; onlyA: OnlyRow[]; onlyB: OnlyRow[]; }

const buildPartitionedRows = (aState: any, bState: any, columns: CanonicalColumn[]): Partitions => {
	const aRows = getRows(aState), bRows = getRows(bState);
	const aSide = columns.map(c => c.aIndex), bSide = columns.map(c => c.bIndex);
	const aMap = new Map<string, number[]>(), bMap = new Map<string, number[]>();
	const aData: RowKeyResult[] = [], bData: RowKeyResult[] = [];

	for (let i = 0; i < aRows.length; i++) { const rd = buildRowKeyAndDisplayValues(aRows[i] as unknown[], aSide); aData.push(rd); if (!aMap.has(rd.key)) aMap.set(rd.key, []); aMap.get(rd.key)!.push(i); }
	for (let i = 0; i < bRows.length; i++) { const rd = buildRowKeyAndDisplayValues(bRows[i] as unknown[], bSide); bData.push(rd); if (!bMap.has(rd.key)) bMap.set(rd.key, []); bMap.get(rd.key)!.push(i); }

	const allKeys = Array.from(new Set([...aMap.keys(), ...bMap.keys()])).sort();
	const common: Partition[] = [], onlyA: OnlyRow[] = [], onlyB: OnlyRow[] = [];

	for (const key of allKeys) {
		const aList = aMap.get(key) || [], bList = bMap.get(key) || [];
		const shared = Math.min(aList.length, bList.length);
		for (let i = 0; i < shared; i++) common.push({ aRowIndex: aList[i], bRowIndex: bList[i], values: aData[aList[i]].displayValues });
		for (let i = shared; i < aList.length; i++) onlyA.push({ aRowIndex: aList[i], values: aData[aList[i]].displayValues });
		for (let i = shared; i < bList.length; i++) onlyB.push({ bRowIndex: bList[i], values: bData[bList[i]].displayValues });
	}
	return { common, onlyA, onlyB };
};

interface DiffModel {
	aLabel: string; bLabel: string; columns: CanonicalColumn[];
	partitions: Partitions;
	columnDiff: { onlyInA: string[]; onlyInB: string[] };
	_aState: any; _bState: any;
}

const buildDiffModelFromStates = (aState: any, bState: any, labels: any): DiffModel => {
	const { columns } = buildCanonicalColumnsSorted(aState, bState);
	const partitions = buildPartitionedRows(aState, bState, columns);

	const aCols = getColumns(aState), bCols = getColumns(bState);
	const normName = (n: unknown) => {
		try { if (typeof (_win.__kustoNormalizeColumnNameForComparison) === 'function') return _win.__kustoNormalizeColumnNameForComparison!(n); } catch (e) { console.error('[kusto]', e); }
		return safeString(n).trim().toLowerCase();
	};
	const aSet = new Set(aCols.map(normName)), bSet = new Set(bCols.map(normName));

	return {
		aLabel: labels?.aLabel ? String(labels.aLabel) : 'A',
		bLabel: labels?.bLabel ? String(labels.bLabel) : 'B',
		columns, partitions,
		columnDiff: { onlyInA: aCols.filter((c: any) => !bSet.has(normName(c))), onlyInB: bCols.filter((c: any) => !aSet.has(normName(c))) },
		_aState: aState, _bState: bState
	};
};

const getCellFromState = (state: any, rowIndex: number, colIndex: number): unknown => {
	try {
		const rows = getRows(state);
		if (rowIndex < 0 || rowIndex >= rows.length) return undefined;
		const row = rows[rowIndex];
		if (!Array.isArray(row) || colIndex < 0) return undefined;
		return row[colIndex];
	} catch { return undefined; }
};

const buildInnerJoinResult = (model: DiffModel, joinColumnKey: string): { columns: string[]; rows: unknown[][] } => {
	if (!model) return { columns: [], rows: [] };
	const columns = model.columns;
	const onlyA = model.partitions.onlyA;
	const onlyB = model.partitions.onlyB;

	const selected = columns.find(c => c.key === joinColumnKey);
	if (!selected) return { columns: [], rows: [] };
	const joinIdx = columns.indexOf(selected);
	if (joinIdx < 0 || selected.aIndex < 0 || selected.bIndex < 0) return { columns: [], rows: [] };

	const aByKey = new Map<string, { display: string; rows: OnlyRow[] }>();
	for (const r of onlyA) {
		if (r.aRowIndex === undefined || r.aRowIndex < 0) continue;
		const cell = getCellFromState(model._aState, r.aRowIndex, selected.aIndex);
		if (cell === undefined) continue;
		let key = ''; try { key = JSON.stringify(normalizeCell(cell)); } catch { key = String(cell); }
		if (!aByKey.has(key)) aByKey.set(key, { display: formatCellForDisplay(cell), rows: [] });
		aByKey.get(key)!.rows.push(r);
	}

	const bByKey = new Map<string, { display: string; rows: OnlyRow[] }>();
	for (const r of onlyB) {
		if (r.bRowIndex === undefined || r.bRowIndex < 0) continue;
		const cell = getCellFromState(model._bState, r.bRowIndex, selected.bIndex);
		if (cell === undefined) continue;
		let key = ''; try { key = JSON.stringify(normalizeCell(cell)); } catch { key = String(cell); }
		if (!bByKey.has(key)) bByKey.set(key, { display: formatCellForDisplay(cell), rows: [] });
		bByKey.get(key)!.rows.push(r);
	}

	const outRows: unknown[][] = [];
	const keys = Array.from(new Set([...aByKey.keys(), ...bByKey.keys()])).sort();
	for (const key of keys) {
		const aGroup = aByKey.get(key), bGroup = bByKey.get(key);
		if (!aGroup || !bGroup) continue;
		const joinDisplay = aGroup.display || bGroup.display || '';
		for (const aRow of aGroup.rows) {
			for (const bRow of bGroup.rows) {
				const aVals = aRow.values || [], bVals = bRow.values || [];
				outRows.push([joinDisplay, ...aVals.filter((_, i) => i !== joinIdx), ...bVals.filter((_, i) => i !== joinIdx)]);
			}
		}
	}

	const colLabels = columns.map(c => c.label);
	const aColLabels = colLabels.filter((_, i) => i !== joinIdx).map(n => model.aLabel + '.' + n);
	const bColLabels = colLabels.filter((_, i) => i !== joinIdx).map(n => model.bLabel + '.' + n);

	return { columns: [selected.label, ...aColLabels, ...bColLabels], rows: outRows };
};

const getBoxLabel = (boxId: string): string => {
	try {
		// Try Lit element's getName() first (shadow DOM — getElementById can't reach the input).
		const el = document.getElementById(boxId) as any;
		if (el && typeof el.getName === 'function') {
			const n = String(el.getName() || '').trim();
			if (n) return n;
		}
		// Legacy fallback: light-DOM input.
		const nameEl = document.getElementById(boxId + '_name');
		const name = nameEl ? String((nameEl as HTMLInputElement).value || '').trim() : '';
		return name || boxId || 'Dataset';
	} catch { return boxId || 'Dataset'; }
};

// ──────────────────────────────────────────────────────────
// Lit Component
// ──────────────────────────────────────────────────────────

@customElement('kw-diff-view')
export class KwDiffView extends LitElement {
	@state() private _visible = false;
	@state() private _title = 'Diff';
	@state() private _model: DiffModel | null = null;
	@state() private _joinColumnKey = '';

	// ── Public API (called from window bridges) ──

	open(args: { aBoxId: string; bBoxId: string; aLabel?: string; bLabel?: string }): void {
		const aBoxId = String(args?.aBoxId || '');
		const bBoxId = String(args?.bBoxId || '');
		if (!aBoxId || !bBoxId) return;

		let aState: any = null, bState: any = null;
		try {
			if (typeof (_win.__kustoGetResultsState) === 'function') {
				aState = _win.__kustoGetResultsState!(aBoxId);
				bState = _win.__kustoGetResultsState!(bBoxId);
			}
		} catch (e) { console.error('[kusto]', e); }

		if (!aState || !bState) {
			try {
				if (_win.vscode && typeof _win.vscode?.postMessage === 'function') {
					_win.vscode?.postMessage({ type: 'showInfo', message: 'No results available to diff yet. Run both queries first.' });
				}
			} catch (e) { console.error('[kusto]', e); }
			return;
		}

		const aLabel = args?.aLabel || getBoxLabel(aBoxId);
		const bLabel = args?.bLabel || getBoxLabel(bBoxId);

		this._model = buildDiffModelFromStates(aState, bState, { aLabel, bLabel });
		this._title = 'Diff: ' + aLabel + ' vs ' + bLabel;
		this._joinColumnKey = this._model.columns.length > 0 ? this._model.columns[0].key : '';
		this._visible = true;
	}

	close(): void {
		this._visible = false;
	}

	get isVisible(): boolean {
		return this._visible;
	}

	// ── Styles ──

	static override styles = css`
		:host { display: contents; }
		.backdrop {
			display: none; position: fixed; inset: 0;
			background: rgba(0,0,0,0.6); z-index: 10000;
			align-items: center; justify-content: center;
		}
		.backdrop.visible { display: flex; }
		.content {
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			width: 92%; max-width: 1400px; max-height: 86vh;
			display: flex; flex-direction: column;
			box-shadow: 0 4px 20px rgba(0,0,0,0.3);
		}
		.header {
			padding: 10px 12px;
			border-bottom: 1px solid var(--vscode-panel-border);
			display: flex; gap: 12px; align-items: center;
			background: var(--vscode-editorGroupHeader-tabsBackground);
		}
		.header h3 { margin: 0; font-size: 13px; font-weight: 600; white-space: nowrap; }
		.close-btn {
			margin-left: auto;
			background: transparent; border: 1px solid transparent;
			color: var(--vscode-foreground); cursor: pointer;
			width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
			border-radius: 4px; padding: 0;
		}
		.close-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
		.body {
			flex: 0 1 auto; overflow: auto; padding: 10px; min-height: 0;
		}
		.diff-section { margin-bottom: 14px; }
		/* kw-data-table uses height:100% internally; give it a concrete height
		   so the virtual scroller has room. Compute per-table in _tableHeight(). */
		.diff-section kw-data-table { display: block; }
		.diff-column-diff-section {
			background: var(--vscode-editorWidget-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px; padding: 12px;
		}
		.diff-section-header {
			font-weight: 600; font-size: 13px; margin-bottom: 8px; color: var(--vscode-foreground);
		}
		.diff-column-list { margin: 6px 0; font-size: 12px; line-height: 1.6; }
		.diff-column-list-label { color: var(--vscode-descriptionForeground); margin-right: 6px; }
		.diff-column-only-a .diff-column-list-label { color: var(--vscode-charts-red, #f48771); }
		.diff-column-only-b .diff-column-list-label { color: var(--vscode-charts-yellow, #cca700); }
		.diff-column-name {
			background: var(--vscode-textCodeBlock-background);
			padding: 2px 6px; border-radius: 3px;
			font-family: var(--vscode-editor-font-family); font-size: 11px;
		}
		.join-controls {
			display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 8px;
		}
		.join-label {
			display: inline-flex; gap: 6px; align-items: center;
			font-size: 12px; color: var(--vscode-foreground); user-select: none;
		}
		.join-select {
			background-color: var(--vscode-dropdown-background);
			color: var(--vscode-dropdown-foreground);
			border: 1px solid var(--vscode-dropdown-border);
			border-radius: 0; padding: 4px 6px; font-size: 12px;
		}
		.table-label {
			font-weight: 600; font-size: 12px; color: var(--vscode-foreground);
			margin-bottom: 4px;
		}
	`;

	// ── Render ──

	override render() {
		return html`
		<div class="backdrop ${this._visible ? 'visible' : ''}" @click=${this._onBackdropClick}>
			<div class="content" @click=${(e: Event) => e.stopPropagation()}>
				<div class="header">
					<h3>${this._title}</h3>
					<button class="close-btn" type="button" title="Close" aria-label="Close" @click=${this.close}>
						<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">
							<path d="M4 4l8 8" /><path d="M12 4L4 12" />
						</svg>
					</button>
				</div>
				<div class="body">
					${this._model ? this._renderBody() : nothing}
				</div>
			</div>
		</div>`;
	}

	private _renderBody() {
		const m = this._model!;
		const p = m.partitions;

		// Compute per-table height: header(~34) + rows(~27 each) + toolbar(~30) + padding
		const tableH = (rows: number) => {
			if (rows <= 0) return '120px';  // header + toolbar + "No matching rows" text
			const capped = Math.min(rows, 10);
			return (34 + 30 + capped * 27 + 10) + 'px';
		};
		const canonLabels = m.columns.map(c => c.label);
		const colDiff = m.columnDiff;
		const hasColDiff = colDiff.onlyInA.length > 0 || colDiff.onlyInB.length > 0;

		// Common rows
		const commonCols: DataTableColumn[] = canonLabels.map(n => ({ name: n }));
		const commonRows: CellValue[][] = p.common.map(r => r.values as CellValue[]);

		// Only-A rows (with Row # prepended)
		const onlyACols: DataTableColumn[] = [{ name: 'Row' }, ...commonCols];
		const onlyARows: CellValue[][] = p.onlyA.map(r => ['Row #' + ((r.aRowIndex ?? 0) + 1), ...r.values] as CellValue[]);

		// Only-B rows
		const onlyBCols: DataTableColumn[] = [{ name: 'Row' }, ...commonCols];
		const onlyBRows: CellValue[][] = p.onlyB.map(r => ['Row #' + ((r.bRowIndex ?? 0) + 1), ...r.values] as CellValue[]);

		// Inner join
		const join = buildInnerJoinResult(m, this._joinColumnKey || (m.columns[0]?.key ?? ''));
		const joinCols: DataTableColumn[] = join.columns.map(n => ({ name: n }));
		const joinRows: CellValue[][] = join.rows as CellValue[][];

		return html`
			${hasColDiff ? html`
			<div class="diff-section">
				<div class="diff-column-diff-section">
					<div class="diff-section-header">Column Differences</div>
					${colDiff.onlyInA.length > 0 ? html`
					<div class="diff-column-list diff-column-only-a">
						<span class="diff-column-list-label">Missing in ${m.bLabel}:</span>
						${colDiff.onlyInA.map(c => html`<code class="diff-column-name">${c}</code> `)}
					</div>` : nothing}
					${colDiff.onlyInB.length > 0 ? html`
					<div class="diff-column-list diff-column-only-b">
						<span class="diff-column-list-label">Extra in ${m.bLabel}:</span>
						${colDiff.onlyInB.map(c => html`<code class="diff-column-name">${c}</code> `)}
					</div>` : nothing}
				</div>
			</div>` : nothing}

			<div class="diff-section">
				<kw-data-table style="height:${tableH(commonRows.length)}"
					.columns=${commonCols}
					.rows=${commonRows}
					.options=${{ label: 'Rows common to both', compact: true, hideTopBorder: true }}
				></kw-data-table>
			</div>

			<div class="diff-section">
				<kw-data-table style="height:${tableH(onlyARows.length)}"
					.columns=${onlyACols}
					.rows=${onlyARows}
					.options=${{ label: 'Rows only in ' + m.aLabel, compact: true, hideTopBorder: true }}
				></kw-data-table>
			</div>

			<div class="diff-section">
				<kw-data-table style="height:${tableH(onlyBRows.length)}"
					.columns=${onlyBCols}
					.rows=${onlyBRows}
					.options=${{ label: 'Rows only in ' + m.bLabel, compact: true, hideTopBorder: true }}
				></kw-data-table>
			</div>

			<div class="diff-section">
				<div class="join-controls">
					<label class="join-label" for="diffJoinCol">Join column</label>
					<select id="diffJoinCol" class="join-select" @change=${this._onJoinColumnChange}>
						${m.columns.map(c => html`<option value=${c.key} ?selected=${c.key === this._joinColumnKey}>${c.label}</option>`)}
					</select>
				</div>
				<kw-data-table style="height:${tableH(joinRows.length)}"
					.columns=${joinCols}
					.rows=${joinRows}
					.options=${{ label: 'Inner join: only in ' + m.aLabel + ' ⨝ only in ' + m.bLabel, compact: true, hideTopBorder: true }}
				></kw-data-table>
			</div>
		`;
	}

	// ── Event handlers ──

	private _onBackdropClick(): void {
		this.close();
	}

	private _onJoinColumnChange(e: Event): void {
		this._joinColumnKey = (e.target as HTMLSelectElement).value;
	}
}

// ── Window bridges (backward compat) ──

window.closeDiffView = function () {
	try {
		const el = document.querySelector('kw-diff-view') as KwDiffView | null;
		if (el) { el.close(); return; }
		// Legacy fallback
		const modal = document.getElementById('diffViewModal');
		if (modal?.classList) modal.classList.remove('visible');
	} catch (e) { console.error('[kusto]', e); }
};

window.openDiffViewModal = function (args: any) {
	try {
		const el = document.querySelector('kw-diff-view') as KwDiffView | null;
		if (el) { el.open(args); return; }
	} catch (e) { console.error('[kusto]', e); }
};

// Expose the model builder for queryBoxes-execution.ts (counts matching/unmatching rows)
_win.__kustoDiffView = _win.__kustoDiffView || {} as typeof _win.__kustoDiffView;
_win.__kustoDiffView.buildModelFromResultsStates = buildDiffModelFromStates;
_win.__kustoDiffView.render = function () { /* no-op — Lit component handles rendering */ };

declare global {
	interface HTMLElementTagNameMap {
		'kw-diff-view': KwDiffView;
	}
}
