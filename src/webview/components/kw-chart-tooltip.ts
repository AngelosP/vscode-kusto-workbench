import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { styles } from './kw-chart-tooltip.styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChartTooltipRow {
	color: string;
	seriesName: string;
	value: number | null;
	formattedValue: string;
	seriesIndex: number;
}

export interface ChartTooltipExtra {
	[key: string]: string;
}

type SortField = '' | 'name' | 'value';
type SortDir = '' | 'asc' | 'desc';

// ── SVG ───────────────────────────────────────────────────────────────────────

const CLOSE_SVG = html`<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z"/></svg>`;

const SORT_ASC = html`&#9650;`;
const SORT_DESC = html`&#9660;`;
const SORT_NONE = html`<span style="opacity:0.35">&#8693;</span>`;

const SEARCH_SVG = html`<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.5 6.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0zm-.82 4.12a5 5 0 1 1 .707-.707l3.536 3.536-.707.707-3.536-3.536z"/></svg>`;

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * `<kw-chart-tooltip>` — interactive hover tooltip for ECharts XY charts.
 *
 * Displays a sortable, searchable table of series values with colour accent
 * bars that expand into colour-picker swatches on hover.
 *
 * @fires kusto-series-color-change  Dispatched when user picks a new series
 *   colour. Detail: `{ seriesName: string; color: string }`.
 * @fires tooltip-close  Dispatched when user clicks the close button.
 * @fires tooltip-highlight  Dispatched when user clicks a row.
 *   Detail: `{ seriesIndex: number; active: boolean }`.
 */
@customElement('kw-chart-tooltip')
export class KwChartTooltip extends LitElement {
	static override styles = [scrollbarSheet, styles];

	// ── Public properties ─────────────────────────────────────────────────────

	@property()
	tooltipTitle = '';

	@property({ attribute: false })
	rows: ChartTooltipRow[] = [];

	@property({ attribute: false })
	extraPayload: ChartTooltipExtra | null = null;

	// ── Internal state ────────────────────────────────────────────────────────

	@state() private _sortField: SortField = 'value';
	@state() private _sortDir: SortDir = 'desc';
	@state() private _searchTerm = '';
	@state() private _searchOpen = false;
	@state() private _activeSeriesIndex = -1;

	// ── Public methods ────────────────────────────────────────────────────────

	/** Reset interactive state when the data point changes. */
	resetInteractionState(): void {
		this._searchTerm = '';
		this._searchOpen = false;
		this._activeSeriesIndex = -1;
	}

	// ── Render ────────────────────────────────────────────────────────────────

	override render(): TemplateResult {
		const sorted = this._getSortedFilteredRows();
		return html`
			<div class="kpt-header">
				<span class="kpt-title">${this.tooltipTitle}</span>
				<button class="kpt-btn" title="Close"
					@click=${this._onClose}>${CLOSE_SVG}</button>
			</div>
			<div class="kpt-table-wrap">
				<table class="kpt-table">
					<thead><tr>
						<th class="kpt-th-accent">
							<button class="kpt-search-btn ${this._searchOpen ? 'kpt-search-active' : ''}"
								title="Search series"
								@click=${this._toggleSearch}>${SEARCH_SVG}</button>
						</th>
						<th class="kpt-th-name"
							@click=${() => this._toggleSort('name')}
							title="Sort by name">
							Series ${this._sortIcon('name')}
						</th>
						<th class="kpt-th-value"
							@click=${() => this._toggleSort('value')}
							title="Sort by value">
							Value ${this._sortIcon('value')}
						</th>
					</tr></thead>
					<tbody>
						${this._searchOpen ? html`
							<tr class="kpt-search-row">
								<td colspan="3">
									<div class="kpt-search-control">
										<span class="kpt-search-icon" aria-hidden="true">${SEARCH_SVG}</span>
										<input class="kpt-search" type="text"
											placeholder="Search\u2026"
											.value=${this._searchTerm}
											@input=${this._onSearch} />
									</div>
								</td>
							</tr>
						` : nothing}
						${sorted.map(r => this._renderRow(r))}
					</tbody>
				</table>
			</div>
			${this._renderExtra()}
		`;
	}

	// ── Row template ──────────────────────────────────────────────────────────

