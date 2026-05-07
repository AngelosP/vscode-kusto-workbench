// Data source switching + column memory — ReactiveController pattern.
// Extracted from kw-chart-section.ts into a Lit ReactiveController
// that manages data source selection and per-source column memory.
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import {
	__kustoGetChartDatasetsInDomOrder,
} from '../core/section-factory.js';
import type { XAxisSettings, YAxisSettings } from '../shared/chart-utils.js';

// ── Host interface ────────────────────────────────────────────────────────────

/** Dataset entry shape. */
export interface DatasetEntry {
	id: string;
	label: string;
	columns: string[];
	rows: unknown[][];
}

/** Column memory snapshot saved per data source. */
export interface ColumnMemoryEntry {
	xColumn: string; yColumns: string[]; legendColumn: string;
	labelColumn: string; valueColumn: string;
	sourceColumn: string; targetColumn: string;
	tooltipColumns: string[]; sortColumn: string;
	wrapperHeight: string;
	xAxisSettings: XAxisSettings; yAxisSettings: YAxisSettings;
}

/** Minimal interface the controller needs from its host element. */
export interface ChartSectionHost extends ReactiveControllerHost, HTMLElement {
	boxId: string;
	// Data source
	getDataSourceId(): string;
	setDataSourceId(id: string): void;
	getDatasets(): DatasetEntry[];
	setDatasets(ds: DatasetEntry[]): void;
	// Column selections
	getXColumn(): string;    setXColumn(v: string): void;
	getYColumns(): string[]; setYColumns(v: string[]): void;
	getLegendColumn(): string; setLegendColumn(v: string): void;
	getLabelColumn(): string;  setLabelColumn(v: string): void;
	getValueColumn(): string;  setValueColumn(v: string): void;
	getTooltipColumns(): string[]; setTooltipColumns(v: string[]): void;
	getSortColumn(): string;   setSortColumn(v: string): void;
	getSourceColumn(): string; setSourceColumn(v: string): void;
	getTargetColumn(): string; setTargetColumn(v: string): void;
	getXAxisSettings(): XAxisSettings; setXAxisSettings(v: XAxisSettings): void;
	getYAxisSettings(): YAxisSettings; setYAxisSettings(v: YAxisSettings): void;
	// Persistence
	schedulePersist(): void;
}

// ── ReactiveController ────────────────────────────────────────────────────────

/**
 * Manages the data-source dropdown, dataset list refresh, column pruning,
 * and per-data-source column memory for a `<kw-chart-section>`.
 */
export class ChartDataSourceController implements ReactiveController {
	host: ChartSectionHost;

	/** Per-data-source column memory: remembers column selections so switching
	 *  away and back restores the previous configuration. */
	private _columnMemory = new Map<string, ColumnMemoryEntry>();

	constructor(host: ChartSectionHost) {
		this.host = host;
		host.addController(this);
	}

	hostConnected(): void { /* no setup needed */ }
	hostDisconnected(): void { /* no cleanup needed */ }

	// ── Data source switching ─────────────────────────────────────────────────

	onDataSourceChanged(e: Event): void {
		const oldId = this.host.getDataSourceId();
		const newId = (e.target as HTMLSelectElement).value;
		// Save current column config + wrapper height for the old data source.
		if (oldId) {
			const wrapper = document.getElementById(this.host.boxId + '_chart_wrapper');
			const h = wrapper?.style.height?.trim() || '';
			this._columnMemory.set(oldId, {
				xColumn: this.host.getXColumn(),
				yColumns: [...this.host.getYColumns()],
				legendColumn: this.host.getLegendColumn(),
				labelColumn: this.host.getLabelColumn(),
				valueColumn: this.host.getValueColumn(),
				tooltipColumns: [...this.host.getTooltipColumns()],
				sortColumn: this.host.getSortColumn(),
				sourceColumn: this.host.getSourceColumn(),
				targetColumn: this.host.getTargetColumn(),
				wrapperHeight: h,
				xAxisSettings: { ...this.host.getXAxisSettings() },
				yAxisSettings: { ...this.host.getYAxisSettings() },
			});
		}
		this.host.setDataSourceId(newId);
		this.refreshDatasets();
		// Try to restore saved column config for the new data source.
		const saved = this._columnMemory.get(newId);
		if (saved) {
			const cols = new Set(this.getColumnNames());
			this.host.setXColumn(saved.xColumn && cols.has(saved.xColumn) ? saved.xColumn : '');
			const restoredY = saved.yColumns.filter(c => cols.has(c));
			this.host.setYColumns(restoredY);
			this.host.setLegendColumn(saved.legendColumn && cols.has(saved.legendColumn) ? saved.legendColumn : '');
			this.host.setLabelColumn(saved.labelColumn && cols.has(saved.labelColumn) ? saved.labelColumn : '');
			this.host.setValueColumn(saved.valueColumn && cols.has(saved.valueColumn) ? saved.valueColumn : '');
			const restoredTooltip = saved.tooltipColumns.filter(c => cols.has(c));
			this.host.setTooltipColumns(restoredTooltip);
			this.host.setSortColumn(saved.sortColumn && cols.has(saved.sortColumn) ? saved.sortColumn : '');
			this.host.setSourceColumn(saved.sourceColumn && cols.has(saved.sourceColumn) ? saved.sourceColumn : '');
			this.host.setTargetColumn(saved.targetColumn && cols.has(saved.targetColumn) ? saved.targetColumn : '');
			if (saved.xAxisSettings) this.host.setXAxisSettings({ ...saved.xAxisSettings });
			if (saved.yAxisSettings) this.host.setYAxisSettings({ ...saved.yAxisSettings });
			// Restore wrapper height.
			if (saved.wrapperHeight) {
				const wrapper = document.getElementById(this.host.boxId + '_chart_wrapper');
				if (wrapper) {
					wrapper.style.height = saved.wrapperHeight;
					wrapper.dataset.kustoUserResized = 'true';
				}
			}
		}
		this.host.schedulePersist();
	}

