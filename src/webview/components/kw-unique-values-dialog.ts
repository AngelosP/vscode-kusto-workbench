import { LitElement, html, nothing } from 'lit';
import { styles } from './kw-unique-values-dialog.styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';
import { osStyles } from '../shared/os-styles.js';
import { OverlayScrollbarsController } from './overlay-scrollbars.controller.js';
import { customElement, property, state } from 'lit/decorators.js';
import { pushDismissable, removeDismissable } from './dismiss-stack.js';
import { ensureEchartsLoaded } from '../shared/lazy-vendor.js';
import { isDarkTheme } from '../monaco/theme.js';
import { getCellDisplayValue, type DataTableColumn, type CellValue } from './kw-data-table.js';

export type UniqueValuesMode = 'unique-values' | 'unique-count';

const EMPTY_LABEL = '(empty)';
const MAX_PIE_SLICES = 50;

@customElement('kw-unique-values-dialog')
export class KwUniqueValuesDialog extends LitElement {
	private _osCtrl = new OverlayScrollbarsController(this);

	static override styles = [...osStyles, scrollbarSheet, styles];

	@property({ type: Array }) columns: DataTableColumn[] = [];
	@property({ type: Array }) rows: CellValue[][] = [];
	@property({ type: Number }) colIndex = 0;
	@property({ type: String }) mode: UniqueValuesMode = 'unique-values';

	@state() private _open = false;
	@state() private _labelDensity = 3;
	@state() private _groupByColIndex = -1;

	private _chartInstance: any = null;
	private _dismissCb = (): void => { this.hide(); };
	private _cachedAgg: Array<[string, number]> | null = null;
	private _chartInitRetries = 0;

	// ── Public API ────────────────────────────────────────────────────────

	show(): void {
		this._open = true;
		this._cachedAgg = null;
		this._chartInitRetries = 0;
		this._labelDensity = 3;
		if (this.mode === 'unique-count') {
			const first = this.columns.findIndex((_, i) => i !== this.colIndex);
			this._groupByColIndex = first >= 0 ? first : 0;
		}
		pushDismissable(this._dismissCb);
		this.updateComplete.then(() => this._initChart());
	}

	hide(): void {
		this._open = false;
		this._cachedAgg = null;
		this._disposeChart();
		removeDismissable(this._dismissCb);
		this.dispatchEvent(new CustomEvent('unique-values-close', { bubbles: true, composed: true }));
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this._disposeChart();
		removeDismissable(this._dismissCb);
	}

	// ── Aggregation ───────────────────────────────────────────────────────

	private _aggregate(): Array<[string, number]> {
		if (this._cachedAgg) return this._cachedAgg;
		if (this.mode === 'unique-count') {
			this._cachedAgg = this._aggregateUniqueCount();
		} else {
			this._cachedAgg = this._aggregateUniqueValues();
		}
		return this._cachedAgg;
	}