	private _renderRow(r: ChartTooltipRow): TemplateResult {
		const active = r.seriesIndex === this._activeSeriesIndex;
		return html`
			<tr class="kpt-row ${active ? 'kpt-active' : ''}"
				@click=${(e: MouseEvent) => this._onRowClick(e, r.seriesIndex)}>
				<td class="kpt-accent">
					<span class="kpt-accent-bar"
						style="background:${r.color}"></span>
					<input type="color" class="kpt-color-input"
						.value=${r.color}
						title="Change series color"
						@click=${(e: MouseEvent) => e.stopPropagation()}
						@change=${(e: Event) => this._onColorChange(e, r.seriesName)} />
				</td>
				<td class="kpt-name">${r.seriesName}</td>
				<td class="kpt-value">${r.formattedValue}</td>
			</tr>
		`;
	}

	private _renderExtra(): TemplateResult | typeof nothing {
		if (!this.extraPayload) return nothing;
		const entries = Object.entries(this.extraPayload).filter(([, v]) => v);
		if (!entries.length) return nothing;
		return html`
			<div class="kpt-extra">
				${entries.map(([k, v]) => html`
					<div class="kpt-extra-row">
						<span class="kpt-extra-key">${k}:</span> ${v}
					</div>
				`)}
			</div>
		`;
	}

	// ── Sorting / filtering ───────────────────────────────────────────────────

	private _getSortedFilteredRows(): ChartTooltipRow[] {
		let rows = [...this.rows];

		if (this._searchTerm) {
			const lower = this._searchTerm.toLowerCase();
			rows = rows.filter(r =>
				r.seriesName.toLowerCase().includes(lower) ||
				r.formattedValue.toLowerCase().includes(lower)
			);
		}

		if (this._sortField === 'name' && this._sortDir) {
			rows.sort((a, b) => {
				const cmp = a.seriesName.localeCompare(b.seriesName);
				return this._sortDir === 'asc' ? cmp : -cmp;
			});
		} else if (this._sortField === 'value' && this._sortDir) {
			rows.sort((a, b) => {
				const diff = (a.value ?? -Infinity) - (b.value ?? -Infinity);
				return this._sortDir === 'asc' ? diff : -diff;
			});
		}

		return rows;
	}

	private _sortIcon(field: SortField): TemplateResult {
		if (this._sortField !== field) return SORT_NONE;
		return this._sortDir === 'asc' ? SORT_ASC : SORT_DESC;
	}

	// ── Event handlers ────────────────────────────────────────────────────────

	private _onClose(e: MouseEvent): void {
		e.stopPropagation();
		this.dispatchEvent(new CustomEvent('tooltip-close', { bubbles: true }));
	}

	private _onSearch(e: InputEvent): void {
		this._searchTerm = (e.target as HTMLInputElement).value;
	}

	private _toggleSearch(e: MouseEvent): void {
		e.stopPropagation();
		this._searchOpen = !this._searchOpen;
		if (!this._searchOpen) {
			this._searchTerm = '';
		} else {
			this.updateComplete.then(() => {
				const inp = this.shadowRoot?.querySelector('.kpt-search') as HTMLInputElement | null;
				inp?.focus();
			});
		}
	}

	private _toggleSort(field: SortField): void {
		if (this._sortField === field) {
			this._sortDir = this._sortDir === '' ? 'desc'
				: this._sortDir === 'desc' ? 'asc' : '';
			if (!this._sortDir) this._sortField = '';
		} else {
			this._sortField = field;
			this._sortDir = 'desc';
		}
	}

	private _onRowClick(e: MouseEvent, seriesIndex: number): void {
		e.stopPropagation();
		const wasActive = this._activeSeriesIndex === seriesIndex;
		this._activeSeriesIndex = wasActive ? -1 : seriesIndex;
		this.dispatchEvent(new CustomEvent('tooltip-highlight', {
			bubbles: true,
			detail: { seriesIndex, active: !wasActive },
		}));
	}

	private _onColorChange(e: Event, seriesName: string): void {
		e.stopPropagation();
		const color = (e.target as HTMLInputElement).value;
		this.dispatchEvent(new CustomEvent('kusto-series-color-change', {
			bubbles: true,
			detail: { seriesName, color },
		}));
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-chart-tooltip': KwChartTooltip;
	}
}