	// ── Dataset refresh ───────────────────────────────────────────────────────

	/** Refresh the list of available data sources from the DOM. */
	refreshDatasets(): void {
		try {
			const fresh = __kustoGetChartDatasetsInDomOrder() || [];
			if (!this._datasetsEqual(this.host.getDatasets(), fresh)) {
				this.host.setDatasets(fresh);
			}
		} catch (e) { console.error('[kusto]', e); }
		this.pruneStaleColumns();
	}

	/** Shallow compare dataset lists to avoid unnecessary re-renders. */
	private _datasetsEqual(a: DatasetEntry[], b: DatasetEntry[]): boolean {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (a[i].id !== b[i].id || a[i].label !== b[i].label ||
				(a[i].rows?.length ?? 0) !== (b[i].rows?.length ?? 0)) return false;
			const aCols = a[i].columns;
			const bCols = b[i].columns;
			const aLen = aCols?.length ?? 0;
			const bLen = bCols?.length ?? 0;
			if (aLen !== bLen) return false;
			for (let j = 0; j < aLen; j++) {
				if (this._colName(aCols[j]) !== this._colName(bCols[j])) return false;
			}
		}
		return true;
	}

	/** Extract a column name from a string or {name}/{columnName} object. */
	private _colName(c: unknown): string {
		if (typeof c === 'string') return c;
		if (c && typeof c === 'object') return (c as any).name || (c as any).columnName || '';
		return '';
	}

	/** Remove column selections that don't exist in the current dataset. */
	pruneStaleColumns(): void {
		const cols = new Set(this.getColumnNames());
		if (!cols.size) return;
		const prunedY = this.host.getYColumns().filter(c => cols.has(c));
		if (prunedY.length !== this.host.getYColumns().length) this.host.setYColumns(prunedY);
		const prunedTooltip = this.host.getTooltipColumns().filter(c => cols.has(c));
		if (prunedTooltip.length !== this.host.getTooltipColumns().length) this.host.setTooltipColumns(prunedTooltip);
		if (this.host.getXColumn() && !cols.has(this.host.getXColumn())) this.host.setXColumn('');
		if (this.host.getLegendColumn() && !cols.has(this.host.getLegendColumn())) this.host.setLegendColumn('');
		if (this.host.getLabelColumn() && !cols.has(this.host.getLabelColumn())) this.host.setLabelColumn('');
		if (this.host.getValueColumn() && !cols.has(this.host.getValueColumn())) this.host.setValueColumn('');
		if (this.host.getSortColumn() && !cols.has(this.host.getSortColumn())) this.host.setSortColumn('');
		if (this.host.getSourceColumn() && !cols.has(this.host.getSourceColumn())) this.host.setSourceColumn('');
		if (this.host.getTargetColumn() && !cols.has(this.host.getTargetColumn())) this.host.setTargetColumn('');
	}

	/** Get column names from the currently selected dataset. */
	getColumnNames(): string[] {
		const ds = this.host.getDatasets().find(d => d.id === this.host.getDataSourceId());
		if (!ds || !Array.isArray(ds.columns)) return [];
		return ds.columns.map(c => {
			if (typeof c === 'string') return c;
			if (c && typeof c === 'object') {
				return (c as any).name || (c as any).columnName || '';
			}
			return '';
		}).filter(Boolean);
	}
}