	private _aggregateUniqueValues(): Array<[string, number]> {
		const ci = this.colIndex;
		const counts = new Map<string, number>();
		for (const row of this.rows) {
			const raw = row[ci];
			const key = getCellDisplayValue(raw) || EMPTY_LABEL;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return [...counts.entries()].sort((a, b) => b[1] - a[1]);
	}

	private _aggregateUniqueCount(): Array<[string, number]> {
		const gi = this._groupByColIndex;
		const ci = this.colIndex;
		const groups = new Map<string, Set<string>>();
		for (const row of this.rows) {
			const groupKey = getCellDisplayValue(row[gi]) || EMPTY_LABEL;
			const valKey = getCellDisplayValue(row[ci]) || EMPTY_LABEL;
			let set = groups.get(groupKey);
			if (!set) { set = new Set(); groups.set(groupKey, set); }
			set.add(valKey);
		}
		return [...groups.entries()]
			.map(([key, vals]) => [key, vals.size] as [string, number])
			.sort((a, b) => b[1] - a[1]);
	}

	// ── ECharts ───────────────────────────────────────────────────────────

	private async _initChart(): Promise<void> {
		try { await ensureEchartsLoaded(); } catch { return; }
		const w = window as any;
		if (!w.echarts) return;

		// Wait for the canvas to have dimensions
		await this.updateComplete;
		const canvas = this.shadowRoot?.querySelector('.chart-container') as HTMLElement | null;
		if (!canvas) return;
		if (!canvas.clientWidth || !canvas.clientHeight) {
			if (++this._chartInitRetries < 10) requestAnimationFrame(() => this._initChart());
			return;
		}

		this._disposeChart();
		const themeName = isDarkTheme() ? 'dark' : undefined;
		this._chartInstance = w.echarts.init(canvas, themeName);

		const agg = this._aggregate();
		const pieData = agg.length <= MAX_PIE_SLICES
			? agg.map(([name, value]) => ({ name, value }))
			: [
				...agg.slice(0, MAX_PIE_SLICES).map(([name, value]) => ({ name, value })),
				{ name: 'Other', value: agg.slice(MAX_PIE_SLICES).reduce((s, [, v]) => s + v, 0) },
			];

		this._chartInstance.setOption({
			backgroundColor: 'transparent',
			tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
			series: [{
				type: 'pie', radius: ['30%', '70%'],
				data: pieData,
				label: { fontSize: 11, formatter: '{b}: {d}%' },
				labelLine: { show: true },
				minShowLabelAngle: this._labelMinAngle(),
				emphasis: { itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0,0,0,0.5)' } },
			}],
		});
	}

	private _disposeChart(): void {
		try { this._chartInstance?.dispose(); } catch { /* ignore */ }
		this._chartInstance = null;
	}

	private _labelMinAngle(): number {
		// density 1 = fewest labels (minAngle 25), density 5 = all labels (minAngle 0)
		return [25, 12, 5, 2, 0][this._labelDensity - 1] ?? 5;
	}

	private _onDensityChange(e: Event): void {
		this._labelDensity = Number((e.target as HTMLInputElement).value);
		if (!this._chartInstance) return;
		this._chartInstance.setOption({
			series: [{ minShowLabelAngle: this._labelMinAngle() }],
		});
	}

	private _onGroupByChange(e: Event): void {
		this._groupByColIndex = Number((e.target as HTMLSelectElement).value);
		this._cachedAgg = null;
		this.updateComplete.then(() => this._initChart());
	}

	// ── Render ─────────────────────────────────────────────────────────────

	protected override render() {
		if (!this._open) return nothing;

		const colName = this.columns[this.colIndex]?.name ?? `Column ${this.colIndex}`;
		const agg = this._aggregate();

		let title: string;
		let tableColumns: DataTableColumn[];
		if (this.mode === 'unique-count') {
			const groupByName = this.columns[this._groupByColIndex]?.name ?? `Column ${this._groupByColIndex}`;
			title = `Unique count of ${colName}`;
			tableColumns = [{ name: groupByName }, { name: `Distinct count of ${colName}`, type: 'long' }];
		} else {
			title = `Unique values for column ${colName}`;
			tableColumns = [{ name: colName }, { name: 'Count', type: 'long' }];
		}
		const tableRows: CellValue[][] = agg.map(([key, count]) => [key, count]);

		const ROW_H = 22; // compact row height (21px cell + 1px border)
		const OVERHEAD = 90; // hbar ~40 + column-header ~22 + internal padding ~25 + border
		const maxVisible = Math.min(agg.length, 10);
		const panelH = OVERHEAD + maxVisible * ROW_H;

		return html`
		<div class="modal-backdrop" @click=${this.hide}>
			<div class="modal-content" @click=${(e: Event) => e.stopPropagation()}>
				<div class="modal-header">
					<h3>${title}</h3>
					<button class="close-btn" title="Close" @click=${this.hide}>✕</button>
				</div>
				<div class="modal-body" data-overlay-scroll="x:hidden">
					${this.mode === 'unique-count' ? html`
						<div class="uv-column-picker">
							<label>Group by:</label>
							<select @change=${this._onGroupByChange}>
								${this.columns.map((col, i) =>
									i !== this.colIndex
										? html`<option value=${i} ?selected=${i === this._groupByColIndex}>${col.name}</option>`
										: nothing
								)}
							</select>
						</div>
					` : nothing}
					<div class="table-panel" style="height:${panelH}px">
						<kw-data-table
							.columns=${tableColumns}
							.rows=${tableRows}
							.options=${{ compact: true, showToolbar: true, hideTopBorder: true }}
							@chrome-height-change=${(e: Event) => e.stopPropagation()}
							@visible-row-count-change=${(e: Event) => e.stopPropagation()}
							@visibility-toggle=${(e: Event) => e.stopPropagation()}
							@save=${(e: Event) => e.stopPropagation()}
							@unique-values-close=${(e: Event) => e.stopPropagation()}
						></kw-data-table>
					</div>
					<div class="chart-panel">
						<div class="chart-controls">
							<label class="slider-label">Label density</label>
							<input type="range" min="1" max="5" .value=${String(this._labelDensity)} @input=${this._onDensityChange}>
						</div>
						<div class="chart-container"></div>
					</div>
				</div>
			</div>
		</div>`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-unique-values-dialog': KwUniqueValuesDialog;
	}
}
